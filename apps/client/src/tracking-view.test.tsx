// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackingRows, type Project, type TrackingSummary } from '@citevia/core';

const { useApi, request } = vi.hoisted(() => ({ useApi: vi.fn(), request: vi.fn() }));
vi.mock('./api', async (original) => ({ ...(await original<object>()), useApi, request }));
import TrackingView from './TrackingView';

const project = { id: 'tracking-account', name: 'Northstar', brand: { name: 'Northstar' }, country: 'US', role: 'owner' } as Project;
const period: TrackingSummary['period'] = { start: '2026-10-29T00:00:00.000Z', end: '2026-11-04T12:00:00.000Z', granularity: 'daily', timezone: 'UTC' };
const row = {
  ...trackingRows([{
    id: 'e618f64d-6683-4d7e-925b-d4fa26bebfb6', projectId: project.id,
    url: 'https://northstar.example/blog/metrics', normalizedUrl: 'northstar.example/blog/metrics',
    title: 'Choose useful metrics', contentType: 'BLOG', active: true,
    createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z', publishedAt: '2026-05-01T00:00:00.000Z', version: 1,
  }], [], period, new Date(period.end))[0],
  appearances: 999, periodAppearances: 3,
};
const summary: TrackingSummary = {
  period, trackedCount: 1, trackedThisMonth: 0, appearances: 3, citedCount: 1, citedRate: 100, medianPickup: null, clicks: null,
  series: Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.parse(period.start) + i * 86400000).toISOString().slice(0, 10), citations: i === 6 ? 3 : 0, mentions: 0, published: 0 })),
};
let root: Root, container: HTMLDivElement;
let state: 'loading' | 'ready' | 'error';
async function render(demo?: Project['demo']) {
  await act(async () => root.render(createElement(TrackingView, { path: `/projects/${project.id}`, project: { ...project, demo }, onResponse: vi.fn(), notify: vi.fn() })));
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label || element.getAttribute('aria-label') === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

describe('Tracking report', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(period.end));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.clearAllMocks();
    state = 'ready';
    useApi.mockImplementation((path: string) => ({
      loading: state === 'loading',
      error: state === 'error' ? new Error('Tracking could not be loaded') : undefined,
      data: state !== 'ready' ? undefined : path.includes('/summary') ? summary : path.includes('/tracked-urls?') ? { items: [row], total: 1 } : undefined,
    }));
    request.mockResolvedValue(row);
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

  it.each([undefined, 'igeo-nayax', 'igeo-dr-roof', 'website-demo'] as const)('opens %s accounts on seven days and requests both report endpoints', async (source) => {
    await render(source ? { version: 1, source, anchorDate: '2026-10-23', startDate: '2026-04-23', endDate: '2027-04-23', sourceAccountId: 'source', sourceCopiedAt: '2026-10-23T00:00:00.000Z' } : undefined);
    expect(container.querySelector('[aria-label="Date range: Last 7 days"]')).not.toBeNull();
    const paths = useApi.mock.calls.map(([path]) => path as string);
    expect(paths).toHaveLength(2);
    expect(paths.some(path => path.includes('/tracked-urls/summary?'))).toBe(true);
    for (const path of paths) {
      expect(path).toContain('days=7');
      expect(path).not.toMatch(/start=|end=|custom/);
    }
  });

  it('renders fetched content and daily chart labels after loading', async () => {
    state = 'loading';
    await render();
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    state = 'ready';
    await render();
    expect(container.querySelector('table')?.textContent).toContain(row.title);
    expect(container.querySelector('td[title="Source occurrences during the selected period"] strong')?.textContent).toBe('3');
    expect(container.textContent).toContain('Daily totals · Selected period');
    expect(container.textContent).not.toContain('Invalid Date');
    expect(container.querySelectorAll('.tracking-month')).toHaveLength(7);
    expect(container.querySelector('.tracking-month')?.textContent).toContain('29 Oct');
  });

  it('can retry failed content and summary requests', async () => {
    state = 'error';
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Tracking could not be loaded');
    await click('Try again');
    expect(useApi.mock.calls.slice(-2).map(([, revision]) => revision)).toEqual([1, 1]);
    state = 'ready';
    await render();
    expect(container.querySelector('table')?.textContent).toContain(row.title);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders UTC hour labels for a 24-hour report', async () => {
    useApi.mockImplementation((path: string) => ({
      data: path.includes('/summary') ? {
        ...summary, period: { ...period, granularity: 'hourly' },
        series: [{ date: '2026-11-04T09:00:00.000Z', citations: 3, mentions: 0, published: 0 }],
      } : { items: [row], total: 1 },
    }));
    await render();
    expect(container.textContent).toContain('Hourly totals · Selected period');
    expect(container.querySelector('.tracking-month')?.textContent).toContain('09:00');
    expect(container.textContent).not.toContain('Invalid Date');
  });

  it('updates both endpoints with a date change and returns to seven days after adding a URL', async () => {
    await render();
    await click('Date range: Last 7 days');
    await click('Last 30 days');
    expect(useApi.mock.calls.slice(-2).every(([path]) => (path as string).includes('days=30'))).toBe(true);
    await click('Track results');
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('input[type="url"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, row.url);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(request).toHaveBeenCalledWith(`/projects/${project.id}/tracked-urls`, { method: 'POST', body: JSON.stringify({ url: row.url }) });
    expect(container.querySelector('[aria-label="Date range: Last 7 days"]')).not.toBeNull();
    expect(useApi.mock.calls.filter(([path]) => /tracked-urls(?:\/summary)?\?/.test(path as string)).slice(-2).every(([path]) => (path as string).includes('days=7'))).toBe(true);
  });
});
