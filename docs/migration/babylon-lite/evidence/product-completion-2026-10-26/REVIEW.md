# Independent read-only review — native Lite product completion

Reviewer: `review-worker` (independent, read-only; only this file was written).
Scope: branch `feat/twin-babylon-lite-native`, HEAD `d25eb4f` + uncommitted migration work.
Final freeze reviewed: docs frozen 2026-10-26T23:32:54+08:00; code frozen 2026-10-26T23:24:57+08:00;
production build frozen 2026-10-26T23:25:38+08:00. Earlier snapshot in this session was 23:05–23:15;
issues found then were fixed in flight and are classified as **resolved** below.

Method: static reading of the full diff/new modules, unit tests and typecheck (allowed), no browser/CDP
runs by the reviewer (the final product/UI/Edge/soak runs were executed by the Lead; their raw JSON,
PNG manifests, browser UA strings and file times were audited here), no rebuild (dist artifacts and
mtimes verified instead), evidence numbers recomputed/re-checked against raw JSON. No source, test,
tool, package or existing doc was modified; the only write is this REVIEW.md.

## Verdict

**No Critical issue and no blocking code defect in the frozen tree.** The headline product claims hold
against code and raw evidence: three real forced WebGPU device losses in Chrome 155 (and again in
Edge 156) with 0 GPU validation errors and 0 console errors, camera/roof/cut/or X-Ray restored, canvas
selection index + wireframe restored in the new no-spatial-mode round, Redux tool-state sync resumed;
native/Lite API boundary clean (only `@babylonjs/lite` imported in `web_app/src`, no private
underscore members, no `@babylonjs/core`/three/lite-compat), `@babylonjs/core` gone from
package.json+lockfile, 0 dangling relative imports in the frozen tree, `tsc --noEmit` 0, `vitest`
51 files / 238 tests pass, dist contains 0 old-engine symbols, visual/perf A/B and 1-minute soak numbers
in the evidence README match the raw JSON exactly, and the 60-minute soak is correctly marked
**NOT_RUN** (user-directed 1-minute replacement) rather than passed.

The only **Important** findings are documentation/evidence bookkeeping: `MIGRATION_PLAN.md`,
`VALIDATION.md` and `FEATURE_GAPS.md` still contain pre-freeze numbers/links/status that contradict
the frozen evidence README (details D-1). They do not change the product conclusion but must be aligned
before merge so the package cannot be misread. Everything below is Minor (assertion tightness, one 56 B
payload figure, residual race/coverage notes, historical-doc staleness).

## Findings table

