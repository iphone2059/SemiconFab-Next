本次整改规范将以 GitHub 提交 `f5dd8a8bfcf304ebf74bff0737dfc4589d8ddd9e` 为基线，命名为：

Round 5 — Command Runtime Correctness & Consistency Remediation Specification

本轮不再重复 Round 4 的整体架构设计，也不进行兼容性改造。目标是修复已经识别的运行时正确性缺陷，并使前端 Runtime、SSE Transport、Actor、Scheduler 和后端持久化之间形成严格、可证明的状态一致性契约。

规范采用以下原则：

1. 服务端持久化状态是命令状态的权威来源。
2. 客户端 observed、applied、acknowledged 三种进度严格分离。
3. 所有状态转换必须有明确的前置条件和后置条件。
4. 取消操作必须真正终止所属异步工作，而不只是停止等待。
5. 成功提交的命令必须能够在客户端可靠注册。
6. 恢复完成必须证明本地状态与权威状态收敛，不能仅凭请求成功判断。

以下文档可以直接作为下一轮逐文件整改依据。

> **历史记录说明（2026-10-30）：** 本文是 Round 5 的历史整改规范。Round 5 的源码整改已由提交 `4c8f0c1` 落地；Round 5.1 复审发现的剩余 P1/P2 不变量缺口由 `docs/architecture/19-round5.1-remediation-specification.md` 规范并实施（P1-01 恢复最终屏障、P1-02 revision/outcome 冲突与权威修正、P1-03 realtime/authoritative 来源隔离与 expired 语义、P1-04 cover 不伪造 delivered、P2-01 ConnectionStatus 生命周期、P2-02 按需 Command SSE、P2-03 独立 Workflow/Correlation TTL、P2-04 fake 协议保真）。**Round 5.1 取代本文中剩余的 P1/P2 义务**；本文保持原样作为历史记录，若本文与 19 号规范或 `web_app/src` 源码冲突，以 19 号规范与源码为准。

# Round 5 — Command Runtime Correctness & Consistency Remediation Specification

**项目：** SemiconFab-Next\
**分支：** main\
**整改基线：** `f5dd8a8bfcf304ebf74bff0737dfc4589d8ddd9e`\
**前置基线：** `d04ee8b2bbcdf1ad5816c28515c697f8a57b44f3`\
**整改性质：** 正确性修复、状态一致性修复、生命周期修复\
**优先级：** P1-01 至 P1-05、P2-01 至 P2-02

---

# 1. 整改目标与边界

本轮只处理 Round 4 复审发现的问题，不进行无关重构。

核心目标是建立以下完整闭环：

1. SSE Transport 正确识别、记录和恢复丢失事件。
2. CommandEventBridge 只在 Actor 确实应用事件后确认事件。
3. Correlation 严格区分 observed revision 和 applied revision。
4. FabRuntime 能够通过完整权威快照实现本地状态收敛。
5. Scheduler 的任务生命周期能够被真正取消。
6. 命令提交与前端 Workflow 注册之间不存在提交成功但注册失败的窗口。
7. Recovery 的 Healthy 状态具有严格、可验证的进入条件。
8. 所有缓存、队列、Actor 和定时器都有明确的容量与生命周期边界。

## 1.1 不允许的实现

- 不允许通过 `Math.max`、`Math.min` 等方式掩盖非法配置。
- 不允许通过增加重试次数掩盖状态一致性错误。
- 不允许通过延长 TTL 掩盖状态泄漏。
- 不允许通过捕获异常后忽略错误来保持流程运行。
- 不允许把 HTTP 请求完成等同于 Actor 状态收敛。
- 不允许把 observed revision 当成 applied revision。
- 不允许把 HTTP 404 当作成功收敛。
- 不允许把未知命令结果伪造成 succeeded、failed 或 cancelled。
- 不允许通过 Promise 超时停止等待，却让底层请求继续执行。
- 不允许在 HTTP 202 返回后再次执行可能拒绝该命令的本地 admission。
- 不允许为了修复问题增加第二套 Scheduler、第二套 Workflow 注册表或第二套命令状态缓存。

---

# 2. 全局状态不变量

以下不变量是所有文件必须共同满足的规范。任何单个模块不能通过自己的局部实现破坏这些约束。

## 2.1 SSE 三游标不变量

Transport 必须严格区分：

| 游标           | 定义                  | 允许推进的条件                            |
| ------------ | ------------------- | ---------------------------------- |
| observed     | 最近观察到的 SSE 位置       | 收到有效 SSE ID                        |
| delivered    | 最近成功交付到有界消费者的事件位置   | Queue publish 成功                   |
| acknowledged | 已经安全应用或被权威快照覆盖的连续前缀 | 连续 ACK ledger 前缀全部 Applied/Covered |

必须满足：

- `acknowledged` 不得超过能够证明安全的连续前缀。
- `observed` 永远不能直接用于恢复起点。
- `delivered` 永远不能直接用于恢复起点。
- 同 epoch 下 acknowledged 严格单调递增。
- epoch 替换只能通过成功的权威 List cover 完成。
- 存在未覆盖丢失位置时，不允许解除 ACK latch。
- 任何无法证明位置的事件丢失都必须触发 List Recovery。

## 2.2 Command Revision 不变量

每个 `(fabId, commandId)` 独立维护：

- `observedRevision`
- `appliedRevision`

必须满足：

[\
appliedRevision \le observedRevision\
]

其中：

