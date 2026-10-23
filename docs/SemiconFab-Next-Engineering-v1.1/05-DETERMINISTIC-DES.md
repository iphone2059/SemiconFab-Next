# 05 — 确定性离散事件仿真内核规范

## 1. 时钟与队列

- 内部主时钟为 `int64 simulation_time_us`，基于每个 Run 的虚拟零点；统一微秒单位，并对溢出、负值和单位转换执行校验。
- Event Order Key：`(simulation_time_us, semantic_priority, enqueue_sequence)`；按字典序排序。优先级枚举及同时间处理阶段版本化且冻结在 Run Manifest。
- 禁止依赖 `Task.Delay`、真实时钟、线程到达次序或网络消息顺序推进事件。
- 稳定事件队列初始可用 4-ary heap/二叉堆；其他队列优化须通过重复负载基准决定。
- 每个 FAB Run 的默认执行器为单逻辑线程确定性引擎；并行优先用于独立运行实例与 Replication。

### 1.1. 顺序、因果与序号作用域

- `enqueue_sequence` 是执行域内唯一、递增的**入队序号**；`event_seq` 是执行域内从 1 连续递增的**已处理日志序号**。较早入队的远期事件可晚执行，因此二者不能混用。分配器的 next value、最后处理键、日志持久化水位都纳入 Checkpoint，溢出明确失败。
- 独立模式序号作用域为 `(site_id, run_id, fab_id)`；共享模式为 `(site_id, run_id)`。不同独立成员的序号没有大小关系。共享资源通知须引用协调域的因果 `event_seq`，不能以另一个自增 Site 序号取代全域因果位置。
- 初始事件按冻结的稳定 FAB/实体 ID、事件种类与模型定义的局部序号枚举；处理器生成的子事件先按固定规则排序，再由唯一执行器分配入队序号。哈希表遍历、随机 UUID、并行任务完成顺序和网络到达次序不得参与排序。
- 新事件完整键必须严格大于当前已处理键：不得调度过去时间；同时间子事件优先级不得回到已关闭的较早阶段。模型必须声明请求产生、仲裁、启动/释放等阶段关系，不能靠随意加 1 微秒掩盖因果冲突。同时间事件链的上限/无进展检测冻结于模型，超限以诊断错误终止，避免零时间死循环。
- 外部业务输入先经范围校验与持久化接纳，再在安全事件边界赋予生效时间、阶段和稳定输入序号；记录 payload、causation 和应用边界。迟到输入不得倒灌已提交时间。纯离线复现实验使用相同冻结输入记录；交互输入的接纳边界是记录的一部分，不能宣称随意改变网络顺序仍得到同一轨迹。

## 2. 事件类别

`LotReleased`、`RouteStepEntered`、`OperationStarted`、`OperationCompleted`、`ReworkScheduled`、`LotScrapped`、`EquipmentStateChanged`、`FailureStarted`、`RepairCompleted`、`PMStarted`、`PMCompleted`、`CarrierMoved`、`TransportRequested`、`TransportCompleted`、`SharedCapacityRequested`、`SharedCapacityGranted`、`SharedCapacityReleased`、`WipSampled`、`KpiWindowClosed`。

每种事件必须定义：数据 Schema、所有者 FAB/Site、触发先决条件、状态转移、幂等行为、因果来源、相同时间优先级、统计影响及测试。

## 3. 事件处理契约（伪代码）

```
while queue has next event and !stop_applied_at_boundary:
    next = queue.peek_min()
    candidate = stage_transition(next, state, queue, rng, statistics)
    validate_preconditions_invariants_and_child_order(candidate)
    commit_in_memory_atomically(candidate, checked(event_seq + 1))  // 原子安装新序号、出队、Clock、RNG、子事件和日志
    flush_complete_prefix_when_required()               // 独立持久化水位
    emit_optional_read_projection(event_seq, durable_event_seq)
```

权威事件日志可周期分块，不要求每个事件同步访问 PostgreSQL；但同一 Checkpoint 的队列、RNG、状态及日志提交点必须可一致恢复。

失败的处理器不得留下部分实体变化、已消费 RNG、丢失的队列项或半条日志。可使用暂存转移或等价的原子处理方式；无法回滚时立即停止执行域并从有效恢复点重建，不能在受污染内存上重试。预期的取消/过期事件须有明确 no-op/终态处理契约；不应把合法重复消息等同于断言崩溃。读投影可以显示尚未持久化的进度，但须标注持久化水位，故障后按新流代际重同步。

## 4. 随机数与实验设计

- PRNG 算法和具体实现版本必须固定、跨平台测试、支持显式状态序列化；禁止依赖未冻结的 .NET 随机数内部实现。
- `run_master_seed` 为 UInt64；每个独立流由 `(run_master_seed, fab_stable_id, equipment_stable_id / event_domain, stream_kind)` 派生；稳定 ID 对应字节序列独立于容器遍历顺序。
- 流派生的哈希/KDF、字段编码、字节序、分隔/长度前缀与种子截取规则必须版本化；不得使用进程随机化的 `GetHashCode`。Site 资源故障使用独立 `site_resource_stable_id` 流，不借用某个 FAB 的 RNG。
- 不同 FAB 的随机调用数量不能相互扰动。策略对比时使用分层 Common Random Numbers，记录相关性限制。
- Replication 记录每条流的种子方案、调度策略版本、Scenario 哈希、模型构建版本、依赖与浮点模式。
- 相同 seed 的复现沿用稳定模型 ID；新 `run_id`、随机生成的请求 ID、LeaseEpoch、真实时间和追踪 ID 不参与模型随机流或语义轨迹哈希。

