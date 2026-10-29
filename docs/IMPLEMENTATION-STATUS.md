# 实施状态（V2.1 最终）

- 状态：**Effect 4 / 单层目录 / code-based routing 重构已完成并验收（2026-10-29，分支 `refactor/effect4-flat-20261029`，受测代码提交见本文件 A4 证据与 `docs/architecture/evidence/effect4-task6-performance-a4.md`（Task 0–6 提交索引见 `evidence/effect4-progress.md`））。** 当前事实以本文件“Effect 4 重构终态”章节与 `docs/architecture/README.md` 为准；下方“V2.1 历史状态/里程碑”保留当日审计轨迹，其中 TanStack Query/Zustand/RxJS/Zod、生成式路由树与 `features/` 目录已被 2026-10-29 重构取代。\
- Effect 4 终态验证：前端 **120 文件 / 718 测试 PASS**；`./scripts/verify.ps1` exit 0；浏览器 e2e **10/10 PASS**（`docs/perf/effect4-e2e.json`）；A/B 性能/GPU 证据见 `docs/architecture/evidence/perf/`。\
- 历史 V2.1 状态（截至 2026-10-28）：M0–M6、review 修复与 R-01…R-14 递归整改已完成；PostgreSQL/Outbox/生产身份因基础设施缺失保留边界。
- 最后验证（提交前）：
  - 契约/架构检查 PASS
  - Python 工具测试（`python -m unittest discover -s tools`）与渲染门禁 Node 单测（`node --test tools/test_render_perf_checks.mjs`）PASS
  - 3 个 .NET 项目 Release 构建 + **170/170 测试 PASS**
  - 前端 `pnpm install --frozen-lockfile`、`tsc --noEmit` 0、Vitest **104 文件 / 662 测试 PASS**（2026-10-28 递归整改 + 收尾后全量；含 `tests/architecture/` 的 R0–R6 与 R7–R14 门禁及负向 fixtures；默认并发全量 PASS，CPU 密集黄金向量套件统一 `testTimeout: 15s`）、`vite build` 0
  - 架构门禁：`python tools/check_architecture.py` PASS；生成物 `node tools/check_generated_artifacts.mjs --check` PASS（`tools/generated-artifacts.json` 登记 3 件生成物，generator `--check` 已并入 verify）
  - `./scripts/verify.ps1` exit 0
  - 真实 Chrome/WebGPU dev 门禁：600 帧，p95 8.5ms，114.5fps，1 个按需 Worker，heap growth 6.82MB，rendererFrames 631，drawCalls 903，gpuErrors []（`.local/render-perf-final2.json`）
  - 真实 Chrome/WebGPU 60Hz profile：600 帧，p95 8.5ms，p99 16.6ms，heap growth 11.82MB，failures []
  - Worker 压力：500/2000/5000 entities × 60Hz × 5s，真实浏览器 Worker 收发 100%，p95 0.4/0.8/1.2ms
  - 性能优化证据：`docs/evidence/perf-2026-10-27.json`（base `536b44e`，9 个主题提交）；review-2 修复证据：`docs/evidence/perf-2026-10-27-review2.json`（base `6cdfc7a`，4 个修复提交；RunStore 10k 历史 Submit steady p50 6.2ms）；review-3 修复证据：`docs/evidence/perf-2026-10-27-review3.json`（base `a05ca0a`，提交通知合并唤醒）；相机输入对齐证据：`docs/evidence/camera-parity-2026-10-27.json`（PR #1，merge `c1d1678`，真实浏览器 12 项交互探针通过）

## 当前架构（2026-10-29 Effect 4 终态）

```text
React 19 + Vite 8 + TS 7
Effect 4.0.7 + @effect/atom-react 4.0.7
  AppRuntime: 一个 ManagedRuntime + 一个 AtomRegistry（app/app-runtime.ts）
  Resource Atom: AsyncResult + freshness/idle TTL/single-flight/错误保留（api/resource.ts）
  Effect Schema + Effect HTTP transport（api/*.schema.ts / api/http.transport.ts）
  Effect Stream/PubSub: 命令 SSE 与遥测信号（realtime/*.transport.ts）
  Effect Scope: XState actor acquire/release + SSE/Stream fiber 生命周期
TanStack Router     code-based 路由树（routes/route-tree.ts）；URL/search 单一所有权
XState 6 Alpha      命令生命周期（runtime/*command*；经 CommandWorkflow 契约）
Babylon Lite 1.36   WebGPU-only 渲染（rendering/lite-backend.ts）
```

