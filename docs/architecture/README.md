# SemiconFab Next：Effect 4 与单层源码目录重构文档

**文档状态：** 设计草案，待架构决策批准；不是已实施或已验收声明。\
**基线：** 远端 `main` 的源码基线
`4fc8a94a3f10d185c8bef7929349ac6ccb2b8792`。\
**范围：** `web_app` 前端；不重构 ASP.NET Core 后端，不改变 Babylon
Lite + WebGPU-only 的产品约束。

## 文档地图

  ------------------------------------------------------------------------------------------------------
  文档                                        用途
  ------------------------------------------- ----------------------------------------------------------
  `01-effect4-target-architecture.md`         目标架构、状态所有权、Effect Runtime、资源缓存、实时数据与
                                              XState 契约

  `02-flat-source-layout.md`                  `web_app/src` 严格单层目录、命名规则、旧路径映射与路由改造

  `03-migration-plan.md`                      可执行的分阶段重构顺序、任务边界、依赖清理与回滚策略

  `04-acceptance-and-architecture-gates.md`   自动化门禁、浏览器验收、性能基线、负向测试与最终验收清单
  ------------------------------------------------------------------------------------------------------

## 本次重构的核心决定

1.  `effect` 与 `@effect/atom-react`
    负责应用副作用、异步执行和响应式状态。
2.  一个应用实例只创建一个 `AtomRegistry`；Router loader 和 React
    组件必须使用同一 Registry。
3.  移除 Zustand、TanStack Query、Zod、RxJS，不保留模拟这些库 API
    的兼容层。
4.  保留 TanStack Router、React、XState 和 Babylon Lite；渲染仍然只使用
    WebGPU，不引入 WebGL。
5.  `web_app/src` 只允许 `src/<module>/<file>` 结构；不允许
    `src/<module>/<submodule>/<file>`。
6.  因为当前文件式路由依赖嵌套目录，严格单层目录要求意味着路由改为
    TanStack Router code-based routing。URL 与错误处理语义必须保持不变。
7.  高频遥测、TypedArray、Worker 数据通道和 Babylon Lite 引擎对象不进入
    AtomRegistry。
8.  命令生命周期仍由 XState 拥有；Effect 管理 actor
    生命周期、事件串行化、取消、资源释放和恢复工作。

## 重要边界

-   远端 `main` 当前仍使用 Zustand、TanStack Query、Zod、RxJS 和
    `@tanstack/router-plugin`。本文定义的是目标，不代表这些依赖已经删除。
-   提供的迁移提案将 `effect` 与 `@effect/atom-react` 目标版本设为
    `4.0.7`。实施前必须以实际安装包、锁文件和类型检查确认该精确版本的
    API；不能根据最新版文档直接推断补丁版本完全一致。
-   项目现有架构文档和测试包含文件式路由、生成路由树以及 Vite
    插件约束。改成 code-based routing
    是为满足单层目录而进行的明确架构变更，必须同步更新相关测试与架构规范，不能只删除目录。
-   本文不声称已经运行浏览器、WebGPU、性能或迁移后构建测试。
-   新增的容量驱逐诊断、终态优先保留、资源 freshness
    helper、命令恢复并发上限等均属于目标行为；若当前源码不具备，必须作为新增实现与测试处理。

## 建议的文档落点

将文档保存到 `docs/architecture/`，不要放进当前架构门禁明确禁止的
`docs/superpowers/` 路径，除非项目正式修改并验证该门禁规则。

## 参考基线

-   当前前端依赖：`web_app/package.json`
-   当前架构门禁：`web_app/tests/architecture/architecture-import-graph.test.ts`、`architecture-contract-rules.test.ts`、`route-tree-generation.test.ts`
-   当前资源缓存：`web_app/src/api/queries/`
-   当前设备状态顺序门：`web_app/src/realtime/equipment-status/` 与
    `web_app/src/api/cache/equipment-status-bridge.ts`
-   当前命令工作流：`web_app/src/runtime/`、`web_app/src/application/`
-   当前渲染边界：`web_app/src/rendering/`、`web_app/src/realtime/workers/`
