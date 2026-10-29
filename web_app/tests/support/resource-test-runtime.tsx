import { RegistryContext } from '@effect/atom-react';
import { Layer } from 'effect';
import type { ReactNode } from 'react';
import { AppRuntimeProvider } from '@/app/app-runtime-provider';
import { createApplicationRuntime, type AppRuntime } from '@/app/app-runtime';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { resourceValue, setResourceValue, type Resource } from '@/api/resource';
import { sitesResource } from '@/api/sites.resource';
import { catalogResource } from '@/api/catalog.resource';
import { runResource, runResultsResource, runsResource } from '@/api/runs.resource';
import { researchEventsResource } from '@/api/research.resource';
import { waferRoutesResource } from '@/api/wafer.resource';
import { equipmentStatusResource } from '@/api/equipment.resource';
import type { SiteDto, CatalogPageDto, RunResult, RunSummary } from '@/contracts/app-contracts';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import type { WaferProduct, WaferRouteStep } from '@/domain/wafer-route';

/** Isolated application runtime for tests; call runtime.dispose() in afterEach. */
export type { AppRuntime } from '@/app/app-runtime';

export function createTestRuntime(registry?: AtomRegistry.AtomRegistry): AppRuntime<never> {
  return createApplicationRuntime({ layer: Layer.empty, registry });
}

/** Runtime pre-seeded with the sites document used by most page tests. */
export function createRuntimeWithSites(sites: SiteDto[], registry?: AtomRegistry.AtomRegistry): AppRuntime<never> {
  const runtime = createTestRuntime(registry);
  seedSites(runtime, sites);
  return runtime;
}

export function seedResource<A, E>(runtime: AppRuntime<never>, resource: Resource<A, E>, value: A): void {
  setResourceValue(runtime, resource, value);
}

export function seedSites(runtime: AppRuntime<never>, sites: SiteDto[]): void {
  seedResource(runtime, sitesResource, sites);
}

export function seedCatalog(runtime: AppRuntime<never>, catalog: CatalogPageDto): void {
  seedResource(runtime, catalogResource, catalog);
}

export function seedRuns(runtime: AppRuntime<never>, runs: RunSummary[]): void {
  seedResource(runtime, runsResource, runs);
}

export function seedRun(runtime: AppRuntime<never>, runId: string, run: RunSummary): void {
  seedResource(runtime, runResource(runId), run);
}

export function seedRunResults(runtime: AppRuntime<never>, runId: string, results: RunResult): void {
  seedResource(runtime, runResultsResource(runId), results);
}

export function seedResearchEvents(runtime: AppRuntime<never>, events: string): void {
  seedResource(runtime, researchEventsResource, events);
}

export function seedWaferRoutes(runtime: AppRuntime<never>, routes: Record<WaferProduct, WaferRouteStep[]>): void {
  seedResource(runtime, waferRoutesResource, routes);
}

export function seedEquipmentStatus(
  runtime: AppRuntime<never>,
  siteId: string,
  fabId: string,
  snapshot: EquipmentStatusSnapshot,
): void {
  seedResource(runtime, equipmentStatusResource(siteId, fabId), snapshot);
}

/**
 * Minimal provider stack for component tests: the same AppRuntime/RegistryContext
 * the product uses, without RuntimeBootstrap's FAB assembly side effects.
 */
export function ResourceTestProviders({ runtime, children }: { runtime: AppRuntime<never>; children: ReactNode }) {
  return (
    <AppRuntimeProvider runtime={runtime}>
      <RegistryContext.Provider value={runtime.registry}>{children}</RegistryContext.Provider>
    </AppRuntimeProvider>
  );
}

export function readEquipmentStatus(
  runtime: AppRuntime<never>,
  siteId: string,
  fabId: string,
): EquipmentStatusSnapshot | undefined {
  return resourceValue(runtime.registry, equipmentStatusResource(siteId, fabId));
}

export function readResourceValue<A, E>(runtime: AppRuntime<never>, resource: Resource<A, E>): A | undefined {
  return resourceValue(runtime.registry, resource);
}
