# ADR-006：资源身份、状态机与提交协议（Phase B 冻结接口）

- 状态：Accepted（Phase A，2026-10-29；2026-10-30 补充读取控制态与有界生命周期）
- 基线：`1fb25ffc36b5b65813f031c8d889063964b4d1bd`
- 取代：`01-effect4-target-architecture.md` 中 Resource Atom 的模块级 single-flight/family 描述；`03-migration-plan.md` 中资源相关阶段
- 关联不变量：INV-01/02/03/04/05/06/10；关联测试：CORE-001..006

## 1. 背景与已证缺陷

1. `api/resource.ts` 模块级 `WeakMap<Resource, Promise>`：两个独立 AppRuntime 的同一 Resource 共享 in-flight（INV-01 违反）。
2. `resourceFamily` 使用永不淘汰的 `Map<Key, Resource>`：动态 Run 资源定义无限增长（INV-06 违反）。
3. `refreshResource` 在请求开始时捕获 previous，异步完成时把它交给 accept，并在通用 `catch` 中写 Failure；失败可覆盖此后 SSE 成功（INV-03 违反）。
4. `equipment.resource.ts` 的 accept 在 Gate 拒绝时返回 previous，调用方仍 `registry.set(AsyncResult.success(previous))`；可构造 10 → SSE 12 → REST 11 被拒 → 写回 10 的 P0 回归。
5. `useResource` 每个组件各自 `setInterval` 轮询：两个消费者 = 两个 timer（INV-05 违反）。
6. 设备 gate 以 per-registry Map 保存高水位（控制元数据），但快照比较与 Atom 内容分属两处，Activate/reset 时序可导致旧快照被当作新基线。

## 2. 决策

### 2.1 身份与所有权

- `ResourceKey` 是规范化的不可变字符串，由资源模块的构造函数生成（如 `equipment-status\u0000{siteId}\u0000{fabId}`、`run\u0000{runId}`）。同一 key 在一个 AppRuntime 内最多一个协调条目与一个 Atom。
- 静态资源（sites/catalog/runs/equipment-status/research/wafer）使用模块级**不可变定义**（`ResourceDefinition`），不得携带任何可变请求状态。
- 动态资源（run detail/results 等）的定义由 AppRuntime 的 ResourceManager 按需创建并缓存；定义与协调条目同属 manager，随空闲 TTL/容量回收。
- 快照唯一所有者：`handle.atom`（每个 manager 创建，注册在 `runtime.registry`）。不同 AppRuntime 的同 key Atom 值与请求完全隔离（AtomRegistry 本身按 registry 存值；已实测同一 Atom 在两个 registry 中互不影响）。

### 2.2 允许的控制元数据（不得含 payload 副本）

每个 key 的 manager 条目只允许：`requestIdCounter`、`currentRequestId`、`inFlight: { requestId, promise, interrupt }`、`writeSeq`、`subscribers: number`、`scope: Closeable`、`scopeGeneration`、`pollFiber`、`idleTimer`、`idleAt`、`lastDiagnostic`。禁止 `lastSuccess` 数据缓存、禁止在 manager 中保存 `A`（设备高水位以 Atom 当前 `AsyncResult.value(...)` 在同一提交段读取，见 2.5）。

### 2.3 状态模型（唯一互斥 union）

采用 Effect `AsyncResult<A, E>` 承载下列语义，并禁止额外变体：

| 语义 | AsyncResult 表示 | 读取 API |
|---|---|---|
| Initial | `initial()`（无 value、无 error、非 waiting） | `isInitial` |
| Loading | `initial({ waiting: true })` | `waiting && !value` |
| Ready | `success(value)` | `isSuccess` |
| Refreshing | `success(value, { waiting: true })` | `isSuccess && waiting` |
| FailedWithoutValue | `failure(error)`（无 previousSuccess） | `isFailure && previousSuccess === none` |
| FailedWithPrevious | `failWithPrevious(error, { previous })` | `isFailure && previousSuccess === some` |

- `previousSuccess` 只能来自同一 Atom 当前态；实现先读 registry 再构造，禁止跨资源/跨 registry 复用。
- 错误呈现：UI 只从 failure 的 error 渲染错误态；ready/refreshing 的 value 永不被用作“新请求成功”的证据。
- 序列化：资源 Atom 值不进入路由/SSR/持久化序列化；无 JSON 状态序列化契约。

