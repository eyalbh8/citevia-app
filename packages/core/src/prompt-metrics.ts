import type { Project, Prompt, PromptResult, ScanRun } from './types.js';
import { sameMethod } from './metrics.js';
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
}
function measurement(
  prompt: Prompt,
  run: ScanRun | null,
  rows: PromptResult[],
) {
  const result = rows.find(
    (row) =>
      row.runId === run?.id &&
      row.projectId === run.projectId &&
      row.promptId === prompt.id &&
      row.prompt.version === prompt.version &&
      row.prompt.text === prompt.text,
  );
  const brand = result?.status === 'succeeded' ? result.target : undefined;
  return {
    avgVisibility: brand ? (brand.mentioned ? 100 : 0) : null,
    avgRank: brand ? brandRank(brand) : null,
    avgSentimentScore: brand ? brandSentimentScore(brand) : null,
  };
}
function change(
  current: number | null,
  previous: number | null,
  invert = false,
) {
  if (current === null || previous === null || previous === 0) return null;
  return (
    Math.round(
      (10000 * (invert ? previous - current : current - previous)) / previous,
    ) / 100
  );
}
export function promptMetrics(
  project: Project,
  run: ScanRun | null,
  results: PromptResult[],
  previousRun: ScanRun | null = null,
  previousResults: PromptResult[] = [],
): PromptMetricsRow[] {
  const provider = run ? snapshotProvider(run.snapshot) : null;
  if (
    run &&
    !sameMethod(run.snapshot, {
      ...run.snapshot,
      brand: project.brand,
      competitors: project.competitors,
      parserVersion: project.parserVersion,
      extractionModel: project.extractionModel,
      country: project.country,
      language: project.language,
      generationModel:
        projectProviders(project).find((config) => config.provider === provider)
          ?.model || '',
    })
  ) {
    run = null;
  }
  const comparable =
    run && previousRun && sameMethod(run.snapshot, previousRun.snapshot);
  return project.prompts.map((prompt) => {
    const current = measurement(prompt, run, results);
    const previous = measurement(
      prompt,
      comparable ? previousRun : null,
      comparable ? previousResults : [],
    );
    return {
      ...prompt,
      regions: [project.country],
      language: project.language,
      ...current,
      visibilityChange: change(current.avgVisibility, previous.avgVisibility),
      sentimentChange: change(
        current.avgSentimentScore,
        previous.avgSentimentScore,
      ),
      rankChange: change(current.avgRank, previous.avgRank, true),
    };
  });
}
