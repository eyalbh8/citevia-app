// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardOverview, Project, Prompt, PromptMetricsResponse } from '@citevia/core';

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
import PromptsView from './PromptsView';

const path = '/projects/xtrade';
const project = {
  id: 'xtrade', name: 'XTrade',
  brand: { id: 'target', name: 'XTrade', domains: ['xtrade.com'], aliases: [] },
  competitors: [{ id: 'competitor', name: 'Other broker', domains: ['broker.example'], aliases: [] }],
  prompts: [], country: 'IT', language: 'en', timezone: 'UTC', role: 'owner',
  scanProviders: [{ provider: 'openai', model: 'saved-openai' }],
} as unknown as Project;
const demo: NonNullable<Project['demo']> = {
  version: 1, source: 'website-demo', anchorDate: '2026-10-23',
  startDate: '2026-04-23', endDate: '2027-04-23', sourceAccountId: 'demo',
  sourceCopiedAt: '2026-10-23T00:00:00.000Z',
};
function report(): DashboardOverview {
  return {
    period: { start: '2026-10-19T00:00:00.000Z', end: '2026-10-25T12:00:00.000Z', granularity: 'daily', timezone: 'UTC' },
    filters: { providers: [], region: '', tag: '', branded: 'false', intent: '', search: '' },
    analyzed: 42, providers: [], stages: [],
    ranking: [], trend: [], sources: [], comparison: 'first_to_last_observed_day',
  };
}
function ranking(targetPosition: number | null = 8): DashboardOverview['ranking'] {
  return Array.from({ length: 6 }, (_, index) => ({
    brandId: index === 5 ? 'target' : `competitor-${index}`,
    name: index === 5 ? 'XTrade' : `Competitor ${index + 1}`,
    domain: null, isTarget: index === 5,
    position: index === 5 ? targetPosition : index + 1,
    rank: index === 5 ? targetPosition : index + 1,
    rankChange: null,
    mentions: index === 5 ? targetPosition === null ? 0 : 2 : 20 - index,
    mentionChange: null, sentiment: null, sentimentChange: null,
  }));
}
let root: Root, container: HTMLDivElement, data: DashboardOverview;
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  data = report();
  mocks.useApi.mockReset();
  mocks.useApi.mockImplementation(() => ({ data, loading: false, error: undefined }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  vi.unstubAllGlobals();
});
async function dashboard(account = project) {
  await act(async () => root.render(<DashboardView project={account} path={path} />));
}
const latestQuery = () => new URL(mocks.useApi.mock.calls.at(-1)![0], 'https://citevia.test').searchParams;

describe('dashboard discovery reporting', () => {
  it('opens real accounts on non-branded discovery results with a visible filter', async () => {
    await dashboard();
    expect(latestQuery().get('branded')).toBe('false');
    expect(container.querySelector('[aria-label="Branded: Non-branded"]')).not.toBeNull();
    expect(container.querySelector('.overview-ranking .card-description')?.textContent)
      .toBe('Discovery visibility from non-branded prompts');
  });

  it('keeps demo accounts on their existing all-prompts overview', async () => {
    await dashboard({ ...project, demo });
    expect(latestQuery().has('branded')).toBe(false);
    expect(container.querySelector('.overview-ranking .card-description')?.textContent)
      .toBe('Top brands by visibility across all prompts');
  });

  it('allows the user to include branded prompts again', async () => {
    await dashboard();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Branded: Non-branded"]')!;
    await act(async () => trigger.click());
    const option = document.querySelector<HTMLElement>('[role="option"][aria-label="All prompts"]')!;
    await act(async () => option.click());
    expect(latestQuery().has('branded')).toBe(false);
    expect(container.querySelector('.overview-ranking .card-description')?.textContent)
      .toBe('Top brands by visibility across all prompts');
  });

  it('shows the target’s actual position when retained below the top five', async () => {
    data.ranking = ranking();
    await dashboard();
    const rows = container.querySelectorAll('.overview-ranking-table tbody tr');
    expect(rows).toHaveLength(6);
    const target = container.querySelector('.overview-ranking-table tr.is-target')!;
    expect(target.querySelector('td')?.textContent).toBe('8');
    expect(target.textContent).toContain('XTrade');
    expect(target.textContent).toContain('Your brand');
    expect(container.querySelector('.overview-ranking .overview-card-footer')?.textContent)
      .toMatch(/non-branded/i);
  });

  it('keeps an unmentioned target visible without assigning a false position', async () => {
    data.ranking = ranking(null);
    await dashboard();
    const target = container.querySelector('.overview-ranking-table tr.is-target')!;
    expect(target.querySelector('td')?.textContent).toBe('—');
    expect(target.textContent).toContain('Not mentioned');
    expect(target.querySelectorAll('td')[2].querySelector('strong')?.textContent).toBe('0');
  });

  it('draws the retained sixth brand with a visible chart color', async () => {
    data.ranking = ranking();
    data.trend = [
      { date: '2026-10-22', mentions: { target: 0 } },
      { date: '2026-10-25', mentions: { target: 2 } },
    ];
    await dashboard();
    const lines = container.querySelectorAll('.overview-chart polyline');
    const colors = [...lines].map((line) => line.getAttribute('stroke'));
    expect(lines).toHaveLength(6);
    expect(colors[5]).toMatch(/^#[\da-f]{6}$/i);
    expect(new Set(colors).size).toBe(6);
    const legend = container.querySelectorAll<HTMLElement>('.overview-chart-legend i');
    expect(legend[5].style.background).not.toBe('');
  });
});

describe('saved prompt measurement context', () => {
  it('explains saved analyses when current analysis settings have changed', async () => {
    const prompt: Prompt = {
      id: 'p1', version: 1, text: 'Which brokers offer demo accounts?', active: true,
      branded: false, stage: 'understand', intent: 'informational', tags: [],
      createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
    };
    const account = { ...project, prompts: [prompt] };
    const metrics: PromptMetricsResponse = {
      items: [{
        ...prompt, regions: ['IT'], language: 'en',
        avgVisibility: 25, avgRank: 4, avgSentimentScore: 46,
        visibilityChange: null, rankChange: null, sentimentChange: null,
        measurementCount: 12, previousMeasurementCount: 0, rankCount: 3,
        sentimentCount: 3, responseId: 'response-1', comparison: null,
        historicalAnalysis: true, analysisModels: ['saved-analysis-model'],
      }],
      period: { start: '2026-10-19', end: '2026-10-25', previousStart: '2026-10-12', previousEnd: '2026-10-18' },
      provider: null, usage: { active: 1, limit: 50 },
    };
    mocks.useApi.mockImplementation((url: string) => ({
      data: url.endsWith('/settings') ? account : metrics,
      loading: false, error: undefined,
    }));
    await act(async () => root.render(<PromptsView path={path} onSaved={() => {}} notify={() => {}} />));
    const visibility = container.querySelector<HTMLElement>('.prompts-table tbody .prompt-metric')!;
    expect(visibility.querySelector('[aria-label="Visibility 25%"]')).not.toBeNull();
    expect(visibility.title).toContain('12 successfully analyzed answers');
    expect(visibility.title).toMatch(/saved analys/i);
    expect(visibility.title).toContain('saved-analysis-model');
  });
});
