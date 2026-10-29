# 第二轮整改 F4：可取消 Gateway、真实超时与 FAB 物理预算（CR-04 / CR-08 overflow）

- 任务：task-8（owner: cancellation-owner）
- 契约：ADR-011（`docs/architecture/11-adr-cancellable-gateway-timeout.md`）、ADR-010 §3/§4；验收矩阵 4（`14-round2-remediation-matrix.md`）
- 基线工作树：`main@b0c3e09`（F1 契约冻结）+ 第二轮并行整改工作树（未提交；本轮禁止 git 写操作）
- 状态：F4 交付物完成，矩阵 4 单元/集成证据 **GREEN**；最终采集时全仓 `pnpm typecheck` **0 错误**、`pnpm lint` exit 0、F4 6 文件 43 测试全绿。

## 1. 交付文件（本 owner write scope）

| 文件 | 变更 |
|---|---|
| `web_app/src/contracts/command-gateway.contract.ts` | 三方法改为原生 `Effect`；冻结 `CommandGatewayError` 判别式联合；`CommandJournalQuery` epoch+afterSequence 必填；`CommandJournalPage.nextAfterSequence` |
| `web_app/src/api/http.transport.ts` | `Effect.tryPromise((signal) => fetch(..., { signal }))` 中断传播（既有）+ AbortError→`RequestAborted`、ProblemDetails body 透传（供 409 结构化映射） |
| `web_app/src/api/http-command-gateway.ts` | 纯 Effect（无内部 runPromise/runPromise 注入）；ApiError→CommandGatewayError 映射；journal 409 body 经 F3 `decodeJournalEpochMismatch` schema 解码→`CommandJournalEpochMismatch`；nextAfterSequence 透传 |
| `web_app/src/runtime/command-reconciler.ts` | `reconcile` 返回 `Effect<boolean, CommandGatewayError>`；应用结果前校验 workflow 身份 + 调度 entry generation |
| `web_app/src/runtime/fab-reconciliation-scheduler.ts` | `Effect.timeoutOption` 包裹真实 reconcile Effect；共享 `PhysicalRequestBudget`（Semaphore(4)）；stats 增 `physicallyInFlight`；删除 4096 条 overflow retry 二级缓冲，队列满仅 `onDrop` |
| `web_app/tests/correctness/gateway/**` | RED→GREEN 矩阵 4 测试（6 文件 43 测试） |
| `web_app/tests/api/command-http.test.ts`、`effect-http.test.ts` | 适配 native Effect 契约与新的错误代数 |
| `web_app/tests/contract/command-recovery.test.ts` | 适配 command-owner 新增的显式 Effect 执行边界参数 |
| `web_app/tests/types/effect-api-types.ts` | 类型边界断言从 Promise 形状改为 native Effect 形状（该文件断言本契约；原断言已失效，已同步） |

## 2. 冻结接口（已 send_message 通知 command-owner / lead）

```ts
// contracts/command-gateway.contract.ts
export interface CommandGateway {
  getCommandStatus(fabId: string, commandId: string): Effect.Effect<CommandResultEvent | null, CommandGatewayError>;
  listFabCommands(siteId: string, fabId: string, filter: CommandRecoveryFilter): Effect.Effect<CommandRecoveryList, CommandGatewayError>;
  getCommandJournalPage(siteId: string, fabId: string, query: CommandJournalQuery): Effect.Effect<CommandJournalPage, CommandGatewayError>;
}
export interface CommandJournalQuery { readonly epoch: string; readonly afterSequence: number; readonly limit?: number; }
// CommandJournalPage 新增 nextAfterSequence: number
export type CommandGatewayError =
  | CommandRequestAborted                                             // 取消，不算业务失败
  | CommandJournalEpochMismatch                                       // 409 journal-epoch-mismatch → 权威 list 兜底
  | CommandGatewayRetryableFailure                                    // 网络/5xx/429 → 保持 Dirty + 退避
  | CommandGatewayTerminalFailure;                                    // invalid-response|identity-mismatch|rejected|invalid-request|store-fault
```

