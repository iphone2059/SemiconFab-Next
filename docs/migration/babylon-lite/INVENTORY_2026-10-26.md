# Source-vs-Lite scene inventory — 2026-10-26

Status: **IMPLEMENTING / NOT_PARITY_VERIFIED**. Scope: the current migration increment (restored
source lighting, native CSM shadows, restored facility/airlock/ceiling systems) on branch
`feat/twin-babylon-lite-native` (HEAD `d25eb4f680105278907ed6d2b0ca3cffcaf6b211`).

Revision: **final revision before commit**. R01 (early procedural air-shower approximation still
rendering) and R02 (procedural ceiling not source-disabled) were fixed by the Lead in
`web_app/src/render/lite/geometry/static-structure.ts` and the preview composition; the full canonical
GPU suite matrix was rerun from the final state (`.local/lite-acceptance-final/`) with all suites PASS.
This inventory and the evidence package reflect that final state. The task named previous-evidence path
`docs/migration/babylon-lite/evidence/material-lighting-2026-10-26/README.md` does not exist in this
checkout; the previous evidence style was read from
`docs/migration/twin-parity/evidence/material-lighting-2026-10-26/README.md`.

Machine-readable companion: [evidence/lighting-shadows-facility-2026-10-26/inventory.json](evidence/lighting-shadows-facility-2026-10-26/inventory.json).
Pixel/toggle evidence: [comparison.json](evidence/lighting-shadows-facility-2026-10-26/comparison.json),
[README.md](evidence/lighting-shadows-facility-2026-10-26/README.md). This inventory does not claim
Golden or whole-product parity; unverified items are listed in §8.

## 1. Method and frozen basis

Source of truth is the current checkout of the frozen Next renderer (`web_app/src/legacy-site.ts`,
`web_app/src/procedural-fab.ts`, the `web_app/src/original-*.ts` builders, and the
`web_app/src/{amhs,personnel,tour-wafer}-timeline.ts` modules), not the older original Three.js page.
The original page commit `b3666132e5d8cab2cebe4c4227fc04c52242eb28` is cited where the frozen source
comments cite it. The Lite state is the test-only preview composed by `web_app/tests/lite-runtime/main.ts`
and driven by the final canonical GPU acceptance evidence in `.local/lite-acceptance-final/` (Chrome 155,
real WebGPU, 1536x735, DOM chrome hidden).

Verdicts used below:

| Verdict | Meaning |
|---|---|
| `COVERED_NOW` | Source system (or its data) is built by the current Lite native port and visible/verified in this increment or P2/P2b, or its source-disable semantics are reproduced (S05/S06). |
| `PARTIAL` | Geometry/data is ported but a source behaviour, state binding, or semantic is not reproduced, or verification is missing for part of it. |
| `DEFERRED` | Not ported in this increment and explicitly assigned to a later migration phase (P3/P6–P9) by `MIGRATION_PLAN.md` / the migration guide §7. |
| `MISSING` | Not ported and no phase citation found. None: R01/R02 were fixed in the final revision and no remaining source system lacks a phase citation. |

Frozen files used by this inventory are unmodified versus HEAD (git status clean for those paths).
Recorded SHA-256 values (first 8 hex digits; full table in inventory.json):

