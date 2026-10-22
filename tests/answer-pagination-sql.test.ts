import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PromptResult, ScanRun, ScanProvider } from '@citevia/core';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { MemoryArtifacts, MemoryQueue, PostgresRepository, type SqlDatabase, type PromptAnswerPageOptions } from '@citevia/storage';
import { promptAnswers } from '../apps/api/src/prompt-answers.js';
import { createApi } from '../apps/api/src/app.js';
import { testIdentity } from './fixtures/users.js';
import { project as fixture, snapshot } from '../apps/scanner/test/fixtures.js';

let db: SqlDatabase;
let repository: PostgresRepository;
const project = { ...structuredClone(fixture), id: 'sql-answer-pages' };
const start = '2026-10-01T00:00:00.000Z';
const end = '2026-10-31T23:59:59.999Z';
const promptId = project.prompts[0].id;
const runId = (index: number) => `run_${index.toString(16).padStart(24, '0')}`;

async function observation(index: number, options: { date?: string; createdAt?: string; provider?: ScanProvider;
  capture?: string; status?: PromptResult['status']; rank?: number | null; sentiment?: 'positive' | 'neutral' | 'mixed' | 'negative' | 'unknown';
  promptIndex?: number; arbitraryId?: string } = {}) {
  const id = options.arbitraryId || runId(index);
  const at = options.date || `2026-10-${String(index).padStart(2, '0')}T12:00:00.000Z`;
  const status = options.status || 'succeeded';
  const prompt = project.prompts[options.promptIndex || 0];
  const run: ScanRun = { id, projectId: project.id, scheduledAt: at, createdAt: options.createdAt || at,
    status: status === 'succeeded' ? 'completed' : 'partial', trigger: 'manual',
    snapshot: { ...snapshot, provider: options.provider || 'openai', prompts: project.prompts },
    totalCount: 1, terminalCount: 1, succeededCount: Number(status === 'succeeded'), capturedCount: Number(status !== 'failed_collection'),
    resultVersion: 1, deadlineAt: end, expiresAt: 2000000000 };
  const result: PromptResult = { projectId: project.id, runId: id, promptId: prompt.id,
    responseId: `${id}~${prompt.id}`, prompt, status, version: 1, attempts: 1,
    ...(status !== 'failed_collection' ? { captureKey: options.capture || `capture-${index}`, capturedAt: at } : {}),
    citationCount: index % 3, sourceCount: 0, expiresAt: 2000000000,
    ...(status === 'succeeded' ? { target: { brandId: project.brand.id, mentioned: true,
      appearanceRank: options.rank ?? undefined, explicitRank: options.rank === undefined ? 2 : null,
      mentionOrder: 1, sentiment: options.sentiment || 'neutral', evidence: [], rankEvidence: null, sentimentEvidence: null } } : {}) };
  await repository.createRun(run, [result]);
  return { run, result };
}

beforeAll(async () => {
  db = await localPostgres();
  repository = new PostgresRepository(db);
  await repository.saveProject(project, null);
  await repository.syncUser(testIdentity('sql-pages-owner'));
  await repository.putMembership({ projectId: project.id, userId: 'sql-pages-owner', role: 'owner' });
  await observation(1, { capture: 'shared-original', rank: 4, sentiment: 'positive' });
  await observation(10, { date: '2026-10-01T12:00:00.000Z', createdAt: '2026-10-20T12:00:00.000Z',
    capture: 'shared-original', rank: -2, sentiment: 'negative' });
  await observation(11, { date: '2026-10-01T12:00:00.000Z', createdAt: '2026-10-21T12:00:00.000Z',
    capture: 'shared-original', status: 'failed_extraction' });
  await observation(2, { provider: 'gemini', rank: null, sentiment: 'neutral' });
  await observation(3, { rank: 3, sentiment: 'mixed' });
  await observation(4, { rank: null, sentiment: 'unknown' });
  await observation(5, { status: 'failed_collection' });
  await observation(6, { date: '2026-10-03T12:00:00.000Z', provider: 'gemini', rank: 3, sentiment: 'positive' });
  await observation(7, { date: '2026-10-01T12:00:00.000Z', provider: 'gemini', capture: 'shared-original', rank: 1 });
  await observation(8, { promptIndex: 1 });
}, 30000);
afterAll(async () => { await db?.close(); });

