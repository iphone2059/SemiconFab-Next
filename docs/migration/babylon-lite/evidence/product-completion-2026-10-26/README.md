# Native Lite product completion evidence — 2026-10-26

Status: **IMPLEMENTING / NOT_PARITY_VERIFIED**. This package records product-level evidence for the
**/twin** page running the native Babylon Lite 1.36 renderer (not the bounded fixture preview). The
final code freeze build is the one produced after the P11 cleanup and the device-loss disposal/queue
fixes; the whole-product frozen-clock Golden, non-Chromium browser coverage, the user-directed
60-minute soak replacement and the independent review status are stated explicitly below and in
[VALIDATION.md](../VALIDATION.md).

Environment: Chrome **155.0.8059.86** and Edge **156.0.4314.42** on Windows, viewport **1536x735
DPR 1**, local API at 127.0.0.1:5080 (Development), Lite production preview at 127.0.0.1:5178,
frozen pre-migration Next reference worktree (commit `0b35ca5`) built and previewed at
127.0.0.1:5179.

## 1. Native product acceptance — PASS (0 console errors, Chrome + Edge)

`web_app/tests/twin-lite.browser.ts` driven by `node tools/run_twin_browser.mjs lite-product`.
Final-build evidence: [acceptance-final-run.json](./acceptance-final-run.json),
[acceptance-final-run.png](./acceptance-final-run.png); Edge run:
[acceptance-edge.json](./acceptance-edge.json), [acceptance-edge.png](./acceptance-edge.png).

| Area | Assertion |
|---|---|
| First frame | status reaches `WebGPU · 程序化 FAB · 121 台设备`; screenshot at the asserted 1536x735 runner viewport; 0 console errors |
| Picking | projected tool caught by native GPU pick; hover card, inspector, selection wireframe box visible; ESC clears |
| Focus | double-click focuses the selected tool (camera target = selection visual centre, reflected Z once) |
| Camera | ISO `[38,48,58]`, Top `[0,95,0.1]`, Litho `[-21,3.6,-12.5]`, Airlock `[-12.5,4.2,7.5]` presets exact; orbit drag changes pose; wheel zoom is page-owned; live resize to 1280x640 |
| Levels | L1 floor alpha 1 / B1 0.2 / DUAL 0.35 / EXPLODED 0.55, slab+ceiling+subfab visibility, ceiling lift >15 m, subfab drop <-13 m, offsets reset |
| Layers | roof (assertion: >0 native exhaust particle sprites; source data has 70), ceiling, subfab/piping, heatmap texture updates, airflow clock advances, AMHS layer hide/show |
| Tool states | inspector MAINT reaches the native frame loop within the up-to-5 s frame-sync poll window; 121 states after each recovery |
| X-Ray | all/vac filters, hologram materials active, subfab forced visible, restore removes all `fab-xray-*` materials and returns L1 |
| Section cut | Z +12 => `[0,0,-1,-12]`; invert => `[0,0,1,12]`; exclusive spatial mode clears cut for X-Ray; cut off => null |
| Wafer | marker visible/moving, additive trail draws (>0 indices), follow camera targets the marker, close hides marker/trail |
| Tour / patrol | tour card animates the camera and closes; patrol focus targets the walking engineer |
| Language | zh <-> en product toggle keeps the scene ready |
| Device loss x3 | cut / X-Ray / no-spatial-mode rounds; after each of three real WebGPU device losses: 0 GPU validation errors, all 121 tool states present, camera pose preserved, cut plane or X-Ray materials restored, roof layer restored, and in the no-mode round the **canvas selection index + wireframe** are restored; Redux tool-state sync resumes afterwards. A loss during the replacement build queues another rebuild instead of silently falling back to in-place native recovery. |

Product device-loss strategy (documented integration decision): the native scene is **rebuilt on the
replacement device** and the user camera pose/selection are restored; Lite in-place scene recovery is
still exercised by the bounded `lite-*` fixtures. X-Ray palette CSM depth sampling and section-cut on
Standard materials are deliberate, documented exclusions (see [FEATURE_GAPS.md](../FEATURE_GAPS.md)).

## 2. Legacy product UI regression — PASS (Chrome 155 + Edge 156)

