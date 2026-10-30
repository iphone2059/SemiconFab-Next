# SemiconFab Next — Round 3：先修代码、后运行测试的正确性整改规范

- 文档性质：代码修改规范 / 静态审查清单，不是修复完成证明。
- 审查对象：iphone2059/SemiconFab-Next，`main@20101b433d9861e7056ed6e58446f0cf4a8317d1`（2026-10-30 复审时的 HEAD）。
- 依据：生产源码、API 与前端协议契约、ADR-010~013、第二轮验收证据及相应测试源码。
- 本阶段要求：修改生产代码、同步协议/生成物、开展静态复核；**不运行 Vitest、dotnet test、浏览器 E2E、GPU soak、Compiler ON/OFF 或完整 verify.ps1。** 待代码静态闭环以后再独立执行验证。
- 当前操作记录：本文档只描述应当实施的变更；生成本文档期间未修改 GitHub 仓库，没有运行项目测试。
- **产品决策补充（2026-10-30，用户澄清，优先于 §11 R3-10 的默认值）：当前部署只需要 1 个 FAB；架构必须支持 1–32 个相互独立的 FAB。** 因此 SiteDirectory 默认 FAB 数为 1，显式 `Fab:FabCount` 支持多 FAB；多 FAB 身份隔离、复合 `(siteId,fabId)`、FAB-scoped 实例标识与多 FAB 测试覆盖必须保留，不得退化为单 FAB 假设。

## 0. 不可妥协的约束与正确性不变量

1. 正确性与规范性优先。允许更改前后端协议、替换不当抽象和移除旧实现；不为了减少 diff 保留错误假设。
2. 不能假装已验证。代码审查结论应标为「源码确认」「有条件风险」「待运行复现」；不把已有测试或日志误记为 Round 3 验收。
3. FAB 身份：以 (siteId, fabId) 区分运行时与资源；当前部署默认 1 个 FAB，架构必须支持 1–32 个相互独立的 FAB（`Fab:FabCount` 显式配置）。
4. Journal 游标：epoch 与 sequence 必须绑定；observed 不等于 delivered，delivered 不等于 acknowledged；恢复起点不得越过尚未成功应用或经权威快照明确覆盖的事件。
5. Journal 缺口：请求起点早于当前最早可恢复水位、跨 epoch、序列损坏或者保留窗口已清空，必须显式声明 gap 或退化为权威恢复；不得通过空响应伪造完成。
6. 分页：返回事件按 Site 序号严格递增；FAB 过滤后的结果允许稀疏；分页游标要单调且符合后端对已扫描区间的承诺。
7. 恢复状态：只有权威状态成功应用并能证明达到确认水位后，才允许 Healthy；Gateway 缺失、请求失败/超时、未终结的对账和未知 gap 均不能进入 Healthy。
8. 结构化并发：任何 FabRuntime 创建的网络请求、重试 timer、actor、SSE Stream 和 polling Fiber 必须有明确的所有者和可观察的终止路径；dispose 必须中断/清理由该 Scope 持有的工作。
9. 物理并发：FAB 的 HTTP 同时在途数 ≤4；逻辑超时后计数复位必须以网络请求真正完成或收到 abort 为前提。
10. 资源身份：ResourceManager 的 kind/version/key/policy 不能发生无声碰撞；旧 generation 的异步完成不能篡改新 generation 的状态。
11. GPU：重建预算不能取 NaN/Infinity 或非预期的非整数；耗尽预算必须受控失败并释放资源，不允许继续无界重试。
12. 保持基础技术栈：Effect 4、XState、Rust/Oxc React Compiler、Babylon Lite WebGPU-only、单层 web_app/src/<area>/<file> 不改变；不加 Babel、Zustand、TanStack Query 或 RxJS 兼容层。

## 1. 整改总表：先落实生产代码

