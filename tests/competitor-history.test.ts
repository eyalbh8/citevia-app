import { describe, expect, it, vi } from 'vitest';
import {
  aggregateDashboardOverview,
  type Analysis,
  type BrandAnalysis,
  type DashboardObservation,
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
import {
  competitorSuggestions,
  historicalCompetitorMentions,
} from '../apps/api/src/competitors.js';
import { newProject } from './fixtures/scanner.js';
import { captured } from '../apps/scanner/test/fixtures.js';
import { createApi } from '../apps/api/src/app.js';
import { testIdentity } from './fixtures/users.js';

const now = new Date('2026-10-21T12:00:00.000Z');
const period = {
  start: '2026-10-15T00:00:00.000Z',
  end: now.toISOString(),
  timezone: 'UTC' as const,
  granularity: 'daily' as const,
};
const filters = {
  providers: [],
  region: '',
  tag: '',
  branded: '',
  intent: '',
  search: '',
};

function observation(
  project: Project,
  id: string,
  names: string[],
  options: {
    at?: string;
    provider?: ScanProvider;
  } = {},
) {
  const at = options.at || '2026-10-20T12:00:00.000Z';
  const target: BrandAnalysis = {
    brandId: project.brand.id,
    mentioned: true,
    explicitRank: null,
    appearanceRank: 1,
    mentionOrder: 1,
    sentiment: 'positive',
    evidence: [],
    rankEvidence: null,
    sentimentEvidence: null,
  };
  const item: DashboardObservation = {
    run: {
      id,
      projectId: project.id,
      scheduledAt: at,
      createdAt: at,
      status: 'completed',
      trigger: 'manual',
      snapshot: structuredClone({
        ...project,
        projectName: project.name,
        configVersion: project.version,
        provider: options.provider || 'openai',
      }),
      totalCount: 1,
      terminalCount: 1,
      succeededCount: 1,
      capturedCount: 1,
      resultVersion: 1,
      deadlineAt: at,
      expiresAt: 2000000000,
    },
    result: {
      projectId: project.id,
      runId: id,
      promptId: project.prompts[0].id,
      prompt: project.prompts[0],
      responseId: `${id}~${project.prompts[0].id}`,
      status: 'succeeded',
      version: 1,
      attempts: 1,
      capturedAt: at,
      captureKey: `captures/${id}`,
      analysisKey: `analyses/${id}`,
      target,
      brands: [target],
      citationCount: 0,
      sourceCount: 0,
      expiresAt: 2000000000,
    },
  };
  const answer = captured(
    names.map((name) => `${name} is an alternative.`).join('\n'),
  );
  answer.createdAt = at;
  const analysis: Analysis = {
    brands: [target],
    companies: names.map((name, index) => {
      const quote = `${name} is an alternative.`;
      const start = answer.blocks[0].text.indexOf(quote);
      return {
        name,
        rank: index + 1,
        evidence: {
          blockId: answer.blocks[0].id,
          quote,
          start,
          end: start + quote.length,
        },
      };
    }),
    parserVersion: project.parserVersion,
    validationVersion: 'exact-evidence-v2.1',
    model: project.extractionModel,
    createdAt: at,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
  return { ...item, answer, analysis };
}

async function fixture(repository: Repository = new MemoryRepository()) {
  const project = newProject({ prompts: ['Which products should I compare?'] });
  project.competitors[0].aliases = ['Clear View'];
  const runtime = {
    repository,
    artifacts: new MemoryArtifacts(),
    queue: new MemoryQueue(),
  };
  await runtime.repository.saveProject(project, null);
  const save = async (item: ReturnType<typeof observation>) => {
    await runtime.repository.createRun(item.run, [item.result]);
    await runtime.artifacts.put(item.result.analysisKey!, item.analysis);
    await runtime.artifacts.put(item.result.captureKey!, item.answer);
  };
  return { project, runtime, save };
}

describe('observed competitor suggestions', () => {
  it('uses verified company appearances, deduplicates captures and names, and excludes assigned identities', async () => {
    const { project, runtime, save } = await fixture();
    const first = observation(project, 'first', [
      'Northstar',
      'Northstar Analytics',
      'Clear View',
      'Skyward',
      'SKYWARD',
      'Delta',
    ]);
    first.answer.citations.push({
      id: 'publisher',
      blockId: first.answer.blocks[0].id,
      url: 'https://publisher.example/skyward',
      title: 'Review',
      start: null,
      end: null,
    });
    await save(first);
    const duplicate = observation(project, 'reanalysis', ['Skyward']);
    duplicate.run.reanalysisOf = first.run.id;
    duplicate.run.createdAt = now.toISOString();
    duplicate.result.captureKey = first.result.captureKey;
    duplicate.analysis = first.analysis;
    await save(duplicate);
    const secondProvider = observation(project, 'gemini', ['Skyward'], {
      provider: 'gemini',
      at: '2026-10-19T12:00:00.000Z',
    });
    secondProvider.result.captureKey = first.result.captureKey;
    await save(secondProvider);
    await save(
      observation(project, 'old', ['Outdated'], {
        at: '2026-06-01T12:00:00.000Z',
      }),
    );
    await save(
      observation({ ...project, id: 'another-project' }, 'foreign', [
        'Foreign rival',
      ]),
    );
    const failed = observation(project, 'failed', ['Failed rival']);
    failed.result.status = 'failed_extraction';
    await save(failed);
    const result = await competitorSuggestions(runtime, project, now);
    expect(
      result.items.map(({ name, mentions }) => ({ name, mentions })),
    ).toEqual([
      { name: 'Skyward', mentions: 2 },
      { name: 'Delta', mentions: 1 },
    ]);
    expect(result.items[0].evidence).toEqual({
      quote: 'Skyward is an alternative.',
      runId: 'reanalysis',
      promptId: project.prompts[0].id,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /publisher|captureKey|analysisKey|domain|Foreign|Outdated|Failed/,
    );
  });

  it('rejects unvalidated, incompatible, malformed, substring and URL-only evidence', async () => {
    const { project, runtime, save } = await fixture();
    const unvalidated = observation(project, 'unvalidated', ['Unvalidated']);
    delete unvalidated.analysis.validationVersion;
    await save(unvalidated);
    const incompatible = observation(project, 'incompatible', ['Incompatible']);
    incompatible.analysis.parserVersion = 'another-parser';
    await save(incompatible);
    for (const [id, quote, name] of [
      ['substring', 'Skywardness is useful.', 'Skyward'],
      ['url', 'Source: https://skyward.example/', 'Skyward'],
      ['offset', 'Wrong length', 'Wrong'],
    ]) {
      const item = observation(project, id, [name]);
      Object.assign(item.analysis.companies![0].evidence, {
        quote,
        start: 0,
        end: id === 'offset' ? 999 : quote.length,
      });
      await save(item);
    }
    expect(await competitorSuggestions(runtime, project, now)).toEqual({
      items: [],
    });
  });

  it('bounds suggestions to the latest 300 original captures and five concurrent artifact reads', async () => {
    const { project, runtime } = await fixture();
    const items = Array.from({ length: 320 }, (_, index) =>
      observation(project, `sample-${index}`, ['Skyward']),
    );
    vi.spyOn(runtime.repository, 'listPromptHistory').mockResolvedValue({
      runs: items.map((item) => item.run),
      results: items.map((item) => item.result),
    });
    let active = 0,
      maxActive = 0;
    const read = vi
      .spyOn(runtime.artifacts, 'get')
      .mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        return items[0].analysis;
      });
    expect(
      (await competitorSuggestions(runtime, project, now)).items[0].mentions,
    ).toBe(300);
    expect(read).toHaveBeenCalledTimes(300);
    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it('only exposes suggestions to account members and never changes saved project data', async () => {
    const { project, runtime, save } = await fixture();
    await runtime.repository.syncUser(testIdentity('viewer'));
    await runtime.repository.putMembership({
      projectId: project.id,
      userId: 'viewer',
      role: 'viewer',
    });
    await save(observation(project, 'suggestion', ['Skyward']));
    const before = await runtime.repository.getProject(project.id);
    const api = createApi(runtime, { mode: 'live', now: () => now });
    const request = () =>
      new Request(
        `https://test/v1/projects/${project.id}/competitors/suggestions`,
      );
    expect((await api(request())).status).toBe(401);
    expect((await api(request(), testIdentity('outsider'))).status).toBe(404);
    const response = await api(request(), testIdentity('viewer'));
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].name).toBe('Skyward');
    expect(await runtime.repository.getProject(project.id)).toEqual(before);
    expect(runtime.queue.messages).toEqual([]);
  });
});

describe('historical competitor dashboard measurements', () => {
  it.each([
    ['positive', 100],
    ['neutral', 50],
    ['negative', 0],
    ['mixed', 50],
  ] as const)(
    'recovers evidence-backed %s sentiment for a subsequently assigned competitor',
    async (sentiment, score) => {
      const { project, runtime, save } = await fixture();
      const item = observation(project, 'scored-company', ['Skyward']);
      const company = item.analysis.companies![0];
      company.sentiment = sentiment;
      company.sentimentEvidence = company.evidence;
      company.sentimentScore = score;
      item.analysis.validationVersion = 'exact-evidence-v2.2';
      await save(item);
      await runtime.repository.saveMeasurement(
        item.result, item.run, item.answer, item.analysis,
      );
      project.competitors.push({
        id: 'skyward', name: 'Skyward', aliases: [], domains: [],
      });
      const read = vi.spyOn(runtime.artifacts, 'get');
      const projected = await historicalCompetitorMentions(
        runtime, project, [item],
      );
      expect(
        projected[0].result.brands?.find((brand) => brand.brandId === 'skyward'),
      ).toMatchObject({
        sentiment, sentimentScore: score, sentimentEvidence: company.evidence,
      });
      expect(
        aggregateDashboardOverview(project, period, filters, projected)
          .ranking.find((brand) => brand.brandId === 'skyward'),
      ).toMatchObject({ mentions: 1, sentiment: score });
      expect(read).not.toHaveBeenCalled();
      expect(runtime.queue.messages).toEqual([]);
      expect(item.result.brands).toHaveLength(1);
    },
  );

  it('does not reuse another company assessment, malformed evidence, or an unsupported numeric score', async () => {
    const { project, runtime, save } = await fixture();
    const item = observation(project, 'bad-sentiment', ['Skyward', 'OtherCo']);
    const company = item.analysis.companies![0];
    company.sentiment = 'positive';
    company.sentimentScore = 100;
    project.competitors.push({
      id: 'skyward', name: 'Skyward', aliases: [], domains: [],
    });
    for (const evidence of [
      undefined,
      item.analysis.companies![1].evidence,
      { ...company.evidence, end: 999 },
    ]) {
      company.sentimentEvidence = evidence;
      await save(item);
      const projected = await historicalCompetitorMentions(
        runtime, project, [item],
      );
      expect(
        projected[0].result.brands?.find((brand) => brand.brandId === 'skyward'),
      ).toMatchObject({
        sentiment: 'unknown', sentimentScore: null, sentimentEvidence: null,
      });
    }
  });

  it.each(['memory', 'postgres'])(
    'prefers indexed analysis and authoritative null over legacy artifacts (%s)',
    async (backend) => {
      const db = backend === 'postgres' ? await localPostgres() : undefined;
      try {
        const { project, runtime, save } = await fixture(
          db ? new PostgresRepository(db) : new MemoryRepository(),
        );
        const indexed = observation(project, 'indexed', ['Skyward']);
        const indexedNull = observation(project, 'indexed-null', [
          'Stale artifact rival',
        ]);
        for (const item of [indexed, indexedNull]) {
          await save(item);
          await runtime.repository.saveMeasurement(
            item.result,
            item.run,
            item.answer,
            item === indexedNull ? null : item.analysis,
          );
        }
        const read = vi.spyOn(runtime.artifacts, 'get');
        expect(
          (await competitorSuggestions(runtime, project, now)).items.map(
            ({ name }) => name,
          ),
        ).toEqual(['Skyward']);
        expect(read).not.toHaveBeenCalled();
        const updated = {
          ...project,
          version: project.version + 1,
          competitors: [
            ...project.competitors,
            { id: 'skyward', name: 'Skyward', aliases: [], domains: [] },
            {
              id: 'stale',
              name: 'Stale artifact rival',
              aliases: [],
              domains: [],
            },
          ],
        };
        await runtime.repository.saveProject(updated, project.version);
        await runtime.repository.syncUser(testIdentity('viewer'));
        await runtime.repository.putMembership({
          projectId: project.id,
          userId: 'viewer',
          role: 'viewer',
        });
        const api = createApi(runtime, { mode: 'live', now: () => now });
        const response = await api(
          new Request(
            `https://test/v1/projects/${project.id}/dashboard/overview`,
          ),
          testIdentity('viewer'),
        );
        expect(response.status).toBe(200);
        const dashboard = await response.json();
        expect(
          dashboard.ranking.find(
            (brand: { brandId: string }) => brand.brandId === 'skyward',
          ),
        ).toMatchObject({ mentions: 1, sentiment: null });
        expect(
          dashboard.ranking.some(
            (brand: { brandId: string }) => brand.brandId === 'stale',
          ),
        ).toBe(false);
        expect(read).not.toHaveBeenCalled();

        const legacy = observation(project, 'legacy', ['Legacy rival']);
        await save(legacy);
        expect(
          (await competitorSuggestions(runtime, project, now)).items
            .map(({ name }) => name)
            .sort(),
        ).toEqual(['Legacy rival', 'Skyward']);
        expect(read.mock.calls.map(([key]) => key)).toEqual([
          legacy.result.analysisKey,
        ]);
      } finally {
        await db?.close?.();
      }
    },
  );

  it('does not relabel a former competitor when its saved ID is reused for a new name or website', async () => {
    const { project, runtime, save } = await fixture();
    const oldRival = project.competitors[0];
    const measured = observation(project, 'former-identity', [oldRival.name]);
    measured.result.brands!.push({
      ...measured.result.target!,
      brandId: oldRival.id,
    });
    await save(measured);
    for (const currentRival of [
      { ...oldRival, name: 'Skyward', aliases: [] },
      { ...oldRival, domains: ['another-company.example'] },
    ]) {
      const changed = { ...project, competitors: [currentRival] };
      for (const item of [
        measured,
        { ...measured, result: { ...measured.result, analysisKey: undefined } },
      ]) {
        const projected = await historicalCompetitorMentions(runtime, changed, [
          item,
        ]);
        expect(
          aggregateDashboardOverview(
            changed,
            period,
            filters,
            projected,
          ).ranking.some((brand) => brand.brandId === oldRival.id),
        ).toBe(false);
      }
    }
    expect(
      measured.result.brands!.some((brand) => brand.brandId === oldRival.id),
    ).toBe(true);
  });

  it('preserves established alias renames and only recovers a new identity from its own verified appearance', async () => {
    const { project, runtime, save } = await fixture();
    const oldRival = project.competitors[0];
    const measured = observation(project, 'both-identities', [
      oldRival.name,
      'Skyward',
    ]);
    measured.result.brands!.push({
      ...measured.result.target!,
      brandId: oldRival.id,
    });
    await save(measured);
    const renamed = {
      ...project,
      competitors: [{ ...oldRival, name: 'Clear View', aliases: [] }],
    };
    const read = vi.spyOn(runtime.artifacts, 'get');
    const preserved = await historicalCompetitorMentions(runtime, renamed, [
      measured,
    ]);
    expect(read).not.toHaveBeenCalled();
    expect(
      aggregateDashboardOverview(
        renamed,
        period,
        filters,
        preserved,
      ).ranking.find((brand) => brand.brandId === oldRival.id),
    ).toMatchObject({ name: 'Clear View', mentions: 1, sentiment: 100 });
    const reassigned = {
      ...project,
      competitors: [
        {
          ...oldRival,
          name: 'Skyward',
          aliases: [],
          domains: ['skyward.example'],
        },
      ],
    };
    const recovered = await historicalCompetitorMentions(runtime, reassigned, [
      measured,
    ]);
    expect(
      aggregateDashboardOverview(
        reassigned,
        period,
        filters,
        recovered,
      ).ranking.find((brand) => brand.brandId === oldRival.id),
    ).toMatchObject({ name: 'Skyward', mentions: 1, sentiment: null });
    expect(
      recovered[0].result.brands?.find((brand) => brand.brandId === oldRival.id)
        ?.appearanceRank,
    ).toBe(2);
  });

  it('projects exact assigned identities without inventing sentiment, absence or fresh observations', async () => {
    const { project, runtime, save } = await fixture();
    const first = observation(project, 'first', ['Skyward Labs']);
    const second = observation(project, 'second', ['Skyward Labs Inc']);
    const trackedAbsence = observation(project, 'tracked-absence', [
      'Skyward Labs',
    ]);
    const rival = {
      id: 'skyward',
      name: 'Skyward',
      aliases: ['Skyward Labs'],
      domains: [],
    };
    trackedAbsence.run.snapshot.competitors.push(rival);
    trackedAbsence.result.brands!.push({
      ...trackedAbsence.result.target!,
      brandId: rival.id,
      mentioned: false,
      sentiment: 'not_applicable',
    });
    for (const item of [first, second, trackedAbsence]) await save(item);
    project.competitors.push(rival);
    const originals = structuredClone([first, second, trackedAbsence]);
    const projected = await historicalCompetitorMentions(runtime, project, [
      first,
      second,
      trackedAbsence,
    ]);
    const report = aggregateDashboardOverview(
      project,
      period,
      filters,
      projected,
    );
    expect(report.analyzed).toBe(3);
    expect(report.providers[0].count).toBe(3);
    expect(
      report.ranking.find((brand) => brand.brandId === rival.id),
    ).toMatchObject({ mentions: 1, sentiment: null, sentimentChange: null });
    expect(
      projected[0].result.brands?.find((brand) => brand.brandId === rival.id),
    ).toMatchObject({
      mentioned: true,
      appearanceRank: 1,
      explicitRank: null,
      sentiment: 'unknown',
      sentimentScore: null,
    });
    expect(projected[1]).toBe(second);
    expect(projected[2]).toBe(trackedAbsence);
    expect([first, second, trackedAbsence]).toEqual(originals);
    expect(await runtime.artifacts.get(first.result.analysisKey!)).toEqual(
      first.analysis,
    );
    expect(runtime.queue.messages).toEqual([]);
  });

  it('keeps already tracked scans on the indexed dashboard fast path', async () => {
    const { project, runtime } = await fixture();
    const item = observation(project, 'already-tracked', ['Clearview']);
    const read = vi.spyOn(runtime.artifacts, 'get');
    expect(
      await historicalCompetitorMentions(runtime, project, [item]),
    ).toEqual([item]);
    expect(read).not.toHaveBeenCalled();
  });

  it('includes newly assigned historical mentions in the authenticated dashboard without a new scan', async () => {
    const { project, runtime, save } = await fixture();
    await save(observation(project, 'before-assignment', ['Skyward']));
    await runtime.repository.syncUser(testIdentity('viewer'));
    await runtime.repository.putMembership({
      projectId: project.id,
      userId: 'viewer',
      role: 'viewer',
    });
    await runtime.repository.saveProject(
      {
        ...project,
        competitors: [
          ...project.competitors,
          { id: 'skyward', name: 'Skyward', aliases: [], domains: [] },
        ],
        version: project.version + 1,
      },
      project.version,
    );
    const api = createApi(runtime, { mode: 'live', now: () => now });
    const response = await api(
      new Request(`https://test/v1/projects/${project.id}/dashboard/overview`),
      testIdentity('viewer'),
    );
    expect(response.status).toBe(200);
    const dashboard = await response.json();
    expect(
      dashboard.ranking.find(
        (brand: { brandId: string }) => brand.brandId === 'skyward',
      ),
    ).toMatchObject({ mentions: 1, sentiment: null });
    expect(dashboard.trend[0]).toMatchObject({
      date: '2026-10-20',
      mentions: { skyward: 1 },
    });
    expect(runtime.queue.messages).toEqual([]);
    expect(await runtime.repository.listRuns(project.id)).toHaveLength(1);
  });
});