### 2.4 提交协议（唯一 Publish | Ignore 出口）

所有读取完成、SSE 推送、mutation 结果、recovery 快照都必须经 ResourceManager 的同步提交函数。提交函数**不得包含 await/微任务切换**：

1. 若 `runtime.disposed` 或该 key 的 `scope.closed` → `Ignore('disposed'|'scope-closed')`。
2. 读取 `const current = registry.get(handle.atom)`（与后续写入同一同步段）。
3. 对 read 来源：
   - `candidate.requestId !== entry.currentRequestId` → `Ignore('stale-request')`；
   - 成功候选：执行 `definition.accept?.(value, ctx)`。Ignore 不发布候选 payload，但当前 request 可结束等待控制态；仅明确标记 `unchanged: true` 的有效同版本、同内容读取可清除旧读取错误。控制态更新只使用同一 Atom 的当前/previousSuccess 值，保留原 timestamp，不增加 writeSeq；
   - 失败候选：若 `candidate.baselineWriteSeq !== entry.writeSeq`（请求开始后已有被接受的更高代写入，如 SSE）→ `Ignore('superseded-write')`；否则以 `failWithPrevious(error, { previous: 当前同一 Atom 的 previousSuccess })` 写入。
4. 对 push/mutation/recovery 来源：必须执行 `accept`（如有），Publish 时写入并 `writeSeq += 1`；无 accept 的资源由 key 级 generation 保证幂等（相同值可写但需记录诊断；推荐调用方先去重）。
5. 判定 Publish 时：`entry.writeSeq += 1`，`entry.lastWriteRequestId = requestId`，`registry.set(atom, nextState)` 恰好一次，返回 `Publish(next value)`。
6. 所有 Ignore 都追加有界诊断（最近 32 条）。push/mutation/recovery 的 Ignore 不写 Atom；read 的 Ignore 仅允许完成当前 request 的控制态，不得安装被拒绝 payload，不得推进 timestamp/writeSeq。disposed、scope-closed、stale-request 或已被后续写入取代的读取不得覆盖新状态。

顺序比较的唯一来源：
- 设备快照：`accept` 从 `ctx.current` 的生效值（Success 或 failure.previousSuccess）读取上次已接受的 `(epoch, sequence)`，规则：无效帧或不递增版本 → Ignore('rejected')；否则 Publish。read 来源中，结构/作用域有效、epoch/sequence/generatedAt 与各工具状态均等于已接受快照时，额外返回 `unchanged: true`，只确认读取恢复。旧版本、无效帧、同版本但内容冲突均不能清除旧错误。
- 通用资源：read 成功由 requestId 单飞/最新请求胜出；push 由调用方保证值语义（mutation 结果视为权威快照）。

### 2.5 设备状态唯一提交端口（EquipmentStatusCommit）

- `api/equipment.resource.ts` 只暴露不可变 `equipmentStatusDefinition(siteId, fabId)` 与协议校验；所有 REST/SSE/重连快照/权威恢复写同一 handle。
- 删除 `gatesByRegistry`、`equipmentStatusGate`、`activateEquipmentStatusScope`、`resetEquipmentStatusGates`、`acceptEquipmentStatusSnapshot`、`setResourceValue`。高水位只从 Atom 当前值在同一同步提交段得出，不再有第二份 gate 状态。
- `EquipmentStatusScope` 的 epoch/sequence 高水位与 Atom 内容在同一提交段演进：提交函数内读→比较→写，中间无 await。
- 重连/浏览器重挂/Scope 重建使用独立 generation（见 ADR-007）；旧 EventSource 回调必须被 abort，提交时 scopeGeneration 不匹配即 Ignore。

### 2.6 单飞、订阅与轮询

