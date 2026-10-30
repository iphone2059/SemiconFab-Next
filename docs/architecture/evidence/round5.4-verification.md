# Round 5.4 — 验证证据（绑定 commit `1dcebb4`）

**轮次：** Round 5.4（R5.4-01 终态保护 / R5.4-02 HTTP 202 accepted command 交接 / R5.4-03 复合 FAB 身份）。
**整改基线：** `972552b`（Round 5.3 证据提交，本轮源码父提交）。
**被验证 commit：** `1dcebb4832f051e1765841f20263fc715d1a9938`（Round 5.4 源码 + 测试提交）。
**规范：** 用户提供的 Round 5.4 规范；实现前冻结接口见 [round5.4-interface-freeze.md](../round5.4-interface-freeze.md)。
**验证时间：** 2026-10-30 20:20–20:29（Asia/Singapore）；Node `v26.12.1`、pnpm `12.15.0`、.NET SDK `11.0.100-rc.3.26522.148`、Chrome `155.0.8059.86`。
**原始日志：** [final-verify-1dcebb4.log](final-verify-1dcebb4.log)。

## 1. 完整门禁（scripts/verify.ps1，含 GPU gate）

在 `1dcebb4` 上执行完整 `scripts/verify.ps1`（`FAB_RUN_GPU_GATE=1`、`FAB_GPU_GATE_SECONDS=120`）：**退出码 0**。
[final-verify.json](final-verify.json) 的 `commit` 为 `1dcebb4...`，`gpuGate=true`。

| 门禁 | 结果 |
|---|---|
| 契约生成物 / generated-artifacts / frozen-assets / Python tools | PASS |
| architecture（flat layout / 依赖 DAG / 模块记录 / ARCH-11 高频边界） | PASS |
| start-dev 自检（节点/pnpm/端口/进程树/隔离启动/环境恢复） | PASS（含 8 个 Python 单元测试 OK） |
| .NET Release build（3 个独立项目） | PASS（0 warning / 0 error） |
| .NET 全量测试（fab_tests） | PASS（226/226，`Failed: 0`） |
| pnpm install --frozen-lockfile | PASS |
| TypeScript typecheck（tsc --noEmit） | PASS（0 error） |
| oxlint（React Compiler correctness） | PASS（0 warning / 0 error，212 文件） |
| Vitest 全量 | PASS（160 文件 / 1057 测试） |
| Vite production build | PASS |
| compiler-compat（Oxc peer/API 兼容） | PASS |
| Production browser e2e（production bundle + 固定 Chrome） | **PASS 9/9**（[production-e2e.json](browser/production-e2e.json) `commit=1dcebb4`） |
| WebGPU / no-WebGL GPU gate（`FAB_RUN_GPU_GATE=1`，120s） | **PASS**：3/3 注入循环全部恢复到 ready；最终 `webgpu=true, webgl=false, webgl2=false`；CR-08 预算熔断 fail-closed=true；`limitations=[]`（[gpu-gate.json](gpu/gpu-gate.json) `commit=1dcebb4`） |
| CORE-011 Compiler ON/OFF 独立双后端等价 | **PASS**：`equal=true`、`differences=0`、`scenarioFailures=0`、`sideEffects.equal=true`、`quiescence.timeouts=0`；ON/OFF 后端 `127.0.0.1:5191` / `5192` 独立（[equivalence-trace.json](compiler/equivalence-trace.json) `commit=1dcebb4`） |

GPU gate 的 `consoleErrors` 为 1 条，是 CR-08 预算探测**故意注入**的 fail-closed 文案
（`device-loss recovery budget exhausted; failing closed`），不是产品缺陷；主门禁循环无 console error。

## 2. 定向回归矩阵（规范 5.1）

`14 个文件 / 147 个测试通过`：

