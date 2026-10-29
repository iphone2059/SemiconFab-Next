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