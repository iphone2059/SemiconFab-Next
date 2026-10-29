# SemiconFab Next：严格单层源码目录规范

**状态：** 目标目录规范，必须由架构门禁强制执行。\
**作用范围：** 仅 `web_app/src`。`web_app/tests`、`tools`、`docs`
的测试夹具和文档可以使用自己的分层结构。\
**硬约束：** 生产源码目录深度最多为 `src/<module>/<file>`；不允许
`src/<module>/<submodule>/<file>`。

## 1. 目录规则

允许：

``` text
web_app/src/
├── main.tsx
├── app/
│   ├── app-providers.tsx
│   └── app-runtime.ts
├── api/
│   ├── http.transport.ts
│   └── sites.resource.ts
├── catalog/
│   ├── catalog-page.tsx
│   └── catalog-search.ts
└── twin/
    ├── twin-page.tsx
    └── twin-selection.atom.ts
```

禁止：

``` text
web_app/src/features/twin/state/twinPageStore.ts
web_app/src/api/queries/sites.queries.ts
web_app/src/rendering/lite/geometry/facility.ts
```

以上路径中的模块语义可以保留，但文件必须移动到唯一的一级模块目录，并通过文件名保留原有子领域含义。

### 1.1 根目录规则

`src` 根目录只允许应用入口
`main.tsx`。其他源文件必须属于一个一级模块目录。禁止在 `src` 根目录堆积
contracts、types、utils 或 feature 实现。

### 1.2 模块目录规则

-   模块目录使用小写英文名；多词目录使用 kebab-case。
-   每个模块目录直接包含源文件，不得包含任何子目录。
-   不建立 `misc`、`common`、`stuff`、`helpers`
    这类没有清晰所有权的目录。
-   不建立一个巨大的 `features/` 目录再在其中创建
    `catalog/`、`twin/`、`workbench/`。三个 Feature 直接成为
    `src/catalog`、`src/twin`、`src/workbench`。
-   不为迁就旧路径而建立 `api-queries`、`feature-twin-state`
    等模拟层级的目录；层级语义通过明确的文件名表达。
-   不保留只有一个转发导出的目录或 barrel
    文件。跨模块导入应指向明确的文件。

## 2. 目标目录清单

  ----------------------------------------------------------------------------------------------------------
  一级目录                唯一职责                                    不允许放入
  ----------------------- ------------------------------------------- --------------------------------------
  `app/`                  应用组合根、Provider、AppRuntime            业务页面、资源缓存实现
                          工厂、应用级装配                            

  `api/`                  HTTP transport、Schema、Resource            React 页面、第二份快照缓存
                          Atom、mutation、资源 freshness helper       

  `assets/`               源码需要导入的静态资源                      生成代码、业务计算

  `catalog/`              Catalog Feature 页面、筛选控制、导入导出与  Twin/Workbench 内部实现
                          Feature Atom                                

  `components/`           跨 Feature 可复用的 UI 原语                 特定 Feature 的页面状态

  `contracts/`            跨模块稳定契约、端口和共享 DTO              实现代码、运行时装配

  `domain/`               纯业务计算、领域模型、确定性投影            React、Effect、网络、浏览器全局、GPU
                                                                      资源

  `generated/`            工具生成的契约、翻译和打包数据              手工维护的业务逻辑

  `lib/`                  与领域无关的纯技术工具，例如合批器          服务端数据缓存、Feature 状态

  `localization/`         语言类型、翻译入口和本地化策略              与语言无关的业务状态

  `realtime/`             SSE 传输、协议、顺序门、遥测                React 页面、业务命令状态机
                          Worker、有限缓冲区                          

  `rendering/`            Babylon Lite、WebGPU、场景与 GPU 生命周期   Atom、Query、Zustand、Effect 高频循环

  `routes/`               TanStack Router 路由定义、route             直接 HTTP 请求、资源缓存
                          tree、search schema、路由数据适配           

  `runtime/`              FAB 生命周期、命令桥、命令恢复、XState      页面 UI 组件
                          adapter 与运行时注册表                      

  `state/`                应用级偏好 Atom，例如语言和主题             服务器快照、所有 Feature 的统一大
                                                                      Store

  `twin/`                 Twin Feature                                Babylon 引擎内部实现、其他 Feature
                          的页面、控制器、HUD、播放、选择和低频投影   的私有状态

  `workbench/`            Workbench 页面、Run                         资源缓存实现、Twin 私有状态
                          表单、命令控制台和提交流程 UI               
  ----------------------------------------------------------------------------------------------------------

