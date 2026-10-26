# Lite migration gap closure

> Execution: continue the existing feature branch in place, as requested. Implement and verify sequentially; do not merge or push.

**Goal:** Repair the failing recovery contract, close reproducible rendering and acceptance gaps, and retain direct PowerShell startup.

**Design:** Continue the approved native-migration guide and current product architecture. Keep Lite pinned to 1.36.0, preserve source data and public APIs. Trace X-Ray shader/compositing differences against frozen Next before changing shadow architecture; record evidence before adding a rendering pass. Keep the user-directed one-minute soak. Golden comparisons must fail on visible residuals rather than choose thresholds to pass today's output.

**References:** `docs/SemiconFab-Next_Babylon-Lite_Native-Migration_Guide_2026-10-26.md`, `docs/migration/babylon-lite/ACCEPTANCE_STATUS.md`.

## Tasks

- [x] Recovery texture ownership: reproduce the existing failing test, clear borrowed material bindings through the public API, verify rebinding and no ownership transfer. Run the frontend suite.
- [ ] X-Ray: compare shader output, render-target encoding, alpha/depth ordering and native-shadow response against the frozen source. Add a failing observable regression for each confirmed bug, fix it, and capture the same frozen views.
- [ ] Acceptance: add meaningful pixel assertions and recovery coverage where missing; execute production product/UI suites, frozen visual comparisons, and the one-minute soak. Exercise an available non-Chromium WebGPU browser if feasible; report actual runtime limitations.
- [ ] PowerShell startup: preserve `scripts/start-dev.ps1` and defaults, fix startup/cleanup issues demonstrated by a real smoke run, verify `/health/ready`, frontend/API proxy and `/twin`, and clean up owned processes.
- [ ] Synchronize status/API mapping and evidence, run repository checks, obtain an independent code review, and address blocking findings.

## Review focus

- A lost device must leave no borrowed old-device texture bound; scene disposal must not destroy generator-owned resources.
- X-Ray changes must preserve six filters, normal-view materials, transparency/depth behavior, and device replacement.
- Rebuilding after a second loss must not leave the product stuck or silently switch recovery strategy.
- Visual comparisons must detect blank canvases, camera/clock misalignment, and errors; capture is not a Golden pass by itself.
- Startup must work from another current directory, keep secrets out of logs, report occupied ports, and stop only processes it owns.

## Ledger

- Baseline `887990b`: clean checkout; tsc/build pass; Vitest 240/241, recovery depth-binding assertion fails both in the full suite and alone. Existing GPU evidence was audited, not rerun.
- Scope steering: preserve direct PowerShell startup; keep prior one-minute soak instruction.
- Recovery RED→GREEN: `lite-effects.test.ts:171` failed in isolation; public `setShaderTexture(..., null)` now clears every borrowed palette binding; frontend 241/241 passed.
- Color GPU RED→GREEN: new `lite-effects-color` fixture and browser suite demonstrate identical surface [20,40,61] becoming [81,110,133] through transmission. Output compensation makes both [20,40,61]. A second source-response RED test rejects the old fitted shadow-contrast factor; restoring the frozen `.35 + .65 * shadow` formula makes both paths [35,70,105], channel error 0, GPU errors 0.
- Connected Chrome works after user connected it. Browser launch through shell was rejected; all browser actions now use the supported CUA CDP capability. Persistent pre-navigation script injection is unavailable, so `tests/frozen-preview.vite.config.ts` supplies the same clock in test-only HTML. Capture helpers are importable and support incremental calls.
- Initial current-browser seven-view capture exposed camera mismatch in later views (e.g. noncanonical L1 pose), so its large X-Ray mean difference 59.815 is INVALID as a material comparison. A separately verified canonical L1 capture after color compensation (before removing the fitted multiplier) measured 25.541 against the previously committed reference; this is exploratory, not a Golden pass. Add camera preconditions before publishing fresh comparisons.
- Latest frontend verification before restoring the original shadow formula: tsc/build PASS; 53 files / 242 tests PASS.
- PowerShell worker completed PS5.1/PS7 key, quoting, process ownership, port checks, isolated artifact outputs and real HTTP/Ctrl+C smoke tests on separate ports. Root review/verification pending.
