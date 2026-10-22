import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptResult, ScanMessage, ScanRun } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, MemoryScanDispatchStore, type AnalysisBatchPort, type AnswerProvider } from '@citevia/storage';
import { Scanner, providerRunIdFor, runIdFor } from '../src/engine.js';
import { analysis, captured, instant, project, snapshot } from './fixtures.js';

afterEach(() => vi.unstubAllEnvs());
const hour = 60 * 60_000;

async function pendingRun(count = 1) {
  const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  await repository.saveProject(structuredClone(project), null);
  const run: ScanRun = {
    projectId: project.id, id: 'late-batch', scheduledAt: instant, createdAt: instant, trigger: 'scheduled', status: 'running',
    snapshot: { ...snapshot, provider: 'openai', analysisMode: 'batch', prompts: project.prompts.slice(0, count) },
    totalCount: count, terminalCount: 0, succeededCount: 0, capturedCount: count, resultVersion: 0,
    deadlineAt: new Date(Date.parse(instant) + 30 * hour).toISOString(), expiresAt: 2_000_000_000,
  };
  const results: PromptResult[] = run.snapshot.prompts.map(prompt => ({
    projectId: project.id, runId: run.id, promptId: prompt.id, responseId: `${run.id}~${prompt.id}`, prompt,
    status: 'analysis_pending', captureKey: `projects/${project.id}/runs/${run.id}/${prompt.id}/capture.json`,
    capturedAt: instant, attempts: 1, collectionAttempts: 1, analysisAttempts: 1, version: 1,
    citationCount: 1, sourceCount: 1, expiresAt: run.expiresAt,
  }));
  for (const result of results) await artifacts.put(result.captureKey!, captured());
  await repository.createRun(run, results);
  let time = Date.parse(instant) + 31 * hour;
  const provider = { collect: vi.fn(async () => captured()), extract: vi.fn(async () => analysis(captured())) };
  const makeScanner = (port: AnalysisBatchPort) => new Scanner({ repository, artifacts, queue, provider, analysisBatch: port, now: () => new Date(time) });
  return { repository, artifacts, queue, provider, run, results, makeScanner, advance: (milliseconds: number) => { time += milliseconds; } };
}

