# SemiconFab Next：Effect 4 与单层目录重构实施计划

**状态：** 待实施计划。\
**基线：** 远端 `main` 的 `4fc8a94a3f10d185c8bef7929349ac6ccb2b8792`。\
**策略：**
按任务提交、每个任务有明确验收；不建立永久兼容层，不对同一数据双写。

## 1. 当前基线与需要先确认的事实

远端 `main` 的 `web_app/package.json` 当前包含：

-   `@tanstack/react-query@5.105.0`
-   `@tanstack/react-router@1.170.46`
-   `@tanstack/router-plugin@1.168.48`
-   `zustand@5.0.16`
-   `zod@4.6.7`
-   `rxjs@7.8.2`
-   `xstate@6.0.0-alpha.70`
-   `@babylonjs/lite@1.36.0`
-   `react@19.3.1`、`react-dom@19.3.1`

当前 `src` 有 196 个 TypeScript/TSX 文件，存在
`features/twin/state`、`api/queries`、`rendering/lite/geometry`
等多级目录。当前路由依赖 TanStack Router Vite 插件和生成的
`routeTree.gen.ts`。

迁移提案目标为 `effect@4.0.7` 与
`@effect/atom-react@4.0.7`，但它们不在上述远端 `main`
依赖表中。迁移工作树中的变更必须以真实分支、提交和锁文件核验；不得把本地未提交状态视为远端基线。

## 2. 迁移原则

1.  每个任务必须有明确的文件范围、行为契约、测试和退出条件。
2.  结构迁移与状态容器迁移分开提交，先让新目录规则稳定，再迁移数据所有权。
3.  不允许同一资源同时由 Query 和 Atom 作为权威缓存，也不允许同一 UI
    状态同时由 Zustand 与 Atom 双写。
4.  迁移中允许尚未迁移的模块暂时使用旧库，但每个已迁移模块必须完整切换所有权；最终删除所有旧依赖与旧
    API。
5.  不用兼容转发模块延长旧路径寿命。
6.  每个阶段通过 `verify.ps1` 中适用的门禁和阶段测试；浏览器/GPU
    测试单独执行并保存证据。
7.  不把性能改善当作默认结果；必须用同一环境、同一脚本对比基线。
8.  每次涉及 unstable Effect API
    的变更必须由精确锁定版本的类型检查和行为测试证明。

## 3. Task 0：冻结基线与文件归属清单

### 范围

-   保存当前依赖、lockfile、Node/pnpm/.NET SDK 版本信息。
-   运行当前可执行的完整门禁、单元/集成测试、构建和性能基线。
-   输出当前 `src` 文件清单及目标路径映射，逐文件记录
    owner、导入者、测试、生成状态。
-   记录路由 URL、错误行为、资源
    freshness、轮询间隔、命令身份和渲染路径。
-   记录
    `render_perf.mjs`、`test_render_perf.browser.mjs`、`telemetry_stress.mjs`
    及现有性能脚本的实际产物。

### 退出条件

-   每个生产源码文件都有唯一目标路径和 owner。
-   所有无法执行的门禁都记录原因，不得标记 PASS。
-   性能基线包含硬件/浏览器/Node 版本、构建 commit、运行参数和原始
    JSON。
-   对 `global.json` 与当前安装 SDK 的匹配情况作出明确决策。
-   对 pnpm 12.15.0 的预置方式和验收环境是否联网作出明确决策。

## 4. Task 1：单层目录迁移与 code-based routing

### 范围

-   将 `web_app/src` 重构为 `02-flat-source-layout.md`
    定义的一级模块目录。
-   将 `features/catalog`、`features/twin`、`features/workbench` 改为
    `catalog`、`twin`、`workbench`。
-   将 `api/queries`、`api/schemas`、`api/transport`、`api/cache`
    中的文件平铺到 `api/`，使用明确文件名。
-   将 `application/contracts` 迁移至 `contracts/`；按实际所有权迁移
    coordination 和 ports。
-   将 `domain`、`realtime`、`rendering`、`runtime`
    中所有文件移动至对应一级目录。
-   新建单层目录架构门禁和负向 fixture。
-   将 `@/` alias 同步配置到 TypeScript、Vite、Vitest 和 import graph。
-   将 file-based route 改为 code-based route；移除
    `@tanstack/router-plugin`。
-   更新 R0--R14 的路径规则和所有路径敏感测试。
-   保留 Vite 的 server、proxy、build chunking
    和测试参数；只移除文件路由生成插件及相关配置。
-   保留 Twin 页面动态导入，验证构建产物确实分块。

### 必须保留的行为

-   URL：`/`、`/equipment`、`/equipment/compare`、`/fabs/$fabId/3d`。
-   首页 Sites 请求失败由 Workbench 显示可重试 UI。
-   未知 FAB 与加载错误进入路由错误边界。
-   未知 URL 显示 root 404。
-   search 参数、语言/主题 URL 状态、前进/后退。
-   现有 3D 路由动态加载和 Suspense fallback。
-   `defaultPreloadStaleTime: 0` 的集成语义。
-   Babylon Lite 与 WebGPU-only 约束。