| ID | 优先级 | 缺陷 / 风险 | 主要文件 | 需要交付的代码变化 |
|---|---|---|---|---|
| R3-01 | P0 | Journal 全空时 retention gap 可能被错误报告为成功 | `fab_app/src/EquipmentCommandService.cs`、`web_app/src/runtime/fab-runtime.ts` | 两端 retention 下界校验、明确 fallback |
| R3-02 | P0 | SSE ACK 能越过尚未被 actor 应用的早期消息 | `web_app/src/realtime/command-event-source.transport.ts`、`web_app/src/runtime/command-event-bridge.ts` | 按已应用前缀确认，而非直接 max(sequence) |
| R3-03 | P1 | FAB 过滤 Journal 的合法稀疏 Site 序号被前端误判为 hole | `web_app/src/runtime/fab-runtime.ts`、前后端契约 | 稀疏递增校验 + 服务端权威 hasGap |
| R3-04 | P1 | SSE 数据帧/dirty 控制帧解码失败时静默忽略 | `web_app/src/realtime/command-event-source.transport.ts` | 诊断 + Dirty + 权威对账 |
| R3-05 | P1 | Recovery HTTP 从裸 runPromise 启动，缺 Fiber 所有权/请求 timeout | `web_app/src/runtime/fab-runtime.ts` | RecoveryScope、fiber interrupt、超时传播 |
| R3-06 | P1 | Polling fork 拒绝回调缺 generation 检查 | `web_app/src/api/resource-manager.ts` | catch 内同一代身份校验 |
| R3-07 | P1 | 无 Gateway 时恢复仍可能成功进入 Healthy | `web_app/src/runtime/fab-runtime.ts`、`fab-runtime-factory.ts` | Gateway 显式必填或明确的离线状态协议 |
| R3-08 | P1 | Recovery 成功后对账队列丢弃可能被直接忽略 | `web_app/src/runtime/fab-runtime.ts`、scheduler | 显式 remaining-dirty / 再对账条件，避免无限循环 |
| R3-09 | P2 | GPU budget 接受无效配置 | `web_app/src/rendering/lite-backend.ts` | 严格有限安全整数验证 |
| R3-10 | P2 | 多 FAB 架构能力与默认配置语义文档化 | `fab_app/src/SiteDirectory.cs`、启动配置/示例、前端身份 | 当前部署默认 1 个 FAB；架构保持 1–32 独立 FAB、FAB-scoped 身份与显式多 FAB 测试 |
| R3-11 | P2 | 恢复缺少明确终态可见性与查询策略 | `fab-runtime.ts`、Command List API/ADR | 明确「active-only」与「终态刷新」的产品语义 |

注意：R3-01、03–07、09、10 是直接从源码导出的具体缺陷/契约冲突；R3-02、08、11 涉及跨阶段业务语义，需要按以下不变量落实，完成与否不能仅靠本轮静态审查保证。

## 2. R3-01（P0）— 全空 Journal 的保留窗口边界

### 当前缺陷与触发路径
后端 `ReadCommandJournalPage` 使用 `var hasGap = dropped > 0 || afterSequence > latest;`。若 Journal 全部清空、latest=6、firstRetained=7，客户端使用旧 afterSequence=0 时循环无元素，dropped=0、hasGap=false、nextAfterSequence=6；客户端把从未得到的 1..6 视作已恢复。

### 目标代码
后端在同一 Site lock 下先取得 first/latest，明确计算：
```csharp
var outsideRetainedWindow = afterSequence < first - 1;
var beyondLatest = afterSequence > latest;
var hasGap = outsideRetainedWindow || beyondLatest || dropped > 0;
```
所有值使用 long；处理 latest=0 / first=1 / after=0 的合法空站点，不误判 gap。afterSequence 输入范围已在 API 路由限制为非负。

前端在 runJournalRecovery 增加独立协议防御：若 cursor.sequence < page.firstRetainedSequence - 1，不接受空结果为成功，抛 RecoveryNeedsAuthority；检查 firstRetainedSequence <= latestSequence + 1、nextAfterSequence <= latestSequence 以及每页水位自洽。后端返回不自洽数据时标记协议错误/强制权威 List，而非静默继续。

特别注意：首次权威 List 本身不包含已过保留窗口的终态记录时，前端只能宣告“已恢复所有当前仍受保留协议保证的权威命令”，不能宣告历史全部可恢复；需在 ADR 与 UI 明示。

### 静态代码审查完成条件
后端 hasGap 必然覆盖 after < first-1；前端不是只靠 page.hasGap 就置 Healthy；异常通过现有 Effect Gateway 错误代数显式传播。

## 3. R3-02（P0）— ACK 必须确认已应用前缀

### 现状及危险交错
transport 的 rememberedEvents 以 (fabId,commandId,revision) 记录事件对应 Site cursor；acknowledge() 直接把 acknowledged 推进到该事件的 cursor。假设序号 10 属于尚未创建 actor 的命令 A 被 bridge hold；序号 11 属于已有 actor 的命令 B 已应用并 ACK，则 acknowledged 可推进到 11，而 A 的 10 未应用 → 断线后从 11 回放无法恢复 A。