describe('fleet batch deadline recovery', () => {
  it('retains a pending paid batch past the original deadline and repairs the stored deadline', async () => {
    const f = await pendingRun();
    const deadlineAt = new Date(Date.parse(instant) + 55 * hour).toISOString();
    const port: AnalysisBatchPort = { process: vi.fn(async () => ({ deadlineAt, updates: [] })), complete: vi.fn() };
    const scanner = f.makeScanner(port);
    await scanner.handle({ kind: 'reconcile' });
    expect(await f.repository.getResult(project.id, f.run.id, f.results[0].promptId)).toMatchObject({ status: 'analysis_pending', analysisAttempts: 1 });
    expect(await f.repository.getRun(project.id, f.run.id)).toMatchObject({ status: 'running', deadlineAt });
    vi.mocked(port.process).mockClear();
    // A stale queued prompt also polls the paid batch instead of expiring or recollecting it.
    await scanner.handle({ kind: 'prompt', projectId: project.id, runId: f.run.id, promptId: f.results[0].promptId });
    expect(f.provider.collect).not.toHaveBeenCalled();
    expect(f.provider.extract).not.toHaveBeenCalled();
    expect(port.process).toHaveBeenCalledOnce();
  });

  it('imports completed output before applying the original expired run deadline', async () => {
    const f = await pendingRun();
    const result = f.results[0], saved = analysis(captured()), analysisKey = `${result.captureKey}.analysis`;
    await f.artifacts.put(analysisKey, saved);
    const port: AnalysisBatchPort = {
      process: vi.fn(async () => ({ batchId: 'already-paid', deadlineAt: new Date(Date.parse(instant) + 55 * hour).toISOString(),
        updates: [{ promptId: result.promptId, captureKey: result.captureKey!, analysisAttempt: 1, analysisKey, analysis: saved }] })),
      complete: vi.fn(),
    };
    await f.makeScanner(port).handle({ kind: 'reconcile' });
    expect(await f.repository.getRun(project.id, f.run.id)).toMatchObject({ status: 'completed', succeededCount: 1 });
    expect(port.complete).toHaveBeenCalledWith('already-paid');
    expect(f.provider.collect).not.toHaveBeenCalled();
  });

  it('submits saved answers after unfinished collection times out instead of expiring those answers too', async () => {
    const f = await pendingRun(2), queued = f.results[1];
    await f.repository.commitResult({ ...queued, version: queued.version + 1, status: 'queued', captureKey: undefined, capturedAt: undefined,
      attempts: 0, collectionAttempts: 0, analysisAttempts: 0 }, queued);
    const deadlineAt = new Date(Date.parse(instant) + 57 * hour).toISOString();
    const port: AnalysisBatchPort = { process: vi.fn(async () => ({ deadlineAt, updates: [] })), complete: vi.fn() };
    await f.makeScanner(port).handle({ kind: 'reconcile' });
    expect(await f.repository.getResult(project.id, f.run.id, queued.promptId)).toMatchObject({ status: 'failed_collection' });
    expect(await f.repository.getResult(project.id, f.run.id, f.results[0].promptId)).toMatchObject({ status: 'analysis_pending' });
    expect(port.process).toHaveBeenCalledOnce();
    expect(await f.repository.getRun(project.id, f.run.id)).toMatchObject({ deadlineAt, status: 'running' });
  });

  it('ignores stale-attempt output and stops after the initial analysis plus three safe retries', async () => {
    const f = await pendingRun(), previous = f.results[0];
    await f.repository.commitResult({ ...previous, version: previous.version + 1, analysisAttempts: 4, attempts: 4 }, previous);
    const error = { code: 'analysis_batch_item_expired', message: 'Unprocessed item expired.', kind: 'transient' as const, safeToRetry: true, retryable: true };
    let attempt = 3;
    const port: AnalysisBatchPort = { process: vi.fn(async () => ({ deadlineAt: new Date(Date.parse(instant) + 57 * hour).toISOString(),
      updates: [{ promptId: previous.promptId, captureKey: previous.captureKey!, analysisAttempt: attempt, error }] })), complete: vi.fn() };
    const scanner = f.makeScanner(port);
    await scanner.handle({ kind: 'reconcile' });
    expect(await f.repository.getResult(project.id, f.run.id, previous.promptId)).toMatchObject({ status: 'analysis_pending', analysisAttempts: 4 });
    attempt = 4;
    await scanner.handle({ kind: 'reconcile' });
    expect(await f.repository.getResult(project.id, f.run.id, previous.promptId)).toMatchObject({ status: 'failed_extraction', analysisAttempts: 4, error: { retryable: false } });
    expect(await f.repository.getRun(project.id, f.run.id)).toMatchObject({ status: 'failed' });
    expect(f.queue.messages).toHaveLength(0);
    expect(f.provider.collect).not.toHaveBeenCalled();
  });
});

