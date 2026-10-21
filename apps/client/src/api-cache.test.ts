// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ getAccessToken: async () => 'test-token' }));
import { request, useApi } from './api';
import ApiSessionProvider from './ApiSessionProvider';
import { apiQueryKey, queryClient } from './query-cache';

let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useApi<{ value: string }>>;
function Page({ path, revision = 0 }: { path: string | null; revision?: number }) {
  latest = useApi<{ value: string }>(path, revision);
  return createElement('div', null, latest.data?.value || (latest.loading ? 'Loading' : latest.error?.message));
}

async function render(path: string | null, options: { sessionId?: string; revision?: number; visible?: boolean; strict?: boolean } = {}) {
  const sessionId = options.sessionId || 'user-a';
  const page = createElement(ApiSessionProvider, {
    key: sessionId,
    sessionId,
    children: options.visible === false ? null : createElement(Page, { path, revision: options.revision }),
  });
  await act(async () => {
    root.render(options.strict ? createElement(StrictMode, null, page) : page);
  });
  await settle();
}

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
const response = (value: string, status = 200) => new Response(JSON.stringify({ value }), { status });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  queryClient.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe('useApi navigation cache', () => {
  it('reuses data after leaving and returning to a page, including StrictMode', async () => {
    const fetcher = vi.fn().mockImplementation(async () => response('cached page'));
    vi.stubGlobal('fetch', fetcher);
    await render('/projects/a/settings', { strict: true });
    expect(container.textContent).toBe('cached page');
    const initialCalls = fetcher.mock.calls.length;
    await render('/projects/a/settings', { strict: true, visible: false });
    await render('/projects/a/settings', { strict: true });
    expect(container.textContent).toBe('cached page');
    expect(latest.loading).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(initialCalls);
  });

  it('keeps revisions out of cache keys and preserves data during an explicit refresh', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(response('before'))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    await render('/projects/a/settings');
    await render('/projects/a/settings', { revision: 1 });
    expect(container.textContent).toBe('before');
    expect(latest.loading).toBe(true);
    await act(async () => finish(response('after')));
    await settle();
    await render('/projects/a/settings', { visible: false });
    await render('/projects/a/settings');
    expect(container.textContent).toBe('after');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses separate filter entries and never shows a previous account while loading', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response('account a'))
      .mockResolvedValueOnce(response('account b'));
    vi.stubGlobal('fetch', fetcher);
    await render('/projects/a/mentions?provider=openai');
    await render('/projects/b/mentions?provider=openai');
    expect(container.textContent).toBe('account b');
    await render('/projects/a/mentions?provider=openai');
    expect(container.textContent).toBe('account a');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('clears the previous user on session change and on sign-out', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response('first user'))
      .mockResolvedValueOnce(response('second user'));
    vi.stubGlobal('fetch', fetcher);
    await render('/me');
    await render('/me', { sessionId: 'user-b' });
    expect(container.textContent).toBe('second user');
    expect(queryClient.getQueryData(apiQueryKey('user-a', '/me'))).toBeUndefined();
    await act(async () => root.render(null));
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('discards a late response from the previous session', async () => {
    let finishOldRequest!: (response: Response) => void;
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishOldRequest = resolve; }))
      .mockResolvedValueOnce(response('second user'));
    vi.stubGlobal('fetch', fetcher);
    await render('/me');
    await render('/me', { sessionId: 'user-b' });
    await act(async () => finishOldRequest(response('first user')));
    await settle();
    expect(container.textContent).toBe('second user');
    expect(queryClient.getQueryData(apiQueryKey('user-a', '/me'))).toBeUndefined();
  });

  it('keeps cached data available after a temporary refresh failure', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response('cached page'))
      .mockRejectedValueOnce(new TypeError('Network unavailable'));
    vi.stubGlobal('fetch', fetcher);
    await render('/projects/a/settings');
    await render('/projects/a/settings', { revision: 1 });
    expect(container.textContent).toBe('cached page');
    expect(latest.error?.message).toBe('Network unavailable');
    expect(latest.loading).toBe(false);
  });

  it('refreshes after a successful write and does not retain forbidden data', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response('before'))
      .mockResolvedValueOnce(response('saved'))
      .mockResolvedValueOnce(response('after'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Access removed' }), { status: 403 }))
      .mockRejectedValueOnce(new TypeError('Network unavailable'));
    vi.stubGlobal('fetch', fetcher);
    await render('/projects/a/settings');
    await act(async () => { await request('/projects/a/settings', { method: 'PATCH', body: '{}' }); });
    await settle();
    expect(container.textContent).toBe('after');
    await render('/projects/a/settings', { revision: 1 });
    expect(latest.data).toBeUndefined();
    expect(container.textContent).toBe('Access removed');
    await render('/projects/a/settings', { revision: 2 });
    expect(latest.data).toBeUndefined();
    expect(container.textContent).toBe('Network unavailable');
  });

  it('does not fetch a disabled path', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await render(null);
    expect(latest).toMatchObject({ data: undefined, error: undefined, loading: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
