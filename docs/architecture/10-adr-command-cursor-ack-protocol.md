# ADR-010：命令事件游标、确认与 Dirty 恢复协议（Round 2 · F1 冻结）

- 状态：Accepted（2026-10-30，第二轮整改 F1）
- 基线：`main@9ab2fd3f3cc5304f030dbf7f8e46a414ccd4ebda`（第二轮审查报告 CR-01/CR-02）
- 取代：ADR-007 §5 的单一 `observed` 游标与“一页 journal 即恢复”的实现描述
- 关联验收：矩阵 1/2/6；CR-01、CR-02、CR-06
- Round 5.1 修订（2026-10-30）：新增 §9「三游标与 Cover 语义」（P1-04：cover 永不修改 delivered）；规范与验收见 `19-round5.1-remediation-specification.md`。
- Round 5.2 修订（2026-10-30，独立复审 P1-01/P1-02/P1-03/P2-02）：修正 §9.2 的同 epoch 数学不变量（acknowledged 可在权威 Cover 下超过 delivered）；新增 §9.5「ACK 完整身份与权威 Supersede」；规范见 `20-round5.2-remediation-specification.md`。

## 1. 已证缺陷（本轮复现依据）

1. `realtime/command-event-source.transport.ts` 在 `onmessage` 中先 `observeCursor` 再 `commandResults.publish`；有界队列满时帧被丢弃，但 `state.cursor` 已前进，dirty 携带的是“已丢帧之后”的序号 → 恢复从错误位置开始，被丢弃事件永久缺失（CR-01）。
2. `api/http-command-gateway.ts` 的 journal 请求只发送 `afterSequence`，不发送/校验 `epoch`；`fab-runtime.ts` 只拉一页（limit 256），不迭代到 `latestSequence`，不校验页间 epoch/序号连续性（CR-02）。
3. `fab-runtime.ts` recovery pass 的 catch 静默、finally 无条件 `gapObserved=false`；恢复失败不会保留 Dirty，也没有重试/终态（CR-06）。

## 2. 游标模型（冻结）

```ts
/** 不透明恢复游标：epoch 必填，sequence 为“该 epoch 内已确认/已投递的最后序号”。 */
export interface CommandCursor {
  readonly epoch: string;
  readonly sequence: number;
}
```

Transport（`CommandEventSource` 实现）内部维护三个游标，职责不可混用：

| 游标 | 含义 | 更新时机 |
|---|---|---|
| observed | SSE 帧到达并解析成功后的最高序号 | `onmessage` 解析成功即更新（只用于诊断/去重） |
| delivered | 已成功进入有界队列、对消费者可见的最高序号 | `queue.publish` 返回成功后更新 |
| acknowledged | 消费者（FabRuntime/CommandEventBridge）已应用到权威 actor 的最高序号 | 消费者调用 `source.acknowledge(event)` 后更新 |

- `acknowledge(event)` 是 `CommandEventSource` 的必选能力（新契约）；没有 ack 的 event 不得推进 acknowledged。
- 溢出/丢弃时：禁止推进 delivered；dirty 必须携带 `delivered`（或 acknowledged，取更保守者）与 `gapStart`（本次丢弃的最小序号）与 `gapEnd`（最大序号，可缺省表示未知）。若无法确定缺口起点：`gapStart` 缺省，消费者必须走权威全量对账。
- 重连/重新打开连接：使用 acknowledged 游标（不是 observed）作为 `Last-Event-ID`/恢复起点。

```ts
export interface CommandStreamDirty {
  readonly reason: 'overflow' | 'slow-consumer' | 'stale-generation' | 'closed' | 'server-overflow' | 'store-fault';
  readonly droppedCount: number;
  readonly delivered?: CommandCursor;
  /** 本次丢失的最小序号（含）；undefined 表示缺口起点未知 → 权威全量对账。 */
  readonly gapStart?: number;
  /** 本次丢失的最大序号（含）；undefined 表示缺口终点未知。 */
  readonly gapEnd?: number;
}
```

