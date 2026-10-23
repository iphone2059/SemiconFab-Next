# SemiconFab-Next

本仓库按 **扁平、独立、按名字关联、每个域一个服务项目** 的原则组织：仓库根目录下的每个子目录就是一个完全独立的项目；仓库没有总 solution，任何项目都可以单独还原、构建、测试和运行。

## 组织原则

- **全部同级**：22 个 .NET 项目与 1 个自包含前端站点项目全部位于仓库根目录，没有 `src/`、`apps/`、`tests/`、`frontend/` 等容器层级。
- **一域一项目**：每个业务域合并为单一 `*_service` 项目（原 domain/application/infrastructure 三层已合并）；服务之间不互相引用，只依赖共享内核。
- **名称即关系**：全小写 + 下划线 `{域}_{角色}`；服务后缀 `_service`，测试后缀 `_tests`，共享内核 `fab_shared`；前端只有 `web_app`。
- **完全独立**：每个 csproj 自带 TargetFramework、编译开关与包版本，不依赖根目录 `Directory.Build.props` / `Directory.Packages.props`；仓库不含 `*.sln` / `*.slnx`。
- **按名字关联**：后端只用显式相对 `ProjectReference`（如 `../fab_shared/fab_shared.csproj`）；前端源码内部只用相对导入。
- **设计基线**：功能边界以 `../SemiconFab-Next-Engineering-v1.1` 为准；布局决策见 `docs/adr/0001-flat-project-layout.md`、`0002-merge-domain-layers-into-services.md`、`0003-single-web-app.md`、`0004-merge-shared-kernel.md` 与 `0005-merge-simulation-into-shared.md`。

## 项目族

```text
共享内核（1）：fab_shared（IDs / Contracts / 消息 / 可观测性 / Host / 配置 / 行业 Profile / 安全策略 / 优化抽象，以及 M07 确定性仿真引擎与 M08 协调内核；契约由 JSON Schema 生成）

业务域服务（12）：site_service / manufacturing_service / process_engineering_service /
                 equipment_service / material_handling_service / maintenance_service /
                 quality_service / site_resources_service / orchestration_service /
                 experiment_service / analytics_service / identity_service

平台服务（2）：eap_service / industrial_interfaces_service
独立部署宿主（4）：api_service / worker_service / realtime_service / ot_gateway_service
测试（3）：simulation_tests / orchestration_tests / api_tests
前端（1）：web_app（单站点 Vite/React 项目，自带 package.json、lockfile 与 tsconfig）
预留（8）：fab_native / contracts_tests / e2e_tests / gpu_acceptance_tests /
           ot_conformance_tests / performance_tests / simulation_golden_tests / shared_resources
```

## 构建与验证

```powershell
# 单项目独立构建（无 solution）
dotnet build site_service/site_service.csproj
dotnet run --project api_service

# 本地开发（API + Web）
./scripts/start-dev.ps1

# 全量校验（逐项目 restore/build/test + 契约/架构检查 + 前端检查）
./scripts/verify.ps1
```

前端（单站点）：`cd web_app; npx --yes pnpm@12.15.0 install --frozen-lockfile`，然后 `typecheck` / `test` / `build`。

## 文档

- 模块档案：`docs/modules/M01.md` … `M18.md`
- 实施状态：`docs/IMPLEMENTATION-STATUS.md`
- 决策记录：`docs/adr/`
