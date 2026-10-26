# 命令事件桥（Command Event Bridge）

- 版本：V2.1 / 2026-10-27
- 状态：**SPECIFIED，未实现**（Decision accepted / implementation pending）
- 依据：[ADR-0010](adr/0010-command-event-bridge.md)；总览见 [架构基线](architecture.md)；恢复细节见 [命令核对](command-reconciliation.md)；上层协议见 [实时协议](realtime-protocol.md)；装配见 [FAB 运行时](fab-runtime.md)
- 当前实现：没有 WebSocket、没有桥、没有 XState；设备状态仍走 SSE -> Redux（ADR-0008）。本文档是目标设计
- 所有门禁均为 **SPECIFIED / NOT RUN**，不提供通过证据

## 1. 定位

CommandEventBridge 是 Application 协调层（`application/coordination`）的唯一命令结果协调器：

- **上游**：实时基础设施暴露的 `CommandEventSource`（只读 Observable）。
- **下游**：`CommandWorkflowRegistry` 返回的 `CommandWorkflow` 实现（当前由 XState v6 适配器实现）。
- **职责**：按 FAB 过滤、按命令身份关联、按 revision 去重、调用工作流接口、缺失 actor 时进入恢复、生命周期管理。
- **不是**：HTTP 客户端、实时传输、状态容器、UI 层、XState actor（这些各有归属）。

## 2. 公共契约（唯一权威位置：`application/contracts`）

```ts
// application/contracts/CommandEvents.ts
import type { Observable } from 'rxjs';

export type CommandOutcome =
  | 'accepted'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface CommandResultEvent {
  readonly fabId: string;
  readonly commandId: string;
  readonly revision: number;
  readonly outcome: CommandOutcome;
  /** ISO-8601；仅展示/审计，不参与排序或去重 */
  readonly occurredAt: string;
}

export interface CommandEventSource {
  readonly commandResult$: Observable<CommandResultEvent>;
}
```

```ts
// application/contracts/CommandWorkflow.ts
import type { CommandResultEvent } from './CommandEvents';

export interface CommandWorkflow {
  receive(event: CommandResultEvent): void;
  reconcile(commandId: string): Promise<void>;
  dispose(): void;
}

export interface CommandWorkflowRegistry {
  get(fabId: string, commandId: string): CommandWorkflow | undefined;
}
```

契约规则：

1. **`application/contracts` 是唯一权威定义**。`workflows/contracts` 只允许 XState 内部契约（机器 context/event 等），不得复制 `CommandWorkflow`/`CommandResultEvent`（G-03）。
2. 契约版本无关：不 import WebSocket 帧类型、不 import XState、不 import Query/React；允许 RxJS 类型（`Observable`）。
3. 命令身份是复合身份 `(fabId, commandId)`；registry 查询必须同时带两者。
4. `CommandEventSource` 只读；Bridge 不得反向向实时层写消息。
5. 其他契约文件：`CommandGateway`（命令提交 HTTP 抽象，实现于 `api/mutations`/`api/endpoints`）、`RealtimeGateway`（连接/订阅抽象，实现于 `realtime`）。它们同样只暴露接口与类型。

## 3. 组件协作

```text
realtime/transport (WebSocketClient)
        |
        v
realtime/protocol (MessageDecoder, SequenceTracker)
        |
        v
realtime/streams (EventRouter -> CommandResultStream)   [不知道 XState]
        |
        v  Observable<CommandResultEvent>
application/coordination/CommandEventBridge
        |  filter(fabId) -> correlate((fabId,commandId)) -> dedupe(revision)
        v
application/contracts/CommandWorkflowRegistry.get(fabId, commandId)
        |
        v
workflows/equipment/XStateCommandWorkflowAdapter -> equipmentCommand.machine.ts (XState v6)
        |
        v
CommandReconciler（缺失 actor/断线时，按后端权威状态核对）

runtime/FabRuntime 负责把上面这些按 FAB 装配与销毁
```

## 4. Bridge 处理流程

### 4.1 生命周期

1. `start()`：订阅 `commandResultSource.commandResult$`，保存 `Subscription`。
2. 事件到达后按顺序执行（同步/受控队列，避免并发乱序）：
   1. **FAB 过滤**：事件 `fabId` 不是当前 Runtime 负责的 FAB -> 忽略（属于其他 Runtime 或全局告警）；记录诊断。
   2. **身份校验**：`commandId` 为空/非法 -> 协议错误处理，不进入恢复队列。
   3. **关联**：在 `CommandCorrelationRegistry` 中查找/建立 `(fabId, commandId)` 记录（含提交请求身份、幂等键、首次到达时间、最后 revision）。
   4. **去重/版本**：比较 `revision`；重复或更旧 -> 不调用工作流，记录计数；更新最新 revision。
   5. **分发**：`registry.get(fabId, commandId)`；存在 -> `workflow.receive(event)`；不存在 -> `CommandEventRecovery` 记录 + 有界 pending queue。
   6. **异常隔离**：单个 workflow.receive 抛错不得中断订阅；记录错误并进入诊断/核对，不得静默吞掉。
