# 13 — PostgreSQL 数据架构与表分组细化

## 1. 存储分类与 Schema 所有权

初期可使用单一 PostgreSQL Cluster + 独立 schema；对共享资源与真实设备遥测采用不同角色/权限。业务模块只通过其 repository/Query API 访问所属 schema，除只读聚合专用 SQL 外不允许跨模块直接更新。

| PostgreSQL schema | 表（示例） | Owner | 写入者 |
|---|---|---|---|
| `identity` | principals, role_bindings, user_fab_grants | Identity | Identity 应用服务 |
| `site` | sites, fab_units, template_versions, layout_versions | Site | Site 管理服务 |
| `manufacturing` | lots, wafers, work_orders, lot_history, holds | MES/WIP | Manufacturing |
| `process` | products, route_versions, recipe_versions, capabilities | ProcessEngineering | ProcessEngineering |
| `equipment` | equipment_instances, chambers, load_ports, state_projection | Equipment | Equipment 投影/管理 |
| `material_handling` | carriers, transport_orders, network_versions, stockers | AMHS | MaterialHandling |
| `maintenance` | maintenance_plans, maintenance_actions, failures | Maintenance | Maintenance |
| `quality` | measurements, control_limits, quality_dispositions | Quality | Quality |
| `simulation` | scenarios, scenario_versions, runs, run_fabs, run_executions, checkpoints, run_artifacts | M09 Orchestration（场景建模协作 M07） | Orchestration/Worker 受限账户 |
| `site_resources` | resources, contracts, grants_projection | SiteResources | Coordinator/受限服务 |
| `analytics` | kpi_definitions, run_metrics, site_rollups, experiment_comparisons | M10 Analytics | Analytics projector |
| `integration` | outbox_events, inbox_dedup, adapter_profiles, gem_state_projection, endpoint_profiles, ingest_offsets | 事件记录归各业务事务；adapter_profiles/gem_state_projection 归 M14；endpoint_profiles/ingest_offsets 归 M15 | 各 owner 受限服务；M15 只消费 M14 已发布 Adapter Profile |
| `simulation`（实验） | experiments, policy_versions | M17 Experiments | Experiments；不直接修改 M09 执行/结果目录 |
| `audit` | audit_entries, admin_actions, access_events | M16 IdentitySecurity | M16 唯一追加 writer，其他模块经审计 Port 提交 |

对于运行中的 Lot/设备状态，DES 的权威真相在 Worker 的内存状态+Checkpoint+EventLog；数据库中的业务操作记录和读投影**不是热事件队列**。实际 MES 业务系统与模拟运行生成的 Lot 应以 `data_origin/source_mode` 或隔离数据库进行区分，避免实验写入真实主数据。

## 2. 关键字段与约束

- `fab_units(id uuid pk, site_id uuid not null, code text, template_version_id uuid, row_version bigint)`；UNIQUE `(site_id, code)`。
- `equipment_instances(id uuid pk, site_id uuid, fab_id uuid, local_code text, tool_group_id uuid, model_profile_id uuid)`；UNIQUE `(fab_id,local_code)`；复合 FK 要求 equipment 的 `site_id` 与所属 `fab_id` 对应。
- `lots(id uuid pk, site_id uuid, fab_id uuid, route_version_id uuid, quantity int, lot_state text, version bigint)`；禁止空 fab_id；拆并 Lot 建 ledger 与 genealogical links。
- `scenarios(id uuid, site_id uuid, mode text, current_version int)`，`scenario_versions(id uuid, site_id uuid, content_hash bytea, frozen_document jsonb, created_at, released_at)`；版本发布后禁止 UPDATE，发布事务冻结 FAB/模板/资源版本绑定。首版只接受 Independent/SharedCapacity。
- `runs(id uuid, site_id uuid, scenario_id uuid, mode text, status text, state_version bigint, engine_build text, run_seed numeric(20,0), result_manifest)`；`scenario_id` 在种子与本规范均指已发布 ScenarioVersion，非可变 Draft。`run_seed` 限制 0..18446744073709551615。
- `run_fabs(site_id uuid, run_id uuid, scenario_id uuid, fab_id uuid, template_version_id uuid, output_prefix text)`；既通过 `(site_id,run_id,scenario_id)` 绑定 Run 版本，也通过 `(site_id,scenario_id,fab_id,template_version_id)` 绑定冻结成员，防止引入同 Site 但不属于场景的 FAB。创建 Run 时同事务完整复制成员，不能只验证单行有效。
- `run_executions(id uuid, site_id uuid, run_id uuid, fab_id uuid?, mode text, status text, state_version bigint, lease_owner text, lease_epoch bigint, lease_until_utc timestamptz, heartbeat_at timestamptz)`；Independent 每 FAB 一个非空 fab_id 执行，SharedCapacity 每 Run 一个空 fab_id 执行，mode 必须与 Run 相同。租约 CAS、心跳与 fencing 均以 execution 为粒度，Run 只聚合成员状态。
- `site_resources.resources(site_id, resource_id, dimension, unit, capacity_definition, model_confidence, revision)`；`site_resources.contracts(site_id, resource_id, fab_id, cap, priority, validity)`。
- `integration.outbox_events(event_id uuid, site_id uuid, aggregate_key text, aggregate_sequence bigint, schema_version int, payload jsonb, recorded_at, published_at)`；`integration.inbox_dedup(site_id,consumer,event_id)` 唯一。aggregate_sequence 是业务聚合投递次序，不是 DES EventSeq。
- `idempotency_requests(site_id,principal_id,operation,key,request_hash,response_status,response_body,run_id,expires_at)`；按前四项唯一，与命令副作用同事务。API 先授权再读取缓存结果，同键异请求拒绝。
- 幂等响应过期后保留键作用域、request_hash 与原操作/Run 关联的 tombstone；仅删除响应正文不解除键唯一约束。不可用整行 TTL 删除实现“过期键拒绝复用”，种子不包含清理/归档策略。

