# Effect 4 迁移设计文档独立审查（2026-10-29）

- 审查对象：`docs/superpowers/specs/2026-10-29-effect-consolidation-design.md`（216 行；主工作树版本，与迁移分支 `cb823db` 内容基本一致，主工作树多出 1 行产品范围说明）
- 配套计划：`WT/docs/superpowers/plans/2026-10-29-effect-consolidation.md`（101 行）
- 对照基线：主工作树 `4fc8a94`；迁移工作树 `WT=.local/worktrees/effect-consolidation` @ `be1da31`（Task 1–2 已提交，Task 3 未开始）
- 审查方式：文档逐节核对仓库代码/锁文件/安装包声明/现有测试与文档；三个独立核查方向（依赖与工具链、Atom/Router/XState API 可行性、行为与验收）由 Lead 复核关键阻断项。全程只读，未修改设计或产品代码。
- **结论：有条件通过。** 方案方向正确，大多数事实性声明与仓库一致（见 §4），可以继续作为迁移约束；但当前版本**不能直接作为 Task 3–6 的验收依据**，需先修订 3 个 P0、7 个 P1。主要问题是：验收项当前不可执行、若干“保留”声明与实际行为不符/属于新增要求未标注、资源刷新与 XState–Effect 集成契约缺具体机制、验收与门禁范围未覆盖文档和工具链现状。

Grading：P0 = 不修订则验收会失败或声明失真；P1 = 影响实现可行性或任务范围；P2 = 一致性/可执行性改进。

---

## 1. P0（必须修订）

### P0-1 §13.9 / 计划 Task 6：`verify.ps1` 当前必然失败，全量验收不可执行

**问题**：设计把 `./scripts/verify.ps1` 作为全量验收（L202），但迁移分支当前状态下它无法通过，且计划 Task 6 未包含修复所需文件。

**证据**：
- `tools/check_architecture.py:185-186` 把 `docs/superpowers` 列入“必须不存在的遗留迁移路径”：`for legacy in (... 'docs/superpowers', ...): assert not (ROOT / legacy).exists()`。
- 但迁移分支 `1e50861` 新增了 `docs/superpowers/plans/...` 与 `docs/superpowers/specs/...`（`cb823db` 又修改）；在主工作树/迁移工作树实跑 `python tools/check_architecture.py` 得到 `EXIT=1`，断言信息 `Legacy migration path remains: docs/superpowers`。`scripts/verify.ps1:15-16` 会调用该门禁。
- 迁移工作树 `global.json` 固定 `.NET SDK 11.0.100-rc.2.26504.105`，但机器只安装 `11.0.100-rc.3.26522.148`；`dotnet --version` 在 WT 报 “A compatible .NET SDK was not found”。主工作树有未提交的 rc.3 修改（`git status` 显示 `M global.json`），但该修改不在迁移分支上。`verify.ps1:25-36` 的 .NET build/test 因此失败。
- 计划 Task 6 的 Files 列表（`WT/docs/superpowers/plans/2026-10-29-effect-consolidation.md:88`）只写依赖审计、verify.ps1、package/lockfile、文档，**未列 `tools/check_architecture.py` 和 `global.json`**。

**影响**：§13.9 必然红（与 Effect 迁移质量无关，却会被误判为迁移未完成）；Task 6 若按现有文件清单执行，修复后仍会继续失败。

**建议**：
1. 在 §12/§13 与计划 Task 6 中明确 `docs/superpowers` 的当前定位（现行设计/计划文档目录），把 check_architecture.py 的“legacy path”断言改为“允许当前设计/计划目录、继续禁止历史迁移/修复目录”，并加负向 fixture 证明历史路径仍被拒。
2. 把 `tools/check_architecture.py`、`global.json`（以及 .NET SDK pin 策略）加入 Task 6 Files/步骤。
3. 统一主工作树与迁移分支的 `global.json` 版本 pin，并说明升级依据；不要依赖主工作树未提交修改。

### P0-2 §13.8：真实浏览器功能回归没有可执行的 harness / 通过标准

**问题**：§13.8（L198）要求用真实浏览器回归 URL/search/前进后退、语言/主题、目录对话框、Workbench 提交、Twin DEMO/实时、wafer/research 播放，但仓库没有功能型浏览器测试工具，也没有给出命令、通过标准或证据格式。

