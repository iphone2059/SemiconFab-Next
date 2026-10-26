# SemiconFab Next V2.1 架构基线

- 版本：V2.1（2026-10-27）
- 状态：**文档基线已采纳；代码迁移未开始**（Baseline adopted / implementation pending）
- 适用对象：`web_app` 前端架构。后端 `fab_app`/`fab_shared` 的项目与命名空间边界沿用 ADR-0001…ADR-0007
- 权威决策：[ADR-0009](adr/0009-tanstack-router-query-boundary.md)（Router/Query 边界）、[ADR-0010](adr/0010-command-event-bridge.md)（实时/命令/工作流边界）；本文档负责汇总、目录结构与迁移计划
- 当前实现事实：以 [ADR-0008](adr/0008-redux-toolkit-rtk-query.md)（Redux Toolkit + RTK Query）和 [实施状态](IMPLEMENTATION-STATUS.md) 为准。**V2.1 在代码层面尚未落地，本基线不改变现有构建、依赖与运行行为。**

> 本文档不是验收证据。文中 RQ-01..RQ-05、CE-01..CE-08 全部是 **SPECIFIED / NOT RUN**（已定义、未运行）；任何“已通过/已验证”的表述都必须指向真实测试记录，本基线不提供此类记录。

## 1. 基线与范围

### 1.1 本次基线交付