## 3. 跨 FAB 数据隔离方法

- 每张 FAB 所属表强制 `site_id + fab_id`；Site 角色能读允许范围的聚合、但不自动取得写权限。
- 关系完整性优先通过复合 FK、UNIQUE 约束与受限 role 建立；业务层仍必须重复校验跨 FAB 引用。
- EF Core QueryFilter 可减少误查询，但**不是安全边界**。敏感 FAB 表的 RLS 同时检查受信任的 Site/FAB 上下文，必需上下文缺失时拒绝；普通角色非 owner/superuser/BYPASSRLS，表启用 FORCE RLS，不授予 TRUNCATE/策略管理权限。Site 汇总另用受控只读投影。会话变量可以被 SQL 设置，本身不是认证机制；仅由受信任应用在事务中以 SET LOCAL 设置已授权值，连接池不能遗留会话默认租户。参考 SQL 仅覆盖 equipment_instances，其他表的 RLS/GRANT 必须在正式迁移中补齐。
- 所有读写均保留 `trace_id`、`run_id`、`site_id`、`fab_id` 的审计上下文；禁止在日志输出 Carrier/个人信息等敏感原始数据。
- 不为三个 FAB 创建三套表；只有经过治理的设备/实时遥测隔离要求才考虑单独数据库或物理分片。

## 4. 并发与 Job Claim

Job Claim 使用带行锁的短事务，从当前身份允许的 `run_executions` 中 `FOR UPDATE SKIP LOCKED` 领取；同事务更新 owner、lease_until、state_version 与递增 lease_epoch。只接受已提交 Claim；事务提交失败不得在 Worker 本地假定已领取任务。长时间计算在数据库事务外进行。过期租约的恢复仍占用同一 execution 并递增 epoch，不为恢复另建一个可并行写入的执行。过期事件名统一为 `JobLeaseExpired`。

Worker 的心跳、Checkpoint/事件分块目录提交、状态更新和 Finish 均须在短事务对当前 `(execution_id,lease_owner,lease_epoch)` 及未过期租约加锁/CAS，检查受影响行数；上传对象完成不代表成功提交。失租旧 Worker 最多产生不可见的孤立对象，不得覆盖已提交 URI。独立 FAB 的故障恢复不占用其他 FAB 租约，共享恢复必须同时恢复所有 Partition 与 ResourceLedger。

持久生命周期统一为 `QUEUED -> CLAIMED -> RUNNING -> PAUSED/STOPPING -> COMPLETED/FAILED/CANCELLED`，合法分支及恢复迁移由受控 FSM 明确，初始化/暂停中/完成中记录为 phase，不能引入第二套 Leased/Succeeded 状态枚举。独立 Run 的 pause/stop 必须记录目标成员和应答范围，不能以一名 FAB 应答宣告全 Run 完成。Run 只有全部成员成功且最终 Manifest 已提交、哈希已校验、KPI 已冻结后才能 `COMPLETED`；失败/取消的部分 Trace 标记 `partial=true`。

