import { describe, expect, it, vi } from 'vitest';
import type { ScanMessage, PromptResult, RunSummary, CapturedAnswer, Analysis, ScanRun } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, type AnswerProvider, type AnalysisBatchPort } from '@citevia/storage';
import { Scanner, captureKeyFor, MAX_ATTEMPTS, MAX_MANUAL_RETRIES, runIdFor } from '../src/engine.js';
import { ProviderError } from '../src/provider.js';
import { ExtractionError } from '../src/openai.js';
import { analysis, captured, instant, project } from './fixtures.js';

const kickoff: Extract<ScanMessage, { kind: 'kickoff' }> = { kind: 'kickoff', projectId: project.id, scheduledAt: instant };
async function setup(options: { repository?: MemoryRepository; artifacts?: MemoryArtifacts; provider?: AnswerProvider; promptCount?: number; parserVersion?: string; analysisBatch?: AnalysisBatchPort } = {}) {
  const repository = options.repository ?? new MemoryRepository();
  const artifacts = options.artifacts ?? new MemoryArtifacts();
  const queue = new MemoryQueue();
  const provider = options.provider ?? { collect: vi.fn(async () => captured()), extract: vi.fn(async (answer: CapturedAnswer) => analysis(answer)) };
  let time = new Date(instant);
  const scanner = new Scanner({ repository, artifacts, queue, provider, analysisBatch: options.analysisBatch, now: () => time });
  const saved = structuredClone(project);
  if (options.parserVersion) saved.parserVersion = options.parserVersion;
  if (options.promptCount) saved.prompts = Array.from({ length: options.promptCount }, (_, index) => ({ ...project.prompts[0], id: `p${index}` }));
  await repository.saveProject(saved, null);
  return { scanner, repository, artifacts, queue, provider, advance: (ms: number) => { time = new Date(time.getTime() + ms); } };
}
const promptMessages = (messages: ScanMessage[]) => messages.filter((message): message is Extract<ScanMessage, { kind: 'prompt' }> => message.kind === 'prompt');

