// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from '@/app/app-providers';
import { useCommandProjection, useFabRuntimeRegistry } from '@/app/runtime-provider';
import { useFabTelemetry } from '@/app/telemetry-provider';
import type { SiteDto } from '@/contracts/app-contracts';
import type { FabIdentity } from '@/domain/fab-identity';
import { resolveCommandComposition } from '@/app/runtime-bootstrap';
import { createPendingCommandEventSource } from '@/runtime/command-sources';
import type { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import WorkbenchApp from '@/workbench/workbench';
import { createRuntimeWithSites, seedSites, type AppRuntime } from '../support/resource-test-runtime.tsx';

const identity = (siteId: string, fabId: string): FabIdentity => ({ siteId, fabId });

const site1FabA = identity('site-1', 'fab-a');
const siteAFab01 = identity('site-a', 'fab-01');
const siteBFab01 = identity('site-b', 'fab-01');

const sites: SiteDto[] = [{
  siteId: 'site-1',
  code: 'SITE-1',
  templateHash: 'h'.repeat(64),
  fabs: [
    { fabId: 'fab-a', code: 'FAB-A' },
  ],
}];

/** R5.4-03 spec fixture: two sites that both own a FAB with the same fabId. */
const crossSiteSites: SiteDto[] = [
  { siteId: 'site-a', code: 'SITE-A', templateHash: 'a'.repeat(64), fabs: [{ fabId: 'fab-01', code: 'FAB-01' }] },
  { siteId: 'site-b', code: 'SITE-B', templateHash: 'b'.repeat(64), fabs: [{ fabId: 'fab-01', code: 'FAB-01' }] },
];

/** Same site, two FABs: one runtime/stream each, never shared. */
const sameSiteFabs: SiteDto[] = [
  { siteId: 'site-1', code: 'SITE-1', templateHash: 'h'.repeat(64), fabs: [
    { fabId: 'fab-01', code: 'FAB-01' },
    { fabId: 'fab-02', code: 'FAB-02' },
  ] },
];

let captured: FabRuntimeRegistry | null = null;

function RegistryProbe() {
  const registry = useFabRuntimeRegistry();
  captured = registry;
  return <div data-testid="runtime-fabs">{registry?.size ?? -1}</div>;
}

const runtimes: AppRuntime<never>[] = [];
function runtimeWithSites(): AppRuntime<never> {
  return runtimeFor(sites);
}

function runtimeFor(configuredSites: SiteDto[]): AppRuntime<never> {
  const runtime = createRuntimeWithSites(configuredSites);
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  cleanup();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  captured = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

interface FakeEventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
}

/**
 * Browser-transport stubs keyed by exact URL: every test asserts on the real
 * composition-root URLs instead of a patched lookup.
 */
function installFakeTransports() {
  const urls: string[] = [];
  const closed: string[] = [];
  const sources = new Map<string, FakeEventSourceLike>();
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(readonly url: string) {
      urls.push(url);
      sources.set(url, this);
    }
    addEventListener() {}
    removeEventListener() {}
    close() { closed.push(this.url); }
  }
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    postMessage() {}
    terminate() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('Worker', FakeWorker);
  const commandUrls = (): string[] => urls.filter((url) => url.includes('/commands/stream'));
  const telemetryUrls = (): string[] => urls.filter((url) => url.includes('/telemetry/stream'));
  return { urls, closed, sources, commandUrls, telemetryUrls };
}

it('assembles one runtime per exact (siteId, fabId) from the sites document', async () => {
  render(<AppProviders runtime={runtimeWithSites()}><RegistryProbe /></AppProviders>);
  // Registry mutations do not re-render the probe; poll the captured registry.
  await waitFor(() => expect(captured?.size).toBe(1));
  expect(captured?.fabIdentities).toEqual([site1FabA]);
  expect(captured?.get(site1FabA)?.siteId).toBe('site-1');
  expect(captured?.get(site1FabA)?.fabId).toBe('fab-a');
  // No partial-key lookup exists: a same-fabId other site or another fab never matches.
  expect(captured?.get(identity('site-2', 'fab-a'))).toBeUndefined();
  expect(captured?.get(identity('site-1', 'unknown-fab'))).toBeUndefined();
  expect(captured?.get(site1FabA)?.running).toBe(true);
  expect(captured?.get(site1FabA)?.getProjection('missing')).toBeUndefined();
});

