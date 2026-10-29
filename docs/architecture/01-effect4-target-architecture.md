# Effect 4 目标架构与数据所有权规范

> **历史文档（第二轮“正确性优先”重构起）：** 本文所属的 effect4 实施已完成并归档；与
> `05-correctness-first-target-spec.md`、`06`–`09` 冲突的资源/命令/恢复/编译器描述以新规范
> 为准。本文保留为历史证据，不再作为当前架构事实来源。

**状态：** 目标设计，待实施与验收。\
**基线提交：** `4fc8a94a3f10d185c8bef7929349ac6ccb2b8792`。\
**目标依赖版本：**
`effect@4.0.7`、`@effect/atom-react@4.0.7`；此版本组合必须在实现分支上通过
API、类型和行为验证。

## 1. 目标与非目标

### 1.1 目标

-   以 Effect 4 统一管理异步任务、副作用、取消、资源作用域和错误通道。
-   以单个应用级 `AtomRegistry`
    作为客户端响应式状态与远程资源快照的唯一注册表。
-   保证 TanStack Router 预加载与 React 订阅复用同一资源 Atom 和同一
    Registry。
-   保留现有 URL、路由错误语义、资源新鲜度、轮询间隔、命令身份、FAB
    隔离和 WebGPU 数据路径。
-   将 `web_app/src`
    固定为单层模块目录，使用架构测试禁止未来重新引入嵌套目录。
-   在删除旧依赖前，逐项证明新实现拥有相同或经过明确批准的新行为。

### 1.2 非目标

-   不改变 ASP.NET Core API、数据库、认证和服务端持久化边界。
-   不把 XState 替换成 Effect；XState 继续拥有设备命令状态机。
-   不把 Babylon Lite 对象、GPU 资源、逐帧状态或 TypedArray 放入 Atom。
-   不增加第二个通用缓存系统，不复制 QueryClient，也不实现 Zustand/Query
    的兼容 API。
-   不以"测试通过"替代真实浏览器与 GPU 验收。

## 2. 技术决策

  ------------------------------------------------------------------------------------------------------------------------------
  技术                        目标职责                                                      决策
  --------------------------- ------------------------------------------------------------- ------------------------------------
  Effect 4                    Effect、Layer、Scope、Fiber、Stream、PubSub、取消和错误模型   引入

  `@effect/atom-react`        Atom、AtomRegistry、AsyncResult、React Hooks                  引入；接受 unstable API

  Effect Schema               网络边界解码与运行时验证                                      取代 Zod

  TanStack Router             URL、路由匹配、导航、loader 和错误边界                        保留；改为 code-based routing

  React                       组件与渲染                                                    保留

  XState 6 Alpha              设备命令状态机                                                保留；只允许 runtime adapter 导入

  Babylon Lite                3D 引擎                                                       保留；WebGPU-only

  Zustand                     客户端状态容器                                                删除

  TanStack Query              远程资源缓存                                                  删除

  RxJS                        通用 Observable/Subscription                                  删除；以 Effect Stream 或原生 Worker
                                                                                            通道按场景替代

  Zod                         网络数据校验                                                  删除

  `@tanstack/router-plugin`   文件式路由树生成                                              移除，因为目标目录禁止嵌套路由文件
  ------------------------------------------------------------------------------------------------------------------------------

`@tanstack/react-router`
版本仍须精确锁定，并确保锁文件只有一个实际解析版本。若
`@effect/atom-react` 的 peer 依赖需要 `scheduler`，应验证单一解析版本与
peer 范围；不要在没有直接导入需求时人为增加直接依赖。

## 3. 目标层次与依赖方向

``` text
React UI / TanStack Router
          |
          v
App composition root
          |
          +---- AppRuntime / AtomRegistry / Effect services
          |
          +---- routes ----> api resource entry points
          |
          +---- catalog / twin / workbench
          |          |
          |          +---- api resources / runtime contracts / domain
          |
          +---- runtime ----> contracts + realtime + XState adapter
          |
          +---- realtime ----> transport / protocol / gate / Worker
          |
          +---- rendering ----> Babylon Lite / WebGPU
```

