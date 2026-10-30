# Round 5.2 — 命令协议证明链与 CORE-011 验证环境修复

**文档性质：** Round 5.2 定向整改规范与记录（Round 5.1 独立复审的未通过项响应）。不是新架构轮次，不改变 Reservation / Scheduler / Scope / FAB 隔离设计。
**Repository：** `iphone2059/SemiconFab-Next`，分支 `main`。
**整改基线：** `919b6d15d2f765784cbbbddd5158572eca4e7977`（Round 5.1 验证证据提交；源码提交 `96b33d0`）。
**上一轮规范：** [19-round5.1-remediation-specification.md](19-round5.1-remediation-specification.md)。
**输入：** Round 5.1 独立复审报告（2026-10-30）：3 项 P1 + 2 项 P2，判定「暂不通过」。
**日期：** 2026-10-30。

> 本文档只覆盖复审中可由源码确认的缺口；Round 5.1 已确认正确、复审未要求重构的部分保持冻结。
> 本文档取代 Round 5.1 文档中与以下五项冲突的表述：§2.4 三游标数学表述、Correlation applied 证明、
> Transport ACK 身份、CORE-011 实验条件、旧 revision 去重语义。

## 0. 复审结论与整改边界

复审确认 Round 5.1 的主体整改（Recovery 双屏障、Conflict 处理、XState 来源隔离、Cover 不修改 delivered、按需 Command SSE、独立 TTL）已经落地；失败点是 **Correlation / Actor / ACK Ledger 之间的证明链没有把 outcome 纳入身份**，以及 **CORE-011 的 ON/OFF 对照实验共用了同一个可变后端**。

本轮不修改：Admission Reservation、Accepted Registration、Scheduler waiter 所有权、PhysicalRequestBudget、Scope 树、Recovery generation/fiber interruption、每 FAB 独立 Runtime/Workflow/Transport。

## 1. P1-01 — 旧 revision 的 outcome 冲突不得绕过检测并被 ACK

### 复现路径（复审给出）

1. `rev1 accepted` 已观察并应用；
2. `rev2 executing` 已观察并应用；
3. 迟到异常帧 `rev1 failed`。

Round 5.1 的 `observe()` 对低于最高 revision 的事件直接返回 `stale`；Bridge 只检查 `appliedRevision >= revision` 就 `acknowledge`。于是旧 revision 的 outcome 冲突被当作无害重复确认，违反「同一 revision 只能有一个 outcome」。

### 整改

- `CommandCorrelationRegistry` 为每条命令维护**有界 per-revision outcome 历史**（`MAX_RETAINED_REVISION_OUTCOMES = 32`，smallest-first 剪枝；当前 revision 永不剪枝）。
- `observe()` 对旧 revision：无记录 → `stale-unverified`；记录匹配 → `stale`；记录不同 → `conflict`。冲突不得修改已记录 outcome。
- `CorrelationDecision` 新增 `stale-unverified`；Bridge 新增 `CommandDeliveryOutcome 'stale-unverified'` 与 `onUnverified` 回调。
- Bridge 对 `stale-unverified`：**绝不 ACK、绝不当作重复事件忽略**，通知 Runtime 进入权威 List 恢复；Runtime `onBridgeUnverified` 合并 list-only 请求并按既有有界补偿状态机收敛。
- 只有 `provesApplied(event)` 为真（见 P1-02）的 duplicate/stale 才允许 `source.acknowledge(event)`。
- 剪枝导致旧 revision 无法验证时，保守降级为 `stale-unverified`，绝不产生 false applied proof。

### 验收测试

- `rev1 accepted → rev2 executing → rev1 failed`：第三个事件返回 `conflict`，不 ACK、不修改 Actor 投影、conflict 参与 `pendingCount`。
- 旧 revision 未记录：返回 `stale-unverified`，不 ACK，`onUnverified` 触发权威恢复。
- 旧 revision 记录匹配：`stale` 且 `provesApplied` 为真时才 ACK。
- 有界历史剪枝后旧 revision → `stale-unverified`。

## 2. P1-02 — applied 证明必须绑定 (revision, outcome)

### 复现路径（复审给出）

`rev3 accepted` 已应用 → 权威把 rev3 修正为 `failed`；Round 5.1 的 `correctOutcome()` 原样继承 `appliedRevision = 3`，于是 `hasUnappliedObservation()` 错误返回 false，后续同 revision `failed` 的 SSE 可能被判定为 `duplicate-applied` 并 ACK。

### 整改