| # | Severity | Area | Location | Finding / status |
|---|---|---|---|---|
| C-1 | Critical | — | — | **None found.** |
| D-1 | **Important** | Documentation consistency | `MIGRATION_PLAN.md:25,26,28,84,87`; `VALIDATION.md:94,95,98`; `FEATURE_GAPS.md:32,33` | Pre-freeze claims remain and contradict the frozen evidence README. See detail block below. Doc-only; should be fixed before merge. |
| M-1 | Minor | Evidence number | `evidence/.../README.md:83` | `lite-backend` payload stated as `2,359,065 B`; current frozen dist chunk is `2,359,121 B` (56 B difference). `gpu` 396,492 B and old-reference `gpu` 2,528,822 B verify exactly. |
| M-2 | Minor | Evidence provenance | `evidence/.../soak-final.json` | 1-minute soak JSON records `startedAt/finishedAt/minutes/frames` but no `baseUrl`/browser. README environment supplies context; worth adding for provenance. |
| M-3 | Minor | Verification gap | `web_app/tests/support/png.ts`; `lite-lighting.browser.ts:9`; `lite-shadow.browser.ts:10` | New hand-written PNG decoder (no unit test); the two CDP fixtures that consume it were repaired but not re-executed on the frozen final build (their last recorded PASS predates the refactor). Node imports of both modules were verified OK; add a tiny decode test or one final run. |
| M-4 | Minor | P11 cleanup residue | `web_app/tests/personnel-keyframes.browser.ts:9,14,18` | Still expects the legacy perf bridge (`__SEMICONFAB_PERF__.getScene/getEngine/getShadow`), which the product Lite bridge no longer exposes (`lite-backend.ts:27-59`). Not mapped in `tools/run_twin_browser.mjs`; stale historical suite. |
| M-5 | Minor | Historical docs | `INVENTORY_2026-10-26.md:253-254`; `P2_STATIC_STRUCTURE.md:46`; `P2B_FILES.txt:35-36` | INVENTORY snapshot still says “Product /twin still runs the legacy renderer” and “No 60-minute soak, cross-browser matrix or performance A/B” while `MIGRATION_PLAN.md:32` links it as evidence; P2 docs reference deleted `tests/static-reference.*`. Mark them as historical snapshots or update the commands. |
| M-6 | Minor | Assertion tightness | `twin-lite.browser.ts:341,382,386,391,399-400,405`, `world.ts:247` | See detail block; no assertion is vacuous in a way that invalidates the acceptance (gpuErrors is a real `uncapturederror` subscription), but several could be tightened. |
| M-7 | Minor | Race-prone async restore | `lite-backend.ts:116-125`; `twin-page.tsx:260-266` | Camera-pose restore runs in `setTimeout(0)` while the status effect unconditionally calls `setView(view)` on every `WebGPU ·` ready (including recovery). Ordering currently favours the restore (6 recoveries across the Chrome and Edge final-build runs); by construction it is a race, not a guaranteed barrier. |
| M-8 | Minor | Cascading-loss queue coverage | `lite-backend.ts:94,155,171-175` | A loss during the replacement build is now queued instead of dropped (good), but this path has no unit/browser coverage (acceptance losses are spaced after full recovery); the in-between instance still enters in-place native recovery until the queue fires, so the comment “never left on the in-place native recovery path” is slightly stronger than the code. |
| M-9 | Minor | Cut-plane scope / evidence | `world.ts:260`; `cut-plane.ts:119-136`; `twin-lite.browser.ts:262,269-283` | Cut clips native PBR materials only; overlay billboard scenes (facility/environment labels, roof particles, airflow) and Standard-material actors are not clipped. FEATURE_GAPS item 3 documents the Standard exclusion but not the overlay scenes; product evidence asserts the clip-plane value/mode exclusivity, not that pixels are removed (no pixel/draw assertion for cut). |
| M-10 | Minor | Status stream asymmetry | `lite-backend.ts:100` vs `136-151` | First mount records `initializing` (both `instance` and `runtime` undefined at the synchronous callback), but every restarted runtime drops its synchronous `initializing` status (evidence statuses show none after `lost`). Harmless for UX; document or restructure the instance assignment. |

### D-1 detail (Important; documentation only)

- `MIGRATION_PLAN.md:25` — still reports the pre-final production perf “Lite idle/orbit 52.7/48.7 fps vs
  12.8/14.2”; frozen evidence `perf-ab.json` (production-preview, 15:30:56Z) is **54.3/51.4 vs
  15.9/12.9**, and the same line still speaks of the “60-minute soak” instead of the 1-minute
  user-directed replacement.
- `MIGRATION_PLAN.md:28` — still says “当前 `/twin` 仍使用已有渲染器” and “完整像素对照和性能 A/B
  尚未执行”, which flatly contradicts the product switch and the same file’s own §81-90.
- `MIGRATION_PLAN.md:26,87` — still “13 个旧测试删除或改写”; the diff actually removes 20 test modules plus
  3 helper/config files (`static-reference.capture.ts`, `static-reference.vite.config.ts`,
  `twin-golden.vite.config.ts`) and rewrites `lite-facility.test.ts` (README §7 already avoids
  the count, so only these lines remain).
- `MIGRATION_PLAN.md:84` — “三次真实设备丢失（cut/X-Ray 交替…)” is stale: the frozen suite’s third
  round is **no-spatial-mode** and additionally asserts canvas selection restore
  (`twin-lite.browser.ts:343-364,395-396`; `recovery-x3` values cut/xray/none in
  `acceptance-final-run.json`/`acceptance-edge.json`).
