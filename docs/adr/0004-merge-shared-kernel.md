# ADR-0004 — 共享内核合并为单一 fab_shared 项目

- 状态：已采纳（2026-10-24）
- 关联：在 ADR-0001/0002/0003 的扁平、独立、一域一项目原则下继续收敛共享库粒度

## 背景

ADR-0002 后共享内核仍有 10 个独立项目：`fab_ids`、`fab_contracts`、`fab_contracts_adapters`、`fab_messaging`、`fab_observability`、`fab_hosting`、`fab_configuration`、`fab_industrial_profiles`、`fab_security_policies`、`fab_optimization_abstractions`。其中 8 个当前只有脚手架，10 个项目都要单独构建、单独维护引用，与“按名字关联、尽量少项目”的偏好不一致。

## 决策

1. 10 个共享库合并为 **单一共享内核项目 `fab_shared`**（命名空间保持不变：`Fab.Ids`、`Fab.Contracts` 等）。
2. 代码资产：
   - `StableId.cs`（`Fab.Ids`）
   - `Generated/Contracts.g.cs`（由 `tools/generate_contracts.py` 生成，路径改为 `fab_shared/Generated/Contracts.g.cs`）
   - 其余消息/可观测性/Host/配置/行业 Profile/安全策略/优化抽象保留在项目 README 与命名空间中，后续在本项目内实现。
3. 引用规则：
   - 业务服务、平台服务、`simulation_engine`、宿主都只引用 `fab_shared`（外加允许的 `simulation_engine` 共享库）。
   - `fab_shared` 不引用任何项目，也不带 NuGet 包；保留 ASP.NET Core FrameworkReference（原 Hosting/Observability 需要）。
4. 工具同步：`tools/check_architecture.py` 校验 23 个项目、单共享内核与引用规则；`scripts/verify.ps1` 按 23 个项目构建。

## 结果

- .NET 项目数 32 → **23**（1 共享内核 + 12 域服务 + 2 平台服务 + 1 仿真引擎 + 4 宿主 + 3 测试）；前端仍为 1 个 `web_app`。
- 所有服务统一 `../fab_shared/fab_shared.csproj`，依赖关系更简单；契约生成输出路径同步调整。
