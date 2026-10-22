import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedAnswer, Project, PromptResult, ScanMessage, ScanProvider, ScanRun } from '@citevia/core';
import {
  MemoryArtifacts, MemoryRepository, MemoryScanDispatchStore, PostgresRepository, SqlScanDispatchStore,
  type AnalysisBatchPort, type AnswerProvider, type JobQueue, type Repository, type ScanDispatchStore,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { Scanner, LEASE_MS, MAX_ATTEMPTS } from '../apps/scanner/src/engine.js';
import { ProviderError } from '../apps/scanner/src/provider.js';
import { analysis, captured, instant, project } from '../apps/scanner/test/fixtures.js';

type PromptMessage = Extract<ScanMessage, { kind: 'prompt' }>;
const providers: ScanProvider[] = ['openai', 'gemini', 'perplexity'];
afterEach(() => vi.unstubAllEnvs());

/** Model SQS timers explicitly so early deliveries cannot accidentally make retry tests pass. */
class ClockQueue implements JobQueue {
  readonly messages: { message: ScanMessage; dueAt: number }[] = [];
  readonly sent: ScanMessage[] = [];
  maxQueuedPrompts = 0;
  failNextSend = false;
  constructor(private readonly now: () => number) {}
  async send(messages: ScanMessage[], delaySeconds = 0) {
    this.sent.push(...structuredClone(messages));
    if (this.failNextSend) { this.failNextSend = false; throw Error('Lost SQS send acknowledgment'); }
    this.messages.push(...messages.map(message => ({ message: structuredClone(message), dueAt: this.now() + delaySeconds * 1000 })));
    this.maxQueuedPrompts = Math.max(this.maxQueuedPrompts, this.messages.filter(item => item.message.kind === 'prompt').length);
  }
  take(): ScanMessage | undefined {
    const index = this.messages.findIndex(item => item.dueAt <= this.now());
    return index === -1 ? undefined : this.messages.splice(index, 1)[0].message;
  }
}
class CancellableRepository extends MemoryRepository {
  cancel(projectId: string) {
    return this.operation(() => {
      for (const run of Object.values(this.state.runs)) if (run.projectId === projectId) run.cancelledAt = instant;
    }, true);
  }
}
async function environment(options: {
  accounts?: number; prompts?: number; providers?: ScanProvider[]; provider?: AnswerProvider;
  batch?: boolean; repository?: Repository; dispatch?: (clock: () => Date) => ScanDispatchStore;
} = {}) {
  let time = Date.parse(instant);
  const clock = () => new Date(time), repository = options.repository ?? new CancellableRepository();
  const artifacts = new MemoryArtifacts(), queue = new ClockQueue(() => time);
  const dispatch = options.dispatch?.(clock) ?? new MemoryScanDispatchStore({ now: clock });
  const calls = new Map<string, number>();
  const provider = options.provider ?? {
    collect: vi.fn(async (_prompt: string, snapshot: Parameters<AnswerProvider['collect']>[1]) => {
      const key = `${snapshot.projectId}:${snapshot.execution!.runId}:${snapshot.execution!.promptId}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return { ...captured(), provider: snapshot.provider, providerResponseId: key };
    }),
    extract: vi.fn(async (answer: CapturedAnswer) => analysis(answer)),
  };
  const batch: AnalysisBatchPort = {
    process: vi.fn(async (run: ScanRun, results: PromptResult[]) => ({
      batchId: `batch-${run.id}`,
      updates: await Promise.all(results.filter(result => result.status === 'analysis_pending').map(async result => {
        const answer = await artifacts.get<CapturedAnswer>(result.captureKey!);
        if (!answer) throw Error('Missing persisted capture');
        const extracted = analysis(answer), key = `batch-analysis/${run.id}/${result.promptId}`;
        await artifacts.put(key, extracted);
        return { promptId: result.promptId, captureKey: result.captureKey!, analysisKey: key,
          analysisAttempt: result.analysisAttempts, analysis: extracted };
      })),
    })),
    complete: vi.fn(async () => {}),
  };
  if (options.batch) vi.stubEnv('ANALYSIS_BATCH_ENABLED', 'true');
  const scanner = new Scanner({ repository, artifacts, queue, dispatch, provider,
    analysisBatch: options.batch ? batch : undefined, now: clock });
  const accounts: Project[] = [];
  for (let account = 0; account < (options.accounts ?? 1); account++) {
    const saved = { ...structuredClone(project), id: `fleet-${account}`, parserVersion: 'igeo-evidence-v2',
      prompts: Array.from({ length: options.prompts ?? 1 }, (_, index) => ({ ...project.prompts[0], id: `prompt-${index}` })),
      scanProviders: (options.providers ?? providers).map(provider => ({ provider, model: 'fixture-model' })),
    };
    await repository.saveProject(saved, null); accounts.push(saved);
  }
  const kickoff = (account: Project, offset = 0): Extract<ScanMessage, { kind: 'kickoff' }> => ({
    kind: 'kickoff', projectId: account.id, scheduledAt: new Date(time + offset).toISOString(), trigger: 'scheduled',
  });
  async function drain(duplicate = false) {
    let count = 0;
    for (let message = queue.take(); message; message = queue.take()) {
      if (++count > 1000) throw Error('Unbounded dispatch loop');
      if (duplicate && message.kind === 'prompt') await Promise.all([scanner.handle(message), scanner.handle(message)]);
      else await scanner.handle(message);
    }
  }
  return { scanner, repository, artifacts, queue, provider, batch, dispatch, calls, accounts, kickoff, drain,
    now: () => time, advance: (ms: number) => { time += ms; } };
}

describe('fleet scanner dispatch integration', () => {
  it('completes three accounts across all providers and batch analysis with bounded work and duplicate deliveries', async () => {
    const env = await environment({ accounts: 3, prompts: 5, batch: true });
    await Promise.all(env.accounts.map(account => env.scanner.handle(env.kickoff(account))));
    expect(env.queue.messages.filter(item => item.message.kind === 'prompt')).toHaveLength(9);
    await env.drain(true);
    await env.scanner.handle({ kind: 'reconcile' });
    await env.drain(true);
    expect(env.calls.size).toBe(45);
    expect([...env.calls.values()].every(count => count === 1)).toBe(true);
    expect(env.provider.extract).not.toHaveBeenCalled();
    expect(env.batch.complete).toHaveBeenCalledTimes(9);
    expect(env.queue.maxQueuedPrompts).toBeLessThanOrEqual(12);
    for (const account of env.accounts) {
      const runs = await env.repository.listRuns(account.id);
      expect(runs).toHaveLength(3);
      expect(new Set(runs.map(run => run.snapshot.provider))).toEqual(new Set(providers));
      for (const run of runs) {
        expect(run).toMatchObject({ status: 'completed', totalCount: 5, capturedCount: 5, succeededCount: 5 });
        const results = await env.repository.listResults(account.id, run.id);
        expect(results.every(result => result.collectionAttempts === 1 && result.analysisAttempts === 1 && result.captureKey && result.analysisKey)).toBe(true);
        for (const result of results) expect(await env.artifacts.get(result.captureKey!)).toBeTruthy();
      }
    }
    expect(await env.dispatch.claim({ globalLimit: 12, accountLimit: 3, providerLimit: 4, leaseMs: LEASE_MS })).toEqual([]);
  });

  it('recovers a lost SQS send after the lease and rejects its stale token without a duplicate paid call', async () => {
    const env = await environment({ providers: ['openai'] });
    env.queue.failNextSend = true;
    await expect(env.scanner.handle(env.kickoff(env.accounts[0]))).rejects.toThrow('Lost SQS send acknowledgment');
    const stale = env.queue.sent.find((message): message is PromptMessage => message.kind === 'prompt')!;
    expect(stale.dispatchToken).toBeTruthy();
    env.advance(LEASE_MS - 1);
    await env.scanner.handle({ kind: 'dispatch' });
    expect(env.queue.messages).toHaveLength(0);
    env.advance(1);
    await env.scanner.handle({ kind: 'dispatch' });
    const fresh = env.queue.messages[0].message as PromptMessage;
    expect(fresh.dispatchToken).not.toBe(stale.dispatchToken);
    await env.scanner.handle(stale);
    expect(env.provider.collect).not.toHaveBeenCalled();
    await env.drain(true);
    await env.scanner.handle(stale);
    expect(env.provider.collect).toHaveBeenCalledOnce();
    expect(env.provider.extract).toHaveBeenCalledOnce();
    expect((await env.repository.listRuns(env.accounts[0].id))[0].status).toBe('completed');
  });

  for (const failures of [3, 4]) it(`keeps saved captures and Retry-After delays with ${failures} analysis rejections and at most three paid retries`, async () => {
    let requests = 0;
    const provider = {
      collect: vi.fn(async () => captured()),
      extract: vi.fn(async (answer: CapturedAnswer) => {
        requests++;
        if (requests === 1) throw new ProviderError('provider_wait', 'Provider admission delayed.', true, null,
          { kind: 'deferred', safeToRetry: true, retryAfterMs: 120_000 });
        if (requests <= failures + 1) throw new ProviderError('openai_http_429', 'Rate limited.', true, null,
          { kind: 'rate_limit', safeToRetry: true, retryAfterMs: 120_000 });
        return analysis(answer);
      }),
    };
    const env = await environment({ providers: ['openai'], provider });
    await env.scanner.handle(env.kickoff(env.accounts[0]));
    const original = env.queue.messages[0].message as PromptMessage;
    await env.drain(true);
    const getResult = () => env.repository.getResult(original.projectId, original.runId, original.promptId);
    expect(await getResult()).toMatchObject({ collectionAttempts: 1, analysisAttempts: 0, status: 'captured' });
    for (let call = 1; call <= MAX_ATTEMPTS; call++) {
      const waiting = (await getResult())!;
      const wait = Date.parse(waiting.retryNotBefore!) - env.now();
      expect(wait).toBeGreaterThanOrEqual(120_000);
      env.advance(wait - 1);
      await env.scanner.handle({ kind: 'dispatch' });
      await env.scanner.handle(original);
      await env.drain();
      expect(provider.extract).toHaveBeenCalledTimes(call);
      env.advance(1);
      await env.scanner.handle({ kind: 'dispatch' });
      await env.drain(true);
      expect((await getResult())!.analysisAttempts).toBe(call);
    }
    expect(await getResult()).toMatchObject({ status: failures === 3 ? 'succeeded' : 'failed_extraction', collectionAttempts: 1, analysisAttempts: 4 });
    env.advance(60 * 60_000);
    await env.scanner.handle({ kind: 'reconcile' });
    await env.drain(true);
    expect(provider.collect).toHaveBeenCalledOnce();
    expect(provider.extract).toHaveBeenCalledTimes(5); // Admission wait plus initial paid call and three retries.
  });

  it('discards cancelled accounts without collecting queued work and lets another account continue', async () => {
    const repository = new CancellableRepository(), env = await environment({ accounts: 2, prompts: 3, repository });
    await Promise.all(env.accounts.map(account => env.scanner.handle(env.kickoff(account))));
    const cancelledJobs = env.queue.sent.filter((message): message is PromptMessage => message.kind === 'prompt' && message.projectId === env.accounts[0].id);
    await repository.cancel(env.accounts[0].id);
    await env.scanner.handle({ kind: 'reconcile' });
    await env.drain(true);
    for (const message of cancelledJobs) await env.scanner.handle(message);
    expect([...env.calls.keys()].some(key => key.startsWith(`${env.accounts[0].id}:`))).toBe(false);
    expect(env.calls.size).toBe(9);
    expect((await repository.listRuns(env.accounts[1].id)).every(run => run.status === 'completed')).toBe(true);
    expect(await env.dispatch.claim({ globalLimit: 12, accountLimit: 3, providerLimit: 4, leaseMs: LEASE_MS })).toEqual([]);
  });

  it('isolates a broken batch poll in its own recovery job so another account still completes', async () => {
    const env = await environment({ accounts: 2, providers: ['openai'], batch: true });
    const process = vi.mocked(env.batch.process), successfulPoll = process.getMockImplementation()!;
    process.mockResolvedValue({ updates: [] });
    await Promise.all(env.accounts.map(account => env.scanner.handle(env.kickoff(account))));
    await env.drain(true);
    expect(await env.repository.listActiveRuns()).toHaveLength(2);
    process.mockImplementation(async (run, results) => {
      if (run.projectId === env.accounts[0].id) throw Error('One batch provider lookup failed');
      return successfulPoll(run, results);
    });
    await env.scanner.handle({ kind: 'reconcile' });
    expect(env.queue.messages.map(item => item.message.kind)).toEqual(['reconcile-run', 'reconcile-run']);
    const failed: ScanMessage[] = [];
    for (let message = env.queue.take(); message; message = env.queue.take()) {
      try { await env.scanner.handle(message); }
      catch { failed.push(message); }
    }
    expect(failed).toHaveLength(1);
    expect((await env.repository.listRuns(env.accounts[1].id))[0].status).toBe('completed');
    expect((await env.repository.listRuns(env.accounts[0].id))[0].status).toBe('running');
    process.mockImplementation(successfulPoll);
    await env.scanner.handle(failed[0]);
    expect((await env.repository.listRuns(env.accounts[0].id))[0].status).toBe('completed');
    expect(env.provider.collect).toHaveBeenCalledTimes(2);
    expect(env.provider.extract).not.toHaveBeenCalled();
  });

  it('atomically allows only one scheduled group per account across competing PostgreSQL kickoffs', async () => {
    const db = await localPostgres();
    try {
      const repository = new PostgresRepository(db), env = await environment({ repository,
        dispatch: clock => new SqlScanDispatchStore(db, { now: clock }) });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await Promise.all(Array.from({ length: 8 }, (_, index) => env.scanner.handle(env.kickoff(env.accounts[0], -index * 60_000))));
      } finally { warning.mockRestore(); }
      const runs = await repository.listRuns(env.accounts[0].id);
      expect(runs).toHaveLength(3);
      expect(new Set(runs.map(run => run.groupId)).size).toBe(1);
      expect(env.queue.messages.filter(item => item.message.kind === 'prompt')).toHaveLength(3);
      await env.drain(true);
      expect(env.provider.collect).toHaveBeenCalledTimes(3);
      expect((await repository.listRuns(env.accounts[0].id)).every(run => run.status === 'completed')).toBe(true);
    } finally { await db.close(); }
  }, 30_000);
});
