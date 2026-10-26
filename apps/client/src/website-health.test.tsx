// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, WebsiteHealthAudit, WebsiteHealthDevice, WebsiteHealthPage } from '@citevia/core';

const mocks = vi.hoisted(() => ({ useApi: vi.fn(), idempotentPost: vi.fn(), invalidateApiQueries: vi.fn() }));
vi.mock('./api', () => ({ ...mocks, ApiError: class extends Error {} }));
vi.mock('./query-cache', () => ({ invalidateApiQueries: mocks.invalidateApiQueries }));
import WebsiteHealthView, { previousWebsiteHealthAudit, websiteHealthChecklist } from './WebsiteHealthView';

const path = '/projects/health-test';
const project = { id: 'health-test', role: 'owner', brand: { name: 'Health', domains: ['example.com'] } } as Project;
function report(id = 'latest', createdAt = '2026-10-26T09:00:00Z', url = 'https://example.com/'): WebsiteHealthAudit {
  function device(strategy: WebsiteHealthDevice) {
    return {
      status: 'completed' as const,
      lab: {
        strategy, requestedUrl: url, finalUrl: url, fetchedAt: createdAt, lighthouseVersion: '13.0',
        scores: { performance: strategy === 'mobile' ? 62 : 96, accessibility: 88, 'best-practices': 100, seo: null },
        metrics: [{ id: 'lcp', title: 'Largest Contentful Paint', value: null, unit: 'ms' as const, displayValue: '', rating: 'unknown' as const }],
        issues: [
          { id: 'image', category: 'performance' as const, title: 'Optimize images', description: 'Use appropriately sized images.', priority: 'low' as const, resources: [] },
          { id: 'render', category: 'performance' as const, title: 'Reduce render-blocking resources', description: 'Defer **nonessential scripts**. [Read guidance](https://example.com/help). <script>alert(1)</script>', priority: 'high' as const, savingsMs: 1200, savingsBytes: 20480, resources: ['https://example.com/main.js'] },
        ], warnings: [],
      },
      field: { status: 'unavailable' as const, metrics: [] },
    };
  }
  return { id, projectId: 'health-test', url, createdAt, updatedAt: createdAt, status: 'completed', results: { mobile: device('mobile'), desktop: device('desktop') } };
}
let root: Root, container: HTMLDivElement, page: WebsiteHealthPage;
let failures: Record<string, Error>;
let extras: WebsiteHealthAudit[];
let detailPending: boolean;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  page = { items: [report()], total: 1, nextCursor: null, auditingAvailable: true, cruxAvailable: true, defaultUrl: 'https://example.com/' };
  failures = {};
  extras = [];
  detailPending = false;
  mocks.useApi.mockReset();
  mocks.idempotentPost.mockReset();
  mocks.invalidateApiQueries.mockReset();
  mocks.useApi.mockImplementation((requested: string | null) => {
    if (!requested) return { data: undefined, loading: false };
    if (requested.includes('?cursor=')) return { data: page, loading: false, error: failures[requested] };
    if (detailPending) return { data: undefined, loading: true, error: failures[requested] };
    const audit = [...extras, ...page.items].find(item => requested.endsWith(`/${item.id}`));
    return { data: audit ? { audit } : undefined, loading: false, error: failures[requested] };
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(account = project) {
  await act(async () => root.render(<WebsiteHealthView project={account} path={path} notify={vi.fn()} />));
}
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)!;
}
function score(label: string) { return container.querySelector(`[aria-label="${label} score"]`)!; }

