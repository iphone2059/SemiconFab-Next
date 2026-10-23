# 08 — API、事件契约与实时状态流规范

## 1. 通信分层

| 用途 | 协议 | 权威性 |
|---|---|---|
| 业务命令、场景 CRUD、审计 | HTTPS REST + OpenAPI | 强一致命令 |
| 任务状态、普通通知 | SignalR / JSON | 非权威实时提示 |
| 高频 3D 状态流 | Binary WebSocket + Protobuf | 快照/增量投影 |
| 内部控制面—Worker | gRPC/Protobuf | 签名/认证的内部 RPC |
| 离线结果导出 | HTTPS / Parquet | 最终冻结数据 |
| 真实设备入口 | 隔离 Gateway/SECS-GEM/OPC UA | 仅按批准配置开放 |

**不**允许把浏览器推送顺序等同于仿真因果顺序；Worker 按冻结顺序产生权威日志，Gateway 可降采样用于 3D。

## 2. REST 资源设计示例

```
GET    /api/v1/sites/{siteId}
GET    /api/v1/sites/{siteId}/fabs
GET    /api/v1/sites/{siteId}/resources
POST   /api/v1/scenarios
POST   /api/v1/scenarios/{scenarioId}/versions/{version}:publish
POST   /api/v1/runs                 # Idempotency-Key header required
GET    /api/v1/runs/{runId}
POST   /api/v1/runs/{runId}:pause
POST   /api/v1/runs/{runId}:resume
POST   /api/v1/runs/{runId}:stop
GET    /api/v1/runs/{runId}/snapshots/latest
GET    /api/v1/runs/{runId}/artifacts
GET    /api/v1/sites/{siteId}/kpi?from=...&to=...
```

返回标准错误：`application/problem+json`，包含 `type/title/status/detail/traceId/errorCode`。业务冲突与幂等键请求内容不一致用 409，身份未认证用 401、已认证但无权限用 403；状态版本条件缺失用 428、`If-Match` 不匹配用 412。控制 Run 的接口必须带 `If-Match` 和 `Idempotency-Key`，条件检查、持久控制意图和 Outbox 同事务；202 表示已接收，只有安全点确认后才更新为目标状态。

幂等键按 `(site_id, authenticated_principal_id, operation, key)` 唯一，其中 operation 包含方法与目标资源。先执行身份/范围授权，再对规范化请求体、目标与版本条件计算 request_hash；同键同内容返回原始 status/body/location，同键异内容返回 409。记录与创建 Run/控制意图原子提交，并发重试只能产生一个结果；事务回滚不留下“已成功”记录。保留期须覆盖允许的重试窗口，过期键拒绝重放并提示刷新，不静默创建第二个 Run。幂等记录不能代替运行时命令去重和状态 CAS。

过期后可按策略清除响应正文，但须保留键作用域、请求哈希和原操作/Run 关联的 tombstone 以拒绝复用；不能仅 TTL 删除整条记录后把旧键当新键。保留/归档边界必须在上线前冻结，种子未实现自动清理。Independent 的 `snapshots/latest` 返回经授权成员的快照 Manifest 集合（每项含 fab_id 与各自权威边界），或通过显式 fabId 只取单成员；不得伪造一个跨独立 FAB 的 last_applied_sequence。SharedCapacity 可返回同一 Site execution 的一致边界投影，但详情仍按身份授权。

## 3. Protobuf 与消息语义

版本化参考原型见 `contracts/fab_events.proto`，尚不是覆盖全部业务事件的可投产契约。权威 `EventEnvelope` 使用 `contract_version`、`identity(site_id,fab_id,run_id)`、`simulation_time_us`、`sequence`、`event_id`、`correlation_id`、`causation_id`、`producer_build`；管理/实时控制消息按各自结构携带范围，不要求虚构业务事件 ID 或仿真时间。`oneof` 为不同业务事件；禁止将整个 FAB 对象作为无界 JSON blob 每帧发送。

权威序号从 1 开始；0 表示尚未应用事件。Independent 的范围为 `(site_id,run_id,fab_id)`，仅比较同一 FAB 的序号；SharedCapacity 的范围为 `(site_id,run_id)`，所有 FAB 与 SiteResource 共用协调器序号，Site 事件的 fab_id 为空，FAB 事件仍须携带成员 fab_id。`SharedCapacityAllocation.site_sequence` 必须等于外层 `sequence`，不是第二个可独立递增计数器。队列调度的插入序号与执行后 EventLog 序号是不同字段，不能混用；恢复已提交日志后不得重置或复用序号。

