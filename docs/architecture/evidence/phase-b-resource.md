# Phase B evidence — resource system rebuild (ADR-006, CORE-001..006)

- 基线提交：`1fb25ff`（规范冻结基线）；Phase A 文档提交：`9dc793f`。
- 本文件记录 Phase B 实现期间直接重跑的原始输出；最终提交 SHA 由 Lead 绑定（pending）。
- 工作目录：`C:\\Users\\han_qingyu\\SemiconFab-Next\\web_app`
- 环境：Windows 11 / Node 26.12.1 / pnpm 12.16.1（项目锁 12.15.0）/ effect 4.0.7 / @effect/atom-react 4.0.7 / vitest 5.0.5

## 1. RED 基线捕获（旧实现，工作树 `9dc793f`）

临时基线测试文件（随后删除，因为旧 API 按 ADR-006 §2.9 删除；删除原因见 §7）：
`web_app/tests/core/core-baseline-red.test.tsx`

命令：

```powershell
cd web_app
pnpm test -- tests/core/core-baseline-red
```

原始输出（2026-10-29，4 tests / 4 failed，即目标缺陷在旧实现上确实存在）：

```text
 ❯ tests/core/core-baseline-red.test.tsx (4 tests | 4 failed) 29ms
   × CORE-003 baseline: REST(11) rejected after SSE(12) must not write the old 10 back 11ms
   × CORE-004 baseline: a REST failure after SSE must not replace the accepted success 2ms
   × CORE-001 baseline: two runtimes must not share one in-flight request 1ms
   × CORE-002 baseline: two consumers must not own two polling intervals 14ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/core/core-baseline-red.test.tsx > CORE-003 baseline: REST(11) rejected after SSE(12) must not write the old 10 back
AssertionError: stale REST response must not write back the old 10: expected 10 to be 12 // Object.is equality
- Expected: 12 ; + Received: 10

 FAIL  tests/core/core-baseline-red.test.tsx > CORE-004 baseline: a REST failure after SSE must not replace the accepted success
AssertionError: a stale request failure must not overwrite the accepted success: expected true to be false
- Expected: false ; + Received: true

 FAIL  tests/core/core-baseline-red.test.tsx > CORE-001 baseline: two runtimes must not share one in-flight request
AssertionError: each runtime must issue its own request: expected 1 to be 2
- Expected: 2 ; + Received: 1

 FAIL  tests/core/core-baseline-red.test.tsx > CORE-002 baseline: two consumers must not own two polling intervals
AssertionError: one resource must have exactly one polling owner: expected 2 to be 1
- Expected: 1 ; + Received: 2

 Test Files  1 failed (1)
      Tests  4 failed (4)
```

结论（对应 G01/G03/G04/G05）：

| CORE | 旧实现观测 | 目标不变量 |
|---|---|---|
| CORE-001 | 两个 AppRuntime 对同一 `sitesResource` 只发 1 次请求，runtime B 的 Atom 未写 | INV-01 每个 runtime 独立请求/快照 |
| CORE-002 | 两个消费者各建 `setInterval`，一个 20ms 周期产生 2 次 load | INV-05 每资源最多一个轮询 owner |
| CORE-003 | REST 11 被 gate 拒绝后写回请求开始前的 10（P0） | INV-03 拒绝响应不得改变已接受 12 |
| CORE-004 | SSE 12 之后 REST 失败把 Atom 改成 Failure | INV-03 失败不得覆盖更高代成功 |

## 2. 实现摘要（ADR-006 冻结 API）

新增/重写：

