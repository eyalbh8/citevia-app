import type {
  Analysis,
  CapturedAnswer,
  Citation,
  Prompt,
  PromptAnswerRow,
  PromptResult,
  ScanProvider,
  ScanRun,
} from './types.js';
import { snapshotProvider } from './providers.js';
import { brandRank, brandSentimentScore } from './scoring.js';
import { reportingCompanies } from './company-reporting.js';

export const TRACKING_VERSION = 1;
/** iGEO identity: retain path case, www, trailing slash and content query IDs. */
export function trackedUrlKey(raw: string): string | null {
  raw = raw.trim();
  let domain: string;
  try {
    const parsed = new URL(raw);
    domain = parsed.hostname.toLowerCase();
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      return null;
  } catch {
    return null;
  }
  const path = raw.match(/^[a-zA-Z]+:\/\/[^/?#]+(\/[^?#]*)/)?.[1] || '';
  const query = raw.match(/^[^?#]*\?([^#]*)/)?.[1] || '';
  const parameters = query
    .split('&')
    .filter(
      (p) =>
        p &&
        !/^(utm(_.*)?|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|igsh|si)$/i.test(
          p.split('=', 1)[0],
        ),
    )
    .sort();
  const key =
    domain + path + (parameters.length ? `?${parameters.join('&')}` : '');
  // Leave room for project/capture identity in PostgreSQL's composite indexes.
  return new TextEncoder().encode(key).length <= 2048 ? key : null;
}
export type TrackingStatus =
  | 'published'
  | 'crawled'
  | 'cited'
  | 'stale'
  | 'lost';
export interface TrackedUrl {
  id: string;
  projectId: string;
  url: string;
  normalizedUrl: string;
  title: string;
  contentType: 'BLOG' | 'WEBSITE' | 'SOCIAL';
  active: boolean;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
  version: number;
  trackingPeriods?: { start: string; end: string | null }[];
}
/** Enrollment is evaluated at capture time, including during reconciliation. */
export function trackingEnabledAt(url: TrackedUrl, at: string) {
  return url.trackingPeriods
    ? url.trackingPeriods.some(
        (period) => at >= period.start && (!period.end || at < period.end),
      )
    : url.active && at >= url.createdAt;
}
export function trackingPeriodsAfter(
  url: TrackedUrl,
  active: boolean,
  at: string,
) {
  const periods = (
    url.trackingPeriods || [
      { start: url.createdAt, end: url.active ? null : url.updatedAt },
    ]
  ).map((p) => ({ ...p }));
  if (active === url.active) return periods;
  if (active) periods.push({ start: at, end: null });
  else for (const period of periods) if (!period.end) period.end = at;
  return periods;
}
export function trackedUrlMetadata(url: string) {
  const parsed = new URL(url);
  const social =
    /(^|\.)(instagram|facebook|linkedin|tiktok|x|twitter|reddit|youtube|threads|pinterest|quora)\./i.test(
      parsed.hostname,
    );
  const segment = parsed.pathname.split('/').filter(Boolean).at(-1);
  let title = segment || parsed.hostname;
  try {
    title = decodeURIComponent(title).replace(/[-_]+/g, ' ');
  } catch {
    /* retain original segment */
  }
  return {
    title: title.slice(0, 200),
    contentType: social
      ? ('SOCIAL' as const)
      : /\/(blog|posts?|articles?)(\/|$)/i.test(parsed.pathname)
        ? ('BLOG' as const)
        : ('WEBSITE' as const),
  };
}
export interface CitationCapture {
  projectId: string;
  captureKey: string;
  runId: string;
  responseId: string;
  promptId: string;
  prompt: Prompt;
  country: string;
  provider: ScanProvider;
  capturedAt: string;
  analysisAt: string;
  resultVersion: number;
  analyzed: boolean;
  rank: number | null;
  sentimentScore: number | null;
  mentioned: boolean;
}
export interface CitationEvidence {
  normalizedUrl: string;
  url: string;
  citations: Citation[];
  /** Raw native annotations, independent of projected company rows. */
  nativeCount: number;
  /** iGEO company_sources UNION ALL url_sources occurrence count. */
  appearances: number;
  resultKeys: string[];
}
export interface TrackingMatch {
  trackedUrlId: string;
  capture: CitationCapture;
  evidence: CitationEvidence;
}
export function citationMeasurement(
  result: PromptResult,
  run: ScanRun,
  answer: CapturedAnswer | null,
  analysis: Analysis | null,
) {
  if (!answer || answer.status !== 'completed' || !result.captureKey)
    return null;
  const analyzed = result.status === 'succeeded' && !!analysis;
  const capture: CitationCapture = {
    projectId: result.projectId,
    captureKey: `${snapshotProvider(run.snapshot)}:${result.captureKey}`,
    runId: run.id,
    responseId: result.responseId,
    promptId: result.promptId,
    prompt: result.prompt,
    country: run.snapshot.country,
    provider: snapshotProvider(run.snapshot),
    capturedAt: answer.createdAt,
    analysisAt: run.createdAt,
    resultVersion: result.version,
    analyzed,
    rank: analyzed ? brandRank(result.target) : null,
    sentimentScore: analyzed ? brandSentimentScore(result.target) : null,
    mentioned: analyzed && !!result.target?.mentioned,
  };
  const groups = new Map<string, CitationEvidence>();
  for (const citation of answer.citations) {
    const key = trackedUrlKey(citation.url);
    if (!key) continue;
    const entry = groups.get(key) || {
      normalizedUrl: key,
      url: citation.url,
      citations: [],
      nativeCount: 0,
      appearances: 0,
      resultKeys: [],
    };
    entry.citations.push(citation);
    entry.nativeCount++;
    groups.set(key, entry);
  }
  if (analyzed)
    for (const company of reportingCompanies(analysis, run.snapshot, answer)) {
      if (company.rank === null) continue;
      const hits = new Map<string, number>();
      for (const citation of [...answer.citations, ...company.sources]) {
        const key = trackedUrlKey(citation.url);
        if (key) hits.set(key, (hits.get(key) || 0) + 1);
      }
      for (const [key, count] of hits) {
        const entry = groups.get(key);
        if (entry) {
          entry.appearances += count;
          entry.resultKeys.push(company.company.toLocaleLowerCase());
        }
      }
    }
  return { capture, evidence: [...groups.values()] };
}
export function newerCapture(
  next: CitationCapture,
  previous?: CitationCapture,
) {
  return (
    !previous ||
    (next.analyzed && !previous.analyzed) ||
    (next.analyzed === previous.analyzed &&
      (next.analysisAt > previous.analysisAt ||
        (next.analysisAt === previous.analysisAt &&
          next.resultVersion >= previous.resultVersion)))
  );
}
export interface MonitoringPeriod {
  start: string;
  end: string;
  granularity: 'daily' | 'hourly';
  timezone: 'UTC';
}
export interface MonitoringFilters {
  providers: ScanProvider[];
  region: string;
  tag: string;
  branded: string;
  intent: string;
  search: string;
}
export function matchesMonitoringFilters(
  prompt: Prompt,
  provider: ScanProvider,
  country: string,
  filters: MonitoringFilters,
) {
  return (
    (!filters.providers.length || filters.providers.includes(provider)) &&
    (!filters.region || country === filters.region) &&
    (!filters.tag || prompt.tags?.includes(filters.tag)) &&
    (!filters.branded || String(prompt.branded) === filters.branded) &&
    (!filters.intent || prompt.intent === filters.intent) &&
    (!filters.search ||
      prompt.text
        .toLocaleLowerCase()
        .includes(filters.search.toLocaleLowerCase()))
  );
}
export interface MentionProvider {
  provider: ScanProvider;
  count: number;
  share: number;
  change: number | null;
  points: { date: string; count: number }[];
}
export interface MentionsSummary {
  period: MonitoringPeriod;
  total: number;
  providers: MentionProvider[];
  comparison: 'first_to_last_observed_day';
  markers: {
    date: string;
    items: { id: string; url: string; title: string; appearances: number }[];
  }[];
}
export interface MentionAnswer extends PromptAnswerRow {
  brandSites: { name: string; url: string | null }[];
}
export interface TrackingRow extends TrackedUrl {
  status: TrackingStatus;
  appearances: number;
  periodAppearances: number;
  nativeCitations: number;
  matchingResults: number;
  matchingAnswers: number;
  previousResults: number;
  promptCount: number;
  firstCitedAt: string | null;
  lastCitedAt: string | null;
  daysToFirstCitation: number | null;
  providers: { provider: ScanProvider; count: number; share: number }[];
  series: { date: string; count: number }[];
  lift: null;
  firstCrawledAt: null;
  clicks: null;
}
export interface TrackingSummary {
  trackedCount: number;
  trackedThisMonth: number;
  appearances: number;
  citedCount: number;
  citedRate: number;
  medianPickup: number | null;
  series: {
    date: string;
    citations: number;
    mentions: number;
    published: number;
  }[];
  clicks: null;
}
export interface TrackingDetail {
  row: TrackingRow;
  period: MonitoringPeriod;
  avgPosition: number | null;
  sentimentScore: number | null;
  prompts: {
    id: string;
    text: string;
    provider: ScanProvider;
    answers: number;
  }[];
}
/** iGEO's summary uses ROUND(PERCENTILE_CONT(0.5)). */
export const medianPickupDays = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return Math.round(
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
  );
};
export function trackingRows(
  urls: TrackedUrl[],
  matches: TrackingMatch[],
  period: MonitoringPeriod,
  now: Date,
): TrackingRow[] {
  const grouped = new Map<string, TrackingMatch[]>();
  for (const match of matches) {
    const list = grouped.get(match.trackedUrlId) || [];
    list.push(match);
    grouped.set(match.trackedUrlId, list);
  }
  const pickup = urls.flatMap((url) => {
    const first = grouped
      .get(url.id)
      ?.map((m) => m.capture.capturedAt)
      .sort()[0];
    return first
      ? [
          Math.max(
            0,
            Math.round(
              (Date.parse(first) - Date.parse(url.publishedAt)) / 86400000,
            ),
          ),
        ]
      : [];
  });
  // The reference lifecycle uses the lower middle value (distinct from its KPI).
  pickup.sort((a, b) => a - b);
  const typicalPickup = pickup.length
    ? pickup[Math.floor((pickup.length - 1) / 2)]
    : 9;
  const threshold = Math.max(14, 2 * typicalPickup);
  const start = Date.parse(period.start),
    end = Date.parse(period.end),
    width = end - start + 1;
  return urls.map((url) => {
    const all = grouped.get(url.id) || [],
      times = all.map((m) => m.capture.capturedAt).sort();
    const current = all.filter(
      (m) =>
        Date.parse(m.capture.capturedAt) >= start &&
        Date.parse(m.capture.capturedAt) <= end,
    );
    const prev = all.filter(
      (m) =>
        Date.parse(m.capture.capturedAt) >= start - width &&
        Date.parse(m.capture.capturedAt) < start,
    );
    const recent = all.some(
      (m) => Date.parse(m.capture.capturedAt) >= now.getTime() - 30 * 86400000,
    );
    const firstCitedAt = times[0] || null,
      lastCitedAt = times.at(-1) || null;
    const providers = new Map<ScanProvider, number>(),
      series = new Map<string, number>();
    for (const m of current) {
      const count = m.evidence.resultKeys.length;
      providers.set(
        m.capture.provider,
        (providers.get(m.capture.provider) || 0) + count,
      );
      const date = m.capture.capturedAt.slice(0, 10);
      series.set(date, (series.get(date) || 0) + count);
    }
    const matchingResults = current.reduce(
      (sum, m) => sum + m.evidence.resultKeys.length,
      0,
    );
    return {
      ...url,
      status: recent
        ? 'cited'
        : all.length
          ? 'lost'
          : now.getTime() - Date.parse(url.publishedAt) > threshold * 86400000
            ? 'stale'
            : 'published',
      appearances: all.reduce((sum, m) => sum + m.evidence.appearances, 0),
      periodAppearances: current.reduce(
        (sum, m) => sum + m.evidence.appearances,
        0,
      ),
      nativeCitations: current.reduce(
        (sum, m) => sum + m.evidence.nativeCount,
        0,
      ),
      matchingResults,
      matchingAnswers: current.length,
      previousResults: prev.reduce(
        (sum, m) => sum + m.evidence.resultKeys.length,
        0,
      ),
      promptCount: new Set(current.map((m) => m.capture.promptId)).size,
      firstCitedAt,
      lastCitedAt,
      daysToFirstCitation: firstCitedAt
        ? Math.max(
            0,
            Math.round(
              (Date.parse(firstCitedAt) - Date.parse(url.publishedAt)) /
                86400000,
            ),
          )
        : null,
      providers: [...providers]
        .map(([provider, count]) => ({
          provider,
          count,
          share: matchingResults ? count / matchingResults : 0,
        }))
        .sort((a, b) => b.count - a.count),
      series: [...series]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count })),
      lift: null,
      firstCrawledAt: null,
      clicks: null,
    };
  });
}