**证据**：`scripts/` 中没有 Playwright/Puppeteer/e2e 脚本；`tools/` 只有渲染性能 CDP 工具（`render_perf.mjs`、`test_render_perf.browser.mjs`）；后者是“负向渲染门禁”，不是页面功能回归。§13.8 未指定执行命令、场景清单、每项通过判据和证据落盘位置。

**影响**：验收项无法执行、无法复核，也无法证明迁移没有破坏页面行为；这正是大重构最需要的行为证据。

**建议**：二选一并写入 §13：
- 指定/新增可执行 harness（可复用现有 CDP 驱动 + 场景脚本），给出命令、场景表、通过判据、证据 JSON 路径；或
- 明确标为 manual checklist，逐项给出操作步骤、通过判据、证据要求（截图/JSON）和复核人。
同时把路由错误边界/404/未知 FAB 行为纳入该验收（当前代码有行为，测试为 0）。

### P0-3 §9:148：容量驱逐“记录诊断并触发权威核对”与当前实现不符（且与现有文档矛盾）

**问题**：§9:148 在“保留既有保留策略”段落中声称容量驱逐“记录诊断，并对可能漏失状态触发权威核对”。当前代码两项都不成立。

**证据**：
- `WT/web_app/src/application/coordination/CommandEventRecovery.ts:39,111` 只有私有 `dropped` 计数器与 getter，生产代码无消费者，只有测试读取。
- 驱逐路径 `CommandEventRecovery.ts:66-72,120-132` 是全局 FIFO（与 terminal 状态无关），不触发 reconcile；`CommandEventBridge.ts:106-115` 对未关联事件只做 hold。
- 现有所有权文档却承诺“终态优先 + 溢出触发核对”：`WT/docs/command-reconciliation.md:47`、`WT/docs/command-event-bridge.md:145`。

**影响**：设计把“新增行为”写成“保留行为”，验收（§13.6 只要求“缓冲溢出可观察”）会漏测；实现完成后仍会与文档矛盾。

**建议**：删除该“保留”表述，或明确写为新增要求：容量驱逐需产生可观察诊断信号（投影/回调）并按命令终态优先驱逐；“可能漏失状态”触发有界合并的权威核对；在计划 Task 4 增加 RED 测试，在 §13.6 增加对应验收项，并同步修正两份 ownership 文档。

---

## 2. P1（重要修订）

### P1-1 §7：资源 freshness 与 idle TTL 的具体实现机制必须写明（官方原语不足）

**问题**：§7 的“freshness 0 → 消费者挂载/导航时重新检查”（L126）、“预加载结果按 idle TTL 保留”（L128）、“Atom 的 idle TTL 不等于 Query staleTime”（L112）在概念上正确，但仅靠官方 `Atom.swr` 无法实现挂载/导航级别的 freshness 检查；文档没有说明所需的自定义资源工具与 Registry 配置。

**证据**：
- 官方 `Atom.swr`（`WT/web_app/node_modules/effect/dist/reactivity/Atom.d.ts:1218`）的 staleTime 只在 atom node 被（重新）构建时检查；`revalidateOnMount` 指的是 node 首次构建，不是 React 挂载。
- 独立核查用已安装 effect 4.0.7 实测：`swr(staleTime=100ms)` + `setIdleTTL(300s)`，卸载后 250ms（已过期）再挂载，source effect 未重跑；只有 `registry.refresh` 才重跑。即“保留 node + 重挂载自动刷新”不成立。
- 每资源 idle TTL 有官方原语：`Atom.setIdleTTL`（Atom.d.ts:203）与 `AtomRegistry.make({ defaultIdleTTL })`（AtomRegistry.d.ts:119-124）；但 `@effect/atom-react` 的 `RegistryProvider` 默认 `defaultIdleTTL: 400`ms（`RegistryContext.js:46`），应用必须自建并显式传入 registry，否则 5/10 分钟保留不成立。
- 在线重连刷新可用 `Atom.makeRefreshOnSignal`（Atom.d.ts:1368）或自定义 online atom，文档未点名。
- `AtomHttpApi.query` 的 `timeToLive` 只映射 idle TTL，没有 staleTime（`AtomHttpApi.d.ts:50-58` 选项声明；实现位于同包源码的 query 构造）。

