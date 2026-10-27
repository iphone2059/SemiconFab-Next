# 实时协议（Realtime Protocol）

- 版本：V2.1 / 2026-10-27
- 状态：**契约/类型化流/HTTP-SSE 产品链路已实现（模拟后端）；真实 WebSocket 未接**（implemented / WebSocket pending）
- 依据：[ADR-0010](adr/0010-command-event-bridge.md)；总览见 [架构基线](architecture.md)；命令桥见 [命令事件桥](command-event-bridge.md)；恢复见 [命令核对](command-reconciliation.md)；渲染旁路见 [渲染管线](rendering.md)
- 上位规范：[08-API-EVENT-CONTRACTS](SemiconFab-Next-Engineering-v1.1/08-API-EVENT-CONTRACTS.md)、[14-CONTRACTS-AND-EVENT-FLOWS](SemiconFab-Next-Engineering-v1.1/engineering/14-CONTRACTS-AND-EVENT-FLOWS.md)（本前端协议不得另造第二套语义）
- 当前实现：设备状态 SSE + 后端**模拟**命令 SSE / 20Hz 遥测 SSE 已接入产品；`MessageDecoder` 由 `TelemetryRuntime` 实际使用；`SseCommandEventSource` 与 `TelemetryRuntime` 使用同一 envelope 契约。`realtime/streams` 与 `WebSocketClient`/`SequenceTracker`/`RealtimeGateway` 的 RxJS 骨架在 2026-10-27 审计清理中作为生产不可达死代码删除（M4+ 接入真实 WebSocket 时按 ADR-0010 重建）。后端 `--realtime`（WebSocket）仍为占位。
- 门禁：解码/序列/路由、CE-01..08 已在测试源/真实模拟后端上 PASS；浏览器 e2e 命令 accepted→executing→succeeded；真实 WebSocket 生产传输仍缺。

## 1. 范围与边界

实时层的目标：把后端实时流安全、可诊断地转换成应用可消费的**类型化 Observable**，并把高频数据旁路到 Worker/GPU。

| 在范围内 | 不在范围内 |
|---|---|
| WebSocket 连接、重连、鉴权、心跳、背压信号 | 后端流协议的生产实现（当前不存在） |
| 消息解码、版本校验、序列/缺口检测 | 业务命令状态机（XState，见 ADR-0010） |
| topic -> 类型化流（命令结果/告警/遥测） | Query 服务端缓存（HTTP 查询见 ADR-0009） |
| 高频遥测到 Worker/缓冲区的通路 | 渲染视觉/性能验收（见 [渲染管线](rendering.md)） |

硬约束（ARCH-06）：`realtime` 不得 import `runtime/commands` 或 `xstate`；也不知道 `CommandEventBridge` 的存在（bridge 是消费者）。

## 2. 分层与职责

| 层 | 目录 | 组件 | 职责 | 不得做 |
|---|---|---|---|---|
| transport | `realtime/transport` | `WebSocketClient` | 建连、鉴权握手、心跳、重连退避、连接状态、背压信号 | 业务语义、UI、工作流 |
| protocol | `realtime/protocol` | `MessageDecoder`、`SequenceTracker` | 解码、版本校验、字段/单位/精度校验、序列缺口检测 | 业务去重、按“看起来重复”丢消息 |
| streams | `realtime/streams` | `EventRouter`、`CommandResultStream`、`AlarmStream`、`TelemetryStream` | topic 分发、类型化 Observable、stream 身份管理 | import XState/runtime/commands、写 Query/Redux |
| high-frequency | `realtime/workers`、`realtime/buffers`、`realtime/synchronization` | Worker、环形缓冲、同步 | 高频遥测解码/批处理 -> TypedArray -> 渲染 | 逐帧 React state、逐事件 dispatch |

## 3. 消息与信封

### 3.1 上位信封字段

