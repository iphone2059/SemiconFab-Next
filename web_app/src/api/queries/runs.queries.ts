import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import type { RunResult, RunSummary } from '../../contracts';
import { fetchJson } from './http';
import { queryKeys } from './queryKeys';

const runSchema = z.looseObject({
  runId: z.string().min(1),
  siteId: z.string().min(1),
  status: z.string().min(1),
  version: z.string(),
  createdAtUtc: z.string(),
  executions: z.array(z.unknown()),
});
const runListSchema = z.array(runSchema);

const runResultSchema = z.looseObject({
  runId: z.string().min(1),
  fabs: z.array(z.unknown()),
});

export const runsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.runs.all,
    queryFn: async ({ signal }) => {
      const payload = await fetchJson('/api/v1/runs', { signal });
      return runListSchema.parse(payload) as RunSummary[];
    },
    staleTime: 0,
    retry: 0,
  });

export const runQueryOptions = (runId: string) =>
  queryOptions({
    queryKey: queryKeys.runs.detail(runId),
    queryFn: async ({ signal }) => {
      const payload = await fetchJson(`/api/v1/runs/${encodeURIComponent(runId)}`, { signal });
      return runSchema.parse(payload) as RunSummary;
    },
    staleTime: 0,
    retry: 0,
  });

export const runResultsQueryOptions = (runId: string) =>
  queryOptions({
    queryKey: queryKeys.runs.results(runId),
    queryFn: async ({ signal }) => {
      const payload = await fetchJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/results`,
        { signal },
      );
      return runResultSchema.parse(payload) as RunResult;
    },
    staleTime: 0,
    retry: 0,
  });
