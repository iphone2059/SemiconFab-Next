# FAB 运行时（Fab Runtime）

- 版本：V2.1 / 2026-10-27
- 状态：**已实现并接入产品（模拟后端命令 SSE/HTTP）**（implemented / simulated backend）
- 依据：[ADR-0010](adr/0010-command-event-bridge.md)；桥见 [命令事件桥](command-event-bridge.md)；恢复见 [命令核对](command-reconciliation.md)；协议见 [实时协议](realtime-protocol.md)
- 当前实现：`web_app/src/runtime/` 已有 FabRuntime/Factory/Registry/LifecycleCoordinator；RuntimeBootstrap 按 sites 为每个 FAB 装配，命令源为后端命令 SSE（`SseCommandEventSource`），gateway 为权威 HTTP 查询；`CommandConsole` 提交并通过 `useCommandProjection` 只读展示。无 EventSource/Worker 的测试环境回退空源 seam。

## 1. 定位

FabRuntime 是**唯一装配层**（ARCH-09）：把“实时事件源 + CommandEventBridge + CommandWorkflowRegistry + 工作流实现”按 FAB 组装成一个可启动/停止/销毁的运行时。

它**不是**：

- 不是服务端缓存（Query 负责，应用级单例 + fabId key）；
- 不是 UI 状态容器（Zustand/组件负责）；
- 不是命令状态机本身（XState 工作流负责，藏在 `CommandWorkflow` 后）；
- 不是渲染器（Babylon Lite 渲染生命周期由渲染层管理，见 [渲染管线](rendering.md)）。

## 2. 组件与职责

| 组件 | 职责 | 关键 API | 不得做 |
|---|---|---|---|
| `FabRuntime` | 单个 FAB 的源/桥/registry/工作流实例与运行状态 | `start()`、`stop()`、`dispose()`、`status()` | 创建全局 QueryClient、渲染 3D、操作 DOM |
| `FabRuntimeFactory` | 按 FAB 配置构造 Runtime；注入实时源工厂、`CommandGateway`、工作流工厂、诊断 sink | `create(fabId, deps)` | 单例隐式状态、跨 FAB 共享 actor |
| `FabRuntimeRegistry` | 按 `fabId` 管理 Runtime 实例；保证 get/ensure 幂等；提供 disposeAll | `get(fabId)`、`ensure(fabId)`、`dispose(fabId)`、`disposeAll()` | 把不存在的 FAB 自动补成共享实例 |
| `FabLifecycleCoordinator` | 启动/停止/销毁顺序、错误隔离、超时、重试/降级策略 | `start(runtime)`、`dispose(runtime)`、`onError` | 改变工作流业务状态 |

### 2.1 运行状态

| 状态 | 含义 | 允许的转换 |
|---|---|---|
| `idle` | 已创建未启动 | -> starting |
| `starting` | 订阅中/工作流准备中 | -> running / degraded / failed |
| `running` | 正常接收与分发 | -> stopping / degraded |
| `degraded` | 部分依赖不可用（如实时断线、恢复未完成） | -> running / stopping |
| `stopping` | 正在取消订阅/停止 actor | -> stopped |
| `stopped` | 已停止但可重新 start（若策略允许） | -> starting / disposed |
| `failed` | 启动失败且无法自动恢复 | -> disposing |
| `disposed` | 终态；不得再回调 | 无 |

状态由 Runtime 暴露只读快照给 Provider/诊断，不写入 Query/Zustand。

## 3. 装配与销毁顺序

```text
create(fabId, deps):
  1. 构造 CommandCorrelationRegistry / CommandEventRecovery（per FAB，空）
  2. 构造 CommandWorkflowRegistry（per FAB，空）
  3. 构造 CommandEventBridge(source, registry, recovery)   // 此时不订阅
  4. 构造工作流工厂（XStateCommandWorkflowAdapter），按需创建 actor
  5. 返回 FabRuntime(idle)

start():
  1. 订阅 CommandEventSource.commandResult$
  2. Bridge 进入 running；准备接收事件
  3. 对已知进行中命令安排 reconcile（如有）
  4. 状态 running（实时源异常则 degraded）

dispose():
  1. 状态 stopping：Bridge 取消订阅（RxJS subscription.unsubscribe）
  2. 逐个 dispose 工作流 actor（`CommandWorkflow.dispose`）
  3. 清空 pending/关联记录（按策略；不得泄漏到下一个 FAB）
  4. 移除诊断 sink、释放引用
  5. 状态 disposed；之后任何源事件不得再进入业务
```