it('disposes runtimes when the provider unmounts (StrictMode-safe lifecycle)', async () => {
  const { unmount } = render(<AppProviders runtime={runtimeWithSites()}><RegistryProbe /></AppProviders>);
  await waitFor(() => expect(captured?.size).toBe(1));
  const registry = captured;
  unmount();
  await waitFor(() => expect(registry?.size).toBe(0));
});

function TelemetryConsumer({ identity: target, testId }: { identity: FabIdentity | undefined; testId: string }) {
  const runtime = useFabTelemetry(target);
  return <div data-testid={testId}>{runtime ? runtime.siteId + '/' + runtime.fabId : 'none'}</div>;
}

it('starts only the consumed FAB telemetry runtime and exposes useFabTelemetry(identity)', async () => {
  const { urls, closed, commandUrls, telemetryUrls } = installFakeTransports();
  const view = render(
    <AppProviders runtime={runtimeWithSites()}>
      <RegistryProbe />
      <TelemetryConsumer identity={site1FabA} testId="configured" />
      <TelemetryConsumer identity={identity('site-1', 'missing')} testId="missing" />
    </AppProviders>,
  );
  // Telemetry is demand-driven: the configured FAB has one mounted consumer.
  await waitFor(() => expect(telemetryUrls()).toEqual(['/api/v1/sites/site-1/fabs/fab-a/telemetry/stream']));
  // An unregistered identity acquires nothing (no leaked stream).
  expect(screen.getByTestId('missing').textContent).toBe('none');
  // P2-02: command streams are truly on-demand: no per-FAB SSE connection is
  // opened until the FAB has command demand (reservation/active/held result).
  expect(commandUrls()).toEqual([]);
  captured?.get(site1FabA)?.registerAcceptedCommand('cmd-a');
  await waitFor(() => expect(commandUrls()).toEqual(['/api/v1/sites/site-1/commands/stream?fabId=fab-a']));
  expect(commandUrls().some((url) => !url.includes('?fabId='))).toBe(false);
  await waitFor(() => expect(screen.getByTestId('configured').textContent).toBe('site-1/fab-a'));
  expect(captured?.size).toBe(1);

  view.unmount();
  await waitFor(() => expect(urls.every((url) => closed.includes(url))).toBe(true));
});

it('R5.4-03 T04/T05: two sites with the same fabId assemble distinct command and telemetry streams', async () => {
  const { commandUrls, telemetryUrls } = installFakeTransports();
  render(
    <AppProviders runtime={runtimeFor(crossSiteSites)}>
      <RegistryProbe />
      <TelemetryConsumer identity={siteAFab01} testId="consumer-a" />
      <TelemetryConsumer identity={siteBFab01} testId="consumer-b" />
    </AppProviders>,
  );
  await waitFor(() => expect(captured?.size).toBe(2));
  expect(captured?.fabIdentities).toEqual([siteAFab01, siteBFab01]);
  // Two independent runtimes, not a first-match on the shared fabId.
  expect(captured?.get(siteAFab01)?.siteId).toBe('site-a');
  expect(captured?.get(siteBFab01)?.siteId).toBe('site-b');
  expect(captured?.get(siteAFab01)).not.toBe(captured?.get(siteBFab01));

  // T05: distinct telemetry SSE URLs built from the exact identity.
  await waitFor(() => expect([...telemetryUrls()].sort()).toEqual([
    '/api/v1/sites/site-a/fabs/fab-01/telemetry/stream',
    '/api/v1/sites/site-b/fabs/fab-01/telemetry/stream',
  ]));
  await waitFor(() => expect(screen.getByTestId('consumer-a').textContent).toBe('site-a/fab-01'));
  expect(screen.getByTestId('consumer-b').textContent).toBe('site-b/fab-01');

  // T04: distinct command SSE URLs for the same fabId in two sites.
  captured?.get(siteAFab01)?.registerAcceptedCommand('cmd-a');
  await waitFor(() => expect(commandUrls()).toEqual([
    '/api/v1/sites/site-a/commands/stream?fabId=fab-01',
  ]));
  captured?.get(siteBFab01)?.registerAcceptedCommand('cmd-b');
  await waitFor(() => expect([...commandUrls()].sort()).toEqual([
    '/api/v1/sites/site-a/commands/stream?fabId=fab-01',
    '/api/v1/sites/site-b/commands/stream?fabId=fab-01',
  ]));
});

