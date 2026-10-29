# SemiconFab Next：正确性优先的彻底重构规范

- 状态：审查后的目标规范，不是已实施或已验收记录
- 审查基线：GitHub iphone2059/SemiconFab-Next，`main@1fb25ffc36b5b65813f031c8d889063964b4d1bd`（2026-10-29）
- 适用范围：`web_app`、必要的 fab_app/API 协议和配套测试、CI、文档
- 不变约束：React 19、TypeScript、Effect 4、TanStack Router code-based routing、XState 6、Babylon Lite WebGPU-only、Rust/Oxc React Compiler；`web_app/src` 严格单层模块目录
- 首要原则：正确性 > 可证明的系统边界 > 规范性 > 性能；不接受为了减少改动而保留错误抽象；不保留兼容层和双写

## 0. 证据范围及术语

本文件来自对远端源码、测试和仓库提交的验证日志只读审查，未在审查会话中重跑 Windows 构建、浏览器或 GPU 测试。仓库有 verify.ps1 exit 0、122 个测试文件/726 测试通过的记录，但它们不能证明尚未覆盖的竞态不存在。

- 源码可证：逻辑可从特定源文件和调用链直接推导。
- 待复现：静态代码提示潜在故障，必须补充可控制交错的 RED 测试。
- 架构缺口：即使现有测试通过，仍违反目标所有权、生命周期或可靠性契约。

此次重构的完成条件不是“旧测试全绿”，而是下列不变量在静态检查、模型测试、故障注入、生产构建浏览器验收中具有证据。

## 1. 强制不变量

ID	不变量	验证方式
INV-01	每个 AppRuntime 只拥有自己的 Registry、资源任务、Fiber、请求协调和缓存生命周期；不同 Runtime 不共享可变请求状态	双 Runtime 并发、相互取消、相互销毁测试
INV-02	同一 Runtime/资源身份同一时刻最多一条实际读取请求；多个订阅者共享该请求	gate/deferred 受控交错测试
INV-03	任意被拒绝的 REST/SSE 响应不得改变已发布的更高 (epoch,sequence) 设备快照；请求失败也不能覆盖更高代的已接受成功快照	交错顺序枚举/性质测试
INV-04	资源的唯一快照所有者是指定 Atom；缓存容量、请求状态、引用计数属于控制元数据而不是第二份快照	数据流与导入图检查；代码审计
INV-05	每个资源身份在活跃时最多一个轮询任务，零订阅后停止，Scope 关闭后无任务写入	双订阅者/Unmount/Stop 测试
INV-06	全部动态资源定义和运行时元数据有有限保留策略，生命周期到期后可回收	千/万唯一资源压力测试、堆快照
INV-07	(siteId,fabId,commandId) 的命令事件只经一处有序投递；旧 revision、过期 generation、终态之后的事件不改变权威状态	状态机与扰动测试
INV-08	同一 FAB 的全部核对入口共享最多 4 个并发槽位，同一命令最多 1 个 in-flight；取消不遗留槽位	组合入口并发、异常、中断测试
INV-09	每个活跃 actor 有唯一子 Scope，关闭子 Scope 后 finalizer 恰好执行一次；父 Scope 关闭后全部资源释放	计数型 finalizer、强引用释放测试
INV-10	EventSource、PubSub、Fiber、Worker、轮询定时器均有明确所有者和容量/关闭协议；无静默丢失的命令结果	storm、close race、慢消费者测试
INV-11	UI 对同一命令只从 Atom 的只读投影获取数据，不能存在 local React state 备份路径	架构扫描+runtime 替换测试
INV-12	编译器 ON/OFF 的确定性业务行为一致；Compiler 不能改变 BigInt、Effect/Atom 订阅和外部可变对象读取的语义	差分测试、真实生产 bundle E2E
INV-13	所有资源请求/命令恢复的身份、幂等、版本和失败语义都有后端权威契约；前端不虚构无法保证的持久恢复	API contract tests/后端重启测试
INV-14	src 内仅 src/main.tsx 与 src/<module>/<file>；模块依赖方向、文件命名和未使用代码有强制门禁	AST/import graph + 负向 fixture

