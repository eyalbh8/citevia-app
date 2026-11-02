import { geoBacklinkDomain, selectGeoBacklinkCandidates } from '@citevia/core';
import type { GeoBacklinkActivity, GeoBacklinkCandidate, GeoBacklinkLedger, GeoBacklinkMonthlyReport,
  GeoBacklinkPerformanceSnapshot, GeoBacklinkRecommendation, GeoBacklinkSettings, Project } from '@citevia/core';

export interface GeoBacklinkPageOptions { offset?: number; limit?: number; month?: string; status?: string; priority?: string; provider?: string; category?: string; query?: string; sort?: 'date' | 'recommendedAt' | 'domain' | 'priority' | 'status' | 'score' | 'eligibleAgainAt'; direction?: 'asc' | 'desc' }
export interface GeoBacklinkCommit {
  report: GeoBacklinkMonthlyReport;
  leaseToken: string;
  candidates: GeoBacklinkCandidate[];
  /** All qualified fresh candidates as proposals; only the transaction-selected subset is persisted. */
  recommendations: GeoBacklinkRecommendation[];
  exclusionDays: number;
  now: string;
}
export interface GeoBacklinkRepository {
  listGeoBacklinkProjects(offset: number, limit: number): Promise<{ items: Project[]; total: number }>;
  reserveGeoBacklinkReport(report: GeoBacklinkMonthlyReport): Promise<{ status: 'created' | 'existing'; report: GeoBacklinkMonthlyReport }>;
  claimGeoBacklinkReport(projectId: string, month: string, token: string, now: string, leaseUntil: string): Promise<GeoBacklinkMonthlyReport | null>;
  /** Finalizes report and selected-domain exclusions under the same account lock. Rechecks exclusions and may return fewer recommendations. */
  commitGeoBacklinkReport(input: GeoBacklinkCommit): Promise<GeoBacklinkMonthlyReport | null>;
  failGeoBacklinkReport(projectId: string, month: string, token: string, error: string, now: string): Promise<boolean>;
  getGeoBacklinkReport(projectId: string, month: string): Promise<GeoBacklinkMonthlyReport | null>;
  listGeoBacklinkReports(projectId: string, offset: number, limit: number): Promise<{ items: GeoBacklinkMonthlyReport[]; total: number }>;
  listActiveGeoBacklinkReports(limit?: number, now?: string): Promise<GeoBacklinkMonthlyReport[]>;
  listGeoBacklinkCandidates(projectId: string, options?: GeoBacklinkPageOptions): Promise<{ items: GeoBacklinkCandidate[]; total: number }>;
  listGeoBacklinkRecommendations(projectId: string, options?: GeoBacklinkPageOptions): Promise<{ items: GeoBacklinkRecommendation[]; total: number }>;
  getGeoBacklinkRecommendation(projectId: string, id: string): Promise<GeoBacklinkRecommendation | null>;
  saveGeoBacklinkRecommendation(next: GeoBacklinkRecommendation, expectedVersion: number, activity: GeoBacklinkActivity): Promise<boolean>;
  listGeoBacklinkActivities(projectId: string, recommendationId: string, offset: number, limit: number): Promise<{ items: GeoBacklinkActivity[]; total: number }>;
  listGeoBacklinkLedger(projectId: string): Promise<GeoBacklinkLedger[]>;
  /** Import entries must carry original dates and stable ids; re-importing an id is a no-op. */
  importGeoBacklinkHistory(projectId: string, entries: GeoBacklinkRecommendation[], actorId: string, now: string): Promise<number>;
  listLegacyGeoBacklinkHistory(projectId: string): Promise<{ id: string; url: string; recommendedAt: string; source: string }[]>;
  putGeoBacklinkPerformance(snapshot: GeoBacklinkPerformanceSnapshot): Promise<boolean>;
  listGeoBacklinkPerformance(projectId: string, recommendationId?: string): Promise<GeoBacklinkPerformanceSnapshot[]>;
}