## 3. Journal 分页与 epoch（冻结）

请求：`GET /api/v1/sites/{siteId}/fabs/{fabId}/command-journal?epoch=<uuid>&afterSequence=<int>=0&limit=<1..1000>`

- `epoch` 必填；缺失/非法 → 400 `journal-cursor-invalid`。
- epoch 与当前 store epoch 不一致 → **HTTP 409** `application/problem+json`：`{ code: "journal-epoch-mismatch", currentEpoch, firstRetainedSequence, latestSequence }`。前端必须转权威全量对账，不得“继续按序号猜”。
- 响应（在 ADR-008 DTO 基础上增补）：
  ```ts
  interface CommandJournalPage {
    epoch: string;
    hasGap: boolean;
    firstRetainedSequence: number;
    latestSequence: number;
    events: readonly CommandJournalEvent[]; // sequence 严格递增，且全部 > afterSequence
    /** 下一页起点（= events 最后一条 sequence；无事件时 = afterSequence）；由前端循环使用。 */
    nextAfterSequence: number;
  }
  ```
- 同一次恢复必须循环分页直到 `nextAfterSequence >= latestSequence`（或收到 hasGap/epoch 错误）；每页都校验 epoch 与本批首页一致、序号严格递增、无空洞（空洞 = 无法解释的缺号 → 视为 gap）。
- 跨 FAB：页内事件按 `fabId` 过滤，但游标/epoch 是 site 级；不得因过滤造成的“空页”判定恢复完成，必须以 sequence 水位判定。

## 4. 恢复状态机（冻结）

```text
Healthy --dirty|gap|reconnect|transport-failure--> Dirty
Dirty --开始恢复--> Recovering
Recovering --journal 全量水位到达 或 authoritative-list 应用完成--> Healthy
Recovering --可重试失败(网络/5xx/subscribe 中断)--> WaitingRetry --退避到期--> Recovering
Recovering --不可恢复(epoch 无法替换? 持续 N 次失败/存储故障/scope closed)--> Unrecoverable
```

- 清除 Dirty 的唯一条件：journal 循环到达权威 `latestSequence`，或 authoritative list 快照应用完成且其 `latestSequence` 已作为新基线记录。仅“收到一次 SSE 事件”不清除 Dirty。
- 失败重试：有界指数退避（500ms → 1s → 2s → 4s → 8s → 最大 15s），最多 8 次；期间保持 Dirty，UI 可通过只读诊断观察到 `dirty/recovering/waiting-retry/unrecoverable` + last error。
- 恢复请求也受 FAB 级物理请求预算约束（与调度器共享 4 个 HTTP 槽位，见 ADR-011）。
- 恢复过程中的 SSE 事件仍按 revision 去重；恢复完成后再执行一次统一调度器对账（tracked active commands），避免“恢复了事件但 actor 未收敛”。

## 5. 测试要求（RED→GREEN）

1. 真实 SSE capacity=4，注入 100+ 帧（含终态/非终态混合、乱序、重复），消费慢于生产；断言：每个命令最终状态与后端一致，dirty 的 `delivered/gapStart` 精确覆盖被丢弃帧，acknowledged 游标不回退。
2. Journal 1/256/257/1000 条多页；epoch 替换 → 409 → 权威 list；跨 FAB 稀疏序号；断页/重复页/空洞；断言不跳页、不重复应用、无静默 gap。
3. 恢复端点 5xx 断续 5 次期间 Dirty 不清；恢复后自动补偿；没有新 SSE 事件时也能恢复（仅 dirty/reconnect 触发）。
4. 红转绿：在修复前用 fake transport + 可控队列写 RED 测试并保存输出。

## 6. Round 3 静态整改修订（2026-10-30）

状态：源码确认级冻结；验证留待 Round 3 验证阶段。修订以下契约（与本文前文的兼容冲突处，以本节为准）：

### 6.1 Retention 下界与 Journal 缺口（R3-01）