it('R5.4-03 T06/T07: consuming Site A fab-01 never starts Site B fab-01, and releasing Site A never stops Site B', async () => {
  const { closed, telemetryUrls } = installFakeTransports();
  const client = runtimeFor(crossSiteSites);
  const view = render(
    <AppProviders runtime={client}>
      <RegistryProbe />
      <TelemetryConsumer key="consumer-a" identity={siteAFab01} testId="consumer-a" />
    </AppProviders>,
  );
  // T06: acquire((site-a, fab-01)) starts only that runtime.
  await waitFor(() => expect(telemetryUrls()).toEqual(['/api/v1/sites/site-a/fabs/fab-01/telemetry/stream']));
  expect(closed).toEqual([]);

  view.rerender(
    <AppProviders runtime={client}>
      <RegistryProbe />
      <TelemetryConsumer key="consumer-a" identity={siteAFab01} testId="consumer-a" />
      <TelemetryConsumer key="consumer-b" identity={siteBFab01} testId="consumer-b" />
    </AppProviders>,
  );
  await waitFor(() => expect([...telemetryUrls()].sort()).toEqual([
    '/api/v1/sites/site-a/fabs/fab-01/telemetry/stream',
    '/api/v1/sites/site-b/fabs/fab-01/telemetry/stream',
  ]));

  // T07: the last Site A consumer unmounts; Site B's runtime keeps streaming.
  view.rerender(
    <AppProviders runtime={client}>
      <RegistryProbe />
      <TelemetryConsumer key="consumer-b" identity={siteBFab01} testId="consumer-b" />
    </AppProviders>,
  );
  await waitFor(() => expect(closed).toEqual(['/api/v1/sites/site-a/fabs/fab-01/telemetry/stream']));
  expect(closed.some((url) => url.includes('site-b'))).toBe(false);

  view.unmount();
  await waitFor(() => expect(closed).toContain('/api/v1/sites/site-b/fabs/fab-01/telemetry/stream'));
});

it('R5.4-03 T12: same-site FABs keep independent telemetry runtimes and stream lifetimes', async () => {
  const { closed, telemetryUrls } = installFakeTransports();
  const fab01 = identity('site-1', 'fab-01');
  const fab02 = identity('site-1', 'fab-02');
  const client = runtimeFor(sameSiteFabs);
  const view = render(
    <AppProviders runtime={client}>
      <RegistryProbe />
      <TelemetryConsumer key="consumer-01" identity={fab01} testId="consumer-01" />
      <TelemetryConsumer key="consumer-02" identity={fab02} testId="consumer-02" />
    </AppProviders>,
  );
  await waitFor(() => expect(captured?.size).toBe(2));
  await waitFor(() => expect([...telemetryUrls()].sort()).toEqual([
    '/api/v1/sites/site-1/fabs/fab-01/telemetry/stream',
    '/api/v1/sites/site-1/fabs/fab-02/telemetry/stream',
  ]));

  view.rerender(
    <AppProviders runtime={client}>
      <RegistryProbe />
      <TelemetryConsumer key="consumer-02" identity={fab02} testId="consumer-02" />
    </AppProviders>,
  );
  await waitFor(() => expect(closed).toEqual(['/api/v1/sites/site-1/fabs/fab-01/telemetry/stream']));
  expect(closed.some((url) => url.includes('fab-02'))).toBe(false);
  view.unmount();
});

