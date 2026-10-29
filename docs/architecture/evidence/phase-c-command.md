# Phase C evidence — command runtime rebuild (ADR-007 + ADR-008 §2.4, CORE-007..010/014)

- 状态：Phase C 实现与自测已完成；本文件只记录可直接重跑的命令与原始输出，最终提交 SHA 由 Lead 绑定（SHA pending，本文件不写 PASS 结论以外的推断）。
- 基线提交：`1fb25ff`（规范冻结基线）；Phase A 文档提交：`9dc793f`。
- 工作目录：`C:\Users\han_qingyu\SemiconFab-Next\web_app`
- 环境：Windows 11；Node 26.12.1；pnpm 12.16.1（项目锁 12.15.0）；effect 4.0.7；@effect/atom-react 4.0.7；vitest 5.0.5；TypeScript 7.0.2。
- 记录时间：2026-10-30 00:15 (+08:00)。
- 依赖说明：`app/app-runtime.ts` 的 `rootScope/forkScope/resources` 由 Phase B（resource-owner）落地；Phase D 恢复端点与 `@/api/command-recovery.schema` 由 backend-owner 落地。本文件只声称在 Phase C 自测范围内验证通过；全仓最终签收归 Phase F。

## 1. 范围

### 1.1 新增

- `src/runtime/fab-reconciliation-scheduler.ts`：唯一核对调度器（Effect Semaphore(4)、按 commandId single-flight、FIFO 队列容量 128、丢弃最旧非终态项 + 诊断 + 有界重试、单项 10s 超时、ensuring 释放槽位、stats、dispose 关闭 ReconciliationSchedulerScope）。
- `src/runtime/command-projection.store.ts`：有界只读投影 Atom store（pinned active + retained terminal ≤ maxRetainedProjections，FabRuntime 唯一写者；值相等不重复写；eviction/dispose 失效）。
- `src/runtime/fab-runtime-host.ts`：窄运行边界 `{ runSync, runPromise }`，避免 `runtime/*` 反向 import `app/*`（R1 import graph 把 type-only 边也算环）。
- `tests/support/property.ts`：SplitMix64 确定性 PRNG、seed 输出、`minimize`/`minimizeAsync`/`arrayShrinks`（无新增依赖）。
- `tests/core/core-007-command-scheduler.test.ts`（5 tests）、`core-008-command-scope-finalizer.test.ts`（2）、`core-009-command-runtime-replacement.test.ts`（1）、`core-010-command-overflow-recovery.test.ts`（3）、`core-014-command-teardown.test.ts`（2）、`core-command-model.property.test.ts`（1）。
- `tests/architecture/command-projection-ownership.test.ts`（4 gates）。
- `tests/integration/command-gateway-http.test.ts`（4 tests，Phase D 真实 wire DTO 集成）。

### 1.2 重写

