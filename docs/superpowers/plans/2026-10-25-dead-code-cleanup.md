# Frontend dead-code cleanup implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline; one independent final review.

**Goal:** Remove obsolete frontend implementations and unused migration code while testing the active product paths.

**Architecture:** Redux/RTK Query remain the only application state/transport paths. Trace imports from `src/main.tsx`, compare test-only references, and remove confirmed obsolete implementations with their exclusive styles. Keep active original-source recipes and acceptance fixtures.

**Tech Stack:** Existing TypeScript/React/Redux/Babylon; TypeScript unused checks, Vitest, browser acceptance.

**Spec:** User request to inspect and clean old, expired and dead code; ADR 0008 and the Twin parity baseline retain product constraints.

## Global constraints

- Work and push on `main` only per the user's explicit instruction.
- Preserve the read-only original, legacy provenance assets, runtime facilities, source fixtures and acceptance tooling that still have consumers.
- No dependency upgrades, renderer replacement, UI redesign or parity-status promotion.
- Do not delete an implementation solely because its filename includes legacy/original.

## Review focus

- Dynamic renderer imports and test/browser-only acceptance entry points.
- Cancellation, same-origin credentials, idempotency and error handling in the actual RTK transport.
- Styles exclusive to a removed component versus selectors shared by the live HUD.
- Redux action fields and helpers superseded by RTK Query/derived state.
- URL/storage language precedence during helper consolidation.

## Task 1 — active import and API coverage

- [x] Record runtime reachability, direct/test consumers and unused compiler diagnostics.
- [x] Replace obsolete ApiClient tests with current RTK endpoint transport tests; observe assertions before deleting the old client.
- [x] Remove obsolete client/inspector and tests that exercise only removed UI, plus exclusive styles.

## Task 2 — unused migration residue

- [x] Remove confirmed unused imports/bindings/exports/actions; consolidate the tested language resolver into active preference initialization.
- [x] Enable `noUnusedLocals` and `noUnusedParameters`; the initial audit fails with 21 diagnostics, final typecheck must pass.
- [x] Preserve source behavior and run affected tests.

## Task 3 — verification and publication

- [x] Run full frontend tests, build, architecture and source-vector drift checks.
- [x] Recheck workbench/catalog/Twin in browser, request an independent cleanup review, and resolve blockers.
- [x] Record removals and limits; commit/push verified cleanup and confirm only `main` remains. The commit and remote result are recorded in Git history after this verification.
