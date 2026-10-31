# SemiconFab Next：Effect 4 与单层源码目录重构（已实施）

**状态：** 2026-10-30 完成 Round 4 源码整改（R4-01…R4-09，输入为 Round 4 复审报告）：生产代码/契约/ADR/测试 fixture 已修改，整改与验证记录见 `17-round4-remediation-record.md`。本轮实际运行了 typecheck/lint/Vitest/vite build、3 个 .NET 项目 Release build + dotnet test（226 passed）及契约/生成物/架构/frozen-assets/Python tools 源码门禁；**未运行**浏览器 E2E、GPU 600s soak、Oxc ON/OFF 生产等价与完整 `scripts/verify.ps1`。Round 3 的静态整改记录见 `15/16`；Round 3 阶段本身未运行测试。Round 5 源码整改已提交 `4c8f0c1`；Round 5.1 的剩余 P1/P2 不变量整改规范/记录见 `19-round5.1-remediation-specification.md`（2026-10-30）。Round 5.1 独立复审为「暂不通过」（3×P1 + 2×P2），Round 5.2 定向修复 Correlation applied 身份、Transport ACK 完整身份/权威 Supersede、CORE-011 独立双后端实验与三游标数学契约，规范见 `20-round5.2-remediation-specification.md`，完整 `scripts/verify.ps1` 在 `a7ef24b` 通过（Vitest 157 文件/1004 测试、.NET 226、production e2e 9/9、CORE-011 equal=true/differences=0），证据见 `evidence/round5.2-verification.md`。
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
| `10-adr-command-cursor-ack-protocol.md` | ADR-010：命令事件 observed/delivered/acknowledged 游标、dirty 缺口与恢复状态机（CR-01/02/06） |
| `11-adr-cancellable-gateway-timeout.md` | ADR-011：原生可取消 Effect Gateway、调度器真实超时与物理请求预算（CR-04/08） |
| `12-adr-transactional-command-persistence.md` | ADR-012：SQLite WAL 事务化存储、唯一幂等、epoch journal 与故障注入（CR-03） |
| `13-adr-resource-commit-identity-capacity.md` | ADR-013：通用资源 superseded-write、类型化身份、单一容量、轮询 generation（CR-05/07/09/10） |
| `14-round2-remediation-matrix.md` | Round 2 缺陷→阶段→验收矩阵与执行记录 |
| `15-round3-static-remediation-spec.md` | Round 3 静态整改规范（R3-01…R3-11，代码先行/暂不测试） |
| `16-round3-static-review.md` | Round 3 逐文件静态审查记录、状态机/所有权表与推迟验证项 |
| `17-round4-remediation-record.md` | Round 4（R4-01…R4-09）源码整改设计、契约变化、验证结果与未完成边界 |
| `18-round5-remediation-specification.md` | Round 5 整改规范与验收要求（已实施 4c8f0c1；历史记录，剩余义务由 19 号规范取代） |
| `19-round5.1-remediation-specification.md` | Round 5.1 剩余 P1/P2 不变量整改规范与记录（P1-01…P2-04、四协议流程、Phase A/B/C 验收；2026-10-30） |
| `20-round5.2-remediation-specification.md` | Round 5.2 定向整改（独立复审 P1-01…P1-03 / P2-01 / P2-02）：outcome 证明链、ACK 完整身份 + supersede、CORE-011 双后端隔离、三游标数学修正（2026-10-30） |
| `22-adr-twin-process-runtime.md` | ADR-022：Twin Tour 的 XState 状态所有权、Effect Scope、RAF 驱动与 Atom 投影契约 |
| `23-adr-twin-wafer-runtime.md` | ADR-023：Wafer Playback 的 XState 状态机、Effect Scope、单 RAF、命令式场景帧与 Atom 投影契约 |

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
10. Twin Tour 已采用独立 XState Actor + TwinTourRuntime：Effect child Scope 管理 Actor/RAF/Timeline，twinTourAtom 仅保存只读投影。
11. Twin Wafer Playback 已采用独立 XState Actor + TwinWaferRuntime：Effect child Scope 管理 Actor/Timeline/RAF；twinWaferAtom 只保存离散状态与 HUD 投影，逐帧位置/轨迹/相机写入 SceneCommands；Research Replay 已迁移到独立 XState Actor + Effect-scoped Runtime。

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

- 当前部署默认 1 个 FAB；架构支持 `Fab:FabCount` 1–32 个独立 FAB。浏览器验收可聚焦单个 FAB 渲染，跨 FAB 隔离由显式多 FAB 配置的单元/集成测试覆盖。命令恢复只保证活动命令，终态历史跨刷新不保证（ADR-010 §6.6）。
- GPU 设备丢失未做真实硬件注入端到端验证；由渲染生命周期测试覆盖。
- 长时 heap 仅记录 600 帧窗口；非分钟级稳定性测试。
- 生产构建产物已测量（raw/gzip），浏览器功能与性能基线使用 Vite dev server。
- Round 4 源码整改后的验证事实：前端 155 文件 / 908 测试 PASS、typecheck 0、oxlint 0、vite build PASS；后端 226 测试 PASS；契约/生成物/架构/frozen-assets/Python tools 源码门禁 PASS。浏览器 E2E、GPU soak、Compiler ON/OFF 等价与完整 verify.ps1 仍未执行，见 `17-round4-remediation-record.md` §5。
- **提交约定（用户指令，2026-10-30）：每一轮整改/修复完成后必须立即 `git commit` 并 `git push origin main`，不得只留本地提交；回复中报告 commit SHA 与 GitHub compare 链接。** 任务同时按提交逐项记录在 `evidence/effect4-progress.md`。