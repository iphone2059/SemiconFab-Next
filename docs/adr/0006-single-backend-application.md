# ADR-0006 — 全部服务与宿主合并为单一 fab_app，测试合并为 fab_tests

- 状态：已采纳（2026-10-24）
- 关联：ADR-0001…0005；本 ADR 完成“一个后端、一个前端”的最终收敛

## 背景

ADR-0005 后仍有 22 个 .NET 项目：`fab_shared`、12 个业务域服务、2 个平台服务、4 个宿主、3 个测试项目。实际运行形态只是“一个 API 进程（可内嵌 Worker）+ 一个网站”；其中 10 个服务项目没有任何代码，4 个宿主里 2 个是 3 行占位。继续保留这些项目只会增加构建单元与引用维护成本。

## 决策

1. **单后端应用 `fab_app`**：合并 12 个域服务、2 个平台服务与 4 个宿主为一个 `Microsoft.NET.Sdk.Web` 可执行项目。
   - 同一入口按模式分发：默认 `api`；`--worker` / `--realtime` / `--ot`（后两者保留占位错误码 2）。
   - API 与 Worker 共享 `Fab__DataDirectory`；`Fab__EmbeddedWorker` 控制 API 是否内嵌 Worker；两种模式都要求 Development。
   - 原宿主代码拆为 `Program.cs`（模式分发）、`ApiHost.cs`、`WorkerHost.cs`；各域命名空间收敛为 `Fab.Site`、`Fab.Orchestration`、`Fab.Analytics`、`Fab.Identity`（去掉 Domain/Application/Infrastructure 后缀）。
   - API 保留 `public partial class Program` 以继续支持 `WebApplicationFactory<Program>` 集成测试。
2. **单测试项目 `fab_tests`**：合并 `simulation_tests` / `orchestration_tests` / `api_tests`；保留 orchestration 测试的自调用进程测试入口（Exe + `GenerateProgramFile=false` + 自定义 `Main`）。
3. **`fab_shared` 保持不变**：基础类型、生成契约、消息/可观测性/Host/配置/Profile/策略/优化抽象、M07/M08 仿真内核。
4. **前端 `web_app` 保持不变**。
5. 工具同步：`tools/check_architecture.py` 校验 3 个项目与模式分发；`scripts/verify.ps1` 按 3 个项目构建并运行 `fab_tests`；`start-dev.ps1` 改为启动 `fab_app`。

## 结果

- .NET 项目数 22 → **3**：`fab_shared`、`fab_app`、`fab_tests`；前端 1 个 `web_app`；全仓库 **4 个项目**。
- 运行：`dotnet run --project fab_app`（API）或 `dotnet run --project fab_app -- --worker`（Worker）；本地开发仍是 `scripts/start-dev.ps1`。
- 内容全部保留：21 个 `.cs` 文件、21 个测试用例、契约生成与 WebGPU 前端均未删减；后续若需拆分服务，可在 `fab_app` 内按命名空间/目录重新拆回项目。

## 命名空间收敛

- `fab_shared`：`Fab.Simulation.Core/Models/Runtime` → **`Fab.Simulation`**；`Fab.Ids`、`Fab.Contracts` 保留（公共契约与生成代码的稳定入口）。
- `fab_app`：`Fab.Site.Domain/Application` → `Fab.Site`；`Fab.Orchestration.Application/Infrastructure` → `Fab.Orchestration`；`Fab.Analytics.Application` → `Fab.Analytics`；`Fab.Identity.Infrastructure` → `Fab.Identity`；`Fab.App.Hosting` → `Fab.App`。
- `fab_tests`：三个测试命名空间 → **`Fab.Tests`**。

> 2026-10-24 目录整理：`fab_app` 与 `fab_shared` 的 C# 源码统一移入各自项目内的 `src/`（生成契约位于 `fab_shared/src/Generated/`），`fab_tests` 也已统一为 `fab_tests/src/`。
