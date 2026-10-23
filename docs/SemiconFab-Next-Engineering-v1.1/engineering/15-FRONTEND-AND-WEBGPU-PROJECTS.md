# 15 — React 工作台、Babylon.js WebGPU 渲染与资产管线

## 1. Monorepo TS 包责任

| package | 具体目录 | 核心责任 |
|---|---|---|
| `@fab/web` | `apps/web/src` | Router/Auth/Layout、页面、ErrorBoundary、命令交互 |
| `@fab/contracts` | `frontend/packages/contracts` | Protobuf/OpenAPI 生成类型（不可手改） |
| `@fab/api-client` | `frontend/packages/api-client` | fetch client、授权、重试/取消、ETag、Idempotency-Key |
| `@fab/state-sync` | `frontend/packages/realtime-sync` | SnapshotAssembler、DeltaReconciler、GapDetector、TelemetryCache |
| `@fab/fab-scene` | `frontend/packages/fab-scene` | EntityRegistry、AssetKey、CoordinateFrame、VisualState、RenderClock |
| `@fab/babylon-webgpu` | `frontend/packages/babylon-webgpu` | WebGPUEngine、Scene/Buffer/Material、Pipelines、DeviceLost |
| `@fab/ui` | `frontend/packages/app-ui` | Ant Design 封装、tokens、表单、权限 UI |
| `@fab/widgets` | `frontend/packages/widgets` | 可复用工作台/KPI 组件，消费已授权查询结果 |
| `@fab/charting` | `frontend/packages/charting` | ECharts metrics/time window 聚合显示 |

React Router、TanStack Query、Zustand、i18next、ECharts、Playwright、Vitest 作为推荐依赖；版本以 CI 锁文件为准。React 只保存 Page 选择、Filter、Form 状态，设备高频更新走 `state-sync` 缓存与 GPU 更新调度，禁止高频每事件 setState 渲染所有组件。

## 2. React 页面域路由

`/sites/:siteId/overview`：Site KPI 与三个 FAB 状态；`/sites/:siteId/fabs/:fabId`：FAB 概况；`/sites/:siteId/fabs/:fabId/3d`：WebGPU FAB 视图；`/equipment/:id`：设备；`/lots/:id`：Lot 轨迹；`/scenarios`：配置/版本；`/runs/:runId`：仿真控制与回放；`/experiments`：优化评估；`/standards/evidence`：符合性证据。不同权限用户只获得授权的菜单和 API 范围，不能仅靠隐藏路由保护数据。

## 3. 3D Scene 分层

```text
SceneFacade                  # 与业务界面唯一交互点
  ├─ SceneLifecycle          # init/start/suspend/dispose/device-lost
  ├─ SceneEntityRegistry     # (siteId,runId,fabId,entityId) -> VisualHandle
  ├─ AssetManager            # GLB/KTX2/LOD/asset hash/ref-count
  ├─ TransformAndUnits       # fab-local -> site -> render frame
  ├─ VisibilitySystem        # frustum/LOD/occlusion optional
  ├─ StateBindingSystem      # Equipment/Carrier/OHT -> buffer updates
  ├─ SelectionAndPicking     # selection id -> stable entity id
  ├─ TimelineController      # PlaybackSpeed/simTime interpolation
  ├─ Diagnostics             # FPS/frame/pick/device/memory
  └─ BabylonWebGpuBackend    # only GPU implementation
```

Site View 使用三个 FAB 共用静态 Asset，但每个 FAB 有独立 SceneRoot transform、EntityRegistry、状态缓存与 Subscription。选择 FAB View 时才载入详细设备/Chamber/AMHS 资产，不默认把全部三 FAB 全精度同时渲染。

`fab-scene` 定义引擎无关的渲染 Port，`babylon-webgpu` 实现该 Port 并依赖 `fab-scene`；由 `apps/web` 装配，禁止 `fab-scene` 再反向 import GPU 实现形成环。切换 Run、回放位置或订阅过滤条件时更换流身份并清理旧缓存，晚到的异步加载与旧增量不得写入新场景。

## 4. WebGPU-only 强制规范

- 仅 `WebGPUEngine`；运行前检查 `window.isSecureContext`、`navigator.gpu`、adapter、device limits、所需 feature、`device.lost`。对不支持 WebGPU 的终端显示错误与准入建议，**不回退 WebGL**。
- `webgl`/`webgl2`/`experimental-webgl` context 创建语句在静态审计、运行时测试和 bundle 检查中为阻断项。
- Renderer 适配不得混入 React 组件；包含 Babylon 私有对象的类型不得越过 `@fab/babylon-webgpu` 包 API。
- Shader 首选 WGSL；自定义 GPU Compute 仅用于非权威视图计算。WebGPU 功能受 adapter capabilities 约束，**不得假设所有设备支持 timestamp-query/indirect 特性**。
- 禁止因逐设备报警而重编 GPU pipeline；使用稳定材质/实例属性 Buffer；批量更新产生的数据流须有帧预算与拥塞降级。
- Device lost 后停止提交帧、重建引擎资源、重载必要资产并从快照恢复；不能直接复用 lost device 的 GPUBuffer/GPUTexture。

## 5. 三 FAB 坐标契约

`SiteCoordinateFrame` 为基地统一坐标；三个 FAB 共用 `FabLocalFrame` 模板，但通过每个 `FabUnitPlacement` (`position`, `rotation`, `scale=1`) 映射至 Site。数学计算均采用米、右手系、+Y up，Babylon 场景须显式设置 `scene.useRightHandedSystem = true`；设备尺寸由经过审核的 catalog，缺失则明确展示估算模型与不确定性。不要修改设备业务 ID 来表达 3D 实例。

## 6. 资产交付

每个机台模型需附：`assetId/modelRef/version/contentHash/unit/coordinateFrame/declaredOrigin/LOD set/material list/collision or pick proxy/license/source/provenance`。推荐 glTF 2.0/GLB + KTX2；Draco/meshopt 需在 WebGPU 浏览器兼容测试中验证。静态 GLB 与运行时状态（E10）完全分离，禁止按设备状态复制 GPU 材质无界增长。

## 7. 性能与回归

将测试规模与 GPU/驱动锁定：1/3 FAB 同屏、设备 1k/3k 规模（均为**建议测试点而非真实机台数**）、动态更新 5/10/20Hz、60FPS 目标、快速切换 1k 次、显存持续增长检测。测量 p50/p95 帧时、JS heap、GPU memory（在可用 API 范围内）、首屏 p95、Picking p95。无 GPU 的 CI 只做基础逻辑，不作为 WebGPU 性能证据。

## 8. 典型 3D 数据路径

`Worker -> Snapshot/Delta -> WebSocketDecoder -> StateSyncCache -> DirtyEntitySet -> SceneStateBinding -> GPU instance buffer -> Render`。通过 `requestAnimationFrame` 合并 DirtyEntitySet；仿真时钟步进不应与画面帧率耦合。站点 3D 视图仅接收低 LOD 聚合，独立 FAB 详情页面按权限和视锥订阅精细事件。

序号、Run/FAB 作用域与快照水位遵循 `08-API-EVENT-CONTRACTS.md`，不得将过滤、合并后的推送序号当成权威执行日志序号。解码时 `int64/uint64` 使用 `bigint` 或十进制字符串，先校验范围与单位再转换为展示数字；禁止直接转成可能丢精度的 JavaScript `number`。