`web_app/tests/twin.browser.ts` runs unchanged against the Lite /twin page: controls, exclusive
spatial modes, ESC behavior, English-only sweep, font floor, modals, wafer panel, tour card,
singleton page. Evidence: [ui-final-run.json](./ui-final-run.json),
[ui-edge.json](./ui-edge.json), screenshots alongside.

## 3. Visual A/B against the frozen pre-migration Next renderer

Method: same Chrome/profile, same viewport 1536x735 DPR 1, both pages at `WebGPU ·`, HUD visible
(outside the ROI), default dynamic demo state, screenshots captured view-by-view with the same HUD
buttons. ROI `[400,120,1500,680]`, Pillow absolute RGB difference, no colour correction. Raw:
[pixel-diff.json](./pixel-diff.json), [screenshot-manifest.json](./screenshot-manifest.json),
screenshots `ref-*.png` / `lite-*.png`. Capture/diff tooling lives in the session `.local/` scratch
scripts and is not committed; the method above is reproducible from those files.

| View | mean abs channel diff | pixels changed >24 |
|---|---|---|
| ISO | 10.301 | 15.6% |
| TOP | 13.721 | 20.9% |
| B1 | 17.666 | 29.1% |
| DUAL | 20.480 | 37.9% |
| EXPLODED | 14.593 | 22.4% |

Residual comes from (a) AMHS/personnel/demo animation phase not being clock-frozen across the two
separate pages, (b) known hologram/cut exclusions, (c) remaining light/shadow response differences.
This is a **comparison, not a Golden PASS**; a frozen-clock product golden run is still NOT_RUN.

## 4. Performance A/B on production preview builds

Both sites built with `vite build` and served with `vite preview` (Lite 5178, frozen reference 5179).
Method: 5 s warmup, 8 s idle + 6 s orbit sampling of rAF deltas, same Chrome/viewport/query. Raw:
[perf-ab.json](./perf-ab.json).

| Renderer | idle fps | orbit fps |
|---|---|---|
| Native Lite (production) | 54.3 | 51.4 |
| Frozen Next 0b35ca5 (production) | 15.9 | 12.9 |

Both runs 0 console errors. Raw JS payload: Lite `gpu` chunk 396,492 B (Lite engine only;
`lite-backend` 2,359,121 B includes the 2.28 MB frozen static-structure data) vs frozen old renderer
`gpu` chunk 2,528,822 B (old core). No old-engine symbols in the Lite dist. Gzip sizes are not
asserted in this report (they vary with the compressor used).

## 5. Soak (user-directed 1-minute run; 60-minute NOT_RUN)

The session owner explicitly replaced the planned 60-minute soak with a 1-minute soak. Final-build
result: 3,330 frames, mean frame 18.01 ms (**55.5 fps**), p95 33.4 ms, p99 33.5 ms, **0 long tasks**,
heap 42.9 MB, 0 GPU validation errors, 0 console errors, status stable at
`WebGPU · 程序化 FAB · 121 台设备`. Raw: [soak-final.json](./soak-final.json).
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
- Legacy internal-scene acceptance/unit modules and their capture helpers deleted or rewritten; the
  retained suite is 51 Vitest files / 238 tests plus the CDP product suites above.
  `lite-facility.test.ts` now compares the native facility against a frozen reference fixture
  (sha256 provenance of the deleted source).
- Stale CDP suites and `tools/run_twin_browser.mjs` mappings removed; the product matrix is
  `twin-lite.browser.ts`, DOM regression is `twin.browser.ts`. `decodePng` now lives in
  `tests/support/png.ts`.
- `@babylonjs/core` removed from `web_app/package.json`; lockfile updated with the repo-pinned pnpm
  and validated with `--frozen-lockfile`.
- Import gate: 0 `@babylonjs/core`/`lite-compat`/three/legacy-module imports in `web_app/src`,
  `web_app/tests`, vite configs and `tools`; dist grep for `WebGPUEngine`/`NullEngine`/
  `SceneInstrumentation`/old plugin symbols returns 0.
- Verification after cleanup: `tsc --noEmit` 0; `vitest run` 51 files / 238 tests; `vite build` 0.

## 8. Still open

- Frozen-clock whole-product Golden: **NOT_RUN**.
- 60-minute soak: **NOT_RUN** (replaced by the user-directed 1-minute soak).
- Non-Chromium browser coverage: **NOT_RUN** (browser unavailable).
- Independent review: findings closed in `REVIEW.md` when the reviewer finalises against this freeze.