- 后端 hasGap 必须同时覆盖三个条件：`afterSequence < firstRetainedSequence - 1`（起点早于保留窗口）、`afterSequence > latestSequence`、以及实际扫描空洞；全部使用 long。`firstRetained=1/latest=0/after=0` 是合法空站点，不是 gap。
- `nextAfterSequence` 语义固定为“服务端已扫描覆盖的 Site 区间结束位置”，不得越过本 FAB 尚未返回的记录；无法保证时应改分页算法或返回不透明 continuation token。
- 前端不得仅凭 `page.hasGap=false` 或空页进入 Healthy；必须独立校验 `cursor.sequence >= firstRetainedSequence - 1`、`firstRetained <= latest + 1`、`nextAfterSequence <= latest`、页内水位自洽；不自洽即 RecoveryNeedsAuthority → 权威 List。
- 首次权威 List 不包含已过保留窗口的终态记录时，前端只能宣告“保留了当前保留窗口内可权威恢复的命令”，禁止宣称历史全部可恢复。

### 6.2 有序 ACK Ledger（R3-02）

- transport 维护有序 delivered ledger（pending/applied/covered）。只有从 ledger 头部开始连续为 applied|covered 的条目才能出队并推进 `acknowledged`；不得用 max(sequence) 越过仍 pending 的早期事件。
- `covered` 只能来自权威 Journal/List 应用结果；EventSource 后续消息不能证明更早事件已覆盖。
- Ledger 有界：容量耗尽、命令长时间未建 actor、epoch 不一致 → Dirty + 权威恢复；禁止驱逐最旧 pending 后继续前进。
- 重连恢复起点 = 最后安全 ACK 前缀；无安全前缀 → List Recovery。权威恢复完成必须显式 cover/同步 transport safe watermark；旧 ledger 不得回滚新游标。
- observed / actor-applied / safe-ACK 三态分离；bridge 仅在 actor 应用成功后对 transport 确认。

### 6.3 稀疏 Site 序号（R3-03）

- 页内事件按 Site 全局 sequence 严格递增；FAB 过滤后允许稀疏。前端仅校验严格递增 + epoch 等同 + cursor 边界 + nextAfterSequence 前进；禁止用相邻差值断言 Site journal 丢行。
- foreign FAB event、non-monotonic event、event.sequence > nextAfterSequence、epoch 不一致 → RecoveryNeedsAuthority（不得静默）。
- 未达 latest 时 nextAfterSequence 必须严格大于当前 cursor；同 epoch 的 server watermark 不得无原因回退。

### 6.4 协议错误 Dirty 与 sticky 恢复（R3-04）

- 带 id 的命令帧解码失败 → dirty(decode-error, delivered=安全前缀)，不 ACK；无法证明 id/topic → listOnly（无 gapStart）→ List。
- server dirty control 解析失败 → dirty(invalid-control-frame|decode-error) 安全降级；专用命令流未知 topic 属于协议错误。
- 控制信号通道可能被新的 dirty 覆盖，运行时必须保留 sticky dirty 直到权威恢复水位签收；诊断有界且不含敏感 payload。

### 6.5 Recovery Scope 与所有者（R3-05/R3-07/R3-08）

- 恢复任务必须 fork 在 FabScope 的子 RecoveryScope 中，持有 generation 与 fiber handle；dispose 中断全部恢复 fiber，cleanup 完成后不得再有回调；stop 语义显式。
- Journal/List 请求统一 Effect timeout（约 10s）并把中断信号传到 fetch；与 scheduler 共享 FAB 物理预算；permit 释放在请求实际完成/abort 后。
- 旧 generation 的恢复结果不得写 projectionStore、改变 recovery phase 或触发对账。
- 需要命令恢复的 FabRuntime 的 gateway 改为必填；缺失时 composition root 明确失败。无权威水位时不得进入 Healthy：进入 Unrecoverable/Unavailable 并提供可观察诊断。仅展示用 Runtime 必须显式标记不可用。
- 恢复 drop 覆盖：按 recoveryGeneration + 快照水位 + drop generation 区分“已被本轮权威快照覆盖”（记录覆盖、不重试）与“快照后发生的新 drop”（recoveryPending/needsNextAuthoritativePass，禁止直接 return 后 Healthy）。补偿有界退避与进展证明，超限进入 WaitingRetry/Unrecoverable；scheduler 队列溢出不得循环同一批 128 命令，按优先级分批并以权威快照覆盖收敛。

