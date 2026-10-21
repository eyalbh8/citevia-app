import type { Analysis, CapturedAnswer } from '@citevia/core';
import type { Runtime } from './contracts.js';

/** Rebuild derived evidence from saved artifacts, without calling an AI provider. */
export async function backfillTracking(
  runtime: Pick<Runtime, 'repository' | 'artifacts'>,
  projectId: string,
  from: string,
  to: string,
  checkpoint?: (progress: {
    nextDate: string;
    processed: number;
    missing: number;
  }) => void,
) {
  const parse = (date: string) => {
    const value = new Date(`${date}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(value.getTime()) ||
      value.toISOString().slice(0, 10) !== date
    )
      throw new Error('Use valid YYYY-MM-DD dates.');
    return value.getTime();
  };
  const first = parse(from),
    last = parse(to);
  if (first > last)
    throw new Error('The start date must precede the end date.');
  if (!(await runtime.repository.getProject(projectId)))
    throw new Error('Account not found.');
  let processed = 0,
    missing = 0;
  // Bound history/artifact reads to one UTC day. Repeating a day is idempotent.
  for (let at = first; at <= last; at += 86400000) {
    const history = await runtime.repository.listPromptHistory(
      projectId,
      new Date(at).toISOString(),
      new Date(at + 86400000 - 1).toISOString(),
    );
    const runs = new Map(
      history.runs
        .filter((r) => ['completed', 'partial'].includes(r.status))
        .map((r) => [r.id, r]),
    );
    for (const result of history.results) {
      const run = runs.get(result.runId);
      if (!run || !result.captureKey) continue;
      const [answer, analysis] = await Promise.all([
        runtime.artifacts.get<CapturedAnswer>(result.captureKey),
        result.analysisKey
          ? runtime.artifacts.get<Analysis>(result.analysisKey)
          : null,
      ]);
      if (!answer || (result.status === 'succeeded' && !analysis)) {
        missing++;
        continue;
      }
      await runtime.repository.saveMeasurement(result, run, answer, analysis);
      processed++;
    }
    checkpoint?.({
      nextDate: new Date(at + 86400000).toISOString().slice(0, 10),
      processed,
      missing,
    });
  }
  return { processed, missing };
}
