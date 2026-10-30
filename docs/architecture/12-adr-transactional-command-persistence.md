# ADR-012：事务化命令持久化、唯一幂等与 outbox（Round 2 · F1 冻结）

- 状态：Accepted（2026-10-30，第二轮整改 F1）
- 基线：`main@9ab2fd3f3cc5304f030dbf7f8e46a414ccd4ebda`（CR-03）
- 关联验收：矩阵 2/3；CR-03

## 1. 已证缺陷

`FileCommandStore.CommitAccepted` 顺序执行 `WriteRecord → WriteIdempotency → AppendJournal`（三个独立 fsync/rename），没有事务边界；崩溃在 record 之后、idempotency 之前会留下“命令存在但幂等键丢失”，客户端重试可能创建新命令。`CommandPersistenceTests.CorruptIdempotencyEntryIsDroppedWithoutBlockingStartup` 明确把“同 key 产生新命令”当作可接受行为，必须修改。

## 2. 冻结决策

### 2.1 开发实现：SQLite WAL（严谨同步）

- `Microsoft.Data.Sqlite`（仓储内固定版本），数据库文件 `<Fab:DataDirectory>/commands.db`；PRAGMA：`journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000`。
- 每 Site 单写者（SemaphoreSlim）或单连接串行；禁止多进程同时写（文件锁/文档明示）。
- Schema（最小）：
  ```sql
  CREATE TABLE site_state (site_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, first_retained INTEGER NOT NULL, latest_sequence INTEGER NOT NULL);
  CREATE TABLE commands (command_id TEXT PRIMARY KEY, site_id TEXT NOT NULL, fab_id TEXT NOT NULL, equipment_id TEXT NOT NULL,
    action TEXT NOT NULL, revision INTEGER NOT NULL, outcome TEXT NOT NULL, occurred_at TEXT NOT NULL, terminal INTEGER NOT NULL);
  CREATE TABLE journal (sequence INTEGER PRIMARY KEY AUTOINCREMENT, epoch TEXT NOT NULL, fab_id TEXT NOT NULL,
    command_id TEXT NOT NULL, revision INTEGER NOT NULL, outcome TEXT NOT NULL, occurred_at TEXT NOT NULL);
  CREATE TABLE idempotency (site_id TEXT NOT NULL, fab_id TEXT NOT NULL, principal TEXT NOT NULL, key TEXT NOT NULL,
    payload_hash TEXT NOT NULL, command_id TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (site_id, fab_id, principal, key));
  -- outbox: 与命令同事务写入，供重复提交的响应重放与恢复查询；开发实现中 response_json 即 outbox。
  ```

- **项目归属（Round 2 架构门禁）**：实现位于共享内核 `fab_shared/src/store/`（命名空间 `Fab.Contracts`），`Microsoft.Data.Sqlite` 的 `PackageReference` 只出现在 `fab_shared.csproj`（显式 Version；fab_shared 允许显式包依赖）。`fab_app` 保持 **零 PackageReference**（framework 全部由 Web SDK 提供），因此 `tools/check_architecture.py` 的“fab_app 不得有 PackageReference / fab_shared 不得引用项目”门禁 **未放宽、未豁免**；`fab_tests` 经 ProjectReference 传递获得 store 类型。
- 生产目标（不在本轮实现）：PostgreSQL 同 schema + 事务/唯一约束 + outbox；迁移路径保持 DTO/服务层不变。

### 2.2 提交事务（原子）

- `Submit`：单个事务内 (a) 查/写 idempotency（唯一约束冲突时读取原 response 并按 payload_hash 判 replay/conflict）；(b) 写 command；(c) 写 journal accepted 行；(d) 更新 site_state.latest_sequence/epoch。`COMMIT` 成功后才返回 202。
- `Advance`（executing/succeeded）：单个事务内 revision 守卫 + journal 行 + 更新 command；epoch/sequence 与事件同事务推进。
- `Prune/Retention`：单事务内删除记录 + 推进 first_retained + 重写/裁剪 journal（SQLite DELETE）；崩溃回滚到一致状态。
- **不变量**：任何时刻磁盘上不存在“command 无 idempotency”或“journal 事件与 command revision 不一致”的状态；只要 202 已返回，崩溃重启后同 key+payload 重试必须返回同一 commandId（保留窗口内）。
- 保留窗口外语义（产品契约，文档明示）：GET 404 / journal gap；同 key 重试视为新命令（需在 API 契约与验收矩阵中固定，不得用“尽力恢复”搪塞）。

### 2.3 故障注入（验收矩阵 3）

- 新增测试 seam `ICommandStoreFaultInjector`（仅测试/Development 使用）：注入点 `before-commit`、`after-command-insert`、`after-idempotency-insert`、`before-commit-return`、`after-commit-before-response`、`during-prune` 等；每个点注入异常后重开 store，断言：
  - 无部分状态对客户端可见；未返回 202 的前缀重试允许产生一次新命令（客户端未收到确认）；
  - 已返回 202 的命令在重启后同 key 重试返回同 commandId/revision/outcome；
  - journal/命令/epoch 三者一致。
- 另外提供“进程级”验证：测试内新建 store 实例并丢弃旧实例（模拟进程重启）；可选子进程 kill 测试（若环境允许）。
- SQLite 不可用/IO 失败：显式 503 COMMAND_STORE_UNAVAILABLE，禁止内存降级。

## 3. 迁移与清理

- 删除 `FileCommandStore` 的三文件写协议与对应测试假设；旧数据目录不做兼容迁移（Development-only，README/ADR 明示清理即可；不得保留双写）。
- `ICommandStore` 接口按事务语义重定义；`EquipmentCommandService` 的读写路径全部经 store，不允许在 service 层拼多步非事务写。
- 生产目标（不在本轮实现）：PostgreSQL 同 schema，`SERIALIZABLE`/唯一约束 + outbox 表；ADR 记录迁移路径。

## 4. 测试要求

1. 每个注入点的“崩溃前缀”后重启一致性（按 2.3）。
2. 257/1000 条 journal 多页 + epoch 替换 + 保留窗口裁剪后的一致性（与 ADR-010 联合）。

## 5. Round 3 修订（2026-10-30，静态阶段；R3-01 保留窗口缺口语义）

- Journal 读路径（`EquipmentCommandService.ReadCommandJournalPage`）在**同一 Site 锁与同一事务快照语义内**用 long 边界计算缺口：`outsideRetainedWindow = afterSequence < firstRetainedSequence - 1`、`beyondLatest = afterSequence > latestSequence`、`hasGap = outsideRetainedWindow || beyondLatest || dropped > 0`。合法空站点（latest=0/first=1/after=0）不判 gap；保留窗口被完全清空（first=latest+1）时旧 cursor 必须 hasGap=true，即使 FAB 过滤后的 events 为空。
- `nextAfterSequence` 明确为“服务端已扫描覆盖的 Site 区间结束位置”：截断页=最后返回事件序号；耗尽/空 FAB 页=权威 `latestSequence`（cursor 已超前则回显，不回退）；`afterSequence < latestSequence` 时必前进，空页不得伪造完成。DTO 无变化，SQLite 事务/唯一幂等契约不变。