describe('PostgreSQL answer pagination', () => {
  it('matches historical dedupe and numeric/date ordering across every page and provider', async () => {
    for (const provider of [undefined, 'openai', 'gemini'] as const) {
      const history = await repository.listPromptHistory(project.id, start, end, promptId);
      for (const sort of ['date', 'rank', 'citations', 'sentiment'] as const) {
        for (const direction of ['asc', 'desc'] as const) {
          const expected = promptAnswers(history, project.id, promptId, provider, sort, direction);
          const seen: string[] = [];
          for (let offset = 0; offset <= expected.length; offset += 2) {
            const page = await repository.listPromptAnswerPage(project.id, { start, end, promptId, provider, sort, direction, offset, limit: 2 });
            expect(page).not.toBeNull();
            expect(page!.total).toBe(expected.length);
            expect(page!.items).toEqual(expected.slice(offset, offset + 2));
            seen.push(...page!.items.map(item => item.result.responseId));
          }
          expect(seen).toEqual(expected.map(item => item.result.responseId));
          expect(new Set(seen).size).toBe(seen.length);
        }
      }
    }
  });

  it('uses original capture dates for reanalysis and preserves project/prompt boundaries', async () => {
    const options: PromptAnswerPageOptions = { start, end: '2026-10-01T23:59:59.999Z', promptId,
      sort: 'date', direction: 'desc', offset: 0, limit: 10 };
    const page = (await repository.listPromptAnswerPage(project.id, options))!;
    expect(page.total).toBe(2);
    expect(page.items.map(item => item.result.responseId)).toContain(`${runId(10)}~${promptId}`);
    expect(page.items.every(item => item.result.capturedAt === '2026-10-01T12:00:00.000Z')).toBe(true);
    expect(await repository.listPromptAnswerPage('another-project', options)).toEqual({ total: 0, items: [] });
    expect((await repository.listPromptAnswerPage(project.id, { ...options, promptId: project.prompts[1].id }))!.total).toBe(0);
    await expect(repository.listPromptAnswerPage(project.id, { ...options, limit: 1000 })).rejects.toThrow('bounds');
  });

  it('serves the API from bounded SQL pages without requesting complete period history', async () => {
    const history = vi.spyOn(repository, 'listPromptHistory').mockRejectedValue(new Error('Full history must not be read'));
    try {
      const api = createApi({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() },
        { mode: 'live', now: () => new Date(end) });
      const call = async (query: string) => {
        const response = await api(new Request(`http://test/v1/projects/${project.id}/prompts/${promptId}/responses?${query}`), testIdentity('sql-pages-owner'));
        expect(response.status).toBe(200);
        return response.json();
      };
      const first = await call('sort=sentiment&direction=asc&limit=2');
      expect(first.items).toHaveLength(2);
      expect(first.items[0].sentimentScore).toBe(0);
      const second = await call(`sort=sentiment&direction=asc&limit=2&cursor=${first.nextCursor}`);
      expect(second.total).toBe(first.total);
      expect(first.items.map((item: any) => item.responseId).some((id: string) => second.items.some((item: any) => item.responseId === id))).toBe(false);
      expect(history).not.toHaveBeenCalled();
    } finally { history.mockRestore(); }
  });

  it('retains exact legacy ordering for model collation, arbitrary IDs and indistinguishable reanalysis ties', async () => {
    const options: PromptAnswerPageOptions = { start, end, promptId, sort: 'model', direction: 'asc', offset: 0, limit: 2 };
    expect(await repository.listPromptAnswerPage(project.id, options)).toBeNull();
    await observation(12, { arbitraryId: 'legacy_short_id' });
    expect(await repository.listPromptAnswerPage(project.id, { ...options, sort: 'date' })).toBeNull();
    await observation(13, { date: '2026-10-01T12:00:00.000Z', createdAt: '2026-10-20T12:00:00.000Z', capture: 'shared-original' });
    expect(await repository.listPromptAnswerPage(project.id, { ...options, sort: 'rank', end: '2026-10-01T23:59:59.999Z' })).toBeNull();
  });
});
