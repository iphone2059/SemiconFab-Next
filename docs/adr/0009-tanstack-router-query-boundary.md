# ADR-0009 — TanStack Router 只做导航与加载协调，TanStack Query 独占服务端数据缓存

- 状态：已采纳（2026-10-27）；实施状态：未开始（Status: Accepted / implementation pending）
- 取代：迁移完成后取代 [ADR-0008](0008-redux-toolkit-rtk-query.md) 中“服务端数据由 RTK Query 缓存”与“页面/交互状态由 Redux slice 承载”的部分；ADR-0008 的渲染循环约束经 [ADR-0010](0010-command-event-bridge.md) 与 [渲染管线](../rendering.md) 重新表述
- 关联：[ADR-0003](0003-single-web-app.md)（单站点）、[ADR-0006](0006-single-backend-application.md)（唯一后端）、[ADR-0010](0010-command-event-bridge.md)；基线汇总见 [架构基线](../architecture.md)，实施细则见 [路由与查询集成](../router-query-integration.md) 与 [状态管理](../state-management.md)
- 决策范围：仅前端 `web_app`。本文档不修改代码、依赖或 Vite 配置；迁移落地前，当前实现仍以 ADR-0008 与 [实施状态](../IMPLEMENTATION-STATUS.md) 为准

## 背景

2026-10-27 的 `web_app` 是一个 Vite + React 单站点：入口 `src/main.tsx` 用自定义 pathname 分支在 workbench/catalog/compare/twin 之间切换，服务端数据由 RTK Query（`store/api.ts`）缓存，页面/交互状态由 Redux Toolkit 的多个 slice 承载（ADR-0008）。这一实现有三个与 V2.1 目标不一致的结构性问题：

1. **没有类型化路由层**：URL 解析是手写字符串匹配，搜索参数没有 schema 校验，也没有“悬停预加载”能力；页面进入数据加载的时机只能靠组件 `useEffect`。
2. **新鲜度入口不唯一**：RTK Query 的 tag/polling 与页面局部 effect 并存，容易出现同一服务端值被多个消费者各自刷新，或页面切换后仍显示旧缓存。
3. **服务端缓存与客户端状态混在同一容器**：Redux slice 里既存 UI 状态也存服务端结果，迁移时难以判断“删除哪一份缓存才是安全的”。

Engineering v1.1 已把 TanStack Query、Zustand 列为 SELECTED（[90-DECISIONS-AND-OPEN-ITEMS](../SemiconFab-Next-Engineering-v1.1/engineering/90-DECISIONS-AND-OPEN-ITEMS.md) 第 2 节），并在 [15-FRONTEND-AND-WEBGPU-PROJECTS](../SemiconFab-Next-Engineering-v1.1/engineering/15-FRONTEND-AND-WEBGPU-PROJECTS.md) 第 1 节推荐 React Router + TanStack Query + Zustand。V2.1 保留 Query/Zustand 的选择，但在路由层选择 **TanStack Router**：只有同一套 loader/preload/context 机制能把“导航意图”与“Query 加载”连接起来，而 Router 不因此成为第二个数据缓存。该选择只取代 Engineering v1.1 中“React Router”的建议，不修改其文档。

关键设计难点是：Router 的预加载缓存有“新鲜度”概念（默认约 30 秒），如果 loader 是数据加载的唯一入口，Router 可能因为“预加载结果还新鲜”而跳过 loader 重跑；而 Query 可能已经按自己的 `staleTime` 判定数据过期。两个缓存各有一套时间语义，必须显式收口。

## 决策

### 1. 职责边界

| 关注点 | 所有者 | 说明 |
|---|---|---|
| URL、路径参数、搜索参数、导航、重定向、按意图预加载 | TanStack Router | 只负责“何时进入页面、进入前要准备什么”；不持有 HTTP 响应缓存 |
| HTTP 服务端数据的缓存、去重、新鲜度、失效、后台刷新 | TanStack Query | 唯一的 HTTP 服务端缓存；其他容器不得保存其副本 |
| 客户端 UI 状态（面板、视图偏好、临时选择等） | Zustand 或组件局部状态 | 不保存 Query 结果副本（ARCH-05） |
| 命令/工作流生命周期 | XState v6（经 CommandWorkflow 契约） | 见 [ADR-0010](0010-command-event-bridge.md) |
| 高频遥测与 3D 数据 | Worker/环形缓冲 + Babylon Lite | 不进入 Router/Query/Zustand/XState（ARCH-11） |

### 2. QueryClient 通过 Router context 注入

应用只创建一个 `QueryClient`（`api/queries/queryClient.ts`），在根路由创建时通过 context 注入，而不是在每个 loader 里 import 单例：

```tsx
// app/router/__root.tsx
import { createRootRouteWithContext } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootComponent,
});
```

```tsx
// app/router/router.tsx
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { queryClient } from '../../api/queries/queryClient';

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
});

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
```

约定：`context.queryClient` 是 loader 访问 Query 的唯一入口；页面组件通过 `useQueryClient()` 或 Query hooks 访问同一实例。禁止在模块内再创建第二个 `QueryClient`，也禁止 loader 直接 `fetch`。

