# SemiconFab Next V2.1 架构基线

- 版本：V2.1（2026-10-27）
- 状态：**基线已采纳；M1、M2（含 M2c）、M3（实时契约/类型化流/CommandEventBridge 假源）已落地并验证；M4–M6 未开始**（Baseline adopted / M1-M3 implemented / M4-M6 pending）
- 适用对象：`web_app` 前端架构。后端 `fab_app`/`fab_shared` 的项目与命名空间边界沿用 ADR-0001…ADR-0007
- 权威决策：[ADR-0009](adr/0009-tanstack-router-query-boundary.md)（Router/Query 边界）、[ADR-0010](adr/0010-command-event-bridge.md)（实时/命令/工作流边界）；本文档负责汇总、目录结构与迁移计划
- 当前实现事实：所有 HTTP 端点由 TanStack Query 独占；客户端 UI 状态由 5 个 Zustand store（twinUi/twinPage/twinDemo/catalog/workbench/runtime/locale 归属其中）独占；RTK Query、Redux Toolkit、react-redux 与 `src/store/` 已全部删除。XState 按用户指示锁定 6.0.0-alpha.70（无 stable v6），在 M4 接入工作流。详细证据见 [实施状态](IMPLEMENTATION-STATUS.md)、§15–§17。

> RQ-01..RQ-05、CE-01..CE-05、CE-08 均已真实运行（假源，见 §12.2）；CE-06/CE-07 与性能门禁仍为 **SPECIFIED / NOT RUN**（M4）。任何“已通过/已验证”的表述都必须指向真实测试记录。

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

- **公共命令契约只放一次**：`application/contracts/CommandWorkflow.ts` 是权威定义；`workflows/contracts` 只放 XState 内部契约，不复制公共接口（G-03）。
- **路由文件位置**：`routes/fabs|equipment|amhs|alarms` 是 V2.1 目标分组；最终 URL 已由 M1 定稿，M2 删除旧地址后不存在别名/重定向（OPEN-V21-01 已解决，见 §4.1）。
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

