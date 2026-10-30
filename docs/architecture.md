# SemiconFab Next V2.1 架构基线

> **2026-10-29 更新：** 本 V2.1 基线（TanStack Query/Zustand/RxJS/Zod/routeTree 生成）已被 Effect 4 + 严格单层目录 + code-based routing 重构取代。当前事实与验收证据见 [architecture/README.md](architecture/README.md)、[01-effect4-target-architecture.md](architecture/01-effect4-target-architecture.md)、[02-flat-source-layout.md](architecture/02-flat-source-layout.md)、[03-migration-plan.md](architecture/03-migration-plan.md)、[04-acceptance-and-architecture-gates.md](architecture/04-acceptance-and-architecture-gates.md) 与 [ADR-0011](adr/0011-effect4-runtime-architecture.md)。本文 §1–§30 保留 2026-10-28 的历史轨迹，不再代表当前实现；当前状态见 [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)。

- 版本：V2.1 历史基线（2026-10-27；2026-10-28 R-01…R-14 同步）；**2026-10-29 被 Effect 4 重构取代，见页首更新**
- 状态：**基线已采纳；M0–M6、all review batches 与 2026-10-28 递归整改（11 个职责提交 + 文档同步提交，`67915c0..546647d`）均已落地：多 FAB 目录/遥测、FAB 级设备状态、命令幂等/鉴权/校验、SSE 游标/缺口恢复、命令保留、真实 GPU 门禁与压力测试、严格 ScenePort 生命周期、确定性领域时钟、独立 GPU Effect Owner、生成物登记/校验、实时/feature 所有权收口与 R0–R14 架构门禁全部实现；2026-10-28 收尾提交进一步消除 R12/R13 例外并为 routeTree 增加官方生成一致性门禁；仅 PostgreSQL/Outbox/生产身份因基础设施缺失保留为边界**。
- 适用对象：`web_app` 前端架构。后端 `fab_app`/`fab_shared` 的项目与命名空间边界沿用 ADR-0001…ADR-0007
- 产品范围（2026-10-30 Round 3 更新）：当前部署默认 1 个 FAB；架构必须支持 `Fab:FabCount` 1..32 个相互独立、完整配置的 FAB。集合契约、复合身份 `(siteId,fabId)` 与按 FAB 隔离的 Runtime/遥测/设备状态为架构默认语义；浏览器验收可聚焦单 FAB 渲染，跨 FAB 由显式多 FAB 配置的集成/多 FAB Run 测试覆盖。
- 权威决策：[ADR-0009](adr/0009-tanstack-router-query-boundary.md)（Router/Query 边界）、[ADR-0010](adr/0010-command-event-bridge.md)（实时/命令/工作流边界）；本文档负责汇总、目录结构、规则、数据流、迁移与整改记录
- 当前实现事实（2026-10-28 终态，详见 §4/§30）：服务器资源快照以 TanStack Query 为唯一缓存；命令提交与权威命令状态通过显式 HTTP 适配器处理，不在 Query 中复制进行中的工作流状态；所有 HTTP 请求统一使用 `api/transport/http.ts`；客户端 UI 状态由 7 个 Zustand store 独占（twinUi/twinPage/twinDemo/catalog/workbench 位于 `features/*/state/`，runtime/locale 位于 `state/`），均由类型安全 `createSliceStore` 生成；RTK Query、Redux Toolkit、react-redux 与 `src/store/` 已全部删除；XState v6 工作流实现位于 `runtime/commands`，经 `CommandWorkflow` 契约暴露（位置不构成架构约束）；浏览器场景依赖应用侧 `application/ports/scene.ts` 的 `ScenePort`（必需命令 + 强类型 mount options + `ViewerLifecycle`），由 `rendering/lite-backend.ts` 实现，不再存在 `rendering/fab-scene.ts`；纯领域拆分为 `domain/{fab,amhs,personnel,equipment,simulation,wafer,math}`，MES 创建函数要求显式 epoch 毫秒；`TwinLanguage` 位于 `localization/language.ts`；生成物由 `tools/generated-artifacts.json` 登记并由 `node tools/check_generated_artifacts.mjs --check` 校验；架构门禁为 `web_app/tests/architecture/` 的 R0–R14（真实 TypeScript import 图 + 负向 fixtures）。详细证据见 [实施状态](IMPLEMENTATION-STATUS.md)、§29、§30。