- `src/runtime/fab-runtime.ts`：FabScope/CommandTransportScope/per-command CommandScope；`Effect.acquireRelease` 获取 XState actor；终态驱逐关闭 CommandScope；固定 dispose 顺序；恢复路径（启动/gap/重连/传输失败/dirty）全部经 `listFabCommands`/`getCommandJournalPage` → 调度器。
- `src/realtime/command-event-source.transport.ts`：`Stream.callback` 有界队列（默认 256），溢出 → 单调 droppedCount 的 dirty 信号；连接 generation token；同一时刻单连接；connect watchdog + 显式重连 timer；server `event: dirty` 解码映射；无 PubSub、无全局 Effect runner。
- `src/runtime/command-stream.ts`：只提供 `runCommandStream(runtime, scope, stream, onValue)`/`stopCommandStream`，用 `Effect.forkIn` 把消费者交给 scope 拥有。
- `src/runtime/command-event-bridge.ts`：消费者 Fiber 由 CommandTransportScope 拥有；start/stop 幂等。
- `src/runtime/fab-runtime-factory.ts`：新增 runtime/parentScope/必填 projectionRegistry/sourceFor(fabId, scope)/siteId 身份。
- `src/app/runtime-provider.tsx`：`useCommandProjection` 只 `useAtomValue`（无 useState fallback、无 runtime.subscribe、无第二缓存）；Runtime 缺失时读稳定空 Atom。
- `src/app/runtime-bootstrap.tsx`：每个 FAB 从 `appRuntime.rootScope` fork；transport 的 EventSource/timer finalizer 注册到该 FAB 的 CommandTransportScope；HTTP gateway 注入 `appRuntime.runPromise`。
- `src/api/http-command-gateway.ts`：Promise 契约实现 `getCommandStatus/listFabCommands/getCommandJournalPage`，用 `@/api/command-recovery.schema` 解码，身份校验与 404/503/畸形载荷错误映射。
- `src/contracts/command-events.contract.ts`：新增 `CommandStreamDirtyReason/CommandStreamDirty` 与可选 `dirty` stream。
- `src/contracts/command-gateway.contract.ts`：ADR-008 §2.4 冻结的恢复 DTO/方法（Promise）。
- 测试重写：`tests/integration/fab-runtime.test.ts`（10）、`fab-runtime-batch23.test.ts`（11）、`command-actor-scope.test.tsx`（3）、`command-concurrency.test.ts`（1）、`command-event-bridge.test.ts`（7）、`command-projection-identity.test.tsx`（1）、`command-transport-failure.test.ts`（1）、`command-recovery-contract.test.ts`（3）、`runtime-replacement.test.tsx`（原 1）、`tests/realtime/realtime-transport.test.ts`（11，command 段重写，telemetry 段保留）、`tests/contract/command-workflow.test.ts`、`tests/contract/command-recovery.test.ts`、`tests/api/command-http.test.ts`（7）、`tests/api/effect-http.test.ts`、`tests/types/effect-api-types.ts`、`tests/support/command-fakes.ts`、`tests/architecture/effect-runtime-boundary.test.ts`。
- 经 Lead 单文件授权改 `tests/features/workbench/workbench-command-scope.test.tsx`（FakeRuntime 增加 `projectionAtom`，断言改为 Atom 投影，scope 语义断言保留）。

### 1.3 删除（无兼容层/shim）

- `src/runtime/command-projection.atom.ts`（`Atom.family` 无界）。
- `src/runtime/command-workflow-scope.ts`（单一共享 workflow Scope + 全局 `Effect.runSync`）。

## 2. 实现与 ADR-007 冻结语义的对应

### 2.1 Scope 树与生命周期

```text
AppRuntime.rootScope (Phase B)
  └── FabScope(siteId,fabId)                      FabRuntime 构造时 Scope.forkUnsafe(parentScope)
        ├── CommandTransportScope                 FabRuntime 构造时 fork；EventSource/timer/consumer fibers
        ├── ReconciliationSchedulerScope           FabReconciliationScheduler 构造时 fork
        └── CommandScope(commandId)               每个 trackCommand 时 forkUnsafe(FabScope)
              └── XState actor + projection subscription（Effect.acquireRelease）
```

- 构造依赖（ADR-007 §2 冻结）：`siteId/fabId`、`runtime: RuntimeHost`（`AppRuntime<never>` 结构满足）、`parentScope: Scope.Scope`、必填 `projectionRegistry`、`sourceFor(fabId, scope)`；`gateway/createWorkflow/retention/...` 为可选测试缝。
- actor 获取：`Effect.acquireRelease(Effect.sync(createWorkflow), w => Effect.sync(w.dispose))` 经 `Effect.provideService(..., Scope.Scope, commandScope)` 后用 `runtime.runSync` 取得；finalizer 恰好一次由 Scope close 保证。
- 终态驱逐：先取消投影订阅 → `Scope.close(commandScope, Exit.void)` → store.retain 只读终态投影；`FabRuntime.dispose` 顺序：`stop() → scheduler.dispose() → close(transportScope) → close(each commandScope) → bridge.dispose() → projectionStore.invalidateAll() → close(fabScope)`，全部幂等。
- 同步生命周期可行性（探针，2026-10-30）：Effect 4.0.7 下 `Scope.makeUnsafe/forkUnsafe`、`Scope.close`（含 `Fiber.interrupt`、pending Promise 中断）、`Semaphore.makeUnsafe`、`Stream.callback` 的 `Effect.runSync` 均同步完成；`Effect.sleep` 抛 `AsyncFiberError`。因此所有 Scope finalizer 以 `Effect.sync` 编写并保持 `FabRuntime.dispose(): void` 同步契约（不引入异步 dispose 兼容层）。
- 与 Phase D/F 的衔接：AppRuntime.dispose 先 `resources.dispose()` 再 `Scope.close(rootScope)`（Phase B 实现）；FabScope 是 rootScope 子 Scope，Runtime 级关闭与 FabRuntime.dispose 双重关闭幂等，finalizer 不会执行两次。

