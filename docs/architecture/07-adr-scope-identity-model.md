# ADR-007：Scope 树、身份与命令运行时契约（Phase C 冻结接口）

- 状态：Accepted（Phase A，2026-10-29）
- 基线：`1fb25ffc36b5b65813f031c8d889063964b4d1bd`
- 关联不变量：INV-07/08/09/10/11；关联测试：CORE-007..010、CORE-014

## 1. 已证缺陷

1. `runtime/command-stream.ts` 使用全局 `Effect.runFork`：Stream Fiber 无 Scope 所有者，关闭只靠手写 cancel（INV-09/10 违反）。
2. `runtime/command-workflow-scope.ts` 用 `Effect.runSync(Scope.make())` + 一个共享 Scope 管全部 workflow；没有 per-command 子 Scope，终态驱逐直接 `workflow.dispose()`（INV-09 违反）。
3. `FabRuntime` 同时存在 `reconcileCommand` 直调、`reconcileTracked` worker、`scheduleReconcilePass` 三条路径；显式入口可绕过 4 并发限流，无统一队列/容量/取消语义（INV-08 违反）。
4. `realtime/command-event-source.transport.ts` 使用 `PubSub.unbounded` + 全局 `Effect.runSync`；慢消费者/溢出无 gap 协议（INV-10 违反）。
5. `app/runtime-provider.tsx` 的 `useCommandProjection` 同时读 Atom 与 React `useState` fallback，并订阅 runtime 广播；存在双源读取路径（INV-11 违反）。
6. `command-projection.atom.ts` 的 `Atom.family` 无界；projectionRegistry 可选导致生产可绕过 Atom 唯一来源。
7. `FabRuntime` 与 `FabRuntimeRegistry/FabLifecycleCoordinator` 没有父 Scope；Runtime 重建后旧回调只靠 disposed 布尔保护。

## 2. 决策：Scope 树与所有权

```text
AppScope (AppRuntime.rootScope, Scope.Closeable; child of ManagedRuntime.scope)
  ├── ResourceScope(resource key)            # ResourceManager 拥有（ADR-006）
  ├── FabScope(siteId, fabId, generation)    # FabRuntime 拥有；dispose() 关闭
  │     ├── CommandTransportScope            # SSE/EventSource/transport fibers
  │     ├── TelemetryScope                   # FAB telemetry 订阅（保持既有实时路径）
  │     ├── ReconciliationSchedulerScope     # 调度器 Fiber/队列
  │     └── CommandScope(commandId)          # Scope.forkUnsafe(FabScope)
  │             ├── XState actor (acquireRelease)
  │             ├── projection subscription
  │             └── command-owned tasks
  └── RenderingScope(viewer identity)        # 既有 viewer epoch/generation 生命周期
```

- 唯一最终责任者：AppRuntime 关闭 AppScope；FabRuntime 关闭 FabScope；CommandScope 由 FabRuntime（CommandScope 创建者）在终态驱逐/dispose 时关闭；ResourceScope 由 ResourceManager（ADR-006）关闭。任何类不得“先 dispose 对象再等父 Scope finalizer”。
- 全部 acquire/release 使用 `Effect.acquireRelease`；Fiber 一律 `Effect.forkIn(scope)` 或在 Scope 内 `forkScoped`；禁止在 `web_app/src` 业务代码中出现全局 `Effect.runFork/runSync/runPromise`（仅 AppRuntime 门面与测试允许，静态门禁更新）。
- 关闭顺序在 FabRuntime.dispose：scheduler.dispose() → transport/telemetry 子 Scope 关闭（cascade）→ command scopes 关闭（actor exactly-once finalizer）→ 清理投影 → FabScope 关闭。Scope 关闭幂等。
- FabRuntime 构造依赖（冻结）：`runtime: AppRuntime<never>`、`parentScope: Scope.Scope`（fork 出 FabScope）、`projectionRegistry: AtomRegistry.AtomRegistry`（**必填**，生产为 AppRuntime.registry）、`sourceFor(fabId, scope)`；旧的 `workflowScope`/可选 `projectionRegistry` 删除。
- AppRuntime 增加：`rootScope: Scope.Closeable`、`resources: ResourceManager`、`forkScope(): Scope.Closeable`；`dispose()` 顺序固定：`resources.dispose()` → `Scope.close(rootScope)` → `services.dispose()` → `registry.dispose()`。

## 3. 身份模型（全局唯一表）

| 身份 | 组成 | 生命周期/比较规则 |
|---|---|---|
| App | AppRuntime 实例 | 每个运行时独立 registry/scope；不共享 |
| Resource | ResourceKey | manager 内唯一；见 ADR-006 |
| FAB | (siteId, fabId, fabGeneration) | fabGeneration 在 FAB Runtime 注册表内单调递增；旧 generation 的 SSE/REST/timer 回调不得提交 |
| Transport | (fabGeneration, connectionGeneration) | 每次 EventSource 建立/重连 +1；回调携带 generation，旧 generation 丢弃 |
| Command | (siteId, fabId, commandId) | 复合键唯一；commandId 由后端生成；revision 由后端单调 |
| Projection | (fabId, commandId, fabGeneration) | Atom key；FAB/Runtime 重建后必须失效旧投影 |
| Device snapshot | (siteId, fabId) | 带 epoch/sequence 高水位；只经 EquipmentStatusCommit（ADR-006） |
| Rendering viewer | viewer epoch (UUID) + generation | 既有 runtime atom 语义；关闭后旧回调不写 |

## 4. 唯一核对调度器（FabReconciliationScheduler）