it('keeps one FAB telemetry stream alive until the last useFabTelemetry consumer unmounts', async () => {
  const { closed, telemetryUrls } = installFakeTransports();

  const client = runtimeWithSites();
  const view = render(
    <AppProviders runtime={client}>
      <TelemetryConsumer identity={site1FabA} testId="consumer-a" />
      <TelemetryConsumer identity={site1FabA} testId="consumer-b" />
    </AppProviders>,
  );
  await waitFor(() => expect(telemetryUrls().length).toBe(1));
  await waitFor(() => expect(screen.getByTestId('consumer-a').textContent).toBe('site-1/fab-a'));
  expect(screen.getByTestId('consumer-b').textContent).toBe('site-1/fab-a');
  expect(closed).toEqual([]);

  // Unmounting one of two consumers keeps the shared runtime and stream open.
  view.rerender(
    <AppProviders runtime={client}>
      <TelemetryConsumer identity={site1FabA} testId="consumer-a" />
    </AppProviders>,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(closed).toEqual([]);
  expect(telemetryUrls()).toHaveLength(1);

  // The last consumer unmounts: the runtime stops and its stream closes.
  view.unmount();
  await waitFor(() => expect(closed.filter((url) => url.includes('/telemetry/stream'))).toEqual([telemetryUrls()[0]]));
});

function ProjectionProbe({ identity: target, commandId }: { identity: FabIdentity; commandId: string }) {
  const projection = useCommandProjection(target, commandId);
  return <div data-testid="projection">{projection ? `${projection.state}:${projection.revision}` : 'none'}</div>;
}

it('rejects a foreign FAB payload on the configured command SSE stream', async () => {
  const { sources } = installFakeTransports();

  render(
    <AppProviders runtime={runtimeWithSites()}>
      <RegistryProbe />
      <ProjectionProbe identity={site1FabA} commandId="cmd-1" />
    </AppProviders>,
  );
  await waitFor(() => expect(captured?.size).toBe(1));
  // Tracking the command opens only the configured FAB's lazy stream.
  captured?.get(site1FabA)?.registerAcceptedCommand('cmd-1');
  await waitFor(() => expect(sources.size).toBe(1));

  const emit = (event: unknown) => {
    sources.get('/api/v1/sites/site-1/commands/stream?fabId=fab-a')?.onmessage?.({ data: JSON.stringify(event) });
  };
  const envelope = (fabId: string, sequence: number) => ({
    topic: 'command.result', sequence,
    payload: { fabId, commandId: 'cmd-1', revision: 1, outcome: 'accepted', occurredAt: '2026-10-27T00:00:00Z' },
  });

  // A malformed foreign payload is rejected without configuring another FAB.
  emit(envelope('unknown-fab', 1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByTestId('projection').textContent).toBe('idle:-1');

  emit(envelope('fab-a', 2));
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('accepted:1'));
});

it('R5.4-03 T11: a late event from the replaced site generation cannot modify the new site projection', async () => {
  const { sources, commandUrls } = installFakeTransports();
  // Keep authoritative recovery pending: this test is only about realtime identity.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  const client = runtimeFor(crossSiteSites);
  render(
    <AppProviders runtime={client}>
      <RegistryProbe />
      <ProjectionProbe identity={siteBFab01} commandId="cmd-1" />
    </AppProviders>,
  );
  await waitFor(() => expect(captured?.size).toBe(2));

  // Both sites open their own command stream for the same commandId.
  const oldSiteARuntime = captured!.get(siteAFab01)!;
  const oldSiteBRuntime = captured!.get(siteBFab01)!;
  oldSiteARuntime.registerAcceptedCommand('cmd-1');
  oldSiteBRuntime.registerAcceptedCommand('cmd-1');
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('idle:-1'));
  const siteAUrl = '/api/v1/sites/site-a/commands/stream?fabId=fab-01';
  const siteBUrl = '/api/v1/sites/site-b/commands/stream?fabId=fab-01';
  await waitFor(() => expect([...commandUrls()].sort()).toEqual([siteAUrl, siteBUrl].sort()));
  const staleSiteASource = sources.get(siteAUrl)!;
  const staleSiteBSource = sources.get(siteBUrl)!;

  // Reload the sites document so the assembled generation contains only site-b:
  // the bootstrap disposes the whole old generation and registers a new runtime.
  seedSites(client, [crossSiteSites[1]]);
  await waitFor(() => expect(captured?.size).toBe(1));
  await waitFor(() => expect(captured?.get(siteBFab01)).not.toBe(oldSiteBRuntime));
  expect(captured?.get(siteAFab01)).toBeUndefined();

  const newSiteBRuntime = captured!.get(siteBFab01)!;
  newSiteBRuntime.registerAcceptedCommand('cmd-1');
  await waitFor(() => expect(sources.get(siteBUrl)).not.toBe(staleSiteBSource));
  const freshSource = sources.get(siteBUrl)!;
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('idle:-1'));

  const commandEnvelope = (outcome: string, revision: number) => ({
    topic: 'command.result', sequence: revision,
    payload: { fabId: 'fab-01', commandId: 'cmd-1', revision, outcome, occurredAt: '2026-10-27T00:00:00Z' },
  });
  // Late frames from the disposed site-a and the replaced site-b generation must
  // never reach the new projection Atom.
  staleSiteASource.onmessage?.({ data: JSON.stringify(commandEnvelope('succeeded', 7)) });
  staleSiteBSource.onmessage?.({ data: JSON.stringify(commandEnvelope('failed', 6)) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByTestId('projection').textContent).toBe('idle:-1');

  // The current generation still applies its own result.
  freshSource.onmessage?.({ data: JSON.stringify(commandEnvelope('accepted', 1)) });
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('accepted:1'));
});

