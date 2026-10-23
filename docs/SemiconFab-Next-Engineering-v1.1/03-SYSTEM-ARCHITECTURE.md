# 03 — 系统架构与架构决策记录（ADR）

## 1. 物理边界、逻辑边界

```
Site Control Plane (tenant/security/config/API/monitoring/read models)
  ├── FAB-01 Simulation Domain (own state, clock, RNG, jobs)
  ├── FAB-02 Simulation Domain (own state, clock, RNG, jobs)
  ├── FAB-03 Simulation Domain (own state, clock, RNG, jobs)
  └── Site Resource Authority [disabled in independent mode]
        └── shared electric/UPW/CDA/gas/HVAC/... only when configured
```

当前默认 `INDEPENDENT`：FAB-01/02/03 共用**模板**，不共用设备实例、Lot、事件队列、持久化轨迹、时钟或命令执行权。共享模式仍隔离 FAB 可变实体，但由协调域统一持有队列和时钟。Site 控制面具有全局读取和治理能力，但不得直接修改 FAB 引擎内部对象。

`RunId` 标识一次冻结 Scenario 的执行，可包含多个 FAB。权威**执行域**在 `INDEPENDENT` 下为 `(site_id, run_id, fab_id)`，每个成员各有 Worker 租约、时钟、队列与恢复点；在 `SHARED_CAPACITY` 下为 `(site_id, run_id)`，全部 FAB 分区和资源账本由同一协调域提交、暂停和恢复。Run 级状态是成员状态的编排汇总，不得用一个 Run 级 Lease 排斥独立成员的合法并行执行。详见 `engineering/12`。

## 2. 三个逻辑平面

1. **Control Plane**：ASP.NET Core API、身份认证、Scenario 管理、Job 编排、Site 级查询聚合、版本发布。
2. **Simulation Plane**：一个或多个 .NET Worker 执行 C# DES，装载冻结 Scenario；可扩展 C++ 计算模块；同次运行中不与数据库做逐事件 RPC。
3. **Data Plane**：WebSocket/Protobuf 实时状态、快照/Delta、Parquet 轨迹、场景资产、可观测性；为多客户端订阅提供独立扩容点。

初版推荐模块化单体 API + 单独 Worker + 独立浏览器前端 + PostgreSQL + 文件/对象存储。逻辑边界稳定但进程部署可以在以后拆开；禁止按照模块数量强制微服务化。

## 3. 部署拓扑

- Web SPA：React/TypeScript/Vite，HTTPS 静态资源托管。
- API：ASP.NET Core 进程；不承载长时间 DES 核心循环。
- Worker：Windows Service 或容器中 Generic Host，按冻结的执行域启动；共享协调器是 Worker 内的可选逻辑角色，首版不另设独立权威进程。
- Database：PostgreSQL 元数据、任务/授权/发布事件、低频状态投影；对象存储管理大轨迹与快照。
- Realtime Gateway：初期同 API 进程，独立协议与租户空间；未来可单独部署。
- OT Gateway：**独立网络隔离进程**；默认完全禁用写入真实设备。

## 4. 核心调用边界

| 来源 | 目标 | 机制 | 一致性 |
|---|---|---|---|
| React | API | HTTPS/OpenAPI | 事务命令 + 幂等键 |
| WebGPU 客户端 | State Gateway | Binary WebSocket + Protobuf | 序列、快照、增量、背压 |
| API | Job Table | PostgreSQL 事务 + Outbox | 可恢复的持久化命令 |
| Worker | Frozen Scenario | 数据库读取、版本校验 | 不可变读 |
| Worker | Result Store | Parquet/快照 + 元数据提交 | 先对象再提交索引 |
| Site Monitor | FAB Read Projections | 授权聚合视图 | 只读最终一致性 |
| Site Coordinator | 共享运行域 | 权威资源仲裁事件 | 确定性逻辑时钟 |

## 5. ADR 固化

- **ADR-001**：采用模块化单体控制面 + 独立 Worker，而非一开始微服务。
- **ADR-002**：源域状态归属 FAB；Site 仅持有 Site 配置、共享资源真相与只读聚合。
- **ADR-003**：独立和共享两种 Mode 采用相同业务对象和工艺事件契约。
- **ADR-004**：共享资源竞争时，执行协调级全局确定性事件模型，**不**以异步最终一致消息直接实现排他容量。
- **ADR-005**：Babylon.js **WebGPU Only**；渲染进程不具有工艺权威。
- **ADR-006**：协议与存储采用版本化契约，滚动升级遵守兼容矩阵。
- **ADR-007**：版本更新通过依赖锁定与 CI 门禁，最新稳定版优先；候选版不可直接替代生产验收。
- **ADR-008**：采用证据驱动的性能优化，C++ 仅通过稳定接口替换热点。
- **ADR-009**：运行态、队列、资源授权与产物均按 Run 和执行域隔离；同一 Site 的不同实验 Run 共享不可变定义，分别实例化资源账本，彼此不竞争模拟容量。

## 6. 数据一致性

- 强一致边界：独立模式为**同一 FAB 执行域内**的物料、设备、事件队列；共享模式为**同一共享 Run 协调域**内全部 FAB 转移及共享容量授予。
- 最终一致边界：Site KPI 聚合、搜索、UI 缩略状态、只读监控投影。
- 对写操作实行 CAS/版本号和幂等请求；消息重复可重放；不可把网络到达顺序当作事件时间顺序。
- 所有外部效果（数据库/通知/导出）通过 Outbox 或可幂等处理机制，避免“事件已处理但回执未到”产生重复生产行为。
- 事件在内存中的原子处理和持久化提交是不同水位。只有完整、校验通过并被当前 LeaseEpoch 事务引用的日志/快照可作为恢复依据；投影 ACK、对象上传成功和失联 Worker 本地文件均不能推进权威持久化水位。
- M07 持有事件执行、队列与运行态；M08 提供被该执行器同步调用的资源模型和仲裁策略；M09 唯一拥有 Job/Lease/Run 元数据的事务写入及产物目录提交。共享协调器的进程宿主不改变这三个责任边界。

## 7. 未来扩展门禁

扩展 N 个 FAB 只需增添实例与资源映射，无需重编代码。共享资源扩展为多 Site 时需新增显式 Site-to-Site Contract，不允许直接开放任意跨 Site 数据库写权限。分布式 DES 必须证明因果顺序、死锁自由以及跨节点延迟预算，不得仅凭并行 Worker 宣称支持精确联合仿真。
