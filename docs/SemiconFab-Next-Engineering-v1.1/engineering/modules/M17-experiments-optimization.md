# M17 — 实验计划、调度优化与 RL 适配：开发项目架构与详细规范

> 模块编号：`M17`　|　主责任域：Operations Research/ML　|　状态：`DESIGN_BASELINE`　|　受 `01`—`14` 规范与 `engineering/00` 共同约束。

## 1. 业务职责与范围

管理多场景实验、可复现 seed、Warmup/Observation、策略矩阵、统计显著性、RL step 接口与训练数据导出。

### 拥有的领域对象

`ExperimentPlan`、`PolicyVersion`、`ReplicationSet`、`RandomizationPlan`、`ExperimentResult`、`ConfidenceInterval`。

### 边界与依赖

- 上游输入或参照：M07 DES; M09 Orchestration; M10 Analytics; M02 MES。
- 下游消费者：M11 UI; external ML/RL agents。
- 权威写入者：本模块的用例与领域规则控制所属定义、台账或投影；模拟运行中的可变状态由 M07 在 Run 执行域内按这些规则推进，不能与数据库形成双权威。跨模块只使用公开 Contract/Port。
- 数据范围：与 FAB 关联的对象必须携带 `SiteId/FabId`；Site 级对象不得借此取得 FAB 运行状态写权限。

## 2. 可落地的工程/程序集与目录

- `Fab.Experiment.Domain`
- `Fab.Experiment.Application`
- `Fab.Experiment.Infrastructure`
- `Fab.Optimization.Abstractions`

领域模块建议内部目录（单个项目内部，不把每个文件都做程序集）：

```text
Fab.Experiment.Domain/
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

公开 Ports / Services：`IPolicyEvaluator`、`IReplicationScheduler`、`IRlStepEnvironment`、`IExperimentStatistics`。`IDispatchingPolicy` 定义于无 I/O 的 `Fab.Optimization.Abstractions`，M07 消费该抽象、M17 提供策略实现，禁止 M07 反向引用 Experiment.Application/Infrastructure。

### 命令 API

| Command | 前置条件与结果 |
|---|---|
| `CreateExperiment` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `AddPolicy` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `FreezeReplicationPlan` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `ExecuteReplications` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `EvaluatePolicy` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `ExportTrainingSet` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |

### 查询 API

| Query | 返回/权限约束 |
|---|---|
| `GetExperimentComparison` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetPolicyRanking` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetReplicationManifest` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetConfidenceIntervals` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |

写操作具备 `IdempotencyKey`（适用时）、`ExpectedVersion`、`Actor/ServiceIdentity`、`CorrelationId` 和业务范围；读操作返回不可变 DTO，不直接返回 EF Entity 或持有 Babylon GPU 资源的对象。对高频 DES 事件，使用非异步的领域处理器，不把 REST 或 DB 接入仿真热循环。

## 4. Domain Events / Integration Events

| Event | 结构化契约要求 |
|---|---|
| `ExperimentSubmitted` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `ReplicationCompleted` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `ComparisonCalculated` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `ModelEvaluated` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |

公开事件的字段、owner、时间语义和兼容规则在 `contracts/` 中维护；仅实际进入 DES 的事件定义同时间优先级、实体影响与统计更新。通知性 IntegrationEvent 与 DES 内部权威 EventLog 区分存储与因果语义。

## 5. 数据与存储

负责的数据：`simulation.experiments`、`simulation.policy_versions`（物理 schema 共享不改变 M17 的逻辑所有权）；`analytics.experiment_comparisons` 由 M10 写入，本模块请求计算并消费结果；Run/Checkpoint/Artifact 元数据仍归 M09。

- FAB 所属表使用 `(site_id, fab_id)` 作用域与复合关系约束；Site 级定义使用 Site 作用域，不伪造 fab_id；跨 FAB 关联须显式验证。
- 数据库中的投影、报表、事件分块和 DES 内存状态须明确权威性；不可在多数据源间形成无主的双向写入。
- 索引、行锁、事务隔离、Outbox 幂等由对应 repository 负责，并增加真实 PostgreSQL 集成测试。
- 长期存储与迁移按 `13-DATABASE-DETAIL-DESIGN.md`；文件型数据写 Manifest 和 SHA-256，拒绝不完整 Artifact。

## 6. 必须守护的领域不变量

合法 RL action（含协议允许的 wait/no-op）必须交给 M07 校验并执行，推进到下一决策点或已定义终止边界；非法 action 不改变状态。reward/terminated/truncated、步进上限与取消语义必须定义；策略版本、场景版本、seed/CRN 方案和决策输入写入复现证据，重放不依赖外部 Agent 响应时序。

### 三 FAB / 共享模式行为

- `INDEPENDENT`：业务写入与事件执行限制在所属 FAB 执行域；查询和 UI 订阅按授权范围过滤，允许 Site 角色只读汇总多个 FAB；相同模板不使 FAB 共享 Mutable State。
- `SHARED_CAPACITY`：只有 M07 确定性执行器与 M08 `SiteResourceAuthority/SiteCoordinator` 的正式接口可参与 Site 共用容量争用；所有资源授予具有虚拟时间顺序和可回放记录。
- 在没有明确的 `SiteResourceDefinition` 或跨 FAB 业务配置时，不得推断存在共享设施，也不得在当前版本自动进行跨 FAB 物料转移。

## 7. 典型流程与异常处理

1. 入口适配层接收命令或仿真 Event，校验 Auth Scope、SchemaVersion、ExpectedVersion、RequiredCapability。
2. Application 读取必要的冻结定义或当前聚合，调用 Domain StateMachine/Policy；违反不变量返回结构化 DomainError，不得部分成功。
3. 持久化业务命令在同一事务提交所属变更与 Outbox；模拟事件由 M07 在事件安全点推进内存状态并提交 Checkpoint/Log，不逐事件写业务库。
4. 其它模块只通过公开事件/Contract/Port 更新自己的投影；一旦失败按 `retry / dedup / compensate / dead-letter` 策略处理。
5. 日志与审计携带适用的 `site_id/fab_id/run_id/trace_id`；无 Run 的管理操作不伪造 run_id。现场遥测与模拟流以不同 source 标识，禁止混入同一权威状态。

## 8. 测试、交付和验收

- T-01 非法 action 不改变状态；T-02 RL step 真正推进时钟；T-03 配对 CRN/统计方法正确；T-04 30 重复实验报告统计与异常样本。
- 每个命令必须有非法状态和跨 FAB 授权负测；每个重要事件有 Schema backward compatibility 与重放验证。
- 检查模块内 `Domain` 不依赖数据库/HTTP/GPU；单测无需外部服务即可运行。
- 仅对本模块承担的协议、GPU、数据库或共享容量能力执行对应环境验收；跨模块验收记录责任模块及证据，不能仅使用 mock 声称已验证。

### Definition of Done

- [ ] 项目与包在主仓库可构建，静态检查通过。
- [ ] 公开 Ports 与契约已发布，版本和单位明确。
- [ ] 主要 StateMachine/Invariant 单测和跨 FAB 隔离测试通过。
- [ ] 数据迁移/契约升级/回退方案已评审。
- [ ] 日志、指标、告警和追踪字段齐备，敏感字段已脱敏。
- [ ] 对应阶段 G0—G8 的验收证据有固定 URI 和 Review 记录。

## 9. 特殊风险与设计提醒

优化器/ML Agent 只提出决策，由权限与仿真领域规则裁决，不拥有直接更改设备状态的特权。
