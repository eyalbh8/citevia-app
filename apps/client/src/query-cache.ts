import { QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api-error';

export function createApiQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          // Unlike a temporary network failure, denied/deleted data must not
          // reappear if the next retry also fails. Keep the error for the UI.
          query.setState({ data: undefined, dataUpdatedAt: 0 });
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: 30 * 60 * 1000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
      mutations: { retry: false },
    },
  });
}

// Shared across page mounts, with separate keys for each authenticated user.
export const queryClient = createApiQueryClient();

export function apiQueryKey(sessionId: string, path: string | null) {
  if (!path) return ['api', sessionId, null] as const;
  const [pathname, search = ''] = path.split('?');
  const params = new URLSearchParams(search);
  params.sort();
  return ['api', sessionId, `${pathname}${params.size ? `?${params}` : ''}`] as const;
}

function matchesPath(cached: unknown, path: string) {
  if (typeof cached !== 'string') return false;
  const pathname = cached.split('?')[0];
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function invalidateApiQueries(path?: string) {
  return queryClient.invalidateQueries(
    {
      queryKey: ['api'],
      predicate: (query) => !path || matchesPath(query.queryKey[2], path),
    },
    // Several mounted views can request the same refresh in one render.
    { cancelRefetch: false },
  );
}

export function invalidateAfterMutation(path: string) {
  const pathname = path.split('?')[0];
  const project = pathname.match(/^\/projects\/[^/]+/)?.[0];
  const affectsAccess = pathname.startsWith('/admin/users');
  const affectsProjects = Boolean(project) || pathname.startsWith('/onboarding/');
  const resource = pathname.startsWith('/mcp/') ? '/mcp' : pathname;
  const filters = {
    queryKey: ['api'],
    predicate: (query: { queryKey: readonly unknown[] }) => {
      const cached = query.queryKey[2];
      if (affectsAccess) return true;
      if (project && matchesPath(cached, project)) return true;
      if (affectsProjects && typeof cached === 'string' && cached.split('?')[0] === '/projects') return true;
      return matchesPath(cached, resource);
    },
  };
  // A GET started before the write must not restore an obsolete fresh value.
  // Inactive variants stay invalidated and revalidate when opened again.
  return queryClient.cancelQueries(filters).then(() =>
    queryClient.invalidateQueries(filters),
  );
}
