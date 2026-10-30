# Round 3 静态整改审查记录

- 阶段：Round 3 静态整改（**代码先行、暂不运行测试**）。
- 规范：`docs/architecture/15-round3-static-remediation-spec.md`（含 2026-10-30 产品决策补充）。
- 审查基线：`main@20101b433d9861e7056ed6e58446f0cf4a8317d1`；本轮仅修改生产代码/协议/ADR/生成物/测试 fixture 源码。
- **本轮未运行任何 Vitest、dotnet test、浏览器 E2E、GPU soak、Compiler ON/OFF 或 verify.ps1**；也未运行 typecheck/lint/build。本文结论均为「源码确认 / 有条件风险 / 待运行复现」，不是功能验收 PASS。
- 产品决策（用户澄清，优先于原 R3-10 默认值）：**当前部署默认 1 个 FAB；架构必须支持 1–32 个相互独立 FAB**。`SiteDirectory.DefaultFabCount=1`，显式 `Fab:FabCount` 支持多 FAB；多 FAB 身份隔离与测试覆盖保留。

## 1. 整改总表（R3-01…R3-11）

| ID | 结论 | 生产代码变化 | 主要文件 | 风险 / 留待验证 |
|---|---|---|---|---|
| R3-01 | 源码确认 | 后端 hasGap 改 long 边界（after<first-1 / after>latest / dropped）；空保留窗口不再伪装成功；nextAfterSequence 定义为服务端扫描区间结束。前端在 runJournalRecovery 增加独立协议防御（cursor 早于 first-1、first<=latest+1、next<=latest、水位自洽），不自洽→RecoveryNeedsAuthority→权威 List | `fab_app/src/EquipmentCommandService.cs`、`web_app/src/runtime/fab-runtime.ts` | Round 3 验证阶段覆盖全空 Journal/保留窗口边界/多页 |
| R3-02 | 源码确认 | transport 由 max-cursor ack 改为有序 delivered ledger（pending/applied/covered）；仅连续 applied\|covered 前缀推进 acknowledged，禁止驱逐 pending；容量饱和/epoch 不一致→Dirty；重连用安全 ACK 前缀；权威恢复 `cover(cursor)` 显式覆盖并同步 watermark；bridge 仅在 actor projection revision 验证后 ack | `web_app/src/realtime/command-event-source.transport.ts`、`.../command-event-bridge.ts`、`contracts/command-events.contract.ts` | 跨 generation cover 防回退依赖 FabRuntime 只允许当前 generation 调用；动态交错验证留待运行阶段 |
| R3-03 | 源码确认 | 前端删除“相邻序列差=hole”判定；改为严格递增 + epoch 等价 + cursor 边界 + nextAfterSequence 前进 + server hasGap 权威；foreign FAB/非单调/越界→RecoveryNeedsAuthority；fixture 改为 FAB-A 1,3,5,7 且无 FAB-B 行 | `web_app/src/runtime/fab-runtime.ts`、`tests/correctness/sse/matrix-2-*` | 真实服务端分页契约联调留待运行阶段 |
| R3-04 | 源码确认 | 坏帧 JSON/command/未知 topic/dirty 控制帧解析失败→有界诊断 + Dirty（decode-error/invalid-control-frame/protocol-error/ack-ledger-overflow），不 ACK；无法证明 id/topic→listOnly→权威 List；运行时 sticky dirty | `transport.ts`、`contracts/command-events.contract.ts` | 跨范围 fixture 缺 lastEventId 会产生 Dirty、需验证阶段补 id |
| R3-05 | 源码确认 | RecoveryScope（FabScope 子 Scope）+ generation-stamped pass fiber；Journal/List 走共享 PhysicalRequestBudget(4) + Effect.timeout(10s)，中断→fetch abort→permit 释放；stop/dispose 语义显式；旧 generation 不写 phase/projection/不触发对账 | `fab-runtime.ts`、`fab-runtime-factory.ts`、`app/runtime-bootstrap.tsx` | hung fetch 的真实 abort/permit 时序留待验证 |
| R3-06 | 源码确认 | startPolling 统一所有权谓词（!removed && polling && scopeGeneration===started && scope===scope）；catch 不再裸清 polling；新增 fiber 终止观测；有界诊断环（32）+ entry.lastDiagnostic；current-generation 终止策略=清 owner→诊断→≤1 次安全重试→stopped；closeScope 防御 | `web_app/src/api/resource-manager.ts` | 注入失败 ManagedRuntime/fiber 的动态验证留待运行阶段 |
| R3-07 | 源码确认 | gateway 改为必填属性（类型 CommandGateway \| undefined，显式权威声明）；缺失→可观察 Unavailable + no-authority 诊断，永不 Healthy；组合根生产环境缺失 fetch fail-fast；显示用 runtime 显式 display-only | `fab-runtime.ts`、`fab-runtime-factory.ts`、`runtime-bootstrap.tsx` | 组合根缺失路径的浏览器行为留待运行阶段 |
| R3-08 | 源码确认 | dropGeneration + per-pass barrier；covered drop 记录不重试；快照后 drop 设 needsNextAuthoritativePass，不得直接 return 后 Healthy；补偿有界 attempts/退避/进展证明，超限 Unrecoverable；对账 batch 按剩余队列容量分块并优先 drop，禁止自造 128 溢出循环 | `fab-runtime.ts` | 需验证真实调度/快照交错 |
| R3-09 | 源码确认 | 程序级 recoveryBudget 必须 safe integer 1..96，否则构造即抛配置异常；`?perf&recoveryBudget=N` 严格十进制安全整数，非法值保留默认并诊断；NaN/Infinity/非整数不可能进入熔断器 | `web_app/src/rendering/lite-backend.ts` | 实机 GPU 探针留待验证 |
| R3-10 | 源码确认（按产品决策修正） | `SiteDirectory.DefaultFabCount=1`（当前部署一个 FAB），`Fab:FabCount` 1..32 保留；删除 Site 级静默 FAB-01 equipment-status 端点与 PrimaryFab；FAB 身份/实例标识按 FAB code 隔离；多 FAB 测试改显式 FabCount=3 | `fab_app/src/SiteDirectory.cs`、`ApiHost.cs`、前端 `fab-layout-identities`/`twin-page`/`runtime-bootstrap`、文档 | 多 FAB 浏览器/Run 验证留待运行阶段 |
| R3-11 | 源码确认（决策 A） | ADR-010 §6.6 明确 active-only 刷新恢复语义；命令控制台/注释明确终态历史跨刷新不保证、历史由独立资源读取；不宣称全量恢复 | `docs/architecture/10-*`、`command-console.tsx`、`use-command-console.ts` | 产品若需终态历史需决策 B（List all 分页 + revision 快照） |

