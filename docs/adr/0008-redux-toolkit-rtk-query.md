# ADR 0008: Redux Toolkit and RTK Query for application state

- Status: Accepted
- Date: 2026-10-25
- Supersedes: the page-local `useReducer`/`useState` state model used by the first Twin implementation

## Context

The first Twin implementation kept its authoritative UI state in `twin-page.tsx`
with `useReducer`, kept demo state in a second reducer, polled/fetched the API
from effects, and duplicated site/status/run data in independent components.
That made ownership clear locally but produced three problems:

1. State could not be inspected or replayed from one place during WebGPU acceptance.
2. Server state had no shared cache, deduplication or tag invalidation.
3. Component-local setters made it easy to add a second source of truth for the
   same domain value (selection, status source, YMS, catalog filters, workbench runs).

## Decision

All serializable application state is owned by Redux Toolkit. Server state is
owned by RTK Query. This includes transient interaction state: viewer readiness,
reload generation, hover, wafer playback progress/trail, import request identity
and submission idempotency. React keeps DOM/WebGPU handles, subscriptions and
derived render caches. ErrorBoundary retains only React's required private
capture latch; its displayed error belongs to Redux.

### Redux slices

| Slice | Owns |
| --- | --- |
| `twinUi` | entry mode, level/view, exclusive spatial mode, cut/xray/explode, Tour, onboarding, wafer/research clocks, status source |
| `twinDemo` | deterministic demo states, original signal keys, reference lamps, 18-row telemetry/history, yield jitter, seed, scenario, cycle |
| `twinPage` | site identity, live equipment states, status feed, selection, layers, MES jobs, YMS/wafer panels, research/Tour/onboarding UI, sidebar filters, inspector MES |
| `workbench` | selected site/run, form, submission error, pending request JSON and retry idempotency key |
| `catalog` | route filters, compare selection, detail/import state, hydration and active import request ID |
| `locale` | shared Catalog/Twin language and theme; no parallel catalog preferences |
| `runtime` | viewer epoch/status/reload/hover/selection synchronization and application fatal error |

### RTK Query endpoints

`twinApi` uses `fetchBaseQuery` against the same-origin API:

| Endpoint | Consumer |
| --- | --- |
| `getSites` | Twin + Workbench |
| `getEquipmentStatus` | Twin initial/polled status; SSE frames still update the ordered consumer |
| `getCatalog` | Catalog page |
| `getRuns`, `getRun`, `getRunResults` | Workbench polling |
| `createRun` | Workbench mutation with idempotency key and `Runs` invalidation |
| `getResearchEvents` | Research replay JSONL, parsed only after cache read |
| `getWaferRoutes` | Wafer Follow routes, parsed by `transformResponse` |

RTK Query supplies request deduplication, polling, error state, cache retention
and tag invalidation. The Twin SSE transport remains a push path: frames are
validated by `createOrderedEquipmentStatusConsumer` and dispatched into
`twinPage`, while the query acts as the initial/fallback transport.

## Render-loop performance rules

1. **Escape hatch:** Babylon objects never enter Redux. The store contains only
   serializable IDs, states, filters and small DTOs; engine/scene/mesh/materials
   live in `useRef` and the `SceneFacade`/backend singletons.
2. **Telemetry batching:** SSE snapshots and AMHS stats are written to a
   non-Redux buffer (`store/telemetry-buffer.ts`) and coalesced to one 100 ms
   dispatch. A 10 Hz source cannot produce 10 Redux renders per second.
3. **Frame-loop read:** `FabViewport` receives a stable `getToolStates` callback
   that calls `store.getState()` inside the Babylon `onBeforeRenderObservable`
   loop. Demo/live transitions therefore reach meshes without a React prop pass;
   research replay falls back to its derived ref while its query snapshot is loading.
4. **Wafer frame state:** progress, point and the bounded trail enter Redux in one
   frame action. The full Twin page excludes this frame object from its shallow
   subscription and separately observes product/index/follow; the scene reads
   the current frame directly. Frame actions are excluded from DevTools and
   serializability traversal; they still carry ordinary serializable DTOs.
5. **Store filtering:** high-frequency actions are denied from DevTools, large
   arrays are skipped by the serializable check, and the immutable check is off
   for the 121-tool scene. DevTools remains available for durable transitions.

## Consequences

- Redux DevTools can capture every durable transition without attaching to Babylon.
- Tests assert the store shape and typed actions directly (`tests/redux-store.test.ts`).
- WebGPU objects remain outside Redux. Viewer lifecycle/hover DTOs are store-owned;
  epoch checks reject callbacks from replaced scenes, and hover is coalesced.
- Catalog hydration reads the Provider's current store during effect execution,
  so StrictMode replay cannot reread a URL already changed by persistence effects.
- Imports and submissions retain request identity in Redux; late results cannot
  restore a cleared import or select a run belonging to a former site.
- `api-client.ts` remains a small standalone transport used by its contract tests;
  application pages no longer construct it.