**建议**：在 §7 增加“资源工具契约”小节，至少写明：
1. freshness 判定与“挂载/导航时刷新”由自定义 resource helper 完成（读 `AsyncResult.Success.timestamp`，超时则 `registry.refresh`，约 15–30 行，含单飞/等待者守卫与失败保留旧值）；明确禁止依赖 `swr` 的 mount 语义。
2. Registry 由组合根创建，显式配置 `defaultIdleTTL`（如 300s），并按资源用 `setIdleTTL` 覆盖 5/10 分钟；不得使用 `RegistryProvider` 的默认 400ms registry。
3. 在线重连刷新使用独立 online signal atom + `makeRefreshOnSignal`；窗口聚焦刷新保持关闭。
4. 在验收中增加“idle TTL 保留期内重挂载是否刷新”的测试（当前无此行为）。

### P1-2 §9：缺少 XState 与 Effect 的集成契约（生命周期/投影/写入顺序）

**问题**：§9 决定保留 XState 作为命令业务状态唯一所有者，但未定义 actor 在 Effect 作用域中的创建/释放、订阅顺序、投影 atom 桥接与单写入者规则。当前 adapter 是同步类，Effect 尚未接管。

**证据**：
- 已安装 xstate 6.0.0-alpha.70 API 与仓库匹配：`setup/types/createMachine`、`createActor/getSnapshot/subscribe/send/start/stop`；xstate 仅被 `WT/web_app/src/runtime/commands/equipmentCommand.machine.ts` 与 `XStateCommandWorkflowAdapter.ts` 导入，边界声明正确。
- `actor.subscribe` 不会立即回放当前 snapshot（xstate 运行时实现），若不先 start 或先 getSnapshot 播种，投影会丢首帧。
- 当前 adapter 直接同步 `send`，无 Effect 串行化；§9 只说“Effect 负责执行/恢复”，没有说明并发结果如何进入单写入者的 actor。
- §5/§9 只说“Atom 仅暴露投影”，未定义 actor→atom 的桥接与退订。

**建议**：在 §9 增加集成契约：
1. 每个 command 的 actor 由 `Effect.acquireRelease` 在所属 FAB scope 创建/停止；adapter 是唯一 `send` 入口。
2. 先 `subscribe` 再 `start`（或先 `getSnapshot` 播种），projection 用 writable atom/可观察投影桥接，actor stop 时退订并失效 projection。
3. 命令提交/事件/核对结果统一经有界队列串行化进入 adapter；并发上限与单飞规则在此层实现。
4. 增加 dispose/替换/StrictMode 重挂的 actor 泄漏测试；在 Task 4 报告确切桥接 API。

### P1-3 §12：文档更新范围遗漏关键活跃文档

**问题**：§12:180 列出 8 份文档/ADR，但多份当前活跃文档会直接失真，且有两份已经失真（Task 1 已把 Zod 解码改成 Effect Schema，但文档仍写 Zod/Query）。

**证据**（工作树内）：
- `WT/docs/realtime-protocol.md:172` 仍写“Query 唯一缓存”，:173 写“MessageDecoder（Zod envelope）”（已不成立），:174 写 RxJS Observable 类型化流；这是核心 ownership 文档。
- `WT/docs/rendering.md:7,29`（遥测 SSE→Worker 所有权、`state/runtimeStore.ts` 生命周期）；`WT/docs/IMPLEMENTATION-STATUS.md:23-27`（技术栈表仍是 Query/Zustand/RxJS+Zod）；`WT/docs/modules/M11.md:14`（Query + 7 个 Zustand store）、`M12.md:14`；`WT/docs/standards/SFN-WEB-REVIEW-STD-001.md:102,122,172-178,494`（评审标准仍要求 Query/Zustand 所有权）；`WT/README.md` 技术栈段；`WT/scripts/README.md:56,62`（路由生成门禁说明）。
- 另外 P0-1 的 `tools/check_architecture.py` 与 `global.json` 也属于“迁移后必须同步的活跃资产”，应在 §12/计划 Task 6 点名。

