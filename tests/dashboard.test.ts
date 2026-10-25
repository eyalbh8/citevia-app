import { describe, expect, it, vi } from 'vitest';
import {
  aggregateDashboardOverview,
  JOURNEY_STAGES,
  type BrandAnalysis,
  type CapturedAnswer,
  type DashboardObservation,
  type DashboardOverview,
  type Project,
  type ScanProvider,
} from '@citevia/core';
import {
  MemoryArtifacts,
  MemoryQueue,
  MemoryRepository,
  PostgresRepository,
  type Repository,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { createApi } from '../apps/api/src/app.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const period = {
  start: '2026-10-14T00:00:00.000Z',
  end: '2026-10-20T23:59:59.999Z',
  granularity: 'daily' as const,
  timezone: 'UTC' as const,
};
const filters: DashboardOverview['filters'] = {
  providers: ['openai', 'gemini'],
  region: '',
  tag: '',
  branded: '',
  intent: '',
  search: '',
  topic: '',
};
function project() {
  const value = newProject({
    prompts: ['First question?', 'Second question?', 'Third question?'],
  });
  value.scanProviders = [
    { provider: 'openai', model: 'test' },
    { provider: 'gemini', model: 'test' },
  ];
  value.prompts[0] = {
    ...value.prompts[0],
    stage: 'understand',
    topic: 'Analytics',
    tags: ['Priority'],
    intent: 'informational',
  };
  value.prompts[1].stage = 'understand';
  value.prompts[2].stage = 'trust';
  return value;
}
function brand(
  brandId: string,
  mentioned = true,
  sentiment: BrandAnalysis['sentiment'] = 'positive',
): BrandAnalysis {
  return {
    brandId,
    mentioned,
    explicitRank: 99,
    mentionOrder: 1,
    sentiment,
    evidence: [],
    rankEvidence: null,
    sentimentEvidence: null,
  };
}
function observation(
  value: Project,
  id: string,
  day = '2026-10-15',
  {
    prompt = 0,
    provider = 'openai',
    mentioned = true,
    competitors = [],
    sentiment = 'positive',
  }: {
    prompt?: number;
    provider?: ScanProvider;
    mentioned?: boolean;
    competitors?: string[];
    sentiment?: BrandAnalysis['sentiment'];
  } = {},
): DashboardObservation {
  const at = `${day}T12:00:00.000Z`,
    target = brand(value.brand.id, mentioned, sentiment);
  const run: DashboardObservation['run'] = {
    id,
    projectId: value.id,
    createdAt: at,
    scheduledAt: at,
    status: 'completed',
    trigger: 'manual',
    snapshot: {
      projectName: value.name,
      brand: value.brand,
      competitors: value.competitors,
      prompts: value.prompts,
      country: value.country,
      language: value.language,
      timezone: value.timezone,
      generationModel: 'test',
      extractionModel: 'test',
      parserVersion: value.parserVersion,
      configVersion: 1,
      provider,
    },
    totalCount: 1,
    terminalCount: 1,
    succeededCount: 1,
    capturedCount: 1,
    resultVersion: 1,
    deadlineAt: at,
    expiresAt: 2000000000,
  };
  return {
    run,
    result: {
      projectId: value.id,
      runId: id,
      promptId: value.prompts[prompt].id,
      prompt: value.prompts[prompt],
      responseId: `${id}~${value.prompts[prompt].id}`,
      status: 'succeeded',
      version: 1,
      attempts: 1,
      captureKey: `captures/${id}`,
      analysisKey: `analyses/${id}`,
      target,
      brands: [target, ...competitors.map((id) => brand(id))],
      citationCount: 0,
      sourceCount: 0,
      capturedAt: at,
      completedAt: at,
      expiresAt: 2000000000,
    },
  };
}
function capture(urls: string[]): CapturedAnswer {
  return {
    providerResponseId: 'native-answer',
    model: 'test',
    status: 'completed',
    text: 'Private native answer',
    blocks: [],
    sources: [{ url: 'https://consulted-only.example/page' }],
    citations: urls.map((url, index) => ({
      id: String(index),
      blockId: 'b1',
      url,
      title: 'Native citation',
      start: null,
      end: null,
    })),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    createdAt: '2026-10-15T12:00:00.000Z',
    raw: { privateReceipt: true },
  };
}

