# SemiconFab Next V2.1 架构基线

- 版本：V2.1（2026-10-27）
- 状态：**基线已采纳；M1–M6 与 all review batches 已落地：多 FAB 目录/遥测、FAB 级设备状态、命令幂等/鉴权/能力校验、SSE 游标/缺口恢复、命令保留、真实 GPU 门禁与压力测试均已实现；仅 PostgreSQL/Outbox/生产身份因基础设施缺失保留为边界**。
- 适用对象：`web_app` 前端架构。后端 `fab_app`/`fab_shared` 的项目与命名空间边界沿用 ADR-0001…ADR-0007
- 权威决策：[ADR-0009](adr/0009-tanstack-router-query-boundary.md)（Router/Query 边界）、[ADR-0010](adr/0010-command-event-bridge.md)（实时/命令/工作流边界）；本文档负责汇总、目录结构与迁移计划
- 当前实现事实：所有 HTTP 端点由 TanStack Query 独占；客户端 UI 状态由 7 个 Zustand store（twinUi/twinPage/twinDemo/catalog/workbench/runtime/locale）独占，均由类型安全的 `createSliceStore` 工厂生成（reducer 参数推导到 action creators，无 `any`/手写 action 接口断言）；RTK Query、Redux Toolkit、react-redux 与 `src/store/` 已全部删除；XState 工作流已接入，实现位于 `runtime/commands` 并经 `CommandWorkflow` 契约暴露（位置不构成架构约束）。详细证据见 [实施状态](IMPLEMENTATION-STATUS.md)、§15–§17、§29。

> RQ-01..RQ-05、CE-01..CE-08、ARCH 检查与真实 Chrome/WebGPU 性能门禁均已真实运行（见 §12.2/§26）；任何“已通过/已验证”的表述都必须指向真实测试记录。

## 1. 基线与范围

### 1.1 本次基线交付

