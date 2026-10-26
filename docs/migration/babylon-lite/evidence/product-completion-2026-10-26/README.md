# Native Lite product completion evidence — 2026-10-26 (final build)

Status: **IMPLEMENTING / NOT_PARITY_VERIFIED**. This package records product-level evidence for the
**/twin** page running the native Babylon Lite 1.36 renderer. The recorded build is the final code
freeze after the P11 cleanup, the device-loss disposal/queue fixes, the GPU-error subscription move,
the frozen-clock visual pass and the PNG-decoder unit tests. Full parity is **not** claimed: see
§8 for open gates and the documented X-Ray visual gap.

Environment: Chrome **155.0.8059.86** and Edge **156.0.4314.42** on Windows, viewport **1536x735
DPR 1**, local API at 127.0.0.1:5080 (Development), Lite production preview at 127.0.0.1:5178,
frozen pre-migration Next reference worktree (commit `0b35ca5`) built and previewed at
127.0.0.1:5179.

## 1. Native product acceptance — PASS (0 console errors, Chrome + Edge)

`web_app/tests/twin-lite.browser.ts` driven by `node tools/run_twin_browser.mjs lite-product`.
Final-build evidence: [acceptance.json](./acceptance.json), [acceptance.png](./acceptance.png);
Edge run: [acceptance-edge.json](./acceptance-edge.json), [acceptance-edge.png](./acceptance-edge.png).

| Area | Assertion |
|---|---|
| First frame | status reaches `WebGPU · 程序化 FAB · 121 台设备`; runner viewport 1536x735; 0 console errors |
| Picking | projected tool caught by native GPU pick; hover card, inspector, selection wireframe box visible; ESC clears |
| Focus | double-click focuses the selected tool (camera target = selection visual centre, reflected Z once) |
| Camera | ISO `[38,48,58]`, Top `[0,95,0.1]`, Litho `[-21,3.6,-12.5]`, Airlock `[-12.5,4.2,7.5]` presets exact; orbit drag changes pose; wheel zoom is page-owned; live resize to 1280x640 |
| Levels | L1 floor alpha 1 / B1 0.2 / DUAL 0.35 / EXPLODED 0.55, slab+ceiling+subfab visibility, ceiling lift >15 m, subfab drop <-13 m, offsets reset |
| Layers | roof (>0 native exhaust particle sprites; source data has 70), ceiling, subfab/piping, heatmap texture updates, airflow clock advances, AMHS layer hide/show |
| Tool states | inspector MAINT reaches the native frame loop within the up-to-5 s frame-sync poll window; 121 states after each recovery |
| X-Ray | all/vac filters, hologram materials active, subfab forced visible, restore removes all `fab-xray-*` materials and returns L1 |
| Section cut | Z +12 => `[0,0,-1,-12]`; invert => `[0,0,1,12]`; exclusive spatial mode clears cut for X-Ray; cut off => null |
| Wafer | marker visible/moving, additive trail draws (>0 indices), follow camera targets the marker, close hides marker/trail |
| Tour / patrol | tour card animates the camera and closes; patrol focus targets the walking engineer |
| Language | zh <-> en product toggle keeps the scene ready |
| Device loss x3 | cut / X-Ray / no-spatial-mode rounds; after each of three real WebGPU device losses: 0 GPU validation errors, all 121 tool states present, camera pose preserved, cut plane or X-Ray materials restored, roof layer restored, and in the no-mode round the canvas selection index + wireframe are restored; Redux tool-state sync resumes. A loss during the replacement build queues another rebuild instead of silently falling back to in-place native recovery. |

Product device-loss strategy (documented integration decision): the native scene is **rebuilt on the
replacement device** and the user camera pose/selection are restored; Lite in-place scene recovery is
still exercised by the bounded `lite-*` fixtures. X-Ray palette CSM depth sampling and section-cut on
Standard materials are deliberate, documented exclusions (see [FEATURE_GAPS.md](../FEATURE_GAPS.md)).

## 2. Legacy product UI regression — PASS (Chrome 155 + Edge 156)

`web_app/tests/twin.browser.ts` runs unchanged against the Lite /twin page: controls, exclusive
spatial modes, ESC behavior, English-only sweep, font floor, modals, wafer panel, tour card,
singleton page. Evidence: [ui.json](./ui.json), [ui-edge.json](./ui-edge.json), screenshots alongside.

## 3. Frozen-clock visual A/B against the frozen pre-migration Next renderer

Method: both pages are captured under the frozen clock from the reference golden harness
(`GOLDEN_CLOCK`: fixed 16.667 ms virtual frames, seeded `Math.random`, fixed `Date.now`), injected
via CDP `Page.addScriptToEvaluateOnNewDocument` before load and advanced only by
`__twinGoldenClock.step(n)` to the same virtual frame counts on both sides: 180 settle frames after
`WebGPU ·`, then ISO, Top, B1, Dual, L1→Exploded, Cut, X-Ray views with 120–700 frames each for
camera/level/explosion easing. Same Chrome/profile, viewport 1536x735 DPR 1, HUD visible outside the
ROI, ROI `[400,120,1500,680]`, Pillow absolute RGB difference, no colour correction. Raw:
[frozen-clock-diff.json](./frozen-clock-diff.json),
[frozen-clock-manifest.json](./frozen-clock-manifest.json), screenshots `ref-*.png` / `lite-*.png`.

