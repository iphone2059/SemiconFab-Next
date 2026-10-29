# ADR-010：命令事件游标、确认与 Dirty 恢复协议（Round 2 · F1 冻结）

- 状态：Accepted（2026-10-30，第二轮整改 F1）
- 基线：`main@9ab2fd3f3cc5304f030dbf7f8e46a414ccd4ebda`（第二轮审查报告 CR-01/CR-02）
- 取代：ADR-007 §5 的单一 `observed` 游标与“一页 journal 即恢复”的实现描述
- 关联验收：矩阵 1/2/6；CR-01、CR-02、CR-06

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