### 2.2 唯一核对调度器

- 每个 FabScope 恰好一个 `FabReconciliationScheduler`；`FabRuntime` 不直接调用 gateway 状态查询或 `CommandReconciler`，所有显式入口（`reconcileCommand/reconcileAll/reconcileTracked`、trackCommand 触发、gap/reconnect/transportFailure/dirty 的恢复 pass）都走 `scheduler.schedule/scheduleMany`。
- 并发：`Semaphore.makeUnsafe(4)` + pump 只在 `inFlight < maxConcurrent` 时 fork 下一项（Semaphore 作为契约内第二道保证）。
- single-flight：同一 commandId 的 in-flight/queued 项合并为一个 Promise；`stats.scheduled/completed/failed/timedOut/dropped/cancelled/queued/inFlight` 可观测。
- 容量：FIFO 128；满时丢弃最旧**非终态**排队项 → `stats.dropped+1`、`onDrop` 诊断（reason='queue-capacity'、droppedTotal、queued/inFlight 快照），并进入有界重试列表（≤4096），容量释放后重新入队；不静默丢失。
- 超时/异常/关闭：`Effect.timeoutOption(Effect.promise(reconcile), 10s)`（可注入），None→timedOut；`Effect.ensuring` 删除 inFlight、结算 waiters、唤醒 pump；dispose 关闭 Scope 中断 in-flight，caller 解析为 false。
- `onReconciled` 回调把“权威结果已投递”通知 FabRuntime（投影发布 + 终态记录），保持投影/驱逐归 FabRuntime 所有。

### 2.3 唯一投影

- `CommandProjectionStore`：每个 FabRuntime 一个；Atom 只由 FabRuntime 写（`publishProjection` 调用 store.set），React 只 `useAtomValue`。
- 有界：pinned（活跃命令）+ unpinned 上限 `maxRetainedProjections`（默认 128，含 hook 只读创建的 Atom）；evict 顺序先非 retained、再最旧 retained；`forget/invalidateAll` 先把 Atom 写成 undefined 再从 map 删除，旧会话不可读旧值。
- 值相等抑制：`state/revision/outcome` 相同则不写 registry，重复/乱序 revision 不会触发额外 React 更新。
- FAB 重建：新 FabRuntime = 新 store = 新 Atom 身份；旧 store.invalidateAll 已置 undefined（CORE-009）。
- `useCommandProjection(fabId, commandId)`：仅 `useFabRuntimeRegistry → runtime.projectionAtom(commandId) → useAtomValue`；Runtime/命令缺失时读模块级稳定空 Atom；无 useState/useRef/subscribe 双源。
- Oxc React Compiler 实验性缺陷 workaround：该 hook 标注 `'use no memo'`（详见 §5）。

### 2.4 有界 SSE 传输

- `Stream.callback` 每信号一个有界 queue（bufferSize=capacity，默认 256，sliding 内部策略仅作兜底）；publish 前用 `Queue.sizeUnsafe` 检测满，满则丢弃该帧（drop-new）、累加单调 droppedCount，并通过独立容量 1 的 coalescing dirty channel 发布 `CommandStreamDirty`（最新状态保留、droppedCount 单调累积）。
- EventSource 生命周期：第一个 commandResults 消费者打开唯一连接；最后一个消费者离开/Scope 关闭关闭连接；`host.addFinalizer` 把 EventSource close + timer clear 注册进 CommandTransportScope；无全局 Effect runner。
- generation token：每次 open 与 close 都推进 generation；旧连接回调命中 `isStale()` 时发布 `stale-generation` dirty 并丢弃；同一时刻 state.source 非空时 open 直接返回。
- 重连/超时建模：onerror → status reconnecting + transportFailure + 显式 close + reconnectDelayMs 后重开；未 onopen 的 connectWatchdog（默认 10s）→ status failed + failure + dirty('closed') + 显式重连；closeSource 清空两个 timer。
- 后端 Phase D `event: dirty`（CommandDirtyDto）映射（保持 ADR-007 §5 冻结的 4 值 reason）：