| View | mean abs channel diff | pixels changed >24 |
|---|---|---|
| ISO | 9.834 | 15.0% |
| TOP | 13.406 | 20.3% |
| B1 | 17.668 | 29.0% |
| DUAL | 19.834 | 37.1% |
| EXPLODED | 8.191 | 10.9% |
| CUT (X axis) | 5.111 | 7.9% |
| X-RAY (all) | 43.860 | 56.3% |

Free-running earlier captures (no frozen clock) are superseded: ISO 10.301 / TOP 13.721 / B1 17.666 /
DUAL 20.480 / EXPLODED 14.593. Freezing removed the dynamic-phase noise (notably EXPLODED
14.593 → 8.191) and exposed the real remaining gaps. **X-Ray is a known visual gap**: the product
palette does not sample the CSM depth texture (WebGPU usage conflict in refit frames) and the frozen
frame is much lighter than the reference hologram; it is recorded as a limitation, not a pass.

This is a **frozen-clock comparison, not a Golden PASS**: the migration guide does not define a
whole-product golden threshold and the X-Ray gap is visible. Whole-product Golden remains NOT_RUN.

## 4. Performance A/B on production preview builds

Both sites built with `vite build` and served with `vite preview` (Lite 5178, frozen reference 5179).
Method: 5 s warmup, 8 s idle + 6 s orbit sampling of rAF deltas, same Chrome/viewport/query. Raw:
[perf-ab.json](./perf-ab.json).

| Renderer | idle fps | orbit fps |
|---|---|---|
| Native Lite (production) | 57.2 | 52.2 |
| Frozen Next 0b35ca5 (production) | 16.1 | 15.5 |

Both runs 0 console errors. Raw JS payload: Lite `gpu` chunk 396,492 B (Lite engine only;
`lite-backend` 2,359,121 B includes the 2.28 MB frozen static-structure data) vs frozen old renderer
`gpu` chunk 2,528,822 B (old core). No old-engine symbols in the Lite dist; gzip sizes are not
asserted here.

## 5. Soak (user-directed 1-minute run; 60-minute NOT_RUN)

The session owner explicitly replaced the planned 60-minute soak with a 1-minute soak. Final-build
result: 3,379 frames, mean frame 17.75 ms (**56.3 fps**), p95 33.4 ms, p99 33.5 ms, **0 long tasks**,
heap 29.6 MB, 0 GPU validation errors, 0 console errors, status stable at
`WebGPU · 程序化 FAB · 121 台设备`. Raw: [soak.json](./soak.json).
A 60-minute soak remains **NOT_RUN** by instruction; it is not reported as passed.

## 6. Browser matrix

| Browser | Product acceptance | UI regression | Result |
|---|---|---|---|
| Chrome 155.0.8059.86 | PASS (0 errors) | PASS (0 errors) | real WebGPU |
| Edge 156.0.4314.42 (Chromium) | PASS (0 errors) | PASS (0 errors) | real WebGPU |

No Firefox/Safari (or other non-Chromium WebGPU) browser is installed on this machine and none was
downloaded; non-Chromium coverage is **NOT_RUN**.

## 7. P11 dependency cleanup (old Babylon removed)

- 17 obsolete legacy renderer sources deleted after import-graph verification (old
  `babylon-webgpu`/`legacy-site` backend, procedural/original builders, native static shadows,
  aerodynamics, xray-hologram, babylon-lifecycle).
- Legacy internal-scene acceptance/unit modules and capture helpers deleted or rewritten; the
  retained suite is **52 Vitest files / 241 tests** plus the CDP product suites above.
  `lite-facility.test.ts` compares the native facility against a frozen reference fixture (sha256
  provenance of the deleted source); `png-support.test.ts` covers the acceptance PNG decoder.
- Stale CDP suites and `tools/run_twin_browser.mjs` mappings removed; the product matrix is
  `twin-lite.browser.ts`, DOM regression is `twin.browser.ts`. `decodePng` lives in
  `tests/support/png.ts`.
- `@babylonjs/core` removed from `web_app/package.json`; lockfile updated with the repo-pinned pnpm
  and validated with `--frozen-lockfile`.
- Import gate: 0 `@babylonjs/core`/`lite-compat`/three/legacy-module imports in `web_app/src`,
  `web_app/tests`, vite configs and `tools`; dist grep for `WebGPUEngine`/`NullEngine`/
  `SceneInstrumentation`/old plugin symbols returns 0.
- Verification after cleanup and final fixes: `tsc --noEmit` 0; `vitest run` 52 files / 241 tests;
  `vite build` 0.

## 8. Still open / limitations

- Whole-product frozen-clock **Golden: NOT_RUN**; frozen-clock comparison above is the closest
  recorded evidence. **X-Ray visual gap** (frozen mean diff 43.86) is accepted as a documented
  limitation.
- 60-minute soak: **NOT_RUN** (user-directed 1-minute soak instead).
- Non-Chromium browser coverage: **NOT_RUN** (no such browser available).
- Residual review items (camera-restore timer ordering, cascading-loss queue untested, clip scope for
  Standard/overlay surfaces, cut not pixel-asserted) remain tracked in [REVIEW.md](./REVIEW.md).
