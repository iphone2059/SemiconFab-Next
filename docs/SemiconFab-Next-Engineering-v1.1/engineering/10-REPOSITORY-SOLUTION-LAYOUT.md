# 10 — Monorepo、解决方案与工程组织规范

## 1. 仓库布局（规范性）

```text
SemiconFab-Next/
├─ SemiconFab.slnx                   # VS 2026 Solution
├─ global.json                      # 固定 .NET SDK，CI 自动审查升级
├─ Directory.Build.props            # Nullable, Analyzers, deterministic, warnings
├─ Directory.Packages.props         # NuGet CPM 锁定依赖
├─ NuGet.Config                      # 官方/企业受控包源，不含凭据
├─ .editorconfig / .gitattributes
├─ pnpm-workspace.yaml / pnpm-lock.yaml
├─ package.json / .npmrc
├─ apps/
│  ├─ Fab.Api/                       # ASP.NET Core Composition Root
│  ├─ Fab.Worker/                    # Worker Composition Root
│  ├─ Fab.RealtimeHost/              # 可独立部署，初期可并入 Api
│  ├─ Fab.OtGateway/                 # 独立进程/安全域，默认模拟与只读
│  └─ web/                           # SPA Shell (React + Vite)
├─ src/
│  ├─ Foundation/
│  │  ├─ Fab.Ids/                    # Strong typed Ids/Units/Time
│  │  ├─ Fab.Contracts/              # 独立版本化 DTO/Ports；不引用任何 Domain
│  │  ├─ Fab.Messaging/              # 幂等、Outbox、Envelope
│  │  ├─ Fab.Observability/          # OpenTelemetry 共享语义
│  │  ├─ Fab.Hosting/                # Host 生命周期/健康检查
│  │  └─ Fab.Configuration/          # 类型化配置与启动验证
│  ├─ Site/
│  │  ├─ Fab.Site.Domain/
│  │  ├─ Fab.Site.Application/
│  │  └─ Fab.Site.Infrastructure/
│  ├─ Manufacturing/                # Domain/Application/Infrastructure 三项目
│  ├─ ProcessEngineering/           # 同上
│  ├─ Equipment/                    # 同上
│  ├─ MaterialHandling/             # 同上
│  ├─ Maintenance/                  # 同上
│  ├─ Quality/                      # 同上
│  ├─ Simulation/
│  │  ├─ Fab.Simulation.Core/        # 队列、时钟、RNG、调度内核；纯类库
│  │  ├─ Fab.Simulation.Models/      # 冻结场景/运行时状态/调度策略
│  │  ├─ Fab.Simulation.Runtime/     # 执行域、Checkpoint、统计
│  │  ├─ Fab.Simulation.SiteCoordinator/ # M08 资源仲裁装配；使用 M07 事件循环
│  │  └─ Fab.Simulation.NativeBridge/# 可选 native ABI
│  ├─ SiteResources/                # Domain/Application/Infrastructure
│  ├─ Orchestration/                # Job/Lease/Worker placement
│  ├─ Experiment/                   # Domain/Application/Infrastructure，实验计划
│  ├─ Optimization/Fab.Optimization.Abstractions/ # 无 I/O 的策略抽象，供 M07/M17 共用
│  ├─ Analytics/                    # KPI 定义、查询、Site 聚合
│  ├─ Identity/                     # 身份授权、审计，勿自建密码协议
│  ├─ Eap/                          # Fab.Eap.Domain/Application/Simulator
│  ├─ IndustrialProfiles/Fab.IndustrialProfiles/ # 无 I/O 的版本化标准 Profile
│  ├─ IndustrialInterfaces/         # Domain/Application/Protocols/Adapters，M15
│  ├─ Security/Fab.SecurityPolicies/ # 无 I/O 的授权抽象/策略结构
│  └─ Adapters/Fab.Contracts.Adapters/ # 协议/Domain 映射；不是 Foundation 的依赖
├─ frontend/packages/
│  ├─ contracts/                    # proto/OpenAPI 自动生成的 TS 类型
│  ├─ api-client/                   # 认证 REST 客户端
│  ├─ app-ui/                       # Ant Design 封装及 tokens
│  ├─ widgets/                      # 可复用工作台/KPI 组件
│  ├─ fab-scene/                    # 引擎无关视图数据与 EntityRegistry
│  ├─ babylon-webgpu/               # 唯一 Babylon/ GPU 接口实现
│  ├─ realtime-sync/               # 二进制状态同步/快照恢复
│  └─ charting/                     # ECharts 适配
├─ contracts/
│  ├─ protobuf/                     # 规范化 .proto
│  ├─ openapi/                      # OpenAPI 快照/diff
│  └─ json-schema/                  # Scenario、Template、Asset
├─ native/Fab.Native/              # 可选 MSVC/CMake 工程，C ABI
├─ assets/                          # GLB、KTX2、场景元数据
├─ tests/
│  ├─ Unit / Integration / Contracts / SimulationGolden /
│  ├─ SharedResources / OTConformance / E2E / Performance /
│  └─ GPUAcceptance/
├─ tools/                           # 契约生成、模型检查、DB 迁移、数据合成
├─ infrastructure/                  # WinService、容器、OT 隔离部署、观测
└─ docs/                            # 规范、ADR、标准适用性、操作手册
```

