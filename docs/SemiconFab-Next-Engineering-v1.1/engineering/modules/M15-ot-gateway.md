# M15 — OT Gateway、SECS-II/HSMS、OPC UA 工业适配：开发项目架构与详细规范

> 模块编号：`M15`　|　主责任域：Industrial Integration　|　状态：`DESIGN_BASELINE`　|　受 `01`—`14` 规范与 `engineering/00` 共同约束。

## 1. 业务职责与范围

在明确安全分区的独立进程中处理厂商接口、SECS-II/HSMS、GEM 数据采集、OPC UA 与连接管理；真机写操作必须单独安全授权。

### 拥有的领域对象

`ConnectionProfile`、`EquipmentProtocolEndpoint`、`DataCollectionSubscription`、`DeviceCommandAudit`、`ProtocolTrace`。

### 边界与依赖

- 上游输入或参照：M14 EAP; M16 Identity/Security; authorized OT endpoints。
- 下游消费者：M03 Equipment projections; M13 FDC; M10 Analytics。
- 本模块拥有端点连接配置、采集游标与协议执行结果；M14 拥有语义 Profile，M16 追加审计记录，M03/M13 分别维护接收后的设备/质量投影。网关不写其他域数据库或 DES 状态。
- 数据范围：与 FAB 关联的对象必须携带 `SiteId/FabId`；Site 级对象不得借此取得 FAB 运行状态写权限。

## 2. 可落地的工程/程序集与目录

- `apps/Fab.OtGateway`：Composition Root、托管生命周期、配置与网络出口策略；不包含领域聚合。
- `Fab.IndustrialInterfaces.Domain`：连接模式、端点/命令能力、安全不变量与无 I/O 状态机。
- `Fab.IndustrialInterfaces.Application`：连接/订阅/控制用例、Ports、授权与审计结果编排。
- `Fab.IndustrialInterfaces.Protocols`：SECS-II/HSMS、OPC UA 编解码和会话实现；不拥有 MES/设备业务状态。
- `Fab.IndustrialInterfaces.Adapters`：端点持久化、采集转发、身份/审批/审计适配。

Application 依赖本域 Domain 与公开 Contracts；Protocols/Adapters 实现其 Ports，Gateway 显式装配。共享 `Fab.IndustrialProfiles` 只有无 I/O 语义结构，不依赖模拟器或 Gateway。凭据通过 M16 SecretProvider 获取，不进入 Profile/示例配置。

## 3. 接口清单与类型规范

公开 Ports / Services：`IProtocolSession`、`IEquipmentTelemetrySource`、`IEquipmentCommandPort`、`IEndpointAllowlist`、`IModeEnforcer`。

### 命令 API

| Command | 前置条件与结果 |
|---|---|
| `ConnectReadOnly` | 校验端点 allowlist、身份与 Profile；仅允许声明的建联/采集协议交互，禁止任意生产控制指令 |
| `SubscribeAlarms` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `SubscribeVariables` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `SimulateMessage` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `RequestApprovedControl` | 默认拒绝；仅 CONTROL_ENABLED 且目标/参数/审批有效、凭据与网络准入匹配时可发送；保留请求/发送/确认或未知结果审计 |
| `Disconnect` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |

### 查询 API

