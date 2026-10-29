import type { ReactNode } from 'react';
import { RegistryContext } from '@effect/atom-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { applicationRuntime, type AppRuntime } from '@/app/app-runtime';
import { AppRuntimeProvider } from '@/app/app-runtime-provider';
import { RuntimeBootstrap } from '@/app/runtime-bootstrap';

/**
 * Application-wide providers: the app-owned AppRuntime supplies the single
 * AtomRegistry to React; TanStack Query still owns server data until Task 5 and
 * RuntimeBootstrap assembles one XState v6 FabRuntime per FAB.
 */
export function AppProviders({ children, runtime = applicationRuntime }: {
  children: ReactNode;
  runtime?: AppRuntime<never>;
}) {
  return (
    <AppRuntimeProvider runtime={runtime}>
      <RegistryContext.Provider value={runtime.registry}>
        <RuntimeBootstrap appRuntime={runtime}>
          <ErrorBoundary>{children}</ErrorBoundary>
        </RuntimeBootstrap>
      </RegistryContext.Provider>
    </AppRuntimeProvider>
  );
}