describe('scanner engine lifecycle', () => {
  it('atomically freezes up to 50 prompts and deduplicates the scheduled run', async () => {
    const env = await setup({ promptCount: 50 });
    await env.scanner.handle(kickoff);
    await env.scanner.handle(kickoff);
    const runs = await env.repository.listRuns(project.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].totalCount).toBe(50);
    const results = await env.repository.listResults(project.id, runs[0].id);
    expect(results).toHaveLength(50);
    expect(results[0].responseId).toBe(`${runs[0].id}~${results[0].promptId}`);
    expect(env.queue.messages).toHaveLength(100); // Replay delivery is safe; manifest and paid calls remain deduplicated.
    const changed = await env.repository.getProject(project.id);
    changed!.prompts[0].text = 'Edited after scan start'; changed!.version++;
    await env.repository.saveProject(changed!, 1);
    expect((await env.repository.getRun(project.id, runs[0].id))!.snapshot.prompts[0].text).toBe(project.prompts[0].text);
  });
  it('pauses scheduled scans while allowing an explicitly requested manual scan', async () => {
    const env = await setup({ promptCount: 1 });
    const paused = (await env.repository.getProject(project.id))!;
    paused.enabled = false; paused.version++;
    await env.repository.saveProject(paused, 1);
    await env.scanner.handle(kickoff);
    expect(env.queue.messages).toHaveLength(0);
    await env.scanner.handle({ ...kickoff, trigger: 'manual', requestId: 'explicit-manual' });
    expect(env.queue.messages).toHaveLength(1);
    const run = (await env.repository.listRuns(project.id))[0];
    expect(Date.parse(run.deadlineAt) - Date.parse(run.createdAt)).toBe(3 * 60 * 60_000);
  });
  it('rejects more than 50 active prompts before creating a run', async () => {
    const env = await setup({ promptCount: 51 });
    await expect(env.scanner.handle(kickoff)).rejects.toMatchObject({ code: 'invalid_prompt_count' });
    expect(await env.repository.listRuns(project.id)).toHaveLength(0);
  });
  it('runs capture then extraction, finalizes metrics and ignores duplicate deliveries', async () => {
    const env = await setup();
    await env.scanner.handle(kickoff);
    const jobs = promptMessages(env.queue.messages);
    for (const job of jobs) await env.scanner.handle(job);
    for (const job of jobs) await env.scanner.handle(job);
    expect(env.provider.collect).toHaveBeenCalledTimes(2);
    expect(env.provider.extract).toHaveBeenCalledTimes(2);
    const run = (await env.repository.listRuns(project.id))[0];
    expect(run).toMatchObject({ status: 'completed', terminalCount: 2, succeededCount: 2, capturedCount: 2 });
    const summary = await env.artifacts.get<RunSummary>(run.summaryKey!);
    expect(summary!.metrics.visibility).toMatchObject({ value: 100, numerator: 2, denominator: 2 });
    expect(summary!.domains[0].answerCount).toBe(2);
    expect(run.summaryVersion).toBe(run.resultVersion);
  });
  it('uses CAS leases to prevent concurrent duplicate paid calls', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const provider = { collect: vi.fn(async () => { await waiting; return captured(); }), extract: vi.fn(async (answer: CapturedAnswer) => analysis(answer)) };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    const running = env.scanner.handle(job);
    const duplicate = env.scanner.handle(job);
    release();
    await Promise.all([running, duplicate]);
    expect(provider.collect).toHaveBeenCalledOnce();
    expect(provider.extract).toHaveBeenCalledOnce();
    expect((await env.repository.getRun(project.id, job.runId))!.succeededCount).toBe(1);
  });
  it('retries extraction from the saved answer, without a new web-search call', async () => {
    const provider = { collect: vi.fn(async () => captured()), extract: vi.fn().mockRejectedValueOnce(new ProviderError('openai_http_429', 'Rate limited.', true, null, { kind: 'rate_limit', safeToRetry: true, retryAfterMs: 60_000 })).mockImplementation(async (answer: CapturedAnswer) => analysis(answer)) };
    const env = await setup({ provider, promptCount: 1, parserVersion: 'igeo-evidence-v2' });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    expect((await env.repository.getResult(project.id, job.runId, job.promptId))!.status).toBe('captured');
    await env.scanner.handle(job); // An early duplicate cannot bypass the provider cooldown.
    expect(provider.extract).toHaveBeenCalledOnce();
    expect(env.queue.delays.at(-1)).toBe(60);
    env.advance(60_000);
    await env.scanner.handle(job);
    expect(provider.collect).toHaveBeenCalledOnce();
    expect(provider.extract).toHaveBeenCalledTimes(2);
    expect((await env.repository.getRun(project.id, job.runId))!.status).toBe('completed');
  });
  it('recovers the raw artifact if saving its metadata fails', async () => {
    class InterruptedRepository extends MemoryRepository {
      interrupted = false;
      override async commitResult(next: PromptResult, previous: PromptResult) {
        if (!this.interrupted && next.status === 'captured') { this.interrupted = true; throw new Error('interrupted after S3'); }
        return super.commitResult(next, previous);
      }
    }
    const env = await setup({ repository: new InterruptedRepository(), promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    const result = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    expect(result.captureKey).toBeUndefined();
    expect(await env.artifacts.get(captureKeyFor(result))).not.toBeNull();
    env.advance(60_000);
    await env.scanner.handle(job);
    expect(env.provider.collect).toHaveBeenCalledOnce();
    expect((await env.repository.getRun(project.id, job.runId))!.status).toBe('completed');
  });
  it('keeps malformed extraction receipts without replaying a paid invalid response', async () => {
    const receipt = { response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{broken' }] }], usage: { total_tokens: 20 } }, requestId: 'extract-request', receivedAt: instant };
    const provider = { collect: vi.fn(async () => captured()), extract: vi.fn(async () => { throw new ExtractionError(new ProviderError('invalid_extraction', 'Malformed extraction.', true), receipt); }) };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    await env.scanner.handle(job);
    const result = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    expect(result).toMatchObject({ status: 'failed_extraction', attempts: 1, error: { retryable: false } });
    expect(provider.collect).toHaveBeenCalledOnce();
    expect(provider.extract).toHaveBeenCalledOnce();
    expect([...env.artifacts.values.keys()].filter(key => key.includes('extraction-attempt'))).toHaveLength(1);
    expect((await env.repository.getRun(project.id, job.runId))!.status).toBe('failed');
  });
  it('saves refusals but does not analyze them or count them as captures', async () => {
    const answer = { ...captured(), status: 'refused' as const, refusal: 'Cannot answer.' };
    const provider = { collect: vi.fn(async () => answer), extract: vi.fn() };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    const result = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    expect(result.status).toBe('refused');
    expect(result.captureKey).toBeTruthy();
    expect(result.capturedAt).toBeUndefined();
    expect(provider.extract).not.toHaveBeenCalled();
    const run = (await env.repository.getRun(project.id, job.runId))!;
    expect(run.capturedCount).toBe(0);
  });
  it('manual collection retry keeps response IDs stable and preserves failed evidence', async () => {
    const invalid = captured(); invalid.raw = { response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: invalid.text }] }] } };
    const provider = { collect: vi.fn().mockResolvedValueOnce(invalid).mockResolvedValue(captured()), extract: vi.fn(async (answer: CapturedAnswer) => analysis(answer)) };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    const previous = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    expect(previous.status).toBe('failed_collection');
    env.advance(2 * 86400_000);
    await env.scanner.handle({ kind: 'retry', projectId: project.id, runId: job.runId, requestId: 'manual-retry-1' });
    await env.scanner.handle(job);
    const result = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    expect(result.responseId).toBe(previous.responseId);
    expect(result.captureGeneration).toBe(1);
    expect(result.status).toBe('succeeded');
    expect(await env.artifacts.get(previous.captureKey!)).toEqual(invalid);
    expect(provider.collect).toHaveBeenCalledTimes(2);
  });
  it('reconciliation repairs missing queue dispatch and expires abandoned jobs', async () => {
    const env = await setup({ promptCount: 1 });
    await env.scanner.handle(kickoff);
    env.queue.messages.length = 0;
    await env.scanner.handle({ kind: 'reconcile' });
    expect(env.queue.messages).toHaveLength(1);
    env.advance(25 * 60 * 60_000);
    await env.scanner.handle({ kind: 'reconcile' });
    expect((await env.repository.getRun(project.id, runIdFor(kickoff)))!.status).toBe('failed');
    expect(env.provider.collect).not.toHaveBeenCalled();
  });
  it('records DLQ exhaustion visibly without double counting terminal results', async () => {
    const env = await setup({ promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handleDeadLetter(job);
    await env.scanner.handleDeadLetter(job);
    const result = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    expect(result.error!.code).toBe('queue_delivery_exhausted');
    expect((await env.repository.getRun(project.id, job.runId))!.terminalCount).toBe(1);
  });
  it('does not re-admit duplicate retries, including an old request after a newer retry failed', async () => {
    const provider = { collect: vi.fn(async () => { throw new ProviderError('openai_http_400', 'Bad request.', false); }), extract: vi.fn() };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    const retry = { kind: 'retry' as const, projectId: project.id, runId: job.runId, requestId: 'retry-request-1' };
    await env.scanner.handle(retry);
    await env.scanner.handle(job);
    const first = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    const firstDeadline = (await env.repository.getRun(project.id, job.runId))!.deadlineAt;
    env.advance(60 * 60_000);
    await env.scanner.handle(retry);
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toEqual(first);
    expect((await env.repository.getRun(project.id, job.runId))!.deadlineAt).toBe(firstDeadline);
    await env.scanner.handle({ ...retry, requestId: 'retry-request-2' });
    await env.scanner.handle(job);
    const second = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    expect(second).toMatchObject({ captureGeneration: 2, attempts: 3, retryRequestIds: ['retry-request-1', 'retry-request-2'] });
    const queueCount = env.queue.messages.length;
    await env.scanner.handle(retry);
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toEqual(second);
    expect(env.queue.messages).toHaveLength(queueCount);
    expect(provider.collect).toHaveBeenCalledTimes(3);
  });
  it('repairs retry fan-out without changing the original deadline or attempt generation', async () => {
    const provider = { collect: vi.fn(async () => { throw new ProviderError('openai_http_400', 'Bad request.', false); }), extract: vi.fn() };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    env.advance(24 * 60 * 60_000);
    const send = env.queue.send.bind(env.queue);
    env.queue.send = vi.fn().mockRejectedValueOnce(new Error('fanout failed')).mockImplementation(send);
    const retry = { kind: 'retry' as const, projectId: project.id, runId: job.runId, requestId: 'retry-request-1' };
    await expect(env.scanner.handle(retry)).rejects.toThrow('fanout failed');
    const saved = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    const deadline = (await env.repository.getRun(project.id, job.runId))!.deadlineAt;
    env.advance(60 * 60_000);
    await env.scanner.handle(retry);
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toEqual(saved);
    expect((await env.repository.getRun(project.id, job.runId))!.deadlineAt).toBe(deadline);
    expect(env.queue.messages.at(-1)).toEqual(job);
  });
  it('repairs a recorded retry intent after a crash before reopening the run deadline', async () => {
    class InterruptedRepository extends MemoryRepository {
      interrupted = false;
      override async markRunRunning(projectId: string, runId: string, deadlineAt?: string) {
        if (deadlineAt && !this.interrupted) { this.interrupted = true; throw new Error('deadline update failed'); }
        return super.markRunRunning(projectId, runId, deadlineAt);
      }
    }
    const provider = { collect: vi.fn(async () => { throw new ProviderError('openai_http_400', 'Bad request.', false); }), extract: vi.fn() };
    const env = await setup({ repository: new InterruptedRepository(), provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    env.advance(24 * 60 * 60_000);
    await expect(env.scanner.handle({ kind: 'retry', projectId: project.id, runId: job.runId, requestId: 'retry-request-1' })).rejects.toThrow('deadline update failed');
    await env.scanner.handle(job);
    const result = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    expect(result).toMatchObject({ attempts: 2, captureGeneration: 1, error: { code: 'openai_http_400' } });
    expect(provider.collect).toHaveBeenCalledTimes(2);
  });
  it('bounds the retry request ledger to three manual retries', async () => {
    const env = await setup({ promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handleDeadLetter(job);
    const previous = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    const full = { ...previous, version: previous.version + 1, retryRequestIds: Array.from({ length: MAX_MANUAL_RETRIES }, (_, i) => `retry-request-${i}`) };
    await env.repository.commitResult(full, previous);
    const queueCount = env.queue.messages.length;
    await env.scanner.handle({ kind: 'retry', projectId: project.id, runId: job.runId, requestId: 'retry-new-request' });
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toEqual(full);
    expect(env.queue.messages).toHaveLength(queueCount);
  });

  it('repairs a reopened terminal run even when its summary version already matches', async () => {
    class ReopenedRepository extends MemoryRepository {
      async simulateDelayedLegacyUpdate(runId: string) {
        return this.operation(() => {
          const run = this.state.runs[`${project.id}:${runId}`];
          run.status = 'running';
          delete run.completedAt;
        }, true);
      }
    }
    const repository = new ReopenedRepository();
    const env = await setup({ repository, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    const completed = (await repository.getRun(project.id, job.runId))!;
    expect(completed.status).toBe('completed');
    await repository.simulateDelayedLegacyUpdate(job.runId);
    const reopened = (await repository.getRun(project.id, job.runId))!;
    expect(reopened.summaryVersion).toBe(reopened.resultVersion);
    await env.scanner.handle({ kind: 'reconcile' });
    expect(await repository.getRun(project.id, job.runId)).toMatchObject({ status: 'completed', terminalCount: 1, succeededCount: 1, resultVersion: completed.resultVersion });
    expect(env.provider.collect).toHaveBeenCalledOnce();
  });

  it('allows exactly three retries per stage and retains the saved collection across extraction retries', async () => {
    const rejected = () => new ProviderError('openai_http_429', 'Rate limited.', true, null, { kind: 'rate_limit', safeToRetry: true });
    const provider = {
      collect: vi.fn().mockRejectedValueOnce(rejected()).mockRejectedValueOnce(rejected()).mockRejectedValueOnce(rejected()).mockResolvedValue(captured()),
      extract: vi.fn(async (_answer: CapturedAnswer) => { throw rejected(); }),
    };
    const env = await setup({ provider, promptCount: 1, parserVersion: 'igeo-evidence-v2' });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    for (let call = 0; call < 7; call++) {
      await env.scanner.handle(job);
      env.advance(15 * 60_000);
    }
    await env.scanner.handle(job);
    await env.scanner.handle({ kind: 'reconcile' });
    const result = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    expect(result).toMatchObject({ status: 'failed_extraction', collectionAttempts: MAX_ATTEMPTS, analysisAttempts: MAX_ATTEMPTS, error: { retryable: false } });
    expect(provider.collect).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(provider.extract).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(provider.extract.mock.calls.every(([answer]) => answer.providerResponseId === captured().providerResponseId)).toBe(true);
    // A manual retry uses the same durable budget; it cannot buy a fifth analysis.
    await env.scanner.handle({ kind: 'retry', projectId: project.id, runId: job.runId, requestId: 'beyond-limit' });
    await env.scanner.handle(job);
    expect(provider.extract).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('does not consume attempts while the shared provider admission gate is busy', async () => {
    const deferred = new ProviderError('provider_admission_deferred', 'Waiting for provider capacity.', true, null,
      { kind: 'deferred', safeToRetry: true, retryAfterMs: 10_000 });
    const extract = vi.fn();
    for (let i = 0; i < 6; i++) extract.mockRejectedValueOnce(deferred);
    extract.mockImplementation(async (answer: CapturedAnswer) => analysis(answer));
    const provider = { collect: vi.fn(async () => captured()), extract };
    const env = await setup({ provider, promptCount: 1, parserVersion: 'igeo-evidence-v2' });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    for (let i = 0; i < 6; i++) {
      await env.scanner.handle(job);
      expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toMatchObject({ collectionAttempts: 1, analysisAttempts: 0, attempts: 1, status: 'captured' });
      env.advance(10_000);
    }
    await env.scanner.handle(job);
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toMatchObject({ status: 'succeeded', collectionAttempts: 1, analysisAttempts: 1 });
    expect(provider.collect).toHaveBeenCalledOnce();
  });

  it('honors a cooldown beyond the SQS delay limit through duplicate deliveries and reconciliation', async () => {
    const provider = {
      collect: vi.fn().mockRejectedValueOnce(new ProviderError('openai_http_429', 'Rate limited.', true, null,
        { kind: 'rate_limit', safeToRetry: true, retryAfterMs: 30 * 60_000 })).mockResolvedValue(captured()),
      extract: vi.fn(async (answer: CapturedAnswer) => analysis(answer)),
    };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    expect(env.queue.delays.at(-1)).toBe(900);
    const before = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    env.advance(15 * 60_000);
    const queued = env.queue.messages.length;
    await env.scanner.handle({ kind: 'reconcile' });
    expect(env.queue.messages).toHaveLength(queued);
    await env.scanner.handle(job);
    await env.scanner.handleDeadLetter(job);
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toEqual(before);
    expect(provider.collect).toHaveBeenCalledOnce();
    expect(env.queue.delays.at(-1)).toBe(900);
    env.advance(15 * 60_000);
    await env.scanner.handle(job);
    expect(provider.collect).toHaveBeenCalledTimes(2);
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toMatchObject({ status: 'succeeded' });
  });

  it('recovers a failed delayed enqueue from persisted retry state', async () => {
    const provider = {
      collect: vi.fn(async () => captured()),
      extract: vi.fn().mockRejectedValueOnce(new ProviderError('openai_http_503', 'Unavailable.', true, null,
        { kind: 'transient', safeToRetry: true, retryAfterMs: 60_000 })).mockImplementation(async (answer: CapturedAnswer) => analysis(answer)),
    };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    env.queue.messages.length = 0;
    const send = env.queue.send.bind(env.queue);
    env.queue.send = vi.fn().mockRejectedValueOnce(new Error('SQS unavailable')).mockImplementation(send);
    await expect(env.scanner.handle(job)).rejects.toThrow('SQS unavailable');
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toMatchObject({ status: 'captured', safeRetryStage: 'analysis', retryNotBefore: new Date(Date.parse(instant) + 60_000).toISOString() });
    await env.scanner.handle({ kind: 'reconcile' });
    expect(env.queue.messages).toHaveLength(0);
    env.advance(60_000);
    await env.scanner.handle({ kind: 'reconcile' });
    expect(env.queue.messages).toEqual([job]);
    await env.scanner.handle(job);
    expect(provider.collect).toHaveBeenCalledOnce();
    expect(provider.extract).toHaveBeenCalledTimes(2);
  });

  it('stops a hard quota failure without repeatedly buying collection or analysis', async () => {
    const provider = {
      collect: vi.fn(async () => captured()),
      extract: vi.fn(async () => { throw new ProviderError('openai_quota_exhausted', 'Provider billing quota requires attention.', false, null,
        { kind: 'quota', safeToRetry: false }); }),
    };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    await env.scanner.handle(job);
    await env.scanner.handle({ kind: 'reconcile' });
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toMatchObject({ status: 'failed_extraction', analysisAttempts: 1, error: { kind: 'quota', retryable: false } });
    expect(provider.collect).toHaveBeenCalledOnce();
    expect(provider.extract).toHaveBeenCalledOnce();
  });

  it('never repeats a provider call after an uncertain outcome', async () => {
    const provider = {
      collect: vi.fn(async () => { throw new ProviderError('openai_timeout', 'The outcome is unknown.', false, null,
        { kind: 'uncertain', safeToRetry: false }); }),
      extract: vi.fn(),
    };
    const env = await setup({ provider, promptCount: 1, parserVersion: 'igeo-evidence-v2' });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    env.advance(15 * 60_000);
    await env.scanner.handle(job);
    await env.scanner.handle({ kind: 'reconcile' });
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toMatchObject({ status: 'failed_collection', collectionAttempts: 1, error: { kind: 'uncertain', retryable: false } });
    expect(provider.collect).toHaveBeenCalledOnce();
    expect(provider.extract).not.toHaveBeenCalled();
  });

  it('does not consume a paid-call attempt when a known quota circuit blocks an explicit retry', async () => {
    const extract = vi.fn()
      .mockRejectedValueOnce(new ProviderError('openai_quota_exhausted', 'Billing quota exhausted.', false, null, { kind: 'quota', safeToRetry: false }))
      .mockRejectedValueOnce(new ProviderError('provider_quota_blocked', 'Resolve provider billing first.', false, null, { kind: 'quota', safeToRetry: false }))
      .mockImplementation(async (answer: CapturedAnswer) => analysis(answer));
    const provider = { collect: vi.fn(async () => captured()), extract };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    // The original HTTP quota rejection consumed one provider request.
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toMatchObject({ analysisAttempts: 1 });
    await env.scanner.handle({ kind: 'retry', projectId: project.id, runId: job.runId, requestId: 'still-blocked' });
    await env.scanner.handle(job);
    const blocked = await env.repository.getResult(project.id, job.runId, job.promptId);
    expect(blocked).toMatchObject({ status: 'failed_extraction', analysisAttempts: 1, error: { kind: 'quota', retryable: false } });
    expect(blocked?.pendingCallStage).toBeUndefined();
    await env.scanner.handle({ kind: 'retry', projectId: project.id, runId: job.runId, requestId: 'billing-resolved' });
    await env.scanner.handle(job);
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toMatchObject({ status: 'succeeded', analysisAttempts: 2, collectionAttempts: 1 });
    expect(provider.collect).toHaveBeenCalledOnce();
  });

  it('recovers a saved analysis after a metadata write fails without a second model call', async () => {
    class InterruptedRepository extends MemoryRepository {
      interrupted = false;
      override async commitResult(next: PromptResult, previous: PromptResult) {
        if (!this.interrupted && next.status === 'succeeded') { this.interrupted = true; throw new Error('interrupted after analysis checkpoint'); }
        return super.commitResult(next, previous);
      }
    }
    const env = await setup({ repository: new InterruptedRepository(), promptCount: 1, parserVersion: 'igeo-evidence-v2' });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    env.advance(60_000);
    await env.scanner.handle(job);
    expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toMatchObject({ status: 'succeeded', collectionAttempts: 1, analysisAttempts: 1 });
    expect(env.provider.collect).toHaveBeenCalledOnce();
    expect(env.provider.extract).toHaveBeenCalledOnce();
  });

  it('does not revive a canceled scan through kickoff, retry, prompt or reconciliation', async () => {
    class CanceledRepository extends MemoryRepository {
      cancel(runId: string) {
        return this.operation(() => { this.state.runs[`${project.id}:${runId}`].cancelledAt = instant; }, true);
      }
    }
    const repository = new CanceledRepository();
    const env = await setup({ repository, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await repository.cancel(job.runId);
    env.queue.messages.length = 0;
    await env.scanner.handle(kickoff);
    await env.scanner.handle(job);
    await env.scanner.handle({ kind: 'retry', projectId: project.id, runId: job.runId, requestId: 'retry-canceled' });
    await env.scanner.handleDeadLetter(job);
    await env.scanner.handle({ kind: 'reconcile' });
    expect(env.queue.messages).toHaveLength(0);
    expect(env.provider.collect).not.toHaveBeenCalled();
    expect(env.provider.extract).not.toHaveBeenCalled();
  });

  it('terminates a retry beyond the run deadline without overflowing dates or retrying early', async () => {
    const provider = {
      collect: vi.fn(async () => { throw new ProviderError('openai_http_429', 'Rate limited.', true, null,
        { kind: 'rate_limit', safeToRetry: true, retryAfterMs: Number.MAX_SAFE_INTEGER }); }),
      extract: vi.fn(),
    };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await env.scanner.handle(job);
    const result = await env.repository.getResult(project.id, job.runId, job.promptId);
    expect(result).toMatchObject({ status: 'failed_collection', error: { retryable: false } });
    expect(result?.retryNotBefore).toBeUndefined();
    expect(provider.collect).toHaveBeenCalledOnce();
  });

  it('retries only safely rejected batch items up to three times without recollecting their answers', async () => {
    vi.stubEnv('ANALYSIS_BATCH_ENABLED', 'true');
    try {
      const process: AnalysisBatchPort['process'] = vi.fn(async (_run: ScanRun, results: PromptResult[]) => ({
        batchId: `batch-${results[0].analysisAttempts}`,
        updates: results.filter((result) => result.status === 'analysis_pending').map((result) => ({
          promptId: result.promptId, captureKey: result.captureKey!, analysisAttempt: result.analysisAttempts,
          error: { code: 'openai_http_429', message: 'Batch item rate limited.', retryable: true, kind: 'rate_limit' as const, safeToRetry: true, retryAfterMs: 60_000 },
        })),
      }));
      const complete = vi.fn(async () => {});
      const env = await setup({ promptCount: 1, analysisBatch: { process, complete } });
      await env.scanner.handle(kickoff);
      const job = promptMessages(env.queue.messages)[0];
      for (let generation = 1; generation <= MAX_ATTEMPTS; generation++) {
        await env.scanner.handle(job);
        const result = await env.repository.getResult(project.id, job.runId, job.promptId);
        expect(result).toMatchObject({ collectionAttempts: 1, analysisAttempts: generation, status: generation < MAX_ATTEMPTS ? 'captured' : 'failed_extraction' });
        expect(complete).toHaveBeenCalledWith(`batch-${generation}`);
        env.advance(15 * 60_000);
      }
      await env.scanner.handle(job);
      await env.scanner.handle({ kind: 'reconcile' });
      expect(env.provider.collect).toHaveBeenCalledOnce();
      expect(env.provider.extract).not.toHaveBeenCalled();
      expect(process).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    } finally { vi.unstubAllEnvs(); }
  });

  it('ignores replayed output from a previous batch retry generation', async () => {
    vi.stubEnv('ANALYSIS_BATCH_ENABLED', 'true');
    try {
      let replayOld = false;
      const process: AnalysisBatchPort['process'] = vi.fn(async (_run: ScanRun, results: PromptResult[]) => ({
        batchId: 'first-batch', updates: results.filter((result) => result.status === 'analysis_pending').map((result) => ({
          promptId: result.promptId, captureKey: result.captureKey!, analysisAttempt: 1,
          error: { code: 'openai_http_429', message: 'Batch item rate limited.', retryable: true, kind: 'rate_limit' as const, safeToRetry: true, retryAfterMs: 60_000 },
        })),
      }));
      const complete = vi.fn(async () => { if (!replayOld) { replayOld = true; throw new Error('completion checkpoint interrupted'); } });
      const env = await setup({ promptCount: 1, analysisBatch: { process, complete } });
      await env.scanner.handle(kickoff);
      const job = promptMessages(env.queue.messages)[0];
      await expect(env.scanner.handle(job)).rejects.toThrow('completion checkpoint interrupted');
      env.advance(60_000);
      await env.scanner.handle(job);
      // Completing the old record must not apply its failure a second time to generation two.
      expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toMatchObject({ status: 'analysis_pending', analysisAttempts: 2, collectionAttempts: 1 });
      expect(complete).toHaveBeenCalledTimes(2);
      expect(env.provider.collect).toHaveBeenCalledOnce();
    } finally { vi.unstubAllEnvs(); }
  });

  it('imports a frozen batch created before per-stage attempt counters existed', async () => {
    vi.stubEnv('ANALYSIS_BATCH_ENABLED', 'true');
    try {
      let ready = false;
      const process: AnalysisBatchPort['process'] = vi.fn(async (_run: ScanRun, results: PromptResult[]) => ({
        batchId: ready ? 'legacy-batch' : undefined,
        updates: ready ? results.map((result) => ({
          promptId: result.promptId, captureKey: result.captureKey!, analysisAttempt: 1,
          analysisKey: `${result.captureKey}.analysis`, analysis: analysis(captured()),
        })) : [],
      }));
      const complete = vi.fn(async () => {});
      const env = await setup({ promptCount: 1, analysisBatch: { process, complete } });
      await env.scanner.handle(kickoff);
      const job = promptMessages(env.queue.messages)[0];
      await env.scanner.handle(job);
      const before = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
      const legacy = { ...before, version: before.version + 1 };
      delete legacy.collectionAttempts;
      delete legacy.analysisAttempts;
      await env.repository.commitResult(legacy, before);
      ready = true;
      await env.scanner.handle(job);
      expect(await env.repository.getResult(project.id, job.runId, job.promptId)).toMatchObject({ status: 'succeeded', attempts: 1 });
      expect(complete).toHaveBeenCalledWith('legacy-batch');
      expect(env.provider.collect).toHaveBeenCalledOnce();
      expect(env.provider.extract).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

});
