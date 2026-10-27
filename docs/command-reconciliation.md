# 命令核对（Command Reconciliation）

- 版本：V2.1 / 2026-10-27
- 状态：**M3 已实现（内存有界队列 + 假 gateway 验证）**（M3 implemented / backend reconciliation pending）
- 依据：[ADR-0010](adr/0010-command-event-bridge.md)；桥与契约定见 [命令事件桥](command-event-bridge.md)；协议见 [实时协议](realtime-protocol.md)；装配见 [FAB 运行时](fab-runtime.md)
- 当前实现：`CommandEventRecovery` 已实现有界 pending 队列、按 (fabId, commandId) 查询与 `CommandGateway` 权威对账；CE-05 在假源/假 gateway 上 PASS。持久恢复与真实后端查询仍为 M4+。
- 边界：**前端只做有界尽力恢复；持久化/权威恢复是后端责任**。本文档不承诺“关闭浏览器也不丢命令结果”

## 1. 为什么需要核对

实时命令结果可能因为以下原因没有到达工作流：actor 尚未创建、页面已卸载、WebSocket 断线/重连、提交响应与推送乱序、FAB 运行时重启、命令结果重复/乱序。如果这些情况简单地“丢弃/忽略”，会出现：

- 命令实际已成功，但 UI 永远停在“执行中”；
- 重复终态导致 UI 状态回退或重复动作；
- 断线恢复后展示旧状态，用户据此做错误操作。

核对（reconciliation）用“**关联记录 + 权威状态查询 + 有界重试**”把这些场景收敛到后端事实，而不是靠实时消息顺序猜测。

## 2. 恢复对象与状态模型

### 2.1 关联记录（CommandCorrelationRegistry，Application）

| 字段 | 说明 |
|---|---|
| `fabId` / `commandId` | 复合身份 |
| `idempotencyKey` | 提交幂等键（HTTP 提交重试去重） |
| `latestRevision` | 已应用的最大 revision |
| `terminal` | 是否已到终态（succeeded/failed/cancelled） |
| `submissionState` | submitting / acknowledged / failed |
| `createdAt` / `updatedAt` | 记录生命周期 |
| `sourceStreamId` | 最近一次来源流（诊断用） |

### 2.2 恢复记录（CommandEventRecovery，Application）

| 字段 | 说明 |
|---|---|
| `fabId` / `commandId` / `revision` / `outcome` | 未送达工作流的事件内容 |
| `receivedAt` | 到达时间（仅诊断） |
| `attempts` | 已尝试恢复次数 |
| `status` | pending / reconciling / reconciled / abandoned |
| `lastError` | 最近一次失败原因（脱敏） |
| `terminal` | 是否终态事件（优先保留） |

### 2.3 有界 pending queue

- 容量按“活跃命令数上限”设定（M3 与后端/产品共同决定）；**不得无界**。
- 溢出策略：优先保留终态事件；非终态/低价值事件可淘汰并计数告警；**不得静默丢弃终态**。
- 队列元素有 TTL 与最大尝试次数；超过阈值 -> `abandoned` + 可见告警/日志，而不是无声消失。
- 前端不做跨刷新持久化承诺；是否需要 sessionStorage 见 OPEN-V21-09。

## 3. 触发核对的场景

| 场景 | 触发条件 | 处理入口 |
|---|---|---|
| actor 缺失 | `registry.get(fabId, commandId) === undefined` | Bridge -> 恢复记录 -> 待 actor 可用 |
| 页面卸载后结果到达 | 组件已卸载但 Runtime 仍存活 | Bridge 继续处理；UI 重新挂载后读权威状态 |
| WS 确认先于 HTTP 响应 | 结果先到、提交响应后到 | 关联记录按幂等键补全身份（CE-04） |
| 重复/乱序 | revision 相等/更旧 | 去重/拒绝回退（CE-02/CE-03） |
| revision 缺口 | 收到更大 revision 但缺少中间状态 | 不猜测；进入核对（CE-05） |
| 长断线 | 连接恢复且期间可能有终态 | 重连后对活跃命令批量核对（CE-06） |
| 工作流异常 | `receive` 抛错/actor 崩溃 | 记录错误 -> reconcile |
| 终态重复 | 已终态后又收到重复终态 | 幂等；不重复动作 |

## 4. 核对流程（reconcile）

```text
reconcile(commandId):
  1. 在关联记录中取 (fabId, commandId) 与 submission 信息；不存在 -> 记录诊断并退出（不猜）
  2. 查询后端权威状态（按 fabId+commandId 的幂等只读接口）
  3. 比较权威 revision/outcome 与工作流当前状态
  4. 若权威更新：把权威结果应用到工作流（通过受控内部路径，等价于 receive 一次终态）
  5. 若工作流更新（理论上不应发生）：记录冲突，以后端为准并告警
  6. 标记恢复记录 reconciled；清理 pending 中同一命令的旧事件
  7. 失败：按有界退避重试；超过阈值 -> abandoned + 可见告警，保留查询入口
```

要求：

