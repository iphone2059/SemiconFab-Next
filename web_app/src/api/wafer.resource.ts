import { Effect } from 'effect';
import { parseWaferRoutes } from '@/domain/wafer-route';
import { httpTransport, InvalidServerResponse } from '@/api/http.transport';
import { defineResource } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';

export const fetchWaferRoutes = () => httpTransport.fetchJson('/twin/routes.json').pipe(Effect.flatMap(value => Effect.try({
  try: () => parseWaferRoutes(value),
  catch: cause => new InvalidServerResponse(cause instanceof Error ? cause.message : 'invalid wafer routes', cause),
})));

/** Static wafer-routes definition; freshness is infinite, retention 10 minutes. */
export const waferRoutesDefinition = defineResource({
  key: 'wafer-routes',
  load: fetchWaferRoutes(),
  policy: RESOURCE_POLICIES.waferRoutes,
});
