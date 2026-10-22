import {
  citationMeasurement,
  trackedUrlKey,
  trackedUrlMetadata,
  trackingEnabledAt,
  type Analysis,
  type CapturedAnswer,
  type Citation,
  type Project,
  type Prompt,
  type PromptHistory,
  type PromptResult,
  type ScanRun,
  type TrackedUrl,
  type TrackingMatch,
} from '@citevia/core';
import { uuidFor } from './sql.js';

interface ScenarioTrackingHooks {
  history(start: string, end: string): PromptHistory;
  /** Cheap citation lookup avoids generating answer prose for unrelated captures. */
  citations?(run: ScanRun, prompt: Prompt): readonly Citation[];
  evidence(run: ScanRun, prompt: Prompt): {
    result: PromptResult;
    answer: CapturedAnswer;
    analysis: Analysis;
  };
}

/** Small enrollment metadata; counts use the same captures as the answer screens. */
export function createScenarioTracking(project: Project, hooks: ScenarioTrackingHooks) {
  const urls = new Map<string, TrackedUrl>();
  for (const item of project.demo?.trackedUrls || []) {
    const normalizedUrl = trackedUrlKey(item.url);
    if (!normalizedUrl || urls.has(normalizedUrl)) continue;
    const createdAt = new Date(item.createdAt || item.publishedAt).toISOString();
    const publishedAt = new Date(item.publishedAt).toISOString();
    urls.set(normalizedUrl, {
      id: uuidFor(`scenario-tracked-url:${project.id}:${normalizedUrl}`),
      projectId: project.id,
      url: item.url.trim(),
      normalizedUrl,
      title: item.title || trackedUrlMetadata(item.url).title,
      contentType: item.contentType || trackedUrlMetadata(item.url).contentType,
      imageUrl: item.imageUrl,
      active: true,
      createdAt,
      updatedAt: createdAt,
      publishedAt,
      version: 1,
      trackingPeriods: item.trackingPeriods?.map((period) => ({
        start: new Date(period.start).toISOString(),
        end: period.end ? new Date(period.end).toISOString() : null,
      })),
    });
  }

  // This cache belongs to the scenario adapter, never a database or object store.
  let matches: TrackingMatch[] | undefined;
  const listTrackingMatches = (trackedUrlId?: string): TrackingMatch[] => {
    if (trackedUrlId && ![...urls.values()].some((url) => url.id === trackedUrlId)) return [];
    if (!matches) {
      matches = [];
      if (urls.size && project.demo) {
        const history = hooks.history(`${project.demo.startDate}T00:00:00.000Z`, `${project.demo.endDate}T23:59:59.999Z`);
        const runs = new Map(history.runs.map((run) => [run.id, run]));
        for (const result of history.results) {
          const run = runs.get(result.runId);
          if (!run || run.reportingExcludedAt || !['completed', 'partial'].includes(run.status)) continue;
          const capturedAt = result.capturedAt || run.createdAt;
          if (![...urls.values()].some((url) => capturedAt >= url.publishedAt && trackingEnabledAt(url, capturedAt))) continue;
          if (hooks.citations && !hooks.citations(run, result.prompt).some((citation) => {
            const key = trackedUrlKey(citation.url);
            const url = key ? urls.get(key) : undefined;
            return url && capturedAt >= url.publishedAt && trackingEnabledAt(url, capturedAt);
          })) continue;
          const evidence = hooks.evidence(run, result.prompt);
          const measurement = citationMeasurement(evidence.result, run, evidence.answer, evidence.analysis);
          if (!measurement) continue;
          for (const citation of measurement.evidence) {
            const url = urls.get(citation.normalizedUrl);
            const at = measurement.capture.capturedAt;
            if (url && at >= url.publishedAt && trackingEnabledAt(url, at))
              matches.push({ trackedUrlId: url.id, capture: measurement.capture, evidence: citation });
          }
        }
        matches.sort((a, b) => b.capture.capturedAt.localeCompare(a.capture.capturedAt) || a.capture.captureKey.localeCompare(b.capture.captureKey));
      }
    }
    return trackedUrlId ? matches.filter((match) => match.trackedUrlId === trackedUrlId) : matches;
  };

  return { listTrackedUrls: () => [...urls.values()], listTrackingMatches };
}