1. **幂等**：同一命令多次 reconcile 结果一致，不产生重复终态动作。
2. **权威优先**：本地实时事件与后端查询冲突时，以后端状态为准，并记录差异。
3. **不伪造**：查询失败时不能把命令标成成功/失败；保持未知/进行中并展示可恢复错误。
4. **有界**：重试次数/间隔/并发有上限（具体值 M3 冻结）；不得在断线风暴中打爆后端。
5. **可观测**：pending/reconciling/abandoned 计数与原因进入诊断（不含敏感数据）。
6. **串行**：同一命令的 reconcile 不得并发；不同命令可有限并发。

## 5. 后端权威查询要求（当前不存在）

前端需要的后端能力（属于 OPEN-V21-07，不得虚构实现）：

| 要求 | 说明 |
|---|---|
| 只读、幂等 | 重复查询不改变状态 |
| 复合身份 | 按 `(fabId, commandId)` 精确查询，不能只按 commandId |
| 返回权威字段 | revision、outcome、是否终态、最后更新时间/排序依据 |
| 权限 | 只返回调用者有权查看的 FAB/命令 |
| 语义稳定 | 未知/已过期命令返回明确错误，不返回猜测值 |
| 可批量（可选） | 重连后按 FAB 拉取活跃命令集合，避免逐条风暴 |

在端点落地前，CE-05/CE-06 只能用 mock 验证结构；**不得**把 mock 结果描述为生产恢复已验收。

## 6. 断线与重连

1. 断线期间不推进任何“成功/失败”UI 状态；只显示连接中断与可恢复提示。
2. 重连后：新流身份订阅 -> 快照/增量恢复展示数据 -> 对活跃命令执行批量 reconcile（限制并发）。
3. 旧流迟到消息按 stream 身份丢弃；不得用旧事件覆盖权威查询结果。
4. 长期断线（超过阈值）后仍无法核对：保留记录 + 明确告警；不得静默清理。
5. 重连后的重复终态由工作流保证幂等（CE-06）。

## 7. 页面卸载与 Runtime 生命周期

- 页面卸载**不**自动销毁 FAB 运行时；否则卸载期间到达的结果会丢失。Runtime 生命周期由应用/FAB 会话管理（见 [FAB 运行时](fab-runtime.md) 第 5 节）。
- 页面重新挂载后：通过 Query 读取命令权威状态（`command.queries.ts`）恢复展示；不直接读 actor 内部。
- 组件卸载后不得再异步 `setState`（React 警告/泄漏）；用挂载检查或订阅纪律保证。
- FAB 切换/登出/运行时销毁：停止订阅与 actor；pending 按策略清理；不得把 A FAB 的恢复记录带到 B FAB。

## 8. 三 FAB 隔离

- 所有关联/恢复/队列键都使用 `(fabId, commandId)`；不得只按 commandId。
- 每个 FAB Runtime 拥有独立的 Bridge/Registry/Recovery；Query 缓存共享但 key 含 `fabId`。
- 同一 commandId 在三个 FAB 中可同时存在，各自独立核对（CE-07）。
- 销毁 FAB-A 不得影响 FAB-B/C 的订阅、actor、恢复记录（CE-08 的扩展断言）。

## 9. 与其他层的边界

| 层 | 与核对的关系 |
|---|---|
| 实时协议 | 提供事件与序列/缺口信号；不做业务去重（[实时协议](realtime-protocol.md)） |
| CommandEventBridge | 触发恢复记录、调用 reconcile；不写 Query/UI |
| workflows/equipment/CommandReconciler | 具体核对逻辑：调用权威查询、把结果应用到 actor |
| XState actor | 持有命令生命周期；通过受控路径接受 reconcile 结果 |
| TanStack Query | 只读展示权威状态（`command.queries.ts`）；不是恢复队列/权威来源 |
| 后端 | 持久化恢复的最终责任方；提供权威查询 |

## 10. 验证矩阵

| 场景 | 覆盖门禁 | 证据状态 |
|---|---|---|
| actor 缺失恢复 | CE-05 | SPECIFIED / NOT RUN |
| 断线重连收敛 | CE-06 | SPECIFIED / NOT RUN |
| 确认先于 HTTP 响应 | CE-04 | SPECIFIED / NOT RUN |
| 重复 revision | CE-02 | SPECIFIED / NOT RUN |
| 乱序回退 | CE-03 | SPECIFIED / NOT RUN |
| 三 FAB 隔离 | CE-07 | SPECIFIED / NOT RUN |
| 销毁后不再回调 | CE-08 | SPECIFIED / NOT RUN |

测试文件（计划）：`web_app/tests/contract/command-recovery.test.ts`、`web_app/tests/integration/command-event-bridge.test.ts`。当前测试环境/依赖/Runtime 均未实现，因此无运行证据。

## 11. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| 后端无权威查询 | CE-05/CE-06 无法闭环 | 后端排期；前端用 mock 验证结构并明确标注 |
| 恢复队列无界/静默淘汰 | 终态丢失 | 有界 + 终态优先 + 告警；测试覆盖溢出 |
| reconcile 风暴 | 后端压力 | 并发/重试上限；批量查询；观察指标 |
| 页面卸载后 setState | 泄漏/警告 | 订阅与挂载检查纪律；Runtime 级状态 |
| 用旧事件覆盖权威 | 状态回退 | 权威优先；旧流身份过滤；CE-03/CE-06 |

开放问题：OPEN-V21-07（权威查询）、OPEN-V21-09（恢复记录生命周期）、OPEN-V21-13（工作流状态只读暴露），见 [架构基线](architecture.md) 第 14 节。
