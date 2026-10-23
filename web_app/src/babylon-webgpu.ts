import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { _CommonDispose } from '@babylonjs/core/Engines/engine.common';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { FabPlacement, SceneBackend } from './fab-scene';
import { InitializationDisposal } from './babylon-lifecycle';

/** Estimated geometry in metres, right handed, +Y up. No authoritative simulation state. */
export function createWebGpuBackend(): SceneBackend {
  let engine: WebGPUEngine | undefined;
  let scene: Scene | undefined;
  let cleanup = () => {};
  let disposed = false;
  let deviceLost = false;
  let initialized = false;
  let attachedCanvas: HTMLCanvasElement | undefined;
  const disposal = new InitializationDisposal(() => {
    scene?.dispose(); scene = undefined;
    if (!engine) return;
    if (initialized) engine.dispose();
    else {
      // Babylon 9.32's WebGPU dispose dereferences helpers absent after failed init.
      // Destroy a partial device and use its base/DOM cleanup; this is version pinned.
      engine._device?.destroy();
      _CommonDispose(engine, attachedCanvas ?? null);
      AbstractEngine.prototype.dispose.call(engine);
    }
    engine = undefined;
  });
  return {
    async mount(canvas: HTMLCanvasElement, fabs: readonly FabPlacement[], signal: AbortSignal, onStatus: (status: string) => void): Promise<void> {
      if (!window.isSecureContext || !navigator.gpu) throw new Error('此终端无法使用 WebGPU。请使用支持 WebGPU 的浏览器，并通过 HTTPS 或 localhost 访问。');
      const adapter = await navigator.gpu.requestAdapter();
      if (signal.aborted || disposed) return;
      if (!adapter || adapter.limits.maxTextureDimension2D < 2048) throw new Error('WebGPU adapter 或必要纹理限制不满足要求。');
      attachedCanvas = canvas;
      try {
        engine = new WebGPUEngine(canvas, { antialias: true, enableAllFeatures: false, deviceDescriptor: { requiredFeatures: [], requiredLimits: {} } });
      // Babylon rebuilds resources on a fresh device; no old buffers are reused.
      engine.onContextLostObservable.add(() => {
        if (signal.aborted || disposed) return;
        deviceLost = true; engine?.stopRenderLoop();
        onStatus('GPU 设备已丢失，正在重建设备和静态场景。若未恢复，请重新加载视图。');
      });
      onStatus('正在初始化 WebGPU…');
        await engine.initAsync(); initialized = true;
      } finally { disposal.settled(); }
      if (signal.aborted || disposed || !engine) { disposal.dispose(); return; }
      if (deviceLost) throw new Error('初始化期间 GPU 设备已丢失，请重新加载视图。');
      scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      scene.clearColor = new Color4(0.047, 0.09, 0.133, 1);
      const camera = new ArcRotateCamera('site-camera', -Math.PI / 2, Math.PI / 3, 150, new Vector3(0, 0, 0), scene);
      camera.lowerRadiusLimit = 40; camera.upperRadiusLimit = 280; camera.attachControl(canvas, true);
      new HemisphericLight('ambient', new Vector3(0, 1, 0), scene).intensity = 1.2;
      const floorMaterial = new StandardMaterial('floor', scene);
      floorMaterial.diffuseColor = new Color3(0.1, 0.19, 0.25);
      const toolMaterial = new StandardMaterial('tools', scene);
      toolMaterial.diffuseColor = new Color3(0.2, 0.7, 0.64);
      const floor = MeshBuilder.CreateBox('shared-floor-template', { width: 38, depth: 48, height: 0.6 }, scene);
      floor.material = floorMaterial; floor.isVisible = false;
      const tool = MeshBuilder.CreateBox('shared-tool-template', { width: 4, depth: 6, height: 3 }, scene);
      tool.material = toolMaterial; tool.isVisible = false;
      for (const fab of fabs) {
        const root = new TransformNode(fab.fabId, scene); root.position.set(...fab.position);
        const base = floor.createInstance(`${fab.fabId}:floor`); base.parent = root; base.isVisible = true;
        for (let i = 0; i < 12; i++) {
          const instance = tool.createInstance(`${fab.fabId}:placeholder-${i}`);
          instance.parent = root; instance.position.set((i % 3 - 1) * 10, 1.8, (Math.floor(i / 3) - 1.5) * 10); instance.isVisible = true;
        }
      }
      const resize = () => engine?.resize();
      const visibility = () => { if (document.hidden || deviceLost) engine?.stopRenderLoop(); else engine?.runRenderLoop(render); };
      const render = () => { if (!signal.aborted && !disposed && !deviceLost) scene?.render(); };
      engine.onContextRestoredObservable.add(() => {
        if (signal.aborted || disposed) return;
        deviceLost = false; onStatus('WebGPU 设备和静态场景已重建 · 估算占位几何');
        if (!document.hidden) engine?.runRenderLoop(render);
      });
      window.addEventListener('resize', resize); document.addEventListener('visibilitychange', visibility);
      cleanup = () => { window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', visibility); };
      engine.resize(); engine.runRenderLoop(render);
      onStatus('WebGPU · 估算占位几何 · 拖动旋转 / 滚轮缩放');
    },
    dispose(): void { disposed = true; cleanup(); engine?.stopRenderLoop(); disposal.dispose(); },
  };
}