- `src/api/resource.ts`：冻结类型 `ResourceKey/ResourcePolicy/IgnoreReason/CommitDecision/ResourceCommitContext/ResourceDefinition/ResourceHandle/ResourceManager/ResourceManagerHost/ResourceCapacityError`，`defineResource` 辅助函数。
- `src/api/resource-manager.ts`：`createResourceManager`。每 AppRuntime 一个；key 级协调条目仅保存控制元数据（requestId/writeSeq/subscribers/scope/pollFiber/idleTimer/诊断），快照唯一所有者是 manager 创建的 `handle.atom`；提交函数无 await、Publish|Ignore 单出口、Ignore 只追加 ≤32 条诊断；唯一轮询 Fiber 由 ResourceScope 拥有；容量 soft 256/hard 512 + idle TTL；`stats { entries, inFlight, polling, scopes }`。
- `src/app/app-runtime.ts`：新增 `rootScope: Scope.Closeable`（`Scope.forkUnsafe(services.scope)`）、`forkScope()`、`resources: ResourceManager`；dispose 固定顺序 `resources.dispose() → Scope.close(rootScope) → services.dispose() → registry.dispose()`。
- 资源模块改为不可变 Definition：`sitesDefinition`、`catalogDefinition`、`runsDefinition`、`runDefinition(runId)`、`runResultsDefinition(runId)`、`equipmentStatusDefinition(siteId,fabId)`、`researchEventsDefinition`、`waferRoutesDefinition`。
- `src/api/use-resource.ts`：`runtime.resources.handle(definition)` + `useAtomValue(handle.atom)` + effect 内 `retain`/`ensure`/release；无组件级 interval；`enabled=false` 不 retain/ensure/轮询但仍可读 Atom。
- 设备唯一提交端口：`equipmentStatusDefinition.accept` 在同一同步提交段从 `context.current`（Success 或 failure.previousSuccess）读取已接受 `(epoch,sequence)`，`compareEquipmentStatusSnapshot`（纯函数）返回 Publish|Ignore；REST/SSE/重连快照全部经 `resources.publish`。
- `twin/twin-equipment-status-pipeline.tsx` 重写：layout effect 原子换手（cancel batcher + generation token + liveScopeActivated）、AbortController 中止旧 EventSource、SSE 回调只 `resources.publish(handle, snapshot, 'push')`（Ignore 即诊断，不写 UI）。
- 删除（无 shim）：`resourceFamily`、`makeResource`、`refreshResource`、`ensureResource`、`setResourceValue`、`resourceValue`、`invalidateResource`、模块级 `inFlight WeakMap`、模块级动态 Atom/family；`gatesByRegistry`、`equipmentStatusGate`、`activateEquipmentStatusScope`、`resetEquipmentStatusGates`、`acceptEquipmentStatusSnapshot`；`realtime/equipment-status.gate.ts` 改为纯比较函数（无可变高水位）。

### 2.1 与 ADR-006 §2.8 冻结签名的实现偏离说明（供 Lead 修订记录）

1. `ResourceManager`/`ResourceManagerHost` 增加类型参数 `Runtime extends ResourceRuntime`，host 增加 `runtime` 字段：保持 `manager.runtime` 是真实 AppRuntime 实例（身份而非结构副本），同时避免 `app/app-runtime.ts ↔ api/resource*.ts` 出现模块环（仓库 R1/R10 的 import graph 把 type-only 边也算环）。结构等价：manager.runtime 的实际类型就是 `AppRuntime<never>`。
2. 容量：软上限 256，先按 idle LRU 驱逐零订阅条目；驱逐后仍 `>= 256` 抛 `ResourceCapacityError`；`maxEntriesHard = 512` 作为绝对拒绝阈值兜底（不允许任何路径越过）。与 §2.7 “仍超然后拒绝创建”一致。
3. 新增 `defineResource`（identity 辅助函数，无行为差异），用于保持定义文件的 A/E 推断；新增 `runKey/runResultsKey/equipmentStatusKey` 显式 key 构造函数（§2.1 规定 key 由资源模块构造）。
4. `ResourceManager.state/value` 对未注册 handle 直接读 `handle.atom`（该路径不可达：handle 只能由本 manager 的 handle() 创建）；其余方法对已释放 handle 返回 Ignore('scope-closed') 或拒绝 Promise，不静默成功。
5. ResourceScope 在首个 retain 时创建（`Scope.forkUnsafe(rootScope)`），最后 release 关闭；loader-only ensure 不创建 scope，其 in-flight 由 manager 的 requestId/writeSeq 判定，不写入已释放条目。
6. idle TTL 定时器使用宿主 `setTimeout` 并在 Node 下 `unref()`（不影响浏览器行为；测试环境不因其阻止进程退出）。

## 3. GREEN：CORE-001..006 原始输出

命令：

```powershell
cd web_app
pnpm test -- tests/core
```

```text
 RUN  v5.0.5 C:/Users/han_qingyu/SemiconFab-Next/web_app

 ✓ tests/core/core-001-runtime-isolation.test.ts (2 tests) 15ms
 ✓ tests/core/core-002-single-flight-single-poller.test.tsx (2 tests) 44ms
 ✓ tests/core/core-003-equipment-commit.test.ts (3 tests) 53ms
 ✓ tests/core/core-004-equipment-failure.test.ts (2 tests) 58ms
 ✓ tests/core/core-005-fab-scope.test.ts (2 tests) 49ms
 ✓ tests/core/core-006-boundedness.test.tsx (2 tests) 163ms

 Test Files  6 passed (6)
      Tests  13 passed (13)
```

覆盖映射：

