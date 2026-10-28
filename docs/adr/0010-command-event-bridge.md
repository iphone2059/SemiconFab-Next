# ADR-0010 — 实时基础设施只提供类型化流，Application 层 CommandEventBridge 协调，XState 工作流隐藏在契约之后

- 状态：已采纳（2026-10-27）；实施状态：契约/类型化流/CommandEventBridge/恢复队列、XState 工作流、FabRuntime、RuntimeBootstrap、Workbench 命令面板、后端模拟 HTTP/SSE 命令与遥测链路均已实现并完成浏览器 e2e；XState 目录强制已取消，实现位于 `runtime/commands`；WebSocket 生产传输仍未接（Status: Accepted / simulated backend wired / WebSocket pending）。2026-10-28 递归整改后的终态模块映射见文末 [Update（2026-10-28）](#update2026-10-28)。
- 取代：迁移完成后取代 [ADR-0008](0008-redux-toolkit-rtk-query.md) 中“SSE 帧直接 dispatch 进 Redux slice”的命令/实时接线方式；ADR-0008 的“Babylon 对象不进入状态容器、遥测合批”原则保留，但在 `ARCH-11` 下进一步收紧
- 关联：[ADR-0009](0009-tanstack-router-query-boundary.md)（Router/Query 边界）、[ADR-0003](0003-single-web-app.md)；细则见 [命令事件桥](../command-event-bridge.md)、[命令核对](../command-reconciliation.md)、[实时协议](../realtime-protocol.md)、[FAB 运行时](../fab-runtime.md)；基线见 [架构基线](../architecture.md)
- 决策范围：仅前端 `web_app` 的实时/命令链路。M3/M4 已按本决策实现 contracts/realtime/application coordination 与 XState v6/FabRuntime；M5a/M5c 已把 `RuntimeProvider`/RuntimeBootstrap 挂到产品树，并接入后端模拟 HTTP/SSE 命令/遥测链路；后端实时服务仍是占位模式（`fab_app -- --realtime` 退出码 2），生产 WebSocket 源尚不存在

## 背景

2026-10-27 当时的实现中，唯一的推送链路是设备状态 SSE：`twin-page.tsx` 用 `EventSource` 连接 `/api/v1/sites/{siteId}/equipment-status/stream`，帧经 `createOrderedEquipmentStatusConsumer`（`equipment-status.ts`）校验顺序后 dispatch 进 Redux 的 `twinPage` slice。没有 WebSocket 客户端、没有消息解码器、没有命令提交/回执/核对链路，也没有 XState actor。（历史记录：该 Redux 链路与 `equipment-status.ts` 均已被 M2/SQL 边界的后续整改取代，见文末 Update。）

V2.1 要引入设备命令工作流（提交、执行、成功/失败/取消、断线恢复），并保持三 FAB 隔离。如果按“基础设施直接驱动业务 actor”的方式实现，会出现三个结构性问题：

1. **依赖方向倒置**：WebSocket/解码/RxJS 路由层一旦知道 XState actor 或业务工作流，实时基础设施就无法在没有业务工作流的场景（纯遥测、告警、回放）复用；工作流也会被传输细节污染。
2. **重要结果被静默丢弃**：通用的 `EventRouter` 如果按“自己认为是重复/过期”就丢弃消息，会把“actor 尚未创建”“页面已卸载”“命令提交与 WebSocket 回执竞态”等场景下的终态结果吞掉；这类结果不能被当成传输层噪声。
3. **缺少装配层**：FAB 级的事件源、桥、工作流注册表如果散落在页面或模块单例里，三 FAB 隔离和生命周期清理只能靠约定，无法测试。

## 决策

### 1. 实时基础设施只提供类型化流

实时层职责固定为：`WebSocket -> Decoder -> RxJS EventRouter`，向上暴露 `Observable` 类型化流。它**不知道** XState actor、业务工作流或 CommandEventBridge 的存在，也不保存业务状态。

| 层 | 目录 | 允许知道 | 禁止 |
|---|---|---|---|
| transport | `realtime/transport`（当时设计 `WebSocketClient`；当前实现 `SseCommandEventSource`/`HttpCommandGateway`） | 连接、鉴权、心跳、重连、背压信号 | 业务事件语义、actor、React |
| protocol | `realtime/protocol`（`MessageDecoder`；当时设计含 `SequenceTracker`） | 线上消息格式、版本、序列/缺口检测 | 业务去重、工作流调用 |
| streams | 当时设计 `realtime/streams`（`EventRouter`、`CommandResultStream`、`AlarmStream`、`TelemetryStream`）；**当前不存在** | topic 分发、类型化 Observable | import 工作流实现/XState；按业务判断丢弃消息 |
| consumers | `application/coordination`、`realtime/workers` | 类型化事件、命令契约 | 反向依赖具体工作流实现 |

> 上表是 M3 当时的设计基线；当前终态（SSE 事件源、`equipment-status/{protocol,gate,stream,index}`、`api/cache/equipment-status-bridge.ts`、`shared/scheduling/`）见文末 Update 与 [实时协议](../realtime-protocol.md) §2.1。

### 2. 版本无关契约只放在 `application/contracts`

公共命令契约只有一处权威定义：`application/contracts`。XState 实现内部只允许定义机器 context/event 等实现类型，**不得复制**公共 `CommandWorkflow`/`CommandResultEvent`。这样实时层与工作流实现都只依赖 `application/contracts`，装配层通过契约注入实现。

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
  /** ISO-8601 时间字符串；仅用于展示/审计，不用于排序或去重（排序看 revision） */
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

约束：

- 契约保持版本无关：不含 protobuf 生成类型、不含 WebSocket 帧类型、不含 XState 类型；线上版本适配在 realtime/protocol 完成。
- `CommandEventSource` 的 `commandResult$` 是只读 Observable；消费方不得要求实时层暴露“可写的 actor 入口”。
- 命令身份是复合身份 `(fabId, commandId)`；同一 `commandId` 在不同 FAB 中不是同一命令（CE-07）。
- `queued`/`submitted` 等“尚未被后端确认”的状态属于应用/工作流状态，不属于 `CommandResultEvent` 的 outcome 枚举；outcome 表达后端确认后的结果。
- 契约文件还包含 `CommandGateway`（命令提交/权威查询的 HTTP 抽象，当前实现 `api/transport/HttpCommandGateway.ts`）；当时设计的 `RealtimeGateway`（实时连接/订阅抽象）已在 2026-10-27 审计清理中删除，真实 WebSocket 接入时按本 ADR 重建。

### 3. CommandEventBridge 在 Application 协调层

`application/coordination/CommandEventBridge.ts` 是唯一把“实时事件流”接到“工作流”的地方，职责：

1. 订阅 `CommandEventSource.commandResult$`；
2. 按 `fabId` 过滤当前运行时负责的 FAB（三 FAB 隔离从入口开始）；
3. 用复合身份 `(fabId, commandId)` 关联命令（correlation registry）；
4. 按 `revision` 去重与版本单调过滤（旧 revision 不得回滚已应用状态）；
5. 通过 `CommandWorkflowRegistry.get(fabId, commandId)` 调用工作流接口 `receive(event)`；
6. 在 actor 缺失时进入恢复路径（`CommandEventRecovery`），不丢弃结果；
7. 提供 `start()`/`stop()`/`dispose()` 生命周期，RxJS 订阅在 `dispose` 时取消。

Bridge 不 import 工作流实现、不 import `xstate`、不操作 React、不写 Query 缓存。它只依赖 `application/contracts` 与 `application/coordination` 内部模块。

### 4. XState v6 实现隐藏在公共契约之后（位置不强制）

工作流实现当前位于 `runtime/commands`（这是实现选择，不是架构强制；可移动到其他功能目录，只要仍通过 `CommandWorkflow` 契约暴露）：

| 文件 | 职责 | 对外可见性 |
|---|---|---|
| `equipmentCommand.machine.ts` | 命令生命周期状态机（accepted/executing/terminal，含失败/取消/重试边界） | 实现细节 |
| `equipmentCommand.logic.ts` | actor 输入、命令提交、后端状态查询等业务逻辑 | 实现细节 |
| `CommandReconciler` | 缺口/缺失 actor/断线后的状态核对 | 通过 CommandWorkflow.reconcile 暴露 |
| `XStateCommandWorkflowAdapter` | 实现公共 `CommandWorkflow` 接口，包住 actor 生命周期 | 唯一对外实现 |

其他层只能拿到 `CommandWorkflow` 接口；装配层负责创建实现。实现文件放在哪个目录属于组织选择，不属于架构约束；未来替换 XState 版本或实现方式时，实时层、Bridge、页面都不受影响。机器使用 `setup` + `types` schema 的静态定义，每个命令的身份通过 actor input 注入，事件 schema 只描述 payload；refresh 采用 v6 transition function 返回 `{ target, context }` patch。

### 5. FabRuntime 是唯一装配层

`runtime` 下的 `FabRuntime`、`FabRuntimeFactory`、`FabRuntimeRegistry`、`FabLifecycleCoordinator` 负责：

- 为每个 FAB 创建/持有实时源（或测试用假源）、`CommandEventBridge`、`CommandWorkflowRegistry` 与工作流实现；
- 按 FAB 注入 `(fabId, ...)` 作用域，禁止跨 FAB 共享可变 actor/订阅；
- 生命周期：`start` -> 订阅就绪 -> 页面使用；`dispose` 时反向顺序取消订阅、停止 actor、清理恢复记录，并保证 dispose 后的回调不再进入业务；
- 运行时注册表按 `fabId` 管理实例；页面通过 `app/providers/RuntimeProvider` 获取，不自行 new。
- **Runtime 不拥有 Query 服务端缓存**：`QueryClient` 是应用级单例，FAB 维度体现在 query key 中；Runtime 只负责命令/实时链路装配（见 [FAB 运行时](../fab-runtime.md)）。

### 6. 去重与版本过滤的位置规则

- 事件去重/版本过滤属于 **CommandEventBridge 或业务投影**，不属于通用 `EventRouter`。
- `EventRouter` 可以做的是：传输级分发、topic 映射、把 `SequenceTracker` 发现的缺口/重复作为诊断或控制信号上报；**不得**因为“自己认为是重复/过期”而静默丢弃业务消息。
- 理由：同一条命令结果可能同时用于工作流状态推进、告警投影、审计展示；“是否重复”只有业务上下文（该 FAB、该命令当前 revision）能判断。通用层丢弃会让某些消费者永远收不到本应处理的终态。
- 传输层确实需要处理协议级重复/重放时，按 [实时协议](../realtime-protocol.md) 的 stream/sequence 规则处理，并保留“重同步”路径；不能把“丢弃”当作默认的重复处理策略。

### 7. actor 缺失时不得静默丢弃

当命令结果到达时没有可用的 `CommandWorkflowRegistry.get(fabId, commandId)`（actor 尚未创建、页面已卸载、FAB 尚未启动）：

1. 写入 `CommandEventRecovery` 的关联恢复记录（事件、复合身份、到达时间、尝试次数）；
2. 进入有界 pending queue；队列容量与丢弃策略必须显式定义，终态结果（`succeeded`/`failed`/`cancelled`）优先保留，溢出时触发核对/告警而不是静默丢弃；
3. actor 可用后（或页面重新挂载后）按 `reconcile(commandId)` 恢复；
4. 与权威后端状态冲突时，以查询到的权威状态为准，并记录差异；
5. **持久化恢复是后端责任**：前端恢复队列只做有界尽力而为；不能声称“关掉浏览器也不丢命令结果”。后端必须提供可按 `(fabId, commandId)` 查询的权威状态端点。

### 8. 生产环境必须覆盖的场景

| 场景 | 风险 | 要求 |
|---|---|---|
| WebSocket 确认先于 HTTP 提交响应到达 | 提交响应尚未拿到 commandId 时结果已到，被当作未知命令丢弃 | 桥先按请求/幂等键建立 pending correlation；HTTP 响应补全身份后再关联（CE-04） |
| 重复推送 | 同一结果被处理多次 | 按 `(fabId, commandId, revision)` 去重（CE-02） |
| 乱序事件 | 旧 revision 覆盖新状态 | 单调 revision；旧版本不得回滚；缺口语义由协议/Bridge 约定（CE-03） |
| actor 未创建或页面已卸载 | 结果无人接收 | 恢复记录 + 有界队列 + 核对（CE-05） |
| 长时间断线 | 恢复后状态陈旧/缺口 | 重连后按后端权威状态核对，重新订阅流（CE-06） |
| 同一 commandId 出现在不同 FAB | 串状态、串缓存 | 复合身份 `(fabId, commandId)`（CE-07） |
| 生命周期清理 | dispose 后回调仍改状态、订阅泄漏 | Runtime dispose 取消订阅并停止 actor；有测试断言（CE-08） |
| 未知 outcome/版本不匹配 | 猜语义导致错误状态 | 协议层按版本规则拒绝/重同步，不猜测业务语义 |
| 时钟偏移 | 用 `occurredAt` 排序导致乱序 | 排序/去重只用 `revision`；`occurredAt` 仅展示/审计 |

### 9. 必测门禁 CE-01..CE-08

细则与断言见 [命令事件桥](../command-event-bridge.md) 与 [命令核对](../command-reconciliation.md)；CE-01..08 均已在测试源/模拟后端上真实运行 PASS（证据见 [架构基线](../architecture.md) §12.2）：

| ID | 门禁 |
|---|---|
| CE-01 | 正常派发：提交 -> accepted/executing/succeeded，workflow 按序收到 |
| CE-02 | 重复 revision 被过滤，投影不变 |
| CE-03 | 乱序事件不导致状态回退 |
| CE-04 | 确认先于 HTTP 响应仍能关联，不丢结果 |
| CE-05 | actor 缺失时通过核对恢复 |
| CE-06 | 重连后通过后端权威查询收敛 |
| CE-07 | 三个 FAB 中出现相同 commandId 仍按复合身份隔离 |
| CE-08 | FAB 运行时关闭后取消订阅、停止 actor、不再回调 |

### 10. 迁移与生效条件

- 当前设备状态链路走 SSE → TanStack Query（FAB 级设备状态快照）与 Worker/FrameRingBuffer（高频遥测），没有 Redux/Zustand 副本；本 ADR 描述命令/实时链路边界。
- 迁移顺序已完成：契约/实时协议 -> Bridge/恢复 -> XState 工作流与 Runtime 装配 -> 真实后端命令流接通后补 CE-06/CE-04 的生产链路验证。
- 真实命令链路依赖后端生产 WebSocket 与权威持久化；当前 HTTP 命令 API + 命令 SSE 模拟链路已接通，在生产链路完成前不声称 CE-06 生产验收。

## 不改变的事项

- Router/Query 边界由 [ADR-0009](0009-tanstack-router-query-boundary.md) 定义；本 ADR 不改变 HTTP 缓存与路由。
- Babylon Lite/WebGPU-only、渲染管线、单 FAB 当前产品边界不变；高频遥测仍按 [渲染管线](../rendering.md) 走 Worker/TypedArray，不进入 XState/Query/Zustand。
- 不新增依赖、不改代码、不改 Vite 配置。

## 后果

**正面**

- 实时传输可独立演进与复用；工作流实现可替换（XState v6 只是当前实现）。
- 命令结果的关联、去重、恢复有唯一位置，CE 门禁可直接测试。
- 三 FAB 隔离通过运行时装配和复合身份同时保证，而不是靠页面自觉。

**代价与风险**

- 新增 Bridge/Recovery/Runtime 三层抽象，单 FAB 阶段可能显得“重”；但这是三 FAB 与命令链路的必要结构成本。
- XState v6 的 API/行为需要在引入时核实并用锁文件记录版本；本基线不对其发布状态作断言。
- 恢复语义的上限由后端能力决定。若后端不提供权威查询，CE-05/CE-06 无法真正闭环。
- Bridge 与实时层之间存在事件契约变更的耦合点；契约版本化策略需在 [实时协议](../realtime-protocol.md) 中固定。

## 备选方案

| 方案 | 结论 | 原因 |
|---|---|---|
| 实时层直接调用 XState actor | 不采纳 | 依赖方向倒置；纯遥测/告警复用受限；actor 生命周期与连接生命周期纠缠 |
| 由通用 EventRouter 按重复/过期丢弃消息 | 不采纳 | 会静默丢弃重要终态；业务语义无法在通用层判断 |
| 在 Redux middleware 中做命令桥 | 不采纳 | 与 V2.1 客户端状态目标冲突；middleware 仍属状态容器，且无法表达 per-FAB 运行时生命周期 |
| 页面直接订阅实时流并自己调 actor | 不采纳 | 无统一关联/去重/恢复；页面卸载即丢结果；CE 门禁不可满足 |
| 后端推送完整状态，前端不建模命令生命周期 | 不采纳 | 与“命令结果必须可关联/去重/恢复”的交互要求不符；后端仍可作为权威恢复来源，但前端仍需管理进行中命令 |

## Update（2026-10-28 终态）

本 ADR 的决策不变；以下是 R-08 整改后的真实模块映射（以 [architecture.md](../architecture.md) §30 为准）：

| 关注点 | 终态实现 |
|---|---|
| 命令结果事件源 | `web_app/src/realtime/transport/SseCommandEventSource.ts`（`commandResult$` + `gaps$`；后端 journal 游标 `{epoch}:{sequence}` 与 `replay-gap`） |
| 权威查询 | `web_app/src/api/transport/HttpCommandGateway.ts`（`GET /api/v1/commands/{id}`） |
| 解码 | `web_app/src/realtime/protocol/MessageDecoder.ts`（Zod envelope） |
| 设备状态边界 | `web_app/src/realtime/equipment-status/{protocol,gate,stream,index}.ts`；REST/SSE→Query 唯一投影桥 `web_app/src/api/cache/equipment-status-bridge.ts` |
| 通用低频合批 | `web_app/src/shared/scheduling/coalesced-dispatcher.ts`（`realtime/telemetry/telemetry-buffer.ts` 已不存在） |
| 桥/恢复/Runtime | `application/coordination/{CommandEventBridge,CommandEventRecovery,CommandCorrelationRegistry}.ts`、`runtime/{FabRuntime,FabRuntimeFactory,FabRuntimeRegistry,FabLifecycleCoordinator}.ts`、`runtime/commands/*` |
| 门禁位置 | `web_app/tests/integration/command-event-bridge.test.ts`、`web_app/tests/contract/command-{recovery,workflow,correlation}.test.ts`、`web_app/tests/integration/fab-runtime*.test.ts`（镜像式布局后路径） |
| 架构门禁 | R0–R14 位于 `web_app/tests/architecture/`；R7 保证 `realtime/` 等通用层不 import `features/**`，R10 保证含 type-only 边的全图无环 |

`realtime/streams`/`EventRouter`/`RealtimeGateway`/`WebSocketClient`/`SequenceTracker` 当前均不存在；生产 WebSocket 接入时按本 ADR 的“通用层不得按业务语义丢弃消息”约束重建，不得恢复为不可达骨架。

## 开放问题

| ID | 问题 | 影响 | 建议 |
|---|---|---|---|
| OPEN-V21-06 | 后端实时流协议（protobuf/JSON）、stream/sequence/ACK 语义、鉴权与 maxHz | CE-04/CE-06 与真实链路验收 | 由后端/Lead 在 M3 前确认；前端按 [实时协议](../realtime-protocol.md) 的兼容假设实现 |
| OPEN-V21-07 | 后端命令状态查询端点（按 fabId+commandId 的权威状态） | CE-05/CE-06 闭环 | 需要新增 API 契约；本基线不虚构端点 |
| OPEN-V21-08 | XState v6 版本与 API 稳定性、actor 粒度（每 FAB 一个 actor 还是每命令一个 actor） | 工作流实现与测试 | M4 前核实并锁版本；建议命令级 actor + FAB 级 registry |
| OPEN-V21-09 | 前端恢复记录的生命周期（仅内存 vs sessionStorage） | 页面刷新后的恢复范围 | 权威恢复在后端；前端不承诺跨刷新持久化，具体策略在 M3 决定 |
| OPEN-V21-10 | CommandGateway 的 HTTP 提交契约（幂等键、202/结果码、请求指纹） | 与后端 API 契约 | 沿用现有开发 API 风格，M3 时与后端契约一起冻结 |
