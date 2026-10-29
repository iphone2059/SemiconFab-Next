# Round 2 / F5 evidence — resource commit, identity, capacity, poll generation (ADR-013, CR-05/07/09/10)

- 基线：`main@9ab2fd3f`（Round 2 审查基线）；本文件记录 F5（task-9）RED→GREEN 原始输出。
- 生效前工作树（Phase B 完成态，Round 2 F1 文档已冻结）；最终 SHA 由 Lead 绑定（pending）。
- 环境：Windows 11 / Node 26.12.1 / pnpm 12.16.1 / effect 4.0.7 / vitest 5.0.5
- 测试目录：`web_app/tests/correctness/resource/`

## 1. RED 基线（整改前实现，2026-10-30）

临时 RED 文件（随后删除，由正式矩阵测试替代；删除原因与替换映射见 §4）：
`web_app/tests/correctness/resource/round2-f5-red.test.ts`

命令：

```powershell
cd web_app
pnpm test -- tests/correctness/resource
```

原始输出（4 tests / 4 failed）：

```text
 ❯ tests/correctness/resource/round2-f5-red.test.ts (4 tests | 4 failed) 13ms
   × CR-05 RED: a delayed generic GET must not overwrite a newer mutation publish 9ms
   × CR-07 RED: a same-key definition with a different contract must throw instead of silently reusing the handle 2ms
   × CR-09 RED: the manager has a single 256 hard capacity (no unreachable 512 waterline) 1ms
   × CR-10 RED: the polling fork callback validates generation and scope identity before claiming the owner slot 1ms

 FAIL  CR-05 RED: a delayed generic GET must not overwrite a newer mutation publish
AssertionError: old GET must not overwrite the accepted mutation: expected 'get-old' to be 'mutation-new'
Expected: "mutation-new"
Received: "get-old"

 FAIL  CR-07 RED: a same-key definition with a different contract must throw instead of silently reusing the handle
AssertionError: heterogeneous definitions for one key must fail loudly: expected [Function] to throw an error

 FAIL  CR-09 RED: the manager has a single 256 hard capacity (no unreachable 512 waterline)
AssertionError: MAX_ENTRIES_HARD must be deleted (single 256 limit): expected 'import { Cause, Duration, Effect, Exi…' not to match /MAX_ENTRIES_HARD/

 FAIL  CR-10 RED: the polling fork callback validates generation and scope identity before claiming the owner slot
AssertionError: fork callback must capture the started scope generation: expected '...' to match /startedGeneration/
```

缺陷对照：

| ID | 旧实现观测 | ADR-013 决策 |
|---|---|---|
| CR-05 | 无 accept 的通用资源：GET-old 在 mutation-new 发布后仍写入 Atom（`value() === 'get-old'`） | baselineWriteSeq 变化时无 accept → Ignore('superseded-write') |
| CR-07 | 同 key 异构 policy 定义静默返回旧 handle（无异常） | identity(kind/version) + policy 冲突 → ResourceDefinitionConflictError |
| CR-09 | 源码存在 `MAX_ENTRIES_HARD = 512` 双水位（永远不可达） | 单一 `MAX_ENTRIES = 256` 硬限 |
| CR-10 | `startPolling` 的 fork 回调只检查 removed/polling，无 generation/scope 身份校验 | 捕获 scopeGeneration+scope，四项校验，不匹配 interrupt |

## 2. GREEN 结果（实现后，2026-10-30）

实现改动（ADR-013）：

1. `src/api/resource.ts`：新增 `ResourceIdentity { kind, version, key }` 与 `ResourceDefinitionConflictError`（字段 `key/existing/incoming/field`，field ∈ kind|version|key|policy）；`ResourceDefinition` 以 `identity` 取代裸 `key`。
2. `src/api/resource-manager.ts`：
   - `commitReadSuccess`：`baselineWriteSeq !== entry.writeSeq` 时，有 accept 交 accept（版本/epoch 语义自决），无 accept → `Ignore('superseded-write')`（CR-05）；失败路径保持 ADR-006 规则。
   - 条目保存 `identity`；`handle()` 命中同 key 时校验 kind/version/key 与 policy(freshnessMs/idleTtlMs/pollMs)，不一致抛 `ResourceDefinitionConflictError`；TTL 释放后重建合法（CR-07）。
   - 容量改为单一 `MAX_ENTRIES = 256` 硬限：先 idle-LRU 释放零订阅条目，仍无空间抛 `ResourceCapacityError`；删除 `MAX_ENTRIES_HARD`（CR-09）。
   - `stopPolling` 递增 `scopeGeneration`；`startPolling` 捕获 `scopeGeneration + scope`，fork 回调同时校验 removed/polling/generation/scope 身份，不匹配则 interrupt 且不写 `pollFiber`（CR-10）。
3. 全部 `*.resource.ts` 提供 identity：sites/catalog/runs/run-detail/run-results/equipment-status/research-events/wafer-routes（version 1）。

命令与原始输出：

```powershell
cd web_app
pnpm test -- tests/correctness/resource
```

```text
 ✓ tests/correctness/resource/cr-05-generic-commit.test.ts (5 tests)
 ✓ tests/correctness/resource/cr-07-identity.test.ts (5 tests)
 ✓ tests/correctness/resource/cr-09-capacity.test.ts (4 tests)
 ✓ tests/correctness/resource/cr-10-poll-generation.test.tsx (3 tests)
 Test Files  4 passed (4)
      Tests  17 passed (17)
```

