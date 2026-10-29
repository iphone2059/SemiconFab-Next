import { Effect } from 'effect';
import { parseWaferRoutes } from '@/domain/wafer-route';
import { httpTransport, InvalidServerResponse } from '@/api/http.transport';
import { makeResource } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';

export const fetchWaferRoutes = () => httpTransport.fetchJson('/twin/routes.json').pipe(Effect.flatMap(value => Effect.try({
  try: () => parseWaferRoutes(value),
  catch: cause => new InvalidServerResponse(cause instanceof Error ? cause.message : 'invalid wafer routes', cause),
})));

/** Static wafer routes resource; freshness is infinite, retention 10 minutes. */
export const waferRoutesResource = makeResource(fetchWaferRoutes(), RESOURCE_POLICIES.waferRoutes);
