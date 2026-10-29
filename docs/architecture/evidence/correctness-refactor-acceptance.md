# 正确性优先重构：验收证据索引（进行中）

- 规范：`docs/architecture/05-correctness-first-target-spec.md`
- 基线：`1fb25ffc36b5b65813f031c8d889063964b4d1bd`（verify.ps1 exit 0；122 文件/726 测试——仅历史证据）
- 规则：任何 PASS 必须能由命令重跑；证据文件与 commit SHA 绑定；未验证项必须写“限制/未验证”，不得标 PASS。

## 阶段状态

| 阶段 | 状态 | 证据 | SHA |
|---|---|---|---|
| A 规范冻结 | 完成（本文档提交） | `05``06``07``08``09` | Phase A commit |
| B 资源重建 | 进行中 | `phase-b-resource.md` | pending |
| C 命令重建 | 进行中 | `phase-c-command.md` | pending |
| D 后端正确性 | 进行中 | `phase-d-backend.md` | pending |
| E UI/Compiler | 进行中 | `phase-e-compiler.md` | pending |
| F 最终签收 | 未开始 | 本文件 + GPU/浏览器原始日志 | pending |

## CORE 测试矩阵（逐项要求证据）

| ID | 测试文件/命令 | 结果 | 证据引用 |
|---|---|---|---|
| CORE-001 | tests/core/core-001-*.test.ts | pending | |
| CORE-002 | tests/core/core-002-*.test.ts | pending | |
| CORE-003 | tests/core/core-003-*.test.ts（含 RED 基线日志） | pending | |
| CORE-004 | tests/core/core-004-*.test.ts（含 RED 基线日志） | pending | |
| CORE-005 | tests/core/core-005-*.test.ts | pending | |
| CORE-006 | tests/core/core-006-*.test.ts | pending | |
| CORE-007 | tests/core/core-007-*.test.ts | pending | |
| CORE-008 | tests/core/core-008-*.test.ts | pending | |
| CORE-009 | tests/core/core-009-*.test.ts | pending | |
| CORE-010 | tests/core/core-010-*.test.ts | pending | |
| CORE-011 | tests/core/core-011-*.test.ts + tools/compiler_equivalence.mjs | pending | |
| CORE-012 | tools/e2e_production.mjs + tools/gpu_gate.mjs | pending | |
| CORE-013 | fab_tests/src/CommandPersistenceTests.cs + tests/api/command-recovery-schema.test.ts | pending | |
| CORE-014 | tests/core/core-014-*.test.ts | pending | |

## 最终门禁（Phase F 填写）

- [ ] `scripts/verify.ps1` exit 0（最终 SHA）
- [ ] 生产 `vite build` + preview 浏览器功能回归（固定 Chrome，记录版本）
- [ ] Compiler ON/OFF 业务 trace 等价（hash 记录）
- [ ] GPU 真实 WebGPU + 设备丢失/恢复 + 5–30 分钟长稳（原始日志）
- [ ] Compiler ON/OFF 的 BigInt/StrictMode/Atom 订阅/FAB 切换/GPU 生命周期差分
- [ ] 架构门禁：单层目录、import 无环、唯一 registry/runner、无旧 API token、无 fallback 投影
- [ ] 后端重启/游标断裂/重复幂等恢复（CORE-013）
- [ ] 文档清理：旧 effect4 冲突描述标记取代；README 状态更新
- [ ] 未覆盖项与限制清单
