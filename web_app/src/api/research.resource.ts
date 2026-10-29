import { Effect } from 'effect';
import { queryOptions } from '@tanstack/react-query';
import { httpTransport } from '@/api/http.transport';
import { queryKeys } from '@/api/query-keys';

/** Static JSONL replay events; long-lived cache, never polled. */
export const researchEventsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.research.events,
    queryFn: ({ signal }) => Effect.runPromise(fetchResearchEvents(), { signal }),
    staleTime: Infinity,
    gcTime: 600_000,
    retry: 0,
  });

export const fetchResearchEvents = () => httpTransport.fetchText('/twin/events-t1-fifo.jsonl');