### 目标模型
- rememberedEvents 改为有序 delivered ledger：`{epoch,sequence,eventIdentity,status: pending|applied|covered}`；业务 key 仅用于定位待确认条目。
- 只有 ledger 起点开始的连续 applied|covered 项才可出队并推进 acknowledged；后续条目已应用也不能越过仍 pending 的早期条目。
- covered 必须来自权威 Journal/List 结果；普通 EventSource 收到后来一条消息不等于早期消息已覆盖。
- Ledger 容量有界：达容量、等待命令永不建 actor、epoch 不一致 → Dirty + 权威恢复；不得驱逐最旧 pending 后继续前进隐藏缺失。
- 重连恢复点使用最后安全 ACK 前缀，而不是最高已应用序号；没有可证明前缀则 List Recovery。
- 权威恢复完成时显式通知/同步 transport safe watermark：允许跳过已由权威快照覆盖的旧 epoch/旧 sequence，不能让 transport 旧 ledger 把新游标回滚。
- 保留 CommandEventBridge 去重，但“已观察 revision”“状态已应用”“游标已安全 ACK”三者分离。

受影响：CommandEventSource 接口、CommandEventBridge.applyToWorkflow() ACK 语义、contracts/command-events.contract.ts、ADR-010。必须定义权威恢复完成时如何 cover 未应用条目。

## 4. R3-03（P1）— Site 级全局 sequence 与 FAB 过滤后的稀疏序列

### 现状
后端 `ReadCommandJournalPage(siteId,fabId,...)` 明确 FAB 过滤；序号仍是 Site 全局 sequence。两 FAB 交错时 FAB-A 收到 [1,3,5,7]。前端 fab-runtime.ts 却要求 event.sequence === expected + 1，把合法数据误判为 hole 并执行 List Recovery。matrix-2 的跨 FAB fake 还把 FAB-B 事件放进前端页面，与实际响应不同。

### 目标协议
保持“只返回当前 FAB 事件、游标按 Site sequence”的设计，统一校验：
```ts
let previousSequence = cursor.sequence;
for (const event of page.events) {
  if (event.fabId !== this.fabId) throw new RecoveryNeedsAuthority('foreign FAB event');
  if (event.sequence <= previousSequence) throw new RecoveryNeedsAuthority('non-monotonic journal event');
  if (event.sequence > page.nextAfterSequence) throw new RecoveryNeedsAuthority('event beyond next cursor');
  previousSequence = event.sequence;
}
```
还必须满足：page.epoch === cursor.epoch（跨代立即 List）；`firstRetainedSequence - 1 <= cursor.sequence <= latestSequence`；`cursor.sequence <= nextAfterSequence <= latestSequence`，未达 latest 时 nextAfterSequence 必须严格大于当前 cursor；同 epoch 每页 watermark 不得无原因回退（新写入增大合法）；后端 hasGap=true 直接权威恢复，不以 FAB 相邻 event 差值自行断言 Site journal 丢行；后端明确 nextAfterSequence 表示“服务端已覆盖扫描的 Site 区间结束位置”，不能越过本 FAB 尚未返回的记录，否则改分页算法/不透明 continuation token。

更新测试 fixture 语义（本阶段只改源码不运行）：FAB-A 只出现 1,3,5,7，不返回 FAB-B 事件；后端跨 FAB 测试与前端 fixture 使用同一契约。

## 5. R3-04（P1）— SSE 协议错误不可静默跳过

- 任何带 id 的命令数据帧解码失败，至少发布 dirty(reason='decode-error', delivered=安全前缀)，禁止 ACK；新增枚举同步前端类型与 ADR。
- 无法解析 ID 或 frame/topic 预期无法证明时，直接 listOnly：无 gapStart，迫使 FabRuntime.onDirty 使用 List。
- 服务端 dirty control 解析失败同样发布 dirty（'invalid-control-frame' 或 'decode-error'），安全降级 List；不能静默忽略。
- 控制信号自身通道若覆盖/丢失，不得只依赖可能被 sliding 替换的瞬态事件；运行时保留 sticky dirty 标志直到权威恢复水位签收。
- 诊断有界，记录最后若干错误原因与时间；不把原始异常正文或敏感 payload 写入长期日志。
- 专用命令流收到未知 topic 视为协议错误并恢复，不能无声跳过。

## 6. R3-05（P1）— Recovery 请求必须是 FabScope 的子任务

