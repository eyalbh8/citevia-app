import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  evaluateBlog, type BlogObservation, type BlogPerformancePage, type TrackedUrl,
  type PromptResult, type ScanRun, type CapturedAnswer, type AgentPost,
} from '@citevia/core';
import { MemoryRepository, MemoryArtifacts, MemoryQueue, PostgresRepository } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { createApi } from '../apps/api/src/app.js';
import { agentGenerationRequest } from '../apps/scanner/src/agent-generation.js';
import { blogResearchRequest } from '../apps/scanner/src/agent-research.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const now = new Date('2026-11-02T12:00:00.000Z');
const project = newProject({ id: 'blog-review', prompts: ['How do I choose reporting metrics?', 'How do dashboards help?'], now: new Date('2026-09-01T00:00:00Z') });
const prompt = project.prompts[0];
const url = (): TrackedUrl => ({
  id: randomUUID(), projectId: project.id, url: 'https://northstar.example/blog/metrics', normalizedUrl: 'northstar.example/blog/metrics', title: 'Choose useful reporting metrics',
  contentType: 'BLOG', promptId: prompt.id, active: true, version: 1,
  createdAt: '2026-09-01T00:00:00.000Z', publishedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
});
function observations(count = 6, cited = false, start = 25): BlogObservation[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `openai:answer-${start}-${i}`, promptId: prompt.id, promptText: prompt.text, provider: 'openai',
    at: new Date(now.getTime() - (start - i) * 86400000).toISOString(), cited,
  }));
}
const review = (items: BlogObservation[], tracked = url()) => evaluateBlog(tracked, prompt, items, ['openai'], now);

describe('blog review decisions', () => {
  it('treats actual citation pickup as success even with a small sample', () => {
    expect(review(observations(1, true))).toMatchObject({ outcome: 'successful', action: 'keep', current: { answers: 1, citedAnswers: 1, citationRate: 100 } });
  });
  it('requires enough recent independent observations before judging uncited content', () => {
    const repeated = observations(1);
    expect(review([...repeated, ...repeated, ...repeated])).toMatchObject({ outcome: 'awaiting_data', current: { answers: 1 } });
    const sameDay = observations(6).map((item) => ({ ...item, at: '2026-10-30T10:00:00.000Z' }));
    expect(review(sameDay).action).toBe('wait');
    expect(review(observations(6), { ...url(), createdAt: '2026-10-25T00:00:00.000Z' }).outcome).toBe('awaiting_data');
    expect(review([]).outcome).toBe('awaiting_data');
  });
  it('recommends an adjustment before replacing a long-unpicked article', () => {
    expect(review(observations(3))).toMatchObject({ outcome: 'unsuccessful', action: 'adjust' });
    expect(review(observations(6))).toMatchObject({ outcome: 'unsuccessful', action: 'create' });
    expect(review([...observations(6), ...observations(1, true, 50)]).action).toBe('adjust');
  });
  it('detects a citation-rate decline even when a recent answer still cites the article', () => {
    const recent = observations(6).map((item, i) => ({ ...item, cited: i === 0 }));
    const value = review([...observations(6, true, 50), ...recent]);
    expect(value).toMatchObject({ outcome: 'declining', action: 'adjust', current: { citationRate: 16.7 }, previous: { citationRate: 100 } });
  });
  it('does not count unrelated prompts, older wording, future or pre-enrollment evidence', () => {
    const old = observations(6, true).map((item) => ({ ...item, promptText: 'An obsolete question?' }));
    const unrelated = observations(6, true).map((item) => ({ ...item, key: item.key + 'other', promptId: 'other' }));
    const future = observations(1, true, -1);
    expect(review([...old, ...unrelated, ...future])).toMatchObject({ outcome: 'awaiting_data', promptChanged: true, current: { answers: 0 } });
    const resumed = { ...url(), trackingPeriods: [{ start: '2026-09-01T00:00:00.000Z', end: '2026-10-10T00:00:00.000Z' }, { start: '2026-11-01T00:00:00.000Z', end: null }] };
    expect(review(observations(6, true), resumed)).toMatchObject({ outcome: 'awaiting_data', current: { answers: 0 } });
  });
  it('requires an explicit editorial prompt and active tracking', () => {
    expect(evaluateBlog(url(), undefined, observations(), ['openai'], now).outcome).toBe('unlinked');
    expect(review(observations(6, true), { ...url(), active: false }).outcome).toBe('paused');
    expect(evaluateBlog(url(), { ...prompt, active: false }, observations(6, true), ['openai'], now).action).toBe('wait');
  });
});