依赖方向规则：

1.  `domain` 只允许依赖 `domain`
    内的纯模块、明确的数据契约和纯数据资产；禁止
    React、Effect、网络、Router、XState、AtomRegistry、Worker
    全局和引擎对象。
2.  `routes` 只负责路径参数、search schema、loader
    协调、路由组件装配与错误语义；不直接构造 HTTP
    请求，也不持有资源缓存。
3.  `api` 负责 HTTP transport、Schema、资源 Atom 和
    mutation；不依赖具体页面。
4.  `runtime` 负责 FAB 生命周期、命令工作流装配、事件桥接和权威核对。
5.  `realtime` 负责传输、协议、顺序门、事件流与 Worker 数据通道；不依赖
    React 页面。
6.  `rendering` 只负责 Babylon Lite 与 WebGPU；不依赖 Atom、React
    Query、Zustand、XState 或 Effect 的高频执行 API。
7.  `catalog`、`twin`、`workbench` 不允许直接互相导入。跨 Feature
    协作必须通过明确的 `contracts` 或 `runtime` 入口。
8.  `app` 是组合根，负责构造并注入依赖；业务模块不得自行创建全局 Runtime
    或 Registry。

## 4. 唯一所有权模型

  -------------------------------------------------------------------------------------------------------------------
  状态类别          唯一所有者                       允许的消费者                    禁止的副本
  ----------------- -------------------------------- ------------------------------- --------------------------------
  服务器资源快照    `AtomRegistry` 中对应 Resource   Router loader、React、业务服务  第二个
                    Atom                                                             Map/缓存、组件长期副本、其他
                                                                                     Atom 中的复制快照

  UI 交互状态       组件局部 state 或领域归属的 Atom 同一页面或 Feature              全局巨型 Atom、跨 Feature
                                                                                     直接写入

  URL/search        TanStack Router                  路由和页面                      在 Atom 中复制一份作为权威

  设备命令状态      XState actor，经                 Workbench、命令面板、恢复流程   Query 或 UI Atom
                    `CommandWorkflow` 投影暴露                                       作为第二权威状态机

  设备状态快照      通过统一顺序门验收后写入的       Twin 低频投影、HUD              REST 和 SSE 各自维护的快照缓存
                    Snapshot Atom                                                    

  顺序高水位        对应 `(siteId, fabId)` 的 Gate   REST/SSE 验收入口               与快照相同内容的第二份数据存储

  高频遥测          Worker、TypedArray、有限缓冲区   渲染帧循环和低频投影            AtomRegistry、React
                                                                                     state、XState

  Babylon 场景与    Rendering Runtime                渲染模块和受控 ScenePort        任意 Atom、业务 store 或 API
  GPU 对象                                                                           缓存
  -------------------------------------------------------------------------------------------------------------------

"单一所有权"不是禁止派生值，而是禁止把派生结果长期保存为另一份权威快照。Gate
的 epoch/sequence
等控制元数据不属于服务器数据快照，不得被当成第二份快照缓存。

## 5. AppRuntime 与 AtomRegistry 生命周期

### 5.1 应用级组合根

`AppRuntime` 必须由应用入口创建一次，至少拥有：

-   一个 `AtomRegistry`；
-   一套共享 Effect services / Layer；
-   一个应用级 Scope；
-   资源读取、刷新和路由 loader 可调用的 typed facade；
-   统一的 dispose 入口。

React、Router loader 和资源模块必须引用同一
`AppRuntime`。测试创建独立实例，禁止共享测试全局 Registry。

不要在 React render 函数中创建 Registry，也不要让 `RegistryProvider`
的默认值成为应用缓存保留策略。若使用 `RegistryContext.Provider`
注入已创建的 Registry，必须验证 provider 生命周期与 Registry dispose
的对应关系。应用退出时，先停止应用级任务和订阅，再释放 Registry
与其节点资源。

### 5.2 Effect Runtime / Layer

-   共享 Layer 应只构建一次，并由明确的组合根或 Registry 级 runtime
    factory 管理。
-   共享依赖的 memoization 归属必须明确；不得在每个资源 Atom
    内重新构造同一套全局服务。
