# Round 4 源码整改记录（R4-01 … R4-09）

- 文档性质：**源码整改与验证记录，不是最终验收证明**。
- 审查基线（输入）：`main@d04ee8b2bbcdf1ad5816c28515c697f8a57b44f3`（Round 4 复审目标）；对照 `20101b433d9861e7056ed6e58446f0cf4a8317d1`。
- 依据：Round 4 复审报告 R4-01…R4-09、生产源码、ADR-010/011/012/013、前后端契约与仓库既有静态审查记录。
- 本轮实际执行：生产代码/契约/ADR/测试 fixture 修改；`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、3 个 .NET 项目 Release build + `dotnet test`、契约/生成物/架构/frozen-assets/Python tools/migrate-legacy 源码门禁、`git diff --check`。
- 本轮未执行：浏览器 E2E（`scripts/e2e-production.ps1`）、GPU 600s device-loss soak、Oxc Compiler ON/OFF 生产等价、完整 `scripts/verify.ps1`（因其包含上述浏览器/Compiler 阶段）、真实 HTTP 400/409/429 端到端、真实多 FAB SSE 并发负载、真实 transport+FabRuntime 的 unknown-gap 端到端。

## 1. 整改总表

| ID | 审查结论 | 本轮状态 | 主要代码/契约 |
|---|---|---|---|
| R4-01 | ACK latch 未覆盖全部丢失路径，cover 无条件解锁 | 源码整改完成：统一 `markUntrustedGap` + untracked high-water + cover authority 释放条件 | `realtime/command-event-source.transport.ts`、`contracts/command-events.contract.ts` |
| R4-02 | Recovery 批次忽略 Scheduler 失败结果，cover/attempts 过早重置 | 源码整改完成：逐命令 `ReconciliationResult`；batch 成功后才 cover/重置/Healthy；fire-and-forget 失败进入 Dirty | `runtime/fab-reconciliation-scheduler.ts`、`runtime/fab-runtime.ts` |
| R4-03 | observed 与实际应用混同；rejected event 从队列丢失 | 源码整改完成：observed/applied/covered 分离，`receiveAuthoritative` 绕过 SSE 去重，flush 只释放 Applied/Covered | `runtime/command-event-bridge.ts`、`runtime/command-correlation-registry.ts`、`runtime/command-event-recovery.ts`、`fab-runtime.ts` |
| R4-04 | Replay-Gap 用继承 lastEventId 拼不可信游标 | 源码整改完成：解析器只保留 payload epoch（sequence 永不继承），gap 一律 listOnly | `command-event-source.transport.ts`、`runtime/fab-runtime.ts` |
| R4-05 | Stream 消费 Fiber 失败无观察者 | 源码整改完成：`runCommandStream` exit/defect observer；bridge/signal 有界重启；超限 Unrecoverable | `runtime/command-stream.ts`、`command-event-bridge.ts`、`fab-runtime.ts` |
| R4-06 | source availability 未纳入健康状态 | 源码整改完成：recovery authority 与 realtime transport 分离；新增 `Degraded` 与 `realtimeAvailability`；无 EventSource 组合根 display-only + PROD fail-fast | `fab-runtime.ts`、`app/runtime-bootstrap.tsx`、`runtime/command-sources.ts`、transport |
| R4-07 | 容量/超时用 Math.max 归一化可被 NaN/Infinity 破坏 | 源码整改完成：`contracts/command-config.ts` 严格 safe-integer/finite 校验，构造期 fail-fast | `contracts/command-config.ts` + transport/scheduler/recovery/correlation/runtime |
| R4-08 | Active command 无硬 admission；correlation maxEntries 非硬上限 | 源码整改完成：后端 SQLite 写事务内 `MaxActiveCommandsPerFab` admission + 429；前端 `maxActiveCommands` 与 correlation 硬上限 | `fab_app/src/EquipmentCommandService.cs`、`fab_shared/src/store/{CommandStore,SqliteCommandStore}.cs`、`fab_app/src/ApiHost.cs`、`fab-runtime.ts`、`command-correlation-registry.ts` |
| R4-09 | FAB 过滤空页不推进 SSE 扫描 cursor | 源码整改完成：无 gap 的成功扫描始终推进 Site 级 cursor，仅实际写出帧时 flush | `fab_app/src/ApiHost.cs` |

## 2. 关键设计（按 R4 编号）

### R4-01 统一 ACK 安全锁

- 所有无法证明“已登记/已应用”的路径统一经过 `markUntrustedGap`：consumer queue overflow/drop、无可用 journal id、JSON/Schema/未知 topic 解码失败、epoch 不一致、非单调序号、server dirty 控制帧、replay-gap、`onerror`、connect timeout、factory throw、stale generation。
- latch 记录两类状态：`untrackedHighWater = {epoch, sequence}`（id 行能证明位置）与 `untrustedUnknownGap`（无法证明/跨 epoch）。latch 期间到达的帧仍可见但不再进入 ACK ledger，且持续抬高高水位（复审报告 200/201 场景）。
- `cover(cursor, authority)` 释放条件：已知位置必须同 epoch 且 `cursor.sequence >= highWater.sequence`；未知或跨 epoch 位置必须 `authority === 'list'`。cover 不足时保留 latch、记录有界诊断并发布 `uncovered-gap`（无 gapStart → 重新 List）；cover 足够时清除 latch 并排空可证明的 applied|covered 前缀。
- pending 条目从不驱逐；ACK 不会越过未登记位置。

### R4-02 Scheduler 结果与恢复时序

- `schedule()/scheduleMany()` 返回逐命令 `ReconciliationResult`：`succeeded | already-terminal | not-found | failed | timed-out | cancelled | dropped`（payload-free error）。
- Recovery pass 只在 authoritative snapshot 应用 + post-snapshot batch 全部收敛后：`source.cover(watermark, kind)`、重置 attempts、清除 activeRecoveryRequest、进入 Healthy/Degraded。
- batch 中 failed/timed-out/cancelled（以及无 drop intent 的 dropped）直接使 pass 失败并进入有界退避；`trackCommand` 的 fire-and-forget 调度失败同样进入 Dirty。
- `appliedRecords` 只统计 bridge 权威应用的 Applied/Covered 结果，不再统计“调用次数”。

### R4-03 observed / applied / covered 分离

- Correlation 同时维护 observed revision 与 applied revision；`markApplied` 只在 actor projection 证明前进后调用。
- `receiveAuthoritative(event, coveredRevision?)` 跳过 observed-revision 去重门槛，重新投递 actor，并按 projection 归类：`applied / stale-covered / rejected`；不可验证 workflow 仅在 coveredRevision 覆盖时视为 applied。
- `flushRecovery()` 返回 `{applied, held, rejected}`；只移除 Applied/Covered，rejected 重新入队并由 FabRuntime 转为 Dirty。

### R4-04 Replay-Gap 安全恢复

- `parseCommandReplayGap(data)` 单参数：只接受 payload epoch，`requestedLastEventId` 仅进入 `gap.cursor` 诊断，**永不产生 sequence**；malformed frame → `{}` + 有界 control-frame 诊断。
- FabRuntime 对每个 replay-gap 一律 `listOnly: true`；不使用 transport 的 observed/lastEventId 作为游标。

### R4-05 Stream Fiber 监督

- `runCommandStream` 增加 `{label,onDefect,onExit}` observer：handler 抛异常转为有界诊断（消费继续），fiber 终止可被 owner 观察。
- CommandEventBridge 意外退出时先重置 `started/commandFiber` 再回调 owner；`stop()/dispose()` 的预期退出不回调。FabRuntime 对 bridge 与 5 个 signal fiber 执行有界重启（≤3 次）并触发权威恢复；超限进入 Unrecoverable，绝不保留“fiber 已死但 running=true”。

### R4-06 Realtime 与 Recovery 可用性分离

- `recoveryAvailable = gateway !== undefined && source.availability === 'ready'`；无 gateway = display-only `Unavailable`；有 gateway 但 source 不可用同样 display-only。
- 新增 `CommandRecoveryPhase = … | 'Degraded'` 与 `recoveryState.realtimeAvailability: 'ready' | 'unavailable'`。仅当 recovery authority 可用且实时 transport ready 时才 Healthy。
- runtime-bootstrap 仅在 EventSource+fetch 都存在时创建 HTTP gateway；无 EventSource → `gateway: undefined` 的 display-only runtime；PROD 缺失任一 transport 直接 fail-fast。transport 的 `availability` 为 getter：无 factory 永久 unavailable；factory throw/connect timeout 有界重试（`maxConnectAttempts`，默认 4），耗尽后永久 unavailable，不再无限重连。

### R4-07 严格配置校验

- `web_app/src/contracts/command-config.ts`（纯函数，realtime 可按 ARCH-06 引用）：`resolveIntegerOption`（Number.isSafeInteger + 边界）、`resolveTimeoutOption`（finite + 边界）、`resolveBackoffSchedule`（非空、finite、≥0）、`resolveClockOption`；非法显式配置抛 `CommandConfigurationError`，不做 NaN/Infinity 静默归一化。
- 覆盖 transport capacity/connectTimeout/reconnectDelay/ackLedgerCapacity/maxConnectAttempts；scheduler maxConcurrent/maxQueued/timeout；recovery maxAttempts/journalPageLimit/maxJournalPages/requestTimeout/maxCompensationPasses/backoff；correlation maxEntries/maxTerminalEntries/terminalTtlMs；FabRuntime retention 与 active admission 等。

### R4-08 Active command 硬 admission

- 后端：`EquipmentCommandOptions.MaxActiveCommandsPerFab`（默认 64，构造期 1..4096 校验）。admission 计数在**同一个 SQLite 写事务**内完成（BEGIN IMMEDIATE；先判幂等 replay/conflict，再 COUNT revision<2，再插入），无 check-then-act 窗口；超过上限返回 `ActiveCapacityExceeded`，HTTP 429 problem：`code=active-command-capacity`、`errorCode=ACTIVE_COMMAND_CAPACITY`，携带 limit/activeCommands。幂等 replay 在容量已满时仍成功。
- 前端：`FabRuntimeOptions.maxActiveCommands`（默认 64）在 `trackCommand` 处硬拒绝并抛 `ActiveCommandCapacityError`（不创建 workflow/Scope/actor）；authoritative 恢复可镜像后端已有状态并记录 `active-capacity` 诊断；correlation `maxEntries = maxActiveCommands + maxTerminalWorkflows` 且为硬上限（先 terminal，再 oldest active）。

### R4-09 SSE 扫描游标

- live loop 在 `pending.HasGap == false` 时无条件推进 `cursor = pending.LatestSequence`（即使目标 FAB 过滤后 Events 为空）；仅实际写出帧/gap 帧时 flush。避免空闲 FAB 反复 O(n) 扫描 Site journal，并减少其他 FAB 活动导致的 retention 误报。

## 3. 验证证据（本轮实际执行）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 前端类型 | `web_app> pnpm run typecheck` | exit 0 |
| 前端 lint | `web_app> pnpm run lint`（oxlint src） | 0 warnings / 0 errors，211 files |
| 前端单测 | `web_app> pnpm test`（Vitest） | **155 files / 908 tests PASS** |
| 前端构建 | `web_app> pnpm run build` | PASS（vite 8.3.5，1745 modules） |
| 后端构建 | 3 个 .NET 项目 `dotnet build -c Release` | 0 warnings / 0 errors |
| 后端单测 | `dotnet test fab_tests -c Release` | **226 passed / 0 failed** |
| 契约一致 | `python tools/generate_contracts.py --check` | PASS |
| 生成物 | `node tools/check_generated_artifacts.mjs --check` 等 | PASS |
| 架构/工具 | `python tools/check_architecture.py`、`python -m unittest discover -s tools` | PASS（8 tests） |
| 冻结资产 | `node tools/check_frozen_assets.mjs` + `node --test tools/test_check_frozen_assets.mjs` | PASS（4 tests） |
| 空白/冲突 | `git diff --check` | PASS |

原始日志：`.local/r4-full-web-test.log`、`.local/r4-source-verify2.log`（本地工作区，不随仓库提交）。

## 4. 因语义变更同步的测试 fixture（Round 3 源码从未运行，本轮首次全量运行）

- `tests/correctness/sse/matrix-1-*`：ACK latch 下 pending 计数、journal cover(99) 释放已知高水位的期望更新；新增 R4-01 latch/cover 用例。
- `tests/integration/command-gateway-http.test.ts`：replay-gap 改为 List-only（不再断言 journal afterSequence 游标），新增“不得制造 journal cursor”断言。
- `tests/core/core-010-command-overflow-recovery.test.ts`：journal 恢复路径改由“带安全 delivered cursor + gapStart 的 dirty”触发；replay-gap 一律 List。
- `tests/integration/fab-runtime*.test.ts`：drop 覆盖测试改用无 projection workflow 以强制调度器 admission；100 active command 的保留测试显式提高 `maxActiveCommands`。
- `tests/integration/command-event-bridge.test.ts`、`tests/contract/*`、`tests/correctness/gateway/*`：flushRecovery 返回对象、scheduler 结果对象、correlation applied watermark/hard cap、config fail-fast 断言。
- 新增/扩展：transport 5 个 R4-01/R4-04/R4-06/R4-07 用例；bridge 16 个（含 receiveAuthoritative/rejected re-hold/fiber exit）；C# `CommandAdmissionTests`（9 tests，含 429、replay-at-capacity、per-FAB、restart 持久化、24 并发多 store 原子性、配置绑定、R4-09 空 FAB 页）。

## 5. 未完成验证与风险（不得宣称最终验收）

1. **浏览器/生产**：浏览器 E2E、`scripts/verify.ps1` 全量、真实 Chrome/WebGPU 600s、Oxc ON/OFF 生产等价未运行。
2. **真实 HTTP**：400 journal-cursor-invalid、409 journal-epoch-mismatch、429 active-command-capacity 的端到端（含真实浏览器 UI 展示）未运行；C# 侧有 API 级测试。
3. **真实多 FAB SSE**：多 FAB 交错负载、空闲 FAB 扫描成本、retention 误报与 R4-09 行为仅由后端 API 级测试覆盖。
4. **unknown-gap cover**：真实 transport 的 replay-gap/onerror latch 需要一次额外 List 才能释放；当前只有 transport 级测试，尚无真实 SSE + FabRuntime 的端到端验证。
5. **bridge 重启**：真实 transport 上 commandResults consumer 意外终止后的有界重启/恢复只有 fake source 集成测试。
6. **Degraded 路径**：初始 ready 的 transport 运行中永久不可用（factory 重试耗尽）改变 phase 为 Degraded 的行为，由 transport 测试与代码路径覆盖，缺真实浏览器集成验证。
7. **终态语义**：维持 Round 3 决策 A（active-only 刷新恢复；终态历史不保证跨刷新）。