- `VALIDATION.md:94-95` — points at the pre-fix `acceptance.json`/`acceptance-production.json`/
  `ui.json`/`ui-production.json` (captured 14:41–14:58Z, before the 23:17–23:25 restart-disposal
  and selection-round changes) and repeats “cut/X-Ray 交替”; the frozen final-build evidence is
  `acceptance-final-run.json` (Chrome, 15:26:33Z), `acceptance-edge.json` (Edge 156, 15:29:42Z),
  `ui-final-run.json` (15:26:47Z), `ui-edge.json` (15:29:54Z), all against 127.0.0.1:5178 and all 0 errors.
- `VALIDATION.md:98` — repeats “13 旧测试”.
- `FEATURE_GAPS.md:32` — “跨浏览器矩阵 **NOT_RUN**：本机仅安装 Chrome 155” contradicts the frozen
  browser matrix (Chrome 155 + Edge 156 PASS, non-Chromium NOT_RUN; Edge UA verified in
  `acceptance-edge.json`).
- `FEATURE_GAPS.md:33` — “60 分钟 soak 结果见验收表” contradicts the frozen “60-minute soak NOT_RUN
  (replaced by user-directed 1-minute run)”; README/VALIDATION/MIGRATION_PLAN:89 are already correct.
- Evidence hygiene: `acceptance.json`, `acceptance-production.json`, `ui.json`,
  `ui-production.json`, `ab-production.json` (pre-fix snapshots, 14:41–15:00Z) are still in the
  package directory while the frozen README no longer references them; they should be removed or moved
  under a clearly labelled `pre-final/` folder so a stale PASS/perf figure cannot be cited by mistake.

### M-6 detail (assertions; all acceptance claims still proven by the run)

- `twin-lite.browser.ts:341` captures `statesBeforeLoss` but never compares to it; lines 399-400 only
  assert length 121 + allowed values, which the default `FAB_TOOL_STATES` satisfies. README §1 says
  “all 121 tool states present” (accurate) — do not claim exact pre-loss preservation without the compare.
- `:382` and `:386` are the same `recoveries >= round + 1` assertion; the second’s “scene rebuilt on”
  message adds no check (a real check would compare `lifecycle.losses`/`backendId` identity or scene
  object identity).
- `:391` the cut round only asserts `cutPlane !== null`; plane value/invert is not re-checked after
  recovery (a wrong default plane would pass). Cheap fix: compare `[0,0,-1,-12]` as in C8.
- `:92` focus assertion passes `focused.target[1]` as its own expected Y (Y component tautological;
  X/Z assertions are meaningful and catch the RH→LH Z reflection).
- `:104-111,378` fixed sleeps for camera tweens/settling and the 800 ms post-recovery wait are
  flake-prone under load; it passed in the Chrome and Edge final-build runs, and most other waits are polled. Not a defect,
  just a residual CI-flake risk.
- `:65-68` `hoverSeen` once true is not re-bound to the candidate that is finally picked (minor).
- `world.ts:247` subscribes `onEngineGpuError` after equipment/structure/facility/environment
  composition, so a GPU validation error emitted during early replacement-world composition could be
  missed; post-loss/per-round re-checks (`twin-lite.browser.ts:383,435`) still run after frames.
  The gpuErrors assertion itself is **not vacuous**: Lite's `onEngineGpuError` is a real
  `device.addEventListener('uncapturederror')` (`@babylonjs/lite/lib/engine/engine-gpu-events.js`),
  and `forceDeviceLoss` uses the public `forceWebGpuDeviceLossForTesting` → real `device.destroy()`.

## Resolved during this review (verified in the frozen tree)