## 2. 逐文件变更（按 owner / 批次）

### A. Journal 契约 + 默认 FAB / API 语义（R3-01 后端、R3-10）
- `fab_app/src/EquipmentCommandService.cs`：long 边界 hasGap；空保留窗口→gap；nextAfterSequence=服务端扫描区间结束（截断页=末事件；耗尽/空页=latest；超前回显，不回退；after<latest 必前进）。
- `fab_app/src/SiteDirectory.cs`：DefaultFabCount 3→**1**（产品决策）；Min/Max 1..32；确定性 FAB-01..32 身份；删除 `PrimaryFab` 隐式 FAB-01。
- `fab_app/src/ApiHost.cs`：删除 `/sites/{siteId}/equipment-status` 与 `/stream` 的静默 FAB-01 别名（无调用者）；注释明确 Site 级 vs FAB 级；FAB-scoped 端点必须显式 fabId。
- `fab_app/src/SiteKpiCalculator.cs`：注释明确 Site 聚合边界（共同观测校验，非 FAB-01 替换）。
- `fab_tests/src/CommandPersistenceTests.cs`：+3 保留窗口/空站点 fixtures（源码，不运行）。
- `fab_tests/src/CommandRecoveryApiTests.cs`：空站点首页非 gap、TTL 清空窗口 gap、ahead cursor；跨 FAB 稀疏测试显式 `fabCount: 3`。
- `fab_tests/src/ApiTests.cs`：默认单 FAB 身份；显式 `Fab:FabCount=3` 的多 FAB 身份 + 三 FAB Run/SiteKPI 聚合。
- `fab_tests/src/TelemetryApiTests.cs / EquipmentStatusTests.cs / CommandApiTests.cs`：默认单 FAB 适配；多 FAB 走显式配置。
- 拒绝旧设计：`hasGap = dropped>0 || after>latest`、混合 nextAfterSequence 语义、单 FAB 默认假设、Site 级静默 FAB-01 别名、PrimaryFab。

