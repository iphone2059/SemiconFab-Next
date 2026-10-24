# Native WebGPU static shadows implementation plan

> Execute inline in the existing dirty workspace, preserving the ongoing procedural FAB migration.

**Goal:** Replace the simulated equipment shadow planes with visible depth-tested static shadows, then continue original single-FAB UI and geometry parity.

**Architecture:** Use the Babylon engine's GPUDevice to render actual world-space static geometry to depth32float with a native depth-only pipeline. A WGSL receiver in the main Babylon pass compares that same texture using textureSampleCompare. Geometry, light and visibility changes invalidate the cache; camera motion and material colors do not. Release native resources on disposal and recreate them on device restoration. Keep moving OHT/personnel outside the static cache.

**Spec:** User's pasted static-shadow explanation and explicit native WebGPU direction, 2026-10-24.

## Constraints and review focus

- Pure WebGPU, no WebGL fallback, glTF assets, loader dependencies or shadow-generator retries.
- Preserve the existing 121-machine layout and ongoing uncommitted work.
- Test transformed geometry, hidden casters, zero-to-one RH projection, and resource/cache lifecycle.
- Browser checks must measure visible occlusion with shadows enabled/disabled and inspect GPU validation errors; a clean build alone is insufficient.
- Compare HUD/cards/B1 with the preserved original at `../SemiconFab`; do not invent simulation telemetry.

## Tasks

- [x] Add failing geometry/projection tests and a GPU browser acceptance test.
- [x] Implement native depth cache, WGSL main-pass receiver and disposal/recovery (loss-injection acceptance remains separate).
- [x] Remove baked equipment shadows; connect layer/Explode/B1 invalidation.
- [x] Verify typecheck, unit tests, production build, GPU evidence and existing browser interactions.
- [x] Prioritize the user's subsequent exact-machine requirement: port all 117 original family templates and four catalog models; verify all 121 transforms/bounds against original runtime data, including vertex colors, catalog part materials and wire geometry.
- [x] Extend OEM cards and B1 pipework and rerun acceptance.
- [ ] Complete the remaining original HUD / full-page visual parity (outside this machine-geometry acceptance).
- [x] Record actual results and remaining parity limits in migration progress.