- `observedRevision` 表示系统见过的最高 revision。
- `appliedRevision` 表示 Actor projection 已经证明应用的最高 revision。
- 只有 Actor projection 证明前进后才能更新 `appliedRevision`。
- Actor 拒绝事件不能更新 `appliedRevision`。
- 重复事件不能自动证明已经应用。
- 旧事件不能仅凭 observed watermark 判定为 applied。

## 2.3 权威状态不变量

后端 SQLite 持久化数据是命令状态的唯一权威来源。

客户端：

- Actor 是单条命令的本地业务状态投影。
- Correlation 是事件身份与 revision 的去重索引。
- Recovery 是丢失事件的有界暂存区。
- Scheduler 是唯一权威查询执行器。
- Atom 是 UI 读取的只读投影。

禁止任何客户端缓存成为第二份命令业务状态权威。

## 2.4 Healthy 不变量

只有同时满足以下条件才能进入 `Healthy`：

1. CommandGateway 可用。
2. EventSource 环境能力可用。
3. SSE 连接状态为 `open`。
4. 当前 Recovery generation 已完成。
5. 权威快照中的活动命令已经应用。
6. 所有需要核对的活动命令已经收敛。
7. 所有 held event 已经应用或被权威覆盖。
8. ACK cover 明确返回成功。
9. 不存在未解决的 RecoveryDropIntent。
10. 不存在未处理的 Actor rejection。
11. 不存在未完成的恢复请求。

任何一个条件不满足，都不得报告 Healthy。

## 2.5 Admission 不变量

前端：

[\
N\_{\text{active}} + N\_{\text{reserved}}\
\le C\_{\text{frontend}}\
]

后端：

[\
N\_{\text{persisted-active}}\
\le C\_{\text{backend}}\
]

其中后端 SQLite 事务是最终 admission 权威。

最重要的约束：

**后端已经返回 HTTP 202 的命令，前端必须注册，不能再次拒绝。**

## 2.6 Cancellation 不变量

取消必须遵循资源所有权：

- 取消 Recovery 不得取消显式用户请求。
- 取消一个 Scheduler waiter 不得取消其他 waiter 仍需要的共享请求。
- 最后一个 waiter 取消后，底层 HTTP 请求必须真正中断。
- 中断后释放 Semaphore 和 PhysicalRequestBudget。
- 旧 generation 的迟到结果不得写入 Actor。
- `stop()` 返回时，不得残留属于该 Recovery generation 的请求。

---

# 3. P1-01：ACK Cover 原子化

**优先级：最高**

涉及文件：

1. `web_app/src/contracts/command-events.contract.ts`
2. `web_app/src/realtime/command-event-source.transport.ts`
3. `web_app/src/runtime/fab-runtime.ts`
4. `web_app/tests/realtime/realtime-transport.test.ts`
5. `web_app/tests/correctness/sse/matrix-1-ordered-ack-ledger.test.ts`
6. `web_app/tests/correctness/sse/matrix-1-three-cursor.test.ts`

## 3.1 command-events.contract.ts

修改 `CommandEventSource.cover()`。

当前返回 `void`，无法让 Runtime 确认 cover 是否真正完成。

必须引入明确的结果类型：

- `covered`
- `insufficient`

结果必须包含：

- 实际 cover cursor。
- cover authority。
- 是否成功解除 latch。
- 失败原因。
- 后续需要执行的恢复类型。

`cover()` 必须成为具有明确后置条件的同步状态转换。

不得仅依靠 Dirty Stream 的异步通知判断 cover 是否成功。

## 3.2 command-event-source.transport.ts

重点修改：

- `coverCoversLatch`
- `cover`
- `drainAcknowledgedPrefix`
- `markUntrustedGap`
- `recordUntrackedPosition`

### 必须修改的执行顺序

当前实现先修改 ledger 和 acknowledged，再检查 cover 是否足够。

必须改为：

1. 获取当前 ACK latch 状态。
2. 获取 untracked high-water。
3. 检查 epoch。
4. 检查 authority。
5. 检查 cursor 是否覆盖所有已知位置。
6. 检查是否存在 unknown gap。
7. 计算 cover 结果。
8. 只有结果为 covered 才修改 ledger、cursor 和 latch。
9. 最后执行连续 ACK prefix drain。

如果 cover 不足：

- acknowledged 不得改变。
- delivered 不得改变。
- ledger 不得改变。
- ledgerEpoch 不得改变。
- ACK latch 不得解除。
- high-water 不得清除。
- unknown-gap 标记不得清除。
- 发布 `uncovered-gap`。
- 返回 `insufficient`。

本轮采取保守策略：不完整 cover 统一要求重新执行权威 List，不允许使用一个不完整的 Journal cover 逐步放宽安全约束。

### 必须验证的场景

| 场景                                      | 预期结果                   |
| --------------------------------------- | ---------------------- |
| unknown gap + Journal cover             | 拒绝，所有游标不变              |
| unknown gap + List cover                | 成功解除 latch             |
| cross-epoch + Journal cover             | 拒绝                     |
| cross-epoch + List cover                | 成功替换 epoch             |
| known high-water + cursor 小于 high-water | 拒绝                     |
| known high-water + cursor 覆盖 high-water | 成功                     |
| cover 过程中产生新的 untracked position        | 新位置不能被旧 cover 错误覆盖     |
| ledger 存在 pending entry                 | 不能越过 pending entry ACK |

## 3.3 fab-runtime.ts

修改：

- `completeRecoverySuccess()`
- Recovery pass 成功处理逻辑
- `source.cover()` 调用位置

必须遵守：

**先 cover，后重置 Recovery 状态。**

新的顺序：