### 3. 预加载配置：`defaultPreload: 'intent'` 与 `defaultPreloadStaleTime: 0`

- `defaultPreload: 'intent'`：用户 hover/focus/touch 链接时预加载目标路由与 loader，这是 RQ-01 用户场景的入口。
- `defaultPreloadStaleTime: 0`：让 Router 的预加载结果在“紧接着导航”时仍重新运行 loader。Router 默认约 30 秒的 preload 新鲜度会认为预加载结果仍然新鲜并跳过 loader；那样 Query 的新鲜度就没有机会表达，会出现“Query 已过期但 Router 让页面使用旧数据”的错配。
- 该配置**只移除 Router 对 loader 重跑的否决**，不改变 Router 自身路由缓存的保留策略；Router cache retention 与 Query 的 `staleTime`/`gcTime` 相互独立。
- **`defaultPreloadStaleTime: 0` 是必要条件，但不是充分条件。** 数据是否新鲜还取决于：Query 选项一致（同一 key、同一 `queryFn`、同一 `staleTime`）、页面是否用 `useQuery`/`useSuspenseQuery` 订阅、mutations 是否失效对应 key、需要权威数据时是否显式 `fetchQuery`、以及是否还残留第二个缓存。

### 4. loader 用 `ensureQueryData(queryOptions)`，且与组件复用同一份 Query Options

```ts
// api/queries/equipment.queries.ts
import { queryOptions } from '@tanstack/react-query';
import { getEquipment } from '../endpoints/equipment.endpoint';

export const equipmentQueries = {
  detail: (fabId: string, equipmentId: string) => queryOptions({
    queryKey: ['fab', fabId, 'equipment', equipmentId],
    queryFn: () => getEquipment(fabId, equipmentId),
  }),
};
```

```ts
// app/router/routes/fabs/$fabId/equipment/$equipmentId.tsx
loader: ({ context, params }) =>
  context.queryClient.ensureQueryData(equipmentQueries.detail(params.fabId, params.equipmentId)),
```

```tsx
// 组件订阅同一个 Query Options
const { data } = useQuery(equipmentQueries.detail(fabId, equipmentId));
// 或：const { data } = useSuspenseQuery(equipmentQueries.detail(fabId, equipmentId));
```

语义约束：

- `ensureQueryData` 在缓存已有数据时直接返回缓存（即使该数据按 `staleTime` 已过期），**不会因为过期而强制发起网络请求**；缓存未命中时才调用 `queryFn`。
- 因此 loader 的职责是“保证页面首次渲染有数据”，而不是“判断数据是否新鲜”；新鲜度由 Query 的订阅刷新、失效和后台重取负责。
- 页面必须用 `useQuery`/`useSuspenseQuery` 订阅同一 Query Options；禁止把 loader 返回值当作组件唯一数据源（那样后台刷新不会触发重渲染）。
- 确实需要“权威新数据才能继续”的导航（例如命令终态后的确认页、审计视图）使用 `queryClient.fetchQuery(...)` 显式获取并写回缓存；`fetchQuery` 是逐路由的显式选择，不能变成 loader 的默认写法，否则每次预加载都会产生网络请求，RQ-01 也就失去意义。注意 `fetchQuery` 仍遵循传入 options 的 `staleTime`：若复用某份 `staleTime > 0` 的 Query Options 且数据仍新鲜，它会直接返回缓存；需要无条件网络取数时必须显式覆盖 `staleTime: 0`。
- `fetchQuery` 与 `ensureQueryData` 都会写同一份 Query 缓存，不存在第三份缓存。

### 5. Query 是唯一 HTTP 服务端缓存；Router 不缓存响应体

- 禁止把 loader 返回值再放进 Router search state、Context 或 Redux/Zustand。
- 页面需要的服务端数据只能通过 Query hooks 或 `queryClient` 读取。
- Zustand 只保存 UI 状态；如果某个值来自 Query，它必须在渲染时从 Query 读取，而不是复制进 store（ARCH-05）。

### 6. 文件式路由与 Vite 约束

- 路由生成采用 TanStack Router 的文件式路由插件（官方 Vite 插件，具体包名/版本在 M1 核实）：路由文件位于 `app/router/routes/`，生成 `app/router/routeTree.gen.ts` 并提交仓库。
- **Vite 约束（用户确认）**：`web_app/vite.config.ts` 的 `server` 与 `build` 参数（端口 5173/strictPort/host、`/api` 代理、`build.rolldownOptions.manualChunks`）**不得改变**；允许新增路由生成插件，但插件不得改动 server/build 参数、产物目录或分包结果。若插件要求改变 build 参数，则退回 **code-based routes**（手写 `routeTree`/`createRoute`），不得违反约束。
- 该约束是架构护栏 G-01，见 [架构基线](../architecture.md) 的“架构护栏”一节。

### 7. 必测门禁 RQ-01..RQ-05

以下门禁在 [路由与查询集成](../router-query-integration.md) 中有 Given/When/Then 与断言点；当前全部为 **SPECIFIED / NOT RUN**，没有任何通过证据：

