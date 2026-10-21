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
): PromptMetricsRow {
  const current = aggregate(rows),
    previous = aggregate(prior);
  return {
    ...prompt,
    regions: [project.country],
    language: project.language,
    ...current,
    previousMeasurementCount: previous.measurementCount,
    visibilityChange: promptMetricChange(
      current.avgVisibility,
      previous.avgVisibility,
    ),
    sentimentChange: promptMetricChange(
      current.avgSentimentScore,
      previous.avgSentimentScore,
    ),
    rankChange: promptMetricChange(current.avgRank, previous.avgRank, true),
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
      return metricRow(
        project,
        prompt,
        rows.filter((row) => inWindow(row, startMs, endMs)),
        rows.filter((row) => inWindow(row, previousStartMs, startMs - 1)),
      );
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