| File | SHA-256 | Basis |
|---|---|---|
| `web_app/src/fab-layout.ts` | `ec7cab8e…` | BASELINE.json |
| `web_app/src/fab-scene.ts` | `990ba07a…` | BASELINE.json |
| `web_app/src/personnel-timeline.ts` | `8bc0ceda…` | BASELINE.json |
| `web_app/src/amhs-timeline.ts` | `e877b051…` | BASELINE.json |
| `web_app/src/twin-spatial.ts` | `e69f171e…` | BASELINE.json |
| `web_app/src/procedural-fab.ts` | `19057527…` | lite-static-structure.json provenance |
| `web_app/src/original-environment.ts` | `7d538941…` | lite-static-structure.json provenance |
| `web_app/src/subfab-utilities.ts` | `3453a964…` | lite-static-structure.json provenance |
| `web_app/src/original-subfab-facilities.ts` | `7f4feb87…` | lite-static-structure.json provenance |
| `web_app/src/legacy-site.ts` | `90f6db0f…` | computed; unmodified vs HEAD |
| `web_app/src/original-lighting.ts` | `f3616c88…` | computed; unmodified vs HEAD |
| `web_app/src/original-facility-architecture.ts` | `1fb39e1a…` | computed; unmodified vs HEAD |
| `web_app/src/original-roof-hvac.ts` | `ab09e544…` | computed; unmodified vs HEAD |
| `web_app/src/original-tool-geometry.ts` / `-tool-parts.ts` | `e8289176…` / `dbb8f159…` | computed; unmodified vs HEAD |
| `web_app/src/original-exploded-links.ts` / `-data.ts` | `c25f2bde…` / `a6a6990c…` | computed; unmodified vs HEAD |
| `web_app/src/aerodynamics.ts` / `airflow-texture.ts` / `cleanroom-pressure.ts` | `682f2b96…` / `efa92f6d…` / `2a940143…` | computed; unmodified vs HEAD |
| `web_app/src/xray-hologram.ts` | `230a90a0…` | computed; unmodified vs HEAD |
| `web_app/src/native-static-shadows.ts` / `native-shadow-material.ts` | `f2f152da…` / `9e94a698…` | computed; unmodified vs HEAD |
| `web_app/assets/lite-static-structure.json` | `a0e86d22…` | P2b frozen asset (provenance `fadc3b4`), 1 648 entities |

Final-revision Lite files changed by the fixes: `render/lite/geometry/static-structure.ts`
`a954880e…` (hidden `static-source-disabled` root + airshower-* parenting), `tests/lite-runtime/main.ts`
`e703efee…` (FFU view maps to facility ceiling; snapshot `airshowerVisible`),
`tests/lite-static-structure.browser.ts` `38883a40…`, `tests/lite-lighting.browser.ts` `6e684811…`,
`tests/lite-shadow.browser.ts` `8a51ce12…`, `tools/run_twin_browser.mjs` `d09a95e6…`. plus render/lite/lighting.ts final local-light UBO packing optimization (hash 2deba87e..., public API, pixel-neutral by intent). Full 70+ entry
hash table is in inventory.json.

## 1b. 3D implementation boundary (user constraint)

User constraint: **所有 3D 效果必须由 Babylon Lite 原生能力或 WebGPU 公开 API 实现**
("All 3D effects must be implemented with Babylon Lite native capabilities or public WebGPU APIs").

Verified implementation boundary:

- **Lighting**: official Lite directional/hemispheric/point/spot lights + official `MaterialPlugin`
  public WGSL slots compiled into the native Lite PBR pipeline (`enableMaterialPlugins`); source local
  lights ride the material UBO. No custom render pass, no private Lite API, no regex WGSL rewriter, no
  forked Lite shader.
- **Shadows**: native `createCsmDirectionalShadowGenerator` + `enableCsmStaticCache` +
  `setShadowTaskCasterMeshes` + `setShadowGeneratorEnabled` + `registerSceneWithShadowSupport`. No
  hand-written depth pass or `GPUTexture`.
- **Facility/geometry**: native `createMeshFromData` / `createBox` / `createCylinder` / `createPlane`,
  thin instances and the facing-billboard system; native `ShaderMaterial` (WGSL) for the air-shower
  jets. Canvas2D is used only to generate source textures/label sprites, not 3D rendering.
- **Audit result**: 0 matches for `@babylonjs/core`, `@babylonjs/lite-compat`, Three.js or WebGL
  imports in `web_app/src/render/lite/**` and in `web_app/tests/lite-runtime/main.ts`, and 0 matches for
  private underscore-prefixed Lite members in the new Lite render path. The old Babylon-core product
  renderer still powers `/twin` until P11 replaces it; that is documented migration state, not part of
  this increment.

## 2. Coverage summary

```
systems enumerated: 34
COVERED_NOW: 16
PARTIAL:      6
DEFERRED:    12
MISSING:      0
```

The 121 process tools are one system (S07) and are never mixed with the facility/environment systems.

## 3. Process tools (separate from displayed systems)

