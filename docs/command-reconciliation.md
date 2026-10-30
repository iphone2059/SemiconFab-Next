# 命令核对（Command Reconciliation）

- 版本：V2.1 / 2026-10-27（2026-10-28 递归整改 R-03/R-08 同步）
- 状态：**M3/M4 已实现（内存有界队列 + 假 gateway 验证）；开发模拟后端已提供按 `(fabId, commandId)` 的权威查询端点，生产持久化恢复仍待后端**（implemented / backend persistence pending）
- 依据：[ADR-0010](adr/0010-command-event-bridge.md)；桥与契约定见 [命令事件桥](command-event-bridge.md)；协议见 [实时协议](realtime-protocol.md)；装配见 [FAB 运行时](fab-runtime.md)
- 当前实现：`CommandEventRecovery` 已实现有界 pending 队列、按 (fabId, commandId) 查询与 `CommandGateway` 权威对账；M4 的 `FabRuntime.reconcileCommand` 与 `CommandReconciler` 已在假 gateway 上验证 CE-05/CE-06。持久恢复与真实后端查询仍缺。
- 边界：**前端只做有界尽力恢复；持久化/权威恢复是后端责任**。本文档不承诺“关闭浏览器也不丢命令结果”

## 1. 为什么需要核对

实时命令结果可能因为以下原因没有到达工作流：actor 尚未创建、页面已卸载、WebSocket 断线/重连、提交响应与推送乱序、FAB 运行时重启、命令结果重复/乱序。如果这些情况简单地“丢弃/忽略”，会出现：

- 命令实际已成功，但 UI 永远停在“执行中”；
- 重复终态导致 UI 状态回退或重复动作；
- 断线恢复后展示旧状态，用户据此做错误操作。

核对（reconciliation）用“**关联记录 + 权威状态查询 + 有界重试**”把这些场景收敛到后端事实，而不是靠实时消息顺序猜测。

## 2. 恢复对象与状态模型

### 2.1 关联记录（CommandCorrelationRegistry，Application）

| 字段 | 说明 |
|---|---|
| `fabId` / `commandId` | 复合身份 |
| `idempotencyKey` | 提交幂等键（HTTP 提交重试去重） |
| `latestRevision` | 已应用的最大 revision |
| `terminal` | 是否已到终态（succeeded/failed/cancelled） |
| `submissionState` | submitting / acknowledged / failed |
| `createdAt` / `updatedAt` | 记录生命周期 |
| `sourceStreamId` | 最近一次来源流（诊断用） |

### 2.2 恢复记录（CommandEventRecovery，Application）

| 字段 | 说明 |
|---|---|
| `fabId` / `commandId` / `revision` / `outcome` | 未送达工作流的事件内容 |
| `receivedAt` | 到达时间（仅诊断） |
| `attempts` | 已尝试恢复次数 |
| `status` | pending / reconciling / reconciled / abandoned |
| `lastError` | 最近一次失败原因（脱敏） |
| `terminal` | 是否终态事件（优先保留） |

### 2.3 有界 pending queue

- 容量按“活跃命令数上限”设定（M3 与后端/产品共同决定）；**不得无界**。
- 溢出策略：优先保留终态事件；非终态/低价值事件可淘汰并计数告警；**不得静默丢弃终态**。
- 队列元素有 TTL 与最大尝试次数；超过阈值 -> `abandoned` + 可见告警/日志，而不是无声消失。
- 前端不做跨刷新持久化承诺；是否需要 sessionStorage 见 OPEN-V21-09。

## 3. 触发核对的场景

| 场景 | 触发条件 | 处理入口 |
|---|---|---|
| actor 缺失 | `registry.get(fabId, commandId) === undefined` | Bridge -> 恢复记录 -> 待 actor 可用 |
| 页面卸载后结果到达 | 组件已卸载但 Runtime 仍存活 | Bridge 继续处理；UI 重新挂载后读权威状态 |
| WS 确认先于 HTTP 响应 | 结果先到、提交响应后到 | 关联记录按幂等键补全身份（CE-04） |
| 重复/乱序 | revision 相等/更旧 | 去重/拒绝回退（CE-02/CE-03） |
| revision 缺口 | 收到更大 revision 但缺少中间状态 | 不猜测；进入核对（CE-05） |
| 长断线 | 连接恢复且期间可能有终态 | 重连后对活跃命令批量核对（CE-06） |
| 工作流异常 | `receive` 抛错/actor 崩溃 | 记录错误 -> reconcile |
| 终态重复 | 已终态后又收到重复终态 | 幂等；不重复动作 |

## 4. 核对流程（reconcile）

