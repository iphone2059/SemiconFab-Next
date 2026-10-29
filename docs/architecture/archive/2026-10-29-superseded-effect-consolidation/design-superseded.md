# SemiconFab Next：Effect 4 全面替换方案（修订版）

- 日期：2026-10-29（Asia/Singapore）
- 状态：用户于 2026-10-29 指示替换方案并开始代码迁移；实施中，未完成最终验收
- 依据：用户本次提供的 Effect 4 修订方案；以本修订版作为后续迁移约束
- 修订检查：独立构建者检查完成；已修正计划中残留的 XState 移除指令，无重要未决设计问题
- 核对基线：`4fc8a94a3f10d185c8bef7929349ac6ccb2b8792`
- 范围：`web_app` 及其构建、测试、架构门禁和相关文档；后端协议保持现有语义
- 产品范围沿用当前已确认的单站点、单活动 FAB-01；保留复合身份隔离能力与错误身份负向测试，不扩展为多 FAB 部署验收。

## 1. 用户已经确定的目标

1. 优先使用 Effect 生态替代职责重叠的独立依赖，增强代码类型安全。
2. 接受大规模重构；降低代码量、降低复杂度或减小包体不作为采用前提。
3. 移除目标依赖时，包括锁文件中的直接、间接、开发、可选和 peer 解析结果；业务代码不再引用不代表清理完成。
4. 接受 Effect 4 Atom 和 React Hooks 的 `unstable` 标记，不以此要求保留 Query 或 Zustand。
5. 保留 XState 6 Alpha 作为设备命令状态机；Effect 管理执行、并发、事件流与资源生命周期。保留 TanStack Router、React 19 和 Babylon Lite。

以下具体替代方案、版本及测试策略是本设计的工程建议，供整体验收；不把这些实现选择表述为用户逐项指定。

## 2. 方案与取舍

### 推荐：Effect 官方响应式生态 + TanStack Router 代码路由

使用 `effect@4.0.7` 和 `@effect/atom-react@4.0.7` 统一校验、执行、事件流、异步状态和共享 UI 状态。保留 `xstate@6.0.0-alpha.70` 和现有命令状态机，由 Effect 管理命令执行、恢复、并发和资源生命周期。保留 TanStack Router 运行库，改用官方 `createRoute` / `addChildren` 代码路由。

这条方案满足 Effect 优先和目标包清零，同时保留已有 URL、导航、类型化参数与懒加载能力。接受官方响应式模块在补丁版本内可能变化的维护成本，精确锁定版本。

### 比较过的方案

- Effect 核心 + 自建 `useSyncExternalStore` 状态/查询适配：也能移除旧依赖，但重复实现官方 Atom 已提供的能力，不符合“能使用 Effect 代替就使用 Effect”的偏好，因此不推荐。
- 连 Router 运行库一起替换：目前锁文件显示 Zod 来自 Router 生成插件及生成器，运行库的实际依赖不含目标包。移除运行库不会进一步解决已知依赖阻塞，却扩大导航重写范围，因此不推荐。
- 继续保留文件路由生成插件：插件和生成器实际依赖 Zod，与锁文件清零要求冲突，排除。

### 技术栈和阶段

核心技术栈为 `effect`、`@effect/atom-react`、`react`、`react-dom`、`@tanstack/react-router`、`xstate` 和 `@babylonjs/lite`。`scheduler` 是 React 绑定所需的显式 peer 依赖，不把“7 项核心库”误解为 manifest 只能有 7 个条目。

阶段按模块所有权切换：①应用 Runtime/共享 Registry；②完全移除 Zustand；③完全移除 Query 并迁移 Router 预加载；④设备状态/Mutation 一致性；⑤Schema/Stream/PubSub 与生命周期；⑥旧依赖清理、架构门禁和功能/性能验收。已有通过检查的 Schema/HTTP 与 UI Atom 提交予以沿用，不为更换方案重复实现。

## 3. 依赖目标和清零的含义

### 新增/明确锁定

| 依赖 | 精确版本 | 用途 |
| --- | --- | --- |
| `effect` | `4.0.7` | Schema、Effect、Layer、Scope、Stream、Queue、PubSub、Ref、响应式原语 |
| `@effect/atom-react` | `4.0.7` | 官方 React Atom 绑定 |
| `scheduler` | `0.28.0` | 显式满足 Atom React peer；当前已由 react-dom 引入，不增加第二个版本 |

