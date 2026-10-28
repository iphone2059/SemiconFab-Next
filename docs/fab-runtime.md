# FAB 运行时（Fab Runtime）

- 版本：V2.1 / 2026-10-27
- 状态：**已实现并接入产品（模拟后端命令 SSE/HTTP）**（implemented / simulated backend）
- 依据：[ADR-0010](adr/0010-command-event-bridge.md)；桥见 [命令事件桥](command-event-bridge.md)；恢复见 [命令核对](command-reconciliation.md)；协议见 [实时协议](realtime-protocol.md)
- 当前实现：`web_app/src/runtime/` 已有 FabRuntime/Factory/Registry/LifecycleCoordinator；RuntimeBootstrap 按 sites 为每个 FAB 装配，命令源为后端命令 SSE（`SseCommandEventSource`），gateway 为权威 HTTP 查询；`CommandConsole` 提交并通过 `useCommandProjection` 只读展示。无 EventSource/Worker 的测试环境回退空源 seam。

## 1. 定位

FabRuntime 是**唯一装配层**（ARCH-09）：把“实时事件源 + CommandEventBridge + CommandWorkflowRegistry + 工作流实现”按 FAB 组装成一个可启动/停止/销毁的运行时。

它**不是**：

- 不是服务端缓存（Query 负责，应用级单例 + fabId key）；
- 不是 UI 状态容器（Zustand/组件负责）；
- 不是命令状态机本身（XState 工作流负责，藏在 `CommandWorkflow` 后）；
- 不是渲染器（Babylon Lite 渲染生命周期由渲染层管理，见 [渲染管线](rendering.md)）。

## 2. 组件与职责

| 组件 | 职责 | 关键 API | 不得做 |
|---|---|---|---|
| `FabRuntime` | 单个 FAB 的源/桥/registry/工作流实例与运行状态 | `start()`、`stop()`、`dispose()`、`status()` | 创建全局 QueryClient、渲染 3D、操作 DOM |
| `FabRuntimeFactory` | 按 FAB 配置构造 Runtime；注入实时源工厂、`CommandGateway`、工作流工厂、诊断 sink | `create(fabId, deps)` | 单例隐式状态、跨 FAB 共享 actor |
| `FabRuntimeRegistry` | 按 `fabId` 管理 Runtime 实例；保证 get/ensure 幂等；提供 disposeAll | `get(fabId)`、`ensure(fabId)`、`dispose(fabId)`、`disposeAll()` | 把不存在的 FAB 自动补成共享实例 |
| `FabLifecycleCoordinator` | 启动/停止/销毁顺序、错误隔离、超时、重试/降级策略 | `start(runtime)`、`dispose(runtime)`、`onError` | 改变工作流业务状态 |

### 2.1 运行状态

| 状态 | 含义 | 允许的转换 |
|---|---|---|
| `idle` | 已创建未启动 | -> starting |
| `starting` | 订阅中/工作流准备中 | -> running / degraded / failed |
| `running` | 正常接收与分发 | -> stopping / degraded |
| `degraded` | 部分依赖不可用（如实时断线、恢复未完成） | -> running / stopping |
| `stopping` | 正在取消订阅/停止 actor | -> stopped |
| `stopped` | 已停止但可重新 start（若策略允许） | -> starting / disposed |
| `failed` | 启动失败且无法自动恢复 | -> disposing |
| `disposed` | 终态；不得再回调 | 无 |

状态由 Runtime 暴露只读快照给 Provider/诊断，不写入 Query/Zustand。

## 3. 装配与销毁顺序

```text
create(fabId, deps):
  1. 构造 CommandCorrelationRegistry / CommandEventRecovery（per FAB，空）
  2. 构造 CommandWorkflowRegistry（per FAB，空）
  3. 构造 CommandEventBridge(source, registry, recovery)   // 此时不订阅
  4. 构造工作流工厂（XStateCommandWorkflowAdapter），按需创建 actor
  5. 返回 FabRuntime(idle)

start():
  1. 订阅 CommandEventSource.commandResult$
  2. Bridge 进入 running；准备接收事件
  3. 对已知进行中命令安排 reconcile（如有）
  4. 状态 running（实时源异常则 degraded）

dispose():
  1. 状态 stopping：Bridge 取消订阅（RxJS subscription.unsubscribe）
  2. 逐个 dispose 工作流 actor（`CommandWorkflow.dispose`）
  3. 清空 pending/关联记录（按策略；不得泄漏到下一个 FAB）
  4. 移除诊断 sink、释放引用
  5. 状态 disposed；之后任何源事件不得再进入业务
```