```text
reconcile(commandId):
  1. 在关联记录中取 (fabId, commandId) 与 submission 信息；不存在 -> 记录诊断并退出（不猜）
  2. 查询后端权威状态（按 fabId+commandId 的幂等只读接口）
  3. 比较权威 revision/outcome 与工作流当前状态
  4. 若权威更新：把权威结果应用到工作流（通过受控内部路径，等价于 receive 一次终态）
  5. 若工作流更新（理论上不应发生）：记录冲突，以后端为准并告警
  6. 标记恢复记录 reconciled；清理 pending 中同一命令的旧事件
  7. 失败：按有界退避重试；超过阈值 -> abandoned + 可见告警，保留查询入口
```

要求：

1. **幂等**：同一命令多次 reconcile 结果一致，不产生重复终态动作。
2. **权威优先**：本地实时事件与后端查询冲突时，以后端状态为准，并记录差异。
3. **不伪造**：查询失败时不能把命令标成成功/失败；保持未知/进行中并展示可恢复错误。
4. **有界**：重试次数/间隔/并发有上限（具体值 M3 冻结）；不得在断线风暴中打爆后端。
5. **可观测**：pending/reconciling/abandoned 计数与原因进入诊断（不含敏感数据）。
6. **串行**：同一命令的 reconcile 不得并发；不同命令可有限并发。

## 5. 后端权威查询要求（开发模拟端点已提供，生产持久化仍缺）

前端需要的后端能力（OPEN-V21-07 的开发级端点 `GET /api/v1/commands/{id}` 已提供；生产持久化/幂等仍待后端，不得虚构实现）：

| 要求 | 说明 |
|---|---|
| 只读、幂等 | 重复查询不改变状态 |
| 复合身份 | 按 `(fabId, commandId)` 精确查询，不能只按 commandId |
| 返回权威字段 | revision、outcome、是否终态、最后更新时间/排序依据 |
| 权限 | 只返回调用者有权查看的 FAB/命令 |
| 语义稳定 | 未知/已过期命令返回明确错误，不返回猜测值 |
| 可批量（可选） | 重连后按 FAB 拉取活跃命令集合，避免逐条风暴 |

在端点落地前，CE-05/CE-06 只能用 mock 验证结构；**不得**把 mock 结果描述为生产恢复已验收。

## 6. 断线与重连

1. 断线期间不推进任何“成功/失败”UI 状态；只显示连接中断与可恢复提示。
2. 重连后：新流身份订阅 -> 快照/增量恢复展示数据 -> 对活跃命令执行批量 reconcile（限制并发）。
3. 旧流迟到消息按 stream 身份丢弃；不得用旧事件覆盖权威查询结果。
4. 长期断线（超过阈值）后仍无法核对：保留记录 + 明确告警；不得静默清理。
5. 重连后的重复终态由工作流保证幂等（CE-06）。

## 7. 页面卸载与 Runtime 生命周期

- 页面卸载**不**自动销毁 FAB 运行时；否则卸载期间到达的结果会丢失。Runtime 生命周期由应用/FAB 会话管理（见 [FAB 运行时](fab-runtime.md) 第 5 节）。
- 页面重新挂载后：通过 `CommandGateway`（`HttpCommandGateway`）读取命令权威状态恢复展示；不直接读 actor 内部。
- 组件卸载后不得再异步 `setState`（React 警告/泄漏）；用挂载检查或订阅纪律保证。
- FAB 切换/登出/运行时销毁：停止订阅与 actor；pending 按策略清理；不得把 A FAB 的恢复记录带到 B FAB。

## 8. 三 FAB 隔离

- 所有关联/恢复/队列键都使用 `(fabId, commandId)`；不得只按 commandId。
- 每个 FAB Runtime 拥有独立的 Bridge/Registry/Recovery；Query 缓存共享但 key 含 `fabId`。
- 同一 commandId 在三个 FAB 中可同时存在，各自独立核对（CE-07）。
- 销毁 FAB-A 不得影响 FAB-B/C 的订阅、actor、恢复记录（CE-08 的扩展断言）。

## 9. 与其他层的边界

| 层 | 与核对的关系 |
|---|---|
| 实时协议 | 提供事件与序列/缺口信号；不做业务去重（[实时协议](realtime-protocol.md)） |
| CommandEventBridge | 触发恢复记录、调用 reconcile；不写 Query/UI |
| runtime/commands/CommandReconciler | 具体核对逻辑：调用权威查询、把结果应用到 actor |
| XState actor | 持有命令生命周期；通过受控路径接受 reconcile 结果 |
| TanStack Query / CommandGateway | Query 只负责 HTTP 服务端缓存；命令权威状态经 `HttpCommandGateway` 读取；二者都不是恢复队列/权威来源 |
| 后端 | 持久化恢复的最终责任方；提供权威查询 |

## 10. 验证矩阵

