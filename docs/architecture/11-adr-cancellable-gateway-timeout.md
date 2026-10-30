# ADR-011：可取消 Gateway、超时传播与物理请求预算（Round 2 · F1 冻结）

- 状态：Accepted（2026-10-30，第二轮整改 F1）
- 基线：`main@9ab2fd3f3cc5304f030dbf7f8e46a414ccd4ebda`（CR-04）
- 关联验收：矩阵 4；CR-04

## 1. 已证缺陷

`FabReconciliationScheduler.itemEffect` 用 `Effect.timeoutOption(Effect.promise(() => reconciler.reconcile(...)))`。`Effect.promise` 不可中断：timeout 只会中断等待它的 Fiber，底层 `runPromise`/fetch 继续执行；逻辑 permit 释放了，但物理 HTTP 请求仍在途 → “同 FAB 最多 4 个物理请求”不成立，且旧请求结果可能在超时后写 actor。

## 2. 冻结契约

### 2.1 Gateway：返回原生 Effect（可中断）

```ts
export interface CommandGateway {
  getCommandStatus(fabId: string, commandId: string): Effect.Effect<CommandResultEvent | null, CommandGatewayError>;
  listFabCommands(siteId: string, fabId: string, filter: CommandRecoveryFilter): Effect.Effect<CommandRecoveryList, CommandGatewayError>;
  getCommandJournalPage(siteId: string, fabId: string, query: CommandJournalQuery): Effect.Effect<CommandJournalPage, CommandGatewayError>;
}
```

- 禁止在 gateway 内部调用 `AppRuntime.runPromise`；composal root 通过 `runtime.runPromise(effect)` 执行顶层 effect。
- HTTP 实现必须把中断信号传到 `fetch`：`Effect.tryPromise({ try: (signal) => fetch(url, { signal }), catch: ... })`；AbortError 映射为 `CommandRequestAborted`（不进入业务失败/诊断计数）。
- `createHttpTransport` 增加 signal 感知的请求入口；所有命令恢复请求同源。

### 2.2 Scheduler：物理预算 + 真实取消

- 对每一步都使用 `Effect.timeout(`/`Effect.timeoutOption`)` 包裹**真实 Effect**（reconciler.reconcileEffect），而不是 `Effect.promise`。
- 超时/scope 关闭必须导致：Fiber 中断 → fetch AbortSignal aborted → 物理在途数递减 → `ensuring` 释放 Semaphore permit。
- 同一命令 single-flight；超时后的旧结果不得写 actor：`CommandReconciler` 在应用结果前校验 `isCurrent()` 与请求 generation（workflow 实例 + 调度 entry id）。
- 物理预算：FAB 级共享 4 个 HTTP 槽位（调度器 reconcile + FabRuntime recovery journal/list 请求都经过同一预算；恢复请求不得额外开 4 条）。实现上以 Effect Semaphore(4) 由 `FabRuntime` 暴露 `withPhysicalPermit`，调度器与 recovery 共用。
- 超时/取消/失败都不泄漏槽位（ensuring）；stats 暴露 timedOut/cancelled/physicallyInFlight。

## 3. 测试要求（RED→GREEN）

1. 假 fetch 永不 resolve：调度器 timeout 后断言 `signal.aborted === true`、物理 pending 计数归零、Semaphore 可用 permit=4、同命令重试可立即开始。
2. 混合入口（track/gap/reconnect/overflow/显式）并发 8+ 命令：物理在途峰值 ≤4（通过 fetch 层计数，不只看逻辑 stats）。
3. 超时后旧 fetch resolve：其 revision 结果不得写入 actor（断言 worker 投影不变、无额外投影发布）。
4. dispose/Scope 关闭：所有在途请求 abort，无未处理 rejection。
5. 在修复前用 fake fetch + 永不 resolve 写 RED 测试并保存输出。

## 3. Round 3 修订（2026-10-30，静态阶段；R3-05/R3-07/R3-08）

- **RecoveryScope 所有权**：FabRuntime 恢复任务不再通过裸 `void runPromise(...)` 启动；每次恢复在 FabScope 的子 RecoveryScope 中 fork 一个带 generation 标记的 Effect pass fiber。请求前后、页面应用、phase 写入、retry timer、cover 调用均校验当前 generation；`interruptRecoveryPass` 先 bump generation 再 interrupt，陈旧结果不得写 projectionStore/phase、不得触发下一轮对账。
- **统一 timeout 与物理预算**：Journal/List 请求走 FAB 共享 `PhysicalRequestBudget(4)` 与 `Effect.timeoutOption`（默认 10s）；中断信号传到 fetch，permit 在底层请求实际完成/abort 后才释放；stop() 暂停并中断当前恢复但保留意图，dispose() 先关闭 RecoveryScope 再关闭 scheduler/transport/command scopes/FabScope，cleanup 后无迟到回调。
- **权威来源声明（R3-07）**：`FabRuntimeOptions.gateway`/`FabRuntimeFactoryOptions.gateway` 改为必填属性，类型 `CommandGateway | undefined`（显式声明权威来源）。缺少 gateway 时进入可观察 `Unavailable` 状态并保留 no-authority 诊断，永不进入 Healthy；组合根在缺少 fetch 的生产环境 fail-fast，显示用 runtime 必须显式标记 display-only。
- **drop 覆盖闭环（R3-08）**：恢复 pass 记录 recoveryGeneration、权威快照水位与 dropGeneration/per-pass barrier。已被权威快照完整覆盖的 drop 记录为 covered、不重试；权威快照水位之后发生的新 drop 设置 `needsNextAuthoritativePass`/recoveryPending，不得直接 return 后宣告 Healthy。补偿 pass 有界 attempts/退避/进展证明，超限进入 Unrecoverable；恢复后的对账 batch 按剩余 scheduler 队列容量分块并优先处理 drop，禁止自造 128 队列溢出循环。
- 被拒绝的旧设计：恢复成功后的 fire-and-forget `void scheduler.scheduleMany(active)`；无 owner 的裸 Promise 恢复；只关 retry timer 不中断 fetch 的取消；无 gateway -> Healthy 的静默路径。

## 4. Round 4 修订（2026-10-30，R4-02）

- Scheduler 的 `schedule()/scheduleMany()` 现返回逐命令 `ReconciliationResult`（`succeeded | already-terminal | not-found | failed | timed-out | cancelled | dropped`，payload-free error），不再只返回成功数量；超时/5xx/取消/语义性 dropped 的逐命令结果必须由恢复批次显式判定。
- Recovery pass 只有在 authoritative snapshot 应用 + post-snapshot batch 全部收敛后才调用 `source.cover(watermark, kind)`、重置 attempts/activeRecoveryRequest 并进入 Healthy；batch 失败使 pass 进入有界退避，禁止“批次 fulfilled 即成功”。
- `trackCommand` 的 fire-and-forget 调度同样消费结果：失败/超时/取消（且命令仍需收敛）进入 Dirty 并由权威 pass 重试。


## Round 5（进行中）

Round 5 正在整改：每个 Scheduler 调用者拥有独立 waiter；最后一个 waiter 取消时中断对应请求，其他 waiter 不受影响。
