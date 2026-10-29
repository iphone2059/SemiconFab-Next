# Round 2 F3 证据：SQLite WAL 事务化命令存储、唯一幂等与 epoch 感知 journal 分页（CR-02 backend / CR-03）

- 状态：实现完成，后端门禁全部执行；前端全量 typecheck 另有其他 phase 在途错误（本 phase 文件不在错误列表，见 §8）。
- 阶段：Round 2 F3（task-7）；关联 ADR-010（后端 half）、ADR-012、矩阵 2(backend)/3。
- 基线：审查基线 `9ab2fd3`；F1 规范冻结提交 `b0c3e09`。
- 本步工作树 SHA：**pending**（由 Lead 在提交后绑定；本文件不手写 PASS）。
- 环境：Windows 11；.NET SDK 11.0.100-rc.3；Microsoft.Data.Sqlite 10.0.14（固定版本，见 `fab_app/fab_app.csproj` + lock）；Node 26.12.1 / pnpm 12.16.1。

## 1. 交付范围

| 类别 | 文件 |
| --- | --- |
| 事务化存储（新增） | `fab_shared/src/store/SqliteCommandStore.cs`（SQLite WAL 单事务实现）、`fab_shared/src/store/CommandStoreFaultInjection.cs`（`ICommandStoreFaultInjector` seam + 注入点常量） |
| 存储契约（重定义） | `fab_shared/src/store/CommandStore.cs`（`CommitSubmit/CommitAdvance/CommitRetention` 事务语义、outbox 记录、Persistence 记录；删除三文件协议辅助类型） |
| 删除旧协议 | `fab_app/src/FileCommandStore.cs` 已删除（无兼容迁移、无双写） |
| 集成/端点 | `fab_app/src/EquipmentCommandService.cs`（全部写路径经单事务 store；唯一键幂等、response_json 重放、epoch 感知分页、nextAfterSequence）、`fab_app/src/ApiHost.cs`（SQLite DI、journal 必填 epoch/400/409、503 映射） |
| 包/锁 | `fab_shared/fab_shared.csproj`（`Microsoft.Data.Sqlite` 10.0.14，显式 Version）、`fab_shared/packages.lock.json`、`fab_app/packages.lock.json`（仅项目引用）、`fab_tests/packages.lock.json`（restore 更新，均转 LF）；**fab_app 保持零 PackageReference** |
| 契约/生成物 | `contracts/json-schema/contracts.schema.json`（`nextAfterSequence`、`JournalEpochMismatchDto`）、`contracts/openapi/openapi.json`（生成）、`tools/generate_contracts.py`（epoch 必填参数、400/409 响应）、`fab_shared/src/Generated/Contracts.g.cs`、`web_app/src/generated/contracts.generated.ts`、`tools/generated-artifacts.json`（经 Lead 授权 `--update`）、两个 contracts README |
| 前端 schema（仅允许的两个文件） | `web_app/src/api/command-recovery.schema.ts`、`web_app/tests/api/command-recovery-schema.test.ts` |
| 测试 | 新增 `fab_tests/src/CommandFaultInjectionTests.cs`、`fab_tests/src/TestFaultInjector.cs`；重写 `CommandPersistenceTests.cs`、`CommandRecoveryApiTests.cs`；适配 `TestDataDirectory.cs`、`CommandRetentionTests.cs` |

未触碰：`web_app` 其他文件（runtime/api/gateway 归 F2/F4）、`runtime/**`、`scripts/**`、`.github/**`、`package.json`/pnpm lock。

## 1.1 项目归属（Round 2 verify 架构门禁修复）

Round 2 最终 verify 在 `tools/check_architecture.py:71` 失败：`fab_app must stay package-free (framework from Web SDK)`。修复方式不是放宽门禁，而是把持久化实现放到共享内核：