本次只交付架构文档：ADR-0009、ADR-0010、本基线、7 篇专项文档与 V2.1 实施状态指针（完整清单见 [文档地图](#13-文档地图)）。不新增依赖、不改 `web_app/vite.config.ts`、不删 Redux、不改任何源代码，也不做 git 提交。

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
        |        | realtime/workers  |          | realtime/    |   | workflows/equipment  |
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
| `api/queries/mutations/endpoints` | TanStack Query、`schemas`（Zod）、`domain`、`application/contracts` | `workflows`、`realtime` 传输实现 |
| `application/contracts` | 无（可依赖 RxJS 类型与领域类型；不依赖基础设施/工作流实现） | WebSocket、XState、React、Query |
| `application/coordination` | `application/contracts` | `workflows/equipment`、XState、React、Query |
| `realtime` | `application/contracts`、`shared`、`domain` | `workflows`、XState、React、Query |
| `workflows/equipment` | `application/contracts`、`workflows/contracts`、XState v6、`domain` | `realtime/transport`、`app`、`api` |
| `runtime` | `application/contracts`、`application/coordination`、`realtime`、`workflows/equipment`、`api/queries`（仅装配 QueryClient 引用） | 页面组件、UI 细节 |
| `state`（Zustand） | `shared`、`domain` | Query 结果副本、XState actor、引擎对象 |

## 4. 目标目录结构（`web_app/src`）

```text
web_app/
  src/
    app/
      providers/            AppProviders / QueryProvider / RuntimeProvider
      router/               router.tsx（QueryClient context + defaultPreloadStaleTime: 0）
        __root.tsx
        routeTree.gen.ts    文件式路由生成并提交
        routes/
          fabs/
          equipment/
          amhs/
          alarms/
    api/
      queries/              queryClient / queryKeys / equipment.queries / command.queries
      mutations/
      endpoints/
    application/
      contracts/            CommandEvents / CommandGateway / RealtimeGateway / CommandWorkflow
      coordination/         CommandEventBridge / CommandEventRecovery / CommandCorrelationRegistry
    realtime/
      transport/            WebSocketClient
      protocol/             MessageDecoder / SequenceTracker
      streams/              EventRouter / CommandResultStream / AlarmStream / TelemetryStream
      workers/
      buffers/
      synchronization/
    workflows/
      contracts/            XState 内部契约（不得复制公共 CommandWorkflow）
      equipment/            equipmentCommand.machine.ts / equipmentCommand.logic.ts /
                            CommandReconciler / XStateCommandWorkflowAdapter
    runtime/                FabRuntime / FabRuntimeFactory / FabRuntimeRegistry / FabLifecycleCoordinator
    state/                  Zustand（仅 UI 状态）
    domain/
    schemas/                Zod（HTTP 边界校验）
    rendering/              Babylon Lite / WebGPU 封装（当前实体位于 src/render/lite）
    features/
    components/
    shared/
  tests/
    integration/            router-query.test.tsx / command-event-bridge.test.ts
    contract/               command-workflow.test.ts / command-recovery.test.ts
    performance/
    (现有 *.test.ts / *.browser.ts 保持不动，迁移时按阶段归位)
  assets/  vite.config.ts  package.json  tsconfig.json
```

结构说明：

- **公共命令契约只放一次**：`application/contracts/CommandWorkflow.ts` 是权威定义；`workflows/contracts` 只放 XState 内部契约，不复制公共接口（G-03）。
- **路由文件位置**：`routes/fabs|equipment|amhs|alarms` 是 V2.1 目标分组；现有 `/`、`/catalog`、`/compare`、`/twin` 页面到这些分组的最终 URL 尚未决策（OPEN-V21-01），M1 只建骨架与重定向，不虚构产品路由。
- **测试位置**：按 ADR-0003 与 `tools/check_architecture.py`，测试不得放 `src`；V2.1 门禁统一落 `web_app/tests/integration`、`web_app/tests/contract`、`web_app/tests/performance`。
- **`state`/`domain`/`schemas`/`rendering`/`features`/`components`/`shared`** 是 V2.1 目标保留目录，当前仓库尚未全部建立（现状只有 `store`、`render/lite` 等）。文件搬迁属于 M2/M5 的实施工作，本基线不搬文件，也不把“未创建”描述成“已存在”。

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
5. `workflows/equipment/XStateCommandWorkflowAdapter` 把 `receive(event)` 映射到 `equipmentCommand.machine.ts` 的 actor 事件；`CommandReconciler` 处理缺口/缺失 actor/断线恢复。
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
| ARCH-06 | Realtime 不得 import Workflows/XState | ADR-0010 | 依赖检查（计划纳入 `tools/check_architecture.py`） | CE-01..08 |
| ARCH-07 | CommandEventBridge 位于 Application 协调层 | ADR-0010 | 目录/依赖评审 | CE-01..05 |
| ARCH-08 | XState 实现隐藏在公共 `CommandWorkflow` 契约之后 | ADR-0010 | 禁止 workflows 实现被非 runtime 层 import | CE-01、CE-08 |
| ARCH-09 | Runtime 是事件源、桥、工作流实现的唯一装配层 | ADR-0010 | 装配评审；页面禁止 new 桥/actor | CE-07、CE-08 |
| ARCH-10 | 命令结果按 FAB+command 复合身份关联、去重、恢复 | ADR-0010 | 契约测试 + 集成测试 | CE-02..CE-07 |
| ARCH-11 | 高频遥测不得经过 Query/Zustand/XState | ADR-0010 + Engineering 09/15 | 架构评审 + 性能测试；渲染路径禁止读状态容器 | 性能门禁（计划） |
| ARCH-12 | Babylon Lite 是唯一 3D 引擎，且只允许 WebGPU | ADR-0003/Engineering 09 + ADR-0010 高频路径 | `tools/check_architecture.py` 禁止 WebGL；渲染评审 | 渲染验收（现有） |

规则的可执行检查在 M1..M6 逐步补齐；在此之前由评审负责。**当前这些规则没有任何自动化通过证据。**

补充说明：ARCH-03 的 `defaultPreloadStaleTime: 0` 只是让 Router 不再否决 loader 重跑，是**必要但不充分**条件；Query 的 `staleTime`/`gcTime`、同源 Query Options、页面订阅、失效与显式 `fetchQuery` 共同决定数据新鲜度（见 [ADR-0009](adr/0009-tanstack-router-query-boundary.md) 第 3 节）。

## 7. 架构护栏（Constraints）

| ID | 护栏 | 说明 |
|---|---|---|
| G-01 | Vite server/build 参数冻结 | `web_app/vite.config.ts` 的 `server` 与 `build` 参数（端口 5173/strictPort/host、`/api` 代理、`build.rolldownOptions.manualChunks`）不得改变；允许新增路由生成插件，插件不得改变这些参数与产物结构；若插件不满足约束，路由退回 code-based 实现 |
| G-02 | 同一端点不得双缓存 | 迁移期 RTK Query 与 TanStack Query 不得同时缓存同一端点；按页面/端点在同一个 PR 内切换，旧缓存同 PR 删除 |
| G-03 | 公共契约单点定义 | 命令公共契约只在 `application/contracts` 定义一次；`workflows/contracts` 不得复制 |
| G-04 | 基础设施不得反向依赖业务工作流 | `realtime` 不得 import `workflows`/XState；依赖方向由契约层收口 |
| G-05 | 测试位置与证据诚实 | 测试只放 `web_app/tests`；未运行的测试只能标 SPECIFIED / NOT RUN，不得写“已通过” |

## 8. 与既有决策和外部规范的关系

### 8.1 ADR 状态

| ADR | 状态 | 与 V2.1 的关系 |
|---|---|---|
| [ADR-0001](adr/0001-flat-project-layout.md)…[ADR-0007](adr/0007-read-only-legacy-catalog.md) | 已采纳 | 保留。项目布局、单后端、只读目录等与前端 V2.1 不冲突 |
| [ADR-0008](adr/0008-redux-toolkit-rtk-query.md) | 已采纳，**当前实现** | V2.1 **部分取代**：RTK Query 的服务端缓存与 Redux slice 的页面状态仅在迁移落地后由 ADR-0009/0010 取代；渲染循环约束按 ARCH-11 收紧。迁移完成前 ADR-0008 仍是代码事实 |
| [ADR-0009](adr/0009-tanstack-router-query-boundary.md) | 已采纳，实施未开始 | Router/Query 边界、RQ 门禁 |
| [ADR-0010](adr/0010-command-event-bridge.md) | 已采纳，实施未开始 | 实时/命令/工作流/运行时边界、CE 门禁 |

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

| 维度 | 当前（2026-10-27 可核对事实） | V2.1 目标 | 落点/阶段 | 状态 |
|---|---|---|---|---|
| 路由 | `src/main.tsx` 自定义 pathname 分支（workbench/catalog/compare/twin），无路由库 | TanStack Router + 类型化 URL + intent 预加载 | M1 | 未开始 |
| HTTP 服务端缓存 | RTK Query（`store/api.ts`）8 个 query + 1 mutation | TanStack Query 唯一缓存；loader 复用 Query Options | M1/M2 | 未开始 |
| 客户端状态 | Redux Toolkit 7 个 slice；`store/store.ts` | Zustand/组件局部；不复制 Query 数据 | M2 | 未开始 |
| 实时推送 | 仅设备状态 SSE（`EventSource` -> 有序消费者 -> Redux） | WebSocket -> Decoder -> RxJS -> 类型化流 | M3 | 未开始 |
| 命令链路 | 无（无 WS、无命令桥、无 actor） | CommandEventBridge + CommandWorkflow + 恢复 | M3/M4 | 未开始 |
| XState | 未安装/未使用 | XState v6（隐藏在 `CommandWorkflow` 后） | M4 | 未开始 |
| FabRuntime | 无；单站点页面直接装配 | `FabRuntime` 等四件套，按 FAB 装配/销毁 | M4 | 未开始 |
| 多 FAB | 产品为单 FAB（121 台设备布局，`fab-layout.ts`） | 三 FAB 隔离：独立 actor、订阅、复合身份 | M4 | 未开始（依赖产品/后端） |
| 高频遥测 | 现有 `store/telemetry-buffer.ts` 100ms 合批后进 Redux | Worker/TypedArray -> Babylon Lite，不进 Query/Zustand/XState | M5 | 未开始 |
| 渲染 | Babylon Lite 1.36 已在 `src/render/lite`，WebGPU-only 校验已有 | 保留；渲染目录归位 `rendering` | M5 | 部分（引擎已就位） |
| 依赖 | 无 @tanstack/*、xstate、rxjs、zustand、zod | 按阶段引入并锁版本 | M1..M4 | 未开始 |
| 测试基建 | Vitest + SSR `renderToStaticMarkup`；无 jsdom/Testing Library；无 integration/contract/performance 套装 | RQ/CE 集成与契约测试；性能测试目录 | M1 起 | 未开始 |
| 架构检查 | `tools/check_architecture.py` 只查既有前端边界（TS/TSX、禁止 WebGL、单 web_app） | 增加 ARCH 依赖方向/双缓存/契约位置检查 | M6 | 未开始 |
| 文档 | ADR-0008 + 迁移文档；无 V2.1 基线 | 本基线 + ADR-0009/0010 + 7 篇专项 | M0（本次） | 文档已写，未合并 |

## 10. 分阶段迁移计划

> 阶段编号 M0..M6；每阶段结束必须有对应门禁证据才能进入下一阶段。当前 M0 只完成文档，M1..M6 均未开始。

| 阶段 | 主题 | 主要交付 | 退出条件（Exit criteria） | 依赖/阻塞 | 状态 |
|---|---|---|---|---|---|
| M0 | 架构基线文档 | 本文件、ADR-0009/0010、7 篇专项、实施状态指针 | 文档评审通过；ARCH/RQ/CE/目录/数据流可追踪 | 无 | 本次完成（未提交） |
| M1 | 路由与查询地基 | 依赖（Router/Query/Zod + 路由插件 + 测试环境）、`app/providers`、`app/router`、`api/queries`、现有页面的路由骨架与重定向 | typecheck/build/test 通过；RQ-01/RQ-05 首次运行；无双缓存；vite server/build 参数未变 | OPEN-V21-01/02/03 | 未开始 |
| M2 | 客户端状态与 RTK 退役 | Zustand store、逐端点迁移 Query、删除对应 RTK 端点/slice 服务端字段 | ARCH-02/05 检查通过；RQ-02/RQ-03/RQ-04 运行；无 RTK Query 残留端点（或清单明确） | M1；页面级切换计划 | 未开始 |
| M3 | 实时协议与命令桥 | `application/contracts`、`realtime/transport`、`realtime/protocol`、`realtime/streams`、`application/coordination`、假源集成测试 | CE-01..CE-05、CE-08 在假源上运行；ARCH-06/07 检查通过 | M1；后端流协议 OPEN-V21-06（真实链路） | 未开始 |
| M4 | XState 工作流与 FabRuntime | `workflows/equipment` 四文件、`runtime` 四件套、`RuntimeProvider`、三 FAB 隔离测试 | CE-06/CE-07 在测试源上运行；ARCH-08/09/10 检查通过；单 FAB 回归通过 | M3；OPEN-V21-07/08；多 FAB 产品范围 | 未开始 |
| M5 | 高频渲染管线与目录归位 | Worker/TypedArray 缓冲、Lite 渲染接入、`rendering`/`features` 等目录迁移、性能测试 | ARCH-11 检查通过；性能测试基线记录；无 WebGL；现有 Lite 验收不回退 | M1；现有 Twin/Lite 迁移工作完成 | 未开始 |
| M6 | 收口与退役 | 删除 Redux/RTK 依赖与 `store`、ADR-0008 标记 Superseded、架构检查更新、文档更新 | `pnpm verify` 实际通过并留有记录；ARCH-01..12 检查可执行；CE-06/CE-07 真实链路证据（若后端就绪） | M2/M4/M5；后端实时服务 | 未开始 |

**关键路径**：M1 -> M2 -> M3 -> M4 为主链；M5 可与 M3/M4 并行，但依赖现有 Twin/Lite 工作收尾。真实后端 WebSocket 是 CE-04/CE-06 的硬依赖，前端不得用假源证据替代生产链路验收。

## 11. 风险登记

| ID | 风险 | 影响 | 缓解 | 触发信号 |
|---|---|---|---|---|
| R-01 | 双栈期间残留两份缓存（RTK Query + Query） | 数据不一致、RQ 门禁失真 | G-02 按端点同 PR 切换；M2 结束前做“无 RTK 端点”静态清单 | 同一端点出现两套 hooks/请求 |
| R-02 | 路由插件改变 Vite build 行为 | 违反 G-01、产物/分包变化 | 插件仅生成路由树；对比 build 产物与 manualChunks；不满足则 code-based | build 产物/分包 diff |
| R-03 | 集成测试环境缺失（jsdom/Testing Library） | RQ/CE 无法执行，门禁长期 NOT RUN | M1 前置批准 devDependencies；先写环境 smoke test | RQ 测试无法启动 |
| R-04 | 后端实时/命令状态端点未提供 | CE-04/CE-06 无法真实闭环 | 假源只用于结构验证；后端契约列为 OPEN-V21-06/07 | 真实链路验收缺失 |
| R-05 | 多 FAB 产品范围未定 | FabRuntime 三 FAB 隔离只能测试床验证 | 以复合身份与假 FAB 源覆盖 CE-07；产品范围由 Lead 决策 | 需求变化 |
| R-06 | XState v6 版本/API 不稳定 | 工作流实现返工 | M4 前核实并锁版本；`CommandWorkflow` 隔离实现 | 依赖升级失败/行为差异 |
| R-07 | intent 预加载在 loader 误用 `fetchQuery` 时放大请求 | 性能与后端压力 | RQ-01/RQ-05 请求计数断言；loader 评审 | 预加载请求数异常 |
| R-08 | 迁移与正在进行的 Twin/Lite parity 工作冲突 | 返工、合并冲突 | M1/M5 排期避开 `docs/migration/twin-parity` 与 `docs/migration/progress.md` 的活跃改动；文件搬迁放 M5 | 合并冲突 |
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
| RQ-01 | hover 预加载后立即导航复用 Query 数据 | `web_app/tests/integration/router-query.test.tsx` | SPECIFIED / NOT RUN |
| RQ-02 | 预加载后过期导航遵循 Query 新鲜度 | 同上 | SPECIFIED / NOT RUN |
| RQ-03 | mutation 失效展示权威数据 | 同上 | SPECIFIED / NOT RUN |
| RQ-04 | FAB-A/FAB-B 相同设备 id 不串缓存 | 同上 | SPECIFIED / NOT RUN |
| RQ-05 | 重叠预加载/导航复用 in-flight 请求 | 同上 | SPECIFIED / NOT RUN |
| CE-01 | 正常派发（accepted/executing/succeeded） | `web_app/tests/integration/command-event-bridge.test.ts` | SPECIFIED / NOT RUN |
| CE-02 | 重复 revision 过滤 | 同上 | SPECIFIED / NOT RUN |
| CE-03 | 乱序事件不回退 | 同上 | SPECIFIED / NOT RUN |
| CE-04 | 确认先于 HTTP 响应仍关联 | 同上 | SPECIFIED / NOT RUN |
| CE-05 | actor 缺失时通过核对恢复 | 同上 | SPECIFIED / NOT RUN |
| CE-06 | 重连后通过后端权威查询收敛 | `web_app/tests/contract/command-workflow.test.ts`、`command-recovery.test.ts` | SPECIFIED / NOT RUN |
| CE-07 | 三 FAB 相同 commandId 隔离 | 同上 | SPECIFIED / NOT RUN |
| CE-08 | Runtime 关闭后取消订阅/停止 actor | `web_app/tests/integration/command-event-bridge.test.ts` | SPECIFIED / NOT RUN |
| 性能 | 渲染/高频路径帧预算与帧率 | `web_app/tests/performance` | SPECIFIED / NOT RUN |

### 12.3 当前测试基建事实

- 现有前端测试在 `web_app/tests`（扁平 `*.test.ts/tsx`），React 测试使用 `renderToStaticMarkup`，需要浏览器/GPU 的验收使用独立 Vite 配置。
- 未安装 jsdom/happy-dom、Testing Library、TanStack Router/Query、Zustand、XState、RxJS、Zod；因此 RQ/CE 测试当前**无法执行**，这是事实而非缺陷声明。
- 没有运行任何 V2.1 门禁；没有性能数据。

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
| OPEN-V21-01 | 现有页面到 `routes/fabs`、`routes/equipment`、`routes/amhs`、`routes/alarms` 的最终 URL、重定向与保留策略 | Lead，M1 前 |
| OPEN-V21-02 | TanStack Router/Query/路由插件版本锁定 | 实施者，M1 |
| OPEN-V21-03 | jsdom/happy-dom + Testing Library 测试环境引入 | Lead 批准，M1 |
| OPEN-V21-04 | 是否引入 `@/` 路径别名（当前 ADR-0003 相对导入） | Lead，M1 |
| OPEN-V21-05 | `useSuspenseQuery` 的渲染边界与错误/加载 UI | 实施者，M1 |
| OPEN-V21-06 | 后端实时流协议、序列/ACK/鉴权/maxHz | 后端/Lead，M3 |
| OPEN-V21-07 | 后端命令状态查询端点（权威恢复） | 后端/Lead，M3 |
| OPEN-V21-08 | XState v6 版本与 actor 粒度 | 实施者，M4 |
| OPEN-V21-09 | 前端恢复记录生命周期（内存 vs sessionStorage） | 实施者，M3 |
| OPEN-V21-10 | CommandGateway HTTP 提交契约 | 后端/前端，M3 |
| OPEN-V21-11 | FabRuntime 实例化时机（应用启动/路由进入）与页面卸载语义 | 实施者，M4 |
| OPEN-V21-12 | README/外部规范是否增加 V2.1 指针（README 与 Engineering v1.1 不在本次写范围） | Lead |
| OPEN-V21-13 | 工作流状态的只读暴露方式（Query 权威状态 + 提交态之外的展示投影） | 实施者，M4 |
| OPEN-V21-14 | 是否使用 SharedArrayBuffer（COOP/COEP 部署策略） | 实施者，M5 |
| OPEN-V21-15 | 告警/遥测 topic 命名与订阅范围（per FAB/run/LOD） | 后端/前端，M3 |
| OPEN-V21-16 | 解码 schema 单一来源（Zod 手写 vs 由契约生成） | 实施者，M3 |

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
