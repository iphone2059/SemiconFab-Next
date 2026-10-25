# Twin parity baseline

Updated: 2026-10-26. Status: **IMPLEMENTING / NOT PARITY_VERIFIED**.

The user selected the final construction loaded by `../SemiconFab/twin.html`, with `?layout=/twin/layout-default.json&mode=engineer`. The frozen original is `jinjiefan2020/SemiconFab@b3666132e5d8cab2cebe4c4227fc04c52242eb28`. Next started this increment at `060957d`. Original source bytes are unchanged; hashes and inputs are in [source-manifest.json](source-manifest.json). See [attribution.md](attribution.md) for original PolyForm and icon notices.

## Product boundary

There is one single-FAB 3D page, `/twin` (`/twin.html` compatible). The independent preview page/component and embedded home canvas have been deleted. Old `/preview` and `/preview.html` URLs canonicalize to `/twin`, retaining parameters. The workbench has an ordinary new-tab **3D FAB** link. Rendering remains Babylon `WebGPUEngine` only, with native WebGPU depth shadows and no WebGL fallback, Three renderer, iframe renderer, glTF/GLB asset or loader dependency. A measured headless performance baseline and its explicit limitations are in [performance-baseline.md](performance-baseline.md).

## Machine/source evidence

- Final original layout: **117 draft instances of eight parameterized families plus four catalog boxes**, not 121 unique detailed manufacturer CAD models. No extra invented machine geometry is used to make the original appear more detailed.
- Tests compare all 121 record/instance identities, positions, rotations, rendered bounds, family vertices/colours and catalog part materials/wire edges against the independently captured original fixture. Nominal label dimensions remain separate from rendered geometry.
- Original floor canvas recipes/repeat factors, nine L1 zone planes, 24 ten-metre columns, 55 always-visible amber FFU panels, light strips and curtains are now ported. The amber ceiling is independent of the optional general FFU layer.
- Original legacy light attenuation and **LinearEncoding / NoToneMapping** are reproduced with WGSL material patches. Actual GPU shader inspection confirmed the range patch; Babylon's unconditional gamma conversion is bypassed for these original PBR surfaces. Remaining scene/transparent-material differences must still be judged in paired images.

## Inventory and reproducible comparison

[controls.csv](controls.csv) retains all **263 raw ID attributes (260 unique)** including duplicates/template IDs, plus two DOM-property IDs. [functions.csv](functions.csv) retains **218 named functions**. Counts are source inventory, not runtime acceptance. Run `python tools/build_twin_inventory.py --check` against the frozen original.

`tests/twin-goldens.browser.ts` captures ISO/Top/Litho/B1/Cut/X-Ray/Research/Wafer/MES/SPC/YMS with a declared seed and virtual animation clock. The original is served read-only by `tools/serve_twin_reference.py`; the capture-only injected seed/clock is declared in the HTML. Product source contains no capture hooks. Both pages use 1536×735 CSS pixels, DPR 2, Chinese. Each PNG has its DOM boxes, fonts, colours, disabled states and interactive control inventory in adjacent JSON.

See [evidence/golden](evidence/golden) and its `comparison.json`. The comparison uses unaligned RGB differences and 11×11 Gaussian luminance SSIM (sigma 1.5). Full-frame and common-scene ROI scores are both retained; the ROI cannot replace the full-frame result. **These are candidate baselines exposing differences**: the demo random streams/initialization order and complete HUD are not yet equivalent, no visual threshold has been approved, and no screenshot is marked accepted. Video, complete state/event coverage, blind review and browser matrix remain open.

## Audit of the 14 requested items

