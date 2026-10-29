# Round 2 F2 evidence — SSE three-cursor ack, dirty gap precision, multi-page epoch journal recovery (CR-01/CR-02/CR-06)

- 状态：F2 实现与自测完成；最终提交 SHA 由 Lead 绑定（SHA pending，本文件不写终态 PASS）。
- 审查基线：`main@9ab2fd3f3cc5304f030dbf7f8e46a414ccd4ebda`；F1 规范冻结提交：`b0c3e09`（ADR-010/011/012/013 + 14-round2-remediation-matrix）。
- 工作目录：`C:\Users\han_qingyu\SemiconFab-Next/web_app`；环境：Windows 11、Node 26.12.1、pnpm 12.16.1（项目锁 12.15.0）、effect 4.0.7、@effect/atom-react 4.0.7、vitest 5.0.5、TypeScript 7.0.2。
- 时间：2026-10-30 07:18 (+08:00)。
- 关联：ADR-010 §2（三游标/ack/dirty 精确缺口）、§3（epoch journal、nextAfterSequence、409）、§4（恢复状态机）；ADR-011 §2.2（FAB 共享物理预算）；矩阵 1 / 2（前端）/ 6。
- 交叉依赖：F4（cancellation-owner）已落 command-gateway.contract（Effect + CommandGatewayError）、scheduler（physicalBudget/onDrop/no retry buffer）、reconciler（entryId 守卫）、http gateway；F3（backend-owner）已落 epoch+nextAfterSequence DTO/端点。本文件只记录 F2 侧证据。

## 1. 范围

### 1.1 修改（F2 写范围 + Lead file-level 授权）

- `src/contracts/command-events.contract.ts`：新增 `CommandCursor`、`CommandSourceCursors`；`CommandStreamDirtyReason` 扩展为 `overflow|slow-consumer|stale-generation|closed|server-overflow|store-fault`；`CommandStreamDirty` 改为 `{reason,droppedCount,delivered?:CommandCursor,gapStart?,gapEnd?}`（删除旧 epoch/sequence 字段，无兼容 shim）；`CommandEventSource` 新增必选 `acknowledge(event)` 与 `cursors`。
- `src/realtime/command-event-source.transport.ts`：三游标 observed/delivered/acknowledged；delivered 仅在队列接纳成功后推进；dirty 携带保守 delivered + 精确 gapStart/gapEnd；accepted 后关闭 gap episode；ack 映射有界；服务端 dirty 帧映射 + 不推进本地游标；generation token/单连接/watchdog/重连 timer 保留。
- `src/runtime/command-event-bridge.ts`：apply→acknowledge（用 actor projection revision before/after 验证；stale/terminal 不 ack；无 projection 的自定义 workflow 视为已应用）。
- `src/runtime/command-sources.ts`：pending source 实现 acknowledge/cursors 空能力。
- `src/runtime/command-event-recovery.ts`：gateway 改为原生 Effect，reconcile 由调用方提供 approved runner（测试/契约辅助路径）。
- `src/runtime/fab-runtime.ts`：恢复状态机 + 多页 epoch journal 循环 + 权威 list 兜底 + 有界退避 + shared physical budget + Effect gateway 经 runtime.runPromise + scheduler onDrop 集成 + recovery↔overflow 有界保护；physicalRequestStats/recoveryState/recoveryHistory 诊断。
- `src/runtime/fab-runtime-factory.ts`：转发 `recovery` 选项。
- `src/runtime/xstate-command-workflow-adapter.ts`：移除直调 reconciler（ADR-011 §2.2：scheduler 是唯一权威），`reconcile()` 为无权威副作用 no-op。
- `src/app/runtime-bootstrap.tsx`：Effect gateway 不再注入 runPromise（`createHttpCommandGateway()`），FabRuntime 用 AppRuntime.runPromise 执行恢复 Effect。
- 测试：`tests/correctness/sse/**`（新增 matrix-1/2/6 + harness）、`tests/realtime/realtime-transport.test.ts`、`tests/integration/command*`（event-bridge/gateway-http/recovery-contract/fab-runtime 系列）、`tests/core/core-007-command-scheduler.test.ts`（ADR-011 语义更新）、`tests/core/core-010-command-overflow-recovery.test.ts`、`tests/support/command-fakes.ts`（Effect gateway + typed error 分类 + 三游标 fake）、`tests/contract/command-workflow.test.ts`（授权更新：adapter no-op 断言）。`tests/types/effect-api-types.ts` 由 cancellation-owner 按 ADR-011 合并更新（Lead 协调，无重复修改）。