保留现有 React、React DOM、TanStack Router 运行库、Babylon Lite 和通用构建/测试工具的版本。Node 继续 `>=26.0.0 <27`，TypeScript 继续 `7.0.2`，pnpm 继续 `12.15.0`。本次不引入 Effect HTTP/RPC 服务端，不改写 .NET 后端。

### 必须在最终依赖图中不存在

- `rxjs`、`zod`、`@zod/*`、`zustand`。XState 不属于清理目标。
- `@tanstack/react-query`、`@tanstack/query-core` 以及 Query 的适配器/开发工具包。
- `@tanstack/router-plugin`、`@tanstack/router-generator`。

上述目标检查全部 manifest、pnpm importer、package resolution 和 snapshot，以及干净安装后的实际依赖图；包括别名指向的包和 optional/peer 解析。包名匹配以依赖节点为准，不把文档中的历史说明误报为依赖。

清理由包管理器重新求解和裁剪锁文件完成，不手删仍被引用的解析记录，不用别名、空包、override 或本地复刻库隐藏旧包。检查 `pnpm-workspace.yaml` 中旧 Query 发布年龄例外并清理。继续使用一个 `pnpm-lock.yaml`，不产生 npm/yarn 锁文件。

不要求删除 pnpm 全局内容寻址仓库中的历史下载；验收对象是仓库、锁文件、一次全新安装和产品产物。

## 4. 目标职责与代码边界

| 职责 | 唯一所有者 |
| --- | --- |
| 外部输入、HTTP DTO、URL 参数校验 | application/API 边界的 Effect Schema |
| 应用用例、类型化失败、并发、恢复 | Effect 服务与用例 |
| 服务端快照、异步读取、变更失效 | 共享 AtomRegistry 中的资源 atoms |
| 跨组件 UI 状态和偏好 | feature atoms；局部状态仍归 React |
| URL、路径参数、导航历史 | TanStack Router |
| 命令业务状态 | FAB 内的 XState 状态机；Atom 只暴露投影 |
| SSE/Worker/后台任务所有权 | Effect 作用域与受监督任务 |
| 高频遥测计算与渲染消费 | Worker、TypedArray 和现有渲染循环 |

领域计算、生成代码、帧缓冲和渲染热路径保持纯 TypeScript，不依赖 Effect Runtime。Schema 定义放在协议/应用边界，禁止为追求类型品牌而把 Effect 导入纯领域层。API 的运行时类型优先从 Schema 推导，生成契约通过静态兼容性和现有契约测试验证；不维护未经检查的平行 DTO。

不用兼容旧 Query/Zustand/RxJS API 的大包装层维持旧架构。每个迁移单元切换消费者后删除其旧实现，最终无双缓存、双连接或并行状态权威。

## 5. 组合根、资源作用域与 React

应用组合根拥有一个应用级资源作用域、一份应用服务装配和一个共享 AtomRegistry。Router loaders、React Provider、SSE 快照写入使用相同 registry 和资源身份。不得由 ManagedRuntime 与 Atom runtime 分别构建两份相同服务。

- 应用层拥有 HTTP、时钟、ID 生成、资源缓存及 FAB registry 服务。
- 每个 FAB 拥有独立命令状态、关联记录、事件消费、恢复任务和遥测资源作用域。
- 命令 SSE 保留按 FAB 延迟订阅：未跟踪命令前不打开连接；消费者共享一个实际连接。
- 遥测保留按 FAB 引用计数：第一个页面消费者启动，最后一个消费者释放后停止；旧消费者 cleanup 不能关闭替代实例。
- 页面拥有可取消的读取和 UI 订阅，不拥有服务端已接受命令的业务生命周期。
- 重建先使旧代际失效，再取消旧任务并完成 finalizers；新代际发布不得使旧回包重新生效。异步关闭屏障由组合根序列化，不把 async cleanup 直接返回 React effect。
- StrictMode setup/cleanup/setup、应用退出和多次 dispose 均有明确、可重复的行为；关闭后不得出现游离 Fiber 或新的回调写入。

具体组合根 API 和文件拆分由实施计划确定；“服务只构建一次、registry 全链路共享、关闭可等待”须通过行为测试证明。

## 6. Schema、HTTP 和错误通道

把 `api/schemas/*.schema.ts` 以及 Router search 中的 Zod 校验迁移为 Effect Schema；检查额外的 test/tool 直接使用。保留 GUID 规范化、命令响应身份检查、时间戳格式、非 JSON/ProblemDetails 错误语义以及现有未知字段处理策略。

所有请求保留同源路径、`credentials: same-origin`、`cache: no-store`，浏览器不得持有或设置开发身份密钥。Effect 异步适配将中断信号传到底层 `fetch`，不能只停止等待 Promise。