顺序原则：**先停止入口（订阅），再停止业务（actor），最后清理记录**。这样 dispose 期间到达的消息不会被半处理。启动失败必须回滚已创建的订阅，避免泄漏。

## 4. 三 FAB 隔离

| 规则 | 说明 |
|---|---|
| 独立实例 | 每个 `fabId` 一个 FabRuntime；registry 不得把两个 FAB 映射到同一实例 |
| 独立事件源 | 每个 Runtime 只订阅本 FAB 作用域的流；跨 FAB 聚合由独立只读视图处理 |
| 独立桥/registry/recovery | 关联、去重、恢复记录均按 `fabId` 隔离 |
| 复合身份 | 工作流查找与缓存 key 均为 `(fabId, commandId)` |
| Query 边界 | QueryClient 应用级共享，但所有 FAB 相关 key 含 `fabId`（RQ-04） |
| 故障隔离 | 一个 FAB 启动失败/degraded 不影响其他 Runtime 的 running 状态 |
| 销毁隔离 | `dispose(A)` 只清理 A 的订阅/actor/记录（CE-08 扩展） |

当前部署默认 1 个 FAB；架构支持 `Fab:FabCount` 1..32 个相互独立、完整配置的 FAB。前端 Runtime/遥测/设备状态/UI 按 FAB 数据驱动并使用复合身份 `(siteId,fabId)`；121 台设备布局数据在 `src/domain/fab-layout.ts`，每 FAB 的实例标识以 FAB code 为前缀（R3-10）。跨 FAB 隔离由显式多 FAB 配置的集成测试与多 FAB Run 测试覆盖。

## 5. React 集成

- `app/providers/RuntimeBootstrap` 在 `AppProviders` 内按 sites 文档为每个 FAB 创建 `FabRuntime`，`RuntimeProvider` 暴露只读 registry（位于 `QueryProvider` 之内、`RouterProvider` 之外；见 [架构基线](architecture.md) §5.4）。
- 页面通过 `useFabRuntime(fabId)` 获取运行时状态/句柄；**不得**在组件内 `new FabRuntime` 或直接订阅 WebSocket。
- 页面卸载只解除 UI 订阅/停止展示，不自动 dispose Runtime；Runtime 生命周期由应用/FAB 会话管理（避免卸载期间丢失命令结果）。
- FAB 切换：按策略停止/保留旧 FAB Runtime；切换页面不得把 A 的 actor/恢复记录带进 B。
- 登出/应用销毁：`disposeAll()`，确保取消所有订阅与 actor。
- React `StrictMode` 开发态会重复挂载：`ensure(fabId)` 必须幂等；不得因双重 effect 创建两份运行时或双重订阅（需测试）。
- 错误边界：Runtime 启动失败展示可恢复错误；不阻塞其他路由。

## 6. 生命周期矩阵

| 事件 | Runtime 行为 | 说明 |
|---|---|---|
| 应用启动 | `RuntimeBootstrap` 按 sites 文档为每个 FAB 创建 Runtime | 当前默认 1 FAB，前端保留按 FAB 数据驱动的装配 |
| 路由进入 FAB 页面 | `ensure(fabId)` -> start（若未运行） | 页面不直接装配 |
| 页面卸载 | 仅解除 UI 订阅；Runtime 继续 | 命令结果不丢 |
| 切换 FAB | 新 FAB ensure；旧 FAB 按策略保留或 stop | 隔离优先 |
| WebSocket 断线 | Runtime 进入 degraded；重连后恢复 | 不伪造状态 |
| 认证失效/登出 | disposeAll；清理敏感恢复记录 | 安全 |
| HMR（开发） | 显式 dispose 旧实例，避免重复订阅 | 开发体验/泄漏 |
| 测试 | 每个测试新建 Registry，结束后 disposeAll | 无跨测试污染 |

