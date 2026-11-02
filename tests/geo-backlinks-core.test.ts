import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GEO_BACKLINK_SETTINGS, buildGeoBacklinkObservations, discoverGeoBacklinkCandidates, dueGeoBacklinkMonth,
  geoBacklinkAnalysisWindow, geoBacklinkDomain, geoBacklinkDomainEligible, geoBacklinkEligibleAgainAt,
  geoBacklinkMetrics, geoBacklinkPerformanceSnapshot, selectGeoBacklinkCandidates, unknownGeoBacklinkArticle,
  type GeoBacklinkArticleEvidence, type GeoBacklinkCandidate, type GeoBacklinkLedger, type GeoBacklinkObservation,
  type GeoBacklinkRecommendation, type PromptResult, type ScanRun,
} from '@citevia/core';
import { newProject } from './fixtures/scanner.js';

const project = { ...newProject({ domain: 'northstar.com' }), timezone: 'UTC', competitors: [
  { id: 'clearview', name: 'Clearview', aliases: [], domains: ['clearview.com'] },
  { id: 'metriclane', name: 'Metriclane', aliases: [], domains: ['metriclane.com'] },
] };
const settings = { ...DEFAULT_GEO_BACKLINK_SETTINGS, enabled: true };
function observation(overrides: Partial<GeoBacklinkObservation> = {}): GeoBacklinkObservation {
  return { key: 'run-1:openai:prompt-1', runId: 'run-1', scanGroupId: 'run-1:openai', responseId: 'response-1',
    provider: 'openai', at: '2026-10-10T10:00:00.000Z', promptId: 'prompt-1', promptVersion: 1,
    promptText: 'Best marketing analytics products in the United States', topic: 'Marketing analytics', country: 'US',
    brandMentioned: false, brandRank: null, competitors: [{ id: 'clearview', name: 'Clearview', mentioned: true, rank: 1 }],
    citations: [{ url: 'https://publisher.com/best-analytics', title: 'Best analytics' }], ...overrides };
}
function article(overrides: Partial<GeoBacklinkArticleEvidence> = {}): GeoBacklinkArticleEvidence {
  return { ...unknownGeoBacklinkArticle('https://publisher.com/best-analytics'), status: 'verified', verifiedAt: '2026-11-01T06:00:00.000Z',
    title: 'Best analytics', brandPresence: 'absent', topicRelevant: true, marketRelevant: true,
    competitors: [{ id: 'clearview', name: 'Clearview', position: 1 }, { id: 'metriclane', name: 'Metriclane', position: 2 }], ...overrides };
}
function candidate(domain: string, priority: GeoBacklinkCandidate['priority'] = 'P1', score = 80): GeoBacklinkCandidate {
  const candidate = discoverGeoBacklinkCandidates(project, '2026-11', [observation()], new Map(), settings)[0];
  return { ...candidate, id: domain, domain, url: `https://${domain}/article`, priority, score };
}
function ledger(domain: string, date: string): GeoBacklinkLedger {
  return { projectId: project.id, domain, originalUrl: `https://${domain}/old`, firstRecommendedAt: date, lastRecommendedAt: date,
    month: date.slice(0, 7), eligibleAgainAt: geoBacklinkEligibleAgainAt(date), priority: 'P3', status: 'rejected',
    reportId: 'report-old', recommendationId: 'recommendation-old', evidence: null };
}
function recommendation(overrides: Partial<GeoBacklinkRecommendation> = {}): GeoBacklinkRecommendation {
  return { id: 'recommendation-1', projectId: project.id, reportId: 'report-1', month: '2026-11', domain: 'publisher.com',
    url: 'https://publisher.com/best-analytics', priority: 'P4', recommendedAt: '2026-11-01T06:00:00.000Z',
    eligibleAgainAt: '2027-04-30T06:00:00.000Z', status: 'published', candidate: null, contactedAt: null,
    publishedAt: '2026-11-10T12:00:00.000Z', publishedUrl: 'https://publisher.com/best-analytics', finalDomain: 'publisher.com',
    landingPage: null, placementType: null, linkType: 'unknown', cost: null, currency: null, notes: '', ownerId: null,
    version: 1, createdAt: '2026-11-01T06:00:00.000Z', updatedAt: '2026-11-10T12:00:00.000Z', ...overrides };
}

