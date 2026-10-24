# Twin parity baseline

Updated: 2026-10-25. Status: **IMPLEMENTING / NOT PARITY_VERIFIED**.

The user selected the final construction loaded by `../SemiconFab/twin.html`, with `?layout=/twin/layout-default.json&mode=engineer`. The frozen original is `jinjiefan2020/SemiconFab@b3666132e5d8cab2cebe4c4227fc04c52242eb28`. Next started this increment at `060957d`. Original source bytes are unchanged; hashes and inputs are in [source-manifest.json](source-manifest.json). See [attribution.md](attribution.md) for original PolyForm and icon notices.

## Product boundary

There is one single-FAB 3D page, `/twin` (`/twin.html` compatible). The independent preview page/component and embedded home canvas have been deleted. Old `/preview` and `/preview.html` URLs canonicalize to `/twin`, retaining parameters. The workbench has an ordinary new-tab **3D FAB** link. Rendering remains Babylon `WebGPUEngine` only, with native WebGPU depth shadows and no WebGL fallback, Three renderer, iframe renderer, glTF/GLB asset or loader dependency.

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
| P0 2. Page/HUD | Original main regions; 12px normalized micro-text; captured SVG controls; shared zh/en locale | Full original sidebar/OEM tab, inspector/CAD fields, modals, footer legend, exact spacing and responsive rules |
| P0 3. Unified modes | One SpatialMode; reducer owns spatial and Tour/Wafer/Research/Onboarding; focused-select Esc exits Tour; original tour positions/durations; Aero pressure/1500 sprites | Original visible/disabled control comparison and complete Aero facility/animation matching |
| P0 4. GPU/failure | Real shadow/cut pixels, depth restoration and GPUDevice.destroy recovery; completed-frame/validation gate; preserves manual camera | Instrumented 60-minute run, frame-time/memory records, repeated failure matrix and all mode combinations |
| P1 5. B01 | DEMO Scenario, Play/Pause, 1600ms tick, per-instance four-state override; towers/counts/inspector derive one authority | Original random-stream/telemetry sequence, list/KPI exactness; backend commands remain separate |
| P1 6. Research | 27,263 rows; original winning aliases; per-machine states; entering/re-entering replay freezes current DEMO/SSE state | Replay Golden acceptance; no AMHS events exist in JSONL, so AMHS stats are explicitly independent animation |
| P1 7. X-Ray | System filters, ghost restoration and Cut/level mutual exclusion | Original filtered shader and exact rendering/shadow behavior |
| P1 8. Facilities/dynamics | Dual OHT/24 cars, personnel, amber ceiling/floor/columns, pressure/laminar display, utility headers/pump stations | Full general FFU/HVAC/roof, B1 dense industrial network, exact personnel/airlock/OHT timing and visuals |
| P1 9. Wafer | A/B/C 120/104/92 steps, seek/play/pause, 1×/4×/16×, camera/trail | Original Bay/final wording and fixed-time seek/speed Golden vectors |
| P1 10. MES/SPC | Existing local MES actions and SPC; explicit local demonstration boundary | Original inspector layout and sample vectors; no backend production persistence claimed |
| P1 11. YMS/Yield | Existing Wafer Map/STDF and yield models; literal scenario overrides resolve exact IDs only | Obsolete fe.* IDs stay unresolved; source bay-group math/jitter/cycle adjustment and model Golden vectors |
| P2 12. Locale/theme | Original font normalization and language storage keys; URL/refresh persistence; translated process search tested | All technical strings/tooltips and full theme/persistence equivalence |
| P2 13. Modals/notices | Original code/data and Lucide/Feather notices retained | Original architecture/source/related-page modal flows |
| P2 14. Release | Updated feature map, regression suites, evidence and source review | Full accessibility/mobile/cross-browser/performance/release audit; no parity release tag |

## Exact data boundaries and compatibility exceptions

1. **Instance identity:** 121 stable `FAB-01/tool-NNN` IDs differ from record UUIDs, which repeat. [layout-identities.json](layout-identities.json) records both.
2. **Original alias collisions:** packaging shares TG01_LITHO, test shares TG16_MET_CD. Source inserts catalog aliases before draft-family groups; its last writer wins. Thirty-two layout rows participate in collisions. [replay-map.csv](replay-map.csv) maps **94 of 217 simulation machines** to the source-winning instance. No one-to-one mapping is invented. Unmapped instances retain the current session's pre-replay state.
3. **Authority:** SSE updates only its live cache. DEMO and Research derive rendered states independently; late SSE cannot overwrite them. DEMO/MES/SPC are local demonstrations, not backend commands or durable production models.
4. **SPC compatibility:** existing constants for insufficient sample data remain for demonstration compatibility. They are not measured production capability; precise source vectors and UI annotation remain to be accepted.
5. **Scenarios:** source fe.* overrides absent from the selected 121-tool layout are disclosed as unresolved. Category-wide DOWN substitution has been removed.
6. **Aerodynamics:** original pressure-field branch order (including Litho/airlock overlap), drift and nominal per-frame motion remain. Obstacles use the final 121-tool layout; original builds its old obstacle list before async replacement. This deliberate delta is not particle-exact parity.

## GPU evidence interpretation

`evidence/native-shadow-acceptance.json` measures cache behavior, visible shadow contrast, ambient isolation and validation errors. `cut-shadow-acceptance.json` measures clipped depth coverage and exact restoration. `device-loss-acceptance.json` requires a new device, a new native pass, the **completed** WebGPU status, unchanged manual camera and no new-device validation errors. Waiting text does not qualify. Readback acquires the current presentation frame; a previously presented swap texture must not be reused.

Babylon 9.32's WebGPU buffer rebuild omits the scene geometry pass present in its WebGL Engine class. The application explicitly rebuilds CPU-backed geometry/sprites on restoration, then validates the submitted first frame. This is version-pinned compatibility code, not a WebGL fallback. Native depth resources rebuild on the same new device. No 60-minute or VRAM claim follows from this targeted test.