### 1.2 未修改（边界）

scheduler/gateway 契约/command-reconciler/http-command-gateway/http.transport（cancellation-owner F4）；backend/contracts DTO（backend-owner F3）；resource-manager/api resources（resource-owner F5）；渲染 F6 文件（Lead）。

## 2. 实现要点

### 2.1 三游标（transport）

| 游标 | 更新时机 | 用途 |
|---|---|---|
| observed | SSE id 解析成功（epoch:sequence） | 诊断/去重，不得作为恢复起点 |
| delivered | 事件被至少一个 bounded 队列接纳后 | dirty 的保守恢复起点 |
| acknowledged | bridge 应用后调用 `acknowledge(event)`（映射回该事件投递时的 cursor） | 重连/恢复起点 |

- 队列满（`Queue.sizeUnsafe >= capacity`）时：不推进 delivered/acknowledged；记录 `lossEpisode.gapStart/gapEnd`（精确最小/最大被丢弃序号）与单调 `droppedCount`；dirty 携带 `delivered=conservative(acknowledged,delivered)` 与 episode 范围。无法解析 id 的丢帧 → dirty 无 gapStart（消费方走权威 list）。
- accepted 后关闭 episode：下一段丢失从新的精确范围开始；dirty 通道自身 coalescing（容量 1，sliding）不会丢失单调计数与累计区间。
- `acknowledge` 只接受已投递事件（有界 event→cursor 映射）；重复/未知 ack no-op；同 epoch 不回退，跨 epoch 按新 epoch 接受（不与旧 epoch 比较）。
- 服务端 `event: dirty`（CommandDirtyDto）映射：`retention-trim→server-overflow`、`epoch-replaced→stale-generation`、`store-fault→store-fault`；服务端游标不推进本地 delivered，droppedCount 取单调 max，dirty 不带 gapStart → 权威 list 恢复。
- 恢复起点：`source.cursors.acknowledged` 由 FabRuntime 在 reconnect/recovery 时使用；浏览器 EventSource 无法自定义 Last-Event-ID header（见 §6 限制），因此“acknowledged 作为恢复起点”在恢复层实现，而不是复用 observed。

### 2.2 bridge apply→ack

- 每次投递前后读取 `workflow.projection?.revision`：actor 实际推进到该 revision 才 `source.acknowledge(event)`；stale/重复（correlation duplicate/stale）在 bridge.receive 前被过滤，不 ack；终态后事件被 actor 拒绝 → 不 ack。
- 无 projection 的自定义 workflow（测试 fake/契约实现）无法验证，视为已应用（不存在第二权威）；真实 XState adapter 始终暴露 projection。
- `flushRecovery`（trackCommand 前到达的确认）走同一 apply 路径与 ack。

### 2.3 恢复状态机（FabRuntime）

```text
Healthy --dirty|gap|reconnect|transport-failure|queue-capacity|eviction|refresh--> Dirty
Dirty --pass start--> Recovering --成功(journal 到 latestSequence / 权威 list 应用)--> Healthy
Recovering --retryable(网络/5xx/429) & attempts<max--> WaitingRetry --backoff--> Recovering
Recovering --terminal/store-fault/abort/maxAttempts--> Unrecoverable（可观察；新外部信号重新武装 attempts=0）
```

- `recoveryState`：`{phase, attempts, maxAttempts, lastError, lastDirtyCause, recoveryCursor, nextRetryAt, lastRecoveredAt, authoritativeWatermark}`；`recoveryHistory` 保留最近 32 条（at/phase/cause/message）。
- 默认退避 `[500,1000,2000,4000,8000,15000,15000,15000]ms`、最多 8 次（测试注入 1ms/3 次或 5ms 序列）；重试 timer 在 stop/dispose 清理（CORE-014 语义）。
- Dirty 只在 (a) journal 循环到达权威 `latestSequence` 或 (b) 权威 list 快照应用完成后清除；转发 SSE 事件本身不清除。删除旧实现“catch 静默 + finally 无条件 gapObserved=false”。
- 恢复成功后执行一次统一 scheduler 批量对账（tracked active），使用同一 scheduler（无第二 worker）。

