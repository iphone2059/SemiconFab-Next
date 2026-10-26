# Complete native Lite product migration

> **Execution:** existing approved native migration guide, continued under the user's instruction to remove old Babylon and complete acceptance. Use TDD, systematic debugging, native APIs, and independent module workers where ownership does not overlap.

**Spec:** `docs/SemiconFab-Next_Babylon-Lite_Native-Migration_Guide_2026-10-26.md`.

**Goal:** All product renderer behavior uses pinned Babylon Lite 1.36; old core dependency and old renderers are removed after functional, identity, state, visual, performance and lifecycle gates pass. Keep NOT_PARITY_VERIFIED until the actual gates pass.

**Architecture:** Preserve SceneBackend/SceneFacade, React/Redux and pure TS domain timelines. Build native renderer modules in source RH coordinates, reflect only at the render boundary. Business state enters through the current callbacks and setters. Native scene owns resources; runtime owns GPU acquisition/recovery/first-frame readiness. Existing feature checkout contains the accepted uncommitted groundwork and is the implementation workspace.

## Module contracts

- `createLiteMotion(scene, engine)`: `root`, `meshes`, `lights`, `update(deltaMs, nowMs)`, `readStats(): AmhsStats`, `patrolPosition(): readonly [number,number,number]`, `setLanguage('zh'|'en')`, `prepareForDeviceRecovery()`, `dispose()`. Own AMHS/people/patrol only, 24 vehicles/6 people, reuse existing deterministic timelines.
- `createLiteEnvironment(scene, engine)`: `root`, `meshes`, `lights`, `update(deltaMs, nowMs)`, `setLayer('roof'|'airflow'|'heatmap', visible)`, `setExplodeFactor(factor)`, `setLanguage('zh'|'en')`, `prepareForDeviceRecovery()`, `dispose()`. Own roof/HVAC/airflow/heatmap/exploded links only; preserve source counts/poses and native batching.
- Root implementer owns `backend.ts`, camera/picking/selection, tool state colors, world composition, cut/X-Ray/wafer projection and UI integration. Module workers do not change these files or shared lifecycle/lighting/facility groundwork.

## Tasks

1. **Product backend and projection state** — native world composition, coordinate/camera transforms, async camera cancellation, picking/hover/selection, status updates, layer and level state, locale, resize/recovery. Tests exercise actual public domain interface and GPU product mounting. Preserve viewer epochs and do not create another Redux store.
2. **Motion systems** — native AMHS and people builders plus fixed-step source timelines; source identity/count/pose tests before implementation, device recovery and scene ownership tests.
3. **Environment systems** — native roof/particles/airflow/heatmap/exploded links with source fixture/bounds/timing/layer tests; avoid custom renderers where native mesh/billboard/task APIs suffice.
4. **Special effects and business linkage** — native cut planes, X-Ray roles/filters, wafer marker/trail, source device-state indicators and camera presets; preserve existing tour/wafer/research/HUD controllers. Browser regression for every public control and combined states.
5. **Reference and dependency cleanup** — keep frozen old reference independently reproducible; replace core-dependent tests/extraction with frozen data/native tests, delete obsolete renderer code and core dependency only after consumers migrate. Verify imports/manifests/lock/production graph.
6. **Full acceptance** — complete scene/browser/locale/layer/camera/lifecycle matrix; three repeated losses preserving user state; 60-minute soak; same-machine visual/performance A/B and original reference comparison. Record real PASS/FAIL/NOT_RUN, repair failures, independently review and report only proven completion.

## Review focus

- Stale async camera/pick/build work cannot overwrite a newer selection or disposed mount.
- Thin-instance identities and state updates survive visibility, level changes and device loss.
- Source clocks/seeds remain authoritative, including hidden systems; no duplicate simulation clock for shared domain timelines.
- Transparent/overlay/native unlit paths retain correct ordering and recovery ownership.
- All mode combinations restore original materials/visibility/positions when exited; old engine is absent from the final product graph and lockfile.

Progress and per-task RED/GREEN evidence: `.local/lite-product-completion-20261026/progress.md`.

## Remaining steps (decomposed, updated 2026-10-26 21:00)

Status legend: DONE / ACTIVE / TODO. Every acceptance step records real evidence; no "looks fine" claims.

### A. Native modules (DONE)
- A5 section-cut MaterialPlugin for native PBR+Standard materials: `render/lite/cut-plane.ts`; 4 tests green, wired in world. DONE
- A1 effects module (X-Ray palette/6 filters, cut plane state, wafer marker/flange/door + amber light, bounded trail, CSM depth borrowing): `render/lite/effects.ts`, `effects-xray-state.ts`; 7 contract tests green. DONE
- A2 selection (native GPU pick, hover/click/dblclick/focus, stale-epoch guard, r128 wireframe box) + tool states (4 frozen colors, down pulse, per-instance color/emissive plugin, recovery reapply): `render/lite/selection.ts`, `tool-states.ts`; 17 tests green. DONE
- A3 world composition (`render/lite/world.ts`): equipment/static/facility/motion/environment/effects/lighting/shadows + one frame loop, legacy `syncLevel`/explode state machine, overlay billboard layer for facility+environment, single RH->LH boundary, perf snapshot. DONE
- A4 product backend (`lite-backend.ts`) mounted by `fab-viewer.tsx`; product wheel-zoom ownership fixed for Lite attachControl. DONE (unit/build level)