> RQ-01..RQ-05、CE-01..CE-08、ARCH 检查与真实 Chrome/WebGPU 性能门禁均已真实运行（见 §12.2/§26/§30）；任何“已通过/已验证”的表述都必须指向真实测试记录。
>
> **文档时效约定（2026-10-28）：** §15–§29 是按日期记录的历史落地轨迹，保留当时的路径、测试文件名与数字（审计轨迹，不追改）；目录/契约/门禁的**当前事实**以 §4 与 §30 为准。历史记录中出现的 `tests/*.test.ts` 平铺路径或已迁移模块名，均以 §30 的镜像式测试布局与终态目录为准。

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

允许的 import 方向（本基线强约束，由 `tests/architecture/` 的 R0–R14 与 `tools/check_architecture.py` 落实）：

| 层/目录 | 允许依赖 | 禁止依赖 |
|---|---|---|
| `app/providers`、`app/router/routes`（装配根，R7 豁免） | 任意下层：`runtime`、`api`、`features`、`components`、`state` | —（装配根只做组合，不新增业务逻辑） |
| `app/router` 直接文件（`router/search/url-mapping/route-data/routeTree.gen`） | `api/queries`、`contracts`、通用 schema/helper | `features/**`（R2）；feature 专属转换归 `features/*/search.ts` |
| `features` | `api`、`domain`、`state`、`localization`、`shared`、`components`、`application/ports`、`contracts` | 直接 new WebSocket、直接 import XState actor、绕过 Query 自建 HTTP 缓存；跨 feature 互导（R4，需显式批准表） |
| `components`（公共设计系统，R12） | `state`、`contracts` 与无 feature 知识的类型 | `features/**`；无跨 feature 使用又无设计系统角色的组件 |
| `api` | TanStack Query、`transport/http`（FetchLike）、`schemas`（Zod）、`application/contracts` 类型、`domain` 纯类型、`realtime/equipment-status`（仅 cache bridge） | `runtime/commands`、`features`、`components`、`rendering` |
| `application/ports`（`scene.ts`） | `domain` 纯类型 | Babylon/GPU、React、Query、Zustand、XState |
| `application/contracts` | 无（可依赖 RxJS 类型与领域类型；不依赖基础设施/工作流实现） | WebSocket/SSE、XState、React、Query |
| `application/coordination` | `application/contracts`、`application/ports` 类型 | `runtime/commands`、XState、React、Query |
| `realtime` | `application/contracts`、`domain`、`shared`、`contracts` | `runtime/commands`、XState、React、Query/Zustand（ARCH-06/R7） |
| `shared`（如 `scheduling/coalesced-dispatcher`） | 无（纯通用原语） | 任何业务层/特征层 |
| `runtime/commands` | `application/contracts`、XState v6、XState 内部类型、`domain` | `realtime/transport` 实现、`app`、`api` |
| `runtime` | `application/contracts`、`application/coordination`、`realtime`、`runtime/commands`、`api/queries`（仅装配 QueryClient 引用） | 页面组件、UI 细节 |
| `rendering`（Lite/WebGPU） | `application/ports/scene`（实现方）、`domain` 类型、`generated` 数据、`rendering/contracts` | React、Query、Zustand、XState、`runtime/commands`、`features`（ARCH-11/R7；高频层检查同样覆盖 `realtime/buffers`、`realtime/workers`） |
| `domain` | 无 npm 包；`domain/**` 与 `web_app/assets` 静态参考数据（R3/R8） | React/Zustand/XState/@tanstack/Babylon；app/features/state/rendering/realtime/runtime/application/components/api；隐式时钟/随机/DOM/timer/网络 |
| `state`（Zustand） | `domain`、`generated` 契约类型、`application/ports` 类型 | Query 结果副本、XState actor、引擎对象、跨 store 直接 `setState` 互写 |
| `localization` | 无 | `domain`、`features`（仅被上层消费） |