| 场景 | 覆盖门禁 | 证据状态 |
|---|---|---|
| actor 缺失恢复 | CE-05 | PASS（`tests/contract/command-recovery.test.ts`，mock gateway） |
| 断线重连收敛 | CE-06 | PASS（测试源 + 后端权威查询端点） |
| 确认先于 HTTP 响应 | CE-04 | PASS（`tests/integration/command-event-bridge.test.ts`，假源） |
| 重复 revision | CE-02 | PASS（同上） |
| 乱序回退 | CE-03 | PASS（同上） |
| 三 FAB 隔离 | CE-07 | PASS（`tests/integration/fab-runtime.test.ts`） |
| 销毁后不再回调 | CE-08 | PASS（`tests/integration/fab-runtime.test.ts`） |

测试文件：`web_app/tests/contract/command-recovery.test.ts`、`web_app/tests/integration/command-event-bridge.test.ts`、`web_app/tests/integration/fab-runtime.test.ts`，均已真实运行 PASS。生产 WebSocket 链路仍未接，CE-06 的生产级依赖仍由后端承担。

## 11. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| 后端无权威查询 | CE-05/CE-06 无法闭环 | 后端排期；前端用 mock 验证结构并明确标注 |
| 恢复队列无界/静默淘汰 | 终态丢失 | 有界 + 终态优先 + 告警；测试覆盖溢出 |
| reconcile 风暴 | 后端压力 | 并发/重试上限；批量查询；观察指标 |
| 页面卸载后 setState | 泄漏/警告 | 订阅与挂载检查纪律；Runtime 级状态 |
| 用旧事件覆盖权威 | 状态回退 | 权威优先；旧流身份过滤；CE-03/CE-06 |

开放问题：OPEN-V21-07（权威查询）、OPEN-V21-09（恢复记录生命周期）、OPEN-V21-13（工作流状态只读暴露），见 [架构基线](architecture.md) 第 14 节。

## 12. Round 4 修订（2026-10-30）

- `FabReconciliationScheduler.schedule/scheduleMany` 返回逐命令 `ReconciliationResult`（succeeded/already-terminal/not-found/failed/timed-out/cancelled/dropped + payload-free error）；恢复批次必须校验每个结果，失败/超时/取消（仍活跃命令）使 RecoveryPass 失败并进入有界退避。
- Recovery pass 的 cover 与时序：authoritative records 应用 → post-snapshot batch 收敛 → `source.cover(watermark, kind)` → 重置 attempts/active request → Healthy/Degraded。禁止先 cover 后 batch、批次失败仍 Healthy、批次前清零 attempts。
- 权威 List/Journal 应用走 `receiveAuthoritative`（绕过 SSE observed 去重）；`flushRecovery` 只释放 Applied/Covered，rejected 重新入队并触发 Dirty。


## 13. Round 5 修订（已实施，2026-10-30）

Round 5 源码整改已提交 `4c8f0c1`：活动命令 GET 404 要求完整 List；被权威集合裁剪且最终结果未知时使用 `expired-unresolved`。Round 5 规范见 `architecture/18-round5-remediation-specification.md`。

## 14. Round 5.1 修订：Recovery 最终验收屏障（2026-10-30）

状态：契约/源码整改（Round 5.1）；规范见 `architecture/19-round5.1-remediation-specification.md` §2.1/§3。本节优先于本文 §4/§12 中“恢复完成即 Healthy”的任何旧描述。

### 14.1 四个必须分开的事实

Recovery 的完成不是单一事件。以下四个事实互相独立，任何一个成功都不能替代其他三个：

1. **HTTP recovery success**：gateway 返回了 Journal 页/List 响应；
2. **List/journal application**：权威记录已经通过 `receiveAuthoritative` 应用到 actor；
3. **actor batch completion**：post-snapshot scheduler 对每个活动命令给出了收敛结果；
4. **ACK cover success**：transport 接受权威水位（`cover(...) = covered`）并且 post-cover pending ACK 为 0。

“HTTP 成功”不等于“已应用”，“已应用”不等于“活动命令已收敛”，“已收敛”不等于“ACK 安全前缀已签收”。**cover 成功本身永远不意味着 Healthy。**

### 14.2 最终验收屏障流水线（严格顺序）