没有实际文件需要的目录不必提前创建。新增目录必须属于上述清单，或通过架构评审新增明确职责；新增目录仍不得包含子目录。

## 3. 文件命名

### 3.1 基础规则

-   文件名使用小写 kebab-case。
-   文件名必须表达领域对象或职责，不使用
    `index.ts`、`utils.ts`、`helpers.ts`、`common.ts`
    等模糊名称作为默认组织方式。
-   React 组件使用 `.tsx`；不渲染 UI 的纯逻辑使用 `.ts`。
-   生成文件以 `.generated.ts` / `.generated.tsx`
    结尾，并登记到生成物清单。
-   不在一个文件中混放多个不相关领域的实现。

### 3.2 建议后缀

  ----------------------------------------------------------------------------------------------
  后缀                    含义                      示例
  ----------------------- ------------------------- --------------------------------------------
  `.atom.ts`              Atom 定义或领域投影 Atom  `locale.atom.ts`、`twin-selection.atom.ts`

  `.resource.ts`          远程资源 Atom             `sites.resource.ts`、`runs.resource.ts`
                          与资源读取策略入口        

  `.mutation.ts`          写入型业务请求            `runs.mutation.ts`

  `.schema.ts`            Effect Schema 与网络解码  `sites.schema.ts`

  `.transport.ts`         HTTP/SSE/其他传输适配器   `http.transport.ts`

  `.protocol.ts`          线协议与数据帧类型        `equipment-status.protocol.ts`

  `.gate.ts`              顺序、身份或接纳门        `equipment-status.gate.ts`

  `.worker.ts`            Worker 入口               `telemetry.worker.ts`

  `.machine.ts`           XState machine 定义       `equipment-command.machine.ts`

  `.route.tsx`            单个路由定义              `equipment-compare.route.tsx`

  `.port.ts`              端口接口                  `scene.port.ts`

  `.contract.ts`          稳定模块契约              `command-workflow.contract.ts`
  ----------------------------------------------------------------------------------------------

不要求每个文件都添加后缀；只有在后缀能够区分不同职责时才使用。

## 4. 目标源码树

下面列出目录和代表性文件，不要求预先创建空文件。全部目录都是 `src`
的直接子目录，所有文件均在所属目录的第一层。