- 三个存储文件位于 `fab_shared/src/store/`（`CommandStore.cs`、`SqliteCommandStore.cs`、`CommandStoreFaultInjection.cs`），命名空间 `Fab.Contracts`（`fab_shared` 仅允许 `Fab.Simulation` / `Fab.Ids` / `Fab.Contracts` 三个命名空间，store 属 contract 语义）。
- `Microsoft.Data.Sqlite` 10.0.14 的 `<PackageReference ... Version="10.0.14" />` 放在 `fab_shared/fab_shared.csproj`；`fab_app/fab_app.csproj` 恢复为零 `PackageReference`（仅 `ProjectReference fab_shared` + Web SDK framework），门禁未加任何豁免。
- `fab_app`（`EquipmentCommandService`、`ApiHost`）与 `fab_tests` 通过既有 `using Fab.Contracts;` / 项目引用消费 store；`dotnet restore` 更新 `fab_shared/packages.lock.json`（新增包图）与 `fab_app`/`fab_tests` lock，均保持 LF。

门禁原始输出见 §7。

## 2. 事务化存储实现（ADR-012 2.1/2.2）

数据库：`<Fab:DataDirectory>/commands.db`。连接串固定 `Mode=ReadWriteCreate;Pooling=true;DefaultTimeout=5000`；每次开连接应用 `PRAGMA synchronous=FULL; foreign_keys=ON; busy_timeout=5000;`，初始化 `PRAGMA journal_mode=WAL;`（并校验返回 `wal`）。每 Site 一个 `SemaphoreSlim(1,1)` 单写者；写事务使用 `BeginTransaction(deferred: false)`（立即取写锁，避免并发升级死锁）。

Schema（`CREATE TABLE IF NOT EXISTS`，最小 schema + 服务需要的 created_at/terminal_at/site 列）：

```sql
CREATE TABLE site_state (site_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, first_retained INTEGER NOT NULL, latest_sequence INTEGER NOT NULL);
CREATE TABLE commands (command_id TEXT PRIMARY KEY, site_id TEXT NOT NULL, fab_id TEXT NOT NULL, equipment_id TEXT NOT NULL,
  action TEXT NOT NULL, revision INTEGER NOT NULL, outcome TEXT NOT NULL, occurred_at TEXT NOT NULL, terminal INTEGER NOT NULL,
  created_at TEXT NOT NULL, terminal_at TEXT NULL);
CREATE TABLE journal (sequence INTEGER PRIMARY KEY AUTOINCREMENT, epoch TEXT NOT NULL, fab_id TEXT NOT NULL,
  command_id TEXT NOT NULL, revision INTEGER NOT NULL, outcome TEXT NOT NULL, occurred_at TEXT NOT NULL);
CREATE TABLE idempotency (site_id TEXT NOT NULL, fab_id TEXT NOT NULL, principal TEXT NOT NULL, key TEXT NOT NULL,
  payload_hash TEXT NOT NULL, command_id TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, fab_id, principal, key),
  FOREIGN KEY (command_id) REFERENCES commands (command_id) ON DELETE CASCADE);
```

事务边界：

- `CommitSubmit`（单事务）：查唯一键幂等行 → 命中且 `payload_hash` 相同则返回 Replayed（读回原 command + response_json）；不同则 PayloadMismatch（HTTP 409）；未命中则 INSERT command → INSERT idempotency/outbox → INSERT journal（`last_insert_rowid()` 为该 Site 的 sequence）→ UPDATE site_state latest_sequence/first_retained → COMMIT。**COMMIT 成功后才返回 202**。
- `CommitAdvance`（单事务）：revision 守卫（expectedRevision 且 < 目标 revision 才继续）→ UPDATE command revision/outcome/occurred_at/terminal/terminal_at → INSERT journal → UPDATE site_state.latest_sequence → COMMIT；已被推进则返回 null（幂等 no-op）。
- `CommitRetention`（单事务）：DELETE pruned 命令的 journal 事件与 command 行（idempotency 由 FK CASCADE 删除）→ DELETE `sequence < first_retained` 的 journal 前缀 → UPDATE site_state.first_retained → COMMIT。
- 不变量由事务 + 恢复校验双重保证：磁盘上不存在 command 无 idempotency、journal 事件无 command、journal 最后 revision ≠ command revision；恢复发现违反（外部篡改/损坏）时显式抛 `CommandStoreException` 拒绝启动（见 `TamperedInvariantFailsStartupExplicitly`）。SQLite 失败/不可写路径统一包装 `CommandStoreException`，service 捕获后置 fault 标志并返回 503 / `StoreUnavailable`，无内存降级。