describe('dashboard overview measurement semantics', () => {
  it('omits excluded scan rounds and their reanalyses from every aggregate without mutating evidence', () => {
    const value = project();
    const earlier = observation(value, 'earlier', '2026-10-20');
    earlier.run.reportingExcludedAt = '2026-10-23T00:00:00.000Z';
    earlier.run.reportingExclusionReason = 'Keep one scan round on October 20';
    earlier.answer = capture(['https://excluded.example/page']);
    const reanalysis = structuredClone(earlier);
    reanalysis.run.id = reanalysis.result.runId = 'earlier-reanalysis';
    reanalysis.run.reanalysisOf = earlier.run.id;
    const kept = observation(value, 'kept', '2026-10-20', { mentioned: false });
    const data = aggregateDashboardOverview(value, period, filters, [earlier, reanalysis, kept]);
    expect(data).toMatchObject({
      analyzed: 1,
      ranking: [],
      sources: [],
      trend: [{ date: '2026-10-20', mentions: {} }],
      providers: [
        { provider: 'openai', count: 0, change: 0 },
        { provider: 'gemini', count: 0, change: null },
      ],
    });
    expect(data.stages.find((row) => row.key === 'understand'))
      .toMatchObject({ measuredPromptCount: 1, visibility: 0 });
    expect(earlier.result.status).toBe('succeeded');
    expect(earlier.answer.citations).toHaveLength(1);
  });

  it('weights each active prompt equally and includes unmeasured prompts as zero', () => {
    const value = project();
    value.prompts.push({
      ...value.prompts[0],
      id: 'unassigned',
      stage: undefined,
    });
    value.prompts.push({ ...value.prompts[0], id: 'inactive', active: false });
    const items = [0, 1, 2, 3].map((id) => observation(value, `first-${id}`));
    items.push(
      observation(value, 'second', undefined, { prompt: 1, mentioned: false }),
    );
    const result = aggregateDashboardOverview(value, period, filters, items);
    expect(result.stages).toEqual([
      {
        key: 'understand',
        promptCount: 2,
        measuredPromptCount: 2,
        visibility: 50,
        visibilityChange: 0,
      },
      { key: 'trust', promptCount: 1, measuredPromptCount: 0, visibility: 0, visibilityChange: null },
      {
        key: 'unassigned',
        promptCount: 1,
        measuredPromptCount: 0,
        visibility: 0,
        visibilityChange: null,
      },
    ]);
    expect(result.analyzed).toBe(5);
  });

  it('compares stage visibility rates on its own observed days, weighting active prompts equally', () => {
    const value = project();
    const items = [
      ...Array.from({ length: 10 }, (_, index) => observation(value, `first-${index}`, '2026-10-15', { mentioned: index < 2 })),
      ...Array.from({ length: 5 }, (_, index) => observation(value, `last-${index}`, '2026-10-18', { mentioned: index < 2 })),
      observation(value, 'another-stage-first', '2026-10-14', { prompt: 2 }),
      observation(value, 'another-stage-last', '2026-10-20', { prompt: 2 }),
    ];
    const data = aggregateDashboardOverview(value, period, filters, items);
    // The measured prompt goes from 20% to 40%, while the other active prompt
    // counts as zero on both days: stage visibility rises 10% to 20% (+100%).
    // Mention counts themselves are unchanged, so they cannot supply this delta.
    expect(data.stages.find(row => row.key === 'understand')).toEqual({
      key: 'understand', promptCount: 2, measuredPromptCount: 1, visibility: 14, visibilityChange: 100,
    });
    expect(data.stages.find(row => row.key === 'trust')?.visibilityChange).toBe(0);
  });

  it.each([
    { first: 4, last: 2, expected: -50 },
    { first: 2, last: 2, expected: 0 },
    { first: 0, last: 2, expected: 100 },
    { first: 0, last: 0, expected: 0 },
  ])('calculates stage rate change from $first to $last mentions, including observed zeroes', ({ first, last, expected }) => {
    const value = project();
    const items = [
      ...Array.from({ length: 10 }, (_, index) => observation(value, `first-${index}`, '2026-10-15', { mentioned: index < first })),
      ...Array.from({ length: 10 }, (_, index) => observation(value, `last-${index}`, '2026-10-18', { mentioned: index < last })),
    ];
    const data = aggregateDashboardOverview(value, period, filters, items);
    expect(data.stages.find(row => row.key === 'understand')?.visibilityChange).toBe(expected);
    expect(data.stages.find(row => row.key === 'trust')?.visibilityChange).toBeNull();
  });

  it('keeps fractional daily visibility precise until the final percentage change', () => {
    const value = project();
    const items = [
      ...Array.from({ length: 3 }, (_, index) => observation(value, `first-${index}`, '2026-10-15', { mentioned: index < 1 })),
      ...Array.from({ length: 3 }, (_, index) => observation(value, `last-${index}`, '2026-10-18', { mentioned: index < 2 })),
    ];
    expect(aggregateDashboardOverview(value, period, filters, items).stages.find(row => row.key === 'understand'))
      .toMatchObject({ visibility: 25, visibilityChange: 100 });
  });

  it('uses only matching current prompt versions for stage changes and keeps single-day comparisons neutral', () => {
    const value = project();
    const edited = observation(value, 'old-question', '2026-10-18');
    edited.result.prompt = { ...edited.result.prompt, version: 0 };
    const otherProvider = observation(value, 'excluded-provider', '2026-10-18', { provider: 'gemini' });
    const first = observation(value, 'first', '2026-10-15', { mentioned: false });
    const data = aggregateDashboardOverview(value, period, { ...filters, providers: ['openai'] }, [first, edited, otherProvider]);
    expect(data.stages.find(row => row.key === 'understand')).toMatchObject({ visibility: 0, visibilityChange: 0 });
    expect(aggregateDashboardOverview(value, period, filters, [edited]).stages.every(row => row.visibilityChange === null)).toBe(true);
  });

  it('deduplicates prompt text within a provider scan, but counts new scans and providers', () => {
    const value = project();
    const first = observation(value, 'same-scan');
    const duplicate = structuredClone(first);
    duplicate.result.promptId = 'same-text-another-id';
    duplicate.result.responseId = 'same-scan~duplicate';
    const result = aggregateDashboardOverview(value, period, filters, [
      first,
      duplicate,
      observation(value, 'next-scan', '2026-10-18'),
      observation(value, 'gemini-scan', '2026-10-18', { provider: 'gemini' }),
    ]);
    expect(result.providers).toEqual([
      { provider: 'openai', count: 2, change: 0 },
      { provider: 'gemini', count: 1, change: 0 },
    ]);
    expect(result.ranking[0].mentions).toBe(3);
  });

  it('uses daily competition ranks, zero-mention observed days, and score-point sentiment changes', () => {
    const value = project(),
      competitor = value.competitors[0].id;
    const items = [
      observation(value, 'a', '2026-10-15', { competitors: [competitor] }),
      observation(value, 'b', '2026-10-15'),
      observation(value, 'c', '2026-10-15'),
      observation(value, 'd', '2026-10-18', {
        mentioned: false,
        competitors: [competitor],
      }),
      observation(value, 'e', '2026-10-18', {
        mentioned: false,
        competitors: [competitor],
      }),
      observation(value, 'f', '2026-10-20', {
        competitors: [competitor],
        sentiment: 'negative',
      }),
    ];
    const result = aggregateDashboardOverview(value, period, filters, items);
    const target = result.ranking.find((row) => row.isTarget)!;
    expect(target).toMatchObject({
      rank: 1.3,
      rankChange: 0,
      mentions: 4,
      mentionChange: -66.67,
      sentiment: 75,
      sentimentChange: -100,
    });
    expect(result.ranking).toHaveLength(2); // Never-mentioned competitors are not fabricated.
    expect(result.trend).toEqual([
      { date: '2026-10-15', mentions: { target: 3, [competitor]: 1 } },
      { date: '2026-10-18', mentions: { target: 0, [competitor]: 2 } },
      { date: '2026-10-20', mentions: { target: 1, [competitor]: 1 } },
    ]);
    items[5].result.target!.mentioned = false;
    expect(
      aggregateDashboardOverview(value, period, filters, items).ranking.find(
        (row) => row.isTarget,
      ),
    ).toMatchObject({
      rank: 1.7,
      rankChange: -1,
      sentiment: 100,
      sentimentChange: null,
    });
  });

  it('averages classified sentiment over all selected mentions for both target and competitors', () => {
    const value = project();
    const competitor = value.competitors[0].id;
    const first = observation(value, 'first', '2026-10-15', {
      competitors: [competitor],
    });
    first.result.brands![1].sentiment = 'negative';
    const second = observation(value, 'second', '2026-10-15', {
      competitors: [competitor],
    });
    second.result.brands![1].sentiment = 'neutral';
    const unknown = observation(value, 'unknown', '2026-10-18', {
      competitors: [competitor],
      sentiment: 'unknown',
    });
    unknown.result.brands![1].sentiment = 'unknown';
    const last = observation(value, 'last', '2026-10-20', {
      provider: 'gemini',
      sentiment: 'negative',
    });
    const data = aggregateDashboardOverview(value, period, filters, [first, second, unknown, last]);
    expect(data.ranking.find((row) => row.isTarget)).toMatchObject({
      mentions: 4,
      sentiment: 67,
      sentimentChange: -100,
    });
    expect(data.ranking.find((row) => row.brandId === competitor)).toMatchObject({
      mentions: 3,
      sentiment: 25,
      sentimentChange: null,
    });
    const selected = aggregateDashboardOverview(
      value, period, { ...filters, providers: ['gemini'] }, [first, second, unknown, last],
    );
    expect(selected.ranking).toHaveLength(1);
    expect(selected.ranking[0]).toMatchObject({ sentiment: 0, mentions: 1 });
  });

  it('compares mention totals on observed days including measured zeroes, per provider', () => {
    const value = project();
    const first = observation(value, 'first', '2026-10-15');
    const zero = observation(value, 'zero', '2026-10-18', { mentioned: false });
    const last = observation(value, 'last', '2026-10-20', { provider: 'gemini' });
    const data = aggregateDashboardOverview(value, period, filters, [first, zero, last]);
    expect(data.providers).toEqual([
      { provider: 'openai', count: 1, change: -100 },
      { provider: 'gemini', count: 1, change: 0 },
    ]);
    expect(aggregateDashboardOverview(value, period, filters, [first, zero]).ranking[0])
      .toMatchObject({ mentions: 1, mentionChange: -100 });
    expect(aggregateDashboardOverview(value, period, filters, [zero, last]).ranking[0])
      .toMatchObject({ mentions: 1, mentionChange: 100, sentimentChange: null });
    expect(data.trend.map((row) => row.date)).toEqual(['2026-10-15', '2026-10-18', '2026-10-20']);
  });

  it('retains historical totals without assigning answers to an edited active prompt', () => {
    const value = project();
    const previous = observation(value, 'old-question');
    previous.result.prompt = { ...previous.result.prompt };
    value.prompts[0] = {
      ...value.prompts[0],
      version: value.prompts[0].version + 1,
      text: 'A changed question?',
    };
    const data = aggregateDashboardOverview(value, period, filters, [previous]);
    expect(data.analyzed).toBe(1);
    expect(data.ranking[0].mentions).toBe(1);
    expect(data.stages.find((row) => row.key === 'understand'))
      .toMatchObject({ promptCount: 2, measuredPromptCount: 0, visibility: 0, visibilityChange: null });
  });

  it.each(['provider', 'region', 'tag', 'topic', 'intent', 'branded', 'search', 'stage', 'date'])(
    'excludes mismatched %s observations from every card and competitor sentiment',
    (dimension) => {
      const value = project();
      const selected: DashboardOverview['filters'] = {
        ...filters,
        providers: ['gemini'],
        region: 'US',
        tag: 'Priority',
        topic: 'Analytics',
        intent: 'informational',
        branded: 'false',
        search: 'first',
        stage: 'understand',
      };
      const competitor = value.competitors[0].id;
      const included = observation(value, 'included', '2026-10-15', {
        provider: 'gemini', competitors: [competitor], sentiment: 'negative',
      });
      included.result.brands![1].sentiment = 'negative';
      included.answer = capture(['https://included.example/page']);
      const excluded = observation(value, 'excluded', '2026-10-18', {
        provider: 'gemini', competitors: [competitor],
      });
      excluded.result.prompt = { ...excluded.result.prompt };
      excluded.answer = capture(['https://excluded.example/page']);
      switch (dimension) {
        case 'provider': excluded.run.snapshot.provider = 'openai'; break;
        case 'region': excluded.run.snapshot.country = 'GB'; break;
        case 'tag': excluded.result.prompt.tags = ['Other']; break;
        case 'topic': excluded.result.prompt.topic = 'Other'; break;
        case 'intent': excluded.result.prompt.intent = 'comparison'; break;
        case 'branded': excluded.result.prompt.branded = true; break;
        case 'search': excluded.result.prompt.text = 'Unrelated question'; break;
        case 'stage': excluded.result.prompt.stage = 'trust'; break;
        case 'date': excluded.result.capturedAt = '2026-10-21T00:00:00.000Z'; break;
      }
      const data = aggregateDashboardOverview(value, period, selected, [included, excluded]);
      expect(data).toMatchObject({
        analyzed: 1,
        providers: [{ provider: 'gemini', count: 1, change: 0 }],
        stages: [{ key: 'understand', promptCount: 1, measuredPromptCount: 1, visibility: 100 }],
        trend: [{ date: '2026-10-15', mentions: { [value.brand.id]: 1, [competitor]: 1 } }],
        sources: [{ domain: 'included.example', pageCount: 1, citationCount: 1 }],
      });
      expect(data.ranking).toHaveLength(2);
      for (const row of data.ranking)
        expect(row).toMatchObject({ mentions: 1, sentiment: 0, sentimentChange: 0 });
    },
  );

  it('counts distinct cited pages per hostname separately from citation occurrences', () => {
    const value = project(),
      item = observation(value, 'sources');
    item.answer = capture([
      'https://northstar.example/Page?id=7&utm_source=ai',
      'http://NORTHSTAR.example/Page?id=7#section',
      'https://northstar.example/Page?id=8',
      'https://kb.northstar.example/Page',
      'javascript:alert(1)',
    ]);
    const result = aggregateDashboardOverview(value, period, filters, [item]);
    expect(result.sources).toEqual([
      {
        domain: 'northstar.example',
        pageCount: 2,
        citationCount: 3,
        owned: true,
      },
      {
        domain: 'kb.northstar.example',
        pageCount: 1,
        citationCount: 1,
        owned: true,
      },
    ]);
  });

  it('applies provider, region and prompt metadata filters to observations and active stages', () => {
    const value = project();
    const selected = {
      ...filters,
      providers: ['gemini' as const],
      region: 'US',
      tag: 'Priority',
      topic: 'Analytics',
      intent: 'informational',
      branded: 'false',
      search: 'first',
    };
    const data = [
      observation(value, 'openai'),
      observation(value, 'gemini', undefined, { provider: 'gemini' }),
      observation(value, 'other-prompt', undefined, {
        provider: 'gemini',
        prompt: 1,
      }),
      observation(value, 'disabled', undefined, { provider: 'perplexity' }),
    ];
    expect(
      aggregateDashboardOverview(value, period, selected, data),
    ).toMatchObject({
      analyzed: 1,
      providers: [{ provider: 'gemini', count: 1, change: 0 }],
      stages: [
        {
          key: 'understand',
          promptCount: 1,
          measuredPromptCount: 1,
          visibility: 100,
        },
      ],
    });
    expect(
      aggregateDashboardOverview(
        value,
        period,
        { ...selected, region: 'GB' },
        data,
      ),
    ).toMatchObject({
      analyzed: 0,
      stages: [],
      ranking: [],
      sources: [],
      trend: [],
    });
  });

  it('keeps absent observations and unknown sentiment distinguishable from measured zero', () => {
    const value = project();
    expect(
      aggregateDashboardOverview(value, period, filters, []),
    ).toMatchObject({
      analyzed: 0,
      ranking: [],
      trend: [],
      sources: [],
      providers: [
        { provider: 'openai', count: 0, change: null },
        { provider: 'gemini', count: 0, change: null },
      ],
    });
    const item = observation(value, 'unknown', undefined, {
      sentiment: 'unknown',
    });
    expect(
      aggregateDashboardOverview(value, period, filters, [item]).ranking[0],
    ).toMatchObject({ sentiment: null, sentimentChange: null });
    item.result.target!.mentioned = false;
    expect(
      aggregateDashboardOverview(value, period, filters, [item]),
    ).toMatchObject({
      analyzed: 1,
      ranking: [],
      trend: [{ date: '2026-10-15', mentions: {} }],
    });
  });
});

