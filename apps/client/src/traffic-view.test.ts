// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRAFFIC_PROVIDERS,
  type Project,
  type TrafficDashboard,
} from '@citevia/core';

const mocks = vi.hoisted(() => ({
  useApi: vi.fn(),
  request: vi.fn(),
  downloadCsv: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('./api', () => ({
  ...mocks,
  ApiError: class extends Error {},
  query: (values: Record<string, unknown>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values))
      if (value !== undefined && value !== '') params.set(key, String(value));
    return `?${params}`;
  },
}));
vi.mock('./query-cache', () => ({ invalidateApiQueries: mocks.invalidate }));
import TrafficView from './TrafficView';

const project = {
  id: 'traffic-a',
  brand: { name: 'Northstar', domains: ['northstar.example'] },
  role: 'owner',
} as Project;
const initialReport = (): TrafficDashboard => ({
  current: 24,
  previous: 12,
  period: {
    start: '2026-10-15T00:00:00.000Z',
    end: '2026-10-21T23:59:59.999Z',
    granularity: 'daily',
    timezone: 'UTC',
  },
  previousPeriod: {
    start: '2026-10-08T00:00:00.000Z',
    end: '2026-10-14T23:59:59.999Z',
    granularity: 'daily',
    timezone: 'UTC',
  },
  providers: TRAFFIC_PROVIDERS.map((provider) => ({
    provider,
    visits: 4,
    previous: 2,
  })),
  series: ['2026-10-15', '2026-10-16', '2026-10-17'].map((date) => ({
    date,
    values: { openai: 8 },
  })),
  sources: Array.from({ length: 8 }, (_, i) => ({
    label: `source-${i}.example`,
    visits: 8 - i,
  })),
  pages: [{ label: '/pricing', visits: 24 }],
  locations: [
    { label: 'US', visits: 20 },
    { label: 'CY', visits: 4 },
  ],
  devices: [
    { label: 'mobile', visits: 14 },
    { label: 'desktop', visits: 10 },
  ],
  browsers: [{ label: 'Chrome', visits: 24 }],
  countries: ['CY', 'US'],
  status: {
    hasEvents: true,
    lastReceivedAt: '2026-10-21T12:00:00.000Z',
    testReceived: false,
  },
});
let root: Root, container: HTMLDivElement, report: TrafficDashboard;
const buttons = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) =>
      b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );
async function click(label: string) {
  const button = buttons(label)[0];
  expect(button, `Button ${label}`).toBeDefined();
  await act(async () => button.click());
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  report = initialReport();
  mocks.request.mockReset();
  mocks.useApi.mockReset();
  mocks.downloadCsv.mockReset();
  mocks.useApi.mockImplementation((path: string) => ({
    data: path.includes('/status') ? report.status : report,
    loading: false,
    error: undefined,
  }));
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
async function render() {
  await act(async () =>
    root.render(
      createElement(TrafficView, {
        path: '/projects/traffic-a',
        project,
        notify: vi.fn(),
      }),
    ),
  );
}

describe('AI Traffic screen interactions', () => {
  it('renders all providers and breakdowns, pages lists, toggles chart series and exports the filtered report', async () => {
    await render();
    expect(document.querySelectorAll('.traffic-metric')).toHaveLength(7);
    expect(document.querySelectorAll('.traffic-breakdown')).toHaveLength(5);
    expect(container.textContent).toContain('source-0.example');
    expect(container.textContent).not.toContain('source-5.example');
    await click('Next top sources page');
    expect(container.textContent).toContain('source-5.example');
    expect(container.textContent).not.toContain('source-0.example');
    expect(container.textContent).toContain('6–8 of 8');
    const legend = document.querySelector<HTMLButtonElement>(
      '.traffic-legend button',
    )!;
    await act(async () => legend.click());
    expect(legend.getAttribute('aria-pressed')).toBe('false');
    await click('Export traffic CSV');
    expect(mocks.downloadCsv).toHaveBeenCalledOnce();
    expect(mocks.downloadCsv.mock.calls[0][2]).toContainEqual([
      'Page',
      '/pricing',
      24,
      '',
    ]);
  });
  it('sends independent traffic providers and countries to the API and resets filters', async () => {
    await render();
    await click('Providers');
    const claude = [
      ...document.querySelectorAll<HTMLElement>('[role=option]'),
    ].find((e) => e.getAttribute('aria-label') === 'Claude')!;
    await act(async () => claude.click());
    expect(mocks.useApi.mock.calls.at(-1)?.[0]).toContain('providers=claude');
    await act(async () =>
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })),
    );
    await click('Regions');
    const cyprus = [
      ...document.querySelectorAll<HTMLElement>('[role=option]'),
    ].find((e) => e.getAttribute('aria-label') === 'Cyprus')!;
    await act(async () => cyprus.click());
    expect(mocks.useApi.mock.calls.at(-1)?.[0]).toContain('countries=CY');
    await act(async () =>
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })),
    );
    await click('Reset filters');
    expect(mocks.useApi.mock.calls.at(-1)?.[0]).not.toContain('providers=');
    expect(mocks.useApi.mock.calls.at(-1)?.[0]).not.toContain('countries=');
  });
  it('verifies a new test ID rather than treating historical events as a successful connection', async () => {
    await render();
    await click('Settings');
    const popup = { opener: {} };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    mocks.request
      .mockResolvedValueOnce({ ...report.status, testReceived: false })
      .mockResolvedValueOnce({ ...report.status, testReceived: true });
    vi.useFakeTimers();
    await click('Test connection');
    expect(container.textContent).toContain('Waiting for your test visit');
    const url = new URL(vi.mocked(window.open).mock.calls.at(-1)![0] as string);
    expect(url.hostname).toBe('northstar.example');
    expect(url.searchParams.get('utm_source')).toBe('chatgpt');
    const id = url.searchParams.get('citevia_test');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(popup.opener).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(container.textContent).not.toContain('Connection verified');
    expect(mocks.request.mock.calls[0][0]).toContain(`testId=${id}`);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(container.textContent).toContain('Connection verified');
  });
  it('cancels a pending connection test when the settings screen unmounts', async () => {
    await render();
    await click('Settings');
    vi.spyOn(window, 'open').mockReturnValue({ opener: null } as Window);
    vi.useFakeTimers();
    await click('Test connection');
    await click('View AI traffic');
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('shows website setup for accounts with no events and keeps the zero-data dashboard available', async () => {
    report.status.hasEvents = false;
    report.current = 0;
    await render();
    expect(container.textContent).toContain(
      'Connect your website to see AI traffic',
    );
    await click('Set up tracking');
    expect(container.textContent).toContain('data-project-id="traffic-a"');
    expect(container.textContent).toContain('/api/v1/traffic/tracker.js');
  });
});