- 使用独立 RecoveryScope（FabScope 子 Scope）或 forkIn recovery fiber，保存每次恢复 generation + 当前 fiber handle。
- runRecoveryPass 不再通过无所有权 void Promise 启动网络；归一为一个显式 Effect/Scope 任务。
- Journal/List 请求统一 Effect.timeout 或 typed timeout；明确 deadline（例如 10s，最终由契约统一配置），Effect 中断信号传到 fetch。
- stop() 语义明确：暂停并中断当前恢复，还是保留到下一次 start；不得只关 retry timer 让裸请求继续。dispose() 必须停止所有恢复 fiber，cleanup 完成后 no callbacks。
- 恢复请求与 Scheduler 共享同一 FAB 物理 HTTP 预算；permit 释放顺序与中断底层 fetch 的完成信号一致。
- 取消/timeout 后旧 generation 结果不得写 projectionStore、改变 recovery phase 或触发下一轮对账。
- 永久 hung/不可中断的第三方调用作为明确协议失败，不消耗永久 permit。

实现可用 Effect.acquireRelease、Effect.forkIn、Effect.timeout、Scope.close 等既有能力，不引入全局 Promise 队列或自定义 async runtime。

## 7. R3-06（P1）— Poll Fiber 失败回调的旧代污染

成功 .then 已检查 entry.removed/polling/generation/scope，但 .catch(() => { entry.polling = false; }) 没有相同条件。目标：
```ts
.catch((cause) => {
  const stillOwner = !entry.removed && entry.polling &&
    entry.scopeGeneration === startedGeneration && entry.scope === scope;
  if (!stillOwner) return;
  entry.polling = false;
  entry.pollFiber = undefined;
  // 记录有界错误；按资源策略决定安全重试或置失败
});
```
还需审查成功 fork 后 Fiber 运行失败如何上报：不能永远 polling=true 却无活跃 poll fiber；fiber 终止应在当前 generation 内清除 owner 并按明确策略重试；generation 已变化时只释放旧 owner，禁止写新 entry。

## 8. R3-07（P1）— Recovery 缺 Gateway 时不得返回 Healthy

FabRuntimeOptions.gateway? / FabRuntimeFactoryOptions.gateway? 允许缺省；executeRecovery() 在 !gateway 时返回 undefined，但 runRecoveryPass() 不视为错误而是 Healthy（诊断 no-authority）。
建议：需要命令恢复的 FabRuntime 将 gateway 改为必填 CommandGateway，composition root 缺失时明确报错；Storybook/纯展示测试需要无 Gateway 时使用单独只读 Runtime（明确不可用状态），不能返回 Healthy。移除基于 undefined watermark 的“成功”路径：no-authority 进入 Unrecoverable/Unavailable 并提供可观察诊断。

## 9. R3-08（P1）— Recovery 成功后的补偿任务不可掩盖新 drop

onDrop 在 phase==='Recovering' || recoveryBatchRunning 时直接 return（避免无限 recovery 循环）；但需区分“drop 已由本轮权威快照覆盖”与“drop 发生在快照取得之后”：
1. 每次恢复标记 recoveryGeneration、快照水位及 drop generation。
2. 若 drop 的命令/事件已被取得的权威快照完整覆盖，记录已覆盖，不重跑。
3. 若 drop 发生在权威快照水位之后，记录 recoveryPending=true / needsNextAuthoritativePass=true，不能直接 return 并宣告 Healthy。
4. 避免无界重试：补偿轮次有预算、退避及对账进展证明；超限显式 WaitingRetry/Unrecoverable。
5. tracked 命令数超过 scheduler queue capacity 时，不能反复调度同样 128 个命令制造循环；必须分批/优先级迭代并以权威快照覆盖作为结束条件。
本项需以源码所有权和状态机不变量完成设计，不仅修改 if 条件。

## 10. R3-09（P2）— GPU 参数 fail-fast

createLiteBackend({recoveryBudget}) 直接 Math.max(1, Math.trunc(...))；NaN 原样传播、Infinity 不受限，熔断器失效。
- 程序级 options.recoveryBudget：必须 Number.isSafeInteger(v) && v >= 1 && v <= 生产最大值；否则立即抛配置异常。
- ?perf&recoveryBudget=N：只在明确验收模式接受，严格解析十进制有限安全整数；非法值保留默认并明确诊断或拒绝探针。
- 硬上限明确（例如 96），不同于测试注入更小值；不修改 WebGPU-only 与 fail-closed 行为。

## 11. R3-10（P2）— 默认 FAB 数量与多 FAB 架构（按产品决策：当前默认 1，架构支持 1–32）

当前 SiteDirectory.DefaultFabCount=1，产品要求默认 3 个完整独立 FAB（统一管理监控、预留共享设施拓扑）。改 DefaultFabCount=3；仍允许 Fab:FabCount 显式 1–32。同步开发脚本、示例配置、生成契约示例与页面默认选择逻辑；不能只改常量而保留假设唯一 FAB 的 API/业务代码。
审核 ApiHost.cs 兼容端点 /sites/{siteId}/equipment-status 使用 site.Fabs[0]：若保留应明确命名/标记弃用并避免三 FAB 聚合组件误用；若被业务当 Site 汇总，必须显式 Site 聚合契约，不能静默返回 FAB-01。其他无 FAB 参数 API 逐一明确 Site 级与 FAB 级含义。

