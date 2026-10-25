# Complete original Twin page parity

> **For agentic workers:** Use superpowers:executing-plans inline, with tests before each behavior change and a final independent code review.

**Goal:** Complete the remaining original-page controls, HUD, facilities and differential acceptance without replacing the existing WebGPU equipment/shadow implementation.

**Architecture:** React renders the original page structure from typed source data. A separate reference-equipment registry preserves the original directory semantics; stable layout instance IDs remain the authority for 121 machine geometry and replay. Static facility primitives are generated from original parameter recipes and world transforms, with the original hierarchy and layer identity. Controllers own animation/timing, not JSX effects scattered across the page.

**Tech Stack:** Existing React/TS/Babylon 9.32 WebGPU; source-extraction/Golden tooling; Vitest; same native GPUDevice depth pass.

**Spec:** `SemiconFab_Twin_3D_React_TS_Babylon_WebGPU_Parity_Spec_2026-10-24.md`; `docs/migration/twin-parity/baseline.md`.

## Global constraints

- One `/twin` product page; no independent preview, original-page iframe, Three runtime, glTF/GLB or WebGL fallback.
- Preserve all 121 instance identities, dimensions, transforms and existing native shadow/cut/recovery evidence.
- Original commit remains `b3666132e5d8cab2cebe4c4227fc04c52242eb28`; starting Next commit `6ed8a579329099f0cf9f503c2675d46decab5806`.
- Per the user's 2026-10-25 instruction, merge the verified increment into `main`, push GitHub, delete other local/remote branches, then continue in this existing checkout on `main` only. Preserve existing dependencies/servers; no second worktree or website.
- Do not equate an implemented/tested control with visual acceptance. Keep unresolved differences explicit.
- The full parity scope includes complete controls, inspector, modals, original timing/data, facilities, i18n/theme, and GPU/browser acceptance. Do not stop merely after the first task.

## Review focus

- Original final `FAB_EQUIPMENT` directory has 18 entries (12 B1, 2 airlocks, 4 catalog machines), distinct from 121 placed instances and 116 OEM records.
- Same record UUID can refer to several placements; draft selection and reference/OEM selection must not lose instance identity.
- Original initial FAB tab label 67 is stale until Scenario application; preserve/document this source behavior instead of inventing a 121 directory count.
- Reference DEMO states and draft/replay light states have different source ownership; late SSE must remain isolated.
- Adding facility meshes/transparent materials must retain exact layer restoration, native depth invalidation and safe new-device resource ownership.

## Task 1 — typed reference directory and state ownership

**Files:** `original-twin-data.ts`, generated `assets/original-twin-ui.json`, `twin-equipment.ts`; tests `original-twin-data.test.ts`, `twin-equipment.test.ts`.
**Interfaces:** `OriginalEquipment`, `OriginalOem`, `TwinSelection`; `referenceDirectory`, `filterReferenceDirectory`, `resolveTwinSelection`; project 18 directory states into known catalog placements while keeping draft lights unchanged outside replay/live.

- [x] Freeze final reference objects and both localized projections with source hashes; distinguish original initial counter from actual directory length.
- [x] Test exact 18/116 identity/order and all four catalog mappings; category/state/localized search, repeated IDs and unmapped relations.
- [x] Implement typed data/selectors and exact DEMO tick ownership; verify full suite.

## Task 2 — original sidebar, inspector and CAD elevation

**Files:** `twin-sidebar.tsx`, `twin-inspector.tsx`, `twin-elevation.tsx`, `twin-page.tsx`, `fab-viewer.tsx`, `assets/twin.css`.
**Interfaces:** selection discriminated by layout/reference/OEM; existing `PickedTool` remains compatible; `SceneFacade.selectEntity` handles facilities alongside `selectTool`.

