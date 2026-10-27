# 路由与查询集成（Router / TanStack Query）

- 版本：V2.1 / 2026-10-27
- 状态：**M1/M2 已实现；Zustand 接管客户端状态、Router search 接管 URL 状态（M2c）**（M2 implemented）
- 依据：[ADR-0009](adr/0009-tanstack-router-query-boundary.md)；总览见 [架构基线](architecture.md)；状态所有权见 [状态管理](state-management.md)
- 当前实现：`main.tsx` 已改为 `AppProviders + RouterProvider`；TanStack Router 接管顶层路由；**全部 HTTP 端点**由 TanStack Query 独占；客户端 UI 状态由 Zustand 承载；Redux/RTK Query 已删除
- 门禁状态：RQ-01..RQ-05 **均已真实运行（PASS）**。证据见 [架构基线](architecture.md) §15/§16、`tests/integration/router-query.test.tsx` 与 `tests/integration/query-cache.test.tsx`

## 1. 职责边界

| 能力 | TanStack Router | TanStack Query | 说明 |
|---|---|---|---|
| URL/路径/搜索参数解析与校验 | 负责 | 不负责 | Router 用 schema 校验 search |
| 导航、重定向、history | 负责 | 不负责 | — |
| 按意图预加载（hover/focus/touch） | 负责 | 不负责 | `defaultPreload: 'intent'` |
| 路由级加载门槛（首次渲染前准备数据） | 调用方 | 数据提供方 | loader 调 `ensureQueryData` |
| HTTP 响应缓存/去重/新鲜度/失效 | 不负责 | 唯一负责 | ARCH-02 |
| 后台刷新、窗口焦点刷新、重连刷新 | 不负责 | 负责 | Query 默认行为 + 配置 |
| 组件订阅 | 不负责 | `useQuery`/`useSuspenseQuery` | 组件不得只用 loader 返回值 |
| 命令/工作流状态 | 不负责 | 不负责 | 见 [命令事件桥](command-event-bridge.md) |
| 高频遥测 | 不负责 | 不负责 | 见 [渲染管线](rendering.md)（ARCH-11） |

## 2. 应用装配

目标装配顺序（`app/providers/AppProviders`）：

```text
AppProviders
  ├─ QueryProvider        （创建/提供 QueryClient）
  ├─ RuntimeProvider      （按 FAB 提供 FabRuntime；见 fab-runtime.md）
  └─ RouterProvider       （router；根路由 context 注入 queryClient）
```

```tsx
// app/providers/QueryProvider.tsx（示意）
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { queryClient } from '../../api/queries/queryClient';

export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
```

- 全应用只有一个 `QueryClient`（`api/queries/queryClient.ts`）；`createRootRouteWithContext<{ queryClient: QueryClient }>()` 把它注入路由 context。
- `QueryProvider` 与 `createRouter({ context: { queryClient } })` 必须引用**同一个实例**；禁止在模块内或测试外再建第二个。
- `QueryClient` 默认值（`staleTime`、`gcTime`、`retry`、`refetchOnWindowFocus`）在 M1 冻结并写入本文件；本基线不虚构数值。测试不依赖全局默认值，逐 Query 显式配置。

## 3. 路由配置

```tsx
// app/router/router.tsx（示意）
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { queryClient } from '../../api/queries/queryClient';

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
});
```

要求：

1. `defaultPreload: 'intent'` 必须开启：hover/focus/touch 链接即触发目标路由的 loader 预加载（RQ-01 场景）。
2. `defaultPreloadStaleTime: 0` 必须配置：Router 不再用自身约 30 秒的预加载新鲜度否决 loader 重跑；每次导航都重新执行 loader，由 Query 决定是否发请求。
3. `defaultPreloadStaleTime: 0` 只影响 Router 的预加载新鲜度判断，不改变 Router 的路由缓存保留；Query 的 `staleTime`/`gcTime` 独立生效。
4. **该配置是必要条件，不是充分条件**：数据新鲜度还取决于同 key/同 `queryFn`/同 `staleTime`、页面订阅、invalidation、显式 `fetchQuery`、无第二份缓存（见 [ADR-0009](adr/0009-tanstack-router-query-boundary.md) 第 3 节）。

## 4. Query Options 与 Query Keys

### 4.1 单一 Query Options 定义

