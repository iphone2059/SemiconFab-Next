# 06 — Site 共享资源与多 FAB 运行模式规范

## 1. 正式业务结论

**当前确认**：三个 FAB 结构一致，运行实例完全独立，Site 仅统一管理和监控。**未确认**：有无共享 UPW、CDA、压缩空气、真空、特气、厂务供电、HVAC、废气处理、配送设施等。共享设施必须被配置驱动，禁止通过设备名称或 Site 关联推断存在共享关系。

## 2. 三种模式

| Mode | 资源域 | 调度时钟 | 跨 FAB 物料 | 首版 |
|---|---|---|---|---|
| `INDEPENDENT` | 独立 FAB 资源 | 每 FAB 独立时钟 | 禁止 | 默认 |
| `SHARED_CAPACITY` | SiteResource + FAB 本地 | 共享授权使用统一确定性 Site 时间轴 | 禁止 | 架构必须支持，功能阶段实现 |
| `COUPLED_FLOW` | 共享容量+运输/物流 | 全局因果时间轴 | 只在显式许可/路线存在时可用 | 预留；不假定业务需求 |

Mode 和所有能力都冻结于 `ScenarioVersion`，正在执行的 Run 不得热更模式或资源图。应创建新 Run 做 What-if 对比。

SiteResourceDefinition 是可共享的不可变定义；资源账本、请求、授予和资源故障 RNG 必须按 `(site_id, run_id)` 实例化。同一 Site 下两个共享实验 Run 不竞争彼此的模拟容量，不得用 Site 级单例账本把实验耦合。这里的“一个权威协调器”指每个共享 Run 一个权威执行域，并不限制 Site 同时执行多个隔离实验。

## 3. SiteResource 强类型模型

```
SiteResourceDefinition {
  ResourceId, SiteId, ResourceKind,
  CapacityValue, CapacityUnit, TimeGranularity,
  AvailabilityCalendar, FailureModel?, RecoveryModel?,
  AllocationPolicy, PriorityPolicy,
  EligibleFabIds[], Contracts[], Version, ModelConfidence
}
ResourceContract {
  FabId, ResourceId, MaxShare?, Reservation?, Priority,
  MinGuaranteed?, ValidFromSimulationTime, ValidToSimulationTime?
}
Allocation { RunId, AllocationId, ResourceId, FabId, DemandId, RequestedUnits,
             GrantedUnits, StartTime, EndTime?, State, GrantVersion }
```

ResourceKind 示例：`UPW_FLOW`, `ELECTRIC_POWER`, `CDA_FLOW`, `EXHAUST_FLOW`, `GAS_FLOW`, `HVAC_LOAD`, `TRANSPORT_CAPACITY`。不同资源具有不同量纲，必须显式表示单位和周期；不能用同一个整数“车位数”模型抽象所有资源。持续流量与离散排他对象分别采用适合的 CapacityModel。

- 数量、容量和日历值使用已冻结的基准单位、定点精度/舍入与溢出规则；非正需求、负容量、非法区间、单位不匹配和精度无法表示的请求在入队前拒绝。授予有效区间为 `[StartTime, EndTime)`；`EndTime=null` 表示持续到显式释放/撤销。相同时间的到期/释放与新授予顺序必须冻结。
- `Reservation`、`MaxShare`、`MinGuaranteed` 的量纲、适用区间及是否可借用须由发布策略定义；校验可行性，不能把相互冲突的保证量发布成有效配置。不可分工艺步骤须全量授予；只有模型声明可分割并定义降额加工行为时才允许部分授予。
- 一项工序同时依赖多个容量时，提交一个资源需求集合，由同一协调事件全有或全无地校验/授予，按稳定 ResourceId 锁定逻辑顺序；任一资源不足则整个集合排队，不得持有部分授权等待另一资源而造成循环等待。资源请求本身不授权占用本地 Equipment/Carrier，启动转移仍须校验本地状态。

## 4. 权威仲裁与时钟

共享资源满足：

`∀ resource, t : Σ active_grants(resource,t) <= resource.available_capacity(t)`

在 `SHARED_CAPACITY` 模式，一个权威 Site Coordinator 负责接收需求、决定授予、处理释放、执行失效/故障重算；FAB 各自的仿真事件由同一确定性时间轴驱动，**禁止不同 Worker 仅靠实时消息抢占共享容量**。多个物理进程可以执行计算，但仲裁与提交的因果顺序必须被权威 Site Run Engine 确认。

明确顺序：
1. `SharedCapacityRequested` 进入该 Run 的协调队列，带 Run/FAB ID、稳定 DemandId、需求量/区间、工艺原因和冻结资源版本；DemandId 从稳定因果标识派生，不以网络到达或随机 GUID 决定先后。
2. 队列按 05 的 `(sim_time, semantic_priority, enqueue_sequence)` 执行。模型保证同批请求的产生阶段早于仲裁阶段，并显式关闭该时间/阶段的请求集合后，再按冻结业务优先级与稳定 `(fab_id, demand_id)` 规则仲裁（或明确选择确定性先入队策略）；必要时整单排队/拒绝，部分授予仅按已声明模型。批次关闭不能依赖 wall clock、网络超时或当前队列暂空。子事件不能倒回已关闭阶段；同时间产生的新因果需求必须属于后续已定义阶段。
3. `Granted` 或 `Queued/Rejected` 反馈给对应 FAB 的确定性状态机。
4. 工序完成或中断产生 `Released`；若资源故障，按冻结策略生成 `Reduced/Revoked` 并对依赖任务施加显式处理。
5. 每次分配可按 AllocationId 追溯到请求、资源容量版本和上游制造事件。