1. 权威 snapshot 应用完成。
2. Scheduler batch 收敛。
3. 确认没有新的 drop。
4. 调用 `source.cover()`。
5. 检查 cover 返回值。
6. cover 成功后重置 attempts。
7. 清除 activeRecoveryRequest。
8. 更新 recoveryCursor。
9. 根据实时连接状态确定 Healthy 或 Degraded。

cover 返回 insufficient 时：

- 不清除 Recovery request。
- 不重置 attempts。
- 不更新 Healthy。
- 强制下一次恢复使用 List。
- 保留原始错误诊断。

## 3.4 完成标准

- Cover 不足不会修改任何安全游标。
- 不存在 latch 仍然 Healthy 的状态。
- 不存在旧 cover 释放新丢失位置的情况。
- 任何 ACK 都不能越过未应用事件。

---

# 4. P1-02：Realtime Actor Rejection 修复

涉及文件：

1. `web_app/src/runtime/command-event-bridge.ts`
2. `web_app/src/runtime/command-correlation-registry.ts`
3. `web_app/src/runtime/command-event-recovery.ts`
4. `web_app/src/runtime/fab-runtime.ts`
5. `web_app/tests/integration/command-event-bridge.test.ts`
6. `web_app/tests/contract/command-correlation.test.ts`

## 4.1 command-event-bridge.ts

重点修改：

- `receive()`
- `receiveAuthoritative()`
- `applyToWorkflow()`
- `flushRecovery()`
- commandResults Stream consumer

### Realtime rejection

当前 Stream consumer 忽略 `receive()` 返回值。

必须建立统一的 rejection 处理路径。

当 Actor 拒绝事件：

1. 不调用 ACK。
2. 不更新 applied revision。
3. 将事件保留在 Recovery 暂存区。
4. 调用 `onRejected`。
5. 通知 FabRuntime。
6. FabRuntime 进入 Dirty。
7. 执行权威 List Recovery。

不能仅依靠后续出现新 SSE 事件才发现问题。

### Duplicate 和 Stale

必须改变判断依据。

对于 duplicate：

- 如果 `appliedRevision >= event.revision`，返回 `duplicate-applied`。
- 否则必须重新尝试应用，或者进入 rejected recovery。

对于 stale：

- 如果 `appliedRevision >= event.revision`，可以返回 `stale-covered`。
- 如果 `appliedRevision < event.revision`，不得直接返回 `stale-covered`。

observed watermark 不能作为应用证明。

如果 Actor 已经应用了该 revision，则允许对对应 transport ledger entry 进行 ACK。

如果没有应用证明，则进入 Recovery。

### appliedRevision 高于当前事件但低于 observedRevision

这种情况必须被识别。

例如：

- observed = 5
- applied = 3
- 当前事件 revision = 4

即使 revision 4 可以被 Actor 接受，系统仍然知道 revision 5 尚未被证明应用。

必须触发 Dirty，不能因为 revision 4 成功就进入 Healthy。

## 4.2 command-correlation-registry.ts

明确 API 语义：

- `lastRevision()` 应明确命名为 `lastObservedRevision()`。
- `lastAppliedRevision()` 保留。
- 不允许根据 observed revision 推导 applied revision。
- applied watermark 只允许单调推进。

增加明确的未收敛状态查询能力，例如：

`hasUnappliedObservation(fabId, commandId)`

判断条件：

`observedRevision > appliedRevision`

当两个 watermark 之间存在未应用进度时，Runtime 必须能够发现。

## 4.3 command-event-recovery.ts

确保：

- rejected event 可以重新进入有界 Recovery queue。
- 相同 revision 不产生重复记录。
- 新 revision 不会被旧 revision 替换。
- 应用成功后才释放对应记录。
- queue capacity eviction 必须触发 Dirty。
- Recovery queue 不承担长期持久化职责。

## 4.4 完成标准

必须通过：

1. 同 revision 第二次收到时，Actor 未应用则不能被判定为 duplicate-applied。
2. observed=5、applied=3、收到 revision 4，不得判定 stale-covered。
3. Actor rejection 必须触发 Dirty。
4. 被拒绝事件不能推进 ACK。
5. 权威 List 可以修复之前 observed 但未 applied 的事件。
6. Recovery queue 只能释放已应用或已覆盖事件。

---

# 5. P1-03：权威 List 完整集合对账

涉及文件：

1. `web_app/src/contracts/command-gateway.contract.ts`
2. `web_app/src/contracts/command-workflow.contract.ts`
3. `web_app/src/runtime/fab-runtime.ts`
4. `web_app/src/runtime/command-reconciler.ts`
5. `web_app/src/runtime/fab-reconciliation-scheduler.ts`
6. `web_app/src/runtime/equipment-command.logic.ts`
7. `web_app/src/runtime/equipment-command.machine.ts`
8. `web_app/src/runtime/xstate-command-workflow-adapter.ts`
9. `web_app/tests/integration/fab-runtime.test.ts`
10. `web_app/tests/integration/fab-runtime-batch23.test.ts`
11. `web_app/tests/contract/command-workflow.test.ts`
12. `fab_tests/src/CommandRecoveryApiTests.cs`
13. `fab_tests/src/CommandRetentionTests.cs`

## 5.1 核心问题

当前 List Recovery 主要处理服务端返回的记录，没有处理：

**本地 active Workflow 存在，但服务端权威集合已经不存在的情况。**

这会造成本地活动命令泄漏。

## 5.2 command-gateway.contract.ts

Recovery List 必须使用完整集合语义。

