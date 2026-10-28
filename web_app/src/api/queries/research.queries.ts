import { queryOptions } from '@tanstack/react-query';
import { httpTransport } from '../transport/http';
import { queryKeys } from './queryKeys';

/** Static JSONL replay events; long-lived cache, never polled. */
export const researchEventsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.research.events,
    queryFn: async ({ signal }) => httpTransport.fetchText('/twin/events-t1-fifo.jsonl', { signal }),
    staleTime: Infinity,
    gcTime: 600_000,
    retry: 0,
  });
