# 实施状态（V2.1 最终）

- 状态：**M0–M6 与后续 review 修复（多 FAB、SSE 游标/缺口、命令保留/幂等/能力、FAB 级遥测/设备状态、真实 GPU/Worker 压力门禁）已完成；性能优化专项（渲染热路径、遥测传输、RunStore 索引、静态资源打包、门禁加强、仿真值类型）已完成；review-2/review-3 修复已完成；PR #1 相机输入对齐已完成；**2026-10-28 递归整改 R-01…R-14（11 个职责提交，`67915c0..546647d`）已完成：键盘监听最新回调、Tour 单一 RAF、命令结果严格校验、唯一 HTTP transport、ScenePort/ViewerLifecycle、独立 GPU Effect Owner、生成物登记/校验、实时边界拆分、feature 所有权收口、镜像式测试布局、R7–R14 架构门禁与负向 fixtures；2026-10-28 收尾提交消除 R12/R13 例外、将 Workbench 本地组件归位并为 routeTree 增加官方生成逐字节门禁**；PostgreSQL/Outbox/生产身份因基础设施缺失保留边界。**
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

## 当前架构

```text
React 19 + Vite 8 + TS 7
TanStack Router     URL/search/生成式路由树（canonical URL only）
TanStack Query      唯一 HTTP 缓存
Zustand             客户端 UI 状态
RxJS + Zod          实时类型化流/解码（CommandEventBridge 输入）
XState              命令工作流（CommandWorkflow 契约后；FabRuntime 按 FAB 装配）
Babylon Lite 1.36   WebGPU-only 渲染
```

- 产品 URL：`/`、`/fabs/{fabId}/3d`、`/equipment`、`/equipment/compare`；旧地址无重定向。
- 目录（2026-10-28 终态，详见 `docs/architecture.md` §30）：`src/app`、`src/api/{transport,schemas,cache,queries,mutations}`、`src/application/{contracts,coordination,ports/scene.ts}`、`src/realtime/{equipment-status,protocol,telemetry,transport,workers,buffers}`、`src/runtime`（含 `runtime/commands` XState 实现）、`src/state`、`src/localization`、`src/shared/scheduling`、`src/domain/{fab,amhs,personnel,equipment,simulation,wafer,math}`、`src/features/{twin,catalog,workbench}`、`src/components`、`src/rendering/{lite-backend.ts,lite,contracts}`、`src/generated`（生成物统一目录）；`src` 根只允许 `main.tsx` + `contracts.ts`（R6）。
- 旧 `src/render`、Redux/`src/store`、RTK Query、immer、Babylon 旧代码/旧迁移文档/parity 工具与测试均已删除（Git 历史保留）。
- P2 架构清理（2026-10-28，行为不变）：18 个纯领域模块移入 `src/domain/**`（`original-twin-data` 不再反向依赖 feature）；`app/router` 通用 search/url-mapping 不再认识 catalog/Twin（转换分别归 `features/catalog/search.ts`、`features/twin/twin-search.ts`）；`state/createSliceStore` 改为类型安全工厂；遥测传输与设备状态投影分离；Twin 页拆为 `features/twin/controllers/*` + `equipment-status-pipeline.tsx`；生成物迁入 `src/generated/`。
- 递归整改（2026-10-28，`67915c0..546647d`）随后完成：`application/ports/scene.ts` ScenePort + `ViewerLifecycle`（`state/runtimeStore.ts`）；domain 拆为 `simulation/tour-timeline.ts`、`wafer/wafer-timeline.ts`、`math/`，MES 创建要求显式 epoch-ms；`TwinLanguage` 迁入 `localization/language.ts`；`rendering/lite/effects/{xray,xray-shaders,cut,wafer,index}.ts` 独立资源所有者；`rendering/contracts/static-structure-data.ts` + `tools/generated-artifacts.json` + `tools/check_generated_artifacts.mjs`；`realtime/equipment-status/{protocol,gate,stream,index}.ts` + `api/cache/equipment-status-bridge.ts` + `shared/scheduling/coalesced-dispatcher.ts`；catalog/workbench 子目录与全局 `widgets/charting` 删除；测试镜像式布局与 R7–R14 门禁。

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
- **多 FAB**：后端默认 FAB-01/02/03（`Fab:FabCount` 1..32），前端按 FAB 装配 Runtime/遥测/状态，Workbench 多 FAB 卡片，Scenario 可提交任意非空子集。
- **命令可靠性**：Idempotency-Key 幂等、能力目录/前置条件、FAB 授权 seam、终态 TTL/容量保留；命令 SSE 带 epoch/sequence 与 Last-Event-ID，缺口触发 replay-gap + 权威核对。
- **性能**：`tools/render_perf.mjs` 在 headless Chrome + 真实 WebGPU 上验证 `navigator.gpu`/adapter/canvas、renderer frames/draw calls/gpuErrors；dev 门禁 + 60Hz profile（p95/p99/heap trend/首帧，`scripts/perf-render.ps1 -Profile`）；静态结构构建期打包（`tools/pack_static_structure.mjs` → `src/generated/static-structure-packed.ts`）；`tests/performance/telemetry-load.test.ts` 覆盖 500/2000/5000 实体负载。命令见根 README。

