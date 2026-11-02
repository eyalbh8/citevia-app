import { parse } from 'tldts';
import type { Analysis, Citation, Project, PromptResult, ScanProvider, ScanRun } from './types.js';
import { normalizeUrl, sourceId } from './urls.js';
import { brandRank } from './scoring.js';

export const GEO_BACKLINK_ALGORITHM_VERSION = 'geo-backlinks-v1';
export const GEO_BACKLINK_STATUSES = ['recommended', 'approved', 'outreach_sent', 'awaiting_response', 'negotiating', 'accepted', 'published', 'rejected', 'cancelled'] as const;
export type GeoBacklinkStatus = typeof GEO_BACKLINK_STATUSES[number];
export type GeoBacklinkPriority = 'P1' | 'P2' | 'P3' | 'P4';
export type GeoBacklinkPresence = 'present' | 'absent' | 'unknown';
export type GeoBacklinkLinkType = 'follow' | 'nofollow' | 'sponsored' | 'ugc' | 'unknown';
export interface GeoBacklinkWeights { citationConsistency: number; competitorGap: number; relevance: number; visibilityGap: number; placement: number }
export interface GeoBacklinkSettings {
  enabled: boolean;
  target: number;
  exclusionDays: number;
  weights: GeoBacklinkWeights;
  /** Explicit exclusions for reviewed spam, link farms, or irrelevant publishers. */
  excludedDomains?: string[];
  enabledAt?: string;
}
export const DEFAULT_GEO_BACKLINK_SETTINGS: GeoBacklinkSettings = {
  enabled: false, target: 10, exclusionDays: 180,
  weights: { citationConsistency: 25, competitorGap: 25, relevance: 25, visibilityGap: 15, placement: 10 },
};
export interface GeoBacklinkArticleEvidence {
  status: 'verified' | 'unavailable';
  url: string;
  verifiedAt: string | null;
  title: string | null;
  publisher: string | null;
  brandPresence: GeoBacklinkPresence;
  competitors: { id: string; name: string; position: number | null; mentions?: number }[];
  brandPosition: number | null;
  brandMentions?: number;
  hasBrandLink: boolean | null;
  links: { url: string; type: GeoBacklinkLinkType }[];
  topicRelevant: boolean | null;
  marketRelevant: boolean | null;
  outdated: boolean | null;
  placementOpportunity: 'editorial' | 'commercial' | 'unknown';
  excerpts: string[];
  reason: string | null;
}
/** One successfully analysed answer; article claims never come from this observation. */
export interface GeoBacklinkObservation {
  key: string;
  runId: string;
  scanGroupId: string;
  responseId: string;
  provider: ScanProvider;
  at: string;
  promptId: string;
  promptVersion: number;
  promptText: string;
  topic: string | null;
  country: string;
  brandMentioned: boolean | null;
  brandRank: number | null;
  competitors: { id: string; name: string; mentioned: boolean | null; rank: number | null }[];
  citations: { url: string; title: string }[];
}
export interface GeoBacklinkEvidence {
  article: GeoBacklinkArticleEvidence;
  observations: GeoBacklinkObservation[];
  providers: ScanProvider[];
  prompts: { id: string; version: number; text: string; topic: string | null }[];
  distinctScans: number;
  totalScans: number;
  citationConsistency: number;
  recentConsistency: number;
  aiBrandMentionRate: number | null;
  aiAverageBrandRank: number | null;
  aiCompetitors: string[];
  firstCitedAt: string;
  lastCitedAt: string;
}
export interface GeoBacklinkCandidate {
  id: string;
  projectId: string;
  domain: string;
  url: string;
  title: string;
  firstDiscoveredAt: string;
  lastSeenAt: string;
  evaluatedMonth: string;
  priority: GeoBacklinkPriority;
  category: 'competitor_gap' | 'underrepresented' | 'coverage_gap' | 'secondary';
  score: number;
  scoreBreakdown: GeoBacklinkWeights;
  explanation: string[];
  action: string;
  evidence: GeoBacklinkEvidence;
}
export interface GeoBacklinkMonthlyReport {
  id: string;
  projectId: string;
  month: string;
  status: 'queued' | 'running' | 'completed' | 'insufficient_data' | 'failed';
  version: number;
  leaseToken?: string;
  leaseUntil?: string;
  createdAt: string;
  updatedAt: string;
  generatedAt: string | null;
  analysisStart: string;
  analysisEnd: string;
  timezone: string;
  scanCount: number;
  answerCount: number;
  candidateCount: number;
  excludedCount: number;
  algorithmVersion: string;
  settings: GeoBacklinkSettings;
  selectedRecommendationIds: string[];
  warnings: string[];
  error?: string;
  requestedBy?: string;
}
export interface GeoBacklinkRecommendation {
  id: string;
  projectId: string;
  reportId: string | null;
  month: string;
  domain: string;
  url: string;
  priority: GeoBacklinkPriority;
  recommendedAt: string;
  eligibleAgainAt: string;
  status: GeoBacklinkStatus;
  candidate: GeoBacklinkCandidate | null;
  contactedAt: string | null;
  publishedAt: string | null;
  publishedUrl: string | null;
  finalDomain: string | null;
  landingPage: string | null;
  placementType: string | null;
  linkType: GeoBacklinkLinkType;
  cost: number | null;
  currency: string | null;
  notes: string;
  ownerId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  imported?: boolean;
  importSource?: string;
}
export interface GeoBacklinkLedger {
  projectId: string;
  domain: string;
  originalUrl: string;
  firstRecommendedAt: string;
  lastRecommendedAt: string;
  month: string;
  eligibleAgainAt: string;
  priority: GeoBacklinkPriority;
  status: GeoBacklinkStatus;
  reportId: string | null;
  recommendationId: string;
  evidence: GeoBacklinkEvidence | null;
}
export interface GeoBacklinkActivity {
  id: string;
  projectId: string;
  recommendationId: string;
  actorId: string;
  at: string;
  action: 'recommended' | 'updated' | 'imported';
  fromStatus: GeoBacklinkStatus | null;
  toStatus: GeoBacklinkStatus;
  changes: Record<string, { from: unknown; to: unknown }>;
}
export interface GeoBacklinkPerformanceMetrics {
  answers: number;
  scans: number;
  brandMentionRate: number | null;
  averageBrandRank: number | null;
  domainCitationRate: number | null;
  articleCitationRate: number | null;
  uniqueReferringDomains: number;
  competitorRates: { id: string; name: string; rate: number | null }[];
  attribution: 'attributed' | 'unattributed';
}
export interface GeoBacklinkPerformanceSnapshot {
  id: string;
  projectId: string;
  recommendationId: string;
  checkpoint: 0 | 30 | 60 | 90;
  publicationDate: string;
  publicationUrl: string;
  start: string;
  end: string;
  measuredAt: string;
  status: 'measured' | 'insufficient_data';
  comparablePromptKeys: string[];
  excludedChangedPrompts: number;
  metrics: GeoBacklinkPerformanceMetrics;
  providers: Partial<Record<ScanProvider, GeoBacklinkPerformanceMetrics>>;
  article: GeoBacklinkArticleEvidence | null;
  delta: { brandMentionRate: number | null; averageBrandRank: number | null; domainCitationRate: number | null };
  referralTraffic: number | null;
  conversions: number | null;
  caveat: string;
}

