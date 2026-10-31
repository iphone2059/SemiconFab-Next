# ADR-025 — Twin Demo Clock Runtime
**Status:** Implemented; repository-wide validation pending.
**Date:** 2026-10-31.
## Decision
The deterministic 1600ms DEMO clock is owned by a child Effect Scope, not by a React effect timer. React mounts a controller and conveys the current status-source and playing flags; the existing demoReducer remains the only authority for demo telemetry, equipment state, and simulation cycle transitions. XState is not added because DEMO already has a typed, closed set of discrete transitions and a second machine would duplicate authority.
## Contracts
| ID | Requirement |
| --- | --- |
| DCR-01 | Only DEMO + playing can own an active 1600ms timer. |
| DCR-02 | Repeated configuration with the same enabled state never allocates a second timer. |
| DCR-03 | Pausing, switching to SSE or Research, component unmount, and Effect Scope closure clear the active timer. |
| DCR-04 | Generation-guarded callbacks cannot apply ticks after cancellation. |
| DCR-05 | A callback that observes a mode/source or playing change before React commits the new effect terminates rather than applying a tick. |
| DCR-06 | The existing demoReducer and twinDemoAtom remain the only state authority; no duplicate XState context or React clock state exists. |
## Validation
Deterministic virtual scheduler and source ownership tests are included. The Windows repository gate `scripts/verify.ps1`, browser e2e and compiler equivalence checks remain unverified.
