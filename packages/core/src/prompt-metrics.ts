import type {
  Project,
  Prompt,
  PromptResult,
  ScanProvider,
  ScanRun,
} from './types.js';
import { sameTargetMethod } from './metrics.js';
import { brandRank, brandSentimentScore } from './scoring.js';
import { projectProviders, snapshotProvider } from './providers.js';

export interface PromptMetricComparison {
  mode: 'previous_period' | 'first_last_day';
  baseline: { start: string; end: string; measurementCount: number };
  current: { start: string; end: string; measurementCount: number };
  providers: ScanProvider[];
}
export interface PromptMetricsRow extends Prompt {
  regions: string[];
  language: string;
  avgVisibility: number | null;
  avgRank: number | null;
  avgSentimentScore: number | null;
  visibilityChange: number | null;
  rankChange: number | null;
  sentimentChange: number | null;
  measurementCount: number;
  previousMeasurementCount: number;
  rankCount: number;
  sentimentCount: number;
  responseId: string | null;
  comparison: PromptMetricComparison | null;
}
export interface PromptHistory {
  runs: ScanRun[];
  results: PromptResult[];
}
export interface PromptMetricsResponse {
  items: PromptMetricsRow[];
  period: {
    start: string;
    end: string;
    previousStart: string;
    previousEnd: string;
  };
  provider: ScanProvider | null;
  usage: { active: number; limit: number };
}

export function matchesPromptMethod(project: Project, run: ScanRun) {
  return (
    run.projectId === project.id &&
    !run.reportingExcludedAt &&
    sameTargetMethod(run.snapshot, {
      ...run.snapshot,
      brand: project.brand,
      competitors: project.competitors,
      parserVersion: project.parserVersion,
      extractionModel: project.extractionModel,
      country: project.country,
      language: project.language,
      generationModel:
        projectProviders(project).find(
          (config) => config.provider === snapshotProvider(run.snapshot),
        )?.model || '',
    })
  );
}

/** iGEO percentage convention: zero to positive is +100%; zero to zero is 0%. */
export function promptMetricChange(
  current: number | null,
  previous: number | null,
  invert = false,
) {
  if (
    current === null ||
    previous === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  )
    return null;
  if (previous === 0) return invert ? null : current > 0 ? 100 : 0;
  return (
    Math.round(
      (10000 * (invert ? previous - current : current - previous)) / previous,
    ) / 100
  );
}

function aggregate(rows: PromptResult[]) {
  const measured = rows.filter(
    (row) => row.status === 'succeeded' && row.target,
  );
  const ranks = measured
    .map((row) => brandRank(row.target))
    .filter((value): value is number => value !== null);
  const sentiments = measured
    .map((row) => brandSentimentScore(row.target))
    .filter((value): value is number => value !== null);
  return {
    // iGEO rounds visibility and sentiment before calculating their deltas.
    avgVisibility: measured.length
      ? Math.round(
          (100 * measured.filter((row) => row.target!.mentioned).length) /
            measured.length,
        )
      : null,
    avgRank: ranks.length
      ? ranks.reduce((sum, value) => sum + value, 0) / ranks.length
      : null,
    avgSentimentScore: sentiments.length
      ? Math.round(
          sentiments.reduce((sum, value) => sum + value, 0) / sentiments.length,
        )
      : null,
    measurementCount: measured.length,
    rankCount: ranks.length,
    sentimentCount: sentiments.length,
    responseId: measured[0]?.responseId || null,
  };
}
function metricRow(
  project: Project,
  prompt: Prompt,
  rows: PromptResult[],
  prior: PromptResult[],
  comparison: {
    current: PromptResult[];
    previous: PromptResult[];
    metadata: PromptMetricComparison;
  } | null = null,
): PromptMetricsRow {
  const current = aggregate(rows),
    previous = aggregate(prior);
  const comparedCurrent = comparison ? aggregate(comparison.current) : current,
    comparedPrevious = comparison ? aggregate(comparison.previous) : previous;
  // Day comparisons pair one answer per provider. Unknown rank/sentiment on one
  // side must not change the provider mix used for that particular score.
  const comparableScore = (score: typeof brandRank) => {
    if (comparison?.metadata.mode !== 'first_last_day') return null;
    const indexes = comparison.current.flatMap((row, index) =>
      score(row.target) !== null &&
      score(comparison.previous[index].target) !== null
        ? [index]
        : [],
    );
    return {
      current: aggregate(indexes.map((index) => comparison.current[index])),
      previous: aggregate(indexes.map((index) => comparison.previous[index])),
    };
  };
  const ranks = comparableScore(brandRank),
    sentiments = comparableScore(brandSentimentScore);
  return {
    ...prompt,
    regions: [project.country],
    language: project.language,
    ...current,
    previousMeasurementCount: previous.measurementCount,
    comparison: comparison?.metadata || null,
    visibilityChange: promptMetricChange(
      comparedCurrent.avgVisibility,
      comparedPrevious.avgVisibility,
    ),
    sentimentChange: promptMetricChange(
      (sentiments?.current || comparedCurrent).avgSentimentScore,
      (sentiments?.previous || comparedPrevious).avgSentimentScore,
    ),
    rankChange: promptMetricChange(
      (ranks?.current || comparedCurrent).avgRank,
      (ranks?.previous || comparedPrevious).avgRank,
      true,
    ),
  };
}
function matchesPrompt(prompt: Prompt, row: PromptResult) {
  return (
    row.promptId === prompt.id &&
    row.prompt.version === prompt.version &&
    row.prompt.text === prompt.text
  );
}