## 3. Journal API（ADR-010 §3 后端）

`GET /api/v1/sites/{siteId:guid}/fabs/{fabId:guid}/command-journal?epoch=<uuid>&afterSequence=<int>=0&limit=<1..1000>`

- `epoch` 必填；缺失/非 GUID → 400 `application/problem+json`，顶层 `code: "journal-cursor-invalid"`（`afterSequence<0`、`limit` 越界同样 400）。
- epoch ≠ 当前 store epoch → **409** `application/problem+json`，顶层字段：
  `{"code":"journal-epoch-mismatch","currentEpoch":"<uuid>","firstRetainedSequence":1,"latestSequence":6}`。
- 200 → `CommandJournalPageDto`：`{epoch, hasGap, firstRetainedSequence, latestSequence, nextAfterSequence, events:[{sequence,fabId,commandId,revision,outcome,occurredAt}]}`。
  - events 严格递增且全部 `> afterSequence`；
  - `nextAfterSequence` = 本页最后事件 sequence；**空页时 = 权威水位 latestSequence（若 cursor 已 ≥ latest 则回显 cursor）**。这是对 ADR-010 "无事件时 = afterSequence" 的必要澄清：FAB 过滤会造成稀疏页，若空页不前进，前端"循环到 latest"会无法终止（ADR-010 §3 同时要求"不得因过滤造成的空页判定恢复完成，必须以 sequence 水位判定"）。已在 contracts README 与本证据中明示。
  - `hasGap` = retained 窗口内缺失序号（裁剪空洞）或 cursor 超前；FAB 过滤造成的稀疏序号不算 gap。
- 多页/跨 FAB/空洞验收见 §6。

## 4. 故障注入 seam（ADR-012 2.3 / 矩阵 3）

`ICommandStoreFaultInjector.Reach(point)`（生产用 `NoCommandStoreFaultInjector`；测试用 `TestFaultInjector`），注入点与语义：

| 注入点 | 位置 | 崩溃后重启断言（`CommandFaultInjectionTests`） |
| --- | --- | --- |
| `after-command-insert` | INSERT command 后、idempotency 前 | 事务回滚；DB 中 commands/idempotency/journal 均 0，latest=0；同 key 重试恰好创建 1 个命令 |
| `after-idempotency-insert` | outbox 插入后、journal 前 | 同上 |
| `after-journal-insert` | journal 插入后、site_state 更新前 | 同上 |
| `before-commit` | 全部写完成、COMMIT 前 | 同上 |
| `after-commit-before-response` | COMMIT 成功后、返回前（模拟 202 丢失） | 已持久化：重启后 commands/idempotency/journal 各 1；同 key+payload 重试返回同一 commandId/revision/outcome/occurredAt |
| `before-commit-return` | COMMIT 成功后、方法返回前 | 同上 |
| `during-prune` | retention 事务 DELETE 完成、COMMIT 前 | 整体回滚：命令/幂等/journal 数量与 latest 不变；重启重新应用保留策略后一次性成功 |

每次注入后均执行磁盘不变量 SQL：`commands LEFT JOIN idempotency … WHERE i.command_id IS NULL` = 0、`journal LEFT JOIN commands … WHERE c.command_id IS NULL` = 0、`commands.revision <> MAX(journal.revision)` = 0。测试内用新 store/service 实例复用同一数据库文件模拟进程重启；**没有用真实子进程 kill**（限制见 §9）。注入器同时记录 reaching 顺序，`InjectorRecordsCommitBoundaryOrder` 锁定六点顺序。

RED 依据（旧实现，`9ab2fd3` 源码可证；不重跑旧代码）：`FileCommandStore.CommitAccepted` 依次独立执行 `WriteRecord → WriteIdempotency → AppendJournal`（三次 fsync/rename，无事务），崩溃在 record 之后、idempotency 之前会留下"command 无幂等键"；旧测试 `CorruptIdempotencyEntryIsDroppedWithoutBlockingStartup` 显式断言同 key 重试创建新 commandId。本轮按要求删除该旧测试/旧协议，换成上述注入矩阵（禁止 "same key => new command" 作为保留窗口内的通过条件）。