规则的可执行检查在 M1..M6 逐步补齐。M1 已为 ARCH-03（router 配置 + 断言测试）与 ARCH-04（loader 只调用 `queryOptions`）提供可复核代码/测试；ARCH-02 由 RQ-03/RQ-04 与“全部端点只有 Query 一处缓存”的代码事实覆盖；ARCH-05 由 M2b 的 store 清单/评审覆盖（Zustand 只含 UI 字段，无 Query DTO 副本）；ARCH-06/07 已由 `tests/architecture-boundaries.test.ts` 静态检查并通过（M3）；ARCH-08 由该测试的契约单点声明覆盖。其余规则在 M3–M6 补齐自动化检查前仍由评审负责。

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
| [ADR-0008](adr/0008-redux-toolkit-rtk-query.md) | **已被取代（M2）** | RTK Query 由 ADR-0009 取代（M2a）；Redux Toolkit/react-redux 由 V2.1 的 Zustand store 取代（M2b）。仅保留“Babylon 对象不入状态容器、遥测合批”等原则（ARCH-11） |
| [ADR-0009](adr/0009-tanstack-router-query-boundary.md) | 已采纳，M1+M2 已落地 | Router/Query 边界、全部 RQ 门禁已运行；Zustand 已在 M2b 接管客户端 UI |
| [ADR-0010](adr/0010-command-event-bridge.md) | 已采纳，M3 契约/桥接已落地 | 实时类型化流、CommandEventBridge、恢复队列、CE-01..05/08 已运行；XState/Runtime 留待 M4 |

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
| 路由 | TanStack Router 接管顶层路由/URL/search；生成式路由树 + 最终 URL（M1）；旧地址与重定向已删除（M2）；目录筛选、compare、Twin 的 siteId/modal/mode/lang/theme 已由 Router search 拥有（M2c） | TanStack Router + 类型化 URL + intent 预加载 | M1/M2 | **M1/M2 PASS** |
| HTTP 服务端缓存 | 全部端点已由 TanStack Query 独占（M2a）；RTK Query/api.ts 已删除，无双缓存 | TanStack Query 唯一缓存；loader 复用 Query Options | M1/M2 | **M2a PASS** |
| 客户端状态 | 5 个 Zustand store（twinUi/twinPage/twinDemo/catalog/workbench/runtime/locale 字段）承载 UI 状态；Redux/react-redux 已删除 | Zustand/组件局部；不复制 Query 数据 | M2b | **M2b PASS** |
| 实时推送 | 设备状态 SSE（产品链路）+ `realtime/protocol`/`streams` 的 WebSocket 解码/序列/类型化流契约（M3，假源测试）；真实 WebSocket 服务仍未接入 | WebSocket -> Decoder -> RxJS -> 类型化流 | M3 | **M3 PASS（契约/假源）；真实链路 M4+** |
| 命令链路 | `application/contracts` + `CommandEventBridge` + `CommandCorrelationRegistry` + `CommandEventRecovery` 已实现（假源测试）；XState 工作流与 Runtime 装配未开始 | CommandEventBridge + CommandWorkflow + 恢复 | M3/M4 | **M3 PASS（假源）；M4 接 XState/Runtime** |
| XState | 未安装/未使用 | XState v6（隐藏在 `CommandWorkflow` 后） | M4 | 未开始 |
| FabRuntime | 无；单站点页面直接装配 | `FabRuntime` 等四件套，按 FAB 装配/销毁 | M4 | 未开始 |
| 多 FAB | 产品为单 FAB（121 台设备布局，`fab-layout.ts`） | 三 FAB 隔离：独立 actor、订阅、复合身份 | M4 | 未开始（依赖产品/后端） |
| 高频遥测 | 现有 `state/telemetry-buffer.ts` 100ms 合批后进 Zustand（非逐帧框架状态） | Worker/TypedArray -> Babylon Lite，不进 Query/Zustand/XState | M5 | 过渡实现；M5 迁 Worker/TypedArray |
| 渲染 | Babylon Lite 1.36 已在 `src/render/lite`，WebGPU-only 校验已有 | 保留；渲染目录归位 `rendering` | M5 | 部分（引擎已就位） |
| 依赖 | TanStack Router 1.170.46 / Query 5.105.0 / Router plugin 1.168.48、Zustand 5.0.16、RxJS 7.8.2、Zod 4.6.7、XState 6.0.0-alpha.70（用户指示直接用 v6）；jsdom 30.1.3 + Testing Library（dev）；Redux/react-redux 已移除 | 按阶段引入并锁版本；XState v6 当前仅 alpha，M4 前评估升级但不回退 v5 | M1..M4 | M2b 已移除 Redux；v6 alpha 锁定 |
| 测试基建 | Vitest + jsdom + Testing Library；RQ-01..05、Zustand store、Router search 映射已真实运行 | RQ/CE 集成与契约测试；性能测试目录 | M1 起 | **M1/M2a/M2b/M2c PASS**；CE/性能未开始 |
| 架构检查 | `tools/check_architecture.py` 只查既有前端边界（TS/TSX、禁止 WebGL、单 web_app） | 增加 ARCH 依赖方向/双缓存/契约位置检查 | M6 | 未开始 |
| 文档 | V2.1 基线 + ADR-0009/0010 + 7 篇专项已合入 main（e18595f）；本文档补充 M1 证据 | 本基线 + ADR-0009/0010 + 7 篇专项 | M0 | **M0 PASS；M1 增量已更新** |

## 10. 分阶段迁移计划

> 阶段编号 M0..M6；每阶段结束必须有对应门禁证据才能进入下一阶段。当前 M0 只完成文档，M1..M6 均未开始。