```ts
// fab-reconciliation-scheduler.ts（FAB 唯一实例，由 FabRuntime 创建并同时传给 recovery 请求）
export interface PhysicalRequestBudget {
  readonly capacity: number;
  readonly inFlight: number;   // 全部入口的物理在途计数
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
export function createPhysicalRequestBudget(capacity?: number): PhysicalRequestBudget; // 默认 4
export interface FabReconciliationSchedulerStats {
  scheduled; queued; inFlight; physicallyInFlight; completed; failed; timedOut; dropped; cancelled;
}
// onDrop（队列容量丢弃；不再内部重试，FabRuntime 置 Dirty + 权威 list 恢复）
onDrop?: (diagnostic: { reason: 'queue-capacity'; commandId: string; droppedTotal: number; queued: number; inFlight: number }) => void;
```

```ts
// command-reconciler.ts
reconcile(workflow, fabId, commandId, request: {
  entryId: number;
  isCurrent: (identity: { fabId: string; commandId: string; entryId: number }) => boolean;
}): Effect.Effect<boolean, CommandGatewayError>
```

## 3. RED 证据（修复前旧实现）

先写 `web_app/tests/correctness/gateway/red-baseline.test.ts` 对旧契约（scheduler gateway 返回 Promise；`timeoutOption(Effect.promise(...))`）执行，原始输出：

```text
[exit 1]
Frozen asset contracts PASS

 RUN  v5.0.5 C:/Users/han_qingyu/SemiconFab-Next/web_app

stderr | tests/correctness/gateway/red-baseline.test.ts > RED: timeout leaves the physical authoritative request in flight (no cancellation reaches fetch)
[RED counters] timedOut= 1 physicalPending= 1 aborts= 0

stderr | tests/correctness/gateway/red-baseline.test.ts > RED: a late authoritative result after timeout is still applied to the actor
[RED counters] receivedAfterTimeout= 1

stderr | tests/correctness/gateway/red-baseline.test.ts > RED: gateway contract is not a native cancellable Effect
[RED counters] Effect.isEffect(gateway.getCommandStatus(...))= false

 ❯ tests/correctness/gateway/red-baseline.test.ts (3 tests | 3 failed) 282ms
   × RED: timeout leaves the physical authoritative request in flight (no cancellation reaches fetch) 135ms
   × RED: a late authoritative result after timeout is still applied to the actor 145ms
   × RED: gateway contract is not a native cancellable Effect 1ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/correctness/gateway/red-baseline.test.ts > RED: timeout leaves the physical authoritative request in flight (no cancellation reaches fetch)
AssertionError: physical request must not stay in flight after timeout: expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ tests/correctness/gateway/red-baseline.test.ts:90:91
     88|   expect(scheduler.stats.timedOut).toBe(1);
     89|   // The fix must abort the signal and end the physical request:
     90|   expect(physicalPending.value, 'physical request must not stay in fli…
       |                                                                                           ^
     91|   expect(aborts.value, 'timeout must abort the fetch signal').toBeGrea…
     92|   scheduler.dispose();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯

 FAIL  tests/correctness/gateway/red-baseline.test.ts > RED: a late authoritative result after timeout is still applied to the actor
AssertionError: a result that resolves after the timeout must not write the actor: expected [ { fabId: 'fab-a', …(4) } ] to deeply equal []

- Expected
+ Received

- []
+ [
+   {
+     "commandId": "cmd-1",
+     "fabId": "fab-a",
+     "occurredAt": "2026-10-30T00:00:00.000Z",
+     "outcome": "executing",
+     "revision": 5,
+   },
+ ]

 ❯ tests/correctness/gateway/red-baseline.test.ts:110:98
    108|   await sleep(50);
    109|   console.error('[RED counters] receivedAfterTimeout=', workflow.recei…
    110|   expect(workflow.received, 'a result that resolves after the timeout …
       |                                                                                                  ^
    111|   scheduler.dispose();
    112| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯

 FAIL  tests/correctness/gateway/red-baseline.test.ts > RED: gateway contract is not a native cancellable Effect
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ tests/correctness/gateway/red-baseline.test.ts:122:35
    120|   const result: unknown = gateway.getCommandStatus('fab-a', 'cmd-1');
    121|   console.error('[RED counters] Effect.isEffect(gateway.getCommandStat…
    122|   expect(Effect.isEffect(result)).toBe(true);
       |                                   ^
    123|   await Promise.resolve(result as Promise<unknown>).catch(() => undefi…
    124| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯


 Test Files  1 failed (1)
      Tests  3 failed (3)
   Start at  07:03:41
   Duration  657ms (tests 53%, import 41%, transform 5%, worker 1%)

[ELIFECYCLE] Test failed. See above for more details.

```

