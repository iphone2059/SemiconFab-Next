# M07 — 确定性离散事件仿真核心：开发项目架构与详细规范

> 模块编号：`M07`　|　主责任域：Simulation Platform　|　状态：`DESIGN_BASELINE`　|　受 `01`—`14` 规范与 `engineering/00` 共同约束。

## 1. 业务职责与范围

掌握 SimulationClock、EventQueue、PRNG、状态分区、事件处理器、Checkpoint 和权威 EventLog；任何规则都不能依赖真实时间推进。

M07 负责事件执行与 Checkpoint/日志编解码；M09 唯一持有 Run/执行域 Job、Lease、产物目录与状态事务写入权。M07 通过 Ports 请求 M09 登记持久化边界，不直接维护第二套 `simulation.runs/checkpoints` 仓储。共享执行循环仍由 M07 掌握，M08 提供资源策略及 `Fab.Simulation.SiteCoordinator` 装配，不另建互相竞争的调度循环。

### 拥有的领域对象

`SimulationRunState`、`EventEnvelope`、`DeterministicQueue`、`RandomStream`、`FabRuntimePartition`、`CheckpointState`。

### 边界与依赖

- 上游输入或参照：M01 Template; M02/M03/M04/M05/M06/M13 domain adapters。
- 下游消费者：M08 SiteResources; M09 Orchestration; M10 Analytics; M12 3D。
- 权威内存写入者：当前执行域唯一的确定性执行器；Runtime 装配 Core/Models，跨模块消费者通过公开 Contract/Port 获取派生事实，持久化目录由 M09 提交。
- 数据范围：与 FAB 关联的对象必须携带 `SiteId/FabId`；Site 级对象不得借此取得 FAB 运行状态写权限。

## 2. 可落地的工程/程序集与目录

- `Fab.Simulation.Core`
- `Fab.Simulation.Models`
- `Fab.Simulation.Runtime`
- `Fab.Simulation.NativeBridge`

内核建议内部目录（纯类库，不强套业务持久化分层）：

```text
Fab.Simulation.Core/
  Scheduling/              # 稳定队列、入队顺序与推进边界
  Time/                    # 虚拟时钟与时间校验
  Randomness/              # 可序列化随机流及确定性派生
  Events/                  # 内核事件与纯处理接口
  Diagnostics/             # 不变量、无进展与错误分类
```

`Models` 持有冻结输入、运行态与纯处理规则；`Runtime` 含执行、Checkpoint 编解码、Replay 与持久化 Ports。数据库、对象存储和 Outbox 的具体 Adapter 由 Host/M09 装配，不在 Core 建 EF 仓储、Outbox 或 Migration 项目。

## 3. 接口清单与类型规范

公开 Ports / Services：`IEventScheduler`、`IEventHandler<T>`、`IDeterministicPrng`、`ICheckpointCodec`、`IAuthoritativeEventWriter`、`INativeKernelPort`。

Core 仅依赖强 ID、无 IO 抽象和纯模型契约；Runtime/Models 通过冻结输入与纯域行为适配装配，不引用其他业务模块的 Application/Infrastructure。调度策略扩展接口 `IDispatchingPolicy` 位于纯 `Fab.Optimization.Abstractions`，M07 消费、M17 实现，避免为加载优化策略形成反向项目依赖。

### 命令 API

| Command | 前置条件与结果 |
|---|---|
| `InitializeRun` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `ScheduleEvent` | 仅执行器或持久化接纳的输入适配器可调用；验证执行域、完整顺序键严格向前、Schema 与因果来源 |
| `StepOne` | 仅 PAUSED；执行恰好一个队列事件后仍 PAUSED，空队列返回 NoEvent，共享模式覆盖全域 |
| `RunUntil` | 截止仿真时间不得早于当前时刻；边界是否包含截止点冻结于契约，完成不得遗漏同时间尚应处理的事件 |
| `PauseAtSafePoint` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `StopRun` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `CreateCheckpoint` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `RestoreCheckpoint` | 仅初始化/恢复阶段；验证完整执行域、已提交 Manifest、版本/哈希和连续持久化水位，不在运行中覆盖局部状态 |

