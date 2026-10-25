# SemiconFab /twin WebGPU parity repair — iteration 2 (2026-10-25)

**Branch**: `fix/twin-parity-personnel-exploded-20261025` (main is untouched)  
**Frozen original**: `jinjiefan2020/SemiconFab@b3666132e5d8cab2cebe4c4227fc04c52242eb28`  
**Next base**: `6e4cf16699c765b4318057c611da8b26ef776c2a`  
**Scope**: `twin.html` ↔ `/twin` only. Do not modify the Next homepage or other sites.  
**Stack constraint**: React 19 + TypeScript/TSX + Babylon.js **WebGPU-only** + existing ASP.NET Core. No Three.js/WebGL runtime, no iframe.

## Implemented patches

| Source | Change |
| --- | --- |
| `web_app/src/procedural-fab.ts` | Frozen six PERSONNEL coordinates, patrol locomotion/limb frames and tablet colors from `createPersonnelTimeline`; restores overhead original status billboard; removes independent sinusoidal walk |
| `web_app/src/original-patrol-status.ts` | Original 512×128 pill/status canvas, 3.2×0.8 Babylon billboard with translucent unlit material; bilingual initial as-built status; updates texture only on locale changes |
| `web_app/src/original-facility-architecture.ts` | Original air-shower indicators/jets/interior lights/label positions consume the single personnel timeline; disables secondary realtime timekeeper once bound |
| `web_app/src/legacy-site.ts` | Single 16ms personnel source-clock with bounded catch-up and seed=42; source exploded 0.08 easing, ceiling +20m, Subfab −18m, floor B1=0.2 / DUAL=0.35 / exploded=0.55; source 12 L1↔B1 conduits with animated rings; preserves X-Ray subfab visibility; avoids per-frame full scene graph level sync |
| `web_app/src/twin-spatial.ts` | Pure exploded factor, displacement and material mode functions |
| `web_app/src/original-exploded-link-data.ts` | Twelve authentic B1 connectedTool→L1 host pairs extracted from the frozen original `FAB_EQUIPMENT`, with both endpoints, source svgType and colors; separate from the 121-site layout |
| `web_app/src/original-exploded-links.ts` | Babylon conduit cylinders (r=0.14m, h=7m) and white pulse torus (R=0.28m, tube=0.04m), source scaling/phase travel; excluded from native static shadow caster list |
| `web_app/src/fab-scene.ts`, `web_app/src/fab-viewer.tsx`, `web_app/src/twin-page.tsx`, `web_app/src/babylon-webgpu.ts` | Explicit exploded `modeActive` distinct from 0% slider; source entry pose (55,44,72) targeting (0,-4,0), exit default pose; backward-compatible optional argument |
| `web_app/tests/twin-spatial.test.ts` | Source displacement/easing/level-opacity tests |
| `web_app/tests/original-exploded-links.test.ts` | Source link count, exact endpoint samples, conduit scaling and sinusoidal ring motion |

### Original observed-data edge cases
- Original `twin.html` has **12 B1-connected reference devices**, but `twin/layout-default.json` has zero B1 records. The interconnect renderer therefore uses a distinct 12-row *reference* inventory and NEVER adds these as new tool identities to the 121 layout.
- The original `buildCleanroomPersonnel()` overwrites the patrol actor's `userData` after creating its status sprite. That makes its later status-sprite update references unavailable: preserve the visible initial billboard for as-built parity instead of inventing live status text. The user's frozen-source `as-built` timeline mode also records two air-shower `timer` references lost by userData rewriting (non-finite). A separate preserved-mode enhancement must be explicitly opt-in and visually reviewed.
- The exact global original `Math.random` draw order is not reproduced; the explicit seed 42 controls reproducibility but does **not** claim bit-identical scene initialization.
- Link ring phase uses deterministic per-link seed instead of the original unseeded random phase; source geometry and timing formulas are preserved.

## Tests and reproducibility

Source file existence/import paths have been checked against branch Git tree. **TypeScript compilation, Vitest, live WebGPU browser acceptance and GPU performance tests have NOT been executed for this iteration.** GitHub Actions push workflow previously reported `startup_failure` (job did not run). Do not merge based only on code review or this document.

