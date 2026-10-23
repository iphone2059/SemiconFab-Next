# M18 — 可观测性、配置、部署与生命周期管理：开发项目架构与详细规范

> 模块编号：`M18`　|　主责任域：SRE/Operations　|　状态：`DESIGN_BASELINE`　|　受 `01`—`14` 规范与 `engineering/00` 共同约束。

## 1. 业务职责与范围

提供 Windows Service/未来容器部署、OpenTelemetry 日志指标链路、健康检查、配置校验、发布迁移、备份和灾备及多 FAB 容量规划。

### 拥有的运维记录与状态

`DeploymentManifest`、`ServiceHealth`、`Incident`、`CapacityBudget`、`BuildManifest`、`BackupManifest`。

### 边界与依赖

- 上游输入或参照：All services; OTel collector; PostgreSQL; Object Store。
- 下游消费者：All services and Site monitoring。
- 本模块拥有发布/配置/健康与恢复证据；业务 Run/Lease 的决策仍归 M09，审计记录通过 M16 追加接口写入。共享运维库只提供基础能力，不反向引用所有业务模块。
- 数据范围：与 FAB 关联的对象必须携带 `SiteId/FabId`；Site 级对象不得借此取得 FAB 运行状态写权限。

## 2. 可落地的工程/程序集与目录

- `Fab.Observability`：日志/指标/追踪语义、脱敏与 OTel 注册。
- `Fab.Hosting`：托管生命周期、健康/就绪检查与受控停止。
- `Fab.Configuration`：类型化配置、验证与版本清单；不在静态构造时连接外部服务。
- `infrastructure/deployment`：Windows Service/后续容器部署、迁移、备份与回滚脚本。
- `tests/performance`：声明硬件/负载的容量与故障恢复验证。

共享包以纯抽象/注册扩展、配置与适配目录组织；不机械创建 Aggregates、Domain/Application/Infrastructure 三套项目。业务模块向基础库报告诊断，恢复协调通过公开 M09/M16 Ports 或运维 API，不从基础库反向导入业务实现。

## 3. 接口清单与类型规范

公开 Ports / Services：`IServiceHealthReporter`、`IBuildManifestProvider`、`IConfigurationValidator`、`IRecoveryCoordinator`。

### 命令 API

| Command | 前置条件与结果 |
|---|---|
| `DeployRelease` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `ValidateConfig` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `MigrateDatabase` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `RotateCertificates` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `InitiateBackup` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `RecoverRun` | 向 M09 请求恢复并收集证据；新 LeaseEpoch/fencing、Checkpoint 校验和运行状态由 M09/M07 裁决，不另起第二个权威 Worker |

### 查询 API