### 查询 API

| Query | 返回/权限约束 |
|---|---|
| `GetSimulationTime` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetPendingEventCount` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetRunMetrics` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `InspectRunState` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `ReplayEventRange` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |

外部控制由 M09 先完成授权、幂等和版本校验，再交 Runtime 在安全边界应用；不要求每个内部 `ScheduleEvent` 携带 HTTP 幂等键或用户身份。查询返回不可变执行诊断 DTO，不返回可写状态引用。高频 DES 事件使用同步纯处理器，不把 REST、Outbox 事务或数据库接入热循环。

## 4. 执行域本地事实与 Port 回报

| Event | 结构化契约要求 |
|---|---|
| `ExecutionStarted` | 内核执行域已完成初始化并开始执行；带 execution_id、scope、当前租约和初始边界 |
| `ExecutionEventApplied` | 单个 DES 事件已在内存原子应用；带权威 event_seq 和 durable_event_seq，不声称已经持久化 |
| `ExecutionPaused` | 当前执行域已到达暂停安全点；带 CommandId、实际应用边界与状态摘要 |
| `ExecutionCheckpointPrepared` | 完整快照与所需日志已准备并校验；带执行域、边界与内容引用，仍需 M09 事务登记才成为有效恢复点 |
| `ExecutionFailed` | 当前执行域发生内核错误；带错误分类、最后有效边界及诊断，不直接决定整个 Run 的终态 |
| `ExecutionCompleted` | 当前执行域满足冻结完成条件；带最终事件边界和候选产物引用，不等同 Run 完成或结果目录已提交 |

这些是 M07 本地执行事实/Port 回报，均标明 execution_id、独立 FAB 或共享 Run scope、causation 及当前事件边界；不额外入 DES 队列，也不把 `StepOne` 扩大为多个事件。M09 校验当前租约并完成元数据/产物事务后，唯一通过 Outbox 发布 Run 生命周期 IntegrationEvents。独立模式一个 FAB 的 `ExecutionCompleted` 不能触发尚有未完成成员的 `RunCompleted`；恢复重放不能再次发布这些外部生命周期效果。

内部 DES 事件另行声明时间、优先级、状态转移和统计影响；本表是执行控制回报。需要跨进程传输时再定义版本化契约，不能把本地回调直接当成公共 IntegrationEvent。

## 5. 数据与存储

负责的数据内容：运行内存状态、Checkpoint 编码与 `objectstore/eventlogs` 事件内容；`simulation.runs/run_executions/checkpoints/run_artifacts` 的目录/租约/状态由 M09 唯一写入。M07 提交不可变内容与哈希给其持久化 Port，不能同时对同一元数据表声明第二个 Owner。

- 内容与查询均携带明确的执行域；不同 FAB/Run 的可变状态、日志和去重记录不可串用。
- 数据库读投影不能覆盖内存状态或变成第二个权威事件队列。
- 文件内容写 Manifest 和 SHA-256，拒绝不完整 Artifact；上传与目录提交之间的失败由 M09 恢复协议处理。
- 目录表约束、索引、行锁、RLS 和迁移由 M09/基础设施按 `engineering/13` 实施并集成验收；M07 只验证内容编解码及恢复一致性，不重复声明元数据写权限。

## 6. 必须守护的领域不变量

