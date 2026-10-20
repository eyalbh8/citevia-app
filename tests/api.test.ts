import { testIdentity } from './fixtures/users.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  Dashboard,
  Page,
  Project,
  PromptResult,
  ResponseDetail,
  SourceRow,
  ScanRun,
} from '@citevia/core';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_PERPLEXITY_PRESET,
  snapshotProvider,
} from '@citevia/core';
import {
  MemoryArtifacts,
  MemoryQueue,
  MemoryRepository,
} from '@citevia/storage';
import { createApi, type ApiOptions } from '../apps/api/src/app.js';
import { runIdFor, Scanner } from '../apps/scanner/src/engine.js';
import {
  FixtureProvider,
  fixturePrompts,
  newProject,
} from './fixtures/scanner.js';

const OWNER = 'owner-user';
const VIEWER = 'viewer-user';
const BASE = '/v1/projects/project-main';
const DATE = new Date('2026-10-19T06:00:00.000Z');
const jsonRequest = (
  method: string,
  data?: unknown,
  headers: Record<string, string> = {},
): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
});
const read = async <T>(response: Response): Promise<T> =>
  response.json() as Promise<T>;

async function fixture(
  prompts = fixturePrompts().slice(0, 3),
  extra: Partial<ApiOptions> = {},
) {
  const repository = new MemoryRepository();
  const artifacts = new MemoryArtifacts();
  const queue = new MemoryQueue();
  const runtime = { repository, artifacts, queue };
  let clock = DATE;
  const project = newProject({ id: 'project-main', prompts, now: clock });
  await repository.saveProject(project, null);
  await repository.syncUser(testIdentity(OWNER));
  await repository.syncUser(testIdentity(VIEWER));
  await repository.putMembership({
    projectId: project.id,
    userId: OWNER,
    role: 'owner',
  });
  await repository.putMembership({
    projectId: project.id,
    userId: VIEWER,
    role: 'viewer',
  });
  const api = createApi(runtime, {
    mode: 'live',
    now: () => clock,
    ...extra,
  });
  const call = (
    path: string,
    init: RequestInit = {},
    user: string | null = OWNER,
  ) =>
    api(
      new Request(`https://citevia.test${path}`, init),
      user ? testIdentity(user) : undefined,
    );
  async function scan(at = clock, projectId = project.id) {
    clock = at;
    const scanner = new Scanner({
      ...runtime,
      provider: new FixtureProvider(() => clock),
      now: () => clock,
    });
    const message = {
      kind: 'kickoff' as const,
      projectId,
      scheduledAt: at.toISOString(),
      trigger: 'manual' as const,
    };
    await scanner.handle(message);
    let deliveries = 0;
    while (queue.messages.length) {
      if (++deliveries > 200) throw new Error('Test queue did not settle');
      await scanner.handle(queue.messages.shift()!);
    }
    return runIdFor(message);
  }
  return { ...runtime, project, call, scan };
}