| Query | 返回/权限约束 |
|---|---|
| `GetConnectionHealth` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetProtocolCapabilities` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetObservedTelemetry` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetCommandAudit` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |

管理命令携带身份、scope、请求 ID、版本与 correlation。现场设备协议不一定支持幂等或事务：发送后超时必须记录结果未知并查询/人工对账；不得因 HTTP 幂等键或通用 retry 自动重发有副作用的设备指令。断开/取消不能宣称已撤销物理动作。

## 4. Domain Events / Integration Events

| Event | 结构化契约要求 |
|---|---|
| `EquipmentTelemetryObserved` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `ProtocolDisconnected` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `ProtocolAlarmReceived` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |
| `ApprovedCommandDispatched` | 版本化语义；必须带 owner、simTime/WallTime（按场景）、correlation、causation |

公开事件的字段、owner、时间语义和兼容规则在 `contracts/` 中维护；仅实际进入 DES 的事件定义同时间优先级、实体影响与统计更新。通知性 IntegrationEvent 与 DES 内部权威 EventLog 区分存储与因果语义。

## 5. 数据与存储

负责 `integration.endpoint_profiles`、`integration.ingest_offsets` 与受控协议 trace；只读 M14 发布的 `integration.adapter_profiles`。`audit.device_commands` 由 M16 审计追加接口写入，网关提供事实及关联 ID，不具备修改/删除审计权限。

- FAB 端点绑定 `(site_id, fab_id, endpoint_id)`；建立连接前验证配置范围，不能因同名设备路由到另一 FAB。
- 遥测保留 source、设备观测时间、接收时间、质量标志与协议序号；无可靠 source sequence 时不能虚构 exactly-once，采用声明的去重窗口/不确定性标记。
- 只在下游持久接受或可恢复缓冲后推进 ingest offset；重连重复样本不重复计入分析，缺口显式标注。
- 端点配置/游标适配执行真实 PostgreSQL 集成验收；协议 trace 记录格式/保留策略/hash 并脱敏，不保存凭据。

## 6. 必须守护的领域不变量

默认为 SIMULATED/READ_ONLY；CONTROL_ENABLED 需要审批、独立凭据、网络通道、审计与物理设备安全确认；OT 数据不可覆盖仿真权威状态。

### 三 FAB / 共享模式行为

- `INDEPENDENT`：业务写入与事件执行限制在所属 FAB 执行域；查询和 UI 订阅按授权范围过滤，允许 Site 角色只读汇总多个 FAB；相同模板不使 FAB 共享 Mutable State。
- `SHARED_CAPACITY`：只有 M07 确定性执行器与 M08 `SiteResourceAuthority/SiteCoordinator` 的正式接口可参与 Site 共用容量争用；所有资源授予具有虚拟时间顺序和可回放记录。
- 在没有明确的 `SiteResourceDefinition` 或跨 FAB 业务配置时，不得推断存在共享设施，也不得在当前版本自动进行跨 FAB 物料转移。

## 7. 典型流程与异常处理

1. 启动校验模式、端点 allowlist、身份、凭据与受批准 Profile；缺失配置即拒绝连接或控制。
2. 通过 Protocols 建联/订阅，使用有界缓冲与取消控制协议 I/O；READ_ONLY 允许的协议握手/订阅消息按 Profile 明列，与生产控制能力分开。
3. 规范化遥测并通过公开接口投递给 M03/M13/M10；真实观测始终带 source，不能直接覆盖 Run 内存。
4. 连接中断按 Profile 重连并校验序号/游标；不可恢复缺口触发告警，控制结果未知时禁止盲目重发。
5. 停止时先禁止新控制请求、停止订阅并完成/取消 I/O，再提交可恢复游标和审计；审批/审计不可用时高风险控制 fail closed。

## 8. 测试、交付和验收

- T-01 未授权命令在网关网络出口前被拒绝；T-02 HSMS 建联/断连/超时重试；T-03 SxFy 大小端/格式一致；T-04 重连重复样本不重复统计且缺口可见；T-05 控制回执丢失保持结果未知且不自动重发。
- 每个命令必须有非法状态和跨 FAB 授权负测；每个重要事件有 Schema backward compatibility 与重放验证。
- 检查 Domain 不依赖协议 socket、数据库或外部 SDK；协议/连接/安全出口测试在隔离模拟端点完成，现场接入另按授权验收。
- 仅对本模块承担的协议、GPU、数据库或共享容量能力执行对应环境验收；跨模块验收记录责任模块及证据，不能仅使用 mock 声称已验证。

### Definition of Done

- [ ] 项目与包在主仓库可构建，静态检查通过。
- [ ] 公开 Ports 与契约已发布，版本和单位明确。
- [ ] 主要 StateMachine/Invariant 单测和跨 FAB 隔离测试通过。
- [ ] 数据迁移/契约升级/回退方案已评审。
- [ ] 日志、指标、告警和追踪字段齐备，敏感字段已脱敏。
- [ ] 对应阶段 G0—G8 的验收证据有固定 URI 和 Review 记录。

## 9. 特殊风险与设计提醒

明确现场安全策略和变更审批，不把软件按钮作为安全联锁或者急停实现。