/** Backwards-compatible single-scan endpoint for existing consumers. */
export function promptMetrics(
  project: Project,
  run: ScanRun | null,
  results: PromptResult[],
  previousRun: ScanRun | null = null,
  previousResults: PromptResult[] = [],
): PromptMetricsRow[] {
  if (run && !matchesPromptMethod(project, run)) run = null;
  const comparable =
    run &&
    previousRun &&
    !previousRun.reportingExcludedAt &&
    previousRun.projectId === project.id &&
    sameTargetMethod(run.snapshot, previousRun.snapshot);
  return project.prompts.map((prompt) =>
    metricRow(
      project,
      prompt,
      run
        ? results.filter(
            (row) =>
              row.runId === run.id &&
              row.projectId === project.id &&
              matchesPrompt(prompt, row),
          )
        : [],
      comparable
        ? previousResults.filter(
            (row) =>
              row.runId === previousRun.id &&
              row.projectId === project.id &&
              matchesPrompt(prompt, row),
          )
        : [],
    ),
  );
}

/** Timestamp of the original answer, so reanalysis never moves an observation to another week. */
export function promptMeasuredAt(result: PromptResult, run: ScanRun) {
  return result.capturedAt || run.createdAt;
}

function firstLastDayComparison(
  rows: PromptResult[],
  runs: Map<string, ScanRun>,
) {
  const byDay = new Map<string, Map<ScanProvider, PromptResult>>();
  // Rows are newest first, so a repeated scan on one day cannot give a provider
  // extra weight in the change. The headline still averages the whole period.
  for (const row of rows) {
    const run = runs.get(row.runId)!,
      day = new Date(promptMeasuredAt(row, run)).toISOString().slice(0, 10),
      provider = snapshotProvider(run.snapshot);
    const providers = byDay.get(day) || new Map<ScanProvider, PromptResult>();
    if (!providers.has(provider)) providers.set(provider, row);
    byDay.set(day, providers);
  }
  const days = [...byDay.keys()].sort();
  if (days.length < 2) return null;
  const first = days[0],
    last = days[days.length - 1],
    baseline = byDay.get(first)!,
    current = byDay.get(last)!;
  const providers = [...baseline.keys()]
    .filter((provider) => current.has(provider))
    .sort();
  if (!providers.length) return null;
  return {
    current: providers.map((provider) => current.get(provider)!),
    previous: providers.map((provider) => baseline.get(provider)!),
    metadata: {
      mode: 'first_last_day' as const,
      baseline: { start: first, end: first, measurementCount: providers.length },
      current: { start: last, end: last, measurementCount: providers.length },
      providers,
    },
  };
}

export function promptPeriodMetrics(
  project: Project,
  history: PromptHistory,
  start: string,
  end: string,
  provider?: ScanProvider,
): PromptMetricsResponse {
  const startMs = Date.parse(start),
    endMs = Date.parse(end);
  // Inclusive millisecond boundaries give disjoint, exactly equal windows.
  const previousStartMs = startMs - (endMs - startMs + 1);
  const runs = new Map(
    history.runs
      .filter(
        (run) =>
          matchesPromptMethod(project, run) &&
          (!provider || snapshotProvider(run.snapshot) === provider),
      )
      .map((run) => [run.id, run]),
  );
  const candidates = history.results
    .filter(
      (row) =>
        row.projectId === project.id &&
        runs.has(row.runId) &&
        row.status === 'succeeded' &&
        row.target,
    )
    .sort((a, b) =>
      runs.get(b.runId)!.createdAt.localeCompare(runs.get(a.runId)!.createdAt),
    );
  // A saved answer may be reanalyzed several times. Count its latest compatible successful analysis once.
  const seen = new Set<string>();
  const measured = candidates
    .filter((row) => {
      const run = runs.get(row.runId)!;
      const key = `${snapshotProvider(run.snapshot)}:${row.promptId}:${row.captureKey || row.responseId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      promptMeasuredAt(b, runs.get(b.runId)!).localeCompare(
        promptMeasuredAt(a, runs.get(a.runId)!),
      ),
    );
  return {
    items: project.prompts.map((prompt) => {
      const rows = measured.filter((row) => matchesPrompt(prompt, row));
      const inWindow = (row: PromptResult, from: number, to: number) => {
        const timestamp = Date.parse(
          promptMeasuredAt(row, runs.get(row.runId)!),
        );
        return timestamp >= from && timestamp <= to;
      };
      const current = rows.filter((row) => inWindow(row, startMs, endMs)),
        previous = rows.filter((row) =>
          inWindow(row, previousStartMs, startMs - 1),
        );
      const comparison = previous.length
        ? {
            current,
            previous,
            metadata: {
              mode: 'previous_period' as const,
              baseline: {
                start: new Date(previousStartMs).toISOString(),
                end: new Date(startMs - 1).toISOString(),
                measurementCount: previous.length,
              },
              current: { start, end, measurementCount: current.length },
              providers: [
                ...new Set(
                  [...current, ...previous].map((row) =>
                    snapshotProvider(runs.get(row.runId)!.snapshot),
                  ),
                ),
              ].sort(),
            },
          }
        : firstLastDayComparison(current, runs);
      return metricRow(project, prompt, current, previous, comparison);
    }),
    period: {
      start,
      end,
      previousStart: new Date(previousStartMs).toISOString(),
      previousEnd: new Date(startMs - 1).toISOString(),
    },
    provider: provider || null,
    usage: {
      active: project.prompts.filter((prompt) => prompt.active).length,
      limit: 50,
    },
  };
}