describe('GEO backlink public suffix normalization and 180 full day exclusions', () => {
  it('collapses www and subdomains, preserves co.uk registrable domains and private suffix tenants', () => {
    expect(geoBacklinkDomain('https://WWW.nerdwallet.com/a')).toBe('nerdwallet.com');
    expect(geoBacklinkDomain('investing.nerdwallet.com')).toBe('nerdwallet.com');
    expect(geoBacklinkDomain('www.example.co.uk')).toBe('example.co.uk');
    expect(geoBacklinkDomain('publication.blogspot.com')).toBe('publication.blogspot.com');
    expect(geoBacklinkDomain('127.0.0.1')).toBeNull();
    expect(geoBacklinkDomain('localhost')).toBeNull();
    expect(geoBacklinkDomain('co.uk')).toBeNull();
    expect(geoBacklinkDomain('https://user:secret@publisher.com')).toBeNull();
  });
  it('blocks yesterday and five months ago even for rejected or unpublished recommendations', () => {
    const now = new Date('2026-11-02T06:00:00.000Z');
    expect(geoBacklinkDomainEligible('publisher.com', [ledger('publisher.com', '2026-11-01T06:00:00.000Z')], now)).toBe(false);
    expect(geoBacklinkDomainEligible('publisher.com', [ledger('publisher.com', '2026-06-02T06:00:00.000Z')], now)).toBe(false);
  });
  it('requires exactly 180 full days and also honors longer configured windows', () => {
    const date = '2026-05-06T06:00:00.000Z';
    const row = ledger('publisher.com', date);
    const end = Date.parse(date) + 180 * 86400000;
    expect(geoBacklinkDomainEligible('publisher.com', [row], new Date(end - 1))).toBe(false);
    expect(geoBacklinkDomainEligible('publisher.com', [row], new Date(end))).toBe(true);
    expect(geoBacklinkDomainEligible('publisher.com', [row], new Date(end), 181)).toBe(false);
    expect(geoBacklinkEligibleAgainAt(date, 1)).toBe(new Date(end).toISOString());
  });
  it('blocks alternate articles and subdomains while an empty account ledger remains independent', () => {
    const now = new Date('2026-11-02T06:00:00.000Z');
    const rows = [ledger('www.publisher.co.uk', '2026-11-01T06:00:00.000Z')];
    expect(geoBacklinkDomainEligible('https://other.publisher.co.uk/new', rows, now)).toBe(false);
    expect(geoBacklinkDomainEligible('publisher.co.uk', [], now)).toBe(true);
    expect(geoBacklinkDomainEligible('publisher.co.uk', [{ ...rows[0], eligibleAgainAt: 'invalid' }], now)).toBe(false);
  });
});

describe('monthly timezone processing', () => {
  it('uses the previous local calendar month including DST offset changes', () => {
    expect(geoBacklinkAnalysisWindow('2026-11', 'Asia/Nicosia')).toEqual({ start: '2026-09-30T21:00:00.000Z', end: '2026-10-31T22:00:00.000Z' });
    expect(geoBacklinkAnalysisWindow('2026-04', 'America/New_York')).toEqual({ start: '2026-03-01T05:00:00.000Z', end: '2026-04-01T04:00:00.000Z' });
    expect(geoBacklinkAnalysisWindow('2028-03', 'UTC')).toEqual({ start: '2028-02-01T00:00:00.000Z', end: '2028-03-01T00:00:00.000Z' });
  });
  it('becomes due at 06:00 local on the first and permits same-month catch-up', () => {
    expect(dueGeoBacklinkMonth(new Date('2026-11-01T03:59:59Z'), 'Asia/Nicosia')).toBeNull();
    expect(dueGeoBacklinkMonth(new Date('2026-11-01T04:00:00Z'), 'Asia/Nicosia')).toBe('2026-11');
    expect(dueGeoBacklinkMonth(new Date('2026-11-15T00:00:00Z'), 'Asia/Nicosia')).toBe('2026-11');
  });
  it('rejects malformed month identifiers', () => {
    expect(() => geoBacklinkAnalysisWindow('2026-13', 'UTC')).toThrow('Invalid report month');
    expect(() => geoBacklinkAnalysisWindow('2026-1', 'UTC')).toThrow('Invalid report month');
  });
});

