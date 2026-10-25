# Wafer renderer and Golden repairs

**Goal:** Wire the frozen Wafer controller into the production scene and repair evidenced Wafer/B1/Dual/X-Ray/HUD differences.
**Reference:** `2026-10-25-remaining-parity-phases.md`, frozen `SemiconFab@b3666132` and `original-tour-wafer-vectors.json`.
**Architecture:** Keep timing in `tour-wafer-timeline.ts`; map full A/B/C routes in `wafer-scenario.ts`. React owns controls and projects controller HUD; the Babylon adapter applies position, tangent rotation, camera and bounded trail. Preserve WebGPU-only and single X-Ray shader.
**Execution:** Continue the user's specified implementation in this checkout. No soak or device-loss matrix. No publish/push requested.

- [x] Add failing full-route projection and replay-completion tests, then implement scenario mapping and controller lifecycle fixes.
- [x] Replace Redux's duplicate Wafer integrator with controller HUD snapshots; wire persistent RAF across pause/speed/follow changes. Match source open/product/replay/close behavior and HUD IDs; remove seek.
- [x] Add production browser acceptance for pause pose, camera offset/free view, trail bounds, product/speed/replay/completion and Tour exclusion; run RED then GREEN.
- [x] Diagnose B1/Dual visibility, floor material and X-Ray/HUD differences against source and captures; fix evidenced causes and add targeted verification.
- [x] Run typecheck, full Vitest, build, architecture/source drift gates and production browser regressions. Re-capture matched Goldens, document scores and remaining deltas without asserting full parity.

Review focus: slow-frame dt clamp; pause retains interpolated pose; product changes during pause; completion after replay; close/reopen and Tour exclusion stop duplicate loops; free camera and locale changes preserve route progress; native shadow restore after level/X-Ray switches.

## Result

187 Vitest and 16 Python tests pass; seven production browser suites pass with no console/runtime
errors. Independent review checked controller/renderer lifecycle; source computed-style measurements
resolved its typography concern (source also has the 12px floor). Reproduced/fixed Tour Escape RAF
resurrection, missing dynamic pause icon and DPR ROI measurement error during verification.
Evidence: `docs/migration/twin-parity/evidence/golden-2026-10-26/README.md`.
Full pixel parity remains open: source material/light response, sidebar and other HUD composition,
X-Ray look and random-state equivalence. No soak/device-loss matrix was run.
