# M11 — React Web 工作台、业务页面与 UI：开发项目架构与详细规范

> 模块编号：`M11`　|　主责任域：Frontend　|　状态：`DESIGN_BASELINE`　|　受 `01`—`14` 规范与 `engineering/00` 共同约束。

## 1. 业务职责与范围

提供 Site 导航、Fab 多维视图、设备/批次浏览、Scenario 编辑、仿真运行控制、报表与权限界面。

### 拥有的界面状态

`UiSession`、`SelectedFab`、`RunControlForm`、`DashboardQuery`、`LayoutPreference`。

### 边界与依赖

- 上游输入或参照：M01 Site; M09 Run; M10 Analytics; M16 Identity。
- 下游消费者：Site/FAB dashboards。
- 组合的界面能力：M12 Scene Facade；M11 是渲染能力的调用方，M12 不依赖 React 页面。
- 本模块只拥有界面选择、表单与查询缓存；业务写入必须提交到相应后端 owner，按钮点击和 UI 乐观状态不代表命令已执行。
- 数据范围：与 FAB 关联的对象必须携带 `SiteId/FabId`；Site 级对象不得借此取得 FAB 运行状态写权限。

## 2. 可落地的工程/包与目录

- `apps/web/src`：`routes/`、`pages/`、`auth/`、`layout/`、`bootstrap/`。
- `frontend/packages/app-ui`：设计 tokens、可访问表单与权限提示。
- `frontend/packages/api-client`：生成契约上的认证请求、取消、错误映射与受控重试。
- `frontend/packages/widgets`：可复用工作台/KPI 组件；不拥有业务真相。

页面通过 `@fab/contracts` 使用生成类型，通过 `@fab/state-sync` 读取高频视图，通过 M12 `ISceneFacade` 交互。Web bootstrap 装配渲染后端，React 组件不导入 Babylon。这里不建立 C# Domain/Application/Infrastructure、EF 仓储或 Outbox。

## 3. 接口清单与类型规范

公开 Ports / Services：`IAuthenticatedApiClient`、`IRunViewStore`、`IUiPermissionGate`、`ILocalizationProvider`。

### 命令 API

| Command | 前置条件与结果 |
|---|---|
| `SubmitScenario` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `StartRun` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `PauseRun` | 向 M09 提交控制意图；显示 Accepted/待生效，收到权威 PAUSED 状态后再更新控制状态 |
| `ChangeSelectedFab` | 本地选择动作；取消旧范围请求/订阅，清理旧视图，再加载新范围，禁止迟到响应覆盖新 FAB |
| `ExportMetrics` | 命令处理器校验权限、版本与前置条件，返回明确成功/冲突/失败结果 |
| `InspectEquipment` | 本地选择动作；只用稳定实体 ID 读取授权详情，不改变设备运行状态 |

### 查询 API

