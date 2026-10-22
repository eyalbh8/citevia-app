import {
  brandRank,
  brandSentimentScore,
  snapshotProvider,
  type PromptHistory,
  type PromptResult,
  type ScanProvider,
  type ScanRun,
} from '@citevia/core';

export const ANSWER_SORTS = [
  'date',
  'model',
  'rank',
  'citations',
  'sentiment',
] as const;
export type AnswerSort = (typeof ANSWER_SORTS)[number];

/** One row per original capture, across runs and prompt versions. */
export function promptAnswers(
  history: PromptHistory,
  projectId: string,
  promptId: string | undefined,
  provider: ScanProvider | undefined,
  sort: AnswerSort,
  direction: 'asc' | 'desc',
) {
  const runs = new Map(
    history.runs
      .filter((run) => run.projectId === projectId && !run.reportingExcludedAt)
      .map((run) => [run.id, run]),
  );
  const captures = new Map<string, { result: PromptResult; run: ScanRun }>();
  for (const result of history.results) {
    const run = runs.get(result.runId);
    if (
      !run ||
      result.projectId !== projectId ||
      (promptId && result.promptId !== promptId) ||
      (provider && snapshotProvider(run.snapshot) !== provider)
    )
      continue;
    const key = `${snapshotProvider(run.snapshot)}:${result.captureKey || result.responseId}`;
    const previous = captures.get(key);
    // A failed/pending reanalysis must not replace a completed original analysis.
    if (
      !previous ||
      (result.status === 'succeeded' &&
        previous.result.status !== 'succeeded') ||
      ((result.status === 'succeeded') ===
        (previous.result.status === 'succeeded') &&
        run.createdAt > previous.run.createdAt)
    )
      captures.set(key, { result, run });
  }
  function value({
    result,
    run,
  }: {
    result: PromptResult;
    run: ScanRun;
  }): string | number | null {
    const target = result.status === 'succeeded' ? result.target : undefined;
    switch (sort) {
      case 'date':
        return Date.parse(result.capturedAt || run.createdAt);
      case 'model':
        return result.model || run.snapshot.generationModel;
      case 'rank':
        return brandRank(target);
      case 'sentiment':
        return brandSentimentScore(target);
      case 'citations':
        return result.captureKey ? result.citationCount : null;
    }
  }
  return [...captures.values()].sort((a, b) => {
    const left = value(a),
      right = value(b);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left ?? '').localeCompare(String(right ?? ''));
    return (
      (direction === 'asc' ? order : -order) ||
      a.result.responseId.localeCompare(b.result.responseId)
    );
  });
}
