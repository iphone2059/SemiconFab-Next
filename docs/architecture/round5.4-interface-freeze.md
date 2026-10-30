# Round 5.4 — frozen interfaces (Lead, before parallel implementation)

Round 5.4 has three obligations, implemented in this order: R5.4-01 terminal-state
protection, R5.4-02 accepted-command handoff, R5.4-03 composite identity. To allow
parallel work, these interfaces are frozen; implementations must match them exactly.
There are no compatibility wrappers, no old-API forwarding functions, no dual-key
maps and no fabId-guess fallbacks.

## 1. Domain identity (web_app/src/domain/fab-identity.ts) — DONE

```ts
export interface FabIdentity { readonly siteId: string; readonly fabId: string; }
export function fabIdentityKey(identity: FabIdentity): string // JSON.stringify([siteId, fabId])
```

Rules: every Map/Set key uses fabIdentityKey(); never `siteId + ':' + fabId`;
never look up a site from a bare fabId.

## 2. FabRuntime / factory (Lead owns these files)

- `FabRuntimeOptions.sourceFor: (identity: FabIdentity, scope: Scope.Scope) => CommandEventSource`.
  FabRuntime calls it with its own `{ siteId, fabId }`. Source URL construction is the
  composition root's job and must use the identity's siteId and fabId.
- `FabRuntimeFactoryOptions.sourceFor` same signature.
- `FabRuntimeFactory.create(identity: FabIdentity): FabRuntime` (replaces create(fabId, siteId)).
- R5.4-01: `FabRuntime.setPhase()` is the ONE transition entry. It preserves terminal
  `Unrecoverable` and no-authority `Unavailable` unconditionally; only non-terminal
  phases may map to `Degraded` when the realtime source is unavailable. No caller-specific
  override, no one-shot rewrite in handleRecoveryFailure.
- `enterDirty(input, trigger)` where `trigger: 'external-dirty' | 'internal' = 'internal'`:
  only an `external-dirty` trigger may re-arm an `Unrecoverable` runtime (attempts=0, new
  bounded episode). Connection-status transitions, transport failures, pending-source finite
  stream exits, component remount/start(), internal defects and timers are `internal` and
  must leave phase/attempts untouched. External dirty inputs: source.dirty stream,
  replay-gap stream, explicit requestAuthoritativeRecovery(). Realtime held/conflict/
  unverified bridge signals keep their existing Round 5.2 re-arm semantics.
- `completeRecoverySuccess()` remains the only Healthy entry; unavailable realtime => Degraded.

## 3. FabRuntimeRegistry (web_app/src/runtime/fab-runtime-registry.ts)

```ts
export type AcceptedCommandRegistration =
  | { readonly kind: 'registered' }
  | { readonly kind: 'recovery-pending' };

register(runtime: FabRuntime): void;                       // key from runtime.siteId/fabId
get(identity: FabIdentity): FabRuntime | undefined;
remove(identity: FabIdentity): FabRuntime | undefined;
registerAcceptedCommand(identity, commandId, reservation): AcceptedCommandRegistration;
requestAuthoritativeRecovery(identity: FabIdentity): void; // missing runtime records pending intent
startAll(): void; stopAll(): void; disposeAll(): void;
get size(): number;
get fabIdentities(): readonly FabIdentity[];
get pendingHandoffCount(): number;                         // read-only evidence
```

Internal state: runtimes keyed by fabIdentityKey; `pendingAcceptedCommands: Map<key,
{ identity, commandIds: Set<string> }>`; `pendingAuthoritativeRecovery: Map<key, FabIdentity>`.
Only identity + commandId are stored (no payload/Workflow/Actor/Reservation/Runtime copy).

Handoff rules:
- A: runtime exists AND owns reservation => commit it (single workflow, no second admission) => registered.
- B: runtime exists, reservation belongs to a replaced runtime => current runtime.registerAcceptedCommand(commandId);
  only after it accepts, release the old reservation if still reserved => registered. If the current runtime
  rejects/throws, keep the commandId in pending, release the reservation, return recovery-pending (never lose a 202).
- C: no runtime => add commandId to pending for identity; release reservation only if still reserved; never commit;
  never create a detached workflow => recovery-pending.
- D: register(runtime) flushes every pending commandId through runtime.registerAcceptedCommand; remove an id only
  after the runtime accepted it; after flush, if pendingAuthoritativeRecovery has the identity call
  runtime.requestAuthoritativeRecovery() once and clear the marker. Coalesced per identity.
