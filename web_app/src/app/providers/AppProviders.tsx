import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorBoundary } from '../../error-boundary';
import { QueryProvider } from './QueryProvider';

/**
 * Application-wide providers after M2b: TanStack Query owns server data,
 * Zustand stores own client UI state (no Redux Provider), and the existing
 * error boundary keeps fatal rendering UI.
 */
export function AppProviders({ children, client }: { children: ReactNode; client?: QueryClient }) {
  return (
    <QueryProvider client={client}>
      <ErrorBoundary>{children}</ErrorBoundary>
    </QueryProvider>
  );
}