- 队列键 `(time, priority, enqueue_sequence)` 与已处理日志 `event_seq` 分开；初始事件和子事件按冻结稳定身份/局部顺序产生，序号只能由唯一执行器分配。新事件不得早于已处理完整键，同时间不能返回已关闭优先级阶段，零时间无进展按冻结上限诊断终止。
- 独立执行域为 `(site_id, run_id, fab_id)`；共享域为 `(site_id, run_id)`，全部分区使用同一队列和因果日志位置。跨 Run 的可变状态、RNG、事件去重与资源账本完全隔离。
- 一次事件的出队、Clock、实体、RNG、统计、子事件和内存日志必须原子处理；失败不能继续使用部分变更的内存。完整 Checkpoint 保存 next enqueue sequence、last processed key/event_seq、输入/命令去重以及 ResourceLedger 等状态。
- 恢复只重放快照之后已提交连续日志；按 05 重新执行并验证摘要，不再叠加结果 Delta，不重发外部效果；共享域整体恢复，不拼接不同边界的 FAB 快照。
- 语义哈希使用规范序列化并排除 RunId、真实时间、租约和传输元数据；PRNG 派生算法/编码冻结，所有会影响时间、分支、仲裁的数值计算保证相同离散决策。

### 三 FAB / 共享模式行为

- `INDEPENDENT`：业务写入和事件执行保持 FAB 隔离；查询与 UI 订阅按授权范围过滤，允许专门授权的 Site 只读汇总。当前三个 FAB 的模板相同并不使其共享 Mutable State。
- `SHARED_CAPACITY`：只有 `M07` 确定性执行器与 `M08 SiteResourceAuthority/SiteCoordinator` 的**正式接口**可参与 Site 共用容量争用；所有资源授予具有虚拟时间顺序和可回放记录。
- 在没有明确的 `SiteResourceDefinition` 或跨 FAB 业务配置时，不得推断存在共享设施，也不得在当前版本自动进行跨 FAB 物料转移。

## 7. 典型流程与异常处理

1. 入口适配层接收命令或仿真 Event，校验 Auth Scope、SchemaVersion、ExpectedVersion、RequiredCapability。
2. Application 读取必要的冻结定义或当前聚合，调用 Domain StateMachine/Policy；违反不变量返回结构化 DomainError，不得部分成功。
3. 同一事务提交本域持久化变更与 Outbox；DES 热循环按已冻结 EventHandler 在内存中提交事件，再通过 Checkpoint/Log 刷盘。
4. 其它模块只通过公开事件/Contract/Port 更新自己的投影；一旦失败按 `retry / dedup / compensate / dead-letter` 策略处理。
5. 指标和审计带上 `site_id/fab_id/run_id/trace_id`；现场遥测与模拟流以不同 source 标识，禁止混入同一个权威状态。

## 8. 测试、交付和验收

- T-01 同冻结输入/seed/hash 的语义事件与状态 hash 一致；T-02 含 RNG、等待授权与子事件的 Checkpoint 恢复后结果一致；T-03 事件暂存失败/日志半写/孤立上传注入，不丢已提交连续前缀且无部分转移；T-04 PAUSED 单步恰好一个事件，空队列 NoEvent；T-05 后端可无 GPU 运行；T-06 同时间较早优先级子事件拒绝、零时间循环可诊断；T-07 同 Site 多 Run 的语义轨迹隔离。
- 每个命令必须有非法状态和跨 FAB 授权负测；每个重要事件有 Schema backward compatibility 与重放验证。
- 检查 Core/Models 不依赖数据库、HTTP、GPU 或业务 Application；纯内核测试无需外部服务，持久化故障通过 Port 注入。
- 真实协议、GPU、数据库、共享容量性能，须在对应设施/驱动/版本环境下集成验收，不能仅使用 mock 声称已验证。

### Definition of Done

- [ ] 项目与包在主仓库可构建，静态检查通过。
- [ ] 公开 Ports 与契约已发布，版本和单位明确。
- [ ] 主要 StateMachine/Invariant 单测和跨 FAB 隔离测试通过。
- [ ] 数据迁移/契约升级/回退方案已评审。
- [ ] 日志、指标、告警和追踪字段齐备，敏感字段已脱敏。
- [ ] 对应阶段 G0—G8 的验收证据有固定 URI 和 Review 记录。

## 9. 特殊风险与设计提醒

必须将热路径 State 与 EF/REST/UI 隔离；不能以 async Task.Delay 或 WallClock 定义模拟时间。