3. `stop()`/`dispose()`：取消订阅；按约定处理 pending（保留给恢复或按策略清理，详见 [命令核对](command-reconciliation.md)）；清空关联记录中的非必要字段；dispose 后不得再调用工作流。

### 4.2 并发与顺序

- 同一 `(fabId, commandId)` 的事件必须串行处理；不同命令可并行。
- 排序与去重只看 `revision`；`occurredAt` 不参与（时钟偏移会导致错误排序）。
- revision 缺口语义：Bridge 只保证“不倒退”；缺口的补全由恢复/权威查询完成（CE-03/CE-05），不在实时层猜测。

### 4.3 输出

Bridge 不直接写 Query 缓存、不 dispatch Redux、不 setState。工作流状态由 XState 拥有；页面展示通过 Query 权威状态 + 组件提交态（见 [状态管理](state-management.md) 第 5 节），具体只读暴露方式在 M4 决定（OPEN-V21-13）。

## 5. 命令身份与关联

| 概念 | 定义 | 用途 |
|---|---|---|
| 命令身份 | `(fabId, commandId)` | 工作流查找、关联记录、恢复、隔离 |
| 幂等键 | 提交请求携带的 idempotency key（沿用现有 API 风格） | 提交重试去重；与 commandId 关联（CE-04） |
| revision | 同一命令内单调递增版本 | 去重、排序、旧版本拒绝 |
| outcome | 后端确认的 accepted/executing/succeeded/failed/cancelled | 工作流状态推进 |
| 提交待定记录 | HTTP 提交已发出、commandId 尚未拿到时的占位记录 | 处理“确认先于 HTTP 响应”（CE-04） |

`CommandCorrelationRegistry` 至少保存：复合身份、幂等键、最近 revision、是否已终态、创建/更新时间、恢复状态。容量有界，终态记录有保留策略（M3 定义）。

## 6. 去重/版本规则

| 到达事件 | Bridge 行为 | 是否调用工作流 |
|---|---|---|
| 合法、revision > 当前 | 应用；更新当前 revision | 是 |
| revision == 当前 | 判定重复；计数；不重复应用（CE-02） | 否 |
| revision < 当前 | 判定旧版本；拒绝回退；计数/诊断（CE-03） | 否 |
| revision 跳跃（gap） | 不猜测缺失状态；保留事件，触发核对（CE-05） | 视工作流是否已有更高 revision：否/核对 |
| 未知 commandId（无 actor） | 写恢复记录 + 有界 pending queue | 否（等待恢复） |
| 未知 outcome/非法字段 | 协议错误；不进入业务 | 否 |
| fabId 不匹配当前 Runtime | 忽略（其他 FAB/全局流） | 否 |

**注意**：`EventRouter` 不得做上述业务判断；它的职责只是分发（[实时协议](realtime-protocol.md) 第 5.2 节）。

## 7. 缺失 actor / 断线恢复（摘要）

1. 记录 `CommandEventRecovery`：事件、复合身份、到达时间、尝试次数、来源。
2. 进入有界 pending queue；终态结果优先保留；溢出触发核对/告警，不静默丢弃。
3. actor 可用或页面重新挂载后调用 `workflow.reconcile(commandId)`；核对优先使用后端权威状态查询。
4. 与实时流旧事件冲突时，以后端权威状态为准，记录差异。
5. 持久化恢复是后端责任；前端不承诺跨浏览器会话恢复。

详见 [命令核对](command-reconciliation.md)。

## 8. 生产场景与设计覆盖

| 场景 | 设计控制 | 门禁 |
|---|---|---|
| WS 确认先于 HTTP 提交响应 | 提交待定记录 + 幂等键关联；响应补全身份后再分发 | CE-04 |
| 重复推送 | revision 相等 -> 去重 | CE-02 |
| 乱序事件 | revision 单调；旧版本拒绝 | CE-03 |
| actor 未创建/页面卸载 | 恢复记录 + 有界队列 + reconcile | CE-05 |
| 同一 commandId 跨 FAB | 复合身份 + per-FAB registry | CE-07 |
| 长断线 | 重连后权威查询 + 新流订阅 | CE-06 |
| 生命周期清理 | Runtime dispose 取消订阅、停止 actor、清空 pending | CE-08 |
| 未知消息/版本 | 协议层拒绝/重同步 | 协议测试 |
| 单 FAB 故障 | Runtime 错误隔离；不拖垮其他 FAB | CE-07/CE-08 |

