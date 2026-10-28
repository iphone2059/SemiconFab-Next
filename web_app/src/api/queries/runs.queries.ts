import { queryOptions } from '@tanstack/react-query';
import { runListSchema, runResultSchema, runSummarySchema } from '../schemas/runs.schema';
import { httpTransport } from '../transport/http';
import { queryKeys } from './queryKeys';

export const runsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.runs.all,
    queryFn: async ({ signal }) => {
      const payload = await httpTransport.fetchJson('/api/v1/runs', { signal });
      return runListSchema.parse(payload);
    },
    staleTime: 0,
    retry: 0,
  });

export const runQueryOptions = (runId: string) =>
  queryOptions({
    queryKey: queryKeys.runs.detail(runId),
    queryFn: async ({ signal }) => {
      const payload = await httpTransport.fetchJson(`/api/v1/runs/${encodeURIComponent(runId)}`, { signal });
      return runSummarySchema.parse(payload);
    },
    staleTime: 0,
    retry: 0,
  });

export const runResultsQueryOptions = (runId: string) =>
  queryOptions({
    queryKey: queryKeys.runs.results(runId),
    queryFn: async ({ signal }) => {
      const payload = await httpTransport.fetchJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/results`,
        { signal },
      );
      return runResultSchema.parse(payload);
    },
    staleTime: 0,
    retry: 0,
  });
