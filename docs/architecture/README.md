# SemiconFab Next：Effect 4 与单层源码目录重构（已实施）

**状态：** 2026-10-29 起进入第二轮“正确性优先”重构：Phase A 已冻结新目标规范 `05-correctness-first-target-spec.md` 与 ADR-006/007/008/09；`01`–`04` 中与新规范冲突的资源/命令/恢复描述以 `05`–`09` 为准。Task 0–7（`refactor/effect4-flat-20261029`）的 726 PASS 仅作历史证据，不再代表新架构已通过。
**基线：** 远端 `main` 的 `4fc8a94a3f10d185c8bef7929349ac6ccb2b8792`（独立 worktree `.local/worktrees/effect4-baseline` 仅用于 A/B）。
**范围：** 仅 `web_app` 前端；后端不变，Babylon Lite + WebGPU-only 产品约束不变。
**验收证据：** `docs/architecture/evidence/`；浏览器 e2e：`docs/perf/effect4-e2e.json`；性能/GPU：`docs/architecture/evidence/perf/`。

## 文档地图

| 文档 | 用途 |
|---|---|
| `01-effect4-target-architecture.md` | 目标架构、状态所有权、Effect Runtime、Resource Atom、实时数据与 XState 契约 |
| `02-flat-source-layout.md` | `web_app/src` 严格单层目录、命名规则、旧路径映射与 code-based routing |
| `03-migration-plan.md` | Task 0–6 的实际执行顺序、边界与回滚策略 |
| `04-acceptance-and-architecture-gates.md` | A0–A4 验收矩阵、自动化门禁、负向测试与最终签收清单 |
| `evidence/effect4-progress.md` | Task/提交/证据索引 |
| `evidence/effect4-task*.md` | 每个任务的执行证据 |
| `evidence/effect4-task6-browser-e2e.md` | A3 浏览器 10 场景结果与修复记录 |
| `evidence/effect4-task6-performance-a4.md` | A4 渲染/遥测/bundle/连接/render 指标与 A0–A4 对照 |
| `evidence/effect4-task6-rxjs-removal.md` | RxJS→Effect Stream/PubSub 迁移证据 |
| `evidence/effect4-task7-react-compiler.md` | Rust/Oxc React Compiler 接入、规则修复、A/B 与边界 |
| `reviews/2026-10-29-effect-consolidation-design-review.md` | 方案评审历史（不作为当前事实） |
| `05-correctness-first-target-spec.md` | 第二轮重构冻结规范（正确性优先） |
| `06-adr-resource-state-machine.md` | ADR-006：资源身份、状态机、提交协议（Phase B 冻结接口） |
| `07-adr-scope-identity-model.md` | ADR-007：Scope 树、身份模型、调度器/有界流/唯一投影（Phase C 冻结接口） |
| `08-adr-command-durable-recovery.md` | ADR-008：后端持久恢复与权威契约（Phase D 冻结接口） |
| `09-gap-register-and-gates.md` | 缺口登记 G01–G20、阶段门禁、环境约束 |

## 已实施的核心决定

1. `effect@4.0.7` + `@effect/atom-react@4.0.7` 负责应用副作用、异步执行与响应式状态；`ManagedRuntime` 只在 `app/app-runtime.ts` 创建一次。
2. 一个应用一个 `AtomRegistry`；Router context 与 React 树共用同一 `AppRuntime`。
3. 已删除 Zustand、TanStack Query、Zod、RxJS 与 `@tanstack/router-plugin`；没有兼容层、双写或第二资源缓存。
4. 保留 TanStack Router（**code-based**，无 routeTree 生成插件）、React 19、XState 6 Alpha、Babylon Lite/WebGPU；构建期 React Compiler 使用 Oxc/Rust（experimental），不引入 Babel Compiler。
5. `web_app/src` 严格 `src/<module>/<file>`：允许模块 `api app catalog components contracts domain generated lib localization realtime rendering routes runtime state twin workbench`，根只允许 `main.tsx`；无二级目录。
6. 远程快照唯一 owner 为 Resource Atom（`api/resource.ts`）：`AsyncResult` + freshness/idle TTL/single-flight/错误保留/取消；Router loader 与页面共享 `ensureResource`。
7. XState 仍拥有命令生命周期；Effect Scope 管理 actor acquire/release，命令事件经 Effect PubSub/Stream 进入 bridge；Flux/Redux/Query/RxJS 均不再参与命令状态。
8. 高频遥测/TypedArray/Worker/Babylon 引擎对象不进入 AtomRegistry；100ms UI 合批与 FAB Scope 顺序语义保留。
9. 设备状态 REST 与 SSE 共用一个 per-registry 顺序 Gate；gate 只保存 epoch/sequence，快照存储只属于 FAB 作用域 Resource Atom。