本轮将 FabRuntime 的恢复查询固定为：

`listFabCommands(siteId, fabId, 'all')`

不再允许 Runtime 使用仅返回 active 的 List 作为完整权威集合。

后端已经支持：

- active
- terminal
- all

因此不需要增加第二个 API。

移除 FabRuntime 中可削弱完整集合保证的 `listFilter` 配置。

## 5.3 fab-runtime.ts

重点修改：

- `listRecoveryEffect()`
- `trackAuthoritativeCommand()`
- `activeCommandIds()`
- `countActiveCommands()`
- `isTerminalCommand()`
- `recordTerminal()`
- `resolveReconciliationTarget()`
- `batchFailure()`

### A. 获取 List 前记录本地活动集合

在开始权威 List 请求之前，记录：

`localActiveAtSnapshotStart`

该集合只包含快照开始前已经存在的本地活动命令。

这样可以避免将快照期间新提交的命令错误判定为已丢失。

### B. 获取完整权威 List

获取：

- epoch
- latestSequence
- commands

必须验证：

- Site/FAB 身份正确。
- commandId 唯一。
- revision 合法。
- outcome 合法。
- terminal 与 outcome 一致。
- latestSequence 合法。

### C. 应用权威记录

对于 active record：

1. 创建或取得 Workflow。
2. 通过 `receiveAuthoritative()` 应用。
3. 验证 Actor projection。
4. 更新 applied watermark。

对于 terminal record：

1. 如果本地存在对应 Workflow，则应用终态。
2. 如果本地不存在，不创建额外 Actor。
3. 更新本地 resolved retention。

所有拒绝必须使 Recovery pass 失败。

### D. 处理本地多余活动命令

计算：

`localActiveAtSnapshotStart - authoritativeCommandIds`

对于差集中的每一个命令：

- 如果 Actor 已经进入真实终态，不再处理。
- 如果 Actor 仍然 active，则标记为 `expired-unresolved`。

这里有一个重要的领域约束：

**不能把已经被后端裁剪的命令伪造成 succeeded、failed 或 cancelled。**

后端没有保留最终 outcome，就不能凭空制造业务结果。

### E. 增加独立的 Recovery Disposition

在 `CommandWorkflowProjection` 中增加：

`recoveryDisposition`

取值：

- `tracked`
- `expired-unresolved`

`expired-unresolved` 表示：

- 后端完整活动快照已经证明该命令不再 active。
- 但客户端无法获得最终业务结果。
- 该命令不再占用 active admission。
- UI 必须显示结果不可确认。
- 不得伪装成业务成功或失败。

同时在 XState workflow 中增加对应的 `expired` 状态。

该状态：

- 不改变原有 `CommandOutcome`。
- 不伪造 revision。
- 不伪造终态事件。
- 不计入活动命令。
- 允许未来迟到的有效权威事件将其更新为真实终态。

`expired` 是客户端恢复状态，不是后端新增的 CommandOutcome。

### F. 修复 not-found 语义

Scheduler 的 `not-found` 不能再被当作正常收敛。

当一个本地 active Workflow 查询后端得到 404：

1. 当前 Recovery pass 失败。
2. 强制下一次执行完整 List。
3. 重新检查该命令是否存在于权威集合。
4. 如果不存在，标记 `expired-unresolved`。
5. 如果仍然存在，重新核对。

不能直接 Healthy。

## 5.4 完成标准

必须覆盖：

- 本地 active、服务端 active。
- 本地 active、服务端 terminal。
- 本地 active、服务端已经裁剪。
- HTTP GET 404，但下一次 List 仍然包含命令。
- HTTP GET 404，下一次 List 不包含命令。
- List 请求过程中产生新命令。
- List 快照期间命令从 active 变成 terminal。
- 多 FAB 不得互相污染。
- expired-unresolved 不占用 active admission。
- 不得制造不存在的最终业务结果。

---

# 6. P1-04：Admission Reservation 与 Accepted Registration 分离

涉及文件：

1. `web_app/src/runtime/fab-runtime.ts`
2. `web_app/src/runtime/fab-runtime-registry.ts`
3. `web_app/src/workbench/use-command-console.ts`
4. `web_app/src/api/commands.mutation.ts`
5. `web_app/src/contracts/command-workflow.contract.ts`
6. `web_app/tests/integration/fab-runtime.test.ts`
7. `web_app/tests/integration/fab-runtime-batch23.test.ts`
8. `web_app/tests/features/workbench/use-command-console.test.tsx`（新增）

## 6.1 删除当前错误的提交后 Admission

当前：

HTTP POST → 202 → trackCommand → capacity check

这个顺序必须废除。

## 6.2 FabRuntime 新 API

拆分为两个不同职责。

### A. reserveCommandAdmission

提交 HTTP 请求之前调用。

职责：

- 检查当前 active Workflow 数量。
- 检查尚未提交的 reservation 数量。
- 检查 `maxActiveCommands`。
- 为一个逻辑提交创建 reservation。
- 同一个 idempotency key 不允许重复占用多个 reservation。

返回一个一次性 Reservation 对象。

Reservation 具有：

- `commit(commandId)`
- `release()`

状态严格限定为：

`reserved → committed`

或：

`reserved → released`

不得重复提交、重复释放或重复消费。

### B. registerAcceptedCommand

收到后端 HTTP 202 后调用。

职责：

- 注册已经被后端接受的命令。
- 创建 Workflow。
- 创建 CommandScope。
- 注册 Projection。
- 订阅 Actor。
- 启动 Actor。
- flush 已经提前到达的 SSE 事件。
- 释放对应 reservation。