export function geoPageBounds(options: GeoBacklinkPageOptions = {}) {
  return { offset: Math.max(0, Math.floor(options.offset || 0)), limit: Math.min(100, Math.max(1, Math.floor(options.limit || 25))) };
}
export const geoFinal = (report: GeoBacklinkMonthlyReport) => ['completed', 'insufficient_data'].includes(report.status);
export function geoCanonicalDomain(value: string) {
  const domain = geoBacklinkDomain(value);
  if (!domain) throw new Error('Invalid backlink referring domain');
  return domain;
}
export function geoLedger(recommendation: GeoBacklinkRecommendation, previous?: GeoBacklinkLedger): GeoBacklinkLedger {
  const newest = !previous || Date.parse(recommendation.recommendedAt) >= Date.parse(previous.lastRecommendedAt);
  if (!newest) return { ...previous, firstRecommendedAt: new Date(Math.min(Date.parse(previous.firstRecommendedAt), Date.parse(recommendation.recommendedAt))).toISOString(),
    eligibleAgainAt: new Date(Math.max(Date.parse(previous.eligibleAgainAt), Date.parse(recommendation.eligibleAgainAt))).toISOString() };
  return { projectId: recommendation.projectId, domain: recommendation.domain, originalUrl: recommendation.url,
    firstRecommendedAt: previous ? new Date(Math.min(Date.parse(previous.firstRecommendedAt), Date.parse(recommendation.recommendedAt))).toISOString() : recommendation.recommendedAt,
    lastRecommendedAt: recommendation.recommendedAt, month: recommendation.month, eligibleAgainAt: previous ? new Date(Math.max(Date.parse(previous.eligibleAgainAt),Date.parse(recommendation.eligibleAgainAt))).toISOString() : recommendation.eligibleAgainAt,
    priority: recommendation.priority, status: recommendation.status, reportId: recommendation.reportId,
    recommendationId: recommendation.id, evidence: recommendation.candidate?.evidence ?? null };
}
export function geoEligible(ledger: GeoBacklinkLedger | undefined, now: string, days: number) {
  if (!ledger) return true;
  return Date.parse(now) >= Math.max(Date.parse(ledger.eligibleAgainAt), Date.parse(ledger.lastRecommendedAt) + Math.max(180, days) * 86400000);
}
export function geoSameCohort(a: GeoBacklinkRecommendation, b: GeoBacklinkRecommendation) {
  return a.projectId === b.projectId && a.id === b.id && a.reportId === b.reportId && a.month === b.month && a.domain === b.domain &&
    a.url === b.url && a.priority === b.priority && a.recommendedAt === b.recommendedAt && a.eligibleAgainAt === b.eligibleAgainAt &&
    a.createdAt === b.createdAt && stableJson(a.candidate) === stableJson(b.candidate) && a.imported === b.imported && a.importSource === b.importSource;
}

export function geoValidateCandidate(candidate: GeoBacklinkCandidate) {
  const url = new URL(candidate.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || geoCanonicalDomain(url.hostname) !== geoCanonicalDomain(candidate.domain))
    throw new Error('Invalid GEO candidate URL/domain');
}
export function geoValidateRecommendation(item: GeoBacklinkRecommendation) {
  const url = new URL(item.url);
  const domain = geoCanonicalDomain(item.domain);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || geoCanonicalDomain(url.hostname) !== domain)
    throw new Error('Invalid GEO recommendation URL/domain');
  if (item.candidate) {
    geoValidateCandidate(item.candidate);
    if (geoCanonicalDomain(item.candidate.domain) !== domain || item.candidate.projectId !== item.projectId || item.candidate.url !== item.url)
      throw new Error('Invalid GEO recommendation evidence domain');
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([name,item]) => JSON.stringify(name) + ':' + stableJson(item)).join(',') + '}';
}

/** Keep one deterministic strongest article per domain; backlog discovery never reserves its domain. */
export function geoBestCandidates(candidates: GeoBacklinkCandidate[]) {
  const result = new Map<string, GeoBacklinkCandidate>();
  for (const candidate of [...candidates].sort((a,b) => b.score-a.score || a.priority.localeCompare(b.priority) || a.url.localeCompare(b.url))) {
    const domain = geoCanonicalDomain(candidate.domain);
    if (!result.has(domain)) result.set(domain,{...candidate,domain});
    else if (Date.parse(candidate.firstDiscoveredAt)<Date.parse(result.get(domain)!.firstDiscoveredAt)) result.get(domain)!.firstDiscoveredAt=candidate.firstDiscoveredAt;
  }
  return [...result.values()];
}
export function geoRefreshCandidate(next: GeoBacklinkCandidate, previous?: GeoBacklinkCandidate): GeoBacklinkCandidate {
  if (!previous) return next;
  const firstDiscoveredAt = Date.parse(previous.firstDiscoveredAt) <= Date.parse(next.firstDiscoveredAt) ? previous.firstDiscoveredAt : next.firstDiscoveredAt;
  // A manual historical report must not replace more recent backlog evidence.
  if (next.evaluatedMonth < previous.evaluatedMonth) return {...previous,firstDiscoveredAt};
  return {...next,firstDiscoveredAt};
}

/** Re-run the same allocation against the locked ledger so simultaneous imports can refill from the backlog. */
export function geoSelectProposals(proposals: GeoBacklinkRecommendation[], ledger: GeoBacklinkLedger[], now: string, settings: GeoBacklinkSettings) {
  const byCandidate = new Map(proposals.map(item => [JSON.stringify([item.candidate!.id,item.candidate!.url]),item]));
  const selected = selectGeoBacklinkCandidates(proposals.map(item=>item.candidate!),ledger,new Date(now),settings)
    .map(candidate=>byCandidate.get(JSON.stringify([candidate.id,candidate.url]))!);
  const byDomain = new Map(ledger.map(item=>[item.domain,item]));
  const excludedCount = new Set(proposals.map(item=>geoCanonicalDomain(item.domain))
    .filter(domain=>!geoEligible(byDomain.get(domain),now,settings.exclusionDays))).size;
  return {selected,excludedCount};
}
