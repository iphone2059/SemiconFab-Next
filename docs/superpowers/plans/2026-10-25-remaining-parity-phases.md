# Remaining Twin parity — staged phases

> **Execution:** the product boundary, architecture and spec references stay in
> [2026-10-25-full-page-parity.md](2026-10-25-full-page-parity.md); this document re-stages every
> remaining open item into four evidence-gated phases. Execute in order unless a phase is marked
> parallel-safe. Status stays **IMPLEMENTING / NOT PARITY_VERIFIED** until Phase D evidence is accepted.

**Date:** 2026-10-25 · **Frozen original:** `jinjiefan2020/SemiconFab@b3666132e5d8cab2cebe4c4227fc04c52242eb28` · **Tracking:** [baseline.md](../../migration/twin-parity/baseline.md) · **Spec:** `SemiconFab_Twin_3D_React_TS_Babylon_WebGPU_Parity_Spec_2026-10-24.md`

## Scope decisions (2026-10-25)

1. **Languages: `en-US` and `zh-CN` only.** Nine-language coverage is withdrawn as a target (user
   instruction). The frozen twin page's own toggle only cycles `zh-CN`/`en` (`js/i18n.js` lines
   53–56); its nine-language dictionary is site-wide and out of scope. Canonical locale tag goes into
   the URL, `documentElement.lang` and `semiconfab_lang`; `semicon_lang` keeps its legacy
   `zh`/`en` mirror; old `en`/`zh`/`zh-TW` inputs are normalized, never stored as canonical.
2. **Theme: source has no Twin theme control; align to the original (user confirmed 2026-10-25).** Evidence: `twin.html` line 28 only carries
   `meta[name=theme-color]`; four `dark:` utility classes (lines 1518–1535) sit in a decorative
   control with no runtime class switching; the `#theme-label` handling in shared `js/i18n.js`
   (lines 118–123) serves other site pages. Parity therefore means the original **light-only**
   styling on `/twin`; no theme toggle is added. A Next-only dark variant may be added later only as
   an explicitly labelled non-parity enhancement.
3. **Closed, not reopened here:** OEM/architecture dialogs + deep links, onboarding advance, Redux
   state ownership, and the frozen MES/SPC/Yield/STDF process vectors. They still need runtime and
   visual evidence in Phase D, but are not re-implemented.
4. **Known non-equivalence retained:** full-scene random initialization (the original consumes
   unseeded `Math.random` in telemetry, AMHS, personnel and particles). Phase D has an explicit
   gate; frozen process vectors do not prove scene equivalence.

## Global rules

- One WebGPU-only `/twin`; preserve all 121 instance identities, native depth shadows, cut
  restoration and device-loss recovery.
- Never accept a visual or control item from unit tests alone. Every claim needs browser evidence
  recording browser/GPU, DPR, viewport, language, seed and scene clock.
- Every extraction tool grows a `--check` drift gate and is wired into `scripts/verify.ps1` and CI.
- Keep write scopes disjoint. Only one owner edits `legacy-site.ts` / `twin-page.tsx` at a time;
  pure modules (`twin-dynamics`, `xray-materials`) and fixtures can be prepared in parallel.
- Per behavior change: RED test first, then implementation, then typecheck + affected unit tests +
  build; browser evidence captured from the production build in Phase D.

---

## Phase A — source-exact dynamic timeline

Replaces approximations with frozen-source timing vectors and pure controllers. Current rough
implementations: `legacy-site.ts` (OHT hoist/load constants around lines 216–320, personnel root),
`procedural-fab.ts` (personnel meshes), `aerodynamics.ts` (laminar/airlock visuals).

### A1. Extract and freeze timing vectors

