# Lite review fixes implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this bounded repair. Steps use checkboxes for tracking.

**Goal:** Fix all four findings from the code review: lost labels, split ambient state, overridden unlit materials and optional screenshot output failures.

**Architecture:** Keep pinned Lite 1.36 and use its public APIs. Facility labels use a separately owned native SceneContext, rebuilt after device loss; the runtime awaits an optional beforeStart hook during initial setup and recovery before confirming a GPU frame. Lit PBR materials retain the source falloff plugin; unlit materials use Lite's own shading.

**Tech Stack:** TypeScript, Babylon Lite 1.36, Vitest, real WebGPU Chrome/CDP.

**Spec:** The four findings in this conversation; `docs/SemiconFab-Next_Babylon-Lite_Native-Migration_Guide_2026-10-26.md`.

## Global constraints

- Work in the existing feature checkout: the reviewed files include the user's uncommitted work.
- Preserve the product renderer, 121 equipment identities, source geometry and pinned dependencies.
- Use public Lite scene, billboard, light and material APIs; no private fields, custom GPU pass or engine fork.
- Completion is scoped to these repairs; retain IMPLEMENTING / NOT_PARITY_VERIFIED.
- Leave the user's changes and these repairs uncommitted for review.

## Review focus

- Initial setup and recovery must await label registration; disposal must wait for any in-flight registration.
- Repeated losses must retain one label context, two billboards and the current camera/layer/light state.
- Ambient toggles must affect native Standard and plugin PBR paths together.
- Unlit materials must ignore key/fill/ambient/local light changes.
- Both browser suites must work with and without LITE_EVIDENCE_DIR.

## Tasks

### Task 1: Restore labels through native scene ownership

Files: `src/render/lite/runtime.ts`, `geometry/facility.ts`, `tests/lite-runtime/main.ts`, `tests/lite-runtime.test.ts`, `tests/lite-shadow.browser.ts` (under web_app).

Interface: `LiteRuntimeOptions.beforeStart?(scene, engine): void | Promise<void>`; facility `registerLabels(): Promise<void>`; facility recovery preparation disposes only its label scene and resets FFU instances.

- [x] RED: add runtime tests for awaited preparation, failure cleanup, disposal during preparation and stale recovery suppression. Add post-loss label-region pixel comparison to the shadow browser suite and observe its failure.
- [x] GREEN: add the awaited runtime barrier; create/register/dispose label scenes through native functions and preserve billboard CPU handles.
- [x] Verify three losses, current off-light state, layer state, remount and no context growth on real GPU.

### Task 2: Keep native lighting and material semantics

Files: `web_app/src/render/lite/lighting.ts`, `web_app/tests/lite-lighting.test.ts`, GPU fixture/suite.

- [x] RED: ambient disable must write zero to the real native light and PBR UBO; restore must recover 0.48. An unlit material must retain its native result under light changes.
- [x] GREEN: call setLightIntensity for ambient and exclude getPbrUnlit materials from the source lighting plugin.
- [x] Verify real GPU Standard ambient response and unlit invariance, alongside existing lighting thresholds.

### Task 3: Optional evidence output and final verification

Files: `web_app/tests/lite-lighting.browser.ts`, `web_app/tests/lite-shadow.browser.ts`, migration validation/gap records.

- [x] RED: run both suites without LITE_EVIDENCE_DIR and observe screenshot-path failure.
- [x] GREEN: return an empty screenshot-path list when output is disabled; keep configured output paths unchanged.
- [x] Run npm test, typecheck, production/Lite builds and all applicable Lite GPU suites; inspect before/after label captures.
- [x] Fresh read-only review of the repairs, resolve substantive findings and update evidence records.

## Final evidence

See `docs/migration/babylon-lite/evidence/review-fixes-2026-10-26/README.md` and `acceptance.json`. 238 unit tests, typecheck, both builds and five built-fixture WebGPU suites pass. The labels' native render task is added after registering the no-default-task label scene, avoiding Lite 1.36's automatic MSAA overlay/transmission conflict. Label on/off visibility is checked before recovery comparisons; three recoveries and full-light restoration are pixel-identical to their respective baselines. No deferred findings; changes remain uncommitted.