describe('authorized period dashboard API', () => {
  async function setup(value = project()) {
    const repository = new MemoryRepository(),
      artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    await repository.saveProject(value, null);
    await repository.syncUser(testIdentity('viewer'));
    await repository.syncUser(testIdentity('outsider'));
    await repository.putMembership({
      projectId: value.id,
      userId: 'viewer',
      role: 'viewer',
    });
    const api = createApi(
      { repository, artifacts, queue },
      { mode: 'live', now: () => new Date(period.end) },
    );
    const call = (query = '', user: string | null = 'viewer') =>
      api(
        new Request(
          `https://citevia.test/v1/projects/${value.id}/dashboard/overview${query}`,
        ),
        user ? testIdentity(user) : undefined,
      );
    const save = async (item: DashboardObservation) => {
      await repository.createRun(item.run, [item.result]);
      if (item.answer)
        await artifacts.put(item.result.captureKey!, item.answer);
    };
    return { repository, artifacts, value, call, save };
  }

  it('deduplicates reanalysis receipts, filters by captured date and avoids extraction artifact reads', async () => {
    const { artifacts, value, call, save } = await setup();
    const original = observation(value, 'original');
    original.answer = capture(['https://northstar.example/page']);
    original.result.citationCount = 1;
    await save(original);
    const reanalysis = structuredClone(original);
    reanalysis.run = {
      ...reanalysis.run,
      id: 'reanalysis',
      reanalysisOf: original.run.id,
      createdAt: '2026-10-20T12:00:00.000Z',
    };
    reanalysis.result = {
      ...reanalysis.result,
      runId: 'reanalysis',
      responseId: 'reanalysis~p_01',
      analysisKey: 'analyses/new',
    };
    await save(reanalysis);
    const outside = observation(value, 'outside', '2026-10-12');
    outside.run.createdAt = '2026-10-20T12:00:00.000Z';
    await save(outside);
    const failed = observation(value, 'failed');
    failed.run.status = 'failed';
    await save(failed);
    const foreign = observation({ ...value, id: 'another-project' }, 'foreign');
    await save(foreign);
    const read = vi.spyOn(artifacts, 'get');
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const data = (await response.json()) as DashboardOverview;
    expect(data.analyzed).toBe(1);
    expect(data.providers[0]).toMatchObject({ count: 1, change: 0 });
    expect(data.sources).toEqual([
      {
        domain: 'northstar.example',
        pageCount: 1,
        citationCount: 1,
        owned: true,
      },
    ]);
    expect(read.mock.calls.map(([key]) => key)).toEqual(['captures/original']);
    expect(JSON.stringify(data)).not.toMatch(
      /Private native answer|privateReceipt|captureKey|analysisKey/,
    );
    expect(
      (
        await call('?days=custom&start=2026-10-20&end=2026-10-20').then((r) =>
          r.json(),
        )
      ).analyzed,
    ).toBe(0);
  });

  it('validates periods and providers after authorization, with no cross-project disclosure', async () => {
    const { call, value, save } = await setup();
    await save(observation(value, 'gemini', undefined, { provider: 'gemini' }));
    expect((await call('', null)).status).toBe(401);
    expect((await call('', 'outsider')).status).toBe(404);
    expect((await call('?stage=informational', null)).status).toBe(401);
    expect((await call('?stage=informational', 'outsider')).status).toBe(404);
    for (const query of [
      '?days=2',
      '?days=custom&start=2026-02-30&end=2026-03-01',
      '?providers=perplexity',
      '?branded=maybe',
      '?stage=informational',
      '?stage=understand,trust',
    ])
      expect((await call(query)).status).toBe(400);
    const response = await call(
      '?providers=gemini&topic=Analytics&tag=Priority&intent=informational&region=US',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      analyzed: 1,
      providers: [{ provider: 'gemini', count: 1, change: 0 }],
    });
  });

  it.each(JOURNEY_STAGES)(
    'filters every dashboard card by the %s stage together with date and provider',
    async (stage) => {
      const value = project();
      value.prompts = JOURNEY_STAGES.map((key) => ({
        ...value.prompts[0],
        id: key,
        text: `${key} question?`,
        stage: key,
        intent: 'informational',
      }));
      value.prompts.push({
        ...value.prompts[JOURNEY_STAGES.indexOf(stage)],
        id: 'unmeasured',
        text: 'A prompt without observations',
      });
      const { call, save } = await setup(value);
      for (const [prompt, key] of JOURNEY_STAGES.entries()) {
        const selected = observation(value, `${key}-gemini`, '2026-10-18', {
          prompt,
          provider: 'gemini',
          competitors: [value.competitors[0].id],
        });
        selected.answer = capture([`https://${key}.example/page`]);
        selected.result.citationCount = 1;
        await save(selected);
        await save(
          observation(value, `${key}-openai`, '2026-10-18', { prompt }),
        );
        await save(
          observation(value, `${key}-earlier`, '2026-10-17', {
            prompt,
            provider: 'gemini',
          }),
        );
      }
      const response = await call(
        `?days=custom&start=2026-10-18&end=2026-10-18&providers=gemini&stage=${stage}&intent=informational`,
      );
      expect(response.status).toBe(200);
      const data = (await response.json()) as DashboardOverview;
      expect(data).toMatchObject({
        filters: { stage, intent: 'informational', providers: ['gemini'] },
        analyzed: 1,
        providers: [{ provider: 'gemini', count: 1, change: 0 }],
        stages: [
          { key: stage, promptCount: 2, measuredPromptCount: 1, visibility: 50 },
        ],
        trend: [{ date: '2026-10-18', mentions: { target: 1, clearview: 1 } }],
        sources: [
          {
            domain: `${stage}.example`,
            pageCount: 1,
            citationCount: 1,
            owned: false,
          },
        ],
      });
      expect(data.ranking).toHaveLength(2);
      expect(data.ranking.map(({ mentions }) => mentions)).toEqual([1, 1]);
      expect(
        await call(`?stage=${stage}&intent=comparison`).then((r) => r.json()),
      ).toMatchObject({
        analyzed: 0,
        stages: [],
        ranking: [],
        trend: [],
        sources: [],
      });
    },
  );
});