- `refresh/ensure` 按 (manager, key) 单飞：`inFlight` 存在即共享同一 Promise；不同 manager 不共享。每次 load 使用原始启动时的有界 deadline：默认 30 秒，可通过 `policy.loadTimeoutMs` 覆盖（有限正数且不超过 2,147,483,647 ms）。超时中断真实 Effect，使 fetch 与响应体消费收到 abort，释放单飞槽并产生 `ResourceReadTimeoutError(key, timeoutMs)`；不自动重试 POST。
- `retain(handle)` 返回 release：`subscribers += 1`；首个订阅者创建 ResourceScope（`Scope.forkUnsafe(appRootScope)`）、启动轮询 Fiber（若 policy.pollMs）、按 freshness 触发一次 ensure；最后一位 release 时停下轮询 Fiber、记录 `idleAt`，按 `idleTtlMs` 启动释放定时器。
- 每个 key 最多一个轮询 Fiber；轮询体只调用 `refresh`（本身受单飞约束）。组件/loader 禁止自建 interval。
- `idleTTL` 与 freshness、读取 deadline 分离：freshness 决定 mount 时是否发请求；idleTTL 决定零订阅后多久释放控制元数据与 Atom 节点（同时设置 `Atom.setIdleTTL` 与 manager 定时器双重保障）。最后 release 后已启动 GET 可继续供 StrictMode 重挂载或 loader/prefetch 共享，但只能存活至原始 deadline 或固定 idleTTL 中较早者；在飞请求不得续期 idleTTL。TTL 淘汰会真实中断读取，迟到结果不得写入已移除或重新创建的资源。

### 2.7 有界保留（动态资源）

- Manager 容量：`maxEntries = 256`（软上限）、`maxEntriesHard = 512`。超软上限先按 idle LRU 释放（仅零订阅条目）；仍超然后触发 `capacity` 诊断并拒绝创建（`handle()` 抛 `ResourceCapacityError`，调用方必须显示错误而不是静默）。
- 最后订阅者离开后按 `idleTtlMs` 到期：关闭 ResourceScope（中断轮询/在飞 Fiber）、删除 handle/definition、删除 idle timer；Atom 节点由 registry idle TTL 回收。
- 压力测试必须同时断言：manager 条目数有界、`getNodes()` 有界、resource scope 数 = 0（TTL 后）、无保留轮询 Fiber；不得只断言 `getNodes()` 减少。

### 2.8 冻结 API（web_app/src/api/resource.ts + resource-manager.ts）

```ts
export type ResourceKey = string;
export interface ResourcePolicy { readonly freshnessMs: number; readonly idleTtlMs: number; readonly pollMs?: number; readonly loadTimeoutMs?: number }
export type IgnoreReason = 'disposed' | 'scope-closed' | 'stale-request' | 'superseded-write' | 'rejected' | 'capacity';
export type CommitDecision<A> =
  | { readonly _tag: 'Publish'; readonly value: A }
  | { readonly _tag: 'Ignore'; readonly reason: IgnoreReason; readonly unchanged?: true };
export interface ResourceCommitContext<A> {
  readonly current: AsyncResult.AsyncResult<A, unknown>;
  readonly origin: 'read' | 'push' | 'mutation' | 'recovery';
  readonly requestId: number | undefined;
  readonly baselineWriteSeq: number;
  readonly writeSeq: number;
  readonly scopeGeneration: number;
}
export interface ResourceDefinition<A, E> {
  readonly key: ResourceKey;
  readonly load: Effect.Effect<A, E, never>;
  readonly policy: ResourcePolicy;
  readonly accept?: (next: A, context: ResourceCommitContext<A>) => CommitDecision<A>;
}
export interface ResourceHandle<A, E> {
  readonly key: ResourceKey;
  readonly atom: Atom.Atom<AsyncResult.AsyncResult<A, E | ResourceReadTimeoutError>>;
  readonly definition: ResourceDefinition<A, E>;
}
export interface ResourceManager {
  readonly runtime: AppRuntime<never>;
  handle<A, E>(definition: ResourceDefinition<A, E>): ResourceHandle<A, E>;
  state<A, E>(handle: ResourceHandle<A, E>): AsyncResult.AsyncResult<A, E | ResourceReadTimeoutError>;
  value<A, E>(handle: ResourceHandle<A, E>): A | undefined;
  ensure<A, E>(handle: ResourceHandle<A, E>): Promise<A>;
  refresh<A, E>(handle: ResourceHandle<A, E>): Promise<A>;
  publish<A, E>(handle: ResourceHandle<A, E>, value: A, origin?: 'push' | 'mutation' | 'recovery'): CommitDecision<A>;
  retain<A, E>(handle: ResourceHandle<A, E>): () => void;
  release(key: ResourceKey): void;
  readonly diagnostics: readonly { key: ResourceKey; origin: string; reason: IgnoreReason; requestId?: number }[];
  readonly stats: { readonly entries: number; readonly inFlight: number; readonly polling: number; readonly scopes: number };
  dispose(): void;
}
export class ResourceCapacityError extends Error {}
export class ResourceReadTimeoutError extends Error { readonly key: ResourceKey; readonly timeoutMs: number; }
export function createResourceManager(host: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly services: ManagedRuntime.ManagedRuntime<never, never>;
  readonly rootScope: Scope.Scope;
  readonly isDisposed: () => boolean;
}): ResourceManager;
```