### 退出条件

-   `src` 下不存在二级目录。
-   路由树不依赖文件生成插件，所有路径和类型通过测试。
-   `route-tree-generation.test.ts` 已替换为 code-based route tree
    测试。
-   `route-code-splitting.test.ts`
    不再断言文件路由插件配置，而是验证动态导入与实际 chunk。
-   `R14` 不再允许生成路由树中的 `@ts-nocheck`；生产源码扫描默认禁止
    `@ts-nocheck`。
-   无功能性改动遗漏；全量 typecheck、测试和 build 通过。

## 5. Task 2：建立 Effect AppRuntime 与 Registry

### 范围

-   精确锁定 `effect@4.0.7` 与 `@effect/atom-react@4.0.7`。
-   创建唯一 `AppRuntime`、应用级 Scope、Layer/service 组装和单一
    `AtomRegistry`。
-   让 React Provider 和 Router Context 引用同一 AppRuntime/Registry。
-   为测试提供独立 Runtime/Registry 工厂。
-   配置明确的 Registry `defaultIdleTTL`，目标为 300 秒；不依赖 provider
    默认值。
-   建立资源读取 facade 与 Effect 执行边界；业务模块不得散布
    `Effect.run*`。
-   为 Registry、共享 Layer、Scope 和 finalizer 增加生命周期测试。

### 退出条件

-   同一 App 内 React 与 Router 读取同一 Registry。
-   两个独立测试 Registry 的 Atom 状态完全隔离。
-   应用释放时没有遗留 Fiber、订阅、定时器和 Registry 节点。
-   StrictMode 重挂不会创建第二个长期 Runtime。
-   共享 Layer 不会按每个 Atom 重复构建。
-   `Effect.run*` 的使用点落入明确 allowlist。

## 6. Task 3：Effect Schema 与 HTTP transport

### 范围

-   把 Zod Schema 转换为 Effect Schema。
-   将 HTTP transport 的成功解码、HTTP 错误、网络错误、Schema
    错误、身份/协议错误分开建模。
-   将 `AbortSignal`/Effect interruption 传递到底层 fetch。
-   删除所有生产源码的 Zod 导入与旧 Schema 文件。
-   保留 API DTO 的语义和现有错误文案/可恢复性要求。

### 退出条件

-   无生产代码导入 Zod。
-   所有 API 边界对响应执行类型化解码；不得使用 `as`、`String()` 或
    `Number()` 冒充运行时校验。
-   Schema 错误不触发网络重试。
-   取消测试证明底层请求实际收到 abort。
-   生成契约与后端 contract 门禁通过。

## 7. Task 4：Zustand → Atom 与命令状态桥接

### 范围

-   将共享 locale/theme/preference 状态迁移为独立 Atom。
-   将 Catalog、Twin、Workbench Store 按真实订阅粒度拆分为 Feature
    Atom。
-   迁移纯 Reducer/状态转换逻辑；不将大 Store 原样包进一个 Atom。
-   将 `runtimeStore` 按字段所有权拆分为 app lifecycle、Twin
    projection、rendering lifecycle，不做机械转换。
-   建立 XState actor 的 Effect Scope 生命周期、唯一 adapter
    写入口和只读 projection Atom。
-   将命令提交、SSE 事件、恢复结果按同一命令 identity 串行送入 adapter。
-   对 command recovery queue
    实现终态优先保留、可观察驱逐诊断和容量溢出后权威核对。
-   将每 FAB 的权威核对并发上限冻结为 4；同一命令 single-flight。
-   将 `transport-failure`/reconnected/gap 信号纳入明确事件契约，补齐
    EventSource 错误状态处理。

### 退出条件

-   生产源码无 Zustand import；`createSliceStore.ts` 删除。
-   所有已迁移 UI 状态只有 Atom 一个 owner。
-   actor create/start/subscribe/stop/dispose 生命周期测试通过。
-   首个 actor snapshot 不丢失。
-   同一命令 revision 单调、终态不可变。
-   队列 32/256 上限、终态优先、驱逐诊断、合并核对和并发 4
    均有正负测试。
-   Run submission 的 `ScopeToken` 与设备命令的 `(fabId, commandId)`
    /幂等身份严格区分。

## 8. Task 5：TanStack Query → Resource Atom

### 范围

-   将 Sites、Catalog、Runs、Run Results、Wafer Routes、Research Events
    迁移为 Resource Atom。
-   建立 `resource-policy.ts`：集中定义 freshness、idle
    TTL、轮询、重试、失效和取消策略。
-   资源 factory 使用确定的身份键和 `Atom.family`
    等已验证原语，禁止组件临时创建私有资源 Atom。
-   以 `AsyncResult.Success.timestamp` 判断 freshness。
-   `ensureResource` 实现明确的过期检查、单飞刷新和旧成功值保留语义。
-   Router loader 只调用 AppRuntime resource facade，不直接
    fetch，不持有缓存。