describe('multi-provider reporting and admission', () => {
  async function configure(f: Awaited<ReturnType<typeof fixture>>) {
    const stored = (await f.repository.getProject(f.project.id))!;
    await f.repository.saveProject(
      {
        ...stored,
        version: stored.version + 1,
        scanProviders: [
          { provider: 'openai', model: stored.generationModel },
          { provider: 'perplexity', model: DEFAULT_PERPLEXITY_PRESET },
          { provider: 'gemini', model: DEFAULT_GEMINI_MODEL },
        ],
      },
      stored.version,
    );
  }
  it('selects each provider independently and compares only that provider’s prior scans', async () => {
    const f = await fixture();
    await configure(f);
    await f.scan(new Date('2026-10-12T06:00:00.000Z'));
    await f.scan(DATE);
    for (const provider of ['openai', 'perplexity', 'gemini']) {
      const dashboard = await read<Dashboard>(
        await f.call(`${BASE}/dashboard?provider=${provider}`),
      );
      expect(snapshotProvider(dashboard.run!.snapshot)).toBe(provider);
      expect(dashboard.trend).toHaveLength(2);
      expect(dashboard.comparison.comparableCount).toBe(3);
      const previous = await f.repository.getRun(
        f.project.id,
        dashboard.comparison.previousRunId!,
      );
      expect(snapshotProvider(previous!.snapshot)).toBe(provider);
      const runs = await read<Page<ScanRun>>(
        await f.call(`${BASE}/runs?provider=${provider}`),
      );
      expect(runs.items).toHaveLength(2);
      expect(
        runs.items.every((run) => snapshotProvider(run.snapshot) === provider),
      ).toBe(true);
      const results = await read<Page<PromptResult>>(
        await f.call(`${BASE}/responses?provider=${provider}`),
      );
      expect(
        results.items.every((result) => result.runId === dashboard.run!.id),
      ).toBe(true);
    }
    const run = (await f.repository.listRuns(f.project.id)).find(
      (run) => snapshotProvider(run.snapshot) === 'gemini',
    )!;
    expect(
      (await f.call(`${BASE}/dashboard?runId=${run.id}&provider=openai`))
        .status,
    ).toBe(400);
    expect((await f.call(`${BASE}/dashboard?provider=unknown`)).status).toBe(
      400,
    );
    expect(
      (await f.call(`${BASE}/dashboard?provider=gemini`, {}, 'unrelated-user'))
        .status,
    ).toBe(404);
  });
  it('returns one deterministic run ID per enabled provider for a manual scan request', async () => {
    const f = await fixture();
    await configure(f);
    const init = jsonRequest('POST', undefined, {
      'Idempotency-Key': 'all-providers-123',
    });
    const first = await read<{
      runId: string;
      runs: { provider: string; runId: string }[];
    }>(await f.call(`${BASE}/runs`, init));
    const second = await read<typeof first>(await f.call(`${BASE}/runs`, init));
    expect(second).toEqual(first);
    expect(first.runs).toHaveLength(3);
    expect(new Set(first.runs.map((item) => item.runId)).size).toBe(3);
    expect(first.runs[0].runId).toBe(first.runId);
  });
  it('rejects unconfigured enabled providers before enqueueing or charging a request', async () => {
    const f = await fixture(undefined, {
      providerAvailability: { openai: true, perplexity: false, gemini: true },
    });
    await configure(f);
    const response = await f.call(
      `${BASE}/runs`,
      jsonRequest('POST', undefined, { 'Idempotency-Key': 'missing-provider' }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'PROVIDER_NOT_CONFIGURED' },
    });
    expect(f.queue.messages).toHaveLength(0);
    // Missing providers do not prevent read access or a legacy OpenAI-only account.
    expect((await f.call(`${BASE}/settings`)).status).toBe(200);
    const stored = (await f.repository.getProject(f.project.id))!;
    await f.repository.saveProject(
      {
        ...stored,
        version: stored.version + 1,
        scanProviders: [{ provider: 'openai', model: stored.generationModel }],
      },
      stored.version,
    );
    expect(
      (
        await f.call(
          `${BASE}/runs`,
          jsonRequest('POST', undefined, { 'Idempotency-Key': 'openai-only' }),
        )
      ).status,
    ).toBe(202);
  });
  it('validates provider settings and preserves owner/viewer access rules', async () => {
    const f = await fixture();
    for (const scanProviders of [
      [],
      [{ provider: 'other', model: 'anything' }],
      [
        { provider: 'gemini', model: 'one' },
        { provider: 'gemini', model: 'two' },
      ],
    ])
      expect(
        (
          await f.call(
            `${BASE}/settings`,
            jsonRequest('PATCH', { version: 1, scanProviders }),
          )
        ).status,
      ).toBe(400);
    const patch = jsonRequest('PATCH', {
      version: 1,
      scanProviders: [{ provider: 'gemini', model: DEFAULT_GEMINI_MODEL }],
    });
    expect((await f.call(`${BASE}/settings`, patch, VIEWER)).status).toBe(403);
    expect((await f.call(`${BASE}/settings`, patch)).status).toBe(200);
    const saved = (await f.repository.getProject(f.project.id))!;
    expect(saved.scanProviders).toEqual([
      { provider: 'gemini', model: DEFAULT_GEMINI_MODEL },
    ]);
  });
});

