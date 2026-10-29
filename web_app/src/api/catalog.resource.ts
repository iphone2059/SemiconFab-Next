import type { CatalogPageDto } from '@/contracts/app-contracts';
import { Effect } from 'effect';
import { catalogPageSchema } from '@/api/catalog.schema';
import { httpTransport, decodeApiResponse, type ApiError } from '@/api/http.transport';
import { defineResource } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';

export const fetchCatalog = (): Effect.Effect<CatalogPageDto, ApiError> => httpTransport.fetchJson('/api/v1/catalog').pipe(
  Effect.flatMap(decodeApiResponse(catalogPageSchema, 'invalid catalog response')),
);

/** Static catalog definition (60s freshness). */
export const catalogDefinition = defineResource({
  identity: { kind: 'catalog', version: 1, key: 'catalog' },
  load: fetchCatalog(),
  policy: RESOURCE_POLICIES.catalog,
});
