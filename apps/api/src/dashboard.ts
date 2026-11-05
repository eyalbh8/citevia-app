import {
  aggregateDashboardOverview,
  dashboardObservations,
  isReportableRun,
  matchesMonitoringFilters,
  snapshotProvider,
  type CapturedAnswer,
  type Project,
} from '@citevia/core';
import { AccessError, type Runtime } from '@citevia/storage';
import { filtersFor, monitoringPeriod } from './monitoring.js';
import { promptAnswers } from './prompt-answers.js';
import { historicalCompetitorMentions } from './competitors.js';

/** This period projection is separate from the retained single-scan dashboard API. */
export async function dashboardOverviewRoute(
  runtime: Runtime,
  project: Project,
  request: Request,
  now: Date,
) {
  if (request.method !== 'GET')
    throw new AccessError(405, 'DASHBOARD_REQUEST', 'Method not allowed.');
  const query = new URL(request.url).searchParams;
  const period = monitoringPeriod(query, now);
  const filters = {
    ...filtersFor(query, project),
    topic: query.get('topic') || '',
  };
  const history = await runtime.repository.listPromptHistory(
    project.id,
    period.start,
    period.end,
  );
  const scanInProgress = history.runs.some(
    (run) =>
      !run.cancelledAt && !run.reportingExcludedAt &&
      ['queued', 'running'].includes(run.status) &&
      run.snapshot.prompts.some(
        (prompt) =>
          matchesMonitoringFilters(prompt, snapshotProvider(run.snapshot), run.snapshot.country, filters) &&
          (!filters.topic || prompt.topic === filters.topic),
      ),
  );
  history.runs = history.runs.filter(isReportableRun);
  const observations = dashboardObservations(
    project,
    period,
    filters,
    promptAnswers(history, project.id, undefined, undefined, 'date', 'asc'),
  );
  const captureKeyFor = (item: (typeof observations)[number]) =>
    `${snapshotProvider(item.run.snapshot)}:${item.result.captureKey}`;
  // The capture index retains native annotations separately from company appearances.
  // An indexed capture with no annotations is authoritative, so it never needs S3.
  const indexed = new Map(
    (
      await runtime.repository.listNativeCitations(
        project.id,
        observations
          .filter((item) => item.result.captureKey)
          .map(captureKeyFor),
      )
    ).map((item) => [item.captureKey, item.citations]),
  );
  const legacy = observations.filter((item) => {
    const citations = indexed.get(captureKeyFor(item));
    if (citations !== undefined) {
      item.answer = { citations };
      return false;
    }
    return !!item.result.captureKey && item.result.citationCount > 0;
  });
  // Older captures can predate indexing. Preserve them with bounded fallback reads.
  for (let index = 0; index < legacy.length; index += 10) {
    await Promise.all(
      legacy.slice(index, index + 10).map(async (item) => {
        const answer = await runtime.artifacts.get<CapturedAnswer>(
          item.result.captureKey!,
        );
        item.answer = answer ? { citations: answer.citations } : null;
      }),
    );
  }
  const report = aggregateDashboardOverview(project, period, filters,
    await historicalCompetitorMentions(runtime, project, observations));
  if (project.demo?.dashboardComparison === 'scenario_start' && !project.demo.presentation && observations.length) {
    const baselineStart = `${project.demo.startDate}T00:00:00.000Z`;
    const baselineEnd = new Date(Math.min(Date.parse(period.end), Date.parse(baselineStart) + 7 * 86400000)).toISOString();
    const baselineHistory = await runtime.repository.listPromptHistory(project.id, baselineStart, baselineEnd);
    const baselineRows = promptAnswers(baselineHistory, project.id, undefined, undefined, 'date', 'asc');
    const baselinePeriod = { ...period, start: baselineStart, end: baselineEnd };
    const eligible = dashboardObservations(project, baselinePeriod, filters, baselineRows);
    const first = eligible.map(row => row.result.capturedAt!.slice(0, 10)).sort()[0];
    const last = observations.map(row => row.result.capturedAt!.slice(0, 10)).sort().at(-1)!;
    if (first && first < last) {
      const onDay = (date: string, rows: typeof observations) => aggregateDashboardOverview(project,
        { ...period, start: `${date}T00:00:00.000Z`, end: `${date}T23:59:59.999Z` }, filters, rows);
      const baseline = onDay(first, eligible), latest = onDay(last, observations);
      const growth = (before: number, after: number) => Number((before ? (after - before) * 100 / before : after ? 100 : 0).toFixed(2));
      report.providers = report.providers.map(row => ({ ...row, change: growth(
        baseline.providers.find(item => item.provider === row.provider)?.count || 0,
        latest.providers.find(item => item.provider === row.provider)?.count || 0) }));
      report.stages = report.stages.map(row => ({ ...row, visibilityChange: growth(
        baseline.stages.find(item => item.key === row.key)?.visibility || 0,
        latest.stages.find(item => item.key === row.key)?.visibility || 0) }));
      const difference = (before: number | null | undefined, after: number | null | undefined) =>
        before == null || after == null ? null : Number((after - before).toFixed(1));
      report.ranking = report.ranking.map(row => {
        const previous = baseline.ranking.find(item => item.brandId === row.brandId);
        const current = latest.ranking.find(item => item.brandId === row.brandId);
        return { ...row, mentionChange: growth(previous?.mentions || 0, current?.mentions || 0),
          rankChange: difference(current?.rank, previous?.rank),
          sentimentChange: difference(previous?.sentiment, current?.sentiment) };
      });
      report.comparison = 'scenario_baseline';
      report.comparisonPeriod = { start: `${first}T00:00:00.000Z`, end: `${last}T23:59:59.999Z` };
    }
  }
  return new Response(
    JSON.stringify({
      ...report,
      scanInProgress,
    }),
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