describe.each(['memory', 'postgres'] as const)('blog review integration (%s)', (backend) => {
  async function fixture() {
    const db = backend === 'postgres' ? await localPostgres() : undefined;
    const repository = db ? new PostgresRepository(db) : new MemoryRepository();
    const artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
    await repository.saveProject(structuredClone(project), null);
    for (const name of ['admin', 'owner', 'viewer', 'outsider']) await repository.syncUser(testIdentity(name));
    await repository.bootstrapAdmin((await repository.getUser('admin'))!.id);
    for (const role of ['owner', 'viewer'] as const) await repository.putMembership({ projectId: project.id, userId: role, role });
    const tracked = await repository.registerTrackedUrl(url());
    const api = createApi({ repository, artifacts, queue }, { mode: 'live', now: () => now, providerAvailability: { openai: true, gemini: false, perplexity: false }, agentImagesConfigured: true });
    const call = (tail: string, method = 'GET', body?: unknown, who = 'admin', key = 'blog-refresh-request') => api(new Request(`http://test/v1/projects/${project.id}/${tail}`, {
      method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), testIdentity(who));
    async function capture(item: BlogObservation, options: { failed?: boolean; excluded?: boolean; key?: string } = {}) {
      const runId = randomUUID();
      const run: ScanRun = {
        projectId: project.id, id: runId, scheduledAt: item.at, createdAt: item.at, status: options.failed ? 'failed' : 'completed', trigger: 'manual',
        snapshot: { projectName: project.name, brand: project.brand, competitors: [], prompts: [prompt], country: project.country, language: project.language, timezone: 'UTC', provider: item.provider, generationModel: 'test', extractionModel: 'test', parserVersion: project.parserVersion, configVersion: 1 },
        totalCount: 1, terminalCount: 1, succeededCount: 1, capturedCount: 1, resultVersion: 1, deadlineAt: item.at, expiresAt: 2000000000,
        ...(options.excluded ? { reportingExcludedAt: now.toISOString() } : {}),
      };
      const result: PromptResult = {
        projectId: project.id, runId, promptId: item.promptId, prompt: { ...prompt, id: item.promptId, text: item.promptText }, responseId: `${runId}~${item.promptId}`, status: 'succeeded',
        captureKey: options.key || item.key.slice('openai:'.length), version: 1, attempts: 1, capturedAt: item.at, citationCount: item.cited ? 1 : 0, sourceCount: 0, expiresAt: 2000000000,
      };
      const answer: CapturedAnswer = {
        providerResponseId: runId, model: 'test', status: 'completed', text: 'An answer', blocks: [],
        citations: item.cited ? [{ id: 'c1', url: tracked.url, title: tracked.title, blockId: 'b1', start: 0, end: 1 }] : [], sources: [],
        createdAt: item.at, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: {},
      };
      await repository.createRun(run, [result]);
      await repository.saveMeasurement(result, run, answer, null);
      return { run, result };
    }
    return { db, repository, artifacts, queue, tracked, call, capture };
  }
  it('enforces system-admin access and saves versioned account-local prompt associations', async () => {
    const f = await fixture();
    try {
      for (const who of ['owner', 'viewer']) {
        expect((await f.call('blog-performance', 'GET', undefined, who)).status).toBe(403);
        expect((await f.call(`blog-performance/${f.tracked.id}`, 'PATCH', { version: 1, promptId: prompt.id }, who)).status).toBe(403);
        expect((await f.call('agents/posts', 'POST', { channel: 'blog', promptId: prompt.id, blogRefresh: { trackedUrlId: f.tracked.id, action: 'adjust', originalBody: 'Current article' } }, who)).status).toBe(403);
      }
      expect((await f.call('blog-performance', 'GET', undefined, 'outsider')).status).toBe(404);
      expect((await f.call(`blog-performance/${f.tracked.id}`, 'PATCH', { version: 1, promptId: 'foreign' })).status).toBe(400);
      expect((await f.call(`blog-performance/${f.tracked.id}`, 'PATCH', { version: 1, promptId: project.prompts[1].id })).status).toBe(200);
      expect((await f.repository.listTrackedUrls(project.id))[0]).toMatchObject({ version: 2, promptId: project.prompts[1].id });
      expect((await f.call(`blog-performance/${f.tracked.id}`, 'PATCH', { version: 1, promptId: prompt.id })).status).toBe(409);
      const rows = await (await f.call('blog-performance')).json() as BlogPerformancePage;
      expect(rows.items[0].prompt?.id).toBe(project.prompts[1].id);
      expect((await f.call(`blog-performance/${randomUUID()}`, 'PATCH', { version: 1, promptId: prompt.id })).status).toBe(404);
    } finally { await f.db?.close(); }
  }, 30000);
  it('uses independent successful scans and native citations for the same prompt', async () => {
    const f = await fixture();
    try {
      const items = observations(3);
      for (const item of items) await f.capture(item);
      await f.capture(items[0]); // Reanalysis/repeated capture cannot create another answer.
      await f.capture({ ...items[0], key: 'openai:failed', cited: true }, { failed: true });
      await f.capture({ ...items[0], key: 'openai:excluded', cited: true }, { excluded: true });
      await f.capture({ ...items[0], key: 'openai:unrelated', promptId: project.prompts[1].id, cited: true });
      let data = await (await f.call('blog-performance')).json() as BlogPerformancePage;
      expect(data.items[0]).toMatchObject({ outcome: 'unsuccessful', action: 'adjust', current: { answers: 3, citedAnswers: 0 } });
      await f.capture({ ...observations(1, true, 1)[0], key: 'openai:success' });
      data = await (await f.call('blog-performance')).json() as BlogPerformancePage;
      expect(data.items[0]).toMatchObject({ outcome: 'successful', current: { answers: 4, citedAnswers: 1, citationRate: 25 } });
    } finally { await f.db?.close(); }
  }, 30000);
  it('freezes the change brief with the same prompt and current brand context in an idempotent draft', async () => {
    const f = await fixture();
    try {
      for (const item of observations(3)) await f.capture(item);
      const input = { channel: 'blog', promptId: prompt.id, blogRefresh: { trackedUrlId: f.tracked.id, action: 'adjust', originalBody: 'Private current article with useful original sections.' } };
      expect((await f.call('agents/posts', 'POST', { ...input, blogRefresh: { ...input.blogRefresh, originalBody: undefined } })).status).toBe(400);
      expect((await f.call('agents/posts', 'POST', { ...input, promptId: project.prompts[1].id })).status).toBe(400);
      expect((await f.call('agents/posts', 'POST', { ...input, blogRefresh: { ...input.blogRefresh, trackedUrlId: randomUUID() } })).status).toBe(404);
      expect((await f.call('agents/posts', 'POST', { ...input, blogRefresh: { ...input.blogRefresh, action: 'create' } })).status).toBe(409);
      const response = await f.call('agents/posts', 'POST', input);
      expect(response.status).toBe(202);
      const data = await response.json() as { post: AgentPost };
      expect(data.post).toMatchObject({ promptId: prompt.id, prompt: prompt.text, blogRefresh: { trackedUrlId: f.tracked.id, action: 'adjust', url: f.tracked.url } });
      expect(JSON.stringify(data)).not.toContain(input.blogRefresh.originalBody);
      expect(JSON.stringify(data)).not.toContain('context');
      const saved = (await f.repository.getAgentPost(project.id, data.post.id))!;
      expect(saved.context.blogRefresh).toMatchObject({ originalBody: input.blogRefresh.originalBody, changes: expect.arrayContaining([expect.stringContaining('fresh primary-source research')]) });
      const generated = agentGenerationRequest(saved);
      expect(generated.input).toMatchObject({ prompt: prompt.text, blogRefresh: { originalBody: input.blogRefresh.originalBody } });
      expect(generated.instructions).toContain('performance-informed blog refresh');
      expect(agentGenerationRequest({ ...saved, stage: 'repair' }).input).toMatchObject({ blogRefresh: { originalBody: input.blogRefresh.originalBody } });
      expect(JSON.parse(blogResearchRequest(saved, now).prompt)).toMatchObject({ question: prompt.text, refresh: { action: 'adjust', changesToResearch: saved.context.blogRefresh!.changes } });
      const repeated = await (await f.call('agents/posts', 'POST', input)).json();
      expect(repeated.post.id).toBe(data.post.id);
      expect((await f.repository.listAgentPosts(project.id, 0, 10)).total).toBe(1);
      expect((await f.call('agents/posts', 'POST', { ...input, blogRefresh: { ...input.blogRefresh, originalBody: 'A different article' } })).status).toBe(409);
    } finally { await f.db?.close(); }
  }, 30000);
});
