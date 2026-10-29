# Effect 4 重构：验收矩阵与架构门禁

**状态：** 目标验收规范。每项必须在实现后执行并保存结果；本文不是 PASS
记录。

## 1. 验收等级

  ----------------------------------------------------------------------------------------------------
  等级                    含义                                              合并条件
  ----------------------- ------------------------------------------------- --------------------------
  A0：静态架构            目录、导入方向、依赖、生成物、单一 owner          所有门禁通过

  A1：单元测试            Schema、Gate、resource policy、reducer、queue     全部通过

  A2：集成测试            Router/Registry、SSE/REST、XState/Effect、Scope   全部通过

  A3：真实浏览器          URL、导航、表单、对话框、Twin、播放和错误边界     所有场景有证据

  A4：性能与 GPU          构建产物、WebGPU、Worker、渲染帧时间、内存        与基线对比并达到冻结标准
  ----------------------------------------------------------------------------------------------------

不能以 A0/A1 通过推断 A3/A4 通过。

## 2. 架构门禁

### 2.1 单层目录（新增）

-   扫描范围仅为 `web_app/src`。
-   允许 `src/main.tsx`，其余源码必须是 `src/<module>/<file>`。
-   任意 `src/<module>/<submodule>/` 均失败。
-   一级目录必须属于正式目录清单。
-   负向 fixture 必须证明 `src/api/queries/example.ts` 被拒绝。
-   测试夹具 `web_app/tests/architecture/fixtures/**`
    不受生产源码目录深度规则约束。

### 2.2 依赖与导入方向

-   `domain/` 不导入 React、Effect、Router、XState、网络包、Atom、Worker
    全局或 Babylon。
-   `rendering/` 不导入 React Query、Zustand、Atom、XState 或 Effect
    热路径 API。
-   `catalog/`、`twin/`、`workbench/` 互相之间没有未批准的内部导入。
-   `routes/` 不直接调用 `fetch`；只调用 AppRuntime 资源 facade。
-   `XState` 只允许从 `runtime/` 的 machine/adapter 模块导入。
-   `Effect.run*` 只允许出现在组合根和明确登记的 React/Router 适配边界。
-   所有相对导入和 `@/` alias 都能解析，导入图无循环。
-   生成文件登记完整，生成检查可复现。

### 2.3 旧依赖与兼容层

最终生产源码扫描必须满足：

-   无 `zustand` import。
-   无 `@tanstack/react-query` import。
-   无 `zod` import。
-   无 `rxjs` import。
-   无旧
    `QueryClient`、`queryKeys`、`QueryProvider`、`createSliceStore`。
-   无为旧 API 创建的兼容转发模块。
-   `package.json` 和 lockfile 不包含因旧实现而保留的直接依赖。
-   `@tanstack/router-plugin` 已移除；Router 仍有精确版本 pin
    和单一解析。

### 2.4 资源缓存所有权

-   远程快照只存放于指定 Resource Atom。
-   不存在第二个 Map、Effect Cache 或 Store 保存相同快照。
-   Gate 可以保存 epoch/sequence 等顺序元数据，但不得复制完整 Snapshot。
-   React 组件、Router loader 和 mutation 通过同一 AppRuntime/Registry
    操作资源。
-   架构门禁应扫描 `new Map`、自建 registry/cache
    和资源快照赋值点；命中后需由语义规则判定，不能只靠字符串匹配误报或漏报。

