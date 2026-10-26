# Lite lighting, shadows and missing equipment implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore readable source lighting and native GPU shadows in the Lite FAB preview, audit and restore missing displayed equipment against Next.

**Architecture:** Keep `FAB_LAYOUT: readonly FabLayoutTool[]` and source geometry unchanged. Use public Lite lights, material plugins and recoverable CSM; reflect source light positions/directions through the same render coordinate frame. Compare actual old/new scenes and light/shadow on/off screenshots.

**Tech Stack:** TypeScript, Babylon Lite 1.36.0, WebGPU, Vitest and Chrome CDP.

**Spec:** `docs/SemiconFab-Next_Babylon-Lite_Native-Migration_Guide_2026-10-26.md` sections 5/6 and P4/P5; user requests strict source consistency, missing devices, lighting/shadows; existing `legacy-site.ts` and `original-lighting.ts` are executable references.

## Global constraints

- No equipment JSON, no compat wrappers or private Lite APIs; existing feature branch; preserve 121 placement identities and original source files.
- Native shadow API first: 2048 depth32float, comparison sampling, explicit caster set, recovery and actual GPU proof.
- Do not claim whole-product or Golden parity from inventory/projection tests.

## Review focus

- B1/DUAL and changing opacity must keep correct light/caster visibility and depth.
- Thin-instance aggregate bounds must include distant machines for shadow fitting and culling.
- Three device losses must restore depth resources, instance geometry and current camera/lights.
- Rapid preset/light toggles and remount must not leave stale async state or leaked callbacks.
- Source PBR linear output, legacy local attenuation and ambient must not be double counted or clipped white.

## Task 1: Inventory and source lighting

Files: new `src/render/lite/lighting.ts`, `tests/lite-lighting.test.ts`, `tests/lite-lighting.browser.ts`; modify preview composition, public bounding opt-in in geometry builders.

- [x] Capture actual Next visible mesh groups and preview before image; enumerate omitted systems separately from 121 process tools.
- [x] Write/rerun failing source-light and GPU image tests.
- [x] Restore key/fill/ambient, amber points/spot, source fog/exposure, PBR linear output and legacy local attenuation through public material plugin; test isolated directional/local/ambient responses.
- [x] Compare same-view images and identify genuine remaining absent equipment; full frontend/typecheck/build.

## Task 2: Native shadows

Files: new `src/render/lite/shadows/native-lite-shadow.ts`, shadow browser gate; modify runtime shadow registration and lifecycle tests.

- [x] RED runtime registration waits for shadow support and its failures clean up.
- [x] Compose recoverable native CSM 2048 with explicit casters, no floor/slab/status/line casters; use native static cache and world bounds.
- [x] Browser on/off proves actual shadow contribution; key off eliminates its shadow contribution; ISO/TOP/B1/DUAL and three losses recover, no GPU errors; verify layer/offset invalidation and remount.

## Task 3: Missing displayed systems and acceptance

- [x] Restore source-defined omitted equipment identified in task 1 using typed TS geometry; retain independent process identities. Capture source/destination inventory and matched bounds for each restored system.
- [x] Run relevant geometry, lighting, lifecycle and spatial suites; document any remaining full migration gates precisely.
- [ ] One read-only independent review, fix Important/Critical with reproducing tests, commit verified increment and retain preview.

## Execution record (2026-10-26)

Status: **IMPLEMENTING / NOT_PARITY_VERIFIED**; a bounded P4/P5 increment, not whole-product parity.

Implemented through public Lite APIs only:

- `src/render/lite/lighting.ts`: source key (1.15) / fill (0.32) / ambient (#cfd8dc × 0.48), five amber points plus the amber spot, source fog/exposure, and legacy local range/spot falloff through `enableMaterialPlugins` + the material UBO (18 packed locals: 6 source + 10 structure basement + 2 facility). PBR `surfaceAlbedo = baseColor × (1 − metallic)` removes Babylon's extra dielectric-F0 diffuse reduction. The frozen source renders with THREE LinearEncoding and no tone mapping; Lite's transmissive scene retargets the pass to `rgba16float` and appends one image-processing gamma encode, so the plugin writes the source linear value and pre-compensates only that trailing encode (and writes it directly when no transmission pass exists).
- `src/render/lite/shadows/native-lite-shadow.ts`: recoverable native CSM directional shadows, 2048² depth32float × 2 cascades, comparison sampling and the native static cache (`enableCsmStaticCache`, refitAngle 0.0001), explicit caster set via `setShadowTaskCasterMeshes` (195 casters, source exclusions: floor/slab/line/status/transparent/vertex-alpha and frozen `staticShadowCaster:false`), thin-instance world bounds opt-in in all three geometry builders, and runtime shadow registration before the first frame (`registerSceneWithShadowSupport`).
- `src/render/lite/geometry/facility.ts` + `facility-layout.ts`: restored frozen source airlock/mat/ceiling systems (1659 parts, 274 native meshes, 1386 FFU instances, 2 air showers with interior lights and billboards, 6 sticky mats, cable trays/trusses/braces/drop rods, purge frame updates) and wired into the preview composition with its own local lights and recovery rebuild.
- Source consistency corrections found by the inventory: frozen early procedural `airshower-*` batches are now kept under a source-disabled root (`legacy-site.ts:406-407`) and the frozen procedural ceiling layer stays disabled (`legacy-site.ts:412`); the preview FFU view maps to the restored original facility ceiling only.

Verification (real WebGPU: Chrome 155.0.8059.86 / NVIDIA RTX 3050, CDP):

- `node tools/run_twin_browser.mjs <suite> 9496 http://127.0.0.1:5175 <json>` — new `lite-lighting` and `lite-shadow` suites PASS with 0 console/GPU errors; existing `lite`, `lite-equipment`, `lite-static`, `lite-layout` suites PASS. `lite-layout` needs the goldens reference server on 5176 (`tests/twin-golden.vite.config.ts`, `FAB_DEVELOPMENT_KEY` set) and `NEXT_REFERENCE_URL`.
- Lighting: shadows on/off ISO mean channel Δ 3.7338, 11.87% ROI pixels changed; key off drops mean luminance 229.714 → 175.609 (−23.55%) and collapses the shadow on/off delta to exactly 0; ambient/fill/local toggles Δ 26.375 / 12.820 / 5.898; every restore byte-identical; ISO/TOP/L1/B1/DUAL/FFU render with 722 draw calls (B1 1112), 0 GPU errors; rapid B1↔DUAL and remount leave no stale state.
- Shadows: 195 casters captured from the exact task array with zero forbidden-caster violations; ISO shadow contribution median Δ 28.67 among changed pixels; TOP/B1 contributions measured; three forced device losses recover with fresh 2048 depth32float CSM maps; dispose+remount recreates shadows with identical contribution; identical states produce identical PNG hashes.
- Same-view geometry gate remains exact: 121 tools + 56 yellow objects, max projection error 0.000021 px (ISO), ≤0.000025 px across ISO/TOP/L1/B1/DUAL.
- Same-view appearance (HUD-hidden Next reference vs Lite, scene ROI [360,100,1500,700], Pillow, no colour correction): mean absolute RGB difference ISO 9.78 (Next mean 216.2/225.3/231.1 vs Lite 219.1/227.2/233.1), TOP 13.11, L1 12.32, B1 16.75, DUAL 19.68. Dynamic P3/P6-P9 systems (personnel, AMHS, airflow/heatmap, roof HVAC, subfab detail, status lamps, wafer/tour) remain absent/different, so this is not a Golden claim.
- Unit/typecheck/build evidence and the read-only review result are recorded in `docs/migration/babylon-lite/evidence/lighting-shadows-facility-2026-10-26/README.md` and the repository progress ledger.