const DAY = 86_400_000;
const round = (value: number) => Math.round(value * 100) / 100;
const average = (values: number[]) => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const unique = <T>(values: T[]) => [...new Set(values)];
const stamp = (value: string) => Date.parse(value);

/** Public Suffix List, including private suffixes; IPs and unregistered suffixes cannot be prospects. */
export function geoBacklinkDomain(value: string): string | null {
  const url = normalizeUrl(value.includes('://') ? value : `https://${value}`);
  if (!url) return null;
  const result = parse(new URL(url).hostname, { allowPrivateDomains: true, extractHostname: false });
  return !result.isIp && (result.isIcann || result.isPrivate) ? result.domain : null;
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find(item => item.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour') };
}

export function geoBacklinkMonth(date: Date, timezone: string): string {
  const parts = localParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
}

/** First instant of a calendar month, including zones whose offset changes at midnight. */
function monthBoundary(year: number, month: number, timezone: string): string {
  const anchor = Date.UTC(year, month - 1, 1);
  const target = year * 12 + month;
  let low = anchor - 2 * DAY, high = anchor + 2 * DAY;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const local = localParts(new Date(mid), timezone);
    if (local.year * 12 + local.month >= target) high = mid;
    else low = mid;
  }
  return new Date(high).toISOString();
}

