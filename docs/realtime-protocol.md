# 实时协议（Realtime Protocol）

- 版本：V2.1 / 2026-10-27（2026-10-28 递归整改 R-08 同步）
- 状态：**Effect 4 重构终态（2026-10-29）：命令/设备状态/遥测 HTTP-SSE 链路已实现（模拟后端）；命令信号为 Effect Stream/PubSub，不再使用 RxJS；真实 WebSocket 未接**（implemented / WebSocket pending）
- 依据：[ADR-0011](adr/0011-effect4-runtime-architecture.md)（Effect 4 运行时/资源/Stream 边界）、[ADR-0010](adr/0010-command-event-bridge.md)；总览见 [架构 README](architecture/README.md)；命令桥见 [命令事件桥](command-event-bridge.md)；恢复见 [命令核对](command-reconciliation.md)；渲染旁路见 [渲染管线](rendering.md)
- 上位规范：[08-API-EVENT-CONTRACTS](SemiconFab-Next-Engineering-v1.1/08-API-EVENT-CONTRACTS.md)、[14-CONTRACTS-AND-EVENT-FLOWS](SemiconFab-Next-Engineering-v1.1/engineering/14-CONTRACTS-AND-EVENT-FLOWS.md)（本前端协议不得另造第二套语义）
- 当前实现（2026-10-29 事实）：设备状态 SSE + 后端**模拟**命令 SSE / 20Hz 遥测 SSE 已接入产品。命令信号由 `realtime/command-event-source.transport.ts` 实现为 **Effect PubSub + Stream**（`commandResults/reconnected/gaps/connectionStatus/transportFailures`），EventSource 只由第一个/最后一个 result Stream 消费者懒打开/关闭；`FabRuntime` 通过 `runtime/command-stream.ts` 消费 Stream，无 RxJS Subscription。设备状态 payload/scope、epoch+sequence 顺序门控与 REST/SSE 共同写入路径由 `realtime/equipment-status.*.ts` + `api/equipment.resource.ts` 唯一拥有；接受帧写入 FAB 作用域 Resource Atom（`api/resource.ts`），Gate 只保存顺序元数据。遥测仍由 `realtime/telemetry-runtime.ts` 走 Worker/FrameRingBuffer。真实 WebSocket 生产传输仍缺。
- 门禁：解码/序列/路由、CE-01..08 已在测试源/真实模拟后端上 PASS；浏览器 e2e 命令 accepted→executing→succeeded；真实 WebSocket 生产传输仍缺。

## 1. 范围与边界

实时层的目标：把后端实时流安全、可诊断地转换成应用可消费的**类型化 Effect Stream**，并把高频数据旁路到 Worker/GPU。

> 当前产品使用的是 HTTP/SSE 模拟链路（见 §2.1/§10）；本文的 WebSocket 描述是待接目标的协议规范，不代表已实现。

| 在范围内 | 不在范围内 |
|---|---|
| WebSocket 连接、重连、鉴权、心跳、背压信号 | 后端流协议的生产实现（当前不存在） |
| 消息解码、版本校验、序列/缺口检测 | 业务命令状态机（XState，见 ADR-0010） |
| topic -> 类型化流（命令结果/告警/遥测） | Query 服务端缓存（HTTP 查询见 ADR-0009） |
| 高频遥测到 Worker/缓冲区的通路 | 渲染视觉/性能验收（见 [渲染管线](rendering.md)） |

硬约束（ARCH-06）：`realtime` 不得 import `runtime/commands` 或 `xstate`；也不知道 `CommandEventBridge` 的存在（bridge 是消费者）。

## 2. 分层与职责

### 2.1 当前实现模块（2026-10-28 事实，与真实树核对）

| 层 | 目录/文件 | 组件 | 职责 | 不得做 |
|---|---|---|---|---|
| transport（命令） | `realtime/command-event-source.transport.ts` + `api/http.transport.ts` | Effect PubSub Stream 事件源、权威 HTTP 查询 | EventSource 懒生命周期、journal 游标 `{epoch}:{sequence}`、`gaps`/`reconnected`/`connectionStatus`/`transportFailures` Stream；权威状态查询 | 业务去重、UI、工作流 |
| protocol | `realtime/message-decoder.ts` | `MessageDecoder` | envelope 版本/字段解码与校验 | 业务去重、按“看起来重复”丢消息 |
| equipment-status | `realtime/equipment-status.protocol.ts`、`equipment-status.gate.ts`、`equipment-status.transport.ts`；`api/equipment.resource.ts` | payload/scope、epoch+sequence gate、REST/SSE 资源 | FAB 作用域快照的唯一顺序权威；接受帧写入 Resource Atom | 创建第二快照缓存 |
| telemetry | `realtime/telemetry-runtime.ts`、`telemetry-registry.ts` | 20Hz SSE 运行时、按 FAB 引用计数 | 传输/解码/帧/背压、Worker 生命周期 | 逐帧 React state |
| high-frequency | `realtime/telemetry-worker-*`、`realtime/frame-ring-buffer.ts`；低频合批 `lib/coalesced-dispatcher.ts` | Worker、环形缓冲、通用合批 | 高频遥测解码 -> TypedArray -> 渲染；低频 UI 聚合 | 逐帧 React state、逐事件 dispatch |

