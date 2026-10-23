# M09 — Scenario / Run / Worker 编排：开发项目架构与详细规范

> 模块编号：`M09`　|　主责任域：Platform Runtime　|　状态：`DESIGN_BASELINE`　|　受 `01`—`14` 规范与 `engineering/00` 共同约束。

## 1. 业务职责与范围

冻结 Scenario，提交 Run，领取 Job、Lease/Heartbeat、执行 Worker 拓扑调度、分发控制命令、结果提交与故障恢复。

### 拥有的领域对象

`ScenarioDraft`、`ScenarioVersion`、`Job`、`Run`、`RunExecution`、`WorkerLease`、`RunManifest`、`CheckpointReference`、`RunArtifact`。

### 边界与依赖

- 上游输入或参照：M01 Site; M07 DES; M08 Shared; M16 Identity。
- 下游消费者：M10 Analytics; M11 Web; M12 Scene; M18 Ops。
- 权威写入者：本模块的 Application + Domain；跨模块消费者只能通过公开 Contract/Port 获取派生事实。
- 数据范围：与 FAB 关联的对象必须携带 `SiteId/FabId`；Site 级对象不得借此取得 FAB 运行状态写权限。

## 2. 可落地的工程/程序集与目录

- `Fab.Orchestration.Domain`
- `Fab.Orchestration.Application`
- `Fab.Orchestration.Infrastructure`
- `apps/Fab.Worker`

领域模块建议内部目录（单个项目内部，不把每个文件都做程序集）：

```text
Fab.Orchestration.Domain/
  Aggregates/              # 领域聚合和强不变量
  Entities/                # 业务实体
  ValueObjects/            # 强类型 Id、单位、版本
  StateMachines/           # 显式状态与允许的跃迁
  Events/                  # 模块内领域事件
  Policies/                # 业务规则与算法
  Errors/                  # 有穷的业务错误分类
```

Application 项目建议含 `Commands/`, `Queries/`, `Ports/`, `Dtos/`, `Validators/`, `Registration/`；Infrastructure 含 `Persistence/`, `Mappings/`, `ExternalAdapters/`, `Outbox/`, `Migrations/`。纯仿真核心/前端包使用相同分层语义，但不强造无意义的 EF 仓储。

## 3. 接口清单与类型规范

公开 Ports / Services：`IScenarioRepository`、`IRunRepository`、`IJobLeaser`、`IWorkerLauncher`、`IRunArtifactCatalog`、`IRunCommandChannel`。

### 命令 API

| Command | 前置条件与结果 |
|---|---|
| `ValidateScenario` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `PublishScenario` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `SubmitRun` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `ClaimJob` | 以执行域短事务 CAS/锁领取并递增 LeaseEpoch；提交成功后才可执行，失败不得假定领取 |
| `Heartbeat` | 校验执行域、owner、未过期 epoch；使用数据库真实时间续期，不复活过期租约 |
| `PauseRun` | 持久化 CommandId/ExpectedVersion/目标执行域，Accepted 与安全边界 Applied 分开；共享域只允许全域暂停 |
| `ResumeRun` | PAUSED；验证有效租约或领取新租约并从完整 Checkpoint 恢复，不凭旧 epoch 续跑 |
| `StepRun` | 仅 PAUSED；持久化幂等控制命令并交 M07 恰好处理一个队列事件，共享模式仅全域单步 |
| `StopRun` | 非终态经 STOPPING 到 CANCELLED；已完成终态返回原结果/状态冲突，不伪装 COMPLETED |
| `FinalizeRun` | 当前有效租约提交校验完整的最终 Artifact/Manifest、状态与 Outbox，同一事务成功后才报告 COMPLETED |

### 查询 API

| Query | 返回/权限约束 |
|---|---|
| `GetRunStatus` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetJobQueue` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetRunManifest` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetLatestCheckpoint` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetWorkerHealth` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |

写操作具备 `IdempotencyKey`（适用时）、`ExpectedVersion`、`Actor/ServiceIdentity`、`CorrelationId` 和业务范围；读操作返回不可变 DTO，不直接返回 EF Entity 或持有 Babylon GPU 资源的对象。对高频 DES 事件，使用非异步的领域处理器，不把 REST 或 DB 接入仿真热循环。

## 4. Domain Events / Integration Events

| Event | 结构化契约要求 |
|---|---|
| `ScenarioPublished` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `RunQueued` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `ExecutionLeased` | 执行域租约事务已提交；带 execution_id、scope、owner、LeaseEpoch 与真实到期时间，不假定整个 Run 只有一个独立成员租约 |
| `RunRunning` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `RunPaused` | Run 汇总暂停状态已提交；所有尚未终止的成员均已到达暂停安全点，单个 FAB 的内核暂停事实不代表 Run 已暂停 |
| `RunCompleted` | 全部独立成员或唯一共享执行域均完成，且最终产物目录/Run 状态已在事务中提交后发布 |
| `RunFailed` | 按冻结重试/成员失败策略判定 Run 不可恢复并提交 FAILED 后发布，不直接转发一次内核报错 |
| `CheckpointCommitted` | 已校验的执行域快照/日志引用和水位通过当前有效租约事务登记后发布；区别于 M07 的 ExecutionCheckpointPrepared |
| `JobLeaseExpired` | M09 唯一发布；必须带执行域、失效 epoch、数据库真实到期时间和恢复策略引用；不作 DES 资源到期事件 |