- Snapshot：一致边界的展示投影，携带 `last_applied_sequence`（权威边界）、`projection_hash_sha256`、`snapshot_version`、`stream_id`、`stream_sequence`。不是包含 RNG/Queue 的恢复 Checkpoint。参考 proto 传输单条完整快照；超出协商字节/实体上限时拒绝该流或要求更小订阅，分片协议须另行版本化，不能擅自拆同一消息。
- Delta：`StateDeltaBatch.sequence_start/end` 是该 `stream_id` 的连续投影序号，一批占一个序号（start=end）；`changes[].sequence` 才是权威事件序号。过滤、LOD 或降采样可以使后者稀疏，不作为展示 gap；批内包含版本化变化与显式删除项。投影变化禁止写回权威 EventLog。
- Client ACK：客户端已完整校验并应用的最高连续 `stream_sequence`；仅用于流控，不证明权威业务提交。重复批次忽略，缺失投影批次停止应用并重同步。
- Gap：客户端发现缺口时请求新的快照或允许的补发窗口，不猜测缺失状态。
- Throttle：GPU 渲染与后端仿真完全解耦；合并设备状态、发送最近状态，保留完整权威日志。

展示实体按 `(site_id,run_id,fab_id,entity_id)` 标识；Site 流中的每个 FAB 实体/删除项必须填写自身 fab_id，不得用相同模板的 local entity_id 互相覆盖。`upserted_entities` 表示包含 Transform 的完整实体展示更新，`removed_entities` 表示带版本的删除；一批同一实体只能出现一种最终变更，整体校验/应用后再 ACK。单 FAB 流的内层 FAB 必须与外层匹配，Site 流仍须逐项验证授权；哈希按冻结的完整实体键排序，不把展示版本与权威序号混为一谈。

## 4. 实时订阅与背压

客户端按 `(run_id, fab_id, view_frustum, LOD, topic)` 订阅，并限制最高更新速率。服务端按用户权限过滤信息、给每个连接设有界缓冲区；缓冲积压应优先合并非关键展示增量，并发送 `RESYNC_REQUIRED`，不可无界累积。

订阅建立/范围变更/权限变更/重连均签发新的不透明 `stream_id`，快照从 `stream_sequence=0` 建立基线；旧流迟到消息必须丢弃。构建快照时在一致权威边界冻结投影并缓存后继增量，收到 ACK 后再发送；缓冲溢出立即废弃该流。生成投影序号前可合并，已编号的批次不得静默删除或改写。`RESYNC_REQUIRED` 应通过独立受限控制通道发送，发送不出则关闭连接并重建；gap 补发仅在同流保留窗口内，否则新流快照。服务端须冻结最大帧字节、实体数、连接队列字节/批数、ACK 超时与重同步频率，客户端提交的 maxHz 不得突破上限。Site 总览的多 FAB 详情可拆为多个独立授权流；参考单流 Identity 不以空 fab_id 暗示拥有所有 FAB。

时钟区分：proto `simulation_time_us` 是 Run 非负仿真时钟；`wall_produced_unix_ms` 是服务器产生时间；可选 `observed_at_unix_ms` 是现场真实观测时间，仅用于相应现场数据，不得替代仿真时间。对同一设备同时呈现 Live 与 Simulation 必须强制标记不同数据源。

## 5. 合约演进

- Protobuf 字段编号永不复用，删除字段使用 `reserved`；支持 tolerant reader。
- 不兼容事件 Schema 必须版本化新增类型或新通道，旧 Run 仍可被历史 reader 回放。
- OpenAPI 破坏性改动由契约 diff 与客户端构建阻断。
- `fab_id` 与 `site_id` 不得在任意跨租户订阅或 RPC 中由未经身份验证的客户端自行提升权限。

## 6. 共用 Site 与隔离 FAB

Site 只读订阅可以收到授权 FAB 的聚合值，不限制固定数量；实时设备详情始终带 FAB 身份。共享事件除 `resource_id` 还必须带 Run 范围、`demand_id`、`allocation_id`、有效时间区间及 `grant_version`；数量使用已发布资源单位的整数基准量，禁止用 `double` 仲裁。`lease_epoch` 仅用于当前执行发布/提交的 fencing，不进入可重放模型状态/语义哈希；换租约保留有效 GrantVersion 与容量占用。共享资源只能由该 Site Run 当前租约的 Coordinator 写入，普通 FAB Topic 无权修改配额。跨资源/跨 Run 的请求或释放必须拒绝；同 demand_id 内容相同为重试、不同为冲突，Release 校验 GrantVersion 并从 ledger 读释放量，重复释放无额外副作用。

Protobuf 编号及删除字段保留规则依据 [Proto3 Language Guide](https://protobuf.dev/programming-guides/proto3/)。外层版本不匹配、未知状态改变事件或必需语义缺失应拒绝执行/重同步；保留未知字段的 tolerant reader 不能猜测业务语义。
