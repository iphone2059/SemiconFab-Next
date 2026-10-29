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