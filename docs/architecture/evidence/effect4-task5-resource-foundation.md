# Task 5（阶段 A）：Resource Atom 基础设施

- 执行日期：2026-10-29（Asia/Singapore）
- 前序：Task 4 完成（`12f3395`、`e7d2f49`）
- 权威计划：`docs/architecture/03-migration-plan.md` Task 5；`01-effect4-target-architecture.md` §10
- 状态：基础设施完成；消费者仍走 TanStack Query（阶段 B/C 迁移后删除 Query，本文件不声称 Task 5 完成）

## 1. 资源策略

新增 `src/api/resource-policy.ts`，集中定义与旧 Query staleTime/gcTime/refetchInterval 等价的资源策略：

| 资源 | freshness | idle TTL | 轮询 |
|---|---|---|---|
| sites | 30s | 5min | — |
| catalog | 60s | 5min | — |
| runs 列表 / run 详情 | 0 | 5min | 1.5s（仅消费者挂载时） |
| run results | 0 | 5min | —（Run 完成后才启用） |
| equipment status | 0 | 5min | 4s（仅页面挂载时；SSE 仍走顺序门） |
| research events / wafer routes | ∞ | 10min | — |

- `pollMs` 只由已挂载的 React 消费者驱动；最后消费者卸载即清理 interval，不存在全局轮询。
- 没有窗口聚焦刷新。

## 2. Resource Atom 工具（`src/api/resource.ts`）

- `Resource<A,E>`：一个 `Atom.Writable<AsyncResult<A,E>>` + 一个 `Effect<A,E,never>` loader + policy。Atom 是唯一值所有者，freshness/idle TTL 是控制元数据，不存在第二份缓存。
- `makeResource`：初始 `AsyncResult.initial`；使用 `Atom.setIdleTTL(Duration.millis(policy.idleTtlMs))`；AppRuntime 创建 registry 时始终设置 `defaultIdleTTL: 300s`（per-atom TTL 需要 registry TTL bucket 生效，已在测试中验证）。
- `resourceFamily(key)`：按逻辑身份 memoize，相同 key 返回同一 Resource（loader/page/SSE 共享）。
- `refreshResource(runtime, resource)`：
  - 同一 Resource 只有一个 in-flight Promise，所有等待者共享；取消单个等待者不会取消共享读取；
  - 刷新期间保留旧 `AsyncResult.Success` 并标记 waiting；
  - 失败写入 `AsyncResult.failWithPrevious`，保留 `previousSuccess` 与类型化错误，不把旧值伪装成新鲜数据；
  - AppRuntime 已 dispose 后拒绝启动/写入，避免关闭后回调污染。
- `ensureResource`：freshness-on-mount/navigation 的自定义 helper（官方 `Atom.swr` 只在 atom 重建时判定 stale）：fresh success 直接复用；否则触发共享刷新。
- `setResourceValue`：SSE/mutation 接受快照写入；`invalidateResource`：精确失效单个资源（无全局清空）。
- `useResource(runtime, resource, { enabled })`（`src/api/use-resource.ts`）：`useAtomValue` + 挂载 ensure + 可选轮询 + unmount 清理；返回 `{result,data,error,isInitial,isFetching,isError,refresh}`（资源语义，不是 Query 兼容包装）。

## 3. 已定义的 Resource（尚未接入消费者）

- `sitesResource`、`catalogResource`、`researchEventsResource`、`waferRoutesResource`；
- `runsResource`、`runResource(runId)`、`runResultsResource(runId)`（family 确定性身份）。
- 这些定义复用既有 typed Effect loader；暂时仍保留 Query adapters 供现有消费者使用，阶段 B/C 切换后删除。

## 4. 测试

新增 `tests/api/resource.test.tsx`（7 测试）：

- 并发 ensure 共享一次请求，fresh value 不再请求；
- stale 刷新保留旧值；失败保留 previousSuccess 且错误类型化；
- idle TTL 回收后即使 freshness=∞ 也会在挂载时重新读取（明确区分 freshness 与 idle TTL）；
- SSE/mutation 写入与精确 invalidate；
- 策略数值/确定性 family 身份；
- `useResource` 挂载 ensure、轮询仅挂载期间、卸载后停止；
- `enabled=false` 不请求；刷新失败时保留旧值并暴露 isError。

全量测试：**120 文件 / 719 测试 PASS**；typecheck PASS；`./scripts/verify.ps1` 待回填。

## 5. 阶段 B/C 待办（Task 5 未完成）

1. 消费者迁移：RuntimeBootstrap、workbench、catalog、Twin playback/route-state、equipment-status pipeline；
2. Router loader/context 改为 AppRuntime + `ensureResource`，删除 QueryClient；
3. mutation 精确失效 runs 资源；删除 query-client/query-keys/query-provider/equipment-status-bridge；
4. 删除 `@tanstack/react-query` 依赖与 legacy gate 中 Query 规则；移除对应 `Effect.runPromise` 过渡 allowlist；
5. 迁移/重写 Query 相关测试为资源 Atom 语义测试（RES-01..），保留 preload/取消/isolation 断言。