it.each(['memory', 'postgres'])(
  'serves indexed native citations without artifact reads, retaining legacy captures and project isolation (%s)',
  async (backend) => {
    const db = backend === 'postgres' ? await localPostgres() : undefined;
    const repository: Repository = db
      ? new PostgresRepository(db)
      : new MemoryRepository();
    const artifacts = new MemoryArtifacts();
    try {
      const value = project();
      await repository.saveProject(value, null);
      await repository.syncUser(testIdentity('viewer'));
      await repository.putMembership({
        projectId: value.id,
        userId: 'viewer',
        role: 'viewer',
      });
      const first = observation(value, 'indexed');
      const native = capture([
        'https://northstar.example/Page?id=7&utm_source=ai',
        'http://NORTHSTAR.example/Page?id=7#section',
        'https://kb.northstar.example/Page',
      ]);
      first.result.citationCount = native.citations.length;
      await repository.createRun(first.run, [first.result]);
      await repository.saveMeasurement(first.result, first.run, native, null);
      const empty = observation(value, 'indexed-empty');
      // Presence of the empty native receipt wins even if legacy metadata overstates citations.
      empty.result.citationCount = 1;
      await repository.createRun(empty.run, [empty.result]);
      await repository.saveMeasurement(
        empty.result,
        empty.run,
        capture([]),
        null,
      );
      const noCitations = observation(value, 'unindexed-empty');
      await repository.createRun(noCitations.run, [noCitations.result]);
      const other = { ...value, id: 'other-project' };
      await repository.saveProject(other, null);
      const foreign = observation(other, 'indexed');
      await repository.createRun(foreign.run, [foreign.result]);
      await repository.saveMeasurement(
        foreign.result,
        foreign.run,
        capture(['https://private-other.example/page']),
        null,
      );

      const firstKey = `openai:${first.result.captureKey}`;
      const emptyKey = `openai:${empty.result.captureKey}`;
      const rows = await repository.listNativeCitations(value.id, [
        ...Array.from({ length: 501 }, (_, index) => `missing-${index}`),
        firstKey,
        emptyKey,
        firstKey,
      ]);
      expect(rows).toHaveLength(2);
      expect(
        rows
          .find((row) => row.captureKey === firstKey)
          ?.citations.map((c) => c.url)
          .sort(),
      ).toEqual(native.citations.map((c) => c.url).sort());
      expect(
        rows.find((row) => row.captureKey === emptyKey)?.citations,
      ).toEqual([]);
      expect(
        await repository.listNativeCitations('not-a-project', [firstKey]),
      ).toEqual([]);

      const api = createApi(
        { repository, artifacts, queue: new MemoryQueue() },
        { mode: 'live', now: () => new Date(period.end) },
      );
      const call = () =>
        api(
          new Request(
            `https://citevia.test/v1/projects/${value.id}/dashboard/overview`,
          ),
          testIdentity('viewer'),
        );
      const read = vi.spyOn(artifacts, 'get');
      const response = await call();
      expect(response.status).toBe(200);
      expect((await response.json()).sources).toEqual([
        {
          domain: 'northstar.example',
          pageCount: 1,
          citationCount: 2,
          owned: true,
        },
        {
          domain: 'kb.northstar.example',
          pageCount: 1,
          citationCount: 1,
          owned: true,
        },
      ]);
      expect(read).not.toHaveBeenCalled();

      const legacy = observation(value, 'legacy');
      legacy.result.citationCount = 2;
      await repository.createRun(legacy.run, [legacy.result]);
      await artifacts.put(
        legacy.result.captureKey!,
        capture([
          'https://northstar.example/new',
          'https://legacy.example/page',
        ]),
      );
      const withLegacy = await call();
      expect(withLegacy.status).toBe(200);
      expect((await withLegacy.json()).sources).toEqual([
        {
          domain: 'northstar.example',
          pageCount: 2,
          citationCount: 3,
          owned: true,
        },
        {
          domain: 'kb.northstar.example',
          pageCount: 1,
          citationCount: 1,
          owned: true,
        },
        {
          domain: 'legacy.example',
          pageCount: 1,
          citationCount: 1,
          owned: false,
        },
      ]);
      expect(read.mock.calls.map(([key]) => key)).toEqual([
        legacy.result.captureKey,
      ]);
    } finally {
      await db?.close();
    }
  },
);