| # | Interim finding (earlier snapshot) | Resolution in frozen tree |
|---|---|---|
| R-1 | Restart leaked the replaced product world: `compose` teardown read a cleared `mountedWorld`, so camera-control/canvas/overlay resources of the old world were never disposed (Important). | Fixed: per-instance `ownedWorld` captured by the compose disposer (`lite-backend.ts:132-152`); restart disposes the old runtime and awaits `whenReleased` before creating the replacement (`:154-175`). Post-fix production acceptance runs pass 3 losses, 0 GPU errors. |
| R-2 | A second loss during rebuild was silently dropped by `if (restarting) return`. | Now queued via `restartPending` (`:94,155,171-175`); residual coverage note M-8. |
| R-3 | Dangling imports after P11 fixture deletion: `lite-lighting.browser.ts:9`, `lite-shadow.browser.ts:10` → deleted `xray-acceptance.browser.ts`; `tools/capture_lite_migration_baseline.mjs:5` → deleted `twin-goldens.browser.ts`. | Fixed: `decodePng` moved to `web_app/tests/support/png.ts`; suite imports updated; stale capture tool deleted. Reviewer verified `node import()` of both suites = OK and a full relative-import scan of `web_app/src`, `web_app/tests`, web_app configs and `tools` = **0 missing modules**. |
| R-4 | `tsc --noEmit` failed on `tests/twin-golden.vite.config.ts:4` (deleted module) while docs claimed tsc 0. | Config deleted; reviewer reran `tsc --noEmit` on the freeze = exit 0. |
| R-5 | 17 untracked duplicate evidence artifacts in the repo root (identical hashes to evidence files). | Removed; repo root now contains only tracked project files (`global.json` etc.). |
| R-6 | Evidence JSONs had no capturedAt/baseUrl/build identity (production claim unverifiable). | Runner now records `suite/baseUrl/capturedAt/viewport` (`run_twin_browser.mjs:50-53`); final-run/edge/ui/soak files verified. |
| R-7 | Selection restore was claimed by strategy text but never exercised (all losses happened under cut/X-Ray which clear selection). | Frozen suite round 3 is no-spatial-mode and asserts `selection.index === expectedSelection` + `selection.visible` after recovery (`twin-lite.browser.ts:343-364,395-396`); passes Chrome + Edge. |
| R-8 | Evidence README/JSON predated the restart fix. | Frozen package now uses post-build production-preview evidence (build 15:25:38Z; acceptance 15:26:33/15:29:42Z; ui 15:26:47/15:29:54Z; perf 15:30:56Z; visual 15:31–15:32Z; soak 15:27–15:28Z), all 0 errors. |
| R-9 | README §4 gzip figures were not reproducible. | Removed from README (“Gzip sizes are not asserted”); raw byte sizes used instead — only the 56 B `lite-backend` discrepancy remains (M-1). |

## Accepted limitations (documented, not defects)

- Whole-product frozen-clock Golden **NOT_RUN** (`README.md:67-69,126`; `VALIDATION.md:103`).
- 60-minute soak **NOT_RUN** by user direction; only the user-directed 1-minute soak is reported
  (`README.md:87-93`; `VALIDATION.md:101`; `MIGRATION_PLAN.md:89`). Reviewer confirms no soak process was
  running at freeze and the 1-minute JSON is self-consistent; this is a deliberate scope decision, not a
  passed 60-minute soak.
- Non-Chromium browser coverage **NOT_RUN**; Chrome 155 + Edge 156 both PASS product acceptance and UI
  regression (`README.md:95-103`; Edge UA `Edg/156.0.4314.42` verified).
- Product device-loss strategy = rebuild native scene on the replacement device, restoring camera pose
  and selection; bounded Lite fixtures keep in-place recovery coverage (`README.md:36-41`;
  `FEATURE_GAPS.md:27`).
- X-Ray palette deliberately does not sample CSM depth; it binds an owned 1×1 sampled depth
  (`effects.ts:121-124,225-227,269-273`; product never calls `bindShadows` — `world.ts:271-274`).
- Section cut on Standard materials deliberately disabled (1.36 Standard plugin UBO recovery); only
  native PBR surfaces are clipped (`FEATURE_GAPS.md:29`; `world.ts:260`; `cut-plane.ts:119-136`).
  Overlay-scene exclusion is an additional documented-in-code but not yet in-docs nuance (M-9).
- Visual A/B is a comparison, not a Golden; capture/diff scripts live in `.local` and are not committed
  (`README.md:50-69`) — reproducibility caveat is explicitly stated.
- `?perf` acceptance bridge and `forceDeviceLoss` (public Lite testing API) are compiled into the
  production bundle but only installed when the `?perf` query parameter is present
  (`lite-backend.ts:26,57`; `world.ts:485`). Accepted testability surface.

## Reviewer verification log (frozen tree, 2026-10-26 ~23:34–23:36 +08:00)