```
tests/correctness/sse/matrix-6-recovery-state.test.ts            6
tests/contract/command-recovery-phase.test.ts                   13
tests/integration/fab-runtime.test.ts                           32
tests/integration/command-transport-failure.test.ts              2
tests/integration/runtime-replacement.test.tsx                   1
tests/integration/fab-runtime-registry-handoff.test.ts          13
tests/integration/runtime-bootstrap.test.tsx                    18
tests/realtime/fab-telemetry-registry.test.ts                    9
tests/realtime/telemetry-runtime.test.ts                        32
tests/integration/command-projection-identity.test.tsx           3
tests/integration/command-actor-scope.test.tsx                   3
tests/api/sites-queries.test.ts                                  7
tests/integration/router-resource.test.tsx                       5
tests/integration/url-mapping.test.ts                            3
```

## 3. 验收项闭环对照

### R5.4-01 Unrecoverable 终态不被 Degraded 覆盖

实现：`FabRuntime.setPhase()` 在统一状态转换入口显式保留终态 `Unrecoverable` 与无权威
`Unavailable`，只有非终态才可能映射为 `Degraded`；`enterDirty()` 增加 trigger 语义，只有
外部 dirty 输入（source.dirty、replay-gap、显式 requestAuthoritativeRecovery）可以重新武装
终态；`start()`、`refreshRealtimeAvailability()`、连接状态变化、pending source 有限流结束、
普通定时器均不再清除终态或重置 attempts；`completeRecoverySuccess()` 仍是唯一 Healthy 入口。

| 场景 | 测试 | 结果 |
|---|---|---|
| T01 无 SSE + 可用 HTTP + List 连续失败 => Unrecoverable | command-recovery-phase T01、matrix-6 | PASS |
| T02 已 Unrecoverable，SSE 仍 unavailable => 不降级 | command-recovery-phase T02 | PASS |
| T03 已 Unrecoverable，连接变化/重挂载 => phase+attempts 不变 | command-recovery-phase T02/T03/T03b | PASS |
| T04 新外部 dirty => 新 episode 重置 attempts 并重跑 | command-recovery-phase T04（dirty/gaps/显式请求） | PASS |
| T05 无 SSE + HTTP Recovery 成功 => Degraded，绝不 Healthy | command-recovery-phase T05/T05b | PASS |
| T06 SSE 恢复 + Recovery 成功 => Healthy | command-recovery-phase T06 | PASS |
| T07 诊断快照含 Unrecoverable + 终态失败原因 | command-recovery-phase T07 | PASS |

### R5.4-02 HTTP 202 accepted command 交接

实现：`FabRuntimeRegistry.registerAcceptedCommand(identity, commandId, reservation)` 返回
`{kind:'registered'}` / `{kind:'recovery-pending'}` 判别联合；按 FabIdentity 持有
pendingAcceptedCommands 与 pendingAuthoritativeRecovery（只存 identity+commandId，无 payload /
Workflow / Actor / Reservation / Runtime 复制）；规则 A–E；`disposeAll()` 保留 pending；
旧 Reservation 绝不迁移、只在仍 reserved 时释放一次；新 Runtime 通过既有单命令
`getCommandStatus` 收敛（含 terminal command）；控制台两种结果都保留 commandId，并显示
“等待 Runtime 恢复”而非失败。

| 场景 | 测试 | 结果 |
|---|---|---|
| T01 remove/dispose 后 202 => recovery-pending 且保留 commandId | handoff T01/T02 | PASS |
| T02 旧 Reservation 已释放 => 不重复 release / 不 commit | handoff T02 | PASS |
| T03 新 Runtime 注册 => flush 并清除 pending | handoff T03 | PASS |
| T04 terminal command handoff 后按 commandId 查询收敛 | handoff T04 | PASS |
| T05 多个 accepted command 保留 + 全量 Recovery 合并 | handoff T05 | PASS |
| T06 新 Runtime 已存在时旧 Reservation 的 202 返回 | handoff T06 | PASS |
| T07 disposeAll 后新 generation 仍接管 pending | handoff T07 | PASS |
| T08 相同 commandId 重复交接幂等 | handoff T08 | PASS |
| T09 Runtime 缺失时 Recovery 标记保留并在注册时执行 | handoff T09 | PASS |

### R5.4-03 所有 FAB 资源统一 (siteId, fabId)

