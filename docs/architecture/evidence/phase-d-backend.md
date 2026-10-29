# Phase D 证据：后端持久命令恢复（ADR-008）

- 状态：实现完成，后端门禁全部执行；前端全量 typecheck 由其他 phase 在途文件阻塞（本 phase 新文件未被报错，见 §7）。
- 阶段：Phase D（task-3）
- 基线提交：`1fb25ff`（Phase A 文档提交 `9dc793f`）
- 本步工作树 SHA：**pending**（由 Lead 在提交后绑定；本文件不手写 PASS，只引用可重跑命令与原始输出）
- 环境：Windows 11；.NET SDK 11.0.100-rc.3；Node 26.12.1 / pnpm 12.16.1；Python（`python` 在 PATH）

## 1. 交付范围

| 类别 | 文件 |
| --- | --- |
| 新增存储抽象/实现 | `fab_app/src/CommandStore.cs`、`fab_app/src/FileCommandStore.cs` |
| 集成/端点 | `fab_app/src/EquipmentCommandService.cs`（重写持久化集成）、`fab_app/src/ApiHost.cs`（DI、fail-fast、2 个新 GET、SSE dirty、503 映射） |
| 契约 | `contracts/json-schema/contracts.schema.json`、`contracts/openapi/openapi.json`（生成）、`contracts/json-schema/README.md`、`contracts/openapi/README.md` |
| 生成器/生成物 | `tools/generate_contracts.py`、`fab_shared/src/Generated/Contracts.g.cs`（生成）、`web_app/src/generated/contracts.generated.ts`（生成）、`tools/generated-artifacts.json`（经 Lead 授权的 `--update`） |
| 前端 schema（仅新增两个文件） | `web_app/src/api/command-recovery.schema.ts`、`web_app/tests/api/command-recovery-schema.test.ts` |
| 后端测试 | 新增 `fab_tests/src/CommandPersistenceTests.cs`（12）、`fab_tests/src/CommandRecoveryApiTests.cs`（5）、`fab_tests/src/TestDataDirectory.cs`；既有 `CommandApiTests.cs`/`CommandJournalTests.cs`/`CommandRetentionTests.cs` 仅做构造注入与 `GetJournalEpoch` 适配 + dirty 帧断言 |

不涉及（按任务禁止改）：`web_app` 其他文件、`runtime/**`、`scripts/**`、`.github/**`、`package.json`/`lock`。

## 2. 持久化存储与恢复设计（实现即证据）

目录：`Fab:DataDirectory/commands/<siteId:D>/`

- `epoch.json`：`{epoch, createdAt, firstRetainedSequence, latestSequence, journalLastSequence}`，原子写（tmp + `Flush(flushToDisk:true)` + rename）。
- `journal/<epoch:D>.jsonl`：append-only，一行一个事件；每次 append 后 `FileStream.Flush(flushToDisk: true)` 才更新 epoch 并允许提交对外确认。
- `commands/<commandId:D>.json`：权威记录，含 `events[]` 自有历史（用于 record→journal 的 outbox 修复），原子写。
- `idempotency/<sha256 前 2 位>/<sha256(scope)>.json`：scope = sha256("command-idempotency-v1\n" + siteId + fabId + principal + key)；条目携带首次 accepted 快照，重启后 replay 返回同一 commandId/revision/outcome/occurredAt。
- 每 site 一个 `SemaphoreSlim(1,1)`（store 内）+ service 内 per-site 锁，保证 sequence 单调、append 顺序与内存/磁盘一致。
- 提交顺序（accepted）：写 record → 写 idempotency → append journal(+fsync) → 原子写 epoch；崩溃窗口由恢复的 outbox 语义修复。
- 恢复协议（启动时对每个配置 Site 同步执行，失败即启动失败）：
  1. 读 epoch.json；缺失/损坏 → 新 epoch。
  2. 读 journal 当前 epoch 文件；缺失/JSON 损坏/尾部截断（`journalLastSequence` 大于文件末行）/sequence 非递增 → 新 epoch（旧 cursor 全部 gap），诊断写入 `RecoveryDiagnostics`。
  3. journal 比 epoch 新（崩溃在 journal 落盘后、epoch 写前）→ 修复 `latestSequence/journalLastSequence`，同 epoch 继续。
  4. 记录自 `events[]` 中 sequence > journal 末行（崩溃在 record 写后、journal append 前）→ 追加 journal（outbox），诊断 `journal-repaired-from-records`。
  5. journal 中有事件但记录缺失 → 由 journal 重建权威记录（诊断 `record-rebuilt-from-journal`）；记录比 journal 新 → 由 journal 补记录。
  6. 幂等索引：逐文件校验 scope/文件名校验；损坏或指向已不存在 commandId 的条目删除 + 诊断（`idempotency-unreadable`/`idempotency-dangling`），不阻塞启动。
  7. 恢复后重新应用保留策略（TTL/容量）并持久化 `firstRetainedSequence`；终态裁剪会同时移除 record、idempotency 与 journal 事件，因此被裁掉的 cursor 得到显式 gap 而不是静默空洞。