describe('evidence aggregation and conservative priorities', () => {
  it('ignores failed, partial, excluded and incomplete results and deduplicates source citations', () => {
    const run: ScanRun = { projectId: project.id, id: 'run', status: 'completed', groupId: 'group',
      snapshot: { ...project, projectName: project.name, configVersion: 1 }, createdAt: '2026-10-10T10:00:00.000Z', scheduledAt: '2026-10-10T10:00:00.000Z',
      trigger: 'scheduled', totalCount: 1, terminalCount: 1, succeededCount: 1, capturedCount: 1, resultVersion: 1, deadlineAt: '2026-10-11T00:00:00.000Z', expiresAt: 0 };
    const result: PromptResult = { projectId: project.id, runId: run.id, promptId: project.prompts[0].id, prompt: project.prompts[0], responseId: 'response',
      status: 'succeeded', version: 1, attempts: 1, citationCount: 2, sourceCount: 1, expiresAt: 0 };
    const citations = [0, 1].map(id => ({ id: String(id), blockId: 'b', url: `https://publisher.com/article?utm_source=${id}`, title: 'Publisher', start: null, end: null }));
    const input = { run, result, citations };
    const valid = buildGeoBacklinkObservations([input, input]);
    expect(valid).toHaveLength(1);
    expect(valid[0].citations).toHaveLength(1);
    expect(valid[0].brandMentioned).toBeNull();
    expect(buildGeoBacklinkObservations([
      { ...input, run: { ...run, status: 'partial' } }, { ...input, run: { ...run, status: 'failed' } },
      { ...input, run: { ...run, reportingExcludedAt: run.createdAt } }, { ...input, result: { ...result, status: 'incomplete' } },
    ])).toEqual([]);
    const providers = buildGeoBacklinkObservations([input, { ...input, run: { ...run, id: 'gemini-run', snapshot: { ...run.snapshot, provider: 'gemini' } }, result: { ...result, runId: 'gemini-run' } }]);
    expect(providers.map(item => item.provider).sort()).toEqual(['gemini', 'openai']);
  });
  it('counts a publisher once per provider scan even across repeated answers', () => {
    const observations = [observation(), observation({ key: 'second-prompt', promptId: 'prompt-2' }), observation({ key: 'run-2', scanGroupId: 'run-2:gemini', provider: 'gemini' })];
    const [result] = discoverGeoBacklinkCandidates(project, '2026-11', observations);
    expect(result.evidence.distinctScans).toBe(2);
    expect(result.evidence.totalScans).toBe(2);
    expect(result.evidence.providers).toEqual(['gemini', 'openai']);
    expect(result.evidence.citationConsistency).toBe(100);
  });
  it('keeps article presence separate from customer absence in the AI answer', () => {
    const [result] = discoverGeoBacklinkCandidates(project, '2026-11', [observation()], new Map([[article().url, article({ brandPresence: 'present', hasBrandLink: false })]]));
    expect(result.evidence.article.brandPresence).toBe('present');
    expect(result.evidence.aiBrandMentionRate).toBe(0);
    expect(result.priority).toBe('P3');
  });
  it('never infers verified absence from unavailable content or AI competitor appearances', () => {
    const unverified = article({ status: 'unavailable', brandPresence: 'absent' });
    const [result] = discoverGeoBacklinkCandidates(project, '2026-11', [observation()], new Map([[unverified.url, unverified]]));
    expect(result.evidence.article.brandPresence).toBe('unknown');
    expect(result.evidence.article.competitors).toEqual([]);
    expect(result.priority).toBe('P4');
  });
  it('requires two verified different competitors, strong scans and verified topic and market for P1', () => {
    const observations = [observation(), observation({ key: 'run-2', scanGroupId: 'run-2:openai', at: '2026-10-20T10:00:00.000Z' })];
    const priority = (value: GeoBacklinkArticleEvidence) => discoverGeoBacklinkCandidates(project, '2026-11', observations, new Map([[value.url, value]]))[0].priority;
    expect(priority(article())).toBe('P1');
    expect(priority(article({ competitors: [article().competitors[0], article().competitors[0]] }))).toBe('P3');
    expect(priority(article({ marketRelevant: null }))).toBe('P3');
    expect(discoverGeoBacklinkCandidates(project, '2026-11', [observation()], new Map([[article().url, article()]]))[0].priority).toBe('P4');
  });
  it('classifies verified underrepresentation using explicit rankings or prominence observations', () => {
    const value = article({ brandPresence: 'present', brandPosition: 5 });
    const [result] = discoverGeoBacklinkCandidates(project, '2026-11', [observation()], new Map([[value.url, value]]));
    expect(result.priority).toBe('P2');
    expect(result.action).toContain('editorial decisions');
  });
  it('excludes customer, competitor, proxy, government and explicitly excluded publishers', () => {
    const domains = ['northstar.com', 'news.clearview.com', 'vertexaisearch.cloud.google.com', 'gov.uk', 'spamdomain.com'];
    const observations = [observation({ citations: domains.map(domain => ({ url: `https://${domain}/article`, title: 'Article' })) })];
    expect(discoverGeoBacklinkCandidates(project, '2026-11', observations, new Map(), { ...settings, excludedDomains: ['spamdomain.com'] })).toEqual([]);
  });
  it('excludes owned domains recorded only in the project brandbook, including their subdomains', () => {
    const account = { ...project, brandbook: {
      about: '', industryCategory: '', subIndustryCategory: '', companyCountry: 'US', language: 'en', names: [],
      domains: ['northstar-products.co.uk'], keyFeatures: [], toneOfVoice: [], values: [], personality: [], targetAudience: [],
      knowledgeSources: [], sitemapUrl: null, caseStudiesSourceUrl: null, caseStudies: [],
      postGuidelines: { dos: [], donts: [] }, evidence: [], unknowns: [], generatedAt: '2026-10-01T00:00:00.000Z',
      model: 'test', version: 1, generationId: 'brandbook-test',
    } };
    const observed = observation({ citations: [{ url: 'https://guides.northstar-products.co.uk/article', title: 'Owned guide' }] });
    expect(discoverGeoBacklinkCandidates(account, '2026-11', [observed])).toEqual([]);
  });
  it('excludes redirected own articles and unrelated verified material, and requires fresh monthly citations', () => {
    expect(discoverGeoBacklinkCandidates(project, '2026-11', [observation()], new Map([[article().url, article({ url: 'https://northstar.com/a' })]]))).toEqual([]);
    expect(discoverGeoBacklinkCandidates(project, '2026-11', [observation()], new Map([[article().url, article({ topicRelevant: false })]]))).toEqual([]);
    expect(discoverGeoBacklinkCandidates(project, '2026-12', [observation()])).toEqual([]);
    expect(discoverGeoBacklinkCandidates(project, '2026-11', [])).toEqual([]);
  });
  it('normalizes known redirects even when content is unavailable and merges redirected copies', () => {
    const unknownRedirect = { ...unknownGeoBacklinkArticle('https://northstar.com/a'), reason: 'Redirected page unavailable' };
    expect(discoverGeoBacklinkCandidates(project, '2026-11', [observation()], new Map([[article().url, unknownRedirect]]))).toEqual([]);
    const second = 'https://secondpublisher.com/copy';
    const evidence = article({ url: 'https://editorial.com/canonical' });
    const observed = observation({ citations: [{ url: article().url, title: 'First' }, { url: second, title: 'Second' }] });
    const selected = discoverGeoBacklinkCandidates(project, '2026-11', [observed], new Map([[article().url, evidence], [second, evidence]]));
    expect(selected).toHaveLength(1);
    expect(selected[0].domain).toBe('editorial.com');
    expect(selected[0].evidence.observations).toHaveLength(1);
  });
  it('gives recent consistent evidence more weight than older equally frequent evidence', () => {
    const older = observation({ citations: [{ url: 'https://olderpublisher.com/a', title: 'Older' }], at: '2026-10-02T10:00:00.000Z' });
    const recent = observation({ key: 'recent', scanGroupId: 'recent:openai', citations: [{ url: 'https://recentpublisher.com/a', title: 'Recent' }], at: '2026-10-29T10:00:00.000Z' });
    const candidates = discoverGeoBacklinkCandidates(project, '2026-11', [older, recent]);
    expect(candidates[0].domain).toBe('recentpublisher.com');
    expect(candidates[0].scoreBreakdown.citationConsistency).toBeGreaterThan(candidates[1].scoreBreakdown.citationConsistency);
  });
});

