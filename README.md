# SemiconFab-Next

本仓库按 **扁平、独立、按名字关联、每个域一个服务项目** 的原则组织：仓库根目录下的每个子目录就是一个完全独立的项目；仓库没有总 solution，任何项目都可以单独还原、构建、测试和运行。

## 组织原则

- **全部同级**：32 个 .NET 项目与 9 个前端包全部位于仓库根目录，没有 `src/`、`apps/`、`tests/`、`frontend/` 等容器层级。
- **一域一项目**：每个业务域合并为单一 `*_service` 项目（原 domain/application/infrastructure 三层已合并）；服务之间不互相引用，只依赖共享内核。
- **名称即关系**：全小写 + 下划线 `{域}_{角色}`；服务后缀 `_service`，测试后缀 `_tests`，共享库 `fab_*`，前端 `web_*`。
- **完全独立**：每个 csproj 自带 TargetFramework、编译开关与包版本，不依赖根目录 `Directory.Build.props` / `Directory.Packages.props`；仓库不含 `*.sln` / `*.slnx`。
- **按名字关联**：后端只用显式相对 `ProjectReference`（如 `../fab_contracts/fab_contracts.csproj`）；前端只用 pnpm 包名（`@fab/...`）。
- **设计基线**：功能边界以 `../SemiconFab-Next-Engineering-v1.1` 为准；布局决策见 `docs/adr/0001-flat-project-layout.md` 与 `docs/adr/0002-merge-domain-layers-into-services.md`。

## 项目族

```text
共享内核（10）：fab_ids / fab_contracts / fab_contracts_adapters / fab_messaging /
                 fab_observability / fab_hosting / fab_configuration / fab_industrial_profiles /
                 fab_security_policies / fab_optimization_abstractions

业务域服务（12）：site_service / manufacturing_service / process_engineering_service /
                 equipment_service / material_handling_service / maintenance_service /
                 quality_service / site_resources_service / orchestration_service /
                 experiment_service / analytics_service / identity_service

平台服务（2）：eap_service / industrial_interfaces_service
仿真引擎（1）：simulation_engine（M07 内核 + M08 协调，作为共享库被编排引用）

独立部署宿主（4）：api_service / worker_service / realtime_service / ot_gateway_service
测试（3）：simulation_tests / orchestration_tests / api_tests
前端（9）：web_app + web_contracts / web_api_client / web_ui / web_widgets / web_charting /
           web_fab_scene / web_babylon_webgpu / web_state_sync
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

前端：`npx --yes pnpm@12.15.0 install --frozen-lockfile`，然后 `typecheck` / `test` / `build`。

## 文档

- 模块档案：`docs/modules/M01.md` … `M18.md`
- 实施状态：`docs/IMPLEMENTATION-STATUS.md`
- 决策记录：`docs/adr/`