describe('three-provider fleet capture and batch recovery', () => {
  it('does not recreate missing old provider siblings while a newer scheduled group is active', async () => {
    const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
    const time = new Date(Date.parse(instant) + 85 * hour);
    const scanProviders = [
      { provider: 'openai' as const, model: 'openai-fixture' }, { provider: 'gemini' as const, model: 'gemini-fixture' },
      { provider: 'perplexity' as const, model: 'perplexity-fixture' },
    ];
    await repository.saveProject({ ...structuredClone(project), scanProviders }, null);
    const oldKickoff = { kind: 'kickoff' as const, projectId: project.id, scheduledAt: instant, trigger: 'scheduled' as const };
    // A crashed original kickoff left only its primary manifest. Reconciliation
    // completed that provider, whose batch retries extended its original deadline.
    const oldRun: ScanRun = {
      projectId: project.id, id: runIdFor(oldKickoff), groupId: runIdFor(oldKickoff), scheduledAt: instant, createdAt: instant,
      trigger: 'scheduled', status: 'completed', snapshot: { ...snapshot, provider: 'openai', scanProviders },
      totalCount: project.prompts.length, terminalCount: project.prompts.length, succeededCount: project.prompts.length,
      capturedCount: project.prompts.length, resultVersion: 1, summaryVersion: 1,
      deadlineAt: new Date(time.getTime() + 24 * hour).toISOString(), expiresAt: 2_000_000_000,
    };
    await repository.createRun(oldRun, project.prompts.map(prompt => ({
      projectId: project.id, runId: oldRun.id, promptId: prompt.id, responseId: `${oldRun.id}~${prompt.id}`, prompt,
      status: 'succeeded', attempts: 1, version: 1, citationCount: 1, sourceCount: 1, expiresAt: oldRun.expiresAt,
    })));
    const scanner = new Scanner({ repository, artifacts, queue, dispatch: new MemoryScanDispatchStore({ now: () => time }),
      provider: { collect: vi.fn(async () => captured()), extract: vi.fn(async () => analysis(captured())) }, now: () => time });
    const nextKickoff = { ...oldKickoff, scheduledAt: time.toISOString() };
    await scanner.handle(nextKickoff);
    await scanner.handle(oldKickoff);
    const active = await repository.listActiveRuns();
    expect(active).toHaveLength(3);
    expect(new Set(active.map(run => run.groupId))).toEqual(new Set([runIdFor(nextKickoff)]));
    for (const provider of ['gemini', 'perplexity'] as const)
      expect(await repository.getRun(project.id, providerRunIdFor(oldRun.id, provider, 'openai'))).toBeNull();
  });

  it('collects each provider once and retries only unsuccessful batch items using their saved answers', async () => {
    vi.stubEnv('ANALYSIS_BATCH_ENABLED', 'true');
    const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
    let time = Date.parse(instant);
    const dispatch = new MemoryScanDispatchStore({ now: () => new Date(time) });
    await repository.saveProject({ ...structuredClone(project), scanProviders: [
      { provider: 'openai', model: 'openai-fixture' }, { provider: 'gemini', model: 'gemini-fixture' }, { provider: 'perplexity', model: 'perplexity-fixture' },
    ] }, null);
    const provider = { collect: vi.fn<AnswerProvider['collect']>(async (_prompt, runSnapshot) => ({ ...captured(), provider: runSnapshot.provider, model: runSnapshot.generationModel })),
      extract: vi.fn(async () => analysis(captured())) };
    const process = vi.fn<AnalysisBatchPort['process']>(async (run, results) => {
      const pending = results.filter(result => result.status === 'analysis_pending');
      const updates = [];
      for (const result of pending) {
        if (result.promptId === project.prompts[1].id && result.analysisAttempts === 1) {
          updates.push({ promptId: result.promptId, captureKey: result.captureKey!, analysisAttempt: 1,
            error: { code: 'analysis_batch_item_expired', message: 'Unprocessed item expired.', kind: 'transient' as const, retryable: true, safeToRetry: true } });
        } else {
          const saved = analysis(captured()), analysisKey = `${result.captureKey}.analysis`;
          await artifacts.put(analysisKey, saved);
          updates.push({ promptId: result.promptId, captureKey: result.captureKey!, analysisAttempt: result.analysisAttempts, analysisKey, analysis: saved });
        }
      }
      return { batchId: `${run.id}-attempt-${pending[0]?.analysisAttempts}`, updates,
        deadlineAt: new Date(time + 26 * hour).toISOString() };
    });
    const port = { process, complete: vi.fn(async () => {}) };
    const scanner = new Scanner({ repository, artifacts, queue, provider, dispatch, analysisBatch: port, now: () => new Date(time) });
    const drain = async () => {
      let count = 0;
      while (queue.messages.length) {
        if (++count > 100) throw new Error('Unbounded dispatch loop');
        await scanner.handle(queue.messages.shift()!);
      }
    };
    const kickoff: ScanMessage = { kind: 'kickoff', projectId: project.id, scheduledAt: instant, trigger: 'scheduled' };
    await scanner.handle(kickoff);
    const duplicates = structuredClone(queue.messages);
    await drain();
    const runs = await repository.listRuns(project.id);
    expect(runs).toHaveLength(3);
    expect(provider.collect).toHaveBeenCalledTimes(6);
    expect(new Set(provider.collect.mock.calls.map(([, runSnapshot]) => runSnapshot.provider))).toEqual(new Set(['openai', 'gemini', 'perplexity']));
    const before = await Promise.all(runs.map(run => repository.listResults(project.id, run.id)));
    expect(before.every(results => results[0].status === 'succeeded' && results[1].status === 'captured')).toBe(true);
    const captureKeys = before.map(results => results[1].captureKey);
    time += 60_000;
    await scanner.handle({ kind: 'reconcile' });
    await drain();
    const after = await Promise.all(runs.map(run => repository.listResults(project.id, run.id)));
    expect(after.every(results => results.every(result => result.status === 'succeeded'))).toBe(true);
    expect(after.map(results => results[1].captureKey)).toEqual(captureKeys);
    expect(after.every(results => results[0].analysisAttempts === 1 && results[1].analysisAttempts === 2)).toBe(true);
    for (const message of duplicates) await scanner.handle(message);
    expect(provider.collect).toHaveBeenCalledTimes(6);
    expect(provider.extract).not.toHaveBeenCalled();
    expect((await repository.listRuns(project.id)).every(run => run.status === 'completed')).toBe(true);
    expect(port.complete).toHaveBeenCalledTimes(6);
  });
});
