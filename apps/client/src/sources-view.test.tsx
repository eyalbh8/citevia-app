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
    const limit = Number(params.get('limit') || 50), offset = Number(params.get('cursor') || 0);
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
  it('requests ten domains per page, visits the next page and returns without skipping sources', async () => {
    await render();
    expect(container.querySelectorAll('.source-card')).toHaveLength(10);
    expect(container.textContent).toContain('1–10 of 14 domains');
    expect(container.textContent).toContain('Page 1 of 2');
    expect(button('Previous source page')?.disabled).toBe(true);
    expect(button('Previous source page')?.title).toBe('This is the first page');
    expect(button('Next source page')?.disabled).toBe(false);
    await click('Next source page');
    expect(container.querySelectorAll('.source-card')).toHaveLength(4);
    expect(container.textContent).toContain('source-10.example');
    expect(container.textContent).not.toContain('source-0.example');
    expect(container.textContent).toContain('11–14 of 14 domains');
    expect(container.textContent).toContain('Page 2 of 2');
    expect(button('Next source page')?.disabled).toBe(true);
    expect(button('Next source page')?.title).toBe('This is the last page');
    await click('Previous source page');
    expect(container.textContent).toContain('source-0.example');
    expect(container.textContent).toContain('Page 1 of 2');
  });

  it('resets the cursor when source filters change and omits navigation for one page', async () => {
    await render();
    await click('Next source page');
    await click('Retrieved sources');
    expect(container.querySelectorAll('.source-card')).toHaveLength(3);
    expect(container.textContent).toContain('1–3 of 3 domains');
    expect(button('Next source page')).toBeUndefined();
    expect(button('Previous source page')).toBeUndefined();
    const lastRequest = mocks.useApi.mock.calls.filter(([path]) => path).at(-1)![0];
    expect(lastRequest).toContain('kind=consulted');
    expect(lastRequest).not.toContain('cursor=');
  });

  it('prevents duplicate page advances while a request is loading', async () => {
    await render();
    loading = true;
    await render();
    expect(button('Next source page')?.disabled).toBe(true);
    await click('Next source page');
    expect(container.textContent).toContain('Page 1 of 2');
  });
});