事件类型的完整字段、同时间优先级、受影响实体、统计更新和版本兼容规则由本模块在 `contracts/` 中维护。通知性 IntegrationEvent 与 DES 内部权威 EventLog **区分存储与因果语义**。

M09 是 Run 生命周期 IntegrationEvents 的唯一发布者，消息与对应元数据变更同事务写 Outbox，并按 Run 版本去重。M07 的 `ExecutionStarted/Paused/Failed/Completed` 仅为执行域本地事实；M09 校验 scope/租约并依 `engineering/12` 汇总后，才产生对应 Run 事件。所有消息保留 owner、correlation、causation 与适用的仿真/真实时间；执行域事件和聚合 Run 事件不得复用同名契约混淆作用域。

## 5. 数据与存储

负责的数据：`simulation.scenarios`、`simulation.scenario_versions`、`simulation.runs`、`simulation.run_fabs`、`simulation.run_executions`、`simulation.checkpoints`、`simulation.run_artifacts` 与 Job/控制命令接纳记录。M07 提供日志/快照内容，M18 订阅健康事件；二者不能另行成为这些元数据的写入 Owner。

- 每张 FAB 所属表必须有适当的 `(site_id, fab_id)` 作用域、唯一键和复合关系约束；跨 FAB 数据关系须显式验证。
- 数据库中的投影、报表、事件分块和 DES 内存状态须明确权威性；不可在多数据源间形成无主的双向写入。
- 索引、行锁、事务隔离、Outbox 幂等由对应 repository 负责，并增加真实 PostgreSQL 集成测试。
- 长期存储与迁移按 `13-DATABASE-DETAIL-DESIGN.md`；文件型数据写 Manifest 和 SHA-256，拒绝不完整 Artifact。

## 6. 必须守护的领域不变量

- 独立执行域为 `(site_id, run_id, fab_id)`，共享执行域为 `(site_id, run_id)`；一次执行域唯一有效 LeaseEpoch。Run 可包含多个独立成员，不能以一条 Run 级租约阻止成员合法并行。共享模式只签发一个全域租约。
- 每个执行域 Claim/Heartbeat/应用命令回执/日志索引/Checkpoint/最终状态提交都在服务端核验当前 owner、未过期 epoch 与作用域。租约过期即拒绝旧主，旧主不可通过晚到 Heartbeat 恢复权威。对象用 execution/epoch/unique upload 路径不可变写入，目录提交才算持久化。
- 持久化 FSM 使用 `QUEUED/CLAIMED/RUNNING/PAUSED/STOPPING/COMPLETED/FAILED/CANCELLED`；初始化/暂停中/恢复中/完成中是阶段。终态不可复活，租约失效按策略恢复或 FAILED，不混用 Succeeded/Interrupted 等第二套状态。Run 汇总与恢复规则见 `engineering/12`。
- 相同幂等键在认证主体/作用域及命令类型内只创建一个 Run/应用一次控制命令；同键不同 payload 冲突。控制命令记录稳定请求序与实际应用边界，不把 API 收到请求等同于引擎已执行。
- CheckpointEpoch、日志持久化水位、Worker LeaseEpoch 分别维护；共享域整体快照与恢复。新租约保留模型 GrantVersion，不把 Worker fencing 当作仿真容量失效。
- 冻结 Scenario 校验全部依赖哈希、RNG UInt64 master seed/派生规则与 FAB 成员；新 Run 对相同定义重新实例化，禁止共享 mutable 状态、去重记录或 SiteResource 账本。

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

- T-01 两 Worker Claim 同执行域不双提交，不同独立 FAB 成员可同时领取；T-02 旧主在租约到期/新主接管后 Heartbeat、Checkpoint、日志索引、Finish 均被拒绝；T-03 重复/乱序 Pause/Resume/Stop 以版本及 CommandId 处理，Accepted/Applied 可区分；T-04 对象上传完成但目录事务失败不标成功；T-05 共享域无成员级独立租约或局部恢复；T-06 无 Checkpoint/存在未提交日志尾部时按声明策略重建且不重复外部效果。
- 每个命令必须有非法状态和跨 FAB 授权负测；每个重要事件有 Schema backward compatibility 与重放验证。
- 检查模块内 `Domain` 不依赖数据库/HTTP/GPU；单测无需外部服务即可运行。
- 真实协议、GPU、数据库、共享容量性能，须在对应设施/驱动/版本环境下集成验收，不能仅使用 mock 声称已验证。

### Definition of Done

- [ ] 项目与包在主仓库可构建，静态检查通过。
- [ ] 公开 Ports 与契约已发布，版本和单位明确。
- [ ] 主要 StateMachine/Invariant 单测和跨 FAB 隔离测试通过。
- [ ] 数据迁移/契约升级/回退方案已评审。
- [ ] 日志、指标、告警和追踪字段齐备，敏感字段已脱敏。
- [ ] 对应阶段 G0—G8 的验收证据有固定 URI 和 Review 记录。

## 9. 特殊风险与设计提醒

Job 调度是 WallClock 管理，DES Clock 是模拟时间，两者不能混淆。