- 每个领域一个 `*.queries.ts`：`api/queries/equipment.queries.ts`、`command.queries.ts` 等。
- 使用 `queryOptions(...)` 导出具名对象/工厂；loader 与组件 import 同一份，禁止复制 queryFn 或 key。
- `queryFn` 只调用 `api/endpoints`；HTTP 响应在 endpoint 层或 queryFn 内用 `schemas`（Zod）校验，失败抛错，不写入缓存。
- `command.queries.ts` 只用于“读取命令的权威状态”（恢复/核对场景），不得用 Query 建模进行中命令的生命周期；生命周期由 XState 工作流拥有（[ADR-0010](adr/0010-command-event-bridge.md)）。

### 4.2 Query Keys 约定

```ts
// api/queries/queryKeys.ts（示意）
export const queryKeys = {
  sites: () => ['sites'] as const,
  fab: (fabId: string) => ['fab', fabId] as const,
  fabEquipment: (fabId: string) => ['fab', fabId, 'equipment'] as const,
  equipment: (fabId: string, equipmentId: string) =>
    ['fab', fabId, 'equipment', equipmentId] as const,
  equipmentStatus: (fabId: string) => ['fab', fabId, 'equipment-status'] as const,
  catalog: (filters: Record<string, string>) => ['catalog', filters] as const,
  runs: () => ['runs'] as const,
  run: (runId: string) => ['runs', runId] as const,
  runResults: (runId: string) => ['runs', runId, 'results'] as const,
  commandStatus: (fabId: string, commandId: string) =>
    ['command', fabId, commandId] as const,
};
```

约束：

- **所有 FAB 相关 key 必须包含 `fabId`**（ARCH-10 的客户端缓存投影）；同一设备 id 在不同 FAB 不共享缓存（RQ-04）。
- key 定义集中在 `queryKeys.ts`；禁止在组件/loader 内手写数组字面量。
- 失效粒度按 key 前缀：`invalidateQueries({ queryKey: ['fab', fabId] })` 只影响该 FAB。
- filters 等对象必须稳定序列化（排序后）再进 key，避免同义 key 不命中。

## 5. Loader 模式

| 场景 | loader 写法 | 网络请求 | 页面 |
|---|---|---|---|
| 普通路由加载（默认） | `context.queryClient.ensureQueryData(options)` | 仅未命中时 | `useQuery(options)` 或 `useSuspenseQuery` |
| 预加载后导航 | 同上（Router 因 `defaultPreloadStaleTime: 0` 会重跑 loader） | 通常 0（缓存命中） | 同上；旧数据立即显示，过期则后台刷新 |
| 必须权威新数据（命令终态确认、审计） | `context.queryClient.fetchQuery({ ...options, staleTime: 0 })`（显式、逐路由；若沿用 options 的 `staleTime > 0` 可能直接返回缓存） | 是 | 同上（缓存已更新） |
| 只在客户端加载的辅助数据 | 不放 loader | 由组件 `useQuery` 触发 | `useQuery` |
| 命令工作流 | 不放 loader | — | 由 Runtime/工作流驱动，不靠路由加载 |

规则：

1. loader 不做 UI 状态写入、不 dispatch、不 import 具体工作流实现。
2. loader 不 `try/catch` 后再返回空数据来“吞掉”错误；错误交给 Router 的 `errorComponent`/error boundary。
3. 路由提供 `pendingComponent`/`errorComponent`（或 suspense boundary）；加载/失败形态在 M1 统一。
4. 预加载失败不应阻塞后续导航的错误展示；以 Router 的错误处理为准。

## 6. 新鲜度矩阵

| 场景 | Router 行为 | Query 行为 | 额外网络请求 | 数据来源 |
|---|---|---|---|---|
| hover 预加载后立即导航（预加载在 Query 新鲜期内） | 因 `defaultPreloadStaleTime: 0` 重跑 loader | `ensureQueryData` 命中缓存 | 0 | Query 缓存 |
| 导航时 Query 数据已过 `staleTime` | 重跑 loader | `ensureQueryData` 仍返回缓存；页面订阅触发一次后台刷新 | 1（页面订阅） | 先缓存后权威 |
| 导航到未缓存路由 | 执行 loader | `ensureQueryData` 未命中 -> `queryFn` | 1 | 网络 |
| 预加载与导航请求重叠 | 两次 loader 调用 | 同 key in-flight 去重 | 1（共享） | 网络 |
| mutation 成功并失效 | 无感知 | 活跃 observer 重新取数 | 按失效范围 | 网络（权威） |
| 显式 `fetchQuery` 的导航 | loader await | 强制取数并写缓存 | 1 | 网络（权威） |
| 浏览器前进/后退 | Router 恢复路由 | 缓存仍在 `gcTime` 内则命中；gc 后重新取数 | 0 或 1 | Query 缓存/网络 |
| 窗口重新聚焦 | 无 | 仅当 query 允许 focus 刷新且已过期 | 可能 1 | 网络 |