## 7. 与 Router/Query 的边界

- Router loader **不创建** Runtime，也不直接访问 Bridge/actor；Runtime 通过 Provider 提供给页面。
- Query 负责所有 HTTP 服务端数据；Runtime 只负责命令/实时链路。命令权威状态经 `CommandGateway`（`api/transport/HttpCommandGateway.ts`，`GET /api/v1/commands/{id}`）读取，恢复由 `CommandReconciler` 调用同一 gateway（见 [命令核对](command-reconciliation.md)）；当前没有也不应新增独立的命令 Query 模块。
- Runtime 不写 Query 缓存；Busy/进行中状态不进入 Query。
- 高频遥测不经过 Runtime 的业务链路；Telemetry 走 Worker/缓冲（[渲染管线](rendering.md)）；设备槽位/FabToolState 投影在纯函数 `domain/equipment/tool-state-projection.ts`，Runtime 不做投影。

## 8. 当前实现 vs 目标（差距）

| 方面 | 当前事实 | 目标 | 状态 |
|---|---|---|---|
| Runtime | `FabRuntime`/Factory/Registry/Lifecycle 已实现，RuntimeBootstrap 按 sites 装配 | `runtime` 四件套 | PASS |
| FAB 数量 | 当前部署默认 1 个 FAB；架构支持 `Fab:FabCount` 1–32 个独立 FAB，前端按 FAB 数据驱动 | 多 FAB 隔离与复合身份 | 多 FAB 身份/隔离/聚合由显式配置验收（Round 3 验证阶段） |
| 实时源 | 后端命令 SSE（`SseCommandEventSource`）+ 权威 HTTP gateway；测试环境回退空源 seam | WebSocket + typed stream（经 Runtime 注入） | 部分（HTTP/SSE 模拟链路） |
| 生命周期 | Runtime/Provider 统一管理；页面只解除 UI 订阅 | Runtime/Provider 统一管理 | PASS |
| 清理测试 | `tests/integration/fab-runtime.test.ts`、`tests/integration/runtime-bootstrap.test.tsx` 覆盖 dispose/缺口核对/StrictMode 幂等 | CE-08；StrictMode 幂等测试 | PASS |

## 9. 测试计划

| 测试 | 内容 | 位置（计划） | 状态 |
|---|---|---|---|
| CE-08 | dispose 取消订阅、停止 actor、无后续回调 | `web_app/tests/integration/command-event-bridge.test.ts`、`tests/integration/fab-runtime.test.ts` | PASS |
| CE-07 | 三个 FAB 相同 commandId 隔离；dispose(A) 不影响 B/C | `web_app/tests/integration/fab-runtime.test.ts` | PASS |
| StrictMode 幂等 | 双重挂载不重复订阅/不双份 actor | `tests/integration/runtime-bootstrap.test.tsx` | PASS |
| 错误隔离 | 一个 FAB start 失败不影响其他 | `tests/integration/fab-runtime.test.ts` | PASS |

单元/契约测试使用假 `CommandEventSource`（RxJS Subject）与记录型工作流；产品接线由后端模拟 HTTP/SSE 链路 + `RuntimeBootstrap` 集成测试覆盖。生产 WebSocket 传输仍不存在，因此真实生产链路的竞态验收仍需后端实现。

## 10. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| Runtime 生命周期归属不清 | 泄漏/丢结果 | OPEN-V21-11 明确：应用会话级、Provider 管理 |
| 三 FAB 只在测试床 | 产品风险 | 产品范围决策前不宣称支持；复合身份先落地 |
| StrictMode/双重订阅 | 重复处理命令 | 幂等 ensure + dispose 测试 |
| 启动失败未回滚 | 订阅泄漏 | Coordinator 统一 try/catch/回滚顺序 |
| 认证/权限变化 | 越权数据 | 订阅时按权限过滤；登出 disposeAll |

