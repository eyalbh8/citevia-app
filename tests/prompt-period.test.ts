import { describe, expect, it } from 'vitest';
import {
  promptMetricChange,
  promptPeriodMetrics,
  promptMetrics,
  sameMethod,
  sameTargetMethod,
  type PromptHistory,
  type PromptResult,
  type ScanProvider,
  type ScanRun,
} from '@citevia/core';
import {
  MemoryArtifacts,
  MemoryQueue,
  MemoryRepository,
  PostgresRepository,
  uuidFor,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { createApi } from '../apps/api/src/app.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const start = '2026-10-15T00:00:00.000Z',
  end = '2026-10-21T23:59:59.999Z';
function fixture() {
  const project = newProject({
    id: 'prompt-period',
    prompts: ['Which tools should I compare?'],
  });
  project.scanProviders!.push({ provider: 'gemini', model: 'gemini-test' });
  const history: PromptHistory = { runs: [], results: [] };
  let sequence = 0;
  function observation(
    at: string,
    options: {
      provider?: ScanProvider;
      mentioned?: boolean;
      sentiment?: 'positive' | 'neutral' | 'negative' | 'unknown';
      rank?: number;
      status?: PromptResult['status'];
    } = {},
  ) {
    const provider = options.provider || 'openai',
      id = `run_${sequence++}`;
    const run: ScanRun = {
      projectId: project.id,
      id,
      scheduledAt: at,
      createdAt: at,
      status: 'completed',
      trigger: 'manual',
      snapshot: {
        projectName: project.name,
        brand: project.brand,
        competitors: project.competitors,
        prompts: project.prompts,
        country: project.country,
        language: project.language,
        timezone: project.timezone,
        provider,
        generationModel: project.scanProviders!.find(
          (value) => value.provider === provider,
        )!.model,
        extractionModel: project.extractionModel,
        parserVersion: project.parserVersion,
        configVersion: 1,
      },
      totalCount: 1,
      terminalCount: 1,
      succeededCount: 1,
      capturedCount: 1,
      resultVersion: 1,
      deadlineAt: at,
      expiresAt: 2000000000,
    };
    const result: PromptResult = {
      projectId: project.id,
      runId: id,
      promptId: project.prompts[0].id,
      prompt: { ...project.prompts[0] },
      responseId: `${id}~${project.prompts[0].id}`,
      status: options.status || 'succeeded',
      version: 1,
      attempts: 1,
      capturedAt: at,
      captureKey: `capture/${id}`,
      citationCount: 0,
      sourceCount: 0,
      expiresAt: 2000000000,
      target: {
        brandId: project.brand.id,
        mentioned: options.mentioned ?? true,
        appearanceRank: options.rank ?? 1,
        explicitRank: null,
        mentionOrder: 1,
        sentiment: options.sentiment || 'positive',
        evidence: [],
        rankEvidence: null,
        sentimentEvidence: null,
      },
    };
    history.runs.push(run);
    history.results.push(result);
    return { run, result };
  }
  return { project, history, observation };
}

describe('iGEO prompt period metrics', () => {
  it('retains target measurements when competitors change without relaxing full-report compatibility', () => {
    const f = fixture();
    const previous = f.observation('2026-10-13T12:00:00.000Z', { rank: 3 });
    const current = f.observation('2026-10-20T12:00:00.000Z', { rank: 2 });
    f.project.competitors = [
      { id: 'new', name: 'New rival', aliases: [], domains: [] },
    ];
    current.run.snapshot.competitors = f.project.competitors;
    expect(sameTargetMethod(previous.run.snapshot, current.run.snapshot)).toBe(
      true,
    );
    expect(sameMethod(previous.run.snapshot, current.run.snapshot)).toBe(false);
    expect(
      promptPeriodMetrics(f.project, f.history, start, end).items[0],
    ).toMatchObject({
      measurementCount: 1,
      previousMeasurementCount: 1,
      avgVisibility: 100,
      avgRank: 2,
      rankChange: 33.33,
    });
    expect(
      promptMetrics(f.project, current.run, [current.result], previous.run, [
        previous.result,
      ])[0],
    ).toMatchObject({ previousMeasurementCount: 1, rankChange: 33.33 });
    f.project.brand = { ...f.project.brand, aliases: ['New target alias'] };
    expect(
      promptPeriodMetrics(f.project, f.history, start, end).items[0]
        .measurementCount,
    ).toBe(0);
  });
  it('matches rounded period averages and two-decimal iGEO changes', () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) {
      f.observation('2026-10-20T12:00:00Z', {
        sentiment: i < 94 ? 'positive' : 'negative',
        rank: i < 30 ? 3 : 2,
      });
      f.observation('2026-10-13T12:00:00Z', {
        sentiment: i < 92 ? 'positive' : 'negative',
        rank: 2,
      });
    }
    const report = promptPeriodMetrics(f.project, f.history, start, end);
    expect(report.items[0]).toMatchObject({
      avgVisibility: 100,
      avgSentimentScore: 94,
      avgRank: 2.3,
      visibilityChange: 0,
      sentimentChange: 2.17,
      rankChange: -15,
      measurementCount: 100,
      previousMeasurementCount: 100,
    });
    expect(report.period).toEqual({
      start,
      end,
      previousStart: '2026-10-08T00:00:00.000Z',
      previousEnd: '2026-10-14T23:59:59.999Z',
    });
    expect(promptMetricChange(100, 95)).toBe(5.26);
    expect(promptMetricChange(67, 87)).toBe(-22.99);
    expect(promptMetricChange(2.8, 2.7, true)).toBe(-3.7);
    expect(promptMetricChange(100, 0)).toBe(100);
    expect(promptMetricChange(0, 0)).toBe(0);
    expect(promptMetricChange(null, 0)).toBeNull();
    expect(promptMetricChange(1, 0, true)).toBeNull();
  });
  it('averages all selected providers, ignores failures, and retains null unknown scores', () => {
    const f = fixture();
    f.observation(start, {
      provider: 'openai',
      mentioned: true,
      sentiment: 'unknown',
    });
    f.observation(end, { provider: 'gemini', mentioned: false });
    f.observation(start, { status: 'failed_extraction', mentioned: true });
    expect(
      promptPeriodMetrics(f.project, f.history, start, end).items[0],
    ).toMatchObject({
      avgVisibility: 50,
      avgSentimentScore: null,
      avgRank: 1,
      measurementCount: 2,
      sentimentCount: 0,
    });
    expect(
      promptPeriodMetrics(f.project, f.history, start, end, 'gemini').items[0],
    ).toMatchObject({
      avgVisibility: 0,
      avgRank: null,
      avgSentimentScore: null,
      measurementCount: 1,
    });
  });
  it('counts a reanalyzed answer once at its original capture time and excludes incompatible methods/versions', () => {
    const f = fixture();
    const first = f.observation('2026-10-13T12:00:00Z', {
      sentiment: 'neutral',
    });
    const rescored = f.observation('2026-10-20T12:00:00Z');
    rescored.run.reanalysisOf = first.run.id;
    rescored.result.captureKey = first.result.captureKey;
    rescored.result.capturedAt = first.result.capturedAt;
    const changed = f.observation(start);
    changed.result.prompt.version = 2;
    const foreign = f.observation(start);
    foreign.result.projectId = 'another-account';
    const incompatible = f.observation(start);
    incompatible.run.snapshot.generationModel = 'different-model';
    expect(
      promptPeriodMetrics(f.project, f.history, start, end).items[0],
    ).toMatchObject({
      avgVisibility: null,
      avgSentimentScore: null,
      measurementCount: 0,
      previousMeasurementCount: 1,
      visibilityChange: null,
    });
  });
});