**建议**：把上述文档全部列入 §12 与 Task 6；对确属历史记录的 ADR（如 ADR-0008）明确标注“历史”并说明其不再生效。ADR-0009/0010 的“生效关系”需分别处理：0009 的 Query 边界被取代，0010 的 bridge 契约保留但实现改为 Effect Stream。

### P1-4 §13.2 / §13.9：固定 pnpm 12.15.0 的预置风险未说明

**问题**：`verify.ps1` 依赖固定版本 pnpm 12.15.0，但当前环境下的自动查找路径找不到可用副本，可能使 §13.2/§13.9 在无网络或 shim 异常时失败。

**证据**：`scripts/verify.ps1:40-57` 只搜索 `web_app/node_modules/pnpm/bin/pnpm.mjs` 与全局 `pnpm.cmd` 同目录候选；WT 中前者不存在，全局 pnpm 为 12.16.1（被版本检查拒绝），`npx --yes pnpm@12.15.0` 是唯一回退且依赖网络；npx 缓存中虽有可用的 12.15.0（`%LOCALAPPDATA%\npm-cache\_npx\bcfc56e7126ead17\node_modules\pnpm\bin\pnpm.mjs`），但脚本不搜索该路径。

**建议**：在 §13.2 前明确写“pinned pnpm 预置方式/绝对路径或环境变量”，或扩展 verify.ps1 候选搜索到 npx 缓存；同时注明干净目录 frozen-lockfile 安装需要网络。把该要求纳入 Task 6。

### P1-5 §9/§10：若干“保留”声明实为新增行为，未在计划/验收中标注

**问题**：以下行为当前不存在，文档以现状/保留口气描述，计划与验收未逐项覆盖：

| 位置 | 声明 | 当前实际 |
|---|---|---|
| §9:146 | “每个 FAB 的权威核对并发上限为 4” | `WT/web_app/src/runtime/FabRuntime.ts:214-227` 使用无界 `Promise.all`；现有文档只说“有限并发（具体值 M3 冻结）” |
| §9:148 | 容量驱逐诊断 + 触发核对 | 见 P0-3 |
| §10:156 | 命令流带 `transport-failure` 标签 | `WT/web_app/src/application/contracts/CommandEvents.ts:34-44` 只有 commandResult$/可选 reconnected$/gaps$；`SseCommandEventSource.ts:114-117` 吞掉 onerror |
| §10:160 | 命令数据缓冲容量 256 | 当前无命令数据 buffer；唯一 256 是 §9 pending 队列总容量（`CommandEventRecovery.ts:43`），两个 256 混用易歧义 |
| §7:118 | sites 只对网络/可重试 HTTP 故障重试 1 次 | 当前是全局 Query `retry: 1`（`queryClient.ts:11`），decode/身份错误同样重试；无 error-type 谓词 |
| §9:150 | 提交绑定 commandId/Site/FAB/ScopeToken | 设备命令幂等键绑定 `[siteId,fabId,equipmentId,action]`（`use-command-console.ts:109-112`），ScopeToken 只用于 Run 提交（`use-run-submission.ts`） |

**建议**：在 §9/§10 明确区分“保留（已核对）”与“新增（Task N 实现）”；将上表逐项落到 Task 4/5 的 RED 测试与 §13.5/§13.6 验收；把“命令数据缓冲 256”与“pending 队列 256”分别命名（如 stream buffer / pending replay queue）。

### P1-6 §11：路由测试替换会静默丢掉两条现有门禁

**问题**：§11:172 要求用代码路由测试替换 `route-tree-generation.test.ts`，但未说明需保留的两条现有断言，也未点名另一个会受影响的测试。

**证据**：
- `WT/web_app/tests/architecture/route-tree-generation.test.ts:104-128`：要求 `@tanstack/router-plugin`/`@tanstack/react-router` 精确版本 pin、installed==pin、锁文件只有一个 router-generator 解析；:130-141 要求 `@ts-nocheck` 仅限 routeTree.gen.ts。
- `@ts-nocheck` 没有其他门禁覆盖；R14 的 allowlist 条目（`WT/web_app/tests/architecture/architecture-contract-rules.test.ts:866-884`，其中 :868 指向 routeTree.gen.ts）在生成文件删除后会变成死条目。
- `WT/web_app/tests/integration/route-code-splitting.test.ts:22-27` 断言 vite.config 中的 `autoCodeSplitting: false`、“Route-code generation only”等字符串，插件移除后必须改，但 §11 未点名。