可预期错误使用带标签联合，例如 `NetworkUnavailable`、`HttpFailure`、`InvalidServerResponse`、`CommandIdentityMismatch`、`IdempotencyConflict`；Schema 失败显式进入预期错误通道。中断保留 Effect interruption 语义，程序缺陷保留 defect，不把三者统一转为字符串或重试。

命令 404 的无记录结果显式建模为 Option/带标签结果，不与网络失败混淆。页面仅在最终展示处格式化错误文本。

## 7. Query 替代：资源 atoms 与统一快照

使用官方 `effect/reactivity` 和 `@effect/atom-react`；按需使用 AtomHttpApi 或直接基于服务 Effect 的 atoms，不要求为现有 .NET API 再造一套服务端协议。

资源身份包含端点需要的 siteId、fabId、runId 和参数。相同逻辑 key 从 loader、页面和 SSE 都得到同一 atom；不得因临时对象键创建不同缓存实例。

仅在 AtomRegistry 中保存资源值和 AsyncResult，刷新时间/顺序水位是控制元数据，不另外建立第二份 `Effect.Cache` 原始快照。明确区分 freshness 与 idle TTL：Atom 的 idle TTL 不等于 Query staleTime。

### 资源策略

| 资源 | freshness | 无消费者后的保留时间 | 读取重试 |
| --- | --- | --- | --- |
| sites | 30 秒 | 5 分钟 | 网络/可重试 HTTP 故障再试 1 次；不重试校验/身份错误 |
| catalog | 60 秒 | 5 分钟 | 0 |
| runs 列表、详情、结果 | 0 | 5 分钟 | 0 |
| 设备状态快照 | 0 | 5 分钟 | 0 |
| research 静态事件、wafer routes | 无限 | 10 分钟 | 0 |

Runs 列表与所选 Run 详情在有消费者时每 1.5 秒刷新；Results 仅在 Run 完成后激活。设备状态有消费者时每 4 秒 REST 轮询，并共享 SSE 顺序门。最后消费者离开后停止轮询。

默认不因窗口聚焦刷新；网络重新连接时刷新已挂载的过期资源。freshness 为 0 表示在消费者挂载、导航或显式失效时重新检查，不能形成持续刷新循环。显式失效不受 freshness 阻止。

loader 预加载和页面读取共享在途请求；取消一个等待者不得取消仍被其他消费者使用的读取。预加载留下的结果按 idle TTL 保留，页面挂载能复用新鲜结果。过期结果允许先显示，同时只触发一次后台刷新；失败仍保留旧值和明确错误状态。

Mutation 成功后精确失效受影响资源，保留 FAB 隔离；不以全局清空掩盖身份设计。REST fallback 和设备状态 SSE 仍通过同一个 epoch/sequence 接受门禁；只允许通过门禁的快照进入资源 atom，延迟 REST 不能覆盖更新的 SSE；Atom 失效/重新挂载不能重置高水位。FAB 切换必须先取消前一 FAB 的待处理合批、激活新 Gate、清空旧 UI 投影，再接受新帧。保留 100ms UI 合批。

## 8. UI atoms 与移除 Zustand

迁移 `state/{localeStore,runtimeStore,createSliceStore}` 及 feature 下 twinUi/twinPage/twinDemo/catalog/workbench stores 的实际职责。纯 reducer/投影函数可保留为普通 TypeScript；删除 Zustand store 工厂和 `useShallow` 消费，不保留同名兼容 API。

UI atom 不保存服务端快照副本、工作流权威状态或 GPU 对象。URL 仍是可分享参数的唯一所有者，不能再由 UI atom 回写形成环。

偏好保留现有语言/主题优先级和 storage keys；拒绝 localStorage、损坏内容、zh/en locale 规范化均不能阻止页面启动。DEMO 与实时遥测的数据源优先级保留；高频 hover/帧更新继续绕开 React 通知。

## 9. 保留 XState，使用 Effect 管理命令执行和恢复

`XStateCommandWorkflowAdapter`、`equipmentCommand.machine` 及纯转换/校验逻辑继续承担命令状态机。当前状态 idle、accepted、executing、succeeded、failed、cancelled 保持不变；XState 的导入仍局限于命令 workflow 边界。

状态机是命令业务状态的唯一所有者。Effect 服务负责 HTTP 提交、事件消费、权威核对、限流、超时与资源释放；Atom 仅暴露低频只读投影，不维护第二份命令状态。

