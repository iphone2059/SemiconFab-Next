import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sitesQueryOptions } from '../../api/queries/sites.queries';
import { FabLifecycleCoordinator } from '../../runtime/FabLifecycleCoordinator';
import { FabRuntimeFactory } from '../../runtime/FabRuntimeFactory';
import { FabRuntimeRegistry } from '../../runtime/FabRuntimeRegistry';
import { createPendingCommandEventSource } from '../../runtime/commandSources';
import { RuntimeProvider } from './RuntimeProvider';

/**
 * Product runtime wiring: one FabRuntime per FAB discovered from the sites
 * document. The command source is a replaceable CommandEventSource (currently
 * empty because the backend realtime transport is still a placeholder); XState
 * v6 is now part of the product lifecycle/bundle, not only tests.
 */
export function RuntimeBootstrap({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new FabRuntimeRegistry());
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
    registry.disposeAll();
    const factory = new FabRuntimeFactory({ sourceFor: () => createPendingCommandEventSource() });
    for (const fab of fabs) registry.register(factory.create(fab.fabId));
    const coordinator = new FabLifecycleCoordinator(registry);
    coordinator.start();
    lifecycle.current = coordinator;
    signature.current = nextSignature;
  }, [sites, registry]);

  useEffect(() => () => {
    lifecycle.current?.dispose();
    lifecycle.current = undefined;
    signature.current = '';
  }, [registry]);

  return <RuntimeProvider registry={registry}>{children}</RuntimeProvider>;
}
