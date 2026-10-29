# Task 2：Effect AppRuntime 与单一 AtomRegistry（执行记录）

- 执行日期：2026-10-29（Asia/Singapore）
- 基线提交：`4fc8a94`；前序：Task 0 `b946996`、Task 1 `0d6ff12`
- 分支：`refactor/effect4-flat-20261029`
- 权威计划：`docs/architecture/03-migration-plan.md` Task 2；`01-effect4-target-architecture.md` §5
- 状态：Task 2 完成（见 §4 验证）；产品行为保持 Query/Zustand 过渡实现不变

## 1. 依赖与版本

| 依赖 | 版本 | 说明 |
|---|---|---|
| `effect` | `4.0.7` 精确锁定 | 提供 Effect/Layer/Scope/ManagedRuntime 等 |
| `@effect/atom-react` | `4.0.7` 精确锁定 | 官方 React Atom 绑定 + `scheduleTask` |
| `scheduler` | 锁文件唯一解析 `0.28.0`（由 react-dom 引入） | 未新增直接依赖：`@effect/atom-react` peer 为 `>=0.25.0 <0.29.0`，安装图已有单一 0.28.0，满足 01 §2 “验证单一解析与 peer 范围”的要求 |
| `react` / `react-dom` | 19.3.1 | 不变 |

- manifest/lockfile 同步；`pnpm install --frozen-lockfile` 见 §4。
- 未新增 `minimumReleaseAgeExclude`（当前 pnpm 供应链策略未拦下 4.0.7）；未引入 Effect HTTP/RPC 服务端。
- 未移除任何旧依赖（Query/Zustand/Zod/RxJS 仍按计划留待 Task 3–6）。

## 2. 组合根实现

### 2.1 AppRuntime（`src/app/app-runtime.ts`）

- `createApplicationRuntime({ layer, defaultIdleTTL? })`：应用唯一组合根工厂。
  - 创建单一 `AtomRegistry.make({ scheduleTask, defaultIdleTTL: 300_000 })`（`DEFAULT_IDLE_TTL_MS` 显式常量；不依赖 `RegistryProvider` 默认 400ms）。
  - `ManagedRuntime.make(layer)`：共享 Layer 惰性构建且只构建一次；runtime 持有应用级 Scope。
  - 提供 `runPromise` / `runSync` / `runFork` 三个受控 Effect 执行入口；业务模块不得自行 `Effect.run*`。
  - `dispose()`：幂等；先 `ManagedRuntime.dispose()`（中断 runtime-owned Fiber、运行 Layer finalizer），再 `registry.dispose()`（释放 Atom 节点）。
- `applicationRuntime: AppRuntime<never>`：应用入口导入一次的默认实例（`Layer.empty`，Task 2 尚无共享服务；Task 3+ 扩展 layer）。测试必须用工厂创建隔离实例。

### 2.2 React 与 Router 共享同一实例

- `src/app/app-runtime-provider.tsx`：`AppRuntimeProvider` + `useAppRuntime()`，不创建 Registry/Runtime。
- `src/app/app-providers.tsx`：`AppRuntimeProvider` → `RegistryContext.Provider value={runtime.registry}` → QueryProvider（过渡）→ RuntimeBootstrap → ErrorBoundary；接受 `runtime` prop 供测试注入隔离实例。
- `src/routes/router.tsx`：`createAppRouter(runtime)` 把同一 `appRuntime` 注入 RouterContext（与 `queryClient` 共存，Task 5 删除 Query 后仅保留 AppRuntime/资源 facade）；默认 `router` 使用 `applicationRuntime`；`Register` 类型保持不变。
- `src/routes/root.route.tsx`：`RouterContext` 增加 `appRuntime: AppRuntime<never>`。
- 未创建第二个 Registry/Runtime；React 卸载不会 dispose 应用 runtime（应用生命周期所有者负责）。

## 3. 测试与门禁

| 测试/门禁 | 覆盖 | 结果 |
|---|---|---|
| `tests/integration/app-runtime.test.tsx` | 两个独立 runtime 的 Atom 隔离；Router context 与默认 runtime 同实例；Layer 只构建一次且 dispose 运行 finalizer；dispose 幂等且 runtime 不可复用；runtime-owned Fiber 在 dispose 时中断并运行 finalizer；idle TTL 到点回收节点；StrictMode 下 React 与 Router 共享同一 Registry 且卸载不 dispose | PASS（5 测试） |
| `tests/architecture/effect-runtime-boundary.test.ts` | `Effect.run*` 仅 `app/app-runtime.ts`；`AtomRegistry.make`/`ManagedRuntime.make` 仅组合根；`RegistryContext.Provider` 仅 `app/app-providers.tsx`；AppProviders 使用 `runtime.registry` | PASS（2 测试） |
| Task 1 架构门禁回归 | 扁平目录/import graph/contract rules/boundaries/feature-ui/source-layout | PASS |

## 4. 全量验证（Task 2 提交前）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | pinned pnpm `typecheck` | PASS |
| 全量测试 | pinned pnpm `test` | PASS：109 文件 / **675 测试** |
| 构建 | pinned pnpm `build` | PASS（2100 modules；独立 twin-page chunk 保留） |
| 完整验收脚本 | `./scripts/verify.ps1` | PASS（VERIFY_EXIT=0，含 frozen install/typecheck/test/build/.NET/架构门禁） |
| 安装 | pinned pnpm `install --frozen-lockfile` | PASS |

## 5. 03 计划 Task 2 退出条件对照

- [x] 同一 App 内 React 与 Router 读取同一 Registry（测试断言 RouterContext.appRuntime 与 React context 同实例）。
- [x] 两个独立测试 Registry 的 Atom 状态完全隔离。
- [x] 应用释放时没有遗留 Fiber/finalizer：runtime-owned Fiber 中断测试 + Layer finalizer 只运行一次；Registry 在 dispose 后不可再运行。
- [x] StrictMode 重挂不会创建第二个长期 Runtime（AppProviders 只接收/提供 runtime，不构造）。
- [x] 共享 Layer 不会按每个 Atom 重复构建（并发+串行多次 run 只 build 一次）。
- [x] `Effect.run*` 的使用点落入明确 allowlist（架构测试）。

## 6. 过渡说明

- 资源读取 facade（`ensureResource`/资源 Atom）在 Task 5 建立；Task 2 的受控执行边界是 `runPromise/runSync/runFork`，后续资源模块通过 AppRuntime 调用。
- RuntimeBootstrap 目前仍在 React effect 中装配 FAB runtimes（旧实现）；FAB 级 Scope、SSE/Worker 与 StrictMode 产品级清理在 Task 4/5/6 按计划迁移，本任务只冻结应用级 Runtime/Registry 所有权。
- `applicationRuntime` 的默认 Layer 为 `Layer.empty`；Task 3 引入 HTTP/Clock 等共享服务后替换为组合 Layer，仍由同一 factory 构建。
