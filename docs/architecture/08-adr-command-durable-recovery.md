# ADR-008：命令持久恢复与后端权威契约（Phase D 冻结接口）

- 状态：Accepted（Phase A，2026-10-29）
- 基线：`1fb25ffc36b5b65813f031c8d889063964b4d1bd`
- 关联不变量：INV-07/08/10/13；关联测试：CORE-013（另需 CORE-010 的后端兜底）

## 1. 背景

当前 `fab_app/src/EquipmentCommandService.cs` 已具备：幂等键去重（进程内）、per-site 事件 journal（内存）、epoch + sequence 游标、`replay-gap` 帧、权威 GET `/api/v1/commands/{commandId}`、终态 TTL/容量裁剪。但它全部在 `ConcurrentDictionary`/内存中：

- 后端重启 → 所有命令记录、journal、epoch、幂等索引丢失；浏览器重连/刷新后无法恢复命令最终状态（前端只能“尽力恢复”，违反 INV-13 的产品级保证）。
- 浏览器刷新 → `use-command-console` 的 in-memory ledger 丢失 commandId；没有“按 FAB 列举活动/未确认命令”的权威入口。
- journal/容量裁剪无持久化游标，重启后无法区分“pruned”与“lost”。

产品目标包含“浏览器刷新/断线后命令最终状态恢复”，因此本 ADR 把后端持久化列为 Phase D 必做项，不再把前端当作唯一恢复边界。

## 2. 决策

### 2.1 持久化存储（本地单机 Development 实现）

根目录：`Fab:DataDirectory`（默认 `fab_app/.local/data`，已在 `ApiHost` 解析）下新增 `commands/<siteId>/`：

- `epoch.json`：`{ epoch: Guid, createdAt, firstRetainedSequence, latestSequence }`（原子写：tmp + flush + rename）。
- `journal/<epoch>.jsonl`：append-only，一行一个 `{ sequence, occurredAt, fabId, commandId, revision, outcome }`；每行写入后 `FileStream.Flush(flushToDisk: true)` 才允许对外确认。
- `commands/<commandId>.json`：权威命令记录（siteId/fabId/equipmentId/action/commandId/revision/outcome/occurredAt/terminalAt），原子写。
- `idempotency/<sha256(key+principal)>.json`：幂等键 → commandId/首次响应摘要/请求哈希；用于重启后 replay/conflict。
- `journal/epoch.json` 与 journal 文件的一致性由恢复流程保证（见 2.3）。

约束：单 site 单写者（`SemaphoreSlim(1,1)` per site）保证 sequence 单调与 append 顺序；写线程不得在 lock 内做网络 I/O。容量/裁剪沿用 Development 策略（终态 TTL 5 分钟、MaxTerminalCommands 512、MaxJournalEventsPerSite 4096），但必须把裁剪结果（`firstRetainedSequence`）持久化，重启后裁剪语义一致。

### 2.2 权威契约（HTTP）

保留并扩展：

| 端点 | 语义 |
|---|---|
| `POST /api/v1/sites/{siteId}/commands` | 幂等提交（`Idempotency-Key` 必填）；持久化成功后才返回 202；响应含 `commandId/revision/outcome`。重放同 key+同 payload 返回同一 commandId；同 key 不同 payload → 409 IdempotencyConflict；重启后仍成立 |
| `GET /api/v1/commands/{commandId}` | 权威状态查询；返回 revision/outcome；裁剪窗口外 404（契约明确“只保证保留窗口内”） |
| `GET /api/v1/sites/{siteId}/fabs/{fabId}/commands?status=active\|terminal\|all&afterRevision=` | **新增**：按 FAB 列举命令（含 revision/outcome/occurredAt、journal epoch/latestSequence）；浏览器刷新/严重 gap 后恢复未确认命令的权威入口 |
| `GET /api/v1/sites/{siteId}/fabs/{fabId}/command-journal?afterSequence=&limit=` | **新增**：journal 分页回放（含 `hasGap`、`firstRetainedSequence`、`latestSequence`、`epoch`）；慢消费者/重连补洞使用 |
| `GET /api/v1/sites/{siteId}/commands/stream?fabId=` | 既有 SSE；新增：每个 result 的 SSE id 含 `epoch:sequence`；cursor 不可服务时先发 `event: replay-gap`（保留既有语义）；新增 `event: dirty`（服务端背压/裁剪导致的事件可能不完整，客户端必须权威对账） |