实现：新增纯领域 `FabIdentity` / `fabIdentityKey()`；Runtime Registry、Telemetry Registry、
React Hook（`useCommandProjection` / `useFabTelemetry`）、RuntimeBootstrap、Twin/Workbench
消费者、`sites.resource` / `route-data`、路由与 E2E/GPU/Compiler 脚本全部使用复合身份；
`siteByFab` 与 `findSiteByFabId` 已删除；canonical route 为
`/sites/$siteId/fabs/$fabId/3d`，旧 `/fabs/$fabId/3d` 无 alias/redirect；Telemetry 帧 wire
schema 未修改（隔离来自 site-scoped URL + 每 Runtime 身份），高频帧仍走 SSE → Worker →
TypedArray，不进入 React state。

| 场景 | 测试 | 结果 |
|---|---|---|
| T01/T02 两个 Site 相同 fabId 注册/获取不同 Runtime | runtime-bootstrap、fab-runtime、handoff composite-key | PASS |
| T03 remove(site-a) 不影响 site-b | runtime-bootstrap | PASS |
| T04/T05 两 Site 的 Command/Telemetry SSE URL 不同 | runtime-bootstrap | PASS |
| T06/T07 acquire/release 按复合身份独立计费 | fab-telemetry-registry | PASS |
| T08 相同 commandId 两 Site 不共享 Projection Atom | command-projection-identity | PASS |
| T09 loader 精确匹配 siteId+fabId，不存在组合进入 route error | router-resource | PASS |
| T10 Workbench 3D 链接同时包含 siteId+fabId | twin-entry | PASS |
| T11 旧 Site 迟到回调不能修改新 Site Projection/Telemetry | runtime-bootstrap | PASS |
| T12 同 Site 多 FAB 保持独立 Runtime/Worker/SSE | fab-runtime、runtime-bootstrap、twin-fab-scope | PASS |

## 4. 归一化与残余风险（如实记录）

1. **CI 未在本轮本地观察**：GitHub Actions 工作流（`.github/workflows/build.yml`）会在 push 后触发，
   本报告不声称 CI 结果；本地证据以 `scripts/verify.ps1` 退出码 0 为准。
2. **E2E/GPU 使用单 Site/单 FAB 开发 fixture**：多 Site、同 fabId 并存矩阵由 integration/contract
   测试覆盖（runtime-bootstrap / telemetry-registry / handoff / sites-queries / router-resource 等）。
3. **GPU gate 时长为 120s（3 个注入循环）**，不是 10 分钟 soak；完整 `gpu-gate.ps1` 支持更长时长参数。
   本轮 CR-08 预算熔断探测 PASS。
4. **Compiler 等价**：ON/OFF 独立后端 + 同一 seeded fixture + 语义静止屏障；900ms quiescence 在
   本轮运行中 0 timeout；实时 SPC/FDC 状态归一化沿用 Round 5.2 的既有说明。
5. **历史文档/证据不重写**：旧轮次 evidence JSON 与历史设计文档保留历史 URL；当前产品文档
  （README / scripts/README / IMPLEMENTATION-STATUS / architecture.md / 验收门禁）已更新为
  canonical 复合路由。
6. **R5.4-02 pending handoff 无 TTL 属设计**：Registry 生命周期结束后由 AppRuntime 释放；
   不通过 TTL 静默丢弃 202 已接受命令。
7. **Telemetry 帧不含 siteId（wire schema 冻结）**：Site 隔离由 site-scoped endpoint +
   Runtime 身份 + FAB 帧校验保证；后续若改协议必须同步后端/schema/解码器与协议测试。

## 5. 证据文件

- [final-verify.json](final-verify.json)（`commit=1dcebb4`，`gpuGate=true`）
- [final-verify-1dcebb4.log](final-verify-1dcebb4.log)（完整门禁原始输出）
- [browser/production-e2e.json](browser/production-e2e.json)（9/9，`commit=1dcebb4`）
- [gpu/gpu-gate.json](gpu/gpu-gate.json)（GPU gate PASS，`commit=1dcebb4`）
- [compiler/equivalence-trace.json](compiler/equivalence-trace.json)（ON/OFF 等价 PASS，`commit=1dcebb4`）
- [compiler/compiler-compat.json](compiler/compiler-compat.json)