## 4. 目录结构（`web_app/src`，2026-10-28 递归整改后终态）

以下为当前真实布局（逐项对照真实树，2026-10-28 复核）；§29 是更早一次 P2 清理的历史记录，其目录名可能已被同日递归整改再次迁移，终态以本节与 §30 为准。

```text
web_app/
  index.html
  package.json / pnpm-lock.yaml / pnpm-workspace.yaml（仅 pnpm 配置载体，不是 workspace）
  .npmrc / tsconfig.json / vite.config.ts
  src/
    main.tsx / contracts.ts  # 入口与公共契约 re-export；R6 门禁只允许这两个 root 文件
    app/
      providers/            AppProviders / QueryProvider / RuntimeProvider / RuntimeBootstrap / TelemetryProvider（装配根）
      router/               router.tsx / search.ts（通用 schema+helper）/ url-mapping.ts / route-data.ts
        routeTree.gen.ts    文件式路由生成并提交
        routes/             装配入口：按 URL 组合 features 页面（唯一允许 import features 的 router 位置）
    api/
      transport/http.ts     唯一 HTTP 策略（同源相对路径、credentials/no-store、ProblemDetails、FetchLike 注入；R-10）
      schemas/              Zod 运行时合同（command.schema.ts；R-03）
      cache/                equipment-status-bridge（REST/SSE → Query 缓存唯一 acceptance 投影桥）
      queries/              queryClient / queryKeys / sites|equipment|catalog|runs|research|wafer.queries
      mutations/            runs|commands.mutations
    application/
      contracts/            CommandEvents / CommandGateway / CommandWorkflow（契约单点）
      coordination/         CommandEventBridge / CommandEventRecovery / CommandCorrelationRegistry / ScopeGate
      ports/scene.ts        ScenePort：必需 SceneCommands + 强类型 SceneMountOptions + mount/dispose 生命周期（R-04/R9）
    realtime/
      equipment-status/     protocol（payload/scope）/ gate（epoch+sequence 唯一权威）/ stream（SSE）/ index
      protocol/             MessageDecoder（SSE envelope 解码）
      telemetry/            TelemetryRuntime（传输/帧/背压）+ FabTelemetryRegistry（acquire/release）
      transport/            SseCommandEventSource（权威 HTTP Gateway 在 api/transport）
      workers/              telemetryWorker（入口）/ telemetryWorker.logic（纯 handler）/ createTelemetryWorker
      buffers/              FrameRingBuffer
    runtime/
      commands/             equipmentCommand.machine.ts / equipmentCommand.logic.ts /
                            CommandReconciler / XStateCommandWorkflowAdapter（位置非强制）
      FabRuntime / FabRuntimeFactory / FabRuntimeRegistry / FabLifecycleCoordinator / commandSources
    state/                  共享客户端状态（类型安全 createSliceStore）：runtimeStore（含 ViewerLifecycle）/ localeStore / preferences
    localization/language.ts TwinLanguage（UI 语言状态；不进入 domain）
    shared/scheduling/      coalesced-dispatcher（通用低频合批原语，不绑定遥测）
    domain/                 纯领域模块（无框架/无包依赖/无隐式时钟；见 §3，R3/R8）：
      fab/                  fab-layout / process-control（MES 创建函数要求显式 epoch-ms）/ fab-yield /
                            cleanroom-pressure / layout-identities / original-twin-data / twin-spatial
      amhs/ personnel/      amhs-timeline / personnel-timeline
      equipment/            tool-state-projection（遥测帧 → FabToolState 纯函数）
      simulation/           tour-timeline / tour-scenario / original-tour / research-replay / scenario / twin-equipment
      wafer/                wafer-timeline / wafer-scenario / wafer-route / wafer-map
      math/                 vec3 / round（Tour 与 Wafer 时间线共享的数学原语）
    generated/              生成物（禁止手改；登记于 tools/generated-artifacts.json）：contracts.generated.ts /
                            twin-translations.generated.ts / static-structure-packed.ts
    rendering/
      lite-backend.ts       application/ports/scene 的产品实现（Lite runtime/world、设备丢失恢复；R9）
      contracts/            static-structure-data.ts：生成物 payload 的手写类型合同（生成物仅 type-only 引用）
      lite/                 Babylon Lite / WebGPU 实现：runtime / world / camera / environment / lighting /
                            selection / cut-plane / motion / airflow-texture / source-orbit-input / tool-states …
        effects/            xray / xray-shaders / cut / wafer / index：独立 create/update/dispose 资源所有者（R-06）
        geometry/           facility / tool-families / original-tool-parts / original-exploded-link-data / static-structure
        shadows/            native-lite-shadow
    features/
      twin/                 页面 + controllers/（10 个控制器，零相互 import）+ state/（twinUiStore/twinPageStore/
                            twinDemoStore/twin-state）+ twin-search.ts + wafer-session.ts + equipment-status-pipeline.tsx
                            + HUD/侧栏/检查器/对话框子组件
      catalog/              catalog-page / catalog-data / search / labels / types + components/ + controllers/ +
                            export/（catalog-export/download-lifecycle/use-catalog-downloads）+ state/catalogStore
      workbench/            workbench / command-console / error-message / format + components/（含本地 panel/status-pill 原语）+ controllers/ + state/workbenchStore
    components/             共享设计系统：modal / error-boundary / class-names / original-icons（+ original-icons-data，R12；单 feature 组件不下沉到全局）
  tests/                    镜像式布局：api/ application/ components/ contract/ domain/ features/ integration/
                            performance/ realtime/ rendering/ state/ architecture/（含 R0–R14 门禁与 fixtures/r7…r14）/
                            fixtures/ support/ types/；另含真实浏览器压测页 telemetry-stress.html/ts
  assets/                   Vite 打包的 CSS/i18n/原始参考数据与生成器输入
  public/                   浏览器 URL 直接请求的数据与许可证副本
```