注意：上表描述的是**设计语义**，不是已执行结果；具体行为以 RQ-01..05 与 M1 后的测试记录为准。

## 7. 必测门禁 RQ-01..RQ-05 细则

> 位置（计划）：`web_app/tests/integration/router-query.test.tsx`。全部 **SPECIFIED / NOT RUN**。前置：TanStack Router/Query 依赖、jsdom/happy-dom + Testing Library（当前未安装，见 [架构基线](architecture.md) 第 12.3 节）。

### RQ-01 hover 预加载后立即导航复用 Query 数据

- **目的**：证明 intent 预加载的数据被紧接着的导航复用，而不是重复请求。
- **Given**：全新 `QueryClient`（测试隔离）；路由 `/fabs/F1/equipment/E1` 的 loader 使用 `equipmentQueries.detail('F1','E1')`；mock endpoint 计数返回 v1；当前渲染另一页面且页面内有指向该路由的 `Link`。
- **When**：触发链接 hover/focus（intent 预加载）并等待预加载 loader 完成；随后立即点击导航。
- **Then**：导航后的 loader 因 `defaultPreloadStaleTime: 0` 确实重新执行；`ensureQueryData` 命中缓存；endpoint 仅被调用 **1** 次；页面无需 loading 状态即显示 v1；不存在第二次相同 key 的请求。
- **断言点**：endpoint 调用次数 = 1；`queryClient.getQueryData(equipmentQueries.detail(...).queryKey)` 为 v1；导航完成且页面渲染 v1。
- **状态**：SPECIFIED / NOT RUN。阻塞：依赖与 DOM 测试环境未安装。

### RQ-02 预加载后数据过期再导航遵循 Query 新鲜度

- **目的**：证明 Router 不 veto loader，但 loader 不强制刷新；过期后的刷新由页面订阅按 Query 新鲜度触发。
- **Given**：Query 显式 `staleTime`（例如 1000ms，测试用假时钟）；endpoint 首次返回 v1、再次返回 v2；先 hover 预加载（产生第 1 次请求）。
- **When**：推进假时钟超过 `staleTime`，然后点击导航。
- **Then**：导航不被网络阻塞（loader `ensureQueryData` 返回缓存，不等待网络）；页面先显示 v1；页面 `useQuery` 订阅触发恰好 1 次后台刷新，最终显示 v2。
- **断言点**：导航完成时 endpoint 计数仍为 1；随后计数变为 2；最终缓存/页面为 v2；无重复/循环刷新。
- **状态**：SPECIFIED / NOT RUN。

### RQ-03 mutation 失效后展示刷新后的权威数据

- **目的**：证明服务端变更通过 invalidate + refetch 反映，且没有第二份状态副本继续展示旧值。
- **Given**：某 Query 已缓存 v1 且页面正在订阅；mutation（如创建 Run 或提交命令的 HTTP 部分）成功后调用 `invalidateQueries` 对应 key。
- **When**：mutation resolve。
- **Then**：活跃 Query 重新取数并写入 v2；页面显示 v2；Zustand/组件不得保留 v1 副本作为展示来源（ARCH-05）。
- **断言点**：失效后 endpoint 计数 +1；缓存与 DOM 均为 v2；store 中无该查询结果字段。
- **状态**：SPECIFIED / NOT RUN。

### RQ-04 FAB-A / FAB-B 相同设备 id 不串缓存

- **目的**：证明 FAB 维度进入 Query key，同一 `equipmentId` 字符串在不同 FAB 中互不影响。
- **Given**：FAB-A 与 FAB-B 使用相同 `equipmentId`（例如 `EQ-001`）；endpoint 按 `fabId` 返回不同数据（A: "A-state"，B: "B-state"）。
- **When**：分别加载 FAB-A 与 FAB-B 的设备查询；再对 FAB-A 执行失效。
- **Then**：两个缓存条目独立、互不覆盖；FAB-A 的失效不触发 FAB-B 重取；各自页面显示各自数据。
- **断言点**：`queryClient.getQueryData` 两个 key 数据不同；endpoint 调用次数各 1；失效后只有 A 变化。
- **状态**：SPECIFIED / NOT RUN。

### RQ-05 重叠预加载/导航请求复用 in-flight 请求