- 每个 FabScope 恰好一个实例，拥有 `ReconciliationSchedulerScope`（Scope.forkUnsafe(FabScope)）；`dispose()` 关闭子 Scope 并取消全部排队/在飞项。
- 所有入口统一：`trackCommand`、gap、reconnect、transportFailure、容量溢出/丢弃、显式 `reconcileCommand`、`reconcileTracked`、`reconcileAll` 只能调用调度器；FabRuntime 不得直接调用 gateway。调度器内部独占 CommandReconciler。
- 队列：按复合 identity（commandId 在同一 FAB 内唯一）去重；FIFO；`maxQueued = 128`；超容量时丢弃**最旧的非终态排队项**并触发一次 gap/dirty 对账（诊断记录），不得静默。
- 并发：`Semaphore(4)`（Effect Semaphore）限制全 FAB 同时 in-flight ≤ 4；同一 identity single-flight（重复 schedule 合并）。
- 单项超时 10s；失败/异常/关闭必须释放槽位（用 `Effect.ensuring` 或等价 finally），终态命令不重试。
- 可观测统计：`queued/inFlight/completed/dropped/timedOut/cancelled`；测试 CORE-007 在 8+ 混合入口下断言峰值 in-flight ≤ 4、同一命令 ≤ 1。
- `reconcileAll/reconcileTracked` 必须是“调度 + 等待完成”的聚合，不得创建第二套 worker 绕过限流。

## 5. 有界命令事件流与传输

- `contracts/command-events.contract.ts` 扩展：`CommandEventSource` 增加 `dirty?: Stream.Stream<CommandStreamDirty>`，`CommandStreamDirty = { readonly reason: 'overflow' | 'slow-consumer' | 'stale-generation' | 'closed'; readonly droppedCount: number; readonly epoch?: string; readonly sequence?: number }`。
- 传输层：每个 FAB 一个 `CommandTransportScope` 内的 EventSource；有界总线容量 256（`PubSub.sliding` 或等价 Queue），溢出时发布 `dirty('overflow')`（该信号不得被丢弃：单独 callback/队列），并让 FabRuntime 走调度器对全部 tracked 活动命令做权威核对。禁止只计数。
- EventSource 关闭/重开/自动重连/终止/异常都建模在 Scope 内；同一时刻最多一个连接实例；每次连接 generation token；旧连接回调因 generation 不匹配而丢弃。连接超时/背压为模型测试输入。
- `command-stream.ts` 的全局 `Effect.runFork` 删除；FabRuntime 用 `runtime.runPromise(Effect.forkIn(streamEffect, transportScope))` 或 `Stream.runForEach` 的 Scope 版；停止 = 关闭对应 Scope/Fiber.interrupt，不用手写 stop 函数作为唯一所有者。
- 事件投递仍是唯一有序路径：`(siteId,fabId,commandId,revision)` 由 CommandCorrelationRegistry 去重/排序；旧 revision、终态后事件、旧 generation 事件只产生诊断，不改变 actor 状态。

## 6. 唯一命令投影

- `CommandProjectionStore`（FabRuntime 拥有）：按 (fabId, commandId) 创建并缓存只读 Atom（`Atom.make(undefined)`），写入只有 FabRuntime/adapter aggregator 允许；`projectionRegistry` 必填。
- 投影 Atom 数量有界：active 命令 + retained terminal（≤ `maxRetainedProjections`，默认 128）；命令被完全驱逐时 `forget(commandId)` 删除 Atom 引用；FAB dispose 时全部失效。
- `useCommandProjection(fabId, commandId)` 删除 `useState` fallback 与 `runtime.subscribe`：只 `useAtomValue`；Runtime 缺失/未启动时返回 undefined；FAB 切换/Runtime 重建由 Provider version + atom identity 保证读新 Atom。
- 架构门禁新增扫描：禁止 `useState` 持有 `CommandWorkflowProjection`、禁止 `commandProjectionAtom` 外写投影、禁止 `Atom.family` 无界 family 用于命令投影。

## 7. 测试要求

- CORE-007：8+ 命令、track/gap/reconnect/overflow/显式入口混合；峰值并发 ≤4、同命令 in-flight ≤1；关闭后 0 排队/0 in-flight。
- CORE-008：actor 终态驱逐 → 关闭 FAB；每个 actor `dispose` 与 Scope finalizer 恰好一次（计数型 finalizer），无保留闭包/监听。
- CORE-009：Runtime 关闭 → 用同一 registry 重建同 FAB；旧投影/旧事件/旧状态不可读；新 Runtime 投影与 actor 全新。
- CORE-010：慢消费者 + 高速事件；总线有界、溢出产生 dirty + 权威核对；未确认命令不静默丢失（后端重放/列举兜底，见 ADR-008）。
- CORE-014：终止全部 FAB/Root Scope 后：0 活跃 Fiber、actor、EventSource、Worker、timer；无新写入（注入探针到期不写）。
- 模型/property 测试：事件序列乱序/重复/缺口/终态后/交错关闭重启；失败输出 seed 与最小反例。
- 证据：`docs/architecture/evidence/phase-c-*.md` 绑定 SHA。

## 8. 后果

- 生命周期由 Effect Scope 构造性保证，而不是布尔字段约定；关闭顺序可测试。
- 调度器成为唯一核对屏障，任何绕过都是审查/静态门禁错误。
- 有界总线 + dirty/gap 协议把“内存有界”与“不可静默丢失”同时满足，代价是重连/溢出时更多的权威对账请求（是有意的正确性成本）。