describe('Website Health reports', () => {
  it('renders initial history loading before any report has been selected', async () => {
    mocks.useApi.mockImplementation((requested: string | null) => ({
      data: undefined,
      loading: Boolean(requested?.includes('?cursor=')),
    }));
    await render();
    expect(container.textContent).toContain('Website Health');
    expect(container.textContent).toContain('Loading saved website audits');
    expect(container.querySelector('.health-report')).toBeNull();
  });

  it('shows the first-audit empty state when the account has no saved reports', async () => {
    page.items = [];
    page.total = 0;
    await render();
    expect(container.textContent).toContain('Your next improvement starts here');
    expect(button('Run audit').disabled).toBe(false);
    expect(container.querySelector('.health-report')).toBeNull();
  });

  it('keeps a failed initial history request visible and retryable without a selected report', async () => {
    mocks.useApi.mockImplementation((requested: string | null) => ({
      data: undefined,
      loading: false,
      error: requested?.includes('?cursor=') ? new Error('Website audit history is temporarily unavailable') : undefined,
    }));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Website audit history is temporarily unavailable');
    await act(async () => button('Try again').click());
    expect(mocks.invalidateApiQueries).toHaveBeenCalledWith(`${path}/website-health`);
    expect(container.querySelector('.health-report')).toBeNull();
  });

  it('shows missing values honestly and switches the selected device', async () => {
    await render();
    expect(score('Performance').querySelector('.health-score-number')?.textContent).toContain('62');
    expect(score('SEO').textContent).toContain('Not measured');
    expect(score('SEO').textContent).not.toContain('/ 100');
    expect(container.querySelector('.health-metric strong')?.textContent).toBe('—');
    expect(container.textContent).toContain('Not enough real-user data');
    await act(async () => button('Desktop').click());
    expect(score('Performance').querySelector('.health-score-number')?.textContent).toContain('96');
    expect(button('Desktop').getAttribute('aria-pressed')).toBe('true');
    expect(button('Mobile').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the real-user period and makes an origin fallback explicit', async () => {
    page.items[0].results.mobile.field = { status: 'available', scope: 'origin', url: 'https://example.com', collectionPeriod: { start: '2026-09-29', end: '2026-10-26' }, metrics: [{ id: 'lcp', title: 'Largest Contentful Paint', value: 2400, unit: 'ms', displayValue: '2.4 s', rating: 'good' }] };
    await render();
    const field = container.querySelector('.health-field')!;
    expect(field.textContent).toContain('rolling 28-day period');
    expect(field.textContent).toContain('Whole website (origin)');
    expect(field.textContent).toContain('Page-level data was unavailable');
    expect(field.textContent).toContain('Sep 29, 2026');
    expect(field.textContent).toContain('Oct 26, 2026');
    expect(field.textContent).toContain('2.4 s');
  });

  it('prioritizes fixes, renders descriptions safely, and shows resources and estimated savings', async () => {
    await render();
    const first = container.querySelector('.health-issue')!;
    expect(first.textContent).toContain('Reduce render-blocking resources');
    expect(first.querySelector('strong')?.textContent).toBe('nonessential scripts');
    expect(first.querySelector('script')).toBeNull();
    expect(first.querySelector('a')?.getAttribute('rel')).toBe('noreferrer noopener');
    expect(first.textContent).toContain('Save ~1.2 s · 20 KiB');
    expect(first.textContent).toContain('https://example.com/main.js');
    expect(container.textContent).toContain('not guaranteed or additive');
    await act(async () => button('Accessibility').click());
    expect(container.querySelectorAll('.health-issue')).toHaveLength(0);
    expect(container.textContent).toContain('No recommendations in this category');
  });

  it('compares only the previous completed device report for the same URL', async () => {
    const matching = report('matching', '2026-10-20T09:00:00Z');
    matching.results.mobile.lab!.scores.performance = 50;
    matching.results.desktop.lab!.scores.performance = 99;
    const otherUrl = report('other-url', '2026-10-25T09:00:00Z', 'https://example.com/contact');
    const failed = report('failed-device', '2026-10-24T09:00:00Z');
    failed.results.mobile = { status: 'failed', error: { code: 'TEST', message: 'Failed' } };
    page.items.push(otherUrl, failed, matching);
    page.total = 4;
    await render();
    const delta = score('Performance').querySelector('.health-score-change')!;
    expect(delta.textContent).toContain('12 points');
    expect(delta.getAttribute('title')).toContain('Oct 20, 2026');
    expect(delta.classList.contains('up')).toBe(true);
    await act(async () => button('Desktop').click());
    // The later failed mobile report has a completed desktop, so it is the correct desktop comparison.
    expect(score('Performance').querySelector('.health-score-change')?.textContent).toContain('No score change');
  });

  it.each([{ role: 'viewer' }, { role: 'owner', demo: true }])('keeps $role demo=$demo audits read-only', async access => {
    await render({ ...project, ...access } as Project);
    expect(button('Run audit').disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('#health-page-url')!.disabled).toBe(true);
    expect(button('Recheck page')).toBeUndefined();
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(mocks.idempotentPost).not.toHaveBeenCalled();
  });

  it('explains unavailable configuration without exposing environment variables', async () => {
    page.auditingAvailable = false;
    page.cruxAvailable = false;
    page.items[0].results.mobile.field = { status: 'not_configured', metrics: [] };
    await render();
    expect(button('Run audit').disabled).toBe(true);
    expect(container.textContent).toContain('Ask your administrator to enable Google PageSpeed');
    expect(container.textContent).toContain('Real-user data is not connected yet');
    expect(container.textContent).not.toMatch(/API_KEY|GOOGLE_/);
  });

  it('queues a saved report and polls only while an audit is active', async () => {
    vi.useFakeTimers();
    await render();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(mocks.invalidateApiQueries).not.toHaveBeenCalled();
    const queued = report('queued', '2026-10-26T11:00:00Z');
    queued.status = 'queued';
    queued.results = { mobile: { status: 'queued' }, desktop: { status: 'queued' } };
    extras.push(queued);
    mocks.idempotentPost.mockResolvedValue({ audit: queued });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(mocks.idempotentPost).toHaveBeenCalledWith(`${path}/website-health/audits`, { url: 'https://example.com/' });
    expect(button('Audit in progress').disabled).toBe(true);
    expect(container.textContent).toContain('Mobile audit is queued');
    mocks.invalidateApiQueries.mockClear();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(mocks.invalidateApiQueries).toHaveBeenCalledExactlyOnceWith(`${path}/website-health`);
    queued.status = 'completed';
    queued.results = report().results;
    page.items.unshift(queued);
    await render();
    mocks.invalidateApiQueries.mockClear();
    await act(async () => vi.advanceTimersByTime(10000));
    expect(mocks.invalidateApiQueries).not.toHaveBeenCalled();
  });

  it('preserves a report selected from history when newer results arrive', async () => {
    const old = report('older', '2026-10-20T09:00:00Z', 'https://example.com/about');
    page.items.push(old);
    await render();
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.health-history-item')[1].click());
    expect(container.querySelector<HTMLInputElement>('#health-page-url')!.value).toBe(old.url);
    page = { ...page, items: [report('new', '2026-10-26T12:00:00Z'), ...page.items], defaultUrl: 'https://example.com/changed' };
    await render();
    expect(container.querySelector<HTMLInputElement>('#health-page-url')!.value).toBe(old.url);
    expect(container.querySelector('.health-report-heading h2')?.textContent).toBe(old.url);
    expect(container.querySelector('.health-history-item[aria-pressed=true]')?.textContent).toContain(old.url);
  });

  it('waits for full detail before declaring recommendations or real-user data unavailable', async () => {
    page.items[0].summaryOnly = true;
    page.items[0].results.mobile.lab!.issues = [];
    page.items[0].results.mobile.lab!.metrics = [];
    delete page.items[0].results.mobile.field;
    detailPending = true;
    await render();
    expect(container.textContent).toContain('Loading this audit’s measurements and recommendations');
    expect(container.textContent).not.toContain('No actionable issues');
    expect(container.textContent).not.toContain('Real-user data is not connected');
    expect(container.querySelector('.health-field')).toBeNull();
    detailPending = false;
    extras.push(report());
    await render();
    expect(container.textContent).toContain('Reduce render-blocking resources');
  });

  it('keeps a summary detail error retryable without showing false empty measurements', async () => {
    page.items[0].summaryOnly = true;
    detailPending = true;
    failures[`${path}/website-health/audits/latest`] = new Error('Detail temporarily unavailable');
    await render();
    expect(container.textContent).toContain('Detail temporarily unavailable');
    expect(container.textContent).toContain('Report details could not be loaded');
    expect(container.querySelector('.health-field')).toBeNull();
    await act(async () => button('Try again').click());
    expect(mocks.invalidateApiQueries).toHaveBeenCalledWith(`${path}/website-health`);
  });

  it('stops polling when full detail completes an older active history summary', async () => {
    vi.useFakeTimers();
    const summary = report('older-active', '2026-10-20T09:00:00Z');
    summary.status = 'running';
    summary.summaryOnly = true;
    page.items.push(summary);
    const completed = report('older-active', '2026-10-20T09:00:00Z');
    extras.push(completed);
    await render();
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.health-history-item')[1].click());
    mocks.invalidateApiQueries.mockClear();
    await act(async () => vi.advanceTimersByTime(10000));
    expect(mocks.invalidateApiQueries).not.toHaveBeenCalled();
    expect(container.querySelector('.health-history-item[aria-pressed=true]')?.textContent).toContain('Complete');
  });

  it('provides a manual copy fallback if clipboard access is unavailable', async () => {
    await render();
    await act(async () => button('Copy for developer').click());
    expect(container.querySelector<HTMLTextAreaElement>('#health-checklist-copy')?.value).toContain('Developer checklist');
    expect(container.querySelector<HTMLTextAreaElement>('#health-checklist-copy')?.value).toContain('https://example.com/main.js');
  });
});

describe('Website Health comparison and checklist', () => {
  it('does not compare a newer report or a different URL', () => {
    const current = report();
    expect(previousWebsiteHealthAudit([report('newer', '2026-10-27T09:00:00Z'), report('different', '2026-10-25T09:00:00Z', 'https://example.com/contact')], current, 'mobile')).toBeUndefined();
  });
  it('exports the selected device, missing scores, fixes, resources and honest estimates', () => {
    const value = websiteHealthChecklist(report(), 'desktop');
    expect(value).toContain('Website Health — Desktop');
    expect(value).toContain('Performance: 96/100');
    expect(value).toContain('SEO: Not available');
    expect(value.indexOf('[HIGH]')).toBeLessThan(value.indexOf('[LOW]'));
    expect(value).toContain('https://example.com/main.js');
    expect(value).toContain('estimates overlap; do not add together');
  });
});
