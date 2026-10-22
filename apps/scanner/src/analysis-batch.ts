import { createHash } from 'node:crypto';
import type { CapturedAnswer, PromptResult, ScanRun } from '@citevia/core';
import { CostBudgetError, type AnalysisBatchPort, type AnalysisBatchUpdate, type ArtifactStore, type CallLedger } from '@citevia/storage';
import type { AnalysisBatchRecord, AnalysisBatchStore } from '../../../packages/storage/src/analysis-batch.js';
import { analysisRequest, parseAnalysisReceipt } from './analysis-request.js';
import { extractionBody, ProviderError, type ProviderReceipt } from './provider.js';
import { BatchSubmissionError, parseBatchResultLines, type BatchClient, type NativeBatch } from './openai-batch.js';
import { usage } from './normalize.js';
import { budgetFromEnv, estimateProviderCost, hasCompleteTokenUsage, PRICE_VERSION, settleCall } from './cost-observer.js';
import { cachedAnalysis, cacheAnalysis } from './analysis-costs.js';

interface BatchItem {
  customId: string;
  promptId: string;
  captureKey: string;
  retryRequestId?: string;
  analysisKey: string;
  attempt: number;
  body: Record<string, unknown>;
}
interface BatchManifest { items: BatchItem[] }
interface BatchOutput { updates: AnalysisBatchUpdate[] }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const terminal = new Set(['completed', 'failed', 'expired', 'cancelled']);

/** Stable across duplicate delivery, distinct across capture/configuration changes and explicit retries. */
export function analysisBatchCustomId(run: ScanRun, result: PromptResult, body: Record<string, unknown>): string {
  return `analysis_${digest(JSON.stringify([run.projectId, run.id, run.snapshot.parserVersion, result.promptId, result.captureKey, result.lastRetryRequestId, body])).slice(0, 48)}`;
}

