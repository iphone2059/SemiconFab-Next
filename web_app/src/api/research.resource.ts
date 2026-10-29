import { httpTransport } from '@/api/http.transport';
import { defineResource } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';

/** Static JSONL replay events; freshness is infinite, retention 10 minutes. */
export const researchEventsDefinition = defineResource({
  identity: { kind: 'research-events', version: 1, key: 'research-events' },
  load: httpTransport.fetchText('/twin/events-t1-fifo.jsonl'),
  policy: RESOURCE_POLICIES.researchEvents,
});