## 2. 资源系统：替换而不是修补 resource.ts

### 2.1 已发现的问题

src/api/resource.ts 的模块级 WeakMap<Resource,Promise> 让两个独立 AppRuntime 的同一个 Resource 共享 in-flight；`resourceFamily` 使用永不淘汰的 Map<Key,Resource>；`refreshResource` 在启动时保存 previous，在异步完成时将它传给接受钩子，并在通用 catch 中写 Failure。

src/api/equipment.resource.ts 在 REST 响应被 Gate 拒绝后返回此前捕获的 previous，调用方仍执行 registry.set(AsyncResult.success(previous))。可构造 REST 开始时 10 → SSE 更新 12 → REST 11 被拒绝 → Atom 写回 10。首次没有 previous 的失败路径也可能将后续 SSE 成功状态替换为失败。此项是必须处理的 P0 级源码缺陷。

### 2.2 最终设计

由 AppRuntime 创建一个显式 ResourceManager。它内部为每个规范化的 ResourceKey 建立有生命周期的协调条目，包含单飞请求、订阅计数、轮询 fiber、请求 generation 与 TTL/容量控制；每条资源的有效 payload 只保存在其 Atom 中。所有资源读取、接收推送、失效、释放均通过该管理器。模块级 sitesResource 可以是不可变定义，但不得携带跨 Runtime 可变请求状态。

不得为兼容 QueryClient 保留 queryKey、`invalidateQueries` 或 query 对象包装。需要重新设计资源 Identity、Scope ownership、Data/Control 分离及提交协议。

资源状态采用完整的、互斥的 discriminated union，例如 Initial / Loading / Ready / Refreshing / FailedWithoutValue / FailedWithPrevious，或使用符合这些语义的原生 Effect AsyncResult；必须明确定义状态读取/序列化/错误呈现。禁止额外创建 lastSuccess 数据缓存。`previousSuccess` 必须始终属于同一 Atom 的状态。

提交协议必须是显式的 Publish | Ignore 判定，Ignore 不得触发任何 Atom 写入。在一次同步、不可被 await 切开的提交步骤中重新读取当前 Registry 状态，比较资源身份、Scope generation、请求身份、设备 epoch/sequence，再一次性判定是否写入。`catch` 只有仍属于当前 generation 的请求才可以提交错误状态；更高版本的 SSE 成功具有优先所有权。比较/写入逻辑必须是唯一确定的路径。

同一 Registry 的多个消费者/Router loader 可以共享请求；不同 Registry 即便 key 一样也不得共享 Promise。每个资源只存在一个轮询 Fiber，第一位订阅者激活，最后一位订阅者释放；刷新本身同样遵守 in-flight 限制。`idleTTL` 与 freshness 不混用。

动态 Run 资源必须按 AppRuntime 持有有界 identity cache，最后一位订阅者离开后记录 idle 时间，到期释放 resource owner、轮询、订阅和控制元数据；对资源节点回收和实际堆内存进行压力测试。不能仅验证 AtomRegistry.getNodes() 减少就宣称 Resource 定义也被回收。

### 2.3 REST/SSE 一致性

所有 REST、SSE、重连后快照与权威恢复接口必须进入唯一 EquipmentStatusCommit 端口；任意 writer 均不得绕过 Gate。每个 (siteId,fabId) 的 epoch/sequence 高水位和 Atom 内容应在同一同步提交段演进。无效帧、旧帧、不同 FAB 的帧只产生诊断，不允许改变有效快照。重连、浏览器重挂和重建 Scope 必须有独立 generation token，旧回调不能提交。

## 3. FAB Runtime、命令可靠性与后端契约

### 3.1 Scope 树

```text
AppScope
  ├── ResourceScope(resource key)
  ├── FabScope(siteId, fabId)
  │     ├── CommandTransportScope
  │     ├── TelemetryScope
  │     ├── ReconciliationSchedulerScope
  │     └── CommandScope(commandId)
  │             ├── XState actor
  │             ├── projection subscription
  │             └── command-owned tasks
  └── RenderingScope(viewer identity)
```