- **目的**：证明 Query 的去重能力覆盖“预加载请求尚未返回时导航 loader 再次请求”的竞态。
- **Given**：endpoint 返回受控 Promise（deferred）；预加载触发后请求处于 in-flight。
- **When**：在 Promise resolve 前执行导航，导航 loader 再次 `ensureQueryData`。
- **Then**：两个调用都等待同一个 in-flight 请求；endpoint 仅调用 1 次；两者解析到同一份数据；无重复缓存写入。
- **断言点**：endpoint 调用次数 = 1；两次 loader promise 解析值相同；导航完成后页面数据正确。
- **状态**：SPECIFIED / NOT RUN。

## 8. 文件式路由与 Vite 约束（G-01）

| 事项 | 规则 |
|---|---|
| 路由生成 | 使用 TanStack Router 文件式路由插件生成 `app/router/routeTree.gen.ts`，生成文件提交仓库 |
| 插件允许范围 | 允许新增该 Vite 插件；**不得**修改 `server`/`build` 参数、产物目录、`manualChunks` 分包结果 |
| 校验方式 | M1 对比改动前后 `pnpm build` 的产物与分包；若插件引起 build 行为变化，退回 code-based routes |
| 回退方案 | 手写 `routeTree`/`createRoute`（code-based），功能等价，仅失去文件式生成便利 |
| 当前现状 | 无路由库、无路由插件；`vite.config.ts` 只有 react 插件、server 代理与 manualChunks（见仓库文件） |

## 9. 迁移映射（RTK Query -> Query Options）

| 当前 RTK Query 端点 | 目标 Query | key 维度 | 迁移批次 |
|---|---|---|---|
| `getSites` | `sitesQuery.list()` | 无 | M2 |
| `getEquipmentStatus` | `equipmentStatusQuery.byFab(fabId)` | fabId | M2 |
| `getCatalog` | `catalogQuery.list(filters)` | filters（稳定序列化） | M2 |
| `getRuns` / `getRun` / `getRunResults` | `runQuery.list/detail/results` | runId | M2 |
| `createRun` | `useCreateRunMutation`（`api/mutations`） | 失效 `runQuery` 前缀 | M2 |
| `getResearchEvents` / `getWaferRoutes` | 对应静态数据 Query（可设长 `gcTime`） | 资源版本 | M2 |
| —（新增）命令权威状态 | `commandQuery.status(fabId, commandId)` | fabId+commandId | M3/M4（恢复用） |

规则：

1. 同一端点只能有一个缓存实现；迁移 PR 同时删除 RTK 端点与调用点，禁止双缓存（G-02）。
2. RTK 的 tag 失效映射为 `invalidateQueries` 前缀；不得把 tag 语义复制成 Zustand 字段。
3. 迁移顺序按页面：先只读页面（catalog/compare），后交互页面（twin/workbench），最后命令链路。
4. 未迁移页面继续用 RTK Query，且不得在迁移期间引入同端点的 Query 版本。

## 10. 反模式与评审清单

禁止：

- ❌ loader 内 `fetch(...)` 或自写 queryFn，绕过 Query Options（ARCH-04）。
- ❌ `defaultPreloadStaleTime` > 0 或未配置（ARCH-03）。
- ❌ 把 `ensureQueryData` 的返回值放进组件 props 作为唯一数据源，导致后台刷新不更新 UI。
- ❌ loader 一律 `fetchQuery`，把预加载变成请求放大。
- ❌ 把 Query 数据复制进 Zustand/Redux/组件 state（ARCH-02/05）。
- ❌ Fetch 后在组件里手写 `setState` 管理服务端数据。
- ❌ Query key 缺少 `fabId` 或运行域维度，导致跨 FAB 串缓存。
- ❌ 用 Query 建模命令“进行中”生命周期（应由 XState 工作流拥有）。
- ❌ 修改 `vite.config.ts` 的 server/build 参数来迁就路由插件（G-01）。

评审清单：

1. Query Options 是否只有一处定义？loader 与组件是否引用同一份？
2. 预加载路径是否可能产生重复请求？是否有请求计数测试？
3. 失效范围是否精确到受影响的 key/FAB？
4. 是否出现第二份缓存或 loader 返回值二次存储？
5. 新增路由是否声明 `pendingComponent`/`errorComponent`？
6. 是否改动 Vite server/build 参数？

## 11. 测试环境前置（M1）

