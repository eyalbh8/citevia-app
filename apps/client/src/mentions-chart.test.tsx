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
});