| Priority / item | Current implementation and evidence | Acceptance still open |
| --- | --- | --- |
| P0 1. Inventory + Golden | Source ledgers, immutable hashes, paired state PNG/DOM JSON and SSIM tooling | Every control/function/event mapping; full state/tooltip/disabled/video inventory; calibrated thresholds, blind review and browser matrix |
| P0 2. Page/HUD | Original main regions; 12px normalized micro-text; captured SVG controls; shared zh/en locale; 18-row reference sidebar and 116-row in-page OEM tab; reference inspector with CAD elevation/provenance/telemetry/MES/SPC; roof/HVAC, airlocks, tacky mats, FFU ceiling grid, patrol focus, grid/footer and process legend | Remaining full modal depth, en-US/zh-CN label/tooltip equivalence, exact responsive rules and calibrated pixel diff |
| P0 3. Unified modes | One SpatialMode; reducer owns spatial and Tour/Wafer/Research/Onboarding; focused-select Esc exits Tour; original tour positions/durations; Aero pressure/1500 sprites | Original visible/disabled control comparison and complete Aero facility/animation matching |
| P0 4. GPU/failure | Real shadow/cut pixels, depth restoration and GPUDevice.destroy recovery; completed-frame/validation gate; preserves manual camera | Instrumented 60-minute run, frame-time/memory records, repeated failure matrix and all mode combinations |
| P1 5. B01 | DEMO Scenario, Play/Pause, 1600ms tick, per-instance four-state override; towers/counts/inspector derive one authority | Original random-stream/telemetry sequence, list/KPI exactness; backend commands remain separate |
| P1 6. Research | 27,263 rows; original winning aliases; per-machine states; entering/re-entering replay freezes current DEMO/SSE state | Replay Golden acceptance; no AMHS events exist in JSONL, so AMHS stats are explicitly independent animation |
| P1 7. X-Ray | System filters, ghost restoration and Cut/level mutual exclusion | Single WGSL hologram program covers equipment/floor/subfab/OHT/catalog wire surfaces (no fallback path) with native shadow sampling, six-filter/B1+UPW/AMHS, exact material/visibility restore and stable shadow cache measured in the browser; only matched-Golden rendering against the frozen original remains open |
| P1 8. Facilities/dynamics | Dual OHT/24 cars, personnel, amber ceiling/floor/columns, pressure/laminar display, utility headers/pump stations, original 85×60 m roof/HVAC slab, 3 MAUs, mains/feeders/drops, 5 stacks, 70 exhaust billboards, two source air showers, six tacky mats, 1569-mesh FFU ceiling and the 793-mesh B1 industrial layer | Outer-wall/CAD architecture gaps, exact personnel/airlock/OHT timing and visuals |
| P1 9. Wafer | A/B/C 120/104/92 steps, seek/play/pause, 1×/4×/16×, camera/trail | Original Bay/final wording and fixed-time seek/speed Golden vectors |
| P1 10. MES/SPC | Existing local MES actions and SPC; explicit local demonstration boundary | Original inspector layout and sample vectors; no backend production persistence claimed |
| P1 11. YMS/Yield | Existing Wafer Map/STDF and yield models; literal scenario overrides resolve exact IDs only | Obsolete fe.* IDs stay unresolved; source bay-group math/jitter/cycle adjustment and model Golden vectors |
| P2 12. Locale/theme | Original font normalization and language storage keys; URL/refresh persistence; translated process search tested | All technical strings/tooltips in en-US/zh-CN and storage/URL persistence; frozen original twin page has no theme control (see 2026-10-25 scope note) |
| P2 13. Modals/notices | Original code/data and Lucide/Feather notices retained | Original architecture/source/related-page modal flows |
| P2 14. Release | Updated feature map, regression suites, evidence and source review | Full accessibility/mobile/cross-browser/performance/release audit; no parity release tag |

## Exact data boundaries and compatibility exceptions

