# SemiconFab-Next

SemiconFab-Next 是 SemiconFab 的下一代实现：后端保持扁平、独立、按名字关联的单应用结构；前端已完成 **Effect 4 + 严格单层源码目录 + code-based routing** 重构（分支 `refactor/effect4-flat-20261029`）。

## 组织原则

- **全部同级**：3 个 .NET 项目 + 1 个前端站点全部位于仓库根目录。
- **一个后端**：`fab_app` 合并全部域服务、平台服务与宿主，按运行模式（api/worker/realtime/ot）启动；无 solution / 工作区。
- **一个前端**：`web_app` 是唯一站点（Vite + React），自包含 package.json / lockfile / tsconfig。
- **一个共享内核**：`fab_shared` 持有 ID、生成契约、确定性 DES 内核。
- **一个测试项目**：`fab_tests` 合并仿真、编排、API 测试。
- **完全独立**：每个 csproj 自带 TargetFramework、编译开关与包版本；仓库不含 `*.sln` / `*.slnx`。
- **按名字关联**：后端只用显式相对 `ProjectReference`；前端源码内部使用 `@/` alias（`@/* -> ./src/*`）。

## 技术栈

- React 19 + Vite 8 + TypeScript 7
- Effect 4（`effect@4.0.7`、`@effect/atom-react@4.0.7`）：AppRuntime、AtomRegistry、Resource Atom、Effect Stream/Scope
- TanStack Router 1.170（**code-based route tree**；无 router plugin）
- XState 6 Alpha（命令工作流，Scope 管理 actor 生命周期）
- Babylon Lite 1.36（WebGPU-only）
- 已移除：Zustand、TanStack Query、Zod、RxJS、`@tanstack/router-plugin`

## 项目清单

```text
fab_shared/   共享内核：StableId、Generated/Contracts.g.cs、确定性 DES 引擎
fab_app/      唯一后端应用：API + Worker + Realtime/OT 占位模式（Sdk.Web）
fab_tests/    唯一测试项目：仿真 / 编排 / API 集成测试
web_app/      唯一前端站点（严格单层 src；详见 web_app/README.md）
  src/
    main.tsx
    api/          Resource Atom、resource-policy、Effect HTTP transport、Effect Schema contracts
    app/          AppRuntime/AppProviders/RuntimeBootstrap（唯一组合根）
    catalog/      设备目录
    components/   共享 UI 原语
    contracts/    命令契约/网关/工作流/ScenePort
    domain/       纯领域逻辑
    generated/    生成静态结构数据
    lib/          通用原语
    localization/
    realtime/     Effect Stream/PubSub SSE、遥测 Worker、设备状态 gate
    rendering/    Babylon Lite + WebGPU
    routes/       code-based 路由 + loader（ensureResource）
    runtime/      FabRuntime/命令 bridge/XState Effect Scope
    state/        UI Effect atoms
    twin/         Twin 页面与 HUD
    workbench/    工作台
```

## 文档

- 目标/验收：`docs/architecture/README.md`、`01-effect4-target-architecture.md`、`02-flat-source-layout.md`、`03-migration-plan.md`、`04-acceptance-and-architecture-gates.md`
- 任务证据：`docs/architecture/evidence/`
- 浏览器 e2e：`docs/perf/effect4-e2e.json`；性能/GPU：`docs/architecture/evidence/perf/`
- 实施状态：`docs/IMPLEMENTATION-STATUS.md`；评审规范：`docs/standards/SFN-WEB-REVIEW-STD-001.md`

## 常用命令

```powershell
# 启动 API + Web（默认 5080 / 5173；自动校验 Node/.NET/pnpm 版本）
./scripts/start-dev.ps1

# 全量验证（生成物/架构/导入/.NET/前端 typecheck+test+build）
./scripts/verify.ps1

# 真实浏览器功能验收（必要时自动启动隔离 dev 栈）
cd web_app; pnpm e2e

# 渲染/GPU 与遥测压力（需已启动 dev 栈）
node tools/render_perf.mjs --url http://127.0.0.1:5173/fabs/<fabId>/3d --frames 600 --profile dev
node tools/telemetry_stress.mjs --url http://127.0.0.1:5173/tests/telemetry-stress.html --seconds 8 --rate 60
```