顺序原则：**先停止入口（订阅），再停止业务（actor），最后清理记录**。这样 dispose 期间到达的消息不会被半处理。启动失败必须回滚已创建的订阅，避免泄漏。

## 4. 三 FAB 隔离

| 规则 | 说明 |
|---|---|
| 独立实例 | 每个 `fabId` 一个 FabRuntime；registry 不得把两个 FAB 映射到同一实例 |
| 独立事件源 | 每个 Runtime 只订阅本 FAB 作用域的流；跨 FAB 聚合由独立只读视图处理 |
| 独立桥/registry/recovery | 关联、去重、恢复记录均按 `fabId` 隔离 |
| 复合身份 | 工作流查找与缓存 key 均为 `(fabId, commandId)` |
| Query 边界 | QueryClient 应用级共享，但所有 FAB 相关 key 含 `fabId`（RQ-04） |
| 故障隔离 | 一个 FAB 启动失败/degraded 不影响其他 Runtime 的 running 状态 |
| 销毁隔离 | `dispose(A)` 只清理 A 的订阅/actor/记录（CE-08 扩展） |

当前产品与所有测试只使用 1 个 FAB（FAB-01）。`Fab:FabCount` 仍支持 1..32，前端 Runtime/遥测/设备状态/UI 按 FAB 数据驱动，121 台设备布局数据在 `src/domain/fab/fab-layout.ts`。每个 FAB 独立 Runtime/订阅/actor 的复合身份架构保留，供将来扩展；当前不要求多 FAB 部署或验收。

## 5. React 集成

- `app/providers/RuntimeBootstrap` 在 `AppProviders` 内按 sites 文档为每个 FAB 创建 `FabRuntime`，`RuntimeProvider` 暴露只读 registry（位于 `QueryProvider` 之内、`RouterProvider` 之外；见 [架构基线](architecture.md) §5.4）。
- 页面通过 `useFabRuntime(fabId)` 获取运行时状态/句柄；**不得**在组件内 `new FabRuntime` 或直接订阅 WebSocket。
- 页面卸载只解除 UI 订阅/停止展示，不自动 dispose Runtime；Runtime 生命周期由应用/FAB 会话管理（避免卸载期间丢失命令结果）。
- FAB 切换：按策略停止/保留旧 FAB Runtime；切换页面不得把 A 的 actor/恢复记录带进 B。
- 登出/应用销毁：`disposeAll()`，确保取消所有订阅与 actor。
- React `StrictMode` 开发态会重复挂载：`ensure(fabId)` 必须幂等；不得因双重 effect 创建两份运行时或双重订阅（需测试）。
- 错误边界：Runtime 启动失败展示可恢复错误；不阻塞其他路由。

## 6. 生命周期矩阵

| 事件 | Runtime 行为 | 说明 |
|---|---|---|
| 应用启动 | `RuntimeBootstrap` 按 sites 文档为每个 FAB 创建 Runtime | 当前默认 1 FAB，前端保留按 FAB 数据驱动的装配 |
| 路由进入 FAB 页面 | `ensure(fabId)` -> start（若未运行） | 页面不直接装配 |
| 页面卸载 | 仅解除 UI 订阅；Runtime 继续 | 命令结果不丢 |
| 切换 FAB | 新 FAB ensure；旧 FAB 按策略保留或 stop | 隔离优先 |
| WebSocket 断线 | Runtime 进入 degraded；重连后恢复 | 不伪造状态 |
| 认证失效/登出 | disposeAll；清理敏感恢复记录 | 安全 |
| HMR（开发） | 显式 dispose 旧实例，避免重复订阅 | 开发体验/泄漏 |
| 测试 | 每个测试新建 Registry，结束后 disposeAll | 无跨测试污染 |