**这个方法绝对不能再执行 admission rejection。**

如果本地活动数量超过配置：

- 记录 `active-capacity` diagnostic。
- 注册已经接受的命令。
- 进入权威 List Recovery。
- 不得丢弃命令。

### C. trackCommand

删除旧的单阶段 `trackCommand()` API。

新 API 必须明确区分：

- 新提交的本地 reservation。
- 后端已经接受的命令。
- 权威恢复发现的命令。

三个入口不能混用。

## 6.3 fab-runtime-registry.ts

增加统一的 accepted registration 入口。

例如：

`registerAcceptedCommand(siteId, fabId, commandId, reservation)`

必须：

- 校验 Site/FAB 身份。
- 使用当前注册的 FAB Runtime。
- 不允许跨 FAB 注册。
- 不允许对已 disposed Runtime 写入。
- 当前 Runtime 不存在时，将后续恢复责任交给该 FAB Runtime 的启动 List Recovery。

不能依赖 Workbench 组件是否仍然挂载来决定命令是否被注册。

## 6.4 use-command-console.ts

修改提交顺序：

1. 生成或复用 idempotency key。
2. 新逻辑命令执行 admission reservation。
3. 执行 HTTP POST。
4. 收到 202 后，通过 registry 注册 accepted command。
5. 更新 Workbench tracked ledger。
6. 释放或消费 reservation。

特别处理异步生命周期：

当前代码在 `isCurrentScope()` 检查失败后直接 return。

必须调整：

**先处理已经接受的命令注册，再判断是否允许更新当前 UI。**

组件已经切换 FAB 或卸载，不能成为丢失已接受命令的理由。

### Idempotency retry

同一个 pending idempotency key 的重试属于同一个逻辑提交。

它不得重复占用本地 reservation。

重试由后端幂等机制决定：

- 已经提交：返回原 commandId。
- 尚未提交：正常执行后端 admission。
- 容量不足：返回 429。

### HTTP 失败

- 明确拒绝的请求：释放 reservation。
- 网络错误或 5xx：保留原 idempotency key，以便用户重试。
- 429：释放 reservation，不创建 Workflow。
- 202：必须完成 accepted registration。

## 6.5 完成标准

必须证明：

- 前端达到容量上限时，新逻辑提交不会发出 HTTP 请求。
- HTTP 202 之后不会出现 `ActiveCommandCapacityError`。
- 相同 idempotency key 不会重复占用容量。
- HTTP 429 不创建 Actor。
- SSE 先于 HTTP 响应到达时，accepted registration 能正确消费 held event。
- FAB 切换期间 HTTP 返回 202，仍然可以注册到正确 FAB。
- 组件卸载不能造成已接受命令丢失。
- reservation 不存在泄漏。

---

# 7. P1-05：Scheduler Cancellation Ownership

涉及文件：

1. `web_app/src/runtime/fab-reconciliation-scheduler.ts`
2. `web_app/src/runtime/fab-runtime.ts`
3. `web_app/src/runtime/command-reconciler.ts`
4. `web_app/tests/correctness/gateway/scheduler-timeout.test.ts`
5. `web_app/tests/correctness/gateway/scheduler-cancellation.test.ts`（新增）
6. `web_app/tests/integration/fab-runtime.test.ts`

## 7.1 当前问题

`awaitSchedulerBatch()` 取消的只是等待 Promise。

底层 Scheduler 工作仍然继续。

必须修复任务所有权，而不是仅修改 Promise 包装。

## 7.2 Scheduler API

修改：

- `schedule()`
- `scheduleMany()`
- `ScheduledEntry`
- `start()`
- `itemEffect()`
- `dispose()`

增加调用者级取消参数：

`AbortSignal`

例如：

`scheduleMany(commandIds, { signal })`

## 7.3 ScheduledEntry 所有权

每个 ScheduledEntry 必须具备：

- commandId
- entry generation
- 独立的 waiter 集合
- queued/in-flight 生命周期
- 实际执行 Fiber 或其独立 Scope

每个 waiter 独立拥有自己的等待生命周期。

### 单个 waiter 取消

- 只取消该 waiter。
- 其他 waiter 不受影响。
- 不允许取消共享请求。

### 所有 waiter 取消

- 如果仍在 queue：删除队列项。
- 如果正在执行：中断对应 Fiber。
- AbortSignal 必须传递到 HTTP fetch。
- 释放 PhysicalRequestBudget。
- 释放逻辑 Semaphore。
- 清除对应 entry。

### 多调用者共享请求

假设：

- Recovery 正在等待 command A。
- 用户显式 reconcileCommand 也在等待 command A。

当 Recovery 被 stop：

- Recovery waiter 取消。
- 用户 waiter 继续等待。
- HTTP 请求继续执行。

当两个 waiter 都取消：

- HTTP 请求立即中断。

这样既保留 per-command single-flight，也保证任务取消语义正确。

## 7.4 fab-runtime.ts

修改：

- `awaitSchedulerBatch()`
- `reconcileActiveBatchEffect()`
- `interruptRecoveryPass()`
- `stop()`
- `dispose()`

Recovery 使用 Effect 的取消信号传递给 Scheduler。

`stop()` 必须：

1. 增加 Recovery generation。
2. 中断 Recovery Fiber。
3. 取消 Recovery 的 Scheduler waiter。
4. 如果该请求没有其他所有者，则中断底层请求。
5. 等待取消完成。
6. 确认资源释放后返回。