关键计数（RED）：`timedOut=1` 时 `physicalPending=1`、`aborts=0`（超时未取消物理请求）；超时后旧请求 resolve 仍写入 actor（`receivedAfterTimeout=1`）；`Effect.isEffect(gateway.getCommandStatus(...))=false`。

RED 基线测试在 GREEN 落地后删除（旧 API 已不存在）；其核心断言：

```ts
expect(scheduler.stats.timedOut).toBe(1);
expect(physicalPending.value, 'physical request must not stay in flight after timeout').toBe(0); // RED: 1
expect(aborts.value, 'timeout must abort the fetch signal').toBeGreaterThan(0);                  // RED: 0
expect(workflow.received, 'a result that resolves after the timeout must not write the actor').toEqual([]); // RED: 1 条
expect(Effect.isEffect(gateway.getCommandStatus('fab-a', 'cmd-1'))).toBe(true);                  // RED: false
```

## 4. GREEN 证据（修复后）

命令：

```powershell
cd web_app
pnpm test -- tests/correctness/gateway tests/api/command-http.test.ts tests/api/effect-http.test.ts
```

原始输出（含 F4 计数，F3 schema 对齐后的最终结果 43 测试）：

```text
$ node ../tools/check_frozen_assets.mjs
Frozen asset contracts PASS
$ vitest run tests/correctness/gateway tests/api/command-http.test.ts tests/api/effect-http.test.ts

 RUN  v5.0.5 C:/Users/han_qingyu/SemiconFab-Next/web_app

stderr | tests/correctness/gateway/scheduler-timeout.test.ts > timeout aborts the physical fetch, clears physical pending and releases the shared permit
[F4 counters] timeout -> signalAborts=1 physicalPending=0 budgetInFlight=0 timedOut=1

 ✓ tests/api/command-http.test.ts (7 tests) 59ms
 ✓ tests/api/effect-http.test.ts (10 tests) 60ms
 ✓ tests/correctness/gateway/gateway-effect.test.ts (16 tests) 100ms
stderr | tests/correctness/gateway/scheduler-timeout.test.ts > a late authoritative result resolving after the timeout never writes the actor
[F4 counters] lateResolve -> receivedAfterTimeout=0 signalAborts=1 budgetInFlight=0

stderr | tests/correctness/gateway/scheduler-timeout.test.ts > dispose aborts every in-flight physical request, leaks no permit and produces no unhandled rejection
[F4 counters] dispose -> aborted=3 physicalPending=0 cancelled=3 budgetInFlight=0

 ✓ tests/correctness/gateway/stale-result.test.ts (4 tests) 151ms
stderr | tests/correctness/gateway/physical-budget.test.ts > 8+ mixed-entry reconciliations share the budget with recovery requests: physical peak <= 4
[F4 counters] sharedBudget -> physicalPeak=4 physicalStarts=10 recoveryOverlap=true completed=10 budgetInFlight=0

stderr | tests/correctness/gateway/physical-budget.test.ts > queue capacity drops are reported through onDrop with no hidden retry buffer (CR-08)
[F4 counters] overflowDrop -> dropped=4 physicalStarts=1 queued=1

 ✓ tests/correctness/gateway/scheduler-timeout.test.ts (3 tests) 197ms
 ✓ tests/correctness/gateway/physical-budget.test.ts (3 tests) 240ms

 Test Files  6 passed (6)
      Tests  43 passed (43)
   Start at  07:16:06
   Duration  918ms (import 73%, tests 23%, transform 3%, worker 2%)
```

关键计数（GREEN，均来自 fetch 层/共享预算实测）：

