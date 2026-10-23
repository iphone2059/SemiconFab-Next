# Fab.Simulation.Runtime

公共入口：

```csharp
var engine = new FabSimulation();
FabSimulation.Validate(scenario); // ArgumentException 派生异常表示输入无效
var result = engine.Execute(scenario, fabId, cancellationToken);
var session = engine.Start(scenario, fabId);
session.StepOneEvent(cancellationToken); // 恰好一个事件；达到观察终点返回 false
var checkpoint = session.CreateCheckpoint(); // System.Text.Json 可序列化
var resumed = engine.Resume(checkpoint);
var sameResult = resumed.RunToCompletion(cancellationToken);
```

会话属于单一调用方，不支持并发 Step/Checkpoint。事件阶段 v1：`LotReleased=0`、`OperationCompleted=1`、`OperationStarted=2`；同时间子事件必须位于父事件之后。初始 Lot 用 1..N 枚举。事件日志从 1 连续编号，独立于入队序号。

输入接受 contractVersion=1、INDEPENDENT、1..32 FAB、各 1..10000 Lot。Site/FAB 为非零 D 格式 UUID；ID 规范化为小写。FAB code 是 1..64 ASCII 字母/数字/连字符/下划线且不区分大小写唯一。64 位数使用无符号/无空格/无多余前导零十进制字符串，seed 范围 UInt64，时间范围非负 Int64，加工时间和时长非零，warmup < duration。最坏整批加工时间溢出时拒绝。应用层负责 Site 目录成员授权；内核检查所选 FAB 必须存在于场景内。

只执行时间 `< durationUs` 的事件。完成数统计 `[warmupUs,durationUs)` 内的完成事件；busyTimeUs 为所有设备服务区间与该观察窗的交集，含在终点仍未完成的加工部分；simulationTimeUs 总是观察终点。每 FAB 至多 30000 个事件，事件间检查取消并抛 OperationCanceledException，不生成成功结果。Checkpoint/Step 不消费额外随机数。

检查点 schema v1 包括冻结场景、引擎版本、时钟、完整有序队列、最后事件键、下一个入队序号、执行/快照日志水位、RNG state、等待队列、设备状态、统计量及全部已处理日志。载荷 SHA-256 校验，恢复还在最多 30000 事件内重放校验完整状态，再安装快照。此校验不是认证/签名。恢复成本 O(已处理事件数)，尚无分块日志或快速可信恢复优化。检查点调用方须自己可靠持久化整个对象；此 API 不声明数据库提交、Worker 租约 fencing、任意崩溃瞬间恢复或外部持久化水位。

成员语义轨迹哈希 v1 为固定声明字段顺序的 System.Text.Json UTF-8 SHA-256：模型版本、当前 FAB ID/code/输入、观察窗、统计量、RNG state 和当前 FAB 日志。排除 Site/RunId、整体场景标识、其他 FAB 和墙钟。当前版本在 .NET 11 范围冻结编码；修改编码或模型须升级版本。

2026-10-23 验证命令：`dotnet test tests/Unit/Fab.Simulation.Tests/Fab.Simulation.Tests.csproj --verbosity minimal`。TDD 首轮：19 failed/0 passed（占位 API NotImplementedException）；实现后 19 passed；队列重用序号约束：1 failed/24 passed，再修复后 25 passed；规范十进制补充：5 failed/25 passed，再修复后 30 passed/0 failed。SDK 为 11.0.100-rc.2.26504.105；仅输出 SDK preview 提示，无编译警告/错误。覆盖每个事件边界的检查点 JSON 往返/恢复最终结果一致、固定 RNG 向量、FIFO、FAB 隔离、非法输入、取消、窗口边界、最大 10000 Lot 与篡改拒绝。无全 solution、跨平台、真实工厂或性能验收。