### 2.4 多页 epoch journal 循环

- cursor 来自 `dirty.delivered` 或（reconnect）acknowledged；无 cursor/未知 gapStart/store-fault → 权威 list。
- 请求 `{epoch, afterSequence, limit=256(1..1000)}`；循环直到 `nextAfterSequence >= latestSequence`。
- 每页校验：epoch 必须与首页一致；events 序号严格递增、全部 > afterSequence、与 cursor 连续无空洞；`nextAfterSequence` 不得回退；空页且未到 watermark → 视为无进展 → 权威 list；`hasGap` → 权威 list；`CommandJournalEpochMismatch(409)` → 权威 list；超过 `maxJournalPages`(10000) 安全上限 → 失败（retryable 走退避）。
- 应用：事件按 fabId 过滤后经 `bridge.receive`（correlation revision 去重/排序）进入唯一投影路径；跨 FAB 空页用 sequence 水位判定，不以“过滤后为空”提前结束。
- 权威 list：`listFabCommands(siteId,fabId,'active')`；仅未确认 active 命令会被 track + 应用；terminal 记录不在 active 列表（测试注意）；成功后记录 `latestSequence` 为 authoritativeWatermark。

### 2.5 共享物理预算（ADR-011 §2.2）

- FabRuntime 创建唯一 `createPhysicalRequestBudget(4)`；传给 scheduler `physicalBudget`；recovery 的每次 journal/list 请求通过 `budget.withPermit(effect)` 并用 `runtime.runPromise` 顶层执行（api/gateway 内部不 run）。
- 观测：`runtime.physicalRequestStats {capacity,inFlight}`；`reconciliationStats.physicallyInFlight`（scheduler 读取同一 budget）。dispose 关闭 schedulerScope 中断 reconcile Effect → fetch abort（F4 证据），recovery pass 在 disposed 检查后停止。

### 2.6 scheduler queue overflow 集成（CR-08 边界）

- scheduler 满队列时不再有隐藏 4096 重试缓冲：onDrop → FabRuntime 记录 `lastReconciliationDrop` + diagnostic('queue-capacity') + Dirty(list-only) → 权威 list 恢复。
- recovery↔overflow 有界保护：`phase==='Recovering'` 或恢复后统一对账 batch 运行期间观察到的 drop 不再触发新 recovery pass（已由当前权威恢复覆盖），避免“tracked 数 > 队列容量”时无限 recovery loop（开发期一次 full-suite worker OOM 的根因，修复后复跑通过，见 §5.4）。drop 仍保留在 `lastReconciliationDrop`/Dirty 语义中，下一次外部信号（dirty/gap/reconnect）继续恢复。

## 3. RED 证据（基线行为，修复前）

RED 方法：先写 `tests/correctness/sse/**` 目标断言（用局部 round-two 结构别名/类型断言编译到基线 API），在 F2 实现前运行并保存原始输出；随后实现 GREEN。注意：F4 契约（Effect gateway）落地后，测试的 fake gateway 同步迁移为 native Effect（同一批断言未弱化），RED 原始输出保留如下。

### 3.1 CR-01（游标跳过 / dirty 精度）

```powershell
cd web_app
pnpm vitest run tests/correctness/sse/matrix-1-three-cursor.test.ts
```

原始输出（修复前，2026-10-30 07:03 +08:00）：

```text
 ❯ tests/correctness/sse/matrix-1-three-cursor.test.ts (3 tests | 3 failed) 136ms
   × advances delivered only when the bounded queue accepted the frame and reports an exact gap
   × acknowledged only advances for delivered events and never regresses
   × replays the exact dropped range through the journal and converges the actor

AssertionError: expected undefined to deeply equal { epoch: 'epoch-1', sequence: 3 }
（lastDirty.delivered 不存在——旧实现只携带已越过丢帧的 observed 序号）

TypeError: Cannot read properties of undefined (reading 'acknowledged')
（旧 CommandEventSource 没有三游标/acknowledge 能力）

AssertionError: expected 99 to be 3
 ❯ tests/correctness/sse/matrix-1-three-cursor.test.ts:152
（capacity=4 突发 100 帧后，恢复 journal 从 observed=99 开始，而不是 delivered/acknowledged=3 → 被丢弃的 4..99 永久缺失）
```

