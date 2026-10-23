# orchestration_application

公开 `IRunService.Submit(CreateRunRequest,string principal,string key)`、`Get(Guid)`、`List()`、`GetResults(Guid)`；DTO 来自 fab_contracts。`ISimulationExecutionPort.Execute` 是可注入的同步引擎端口。`ExecutionLease` 携带冻结场景、Run/FAB、owner、epoch 与租期。

同幂等范围异请求抛 `IdempotencyConflictException`；失租提交抛 `LeaseLostException`，均不依赖 HTTP。成员业务目录校验由宿主执行，场景结构/数值校验由基础设施调用引擎验证入口。当前没有暂停、停止、失败重试和 checkpoint 编排接口。