## 3. Resource Atom 测试矩阵

  ---------------------------------------------------------------------------------------------------------------
  ID                      场景                               通过标准
  ----------------------- ---------------------------------- ----------------------------------------------------
  RES-01                  两个消费者同时请求同一未缓存资源   只执行一次实际网络请求

  RES-02                  Router intent 预加载后立即导航     loader 和 React 复用同一 Registry
                                                             中的同一结果；请求总数为 1

  RES-03                  资源处于 freshness 窗口内          ensure 不触发额外请求

  RES-04                  freshness 已过期                   ensure 触发刷新；同一资源的并发刷新合并为一个

  RES-05                  资源 idle TTL 内卸载后重新挂载     节点可复用，但 freshness 仍被显式检查；过期时刷新

  RES-06                  资源 idle TTL 到期后重新挂载       允许重建节点；首次加载行为正确，不遗留旧订阅

  RES-07                  刷新期间旧值仍存在                 UI 可读旧值并能识别 waiting 状态

  RES-08                  刷新失败但之前成功过               `AsyncResult.Failure` 保留 previous success；UI
                                                             同时展示旧值和错误

  RES-09                  首次加载失败                       没有伪造成功值；错误可被界面识别并按契约重试

  RES-10                  Effect interruption                底层 fetch 被 abort；取消后不再写入已关闭的 Scope

  RES-11                  Schema 解码错误                    不触发网络重试，不写入资源成功状态

  RES-12                  同一设备 ID 出现在不同 FAB         资源身份隔离，互不覆盖

  RES-13                  mutation 成功                      只刷新与该 mutation 相关的资源 Atom

  RES-14                  Runs 列表/详情轮询                 1.5 秒策略正确；资源不活跃或 Scope 释放后停止

  RES-15                  Run Results                        Run 未完成时不请求；完成后按契约启动读取

  RES-16                  Sites 重试                         只对规定的瞬态网络/服务器错误重试一次；4xx、Schema
                                                             和身份错误不重试
  ---------------------------------------------------------------------------------------------------------------

## 4. Router 测试矩阵

  -------------------------------------------------------------------------------
  ID                      场景                    通过标准
  ----------------------- ----------------------- -------------------------------
  ROUTE-01                访问 `/`                Workbench 正常加载；Sites
                                                  失败显示可重试错误

  ROUTE-02                访问 `/equipment`       目录页与 URL search 同步

  ROUTE-03                访问                    比较视图和筛选状态正确
                          `/equipment/compare`    

  ROUTE-04                访问 `/fabs/FAB-01/3d`  Sites 成功且 FAB 存在时显示
                                                  Twin

  ROUTE-05                访问未知 FAB            进入 root error
                                                  component；不得静默渲染空场景

  ROUTE-06                访问未知 URL            显示 404 `notFoundComponent`

  ROUTE-07                前进/后退               路由和 URL search 恢复一致

  ROUTE-08                非法 search 参数        按既定 schema/default policy
                                                  处理，不产生类型断言逃逸

  ROUTE-09                Twin 路由代码分割       构建输出包含独立 chunk；初始
                                                  Workbench 不静态加载完整 Twin
                                                  页面图

  ROUTE-10                路由预加载              `defaultPreloadStaleTime: 0`
                                                  保留；数据 freshness 由
                                                  Resource Atom 决定

  ROUTE-11                单层目录                不需要 `routeTree.gen.ts`；code
                                                  route tree 类型注册有效
  -------------------------------------------------------------------------------

## 5. XState / Effect 命令测试矩阵

  ----------------------------------------------------------------------------------------------------------------
  ID                      场景                    通过标准
  ----------------------- ----------------------- ----------------------------------------------------------------
  CMD-01                  actor 创建              actor 只由对应 FAB/命令 Scope 拥有

  CMD-02                  首个 snapshot           projection 在 actor start 后不丢初始帧

  CMD-03                  StrictMode 重挂         无重复 actor、订阅、计时器或 SSE

  CMD-04                  actor dispose           Scope 关闭后 actor 停止，projection 失效，订阅被移除

  CMD-05                  重复/乱序 revision      revision 不倒退，重复事件幂等

  CMD-06                  终态之后收到新事件      终态不可回退

  CMD-07                  同一命令并发 reconcile  同一命令最多一个 in-flight 请求

  CMD-08                  多命令 reconcile        每 FAB 同时最多 4 个权威查询

  CMD-09                  queue per-command       每命令 pending 不超过 32；产生诊断
                          overflow                

  CMD-10                  queue global overflow   每 FAB 不超过 256；优先驱逐非终态；有可观察诊断

  CMD-11                  驱逐后恢复              容量驱逐触发合并权威核对；不能静默丢失终态

  CMD-12                  FAB A 切换到 FAB B      A 的迟到事件和结果不能写入 B

  CMD-13                  Run 提交重试            同一逻辑提交复用 Idempotency-Key

  CMD-14                  新 Run 提交             新逻辑提交生成新 Idempotency-Key

  CMD-15                  设备命令身份            以 `(fabId, commandId)` 与 API 定义的设备命令幂等身份关联

  CMD-16                  传输错误/重连/gap       连接状态可观察；恢复后执行有界核对，不把传输错误伪装为命令失败
  ----------------------------------------------------------------------------------------------------------------

