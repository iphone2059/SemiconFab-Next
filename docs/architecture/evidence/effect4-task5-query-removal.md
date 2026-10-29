# Task 5（阶段 B/C）：消费者迁移与 TanStack Query 删除

- 执行日期：2026-10-29（Asia/Singapore）
- 前序：Task 5 阶段 A `14a3dfc`（Resource Atom 基础设施）
- 权威计划：`docs/architecture/03-migration-plan.md` Task 5；`01-effect4-target-architecture.md` §10
- 状态：**Task 5 完成**；TanStack Query 已从生产源码、manifest、lockfile、workspace 例外中移除

## 1. 应用组合根 / Router

- `AppProviders` 删除 QueryClient/QueryProvider/client prop；仅保留 AppRuntimeProvider + RegistryContext.Provider + RuntimeBootstrap + ErrorBoundary。
- `RouterContext` 只保留 `appRuntime`；`createAppRouter(runtime)` 不再传 queryClient。
- `routes/route-data.ts`：`loadSites(runtime)` / `requireFabSites(runtime, fabId)` 改走 `ensureResource(runtime, sitesResource)`；loader 预加载、intent preload 与页面挂载共享同一 Atom 与单飞读取。
- `RuntimeBootstrap`：sites 改 `useResource(appRuntime, sitesResource)`；命令 gateway 改为 `appRuntime.runPromise`（不再直接 `Effect.runPromise`）。

## 2. Feature 消费者

| 消费者 | 迁移 |
|---|---|
| `workbench/workbench.tsx` | sites/runs/run/results 全部 `useResource`；runs 列表与详情由 policy 每 1.5s 轮询，results 仅在 Run 完成且启用时读取；错误/加载态来自 AsyncResult |
| `workbench/use-run-submission.ts` | 删除 `useMutation/useQueryClient`；直接经 `appRuntime.runPromise(createRun(...))`，成功后精确 `refreshResource(runsResource)`；保留 ScopeToken/幂等键/提交生命周期语义 |
| `catalog/use-catalog-data.ts` | `catalogResource`；`refresh()` 替代 refetch |
| `twin/use-research-playback.ts` | `researchEventsResource`（enabled=mode==='research'；∞ freshness/10min retention） |
| `twin/use-wafer-playback.ts` | `waferRoutesResource`（enabled=waferActive） |
| `twin/use-twin-route-state.ts` | `sitesResource`，错误映射为页面 siteError |
| `twin/twin-equipment-status-pipeline.tsx` | `equipmentStatusResource(siteId,fabId)` + 4s 消费者轮询；SSE 与 REST 共用 per-registry 顺序门；接受帧写资源 Atom，100ms 合批投影；provider/scope 替换时清空 UI 投影但保留 Atom 高水位（只有更新 epoch/sequence 才重新填充） |
| `workbench/use-command-console.ts` | 提交改 `appRuntime.runPromise`，移除最后的生产 `Effect.runPromise` 业务调用 |

## 3. 设备状态 Gate/Atom

- `api/equipment.resource.ts`：`equipmentStatusResource(siteId,fabId)` family；`accept` hook 让 REST 轮询经过同一 gate；`acceptEquipmentStatusSnapshot(runtime, scope, frame)` 是 SSE 唯一写入路径；gate 状态按 `WeakMap<AtomRegistry, Map<scopeKey, gate>>` 隔离，重新激活时从 Atom 已接受快照播种高水位。
- 删除 `api/equipment-status-bridge.ts`（Query cache 投影桥）。
- 资源 Atom 成为唯一快照 owner；gate 仅保留 epoch/sequence 控制元数据，不复制快照。

## 4. 删除清单

- 文件：`api/query-client.ts`、`api/query-keys.ts`、`app/query-provider.tsx`、`api/equipment-status-bridge.ts`。
- 依赖：`package.json` 删除 `@tanstack/react-query`；lockfile 中 `@tanstack/react-query`/`query-core` 节点为 0。
- `pnpm-workspace.yaml` 删除旧 Query release-age 例外（现无例外）。
- 生产源码 Query 引用 grep 为 0。
- `legacy-dependency-gate`：Query 规则由预留改为 **active**（react-query + query-core），生产导入/manifest/lockfile 均为 0。
- `effect-runtime-boundary` 的 `Effect.run*` allowlist 收缩为 `app/app-runtime.ts` 与 `runtime/command-workflow-scope.ts`；所有 Query/UI 过渡适配器已删除。

## 5. 测试迁移

- 新增测试支持：`tests/support/resource-test-runtime.tsx`（隔离 AppRuntime、资源 seed/read、最小 Provider 栈；支持注入已有 AtomRegistry）。
- AppRuntime 工厂新增 registry 注入 seam，使 atom-scope 测试的 UI Atom 与资源 Atom 共享同一 registry（单一 Registry 契约）。
- 将 Query 相关测试改写为资源语义：
  - `router-resource.test.tsx`（loader/preload/mount 单飞、取消等待者不影响共享读取、未知 FAB、typed failure）；
  - `resource-cache.test.tsx`（精确失效、FAB 作用域隔离、run family 身份、失败保留旧值）；
  - `tests/api/*`、`equipment-status-bridge.test.ts` 改为资源 fetch/gate 断言；
  - 所有组件/集成测试改用 seedSites/seedCatalog/seedRuns/seedRun/seedRunResults/seedWaferRoutes/seedEquipmentStatus + ResourceTestProviders/AppProviders runtime；
  - `twin-fab-scope` A01 更新为单 Registry 语义：provider 替换清空 UI 投影，但已接受 high-water 在 Atom/gate 中保留，只接受更新 revision。
- 删除旧 `query-cache.test.tsx`、`router-query.test.tsx`。

## 6. 验证（Task 5 提交前）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | pinned pnpm `typecheck` | PASS |
| 全量测试 | pinned pnpm `test` | PASS：**120 文件 / 718 测试** |
| legacy gate | Query active | PASS（源码/manifest/lockfile 均为 0） |
| 构建 | pinned pnpm `build` | 待回填（verify 内） |
| 完整验收脚本 | `./scripts/verify.ps1` | 待回填 |

## 7. 03 计划 Task 5 退出条件对照

- [x] production 无 `@tanstack/react-query` 导入，QueryClient/QueryProvider/QueryKeys 删除。
- [x] 列表/详情/结果/设备状态读取全部走 Resource Atom，loader 与页面共享 Atom 与单飞读取。
- [x] freshness/idle TTL 明确区分；挂载/导航 freshness 由 ensure helper 触发；窗口聚焦不刷新。
- [x] 刷新失败保留旧值并暴露类型化错误；旧值不伪装为新鲜数据。
- [x] 轮询 1.5s（runs）/4s（equipment）只在消费者存活时运行；最后一个消费者卸载即停止。
- [x] mutation 精确失效 runs 资源（无全局清空）。
- [x] manifest/lockfile/workspace 例外清理完成；Query 依赖清零。

## 8. 后续

- Task 6：RxJS 传输改 Effect Stream/Queue/PubSub；浏览器功能 e2e；包体/连接数/React render 测量；多轮性能 A/B；A0–A4 全量验收与证据。