- 产品 URL：`/`、`/fabs/{fabId}/3d`、`/equipment`、`/equipment/compare`；无旧地址重定向/兼容转发。
- 目录（严格单层）：`src/api app catalog components contracts domain generated lib localization realtime rendering routes runtime state twin workbench`；`src` 根只允许 `main.tsx`（`source-layout.test.ts`）。
- 已删除：Zustand、TanStack Query、Zod、RxJS、`@tanstack/router-plugin`、`QueryClient/queryKeys/QueryProvider`、`createSliceStore`、旧 `features/` 路径。
- 资源所有权：Router loader 与页面共享 `ensureResource`；远程快照只在 Resource Atom；Gate 仅保存 epoch/sequence；无第二 Map/Effect Cache 快照（`resource-ownership.test.ts`）。
- 设备状态：REST 与 SSE 共用 per-registry 顺序 Gate；SSE 帧只经 `acceptEquipmentStatusSnapshot` 写入 FAB 作用域 Resource Atom；100ms UI 合批保留。
- 命令：HTTP 提交 → FAB SSE → Effect PubSub/Stream → `CommandEventBridge` → XState；Effect Scope 管理 actor、transport 与 recovery fibers；无 RxJS Subscription。
- 遥测：FAB 级 20Hz SSE → `TelemetryRuntime` → Worker FrameRingBuffer → 渲染 frame loop；不进入 AtomRegistry/React 逐帧 state。
- 生成物：`tools/generated-artifacts.json` 登记；`tools/check_generated_artifacts.mjs --check` 并入 `verify.ps1`；无 routeTree 生成物。
- 浏览器验收：`pnpm e2e`（`tools/e2e_functional.mjs` + `scripts/e2e.ps1`），10 场景全部 PASS。
- 性能/GPU：`tools/render_perf.mjs`（dev/60Hz ×3 轮交替 A/B）、`tools/telemetry_stress.mjs`（×3）、`tools/bundle_metrics.mjs`；原始 JSON 在 `docs/architecture/evidence/perf/`。
- 历史 V2.1 细节（TanStack Query/Zustand/旧 feature 目录/routeTree）仅保留在下方“里程碑”等历史章节，不再代表当前实现。

## 里程碑

| 阶段 | 结果 |
|---|---|
| M0 | V2.1 架构基线、ADR-0009/0010、专项文档 |
| M1 | Router/Query 基础设施、最终 URL、RQ-01/05 |
| M2a/b/c | 全端点 Query、RTK/Redux 删除、Zustand 接管 UI 状态、Router search、最终 URL |
| M3 | 实时契约、MessageDecoder/SequenceTracker、类型化流、CommandEventBridge/恢复（假源） |
| M4 | XState 工作流、FabRuntime/Factory/Registry/Lifecycle、三 FAB 隔离（测试源） |
| M5a | XState 正式产品接线、RuntimeBootstrap、多 FAB 数据驱动 UI、只读投影 |
| M5b | `src/rendering/lite` 归位、FrameRingBuffer/Worker 骨架、ARCH-11 检查、CPU 性能基线 |
| M6 | 旧迁移文档/证据/parity 工具与测试删除、verify 收口 |
| M6 后补 | 页面 `features/components` 归位；后端模拟命令 HTTP/SSE + 遥测 SSE；Worker → 渲染接线；真实 GPU 门禁 |
| Review 修复 | 三 FAB 目录/场景子集；FAB 级遥测/设备状态；命令幂等/能力/授权；SSE id/Last-Event-ID/replay-gap；命令保留；前端/后端压力与 GPU 门禁 |
| 递归整改 R-01…R-14（2026-10-28） | 键盘/Tour 单所有权；命令严格校验与唯一 transport；ScenePort+ViewerLifecycle；确定性领域时钟；GPU Effect Owner；生成物登记/校验；实时/feature 所有权收口；镜像式测试布局；R7–R14 门禁 + 负向 fixtures；收尾：Workbench 本地 Panel/StatusPill（删除全局 components/ui.tsx）、Tour 稳定 stop（R13 零例外）、routeTree 官方生成一致性门禁 |

## 命令/遥测/渲染链路