| 指标 | 值 | 出处 |
|---|---|---|
| timeout 后 signalAborts | 1 | scheduler-timeout.test.ts |
| timeout 后 physicalPending / budgetInFlight | 0 / 0 | scheduler-timeout.test.ts |
| timeout 后旧 resolve 写入 actor 次数 | 0 | scheduler-timeout.test.ts |
| 8+ 混合入口 + 2 个 recovery 请求物理峰值 | 4（physicalStarts=10，recoveryOverlap=true） | physical-budget.test.ts |
| dispose 时 aborts / cancelled / 残留 budgetInFlight | 3 / 3 / 0，无 unhandledRejection | scheduler-timeout.test.ts |
| overflow 丢弃 / 隐藏重试请求数 | dropped=4、physicalStarts=1（无二级缓冲重试） | physical-budget.test.ts |
| journal 409 → CommandJournalEpochMismatch | 通过（含 currentEpoch/firstRetainedSequence/latestSequence） | gateway-effect.test.ts |
| journal 400 cursor-invalid → Terminal(invalid-request) | 通过（不按序号重试） | gateway-effect.test.ts |
| 空页 nextAfterSequence 透传（恢复循环终止输入） | nextAfterSequence=latestSequence 原样返回 | gateway-effect.test.ts |
| 测试总数 | 6 文件 / 43 测试全绿 | 原始输出 |

## 5. 矩阵 4 验收映射

| 矩阵 4 要求 | 断言/证据 | 结果 |
|---|---|---|
| 永不 resolve fetch 在 timeout/dispose 后收到 abort | `signalAborts=1`、`aborted=3`（dispose）；fake fetch AbortSignal listener | PASS |
| timeout 后物理 pending=0、permit 恢复 | `physicalPending=0`、`budgetInFlight=0`，随后同预算下一命令立即完成 | PASS |
| 超时后的旧结果不得写 actor | 非协作 transport 超时后 resolve：`receivedAfterTimeout=0`；reconciler generation guard；target.isCurrent 失效测试 | PASS |
| 8+ 混合入口物理在途 ≤4（fetch 层计数） | peak=4、10 个混合入口 + 2 个共享预算 recovery 请求，`overlap=true` | PASS |
| 不泄漏 permit / 无未处理 rejection | dispose 后 cancelled=3、inFlight=0；unhandledRejection 监听为空 | PASS |
| 队列 overflow 不再靠二级缓冲 | onDrop 4 次、droppedTotal 单调、physicalStarts=1；FabRuntime 侧 Dirty+权威 list 由 command-owner 集成 | PASS（调度器侧） |
| journal epoch 409 映射 | 顶层 problem+json → `CommandJournalEpochMismatch`；POST 幂等冲突/其它 409→Terminal(`rejected`)；400 cursor-invalid→Terminal(`invalid-request`) | PASS |
| gateway 原生可取消（无内部 runPromise） | 三方法 `Effect.isEffect=true`；`Effect.timeoutOption` 中断→fetch AbortSignal aborted | PASS |

## 6. 实现要点

1. **取消链**：scheduler `Effect.timeoutOption(physicalBudget.withPermit(reconciler.reconcileEffect), timeout)` → 超时/Scope 关闭中断 fiber → `Effect.tryPromise` 的 AbortSignal abort → 真实 fetch 收到 abort → 物理 pending 递减；`withPermit` 的 `ensuring` 释放 Semaphore(4) permit；scheduler 逻辑 permit 的 `ensuring` 结算 waiter 且从不泄漏。
2. **旧结果守卫**：`CommandReconciler.reconcile` 在 `workflow.receive` 之前校验 `request.isCurrent({fabId,commandId,entryId})`；scheduler 的实现同时校验 entryId、inFlight entry 身份、disposed 与 workflow `target.isCurrent()`。因此即使底层请求不协作（超时后才 resolve），写入路径也被拒绝。
3. **共享物理预算**：`createPhysicalRequestBudget(4)` 由 FabRuntime 每个 FAB 构造一次，scheduler 构造参数 `physicalBudget` 必填；recovery journal/list 请求用同一对象 `withPermit`，因此峰值为全 FAB 口径而非每子系统口径。stats.physicallyInFlight 直接读取 budget.inFlight。
4. **overflow**：删除 `MAX_OVERFLOW_RETRIES=4096` 与 `overflowRetry` 列表/refill 逻辑；队列满时丢弃最旧非终态排队项、settle(false) 并调用 onDrop（含 droppedTotal/queued/inFlight），丢弃意图由 FabRuntime 进入 Dirty + 权威 list 恢复承担（ADR-010 §4）。
5. **错误分类**：`{_tag} CommandRequestAborted | CommandJournalEpochMismatch | CommandGatewayRetryableFailure | CommandGatewayTerminalFailure(reason)`，取消不计入 failed；5xx/429 可重试；400（含 F3 `journal-cursor-invalid`）→ Terminal(`invalid-request`)，其余 4xx→Terminal(`rejected`)，坏 payload/身份不符/显式 store-fault 终止；journal 409 epoch mismatch 单独结构化（不按序号重试）。