Run locally using Node 26/pnpm 12 as pinned:

```powershell
git fetch origin fix/twin-parity-personnel-exploded-20261025
git switch --track origin/fix/twin-parity-personnel-exploded-20261025
cd web_app
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
cd ..
pwsh -File scripts/verify.ps1
```

Then capture original and Next at equal Chrome/Edge WebGPU adapter, browser build, DPI, resolution, locale, seed and source clock:
1. 121-equipment geometry unchanged and native depth/shadow GPU errors remain zero.
2. L1/B1/DUAL/Exploded (0%, 50%, 100%) and interconnect count=12 with active/disabled state.
3. Exploded slider 0% must keep active mode/camera; leaving mode must restore prior camera.
4. X-Ray 6 filters, Cut, Roof/FFU, Subfab, repeated mode toggles; exact materials and shadows restored.
5. Patrol source frames around approach, purge transition and airlock; source as-built/intentional split documented.
6. Both zh-CN/en-US, desktop/mobile viewport, complete control matrix, original vs Next screenshot SSIM/difference.
7. Production bundle/real browser performance and 60-minute GPU lifetime plus ≥3 sequential device-loss recoveries.

## Remaining unverified or open
- **Visual 1:1 has not been achieved or certified**. Existing 11 legacy screenshots gave SSIM only ~0.37–0.65 on an earlier revision; this branch needs fresh calibrated Golden captures and ROI comparisons.
- Source-complete 70 vortex particle render and entire original randomness/animation synchronization, Tour/Wafer keyframes remain outstanding. The as-built source normally has a zero-opacity vortex unless preserved metadata is enabled.
- Pixel-exact HUD/Inspector dialogs/tooltips, source bilingual strings and responsive controls require full audit.
- Main-thread/GPU bottleneck ~1,700 Draw Calls/~20 FPS on previous *headless* baseline has not been optimized (no safe renderer A/B hardware profile in this run).
- CI build/typecheck, production Chrome/Edge matrix and long-term resource validation remain hard release gates.

**Status: IMPLEMENTING / NOT PARITY_VERIFIED.** Keep patch isolated until objective tests pass.

## Lead integration verification (2026-10-25)

The bundle was applied to `main` on top of `6e4cf16` and verified in this checkout. Two follow-up fixes
were required before the checks below went green: `babylon-webgpu.ts` must forward the explicit
`modeActive` flag to the legacy runtime (otherwise a 0% slider silently leaves exploded mode), and
`twin-page.tsx` must reset the preset to 100% on entry / 0% on exit and own the level camera poses
(the backend transition was overriding B1/DUAL poses). `NativeShadowMaterial` also now declares a
plugin define so non-plugin PBR materials cannot share its effect and log WebGPU validation errors.

Verification executed:

- `web_app`: `tsc --noEmit` 0; `vitest run` 44 files / **163 tests pass**; `vite build` pass.
- `python tools/check_architecture.py` pass; all frozen-source extractor `--check` gates stable.
- Production Vite bundle served with an `/api` proxy; Headless Chrome 155 WebGPU, 1600×900 DPR 1:
  `web_app/tests/twin-exploded.browser.ts` passes — 121 tool identities unchanged, 12 links, source
  displacement +20/−18 m, floor opacity 1/0.2/0.35/0.55, entry/exit/level camera poses, caster count
  771→970→771, shadow cache settled at 95 passes, X-Ray during exploded restores 2,236 shader surfaces
  and floor 0.55, patrol actor moved 1.66 m, zero console/device errors. Evidence:
  `docs/migration/twin-parity/evidence/twin-exploded-acceptance-2026-10-25.json` plus the two PNGs.
- Regression acceptance re-run: Twin UI; native static shadow (79,290 darkened pixels, 0 errors);
  X-Ray (2,236 surfaces, shadow pixel delta, exact restore) — all pass.

Remaining open items are unchanged: matched-Golden SSIM/ROI comparison against the frozen original,
source-complete vortex rendering, complete randomness/animation sync, Tour/Wafer keyframes,
HUD/tooltip/responsive audit, the performance profile and the 60-minute/device-loss matrix.