- **命令**：Workbench `CommandConsole` → `POST /api/v1/sites/{siteId}/commands` → `FabRuntime.trackCommand` → 后端命令 SSE → `CommandEventBridge` → XState workflow；`GET /api/v1/commands/{id}` 供核对。浏览器实测 accepted → executing → succeeded。
- **遥测/设备状态**：FAB 级 20Hz 遥测 SSE → 每 FAB `TelemetryRuntime`（传输/解码/帧/背压）→ MessageDecoder → Worker FrameRingBuffer → 渲染 frame loop；设备槽位与 `FabToolState` 投影在纯函数 `domain/equipment/tool-state-projection.ts`；设备状态 REST/SSE 同样按 FAB 作用域；不经过 Query/Zustand/XState（ARCH-11）。
- **FAB 范围**：后端默认只提供 FAB-01；测试使用一个活动 FAB。`Fab:FabCount` 的 1..32 配置范围、按 FAB 装配的 Runtime/遥测/状态、集合形式的 Scenario 和复合身份仍保留，支持将来扩展。
- **命令可靠性**：Idempotency-Key 幂等、能力目录/前置条件、FAB 授权 seam、终态 TTL/容量保留；命令 SSE 带 epoch/sequence 与 Last-Event-ID，缺口触发 replay-gap + 权威核对。
- **性能**：`tools/render_perf.mjs` 在 headless Chrome + 真实 WebGPU 上验证 `navigator.gpu`/adapter/canvas、renderer frames/draw calls/gpuErrors；dev 门禁 + 60Hz profile（p95/p99/heap trend/首帧，`scripts/perf-render.ps1 -Profile`）；静态结构构建期打包（`tools/pack_static_structure.mjs` → `src/generated/static-structure-packed.ts`）；`tests/performance/telemetry-load.test.ts` 覆盖 500/2000/5000 实体负载。命令见根 README。

## 测试与门禁（Effect 4 终态）

- 前端：**120 文件 / 718 测试 PASS**；`tsc --noEmit` 与 `vite build` PASS；`verify.ps1` 内冻结依赖安装。
- A0 架构门禁：`source-layout.test.ts`（严格单层）、`architecture-import-graph.test.ts`（R0–R6 真实 import 图）、`architecture-contract-rules.test.ts`（R7–R14 + 负向 fixtures）、`legacy-dependency-gate.test.ts`（Zod/Zustand/Query/RxJS 清零）、`effect-runtime-boundary.test.ts`（runner/registry/provider 白名单）、`resource-ownership.test.ts`（唯一资源快照 owner/无第二 cache/路由不直接 fetch）。
- A1/A2：Resource Atom（RES 语义）、Effect Schema/HTTP、XState/Effect 命令契约、FAB Scope/设备状态 Gate/Telemetry/渲染生命周期。
- A3：`pnpm e2e` 10/10 场景（Sites 失败/重试、目录筛选/搜索/视图、URL search、Workbench、Catalog 导入/导出、Twin DEMO/晶圆/Research、Twin REST/SSE 断线恢复、未知 FAB、404、退出重进连接卫生）。
- A4：渲染 dev/60Hz 各 3 轮交替 A/B、遥测压力 3 轮、bundle raw/gzip、连接/Worker/heap 指标、React render 隔离测试；证据索引 `docs/architecture/evidence/perf/`。
- 后端：3 个 .NET 项目 Release 构建 + `dotnet test`（verify 内）。
- 浏览器功能与性能为同一台机器、同一 Chrome/WebGPU 环境；性能基线 worktree 为 `4fc8a94`。

## 已知边界

- 后端 `--realtime` WebSocket 仍是占位；当前产品使用 HTTP/SSE 模拟实现，WebSocket 生产传输后续可替换同契约。
- **PostgreSQL/Outbox/生产身份认证未实现**：仓库无数据库依赖/服务与 IdP；当前命令历史/状态为内存存储 + 终态 TTL/容量限制，`DevelopmentFabAuthorization` 仅为开发 seam。
- SharedArrayBuffer/COOP-COEP 未启用（OPEN-V21-14），Worker 走 postMessage。
- GPU 门禁为单机 headless Chrome 基线；生产设备矩阵/显存/长时压测待补。
- 当前产品默认 1 FAB，测试与验收同样只使用 1 FAB；前端 Runtime/遥测/状态/UI 继续按 FAB 数据驱动。
