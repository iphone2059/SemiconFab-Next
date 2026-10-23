# ADR-0001 — 扁平、独立的项目布局

- 状态：已采纳（2026-10-23）；项目粒度后续由 ADR-0002 调整（三层合并为单一 `*_service`）；前端包边界由 ADR-0003 调整（合并为单一 `web_app`）；共享库粒度由 ADR-0004 调整（合并为单一 `fab_shared`）；仿真引擎由 ADR-0005 并入 `fab_shared`；最终项目粒度由 ADR-0006 收敛为 `fab_shared` + `fab_app` + `fab_tests`
- 取代：`SemiconFab-Next-Engineering-v1.1/engineering/10-REPOSITORY-SOLUTION-LAYOUT.md` 中“单一 solution + src/apps/tests 容器”的仓库布局（外部规范包本身不修改）

## 背景

v1.1 规范的仓库布局按 `src/<Context>/Fab.X.Layer/` 嵌套，并用一个 `SemiconFab.slnx` 汇总全部项目。实际使用中提出：模块化、微服务化、完全扁平，所有项目同级，项目名使用全小写 + 下划线 `xx_yy_zz`，只靠名字建立联系与区分；同时不要总 solution，所有子项目完全独立。

## 决策

1. **全部同级**：65 个 .NET 项目与 9 个前端包目录直接位于仓库根目录，不设 `src/`、`apps/`、`tests/`、`frontend/` 容器。
2. **无总 solution**：仓库不包含 `*.sln` / `*.slnx`；任意项目可单独 `dotnet build` / `dotnet test` / `dotnet run`。
3. **项目自包含**：删除根级 `Directory.Build.props` 与 `Directory.Packages.props`；每个 csproj 显式声明 TargetFramework、Nullable、ImplicitUsings、TreatWarningsAsErrors、Deterministic、依赖包版本与 lock file 设置。
4. **命名规则**：全小写 + 下划线，`{域}_{角色}`。角色后缀：`_domain`、`_application`、`_infrastructure`、`_service`、`_tests`；共享库以 `fab_` 开头；前端以 `web_` 开头。
5. **按名字关联**：后端仅通过显式相对 `ProjectReference` 关联，路径形如 `../fab_contracts/fab_contracts.csproj`；前端仅通过 pnpm 包名（`@fab/...`）关联。
6. **共享的只有工具链**：根目录仅保留 `global.json`（SDK 版本）、`NuGet.Config`、`.editorconfig`、`.gitignore`、前端 pnpm workspace 与文档/工具目录；它们不参与任何项目编译依赖。

## 命名映射（族）

| 旧 | 新 |
|---|---|
| `Fab.X.Domain/Application/Infrastructure` | `x_domain` / `x_application` / `x_infrastructure` |
| `Fab.Simulation.Core/Models/Runtime/SiteCoordinator/NativeBridge` | `simulation_core` / `simulation_models` / `simulation_runtime` / `simulation_site_coordinator` / `simulation_native_bridge` |
| `Fab.Eap.*` | `eap_*` |
| `Fab.IndustrialInterfaces.*` | `industrial_interfaces_*` |
| `Fab.Contracts` / `Fab.Ids` / 其它 Foundation | `fab_contracts` / `fab_ids` / `fab_*` |
| `Fab.Contracts.Adapters` | `fab_contracts_adapters` |
| `Fab.Optimization.Abstractions` | `fab_optimization_abstractions` |
| `Fab.IndustrialProfiles` / `Fab.SecurityPolicies` | `fab_industrial_profiles` / `fab_security_policies` |
| `apps/Fab.Api` 等宿主 | `api_service` / `worker_service` / `realtime_service` / `ot_gateway_service` |
| `tests/.../Fab.*.Tests` | `simulation_tests` / `orchestration_tests` / `api_tests` |
| `apps/web` + `frontend/packages/*` | `web_app` + `web_*`（npm 包名保持 `@fab/*` 不变） |
| `native/Fab.Native` / 预留测试目录 | `fab_native` / 根级 `*_tests` 与 `shared_resources` |

C# 命名空间保持 PascalCase（`Fab.Site.Domain` 等），项目/程序集名使用小写下划线；两者通过 csproj 的 `RootNamespace` 明确绑定。

## 后果

- 无法再用一个 solution 一次性构建全部项目；`scripts/verify.ps1` 改为枚举根目录所有 csproj，逐项目独立构建与测试。
- 模块文档、工具与前端 workspace 路径已同步更新；旧布局完整保留在基线提交 `165ba28`，可供对照或回滚。
- 工程规范（依赖方向、Domain/Contracts 纯度、前端引擎边界、模块档案数量）继续由 `tools/check_architecture.py` 强制。

> 2026-10-24 备注：原预留空目录（`fab_native`、`contracts_tests`、`e2e_tests`、`gpu_acceptance_tests`、`ot_conformance_tests`、`performance_tests`、`simulation_golden_tests`、`shared_resources`）已删除；未来需要时再按需创建（测试仍归入 `fab_tests` 或新项目）。
