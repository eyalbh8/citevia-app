// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard, SourceRow } from '@citevia/core';

const mocks = vi.hoisted(() => ({ useApi: vi.fn() }));
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
import SourcesView from './SourcesView';

const sources: SourceRow[] = Array.from({ length: 14 }, (_, index) => ({
  id: `source-${index}`, domain: `source-${index}.example`, kind: 'cited', owned: false,
  answerCount: 20 - index, citationCount: 20 - index, uniqueUrlCount: 1,
  coverage: 40 - index, responseIds: [], promptCount: 20 - index,
  usedPercent: 40 - index, avgCitations: 1,
  firstSeenAt: '2026-11-01T12:00:00Z', lastSeenAt: '2026-11-01T12:00:00Z',
}));
const dashboard = {
  run: { id: 'run-a' }, metrics: { uniqueDomains: 14, uniqueUrls: 14, citations: 100, captured: 50 },
} as Dashboard;

let root: Root, container: HTMLDivElement, loading: boolean, rows: SourceRow[];
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
}
async function click(label: string) {
  expect(button(label), `Button ${label}`).toBeDefined();
  await act(async () => button(label)!.click());
}
async function render() {
  await act(async () => root.render(<SourcesView path="/projects/a" dashboard={dashboard} onResponse={vi.fn()} />));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  loading = false;
  rows = sources;
  mocks.useApi.mockReset();
  mocks.useApi.mockImplementation((path: string | null) => {
    if (!path) return { data: undefined, loading: false };
    const params = new URL(path, 'http://localhost').searchParams;
    const limit = Number(params.get('limit') || 50), offset = Number(params.get('page') || 0) * limit;
    const matching = params.get('kind') === 'consulted' ? rows.slice(0, 3) : rows;
    return { loading, data: {
      items: matching.slice(offset, offset + limit), total: matching.length,
      nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
    } };
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('source domain pagination', () => {
  it('gives each source a stable graphical mark even when no favicon exists', async () => {
    await render();
    const marks = () => [...container.querySelectorAll('summary .publisher-mark')].map(svg => svg.outerHTML);
    const first = marks();
    expect(first).toHaveLength(10);
    expect(new Set(first).size).toBe(10);
    expect(container.querySelectorAll('summary .domain-logo img')).toHaveLength(0);
    await click('Next page');
    await click('Previous page');
    expect(marks()).toEqual(first);
  });
  it('requests ten domains per page, visits the next page and returns without skipping sources', async () => {
    await render();
    expect(container.querySelectorAll('.source-card')).toHaveLength(10);
    expect(container.textContent).toContain('1–10 of 14');
    expect([...container.querySelectorAll('.source-stats small')].map(label => label.textContent)).not.toContain('Answers');
    expect(button('Page 1')?.getAttribute('aria-current')).toBe('page');
    expect(button('Previous page')?.disabled).toBe(true);
    expect(button('Next page')?.disabled).toBe(false);
    await click('Next page');
    expect(container.querySelectorAll('.source-card')).toHaveLength(4);
    expect(container.textContent).toContain('source-10.example');
    expect(container.textContent).not.toContain('source-0.example');
    expect(container.textContent).toContain('11–14 of 14');
    expect(button('Page 2')?.getAttribute('aria-current')).toBe('page');
    expect(button('Next page')?.disabled).toBe(true);
    await click('Previous page');
    expect(container.textContent).toContain('source-0.example');
    expect(button('Page 1')?.getAttribute('aria-current')).toBe('page');
  });

  it('resets the page when source filters change and omits navigation for one page', async () => {
    await render();
    await click('Next page');
    await click('Retrieved sources');
    expect(container.querySelectorAll('.source-card')).toHaveLength(3);
    expect(container.textContent).toContain('3 domains');
    expect(button('Next page')).toBeUndefined();
    expect(button('Previous page')).toBeUndefined();
    const lastRequest = mocks.useApi.mock.calls.filter(([path]) => path).at(-1)![0];
    expect(lastRequest).toContain('kind=consulted');
    expect(lastRequest).toContain('page=0');
  });

  it('jumps directly to the last page of a large catalog', async () => {
    rows = Array.from({ length: 1152 }, (_, index) => ({
      ...sources[0], id: `source-${index}`, domain: `publisher-${index}.example`,
    }));
    await render();
    await click('Page 116');
    expect(container.querySelectorAll('.source-card')).toHaveLength(2);
    expect(container.textContent).toContain('publisher-1151.example');
    expect(button('Next page')?.disabled).toBe(true);
    await click('Page 1');
    expect(container.textContent).toContain('publisher-0.example');
  });

  it('prevents duplicate page advances while a request is loading', async () => {
    await render();
    loading = true;
    await render();
    expect(button('Next page')?.disabled).toBe(true);
    await click('Next page');
    expect(button('Page 1')?.getAttribute('aria-current')).toBe('page');
  });
});
