# Task 6（阶段 A）：RxJS → Effect Stream/PubSub

- 执行日期：2026-10-29（Asia/Singapore）
- 前序：Task 5 完成 `b3d795d`
- 权威计划：`docs/architecture/03-migration-plan.md` Task 6；`01-effect4-target-architecture.md` §9
- 状态：RxJS 已清零；Task 6 浏览器功能/性能/验收（阶段 B/C）待完成

## 1. 契约

`CommandEventSource`（`src/contracts/command-events.contract.ts`）从 Observable 改为 Effect Stream：

| 旧 | 新 |
|---|---|
| `commandResult$: Observable<CommandResultEvent>` | `commandResults: Stream<CommandResultEvent>` |
| `reconnected$: Observable<void>` | `reconnected: Stream<void>` |
| `gaps$: Observable<CommandStreamGap>` | `gaps: Stream<CommandStreamGap>` |
| `connectionStatus$: Observable<CommandConnectionStatus>` | `connectionStatus: Stream<CommandConnectionStatus>` |
| `transportFailures$: Observable<CommandTransportFailure>` | `transportFailures: Stream<CommandTransportFailure>` |

这样行为契约（恰好一次 result、reconnect/gap/failure 分离、transport failure 不伪造命令结果）只依赖类型化 Stream，消费者不再接触 RxJS。

## 2. SSE 适配器

`src/realtime/command-event-source.transport.ts` 重写：

- 一个 `PubSub.unbounded<CommandStreamMessage>` 作为 FAB SSE 的唯一消息总线；五路 Stream 均由它派生（result/reconnected/gap/status/failure）。
- **懒连接语义保持**：连接生命周期只由 `commandResults` 消费者的 `Stream.onStart`/`Stream.ensuring` 拥有；第一个命令结果消费者启动时才创建 EventSource，最后一个退出时 close。FabRuntime 的其他信号订阅（status/gap/failure）不会提前打开 FAB 连接。
- 一个 EventSource 同时服务所有信号；不再使用 `share()`/Subject。
- cursor 合并、replay-gap 解析、MessageDecoder 解码、transport failure 语义与 Task 5 前等价。
- 无 EventSource 环境（jsdom/测试）发布 status failed + transport failure，result Stream 保持空；不再通过 Observable error 抛出。

## 3. 消费端

- 新增 `src/runtime/command-stream.ts`：唯一的 Stream→plain-TS 适配器，`Effect.runFork(Stream.runForEach(...))` 返回幂等 stop；被 `effect-runtime-boundary` allowlist 明确批准（另有 transport 的 PubSub 单次构造）。
- `CommandEventBridge`：`source.commandResults` 经 `runCommandStream` 消费，dispose 调用 stop；不再持有 RxJS Subscription。
- `FabRuntime`：gap/reconnect/failure/status 四个信号全部改为 Stream 订阅（各自 stop 函数），`stop()` 先停 bridge 再停信号流；无 Subscription 字段。
- `command-sources.ts`：空源改为 `Stream.empty`。
- 遥测传输（TelemetryRuntime）此前已是 EventSource/Worker 回调 + 显式 stop，无 RxJS；Task 4/5 已删除其 Observable 依赖。

## 4. 依赖与门禁

- `package.json` 删除 `rxjs`；`pnpm-lock.yaml` 中 rxjs 行数为 **0**；install 移除 2 个包。
- `legacy-dependency-gate`：RxJS 规则由预留改为 **active**（生产 import/manifest/lockfile 均为 0）。
- 生产源码无 `from 'rxjs'`；仅注释中出现 “no RxJS Subscription remains”。

## 5. 测试

- `tests/support/command-fakes.ts`：`FakeCommandEventSource` 改为 PubSub+Streams，observer 计数由 Stream `onStart/ensuring` 维护；emit/reconnect/emitGap/failTransport/openStream API 保持，测试断言语义不变。
- `tests/realtime/realtime-transport.test.ts`：改用 `runCommandStream` 消费并发起/停止；覆盖 decode、reconnect、replay-gap、status/failure、EventSource close。
- 全量测试：**120 文件 / 718 测试 PASS**；typecheck PASS；`./scripts/verify.ps1` 待回填。

## 6. Task 6 剩余（阶段 B/C）

- [ ] 依赖/源码/锁文件最终审计（Zod 保留、其他旧依赖清零）与架构文档同步；
- [ ] A3 浏览器功能 e2e（真实 dev server + 浏览器，页面路由/SSE/3D/错误态）；
- [ ] 包体、初始请求数、SSE/Worker 连接数、React render 次数测量；
- [ ] 至少 3 轮性能 A/B（对照 Task 0 基线 worktree/commit）与 A4 GPU/真实浏览器记录；
- [ ] A0–A4 全量证据、进度台账与最终验收；不 push/merge。