容量日历/故障在 T 降额时，容量变化、受影响 Grant 的确定性降额/撤销及依赖任务的阻塞/中断转移必须作为同一原子边界提交，使 T 时刻提交后的有效授予不超新容量；不能先公布较低容量再异步等待 FAB 释放。若工艺无法中断，模型必须事先定义可行的降载策略，否则拒绝该资源模型，不能以“仍在处理中”豁免守恒。恢复容量触发按冻结策略重新仲裁，不自动复活旧 Grant。已有 Grant 到期的释放事件与手动释放/取消相遇时只能释放一次。

等待请求须保持可恢复的排队状态；释放、到期、故障恢复等容量变化触发重新仲裁，旧请求的更新/取消通过 DemandId 和版本校验。过期/取消请求不得在恢复后重新授予。仿真授予的到期使用仿真时间，Worker 租约到期使用真实时间，二者没有换算关系。

`GrantVersion` 是可重放的模型账本版本，Worker `LeaseEpoch` 是 M09 的提交 fencing。恢复时保留有效 Grant 的模型身份/区间，同时以新的执行域租约校验发布权；不得因租约轮换清空 Grant 或把旧 Worker 的资源通知当作新需求。所有跨进程请求/授予/释放需校验 scope、当前 LeaseEpoch、Demand/Allocation 所属者与版本；同键同 payload 重试返回原结果，同键异 payload 拒绝。释放只按有效 AllocationId 改变一次账本，不能相信调用方提交的“释放数量”。

共享 Checkpoint 必须在同一事件边界包含全部 FAB、时钟/队列、等待请求、Grant 终态去重记录、资源故障 RNG 和统计；故障恢复整体回到同一持久化水位。不能只恢复协调器、单个 FAB 或授权表。暂停/单步/停止以整个共享执行域为范围。

若物理资源调度可建模为纯事先分配的固定容量配额，可令三个 FAB 独立运行但各自只消费冻结配额；此实验标记称 `FIXED_ALLOCATION_EXPERIMENT`，仍使用 `INDEPENDENT` Mode，不新增运行模式枚举。发布时验证每个区间冻结配额总和不超过建模容量；它不能模拟动态故障后的跨 FAB 再分配，禁止与动态共享仲裁混称。

## 5. 安全边界

- 资源账本是唯一跨 FAB 共享的可变业务状态；Site 控制面不得直接修改 FAB 的 `Equipment`/`Lot` 对象。单进程共享执行器可持有各分区，但只通过对应分区的正式确定性处理器提交状态转移。
- Site 共享资源故障可以通过正式事件对多个 FAB 产生影响，默认纯独立模式则必须证明这种影响不存在。
- 跨 FAB TransferJob 必须单独授权、定义来源/目标、物料主权移交及 Route 许可；默认 `cross_fab_material_flow=false`。
- 未确定设施用 `UNCONFIRMED`，不能默认填“无限容量”并伪装成真实共享系统；可在沙盒演示配置中使用 `synthetic=true`。
- 所有场景支持 Resource Policy A/B Compare，附带参数来源、敏感性分析和置信区间。

## 6. 必须通过的测试

| 用例 | 方法 | 通过标准 |
|---|---|---|
| SHARED-001 | 在 INDEPENDENT 模式对 FAB-02 插入机台故障 | FAB-01/03 轨迹哈希不变 |
| SHARED-002 | 三 FAB 同时争用一个容量 100 的共享资源，各申请 60 | 任意时刻授予总数 <= 100；等待/拒绝可解释 |
| SHARED-003 | 相同时刻、不同消息到达顺序重复运行 | 资源授予事件顺序与结果一致 |
| SHARED-004 | 恢复时注入重复资源申请/释放 | 不发生双重授予或负容量 |
| SHARED-005 | 共享资源故障减少容量，后续恢复 | 故障影响范围、恢复策略与事件时间可追溯 |
| SHARED-006 | 未授权跨 FAB Lot 运输 | 拒绝，记录审计 |
| SHARED-007 | 从 3 FAB 新增第 4 FAB | 无核心重编译且资源权限明确 |
| SHARED-008 | Site 仅读 KPI 用户尝试 FAB 状态写入 | 拒绝并审计 |
| SHARED-009 | 同一 Site 并行执行两个引用相同资源定义的 Run | 授权/随机流/等待队列完全隔离；任一 Run 控制不影响另一 Run |
| SHARED-010 | 多资源原子需求、重复到期/释放和容量降额同时间发生 | 无部分持有循环等待；只释放一次；每个提交边界满足容量约束 |
| SHARED-011 | 有活动授权和等待请求时崩溃并整体恢复 | FAB/资源账本/队列及语义结果一致，旧租约提交被拒绝 |

## 7. 对开发和运维的含义

Site 共享协调器是**可选计算逻辑模块**，可以初期与 DES 部署在同一 Worker；配置和领域 API 必须一开始存在。用户切换模式时创建新的 ScenarioVersion/Run；系统为共享模式明确展示“结果受共享约束影响”，不能拿独立模式绩效直接作为共享模式真实预测。
