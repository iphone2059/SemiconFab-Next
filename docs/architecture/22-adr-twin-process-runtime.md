# ADR-022: Twin Tour Process Runtime Ownership

**Status:** Accepted; Phase A1 implementation.
**Date:** 2026-10-31.
**Scope:** The cinematic Tour vertical slice. Wafer Playback is implemented separately by ADR-023; Research Replay remains a later migration phase.

## Context

The Twin page previously kept the Tour lifecycle, timeline, generation token, requestAnimationFrame handle, and HUD seed in a React Hook. The Hook had already implemented stop-then-restart, stale-frame rejection, a bounded catch-up loop, and viewer-scope teardown. Those invariants were correct, but the ownership boundary was wrong: a React component owned an application process and its animation resource.

Tour has two distinct kinds of state:

- Discrete process state: active/inactive and current waypoint.
- Continuous frame data: camera pose, countdown progress, and HUD presentation.

They must not share one update channel.

## Decision

### State ownership

1. XState owns the discrete Tour process state and waypoint.
2. TwinTourRuntime owns the XState Actor, TourTimeline instance, generation token, RAF handle, and scheduler.
3. Effect AppRuntime owns the child Scope. The Scope finalizer stops the timeline, invalidates the active generation, cancels the RAF, unsubscribes the Actor observer, and stops the Actor.
4. The pure Domain TourTimeline remains independent of React, Effect, XState, DOM, and browser clocks.
5. twinTourAtom contains only a read-only projection of active/waypoint. TwinTourRuntime is its sole production writer.
6. React owns only the adapter lifetime, HUD ref, initial HUD seed, and command wiring. It does not own the Actor, timeline, RAF, or process state.
7. Rendering is accessed through the narrow SceneCommands camera surface. TwinTourRuntime does not import a React component or a concrete renderer.

### Lifecycle

- One TwinTourRuntime exists per active AtomRegistry/Twin page lifetime.
- The runtime Scope is forked from AppRuntime.rootScope.
- Page unmount closes the child Scope.
- AppRuntime disposal cascades to the child Scope.
- A composite FAB/viewer epoch change stops the current Tour session but does not recreate the Actor.
- Start while running is stop-then-start.
- Stop invalidates the generation before cancellation; callbacks from an old session cannot write or schedule into a new session.
- The runtime schedules at most one RAF at a time.
- A delayed frame advances at most eight virtual 60 Hz steps per callback.
- Time is read from the injected monotonic scheduler; the browser implementation uses performance.now().
- HUD frame updates are pushed through TwinTourHudHandle. They do not update TwinContent or twinTourAtom at frame frequency.

### Process projection

TwinUiState contains neither Tour nor Wafer process lifecycle fields. A waypoint event changes scene presentation (level, view, spatial mode) and closes the Research playback projection; it never writes Tour or Wafer Actor state. XState owns Tour active/waypoint, and twinTourAtom exposes that snapshot to the page.

The runtime's projection subscription is the only production write path to twinTourAtom. The page reads the Atom through useTwinSlices.

### Cross-process exclusion

The current Tour vertical slice preserves existing user-visible exclusion rules through explicit use cases:

- Switching to Engineer or Research stops Tour.
- Entering Wafer Playback stops Tour before opening Wafer.
- Opening onboarding stops Tour.
- Escape stops Tour.
- Manual camera interaction stops Tour.
- FAB/viewer epoch change stops Tour.

No state reducer pretends to stop an Actor. The process owner receives an explicit stop command.

## Invariants

| ID | Invariant |
|---|---|
| TPR-01 | One registered TwinTourRuntime per AtomRegistry |
| TPR-02 | One Actor and one child Scope per runtime |
| TPR-03 | At most one active TourTimeline and one scheduled RAF |
| TPR-04 | Stop invalidates the current session before cancellation |
| TPR-05 | A stale frame cannot update the scene, Atom projection, HUD, or schedule another frame |
| TPR-06 | Scope close stops the Actor and releases the timeline/RAF exactly once |
| TPR-07 | twinTourAtom is a projection, not a second process-state owner |
| TPR-08 | Tour frame data never enters React state or AtomRegistry at 60 Hz |
| TPR-09 | Domain timeline remains pure and deterministic |
| TPR-10 | The Hook contains no RAF scheduler or TourTimeline ownership |

## Deferred work

Phase A2 is implemented by ADR-023: Wafer Playback uses an Effect-scoped runtime and a discrete XState process model. Its per-frame position, rotation, trail, and camera follow remain imperative SceneCommands writes; no frame enters AtomRegistry.

Phase A3 migrates Research Replay parsing and playback clock. The JSONL parser remains a pure Domain parser; Effect owns resource execution and the clock; XState owns only discrete play/pause process state.

A later parent TwinProcessMachine may coordinate cross-process exclusivity once Research Replay has moved to its runtime owner. Until then, the explicit stop use cases listed above are the authoritative coordination boundary. Do not introduce a speculative parent Actor that merely mirrors state still owned by React.

## Acceptance

- Repeated Start does not stack RAF loops.
- Start/Stop/Start rejects a stale callback from the previous generation.
- Viewer epoch changes stop the active session.
- Manual camera input, explicit finish, and page unmount share the same teardown.
- StrictMode setup/cleanup/setup leaves one runtime and one RAF.
- Scheduler replacement disposes the old runtime through the old Scope.
- Architecture gates reject RAF/timeline ownership in the React Hook.
- Full repository verification must pass before merge.
