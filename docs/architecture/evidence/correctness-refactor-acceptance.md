# 正确性优先重构：验收证据索引

- 规范：`docs/architecture/05-correctness-first-target-spec.md`（冻结原文）；ADR-006/007/008/09。
- 基线：`1fb25ffc36b5b65813f031c8d889063964b4d1bd`（verify.ps1 exit 0；122 文件/726 测试——仅历史证据，不代表新架构）。
- 规则：任何 PASS 必须能由命令重跑；证据与 commit SHA 绑定；未验证项写“限制/未验证”，不得标 PASS。
- 最终整树验证：`scripts/verify.ps1`（含生产浏览器/Compiler 等价/GPU gate），结果见 `final-verify.json`；原始输出保存为 `final-verify-<sha>.log`。

## 阶段与提交绑定

| 阶段 | 状态 | 实现提交 | 证据 |
|---|---|---|---|
| A 规范冻结 | 完成 | `9dc793f` | `05`/`06`/`07`/`08`/`09` |
| B 资源重建 | 完成 | `7564cdd` | `phase-b-resource.md` |
| C 命令重建 | 完成 | `ff5f54b` | `phase-c-command.md` |
| D 后端正确性 | 完成 | `12ec565` | `phase-d-backend.md` |
| E UI/Compiler | 完成 | `d0c6f19` | `phase-e-compiler.md` + `phase-e-*.json` + `phase-e-equivalence/` |
| F 最终签收 | 本文件 + `final-verify.json` | 待最终提交 | 生产浏览器/GPU/Compiler/verify 原始日志 |

> 提交顺序按阶段独立：B(`7564cdd`)、C(`ff5f54b`)、D(`12ec565`)、E(`d0c6f19`)、F 基础设施(`3379750`)。最终签收对整树执行，不依赖单阶段提交是否可独立构建。

## CORE 测试矩阵

| ID | 位置/命令 | 结果 |
|---|---|---|
| CORE-001 | `web_app/tests/core/core-001-runtime-isolation.test.ts` | 通过（Phase B） |
| CORE-002 | `core-002-single-flight-single-poller.test.tsx` | 通过（Phase B） |
| CORE-003 | `core-003-equipment-commit.test.ts` + RED 基线日志（phase-b 证据 §1） | 通过（RED→GREEN） |
| CORE-004 | `core-004-equipment-failure.test.ts` + RED 基线日志 | 通过（RED→GREEN） |
| CORE-005 | `core-005-fab-scope.test.ts` | 通过（Phase B） |
| CORE-006 | `core-006-boundedness.test.tsx` | 通过（Phase B） |
| CORE-007 | `core-007-command-scheduler.test.ts` | 通过（Phase C） |
| CORE-008 | `core-008-command-scope-finalizer.test.ts` | 通过（Phase C） |
| CORE-009 | `core-009-command-runtime-replacement.test.ts` | 通过（Phase C） |
| CORE-010 | `core-010-command-overflow-recovery.test.ts` | 通过（Phase C） |
| CORE-011 | `core-011-compiler-equivalence.test.ts`（5 tests）+ `tools/compiler_equivalence.mjs`（equal=true，10 场景，0 差异） | 通过（Phase E） |
| CORE-012 | `core-012-production-gpu.test.ts`（4 tests）+ `tools/e2e_production.mjs`（9/9 场景）+ `tools/gpu_gate.mjs`（forceDeviceLoss 3/3 恢复；最终 600s 长稳见 final-verify） | 通过（Phase E；长稳为 F 门禁） |
| CORE-013 | `fab_tests/src/CommandPersistenceTests.cs` + `CommandRecoveryApiTests.cs`（dotnet test 197 passed） | 通过（Phase D） |
| CORE-014 | `core-014-command-teardown.test.ts` | 通过（Phase C） |

全量前端测试（E 完成后复跑）：`142 files / 793 tests passed`；`pnpm typecheck` 0 error；`pnpm lint` 0 warning/0 error；后端 `dotnet test Release` 197 passed；`generate_contracts --check` 通过。

## 最终门禁清单（F 已执行）

最终验证提交：`af002f46b6a63599205b21132538075bbfaa15a7`；`scripts/verify.ps1` **exit 0**（2026-10-30T02:18Z，GPU gate 开启、600s），原始输出 `final-verify-af002f4.log`，机器可读结果 `final-verify.json`。

- [x] `scripts/verify.ps1` exit 0（最终 SHA，含全部静态/单元/集成/后端/构建）
- [x] 生产 `vite build` + `vite preview` 浏览器功能回归（固定 Chrome 155.0.8059.86，9/9 场景，0 failed）
- [x] Compiler ON/OFF 业务 trace 等价（equal=true，0 differences，0 scenario failures，401=0；ON/OFF 产物 hash 不同 + artifact marker 自证）
- [x] GPU：真实 WebGPU、无 WebGL fallback、forceDeviceLoss 39/39 轮全部恢复、600s 长稳、live GPUDevice=2（created 81/destroyed 79）、无 console error；`Browser.crashGpuProcess` 辅助探针 recovered=true
- [x] 后端重启/游标断裂/重复幂等恢复（`dotnet test Release` 197 passed，含 CORE-013）
- [x] 架构门禁：单层目录、import 无环、唯一 registry/runner、无旧 API token、无 fallback 投影（verify 静态步骤 + `check_architecture.py`）
- [x] 文档清理与未覆盖项清单（本文件 + 旧 effect4 文档已标记为历史）

机器可读摘要：`{"commit":"af002f4","node":"v26.12.1","pnpm":"12.15.0","dotnet":"11.0.100-rc.3","gpuGate":true}`。

## 已知限制（如实登记，不标 PASS）