**建议**：在 §11 明确替换后的测试必须保留：(a) Router/相关工具版本的精确 pin 与锁文件唯一解析（可改为对 code router 版本的门禁）；(b) 全局 `@ts-nocheck` 扫描（生成文件中止后直接禁止）；(c) 更新 R14 allowlist；(d) 重写 `route-code-splitting.test.ts` 的 Vite 配置断言，并指出新断言目标。

### P1-7 §12：“禁止第二份资源缓存 / Effect runner 边界 / XState 边界 / 跨 FAB scope”缺少可执行门禁定义

**问题**：§12:182 将这些列为架构门禁，但没有定义检查工具/规则文件/负向 fixture；计划 Task 6 只新增依赖审计，没有对应 gate 实现。

**证据**：现有门禁为 `tools/check_architecture.py`（目录/依赖/分层）、`architecture-import-graph.test.ts`（R0–R6）、`architecture-contract-rules.test.ts`（R7–R14）；没有“第二资源缓存”或“Effect runner 边界”规则。`Effect.runPromise` 目前出现在组合根/UI 适配处（如 `RuntimeBootstrap.tsx:61-62`），迁移后需明确 allowlist。

**建议**：在 §12/计划 Task 6 给出可执行规则：XState 导入 allowlist（仅 workflow 边界）；`Effect.run*` allowlist（仅组合根/React 适配边界）；资源缓存单一所有者检查（如禁止在 src 内新建 cache registry/Map 快照模块，或仅允许指定 resource 模块）；跨 FAB scope 的负向测试归属。否则该条只能算评审清单，不能算门禁。

---

## 3. P2（建议修订）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| P2-1 | §2:37-39 | “阶段按模块所有权切换”列出的 6 阶段与 §12:178/计划 Task 1–6 的顺序不一致（如 Schema 在第⑤阶段，实际 Task 1；Runtime/Registry 排第①，实际分落在 Task 2/3） | 改为与计划一致的 6 个 Task 映射，或删除阶段列表只保留 §12 |
| P2-2 | §5:86 vs §7:112 | §5 说应用层拥有“资源缓存”服务，§7 说“仅在 AtomRegistry 中保存资源值和 AsyncResult”，措辞上可能被读成双缓存 | §5 改为“资源读取/失效策略服务（不持有快照）”；明确控制元数据（时间戳/水位）归属 |
| P2-3 | §13:198 | 路由错误边界/404/未知 FAB 行为当前无测试（测试中 grep `errorComponent`/`notFound` 为 0），验收也未列 | 加入 §13.7/§13.8 场景并补测试 |
| P2-4 | §13:205 | “记录包体、任务与连接数”没有测量工具/命令/产物；render_perf 记录 p95/p99/heap/ready/firstFrame/drawCalls/workerTargets/taskDuration，但不含包体和连接数 | 指定测量命令（build 产物大小、CDP targets/connections）与证据文件 |
| P2-5 | §9:150 | ScopeToken/commandId 的措辞混合了 Run 提交与设备命令两条链路（边界在 P1-5） | 分别描述两条链路的身份绑定，或明确这是新增统一要求 |
| P2-6 | §3:32 / §14:214 | “锁文件 Zod 来源仅为 router-plugin/generator”在分支 tip 成立，但基线 4fc8a94 中 zod 还是 web_app 直接依赖（Task 1 才移除）；另外安装后 zod 只在 `.pnpm` 虚拟店/hoistedDependencies，不在顶层 node_modules | 改为“Task 1 后仅剩传递来源”；给 §13.1 审计加注“扫描 virtual store 与 .modules.yaml hoistedDependencies” |
| P2-7 | §3:61 | 只说清理旧 Query 的 minimumReleaseAgeExclude；但 effect/@effect/atom-react 的例外是新增依赖所需的，必须保留 | 明确删除 Query 两行、保留 effect/atom-react 两行；说明 scheduler/xstate 不需要例外 |
| P2-8 | §3:49 | “scheduler ... 显式满足 Atom React peer”表述可更准确：peer 是范围 `>=0.25.0 <0.29.0`，锁文件唯一解析 0.28.0 | 改为“0.28.0 满足 peer 范围；与 react-dom 共用单一解析，不引入第二版本” |
| P2-9 | §5:84-94 / §7 | 只写“不得两份服务”，未点名“只构建一次”的机制 | 点名共享 `Layer.MemoMap` / `Atom.context({ memoMap })`（安装包中可用）与 registry.dispose 的 finalizer 语义，作为实现契约 |
| P2-10 | 头部:6 | “无重要未决设计问题”与本次审查结果不符 | 改为明确的开放项列表（P0-1..3），或在修订后更新为“已修订并复核”；文档应如实反映状态 |
| P2-11 | §11:172 | 现有路由组件有 3 处 `Route.useSearch() as RouterSearch`（equipment/index、compare、fabs/3d），与“类型化参数、无新 cast”目标不一致 | 在 Task 3 中改为推断类型（Register 已提供），或说明保留理由 |
| P2-12 | 全文 | 缺少“风险与回滚”小节：大爆炸迁移、无运行时特性开关，只有 worktree/分支级回滚 | 增加简短回滚策略（保持 main 基线可运行、按 Task 绿提交、最终验收前不合并）；说明这是刻意选择 |