### B. Section cut plugin (ACTIVE - task-3, effects-worker)
- B1 public MaterialPlugin for native PBR + Standard materials so cut clips the whole FAB (effects shaders already clip); plane math identical to effects tests. Then wire in world.ts + attach before enableMaterialPlugins.
- B2 unit tests for plane conversion/attachment/WGSL discard; later real-GPU assert.

### C. /twin real-page GPU verification (DONE — acceptance suite twin-lite.browser.ts PASS on production build)
- C1 first frame on real /twin: DONE (dev + production preview) — status reaches 'WebGPU · 程序化 FAB · 121 台设备', 0 console/GPU errors; product acceptance + legacy UI suite PASS; evidence package docs/migration/babylon-lite/evidence/product-completion-2026-10-26/.
- C2 121 tools + picking/hover/click/double-click focus/selection box; DOM hover card + inspector sync.
- C3 camera presets ISO/TOP/L1/B1/DUAL/EXPLODED, orbit/pan/zoom, wheel single-owner, resize.
- C4 levels: floor alpha 1/0.2/0.35/0.55, slab visibility, B1 visibility, ceiling offset 20m, subfab offset -18m, ceiling/roof auto rules.
- C5 layers: amhs/ceiling/roof/subfab/heatmap/airflow/xray incl. basement interplay.
- C6 tool states 4 states + down pulse + Redux frame sync; no state leak across tools/batches.
- C7 X-Ray: 6 filters, role matrix, material restoration, subfab system matching (bounded coarse batches documented), combined with explode/level.
- C8 section cut X/Y/Z/invert on whole scene; combined with X-Ray/explode.
- C9 wafer follow (marker/flange/door/light/trail/follow camera), tour 5 waypoints + interruption, patrol focus, zh/en labels.

### D. Device-loss recovery (DONE for product strategy: scene rebuilt on replacement device x3 with 0 GPU errors; native in-place recovery covered by bounded fixtures)
- D1 3x machine-loss on /twin: material restoration, thin instances, CSM caches, overlay billboards/labels, picker recreation, camera pose, Redux state preserved.
- D2 recovery while hidden tab / rapid consecutive losses / unmount during recovery.

### E. Acceptance matrix (PARTIAL)
- E1 frozen old-Next reference worktree comparison (ISO/TOP/L1/B1/DUAL/EXPLODED + layer/xray/cut/wafer states), HUD hidden, same Chrome/viewport; record pixel deltas, no colour correction.
- E2 performance A/B (?perf: fps/frame-ms/draw calls/heap, idle + orbit on one machine).
- E3 60-minute soak (frames/memory/errors), resize storm.
- E4 browser matrix per guide (installed Chrome versions; adapter variants available on this machine).

### F. Cleanup and gates (DONE except final review status/doc sync)
- F1 migrate/replace core-dependent legacy acceptance tests (twin-wafer/level/exploded/xray read Babylon scene internals) with Lite diagnostics; keep DOM/camera-driven suites (twin UI, tour, performance) running on /twin.
- F2 delete obsolete renderer sources (legacy-site, babylon-webgpu, original-*/native-*/procedural-fab/xray/aerodynamics etc.) after no imports remain; frozen reference worktree stays reproducible.
- F3 remove @babylonjs/core from package.json/lockfile, production dependency graph gate, bundle-size note.
- F4 update BASELINE/i18n inventory/MIGRATION_PLAN/VALIDATION/FEATURE_GAPS with real PASS/FAIL/NOT_RUN; independent review; evidence package.

### Status update 2026-10-26 23:xx
- C2–C9: DONE and asserted by `web_app/tests/twin-lite.browser.ts` on the built production preview (picking/hover/selection/focus, camera presets/orbit/wheel/resize, levels, layers, tool-state sync, X-Ray, cut, wafer, tour/patrol, language).
- D1: DONE x3 (cut/X-Ray alternating, 0 GPU errors, 121 states + camera preserved, Redux sync resumes). D2 (hidden-tab/rapid-loss variants) NOT_RUN — hidden tabs suspend rAF in this harness.
- E1: frozen-clock A/B captured with the reference GOLDEN_CLOCK for 7 views and now reproducible via committed tools/frozen_visual_compare.mjs (ISO 10.01 / TOP 13.57 / B1 17.69 / DUAL 20.15 / EXPLODED 8.46 / CUT 5.70 / X-RAY 34.00 after CSM receiver sampling, down from 43.86); whole-product Golden still NOT_RUN and X-Ray visual gap documented. E2: production-build perf A/B PASS (52.8/46.0 vs 39.2/38.9 fps, ~1.2-1.35x; earlier 57.9/53.9 vs 15.8/14.0 withdrawn as occlusion-throttled). E3: user-directed 1-minute soak PASS (52.1 fps, 0 long tasks, 0 GPU/console errors); 60-minute soak NOT_RUN by instruction. E4: Chrome 155 + Edge 156 PASS; non-Chromium unavailable -> NOT_RUN.
- F1: legacy internal-scene suites removed, product suite replaces them; frozen-clock tour timing NOT_RUN. F2/F3: DONE (17 sources + @babylonjs/core removed; dist gate clean). F4: docs updated, independent review IN PROGRESS (REVIEW.md).