前端按 Engineering 08/14 的 `EventEnvelope` 处理，至少包括：`contract_version`、`identity(site_id,fab_id,run_id)`、`event_id`、`correlation_id`、`causation_id`、`sequence`、`simulation_time_us`、`wall_produced_unix_ms`、`oneof body`。前端**不得**自创与之冲突的字段或语义。

### 3.2 前端视角至关重要的三点

1. **收到的不是权威 EventLog**：客户端收到的是投影/展示流（snapshot/delta）；其 `stream_sequence` 与权威 `EventSeq` 不同，不能跨范围比较，也不能当成恢复检查点。
2. **流身份**：订阅建立、范围/权限变更、重连/重同步都会产生新的 `stream_id`；旧流的迟到消息必须丢弃（这是**传输/流身份**层面的丢弃，不是业务去重）。
3. **精度**：`int64/uint64`（含大于 2^53 的序号）必须用 `bigint` 或十进制字符串处理，校验范围后再转展示数字；不得直接转 `number` 丢精度。

### 3.3 命令结果消息（前端契约）

命令结果在实时消息体内承载，经解码后映射为 [ADR-0010](adr/0010-command-event-bridge.md) 的 `CommandResultEvent`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `fabId` | string | FAB 身份；与 commandId 组成复合身份 |
| `commandId` | string | 命令 id（不同 FAB 可相同） |
| `revision` | number | 同一命令内单调；去重/排序依据 |
| `outcome` | enum | `accepted` / `executing` / `succeeded` / `failed` / `cancelled` |
| `occurredAt` | string | ISO-8601；仅展示/审计，不用于排序 |

映射在 protocol/stream 层完成；`realtime` 不推导业务状态，只保证字段被正确解码。

### 3.4 遥测/告警消息

- 遥测：按订阅范围、LOD、maxHz 合并后的帧/批次，含实体 id、变换/状态值、单位；优先走 Worker 路径（`TelemetryStream` 或 Worker 内消费）。
- 告警：低频、需要用户可见；可以进入 `AlarmStream`，由 UI 层消费；不得与命令结果混用同一业务去重逻辑。
- 原始高频帧不得进入 Query/Zustand/XState（ARCH-11）。

## 4. 解码与校验（MessageDecoder）

规则：

1. 先校验 `contract_version` 与消息类型；不支持的版本/类型进入“拒绝并重同步”路径，不猜语义。
2. 用 schema（Zod 或等价）逐字段校验：必填、枚举、范围、单位、精度；未知字段可保留（tolerant reader）但**不得猜测业务含义**。
3. 解码失败：记录诊断（不含敏感数据）+ 丢弃该帧/或按协议关闭重连；不得把部分解析结果写入下游。
4. 批量消息先完整校验再原子应用；部分失败不得产生半批状态。
5. 命令结果的 `outcome` 不合法时按协议错误处理；不能让非法枚举进入 Bridge 并被当作业务结果。

## 5. 序列、缺口、重复与背压

### 5.1 SequenceTracker

- 每个 `stream_id` 维护已应用的最大 `stream_sequence`，检测缺口/旧包。
- 缺口：按 Engineering 08 走 `RESYNC_REQUIRED`/补发或新流快照；在缺口闭合前不得把后续批次当作连续状态应用（否则状态错乱）。
- 旧流/旧包：按 `stream_id` 丢弃（传输层语义），不是业务去重。
- 允许把缺口/重复的统计暴露为诊断信号给 Bridge/监控；SequenceTracker 不做业务判断。

### 5.2 重复的两类区分（重要）

| 类型 | 例子 | 处理位置 |
|---|---|---|
| 协议级重复/重放 | 同一 `stream_id` 的 `stream_sequence` 被重复发送 | transport/protocol 可幂等忽略（ACK 已应用批次） |
| 业务级重复/版本过滤 | 同一命令 `revision` 被重复推送、乱序到达 | **CommandEventBridge 或工作流投影**（ARCH-10）；`EventRouter` 不得静默丢弃 |