## 6. Equipment Status / Telemetry 测试矩阵

  --------------------------------------------------------------------------------------------------
  ID                      场景                    通过标准
  ----------------------- ----------------------- --------------------------------------------------
  LIVE-01                 REST 帧                 必须通过共享 EquipmentStatusGate

  LIVE-02                 SSE 帧                  必须通过同一个 Gate

  LIVE-03                 旧 REST 晚于新 SSE      旧 REST 不覆盖当前快照

  LIVE-04                 同 epoch 旧 sequence    被拒绝

  LIVE-05                 更高 epoch              进入新代并按规则更新

  LIVE-06                 缺少 epoch/sequence     不得使已接受的显式 epoch 高水位倒退
                          的旧帧                  

  LIVE-07                 不完整工具帧            被拒绝，不更新 Snapshot Atom

  LIVE-08                 FAB 切换                先取消旧批次，再激活新 Gate、清理旧投影

  LIVE-09                 100 ms 合批             高频状态不导致整页每帧渲染

  LIVE-10                 Worker fault            释放 in-flight slot，保留有界 pending，按退避恢复

  LIVE-11                 Worker generation 变化  旧 Worker 的迟到响应不能写入新 generation

  LIVE-12                 WebGPU 设备/世界恢复    引擎资源重建；用户输入和恢复重放遵守现有身份规则

  LIVE-13                 WebGL 检查              不存在 `webgl` / `webgl2` context 使用或回退路径
  --------------------------------------------------------------------------------------------------

## 7. 真实浏览器功能验收

当前仓库有 CDP 渲染性能工具，但它不等同于完整页面功能回归。应基于现有
CDP 驱动新增一个可执行功能场景脚本，不能只在报告中写"手工检查通过"。

### 7.1 目标命令

实施后在 `scripts/README.md` 中登记唯一命令，例如：

``` powershell
pnpm e2e
```

该命令应启动或连接已明确指定的开发环境，执行场景，并将结果写入固定目录，例如
`docs/perf/effect4-e2e.json`。命令、服务启动方式和产物路径必须随脚本一并实现；未实现前不得把该命令标为可用。

### 7.2 场景

1.  `/`：Sites 成功、Sites 失败、点击重试。
2.  `/equipment` 与 `/equipment/compare`：筛选、搜索、切换视图。
3.  URL search：语言/主题参数，刷新页面、前进、后退。
4.  Workbench：Run 表单校验、提交、重复提交保护、错误状态。
5.  Catalog 导入/导出：选择文件、解析失败、成功导入、下载完成。
6.  Twin DEMO：页面加载、播放/暂停、Wafer 与 Research 播放。
7.  Twin 实时：REST 初始快照、SSE 更新、重连或模拟断线、FAB Scope 隔离。
8.  未知 FAB：显示 route error，不渲染错误 FAB 的旧数据。
9.  未知 URL：显示 404。
10. 页面退出/重新进入：无重复 SSE、Worker、timer 或 actor。

### 7.3 每个场景的证据

每项至少输出：

-   场景 ID；
-   起始 URL；
-   操作步骤；
-   期望结果与实际结果；
-   pass/fail；
-   浏览器 console 错误；
-   网络请求计数或关键请求摘要；
-   对关键失败场景保存截图；
-   统一 JSON 结果路径。

