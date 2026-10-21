import { createContext, useEffect, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query-cache';

export const ApiSessionContext = createContext('');

export default function ApiSessionProvider({ sessionId, children }: {
  sessionId: string;
  children: ReactNode;
}) {
  useEffect(() => () => {
    // Signing out or changing identity discards data and cancels old requests.
    queryClient.removeQueries({ queryKey: ['api', sessionId] });
  }, [sessionId]);

  return (
    <QueryClientProvider client={queryClient}>
      <ApiSessionContext.Provider value={sessionId}>
        {children}
      </ApiSessionContext.Provider>
    </QueryClientProvider>
  );
}
