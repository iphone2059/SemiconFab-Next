# 11 — 安全架构、部署与运维规范

## 1. 安全域与角色

- IT 管理域：用户/租户/审批/研发环境。
- 仿真域：Fab Worker、Site 共享协调器、仿真 PostgreSQL、对象存储。
- 展示域：浏览器与只读实时网关。
- OT Gateway 域：仅在获批连接真实设备后启用，单独风险评估及安全通道。

设计按 IEC 62443-3-2 的 Zone/Conduit 方法做风险分析，并采用 IEC 62443-4-1 安全开发生命周期；**本规范不能代替正式安全等级评定**。

## 2. 身份与权限

- OIDC/OAuth 2.0；与企业 AD/IdP 集成但不依赖明文域管理员密码。
- RBAC 基础角色：SiteAdmin、SiteObserver、FabEngineer、FabOperator、SimulationResearcher、Auditor、OTGatewayOperator。
- 服务端验证 Token 的签发方、受众、有效期，并从可信 Claim 或服务端授权目录解析租户/Site/FAB 权限；不能相信浏览器传入的 fab_id 即可取得权限。权限变更和 Token 过期同样适用于既有订阅与 Artifact 下载授权。
- 功能权限：ViewSite、ViewFab、EditTemplate、PublishScenario、RunSimulation、AccessArtifacts、ManageResourceContracts、ControlRealEquipment。
- 真实设备写操作要求独立审批、操作日志、双人复核（依据厂规）、网络白名单；最小权限设计。

## 3. 网络与传输

- 统一 HTTPS/TLS，内部 RPC 使用身份验证与 TLS（需要时 mTLS）。
- PostgreSQL 不暴露公网；对象存储的读写通过受控身份及短期签名地址。
- WebSocket 连接前鉴权，订阅时再次校验 Site/FAB 范围；不得开放任意资源 ID 查询。
- 工业协议 Gateway 与 API 分网络分权限；现场只读模式不能调用写命令。

## 4. 审计与可观测性

- OpenTelemetry Trace/Metrics/Logs；统一 `trace_id`、`run_id`、`fab_id`、`site_id`、`equipment_id`。
- 安全审计包括登录、权限变化、场景发布、共享配额修改、真实设备命令与导出。
- 日志不得含凭据、私钥、员工个人敏感信息；对商业机台/Recipe 参数应按保密策略分类。
- 指标：API p95/p99、Worker 吞吐和内存、任务失败率、队列长度、事件同步积压、GPU 设备丢失率、快照恢复时间、权限拒绝次数。

## 5. 高可用与灾难恢复

- Worker 按执行域持有租约与 fencing token：`INDEPENDENT` 为 `(site_id, run_id, fab_id)`，`SHARED_CAPACITY` 为 `(site_id, run_id)` 的完整协调域。失联旧 Worker 不得继续提交检查点、发布结果或推送权威增量；存储与发布端均校验有效租约和 epoch。
- Run 持久状态统一为 `QUEUED/CLAIMED/RUNNING/PAUSED/STOPPING/COMPLETED/FAILED/CANCELLED`，合法迁移及多执行域汇总以 `engineering/12-EXECUTION-TOPOLOGY.md` 为准；初始化、恢复、完成提交作为运行阶段记录，不再定义第二套状态名称。
- PostgreSQL 备份、WAL/PITR；对象存储版本化与不可变校验；定期进行 DB + Artifact 的一致性恢复演练。
- 定义并演练 RPO/RTO；它们在未完成容量和业务评估前**不预填为承诺指标**。
- Site 网络暂时中断时，独立 FAB 只有在输入已冻结且仍满足租约有效性规则时才能继续提交；租约过期后停止发布，未提交的本地推演不能算已接受结果。Site 监控显示数据水位与过期状态；共享模式丢失权威 Coordinator 时暂停整个协调域，不能降级成无约束独立运行。

## 6. 依赖与交付治理

- 锁定 npm/pnpm、NuGet、C++ 依赖；生成 SBOM、许可证报告、漏洞扫描。
- CI Gate：构建、Lint、静态分析、软件组成分析、单元/集成/性能/协议回归、数据库迁移检查、WebGPU-only 检查。
- 补丁与 CVE 等级响应纳入版本发布流程；Release Artifact 使用签名和校验和。
- Windows x64 首发；OS/浏览器/GPU 驱动/数据库版本组合建立支持矩阵；Linux 支持能力在服务端代码层保留，原生 C++/Win32 组件通过接口隔离。