---

## 4. 已核对通过的关键声明（建议保留，不要改）

| 声明 | 证据/结论 |
|---|---|
| 精确版本与锁文件一致 | effect 4.0.7、@effect/atom-react 4.0.7、scheduler 0.28.0（唯一解析，满足 atom-react peer `>=0.25.0 <0.29.0`，与 react-dom 共用）、xstate 6.0.0-alpha.70、react 19.3.1、@tanstack/react-router 1.170.46、TS 7.0.2、Node `>=26 <27`、pnpm 12.15.0；manifest==lockfile==installed，无漂移 |
| Router 运行库不含目标依赖 | 安装的 @tanstack/react-router dependencies 只有 react-store/isbot/history/router-core；zod/react-query 仅其 devDependencies；分支 tip 的 zod 仅由 router-generator 与 router-plugin 引入；移除两者可归零（zustand 在 WT 已为 0） |
| §7 数值与当前行为一致 | runs 列表/详情 1500ms、Results 完成后才启用（workbench.tsx:29,35-38）；设备状态 REST 4000ms + SSE 同一 gate（equipment.queries.ts:27-45；equipment-status-bridge.ts:92-99）；100ms 合批与 FAB 切换顺序（equipment-status-pipeline.tsx:39-59）；freshness/retention 数值与 Query 配置一致（queryClient.ts:10-12 等） |
| §9 保留策略数值/语义一致 | pending 32/256 且重复 revision 不增长（CommandEventRecovery.ts:42-43,56-61）；终态 64/300s、投影 128、sweep 15s（FabRuntime.ts:47-50）；六状态、revision 严格递增、终态不可变、单命令 reconcile 合并、每 FAB 单 lazy EventSource、SSE 先于 POST 的有界 pending 重放均已验证 |
| §10 遥测数值已验证 | 2s in-flight、250ms→8s 上限、单 in-flight + 槽位合并 pending、连接级序号重置、Worker 代际隔离均有代码与测试（TelemetryRuntime.ts 对应行；telemetry-runtime.test.ts） |
| §11 路由契约可保留 | 四个 URL 存在；routeTree.gen.ts 确有 @ts-nocheck 与 as any；defaultPreloadStaleTime 0；`/` 吞 sites 错误供 Workbench 重试、FAB 路由未知 FAB 抛错进 root errorComponent；官方 createRoute/createRootRouteWithContext/addChildren/Register/lazyRouteComponent 均在安装版本中存在；`validateSearch` 接受普通函数，Task 1 已用 Effect Schema 成功接入 |
| §12 所列文档确实存在 | architecture、state-management、router-query-integration、fab-runtime、command-event-bridge、command-reconciliation、equipment-status-ordering、ADR-0009/0010 均存在（但更新范围不全，见 P1-3） |
| §13 工具与基线存在 | verify.ps1、render_perf.mjs、telemetry_stress.mjs、dev/60hz profile、RQ-01..05 测试、4fc8a94 基线工具均存在；3 轮交替测量在 docs/perf 有先例（item 9 被 P0-1 阻断） |
| §14 引用与稳定性标注 | 5 个链接均 HTTP 200；Schema 模块 stable、reactivity 全模块 unstable，与“用户接受 unstable”一致 |
| §6/§9 细节声明 | Zod 生产导入已为 0；中断传播到真实 fetch（http.ts:104-118）；命令 404→Option；`useAtomSet` 重叠写入的 gotcha 已由安装包 Hooks 注记；技术叙述正确 |
| 保留 XState 的决定技术上自洽 | 已安装 6.0.0-alpha.70 API 与仓库代码匹配；仅 2 处导入，边界声明可实现（但需补 P1-2 契约） |

