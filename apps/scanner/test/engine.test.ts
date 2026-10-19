import { describe, expect, it, vi } from 'vitest';
import type { ScanMessage, PromptResult, RunSummary, CapturedAnswer, Analysis } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, type AnswerProvider } from '@citevia/storage';
import { Scanner, captureKeyFor, MAX_ATTEMPTS, MAX_MANUAL_RETRIES, runIdFor } from '../src/engine.js';
import { ProviderError } from '../src/provider.js';
import { ExtractionError } from '../src/openai.js';
import { analysis, captured, instant, project } from './fixtures.js';

const kickoff: Extract<ScanMessage, { kind: 'kickoff' }> = { kind: 'kickoff', projectId: project.id, scheduledAt: instant };
async function setup(options: { repository?: MemoryRepository; artifacts?: MemoryArtifacts; provider?: AnswerProvider; promptCount?: number } = {}) {
  const repository = options.repository ?? new MemoryRepository();
  const artifacts = options.artifacts ?? new MemoryArtifacts();
  const queue = new MemoryQueue();
  const provider = options.provider ?? { collect: vi.fn(async () => captured()), extract: vi.fn(async (answer: CapturedAnswer) => analysis(answer)) };
  let time = new Date(instant);
  const scanner = new Scanner({ repository, artifacts, queue, provider, now: () => time });
  const saved = structuredClone(project);
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
    const provider = { collect: vi.fn(async () => captured()), extract: vi.fn().mockRejectedValueOnce(new ProviderError('openai_http_429', 'Rate limited.', true)).mockImplementation(async (answer: CapturedAnswer) => analysis(answer)) };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    await expect(env.scanner.handle(job)).rejects.toMatchObject({ code: 'openai_http_429' });
    expect((await env.repository.getResult(project.id, job.runId, job.promptId))!.status).toBe('captured');
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
    await expect(env.scanner.handle(job)).rejects.toThrow('interrupted');
    const result = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    expect(result.captureKey).toBeUndefined();
    expect(await env.artifacts.get(captureKeyFor(result))).not.toBeNull();
    await env.scanner.handle(job);
    expect(env.provider.collect).toHaveBeenCalledOnce();
    expect((await env.repository.getRun(project.id, job.runId))!.status).toBe('completed');
  });
  it('keeps malformed extraction receipts and terminates after bounded attempts', async () => {
    const receipt = { response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{broken' }] }], usage: { total_tokens: 20 } }, requestId: 'extract-request', receivedAt: instant };
    const provider = { collect: vi.fn(async () => captured()), extract: vi.fn(async () => { throw new ExtractionError(new ProviderError('invalid_extraction', 'Malformed extraction.', true), receipt); }) };
    const env = await setup({ provider, promptCount: 1 });
    await env.scanner.handle(kickoff);
    const job = promptMessages(env.queue.messages)[0];
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) await expect(env.scanner.handle(job)).rejects.toMatchObject({ code: 'invalid_extraction' });
    await env.scanner.handle(job);
    const result = (await env.repository.getResult(project.id, job.runId, job.promptId))!;
    expect(result).toMatchObject({ status: 'failed_extraction', attempts: MAX_ATTEMPTS, error: { retryable: false } });
    expect(provider.collect).toHaveBeenCalledOnce();
    expect(provider.extract).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect([...env.artifacts.values.keys()].filter(key => key.includes('extraction-attempt'))).toHaveLength(MAX_ATTEMPTS);
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
    expect(second).toMatchObject({ captureGeneration: 2, attempts: 1, retryRequestIds: ['retry-request-1', 'retry-request-2'] });
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
    expect(result).toMatchObject({ attempts: 1, captureGeneration: 1, error: { code: 'openai_http_400' } });
    expect(provider.collect).toHaveBeenCalledTimes(2);
  });
  it('bounds the retry request ledger and requires a new scan after 32 manual retries', async () => {
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

});
