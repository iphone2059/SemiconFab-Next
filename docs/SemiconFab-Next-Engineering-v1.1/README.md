# SemiconFab Next — 工业级多 FAB 数字孪生与仿真平台规范包

> 基线日期：2026-10-23　|　规范包：1.1（架构基线 1.0 + 工程细化）　|　状态：**架构设计基线 / 待业务与标准符合性审查**
>
> 适用：1 个 Site，当前 3 个结构完全相同的 FAB Unit；初始运行互不影响；Site 统一管理与监控；共享设施的实际存在与边界尚未明确，设计必须支持独立与共享两种运行模式。


## V1.1 详细工程设计增补（本版新增）

在原 V1.0 规范基础上新增 `engineering/` 工程落地规范：

- **18 份独立模块开发规范**：`engineering/modules/M01`—`M18`，逐个说明职责、C# 项目/前端 package、命令与查询 API、领域事件、数据表、三 FAB 约束、测试与 DoD。
- **14 份横向工程文档**：工程目录、依赖规则、Worker/共享容量、数据库、协议、React/WebGPU、CI/发布、行业标准、类型与实现示例、任务工作包、Windows 环境、项目引用矩阵、待确认事项等。
- **机器可读模块清单**：`engineering/MODULE-MATRIX.csv`，用于项目管理与职责分配。
- 推荐阅读路径：`engineering/00-ENGINEERING-INDEX.md` → `engineering/10-REPOSITORY-SOLUTION-LAYOUT.md` → `engineering/11-DEPENDENCY-RULES-AND-DI.md` → 各自模块 → `engineering/16-QUALITY-AND-DELIVERY.md`。

**文件性质**：本版交付的是正式工程设计规范和参考片段，并不包含已构建、运行、测试通过的完整应用源码。工业协议/标准的模型映射也不等于符合性认证。

**维护入口**：逐文件规范是编辑源；[合并版规范](合并版规范.md)是自动生成的完整阅读副本。[本次审阅记录](REVIEW-2026-10-23.md)说明修正、清理和未决事项。修改后执行 `python tools/maintain_docs.py --write`，再执行 `python tools/maintain_docs.py --check`，同步合并版与当前清单；`BASELINE-MANIFEST-v1.0.json` 只记录历史基线，不用于校验现有文件。

## 0. 先读此页

本规范包为研发与技术验收提供可执行约束，而**非**任何标准组织的授权标准全文、第三方认证或已完成的设备符合性声明。SEMI 标准通常需要获取正版文本以逐条形成合规证据。标准编号及公开介绍见 `02-INDUSTRY-STANDARDS.md`。

### 基线技术

- 前端：React + 最新经过 CI 验证的稳定 TypeScript（目标 TS 7）+ Vite + Babylon.js，**WebGPU Only，无 WebGL fallback**。
- 后端：ASP.NET Core / .NET 11 目标线；正式版与全部第三方依赖兼容之后才进入生产版本。
- DES：C# 确定性离散事件内核；C++/MSVC 性能热点可选加速；不得牺牲跨语言语义一致性。
- 数据：PostgreSQL、对象存储、Arrow/Parquet；OpenAPI + Protobuf；REST 控制面、SignalR 业务通知、Binary WebSocket 3D 状态流、gRPC 服务内部通信。
- 工程：Windows x64 首发；服务器应用层保留跨平台能力。pnpm monorepo；VS 2026 Enterprise + MSVC；CI 锁定依赖版本。

### 编号规范文件

