# Round 5.1 — Verification Evidence (bound to commit `96b33d0`)

**Round:** Round 5.1 (command runtime invariant repair).
**Baseline commit:** `9e62c3d8869d9cae1825fb42758bb6ddc4be3e7c`.
**Verified commit (source + tests + docs):** `96b33d0834ec7cafe288b8304e0ed1e3b9c2c4f7`.
**Specification:** [19-round5.1-remediation-specification.md](../architecture/19-round5.1-remediation-specification.md).
**Verified at:** 2026-10-30 (Asia/Singapore); Node `v26.12.1`, pnpm `12.15.0`, .NET SDK `11.0.100-rc.3`, Chrome `155.0.8059.86`.

This file records what was actually executed for this round, the exact outcomes, and the
residual risks. It is an evidence report, not a replacement for the frozen specification.

## 1. Automated gates (Round 5.1 §14 Phase B)

| Gate | Command | Result |
|---|---|---|
| TypeScript typecheck | `pnpm run typecheck` (web_app) | **PASS** — 0 errors |
| Lint (React Compiler rules) | `pnpm run lint` (oxlint src) | **PASS** — 0 warnings / 0 errors (211 files) |
| Contract tests | `vitest run tests/contract/...` | **PASS** — workflow/correlation/recovery suites |
| Integration tests | `vitest run tests/integration/...` | **PASS** — including the two P1-01 final-barrier race tests |
| SSE correctness tests | `vitest run tests/correctness/sse/...` | **PASS** — matrix-1 three-cursor/ack-ledger, matrix-2, matrix-6 |
| Full Vitest suite | `pnpm exec vitest run` | **PASS** — 157 files, **991 tests passed, 0 failed** |
| Vite production build | `pnpm run build` | **PASS** — production bundle emitted |
| Architecture boundary tests | included in the full suite (`tests/architecture/...`) | **PASS** |
| .NET Release build | `dotnet build -c Release` for fab_shared / fab_app / fab_tests | **PASS** — 3/3 projects, 0 warnings, 0 errors |
| .NET full tests | `dotnet test -c Release --no-build` | **PASS** — 226/226 |

The full suite covers the Round 5.1 test matrix from the specification §11, including:
* Recovery final barriers: `does not become healthy when an uncorrelated event arrives during post-snapshot reconciliation`,
  `does not become healthy when cover succeeds but delivered acknowledgements remain`,
  `does not become healthy while a same-revision outcome conflict is unresolved`;
* correlation revision/outcome matrix (duplicate vs conflict vs authoritative correction, including terminal correction);
* recovery-queue conflict records (bounded, excluded from flush, cleared only by authority);
* realtime vs authoritative source isolation and the `expired` matrix;
* cover-never-forges-`delivered` same-epoch and cross-epoch cases;
* full `CommandConnectionStatus` lifecycle (`closed` idle vs `reconnecting` vs permanent `failed`);
* on-demand Command SSE (32 FABs, 0 connections when idle; one per active FAB; re-open after demand returns; multi-FAB isolation; dispose);
* independent workflow/correlation TTLs, including TTL=0 for each side.

## 2. Real production-bundle browser verification

`scripts/e2e-production.ps1 -SkipBuild -Out docs/architecture/evidence/browser/production-e2e.json`
drives fixed Chrome against the real production bundle plus the real .NET API:

* **9/9 scenarios passed, 0 failed**;
* evidence file [production-e2e.json](browser/production-e2e.json) records `commit = 96b33d0...` (the verified Round 5.1
  source commit — no longer the stale `f5dd8a8`), Chrome `155.0.8059.86`;
* the scenarios cover: workbench production shell, catalog filtering, deep-linked language/theme refresh,
  run-form validation + accepted submit, twin WebGPU scene, **live REST+SSE feed**, unknown-FAB fail-closed,
  page exit/re-enter stream hygiene (**no duplicate EventSource**), and the external-Atom projection hook.

## 3. Repository-wide `scripts/verify.ps1` gate (supplemental)

