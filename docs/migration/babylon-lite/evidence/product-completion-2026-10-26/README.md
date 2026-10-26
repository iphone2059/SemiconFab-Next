# Native Lite product completion evidence — 2026-10-26 (final build)

Gate summary: [../ACCEPTANCE_STATUS.md](../ACCEPTANCE_STATUS.md).

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
| X-Ray | all/vac filters, hologram materials active, **CSM receiver sampled (`shadowLinked` true) with the source legibility floor**, subfab forced visible, restore removes all `fab-xray-*` materials and returns L1 |
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

Method (reproducible from the repository, no scratch scripts): `node tools/frozen_visual_compare.mjs
--ref http://127.0.0.1:5179 --lite http://127.0.0.1:5178 --port 9490 --out .local/frozen-visual`.
Both pages run under the reference golden harness clock (`GOLDEN_CLOCK`: fixed 16.667 ms virtual
frames, seeded `Math.random`, fixed `Date.now`), injected via CDP
`Page.addScriptToEvaluateOnNewDocument`; the clock is held at 0 until the shell loads, readiness is
padded to a fixed 400-frame budget on both sides, then +180 settle frames and identical per-view frame
counts for ISO, Top, B1, Dual, L1→Exploded, Cut and X-Ray. Sites are captured sequentially in one
foreground tab so a second tab cannot blank/occlude the canvas. Viewport 1536x735 DPR 1, HUD visible
outside the ROI, ROI `[400,120,1500,680]`, absolute RGB difference computed in Node, no colour
correction. Raw: [frozen-clock-diff.json](./frozen-clock-diff.json), screenshots `ref-*.png` /
`lite-*.png`. Because demo data advances on real-time intervals during load, repeated runs vary by
about ±0.5 mean channel; the values below are one recorded run (both sides on identical frames).

| View | mean abs channel diff | pixels changed >24 |
|---|---|---|
| ISO | 9.881 | 15.0% |
| TOP | 13.473 | 20.4% |
| B1 | 17.751 | 29.1% |
| DUAL | 19.943 | 37.3% |
| EXPLODED | 8.299 | 11.1% |
| CUT (X axis) | 5.575 | 8.2% |
| X-RAY (all) | 28.692 | 55.7% |

Free-running earlier captures (no frozen clock) are superseded: ISO 10.301 / TOP 13.721 / B1 17.666 /
DUAL 20.480 / EXPLODED 14.593. Freezing removed the dynamic-phase noise (notably EXPLODED
14.593 → 8.46) and exposed the real remaining gaps. The X-Ray palette now **samples the native CSM
receiver** (2-layer `depth32float` array with its comparison sampler) and casts through a depth-only
Standard caster material, which avoids Lite 1.36's writable+sampled usage conflict: `shadowLinked`
is true, the three device-loss rounds still report 0 GPU errors, and the frozen X-Ray diff improved
from 43.860 (no shadow sampling) via ≈35 (raw CSM response) to **28.692** after the frozen-product
legibility-floor decision (below). X-Ray remains a **known visual gap** — the product hologram is
still lighter than the frozen source's custom depth-pass hologram — and is recorded as a limitation,
not a pass.

Residual analysis (round 4, debug-marker experiment): a temporary pure-red highlight marker proved
the highlighted-subfab branch renders over ~20% of the canvas on both sides, so coverage is right;
inside that mask the reference's median luminance is 117 vs the product's 164 (mean RGB (65,136,167)
vs (125,185,201)). The residual was therefore the *shadow/lit response* of the palette, not geometry.

