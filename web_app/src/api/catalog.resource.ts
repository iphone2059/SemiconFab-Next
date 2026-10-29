import type { CatalogPageDto } from '@/contracts/app-contracts';
import { Effect } from 'effect';
import { catalogPageSchema } from '@/api/catalog.schema';
import { httpTransport, decodeApiResponse, type ApiError } from '@/api/http.transport';
import { makeResource } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';

export const fetchCatalog = (): Effect.Effect<CatalogPageDto, ApiError> => httpTransport.fetchJson('/api/v1/catalog').pipe(
  Effect.flatMap(decodeApiResponse(catalogPageSchema, 'invalid catalog response')),
);

/** Catalog resource Atom (60s freshness). */
export const catalogResource = makeResource(fetchCatalog(), RESOURCE_POLICIES.catalog);
