import { createHash, randomUUID } from 'node:crypto';
import { buildSummary, isTerminal, RETENTION_DAYS, type CapturedAnswer, type Analysis, type PromptResult, type ScanRun, type ScanMessage, type ScanError } from '@citevia/core';
import type { ScannerDependencies } from '@citevia/storage';
import { ExtractionError } from './openai.js';
import { object, ProviderError, responseFailure, type NativeResponse } from './provider.js';

export const MAX_ATTEMPTS = 4;
export const MAX_MANUAL_RETRIES = 32;
export const LEASE_MS = 12 * 60_000;
const RUN_DEADLINE_MS = Number(process.env.SCAN_RUN_DEADLINE_HOURS||3) * 60 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const runIdFor = (message: Extract<ScanMessage, { kind: 'kickoff' }>) => `run_${hash(`${message.projectId}:${message.trigger ?? 'scheduled'}:${message.requestId ?? message.scheduledAt}`)}`;
const rootKey = (result: PromptResult) => `projects/${result.projectId}/runs/${result.runId}/prompts/${result.promptId}/generation-${result.captureGeneration ?? 0}`;
export const captureKeyFor = (result: PromptResult) => `${rootKey(result)}/capture.json`;
export const analysisKeyFor = (result: PromptResult) => `${rootKey(result)}/analysis.json`;

const scanError = (error: unknown): ScanError => error instanceof ProviderError
  ? { code: error.code, message: error.message, retryable: error.retryable }
  : { code: 'internal_error', message: 'The scan could not be completed. It will retry when possible.', retryable: true };
function withoutLease(result: PromptResult): PromptResult {
  const { leaseOwner: _owner, leaseExpiresAt: _expires, ...rest } = result;
  return rest;
}
function capturedFailure(answer: CapturedAnswer): ProviderError | undefined {
  if (answer.status === 'refused') return new ProviderError('response_refused', 'The model refused this prompt.', false);
  if (answer.status === 'incomplete') return new ProviderError('response_incomplete', 'The model returned an incomplete answer.', false);
  if (!answer.text.trim()) return new ProviderError('response_empty', 'The model returned no answer text.', false);
  const native = object(object(answer.raw)?.response);
  return native ? responseFailure(native as NativeResponse, true) : undefined;
}

export class Scanner {
  constructor(private readonly dependencies: ScannerDependencies) {}
  private now(): Date { return this.dependencies.now?.() ?? new Date(); }

  async handle(message: ScanMessage): Promise<void> {
    switch (message.kind) {
      case 'onboard': if(!this.dependencies.onboarding)throw new Error('Onboarding worker is not configured');return this.dependencies.onboarding.handle(message.projectId,message.jobId);
      case 'kickoff': return this.kickoff(message);
      case 'prompt': return this.prompt(message);
      case 'retry': return this.retry(message);
      case 'reconcile': await this.dependencies.onboarding?.reconcile();return this.reconcile();
    }
  }