```text
Recovering (generation g, owned fiber in RecoveryScope)
  1. snapshot = executeRecoveryEffect(g, request)
       - list: listFabCommands(site, fab, 'all')，validate 后逐条 receiveAuthoritative
       - journal: 分页循环到 latestSequence，epoch/序号/保留窗口校验通过
  2. apply authoritative records
       - receiveAuthoritative 绕过 SSE observed 去重；applied|stale-covered 才计入
       - 本地活动而权威集合缺失的命令 -> markExpiredUnresolved（不伪造终态）
  3. reconcile active commands（post-snapshot scheduler batch）
       - 每个仍活动命令的结果必须收敛；failed/timed-out/cancelled/not-found -> pass 失败
  4. PRE-COVER barrier（同步检查，失败 -> 不 Healthy）
       pendingRecovery === undefined
       recoveryPending === false
       bridge.pendingCount === 0            （held events + conflicts）
       effective pendingDropCount === 0     （drop generation <= snapshot.dropBarrier 视为已覆盖）
       bridge.conflictCount === 0
       batchFailure === undefined
       realtimeAvailability === 'ready'      （环境条件）
       connectionStatus === 'open'           （环境条件；closed idle 不 Healthy，也不强制打开）
  5. cover = source.cover({epoch, sequence}, snapshot.kind, snapshot.lossBarrier)
       status 必须为 'covered'；insufficient -> 本轮失败（保留 ACK latch，下一轮 List）
  6. POST-COVER barrier（与 cover 同一个同步窗口，中间不得有 async 让出点）
       source.cursors.pendingAcknowledgements === 0   （必填 number；缺失=失败，绝不视为 0）
       bridge.pendingCount === 0
       bridge.conflictCount === 0
       pendingRecovery === undefined / recoveryPending === false
  7. 只有 4、5、6 全部通过才 completeRecoverySuccess：
       attempts=0、清除 activeRecoveryRequest、resolveCoveredDrops
       Healthy 仅当 recoveryAvailable && realtimeAvailability==='ready' && connectionStatus==='open'
       否则 Degraded（不得 Healthy）
```

失败语义（不得静默、不得绕过）：

- 任一屏障失败：`needsNextAuthoritativePass = true`，记录有界诊断，绝不 Healthy。然后按失败类别处理：
  - **正确性失败**（pending request/queued pass、bridge held/conflict、未覆盖 drop、batchFailure）：合并 `{ listOnly: true }` 恢复请求，走既有 `scheduleCompensationPass` / 有界退避路径；耗尽后 `Unrecoverable`，绝不 Healthy。
  - **环境失败**（`realtimeAvailability !== 'ready'`、`connectionStatus !== 'open'`）：只置 `Degraded`，**不进入补偿循环**；由下一次连接状态迁移重新武装一次权威 pass（而不是失败重试风暴）；不得强行打开连接来满足屏障。
- post-cover 屏障失败时 **不得** 清除 ACK/ledger 状态，**不得** 修改 `delivered`（runtime 从不写 delivered），保留现场等待下一轮权威 List 覆盖。
- 无 workflow 的 realtime 事件（`onUncorrelated`）与同 revision 不同 outcome 的冲突（`onConflict`）在恢复过程中到达：写诊断、置 `needsNextAuthoritativePass`、合并 list-only 请求、**不 ACK**；若当前无进行中的 pass 才调度新 pass，不得并行第二个恢复执行器。

### 14.3 expired-unresolved 与恢复的关系

- 只有“完整权威 List 证明本地仍活动的命令缺失”才能进入 `expired-unresolved`；它是恢复处置（recovery disposition），不是业务终态。
- 进入后该命令不再计为活动命令（不阻塞 Healthy、不会被无限 reconcile），但 UI/投影保留“结果未知”语义，禁止伪造 succeeded/failed/cancelled。
- realtime 事件（任意 revision）永远不能把它复活；只有经校验的权威记录能把它恢复为 `tracked` 并应用 revision/outcome。
- 若后续权威记录始终缺失，保持 `expired-unresolved` 并给出可观察诊断；不重试成终态。

### 14.4 测试要求

`web_app/tests/integration/fab-runtime.test.ts`：

- post-snapshot reconciliation 期间注入无 workflow 的 realtime 事件 → `bridge.pendingCount > 0`、`needsNextAuthoritativePass`、phase 不是 Healthy、调度新的 List pass；下一轮 List 返回权威记录后重新收敛才 Healthy；
- cover 返回 `covered` 但 `cursors.pendingAcknowledgements === 1` → 不是 Healthy；下一轮权威 List 覆盖该 pending 条目后才 Healthy；
- post-snapshot drop（generation > dropBarrier）→ `needsNextAuthoritativePass`、有界补偿，不得 Healthy；
- 批次失败（failed/timed-out/cancelled）→ pass 失败进入有界退避，不重置 attempts、不 cover、不 Healthy。

`web_app/tests/integration/fab-runtime-batch23.test.ts`：快照应用之后、对账批次期间到达的新事件/新请求 → 补偿 List pass，期间不得 Healthy，权威解决后收敛。

失败/覆盖/屏障诊断必须可观察（phase、`needsNextAuthoritativePass`、`coveredDropCount`、`compensationAttempts`、`lastDirtyCause`），但诊断不得包含命令 payload。