### 6.6 终态与刷新恢复语义（R3-11：决策 A）

- 浏览器刷新/断线恢复仅保证 **当前活动（active）命令** 的权威对齐；**终态历史不保证跨刷新恢复**。
- 终态/历史展示由独立历史资源（runs/results 或后续 command history 端点）读取，不得依赖命令 SSE 维护的投影在刷新后仍存在。
- UI 与文档必须使用“活动命令恢复”表述；恢复诊断暴露 recoveryState。若未来产品要求保留窗口内终态也恢复，则必须走决策 B（List all 分页 + revision 快照 + 有界 actor scope），不得把 active-only 宣称为全量恢复。

### 6.7 验证推迟

以上修订在静态阶段只做源码/契约/文档同步；Round 3 验证阶段需覆盖：全空 Journal 保留窗口、ACK 前缀交错、稀疏跨 FAB 分页、坏帧 Dirty、RecoveryScope 取消/超时、gateway 缺失、drop 覆盖、终态语义 E2E。

## 7. Round 4 修订（2026-10-30，R4-01…R4-06）

状态：源码整改完成；Round 4 源码记录见 `17-round4-remediation-record.md`；浏览器/GPU/真实 HTTP 验证边界见该文档 §5。

### 7.1 统一 untrusted-gap ACK 安全锁（R4-01）

- 所有丢失/不可证明路径（consumer queue overflow、无 id 帧、解码/未知 topic、epoch 不一致、非单调序号、server dirty、replay-gap、onerror、connect timeout、factory throw、stale generation）统一调用 `markUntrustedGap`，设置粘性 `ackBlockedUntilCover`。
- 记录 `untrackedHighWater: {epoch,sequence}`（id 行可证明）与 `untrustedUnknownGap`（无法证明/跨 epoch）；latch 期间到达的帧不进入 ledger，但持续抬高高水位（防止 cover(200) 释放后 ACK 越过 201）。
- `cover(cursor, authority)`：已知位置要求同 epoch 且 `cursor.sequence >= highWater.sequence`；未知/跨 epoch 位置要求 `authority === 'list'`。cover 不足时保留 latch、发布 `uncovered-gap`（无 gapStart）并触发下一轮权威 List；cover 足够时清除 latch 并排空可证明的 applied|covered 前缀。pending 条目永不驱逐。
- 契约新增：`CommandCoverAuthority = 'journal' | 'list'`；`cover(cursor, authority?)`；dirty reason `uncovered-gap` / `transport-unavailable`。

### 7.2 Scheduler 逐命令结果与恢复时序（R4-02）

- `schedule()/scheduleMany()` 返回 `ReconciliationResult`（succeeded/already-terminal/not-found/failed/timed-out/cancelled/dropped + payload-free error），不再只返回成功数量。
- Recovery pass 在 snapshot 应用后仍保持 Dirty/attempts，只有在 post-snapshot batch 全部收敛后才 `source.cover(watermark, kind)`、重置 attempts/active request、进入 Healthy（transport 不可用时 Degraded）。batch 失败（failed/timed-out/cancelled、无 drop intent 的 dropped）使 pass 失败并进入有界退避；`trackCommand` 的 fire-and-forget 调度失败同样进入 Dirty。
- `appliedRecords` 只统计 bridge 权威应用结果（Applied/Covered）。

### 7.3 observed / applied / covered 分离（R4-03）

- Correlation 同时维护 observed 与 applied revision；`markApplied` 仅在 actor projection 证明前进后调用。
- `receiveAuthoritative(event, coveredRevision?)` 跳过 SSE observed-revision 去重门槛重新投递 actor；不可验证 workflow 仅在 coveredRevision 覆盖时视为 applied。
- `flushRecovery() → {applied,held,rejected}`：只移除 Applied/Covered；rejected 重新入队并转为 Dirty。

