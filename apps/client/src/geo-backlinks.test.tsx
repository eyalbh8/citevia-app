// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GEO_BACKLINK_SETTINGS, type GeoBacklinkMonthlyReport, type GeoBacklinkRecommendation, type GeoBacklinkPerformanceSnapshot, type Project } from '@citevia/core';
import { project as fixtureProject } from '../../scanner/test/fixtures';

const mocks = vi.hoisted(() => ({ useApi: vi.fn(), request: vi.fn(), idempotentPost: vi.fn(), invalidateApiQueries: vi.fn(), notify: vi.fn(), onSaved: vi.fn() }));
vi.mock('./api', async () => ({ ...mocks, ApiError: (await import('./api-error')).ApiError, query: (values: Record<string, unknown>) => { const params = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value != null && value !== '') params.set(key, String(value)); return `?${params}`; } }));
vi.mock('./query-cache', () => ({ invalidateApiQueries: mocks.invalidateApiQueries }));
import GeoBacklinksView, { type GeoBacklinkProgress } from './GeoBacklinksView';
import GeoBacklinkSettings from './GeoBacklinkSettings';

let root: Root, container: HTMLDivElement, project: Project, report: GeoBacklinkMonthlyReport, recommendation: GeoBacklinkRecommendation;
let reportError: Error | undefined;
let progress: GeoBacklinkProgress;
const base = '/projects/geo-test/geo-backlinks';
const createdAt = '2026-11-01T04:00:00.000Z';
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  project = { ...structuredClone(fixtureProject), id: 'geo-test', timezone: 'Asia/Nicosia', geoBacklinks: { ...DEFAULT_GEO_BACKLINK_SETTINGS, enabled: true } };
  report = { id: 'report-test', projectId: project.id, month: '2026-11', status: 'completed', version: 1, createdAt, updatedAt: createdAt, generatedAt: createdAt, analysisStart: '2026-09-30T21:00:00Z', analysisEnd: '2026-10-31T22:00:00Z', timezone: project.timezone, scanCount: 8, answerCount: 20, candidateCount: 1, excludedCount: 0, algorithmVersion: 'geo-backlinks-v1', settings: project.geoBacklinks!, selectedRecommendationIds: ['rec-test'], warnings: [] };
  recommendation = { id: 'rec-test', projectId: project.id, reportId: report.id, month: report.month, domain: 'publisher.test', url: 'https://publisher.test/article', priority: 'P4', recommendedAt: createdAt, eligibleAgainAt: '2027-04-30T04:00:00Z', status: 'recommended', candidate: {
    id: 'candidate-test', projectId: project.id, domain: 'publisher.test', url: 'https://publisher.test/article', title: 'Relevant article', firstDiscoveredAt: createdAt, lastSeenAt: createdAt, evaluatedMonth: report.month, priority: 'P4', category: 'secondary', score: 42, scoreBreakdown: { citationConsistency: 12, competitorGap: 0, relevance: 20, visibilityGap: 10, placement: 0 }, explanation: ['Observed in four distinct completed scans.'], action: 'Verify the article and seek accurate editorial coverage.', evidence: {
      article: { status: 'unavailable', url: 'https://publisher.test/article', verifiedAt: null, title: null, publisher: null, brandPresence: 'unknown', competitors: [], brandPosition: null, hasBrandLink: null, links: [], topicRelevant: null, marketRelevant: null, outdated: null, placementOpportunity: 'unknown', excerpts: [], reason: 'Publisher blocked retrieval.' },
      observations: [{ key: 'obs-test', runId: 'run-test', scanGroupId: 'group-test', responseId: 'response-test', provider: 'gemini', at: createdAt, promptId: 'prompt-test', promptVersion: 2, promptText: 'Which provider fits this market?', topic: 'Providers', country: 'CY', brandMentioned: false, brandRank: null, competitors: [], citations: [{ url: 'https://publisher.test/article', title: 'Relevant article' }] }], providers: ['gemini'], prompts: [{ id: 'prompt-test', version: 2, text: 'Which provider fits this market?', topic: 'Providers' }], distinctScans: 4, totalScans: 8, citationConsistency: 50, recentConsistency: 50, aiBrandMentionRate: 0, aiAverageBrandRank: null, aiCompetitors: ['Other brand'], firstCitedAt: createdAt, lastCitedAt: createdAt,
    },
  }, contactedAt: null, publishedAt: null, publishedUrl: null, finalDomain: null, landingPage: null, placementType: null, linkType: 'unknown', cost: null, currency: null, notes: '', ownerId: null, version: 1, createdAt, updatedAt: createdAt };
  reportError = undefined;
  progress = { months: [], placements: [] };
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.useApi.mockImplementation((path: string | null) => {
    if (!path) return { data: undefined, loading: false };
    if (path.includes('/reports/')) return { data: reportError ? undefined : { report, recommendations: [recommendation] }, error: reportError, loading: false };
    if (path.includes('/recommendations/')) return { data: { recommendation, activities: [], snapshots: [] }, loading: false };
    if (path.includes('/recommendations?')) return { data: { items: [recommendation], total: 1 }, loading: false };
    if (path.endsWith('/progress')) return { data: progress, loading: false };
    return { data: undefined, loading: false };
  });
  mocks.idempotentPost.mockResolvedValue({ report });
  mocks.request.mockImplementation(async (_path: string, options: RequestInit) => ({ ...project, ...JSON.parse(String(options.body)), version: 2 }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(systemAdmin = true) { await act(async () => root.render(<GeoBacklinksView project={project} systemAdmin={systemAdmin} notify={mocks.notify} />)); }
function button(text: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text)!; }
async function changeSelect(label: string, value: string) { const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); }