与 V2.1 目标计划的差异：计划中的 `realtime/synchronization/` 与 `api/endpoints/` 未创建（合批原语归 `shared/scheduling/`，HTTP 归 `api/transport/http.ts`）；`api/schemas/`、`shared/`、`application/ports/` 已在递归整改中真实建立。目录解释以本节与 §30 为准。

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
- **路由文件位置**：当前 `routes/` 只有 `__root`、`index`、`equipment`、`equipment/compare`、`fabs/$fabId/3d`；最终 URL 已由 M1 定稿，M2 删除旧地址后不存在别名/重定向（OPEN-V21-01 已解决，见 §4.1）。
- **测试位置**：按 ADR-0003 与 `tools/check_architecture.py`，测试不得放 `src`；2026-10-28 起 `web_app/tests/` 按源码所有权镜像（`api/application/components/contract/domain/features/integration/performance/realtime/rendering/state/architecture` + `fixtures/support/types`），历史平铺测试已迁移且 golden fixtures 未改。
- **`domain`/`state`/`rendering`/`features`/`components`/`generated`** 已按递归整改后的终态落地：`domain/**` 是纯叶子层（见 §3/§30），生成物统一在 `src/generated/` 并由 `tools/generated-artifacts.json` 登记；V2.1 计划中的 `realtime/synchronization` 与 `api/endpoints` 未创建，不把“未创建”描述成“已存在”。

## 5. 三条数据流与 FabRuntime

### 5.1 HTTP 数据流

