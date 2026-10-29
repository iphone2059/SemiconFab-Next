import { Effect } from 'effect';
import { runListSchema, runResultSchema, runSummarySchema } from '@/api/runs.schema';
import { httpTransport, decodeApiResponse } from '@/api/http.transport';
import { defineResource, type ResourceKey } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';

export const fetchRuns = () => httpTransport.fetchJson('/api/v1/runs').pipe(Effect.flatMap(decodeApiResponse(runListSchema, 'invalid run list')));
export const fetchRun = (runId: string) => httpTransport.fetchJson(`/api/v1/runs/${encodeURIComponent(runId)}`).pipe(Effect.flatMap(decodeApiResponse(runSummarySchema, 'invalid run response')));
export const fetchRunResults = (runId: string) => httpTransport.fetchJson(`/api/v1/runs/${encodeURIComponent(runId)}/results`).pipe(Effect.flatMap(decodeApiResponse(runResultSchema, 'invalid run result')));

/** Static runs-list definition (1.5s polling while at least one consumer is retained). */
export const runsDefinition = defineResource({
  identity: { kind: 'runs', version: 1, key: 'runs' },
  load: fetchRuns(),
  policy: RESOURCE_POLICIES.runs,
});

/** Canonical dynamic resource key for one Run detail (ADR-006 §2.1: `run\0{runId}`). */
export const runKey = (runId: string): ResourceKey => 'run\u0000' + runId;
/** Canonical dynamic resource key for one Run result document. */
export const runResultsKey = (runId: string): ResourceKey => 'run-results\u0000' + runId;

/**
 * Dynamic Run-detail definition. Creation is cheap and stateless: the manager
 * caches the definition handle by key and reclaims it on idle TTL (ADR-006 §2.7).
 */
export const runDefinition = (runId: string) => defineResource({
  identity: { kind: 'run-detail', version: 1, key: runKey(runId) },
  load: fetchRun(runId),
  policy: RESOURCE_POLICIES.runDetail,
});

/** Dynamic Run-results definition (only requested once the backend reports COMPLETED). */
export const runResultsDefinition = (runId: string) => defineResource({
  identity: { kind: 'run-results', version: 1, key: runResultsKey(runId) },
  load: fetchRunResults(runId),
  policy: RESOURCE_POLICIES.runResults,
});

/** Explicit exported type: the router/loaders and tests can name the dynamic definition. */
export type RunDefinition = ReturnType<typeof runDefinition>;
export type RunResultsDefinition = ReturnType<typeof runResultsDefinition>;
