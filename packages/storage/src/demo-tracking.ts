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
  const normalizedKeys = new Map<string, string | null>();
  const urlKey = (url: string) => {
    if (!normalizedKeys.has(url)) normalizedKeys.set(url, trackedUrlKey(url));
    return normalizedKeys.get(url)!;
  };
  for (const item of project.demo?.trackedUrls || []) {
    const normalizedUrl = urlKey(item.url);
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
  const urlList = [...urls.values()];
  const enrolledAt = (url: TrackedUrl, at: string) => at >= url.publishedAt && trackingEnabledAt(url, at);
  // This cache belongs to the scenario adapter, never a database or object store.
  let matches: TrackingMatch[] | undefined;
  const scopedMatches = new Map<string, TrackingMatch[]>();
  const measureMatches = (selected: Map<string, TrackedUrl>, start: string) => {
    const measured: TrackingMatch[] = [];
    const selectedUrls = [...selected.values()];
    const enrolledCitation = (citation: Citation, at: string) => {
      const key = urlKey(citation.url);
      const url = key ? selected.get(key) : undefined;
      return !!url && enrolledAt(url, at);
    };
    if (selected.size && project.demo) {
      const history = hooks.history(start, `${project.demo.endDate}T23:59:59.999Z`);
      const runs = new Map(history.runs.map((run) => [run.id, run]));
      for (const result of history.results) {
        const run = runs.get(result.runId);
        if (!run || run.reportingExcludedAt || !['completed', 'partial'].includes(run.status)) continue;
        const capturedAt = result.capturedAt || run.createdAt;
        if (!selectedUrls.some((url) => enrolledAt(url, capturedAt))) continue;
        if (hooks.citations && !hooks.citations(run, result.prompt).some((citation) => enrolledCitation(citation, capturedAt))) continue;
        const evidence = hooks.evidence(run, result.prompt);
        // Citation counts and company attribution are independent for each URL.
        // Keeping only tracked annotations preserves their native measurement
        // while avoiding repeated parsing of every unrelated source per company.
        const citations = evidence.answer.citations.filter((citation) => enrolledCitation(citation, evidence.answer.createdAt));
        if (!citations.length) continue;
        const measurement = citationMeasurement(evidence.result, run, { ...evidence.answer, citations }, evidence.analysis);
        if (!measurement) continue;
        for (const citation of measurement.evidence) {
          const url = selected.get(citation.normalizedUrl);
          const at = measurement.capture.capturedAt;
          if (url && enrolledAt(url, at))
            measured.push({ trackedUrlId: url.id, capture: measurement.capture, evidence: citation });
        }
      }
      measured.sort((a, b) => b.capture.capturedAt.localeCompare(a.capture.capturedAt) || a.capture.captureKey.localeCompare(b.capture.captureKey));
    }
    return measured;
  };
  const listTrackingMatches = (trackedUrlId?: string): TrackingMatch[] => {
    const selected = trackedUrlId ? urlList.find((url) => url.id === trackedUrlId) : undefined;
    if (trackedUrlId && !selected) return [];
    if (!matches && selected && project.demo?.source === 'igeo-dr-roof') {
      let measured = scopedMatches.get(selected.id);
      if (!measured) {
        // A URL drawer needs only its own captures. Skip unrelated answer prose
        // and pre-enrollment scans while retaining the exact native URL evidence.
        const start = new Date(Math.max(Date.parse(`${project.demo.startDate}T00:00:00.000Z`),
          Date.parse(selected.createdAt), Date.parse(selected.publishedAt))).toISOString();
        measured = measureMatches(new Map([[selected.normalizedUrl, selected]]), start);
        scopedMatches.set(selected.id, measured);
      }
      return measured;
    }
    if (!matches) {
      matches = project.demo ? measureMatches(urls, `${project.demo.startDate}T00:00:00.000Z`) : [];
      scopedMatches.clear();
    }
    return trackedUrlId ? matches.filter((match) => match.trackedUrlId === trackedUrlId) : matches;
  };

  return { listTrackedUrls: () => [...urlList], listTrackingMatches };
}