由 AppRuntime 或明确组合根创建这些 Scope；Scope 的唯一最终责任者调用 close。终态驱逐关对应 CommandScope，而不是直接 workflow.dispose() 后等待父 Scope 的 finalizer 再 dispose。每个资源的 acquisition/release 使用官方 Effect.acquireRelease 等结构化资源 API。Fiber 必须 forkScoped/被 scope 管理，不能在业务运行时使用全局无主 Effect.runFork。

### 3.2 唯一核对调度器

FabRuntime 的 reconcileCommand、`reconcileTracked`、`reconcileAll`、`trackCommand`、gap、重连和容量溢出全部通过同一个 FabReconciliationScheduler。队列按复合命令身份去重，限流 4；同一 identity single-flight；排队有容量限制和取消语义；超时/失败/关闭不泄露并发槽位。批量调用不得创建另一套 worker bypass scheduler。

### 3.3 唯一命令投影

删除 useCommandProjection() 内“Atom 优先，React useState 作为 fallback”的双源实现，`projectionRegistry` 改为在生产构造时明确要求的依赖。只有 adapter/aggregator 能写 commandProjectionAtom；读取由 Atom 统一完成。Runtime 关闭、actor 驱逐、FAB 切换时必须失效对应投影，阻止旧值被新会话读取。

### 3.4 有界 SSE，不能用静默丢弃换内存有界

PubSub.unbounded 不符合有界运行时约束。改成有界缓冲后必须明确定义溢出和可证明的恢复途径：若事件丢弃，必须产生 gap/dirty 信号并调度权威核对；不能只计数。EventSource 的关闭、重开、自动重连、终止/异常事件都在 Scope 中建模，禁止重复连接和旧 generation 写入。流量背压、单连接复用和超时要有模型测试。

### 3.5 必须扩展的后端能力

如果产品目标包含浏览器刷新/断线后命令最终状态恢复，仅靠浏览器内存无法提供该保证。不计代价意味着需要修改后端，不再把前端边界当作不许触碰的限制。后端应提供持久化的幂等命令记录、按复合命令身份查询的权威 revision/outcome、可重放事件 journal/outbox、游标 epoch/sequence 与显式 gap 报告；严重 gap 时提供按 FAB 列举活动/未确认命令的恢复接口。未实现这些能力时，文档必须明确标记只能做到尽力恢复，不能宣称“持久可靠”。

## 4. React/Atom 与 Oxc Compiler 规则

React UI 不应为了 Oxc 的优化正确性依赖编译器对某个表达式的缓存行为。业务 reducer 在输入未变时返回原状态；React Hook 的 effect 依赖必须正确；外部可变 registry 通过 useSyncExternalStore 或 Atom 订阅使 React 有明确的变化信号。避免先将整个旧 Zustand Store 塞进一个 Atom.keepAlive 后只通过对象 selector 优化；按生命周期与数据 owner 拆分应用级偏好、FAB 快照、Twin UI 与会话状态。

保留 Rust/Oxc，不引入 Babel 或 runtime fallback。但 Oxc React Compiler 官方明确仍为实验性，仓库的验收报告也记录了曾发生的 BigInt/reduce 语义错误。当前将有关计算移到组件外不能代替编译正确性认证。生产 release 必须由固定版本的 Compiler ON/OFF 在同一输入、同一 mock clock、同一网络响应和事件调度下产生等价业务输出；测试应覆盖 BigInt、闭包捕获、动态 import、Effect/Atom subscriptions、React StrictMode、外部可变 registry、FAB 切换和 GPU 生命周期。若发现语义不等价，阻断发布并修复/上游提交 Oxc 缺陷，不能悄悄关闭 Compiler，也不能改用 Babel。

@vitejs/plugin-react@6.1.2 对 oxc-transform-react@^0.152.0 的 peer 范围与目前锁定 0.156.0 有偏差，仓库通过 peerDependencyRules.allowedVersions 放行。应改为验证插件与 Oxc 的真正 API 兼容：升级到正式匹配版本组合，或维护经过 CI 保证的明确版本补丁/分支，而不是把 peer 检查规则当兼容性的证明。升级后重新跑整套差分验证。

