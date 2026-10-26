# LITE-GAP-RECOVERY-002 — Native facility billboard recovery

Scope: `@babylonjs/lite@1.36.0`, two airlock labels in the isolated Lite preview. Product/Golden parity remains **IMPLEMENTING / NOT_PARITY_VERIFIED**.

## Reproduction and native API investigation

- Both labels render initially. Force device loss: geometry, CSM textures and frames resume, but both labels disappear while runtime reports `ready` and console/GPU errors remain empty.
- Installed `lib/sprite/billboard-scene.js` builds the systems through `addDeferredSceneRenderables`. Installed `lib/engine/recovery-rebuild.js` resets renderables and replays only renderables carrying a rebuild thunk; these billboard renderables do not carry one.
- Re-registering the same systems into the main scene would accumulate native picking registrations. Rebuilding a separately owned native label scene avoids that ownership leak.
- A default label scene alone is insufficient: `lib/scene/swapchain-overlay.js` expects a default base MSAA target, while the main scene's transmission path has retargeted that pass. It disables the overlay, hiding labels even before loss. A same-state screenshot comparison alone incorrectly passes in this case.

## Public native API composition

`geometry/facility.ts` retains the native billboard CPU handles and texture ownership. It creates an owned `SceneContext` on the **same surface** as the main scene with `defaultRenderTask:false`, registers the native billboard systems, then adds a native `createRenderTask` targeting `surface.scRT`, with `clr:false` and an owned single-sample depth target. The library owns all rendering, pipeline creation, depth allocation and disposal. The label pass overlays source labels without testing against the FAB's depth, matching the source label policy.

On loss, the stopped scene owner disposes the label context and resets FFU instances. After native recovery, `LiteRuntimeOptions.beforeStart` awaits label registration before requesting a replacement frame and confirming `waitForGpuIdle`. Initialization treats this preparation as part of registration. An in-flight preparation retains engine ownership even if a newer generation completes or fails and the owner is disposed. Old generations cannot restart rendering or publish readiness.

There are no private Lite fields, engine patches, custom WebGPU passes, compatibility classes or dependency changes. The label camera follows the main scene camera; surface resizing uses native render-target sizing.

## Regression evidence

- Original loss regression: mean channel difference **0.1971**, changed fraction **0.00335** after recovery.
- Default-overlay regression: hiding supposedly visible labels produced exactly **zero** image difference, revealing that both states were blank.
- Corrected native task composition: label on/off contribution **0.3955** mean channel difference in the declared ROI. Three losses while ambient/fill/local lights are disabled preserve the frame exactly; restoring lights reproduces the original rig exactly. Rendering contexts remain **2** (main + label) across every loss.
- Runtime tests cover initial preparation, recovered registration failure, disposal while pending, superseded recovery, and old registration outliving both successful and failed newer recovery.
- Final built-fixture results and screenshots are recorded in [review-fix evidence](evidence/review-fixes-2026-10-26/README.md).

No 60-minute soak, cross-browser matrix or whole-product parity is inferred. Revalidate these exact cases before removing this composition when upgrading Lite.