## 7. 与 Router/Query 的边界

- Router loader **不创建** Runtime，也不直接访问 Bridge/actor；Runtime 通过 Provider 提供给页面。
- Query 负责所有 HTTP 服务端数据；Runtime 只负责命令/实时链路。命令权威状态经 `CommandGateway`（`api/transport/HttpCommandGateway.ts`，`GET /api/v1/commands/{id}`）读取，恢复由 `CommandReconciler` 调用同一 gateway（见 [命令核对](command-reconciliation.md)）；当前没有也不应新增独立的命令 Query 模块。
- Runtime 不写 Query 缓存；Busy/进行中状态不进入 Query。
- 高频遥测不经过 Runtime 的业务链路；Telemetry 走 Worker/缓冲（[渲染管线](rendering.md)）；设备槽位/FabToolState 投影在纯函数 `domain/equipment/tool-state-projection.ts`，Runtime 不做投影。

## 8. 当前实现 vs 目标（差距）

| 方面 | 当前事实 | 目标 | 状态 |
|---|---|---|---|
| Runtime | `FabRuntime`/Factory/Registry/Lifecycle 已实现，RuntimeBootstrap 按 sites 装配 | `runtime` 四件套 | PASS |
| FAB 数量 | 产品与测试仅 1 FAB，前端按 FAB 数据驱动 | 保留多 FAB 扩展与复合身份隔离 | 单 FAB 回归；多 FAB 扩展不属当前验收 |
| 实时源 | 后端命令 SSE（`SseCommandEventSource`）+ 权威 HTTP gateway；测试环境回退空源 seam | WebSocket + typed stream（经 Runtime 注入） | 部分（HTTP/SSE 模拟链路） |
| 生命周期 | Runtime/Provider 统一管理；页面只解除 UI 订阅 | Runtime/Provider 统一管理 | PASS |
| 清理测试 | `tests/integration/fab-runtime.test.ts`、`tests/integration/runtime-bootstrap.test.tsx` 覆盖 dispose/缺口核对/StrictMode 幂等 | CE-08；StrictMode 幂等测试 | PASS |

## 9. 测试计划

| 测试 | 内容 | 位置（计划） | 状态 |
|---|---|---|---|
| CE-08 | dispose 取消订阅、停止 actor、无后续回调 | `web_app/tests/integration/command-event-bridge.test.ts`、`tests/integration/fab-runtime.test.ts` | PASS |
| CE-07 | 三个 FAB 相同 commandId 隔离；dispose(A) 不影响 B/C | `web_app/tests/integration/fab-runtime.test.ts` | PASS |
| StrictMode 幂等 | 双重挂载不重复订阅/不双份 actor | `tests/integration/runtime-bootstrap.test.tsx` | PASS |
| 错误隔离 | 一个 FAB start 失败不影响其他 | `tests/integration/fab-runtime.test.ts` | PASS |

单元/契约测试使用假 `CommandEventSource`（RxJS Subject）与记录型工作流；产品接线由后端模拟 HTTP/SSE 链路 + `RuntimeBootstrap` 集成测试覆盖。生产 WebSocket 传输仍不存在，因此真实生产链路的竞态验收仍需后端实现。

## 10. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| Runtime 生命周期归属不清 | 泄漏/丢结果 | OPEN-V21-11 明确：应用会话级、Provider 管理 |
| 三 FAB 只在测试床 | 产品风险 | 产品范围决策前不宣称支持；复合身份先落地 |
| StrictMode/双重订阅 | 重复处理命令 | 幂等 ensure + dispose 测试 |
| 启动失败未回滚 | 订阅泄漏 | Coordinator 统一 try/catch/回滚顺序 |
| 认证/权限变化 | 越权数据 | 订阅时按权限过滤；登出 disposeAll |

开放问题见 [架构基线](architecture.md) 第 14 节：OPEN-V21-11（实例化时机/页面卸载语义）、OPEN-V21-07（权威查询）、OPEN-V21-06（实时协议）。