### 7.4 Replay-Gap 不可信游标（R4-04）

- replay-gap 控制帧没有 `id:` 行，`event.lastEventId` 会继承上一数据帧（可能旧 epoch）。解析器只接受 payload epoch，`requestedLastEventId` 仅作诊断，**永不产生 sequence**；malformed 帧产生空 gap + 有界诊断。
- FabRuntime 对每个 replay-gap 强制 `listOnly: true`，不得用继承 id 或 payload epoch+观测 sequence 组合做 Journal 恢复。

### 7.5 Stream Fiber 监督（R4-05）

- `runCommandStream` 提供 `{label,onDefect,onExit}` observer；handler 异常转为有界诊断，fiber 终止可被 owner 观察。
- Bridge 意外退出先重置 started/owner 再回调；FabRuntime 对 bridge 与全部 signal fiber 执行 ≤3 次有界重启并触发权威恢复，超限进入 Unrecoverable；禁止“fiber 已死但 running=true”。

### 7.6 Recovery authority 与 Realtime availability 分离（R4-06）

- `recoveryAvailable = gateway !== undefined && source.availability === 'ready'`；新增 phase `Degraded` 与 `recoveryState.realtimeAvailability`。无实时 transport 时 HTTP 状态可收敛，但总体状态不得 Healthy。
- 无 EventSource 的 composition root 只装配 display-only runtime；PROD 缺失 transport fail-fast。transport `availability` 为 getter：factory 缺失永久 unavailable；factory throw/connect timeout 有界重试耗尽后永久 unavailable，不再无限重连。


## 8. Round 5 修订（已实施，2026-10-30）

Round 5 源码整改已提交 `4c8f0c1`：cover 在修改游标或 ledger 前检查权威、epoch、高水位及快照开始时的丢失代次；不足时保持原状态并要求 List。Round 5 规范见 `18-round5-remediation-specification.md`。

## 9. Round 5.1 修订：三游标与 Cover 语义（2026-10-30）

状态：契约/源码整改（Round 5.1）；规范见 `19-round5.1-remediation-specification.md` §2.4 与 §6。本节优先于本文前文对 cover 的任何旧描述。

### 9.1 Cover 的唯一合法副作用

`cover(cursor: CommandCursor, authority?: CommandCoverAuthority, lossBarrier?: number): CommandCoverResult` 只允许：

1. 把有序 ACK ledger 中 `epoch` 相同且 `sequence <= cursor.sequence` 的条目标记为 `covered`；权威 epoch 替换时清空/替换旧 ledger（旧 epoch 的位置不可比较）。
2. 推进 `acknowledged`（安全前缀）：同 epoch 只增不减；权威 List 可以替换 epoch 身份。
3. 设置 `ledgerEpoch = cursor.epoch`。
4. 在证明覆盖所有 untracked 位置后释放 ACK latch（R4-01 规则不变：已知位置要求同 epoch 且 `cursor.sequence >= untrackedHighWater`；未知/跨 epoch 位置要求 `authority === 'list'`）。
5. 返回 `{ status: 'covered', ... }`；覆盖不足时返回 `{ status: 'insufficient', ... }`，且不改变任何游标/ledger/loss 状态。

**禁止**：`cover` 修改 `delivered`。`delivered` 的唯一含义是“已成功 publish 到有界消费者”，只能由真实 SSE 帧的成功投递推进；权威水位不能证明任何帧被投递过。P1-04 之前 transport 中“cover 时用 cover 游标推进 delivered”的实现已被删除，不得以任何形式恢复。

### 9.2 同 epoch 不变量（Round 5.2 修正，review P2-02）

Round 5.1 写下的 `acknowledged <= delivered <= observed` **不是完整协议的不变量**：权威 List/Journal Cover 可以把 `acknowledged`（安全确认位置）推进到从未实际投递给消费者的位置，因此合法出现 `observed=9 / delivered=3 / acknowledged=9`。正确的条件化表达：

