# 16 — 研发分工、CI/CD、测试、性能与验收

## 1. 研发工作流

所有需求包含 `RequirementId -> ModuleId -> Interface/Schema -> UnitTest -> IntegrationTest -> AcceptanceEvidence`。新增模块须拥有责任人、ADR、公开 Port、失败/重试语义、字段单位/时间语义、审计字段和风险登记。开发先写契约/假设/不变量测试，再实现业务逻辑。

## 2. CI Build Matrix

| Pipeline | 环境 | 必跑项 | Release blocker |
|---|---|---|---|
| `dotnet-build` | Windows x64 VS/MSVC + .NET SDK 锁定 | restore/build/analyzers/format/test | 失败阻断 |
| `frontend` | Node/pnpm/TS 锁文件 | lint/tsc/vite build/vitest | 失败阻断 |
| `contracts` | proto+OpenAPI generators | buf lint/breaking、生成代码 diff | 不兼容阻断 |
| `database` | PostgreSQL 目标版本 | migrate up/down/constraint/RLS/testcontainers | 数据丢失阻断 |
| `sim-golden` | CPU 固定基准 | deterministic replay/checkpoint/random stream | hash 不一致阻断 |
| `shared-resources` | 独立与共享场景 | 同时刻仲裁、容量、恢复、跨 Fab 隔离 | 超配/串扰阻断 |
| `webgpu-gpu` | Windows 自托管真实 GPU | adapter init/deviceLost/frame tests/no WebGL | 不满足准入阻断 |
| `security` | GitHub Actions | SAST、依赖/SBOM、secret scan、OT deny by default | 高严重未处理阻断 |
| `native` | VS/MSVC Release+Debug | C ABI、ASan（适用）、benchmark、memory ownership | ABI 破坏阻断 |

以上为目标应用 CI，不代表规范包已具备这些流水线。当前文档包独立检查 `python tools/maintain_docs.py --check`：验证合并版、文件清单/哈希、内部文件链接、模块清单及需求测试引用。该检查不替代 C#/TS 编译、PostgreSQL 运行、GPU、协议或工业符合性测试。

前端矩阵须分开记录 TypeScript 7 类型检查器与使用编译器 API 的 ESLint/代码生成工具。后者若尚不兼容，不得因 `tsc` 单项通过就认为整条链路通过；版本处置与官方来源见 `90-DECISIONS-AND-OPEN-ITEMS.md`。

## 3. 模块测试矩阵

- Domain：实体值对象不可非法构造；状态机所有合法/非法跃迁；单位转换与溢出；对不同 FAB 复用显示编号不发生串扰。
- Application：命令幂等、并发冲突、授权、领域事件发布、Outbox 事务一致性、读模型重建。
- Simulation：事件稳定排序、同 seed 重放、RNG 隔离、快照恢复、异常中断、Warmup/KPI、统计置信区间。
- Shared Capacity：`INDEPENDENT` 不存在跨 FAB 影响；`SHARED_CAPACITY` 同时刻多个 FAB 申请不超配，重试不多授、故障不双主。
- EAP/GEM300：按获授权版次/设备 Profile 进行 message/state/alarm/correlation/timeout 测试；未满足证据不可标记合规。
- AMHS：路段互斥、入/出 Stocker、Carrier 单位置、失败重路由；与动画脱钩测试。
- 数据库：复合 FK、unique、RLS、被拒绝跨 FAB 写入、migration 前后历史读取；恢复演练必须覆盖对象存储。
- 前端：3D 无 WebGL context、Device Lost、权限、场景导入错误、切换 FAB 无状态泄漏、snapshot-gap recovery。

发布阻断用例的稳定 ID 及新增的生命周期、租约、RLS、投影流检查统一引用根目录 `12-VERIFICATION-ACCEPTANCE.md`，需求映射见 `14-TRACEABILITY-REGISTER.md`；工程文档不再另起一套同义测试编号。

## 4. 质量门禁标识

`G0` 标准适用性与数据范围；`G1` 合约与基础 schema；`G2` 三 FAB 完全隔离端到端；`G3` 独立 DES + replay + KPI；`G4` WebGPU 3D 联动；`G5` 共享容量协调端到端；`G6` MES/EAP/GEM300 Simulator；`G7` OT 只读接入及安全隔离（如业务批准）；`G8` 灾备与性能验收。

不得因 `G5` 尚未要求部署真实共享设施而省略共享容量的合成测试；不允许将浏览器演示替代真正的 DES 验证。

## 5. 性能测试与生产 SLO

建议测试工作负载（待现场规模签字）：`Site=1, Fab=3, Equipment=1k/fab, ConcurrentRuns=8, DES=100k event/s/run candidate, WebGPU target=60FPS`。所有建议值必须明确硬件、模型事件分布、GPU/驱动、温度/功耗、网络/延迟、观测持续时间。性能对比以统计显著与置信区间进行，不将单次最快结果作为指标。

核心性能预算需包含：引擎 Event/sec、simulatedDays/wallSec、平均与峰值内存、Checkpoint 时延与大小、Worker 再启动时间、API p95/p99、WebSocket connection/backpressure、GPU frame budget、3D streaming bytes/sec。性能未达标先 Profile 后选择 C++ 加速。

## 6. 阶段拆分

| 阶段 | 关键模块 | 必须拿到的证据 |
|---|---|---|
| S0 基础仓库 | M01/M16/M18 + Contracts/DB | 可重建 Windows CI、认证、配置、编译与 migrations |
| S1 三 FAB 概念 | M01/M02/M03/M04/M06 | Template 实例化 3 FAB、Lot/Tool 约束通过 |
| S2 仿真闭环 | M07/M08/M09/M10/M17 | 3 FAB 互不影响、可暂停恢复、KPI/轨迹导出 |
| S3 WebGPU 联动 | M11/M12 | WebGPU-only 三 FAB Site View + FAB View、断线重连 |
| S4 共享设施 PoC | M07/M08/M09 | 合成容量冲突、确定性授予、Crash 恢复 |
| S5 行业域扩展 | M05/M13/M14/M15 | AMHS/设备协议/Profile/FDC 的隔离模拟与验证 |
| S6 工业化 | 全模块 | 安全分区、合规差距台账、性能与灾备验收 |

阶段完成是**通过功能证据**，不是根据日历月份或代码行数。