## 当前布局（实际树）

```text
web_app/src/
  main.tsx
  api/          resource-policy.ts resource.ts use-resource.ts *.resource.ts *.schema.ts http.transport.ts
  app/          app-runtime.ts app-runtime-provider.tsx app-providers.tsx runtime-bootstrap.tsx
  catalog/      catalog page/atoms/controllers/import/export
  components/   shared UI primitives
  contracts/    command contracts / gateway / workflow / scene port
  domain/       pure domain logic (no React/Effect/network)
  generated/    generated static-structure data
  lib/          generic primitives
  localization/
  realtime/     SSE/PubSub Streams, telemetry worker, equipment-status gate
  rendering/    Babylon Lite + WebGPU backend
  routes/       code-based route tree, route-data loaders, search schema
  runtime/      FabRuntime/Factory/Registry, command bridge, XState adapter, Effect Scope
  state/        UI Effect atoms
  twin/         Twin page and HUDs
  workbench/    Workbench page/controllers
```

## 依赖与门禁（当前）

- 生产依赖：`@babylonjs/lite`、`@effect/atom-react`、`@tanstack/react-router`、`effect`、`react`、`react-dom`、`xstate`。
- 开发依赖补充：`oxc-transform-react@0.156.0`（React Compiler）、`oxlint@1.90.0`（correctness 门禁）；无 Babel React Compiler 依赖。
- 旧依赖 gate：`web_app/tests/architecture/legacy-dependency-gate.test.ts`（Zod/Zustand/TanStack Query/RxJS 在源码/manifest/lockfile 均为零）。
- Effect 边界：`effect-runtime-boundary.test.ts`（runner/registry/ManagedRuntime/RegistryContext 白名单）。
- 单层目录：`source-layout.test.ts`；资源所有权：`resource-ownership.test.ts`；导入图/契约：`architecture-import-graph.test.ts`、`architecture-contract-rules.test.ts`。
- 工具链：`scripts/verify.ps1`（Node/pnpm/.NET SDK 固定；pnpm `12.15.0` 由 `start-dev.ps1` 预置）。
- 浏览器功能：`pnpm e2e` → `tools/e2e_functional.mjs` + `scripts/e2e.ps1` → `docs/perf/effect4-e2e.json`。
- React Compiler：`pnpm lint` + `tests/architecture/oxc-react-compiler.test.ts`（直接 transform fixture + Vite/Oxlint 配置门禁）纳入 `verify.ps1`。
- 性能/GPU：`tools/render_perf.mjs`、`tools/telemetry_stress.mjs`、`tools/bundle_metrics.mjs`；A/B 原始 JSON 在 `evidence/perf/`。

## 验收边界（如实记录）

- 开发数据只有 1 个 FAB；跨 FAB 隔离由单元/集成测试覆盖，浏览器 S7 的跨 FAB 场景记为限制。
- GPU 设备丢失未做真实硬件注入端到端验证；由渲染生命周期测试覆盖。
- 长时 heap 仅记录 600 帧窗口；非分钟级稳定性测试。
- 生产构建产物已测量（raw/gzip），浏览器功能与性能基线使用 Vite dev server。
- 不 push、不 merge；任务按提交逐项记录在 `evidence/effect4-progress.md`。