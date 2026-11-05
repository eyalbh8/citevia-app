import {
  citationMeasurement,
  trackedUrlKey,
  trackedArticleUrl,
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
import type { TrackingMatchOptions } from './contracts.js';

interface ScenarioTrackingHooks {
  history(start: string, end: string): PromptHistory;
  captures?(start: string, end: string): Iterable<{ run: ScanRun; prompt: Prompt; capturedAt: string }>;
  /** Cheap citation lookup avoids generating answer prose for unrelated captures. */
  citations?(run: ScanRun, prompt: Prompt): readonly Citation[];
  evidence(run: ScanRun, prompt: Prompt, citations?: Citation[]): {
    result: PromptResult;
    answer: CapturedAnswer;
    analysis: Analysis;
  };
}

function* historyCaptures(history: PromptHistory) {
  const runs = new Map(history.runs.map(run => [run.id, run]));
  for (const result of history.results) {
    const run = runs.get(result.runId);
    if (run) yield { run, prompt: result.prompt, capturedAt: result.capturedAt || run.createdAt };
  }
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
    const publicUrl = trackedArticleUrl(item.url.trim());
    const normalizedUrl = urlKey(publicUrl);
    if (!normalizedUrl || urls.has(normalizedUrl)) continue;
    const createdAt = new Date(item.createdAt || item.publishedAt).toISOString();
    const publishedAt = new Date(item.publishedAt).toISOString();
    urls.set(normalizedUrl, {
      id: uuidFor(`scenario-tracked-url:${project.id}:${urlKey(item.url)}`),
      projectId: project.id,
      url: publicUrl,
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
  const measureMatches = (selected: Map<string, TrackedUrl>, start: string, end = `${project.demo!.endDate}T23:59:59.999Z`) => {
    const measured: TrackingMatch[] = [];
    const selectedUrls = [...selected.values()];
    const enrolledCitation = (citation: Citation, at: string) => {
      const key = urlKey(citation.url);
      const url = key ? selected.get(key) : undefined;
      return !!url && enrolledAt(url, at);
    };
    if (selected.size && project.demo && start <= end) {
      const captures = hooks.captures?.(start, end) ?? historyCaptures(hooks.history(start, end));
      for (const { run, prompt, capturedAt } of captures) {
        if (run.reportingExcludedAt || !['completed', 'partial'].includes(run.status)) continue;
        if (capturedAt < start || capturedAt > end) continue;
        if (!selectedUrls.some((url) => enrolledAt(url, capturedAt))) continue;
        const tracked = hooks.citations?.(run, prompt).filter(citation => enrolledCitation(citation, capturedAt));
        if (tracked && !tracked.length) continue;
        const evidence = hooks.evidence(run, prompt, tracked);
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
  const boundedMatches = new Map<string, { start: string; end: string; urlId?: string; items: TrackingMatch[] }>();
  const listTrackingMatches = (trackedUrlId?: string, options: TrackingMatchOptions = {}): TrackingMatch[] => {
    const selected = trackedUrlId ? urlList.find((url) => url.id === trackedUrlId) : undefined;
    if (trackedUrlId && !selected) return [];
    if (options.start || options.end) {
      const inRange = (match: TrackingMatch) => (!trackedUrlId || match.trackedUrlId === trackedUrlId) &&
        (!options.start || match.capture.capturedAt >= options.start) && (!options.end || match.capture.capturedAt <= options.end);
      if (matches) return matches.filter(inRange);
      if (selected && scopedMatches.has(selected.id)) return scopedMatches.get(selected.id)!.filter(inRange);
      if (!project.demo) return [];
      const catalog = selected ? new Map([[selected.normalizedUrl, selected]]) : urls;
      const start = new Date(Math.max(Date.parse(`${project.demo.startDate}T00:00:00.000Z`),
        options.start ? Date.parse(options.start) : 0,
        selected ? Math.max(Date.parse(selected.createdAt), Date.parse(selected.publishedAt)) : 0)).toISOString();
      const end = new Date(Math.min(Date.parse(`${project.demo.endDate}T23:59:59.999Z`),
        options.end ? Date.parse(options.end) : Infinity)).toISOString();
      const key = `${trackedUrlId || '*'}:${start}`;
      let cached = boundedMatches.get(key);
      if (!cached || cached.end < end) {
        // A previous lifetime read also covers shorter ranges and individual URL drawers.
        for (const interval of boundedMatches.values())
          if ((!interval.urlId || interval.urlId === trackedUrlId) && interval.start <= start && interval.end >= end)
            return interval.items.filter(inRange);
        // List and summary requests have slightly different 'now' timestamps.
        // Extend an existing interval instead of regenerating account history.
        const nextStart = cached ? new Date(Math.max(Date.parse(start), Date.parse(cached.end) + 1)).toISOString() : start;
        const items = [...measureMatches(catalog, nextStart, end), ...(cached?.items || [])];
        cached = { start, end, urlId: trackedUrlId, items };
        for (const [existingKey, interval] of boundedMatches)
          if ((!trackedUrlId || interval.urlId === trackedUrlId) && start <= interval.start && end >= interval.end)
            boundedMatches.delete(existingKey);
        if (boundedMatches.size >= 16) boundedMatches.delete(boundedMatches.keys().next().value!);
        boundedMatches.set(key, cached);
      }
      return cached.items.filter(inRange);
    }
    if (!matches && selected && project.demo) {
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