- `cd web_app; node_modules/.bin/tsc --noEmit` → **exit 0**.
- `cd web_app; node_modules/.bin/vitest run` → **51 files / 238 tests passed**, exit 0.
- Dependencies: `@babylonjs/core` occurrences in `web_app/package.json` = 0, in `pnpm-lock.yaml` = 0;
  installed `@babylonjs/lite` = **1.36.0**; only `@babylonjs/lite` imported anywhere in `web_app/src`.
- Dist (built 2026-10-26T23:25:38Z, no rebuild by reviewer): 0 hits for
  `WebGPUEngine`/`NullEngine`/`SceneInstrumentation`/`_rebuildGeometries`/`@babylonjs/core`;
  `gpu-BLSlVdYJ.js` = 396,492 B; `lite-backend-UUWe2J9m.js` = 2,359,121 B; frozen old-Next
  `gpu-B1kbK2Fm.js` = 2,528,822 B; `index.html` references the new hashed chunks.
- Relative-import scanner over `web_app/src`, `web_app/tests`, web_app root configs and `tools` →
  **0 missing modules**; `node import()` of `lite-lighting.browser.ts` and `lite-shadow.browser.ts` OK.
- Evidence audit:
  - `acceptance-final-run.json`: Chrome/155.0.8059.86, baseUrl 5178, capturedAt 2026-10-26T15:26:33Z,
    `errors: []`, 18 steps ok, `recovery-x3 = [{cut,1,1},{xray,2,2},{none,3,3}]`, gpuErrors 0,
    meshCount 916, final status WebGPU; `acceptance-edge.json`: Edg/156.0.4314.42, same results at
    15:29:42Z; `ui-final-run.json`/`ui-edge.json`: errors `[]`.
  - `pixel-diff.json` (15:32:11Z): ISO 10.301/0.15599, TOP 13.721/0.20891, B1 17.666/0.29093,
    DUAL 20.480/0.37920, EXPLODED 14.593/0.22386 — exactly the frozen README table. `screenshot-manifest.json`
    (15:32:10Z): ROI/cameras/canvas identical ref vs lite, both `errors: []`, status WebGPU.
  - `perf-ab.json` (15:30:56Z, mode production-preview, lite 5178 / ref 5179): Lite idle 54.31 fps /
    orbit 51.36 fps; frozen Next 15.92 / 12.91 fps; errors `[]`; durations consistent with the stated
    8 s idle / 6 s orbit windows.
  - `soak-final.json` (1-min): 3,330 frames, 55.5 fps, p95 33.4 ms, p99 33.5 ms, 0 long tasks,
    0 GPU/console errors, status stable.