- [x] Browser RED: source IDs for two tabs, category/state pills, clear/search and footer actions; OEM tab remains in the page.
- [x] Restore original card rows, ordering, active state/scroll, full header/CAD/spec/provenance/connections/telemetry/MES/SPC fields, source actions and draft CTA.
- [x] Port original CAD recipes to typed React SVG; no injected original HTML/controller.
- [ ] Verify switching locale, selection kinds, invalid/deleted IDs, connected-tool jumps and closing/reopening without stale fields.

## Task 3 — full top/bottom HUD, modals and preferences

**Files:** `twin-hud.tsx`, `twin-dialogs.tsx`, `twin-preferences.ts`, `twin-i18n.tsx`, `original-icons.tsx`, CSS.

- [ ] Compare source control ledger; implement remaining header actions, roof/HVAC/patrol/camera controls, footer legend/grid/stats and original breakpoints.
- [ ] Restore OEM database, architecture/provenance/help and Yield/Map dialog flows, focus/Esc/backdrop behavior and internal valid targets.
- [ ] Restore all source-language labels/tooltips, original storage/theme migration, dark/light styling and responsive behavior; test blocked storage and URL precedence.

## Task 4 — complete static facilities and system identity

**Files:** `tools/extract_twin_facilities.*`, generated facility recipes, `original-facilities.ts`, `procedural-fab.ts`, `legacy-site.ts`, scene facade/backend.

- [x] Extract parameterized Box/Cylinder/Torus/Tube/etc recipes and original world transforms/hierarchy/materials/layer/system IDs from the read-only reference; no baked model or renderer import.
- [x] Test recipe counts, transforms and bounds against independent reference; generate Babylon primitives/shared geometries and correct shadow caster flags.
- [x] Replace approximated walls/airlocks/B1/general FFU/roof/HVAC with corresponding recipes; retain existing 121-machine geometry.
- [ ] Verify L1/B1/Dual/Exploded/Roof/FFU/HVAC/Cut combinations and native shadow cache restoration in real WebGPU.

## Task 5 — dynamic source behavior

**Files:** focused AMHS/personnel/airlock/wafer controllers, `twin-state.ts`, backend.

- [ ] Extract source timeline vectors for OHT jobs/hoist/LED/FOUP, six people and airshower/patrol; test fixed-seed/keyframe behavior before replacing approximations.
- [ ] Complete exploded hierarchy/guide lines, original X-Ray filtering and spatial HUD pressure readouts.
- [ ] Complete original camera paths/presets/deep links, Tour/onboarding copy/countdown/control IDs, Wafer Bay/completion/seek/speed semantics.

## Task 6 — original industry math and data vectors

**Files:** `fab-yield.ts`, `process-control.ts`, reference demo state; data/vector tests.

- [x] Port source directory-based KPI/yield, Scenario and telemetry update order, random input as explicit deterministic test input. Process-only stream verified; full scene random initialization is still a Golden gate.
- [x] Compare MES/SPC (including insufficient-sample constants) and Yield/Map/STDF vectors; retain local demo vs backend boundary. Frozen source vectors cover 15 initial profiles, 29 directory ticks, 26 recipe ticks, 28 MES actions, 14 SPC cases, six Scenarios and seven complete die/bin/STDF maps.
- [ ] Test replay/live/demo transitions and every selection type without inventing mappings for obsolete source IDs.

## Task 7 — complete differential and release gates

- [ ] Fill original control/function traceability and all missing visible/disabled/tooltip states; capture reference and Next with matched data, camera/time/viewport/language/theme.
- [ ] Run 11+ Golden pairs, HUD/scene ROI differences, original control/browser flows and mobile/accessibility checks; keep material remaining errors visible.
- [ ] Instrument actual WebGPU frame time/resource/memory proxies for 60 minutes and repeated device loss in relevant modes; document the actual supported browser matrix.
- [ ] Run root verification, source/asset/loader audit, production-bundle browser acceptance and final independent review; fix blockers with RED→GREEN regressions.
- [ ] Update parity status only to the level supported by evidence; commit/push verified work under the existing authorization. GitHub account billing/runner startup remains an external CI limitation until cleared.
