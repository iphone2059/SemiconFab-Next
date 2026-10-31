# ADR-024 — Twin Research Playback Runtime
**Status:** Merged into main; repository-wide verification pending.
**Date:** 2026-10-31.
## Decision
ResearchReplay continues to parse the 27,263-row JSONL display stream into indexed snapshots; the source is not a checkpoint or authoritative WAL. The runtime has one Effect child Scope, one XState Actor, one immutable replay index per viewer scope and one independently owned 100ms clock. React only installs the controller, subscribes to the bounded projection and submits typed commands. No React effect owns the interval or computes indexed snapshots.
## Ownership
- `TwinResearchRuntime`: event index, monotonic scheduler, playback time, speed, fixed FAB baseline, parsing error and finalizer.
- `twinResearchMachine`: lifecycle states inactive/loading/paused/playing/completed/failed, never per-frame event or equipment arrays.
- `twinResearchAtom`: read-only scoped projection of the clock, HUD metrics and mapped tool states. `twinUiAtom` retains presentation and selected mode, not the research clock.
- `TwinPage`: emits commands and provides the immutable captured replay baseline. Scene frame reads the latest Research projection synchronously from the AtomRegistry; no React ref or timer is in this path.
- `TwinResearchHud`: owns the Research hook and high-frequency HUD subscription; `TwinResearchFooter` owns its own readout. `TwinContent` observes only a stable replay equipment-state array reference. Research time and WIP-only events do not rerender `FabViewport`.
## Contracts
| ID | Invariant |
| --- | --- |
| RPR-01 | At most one registered Research runtime exists per AtomRegistry. |
| RPR-02 | Timer is owned by the child Effect Scope; leaving mode, finishing playback and disposal cancel it. |
| RPR-03 | A generation token rejects callbacks retained after interval cancellation. |
| RPR-04 | XState context never contains timeSec, events, machineStates or a device-state array. |
| RPR-05 | A complete replay advances to the duration exactly and stops the 100ms timer. |
| RPR-06 | Replaying after completion resets time to zero; seeking pauses. |
| RPR-07 | The first accepted stream is immutable for a runtime lifetime, including ResourceManager cache rehydration. |
| RPR-08 | A FAB/viewer scope change invalidates the previous projection before the new scope uses it. |
| RPR-09 | Network failure and JSONL parse failure remain distinct visible errors. |
| RPR-10 | The Research playback baseline is captured upon explicit mode entry; SSE updates cannot rebase it. |
| RPR-11 | When only Research time/WIP changes, the equipment-state projection preserves object identity and cannot invalidate TwinContent. |
| RPR-12 | High-frequency Research HUD and footer subscriptions stay in child components, not TwinContent. |
| RPR-13 | The runtime copies the captured baseline exactly once; no later Atom or SSE update can replace it. |
| RPR-14 | A paused playhead at the duration restarts at zero on Play. |
## Validation
Add deterministic virtual-clock runtime tests, parse-error tests and source ownership tests. The repository-wide `scripts/verify.ps1`, production e2e and compiler ON/OFF equivalence checks remain required before claiming full verification.
