# M12 — WebGPU-only FAB 三维可视化：开发项目架构与详细规范

> 模块编号：`M12`　|　主责任域：3D/Graphics　|　状态：`DESIGN_BASELINE`　|　受 `01`—`14` 规范与 `engineering/00` 共同约束。

## 1. 业务职责与范围

将 Site/FAB/Equipment/Carrier/OHT 的只读状态映射到 WebGPU 场景；维护共享资源资产与各 FAB 独立可视实例，支持 Site View/FAB View/Equipment View。

### 拥有的视图与渲染对象

`SceneEntity`、`VisualHandle`、`FabSceneRoot`、`AssetKey`、`LODLevel`、`RenderState`、`SelectionHandle`。

### 边界与依赖

- 上游输入或参照：M01 模板/资产引用；M09/Realtime 的已授权 Snapshot/Delta（承载 M03/M05/M10 投影）；M11 的视图意图。
- 下游消费者：Site/FAB dashboards。
- 本模块只拥有可重建视图缓存、选择与 GPU 资源；不拥有设备/物料/Run 的业务状态，也不把本地事件回写为仿真事实。
- 数据范围：与 FAB 关联的对象必须携带 `SiteId/FabId`；Site 级对象不得借此取得 FAB 运行状态写权限。

## 2. 可落地的工程/包与目录

- `frontend/packages/fab-scene`：`facade/`、`entities/`、`assets/`、`coordinates/`、`state-binding/`、`selection/`、`lifecycle/`；定义引擎无关的 `IRenderBackend`。
- `frontend/packages/babylon-webgpu`：`engine/`、`buffers/`、`materials/`、`picking/`、`device-recovery/`；实现 `IRenderBackend`，依赖 fab-scene 的纯接口。
- `frontend/packages/realtime-sync`（`@fab/state-sync`）：`snapshot/`、`delta/`、`gaps/`、`subscriptions/`；依赖生成协议，不导入 Babylon。
- `assets/`：不可变 GLB/KTX2/LOD 与 provenance/content hash。

Web bootstrap 注入具体 backend；`fab-scene` 不反向导入 Babylon 包，M12 不依赖 React 页面。模块不建立 EF 仓储、数据库迁移或 Outbox。

## 3. 接口清单与类型规范

公开 Ports / Services：`ISceneFacade`、`IRenderBackend`、`IEntityRegistry`、`IAssetManager`、`IStateDeltaReconciler`。

### 命令 API

| Command | 前置条件与结果 |
|---|---|
| `InitializeWebGpu` | 检查 secure context、adapter/features/limits；每个活动 canvas 只持有一个 Engine；初始化失败可释放且不回退 WebGL |
| `LoadSiteScene` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `LoadFabScene` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `ApplyDeltaBatch` | 只接受当前 scope/stream_id/generation 与快照基线上的连续有效批次；重复忽略、gap 请求重同步，不部分混入旧 Run |
| `SelectEntity` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `SeekTimeline` | 切换到指定回放快照/增量并隔离 live 订阅；仅改变视图时间，不推进或回退权威 DES |
| `RecoverDevice` | 停止旧帧提交，建立新 device/资源 generation，再从完整缓存或服务器快照恢复；旧 GPU handle 不可复用 |
| `DisposeScene` | 幂等取消加载/订阅并释放 RAF、observer、registry、buffer、texture 与资产引用；dispose 后拒绝迟到回调 |

### 查询 API

| Query | 返回/权限约束 |
|---|---|
| `GetRenderedEntity` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetFrameMetrics` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetSceneCapabilities` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetSelection` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetGpuMemoryEstimate` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |

上述接口是客户端视图操作，不要求 REST 幂等键或业务 ExpectedVersion。异步操作使用取消信号与 scope/generation；查询只返回稳定实体 ID、opaque VisualHandle 和只读诊断数据，Babylon Scene/Mesh/GPU 对象不越过 backend API。

## 4. 视图通知与诊断事件

| 通知 | 语义 |
|---|---|
| `SceneReady` | 当前 scope/generation 的场景可展示；不表示 Run 已启动 |
| `FrameRendered` | 本地帧诊断，可采样；不得逐帧写入公共业务日志/Outbox |
| `DeviceLost` | GPU 生命周期故障，停止旧 device 提交 |
| `SnapshotResyncRequired` | 非权威缓存需重建；由 state-sync 请求当前订阅快照 |
| `EntityPicked` | 返回当前视图内的稳定实体 ID，触发 M11 详情选择 |