结论：CR-01 在基线上可复现——dirty 携带 observed（99），恢复从错误位置开始；ACK/保守游标不存在。

### 3.2 CR-02（单页 journal / 无 epoch）与 CR-06（恢复失败清 Dirty）

```powershell
cd web_app
pnpm vitest run tests/correctness/sse/matrix-2-journal-pagination.test.ts tests/correctness/sse/matrix-6-recovery-state.test.ts
```

原始输出（修复前）：

```text
 Test Files  2 failed (2)
      Tests  9 failed | 1 passed (10)

 × loops pages until the authoritative latestSequence (257 events = 2 pages)
 × pages 1/256/257/1000 events with strict epoch continuity
 × falls back to the authoritative list when the journal epoch is replaced (409)
 × treats a sequence hole as a gap and recovers from the authoritative list
 × continues across a page whose events are all another FAB (sequence watermark decides)
 × keeps Dirty through 5 intermittent 5xx failures and recovers without any new SSE event
 × exposes Dirty/Recovering/WaitingRetry while failing and never reports Healthy early
 × becomes Unrecoverable after the bounded retry budget and keeps the condition observable
 × uses the authoritative list on epoch mismatch and clears Dirty only after the snapshot applies
 ✓ stops retry timers on dispose (no work after teardown)（基线无 retry timer，平凡通过）

典型断言失败：
journalAttempts: expected 1 to be greater than or equal to 6（旧实现只拉一页/单次尝试）
recoveryState(runtime)?.phase: expected undefined to be 'Unrecoverable'（无状态机）
projection revision: expected +0 to be 9/10（单页恢复未应用后续事件；跨 FAB 空页提前结束）
listCalls: 未增加（409/hasGap 无权威 list 兜底）
```

结论：CR-02（无 epoch、单页、无页间校验/水位循环）与 CR-06（失败静默、finally 无条件清 Dirty、无重试/Unrecoverable 可观察）在基线可复现。

## 4. GREEN 证据（修复后，2026-10-30 07:17 +08:00）

```powershell
cd web_app
pnpm typecheck
pnpm lint
pnpm vitest run tests/correctness/sse
pnpm vitest run tests/realtime/realtime-transport.test.ts tests/integration/command tests/integration/fab-runtime tests/integration/runtime-bootstrap.test.tsx tests/integration/runtime-replacement.test.tsx tests/core/core-010-command-overflow-recovery.test.ts tests/core/core-007-command-scheduler.test.ts tests/contract/command-workflow.test.ts
pnpm test
```

原始结果：

```text
typecheck: exit 0（0 error TS）
lint: exit 0 — Found 0 warnings and 0 errors. Finished in 110ms on 209 files with 88 rules.

tests/correctness/sse:
 ✓ matrix-1-three-cursor.test.ts (3 tests) 275ms
 ✓ matrix-6-recovery-state.test.ts (5 tests) 464ms
 ✓ matrix-2-journal-pagination.test.ts (5 tests) 749ms
 Test Files  3 passed (3)
      Tests  13 passed (13)

受影响集成/单元套件:
 Test Files  15 passed (15)
      Tests  71 passed (71)

全量 pnpm test:
 Test Files  153 passed (153)
      Tests  852 passed (852)
   Duration  24.98s
   exit 0
```

其中 F2 直接相关全量行：