## 9. 必测门禁 CE-01..CE-08 细则

> 位置（计划）：CE-01..05、08 在 `web_app/tests/integration/command-event-bridge.test.ts`；CE-06、07 在 `web_app/tests/contract/command-workflow.test.ts` 与 `command-recovery.test.ts`。全部 **SPECIFIED / NOT RUN**。前置：依赖（RxJS/XState/Router 相关）与测试环境未安装；真实后端 WebSocket 不存在，集成测试用假 `CommandEventSource`。

### CE-01 正常派发

- **Given**：假 `CommandEventSource`；一个注册在 `(FAB-A, cmd-1)` 的记录型 `CommandWorkflow`。
- **When**：依次发出 revision 1 `accepted`、revision 2 `executing`、revision 3 `succeeded`。
- **Then**：`receive` 按序调用 3 次；每次 `fabId/commandId/outcome` 正确；无恢复记录；无重复调用。
- **断言点**：调用序列 = [accepted, executing, succeeded]；调用次数 = 3。
- **状态**：SPECIFIED / NOT RUN。

### CE-02 重复 revision 被过滤

- **Given**：工作流已收到 revision 2；同一事件再推一次（相同 fabId/commandId/revision/outcome）。
- **When**：Bridge 处理重复事件。
- **Then**：`receive` 不再被调用；工作流状态与投影不变；重复计数 +1；无错误抛出。
- **断言点**：调用次数仍为 1；最新 revision = 2。
- **状态**：SPECIFIED / NOT RUN。

### CE-03 乱序事件不导致状态回退

- **Given**：工作流已收到 revision 3 `executing`。
- **When**：迟到的 revision 2 `accepted` 到达（乱序）。
- **Then**：Bridge 拒绝回退；不调用 `receive`；状态保持 revision 3；记录诊断；不把 `occurredAt` 当作排序依据。
- **断言点**：最新 revision = 3；工作流状态不变；无 `accepted` 回放。
- **状态**：SPECIFIED / NOT RUN。

### CE-04 确认先于 HTTP 响应仍能关联

- **Given**：用户提交命令，`CommandGateway` 的 HTTP 提交尚未返回（commandId 未确定）；Bridge 已建立以幂等键为锚的提交待定记录；实时源先推来 `(FAB-A, cmd-1)` `succeeded`。
- **When**：随后 HTTP 响应返回 commandId = cmd-1（与幂等键关联）。
- **Then**：待定记录补全身份；`succeeded` 被正确分发一次；不产生“未知命令”丢弃；无重复终态；恢复记录被清理或标记已关联。
- **断言点**：工作流收到 `succeeded` 一次；未知命令计数 0；HTTP 与 WS 身份一致。
- **状态**：SPECIFIED / NOT RUN。

### CE-05 actor 缺失时通过核对恢复

- **Given**：命令结果先于 actor 创建到达，registry 返回 `undefined`；后端权威状态查询（mock）返回该命令为 `succeeded`。
- **When**：Bridge 记录恢复项并暂存；随后 actor 创建并调用 `reconcile(commandId)`。
- **Then**：reconcile 更新工作流到权威终态；事件不丢失；pending queue 在容量内；重复恢复幂等。
- **断言点**：恢复记录状态从 pending -> reconciled；工作流最终状态 = succeeded；无重复终态动作。
- **状态**：SPECIFIED / NOT RUN。阻塞：后端权威查询端点不存在（OPEN-V21-07），测试需 mock。

### CE-06 重连后通过后端权威查询收敛

- **Given**：连接断开期间命令到达终态但结果未收到；重连后新流开始。
- **When**：对进行中命令执行 reconcile（后端 mock 返回权威 `failed`）；同时旧流迟到事件被新 stream 身份过滤。
- **Then**：工作流收敛到 `failed`；旧事件不覆盖；不重复终态；UI 查询权威状态一致。
- **断言点**：最终状态 = failed；应用旧事件次数 = 0；reconcile 调用 1 次。
- **状态**：SPECIFIED / NOT RUN。依赖后端权威查询（OPEN-V21-07）。

### CE-07 三个 FAB 相同 commandId 按复合身份隔离

