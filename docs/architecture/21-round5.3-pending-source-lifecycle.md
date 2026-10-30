# Round 5.3 — Pending Command Event Source Lifecycle

**基线：** `d74ed566ea750cceb18ba3267eed76e212ebcf90`（未更改 GitHub 远端）。

## 复审缺陷

`web_app/src/runtime/command-sources.ts` 的 `commandResults`、`reconnected`、`gaps`、`transportFailures`、`dirty` 使用 `Stream.empty`；`connectionStatus` 使用有限的 `Stream.succeed('failed')`。

`FabRuntime.subscribeSignals()` 使用 `runCommandStream()` 管理这些 Stream，并将正常终止与非预期退出送至 `onSignalExit()`。因此，永久不可用的 pending source 在没有任何连接故障的情况下也会立即终止多个监听 Fiber，产生多余的 `protocol-error` 与权威恢复触发。`CommandEventBridge` 的命令结果消费者也会在 `Stream.empty` 上结束。

## 修复

1. 所有无数据的 pending source 通道改为 `Stream.never`，由 owning Scope 负责中断。
2. `connectionStatus` 改为先发出一次 `failed`，随后保持订阅存活直到 Scope 关闭。
3. `cover()` 始终拒绝、`supersede()` 始终无动作、`pendingAcknowledgements` 始终为 `0`，保持原有权威边界不变。
4. 增加一组契约测试，确认空载通道不会自行结束、失败状态只发出一次且 Stream 不会自行终止。

## 必须维持的不变量

- 长期订阅的 Stream 正常情况下只因 owner 请求终止；缺少 EventSource 不构成一个出人意料的正常 Stream 完成。
- 一个永久失败状态必须可观察，不能被 `Stream.empty` 掩盖。
- 未建立实时连接的 runtime 不能变成 `Healthy`；HTTP Gateway 可用时只能执行权威 HTTP Recovery，并保持 `Degraded`。

## 验证状态

此压缩包只包含根据 GitHub 只读源码确认的定向补丁和测试文件。执行环境无法获得完整仓库、node_modules 或 .NET SDK，未实际运行 Vitest、TypeScript、lint、生产构建和完整 `verify.ps1`。不得将该修改标为 Round 5.3 完整验收通过。
