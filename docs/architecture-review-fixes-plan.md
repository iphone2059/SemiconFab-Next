# V2.1 Architecture Review Fixes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. The user has authorized fixing the seven findings from the preceding review.

**Goal:** Fix the seven reproduced regressions without changing the V2.1 architecture or product URLs.

**Architecture:** Keep Router, Query, Zustand, CommandWorkflow and Babylon Lite ownership intact. Prevent effects from writing stale render snapshots; forward current frame callbacks; scope telemetry ordering to each connection; reconcile commands with the authoritative gateway when local recovery is insufficient. Require actual engine readiness and rendered-frame progress in the GPU gate.

**Tech Stack:** Existing React/TypeScript, TanStack Router/Query, Zustand, RxJS, XState v6, Babylon Lite 1.36.0, .NET 11 and Chrome/WebGPU.

**Spec:** The seven actionable findings in the preceding code review, accepted by the user's request to fix them.

## Global Constraints

- Keep canonical product URLs and existing dependency versions.
- Keep high-frequency telemetry outside React state, Query, Zustand and XState.
- Preserve DEMO and research replay source ownership.
- Keep fixes in this checkout on `fix/v21-review-regressions`; leave changes reviewable without committing or publishing.
- Run GPU/browser cases serially.

## Review Focus

- Deep links and back/forward navigation must not overwrite URL input with stale render state.
- A late telemetry callback must become visible without recreating the GPU scene.
- Reconnects must accept the new stream immediately and still reject stale frames within a connection.
- Failed authoritative status requests and disposal during recovery must not produce unhandled rejections or stale notifications.
- A canvas or RAF callback alone must never satisfy the render performance gate.

### Task 1: URL/store synchronization

**Files:** `features/catalog/catalog-page.tsx`, `features/twin/twin-page.tsx`; new integration regression tests under `web_app/tests/integration`.
**Interfaces:** Existing RouterSearch props and store actions remain unchanged.
- [ ] Add tests for initial catalog filters/locale, URL changes, Twin research mode and user changes.
- [ ] Run the tests and observe stale writebacks fail.
- [ ] Guard writeback effects against superseded store snapshots; retain URL hydration and explicit user changes.
- [ ] Run targeted tests. Expected: deep-link input remains intact; user changes still reach the router.

### Task 2: Telemetry rendering and ordering

**Files:** `features/twin/fab-viewer.tsx`, `features/twin/twin-page.tsx`, `realtime/telemetry/TelemetryRuntime.ts`, `realtime/workers/telemetryWorker.logic.ts`; regression tests.
**Interfaces:** Backend telemetry sequences remain connection-local. Worker replies preserve wire sequence; EventSource open resets the connection ordering watermark and worker buffer.
- [ ] Add failing tests for a changed frame callback, DEMO isolation, restarted sequences, stale frames and late worker replies.
- [ ] Forward current callbacks through a ref; merge telemetry only for `sse-live`; retain wire sequence and reset connection state on open.
- [ ] Run targeted tests. Expected: latest callback is consumed; DEMO remains unchanged; first reconnect frame is accepted.

### Task 3: Command recovery

**Files:** `runtime/FabRuntime.ts`, `application/coordination/CommandEventRecovery.ts`, command source contracts/transport if needed; existing contract/integration tests.
**Interfaces:** `trackCommand` remains synchronous; authoritative reconciliation is asynchronous, coalesced and lifecycle-safe.
- [ ] Add failing tests for terminal-result eviction before registration, reconnect recovery, duplicate capacity, request failure and disposal.
- [ ] Reconcile newly tracked commands missing local evidence and active commands after reconnect; preserve correct queue capacity when replacing revisions.
- [ ] Run contract/runtime tests. Expected: evicted terminal result converges; duplicate replacement consumes one slot; failures are contained.

### Task 4: Real rendering gate and acceptance

**Files:** `tools/render_perf.mjs`, gate behavior tests and evidence/documentation.
**Interfaces:** Existing CLI remains usable; request `perf=1` for the product diagnostics bridge and require increasing actual engine frame counts, draw calls, and no GPU errors.
- [ ] Run the blank-canvas negative fixture against the old gate. Expected: it incorrectly exits zero (already reproduced in review).
- [ ] Add gate tests and require actual render progress before/during measurement, reject readiness timeout and GPU failures.
- [ ] Run all frontend tests, typecheck, build, backend tests and architecture checks.
- [ ] Run real Chrome deep-link, source-selection, initial telemetry and reconnect checks serially; run negative and positive GPU gates.
- [ ] Request one fresh read-only review and resolve actionable findings.