## 测试与门禁

- RQ-01..RQ-05、CE-01..CE-08：真实运行；CE-06 已有权威状态查询端点与集成测试。
- ARCH-01..12 与 R0–R14：`web_app/tests/architecture/` 三层门禁——`architecture-boundaries.test.ts`（正则边界）、`architecture-import-graph.test.ts`（真实 TypeScript import 图 R0–R6）、`architecture-contract-rules.test.ts`（R7–R14，含 `fixtures/r7…r14` 负向证明）；`route-tree-generation.test.ts` 在隔离干净 worktree 中官方重生成 `routeTree.gen.ts` 并逐字节比对（插件/生成器版本固定、`@ts-nocheck` 仅限该文件）；`tools/check_architecture.py` 检查终态目录/domain 分层/旧根模块缺席/generated 区域/模块档案数量（18 条）。
- 生成物：`tools/generated-artifacts.json` 登记 3 件产物；`node tools/check_generated_artifacts.mjs --check` 校验输入/输出 sha256 与 `src/generated` 全覆盖（R11）；各生成器 `--check` 已并入 `scripts/verify.ps1`；`app/router/routeTree.gen.ts` 属构建期插件生成物，不进 registry，由 `route-tree-generation` 门禁验证。
- 测试布局：`web_app/tests/{api,application,components,contract,domain,features,integration,performance,realtime,rendering,state,architecture}` + `fixtures/support/types`（历史平铺测试已迁移、golden fixtures 与断言强度不变）。
- 高频路径：`web_app/tests/realtime/realtime-frame-buffer.test.ts`、`web_app/tests/performance/telemetry-frame-buffer.test.ts`/`telemetry-load.test.ts`（CPU/负载）+ `tools/render_perf.mjs`（真实 GPU）。
- 传输：`web_app/tests/realtime/realtime-transport.test.ts` 覆盖 SSE 游标/replay-gap、HTTP gateway、命令幂等提交、TelemetryRuntime Worker 链路；`web_app/tests/integration/fab-runtime-batch23.test.ts` 覆盖 Runtime 保留/缺口核对。

## 已知边界

- 后端 `--realtime` WebSocket 仍是占位；当前产品使用 HTTP/SSE 模拟实现，WebSocket 生产传输后续可替换同契约。
- **PostgreSQL/Outbox/生产身份认证未实现**：仓库无数据库依赖/服务与 IdP；当前命令历史/状态为内存存储 + 终态 TTL/容量限制，`DevelopmentFabAuthorization` 仅为开发 seam。
- SharedArrayBuffer/COOP-COEP 未启用（OPEN-V21-14），Worker 走 postMessage。
- GPU 门禁为单机 headless Chrome 基线；生产设备矩阵/显存/长时压测待补。
- 产品默认 3 FAB；前端 Runtime/遥测/状态/UI 已按 FAB 数据驱动。
