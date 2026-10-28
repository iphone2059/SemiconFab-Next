# SemiconFab-Next

SemiconFab-Next 是 SemiconFab 的下一代实现：后端保持扁平、独立、按名字关联的单应用结构，前端完成 V2.1 架构迁移（TanStack Router/Query、Zustand、RxJS、XState v6、Babylon Lite/WebGPU）。

## 组织原则

- **全部同级**：3 个 .NET 项目 + 1 个前端站点全部位于仓库根目录。
- **一个后端**：`fab_app` 合并全部域服务、平台服务与宿主，按运行模式（api/worker/realtime/ot）启动；无 solution / 工作区。
- **一个前端**：`web_app` 是唯一站点（Vite + React），自包含 package.json / lockfile / tsconfig。
- **一个共享内核**：`fab_shared` 持有 ID、生成契约、确定性 DES 内核。
- **一个测试项目**：`fab_tests` 合并仿真、编排、API 测试。
- **完全独立**：每个 csproj 自带 TargetFramework、编译开关与包版本；仓库不含 `*.sln` / `*.slnx`。
- **按名字关联**：后端只用显式相对 `ProjectReference`；前端源码内部只用相对导入。

## 技术栈（V2.1）

- React 19 + Vite 8 + TypeScript 7
- TanStack Router（最终 URL、search 状态、生成式路由树）
- TanStack Query（唯一 HTTP 缓存）
- Zustand（客户端 UI 状态）
- RxJS + Zod（实时类型化流/解码）
- XState v6（命令工作流，隐藏于 `CommandWorkflow` 契约后）
- Babylon Lite 1.36（WebGPU-only）位于 `web_app/src/rendering/lite`

## 项目清单

```text
fab_shared/   共享内核：StableId、Generated/Contracts.g.cs、确定性 DES 引擎
fab_app/      唯一后端应用：API + Worker + Realtime/OT 占位模式（Sdk.Web）
fab_tests/    唯一测试项目：仿真 / 编排 / API 集成测试
web_app/      唯一前端站点
  src/
    app/          providers、Router（routeTree.gen、通用 search/url-mapping/route-data、routes/ 装配入口）
    api/          TanStack Query 查询/变更
    application/  命令契约 + CommandEventBridge/恢复协调层
    realtime/     协议解码/序列、类型化流、SSE 传输、遥测 Worker/帧缓冲
    runtime/      FabRuntime/Factory/Registry/Lifecycle、SSE/gateway 装配
    runtime/commands/  XState 命令工作流实现（位置非强制，经 CommandWorkflow 契约暴露）
    state/        Zustand UI stores（类型安全 createSliceStore）、遥测合批
    domain/       纯领域模块（fab/amhs/personnel/wafer/simulation/contracts/equipment）
    generated/    生成物（contracts/twin-translations/static-structure-packed，禁止手改）
    features/     twin（含 controllers/、twin-search、wafer-session）/ catalog / workbench 页面模块
    components/   共享 UI（ui/widgets/charting/modal/error-boundary）
    rendering/    Babylon Lite/WebGPU 渲染实现
  tests/          单元/契约/集成/性能/架构测试（Vitest）
  assets/         CSS、i18n/许可与静态数据
contracts/        JSON Schema（契约单一来源）、OpenAPI、protobuf
assets/legacy/    版本化迁移数据与校验清单（后端读取）
docs/             架构基线、ADR、实施状态、模块档案
infrastructure/ scripts/ tools/ .github/
```

## 运行与验证

```powershell
# 本地开发：API(127.0.0.1:5080) + Web(127.0.0.1:5173)
./scripts/start-dev.ps1

# 全量校验：契约/架构检查、Python 工具测试、3 个 .NET 项目构建 + 测试、前端 typecheck/test/build
./scripts/verify.ps1

# 真实 GPU/浏览器性能门禁（需先 ./scripts/start-dev.ps1）
./scripts/perf-render.ps1 -Url http://127.0.0.1:5173/fabs/{fabId}/3d
```

前端单独运行（在 `web_app` 内）：

```powershell
npx --yes pnpm@12.15.0 install --frozen-lockfile
npx --yes pnpm@12.15.0 typecheck
npx --yes pnpm@12.15.0 test
npx --yes pnpm@12.15.0 build
```