it('validates periods, returns empty metrics before the first scan, and scopes reads to members', async () => {
  const repository = new MemoryRepository(),
    project = newProject({ prompts: ['Which products are useful?'] });
  await repository.syncUser(testIdentity('period-owner'));
  await repository.saveProject(project, null);
  await repository.putMembership({
    projectId: project.id,
    userId: 'period-owner',
    role: 'owner',
  });
  const api = createApi(
    { repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() },
    { mode: 'live', now: () => new Date(end) },
  );
  const request = (suffix = '') =>
    new Request(
      `http://test/v1/projects/${project.id}/prompt-metrics${suffix}`,
    );
  const response = await api(request(), testIdentity('period-owner'));
  expect(response.status).toBe(200);
  expect((await response.json()).items[0]).toMatchObject({
    avgVisibility: null,
    avgSentimentScore: null,
    avgRank: null,
  });
  for (const suffix of [
    '?days=8',
    '?days=NaN',
    '?provider=unknown',
    '?days=custom&start=2026-10-15',
    '?days=custom&end=2026-10-21',
    '?days=custom&start=2026-02-30&end=2026-03-01',
    '?days=custom&start=2026-10-22&end=2026-10-21',
    '?days=custom&start=2025-01-01&end=2026-10-21',
  ])
    expect(
      (await api(request(suffix), testIdentity('period-owner'))).status,
    ).toBe(400);
  expect((await api(request(), testIdentity('outsider'))).status).toBe(404);
  expect(
    (await api(request('?days=custom'), testIdentity('outsider'))).status,
  ).toBe(404);
  const fortnight = await api(
    request('?days=14'),
    testIdentity('period-owner'),
  );
  expect(fortnight.status).toBe(200);
  expect((await fortnight.json()).period).toMatchObject({
    start: '2026-10-08T00:00:00.000Z',
    end,
    previousStart: '2026-09-24T00:00:00.000Z',
    previousEnd: '2026-10-07T23:59:59.999Z',
  });
});

