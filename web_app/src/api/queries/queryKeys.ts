/**
 * Central query-key factory. Only the sites endpoint moved to TanStack Query in
 * M1; every other endpoint stays on RTK Query until the M2 migration.
 */
export const queryKeys = {
  sites: {
    all: ['sites'] as const,
  },
} as const;
