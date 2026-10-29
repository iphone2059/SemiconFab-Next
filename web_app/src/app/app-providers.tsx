import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorBoundary } from '@/components/error-boundary';
import { QueryProvider } from '@/app/query-provider';
import { RuntimeBootstrap } from '@/app/runtime-bootstrap';

/**
 * Application-wide providers: TanStack Query owns server data, Zustand owns
 * client UI state, and RuntimeBootstrap assembles one XState v6 FabRuntime per
 * FAB from the sites document. The error boundary keeps fatal rendering UI.
 */
export function AppProviders({ children, client }: { children: ReactNode; client?: QueryClient }) {
  return (
    <QueryProvider client={client}>
      <RuntimeBootstrap>
        <ErrorBoundary>{children}</ErrorBoundary>
      </RuntimeBootstrap>
    </QueryProvider>
  );
}