### B. SSE ACK ledger + 协议错误（R3-02、R3-04）
- `web_app/src/contracts/command-events.contract.ts`：dirty reasons 新增 decode-error/invalid-control-frame/protocol-error/ack-ledger-overflow；`CommandProtocolDiagnostic`（有界、无 payload）；`pendingAcknowledgements`；`cover(cursor)`/`protocolDiagnostics`/`availability` 必选；acknowledge 注释三态。
- `web_app/src/realtime/command-event-source.transport.ts`：有序 delivered ledger（容量可注入，默认 256；饱和→Dirty+粘性 ackBlockedUntilCover，从不驱逐 pending，仅 cover 释放）；连续前缀推进；epoch 不一致不 ACK 需 cover；坏帧 Dirty 不 ACK；diagnostics 上限 16；dirty.delivered=安全前缀；未知 topic 协议错误。
- `web_app/src/runtime/command-event-bridge.ts`：仅 actor projection revision 证明已应用才 ack；stale/terminal/duplicate 不 ack。
- `web_app/src/runtime/command-sources.ts` + `tests/support/command-fakes.ts`：pending source 显式 unavailable + no-op cover/ack；fake 实现新能力。
- 测试 fixture 源码：`tests/correctness/sse/matrix-1-*`、`matrix-2-*`（C owner 改写稀疏/foreign FAB）、`matrix-6-*`、`tests/realtime/realtime-transport.test.ts`。
- 拒绝旧设计：max(sequence) 推进 ack、ack 即推进、驱逐 pending、delivered 当恢复起点、坏帧静默、可选 cover 兼容层。

### C. Recovery 层（R3-01 前端、R3-03、R3-05、R3-07、R3-08）
- `web_app/src/runtime/fab-runtime.ts`（重写恢复层）：RecoveryScope/generation/fiber；Effect.timeout + 共享物理预算；稀疏 Journal 校验；恢复状态机含 Unavailable；drop 覆盖状态机（covered/post-snapshot/pending/有界补偿）；分批对账；cover 仅在权威 watermark 后调用。
- `web_app/src/runtime/fab-runtime-factory.ts`：gateway 必填属性（CommandGateway | undefined）。
- `web_app/src/app/runtime-bootstrap.tsx`：组合根显式声明 authority；生产缺失 fetch fail-fast；jsdom 显式 display-only。
- 测试 fixture 源码：`tests/integration/command-recovery-contract.test.ts`、`tests/integration/fab-runtime.test.ts`、`tests/correctness/sse/matrix-2-journal-pagination.test.ts`。
- 拒绝旧设计：相邻 expected+1 判洞、无 gateway→Healthy、裸 void runPromise、fire-and-forget scheduleMany、恢复后整批调度、只关 timer 的取消。

### D. Resource polling（R3-06）
- `web_app/src/api/resource-manager.ts`：统一 `isCurrentPollOwner`（!removed && !disposed && polling && scopeGeneration===started && scope===scope）；catch 走守卫、不重置新 generation；fiber 终止观测；MAX_POLL_RETRIES=1；有界诊断环 32 + lastDiagnostic；closeScope 防御。
- `web_app/tests/correctness/resource/cr-10-poll-generation.test.tsx`：静态断言 fixtures（源码，不运行）。
- 拒绝旧设计：catch 裸 `entry.polling=false`、旧 generation 覆盖新 owner。

### E/F. GPU 参数、FAB 架构、终态语义、文档/契约（Lead）
- `web_app/src/rendering/lite-backend.ts`：R3-09 严格 safe integer 验证（1..96，程序级 fail-fast；`?perf` 严格十进制、非法保留默认并诊断）。
- `web_app/src/domain/fab-layout-identities.ts` / `lite-geometry-tool-families.ts` / `lite-world.ts` / `lite-backend.ts` / `twin-page.tsx`：FAB-scoped 实例标识（`{fabCode}/tool-N`）与场景/检查器传递，避免多 FAB 身份冲突。
- `twin-page-data.ts` / `twin-translations.ts` / `command-console.tsx` / `use-command-console.ts` / `use-twin-route-state.ts`：多 FAB/active-only 恢复语义文案；删除“单 FAB/默认三个”误导文案。
- `docs/architecture/10/11/12/13`：Round 3 修订（6.1–6.6、3+5 节）；`docs/architecture/15-round3-static-remediation-spec.md` 冻结；`docs/architecture/16-round3-static-review.md`（本文）。
- `docs/IMPLEMENTATION-STATUS.md`、`docs/fab-runtime.md`、`docs/architecture.md`、`docs/architecture/README.md`、`09-gap-register-and-gates.md`、`web_app/README.md`、`fab_tests/README.md`、`tools/e2e_functional.mjs`、`tools/compiler_equivalence.mjs`、`docs/evidence/single-fab-scope-plan-*`：同步“当前默认 1 FAB / 架构支持 1–32 / 多 FAB 由显式配置验证”的表述。
- 产品决策：R3-10 原“默认 3”被用户澄清覆盖为“当前默认 1、架构支持多 FAB”；多 FAB 身份/隔离代码与测试保留。