## 5. 源码规范与技术债务清除

继续执行唯一目录规范：`web_app/src` 根只保留 main.tsx，其他生产源码放 src/<module>/<file>；模块名称及文件名为小写 kebab-case。保留当前 16 个一级业务/技术模块即可，新增模块须写 owner 与依赖方向。不得恢复旧 features/*、`api/queries/`、`rendering/lite/`、转发层或 legacy compatibility。

修改 state/runtime-store.ts 的命名和职责：它已是 Atom 实现，不能继续称 Store；迁到 state/runtime.atom.ts，如状态中混合 viewer 生命周期和跨 FAB 数据，则按 owner 拆分。`twin-page.atom.ts` 的大对象应按更新频率、会话与所有权划分，避免 keepAlive 导致长期滞留和不必要的拓宽通知。此为结构性重设计，不能仅改文件名。

删除旧路径测试 mock（例如 tests/integration/equipment-status-scope-cycle.test.tsx 中仍引用 src/features/twin/fab-viewer），添加 mock 实际生效的断言。删除包含无效断言、已失效路径和未被调用夹具的测试；不得为了达到测试数而保留空覆盖。`noUnusedLocals/noUnusedParameters`、import graph 无环、`@ts-nocheck` 全禁、显式类型化 API 与负向 fixture 门禁保持启用。

## 6. 必须新增的 RED 测试

测试 ID	可控故障/竞态	通过标准
CORE-001	同一 Resource，两个不同 Runtime 并发	网络执行各自隔离；只更新本 Registry；取消互不影响
CORE-002	同一 Runtime 两消费者同时 mount	只有一个网络请求、一个轮询 owner
CORE-003	REST(11) 延迟返回，期间 SSE(12) 更新，初始值(10)	最终仍为 12；绝无旧值瞬时可见
CORE-004	REST 失败，期间 SSE 推送更新	最终仍为 SSE Success；失败仅产生诊断
CORE-005	旧 FAB Scope 的 REST/SSE/Timer 在新 Scope 激活后完成	新 FAB Atom 与 UI 不受影响
CORE-006	大量 Run IDs，页面反复挂载/卸载/TTL 到期	Resource 定义、Fiber、Registry node 与堆使用有界
CORE-007	8+ 命令混合从 track/reconnect/gap/overflow/显式入口核对	同一 FAB in-flight 总数永不超过 4；同命令永不超过 1
CORE-008	actor 终态驱逐，再关闭 FAB	每个 actor/finalizer 恰好执行一次，无保留闭包
CORE-009	Runtime 关闭后用同一 Registry 重建同 FAB	旧命令投影、旧事件与旧状态不进入新 Runtime
CORE-010	SSE 慢消费者 + 高速命令事件	队列有界；溢出明确触发 gap + 权威对账，未确认命令不静默丢失
CORE-011	React Compiler ON/OFF 的空列表、Run submit、BigInt、FAB 切换	状态/DOM/HTTP trace 等价，执行次数允许差异但业务语义不变
CORE-012	生产 bundle 的真实浏览器与 WebGPU 设备丢失	确定性释放与恢复，无 WebGL fallback、跨 generation 无写入
CORE-013	后端重启、游标断裂、事件丢失和重复幂等请求	后端权威记录可恢复，revision 不退、命令不会重复执行
CORE-014	终止所有 FAB/Root Scope	0 活跃 Fiber、actor、EventSource、Worker、timer；无新写入

对于命令事件序列、设备 epoch/sequence 和状态机，除手写用例外应使用 property-based/model-based 测试，系统性生成乱序、重复、缺口、交错、关闭与重启序列。每条失败用例必须输出可重复的 seed 和最小反例。

## 7. 必须完成的验证与构建门禁

- 静态：TypeScript strict、Oxlint React correctness、React Compiler fixture + 真正生产 TSX 转换扫描、依赖无环、唯一状态 owner、源码单层、禁止未知 runner/第二 Registry、零旧依赖。
- 单元：资源状态转移、REST/SSE ordering、Schema/HTTP、命令模型、取消与最终释放、resource-family 有界性。
- 集成：Router prefetch → mount → navigation → refresh、StrictMode 双挂、FB Scope 交错、命令调度混合入口、真实 HTTP + SSE 取消。
- 浏览器：用固定 Chrome 在 生产 vite build + preview/server 环境执行功能回归；不是只测 Vite dev。Compiler ON/OFF 使用同构服务端与确定性测试数据比对业务 trace。
- GPU：Windows 指定 GPU 的真实 WebGPU 执行、设备丢失注入、重复恢复、5–30 分钟稳定性和 heap/GPU 资源观察；不把 600 帧 smoke 当长期验收。
- CI：每个 push/PR 的 Windows 构建执行静态+集成+生产 bundle browser e2e；涉及渲染或 WebGPU 的提交必须在受控 GPU Runner 执行 GPU gate。保存 hash、原始日志、输入 seed、版本及性能报告。
- 证据：每次修复后生成与新 commit SHA 绑定的验收记录；已有 Task 7 的 726 PASS 只当历史证据，不能继续宣称新架构已通过。

## 8. 执行顺序与停止条件

阶段	必须完成	停止条件
A：规范冻结	承认并登记所有架构缺口；后端持久恢复契约、资源状态机、Scope/identity 模型作正式 ADR	关键身份/状态转移仍含糊则不得开发
B：资源重建	AppRuntime 级 ResourceManager、受控提交、单飞、单轮询、动态资源回收，移除原有弱隔离实现	CORE-001~006 红转绿，旧接口彻底删除
C：命令重建	FAB / Command 子 Scope、全局核对调度器、原生有界 Effect Stream、唯一只读投影	CORE-007~010、CORE-014 通过
D：后端正确性	持久 idempotency + journal/outbox + authoritative query + gap/resync 端点，并更新 DTO/Schema	CORE-013 和重启恢复测试通过
E：UI 与 Compiler	拆除 fallback state、修复 Atom 粒度/旧文件、Oxc 差分与生产 bundle UI 验收	CORE-011、真实 E2E 通过，无 Compiler 语义差异
F：最终签收	全量 verify.ps1、生产浏览器、GPU、长稳、负向门禁、文档与原始证据	所有不变量及测试通过，未覆盖项不得标记 PASS

不同阶段可以修改任意必要文件和 API。每个阶段产物必须由可执行测试约束，不允许只更新注释或 Markdown；如出现红测，优先修订不正确的实现/契约，而不是删除断言、设置 suppress 或降低阈值。所有遗留类型、旧代码、临时适配器和过时文档都要清理，不保留兼容性包袱。

## 9. 审查依据

- 代码：web_app/src/api/resource.ts；web_app/src/api/equipment.resource.ts；web_app/src/api/use-resource.ts；web_app/src/runtime/fab-runtime.ts；web_app/src/runtime/command-workflow-scope.ts；web_app/src/app/runtime-provider.tsx。
- 仓库证据：`docs/architecture/evidence/effect4-final-acceptance.md`、`docs/architecture/evidence/effect4-task7-react-compiler.md`、`docs/architecture/evidence/perf/task7-memo-removal-verify.log`。
- 官方资料：Effect Atom v4、Effect Scope、Effect Runtime、Oxc React Compiler。

---

## 实施冻结记录（2026-10-29，Phase A）

- 冻结基线：`1fb25ffc36b5b65813f031c8d889063964b4d1bd`（工作树干净，verify.ps1 exit 0；122 文件/726 测试通过仅作历史证据）。
- 本文件按原文冻结；任何实现偏离必须以 ADR 修订记录变更，不得直接改写本规范。
- 阶段 A 产物：`06-adr-resource-state-machine.md`、`07-adr-scope-identity-model.md`、`08-adr-command-durable-recovery.md`、`09-gap-register-and-gates.md`。