只有相同 FAB/command 身份且 revision 严格递增的结果能推进命令，终态保持不可变。SSE 先于 POST 响应时保留有界 pending 事件；注册后按现有关联/顺序语义送达。同一命令的并行 reconcile 合并，每个 FAB 的权威核对并发上限为 4；失败可观察，网络重连或显式重试可再次触发，不凭客户端超时推断业务失败。

保留既有保留策略：pending 每命令 32/总计 256；终态工作流最多 64、TTL 300 秒；只读历史投影最多 128；终态扫尾最长间隔 15 秒。重复 revision 不增加 pending 计数。容量驱逐记录诊断，并对可能漏失状态触发权威核对。

提交绑定 commandId、Site/FAB、ScopeToken 和完整逻辑请求身份，保留幂等键。中断/断网后的 POST 可能已被服务端接受：保留原键供重试，不自动换键。重叠写入不能仅依赖 `useAtomSet` 的下一次异步结果关联请求，必须使用每次 Effect 命令本身的结果确认归属。切换页面/FAB 后，旧 UI continuation 不得污染新页面，已接受命令继续归所属 FAB 跟踪。

不新增刷新浏览器后的持久化命令恢复或后端业务取消端点。Effect Fiber 中断不能伪装为服务端 outcome=cancelled。

## 10. SSE、Worker 和移除 RxJS

命令流契约改为统一的带标签 Stream，包含 result、reconnected、replay-gap 和 transport-failure。一个 FAB 一个实际 EventSource，通过 scoped 共享服务向消费者分发；订阅、取消、共享启动和释放都有唯一所有者。

继续使用原生 EventSource 的网络重连及 Last-Event-ID 行为；Effect Schedule 负责权威核对和 Worker 恢复，不叠加一套并行 EventSource 重连循环。

命令数据缓冲容量 256。原生 EventSource 无上游暂停 API，不能声称 Stream 自动提供端到端背压。满载时不阻塞 DOM 回调、不为每条消息创建等待中的 Fiber；合并为可观察的 gap 并请求权威核对。控制信号通过独立的有界合并状态传递，不因数据缓冲溢出被静默丢弃。

遥测数据面继续维持一个 in-flight frame 和一个按槽位合并的 pending frame；不得用简单 latest-wins 丢失稀疏增量。保留连接级序号重置、Worker 代际、旧回包隔离、2 秒 in-flight 超时，以及 250ms 起、上限 8 秒的 Worker 重试退避。

Effect 管理 Worker 创建、监督、超时和释放；实体映射、TypedArray 写入、FrameRingBuffer、渲染逐帧读取不创建逐实体 Effect。

## 11. 路由和移除 Zod 传递来源

移除 Vite 的 `tanstackRouter(...)` 插件及其依赖树，用官方代码路由显式组成现有路由树。保留 `/`、`/equipment`、`/equipment/compare`、`/fabs/$fabId/3d`，以及错误/404、前进后退、search 和页面懒加载行为。

删除 `routeTree.gen.ts`，迁移 `createFileRoute` 到 `createRoute`；不得把当前含 `@ts-nocheck` / `as any` 的生成结果当作手写源码继续维护。通过父路由、`addChildren` 和 Router Register 推导参数、search、loader context，增加正反类型用例。

Router context 改为共享应用服务/AtomRegistry 访问，不再传 QueryClient。保留 `defaultPreloadStaleTime: 0`；`/` 允许 Workbench 展示并重试 sites 错误，`/fabs/$fabId/3d` 的 sites 加载失败和未知 FAB 交给 Route ErrorBoundary。鼠标预加载、点击导航和组件挂载共享同一资源请求。原 `route-tree-generation.test.ts` 的生成器再现测试改为代码路由类型/结构、URL 与懒加载行为测试；相关架构规则按新目标更新，不能只删除失败的行为断言。

Vite 普通开发命令、host/port/strictPort、API proxy、开发密钥注入、React 插件和构建 chunk 策略保持现状；只移除路由生成插件，不另造常规 dev server。

## 12. 交付顺序和架构文档

实施计划按依赖关系拆分为：Schema/HTTP 与组合根；资源/UI atoms；代码路由；保留 XState 的命令执行和事件流；Runtime/遥测资源；依赖裁剪与全体验收。每个单元有回归证据，迁移中不宣称完成；最终清零前不得交付为已完成迁移。

更新 architecture、state-management、router-query-integration、fab-runtime、command-event-bridge、command-reconciliation、设备状态顺序文档，以及 ADR-0009/0010 的生效关系；旧 ADR 可以作为明确标注的历史保留。