it('uses inclusive custom UTC dates and the immediately preceding equal-length comparison period', async () => {
  const repository = new MemoryRepository(),
    f = fixture();
  await repository.syncUser(testIdentity('custom-owner'));
  await repository.saveProject(f.project, null);
  await repository.putMembership({
    projectId: f.project.id,
    userId: 'custom-owner',
    role: 'owner',
  });
  for (const [at, mentioned] of [
    ['2026-10-11T23:59:59.999Z', true],
    ['2026-10-12T00:00:00.000Z', false],
    ['2026-10-14T23:59:59.999Z', false],
    ['2026-10-15T00:00:00.000Z', true],
    ['2026-10-17T23:59:59.999Z', true],
    ['2026-10-18T00:00:00.000Z', false],
  ] as const) {
    const { run, result } = f.observation(at, { mentioned });
    await repository.createRun(run, [result]);
  }
  const api = createApi(
    { repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() },
    { mode: 'live', now: () => new Date(end) },
  );
  const response = await api(
    new Request(
      `http://test/v1/projects/${f.project.id}/prompt-metrics?days=custom&start=2026-10-15&end=2026-10-17`,
    ),
    testIdentity('custom-owner'),
  );
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.period).toEqual({
    start: '2026-10-15T00:00:00.000Z',
    end: '2026-10-17T23:59:59.999Z',
    previousStart: '2026-10-12T00:00:00.000Z',
    previousEnd: '2026-10-14T23:59:59.999Z',
  });
  expect(data.items[0]).toMatchObject({
    avgVisibility: 100,
    visibilityChange: 100,
    measurementCount: 2,
    previousMeasurementCount: 2,
  });
});