| 后端 reason | 前端 `CommandStreamDirtyReason` | 语义 |
|---|---|---|
| retention-trim | overflow | journal 裁剪导致事件可能缺失，需权威核对 |
| epoch-replaced | stale-generation | 旧 cursor/epoch 不可服务，需权威核对 |
| store-fault | closed | 权威存储故障，连接将不可信/关闭 |

- 接收后端 dirty 帧时用 `commandDirtySchema` 同步解码（Option），非法帧忽略；epoch/sequence 更新 cursor；droppedCount 进入单调累积。

### 2.5 权威恢复（Phase D 契约，前端侧）

- `CommandGateway`（Promise，ADR-008 §2.4）：`getCommandStatus(fabId,commandId) → CommandResultEvent|null`、`listFabCommands(siteId,fabId,filter) → CommandRecoveryList`、`getCommandJournalPage(siteId,fabId,{epoch?,afterSequence?,limit?}) → CommandJournalPage`。
- `http-command-gateway.ts`：`createHttpTransport` 统一 HTTP 策略；`@/api/command-recovery.schema` 的 `decodeCommandRecoveryList/decodeCommandJournalPage` 解码；响应 record 的 siteId/fabId 做 `commandIdentityMatches` 校验；404（状态查询）→ null；列表/journal 的 404/503/畸形载荷 reject（HttpFailure/InvalidServerResponse），FabRuntime 恢复路径 catch 后保持运行。
- FabRuntime 触发恢复：`start()`（刷新恢复，list status=active）；gap → journal（afterSequence=last sequence，limit=256）→ hasGap 时回退 list；reconnect/transportFailure/dirty 无 cursor → list；dirty 带 cursor → journal。恢复结果经 `bridge.receive`（fab 过滤 + revision 去重/排序）进入统一投影路径，未确认命令先 `trackCommand` 再交给调度器。
- `http-command-gateway` 的 Effect 执行由 composition root 注入 `runPromise`（bootstrap 传 `appRuntime.runPromise`），api/realtime 不出现全局 Effect runner。

## 3. 验收门禁（可重跑命令 + 原始输出）

### 3.1 静态门禁

```powershell
cd web_app
pnpm typecheck        # tsc --noEmit
pnpm lint             # oxlint src
```

原始输出（2026-10-30 00:14 +08:00）：

```text
typecheck exit=0（无 error TS 行）
$ oxlint src
Found 0 warnings and 0 errors.
Finished in 103ms on 209 files with 88 rules using 20 threads.
```

旧 Effect runner / 无界缓存扫描（在仓库根目录执行；仓内已无字面量命中，注释也已改写为不含 token）：

```powershell
Select-String -Path web_app/src -Include *.ts,*.tsx -Recurse -Pattern 'Effect\.(run|runPromise|runSync|runFork|runSyncExit|runPromiseExit|runCallback)\b'
Select-String -Path web_app/src -Include *.ts,*.tsx -Recurse -Pattern 'PubSub\.unbounded'
Select-String -Path web_app/src -Include *.ts,*.tsx -Recurse -Pattern 'Atom\.family'
Test-Path web_app/src/runtime/command-projection.atom.ts, web_app/src/runtime/command-workflow-scope.ts
```

原始结果：

```text
effect-run-matches=0
pubsub-unbounded-matches=0
atom-family-matches=0
False
False
```

### 3.2 全量测试（共享工作树，含 Phase B/D/E 新增测试）

```powershell
cd web_app
pnpm test
```

原始输出尾部（2026-10-30 00:16 +08:00）：