| Query | 返回/权限约束 |
|---|---|
| `GetServiceHealth` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetRunDiagnostics` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetCapacityPressure` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetRecoveryEvidence` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |

写操作具备 `IdempotencyKey`（适用时）、`ExpectedVersion`、`Actor/ServiceIdentity`、`CorrelationId` 和业务范围；读操作返回不可变 DTO，不直接返回 EF Entity 或持有 Babylon GPU 资源的对象。对高频 DES 事件，使用非异步的领域处理器，不把 REST 或 DB 接入仿真热循环。

## 4. Domain Events / Integration Events

| Event | 结构化契约要求 |
|---|---|
| `ServiceUnhealthy` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `WorkerLeaseAlertRaised` | 运维告警；引用 M09 发布的 `JobLeaseExpired` 与 Run/epoch，不独立判定或修改 Lease |
| `StoragePressureRaised` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `ReleaseDeployed` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |

公开事件的字段、owner、时间语义和兼容规则在 `contracts/` 中维护；仅实际进入 DES 的事件定义同时间优先级、实体影响与统计更新。通知性 IntegrationEvent 与 DES 内部权威 EventLog 区分存储与因果语义。

## 5. 数据与存储

负责 operational telemetry、发布包/BuildManifest、部署/备份/恢复证据。`audit.admin_actions` 由 M16 的审计追加接口写入；M18 提供运维操作事实，不另设审计修改通道。

- 健康/遥测以 service/instance/build 为主体，适用时关联 Site/FAB/Run；不为无 FAB 的基础设施记录伪造 fab_id。
- 发布包保留 build SHA、SBOM、配置/schema/ABI 版本与哈希；备份记录数据库恢复点、对象存储清单与密钥版本映射。
- 数据库迁移仍由所属 bounded context 提供，部署流程串行执行并记录结果；M18 不取得全部业务表日常写权限。
- 恢复证据同时验证 DB 元数据、对象完整性、Run fencing 和历史 Reader；仅恢复单个服务进程不能宣称 Run 已恢复。

## 6. 必须守护的领域不变量

每次 Release 可回溯锁定依赖与 schema；日志脱敏、OT 凭据外部托管；无法验证 Checkpoint 不可虚报成功；执行/数据面有独立健康状态。

### 三 FAB / 共享模式行为

- `INDEPENDENT`：业务写入与事件执行限制在所属 FAB 执行域；查询和 UI 订阅按授权范围过滤，允许 Site 角色只读汇总多个 FAB；相同模板不使 FAB 共享 Mutable State。
- `SHARED_CAPACITY`：只有 M07 确定性执行器与 M08 `SiteResourceAuthority/SiteCoordinator` 的正式接口可参与 Site 共用容量争用；所有资源授予具有虚拟时间顺序和可回放记录。
- 在没有明确的 `SiteResourceDefinition` 或跨 FAB 业务配置时，不得推断存在共享设施，也不得在当前版本自动进行跨 FAB 物料转移。

## 7. 典型流程与异常处理

1. 发布前验证配置、依赖/schema/ABI 兼容与受控包哈希，记录审批/操作身份。
2. 暂停接收新任务，按 M09/M07 事件安全点与提交协议排空或标记可恢复的运行；迁移、升级和回退按操作手册执行。
3. 健康检查区分 liveness/readiness、任务/存储/Gateway 数据面；遥测不可用不得改变 DES 虚拟事件顺序。
4. 故障恢复向 M09 请求新的受 fencing 保护的执行，再验证 Checkpoint/Artifact/Replay；失败保留可诊断的 partial 证据，不能标成功。
5. 通过 M16 追加管理员操作审计，按保留策略清理可重建诊断数据；权威审计/历史恢复资产不自动删除。

## 8. 测试、交付和验收

- T-01 Worker 强杀恢复；T-02 DB/Store 故障与部分文件处理；T-03 日志无密钥；T-04 Windows 部署与升级回滚；T-05 自托管 GPU E2E。
- 每个命令必须有非法状态和跨 FAB 授权负测；每个重要事件有 Schema backward compatibility 与重放验证。
- 配置/清单/健康判定单测无外部服务；部署、数据库/对象存储恢复与 GPU E2E 在对应真实环境执行，M07/M09 提供恢复一致性证据。
- 仅对本模块承担的协议、GPU、数据库或共享容量能力执行对应环境验收；跨模块验收记录责任模块及证据，不能仅使用 mock 声称已验证。

### Definition of Done

- [ ] 项目与包在主仓库可构建，静态检查通过。
- [ ] 公开 Ports 与契约已发布，版本和单位明确。
- [ ] 部署、停止、恢复、凭据脱敏与跨 FAB 诊断隔离验收通过。
- [ ] 各 owner 提供的迁移顺序、备份恢复和版本回退方案已评审。
- [ ] 日志、指标、告警和追踪字段齐备，敏感字段已脱敏。
- [ ] 对应阶段 G0—G8 的验收证据有固定 URI 和 Review 记录。

## 9. 特殊风险与设计提醒

不要把主机硬件性能数字写成产品承诺，先通过固定模型负载与容量验收签字。
