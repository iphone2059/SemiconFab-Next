# ADR-0005 — 仿真引擎并入 fab_shared

- 状态：已采纳（2026-10-24）
- 后续：ADR-0006 将全部域服务、平台服务与宿主合并为单一 `fab_app`，测试合并为 `fab_tests`。
- 关联：继续收敛 ADR-0004 的共享内核

## 背景

ADR-0004 后仍保留独立项目 `simulation_engine`（M07/M08 的 Core/Models/Runtime 与协调器代码），由 `orchestration_service` 与 `simulation_tests` 引用。它本质上是可以被多个组件复用的确定性子系统，与共享内核同属“被依赖的基础设施”，单独成项目只会增加引用与构建单元。

## 决策

1. `simulation_engine` 的代码与文档并入 **`fab_shared`**：
   - `FabSimulation.cs`、`FabSimulationSession.cs`、`SyntheticFifoModel.cs`、`StableEventQueue.cs`、`SplitMix64.cs`
   - 命名空间保持 `Fab.Simulation.Core/Models/Runtime`。
2. 所有引用 `simulation_engine` 的项目改为只引用 `fab_shared`：`orchestration_service` 现在仅依赖共享内核；`simulation_tests` 直接引用 `fab_shared`。
3. `fab_shared` 保持“不引用任何业务项目、不带 NuGet 包”；保留 ASP.NET Core FrameworkReference（Host/可观测性等组件需要，仿真代码本身不依赖 I/O）。
4. 工具同步：`tools/check_architecture.py` 校验 22 个项目，并断言仿真核心文件仍在共享内核中；`scripts/verify.ps1` 按 22 个项目构建。

## 结果

- .NET 项目数 23 → **22**：1 共享内核 + 12 域服务 + 2 平台服务 + 4 宿主 + 3 测试；前端仍为 1 个 `web_app`。
- 依赖图进一步简化：除宿主组合服务外，所有服务只指向 `fab_shared`。
