import { describe, expect, it } from 'vitest';
import {
  citationMeasurement,
  trackedUrlKey,
  trackingRows,
  medianPickupDays,
  type Analysis,
  type CapturedAnswer,
  type Project,
  type PromptResult,
  type ScanRun,
  type TrackedUrl,
} from '@citevia/core';
import {
  MemoryRepository,
  MemoryArtifacts,
  MemoryQueue,
  PostgresRepository,
  type Repository,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { createApi } from '../apps/api/src/app.js';
import { monitoringPeriod } from '../apps/api/src/monitoring.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';
import { backfillTracking } from '../packages/storage/src/tracking-backfill.js';
import { Scanner } from '../apps/scanner/src/engine.js';

function sample(
  project: Project,
  id: string,
  at: string,
  provider: 'openai' | 'gemini' = 'openai',
) {
  const prompt = {
    ...project.prompts[0],
    tags: ['Priority'],
    intent: 'informational' as const,
  };
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
      prompts: [prompt],
      country: 'US',
      language: 'en',
      timezone: 'UTC',
      provider,
      generationModel: 'test-model',
      extractionModel: 'test-extract',
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
  const target = {
    brandId: project.brand.id,
    mentioned: true,
    appearanceRank: 1,
    explicitRank: null,
    mentionOrder: 1,
    sentiment: 'positive' as const,
    evidence: [{ blockId: 'b1', quote: 'Northstar', start: 0, end: 9 }],
    rankEvidence: null,
    sentimentEvidence: null,
  };
  const result: PromptResult = {
    projectId: project.id,
    runId: id,
    promptId: prompt.id,
    responseId: `${id}~${prompt.id}`,
    prompt,
    status: 'succeeded',
    version: 1,
    attempts: 1,
    captureKey: `captures/${id}`,
    analysisKey: `analysis/${id}`,
    target,
    citationCount: 2,
    sourceCount: 1,
    capturedAt: at,
    expiresAt: 2000000000,
  };
  const answer: CapturedAnswer = {
    provider,
    providerResponseId: id,
    model: 'test-model',
    status: 'completed',
    text: '**Northstar** leads. Another company appears too.',
    blocks: [
      { id: 'b1', text: 'Northstar leads. Another company appears too.' },
    ],
    citations: [
      {
        id: 'one',
        blockId: 'b1',
        url: 'https://example.com/Page?id=7&utm_source=ai',
        title: 'A page',
        start: 0,
        end: 10,
      },
      {
        id: 'two',
        blockId: 'b1',
        url: 'http://EXAMPLE.com/Page?id=7#section',
        title: 'A page again',
        start: 0,
        end: 10,
      },
    ],
    sources: [{ url: 'https://example.com/consulted-only' }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    createdAt: at,
    raw: { test: true },
  };
  const analysis: Analysis = {
    brands: [target],
    companies: [
      { name: project.brand.name, rank: 1, evidence: target.evidence[0] },
      {
        name: 'Another company',
        rank: 2,
        evidence: {
          blockId: 'b1',
          quote: 'Another company',
          start: 17,
          end: 32,
        },
      },
    ],
    parserVersion: project.parserVersion,
    model: 'test-extract',
    createdAt: at,
    usage: answer.usage,
  };
  return { run, result, answer, analysis };
}
describe('iGEO URL identity and measurement semantics', () => {
  it('matches the reference summary pickup rounding, including even-sized cohorts', () => {
    expect(medianPickupDays([])).toBeNull();
    expect(medianPickupDays([4, 1])).toBe(3);
    expect(medianPickupDays([8, 1, 4])).toBe(4);
  });
  it('ignores attribution and fragments but preserves content identity', () => {
    expect(
      trackedUrlKey(
        'https://EXAMPLE.com:443/Page?z=2&id=7&utm_source=ai&fbclid=123#part',
      ),
    ).toBe('example.com/Page?id=7&z=2');
    for (const url of [
      'https://example.com/page?id=7',
      'https://www.example.com/Page?id=7',
      'https://example.com/Page/?id=7',
      'https://example.com/Page?id=8',
    ])
      expect(trackedUrlKey(url)).not.toBe(
        trackedUrlKey('https://example.com/Page?id=7'),
      );
    expect(trackedUrlKey('https://youtube.com/watch?v=abc&si=xyz')).toBe(
      'youtube.com/watch?v=abc',
    );
    expect(trackedUrlKey('https://[::1]:443/Page')).toBe('[::1]/Page');
    expect(trackedUrlKey(`https://example.com/${'א'.repeat(1100)}`)).toBeNull();
    for (const url of [
      'javascript:alert(1)',
      'file:///tmp/a',
      'https://u:p@example.com/',
      'invalid',
    ])
      expect(trackedUrlKey(url)).toBeNull();
  });
  it('counts annotations, company results and original captures separately', () => {
    const p = newProject({ id: 'counts', prompts: ['Which platform?'] }),
      s = sample(p, 'one', '2026-10-14T12:00:00Z');
    const m = citationMeasurement(s.result, s.run, s.answer, s.analysis)!;
    expect(m.evidence).toHaveLength(1);
    expect(m.evidence[0]).toMatchObject({
      nativeCount: 2,
      appearances: 6,
      resultKeys: ['northstar', 'another company'],
    });
    expect(m.evidence[0].citations).toHaveLength(2);
  });
  it('uses explicit UTC calendar ranges and rejects invalid dates', () => {
    expect(
      monitoringPeriod(
        new URLSearchParams('days=7'),
        new Date('2026-10-21T15:00:00Z'),
      ).start,
    ).toBe('2026-10-15T00:00:00.000Z');
    expect(
      monitoringPeriod(
        new URLSearchParams('days=custom&start=2026-10-21&end=2026-10-21'),
        new Date(),
      ).granularity,
    ).toBe('hourly');
    expect(() =>
      monitoringPeriod(
        new URLSearchParams('days=custom&start=2026-02-30&end=2026-03-01'),
        new Date(),
      ),
    ).toThrow();
  });
});
it.each(['memory', 'postgres'])(
  'persists scan matches, deduplicates retries and reanalysis, and serves period-wide mentions (%s)',
  async (backend) => {
    const db = backend === 'postgres' ? await localPostgres() : undefined;
    let repository: Repository = db
      ? new PostgresRepository(db)
      : new MemoryRepository();
    const artifacts = new MemoryArtifacts();
    try {
      const project = newProject({
        id: `tracking-${backend}`,
        prompts: ['Which platform?'],
      });
      project.scanProviders = [
        { provider: 'openai', model: 'test' },
        { provider: 'gemini', model: 'test' },
      ];
      await repository.saveProject(project, null);
      for (const who of ['owner', 'viewer', 'outsider'])
        await repository.syncUser(testIdentity(who));
      for (const role of ['owner', 'viewer'] as const)
        await repository.putMembership({
          projectId: project.id,
          userId: role,
          role,
        });
      let now = new Date('2026-10-10T00:00:00.000Z');
      const api = () =>
        createApi(
          { repository, artifacts, queue: new MemoryQueue() },
          { mode: 'live', now: () => now },
        );
      const call = (
        tail: string,
        method = 'GET',
        body?: unknown,
        who = 'owner',
      ) =>
        api()(
          new Request(`http://test/v1/projects/${project.id}/${tail}`, {
            method,
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
          testIdentity(who),
        );
      const added = await call('tracked-urls', 'POST', {
        url: 'https://example.com/Page?id=7',
      });
      expect(added.status).toBe(201);
      const tracked = (await added.json()) as TrackedUrl;
      expect(
        (
          await call('tracked-urls', 'POST', {
            url: 'https://example.com/Page?id=7&utm_campaign=hello',
          })
        ).status,
      ).toBe(201);
      expect(await repository.listTrackedUrls(project.id)).toHaveLength(1);
      expect(
        (
          await call(
            'tracked-urls',
            'POST',
            { url: 'https://example.com/other' },
            'viewer',
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call('tracked-urls', 'POST', {
            url: 'https://user:pass@example.com/',
          })
        ).status,
      ).toBe(400);
      const samples = [
        sample(project, 'a', '2026-10-14T12:00:00.000Z'),
        sample(project, 'b', '2026-10-20T12:00:00.000Z'),
        sample(project, 'c', '2026-10-20T13:00:00.000Z'),
        sample(project, 'd', '2026-10-20T14:00:00.000Z', 'gemini'),
      ];
      async function save(s: ReturnType<typeof sample>) {
        await repository.createRun(s.run, [s.result]);
        await artifacts.put(s.result.captureKey!, s.answer);
        await artifacts.put(s.result.analysisKey!, s.analysis);
        await repository.saveMeasurement(s.result, s.run, s.answer, s.analysis);
      }
      for (const s of samples) await save(s);
      const a = samples[0];
      await Promise.all([
        repository.saveMeasurement(a.result, a.run, a.answer, a.analysis),
        repository.saveMeasurement(a.result, a.run, a.answer, a.analysis),
      ]);
      const re = {
        ...a,
        run: {
          ...a.run,
          id: 'reanalysis',
          reanalysisOf: a.run.id,
          createdAt: '2026-10-21T10:00:00.000Z',
        },
        result: {
          ...a.result,
          runId: 'reanalysis',
          responseId: `reanalysis~${a.result.promptId}`,
        },
      };
      await save(re);
      await repository.saveMeasurement(a.result, a.run, a.answer, a.analysis);
      if (db) repository = new PostgresRepository(db);
      const matches = await repository.listTrackingMatches(project.id);
      expect(matches).toHaveLength(4);
      expect(matches.reduce((n, m) => n + m.evidence.appearances, 0)).toBe(24);
      expect(
        matches.find(
          (m) => m.capture.captureKey === `openai:${a.result.captureKey}`,
        )?.capture.responseId,
      ).toBe(re.result.responseId);
      if (db)
        expect(
          (
            await db.query(
              'SELECT total_appearances_after_implementation AS count FROM tracked_recommendations WHERE id=$1',
              [tracked.id],
            )
          ).rows[0].count,
        ).toBe(24);
      expect(await repository.listTrackingMatches('other')).toEqual([]);
      now = new Date('2026-10-21T23:00:00.000Z');
      const params = 'days=custom&start=2026-10-10&end=2026-10-21';
      const mentions = await call(`mentions?${params}`);
      expect(mentions.status).toBe(200);
      const m = await mentions.json();
      expect(m.total).toBe(4);
      expect(m.items[0].answerPreview).toContain('**Northstar**');
      expect(m.items[0].citationCount).toBe(2);
      const summary = await (await call(`mentions/summary?${params}`)).json();
      expect(summary.total).toBe(4);
      expect(
        summary.providers.find((p: any) => p.provider === 'openai'),
      ).toMatchObject({ count: 3, share: 75, change: 100 });
      expect(
        summary.providers
          .find((p: any) => p.provider === 'openai')
          .points.some((p: any) => p.date === '2026-10-15'),
      ).toBe(false);
      expect(
        (await (await call(`mentions?${params}&providers=gemini`)).json())
          .total,
      ).toBe(1);
      expect(
        (await (await call(`mentions?${params}&tag=Other`)).json()).total,
      ).toBe(0);
      expect(
        (await (await call(`mentions?${params}&region=IT`)).json()).total,
      ).toBe(0);
      const detail = await (
        await call(`tracked-urls/${tracked.id}?${params}`)
      ).json();
      expect(detail.row).toMatchObject({
        appearances: 24,
        matchingAnswers: 4,
        matchingResults: 8,
        nativeCitations: 8,
        daysToFirstCitation: 5,
        status: 'cited',
      });
      expect(
        (
          await (
            await call(`tracked-urls/${tracked.id}/answers?${params}`)
          ).json()
        ).total,
      ).toBe(4);
      for (const tail of [
        'tracked-urls',
        'mentions',
        `tracked-urls/${tracked.id}`,
      ])
        expect((await call(tail, 'GET', undefined, 'outsider')).status).toBe(
          404,
        );
      for (const bad of [
        'days=bad',
        'page=-1',
        'pageSize=101',
        'providers=invalid',
        'days=custom&start=2026-10-22&end=2026-10-01',
      ])
        expect((await call(`mentions?${bad}`)).status).toBe(400);
      expect(
        (
          await call(`tracked-urls/${tracked.id}`, 'PATCH', {
            version: 1,
            active: false,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call(`tracked-urls/${tracked.id}`, 'PATCH', {
            version: 1,
            active: true,
          })
        ).status,
      ).toBe(409);
      await save(sample(project, 'paused', '2026-10-21T23:30:00.000Z'));
      expect(await repository.listTrackingMatches(project.id)).toHaveLength(4);
      now = new Date('2026-10-22T00:00:00.000Z');
      expect(
        (
          await call(`tracked-urls/${tracked.id}`, 'PATCH', {
            version: 2,
            active: true,
          })
        ).status,
      ).toBe(200);
      await save(sample(project, 'resumed', '2026-10-22T01:00:00.000Z'));
      expect(await repository.listTrackingMatches(project.id)).toHaveLength(5);
      // Reconciliation after resuming must still exclude the paused interval.
      const paused = sample(project, 'paused', '2026-10-21T23:30:00.000Z');
      await repository.saveMeasurement(
        paused.result,
        paused.run,
        paused.answer,
        paused.analysis,
      );
      expect(await repository.listTrackingMatches(project.id)).toHaveLength(5);
      // Consulted/search-result candidates never become tracking evidence.
      const consulted = await call('tracked-urls', 'POST', {
        url: 'https://example.com/consulted-only',
      });
      expect(consulted.status).toBe(201);
      await save(sample(project, 'after', '2026-10-22T15:00:00.000Z'));
      expect(
        await repository.listTrackingMatches(
          project.id,
          (await consulted.json()).id,
        ),
      ).toEqual([]);
      const final = (await repository.listTrackedUrls(project.id)).find(
        (u) => u.id === tracked.id,
      )!;
      const rows = trackingRows(
        [final],
        await repository.listTrackingMatches(project.id, tracked.id),
        {
          start: '2026-11-01T00:00:00Z',
          end: '2026-11-30T23:59:59Z',
          granularity: 'daily',
          timezone: 'UTC',
        },
        new Date('2026-12-01T00:00:00Z'),
      );
      expect(rows[0]).toMatchObject({ status: 'lost', matchingAnswers: 0 });
      const before = await repository.listTrackingMatches(project.id);
      const rebuilt = await backfillTracking(
        { repository, artifacts },
        project.id,
        '2026-10-10',
        '2026-10-22',
      );
      expect(rebuilt.missing).toBe(0);
      expect(await repository.listTrackingMatches(project.id)).toEqual(before);
      // A new analysis corrects derived counts for a capture; it never adds a capture.
      const correction = {
        ...a,
        run: {
          ...a.run,
          id: 'corrected',
          createdAt: '2026-10-23T00:00:00.000Z',
          reanalysisOf: a.run.id,
        },
        result: {
          ...a.result,
          runId: 'corrected',
          responseId: `corrected~${a.result.promptId}`,
        },
        analysis: { ...a.analysis, companies: [] },
      };
      await save(correction);
      const corrected = await repository.listTrackingMatches(project.id);
      expect(corrected).toHaveLength(before.length);
      expect(corrected.reduce((n, m) => n + m.evidence.appearances, 0)).toBe(
        before.reduce((n, m) => n + m.evidence.appearances, 0) - 2,
      );
      const failed = sample(project, 'failed-run', '2026-10-22T16:00:00.000Z');
      failed.run.status = 'failed';
      await save(failed);
      expect(await repository.listTrackingMatches(project.id)).toEqual(
        corrected,
      );
      if (db)
        expect(
          (
            await db.query(
              'SELECT total_appearances_after_implementation AS count FROM tracked_recommendations WHERE id=$1',
              [tracked.id],
            )
          ).rows[0].count,
        ).toBe(corrected.reduce((n, m) => n + m.evidence.appearances, 0));
    } finally {
      await db?.close();
    }
  },
  30000,
);

it('checks tracked URLs through the real scan finalizer and survives reconciliation', async () => {
  const db = await localPostgres(),
    repository = new PostgresRepository(db),
    artifacts = new MemoryArtifacts(),
    queue = new MemoryQueue();
  try {
    const at = '2026-10-21T12:00:00.000Z',
      project = newProject({
        id: 'scan-tracking',
        prompts: ['Which platform?'],
      });
    await repository.saveProject(project, null);
    const url: TrackedUrl = {
      id: 'f88c9a89-27db-40ce-b705-b029730aebaf',
      projectId: project.id,
      url: 'https://example.com/Page?id=7',
      normalizedUrl: 'example.com/Page?id=7',
      title: 'Page',
      contentType: 'WEBSITE',
      active: true,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      publishedAt: '2026-10-20T00:00:00.000Z',
      version: 1,
    };
    await repository.registerTrackedUrl(url);
    const fixture = sample(project, 'scan', at);
    const scanner = new Scanner({
      repository,
      artifacts,
      queue,
      now: () => new Date(at),
      provider: {
        collect: async () => fixture.answer,
        extract: async () => fixture.analysis,
      },
    });
    await scanner.handle({
      kind: 'kickoff',
      projectId: project.id,
      scheduledAt: at,
      trigger: 'manual',
    });
    while (queue.messages.length) await scanner.handle(queue.messages.shift()!);
    const matches = await repository.listTrackingMatches(project.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].evidence).toMatchObject({
      nativeCount: 2,
      appearances: 6,
    });
    expect(
      (
        await db.query(
          'SELECT total_appearances_after_implementation AS count FROM tracked_recommendations WHERE id=$1',
          [url.id],
        )
      ).rows[0].count,
    ).toBe(6);
    const run = await repository.getRun(project.id, matches[0].capture.runId);
    expect(run?.status).toBe('completed');
    await scanner.finalize(project.id, run!.id);
    expect(await repository.listTrackingMatches(project.id)).toEqual(matches);
    // Simulate a pre-migration account: replay only the stored evidence.
    await db.query(
      'DELETE FROM citevia_citation_captures WHERE project_id=$1',
      [project.id],
    );
    expect(await repository.listTrackingMatches(project.id)).toHaveLength(0);
    expect(
      await backfillTracking(
        { repository, artifacts },
        project.id,
        '2026-10-21',
        '2026-10-21',
      ),
    ).toEqual({ processed: 1, missing: 0 });
    expect(await repository.listTrackingMatches(project.id)).toEqual(matches);
  } finally {
    await db.close();
  }
}, 30000);
