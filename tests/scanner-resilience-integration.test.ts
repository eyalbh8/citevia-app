import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { CapturedAnswer, RunSnapshot, ScanMessage } from '@citevia/core';
import {
  MemoryArtifacts, MemoryQueue, PostgresCallLedger, PostgresRepository, SqlProviderAdmissionStore,
  type AnswerProvider, type SqlDatabase,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { guardScanProvider } from '../apps/scanner/src/provider-admission.js';
import { optimizeScanProvider } from '../apps/scanner/src/analysis-costs.js';
import { observeCall } from '../apps/scanner/src/cost-observer.js';
import { ProviderError } from '../apps/scanner/src/provider.js';
import { analysis, captured, instant, project } from '../apps/scanner/test/fixtures.js';

let db: SqlDatabase;
beforeAll(async () => { db = await localPostgres(); }, 30_000);
afterAll(async () => { await db.close(); });

it('two SQL-backed scanner workers share admission, retain captured answers through a429, and charge no deferrals', async () => {
  let clock = Date.parse(instant);
  const now = () => new Date(clock), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  const saved = { ...structuredClone(project), parserVersion: 'igeo-evidence-v2',
    generationModel: 'gpt-4.1-2025-04-14', extractionModel: 'gpt-4.1-mini-2025-04-14',
    scanProviders: [{ provider: 'openai' as const, model: 'gpt-4.1-2025-04-14' }],
  };
  const repository = new PostgresRepository(db);
  await repository.saveProject(saved, null);
  const collect = vi.fn(async (prompt: string) => ({ ...captured(prompt), model: saved.generationModel }));
  const extract = vi.fn(async (answer: CapturedAnswer) => {
    if (extract.mock.calls.length === 1)
      throw new ProviderError('openai_http_429', 'Rate limited.', true, 'rejected-request',
        { kind: 'rate_limit', safeToRetry: true, retryAfterMs: 60_000, httpStatus: 429 });
    return { ...analysis(answer), model: saved.extractionModel };
  });
  const makeWorker = () => {
    const ledger = new PostgresCallLedger(db);
    const context = (snapshot: RunSnapshot) => ({ projectId: snapshot.projectId, ...snapshot.execution });
    const observed: AnswerProvider = {
      collect: (prompt, snapshot) => observeCall({ ledger, context: context(snapshot), provider: 'openai',
        model: saved.generationModel, stage: 'collection', inputBytes: prompt.length, maxOutputTokens: 8000, now },
      () => collect(prompt), answer => ({ model: answer.model, usage: answer.usage })),
      extract: (answer, snapshot) => observeCall({ ledger, context: context(snapshot), provider: 'openai',
        model: saved.extractionModel, stage: 'analysis', inputBytes: answer.text.length, maxOutputTokens: 12000, now },
      () => extract(answer), result => ({ model: result.model, usage: result.usage })),
    };
    return new Scanner({ repository: new PostgresRepository(db), artifacts, queue, now,
      provider: optimizeScanProvider(guardScanProvider(observed, new SqlProviderAdmissionStore(db, { now })), { artifacts, now }),
    });
  };
  const first = makeWorker(), second = makeWorker();
  await first.handle({ kind: 'kickoff', projectId: project.id, scheduledAt: instant, trigger: 'manual', requestId: 'integration-manual' });
  const jobs = queue.messages.filter((message): message is Extract<ScanMessage, { kind: 'prompt' }> => message.kind === 'prompt');
  expect(jobs).toHaveLength(2);
  const result = (index: number) => repository.getResult(project.id, jobs[index].runId, jobs[index].promptId);
  const reservationCount = async () => (await db.query("SELECT count(*)::int AS count FROM citevia_cost_events WHERE phase='reservation'")).rows[0].count;

  await first.handle(jobs[0]); // Capture succeeds; immediate analysis waits for shared OpenAI spacing.
  await second.handle(jobs[1]); // Another worker cannot start another capture in that same slot.
  expect(await result(0)).toMatchObject({ status: 'captured', collectionAttempts: 1, analysisAttempts: 0 });
  expect(await result(1)).toMatchObject({ status: 'queued', collectionAttempts: 0, analysisAttempts: 0 });
  expect(await reservationCount()).toBe(1);
  const captureKey = (await result(0))!.captureKey!;
  const savedCapture = await artifacts.get(captureKey);

  clock += 10_000;
  await second.handle(jobs[0]); // A different worker gets the definite429 and opens a shared cooldown.
  await first.handle(jobs[1]);
  expect(await result(0)).toMatchObject({ status: 'captured', collectionAttempts: 1, analysisAttempts: 1,
    error: { code: 'openai_http_429', retryable: true } });
  expect(await result(1)).toMatchObject({ status: 'queued', collectionAttempts: 0 });
  expect(await reservationCount()).toBe(2);
  expect(collect).toHaveBeenCalledOnce();
  expect(extract).toHaveBeenCalledOnce();
  await first.handle({ kind: 'reconcile' });
  await first.handle(jobs[0]); // Neither reconciliation nor a duplicate bypasses the cooldown.
  expect(extract).toHaveBeenCalledOnce();
  expect(queue.delays).toContain(60);

  clock += 60_000;
  await first.handle(jobs[0]);
  expect(await result(0)).toMatchObject({ status: 'succeeded', captureKey, collectionAttempts: 1, analysisAttempts: 2 });
  expect(await artifacts.get(captureKey)).toEqual(savedCapture);
  expect(extract.mock.calls[1][0]).toEqual(extract.mock.calls[0][0]);
  clock += 10_000;
  await second.handle(jobs[1]);
  clock += 10_000;
  await first.handle(jobs[1]);

  expect(await repository.getRun(project.id, jobs[0].runId)).toMatchObject({ status: 'completed', totalCount: 2, terminalCount: 2, succeededCount: 2 });
  expect(collect).toHaveBeenCalledTimes(2);
  expect(extract).toHaveBeenCalledTimes(3);
  expect(await reservationCount()).toBe(5);
  const rejectedCost = (await db.query("SELECT data FROM citevia_cost_events WHERE phase='outcome' AND data->>'errorCode'='openai_http_429'")).rows;
  expect(rejectedCost).toEqual([{ data: expect.objectContaining({ status: 'failed', estimatedUsd: 0 }) }]);
  expect((await db.query('SELECT id FROM citevia_provider_leases')).rows).toHaveLength(0);
}, 30_000);