/** End is exclusive. The analysis month is the month before the report's local calendar month. */
export function geoBacklinkAnalysisWindow(month: string, timezone: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 2000) throw new Error('Invalid report month');
  const [year, number] = month.split('-').map(Number);
  const previous = new Date(Date.UTC(year, number - 2, 1));
  return { start: monthBoundary(previous.getUTCFullYear(), previous.getUTCMonth() + 1, timezone), end: monthBoundary(year, number, timezone) };
}

/** A reconciliation retry after 06:00 on day one catches up the same immutable monthly report. */
export function dueGeoBacklinkMonth(now: Date, timezone: string): string | null {
  const parts = localParts(now, timezone);
  return parts.day > 1 || parts.hour >= 6 ? geoBacklinkMonth(now, timezone) : null;
}

export function unknownGeoBacklinkArticle(url: string, reason = 'Article content has not been verified.'): GeoBacklinkArticleEvidence {
  return { status: 'unavailable', url, verifiedAt: null, title: null, publisher: null, brandPresence: 'unknown',
    competitors: [], brandPosition: null, hasBrandLink: null, links: [], topicRelevant: null, marketRelevant: null,
    outdated: null, placementOpportunity: 'unknown', excerpts: [], reason };
}

export function buildGeoBacklinkObservations(rows: { run: ScanRun; result: PromptResult; analysis?: Analysis | null; citations: Citation[] }[]): GeoBacklinkObservation[] {
  const observations = new Map<string, GeoBacklinkObservation>();
  for (const { run, result, analysis, citations } of rows) {
    if (run.status !== 'completed' || run.cancelledAt || run.reportingExcludedAt || result.status !== 'succeeded' || result.runId !== run.id || result.projectId !== run.projectId) continue;
    const provider = run.snapshot.provider ?? 'openai';
    const scanGroupId = `${run.groupId || run.reanalysisOf || run.id}:${provider}`;
    const key = `${scanGroupId}:${result.promptId}:${result.prompt.version}`;
    const target = analysis?.brands.find(item => item.brandId === run.snapshot.brand.id) ?? result.target;
    const brands = analysis?.brands ?? result.brands ?? [];
    const rawAt = result.capturedAt || run.startedAt || run.createdAt;
    if (!Number.isFinite(stamp(rawAt))) continue;
    const at = new Date(rawAt).toISOString();
    const byUrl = new Map<string, { url: string; title: string }>();
    for (const citation of citations) {
      const url = normalizeUrl(citation.url);
      if (url && geoBacklinkDomain(url)) byUrl.set(url, { url, title: citation.title || '' });
    }
    const item: GeoBacklinkObservation = {
      key, runId: run.id, scanGroupId, responseId: result.responseId, provider, at,
      promptId: result.promptId, promptVersion: result.prompt.version, promptText: result.prompt.text,
      topic: result.prompt.topic || null, country: run.snapshot.country,
      brandMentioned: target?.mentioned ?? null, brandRank: brandRank(target),
      competitors: run.snapshot.competitors.map(brand => {
        const value = brands.find(item => item.brandId === brand.id);
        return { id: brand.id, name: brand.name, mentioned: value?.mentioned ?? null, rank: brandRank(value) };
      }), citations: [...byUrl.values()],
    };
    // Reanalysis of the same scan replaces its prior observation, rather than creating another vote.
    const previous = observations.get(key);
    if (!previous || previous.at <= item.at) observations.set(key, item);
  }
  return [...observations.values()].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

const intermediaryDomains = new Set(['google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com', 'vertexaisearch.cloud.google.com',
  'grounding-api-redirect.google.com', 'googleusercontent.com', 'gstatic.com', 'perplexity.ai', 'chatgpt.com', 'openai.com']);

export function geoBacklinkExcludedDomain(domain: string, project: Pick<Project, 'brand' | 'competitors' | 'brandbook'>, settings: GeoBacklinkSettings): boolean {
  if (intermediaryDomains.has(domain) || /^google\.(?:(?:com|co)\.)?[a-z]{2,}$/i.test(domain) || /(^|\.)(gov|gouv|gob|mil)(\.|$)/i.test(domain)) return true;
  return [...project.brand.domains, ...(project.brandbook?.domains ?? []), ...project.competitors.flatMap(brand => brand.domains), ...(settings.excludedDomains ?? [])]
    .some(value => geoBacklinkDomain(value) === domain);
}

function reliableArticle(raw: GeoBacklinkArticleEvidence): GeoBacklinkArticleEvidence {
  if (raw.status !== 'verified') return { ...unknownGeoBacklinkArticle(raw.url, raw.reason || undefined), verifiedAt: raw.verifiedAt };
  const competitors = [...new Map(raw.competitors.map(item => [item.name.trim().toLocaleLowerCase().replace(/\s+/g, ' ') || item.id, item])).values()];
  return { ...raw, competitors };
}

function classify(evidence: GeoBacklinkEvidence): Pick<GeoBacklinkCandidate, 'priority' | 'category' | 'action'> {
  const article = evidence.article;
  if (article.status === 'verified' && article.brandPresence === 'absent' && article.competitors.length >= 2 &&
    article.topicRelevant === true && article.marketRelevant === true && evidence.distinctScans >= 2) return {
    priority: 'P1', category: 'competitor_gap', action: 'Seek accurate editorial inclusion or an independent product evaluation; disclose any commercial placement.',
  };
  const betterPositioned = article.brandPosition !== null && article.competitors.some(item => item.position !== null && item.position < article.brandPosition!);
  const moreCoverage = article.brandMentions !== undefined && article.competitors.some(item => (item.mentions || 0) >= Math.max(2, article.brandMentions! * 2));
  const poorAnswerPosition = evidence.distinctScans >= 2 && evidence.aiAverageBrandRank !== null && evidence.aiAverageBrandRank > 3;
  if (article.status === 'verified' && article.brandPresence === 'present' && (betterPositioned || moreCoverage || poorAnswerPosition)) return {
    priority: 'P2', category: 'underrepresented', action: 'Offer factual updates and request a fresh independent evaluation. Publisher rankings remain editorial decisions.',
  };
  if (article.status === 'verified' && (article.outdated === true || (article.brandPresence === 'present' && article.hasBrandLink === false) ||
    (article.brandPresence === 'absent' && evidence.distinctScans >= 2))) return {
    priority: 'P3', category: 'coverage_gap', action: 'Pursue useful expert contributions, factual corrections, or independent coverage with an appropriate brand link.',
  };
  return { priority: 'P4', category: 'secondary', action: article.status === 'verified'
    ? 'Assess a relevant editorial contribution or secondary brand awareness opportunity.'
    : 'Verify the article’s relevance and existing brand coverage before pursuing an editorial contribution.' };
}

function scoreEvidence(evidence: GeoBacklinkEvidence, weights: GeoBacklinkWeights): GeoBacklinkWeights {
  const article = evidence.article;
  const weightsSum = Object.values(weights).reduce((sum, value) => sum + (Number.isFinite(value) ? Math.max(0, value) : 0), 0) || 100;
  const points = (factor: keyof GeoBacklinkWeights, value: number) => round(Math.max(0, weights[factor]) / weightsSum * 100 * Math.min(1, Math.max(0, value)));
  const articleGap = article.status === 'verified' && article.brandPresence === 'absent' ? Math.min(1, article.competitors.length / 2)
    : article.status === 'verified' && article.brandPresence === 'present' ? (article.competitors.length ? .25 : 0)
      : Math.min(.2, evidence.aiCompetitors.length * .1);
  const relevance = .35 + (article.topicRelevant === true ? .4 : 0) + (article.marketRelevant === true ? .25 : 0);
  const visibility = evidence.aiBrandMentionRate === null ? 0 : 1 - evidence.aiBrandMentionRate / 100;
  const positionGap = evidence.aiAverageBrandRank === null ? 0 : Math.min(1, Math.max(0, (evidence.aiAverageBrandRank - 1) / 5));
  return { citationConsistency: points('citationConsistency', evidence.recentConsistency / 100), competitorGap: points('competitorGap', articleGap),
    relevance: points('relevance', relevance), visibilityGap: points('visibilityGap', Math.max(visibility, positionGap)),
    placement: points('placement', article.placementOpportunity === 'unknown' ? 0 : 1) };
}

/** Candidates must appear in this analysis window: old backlog evidence alone never qualifies. */
export function discoverGeoBacklinkCandidates(project: Project, month: string, observations: GeoBacklinkObservation[], articles: Map<string, GeoBacklinkArticleEvidence> = new Map(), settings: GeoBacklinkSettings = DEFAULT_GEO_BACKLINK_SETTINGS): GeoBacklinkCandidate[] {
  const window = geoBacklinkAnalysisWindow(month, project.timezone);
  const current = observations.filter(item => stamp(item.at) >= stamp(window.start) && stamp(item.at) < stamp(window.end) && item.country === project.country)
    .map(item => ({ ...item, at: new Date(item.at).toISOString() }));
  const scans = new Map<string, string>();
  for (const item of current) if ((scans.get(item.scanGroupId) || '') < item.at) scans.set(item.scanGroupId, item.at);
  const recentWeight = (at: string) => 1 - Math.min(1, Math.max(0, (stamp(window.end) - stamp(at)) / (35 * DAY))) * .5;
  const totalWeight = [...scans.values()].reduce((sum, at) => sum + recentWeight(at), 0);
  const grouped = new Map<string, { url: string; title: string; article: GeoBacklinkArticleEvidence; observations: Map<string, GeoBacklinkObservation> }>();
  for (const item of current) for (const citation of item.citations) {
    const raw = articles.get(citation.url) || unknownGeoBacklinkArticle(citation.url);
    const article = reliableArticle(raw);
    // A known redirect destination is canonical even when its content cannot be verified.
    const url = normalizeUrl(article.url) || normalizeUrl(citation.url);
    const domain = url && geoBacklinkDomain(url);
    if (!url || !domain || geoBacklinkExcludedDomain(domain, project, settings) || article.topicRelevant === false || article.marketRelevant === false) continue;
    const row = grouped.get(url) || { url, title: article.title || citation.title, article, observations: new Map() };
    if (article.status === 'verified' && (row.article.status !== 'verified' || (article.verifiedAt || '') > (row.article.verifiedAt || ''))) {
      row.article = article;
      row.title = article.title || citation.title;
    }
    row.observations.set(item.key, item);
    grouped.set(url, row);
  }
  const candidates: GeoBacklinkCandidate[] = [];
  for (const row of grouped.values()) {
    const items = [...row.observations.values()].sort((a, b) => a.at.localeCompare(b.at));
    const citedScans = unique(items.map(item => item.scanGroupId));
    const knownBrand = items.filter(item => item.brandMentioned !== null);
    const evidence: GeoBacklinkEvidence = {
      article: row.article, observations: items, providers: unique(items.map(item => item.provider)).sort(),
      prompts: [...new Map(items.map(item => [`${item.promptId}:${item.promptVersion}`, { id: item.promptId, version: item.promptVersion, text: item.promptText, topic: item.topic }])).values()],
      distinctScans: citedScans.length, totalScans: scans.size,
      citationConsistency: scans.size ? round(citedScans.length / scans.size * 100) : 0,
      recentConsistency: totalWeight ? round(citedScans.reduce((sum, id) => sum + recentWeight(scans.get(id)!), 0) / totalWeight * 100) : 0,
      aiBrandMentionRate: knownBrand.length ? round(knownBrand.filter(item => item.brandMentioned).length / knownBrand.length * 100) : null,
      aiAverageBrandRank: average(items.flatMap(item => item.brandRank === null ? [] : [item.brandRank])),
      aiCompetitors: unique(items.flatMap(item => item.competitors.filter(brand => brand.mentioned).map(brand => brand.name))).sort(),
      firstCitedAt: items[0].at, lastCitedAt: items[items.length - 1].at,
    };
    const classification = classify(evidence);
    const breakdown = scoreEvidence(evidence, settings.weights);
    const domain = geoBacklinkDomain(row.url)!;
    const articleCompetitors = row.article.competitors.map(item => item.name);
    candidates.push({
      id: sourceId(`${project.id}:${row.url}`), projectId: project.id, domain, url: row.url, title: row.title || domain,
      firstDiscoveredAt: evidence.firstCitedAt, lastSeenAt: evidence.lastCitedAt, evaluatedMonth: month, ...classification,
      score: Math.min(100, round(Object.values(breakdown).reduce((sum, value) => sum + value, 0))), scoreBreakdown: breakdown,
      explanation: [
        `Cited in ${evidence.distinctScans} of ${evidence.totalScans} distinct provider scans (${evidence.citationConsistency}%). Repeated citations in one answer count once.`,
        `Customer presence in the article: ${row.article.brandPresence}. ${row.article.status === 'verified' ? `Verified ${row.article.verifiedAt || 'without a recorded date'}.` : 'Article content remains unverified.'}`,
        `Verified article competitors: ${articleCompetitors.length ? articleCompetitors.join(', ') : 'none verified'}. Competitors in AI answers are recorded separately.`,
        `Associated AI answers mention the customer ${evidence.aiBrandMentionRate === null ? 'at an unknown rate' : `in ${evidence.aiBrandMentionRate}% of analysed answers`}${evidence.aiAverageBrandRank === null ? '; rank unavailable.' : `; average observed rank ${evidence.aiAverageBrandRank}.`}`,
        `Topic relevance: ${row.article.topicRelevant === null ? 'unverified; source cited for tracked prompts' : row.article.topicRelevant ? 'verified' : 'not relevant'}. Market relevance: ${row.article.marketRelevant === null ? 'unverified' : row.article.marketRelevant ? 'verified' : 'not relevant'}.`,
        `Placement availability: ${row.article.placementOpportunity}. No price or publisher agreement is assumed.`,
      ], action: classification.action, evidence,
    });
  }
  return candidates.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain) || a.url.localeCompare(b.url));
}

