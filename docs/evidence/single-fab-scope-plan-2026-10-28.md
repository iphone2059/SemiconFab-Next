# Single-FAB product and test scope

> **历史记录（Round 3 已确认产品决策）：** 当前部署仍默认 1 个 FAB；架构必须支持 1–32 个独立 FAB，且多 FAB 身份/隔离能力保留。本文件保留当时单 FAB 范围的历史证据。

**Requirement:** The current product has one FAB. Keep the architecture extensible to multiple FABs; current automated and manual acceptance uses one active FAB only.

**Approach:** Default the backend catalog to FAB-01; retain the configurable 1..32 range, collection-shaped contracts, composite identities and lifecycle isolation. Replace positive multi-FAB test setups with one active FAB and same-FAB lifecycle/scope cases. Unknown foreign identities and duplicate malformed input remain negative cases, not additional deployed FABs.

## Work

- [x] Backend: expect one stable default FAB, watch the test fail, change the default, convert backend fixtures and run .NET tests.
- [x] Frontend: convert multi-FAB fixtures and registry/runtime/stream tests to single-FAB lifecycle coverage without changing production architecture.
- [x] Workbench: reproduce the single-FAB submission failure, correct invalid test identities against the real request schema, and retain actual HTTP request assertions.
- [x] Documentation: state the current single-FAB scope in active README/runtime/status/architecture guidance; retain historical evidence as history.
- [x] Verify combined frontend/backend suites, typecheck/build, startup regressions and architecture checks. Do not launch the development application or browser.

## Ownership

- Backend worker: `fab_app`, `fab_shared` if necessary, `fab_tests`.
- Frontend worker: `web_app/tests` except Workbench selection.
- Coordinator: Workbench selection, current scope docs and integration verification.

No branch changes, package upgrades, lockfile edits or global tooling changes were made; the completed workspace changes are committed after verification.

## Verification (2026-10-28)

- Backend: `dotnet test fab_tests/fab_tests.csproj -c Release` 180/180. The development catalog seeds exactly FAB-01 with the stable FAB-01 Guid; `Fab:FabCount` stays configurable 1..32 with explicit invalid-count rejection, and foreign/duplicate/cross-site identities remain negative cases.
- Frontend: `tsc --noEmit` 0 and Vitest 106 files / 664 tests. Multi-FAB fixtures were converted to one active FAB plus same-FAB lifecycle/scope cases without production source changes.
- Workbench: submissions assert real site/FAB wire identities and the validated HTTP request body; one FAB renders a single execution card without a redundant FAB selector, and the command console still remounts when the scope site changes.
- Documentation: README, `docs/IMPLEMENTATION-STATUS.md`, `docs/architecture.md`, `docs/fab-runtime.md`, `docs/command-event-bridge.md`, `web_app/README.md` and `fab_tests/README.md` state the current single-FAB scope while retaining multi-FAB architecture guidance; historical multi-FAB evidence stays as history.
- Combined `scripts/verify.ps1` exit 0: generated-artifact/contract/frozen-asset/architecture gates, startup regressions, 8 Python tool tests, 4 frozen-asset Node tests, 13 render-perf unit tests, 3 .NET projects built with 180/180 tests, frozen pnpm install, `tsc --noEmit` 0, Vitest 664 tests and `vite build` 0. No application or browser was launched.