不得调用整个 Scheduler 的 `dispose()` 来实现 stop。

显式用户 reconciliation 必须继续工作。

## 7.5 完成标准

- Recovery stop 后没有残留 Recovery HTTP 请求。
- Explicit reconciliation 不受 Recovery stop 影响。
- 同命令多 waiter 取消正确。
- Queue 中取消的任务不再执行。
- In-flight 取消会触发 fetch AbortSignal。
- PhysicalRequestBudget.inFlight 最终回到 0。
- 旧 generation 不得修改 Actor。
- Scheduler dispose 后所有 waiter 都得到 cancelled 结果。

---

# 8. P2-01：Resolved Workflow TTL = 0

涉及文件：

1. `web_app/src/runtime/fab-runtime.ts`
2. `web_app/src/runtime/command-correlation-registry.ts`
3. `web_app/tests/integration/fab-runtime-batch23.test.ts`
4. `web_app/tests/contract/command-correlation.test.ts`

## 8.1 明确配置语义

本轮将 Runtime retention 配置统一为 resolved workflow retention。

建议重命名：

- `terminalTtlMs` → `resolvedWorkflowTtlMs`
- `maxTerminalWorkflows` → `maxResolvedWorkflows`
- `terminalAt` → `resolvedAt`

CorrelationRegistry 内部真正的 terminal revision retention 仍然保持独立。

resolved workflow 包括：

- succeeded
- failed
- cancelled
- expired-unresolved

## 8.2 TTL = 0 语义

明确规定：

`resolvedWorkflowTtlMs = 0`

表示：

- 禁用时间驱动的 resolved workflow eviction。
- 不创建 sweep timer。
- 保留 `maxResolvedWorkflows` 数量限制。
- 超过数量限制时，仍然驱逐最早 resolved workflow。

不能将 0 解释为每 1ms 清理一次。

## 8.3 修改 scheduleSweep()

当 TTL 为 0：

- 清除已有 sweep timer。
- 直接返回。
- 不创建新 timer。

## 8.4 完成标准

使用 fake timers 验证：

- TTL=0 不产生重复 timer。
- TTL=0 不执行时间驱动 eviction。
- resolved count 超过容量时仍然正确驱逐。
- TTL 大于 0 时按到期时间清理。
- CorrelationRegistry 不发生无界增长。

---

# 9. P2-02：Realtime Connection State 与 Healthy 统一

涉及文件：

1. `web_app/src/contracts/command-events.contract.ts`
2. `web_app/src/realtime/command-event-source.transport.ts`
3. `web_app/src/runtime/fab-runtime.ts`
4. `web_app/src/runtime/command-sources.ts`
5. `web_app/src/app/runtime-bootstrap.tsx`
6. `web_app/tests/realtime/realtime-transport.test.ts`
7. `web_app/tests/integration/fab-runtime.test.ts`
8. `web_app/tests/integration/runtime-bootstrap.test.tsx`
9. `web_app/tests/support/command-fakes.ts`

## 9.1 区分三个概念

### Transport capability

环境是否支持创建 EventSource。

### Transport availability

Transport 是否允许继续建立连接，或者是否已经永久不可用。

### Connection status

实际连接状态：

- connecting
- open
- reconnecting
- failed

三者不能再混为一谈。

## 9.2 command-events.contract.ts

`connectionStatus` Stream 改为必需契约。

所有正式 CommandEventSource 实现必须提供该 Stream。

测试 Fake 和 Pending Source 必须同步实现。

## 9.3 command-event-source.transport.ts

确保连接状态完整覆盖：

- 初始 connecting。
- 成功 open。
- 网络中断 reconnecting。
- 连接失败 failed。
- 重连成功 open。
- 永久不可用 unavailable。

`availability` 只表示 Transport 能力和永久可用性，不再用于代替实际连接状态。

## 9.4 fab-runtime.ts

`CommandRecoveryState` 增加明确的 `connectionStatus`。

修改：

- `subscribeSignalStreams()`
- `refreshRealtimeAvailability()`
- `completeRecoverySuccess()`
- `recoveryState`
- `connectionState`

Healthy 的必要条件：

`source.availability === 'ready'`

并且：

`connectionStatus === 'open'`

### 状态转换

| 当前连接状态       | 新连接状态                   | Runtime 行为                 |
| ------------ | ----------------------- | -------------------------- |
| connecting   | open                    | 完成初始 Recovery 后才允许 Healthy |
| open         | reconnecting            | 立即离开 Healthy，触发权威恢复        |
| reconnecting | open                    | 重新执行权威核对后才允许 Healthy       |
| open         | failed                  | 立即离开 Healthy               |
| failed       | open                    | 执行恢复后才允许 Healthy           |
| 任意状态         | permanently unavailable | Degraded                   |

当 HTTP Gateway 可用但 SSE 不可用：

`Degraded`

当 HTTP Gateway 不可用：

`Unavailable`

不能把 Degraded 伪装成 Healthy。

## 9.5 完成标准

- EventSource 尚未 open 时不得 Healthy。
- reconnecting 时不得 Healthy。
- failed 时不得 Healthy。
- 重新 open 后不能立即 Healthy，必须完成恢复。
- 永久不可用时保持 Degraded。
- 没有 Gateway 时保持 Unavailable。
- Runtime state 必须与实际 Transport 状态一致。

---

# 10. 逐文件修改总表

以下是本轮必须检查的生产源码文件。