export function geoBacklinkEligibleAgainAt(recommendedAt: string, exclusionDays = 180): string {
  if (!Number.isFinite(stamp(recommendedAt))) throw new Error('Invalid recommendation date');
  return new Date(stamp(recommendedAt) + Math.max(180, exclusionDays) * DAY).toISOString();
}

export function geoBacklinkDomainEligible(domain: string, ledger: Pick<GeoBacklinkLedger, 'domain' | 'lastRecommendedAt' | 'eligibleAgainAt'>[], now: Date, exclusionDays = 180): boolean {
  const canonical = geoBacklinkDomain(domain);
  return Boolean(canonical) && Number.isFinite(now.getTime()) && !ledger.some(row => {
    if (geoBacklinkDomain(row.domain) !== canonical) return false;
    // Corrupt historical dates cannot silently remove a known domain exclusion.
    if (!Number.isFinite(stamp(row.eligibleAgainAt)) || !Number.isFinite(stamp(row.lastRecommendedAt))) return true;
    return now.getTime() < Math.max(stamp(row.eligibleAgainAt), stamp(geoBacklinkEligibleAgainAt(row.lastRecommendedAt, exclusionDays)));
  });
}

/** Only final choices enter the ledger. Qualified P4 opportunities retain their reserved slot. */
export function selectGeoBacklinkCandidates(candidates: GeoBacklinkCandidate[], ledger: Pick<GeoBacklinkLedger, 'domain' | 'lastRecommendedAt' | 'eligibleAgainAt'>[], now: Date, settings: GeoBacklinkSettings = DEFAULT_GEO_BACKLINK_SETTINGS): GeoBacklinkCandidate[] {
  const target = Math.max(0, Math.min(100, Math.floor(settings.target)));
  const eligible = candidates.filter(item => geoBacklinkDomainEligible(item.domain, ledger, now, settings.exclusionDays))
    .sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain) || a.url.localeCompare(b.url));
  const selected: GeoBacklinkCandidate[] = [];
  const domains = new Set<string>();
  const add = (item: GeoBacklinkCandidate) => { const domain = geoBacklinkDomain(item.domain); if (domain && !domains.has(domain) && selected.length < target) { selected.push(item); domains.add(domain); return true; } return false; };
  const priorities: GeoBacklinkPriority[] = ['P1', 'P2', 'P3', 'P4'];
  const shares = [5, 3, 1, 1];
  const quotas = shares.map(share => Math.floor(target * share / 10));
  let remainder = target - quotas.reduce((sum, quota) => sum + quota, 0);
  for (const index of shares.map((share, index) => ({ index, fraction: target * share / 10 % 1 })).sort((a, b) => b.fraction - a.fraction || a.index - b.index)) {
    if (remainder-- > 0) quotas[index.index]++;
  }
  for (let index = 0; index < priorities.length; index++) {
    let count = 0;
    for (const candidate of eligible) if (candidate.priority === priorities[index] && count < quotas[index] && add(candidate)) count++;
  }
  for (const candidate of eligible) add(candidate);
  return selected.sort((a, b) => a.priority.localeCompare(b.priority) || b.score - a.score || a.domain.localeCompare(b.domain));
}

