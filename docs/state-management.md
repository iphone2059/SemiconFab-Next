# 状态管理（State Management）

- 版本：V2.1 / 2026-10-27
- 状态：**SPECIFIED，未实现**（Decision accepted / implementation pending）
- 依据：[ADR-0009](adr/0009-tanstack-router-query-boundary.md)、[ADR-0010](adr/0010-command-event-bridge.md)；总览见 [架构基线](architecture.md)；路由/Query 细则见 [路由与查询集成](router-query-integration.md)
- 当前实现：Redux Toolkit + RTK Query（[ADR-0008](adr/0008-redux-toolkit-rtk-query.md)）。本文档是目标，不是现状；迁移完成前 ADR-0008 仍是代码事实
- 本文不含任何已完成验证的声明

## 1. 状态分类与唯一所有权

| 状态类别 | 例子 | 所有者 | 位置 | 生命周期/刷新 | 禁止放入 |
|---|---|---|---|---|---|
| 服务端数据 | 设备列表/详情、目录、Run、命令权威状态 | TanStack Query | `api/queries` | Query `staleTime`/`gcTime`/失效/后台刷新 | Zustand、Redux、组件 state 副本、Router |
| URL/导航状态 | 路径参数、筛选条件、选中 id、视图模式（可分享部分） | TanStack Router | URL/search params | 导航即变化；可前进/后退 | Query 缓存、Zustand 副本 |
| 客户端 UI 状态 | 面板开合、临时 Tab、对话框、视图偏好 | Zustand 或组件局部 state | `state` 或组件内 | 会话内；偏好可持久化 | Query 结果副本、XState actor、引擎对象 |
| 命令/工作流状态 | 命令进行中/成功/失败/取消、核对状态 | XState v6（经 `CommandWorkflow` 契约） | `workflows/equipment` | actor 生命周期；FAB 运行时管理 | Query 缓存、Zustand、Redux |
| 高频遥测/渲染数据 | 设备状态流、AMHS 统计、变换矩阵、帧数据 | Worker + TypedArray 缓冲 | `realtime/workers`、`realtime/buffers` | 帧/批次；渲染循环消费 | Query、Zustand、XState、React state（逐帧） |
| 3D 引擎对象 | Babylon 场景、mesh、材质、GPU buffer | Babylon Lite 封装 | `rendering` | 引擎生命周期；设备丢失重建 | 所有状态容器（ARCH-12/ADR-0008 原则） |
| 派生/格式化值 | 排序后的列表、格式化文本 | 计算方（组件/selector） | 使用处 | 随源数据计算 | 长驻 store 副本 |

原则：**一个值只有一个所有者**。其他层需要时在渲染时读取/计算，不复制。复制会同时产生“哪份是最新的”问题，并让失效/恢复语义失效。

## 2. 服务端状态（TanStack Query）

### 2.1 规则

1. 只有 `api/queries` 定义 Query Options；loader 与组件共用（ARCH-04）。
2. Query 缓存是 HTTP 服务端数据的唯一缓存（ARCH-02）；Zustand/Redux/组件不得保存其副本（ARCH-05）。
3. 所有与 FAB 相关的 key 必须包含 `fabId`（跨 FAB 隔离，RQ-04）。
4. 写入只通过：`queryFn` 拉取、`fetchQuery`/`ensureQueryData`、mutation 失效/更新。组件不得直接 `setQueryData` 伪造服务端结果；确需乐观更新时必须显式评审并定义回滚（命令链路默认不做乐观更新，见 [命令事件桥](command-event-bridge.md)）。
5. 命令的“权威状态”读取放在 `command.queries.ts`，供恢复/核对使用；进行中生命周期不得用 Query 建模（状态归属 XState）。

### 2.2 新鲜度与失效

| 行为 | 由谁决定 | 说明 |
|---|---|---|
| 何时重新取数 | Query（`staleTime`、focus/reconnect 配置、invalidation） | Router 只触发 loader；loader 不因为过期强制网络请求 |
| 何时显示旧数据 | Query（缓存 + 订阅刷新） | 页面可先显示缓存再后台更新；关键视图可用 `fetchQuery` 强制权威数据 |
| 何时失效 | mutation/工作流终态 | `invalidateQueries` 精确到 key 前缀/FAB；禁止全局 `clear()` 掩盖设计问题 |
| 缓存保留 | Query（`gcTime`） | 与 Router 的路由缓存保留无关 |
| 预加载复用 | Router 触发 loader + Query 缓存 | `defaultPreloadStaleTime: 0` 保证 loader 重跑，Query 决定是否请求 |

