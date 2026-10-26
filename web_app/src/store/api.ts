import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { CatalogPageDto, RunResult, RunSummary } from '../contracts';
import type { EquipmentStatusSnapshot } from '../equipment-status';
import { parseWaferRoutes, type WaferProduct, type WaferRouteStep } from '../wafer-route';

const rootQuery = fetchBaseQuery({ baseUrl: '/', credentials: 'same-origin', cache: 'no-store',
  fetchFn: (input, init) => globalThis.fetch(input, init),
});

// /api/v1/sites is owned by TanStack Query (api/queries/sites.queries.ts) so the
// router loaders, Workbench and Twin share one cache (ARCH G-02). The remaining
// endpoints stay on RTK Query until the M2 migration.
export const twinApi = createApi({
  reducerPath: 'twinApi',
  baseQuery: rootQuery,
  tagTypes: ['EquipmentStatus', 'Catalog', 'Runs'],
  endpoints: (builder) => ({
    getEquipmentStatus: builder.query<EquipmentStatusSnapshot, string>({
      query: (siteId) => `api/v1/sites/${encodeURIComponent(siteId)}/equipment-status`,
      providesTags: (_result, _error, siteId) => [{ type: 'EquipmentStatus', id: siteId }],
    }),
    getResearchEvents: builder.query<string, void>({
      queryFn: async () => {
        try {
          const response = await fetch('/twin/events-t1-fifo.jsonl', { cache: 'no-store' });
          if (!response.ok) return { error: { status: response.status, data: await response.text() } };
          return { data: await response.text() };
        } catch (error) {
          return { error: { status: 'FETCH_ERROR' as const, error: error instanceof Error ? error.message : 'research fetch failed' } };
        }
      },
      keepUnusedDataFor: 600,
    }),
    getWaferRoutes: builder.query<Record<WaferProduct, WaferRouteStep[]>, void>({
      query: () => 'twin/routes.json',
      transformResponse: (value: unknown) => parseWaferRoutes(value),
      keepUnusedDataFor: 600,
    }),
    getCatalog: builder.query<CatalogPageDto, { domain?: string; category?: string; q?: string } | void>({
      query: (filters = {}) => {
        const query = new URLSearchParams();
        if (filters) for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
        return `api/v1/catalog${query.size ? `?${query}` : ''}`;
      },
      providesTags: ['Catalog'],
    }),
    getRuns: builder.query<RunSummary[], void>({ query: () => 'api/v1/runs', providesTags: ['Runs'] }),
    getRun: builder.query<RunSummary, string>({ query: (id) => `api/v1/runs/${encodeURIComponent(id)}`, providesTags: ['Runs'] }),
    getRunResults: builder.query<RunResult, string>({ query: (id) => `api/v1/runs/${encodeURIComponent(id)}/results` }),
    createRun: builder.mutation<RunSummary, { request: unknown; idempotencyKey: string }>({
      query: ({ request, idempotencyKey }) => ({
        url: 'api/v1/runs', method: 'POST', body: request,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      }),
      invalidatesTags: ['Runs'],
    }),
  }),
});

export const {
  useGetEquipmentStatusQuery, useGetResearchEventsQuery, useGetWaferRoutesQuery,
  useGetCatalogQuery, useGetRunsQuery, useGetRunQuery, useGetRunResultsQuery, useCreateRunMutation,
} = twinApi;