- IO 失败语义：所有 store 失败包装为 `CommandStoreException`；启动恢复失败 → API 启动失败（`ApiHost` 在 `app.Build()` 后强制解析 service）；运行期写失败 → `Submit` 返回 `StoreUnavailable`（HTTP 503 `COMMAND_STORE_UNAVAILABLE`），service 记录 fault 标志，绝不以内存态返回成功。

## 3. 契约变化

新增 JSON Schema `$defs`（生成 C#/TS/openapi）：

- `CommandRecoveryDto`：`siteId, fabId, commandId, revision, outcome, occurredAt, terminal`
- `CommandRecoveryListDto`：`epoch, latestSequence, commands[]`
- `CommandJournalEventDto`：`sequence, fabId, commandId, revision, outcome, occurredAt`
- `CommandJournalPageDto`：`epoch, hasGap, firstRetainedSequence, latestSequence, events[]`
- `CommandDirtyDto`：`reason, droppedCount, epoch, sequence, occurredAt`（ADR-008 §2.2 笔误的 `CommandPriorityDirtyDto` 已由 Lead 修正为 task 清单名 `CommandDirtyDto`）

生成器 `tools/generate_contracts.py`：`integer + format:int64` 生成 C# `long`；openapi 新增两条 Phase D 路径。openapi 中 DTO 描述写明保留窗口与 404/gap 语义。

新增 HTTP 契约（精确）：

1. `GET /api/v1/sites/{siteId:guid}/fabs/{fabId:guid}/commands?status=active|terminal|all&afterRevision=`
   - `status` 缺省 `all`，其他值 → 400 `INVALID_QUERY`；`afterRevision` 缺省 `-1`（保留 revision 更大的命令），`< -1` → 400。
   - 200 → `CommandRecoveryListDto`；未知/未授权 Site/FAB → 404；store fault → 503。
2. `GET /api/v1/sites/{siteId:guid}/fabs/{fabId:guid}/command-journal?afterSequence=&limit=`
   - `afterSequence` 缺省 0、`>=0`；`limit` 缺省 100、范围 1..1000；非法 → 400 `INVALID_QUERY`。
   - 200 → `CommandJournalPageDto`（`hasGap` 覆盖裁剪窗口、retention 空洞与 ahead cursor）；未知/未授权 → 404。
3. SSE `GET /api/v1/sites/{siteId}/commands/stream?fabId=`：`id: {epoch}:{sequence}` 保持；cursor 不可服务先发 `event: replay-gap`，若可能丢事件（retention-trim / epoch-replaced）再发 `event: dirty`（无 id，data 为 `CommandDirtyDto`）；store fault 时发 `reason=store-fault` dirty 后关闭连接。
4. `POST /sites/{siteId}/commands`：durable 写入失败新增 503 `COMMAND_STORE_UNAVAILABLE`（不产生 accepted 假象）。

## 4. 测试

### 新增 `fab_tests/src/CommandPersistenceTests.cs`（12）

1. `RestartPreservesIdempotentReplayAndRevisionOutcome`
2. `RestartReplaysJournalExactlyFromOldCursorWithoutGap`
3. `PrunedCursorReportsGapAfterRestart`
4. `TruncatedJournalStartsNewEpochAndKeepsAuthoritativeRecords`
5. `DeletedJournalStartsNewEpochAndKeepsAuthoritativeRecords`
6. `RecordNewerThanJournalIsRepairedIntoTheExistingEpoch`（outbox 崩溃窗口注入）
7. `ConcurrentSubmissionsKeepSequencesMonotonicAcrossRestart`（`Parallel.For` 40 个唯一幂等键）
8. `UnwritableStoreFailsStartupExplicitly`
9. `IoFailureOnSubmitIsExplicitAndNeverFallsBackToMemory`
10. `Core013CombinationRestartCursorBreakEventLossAndDuplicateIdempotency`
11. `MissingRecordIsRebuiltFromJournal`
12. `CorruptIdempotencyEntryIsDroppedWithoutBlockingStartup`