| 文件                                           | 修改内容                                | 优先级   |
| -------------------------------------------- | ----------------------------------- | ----- |
| `contracts/command-events.contract.ts`       | CoverResult、连接状态契约                  | P1/P2 |
| `contracts/command-gateway.contract.ts`      | 完整 List 语义                          | P1    |
| `contracts/command-workflow.contract.ts`     | Recovery disposition                | P1    |
| `realtime/command-event-source.transport.ts` | Cover 原子化、连接状态                      | P1/P2 |
| `runtime/command-event-bridge.ts`            | Realtime rejection                  | P1    |
| `runtime/command-correlation-registry.ts`    | observed/applied 查询语义               | P1    |
| `runtime/command-event-recovery.ts`          | rejected event 保留                   | P1    |
| `runtime/command-reconciler.ts`              | not-found 结果语义                      | P1    |
| `runtime/fab-reconciliation-scheduler.ts`    | waiter cancellation、真实取消            | P1    |
| `runtime/fab-runtime.ts`                     | Recovery、List、Admission、TTL、Healthy | P1/P2 |
| `runtime/fab-runtime-registry.ts`            | Accepted registration               | P1    |
| `runtime/equipment-command.logic.ts`         | expired-unresolved 投影               | P1    |
| `runtime/equipment-command.machine.ts`       | expired 状态                          | P1    |
| `runtime/xstate-command-workflow-adapter.ts` | Recovery disposition 接口             | P1    |
| `workbench/use-command-console.ts`           | reservation 与 accepted registration | P1    |
| `api/commands.mutation.ts`                   | 提交生命周期契约                            | P1    |
| `runtime/command-sources.ts`                 | 完整 ConnectionStatus 契约              | P2    |
| `app/runtime-bootstrap.tsx`                  | 新 Transport 契约装配                    | P2    |

---

# 11. 测试文件整改规范

本轮必须先完成源码修改，再开始测试。

以下是测试覆盖要求，不允许只增加测试数量而没有对应的正确性断言。

## 11.1 SSE / ACK

修改：

- `tests/realtime/realtime-transport.test.ts`
- `tests/correctness/sse/matrix-1-ordered-ack-ledger.test.ts`
- `tests/correctness/sse/matrix-1-three-cursor.test.ts`

验证：

- atomic cover。
- unknown gap。
- cross-epoch。
- high-water。
- stale cover。
- latch 释放。
- 连续 ACK 前缀。

## 11.2 Bridge / Correlation

修改：

- `tests/integration/command-event-bridge.test.ts`
- `tests/contract/command-correlation.test.ts`
- `tests/contract/command-workflow.test.ts`

验证：

- Actor rejection。
- duplicate-but-unapplied。
- stale-but-unapplied。
- observed > applied。
- authoritative re-application。
- Recovery queue selective release。
- expired-unresolved 后迟到事件的正确应用。

## 11.3 Recovery / List

修改：

- `tests/integration/fab-runtime.test.ts`
- `tests/integration/fab-runtime-batch23.test.ts`
- `tests/core/core-010-command-overflow-recovery.test.ts`

验证：

- active → active。
- active → terminal。
- active → pruned。
- HTTP 404 → List。
- List 缺失 → expired-unresolved。
- List 中的 terminal record。
- 快照期间的新提交。
- 快照期间的终态转换。
- List 拒绝时不 Healthy。

## 11.4 Scheduler Cancellation

修改：

- `tests/correctness/gateway/scheduler-timeout.test.ts`
- `tests/core/core-007-command-scheduler.test.ts`

新增：

- `tests/correctness/gateway/scheduler-cancellation.test.ts`

验证：

- queued cancellation。
- in-flight cancellation。
- 多 waiter。
- 单 waiter 取消。
- 最后 waiter 取消。
- Recovery stop。
- Explicit reconciliation 保留。
- PhysicalRequestBudget 释放。
- late result 防护。

## 11.5 Admission

新增：

- `tests/features/workbench/use-command-console.test.tsx`

修改：

- `tests/integration/fab-runtime.test.ts`
- `tests/integration/fab-runtime-batch23.test.ts`

验证：

- reserve。
- release。
- commit。
- 相同 idempotency key。
- 202 后注册。
- 429 后释放。
- HTTP 失败重试。
- 组件卸载。
- FAB 切换。
- SSE 先于 HTTP 响应。
- accepted registration 不发生二次 admission rejection。

## 11.6 Retention

修改：

- `tests/integration/fab-runtime-batch23.test.ts`
- `tests/contract/command-correlation.test.ts`

验证：

- TTL=0。
- TTL 正常到期。
- resolved count cap。
- correlation hard cap。
- 不存在 1ms timer loop。

## 11.7 Connection State

修改：

- `tests/realtime/realtime-transport.test.ts`
- `tests/integration/fab-runtime.test.ts`
- `tests/integration/runtime-bootstrap.test.tsx`
- `tests/support/command-fakes.ts`

验证：

- connecting。
- open。
- reconnecting。
- failed。
- reconnect open。
- permanent unavailable。
- Healthy / Degraded / Unavailable 转换。

## 11.8 后端 API

检查：

- `fab_tests/src/CommandRecoveryApiTests.cs`
- `fab_tests/src/CommandRetentionTests.cs`
- `fab_tests/src/CommandAdmissionTests.cs`

本轮不要求修改已经正确的 SQLite admission 实现。

必须验证：

- status=all 的完整集合。
- active/terminal 过滤正确。
- terminal prune 后不再返回过期记录。
- List 的 commands、epoch、latestSequence 属于同一个一致性快照。
- 并发提交不会破坏活动命令上限。
- HTTP 429 契约保持正确。

---

# 12. 架构文档同步

