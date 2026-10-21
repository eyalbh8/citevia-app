import { QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiQueryKey, invalidateAfterMutation, invalidateApiQueries, queryClient } from './query-cache';

const subscriptions = new Set<() => void>();

function observe<T>(path: string, queryFn: () => Promise<T>, sessionId = 'session-a') {
  const observer = new QueryObserver(queryClient, { queryKey: apiQueryKey(sessionId, path), queryFn });
  const unsubscribe = observer.subscribe(() => {});
  subscriptions.add(unsubscribe);
  return {
    observer,
    unsubscribe: () => {
      unsubscribe();
      subscriptions.delete(unsubscribe);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(() => {
  for (const unsubscribe of subscriptions) unsubscribe();
  subscriptions.clear();
  queryClient.clear();
});

describe('API page cache', () => {
  it('shows previously loaded data immediately without fetching again when a page remounts', async () => {
    const path = '/projects/project-a/dashboard?period=7d';
    const fetcher = vi.fn(async () => ({ score: 42 }));
    const firstPage = observe(path, fetcher);
    await vi.waitFor(() => expect(firstPage.observer.getCurrentResult().data).toEqual({ score: 42 }));
    firstPage.unsubscribe();

    const returningPage = observe(path, fetcher);
    expect(returningPage.observer.getCurrentResult()).toMatchObject({
      data: { score: 42 }, status: 'success', isFetching: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request between views with the same filters in different orders', async () => {
    const response = deferred<string[]>();
    const fetcher = vi.fn(() => response.promise);
    const first = observe('/projects/project-a/prompts?period=7d&provider=openai', fetcher);
    const second = observe('/projects/project-a/prompts?provider=openai&period=7d', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    response.resolve(['prompt-a']);
    await vi.waitFor(() => {
      expect(first.observer.getCurrentResult().data).toEqual(['prompt-a']);
      expect(second.observer.getCurrentResult().data).toEqual(['prompt-a']);
    });
  });

  it('keeps data separate for different users, projects, and filters', async () => {
    const variants = [
      ['session-a', '/projects/project-a/dashboard?period=7d', 'week-a'],
      ['session-a', '/projects/project-a/dashboard?period=30d', 'month-a'],
      ['session-a', '/projects/project-b/dashboard?period=7d', 'week-b'],
      ['session-b', '/projects/project-a/dashboard?period=7d', 'other-user'],
    ] as const;
    await Promise.all(variants.map(([sessionId, path, data]) => queryClient.fetchQuery({
      queryKey: apiQueryKey(sessionId, path), queryFn: async () => data,
    })));

    for (const [sessionId, path, data] of variants)
      expect(queryClient.getQueryData(apiQueryKey(sessionId, path))).toBe(data);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(variants.length);
  });

  it('invalidates every cached filter for an edited project and reloads an inactive page when reopened', async () => {
    const relatedPaths = [
      '/projects/project-a',
      '/projects/project-a/dashboard?period=7d',
      '/projects/project-a/dashboard?period=30d',
      '/projects/project-a/prompts?provider=openai',
      '/projects',
      '/projects?accountId=account-a',
    ];
    const unrelatedPaths = ['/projects/project-b/dashboard?period=7d', '/projects/project-ab/prompts', '/mcp/keys'];
    for (const path of [...relatedPaths, ...unrelatedPaths])
      queryClient.setQueryData(apiQueryKey('session-a', path), 'before');

    await invalidateAfterMutation('/projects/project-a/prompts/prompt-1');
    for (const path of relatedPaths)
      expect(queryClient.getQueryState(apiQueryKey('session-a', path))?.isInvalidated).toBe(true);
    for (const path of unrelatedPaths)
      expect(queryClient.getQueryState(apiQueryKey('session-a', path))?.isInvalidated).toBe(false);

    const fetcher = vi.fn(async () => 'after');
    const reopenedPage = observe('/projects/project-a/dashboard?period=30d', fetcher);
    expect(reopenedPage.observer.getCurrentResult().data).toBe('before');
    await vi.waitFor(() => expect(reopenedPage.observer.getCurrentResult().data).toBe('after'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes an active project in the background while preserving its current data', async () => {
    const path = '/projects/project-a/dashboard?period=7d';
    queryClient.setQueryData(apiQueryKey('session-a', path), { score: 42 });
    queryClient.setQueryData(apiQueryKey('session-a', '/projects/project-b/dashboard'), { score: 24 });
    const response = deferred<{ score: number }>();
    const fetcher = vi.fn(() => response.promise);
    const page = observe(path, fetcher);
    expect(fetcher).not.toHaveBeenCalled();

    const refresh = invalidateApiQueries('/projects/project-a');
    expect(page.observer.getCurrentResult()).toMatchObject({
      data: { score: 42 }, isFetching: true, isPending: false,
    });
    expect(queryClient.getQueryState(apiQueryKey('session-a', '/projects/project-b/dashboard'))?.isInvalidated).toBe(false);
    response.resolve({ score: 55 });
    await refresh;
    expect(page.observer.getCurrentResult()).toMatchObject({ data: { score: 55 }, isFetching: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('prevents a read started before a mutation from overwriting the refreshed response', async () => {
    const oldResponse = deferred<string>();
    const newResponse = deferred<string>();
    const fetcher = vi.fn()
      .mockImplementationOnce(() => oldResponse.promise)
      .mockImplementationOnce(() => newResponse.promise);
    const page = observe('/projects/project-a/prompts', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const mutationRefresh = invalidateAfterMutation('/projects/project-a/prompts/prompt-1');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    newResponse.resolve('updated prompts');
    await mutationRefresh;
    oldResponse.resolve('old prompts');
    await oldResponse.promise;
    expect(page.observer.getCurrentResult().data).toBe('updated prompts');
    expect(queryClient.getQueryState(apiQueryKey('session-a', '/projects/project-a/prompts'))?.isInvalidated).toBe(false);
  });

  it('can invalidate all API data without invalidating unrelated query caches', async () => {
    const paths = ['/projects', '/projects/project-a/dashboard?period=7d', '/mcp/keys'];
    for (const path of paths) queryClient.setQueryData(apiQueryKey('session-a', path), 'cached');
    queryClient.setQueryData(['local-preferences'], { theme: 'dark' });

    await invalidateApiQueries();
    for (const path of paths)
      expect(queryClient.getQueryState(apiQueryKey('session-a', path))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['local-preferences'])?.isInvalidated).toBe(false);
  });

  it('removes a signed-out user’s cached data while retaining a different session’s data', async () => {
    const path = '/projects/project-a/dashboard';
    const oldSession = apiQueryKey('session-a', path);
    const nextSession = apiQueryKey('session-b', path);
    queryClient.setQueryData(oldSession, 'private old data');
    queryClient.setQueryData(nextSession, 'different user data');

    queryClient.removeQueries({ queryKey: ['api', 'session-a'] });
    expect(queryClient.getQueryData(oldSession)).toBeUndefined();
    expect(queryClient.getQueryData(nextSession)).toBe('different user data');
    const page = observe(path, async () => 'new login data');
    expect(page.observer.getCurrentResult().data).toBeUndefined();
    await vi.waitFor(() => expect(page.observer.getCurrentResult().data).toBe('new login data'));
  });
});
