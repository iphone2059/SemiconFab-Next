# fab_tests

合并自原 simulation_tests / orchestration_tests / api_tests：

- `SimulationTests.cs`：确定性 DES、FAB 隔离、Checkpoint、非法输入。
- `LocalOrchestrationTests.cs`：文件编排、幂等、租约 fencing、跨进程可见（自定义 `Main` 支持以子进程方式自调用）。
- `ApiTests.cs`：通过 `WebApplicationFactory<Program>` 验证 API 身份、Run 全链路与错误。

```powershell
dotnet test fab_tests/fab_tests.csproj -c Release
```