## 3. 状态机与异步所有权（摘要）

- 恢复状态：`Healthy / Dirty / Recovering / WaitingRetry / Unrecoverable / Unavailable`。只有权威 watermark 到达或 authoritative list 快照应用完成且 batch 收敛、无 post-snapshot drop 时才 Healthy；gateway 缺失为 Unavailable（永不 Healthy）；重试有界，超限 Unrecoverable。
- SSE：observed（到达）/delivered（入队成功）/acknowledged（actor 应用且连续前缀）；ledger 容量饱和、epoch 不一致、坏帧都进入 Dirty 并等待权威 cover；旧 generation 不得 cover 回滚。
- Recovery pass：Fiber 归 RecoveryScope；网络请求归共享 PhysicalRequestBudget(4) + Effect.timeout；generation 校验贯穿 phase/记录/写/retry/cover；dispose 先关 RecoveryScope 再关 scheduler/transport/command scopes。
- Polling：then/catch/fiber-exit/retry/scope-close 全部走同一所有权谓词；stale 只释放旧 owner；current 终止按清 owner→诊断→一次重试→stopped 策略。
- Scheduler：保持单一调度器/物理预算/单一投影；overflow 不再有 4096 二级重试缓冲，drop 记录 intent 并由恢复快照覆盖收敛。

## 4. 静态门禁检查（本轮实际执行的只读检查）

- `git diff --check`：通过（无空白/冲突标记）。
- `web_app/src` 根仅 `main.tsx` + 16 个一级模块；无二级目录。
- `package.json` 无 Babel/Zustand/TanStack Query/RxJS/Zod 新依赖；未新增依赖。
- `src` 无新增 `@ts-ignore/@ts-nocheck`；`runtime/realtime` 无新增全局 `Effect.runFork/runSync/runPromise`（仅 app-runtime 边界与既有测试）。
- contracts/DTO 未变化（R3-01/03 为语义/校验修复，无新 DTO），未改 generated 产物。
- ADR-010/011/012/013 已同步 Round 3 修订；本文与 `15-round3-static-remediation-spec.md` 为当前事实来源。

## 5. 明确推迟到独立 Round 3 验证阶段（本轮不声称 PASS）

1. `pnpm typecheck`、`pnpm lint`、`pnpm test`（含新增 fixture/断言）。
2. `dotnet build/test Release`（含保留窗口、多 FAB 显式配置、持久化/故障注入）。
3. `python tools/check_architecture.py`、`generate_contracts --check`、`check_generated_artifacts --check`、tools unittest。
4. 真实 HTTP 400 `journal-cursor-invalid` / 409 `journal-epoch-mismatch` 端到端；SSE capacity=4 丢帧恢复与 ACK 前缀交错；多页 1/257/1000 与 epoch 替换；恢复 5xx/取消/timeout；drop 覆盖。
5. 真实 WebGPU 设备丢失 600s + GPU budget fail-fast/circuit-breaker 探针；Oxc ON/OFF 生产等价；生产 bundle 浏览器 E2E（默认 1 FAB + 显式多 FAB 配置）。
6. `scripts/verify.ps1` 全量 exit 0，绑定新 commit SHA 与原始日志（`final-verify.json`）。

## 6. 已知风险/限制

1. 静态阶段未编译：跨 owner 接口（Effect 类型、既有 fixture）需在验证阶段用 typecheck/lint 收口。
2. R3-02 跨 generation cover 防回退依赖 FabRuntime 只让当前 recovery generation 调用；transport 只能防同 epoch 回退。
3. 无 projection 的自定义 workflow 不 ACK（生产 XState 不受影响）；跨范围 fixture 无 `lastEventId` 的 SSE 帧会 Dirty 不 ACK，需验证阶段补 id。
4. R3-06 终止后同 generation 剩余订阅不会自动重启轮询（需一次 retain 周期），按产品预期需验证阶段确认。
5. R3-10 产品决策为当前默认 1 FAB、架构支持 1–32；多 FAB 浏览器/聚合行为需显式配置验证。
6. 文档/测试 fixture 与源码在前一轮验证阶段已被部分改写；本轮按要求未运行任何测试，因此不存在“本轮测试通过”的结论。