``` text
web_app/src/
├── main.tsx
├── app/
│   ├── app-providers.tsx
│   ├── app-runtime.ts
│   ├── app-runtime-factory.ts
│   ├── runtime-bootstrap.tsx
│   ├── runtime-provider.tsx
│   └── telemetry-provider.tsx
├── api/
│   ├── http.transport.ts
│   ├── http-error.ts
│   ├── sites.schema.ts
│   ├── catalog.schema.ts
│   ├── runs.schema.ts
│   ├── command.schema.ts
│   ├── sites.resource.ts
│   ├── catalog.resource.ts
│   ├── equipment-status.resource.ts
│   ├── runs.resource.ts
│   ├── research.resource.ts
│   ├── wafer.resource.ts
│   ├── resource-policy.ts
│   ├── runs.mutation.ts
│   └── http-command-gateway.ts
├── assets/
├── catalog/
│   ├── catalog-page.tsx
│   ├── catalog-data.ts
│   ├── catalog-table.tsx
│   ├── catalog-filters.tsx
│   ├── catalog-comparison.tsx
│   ├── catalog-detail.tsx
│   ├── catalog-import.ts
│   ├── catalog-export.ts
│   ├── catalog-download.ts
│   ├── catalog-search.ts
│   ├── catalog.atom.ts
│   └── catalog-types.ts
├── components/
│   ├── error-boundary.tsx
│   ├── modal.tsx
│   ├── class-names.ts
│   ├── original-icons.tsx
│   └── original-icons-data.ts
├── contracts/
│   ├── api.contract.ts
│   ├── command-events.contract.ts
│   ├── command-gateway.contract.ts
│   ├── command-workflow.contract.ts
│   ├── scene.port.ts
│   └── app-contracts.ts
├── domain/
│   ├── amhs-timeline.ts
│   ├── equipment-tool-state-projection.ts
│   ├── fab-layout.ts
│   ├── fab-layout-identities.ts
│   ├── fab-cleanroom-pressure.ts
│   ├── fab-process-control.ts
│   ├── fab-yield.ts
│   ├── fab-twin-spatial.ts
│   ├── math-round.ts
│   ├── math-vec3.ts
│   ├── personnel-timeline.ts
│   ├── simulation-scenario.ts
│   ├── simulation-research-replay.ts
│   ├── simulation-tour-timeline.ts
│   ├── wafer-map.ts
│   ├── wafer-route.ts
│   └── wafer-timeline.ts
├── generated/
│   ├── contracts.generated.ts
│   ├── static-structure-packed.generated.ts
│   └── twin-translations.generated.ts
├── lib/
│   └── coalesced-dispatcher.ts
├── localization/
│   ├── language.ts
│   └── twin-translations.ts
├── realtime/
│   ├── frame-ring-buffer.ts
│   ├── equipment-status.protocol.ts
│   ├── equipment-status.gate.ts
│   ├── equipment-status.transport.ts
│   ├── message-decoder.ts
│   ├── command-event-source.transport.ts
│   ├── telemetry-registry.ts
│   ├── telemetry-runtime.ts
│   ├── telemetry.worker.ts
│   └── telemetry-worker.logic.ts
├── rendering/
│   ├── lite-backend.ts
│   ├── lite-runtime.ts
│   ├── lite-camera.ts
│   ├── lite-world.ts
│   ├── lite-lighting.ts
│   ├── lite-motion.ts
│   ├── lite-geometry-facility.ts
│   ├── lite-geometry-static-structure.ts
│   ├── lite-effects-cut.ts
│   ├── lite-effects-wafer.ts
│   ├── lite-effects-xray.ts
│   ├── lite-effects-xray-shaders.ts
│   └── static-structure-data.contract.ts
├── routes/
│   ├── root.route.tsx
│   ├── home.route.tsx
│   ├── equipment.route.tsx
│   ├── equipment-index.route.tsx
│   ├── equipment-compare.route.tsx
│   ├── fab-3d.route.tsx
│   ├── route-tree.ts
│   ├── router.tsx
│   ├── route-data.ts
│   ├── route-search.ts
│   └── route-url-mapping.ts
├── runtime/
│   ├── fab-lifecycle-coordinator.ts
│   ├── fab-runtime.ts
│   ├── fab-runtime-factory.ts
│   ├── fab-runtime-registry.ts
│   ├── command-correlation-registry.ts
│   ├── command-event-bridge.ts
│   ├── command-event-recovery.ts
│   ├── command-reconciler.ts
│   ├── xstate-command-workflow-adapter.ts
│   ├── equipment-command.machine.ts
│   └── equipment-command.logic.ts
├── state/
│   ├── locale.atom.ts
│   └── preferences.atom.ts
├── twin/
│   ├── twin-page.tsx
│   ├── twin-viewer.tsx
│   ├── twin-dialogs.tsx
│   ├── twin-inspector.tsx
│   ├── twin-sidebar.tsx
│   ├── twin-selection.atom.ts
│   ├── twin-ui.atom.ts
│   ├── twin-demo.atom.ts
│   ├── twin-playback.ts
│   ├── twin-tour-controller.ts
│   ├── twin-wafer-playback.ts
│   ├── twin-research-playback.ts
│   ├── twin-equipment-status-pipeline.tsx
│   └── twin-wafer-session.ts
└── workbench/
    ├── workbench.tsx
    ├── command-console.tsx
    ├── run-form.tsx
    ├── run-submission.ts
    ├── run-history.tsx
    ├── workbench-metrics.tsx
    ├── workbench.atom.ts
    └── workbench-format.ts
```

