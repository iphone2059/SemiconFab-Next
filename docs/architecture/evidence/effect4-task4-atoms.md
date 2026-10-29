# Task 4（阶段 A）：Zustand → Atom UI 状态迁移

- 执行日期：2026-10-29（Asia/Singapore）
- 前序：Task 0 `b946996`/`9ccebf3`、Task 1 `0d6ff12`、Task 2 `857b5ac`、Task 3 `9afe9a0`
- 分支：`refactor/effect4-flat-20261029`
- 权威计划：`docs/architecture/03-migration-plan.md` Task 4（本阶段只覆盖 UI 状态迁移；XState/Effect 命令契约见阶段 B）
- 状态：Zustand 已从生产源码、manifest、lockfile 移除；全量测试通过；Task 4 未完成（命令阶段待做）

## 1. 迁移内容

来源：旧分支 `39ef4fe` + `be1da31` 已验证的 Atom 状态实现，按 Task 1 扁平路径与 Task 2 AppRuntime/Registry 结构移植。

### 1.1 状态模块（每 feature 独立 Atom，保留纯 reducer）

| 模块 | 内容 |
|---|---|
| `state/locale.atom.ts` | `localeAtom`（keepAlive）+ `localeActions`（接收 registry）；首次 read 时按当前 storage 初始化；语言/主题持久化与 deny-storage 行为保留 |
| `state/preferences.atom.ts` | 纯偏好读取/规范化 helper（不变） |
| `catalog/catalog.atom.ts` | Catalog UI 状态（view/domain/category/query/selection/detail/page/import 生命周期）与纯 reducers |
| `twin/twin-ui.atom.ts` | Twin UI 原子（layer、xray、source、dialog、tour 状态等） |
| `twin/twin-page.atom.ts` | FAB 作用域页面投影（site/fab scope、liveToolStates、statusFeed、MES/inspector 等） |
| `twin/twin-demo.atom.ts` | DEMO 播放/时钟状态 |
| `workbench/workbench.atom.ts` | Workbench 表单/选择/submitError |
| `state/runtime-store.ts` | 生命周期/渲染/Twin 投影等字段按原子拆分（旧共享 Zustand store 的替代） |
| `state/atom-equality.ts` | 原子相等性辅助 |

- 所有 actions 显式接收 `AtomRegistry`（来自 React `RegistryContext` 或测试注入），不存在模块级私有 registry；`RegistryContext` 由 AppProviders 的 AppRuntime 提供。
- 删除 `state/create-slice-store.ts`（Zustand 工厂）与全部 `zustand` 依赖/导入。
- 高频 hover/帧更新仍绕过 React 通知（atom selector 粒度）；Twin 页面级字段仍触发页面重渲染，子面板字段只触发子面板（`twin-subscription-isolation` 测试）。

### 1.2 消费者与测试

- 从旧分支移植 atom 化后的 controllers/components：catalog、Twin（HUD/sidebar/dialogs/inspector/playback/tour/keyboard）、Workbench、equipment-status pipeline 等；保留 Task 3 的 Effect HTTP 适配（use-run-submission/use-command-console 为 Task 3/4 组合版本）。
- 移植测试支持：`tests/support/atom-scope.tsx`（隔离真实 registry + React context）、`reset-ui-atoms.ts`（按 registry 重置全部 UI atoms）、相关 feature/integration/architecture 测试。
- 新增/移植原子架构门禁：`tests/architecture/feature-atoms.test.ts`、`remaining-state.test.ts`、`ui-atoms.test.ts`；删除旧 `zustand-stores.test.ts`。
- `tests/state/atom-preferences.test.tsx` 适配 AppRuntime：独立 runtime 注入测试，默认应用 runtime 跨 provider remount 保持不变。

## 2. 依赖清理

- `package.json` 删除 `zustand`；`pnpm install` 后 lockfile 中 `zustand@` 节点为 0。
- `tests/architecture/legacy-dependency-gate.test.ts` 的 Zustand 规则由预留改为 **active**：生产源码导入、manifest、lockfile 节点均为 0。
- `create-slice-store.ts` 已删除，测试目录中的旧 Zustand 门禁文件已删除。

## 3. 验证（阶段 A 提交前）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | pinned pnpm `typecheck` | PASS |
| 全量测试 | pinned pnpm `test` | PASS：**114 文件 / 702 测试** |
| 原子/门禁测试 | feature-atoms + remaining-state + ui-atoms + legacy gate | PASS：13 测试 |
| 完整验收脚本 | `./scripts/verify.ps1` | 待回填 |
| 构建 | pinned pnpm `build` | 待回填（verify 内） |

## 4. 尚未完成的 Task 4（阶段 B）

- XState actor 的 Effect Scope 生命周期：`Effect.acquireRelease` 创建/停止、subscribe-before-start/首帧播种、projection Atom 桥接与退订、唯一 adapter 写入者。
- 命令提交/SSE/恢复按 `(fabId, commandId)` 串行进入 adapter；per-command single-flight；每 FAB 权威核对并发上限 4。
- 恢复队列：终态优先驱逐、可观察驱逐诊断、容量溢出触发合并权威核对；32/256 上限。
- 命令事件契约补 `transport-failure`/`reconnected`/`replay-gap` 可观察状态，EventSource `onerror` 不再无条件吞掉。
- Run `ScopeToken` 与设备命令幂等/身份分离的测试。
- 完成后才能将 Task 4 标记完成并移除 Task 3/4 过渡 `Effect.run*` 适配项（其中 Query resource 适配器属于 Task 5）。
