# ADR-026 — Twin Playback Lifecycle Coordination
**Status:** Implemented in A5; local verification pending.
**Date:** 2026-11-02.
## Ownership
Tour, Wafer and Research are mutually exclusive foreground activities. Their runtime implementations and Effect child scopes remain independent. The single `stopOtherTwinPlaybacks(registry, owner)` entry point requests stop/close/exit of all foreground activities except the explicitly selected owner. It is called on Tour start, Wafer start, entry-mode transitions and onboarding. A transition to Engineer or onboarding has no owner and stops all three. A transition to Visitor preserves Tour; a transition to Research preserves Research.
DEMO is a status-source simulation, not a camera or wafer foreground activity. Its independent 1600 ms Effect clock runs only while the selected status source is DEMO and the DEMO state is playing. It may coexist with the Tour visual experience, but cannot tick while Research or SSE owns status.
## Lifetime
- Each runtime has one Effect child Scope of the active application runtime and one registration associated with an AtomRegistry. StrictMode cleanup unregisters and disposes before the next registration.
- Tour stops on viewer/FAB scope change in the layout-effect phase, before scene-frame callbacks can write into the new viewer.
- Wafer closes through the Actor transition before disposal, clearing both its SceneCommands output and its `active/playing` projection. A stale RAF generation cannot write to a replacement scene.
- Research owns its last published projection. Finalization removes it only when it still owns the current Atom value; a previous scope cannot erase a newer scope's projection. Stale interval callbacks are ignored after stop/disposal.
- Stopping a foreground activity is idempotent; registry state is never duplicated as an independent coordinator state machine.
## Invariants
| ID | Invariant |
| --- | --- |
| LPC-01 | At most one of Tour, Wafer and Research may remain active following a coordinated foreground entry. |
| LPC-02 | Tour entry stops Wafer and Research; Wafer entry stops Tour and Research; Research mode entry stops Tour and Wafer. |
| LPC-03 | Engineer mode and onboarding stop all foreground activities. |
| LPC-04 | DEMO is governed only by status-source and DEMO playing, not by foreground activity ownership. |
| LPC-05 | FAB and ViewerEpoch changes prevent late Tour/Wafer frame writes to a replacement viewer and isolate Research scope projections. |
| LPC-06 | StrictMode mount/cleanup/mount preserves single registration and single timer/RAF per active owner. |
| LPC-07 | Scope finalization clears only the retiring runtime's projection, not a newer owner with the same scope identity. |
## Local acceptance
Run `pwsh -NoProfile -File .\scripts\verify.ps1` from the repository root on Windows. The user will perform local testing; this submission is source-reviewed but does not claim a passing typecheck, lint, Vitest, production browser E2E, compiler equivalence or GPU validation.
