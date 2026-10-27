import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CommandEventSource } from '../../application/contracts/CommandEvents';
import { sitesQueryOptions } from '../../api/queries/sites.queries';
import { FabLifecycleCoordinator } from '../../runtime/FabLifecycleCoordinator';
import { FabRuntimeFactory } from '../../runtime/FabRuntimeFactory';
import { FabRuntimeRegistry } from '../../runtime/FabRuntimeRegistry';
import { createPendingCommandEventSource } from '../../runtime/commandSources';
import { createHttpCommandGateway } from '../../realtime/transport/HttpCommandGateway';
import { createSseCommandEventSource } from '../../realtime/transport/SseCommandEventSource';
import { TelemetryRuntime } from '../../realtime/telemetry/TelemetryRuntime';
import { FabTelemetryRegistry } from '../../realtime/telemetry/FabTelemetryRegistry';
import { RuntimeProvider } from './RuntimeProvider';
import { TelemetryProvider } from './TelemetryProvider';

/**
 * Product runtime wiring: one FabRuntime per FAB discovered from the sites
 * document, backed by one FAB-scoped backend command SSE stream (?fabId=) and
 * one FAB-scoped telemetry runtime (SSE -> Worker -> typed frame) per FAB, plus
 * the HTTP authoritative command gateway. When the browser lacks
 * EventSource/Worker (tests/jsdom), the runtime falls back to the empty
 * CommandEventSource seam.
 */
export function RuntimeBootstrap({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new FabRuntimeRegistry());
  const [telemetryRegistry] = useState(() => new FabTelemetryRegistry());
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const lifecycle = useRef<FabLifecycleCoordinator | undefined>(undefined);
  const signature = useRef('');
  const sitesQuery = useQuery(sitesQueryOptions());
  const sites = sitesQuery.data;

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
    const gateway = typeof fetch === 'function' ? createHttpCommandGateway() : undefined;
    const factory = new FabRuntimeFactory({
      sourceFor: (fabId) => sourceByFab.get(fabId) ?? createPendingCommandEventSource(),
      gateway,
      lazyCommandSubscription: true,
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
  }, [sites, registry, telemetryRegistry]);

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