| 阶段 | 主题 | 主要交付 | 退出条件（Exit criteria） | 依赖/阻塞 | 状态 |
|---|---|---|---|---|---|
| M0 | 架构基线文档 | 本文件、ADR-0009/0010、7 篇专项、实施状态指针 | 文档评审通过；ARCH/RQ/CE/目录/数据流可追踪 | 无 | **完成并推送（e18595f）** |
| M1 | 路由与查询地基 | 依赖、`app/providers`、`app/router`、`api/queries`、最终 URL（旧地址 M2 删除）、sites 端点迁移、RQ-01/RQ-05 集成测试 | typecheck/build/test 通过；RQ-01/RQ-05 首次运行；无双缓存；vite server/build 参数未变 | 已解除（OPEN-V21-01/02/03 已决策） | **PASS（2026-10-27，§15）** |
| M2 | 客户端状态与 RTK 退役 | **M2a（完成）**：全部端点迁 Query、RTK Query 删除、RQ-02/03/04 运行、旧地址删除。**M2b（完成）**：5 个 Zustand store、Redux/react-redux/store 删除、测试迁移 jsdom | 无 RTK Query 端点；RQ-02/03/04 PASS；Zustand 不含 Query 副本；Redux 依赖为零 | M1 | **M2 PASS（§16/§17）** |
| M3 | 实时协议与命令桥 | 契约、解码/序列、类型化流、WebSocket 传输骨架、CommandEventBridge/恢复队列、假源集成测试、ARCH 边界静态检查 | CE-01..CE-05、CE-08 在假源上运行；ARCH-06/07 检查通过 | M1；后端流协议 OPEN-V21-06（真实链路） | **PASS（2026-10-27，§19）；真实 WebSocket M4+** |
| M4 | XState 工作流与 FabRuntime | `workflows/equipment` 四文件、`runtime` 四件套、`RuntimeProvider`、三 FAB 隔离测试 | CE-06/CE-07 在测试源上运行；ARCH-08/09/10 检查通过；单 FAB 回归通过 | M3；OPEN-V21-07/08；多 FAB 产品范围 | 未开始 |
| M5 | 高频渲染管线与目录归位 | Worker/TypedArray 缓冲、Lite 渲染接入、`rendering`/`features` 等目录迁移、性能测试 | ARCH-11 检查通过；性能测试基线记录；无 WebGL；现有 Lite 验收不回退 | M1；现有 Twin/Lite 迁移工作完成 | 未开始 |
| M6 | 收口与退役 | ARCH-01..12 自动化检查、旧迁移文档/证据/测试清理、CE-06/CE-07 真实链路证据（若后端就绪） | `pnpm verify` 实际通过并留有记录；ARCH 检查可执行；CE-06/CE-07 真实链路证据（若后端就绪） | M2/M4/M5；后端实时服务 | 未开始（Redux/RTK 与 ADR-0008 状态已在 M2 完成） |

**关键路径**：M1 -> M2 -> M3 -> M4 为主链；M5 可与 M3/M4 并行，但依赖现有 Twin/Lite 工作收尾。真实后端 WebSocket 是 CE-04/CE-06 的硬依赖，前端不得用假源证据替代生产链路验收。

## 11. 风险登记

| ID | 风险 | 影响 | 缓解 | 触发信号 |
|---|---|---|---|---|
| R-01 | 双栈期间残留两份缓存（RTK Query + Query） | 数据不一致、RQ 门禁失真 | G-02 按端点同 PR 切换；M2 结束前做“无 RTK 端点”静态清单 | 同一端点出现两套 hooks/请求 |
| R-02 | 路由插件改变 Vite build 行为 | 违反 G-01、产物/分包变化 | 插件仅生成路由树；对比 build 产物与 manualChunks；不满足则 code-based | build 产物/分包 diff |
| R-03 | 集成测试环境缺失（jsdom/Testing Library） | RQ/CE 无法执行，门禁长期 NOT RUN | M1 前置批准 devDependencies；先写环境 smoke test | RQ 测试无法启动 |
| R-04 | 后端实时/命令状态端点未提供 | CE-04/CE-06 无法真实闭环 | 假源只用于结构验证；后端契约列为 OPEN-V21-06/07 | 真实链路验收缺失 |
| R-05 | 多 FAB 产品范围未定 | FabRuntime 三 FAB 隔离只能测试床验证 | 以复合身份与假 FAB 源覆盖 CE-07；产品范围由 Lead 决策 | 需求变化 |
| R-06 | XState v6 仅有 alpha（6.0.0-alpha.70） | 工作流实现或 API 变化返工 | 按用户指示锁定 v6 alpha 并隔离在 `CommandWorkflow` 实现内；M4 前复核 API/升级，不回退 v5 | alpha 破坏性变更/构建失败 |
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
| CE-06 | 重连后通过后端权威查询收敛 | `web_app/tests/contract/command-workflow.test.ts`、`command-recovery.test.ts` | SPECIFIED / NOT RUN |
| CE-07 | 三 FAB 相同 commandId 隔离 | 同上 | SPECIFIED / NOT RUN |
| CE-08 | Runtime 关闭后取消订阅/停止 actor | `web_app/tests/integration/command-event-bridge.test.ts` | **PASS（M3 bridge 生命周期；Runtime 装配 M4）** |
| 性能 | 渲染/高频路径帧预算与帧率 | `web_app/tests/performance` | SPECIFIED / NOT RUN |