### 2.9 删除清单（无兼容层）

- `resourceFamily`、`makeResource`、`Resource` 旧接口、`ResourceOptions`、模块级 `inFlight` WeakMap。
- `refreshResource` / `ensureResource` / `setResourceValue` / `resourceValue` / `invalidateResource`。
- `equipmentStatusGate` / `activateEquipmentStatusScope` / `resetEquipmentStatusGates` / `acceptEquipmentStatusSnapshot` / `gatesByRegistry`。
- 所有资源模块的模块级 Atom 与动态 family；改为导出 `*Definition`。
- `realtime/equipment-status.gate.ts` 改为纯比较函数（可由定义内联），不再持有可变高水位。
- `use-resource.ts` 的组件级 interval 与 `refresh/ensure` 直调删除，统一走 manager。

### 2.10 React 绑定契约

- `useResource(runtime, definition, options?)`：`const handle = runtime.resources.handle(definition)`（按 key 稳定）；`useAtomValue(handle.atom)`（RegistryContext 已由 AppProviders 提供同一 registry）；`useEffect` 内 `retain` + 首次 `ensure`，cleanup 调 release。`enabled === false` 时不 retain/ensure/poll，但仍可读 Atom。
- `refresh()` 调 `manager.refresh(handle)`；错误只从 Atom 读取。组件不得读写 `registry` 本身。
- Router loader：`runtime.resources.ensure(runtime.resources.handle(def))`，不得创建第二份缓存或模块级 Promise。

## 3. 测试要求

- CORE-001..006 全部以受控 deferred/fake clock 实现 RED→GREEN；测试必须能在旧实现上失败（提交前用当前 HEAD 验证 RED 记录到证据文件）。
- 语义性质测试：随机交错 REST/SSE 的 (epoch,sequence)（含同级、回退、重复、无效帧），最终 Atom 值等于最高代有效快照；失败只产生诊断，不改变已接受值。
- 单飞/取消：慢请求 + 两个消费者；最后 unmount 后无轮询 Fiber，已启动读按原 deadline/固定 idleTTL 有界共享；资源淘汰或 AppRuntime 关闭后在飞回调不写 Atom。覆盖 fetch/响应体挂起、timeout 后重试、无订阅预读、StrictMode 重挂载及淘汰后迟到结果。
- 控制态：同版本响应完成等待；失败后有效同版本同内容的 200 清除旧错误；旧版本/无效/冲突响应不得伪造恢复，控制更新不修改 payload/timestamp/writeSeq。
- 有界性：1000+ 唯一 key 反复 mount/unmount/TTL 到期，`manager.stats.entries`、`scopes`、`getNodes()` 有界；`eventLoop` 无残留 timer。
- 旧实现 RED 证据与 GREEN 证据写入 `docs/architecture/evidence/phase-b-*.md`，绑定 commit SHA。

## 4. 后果

- Resource 定义无模块级可变状态，跨 Runtime 隔离由构造保证而非约定。
- 每次写入都有唯一同步判定点；Ignore 可观测、可测试。
- 动态资源定义与 Fiber/定时器由 manager 统一回收；需要测试同时检查堆与节点。
- 旧 API 删除会引发大量编译错误，这是迁移的预期信号，不允许加 shim。
