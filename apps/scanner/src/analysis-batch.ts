import { createHash } from 'node:crypto';
import type { CapturedAnswer, PromptResult, ScanRun } from '@citevia/core';
import { CostBudgetError, type AnalysisBatchPort, type AnalysisBatchUpdate, type ArtifactStore, type CallLedger, type ProviderAdmissionStore } from '@citevia/storage';
import type { AnalysisBatchRecord, AnalysisBatchStore } from '../../../packages/storage/src/analysis-batch.js';
import { analysisRequest, parseAnalysisReceipt } from './analysis-request.js';
import { extractionBody, object, ProviderError, type ProviderReceipt } from './provider.js';
import { BatchSubmissionError, parseBatchResultLines, type BatchClient, type NativeBatch } from './openai-batch.js';
import { usage } from './normalize.js';
import { budgetFromEnv, estimateProviderCost, hasCompleteTokenUsage, PRICE_VERSION, settleCall } from './cost-observer.js';
import { cachedAnalysis, cacheAnalysis } from './analysis-costs.js';
import { classifyProviderHttpError, providerFailureMessage } from './provider-errors.js';
import { providerAdmissionPolicy } from './provider-admission.js';

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
const MAX_ATTEMPTS = 4; // Initial request plus the three retries requested for the scanner.
const BATCH_PROCESSING_WINDOW_MS = 24 * 60 * 60_000;
const BATCH_IMPORT_ALLOWANCE_MS = 2 * 60 * 60_000;
type BatchProcessResult = { batchId?: string; updates: AnalysisBatchUpdate[]; deadlineAt?: string };