describe('API authentication and customer isolation', () => {
  it('requires an identity, hides nonmember projects and denies viewer mutations', async () => {
    const f = await fixture();
    expect((await f.call('/v1/projects', {}, null)).status).toBe(401);
    expect(
      (await f.call(`${BASE}/settings`, {}, 'unrelated-user')).status,
    ).toBe(404);
    expect((await f.call(`${BASE}/settings`, {}, VIEWER)).status).toBe(200);
    expect(
      (
        await f.call(
          `${BASE}/settings`,
          jsonRequest('PATCH', { version: 1, name: 'Forbidden' }),
          VIEWER,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.call(
          `${BASE}/runs`,
          jsonRequest('POST', undefined, { 'Idempotency-Key': 'viewer-scan' }),
          VIEWER,
        )
      ).status,
    ).toBe(403);
    expect((await f.repository.getProject(f.project.id))?.name).toBe(
      f.project.name,
    );
    expect(f.queue.messages).toHaveLength(0);
  });

  it('does not expose another customer in project lists, runs or answer details', async () => {
    const f = await fixture();
    const other = newProject({
      id: 'other-project',
      name: 'Private customer',
      brand: 'Private brand',
      prompts: ['Private customer prompt'],
    });
    await f.repository.saveProject(other, null);
    await f.repository.syncUser(testIdentity('other-owner'));
    await f.repository.putMembership({
      projectId: other.id,
      userId: 'other-owner',
      role: 'owner',
    });
    const otherRunId = await f.scan(DATE, other.id);
    const otherResults = await f.repository.listResults(other.id, otherRunId);
    const listing = await read<{ items: Project[] }>(
      await f.call('/v1/projects'),
    );
    expect(listing.items.map((project) => project.id)).toEqual([f.project.id]);
    for (const path of [
      `/v1/projects/${other.id}/responses`,
      `/v1/projects/${other.id}/responses/${otherResults[0].responseId}`,
      `${BASE}/responses/${otherResults[0].responseId}`,
      `${BASE}/runs/${otherRunId}`,
    ]) {
      const result = await f.call(path);
      expect(result.status).toBe(404);
      expect(await result.text()).not.toContain('Private');
    }
  });
});

describe('real-provider readiness and prompt catalog', () => {
  it('blocks paid work before creating accounts or reserving scans when OpenAI is unconfigured', async () => {
    const f = await fixture(undefined, { providerConfigured: false });
    await f.repository.bootstrapAdmin((await f.repository.getUser(OWNER))!.id);
    expect(await read(await f.call('/v1/runtime'))).toMatchObject({
      providerConfigured: false,
      mode: 'live',
    });
    const before = await f.repository.getProject(f.project.id);
    for (const path of [
      '/v1/onboarding/accounts',
      `${BASE}/runs`,
      `${BASE}/onboarding/retry`,
    ]) {
      const result = await f.call(
        path,
        jsonRequest('POST', {}, { 'Idempotency-Key': 'real-only-request' }),
      );
      expect(result.status).toBe(503);
      expect(await read(result)).toMatchObject({
        error: { code: 'OPENAI_NOT_CONFIGURED' },
      });
    }
    expect(f.queue.messages).toHaveLength(0);
    expect(await f.repository.getProject(f.project.id)).toEqual(before);
    expect(await f.repository.listProjects(OWNER)).toHaveLength(1);
  });

  it('saves bulk prompt sections and topics, rejects normalized duplicates and protects stale edits', async () => {
    const f = await fixture(['What products should I compare?']);
    const added = await f.call(
      `${BASE}/prompts`,
      jsonRequest('POST', {
        texts: [
          'What security evidence supports this product?',
          'Which customer references can I verify?',
        ],
        stage: 'trust',
        topic: 'Security and references',
        branded: true,
      }),
    );
    expect(added.status).toBe(201);
    const { items } = await read<{ items: Project['prompts'] }>(added);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      stage: 'trust',
      topic: 'Security and references',
      branded: true,
      version: 1,
    });
    const edited = await f.call(
      `${BASE}/prompts/${items[0].id}`,
      jsonRequest('PATCH', {
        version: 1,
        stage: 'convert',
        topic: 'Procurement',
      }),
    );
    expect(await read(edited)).toMatchObject({
      version: 2,
      stage: 'convert',
      topic: 'Procurement',
    });
    const stale = await f.call(
      `${BASE}/prompts/${items[0].id}`,
      jsonRequest('PATCH', {
        version: 1,
        text: 'An older client overwriting a newer prompt?',
      }),
    );
    expect(stale.status).toBe(409);
    const duplicate = await f.call(
      `${BASE}/prompts`,
      jsonRequest('POST', { text: 'WHAT products should I compare!!!' }),
    );
    expect(duplicate.status).toBe(400);
    expect(
      (await f.repository.getProject(f.project.id))?.prompts.find(
        (p) => p.id === items[0].id,
      )?.topic,
    ).toBe('Procurement');
  });
});