M0（2026-10-27，提交 e18595f）只交付架构文档：ADR-0009、ADR-0010、本基线、7 篇专项文档与 V2.1 实施状态指针（完整清单见 [文档地图](#13-文档地图)）。M0 不新增依赖、不改 `web_app/vite.config.ts`、不删 Redux。

M1（2026-10-27）已在此基线上落地：依赖安装与锁文件、`app/providers`、`app/router`（生成式路由树，`defaultPreload: 'intent'`、`defaultPreloadStaleTime: 0`）、`api/queries`（sites 端点从 RTK Query 迁到 TanStack Query，无双缓存）、最终产品 URL、RQ-01/RQ-05 集成测试。Vite 仅新增路由生成插件，server/build 参数未变（G-01）。M2 已删除旧地址与重定向；M3–M6 未开始。

### 1.2 范围

| 在范围内 | 不在范围内 |
|---|---|
| 前端路由、服务端缓存、客户端状态的所有权划分 | 后端 API 契约、数据库、Worker/DES |
| 实时命令链路的契约、协调、恢复与生命周期 | 真实 WebSocket 服务实现（后端当前为占位） |
| FabRuntime 装配与三 FAB 隔离目标 | 三 FAB 产品范围的业务决策（当前产品仍是单 FAB） |
| Babylon Lite + WebGPU-only 的渲染边界与高频数据旁路 | 渲染视觉 parity、GPU 性能验收（见现有 Twin/Lite 迁移文档） |
| 目标目录结构、ARCH 规则、迁移阶段与风险 | UI 视觉设计、Ant Design/ECharts 选型细节 |

### 1.3 不变量

- 单站点 `web_app`（[ADR-0003](adr/0003-single-web-app.md)）、单后端 `fab_app`（[ADR-0006](adr/0006-single-backend-application.md)）不变。
- 全部同级、无总 solution、每个项目独立构建（[ADR-0001](adr/0001-flat-project-layout.md)）不变。
- Babylon Lite 1.36 + WebGPU-only 不变；禁止 WebGL 回退（Engineering 09 / [渲染管线](rendering.md)）。
- 当前单 FAB 产品边界是事实；V2.1 的三 FAB 是**目标能力**，在 M4 之前不得对外宣称已支持。

## 2. 架构原则

1. **单一所有权**：每一类状态只有一个所有者。HTTP 服务端数据 -> TanStack Query；URL/导航 -> TanStack Router；客户端 UI -> Zustand/组件局部；命令生命周期 -> XState v6（经契约）；高频遥测 -> Worker/缓冲区；3D 对象 -> Babylon Lite。禁止复制缓存。
2. **依赖朝向契约**：实时基础设施只依赖 `application/contracts`，不认识工作流；工作流实现只依赖公共契约；装配只发生在 `runtime`。
3. **查询与命令分离**：HTTP 查询走 Query；命令的提交、回执、失败与恢复走 CommandEventBridge + CommandWorkflow，不把它们塞进 Query 缓存或全局 UI store。
4. **高频数据旁路**：遥测/告警/3D 变换不经过 Query、Zustand、XState，也不以逐帧 React state 更新（ARCH-11）。
5. **显式装配与生命周期**：实时源、桥、工作流注册表由 `FabRuntime` 按 FAB 装配和销毁；组件不 new 单例、不自行订阅裸 WebSocket。
6. **可测试的门禁**：每条硬规则要么有静态检查，要么有契约/集成测试；没有证据不宣称通过。
7. **文档与外部规范不互相篡改**：Engineering v1.1 文档保持只读；V2.1 的取代/保留关系在本文件第 8 节登记。

## 3. 分层与依赖方向

```text
                       +-------------------------------+
                       | app/providers + app/router    |  Router: 导航/预加载/URL 状态
                       | (QueryClient via ctx)         |
                       +---------------+---------------+
                                       |
             +-------------------------+-------------------------+
             |                                                   |
   +---------v----------+                             +----------v-----------+
   | features/components|                             | runtime (FabRuntime) |
   |  (React 渲染)      |                             |  装配 + 生命周期     |
   +----+----------+----+                             +----+-----------+-----+
        |          |                                       |           |
        |          +--> rendering (Babylon Lite/WebGPU)   |           |
        |                  ^                               |           |
        |                  | TypedArray/Worker             |           |
        |                  |                               |           |
        |        +---------+---------+          +----------v---+   +---v------------------+
        |        | realtime/workers  |          | realtime/    |   | runtime/commands  |
        |        | buffers/sync      |          | transport    |   | (XState v6 实现)     |
        |        +-------------------+          | protocol     |   +---+------------------+
        |                                       | streams      |       |
        |                                       +------+-------+       |
        |                                              |               |
        |  +--------------------------+                |               |
        +->| api/queries/mutations    |                v               |
           | endpoints -> HTTP API    |     +----------+---------------+ |
           +--------------------------+     | application/coordination | |
                                            | CommandEventBridge      | |
                                            +----------+--------------+ |
                                                       |                |
                                                       v                v
                                            +----------------------------+
                                            | application/contracts      |  <- 唯一公共契约
                                            | CommandEvents / Gateway /  |
                                            | RealtimeGateway / Workflow |
                                            +----------------------------+
```

允许的 import 方向（本基线强约束，迁移后由架构检查落实）：

| 层/目录 | 允许依赖 | 禁止依赖 |
|---|---|---|
| `app/providers`、`app/router` | `runtime`、`api/queries`、`features`、`components` | 具体工作流实现、`realtime/transport` 细节 |
| `features`、`components`、`rendering` | `api/queries/mutations`、`domain`、`schemas`、`shared`、`state` | 直接 new WebSocket、直接 import XState actor、绕过 Query 自建 HTTP 缓存 |
| `api/queries/mutations/endpoints` | TanStack Query、`schemas`（Zod）、`domain`、`application/contracts` | `runtime/commands`、`realtime` 传输实现 |
| `application/contracts` | 无（可依赖 RxJS 类型与领域类型；不依赖基础设施/工作流实现） | WebSocket、XState、React、Query |
| `application/coordination` | `application/contracts` | `runtime/commands`、XState、React、Query |
| `realtime` | `application/contracts`、`shared`、`domain` | `runtime/commands`、XState、React、Query |
| `runtime/commands` | `application/contracts`、`XState 内部类型`、XState v6、`domain` | `realtime/transport`、`app`、`api` |
| `runtime` | `application/contracts`、`application/coordination`、`realtime`、`runtime/commands`、`api/queries`（仅装配 QueryClient 引用） | 页面组件、UI 细节 |
| `domain` | 无外部包；`domain/**`、contracts（`src/generated/contracts.generated.ts`）、`web_app/assets` 数据 | React/Zustand/XState/@tanstack/Babylon，以及 app/features/state/rendering/realtime/runtime/application/components/api 的相对导入 |
| `state`（Zustand） | `domain`、`generated` 契约类型 | Query 结果副本、XState actor、引擎对象、跨 store 直接 `setState` 互写 |

## 4. 目录结构（`web_app/src`，2026-10-28 清理后）

以下为当前真实布局；V2.1 计划中的 `schemas/`、`shared/`、`api/endpoints/`、`realtime/streams/`、`realtime/synchronization/` 等目标子目录尚未创建，不在此虚构。

```text
web_app/
  src/
    app/
      providers/            AppProviders / QueryProvider / RuntimeProvider / RuntimeBootstrap / TelemetryProvider
      router/               router.tsx / search.ts（通用 schema+helper）/ url-mapping.ts / route-data.ts
        routeTree.gen.ts    文件式路由生成并提交
        routes/             装配入口：按 URL 组合 features 页面（唯一允许 import features 的 router 位置）
    api/
      queries/              queryClient / queryKeys / sites|equipment|catalog|runs|research|wafer.queries
      mutations/            runs|commands.mutations
    application/
      contracts/            CommandEvents / CommandGateway / CommandWorkflow（契约单点）
      coordination/         CommandEventBridge / CommandEventRecovery / CommandCorrelationRegistry / ScopeGate
    realtime/
      protocol/             MessageDecoder / SequenceTracker
      transport/            SseCommandEventSource / HttpCommandGateway
      telemetry/            TelemetryRuntime（传输/帧/背压）+ FabTelemetryRegistry（acquire/release）
                            + telemetry-buffer（低频 UI 合批）
      equipment-status.ts   SSE 设备状态监听与顺序门控
      workers/              telemetryWorker / createTelemetryWorker
      buffers/              FrameRingBuffer
    runtime/
      commands/             equipmentCommand.machine.ts / equipmentCommand.logic.ts /
                            CommandReconciler / XStateCommandWorkflowAdapter（位置非强制）
      FabRuntime / FabRuntimeFactory / FabRuntimeRegistry / FabLifecycleCoordinator / commandSources
    state/                 共享客户端状态（类型安全 createSliceStore）：runtimeStore / localeStore / preferences
    domain/                 纯领域模块（无框架/无包依赖；见 §3）：
      fab/                  fab-layout / process-control / fab-yield / cleanroom-pressure /
                            layout-identities / original-twin-data / twin-spatial
      amhs/ personnel/ wafer/ simulation/
      equipment/            tool-state-projection（遥测帧 → FabToolState 纯函数）
      contracts/            language（领域内共享类型）
    generated/              生成物（禁止手改；由 tools/* 生成）：contracts.generated.ts /
                            twin-translations.generated.ts / static-structure-packed.ts
    rendering/              scene 契约 + 产品后端 + Lite/WebGPU 实现
      fab-scene.ts          引擎无关 SceneBackend/SceneFacade 端口与 DTO
      lite-backend.ts       把 Lite runtime/world 封装为 SceneBackend 的产品后端
      lite/                 Babylon Lite / WebGPU 实现（geometry / shadows / 动效 / 选择 / airflow-texture）
      lite/geometry/        original-tool-parts / original-exploded-link-data（原版几何资产）
    features/
      twin/                 页面 + controllers/ + state/（twinUiStore/twinPageStore/twinDemoStore/twin-state）
                            + twin-search.ts + wafer-session.ts + equipment-status-pipeline.tsx
      catalog/              catalog-page / catalog-data / search / state/catalogStore
      workbench/            workbench / command-console / state/workbenchStore
    components/             共享 UI（ui / widgets / charting / modal / error-boundary /
                            class-names / original-icons）
    main.tsx / contracts.ts # 入口与公共契约 re-export；R6 门禁只允许这两个 root 文件
  tests/
    integration/            router-query / command-event-bridge / fab-runtime / runtime-bootstrap
    contract/               command-workflow / command-correlation / command-recovery
    performance/            telemetry-frame-buffer / telemetry-load
    architecture-boundaries.test.ts / architecture-import-graph.test.ts（架构门禁）
  assets/  vite.config.ts  package.json  tsconfig.json
```

实际与 V2.1 目标计划的差异：`schemas/`（Zod 集中在 api/queries 与 realtime/protocol）、`shared/`（未创建）、`api/endpoints/`（HTTP 统一在 api/queries/http.ts）尚未拆出；目录解释以本节与 §29 为准。

### 4.1 最终产品 URL（2026-10-27 一次性切换，永久不变）

| URL | 页面/职责 | 状态 |
|---|---|---|
| `/` | 工作台 / FAB 总览 | M1 已有 |
| `/fabs/$fabId/3d` | 3D FAB（3D 场景） | M1 已迁移 |
| `/equipment` | 设备目录 | M1 已迁移 |
| `/equipment/compare` | 设备对比 | M1 已迁移 |
| `/fabs/$fabId` | FAB 概览（后续里程碑实现） | 预留，当前未路由（无重定向） |
| `/equipment/$equipmentId` | 设备详情 | 预留 |
| `/amhs` | AMHS | 预留；多 FAB 后用 `?fabId=` 过滤 |
| `/alarms` | 告警 | 预留；多 FAB 后用 `?fabId=` 过滤 |

**旧产品地址已删除，不提供任何别名或重定向**：`/twin`、`/twin.html`、`/preview`、`/preview.html`、`/catalog`、`/catalog-demo`、`/catalog-demo.html`、`/compare`、`/compare.html`、`/workbench` 访问时返回 not-found。只使用上表的新地址；`lang/theme/siteId/modal/mode/perf/domain/category/q/hideDrafts/compare` 作为新地址的查询参数保留，不再为旧地址转发。

结构说明：

- **公共命令契约只放一次**：`application/contracts/CommandWorkflow.ts` 是权威定义；`XState 内部类型` 只放 XState 内部契约，不复制公共接口（G-03）。
- **路由文件位置**：`routes/fabs|equipment|amhs|alarms` 是 V2.1 目标分组；最终 URL 已由 M1 定稿，M2 删除旧地址后不存在别名/重定向（OPEN-V21-01 已解决，见 §4.1）。
- **测试位置**：按 ADR-0003 与 `tools/check_architecture.py`，测试不得放 `src`；V2.1 门禁统一落 `web_app/tests/integration`、`web_app/tests/contract`、`web_app/tests/performance`。
- **`domain`/`state`/`rendering`/`features`/`components`/`generated`** 已按清理后的真实布局落地：`domain/**` 是纯叶子层（见 §3/§29），生成物统一在 `src/generated/`；V2.1 计划中的 `schemas`/`shared`/`api/endpoints`/`realtime/streams`/`realtime/synchronization` 等目标子目录尚未创建，不把“未创建”描述成“已存在”。

## 5. 三条数据流与 FabRuntime

### 5.1 HTTP 数据流

```text
Router -> TanStack Query -> HTTP API -> Zod -> Query Cache -> React
```

（上图为规范流程图；实际触发点是 Router 的 navigation 或 intent 预加载 -> 路由 loader。）

1. 导航（或 intent 预加载）触发路由 loader。
2. loader 只调用 `context.queryClient.ensureQueryData(<queryOptions>)`；Query Options 与组件共用同一份定义（`api/queries/*.queries.ts`）。
3. Query 命中缓存则直接返回（即使已过 `staleTime`，也不会因此强制网络请求）；未命中才走 `api/endpoints` 的 HTTP 调用。
4. 响应在进入缓存前经 `schemas` 的 Zod 校验（计划依赖），校验失败不得写入缓存。
5. 页面用 `useQuery`/`useSuspenseQuery` 订阅同一 Query；后台刷新、失效、重连都会自动反映到 UI。
6. 需要权威新数据时（不能容忍旧缓存）使用 `queryClient.fetchQuery(...)` 显式获取；这是逐路由的显式决策，不是默认 loader 模式。

### 5.2 命令事件流

```text
WebSocket -> RxJS -> CommandEventBridge -> CommandWorkflow -> XState v6
```

1. `realtime/transport` 的 `WebSocketClient` 建立连接并处理鉴权/心跳/重连。
2. `realtime/protocol` 的 `MessageDecoder` 校验并解码为类型化消息，`SequenceTracker` 检测流序列缺口（只报告，不按业务语义丢弃）。
3. `realtime/streams` 的 `EventRouter` 按 topic 暴露 `CommandResultStream` 等类型化 Observable；它不知道 XState 与工作流。
4. `application/coordination/CommandEventBridge` 订阅结果流，按 `fabId` 过滤，按复合身份 `(fabId, commandId)` 关联，按 `revision` 去重，再调用 `CommandWorkflowRegistry.get(fabId, commandId)` 返回的工作流接口。
5. `runtime/commands/XStateCommandWorkflowAdapter` 把 `receive(event)` 映射到 `equipmentCommand.machine.ts` 的 actor 事件；`CommandReconciler` 处理缺口/缺失 actor/断线恢复。
6. 恢复以“关联恢复记录 + 后端权威状态查询 + 有界 pending queue”闭环；持久化恢复是后端责任（[命令核对](command-reconciliation.md)）。

### 5.3 高频渲染数据流

```text
WebSocket -> Worker -> TypedArray -> Babylon Lite -> WebGPU
```

1. 高频遥测/变换在 Worker 中解码并写入 `realtime/buffers` 的环形/双缓冲，数据结构为 TypedArray。
2. Worker 通过有界消息/共享内存把“脏实体/帧”交给渲染循环；UI 只接收低频聚合（如需）。
3. Babylon Lite 在 `rendering` 中消费缓冲区更新 GPU 实例属性；渲染循环不读 Query/Zustand/XState。
4. 该路径完全旁路 ARCH-02/05/11 禁止的容器；不得以逐事件 `setState` 或逐帧 Redux dispatch 实现。

### 5.4 FabRuntime：唯一生命周期装配点

- 每个 FAB 一个 `FabRuntime`：实时源（实现 `CommandEventSource`/`RealtimeGateway`）、`CommandEventBridge`、`CommandWorkflowRegistry` 与工作流实现都在这里组装。
- `FabRuntimeRegistry` 按 `fabId` 管理实例，`FabLifecycleCoordinator` 负责 start/stop/dispose 顺序与错误隔离（一个 FAB 失败不得拖垮其他 FAB）。
- 三 FAB 隔离：每个 FAB 独立 actor、订阅与关联记录；Query 仍为应用级单例，但 key 必须包含 `fabId`。
- Runtime **不拥有**服务端缓存；Query 缓存由 `QueryClient` 管理。详见 [FAB 运行时](fab-runtime.md)。

## 6. 强制架构规则 ARCH-01…ARCH-12

| ID | 规则 | 依据 | 落实方式 | 关联门禁 |
|---|---|---|---|---|
| ARCH-01 | Router 只负责导航与加载协调，不作为数据缓存 | ADR-0009 | 路由评审 + loader 检查；禁止 loader 返回体进组件 props 作为唯一数据源 | RQ-01..05 |
| ARCH-02 | TanStack Query 是唯一 HTTP 服务端数据缓存 | ADR-0009 | 迁移评审；禁止第二份 HTTP 缓存/Zustand 副本 | RQ-03、RQ-04 |
| ARCH-03 | Router 必须配置 `defaultPreloadStaleTime: 0` | ADR-0009 | 路由配置文件检查/单测 | RQ-01、RQ-02 |
| ARCH-04 | 路由 loader 复用 TanStack Query Options，禁止自带 queryFn/fetch | ADR-0009 | 代码评审 + 静态检查（计划） | RQ-01、RQ-05 |
| ARCH-05 | Zustand 不保存 Query 结果副本 | ADR-0009 | 状态评审；store 中禁止服务端 DTO 缓存字段 | RQ-03 |
| ARCH-06 | Realtime 不得 import 工作流实现/XState | ADR-0010 | 依赖检查 | CE-01..08 |
| ARCH-07 | CommandEventBridge 位于 Application 协调层 | ADR-0010 | 目录/依赖评审 | CE-01..05 |
| ARCH-08 | XState 实现隐藏在公共 `CommandWorkflow` 契约之后 | ADR-0010 | 契约单点定义 + 行为测试；**不强制目录**（M6 调整） | CE-01、CE-08 |
| ARCH-09 | Runtime 是事件源、桥、工作流实现的唯一装配层 | ADR-0010 | 装配评审；页面禁止 new 桥/actor | CE-07、CE-08 |
| ARCH-10 | 命令结果按 FAB+command 复合身份关联、去重、恢复 | ADR-0010 | 契约测试 + 集成测试 | CE-02..CE-07 |
| ARCH-11 | 高频遥测不得经过 Query/Zustand/XState | ADR-0010 + Engineering 09/15 | 架构评审 + 性能测试；渲染路径禁止读状态容器 | 性能门禁（计划） |
| ARCH-12 | Babylon Lite 是唯一 3D 引擎，且只允许 WebGPU | ADR-0003/Engineering 09 + ADR-0010 高频路径 | `tools/check_architecture.py` 禁止 WebGL；渲染评审 | 渲染验收（现有） |

规则的可执行检查在 M1..M6 逐步补齐。M1 已为 ARCH-03（router 配置 + 断言测试）与 ARCH-04（loader 只调用 `queryOptions`）提供可复核代码/测试；ARCH-02 由 RQ-03/RQ-04 与“全部端点只有 Query 一处缓存”的代码事实覆盖；ARCH-05 由 M2b 的 store 清单/评审覆盖（Zustand 只含 UI 字段，无 Query DTO 副本）；ARCH-06/07 已由 `tests/architecture-boundaries.test.ts` 静态检查并通过（M3）；ARCH-08 由契约单点/行为测试覆盖（M6 起不再检查 XState 所在目录）；ARCH-09/10 由 M4 的 FabRuntime 装配与三 FAB 隔离测试覆盖。其余规则在 M3–M6 补齐自动化检查前仍由评审负责。2026-10-28 增加真实 import 图门禁 `tests/architecture-import-graph.test.ts`（用项目自带 TypeScript Compiler API 解析全部源文件，不依赖正则）：R0 相对导入可解析、R1 运行图无环、R2 `app/router` 直接文件不依赖 `features/**`、R3 domain 纯度、R4 catalog/twin/workbench feature 互不依赖、R5 生成物登记/do-not-edit 头/数据化；与 `architecture-boundaries.test.ts` 的正则规则、`tools/check_architecture.py` 互补。

补充说明：ARCH-03 的 `defaultPreloadStaleTime: 0` 只是让 Router 不再否决 loader 重跑，是**必要但不充分**条件；Query 的 `staleTime`/`gcTime`、同源 Query Options、页面订阅、失效与显式 `fetchQuery` 共同决定数据新鲜度（见 [ADR-0009](adr/0009-tanstack-router-query-boundary.md) 第 3 节）。

## 7. 架构护栏（Constraints）

| ID | 护栏 | 说明 |
|---|---|---|
| G-01 | Vite server/build 参数冻结 | `web_app/vite.config.ts` 的 `server` 与 `build` 参数（端口 5173/strictPort/host、`/api` 代理、`build.rolldownOptions.manualChunks`）不得改变；允许新增路由生成插件，插件不得改变这些参数与产物结构；若插件不满足约束，路由退回 code-based 实现 |
| G-02 | 同一端点不得双缓存 | 迁移期 RTK Query 与 TanStack Query 不得同时缓存同一端点；按页面/端点在同一个 PR 内切换，旧缓存同 PR 删除 |
| G-03 | 公共契约单点定义 | 命令公共契约只在 `application/contracts` 定义一次；XState 实现内部类型不得复制公共契约 |
| G-04 | 基础设施不得反向依赖业务工作流 | `realtime` 不得 import 工作流实现/XState；依赖方向由契约层收口 |
| G-05 | 测试位置与证据诚实 | 测试只放 `web_app/tests`；未运行的测试只能标 SPECIFIED / NOT RUN，不得写“已通过” |

## 8. 与既有决策和外部规范的关系

### 8.1 ADR 状态

| ADR | 状态 | 与 V2.1 的关系 |
|---|---|---|
| [ADR-0001](adr/0001-flat-project-layout.md)…[ADR-0007](adr/0007-read-only-legacy-catalog.md) | 已采纳 | 保留。项目布局、单后端、只读目录等与前端 V2.1 不冲突 |
| [ADR-0008](adr/0008-redux-toolkit-rtk-query.md) | **已被取代（M2）** | RTK Query 由 ADR-0009 取代（M2a）；Redux Toolkit/react-redux 由 V2.1 的 Zustand store 取代（M2b）。仅保留“Babylon 对象不入状态容器、遥测合批”等原则（ARCH-11） |
| [ADR-0009](adr/0009-tanstack-router-query-boundary.md) | 已采纳，M1+M2b/M2c 已落地 | Router/Query 边界、全部 RQ 门禁已运行；Zustand（M2b）与 Router search（M2c）已接管；通用 router search 不含 feature 转换（P2 清理） |
| [ADR-0010](adr/0010-command-event-bridge.md) | 已采纳，M3+M4+M5c 已落地 | 实时类型化流、CommandEventBridge、恢复队列、XState v6 工作流与 FabRuntime 装配；CE-01..08 已在测试源上运行，后端模拟 HTTP/SSE 链路已接入（生产 WebSocket 仍待） |

### 8.2 Engineering v1.1 对账（外部规范不修改）

| 外部条目 | V2.1 处置 | 说明 |
|---|---|---|
| [15-FRONTEND 第 1 节](SemiconFab-Next-Engineering-v1.1/engineering/15-FRONTEND-AND-WEBGPU-PROJECTS.md)：推荐 React Router + TanStack Query + Zustand | TanStack Query、Zustand 保留；React Router 建议由 TanStack Router 取代 | 理由见 ADR-0009；外部文档保持原文 |
| [90-DECISIONS 第 2 节](SemiconFab-Next-Engineering-v1.1/engineering/90-DECISIONS-AND-OPEN-ITEMS.md)：SELECTED 含 TanStack Query、Zustand | 保留 | 与 V2.1 一致 |
| [08-API-EVENT-CONTRACTS](SemiconFab-Next-Engineering-v1.1/08-API-EVENT-CONTRACTS.md)、[14-CONTRACTS-AND-EVENT-FLOWS](SemiconFab-Next-Engineering-v1.1/engineering/14-CONTRACTS-AND-EVENT-FLOWS.md) | 保留为实时协议的上位规范 | 前端 `realtime/protocol` 必须遵守流/序列/ACK/RESYNC 语义；不另造第二套 |
| [09-WEBGPU-RENDERING](SemiconFab-Next-Engineering-v1.1/09-WEBGPU-RENDERING.md) | 保留 | WebGPU-only、性能与 CI 要求；高频路径见 [渲染管线](rendering.md) |
| [12-VERIFICATION-ACCEPTANCE](SemiconFab-Next-Engineering-v1.1/12-VERIFICATION-ACCEPTANCE.md) | 保留 | V2.1 的 RQ/CE 是前端附加门禁，不替代 TEST-P0 系列 |
| [15-FRONTEND 第 7 节](SemiconFab-Next-Engineering-v1.1/engineering/15-FRONTEND-AND-WEBGPU-PROJECTS.md) 性能目标 | 保留 | 渲染/性能目标仍是候选值，未经 V2.1 验证 |

## 9. 当前实现 vs V2.1 目标（差距表）

| 维度 | 当前（2026-10-28 可核对事实） | V2.1 目标 | 落点/阶段 | 状态 |
|---|---|---|---|---|
| 路由 | TanStack Router 接管顶层路由/URL/search；生成式路由树 + 最终 URL（M1）；旧地址与重定向已删除（M2）；目录筛选、compare、Twin 的 siteId/modal/mode/lang/theme 已由 Router search 拥有（M2c） | TanStack Router + 类型化 URL + intent 预加载 | M1/M2 | **M1/M2 PASS** |
| HTTP 服务端缓存 | 全部端点已由 TanStack Query 独占（M2a）；RTK Query/api.ts 已删除，无双缓存 | TanStack Query 唯一缓存；loader 复用 Query Options | M1/M2 | **M2a PASS** |
| 客户端状态 | 7 个 Zustand store（twinUi/twinPage/twinDemo/catalog/workbench/runtime/locale）承载 UI 状态；`createSliceStore` 为类型安全工厂（无 `any`/action 接口断言）；跨 store 协调经 feature 入口（如 `features/twin/wafer-session.ts`）；Redux/react-redux 已删除 | Zustand/组件局部；不复制 Query 数据 | M2b | **M2b PASS；P2 类型安全化** |
| 实时推送 | 设备状态 SSE + 后端模拟命令/遥测 SSE（20Hz）已接入产品；类型化流解码/序列/桥接 M3 已验证；WebSocket 传输仍可后续替换 | WebSocket/SSE -> Decoder -> RxJS -> 类型化流 | M3/M4/M5c | **PASS（HTTP/SSE 模拟后端）；WebSocket 未接** |
| 命令链路 | 契约 + Bridge + 恢复 + XState 工作流 + FabRuntime；M5c 接入后端模拟命令 API（POST/GET/SSE）与 Workbench 命令面板；浏览器实测 accepted→executing→succeeded；WebSocket 生产链路可后续替换 | CommandEventBridge + CommandWorkflow + 恢复 | M3/M4/M5c | **PASS（HTTP/SSE 模拟后端 + 浏览器 e2e）；WebSocket 未接** |
| XState | XState v6 已接入，实现位于 `runtime/commands`，经 `CommandWorkflow` 契约暴露 | XState v6（隐藏在 `CommandWorkflow` 后） | M4/M5a | **PASS** |
| FabRuntime | `runtime/` 四件套已实现，RuntimeBootstrap 按 sites 为每个 FAB 装配；命令源为后端命令 SSE，gateway 为权威 HTTP 查询 | `FabRuntime` 等四件套，按 FAB 装配/销毁 | M4/M5a | **PASS（模拟后端；WebSocket 未接）** |
| 多 FAB | 后端默认 FAB-01/02/03（`Fab:FabCount` 1..32）；前端 Runtime/遥测/设备状态/UI 按 FAB 数据驱动；121 台设备布局在 `domain/fab/fab-layout.ts` | 三 FAB 隔离：独立 actor、订阅、复合身份 | M4/M5a | **PASS（模拟后端）** |
| 高频遥测 | 后端 20Hz 遥测 SSE → TelemetryRuntime（传输/解码/帧/背压）→ Worker FrameRingBuffer → 渲染 frame loop；槽位投影为纯函数 `domain/equipment/tool-state-projection.ts`；`FabTelemetryRegistry` 按 FAB acquire/release；不经 Query/Zustand/XState（ARCH-11） | Worker/TypedArray -> Babylon Lite | M5b/M5c/P2 | **PASS（模拟后端 + Worker + 渲染接线）**；SharedArrayBuffer/COOP-COEP 未启用 |
| 渲染 | Babylon Lite 1.36 在 `src/rendering/lite`（M5b 目录归位），WebGPU-only；M5c 真实浏览器 WebGPU 性能门禁已运行 | 保留 | M5/M5c | **PASS（目录归位 + Chrome WebGPU 门禁）** |
| 依赖 | TanStack Router 1.170.46 / Query 5.105.0 / Router plugin 1.168.48、Zustand 5.0.16、RxJS 7.8.2、Zod 4.6.7、XState v6；jsdom 30.1.3 + Testing Library（dev）；Redux/react-redux 已移除 | 按阶段引入并锁版本；XState 实现经契约隔离 | M1..M4 | M2b 已移除 Redux；XState v6 已接入 |
| 测试基建 | Vitest + jsdom + Testing Library；RQ/CE/架构（含真实 import 图 R0–R5）/传输/Worker 测试真实运行；真实 GPU 性能脚本 | 契约/集成 + CPU/GPU 性能门禁 | M1 起 | **M1–M5 PASS；GPU 门禁已运行** |
| 架构检查 | Vitest 检查 ARCH-06/07/08 契约边界与 features 归位；`architecture-import-graph.test.ts` 真实 import 图 R0–R5；`tools/check_architecture.py` 检查终态路径/依赖/ARCH-11 + domain 分层/旧根模块缺席/generated 区域 | 可执行检查 | M6/P2 | **PASS（实际运行）** |
| 文档 | V2.1 基线 + ADR-0009/0010 + 7 篇专项已合入 main（e18595f）；本文档补充 M1–M6/review/P2 清理记录 | 本基线 + ADR-0009/0010 + 7 篇专项 | M0 | **M0 PASS；后续增量已更新** |

## 10. 分阶段迁移计划

> 阶段编号 M0..M6；每阶段结束必须有对应门禁证据才能进入下一阶段。下表为阶段记录：M0–M6 均已完成。

| 阶段 | 主题 | 主要交付 | 退出条件（Exit criteria） | 依赖/阻塞 | 状态 |
|---|---|---|---|---|---|
| M0 | 架构基线文档 | 本文件、ADR-0009/0010、7 篇专项、实施状态指针 | 文档评审通过；ARCH/RQ/CE/目录/数据流可追踪 | 无 | **完成并推送（e18595f）** |
| M1 | 路由与查询地基 | 依赖、`app/providers`、`app/router`、`api/queries`、最终 URL（旧地址 M2 删除）、sites 端点迁移、RQ-01/RQ-05 集成测试 | typecheck/build/test 通过；RQ-01/RQ-05 首次运行；无双缓存；vite server/build 参数未变 | 已解除（OPEN-V21-01/02/03 已决策） | **PASS（2026-10-27，§15）** |
| M2 | 客户端状态与 RTK 退役 | **M2a（完成）**：全部端点迁 Query、RTK Query 删除、RQ-02/03/04 运行、旧地址删除。**M2b（完成）**：7 个 Zustand store（当时文件清单）、Redux/react-redux/store 删除、测试迁移 jsdom | 无 RTK Query 端点；RQ-02/03/04 PASS；Zustand 不含 Query 副本；Redux 依赖为零 | M1 | **M2 PASS（§16/§17）** |
| M3 | 实时协议与命令桥 | 契约、解码/序列、类型化流、WebSocket 传输骨架、CommandEventBridge/恢复队列、假源集成测试、ARCH 边界静态检查 | CE-01..CE-05、CE-08 在假源上运行；ARCH-06/07 检查通过 | M1；后端流协议 OPEN-V21-06（真实链路） | **PASS（2026-10-27，§19）；真实 WebSocket M4+** |
| M4 | XState 工作流与 FabRuntime | `runtime/commands` 四文件、`runtime` 四件套、`RuntimeProvider` seam、三 FAB 隔离测试 | CE-06/CE-07 在测试源上运行；ARCH-08/09/10 检查通过；单 FAB 产品回归通过（现有 290 测试） | M3；OPEN-V21-07/08；多 FAB 产品范围 | **PASS（2026-10-27，§20）** |
| M5 | 高频渲染管线与目录归位 | **M5a（完成）**：XState v6 产品 Runtime 接线 + 多 FAB 数据驱动 UI + 工作流只读投影。**M5b（完成）**：`rendering/lite` 目录归位、FrameRingBuffer/Worker 协议骨架、ARCH-11 静态检查、CPU 性能基线 | M5a：产品 bundle/生命周期接入 XState、runtime/FAB UI 可见、投影 API 只读；M5b：ARCH-11 检查、性能基线记录、Lite 回归 | M1/M4 | **M5a/M5b PASS（§21/§22）**；真实 Worker/遥测接线与 GPU 性能门禁留待后续 |
| M6 | 收口与退役 | 旧迁移文档/证据/parity 工具与测试删除、旧路径/依赖/XState/ARCH-11 静态检查、README/状态文档收口 | `./scripts/verify.ps1` 实际通过并留有记录；ARCH 检查可执行 | M2/M4/M5；后端实时服务 | **PASS（2026-10-27，§23）**；CE-06 真实链路需后端 |

**关键路径**：M1 -> M2 -> M3 -> M4 为主链；M5 可与 M3/M4 并行，但依赖现有 Twin/Lite 工作收尾。真实后端 WebSocket 是 CE-04/CE-06 的硬依赖，前端不得用假源证据替代生产链路验收。

## 11. 风险登记

| ID | 风险 | 影响 | 缓解 | 触发信号 |
|---|---|---|---|---|
| R-01 | 双栈期间残留两份缓存（RTK Query + Query） | 数据不一致、RQ 门禁失真 | G-02 按端点同 PR 切换；M2 结束前做“无 RTK 端点”静态清单 | 同一端点出现两套 hooks/请求 |
| R-02 | 路由插件改变 Vite build 行为 | 违反 G-01、产物/分包变化 | 插件仅生成路由树；对比 build 产物与 manualChunks；不满足则 code-based | build 产物/分包 diff |
| R-03 | 集成测试环境缺失（jsdom/Testing Library） | RQ/CE 无法执行，门禁长期 NOT RUN | M1 前置批准 devDependencies；先写环境 smoke test | RQ 测试无法启动 |
| R-04 | 后端实时/命令状态端点未提供 | CE-04/CE-06 无法真实闭环 | 假源只用于结构验证；后端契约列为 OPEN-V21-06/07 | 真实链路验收缺失 |
| R-05 | 多 FAB 产品范围未定 | FabRuntime 三 FAB 隔离只能测试床验证 | 以复合身份与假 FAB 源覆盖 CE-07；产品范围由 Lead 决策 | 需求变化 |
| R-06 | ~~XState 版本风险~~ | **已关闭**：按用户要求固定 v6；实现经 `CommandWorkflow` 契约暴露，升级需重跑契约/集成测试 | — |
| R-07 | intent 预加载在 loader 误用 `fetchQuery` 时放大请求 | 性能与后端压力 | RQ-01/RQ-05 请求计数断言；loader 评审 | 预加载请求数异常 |
| R-08 | ~~迁移与 Twin/Lite parity 工作冲突~~ | **已关闭（M6）**：旧迁移/parity 文档与测试已删除，渲染目录已归位 | — |
| R-09 | 架构检查滞后，ARCH 规则只靠人工评审 | 规则漂移 | M6 前把 ARCH-02/05/06/08/09 纳入 `tools/check_architecture.py` | 评审发现违规 |
| R-10 | 文档与实现漂移 | 错误基线误导后续开发 | 每阶段更新 `IMPLEMENTATION-STATUS` 与本文件差距表；门禁证据可追踪 | 文档状态与代码不符 |

## 12. 验证与证据状态

### 12.1 状态图例

| 标签 | 含义 |
|---|---|
| SPECIFIED / NOT RUN | 测试用例已定义，尚未实现/执行；本文档不提供通过证据 |
| IMPLEMENTED / NOT RUN | 代码已存在，测试尚未执行（V2.1 目前没有此状态） |
| PASS / FAIL | 只有真实执行记录才能使用；本基线不使用 |

### 12.2 门禁索引与测试文件映射（计划）

所有门禁的定义分别在 [路由与查询集成](router-query-integration.md) 第 7 节（RQ）与 [命令事件桥](command-event-bridge.md) 第 9 节（CE）；本表只做索引与证据状态登记。

| 门禁 | 内容摘要 | 计划测试位置 | 状态 |
|---|---|---|---|
| RQ-01 | hover 预加载后立即导航复用 Query 数据 | `web_app/tests/integration/router-query.test.tsx` | **PASS（M1）** |
| RQ-02 | 预加载后过期导航遵循 Query 新鲜度 | `web_app/tests/integration/query-cache.test.tsx` | **PASS（M2a）** |
| RQ-03 | mutation 失效展示权威数据 | `web_app/tests/integration/query-cache.test.tsx` | **PASS（M2a）** |
| RQ-04 | FAB-A/FAB-B 相同设备 id 不串缓存 | `web_app/tests/integration/query-cache.test.tsx` | **PASS（M2a）** |
| RQ-05 | 重叠预加载/导航复用 in-flight 请求 | 同上 | **PASS（M1）** |
| CE-01 | 正常派发（accepted/executing/succeeded） | `web_app/tests/integration/command-event-bridge.test.ts` | **PASS（M3 假源）** |
| CE-02 | 重复 revision 过滤 | 同上 | **PASS（M3 假源）** |
| CE-03 | 乱序事件不回退 | 同上 | **PASS（M3 假源）** |
| CE-04 | 确认先于 HTTP 响应仍关联 | 同上 | **PASS（M3 假源；真实 WS/HTTP 竞态 M4）** |
| CE-05 | actor 缺失时通过核对恢复 | 同上 + `tests/contract/command-recovery.test.ts` | **PASS（M3 假源/假 gateway）** |
| CE-06 | 重连后通过后端权威查询收敛 | `tests/contract/command-workflow.test.ts`、`tests/integration/fab-runtime.test.ts`、真实后端 `GET /api/v1/commands/{id}` | **PASS（测试源 + 模拟后端端点已接）** |
| CE-07 | 三 FAB 相同 commandId 隔离 | `tests/integration/fab-runtime.test.ts` | **PASS（M4 三 FAB 测试源）** |
| CE-08 | Runtime 关闭后取消订阅/停止 actor | `tests/integration/command-event-bridge.test.ts`、`tests/integration/fab-runtime.test.ts` | **PASS（M4 FabRuntime 生命周期）** |
| 性能 | 渲染/高频路径帧预算与帧率 | `web_app/tests/performance`、`tools/render_perf.mjs` | **PASS（CPU TypedArray 基线 + Chrome WebGPU 门禁：179 frames，p95 8.5ms）** |

### 12.3 当前测试基建事实

- 已安装 jsdom 30.1.3、@testing-library/react 16.3.3、TanStack Router/Query、Zustand、XState v6、RxJS、Zod，并建立 `web_app/tests/integration`。
- RQ/CE/ARCH 与产品装配测试真实运行：前端 **90 文件 / 532 测试 PASS**（含 `architecture-boundaries.test.ts` 正则规则与 `architecture-import-graph.test.ts` 真实 import 图 R0–R5；默认并发全量 PASS，CPU 密集黄金向量套件统一 `testTimeout: 15s`）；后端 **170/170 PASS**；真实 Chrome WebGPU 性能门禁已运行。
- 剩余边界：WebSocket 生产传输、SharedArrayBuffer/COOP-COEP、后端非模拟实现；见 §24/§26。

## 13. 文档地图

| 文档 | 内容 | 关联 |
|---|---|---|
| [架构基线](architecture.md)（本文） | 汇总、目录、规则、数据流、差距、迁移计划 | ADR-0009/0010 |
| [路由与查询集成](router-query-integration.md) | Router/Query 职责、配置、loader 模式、新鲜度矩阵、RQ-01..05 细则 | ADR-0009 |
| [状态管理](state-management.md) | 状态所有权、Query/Zustand/XState/实时缓冲区边界、Redux 迁移映射 | ADR-0009/0010 |
| [实时协议](realtime-protocol.md) | WebSocket/解码/序列/EventRouter 类型化流、与 Engineering 08/14 的关系 | ADR-0010 |
| [命令事件桥](command-event-bridge.md) | 契约、Bridge 流程、CE-01..08 细则 | ADR-0010 |
| [命令核对](command-reconciliation.md) | 关联恢复记录、权威查询、有界队列、断线/乱序/缺失 actor | ADR-0010 |
| [FAB 运行时](fab-runtime.md) | FabRuntime 四件套、装配顺序、三 FAB 隔离、生命周期 | ADR-0010 |
| [渲染管线](rendering.md) | Babylon Lite/WebGPU-only、高频旁路、与状态容器的边界 | ARCH-11/12 |
| [ADR-0009](adr/0009-tanstack-router-query-boundary.md) | 决定 1 | — |
| [ADR-0010](adr/0010-command-event-bridge.md) | 决定 2 | — |
| [实施状态](IMPLEMENTATION-STATUS.md) | 当前代码事实与 V2.1 指针 | 全部 |

## 14. 开放问题汇总

| ID | 问题 | 建议决策人/时点 |
|---|---|---|
| OPEN-V21-01 | ~~最终 URL、重定向与保留策略~~ | **已解决（M1/M2，§4.1）**：最终 URL 已定稿；旧地址与重定向按要求全部删除 |
| OPEN-V21-02 | ~~Router/Query/插件版本~~ | **已解决（M1）**：Router 1.170.46 / Query 5.105.0 / plugin 1.168.48（lockfile 记录），其余见 §9 依赖行 |
| OPEN-V21-03 | ~~测试环境~~ | **已解决（M1）**：jsdom 30.1.3 + @testing-library/react 16.3.3 / dom 10.4.2（devDependencies） |
| OPEN-V21-04 | ~~是否引入 `@/` 路径别名~~ | **已解决（M1）**：继续使用相对导入，不引入路径别名（与 ADR-0003 一致） |
| OPEN-V21-05 | `useSuspenseQuery` 的渲染边界与错误/加载 UI | 实施者，M1 |
| OPEN-V21-06 | 后端实时流协议、序列/ACK/鉴权/maxHz | 后端/Lead，M3 |
| OPEN-V21-07 | 后端命令状态查询端点（权威恢复） | 后端/Lead，M3 |
| OPEN-V21-08 | ~~XState 版本与 actor 粒度~~ | **已解决（M4）**：按用户要求采用 v6；每个 command 一个 actor，由 `XStateCommandWorkflowAdapter` 实现 |
| OPEN-V21-09 | ~~前端恢复记录生命周期~~ | **已决策（M3）**：内存有界队列（`CommandEventRecovery`，per-command/global 上限）；持久恢复仍归后端 |
| OPEN-V21-10 | CommandGateway HTTP 提交契约 | **部分解决（M4）**：状态查询接口已定义；提交/幂等契约仍待后端 |
| OPEN-V21-11 | ~~FabRuntime 实例化/卸载语义~~ | **已完成（M5a）**：RuntimeBootstrap 按 sites 数据为每个 FAB 装配并启停；StrictMode 安全清理 |
| OPEN-V21-12 | ~~README/外部规范是否增加 V2.1 指针~~ | **已解决（M1）**：README 文档区已加 V2.1 指针；Engineering v1.1 保持只读 |
| OPEN-V21-13 | ~~工作流状态只读暴露~~ | **已解决（M5a）**：`CommandWorkflowProjection` 契约 + `useCommandProjection` hook；UI 只读，不反写 actor |
| OPEN-V21-14 | 是否使用 SharedArrayBuffer（COOP/COEP 部署策略） | 实施者，M5 |
| OPEN-V21-15 | ~~告警/遥测 topic 命名~~ | **前端已定义（M3）**：`command.result` / `alarm.event` / `telemetry.frame`；订阅范围（per FAB/run/LOD）待后端 M4 |
| OPEN-V21-16 | ~~解码 schema 单一来源~~ | **已决策（M3）**：手写 Zod schema 集中 `realtime/protocol/MessageDecoder.ts`；契约生成留待契约稳定后评估 |

## 15. M1 落地记录（2026-10-27）

> 本节只记录已执行证据；未运行项仍为 SPECIFIED / NOT RUN。

### 15.1 交付

| 项 | 实现 | 文件 |
|---|---|---|
| Query 单例与 key | `QueryClient`（staleTime 30s、retry 1、关闭 window-focus refetch）、`queryKeys.sites.all` | `web_app/src/api/queries/queryClient.ts`、`queryKeys.ts` |
| sites 端点迁移 | `sitesQueryOptions()` + `fetchSites`（Zod 校验、ProblemDetails 错误）；RTK Query 删除 `getSites`，同一端点不再有第二份缓存 | `web_app/src/api/queries/sites.queries.ts`、`web_app/src/store/api.ts`（该文件已在 M2a 删除，见 §16） |
| Providers | Redux Provider → QueryClientProvider → ErrorBoundary | `web_app/src/app/providers/AppProviders.tsx`、`QueryProvider.tsx` |
| Router | `createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent', defaultPreloadStaleTime: 0 })`；QueryClient 经 `createRootRouteWithContext` 注入 | `web_app/src/app/router/router.tsx`、`routes/__root.tsx` |
| 最终 URL | §4.1 的新地址；旧地址/别名/重定向已在 M2 删除（无 catch-all 别名路由） | `web_app/src/app/router/url-mapping.ts`、`routes/fabs/...`、`routes/equipment/...` |
| 路由 loader | 只调用 `queryClient.ensureQueryData(sitesQueryOptions())`；FAB 不存在时返回路由错误（无重定向） | `web_app/src/app/router/route-data.ts`、`routes/fabs/$fabId/3d.tsx` |
| 入口 | `main.tsx` 改为 `StrictMode → AppProviders → RouterProvider`，删除自定义 pathname switch | `web_app/src/main.tsx` |
| 依赖 | Router 1.170.46、Query 5.105.0、router-plugin 1.168.48、Zustand 5.0.16、RxJS 7.8.2、XState v6（见 §16）、Zod 4.6.7；dev：jsdom 30.1.3、Testing Library 16.3.3 | `web_app/package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` |
| Vite | 仅新增 `tanstackRouter({ autoCodeSplitting: false })` 插件；`server`/`build` 原文未变（G-01） | `web_app/vite.config.ts` |
| 路由树 | `routeTree.gen.ts` 由插件生成并提交，不手工维护 | `web_app/src/app/router/routeTree.gen.ts` |

`pnpm-workspace.yaml` 是 pnpm 12 的配置载体（`minimumReleaseAgeExclude`，批准本次锁定的 TanStack 版本），不是 workspace 定义，不改变 ADR-0001 的扁平项目布局。

### 15.2 证据（本次实际运行）

- `node node_modules/vite/bin/vite.js build` → exit 0（1,550 modules；路由树生成）。
- `npx tsc --noEmit` → exit 0。
- `npx vitest run` → **56 文件 / 259 测试 PASS**（M1 前 53 / 245；新增 `tests/integration/router-query.test.tsx`、`url-mapping.test.ts`、`sites-queries.test.ts`）。
- `./scripts/verify.ps1` → exit 0（契约/架构检查、16 个 Python 工具测试、3 个 .NET Release 构建 + 67/67、全部冻结向量门禁、前端 typecheck/test/build）。
- RQ-01：预加载后导航只发生 1 次 `/api/v1/sites` 请求且 loaderData 为同一 Query 缓存对象；RQ-05：并发 `ensureQueryData`+`fetchQuery` 只发生 1 次在途请求（均见集成测试断言）。
- 无双缓存：`getSites` 仅出现在“不存在”的负向断言中；`/api/v1/sites` 只有 `sitesQueryOptions` 一个数据入口。
- `/equipment`、`/equipment/compare`、`/fabs/FAB-01/3d` 在 `vite preview` 生产构建下均返回 200 + SPA 外壳（深链接可刷新）；旧地址已删除，不属于路由契约。

### 15.3 过渡与遗留

- 设备目录/对比页内部筛选与视图切换仍用 `history` + Redux 过渡：路径已改为最终 URL，页面内部状态迁移留待 M2（代码注释已标注）。
- Twin 的 `?siteId=`/`?modal=`/`?mode=` 仍直接读写 `location.search`；路由参数 `$fabId` 优先于旧 `siteId`，M2 迁到 Router search。
- 仅 `/api/v1/sites` 迁到 TanStack Query；其余 7 个 RTK Query 端点与 Redux slice 按 M2 的“同一变更内逐端点切换、无双缓存”执行。
- XState 按用户要求直接采用 v6；M4 接入工作流。
- 以上是 M1 当时的记录；M2a/M2b 之后已由 §16/§17 取代。CE-01..08、性能门禁仍为 SPECIFIED / NOT RUN。

## 16. M2a 落地记录（2026-10-27）

> 本节记录 M2 的数据层（M2a）；Zustand/Redux 退役（M2b）见 §17。

### 16.1 交付

- **全部 7 个 RTK Query 端点迁到 TanStack Query**：equipment status、catalog、runs list/detail/results、research JSONL、wafer routes；模块位于 `web_app/src/api/queries/`，mutation 位于 `web_app/src/api/mutations/runs.mutations.ts`。
- **RTK Query 退役**：删除 `web_app/src/store/api.ts`、`twinApi` reducer/middleware 与 `tests/rtk-api.test.ts`；Redux 只剩临时客户端 UI slice（M2b）。
- **SSE 走 Query 缓存**：Twin 的 `watchEquipmentStatus` 快照除有序消费外写入 `equipmentStatusQueryKey(siteId)`，Query 是唯一服务端缓存；轮询仅作回退。
- **旧地址与重定向彻底删除**：`/twin*`、`/preview*`、`/catalog*`、`/compare*`、`/workbench` 不再有别名/catch-all 重定向（访问返回 not-found）；`/fabs/$fabId` 的 M1 重定向入口也删除，仅保留 `/fabs/$fabId/3d`。
- **XState**：按用户要求改为 v6；actor/工作流在 M4 接入。
- 其余 Query 模块：`queryKeys.ts` 增加 equipment/catalog/runs/research/wafer 工厂；transport 统一在 `api/queries/http.ts`（same-origin、no-store、Zod envelope 校验、ProblemDetails）。

### 16.2 证据（本次实际运行）

- `npx tsc --noEmit` → 0；`npx vitest run` → **57 文件 / 260 测试 PASS**；`vite build` → 0。
- RQ-02/RQ-03/RQ-04 新增于 `web_app/tests/integration/query-cache.test.tsx`：过期数据由页面订阅刷新、mutation 失效后读回权威列表、按 siteId 隔离 equipment status 缓存。
- `web_app/tests/api-queries.test.ts` 覆盖 Query transport（URL/credentials/no-store/Idempotency-Key/ProblemDetails/Zod 拒绝）。
- `./scripts/verify.ps1` 见 M2a 提交记录（契约/架构、16 Python、3 .NET + 67、冻结向量、前端全量）。

### 16.3 过渡与遗留

- ~~Redux Toolkit 仍承载 7 个客户端 UI slice~~：M2b 已迁 Zustand 并删除 Redux/react-redux（§17）。
- ~~目录/对比页内部筛选、Twin 的 `?siteId/?modal/?mode` 仍是 history/直接 location 过渡~~：已在 M2c 迁到 TanStack Router search（§18）。
- XState v6：M4 接入工作流并经 `CommandWorkflow` 契约暴露，不向页面泄漏 actor。
- CE-01..08、性能门禁、M3–M6 未开始。

## 17. M2b 落地记录（2026-10-27）

> 本轮完成客户端状态迁移与 Redux 退役；Router search 清理（目录筛选/Twin URL 参数）随后在 M2c 完成，见 §18。

### 17.1 交付

- **Zustand 接管客户端状态**：新增 `web_app/src/state/`：`twinUiStore`、`twinPageStore`、`twinDemoStore`、`catalogStore`、`workbenchStore`、`runtimeStore`、`localeStore`，以及 `state/telemetry-buffer.ts`；store 使用纯不可变 reducer（`createSliceStore`，无 Immer），actions 为 store 方法（无 Redux dispatch）。**历史记录：** 2026-10-28 清理后 feature store 已归位 `features/*/state/`，共享状态保留在 `state/`（见 §29.6）。
- **Redux 彻底删除**：删除 `web_app/src/store/`（7 个 slice、hooks、store、api 残留）、`react-redux`/`@reduxjs/toolkit` 依赖；`AppProviders` 仅保留 QueryClientProvider + ErrorBoundary。
- **Twin 保留性能边界**：twin-page 仍用 wafer-excluded shallow 订阅避免逐帧 HUD 更新触发整页渲染；帧循环通过 `getState()` 读取 live 状态，不新增 React 状态。
- **测试迁移**：Redux slice 测试改写为 Zustand store/action 测试；需要已挂载状态的组件测试改为 jsdom + Testing Library（Zustand SSR 快照为初始状态）；telemetry-buffer 路径迁移。
- **依赖**：未新增第三方包（Zustand 原生 + 纯不可变 reducer）；`react-redux`、`@reduxjs/toolkit` 移除。XState 为 v6。

### 17.2 证据（本次实际运行）

- `npx tsc --noEmit` → 0；`npx vitest run` → **57 文件 / 260 测试 PASS**；`vite build` → 0（1,562 modules）。
- `./scripts/verify.ps1` → exit 0（契约/架构、16 Python、3 .NET + 67、冻结向量、前端全量）。
- 代码事实：无 `react-redux`/`@reduxjs/toolkit`/`useAppSelector`/`dispatch(` 引用；`src/store/` 不存在；服务端数据仅存在于 Query 缓存（ARCH-02/05 评审通过）。

### 17.3 遗留

- ~~目录筛选、对比选择与 Twin 的 `siteId/modal/mode` 仍由页面直接读写 `location`~~：M2c 已完成（§18）。
- ARCH-02/05 的自动化静态检查留待 M6（当前由“无第二缓存/无 DTO 副本”的代码审查与 RQ-03/04 覆盖）。
- M3 随后完成（§19）；M4–M6 与 CE-06/CE-07、性能门禁仍未开始。
## 18. M2c 落地记录：Router 拥有 URL/search 状态（2026-10-27）

> 补齐 M2 的 URL/搜索状态所有权：页面不再直接读写 `location`/`history` 来保存产品状态。

### 18.1 交付

- Router search 已是 catalog 与 Twin 产品状态的唯一来源：目录筛选、隐藏 draft、对比选择、Twin 的 `siteId`/`modal`/`mode`、`lang`/`theme` 均通过 `RouterSearch` 传入/写回。
- 目录/对比：路由组件通过 `Route.useSearch()`/`Route.useNavigate()` 提供 `search` + `onSearchChange`/`onViewChange`；`catalog-page.tsx` 不再使用 `location`、`history`、`readCatalogRoute`，搜索参数变化即 hydrate 页面状态；翻页/导入等纯客户端状态仍留 store。
- Twin：`/fabs/$fabId/3d` 路由组件传入 `search`/`onSearchChange`；`twin-page.tsx` 的 modal/mode/siteId/语言主题改由 search 驱动，模式切换经 Router 写回；`twin-i18n.tsx` 与 `localeStore.ts` 不再写/读 `location`。
- 保留的 `location` 读取仅限渲染内部调试开关（`liteDebug`、`perf`、`hoverPickMs`），不参与产品状态。
- `catalog-data.readCatalogRoute` 已删除（旧 URL 解析残留）；`url-mapping.test.ts` 继续覆盖最终 URL/旧地址无映射。

### 18.2 测试与证据

- 新增 `web_app/tests/integration/router-search.test.ts`：catalog 筛选/对比 ID 解析、搜索 patch 序列化、Twin mode/modal/siteId 转换。
- 更新 `catalog-page.test.tsx`（显式传入 Router search props）及依赖 `readCatalogRoute` 的旧测试。
- 实际运行：`tsc --noEmit` 0；`npx vitest run` **58 文件 / 262 测试 PASS**；`vite build` 0；`./scripts/verify.ps1` exit 0（契约/架构、16 Python、3 .NET + 67、冻结向量、前端全量）。

### 18.3 遗留

- 渲染层调试开关（`perf`/`liteDebug`/`hoverPickMs`）继续直接读 `location.search`，属于诊断用途，不进入状态容器。
- M3 随后完成（§19）；M4–M6 与 CE-06/CE-07、性能门禁仍未开始。
## 19. M3 落地记录：实时契约、类型化流与 CommandEventBridge（2026-10-27）

> 本轮只实现前端实时契约与假源验证；后端 `--realtime` 仍是占位，真实 WebSocket/命令链路在 M4+ 接入。

### 19.1 交付

- **Application 契约**（`web_app/src/application/contracts/`）：`CommandEvents`（CommandResultEvent/CommandEventSource/Alarm/Telemetry）、`CommandWorkflow`（公共契约单点）、`CommandGateway`（权威状态查询）、`RealtimeGateway`（类型化流接口）。
- **Application 协调**（`application/coordination/`）：`CommandCorrelationRegistry`（FAB+command 复合身份与 revision 水位）、`CommandEventRecovery`（有界恢复队列 + 权威对账）、`CommandEventBridge`（订阅/过滤/去重/分发/重试；无 WebSocket/XState 依赖）。
- **Realtime**：`protocol/MessageDecoder`（手写 Zod envelope + command/alarm/telemetry 校验）、`protocol/SequenceTracker`（per-topic 顺序/重复/缺口/乱序）、`streams/EventRouter`（共享一次解码的 RxJS 类型化流 + 错误/缺口流）、`CommandResultStream`/`AlarmStream`/`TelemetryStream`、`transport/WebSocketClient` 骨架（未装配，保留后续接入能力）。
- **ARCH 静态检查**：`tests/architecture-boundaries.test.ts` 验证 ARCH-06/07（realtime 不依赖工作流实现/XState/React 状态库；application 只依赖 contracts）与 CommandWorkflow 契约单点定义。

### 19.2 证据（假源/假 gateway）

- CE-01 正常派发、CE-02 重复 revision 过滤、CE-03 乱序不回退、CE-04 确认先于 HTTP 响应、CE-05 缺失 actor 经恢复/对账、CE-08 bridge 生命周期：`tests/integration/command-event-bridge.test.ts` PASS。
- 恢复队列边界/去重/权威对账：`tests/contract/command-recovery.test.ts` PASS。
- 解码/序列/EventRouter 类型化流：`tests/realtime-protocol.test.ts` PASS。
- 实际运行：`tsc --noEmit` 0；`npx vitest run` **62 文件 / 280 测试 PASS**；`vite build` 0；`./scripts/verify.ps1` exit 0（契约/架构、16 Python、3 .NET + 67、冻结向量、前端全量）。

### 19.3 遗留与边界

- **真实生产链路未接**：WebSocketClient 未装配，后端 `--realtime`/命令状态端点仍是占位；CE-04/CE-06 的生产级证据需要后端（OPEN-V21-06/07/10）。
- **XState/Runtime 未开始**：CE-06/CE-07、ARCH-08/09/10 的 Runtime 装配与三 FAB 隔离在 M4。
- **高频遥测**：`TelemetryStream` 仅定义低频聚合帧契约；原始高频数据仍走 Worker/TypedArray 旁路（ARCH-11，M5）。
- 恢复队列为内存有界实现（每命令/全局上限），关闭页面即失效；持久恢复是后端责任。
## 20. M4 落地记录：XState v6 工作流与 FabRuntime（2026-10-27）

> 本轮实现工作流层与每 FAB 装配/生命周期，并在测试源上验证三 FAB 隔离；真实 WebSocket/命令状态后端仍缺，`RuntimeProvider` 仅提供接线 seam，未挂到产品树。

### 20.1 交付

- **XState v6 工作流**（`web_app/src/runtime/commands/`）：`equipmentCommand.machine.ts`（setup + `types<>` schemas、idle/accepted/executing/终态）、`equipmentCommand.logic.ts`（纯状态/修订/终态判定）、`XStateCommandWorkflowAdapter.ts`（实现公共 `CommandWorkflow`，revision 单调过滤、终态不再推进、dispose 停 actor）、`CommandReconciler.ts`（`CommandGateway` 权威查询后投递）。
- **FabRuntime 装配**（`web_app/src/runtime/`）：`FabRuntime`（每 FAB 一个 Bridge + workflow registry + 可选 reconciler；`trackCommand`/`reconcileCommand`/start/stop/dispose）、`FabRuntimeFactory`（按 FAB 注入 source/gateway/workflow 工厂）、`FabRuntimeRegistry`（fabId 唯一，startAll/stopAll/disposeAll）、`FabLifecycleCoordinator`（幂等生命周期）。
- **RuntimeProvider seam**（`app/providers/RuntimeProvider.tsx`）：暴露 registry 的 React context，未在 AppProviders 装配（无真实源）。
- **边界**：XState 位于 `runtime/commands`；其他层只依赖 `CommandWorkflow` 契约；页面/实时/application 均不直接 import 工作流实现。目录位置不构成强制（M6 调整）。

### 20.2 证据（测试源/假 gateway）

- CE-06：stream 停止后经 `CommandGateway` 权威查询收敛到 succeeded；CE-07：三个 FAB 使用相同 commandId 时各自 runtime/workflow 状态互不污染；CE-08：lifecycle stop 后不再投递、dispose 清理 workflow/registry。
- `tests/integration/fab-runtime.test.ts`（5）、`tests/contract/command-workflow.test.ts`（3）、`tests/architecture-boundaries.test.ts`（契约/边界检查）PASS。
- 实际运行：`tsc --noEmit` 0；`npx vitest run` **64 文件 / 290 测试 PASS**；`vite build` 0；`./scripts/verify.ps1` exit 0。

### 20.3 遗留与边界

- **真实链路未接**：后端 `--realtime` 仍是占位、命令状态查询端点未提供；CE-06 的真实生产证据需后端就绪。
- **产品装配未接线**：`RuntimeProvider` 未被 AppProviders 使用；多 FAB 目前是 runtime/测试能力，产品 UI 仍单 FAB；M5 按后端能力接线。
- XState 工作流位于 `runtime/commands`，经 `CommandWorkflow` 契约暴露；升级实现需重跑契约/集成测试。
- **UI 只读投影**：adapter 的 state/context getter 仅供 runtime/测试；页面如何只读展示工作流状态仍是 M5/OPEN-V21-13。
- M5–M6 未开始；性能门禁仍为 SPECIFIED / NOT RUN。
## 21. M5a 落地记录：XState v6 正式产品接线 + 多 FAB UI + 只读投影（2026-10-27）

> 本轮把 XState v6/FabRuntime 从测试模块变成产品运行时的一部分；后端真实命令流仍缺，命令源保持可替换 seam。

### 21.1 交付

- **产品 Runtime 装配**：`app/providers/RuntimeBootstrap.tsx` 在 AppProviders 内按 sites 文档为每个 FAB 创建 `FabRuntime`，通过 `FabLifecycleCoordinator` 启停；`RuntimeProvider` 暴露 registry；XState v6 进入产品 bundle 与生命周期。
- **可替换命令源**：`runtime/commandSources.ts` 的 `createPendingCommandEventSource()` 返回空 Observable；后端 SSE/WebSocket 命令端点就绪后只需替换该工厂（`CommandEventSource` 契约不变）。
- **多 FAB 数据驱动 UI**：Workbench 在 `site.fabs.length > 1` 时显示 FAB 选择器，3D 链接指向所选 FAB；后端当前单 FAB 时无可见变化，但代码路径已按多 FAB 数据工作；RuntimeBootstrap 同时为所有 FAB 装配 runtime。
- **工作流只读投影**：新增 `CommandWorkflowProjection` 契约、XState adapter projection getter、`FabRuntime.getProjection/subscribe`、`useCommandProjection(fabId, commandId)` hook；UI 只读订阅，不暴露 actor/send。
- 测试：`runtime-bootstrap.test.tsx`（3 FAB 装配、StrictMode 卸载清理、Workbench 选择器）、`fab-runtime.test.ts` 增加投影/订阅；全量 65 文件 / 294 测试。

### 21.2 证据

- `tsc --noEmit` 0；`npx vitest run` 65 文件 / 294 测试 PASS；`vite build` 0；`./scripts/verify.ps1` exit 0。
- `AppProviders` 现在必然引入 RuntimeBootstrap → FabRuntimeFactory → XState adapter；生产构建包含 XState（非 tree-shaken）。

### 21.3 遗留（M5b/M6）

- **真实命令链路仍未接**：命令源为空；Workbench/页面尚无命令提交 UI；CE-06 生产证据需后端命令流/状态端点。
- **M5b**：Worker/TypedArray 高频路径、`rendering`/`features` 目录迁移、ARCH-11 检查与性能门禁。
- 多 FAB 产品数据当前只有 1 个 FAB（UI 数据驱动但未实际显示多个）；产品范围仍按后端能力。
## 22. M5b 落地记录：rendering 目录归位、TypedArray/Worker 高频路径与性能基线（2026-10-27）

> 本轮完成目录归位与高频路径的基础设施/CPU 基线；真实遥测源、Worker 与渲染器接线、GPU/浏览器性能门禁仍未完成（OPEN-V21-14 等）。

### 22.1 交付

- **目录归位**：`web_app/src/render/` → `web_app/src/rendering/`（git mv，所有 src/tests/tools 导入同步）；旧 `src/render/` 不存在，架构检查新增 M5b 断言。
- **TypedArray 高频缓冲**：`realtime/buffers/FrameRingBuffer.ts`（固定容量 Float32Array 环形缓冲、单调 sequence、latest/按序列读取、drop 统计）。
- **Worker 路径**：`realtime/workers/telemetryWorker.logic.ts`（纯 handler，输入校验 + FrameRingBuffer，不依赖 React/Query/Zustand/XState）、`telemetryWorker.ts` Worker 入口（M5c 已接模拟后端遥测并接入渲染，见 §26）。
- **ARCH-11 静态检查**：`architecture-boundaries.test.ts` 断言 realtime/buffers、realtime/workers、rendering 不 import React/TanStack Query/Zustand/XState/application 状态层。
- **性能基线**：`tests/performance/telemetry-frame-buffer.test.ts` 记录桌面 CPU 写路径基线（本次 100k frames × 8 floats ≈ 1.8 ms，约 56M frames/s）并设 5s 回归上限；不是 GPU/WebGPU 性能证据。

### 22.2 证据

- `tsc --noEmit` 0；`npx vitest run` **67 文件 / 300 测试 PASS**；`vite build` 0；`./scripts/verify.ps1` exit 0。
- 现有 Lite 单元/浏览器验收测试全部保持通过（目录迁移未改行为）。

### 22.3 遗留

- **真实高频链路未接**：Worker 入口未被产品引用；遥测源/SharedArrayBuffer/COOP-COEP 策略（OPEN-V21-14）与渲染器消费 TypedArray 的接线未做。
- **GPU/浏览器性能门禁**：M5b 时只有 CPU 缓冲基线；M5c 已补真实 Chrome/WebGPU 门禁（§26）。
- `features` 目录与页面级 feature 归位尚未做（M5 范围剩余部分）；真实后端实时命令流仍缺。
## 23. M6 落地记录：收口与退役（2026-10-27）

> M6 删除旧迁移/parity 文档、证据、chromium/frozen 测试与工具，保留产品运行所需资产、i18n 生成物、原版署名与当前渲染回归 fixture；`./scripts/verify.ps1` 已重跑通过。

### 23.1 删除

- `docs/migration/`（283 文件，约 51 MB：twin-parity/babylon-lite 证据与计划）、`docs/repair/`、`docs/superpowers/plans/`、根目录旧 parity spec（.md/.docx）、Babylon Lite 迁移指南。
- 旧 parity/frozen/browser 测试与配置：`tests/*.browser.ts`、`tests/frozen-visual.test.ts`、`tests/frozen-preview.vite.config.ts`、`tests/lite-*-runtime/effects-color` 浏览器夹具、`tests/renderer-acceptance.test.ts`、`tests/original-*.test.ts`。
- 旧 parity 工具：`frozen_visual_compare.mjs`、`compare_twin_goldens.py`、`serve_twin_reference.py`、`run_twin_browser.mjs`、`audit_twin_i18n_coverage.mjs`、旧 vector builders 等。
- `scripts/verify.ps1` 的 frozen-original 向量门禁与其 coverage 资产；`web_app/assets/twin-i18n-coverage.json`。

### 23.2 保留与归位

- 产品运行资产：`assets/original-twin-hud.css`、`original-twin-ui.json`、`original-twin-i18n.json`、`lite-static-structure.json`、`legacy-LICENSE.txt`；生成物统一在 `web_app/src/generated/`（`twin-translations.generated.ts`、`static-structure-packed.ts`、`contracts.generated.ts`）。
- 法律署名：`docs/attribution.md`（原版 PolyForm 来源）；相关源文件注释已改为指向该文件。
- 当前渲染回归所需 fixture：`web_app/tests/fixtures/*`；`twin-source-manifest.json`、`twin-layout-identities.json` 从旧迁移目录迁入 tests/fixtures 并由测试直接引用。
- 工具：`generate_contracts.py`、`check_architecture.py`、`migrate_legacy_data.py` 及其测试；`build_twin_translations.cjs` 仅保留用于产品 i18n 生成。

### 23.3 可执行检查

- `tools/check_architecture.py` 新增 V2.1 终态检查：旧路径（`docs/migration`、`docs/repair`、`docs/superpowers`、`src/render`、`src/store`）不存在；旧依赖（react-redux/RTK/immer/@babylonjs/core）不存在；rendering/buffers/workers 不 import 状态容器。**M6 后续移除了 XState 目录强制检查**。
- `scripts/verify.ps1` 现在 = 契约检查 + 架构检查 + Python 工具测试 + 数据导入检查 + 3 个 .NET 项目构建/测试 + 前端 install --frozen-lockfile/typecheck/test/build。

### 23.4 证据

- `./scripts/verify.ps1` exit 0；`tsc --noEmit` 0；Vitest **60 文件 / 265 测试 PASS**；`vite build` 0；.NET 67/67；8 个 Python 工具测试；契约/架构检查 PASS。
- 仍存在的边界：真实 WebSocket 生产传输、SharedArrayBuffer/COOP-COEP、非模拟后端；见 §24/§26。
## 24. 最终已知边界（M6 后）

- **后端传输**：`fab_app -- --realtime`（WebSocket）仍是占位；HTTP 命令 API + 命令 SSE、FAB 级遥测/设备状态 SSE 已实现并接入产品。WebSocket 生产传输可后续替换同契约。
- **后端持久化**：命令/遥测状态仍为内存模拟（命令终态 TTL/容量已限制）；PostgreSQL/Outbox/生产身份未实现，缺少数据库与身份基础设施。
- **Worker/遥测接线**：FAB 级 20Hz 遥测 SSE → selected FAB 的 TelemetryRuntime/Worker → FrameRingBuffer → 渲染 frame loop；Worker 按需启动（3D 页面 1 个，Workbench 0 个）；SharedArrayBuffer/COOP-COEP 未启用。
- **GPU/浏览器性能门禁**：Chrome 155 headless WebGPU 持续门禁通过（600 采集帧，p95 8.5ms，116.5fps，rendererFrames 631，drawCalls 903，1 个按需 Worker，heap 65.59MB，gpuErrors []）；生产设备矩阵/显存/长任务仍待扩展。
- **目录收口**：`rendering/lite`、页面级 `features/{twin,catalog,workbench}`、共享 `components/` 已归位；纯领域模块在 `domain/{fab,amhs,personnel,wafer,simulation,contracts,equipment}`，生成物在 `generated/`；旧顶层页面文件已删除。P2 清理记录见 §29。
- **XState**：实现位于 `runtime/commands`，经 `CommandWorkflow` 契约暴露；位置不强制，升级实现需重跑 workflow/contract 测试。
- **历史保留**：旧代码与旧迁移证据已从工作树删除，但保留在 Git 历史中；仓库只有一个 `main` 分支，无旧 URL 重定向。
## 25. M6 后续调整：保留 CommandWorkflow 契约，取消 XState 目录强制（2026-10-27）

> 决定：保留“实现隐藏在 `CommandWorkflow` 契约之后”，但不再强制 XState 必须位于 `runtime/commands`（原为 `workflows/equipment`）。目录位置属于组织选择，不是架构约束。

### 25.1 变更

- 实现文件从 `workflows/equipment/` 移到 `runtime/commands/`：`equipmentCommand.machine.ts`、`equipmentCommand.logic.ts`、`CommandReconciler.ts`、`XStateCommandWorkflowAdapter.ts`；删除空的 `src/workflows/`。
- `FabRuntime` 改为从 `./commands` 装配；`CommandWorkflow` 契约、Bridge、恢复队列、FabRuntime 的契约边界不变。
- 移除 ARCH-08 的目录强制：`tests/architecture-boundaries.test.ts` 删除“XState 只能在 `workflows/`”“工作流实现只能被 runtime 导入”两条断言；`tools/check_architecture.py` 删除 xstate/workflow 路径检查。
- 保留的边界：`realtime`/`application` 不 import 工作流实现或 XState；`CommandWorkflow` 契约单点定义；`rendering`/`buffers`/`workers` 不 import 状态容器。

### 25.2 理由

- XState 只是当前工作流实现，不是架构层；把它钉在特定目录对功能没有收益，反而增加搬迁成本。
- 契约边界已经能保证页面/实时层不依赖 actor；目录规则属于过度约束。

### 25.3 验证

- `tsc --noEmit` 0；Vitest **60 文件 / 265 测试 PASS**（架构测试由 7 条减为 5 条）；`vite build` 0；契约/架构检查 PASS。
## 26. M5c/后续落地：features 归位 + 模拟后端真实链路 + Worker 渲染接线 + GPU 门禁（2026-10-27）

> 本轮把用户列出的三个剩余项处理完：页面 features 目录迁移、后端命令/遥测链路（用后端模拟实现）、Worker/遥测渲染接线与真实浏览器 GPU 性能门禁。

### 26.1 features/components 归位

- 页面模块迁入 `features/twin/`（twin-page、sidebar、dialogs、elevation、inspector、i18n、fab-viewer）、`features/catalog/`（catalog-page/data）、`features/workbench/`（workbench + command-console）；共享 UI 迁入 `components/`（ui/widgets/charting/error-boundary）。
- 旧顶层页面文件删除；所有相对 import（含 asset URL 由脚本解析）重算；`tests/architecture-boundaries.test.ts` 增加 M5c 归位断言。

### 26.2 后端模拟命令/遥测链路

- 后端新增 `EquipmentCommandService`、`TelemetrySimulationService` 与 4 个 `/api/v1` 端点：POST 命令、GET 命令权威状态、命令 SSE、20Hz 遥测 SSE；命令 202 accepted → 150ms executing → 600ms succeeded。
- 前端新增 `SseCommandEventSource`（复用 MessageDecoder envelope）、`HttpCommandGateway`、`submitEquipmentCommand`、`RuntimeBootstrap` 的 SSE/gateway 接线，以及 Workbench `CommandConsole`；提交后 `trackCommand`，SSE 推进 XState 工作流，面板通过 `useCommandProjection` 只读展示。
- 浏览器 e2e（Chrome headless，真实 API/SSE）：命令面板从 disabled 到可提交，点击后观察到 accepted → executing → succeeded。
- 后端测试：**73/73 PASS**（67 既有 + 6 新增）；构建 3 个项目 Release 0 警告。

### 26.3 Worker 遥测与渲染接线

- `TelemetryRuntime`：浏览器 EventSource 接收 20Hz `telemetry.frame` → MessageDecoder → 16 样本 × 2 值压成 32 float → module Worker `telemetryWorker` → FrameRingBuffer → Worker 回传 latest；渲染帧循环通过 `getToolStates()` 读取，不触发 React/Query/Zustand/XState 更新。
- 浏览器证据：页面存在 dedicated worker target，加载 `telemetryWorker.ts?worker_file&type=module`；后端日志显示遥测 SSE 连接。

### 26.4 真实 GPU/浏览器性能门禁

- 新增 `tools/render_perf.mjs` + `scripts/perf-render.ps1`：启动 headless Chrome（localhost、`--enable-unsafe-webgpu --use-angle=d3d11`），验证 `navigator.gpu`/adapter/canvas，并在真实 3D 路由采集 rAF 帧。
- 本次运行：Chrome 155，`http://127.0.0.1:5173/fabs/{fabId}/3d`，180 采集帧去除 30 warmup 后 **179 frames，avg 8.61ms、p95 8.5ms、avg 116.1fps、canvas 754×424、WebGPU adapter=true**；证据 `.local/render-perf.json`。
- 该门禁需本机 GPU/Chrome，不放进 `scripts/verify.ps1`；命令：先 `./scripts/start-dev.ps1`，再 `./scripts/perf-render.ps1 -Url http://127.0.0.1:5173/fabs/{fabId}/3d`。

### 26.5 验证

- 前端 `tsc --noEmit` 0；Vitest **61 文件 / 271 测试 PASS**；`vite build` 0。
- 后端 73/73；契约/架构检查 PASS；`./scripts/verify.ps1` exit 0（最终状态在提交前复跑）。

### 26.6 剩余边界

- WebSocket 生产传输/非模拟后端仍未接；HTTP/SSE 模拟链路满足当前产品集成。
- SharedArrayBuffer/COOP-COEP（OPEN-V21-14）未启用；Worker 使用 postMessage。
- GPU 门禁为单机 headless Chrome 基线，不是生产设备矩阵/显存/长任务门禁。
## 27. Review 修复落地记录：多 FAB、SSE 恢复、命令保留、能力模型与压力门禁（2026-10-27）

> 实现用户 review 的 P0/P1/P2 项；按批提交。PostgreSQL/Outbox/生产身份因本仓库没有数据库与身份基础设施，明确保留为边界，不用内存实现冒充。

### 27.1 P0 多 FAB 与作用域

- 后端 `SiteDirectory` 支持 1..32 FAB，默认 dev catalog 为 FAB-01/02/03；FAB-01 Guid 保持 `37793fb6-5679-b7a3-3fef-d970433697c1`，FAB-02/03 确定性派生。`Fab:FabCount` 可配置；Scenario 接受非空子集，拒绝重复/跨 Site/未知 FAB。
- FAB 级设备状态：`GET /api/v1/sites/{siteId}/fabs/{fabId}/equipment-status` 与 `/stream`，每 FAB 121 工具、独立序列；未知/不归属 FAB → 404。
- FAB 级遥测：`GET /api/v1/sites/{siteId}/fabs/{fabId}/telemetry/stream`，20Hz，payload `fabId` 为请求 FAB；旧 site 级遥测删除。
- 前端：`FabTelemetryRegistry` + `useFabTelemetry(fabId)`；RuntimeBootstrap 每 FAB 一个 TelemetryRuntime；Twin 按选中 FAB 读取遥测/设备状态；Workbench 三 FAB 卡片/选择器，Run 提交包含所有 site FAB。
- 浏览器 e2e：`/api/v1/sites` 返回 3 FAB；Workbench 命令面板可提交；3D 路由按需启动选中 FAB 的 1 个 Worker；点击 3D FAB 与直接粘贴 URL 均可加载；命令 accepted→executing→succeeded。

### 27.2 P1 SSE 恢复与命令保留

- 命令 SSE 每帧 `id: {epoch}:{sequence}`，支持 `Last-Event-ID`：有效游标从下一条继续、无缺口；epoch 变化/游标早于保留窗口发 `event: replay-gap` + JSON 后重放。
- 前端 `CommandEventSource.gaps$` 解析 replay-gap；FabRuntime 订阅 gap/reconnect，合并触发权威 `reconcileAll`/`reconcileTracked`，dispose 安全；trackCommand 在缺少本地证据时通过 gateway 收敛。
- 后端保留：终态 TTL 5min、MaxTerminalCommands 512、Journal 4096/site、幂等 4096；`PruneTerminalCommands()` 可确定性测试；被清理命令 GET 404。前端 FabRuntime 终态 workflow TTL/上限 + 投影保留，correlation 终态水印清理。
- 命令幂等/能力/授权：Idempotency-Key 必填，同 key+payload 重放同 commandId，异 payload 409，并发单命令；设备能力 catalog 支持每 FAB 配置 actions/preconditions；`IFabAuthorization` seam。

### 27.3 P2 能力模型与压力门禁

- 设备能力目录：`Fab:EquipmentCapabilities` 配置每 FAB equipment actions/preconditions，启动 fail-fast；默认 fallback equipment-0..120 + START/STOP/PAUSE 保持前端兼容；无效/未授权命令 400/404。
- CPU/Worker 负载：`tests/performance/telemetry-load.test.ts` 压测 500/2000/5000 entities at 60Hz（300 frames）：约 18.6ms/60ms/141ms，heap delta < 256MB；覆盖 Worker handler + FrameRingBuffer 路径。
- 真实 GPU：`tools/render_perf.mjs` 增加 `perf=1` 诊断桥，要求真实 renderer frames/drawCalls 且 gpuErrors 为空；最新持续运行 600 帧，p95 8.5ms，116.5fps，rendererFrames 631，drawCalls 903，1 个按需 Worker，gpuErrors []。

### 27.4 验证

- 前端：tsc 0、Vitest **69 文件 / 315 测试 PASS**、vite build 0。
- 后端：**139/139 PASS**（85 + 54 新增/调整）。
- `./scripts/verify.ps1` exit 0；只有 main 分支，工作树干净后提交推送。

### 27.5 保留边界（基础设施缺失）

- PostgreSQL 命令历史/Outbox/事务发布未实现：仓库没有数据库依赖/服务；当前内存存储 + 终态保留只满足开发阶段。
- 生产身份/正式 FAB 权限体系未实现：`DevelopmentFabAuthorization` 只覆盖开发密钥；生产必须接正式 IdP/策略/审计。
- 真实 WebSocket 生产传输、SharedArrayBuffer/COOP-COEP、生产设备矩阵/长时 WebGPU 压力仍为后续项。
## 28. 复核报告剩余 P1/P2 修复记录（2026-10-27）

> 针对复核报告中的 3 个 P1 与 2 个 P2 项逐条修复；GitHub Actions 按要求不处理。

### 28.1 P1 修复

- **幂等重放先于前置条件**：`EquipmentCommandService.Submit` 变为单一临界区路径：site/FAB/principal/key/payload 校验后先查幂等记录；相同 payload 直接重放原 accepted 快照（同 commandId、202、不再跑当前能力/状态校验），不同 payload 409，仅新命令才运行 validator。测试覆盖“第一次 STOP 在 running 通过 → 状态变 idle → 同 key 重放仍 202 同 id，新 key 400”。
- **命令 SSE FAB 级授权**：`GET /sites/{siteId}/commands/stream?fabId=` 必填；缺失/非法 400，未知/无权限 404（无存在性泄漏）；服务端按 payload.fabId 过滤 journal，客户端过滤不再承担访问控制。FAB 级 equipment-status(+stream)/telemetry 同样接 `IFabAuthorization`。前端每个 FAB 使用自己的 `?fabId=` 流。
- **在线 Journal 缺口检测**：`ReadJournal`/`ReadJournalSince` 共享游标合法性检查，覆盖 malformed/foreign epoch、游标早于保留窗口、游标超前/日志尚不存在；SSE 发现缺口时先发一次 `replay-gap` 再重放保留事件，不再静默跳过。

### 28.2 P2 修复

- **稳定设备身份**：`TelemetryRuntime` 按 `entityId`（equipment-<index>）映射渲染槽位，不依赖 sample 数组顺序；乱序/未知/重复实体有明确策略；后续帧缺失实体保留上一状态而非回落 running。设备状态与 telemetry 后端共用同一 EquipmentStatusService 快照（状态映射 0..3）。
- **真实浏览器持续压力**：新增 `web_app/tests/telemetry-stress.html` + `tools/telemetry_stress.mjs`，使用真实 `createTelemetryWorker()` Worker 在 500/2000/5000 实体、60Hz、5s 下测量跨线程往返：收发比例 100%，p95 分别约 0.6/1.1/2.0ms；CPU/Heap 微基准保留。`render_perf.mjs` 持续 600 帧并报告 workerTargets/heap/taskDuration，实测 1 个按需 Worker、p95 8.5ms、116.5fps、gpuErrors []。
- **HTTP/1.1 连接上限修复**：命令 SSE 改为“首次 trackCommand 才打开”（lazyCommandSubscription）；telemetry 也改为按消费者启动（`useFabTelemetry`），Workbench 不打开任何遥测流，3D 页面只启动选中 FAB 的 1 个 Worker/SSE + 1 个设备状态流。之前从 Workbench 点击 3D FAB 会卡在“准备 WebGPU 视图”，根因是 Workbench 常驻 3 条 telemetry SSE 占用浏览器 per-origin 6 连接预算，Babylon Lite 动态模块排队；修复后点击链接与直接粘贴 URL 均实测正常加载。

### 28.3 复核后验证

- 前端 `tsc --noEmit` 0；Vitest **69 文件 / 315 测试 PASS**；`vite build` 0。
- 后端 **139/139 PASS**（含 journal/retention/capability/authorization）。
- 浏览器 e2e：3 FAB Workbench 命令面板提交 → accepted→executing→succeeded；3D 页面按需 1 个 Worker。
- `./scripts/verify.ps1` exit 0。

### 28.4 仍未实现（基础设施边界）

- PostgreSQL/Outbox/正式 IdP：仓库无数据库/身份基础设施；当前为内存 + 终态保留 + 开发授权 seam。
- 生产 WebSocket、SharedArrayBuffer/COOP-COEP、生产设备矩阵/长时 GPU 压测。
## 29. P2 架构清理落地记录（2026-10-28）

> 目标：消除 V2.1 遗留的反向依赖与类型逃逸，把领域层、生成物与遥测投影整理成可执行门禁；产品行为不变。

### 29.1 纯领域模块归位

- 18 个纯领域模块移入 `web_app/src/domain/{fab,amhs,personnel,wafer,simulation}/`：`fab-layout`、`process-control`、`fab-yield`、`cleanroom-pressure`、`layout-identities`、`original-twin-data`、`twin-spatial`、`amhs-timeline`、`personnel-timeline`、`wafer-route`、`wafer-map`、`wafer-scenario`、`tour-wafer-timeline`、`research-replay`、`original-tour`、`tour-scenario`、`twin-equipment`、`scenario`；新增 `domain/contracts/language.ts` 供共享类型，`original-twin-data` 不再反向依赖 `features/twin`。
- 遥测帧→设备状态投影从 `realtime/telemetry/TelemetryRuntime.ts` 拆到纯函数 `domain/equipment/tool-state-projection.ts`；transport 只保留解码/帧/缓冲/背压，`FabTelemetryRegistry` 增加 acquire/release 引用计数（首个消费者启动、最后一个释放停止）。
- 生成物统一到 `web_app/src/generated/`：`contracts.generated.ts`、`twin-translations.generated.ts`、`static-structure-packed.ts`；`tools/generate_contracts.py`、`tools/build_twin_translations.cjs`、`tools/pack_static_structure.mjs` 输出路径同步。

### 29.2 依赖方向与状态

- Router→Catalog 反向依赖移除：通用 `app/router/search.ts` 只保留 search schema/通用 helper；catalog 转换在 `features/catalog/search.ts`，Twin 转换在 `features/twin/twin-search.ts`；`app/router/` 直接文件不再 import `features/**`（`app/router/routes/**` 是装配入口，允许 import 页面）。
- `state/createSliceStore.ts` 改为类型安全工厂：reducer 参数列表推导到 action creators，无 `any`/手写 action 接口断言；7 个 store 继续只保存客户端 UI 状态。
- Twin 页拆为 `features/twin/controllers/*`（路由状态/播放/场景同步/键盘/研究回放等）+ `equipment-status-pipeline.tsx`；跨 store 的 wafer 关闭改走 `features/twin/wafer-session.ts`，store 之间不再直接 `setState` 互写。

### 29.3 可执行门禁

- 新增 `web_app/tests/architecture-import-graph.test.ts`：用项目自带 TypeScript Compiler API（TS 7 原生编译器 API `typescript/unstable/sync` + `typescript/unstable/ast`，不新增依赖）解析 `src/**/*.{ts,tsx}` 的静态 import、`export ... from` 与动态 `import()`，自行解析相对说明符（含 `.ts/.tsx/index.ts`），执行：
  - **R0** 所有相对 import 可解析（否则解析失败会静默绕过后续规则）；**R0b** tsconfig 不得使用 `paths`/`baseUrl` 别名（若引入，门禁必须先扩展解析，防止别名边静默漏检）；
  - **R1** 运行时模块图无环（type-only 边在 emit 时擦除，生成物的消费契约由 R5 单独固定）；
  - **R2** `app/router/` 直接文件（通用 router 工具）不得 import `features/**`；
  - **R3** `domain/**` 纯度：无 npm 包，只允许 `domain/**` / contracts / `web_app/assets` 数据；
  - **R4** `features/{catalog,twin,workbench}` 互不依赖；确需跨 Feature 时必须登记到 `APPROVED_CROSS_FEATURE_IMPORTS` 显式批准表（当前为空）；
  - **R5** 生成物登记表 + do-not-edit 头 + 数据化（`static-structure-packed.ts` 只允许一条 type-only 消费者契约 import）；
  - **R6** `src/` 根目录仅允许 `main.tsx`（入口）与 `contracts.ts`（公共契约 re-export），其余模块必须归属具体分层目录。
  失败信息固定包含 rule id、相对文件路径与 specifier/解析目标。`tests/architecture-boundaries.test.ts` 的正则规则保留，二者互补。
- `tools/check_architecture.py` 同步新布局：`web_app/src/domain/{fab,amhs,personnel,wafer,simulation,contracts}` 必须存在、18 个旧根模块必须不存在、`web_app/src/generated/` 三件生成物存在且带 do-not-edit 头、旧生成路径不存在。

### 29.4 验证

- `tsc --noEmit` 0；Vitest **90 文件 / 532 测试 PASS**（含新门禁 8 测试；默认并发全量 PASS，CPU 密集黄金向量套件统一 `testTimeout: 15s`）；`python tools/check_architecture.py` PASS。

### 29.5 独立验证与生命周期审计（2026-10-28）

- **类型负向契约：** `web_app/tests/types/store-action-types.ts` 由 `tsc --noEmit` 校验：未知字段、缺参、错误 value 类型、缺必填嵌套字段必须编译失败；`@ts-expect-error` 未命中即触发 TS2578，证明类型系统同时拒绝非法调用。
- **资源租约语义：** `tests/fab-telemetry-registry.test.ts` 覆盖双消费者共享、重复释放幂等、Runtime 替换后的旧租约隔离、`disposeAll` 后迟到的释放、以及 StrictMode 的 acquire→release→acquire 循环；`tests/telemetry-runtime.test.ts` 覆盖 `stop()` 后 Worker terminate、回调解绑与在途工作清理。
- **控制器生命周期审计：** 原 `twin-page.tsx` 的 26 个 effect 拆为 controllers 20 + page 1 + equipment-status-pipeline 5（总数不变，1:1 迁移）；10 个 controller 之间零相互 import；仅 `use-tour-controller` 保留 1 个挂载期 HUD seed state，RAF 只写 ref 与场景句柄，无每帧 `setState`。
- **差分正确性审计：** 39 个移动项相对 HEAD 审计：35 个纯迁移仅相对 import 路径变化、0 内容差异；4 个 store 文件为“迁移 + 已复核的类型安全/协调语义变更”（twinUiStore/twinPageStore/catalogStore/workbenchStore）；35 个修改源文件中 10 个属于已知语义变更、0 个意外语义漂移；Twin 页面 DOM 契约 42/42 个 id、class/aria 无缺失；`twinUiActions.waferClose` 的调用点仅剩协调入口与一个断言测试。
- **真实浏览器回归（E3，条件性）：** Chrome/155.0.8059.86 headless + localhost secure context；dev profile 240 帧 p95 **16.8–20.3ms**（冻结预算 ≤100ms，通过）、rendererFrames 271、drawCalls **905**、gpuErrors `[]`；FAB-02 直接进入 120 帧通过。60hz profile 在本机 headless 绑定 Intel Iris Xe 适配器状态下 600 帧 p95 **20.3ms** / p99 **≈90ms**，未达冻结预算；以 `HEAD a61e565` 为对照的同环境 A/B 同为 p95 **20.3ms**，证明不是本次清理引入的回退（同日更早的离散 GPU 状态实测为 p95 8.5ms / p99 8.7ms / 117.8fps）。证据与 A/B 原始数据见 `docs/evidence/architecture-cleanup-2026-10-28.json`。
- **生成物一致性：** `pack_static_structure.mjs --check`、`build_twin_translations.cjs --check`、`generate_contracts.py` 全部 exit 0；`docs/standards/SFN-WEB-REVIEW-STD-001.md` 收录评审规范 v1.0。
- **原始证据：** `docs/evidence/architecture-cleanup-2026-10-28.json`（含环境、命令、exit code、测试逐项耗时索引与浏览器 gate 原始数据路径）。

### 29.6 目录整洁收尾（2026-10-28）

- **根目录只留装配入口**：`src/main.tsx`（入口）与 `src/contracts.ts`（公共契约 re-export）；新增 **R6** 门禁（真实 import 图测试 + `tools/check_architecture.py` 双重断言），防止 root 再次堆积模块。
- **功能状态归位**：`features/twin/state/{twinUiStore,twinPageStore,twinDemoStore,twin-state}.ts`、`features/catalog/state/catalogStore.ts`、`features/workbench/state/workbenchStore.ts`；共享状态保留 `state/{localeStore,runtimeStore,preferences}.ts`。
- **其余根模块归位**：`rendering/fab-scene.ts`、`rendering/lite-backend.ts`、`rendering/lite/{airflow-texture.ts,geometry/original-tool-parts.ts,geometry/original-exploded-link-data.ts}`、`components/{class-names.ts,original-icons.tsx}`、`realtime/equipment-status.ts`、`realtime/telemetry/telemetry-buffer.ts`、`application/coordination/ScopeGate.ts`、`features/twin/twin-translations.ts`。
- **验证**：相对 import 由脚本按新位置整体重写；39 个移动项迁移审计为 35 个纯迁移内容等价 + 4 个“迁移 + 已复核语义变更”，0 异常；`tsc --noEmit` 0、全量 Vitest **90 文件 / 532 测试**、`vite build` 0、`python tools/check_architecture.py` PASS、真实 Chrome dev/FAB-02 门禁通过（60hz 受当前 iGPU 适配器状态限制，A/B 与 HEAD 一致）。
## 附录 A. 关键术语

| 术语 | 含义 |
|---|---|
| Query Options | `api/queries` 中以 `queryOptions(...)` 定义的 key+queryFn+staleTime 等集合；loader 与组件共用 |
| `ensureQueryData` | 缓存有数据即返回；无数据才请求；不因过期强制网络请求 |
| `fetchQuery` | 显式取数并写缓存；遵循传入 options 的 `staleTime`，需强制网络时显式 `staleTime: 0`；用于“必须权威新数据”的导航 |
| intent 预加载 | hover/focus/touch 链接时提前执行目标路由 loader |
| 复合身份 | `(fabId, commandId)`；跨 FAB 隔离的基础 |
| revision | 同一命令内单调递增的版本号；去重与排序依据（不用 `occurredAt`） |
| CommandEventBridge | Application 协调层组件，负责订阅、过滤、关联、去重、调用工作流 |
| FabRuntime | 单 FAB 的实时源 + 桥 + 工作流注册表/实现的装配与生命周期容器 |