describe('GEO backlink strategy', () => {
  it('requires system administrator access before making data requests', async () => {
    await render(false);
    expect(container.textContent).toContain('Administrator access required');
    expect(mocks.useApi).not.toHaveBeenCalled();
  });
  it('requires explicit project enablement before making data requests', async () => {
    delete project.geoBacklinks;
    await render();
    expect(container.textContent).toContain('Enable your monthly strategy');
    expect(mocks.useApi).not.toHaveBeenCalled();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('#settings');
  });
  it('keeps unverified article presence separate from absent AI answer mentions', async () => {
    await render();
    expect(container.textContent).toContain('Customer: Unknown');
    expect(container.textContent).toContain('4 / 8 scans');
    await act(async () => button('publisher.test').click());
    const drawer = document.querySelector('[role="dialog"]')!;
    expect(drawer.textContent).toContain('Unavailable — presence unknown');
    expect(drawer.textContent).toContain('Customer mention rate: 0.0%');
    expect(drawer.textContent).toContain('Publisher blocked retrieval.');
    expect(drawer.textContent).toContain('Customer mentioned in this answerNo');
    expect(drawer.textContent).not.toContain('Customer: Absent');
  });
  it('submits monthly generation to the shared idempotent endpoint', async () => {
    await render();
    await act(async () => button('Open saved report').click());
    expect(mocks.idempotentPost).toHaveBeenCalledWith(`${base}/reports`, { month: expect.stringMatching(/^\d{4}-\d{2}$/) });
    expect(mocks.invalidateApiQueries).toHaveBeenCalledWith(base);
  });
  it('sends provider and status filters to the paginated backend query', async () => {
    await render();
    await changeSelect('Filter provider', 'perplexity');
    await changeSelect('Filter status', 'rejected');
    const requested = mocks.useApi.mock.calls.map(call => call[0]).filter(Boolean);
    expect(requested.some(path => path.includes('/recommendations?') && path.includes('provider=perplexity') && path.includes('status=rejected') && path.includes('offset=0') && path.includes('limit=25'))).toBe(true);
  });
  it('preserves original publication timestamps when editing lifecycle notes', async () => {
    recommendation.status = 'published'; recommendation.publishedAt = '2026-10-14T06:17:00.000Z'; recommendation.publishedUrl = 'https://publisher.test/published';
    await render(); await act(async () => button('publisher.test').click());
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(mocks.request).toHaveBeenCalledOnce();
    const [path, options] = mocks.request.mock.calls[0];
    expect(path).toBe(`${base}/recommendations/rec-test`);
    expect(JSON.parse(options.body)).toMatchObject({ version: 1, status: 'published', publishedAt: '2026-10-14T06:17:00.000Z', publishedUrl: 'https://publisher.test/published' });
  });
  it('renders report errors with retry and does not invent report totals', async () => {
    reportError = new Error('Report unavailable'); await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Report unavailable');
    expect(container.querySelector('[aria-label="Monthly report summary"]')).toBeNull();
    await act(async () => button('Try again').click()); expect(mocks.invalidateApiQueries).toHaveBeenCalledWith(base);
  });
  it('excludes checkpoint evidence for a replaced publication URL', async () => {
    recommendation.publishedAt = '2026-10-14T06:17:00.000Z';
    recommendation.publishedUrl = 'https://publisher.test/replacement';
    const snapshot: GeoBacklinkPerformanceSnapshot = {
      id: 'snapshot-old-url', projectId: project.id, recommendationId: recommendation.id, checkpoint: 0,
      publicationDate: recommendation.publishedAt, publicationUrl: 'https://publisher.test/original',
      start: '2026-09-14T06:17:00.000Z', end: recommendation.publishedAt, measuredAt: createdAt, status: 'measured',
      comparablePromptKeys: ['prompt-test:2:gemini'], excludedChangedPrompts: 0,
      metrics: { answers: 10, scans: 3, brandMentionRate: 99, averageBrandRank: 1, domainCitationRate: 99,
        articleCitationRate: 99, uniqueReferringDomains: 1, competitorRates: [], attribution: 'attributed' }, providers: {},
      article: { ...recommendation.candidate!.evidence.article, status: 'verified', brandPresence: 'present', hasBrandLink: true },
      delta: { brandMentionRate: null, averageBrandRank: null, domainCitationRate: null }, referralTraffic: null, conversions: null, caveat: '',
    };
    progress.placements = [{ recommendation, snapshots: [snapshot] }];
    await render(); await act(async () => button('GEO progress & analytics').click());
    expect(container.textContent).toContain('0 confirmed backlinks');
    expect(container.textContent).toContain('1 placements awaiting article verification');
    expect(container.textContent).not.toContain('99.0%');
    snapshot.publicationUrl = recommendation.publishedUrl;
    await render();
    expect(container.textContent).toContain('1 confirmed backlinks');
    expect(container.textContent).toContain('99.0%');
  });
  it('refreshes performance independently from immutable monthly selection', async () => {
    await render(); await act(async () => button('GEO progress & analytics').click());
    await act(async () => button('Refresh measurements').click());
    expect(mocks.idempotentPost).toHaveBeenCalledWith(`${base}/progress/refresh`);
    expect(mocks.idempotentPost.mock.calls.some(call => call[0] === `${base}/reports`)).toBe(false);
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('existing scan data'));
  });
  it('polls a pending background summary and stops when preparation finishes', async () => {
    vi.useFakeTimers();
    progress = { months: [], placements: [], pending: true, evaluatedAt: null, caveat: 'Measurements are being prepared from saved scans.' };
    await render(); await act(async () => button('GEO progress & analytics').click());
    expect(container.querySelector('.geo-note[role="status"]')?.textContent).toContain('being prepared from saved scans');
    expect(container.textContent).not.toContain('Track your first published placement');
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(mocks.invalidateApiQueries).toHaveBeenCalledWith(`${base}/progress`);
    progress = { ...progress, pending: false, evaluatedAt: createdAt };
    await render();
    expect(container.querySelector('.geo-note[role="status"]')).toBeNull();
    mocks.invalidateApiQueries.mockClear();
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(mocks.invalidateApiQueries).not.toHaveBeenCalled();
  });
  it('keeps a manual refresh pending until a newer saved summary arrives', async () => {
    vi.useFakeTimers();
    progress.evaluatedAt = createdAt;
    await render(); await act(async () => button('GEO progress & analytics').click());
    await act(async () => button('Refresh measurements').click());
    expect(button('Preparing measurements…').disabled).toBe(true);
    expect(container.querySelector('.geo-note[role="status"]')?.textContent).toContain('last saved results remain visible');
    mocks.invalidateApiQueries.mockClear();
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(mocks.invalidateApiQueries).toHaveBeenCalledWith(`${base}/progress`);
    progress = { ...progress, evaluatedAt: '2026-11-02T04:00:00.000Z' };
    await render();
    expect(button('Refresh measurements').disabled).toBe(false);
    expect(container.querySelector('.geo-note[role="status"]')).toBeNull();
    mocks.invalidateApiQueries.mockClear();
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(mocks.invalidateApiQueries).not.toHaveBeenCalled();
  });
  it('shows empty performance without fabricated measurements', async () => {
    await render(); await act(async () => button('GEO progress & analytics').click());
    expect(container.textContent).toContain('Not measured');
    expect(container.textContent).toContain('Not comparable');
    expect(container.textContent).toContain('Track your first published placement');
  });
});