1. **设备丢失注入粒度与极限节奏**：主门禁用生产页 `?perf` 的 `forceDeviceLoss()`（Lite 原生 device loss，走产品同一 status lost → 重建 → ready 恢复路径）。600s/39 轮全部恢复；设备计数显示 created 81 / destroyed 79 / live 2，无 JS 或 GPUDevice 泄漏。另有一次 600s 极限节奏测试（131 次/10 分钟）在最终一轮触发 Chrome/D3D12 descriptor heap 耗尽（`ID3D12Device::CreateDescriptorHeap` OOM）；该场景是浏览器/驱动层在极端设备重建频率下的限制，不是产品业务路径，故门禁采用现实节奏（约 40 次/10 分钟）并在证据 `gpu-soak-probe.json`/报告中如实登记。
2. **GPU 进程崩溃的鲁棒性**：`Browser.crashGpuProcess` 作为辅助探针（非主门禁）；本次最终验证 recovered=true，但历史上的失败模式（GPU 进程重启窗口内 adapter 瞬态不可用，Lite #50）作为已知限制保留，不宣称“任意 GPU 进程崩溃都可恢复”。
2. **CI GPU runner**：GitHub 托管 runner 无 GPU；`.github/workflows/gpu-gate.yml` 需要 `[self-hosted, windows, gpu]` runner，未提供时以本机 600s 门禁 + 原始日志代替。
3. **Oxc peer**：无官方覆盖 oxc-transform-react 0.156.0 的 plugin-react 发布；采用维护补丁 `web_app/patches/@vitejs__plugin-react@6.1.2.patch` + `patchedDependencies`，`pnpm peers check` 仍会显示上游 registry 范围 warning（lock 保留上游范围以便审计），兼容性由 `tools/compiler_compat.mjs` 可执行证明。
4. **生成物 hash**：`tools/generated-artifacts.json` 经授权 `--update` 登记，contracts schema 已规范 LF 以避免跨平台 hash 漂移。
5. **数据窗口**：后端命令恢复只保证保留窗口内（终态 TTL 5min / 512 终态 / journal 4096）；窗口外 404/gap 是契约。
6. **浏览器 E2E 数据**：开发数据仅 1 个 FAB；跨 FAB 由集成/单元覆盖。

---

# Round 2 正确性整改（CR-01…CR-10）

- 审查基线：`9ab2fd3f3cc5304f030dbf7f8e46a414ccd4ebda`（第一轮签收）；规范：`docs/architecture/10`–`14`（ADR-010/011/012/013 + 验收矩阵）。
- 整改实现提交：F1 `b0c3e09`、F6 GPU breaker `a459c18` + `14aba4e`、F3 `2315f6c` + 架构归属修复 `9436d83`、F5 `3f91a7c`、F2 `6a8ab3d`、F4 `9ba9460`、React 19 现代化 `5133235`。
- 本文件只记录**实际执行过**的命令与结果；未完成项在“未完成/限制”中列出，不标 PASS。

## 已验证（Round 2 工作树 / 提交）

| 门禁 | 结果 | 证据 |
|---|---|---|
| 前端 `pnpm typecheck` / `pnpm lint` | 0 error / 0 warning | 本地命令与 verify 日志 |
| 前端测试 `pnpm test` | **154 files / 854 tests passed** | `.local/round2-modern-full-test.log` |
| 后端 `dotnet test Release` | **210 passed**（180 基线 + 10 持久化 + 8 故障注入 + 12 恢复 API） | `round2-f3-store.md` |
| 架构 `check_architecture.py` | PASS（`fab_app` 保持零 PackageReference；SQLite 归属 `fab_shared/Fab.Contracts`，门禁未豁免） | `round2-f3-store.md` §1.1/§7 |
| 契约/生成物 | `generate_contracts --check`、`check_generated_artifacts --check` PASS | `round2-f3-store.md` |
| 生产 bundle 浏览器 E2E | **9/9 PASS**（commit `14aba4e`，Chrome 155） | `browser/production-e2e.json` |
| Oxc 兼容门禁 | **COMPILER COMPAT PASS** | `compiler/compiler-compat.json` |
| CR 矩阵单测/集成 | 矩阵 1/2/4/5/6/7、故障注入矩阵、CORE 回归见各 phase 证据 | `round2-f2-sse.md`、`round2-f3-store.md`、`round2-f4-cancellation.md`、`round2-f5-resource.md` |
| React 19 现代化门禁 | forwardRef 等 legacy idiom 在 `src` 为 0；负向 fixture 触发全部规则 | `tests/architecture/react19-modern-syntax.test.ts` |

## 未完成/限制（明确不标 PASS）

1. **Round 2 HEAD 的 `scripts/verify.ps1` 全量运行未完成**：GPU 600s 长稳 + circuit-breaker 实机探针在启动后被中止（用户要求直接推送）。因此 Round 2 的 CORE-012 实机验收未完成；第一轮 `af002f4` 的 GPU/等价证据不能替代本轮。
2. **Compiler ON/OFF 生产等价未在 Round 2 HEAD 重跑到完成**（第一轮 `af002f4` 结果不可替代）。
3. CR-08 circuit breaker 的单元/集成测试通过（`lite-backend-recovery.test.ts` 17 tests，含 `?perf&recoveryBudget=8` fail-closed 与 plain `?perf` 默认预算），但**真实 WebGPU fail-closed 探针未在实机跑完**。
4. 真实后端 400/409 端到端联调（F3↔F4）未执行，登记为 F7 待办。
5. 最终 `final-verify.json` / `final-verify-<sha>.log` 未生成；Round 2 签收需按矩阵 F7 重新执行全量 verify 并绑定新 SHA。
6. 本轮按用户指令直接提交/推送，GitHub CI（含 gpu-gate workflow）以实际运行为准。