1. **Instance identity:** 121 stable `FAB-01/tool-NNN` IDs differ from record UUIDs, which repeat. [layout-identities.json](layout-identities.json) records both.
2. **Original alias collisions:** packaging shares TG01_LITHO, test shares TG16_MET_CD. Source inserts catalog aliases before draft-family groups; its last writer wins. Thirty-two layout rows participate in collisions. [replay-map.csv](replay-map.csv) maps **94 of 217 simulation machines** to the source-winning instance. No one-to-one mapping is invented. Unmapped instances retain the current session's pre-replay state.
3. **Authority:** SSE updates only its live cache. DEMO and Research derive rendered states independently; late SSE cannot overwrite them. DEMO/MES/SPC are local demonstrations, not backend commands or durable production models.
4. **SPC compatibility:** existing constants for insufficient sample data remain for demonstration compatibility. They are not measured production capability; precise source vectors and UI annotation remain to be accepted.
5. **Scenarios:** source fe.* overrides absent from the selected 121-tool layout are disclosed as unresolved. Category-wide DOWN substitution has been removed.
6. **Aerodynamics:** original pressure-field branch order (including Litho/airlock overlap), drift and nominal per-frame motion remain. Obstacles use the final 121-tool layout; original builds its old obstacle list before async replacement. This deliberate delta is not particle-exact parity.

## 2026-10-25 state and process continuation

The current increment is integrated on `main`; other local/remote branches were
deleted after verifying their commits were included. Application state now also
owns viewer status/reload/hover, wafer progress/point/trail, import request
identity/hydration, pending submission idempotency and the shared language/theme.
DOM/GPU handles and derived scene caches remain runtime objects; React's error
capture latch is the sole component-local state required by its boundary API.

`tools/build_twin_process_vectors.cjs --check` executes extracted frozen-source
functions only in a test VM. Checked-in process fixtures cover all source sensor
categories, directory/recipe ticks, MES actions and slot wrap, SPC edge cases,
six Scenarios and every die/bin/STDF field of seven defect patterns. The DEMO
clock consumes telemetry noise first, optional third-cycle Andon mutation second,
and eight yield jitter inputs last. Inspectors read its live cached telemetry;
Scenario WPM retains `etch_down` even when the Yield panel is in LIVE mode.
These are process vectors with explicit input, not equivalence to the original
scene's global random initialization or an assertion of backend persistence.

`evidence/state-management-2026-10-25.json` records actual Chrome/Windows dev
browser checks: StrictMode deep-link hydration, clock/FDC update and pause,
wafer speed/product/seek, and a completed real GPUDevice replacement with zero
validation errors, unchanged camera, and 16,384 bytes of readback. Recovery took
4,380 ms. An earlier capture exceeded its 3-second transport deadline but the UI
also visibly recovered; this is not a complete repeated-loss matrix. Current
frontend verification at that increment was 138/138 Vitest, TypeScript and Vite build. Full Golden,
en-US/zh-CN/responsive styling, exact dynamics, production-bundle and
60-minute acceptance are user-deferred for this iteration (see 2026-10-25 decision) and remain open
release gates. Status stays **NOT PARITY_VERIFIED**.

The subsequent [dead-code cleanup](../dead-code-cleanup-2026-10-25.md) retires four
tests for removed implementations and validates the active RTK transport;
after the 2026-10-25 locale fix and parity increments the latest frontend verification is **183/183**, strict unused checks and build pass.

## 2026-10-25 locale scope and next phases

User instruction on 2026-10-25 restricts the twin locale target to **en-US and zh-CN**;
nine-language coverage is withdrawn. Canonical URL, `documentElement.lang` and
`semiconfab_lang` values are now the locale tags, while `semicon_lang` keeps the legacy
`zh`/`en` mirror and old `en`/`zh` URL values keep working. The catalog page no longer
misreads `?lang=en-US` as Chinese because it reuses the same resolver. Latest frontend
verification: **183/183 Vitest**, TypeScript and Vite build pass.

The frozen original's twin page has no theme toggle: `twin.html` only carries
`meta[name=theme-color]` and four inert `dark:` utility classes in a decorative control;
the shared `js/i18n.js` `#theme-label` path serves other site pages. Parity therefore means the
original light-only Twin styling, not a new control. Remaining work is staged in
[2026-10-25-remaining-parity-phases.md](../../superpowers/plans/2026-10-25-remaining-parity-phases.md):
source-exact dynamic timing vectors, Exploded hierarchy/guide lines and a WebGPU-shader X-Ray hologram,
en-US/zh-CN copy/tooltips and responsive rules, then full Golden, control matrix, production-bundle,
60-minute and repeated device-loss acceptance (user-deferred in this iteration; open gates).
Full-scene random initialization is still not
equivalent and remains an explicit Phase D gate.

