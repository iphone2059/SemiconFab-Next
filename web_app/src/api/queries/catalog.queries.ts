import { queryOptions } from '@tanstack/react-query';
import { catalogPageSchema } from '../schemas/catalog.schema';
import { httpTransport } from '../transport/http';
import { queryKeys } from './queryKeys';

export const catalogQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.catalog.all,
    queryFn: async ({ signal }) => {
      const payload = await httpTransport.fetchJson('/api/v1/catalog', { signal });
      return catalogPageSchema.parse(payload);
    },
    staleTime: 60_000,
    retry: 0,
  });