it('round-trips prompt metadata, original observations and API averages through PostgreSQL', async () => {
  const db = await localPostgres();
  try {
    const repository = new PostgresRepository(db),
      f = fixture();
    await repository.syncUser(testIdentity('period-db-owner'));
    await repository.saveProject(f.project, null);
    await repository.putMembership({
      projectId: f.project.id,
      userId: 'period-db-owner',
      role: 'owner',
    });
    const api = createApi(
      {
        repository,
        artifacts: new MemoryArtifacts(),
        queue: new MemoryQueue(),
      },
      { mode: 'live', now: () => new Date(end) },
    );
    const call = (tail: string, body?: unknown, identity = 'period-db-owner') =>
      api(
        new Request(`http://test/v1/projects/${f.project.id}/${tail}`, {
          method: body ? 'PATCH' : 'GET',
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        testIdentity(identity),
      );
    const edited = await call(`prompts/${f.project.prompts[0].id}`, {
      version: 1,
      seoKeyword: 'analytics tools',
      tags: ['P1 - Priority', 'Comparison'],
      intent: 'comparison',
    });
    expect(edited.status).toBe(200);
    f.project = (await repository.getProject(f.project.id))!;
    // Fixture closure uses the original project, so carry the saved version into each immutable observation explicitly.
    const current = f.observation('2026-10-20T12:00:00Z', { rank: 2 });
    const previous = f.observation('2026-10-13T12:00:00Z', {
      rank: 3,
      sentiment: 'neutral',
    });
    for (const { run, result } of [current, previous]) {
      result.prompt = { ...f.project.prompts[0] };
      run.snapshot.prompts = f.project.prompts;
      expect(await repository.createRun(run, [result])).toBe(true);
      await repository.saveMeasurement(result, run, null, null);
    }
    // A new repository instance reads only committed database state.
    const reloaded = new PostgresRepository(db);
    expect((await reloaded.getProject(f.project.id))?.prompts[0]).toMatchObject(
      {
        seoKeyword: 'analytics tools',
        tags: ['P1 - Priority', 'Comparison'],
        intent: 'comparison',
        version: 2,
      },
    );
    const native = (
      await db.query(
        'SELECT seo_keyword,tags,type,regions,language FROM prompts WHERE account_id=$1',
        [uuidFor(f.project.id)],
      )
    ).rows[0];
    expect(native).toMatchObject({
      seo_keyword: 'analytics tools',
      tags: ['P1 - Priority', 'Comparison'],
      type: 'comparison',
      regions: ['US'],
      language: 'en',
    });
    const history = await reloaded.listPromptHistory(
      f.project.id,
      '2026-10-08T00:00:00Z',
      end,
    );
    expect(history.results).toHaveLength(2);
    const response = await call('prompt-metrics?days=7');
    expect(response.status).toBe(200);
    expect((await response.json()).items[0]).toMatchObject({
      seoKeyword: 'analytics tools',
      avgVisibility: 100,
      avgRank: 2,
      avgSentimentScore: 100,
      sentimentChange: 100,
      rankChange: 33.33,
    });
    expect(
      (
        await call(`prompts/${f.project.prompts[0].id}`, {
          version: 1,
          seoKeyword: 'stale',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(`prompts/${f.project.prompts[0].id}`, {
          version: 2,
          tags: Array(11).fill('tag'),
        })
      ).status,
    ).toBe(400);
    await repository.syncUser(testIdentity('period-viewer'));
    await repository.putMembership({
      projectId: f.project.id,
      userId: 'period-viewer',
      role: 'viewer',
    });
    expect(
      (
        await call(
          `prompts/${f.project.prompts[0].id}`,
          { version: 2, seoKeyword: 'forbidden' },
          'period-viewer',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call('settings', {
          version: f.project.version,
          country: 'GB',
          language: 'fr',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await db.query(
          'SELECT regions,language FROM prompts WHERE account_id=$1',
          [uuidFor(f.project.id)],
        )
      ).rows[0],
    ).toEqual({ regions: ['GB'], language: 'fr' });
    expect(
      (await (await call('prompt-metrics?days=7')).json()).items[0]
        .avgVisibility,
    ).toBeNull();
  } finally {
    await db.close();
  }
}, 30000);
