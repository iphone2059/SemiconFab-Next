# Audit boundary repairs implementation plan

> **For agentic workers:** Execute inline with superpowers:executing-plans, then request one independent review.

**Goal:** Repair the four residual findings reviewed at `5bc224b`, verify, and push to main as requested.

**Architecture:** Retain the existing Query/Zustand/XState/Lite boundaries. Persist a monotonic equipment-status epoch under the configured data directory; reject protocol downgrades. Notify recovery cancellation at the actual canvas input boundary. Keep one bounded Worker retry and update command terminal indexes only for the affected command.

**Tech Stack:** Windows, .NET 11, TypeScript 7, React 19, Babylon Lite 1.36.0.

**Spec:** User-approved findings R01–R04 in `C:/Users/han_qingyu/Documents/SemiconFab-Next_web_app_TS-TSX_Recheck_2026-10-27.md`.

## Global constraints

- Keep camera sensitivity, simulation timing, identity and render data unchanged.
- Legacy status frames remain accepted only until explicit epoch ordering is established.
- Never retry a stopped Worker runtime or retain stale telemetry over the server projection.
- Push is authorized; use a normal fast-forward merge and push, never force push.

## Review focus

- Persisted epoch allocation must serialize concurrent startups and survive clock rollback.
- Re-entering a FAB must retain the ordering boundary; epoch frames require a sequence.
- Canvas drag, touch, wheel, direct selection and user presets must cancel recovery replay.
- Worker retries must coalesce, back off, preserve sparse frames and cancel on stop/reconnect.
- Per-command reconciliation must keep terminal retention correct without an all-workflow scan.

## Task 1: Equipment generation and ordering

Files: `fab_app/src/EquipmentStatusService.cs`, `fab_app/src/ApiHost.cs`, new epoch allocator, equipment status protocol/tests.

- [x] Add failing frontend same-epoch/downgrade/first-epoch tests and backend persisted restart/concurrent allocation tests.
- [x] Run targeted Vitest and .NET tests; confirm failures.
- [x] Persist a safe-integer counter using an exclusive file lock and atomic flushed replacement; publish it on both REST/SSE DTOs.
- [x] Enforce strict (epoch, sequence) ordering; keep the timestamp heuristic only for wholly legacy feeds.
- [x] Run targeted frontend/backend suites and record results.

## Task 2: Recovery and real input

Files: `web_app/src/lite-backend.ts`, recovery tests, camera/input tests if the boundary changes.

- [x] Add failing DOM input and direct pick tests using the real backend scheduler.
- [x] Notify recovery cancellation from the canvas input and pick boundaries, with mount-owned listener cleanup.
- [x] Distinguish a new preset from the page's idempotent preset reapplication.
- [x] Run backend recovery and input tests, including disposal and repeated loss.

## Task 3: Telemetry fault recovery

Files: `TelemetryRuntime.ts`, telemetry integration and runtime tests.

- [x] Add failing transient/repeated constructor and reset-post failures, sparse pending preservation, retry cancellation tests.
- [x] Schedule one exponential retry (250ms to 8s), cancel on stop; flush the pending frame after success.
- [x] Drop stale Worker projections from renderer reads so server state remains authoritative during failure.
- [x] Run all telemetry/renderer integration tests.

## Task 4: Command registration and reconciliation

Files: `runtime/FabRuntime.ts`, runtime integration tests.

- [x] Add failing operation-count assertions for registration and reconciliation plus terminal-retention checks.
- [x] Carry commandId through assembly/reconcile paths; remove the redundant full terminal scan.
- [x] Run runtime/contract integration tests.

## Completion

- [x] Run frontend typecheck, full Vitest, production build; full .NET and architecture/contract checks.
- [x] Perform independent review and resolve material findings.
- Integration: commit implementation/tests and verification evidence; fast-forward main; push origin/main; report verified remote SHA and clean status in the task result.

## Execution ledger

- Baseline: clean main at `5bc224b`; previous turn freshly verified 86 files / 472 tests, typecheck and build.
- Ruling: implement on a local repair branch in the existing clean checkout; no second dependency installation/worktree is needed for this bounded repair.
- Ruling: the user's direct repair-and-push instruction approves the concrete R01–R04 findings; continue without repeating design or push approval questions.
- Ruling: store this plan under docs/evidence; the repository's architecture gate explicitly forbids the skill's default docs/superpowers legacy path.

- Final verification: frontend 86 files / 492 tests; .NET 177 tests; typecheck/build; architecture/contracts/data checks; Python 8 and render-check 13 tests all pass.
- Independent review: no unresolved Critical/Important findings; targeted live Chrome WebGPU drag/wheel recovery passed twice with zero GPU errors.