该树是目标归属示例。实际迁移必须先逐文件盘点所有权；不能因为文件名相似就机械合并，也不能遗漏当前源码中的文件。`assets/`
等没有示例文件的目录只有在真实需要时才保留。

## 5. 当前目录到目标目录的迁移映射

  ------------------------------------------------------------------------------------------------------------------------
  当前路径                                      目标路径/规则
  --------------------------------------------- --------------------------------------------------------------------------
  `app/providers/*`                             全部平移至 `app/`，使用 `app-providers.tsx` 等唯一命名

  `app/router/*`                                路由定义移至 `routes/`；`router.tsx`、`route-data.ts`、`route-search.ts`
                                                等平铺

  `app/router/routes/equipment/*`               分别移动为
                                                `routes/equipment-index.route.tsx`、`routes/equipment-compare.route.tsx`

  `app/router/routes/fabs/$fabId/3d.tsx`        移动为 `routes/fab-3d.route.tsx`；URL 参数仍使用 `$fabId` 语义

  `api/queries/*`                               移动为 `api/*.resource.ts`；删除 QueryClient 与 QueryKey 模型

  `api/mutations/*`                             移动为 `api/*.mutation.ts`

  `api/schemas/*`                               移动为 `api/*.schema.ts`，使用 Effect Schema

  `api/transport/*`                             移动为 `api/*.transport.ts` 或明确命名的 gateway 文件

  `api/cache/equipment-status-bridge.ts`        重新拆分职责：Gate 在 `realtime/`，Snapshot Atom 在
                                                `api/equipment-status.resource.ts`，REST/SSE 到 Atom 的协调放入 `runtime/`

  `application/contracts/*`                     移动为 `contracts/*.contract.ts`

  `application/coordination/*`                  按实际所有权移至 `runtime/`；不允许保留 `application/coordination/` 子目录

  `application/ports/scene.ts`                  移动为 `contracts/scene.port.ts`

  `features/catalog/*`                          移动到 `catalog/`，Feature 文件直接平铺

  `features/twin/*`                             移动到 `twin/`，Feature 文件直接平铺；`state/` 与 `controllers/`
                                                不再建子目录

  `features/workbench/*`                        移动到 `workbench/`，Feature 文件直接平铺

  `domain/*/*`                                  所有纯领域文件移至 `domain/`，用领域前缀消除重名

  `realtime/*/*`                                所有文件移至 `realtime/`，文件名保留 `equipment-status-`、`telemetry-`
                                                等前缀

  `rendering/lite/*`                            平移至 `rendering/`；用 `lite-geometry-`、`lite-effects-`、`lite-shadows-`
                                                前缀表达原子目录职责

  `runtime/commands/*`                          平移至 `runtime/`，使用 `command-`、`equipment-command-`、`xstate-` 前缀

  `state/createSliceStore.ts`                   删除；所有 Zustand Store 迁移后不再需要该工厂

  `state/localeStore.ts`                        迁移为 `state/locale.atom.ts`

  `state/preferences.ts`                        迁移为 `state/preferences.atom.ts`，仅保留真实全局偏好

  `state/runtimeStore.ts`                       逐字段分类；生命周期归 `app/runtime`，Twin 投影归 `twin`，引擎对象归
                                                `rendering`，禁止整体转换为巨型 Atom

  `shared/scheduling/coalesced-dispatcher.ts`   移动为 `lib/coalesced-dispatcher.ts`

  `src/contracts.ts`                            拆分并移入 `contracts/`；不得保留在 `src` 根目录

  `generated/*`                                 保持 `generated/` 一级目录，更新所有生成物路径登记
  ------------------------------------------------------------------------------------------------------------------------

## 6. Router 迁移要求

当前 `vite.config.ts` 使用 `@tanstack/router-plugin` 生成
`src/app/router/routeTree.gen.ts`，现有门禁会验证生成结果与插件一致。单层目录目标与该文件式目录结构不兼容。

目标方案：

1.  移除 Vite 中的 `tanstackRouter` 插件配置及 `@tanstack/router-plugin`
    依赖。
