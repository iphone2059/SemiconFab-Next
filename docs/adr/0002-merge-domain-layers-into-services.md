# ADR-0002 — 每个域的三层合并为单一服务项目

- 状态：已采纳（2026-10-23）
- 关联：前端包边界由 ADR-0003 调整；仿真引擎由 ADR-0005 并入 `fab_shared`。在 [ADR-0001](0001-flat-project-layout.md) 的扁平、独立、无总 solution 原则之上调整项目粒度

## 背景

ADR-0001 落地后，12 个业务域仍是 `x_domain` / `x_application` / `x_infrastructure` 三个并列项目（EAP、工业接口、仿真同样多项目）。这带来跨项目引用、构建单元过多、与“微服务化、每个域一个自包含服务”的目标不一致。

## 决策

每个域合并为一个单一服务项目，内部不再拆子项目：

- 12 个业务域：`site_service`、`manufacturing_service`、`process_engineering_service`、`equipment_service`、`material_handling_service`、`maintenance_service`、`quality_service`、`site_resources_service`、`orchestration_service`、`experiment_service`、`analytics_service`、`identity_service`。
- EAP：`eap_service`；工业接口：`industrial_interfaces_service`；仿真内核：`simulation_engine`。
- 共享内核后续按 ADR-0004 合并为单一 `fab_shared`；本 ADR 列出的 10 个共享库已不再单独成项目。原列：

`fab_ids`、`fab_contracts`、`fab_contracts_adapters`、`fab_messaging`、`fab_observability`、`fab_hosting`、`fab_configuration`、`fab_industrial_profiles`、`fab_security_policies`、`fab_optimization_abstractions`。
- 宿主保持独立：`api_service`、`worker_service`、`realtime_service`、`ot_gateway_service`；测试：`simulation_tests`、`orchestration_tests`、`api_tests`。

## 关联规则

- 各服务项目只引用共享内核；服务之间不互相引用（不新增跨域编译依赖）。
- 例外仅限 `orchestration_service` 引用共享仿真库 `simulation_engine`（Run 执行需要引擎类型），以及宿主/测试对服务项目的组合引用。
- 原三层代码（Domain/Application/Infrastructure）现在位于同一项目内，命名空间保持 `Fab.<域>.*` 不变，后续可通过项目内部目录组织，而不是再拆 csproj。
- 服务项目保留 ASP.NET Core FrameworkReference（原 Application/Infrastructure 需要），纯共享库继续受无 I/O 规则约束。

## 结果

- .NET 项目数由 65 降为 **32**（10 共享 + 12 域服务 + 2 平台服务 + 1 仿真引擎 + 4 宿主 + 3 测试），前端仍为 9 个包。
- `tools/check_architecture.py` 改为校验“服务不互相引用、只依赖共享内核”、项目名、自包含 csproj、DAG、模块档案数量与前端边界。
- `scripts/verify.ps1` 按 32 个项目逐项目独立构建并运行 3 个测试项目；无总 solution。