-   只有应用组合根和明确批准的 React/Router 适配边界可以执行
    `Effect.run*`。业务模块导出 Effect，不自行创建无主 Fiber。
-   `Effect.run*`、`Effect.fork*`、`Effect.scoped` 等调用必须有架构
    allowlist 和生命周期测试。
-   每个可长期运行的 Fiber 必须有 owner Scope；Scope 关闭时必须中断
    Fiber 并运行 finalizer。

### 5.3 FAB Scope

每个活动 FAB 的运行时有独立 Scope，包含：

-   FAB 级命令 EventSource；
-   FAB 级 Telemetry Runtime / Worker；
-   FAB 级命令关联、恢复队列与 workflow registry；
-   FAB 级设备状态 Gate；
-   该 FAB 的定时刷新和重连任务。

FAB 释放时，按确定顺序停止接收事件、取消计时器与待处理批次、关闭
EventSource、停止 Worker、停止 actor、释放 Atom/订阅和清理 FAB
投影。不得通过清空应用级 Registry 来代替 FAB 级释放。

## 6. Resource Atom 契约

### 6.1 资源身份

每类资源必须有单一的资源定义和明确身份：

-   Sites：应用级资源，按 API 契约决定是否有额外身份维度。
-   Catalog：资源定义集中于 `api`；筛选、分页和排序条件属于 URL 或 UI
    状态，不得复制服务器快照。
-   Runs 列表、Run 详情、Run Results：详情与结果必须使用明确的 Run
    ID；若数据在产品语义上受 Site/FAB 限定，资源身份必须包含相应的
    `siteId` / `fabId`。
-   Equipment Status：复合身份至少包含 `(siteId, fabId)`。
-   Wafer Routes、Research
    Events：按真实资源契约确定静态/版本化身份，不允许任意组件创建私有副本。

资源 Atom 应使用确定的 key/family 工厂，禁止由每个组件临时创建不同 Atom
实例。FAB 相关资源必须能证明跨 FAB 不共享快照。

### 6.2 `AsyncResult` 与刷新状态

资源对 UI 暴露 `Atom<AsyncResult<T, E>>` 或经过严格定义的等价类型。UI
必须区分：

-   初次读取且没有旧值；
-   首次加载中；
-   已成功且未刷新；
-   已有成功值、刷新进行中；
-   刷新失败但存在上一次成功值；
-   从未成功且当前失败。

Effect `AsyncResult` 的 `Success` 带 `timestamp`，`Failure` 可携带
`previousSuccess`。渲染逻辑应使用这些语义，不得另建
`lastSuccessfulValue` Map 保存第二份快照。

### 6.3 Freshness 与 idle TTL 是两个独立策略

-   **Freshness** 决定何时重新验证数据。
-   **Idle TTL** 决定没有订阅者时 Atom 在 Registry 中保留多久。

仅配置 `Atom.swr({ staleTime })` 不能作为"React 重新挂载或 Router
导航时必然重新检查 freshness"的证明。资源读取入口必须显式调用项目定义的
`ensureResource` 契约：

1.  读取当前 `AsyncResult`。
2.  若无成功值，执行首次加载并等待结果。
3.  若成功值仍在 freshness 窗口内，复用现有值。
4.  若已过期，通过同一 Registry 刷新该资源。
5.  同一资源同一时刻只允许一个请求；并发消费者等待同一执行结果。
6.  刷新失败时保留旧成功值和类型化错误，不能将旧值伪装成新鲜数据。
7.  取消请求必须中断底层 `fetch`；已失效的 FAB/页面 Scope 不得写入新
    Scope 的状态。

`ensureResource`
是资源策略适配器，不是第二份缓存；不得把资源结果复制到另一个 Map。

### 6.4 目标缓存与刷新策略