### 2026-10-25 AMHS timing vectors

The first Phase A artifact is in. `tools/build_twin_dynamics_vectors.cjs` executes the frozen
`updateAmhsSimulation` / `setVehicleLedColor` source in a `node:vm` with a declared seed and writes
`web_app/tests/fixtures/original-dynamics-vectors.json`: 32 generated tasks, 14 completed deliveries,
548 discrete transition events and 121 sampled frames over a declared 120 s scenario, with the
source SHA and function line ranges recorded in the fixture. `web_app/src/amhs-timeline.ts`
reproduces that trace exactly (stats, every event and every sampled frame) and the vector test
passes; the declared scenario proves the port, not the original fleet's long-run distribution. The
renderer still uses the previous AMHS approximation until the Phase A integration step, so no visual
parity follows from this artifact.

Renderer integration followed in the same increment. `legacy-site.ts` advances the controller on the
scene tick, maps arc length, hoist, dual-cable, FOUP and LED outputs onto the OHT meshes and feeds the
AMHS HUD; the original FOUP-below-gripper hierarchy and cables are restored. The frozen page used
unseeded `Math.random`, while Next uses the declared seed 42 so the stream is reproducible. Local
browser evidence (Headless Chrome 155, WebGPU adapter available, 1600×900 DPR 1, dev server):
`AMHS OHT` active vehicles rose 00→06/24 within ~12 s with zero console errors or exceptions, and the
Twin UI acceptance suite passes including a new live AMHS-HUD assertion. This is runtime integration
evidence only: personnel/air-shower/tour/wafer vectors, Golden keyframes and visual parity remain open.

The WebGPU X-Ray hologram also landed in this increment as a single WGSL program shared by triangle
surfaces and the catalog wire meshes (`LineListDrawMode`). `web_app/src/xray-hologram.ts` renders
Fresnel rim, scanline modulation, cyan ghost tint and the filter-highlight branch; triangle meshes are
swapped onto palette ShaderMaterial instances and their original material references restored, while
wire meshes keep the same program permanently and switch uniforms between normal amber lines and
X-Ray cyan lines. OHT is part of the same shader path; no alpha/colour mutation side path remains.
Subfab filters highlight matching piping and ghost the rest instead of hiding meshes. Local Headless
Chrome 155 WebGPU evidence: all six filters activate, B1+UPW renders the highlighted subfab hologram,
AMHS highlights the OHT track, switching X-Ray off restores the normal scene, and the run produced
zero console warnings/errors, JS/GPU exceptions or WGSL compilation messages.

The single program now also samples the native static shadow depth pass: the depth texture and light
matrix are bound into the hologram shader with a 3×3 compare PCF, and X-Ray surfaces keep casting into
the same pass through a shared caster flag, so ghosts darken under the source key light. The committed
`web_app/tests/xray-acceptance.browser.ts` measured: 2,236 X-Ray surfaces on the single program; bound
shadow texture and matrix equal to the native pass; shadow-on vs shadow-off pixel delta mean 9.25 vs
0.19 animation control; all six filters; exact material-reference and scene-visibility restore; caster
count restored 771→771; shadow cache stable after restore; zero device/console errors. The native
static-shadow acceptance test was corrected to exercise visibility invalidation on the shell layer
(the optional ceiling is not a static caster by design); it passes with 771 casters and 79,280
darkened pixels. Remaining: matched-Golden comparison against the frozen original (Phase D1), not an
implementation gap.

### 2026-10-25 personnel and air-shower timing vectors