开放问题见 [架构基线](architecture.md) 第 14 节：OPEN-V21-11（实例化时机/页面卸载语义）、OPEN-V21-07（权威查询）、OPEN-V21-06（实时协议）。

## 11. Round 4 修订（当前事实优先）

本节记录 2026-10-30 Round 4 源码整改后的 FabRuntime 行为；与本文前文历史描述冲突处，以本节与源码/ADR-010 §7 为准。

- 恢复状态机：`Healthy | Dirty | Recovering | WaitingRetry | Unrecoverable | Unavailable | Degraded`。`Unavailable` = 无恢复权威（gateway 缺失或 source 不可用）的 display-only；`Degraded` = 恢复权威可用但实时 transport 不可用，HTTP 可收敛但不得 Healthy。
- `CommandRecoveryState` 新增 `realtimeAvailability: 'ready' | 'unavailable'`，与 `availability`（恢复权威）分离。
- Recovery pass 顺序：apply authoritative records（`receiveAuthoritative`）→ post-snapshot scheduler batch（逐命令结果）→ 全部收敛后才 `source.cover(watermark, kind)` → 重置 attempts/active request → Healthy/Degraded。任何 batch 失败使 pass 进入有界退避；不允许“失败后 Healthy”。
- `trackCommand` 增加 active admission：超过 `maxActiveCommands`（默认 64，镜像后端）抛 `ActiveCommandCapacityError`，不创建 workflow/Scope/actor；authoritative 恢复可镜像后端已有状态。
- 所有 stream consumer（commandResults + gaps/reconnected/transportFailures/connectionStatus/dirty）都有 owner Scope 内的 exit/defect observer；意外终止有界重启并触发权威恢复，超限 Unrecoverable。
- replay-gap 一律 List 恢复（R4-04）；reconnect/transport-failure 从 acknowledged cursor 恢复，无安全 cursor 时 List。
- Round 4 验证事实：前端全量 155 文件 / 908 tests PASS、typecheck/lint/build PASS；后端 226 tests PASS。浏览器 E2E/GPU/Compiler 等价未运行，见 `architecture/17-round4-remediation-record.md` §5。


## 12. Round 5 修订（已实施，2026-10-30）

Round 5 源码整改已提交 `4c8f0c1`：恢复使用完整 all List；快照前存在而快照中缺失的活动命令进入 `expired-unresolved`，不制造最终业务结果。规范见 `architecture/18-round5-remediation-specification.md`。

## 13. Round 5.1 修订（2026-10-30，当前事实优先）

状态：契约/源码整改（Round 5.1）；规范见 `architecture/19-round5.1-remediation-specification.md` §2、§3、§7–§9。本节优先于本文前文与 §11 中冲突的旧描述。

### 13.1 Healthy 的完整前置条件（12 条，缺一不可）

FabRuntime 只有在**当前 recovery generation** 同时满足以下全部条件时才能进入 `Healthy`；任何一条不满足都不得报告 Healthy（`Degraded`/`Dirty`/`WaitingRetry`/`Unrecoverable`）：

1. 当前 recovery generation 仍有效（`isRecoveryCurrent(g)`：未 dispose、仍 started、`g === recoveryGeneration`）；
2. 权威 List/Journal 快照已完整应用（list：完整 `listFabCommands(...,'all')` 的每条记录经 `receiveAuthoritative` 被 applied/stale-covered；journal：分页到 `latestSequence` 且 epoch/序号/保留窗口校验通过）；
3. post-snapshot 的 scheduler 对账批次已完成且每个仍活动命令收敛（无 failed/timed-out/cancelled/not-found，`batchFailure === undefined`）；
4. 不存在未覆盖的 DropIntent（`pendingDrops` 为空，或所有 generation `<= snapshot.dropBarrier`；`overflowDropGeneration` 同样被覆盖）；
5. 不存在待处理的 Recovery 请求（`pendingRecovery === undefined` 且 `recoveryPending === false`）；
6. `CommandEventBridge.pendingCount === 0`（held events + conflict records）；
7. 不存在未解决的 event conflict（`bridge.conflictCount === 0`）；
8. transport ACK cover 明确返回 `status === 'covered'`；
9. cover 之后 `source.cursors.pendingAcknowledgements === 0`（必填 number；缺失/undefined 视为失败，绝不当作 0）；
10. `realtimeAvailability === 'ready'`；
11. `connectionStatus === 'open'`（**严格条件**：idle-closed 的运行时不 Healthy，见 §13.3/§13.4；不得为了满足本条件强制打开连接）；
12. 当前 generation 没有被新 Dirty/Conflict/Rejection 事件作废：cover 与 Healthy 提交之间不得有 async 让出点；期间出现的新事件必须置 `needsNextAuthoritativePass`、合并 list-only 恢复请求并阻止 Healthy。