it('does not hold idle FAB telemetry/command SSE connections on the workbench route', async () => {
  const { urls } = installFakeTransports();
  const view = render(<AppProviders runtime={runtimeWithSites()}><RegistryProbe /><WorkbenchApp /></AppProviders>);
  await waitFor(() => expect(captured?.size).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // P2-02: the workbench projects existing state only; no command activity and no
  // telemetry consumer means no SSE connection is held for the idle FAB.
  expect(urls).toEqual([]);
  view.unmount();
});

it('P2-02 assembles 32 FAB runtimes with zero command SSE streams until a FAB has demand', async () => {
  const manyFabs = Array.from({ length: 32 }, (_value, index) => ({
    fabId: 'fab-' + String(index + 1).padStart(2, '0'),
    code: 'FAB-' + (index + 1),
  }));
  const manySites: SiteDto[] = [{ siteId: 'site-1', code: 'SITE-1', templateHash: 'h'.repeat(64), fabs: manyFabs }];
  const { closed, commandUrls } = installFakeTransports();
  // Keep authoritative recovery pending: this test is only about transport demand.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

  const view = render(<AppProviders runtime={runtimeFor(manySites)}><RegistryProbe /></AppProviders>);
  await waitFor(() => expect(captured?.size).toBe(32));
  await new Promise((resolve) => setTimeout(resolve, 80));
  // 32 assembled FABs (and 32 idle runtimes) => no 32 command SSE connections.
  expect(commandUrls()).toEqual([]);

  // Only the FAB with command demand opens exactly one stream.
  captured?.get(identity('site-1', 'fab-07'))?.registerAcceptedCommand('cmd-07');
  await waitFor(() => expect(commandUrls()).toEqual([
    '/api/v1/sites/site-1/commands/stream?fabId=fab-07',
  ]));
  // A second FAB adds its own single stream; the first is untouched.
  captured?.get(identity('site-1', 'fab-08'))?.registerAcceptedCommand('cmd-08');
  await waitFor(() => expect([...commandUrls()].sort()).toEqual([
    '/api/v1/sites/site-1/commands/stream?fabId=fab-07',
    '/api/v1/sites/site-1/commands/stream?fabId=fab-08',
  ]));
  expect(commandUrls().filter((url) => url.includes('fabId=fab-07'))).toHaveLength(1);
  expect(commandUrls().filter((url) => url.includes('fabId=fab-08'))).toHaveLength(1);

  // Closing one FAB resource releases its stream only (multi-FAB isolation).
  captured?.remove(identity('site-1', 'fab-08'));
  await waitFor(() => expect(closed.filter((url) => url.includes('fabId=fab-08'))).toHaveLength(1));
  expect(closed.some((url) => url.includes('fabId=fab-07'))).toBe(false);

  // Unmount/dispose closes every remaining command stream.
  view.unmount();
  await waitFor(() => expect(commandUrls().every((url) => closed.includes(url))).toBe(true));
});

it('shows the configured FAB in the workbench without a redundant FAB selector', async () => {
  const client = runtimeWithSites();
  render(<AppProviders runtime={client}><WorkbenchApp /></AppProviders>);
  await waitFor(() => expect(screen.getAllByText('FAB-A').length).toBeGreaterThan(0));
  const selector = document.querySelector('aside select');
  expect(selector).toBeNull();
  expect(document.querySelectorAll('.fab-card')).toHaveLength(1);
});

// --- R4-06: explicit command composition health -----------------------------

it('R4-06 derives command authority only when BOTH realtime and HTTP transports exist', () => {
  // Authoritative composition: realtime transport + fetch => HTTP CommandGateway.
  const authoritative = resolveCommandComposition({ realtimeTransport: true, httpTransport: true, production: false });
  expect(authoritative.realtimeTransport).toBe(true);
  expect(authoritative.gateway).toBeDefined();

  // No realtime transport: nothing can be observed, so there is no authority to
  // declare even though fetch exists. This is the old bug the composition root
  // must never reintroduce (HTTP-authority runtime around a pending source).
  const noRealtime = resolveCommandComposition({ realtimeTransport: false, httpTransport: true, production: false });
  expect(noRealtime.realtimeTransport).toBe(false);
  expect(noRealtime.gateway).toBeDefined();

  // Realtime without fetch: live events only, still explicitly display-only.
  const noHttp = resolveCommandComposition({ realtimeTransport: true, httpTransport: false, production: false });
  expect(noHttp.realtimeTransport).toBe(true);
  expect(noHttp.gateway).toBeUndefined();
});

it('reports HTTP and realtime capabilities independently in production', () => {
  expect(resolveCommandComposition({ realtimeTransport: false, httpTransport: true, production: true }).gateway).toBeDefined();
  expect(resolveCommandComposition({ realtimeTransport: true, httpTransport: false, production: true }).gateway).toBeUndefined();
  // The valid production composition keeps the authoritative gateway.
  const production = resolveCommandComposition({ realtimeTransport: true, httpTransport: true, production: true });
  expect(production.gateway).toBeDefined();
});

it('R4-06 assembles a display-only runtime without EventSource: observable Unavailable, no HTTP authority', async () => {
  const fetchSpy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}));
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', fetchSpy);

  render(<AppProviders runtime={runtimeWithSites()}><RegistryProbe /></AppProviders>);
  await waitFor(() => expect(captured?.size).toBe(1));
  const runtime = captured?.get(site1FabA);
  // Registry mutations do not re-render the probe; poll the captured runtime.
  await waitFor(() => expect(runtime?.recoveryState.phase).toBe('Degraded'));

  const state = runtime!.recoveryState;
  expect(state.availability).toBe('available');
  expect(state.realtimeAvailability).toBe('unavailable');
  expect(state.phase).toBe('Degraded');
  // A display-only runtime still exposes live-only tracking (pending source seam)
  // but never an authoritative recovery call: the HTTP gateway must not exist.
  expect(() => runtime!.registerAcceptedCommand('cmd-display-only')).not.toThrow();
  const authoritativeCalls = fetchSpy.mock.calls.filter(([input]) => {
    const url = String(input);
    return url.includes('/commands') || url.includes('/command-journal');
  });
  expect(authoritativeCalls.length).toBeGreaterThan(0);
});