通用 `EventRouter` **不得**以“自己认为是重复”为由丢弃消息；同一条命令结果可能同时被工作流、告警投影、审计使用，只有业务上下文能判断是否重复（[ADR-0010](adr/0010-command-event-bridge.md) 第 6 节）。

### 5.3 背压

- 传输/流层使用有界缓冲；遥测的合并在编号前完成，编号后批次不得静默丢弃。
- 消费者（Worker/UI）慢时：合并/丢弃非权威陈旧展示增量、触发重同步；**命令结果不得被当作可丢增量**。
- 缓冲上限、帧大小、maxHz、ACK 超时由后端冻结（Engineering 08）；前端不得通过超限订阅绕过。
- 无法发送控制消息时应关闭连接重建，避免 `RESYNC_REQUIRED` 被堵在满队列里（Engineering 08）。

### 5.4 前端 Worker 背压与增量合并

高频遥测经 Worker 旁路（ARCH-11），其背压策略与本层合并语义一致，但实现为**有界、不排队**：

- **单帧在途**：同一时刻最多只有一个遥测帧等待 Worker 回包；回包前到达的帧不排队，只保留一个有界 Pending 槽位。
- **全量快照维持 latest-wins**：Pending 槽中的旧帧被更新帧覆盖，flush 时只提交最新的一帧；连接内已接受序列（accepted sequence）单调，更旧的帧按序列丢弃。
- **稀疏/增量帧不丢实体更新**：Pending 帧与新到帧按 `entityId` 合并——同一实体由新帧覆盖，实体顺序沿用 Pending 帧顺序，仅出现在新帧的实体追加；flush 时提交合并结果。因此背压期间对 entity1/entity2/entity3 的先后更新都会保留，而不是只剩最后一帧。
- **身份字段取新帧**：合并结果的 `fabId`/`sequence`/`capturedAt` 来自最后接受的帧；`sequence` 仍是连接内局部单调值，不跨连接比较。
- **合并粒度**：合并的是“实体级完整数值记录”（同一 `entityId` 的新记录覆盖旧记录）；若未来协议支持单个实体内只更新部分字段的 Delta，需要另行定义字段级合并语义，当前实现不承诺。
- **产品作用域**：正式渲染路径固定消费 16 个遥测槽位；5000 实体 Worker 压测只验证 Worker 吞吐与内存上限，不代表产品业务链路已支持 5000 台设备。
- **重连重置**：SSE 重连或 `stop()` 清空 Pending/在途状态并发送 Worker `reset`；旧连接的迟到回包按 generation 丢弃，不恢复旧序列。

## 6. EventRouter 与类型化流

```ts
// realtime/streams/EventRouter.ts（示意）
export interface RealtimeStreams {
  readonly commandResults$: Observable<CommandResultEvent>;
  readonly alarms$: Observable<AlarmEvent>;
  readonly telemetry$: Observable<TelemetryBatch>; // 通常直接进 Worker，不进 React
}

// EventRouter 只做 topic -> Observable 的分发与流身份管理
export function createEventRouter(source: Observable<DecodedMessage>): RealtimeStreams;
```

约束：

- 流的创建/销毁跟随连接与订阅范围；`dispose` 后不得再向消费者推送。
- 允许按 topic、FAB、run 订阅；FAB 过滤在该层只是“订阅范围”，业务身份过滤在 Bridge。
- 不暴露 WebSocket/socket 对象给上层；不暴露可写入口。
- 不 import Query/Zustand/React/XState。

## 7. 高频遥测与渲染路径

```text
WebSocket -> transport/MessageDecoder -> Worker（解码/批处理） -> TypedArray 缓冲区 -> Babylon Lite -> WebGPU
```

- Telemetry 帧优先在 Worker 内解码/合并；主线程只接收有界摘要或渲染所需缓冲。
- 缓冲区采用环形/双缓冲；脏实体集合按帧预算合并（Engineering 09/15）。
- 不使用 SharedArrayBuffer 除非安全上下文（COOP/COEP）与部署策略明确批准；该问题登记为 OPEN-V21-14。
- UI 的低频聚合需求由单独契约提供，不从高频流直接 `setState`。

