# ADR-023: Twin Wafer Playback Runtime Ownership

**Status:** Accepted; Phase A2 implementation.
**Date:** 2026-10-31.
**Scope:** Wafer-follow playback. Research Replay remains a separate migration phase.

## Context

The previous useWaferPlayback Hook owned a WaferTimeline, timeline refs, a browser RAF callback, and scene writes. Playback active/playing/speed lived in TwinUiState, while product/index/HUD/follow lived in a separate Wafer Atom. The process lifecycle was split between React, two state owners, and an explicit close coordinator.

Wafer playback has two update classes:

- Discrete process state: closed/loading/playing/paused/completed, product, speed, and waypoint index.
- Continuous frame state: position, rotation, trail, camera follow, and the derived frame clock.

Only discrete process state and low-frequency HUD snapshots may enter Atom projections. Continuous frame data remains in the imperative rendering path.

## Decision

### State ownership

1. XState owns the Wafer process state: closed, loading, playing, paused, and completed. Its context contains product, speed, waypoint index, and route readiness.
2. TwinWaferRuntime owns the Actor, WaferTimeline, RAF session, generation identity, scheduler, and scene command writes.
3. Effect AppRuntime owns a child Scope for each runtime. The Scope finalizer closes the session, cancels the outstanding RAF, invalidates its generation, clears scene-owned Wafer geometry, unsubscribes the Actor observer, and stops the Actor.
4. The pure Domain WaferTimeline remains independent of React, Effect, XState, DOM, and browser clocks. Its timing and frozen original route semantics are unchanged.
5. twinWaferAtom is a projection, not a process owner. The Actor subscription is the only production writer for active/playing/speed/product/index/completed. The atom also contains the low-frequency HUD snapshot and the user-controlled follow preference.
6. useWaferPlayback owns only the Resource Atom observer, React adapter lifetime, typed user commands, and follow preference command. It owns no Timeline, RAF, clock, generation token, or scene frame loop.
7. TwinWaferHud subscribes to the Wafer Atom. TwinContent subscribes only to the active selector needed to show/hide the HUD and enable the route resource.

### Frame path

- The runtime schedules at most one RAF while a Wafer session is active, including while paused, preserving the original single-loop behavior.
- Each frame advances WaferTimeline with the injected monotonic scheduler.
- setWaferPoint, setWaferTrail, and setCameraPose are called directly through the narrow SceneCommands port.
- The runtime reads the follow preference from the Wafer Atom at the frame boundary.
- Atom projection writes occur only when an Actor-owned discrete value changes or the HUD snapshot identity changes. Position, rotation, trail points, and camera pose never enter AtomRegistry or React state.
- Completion is detected on the playing-to-stopped edge and confirmed by the Domain timeline completion statistic; a user pause is not interpreted as completion.

### Resource and lifecycle

- Wafer routes continue to load through waferRoutesDefinition and the shared AppRuntime ResourceManager.
- Opening playback sends OPEN. If routes are unavailable the Actor enters loading; ROUTES_READY starts the Timeline and transitions to playing.
- Closing sends CLOSE, cancels the frame loop, closes the Timeline, clears the HUD and scene marker/trail, and leaves product/speed/waypoint progress available for reopening.
- Reopening resumes the retained route position. If the Domain Timeline is already at the terminal waypoint, its original open() semantics replay the route.
- A composite FAB/viewer epoch change closes the old runtime Scope. The session captures its scene port, and the generation guard prevents an old callback from writing into the replacement scene. A replacement runtime retains product/speed preferences and starts a fresh timeline at waypoint zero. The Hook's `initialized` gate is one-shot: runtime replacement must not toggle the page-level gate or unmount `FabViewport`, because its unmount clears the epoch that triggered replacement.
- The first route snapshot is immutable within one runtime lifetime. A later ResourceManager cache rehydration may return a new object identity after idle eviction; the runtime ignores that replacement and retains its existing Timeline and `routesReady` state. A runtime is replaced with its viewer scope rather than silently replacing route data underneath an active timeline.
- Runtime playback commands require an active Actor state (playing, paused, or completed); closed/loading commands fail before changing the Timeline or writing to the scene. During runtime replacement, the page-level initialization gate remains set so FabViewport stays mounted, while Wafer controls are disabled until the replacement runtime is registered.

### Cross-process exclusion

- Starting Wafer stops Tour before opening the Wafer Actor.
- Starting Tour stops Wafer before starting the Tour Actor.
- Mode changes, onboarding activation, Escape, and viewer/FAB scope replacement stop Wafer explicitly.
- Manual camera interaction clears follow mode but does not stop route playback.
- UI reducers do not pretend to stop an Actor. Cross-process lifecycle changes are explicit runtime commands.

## Invariants

| ID | Invariant |
|---|---|
| WPR-01 | One registered TwinWaferRuntime per AtomRegistry |
| WPR-02 | One XState Actor and one Effect child Scope per runtime |
| WPR-03 | At most one active WaferTimeline and one scheduled RAF |
| WPR-04 | Session identity is invalidated before cancellation; stale frames cannot write or reschedule |
| WPR-05 | Wafer position, rotation, trail, and camera frames never enter AtomRegistry or React state |
| WPR-06 | XState owns discrete playback state; twinWaferAtom is its projection |
| WPR-07 | TwinUiState contains no Wafer process fields or Wafer lifecycle events |
| WPR-08 | React Hook contains no RAF, Timeline, frame clock, or session generation |
| WPR-09 | User close and external process stop share the same runtime close path |
| WPR-10 | FAB/viewer epoch replacement closes the old Scope and rejects late callbacks |
| WPR-11 | Starting Tour and starting Wafer explicitly stop the opposite process |
| WPR-12 | Domain Wafer timing, product route, speed, and frozen-vector semantics remain unchanged |
| WPR-13 | ResourceManager idle eviction cannot invalidate the retained route Timeline or its ready projection |
| WPR-14 | Runtime replacement does not toggle the page initialization gate or unmount FabViewport |
| WPR-15 | Playback commands cannot mutate a closed/loading Timeline or write to the scene |
| WPR-16 | Wafer controls remain disabled while the runtime is being replaced |

## Verification

- Runtime tests cover repeated start, close/reopen, 20 Hz direct scene writes with zero Atom notifications, ResourceManager idle eviction and route rehydration, closed-state command rejection, pause/speed/product/locale synchronization, stale callbacks, viewer epoch replacement, registry replacement, external process stop, and unmount.
- Architecture gates reject RAF/Timeline ownership in useWaferPlayback, Wafer fields/events in TwinUiState, and missing runtime/Scope ownership.
- Atom ownership tests freeze the new Wafer projection fields and action namespace.
- Full repository verification (scripts/verify.ps1) remains the merge acceptance command.

## Deferred work

Phase A3 migrates Research Replay parsing and its playback clock. The JSONL parser remains a pure Domain parser; Effect owns resource execution and the clock; XState owns only discrete play/pause process state.

A parent TwinProcessMachine remains deferred until Research Replay has a runtime owner. Until then, explicit runtime stop commands are the coordination boundary; do not add a parent Actor that mirrors state still owned by React.