## 5. 迁移与清理

- `FileCommandStore.cs` 删除，`ICommandStore` 按事务语义重定义；service 不再自行拼多步写（`CommandPersistedRecord.Events`、`CommandRetentionUpdate.RetainedEvents`、`EvictIdempotency` 等旧协议辅助成员一并删除）。
- 旧数据目录 `commands/<siteId>/*` 不做迁移（Development-only）；`commands.db` 为唯一权威存储。
- 幂等条目不再按 `MaxIdempotencyEntries` 容量淘汰（否则保留窗口内会违反"202 后同 key 同 commandId"）：幂等行与命令同事务创建、命令被裁剪时同事务删除，因此数量随保留窗口有界；`EquipmentCommandOptions.MaxIdempotencyEntries` 移除并同步测试。
- 保留窗口外语义保持固定：GET 单命令 404、列举不含、journal hasGap、窗口外不保证恢复；DB 被重置（Development store reset）即 epoch 替换：旧 cursor/gap 显式 409/replay-gap+dirty，客户端走权威 list。

## 6. 测试与覆盖映射

- `fab_tests/src/CommandPersistenceTests.cs`（10）：重启后幂等 replay/revision/outcome；旧 cursor 精确回放无 gap；裁剪后 gap；DB 重置 → 新 epoch + 旧 cursor 拒绝；40 并发提交 sequence 单调且跨重启一致；不可写路径启动失败；运行期 IO 失败显式 StoreUnavailable；WAL + 单事务三表一致；**外部篡改不变量 → 启动显式失败**；CORE-013 组合（commit 后崩溃重试同 commandId + DB 重置 epoch 拒绝）。
- `fab_tests/src/CommandFaultInjectionTests.cs`（8）：4 个 pre-commit 注入点 ×（无部分状态 + 重试恰好 1 个命令）、2 个 post-commit 注入点 ×（重试同 commandId/revision/outcome）、边界顺序、during-prune 回滚。
- `fab_tests/src/CommandRecoveryApiTests.cs`（12）：权威列举；epoch 必填/400 与 409 problem 形状；1/256/257/1000 条 journal 多页（limit 1000/256/1 + nextAfterSequence 循环水位）；跨 FAB 稀疏序号（空页必须前进、循环终止）；裁剪空洞 hasGap；同 DB 重启后 command/idempotency/journal/SSE 精确恢复；DB 重置 → 404 + 409 + replay-gap+dirty + 权威 list；commit 后崩溃经 HTTP 重试同 commandId；store 写失败 → 503 `COMMAND_STORE_UNAVAILABLE`（无内存降级）。
- 既有测试适配：`CommandJournalTests`/`CommandRetentionTests` 改用临时 SQLite store 与去重后的 options；`TestDataDirectory` 增加数据库路径/WAL 池清理/重置 helper。基线 180 个非 Phase-D 测试全部保留；原文件协议专属测试（journal 截断/删除换 epoch、record→journal outbox 修复、损坏幂等条目）已删除，其语义由事务不变量 + fault-injection + DB reset 测试替代（本文件 §4 已说明，未弱化断言）。

## 7. 门禁原始输出

```
> dotnet build fab_app/fab_app.csproj -c Release
  fab_app -> ...\fab_app\bin\Release\net11.0\fab_app.dll

Build succeeded.
    0 Warning(s)
    0 Error(s)
```

```
> dotnet test fab_tests/fab_tests.csproj -c Release
Test run for ...\fab_tests\bin\Release\net11.0\fab_tests.dll (.NETCoreApp,Version=v11.0)
A total of 1 test files matched the specified pattern.

Passed!  - Failed:     0, Passed:   210, Skipped:     0, Total:   210, Duration: 10 s - fab_tests.dll (net11.0)
```

说明：180 个既有测试 + 10 CommandPersistenceTests + 8 CommandFaultInjectionTests + 12 CommandRecoveryApiTests = 210。