## 5. 执行模式

| 模式 | 时间与并行 | 要求 |
|---|---|---|
| `INDEPENDENT` | 各 FAB 有独立逻辑时钟/Worker | 三 FAB 之间无业务事件依赖 |
| `SHARED_CAPACITY` | 统一 Site 授权的权威时序 | 共享配额争用不能超容量 |
| `COUPLED_FLOW`（保留） | 统一因果模型 + 显式跨 FAB 运输 | 仅审批后可启用，不得隐含 Lot 转移 |

`SHARED_CAPACITY` 初始采用一个确定性协调执行域（可以是一个进程中的多 FAB 组件）；在证明分布式时间同步/安全时间边界之前，不允许三个独立 Worker 无序直接抢共享资源。参见 06。

## 6. 暂停、单步、快照、恢复

- `Pause` 在合法事件边界生效；仅 `PAUSED` 状态的 `StepOneEvent` 执行恰好一个队列事件后仍为 `PAUSED`，空队列返回 `NoEvent`，不得暗中排空同时间批次。`Stop` 经 `STOPPING` 在安全边界产生 `CANCELLED` 终态和部分结果摘要，不记为成功；强制终止按最后持久化水位记录中断原因并按编排策略取消/恢复/失败，不新增第二套持久化状态。
- 快照包括：clock、queue（完整顺序键与 payload）、last_processed_key、next_enqueue_sequence、last_processed_event_seq、durable_event_seq、entity state、RNG state、resource ledger（含等待/授予/释放终态）、statistics accumulators、输入/命令去重状态、schema/version、artifact checksums。
- 恢复时检查模板版本、引擎版本和快照 Schema；不兼容时明确拒绝，或通过版本化迁移工具处理。
- 重复消费外部事件使用执行域内的 `event_id` / `idempotency_key` 去重，同键不同 payload 拒绝冲突。去重状态与其已应用事件一起恢复，不能只在进程缓存去重。
- Checkpoint 只发布事件边界的完整状态；共享模式同时包含全部 FAB 分区和资源账本，不得拼接不同时间/水位的 FAB 快照。对象及推进到该边界所需的完整权威日志先写成不可变对象并校验，再由当前租约事务提交引用；不能用一个快照掩盖尚未持久化的日志缺口。CheckpointEpoch 与 Worker LeaseEpoch 是不同计数器。
- 快照后的日志只可重放到**已提交的最高连续持久化水位**；未上传、半写、本地孤立或未登记分块不保证恢复，不能声称恢复至任意崩溃瞬间。恢复允许重算其后的未提交尾部，投影按新流代际重同步。
- 本内核采用确定性重新执行：加载快照后，按记录的外部输入及已执行事件顺序运行同版本处理器，校验事件/状态/RNG 摘要和子事件。不能同时应用日志的结果 Delta 再执行处理器；重放期间不得重发通知或重复提交外部效果。日志缺块、重叠冲突、摘要不符或版本不兼容均应拒绝继续恢复。

Pause/Resume/Step/Stop 由 M09 持久化接纳，M07 在边界记录命令 ID、版本及实际应用的 `event_seq`；`Accepted` 与 `Applied` 区分。共享模式的暂停、单步、停止、恢复覆盖整个协调域；不支持只暂停一个 FAB 并让其他分区跨越它的潜在因果事件。

## 7. 统计正确性

- 采样窗口明确是否包含预热；每个指标须记录单位、时间窗和分母。
- Lot 守恒、设备忙闲排他、搬运资源互斥、容量守恒和时钟单调性为每场景 P0 断言。
- 95% 均值区间使用相应自由度的 t 临界值（小样本不得固定 2.0/2.045）；跨策略差异优先采用配对设计与有效统计方法。
- KPI Site 汇总按全局观测量重新推导，不能平均各 FAB 的 OEE / 产出率百分比。
- 权威事件、运行状态及其语义哈希要求完全一致，包括进入权威状态的数值字段；冻结并记录浮点环境。浮点容差只适用于不参与权威执行或语义哈希的数值分析/展示，记录其容差与适用边界，不能以此放宽权威复现验收。
- 语义状态/轨迹哈希采用版本化的规范字段编码、排序与摘要算法，排除真实时间、租约及传输元数据。成员级哈希还排除整体 Run/Scenario/Manifest 的标识与根哈希，仅比较本成员的语义事件/状态；实际冻结输入依赖哈希另行记录，避免只改变 FAB-02 输入就因整体 Scenario 版本变化而误判 FAB-01 轨迹受扰。参与权威状态、事件时间、仲裁、路由选择和阈值分支的数值计算必须在声明的执行环境内完全一致；浮点容差仅用于上述非权威数值分析/展示，不能容许权威字段、事件顺序或容量判断漂移。无法保证时拒绝该跨环境复现配置。

## 8. 未来性能优化

测量事件吞吐、峰值内存、p95/p99 单事件 CPU 耗时、快照暂停时间和恢复速度；采用对象池、值类型、Span、ArrayPool 与压缩列式存储。C++ 通过固定 C ABI 或大粒度批处理协议替换纯计算热点，严禁将带 C++ 异常/虚表/所有权不明确的对象直接泄漏给 C#。
