# M08 — 共享容量与 Site 权威协调域：开发项目架构与详细规范

> 模块编号：`M08`　|　主责任域：Site Resource Scheduling　|　状态：`DESIGN_BASELINE`　|　受 `01`—`14` 规范与 `engineering/00` 共同约束。

## 1. 业务职责与范围

以确定性 Site 事件调度与 ResourceLedger 管理可配置的跨 FAB 设施容量；默认不创建共享实例，禁止把尚未确认的 UPW/CDA/电力当成真实资源。

每个共享 Run 独立实例化 Authority/ResourceLedger，Site 仅共享不可变定义。M07 拥有事件循环和整体 Checkpoint；本模块的 `Fab.Simulation.SiteCoordinator` 在其 Worker 中装配资源仲裁，不是脱离 M07 队列的第二个主循环。M09 持有执行域租约和元数据提交权，M08 不签发第二套 Worker 租约。

### 拥有的领域对象

`SiteResourceDefinition`、`ResourceContract`、`ResourceDemand`、`Grant`、`ResourceLedger`、`SiteClockBarrier`。

### 边界与依赖

- 上游输入或参照：M01 Site; M07 DES; M09 Orchestration。
- 下游消费者：M02 MES; M03 Equipment; M10 Analytics。
- 权威写入者：本模块的 Application + Domain；跨模块消费者只能通过公开 Contract/Port 获取派生事实。
- 数据范围：与 FAB 关联的对象必须携带 `SiteId/FabId`；Site 级对象不得借此取得 FAB 运行状态写权限。

## 2. 可落地的工程/程序集与目录

- `Fab.SiteResources.Domain`
- `Fab.SiteResources.Application`
- `Fab.SiteResources.Infrastructure`
- `Fab.Simulation.SiteCoordinator`

领域模块建议内部目录（单个项目内部，不把每个文件都做程序集）：

```text
Fab.SiteResources.Domain/
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

公开 Ports / Services：`ISiteResourceAuthority`、`ICapacityModel`、`IGrantArbiter`、`ISiteResourceClock`、`IGrantLedger`。

### 命令 API

| Command | 前置条件与结果 |
|---|---|
| `PublishResourceGraph` | 发布新的不可变定义；校验合同可行性/单位/策略，不修改已冻结 Run 的图 |
| `RequestCapacity` | 运行内事件 Port；校验 Run/FAB/资源资格、稳定 DemandId、因果阶段、需求数量/区间；多资源以全有或全无集合请求 |
| `AllocateCapacity` | 仅当前共享执行器内部仲裁可调用；不得暴露为普通 FAB 用户任意授予的 REST 写口 |
| `ReleaseCapacity` | 校验执行域、AllocationId、所有者与 GrantVersion；重复释放返回原终态，不按调用方数量直接减账 |
| `AmendCapacityCalendar` | 创建新资源定义供后续 Scenario 使用；运行中只处理已冻结模型内的日历/故障事件，不热更 |
| `RevokeGrant` | 仅已冻结的故障/降额/取消策略产生；资源容量与依赖工序转移同边界原子提交 |

### 查询 API

| Query | 返回/权限约束 |
|---|---|
| `GetCapacityAt` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetActiveGrants` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetResourceAllocationTrace` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetEligibleFabs` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |

写操作具备 `IdempotencyKey`（适用时）、`ExpectedVersion`、`Actor/ServiceIdentity`、`CorrelationId` 和业务范围；读操作返回不可变 DTO，不直接返回 EF Entity 或持有 Babylon GPU 资源的对象。对高频 DES 事件，使用非异步的领域处理器，不把 REST 或 DB 接入仿真热循环。

## 4. Domain Events / Integration Events

| Event | 结构化契约要求 |
|---|---|
| `CapacityRequested` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `CapacityGranted` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `CapacityDeferred` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `CapacityReleased` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `ResourceUnavailable` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |

事件类型的完整字段、同时间优先级、受影响实体、统计更新和版本兼容规则由本模块在 `contracts/` 中维护。通知性 IntegrationEvent 与 DES 内部权威 EventLog **区分存储与因果语义**。

## 5. 数据与存储

负责的数据：`site_resources.resources`、`site_resources.contracts`、`site_resources.grants_projection`、`objectstore/site_trace`。

- 定义表验证 `(site_id, fab_id)` 授权关系；运行态授予/投影另带 `run_id/execution_id`，唯一键、外键和去重均包含执行域，跨 FAB/Run 数据关系须显式验证。
- 数据库中的投影、报表、事件分块和 DES 内存状态须明确权威性；不可在多数据源间形成无主的双向写入。
- 索引、行锁、事务隔离、Outbox 幂等由对应 repository 负责，并增加真实 PostgreSQL 集成测试。
- 长期存储与迁移按 `13-DATABASE-DETAIL-DESIGN.md`；文件型数据写 Manifest 和 SHA-256，拒绝不完整 Artifact。

## 6. 必须守护的领域不变量

- 任意虚拟时间 `Σ active_grants <= capacity(t)`；授予区间 `[start,end)`、固定精度、单位/舍入/溢出与资源类型的区间积分规则全部冻结。
- 同批请求的产生阶段先于仲裁阶段，按业务优先级及稳定 FAB/Demand 标识排序（或发布的确定性先入队策略）；批次关闭不以网络超时或临时队空决定，不能把子请求插回已关闭阶段。
- 每个共享 Run 只有一个权威协调执行域；GrantVersion 是可重放模型版本，M09 LeaseEpoch 仅 fencing 发布权。恢复保留 Grant/等待队列/终态去重，不因新租约重置模型资源。
- 同 DemandId 相同 payload 返回原结果，不同 payload 冲突；Grant 只能释放一次，取消/过期需求不得复活。多资源需求原子授予，不持有部分共享容量等待其他共享资源。
- 故障降容、降额/撤销及 FAB 依赖工序中断同一事件原子提交；无法中断的工艺须有可行冻结策略，否则拒绝该模型。容量恢复重新仲裁，不复活旧 Grant。详见 06。

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

- T-01 同时刻 FAB-01/02/03 请求可重复分配且不受线程/网络到达影响；T-02 崩溃后全域恢复，重复请求/释放/到期不多授予；T-03 capacity drop 与依赖任务转移原子且始终守恒；T-04 不存在 SiteResource 时独立模式轨迹不变；T-05 同 Site 两个共享 Run 完全隔离；T-06 多资源整组请求无部分持有；T-07 取消/过期等待请求与恢复不复活旧授权。
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

共享模式不使用三个互不协调的独立 Worker + 普通消息数据库竞争来假装严格确定性。
