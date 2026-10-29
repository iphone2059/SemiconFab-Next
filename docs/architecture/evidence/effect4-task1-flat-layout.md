# Task 1：单层目录迁移与 code-based routing（执行记录）

- 执行日期：2026-10-29（Asia/Singapore）
- 基线提交：`4fc8a94a3f10d185c8bef7929349ac6ccb2b8792`
- 分支：`refactor/effect4-flat-20261029`
- 权威计划：`docs/architecture/03-migration-plan.md` Task 1；`02-flat-source-layout.md` 为目录规范
- 状态：Task 1 完成（全量门禁通过，见 §4）；旧依赖（Query/Zustand/RxJS/Zod）按计划留待 Task 3–6 清理

## 1. 目录结果

- 生产源码：`web_app/src` 仅允许 `main.tsx` 位于根目录；一级模块目录 16 个：`api, app, catalog, components, contracts, domain, generated, lib, localization, realtime, rendering, routes, runtime, state, twin, workbench`。
- 所有模块目录深度为 1，无嵌套目录；生产源码 195 个 .ts/.tsx 文件。
- 196 个基线生产文件中：193 个移动/重命名，3 个删除（`app/router/routeTree.gen.ts`、`realtime/equipment-status/index.ts`、`rendering/lite/effects/index.ts`），新增 2 个文件（`routes/route-tree.ts`、`rendering/lite-effects.ts`）。
- 逐文件移动清单见 §7（193 行，无目标冲突、无遗漏）。
- 生成物 `static-structure-packed.ts` 按命名规范改为 `generated/static-structure-packed.generated.ts`；生成器、registry、R5/R11 门禁与 `tools/check_architecture.py` 同步更新。

## 2. 路由改造

- 移除 `@tanstack/router-plugin`（package.json 与 pnpm-lock：plugin/generator 节点均为 0），删除 `routeTree.gen.ts`。
- 使用 `createRootRouteWithContext` + `createRoute` + `addChildren` 显式构造 `src/routes/route-tree.ts`；
  `routes/root.route.tsx`、`home.route.tsx`、`equipment.route.tsx`、`equipment-index.route.tsx`、`equipment-compare.route.tsx`、`fab-3d.route.tsx` 分别声明。
- 保留 URL：`/`、`/equipment`、`/equipment/compare`、`/fabs/$fabId/3d`；保留 root `errorComponent`/`notFoundComponent`、
  首页 sites 失败的可重试语义、未知 FAB 的 route error、search 参数、前进/后退、Twin 动态 import 与 Suspense fallback、
  `defaultPreloadStaleTime: 0` 与 Router `Register` 类型注册。
- `routes/*.route.tsx` 的 search 推断改为直接使用 code route 的 `useSearch()`（保留现有 3 处 `RouterSearch` 类型标注用于回调参数；
  Task 3 迁移 Schema 时再做最终收敛，不新增 `as` 断言）。
- 测试替换：
  - `tests/architecture/route-tree-generation.test.ts` 改为 code route tree 契约测试（route id 集合、root error/404、
    preload 语义、Router pin、plugin/generator 缺席、路由源码无 `@ts-nocheck`）。
  - `tests/integration/route-code-splitting.test.ts` 改为验证路由源码动态 import，并在测试中执行一次真实 `vite build` 断言产出独立 `twin-page-*.js` chunk；不再断言文件路由插件配置。

## 3. 别名与门禁

