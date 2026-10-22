// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MentionsSummary, ScanProvider } from '@citevia/core';
import { MentionsChart } from './MonitoringUI';

const summary = (): MentionsSummary => ({
  period: {
    start: '2026-10-16T00:00:00.000Z',
    end: '2026-10-22T23:59:59.999Z',
    granularity: 'daily',
    timezone: 'UTC',
  },
  total: 88,
  comparison: 'first_to_last_observed_day',
  providers: [
    { provider: 'openai', count: 31, share: 35.23, change: 6.67, points: [
      { date: '2026-10-20', count: 15 },
      { date: '2026-10-22', count: 16 },
    ] },
    { provider: 'gemini', count: 30, share: 34.09, change: 0, points: [
      { date: '2026-10-20', count: 15 },
      { date: '2026-10-22', count: 15 },
    ] },
    { provider: 'perplexity', count: 27, share: 30.68, change: 7.69, points: [
      { date: '2026-10-20', count: 13 },
      { date: '2026-10-22', count: 14 },
    ] },
  ],
  markers: [],
});

let root: Root;
let container: HTMLDivElement;
const tracked = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  tracked.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(value = summary()) {
  await act(async () => root.render(<MentionsChart summary={value} onTracked={tracked} />));
}
function lines(provider: ScanProvider) {
  return [...container.querySelectorAll<SVGLineElement>(`.mentions-series[data-provider="${provider}"] line`)];
}
async function focusDate(prefix: string) {
  const target = container.querySelector<SVGElement>(`rect[tabindex="0"][aria-label^="${prefix}"]`);
  expect(target).not.toBeNull();
  await act(async () => target!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
  return container.querySelector('.chart-tooltip')!;
}
async function toggleProvider(name: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.monitor-chart-legend button')]
    .find((item) => item.textContent === name)!;
  await act(async () => button.click());
  return button;
}

describe('Mentions chart', () => {
  it('connects sparse scan dates with dashed straight lines and leaves unmeasured dates empty', async () => {
    await render();
    for (const provider of ['openai', 'gemini', 'perplexity'] as const) {
      expect(lines(provider)).toHaveLength(1);
      expect(lines(provider)[0].getAttribute('stroke-dasharray')).toBe('6 5');
      expect(container.querySelectorAll(`.mentions-measurement[data-provider="${provider}"]`)).toHaveLength(2);
    }
    expect(container.querySelectorAll('.mentions-series path')).toHaveLength(0);
    expect(container.querySelectorAll('.mentions-measurement')).toHaveLength(6);
    const noScan = await focusDate('Oct 21, 2026 UTC');
    expect([...noScan.querySelectorAll('b')].map((item) => item.textContent))
      .toEqual(['No scan', 'No scan', 'No scan']);
    const measured = await focusDate('Oct 20, 2026 UTC');
    expect([...measured.querySelectorAll('b')].map((item) => item.textContent))
      .toEqual(['15', '15', '13']);
    expect(container.querySelector('.mentions-chart-note')?.textContent).toContain('dates without a scan have no measured value');
  });

  it('shows real zero measurements and uses solid connections only for adjacent observations', async () => {
    const value = summary();
    value.providers = value.providers.slice(0, 2);
    value.providers[0].points.splice(1, 0, { date: '2026-10-21', count: 0 });
    await render(value);
    expect(lines('openai')).toHaveLength(2);
    expect(lines('openai').every((line) => !line.hasAttribute('stroke-dasharray'))).toBe(true);
    expect(lines('openai')[0].getAttribute('y2')).toBe('275');
    expect(lines('openai')[1].getAttribute('y1')).toBe('275');
    expect(lines('gemini')[0].getAttribute('stroke-dasharray')).toBe('6 5');
    const tooltip = await focusDate('Oct 21, 2026 UTC');
    expect([...tooltip.querySelectorAll('b')].map((item) => item.textContent)).toEqual(['0', 'No scan']);
  });

  it('keeps coincident providers visible with nested shapes at the actual measurement coordinates', async () => {
    const value = summary();
    value.providers.reverse();
    for (const provider of value.providers) provider.points = [{ date: '2026-10-20', count: 15 }];
    await render(value);
    const markers = [...container.querySelectorAll('.mentions-measurement')];
    expect(markers.map((marker) => marker.getAttribute('data-provider'))).toEqual(['openai', 'gemini', 'perplexity']);
    expect(new Set(markers.map((marker) => marker.getAttribute('transform'))).size).toBe(1);
    expect(markers.map((marker) => marker.lastElementChild?.tagName)).toEqual(['circle', 'path', 'rect']);
    for (const marker of markers) expect(marker.querySelector('title')?.textContent).toContain('15 mentions on Oct 20, 2026 UTC');
    expect(lines('openai')).toHaveLength(0);
  });

  it('handles hourly gaps across midnight and reports the full UTC date in tooltips', async () => {
    const value = summary();
    value.period = {
      start: '2026-10-20T23:00:00.000Z',
      end: '2026-10-21T02:59:59.999Z',
      granularity: 'hourly',
      timezone: 'UTC',
    };
    value.providers = [value.providers[0]];
    value.providers[0].points = [
      { date: '2026-10-20T23:00:00.000Z', count: 0 },
      { date: '2026-10-21T01:00:00.000Z', count: 2 },
      { date: '2026-10-21T02:00:00.000Z', count: 4 },
    ];
    await render(value);
    expect(lines('openai').map((line) => line.getAttribute('stroke-dasharray'))).toEqual(['6 5', null]);
    expect((await focusDate('2026-10-21 00:00 UTC')).textContent).toContain('No scan');
    expect((await focusDate('2026-10-20 23:00 UTC')).textContent).toContain('ChatGPT0');
  });

  it('filters both lines and measurements, including tooltip values, and supports an empty selection', async () => {
    await render();
    expect((await toggleProvider('Gemini')).getAttribute('aria-pressed')).toBe('false');
    expect(lines('gemini')).toHaveLength(0);
    expect(container.querySelectorAll('.mentions-measurement[data-provider="gemini"]')).toHaveLength(0);
    expect((await focusDate('Oct 20, 2026 UTC')).textContent).not.toContain('Gemini');
    await toggleProvider('ChatGPT');
    await toggleProvider('Perplexity');
    expect(container.querySelectorAll('.mentions-measurement')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('NaN');
    await toggleProvider('Gemini');
    expect(lines('gemini')).toHaveLength(1);
  });

  it('does not retain an invalid tooltip when the selected period becomes shorter', async () => {
    await render();
    await focusDate('Oct 22, 2026 UTC');
    const value = summary();
    value.period.start = '2026-10-22T00:00:00.000Z';
    await render(value);
    expect(container.querySelector('.chart-tooltip')).toBeNull();
    expect(container.querySelectorAll('.mentions-measurement')).toHaveLength(3);
    expect(lines('openai')).toHaveLength(0);
  });

  it('keeps long histories readable with sparse point markers while preserving every measurement and hover value', async () => {
    const value = summary();
    value.period.start = '2026-09-01T00:00:00.000Z';
    value.providers = [value.providers[0]];
    value.providers[0].points = Array.from({ length: 52 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10),
      count: 20 + index,
    }));
    await render(value);
    expect(lines('openai')).toHaveLength(51);
    expect(container.querySelectorAll('.mentions-measurement').length).toBeLessThanOrEqual(15);
    const tooltip = await focusDate('Sep 2, 2026 UTC');
    expect(tooltip.textContent).toContain('ChatGPT21');
    expect(container.querySelector('.mentions-measurement[data-active="true"] title')?.textContent)
      .toContain('21 mentions on Sep 2, 2026 UTC');
    const targets = [...container.querySelectorAll<SVGRectElement>('rect[tabindex="0"]')];
    expect(Number(targets[0].getAttribute('x')) + Number(targets[0].getAttribute('width')))
      .toBeCloseTo(Number(targets[1].getAttribute('x')));
  });

  it('groups published URLs by day into a scrolling popup with accurate counts and opens tracking details', async () => {
    const value = summary();
    const items = Array.from({ length: 8 }, (_, index) => ({
      id: `article-${index}`,
      url: `https://example.com/blog/article-${index}`,
      title: `Article ${index}`,
      appearances: index * 3,
      contentType: 'BLOG' as const,
      publishedAt: '2026-10-20T09:30:00.000Z',
      ...(index === 0 ? { imageUrl: 'https://example.com/article.jpg' } : {}),
    }));
    value.markers = [
      { date: '2026-10-20', items: items.slice(0, 4) },
      { date: '2026-10-20T12:00:00.000Z', items: items.slice(3) },
      { date: '2026-10-19', items: [] },
    ];
    await render(value);
    const badges = container.querySelectorAll<HTMLButtonElement>('.chart-publication-badge');
    expect(badges).toHaveLength(1);
    const badge = [...badges].find((button) => button.getAttribute('aria-label')?.startsWith('8 tracked URLs'))!;
    expect(badge).toBeDefined();
    await act(async () => badge.click());
    const popup = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(badge.getAttribute('aria-expanded')).toBe('true');
    expect(popup.getAttribute('aria-label')).toBe('Tracked URLs on Oct 20, 2026 UTC');
    expect(popup.querySelectorAll('li')).toHaveLength(8);
    expect([...popup.querySelectorAll('.marker-content-citations')].map((element) => element.textContent))
      .toEqual(['Cited: 0', 'Cited: 3', 'Cited: 6', 'Cited: 9', 'Cited: 12', 'Cited: 15', 'Cited: 18', 'Cited: 21']);
    expect(popup.querySelector('.marker-content-meta')?.textContent).toContain('Blog');
    expect(popup.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-20T09:30:00.000Z');
    expect(popup.querySelector('.marker-content-image')?.getAttribute('src')).toBe('https://example.com/article.jpg');
    expect(Number.parseFloat(popup.style.maxHeight)).toBeLessThanOrEqual(360);
    await act(async () => popup.querySelector<HTMLButtonElement>('[aria-label="Open tracking details for Article 7"]')!.click());
    expect(tracked).toHaveBeenCalledWith('article-7');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps one publication popup open and dismisses it with Escape or an outside click', async () => {
    const value = summary();
    value.markers = ['2026-10-20', '2026-10-22'].map((date) => ({
      date,
      items: [{ id: date, title: 'Blog post', url: 'https://example.com/blog', appearances: 4 }],
    }));
    await render(value);
    const [first, second] = container.querySelectorAll<HTMLButtonElement>('.chart-publication-badge');
    await act(async () => first.click());
    await act(async () => second.click());
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(first.getAttribute('aria-expanded')).toBe('false');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(second);
    await act(async () => first.click());
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(first.getAttribute('aria-expanded')).toBe('false');
  });
});