```text
Router -> TanStack Query -> HTTP API -> Zod -> Query Cache -> React
```

（上图为规范流程图；实际触发点是 Router 的 navigation 或 intent 预加载 -> 路由 loader。）

1. 导航（或 intent 预加载）触发路由 loader。
2. loader 只调用 `context.queryClient.ensureQueryData(<queryOptions>)`；Query Options 与组件共用同一份定义（`api/queries/*.queries.ts`）。
3. Query 命中缓存则直接返回（即使已过 `staleTime`，也不会因此强制网络请求）；未命中才走 `api/transport/http.ts` 的 HTTP 调用。
4. 响应在进入缓存前经 `schemas` 的 Zod 校验（计划依赖），校验失败不得写入缓存。
5. 页面用 `useQuery`/`useSuspenseQuery` 订阅同一 Query；后台刷新、失效、重连都会自动反映到 UI。
6. 需要权威新数据时（不能容忍旧缓存）使用 `queryClient.fetchQuery(...)` 显式获取；这是逐路由的显式决策，不是默认 loader 模式。

### 5.2 命令事件流

当前实现（HTTP/SSE 模拟后端；生产 WebSocket 未接）：

```text
后端命令 SSE -> SseCommandEventSource（MessageDecoder envelope）-> RxJS Observable<CommandResultEvent>
             -> CommandEventBridge（FAB 过滤 / 复合身份关联 / revision 去重）
             -> CommandWorkflowRegistry.get(fabId, commandId) -> XState v6 workflow
```

1. `realtime/transport/SseCommandEventSource` 建立 EventSource，跟踪后端 journal 游标 `id: {epoch}:{sequence}`，把 `replay-gap` 控制帧暴露为显式 `gaps$` 信号；重连由浏览器 EventSource 负责。
2. 帧由 `realtime/protocol/MessageDecoder` 以 Zod envelope 校验/解码（不合法帧丢弃并记录诊断，不猜语义）。
3. `application/coordination/CommandEventBridge` 订阅结果流，按 `fabId` 过滤，按复合身份 `(fabId, commandId)` 关联，按 `revision` 去重，再调用 `CommandWorkflowRegistry.get(fabId, commandId)`。
4. `runtime/commands/XStateCommandWorkflowAdapter` 把 `receive(event)` 映射到 `equipmentCommand.machine.ts`；`CommandReconciler` 通过 `HttpCommandGateway`（`GET /api/v1/commands/{id}`）处理缺口/缺失 actor/断线恢复。
5. 恢复以“关联恢复记录 + 后端权威状态查询 + 有界 pending queue”闭环；持久化恢复是后端责任（[命令核对](command-reconciliation.md)）。
6. 历史说明：2026-10-27 审计清理删除了生产不可达的 `realtime/streams`/`WebSocketClient`/`SequenceTracker`/`RealtimeGateway` 骨架；真实 WebSocket 接入时按 ADR-0010 重建（见 §30）。

### 5.3 高频渲染数据流

```text
FAB 级 20Hz 遥测 SSE -> TelemetryRuntime -> telemetryWorker（module Worker）
                     -> FrameRingBuffer（TypedArray）-> 渲染 frame loop（lite-backend/ScenePort）
```

1. 高频遥测帧经 `realtime/telemetry/TelemetryRuntime` 解码/背压后交给 `realtime/workers/telemetryWorker`，写入 `FrameRingBuffer`。
2. Worker 通过 `postMessage`（transferable；SharedArrayBuffer 未启用）把最新帧/摘要交给渲染循环；UI 低频聚合经 `shared/scheduling/coalesced-dispatcher`（100ms 合批）单独提供。
3. `rendering/lite-backend.ts` 的帧循环通过 `getToolStates()` 读取最新槽位状态并更新 GPU 实例属性；渲染循环不读 Query/Zustand/XState。
4. 该路径完全旁路 ARCH-02/05/11 禁止的容器；不得以逐事件 `setState` 或逐帧 Redux dispatch 实现。