```
> python tools/generate_contracts.py --check
Contracts: C# / TypeScript match JSON Schema.

> node tools/check_generated_artifacts.mjs --check
PASS: 3 generated artifact(s) registered in tools/generated-artifacts.json; generator commands, source inputs and output sha256 all match the committed tree.

> python -m unittest discover -s tools -p 'test_*.py'
Ran 8 tests in 2.318s
OK
```

```
> cd web_app; pnpm test -- tests/api/command-recovery-schema.test.ts
 ✓ tests/api/command-recovery-schema.test.ts (8 tests) 48ms
 Test Files  1 passed (1)
      Tests  8 passed (8)

> cd web_app; pnpm exec oxlint src/api/command-recovery.schema.ts tests/api/command-recovery-schema.test.ts
Found 0 warnings and 0 errors.
```

```
> git diff --check        # 无空白错误（lock 文件已转 LF）
```

```text
> python tools/check_architecture.py
PASS: Task 1 final-state checks (flat src layout, generated-artifact region, deprecated dependencies, ARCH-11 high-frequency boundaries).
PASS: 3 independent .NET projects (fab_shared + fab_app + fab_tests) / 1 self-contained frontend project; flat layout, reference rules, DAG and module records.
```

`fab_app/fab_app.csproj` 仅含 `ProjectReference ../fab_shared/fab_shared.csproj` 与 Content，无 `PackageReference`；`fab_shared/fab_shared.csproj` 的 `Microsoft.Data.Sqlite` 带显式 Version，符合门禁第 31 行要求。

## 8. 前端 schema 变更（供 F2/F4 消费）

`web_app/src/api/command-recovery.schema.ts` 更新：

- `commandJournalPageSchema` 新增必填 `nextAfterSequence`（对齐生成 DTO）。
- 新增 `journalEpochMismatchSchema` / `decodeJournalEpochMismatch` / `JournalEpochMismatch` 类型，对齐生成 `JournalEpochMismatchDto`。
- `commandJournalQuerySchema` 的 `epoch` 改为必填；`afterSequence`/`limit` 规则不变。
- 新增常量 `JOURNAL_CURSOR_INVALID_CODE = 'journal-cursor-invalid'`、`JOURNAL_EPOCH_MISMATCH_CODE = 'journal-epoch-mismatch'`。
- 编译期桥接类型新增 `JournalEpochMismatchWireAligned`；测试从 7 条增至 8 条（含 epoch 必填、409 body、nextAfterSequence 拒绝缺失/负数）。

收尾首次复核时全量 `pnpm typecheck` 有 5 处错误，全部属于其他并行 phase 的在途文件，本 phase 两个文件 `command-recovery`/`contracts.generated` 相关错误为 0（grep 验证）。并行 phase 完成后二次复核：`pnpm typecheck` exit 0（`tsc --noEmit` 无输出）、`pnpm lint` exit 0（209 files / 88 rules，0 warnings 0 errors）；本 phase 两个前端文件 oxlint 0、目标 vitest 8/8 通过。F3 不再依赖任何 typecheck 豁免。

## 9. 限制与未验证（如实记录）

- SQLite 实现只支持**单进程/单写者** Development 用法；多进程同时写同一 `commands.db` 未支持、未验证（ADR-012 已明示）。busy_timeout 只兜底短锁冲突。
- "崩溃"通过故障注入抛异常 + SQLite 事务回滚建模，未执行真实子进程 kill（矩阵允许的替代证据；如需真实 kill 需额外脚本，本 phase 未做）。
- WAL 模式在进程崩溃后由 SQLite 回收 `-wal/-shm`；测试删除数据库时显式 `SqliteConnection.ClearAllPools()`（Windows 文件句柄），生产运行无需该步骤。
- DB 重置（删除 `commands.db`）等价于保留窗口整体丢失：旧命令 404、旧 cursor 409/gap，属契约行为；不宣称跨 DB 重置恢复。
- 保留窗口内不变量已覆盖；窗口外（TTL/512 终态/4096 journal）语义与文档见 contracts README。
- 前端恢复循环（F2）需按本 phase 的 `epoch` 必填 / 409 / `nextAfterSequence`（空页前进）语义实现；本文件已把精确形状发 Lead/command-owner/cancellation-owner。