- 新增唯一别名 `@/* -> ./src/*`：tsconfig `paths`（TS 7 已移除 `baseUrl`，使用 tsconfig 相对路径）、Vite `resolve.alias`（Vitest 复用 Vite 配置）；未新增其他别名。
- 全部源码与测试相对导入按迁移映射改写为 `@/` 或新相对路径；`vi.mock`、`new URL(..., import.meta.url)`、repo-relative 路径字符串同步更新。
- 新增 `tests/architecture/source-layout.test.ts` + 负向 fixture `fixtures/source-layout/src/api/queries/example.ts`：禁止二级目录、非允许一级目录、PascalCase/空白文件名、`index/utils/helpers/common` 模糊文件名、生产源码 `@ts-nocheck`。
- 更新门禁：`architecture-import-graph`（R0 支持 @/、R0b 只允许单一 alias 且可解析、R2 routes 工具与 route assembly 分离、R3 domain 兼容 contracts/、R4 顶层 feature、R5 generated 新契约路径、R6 根仅 main.tsx）；`architecture-contract-rules`（R7 基模块/assembly 根、R9 contracts/scene.port.ts、R12 顶层 feature owner、R13 顶层 feature、R14 allowlist 路径与移除 routeTree 例外）；`architecture-boundaries`（ARCH-06 路径、ARCH-07 改为 XState 仅 machine/adapter、ARCH-11 扁平高频路径、M5b/M5c、ARCH-08）；`feature-ui-ownership`（顶层 feature 与扁平 workbench 文件）。
- `tools/check_architecture.py` 改为扁平布局断言（根仅 main.tsx、一级允许清单、禁止嵌套目录、生产源码无 `@ts-nocheck`、generated 新文件名、高频路径新前缀）。
- `tools/pack_static_structure.mjs` 与 `tools/generated-artifacts.json` 同步新生成物路径与 hash（`node tools/check_generated_artifacts.mjs --check` PASS）。

## 4. 验证结果（Task 1 提交前）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | pinned pnpm `typecheck` | PASS |
| 全量测试 | pinned pnpm `test` | PASS：107 文件 / 668 测试 |
| 构建 | pinned pnpm `build` | PASS；输出含独立 `twin-page-*.js` chunk |
| 完整验收脚本 | `./scripts/verify.ps1` | PASS（VERIFY_EXIT=0；含生成物/frozen/架构/startup/tool tests/.NET 180 测试/前端 install+typecheck+test+build） |
| Python 架构门禁 | `python tools/check_architecture.py` | PASS（扁平布局规则） |
| 生成物登记 | `node tools/check_generated_artifacts.mjs --check` | PASS |
| 目录门禁 | `tests/architecture/source-layout.test.ts` | PASS（含负向 fixture） |

## 5. 03 计划 Task 1 退出条件对照

- [x] `src` 下不存在二级目录（195 文件中无嵌套）。
- [x] 路由树不依赖文件生成插件；URL、search、error boundary、404、动态分块通过测试。
- [x] `route-tree-generation.test.ts` 已替换为 code-based route tree 测试。
- [x] `route-code-splitting.test.ts` 验证实际动态 import 与构建 chunk，不再断言插件配置。
- [x] R14 删除生成路由树 `@ts-nocheck` allowlist；生产源码扫描禁止 `@ts-nocheck`。
- [x] 全量 typecheck、测试和 build 通过。

## 6. Task 1 保留的过渡点（由后续任务消除）

| 过渡点 | 当前状态 | 计划归属 |
|---|---|---|
| `@tanstack/react-query` | 依赖与 `api/*.resource.ts`（原 queries）仍在；loader 仍用 `ensureQueryData` | Task 5 |
| `zustand` | `state/*.atom.ts`、`catalog/catalog.atom.ts`、`twin/*.atom.ts`、`workbench/workbench.atom.ts` 仍是 Zustand store；`state/create-slice-store.ts` 保留 | Task 4 |
| `zod` | `api/*.schema.ts` 与 `routes/route-search.ts` 仍用 Zod | Task 3 |
| `rxjs` | `realtime/*` 传输仍用 RxJS Observable/Subscription | Task 6 |
| `api/equipment-status-bridge.ts` | Query cache 与 gate 协调的过渡文件（扁平化后保留文件名） | Task 5/6 拆分 |
| `state/runtime-store.ts` | 原共享运行态 store 的扁平化临时位置 | Task 4 按字段拆分 |
| `contracts/app-contracts.ts` | 原 `src/contracts.ts` 的扁平化临时聚合 | Task 2/3 按契约拆分 |
| `api/query-client.ts`/`api/query-keys.ts` | Query 基础设施临时文件 | Task 5 删除 |
| `app/query-provider.tsx` | Query Provider 临时文件 | Task 5 删除 |

这些均按计划保留；Task 1 不宣称旧依赖已删除或 Effect 迁移已完成。

## 7. 逐文件移动清单（193 项）

