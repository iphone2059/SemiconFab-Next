# fab_tests

合并自原 simulation_tests / orchestration_tests / api_tests：

当前产品默认开发目录播种 1 个 FAB（FAB-01）；架构支持 `Fab:FabCount` 1..32 个相互独立的 FAB。数组契约、确定性 FAB 身份及按 FAB 划分的状态与授权边界必须保持多 FAB 语义；多 FAB 架构用例通过显式 `Fab:FabCount=3` 等配置覆盖，不得把架构能力退化为单 FAB 假设。

- `src/SimulationTests.cs`：确定性 DES、单 FAB 的 Site 元数据独立性、Checkpoint、非法输入（含外来身份、重复成员/代码与成员数量上限拒绝）。
- `src/LocalOrchestrationTests.cs`：文件编排、幂等、租约 fencing、跨进程可见（自定义 `Main` 支持以子进程方式自调用）。
- `src/ApiTests.cs`：通过 `WebApplicationFactory<Program>` 验证单 FAB 默认种子、配置范围拒绝、API 身份、Run 全链路与错误。
- 命令、遥测和设备测试保留单 FAB 生命周期、独立连接/服务实例及已知 FAB 授权拒绝覆盖；未知/外来 FAB 身份仅用于拒绝和过滤断言，不代表第二个活动 FAB。

```powershell
dotnet test fab_tests/fab_tests.csproj -c Release
```