| 文件 | 内容 | 主要验收输出 |
|---|---|---|
| `01-SCOPE-REQUIREMENTS.md` | 场景、边界、分级业务需求 | 需求追踪矩阵 |
| `02-INDUSTRY-STANDARDS.md` | SEMI、ISA-95、IEC、ISO 标准适用性 | 逐标准能力与证据矩阵 |
| `03-SYSTEM-ARCHITECTURE.md` | 控制面、仿真面、数据面及 ADR | 系统拓扑与部署约束 |
| `04-FAB-DOMAIN-MODEL.md` | Site–FAB–Tool–Lot–Carrier 模型 | 强类型聚合及不变量 |
| `05-DETERMINISTIC-DES.md` | 时间、事件、种子、并行、快照 | 确定性与统计测试 |
| `06-SHARED-RESOURCE-MODES.md` | 无共享、共享容量、强耦合模式 | 独立隔离及共享仲裁测试 |
| `07-DATA-STORAGE.md` | PostgreSQL、事件与资产存储 | 数据结构、约束、RLS、迁移 |
| `08-API-EVENT-CONTRACTS.md` | REST、Protobuf、实时状态同步 | 版本兼容、重放与背压 |
| `09-WEBGPU-RENDERING.md` | React + Babylon WebGPU 专用规范 | 兼容性、GPU 退化与性能 |
| `10-INDUSTRIAL-INTERFACES.md` | EAP、MES、GEM300、AMHS、OPC UA | 模拟器与协议符合性矩阵 |
| `11-SECURITY-OPERATIONS.md` | 网络安全、RBAC、运维与观测 | 威胁模型与灾难恢复演练 |
| `12-VERIFICATION-ACCEPTANCE.md` | 功能、性能、统计及行业验收 | 可追溯测试报告 |
| `13-IMPLEMENTATION-PLAN.md` | 工作包、质量门禁、架构治理 | 版本化交付计划 |
| `14-TRACEABILITY-REGISTER.md` | 需求、设计、标准与测试映射 | 证据登记和未评估状态 |

### 示例工件

- `contracts/fab_events.proto`：二进制事件 / 快照契约示例。
- `examples/sql/001_initial.sql`：最小可执行 PostgreSQL 基础模型示例。
- `examples/scenarios/site_independent.json` 与 `site_shared_capacity.json`：两种模式示例配置（示例容量仅作说明）。
- `examples/ts/webgpu-only.ts`：Babylon.js WebGPU-only 启动模板。

### 标准用语

- **MUST/必须**：评审通过的强制性工程约束。
- **SHOULD/宜**：强烈建议；偏离须记录原因。
- **MAY/可**：扩展能力。
- **标准适配**：按标准概念建模，不自动构成符合性声明。
- **合规**：只有逐标准版本/条款实施、测试、留存证据后才能声明。
- **FabTemplate**：不可变版本化物理与工艺蓝图；**FabUnit**：对蓝图的实际实例化。
- **Run**：输入、版本和种子冻结的一次仿真执行，运行状态按生命周期迁移；**Scenario**：初始条件与策略配置。
- **Site**：基地；**SiteResource**：跨 FAB 可被授权共享的资源。

### 最关键的五项不可变原则

1. `FAB-01`、`FAB-02`、`FAB-03` **相同模板、不共享运行状态**，任何模块不硬编码数量 3。
2. 初始配置必须是 `INDEPENDENT`；基地汇总只读；共享资源按版本化配置显式启用。
3. 若一个资源受多个 FAB 同步竞争，必须由权威逻辑时钟/协调器决定分配，不允许仅靠最终一致数据库模拟物理约束。
4. **权威仿真状态只在服务端**；WebGPU 场景是派生投影；断线可按快照恢复。
5. 对外不得将示意性工艺、3D 洁净室、模拟协议直接宣称为已通过 SEMI/ISO/IEC 认证。

### 初步假设登记（必须在现场调研中关闭）

| ID | 未确认项 | 处理策略 |
|---|---|---|
| ASSUMP-001 | 三 FAB 是否共享 UPW / CDA / HVAC / 电力 / 特气等公用工程 | 只建能力，默认不共享 |
| ASSUMP-002 | 是否存在跨 FAB Lot/FOUP 搬运 | 默认不允许；需独立工艺许可与路线模型 |
| ASSUMP-003 | 每 FAB 机台数、Chamber 数、Lot 数 | 根据规模验收表确定，不凭空写入固定值 |
| ASSUMP-004 | 真实设备对接范围与 SECS/GEM 设备清单 | 先使用协议模拟器、再基于厂商接口文件签约 |
| ASSUMP-005 | 部署在 OT、IT 还是仿真隔离网络 | 按 IEC 62443 风险评估决定 |
| ASSUMP-006 | 具体法规、厂商授权与采购标准版次 | 上线前由合规负责人确认 |

改变架构原则、领域语义、时间或安全边界时提交 ADR（架构决策记录），并同步受影响的契约、迁移和验收用例。文字勘误、索引修复和已有规则的一致性修正记录在修订说明中，无需为每项建立 ADR。未经审批不得改变上文五项原则。
