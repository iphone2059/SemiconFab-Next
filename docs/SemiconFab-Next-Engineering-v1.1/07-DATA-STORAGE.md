# 07 — PostgreSQL 数据架构与文件存储规范

## 1. 总体原则

PostgreSQL 保存 Site、Fab、模板、场景、授权、作业、结果目录与审计；仿真 Worker 在内存中执行热路径；高频权威事件与快照保存为压缩分块/Parquet/版本化二进制对象。**不得每个 DES 事件进行一次数据库事务**。

## 2. 概念关系

```
site 1 -> N fab_unit
fab_template_version 1 -> N fab_unit
fab_unit 1 -> N equipment_instance
scenario_version 1 -> N scenario_fab_binding
scenario_version 1 -> N simulation_run
simulation_run 1 -> N simulation_run_fab
site 1 -> N site_resource_definition (optional)
site_resource_definition 1 -> N resource_entitlement(fab_id)
simulation_run 1 -> N run_artifact
```

禁止设计 `fab1_equipment/fab2_equipment/fab3_equipment` 三套表；不允许固定 `fab_count=3` 进入数据库约束。

## 3. 关键表与字段

| 表 | 必填字段 | 约束 |
|---|---|---|
| `sites` | id, code, name | code 唯一 |
| `fab_template_versions` | id, template_code, version, sha256, definition | 已发布不可变；版本唯一 |
| `fab_units` | id, site_id, code, fab_template_version_id, lifecycle | (site_id,code) 唯一 |
| `equipment_instances` | id, site_id, fab_id, local_code, model_reference | (site_id,fab_id,local_code) 唯一，复合 FK 防止跨 FAB 错配 |
| `scenario_versions` | id, site_id, mode, version, sha256, frozen_config | 一次执行的参数冻结 |
| `scenario_fab_bindings` | site_id, scenario_id, fab_id, template_version_id | scenario_id 指已发布 ScenarioVersion；绑定同 Site 的 FAB，模板版本冻结 |
| `simulation_runs` | id, site_id, scenario_id, mode, engine_build, run_seed, status, state_version, created_at | mode 与冻结版本一致；Run 状态是成员执行的聚合 |
| `simulation_run_fabs` | site_id, run_id, scenario_id, fab_id, template_version_id, output_prefix | 复合 FK 同时约束 Run 的场景与场景 FAB/模板绑定，不能仅检查 FAB 属于同 Site |
| `simulation_run_executions` | id, site_id, run_id, fab_id?, mode, status, state_version, lease_owner, lease_epoch, lease_until_utc | Independent 每个 Run/FAB 一个执行；SharedCapacity 每 Run 一个 Site 执行，fab_id 为空 |
| `site_resources` | id, site_id, resource_kind, capacity_in_base_unit, unit, revision, config | 当前默认无实例，整数基准量及冻结单位 |
| `resource_entitlements` | site_id, resource_id, fab_id, max_share_in_base_unit, priority | Eligible FAB 与 Site 一致 |
| `run_artifacts` | site_id, run_id, fab_id?, execution_id?, lease_epoch?, kind, uri, checksum, size | FAB 资产必须属于 Run 成员；Worker 提交按当前 execution lease fencing |
| `outbox_events` | event_id, site_id, aggregate_key, aggregate_sequence, payload, published_at | 与业务变更同事务；消息 ID 在重试中保持不变 |
| `inbox_dedup` | site_id, consumer, event_id | 与消费副作用同事务；投递至少一次 |
| `idempotency_requests` | site_id, principal_id, operation, key, request_hash, response | 作用域唯一，和 Run 创建/控制事务原子提交 |

`examples/sql/001_initial.sql` 提供基础建表与隔离示例；它是架构种子，不是全部生产 DDL。

## 4. 数据隔离

