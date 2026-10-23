// Babylon.js WebGPU-only bootstrap, intentionally no WebGL fallback.
// Use with latest validated @babylonjs/core; target browser must support WebGPU.
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { Scene } from '@babylonjs/core/scene';

export interface WebGpuApp {
  engine: WebGPUEngine;
  scene: Scene;
  dispose(): void;
}

export async function createWebGpuOnlyApp(canvas: HTMLCanvasElement): Promise<WebGpuApp> {
  if (!window.isSecureContext) {
    throw new Error('WebGPU requires HTTPS or a trustworthy local origin.');
  }

  const isSupported = await WebGPUEngine.IsSupportedAsync;
  if (!isSupported) {
    throw new Error('WebGPU not supported: check browser, GPU and driver. WebGL is prohibited.');
  }

  const engine = new WebGPUEngine(canvas);
  try {
    await engine.initAsync();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true; // Documented Site/FAB coordinate contract.

    engine.runRenderLoop(() => {
      if (!scene.isDisposed) scene.render();
    });

    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);
    return {
      engine,
      scene,
      dispose() {
        window.removeEventListener('resize', onResize);
        engine.stopRenderLoop();
        scene.dispose();
        engine.dispose();
      },
    };
  } catch (error) {
    engine.dispose();
    throw error;
  }
}

// Production integration shall additionally implement WebGPU device-loss
// telemetry/reinitialization, snapshot resubscription, LOD/resource budgets,
// browser/GPU allowlists, and automated no-WebGL checks.
