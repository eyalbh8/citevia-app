import {
  aggregateDashboardOverview,
  dashboardObservations,
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
  history.runs = history.runs.filter((run) =>
    ['completed', 'partial'].includes(run.status),
  );
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
  return new Response(
    JSON.stringify(
      aggregateDashboardOverview(
        project,
        period,
        filters,
        await historicalCompetitorMentions(runtime, project, observations),
      ),
    ),
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