Frozen-product legibility-floor decision (round 6): experiments showed the raw CSM response leaves most
hologram surfaces near fully lit (35.039 X-Ray mean diff), while the source hologram sampled its own
custom static depth pass and reads as much darker with a wide distribution (median luminance 117).
Reproducing the source's single-map response cannot use the CSM cadence directly, so the palette keeps
the native CSM modulation but folds it into the source legibility floor and reduced contrast:
`lit = 0.35 + (1 - 0.35) * shadow * 0.35` (named `XRAY_LIT_FLOOR` / `XRAY_SHADOW_CONTRAST` in
`render/lite/effects.ts`). This is a documented **visual-parity approximation of the frozen product's
appearance**, not a claim that the legacy depth pass was reproduced; it lowers the frozen X-Ray diff
to 28.692. The marker experiment was reverted; no debug code remains in the tree.

This is a **frozen-clock comparison, not a Golden PASS**: the migration guide does not define a
whole-product golden threshold and the X-Ray gap is visible. Whole-product Golden remains NOT_RUN.

## 4. Performance A/B on production preview builds

Both sites built with `vite build` and served with `vite preview` (Lite 5178, frozen reference 5179).
Method: 5 s warmup, 8 s idle + 6 s orbit sampling of rAF deltas, same Chrome/viewport/query. Raw:
[perf-ab.json](./perf-ab.json).

| Renderer | idle fps | orbit fps |
|---|---|---|
| Native Lite (production) | 52.5 | 45.8 |
| Frozen Next 0b35ca5 (production) | 38.2 | 37.4 |

Both runs 0 console errors. **Methodology correction**: earlier A/B numbers (Lite 57.9/53.9 vs legacy
15.8/14.0) were captured in a stale multi-window CDP browser in which the legacy tab was
occlusion-throttled; they are withdrawn. In a single fresh fully-visible Chrome window, repeated
three times, the legacy renderer runs 38–39 fps and Lite runs 46–54 fps (≈1.2–1.35× faster), which is
the recorded result. Raw JS payload: Lite `gpu` chunk 396,492 B (Lite engine only;
`lite-backend` 2,359,121 B includes the 2.28 MB frozen static-structure data) vs frozen old renderer
`gpu` chunk 2,528,822 B (old core). No old-engine symbols in the Lite dist; gzip sizes are not
asserted here.

## 5. Soak (user-directed 1-minute run; 60-minute NOT_RUN)

The session owner explicitly replaced the planned 60-minute soak with a 1-minute soak. Final-build
result: 3,088 frames, mean frame 19.41 ms (**51.5 fps**), p95 33.4 ms, p99 33.5 ms, **0 long tasks**,
heap 37.5 MB, 0 GPU validation errors, 0 console errors, status stable at
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
- The frozen-clock visual evidence is reproducible from the repository: `tools/frozen_visual_compare.mjs`
  captures both pages on identical virtual frames and computes the ROI diff in Node (see §3).
- `@babylonjs/core` removed from `web_app/package.json`; lockfile updated with the repo-pinned pnpm
  and validated with `--frozen-lockfile`.
- Import gate: 0 `@babylonjs/core`/`lite-compat`/three/legacy-module imports in `web_app/src`,
  `web_app/tests`, vite configs and `tools`; dist grep for `WebGPUEngine`/`NullEngine`/
  `SceneInstrumentation`/old plugin symbols returns 0.
- Verification after cleanup and final fixes: `tsc --noEmit` 0; `vitest run` 52 files / 241 tests;
  `vite build` 0.

## 8. Still open / limitations

- Whole-product frozen-clock **Golden: NOT_RUN**; frozen-clock comparison above is the closest
  recorded evidence and is reproducible with `tools/frozen_visual_compare.mjs`. **X-Ray visual gap**
  (frozen mean diff 28.692 after the legibility-floor approximation, down from 43.86 without shadow
  sampling) is accepted as a documented limitation.
- 60-minute soak: **NOT_RUN** (user-directed 1-minute soak instead).
- Non-Chromium browser coverage: **NOT_RUN** (no such browser available).
- Residual review items (camera-restore timer ordering, cascading-loss queue untested, clip scope for
  Standard/overlay surfaces, cut not pixel-asserted) remain tracked in [REVIEW.md](./REVIEW.md).
