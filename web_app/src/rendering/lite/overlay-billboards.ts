import {
  addFacingBillboardSystem, addTask, createFacingBillboardSystem, createRenderTarget, createRenderTask,
  createSceneContext, disposeScene, getFrameGraph, registerScene,
  type EngineContext, type SceneContext,
} from '@babylonjs/lite';

export type OverlayBillboardSystem = ReturnType<typeof createFacingBillboardSystem>;

/**
 * Owned overlay scene for native billboard systems (LITE-GAP-RECOVERY-002).
 *
 * Lite 1.36's scene recovery drops deferred billboard renderables, and the main scene's
 * transmission path retargets the default MSAA pass that the automatic swapchain overlay
 * expects. Both source label/particle systems therefore render from their own scene on the
 * same surface: register() rebuilds the native billboard renderables after every device
 * recovery, and the owned render task overlays the main scene's retargeted colour target
 * with its own single-sample depth target.
 *
 * The library owns all rendering, pipeline creation, depth allocation and disposal; callers
 * own only the systems and the camera binding.
 */
export function createOverlayBillboards(scene: SceneContext, engine: EngineContext) {
  let overlay: SceneContext | undefined, registration: Promise<void> | undefined, disposed = false, name = 'overlay-billboards';
  function dispose() {
    disposed = true;
    if (overlay) disposeScene(overlay);
    overlay = undefined; registration = undefined;
  }
  return {
    get scene(): SceneContext | undefined { return overlay; },
    /** Register the given systems into a freshly owned overlay scene; idempotent per generation. */
    register(systems: readonly OverlayBillboardSystem[]): Promise<void> {
      if (disposed) return Promise.resolve();
      if (registration) return registration;
      const next = createSceneContext(scene.surface, { defaultRenderTask: false });
      overlay = next; next.camera = scene.camera;
      for (const system of systems) addFacingBillboardSystem(next, system);
      const pending = registerScene(next).then(() => {
        if (disposed || overlay !== next) return;
        // Add the native swapchain overlay after registration: the automatic MSAA overlay
        // expects a default base pass, which the transmission path has retargeted.
        const depth = createRenderTarget({ dFormat: 'depth24plus-stencil8', samples: 1, size: scene.surface });
        addTask(next, createRenderTask({ name, rt: scene.surface.scRT, depth, clr: false }, engine, next));
        getFrameGraph(next).build();
      }).catch(error => {
        disposeScene(next);
        if (overlay === next) { overlay = undefined; registration = undefined; }
        throw error;
      });
      registration = pending;
      return pending;
    },
    /** Keep the overlay camera bound to the main scene camera after (re)mount and per frame. */
    syncCamera(main: SceneContext) { if (overlay) overlay.camera = main.camera; },
    setName(value: string) { name = value; },
    dispose,
  };
}
