import { queryOptions } from '@tanstack/react-query';
import { fetchText } from './http';
import { queryKeys } from './queryKeys';

/** Static JSONL replay events; long-lived cache, never polled. */
export const researchEventsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.research.events,
    queryFn: async ({ signal }) => fetchText('/twin/events-t1-fifo.jsonl', { signal }),
    staleTime: Infinity,
    gcTime: 600_000,
    retry: 0,
  });