- `CorrelationEntry` 新增 `appliedOutcome`；应用证明是 `AppliedIdentity = (appliedRevision, appliedOutcome)`。
- `markApplied(event)` 返回 `boolean`：只有记录 outcome 与 event 一致时才可能推进；同 revision 的 correction 只有在 Actor 重新投影成功后重新建立 `appliedOutcome`；旧 revision 不会推进 watermark。
- 权威同 revision 修正 outcome 且旧 `appliedRevision === revision` 时，**旧证明失效**：watermark 保守回退到 `revision-1`（`revision=0` 时为 undefined），`appliedOutcome` 清空；必须由权威重投递 + Actor projection 重新证明。
- `hasUnappliedObservation()` 比较当前 observed identity 与 applied identity；同 revision 下 `appliedOutcome !== outcome` 即为未应用。
- `provesApplied(event)`：同 `(revision, outcome)` 的 applied identity，或「applied watermark 更高且该旧 revision 的有界 outcome 历史匹配」。Bridge 的 delivery signal 与 ACK 都以它/markApplied 的返回值为门。
- 权威通道应用成功不再通过 `acknowledge()` 冒充 SSE 应用，见 P1-03。

### 验收测试

- 权威修正成功记录到 Correlation 但 Actor 尚未/未能应用：`provesApplied(corrected)` 为 false、`hasUnappliedObservation` 为 true、重复帧不 ACK。
- 权威修正后 Actor 重新应用：`markApplied` 返回 true、证明恢复、重复帧才可覆盖/ACK。
- `markApplied` 对不一致 outcome / 旧 revision 返回 false，watermark 不推进。

## 3. P1-03 — ACK Ledger 完整业务身份与权威 Supersede

### 复现路径（复审给出）

Transport 的 ledger 身份只有 `(fabId, commandId, revision)`；Bridge 的 `applyToWorkflow()` 无条件 `markApplied` + `acknowledge`。于是权威把 `rev3 accepted` 纠正为 `rev3 failed` 后，`acknowledge(rev3 failed)` 会命中原始 `rev3 accepted` 的 ledger 条目并标记 applied——把「权威覆盖」伪装成「SSE 应用」。

### 整改

- `AckLedgerEntry` 与 `eventIdentity` 加入 `outcome`：身份为 `(fabId, commandId, revision, outcome)`；`acknowledge(event)` 仅对同 identity 的 pending 条目生效。
- `CommandEventSource` 新增必选 `supersede(event)`：权威结果纠正/确认某 command revision 后，Transport 将同 `(fabId, commandId, revision)` 的 delivered-pending 条目标记为 `covered`（**绝不 applied**），并按连续前缀推进 acknowledged；未知位置 no-op。
- Bridge `applyToWorkflow()`：
  - 仅当 `markApplied(event)` 为 true（或旧 revision 有 `provesApplied`）才发送 `onResultDelivered` / ACK；
  - `source.acknowledge()` 只在 realtime 通道调用；
  - 权威通道应用成功后调用 `source.supersede(event)` 并清理已被权威解决的 Conflict。
- FakeCommandEventSource 与 Pending source 同步实现：Fake 的 acknowledge 比对 outcome、supersede 标记 covered；Pending source 的 supersede 为显式 no-op。
- 不改变有序 ledger、Cover latch、PhysicalRequestBudget。

### 验收测试（必须直接使用真实 Transport）

- 真实 Transport 收到 `rev3 accepted` pending；`acknowledge(rev3 failed)` 不改变 pending/acknowledged。
- `supersede(rev3 failed)` 后该位置为 covered、acknowledged 推进到该位置，且从未计入 applied。
- Bridge 用真实契约语义：realtime 被 Actor 拒绝的帧由权威记录 `supersede`（covered），不 ACK。
- 修正后的 outcome 在 Actor 重新证明前，重复帧不 ACK。

## 4. P2-01 — CORE-011 ON/OFF 对照实验隔离

### 问题

`scripts/compiler-equivalence.ps1` 只启动一套 API；`tools/compiler_equivalence.mjs` 的 ON/OFF 两个生产包代理到同一 `apiUrl`（证据 `equivalence-trace.json` 中 `apiUrl.on === apiUrl.off`）。两个模式顺序执行且会真实写入命令/运行记录；注入确定性 UUID 也不能阻止 OFF 看到 ON 已创建的命令/幂等记录。并且 `apiSurface()` 用 Set 比较路径集合、采样窗口无静止屏障，因此此前 ON 多出一条 `GET /api/v1/commands/{id}` 不能被归因于 React Compiler。

### 整改