```text
 ✓ tests/correctness/sse/matrix-1-three-cursor.test.ts (3 tests)
 ✓ tests/correctness/sse/matrix-2-journal-pagination.test.ts (5 tests)
 ✓ tests/correctness/sse/matrix-6-recovery-state.test.ts (5 tests)
 ✓ tests/realtime/realtime-transport.test.ts (11 tests)
 ✓ tests/core/core-007-command-scheduler.test.ts (5 tests)
 ✓ tests/core/core-010-command-overflow-recovery.test.ts (3 tests)
 ✓ tests/integration/command-gateway-http.test.ts (4 tests)
 ✓ tests/integration/command-event-bridge.test.ts (7 tests)
 ✓ tests/integration/command-recovery-contract.test.ts (3 tests)
 ✓ tests/integration/fab-runtime.test.ts (10 tests)
 ✓ tests/integration/fab-runtime-batch23.test.ts (11 tests)
 ✓ tests/integration/command-actor-scope.test.tsx (3 tests)
 ✓ tests/integration/command-projection-identity.test.tsx (1 test)
 ✓ tests/integration/runtime-bootstrap.test.tsx (7 tests)
 ✓ tests/integration/runtime-replacement.test.tsx (1 test)
```

## 5. 验收矩阵映射

### 5.1 矩阵 1（SSE 有界与丢帧恢复，ADR-010 §2）

`matrix-1-three-cursor.test.ts`：

1. real transport capacity=4 + 同步突发 100 帧（消费慢于生产）：received=[0,1,2,3]；dirty.reason='overflow'、droppedCount=96、`delivered={epoch-1,3}`、`gapStart=4`、`gapEnd=99`；observed=99、delivered=3、acknowledged=3（ack 只在应用后推进）。
2. ack 不回退：投递 0..2 后 acknowledged=2；对旧 revision=1 与未投递 revision=50 的 ack 均 no-op。
3. 旗舰集成：capacity=4 突发 100 帧 + fake authoritative journal：journal 首个请求 `afterSequence=3`（不是 observed 99）、epoch=epoch-1；循环恢复 4..99；最终 projection revision=99/outcome succeeded；`recoveryState.phase='Healthy'`（到达权威水位才清 Dirty）。

### 5.2 矩阵 2（前端 journal 分页与 epoch，ADR-010 §3）

`matrix-2-journal-pagination.test.ts`：

1. 257 事件 → 2 页（page1 afterSequence=0，page2 afterSequence=256），直到 latestSequence=257；最终 revision=257，phase Healthy，未触发 list（journal 水位足够）。
2. 1/256/257/1000 事件 → 1/1/2/4 页；每页 epoch 均 'epoch-1'；最终 revision=latest。
3. epoch 替换（journal 抛 409 journal-epoch-mismatch）→ 权威 list（listCalls 增加），应用 active 记录后 phase Healthy。
4. 页内序列空洞（2,4）→ 视为 gap → 权威 list → 应用 revision=9。
5. 跨 FAB 页（site 级序号连续 3..10，仅最后一条属本 FAB）→ 以 sequence 水位继续到下一页并应用 revision=10（不因过滤为空提前结束）。
6. `command-gateway-http.test.ts` 用 F3 真实 wire DTO + 注入 fetch 做端到端：refresh list 恢复未确认命令；hasGap → list；overflow cursor → 多页 journal（请求 `epoch=epoch-1&afterSequence=7&limit=256` 等）达成 revision=10；store-fault 503 → Dirty→Unrecoverable 可观察。

### 5.3 矩阵 6（恢复状态机，ADR-010 §4）

`matrix-6-recovery-state.test.ts`：

1. 5 次连续 5xx（retryable）期间保持非 Healthy；无新 SSE 事件；第 6 次成功后自动恢复 revision=5、phase Healthy、attempts=0。
2. 失败中可观察 Dirty/Recovering/WaitingRetry + lastError；网络恢复后自动补偿到终态。
3. 有界重试预算耗尽（maxAttempts=3）→ Unrecoverable 可观察（lastError 含 503），不再自动重试。
4. journal epoch mismatch → 权威 list 应用后 phase Healthy（Dirty 仅在水位/快照后清除）。
5. dispose 后 retry timer 停止，不再产生请求（无 teardown 后工作）。

### 5.4 注入参数 / 统计

