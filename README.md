# SemiconFab-Next

本仓库按 **扁平、独立、按名字关联** 的原则组织：仓库根目录下的每个子目录就是一个完全独立的项目；仓库没有总 solution，任何项目都可以单独还原、构建、测试和运行。

## 组织原则

- **全部同级**：65 个 .NET 项目与 9 个前端包全部位于仓库根目录，没有 `src/`、`apps/`、`tests/`、`frontend/` 等容器层级。
- **名称即关系**：项目名统一为全小写 + 下划线 `{域}_{角色}`。同一域共享前缀，角色由后缀区分：`_domain` / `_application` / `_infrastructure` / `_service` / `_tests`；前端统一 `web_*` 前缀。
- **完全独立**：每个 csproj 自带 TargetFramework、编译开关与包版本，不依赖根目录 `Directory.Build.props` / `Directory.Packages.props`；不存在 `*.sln` / `*.slnx`。
- **按名字关联**：后端项目之间只用显式相对 `ProjectReference`（如 `../fab_contracts/fab_contracts.csproj`）；前端包之间只用 pnpm 包名（`@fab/...`）。
- **设计基线**：功能边界仍以 `../SemiconFab-Next-Engineering-v1.1` 为准；布局偏离记录在 `docs/adr/0001-flat-project-layout.md`。

## 项目族

```text
共享库：fab_ids / fab_contracts / fab_contracts_adapters / fab_messaging / fab_observability /
        fab_hosting / fab_configuration / fab_industrial_profiles / fab_security_policies /
        fab_optimization_abstractions

业务域（12 × domain/application/infrastructure）：
        site_* / manufacturing_* / process_engineering_* / equipment_* / material_handling_* /
        maintenance_* / quality_* / site_resources_* / orchestration_* / experiment_* /
        analytics_* / identity_*

仿真：simulation_core / simulation_models / simulation_runtime /
      simulation_site_coordinator / simulation_native_bridge
EAP：eap_domain / eap_application / eap_simulator
工业接口：industrial_interfaces_domain / _application / _protocols / _adapters

部署单元（独立进程）：api_service / worker_service / realtime_service / ot_gateway_service
测试：simulation_tests / orchestration_tests / api_tests
前端：web_app + web_contracts / web_api_client / web_ui / web_widgets / web_charting /
      web_fab_scene / web_babylon_webgpu / web_state_sync
预留：fab_native / contracts_tests / e2e_tests / gpu_acceptance_tests / ot_conformance_tests /
      performance_tests / simulation_golden_tests / shared_resources
```

## 构建与验证

```powershell
# 单项目独立构建（无 solution）
dotnet build site_domain/site_domain.csproj
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