describe('deterministic monthly allocation', () => {
  it('reserves 5/3/1/1 and returns the same selections after reordering input', () => {
    const candidates = (['P1', 'P2', 'P3', 'P4'] as const).flatMap((priority, index) => Array.from({ length: 8 }, (_, i) => candidate(`publisher${index}${i}.com`, priority, 90 - index * 10 - i)));
    const selected = selectGeoBacklinkCandidates(candidates, [], new Date('2026-11-01'), settings);
    expect(['P1', 'P2', 'P3', 'P4'].map(priority => selected.filter(item => item.priority === priority).length)).toEqual([5, 3, 1, 1]);
    expect(selectGeoBacklinkCandidates([...candidates].reverse(), [], new Date('2026-11-01'), settings).map(item => item.domain)).toEqual(selected.map(item => item.domain));
  });
  it('redistributes unavailable priorities, selects distinct domains and accepts fewer than ten', () => {
    const candidates = [candidate('publisher.com'), candidate('publisher.com', 'P2'), candidate('second.com', 'P4')];
    expect(selectGeoBacklinkCandidates(candidates, [], new Date('2026-11-01'))).toHaveLength(2);
    expect(selectGeoBacklinkCandidates(candidates, [ledger('publisher.com', '2026-10-31T00:00:00.000Z')], new Date('2026-11-01')).map(item => item.domain)).toEqual(['second.com']);
  });
});

