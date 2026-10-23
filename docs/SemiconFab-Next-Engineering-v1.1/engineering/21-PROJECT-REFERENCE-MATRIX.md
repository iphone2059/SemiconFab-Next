# 21 — C# 项目引用、NuGet 与部署单元约束

## 1. 项目依赖框架

箭头表示“左侧项目引用右侧项目”；跨域业务协作不直接转化为项目引用。

```text
Fab.Contracts -> Fab.Ids / 协议运行库
Fab.Messaging -> Fab.Contracts / Fab.Ids（Envelope、幂等与 Outbox 抽象）
Fab.X.Domain -> Fab.Ids / 明确的无 I/O 纯抽象
Fab.X.Application -> 本域 Domain / Fab.Contracts / 纯授权抽象
Fab.X.Infrastructure -> 本域 Application / Domain / 外部 SDK
Fab.Contracts.Adapters -> Fab.Contracts / 所需 Domain（边界映射）
API / Worker / RealtimeHost / OtGateway -> 各自需要的用例与 Adapter
```

`X` 指 Site、Manufacturing、ProcessEngineering、Equipment、MaterialHandling、Maintenance、Quality、SiteResources、Orchestration、Analytics、Identity、Experiment。跨域公开 DTO/Ports 集中在独立 `Fab.Contracts` 的领域命名空间；禁止 Contracts 引用 Domain、Application、EF 实体或业务实现，也禁止为了调用接口而相互引用 Application。私有仓储 Port 不公开为跨域 API。

EAP 与 OT 使用显式变体：`Fab.Eap.Domain/Application/Simulator`、`Fab.IndustrialInterfaces.Domain/Application/Protocols/Adapters`。`Fab.IndustrialProfiles`、`Fab.SecurityPolicies`、`Fab.Optimization.Abstractions` 为无 I/O 的公共结构/抽象，不反向依赖使用方；优化策略实现在 M17，M07 不引用 Experiment.Application。

## 2. 项目允许引用与禁止引用

| 项目类型 | 允许 | 禁止 |
|---|---|---|
| `Fab.Ids` | 纯 ID、单位、虚拟时间值类型 | 业务项目、协议生成、I/O |
| `Fab.Contracts` | Fab.Ids、版本化 DTO/Ports、生成协议及其运行库 | Domain/Application/Infra、EF、外部业务 SDK |
| `Fab.X.Domain` | Fab.Ids、经声明的纯值对象/算法抽象 | 其它域 Domain/Application/Infra、生成协议、EF、ASP.NET、网络、GPU |
| `Fab.X.Application` | 本域 Domain、Fab.Contracts、授权 Abstractions | 其它域 Application/Domain、DbContext 或具体 Adapter |
| `Fab.X.Infrastructure` | 本域 Domain/Application、公开 Contracts、Npgsql/EF/外部 SDK | 借 Adapter 直接写其它域表或调用其内部实现 |
| `Fab.Contracts.Adapters` | Contracts、所需 Domain、协议/域映射 | 被 Contracts 或 Domain 反向引用 |
| `Fab.Simulation.Core` | Fab.Ids、纯事件接口、稳定纯算法 | 业务 Application/Infra、HTTP、数据库、系统时钟/计时器、GPU |
| `Fab.Simulation.Models` | Core、冻结的内存模型、纯领域行为/模型适配 | 可变业务库实体、外部 I/O、运行中重新查询主数据 |
| `Fab.Simulation.Runtime` | Core、Models、Checkpoint/Artifact 等公开 Ports | 客户端 UI、Orchestration 实现、真实 OT write |
| `Fab.Simulation.SiteCoordinator` | M07 的 Core/Models/Runtime 公开执行接口、M08 纯仲裁规则 | 独立竞争的事件循环、Orchestration 实现、OT write |
| `Fab.Eap.Simulator` | 本域 Application/Domain、纯 IndustrialProfiles、M07 公开模型接口 | 真实设备网络出口或 Gateway 实现 |
| `Fab.IndustrialInterfaces.Protocols/Adapters` | 本域 Application/Domain、IndustrialProfiles、协议/安全 SDK | Simulation.Run 内存写入、其它域 DbContext |
| `Fab.Api` | 所需 Application/Infra、边界映射、OpenAPI | 在 endpoint 内跑 DES 长循环或实现领域规则 |
| `Fab.Worker` | M07 Runtime、M08 Coordinator、M09 Job/Artifact Ports 与 Adapter、显式模型装配 | 公网未授权设备调用、绕过 LeaseEpoch 提交 |
| `Fab.RealtimeHost` | 授权/订阅 Ports、非权威快照/Delta Adapter、版本化协议 | 拥有 DES 事件时序、修改 Run 运行状态 |
| `Fab.OtGateway` | 本域 Application、Protocol/Adapter、Approved Profiles、Security Port | 对其它域表或 Simulation.Run 状态的直接修改 |
| `Fab.Observability/Hosting/Configuration` | OTel/Host/配置抽象及适用 SDK | 反向引用所有业务域形成基础库循环 |

Simulation.Models 对纯领域行为的引用是显式模型装配边界，不允许业务 Domain 反向引用 Models。每个模型必须声明冻结输入、可变运行状态和事件处理接口；编译依赖图由 CI 检查为 DAG，不能把 MODULE-MATRIX 中的上下游协作表当成 csproj 引用清单。

## 3. 构建配置

- 启用 `Nullable`、一致语言版本、强类型 ID；build 信息生成 `BuildManifest`，不得用文件最后修改时间推断版本。
- 项目中配置 `LangVersion=preview` 仅当明确需要尚未正式进入 C# 15 的特性，并经 CI 验证；不要因“最新”无理由开启不可控功能。
- 原生 DLL 由 Packaging Pipeline 读取 ABI 版本与平台架构，单一生成受控运行包，不通过 VS 解决方案到处隐式复制。
- EF Core Migration 以所属逻辑 Owner 管理，物理 schema 共用不转移写权限；多组 migration 由部署流程全局串行执行。
- Generic Host/BackgroundService 实现宿主生命周期；DES 虚拟事件时序独立于 HostedService 调度时钟。
- `Fab.Api`、`Fab.Worker`、`Fab.RealtimeHost`、`Fab.OtGateway` 各有 Composition Root；初期 Realtime 可装入 API，但 OT 仍保持独立进程/安全域。

## 4. 解耦策略

- 在主要业务边界设计 `IEquipmentCapabilityReader`、`IRouteReader`、`ISiteResourceAuthority`、`IRunArtifactStore` 等 Ports；避免给每个实体建立空接口和纯 CRUD 仓储。
- 事件是跨模块事实，命令是有权限和结果的请求。强一致规则停留在 Aggregate 或单次 Deterministic Coordinator 内，不能依赖最终一致发布做资源排他。
- 外部 SDK 类型仅在 Adapter 中导入；公开 DTO 与 Domain Contract 不暴露 DbContext、协议 session、Babylon Scene 等实现对象。
- 前端按同一原则分离：Web bootstrap 装配 Scene Facade 与 GPU backend；babylon-webgpu 实现并依赖 fab-scene 的纯 IRenderBackend，fab-scene/state-sync 不反向导入 Babylon/React 页面。