以下是需在实施阶段对照当前 Query 配置并由测试冻结的目标值：

  ----------------------------------------------------------------------------------------------
  资源                    目标行为                必须验证
  ----------------------- ----------------------- ----------------------------------------------
  Sites                   freshness 30            首次加载、过期刷新、失败重试、Router/React
                          秒；失败可由 Workbench  共用请求
                          明确重试                

  Catalog                 freshness 60 秒         筛选 URL 与服务器快照分离；并发读取去重

  Runs 列表               每 1.5 秒刷新           只在资源活跃且策略要求时刷新；卸载后释放任务

  Run 详情                每 1.5 秒刷新           按 Run ID 归属；不串身份

  Run Results             Run 完成后才启用读取    未完成前不请求；完成后请求一次并按策略刷新

  Equipment Status REST   每 4 秒轮询             所有 REST 帧经过同一 Gate

  Equipment Status SSE    实时推送                与 REST 使用同一 Gate 和 Snapshot Atom

  Wafer Routes            静态/版本化资源；idle   不订阅时可回收；重新挂载时遵循 freshness 规则
                          TTL 10 分钟             

  Research Events         静态/版本化资源；idle   不订阅时可回收；重新挂载时遵循 freshness 规则
                          TTL 10 分钟             
  ----------------------------------------------------------------------------------------------

应用级 `defaultIdleTTL` 设为明确值（目标 300 秒）；Wafer Routes 与
Research Events 等资源按表显式设置 600 秒。不要依赖 provider
默认值。若基线配置与表中目标存在差异，必须在实现前把差异列入决策记录，不能静默更改。

### 6.5 重试

重试策略按错误类型定义，而不是全局对所有失败重试：

-   只对明确可重试的网络错误和指定 HTTP 服务器错误重试一次（Sites
    的目标策略）。
-   Schema 解码错误、身份不匹配、协议错误、普通 4xx 不自动重试。
-   设备状态顺序门拒绝的旧帧不能通过重试绕过 Gate。
-   重试、刷新和轮询必须有上限；不存在无界重试循环。

## 7. Router 与资源层

### 7.1 目标路由

保留现有 canonical URLs：

  --------------------------------------------------------------------------
  URL                                 行为约束
  ----------------------------------- --------------------------------------
  `/`                                 预热 Sites；Sites 加载失败由 Workbench
                                      显示可重试错误，不升级成全屏路由错误

  `/equipment`                        设备目录页；search 参数由 Router
                                      schema 验证

  `/equipment/compare`                目录比较页；保留筛选和前进/后退行为

  `/fabs/$fabId/3d`                   loader 验证 FAB 身份；未知 FAB
                                      或必要数据加载失败进入 root error
                                      boundary

  未知 URL                            root `notFoundComponent` 显示 404
  --------------------------------------------------------------------------

### 7.2 共享资源流程

Router loader 不直接 `fetch`，不维护资源快照，不自行创建
Registry。loader 调用 `AppRuntime` 暴露的资源 facade；该 facade 通过唯一
Registry 读取或刷新资源 Atom。

必须通过自动化测试证明：hover/intent 预加载 → 点击导航 → React
挂载，同一个 Sites 资源只发出一次实际请求，页面读取的就是 loader
预热的那份 Atom 状态。

`defaultPreloadStaleTime: 0` 是当前
Router/外部缓存集成的既有约束。迁移后应重新验证其在 code-based routing
中仍被保留，但 freshness 的决定权属于资源层。

### 7.3 为什么必须使用 code-based routing

当前项目使用 TanStack Router
文件式路由，路由文件路径本身包含多级目录。严格禁止 `src`
嵌套目录与文件式路由的目录约定直接冲突。因此目标架构使用 code-based
routing，以平铺的 `routes/` 文件声明路由，再通过 `addChildren` 显式构造
route tree。

这是一项为满足项目硬性目录约束而作出的明确选择。TanStack
官方文档通常推荐 file-based routing；因此 code-based routing
需要补足路由树、类型注册、路径覆盖、404、错误边界和 code-splitting
测试。

## 8. REST + SSE 设备状态一致性

### 8.1 单一接受入口

REST 和 SSE 的设备状态帧都必须经过同一个 `EquipmentStatusGate`。只有
Gate 接受的完整帧才能更新唯一的 Equipment Snapshot Atom。

Gate 校验至少包括：

