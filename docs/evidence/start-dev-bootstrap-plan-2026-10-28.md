# Development startup bootstrap

> Execute inline with test-driven-development and verification-before-completion.

**Goal:** A fresh clone starts through `scripts/start-dev.ps1` without a separate frontend install command. The script prints a clickable URL; it does not open a browser.

**Architecture:** Preserve the existing API/Vite process ownership and `npm run dev`. Validate the SDK and Node requirements, resolve the pinned pnpm through its JavaScript entry (bootstrapping under `.local/tooling` when necessary), and run an incremental frozen-lockfile install before starting either server.

**Constraints:** Do not change Vite defaults, global tooling, package versions, or lockfiles. Keep `-ApiOnly` independent of Node/pnpm. Preserve occupied listeners and clean up only owned process trees. Do not run the application during this change; use isolated fixtures for script verification.

**Review focus:** Missing dependencies; broken/mismatched global pnpm; production-mode environments omitting Vite; failed installs; API-only startup and process cleanup.

## Task 1: Prerequisites and dependencies

- [x] Add failing executable fixtures to `scripts/test-start-dev.ps1` for Node ranges, pinned pnpm fallback/bootstrap, frozen development-dependency installation and install failures.
- [x] Add the corresponding helpers to `scripts/start-dev-support.ps1` and wire them before the API build/start in `scripts/start-dev.ps1`.
- [x] Check the exact SDK selected by `global.json` from the repository root and provide actionable prerequisite errors.
- [x] Run the complete startup regression script; all cases must pass without launching the application.

## Task 2: Ready URL and documentation

- [x] Require both the web page and authenticated sites/catalog proxy before reporting Web ready; retain the last readiness error for diagnosis.
- [x] Update README startup instructions and the scripts documentation to describe automatic dependency preparation and manual Ctrl+click navigation.
- [x] Run syntax checks, startup regression tests, and the frontend suite. Review the diff and verify ports 5080/5173 remain free.

## Execution decisions

- Work in the supplied checkout so the requested script changes are immediately available; no branch switches were made and the changes were left uncommitted for the caller.
- An incremental frozen install on every invocation delegates stale/missing dependency detection to pnpm, avoiding a custom dependency cache that could miss upgrades.
- Missing Node/.NET receives the exact required version and installation guidance; the script does not install system-wide runtimes.

## Verification record

- RED: the added bootstrap test failed because startup did not validate the Node requirement. GREEN: bootstrap tests and six isolated orchestration cases pass in PowerShell 7 and Windows PowerShell 5.1.
- Real npm bootstrap of pnpm 12.15.0 and real `install --frozen-lockfile --prod=false` succeeded without starting the application.
- Read-only independent review found a PowerShell 5.1 fixture array-shape issue; corrected to match Invoke-RestMethod. No remaining review findings.
- Frontend suite at that point: 663 passed, 1 failed (`workbench-selection.test.ts`, `submits one scenario FAB per site FAB`; an invalid test identity corrected by the single-FAB batch). No frontend source, tests, package manifest or lockfile changes.
- Final syntax/whitespace checks pass; startup regression suites pass in both shells, and ports 5080/5173 are free. Full-flow fixtures use ephemeral ports so verification also works alongside a user's running development server.
- Combined verification (this bootstrap plus the single-FAB scope batch) exposed an environment-restoration defect: `[Environment]::SetEnvironmentVariable` converts a PowerShell `$null` argument to an empty string, so variables absent before startup stayed present and blank. Once `scripts/verify.ps1` ran the startup regression in-process, the blank `Fab__EmbeddedWorker` made 8 API test hosts fail to bind `Fab:EmbeddedWorker`. `Set-FabDevEnvironmentState` now removes absent variables; `test-start-dev.ps1` and `test-start-dev-flow.ps1` assert exact caller-environment restoration (absent stays absent), and `smoke-start-dev.ps1` uses the same helper.
- Final `scripts/verify.ps1` exit 0 (startup regression also rerun in Windows PowerShell 5.1): generated-artifact/contract/frozen-asset/architecture gates, startup regressions, 8 Python tool tests, 4 frozen-asset Node tests, 13 render-perf unit tests, 3 .NET projects built with 180/180 tests, frozen pnpm install, `tsc --noEmit` 0, Vitest 106 files / 664 tests and `vite build` 0; ports 5080/5173 stayed free.