### 5.4 FabRuntime：唯一生命周期装配点

- 每个 FAB 一个 `FabRuntime`：实时源（实现 `CommandEventSource`，当前为 `SseCommandEventSource`）、`CommandEventBridge`、`CommandWorkflowRegistry` 与工作流实现都在这里组装；权威查询经 `CommandGateway`（`HttpCommandGateway`）。
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

规则的可执行检查已在 2026-10-28 递归整改中收口为 R0–R14（全部真实运行）：

| 门禁 | 内容 | 位置 |
|---|---|---|
| R0 / R0b | 所有相对 import 可解析；tsconfig 不使用路径别名 | `web_app/tests/architecture/architecture-import-graph.test.ts` |
| R1 / R10 | 运行时模块图无环；R10 进一步要求含 type-only 边的全图无环 | 同上 + `architecture-contract-rules.test.ts` |
| R2 | `app/router/` 直接文件（通用工具）不得 import `features/**` | `architecture-import-graph.test.ts` |
| R3 / R8 | `domain/**` 纯度：无 npm 包；无 Date/Math.random/DOM/timer/network 与顶层副作用；静态参考数据只来自 `web_app/assets/**` | `architecture-import-graph.test.ts` + `architecture-contract-rules.test.ts` |
| R4 | `features/{catalog,twin,workbench}` 互不依赖，跨 feature 需登记 `APPROVED_CROSS_FEATURE_IMPORTS` | `architecture-import-graph.test.ts` |
| R5 / R11 | 生成物登记/do-not-edit 头/数据化；R11 由 `tools/check_generated_artifacts.mjs --check` 校验登记表与 sha256；`routeTree.gen.ts` 例外：在隔离 worktree 用官方插件重生成并逐字节比对（版本固定） | 两个 import 图门禁 + R11 测试 + 根目录 checker + `route-tree-generation.test.ts` |
| R6 | `src/` 根只允许 `main.tsx`/`contracts.ts` | `architecture-import-graph.test.ts` + `tools/check_architecture.py` |
| R7 | 通用基础层（api/realtime/rendering/components/state/application/runtime）不得 import `features/**`；装配根 `app/providers`、`app/router/routes` 豁免 | `architecture-contract-rules.test.ts` |
| R9 | `SceneCommands` 无 optional 成员，`ScenePort` 仅 `acceptance` 可选，且 `rendering/lite-backend.ts` 实现全部必需命令 | 同上 |
| R12 | `src/components/**` 公共组件必须有跨 feature 使用或可验证 owner 角色：design-system / frozen-asset，或由 `app/**`/`main.tsx` 实际 import 的 app-infrastructure（应用级组件如 ErrorBoundary 按职责归属，不以 feature 计数为唯一标准）；单 feature 组件必须下沉 | 同上 |
| R13 | `src/features/**` 的空依赖 effect 不得捕获变化 props/state/callback（`useEffectEvent`/ref 间接为稳定原语）；当前零例外（Tour stop 为稳定身份 + 显式依赖） | 同上 |
| R14 | 禁止未登记 `any`/`as any`/无说明 `as unknown as` 与 `String()/Number()` 伪校验响应数据；`@ts-nocheck` 仅允许官方 `routeTree.gen.ts` 生成物 | 同上 |

每条规则都有 `web_app/tests/architecture/fixtures/r7…r14/**` 负向/正向样例证明其可失败；`architecture-boundaries.test.ts` 的通用正则规则与 `tools/check_architecture.py` 的终态目录检查与之互补。2026-10-28 之前平铺在 `web_app/tests/` 根的门禁文件已迁入 `web_app/tests/architecture/`。