/** Durable orchestration: creating is recorded BEFORE submission; ambiguous submissions are discovered, never replayed. */
export class AnalysisBatchCoordinator implements AnalysisBatchPort {
  constructor(private readonly options: {
    store: AnalysisBatchStore;
    artifacts: ArtifactStore;
    client: BatchClient;
    now?: () => Date;
    pollIntervalMs?: number;
    ledger?: CallLedger;
    onReceipt?: (input: { run: ScanRun; result: Pick<PromptResult, 'promptId' | 'attempts'>; receipt: ProviderReceipt; error?: ProviderError }) => Promise<void>;
  }) {}
  private now() { return this.options.now?.() ?? new Date(); }
  private callId(record: AnalysisBatchRecord, item: BatchItem) { return `${record.id}:${item.customId}`; }
  private async reserve(record: AnalysisBatchRecord, run: ScanRun, items: BatchItem[]) {
    if (!this.options.ledger) return;
    for (const item of items) {
      const at = this.now().toISOString();
      await this.options.ledger.reserve({ id: this.callId(record, item), projectId: run.projectId, runId: run.id, promptId: item.promptId, attempt: item.attempt, stage: 'analysis', provider: 'openai', model: run.snapshot.extractionModel, mode: 'batch', createdAt: at, priceVersion: PRICE_VERSION,
        reservedUsd: estimateProviderCost('openai', run.snapshot.extractionModel, { inputTokens: Buffer.byteLength(JSON.stringify(item.body)), outputTokens: Number(item.body.max_output_tokens ?? 12000), totalTokens: 0 }, 'batch', at) }, budgetFromEnv());
    }
  }
  private async settle(record: AnalysisBatchRecord, item: BatchItem, receipt?: ProviderReceipt, code?: string, definitelyUnprocessed = false) {
    if (!this.options.ledger) return;
    const at = this.now().toISOString(), tokens = receipt ? usage(receipt.response) : undefined;
    const measured = !!receipt && hasCompleteTokenUsage(receipt.response);
    await settleCall(this.options.ledger, this.callId(record, item), { status: !measured && !definitelyUnprocessed ? 'uncertain' : code ? 'failed' : 'succeeded', completedAt: at, requestId: receipt?.requestId, usage: tokens, model: receipt ? String(receipt.response.model ?? item.body.model) : undefined,
      estimatedUsd: definitelyUnprocessed ? 0 : tokens && measured ? estimateProviderCost('openai', String(receipt?.response.model ?? item.body.model), tokens, 'batch', at) : null, errorCode: code ?? (receipt && !measured ? 'provider_usage_unavailable' : undefined) });
  }
  private async change(record: AnalysisBatchRecord, changes: Partial<AnalysisBatchRecord>): Promise<AnalysisBatchRecord | null> {
    const next = { ...record, ...changes, version: record.version + 1, updatedAt: this.now().toISOString() };
    return await this.options.store.save(next, record.version) ? next : null;
  }
  private async resolve(record: AnalysisBatchRecord, updates: AnalysisBatchUpdate[]) {
    const outputKey = `${record.inputKey}.results.json`;
    // Results reference the canonical private analysis objects rather than duplicating raw receipts.
    await this.options.artifacts.put(outputKey, { updates: updates.map(({ analysis: _analysis, ...update }) => update) } satisfies BatchOutput);
    return this.change(record, { status: 'resolved', outputKey, leaseExpiresAt: undefined });
  }
  private failed(items: BatchItem[], code: string, message: string): AnalysisBatchUpdate[] {
    return items.map((item) => ({ promptId: item.promptId, captureKey: item.captureKey, retryRequestId: item.retryRequestId, error: { code, message, retryable: false } }));
  }
  async process(run: ScanRun, results: PromptResult[]) {
    let record = await this.options.store.open(run.projectId, run.id);
    if (!record) {
      const pending = results.filter((result) => result.status === 'analysis_pending' && result.captureKey).sort((a, b) => a.promptId.localeCompare(b.promptId));
      if (!pending.length) return { updates: [] };
      const items: BatchItem[] = [];
      const cached: AnalysisBatchUpdate[] = [];
      for (const result of pending) {
        const answer = await this.options.artifacts.get<CapturedAnswer>(result.captureKey!);
        if (!answer || answer.status !== 'completed')
          return { updates: this.failed([{ promptId: result.promptId, captureKey: result.captureKey! } as BatchItem], 'saved_answer_missing', 'Saved answer is unavailable. No replacement answer was purchased.') };
        const analysisKey = result.analysisKey ?? `${result.captureKey!.slice(0, -'capture.json'.length)}analysis.json`;
        let saved = null;
        try { saved = await cachedAnalysis(this.options.artifacts, answer, { ...run.snapshot, projectId: run.projectId }, this.now()); }
        catch { console.error(JSON.stringify({ event: 'analysis_cache_read_skipped', projectId: run.projectId })); }
        if (saved) {
          await this.options.artifacts.put(analysisKey, saved);
          cached.push({ promptId: result.promptId, captureKey: result.captureKey!, retryRequestId: result.lastRetryRequestId, analysisKey, analysis: saved });
          continue;
        }
        const body = extractionBody(analysisRequest(answer, run.snapshot));
        items.push({ customId: analysisBatchCustomId(run, result, body), promptId: result.promptId, captureKey: result.captureKey!, retryRequestId: result.lastRetryRequestId, analysisKey, attempt: result.attempts, body });
      }
      // Apply reuse first; the next reconciliation batches only actual misses.
      if (cached.length) return { updates: cached };
      const id = `analysis_batch_${digest(items.map((item) => item.customId).join(':')).slice(0, 40)}`;
      record = await this.options.store.get(id);
      if (!record) {
        const at = this.now().toISOString();
        record = { id, projectId: run.projectId, runId: run.id, version: 0, status: 'prepared', inputKey: `projects/${run.projectId}/runs/${run.id}/analysis-batches/${id}/input.json`, createdAt: at, updatedAt: at, expiresAt: run.expiresAt };
        await this.options.artifacts.put(record.inputKey, { items } satisfies BatchManifest);
        if (!(await this.options.store.create(record))) return { updates: [] };
      }
    }
    if (record.projectId !== run.projectId || record.runId !== run.id)
      throw new ProviderError('analysis_batch_scope_mismatch', 'Batch does not belong to this scan.', false);
    if (record.status === 'resolved' || record.status === 'processed') {
      const output = record.outputKey ? await this.options.artifacts.get<BatchOutput>(record.outputKey) : null;
      if (!output) throw new ProviderError('analysis_batch_saved_output_missing', 'Saved batch output is unavailable.', false);
      const updates = await Promise.all(output.updates.map(async (update) => {
        if (!update.analysisKey) return update;
        const analysis = await this.options.artifacts.get<import('@citevia/core').Analysis>(update.analysisKey);
        if (!analysis) throw new ProviderError('analysis_batch_saved_analysis_missing', 'Saved batch analysis is unavailable.', false);
        return { ...update, analysis };
      }));
      return { batchId: record.id, updates };
    }
    const manifest = await this.options.artifacts.get<BatchManifest>(record.inputKey);
    if (!manifest?.items.length) throw new ProviderError('analysis_batch_saved_input_missing', 'Saved batch input is unavailable.', false);
    const { items } = manifest;
    if (record.nextPollAt && Date.parse(record.nextPollAt) > this.now().getTime()) return { updates: [] };
    if (record.leaseExpiresAt && Date.parse(record.leaseExpiresAt) > this.now().getTime()) return { updates: [] };
    if (record.status === 'prepared') {
      const jsonl = items.map((item) => JSON.stringify({ custom_id: item.customId, method: 'POST', url: '/v1/responses', body: item.body })).join('\n') + '\n';
      if (items.length > 50_000 || Buffer.byteLength(jsonl) > 16 * 1024 * 1024) {
        const updates = this.failed(items, 'analysis_batch_input_limit', 'Batch input exceeded the application limit.');
        const resolved = await this.resolve(record, updates);
        return { batchId: resolved?.id, updates: resolved ? updates : [] };
      }
      // A lease protects the upload. Repeating only a file upload after a crash cannot purchase inference.
      record = await this.change(record, { leaseExpiresAt: new Date(this.now().getTime() + 120_000).toISOString() });
      if (!record) return { updates: [] };
      if (!record.inputFileId) {
        const inputFileId = await this.options.client.upload(jsonl);
        record = await this.change(record, { inputFileId });
        if (!record) return { updates: [] };
      }
      try { await this.reserve(record, run, items); }
      catch (error) {
        if (!(error instanceof CostBudgetError)) throw error;
        for (const item of items) await this.settle(record, item, undefined, error.code, true);
        const updates = this.failed(items, error.code, error.message);
        const resolved = await this.resolve(record, updates);
        return { batchId: resolved?.id, updates: resolved ? updates : [] };
      }
      record = await this.change(record, { status: 'creating' });
      if (!record) return { updates: [] };
      const creating = record;
      try {
        const batch = await this.options.client.create(record.inputFileId!, record.id);
        record = await this.change(record, { status: 'submitted', providerBatchId: batch.id, providerStatus: batch.status, leaseExpiresAt: undefined });
        if (!record) return { updates: [] };
      } catch (error) {
        if (error instanceof BatchSubmissionError && !error.uncertain) {
          for (const item of items) await this.settle(creating, item, undefined, error.code, true);
          const updates = this.failed(items, error.code, 'Analysis batch submission was rejected. Retry explicitly after correcting the configuration.');
          const resolved = await this.resolve(creating, updates);
          return { batchId: resolved?.id, updates: resolved ? updates : [] };
        }
        await this.change(creating, { status: 'submission_uncertain', leaseExpiresAt: undefined, nextPollAt: new Date(this.now().getTime() + (this.options.pollIntervalMs ?? 60_000)).toISOString() });
        return { updates: [] };
      }
    } else if (record.status === 'creating' || record.status === 'submission_uncertain') {
      const batch = await this.options.client.find(record.id, record.inputFileId!);
      if (!batch) {
        await this.change(record, { status: 'submission_uncertain', leaseExpiresAt: undefined, nextPollAt: new Date(this.now().getTime() + (this.options.pollIntervalMs ?? 60_000)).toISOString() });
        return { updates: [] };
      }
      record = await this.change(record, { status: 'submitted', providerBatchId: batch.id, providerStatus: batch.status, leaseExpiresAt: undefined });
      if (!record) return { updates: [] };
    }
    const batch = await this.options.client.retrieve(record.providerBatchId!);
    if (batch.id !== record.providerBatchId || batch.input_file_id !== record.inputFileId || batch.metadata?.citevia_batch !== record.id)
      throw new ProviderError('analysis_batch_provenance_mismatch', 'Batch provenance does not match its saved submission.', false);
    if (!terminal.has(batch.status)) {
      await this.change(record, { providerStatus: batch.status, nextPollAt: new Date(this.now().getTime() + (this.options.pollIntervalMs ?? 60_000)).toISOString() });
      return { updates: [] };
    }
    await this.options.artifacts.put(`${record.inputKey}.batch.json`, batch);
    const updates = await this.import(run, record, manifest, batch);
    const resolved = await this.resolve(record, updates);
    return { batchId: resolved?.id, updates: resolved ? updates : [] };
  }
  private async import(run: ScanRun, record: AnalysisBatchRecord, manifest: BatchManifest, batch: NativeBatch): Promise<AnalysisBatchUpdate[]> {
    const files = [batch.output_file_id, batch.error_file_id].filter((id): id is string => !!id);
    const contents = await Promise.all(files.map(async (id) => {
      const text = await this.options.client.download(id);
      await this.options.artifacts.put(`${record.inputKey}.${id}.json`, { contents: text });
      return text;
    }));
    let lines;
    try { lines = parseBatchResultLines(contents.join('\n'), new Set(manifest.items.map((item) => item.customId))); }
    catch (error) { return this.failed(manifest.items, error instanceof ProviderError ? error.code : 'analysis_batch_invalid_output', 'Analysis batch output could not be attributed safely. Saved output requires review.'); }
    const updates: AnalysisBatchUpdate[] = [];
    for (const item of manifest.items) {
      const row = lines.get(item.customId);
      if (!row || row.error || !row.response || row.response.status_code < 200 || row.response.status_code >= 300) {
        // Missing output is missing attribution, even for a nominally completed batch.
        // Only an explicit unprocessed-item error can release its reservation as zero spend.
        await this.settle(record, item, undefined, !row ? `analysis_batch_${batch.status}_missing_item` : 'analysis_batch_item_failed', row?.error?.code === 'batch_expired');
        updates.push(...this.failed([item], !row ? `analysis_batch_${batch.status}_missing_item` : 'analysis_batch_item_failed', 'Analysis was not completed for this saved answer. Retry this item explicitly; successful items are retained.'));
        continue;
      }
      const receipt: ProviderReceipt = { response: row.response.body, requestId: row.response.request_id ?? null, receivedAt: this.now().toISOString() };
      try {
        const answer = await this.options.artifacts.get<CapturedAnswer>(item.captureKey);
        if (!answer) throw new ProviderError('saved_answer_missing', 'Saved answer is unavailable.', false);
        const analysis = parseAnalysisReceipt(receipt, answer, run.snapshot);
        await this.options.artifacts.put(item.analysisKey, analysis);
        try { await cacheAnalysis(this.options.artifacts, answer, { ...run.snapshot, projectId: run.projectId }, analysis, this.now()); }
        catch { console.error(JSON.stringify({ event: 'analysis_cache_write_skipped', projectId: run.projectId })); }
        await this.settle(record, item, receipt);
        await this.options.onReceipt?.({ run, result: { promptId: item.promptId, attempts: item.attempt }, receipt });
        updates.push({ promptId: item.promptId, captureKey: item.captureKey, retryRequestId: item.retryRequestId, analysisKey: item.analysisKey, analysis });
      } catch (error) {
        const failure = error instanceof ProviderError ? error : new ProviderError('analysis_batch_invalid_analysis', 'Batch analysis did not pass validation.', false);
        await this.settle(record, item, receipt, failure.code);
        await this.options.onReceipt?.({ run, result: { promptId: item.promptId, attempts: item.attempt }, receipt, error: failure });
        updates.push(...this.failed([item], failure.code, failure.message));
      }
    }
    return updates;
  }
  async complete(batchId: string): Promise<void> {
    const record = await this.options.store.get(batchId);
    if (record?.status === 'resolved') await this.change(record, { status: 'processed' });
  }
}