`tools/build_twin_personnel_vectors.cjs` executes the frozen patrol behavior tree,
`createBunnySuitOperator`/`buildCleanroomPersonnel`, both air-shower chambers, vortex particles and
the two anonymous `animate()` blocks (breathing and the 12 s standby cycle) in `node:vm` with a
declared 16 ms frame clock and LCG seed 42; source SHA and every line range are asserted and the
`--check` gate is wired into `scripts/verify.ps1`. The 813 KB fixture
`web_app/tests/fixtures/original-personnel-vectors.json` declares 6 actors, the six-phase patrol trace
(purge 282 ticks = 4.512 s; phase ticks 366/104/282/254/2022/472), 27 as-built and 46 preserved events,
176 sampled frames per mode, purge/vortex samples and zh/en status text.
`web_app/src/personnel-timeline.ts` is a pure clock-injected port (no DOM/THREE/Date.now/Math.random)
and `web_app/tests/personnel-timeline.test.ts` reproduces both declared modes exactly (9 tests).

Encoded parity findings: the frozen builders overwrite `userData`, so as-built limb, status-board,
tablet-screen and air-shower material animation references are dropped and the chamber purge timer
becomes NaN; the `preserved` mode re-attaches the constructor outputs without adding math so the frozen
animation vectors stay testable. The frozen `PATROL_WAYPOINTS` never resets `stateTimer` on arrival and
every travel leg exceeds the inspect duration, so no inspect/countdown frame is observable. The
controller is now wired into the renderer (see the next section); visual keyframe acceptance remains
open.

### 2026-10-25 C2 frozen copy, personnel keyframes and exploded source verification

C2 replacement: `tools/build_twin_translations.cjs` emits `web_app/src/twin-translations.generated.ts`
from the frozen en/zh inventory (308 pairs -> 281 unique zh entries, 9 genuine source collisions, only
en/zh bytes serialized) and `tools/audit_twin_i18n_coverage.mjs` scans all `web_app/src` twin copy
(178 literal `t()` pairs, 0 English contradictions, 0 missing English, 41 documented Next-only catalog
labels). `twin-i18n.tsx` merges the generated map with frozen-wins precedence, so the three legacy
labels that differed (`爆炸解构` Explode, `气流热力图` Heatmap, `开放软件架构` Open Architecture) now
match the source; a unit test pins the precedence and the Twin UI browser acceptance still passes.
Both tools are in `scripts/verify.ps1` as drift gates.

Personnel renderer keyframes: `web_app/tests/personnel-keyframes.browser.ts` samples the live Babylon
scene against the single frozen `PersonnelFrame` and compares six actor positions/rotations, patrol
limb pivots, patrol tablet screen colors, the as-built status billboard parent/visibility and both air
showers (indicator color/intensity, jet opacity/scale, inner light, billboard height). The production
build run recorded **43 samples, 5 keyframes** (approach, airlock entry, purge, airlock exit,
PATROL_WAYPOINTS), **0 mapping mismatches, 0 console/device errors**. As in the frozen runtime the
as-built `userData` overwrite leaves air-shower jets closed (`jetMax = 0`); the page mirrors that
instead of inventing a purge animation. Evidence:
[evidence/personnel-keyframes-2026-10-25.json](evidence/personnel-keyframes-2026-10-25.json) and the
five adjacent PNGs.

Exploded source verification: `tools/build_twin_exploded_links.cjs` executes the frozen
`FAB_EQUIPMENT` table (lines 5061-7482, 69 records), derives the 12 B1->L1 pairs with the source
conduit-color map and writes `web_app/tests/fixtures/original-exploded-links.json`; the link-data unit
test now compares row-for-row (sub/host ids, svg types, coordinates, colors) and `--check` is a gate.

**Matched-Golden capture is in progress** for all prior cases plus the new dual/exploded 0-50-100/
patrol/purge/tour/en views; results and the SSIM/ROI report will be recorded after capture. Per the
user's 2026-10-25 decision the 60-minute soak and repeated device-loss matrix are not executed in this
iteration and remain open release gates.

### 2026-10-25 frozen Tour and Wafer fixed-time vectors