**2026-10-25 progress:** the AMHS slice is landed — `tools/build_twin_dynamics_vectors.cjs`,
`web_app/tests/fixtures/original-dynamics-vectors.json` and the exact
`web_app/src/amhs-timeline.ts` port with `web_app/tests/amhs-timeline.test.ts` (548 transition events,
121 sampled frames, 32 tasks / 14 deliveries over a declared 120 s scenario). Renderer integration is
also landed: `legacy-site.ts` advances the controller on the scene tick with the declared seed 42
(replacing the frozen page's unseeded `Math.random`), maps arc length / hoist / cable / FOUP / LED
outputs onto the OHT meshes (FOUP now hangs below the gripper and the dual cables are restored) and
feeds the AMHS HUD. Local Headless Chrome 155 WebGPU evidence: active vehicles rose 00→06/24 within
~12 s, zero console errors/exceptions, and the Twin UI acceptance (with a new AMHS-HUD assertion)
passes. Personnel, air-shower and tour/wafer vectors plus pixel-Golden acceptance remain open.

- New tool `tools/build_twin_dynamics_vectors.cjs`, modelled on
  `tools/build_twin_process_vectors.cjs`: verify `twin.html` SHA against
  `source-manifest.json`, execute only extracted frozen functions in `node:vm` with minimal THREE
  stubs and a seeded LCG replacing `Math.random`; write
  `web_app/tests/fixtures/original-dynamics-vectors.json` and support `--check`.
- Source functions and ranges (frozen `twin.html`):
  - AMHS: `buildAmhsSystem` 15371, `setVehicleLedColor` 15364, `createFoupMesh` 11446,
    `updateAmhsSimulation` 18688–19037, `toggleOhtVisibility` 21487. Timing to freeze: Poisson job
    arrival mean 4 s, FIFO + nearest-idle dispatch, states `IDLE / TO_PICKUP / LOADING /
    TO_DROPOFF / UNLOADING`, LED color per state, 3.0 s load/unload cycle with hoist phases at
    1.5/1.9 s and FOUP visibility swapped at 1.5 s, hoist travel to −3.2, kinematics (base 1.4,
    station creep 0.22, arrival < 0.3 m/s), car-following 4 m limit / 2.08 m stop / 2.0 m hard
    spacing, 200 ms HUD throttle.
  - Personnel: `buildCleanroomPersonnel` 9470 (six actors incl. five stationed operators plus the
    patrol engineer), `updatePatrolEngineerBehaviorTree` 9544–9836, `focusPatrolEngineer` 9836,
    `createPatrolStatusCanvas/Sprite` 9140/9188, `updatePatrolStatusSprite` 9208. Freeze the six
    phases: `APPROACH_AIRLOCK → ENTER_AIRLOCK → PURGE (4.5 s) → EXIT_TO_LITHO →
    PATROL_WAYPOINTS → RETURN_AIRLOCK`, walk-cycle phase speed 8.0, per-waypoint durations/angles,
    status text (zh/en) and airlock indicator/jet/light animation values.
  - Airlocks: `createAirlockVortexParticles` 9257, `createAirShower` 10087,
    `createAirShowerSprite` 10004, `drawAirShowerBillboardCanvas` 9927,
    `updateAllAirShowerSprites` 10026. Freeze jet/sprite phase and purge-visibility rules.
- Test `web_app/tests/original-dynamics-vectors.test.ts`: fixture reproducibility, declared seed,
  exact phase-boundary ticks and discrete states, and source-line provenance comments.
  `build_twin_dynamics_vectors.cjs --check` is added to `scripts/verify.ps1`.

### A2. Pure timing controllers

- New `web_app/src/twin-dynamics.ts` (split into `amhs-timeline.ts` / `personnel-timeline.ts` /
  `airshower-timeline.ts` only if it exceeds ~600 lines): deterministic, clock-injected state
  machines returning render commands (positions, hoist Y, LED color, FOUP visibility, sprite
  opacity/rotation, status text keys). `legacy-site.ts` becomes the render adapter and no longer
  owns durations.
- Tests (RED→GREEN): replay fixture keyframes exactly (zero tolerance for discrete states, declared
  float tolerance for positions); two runs with same seed are identical; pause/resume; no
  `Date.now`/`Math.random`/module-level mutable state inside controllers.
- Delete the ad-hoc OHT durations (`ease(elapsed / 1.1)`, `1.5`, `1.9` constants) and any
  patrol/air-shower timing scattered in render code; grep gate for those literals.

### A3. Clock wiring and pause semantics

- `twin-page.tsx`, `fab-viewer.tsx`, `legacy-site.ts`: one clamped fixed-step tick drives
  controllers and the existing DEMO clock; Tour/Wafer pause does not freeze AMHS/personnel (match
  source RAF behavior). Device restore must not duplicate timers.
- Tests: injected clock advances exact ticks; reload/remount yields same initial phase; no NaN after
  device loss.

### A4. Browser keyframe evidence

- Extend `web_app/tests/twin-parity.browser.ts` to capture OHT load/unload, patrol airlock purge and
  air-shower frames at fixed virtual clock + camera; store JSON/PNGs in `.local/evidence/dynamics/`
  for Phase D reuse.

**Phase A completion:** `--check` fixtures stable; controller tests replicate the source keyframes;
no ad-hoc timing literals remain; browser keyframes captured; baseline updated with the actual
remaining delta. Until then Phase A stays open even if unit tests pass.

---

## Phase B — Exploded hierarchy and X-Ray materials

### B1. Exploded deconstruction (source: `twin.html` 19910–20092, 19256–19274)

- Port exactly: factor eases toward target by 0.08/frame; slider 0–100 % and presets 0 / 0.5 / 1.0;
  `ceilingMesh.position.y = factor * 20`; `subfabGroup.position.y = -factor * 18`;
  guide links built for every B1 tool with a resolvable `connectedTool` pair (source list), cylinder
  radius 0.14 / height 7, midpoint placement, `scaleY = (7 + 18·factor) / 7`,
  `position.y = -totalH/2`, torus ring 0.28/0.04 at `sin(now·0.005 + phase)·3.08`, per-`svgType`
  conduit colors, links visible only when `factor > 0.01`; floor material state per level
  (L1 opaque + depthWrite, B1 0.2, DUAL 0.35, EXPLODED 0.55 transparent/no depthWrite) and slab
  visible only for L1; entering exploded forces preset 1.0 + camera tween {55,44,72}→{0,−4,0},
  leaving restores the current-level camera. Level switch closes exploded mode.
- Implementation: pure helpers in `web_app/src/twin-spatial.ts` (factor/camera/floor/link math) and
  renderer creation in `legacy-site.ts`; expose ceiling/subfab roots from the facility builders.
  Guide links are dynamic meshes: exclude from static caster list, invalidate native shadows on
  toggle, and restore exactly.
- Tests: pure math vs source values; link count/colors; material restore invariant; browser toggles
  0/50/100 % + slider + preset + level switch, shadow restoration and no stale meshes.

### B2. X-Ray holographic effect — WebGPU shader (source: `twin.html` 20210–20414)

- **User decision 2026-10-25: implement X-Ray with a WebGPU/WGSL shader wherever the effect can be
  expressed in shader code.** The frozen original performs a Three.js material swap; its material
  parameters are the reference look, but Next must not fake the hologram with flat alpha/material
  swaps when a shader path is feasible.
- Shader architecture (must preserve native static shadows and device-loss rebuild):
  - `web_app/src/xray-hologram.ts`: WGSL fragment injection (MaterialPlugin on PBR materials, or a
    dedicated WGSL ShaderMaterial for meshes outside the PBR pipeline) rendering ghost glass with
    Fresnel rim, scanline modulation, cyan ghost tint and an emissive-cylinder variant. Uniforms:
    enabled, ghost strength, highlight/filter gain. Transparency and `depthWrite` are engine state
    toggled on activation and restored exactly.
  - Reuse the `NativeShadowMaterial` depth binding so ghost surfaces still receive native static
    shadows; shader materials are rebuilt after a GPUDevice replacement.
  - Subfab utility filters (ALL / UPW / GAS / VAC / EXHAUST / AMHS by original color-hex groups) are
    applied through shader uniforms per pipe material, not per-frame JS material mutation.
  - Reference parameters to match: ghost floor opacity 0.12/no depthWrite and slab hidden; equipment
    ghost color `#0284c7` opacity 0.16 roughness 0.1 metalness 0.85; tall cylinder parts
    `#38bdf8` color + `#0284c7` emissive intensity 0.95 metalness 0.8; lines `#38bdf8`
    opacity 0.75; piping highlight opacity 1.0/emissiveIntensity 1.2 vs ghost 0.15/0.1; OHT track
    AMHS rule.
  - A material-swap fallback is allowed only for a mesh class where a shader conversion is proven
    infeasible; document each fallback with evidence. No silent fallback path.
- Files: `web_app/src/xray-hologram.ts`, `web_app/src/xray-materials.ts` (pure filter→highlight
  mapping from source hex groups), renderer activation/restore in `legacy-site.ts`,
  `web_app/tests/xray-hologram.test.ts`, browser capture additions.
- Tests: WGSL source/uniform-contract unit tests; filter mapping table against source hex groups;
  activation/restore state machine; browser compile-and-render with zero GPU validation errors, six
  filter captures and shadow restoration; device-loss shader-material rebuild.
- **Completion:** X-Ray renders through the WebGPU shader in the real scene, all six filters match
  reference captures, restore leaves no residual material/shadow change, and no equipment-alpha
  mutation path remains as the primary effect.

**2026-10-25 shader landing:** `web_app/src/xray-hologram.ts` renders the hologram as a WGSL
MaterialPlugin fragment patch on the source PBR equipment/floor/subfab materials (Fresnel rim,
scanline modulation, cyan ghost tint, filter-highlight uniforms; `depthWrite`/transparency are saved
engine state restored exactly). The source alpha-swap path is gone for those surfaces. OHT track and
catalog wire overlays keep the older alpha/colour path until a WGSL line/track variant exists
(documented fallback). Local Headless Chrome 155 WebGPU evidence: all six filters activate, B1+UPW
shows the highlighted subfab piping hologram, disabling X-Ray restores the normal scene, and the run
produced zero console warnings/errors, JS/GPU exceptions or WGSL compilation messages. Remaining:
matched-Golden comparison against the frozen original, floor/slab/shadow restoration measurements,
and the OHT/line shader variant.

### B3. Scene combination matrix

- `web_app/tests/scene-combination.browser.ts`: L1 / B1 / DUAL / EXPLODED × Roof / FFU / HVAC /
  Cut / X-Ray filters, including recovery order and repeated toggles; verify native shadow cache
  restoration, level-appropriate visibility, no stale material, zero GPU validation errors.
- **Phase B completion:** source-exact exploded math and guide lines visible; X-Ray filters/restore
  pixel-tested; full combination matrix green in real WebGPU; deltas documented with images.

---

## Phase C — en-US / zh-CN UI and responsive rules

### C1. Source-string inventory

- New `tools/build_twin_i18n_vectors.cjs`: parse frozen `js/i18n.js`, `js/translations.js` and
  `twin.html` `data-i18n*` references; extract **only `en` and `zh-CN`** bytes plus every
  dynamic zh/en ternary string in the twin inline script (status texts, tour/wafer copy, legends,
  toasts); write `web_app/assets/original-twin-i18n.json` with source hashes and a `--check` gate.
- Wire into `scripts/verify.ps1`; test `web_app/tests/original-twin-i18n.test.ts` (coverage,
  no missing/extra keys, provenance).

### C2. Complete en/zh copy and tooltips

- Replace hand-written `TWIN_EN` guesses with the extracted pairs wherever the source has an exact
  pair; keep explicit bilingual copy only for Next-specific data-boundary labels and list them in the
  inventory as deliberate additions. Cover `data-i18n`, `data-i18n-html`, `-title`, `-aria-label`,
  `-placeholder`, option labels, toasts, tour/wafer copy, footer/legend/grid/stats.
- Files: `twin-page.tsx`, `twin-sidebar.tsx`, `twin-inspector.tsx`, `twin-dialogs.tsx`,
  `twin-translations.ts`, `original-tour.ts`, `original-facility-architecture.ts`,
  `twin-i18n.tsx`.
- Tests: translation completeness (every key used, resolves in both locales); browser scan of
  rendered DOM in both languages (no CJK in en UI, no missed key shown raw, all tooltips non-empty);
  language switch keeps the same selection/dialog fields; reload and deep links keep locale.

### C3. Preference, URL and storage behavior

- Keep the fixed canonical tags: URL `?lang=en-US|zh-CN`, `documentElement.lang`,
  `semiconfab_lang` canonical, `semicon_lang` legacy mirror; normalize legacy `en`/`zh`/`zh-TW`
  inputs; URL > storage > browser-language precedence; blocked storage; StrictMode/hydration safe.
- Tests extend `preferences.test.ts` / `twin.browser.ts` / `catalog.browser.ts`; catalog page must
  not misread `?lang=en-US` (regression covered by this increment).

### C4. Source responsive rules

- Derive breakpoints from frozen source CSS/Tailwind classes and the extracted
  `assets/original-twin-hud.css`; reconcile `web_app/assets/twin.css` media queries instead of
  inventing new breakpoints.
- Browser test (extend `twin-parity.browser.ts`): DOM box inventory of topbar, HUD panels, sidebar,
  inspector, footer at 2560×1440, 1920×1080, 1536×735, 1366×768, 1024×768 and 390×844; assert no
  overlap/overflow, all controls reachable, canvas fills viewport; record declared tolerance.
- **Phase C completion:** all user-visible strings/tooltips resolve from the source inventory in
  both locales; preference/URL behavior matches source; responsive box evidence at six viewports;
  theme decision recorded as in scope decisions (no toggle).

---

## Phase D — integrated differential and release evidence

### D1. Golden matrix (≥ 11 states, both locales where HUD text dominates)

- Capture original vs Next from the production build with matched browser/GPU/DPR/viewport,
  language, seed and virtual scene clock: ISO, Top, Litho, B1, DUAL, EXPLODED (0/50/100 %), Cut,
  X-Ray (six filters), Research, Wafer, MES, SPC, YMS, Tour waypoints 1–5, OEM/architecture/help
  dialogs and onboarding. `en-US` and `zh-CN` for HUD-heavy states at minimum.
- Keep full-frame and ROI SSIM/RGB outputs in `evidence/golden/<date>/` plus `comparison.json`;
  no threshold is invented — report deltas, then ask the user to approve a threshold.

### D2. Control and state matrix

- Reconcile all 263 raw control IDs / 260 unique + 2 DOM-property IDs and 218 named functions
  (`controls.csv`, `functions.csv`) against runtime evidence: visible/disabled/tooltip/label/
  active state in both locales. Cover Replay/Live/DEMO switching, layout/reference/OEM/draft
  selection kinds, invalid and deleted IDs, connected-tool jumps, close/reopen consistency,
  selection after language switch, Esc/focus trap, deep links, onboarding sequence.
- Automated browser test `web_app/tests/twin-control-matrix.browser.ts` + evidence JSON; every row
  ends as `PASS` with artifact, or explicitly `REMAINING` with reason.

### D3. Production bundle and browser matrix

- Serve the built `dist` (production API), open `/twin`, verify WebGPU init first frame, no dev-only
  hooks, no console errors, catalog/deep-link smoke. Record actual supported browser matrix
  (Chrome/Edge WebGPU); do not claim Firefox/Safari support without a WebGPU implementation.

### D4. 60-minute and device-loss matrix

- Instrument frame time, GPU memory/resource proxies and JS heap for a 60-minute run in the main
  modes; record trend and limits. Repeat `GPUDevice.destroy()` ≥3 consecutive times in L1/B1/DUAL/
  EXPLODED/X-Ray/Cut: require new device, new native pass, completed WebGPU status, unchanged manual
  camera, zero new-device validation errors, readback. Store JSON evidence.

### D5. Random-initialization gate

- Attempt to reproduce the original global `Math.random` consumption order for scene init; if not
  bit-equivalent, keep the declared delta, guarantee Golden captures use a declared seed + clock,
  and never derive a parity claim from it.

### D6. Release decision

- Run full `scripts/verify.ps1`, source/asset/loader audit, independent review; update
  `baseline.md` audit table and status **only** to the supported level; keep every remaining item
  visible. `PARITY_VERIFIED` only after D1–D5 evidence and the user-approved visual threshold.

---

## Parallelism and write scopes

| Lane | Work | Owns (write scope) | Can start |
| --- | --- | --- | --- |
| 1 | A1 extractor + A2 controllers | `tools/build_twin_dynamics_vectors.cjs`, `web_app/tests/fixtures/`, `web_app/src/twin-dynamics*`, `web_app/tests/original-dynamics-vectors.test.ts` | immediately |
| 2 | B1/B2 pure modules | `web_app/src/twin-spatial.ts`, `xray-materials.ts`, their tests | immediately (no renderer edit) |
| 3 | C1 inventory tool + C2 copy extraction | `tools/build_twin_i18n_vectors.cjs`, `web_app/assets/original-twin-i18n.json`, `twin-translations.ts` | after C1 extractor |
| 4 | Integration | `legacy-site.ts`, `twin-page.tsx`, `twin.css` | serially after lanes 1–3 land |

## Immediate next actions

- [x] Canonical locale normalization (en-US/zh-CN) with unit tests, legacy input compatibility.
- [x] AMHS source vectors + pure controller port (exact fixture replay) and renderer wiring with browser HUD evidence.
- [x] First X-Ray WGSL hologram shader pass on PBR equipment/floor/subfab with six-filter and restore browser evidence.
- [ ] OHT track + catalog wire WGSL variants (remaining alpha/colour fallbacks).
- [ ] Personnel/air-shower/tour/wafer source vectors.
- [ ] B1 exploded pure math and guide-link geometry from source constants.
- [ ] C1 i18n inventory extractor (en/zh bytes only) before touching copy.
- [ ] Extend browser evidence and Golden tooling only after the first three artifacts land.