- E: disposeAll() disposes runtimes and clears the runtime map but MUST retain pending handoff state; ids are removed
  only after a later generation accepts them. No TTL. The registry object dies with the AppRuntime.
- registerAcceptedCommand validates reservation.siteId/fabId === identity (throw on mismatch).

## 4. Console (web_app/src/workbench)

- `TrackedCommand = { siteId, fabId, commandId, handoff: 'registered' | 'recovery-pending' }`.
- submit(): reserve on runtime from registry.get(identity); after HTTP 202 call
  registerAcceptedCommand(identity, commandId, reservation); BOTH union kinds mean accepted and the
  commandId stays tracked; recovery-pending must not be rendered as rejected/failed and must not clear
  the row. Do not release a committed/released reservation twice.
- `<ProjectionRow identity={identity} commandId=... handoff=...>`; when handoff is recovery-pending and the
  registry has no runtime for the identity, show 等待 Runtime 恢复 (never 命令失败).
- Console keeps no second business-state cache; projections always read the runtime Atom.

## 5. Telemetry (web_app/src/realtime + app providers)

- `TelemetryRuntimeOptions` gains REQUIRED `siteId`; `fabId` required too. Runtime exposes
  getters `siteId: string` and `fabId: string`. Frame wire schema is NOT changed (no siteId in frames);
  isolation comes from the site-scoped URL + per-runtime identity.
- `FabTelemetryRegistry`:
  - internal `runtimes` and `consumers` Maps keyed by fabIdentityKey;
  - `replaceAll(runtimes: readonly TelemetryRuntime[]): void`;
  - `get(identity: FabIdentity | undefined): TelemetryRuntime | undefined`;
  - `acquire(identity: FabIdentity | undefined): () => void` (closure bound to identity + exact runtime instance;
    a late release from an old generation must not stop the replacement runtime);
  - `fabIdentities: readonly FabIdentity[]`.
- `useFabTelemetry(identity: FabIdentity | undefined)` (hook depends on siteId/fabId primitives, not object identity).
- `useCommandProjection(identity: FabIdentity, commandId: string)`.
- Bootstrap: delete siteByFab; iterate `sites -> site.fabs` with the exact {siteId, fabId}; command source URL is
  `/api/v1/sites/{siteId}/commands/stream?fabId={fabId}`; telemetry URL is
  `/api/v1/sites/{siteId}/fabs/{fabId}/telemetry/stream`; factory.create(identity); registry.register(runtime).

## 6. Routes / consumers (web_app/src/routes, twin, workbench, api/sites.resource, tools/*.mjs)

- Canonical route: `/sites/$siteId/fabs/$fabId/3d`; `fab3dPath(siteId, fabId)`; old `/fabs/$fabId/3d`
  is deleted (no alias, no redirect).
- `findSiteByFabId` is DELETED. `sites.resource` exports
  `findSiteFab(sites, identity): { site: SiteDto; fab: FabDto } | undefined` (exact siteId AND fabId).
- `route-data`: `requireFabIdentity(runtime, identity): Promise<{ site, fab }>`; loader validates exact
  membership; unknown combination fails the route (error text keeps "FAB 不存在" for unknown fab).
- `TwinPageProps` and `useTwinRouteState` params gain explicit `siteId`. Resolution: both ids => exact site and
  fab (error if site missing or fab not in site); siteId only => exact site; neither => existing page-store/first-site
  fallback. fabId without siteId must NOT first-match a site.
- Twin page passes the full identity to `useFabTelemetry` and `EquipmentStatusPipeline` (siteId + fabId).
- Workbench 3D link: `fab3dPath(site.siteId, selectedFab.fabId)`.
- E2E/dev script URLs: e2e_production.mjs, e2e_functional.mjs, gpu_gate.mjs, compiler_equivalence.mjs,
  render_perf.mjs, scripts/perf-render.ps1 use `/sites/{siteId}/fabs/{fabId}/3d` (fetch siteId from the
  authenticated sites document; unknown-FAB error scenario keeps a known siteId + unknown fabId).

## 7. Verification commands

From `web_app`:
`node ../.local/tooling/pnpm/12.15.0/node_modules/pnpm/bin/pnpm.mjs exec vitest run <test paths>`
`node ../.local/tooling/pnpm/12.15.0/node_modules/pnpm/bin/pnpm.mjs typecheck`
`node ../.local/tooling/pnpm/12.15.0/node_modules/pnpm/bin/pnpm.mjs exec oxlint src`

Do not commit; the Lead owns commits and the full gate.