当前验证基线：`tsc --noEmit` 0、Vitest **90 文件 / 532 测试 PASS**（含 `architecture-import-graph.test.ts` 的真实 import 图 R0–R6 门禁；默认并发全量 PASS，CPU 密集黄金向量套件统一放宽 `testTimeout: 15s`，断言不变）、`vite build` 0、后端 **170/170**、真实 Chrome WebGPU dev 门禁 **600 帧 / p95 8.5ms / 114.5fps / 1 个按需 Worker**、60Hz profile **p95 8.5ms / p99 16.6ms / heap growth 11.8MB**、Worker 压测 500/2000/5000 实体 p95 ≤1.2ms、静态结构构建期打包（`lite-backend` chunk 2.36MB→1.79MB，gzip 192.7→176.4kB）、RunStore 10k 历史 Run 下 Submit steady p50 **6.2ms（原 40.4ms，分片索引）**、RunStore 提交通知**合并唤醒**（批量提交后不积压空转）、相机输入与 Three.js r128 `OrbitControls` 行为对齐（独立 source-orbit-input 控制器，真实浏览器 12 项交互探针通过）、`./scripts/verify.ps1` exit 0（8 个 Python 工具测试、13 个渲染门禁单测、3 个 .NET 项目、契约/架构检查、前端全量）。

## 产品 URL（仅 canonical，无重定向）

- `/`：基地总览/工作台
- `/fabs/{fabId}/3d`：3D FAB
- `/equipment`：设备目录
- `/equipment/compare`：设备对比
- 预留：`/fabs/{fabId}`、`/equipment/{equipmentId}`、`/amhs`、`/alarms`

旧 URL 已删除，不提供别名或重定向。

## 状态与边界

- **TanStack Query**：唯一服务端数据缓存；页面/组件不另建请求缓存。
- **Zustand**：仅客户端 UI 状态，不保存 Query DTO、XState actor 或引擎对象。
- **XState v6**：命令生命周期由 workflow 拥有，经 `CommandWorkflow` 契约暴露；`RuntimeBootstrap` 按 FAB 装配 `FabRuntime`，命令源接后端模拟 HTTP/SSE，含幂等键、能力/权限校验与权威核对。
- **高频路径**：FAB 级遥测 SSE → 每 FAB Worker → TypedArray/FrameRingBuffer → 渲染 frame loop，不经过 Query/Zustand/XState。
- **多 FAB**：后端默认 FAB-01/02/03，前端按 FAB 装配 Runtime/遥测/设备状态；命令/SSE 带复合身份与游标恢复。
- **Babylon Lite/WebGPU-only**：无 WebGL 回退；缺少 WebGPU/安全上下文时明确报错。

## 文档

- [架构基线](docs/architecture.md)（ADR-0009 Router/Query、ADR-0010 Realtime/Workflow、ARCH-01..12、M0–M6 记录）
- [实施状态](docs/IMPLEMENTATION-STATUS.md)
- [ADR 目录](docs/adr/)
- [模块档案](docs/modules/M01.md)（M01–M18）
- [渲染管线](docs/rendering.md)、[状态管理](docs/state-management.md)、[实时协议](docs/realtime-protocol.md)、[命令事件桥](docs/command-event-bridge.md)、[命令核对](docs/command-reconciliation.md)、[FAB 运行时](docs/fab-runtime.md)
- [原版资产署名](docs/attribution.md)

## 原版数据导入

仓库已包含首份导入快照，正常运行不要求旁边存在旧仓库。重新导入时执行：

```powershell
python tools/migrate_legacy_data.py --source ../SemiconFab-main --output assets/legacy
python tools/migrate_legacy_data.py --check
```

相同输入保持同一版本；错误记录生成字段级问题清单，且不会替换当前快照。`Fab__CatalogDirectory` 可指定另一份导入目录。API 当前沿用开发身份；本地 JSON 载入仅影响浏览器预览，不会发布数据或改动基地设备。

## 已知边界

- 后端 `--realtime`（WebSocket）/OT 仍是占位；当前产品使用 HTTP 命令 API + 命令 SSE + FAB 级遥测/设备状态 SSE 模拟实现。
- PostgreSQL/Outbox/正式身份认证未实现（仓库无数据库/IdP 基础设施）；当前命令状态为内存存储 + 终态 TTL/容量限制，开发身份授权 seam 已就位。
- Worker 已接 FAB 级遥测 SSE 并供渲染 frame loop 读取；SharedArrayBuffer/COOP-COEP 未启用。
- GPU 门禁是单机 headless Chrome 基线，不是生产设备矩阵；产品默认 3 FAB，前端已数据驱动。