### 2.3 与命令链路的边界

- 命令提交的 HTTP 部分（`CommandGateway`）属于命令链路，不属于普通 Query mutation；它不应把“进行中命令”写进 Query 缓存。
- 命令终态/权威状态可以通过 `command.queries.ts` 读取，用于页面展示与恢复核对；缓存的新鲜度按恢复语义配置（例如短 `staleTime`），但不得成为命令状态机的替代品。

## 3. URL 状态（TanStack Router）

属于 URL 的状态必须满足：可分享、可刷新恢复、变化应产生导航历史（或显式 `replace`）。

| 适合 URL | 不适合 URL |
|---|---|
| `fabId`/`equipmentId` 等路径参数 | 高频遥测值、帧进度 |
| 目录筛选（domain/category/q） | 命令进行中状态/revision |
| 选中项、对比项 | 大对象、二进制/引擎句柄 |
| 视图模式、时间窗等可分享参数 | 敏感/未授权数据 |

规则：

- search params 用 schema 校验（`schemas`），非法值重定向/回退策略在 M1 定义。
- 同一筛选不得同时在 URL 与 Zustand 各存一份；以 URL 为准。
- 导航/预加载只加载数据，不在 URL 中塞服务端响应。

## 4. 客户端 UI 状态（Zustand）

### 4.1 职责

Zustand 只保存**不影响服务端事实**的客户端状态，例如：HUD/面板偏好、语言/主题、Tour/引导步骤（如仍需全局）、选择/悬停等低风险交互态（高频悬停应走渲染路径或 ref，避免 store 高频写）。

### 4.2 约束

- 不得保存 Query 结果副本（ARCH-05）；需要服务端值时从 Query 读取。
- 不得保存 XState actor/引擎对象/GPU 资源。
- 不得作为高频遥测的通道（ARCH-11）。
- store 按领域拆分（`state/` 下），避免一个全局大 store；持久化只用于明确批准的用户偏好，不持久化服务端数据。
- 组件局部状态优先：只在确实需要跨组件共享时进 Zustand。

### 4.3 从 Redux 迁移的原则（M2）

| 当前 Redux slice（`src/store`） | 当前内容 | 目标归属（初步，M2 逐页确认） |
|---|---|---|
| `twinUi` | 视图模式、cut/xray、Tour、时钟等 | 可分享的进 Router search；其余进 Zustand；渲染相关进渲染状态 |
| `twinDemo` | 确定性演示数据/信号 | 纯演示模块（非生产状态）；必要时 Worker/静态数据 |
| `twinPage` | site 身份、设备状态、选择、面板、MES/YMS 等 | 服务端部分 -> Query；选择/面板 -> URL/Zustand；高频状态 -> 实时缓冲/渲染 |
| `workbench` | 选择、表单、提交幂等键 | 选择/表单 -> URL/组件；提交状态 -> 命令链路（`CommandGateway`） |
| `catalog` | 筛选、对比选择、详情状态 | 筛选/对比 -> Router search；目录数据 -> Query |
| `locale` | 语言/主题 | Zustand + 偏好持久化 |
| `runtime` | viewer epoch/status、hover、fatal | 渲染生命周期/ref/渲染状态；不进入全局状态容器 |

该表是迁移初稿，不是最终文件映射；每一条在 M2 的实际迁移中必须复核，且不得为了“先跑起来”复制 Query 数据到 Zustand。

## 5. 工作流状态（XState v6）

- 命令生命周期（提交、accepted/executing、终态、取消、失败重试/核对）由 XState actor 拥有；实现文件见 [命令事件桥](command-event-bridge.md) 第 4 节。
- 公共契约只有 `CommandWorkflow`（`receive`/`reconcile`/`dispose`）；页面不得直接 import actor/machine。
- **工作流状态如何只读暴露给 UI**：本基线不虚构额外公共接口。M4 需要决定一种方式（例如 workflows/equipment 提供的专用 hook，经 RuntimeProvider 暴露只读快照），并明确它不是第二份权威状态；在此之前页面用“提交态组件局部状态 + Query 权威状态”展示命令结果。该问题登记为 OPEN-V21-13（[架构基线](architecture.md) 第 14 节）。
- 工作流状态不写入 Zustand/Redux/Query 缓存；如果 UI 需要缓存展示，只能缓存“展示投影”，且不得反写工作流。