要点：**HTTP 恢复成功、List 应用、actor 批次完成、ACK cover 成功是四个彼此独立的事实**，任何一个都不能替代其他条件；“cover 成功”本身永远不意味着 Healthy。

屏障失败语义（`handleHealthyBarrierFailure`）：**正确性失败**（pending request/queued pass、bridge held/conflict、未覆盖 drop、batchFailure）合并 list-only 请求并走有界补偿 List pass；**环境失败**（`realtimeAvailability !== 'ready'` 或 `connectionStatus !== 'open'`）只置 `Degraded`、不进补偿循环，由下一次连接状态迁移重新武装一次权威 pass。任一情况都不得清理 pending ACK/ledger、不得修改 `delivered`、不得 Healthy。完整流水线与失败语义见 `command-reconciliation.md` §14。

### 13.2 expired-unresolved 语义（恢复处置，不是业务结果）

- 只有 Recovery 在应用完整权威 List 后、证明某本地仍活动的命令不在权威集合中时，才调用 `workflow.markExpiredUnresolved()`；投影为 `recoveryDisposition === 'expired-unresolved'`，保留最后已知 revision/outcome。
- **realtime 永远不能恢复它**：`receiveRealtime` 对 expired 工作流的任意 revision/outcome 都是 no-op（迟到的 `executing`/`succeeded`/`failed` 都不得复活）。
- **只有经校验的权威记录能恢复它**：`receiveAuthoritative`（revision 相等可解决/修正，更高 revision 前进，更低 revision 拒绝回滚）应用后 disposition 回到 `tracked`。
- **禁止伪造 succeeded/failed/cancelled**。expired-unresolved 对“投递/对账”而言是终态（不计入活动命令、不阻塞 Healthy、不会被无限 reconcile），但不是业务终态，UI 必须能展示“结果未知”。

### 13.3 按需 Command SSE（`lazyCommandSubscription`）

生产组合根设置 `lazyCommandSubscription: true`。命令流“需求”定义为任一成立：

1. 存在未提交的 admission reservation（`reservations.size > 0`，含 HTTP POST 未返回的窗口）；
2. 存在活动（非终态）tracked workflow；
3. 存在未解决的 held event 或 conflict（`bridge.pendingCount > 0`）。

`syncCommandSubscription()` 规则：有需求且 bridge 未启动 → `bridge.start()`；无需求且 bridge 已启动 → `bridge.stop()`（真实 transport 随后关闭 EventSource 并发布 `closed`）。调用点覆盖 start、reserveCommandAdmission 成功、reservation commit/release、createTrackedWorkflow、afterDelivery/recordTerminal、onBridgeUncorrelated/onBridgeConflict、bridge flush 与 consumer exit。

约束：

- **每个 FAB 至多一条 SSE 连接**；绝不按 workflow 建连接。
- 有其他活动 workflow 需要时不得关闭连接；终态工作流只为 UI 投影保留时不得保持连接。
- HTTP Journal/List 恢复**不需要** live SSE transport。
- `closed` 是合法空闲：不得当作 `failed`、不得触发重连风暴、不得视为 `open`；也不得为了让 Healthy 成立而强行打开/保留连接（no forced-open）。但 idle-closed **不是 Healthy**：当前无需求的 FAB 保持 `Degraded`（环境就绪条件不满足），不是失败也不是重试循环；一旦出现需求，流打开（`connecting` → `open`），`open` 迁移重新武装一次权威 pass，才可能重新进入 Healthy。
- 终态投递通过 microtask 延迟再评估（`scheduleCommandSubscriptionSync`），避免 bridge 在自己的 consumer fiber 内中断自身。

