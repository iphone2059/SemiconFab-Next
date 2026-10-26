import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { ErrorBoundary } from '../../error-boundary';
import { store } from '../../store/store';
import { QueryProvider } from './QueryProvider';

/**
 * Application-wide providers: Redux owns view state, one QueryClient owns server
 * cache, and the existing Redux-backed ErrorBoundary keeps fatal rendering UI.
 */
export function AppProviders({ children, client }: { children: ReactNode; client?: QueryClient }) {
  return (
    <Provider store={store}>
      <QueryProvider client={client}>
        <ErrorBoundary>{children}</ErrorBoundary>
      </QueryProvider>
    </Provider>
  );
}