describe('API prompt configuration and frozen history', () => {
  it('enforces the 50 active prompt limit, including racing additions', async () => {
    const f = await fixture(fixturePrompts().slice(0, 49));
    const additions = await Promise.all([
      f.call(
        `${BASE}/prompts`,
        jsonRequest('POST', {
          text: 'Compare enterprise products for a distributed team.',
        }),
      ),
      f.call(
        `${BASE}/prompts`,
        jsonRequest('POST', {
          text: 'Compare enterprise products for a local team.',
        }),
      ),
    ]);
    expect(additions.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      (await f.repository.getProject(f.project.id))?.prompts.filter(
        (prompt) => prompt.active,
      ),
    ).toHaveLength(50);
    const tooMany = await f.call(
      `${BASE}/prompts`,
      jsonRequest('POST', {
        text: 'One more prompt beyond the permitted customer limit.',
      }),
    );
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({
      error: { code: 'PROMPT_LIMIT' },
    });
  });

  it('rejects duplicate prompt text and does not allow reactivation above the cap', async () => {
    const f = await fixture(fixturePrompts());
    const archived = {
      ...f.project.prompts[0],
      id: 'archived-prompt',
      text: 'An archived prompt with distinct text',
      active: false,
    };
    await f.repository.saveProject(
      { ...f.project, version: 2, prompts: [...f.project.prompts, archived] },
      1,
    );
    const reactivation = await f.call(
      `${BASE}/prompts/archived-prompt`,
      jsonRequest('PATCH', { active: true }),
    );
    expect(reactivation.status).toBe(400);
    expect(await reactivation.json()).toMatchObject({
      error: { code: 'PROMPT_LIMIT' },
    });
    await f.call(`${BASE}/prompts/${f.project.prompts[1].id}`, {
      method: 'DELETE',
    });
    const duplicate = await f.call(
      `${BASE}/prompts`,
      jsonRequest('POST', { text: f.project.prompts[0].text.toUpperCase() }),
    );
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({
      error: { code: 'DUPLICATE_PROMPT' },
    });
  });

  it('increments prompt versions while preserving earlier answers and run snapshots', async () => {
    const f = await fixture();
    const runId = await f.scan();
    const original = f.project.prompts[0];
    const previous = await f.repository.getResult(
      f.project.id,
      runId,
      original.id,
    );
    const updatedText =
      'Which analytics tools should a healthcare team evaluate?';
    const patch = await f.call(
      `${BASE}/prompts/${original.id}`,
      jsonRequest('PATCH', { text: updatedText }),
    );
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ version: 2, text: updatedText });
    const detail = await read<ResponseDetail>(
      await f.call(`${BASE}/responses/${previous!.responseId}`),
    );
    expect(detail.result.prompt).toMatchObject({
      version: 1,
      text: original.text,
    });
    expect(detail.run.snapshot.prompts[0]).toMatchObject({
      version: 1,
      text: original.text,
    });
    expect(detail.answer?.text).toBeTruthy();
    await f.call(`${BASE}/prompts/${original.id}`, { method: 'DELETE' });
    expect(
      (await f.call(`${BASE}/responses/${previous!.responseId}`)).status,
    ).toBe(200);
    expect(
      (await f.repository.getRun(f.project.id, runId))?.snapshot.prompts,
    ).toHaveLength(3);
  });
});

