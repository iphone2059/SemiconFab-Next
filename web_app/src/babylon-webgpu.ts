import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { _CommonDispose } from '@babylonjs/core/Engines/engine.common';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import '@babylonjs/core/Culling/ray';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { AmhsStats, FabPlacement, HoveredTool, PickedTool, SceneBackend, SceneLayer, SceneViewPreset } from './fab-scene';
import { InitializationDisposal } from './babylon-lifecycle';
import { loadLegacyFab, type LegacyRuntime } from './legacy-site';
import { FAB_LAYOUT, FAB_TOOL_STATES, type FabToolState } from './fab-layout';

interface CameraPose {
  alpha: number;
  beta: number;
  radius: number;
  target: Vector3;
}

interface CameraTransition {
  from: CameraPose;
  to: CameraPose;
  startedAt: number;
  duration: number;
}

/** Estimated geometry in metres, right handed, +Y up. No authoritative simulation state. */
export function createWebGpuBackend(): SceneBackend {
  let engine: WebGPUEngine | undefined;
  let scene: Scene | undefined;
  let camera: ArcRotateCamera | undefined;
  let cameraTransition: CameraTransition | undefined;
  let homeRadius = 89;
  let clearPicked: () => void = () => {};
  let selectToolAt: (index: number, focus?: boolean) => void = () => {};
  let refreshSelection: () => void = () => {};
  let legacyRuntime: LegacyRuntime | undefined;
  let toolStates: FabToolState[] = [...FAB_TOOL_STATES];
  let touring = false;
  let basementEnabled = false;
  let lastFrameTime = performance.now();
  const fabTargets = new Map<string, Vector3>();
  let cleanup = () => {};
  let disposed = false;
  let deviceLost = false;
  let initialized = false;
  let attachedCanvas: HTMLCanvasElement | undefined;
  const disposal = new InitializationDisposal(() => {
    cameraTransition = undefined;
    camera = undefined;
    clearPicked = () => {};
    selectToolAt = () => {};
    refreshSelection = () => {};
    legacyRuntime = undefined;
    toolStates = [...FAB_TOOL_STATES];
    touring = false;
    fabTargets.clear();
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
  const reduceMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const applyPose = (pose: CameraPose) => {
    if (!camera) return;
    camera.alpha = pose.alpha;
    camera.beta = pose.beta;
    camera.radius = pose.radius;
    camera.target.copyFrom(pose.target);
  };
  const stopCameraTransition = () => { cameraTransition = undefined; };
  return {
    async mount(canvas: HTMLCanvasElement, fabs: readonly FabPlacement[], signal: AbortSignal, onStatus: (status: string) => void, onToolPick?: (tool: PickedTool | null) => void, onAmhsStats?: (stats: AmhsStats) => void, onToolHover?: (hover: HoveredTool | null) => void): Promise<void> {
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
      scene.clearColor = new Color4(0.945, 0.961, 0.976, 1);
      scene.fogMode = Scene.FOGMODE_EXP2;
      scene.fogColor = new Color3(0.945, 0.961, 0.976);
      scene.fogDensity = 0.0008;
      const beta = Math.PI / 3.64;
      homeRadius = 76;
      camera = new ArcRotateCamera('site-camera', Math.PI / 2, beta, homeRadius, new Vector3(0, 0, 0), scene);
      camera.fov = Math.PI / 4;
      camera.lowerRadiusLimit = 4;
      camera.upperRadiusLimit = 200;
      camera.lowerBetaLimit = 0.08;
      camera.upperBetaLimit = 1.5;
      camera.useNaturalPinchZoom = true;
      camera.panningSensibility = 45;
      camera.inertia = 0.62;
      // Do not let pinch / wheel gestures scroll or zoom the browser page.
      camera.attachControl(canvas, false);
      // The preview owns wheel zoom so overlay gestures and the scene share one sensitivity.
      camera.inputs.removeByType('ArcRotateCameraMouseWheelInput');
      onStatus('正在加载原版设备模型…');
      legacyRuntime = await loadLegacyFab(scene, onAmhsStats);
      toolStates = [...FAB_TOOL_STATES];
      legacyRuntime.setLayer('ceiling', false);
      legacyRuntime.setLayer('subfab', false);
      if (signal.aborted || disposed) { disposal.dispose(); return; }
      for (const fab of fabs) {
        fabTargets.set(fab.fabId, new Vector3(0, 1, 0));
      }

      const selection = MeshBuilder.CreateBox('tool-selection', { size: 1 }, scene);
      const selectionMaterial = new StandardMaterial('tool-selection-material', scene);
      selectionMaterial.emissiveColor = new Color3(0.05, 0.64, 0.44);
      selectionMaterial.diffuseColor = new Color3(0, 0, 0);
      selectionMaterial.specularColor = new Color3(0, 0, 0);
      selectionMaterial.wireframe = true;
      selectionMaterial.disableLighting = true;
      selection.material = selectionMaterial;
      selection.isPickable = false;
      selection.isVisible = false;
      let selectedIndex = -1;
      const updateSelectionBounds = () => {
        const root = scene?.getTransformNodeByName(`procedural-tool-${selectedIndex}`);
        const bounds = root?.getHierarchyBoundingVectors(true);
        if (!bounds) return;
        selection.position.copyFrom(bounds.min.add(bounds.max).scale(0.5));
        selection.scaling.copyFrom(bounds.max.subtract(bounds.min).add(new Vector3(0.2, 0.2, 0.2)));
      };
      refreshSelection = updateSelectionBounds;
      const clearPickedTool = () => {
        selection.isVisible = false;
        if (selectedIndex !== -1) {
          selectedIndex = -1;
          onToolPick?.(null);
        }
      };
      clearPicked = clearPickedTool;
      const selectToolByIndex = (index: number, focus = false) => {
        const tool = FAB_LAYOUT[index];
        if (!tool) return;
        selectedIndex = index;
        updateSelectionBounds();
        selection.isVisible = true;
        onToolPick?.({
          index,
          x: tool.x,
          z: tool.z,
          width: tool.width,
          depth: tool.depth,
          height: tool.height,
          category: tool.category,
          vendor: tool.vendor,
          model: tool.model,
          state: toolStates[index] ?? FAB_TOOL_STATES[index] ?? 'idle',
        });
        if (focus && camera) {
          cameraTransition = {
            from: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() },
            to: {
              alpha: camera.alpha,
              beta: Math.PI / 3.6,
              radius: 58,
              target: new Vector3(tool.x, Math.min(1.5, tool.height / 2), tool.z),
            },
            startedAt: performance.now(),
            duration: 520,
          };
        }
      };
      selectToolAt = selectToolByIndex;
      let pointerDownX = 0;
      let pointerDownY = 0;
      const onPointerDown = (event: PointerEvent) => {
        pointerDownX = event.clientX;
        pointerDownY = event.clientY;
      };
      const findToolAt = (clientX: number, clientY: number): { index: number; x: number; y: number } | null => {
        if (!engine || !camera || basementEnabled) return null;
        const rect = canvas.getBoundingClientRect();
        const screenX = (clientX - rect.left) * (engine.getRenderWidth() / rect.width);
        const screenY = (clientY - rect.top) * (engine.getRenderHeight() / rect.height);
        const hit = scene?.pick(clientX - rect.left, clientY - rect.top,
          mesh => mesh.isEnabled() && mesh.isVisible && mesh.isPickable && Number.isInteger(mesh.metadata?.toolIndex), false, camera);
        return hit?.hit ? { index: hit.pickedMesh!.metadata.toolIndex as number, x: screenX, y: screenY } : null;
      };
      let lastHoverIndex: number | null = null;
      const onPointerUp = (event: PointerEvent) => {
        if (Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY) > 6) return;
        const hit = findToolAt(event.clientX, event.clientY);
        if (hit === null) { clearPickedTool(); return; }
        selectToolByIndex(hit.index);
      };
      const onPointerMove = (event: PointerEvent) => {
        if (event.buttons !== 0) { canvas.style.cursor = ''; return; }
        const hit = findToolAt(event.clientX, event.clientY);
        canvas.style.cursor = hit === null ? '' : 'pointer';
        const nextIndex = hit?.index ?? null;
        if (nextIndex === lastHoverIndex) return;
        lastHoverIndex = nextIndex;
        if (!hit || !engine) { onToolHover?.(null); return; }
        const rect = canvas.getBoundingClientRect();
        const tool = FAB_LAYOUT[hit.index];
        onToolHover?.({
          tool: {
            index: hit.index,
            x: tool.x,
            z: tool.z,
            width: tool.width,
            depth: tool.depth,
            height: tool.height,
            category: tool.category,
            vendor: tool.vendor,
            model: tool.model,
            state: toolStates[hit.index] ?? FAB_TOOL_STATES[hit.index] ?? 'idle',
          },
          x: hit.x * rect.width / engine.getRenderWidth(),
          y: hit.y * rect.height / engine.getRenderHeight(),
        });
      };
      const onPointerLeave = () => {
        lastHoverIndex = null;
        onToolHover?.(null);
      };
      const onDoubleClick = (event: MouseEvent) => {
        const hit = findToolAt(event.clientX, event.clientY);
        if (hit !== null) selectToolByIndex(hit.index, true);
      };
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerleave', onPointerLeave);
      canvas.addEventListener('dblclick', onDoubleClick);

      const resize = () => { if (!signal.aborted && !disposed) { try { engine?.resize(); } catch { /* engine is between device states */ } } };
      const visibility = () => { if (document.hidden || deviceLost) engine?.stopRenderLoop(); else engine?.runRenderLoop(render); };
      const render = () => {
        if (signal.aborted || disposed || deviceLost) return;
        const frameNow = performance.now();
        const frameDelta = Math.min(0.05, Math.max(0, (frameNow - lastFrameTime) / 1000));
        lastFrameTime = frameNow;
        if (touring && camera && !cameraTransition) camera.alpha += frameDelta * 0.18;
        if (camera && cameraTransition) {
          const progress = Math.min(1, (performance.now() - cameraTransition.startedAt) / cameraTransition.duration);
          const eased = 1 - Math.pow(1 - progress, 3);
          camera.alpha = cameraTransition.from.alpha + (cameraTransition.to.alpha - cameraTransition.from.alpha) * eased;
          camera.beta = cameraTransition.from.beta + (cameraTransition.to.beta - cameraTransition.from.beta) * eased;
          camera.radius = cameraTransition.from.radius + (cameraTransition.to.radius - cameraTransition.from.radius) * eased;
          camera.target.set(
            cameraTransition.from.target.x + (cameraTransition.to.target.x - cameraTransition.from.target.x) * eased,
            cameraTransition.from.target.y + (cameraTransition.to.target.y - cameraTransition.from.target.y) * eased,
            cameraTransition.from.target.z + (cameraTransition.to.target.z - cameraTransition.from.target.z) * eased,
          );
          if (progress >= 1) cameraTransition = undefined;
        }
        scene?.render();
      };
      engine.onContextRestoredObservable.add(() => {
        if (signal.aborted || disposed) return;
        deviceLost = false;
        lastFrameTime = performance.now();
        // Native static resources are re-created lazily on the next scene render.
        onStatus('WebGPU 设备和清洁室视图已重建 · 估算几何');
        if (!document.hidden) engine?.runRenderLoop(render);
      });
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : undefined;
      observer?.observe(canvas);
      window.addEventListener('resize', resize);
      document.addEventListener('visibilitychange', visibility);
      canvas.addEventListener('pointerdown', stopCameraTransition);
      canvas.addEventListener('wheel', stopCameraTransition, { passive: true });
      cleanup = () => {
        observer?.disconnect();
        window.removeEventListener('resize', resize);
        document.removeEventListener('visibilitychange', visibility);
        canvas.removeEventListener('pointerdown', stopCameraTransition);
        canvas.removeEventListener('wheel', stopCameraTransition);
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerleave', onPointerLeave);
        canvas.removeEventListener('dblclick', onDoubleClick);
      };
      engine.resize(); engine.runRenderLoop(render);
      onStatus('WebGPU · 程序化 FAB · 121 台设备');
    },
    zoom(deltaY: number): void {
      if (!camera || disposed) return;
      cameraTransition = undefined;
      const step = Math.max(-240, Math.min(240, deltaY));
      camera.radius = Math.min(200, Math.max(6, camera.radius * Math.exp(step * 0.0028)));
    },
    clearSelection(): void {
      clearPicked();
    },
    selectTool(index: number, focus?: boolean): void {
      selectToolAt(index, focus);
    },
    setLayer(layer: SceneLayer, visible: boolean): void {
      legacyRuntime?.setLayer(layer, visible);
    },
    setToolState(index: number, state: FabToolState): void {
      if (index < 0 || index >= toolStates.length) return;
      toolStates[index] = state;
      legacyRuntime?.setToolState(index, state);
    },
    setTour(active: boolean): void {
      touring = active;
      cameraTransition = undefined;
      lastFrameTime = performance.now();
    },
    setExploded(active: boolean): void {
      legacyRuntime?.setExploded(active);
      refreshSelection();
    },
    setBasement(active: boolean): void {
      const changed = basementEnabled !== active;
      basementEnabled = active;
      if (active) clearPicked();
      legacyRuntime?.setBasement(active);
      if (camera && changed) {
        cameraTransition = {
          from: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() },
          to: { alpha: Math.PI / 2.2, beta: active ? 1.08 : Math.PI / 3.64, radius: active ? 76 : homeRadius, target: new Vector3(0, active ? -3.5 : 0, 0) },
          startedAt: performance.now(),
          duration: 520,
        };
      }
    },
    setView(preset: SceneViewPreset, fabId?: string): void {
      if (!camera || disposed) return;
      const focusTarget = fabId ? fabTargets.get(fabId) : undefined;
      const centered = new Vector3(0, 0, 0);
      const beta = Math.PI / 3.64;
      let pose: CameraPose;
      if (preset === 'top') {
        pose = { alpha: Math.PI / 2, beta: 0.08, radius: focusTarget ? 48 : 95, target: focusTarget?.clone() ?? centered };
      } else if (preset === 'reset') {
        pose = { alpha: Math.PI / 2, beta, radius: homeRadius, target: centered };
      } else if (preset === 'focus' && focusTarget) {
        pose = { alpha: Math.PI / 2.2, beta: Math.PI / 3.8, radius: 46, target: focusTarget.clone() };
      } else {
        pose = { alpha: Math.PI / 2, beta, radius: focusTarget ? 52 : homeRadius, target: focusTarget?.clone() ?? centered };
      }
      cameraTransition = undefined;
      if (reduceMotion()) { applyPose(pose); return; }
      cameraTransition = {
        from: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() },
        to: pose,
        startedAt: performance.now(),
        duration: 520,
      };
    },
    resize(): void {
      if (disposed || !initialized) return;
      try { engine?.resize(); } catch { /* engine is between device states */ }
    },
    dispose(): void { disposed = true; cleanup(); engine?.stopRenderLoop(); disposal.dispose(); },
  };
}
