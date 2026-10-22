// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@citevia/core';
import DateRangeFilter, { initialDateRange, type DateRangeSelection } from './DateRangeFilter';

const demo: NonNullable<Project['demo']> = {
  version: 1,
  source: 'igeo-nayax',
  anchorDate: '2026-10-23',
  startDate: '2026-04-23',
  endDate: '2027-04-23',
  sourceAccountId: 'nayax',
  sourceCopiedAt: '2026-10-23T00:00:00.000Z',
};
const value: DateRangeSelection = { days: '7', start: '', end: '' };
const onChange = vi.fn();
let root: Root;
let container: HTMLDivElement;
const button = (label: string) =>
  [...(document.querySelector('.date-range-panel') || document).querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  )!;
async function click(label: string) {
  await act(async () => button(label).click());
}
async function render(config?: Project['demo'], selection = value) {
  await act(async () => root.render(<DateRangeFilter value={selection} onChange={onChange} demo={config} />));
  await act(async () => container.querySelector('button')!.click());
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  onChange.mockReset();
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

describe('Demo date ranges', () => {
  it('opens demo reports on their historical growth and caps history at the scenario end', () => {
    expect(initialDateRange(demo)).toEqual({ days: 'custom', start: demo.startDate, end: '2026-10-23' });
    expect(initialDateRange()).toEqual({ days: '7', start: '2026-10-17', end: '2026-10-23' });
    vi.setSystemTime(new Date('2027-06-01T12:00:00Z'));
    expect(initialDateRange(demo)).toEqual({ days: 'custom', start: demo.startDate, end: demo.endDate });
  });

  it('keeps future dates unavailable for normal projects', async () => {
    await render();
    expect(button('Next month').disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-date="2026-10-24"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[name="range-end"]')!.max).toBe('2026-10-23');
    expect(document.body.textContent).not.toContain('Full demo year');
  });

  it('allows future dates through the demo end and identifies projections', async () => {
    await render(demo, { days: 'custom', start: '2027-04-22', end: '2027-04-23' });
    expect(button('Next month').disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-date="2027-04-23"]')!.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-date="2027-04-24"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[name="range-end"]')!.max).toBe(demo.endDate);
    expect(document.body.textContent).toContain('Future dates are synthetic projections');
    await click('Apply');
    expect(onChange).toHaveBeenCalledWith({ days: 'custom', start: '2027-04-22', end: '2027-04-23' });
  });

  it('rejects dates outside the demo year', async () => {
    await render(demo, { days: 'custom', start: '2026-04-22', end: '2026-04-23' });
    expect(button('Apply').disabled).toBe(true);
    expect(document.body.textContent).toContain('Demo data starts on Apr 23, 2026');
    await act(async () => container.querySelector('button')!.click());
    await render(demo, { days: 'custom', start: '2027-04-23', end: '2027-04-24' });
    expect(button('Apply').disabled).toBe(true);
    expect(document.body.textContent).toContain('Demo data ends on Apr 23, 2027');
  });

  it('offers history and the full scenario as custom ranges while last N days stay relative to today', async () => {
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    await render(demo);
    await click('Demo history');
    expect(onChange).toHaveBeenLastCalledWith({ days: 'custom', start: demo.startDate, end: '2026-10-25' });
    await act(async () => container.querySelector('button')!.click());
    await click('Full demo year');
    expect(onChange).toHaveBeenLastCalledWith({ days: 'custom', start: demo.startDate, end: demo.endDate });
    await act(async () => container.querySelector('button')!.click());
    await click('Last 7 days');
    expect(onChange).toHaveBeenLastCalledWith({ days: '7', start: '2026-10-19', end: '2026-10-25' });
  });
});