The repository's canonical aggregator was executed twice on the verified commit. Every step passed
(contracts/generated artifacts/architecture/start-dev flow/python unit tests/render-perf checks/migrate,
.NET build+tests, pnpm install/typecheck/oxlint/vitest/build, compiler compatibility, production browser e2e)
**except CORE-011 compiler ON/OFF equivalence**, which failed 2/2 under full-gate load with exactly one
`http-surface` difference:

```
scenario external-atom-hook / step projection-terminal
on : GET /api/v1/commands/<uuid> present   (in addition to the identical other calls)
off: GET /api/v1/commands/<uuid> absent
```

* business/DOM traces were equal; `scenario failures: 0`; no command outcome differed;
* the extra call is an **idempotent authoritative read** (`GET /api/v1/commands/{id}`) produced by an
  authoritative reconciliation pass whose timing relative to the terminal SSE frame depends on bundle/render
  speed (on-demand SSE opening at the first command makes that ordering timing-sensitive);
* CORE-011 standalone (`scripts/compiler-equivalence.ps1`), i.e. the gate on an idle machine, passed **2/2**
  and regenerated [equivalence-trace.json](compiler/equivalence-trace.json) with `equal: true`,
  `commit: 96b33d0`, and 0 differences.

So the equivalence gate itself is load-sensitive for this scenario; the Round 5.1 semantic verdict is
"equivalent" (standalone runs), and the residual risk is the aggregator's strict raw-HTTP-set comparison of
a redundant read.

## 4. Phase C real-runtime coverage — what is browser-verified vs integration-verified

| Spec §14 Phase C item | Where verified |
|---|---|
| 1. SSE `open` within the real bundle; deliberate close on last consumer | production e2e P6/P8 (live REST+SSE, no duplicate EventSource); integration: `realtime-transport.test.ts` lifecycle matrix |
| 2. SSE event before HTTP 202 | integration: `fab-runtime.test.ts` (reservation-before-POST then flush) |
| 3. Unknown event injected during Recovery | integration: `fab-runtime.test.ts` P1-01 barrier tests, `fab-runtime-batch23.test.ts` post-snapshot races |
| 4. Same revision / different outcome | contract + integration: `command-correlation.test.ts`, `command-event-bridge.test.ts`, `command-workflow.test.ts`, `fab-runtime.test.ts` |
| 5. Late SSE after `expired` | contract + integration: `command-workflow.test.ts` §5.5 matrix, bridge routing tests |
| 6. Authoritative List corrects local Actor (incl. terminal) | contract + integration: machine/adapter correction tests, bridge authoritative correction, fab-runtime conflict barrier |
| 7. 32 FABs idle => no 32 command SSE connections | integration: `fab-runtime.test.ts` P2-02 32-FAB matrix; `runtime-bootstrap.test.tsx` 32-FAB composition (real `createSseCommandEventSource` + fake EventSource) |
| 8. Multi-FAB active isolation | integration: same P2-02 matrix (per-FAB single connection, FAB-A close does not affect FAB-B) |
| 9. dispose leaves no connection/Fiber/Timer | integration: teardown tests, P2-02 dispose assertions, P2-03 timer cleanup |
| 10. ACK ledger has no unexplained pending entry | transport correctness suites: ordered ledger, cover/pending-ACK, post-cover barrier tests |

Real-browser injection of reconnect/failed/expired scenarios is not scripted in the existing production e2e
suite; those state-machine transitions are verified by the integration/correctness suites above and by the
transport lifecycle tests. This is the honest coverage boundary of this round.

## 5. Residual risks

1. CORE-011 aggregator flake described in §3 (semantics equal, extra idempotent read under load).
2. `docs/architecture/evidence/final-verify.json` is intentionally left as the Phase F record
   (`af002f4`); R3/R4/R5 did not regenerate it either. Round evidence for this round is this file plus the
   per-gate evidence files above.
3. The XState development build logs "no matching transition" warnings for intentionally ignored
   protocol events (e.g. realtime frames on a terminal/expired actor). Tests pass; production builds are silent.
4. Round 5.1 does not change the backend; the .NET gates above are regression gates only.
