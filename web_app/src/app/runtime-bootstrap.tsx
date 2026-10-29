import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Effect, Scope } from 'effect';
import type { AppRuntime } from '@/app/app-runtime';
import type { CommandEventSource } from '@/contracts/command-events.contract';
import { sitesDefinition } from '@/api/sites.resource';
import { useResource } from '@/api/use-resource';
import { FabLifecycleCoordinator } from '@/runtime/fab-lifecycle-coordinator';
import { FabRuntimeFactory } from '@/runtime/fab-runtime-factory';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import { createPendingCommandEventSource } from '@/runtime/command-sources';
import { createHttpCommandGateway } from '@/api/http-command-gateway';
import {
  createSseCommandEventSource,
  type CommandTransportFinalizerHost,
} from '@/realtime/command-event-source.transport';
import { TelemetryRuntime } from '@/realtime/telemetry-runtime';
import { FabTelemetryRegistry } from '@/realtime/telemetry-registry';
import { RuntimeProvider } from '@/app/runtime-provider';
import { TelemetryProvider } from '@/app/telemetry-provider';

/**
 * Product runtime wiring: one FabRuntime per FAB discovered from the sites
 * document, backed by one FAB-scoped backend command SSE stream (?fabId=) inside
 * that FAB's CommandTransportScope, one FAB-scoped telemetry runtime
 * (SSE -> Worker -> typed frame), and the HTTP authoritative command gateway.
 * When the browser lacks EventSource/Worker (tests/jsdom), the runtime falls back
 * to the empty CommandEventSource seam.
 *
 * Phase C ownership: every FAB scope is forked from AppRuntime.rootScope by the
 * FabRuntime itself; the transport receives its CommandTransportScope and
 * registers its EventSource/timer finalizers there, so no business module owns a
 * detached scope or an unowned Effect fiber.
 */
export function RuntimeBootstrap({ children, appRuntime }: { children: ReactNode; appRuntime: AppRuntime<never> }) {
  const [registry] = useState(() => new FabRuntimeRegistry());
  const [telemetryRegistry] = useState(() => new FabTelemetryRegistry());
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const lifecycle = useRef<FabLifecycleCoordinator | undefined>(undefined);
  const signature = useRef('');
  const sitesResourceView = useResource(appRuntime, sitesDefinition);
  const sites = sitesResourceView.data;
  const projectionRegistry = appRuntime.registry;
  const runPromise = appRuntime.runPromise;
  const runSync = appRuntime.runSync;
  const rootScope = appRuntime.rootScope;

  useEffect(() => {
    if (!sites) return;
    const fabs = sites.flatMap((site) => site.fabs.map((fab) => ({ siteId: site.siteId, fabId: fab.fabId })));
    const nextSignature = fabs.map((fab) => `${fab.siteId}:${fab.fabId}`).join('|');
    if (nextSignature === signature.current) return;
    lifecycle.current?.dispose();
    lifecycle.current = undefined;
    telemetryRegistry.disposeAll();
    registry.disposeAll();

    const siteByFab = new Map(fabs.map((fab) => [fab.fabId, fab.siteId]));
    const transportHost = (scope: Scope.Scope): CommandTransportFinalizerHost => ({
      addFinalizer: (finalizer) => {
        runSync(Scope.addFinalizer(scope, Effect.sync(finalizer)));
      },
    });
    // One command SSE stream per FAB: the backend scopes + authorizes the stream
    // by the fabId query parameter and emits only that FAB's command results.
    // No site-level shared source exists (that would cross FAB identities and
    // fail FAB-scoped authorization). The stream is lazy: FabRuntime/EventSource
    // open it on the first tracked command.
    const sourceFor = (fabId: string, scope: Scope.Scope): CommandEventSource => {
      const siteId = siteByFab.get(fabId);
      if (siteId === undefined || typeof EventSource === 'undefined') return createPendingCommandEventSource();
      return createSseCommandEventSource(
        `/api/v1/sites/${encodeURIComponent(siteId)}/commands/stream?fabId=${encodeURIComponent(fabId)}`,
        { host: transportHost(scope) },
      );
    };
    const gateway = typeof fetch === 'function' ? createHttpCommandGateway({ runPromise }) : undefined;
    const factory = new FabRuntimeFactory({
      runtime: appRuntime,
      parentScope: rootScope,
      projectionRegistry,
      sourceFor,
      gateway,
      lazyCommandSubscription: true,
    });
    for (const fab of fabs) registry.register(factory.create(fab.fabId, fab.siteId));

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
  }, [sites, registry, telemetryRegistry, projectionRegistry, runPromise, runSync, rootScope, appRuntime]);

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
