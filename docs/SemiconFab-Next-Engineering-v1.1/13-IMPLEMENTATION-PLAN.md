# 13 — 实施路线、交付包与架构治理

## 1. 总路线

| Phase | 开发重点 | 必交付的验收证据 |
|---|---|---|
| 0 | 行业业务访谈、标准采购、FabTemplate 真实性审查、GPU/数据库支持矩阵 | 需求基线与标准矩阵，假设清单有负责人 |
| 1 | Monorepo、.NET Domain、TS Contracts、PostgreSQL、WebGPU-only 空场景、身份鉴权 | 全部项目可构建、契约生成一致、无 WebGL |
| 2 | C# DES、Lot/Equipment/Route、3 FAB Independent、KPI、Scenario/Run | 确定性、三 FAB 隔离、Python 对照实验 |
| 3 | 快照/回放、Parquet、WebSocket/Protobuf、Site/FAB/Equipment 视图 | 完整轨迹、断线恢复、60 FPS 目标测量 |
| 4 | Chamber/FOUP/Carrier、MES/EAP 模拟器、GEM300 部分模型 | 状态机/协议模拟器回归、业务约束 |
| 5 | SiteResource 模型与 `SHARED_CAPACITY`、统一逻辑时钟 | 并发争用、故障、恢复、安全不超配 |
| 6 | AMHS/Stocker、Yield、FDC/SPC、优化接口、Site 联合研究 | 厂务参数来源、全业务端到端场景 |
| 7 | 真实设备接入、互操作与合规证据、规模化部署 | OT 安全审批、独立认证/协议测试、DR/HA 演练 |

各阶段可并行交付模块，但必须继承相同领域、时间、身份、契约和模板版本体系；禁止为显示效果临时另造 3D 权威状态。

## 2. Monorepo 规划

```text
apps/web/                          React/Vite SPA
apps/Fab.Api/                      ASP.NET Core Control Plane
apps/Fab.Worker/                   .NET Simulation Worker
apps/Fab.RealtimeHost/             实时发布，可先并入 API
apps/Fab.OtGateway/                独立 OT 安全域
frontend/packages/                Contracts、UI、场景、WebGPU、同步、图表
src/Foundation/                   IDs、Contracts、映射与基础设施适配
src/{Site,Manufacturing,...}/      按领域划分的 Domain/Application/Infrastructure
src/Simulation/                   Core、Models、Runtime、SiteCoordinator
native/Fab.Native/                可选 MSVC C++ 热点
contracts/{protobuf,openapi,json-schema}/ 规范化协议与输入 Schema
infrastructure/                   安全、运维和部署
tests/                            行为、契约、性能、GPU 与恢复验收
```

以上为概要；唯一完整布局见 `engineering/10-REPOSITORY-SOLUTION-LAYOUT.md`。本规范包中的 `contracts/fab_events.proto` 与 `examples/` 是设计参考工件，实施时归入该布局，不代表目标仓库已经存在。

建议使用 `.slnx` 与 CMake presets；核心模块依赖方向 `Presentation -> Application -> Domain`，基础设施只通过接口提供服务。避免按文件夹命名伪装松耦合，重点是执行项目引用和接口依赖检查。

## 3. 强制 ADR 模板

```
ADR-ID / 标题 / 状态（Proposed/Accepted/Superseded）
业务背景 / 备选方案 / 决策 / 驱动因素
一致性及时间语义 / 安全影响 / 性能预算 / 数据迁移
降级与回滚 / 约束的自动化测试 / 审核人和日期
```

新引入分布式系统、语言、框架、ORM、GPU 绑定、数据库时需提交 ADR 并附性能、生态活跃度、许可证、维护与故障域评估。

## 4. 版本升级与长期维护

- **不冻结永久软件版本**，冻结能力契约、领域与事件语义。
- TypeScript/React/Vite/Babylon/.NET/PostgreSQL 使用经回归的当前正式版；RC/Preview 在隔离验证分支测验；对于必须上线的环境采用经认证的稳定版。
- 依赖变更 CI 包括 Protobuf/OpenAPI schema diff、数据库回滚/升级、3D WebGPU 兼容测试、工业模型黄金轨迹、性能回归。
- 商业组件引入前进行许可、维护风险和供应链评估；原始 SemiconFab 的 PolyForm Noncommercial 授权不能通过改写语言规避。

## 5. 关键岗位与评审职责

架构负责人、FAB 工艺/制造专家、MES/EAP/SECS GEM300 专家、AMHS/厂务专家、仿真算法/统计负责人、GPU 工程师、数据库负责人、安全/OT 负责人、质量负责人。标准符合性与厂务参数需由领域专家复核，不能仅由开发人员凭名称推断。

## 6. 第一批实际行动

1. 冻结三 FAB 独立 Site 模型及当前未知共享设施清单。
2. 建立 3 FAB 单模板的 Scenario JSON 及校验工具。
3. 构建不连接真实设备的标准域状态机、可重复 DES 和 Site KPI 聚合。
4. WebGPU-only 3D 场景展示三 FAB 模板实例，确认驱动和 GPU 准入矩阵。
5. 建立共享资源 `SHARED_CAPACITY` 的争用最小演示并通过超配/死锁/恢复测试。
6. 分模块获取厂商 GEM300 接口规范及各项 SEMI 标准版次，按真实证据规划协议实施。
