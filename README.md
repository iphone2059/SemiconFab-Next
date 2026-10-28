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
web_app/      唯一前端站点（2026-10-28 递归整改后的所有权布局，详见 web_app/README.md 与 docs/architecture.md §30）
  src/
    app/          providers（装配根）、Router（routeTree.gen、通用 search/url-mapping/route-data、routes/ 装配入口）
    api/          transport/http（唯一 HTTP 策略）、schemas（Zod 运行时合同）、cache（equipment-status 投影桥）、queries/mutations（TanStack Query）
    application/  contracts（CommandEvents/Gateway/Workflow）、coordination（Bridge/恢复/关联/ScopeGate）、ports/scene.ts（ScenePort）
    realtime/     equipment-status/{protocol,gate,stream}/、protocol/MessageDecoder、telemetry、transport（SSE/gateway）、workers、buffers
    runtime/      FabRuntime/Factory/Registry/Lifecycle、commandSources、commands/（XState v6，经 CommandWorkflow 契约）
    state/        共享客户端状态：runtimeStore / localeStore / preferences（类型安全 createSliceStore）
    localization/  TwinLanguage 等 UI 语言类型（不进入 domain）
    shared/       scheduling/coalesced-dispatcher 等通用原语
    domain/       纯领域模块（fab/amhs/personnel/equipment/simulation/wafer/math）
    generated/    生成物（contracts/twin-translations/static-structure-packed；登记于 tools/generated-artifacts.json，禁止手改）
    features/     twin（页面 + controllers/ + state/ + HUD 子组件）/ catalog（components/controllers/export/state）/ workbench（components/controllers/state）
    components/   共享设计系统（ui/modal/error-boundary/class-names/original-icons + original-icons-data）
    rendering/    application/ports/scene 的产品实现（lite-backend.ts）+ lite/（effects/geometry/shadows/…）+ contracts/（生成物类型合同）
  tests/          镜像式 Vitest 布局（api/application/components/contract/domain/features/integration/performance/realtime/rendering/state/architecture/fixtures/support/types）
  assets/ public/ Vite 打包资产 / 浏览器 URL 直接请求的数据与许可证副本
contracts/        JSON Schema（契约单一来源）、OpenAPI、protobuf
assets/legacy/    版本化迁移数据与校验清单（后端读取）
docs/             架构基线、ADR、实施状态、模块档案、验证证据
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

当前验证以 `./scripts/verify.ps1` 的一次真实运行为准（本文件不硬编码会腐化的测试数量）：它依次执行生成物一致性（含 `node tools/check_generated_artifacts.mjs --check` 与各生成器 `--check`）、`python tools/check_architecture.py`、Python/Node 工具单测、导入快照校验、3 个 .NET 项目构建与测试，以及 `web_app` 的 typecheck/test/build。前端架构门禁为 `web_app/tests/architecture/` 下的 R0–R14（真实 TypeScript import 图 + 负向 fixtures），测试按所有权镜像布局；历史基线与性能/浏览器证据见 `docs/IMPLEMENTATION-STATUS.md` 与 `docs/evidence/`。

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

- [架构基线](docs/architecture.md)（ADR-0009 Router/Query、ADR-0010 Realtime/Workflow、ARCH-01..12、M0–M6 记录、R-01…R-14 递归整改记录 §30）
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