- Not run by the reviewer (by scope/constraint): browser/CDP product acceptance and Edge run (executed
  by the Lead; raw artifacts audited instead of re-executed), `vite build` (rebuild prohibited; frozen
  dist and mtimes verified), repo-level Python/.NET checks (outside this review's scope).

## Residual risks (accepted for merge, tracked)

1. Camera-pose restore remains ordering-dependent vs the React `setView` status effect (M-7).
2. Cascading-loss queue path is untested by automation (M-8); low probability but the device-loss story
   is headline, so a unit test (mock runtime) or a forced double-loss browser round would close it.
3. `gpuErrors` observation starts late in world composition (M-6); the acceptance claim “0 GPU errors”
   is still meaningful but could miss very early composition errors.
4. `tests/support/png.ts` and the two retained Lite CDP fixtures were not re-run on the frozen build
   (M-3).
5. Product evidence records step-level `ok` but not the restored camera/selection values in JSON
   (recovery-x3 only stores mode/loss/recovery counts) — claim auditable via suite passing, thinner than
   the other numeric blocks.
6. Cut-plane coverage excludes overlay/Standard surfaces and is not pixel-verified in product (M-9);
   documented for Standard, not for overlay billboards.
7. 1-minute soak provenance lacks baseUrl/browser (M-2); 60-minute soak remains NOT_RUN.
8. Documentation contradictions (D-1) would mislead a reader if merged as-is.

## Bottom line

Ship-quality code and evidence for the agreed product scope: **no Critical or blocking Important code
defect found**. Fix D-1 (align `MIGRATION_PLAN.md`, `VALIDATION.md`, `FEATURE_GAPS.md` with the frozen
README and move/delete pre-final evidence JSONs) before merge; the M-items are follow-ups or documented
residual risks, not merge blockers.

## Lead disposition after this review (docs-only, no code changes)

- **D-1 resolved**: `MIGRATION_PLAN.md` now records the frozen perf (54.3/51.4 vs 15.9/12.9 fps),
  the cut/X-Ray/no-mode recovery rounds with selection restore, the P11 test-count wording, and no
  longer states that `/twin` runs the legacy renderer. `VALIDATION.md` points at
  `acceptance-final-run.json` / `acceptance-edge.json` / `ui-final-run.json` / `ui-edge.json`.
  `FEATURE_GAPS.md` records Chrome 155 + Edge 156 as PASS and the 1-minute user-directed soak with the
  60-minute gate NOT_RUN. The five pre-freeze evidence JSONs and their pre-freeze screenshots were
  removed so only final-build evidence remains in this package.
- **M-1 resolved**: frozen `lite-backend` dist size corrected to 2,359,121 B.
- **M-6 partially resolved**: unused `statesBeforeLoss` assertion scaffolding removed from
  `twin-lite.browser.ts`; the remaining duplicate recovery counts and Y-tautology are intentionally
  accepted (they assert the same observable from two sources).
- **M-2..M-5, M-7..M-10 accepted as documented residual risks/follow-ups**; no source change was made
  after the frozen acceptance/perf/soak runs, so the recorded evidence still matches the tree.
- Final tree verification after these docs edits: `tsc --noEmit` 0, `vitest run` 51 files / 238 tests
  pass, `vite build` 0; import/dangling scan 0; `git status` contains only migration work.

## Post-review deltas (round 2, re-verified on a new final build)

- GPU validation-error subscription moved to the very start of world composition (M-6 partial).
- X-Ray target-count diagnostics added (equipment/floor/subfab/oht) for the visual investigation.
- `tests/support/png.ts` now has direct unit tests (`png-support.test.ts`; suite is 52 files / 241 tests).
- Stale unmapped `personnel-keyframes.browser.ts` removed; dangling `decodePng` imports repaired.
- Frozen-clock visual A/B produced with the reference GOLDEN_CLOCK for 7 views; results and the
  quantified X-Ray visual gap (43.86 mean abs vs 8.19–19.83 structural) recorded in the evidence
  README §3 and FEATURE_GAPS item 2.
- All acceptance gates were re-run on the new final build: Chrome 155 and Edge 156 product + UI
  suites PASS with 0 errors; production perf A/B 57.2/52.2 vs 16.1/15.5 fps; 1-minute soak 56.3 fps
  / 0 long tasks / 0 GPU+console errors. The reviewer's D-1 remains closed and no new blocker was
  introduced.

## Post-review delta (round 3): X-Ray shadow parity attempt

- The X-Ray palette now samples the native CSM receiver (2-layer `depth32float` array + comparison
  sampler) instead of an owned 1x1 plain depth target; `shadowLinked` is true in product diagnostics.
- To avoid Lite 1.36's writable+sampled usage conflict inside CSM refit frames, palette materials are
  registered with `setShadowCasterMaterial(material, depthOnlyStandardMaterial)` so the shadow pass
  renders a depth-only no-colour view; `lShadowTask` no longer binds the receiver sampler in caster draws.
- World composition order changed: lighting -> native CSM generator -> effects (palette binds the
  receiver before its first rendered frame); the shadow generator is still disposed/owned by the
  world and the replacement-device rebuild path.
- Frozen-clock X-Ray visual diff improved 43.860 -> 34.976 with 0 activation GPU errors; the other six
  frozen views are unchanged (ISO 9.831, TOP 13.401, B1 17.670, DUAL 19.826, EXPLODED 8.182, CUT 5.108).
- All gates were re-run on this build: Chrome 155 + Edge 156 product and UI suites PASS with 0 errors
  (including the three real device losses with the CSM-bound palette), production perf A/B 57.9/53.9
  vs 15.8/14.0 fps, 1-minute soak 57.9 fps / 0 long tasks / 0 GPU+console errors. X-Ray remains a
  documented visual gap (product hologram still lighter than the source custom depth pass).