路由树 `src/app/router/routeTree.gen.ts` 由 `@tanstack/router-plugin` 在构建期生成，其物理位置是工具链约定，因此不登记在 `tools/generated-artifacts.json`；`web_app/tests/architecture/route-tree-generation.test.ts` 会在隔离的干净 worktree 中执行官方 Vite 构建重新生成该文件并逐字节比对，同时断言插件/生成器版本固定、`@ts-nocheck` 只出现在该生成物中。不一致即失败，绝不自动覆盖后放行。

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
| [ADR-0008](adr/0008-redux-toolkit-rtk-query.md) | **已被取代（M2）** | RTK Query 由 ADR-0009 取代（M2a）；Redux Toolkit/react-redux 由 V2.1 的 Zustand store 取代（M2b），`src/store/` 已删除。仅保留“Babylon 对象不入状态容器、遥测合批”等原则（ARCH-11）；该 ADR 末尾的 2026-10-28 更新段给出终态映射（`ScenePort`、`shared/scheduling/coalesced-dispatcher.ts`、R7–R14） |
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
| 客户端状态 | 7 个 Zustand store 承载 UI 状态（twinUi/twinPage/twinDemo 在 `features/twin/state/`，catalog/workbench 在各自 feature `state/`，runtime/locale 在 `state/`）；`createSliceStore` 为类型安全工厂（无 `any`/action 接口断言）；跨 store 协调经 feature 入口（如 `features/twin/wafer-session.ts`）；TelemetryRuntime 的槽位投影为纯函数 `domain/equipment/tool-state-projection.ts`；Redux/react-redux 已删除 | Zustand/组件局部；不复制 Query 数据 | M2b/P2/R-15 | **PASS（终态见 §30）** |
| 实时推送 | 设备状态 SSE + 后端模拟命令/遥测 SSE（20Hz）已接入产品；类型化流解码/序列/桥接 M3 已验证；WebSocket 传输仍可后续替换 | WebSocket/SSE -> Decoder -> RxJS -> 类型化流 | M3/M4/M5c | **PASS（HTTP/SSE 模拟后端）；WebSocket 未接** |
| 命令链路 | 契约 + Bridge + 恢复 + XState 工作流 + FabRuntime；M5c 接入后端模拟命令 API（POST/GET/SSE）与 Workbench 命令面板；浏览器实测 accepted→executing→succeeded；WebSocket 生产链路可后续替换 | CommandEventBridge + CommandWorkflow + 恢复 | M3/M4/M5c | **PASS（HTTP/SSE 模拟后端 + 浏览器 e2e）；WebSocket 未接** |
| XState | XState v6 已接入，实现位于 `runtime/commands`，经 `CommandWorkflow` 契约暴露 | XState v6（隐藏在 `CommandWorkflow` 后） | M4/M5a | **PASS** |
| FabRuntime | `runtime/` 四件套已实现，RuntimeBootstrap 按 sites 为每个 FAB 装配；命令源为后端命令 SSE，gateway 为权威 HTTP 查询 | `FabRuntime` 等四件套，按 FAB 装配/销毁 | M4/M5a | **PASS（模拟后端；WebSocket 未接）** |
| FAB 范围 | 当前产品与测试仅 FAB-01；保留 `Fab:FabCount` 1..32 与按 FAB 装配的 Runtime/遥测/设备状态/UI；121 台设备布局在 `domain/fab/fab-layout.ts` | 单 FAB 功能与生命周期回归；多 FAB 仅架构扩展 | M4/M5a | **单 FAB 回归；多 FAB 不属当前验收** |
| 高频遥测 | 后端 20Hz 遥测 SSE → TelemetryRuntime（传输/解码/帧/背压）→ Worker FrameRingBuffer → 渲染 frame loop；槽位投影为纯函数 `domain/equipment/tool-state-projection.ts`；`FabTelemetryRegistry` 按 FAB acquire/release；不经 Query/Zustand/XState（ARCH-11） | Worker/TypedArray -> Babylon Lite | M5b/M5c/P2 | **PASS（模拟后端 + Worker + 渲染接线）**；SharedArrayBuffer/COOP-COEP 未启用 |
| 渲染 | Babylon Lite 1.36 在 `src/rendering/lite`，WebGPU-only；`application/ports/scene.ts` 是应用侧唯一 ScenePort（必需命令 + 强类型 mount options + ViewerLifecycle），`rendering/lite-backend.ts` 实现它，`lite/effects/` 拆为 xray/cut/wafer 独立资源所有者，无 `rendering/fab-scene.ts`；真实浏览器 WebGPU 性能门禁已运行 | 保留 | M5/M5c/R-04/R-06 | **PASS（ScenePort + Effect Owner + Chrome WebGPU 门禁）** |
| 依赖 | TanStack Router 1.170.46 / Query 5.105.0 / Router plugin 1.168.48、Zustand 5.0.16、RxJS 7.8.2、Zod 4.6.7、XState v6；jsdom 30.1.3 + Testing Library（dev）；Redux/react-redux 已移除 | 按阶段引入并锁版本；XState 实现经契约隔离 | M1..M4 | M2b 已移除 Redux；XState v6 已接入 |
| 测试基建 | Vitest + jsdom + Testing Library；RQ/CE/架构（含真实 import 图 R0–R5）/传输/Worker 测试真实运行；真实 GPU 性能脚本 | 契约/集成 + CPU/GPU 性能门禁 | M1 起 | **M1–M5 PASS；GPU 门禁已运行** |
| 架构检查 | `web_app/tests/architecture/` 三层门禁：`architecture-boundaries.test.ts` 正则边界、`architecture-import-graph.test.ts` 真实 TypeScript import 图 R0–R6、`architecture-contract-rules.test.ts` R7–R14（含负向 fixtures）；`tools/check_architecture.py` 检查终态路径/依赖/ARCH-11 + domain 分层/旧根模块缺席/generated 区域/模块档案数量；生成物由 `tools/check_generated_artifacts.mjs --check` 校验 | 可执行检查 | M6/P2/递归整改 | **PASS（R0–R14 实际运行，见 §30）** |
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