describe('GEO project toggle', () => {
  it('defaults off and saves only the explicit feature configuration', async () => {
    delete project.geoBacklinks;
    await act(async () => root.render(<GeoBacklinkSettings project={project} path="/projects/geo-test" onSaved={mocks.onSaved} notify={mocks.notify} />));
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle.click());
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({ version: project.version, geoBacklinks: { ...DEFAULT_GEO_BACKLINK_SETTINGS, enabled: true } });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('#geo-backlinks');
  });
  it('disables an enabled project without submitting server-owned timestamps', async () => {
    project.geoBacklinks = { ...project.geoBacklinks!, enabledAt: createdAt, target: 7, exclusionDays: 200, excludedDomains: ['excluded.example'] };
    await act(async () => root.render(<GeoBacklinkSettings project={project} path="/projects/geo-test" onSaved={mocks.onSaved} notify={mocks.notify} />));
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => toggle.click());
    const payload = JSON.parse(mocks.request.mock.calls[0][1].body);
    expect(payload.geoBacklinks).not.toHaveProperty('enabledAt');
    expect(payload.geoBacklinks).toEqual({ enabled: false, target: 7, exclusionDays: 200, excludedDomains: ['excluded.example'], weights: DEFAULT_GEO_BACKLINK_SETTINGS.weights });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
  it('keeps the saved state visible after a failed toggle', async () => {
    mocks.request.mockRejectedValue(new Error('Settings conflict. Refresh and try again.'));
    await act(async () => root.render(<GeoBacklinkSettings project={project} path="/projects/geo-test" onSaved={mocks.onSaved} notify={mocks.notify} />));
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Settings conflict');
  });
});