  private async kickoff(message: Extract<ScanMessage, { kind: 'kickoff' }>): Promise<void> {
    const { repository, queue } = this.dependencies;
    const id = runIdFor(message);
    let run = await repository.getRun(message.projectId, id);
    if (!run) {
      const project = await repository.getProject(message.projectId);
      if (!project || (!project.enabled && message.trigger !== 'manual')) return;
      const prompts = project.prompts.filter(prompt => prompt.active);
      if (!prompts.length || prompts.length > 50) throw new ProviderError('invalid_prompt_count', 'A project needs 1 to 50 active prompts.', false);
      if (!Number.isFinite(Date.parse(message.scheduledAt))) throw new ProviderError('invalid_schedule_time', 'The scheduled scan time is invalid.', false);
      const now = this.now();
      const createdAt = now.toISOString();
      const expiresAt = Math.floor(now.getTime() / 1000) + RETENTION_DAYS * 86400;
      const snapshot = structuredClone({
        projectName: project.name, brand: project.brand, competitors: project.competitors, prompts,
        country: project.country, language: project.language, timezone: project.timezone,
        generationModel: project.generationModel, extractionModel: project.extractionModel,
        parserVersion: project.parserVersion, configVersion: project.version,
      });
      run = { projectId: project.id, id, scheduledAt: message.scheduledAt, createdAt, status: 'queued',
        trigger: message.trigger ?? 'scheduled', snapshot, totalCount: prompts.length, terminalCount: 0, succeededCount: 0,
        capturedCount: 0, resultVersion: 0, deadlineAt: new Date(now.getTime() + RUN_DEADLINE_MS).toISOString(), expiresAt };
      const results: PromptResult[] = prompts.map(prompt => ({
        projectId: project.id, runId: id, promptId: prompt.id, responseId: `${id}~${prompt.id}`,
        prompt: structuredClone(prompt), status: 'queued', version: 0, attempts: 0, citationCount: 0, sourceCount: 0, expiresAt,
      }));
      await repository.createRun(run, results);
    }
    // Replay also repairs a crash between the manifest transaction and queue sends.
    const results = await repository.listResults(message.projectId, id);
    await queue.send(results.filter(result => !isTerminal(result.status) && !this.hasLiveLease(result))
      .map(result => ({ kind: 'prompt' as const, projectId: result.projectId, runId: result.runId, promptId: result.promptId })));
  }

  private hasLiveLease(result: PromptResult): boolean {
    return Boolean(result.leaseOwner && result.leaseExpiresAt && Date.parse(result.leaseExpiresAt) > this.now().getTime());
  }

  private deadlineFor(run: ScanRun, result: PromptResult): number {
    // A recorded retry intent also repairs a crash between the result CAS and the run deadline update.
    const retriedAt = result.lastRetryRequestedAt ? Date.parse(result.lastRetryRequestedAt) : 0;
    return Math.max(Date.parse(run.deadlineAt), retriedAt ? retriedAt + RUN_DEADLINE_MS : 0);
  }