-   删除 `QueryClient`、QueryKey 和 Query Provider。
-   对 mutation 成功后的相关资源执行指定 Atom refresh；不增加第二份
    invalidation cache。

### 退出条件

-   生产源码无 `@tanstack/react-query` import。
-   Router hover 预加载 → 点击导航 → 页面挂载只产生一次实际 Sites 请求。
-   freshness 窗口内复用；过期后刷新；并发读取 single-flight。
-   idle TTL 内卸载/重新挂载时，freshness 仍按资源政策判断；不能把 idle
    TTL 当 staleTime。
-   刷新失败保留旧值和类型化错误。
-   轮询仅在 owner Scope 存活时运行；Scope 关闭后停止。
-   30 秒、60 秒、1.5 秒、4 秒和完成后请求的行为均由测试证明。

## 9. Task 6：Effect Stream、SSE/REST 一致性与依赖收尾

### 范围

-   将 RxJS Observable/Subscription 改为 Effect Stream、Scope
    管理或适合高频路径的原生有限队列。
-   `EventSource` 生命周期由 FAB Scope 管理；传输中断、重连和 gap
    信号必须可观察。
-   REST 和 SSE 设备状态帧共用同一个 Gate 和 Snapshot Atom。
-   保留 epoch/sequence 单调性、完整帧校验、FAB 切换顺序和 100 ms UI
    合批。
-   保留 Telemetry Worker generation 隔离、in-flight slot、pending
    合并、有限退避和停止取消。
-   更新
    `realtime-protocol.md`、`rendering.md`、`IMPLEMENTATION-STATUS.md`、`modules/M11.md`、`modules/M12.md`、评审标准、README、scripts
    README 与 ADR 的生效关系。
-   删除旧依赖与不再使用的类型/适配器。
-   修复最终验收依赖的目录门禁、SDK pin 和 pnpm 预置契约。

### 退出条件

-   生产源码无 RxJS import。
-   生产依赖中不存在 Zustand、TanStack
    Query、Zod、RxJS；开发依赖中不再有 router plugin。
-   设备状态 Gate、Telemetry、命令恢复和所有 FAB Scope 测试通过。
-   `verify.ps1` 在约定的干净环境中从头执行成功。
-   真实浏览器功能验收与 GPU 性能验收均有可复核证据。
-   没有永久兼容层、双写、第二资源缓存或旧路径转发文件。

## 10. 版本、工具链与门禁风险

### 10.1 `.NET SDK`

当前远端 `global.json` 固定 `11.0.100-rc.2.26504.105` 且 `rollForward`
为 `disable`。验收环境必须安装该版本，或经过明确决策后同时修改 pin
与验证环境。不能依赖某台机器的未提交 `global.json` 修改。

### 10.2 pnpm

`web_app/package.json` 固定
`pnpm@12.15.0`。验收脚本必须有确定的版本预置方式；不得静默接受全局的其他版本。干净目录
frozen-lockfile 安装是否需要网络必须写入验收前置条件。

### 10.3 `docs/superpowers` 门禁冲突

当前 `tools/check_architecture.py` 把 `docs/superpowers`
视为禁止的遗留路径。迁移计划若继续把现行 spec/plan 放在该目录，最终
`verify.ps1`
将失败。必须先确定该目录是正式资产还是临时迁移资产，再修改文档落点或门禁。不得为了让检查变绿而无条件放宽规则。

### 10.4 架构门禁同步

-   R0 导入图必须支持 `@/` alias。
-   R2 Router 层规则改为 `routes/`。
-   R3 纯领域规则继续严格执行。
-   R4 从 `features/*` 更新为顶层 `catalog/`、`twin/`、`workbench/`。
-   R14 删除生成 route tree 的 cast allowlist，并扫描全仓生产源码
    `@ts-nocheck`。
-   新增单层目录规则、Effect runner allowlist、XState import
    allowlist、单一资源缓存所有权和跨 FAB Scope 负向测试。

## 11. 回滚策略

-   在独立分支/worktree 中执行；`main` 基线保持可构建。
-   每个 Task 完成后形成一个通过相应门禁的提交。
-   结构迁移 Task 与 Effect 迁移 Task 不混成一个不可定位的大提交。
-   最终验收前不合并。
-   失败时回滚到最近一个绿色任务提交，不用运行时 feature flag
    同时维护两套状态容器。
-   不删除基线证据、测试日志或性能结果；重跑结果与 commit SHA 绑定。

## 12. 最终交付物

-   本文档组与正式 ADR/架构规范同步。
-   单层 `src` 目录与自动化负向门禁。
-   code-based router 与 URL/错误行为测试。
-   AppRuntime、AtomRegistry、资源策略和 Effect Schema。
-   所有 Feature Atom、Resource Atom、XState adapter、Effect Stream
    与资源释放实现。
-   旧依赖删除后的 manifest/lockfile。
-   `verify.ps1` 全量日志、浏览器场景 JSON、性能对比报告和未决问题清单。