## 12. R3-11（P2）— 终态、刷新与保留窗口语义

FabRuntime 默认 listFilter='active'，runListRecovery() 跳过 record.terminal。对“刷新后恢复所有未完成指令”是可接受明示边界；对“刷新后仍显示最近终态/确认历史”不满足产品预期。先在 ADR 明确二者之一：
- 方案 A（仅恢复活动命令）：UI 明确终态历史不受浏览器刷新恢复保证；最近终态由独立历史资源读取，不能靠命令 SSE 维护。
- 方案 B（恢复保留窗口内全部命令）：权威 List 用 all 并支持分页/上界；按 revision 恢复终态快照，与新的 actor scope 生命周期规则协调，避免终态实例无界积累。
不能在没有产品语义判定时把 active-only 当成“全量状态完整恢复”。

## 13. 不执行测试时，怎样进行代码阶段签收

代码阶段签收不是功能验收。本轮只要求静态结果：
1. 所有列出的生产文件有具体修改，代码路径逐条符合本规范；不存在通过 ignore/catch/fallback 掩盖错误的实现。
2. 前端与后端围绕 cursor、hasGap、nextAfterSequence、Error algebra、Dirty reason 定义一致；更新 Schema/DTO 与生成器源文件，而不是只手改 generated 产物。
3. API 路由、服务层、SQLite 存储的 retention/epoch/transaction 边界一一对应；并发/取消/Scope 无游离 runPromise 任务。
4. 同步受影响 ADR、架构守卫、测试 fixture 源码；可新增/调整测试源码，但本阶段不运行测试。
5. 针对每个异步回调标注 owner、generation、取消和迟到结果处理；对每个状态转移写明是否导致 Healthy/Dirty/WaitingRetry/Unrecoverable。
6. 检查 web_app/src 单层目录、Oxc Compiler、React 19、Babylon Lite WebGPU-only 等既有硬约束不被破坏。
7. 生成逐文件静态审查记录：文件、变更原因、拒绝的旧设计、保留的风险、推迟到测试阶段的验证项；不能写为所有测试通过。
8. 代码变更全部完成后才进入独立 Round 3 验证阶段：类型检查、lint、Vitest、dotnet test、真实 HTTP 400/409、双 FAB 恢复、Oxc ON/OFF、真实 WebGPU、Windows 600s soak、完整 verify。

## 14. 修改顺序与依赖图

| 批次 | 必须完成的生产代码工作 | 依赖 / 输出 |
|---|---|---|
| A | R3-01 + R3-03：统一 Journal 服务端和客户端契约 | 后端 Site cursor / FAB filter / API schema / 生成 DTO |
| B | R3-02 + R3-04：ACK 有序 ledger、坏帧 Dirty | 与 A 的恢复游标契约一致；不能再次引入跳 ACK |
| C | R3-05 + R3-07 + R3-08：Recovery Scope、gateway 必填、对账闭环 | 不能在没有权威水位时 Healthy；有界且可取消 |
| D | R3-06：资源 Poll owner 的所有异步分支 generation 检查 | 保持单 Resource 单 Poll Fiber |
| E | R3-09 + R3-10 + R3-11：GPU 参数、三 FAB、历史语义 | 不引入兼容层或产品默认退化 |
| F | 全树只读代码复审与契约/文档同步 | 不运行测试；逐条完成静态清单后交接下一阶段 |

## 15. 指定源码永久链接

所有链接锚定于 `20101b433d9861e7056ed6e58446f0cf4a8317d1`：
- EquipmentCommandService.cs:455–505
- FabRuntime journal recovery:865–923
- FabRuntime RecoveryScope:789–859
- FabRuntime fallback on missing gateway:838–844
- SSE delivered/ACK ledger:235–335
- SSE onmessage malformed handling:439–480
- CommandEventBridge ACK:120–158
- ResourceManager poll fork:190–224
- GPU recoveryBudget:28–58
- SiteDirectory default FAB count
- Round 2 已知未完成验收

交付定义：本文档是下一轮实现代理可直接执行的代码整改依据。它不宣称“所有缺陷都可被静态检索穷尽”；如果整改中发现新违反不变量的路径，应直接纳入本轮生产代码修复，不以本文清单作为改动范围上限。完成代码整改并再次静态复审后，再集中运行正式验证。