/** Stable across duplicate delivery, distinct across capture/configuration changes and explicit retries. */
export function analysisBatchCustomId(run: ScanRun, result: PromptResult, body: Record<string, unknown>): string {
  return `analysis_${digest(JSON.stringify([run.projectId, run.id, run.snapshot.parserVersion, result.promptId, result.captureKey, result.lastRetryRequestId, result.analysisAttempts, body])).slice(0, 48)}`;
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
    admission?: ProviderAdmissionStore;
    random?: () => number;
    onReceipt?: (input: { run: ScanRun; result: Pick<PromptResult, 'promptId' | 'attempts'>; receipt: ProviderReceipt; error?: ProviderError }) => Promise<void>;
  }) {}
  private now() { return this.options.now?.() ?? new Date(); }
  private processingDeadline(at: string) {
    return new Date(Date.parse(at) + BATCH_PROCESSING_WINDOW_MS + BATCH_IMPORT_ALLOWANCE_MS).toISOString();
  }
  private acceptedTiming(record: AnalysisBatchRecord, batch: NativeBatch) {
    const nativeCreatedAt = typeof batch.created_at === 'number' ? batch.created_at * 1000 : NaN;
    // A successful create normally supplies created_at; older saved responses may not.
    // Discovery must use the original attempt time, never its later polling time.
    const submittedAt = Number.isFinite(nativeCreatedAt) && nativeCreatedAt > 0 && nativeCreatedAt <= this.now().getTime() + 5 * 60_000
      ? new Date(nativeCreatedAt).toISOString()
      : record.submittedAt ?? record.submissionAttemptedAt ?? this.now().toISOString();
    return { submittedAt, processingDeadlineAt: this.processingDeadline(submittedAt) };
  }
  private nextRetry(attempt: number, retryAfterMs = 0) {
    const base = Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
    const jitter = Math.floor(base * .25 * (this.options.random?.() ?? Math.random()));
    return new Date(Math.min(Date.parse('9999-12-31T23:59:59.999Z'), this.now().getTime() + Math.max(base + jitter, retryAfterMs))).toISOString();
  }
  private async recordProviderFailure(record: AnalysisBatchRecord, error: ProviderError) {
    const kind = error.kind === 'transient' && error.retryAfterMs !== undefined ? 'rate_limit' : error.kind;
    if (!this.options.admission || (kind !== 'rate_limit' && kind !== 'quota')) return;
    try { await this.options.admission.complete('openai', `batch:${record.id}`, { kind, retryAfterMs: error.retryAfterMs }); }
    catch { console.error(JSON.stringify({ event: 'batch_provider_circuit_update_failed', batchId: record.id })); }
  }
  private async admittedCreate(inputFileId: string, id: string) {
    if (!this.options.admission) return this.options.client.create(inputFileId, id);
    let decision;
    try { decision = await this.options.admission.acquire('openai', providerAdmissionPolicy('openai')); }
    catch { throw new ProviderError('provider_admission_unavailable', 'Provider scheduling is temporarily unavailable.', true, null, { kind: 'deferred', safeToRetry: true, retryAfterMs: 30_000 }); }
    if (!decision.admitted) {
      if (decision.reason === 'quota') throw new ProviderError('provider_quota_blocked', 'OpenAI usage is paused: credits, billing, or quota requires attention.', false, null, { kind: 'quota', safeToRetry: false, provider: 'openai' });
      throw new ProviderError('provider_admission_deferred', 'Waiting for shared provider capacity.', true, null, { kind: 'deferred', safeToRetry: true, retryAfterMs: decision.retryAfterMs });
    }
    let failure: { kind: 'rate_limit' | 'quota'; retryAfterMs?: number } | undefined;
    try { return await this.options.client.create(inputFileId, id); }
    catch (error) {
      if (error instanceof ProviderError) {
        const kind = error.kind === 'transient' && error.retryAfterMs !== undefined ? 'rate_limit' : error.kind;
        if (kind === 'rate_limit' || kind === 'quota') failure = { kind, retryAfterMs: error.retryAfterMs };
      }
      throw error;
    } finally {
      try { await this.options.admission.complete('openai', decision.leaseId, failure); }
      catch { console.error(JSON.stringify({ event: 'batch_provider_admission_release_failed', batchId: id })); }
    }
  }
  private callId(record: AnalysisBatchRecord, item: BatchItem) { return `${record.id}:${item.customId}`; }
  private async reportReceipt(run: ScanRun, item: BatchItem, receipt: ProviderReceipt, error?: ProviderError) {
    try { await this.options.onReceipt?.({ run, result: { promptId: item.promptId, attempts: item.attempt }, receipt, error }); }
    catch { console.error(JSON.stringify({ event: 'batch_receipt_observer_failed', batchItem: item.customId })); }
  }
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
  private failed(items: BatchItem[], code: string, message: string, failure?: ProviderError): AnalysisBatchUpdate[] {
    return items.map((item) => ({ promptId: item.promptId, captureKey: item.captureKey, retryRequestId: item.retryRequestId, analysisAttempt: item.attempt,
      error: { code, message, retryable: failure?.retryable ?? false,
        ...(failure ? { kind: failure.kind, safeToRetry: failure.safeToRetry, retryAfterMs: failure.retryAfterMs, providerCode: failure.providerCode } : {}) } }));
  }
  private async operationFailed(record: AnalysisBatchRecord, items: BatchItem[], counter: 'uploadFailures' | 'pollFailures', error: unknown) {
    if (!(error instanceof ProviderError)) throw error;
    await this.recordProviderFailure(record, error);
    const attempts = (record[counter] ?? 0) + 1;
    if (error.retryable && error.safeToRetry && attempts < MAX_ATTEMPTS) {
      await this.change(record, { [counter]: attempts, leaseExpiresAt: undefined, nextPollAt: this.nextRetry(attempts, error.retryAfterMs) });
      return { updates: [] };
    }
    for (const item of items) await this.settle(record, item, undefined, error.code, counter === 'uploadFailures');
    const updates = this.failed(items, error.code, error.message,
      new ProviderError(error.code, error.message, false, error.requestId, { ...error, safeToRetry: false }));
    const resolved = await this.resolve(record, updates);
    return { batchId: resolved?.id, updates: resolved ? updates : [] };
  }
  async process(run: ScanRun, results: PromptResult[]): Promise<BatchProcessResult> {
    const outcome = await this.processBatch(run, results);
    // Return the durable deadline even when a poll is deferred, another worker has
    // the lease, or a submission just became uncertain. The engine can repair its
    // run deadline after a crash between accepting the batch and updating the run.
    const record = outcome.batchId ? await this.options.store.get(outcome.batchId) : await this.options.store.open(run.projectId, run.id);
    return record?.processingDeadlineAt ? { ...outcome, deadlineAt: record.processingDeadlineAt } : outcome;
  }
  private async processBatch(run: ScanRun, results: PromptResult[]): Promise<BatchProcessResult> {
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
          cached.push({ promptId: result.promptId, captureKey: result.captureKey!, retryRequestId: result.lastRetryRequestId, analysisAttempt: result.analysisAttempts, analysisKey, analysis: saved });
          continue;
        }
        const body = extractionBody(analysisRequest(answer, run.snapshot));
        items.push({ customId: analysisBatchCustomId(run, result, body), promptId: result.promptId, captureKey: result.captureKey!, retryRequestId: result.lastRetryRequestId, analysisKey, attempt: result.analysisAttempts ?? result.attempts, body });
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
    if (['creating', 'submission_uncertain', 'submitted'].includes(record.status) && !record.processingDeadlineAt) {
      // Give legacy in-flight batches one fixed recovery window. This is persisted
      // once; subsequent polling cannot keep extending the scan indefinitely.
      const attemptedAt = record.submittedAt ?? record.submissionAttemptedAt ?? this.now().toISOString();
      record = await this.change(record, { submissionAttemptedAt: record.submissionAttemptedAt ?? attemptedAt, processingDeadlineAt: this.processingDeadline(attemptedAt) });
      if (!record) return { updates: [] };
    }
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
        let inputFileId: string;
        try { inputFileId = await this.options.client.upload(jsonl); }
        catch (error) { return this.operationFailed(record, items, 'uploadFailures', error); }
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
      const submissionAttemptedAt = this.now().toISOString();
      record = await this.change(record, { status: 'creating', submitAttempts: (record.submitAttempts ?? 0) + 1,
        submissionAttemptedAt, processingDeadlineAt: this.processingDeadline(submissionAttemptedAt) });
      if (!record) return { updates: [] };
      const creating = record;
      try {
        const batch = await this.admittedCreate(record.inputFileId!, record.id);
        record = await this.change(record, { status: 'submitted', providerBatchId: batch.id, providerStatus: batch.status, leaseExpiresAt: undefined, ...this.acceptedTiming(record, batch) });
        if (!record) return { updates: [] };
      } catch (error) {
        if (error instanceof ProviderError && error.kind === 'deferred') {
          await this.change(creating, { status: 'prepared', submitAttempts: Math.max(0, (creating.submitAttempts ?? 1) - 1), leaseExpiresAt: undefined,
            submissionAttemptedAt: undefined, processingDeadlineAt: undefined, nextPollAt: this.nextRetry(1, error.retryAfterMs) });
          return { updates: [] };
        }
        if ((error instanceof BatchSubmissionError && !error.uncertain) || (error instanceof ProviderError && error.kind === 'quota')) {
          await this.recordProviderFailure(creating, error);
          if (error.retryable && error.safeToRetry && (creating.submitAttempts ?? 1) < MAX_ATTEMPTS) {
            await this.change(creating, { status: 'prepared', leaseExpiresAt: undefined, submissionAttemptedAt: undefined, processingDeadlineAt: undefined,
              nextPollAt: this.nextRetry(creating.submitAttempts ?? 1, error.retryAfterMs) });
            return { updates: [] };
          }
          for (const item of items) await this.settle(creating, item, undefined, error.code, true);
          const message = error.kind === 'quota' ? 'OpenAI usage is paused: credits, billing, or quota requires attention.' : 'Analysis batch submission was rejected. Automatic submission retries are exhausted or unavailable.';
          const updates = this.failed(items, error.code, message, new ProviderError(error.code, message, false, error.requestId, { ...error, safeToRetry: false }));
          const resolved = await this.resolve(creating, updates);
          return { batchId: resolved?.id, updates: resolved ? updates : [] };
        }
        await this.change(creating, { status: 'submission_uncertain', leaseExpiresAt: undefined, nextPollAt: new Date(this.now().getTime() + (this.options.pollIntervalMs ?? 60_000)).toISOString() });
        return { updates: [] };
      }
    }
    try {
      if (record.status === 'creating' || record.status === 'submission_uncertain') {
        const batch = await this.options.client.find(record.id, record.inputFileId!);
        if (!batch) {
          await this.change(record, { status: 'submission_uncertain', leaseExpiresAt: undefined, nextPollAt: new Date(this.now().getTime() + (this.options.pollIntervalMs ?? 60_000)).toISOString() });
          return { updates: [] };
        }
        record = await this.change(record, { status: 'submitted', providerBatchId: batch.id, providerStatus: batch.status, leaseExpiresAt: undefined, ...this.acceptedTiming(record, batch) });
        if (!record) return { updates: [] };
      }
      const batch = await this.options.client.retrieve(record.providerBatchId!);
      if (batch.id !== record.providerBatchId || batch.input_file_id !== record.inputFileId || batch.metadata?.citevia_batch !== record.id)
        throw new ProviderError('analysis_batch_provenance_mismatch', 'Batch provenance does not match its saved submission.', false);
      if (!terminal.has(batch.status)) {
        await this.change(record, { providerStatus: batch.status, pollFailures: 0, nextPollAt: new Date(this.now().getTime() + (this.options.pollIntervalMs ?? 60_000)).toISOString() });
        return { updates: [] };
      }
      await this.options.artifacts.put(`${record.inputKey}.batch.json`, batch);
      const updates = await this.import(run, record, manifest, batch);
      const resolved = await this.resolve(record, updates);
      return { batchId: resolved?.id, updates: resolved ? updates : [] };
    } catch (error) {
      if (!record) throw error;
      return this.operationFailed(record, items, 'pollFailures', error);
    }
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
    let validationFailure: ProviderError | undefined;
    const validationErrors = object(batch.errors)?.data;
    // A failed validation batch was never admitted to inference. Completed output
    // with missing rows remains uncertain and must not use this retry exception.
    if (batch.status === 'failed' && Array.isArray(validationErrors)) {
      for (const error of validationErrors.slice(0, 100)) {
        const code = object(error)?.code;
        const status = ['rate_limit_exceeded', 'rate_limit_error', 'slow_down'].includes(String(code)) ? 429
          : ['server_error', 'server_is_overloaded'].includes(String(code)) ? 503 : 400;
        const classified = await classifyProviderHttpError(Response.json({ error: { code } }, { status }), { provider: 'openai', nowMs: this.now().getTime() });
        if (classified.providerCode && (!validationFailure || classified.kind === 'quota'))
          validationFailure = new ProviderError('analysis_batch_validation_failed', providerFailureMessage('openai', status, classified.kind), classified.retryable, null, classified);
        if (validationFailure?.kind === 'quota') break;
      }
      if (validationFailure) await this.recordProviderFailure(record, validationFailure);
    }
    const updates: AnalysisBatchUpdate[] = [];
    for (const item of manifest.items) {
      const row = lines.get(item.customId);
      if (!row || row.error || !row.response || row.response.status_code < 200 || row.response.status_code >= 300) {
        const code = !row ? `analysis_batch_${batch.status}_missing_item` : 'analysis_batch_item_failed';
        let failure: ProviderError | undefined = !row ? validationFailure : undefined;
        if (row?.error?.code === 'batch_expired') {
          failure = new ProviderError('analysis_batch_item_expired', 'The batch expired before this answer was analyzed.', true, null,
            { kind: 'transient', safeToRetry: true, provider: 'openai' });
        } else if (row?.response && row.response.status_code >= 400 && row.response.status_code <= 599) {
          const classified = await classifyProviderHttpError(Response.json(row.response.body, { status: row.response.status_code }), { provider: 'openai', model: String(item.body.model), nowMs: this.now().getTime() });
          failure = new ProviderError(`analysis_batch_item_http_${row.response.status_code}`, providerFailureMessage('openai', row.response.status_code, classified.kind), classified.retryable, row.response.request_id ?? null, classified);
        } else if (row?.error) {
          const status = ['rate_limit_exceeded', 'rate_limit_error', 'slow_down'].includes(row.error.code ?? '') ? 429
            : ['server_error', 'server_is_overloaded'].includes(row.error.code ?? '') ? 503 : 400;
          const classified = await classifyProviderHttpError(Response.json({ error: { code: row.error.code } }, { status }), { provider: 'openai', model: String(item.body.model), nowMs: this.now().getTime() });
          failure = new ProviderError(code, providerFailureMessage('openai', status, classified.kind), classified.retryable, null, classified);
        }
        if (failure) await this.recordProviderFailure(record, failure);
        // Missing output is missing attribution, even for a nominally completed batch.
        // Only an explicit unprocessed-item error can release its reservation as zero spend.
        const unprocessed = batch.status === 'failed' || row?.error?.code === 'batch_expired' || !!(row?.response && row.response.status_code >= 400 && row.response.status_code < 500) || failure?.kind === 'quota' || failure?.kind === 'rate_limit';
        await this.settle(record, item, undefined, failure?.code ?? code, unprocessed);
        updates.push(...this.failed([item], failure?.code ?? code, failure?.message ?? 'Analysis was not completed for this saved answer. Saved output requires review; successful items are retained.', failure));
        continue;
      }
      const receipt: ProviderReceipt = { response: row.response.body, requestId: row.response.request_id ?? null, receivedAt: this.now().toISOString() };
      // Storage outages are local import failures, not invalid model output. Let
      // reconciliation read the same paid batch again rather than terminally
      // rejecting a valid answer or purchasing replacement inference.
      const answer = await this.options.artifacts.get<CapturedAnswer>(item.captureKey);
      let analysis;
      try {
        if (!answer) throw new ProviderError('saved_answer_missing', 'Saved answer is unavailable.', false);
        analysis = parseAnalysisReceipt(receipt, answer, run.snapshot);
      } catch (error) {
        const failure = error instanceof ProviderError ? error : new ProviderError('analysis_batch_invalid_analysis', 'Batch analysis did not pass validation.', false);
        await this.settle(record, item, receipt, failure.code);
        await this.reportReceipt(run, item, receipt, failure);
        updates.push(...this.failed([item], failure.code, failure.message));
        continue;
      }
      await this.options.artifacts.put(item.analysisKey, analysis);
      try { await cacheAnalysis(this.options.artifacts, answer!, { ...run.snapshot, projectId: run.projectId }, analysis, this.now()); }
      catch { console.error(JSON.stringify({ event: 'analysis_cache_write_skipped', projectId: run.projectId })); }
      await this.settle(record, item, receipt);
      await this.reportReceipt(run, item, receipt);
      updates.push({ promptId: item.promptId, captureKey: item.captureKey, retryRequestId: item.retryRequestId, analysisAttempt: item.attempt, analysisKey: item.analysisKey, analysis });
    }
    return updates;
  }
  async complete(batchId: string): Promise<void> {
    const record = await this.options.store.get(batchId);
    if (record?.status === 'resolved') await this.change(record, { status: 'processed' });
  }
}