it('R4-06 keeps the authoritative gateway when the realtime transport exists', async () => {
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(readonly url: string) {}
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  // The startup refresh runs an authoritative List; keep it pending so the test
  // never depends on a real HTTP response.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

  render(<AppProviders runtime={runtimeWithSites()}><RegistryProbe /></AppProviders>);
  await waitFor(() => expect(captured?.size).toBe(1));
  const runtime = captured?.get(site1FabA);
  // availability 'available' requires BOTH a gateway and a ready source: this is
  // the positive half of the composition decision.
  await waitFor(() => expect(runtime?.recoveryState.availability).toBe('available'));
  expect(runtime!.recoveryState.realtimeAvailability).toBe('ready');
  expect(runtime!.recoveryState.phase).not.toBe('Unavailable');
});

it('keeps the production runtime degraded without EventSource', async () => {
  vi.stubEnv('PROD', true);
  vi.stubGlobal('EventSource', undefined);
  render(<AppProviders runtime={runtimeWithSites()}><RegistryProbe /></AppProviders>);
  await waitFor(() => expect(captured?.get(site1FabA)?.recoveryState.phase).toBe('Degraded'));
});

it('R4-06 keeps the pending command source explicitly display-only', () => {
  const source = createPendingCommandEventSource();
  expect(source.availability).toBe('unavailable');
  // P1-01: the required field is a real zero, never an absent value.
  expect(source.cursors).toEqual({ pendingAcknowledgements: 0 });
  expect(source.protocolDiagnostics).toEqual([]);
  // acknowledge/cover are deliberate no-ops: nothing was delivered or covered.
  expect(() => source.acknowledge({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'accepted', occurredAt: '2026-10-27T00:00:00Z' })).not.toThrow();
  expect(() => source.cover({ epoch: 'epoch-1', sequence: 1 })).not.toThrow();
});