2.  在 `routes/` 内使用 `createRootRouteWithContext`、`createRoute` 和
    `addChildren` 显式声明路由。
3.  保留 `Register` 类型注册，所有路由参数与 search
    参数保持推断类型；禁止新增长期 `as RouterSearch` 断言。
4.  保留 `/`、`/equipment`、`/equipment/compare`、`/fabs/$fabId/3d` 的
    URL。
5.  保留 root `errorComponent`、`notFoundComponent`，以及首页和未知 FAB
    的不同错误处理语义。
6.  保留 Twin 页的动态代码分割；使用项目实际支持并已测试的动态导入方式。
7.  删除生成路由树专属的 `@ts-nocheck` allowlist；生产源码默认禁止
    `@ts-nocheck`。
8.  将 `route-tree-generation.test.ts` 改成 code-based route tree
    合同测试；重写
    `route-code-splitting.test.ts`，验证实际动态分割行为，而不是断言
    Vite 配置仍包含文件路由插件选项。
9.  保留 Router 精确版本 pin 和 lockfile 单一解析门禁。移除 plugin
    不等于放弃 Router 版本控制。

这是为满足单层目录要求而作出的有意取舍。TanStack
官方文档通常推荐文件式路由，因此 code-based routing
必须通过测试补齐其原先由插件生成和校验的约束。

## 7. Import 规则与命名空间

建议设置 `@/` 指向 `web_app/src`：

-   同一个一级目录内允许相对导入。
-   跨一级目录使用 `@/api/sites.resource`、`@/domain/fab-layout`
    等明确路径。
-   不允许跨 Feature 导入 `@/twin/*`、`@/catalog/*` 或 `@/workbench/*`
    的内部实现。
-   `contracts/` 只导出稳定接口和数据契约，不作为通用转发层。
-   `lib/` 只允许纯技术工具；不得把资源缓存或业务状态藏在 `lib`。
-   `domain/` 不得导入 React、Effect、Router、网络包、XState、Babylon 或
    Worker 全局。
-   `rendering/` 不得导入 `@effect/atom-react`、Effect Runtime、React
    Query、Zustand 或 XState。
-   `routes/` 不得直接调用 `fetch`；必须调用 `AppRuntime` 资源 facade。
-   `XState` 只允许由 `runtime/` 中的 machine/adapter 文件导入。
-   `Effect.run*` 只允许在 `app/` 组合根和经批准的 React/Router
    适配文件出现。

若使用 `@/`，TypeScript、Vite、Vitest 与架构导入图必须使用相同 alias
定义。R0 导入图测试必须能解析 alias，并检查 alias
与相对路径混用不会形成漏检。

## 8. 自动化目录门禁

新增 `source-layout.test.ts` 或等价的架构检查：

1.  扫描 `web_app/src` 下所有目录。
2.  任何相对 `src` 深度大于 1 的目录均失败。
3.  `src` 根目录仅允许 `main.tsx`。
4.  一级目录必须在允许列表中；新增目录需先修改规范和测试。
5.  文件名不得出现空白、PascalCase 或不规范的目录层级编码。
6.  生产源码禁止 `@ts-nocheck`。
7.  所有相对导入和 `@/` 导入必须解析成功。
8.  测试包含负向 fixture：故意创建 `src/api/queries/example.ts`
    必须失败。
9.  架构门禁必须报告违规路径、规则编号和修复方向。

`tests/architecture/fixtures/`
可继续嵌套；目录深度规则只扫描真实生产源码 `src/`，不得误扫测试
fixture。

## 9. 官方路由参考

-   [TanStack Router Code-Based
    Routing](https://tanstack.com/router/latest/docs/routing/code-based-routing)
-   [TanStack Router Route
    Trees](https://tanstack.com/router/latest/docs/routing/route-trees)
-   [TanStack Router Creating a
    Router](https://tanstack.com/router/latest/docs/guide/creating-a-router)

官方说明 code-based routing
并非多数应用的首选；这里选择它是为了满足项目的硬性单层目录约束，不应把这一选择描述为
TanStack 官方普遍推荐的目录方案。
