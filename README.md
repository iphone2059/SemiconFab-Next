# SemiconFab-Next

本仓库按 **扁平、独立、按名字关联、最少项目** 的原则组织：仓库根目录下每个子目录就是一个完全独立的项目；没有总 solution、没有 pnpm workspace，任何项目都可以单独构建。

## 组织原则

- **全部同级**：3 个 .NET 项目 + 1 个前端站点全部位于仓库根目录。
- **一个后端**：`fab_app` 合并全部域服务、平台服务与宿主，按运行模式（api/worker/realtime/ot）启动；服务之间不再有项目边界。
- **一个前端**：`web_app` 是唯一站点（Vite + React），自包含 package.json / lockfile / tsconfig。
- **一个共享内核**：`fab_shared` 持有 ID、生成契约、消息/可观测性/Host/配置基础与 M07/M08 确定性仿真内核。
- **一个测试项目**：`fab_tests` 合并原仿真、编排、API 测试。
- **完全独立**：每个 csproj 自带 TargetFramework、编译开关与包版本；仓库不含 `*.sln` / `*.slnx`。
- **按名字关联**：后端只用显式相对 `ProjectReference`；前端源码内部只用相对导入。
- **设计基线**：功能边界以 `../SemiconFab-Next-Engineering-v1.1` 为准；布局决策见 `docs/adr/0001` … `0006`。

## 项目清单

```text
fab_shared/   共享内核：StableId、Generated/Contracts.g.cs、确定性 DES 引擎（FabSimulation 等）
fab_app/      唯一后端应用：API + Worker + Realtime/OT 占位模式（Sdk.Web）
fab_tests/    唯一测试项目：仿真 / 编排 / API 集成测试
web_app/      唯一前端站点：Vite + React + Babylon WebGPU
contracts/    JSON Schema（契约单一来源）、OpenAPI、protobuf
docs/         模块档案 M01–M18、实施状态、ADR
infrastructure/ assets/ scripts/ tools/ .github/   # 部署参考、资产、脚本、工具、CI
```

## 运行与验证

```powershell
# 本地开发：API(127.0.0.1:5080) + Web(127.0.0.1:5173)
./scripts/start-dev.ps1

# 单后端模式
dotnet run --project fab_app                 # API（默认，内嵌 Worker）
dotnet run --project fab_app -- --worker     # 独立 Worker
dotnet run --project fab_app -- --realtime   # 占位：退出码 2
dotnet run --project fab_app -- --ot         # 占位：退出码 2

# 全量校验：逐项目构建 + fab_tests + 契约/架构检查 + 前端检查
./scripts/verify.ps1

# 前端（在 web_app 内）
cd web_app
npx --yes pnpm@12.15.0 install --frozen-lockfile
npx --yes pnpm@12.15.0 typecheck
npx --yes pnpm@12.15.0 test
npx --yes pnpm@12.15.0 build
```

## 文档

- 模块档案：`docs/modules/M01.md` … `M18.md`
- 实施状态：`docs/IMPLEMENTATION-STATUS.md`
- 决策记录：`docs/adr/`