- 高权限 Site 监控角色拥有按权限筛选的 Site 聚合读权限；FAB 操作员只能访问授权 FabUnit。
- API 必须按 `site_id`/`fab_id` 授权并限制过滤；数据库采用复合外键、唯一键，敏感表按风险开启 PostgreSQL RLS，不能只依赖前端选择器。
- RLS 会话上下文必须在受控数据库事务中由服务器验证后的身份映射设置 `app.site_id` 与 `app.fab_id`；不得直接转用请求中的 scope。缺少任一必需上下文时零行可见且拒绝写入；示例不把空 fab_id 解释成 Site 管理员。事务结束恢复会话设置，连接池不得预置租户会话默认值。
- 普通运行时角色须为非表所有者、非超级用户且无 `BYPASSRLS`，不得获授 `TRUNCATE` 或修改策略权限；示例同时开启 `FORCE ROW LEVEL SECURITY`。Site 聚合使用另行授权的只读投影，不借放宽 FAB 写策略实现。
- 自定义会话变量本身不能认证身份；有能力直接发 SQL 的客户端不能靠该示例获得安全隔离，必须限制数据库入口。RLS 不替代对象存储、API、缓存与订阅的同范围授权。
- Worker 绑定明确的执行范围：Independent 为 `(site_id,run_id,fab_id)`；SharedCapacity 为 `(site_id,run_id)` 的独立 SiteCoordinator 身份。Run 级聚合不能让某 FAB Worker 自动访问其他成员资产。
- 正式现场对接另设安全数据区和只读身份，不与仿真数据混表或复用生产凭据。

## 5. 数据生命周期与资产存储

- `FabTemplateVersion`、`RouteVersion` 与运行 manifest 永久保留版本哈希；删除前检查引用。
- 状态快照写入临时对象，计算 SHA-256，成功后通过元数据事务提交到 `run_artifacts`。断点恢复仅使用已提交且完整校验的对象。
- `Parquet` 默认用于批量分析事件/事实表；EventLog 必须有明确排序键，单个文件不允许因压缩/并行写入而模糊原有因果顺序。
- EventLog 的 `sequence` 作用域见 08：Independent 每 Run/FAB 连续；共享模式每 Site Run 连续。Manifest 记录执行范围、已提交序号区间、checkpoint 边界和内容哈希；恢复后延续序号，废弃的未提交尾部不得进入正式目录。投影 `stream_sequence` 不用于权威 Replay。
- `Arrow` 是运行时交换/分析内存格式，不是所有数据都应直接作为 Arrow 序列化。
- 数据保留时间、冷热分层、删除/匿名化策略由法规和现场要求确定；不能假设可无限保留生产数据。

## 6. 数据版本迁移

- Schema 迁移使用受控工具执行，具备升级路径、回滚策略或前向补偿。
- API 采用 expand/contract：先增加新字段与双读/双写，客户端升级后移除旧字段。
- 已产生的旧事件与快照不允许原地覆盖；必须通过版本化 reader/migrator 读取。
- PostgreSQL 分区按业务查询与数据量引入，不强制每张表分区；避免以过早分区复杂化约束。

## 7. 报表聚合口径

Site throughput = 同一时间窗所有 FAB 合格产出的总和；设备/工厂利用率需以工时或容量为权重；Cycle Time 可以通过合格完成 Lot 的全集求均值或按相应样本权重汇总。记录计算窗口、时区、样本、舍入规则、是否含预热和无产出 FAB 的处理。

## 8. 参考工件边界

SQL 种子使用无 schema 前缀的物理名；工程 schema 映射以 engineering/13 为准。它演示约束与单表 RLS，不包含完整授权、不可变版本触发器、租约提交存储过程或全部业务表，不能直接宣称生产隔离完成。发布服务必须在同事务冻结完整 FAB/资源/版本绑定；首版拒绝 `COUPLED_FLOW`。Seed 为无符号 64 位整数，JSON 使用十进制字符串，PostgreSQL 使用受范围约束的 `numeric(20,0)`。

PostgreSQL 行策略的角色绕过与事务上下文语义依据 [Row Security Policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html) 和 [SET](https://www.postgresql.org/docs/18/sql-set.html)；约束设计依据 [Constraints](https://www.postgresql.org/docs/18/ddl-constraints.html)。