describe('publication-relative progress', () => {
  const publication = recommendation();
  const before = observation({ key: 'before', at: '2026-11-01T12:00:00.000Z' });
  const after = observation({ key: 'after', at: '2026-11-20T12:00:00.000Z', brandMentioned: true, brandRank: 2 });
  it('uses actual publication time with end-exclusive baseline and waits for each checkpoint', () => {
    const baseline = geoBacklinkPerformanceSnapshot(publication, [before, after], 0, new Date('2026-11-11'))!;
    expect(baseline.start).toBe('2026-10-11T12:00:00.000Z');
    expect(baseline.end).toBe(publication.publishedAt);
    expect(baseline.metrics.answers).toBe(1);
    expect(geoBacklinkPerformanceSnapshot(publication, [before, after], 30, new Date('2026-12-10T11:59:59.999Z'))).toBeNull();
    const result = geoBacklinkPerformanceSnapshot(publication, [before, after], 30, new Date('2026-12-10T12:00:00.000Z'), baseline)!;
    expect(result.end).toBe('2026-12-10T12:00:00.000Z');
    expect(result.metrics.brandMentionRate).toBe(100);
    expect(result.delta.brandMentionRate).toBe(100);
    expect(result.caveat).toContain('correlations');
    expect(geoBacklinkPerformanceSnapshot(publication, [], 60, new Date('2027-03-01'))!.end).toBe('2027-01-09T12:00:00.000Z');
    expect(geoBacklinkPerformanceSnapshot(publication, [], 90, new Date('2027-03-01'))!.end).toBe('2027-02-08T12:00:00.000Z');
  });
  it('excludes changed prompt versions and changed text, and does not invent source attribution', () => {
    const changed = [after, { ...after, key: 'changed-version', promptVersion: 2 }, { ...after, key: 'changed-text', promptText: 'A different question' }];
    const result = geoBacklinkPerformanceSnapshot(publication, [before, ...changed], 30, new Date('2026-12-11'))!;
    expect(result.metrics.answers).toBe(1);
    expect(result.excludedChangedPrompts).toBe(2);
    const unattributed = geoBacklinkPerformanceSnapshot(publication, [before, { ...after, citations: [] }], 30, new Date('2026-12-11'))!;
    expect(unattributed.metrics.attribution).toBe('unattributed');
    expect(unattributed.metrics.articleCitationRate).toBe(0);
    expect(unattributed.referralTraffic).toBeNull();
  });
  it('reports insufficient data when baseline-compatible evidence is absent and preserves status input', () => {
    const result = geoBacklinkPerformanceSnapshot(publication, [after], 30, new Date('2026-12-11'))!;
    expect(result.status).toBe('insufficient_data');
    expect(result.delta.brandMentionRate).toBeNull();
    expect(publication.status).toBe('published');
    expect(geoBacklinkPerformanceSnapshot(recommendation({ publishedAt: null }), [], 0, new Date())).toBeNull();
  });
  it('creates a new measurement identity when a publication URL is corrected', () => {
    const original = geoBacklinkPerformanceSnapshot(publication, [before, after], 30, new Date('2026-12-11'))!;
    const corrected = geoBacklinkPerformanceSnapshot({ ...publication, publishedUrl: 'https://publisher.com/corrected-url' }, [before, after], 30, new Date('2026-12-11'))!;
    expect(corrected.id).not.toBe(original.id);
    expect(corrected.publicationUrl).toBe('https://publisher.com/corrected-url');
    expect(corrected.metrics.attribution).toBe('unattributed');
  });
  it('does not report an invented citation rate when no target article is being measured', () => {
    const metrics = geoBacklinkMetrics([before, after]);
    expect(metrics.articleCitationRate).toBeNull();
    expect(metrics.domainCitationRate).toBeNull();
    expect(metrics.brandMentionRate).toBe(50);
  });
});