`tools/build_twin_motion_vectors.cjs` executes character-exact frozen Tour/Wafer slices in a
`node:vm` with a declared deterministic event loop (16 ms RAF grid, 100 ms tour countdown interval,
`performance.now` clock, ordered timer queue) and pins the source SHA, every line range and the
`benchmark/routes.json` + `twin/layout-default.json` hashes. Tour fixture: 5 source waypoints
(tween 2200/2000/2000/2000/2200 ms, hold 5000 ms, L1×4 + B1), 849 sampled frames and 378 events over
54,216 ms including two starts, user stop, three next/two prev and auto-stop. Wafer fixture: the full
pinned routes are 120/104/92 steps; five declared 5-step-prefix traces (364 frames, 77 events) cover
1x (10,000 ms completion), 4x (2,560 ms), 16x (640 ms), play/pause/replay/speed/product-change and the
frozen 0.1 s dt clamp, with the 30-point trail cap exercised. `web_app/src/tour-wafer-timeline.ts` is
a zero-import pure controller (`createTourTimeline`, `createWaferTimeline`) and the 11 exact-replay
tests are wired as a `--check` drift gate. The frozen source has **no seek/scrub**: fast-forward is
`setWaferSpeed` scaling `dur = 2.0 / speed`, reset is `replayWaferRoute`/product change, and Tour
advances via next/prev plus timer callbacks — recorded, not invented. Stub boundaries (virtual
scheduler, 5-step route prefix, guarded tour/wafer mutual exclusion, en HUD text) are declared in the
fixture. Renderer wiring against these controllers remains open.

### 2026-10-25 Tour renderer wired to the frozen controller

The Cinematic Tour now consumes `createTourTimeline` instead of independent React timers.
`web_app/src/tour-scenario.ts` maps the frozen `CINEMATIC_WAYPOINTS` literal onto the controller
scenario and a unit test compares it field-for-field with the frozen fixture (5 waypoints, tween
2200/2000/2000/2000/2200 ms, 5000 ms holds, L1×4 + B1, English/zh HUD locales). `twin-page.tsx`
starts from the **current** camera pose (`getCameraPose` added through the scene facade), advances the
controller each composited frame with wall-clock catch-up (the pure controller ticks on a 60 Hz grid;
8-frame catch-up cap), applies `frame.camera`/`frame.target` per frame, mirrors the frozen
`tour-hud-tag`/`tour-hud-timer`/`tour-progress-bar`/`tour-dot-N` HUD and keeps the source dots
non-clickable. Next/prev and skip drive `controller.next/prev/stop`.

A scheduler defect surfaced during wiring: floating-point frame boundaries could make a rescheduled
RAF due exactly at `clockMs`, so `advanceTo` processed it forever inside one step and froze the page
(~1 s after tour start). `scheduleRaf` now guarantees a strictly future due and the frozen-vector
tests plus a 2,000-step smoke run stay green.

Browser acceptance (production build, 93 in-page samples): first waypoint tag and `5s` countdown,
frozen waypoint-1 camera `(70,50,75)`/target origin, auto-advance to waypoint 2 at **7.10 s**
(source 2.2 s tween + 5 s hold), countdown 5s→1s, progress 100%→90%, exactly one active dot, dots do
not jump, next/prev work, skip closes the HUD; 0 console/device errors. A fresh matched-Golden tour
capture improved from **44.6%/45.4%** to **71.4%/77.4%** SSIM (full/ROI vs the frozen original).
Wafer renderer wiring remains open.

### 2026-10-25 matched Golden refresh (19 cases)

