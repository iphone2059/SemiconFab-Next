import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { queryClient as defaultQueryClient } from '../../api/queries/queryClient';

/** Supplies the single application QueryClient; tests may pass an isolated one. */
export function QueryProvider({ children, client = defaultQueryClient }: { children: ReactNode; client?: QueryClient }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