## 7. 限制与未验证（诚实记录）

1. **typecheck**：最终采集时全仓 `pnpm typecheck` **0 错误**（证据采集中期曾因并行 owner 正在改 `tests/core/core-010`、`tests/realtime/realtime-transport`、`tests/rendering/lite-backend-recovery` 短暂报错，均已由其 owner 修复合入；本 owner 文件全程零错误零改动）。`pnpm lint`（oxlint src，209 files）exit 0。
2. **真实网络未参与**：物理在途/abort 计数来自注入 fake fetch 层（确定性、可观测），不是真实浏览器网络；真实 Chrome/生产 bundle 的取消链属 F7/浏览器门禁，本任务未跑 `scripts/verify.ps1`/e2e。
3. **时钟**：GREEN 使用真实定时器（timeout 20–25ms、Windows 环境），未使用 TestClock；高负载 CI 上这 6 个文件均断言最终状态而非精确时序（waitFor 轮询），但极端抖动仍可能导致阈值敏感。RED 输出为本机当时原始输出。
4. **F3 后端契约（已与 backend-owner 逐条对齐，F7 联调待跑）**：backend-owner 确认：
   - `epoch` 必填且随请求发送；缺失/非法 epoch → 400 `journal-cursor-invalid`（客户端映射 Terminal(`invalid-request`)，不按序号重试）；stale epoch → 409 `journal-epoch-mismatch`（客户端结构化映射 → FabRuntime 权威 list）。
   - 409 epoch mismatch 响应为 `application/problem+json`，扩展字段（code/currentEpoch/firstRetainedSequence/latestSequence）与标准 ProblemDetails 字段同处 body 顶层；客户端用 F3 `journalEpochMismatchSchema` 原样 decode（Struct 忽略额外字段，测试已按真实顶层 problem+json 形状加固）。
   - **409 语义不得混淆**：POST /commands 幂等冲突也是 409 但 body 为 `{errorCode:'IDEMPOTENCY_CONFLICT'}`（无 `code`）；客户端只有 journal 的 epoch schema 解码成功才走 epoch 分支，其余 409（含幂等冲突形状）→ Terminal(`rejected`)，已加测试锁定。
   - `nextAfterSequence`：有事件=最后事件 sequence；FAB 过滤空页=latestSequence（cursor>=latest 时回显 cursor），恒前进；客户端原样透传，已测空页终止输入，FabRuntime 以 `nextAfterSequence >= latestSequence` 终止循环。
   - **F7 ProblemDetails 序列化差异**：ASP.NET Core 必有 `type/title/status`，`detail/instance` 可能为 null 或被省略；客户端 schema 只要求 code/currentEpoch/firstRetainedSequence/latestSequence，已用「detail/instance=null」与「仅 4 字段、无标准字段」两种 body 测试锁定原样 decode。POST 幂等 409 的 `{title,status,detail?,errorCode:'IDEMPOTENCY_CONFLICT'}` 形状也已测试（→ Terminal(rejected)）。
   客户端直接解码 F3 schema，fake HTTP 覆盖 200/400/409；真实后端 400/409 端到端联合验证归 F7 最终签收（backend-owner 可随时重跑/补后端断言）。
5. **FabRuntime 集成归 command-owner**：`physicalBudget` 传参、recovery 请求 `withPermit`、`onDrop`→Dirty+权威 list、gateway Effect 调用点均在其文件（fab-runtime.ts / command-event-*.ts / runtime-bootstrap.tsx / xstate adapter），已按其请求冻结接口并 send_message；本证据只验证 scheduler/gateway/reconciler 自身不变量与共享预算行为。
6. **证据 SHA**：本轮规则要求最终证据绑定 commit SHA；本任务禁止 git 写操作，工作树含多 owner 并行修改，故本文件绑定工作树状态与 HEAD `b0c3e09`，最终签收需在新 SHA 上重跑本节命令。