```text
 Test Files  141 passed (141)
      Tests  792 passed (792)
   Duration  13.69s (import 39%, tests 29%, environment 29%, transform 2%, worker 1%)
```

> 注意：该数字包含 resource-owner / backend-owner / ui-compiler-owner 在共享工作树新增的 CORE-001..006、CORE-011..013 等测试，不是 Phase C 独立测试数；Phase C 相关测试清单见 3.3。

### 3.3 Phase C 测试清单（同一份 `pnpm test` 原始行）

```text
 ✓ tests/core/core-007-command-scheduler.test.ts (5 tests) 813ms
 ✓ tests/core/core-008-command-scope-finalizer.test.ts (2 tests) 106ms
 ✓ tests/core/core-009-command-runtime-replacement.test.ts (1 test) 108ms
 ✓ tests/core/core-010-command-overflow-recovery.test.ts (3 tests) 221ms
 ✓ tests/core/core-014-command-teardown.test.ts (2 tests) 81ms
 ✓ tests/core/core-command-model.property.test.ts (1 test) 254ms
 ✓ tests/integration/fab-runtime.test.ts (10 tests) 270ms
 ✓ tests/integration/fab-runtime-batch23.test.ts (11 tests) 472ms
 ✓ tests/integration/command-concurrency.test.ts (1 test) 125ms
 ✓ tests/integration/command-event-bridge.test.ts (7 tests) 39ms
 ✓ tests/integration/command-actor-scope.test.tsx (3 tests) 64ms
 ✓ tests/integration/command-projection-identity.test.tsx (1 test) 147ms
 ✓ tests/integration/command-transport-failure.test.ts (1 test) 57ms
 ✓ tests/integration/command-recovery-contract.test.ts (3 tests) 79ms
 ✓ tests/integration/command-gateway-http.test.ts (4 tests) 309ms
 ✓ tests/realtime/realtime-transport.test.ts (11 tests) 357ms
 ✓ tests/contract/command-workflow.test.ts (3 tests) 52ms
 ✓ tests/contract/command-correlation.test.ts (5 tests) 61ms
 ✓ tests/contract/command-recovery.test.ts (7 tests) 10ms
 ✓ tests/contract/command-identity-contract.test.ts (1 test) 12ms
 ✓ tests/architecture/effect-runtime-boundary.test.ts (3 tests) 155ms
 ✓ tests/architecture/command-projection-ownership.test.ts (4 tests) 131ms
```

## 4. CORE 测试逐项映射

### CORE-007 — 8+ 混合入口峰值并发 ≤4、同命令 ≤1（INV-08）

`tests/core/core-007-command-scheduler.test.ts`（5 tests）：

1. `bounds mixed-entry reconciliation to 4 in flight and 1 per command`：10 命令同时 track + gap/reconnect/transportFailure/overflow dirty + 显式 `reconcileTracked`；gateway 计数 maxActive≤4、per-command 并发=1、timeout=0；dispose 后 queued/inFlight=0。
2. `explicit reconcileCommand is single-flight per command`：同一命令 3 个显式入口（两次 `reconcileCommand` + `reconcileAll`）只产生 1 次 gateway 调用。
3. `queue capacity is bounded and drops are diagnosed, never silent`：maxConcurrent=1、maxQueued=2、8 命令；`lastReconciliationDrop` 记录 reason='queue-capacity' 与 droppedTotal≥1，被丢弃命令在容量释放后被重试并完成（completed≥7）。
4. `times out a hung reconciliation and releases the concurrency slot`：`reconcileTimeoutMs=30`，一个永不 resolve 的 gateway 查询使 `stats.timedOut≥1`；单槽位释放后排队命令完成且 `inFlight=0`。
5. `dispose cancels an in-flight reconciliation and settles its caller`：dispose 后挂起 Promise 的 caller 解析 false，queued/inFlight=0。

> 生产默认超时为 10s（`DEFAULT_RECONCILIATION_TIMEOUT_MS = 10_000`，代码可见）；测试注入小值以避免 10s 墙钟等待，语义路径相同。

### CORE-008 — finalizer 恰好一次（INV-09）