| ID | 门禁 |
|---|---|
| RQ-01 | hover 预加载后立即导航，复用 Query 数据，不重复请求 |
| RQ-02 | 预加载后数据过期再导航，遵循 Query 新鲜度（loader 不阻塞、页面订阅触发一次后台刷新） |
| RQ-03 | mutation 失效后展示刷新后的权威数据 |
| RQ-04 | FAB-A/FAB-B 相同设备 id 不串缓存 |
| RQ-05 | 预加载与导航请求重叠时复用同一 in-flight 请求 |

### 8. 迁移期间的双栈规则

ADR-0008 的 RTK Query 在代码层面仍然存在。为避免双缓存互相污染：

1. 按端点/页面逐个切换：同一端点不得同时被 RTK Query 与 TanStack Query 缓存。
2. 每个迁移 PR 必须同时删除对应的 `twinApi` 端点、hooks 与 slice 中的服务端字段；不得保留“兼容旧页面”的第二份缓存。
3. 未迁移页面继续使用 RTK Query；迁移完成度以 [实施状态](../IMPLEMENTATION-STATUS.md) 与迁移记录为准。
4. 在 M1/M2 完成前，ADR-0008 仍是当前实现的权威描述；本 ADR 只是目标基线。

## 不改变的事项

- 单站点 `web_app`（ADR-0003）、单一后端 `fab_app`（ADR-0006）不变。
- Query/Zustand 的选型与 Engineering v1.1 的 SELECTED 决策一致；本 ADR 只把 Engineering v1.1 中 React Router 的建议更新为 TanStack Router，未修改外部规范文档。
- Babylon Lite + WebGPU-only、单 FAB 当前产品边界、现有 REST 端点与 UI 交互不在本 ADR 范围内。
- 本基线不新增依赖、不改 `vite.config.ts`、不改代码。

## 后果

**正面**

- 导航意图（hover 预加载）与数据加载统一，页面切换可以直接使用已预热数据。
- 服务端缓存只有一个所有权，失效/刷新语义可测试（RQ-01..05）。
- loader 与组件复用 Query Options，减少“loader 取一次、组件再取一次”的重复逻辑。
- 路由搜索参数可 schema 校验，URL 成为可分享的页面状态。

**代价与风险**

- 新增 TanStack Router/Query 依赖、路由插件与生成文件；需要 DOM 测试环境才能覆盖 RQ 门禁（当前测试是 `renderToStaticMarkup`，未安装 jsdom/Testing Library）。
- 双栈期间存在误留两份缓存的风险，必须按端点在同一个 PR 内完成切换。
- `defaultPreloadStaleTime: 0` 会让每次 intent 预加载都重跑 loader；如果 loader 里误用 `fetchQuery`，预加载会放大请求量。需要请求计数类测试（RQ-01/RQ-05）守住。
- “Query 新鲜度”与“权威数据”容易被混为一谈；必须保留 `fetchQuery` 的显式入口并在评审中检查。

## 备选方案

| 方案 | 结论 | 原因 |
|---|---|---|
| React Router data router + TanStack Query | 不采纳 | 可以工作，但 loader/preload/context 与 Query 的对接需要自建粘合；Engineering v1.1 的 React Router 建议是泛化推荐，ADR-0009 的目标需要更明确的 intent 预加载语义 |
| 继续使用 RTK Query 作为唯一缓存 | 不采纳 | 与 V2.1 决策冲突；RTK Query 的 tag 失效模型可以满足部分场景，但无法与 Router loader/预加载形成单一新鲜度入口 |
| 只引入 Router，不改缓存 | 不采纳 | 会出现 Router 预热结果与 RTK Query 两套缓存并存的错误结构 |
| Router loader 直接 `fetch` + 局部状态 | 不采纳 | 无缓存、无去重、无失效；RQ-01/RQ-05 不可满足 |

## 开放问题

| ID | 问题 | 影响 | 建议 |
|---|---|---|---|
| OPEN-V21-01 | 现有页面（`/`、`/catalog`、`/compare`、`/twin`）到 `routes/fabs`、`routes/equipment`、`routes/amhs`、`routes/alarms` 的最终 URL 与重定向策略 | 路由迁移顺序与 RQ 测试夹具 | 由 Lead 在 M1 前确认；本基线只定义目录结构，不虚构产品路由 |
| OPEN-V21-02 | TanStack Router/Query 的版本锁定与路由插件版本 | 依赖安装与 lockfile | M1 开始时核实并锁文件记录；本基线不写具体版本 |
| OPEN-V21-03 | 集成测试环境（jsdom/happy-dom + Testing Library） | RQ-01..05 能否执行 | M1 前置依赖，需批准新增 devDependencies |
| OPEN-V21-04 | 是否引入 `@/` 路径别名 | 目标目录的导入风格 | 当前 ADR-0003 要求相对导入；如引入别名需同时改 tsconfig 与 Vite resolve（属允许的插件/配置范围，但不在本基线） |
| OPEN-V21-05 | 页面级 `useSuspenseQuery` 的边界与错误/加载 UI | UX 与测试稳定性 | M1 内先提供 `pendingComponent`/`errorComponent` 约定再铺开到页面 |
