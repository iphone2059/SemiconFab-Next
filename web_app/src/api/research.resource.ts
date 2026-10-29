import { Effect } from 'effect';
import { httpTransport } from '@/api/http.transport';
import { makeResource } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';

/** Static JSONL replay events; freshness is infinite, retention 10 minutes. */
export const researchEventsResource = makeResource(
  httpTransport.fetchText('/twin/events-t1-fifo.jsonl'),
  RESOURCE_POLICIES.researchEvents,
);

export const fetchResearchEvents = () => researchEventsResource.load;

/** Kept as the explicit loader type for tests/tools that only need the Effect. */
export type ResearchEventsLoader = Effect.Effect<string, import('@/api/http.transport').ApiError>;