/** Prompt text participates even if an upstream edit failed to increment its version. */
export function geoBacklinkPromptKey(item: GeoBacklinkObservation): string {
  return `${item.provider}:${item.promptId}:${item.promptVersion}:${sourceId(`${item.country}:${item.promptText.trim().replace(/\s+/g, ' ')}`)}`;
}

export function geoBacklinkPerformanceMetrics(observations: GeoBacklinkObservation[], domain: string, articleUrl: string): GeoBacklinkPerformanceMetrics {
  const items = [...new Map(observations.map(item => [item.key, item])).values()];
  const canonical = geoBacklinkDomain(domain);
  const article = normalizeUrl(articleUrl);
  const brand = items.filter(item => item.brandMentioned !== null);
  const domainCited = items.filter(item => item.citations.some(citation => geoBacklinkDomain(citation.url) === canonical));
  const articleCited = items.filter(item => item.citations.some(citation => normalizeUrl(citation.url) === article));
  const competitorIds = unique(items.flatMap(item => item.competitors.map(competitor => competitor.id)));
  return { answers: items.length, scans: new Set(items.map(item => item.scanGroupId)).size,
    brandMentionRate: brand.length ? round(brand.filter(item => item.brandMentioned).length / brand.length * 100) : null,
    averageBrandRank: average(items.flatMap(item => item.brandRank === null ? [] : [item.brandRank])),
    domainCitationRate: items.length ? round(domainCited.length / items.length * 100) : null,
    articleCitationRate: items.length ? round(articleCited.length / items.length * 100) : null,
    uniqueReferringDomains: unique(items.flatMap(item => item.citations.map(citation => geoBacklinkDomain(citation.url)).filter(Boolean))).length,
    competitorRates: competitorIds.map(id => {
      const values = items.flatMap(item => item.competitors.filter(competitor => competitor.id === id));
      const known = values.filter(item => item.mentioned !== null);
      return { id, name: values[0].name, rate: known.length ? round(known.filter(item => item.mentioned).length / known.length * 100) : null };
    }), attribution: articleCited.length ? 'attributed' : 'unattributed',
  };
}

