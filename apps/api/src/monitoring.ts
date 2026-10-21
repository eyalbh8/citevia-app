import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  brandRank,
  brandSentimentScore,
  reportingCompanies,
  snapshotProvider,
  projectProviders,
  trackedUrlKey,
  trackedUrlMetadata,
  trackingRows,
  trackingPeriodsAfter,
  medianPickupDays,
  matchesMonitoringFilters,
  JOURNEY_STAGES,
  type Project,
  type PromptResult,
  type ScanRun,
  type Analysis,
  type CapturedAnswer,
  type MentionAnswer,
  type MentionsSummary,
  type MonitoringFilters,
  type MonitoringPeriod,
  type TrackingDetail,
  type TrackingSummary,
} from '@citevia/core';
import { AccessError, type Runtime } from '@citevia/storage';
import {
  ANSWER_SORTS,
  promptAnswers,
  type AnswerSort,
} from './prompt-answers.js';
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
const fail = (message: string, status = 400): never => {
  throw new AccessError(status, 'MONITORING_REQUEST', message);
};
export function monitoringPeriod(
  query: URLSearchParams,
  now: Date,
): MonitoringPeriod {
  const days = query.get('days') || '7';
  if (!['1', '7', '14', '30', '90', 'custom'].includes(days))
    return fail('Choose 24 hours, 7, 14, 30, 90 days or a custom range.');
  let start: Date, end: Date;
  if (days === 'custom') {
    const a = query.get('start') || '',
      b = query.get('end') || '';
    if (![a, b].every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)))
      return fail('Choose both start and end dates.');
    start = new Date(`${a}T00:00:00.000Z`);
    end = new Date(`${b}T23:59:59.999Z`);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start.toISOString().slice(0, 10) !== a ||
      end.toISOString().slice(0, 10) !== b
    )
      return fail('Invalid dates.');
  } else {
    end = new Date(now);
    if (days === '1') start = new Date(end.getTime() - 86400000 + 1);
    else {
      start = new Date(end);
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - Number(days) + 1);
    }
  }
  if (start > end || end.getTime() - start.getTime() > 366 * 86400000)
    return fail('Choose a date range of up to 366 days.');
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    granularity:
      end.getTime() - start.getTime() < 86400000 ? 'hourly' : 'daily',
    timezone: 'UTC',
  };
}
export function filtersFor(
  q: URLSearchParams,
  project: Project,
): MonitoringFilters {
  const supported = projectProviders(project).map((p) => p.provider);
  const providers = [
    ...new Set((q.get('providers') || '').split(',').filter(Boolean)),
  ];
  if (
    providers.some((p) => !supported.includes(p as (typeof supported)[number]))
  )
    fail('Choose an enabled provider.');
  const branded = q.get('branded') || '';
  if (branded && !['true', 'false'].includes(branded))
    fail('Invalid branded filter.');
  const stage = q.get('stage') || '';
  if (
    stage &&
    !JOURNEY_STAGES.includes(stage as (typeof JOURNEY_STAGES)[number])
  )
    fail('Choose Understand, Prefer, Trust or Convert.');
  return {
    providers: (providers.length
      ? providers
      : supported) as MonitoringFilters['providers'],
    region: q.get('region') || '',
    tag: q.get('tag') || '',
    branded,
    intent: q.get('intent') || '',
    stage: stage as MonitoringFilters['stage'],
    search: q.get('q') || '',
  };
}
function paginate<T>(items: T[], q: URLSearchParams) {
  const page = Number(q.get('page') || 0),
    pageSize = Number(q.get('pageSize') || 25);
  if (
    !Number.isSafeInteger(page) ||
    page < 0 ||
    ![25, 50, 100].includes(pageSize)
  )
    fail('Invalid page or page size.');
  return {
    items: items.slice(page * pageSize, (page + 1) * pageSize),
    total: items.length,
    page,
    pageSize,
  };
}
async function answers(
  runtime: Runtime,
  items: { result: PromptResult; run: ScanRun }[],
): Promise<MentionAnswer[]> {
  const rows: MentionAnswer[] = [];
  for (let i = 0; i < items.length; i += 5)
    rows.push(
      ...(await Promise.all(
        items.slice(i, i + 5).map(async ({ result, run }) => {
          const [answer, analysis] = await Promise.all([
            result.captureKey
              ? runtime.artifacts.get<CapturedAnswer>(result.captureKey)
              : null,
            result.analysisKey
              ? runtime.artifacts.get<Analysis>(result.analysisKey)
              : null,
          ]);
          const companies = reportingCompanies(analysis, run.snapshot, answer);
          return {
            responseId: result.responseId,
            promptText: result.prompt.text,
            promptVersion: result.prompt.version,
            provider: snapshotProvider(run.snapshot),
            model:
              answer?.model || result.model || run.snapshot.generationModel,
            date: result.capturedAt || run.createdAt,
            country: run.snapshot.country,
            status: result.status,
            answerPreview: answer?.text.slice(0, 600) || null,
            visibility: result.target?.mentioned ? 100 : 0,
            rank: brandRank(result.target),
            sentimentScore: brandSentimentScore(result.target),
            brands: companies.map((c) => c.company),
            brandSites: companies.map((c) => ({
              name: c.company,
              url: c.company_site_url,
            })),
            citationCount: answer?.citations.length ?? result.citationCount,
          };
        }),
      )),
    );
  return rows;
}
export async function monitoringRoute(
  runtime: Runtime,
  project: Project,
  tail: string,
  request: Request,
  now: Date,
  readBody: (request: Request) => Promise<unknown>,
): Promise<Response | undefined> {
  if (
    !/^(mentions(?:\/summary)?|tracked-urls(?:\/[^/]+(?:\/answers)?)?)$/.test(
      tail,
    )
  )
    return undefined;
  const { repository } = runtime,
    q = new URL(request.url).searchParams,
    method = request.method;
  const period = monitoringPeriod(q, now),
    filters = filtersFor(q, project);
  if (tail === 'tracked-urls' && method === 'POST') {
    const input = z
      .object({ url: z.string().trim().min(1).max(2048) })
      .strict()
      .parse(await readBody(request));
    const normalizedUrl = trackedUrlKey(input.url);
    if (!normalizedUrl)
      fail(
        'Enter an HTTP or HTTPS URL without credentials, with an address up to 2,048 bytes.',
      );
    const at = now.toISOString();
    const saved = await repository.registerTrackedUrl({
      id: randomUUID(),
      projectId: project.id,
      url: input.url,
      normalizedUrl: normalizedUrl!,
      ...trackedUrlMetadata(input.url),
      createdAt: at,
      updatedAt: at,
      publishedAt: at,
      active: true,
      version: 1,
      trackingPeriods: [{ start: at, end: null }],
    });
    return json(saved, 201);
  }
  const trackedId = tail.split('/')[1];
  if (
    trackedId &&
    trackedId !== 'summary' &&
    !z.string().uuid().safeParse(trackedId).success
  )
    fail('Tracked URL not found.', 404);
  if (
    tail.startsWith('tracked-urls/') &&
    method === 'PATCH' &&
    !tail.endsWith('/answers') &&
    trackedId !== 'summary'
  ) {
    const input = z
      .object({
        version: z.number().int().positive(),
        active: z.boolean().optional(),
        title: z.string().trim().min(1).max(200).optional(),
      })
      .strict()
      .parse(await readBody(request));
    const current = (await repository.listTrackedUrls(project.id)).find(
      (u) => u.id === trackedId,
    );
    if (!current) fail('Tracked URL not found.', 404);
    const next = {
      ...current!,
      ...input,
      version: current!.version + 1,
      updatedAt: now.toISOString(),
      trackingPeriods: trackingPeriodsAfter(
        current!,
        input.active ?? current!.active,
        now.toISOString(),
      ),
    };
    if (!(await repository.updateTrackedUrl(next, input.version)))
      fail('This URL changed. Refresh before saving.', 409);
    return json(next);
  }
  if (method !== 'GET') fail('Method not allowed.', 405);
  if (tail === 'mentions' || tail === 'mentions/summary') {
    const history = await repository.listPromptHistory(
      project.id,
      period.start,
      period.end,
    );
    history.runs = history.runs.filter((r) =>
      ['completed', 'partial'].includes(r.status),
    );
    const sort = q.get('sort') || 'date',
      direction = q.get('direction') || 'desc';
    if (
      !ANSWER_SORTS.includes(sort as AnswerSort) ||
      !['asc', 'desc'].includes(direction)
    )
      fail('Invalid answer sort.');
    const observed = promptAnswers(
      history,
      project.id,
      undefined,
      undefined,
      sort as AnswerSort,
      direction as 'asc' | 'desc',
    ).filter(
      ({ result, run }) =>
        result.status === 'succeeded' &&
        matchesMonitoringFilters(
          result.prompt,
          snapshotProvider(run.snapshot),
          run.snapshot.country,
          filters,
        ),
    );
    const eligible = observed.filter(
      ({ result }) =>
        result.target?.mentioned && (brandRank(result.target) ?? 0) >= 1,
    );
    if (tail === 'mentions') {
      const page = paginate(eligible, q);
      return json({ ...page, items: await answers(runtime, page.items) });
    }
    const dates = new Map<string, Map<string, number>>(),
      daily = new Map<string, Map<string, number>>();
    for (const { result, run } of observed) {
      const provider = snapshotProvider(run.snapshot),
        at = result.capturedAt || run.createdAt;
      const date =
        period.granularity === 'hourly'
          ? `${at.slice(0, 13)}:00:00.000Z`
          : at.slice(0, 10);
      const series = dates.get(provider) || new Map();
      const days = daily.get(provider) || new Map();
      series.set(date, 0);
      days.set(at.slice(0, 10), 0);
      dates.set(provider, series);
      daily.set(provider, days);
    }
    for (const { result, run } of eligible) {
      const provider = snapshotProvider(run.snapshot),
        at = result.capturedAt || run.createdAt;
      const date =
        period.granularity === 'hourly'
          ? `${at.slice(0, 13)}:00:00.000Z`
          : at.slice(0, 10);
      const series = dates.get(provider) || new Map(),
        days = daily.get(provider) || new Map();
      series.set(date, (series.get(date) || 0) + 1);
      days.set(at.slice(0, 10), (days.get(at.slice(0, 10)) || 0) + 1);
      dates.set(provider, series);
      daily.set(provider, days);
    }
    const [urls, matches] = await Promise.all([
      repository.listTrackedUrls(project.id),
      repository.listTrackingMatches(project.id),
    ]);
    const markerGroups = new Map<
      string,
      MentionsSummary['markers'][number]['items']
    >();
    for (const url of urls.filter(
      (u) => u.createdAt >= period.start && u.createdAt <= period.end,
    )) {
      const relevant = matches.filter(
        (m) =>
          m.trackedUrlId === url.id &&
          m.capture.capturedAt >= period.start &&
          m.capture.capturedAt <= period.end &&
          matchesMonitoringFilters(
            m.capture.prompt,
            m.capture.provider,
            m.capture.country,
            filters,
          ),
      );
      const date =
          period.granularity === 'hourly'
            ? `${url.createdAt.slice(0, 13)}:00:00.000Z`
            : url.createdAt.slice(0, 10),
        list = markerGroups.get(date) || [];
      list.push({
        id: url.id,
        url: url.url,
        title: url.title,
        appearances: relevant.reduce(
          (sum, m) => sum + m.evidence.appearances,
          0,
        ),
      });
      markerGroups.set(date, list);
    }
    const summary: MentionsSummary = {
      period,
      total: eligible.length,
      comparison: 'first_to_last_observed_day',
      providers: filters.providers
        .map((provider) => {
          const points = [...(dates.get(provider) || [])]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, count]) => ({ date, count }));
          const days = [...(daily.get(provider) || [])].sort(([a], [b]) =>
            a.localeCompare(b),
          );
          const count = points.reduce((sum, p) => sum + p.count, 0),
            first = days[0]?.[1],
            last = days.at(-1)?.[1];
          return {
            provider,
            count,
            share: eligible.length
              ? Math.round((count / eligible.length) * 10000) / 100
              : 0,
            change:
              first === undefined || last === undefined
                ? null
                : first
                  ? Math.round(((last - first) / first) * 10000) / 100
                  : last
                    ? 100
                    : 0,
            points,
          };
        })
        .sort((a, b) => b.count - a.count),
      markers: [...markerGroups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, items]) => ({ date, items })),
    };
    return json(summary);
  }
  const [urls, allMatches] = await Promise.all([
    repository.listTrackedUrls(project.id),
    repository.listTrackingMatches(
      project.id,
      trackedId && trackedId !== 'summary' ? trackedId : undefined,
    ),
  ]);
  const scoped = allMatches.filter((m) =>
    matchesMonitoringFilters(
      m.capture.prompt,
      m.capture.provider,
      m.capture.country,
      { ...filters, search: '' },
    ),
  );
  const rows = trackingRows(urls, scoped, period, now);
  if (tail === 'tracked-urls/summary') {
    const chosen = rows.filter(
      (row) =>
        row.active &&
        row.publishedAt >= period.start &&
        row.publishedAt <= period.end,
    );
    const month = now.toISOString().slice(0, 7),
      ids = new Set(chosen.map((row) => row.id));
    const history = await repository.listPromptHistory(
      project.id,
      new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1),
      ).toISOString(),
      now.toISOString(),
    );
    history.runs = history.runs.filter((r) =>
      ['completed', 'partial'].includes(r.status),
    );
    const mentions = promptAnswers(
      history,
      project.id,
      undefined,
      undefined,
      'date',
      'asc',
    ).filter(
      ({ result, run }) =>
        result.status === 'succeeded' &&
        result.target?.mentioned &&
        (brandRank(result.target) ?? 0) >= 1 &&
        matchesMonitoringFilters(
          result.prompt,
          snapshotProvider(run.snapshot),
          run.snapshot.country,
          { ...filters, search: '' },
        ),
    );
    const summary: TrackingSummary = {
      trackedCount: chosen.length,
      trackedThisMonth: urls.filter(
        (u) => u.active && u.createdAt.startsWith(month),
      ).length,
      appearances: chosen.reduce((n, r) => n + r.appearances, 0),
      citedCount: chosen.filter((r) => r.firstCitedAt).length,
      citedRate: chosen.length
        ? Math.round(
            (chosen.filter((r) => r.firstCitedAt).length / chosen.length) * 100,
          )
        : 0,
      medianPickup: medianPickupDays(
        rows
          .filter(
            (r) =>
              r.firstCitedAt &&
              r.firstCitedAt >= period.start &&
              r.firstCitedAt <= period.end,
          )
          .flatMap((r) =>
            r.daysToFirstCitation === null ? [] : [r.daysToFirstCitation],
          ),
      ),
      clicks: null,
      series: Array.from({ length: 7 }, (_, i) => {
        const date = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6 + i, 1),
        )
          .toISOString()
          .slice(0, 7);
        return {
          date,
          citations: scoped
            .filter(
              (m) =>
                ids.has(m.trackedUrlId) &&
                m.capture.capturedAt.startsWith(date),
            )
            .reduce((n, m) => n + m.evidence.appearances, 0),
          mentions: mentions.filter((m) =>
            (m.result.capturedAt || m.run.createdAt).startsWith(date),
          ).length,
          published: urls.filter(
            (u) => u.active && u.publishedAt.startsWith(date),
          ).length,
        };
      }),
    };
    return json(summary);
  }
  if (tail === 'tracked-urls') {
    const status = q.get('status') || 'all',
      sort = q.get('sort') || 'newest';
    if (
      !['all', 'cited', 'uncited', 'attention', 'paused'].includes(status) ||
      !['cited', 'newest', 'fastest', 'az', 'lift'].includes(sort)
    )
      fail('Invalid tracking filter or sort.');
    const text = (q.get('q') || '').toLocaleLowerCase();
    const items = rows.filter(
      (r) =>
        (status === 'paused' ? !r.active : r.active) &&
        r.publishedAt >= period.start &&
        r.publishedAt <= period.end &&
        (!text || `${r.title} ${r.url}`.toLocaleLowerCase().includes(text)) &&
        (status === 'cited'
          ? r.status === 'cited'
          : status === 'uncited'
            ? !r.firstCitedAt
            : status === 'attention'
              ? ['lost', 'stale'].includes(r.status)
              : true),
    );
    items.sort(
      (a, b) =>
        (sort === 'cited'
          ? b.appearances - a.appearances
          : sort === 'fastest'
            ? (a.daysToFirstCitation ?? Infinity) -
              (b.daysToFirstCitation ?? Infinity)
            : sort === 'az'
              ? a.title.localeCompare(b.title)
              : b.publishedAt.localeCompare(a.publishedAt)) ||
        a.id.localeCompare(b.id),
    );
    return json({ ...paginate(items, q), period });
  }
  const row = rows.find((r) => r.id === trackedId);
  if (!row) fail('Tracked URL not found.', 404);
  const selected = scoped.filter(
    (m) =>
      m.trackedUrlId === trackedId &&
      m.capture.capturedAt >= period.start &&
      m.capture.capturedAt <= period.end,
  );
  if (tail.endsWith('/answers')) {
    const page = paginate(selected, q),
      pairs: { result: PromptResult; run: ScanRun }[] = [];
    for (const match of page.items) {
      const [result, run] = await Promise.all([
        repository.getResult(
          project.id,
          match.capture.runId,
          match.capture.promptId,
        ),
        repository.getRun(project.id, match.capture.runId),
      ]);
      if (result && run) pairs.push({ result, run });
    }
    return json({ ...page, items: await answers(runtime, pairs) });
  }
  const promptGroups = new Map<string, TrackingDetail['prompts'][number]>();
  for (const m of selected) {
    const key = `${m.capture.promptId}:${m.capture.provider}`,
      p = promptGroups.get(key) || {
        id: m.capture.promptId,
        text: m.capture.prompt.text,
        provider: m.capture.provider,
        answers: 0,
      };
    p.answers++;
    promptGroups.set(key, p);
  }
  const avg = (values: number[]) =>
    values.length
      ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) /
        10
      : null;
  const detail: TrackingDetail = {
    row: row!,
    period,
    avgPosition: avg(
      selected.flatMap((m) =>
        m.capture.rank === null ? [] : [m.capture.rank],
      ),
    ),
    sentimentScore: avg(
      selected.flatMap((m) =>
        m.capture.sentimentScore === null ? [] : [m.capture.sentimentScore],
      ),
    ),
    prompts: [...promptGroups.values()].sort((a, b) => b.answers - a.answers),
  };
  return json(detail);
}