| # | 基线路径 | Task 1 路径 |
|---|---|---|
| 1 | `web_app/src/api/cache/equipment-status-bridge.ts` | `web_app/src/api/equipment-status-bridge.ts` |
| 2 | `web_app/src/api/mutations/commands.mutations.ts` | `web_app/src/api/commands.mutation.ts` |
| 3 | `web_app/src/api/mutations/runs.mutations.ts` | `web_app/src/api/runs.mutation.ts` |
| 4 | `web_app/src/api/queries/catalog.queries.ts` | `web_app/src/api/catalog.resource.ts` |
| 5 | `web_app/src/api/queries/equipment.queries.ts` | `web_app/src/api/equipment.resource.ts` |
| 6 | `web_app/src/api/queries/queryClient.ts` | `web_app/src/api/query-client.ts` |
| 7 | `web_app/src/api/queries/queryKeys.ts` | `web_app/src/api/query-keys.ts` |
| 8 | `web_app/src/api/queries/research.queries.ts` | `web_app/src/api/research.resource.ts` |
| 9 | `web_app/src/api/queries/runs.queries.ts` | `web_app/src/api/runs.resource.ts` |
| 10 | `web_app/src/api/queries/sites.queries.ts` | `web_app/src/api/sites.resource.ts` |
| 11 | `web_app/src/api/queries/wafer.queries.ts` | `web_app/src/api/wafer.resource.ts` |
| 12 | `web_app/src/api/schemas/catalog.schema.ts` | `web_app/src/api/catalog.schema.ts` |
| 13 | `web_app/src/api/schemas/command.schema.ts` | `web_app/src/api/command.schema.ts` |
| 14 | `web_app/src/api/schemas/runs.schema.ts` | `web_app/src/api/runs.schema.ts` |
| 15 | `web_app/src/api/transport/http.ts` | `web_app/src/api/http.transport.ts` |
| 16 | `web_app/src/api/transport/HttpCommandGateway.ts` | `web_app/src/api/http-command-gateway.ts` |
| 17 | `web_app/src/app/providers/AppProviders.tsx` | `web_app/src/app/app-providers.tsx` |
| 18 | `web_app/src/app/providers/QueryProvider.tsx` | `web_app/src/app/query-provider.tsx` |
| 19 | `web_app/src/app/providers/RuntimeBootstrap.tsx` | `web_app/src/app/runtime-bootstrap.tsx` |
| 20 | `web_app/src/app/providers/RuntimeProvider.tsx` | `web_app/src/app/runtime-provider.tsx` |
| 21 | `web_app/src/app/providers/TelemetryProvider.tsx` | `web_app/src/app/telemetry-provider.tsx` |
| 22 | `web_app/src/app/router/route-data.ts` | `web_app/src/routes/route-data.ts` |
| 23 | `web_app/src/app/router/router.tsx` | `web_app/src/routes/router.tsx` |
| 24 | `web_app/src/app/router/routes/__root.tsx` | `web_app/src/routes/root.route.tsx` |
| 25 | `web_app/src/app/router/routes/equipment.tsx` | `web_app/src/routes/equipment.route.tsx` |
| 26 | `web_app/src/app/router/routes/equipment/compare.tsx` | `web_app/src/routes/equipment-compare.route.tsx` |
| 27 | `web_app/src/app/router/routes/equipment/index.tsx` | `web_app/src/routes/equipment-index.route.tsx` |
| 28 | `web_app/src/app/router/routes/fabs/$fabId/3d.tsx` | `web_app/src/routes/fab-3d.route.tsx` |
| 29 | `web_app/src/app/router/routes/index.tsx` | `web_app/src/routes/home.route.tsx` |
| 30 | `web_app/src/app/router/search.ts` | `web_app/src/routes/route-search.ts` |
| 31 | `web_app/src/app/router/url-mapping.ts` | `web_app/src/routes/route-url-mapping.ts` |
| 32 | `web_app/src/application/contracts/CommandEvents.ts` | `web_app/src/contracts/command-events.contract.ts` |
| 33 | `web_app/src/application/contracts/CommandGateway.ts` | `web_app/src/contracts/command-gateway.contract.ts` |
| 34 | `web_app/src/application/contracts/CommandWorkflow.ts` | `web_app/src/contracts/command-workflow.contract.ts` |
| 35 | `web_app/src/application/coordination/CommandCorrelationRegistry.ts` | `web_app/src/runtime/command-correlation-registry.ts` |
| 36 | `web_app/src/application/coordination/CommandEventBridge.ts` | `web_app/src/runtime/command-event-bridge.ts` |
| 37 | `web_app/src/application/coordination/CommandEventRecovery.ts` | `web_app/src/runtime/command-event-recovery.ts` |
| 38 | `web_app/src/application/coordination/ScopeGate.ts` | `web_app/src/runtime/scope-gate.ts` |
| 39 | `web_app/src/application/ports/scene.ts` | `web_app/src/contracts/scene.port.ts` |
| 40 | `web_app/src/components/class-names.ts` | `web_app/src/components/class-names.ts` |
| 41 | `web_app/src/components/error-boundary.tsx` | `web_app/src/components/error-boundary.tsx` |
| 42 | `web_app/src/components/modal.tsx` | `web_app/src/components/modal.tsx` |
| 43 | `web_app/src/components/original-icons-data.ts` | `web_app/src/components/original-icons-data.ts` |
| 44 | `web_app/src/components/original-icons.tsx` | `web_app/src/components/original-icons.tsx` |
| 45 | `web_app/src/contracts.ts` | `web_app/src/contracts/app-contracts.ts` |
| 46 | `web_app/src/domain/amhs/amhs-timeline.ts` | `web_app/src/domain/amhs-timeline.ts` |
| 47 | `web_app/src/domain/equipment/tool-state-projection.ts` | `web_app/src/domain/equipment-tool-state-projection.ts` |
| 48 | `web_app/src/domain/fab/cleanroom-pressure.ts` | `web_app/src/domain/fab-cleanroom-pressure.ts` |
| 49 | `web_app/src/domain/fab/fab-layout.ts` | `web_app/src/domain/fab-layout.ts` |
| 50 | `web_app/src/domain/fab/fab-yield.ts` | `web_app/src/domain/fab-yield.ts` |
| 51 | `web_app/src/domain/fab/layout-identities.ts` | `web_app/src/domain/fab-layout-identities.ts` |
| 52 | `web_app/src/domain/fab/original-twin-data.ts` | `web_app/src/domain/original-twin-data.ts` |
| 53 | `web_app/src/domain/fab/process-control.ts` | `web_app/src/domain/fab-process-control.ts` |
| 54 | `web_app/src/domain/fab/twin-spatial.ts` | `web_app/src/domain/fab-twin-spatial.ts` |
| 55 | `web_app/src/domain/math/round.ts` | `web_app/src/domain/math-round.ts` |
| 56 | `web_app/src/domain/math/vec3.ts` | `web_app/src/domain/math-vec3.ts` |
| 57 | `web_app/src/domain/personnel/personnel-timeline.ts` | `web_app/src/domain/personnel-timeline.ts` |
| 58 | `web_app/src/domain/simulation/original-tour.ts` | `web_app/src/domain/simulation-original-tour.ts` |
| 59 | `web_app/src/domain/simulation/research-replay.ts` | `web_app/src/domain/simulation-research-replay.ts` |
| 60 | `web_app/src/domain/simulation/scenario.ts` | `web_app/src/domain/simulation-scenario.ts` |
| 61 | `web_app/src/domain/simulation/tour-scenario.ts` | `web_app/src/domain/simulation-tour-scenario.ts` |
| 62 | `web_app/src/domain/simulation/tour-timeline.ts` | `web_app/src/domain/simulation-tour-timeline.ts` |
| 63 | `web_app/src/domain/simulation/twin-equipment.ts` | `web_app/src/domain/simulation-twin-equipment.ts` |
| 64 | `web_app/src/domain/wafer/wafer-map.ts` | `web_app/src/domain/wafer-map.ts` |
| 65 | `web_app/src/domain/wafer/wafer-route.ts` | `web_app/src/domain/wafer-route.ts` |
| 66 | `web_app/src/domain/wafer/wafer-scenario.ts` | `web_app/src/domain/wafer-scenario.ts` |
| 67 | `web_app/src/domain/wafer/wafer-timeline.ts` | `web_app/src/domain/wafer-timeline.ts` |
| 68 | `web_app/src/features/catalog/catalog-data.ts` | `web_app/src/catalog/catalog-data.ts` |
| 69 | `web_app/src/features/catalog/catalog-page.tsx` | `web_app/src/catalog/catalog-page.tsx` |
| 70 | `web_app/src/features/catalog/components/catalog-comparison.tsx` | `web_app/src/catalog/catalog-comparison.tsx` |
| 71 | `web_app/src/features/catalog/components/catalog-detail.tsx` | `web_app/src/catalog/catalog-detail.tsx` |
| 72 | `web_app/src/features/catalog/components/catalog-fields.tsx` | `web_app/src/catalog/catalog-fields.tsx` |
| 73 | `web_app/src/features/catalog/components/catalog-filters.tsx` | `web_app/src/catalog/catalog-filters.tsx` |
| 74 | `web_app/src/features/catalog/components/catalog-footer.tsx` | `web_app/src/catalog/catalog-footer.tsx` |
| 75 | `web_app/src/features/catalog/components/catalog-header.tsx` | `web_app/src/catalog/catalog-header.tsx` |
| 76 | `web_app/src/features/catalog/components/catalog-table.tsx` | `web_app/src/catalog/catalog-table.tsx` |
| 77 | `web_app/src/features/catalog/components/catalog-toolbar.tsx` | `web_app/src/catalog/catalog-toolbar.tsx` |
| 78 | `web_app/src/features/catalog/components/external-link.tsx` | `web_app/src/catalog/external-link.tsx` |
| 79 | `web_app/src/features/catalog/controllers/use-catalog-data.ts` | `web_app/src/catalog/use-catalog-data.ts` |
| 80 | `web_app/src/features/catalog/controllers/use-catalog-import.ts` | `web_app/src/catalog/use-catalog-import.ts` |
| 81 | `web_app/src/features/catalog/controllers/use-catalog-route-state.ts` | `web_app/src/catalog/use-catalog-route-state.ts` |
| 82 | `web_app/src/features/catalog/export/catalog-export.ts` | `web_app/src/catalog/catalog-export.ts` |
| 83 | `web_app/src/features/catalog/export/download-lifecycle.ts` | `web_app/src/catalog/download-lifecycle.ts` |
| 84 | `web_app/src/features/catalog/export/use-catalog-downloads.ts` | `web_app/src/catalog/use-catalog-downloads.ts` |
| 85 | `web_app/src/features/catalog/labels.ts` | `web_app/src/catalog/catalog-labels.ts` |
| 86 | `web_app/src/features/catalog/search.ts` | `web_app/src/catalog/catalog-search.ts` |
| 87 | `web_app/src/features/catalog/state/catalogStore.ts` | `web_app/src/catalog/catalog.atom.ts` |
| 88 | `web_app/src/features/catalog/types.ts` | `web_app/src/catalog/catalog-types.ts` |
| 89 | `web_app/src/features/twin/controllers/use-research-playback.ts` | `web_app/src/twin/use-research-playback.ts` |
| 90 | `web_app/src/features/twin/controllers/use-tour-controller.ts` | `web_app/src/twin/use-tour-controller.ts` |
| 91 | `web_app/src/features/twin/controllers/use-twin-actions.ts` | `web_app/src/twin/use-twin-actions.ts` |
| 92 | `web_app/src/features/twin/controllers/use-twin-demo-clock.ts` | `web_app/src/twin/use-twin-demo-clock.ts` |
| 93 | `web_app/src/features/twin/controllers/use-twin-keyboard.ts` | `web_app/src/twin/use-twin-keyboard.ts` |
| 94 | `web_app/src/features/twin/controllers/use-twin-process-projection.ts` | `web_app/src/twin/use-twin-process-projection.ts` |
| 95 | `web_app/src/features/twin/controllers/use-twin-route-state.ts` | `web_app/src/twin/use-twin-route-state.ts` |
| 96 | `web_app/src/features/twin/controllers/use-twin-scene-sync.ts` | `web_app/src/twin/use-twin-scene-sync.ts` |
| 97 | `web_app/src/features/twin/controllers/use-twin-slices.ts` | `web_app/src/twin/use-twin-slices.ts` |
| 98 | `web_app/src/features/twin/controllers/use-wafer-playback.ts` | `web_app/src/twin/use-wafer-playback.ts` |
| 99 | `web_app/src/features/twin/equipment-status-pipeline.tsx` | `web_app/src/twin/twin-equipment-status-pipeline.tsx` |
| 100 | `web_app/src/features/twin/fab-viewer.tsx` | `web_app/src/twin/twin-viewer.tsx` |
| 101 | `web_app/src/features/twin/state/twin-state.ts` | `web_app/src/twin/twin-state.ts` |
| 102 | `web_app/src/features/twin/state/twinDemoStore.ts` | `web_app/src/twin/twin-demo.atom.ts` |
| 103 | `web_app/src/features/twin/state/twinPageStore.ts` | `web_app/src/twin/twin-page.atom.ts` |
| 104 | `web_app/src/features/twin/state/twinUiStore.ts` | `web_app/src/twin/twin-ui.atom.ts` |
| 105 | `web_app/src/features/twin/tool-state-merge.ts` | `web_app/src/twin/tool-state-merge.ts` |
| 106 | `web_app/src/features/twin/twin-amhs-hud.tsx` | `web_app/src/twin/twin-amhs-hud.tsx` |
| 107 | `web_app/src/features/twin/twin-dialogs.tsx` | `web_app/src/twin/twin-dialogs.tsx` |
| 108 | `web_app/src/features/twin/twin-elevation.tsx` | `web_app/src/twin/twin-elevation.tsx` |
| 109 | `web_app/src/features/twin/twin-i18n.tsx` | `web_app/src/twin/twin-i18n.tsx` |
| 110 | `web_app/src/features/twin/twin-inspector.tsx` | `web_app/src/twin/twin-inspector.tsx` |
| 111 | `web_app/src/features/twin/twin-page-data.ts` | `web_app/src/twin/twin-page-data.ts` |
| 112 | `web_app/src/features/twin/twin-page.tsx` | `web_app/src/twin/twin-page.tsx` |
| 113 | `web_app/src/features/twin/twin-search.ts` | `web_app/src/twin/twin-search.ts` |
| 114 | `web_app/src/features/twin/twin-sidebar.tsx` | `web_app/src/twin/twin-sidebar.tsx` |
| 115 | `web_app/src/features/twin/twin-tour-hud.tsx` | `web_app/src/twin/twin-tour-hud.tsx` |
| 116 | `web_app/src/features/twin/twin-translations.ts` | `web_app/src/twin/twin-translations.ts` |
| 117 | `web_app/src/features/twin/twin-wafer-hud.tsx` | `web_app/src/twin/twin-wafer-hud.tsx` |
| 118 | `web_app/src/features/twin/twin-yms.tsx` | `web_app/src/twin/twin-yms.tsx` |
| 119 | `web_app/src/features/twin/wafer-session.ts` | `web_app/src/twin/twin-wafer-session.ts` |
| 120 | `web_app/src/features/workbench/command-console.tsx` | `web_app/src/workbench/command-console.tsx` |
| 121 | `web_app/src/features/workbench/components/completion-bar.tsx` | `web_app/src/workbench/completion-bar.tsx` |
| 122 | `web_app/src/features/workbench/components/fab-overview.tsx` | `web_app/src/workbench/fab-overview.tsx` |
| 123 | `web_app/src/features/workbench/components/metric.tsx` | `web_app/src/workbench/metric.tsx` |
| 124 | `web_app/src/features/workbench/components/panel.tsx` | `web_app/src/workbench/panel.tsx` |
| 125 | `web_app/src/features/workbench/components/run-form.tsx` | `web_app/src/workbench/run-form.tsx` |
| 126 | `web_app/src/features/workbench/components/run-history.tsx` | `web_app/src/workbench/run-history.tsx` |
| 127 | `web_app/src/features/workbench/components/status-pill.tsx` | `web_app/src/workbench/status-pill.tsx` |
| 128 | `web_app/src/features/workbench/components/workbench-metrics.tsx` | `web_app/src/workbench/workbench-metrics.tsx` |
| 129 | `web_app/src/features/workbench/controllers/use-command-console.ts` | `web_app/src/workbench/use-command-console.ts` |
| 130 | `web_app/src/features/workbench/controllers/use-run-submission.ts` | `web_app/src/workbench/use-run-submission.ts` |
| 131 | `web_app/src/features/workbench/error-message.ts` | `web_app/src/workbench/error-message.ts` |
| 132 | `web_app/src/features/workbench/format.ts` | `web_app/src/workbench/workbench-format.ts` |
| 133 | `web_app/src/features/workbench/state/workbenchStore.ts` | `web_app/src/workbench/workbench.atom.ts` |
| 134 | `web_app/src/features/workbench/workbench.tsx` | `web_app/src/workbench/workbench.tsx` |
| 135 | `web_app/src/generated/contracts.generated.ts` | `web_app/src/generated/contracts.generated.ts` |
| 136 | `web_app/src/generated/static-structure-packed.ts` | `web_app/src/generated/static-structure-packed.generated.ts` |
| 137 | `web_app/src/generated/twin-translations.generated.ts` | `web_app/src/generated/twin-translations.generated.ts` |
| 138 | `web_app/src/localization/language.ts` | `web_app/src/localization/language.ts` |
| 139 | `web_app/src/main.tsx` | `web_app/src/main.tsx` |
| 140 | `web_app/src/realtime/buffers/FrameRingBuffer.ts` | `web_app/src/realtime/frame-ring-buffer.ts` |
| 141 | `web_app/src/realtime/equipment-status/gate.ts` | `web_app/src/realtime/equipment-status.gate.ts` |
| 142 | `web_app/src/realtime/equipment-status/protocol.ts` | `web_app/src/realtime/equipment-status.protocol.ts` |
| 143 | `web_app/src/realtime/equipment-status/stream.ts` | `web_app/src/realtime/equipment-status.transport.ts` |
| 144 | `web_app/src/realtime/protocol/MessageDecoder.ts` | `web_app/src/realtime/message-decoder.ts` |
| 145 | `web_app/src/realtime/telemetry/FabTelemetryRegistry.ts` | `web_app/src/realtime/telemetry-registry.ts` |
| 146 | `web_app/src/realtime/telemetry/TelemetryRuntime.ts` | `web_app/src/realtime/telemetry-runtime.ts` |
| 147 | `web_app/src/realtime/transport/SseCommandEventSource.ts` | `web_app/src/realtime/command-event-source.transport.ts` |
| 148 | `web_app/src/realtime/workers/createTelemetryWorker.ts` | `web_app/src/realtime/telemetry-worker-factory.ts` |
| 149 | `web_app/src/realtime/workers/telemetryWorker.logic.ts` | `web_app/src/realtime/telemetry-worker.logic.ts` |
| 150 | `web_app/src/realtime/workers/telemetryWorker.ts` | `web_app/src/realtime/telemetry.worker.ts` |
| 151 | `web_app/src/rendering/contracts/static-structure-data.ts` | `web_app/src/rendering/static-structure-data.contract.ts` |
| 152 | `web_app/src/rendering/lite-backend.ts` | `web_app/src/rendering/lite-backend.ts` |
| 153 | `web_app/src/rendering/lite/airflow-texture.ts` | `web_app/src/rendering/lite-airflow-texture.ts` |
| 154 | `web_app/src/rendering/lite/amhs-stats.ts` | `web_app/src/rendering/lite-amhs-stats.ts` |
| 155 | `web_app/src/rendering/lite/camera.ts` | `web_app/src/rendering/lite-camera.ts` |
| 156 | `web_app/src/rendering/lite/cut-plane.ts` | `web_app/src/rendering/lite-cut-plane.ts` |
| 157 | `web_app/src/rendering/lite/effects-xray-state.ts` | `web_app/src/rendering/lite-effects-xray-state.ts` |
| 158 | `web_app/src/rendering/lite/effects/cut.ts` | `web_app/src/rendering/lite-effects-cut.ts` |
| 159 | `web_app/src/rendering/lite/effects/wafer.ts` | `web_app/src/rendering/lite-effects-wafer.ts` |
| 160 | `web_app/src/rendering/lite/effects/xray-shaders.ts` | `web_app/src/rendering/lite-effects-xray-shaders.ts` |
| 161 | `web_app/src/rendering/lite/effects/xray.ts` | `web_app/src/rendering/lite-effects-xray.ts` |
| 162 | `web_app/src/rendering/lite/environment-roof-data.ts` | `web_app/src/rendering/lite-environment-roof-data.ts` |
| 163 | `web_app/src/rendering/lite/environment.ts` | `web_app/src/rendering/lite-environment.ts` |
| 164 | `web_app/src/rendering/lite/geometry/facility-layout.ts` | `web_app/src/rendering/lite-geometry-facility-layout.ts` |
| 165 | `web_app/src/rendering/lite/geometry/facility.ts` | `web_app/src/rendering/lite-geometry-facility.ts` |
| 166 | `web_app/src/rendering/lite/geometry/original-exploded-link-data.ts` | `web_app/src/rendering/lite-geometry-original-exploded-link-data.ts` |
| 167 | `web_app/src/rendering/lite/geometry/original-tool-parts.ts` | `web_app/src/rendering/lite-geometry-original-tool-parts.ts` |
| 168 | `web_app/src/rendering/lite/geometry/static-structure.ts` | `web_app/src/rendering/lite-geometry-static-structure.ts` |
| 169 | `web_app/src/rendering/lite/geometry/tool-families.ts` | `web_app/src/rendering/lite-geometry-tool-families.ts` |
| 170 | `web_app/src/rendering/lite/lighting.ts` | `web_app/src/rendering/lite-lighting.ts` |
| 171 | `web_app/src/rendering/lite/motion.ts` | `web_app/src/rendering/lite-motion.ts` |
| 172 | `web_app/src/rendering/lite/next-coordinate-frame.ts` | `web_app/src/rendering/lite-next-coordinate-frame.ts` |
| 173 | `web_app/src/rendering/lite/overlay-billboards.ts` | `web_app/src/rendering/lite-overlay-billboards.ts` |
| 174 | `web_app/src/rendering/lite/runtime.ts` | `web_app/src/rendering/lite-runtime.ts` |
| 175 | `web_app/src/rendering/lite/selection.ts` | `web_app/src/rendering/lite-selection.ts` |
| 176 | `web_app/src/rendering/lite/shadows/native-lite-shadow.ts` | `web_app/src/rendering/lite-shadows-native-lite-shadow.ts` |
| 177 | `web_app/src/rendering/lite/source-orbit-input.ts` | `web_app/src/rendering/lite-source-orbit-input.ts` |
| 178 | `web_app/src/rendering/lite/tool-states.ts` | `web_app/src/rendering/lite-tool-states.ts` |
| 179 | `web_app/src/rendering/lite/world.ts` | `web_app/src/rendering/lite-world.ts` |
| 180 | `web_app/src/runtime/commands/CommandReconciler.ts` | `web_app/src/runtime/command-reconciler.ts` |
| 181 | `web_app/src/runtime/commands/equipmentCommand.logic.ts` | `web_app/src/runtime/equipment-command.logic.ts` |
| 182 | `web_app/src/runtime/commands/equipmentCommand.machine.ts` | `web_app/src/runtime/equipment-command.machine.ts` |
| 183 | `web_app/src/runtime/commands/XStateCommandWorkflowAdapter.ts` | `web_app/src/runtime/xstate-command-workflow-adapter.ts` |
| 184 | `web_app/src/runtime/commandSources.ts` | `web_app/src/runtime/command-sources.ts` |
| 185 | `web_app/src/runtime/FabLifecycleCoordinator.ts` | `web_app/src/runtime/fab-lifecycle-coordinator.ts` |
| 186 | `web_app/src/runtime/FabRuntime.ts` | `web_app/src/runtime/fab-runtime.ts` |
| 187 | `web_app/src/runtime/FabRuntimeFactory.ts` | `web_app/src/runtime/fab-runtime-factory.ts` |
| 188 | `web_app/src/runtime/FabRuntimeRegistry.ts` | `web_app/src/runtime/fab-runtime-registry.ts` |
| 189 | `web_app/src/shared/scheduling/coalesced-dispatcher.ts` | `web_app/src/lib/coalesced-dispatcher.ts` |
| 190 | `web_app/src/state/createSliceStore.ts` | `web_app/src/state/create-slice-store.ts` |
| 191 | `web_app/src/state/localeStore.ts` | `web_app/src/state/locale.atom.ts` |
| 192 | `web_app/src/state/preferences.ts` | `web_app/src/state/preferences.atom.ts` |
| 193 | `web_app/src/state/runtimeStore.ts` | `web_app/src/state/runtime-store.ts` |

## 8. 删除与新增文件

删除：`web_app/src/app/router/routeTree.gen.ts`（代码路由取代）、`web_app/src/realtime/equipment-status/index.ts`（barrel，禁止）、`web_app/src/rendering/lite/effects/index.ts`（barrel，物化为 `rendering/lite-effects.ts`）。

新增：`web_app/src/routes/route-tree.ts`、`web_app/src/rendering/lite-effects.ts`（原 barrel 的实现物化）、
`web_app/tests/architecture/source-layout.test.ts` 及负向 fixture、替换后的 `tests/architecture/route-tree-generation.test.ts` 与
`tests/integration/route-code-splitting.test.ts`。