- ON 与 OFF 各启动**独立后端进程 + 独立数据目录/数据库**（独立端口），每次运行前重建数据目录并从相同的开发 fixture 初始快照启动。
- 两个后端共享同一个 development key（脚本生成/复制到各自 LocalDirectory）；不等价则 CORE-011 直接失败。
- `tools/compiler_equivalence.mjs`：
  - 采样前加入确定性 quiescence 屏障（请求集合与 DOM 文本在连续 quiet 窗口内稳定 + 双 rAF）；
  - HTTP 快照从 path Set 升级为带 `method/path/count` 的请求集合，按 scenario/step 归属；
  - 每个 mode 跑完后独立拉取并比较权威副作用轨迹（sites 身份、commands 终态多重集、runs 状态多重集），不一致计入 differences；
  - 报告记录 `apiUrl {on, off}`、独立后端身份、build hashes、traces、sideEffects、differences、scenarioFailures。
- 不把 `/api/v1/commands/{id}` 加入忽略列表；不扩大 poll-only 忽略范围。

### 验收测试

- `scripts/compiler-equivalence.ps1` 连续两次运行退出 0、`equal: true`、`differences: 0`、`apiUrl.on != apiUrl.off`、`sideEffects.equal: true`、两侧 fixture/命令终态一致，运行后无端口/进程残留。
- 人为制造 semantic difference 时（如改变某 build 的响应路径集合）harness 必须以非零退出并记录具体 scenario/step。

## 5. P2-02 — 三游标数学契约修正

Round 5.1 文档/契约写的同 epoch 不变量 `acknowledged <= delivered <= observed` 与正确实现矛盾（List Cover 可以把 acknowledged 推进到从未投递的位置，合法出现 `observed=9 / delivered=3 / acknowledged=9`）。本轮修正为条件化表达：

- 始终：`delivered <= observed`；每个游标同 epoch 单调。
- 无权威 Cover 超前推进时：`acknowledged <= delivered <= observed`。
- 存在已证明的权威 Cover 时：acknowledged 可由连续 applied|covered 前缀或权威 Cover 推进，**允许超过 delivered**；delivered 仍只由真实 SSE 投递推进。
- 不同 epoch 的 sequence 不可比较。

同步修改：`command-events.contract.ts` 的 cover/cursor 文档、ADR-010 §9.2、`19-round5.1-remediation-specification.md` 的交叉引用、matrix-1 测试注释。保留已正确的测试行为，不修改实现来迁就旧公式。

## 6. 冻结与禁止

- 不修改 Reservation / Scheduler / Scope / FAB Registry 的核心设计。
- 不为旧 revision 冲突增加无限历史：outcome 历史上限 32，剪枝必须保守降级为 `stale-unverified`。
- 不用 `acknowledge()` 模拟权威覆盖；权威覆盖必须走 `supersede()`。
- 不放宽 Healthy/ACK/expired 判定、不扩大 CORE-011 忽略列表、不以共享后端/固定 sleep 掩盖实验差异。
- 不引入兼容层、双轨实现或第二套 Recovery/Transport。

## 7. 验收

### Phase A：静态正确性

- correlation outcome 历史、applied identity、stale-unverified、provesApplied、markApplied boolean；
- Bridge 的 ACK/onResultDelivered 门控与权威 supersede；
- Transport ledger 完整身份 + supersede；
- CORE-011 独立双后端 + quiescence + 请求计数 + 副作用比较；
- ADR-010/contract/19 号文档的数学契约修正。

### Phase B：自动化验证

| 验证 | 要求 |
|---|---|
| TypeScript typecheck | PASS |
| oxlint | PASS |
| 相关 contract / integration / SSE correctness / realtime 测试 | PASS（含本轮新增矩阵） |
| Vitest 全量 | PASS |
| Vite production build | PASS |
| 架构边界测试 | PASS |
| CORE-011（双后端） | PASS：equal=true、differences=0、sideEffects.equal=true |
| .NET Release build | PASS |
| .NET 全量测试 | PASS |

### Phase C：真实运行时

- 真实浏览器 + 独立双后端执行 CORE-011；
- 生产包 e2e 9 场景（沿用 Round 5.1 脚本）在 Round 5.2 提交上复跑并通过；
- 如有条件，注入“旧 revision 冲突 / 权威 outcome 修正 / 迟到 SSE”场景到真实 Transport 集成路径（本轮已由真实 Transport 测试覆盖 identity 层）。

## 8. 残余风险

1. CORE-011 的浏览器采样仍受真实 wall-clock 影响；本轮用独立后端 + quiescence + 计数 + 副作用轨迹降低混杂，但不能证明所有并发交错。
2. `supersede` 只能覆盖 Transport 已登记 ledger 的位置；若权威结果到达时对应 SSE 帧尚未投递/登记，则不需要覆盖，后续真实投递按正常路径处理。
3. 旧 revision 的 outcome 历史有界（32）：超出窗口的旧 revision 冲突将保守降级为 `stale-unverified`，以额外权威恢复换正确性。
4. 本轮不改后端；.NET 仅回归门禁。