describe('API results, sources and comparisons', () => {
  it('returns all 50 outcomes, including absent-brand answers, with correct visibility denominators', async () => {
    const f = await fixture(fixturePrompts());
    await f.scan();
    const page = await read<Page<PromptResult>>(
      await f.call(`${BASE}/responses`),
    );
    expect(page.total).toBe(50);
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBeNull();
    expect(page.items.every((result) => result.status === 'succeeded')).toBe(
      true,
    );
    const absent = page.items.filter(
      (result) => result.target?.mentioned === false,
    );
    expect(absent.length).toBeGreaterThan(0);
    expect(absent.length).toBeLessThan(50);
    const filtered = await read<Page<PromptResult>>(
      await f.call(`${BASE}/responses?mentioned=false`),
    );
    expect(filtered.items.map((result) => result.responseId)).toEqual(
      absent.map((result) => result.responseId),
    );
    const dashboard = await read<Dashboard>(await f.call(`${BASE}/dashboard`));
    expect(dashboard.metrics.visibility).toEqual({
      value: (100 * (50 - absent.length)) / 50,
      numerator: 50 - absent.length,
      denominator: 50,
    });
    expect(dashboard.run).toMatchObject({
      status: 'completed',
      totalCount: 50,
      succeededCount: 50,
    });
  });

  it('separates cited and consulted sources and drills from domains to URLs to the citing answers', async () => {
    const f = await fixture();
    await f.scan();
    const domains = await read<Page<SourceRow>>(
      await f.call(`${BASE}/sources`),
    );
    const consulted = await read<Page<SourceRow>>(
      await f.call(`${BASE}/sources?kind=consulted`),
    );
    expect(domains.items.some((row) => row.domain === 'research.example')).toBe(
      false,
    );
    expect(
      consulted.items.some((row) => row.domain === 'research.example'),
    ).toBe(true);
    const domain = domains.items.find(
      (row) => row.domain === 'reviewdesk.example',
    )!;
    expect(domain).toMatchObject({
      kind: 'cited',
      answerCount: 3,
      coverage: 100,
    });
    const urls = await read<Page<SourceRow>>(
      await f.call(`${BASE}/sources?groupBy=url&domain=${domain.domain}`),
    );
    expect(urls.items.length).toBeGreaterThan(0);
    expect(
      urls.items.every(
        (row) =>
          row.domain === domain.domain &&
          row.url?.startsWith('https://reviewdesk.example/'),
      ),
    ).toBe(true);
    const url = urls.items[0];
    const responses = await read<Page<PromptResult>>(
      await f.call(`${BASE}/sources/${url.id}/responses`),
    );
    expect(responses.items.map((result) => result.responseId).sort()).toEqual(
      [...url.responseIds].sort(),
    );
    for (const result of responses.items) {
      const detail = await read<ResponseDetail>(
        await f.call(`${BASE}/responses/${result.responseId}`),
      );
      expect(
        detail.answer?.citations.some((citation) => citation.url === url.url),
      ).toBe(true);
    }
    expect(
      (await f.call(`${BASE}/sources/unknown-source/responses`)).status,
    ).toBe(404);
  });

  it('compares only unchanged prompt versions across weeks', async () => {
    const f = await fixture();
    const firstRunId = await f.scan(new Date('2026-10-12T06:00:00.000Z'));
    await f.call(
      `${BASE}/prompts/${f.project.prompts[0].id}`,
      jsonRequest('PATCH', {
        text: 'What analytics software is best for a global enterprise?',
      }),
    );
    const secondRunId = await f.scan(DATE);
    const dashboard = await read<Dashboard>(await f.call(`${BASE}/dashboard`));
    expect(dashboard.run?.id).toBe(secondRunId);
    expect(dashboard.comparison).toMatchObject({
      previousRunId: firstRunId,
      comparableCount: 2,
      reason: 'Compared 2 unchanged, successfully analyzed prompts',
    });
    expect(dashboard.comparison.visibilityDelta).not.toBeNull();
    expect(
      dashboard.trend.find((point) => point.runId === firstRunId)?.comparable,
    ).toBe(false);
    expect(
      dashboard.trend.find((point) => point.runId === secondRunId)?.comparable,
    ).toBe(true);
  });

  it('does not compare scans after model or brand configuration changes', async () => {
    const f = await fixture();
    await f.scan(new Date('2026-10-12T06:00:00.000Z'));
    const original = (await f.repository.getProject(f.project.id))!;
    await f.repository.saveProject(
      {
        ...original,
        version: original.version + 1,
        generationModel: 'different-model',
        scanProviders: [{ provider: 'openai', model: 'different-model' }],
      },
      original.version,
    );
    await f.scan(DATE);
    const dashboard = await read<Dashboard>(await f.call(`${BASE}/dashboard`));
    expect(dashboard.comparison).toMatchObject({
      comparableCount: 0,
      visibilityDelta: null,
      reason: 'Model, brand or locale settings changed',
    });
  });

  it('paginates without repeating results and rejects invalid pagination and filters', async () => {
    const f = await fixture();
    await f.scan();
    const first = await read<Page<PromptResult>>(
      await f.call(`${BASE}/responses?limit=2`),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await read<Page<PromptResult>>(
      await f.call(`${BASE}/responses?limit=2&cursor=${first.nextCursor}`),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.items, ...second.items].map((result) => result.responseId),
      ).size,
    ).toBe(3);
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'cursor=!!!!',
      'cursor=bm90LWFuLW9mZnNldA',
      'mentioned=maybe',
    ]) {
      expect((await f.call(`${BASE}/responses?${query}`)).status, query).toBe(
        400,
      );
    }
    expect((await f.call(`${BASE}/sources?kind=anything`)).status).toBe(400);
    expect((await f.call(`${BASE}/sources?groupBy=anything`)).status).toBe(400);
  });

  it('returns 404 for unknown scans instead of falling back to an older result', async () => {
    const f = await fixture();
    await f.scan();
    for (const path of [
      'runs/missing-run',
      'dashboard?runId=missing-run',
      'responses?runId=missing-run',
      'sources?runId=missing-run',
    ]) {
      const response = await f.call(`${BASE}/${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: 'RUN_NOT_FOUND' },
      });
    }
  });
});

describe('API concurrent writes and scan admission', () => {
  it('rejects stale settings versions without overwriting a newer edit', async () => {
    const f = await fixture();
    const saved = await f.call(
      `${BASE}/settings`,
      jsonRequest('PATCH', { version: 1, name: 'Updated project' }),
    );
    expect(saved.status).toBe(200);
    const current = await read<Project>(saved);
    expect(current.version).toBeGreaterThan(1);
    expect(current.scheduleStatus).toBe('synced');
    const stale = await f.call(
      `${BASE}/settings`,
      jsonRequest('PATCH', { version: 1, name: 'Stale replacement' }),
    );
    expect(stale.status).toBe(409);
    expect((await f.repository.getProject(f.project.id))?.name).toBe(
      'Updated project',
    );
  });

  it('applies a newer schedule mutation before reporting synchronization success', async () => {
    let repository: MemoryRepository;
    const synced: Project[] = [];
    const f = await fixture(undefined, {
      syncSchedule: async (project) => {
        synced.push(structuredClone(project));
        if (synced.length === 1) {
          expect(
            await repository.saveProject(
              {
                ...project,
                enabled: false,
                timezone: 'Pacific/Auckland',
                version: project.version + 1,
              },
              project.version,
            ),
          ).toBe(true);
        }
      },
    });
    repository = f.repository;
    const result = await f.call(
      `${BASE}/settings`,
      jsonRequest('PATCH', { version: 1, name: 'New name' }),
    );
    expect(result.status).toBe(200);
    expect(synced).toHaveLength(2);
    expect(synced[0].enabled).toBe(true);
    expect(synced[1]).toMatchObject({
      enabled: false,
      timezone: 'Pacific/Auckland',
    });
    expect(await result.json()).toMatchObject({
      enabled: false,
      timezone: 'Pacific/Auckland',
      scheduleStatus: 'synced',
    });
    expect((await repository.getProject(f.project.id))?.scheduleStatus).toBe(
      'synced',
    );
  });

  it('retains settings and reports a recoverable error when scheduler synchronization fails', async () => {
    const f = await fixture(undefined, {
      syncSchedule: async () => {
        throw new Error('Scheduler unavailable');
      },
    });
    const result = await f.call(
      `${BASE}/settings`,
      jsonRequest('PATCH', { version: 1, enabled: false }),
    );
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({
      error: { code: 'SCHEDULE_SYNC_FAILED' },
    });
    expect(await f.repository.getProject(f.project.id)).toMatchObject({
      enabled: false,
      scheduleStatus: 'error',
    });
  });

  it('admits only one of two distinct manual scan requests while the queue has not delivered either', async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.call(
        `${BASE}/runs`,
        jsonRequest('POST', undefined, {
          'Idempotency-Key': 'manual-request-one',
        }),
      ),
      f.call(
        `${BASE}/runs`,
        jsonRequest('POST', undefined, {
          'Idempotency-Key': 'manual-request-two',
        }),
      ),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      202, 409,
    ]);
    expect(f.queue.messages).toHaveLength(1);
    expect(await f.repository.listRuns(f.project.id)).toHaveLength(0);
    const blocked = await f.call(
      `${BASE}/runs`,
      jsonRequest('POST', undefined, {
        'Idempotency-Key': 'manual-request-three',
      }),
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { code: 'RUN_ACTIVE' },
    });
  });

  it('repairs a failed queue send using the same idempotency key without admitting a second scan', async () => {
    const f = await fixture();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi
      .spyOn(f.queue, 'send')
      .mockRejectedValueOnce(
        new Error('Provider credentials must not be returned to the client'),
      );
    try {
      const init = jsonRequest('POST', undefined, {
        'Idempotency-Key': 'repair-queue-send',
      });
      const failed = await f.call(`${BASE}/runs`, init);
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain('Provider credentials');
      const repaired = await f.call(`${BASE}/runs`, init);
      expect(repaired.status).toBe(202);
      const repeated = await f.call(`${BASE}/runs`, init);
      expect(repeated.status).toBe(202);
      expect(await repeated.json()).toEqual(await repaired.json());
      expect(send).toHaveBeenCalledTimes(3);
      expect(f.queue.messages).toHaveLength(2);
      expect(f.queue.messages[0]).toMatchObject({
        kind: 'kickoff',
        requestId: 'repair-queue-send',
      });
      expect(f.queue.messages[1]).toMatchObject({
        kind: 'kickoff',
        requestId: 'repair-queue-send',
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it('requires idempotency keys for manual scans and failed-job retries', async () => {
    const f = await fixture();
    const runId = await f.scan();
    for (const path of [`${BASE}/runs`, `${BASE}/runs/${runId}/retry-failed`]) {
      const response = await f.call(path, { method: 'POST' });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'IDEMPOTENCY_REQUIRED' },
      });
    }
  });
});