| Query | 返回/权限约束 |
|---|---|
| `GetSiteOverview` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetFabDashboard` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetEquipmentPanel` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetScenarioForm` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |
| `GetRunStatus` | 查询 DTO；FAB 过滤与访问控制，必要时标注投影延迟 |

后端业务命令按契约发送幂等键、版本与业务范围，由服务器校验身份和授权；本地选择/筛选不伪装为业务命令。写请求超时先查询命令结果或使用同一幂等键重试；409 业务冲突或 412 If-Match 不匹配显示当前版本与重新加载入口。GPU 对象不进入 React 状态或查询 DTO。

## 4. UI 意图与本地通知

| 通知 | 语义 |
|---|---|
| `RunControlRequested` | UI 请求意图，包含目标 Run 与 correlation；不等于 Run 已改变状态 |
| `ViewChanged` | 本地 Site/FAB/Run/选择范围变化，不写入权威 DES EventLog |
| `ExportRequested` | 发起 M10 导出请求；文件可用性由服务器任务/Artifact 状态确认 |

本地事件使用 TS 包接口，不要求进入服务端 Outbox 或公共 Protobuf。实际后端请求/通知使用版本化 `contracts/`，保持两类语义分离。

## 5. 数据与存储

本模块仅持有浏览器内的表单、选择和可丢弃查询缓存；业务持久化由后端 API owner 承担。

- 查询缓存键包括身份/授权上下文及适用的 `SiteId/RunId/FabId/EntityId`，不同 Run 的同一设备不共用可变缓存。
- 退出、身份变化、权限撤销或切换执行范围时，取消请求并退订旧流，清理相关缓存；迟到响应按 scope/generation 拒绝。
- 高频设备状态驻留 `state-sync` 缓存；React 仅订阅汇总/选择项，不能每个 DES 事件更新整棵组件树。
- 本地布局偏好若落盘，必须版本化且不得存储令牌、凭据或未经授权的业务数据；无数据库迁移职责。

## 6. 必须守护的领域不变量

React 不保存每台机台 Mesh；高频状态不逐事件触发全组件重渲染；用户无权限的 Site/FAB 不请求真实数据；请求失败/409 可见可恢复。

### 三 FAB / 共享模式行为

- `INDEPENDENT`：业务写入与事件执行限制在所属 FAB 执行域；查询和 UI 订阅按授权范围过滤，允许 Site 角色只读汇总多个 FAB；相同模板不使 FAB 共享 Mutable State。
- `SHARED_CAPACITY`：只有 M07 确定性执行器与 M08 `SiteResourceAuthority/SiteCoordinator` 的正式接口可参与 Site 共用容量争用；所有资源授予具有虚拟时间顺序和可回放记录。
- 在没有明确的 `SiteResourceDefinition` 或跨 FAB 业务配置时，不得推断存在共享设施，也不得在当前版本自动进行跨 FAB 物料转移。

## 7. 典型流程与异常处理

1. 根据路由与身份解析授权范围，加载主数据/Run 状态；服务器对每次 API/WS 请求独立鉴权。
2. 组件 effect 用可取消请求与 generation 管理加载；FAB/Run 切换先释放旧订阅，旧请求返回时不得写入新视图。
3. 将表单意图交给后端 owner；区分提交中、已受理、权威生效与失败，不在本地推进 DES。
4. 通过 Scene Facade 挂载 canvas，卸载/切换时执行幂等 dispose；React 开发模式重复挂载不得留下多个 Engine/RAF/订阅。
5. 断线显示 stale/重连状态，由 state-sync 完整重同步后恢复动态视图；业务 Run 不因页面关闭而停止。

## 8. 测试、交付和验收

- T-01 路由与 API/WS 授权负测；T-02 场景发布冲突与命令超时/重试；T-03 快速 FAB/Run 切换、退出后迟到响应不串数据；T-04 无 WebGPU 时普通报表正常且 3D 明确不可用；T-05 重复挂载/卸载无残留订阅或 GPU 生命周期泄漏。
- 单测覆盖表单、缓存隔离和 UI 意图；E2E 对真实 API 验证 Accepted→权威状态与权限撤销，不以菜单隐藏代替服务端授权。
- 前端构建、类型/可访问性检查通过；真实 GPU 验收由 M12 提供，M11 记录其集成证据。

### Definition of Done

- [ ] 所辖 TS 包可构建，公开接口无 Babylon 私有对象。
- [ ] 后端命令/查询契约、冲突和断线状态明确。
- [ ] 跨 FAB/Run/身份缓存隔离与页面生命周期 E2E 通过。
- [ ] 日志脱敏，普通页面与不支持 WebGPU 的提示可用。
- [ ] 对应 G0—G8 的适用验收证据有固定 URI 和 Review 记录；不适用的数据库迁移明确归属后端 owner。

## 9. 特殊风险与设计提醒

页面状态、服务端查询缓存、3D 动态状态是三个不同存储，不能用一个全局 Zustand Store 混成权威数据。
