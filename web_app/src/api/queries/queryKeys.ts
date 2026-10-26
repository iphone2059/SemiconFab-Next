/**
 * Central query-key factory for the V2.1 Query cache. Keys carry the identity
 * that scopes the data: site-scoped equipment status keeps the site id in the
 * key (RQ-04), run keys carry the run id, and list/detail prefixes stay stable
 * so mutation invalidation cannot drift from the consuming hooks.
 */
export const queryKeys = {
  sites: {
    all: ['sites'] as const,
  },
  equipment: {
    status: (siteId: string) => ['equipment', 'status', siteId] as const,
  },
  catalog: {
    all: ['catalog'] as const,
  },
  runs: {
    all: ['runs'] as const,
    detail: (runId: string) => ['runs', runId] as const,
    results: (runId: string) => ['runs', runId, 'results'] as const,
  },
  research: {
    events: ['research', 'events'] as const,
  },
  wafer: {
    routes: ['wafer', 'routes'] as const,
  },
} as const;