-   `siteId` 与 `fabId` 与当前 Scope 相符；
-   帧结构完整，工具数量符合领域布局契约；
-   显式 `epoch` 帧必须带有效 `sequence`；
-   更高 epoch 开启新代；同一 epoch 内 sequence 严格递增；
-   低 epoch、旧 sequence 或身份不匹配帧不能覆盖当前快照；
-   已接受显式 epoch 后，缺少 epoch/sequence
    的旧格式帧不能使高水位倒退。

Gate 只保留顺序控制元数据，不另存完整快照。

### 8.2 FAB 切换顺序

FAB 切换必须遵循以下不可重排的步骤：

1.  取消旧 FAB 的待处理合批。
2.  停止旧 Scope 的数据写入。
3.  激活新 FAB 的 Gate，并以该 Scope 已接受的快照播种高水位。
4.  清空旧 FAB 的 UI 投影。
5.  允许新 Scope 的接受帧进入投影。
6.  所有异步回调校验 Scope identity；旧回调不能写入新 FAB。

设备状态 UI 投影维持 100 ms 合批。高频 Telemetry Worker
通道保持独立，不因为 Snapshot Atom 更新而逐帧触发整页 React 渲染。

## 9. XState、Effect 与命令恢复

### 9.1 所有权

-   XState actor 是单条设备命令的业务状态权威。
-   `XStateCommandWorkflowAdapter` 是 actor 的唯一写入入口；外部不得直接
    `actor.send`。
-   Effect 负责 actor
    创建/释放、订阅、命令异步操作、取消、串行队列和恢复任务。
-   Atom 只保存可观察的只读投影，不复制 actor 的完整业务上下文。
-   Actor、projection 和订阅均由同一个命令/FAB Scope 管理。

### 9.2 Actor 生命周期与首帧

创建 actor 时必须避免丢失初始投影：

1.  创建 actor。
2.  从 `getSnapshot()` 读取并播种初始 projection。
3.  建立订阅，再启动 actor；或者采用经过测试的等价顺序。
4.  每次 snapshot 变化通过唯一 adapter 更新 projection Atom。
5.  Scope 关闭时退订、停止 actor，并使旧 projection 不再被读取。

由于 `subscribe` 不应被假定会自动重放当前
snapshot，必须有首帧测试。还必须测试 React StrictMode
下挂载、卸载和重新挂载不会留下 actor、订阅或定时器。

### 9.3 单写入者与事件顺序

提交响应、SSE 事件、权威核对结果和恢复队列重放都必须进入同一个受控
adapter。对于同一个 `(fabId, commandId)`，事件按单写入者规则串行应用：

-   revision 必须严格递增；
-   旧 revision 和重复 revision 幂等忽略；
-   终态不可回退；
-   同一命令的权威核对只能有一个 in-flight 请求；
-   不同命令的核对使用有界并发；
-   旧 FAB 的异步结果不得应用到新 FAB。

### 9.4 身份与幂等键不能混用

Run 提交与设备命令是不同链路：

-   **Run 提交：** 同一逻辑请求重试复用原
    `Idempotency-Key`；新逻辑提交生成新 key。`ScopeToken` 用于阻止过期
    UI/请求作用域写入新状态。
-   **设备命令：** 身份至少使用 `(fabId, commandId)`，并保留设备命令 API
    已定义的幂等身份（当前设计以 `[siteId, fabId, equipmentId, action]`
    为核心）。除非 API 契约明确要求，不把 Run 的 `ScopeToken`
    机械地加到设备命令身份中。

### 9.5 有界恢复队列

目标约束：

-   每命令最多保留 32 个待重放 revision。
-   每 FAB 的全局 pending replay queue 上限为 256 个事件。
-   重复 revision 不增加队列容量。
-   驱逐优先移除非终态事件；终态事件优先保留。
-   所有驱逐均更新可观察计数并发出诊断信号；不得静默丢弃终态。
-   如果发生容量驱逐，触发同一 FAB 的合并权威核对；同一命令的核对
    single-flight。
-   每 FAB 同时最多 4 个不同命令进行权威核对。
-   队列容量 256 指 pending replay queue，不等于独立的 SSE transport
    buffer。没有需求与测试前不得再造一个容量同为 256 的第二队列。