| ID | System | Source reference | Source counts | Verdict | Lite evidence |
|---|---|---|---|---|---|
| S07 | 121 process-tool placements: 8 template families + 4 catalog models, status beacons/poles, 3 inferred catalog wireframes | [fab-layout.ts:25-147](../../../web_app/src/fab-layout.ts#L25-L147) `FAB_LAYOUT`; [original-tool-geometry.ts:13-65](../../../web_app/src/original-tool-geometry.ts#L13-L65); [original-tool-parts.ts:18-73](../../../web_app/src/original-tool-parts.ts#L18-L73) | 121 = 117 draft + 4 catalog; 8 families (litho 16, thermal 8, bench 17, cluster_etch 18, cluster_depo 18, cluster_implant 7, neutral_pkg 20, neutral_metro 13) + catalog 4; 3 wireframes; 51 batches / 936 part instances | `COVERED_NOW` | [tool-families.ts:27-134](../../../web_app/src/render/lite/geometry/tool-families.ts#L27-L134); `lite-equipment.test.ts` 4 PASS; final `lite-lighting.json` tools=121, identitiesMapped=true |

Per-family JSON counts and the 936-instance derivation are in inventory.json (`counts.equipment`).
This increment added `receiveShadows`, caster metadata (`staticShadowCaster` semantics: status parts and
draft pole/beacon excluded) and thin-instance world bounds to the equipment batches
([tool-families.ts:82-114](../../../web_app/src/render/lite/geometry/tool-families.ts#L82-L114)).

## 4. Displayed systems covered now (not process tools)

| ID | System | Source reference | Source counts | Lite evidence | Remaining |
|---|---|---|---|---|---|
| S01 | Floor, slab, 2 Canvas2D floor texture recipes | [original-environment.ts:38-66](../../../web_app/src/original-environment.ts#L38-L66) | floor 114x84 m; 2 x 512² recipes; uScale/vScale 95/70 and 28/60 | [static-structure.ts:76-110](../../../web_app/src/render/lite/geometry/static-structure.ts#L76-L110); P2b frozen asset | texture gamma/anisotropy carried as frozen inputs, not pixel-verified |
| S02 | 9 color zones, borders, hazard strips, aisle | [original-environment.ts:18-24,72-86](../../../web_app/src/original-environment.ts#L18-L86) | 9 zones, 9 borders, 2 hazard strips, 1 aisle | static shell layer (312 parts) | — |
| S03 | Amber litho ceiling: 4 strips/trims, 55 panels, 2 rails, 169 curtain strips, sign | [original-environment.ts:15-16,87-114](../../../web_app/src/original-environment.ts#L15-L114) | 65 `original-amber-*`, 169 `original-curtain-*` entities | static shell layer | transmissive curtain composition not pixel-verified |
| S04 | Perimeter walls/doors/glass/kick + 24 columns (source marks columns non-casting) | [procedural-fab.ts:202-221](../../../web_app/src/procedural-fab.ts#L202-L221); [original-environment.ts:66-71](../../../web_app/src/original-environment.ts#L66-L71) | 3 walls, 12 door entities, 24 columns | static shell layer | — |
| S05 | Early procedural air-shower approximation (2 groups: 8 posts, 2 glass, 2 top, 2 base) — **source-disabled equivalent after R01 fix** | [procedural-fab.ts:223-241](../../../web_app/src/procedural-fab.ts#L223-L241); disable rule [legacy-site.ts:406-407](../../../web_app/src/legacy-site.ts#L406-L407) | 14 `airshower-*` frozen parts | **FIXED**: every batch whose first entity name starts with `airshower-` is parented to a hidden `static-source-disabled` root and `setSubtreeVisible(false)` ([static-structure.ts:67-70,160-164](../../../web_app/src/render/lite/geometry/static-structure.ts#L67-L164)); cannot be re-shown by `setLevel`/`setVisible`. Final `lite-static.json`/`lite-lighting.json` assert `structure.airshowerVisible === false` in every view | — |
| S06 | Procedural ceiling (81 frame/panel/fan/hub + 19 beams = 343 parts) — **source-disabled equivalent after R02 fix** | [procedural-fab.ts:243-269](../../../web_app/src/procedural-fab.ts#L243-L269); disable rule [legacy-site.ts:412](../../../web_app/src/legacy-site.ts#L412) | 343 frozen `ffu`-layer parts | **FIXED**: preview keeps `structure.setVisible('ffu', false)` in every `structureView` call and maps FFU view to the restored original facility ceiling only ([lite-runtime/main.ts:171-176](../../../web_app/tests/lite-runtime/main.ts#L171-L176)). Final suites assert `structure.layers.ffu.visible === false` in every view | — |
| S09 | 2 source air showers: plenums, 3x3 nozzle walls, doors/windows/indicators, HMI, 4 jets, interior point light, Canvas2D billboards | [original-facility-architecture.ts:48-57,416-552](../../../web_app/src/original-facility-architecture.ts#L48-L552) | 2 x 33 parts = 66; 2 point lights; 2 billboards | [facility.ts:67-118](../../../web_app/src/render/lite/geometry/facility.ts#L67-L118); `lite-facility.test.ts` PASS (all source bounds within 4 decimals); final `lite-lighting.json` facilityLights=2; current ISO/L1 captures show the main airlock + bilingual label at bottom-centre | label language (S12) and animation (S13) unverified |
| S10 | 6 sticky mats (frame/surface/tab/mark) | [original-facility-architecture.ts:88-95,557-591](../../../web_app/src/original-facility-architecture.ts#L88-L591) | 24 parts | [facility.ts:119-131](../../../web_app/src/render/lite/geometry/facility.ts#L119-L131) | — |
| S11 | Ceiling FFU architecture: deck, 1 386 FFU units, 8 LED aisles+lenses, 10 trusses, 100 braces, 50 drop rods, 3 cable trays+cables | [original-facility-architecture.ts:106-118,594-656](../../../web_app/src/original-facility-architecture.ts#L106-L656); `ORIGINAL_FACILITY_COUNTS` [136-145](../../../web_app/src/original-facility-architecture.ts#L136-L145) | 1 569 parts; hidden by default (`legacy-site.ts` calls `setCeilingVisible(false)` at [382](../../../web_app/src/legacy-site.ts#L382)) | [facility.ts:132-167](../../../web_app/src/render/lite/geometry/facility.ts#L132-L167); facility parts 1 659 / meshes 274 / instances 1 386; final FFU-view capture shows only this facility ceiling | FFUs are one thin-instance batch (identity data preserved, no per-FFU picking) |
| S15 | B1/subfab static facilities: dense industrial facilities + utility headers/drops + B1 floor + 10 source lights | [original-subfab-facilities.ts:240-273,283+](../../../web_app/src/original-subfab-facilities.ts#L240-L283); [subfab-utilities.ts:9-94](../../../web_app/src/subfab-utilities.ts#L9-L94); [procedural-fab.ts:271-291](../../../web_app/src/procedural-fab.ts#L271-L291) | 993 parts = 46 procedural subfab pipes/tanks + 149 utility meshes + 798 dense facility meshes; 10 lights (6 high-bay decay 1.2, 4 soft strips decay 1.5) | static b1 layer; `lite-static-structure.test.ts` PASS (10 lights, B1 offset); final `lite-lighting.json` structureLights=10 | hidden by default in preview; product layer toggle P3 |
| S27 | Source lighting rig: key 1.15, fill 0.32, ambient 0.48, 5 amber points, amber spot, 10 B1 lights, 2 air-shower lights | [legacy-site.ts:350-370,415-429](../../../web_app/src/legacy-site.ts#L350-L429); [original-subfab-facilities.ts:223-232](../../../web_app/src/original-subfab-facilities.ts#L223-L232); [original-facility-architecture.ts:529-537](../../../web_app/src/original-facility-architecture.ts#L529-L537) | 18 local lights (5+1+10+2), 2 directional, source ambient | [lighting.ts:17-61](../../../web_app/src/render/lite/lighting.ts#L17-L61); `lite-lighting.test.ts` 3 PASS; final `lite-lighting.json` keyIntensity=1.15, localLights=18 | — |
| S28 | Legacy light response: Lambert diffuse, `albedo*(1-metalness)`, per-light `pow(1-d/range, decay)`, LinearEncoding output + unpowered fog, no tone mapping, no IBL | [original-lighting.ts:17-145](../../../web_app/src/original-lighting.ts#L17-L145); [legacy-site.ts:361-370](../../../web_app/src/legacy-site.ts#L361-L370) | decays 2 (amber), 1.2 (six B1), 1.5 (four B1), 1 default; spot smoothstep cone | [lighting.ts:66-121](../../../web_app/src/render/lite/lighting.ts#L66-L121) official MaterialPlugin + public WGSL slots; final ambient/fill/local toggle deltas match suite thresholds | specular/transmission exactness not pixel-verified |
| S29 | Native GPU shadows | Legacy Next: [native-static-shadows.ts:17-239](../../../web_app/src/native-static-shadows.ts#L17-L239) + [native-shadow-material.ts:15-57](../../../web_app/src/native-shadow-material.ts#L15-L57) (custom 2048 depth pass) | legacy Next: custom depth texture + caster list | [native-lite-shadow.ts:8-35](../../../web_app/src/render/lite/shadows/native-lite-shadow.ts#L8-L35): native CSM, mapSize 2048, 2 cascades, depth32float, static cache, explicit casters (195); final suites 0 GPU errors; 3 recoveries | no 60-min soak / cross-browser matrix |
| S30 | Scene lifecycle + device-loss recovery | guide §5; legacy Next device handling | — | [runtime.ts:21-185](../../../web_app/src/render/lite/runtime.ts#L21-L185); `registerSceneWithShadowSupport` when shadow generators exist ([145-150](../../../web_app/src/render/lite/runtime.ts#L145-L150)); `lite-runtime.test.ts` 25 PASS; final `lite-shadow.json` 3 recoveries | whole-product matrix not claimed |
| S34 | P2b frozen static structure data + extraction provenance | [P2_STATIC_STRUCTURE.md](P2_STATIC_STRUCTURE.md); asset provenance `nextCommit fadc3b4` | 1 648 entities, 222 geometries, 59 materials, 10 lights, 2 floor textures | asset sha256 `a0e86d22…`; `lite-static-structure.test.ts` 6 PASS; final `lite-static.json` parts 1 648 / batches 396 / lights 10 | — |

## 5. Partial systems (remaining reproduced-semantics gaps)

| ID | System | Source reference | Gap | Verdict |
|---|---|---|---|---|
| S08 | Per-tool status lamps: 4 states + down-state pulse + `setToolState` | [legacy-site.ts:320-346](../../../web_app/src/legacy-site.ts#L320-L346); [fab-layout.ts:149-165](../../../web_app/src/fab-layout.ts#L149-L165) | Geometry exists (121 beacons + 117 poles, emissive materials) but state mapping by index and the down pulse are not restored in Lite. | `PARTIAL` |
| S13 | Air-shower purge cycle animation: indicator colours, 4 jets, interior light | [original-facility-architecture.ts:683-749](../../../web_app/src/original-facility-architecture.ts#L683-L749) | Implemented in [facility.ts:170-197](../../../web_app/src/render/lite/geometry/facility.ts#L170-L197) from `personnel-timeline` frames, but no unit/pixel assertion of the animated response in this increment. | `PARTIAL` |
| S26 | Product SceneBackend: picking/hover/selection box, focus/zoom, view presets, layers, tool states, language | [fab-scene.ts:37-59](../../../web_app/src/fab-scene.ts#L37-L59); [babylon-webgpu.ts:236-331,458-628](../../../web_app/src/babylon-webgpu.ts#L236-L628) | Preview exposes ISO/TOP/L1/B1/DUAL/FFU and floor states; product backend/picking not ported. | `PARTIAL` (P3) |
| S31 | Camera/coordinate frame and Next reference view poses | [babylon-webgpu.ts:581+](../../../web_app/src/babylon-webgpu.ts#L581); [twin-page.tsx](../../../web_app/src/twin-page.tsx) flyLevel | [next-coordinate-frame.ts:5-45](../../../web_app/src/render/lite/next-coordinate-frame.ts#L5-L45); [LAYOUT_PARITY.md](LAYOUT_PARITY.md) reports < 0.00003 px max projection error across ISO/TOP/L1/B1/DUAL (final `lite-layout.json` max 2.514e-05 px); product presets reset/focus/litho/airshower/etch/oht and interaction remain P3. | `PARTIAL` |
| S32 | Level switching: floor alpha 1/0.2/0.35, slab, retain L1, B1 offset | [legacy-site.ts:529-556,623-634](../../../web_app/src/legacy-site.ts#L529-L634); [twin-spatial.ts:18-25](../../../web_app/src/twin-spatial.ts#L18-L25) | Preview L1/B1/DUAL verified; exploded hierarchy/animation P8; product wiring P3. | `PARTIAL` |
| S33 | Layer toggles: ceiling/ffu, roof, subfab, amhs, heatmap, airflow, xray | [legacy-site.ts:578-615](../../../web_app/src/legacy-site.ts#L578-L615) | Only the FFU/facility-ceiling layer is exercised in the Lite preview (and it now maps to the restored facility ceiling only); the other six layers are deferred P6–P8. | `PARTIAL` |

## 6. Deferred systems (not restored in this increment)

All rows below cite the phase assignment in the migration guide §7 / [MIGRATION_PLAN.md](MIGRATION_PLAN.md)
(P4–P10 `NOT_RUN`). They are counted as displayed systems, not as process tools.

| ID | System | Source reference | Source counts | Phase |
|---|---|---|---|---|
| S12 | Airlock billboard zh/en re-render | [original-facility-architecture.ts:668-680](../../../web_app/src/original-facility-architecture.ts#L668-L680) | 2 billboards | P7 (labels/language) |
| S14 | Vortex air-shower particles (frozen timing data only; not drawn by Next either) | [personnel-timeline.ts:199-206,519-536](../../../web_app/src/personnel-timeline.ts#L199-L536) | 70 particles | P7 |
| S16 | Roof HVAC: slab, 4 parapets, 3 MAUs, 3 mains, 3 feeders, 12 drops, 5 stacks, 70 exhaust particles, 3 labels | [original-roof-hvac.ts:55-159,232+](../../../web_app/src/original-roof-hvac.ts#L55-L232) | ~51 meshes + 70 particles | P7 |
| S17 | Personnel: 5 staff + 1 patrol, behaviour tree, tablets, patrol status billboard 512x128 | [procedural-fab.ts:26-184](../../../web_app/src/procedural-fab.ts#L26-L184); [personnel-timeline.ts:96-163](../../../web_app/src/personnel-timeline.ts#L96-L163); [original-patrol-status.ts:24-85](../../../web_app/src/original-patrol-status.ts#L24-L85) | 6 actors | P6 |
| S18 | AMHS/OHT: 2 loops, 24 vehicles, rails/supports, hoist/FOUP/cables/LEDs/decals, traffic stats | [legacy-site.ts:32-302](../../../web_app/src/legacy-site.ts#L32-L302); [amhs-timeline.ts:30-347](../../../web_app/src/amhs-timeline.ts#L30-L347) | 24 vehicles, 14 stations | P6 |
| S19 | Airflow 1 500 laminar sprites + 1024x768 heatmap | [aerodynamics.ts:16-102](../../../web_app/src/aerodynamics.ts#L16-L102); [airflow-texture.ts:3-163](../../../web_app/src/airflow-texture.ts#L3-L163); [cleanroom-pressure.ts:2-42](../../../web_app/src/cleanroom-pressure.ts#L2-L42) | 1 500 sprites, 94x70 plane | P7 |
| S20 | Exploded interconnects: 12 conduits + 12 pulse rings + easing | [original-exploded-links.ts:17-71](../../../web_app/src/original-exploded-links.ts#L17-L71); [original-exploded-link-data.ts:16-41](../../../web_app/src/original-exploded-link-data.ts#L16-L41) | 12 + 12 | P8 |
| S21 | X-Ray hologram: single WGSL program, 6 filters, 4 roles | [xray-hologram.ts:14-15,49-201](../../../web_app/src/xray-hologram.ts#L14-L201); [legacy-site.ts:449-524](../../../web_app/src/legacy-site.ts#L449-L524) | 6 filters | P8 |
| S22 | Cut plane XYZ + invert | [babylon-webgpu.ts:560-579](../../../web_app/src/babylon-webgpu.ts#L560-L579) | 3 axes | P8 |
| S23 | Wafer-follow marker/flange/door + trail + HUD | [babylon-webgpu.ts:187-215,534-546](../../../web_app/src/babylon-webgpu.ts#L187-L546); [tour-wafer-timeline.ts:495-1034](../../../web_app/src/tour-wafer-timeline.ts#L495-L1034); [wafer-map.ts:1-132](../../../web_app/src/wafer-map.ts#L1-L132) | 3 products, 7 defect patterns, 5 bins | P9 |
| S24 | Cinematic tour: 5 waypoints (4 L1 + 1 B1), 60 Hz timeline, HUD | [original-tour.ts:3-104](../../../web_app/src/original-tour.ts#L3-L104); [tour-scenario.ts:5-40](../../../web_app/src/tour-scenario.ts#L5-L40); [tour-wafer-timeline.ts:167-392](../../../web_app/src/tour-wafer-timeline.ts#L167-L392) | 5 stops | P9 |
| S25 | MES/SPC/YMS HUD: MES actions, SPC, YMS map/yield tabs, 8 yield scenarios, STDF, 3 yield models | [process-control.ts:3-247](../../../web_app/src/process-control.ts#L3-L247); [wafer-map.ts:51-132](../../../web_app/src/wafer-map.ts#L51-L132); [fab-yield.ts:49-144](../../../web_app/src/fab-yield.ts#L49-L144); [twin-page.tsx:13-24,312-317,702](../../../web_app/src/twin-page.tsx#L13-L317) | 3 MES actions, 2 tabs, 8 scenarios | P9 |

## 7. Facility restoration count verification

Expected counts from the task: facility **parts 1 659 / meshes 274 / instances 1 386 / 2 air showers
with lights / ceiling hidden by default**; static structure **parts 1 648 / batches 396 / 10 lights**;
equipment **121 tools / 51 batches / 936 instances**.

Derivation of the facility counts from the source builder (arithmetic on
[original-facility-architecture.ts](../../../web_app/src/original-facility-architecture.ts) and
`ORIGINAL_FACILITY_COUNTS` [136-145](../../../web_app/src/original-facility-architecture.ts#L136-L145)):

```
air showers: 2 plenum + 1 top + 18 nozzles + 2 doors + 2 windows + 2 indicators
            + 1 HMI + 1 HMI screen + 4 jets = 33 per chamber; x2 = 66
sticky mats: 6 x (frame, surface, tab, mark) = 24
ceiling:     1 deck + 1386 FFU units + 8 fixtures + 8 lenses
            + 10 trusses + 100 braces + 50 drop rods + 3 trays + 3 cables = 1569
total parts: 66 + 24 + 1569 = 1659
mesh objects: 1659 - 1386 FFU thin instances + 1 FFU batch mesh = 274
instances:   1386 (FFU thin instances only)
```

The typed Lite copy `ORIGINAL_FACILITY_COUNTS` in
[facility-layout.ts:105-114](../../../web_app/src/render/lite/geometry/facility-layout.ts#L105-L114)
reproduces the frozen source constants (ffuUnits 1386, lightAisles 8, trusses 10, braces 100,
dropRods 50, cableTrays 3, airShowers 2, stickyMats 6) and the label recipe; the source builder and the
Lite layout module therefore agree on the expected counts used by the test and by inventory.json.

Verification run in this session against the final revision (PowerShell from the repo root):

```powershell
cd web_app
npx vitest run tests/lite-facility.test.ts tests/lite-static-structure.test.ts
# PASS: 2 files, 7 tests — facility 1 (every source part matched at exact source bounds;
# airlocks at (12,34) and (-16.5,3); ceiling.visible false by default; lights 2)
# static structure 6 (1648 parts, B1/FFU independence, 10 lights, material inputs, texture cleanup)

npx vitest run tests/lite-lighting.test.ts tests/lite-shadow.test.ts tests/lite-equipment.test.ts tests/lite-runtime.test.ts
# PASS: 4 files, 34 tests (lighting 3, shadow 2, equipment 4, runtime 25)

npx tsc --noEmit
# PASS (exit 0)
```

Cross-check against the final canonical GPU acceptance JSON (owned by the GPU acceptance teammate;
`.local/lite-acceptance-final/lite-lighting.json` and `lite-static.json`: both PASS, `errors: []`):

| Check | Expected | Observed (final) |
|---|---|---|
| equipment tools / batches / instances | 121 / 51 / 936 | 121 / 51 / 936 |
| facility parts / meshes / instances | 1 659 / 274 / 1 386 | 1 659 / 274 / 1 386 |
| facility air showers / lights / ceiling visible | 2 / 2 / false | 2 / 2 / false |
| static structure parts / batches / lights | 1 648 / 396 / 10 | 1 648 / 396 / 10 |
| structure airshowerVisible (all views) | false | false |
| structure layers.ffu.visible (all views) | false | false |
| scene meshes = 396 + 51 + 274 | 721 | 721 (final drawCalls 722) |
| shadow casters / key intensity / local lights | 195 / 1.15 / 18 | 195 / 1.15 / 18 |
| CSM textures / recoveries | 2048 depth32float x2 cascades, static cache; 3 losses | same; 3 recoveries, 0 errors |
| layout projection max error (121 tools + 56 yellow) | < 0.1 px | 2.514e-05 px (ISO/TOP/L1/B1/DUAL) |

## 8. Remaining differences and unverified items

R01 and R02 were fixed in the final revision and are removed from the remaining list (see
inventory.json `resolvedDifferences`):

- **R01 fixed**: frozen `airshower-*` batches are parented to a hidden `static-source-disabled` root
  ([static-structure.ts:67-70,160-164](../../../web_app/src/render/lite/geometry/static-structure.ts#L67-L164)),
  matching `legacy-site.ts:406-407`; final suites assert `structure.airshowerVisible === false` in every view.
- **R02 fixed**: the procedural `ffu` ceiling layer stays source-disabled and FFU view maps to the
  restored original facility ceiling only
  ([lite-runtime/main.ts:171-176](../../../web_app/tests/lite-runtime/main.ts#L171-L176)), matching
  `legacy-site.ts:412`; final suites assert `structure.layers.ffu.visible === false` in every view.

The increment is still **not** parity. Remaining differences (full detail in inventory.json
`remainingDifferences`):

1. Airlock billboards are zh-only (source supports zh/en re-render, P7).
2. Air-shower purge animation is implemented but has no unit/pixel assertion in this increment.
3. Cross-engine pixel delta includes deferred scene content (AMHS, roof/HVAC, personnel, HUD state), so it
   cannot be attributed to lighting alone.
4. HUD/sidebar differ by design: Next is a product page; final Lite captures hide DOM chrome and the
   comparison ROI excludes the sidebar/top HUD.
5. Per-tool status state mapping and down-state pulse not restored (P9).
6. Material/transmission/IBL exactness not pixel-verified (zero-radiance HDR only satisfies Lite
   transmission; no IBL/sky/ground added).
7. Product `/twin` still runs the legacy renderer; Lite is a test-only preview (P3).
8. No 60-minute soak, cross-browser matrix or performance A/B.

Explicitly unverified (must not be reported as PASS):

- Pixel/Golden parity against the frozen original Three.js page `b3666132`.
- Exact BRDF/specular/transmission/anisotropy/gamma for every material.
- Airlock animation and label language switching.
- Product backend/picking/HUD/status-source integration.
- All DEFERRED rows (P3, P6–P9), including pixel/Golden parity of those dynamic systems.

## 9. Evidence and reproduction

- Machine-readable inventory: [inventory.json](evidence/lighting-shadows-facility-2026-10-26/inventory.json)
  (counts, 70+ file hashes, source references, 34 systems, resolved and remaining differences,
  implementation-boundary audit).
- Lighting/shadow/facility evidence package (README draft, comparison.json, before/after PNGs):
  [evidence/lighting-shadows-facility-2026-10-26/README.md](evidence/lighting-shadows-facility-2026-10-26/README.md).
- Final canonical GPU acceptance (owned by the GPU acceptance teammate, Chrome 155 / NVidia Ampere,
  1536x735, real WebGPU, DOM chrome hidden): `.local/lite-acceptance-final/lite-lighting.json`,
  `lite-shadow.json`, `lite-static.json`, `lite-layout.json`, `lite-equipment.json`, `lite.json` — all
  PASS, `errors: []`. Commands:
  `node tools/run_twin_browser.mjs <suite> 9496 http://127.0.0.1:5175 <output.json>` with
  `LITE_EVIDENCE_DIR=.local/lite-acceptance-final`.
- Pixel comparison recomputation:
  `python .local/evidence-tools/compare_lighting_final_2026_10_26.py <repo-root> <out.json> [resized-ref.png]`
  (Pillow 12.3.0; method and ROIs recorded in comparison.json).
- Counts/tests: `cd web_app; npx vitest run tests/lite-facility.test.ts tests/lite-static-structure.test.ts`.