### 13.4 ConnectionStatus：`closed` 与 `failed` 的区别

- `connecting`：正在建立连接（在 factory 调用/计时器之前发布）；`open`：已建立；`reconnecting`：中断并已安排重连（含瞬时 factory throw/connect timeout）；`failed`：本环境永久不可用（无 EventSource factory，或有界打开尝试耗尽），只发布一次、之后关闭不得降级；`closed`：被主动关闭且当前没有连接（正常空闲态）。
- 初始状态：transport 未打开时为 `closed`；runtime 初始 `connectionStatus = 'closed'`（空闲，尚无连接）。
- 每个状态变化都发布到 `connectionStatus` 流（首个订阅者先看到当前状态）；不能只改本地字段。
- runtime 对状态的解释：`open` → 进入 Dirty（list-only, reconnect）；`reconnecting`/`failed` → Dirty + `Degraded`（transport 失败永远不是命令结果）；`closed` → 置 `Degraded`（除 `Unrecoverable`/`Unavailable` 外），**不得**调度恢复循环；下一次 `open` 再武装一次权威 pass。
- 永久不可用时 `availability` 保持 `unavailable`，phase 不得因普通关闭而降级为 Healthy。

### 13.5 独立 TTL 与两个 sweep 定时器

- `FabRuntimeRetentionOptions.correlationTerminalTtlMs`（默认 300000，`min: 0`）独立于 `resolvedWorkflowTtlMs`；传给 `CommandCorrelationRegistry({ terminalTtlMs })`（保留 `maxTerminalEntries/maxEntries/now`）。
- 两个独立定时器，均由 FabRuntime 拥有、start() 启动、stop()/dispose() 清理，互不停止对方：
  - `workflowSweepTimer`：按 `resolvedWorkflowTtlMs` 逐出已解决 workflow；`resolvedAt.size === 0` 或 TTL=0 时清除且不再调度（容量上限 `enforceTerminalLimit()` 仍然生效）。
  - `correlationSweepTimer`：按 `sweepIntervalMs` 调用 `correlation.sweep()`；`correlationTerminalTtlMs === 0` 时清除且不再调度（terminal 数量/绝对容量上限仍然生效）。
- **TTL=0 语义**：只关闭本类条目的“按时间逐出”，不得关闭另一类 TTL，不得关闭容量上限，不得留下空转定时器循环。
- 当前实现不再使用单一 `sweepTimer`；没有全局定时器服务。

### 13.6 与 bridge 的冲突/未关联回调

FabRuntime 在构造时接入 `onUncorrelated` 与 `onConflict`：记录有界诊断、置 `needsNextAuthoritativePass = true`、合并 `{ listOnly: true }` 恢复请求、**不 ACK**，并在没有进行中 pass 时调度恢复（不得并行第二个恢复执行器）。详见 `command-event-bridge.md` §16 与 `command-reconciliation.md` §14.2。

### 13.7 测试与验证

- `web_app/tests/integration/fab-runtime.test.ts`：P1-01 屏障（post-snapshot 未关联事件、cover 成功但 pending ACK 仍存在）、P2-01 closed/failed 生命周期、P2-02 32 FAB 按需连接、P2-03 两个独立 TTL。
- `web_app/tests/integration/fab-runtime-batch23.test.ts`：post-snapshot 竞态与补偿 List pass。
- `web_app/tests/integration/runtime-bootstrap.test.tsx`：生产组合根 lazy 装配、无 32 条命令 SSE、卸载/销毁释放。
- 真实浏览器/多 FAB 连接行为仍属 Phase C（见 19 号规范 §12.3），不得由 fake transport 测试宣称生产验收。