`tests/core/core-008-command-scope-finalizer.test.ts`：

- `runs each command-scope finalizer exactly once across eviction and FAB dispose`：4 个 CommandScope（1 active + 3 terminal，terminal cap=1）→ 驱逐 2 个；`lifecycleCounts.created=4/finalized=2`；dispose 后 finalized=4 且每个 workflow.disposeCalls=1（再次 dispose 不增加）。
- `disposes actors after the terminal TTL while the projection stays readable`：TTL=100、注入 now；workflowCount→0、disposeCalls=1、retainedProjectionCount=1、dispose 后投影 undefined。

### CORE-009 — 同 registry 重建同 FAB 无旧投影/事件（INV-11/G12）

`tests/core/core-009-command-runtime-replacement.test.ts`：旧 Runtime dispose 后同一 AtomRegistry 中旧投影 Atom = undefined；新 Runtime 的 `getProjection` 为 undefined，track 后为 idle；旧 source 的事件不进入新 Runtime（20ms 后仍 idle）；新 source 事件正常推进。

### CORE-010 — 慢消费者/溢出 → dirty + 权威对账（INV-10/G10）

`tests/core/core-010-command-overflow-recovery.test.ts`：

- `bounded transport bus overflows into dirty signals instead of silent loss`：真实 `createSseCommandEventSource`（FakeEventSource、capacity=16），同步突发 40 帧；consumer 收到 ≤16；dirty.reason='overflow' 且 droppedCount≥24；Scope 关闭后 EventSource.closed=true。
- `dirty overflow triggers authoritative reconciliation without losing unconfirmed commands`：启动 list 恢复未确认命令 `recovered`（tracked+reconciled→succeeded）；无 cursor 的 overflow dirty 再触发 list 恢复（listCalls 增加），`lastDirtySignal` 记录。
- `a journal page without gap replays events instead of listing`：gap 带 epoch/sequence → journal 页回放 revision 1/2 → projection succeeded，且不再额外 list。

### CORE-014 — 终止后 0 活跃 Fiber/actor/EventSource/timer（INV-09/10）

`tests/core/core-014-command-teardown.test.ts`：

- `leaves 0 timers, stream consumers, actors and scheduler work after dispose`：fake timers 下 dispose 后 command/gap/reconnect/status/dirty 观察者全 0、lifecycle finalized=created、workflowCount=0、stats queued/inFlight=0；Effect runtime 自身已排队的 scheduler task 经 `runOnlyPendingTimersAsync` 排空后 `vi.getTimerCount()=0`（runner 自有 task 不属于 runtime-owned timer）。
- `closes the scoped EventSource and its connect watchdog timer`：真实 transport + FakeEventSource；lazy track 后只开 1 个连接且存在 watchdog timer；dispose 后 EventSource.closed=true、排空后 timer=0。

### 模型/property 测试（确定性 seed + 最小反例）

`tests/core/core-command-model.property.test.ts` + `tests/support/property.ts`：

- PRNG：SplitMix64（64-bit、BigInt），seed 以十进制/十六进制打印；本轮 seeds = 0x5eed..0x5efc（24293..24308，共 16 个），每个 seed 生成 18–47 个操作。
- 操作：result（随机 commandId/revision 0..4/outcome）、gap、reconnect、dirty、显式 reconcileAll；每个 operation 后在新 runtime 上重放并与模型（每命令单调 revision、终态不可覆盖、乱序/重复忽略）比对最终 projection。
- 失败处理：`forEachSeedAsync` 抛错包含 seed；`minimizeAsync + arrayShrinks` 收缩到最小反例；错误文本包含 seed 与 `describeExample(minimal)`。本轮 16 seeds 均无失败（无 shrink 输出）。
- 运行原始行：`✓ tests/core/core-command-model.property.test.ts (1 test) 254ms`。

## 5. Oxc React Compiler 实验性缺陷（Phase E/CORE-011 交接）

