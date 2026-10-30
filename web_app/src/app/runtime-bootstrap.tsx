import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Effect, Scope } from 'effect';
import type { AppRuntime } from '@/app/app-runtime';
import type { CommandEventSource } from '@/contracts/command-events.contract';
import type { CommandGateway } from '@/contracts/command-gateway.contract';
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
 * Environment capabilities that gate the command composition (R4-06).
 *
 * These are probed once per assembled runtime generation. They are explicit
 * inputs so the production fail-fast policy is testable without a real browser
 * bundle: the composition root never inspects them implicitly.
 */
export interface CommandCompositionCapabilities {
  /** A realtime command transport (EventSource) exists in this environment. */
  readonly realtimeTransport: boolean;
  /** The HTTP transport used by the authoritative CommandGateway exists. */
  readonly httpTransport: boolean;
  /** The build's import.meta.env.PROD flag. */
  readonly production: boolean;
}

/** Explicit command authority for one runtime generation (R3-07/R4-06). */
export interface CommandComposition {
  /** True only when a realtime command transport could be constructed. */
  readonly realtimeTransport: boolean;
  /**
   * Authoritative recovery authority; `undefined` declares an explicitly
   * display-only runtime when fetch is unavailable.
   */
  readonly gateway: CommandGateway | undefined;
}

/** Resolve HTTP authority and realtime capability independently. */
export function resolveCommandComposition(capabilities: CommandCompositionCapabilities): CommandComposition {
  return {
    realtimeTransport: capabilities.realtimeTransport,
    gateway: capabilities.httpTransport ? createHttpCommandGateway() : undefined,
  };
}

/**
 * Product runtime wiring: one FabRuntime per FAB discovered from the sites
 * document, backed by one FAB-scoped backend command SSE stream (?fabId=) inside
 * that FAB's CommandTransportScope, one FAB-scoped telemetry runtime
 * (SSE -> Worker -> typed frame), and the HTTP authoritative command gateway.
 *
 * HTTP and realtime availability are independent: absent EventSource degrades
 * the runtime; absent HTTP authority makes command recovery unavailable.
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
    // fail FAB-scoped authorization). Round 5.1 / P2-02: the production
    // composition root explicitly opts into on-demand subscription - the runtime
    // opens at most one Command SSE per FAB only while that FAB has an admission
    // reservation, an active workflow or an unresolved held/conflict event.
    // R4-06: probe the environment once per assembled generation and derive the
    // explicit command capabilities from it. Missing realtime uses the pending source;
    // HTTP availability alone determines whether a gateway can be assembled.
    const composition = resolveCommandComposition({
      realtimeTransport: typeof EventSource !== 'undefined',
      httpTransport: typeof fetch === 'function',
      production: import.meta.env.PROD,
    });
    const sourceFor = (fabId: string, scope: Scope.Scope): CommandEventSource => {
      const siteId = siteByFab.get(fabId);
      if (!composition.realtimeTransport || siteId === undefined) return createPendingCommandEventSource();
      return createSseCommandEventSource(
        `/api/v1/sites/${encodeURIComponent(siteId)}/commands/stream?fabId=${encodeURIComponent(fabId)}`,
        { host: transportHost(scope) },
      );
    };
    // ADR-011 §2.1: the gateway returns native Effects and never runs them; the
    // FabRuntime executes them through the AppRuntime boundary.
    // The gateway and EventSource are assembled independently.
    const factory = new FabRuntimeFactory({
      runtime: appRuntime,
      parentScope: rootScope,
      projectionRegistry,
      sourceFor,
      gateway: composition.gateway,
      // P2-02: explicit production configuration; never rely on an implicit default.
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
  }, [sites, registry, telemetryRegistry, projectionRegistry, runSync, rootScope, appRuntime]);

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
