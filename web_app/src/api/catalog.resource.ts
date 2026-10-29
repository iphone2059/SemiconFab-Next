import { queryOptions } from '@tanstack/react-query';
import { catalogPageSchema } from '@/api/catalog.schema';
import { httpTransport } from '@/api/http.transport';
import { queryKeys } from '@/api/query-keys';

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