- 始终成立：`delivered.sequence <= observed.sequence`；每个游标在同一 epoch 内单调不减。
- **没有权威 Cover 超前推进时**：`acknowledged.sequence <= delivered.sequence <= observed.sequence`。
- **存在经过证明的权威 Cover 时**：`acknowledged` 可以由“连续 applied|covered ledger 前缀”或“权威 Cover”推进；不要求 `acknowledged <= delivered`（超过 delivered 合法），但 `delivered` 仍只能由真实 SSE 投递推进。
- 不同 epoch 的 sequence 不可直接比较（见 §9.3）。

- `observed`：解析到有效 SSE `id:` 后更新（只用于诊断/去重）。
- `delivered`：`commandResults.publish` 成功（帧进入有界消费者队列）后更新。
- `acknowledged`：有序 ledger 头部连续 `applied|covered` 前缀出队后推进；或由 `cover` 推进。
- `pendingAcknowledgements`：已投递但仍在 ledger 中 pending 的条目数；契约上为必填 `number`，不是可选字段（缺失不得当作 0）。

### 9.3 跨 epoch 语义

- epoch 不同的位置**只按 epoch 身份判断**，禁止用 sequence 大小比较新旧。
- 权威 List cover 用新 epoch 替换 `acknowledged`/epoch 身份（并可以替换 `ledgerEpoch`、清空旧 ledger）。
- `delivered` 跨 epoch 时**不跟随 cover**：它保留旧 epoch 的位置，直到新 epoch 的真实 SSE 帧被成功投递后，才跳到那个实际投递的 sequence。
- 因此不能把跨 epoch cover 当作“新 epoch 的某个位置已投递”；恢复起点只来自 `acknowledged`（或 list-only）。

### 9.4 失败路径与测试要求

- `insufficient` cover：保留 latch、发布 `uncovered-gap`（无 gapStart）并触发下一轮权威 List；游标/ledger/loss 状态不变。
- 测试矩阵（`web_app/tests/correctness/sse/matrix-1-three-cursor.test.ts`、`web_app/tests/correctness/sse/matrix-1-ordered-ack-ledger.test.ts`、`web_app/tests/realtime/realtime-transport.test.ts`）：
  - observed 25 / delivered 10 / acknowledged 8，List cover `epoch-1:20` → delivered 仍为 10、acknowledged 20；
  - delivered `epoch-A:10`，List cover `epoch-B:20` → delivered 仍为 `epoch-A:10`，acknowledged `epoch-B:20`；
  - cover 成功但 watermark 之后仍有 delivered-pending 条目 → 该条目保持 pending，acknowledged 不越过它；
  - insufficient cover 不改变任何游标/ledger；
  - Cover 使 `acknowledged > delivered`（同 epoch 与跨 epoch）是合法且必须被测试覆盖的路径（Round 5.2 修正后，不再作为不变量破坏）。

### 9.5 Round 5.2 修订：ACK 完整身份与权威 Supersede（review P1-03）

有序 ACK ledger 的事件身份是完整业务身份：

```text
(fabId, commandId, revision, outcome)
```

- `acknowledge(event)` 只有在 ledger 中存在同 (fabId, commandId, revision, outcome) 的 pending 条目时才标记 `applied`；仅 revision 相同的不同 outcome 事件不得互相确认。
- 权威结果（List/Journal 记录或权威状态查询）纠正/确认某 command revision 后，调用 `source.supersede(event)`：同 `(fabId, commandId, revision)` 的 delivered-pending 条目标记为 `covered`（**绝不 applied**），随后按连续前缀推进 `acknowledged`。这是权威纠正的显式覆盖语义，不能用 `acknowledge` 冒充 SSE 应用。
- 旧 revision 的重放只有在 correlation 的有界 outcome 历史能证明“该 revision 确实对应此 outcome”时才可标记 `stale`（可 ACK）；证明不了必须为 `stale-unverified`：不 ACK、不当作重复事件忽略，转入权威恢复。