| 测试 | 覆盖 | 关键断言 |
|---|---|---|
| CORE-001 | INV-01 | 两个 runtime 对同一定义各发 1 次请求、各写各的 registry；dispose A 后 B 的请求/值不受影响 |
| CORE-002 | INV-02/INV-05 | 两消费者共享 1 个 in-flight、每周期恰好 1 次轮询、stats.polling 始终 1、全 unmount 后 0；loader ensure 与 mount 共享请求 |
| CORE-003 | INV-03/G04 | 10 → SSE 12 → REST 11 被 accept 拒绝后 Atom 仍为 12，诊断 reason=rejected；重复/低 sequence、旧 epoch 均只诊断 |
| CORE-004 | INV-03/G03 | SSE 12 后延迟 REST 失败只产生 superseded-write 诊断，Atom 保持 Success 12；无更高写时失败保留 previousSuccess |
| CORE-005 | INV-03/G06 | 新 FAB 激活后旧 FAB REST 完成不写新 FAB Atom；release 旧 FAB 后旧请求被忽略；FAB key/Atom 不共享 |
| CORE-006 | INV-06/G02 | 1200 个动态 Run key：entries ≤256、TTL 后 entries/scopes/polling=0、getNodes ≤16；第 257 个保留条目触发 ResourceCapacityError 且诊断 capacity |

有界性统计（CORE-006 断言，命令同上）：`manager.stats.entries` 峰值 ≤ 256（软上限），idle TTL 到期后 = 0；`scopes` = 0；`polling` = 0；`registry.getNodes().size` ≤ 16；容量拒绝后 entries 保持 256（不增长）。

## 4. 静态门禁（Phase B 自身范围）

```powershell
cd web_app
pnpm lint
```

```text
$ oxlint src
Found 0 warnings and 0 errors.
Finished in 122ms on 208 files with 88 rules using 20 threads.
```

旧 API token 扫描（`web_app/src`，0 命中）：

```powershell
rg -n "resourceFamily|makeResource|refreshResource|ensureResource|setResourceValue|resourceValue|invalidateResource|equipmentStatusGate|activateEquipmentStatusScope|resetEquipmentStatusGates|acceptEquipmentStatusSnapshot|gatesByRegistry" src
rg -n "createEquipmentStatusGate|createOrderedEquipmentStatusConsumer" src
```

```text
(no output; exit code 1 from rg = no matches)
```

## 5. 测试迁移与删除说明

- 新增 `tests/core/core-001..006`（13 tests，见 §3），全部使用 Deferred/受控 fetch/fake timers，无真实网络。
- 重写：`tests/api/resource.test.tsx`（manager 公共契约 + useResource 绑定）、`tests/api/equipment-status-bridge.test.ts`（唯一提交端口/epoch-sequence）、`tests/integration/resource-cache.test.tsx`（RES-05..08）、`tests/integration/router-resource.test.tsx`（RES-01..04 走 manager）、`tests/support/resource-test-runtime.tsx`（seed*/read* 改走 publish/value）、`tests/architecture/resource-ownership.test.ts`（唯一 manager、禁止旧 token、禁止 import-time Atom、资源图无环）。
- 删除：`tests/core/core-baseline-red.test.tsx`（仅为 RED 捕获的临时基线，旧 API 删除后无法存在；RED 原始输出保存在 §1）。
- 授权更新（Lead file-level 授权）：`tests/realtime/equipment-status-epoch.test.ts`、`tests/realtime/equipment-status.test.ts`、`tests/realtime/equipment-status-protocol.test.ts`。有状态 `createEquipmentStatusGate/createOrderedEquipmentStatusConsumer` 用例改为纯比较契约 `compareEquipmentStatusSnapshot`（保留 epoch/sequence 校验、transport/stale/abort 覆盖）；\"重复/低 sequence 只产生诊断不写 Atom\" 迁到 CORE-003/004 与 `tests/api/equipment-status-bridge.test.ts`。
- 未改动：`tests/api/command-http.test.ts`、`tests/api/effect-http.test.ts`、`tests/types/effect-api-types.ts`（Phase C 所有权）。
- Lead 单文件授权更新：`tests/integration/twin-fab-scope.test.tsx` A01。旧断言「provider replacement 后同一 registry 的 FAB ordering high-water 仍存活」与 ADR-006 §2.1（每个 manager 创建自己的 `handle.atom`；不同 AppRuntime 同 key 值与请求完全隔离）及 ADR-007 §3/CORE-009（同一 Registry 重建 Runtime 时旧状态不进入新 Runtime）冲突。新断言（不弱化，仍然拒绝空洞 PASS）：换 provider 后旧 SSE generation detach（`sourceA.onmessage === null` 且捕获的旧回调调用后新 runtime Atom/投影不变）、新 runtime 从自身空 Atom 开始并把新连接 seq=1 作为基线接受、同一新 runtime 内后续重复 seq=1 被顺序接受协议拒绝、seq=2 正常推进；旧 runtime 自己仍持有其已接受的 seq=6 快照（跨 runtime 隔离的正反两面都断言）。

## 6. 全量门禁状态（Phase B 收尾时点，工作树并行阶段快照）

验证时工作树同时包含 Phase C/D/E 的进行中修改（非 Phase B 范围）：