A fresh paired capture now exists for every prior case plus dual / exploded 0-50-100 / patrol /
patrol-purge / tour / English HUD, using the declared virtual clock on both the frozen original and
Next (1536x735 DPR2, 180+180 frames per case, 19/19 captured, 0 console errors). The honest result is
**appearance is not yet matched**: full-frame SSIM ranges **50.0%-73.7%** and scene-ROI SSIM
**52.0%-80.1%** after the Tour wiring (Tour improved 44.6%/45.4% → 71.4%/77.4%). Best: cut 73.7%/80.1%;
exploded 67.5%-70.0%; personnel/ISO 69.2%; English HUD 69.3%; worst: wafer 50.0%/52.0%, B1 56.6%/60.0%,
dual 59.9%/63.3%. The visual diffs show remaining HUD
chrome/typography/layout, camera framing, rail/status-bar composition, exploded-panel styling and
depth/shadow contrast differences. Evidence and the full table:
[evidence/golden-2026-10-25b/README.md](evidence/golden-2026-10-25b/README.md) (+ comparison.json and
10 representative JPEG pairs). Thresholds stay unapproved; status remains **NOT PARITY_VERIFIED** and
visual matching is the next working target (worst cases first). The capture runs both sides under the
declared virtual clock; original real-time timers are only approximated, so no real-time equivalence
claim follows.

### 2026-10-25 en-US/zh-CN twin string inventory

`tools/build_twin_i18n_vectors.cjs` pins `twin.html`, `js/translations.js` and `js/i18n.js` against
the source manifest, executes the dictionary in `node:vm` and serializes only `en`/`zh-CN` bytes into
`web_app/assets/original-twin-i18n.json` (other locales are recorded as excluded, never serialized).
The fixture resolves 132 static keys from 133 `data-i18n*` references (105 body, 26 title, 2
placeholder; the frozen dictionary lacks `nav_lang_toggle`), extracts 176 dynamic zh/en pairs plus 6
documented missing strings (1 dictionary key and 5 Chinese-only toast messages) and records 16 skipped
non-literal branches in `web_app/tests/original-twin-i18n.test.ts` (6 tests, source hashes and coverage
asserted). The `--check` gate is wired into `scripts/verify.ps1`.

### 2026-10-25 personnel renderer wiring and exploded hierarchy

The repair-files iteration-2 bundle ([TWIN_PARITY_REPAIR_NOTES_2026-10-25.md](../../repair/TWIN_PARITY_REPAIR_NOTES_2026-10-25.md))
was integrated on top of `6e4cf16` and verified locally. Fixes applied during integration:
(1) `babylon-webgpu.ts` now forwards the explicit `modeActive` flag to the legacy runtime, so a 0%
exploded slider keeps the mode instead of leaving it; (2) `twin-page.tsx` follows source
activate/deactivate semantics (entering Exploded resets the preset to 100%, leaving resets it to 0%,
level switches close the mode) and owns level camera poses; (3) `native-shadow-material.ts` declares
the `FABNATIVEDEPTHSHADOW` define so a non-plugin PBR material cannot share a shadow-patched effect and
emit WebGPU validation errors when new layers appear.

Personnel: `procedural-fab.ts` consumes `createPersonnelTimeline` (six source actors, patrol
limb/tablet/screen pose, overhead as-built status billboard via `original-patrol-status.ts`);
`original-facility-architecture.ts` consumes the same frames for air-shower indicators/jets/inner
lights/labels and disables its independent timekeeper; `legacy-site.ts` steps a fixed 16 ms source
clock with bounded catch-up. As-built visible behaviour keeps the frozen initial billboard status.

Exploded: source 0.08/frame easing, ceiling +20 m, subfab −18 m, level floor opacity
L1=1 / B1=0.2 / DUAL=0.35 / EXPLODED=0.55, 12 reference B1→L1 conduits (source radius/height/torus/ring
sinusoid, stable phases, excluded from static casters) and page-owned entry/exit/level camera poses.

