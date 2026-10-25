// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardOverview, Project } from '@citevia/core';

const mocks = vi.hoisted(() => ({ useApi: vi.fn(), downloadCsv: vi.fn(), request: vi.fn() }));
vi.mock('./api', () => ({
  ...mocks,
  ApiError: class extends Error {},
  query: (values: Record<string, unknown>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values))
      if (value !== undefined && value !== '') query.set(key, String(value));
    return `?${query}`;
  },
}));
import { DashboardView } from './DashboardView';

const project = {
  id: 'stage-report', name: 'Stage report', brand: { id: 'target', name: 'Stage report', domains: ['stage-report.example'], aliases: [] },
  competitors: [], prompts: [], country: 'US', language: 'en', timezone: 'UTC',
  scanProviders: [{ provider: 'openai', model: 'saved-openai' }],
} as unknown as Project;
function report(change: number | null = 12.34, key = 'trust'): DashboardOverview {
  return {
    period: { start: '2026-10-19T00:00:00.000Z', end: '2026-10-25T12:00:00.000Z', granularity: 'daily', timezone: 'UTC' },
    filters: { providers: [], region: '', tag: '', branded: '', intent: '', search: '' },
    analyzed: 12, providers: [{ provider: 'openai', count: 8, change: 6.67 }],
    stages: [{ key, promptCount: 2, measuredPromptCount: 2, visibility: 55, visibilityChange: change }],
    ranking: [], trend: [], sources: [], comparison: 'first_to_last_observed_day',
  };
}
let root: Root, container: HTMLDivElement, data: DashboardOverview;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  data = report();
  mocks.useApi.mockReset();
  mocks.downloadCsv.mockReset();
  mocks.useApi.mockImplementation(() => ({ data, loading: false, error: undefined }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<DashboardView project={project} path="/projects/stage-report" />));
  return container.querySelector<HTMLElement>('.overview-stage')!;
}

describe('dashboard stage visibility comparisons', () => {
  it.each([
    { change: 12.34, style: 'positive', shown: '12.3%', description: 'increased by' },
    { change: -6.78, style: 'negative', shown: '6.8%', description: 'decreased by' },
    { change: 0, style: 'neutral', shown: '0.0%', description: 'unchanged' },
    { change: null, style: 'neutral', shown: '—', description: 'not available' },
  ])('shows $change separately from the period visibility', async ({ change, style, shown, description }) => {
    data = report(change);
    const stage = await render(), metrics = stage.querySelector<HTMLElement>('.overview-stage-metrics')!;
    expect(metrics.querySelector('strong')?.textContent).toBe('55%');
    const badge = metrics.querySelector<HTMLElement>('.overview-change')!;
    expect(badge.classList.contains(style)).toBe(true);
    expect(badge.textContent).toContain(shown);
    expect(badge.textContent).toContain(description);
    expect(badge.getAttribute('title')).toContain('Trust visibility change from first to last observed day');
    expect(badge.getAttribute('title')).toContain('relative percentage');
    expect(badge.getAttribute('title')).not.toMatch(/previous (week|period)/i);
    expect(stage.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('55');
    expect(stage.querySelector<HTMLElement>('.overview-stage-track > span')?.style.width).toBe('55%');
  });

  it('keeps an older API response unavailable rather than showing a false zero', async () => {
    const older = report();
    delete (older.stages[0] as Partial<DashboardOverview['stages'][number]>).visibilityChange;
    data = older;
    const stage = await render();
    expect(stage.querySelector('.overview-change')?.textContent).toContain('not available');
    expect(stage.querySelector('.overview-change')?.textContent).toContain('—');
    expect(stage.querySelector('.overview-stage-metrics > strong')?.textContent).toBe('55%');
  });

  it('labels an unassigned stage naturally for assistive technology', async () => {
    data = report(8, 'unassigned');
    const stage = await render();
    expect(stage.querySelector('.overview-change')?.getAttribute('title'))
      .toContain('No stage visibility change from first to last observed day');
    expect(stage.querySelector('[role="meter"]')?.getAttribute('aria-label')).toBe('No stage visibility');
  });

  it('exports the API percentage change independently from visibility and prompt counts', async () => {
    data.stages.push({ key: 'convert', promptCount: 1, measuredPromptCount: 0, visibility: 0, visibilityChange: null });
    await render();
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === 'Export')!;
    await act(async () => button.click());
    expect(mocks.downloadCsv).toHaveBeenCalledOnce();
    const [filename, headers, rows] = mocks.downloadCsv.mock.calls[0];
    expect(filename).toBe('citevia-dashboard-2026-10-19-2026-10-25.csv');
    expect(headers).toEqual(['Section', 'Name', 'Metric', 'Value']);
    expect(rows).toContainEqual(['Stages', 'Trust', 'Visibility (%)', 55]);
    expect(rows).toContainEqual(['Stages', 'Trust', 'Visibility change (%)', 12.34]);
    expect(rows).toContainEqual(['Stages', 'Trust', 'Active prompts', 2]);
    expect(rows).toContainEqual(['Stages', 'Convert', 'Visibility change (%)', null]);
  });
});