- **Given**：FAB-A/FAB-B/FAB-C 的 registry 各自注册 `commandId = "cmd-1"` 的工作流；三个假源分别发不同结果（A: succeeded，B: failed，C: executing）。
- **When**：Bridge/Runtime 按 FAB 分别处理。
- **Then**：每个工作流只收到本 FAB 的事件；A/B/C 状态独立；Query key（若涉及）也包含 `fabId`；销毁 A 不影响 B/C。
- **断言点**：A=succeeded、B=failed、C=executing；交叉调用 0 次。
- **状态**：SPECIFIED / NOT RUN。依赖多 Runtime/多 FAB 测试床。

### CE-08 FAB 运行时关闭后取消订阅、停止 actor、不再回调

- **Given**：一个 `FabRuntime` 已 start，Bridge 订阅了假源，工作流 actor 运行中。
- **When**：调用 runtime `dispose()`；随后假源继续发出事件。
- **Then**：订阅被取消（源 observer 数量归零）；工作流 `dispose` 被调用；之后再无 `receive` 回调；RuntimeRegistry 移除该实例；pending/关联记录按策略清理且不泄漏。
- **断言点**：dispose 后源发出的事件不产生任何 receive；subscription.closed = true；registry 无该 FAB。
- **状态**：SPECIFIED / NOT RUN。

## 10. XState v6 实现结构（内部）

| 文件 | 内容 | 说明 |
|---|---|---|
| `equipmentCommand.machine.ts` | 状态机定义（idle/提交中/accepted/executing/terminal；失败/取消/重试边界） | 不含网络/React；纯状态逻辑 |
| `equipmentCommand.logic.ts` | actor 输入、提交、核对调用的业务逻辑 | 依赖 `CommandGateway` 等契约 |
| `CommandReconciler` | 缺口/缺失 actor/断线后的核对 | 通过 `reconcile(commandId)` 暴露 |
| `XStateCommandWorkflowAdapter` | 实现 `CommandWorkflow`；包住 actor 生命周期 | 唯一对外实现，只有 `runtime` import |

约束：

- 状态机不得直接 import `realtime`/WebSocket；不得写 Query 缓存。
- actor 只通过 `receive` 接收后端结果；通过 `reconcile` 处理恢复。
- 机器/适配器对上层不可见；外部只能拿到 `CommandWorkflow` 接口（ARCH-08）。
- XState v6 的具体版本与 API 在 M4 核实并锁文件记录（OPEN-V21-08）。

## 11. 测试假源与证据策略

```ts
// 测试用假源（示意）：不得成为生产代码
const subject = new Subject<CommandResultEvent>();
const source: CommandEventSource = { commandResult$: subject.asObservable() };
```

- 假源只用于结构/契约/竞态验证；CE-04/CE-06 的真实链路必须有后端服务参与，不能用假源宣称生产验收。
- 记录型 `CommandWorkflow` 用于断言调用序列；真实适配器的契约测试另测。
- 测试不得依赖 `occurredAt` 排序；需要顺序时用 revision。
- 测试位置与框架前置见 [架构基线](architecture.md) 第 12 节。

## 12. 反模式与评审清单

禁止：

- ❌ Bridge 里直接 import `workflows/equipment` 或 `xstate`（应只通过 `CommandWorkflowRegistry` 契约）。
- ❌ `EventRouter` 按重复/过期丢弃业务消息。
- ❌ 在 Bridge 内写 Query 缓存/Redux/Zustand。
- ❌ 用 `occurredAt` 排序或去重。
- ❌ 缺少 actor 时直接 return（静默丢弃）。
- ❌ 同一个 commandId 只按 commandId 查 registry（忽略 fabId）。
- ❌ dispose 后仍保留订阅或 actor。
- ❌ 用假源测试结果宣称真实实时链路已验收。

评审清单：

1. 契约是否只在 `application/contracts` 定义一份？
2. 关联/去重/恢复是否覆盖 CE-01..08 的每个场景？
3. registry 查询是否始终带 `fabId`？
4. 恢复队列是否有界？溢出策略是否明确？
5. dispose 是否关闭所有订阅并停止 actor？
6. 是否引入了对实时层/React/Query 的反向依赖？

## 13. 开放问题

见 [架构基线](architecture.md) 第 14 节：OPEN-V21-06（流协议）、OPEN-V21-07（权威查询）、OPEN-V21-08（XState 版本/actor 粒度）、OPEN-V21-09（恢复记录生命周期）、OPEN-V21-10（CommandGateway 契约）、OPEN-V21-13（工作流状态只读暴露）。