`realtime/streams`（`EventRouter`/`CommandResultStream` 等）与 `realtime/synchronization` **当前不存在**；真实 WebSocket 接入时按下面的协议语义重建，不得直接恢复为生产不可达骨架。

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

### 5.1 顺序权威（当前实现）

- **设备状态**：`realtime/equipment-status/gate.ts` 是 Site/FAB 作用域 `epoch + sequence` 顺序的唯一权威（REST queryFn 与 SSE listener 共用），只接受“在作用域内、字段完整、工具数匹配”的快照；更高 epoch 重置水位，更低 epoch 视为旧世代丢弃。
- **命令结果**：`SseCommandEventSource` 跟踪后端 journal 游标 `id: {epoch}:{sequence}`；`replay-gap` 控制帧转成显式 `gaps$` 信号，由 Runtime 触发权威核对；命令业务去重（revision）在 CommandEventBridge（ARCH-10）。
- **旧流/旧包**：按流身份/作用域丢弃（传输层语义），不是业务去重。
- 历史说明：M3 的 `SequenceTracker`（per-topic stream_sequence）骨架已在 2026-10-27 审计清理中删除；真实 WebSocket 重建时必须恢复同等“缺口只报告、不按业务语义丢弃”的约束。

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

## 6. 命令结果事件源与类型化流（当前实现）

当前命令结果链路（无通用 EventRouter；生产不可达骨架已删除）：

```ts
// realtime/transport/SseCommandEventSource.ts（当前实现）
export function createSseCommandEventSource(url: string, options?): CommandEventSource;
// CommandEventSource = { commandResult$: Observable<CommandResultEvent>; gaps$: Observable<CommandStreamGap> }
```

约束：

- 事件源的创建/销毁跟随 FAB Runtime 生命周期；`dispose` 后不得再向消费者推送（CE-08）。
- FAB 过滤在传输层只是“订阅范围”（服务端按 `?fabId=` 授权过滤），业务身份过滤/去重在 CommandEventBridge。
- 不暴露 EventSource/socket 对象给上层；不暴露可写入口。
- 不 import Query/Zustand/React/XState。
- 未来真实 WebSocket 若恢复 `EventRouter`/`CommandResultStream`/`AlarmStream`/`TelemetryStream`，必须保持“通用层不得按业务语义丢消息”的 ADR-0010 约束（[ADR-0010](adr/0010-command-event-bridge.md) 第 6 节）。

## 7. 高频遥测与渲染路径