export function geoBacklinkMetrics(observations: GeoBacklinkObservation[], targetUrl = ''): GeoBacklinkPerformanceMetrics {
  const metrics = geoBacklinkPerformanceMetrics(observations, geoBacklinkDomain(targetUrl) || '', targetUrl);
  return targetUrl ? metrics : { ...metrics, domainCitationRate: null, articleCitationRate: null };
}

/** 0 = previous 30 days; 30/60/90 = successive 30-day windows after the actual publication date. */
export function geoBacklinkPerformanceSnapshot(recommendation: GeoBacklinkRecommendation, observations: GeoBacklinkObservation[], checkpoint: 0 | 30 | 60 | 90, now: Date, baseline?: GeoBacklinkPerformanceSnapshot, article: GeoBacklinkArticleEvidence | null = null): GeoBacklinkPerformanceSnapshot | null {
  if (!recommendation.publishedAt || !recommendation.publishedUrl) return null;
  const published = stamp(recommendation.publishedAt);
  const end = published + checkpoint * DAY, start = end - 30 * DAY;
  if (!Number.isFinite(published) || now.getTime() < end) return null;
  const inWindow = observations.filter(item => stamp(item.at) >= start && stamp(item.at) < end);
  const baselineKeys = new Set(baseline?.comparablePromptKeys ?? observations.filter(item => stamp(item.at) >= published - 30 * DAY && stamp(item.at) < published).map(geoBacklinkPromptKey));
  const comparable = inWindow.filter(item => baselineKeys.has(geoBacklinkPromptKey(item)));
  const comparisonKeys = unique(comparable.map(geoBacklinkPromptKey));
  const metrics = geoBacklinkPerformanceMetrics(comparable, recommendation.finalDomain || recommendation.domain, recommendation.publishedUrl);
  const providers: GeoBacklinkPerformanceSnapshot['providers'] = {};
  for (const provider of unique(comparable.map(item => item.provider))) providers[provider] = geoBacklinkPerformanceMetrics(comparable.filter(item => item.provider === provider), recommendation.finalDomain || recommendation.domain, recommendation.publishedUrl);
  // Recalculate baseline on the same intersection, avoiding a changed prompt mix in the comparison.
  const baselineComparable = observations.filter(item => stamp(item.at) >= published - 30 * DAY && stamp(item.at) < published && comparisonKeys.includes(geoBacklinkPromptKey(item)));
  const base = geoBacklinkPerformanceMetrics(baselineComparable, recommendation.finalDomain || recommendation.domain, recommendation.publishedUrl);
  const difference = (key: 'brandMentionRate' | 'averageBrandRank' | 'domainCitationRate') => metrics[key] === null || base[key] === null || !checkpoint ? null : round(metrics[key]! - base[key]!);
  return { id: sourceId(`${recommendation.id}:${recommendation.publishedAt}:${recommendation.publishedUrl}:${checkpoint}`), projectId: recommendation.projectId,
    recommendationId: recommendation.id, checkpoint, publicationDate: recommendation.publishedAt, publicationUrl: recommendation.publishedUrl,
    start: new Date(start).toISOString(), end: new Date(end).toISOString(), measuredAt: now.toISOString(),
    status: comparable.length && (checkpoint === 0 || baselineComparable.length) ? 'measured' : 'insufficient_data',
    comparablePromptKeys: checkpoint === 0 ? unique(inWindow.map(geoBacklinkPromptKey)) : comparisonKeys,
    excludedChangedPrompts: inWindow.length - comparable.length, metrics, providers, article,
    delta: { brandMentionRate: difference('brandMentionRate'), averageBrandRank: difference('averageBrandRank'), domainCitationRate: difference('domainCitationRate') },
    referralTraffic: null, conversions: null,
    caveat: 'Observed changes are correlations, not proof that a placement caused improved AI visibility. Traffic and conversions are unavailable unless attributable integration data exists.',
  };
}