### 12.3 当前测试基建事实

- 已安装 jsdom 30.1.3、@testing-library/react 16.3.3、TanStack Router/Query、Zustand、XState 6.0.0-alpha.70、RxJS、Zod，并建立 `web_app/tests/integration`。
- RQ-01..RQ-05 已真实运行；`router-search.test.ts` 覆盖 Router search 转换；M3 新增 `realtime-protocol.test.ts`、`command-event-bridge.test.ts`、`command-recovery.test.ts`、`architecture-boundaries.test.ts`。M3 后共 **62 文件 / 280 测试 PASS**。
- CE-01..CE-05、CE-08 已在假源/假 gateway 上运行 PASS；CE-06/CE-07 与性能门禁仍为 **SPECIFIED / NOT RUN**（M4）。

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
| OPEN-V21-08 | XState 版本与 actor 粒度 | **版本已定**：按用户指示直接使用 XState v6（当前 6.0.0-alpha.70）；actor 粒度在 M4 定 |
| OPEN-V21-09 | ~~前端恢复记录生命周期~~ | **已决策（M3）**：内存有界队列（`CommandEventRecovery`，per-command/global 上限）；持久恢复仍归后端 |
| OPEN-V21-10 | CommandGateway HTTP 提交契约 | 后端/前端，M3 |
| OPEN-V21-11 | FabRuntime 实例化时机（应用启动/路由进入）与页面卸载语义 | 实施者，M4 |
| OPEN-V21-12 | ~~README/外部规范是否增加 V2.1 指针~~ | **已解决（M1）**：README 文档区已加 V2.1 指针；Engineering v1.1 保持只读 |
| OPEN-V21-13 | 工作流状态的只读暴露方式（Query 权威状态 + 提交态之外的展示投影） | 实施者，M4 |
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
| 依赖 | Router 1.170.46、Query 5.105.0、router-plugin 1.168.48、Zustand 5.0.16、RxJS 7.8.2、XState 5.33.3（M2a 已改 6.0.0-alpha.70，见 §16）、Zod 4.6.7；dev：jsdom 30.1.3、Testing Library 16.3.3 | `web_app/package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` |
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
- XState 稳定版为 5.33.3（6.0 仅 alpha）；已按用户批准安装 5.33.3，M4 前必须复核是否升级 v6。
- 以上是 M1 当时的记录；M2a/M2b 之后已由 §16/§17 取代。CE-01..08、性能门禁仍为 SPECIFIED / NOT RUN。

## 16. M2a 落地记录（2026-10-27）

> 本节记录 M2 的数据层（M2a）；Zustand/Redux 退役（M2b）见 §17。

### 16.1 交付

