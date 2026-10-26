# Review repair evidence — 2026-10-26

Status: the four review defects are repaired in the isolated Lite preview. Whole-product migration remains **IMPLEMENTING / NOT_PARITY_VERIFIED**. Dependencies and the product `/twin` renderer are unchanged.

## Repairs

- Native facility billboards survive device loss. An owned label SceneContext and native render task overlay the source labels on the same surface. Runtime awaits feature registration and GPU completion before `ready`, and waits for every in-flight generation before engine disposal. See [LITE-GAP-RECOVERY-002](../../LITE-GAP-RECOVERY-002.md).
- Ambient changes synchronize native Standard lighting and the PBR plugin via `setLightIntensity`.
- Native unlit materials are detected with `getPbrUnlit` and retain Lite's own shading.
- Both browser suites return `screenshots: []` when `LITE_EVIDENCE_DIR` is unset, and still save configured evidence.

## Current verification

Final source: 238/238 Vitest tests (55 files), TypeScript, production build and the isolated Lite build pass. Builds retain the existing large-chunk warning. The five built-fixture GPU suites in [runs](runs) pass with no console/runtime/GPU errors on Chrome 155 / Intel gen-12lp WebGPU. Lighting and shadow suites also pass with screenshot output enabled. Exact source/image hashes and measured results are in [acceptance.json](acceptance.json).

- Unlit all-lights-on/off mean channel difference: **0**.
- Native Standard ambient luminance contribution: **12.6455**.
- Labels on/off mean channel difference: **0.3955**, proving the baseline actually draws labels.
- Three losses with ambient/fill/local lights disabled: each recovered image has mean difference **0**, changed fraction **0**, and **2** contexts (main + labels).
- Restoring the full rig after those losses reproduces the baseline exactly. The [before](labels-before-loss.png) and [after](labels-after-three-losses.png) images have identical SHA-256 hashes and visibly contain both labels.

The regression was observed failing before repair: original device loss removed labels (mean delta 0.1971), an initial default-overlay attempt hid labels even before loss (visibility delta 0), native ambient stayed at 0.48 after disabling, the unlit GPU probe changed by 1.2751, and both default-output suites threw `undefined.split`. Tests now guard the actual visible behavior as well as state/resource counts.

An independent read-only review examined lifecycle/ownership/material/output handling. Visual inspection additionally caught the default-overlay problem; its label visibility regression was verified RED then GREEN. The reviewer coverage recommendation for failed newer recovery while an older preparation remains pending was incorporated. No deferred review findings remain.

## Reproduction

From `web_app`:

```powershell
npm test
npm run typecheck
npm run build
npx vite build --config tests/lite-runtime.vite.config.ts
npx vite preview --config tests/lite-runtime.vite.config.ts --host 127.0.0.1 --port 5177 --strictPort
```

With a dedicated WebGPU Chrome CDP endpoint on 9501, run from the repository root:

```powershell
Remove-Item Env:LITE_EVIDENCE_DIR -ErrorAction SilentlyContinue
foreach ($suite in @('lite-lighting','lite-shadow','lite-static','lite-equipment','lite')) {
  node tools/run_twin_browser.mjs $suite 9501 http://127.0.0.1:5177 ".local/$suite.json"
  if ($LASTEXITCODE -ne 0) { throw "GPU suite failed: $suite" }
}
$env:LITE_EVIDENCE_DIR = '.local/review-fix-captures'
node tools/run_twin_browser.mjs lite-lighting 9501 http://127.0.0.1:5177 .local/review-lighting.json
node tools/run_twin_browser.mjs lite-shadow 9501 http://127.0.0.1:5177 .local/review-shadow.json
```

The layout-projection reference suite was not rerun for this repair (tool geometry and coordinate-frame modules were unchanged). No cross-browser, long soak or whole-product/Golden result is claimed.