矩阵覆盖：

| 矩阵/CR | 测试文件 | 关键断言 |
|---|---|---|
| 5 / CR-05 | `cr-05-generic-commit.test.ts` (5) | GET-old 不覆盖 mutation-new / recovery-new（`superseded-write` 诊断）；失败路径只诊断；设备 accept 保持 epoch/sequence 拒绝旧 REST（12 不回退）；双 Runtime 各自独立 |
| 7a / CR-07 | `cr-07-identity.test.ts` (5) | 兼容重定义返回同一 handle；同 key 不同 kind/version/policy 抛 ResourceDefinitionConflictError（field/key/existing/incoming 校验）；TTL 释放后同 key 换 kind 合法重建 |
| 7b / CR-09 | `cr-09-capacity.test.ts` (4) | 单一 256 硬限源码门禁（无 MAX_ENTRIES_HARD）；256 保留条目后第 257 个拒绝；零订阅 idle 条目被 LRU 驱逐释放槽位、被驱逐 key 可重入；3000 identity churn 有界且仅 ResourceCapacityError 可拒绝 |
| 7c / CR-10 | `cr-10-poll-generation.test.tsx` (3) | fork 回调四项校验 + release 递增 generation 源码门禁；1000 次 retain/release 交错 + 微任务让位后 polling≤1、最终单 owner 每 20ms 恰好 1 次 load（重复 loop 会 >1）、release/dispose 后 0 polling 且无新 load |

回归（Phase B CORE / 设备 / 路由 / twin / 架构；F5 收尾复跑，命令同工作目录）：

```text
 ✓ tests/core/core-001..006（13 tests）
 ✓ tests/api/resource.test.tsx (7) / sites-queries (7) / api-queries (7) / equipment-status-bridge (5)
 ✓ tests/integration/resource-cache (4) / router-resource (4) / equipment-status-pipeline (1) / equipment-status-scope-cycle (1) / twin-fab-scope (4)
 ✓ tests/realtime/equipment-status{,-epoch,-protocol} (4/5/9)
 ✓ tests/architecture/resource-ownership (6，新增 typed identity 门禁) / architecture-contract-rules (R14 含在 9 tests)
 ✓ tests/correctness/resource 矩阵 1/5/7a/7b/7c（17 tests）
 Test Files  24 passed (24)
      Tests  103 passed (103)
```

F5 范围的 typecheck 过滤结果：`0 error`（全仓 154 error 全部来自 F2/F4 并行编辑中的文件；F5 相关文件 0）。

静态门禁：

```text
pnpm lint  -> Found 0 warnings and 0 errors (209 files, 88 rules)
pnpm typecheck -> 本轮改动文件 0 error（并行阶段 F2/F4 的 tests/correctness/sse 等文件仍在其 owner 编辑中，见 §4）
```

## 3. 工作树全量快照与归属（F5 完成时点）

F5 完成时工作树同时包含 Round 2 其他阶段（F2 SSE/恢复、F4 gateway 取消）的进行中修改。全量 `pnpm test` 快照：

```text
 Test Files  5 failed | 145 passed (150)
      Tests  16 failed | 812 passed (828)
```

失败文件与归属（均非 F5 范围）：

| 失败文件 | 归属 | 现象 |
|---|---|---|
| `tests/correctness/sse/matrix-1-three-cursor.test.ts` | F2 | 三游标/dirty gap 进行中 |
| `tests/correctness/sse/matrix-2-journal-pagination.test.ts` | F2 | 多页 epoch journal 进行中 |
| `tests/correctness/sse/matrix-6-recovery-state.test.ts` | F2 | 恢复状态机进行中 |
| `tests/correctness/gateway/red-baseline.test.ts` | F4 | gateway 物理取消 baseline RED（进行中） |
| `tests/architecture/architecture-contract-rules.test.ts` | F5 自身→已修复 | R14 命中 `api/resource-manager.ts:425` 的 `as unknown as`；已改为传 `identity/policy` 值（无 cast），复跑 R14 绿 |

F5 完成后复跑 `R14`（含在我范围的 24 文件复跑中）：`✓ tests/architecture/architecture-contract-rules.test.ts (9 tests)`。

全量绿由 Lead 在 F2/F4 落地后复跑（pending）。最终 SHA 由 Lead 绑定。

## 4. 限制与说明

- RED 的 CR-09/CR-10 是源码不变量门禁（旧实现中双水位/缺 generation 校验不是运行时可通过公共 API 触发的可观测失败），按矩阵规则以“旧测试覆盖缺口 + 源码门禁 RED”作为 RED 证据；GREEN 侧同时增加了运行时行为断言（256 边界/LRU 重入、1000 次交错后每周期仅 1 次 poll）。
- `ResourceDefinition` 从 `key` 迁移到 `identity` 是 ADR-013 冻结接口的直接落地；本轮同步更新了所有资源定义文件、manager、tests/api 与 Phase B 测试中的定义构造。公共 handle 仍暴露 canonical `handle.key`。
- 未对真实后端/浏览器重跑设备 SSE/REST；F5 的设备 epoch/sequence 回归使用受控 fetch（与 Phase B 相同方式）。
- 未验证 V8 heap snapshot（同 Phase B 限制）；容量/节点/轮询有界性通过 manager.stats 与 registry.getNodes 断言。