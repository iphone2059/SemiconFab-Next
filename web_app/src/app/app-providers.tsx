import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { RegistryContext } from '@effect/atom-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { applicationRuntime, type AppRuntime } from '@/app/app-runtime';
import { AppRuntimeProvider } from '@/app/app-runtime-provider';
import { QueryProvider } from '@/app/query-provider';
import { RuntimeBootstrap } from '@/app/runtime-bootstrap';

/**
 * Application-wide providers: the app-owned AppRuntime supplies the single
 * AtomRegistry to React; TanStack Query still owns server data until Task 5 and
 * RuntimeBootstrap assembles one XState v6 FabRuntime per FAB.
 */
export function AppProviders({ children, client, runtime = applicationRuntime }: {
  children: ReactNode;
  client?: QueryClient;
  runtime?: AppRuntime<never>;
}) {
  return (
    <AppRuntimeProvider runtime={runtime}>
      <RegistryContext.Provider value={runtime.registry}>
        <QueryProvider client={client}>
          <RuntimeBootstrap>
            <ErrorBoundary>{children}</ErrorBoundary>
          </RuntimeBootstrap>
        </QueryProvider>
      </RegistryContext.Provider>
    </AppRuntimeProvider>
  );
}