Acceptance evidence (production Vite bundle served with an `/api` proxy, Headless Chrome 155,
WebGPU, 1600×900 DPR 1): `web_app/tests/twin-exploded.browser.ts` passed with 121 tool identities
unchanged; 12 links; ceiling/subfab 20/−18 at 100% and 10/−9 at 50%; 0% keeps the mode and entry
camera; floor alpha 0.55/0.2/0.35/1 across EXPLODED/B1/DUAL/L1; caster count 771→970→771; shadow cache
settled at 95 passes; X-Ray during exploded kept 2,236 shader surfaces and restored floor alpha 0.55;
patrol actor moved 1.66 m on the source timeline; 0 console/device errors. Evidence:
[evidence/twin-exploded-acceptance-2026-10-25.json](evidence/twin-exploded-acceptance-2026-10-25.json)
plus the adjacent exploded/restored PNGs. Latest frontend verification: **163/163 Vitest**, TypeScript
and Vite build pass; the native-shadow and X-Ray acceptance suites also still pass. This is runtime
acceptance, not a matched Golden SSIM comparison against the frozen original; source-exact visual
parity remains open.

## 2026-10-26 Wafer renderer and targeted Golden repairs

Wafer now consumes `createWaferTimeline` for full A/B/C routes, source position/tangent rotation,
camera offset, bounded additive trail, HUD and completion/replay. Opening/product changes auto-play;
pause retains the interpolated pose. Seek and the duplicate Redux integrator are removed. Close/reopen,
speed/follow/locale changes and Tour exclusion retain the controller lifecycle. Fixed invisible FOUP,
per-frame trail reconstruction, stale replay completion bookkeeping, and Tour RAF surviving Escape.

B1/Dual now retain L1 equipment/architecture/personnel/OHT as the source does. The B1 floor is the
source slate PBR plane at -7 m; level/X-Ray/exploded slab and material restore are checked in browser.
Wafer/X-Ray HUD geometry and dynamic pause glyph match measured source DOM; the frozen global 12px
font floor is retained. The Golden comparator now scales the CSS scene ROI into device pixels.

Production browser acceptance passes for Wafer, level/FFU combinations, Twin UI, Tour, Tour Escape,
Exploded and X-Ray, with zero console/runtime errors and zero recorded GPU errors. 121 identities,
12 exploded links and 771 -> 969 -> 771 casters restore (removed the old extra subfab slab caster).
Tour auto-advance is 7.214 s measured from the click. Current checks: **187/187 Vitest**, TypeScript,
production build, architecture/source drift gates and **16/16 Python tooling tests** pass.

Fresh 19-pair production Golden full-frame SSIM range: **56.7%-73.7%**. Wafer **50.0% -> 58.5%**,
Dual **59.9% -> 63.6%**, X-Ray **60.6% -> 61.4%**. B1 stays **56.7%** structurally while RGB MAE
falls **65.9 -> 51.1**. Corrected ROI values are not comparable to the earlier DPR-bugged ROI table;
full-frame metrics remain comparable. Material/light/specular response, sidebar/top/footer/AMHS layout,
basement detail and X-Ray appearance still prevent parity. The capture procedure also retains declared
React setup clock offsets and non-equivalent random-consumption order. No visual threshold is approved.

Evidence and exact scope/limitations: [2026-10-26 README](evidence/golden-2026-10-26/README.md),
[comparison](evidence/golden-2026-10-26/comparison.json),
[production acceptance](evidence/golden-2026-10-26/acceptance.json).
**60-minute soak and device-loss matrix remain skipped by user decision.**

## Earlier GPU evidence interpretation

`evidence/native-shadow-acceptance.json` measures cache behavior, visible shadow contrast, ambient isolation and validation errors. `cut-shadow-acceptance.json` measures clipped depth coverage and exact restoration. `device-loss-acceptance.json` requires a new device, a new native pass, the **completed** WebGPU status, unchanged manual camera and no new-device validation errors. Waiting text does not qualify. Readback acquires the current presentation frame; a previously presented swap texture must not be reused.

Babylon 9.32's WebGPU buffer rebuild omits the scene geometry pass present in its WebGL Engine class. The application explicitly rebuilds CPU-backed geometry/sprites on restoration, then validates the submitted first frame. This is version-pinned compatibility code, not a WebGL fallback. Native depth resources rebuild on the same new device. No 60-minute or VRAM claim follows from this targeted test.