### 新增 `fab_tests/src/CommandRecoveryApiTests.cs`（5，真实 HTTP host）

1. `ListCommandsIsAuthoritativeAndFiltersByStatusAndRevision`
2. `CommandJournalPagePaginatesAndReportsGap`
3. `CommandJournalPageReportsGapAfterRetentionTrim`
4. `RestartOverSameDataDirectoryRecoversCommandIdempotencyAndJournal`（host 重启 + 旧 SSE cursor 精确回放）
5. `Core013RestartCursorBreakEventLossAndDuplicateIdempotencyOverHttp`（CORE-013：host 重启 + cursor 断裂 + 事件丢失 + 重复幂等请求 → 同一 commandId、无重复执行、新 epoch + replay-gap + dirty）

### 既有测试改动（未弱化断言）

- `CommandJournalTests` / `CommandRetentionTests`：服务构造改为注入 `TestDataDirectory.Store()`；`service.JournalEpoch`（单实例 epoch）→ `service.GetJournalEpoch(SiteId)`（epoch 按 site 持久化）。
- `CommandApiTests`：factory 使用 `TestDataDirectory.Create()`；自定义 options 的 service 注入 DI 的 `ICommandStore`；两处 SSE 断言新增 dirty 控制帧（foreign epoch / live retention trim），原有断言保留。基线 180 个测试数量未变（见 §7 中 197 = 180 + 17）。

### 临时目录与故障注入方式

- 所有测试使用 OS 临时目录：`%TEMP%/fab-command-store-tests/<guid>`（`TestDataDirectory`；进程退出清理，持久化测试在 `Dispose` 立即清理）。API factory 的 `Fab:DataDirectory` 也指向临时目录。不写仓库 `.local/data`（`git status --porcelain -- .local` 为空）。
- 启动 IO 失败：把 store 根路径指向一个普通文件（`Directory.CreateDirectory` 抛 IOException → `CommandStoreException`）；恢复写失败：删除 `epoch.json` 并以同名目录替换。
- 提交期 IO 失败：启动后把当前 `journal/<epoch>.jsonl` 替换成同名目录 → append 失败 → `EquipmentCommandSubmitStatus.StoreUnavailable` + `StoreUnavailable=true`。
- journal 截断/删除：直接改写/删除 `journal/<epoch>.jsonl` 后新建 service/host → 新 epoch + 旧 cursor gap。
- outbox 崩溃窗口：把 journal 改回前 2 行并把 `epoch.json` 的 `latestSequence/journalLastSequence` 改为 2，而 record 仍有 3 个事件 → 恢复补齐 journal 且保持同 epoch。
- 未使用随机 seed（后端为确定性用例；并发用例的调度由 `Parallel.For` 产生，测试只断言唯一性/单调性/无回退，不依赖时序细节）。

## 5. 门禁原始输出

```
> dotnet build fab_app/fab_app.csproj -c Release
  fab_shared -> ...\fab_shared\bin\Release\net11.0\fab_shared.dll
  fab_app -> ...\fab_app\bin\Release\net11.0\fab_app.dll

Build succeeded.
    0 Warning(s)
    0 Error(s)
```

```
> dotnet test fab_tests/fab_tests.csproj -c Release
  fab_app -> ...\fab_app\bin\Release\net11.0\fab_app.dll
  fab_tests -> ...\fab_tests\bin\Release\net11.0\fab_tests.dll
Test run for ...\fab_tests\bin\Release\net11.0\fab_tests.dll (.NETCoreApp,Version=v11.0)
A total of 1 test files matched the specified pattern.

Passed!  - Failed:     0, Passed:   197, Skipped:     0, Total:   197, Duration: 9 s - fab_tests.dll (net11.0)
```

```
> python tools/generate_contracts.py --check
Contracts: C# / TypeScript match JSON Schema.
```

```
> python -m unittest discover -s tools -p 'test_*.py'
----------------------------------------------------------------------
Ran 8 tests in 1.390s

OK
```