### 12.3 当前测试基建事实（2026-10-28 递归整改后）

- 已安装 jsdom 30.1.3、@testing-library/react 16.3.3、TanStack Router/Query、Zustand、XState v6、RxJS、Zod；测试按源码所有权镜像到 `web_app/tests/{api,application,components,contract,domain,features,integration,performance,realtime,rendering,state,architecture}` + `fixtures/support/types`。
- RQ/CE/ARCH 与产品装配测试真实运行：前端全量 Vitest **104 文件 / 662 测试 PASS**（含 `architecture/architecture-import-graph.test.ts` R0–R6 与 `architecture/architecture-contract-rules.test.ts` R7–R14 及负向 fixtures；默认并发全量 PASS，CPU 密集黄金向量套件统一 `testTimeout: 15s`，断言强度不变）；后端 **170/170 PASS**（递归整改只改前端与文档/工具，后端未变）；真实 Chrome WebGPU 性能门禁证据见 `docs/evidence/`。
- 生成物门禁：`node tools/check_generated_artifacts.mjs --check` 校验 `tools/generated-artifacts.json`（R11），各生成器 `--check` 已并入 `scripts/verify.ps1`。
- 剩余边界：WebSocket 生产传输、SharedArrayBuffer/COOP-COEP、后端非模拟实现；见 §24/§26。

## 13. 文档地图

| 文档 | 内容 | 关联 |
|---|---|---|
| [架构基线](architecture.md)（本文） | 汇总、终态目录、规则 R0–R14、数据流、差距、M0–M6 记录、R-01…R-14 递归整改记录（§30） | ADR-0009/0010 |
| [web_app/README](../web_app/README.md) | 前端目录/命令/镜像式测试布局/门禁入口 | 本文 §4/§30 |
| [scripts/README](../scripts/README.md) | verify.ps1 组成、生成物登记与检查器、R7–R14 门禁、性能脚本 | 本文 §6/§12.3 |
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