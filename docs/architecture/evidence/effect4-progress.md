# Effect 4 + 单层目录重构进度

- 权威文档：`docs/architecture/README.md`、`01-effect4-target-architecture.md`、`02-flat-source-layout.md`、`03-migration-plan.md`、`04-acceptance-and-architecture-gates.md`
- 基线：`4fc8a94a3f10d185c8bef7929349ac6ccb2b8792`
- 分支：`refactor/effect4-flat-20261029`
- 工作树：`.local/worktrees/effect4-flat`
- 更新：2026-10-29

## 任务状态

| Task | 状态 | 提交 / 证据 |
|---|---|---|
| Task 0 基线与文件归属冻结 | 完成（性能/浏览器基线待补） | `b946996`；`docs/architecture/evidence/effect4-task0-*.md` |
| Task 1 单层目录 + code-based routing | 完成，全量门禁通过 | `0d6ff12`；`docs/architecture/evidence/effect4-task1-flat-layout.md` |
| Task 2 Effect AppRuntime / 单一 AtomRegistry | 未开始 | — |
| Task 3 Effect Schema + HTTP transport | 未开始（旧分支有可复用实现，需移植到扁平路径） | 旧分支 `refactor/effect-consolidation-20261029` @ be1da31 参考 |
| Task 4 Zustand→Atom + XState/Effect 命令契约 | 未开始 | — |
| Task 5 Query→Resource Atom + resource-policy | 未开始 | — |
| Task 6 Effect Stream/SSE/REST + 依赖清零 + 验收 | 未开始 | — |

## Task 1 后事实

- `web_app/src` 为严格单层：根仅 `main.tsx`，16 个一级模块目录，无嵌套目录，195 个生产 TS/TSX 文件。
- `@tanstack/router-plugin`、router-generator 已从 manifest/lockfile 移除；`routeTree.gen.ts` 已删除；路由为 `routes/*.route.tsx` + `routes/route-tree.ts` 的 code-based 树。
- `@/* -> ./src/*` 唯一别名已配置于 tsconfig paths、Vite/Vitest resolve.alias。
- 架构门禁已改为扁平规则：import graph R0/R0b/R2/R3/R4/R5/R6、contract rules R7/R9/R12/R13/R14、boundaries ARCH-06/07/11/M5b/M5c/ARCH-08、feature-ui-ownership，以及新增 `source-layout.test.ts` + 负向 fixture。
- 生成物 `static-structure-packed.generated.ts` 与 generator/registry/hash 已同步。
- 保留的过渡依赖：TanStack Query、Zustand、Zod、RxJS（Task 3–6 按计划清理）；`api/*.resource.ts` 仍是 Query 封装，loader 仍用 `ensureQueryData`。

## 已验证门禁（Task 1 提交前）

- `./scripts/verify.ps1` EXIT 0
- 前端：107 文件 / 668 测试，typecheck、build PASS（含独立 `twin-page-*.js` chunk）
- .NET：3 项目 Release 构建 + 180/180 测试 PASS
- 生成物/frozen assets/架构/startup/tool tests PASS

## 下一轮起点（Task 2）

1. 精确锁定 `effect@4.0.7`、`@effect/atom-react@4.0.7`（按 01 §2 先验证 scheduler 单一解析/peer，不无理由新增直接依赖）。
2. 新建 `app/app-runtime.ts` / `app/app-runtime-factory.ts`：单一 `AtomRegistry`（`defaultIdleTTL: 300s`）、应用级 Effect Scope/Layer、typed facade、异步 dispose。
3. React Provider 与 Router Context 共享同一 AppRuntime/Registry；测试使用独立 factory，不共享全局。
4. 生命周期测试（双 Registry 隔离、Layer 只构建一次、dispose 幂等、StrictMode 重挂）；新增 `Effect.run*` 架构 allowlist 门禁。
5. 不提前迁移 Query/Zustand/Zod/RxJS；不改变产品行为。

## 旧分支保留

旧迁移分支 `refactor/effect-consolidation-20261029`（be1da31）保留作参考：其 Effect Schema/HTTP 与 UI Atom 实现可在 Task 3/4 中按扁平路径移植；它不是当前权威基线。
