# SemiconFab Next — 详细工程设计规范索引（EDS v1.1）

> 基准：2026-10-23；状态：**可供工程拆分与 PoC 实施的设计基线，非已完成实现、非 SEMI/IEC 符合性认证**。本目录为 `01`—`14` 文档的**增量工程细化**，原标准与架构约束仍然有效。具体目录以 `10`、项目引用以 `11/21`、表与 Owner 以 `13`、协议以根目录 `08` 及其工程细化为准；其他概述不得另起同义定义。真正改变领域或安全语义的冲突按 `90-DECISIONS-AND-OPEN-ITEMS.md` 提交 ADR。

## 不可变约束

- 一个 Site，当前 3 个同构 FAB（FAB-01、FAB-02、FAB-03）；`N` 是运行配置，不是编译期常数。
- Site 统一配置、运营管理、认证、监控和只读汇总。每个 FAB 的物理设备、Lot、状态机、仿真时钟、事件队列和 PRNG 流独立；默认 `INDEPENDENT`。
- 共享厂务设施尚未确认。模型预留 `SiteResource`、Contract、Allocation、Coordinator；**不得默认实例化实际共享设施**。`SHARED_CAPACITY` 启用时必须采用单一权威的确定性时序/仲裁域。跨 FAB 物料流转仍默认禁用。
- 前端 React + TypeScript 7 目标线 + Vite 8 + Babylon.js 9 目标线；**仅 WebGPU，绝不创建 WebGL fallback**。
- ASP.NET Core/.NET 11 目标线；Windows x64 首发，Visual Studio 2026 Enterprise + MSVC；PostgreSQL 稳定正式版，数据迁移流程前置。候选版/工具包具体版本均通过 CI Compatibility Matrix 验证，不因“最新”忽略兼容性。
- 后端权威 DES；React/Babylon 只消费投影。Server 不使用浏览器渲染对象；DES 不在热路径中调用数据库或网络。
- 真实设备 OT 写命令 **默认禁止**。仿真 Adapter 与 OT Gateway 网络、身份、命令能力分离。

## 文件导航

| 文档 | 交付物/用途 |
|---|---|
| `10-REPOSITORY-SOLUTION-LAYOUT.md` | monorepo、C# 解决方案、前端 workspace、命名与引用规则 |
| `11-DEPENDENCY-RULES-AND-DI.md` | 分层依赖矩阵、契约、依赖注入、领域事件与 Outbox |
| `12-EXECUTION-TOPOLOGY.md` | 独立/共享模式运行拓扑、Job/Worker/Coordinator、故障恢复 |
| `13-DATABASE-DETAIL-DESIGN.md` | schema 所有权、具体表、事务与租户隔离、读模型 |
| `14-CONTRACTS-AND-EVENT-FLOWS.md` | REST、Protobuf、gRPC、WebSocket、Envelope、关键时序 |
| `15-FRONTEND-AND-WEBGPU-PROJECTS.md` | React package、Babylon 渲染层、GPU 与数据同步 |
| `16-QUALITY-AND-DELIVERY.md` | CI、测试分层、矩阵、门禁、性能验收与迭代顺序 |
| `17-INDUSTRY-COMPLIANCE-PROFILES.md` | ISA-95、SEMI/GEM300、IEC 62443 等实现定位与证据要求 |
| `18-TECHNICAL-CONTRACT-EXAMPLES.md` | C# 类型/接口、TS、proto、DDL、事务示例及注意事项 |
| `19-DELIVERY-WORKPACKAGES.md` | 模块交付依赖、工作包与完成定义 |
| `20-WINDOWS-DEV-SETUP.md` | Windows 工具链、未来启动命令与环境验收 |
| `21-PROJECT-REFERENCE-MATRIX.md` | 项目引用与部署单元约束 |
| `90-DECISIONS-AND-OPEN-ITEMS.md` | 技术选型状态、风险、冻结与后续调研事项 |
| `modules/M01`—`M18` | 各模块可开发的工程规格、公开 API、数据所有权、事件、测试与 Done |
| `MODULE-MATRIX.csv` | 模块依赖与负责人模板，导入 Excel/项目管理系统 |

## 约定

- `Domain` = 不依赖 EF Core/HTTP/消息框架/Three.js/Babylon 的业务语义。
- `Application` = 用例编排、授权与事务边界；不得维护与 Domain 重复的状态机。
- `Infrastructure` = Npgsql/文件存储/网关/协议适配，依赖 `Domain + Application`，反向依赖禁止。
- `Contracts` = 独立公开的版本化 DTO/proto/Schema；不能把 EF 实体/领域 Aggregate 直接做 REST 或 Protobuf payload。
- `Simulation Runtime` = 独立的时间与状态一致性域；领域业务命令按已定义边界投射成仿真事件。
- `Projection` = 可重建的读取模型；不得误当作权威事件日志。
- `Example` = 可供实现参考的片段；代码片段的可编译性须由实际项目验证。

## 开发前最低冻结项

必须签署：FAB 范围、设备/Chamber/Lot/Wafer 粒度、共享设施列表或明确“暂未确认”、数据保留与隔离等级、性能基准机器、SEMI 标准正版版次、是否接入实际设备。未定项采用安全的显式缺省值，详见 `90-DECISIONS-AND-OPEN-ITEMS.md`。
