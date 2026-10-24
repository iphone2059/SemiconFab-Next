# Captured evidence — 2026-10-25

Status: **NOT_PARITY_VERIFIED**. These files expose remaining differences; they
are not an approved visual baseline or a release certificate.

- `golden/`: 11 original/Next PNG pairs plus per-state DOM coordinates, font,
  colour, disabled and interactive-control JSON. The source is the final custom
  121-tool layout at the frozen original commit. Same 1536×735 CSS viewport,
  DPR 2, Chinese, declared seed and virtual animation clock. Captures are CSS-size
  PNGs; their actual dimensions are included in `golden/comparison.json`.
- `golden/comparison.json`: full-frame and common-scene Gaussian SSIM, RGB
  differences, PNG hashes and diff heatmaps. Scores are around 0.37–0.65, so
  complete visual equivalence is **not** established. The original/Next demo
  streams and source initialization order also remain different.
- `runtime-coverage.json`: visible source IDs across these states. This is
  rectangle-based coverage, not event/occlusion/tooltip/video acceptance.
- `geometry-acceptance.json`: all 121 actual GPU-scene identities, transforms and
  bounds match the independently extracted original fixture; maximum bounds
  difference is about 0.0000008524 metres. This is conceptual source parity, not
  manufacturer-certified CAD or dimensions.
- `native-shadow-acceptance.json`: static cache invalidation, visible shadow
  contrast, unchanged ambient and clean GPU validation.
- `cut-shadow-acceptance.json`: shared world clipping, depth coverage recovery
  and visible Cut shadows.
- `device-loss-acceptance.json` / `device-loss-aero-acceptance.json`: actual
  GPUDevice.destroy, new native depth pass, completed-frame status, validation
  errors and unchanged manual camera. The Aero variant has 1500 sprites enabled.
- `gesture-acceptance.json`: ctrl-wheel and two-touch pinch change camera radius
  while browser page scale stays 1.
- `camera-acceptance.json`: initial ISO and Top/Litho/Airlock positions/targets.
- `ui-acceptance.json`: single-page routing/home without canvas, modes,
  Research re-entry, focused Esc, zh/en persistence, 12px text and English search.
- `browser-renderer.json`: actual browser/viewport, WebGPU flag, shader patches,
  sprite count and absence of glTF/GLB requests. Only this Chrome/Windows surface
  was accepted; no multi-browser, 60-minute or VRAM claim is made.

## Reproduce

Start the ordinary API using the repository development instructions. Do not
change user/browser settings or use a WebGL renderer to obtain a passing result.
Verify original-source drift and install optional image comparison dependencies:

```powershell
python tools/build_twin_inventory.py --check
python -m pip install -r tools/visual-requirements.txt
```

Write `GOLDEN_CLOCK` exported by `web_app/tests/twin-goldens.browser.ts` to an
ignored `.local/twin-golden-clock.js` (Node 26 can import this TypeScript file).
Serve the unchanged reference using:

```powershell
python tools/serve_twin_reference.py --root ../SemiconFab --clock .local/twin-golden-clock.js --port 5179
```

Start a separate capture-only Vite configuration from `web_app`, supplying the
same process-local API development key used by the ordinary dev server:

```powershell
npm run dev -- --config tests/twin-golden.vite.config.ts --port 5177
```

This configuration injects the declared seed/clock only for `?parity=1` and uses
its own ignored Vite cache. Ordinary product dev/build never select it. Open the
reference with `?layout=/twin/layout-default.json&mode=engineer&lang=zh-CN&parity=1`
and Next with `?mode=engineer&lang=zh-CN&parity=1` in connected browser tabs.
Check **actual** viewport/DPR equality before capturing; comparison rejects a
mismatch instead of silently resizing/alignment-correcting it.

Use the connected tabs' CDP transports with `waitForGoldenReady` and
`prepareGoldenCase`; save their returned JSON and each tab's screenshot.
`twin-parity.browser.ts`, `twin.browser.ts` and `native-static-shadows.browser.ts`
export the GPU/UI checks for the same connected-tab transport. Geometry checks
take `tests/fixtures/original-tool-reference.json`'s `tools` array. No test-only
scene API is shipped by the product. Runtime attachment relies on Vite's
development module graph, so this harness is not a production-bundle test.

```powershell
python tools/compare_twin_goldens.py
```

Archive a newly reviewed baseline separately when source, browser, camera,
lighting or fixed data changes. Do not overwrite an accepted Golden with a
failing result or infer human acceptance from the existence of PNGs.