| 项目 | 要求 | 当前状态 |
|---|---|---|
| 依赖 | @tanstack/react-router、@tanstack/react-query、路由插件、jsdom/happy-dom、@testing-library/react | 已安装（Router 1.170.46 / Query 5.105.0 / plugin 1.168.48 / jsdom 30.1.3 / Testing Library 16.3.3） |
| 测试渲染 | `render(<RouterProvider router={createRouter({ routeTree, context, history: createMemoryHistory() })} />)` | 已实现（`tests/integration/router-query.test.tsx`，合成路由树 + `createMemoryHistory`） |
| Query 隔离 | 每个测试新建 `QueryClient`（`retry: false`、按需 `gcTime`），避免跨测试缓存污染 | 已实现 |
| 网络模拟 | 在 `api/endpoints` 层 mock `fetch`；断言调用次数与参数 | 已实现（`vi.stubGlobal('fetch')` + 调用次数断言） |
| 时钟 | RQ-02 使用假时钟覆盖 `staleTime`，不得用真实 sleep | 已实现（`query-cache.test.tsx` 用 `updatedAt` 老化缓存，无真实 sleep） |
| 运行命令 | `pnpm test`（Vitest）纳入 CI/verify；浏览器专用测试仍用现有独立配置 | 已纳入：`npx vitest run` = 58 文件 / 262 测试；`./scripts/verify.ps1` PASS |

## 12. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| 预加载请求放大 | 后端压力、RQ-01 失真 | loader 默认 `ensureQueryData`；仅显式权威导航用 `fetchQuery`；请求计数门禁 |
| RQ-02 依赖假时钟/异步细节，测试易脆 | 门禁不稳定 | 使用 Query 官方测试工具（`QueryClientProvider` + `waitFor`），避免真实计时 |
| 路由迁移与现有四入口页面耦合 | 迁移期 UI 回归 | 先骨架 + 最终 URL；旧地址直接删除（无重定向），再逐页替换 |
| 插件/构建约束误用 | 违反 G-01 | 对比 build 产物；不满足即 code-based |

开放问题：见 [架构基线](architecture.md) 第 14 节的 OPEN-V21-01..05（URL 映射、版本锁定、测试环境、路径别名、Suspense 边界）。

## 13. M1 落地记录（2026-10-27）

- 实现路径：`web_app/src/app/providers/*`、`web_app/src/app/router/*`（含生成式 `routeTree.gen.ts`）、`web_app/src/api/queries/*`；`main.tsx` 已改为 `AppProviders + RouterProvider`。
- Router 配置：`defaultPreload: 'intent'`、`defaultPreloadStaleTime: 0`、`createRootRouteWithContext<{ queryClient }>`；loader 只用 `context.queryClient.ensureQueryData(sitesQueryOptions())`。
- 最终 URL：见 [架构基线](architecture.md) §4.1；旧地址/别名/重定向已在 M2a 删除，纯映射与测试在 `web_app/src/app/router/url-mapping.ts`、`web_app/tests/integration/url-mapping.test.ts`。
- sites 端点：`web_app/src/api/queries/sites.queries.ts` 的 `sitesQueryOptions()` 是唯一入口；RTK Query 的 `getSites` 已删除（G-02）。
- RQ-01/RQ-05：`web_app/tests/integration/router-query.test.tsx` 真实运行 PASS（预加载后导航 1 次请求、重叠请求 1 次在途）。
- 过渡事实：目录/对比页内部筛选/视图切换仍走 history + Redux（M2 迁移）；Twin 的 `?siteId/?modal/?mode` 仍直接读写 `location.search`。
- 验证记录：`tsc --noEmit` 0；`npx vitest run` 56 文件 / 259 测试 PASS；`vite build` 0；`./scripts/verify.ps1` exit 0。

## 14. M2a 落地记录（2026-10-27）

- 全部 7 个 RTK Query 端点迁到 TanStack Query：`api/queries/equipment|catalog|runs|research|wafer.queries.ts`，mutation 在 `api/mutations/runs.mutations.ts`；RTK Query 模块/中间件/测试删除。
- SSE 快照写入 `equipmentStatusQueryKey(siteId)`，Query 是唯一服务端缓存；4s 轮询为回退。
- RQ-02：loader 的 `ensureQueryData` 在缓存过期时仍返回旧值，页面 `useQuery` 订阅触发后台刷新；RQ-03：`createRun` 后 `invalidateRuns` 使下一次读取返回权威列表；RQ-04：equipment status 的 key 含 siteId。
- 验证：`tsc --noEmit` 0；`npx vitest run` 57 文件 / 260 测试 PASS；`vite build` 0；`./scripts/verify.ps1` exit 0（见 M2a 提交记录）。