  private async prompt(message: Extract<ScanMessage, { kind: 'prompt' }>): Promise<void> {
    const { repository, artifacts, provider } = this.dependencies;
    const run = await repository.getRun(message.projectId, message.runId);
    const existing = await repository.getResult(message.projectId, message.runId, message.promptId);
    if (!run || !existing) return;
    if (isTerminal(existing.status)) { await this.finalize(message.projectId, message.runId); return; }
    if (this.hasLiveLease(existing)) return;
    const deadline = this.deadlineFor(run, existing);
    if (existing.attempts >= MAX_ATTEMPTS || deadline <= this.now().getTime()) {
      await this.exhaust(existing, 'retry_exhausted', 'The scan exceeded its retry or time limit.');
      return;
    }
    let current: PromptResult = {
      ...existing, version: existing.version + 1, attempts: existing.attempts + 1,
      leaseOwner: randomUUID(), leaseExpiresAt: new Date(this.now().getTime() + LEASE_MS).toISOString(),
      status: existing.captureKey ? 'extracting' : 'collecting',
    };
    if (!await repository.commitResult(current, existing)) return;
    await repository.markRunRunning(message.projectId, message.runId, deadline > Date.parse(run.deadlineAt) ? new Date(deadline).toISOString() : undefined);
    run.deadlineAt = new Date(deadline).toISOString();
    let answer: CapturedAnswer | null = null;
    try {
      // Read the deterministic checkpoint even if a prior invocation died before saving its DB key.
      const captureKey = current.captureKey ?? captureKeyFor(current);
      answer = await artifacts.get<CapturedAnswer>(captureKey);
      if (!answer) {
        answer = await provider.collect(current.prompt.text, run.snapshot);
        await artifacts.put(captureKey, answer);
      }
      const captured: PromptResult = {
        ...current, version: current.version + 1, status: 'captured', captureKey,
        ...(!capturedFailure(answer) ? { capturedAt: answer.createdAt } : {}), model: answer.model, usage: answer.usage,
        citationCount: answer.citations.length, sourceCount: answer.sources.length,
      };
      if (!await repository.commitResult(captured, current)) return;
      current = captured;
      const failure = capturedFailure(answer);
      if (failure) {
        const terminal: PromptResult = { ...withoutLease(current), version: current.version + 1,
          status: answer.status === 'refused' ? 'refused' : answer.status === 'incomplete' ? 'incomplete' : 'failed_collection',
          completedAt: this.now().toISOString(), error: scanError(failure) };
        await repository.commitResult(terminal, current);
        await this.finalize(message.projectId, message.runId);
        return;
      }
      const extracting: PromptResult = { ...current, version: current.version + 1, status: 'extracting' };
      if (!await repository.commitResult(extracting, current)) return;
      current = extracting;
      const analysisKey = current.analysisKey ?? analysisKeyFor(current);
      let analysis = await artifacts.get<Analysis>(analysisKey);
      if (!analysis) {
        analysis = await provider.extract(answer, run.snapshot);
        await artifacts.put(analysisKey, analysis);
      }
      const target = analysis.brands.find(brand => brand.brandId === run.snapshot.brand.id);
      if (!target) throw new ProviderError('missing_target_analysis', 'The analysis did not contain the tracked brand.', true);
      const succeeded: PromptResult = {
        ...withoutLease(current), version: current.version + 1, status: 'succeeded', analysisKey,
        target, brands: analysis.brands, extractionUsage: analysis.usage, completedAt: this.now().toISOString(),
      };
      delete succeeded.error;
      if (await repository.commitResult(succeeded, current)) await this.finalize(message.projectId, message.runId);
    } catch (error) {
      const failure = scanError(error);
      if (error instanceof ExtractionError) {
        await artifacts.put(`${rootKey(current)}/extraction-attempt-${current.attempts}.json`, error.receipt);
      }
      const retryable = failure.retryable && current.attempts < MAX_ATTEMPTS && Date.parse(run.deadlineAt) > this.now().getTime();
      const next: PromptResult = {
        ...withoutLease(current), version: current.version + 1,
        status: retryable ? (current.captureKey ? 'captured' : 'queued') : (current.captureKey ? 'failed_extraction' : 'failed_collection'),
        error: { ...failure, retryable }, ...(retryable ? {} : { completedAt: this.now().toISOString() }),
      };
      if (!await repository.commitResult(next, current)) return;
      if (retryable) throw error;
      await this.finalize(message.projectId, message.runId);
    }
  }

  private async exhaust(result: PromptResult, code: string, message: string): Promise<void> {
    if (isTerminal(result.status)) return;
    await this.dependencies.repository.commitResult({ ...withoutLease(result), version: result.version + 1,
      status: result.captureKey ? 'failed_extraction' : 'failed_collection', error: { code, message, retryable: false }, completedAt: this.now().toISOString(),
    }, result);
    await this.finalize(result.projectId, result.runId);
  }