---

## 5. 建议的文档修订清单（可直接执行）

按优先级建议修改（§序号对应主工作树 spec 行号）：

1. **§12/§13 + 计划 Task 6**：加入 `tools/check_architecture.py`、`global.json`；说明 docs/superpowers 的现行定位与 legacy-path 断言调整；增加 .NET SDK/固定 pnpm 预置要求（P0-1、P1-4）。
2. **§13.8**：改为可执行浏览器验收（命令+场景表+判据+证据），或明确 manual checklist 格式；补路由错误/404（P0-2、P2-3）。
3. **§9:148**：删除/改写容量驱逐声明，作为新增要求写入 Task 4 与 §13.6，并同步 command-reconciliation/command-event-bridge 文档（P0-3）。
4. **§7**：增加资源工具契约（自定义 freshness helper、registry defaultIdleTTL/每资源 setIdleTTL、online signal、AtomHttpApi TTL 说明），补“保留期内重挂载刷新”验收（P1-1）。
5. **§9**：增加 XState–Effect 集成契约（actor 生命周期、subscribe/seed、projection atom、单写入者、串行化）（P1-2）。
6. **§12:180**：补全 realtime-protocol、rendering、IMPLEMENTATION-STATUS、modules/M11+M12、评审标准、README、scripts/README、ADR-0009/0010 生效关系（P1-3）。
7. **§9/§10**：把新增行为标为“新增”并补齐 Task 4/5 RED 测试与 §13.5/§13.6 验收；区分两个 256（P1-5）。
8. **§11:172**：写明替换测试必须保留依赖 pin 与 @ts-nocheck 扫描门禁；点名 route-code-splitting.test.ts 与 R14 allowlist（P1-6）。
9. **§12:182**：为“第二资源缓存/Effect runner/XState/跨 FAB”定义可执行门禁或降级为评审检查清单（P1-7）。
10. **§2/§5/§14/状态行**：按 P2 表修正措辞、阶段映射、scheduler 表述、状态行开放项；补风险与回滚小节（P2-1、P2-2、P2-8、P2-10、P2-12）。

修订后建议：只对修订 diff 做一次聚焦复核（设计/计划一致性 + 上述 P0 的可执行性），再继续 Task 3；不要把本次审查当作产品验收。

---

## 6. 审查边界

- 本次为**文档/代码静态审查**：未运行真实浏览器/GPU、未做干净目录 frozen-lockfile 安装、未修改产品代码或设计文档。
- Atom 的 remount/freshness 行为、XState subscribe 不回放、RegistryProvider 默认 400ms 由独立核查用安装包实测/声明核对；Lead 复核了其关键声明（Atom.d.ts 中 swr/setIdleTTL/makeRefreshOnSignal、RegistryContext.js:46、xstate 导入范围）。
- P0-1 的 `check_architecture.py` 失败与 .NET SDK 缺失已在本机复跑确认；§13.9 修复前不能视为可执行验收。
- 现有 Task 1/2 的提交证据（分支 `be1da31`，110 文件/689 测试、typecheck/build 通过）只说明局部迁移健康，不构成最终验收；Task 3 有未提交的测试草稿，不在本次文档审查范围内。