## 8. 重连与恢复

1. 连接断开：`WebSocketClient` 退避重连；期间命令结果无法到达（前端不做虚假状态推进）。
2. 重连成功：建立新 `stream_id`/订阅，等待快照与后续批次；旧流消息按身份丢弃。
3. 与命令相关：断线期间的终态必须通过**后端权威状态查询**核对（[命令核对](command-reconciliation.md)）；前端实时流只负责“恢复后的新事件”。
4. 恢复后仍缺数据时，进入核对而不是猜测；持续失败要有可见错误/降级提示。
5. 生命周期：页面卸载/FAB 运行时销毁时取消所有订阅（CE-08）。

## 9. 版本与兼容

- `contract_version` 与前端支持的窗口由后端/前端共同冻结；不兼容变更按 Engineering 08/14 的兼容矩阵处理。
- 新增可选字段保持 tolerant reader；未知**类型**或未知**状态改变**必须拒绝/重同步，不猜测。
- 前端不得在没有协议约定的情况下自行增加语义字段（例如用 `occurredAt` 排序）。
- 日志与诊断不得输出敏感数据；具体字段安全规则遵循 Engineering 11/14。

## 10. 当前实现现状（差距表）

| 方面 | 当前（2026-10-27 事实） | V2.1 目标 | 状态 |
|---|---|---|---|
| 传输 | 设备状态 SSE（`EventSource`） | WebSocket + 二进制/协议消息 | 未开始 |
| 解码 | `createOrderedEquipmentStatusConsumer` 对 SSE 帧排序/校验 | `MessageDecoder` + `SequenceTracker` | 未开始 |
| 类型化流 | 无 RxJS，无 `EventRouter` | `EventRouter` + 命令/告警/遥测流 | 未开始 |
| 命令结果 | 无 | `CommandResultStream` -> Bridge | 未开始 |
| 高频遥测 | `telemetry-buffer.ts` 100ms 合批进 Redux | Worker/TypedArray 旁路 | 未开始 |
| 后端实时服务 | `fab_app -- --realtime` 退出码 2（占位） | 真实 WebSocket/流协议 | 后端未开始 |

> 迁移期间 SSE 链路保留，避免破坏当前 Twin 页面；不得声称 SSE 链路已被新协议替代。

## 11. 计划测试与门禁映射

| 测试 | 内容 | 文件（计划） | 状态 |
|---|---|---|---|
| 解码契约测试 | 合法/非法 envelope、版本、枚举、精度 | `web_app/tests/contract/…`（M3 决定具体文件） | SPECIFIED / NOT RUN |
| 序列测试 | 缺口、旧包、重复 stream_sequence、重同步 | 同上 | SPECIFIED / NOT RUN |
| Bridge 集成 | CE-02/CE-03/CE-04 等基于假源的结果流 | `web_app/tests/integration/command-event-bridge.test.ts` | SPECIFIED / NOT RUN |
| 渲染路径性能 | Worker -> TypedArray -> Lite 帧预算 | `web_app/tests/performance` | SPECIFIED / NOT RUN |

## 12. 开放问题

| ID | 问题 | 建议 |
|---|---|---|
| OPEN-V21-06 | 后端流协议（protobuf/JSON）、stream/sequence/ACK/鉴权/maxHz | 后端/Lead，M3 前冻结；前端按 Engineering 08/14 语义实现 |
| OPEN-V21-14 | 是否使用 SharedArrayBuffer（COOP/COEP 部署） | M5 决策；不用也可先走 transferable ArrayBuffer |
| OPEN-V21-15 | 告警/遥测 topic 命名与订阅范围（per FAB/run/LOD） | M3 与后端共同定义 |
| OPEN-V21-16 | 解码 schema 的单一来源（Zod 手写 vs 由契约生成） | M3 决策；避免双份 schema |