## 6. 高频遥测与渲染状态

- 数据路径：`WebSocket -> Worker -> TypedArray -> Babylon Lite -> WebGPU`（[渲染管线](rendering.md)）。
- 高频数据不进入 Query/Zustand/XState（ARCH-11）；不得以逐帧 `setState`/逐事件 dispatch 驱动 React。
- UI 需要的低频聚合（例如 KPI 摘要）必须由明确的数据契约单独提供；其频率上限与字段在 M5 定义，不得把原始帧塞进状态容器。
- 选择/悬停等交互若频率高，走渲染层或 ref，并以节流/合并方式进入 React；具体阈值在 M5 性能测试中确定，本基线不写死数值。

## 7. 写入路径

```text
HTTP 写入:  用户操作 -> mutation -> HTTP API -> 成功 -> invalidateQueries(受影响的 key)
查询读取:  导航 -> loader ensureQueryData -> Query 缓存/网络 -> 页面 useQuery 订阅
命令写入:  用户操作 -> CommandGateway(HTTP 提交) -> 命令事件流 -> CommandEventBridge -> XState -> 权威状态查询/展示
高频更新:  WebSocket -> Worker/缓冲 -> Babylon Lite（旁路所有状态容器）
```

规则：

- 写入成功后由 Query 失效/权威读取更新 UI；不得在 mutation 回调里手写 setState 复制服务端结果。
- 命令结果更新由工作流/权威查询驱动，不得用 Query 缓存“猜测”终态。
- 失败路径必须有错误状态；不得静默吞掉。

## 8. 反模式与评审清单

禁止：

- 服务端 DTO 同时出现在 Query 缓存与 Zustand/Redux/组件 state。
- Query key 缺少 `fabId`/运行域维度。
- 把 `defaultPreloadStaleTime` 设为非 0 或依赖 Router 预加载缓存当数据缓存。
- 用 Query 建模命令生命周期，或用 XState 保存服务端列表。
- 把 Babylon 对象/GPU 资源放进任何状态容器。
- 用全局 `clear()` 或页面刷新掩盖失效设计问题。
- 高频事件逐条 dispatch 到 React/状态容器。

评审清单：

1. 这个状态值有没有唯一所有者？其他副本是否只是派生计算？
2. 它来自服务端、URL、用户交互、工作流还是帧数据？对应所有者是否正确？
3. 失效范围是否精确到 FAB/实体？
4. 是否引入了第二个缓存或第二份真相？
5. 高频路径是否绕开了所有状态容器？
6. 迁移期间是否出现同一端点的双缓存（G-02）？

## 9. 与 ADR-0008 的关系

| ADR-0008 内容 | V2.1 处置 |
|---|---|
| Redux Toolkit 拥有全部可序列化应用状态 | 迁移后由 Query（服务端）、Router（URL）、Zustand（UI）、XState（工作流）分担；Redux 在 M6 退役 |
| RTK Query 拥有服务端缓存 | 迁移后由 TanStack Query 取代（ADR-0009）；迁移期按端点切换，不双缓存 |
| “Babylon 对象不进入 Redux、遥测合批、帧状态与渲染循环分离” | 原则保留；ARCH-11 进一步要求高频遥测不经过 Query/Zustand/XState，落地形态为 Worker/TypedArray 旁路。当前 `telemetry-buffer.ts` 的 100ms 合批是过渡实现，不等于满足目标 |
| 页面选择/表单/幂等键在 Redux | 选择/表单可进 URL/组件；命令提交与幂等键归命令链路/`CommandGateway` 管理 |

## 10. 验证与证据状态

- 状态所有权目前**没有自动化测试**；ARCH-02/05/11 的检查在 M6 前由评审承担，之后计划纳入架构检查（[架构基线](architecture.md) 第 11 节 R-09）。
- RQ-03（mutation 失效）与 RQ-04（FAB 隔离）是服务端状态规则的主要门禁，当前 SPECIFIED / NOT RUN。
- 本文档不声称 Zustand/Query/XState 已安装或已接入；仓库 `web_app/package.json` 当前没有这些依赖。