若某项依赖无法在自动化浏览器中触发，必须明确记录人工步骤、通过标准、证据和复核人，不能把未执行项标成通过。

## 8. 性能与 WebGPU 验收

### 8.1 必须使用的现有工具

沿用仓库中实际存在的
`render_perf.mjs`、`test_render_perf.browser.mjs`、`telemetry_stress.mjs`
和现有 60 Hz profile。记录原始数据与 commit
SHA。不得仅以主观"感觉流畅"作为结论。

### 8.2 需要记录的指标

-   首屏与 Twin 首帧时间；
-   render frame p95/p99；
-   heap 与长时间运行后的内存趋势；
-   draw calls；
-   Worker 数量、目标数和任务耗时；
-   构建产物大小（压缩前后）；
-   EventSource / 网络连接数；
-   Atom 更新引起的 React render 次数；
-   资源刷新、Scope dispose 后残留任务数。

现有 render
性能工具并不一定包含所有指标。缺少的指标必须实现测量工具后才能验收，不能假设已经被现有
JSON 覆盖。

### 8.3 对比方法

-   使用同一台机器、相同浏览器版本、相同 API 数据、相同场景与相同参数。
-   交替运行基线和新版本，至少 3 轮；保留每轮原始结果。
-   对中位数、p95/p99 和波动范围作比较。
-   数值阈值必须在读取实际基线后冻结，不在没有测量数据时编造。
-   若出现明显回归，定位是 Atom 通知、React 重渲染、网络请求、Worker
    调度还是 GPU 渲染，不以简单提高阈值通过。

## 9. `verify.ps1` 与工具链验收

最终验收前必须解决：

1.  `tools/check_architecture.py` 对 `docs/superpowers`
    的禁用规则与实际文档落点冲突。
2.  `global.json` 精确 SDK pin 与验收机器安装版本不一致的问题。
3.  `pnpm@12.15.0` 的确定性预置及 frozen-lockfile 安装的网络前置条件。
4.  路由插件移除后所有依赖生成 route tree 的门禁、allowlist 和脚本。
5.  新增浏览器功能验收的命令与产物路径。
6.  资源缓存、Effect runner、XState 边界和 FAB Scope
    约束必须有可执行门禁，而不只是文档声明。

完整 `verify.ps1` 成功后保存退出码、完整日志、Node/pnpm/.NET SDK
版本、commit SHA 和 lockfile hash。只在局部通过的 Task
不得被描述为全量验收通过。

## 10. 最终签收清单

-   [ ] `web_app/src` 不存在任何二级目录。
-   [ ] 所有文件都有明确模块 owner；没有模糊的 `common`/`misc`。
-   [ ] code-based router 保留全部 URL、search、404、error boundary
    与动态分块语义。
-   [ ] 一个应用一个 Registry；Router 和 React 共用该实例。
-   [ ] 不存在第二份资源缓存或旧/新容器双写。
-   [ ] 所有 Resource Atom 具备 freshness、idle
    TTL、single-flight、错误保留和取消测试。
-   [ ] 所有 FAB
    Scope、Worker、EventSource、actor、Fiber、计时器和订阅都有 dispose
    测试。
-   [ ] XState
    首帧、revision、终态、命令身份、队列驱逐与有界核对测试通过。
-   [ ] REST/SSE 共用顺序 Gate；高频遥测仍绕过 AtomRegistry。
-   [ ] 生产源码无 Zustand、TanStack Query、Zod、RxJS 导入。
-   [ ] manifest/lockfile 无旧直接依赖和 router plugin。
-   [ ] `verify.ps1` 在确定的工具链环境完整通过。
-   [ ] 浏览器功能场景全部执行并保存 JSON/截图证据。
-   [ ] WebGPU 性能报告基于真实基线和多轮对比。
-   [ ] 文档已同步；未解决的问题、风险和回滚提交已记录。