- 现象：`useCommandProjection`（自定义 hook，唯一响应式输入是 Atom 订阅）在 React Compiler ON 时按调用参数缓存返回值；Atom 更新后组件不再渲染（同一测试中内联 `useAtomValue` 的对照组件正常更新，hook 组件不更新）。
- 最小复现条件（供 CORE-011 登记）：`createTestRuntimeWithSites → AppProviders → RuntimeBootstrap` 装配后，在 React 外 `runtime.trackCommand('cmd-1')` 发布初始投影；自定义 hook 组件渲染计数在 Atom 写入后不增加，而内联 `useAtomValue` 组件增加。前提：Runtime 由 effect 装配（首渲染 runtime 不存在）、hook 参数不变、Atom 值由 runtime 写。
- workaround：`src/app/runtime-provider.tsx` 的 `useCommandProjection` 首行 `'use no memo'`（附精确注释：外部 Atom 订阅 hook + Compiler 'infer' 模式的实验性缺陷；正确性不能依赖编译器缓存，符合规范 §4）。
- 验证：加指令后 `tests/integration/runtime-bootstrap.test.tsx`（foreign FAB payload 用例）与 `tests/features/workbench/workbench-command-scope.test.tsx` 均恢复正确渲染；ON/OFF 对该 hook 等价（都是不 memo 的普通订阅）。
- 交接：请 ui-compiler-owner 在 CORE-011 等价性测试中把该场景加入（自定义 hook + 外部 Atom 订阅 + runtime 侧写入），并在生产 bundle ON/OFF 差分中确认；若上游 Oxc 修复可再移除该指令（需回归证据）。

## 6. 限制 / 未验证项（本阶段不作 PASS 声明）

1. 未在 Phase C 记录对基线 `1fb25ff` 的 RED 运行：旧实现（`command-stream.ts` 全局 runFork、`command-workflow-scope.ts`、`PubSub.unbounded`、Atom.family）在同一提交中被删除，CORE-007..010/014 针对新契约编写。旧缺陷的“源码可证”证据见 ADR-007 §1、09 号缺口表 G07–G12；本文件不把“未跑的 RED”写成已跑。
2. 后端真实 host 端到端未在本阶段执行：Phase D 端点由 backend-owner 的 197 个后端测试覆盖；前端用与后端 DTO 完全一致的 JSON 经注入 `fetchImpl` 做 wire 级集成（`command-gateway-http.test.ts`），未对 `127.0.0.1:5080` 发起真实 HTTP/SSE。真实浏览器刷新恢复 E2E 属 Phase E/F（ADR-008 §2.5/§2.6）。
3. 生产 `vite build` + preview 浏览器 E2E、GPU/长稳属 Phase E/F；本阶段只跑到 vitest（jsdom/node）。
4. 全量 `pnpm test` 数字来自共享工作树且含其他阶段测试；Phase C 的独立证据为 §3.3 清单。
5. 10s 超时默认值通过代码常量与本文件记录，测试注入 30ms；未做 10s 墙钟实测（代价高且语义路径相同）。
6. dirty reason 映射是有意的 4 值冻结域收敛（retention-trim→overflow、epoch-replaced→stale-generation、store-fault→closed）；若需要 1:1 透传后端 reason，须先修订 ADR-007 §5（当前不静默丢语义，但语义被归类）。
7. journal 恢复页大小 256（后端允许 1..1000、默认 100）；hasGap 回退 list 已测，未测试多页连续回放（单页即覆盖本阶段场景）。
8. `FabRuntime.dispose()` 保持同步（`runSync(Scope.close)`），以“所有 finalizer 均为 Effect.sync”为前提；未来引入异步 finalizer 会以 `AsyncFiberError` 失败而不是静默泄漏（CORE-014 约束不得放宽）。
9. 证据文件 SHA pending，由 Lead 在最终提交后绑定；本文件不包含最终 commit 的哈希。
## Lead 绑定（2026-10-30）

- Phase C 实现提交：`ff5f54b9a7e9aae14ba553801f783bc98b0e2460`。
- 本文所有“SHA pending / 由 Lead 绑定”指该提交；最终整树验收证据见 `docs/architecture/evidence/final-verify.json` 与 `correctness-refactor-acceptance.md`（绑定最终 verify 的 commit）。
- 本文原始输出均可按文中命令重跑；未重跑的推断不得视为 PASS。
