# ADR-013：通用资源提交、类型化身份、容量与轮询 generation（Round 2 · F1 冻结）

- 状态：Accepted（2026-10-30，第二轮整改 F1）
- 基线：`main@9ab2fd3f3cc5304f030dbf7f8e46a414ccd4ebda`（CR-05/07/09/10）
- 关联验收：矩阵 5/7

## 1. 冻结决策

### 1.1 通用读提交的 superseded-write 规则（CR-05）

- 读取开始捕获 `baselineWriteSeq`；提交成功时：
  - 若 `entry.writeSeq !== baselineWriteSeq`（请求开始后发生过任何被接受的权威写入）：
    - 有 `accept` 协议的资源：交给 accept（它可基于版本/epoch/sequence 接受或忽略）；
    - 无 `accept` 的通用资源：**必须 Ignore('superseded-write')**，不得用旧 GET 覆盖更新的 mutation/recovery publish。
- 失败的提交维持 ADR-006 规则（superseded → 只诊断）。
- 测试：GET-old / mutation-new / GET-old 交错；两 Runtime 独立；带版本 accept 的资源保持原有语义（设备 epoch/sequence 测试不回归）。

### 1.2 类型化资源身份（CR-07）

```ts
export interface ResourceIdentity {
  readonly kind: string;      // 'sites' | 'run-detail' | 'equipment-status' | ...
  readonly version: number;   // schema/semantics revision
  readonly key: ResourceKey;  // canonical per-instance key
}
export interface ResourceDefinition<A, E> {
  readonly identity: ResourceIdentity;
  ...
}
```

- Manager 条目保存 `identity`；`handle(definition)` 命中同 key 时校验 `kind/version`（以及 policy 关键字段）一致；不一致抛 `ResourceDefinitionConflictError`，禁止泛型擦除式静默返回旧 handle。
- 所有资源定义文件提供 `identity.kind/version`；测试覆盖同 key 不同 kind/version 的冲突与 TTL 释放后重建同 key 合法场景。

### 1.3 容量不变量（CR-09）

- 单一硬限 `MAX_ENTRIES = 256`：达到上限先按 idle LRU 释放零订阅条目；仍无空间则抛 `ResourceCapacityError`。删除永不触发的 `MAX_ENTRIES_HARD=512` 双水位（或实现真正双水位，但本轮选择单一 256，文档与代码一致）。
- 测试：256 边界、释放后重入、并发 handle 竞争。

### 1.4 轮询 Fiber generation（CR-10）

- `startPolling` 捕获 `scopeGeneration` 与 `scope`；异步 `forkIn` 完成回调必须同时校验：entry 未 removed、polling 仍为 true、`entry.scopeGeneration === startedGeneration`、`entry.scope === startedScope`。不匹配 → interrupt 新 fiber，不得写入 `entry.pollFiber`。
- release 时递增 `scopeGeneration` 并停止 polling；新 retain 创建新 scope 后旧回调不能夺取 pollFiber。
- 测试：1000 次 retain/release 交错 + 微任务让位；断言任何时刻 pollFiber 数 ≤1、无旧 fiber 写入、dispose 后 0 活跃轮询。

## 5. Round 3 静态整改修订（2026-10-30）

- **R3-06 轮询失败分支 generation 守卫**：`startPolling` 的 fork promise `.catch` 与 `.then` 一样必须校验 `!entry.removed && entry.polling && entry.scopeGeneration === startedGeneration && entry.scope === startedScope` 后才能处置 `polling/pollFiber`；旧 generation 的拒绝只允许释放旧 owner，不得写新 entry。当前 generation 的 fiber 终止必须有明确策略（清除 owner 并按资源策略安全重试或置失败），不得出现 polling=true 但无活跃 fiber。
- **R3-09 GPU 预算参数 fail-fast**：程序级 `recoveryBudget` 必须是 `Number.isSafeInteger` 且 1..96（硬上限 96），否则 `createLiteBackend` 立即抛配置异常；`?perf&recoveryBudget=N` 仅验收模式接受严格十进制安全整数，非法值保留默认并产生明确诊断，禁止 NaN/Infinity/非整数进入熔断器。

## 6. Round 4 修订：active command 硬 admission（2026-10-30，R4-08）

状态：源码整改完成；验证边界见 `17-round4-remediation-record.md`。

- 后端新增 `EquipmentCommandOptions.MaxActiveCommandsPerFab`（默认 64，构造期必须 safe integer 1..4096）。`active` 定义为 `revision < 2`（与现有 status=active 语义一致）。
- admission 必须与持久化写入处于**同一个 SQLite 写事务**：`BEGIN IMMEDIATE` 后先判幂等 replay / payload conflict，再在同一事务内 `COUNT revision<2 WHERE site_id=? AND fab_id=?`，超过上限返回 `CapacityExceeded`（命令/幂等/journal 均不落库）。禁止 check-then-act 的进程内预计数、事务外 SELECT；幂等 replay 在容量满时仍返回原 202。
- API 显式映射 HTTP 429 problem：`code=active-command-capacity`、`errorCode=ACTIVE_COMMAND_CAPACITY`、limit/activeCommands；不得静默丢弃或无限创建 actor。
- 前端 `FabRuntimeOptions.maxActiveCommands`（默认 64，镜像后端默认）在 `trackCommand` 处抛 `ActiveCommandCapacityError`；authoritative 恢复可镜像后端已有状态并产生 `active-capacity` 诊断。Correlation `maxEntries` 为硬上限（terminal 优先，其次 oldest active），runtime 以 `maxActiveCommands + maxTerminalWorkflows` 传参。
- 领域策略：校验器只验证 capability/action/可选状态前置条件，未建立每设备唯一 active 约束；本轮采用 FAB 级 admission（与现有 START/STOP/PAUSE 序列语义一致），如未来要求每设备唯一 active，需增加 `(siteId,fabId,equipmentId)` 活动唯一约束并在领域层显式定义。
- R4-09（SSE 扫描游标）：`ApiHost` live loop 在 `pending.HasGap == false` 时始终推进 Site 级 `cursor = pending.LatestSequence`，即使目标 FAB 过滤后无事件；仅实际写出帧时 flush。


## Round 5（进行中）

Round 5 正在整改：POST 前预留 admission；服务端接受后由 FAB registry 注册，接受后注册不再执行容量拒绝。