Outbox 与业务写入同事务，发布后再标记 published_at，崩溃窗口允许重复投递。消费端按 `(site_id,consumer,event_id)` 去重并将 Inbox 与数据库副作用同事务提交；外部副作用另需目标系统幂等键，不能声明跨系统 exactly-once。保序消费者按 aggregate_sequence 检测缺口、暂存/补读，不能用数据库 identity 或网络到达顺序作为业务顺序。Outbox 只承载控制/业务事件，不是每个 DES 事件的事务队列。

## 5. 事件、快照与分析文件

| 资产 | 主格式 | 编写责任 | 一致性 |
|---|---|---|---|
| DES 权威事件日志 | 按版本定义的带序号二进制 Log/Protobuf block | Worker | 完整、可按 EventSeq 恢复 |
| Checkpoint | 版本化二进制状态（含 RNG/Queue） | Worker | 单快照原子 Manifest |
| 高频分析事实表 | Parquet | Worker/ETL | 可批处理、可重建 |
| API 查询主数据 | PostgreSQL | Domain repos | 事务/约束 |
| 只读运行指标 | PostgreSQL 投影 | Analytics | 最终一致、可重建 |
| GLB/KTX2/LOD 资产 | 对象存储 | Asset Pipeline | Content Hash |

Parquet 无需承担 DES 完整恢复协议；列式文件按分析访问优化，而权威事件需有已定义的排序、类型和恢复边界。

`run_artifacts` 必须包含 `(site_id,run_id)`，FAB 专属资产还包含成员 fab_id；Worker 资产同时绑定 execution_id/lease_epoch。对象 Key 使用不可变版本/内容哈希，下载签名仅在授权后生成并设置有效期。权威日志 Manifest 记录每个执行范围的已提交 EventSeq 首尾、checkpoint 序号与校验和；共享 Run 的日志序号只有一个，不能把每 FAB 的片段各自从 1 开始。

Checkpoint 的 last_event_sequence 不得超过同执行范围完整连续且已持久化的权威日志前缀；允许快照与对应日志目录在同一元数据事务提交，但不能以“有快照”掩盖日志缺口。共享前缀必须覆盖整个 Site execution，不能只检查各 FAB 的局部文件。恢复时拒绝不连续、哈希不匹配或超出该前缀的快照。

## 6. 核心索引与分区原则

常用索引：`equipment(site_id,fab_id,local_code)`、`lots(site_id,fab_id,lot_state)`、`runs(site_id,scenario_id,created_at DESC)`、`run_executions(status,lease_until_utc)`、`checkpoint(execution_id,last_event_sequence DESC)`、未发布 Outbox 的部分索引。按实际查询计划测量。大规模遥测可按时间窗口和 Site/FAB 分区，但不宜未经压测直接把所有表做多层分区，以免扩大规划成本与复合 FK 复杂度。

## 7. 备份、迁移和恢复

- PostgreSQL PITR+WAL；场景/模型不可变资产持久保存 Hash 和对象 URI，备份包含 DB 元数据、对象存储与密钥版本映射。
- 迁移使用 expand/contract，在线升级需先兼容旧 Reader；恢复演练同时验证历史 Replay。
- `Run Manifest` 记录 PostgreSQL/ORM/Schema、协议版本和引擎构建版本，以支撑长期可复现性。
- 标准化保留策略需由业主与法规确认，先按“未定义，不可自动删除权威审计”处理，而不是无限保留全部高频追踪。

## 8. 参考 SQL 与工程命名映射

`examples/sql/001_initial.sql` 为无 schema 前缀种子：`simulation_runs -> simulation.runs`、`simulation_run_fabs -> simulation.run_fabs`、`simulation_run_executions -> simulation.run_executions`、`run_artifacts -> simulation.run_artifacts`、`outbox_events/inbox_dedup -> integration.*`；这些映射不意味着创建两套表。发布后不可变、Run 成员完整复制、单执行写入 fencing 与所有敏感表 RLS 仍是正式迁移/服务事务的必做项，种子 CHECK/FK 不替代它们。

技术依据：[PostgreSQL Row Security](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)、[SET LOCAL](https://www.postgresql.org/docs/18/sql-set.html)、[Constraints](https://www.postgresql.org/docs/18/ddl-constraints.html)。