源码修改完成后必须同步：

| 文档                                                              | 修改内容                                        |
| --------------------------------------------------------------- | ------------------------------------------- |
| `docs/architecture/10-adr-command-cursor-ack-protocol.md`       | Atomic cover、ACK 安全语义                       |
| `docs/architecture/11-adr-cancellable-gateway-timeout.md`       | Scheduler waiter ownership                  |
| `docs/architecture/13-adr-resource-commit-identity-capacity.md` | Admission reservation、accepted registration |
| `docs/adr/0010-command-event-bridge.md`                         | Realtime rejection、observed/applied         |
| `docs/fab-runtime.md`                                           | Recovery 状态机、完整 List、resolved workflow      |
| `docs/command-event-bridge.md`                                  | Delivery outcome 与 ACK 契约                   |
| `docs/command-reconciliation.md`                                | not-found、List 收敛、expired-unresolved        |
| `docs/realtime-protocol.md`                                     | Transport availability 与 connection status  |
| `docs/state-management.md`                                      | Workflow projection 和 Recovery disposition  |
| `docs/IMPLEMENTATION-STATUS.md`                                 | Round 5 实际完成情况                              |
| `docs/architecture/README.md`                                   | 新增规范索引                                      |

新增本规范文件：

`docs/architecture/18-round5-remediation-specification.md`

不得将整改规范写成已经完成的实现记录。

---

# 13. 最终验收标准

本轮完成必须同时满足以下要求。

## 13.1 静态正确性

- 不存在 Cover 部分成功后错误推进游标。
- 不存在 observed 被当作 applied。
- 不存在 Actor rejection 无人处理。
- 不存在 List 缺失命令仍然保持 active。
- 不存在 HTTP 202 后本地拒绝注册。
- 不存在取消等待但底层请求继续执行。
- 不存在 TTL=0 的定时器循环。
- 不存在连接未 open 却报告 Healthy。

## 13.2 生命周期正确性

- 所有 Scope 有明确所有者。
- 所有 Fiber 有明确终止观察者。
- 所有 Scheduler 请求有明确 waiter 所有权。
- 所有 HTTP 请求可被真正中断。
- 所有 Reservation 都有终结状态。
- 所有 Workflow 都有明确的释放条件。
- 所有 resolved Workflow 都受到容量约束。

## 13.3 状态一致性

- Actor projection 不超前于权威 revision。
- acknowledged 不超前于安全前缀。
- Recovery watermark 与实际 cover 一致。
- 本地 active 集合与服务端权威 active 集合收敛。
- 终态未知的命令不会被伪造为成功或失败。
- 不同 FAB 的状态、容量、Recovery 和 Scheduler 完全隔离。

## 13.4 验证门禁

源码整改全部完成后，才执行：

1. TypeScript typecheck。
2. Oxlint。
3. Vitest 全量测试。
4. Vite production build。
5. .NET Release build。
6. .NET 全量测试。
7. 契约生成一致性检查。
8. Architecture checks。
9. `git diff --check`。
10. 完整生产验证脚本。

真实浏览器验证还必须覆盖：

- EventSource 首次连接。
- EventSource 断线与恢复。
- HTTP 与 SSE 事件乱序。
- Actor rejection 后权威恢复。
- 多 FAB 并发。
- 页面卸载与 Runtime stop。
- Recovery cancellation。
- 后端容量达到上限。
- 终态命令超过保留期限。

测试通过不代表源码自动正确。必须保留对上述不变量的逐项审查。

---

# 14. 执行顺序

严格按照以下顺序实施：

| 阶段   | 内容                           | 退出条件                  |
| ---- | ---------------------------- | --------------------- |
| R5-A | P1-01 Atomic ACK Cover       | Cover 与 Healthy 不变量成立 |
| R5-B | P1-02 Actor Rejection        | observed/applied 完全分离 |
| R5-C | P1-03 完整 List 对账             | 本地活动集合能够收敛            |
| R5-D | P1-04 Admission Reservation  | 202 后必定注册             |
| R5-E | P1-05 Scheduler Cancellation | 取消真正传递到底层请求           |
| R5-F | P2-01 Retention TTL          | TTL=0 不产生定时循环         |
| R5-G | P2-02 Connection State       | Healthy 与真实连接状态一致     |
| R5-H | 文档同步与最终源码复审                  | 全部不变量通过静态审查           |
| R5-I | 测试与生产验证                      | 验证门禁全部通过              |

阶段之间允许修改之前阶段的实现，但不允许为了通过后续测试而削弱已经建立的不变量。

---

# 15. 最终交付要求

完成 Round 5 后必须提交：

1. 所有生产源码修改。
2. 所有新增和修改的测试。
3. 更新后的 ADR 和架构文档。
4. 完整验证日志。
5. 逐项整改结果表。
6. 最新 Git commit SHA。
7. 干净工作区证明。

最终报告必须区分：

- 已经实现。
- 已经静态审查。
- 已经自动化测试。
- 已经真实浏览器验证。
- 尚未验证。

不能将某项源码已修改描述为该项已经通过最终验收。

**最终目标不是让现有测试全部通过，而是让 Command Runtime 的状态转换、事件确认、权威恢复、资源所有权和取消语义在理论与实现上保持一致。**

## 执行建议

这份规范中最重要的是 R5-A 至 R5-E。尤其是 P1-03 完整 List 对账和 P1-05 Scheduler 取消所有权，不应仅做局部补丁。

我建议下一步直接按照 R5-A → R5-I 实施，暂不增加其他功能或依赖。