```
> node tools/check_generated_artifacts.mjs --check
PASS: 3 generated artifact(s) registered in tools/generated-artifacts.json; generator commands, source inputs and output sha256 all match the committed tree.
```

```
> cd web_app; pnpm test -- tests/api/command-recovery-schema.test.ts
 ✓ tests/api/command-recovery-schema.test.ts (7 tests) 14ms
 Test Files  1 passed (1)
      Tests  7 passed (7)

> cd web_app; pnpm exec oxlint src/api/command-recovery.schema.ts tests/api/command-recovery-schema.test.ts
Found 0 warnings and 0 errors.
```

## 6. CORE-013 覆盖映射

| CORE-013 要素 | 覆盖测试 |
| --- | --- |
| 后端重启 | `RestartPreservesIdempotentReplayAndRevisionOutcome`、`RestartReplaysJournalExactlyFromOldCursorWithoutGap`、`RestartOverSameDataDirectoryRecoversCommandIdempotencyAndJournal` |
| 游标断裂 / 事件丢失 | `TruncatedJournalStartsNewEpochAndKeepsAuthoritativeRecords`、`DeletedJournalStartsNewEpochAndKeepsAuthoritativeRecords`、`PrunedCursorReportsGapAfterRestart`、`Core013...`（服务级 + HTTP 级） |
| 重复幂等请求不重复执行 | `RestartPreservesIdempotentReplayAndRevisionOutcome`、`Core013Combination...`、`Core013Restart...OverHttp`（同一 commandId、列举数量为 1） |
| revision 不退 | 同上：重启后 GET 仍为 revision 2 / outcome succeeded；idempotency replay 仍返回首次 revision 0 accepted 快照且不修改权威记录 |

## 7. 限制与未覆盖（如实记录）

- 实现为本地单机文件存储（ADR-008 §2.1 的 Development 方案），只支持单进程单写者；多进程/多主机并发写同一数据目录未支持、未验证（无跨进程锁）。ADR-008 已明确生产需真实数据库/OT 适配。
- 崩溃窗口：accepted 提交在 record/idempotency 已落盘、journal+epoch 尚未完成时崩溃，恢复会补 journal 并可能得到一条“客户端未收到 202”的持久命令；客户端重试会生成新 commandId（at-least-once 提交窗口），文档不得宣称跨崩溃 exactly-once 提交。
- 恢复时对 revision<2 的持久命令会重启开发模拟（以完整延迟重新调度执行 executing/succeeded），不持久化模拟器内部状态/剩余时间。
- 活跃命令的 journal 事件被容量裁剪、或终态命令被裁剪后，resume 失败会导致显式 gap/dirty；窗口外的权威状态不可恢复（404 语义），这是契约而非缺陷。
- 前端全量 `pnpm typecheck` 在本次收尾时仍被其他 phase（Phase B/C/E）在途文件报错阻塞（错误文件均不在本 phase 写范围，例如 `tests/realtime/realtime-transport.test.ts`、`tests/state/atom-notification-surface.test.ts`）；本 phase 新增/修改的前端文件未被 tsc 报错，且 oxlint 0 error。全量 typecheck 需在并行 phase 收尾后复跑（Lead/Phase F 门禁）。
- 真实浏览器刷新恢复 E2E 属于 Phase E/F（本 phase 只提供后端权威入口与 Phase C 的 schema），未在本证据中宣称通过。
- 证据 SHA pending：本文件在提交前生成，待 Lead 绑定最终 commit SHA。
## Lead 绑定（2026-10-30）

- Phase D 实现提交：`12ec5650b91eef0a0ae3b01245b6f1e9e8716c03`。
- 本文所有“SHA pending / 由 Lead 绑定”指该提交；最终整树验收证据见 `docs/architecture/evidence/final-verify.json` 与 `correctness-refactor-acceptance.md`（绑定最终 verify 的 commit）。
- 本文原始输出均可按文中命令重跑；未重跑的推断不得视为 PASS。

## 最终整树验收（Lead，2026-10-30）

- 验证提交：`af002f46b6a63599205b21132538075bbfaa15a7`；`scripts/verify.ps1` exit 0（GPU gate 开启，600s）。
- 原始输出：`docs/architecture/evidence/final-verify-af002f4.log`；机器摘要：`final-verify.json`；门禁矩阵：`correctness-refactor-acceptance.md`。
- 本文件早先记录的“pending”已被最终验证取代：最终 evidence 均绑定该提交；未覆盖/限制项见验收索引。
