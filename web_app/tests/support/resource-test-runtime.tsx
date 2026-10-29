import { RegistryContext } from '@effect/atom-react';
import { Layer } from 'effect';
import type { ReactNode } from 'react';
import { AppRuntimeProvider } from '@/app/app-runtime-provider';
import { createApplicationRuntime, type AppRuntime } from '@/app/app-runtime';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type { ResourceDefinition } from '@/api/resource';
import { sitesDefinition } from '@/api/sites.resource';
import { catalogDefinition } from '@/api/catalog.resource';
import { runDefinition, runResultsDefinition, runsDefinition } from '@/api/runs.resource';
import { researchEventsDefinition } from '@/api/research.resource';
import { waferRoutesDefinition } from '@/api/wafer.resource';
import { equipmentStatusDefinition } from '@/api/equipment.resource';
import type { SiteDto, CatalogPageDto, RunResult, RunSummary } from '@/contracts/app-contracts';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import type { WaferProduct, WaferRouteStep } from '@/domain/wafer-route';

/** Isolated application runtime for tests; call runtime.dispose() in afterEach. */
export type { AppRuntime } from '@/app/app-runtime';

export function createTestRuntime(registry?: AtomRegistry.AtomRegistry): AppRuntime<never> {
  return createApplicationRuntime({ layer: Layer.empty, registry });
}

/**
 * Seeds one resource through the manager's single commit port (the same path a
 * transport push/mutation/recovery snapshot uses). No test writes a registry
 * directly, so the seeded value is exactly what the commit protocol accepts.
 */
export function seedResource<A, E>(
  runtime: AppRuntime<never>,
  definition: ResourceDefinition<A, E>,
  value: A,
): void {
  const manager = runtime.resources;
  manager.publish(manager.handle(definition), value, 'recovery');
}

/** Reads the retained value of any definition through the manager (including previous success). */
export function readResourceValue<A, E>(
  runtime: AppRuntime<never>,
  definition: ResourceDefinition<A, E>,
): A | undefined {
  const manager = runtime.resources;
  return manager.value(manager.handle(definition));
}

/** Runtime pre-seeded with the sites document used by most page tests. */
export function createRuntimeWithSites(sites: SiteDto[], registry?: AtomRegistry.AtomRegistry): AppRuntime<never> {
  const runtime = createTestRuntime(registry);
  seedSites(runtime, sites);
  return runtime;
}

export function seedSites(runtime: AppRuntime<never>, sites: SiteDto[]): void {
  seedResource(runtime, sitesDefinition, sites);
}

export function seedCatalog(runtime: AppRuntime<never>, catalog: CatalogPageDto): void {
  seedResource(runtime, catalogDefinition, catalog);
}

export function seedRuns(runtime: AppRuntime<never>, runs: RunSummary[]): void {
  seedResource(runtime, runsDefinition, runs);
}

export function seedRun(runtime: AppRuntime<never>, runId: string, run: RunSummary): void {
  seedResource(runtime, runDefinition(runId), run);
}

export function seedRunResults(runtime: AppRuntime<never>, runId: string, results: RunResult): void {
  seedResource(runtime, runResultsDefinition(runId), results);
}

export function seedResearchEvents(runtime: AppRuntime<never>, events: string): void {
  seedResource(runtime, researchEventsDefinition, events);
}

export function seedWaferRoutes(runtime: AppRuntime<never>, routes: Record<WaferProduct, WaferRouteStep[]>): void {
  seedResource(runtime, waferRoutesDefinition, routes);
}

export function seedEquipmentStatus(
  runtime: AppRuntime<never>,
  siteId: string,
  fabId: string,
  snapshot: EquipmentStatusSnapshot,
): void {
  seedResource(runtime, equipmentStatusDefinition(siteId, fabId), snapshot);
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
  return readResourceValue(runtime, equipmentStatusDefinition(siteId, fabId));
}