DTO（新增到 `contracts/json-schema/contracts.schema.json` 的 `$defs`，并由 `tools/generate_contracts.py` 生成 C#/TS）：

- `CommandRecoveryDto`：siteId/fabId/commandId/revision/outcome/occurredAt/terminal。
- `CommandRecoveryListDto`：epoch/latestSequence/commands[]。
- `CommandJournalPageDto`：epoch/hasGap/firstRetainedSequence/latestSequence/events[]（events 复用 `CommandJournalEventDto`）。
- `CommandJournalEventDto`：sequence/fabId/commandId/revision/outcome/occurredAt。
- `CommandDirtyDto`（SSE control frame）：reason/droppedCount/epoch/sequence/occurredAt。

openapi.json 同步由生成器产出；`verify.ps1` 的 `python tools/generate_contracts.py --check` 必须通过。

### 2.3 启动恢复协议

1. 读取 `epoch.json`；缺失/损坏 → 创建新 epoch（`firstRetainedSequence=0, latestSequence=0`）。
2. 读取 journal：逐行解析；损坏行或序列不连续：从最后有效 sequence 继续，并记录 `journalRepaired` 诊断；若无法保证连续（文件被截断/删除），生成新 epoch（旧客户端 cursor 全部走 gap）。
3. 重建 terminal index/retention：按 occurredAt 与容量裁剪；裁剪必须推进 `firstRetainedSequence` 并持久化。
4. 幂等索引：扫描 `idempotency/`；哈希校验；损坏/冲突条目删除并记录诊断（不阻塞启动）。
5. 命令记录与 journal 交叉校验：journal 中有而记录缺失 → 由 journal 重建记录（outbox 语义）；记录比 journal 新（崩溃窗口）→ 补写 journal。
6. 启动完成后 `latestSequence` 必须 ≥ 重启前最后确认的 sequence；客户端用重启前 cursor 连接必须不丢已确认事件。
7. 恢复失败（磁盘不可写/权限）→ 服务启动失败（不得以内存模式静默降级）。

### 2.4 前端契约（Phase C/D 交界）

- `CommandGateway` 增加：`listFabCommands(siteId, fabId, filter): Promise<CommandRecoveryList>`、`getCommandJournalPage(siteId, fabId, cursor): Promise<CommandJournalPage>`；`http-command-gateway.ts` 实现并做 Schema 解码。
- FabRuntime 启动/严重 gap/overflow/后端重启（transport 失败后可查询）时：用 `listFabCommands(active)` 恢复未确认命令 → track → 交给统一调度器核对；不依赖 React 内存 ledger。
- 浏览器刷新恢复：页面初始化后 FabRuntime 对当前 FAB 执行一次 active 列举；E2E 必须验证“提交命令 → 刷新页面 → 终态仍可见/可对账”。
- 未实现持久化前，文档不得宣称“持久可靠”；Phase D 完成后才可更新该声明。

### 2.5 测试（后端）

- `CommandPersistenceTests`：
  - 重启后同 idempotency key+payload → 同一 commandId（revision 不重置）；
  - 重启后 `GET /commands/{id}` 返回同一 revision/outcome；
  - 重启后携带旧 SSE cursor 连接 → 精确回放、无 gap；
  - 裁剪后旧 cursor → HasGap=true + gap 事件；
  - journal 文件截断/删除 → 新 epoch + gap（不崩溃）；
  - 并发提交（多线程同 site）→ sequence 无重复/无回退；
  - 写入磁盘失败（只读目录/注入 IO 异常）→ 启动/提交失败明确，不静默内存降级；
  - CORE-013：重启 + cursor 断裂 + 事件丢失 + 重复幂等请求组合。
- 所有测试使用临时目录，结束时清理；不得依赖真实 `.local` 数据。
- 真实前端 E2E（Phase E/F）：生产 build + preview，提交 → 刷新 → 恢复。

### 2.6 CI/门禁

- `verify.ps1` 继续运行 `dotnet test`（含新测试）与 `generate_contracts.py --check`。
- 持久化实现必须跨平台（Windows runner 为主）；只允许本地磁盘目录，不接受 UNC。

## 3. 后果

- 后端成为命令恢复的唯一权威来源；前端只做“展示 + 调度对账”。
- 写入路径增加 fsync，命令提交延迟上升（Development 可接受；生产实现需真实数据库/OT 适配）。
- 保留窗口外不保证恢复，文档必须写明窗口与 404 语义。