这些是本地通知，不是 DomainEvent 或 DES 权威事件。与服务端通信的 Snapshot/Delta/Resync 消息仍使用版本化 `contracts/`。

## 5. 数据与存储

共享不可变 GLB/KTX2/LOD 资产；各 FAB/Run 保有独立动态缓存与可视实例。权威源为服务器已授权的 Snapshot/Delta 或历史回放资产。

- 活动场景以 `(SiteId, RunId, generation)` 隔离；场景内 registry 用 `(FabId, EntityId)`，不同 Run 不复用动态状态。
- 资产缓存按 content hash、backend/device generation 与引用计数管理；共享的是不可变资源，不是不同 FAB 的材质状态或选择状态。
- `dispose`、取消加载与 device lost 必须成对释放资源；迟到的异步加载不得复活已卸载场景。lost device 的 buffer/texture 必须重建。
- 只有完整快照可成为恢复基线；增量缓存可丢弃，不作为业务持久化或 DES Checkpoint。

## 6. 必须守护的领域不变量

只创建 Babylon WebGPUEngine，禁止 WebGL；同一场景内实体键=(fabId,entityId)，场景上下文隔离 Site/Run；GPU 资产可共享但状态独立；设备图形变更不能写回 DES。

### 三 FAB / 共享模式行为

- `INDEPENDENT`：业务写入与事件执行限制在所属 FAB 执行域；查询和 UI 订阅按授权范围过滤，允许 Site 角色只读汇总多个 FAB；相同模板不使 FAB 共享 Mutable State。
- `SHARED_CAPACITY`：只有 M07 确定性执行器与 M08 `SiteResourceAuthority/SiteCoordinator` 的正式接口可参与 Site 共用容量争用；所有资源授予具有虚拟时间顺序和可回放记录。
- 在没有明确的 `SiteResourceDefinition` 或跨 FAB 业务配置时，不得推断存在共享设施，也不得在当前版本自动进行跨 FAB 物料转移。

## 7. 典型流程与异常处理

1. Web bootstrap 创建 Scene Facade 与 backend；检查 WebGPU 准入后初始化，失败时向 M11 返回可展示错误。
2. 为授权范围建立新 scope/generation，加载内容哈希校验后的资产与完整 Snapshot；初始化过程中切换/卸载可取消。
3. state-sync 验证快照/增量连续性，按帧合并 DirtyEntitySet，再批量更新实例 buffer；渲染时钟只做插值。
4. 切换 FAB/Run、退出或权限撤销时退订旧范围，丢弃迟到回调，释放场景资源；允许共享资产按引用计数保留。
5. Device lost 进入停止提交→释放旧资源→重新初始化→恢复完整状态的流程；恢复期间显示不可用/stale，重试失败回到非 3D 页面。

## 8. 测试、交付和验收

- T-01 静态/bundle/运行时扫描不创建 WebGL context；T-02 真实 GPU 启动与 DeviceLost 恢复；T-03 三 FAB 相同 LocalCode 及不同 Run 的选中实体正确；T-04 FPS/内存/缓冲更新压力测试；T-05 反复挂载、切换、取消加载与 dispose 后无残留 RAF/订阅/资源增长。
- 超限快照拒绝/缩小订阅、重复/乱序/缺失 delta、断线重连与 seek/live 切换须验证；v1 不支持快照分片，未来分片须在新契约版本定义后验收，不把不完整状态展示为当前权威状态。
- 引擎无关缓存/registry/坐标逻辑可在无 GPU CI 运行；WebGPU 功能和性能必须在声明的 GPU/驱动/浏览器上验收。

### Definition of Done

- [ ] 所辖包可构建，fab-scene/state-sync 不导入 Babylon 私有类型。
- [ ] Scene Facade、取消/dispose、device recovery 和 scope/generation 契约明确。
- [ ] 跨 FAB/Run 缓存、快照恢复与真实 GPU 生命周期验收通过。
- [ ] 资产 hash、版本、单位与许可齐备，诊断数据脱敏。
- [ ] 对应 G0—G8 的适用 GPU/E2E 证据有固定 URI 和 Review 记录；无业务数据库迁移职责。

## 9. 特殊风险与设计提醒

不支持 WebGPU 的 GPU/浏览器不是自动降级到 WebGL，而是明确报错并提供非 3D 页面。
