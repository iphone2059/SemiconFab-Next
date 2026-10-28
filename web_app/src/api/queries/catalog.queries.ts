import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import type { CatalogPageDto } from '../../contracts';
import { httpTransport } from '../transport/http';
import { queryKeys } from './queryKeys';

// The catalog is a read-only snapshot; entries are defensively parsed by
// catalog-data.parseCatalogEntries, so the transport validates only the envelope.
const catalogEnvelopeSchema = z.looseObject({
  importId: z.string(),
  items: z.array(z.unknown()),
});

export const catalogQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.catalog.all,
    queryFn: async ({ signal }) => {
      const payload = await httpTransport.fetchJson('/api/v1/catalog', { signal });
      const envelope = catalogEnvelopeSchema.parse(payload);
      return envelope as unknown as CatalogPageDto;
    },
    staleTime: 60_000,
    retry: 0,
  });
