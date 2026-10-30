# Round 5.2 — 验证证据（绑定 commit `a7ef24b`）

**轮次：** Round 5.2（Round 5.1 独立复审未通过项的定向修复）。
**整改基线：** `919b6d15d2f765784cbbbddd5158572eca4e7977`（Round 5.1 证据提交）。
**被验证 commit：** `a7ef24b37086d938db4e1198ed3d0c2a9590eb1e`。
**规范：** [20-round5.2-remediation-specification.md](../architecture/20-round5.2-remediation-specification.md)。
**验证时间：** 2026-10-30 15:53–16:08（Asia/Singapore）；Node `v26.12.1`、pnpm `12.15.0`、.NET SDK `11.0.100-rc.3`、Chrome `155.0.8059.86`。

## 1. 完整门禁（scripts/verify.ps1）

在 `a7ef24b` 上执行完整 `scripts/verify.ps1`：**退出码 0**。[final-verify.json](final-verify.json) 的 `commit` 为 `a7ef24b...`。

| 门禁 | 结果 |
|---|---|
| 契约 / 生成物 / 架构 / frozen-assets / Python tools | PASS |
| start-dev 自检与端口/进程清理 | PASS |
| .NET Release build（3 项目） | PASS（0 warning / 0 error） |
| .NET 全量测试 | PASS（226/226） |
| pnpm install --frozen-lockfile | PASS |
| TypeScript typecheck | PASS（0 error） |
| oxlint（React Compiler correctness） | PASS（0 warning / 0 error，211 文件） |
| Vitest 全量 | PASS（157 文件 / 1004 测试） |
| Vite production build | PASS |
| compiler-compat | PASS |
| Production browser e2e | **PASS 9/9**（[production-e2e.json](browser/production-e2e.json) `commit=a7ef24b`） |
| CORE-011 ON/OFF 等价（独立双后端） | **PASS**：`equal=true`、`differences=0`、`scenarioFailures=0`、`sideEffects.equal=true`、`quiescence.timeouts=0`（[equivalence-trace.json](compiler/equivalence-trace.json) `commit=a7ef24b`） |

CORE-011 的 `apiUrl.on=http://127.0.0.1:5191`、`apiUrl.off=http://127.0.0.1:5192` 不同；两个后端使用独立 `Fab__DataDirectory`，运行前重置为同一开发 fixture，`fixtures.identical=true`；ON/OFF 的持久化副作用一致（1 条 `{revision:2,outcome:succeeded,terminal:true}` 命令、0 条 active 命令、1 条 COMPLETED run）。

## 2. 本轮新增/加强的测试

| 层 | 覆盖 |
|---|---|
| `tests/contract/command-correlation.test.ts` | 有界 per-revision outcome 历史；旧 revision 同 outcome = `stale`、不同 outcome = `conflict`、无记录 = `stale-unverified`；applied identity = `(revision,outcome)`；权威修正使旧 applied 证明失效并由 `markApplied` 返回 false/true；历史剪枝后保守降级 |
| `tests/integration/command-event-bridge.test.ts` | 旧 revision outcome 冲突不 ACK、不改 Actor；`stale-unverified` 不 ACK 且触发 `onUnverified`；权威记录 `supersede` 覆盖已投递 SSE 帧（covered，非 applied）；纠正后的 outcome 在 Actor 重新证明前重复帧不 ACK |
| `tests/correctness/sse/matrix-1-ordered-ack-ledger.test.ts`（真实 Transport） | ledger 身份含 outcome：`acknowledge(rev3 failed)` 不会标记 `rev3 accepted` 帧 applied；`supersede` 后位置 covered 且 acknowledged 推进；精确 identity 的 ACK 仍正常 |
| `tests/core/core-011-compiler-equivalence.test.ts` | 冻结新 harness 契约：独立双后端参数、fixture 一致性、quiescence、请求计数、sideEffects 比较；wrapper 双端口/双数据目录/共享 key/端口释放 |
| `tools/compiler_equivalence.mjs` + `scripts/compiler-equivalence.ps1` | 独立后端 + 相同 seeded fixture + 900ms 语义静止屏障 + method/path/count 比较 + 权威副作用多集比较（详见报告 `comparisonNotes`/`limitations`） |

## 3. 复审项闭环对照

| 复审项 | 状态 | 证据 |
|---|---|---|
| P1-01 旧 revision outcome 冲突绕过检测并被 ACK | **已修复** | outcome 历史 + `stale-unverified` + `provesApplied` 门控 ACK；新增测试 |
| P1-02 authoritative 修正后旧 appliedRevision 被当成新 outcome 已应用 | **已修复** | `appliedOutcome` + 修正时证明失效回退 + `hasUnappliedObservation` identity 比较；新增测试 |
| P1-03 ACK Ledger 身份缺 outcome、权威纠正错误确认 SSE | **已修复** | 完整身份 + `supersede`（covered，非 applied）+ 真实 Transport 测试 |
| P2-01 CORE-011 ON/OFF 共用可变后端 | **已修复** | 独立 API/DB + 相同 seed + quiescence + 请求计数 + sideEffects；完整门禁 PASS |
| P2-02 三游标数学不变量与实现矛盾 | **已修复（文档/契约）** | ADR-010 §9.2、`command-events.contract.ts`、19 号文档交叉引用；测试行为保持不变 |

## 4. 归一化与残余风险（如实记录）

1. **实时 FDC/SPC 状态归一化**：独立双后端下，同一 wall-clock 窗口可能合法观察到 `IN SPEC` / `OUT OF SPEC` 等实时控制状态差异。比较时把 `(IN|OUT OF) (SPEC|CONTROL)` 归一化为 `<control-status>`（与既有数字归一化同类），并在 `comparisonNotes/limitations` 中记录。HTTP 请求路径/计数、持久化 side effects、命令/run 终态与全部结构文本仍严格比较；**未扩大 poll-only 忽略列表**。
2. 静止屏障超时（`report.quiescence.timeouts`）会计入报告告警但按设计不直接使 `equal=false`；本轮完整门禁与两次 standalone 运行均为 0 timeout。
3. 旧 revision 的 outcome 历史有界（32）：超出窗口的旧 revision 冲突保守降级为 `stale-unverified`，以额外权威恢复换正确性。
4. `--reuse-trace` 为离线重比较路径，不能证明双后端隔离（报告中标记 LEGACY）。
5. 后端未修改；.NET 构建/测试为回归门禁。Phase C 的真实浏览器故障注入仍以集成/正确性测试覆盖（与 Round 5.1 的边界一致）。
