# X-Ray transparent compositing through the linear transmission target

Status: **OPEN / NOT_PARITY_VERIFIED**, 2026-10-27. This is a renderer-composition gap, not a reason to fit the palette's lighting constants.

## Target and confirmed behavior

The frozen Next ShaderMaterial writes its RGB and alpha directly to the display target. Lite 1.36's transmission path renders the FAB into `rgba16float` and runs a trailing image-processing gamma encode. ShaderMaterial does not automatically compensate this path. The isolated GPU fixture initially measured `[20,40,61]` directly and `[81,110,133]` through transmission for the identical opaque surface, with zero GPU errors.

The repaired shader inverse-encodes its output only when `scene.vImageInfos.w < 0`. Removing the old fitted shadow-contrast multiplier also restores the frozen `.35 + .65 * shadow` response: the controlled unshadowed sample is now `[35,70,105]` in both paths, maximum channel error 0.

This proves the **opaque** response. It does not prove transparent composition. With ordinary source-alpha blending, inverse-encoding each foreground fragment is not equivalent to blending the displayed source values. Over black, displayed color `c` and alpha `a` produce `c * a^(1/2.2)` rather than `c * a`. The discrepancy also depends on the background and on overlapping layers; changing a single alpha/brightness constant cannot correct it generally.

The real GPU ghost probe confirms this: alpha .15 over black yields `[19,19,19]` directly and `[54,54,54]` with transmission (35-channel error); over white it yields `[236,236,236]` vs `[241,241,241]` (5-channel error). These are failing parity measurements, not accepted Golden thresholds.

## Public API/source evidence

Pinned installed package: `@babylonjs/lite@1.36.0`.

- `lib/material/shader/shader-pipeline.js`: alpha materials use `src-alpha` / `one-minus-src-alpha`.
- `lib/frame-graph/transmission.js`: retargets scene rendering to a linear floating-point target.
- `lib/frame-graph/image-processing-task.js`: applies gamma after the render task's composition.
- Public `createShaderMaterial`/custom blend descriptors cannot express a nonlinear blend depending on destination RGB. Pre-powering fragment RGB solves opaque surfaces only.
- Public native `createRenderTask`, `addMeshToTask`, `removeMeshFromTask`, `createRenderTargetTexture` and ordered frame-graph tasks remain candidates for a dedicated display-space overlay. No Lite source changes/private GPU fields are required or introduced in this increment.

## Reproduction and required closure

`tests/lite-effects-color/main.ts` is an isolated GPU fixture, served with `tests/lite-effects-color.vite.config.ts`. `runLiteEffectsColorAcceptance` checks opaque colors; `runLiteEffectsGhostProbe` separately measures a single alpha-.15 surface over black and white, with and without transmission. Its status must remain NOT_PARITY_VERIFIED while either background differs by more than two channel values.

Closing this gap requires a native task composition that blends ghost/line surfaces after the transmission output encode, while preserving main-scene depth, source transparency ordering, instanced identities and shadow bindings. It needs a dedicated bounded implementation and tests for overlapping ghosts, both backgrounds, all six filters, leaving X-Ray, three replacement-device rebuilds, and normal-view/cut regression. No new low-level renderer is added without that evidence. Full-product Golden acceptance remains open independently of the opaque-color test.
