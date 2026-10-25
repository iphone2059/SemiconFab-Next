import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { _CommonDispose } from '@babylonjs/core/Engines/engine.common';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Plane } from '@babylonjs/core/Maths/math.plane';
import '@babylonjs/core/Culling/ray';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import type { AmhsStats, CutAxis, FabPlacement, HoveredTool, PickedTool, SceneBackend, SceneLayer, SceneViewPreset, XRayFilter } from './fab-scene';
import { InitializationDisposal, RecoveryFirstFrame } from './babylon-lifecycle';
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

function poseAt(position: Vector3, target = Vector3.Zero()): CameraPose {
  const offset = position.subtract(target);
  return { alpha: Math.atan2(offset.z, offset.x), beta: Math.acos(offset.y / offset.length()), radius: offset.length(), target };
}

function positionOf(pose: CameraPose): Vector3 {
  return new Vector3(Math.cos(pose.alpha) * Math.sin(pose.beta), Math.cos(pose.beta), Math.sin(pose.alpha) * Math.sin(pose.beta)).scale(pose.radius).add(pose.target);
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
  let dualEnabled = false;
  let waferMarker: ReturnType<typeof MeshBuilder.CreateBox> | undefined;
  let waferTrail: ReturnType<typeof MeshBuilder.CreateLines> | undefined;
  const fabTargets = new Map<string, Vector3>();
  let cleanup = () => {};
  let perfBridge: { dispose: () => void } | undefined;
  let disposed = false;
  let deviceLost = false;
  let initialized = false;
  let attachedCanvas: HTMLCanvasElement | undefined;
  const recovery = new RecoveryFirstFrame();
  let restoreValidationDevice: GPUDevice | undefined;
  const abandonRestoreValidation = () => {
    const pending = restoreValidationDevice; restoreValidationDevice = undefined;
    if (pending) void pending.popErrorScope().catch(() => {});
  };
  const disposal = new InitializationDisposal(() => {
    perfBridge?.dispose(); perfBridge = undefined;
    recovery.dispose();
    abandonRestoreValidation();
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
    async mount(canvas: HTMLCanvasElement, fabs: readonly FabPlacement[], signal: AbortSignal, onStatus: (status: string) => void, onToolPick?: (tool: PickedTool | null) => void, onAmhsStats?: (stats: AmhsStats) => void, onToolHover?: (hover: HoveredTool | null) => void, getToolStates?: () => readonly FabToolState[]): Promise<void> {
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
          recovery.lost();
          abandonRestoreValidation();
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
      scene.fogDensity = 0.0055;
      homeRadius = Math.hypot(58, 68);
      camera = new ArcRotateCamera('site-camera', Math.PI / 2, Math.acos(58 / homeRadius), homeRadius, new Vector3(0, 0, 0), scene);
      camera.fov = Math.PI / 4;
      camera.minZ = 0.5; camera.maxZ = 600;
      camera.lowerRadiusLimit = 4;
      camera.upperRadiusLimit = 180;
      camera.lowerBetaLimit = 0.001;
      camera.upperBetaLimit = Math.PI / 2 - 0.03;
      camera.useNaturalPinchZoom = true;
      camera.panningSensibility = 45;
      camera.inertia = 0.62;
      // Do not let pinch / wheel gestures scroll or zoom the browser page.
      camera.attachControl(canvas, false);
      // FabViewport owns wheel zoom so overlays and the canvas share one sensitivity.
      camera.inputs.removeByType('ArcRotateCameraMouseWheelInput');
      onStatus('正在加载原版设备模型…');
      legacyRuntime = await loadLegacyFab(scene, onAmhsStats);
      toolStates = [...FAB_TOOL_STATES];
      // Frame loop reads the Redux snapshot through a callback instead of waiting
      // for a React prop pass. Only lightweight state IDs/states cross the boundary.
      if (getToolStates) {
        scene.onBeforeRenderObservable.add(() => {
          if (signal.aborted || !legacyRuntime) return;
          const next = getToolStates();
          for (let index = 0; index < next.length && index < toolStates.length; index += 1) {
            const state = next[index];
            if (state !== toolStates[index]) {
              toolStates[index] = state;
              legacyRuntime.setToolState(index, state);
            }
          }
        });
      }
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
      waferMarker = MeshBuilder.CreateBox('wafer-follow-marker', { width: 0.5, height: 0.35, depth: 0.4 }, scene);
      const waferMarkerMaterial = new StandardMaterial('wafer-follow-marker-material', scene);
      waferMarkerMaterial.diffuseColor = new Color3(0.96, 0.62, 0.04);
      waferMarkerMaterial.emissiveColor = new Color3(0.5, 0.24, 0.01);
      waferMarkerMaterial.specularColor = new Color3(0.3, 0.2, 0.05);
      waferMarker.material = waferMarkerMaterial;
      waferMarker.isPickable = false;
      waferMarker.isVisible = false;
      const waferFlangeMaterial = new StandardMaterial('wafer-follow-flange', scene);
      waferFlangeMaterial.diffuseColor = new Color3(0.2, 0.27, 0.35);
      waferFlangeMaterial.specularColor = new Color3(0.4, 0.4, 0.4);
      const waferDoorMaterial = new StandardMaterial('wafer-follow-door', scene);
      waferDoorMaterial.diffuseColor = new Color3(0.12, 0.16, 0.22);
      waferDoorMaterial.specularColor = new Color3(0.5, 0.5, 0.5);
      const flange = MeshBuilder.CreateBox('wafer-follow-flange-mesh', { width: 0.12, height: 0.04, depth: 0.12 }, scene);
      flange.parent = waferMarker;
      flange.position.y = 0.195;
      flange.material = waferFlangeMaterial;
      flange.isPickable = false;
      const door = MeshBuilder.CreateBox('wafer-follow-door-mesh', { width: 0.44, height: 0.3, depth: 0.012 }, scene);
      door.parent = waferMarker;
      door.position.z = 0.201;
      door.material = waferDoorMaterial;
      door.isPickable = false;
      const waferLight = new PointLight('wafer-follow-light', new Vector3(0, 0.3, 0), scene);
      waferLight.parent = waferMarker;
      waferLight.diffuse = new Color3(0.96, 0.62, 0.04);
      waferLight.intensity = 0.9;
      waferLight.range = 4;
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
      let lastHoverPickAt = 0;
      const hoverPickMs = Math.max(0, Number(new URLSearchParams(location.search).get('hoverPickMs') ?? '50') || 0);
      const onPointerUp = (event: PointerEvent) => {
        if (Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY) > 6) return;
        const hit = findToolAt(event.clientX, event.clientY);
        if (hit === null) { clearPickedTool(); return; }
        selectToolByIndex(hit.index);
      };
      const onPointerMove = (event: PointerEvent) => {
        if (event.buttons !== 0) { canvas.style.cursor = ''; return; }
        const now = performance.now();
        // Hover raycasts are CPU-side and only drive a tooltip; 50 ms is visually
        // indistinguishable and prevents pixel-by-pixel picking spikes while orbiting.
        if (now - lastHoverPickAt < hoverPickMs) return;
        lastHoverPickAt = now;
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
        if (camera && cameraTransition) {
          const progress = Math.min(1, (performance.now() - cameraTransition.startedAt) / cameraTransition.duration);
          const eased = 0.5 - Math.cos(progress * Math.PI) / 2;
          const position = Vector3.Lerp(positionOf(cameraTransition.from), positionOf(cameraTransition.to), eased);
          camera.target.set(
            cameraTransition.from.target.x + (cameraTransition.to.target.x - cameraTransition.from.target.x) * eased,
            cameraTransition.from.target.y + (cameraTransition.to.target.y - cameraTransition.from.target.y) * eased,
            cameraTransition.from.target.z + (cameraTransition.to.target.z - cameraTransition.from.target.z) * eased,
          );
          camera.setPosition(position);
          if (progress >= 1) cameraTransition = undefined;
        }
        if (recovery.waiting && !restoreValidationDevice && engine) {
          restoreValidationDevice = engine._device;
          restoreValidationDevice.pushErrorScope('validation');
        }
        scene?.render();
      };
      engine.onContextRestoredObservable.add(() => {
        if (signal.aborted || disposed) return;
        // Babylon 9.32 WebGPUEngine derives from ThinWebGPUEngine: its buffer
        // rebuild covers UBO/storage buffers but omits Scene geometry/sprites.
        // Recreate those CPU-backed buffers on the new device before drawing.
        scene?.resetCachedMaterial();
        scene?._rebuildGeometries();
        deviceLost = false;
        recovery.restored(scene?.getFrameId() ?? 0);
        // Native static resources are re-created lazily on the next scene render.
        onStatus('GPU 设备已重建，等待恢复首帧完成…');
        if (!document.hidden) engine?.runRenderLoop(render);
      });
      engine.onEndFrameObservable.add(() => {
        if (!recovery.waiting || !scene?.isReady() || !engine || !restoreValidationDevice || scene.metadata?.staticShadows?.readyForCurrentDevice !== true) return;
        const submittedDevice = restoreValidationDevice;
        restoreValidationDevice = undefined;
        const completion = Promise.all([submittedDevice.queue.onSubmittedWorkDone(), submittedDevice.popErrorScope()]).then(([, error]) => {
          if (error) throw new Error(error.message);
        });
        recovery.submitted(scene.getFrameId(), true, completion, () => {
          if (!signal.aborted && !disposed) onStatus('WebGPU 设备和清洁室视图已重建 · 首帧完成 · 估算几何');
        }, () => {
          deviceLost = true;
          engine?.stopRenderLoop();
          if (!signal.aborted && !disposed) onStatus('GPU 恢复首帧失败，请重新加载视图。');
        });
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
      if (new URLSearchParams(location.search).has('perf')) {
        void import('@babylonjs/core/Instrumentation/sceneInstrumentation').then(({ SceneInstrumentation }) => {
          if (!scene || !engine || disposed) return;
          const instrumentation = new SceneInstrumentation(scene);
          instrumentation.captureFrameTime = true;
          instrumentation.captureRenderTime = true;
          instrumentation.captureActiveMeshesEvaluationTime = true;
          const target = {
            // Read-only diagnostics for production-bundle acceptance runs (`?perf` only).
            getScene: () => scene,
            getEngine: () => engine,
            getShadow: () => scene?.metadata?.staticShadows ?? null,
            getCameraPose: () => {
              if (!camera) return null;
              const p = camera.position;
              const t = camera.target;
              return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
            },
            getStats: () => ({
              fps: engine?.getFps() ?? 0,
              frameTimeMs: instrumentation.frameTimeCounter.current,
              renderTimeMs: instrumentation.renderTimeCounter.current,
              activeMeshesEvaluationMs: instrumentation.activeMeshesEvaluationTimeCounter.current,
              drawCalls: instrumentation.drawCallsCounter.current,
              activeMeshes: scene?.getActiveMeshes().length ?? 0,
              totalVertices: scene?.getTotalVertices() ?? 0,
              heapBytes: (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize ?? null,
            }),
          };
          (window as Window & { __SEMICONFAB_PERF__?: typeof target }).__SEMICONFAB_PERF__ = target;
          perfBridge = { dispose: () => {
            instrumentation.dispose();
            if ((window as Window & { __SEMICONFAB_PERF__?: typeof target }).__SEMICONFAB_PERF__ === target) {
              delete (window as Window & { __SEMICONFAB_PERF__?: typeof target }).__SEMICONFAB_PERF__;
            }
          } };
        });
      }
      onStatus('WebGPU · 程序化 FAB · 121 台设备');
    },
    zoom(deltaY: number): void {
      if (!camera || disposed) return;
      cameraTransition = undefined;
      const step = Math.max(-240, Math.min(240, deltaY));
      camera.inertialRadiusOffset = 0;
      camera.radius = Math.min(camera.upperRadiusLimit ?? 180, Math.max(camera.lowerRadiusLimit ?? 4, camera.radius * Math.exp(step * 0.0028)));
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
      if (touring === active) return;
      touring = active;
      cameraTransition = undefined;
    },
    setExplodeFactor(factor: number, modeActive?: boolean): void {
      // Exploded mode remains active at a 0% slider setting; camera poses are owned by the page
      // (flyLevel) so level switches keep their source level pose.
      const active = modeActive ?? factor > 0;
      legacyRuntime?.setExplodeFactor(factor, active);
      refreshSelection();
    },
    setBasement(active: boolean): void {
      const changed = basementEnabled !== active;
      basementEnabled = active;
      if (active) { dualEnabled = false; clearPicked(); }
      legacyRuntime?.setBasement(active);
      if (camera && changed) {
        cameraTransition = {
          from: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() },
          to: active ? poseAt(new Vector3(-15, -2, 34), new Vector3(-15, -6, -5)) : poseAt(new Vector3(0, 52, 64), new Vector3(0, 2, 0)),
          startedAt: performance.now(),
          duration: 850,
        };
      }
    },
    setDual(active: boolean): void {
      const changed = dualEnabled !== active;
      dualEnabled = active;
      if (active) { basementEnabled = false; clearPicked(); }
      legacyRuntime?.setDual(active);
      if (camera && changed) {
        cameraTransition = {
          from: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() },
          to: active ? poseAt(new Vector3(0, 38, 62), new Vector3(0, -3, 0)) : poseAt(new Vector3(0, 52, 64), new Vector3(0, 2, 0)),
          startedAt: performance.now(),
          duration: 850,
        };
      }
    },
    setXRayFilter(filter: XRayFilter | null): void {
      legacyRuntime?.setXRayFilter(filter);
    },
    setWaferPoint(x: number, y: number, z: number, visible: boolean, focus: boolean): void {
      if (!waferMarker) return;
      const dx = x - waferMarker.position.x;
      const dz = z - waferMarker.position.z;
      if (visible && dx * dx + dz * dz > 0.00001) waferMarker.rotation.y = Math.atan2(dx, dz);
      waferMarker.position.set(x, y, z);
      waferMarker.setEnabled(visible);
      if (visible && focus && camera) {
        cameraTransition = undefined;
        camera.setTarget(new Vector3(x, y, z));
        camera.alpha = -Math.PI / 2;
        camera.beta = Math.acos(0.6);
        camera.radius = 10;
      }
    },
    setWaferTrail(points: readonly (readonly [number, number, number])[]): void {
      waferTrail?.dispose();
      waferTrail = undefined;
      if (points.length < 2 || !scene) return;
      waferTrail = MeshBuilder.CreateLines('wafer-follow-trail', {
        points: points.map(([x, y, z]) => new Vector3(x, y, z)),
        colors: points.map((_, index) => {
          const f = (index + 1) / points.length;
          return new Color4(0.96 * f, (0.6 + 0.3 * f) * f, 0.05 * f, 0.9);
        }),
      }, scene);
      waferTrail.isPickable = false;
    },
    setLanguage(language: 'zh' | 'en'): void {
      legacyRuntime?.setLanguage?.(language);
    },
    focusPatrol(): void {
      const patrol = scene?.getTransformNodeByName('operator-5');
      if (!patrol || !camera) return;
      const target = patrol.getAbsolutePosition();
      cameraTransition = undefined;
      camera.setTarget(new Vector3(target.x, 1.2, target.z));
      camera.radius = 18;
      camera.beta = 1.08;
    },
    setCutPlane(active: boolean, axis: CutAxis, position: number, invert: boolean): void {
      if (!scene) return;
      if (!active) {
        scene.clipPlane = null;
        return;
      }
      clearPicked();
      const flipped = invert ? -1 : 1;
      const p = Math.max(-60, Math.min(60, position));
      scene.clipPlane = axis === 'X'
        ? new Plane(flipped, 0, 0, -flipped * p)
        : axis === 'Y'
          ? new Plane(0, flipped, 0, -flipped * p)
          : new Plane(0, 0, flipped, -flipped * p);
    },
    getCameraPose(): { position: readonly [number, number, number]; target: readonly [number, number, number] } | null {
      if (!camera) return null;
      const p = camera.position;
      const t = camera.target;
      return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
    },
    setView(preset: SceneViewPreset, fabId?: string): void {
      if (!camera || disposed) return;
      const focusTarget = fabId ? fabTargets.get(fabId) : undefined;
      const beta = Math.PI / 3.64;
      let pose: CameraPose;
      if (preset === 'top') {
        pose = poseAt(new Vector3(0, 95, 0.1));
      } else if (preset === 'litho') {
        pose = poseAt(new Vector3(-21, 3.6, -12.5), new Vector3(-30, 1.8, -22));
      } else if (preset === 'airshower') {
        pose = poseAt(new Vector3(-12.5, 4.2, 7.5), new Vector3(-16.5, 1.5, 3));
      } else if (preset === 'etch') {
        pose = { alpha: 1.62, beta: 1.12, radius: 40, target: new Vector3(5, 1.4, -14) };
      } else if (preset === 'oht') {
        pose = { alpha: 1.8, beta: 1.24, radius: 72, target: new Vector3(0, 3.8, 0) };
      } else if (preset === 'reset') {
        pose = poseAt(new Vector3(0, 58, 68));
      } else if (preset === 'focus' && focusTarget) {
        pose = { alpha: Math.PI / 2.2, beta: Math.PI / 3.8, radius: 46, target: focusTarget.clone() };
      } else {
        pose = focusTarget ? { alpha: Math.PI / 2, beta, radius: 52, target: focusTarget.clone() } : poseAt(new Vector3(38, 48, 58));
      }
      cameraTransition = undefined;
      if (reduceMotion()) { applyPose(pose); return; }
      cameraTransition = {
        from: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() },
        to: pose,
        startedAt: performance.now(),
        duration: 1000,
      };
    },
    setCameraPose(position, target, durationMs): void {
      if (!camera || disposed) return;
      const pose = poseAt(Vector3.FromArray(position), Vector3.FromArray(target));
      cameraTransition = undefined;
      if (reduceMotion() || durationMs <= 0) { applyPose(pose); return; }
      cameraTransition = {
        from: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() },
        to: pose, startedAt: performance.now(), duration: Math.max(1, durationMs),
      };
    },
    resize(): void {
      if (disposed || !initialized) return;
      try { engine?.resize(); } catch { /* engine is between device states */ }
    },
    dispose(): void { disposed = true; cleanup(); engine?.stopRenderLoop(); disposal.dispose(); },
  };
}
