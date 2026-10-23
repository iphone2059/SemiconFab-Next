# 90 — 技术决策状态、未决事项与变更治理

## 1. 已冻结架构 (FROZEN)

- 1 个 Site / 当前 3 个完全同构 FAB；FabTemplateVersion 重用、运行状态独立。数量 3 不写死。
- `INDEPENDENT` 默认；`SHARED_CAPACITY` 通过已发布 Scenario/资源图启用；`COUPLED_FLOW` 仅预留，不作为当前行为。
- React + TypeScript + Vite + Babylon.js，WebGPU-only；不接受 WebGL 回退。
- ASP.NET Core/.NET、PostgreSQL、C# 确定性 DES + 独立 Worker、Protobuf 契约；可选 C++ Native.
- Domain/Simulation 内核不依赖基础设施；数据库非事件热路径；OT 真实控制默认禁止。

## 2. 已选但版本未冻结 (SELECTED)

- TypeScript 7 主线、React 19、Vite 8、Babylon 9 等采用经过测试的最新正式 patch；锁文件/Release Manifest 记录确切版本。不能在此文档中长期把某个 patch 写作“始终最新”。
- TypeScript 7 类型检查器与依赖编译器 API 的工具分别验证；7.0 已正式发布，但没有稳定的编程 API，不能由 `tsc` 通过推断 ESLint/代码生成工具兼容。必要时按官方并存方案为工具使用锁定的兼容编译器包，或暂缓升级；不得静默省略 Lint/契约生成。
- .NET 11 目标发布线：2026-10-23 核实时官方已发布 RC2，尚未 GA。官方 RC2 提供 go-live 支持，但本项目仍选择 GA 加 EF/Npgsql/OT SDK 全链路兼容验证后进入生产；这是项目准入策略，不是断言 RC 无官方支持。
- PostgreSQL 19 目标线：2026-10-23 官方版本页列出 19 RC1，受支持正式主线为 18 等；正式可用前使用受支持稳定分支进行生产验证。不得只改镜像标签原地跨主版本升级；按目标版文档使用 `pg_upgrade` 或导出/恢复并做数据与 Artifact 一致性演练，真实迁移由 DBA 主导。
- 认证实现 OIDC、UI 默认 Ant Design、TanStack Query、Zustand、ECharts；组件变更不影响 Domain 或 API。

### 版本核实出处（快照：2026-10-23）

- [TypeScript 7.0 发布及编程 API/6.0 并存说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)。
- [.NET 11 RC2、go-live 支持及 VS 2026 Insiders 要求](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-2/)。
- [PostgreSQL 版本支持与跨主版本升级政策](https://www.postgresql.org/support/versioning/)。
- [Vite Node.js 要求](https://vite.dev/guide/)、[Node.js 发布与 LTS 支持](https://nodejs.org/en/about/previous-releases)。
- [Windows 10 Home/Pro 生命周期](https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro)。

上述是本次核实的时点事实，不是永久版本约束；正式支持组合仍由锁文件和 Compatibility Matrix 决定。

## 3. 现场必须确认 (OPEN)

| ID | 决策问题 | 当前缺省/风险控制 |
|---|---|---|
| O-001 | 三 FAB 是否共享 UPW/CDA/厂务供电/排风/特气 | 默认不共享；仅合成共享场景作架构测试 |
| O-002 | FAB 内真正的 ToolGroup/Equipment/Chamber 数量 | 不凭空确定；参数化规模基准 |
| O-003 | 跨 FAB Lot/Carrier 转运是否存在 | 禁止；预留未来单独审批扩展 |
| O-004 | 现实接入 MES/EAP/AMHS 系统的厂家、协议、版次 | 仿真 adapter 独立，默认禁写实机 |
| O-005 | 开发/生产首发机型与 GPU/驱动准入标准 | 通过 WebGPU 能力和真实 GPU 压测来签字 |
| O-006 | 运行期规模、并行 Run、网络数据率、存储保留 | 在需求与容量测试确定后冻结 SLO |
| O-007 | 区域与数据合规/信息分类/审计保留 | 默认限制访问，禁止擅自流向公有云 |
| O-008 | License：SEMI 原文、UI Enterprise、协议 SDK 商业授权 | Legal/采购审查；允许替换适配实现 |
| O-009 | 是否需要在线真实数字孪生而非离线仿真 | 优先离线，可选 read-only telemetry overlay |
| O-010 | Site 共用身份系统（AD/OIDC） | 建身份适配层，不硬编码域账号/密码 |

每项 OPEN 在进入相关交付门禁前必须登记 `owner / target_gate / due_date / decision / evidence_uri / closed_at`。未获得业务数据时使用明确标记的合成场景，不用假设值关闭事项。负责人和日期由项目实际分配，本次文档审阅不虚构签署人。

## 4. 兼容与 ADR 程序

更改技术栈必须证明：当前组件有严重维护风险、不可修复缺陷或无法满足验收目标；先提交 benchmark、迁移矩阵、兼容性评估、升级/回退路径，审查通过后更新 ADR。一般版本升级按 CI 决定，不应称作改变架构。

## 5. 不可接受实现

- `if (fabId == 1)` 等硬编码三个 FAB；共用可变状态容器或 RNG。
- 把 Babel/TypeScript 构建速度改进误称为运行时 DES 性能改进。
- 为支持“WebGPU Only”却在不支持 GPU 时偷偷初始化 WebGL。
- 在共同资源模式下让多个 FAB Worker 用普通消息抢占同一个物理容量而无逻辑时间协议。
- 将仓库模拟器结果/设备状态可视化当成真实设备安全控制/SEMI 符合性证明。