## 2. .NET 项目规则

- `Fab.X.Domain.csproj`：`net11.0` 目标；只引用 `Fab.Ids` 与无 I/O 的纯抽象；不得引用生成协议、其它域 Application/Domain/Infrastructure、ASP.NET、EF Core、网络/数据库包。实体和值对象只在所属域定义。
- `Fab.X.Application.csproj`：依赖同域 Domain、`Fab.Contracts/Ids` 与纯授权抽象；跨域只依赖独立公开 Ports/Contracts，不引用对方 Application。跨域 DTO/Port 只含公开值类型，不携带 Domain 实体或 EF 类型。外部 I/O 接受 `CancellationToken`。
- `Fab.X.Infrastructure.csproj`：实现 Application Ports，映射 EF/Npgsql，提供 Adapter/Outbox；禁止直接被其它 Domain 项目引用。
- `Fab.Api`：只做 Composition Root、HTTP 路由、鉴权、请求验证、ProblemDetails、版本声明；严禁把业务逻辑塞进 Endpoint handler。
- `Fab.Worker`：装配 Job/Lease、M07 Runtime、M08 Coordinator、Checkpoint/结果 Adapter；热循环在 Simulation 执行器，Run 持久化状态与目录由 M09 管理，不通过 HTTP Controller 驱动。
- `Fab.OtGateway`：单独部署、显式配置设备 allowlist、默认为 SIMULATED/READ_ONLY；即使 API 被攻破也不天然拥有真实设备控制权。
- `Fab.Contracts` 只依赖公开基础值类型/协议运行库，禁止引用 Domain/EF/业务实现。协议与域映射置于 `Fab.Contracts.Adapters` 或所属边界 Adapter，由 Host 装配；不能为共享 DTO 建立 Contracts→Domain 的反向引用。
- 第三方库采用 `Directory.Packages.props` 集中版本；新依赖必须说明维护状态、许可证、安全更新与替代接口。
- 构建尽量 `TreatWarningsAsErrors=true`、`Nullable=enable`、`AnalysisLevel=latest`；少数第三方生成代码隔离到 Generated 项目并记录例外。
- 编译时间与构建可恢复性是目标指标；不必为每个文件单独建程序集，**以领域边界而非文件数**拆分项目。

## 3. TypeScript 工作空间规范

- `apps/web` 只组合路由、布局、页面；业务 SDK、实时同步与渲染器位于独立 package。使用 `pnpm` workspaces + lockfile。
- TypeScript 启用 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noFallthroughCasesInSwitch`、`noImplicitOverride`；`any` 需审批。
- Vite/Rolldown 按路由和场景大资源拆包；单独衡量首屏和 3D 首次就绪时间。
- 从 OpenAPI/Protobuf 生成 Contract，手写 DOM/UI model 不得重新定义同名协议字段。
- 所有 WebGPU 操作经过 `@fab/babylon-webgpu`；它实现 `fab-scene` 的纯 `IRenderBackend`，由 Web bootstrap 注入。`fab-scene`/`state-sync` 不反向导入 Babylon，React 页面只消费 Scene Facade。
- Monorepo 不是微服务决定：应用部署单元由网络边界和吞吐需求决定，而非包/项目数量。

## 4. 命名、版本与变更

- C# `PascalCase` 公共符号，`IFooPort` 表示领域外依赖；`FooCommand` / `FooEvent` 区分写指令与已发生事实。
- 仿真实体使用不可变二进制 ID，界面显示编号可以与其他 FAB 相同；`SiteId/FabId/RunId/EntityId` 的作用域不可互换。
- 契约 `v1` 采用 add-only 演进；不兼容改动新增 schema/包或协议大版本，老 Run 的历史 Reader 保留。
- 发布包包含 `build_sha`、依赖清单（SBOM）、schema hash、模型版本、场景 hash、测量证据。
- 对编译器、TS、Vite、Babylon、.NET、Npgsql、Postgres 的版本更新应由 Renovate/Dependabot 提议并经 CI 全链路验证；正式 Release 固定精确版本。

## 5. 解决方案过滤器（建议）

开发者可使用完整 `SemiconFab.slnx`，并按工作域另建 `Fab.Simulation.slnx`、`Fab.Industrial.slnx` 等子集解决方案；这些不是同一解决方案的原生过滤器。每个可执行 Host 各有明确 Composition Root，避免因子集缺失而隐式改变装配。Native C++ 以顶层 CMake 及 `CMakePresets.json` 由 VS/MSVC 管理；禁止把 C++ STL 容器直接暴露给 P/Invoke。

## 6. 工程完成定义

新增模块随代码交付 `README.md`（owner/上下游/公开契约）、适用的注册/装配入口、单元测试与正向/负向集成验收、版本兼容、诊断和故障证据。后端持久化模块提供 migration/Outbox，纯核心与前端包提供相应纯逻辑或生命周期验收，不强造数据库。模块 API 未写清契约、无法自动化验证，则不算开发完成。