当前代码的全局 FIFO 驱逐、无消费者的 `droppedCount` 和 `Promise.all`
无界核对不满足以上目标。以上是需要实现的新契约，不得写成"现有行为已保留"。

### 9.6 传输状态

目标命令事件契约必须能够区分命令结果、重连、检测到的 gap
与传输失败/中断。`EventSource.onerror`
不得被无条件吞掉；应更新连接状态并在恢复后触发有界权威核对。不得把传输中断伪装成命令失败或成功。

## 10. Telemetry 与 Babylon Lite

-   SSE → Worker → 有界 TypedArray/slot buffer →
    渲染消费的高频路径继续独立于 AtomRegistry。
-   继续保留 Worker generation 隔离、连接级序号重置、单 in-flight
    槽位合并和有界退避策略。
-   低频状态摘要可以写入 Atom，但必须合批；禁止每个原始遥测帧更新 React
    Atom。
-   Babylon Lite 是唯一渲染引擎；不使用 Babylon Full，不引入 WebGL
    fallback。
-   Rendering Runtime 拥有 scene、mesh、material、GPU buffer、camera
    与引擎句柄；通过受控 ScenePort 暴露必要操作。
-   Effect 不进入每帧渲染循环。Effect
    只管理可界定的资源生命周期、异步初始化、取消和故障恢复。

## 11. 错误与取消

-   HTTP transport 将网络错误、HTTP 状态错误、Schema
    错误和身份/协议错误映射为不同的类型化错误。
-   Effect 中断必须传递到真实 `fetch`
    请求；中断不能只停止等待者而让网络任务无主运行。
-   Route loader 的错误必须按路径语义处理；不得把所有失败转成空数据。
-   设备命令状态只能由 XState 工作流和权威核对更新；HTTP
    失败本身不代表设备命令已失败。
-   重试必须受错误类型、次数和生命周期限制。
-   每一个
    `EventSource`、Worker、计时器、Fiber、actor、订阅和合批器都必须有唯一
    owner 和可验证的释放路径。

## 12. 依赖与版本纪律

目标 runtime 依赖：

-   `effect@4.0.7`
-   `@effect/atom-react@4.0.7`
-   `react@19.3.1`
-   `react-dom@19.3.1`
-   `@tanstack/react-router@1.170.46`
-   `xstate@6.0.0-alpha.70`
-   `@babylonjs/lite@1.36.0`

上表是迁移提案的目标组合，不是当前远端 `main`
的依赖状态。实施前必须确认所有精确版本可安装、API 可编译，并把 lockfile
与 manifest 一并提交。不得使用 `^` 或 `~` 替代已冻结的精确版本。

迁移完成后，生产源码不得再导入：

-   `zustand`
-   `@tanstack/react-query`
-   `zod`
-   `rxjs`

若项目保留
`@tanstack/router-plugin`，则说明仍存在文件式路由工具链，与本文的
code-based routing 目标不一致；最终应删除并检查 lockfile 中的传递依赖。

## 13. 官方 API 参考与版本注意

-   [Effect Atom
    API](https://effect.website/docs/v4/api/effect/reactivity/Atom)
-   [Effect AsyncResult
    API](https://effect.website/docs/v4/api/effect/reactivity/AsyncResult)
-   [Effect Atom React
    RegistryContext](https://effect.website/docs/v4/api/atom-react/RegistryContext)
-   [Effect Atom React
    Hooks](https://effect.website/docs/v4/api/atom-react/Hooks)
-   [TanStack Router Code-Based
    Routing](https://tanstack.com/router/latest/docs/routing/code-based-routing)
-   [TanStack Router Creating a
    Router](https://tanstack.com/router/latest/docs/guide/creating-a-router)
-   [TanStack Router Code
    Splitting](https://tanstack.com/router/latest/docs/guide/code-splitting)

Effect Atom / React Hooks 在官方文档中标注为
unstable。官方网页文档可能与锁定的 `4.0.7`
补丁版本不同；最终契约以实际安装包的声明、实现、测试和冻结的 lockfile
为准。
