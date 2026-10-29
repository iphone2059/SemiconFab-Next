import { Option } from 'effect';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppRuntime } from '@/app/app-runtime';
import type { CommandEventSource } from '@/contracts/command-events.contract';
import { sitesResource } from '@/api/sites.resource';
import { useResource } from '@/api/use-resource';
import { FabLifecycleCoordinator } from '@/runtime/fab-lifecycle-coordinator';
import { FabRuntimeFactory } from '@/runtime/fab-runtime-factory';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import { createPendingCommandEventSource } from '@/runtime/command-sources';
import { createHttpCommandGateway } from '@/api/http-command-gateway';
import { createSseCommandEventSource } from '@/realtime/command-event-source.transport';
import { TelemetryRuntime } from '@/realtime/telemetry-runtime';
import { FabTelemetryRegistry } from '@/realtime/telemetry-registry';
import { RuntimeProvider } from '@/app/runtime-provider';
import { TelemetryProvider } from '@/app/telemetry-provider';

/**
 * Product runtime wiring: one FabRuntime per FAB discovered from the sites
 * document, backed by one FAB-scoped backend command SSE stream (?fabId=) and
 * one FAB-scoped telemetry runtime (SSE -> Worker -> typed frame) per FAB, plus
 * the HTTP authoritative command gateway. When the browser lacks
 * EventSource/Worker (tests/jsdom), the runtime falls back to the empty
 * CommandEventSource seam.
 */
export function RuntimeBootstrap({ children, appRuntime }: { children: ReactNode; appRuntime: AppRuntime<never> }) {
  const [registry] = useState(() => new FabRuntimeRegistry());
  const [telemetryRegistry] = useState(() => new FabTelemetryRegistry());
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const lifecycle = useRef<FabLifecycleCoordinator | undefined>(undefined);
  const signature = useRef('');
  const sitesResourceView = useResource(appRuntime, sitesResource);
  const sites = sitesResourceView.data;
  const projectionRegistry = appRuntime.registry;
  const runPromise = appRuntime.runPromise;

  useEffect(() => {
    if (!sites) return;
    const fabs = sites.flatMap((site) => site.fabs.map((fab) => ({ siteId: site.siteId, fabId: fab.fabId })));
    const nextSignature = fabs.map((fab) => `${fab.siteId}:${fab.fabId}`).join('|');
    if (nextSignature === signature.current) return;
    lifecycle.current?.dispose();
    lifecycle.current = undefined;
    telemetryRegistry.disposeAll();
    registry.disposeAll();

    // One command SSE stream per FAB: the backend scopes + authorizes the stream
    // by the fabId query parameter and emits only that FAB's command results.
    // No site-level shared source exists (that would cross FAB identities and
    // fail FAB-scoped authorization).
    const sourceByFab = new Map<string, CommandEventSource>();
    for (const fab of fabs) {
      sourceByFab.set(
        fab.fabId,
        typeof EventSource === 'undefined'
          ? createPendingCommandEventSource()
          : createSseCommandEventSource(
            `/api/v1/sites/${encodeURIComponent(fab.siteId)}/commands/stream?fabId=${encodeURIComponent(fab.fabId)}`,
          ),
      );
    }
    const httpGateway = typeof fetch === 'function' ? createHttpCommandGateway() : undefined;
    // Transitional UI composition edge; Task 4 replaces the legacy recovery contract.
    const gateway = httpGateway && { getCommandStatus: (fabId: string, commandId: string) =>
      runPromise(httpGateway.getCommandStatus(fabId, commandId)).then(Option.getOrNull) };
    const factory = new FabRuntimeFactory({
      sourceFor: (fabId) => sourceByFab.get(fabId) ?? createPendingCommandEventSource(),
      gateway,
      lazyCommandSubscription: true,
      projectionRegistry,
    });
    for (const fab of fabs) registry.register(factory.create(fab.fabId));

    // One telemetry runtime per FAB: the backend telemetry stream is FAB-scoped
    // and carries a per-connection sequence, so a site aggregate would mix FABs.
    if (typeof EventSource !== 'undefined' && typeof Worker !== 'undefined') {
      const telemetry = new Map<string, TelemetryRuntime>();
      for (const fab of fabs) {
        const runtime = new TelemetryRuntime({
          url: `/api/v1/sites/${encodeURIComponent(fab.siteId)}/fabs/${encodeURIComponent(fab.fabId)}/telemetry/stream`,
          fabId: fab.fabId,
        });
        // Do not open FAB telemetry SSE/Worker until a page actually consumes
        // this FAB (useFabTelemetry); idle streams consume the browser's
        // per-origin HTTP/1.1 connection budget and can block 3D module loads.
        telemetry.set(fab.fabId, runtime);
      }
      telemetryRegistry.replaceAll(telemetry);
    }

    const coordinator = new FabLifecycleCoordinator(registry);
    coordinator.start();
    lifecycle.current = coordinator;
    signature.current = nextSignature;
    // Registry mutations are not React state; re-render once so consumers
    // (command console/sidebar) see the assembled runtimes.
    setRuntimeVersion((value) => value + 1);
  }, [sites, registry, telemetryRegistry, projectionRegistry, runPromise]);

  useEffect(() => () => {
    lifecycle.current?.dispose();
    lifecycle.current = undefined;
    telemetryRegistry.disposeAll();
    signature.current = '';
  }, [registry, telemetryRegistry]);

  return (
    <RuntimeProvider registry={registry} version={runtimeVersion}>
      <TelemetryProvider registry={telemetryRegistry} version={runtimeVersion}>{children}</TelemetryProvider>
    </RuntimeProvider>
  );
}