架构门禁检查：领域/生成/渲染热路径纯度；禁止目标包导入（包括 type-only、dynamic import、require）；禁止第二份资源缓存；Effect runners 限于适配/组合边界，XState 限于命令 workflow 边界；跨 FAB scope 隔离。禁止以放松类型检查、增加 `any`、`@ts-ignore` 或 `@ts-nocheck` 通过迁移。

## 13. 验收

### 依赖与类型

1. 新增依赖审计命令，覆盖 manifest、锁文件和实际安装图；负向用例包含传递包、dev/optional/peer、npm alias 和旧工具链重新引入。
2. 在独立干净目录用固定 pnpm 执行 frozen-lockfile 安装并审计，目标包节点数必须为 0，不能只检查原工作区 node_modules。
3. TypeScript strict 检查通过；错误/服务依赖、Schema 编解码、命令转换、Router 参数有类型级正反用例。后端生成契约及现有 Schema 接受/拒绝语义保持。

### 功能与生命周期

4. 保留并迁移现有缓存 RQ-01..05 行为：预加载复用、过期刷新、mutation 失效、FAB 隔离、重叠请求合并。
5. 覆盖 REST/SSE 竞争、旧 epoch、序号倒退、错误 FAB、稀疏帧合并、Worker construction/error/messageerror/timeout/postMessage 故障。
6. 覆盖命令先事件后响应、重复和乱序 revision、重连/gap、缓冲溢出、幂等重试、404/校验/身份失败、终态保留、并发上限、dispose/替代实例竞态。
7. 覆盖共享消费者卸载、最后释放、StrictMode 重挂、退出与重建；停止后无活动连接/Worker/定时任务/游离 Fiber 或旧回包写入。
8. 页面 URL、搜索、前进后退、语言/主题、目录对话框、Workbench 提交、Twin DEMO/实时及 wafer/research 播放通过真实浏览器回归。

### 全量与运行证据

9. 执行 `./scripts/verify.ps1`，保留生成物/frozen assets/架构/前端类型与 Vitest/build/.NET 等现有检查。
10. 实际 FAB 路由运行 `tools/render_perf.mjs`；必须有 renderer ready、推进的引擎帧、非零 drawCalls 和干净 GPU/浏览器诊断，不能以空 canvas 或单元测试代替。
11. 使用 `tools/telemetry_stress.mjs` 对 500/2000/5000 实体进行 Worker 压测；基线与迁移后在同机同浏览器串行、交替各测至少 3 轮。fresh baseline 使用上述核对提交，不把旧报告的测量值当作本次实测。
12. 记录包体、首帧、p95/p99、heap、任务与连接数。包体缩小不作为迁移前提；出现可复现性能退化必须解释并修复，不能放宽既有门禁掩盖。现有 dev/60hz profiles 分别记录，只有实际通过的 profile 才能标为通过。
13. 提交绑定最终 commit/源码摘要的依赖、类型、功能和运行证据；未运行或未通过的项目明确列为未验收。既有渲染 parity 未决项不因 Effect 迁移自动关闭。

## 14. 官方依据和本次核查的边界

- [Effect 4.0 与 LTS](https://effect.website/blog/releases/effect/40)
- [4.0.7 Schema](https://github.com/Effect-TS/effect/blob/effect%404.0.7/packages/effect/src/Schema.ts)：模块 stable，具体 API 仍须逐项检查。
- [4.0.7 Atom](https://github.com/Effect-TS/effect/blob/effect%404.0.7/packages/effect/src/reactivity/Atom.ts)、[AtomHttpApi](https://github.com/Effect-TS/effect/blob/effect%404.0.7/packages/effect/src/reactivity/AtomHttpApi.ts)、[React Hooks](https://github.com/Effect-TS/effect/blob/effect%404.0.7/packages/atom/react/src/Hooks.ts)：unstable 已获用户接受。
- [TanStack Router 代码路由类型安全](https://tanstack.com/router/latest/docs/guide/type-safety)：使用父路由、代码树与 Register 保持类型推导；另已核对本地固定版本的 createRoute 类型声明。
- 当前锁文件的 Zod 来源为 `@tanstack/router-plugin` 和 `@tanstack/router-generator`；Router 运行库 manifest 中列出的 Zod/Query 是其仓库开发依赖，不是下游安装依赖。

本文件为迁移约束；代码实施和各项验收的实际状态记录于计划与证据中，不能以本设计宣称依赖已清零或功能/运行验收通过。