- **全部 7 个 RTK Query 端点迁到 TanStack Query**：equipment status、catalog、runs list/detail/results、research JSONL、wafer routes；模块位于 `web_app/src/api/queries/`，mutation 位于 `web_app/src/api/mutations/runs.mutations.ts`。
- **RTK Query 退役**：删除 `web_app/src/store/api.ts`、`twinApi` reducer/middleware 与 `tests/rtk-api.test.ts`；Redux 只剩临时客户端 UI slice（M2b）。
- **SSE 走 Query 缓存**：Twin 的 `watchEquipmentStatus` 快照除有序消费外写入 `equipmentStatusQueryKey(siteId)`，Query 是唯一服务端缓存；轮询仅作回退。
- **旧地址与重定向彻底删除**：`/twin*`、`/preview*`、`/catalog*`、`/compare*`、`/workbench` 不再有别名/catch-all 重定向（访问返回 not-found）；`/fabs/$fabId` 的 M1 重定向入口也删除，仅保留 `/fabs/$fabId/3d`。
- **XState**：按用户指示将依赖从 5.33.3 换成 **6.0.0-alpha.70**（当前无 stable v6），actor/工作流仍在 M4 接入。
- 其余 Query 模块：`queryKeys.ts` 增加 equipment/catalog/runs/research/wafer 工厂；transport 统一在 `api/queries/http.ts`（same-origin、no-store、Zod envelope 校验、ProblemDetails）。

### 16.2 证据（本次实际运行）

- `npx tsc --noEmit` → 0；`npx vitest run` → **57 文件 / 260 测试 PASS**；`vite build` → 0。
- RQ-02/RQ-03/RQ-04 新增于 `web_app/tests/integration/query-cache.test.tsx`：过期数据由页面订阅刷新、mutation 失效后读回权威列表、按 siteId 隔离 equipment status 缓存。
- `web_app/tests/api-queries.test.ts` 覆盖 Query transport（URL/credentials/no-store/Idempotency-Key/ProblemDetails/Zod 拒绝）。
- `./scripts/verify.ps1` 见 M2a 提交记录（契约/架构、16 Python、3 .NET + 67、冻结向量、前端全量）。

### 16.3 过渡与遗留

- ~~Redux Toolkit 仍承载 7 个客户端 UI slice~~：M2b 已迁 Zustand 并删除 Redux/react-redux（§17）。
- ~~目录/对比页内部筛选、Twin 的 `?siteId/?modal/?mode` 仍是 history/直接 location 过渡~~：已在 M2c 迁到 TanStack Router search（§18）。
- XState v6 为 alpha：M4 需复核 API 并在 `CommandWorkflow` 实现内隔离，不向页面泄漏 actor。
- CE-01..08、性能门禁、M3–M6 未开始。

## 17. M2b 落地记录（2026-10-27）

> 本轮完成客户端状态迁移与 Redux 退役；Router search 清理（目录筛选/Twin URL 参数）随后在 M2c 完成，见 §18。

### 17.1 交付

- **Zustand 接管客户端状态**：新增 `web_app/src/state/`：`twinUiStore`、`twinPageStore`、`twinDemoStore`、`catalogStore`、`workbenchStore`、`runtimeStore`、`localeStore`，以及 `state/telemetry-buffer.ts`；store 使用纯不可变 reducer（`createSliceStore`，无 Immer），actions 为 store 方法（无 Redux dispatch）。
- **Redux 彻底删除**：删除 `web_app/src/store/`（7 个 slice、hooks、store、api 残留）、`react-redux`/`@reduxjs/toolkit` 依赖；`AppProviders` 仅保留 QueryClientProvider + ErrorBoundary。
- **Twin 保留性能边界**：twin-page 仍用 wafer-excluded shallow 订阅避免逐帧 HUD 更新触发整页渲染；帧循环通过 `getState()` 读取 live 状态，不新增 React 状态。
- **测试迁移**：Redux slice 测试改写为 Zustand store/action 测试；需要已挂载状态的组件测试改为 jsdom + Testing Library（Zustand SSR 快照为初始状态）；telemetry-buffer 路径迁移。
- **依赖**：未新增第三方包（Zustand 原生 + 纯不可变 reducer）；`react-redux`、`@reduxjs/toolkit` 移除。XState 仍为 6.0.0-alpha.70。

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
- **ARCH 静态检查**：`tests/architecture-boundaries.test.ts` 验证 ARCH-06/07/08（realtime 不依赖 workflows/XState/React 状态库；application 只依赖 contracts；CommandWorkflow 契约单点定义）。

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