- 容量：4（丢帧主场景）/16/256；突发 100 帧；明确丢帧 96 帧。
- journal：latest=1/256/257/1000；page limit=256（契约 1..1000）；epoch mismatch、hasGap、hole、跨 FAB 空页、1024 页安全上限路径。
- 恢复：5xx 断续 5 次后成功；retryable/terminal(store-fault/abort)/epoch-mismatch 分类；maxAttempts=8（默认）/3（测试）；退避注入 1ms/5ms 序列；计时使用真实 timer（非 fake clock）避免与 Effect runtime 冲突。
- 预算：每 FAB 唯一 PhysicalRequestBudget(4)；recovery journal/list 与 scheduler reconcile 共享；`physicalRequestStats`/`stats.physicallyInFlight` 断言在 scheduler/F4 测试侧覆盖（F4 证据），F2 不重复宣称物理取消矩阵（矩阵 4 归 F4）。
- seed：F2 矩阵为确定性定向注入，不使用 PRNG（无 property seed）；所有输入序列在测试源码中固定可复现。

## 6. 限制 / 未验证项（不得作为 PASS 声明）

1. **真实浏览器 E2E 未在本阶段执行**：browser EventSource 不能设置 Last-Event-ID 自定义 header；因此 transport 暴露 `cursors.acknowledged`，FabRuntime 在 reconnect/恢复时以 acknowledged 作为 journal `epoch+afterSequence` 起点（ADR-010 §2 的“Last-Event-ID/恢复起点”在恢复层实现），并关闭原生 auto-reconnect 以保持单连接。真实生产 bundle 浏览器刷新/断线恢复属 F7。
2. **真实 backend host 未在 F2 内直连**：HTTP 层用注入 `fetch` + F3 精确 DTO 做 wire 级集成；F3 端点由 backend 的 210 tests/12 CommandRecoveryApiTests 覆盖。跨进程真实 SSE 语义需 F7 E2E。
3. **服务端 dirty 的 droppedCount 语义假设**：transport 以单调 max 合并服务端计数、服务端游标不作为本地 delivered；若后端改为“每次事件增量”语义需 F3/F7 对齐（当前不会越过本地游标，最坏退化到权威 list）。
4. **recovery HTTP 请求没有独立的 per-request timeout**：journal/list 在 physical budget 上执行，取消来自 scope dispose；调度器 reconcile 的 10s 真实超时归 F4。若后端恢复端点 hang，恢复 pass 会等待 fetch/transport 层的结果（受浏览器/网络栈限制）；建议 F4/F7 评估给 recovery 也加 `Effect.timeoutOption`（非本轮冻结要求）。
5. **recovery↔overflow 有界保护**：已知 dropped（phase Recovering / 恢复后统一对账 batch 期间）不再触发新 pass；这些 drop 依赖下一次外部信号再次进入权威 list 恢复。保证不会无限 loop（曾导致 worker OOM），代价是极少数“持续溢出且无新信号”场景需要一次新信号才再次对账；`lastReconciliationDrop`/Dirty 诊断始终可见。
6. **跳页/空洞策略是保守的**：任何页间 epoch 变化、序号不连续、非前进均转权威 list，不尝试“按序号猜”；后端 nextAfterSequence 的 F3 语义（空页推进到 latest）已在 fake/HTTP wire 测试覆盖，真实行为待 F7。
7. **RED 迁移说明**：CR-01 的 RED 在 F2 实现前完成；CR-02/CR-06 的 RED 亦在 F2 前运行。F4 契约冻结后 fake gateway 迁移为 native Effect，测试断言保持/加强（未弱化），但基线 RED 输出对应旧 Promise fake 形状（原始失败文本见 §3）。
8. **全量套件曾出现一次 worker OOM**：根因是 recovery 成功后 scheduler 对账 batch 再次 overflow → 新 recovery → 无限循环（tracked > queue capacity），core-007 worker 4GB heap exit 134；修复 §2.6 保护后全量 24.98s exit 0。该故障已写入风险表，F7 verify 应复跑确认。
9. **SHA pending**：本文件未绑定最终 commit；由 Lead 在提交后绑定。

## Lead 绑定（2026-10-30）

- F2 实现提交：`6a8ab3d53073b4ed6d4529bc062ab5f9946ba696`（同批集成依赖 F4 `9ba9460`、F3 `2315f6c`）。
- 本文件早先的 “SHA pending” 指该提交；Round 2 的 F7 全量 verify 未执行（用户要求直接提交），实机 GPU/等价验收仍待办，见 `correctness-refactor-acceptance.md`。