```text
当前（HTTP/SSE 模拟链路）:
FAB 级 20Hz 遥测 SSE -> TelemetryRuntime（解码/帧/背压）-> telemetryWorker（解码/批处理）
                       -> FrameRingBuffer（TypedArray）-> lite-backend / ScenePort 渲染循环 -> WebGPU

目标（真实 WebSocket 接入后）:
WebSocket -> transport/MessageDecoder -> Worker -> TypedArray 缓冲区 -> ScenePort 渲染循环 -> WebGPU
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

| 方面 | 当前（2026-10-28 事实） | V2.1 目标 | 状态 |
|---|---|---|---|
| 传输 | 设备状态 SSE + 命令 SSE + 20Hz 遥测 SSE（`SseCommandEventSource`/`TelemetryRuntime`） | WebSocket + 二进制/协议消息 | 部分：HTTP/SSE 模拟链路已接；生产 WebSocket 待接 |
| 设备状态边界 | `realtime/equipment-status/{protocol,gate,stream,index}.ts` + `api/cache/equipment-status-bridge.ts`（Query 唯一缓存） | 同职责单点权威 | PASS（R-08 终态） |
| 解码 | `realtime/protocol/MessageDecoder.ts`（Zod envelope） | `MessageDecoder` | PASS |
| 类型化流 | `CommandEventSource`（`commandResult$`/`gaps$`，RxJS Observable） | `EventRouter` + 命令/告警/遥测流 | 部分：命令结果流已接；通用 EventRouter 待真实 WebSocket 重建 |
| 命令结果 | SSE → `CommandEventSource` → CommandEventBridge → XState | 类型化流 -> Bridge | PASS（模拟后端） |
| 高频遥测 | Worker `FrameRingBuffer` + `domain/equipment/tool-state-projection.ts` 投影；低频合批 `shared/scheduling/coalesced-dispatcher.ts` | Worker/TypedArray 旁路 | PASS |
| 后端实时服务 | `fab_app -- --realtime` 退出码 2（占位）；HTTP/SSE 模拟端点已实现 | 真实 WebSocket/流协议 | 后端未开始 |

> 当前产品仍使用 SSE 模拟链路（HTTP 命令 API + 命令/遥测/设备状态 SSE）；生产 WebSocket 未接，不得声称 SSE 链路已被新协议替代。

## 11. 测试与门禁映射（已运行）

| 测试 | 内容 | 文件（2026-10-28 镜像式布局） | 状态 |
|---|---|---|---|
| 解码契约测试 | 合法/非法 envelope、版本、枚举、精度 | `web_app/tests/realtime/realtime-protocol.test.ts`、`realtime-transport.test.ts` | PASS |
| 设备状态边界 | payload/scope、epoch+sequence、SSE 生死周期、REST/SSE 同一 gate | `web_app/tests/realtime/equipment-status.test.ts`、`equipment-status-protocol.test.ts`、`equipment-status-epoch.test.ts`、`web_app/tests/api/equipment-status-bridge.test.ts` | PASS |
| Bridge 集成 | CE-02/CE-03/CE-04 等基于假源的结果流 | `web_app/tests/integration/command-event-bridge.test.ts` | PASS |
| Runtime/遥测 | Worker terminate/回调解绑、租约、迟到回包 | `web_app/tests/realtime/telemetry-runtime.test.ts`、`fab-telemetry-registry.test.ts`、`realtime-frame-buffer.test.ts` | PASS |
| 渲染路径性能 | Worker -> TypedArray -> Lite 帧预算 | `web_app/tests/performance/telemetry-frame-buffer.test.ts`、`telemetry-load.test.ts` | PASS |

## 12. 开放问题

| ID | 问题 | 建议 |
|---|---|---|
| OPEN-V21-06 | 后端流协议（protobuf/JSON）、stream/sequence/ACK/鉴权/maxHz | 后端/Lead，M3 前冻结；前端按 Engineering 08/14 语义实现 |
| OPEN-V21-14 | 是否使用 SharedArrayBuffer（COOP/COEP 部署） | M5 决策；不用也可先走 transferable ArrayBuffer |
| OPEN-V21-15 | 告警/遥测 topic 命名与订阅范围（per FAB/run/LOD） | M3 与后端共同定义 |
| OPEN-V21-16 | 解码 schema 的单一来源（Zod 手写 vs 由契约生成） | M3 决策；避免双份 schema |

## 13. Round 4 修订（控制帧、ACK 安全锁与实时可用性）

本节记录 2026-10-30 Round 4 源码整改后的当前事实；与本文前文（2026-10-27/28 历史描述）冲突处，以本节为准。

- **replay-gap 控制帧没有 `id:` 行。** SSE 规范会让浏览器 `MessageEvent.lastEventId` 继承上一数据帧的 ID（可能属于旧 epoch）。客户端解析器只接受 payload 中的 epoch，`requestedLastEventId` 仅作为诊断字符串；不得把继承的 lastEventId 与 payload epoch 组合成恢复游标，也不得从该帧推导 sequence。
- **replay-gap 一律触发权威 List 恢复。** 该控制帧表示后端无法从客户端 cursor 连续回放；FabRuntime 对每个 gap 使用 `listOnly: true`，不执行 Journal continuation。
- **Dirty reason 当前集合**：`overflow | slow-consumer | stale-generation | closed | server-overflow | store-fault | decode-error | invalid-control-frame | protocol-error | ack-ledger-overflow | uncovered-gap | transport-unavailable`。其中 `uncovered-gap` 表示权威 cover 未覆盖已知未登记位置（继续 List 恢复），`transport-unavailable` 表示实时 transport 永久不可用。
- **SSE ACK 安全锁**：transport 对所有无法证明已登记/已应用的位置（队列溢出、坏帧、无 ID 帧、epoch 跳变、非单调序号、server dirty、replay-gap、连接错误/超时、factory 异常、stale generation）设置粘性 latch 并记录 `untrackedHighWater` 或 unknown gap。`cover(cursor, authority)` 只有在权威 watermark 覆盖全部未登记位置时才释放；未知/跨 epoch 位置必须 List authority。cover 不足时保留 latch 并发布 `uncovered-gap`，不得推进 ACK 越过未登记位置。
- **实时可用性**：`CommandEventSource.availability` 当前为 getter。无 EventSource factory 或失败打开次数超过 `maxConnectAttempts`（默认 4）后为 `unavailable`，transport 不再无限重连。FabRuntime 将 recovery authority（gateway + source ready）与 realtime availability 分开：实时 transport 不可用时 HTTP 可收敛但总体 phase 为 `Degraded`，不得 Healthy；无 EventSource 的 composition root 只装配 display-only runtime（`Unavailable`）。
- **服务端 SSE 扫描游标（R4-09）**：命令 journal 的 sequence 是 Site 级，而事件按 FAB 过滤。live loop 在无 gap 的成功扫描中即使目标 FAB 没有事件也推进 `cursor = latestSequence`，仅在写出帧时 flush；避免空闲 FAB 重复 O(n) 扫描 Site journal。


## Round 5 / Round 5.1（已实施）

Round 5 已由提交 `4c8f0c1` 实施：Transport availability 和实际 connection status 分开，只有连接 open 且恢复完成才能 Healthy。Round 5.1 进一步完成 `CommandConnectionStatus` 五态生命周期（新增合法空闲态 `closed`，与永久 `failed` 区分）、三游标 cover 语义（cover 永不修改 `delivered`）与 Recovery pre/post 双屏障；规范见 `architecture/19-round5.1-remediation-specification.md`（P1-01/P1-04/P2-01）。