  private async retry(message: Extract<ScanMessage, { kind: 'retry' }>): Promise<void> {
    const { repository, queue } = this.dependencies;
    const run = await repository.getRun(message.projectId, message.runId);
    if (!run) return;
    const results = await repository.listResults(message.projectId, message.runId);
    const priorStamp = results.filter(result => result.lastRetryRequestId === message.requestId && result.lastRetryRequestedAt)
      .map(result => result.lastRetryRequestedAt!).sort()[0];
    const requestedAt = priorStamp ?? this.now().toISOString();
    for (const result of results) {
      if (result.status !== 'failed_collection' && result.status !== 'failed_extraction') continue;
      const history = result.retryRequestIds ?? (result.lastRetryRequestId ? [result.lastRetryRequestId] : []);
      if (history.includes(message.requestId) || history.length >= MAX_MANUAL_RETRIES) continue;
      const next: PromptResult = { ...withoutLease(result), version: result.version + 1, attempts: 0,
        status: result.status === 'failed_extraction' ? 'captured' : 'queued',
        lastRetryRequestId: message.requestId, lastRetryRequestedAt: requestedAt,
        retryRequestIds: [...history, message.requestId],
      };
      delete next.completedAt;
      delete next.error;
      if (result.status === 'failed_collection') {
        // Keep previous private evidence while preserving the response ID used by client links.
        next.captureGeneration = (result.captureGeneration ?? 0) + 1;
        delete next.captureKey;
        delete next.analysisKey;
        delete next.capturedAt;
        delete next.usage;
        next.citationCount = 0;
        next.sourceCount = 0;
      }
      await repository.commitResult(next, result);
    }
    // Re-read after CAS: duplicate retry deliveries repair partial fan-out, without resetting jobs again.
    const pending = (await repository.listResults(message.projectId, message.runId))
      .filter(result => result.lastRetryRequestId === message.requestId && !isTerminal(result.status));
    if (!pending.length) return;
    const deadline = Math.max(...pending.map(result => this.deadlineFor(run, result)));
    const latest = await repository.getRun(message.projectId, message.runId);
    if (latest && deadline > Date.parse(latest.deadlineAt)) {
      await repository.markRunRunning(message.projectId, message.runId, new Date(deadline).toISOString());
    }
    await queue.send(pending.filter(result => !this.hasLiveLease(result))
      .map(result => ({ kind: 'prompt' as const, projectId: result.projectId, runId: result.runId, promptId: result.promptId })));
  }

  private async reconcile(): Promise<void> {
    const { repository, queue } = this.dependencies;
    for (const run of await repository.listActiveRuns()) {
      const results = await repository.listResults(run.projectId, run.id);
      const jobs: ScanMessage[] = [];
      for (const result of results) {
        if (isTerminal(result.status) || this.hasLiveLease(result)) continue;
        if (result.attempts >= MAX_ATTEMPTS || this.deadlineFor(run, result) <= this.now().getTime()) {
          await this.exhaust(result, 'retry_exhausted', 'The scan exceeded its retry or time limit.');
        } else jobs.push({ kind: 'prompt', projectId: run.projectId, runId: run.id, promptId: result.promptId });
      }
      await queue.send(jobs);
      await this.finalize(run.projectId, run.id);
    }
  }

  async handleDeadLetter(message: ScanMessage): Promise<void> {
    if(message.kind==='onboard'){await this.dependencies.onboarding?.deadLetter(message.projectId,message.jobId);return;}
    if (message.kind === 'prompt') {
      const result = await this.dependencies.repository.getResult(message.projectId, message.runId, message.promptId);
      if (result && !this.hasLiveLease(result)) await this.exhaust(result, 'queue_delivery_exhausted', 'Queue delivery retries were exhausted.');
      return;
    }
    // Kickoff/retry messages contain no paid calls and can safely repair partial queue dispatch.
    await this.handle(message);
  }

  async finalize(projectId: string, runId: string): Promise<void> {
    const { repository, artifacts } = this.dependencies;
    const run = await repository.getRun(projectId, runId);
    if (!run || run.terminalCount !== run.totalCount || !run.totalCount) return;
    if (run.summaryVersion === run.resultVersion && ['completed', 'partial', 'failed'].includes(run.status)) return;
    const results = await repository.listResults(projectId, runId);
    if (results.length !== run.totalCount || !results.every(result => isTerminal(result.status))) return;
    const details = await Promise.all(results.map(async result => ({
      result,
      answer: result.captureKey ? await artifacts.get<CapturedAnswer>(result.captureKey) : null,
      analysis: result.analysisKey ? await artifacts.get<Analysis>(result.analysisKey) : null,
    })));
    const summary = buildSummary(run, results, details);
    for(const item of details)await repository.saveMeasurement(item.result,run,item.answer,item.analysis);
    const summaryKey = `projects/${projectId}/runs/${runId}/summaries/v${run.resultVersion}.json`;
    await artifacts.put(summaryKey, summary);
    const status = run.succeededCount === run.totalCount ? 'completed' : run.succeededCount === 0 ? 'failed' : 'partial';
    await repository.finalizeRun(projectId, runId, run.resultVersion, status, summaryKey, this.now().toISOString());
  }
}