- `pnpm typecheck`：`src/**` 0 error；剩余错误全部在 Phase C 正在重写的测试文件（`tests/api/command-http.test.ts`、`tests/api/effect-http.test.ts`、`tests/integration/fab-runtime*`、`tests/realtime/realtime-transport.test.ts` 等）与 `tests/state/atom-notification-surface.test.ts`（Phase E）。Phase B 范围（`api/**`、`app/app-runtime.ts`、资源调用点、twin pipeline、Phase B 测试）0 error。
- `pnpm test`（第二次全量，工作树快照）：`Test Files 6 failed | 133 passed (139)`，`Tests 11 failed | 764 passed (775)`；6 个失败文件全部属于 Phase C 进行中的 command 测试：`tests/api/command-http.test.ts`、`tests/api/effect-http.test.ts`、`tests/architecture/architecture-contract-rules.test.ts`（R14 命中 `api/http-command-gateway.ts` 的 String/Number 与 `realtime/command-event-source.transport.ts` 未注释 cast，均不在 Phase B 文件）、`tests/features/workbench/workbench-command-scope.test.tsx`、`tests/integration/runtime-bootstrap.test.tsx`、`tests/realtime/realtime-transport.test.ts`。
- 该快照中与资源系统相关的全部测试（CORE-001..006、tests/api 资源部分、tests/realtime/equipment-status*、resource/equipment-status/router integration、twin-fab-scope、architecture 资源/导入图/runner/R14 以外门禁、app-runtime）均通过。最终全量绿由 Lead 在 Phase C/E 落地后复跑（pending）。

第二次全量原始摘要（并行阶段进行中）：

```text
 Test Files  6 failed | 133 passed (139)
      Tests  11 failed | 764 passed (775)
```

### Phase B 完成时的最终复跑（工作树 `141 files / 792 tests`，所有并行阶段已落地）

```powershell
cd web_app
pnpm typecheck   # exit 0 (tsc --noEmit, no output)
pnpm lint        # 0 warnings / 0 errors (209 files, 88 rules)
pnpm test        # exit 0
rg -n "resourceFamily|makeResource|refreshResource|ensureResource|setResourceValue|resourceValue|invalidateResource|equipmentStatusGate|activateEquipmentStatusScope|resetEquipmentStatusGates|gatesByRegistry|acceptEquipmentStatusSnapshot" src   # no matches (exit 1)
rg -n "createEquipmentStatusGate|createOrderedEquipmentStatusConsumer" src   # no matches (exit 1)
```

```text
 Test Files  141 passed (141)
      Tests  792 passed (792)
```

说明：该全量结果包含其他阶段的 141 个测试文件（含 Phase C/D/E 新增 CORE-007..014 等）；本文件的 Phase B 目标文件全部通过。最终提交 SHA 由 Lead 绑定（pending）。

## 7. 限制与后续

- 未在真实浏览器/后端上重跑设备状态 REST/SSE；Phase B 证据使用受控 fetch/EventSource 与 Deferred 交错。真实浏览器 E2E 属 Phase E/F（CORE-012）。
- 堆内存快照：本轮以 `manager.stats`（entries/scopes/polling/inFlight）与 `registry.getNodes()` 作为可重复的有界性证据；未采集 V8 heap snapshot（需要额外 GC 暴露参数，易抖动）。Phase F 的 verify 可在生产构建浏览器 soak 中补 heap 数据。
- 临时调试文件 `tests/core/tmp-timer-debug.test.ts` 属 Phase C（CORE-014 timer 调试）产物，已提醒 command-owner 收尾删除；Phase B 的 `tests/core/core-00{1..6}*` 命名独立。
- 最终提交 SHA 未绑定（Lead 提交后填写）；本文件所有输出均可由上述命令重跑。
## Lead 绑定（2026-10-30）

- Phase B 实现提交：`7564cddfc2a79b190ac215b2b93839afa3a53066`。
- 本文所有“SHA pending / 由 Lead 绑定”指该提交；最终整树验收证据见 `docs/architecture/evidence/final-verify.json` 与 `correctness-refactor-acceptance.md`（绑定最终 verify 的 commit）。
- 本文原始输出均可按文中命令重跑；未重跑的推断不得视为 PASS。

## 最终整树验收（Lead，2026-10-30）

- 验证提交：`af002f46b6a63599205b21132538075bbfaa15a7`；`scripts/verify.ps1` exit 0（GPU gate 开启，600s）。
- 原始输出：`docs/architecture/evidence/final-verify-af002f4.log`；机器摘要：`final-verify.json`；门禁矩阵：`correctness-refactor-acceptance.md`。
- 本文件早先记录的“pending”已被最终验证取代：最终 evidence 均绑定该提交；未覆盖/限制项见验收索引。
