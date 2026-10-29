# ADR-0011 — Effect 4 AppRuntime/Resource Atom/Effect Stream 架构

- Status: Accepted (2026-10-29)
- Supersedes: [ADR-0009](0009-tanstack-router-query-boundary.md) 的 TanStack Query 服务端缓存与 routeTree 生成部分；[ADR-0008](0008-redux-toolkit-rtk-query.md) 的剩余状态所有权原则由本 ADR + 目标架构文档重新表述
- Related: [ADR-0010](0010-command-event-bridge.md)（命令桥职责仍成立，输入由 Observable 改为 Effect Stream）
- 权威实施/验收文档：`docs/architecture/README.md`、`01-effect4-target-architecture.md`、`02-flat-source-layout.md`、`03-migration-plan.md`、`04-acceptance-and-architecture-gates.md`
- 证据：`docs/architecture/evidence/effect4-progress.md`、`docs/architecture/evidence/perf/`、`docs/perf/effect4-e2e.json`

## Context

V2.1 使用 TanStack Query 作为唯一 HTTP 缓存、Zustand 作为客户端 UI 状态、RxJS+Zod 处理实时流/解码，并用 `@tanstack/router-plugin` 生成嵌套目录路由树。Effect 4 目标要求：

1. 单一 `ManagedRuntime` + 单一 `AtomRegistry`，副作用/异步/响应式状态统一由 Effect 管理；
2. 严格 `src/<module>/<file>`（无二级目录），因此文件式/生成式路由不可用；
3. 移除 Zustand/TanStack Query/Zod/RxJS/router plugin，不保留兼容层；
4. 远程快照有且只有一个 Resource Atom owner；
5. XState 继续拥有命令生命周期，但 actor/transport/fiber 生命周期由 Effect Scope 管理。

## Decision

1. **AppRuntime**：`app/app-runtime.ts` 创建唯一 `ManagedRuntime` 与 `AtomRegistry`；`AppProviders` 通过 `RegistryContext` 提供同一实例；Router context 只持有 `AppRuntime`。
2. **Resource Atom**：`api/resource.ts` 定义可写 `AsyncResult` Atom + typed Effect loader + freshness/idle TTL/single-flight/previous-value/error 语义；Router loader 与页面共用 `ensureResource`；无 QueryClient/第二缓存。
3. **Effect Schema + HTTP**：`api/*.schema.ts` 与 `api/http.transport.ts` 是所有 REST 契约/传输的唯一入口。
4. **Effect Stream/PubSub**：命令 SSE 适配器把 EventSource 事件转为一条 PubSub 总线上的五路类型化 Stream；`runtime/command-stream.ts` 是唯一 plain-TS Stream consumer 边界；EventSource 由首个/末个 result Stream 消费者懒打开/关闭。
5. **Effect Scope**：XState actor acquire/release、SSE/Stream fiber、命令恢复由 Scope/Effect 资源管理；`runtime/command-workflow-scope.ts` 为登记的组合根边界。
6. **Code-based router**：`routes/route-tree.ts` 显式组合路由；URL/search/404/error 语义保持不变；无 routeTree 生成物与 router plugin。
7. **单层目录**：`src/main.tsx` + 15 个模块目录；`source-layout.test.ts` 与负向 fixture 强制。
8. **设备状态**：REST/SSE 共用一个 per-registry 顺序 Gate；快照只写 FAB 作用域 Resource Atom；gate 只存 epoch/sequence。
9. **高频数据**：遥测 TypedArray/Worker/Babylon 对象不进入 AtomRegistry；100ms UI 合批保留。

## Consequences

- 旧依赖与旧路径清零；`verify.ps1` 增加 legacy/resource/effect-runner/source-layout 门禁。
- 浏览器 e2e（Chrome CDP）成为 A3 可执行证据；render/telemetry/bundle 工具构成 A4 证据。
- 迁移期间发现并修复 catalog 视图切换 URL 回写竞态（旧 catalog 路由 replace 导航取消 Compare 路由导航）。
- 真实 WebSocket/设备丢失硬件注入/长时内存仍为边界；文档与证据中显式记录，不冒充已验证。
