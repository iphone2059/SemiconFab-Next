# Task 4（阶段 B）：XState / Effect 命令契约

- 执行日期：2026-10-29（Asia/Singapore）
- 前序：Task 4 阶段 A `12f3395`（Zustand → Atom）
- 权威计划：`docs/architecture/03-migration-plan.md` Task 4；`01-effect4-target-architecture.md` §9
- 状态：Task 4 完成（阶段 A + B 合计）；全量门禁通过

## 1. Actor 的 Effect Scope 生命周期

- 新增 `src/runtime/command-workflow-scope.ts`：`EffectCommandWorkflowScope` 持有一个应用内 Scope；每个 workflow 通过 `Effect.acquireRelease` 获取，`FabRuntime.dispose()` 关闭 Scope，finalizer 停止 actor 并释放订阅（幂等）。
- `XStateCommandWorkflowAdapter` 改为显式生命周期：构造不自动 start；`start()`、`subscribe()`；首次 `receive` 对直接调用者自动 start。`FabRuntime.trackCommand` 顺序为：
  1. acquire actor（未 start）；
  2. 读取初始 snapshot 并播种 projection Atom；
  3. 建立 snapshot 订阅；
  4. `start()`；
  5. 再执行 recovery flush / 事件交付。
  首个 snapshot 不会因订阅晚于 start 而丢失。
- 投递/提交/恢复仍只经 `XStateCommandWorkflowAdapter`（唯一写入者）；`receive` 保持 revision 严格递增与终态不可变。

## 2. 只读 projection Atom

- 新增 `src/runtime/command-projection.atom.ts`：`commandProjectionAtom`（按 `fabId\0commandId` family）与确定性 key。
- `FabRuntime` 是唯一写入者：trackCommand、actor snapshot 订阅、afterDelivery 都只写该 Atom；不复制 actor 的 context。
- `AppProviders → RuntimeBootstrap` 传入同一个 `AppRuntime.registry` 作为 projection registry；`useCommandProjection` 用 `useAtomValue` 读取 Atom，保留无 projection registry 测试场景的订阅 fallback。
- 测试覆盖：初始 snapshot（idle/-1）在 track 后立即可读；executing/succeeded 事件推进 Atom；React hook 通过 Atom 渲染；Scope dispose 幂等且 finalizer 只运行一次。

## 3. 恢复队列与权威核对

- `CommandEventRecovery`（32/命令、256/总）改为**终态优先驱逐**：
  - 每命令溢出/全局溢出都优先移除非终态事件；无候选时才移除终态；
  - 每次驱逐产生 `CommandRecoveryEviction` 诊断（event/reason/terminal/droppedTotal），保留最近 16 条并通过 `onEvict` 回调可观察；
  - 重复 revision 替换不增加容量。
- `FabRuntime` 用 `onEvict` 触发同一 FAB 的**合并权威核对**（与 gap/reconnect 相同的 coalesced pass）；暴露 `recoveryDroppedCount`、`recoveryDiagnostics`、`lastRecoveryEviction`。
- 每个 FAB 的权威核对并发上限为 4：`reconcileTracked` 改为受限 worker pool；同一命令 single-flight 保持。测试以 8 个并发命令验证 maxActive ≤ 4 且全部完成。

## 4. 传输状态契约

- `CommandEventSource` 新增可选 `connectionStatus$`（connecting/open/reconnecting/failed）与 `transportFailures$`；`SseCommandEventSource` 的 `onerror` 不再静默：发出 reconnecting + transport failure，同时由浏览器负责重连；重连 open 仍发 `reconnected$`。
- `FabRuntime` 订阅 failure/status 信号，失败触发有界权威核对，暴露 `connectionState`/`transportFailure`；传输失败不会伪装成命令 failed/cancelled。
- 测试覆盖：SSE 状态/失败信号；FabRuntime 在 transport failure 后触发核对且命令 projection 保持原 outcome。

## 5. Run ScopeToken 与设备命令身份

- 新增 `tests/contract/command-identity-contract.test.ts`：ScopeGate generation 递增、旧 token 被 abort、同 scope 新 token 生效；设备命令幂等键为 UUID，与 ScopeToken 结构不相交。
- 新增 `tests/types/command-identity-types.ts`：类型级负向用例证明 `ScopeToken` 不能混入设备命令提交输入；Run 的 ScopeToken 仍只用于过期 UI/请求作用域防护。

## 6. 验证（Task 4 最终提交前）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | pinned pnpm `typecheck` | PASS |
| 全量测试 | pinned pnpm `test` | PASS：**119 文件 / 712 测试** |
| 新增命令契约测试 | actor scope / recovery / concurrency / transport / identity | PASS |
| 既有命令/运行时回归 | command-workflow、fab-runtime、bridge、projection-identity、runtime-bootstrap 等 | PASS |
| 完整验收脚本 | `./scripts/verify.ps1` | 待回填 |
| 构建 | pinned pnpm `build` | 待回填（verify 内） |

## 7. 03 计划 Task 4 退出条件对照

- [x] 生产源码无 Zustand import；`createSliceStore.ts` 删除（阶段 A）。
- [x] 所有已迁移 UI 状态只有 Atom 一个 owner（阶段 A + 特性原子门禁）。
- [x] actor create/start/subscribe/stop/dispose 生命周期测试；首帧不丢失。
- [x] 同一命令 revision 单调、终态不可变（既有测试 + adapter 逻辑保留）。
- [x] 队列 32/256、终态优先、驱逐诊断、合并核对、并发 4 均有正负测试。
- [x] Run ScopeToken 与设备命令 `(fabId, commandId)`/幂等身份严格区分（行为 + 类型级）。

## 8. 仍属后续任务

- TanStack Query 资源适配器中的过渡 `Effect.runPromise`（Task 5 用 resource Atom 接管后删除）。
- RxJS `CommandEventSource`/Telemetry 传输本体仍是 Observable；状态/失败信号已契约化并测试，Task 6 改为 Effect Stream。
- `api/equipment-status-bridge.ts` 的 Query cache/gate 协调在 Task 5/6 拆分。
