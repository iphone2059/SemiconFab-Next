# Round 5.4 — Runtime 状态终态、Accepted Command 交接与复合 FAB 身份整改规范

**文档性质：** 定向整改规范；只规定修复范围、语义、实现约束和验收条件，不代表源码已经修改或测试已经通过。  
**Repository：** \`iphone2059/SemiconFab-Next\`  
**基线分支：** \`main\`  
**基线提交：** \`972552bd9928d5aaabc59e2a4ae440434dec3a47\`  
**前序规范：** [Round 5.3 — Pending Command Event Source Lifecycle](21-round5.3-pending-source-lifecycle.md)  
**日期：** 2026-10-30

> 本轮只处理 Round 5.3 独立复审发现的 1 项 P1 和 2 项 P2。Round 5.1 / 5.2 已经确认的 Correlation、ACK Ledger、Recovery 双屏障、Scheduler、Scope 所有权和按需 SSE 设计均保持不变。

## 0. 整改目标与边界

| 编号 | 严重级别 | 问题 | 验收目标 |
|---|---|---|---|
| R5.4-01 | P1 | SSE 不可用时，通用 phase 映射把 Unrecoverable 覆盖为 Degraded | 终态失败不可被传输状态覆盖 |
| R5.4-02 | P2 | HTTP 202 返回时 FAB Runtime 已被移除，accepted command 的本地注册被静默丢弃 | Accepted command 必须被当前 Runtime 接管，或进入可验证的待交接状态 |
| R5.4-03 | P2 | Runtime / Telemetry Registry 只以 fabId 为键，违反 (siteId, fabId) 复合身份契约 | 所有 FAB 运行时资源按复合身份隔离 |

### 0.1 冻结项

不得借本轮修改以下已经建立的架构：

- 每个 FAB 独立 FabRuntime、CommandScope、RecoveryScope、Scheduler、CommandEventSource 和 TelemetryRuntime。
- CommandEventBridge、CommandCorrelationRegistry、ACK Ledger、authoritative cover / supersede 语义。
- Recovery pre-cover / post-cover 屏障、generation 失效和有界重试。
- CommandAdmissionReservation 的先预留、后提交或释放语义。
- 高频 Telemetry 的 SSE → Worker → TypedArray 路径；不得将高频帧搬入 React state。
- React Compiler / Oxc 编译器等价验证机制。

不得增加兼容层、旧 API 转发函数、双键并存 Map、按 fabId 猜测 siteId 的回退路径。

## 1. P1 — R5.4-01：Unrecoverable 终态被 Degraded 覆盖

### 1.1 基线缺陷

文件：\`web_app/src/runtime/fab-runtime.ts\`

当前 \`setPhase()\` 的逻辑等价于：

~~~ts
private setPhase(phase: CommandRecoveryPhase): void {
  this.phase = this.recoveryAvailable && this.source.availability === 'unavailable' ? 'Degraded' : phase;
}
~~~

当 HTTP CommandGateway 存在、SSE Source 永久不可用时，所有 phase 请求都会被映射成 Degraded，包括 \`handleRecoveryFailure()\` 在重试耗尽后明确设置的 Unrecoverable。

实际结果：

1. Runtime 使用 pending Source，\`source.availability === 'unavailable'\`。
2. HTTP Gateway 存在，故 \`recoveryAvailable === true\`。
3. authoritative List / Journal Recovery 连续失败。
4. \`attempts >= maxAttempts\`，进入 \`handleRecoveryFailure()\`。
5. 调用 \`setPhase('Unrecoverable')\`。
6. \`phase\` 最终却成为 \`Degraded\`。

这破坏了 Recovery 状态机的终态语义。Degraded 只能表达实时传输不可用，不能代替权威恢复失败。

### 1.2 必须维持的状态语义

本轮保留当前单一 phase API 和 Round 5.3 的 Degraded 语义，不扩大为新的状态模型。

| 条件 | phase | 约束 |
|---|---|---|
| 没有 authoritative Gateway | Unavailable | display-only；不能声称已恢复 |
| Gateway 可用、SSE 不可用 | Degraded | 允许 HTTP authoritative Recovery；不能 Healthy |
| Gateway 与 SSE 可用，尚未完成恢复 | Dirty / Recovering / WaitingRetry | 按现有状态机推进 |
| authoritative Recovery 成功且 SSE 已连接 | Healthy | 只有完整 Recovery 成功屏障后允许进入 |
| terminal failure 或达到 maxAttempts | Unrecoverable | 不受 SSE availability 影响 |
| Unrecoverable 后出现新的外部 dirty 信号 | 重新进入本轮 Recovery | 只能由明确的外部 dirty 输入重新武装 attempts |

\`CommandRecoveryState.realtimeAvailability\`、\`connectionStatus\`、\`recovering\`、\`attempts\` 和 \`nextRetryAt\` 继续表达传输和恢复细节；不得通过覆盖 Unrecoverable 来表达 Degraded。

### 1.3 实现规范

1. 修改 \`FabRuntime.setPhase()\`：显式保留终态 \`Unrecoverable\` 和无权威状态 \`Unavailable\`。只有非终态 phase 才能按既有规则映射为 Degraded。
2. 不能在 \`handleRecoveryFailure()\` 中增加一次性补写、延迟修正或调用方专用绕过函数；终态保护必须位于统一状态转换入口。
3. \`refreshRealtimeAvailability()\` 必须继续遵守现有终态保护：SSE availability 变化不能清除 Unrecoverable，也不能重置 attempts。
4. 只有 \`enterDirty()\` 收到新的外部 dirty 输入时，才按既有规则重新武装 Unrecoverable 状态并开启新的有界 Recovery episode。
5. \`completeRecoverySuccess()\` 仍是进入 Healthy 的唯一成功入口；SSE unavailable 时只能进入 Degraded。
6. Recovery 失败达到上限后，必须保留 \`lastError\`、attempts、maxAttempts 和最后的 Unrecoverable phase。诊断记录中必须存在明确的终态失败记录。
7. 不得让连接状态变化、pending Source 的有限状态 Stream、组件重挂载或普通定时器自动重置 Unrecoverable。

### 1.4 必须增加的测试

主要测试文件：

- \`web_app/tests/correctness/sse/matrix-6-recovery-state.test.ts\`
- \`web_app/tests/integration/fab-runtime.test.ts\`
- \`web_app/tests/integration/command-gateway-http.test.ts\`
- \`web_app/tests/integration/command-transport-failure.test.ts\`
- 必要时增加独立的 \`web_app/tests/contract/command-recovery-phase.test.ts\`

测试场景：

| 场景 | 输入 | 必须断言 |
|---|---|---|
| R5.4-01-T01 | pending Source + 可用 HTTP Gateway + List 请求连续失败 | 达到 maxAttempts 后 phase 为 Unrecoverable |
| R5.4-01-T02 | 已经 Unrecoverable，Source availability 仍为 unavailable | phase 不得变成 Degraded |
| R5.4-01-T03 | 已经 Unrecoverable，连接状态发生变化 | phase 与 attempts 不因连接变化被重置 |
| R5.4-01-T04 | Unrecoverable 后收到新的外部 dirty 信号 | attempts 按新 episode 规则重置，重新执行 Recovery |
| R5.4-01-T05 | pending Source + HTTP Recovery 成功 | phase 为 Degraded，绝不为 Healthy |
| R5.4-01-T06 | SSE 恢复，随后 authoritative Recovery 成功 | phase 才能进入 Healthy |
| R5.4-01-T07 | maxAttempts 失败后检查诊断快照 | 能观察到 Unrecoverable 终态和失败原因 |

**P1 验收条件：** R5.4-01-T01 至 T07 全部通过；不得存在任何由 \`setPhase()\` 引起的终态降级。

## 2. P2 — R5.4-02：HTTP 202 后的 Accepted Command 必须完成交接

### 2.1 基线缺陷

涉及文件：

- \`web_app/src/runtime/fab-runtime-registry.ts\`
- \`web_app/src/workbench/use-command-console.ts\`
- \`web_app/src/runtime/fab-runtime.ts\`

当前提交流程：

1. \`useCommandConsole.submit()\` 从当前 FabRuntime 获取 Reservation。
2. 发出 HTTP POST。
3. POST 返回 202 和 commandId。
4. 调用 \`registry.registerAcceptedCommand(siteId, fabId, commandId, reservation)\`。
5. Registry 如果找不到 Runtime，只释放仍处于 reserved 状态的 Reservation，然后直接返回。
6. 调用方无法区分“已注册”与“未注册”；accepted command 的 commandId 没有交给任何 Runtime，也没有登记待恢复责任。

该竞态可以由 Runtime 生命周期变化触发：HTTP 请求尚未完成时，站点目录刷新导致旧 Runtime 被 dispose / remove；HTTP 202 随后到达。

注意：旧 Runtime 的 \`dispose()\` 已经会释放未提交 Reservation。因此晚到的 202 可能拿到一个已经是 released 的 Reservation。Registry 必须正确处理这一状态，不能重复 release，也不能把它当成 accepted command 已经注册。

### 2.2 所有权原则

- HTTP 202 表示后端已经接受命令；客户端不得把它改判为提交失败。
- Reservation 只约束提交前的本地 Admission；后端接受后，命令身份必须由当前 Runtime 接管。
- Registry 是 Runtime generation 之间的交接边界，不能静默丢弃 accepted command。
- 不得把旧 Runtime 的 Reservation 直接迁移到新 Runtime。旧 Reservation 只允许由其原所有者提交或释放。
- 新 Runtime 必须通过 commandId 建立 Workflow，并执行权威状态核对；不能只依赖后续 SSE 帧碰巧到达。
- 交接责任必须按完整 FAB 身份保存，不能只按 fabId 保存。

### 2.3 目标 API 与数据模型

将 Registry 注册结果改为显式判别联合：

~~~ts
type AcceptedCommandRegistration =
  | { readonly kind: 'registered' }
  | { readonly kind: 'recovery-pending' };
~~~

方法签名应返回该结果：

~~~ts
registerAcceptedCommand(
  identity: FabIdentity,
  commandId: string,
  reservation: CommandAdmissionReservation,
): AcceptedCommandRegistration;
~~~

Registry 增加两类待交接状态：

- \`pendingAcceptedCommands\`：按 FabIdentity 保存尚未交给 Runtime 的 commandId 集合。
- \`pendingAuthoritativeRecovery\`：按 FabIdentity 保存尚未交给 Runtime 的全量恢复请求标记。

只保存 identity 和 commandId，不复制 HTTP payload、Workflow、Actor、Reservation 或 Runtime 对象。

### 2.4 精确交接规则

**A. 对应 Runtime 存在，且仍拥有 Reservation**

1. 校验 Reservation 的 siteId / fabId 与传入 identity 完全相等。
2. 调用 Reservation.commit(commandId)。
3. 返回 \`registered\`。
4. 不创建第二份 Workflow，不执行第二次 Admission。

**B. 对应 Runtime 存在，但 Reservation 属于已经被替换的 Runtime**

1. 在当前 Runtime 上调用 \`registerAcceptedCommand(commandId)\`。
2. 只有在当前 Runtime 接受 commandId 后，才释放旧 Reservation（若其状态仍为 reserved）。
3. 返回 \`registered\`。
4. 当前 Runtime 的既有 Scheduler / Recovery 机制负责查询权威状态。

**C. 对应 Runtime 不存在**

1. 将 commandId 加入该 identity 的 \`pendingAcceptedCommands\`。
2. 若 Reservation 仍为 reserved，则释放；若已 released，不执行第二次 release。
3. 不调用 commit，不创建脱离 Runtime 所有权的 Workflow。
4. 返回 \`recovery-pending\`。
5. 不得丢弃 commandId，不得只设置一个无法恢复终态命令的布尔标记。

**D. 新 Runtime 注册**

1. Runtime 以完整 FabIdentity 注册到 Registry。
2. 对该 identity 的每个 pending commandId 调用新 Runtime 的 \`registerAcceptedCommand(commandId)\`。
3. 新 Runtime 接受每个 commandId 后，才从 pending 集合移除该 ID。
4. 新 Runtime 的 Workflow 创建路径必须保留现有单命令权威查询行为，使已经终态的命令也能通过 commandId 查询；不能只依赖 active-only List。
5. 如果存在 \`pendingAuthoritativeRecovery\`，在 Runtime 注册后调用一次 \`requestAuthoritativeRecovery()\`，由 Runtime 合并为一个 list-only Recovery 请求。
6. 多个相同 identity 的待恢复请求必须合并；不得创建多个 Runtime 或多个共享 SSE Source。

**E. Registry generation 替换**

- \`disposeAll()\` 在 Runtime generation 替换期间不得清空尚未交接的 pending commandId。
- pending ID 只在新 Runtime 成功接管后删除。
- Registry 的最终生命周期结束时，整个 Registry 对象随 AppRuntime 一起释放；不得通过 TTL 静默丢弃已被 HTTP 202 接受的命令。
- \`requestAuthoritativeRecovery(identity)\` 在 Runtime 缺失时也必须记录待交接标记，不能继续无声 no-op。

### 2.5 useCommandConsole 调整

文件：\`web_app/src/workbench/use-command-console.ts\`

1. 调用新的判别联合 API。
2. \`registered\` 和 \`recovery-pending\` 都代表后端已接受；两者都必须保留 commandId。
3. 不得因 \`recovery-pending\` 清空 tracked command，不得释放一个已经 committed / released 的 Reservation。
4. tracked command 应携带完整 identity，以便 Runtime generation 重建后读取正确的 Projection。
5. 如果 UI 暴露交接状态，必须明确显示“等待 Runtime 恢复”，不能显示成命令拒绝或失败。
6. 新 Runtime 装配后，Projection 必须从新 Runtime 的 Atom 读取；禁止在 Console 中增加第二份业务状态缓存。

### 2.6 必须增加的测试

主要测试文件：

- \`web_app/tests/integration/fab-runtime.test.ts\`
- \`web_app/tests/integration/runtime-replacement.test.tsx\`
- 新增 \`web_app/tests/integration/fab-runtime-registry-handoff.test.ts\`

测试场景：

| 场景 | 操作 | 必须断言 |
|---|---|---|
| R5.4-02-T01 | POST 未完成时 remove / dispose 旧 Runtime；随后收到 202 | Registry 返回 recovery-pending，commandId 被保留 |
| R5.4-02-T02 | 旧 Runtime dispose 已释放 Reservation，202 后到达 | 不重复 release，不 commit 旧 Reservation |
| R5.4-02-T03 | 新 Runtime 注册 | pending commandId 被注册到新 Runtime，pending 项被清除 |
| R5.4-02-T04 | 新 Runtime 接管后命令已经 terminal | 新 Runtime 对 commandId 执行权威状态查询并收敛 |
| R5.4-02-T05 | 多个 accepted command 在同一 identity 等待交接 | 每个 commandId 均被保留；全量 Recovery 请求合并 |
| R5.4-02-T06 | 新 Runtime 已存在，旧 Reservation 的 202 才返回 | 新 Runtime 接管 commandId，旧 Reservation 正确释放 |
| R5.4-02-T07 | Registry disposeAll 后重新 register 新 generation | pending commandId 不丢失 |
| R5.4-02-T08 | 相同 commandId 重复交接 | 不创建重复 Workflow，交接幂等 |
| R5.4-02-T09 | 不存在 Runtime 时请求 authoritative recovery | 标记被保留，并在新 Runtime 注册时执行 |

**P2 验收条件：** 任意 HTTP 202 响应都必须满足以下二者之一：当前 Runtime 已接管 commandId；Registry 已持有该 commandId 的待交接责任。禁止第三种静默丢弃状态。

## 3. P2 — R5.4-03：所有 FAB 资源统一使用 (siteId, fabId)

### 3.1 基线缺陷

领域和 Runtime 已经把 FAB 身份定义为 \`(siteId, fabId)\`，但若干 Registry 仍以 fabId 单字段作为 Map key。

涉及位置：

- \`web_app/src/runtime/fab-runtime-registry.ts\`：\`Map<string, FabRuntime>\`，以 fabId 索引。
- \`web_app/src/realtime/telemetry-registry.ts\`：Runtime、consumer count 均以 fabId 索引。
- \`web_app/src/app/runtime-bootstrap.tsx\`：\`siteByFab\` 使用 fabId 作为 key；相同 fabId 出现在两个 Site 时会覆盖。
- \`web_app/src/app/runtime-provider.tsx\`：\`useCommandProjection(fabId, commandId)\` 无法表达 Site 身份。
- \`web_app/src/app/telemetry-provider.tsx\`：\`useFabTelemetry(fabId)\` 无法表达 Site 身份。
- \`web_app/src/api/sites.resource.ts\`、\`web_app/src/routes/route-data.ts\`：\`findSiteByFabId\` 只按 fabId 搜索并返回第一个匹配 Site。
- \`web_app/src/twin/use-twin-route-state.ts\`：根据 fabId 在全部 Site 中 first-match。

当前后端开发目录由 \`SiteDirectory\` 提供单一 Demo Site，因此尚未表现为当前单 Site 部署故障。但仓库已声明使用复合身份隔离；上述实现不满足该契约，不能作为多 Site 架构的验收结果。

### 3.2 唯一身份定义

新增纯领域模块：\`web_app/src/domain/fab-identity.ts\`

~~~ts
export interface FabIdentity {
  readonly siteId: string;
  readonly fabId: string;
}

export function fabIdentityKey(identity: FabIdentity): string {
  return JSON.stringify([identity.siteId, identity.fabId]);
}
~~~

约束：

- 复合身份唯一规范为 \`FabIdentity\`。
- Map / Set 的键统一由 \`fabIdentityKey()\` 生成。
- 不允许使用字符串拼接 \`siteId + ':' + fabId\`；输入值可能包含分隔符。
- 不允许仅凭 fabId 反查 siteId。
- 运行时方法、React Hook、Telemetry Registry 和路由必须传递完整 identity。

### 3.3 Runtime Registry

文件：\`web_app/src/runtime/fab-runtime-registry.ts\`

1. Map key 改为 \`fabIdentityKey({ siteId: runtime.siteId, fabId: runtime.fabId })\`。
2. \`get\`、\`remove\`、\`requestAuthoritativeRecovery\` 接受完整 FabIdentity。
3. \`register\` 通过 Runtime 自身的 siteId / fabId 建立唯一键。
4. \`registerAcceptedCommand\` 使用本规范 R5.4-02 的完整 identity API。
5. 允许 \`site-a/fab-01\` 与 \`site-b/fab-01\` 同时存在；禁止其中一个覆盖、替换或读取另一个。
6. \`fabIdentities\` 返回完整身份集合，不再只暴露无法消歧的 fabIds。

同步调整：

- \`web_app/src/runtime/fab-runtime-factory.ts\` 的 \`sourceFor\` 参数改为完整 FabIdentity。
- \`web_app/src/runtime/fab-runtime.ts\` 创建 Source 时传入自身 siteId / fabId；Source URL 必须来自对应 Site。
- \`web_app/src/app/runtime-bootstrap.tsx\` 删除 \`siteByFab\` lossy Map，直接使用 sites 文档中的每个 \`{ siteId, fabId }\` 构造 Runtime 和 Source。
- \`FabLifecycleCoordinator\` 继续只管理 Registry，不建立第二份身份映射。

### 3.4 Telemetry Registry

文件：

- \`web_app/src/realtime/telemetry-registry.ts\`
- \`web_app/src/realtime/telemetry-runtime.ts\`
- \`web_app/src/app/telemetry-provider.tsx\`
- \`web_app/src/app/runtime-bootstrap.tsx\`

要求：

1. Telemetry Registry 的 Runtime Map 和 consumer count Map 均使用复合 identity key。
2. \`get(identity)\`、\`acquire(identity)\` 和 release 闭包必须绑定完整 identity 与 Runtime 实例。
3. 两个 Site 中相同 fabId 的 TelemetryRuntime 不得共享引用计数。
4. Telemetry SSE URL 必须由 identity 构造：\`/api/v1/sites/{siteId}/fabs/{fabId}/telemetry/stream\`。
5. \`TelemetryRuntime\` 的选项应显式携带 siteId / fabId 身份，不能只携带 fabId。
6. 当前 TelemetryFrame wire contract 只含 fabId；本轮不擅自修改 wire schema。Site 隔离由 Site-scoped endpoint 和对应 Runtime 的 URL 绑定。若后续要把 siteId 加入帧协议，必须同步修改后端、契约 schema、解码器和协议测试，不能只在前端假定该字段存在。
7. 旧 Runtime 的 release 闭包仍只能释放创建该闭包时的 Runtime；新 generation 的同 fabId Runtime 不得受旧闭包影响。

### 3.5 React 消费者与命令提交

更新以下 API：

- \`useCommandProjection(identity, commandId)\`
- \`useFabTelemetry(identity)\`
- \`useCommandConsole({ identity })\` 或等价的显式 siteId / fabId 参数。

涉及文件：

- \`web_app/src/app/runtime-provider.tsx\`
- \`web_app/src/app/telemetry-provider.tsx\`
- \`web_app/src/workbench/use-command-console.ts\`
- \`web_app/src/workbench/command-console.tsx\`
- \`web_app/src/twin/twin-page.tsx\`
- \`web_app/src/twin/use-twin-route-state.ts\`

要求：

1. TrackedCommand 保存 siteId、fabId、commandId。
2. CommandConsole 的 ProjectionRow 必须接收完整 identity。
3. Twin 页面根据完整 identity 获取 TelemetryRuntime。
4. 切换 Site 时，旧 Site 的 Telemetry consumer 必须释放旧 Runtime；新 Site 只 acquire 新 Runtime。
5. 相同 fabId 的两个 Site 不得读取相同 Projection Atom 或 Telemetry Snapshot。

### 3.6 路由必须携带完整身份

当前路由 \`/fabs/$fabId/3d\` 不能唯一确定复合身份。若允许不同 Site 存在相同 fabId，路由不得通过 first-match 推断 Site。

将规范路由改为：

~~~text
/sites/$siteId/fabs/$fabId/3d
~~~

更新：

- \`web_app/src/routes/fab-3d.route.tsx\`
- \`web_app/src/routes/route-data.ts\`
- \`web_app/src/routes/route-url-mapping.ts\`
- \`web_app/src/api/sites.resource.ts\`
- \`web_app/src/twin/use-twin-route-state.ts\`
- \`web_app/src/twin/twin-page.tsx\`
- \`web_app/src/workbench/workbench.tsx\`

具体要求：

1. \`fab3dPath(siteId, fabId)\` 是唯一的路由构造函数。
2. Route loader 必须以 siteId + fabId 精确校验 Site membership。
3. \`findSiteByFabId\` 删除，替换为完整 identity 查找；禁止 first-match。
4. Twin 页面不再从全局 sites 列表按 fabId 选择第一个 Site。
5. Workbench 生成 3D 链接时同时传入当前 Site 和选中 FAB。
6. 不保留旧路由 alias 或自动重定向；更新所有 E2E / GPU / Compiler 等价测试脚本中的路由地址。

至少检查：

- \`tools/e2e_production.mjs\`
- \`tools/e2e_functional.mjs\`
- \`tools/gpu_gate.mjs\`
- \`tools/compiler_equivalence.mjs\`

### 3.7 必须增加的测试

主要测试文件：

- \`web_app/tests/integration/runtime-bootstrap.test.tsx\`
- \`web_app/tests/integration/runtime-replacement.test.tsx\`
- \`web_app/tests/integration/fab-runtime.test.ts\`
- \`web_app/tests/realtime/fab-telemetry-registry.test.ts\`
- \`web_app/tests/realtime/telemetry-runtime.test.ts\`
- \`web_app/tests/integration/command-projection-identity.test.tsx\`
- \`web_app/tests/integration/command-actor-scope.test.tsx\`
- \`web_app/tests/api/sites-queries.test.ts\`
- \`web_app/tests/integration/router-resource.test.tsx\`
- \`web_app/tests/integration/url-mapping.test.ts\`

必须构造如下测试数据：

~~~ts
const sites = [
  { siteId: 'site-a', fabs: [{ fabId: 'fab-01' }] },
  { siteId: 'site-b', fabs: [{ fabId: 'fab-01' }] },
];
~~~

测试场景：

| 场景 | 必须断言 |
|---|---|
| R5.4-03-T01 | 两个 Site 中相同 fabId 可以注册两个不同 FabRuntime |
| R5.4-03-T02 | get(site-a, fab-01) 与 get(site-b, fab-01) 返回不同 Runtime |
| R5.4-03-T03 | remove(site-a, fab-01) 不影响 site-b/fab-01 |
| R5.4-03-T04 | 两个 Site 构造不同 Command SSE URL，siteId 不发生覆盖 |
| R5.4-03-T05 | 两个 Site 构造不同 Telemetry SSE URL |
| R5.4-03-T06 | acquire(site-a, fab-01) 不启动 site-b/fab-01 的 TelemetryRuntime |
| R5.4-03-T07 | 释放 Site A 的最后一个 consumer 不会停止 Site B Runtime |
| R5.4-03-T08 | 两个 Site 的相同 commandId 不共享 Projection Atom |
| R5.4-03-T09 | 路由 loader 对 siteId + fabId 精确匹配；不存在的组合进入 route error |
| R5.4-03-T10 | Workbench 生成的路由同时包含 siteId 与 fabId |
| R5.4-03-T11 | 旧 Site 的迟到回调不能修改新 Site 的 Projection / Telemetry |
| R5.4-03-T12 | 同一个 Site 内多个 FAB 仍保持既有独立 Runtime、Worker 和 SSE 行为 |

**P2 验收条件：** 同 fabId、不同 siteId 的对象可以并存且完全隔离；所有消费者和路由都必须提供完整 identity。

## 4. 文件整改清单

| 文件 | 整改内容 |
|---|---|
| \`web_app/src/runtime/fab-runtime.ts\` | R5.4-01 终态保护；SourceFactory 使用完整 identity |
| \`web_app/src/runtime/fab-runtime-registry.ts\` | R5.4-02 pending handoff；R5.4-03 复合键 |
| \`web_app/src/runtime/fab-runtime-factory.ts\` | SourceFactory 传递完整 identity |
| \`web_app/src/domain/fab-identity.ts\` | 新增 FabIdentity 与唯一 key 函数 |
| \`web_app/src/realtime/telemetry-registry.ts\` | Runtime / consumer Map 复合键 |
| \`web_app/src/realtime/telemetry-runtime.ts\` | TelemetryRuntime 显式携带完整 identity |
| \`web_app/src/app/runtime-bootstrap.tsx\` | 删除 siteByFab lossy Map，按完整 identity 装配 |
| \`web_app/src/app/runtime-provider.tsx\` | Projection 查询使用完整 identity |
| \`web_app/src/app/telemetry-provider.tsx\` | Telemetry 查询和 acquire 使用完整 identity |
| \`web_app/src/workbench/use-command-console.ts\` | 接受注册结果；保留 accepted command；完整 tracked identity |
| \`web_app/src/workbench/command-console.tsx\` | ProjectionRow 传递完整 identity |
| \`web_app/src/api/sites.resource.ts\` | 删除 findSiteByFabId |
| \`web_app/src/routes/route-data.ts\` | Site + FAB 精确查找 |
| \`web_app/src/routes/fab-3d.route.tsx\` | 路由同时携带 siteId / fabId |
| \`web_app/src/routes/route-url-mapping.ts\` | 新的唯一 canonical route |
| \`web_app/src/twin/use-twin-route-state.ts\` | 删除按 fabId first-match |
| \`web_app/src/twin/twin-page.tsx\` | Twin 页面传递完整 identity |
| \`web_app/src/workbench/workbench.tsx\` | 生成复合身份路由 |
| \`tools/e2e_production.mjs\` 等 E2E 脚本 | 更新 canonical route |
| 上述测试文件 | 增加 P1 / P2 的回归矩阵 |

如果实现过程中发现额外消费者，必须通过全仓搜索更新所有调用点；不允许保留只传 fabId 的生产 API。

## 5. 验证与证据要求

### 5.1 定向测试

至少执行：

~~~powershell
pnpm exec vitest run web_app/tests/correctness/sse/matrix-6-recovery-state.test.ts web_app/tests/integration/fab-runtime.test.ts web_app/tests/integration/runtime-replacement.test.tsx web_app/tests/integration/fab-runtime-registry-handoff.test.ts web_app/tests/integration/runtime-bootstrap.test.tsx web_app/tests/realtime/fab-telemetry-registry.test.ts web_app/tests/realtime/telemetry-runtime.test.ts web_app/tests/integration/command-projection-identity.test.tsx web_app/tests/integration/command-actor-scope.test.tsx web_app/tests/api/sites-queries.test.ts web_app/tests/integration/router-resource.test.tsx web_app/tests/integration/url-mapping.test.ts
~~~

按仓库实际 package scripts 确认命令执行目录；不得因单个测试文件不存在而跳过该测试，新增测试必须先落地。

### 5.2 完整门禁

必须在本轮最终代码提交 SHA 上执行：

1. TypeScript typecheck。
2. Oxlint / lint。
3. Vitest 全量测试。
4. Web production build。
5. .NET build 与 tests。
6. 生产 E2E、WebGPU / no-WebGL gate。
7. Compiler ON/OFF 独立后端等价验证。
8. 仓库 canonical \`verify.ps1\` 完整门禁。
9. \`git diff --check\`，并确认工作区干净。

### 5.3 证据约束

- 新验证报告必须记录本轮最终源码 commit SHA。
- \`final-verify.json\`、测试日志、浏览器 trace、Compiler 等价 trace 必须属于同一最终 SHA。
- 不得将基线 \`a7ef24b\` 或其他历史提交的验证结果当作本轮通过证据。
- 若 CI 未运行、E2E 未运行或某个门禁失败，必须如实标记；不得将静态检查描述为运行时验证。
- 复审必须重新读取最终 GitHub main / PR head 的实际文件，不得只审查本地摘要。

## 6. 最终验收标准

Round 5.4 只有同时满足以下条件才可标记通过：

- [ ] R5.4-01：无 SSE 时 Recovery 重试耗尽仍稳定进入 Unrecoverable。
- [ ] R5.4-01：新的外部 dirty 信号可以按既有规则重新武装 Recovery。
- [ ] R5.4-01：无 SSE + HTTP Recovery 成功只能 Degraded，不能 Healthy。
- [ ] R5.4-02：HTTP 202 返回后，commandId 必定被当前 Runtime 接管或进入 pending handoff。
- [ ] R5.4-02：Runtime remove / dispose 与 HTTP 响应乱序不会丢失 accepted command。
- [ ] R5.4-02：terminal command 在 handoff 后仍能通过 commandId 权威查询收敛。
- [ ] R5.4-03：Runtime Registry、Telemetry Registry 和消费者 API 全面使用复合 identity。
- [ ] R5.4-03：相同 fabId、不同 siteId 的测试全部隔离通过。
- [ ] R5.4-03：路由、Workbench、Twin、E2E 全面使用 siteId + fabId。
- [ ] Round 5.1 / 5.2 / 5.3 已有契约测试无回归。
- [ ] 完整门禁通过，证据绑定最终提交 SHA。
- [ ] GitHub 最终分支 / PR 与验证证据一致。

## 7. 明确禁止

- 不得通过把所有失败状态统一改为 Degraded 来“修复”P1。
- 不得在 Runtime 缺失时只释放 Reservation 并丢弃 commandId。
- 不得把 pending accepted command 仅保存为布尔值；必须保留 commandId，确保 terminal status 可查询。
- 不得将旧 Reservation 转移给新 Runtime。
- 不得在一个 Runtime 中混合两个 Site 的 Workflow、Telemetry、Projection 或 ACK 状态。
- 不得用 fabId first-match、siteByFab Map、字符串包含匹配或默认 Site 推断身份。
- 不得添加旧 API 的兼容包装、双 Map 或静默回退。
- 不得修改 Round 5.2 已证明正确的 ACK / Cover / Supersede 语义。
- 不得在没有最新 SHA 验证证据时宣布 Round 5.4 完成。

---

**本规范的执行顺序：** 先修复 R5.4-01 并通过定向状态机测试；再实现 R5.4-02 accepted command handoff；最后一次性完成 R5.4-03 复合身份贯通和路由调整。三项均完成后再运行完整门禁，不在中间阶段提前宣告验收通过。
