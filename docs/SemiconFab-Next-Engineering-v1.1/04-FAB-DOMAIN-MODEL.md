# 04 — 多 FAB 领域模型与不变量

## 1. 层级与对象身份

```
Enterprise [optional]
  └─ Site (1)
      ├─ FabTemplateVersion (shared, immutable)
      ├─ FabUnit (FAB-01 / 02 / 03; N extensible)
      │   ├─ Area / Bay / WorkCenter / ToolGroup
      │   ├─ Equipment / Chamber / LoadPort
      │   ├─ ProcessRouteVersion / Operation / RecipeVersion
      │   ├─ Product / WorkOrder / Lot / Wafer / Carrier
      │   ├─ AMHS Network / OHT / Stocker / TransportJob
      │   ├─ Maintenance / Alarm / Measurement
      │   └─ Scenario / SimulationRun / KPI
      └─ SiteResource (optional and centrally owned)
```

**身份规则**：所有可变对象有不可变 ID；`EntityId` 使用 UUID 或有明确命名空间的 ID，业务显示号允许重复但必须以 `(site_id, fab_id, external_id, source)` 联合辨识。定义实体的稳定 ID 可在不同 Run 中复用，运行态实例的完整身份为 `(site_id, run_id, fab_id, entity_id)`；缓存、事件去重、资源账本、结果和投影不得省略运行作用域。FAB 所属运行实体绑定且仅绑定一个 `FabUnitId`；SiteResource 运行态、Run/Lease 等协调对象属于显式 Site/执行域，不伪造 FAB 归属。

## 2. 核心聚合

| Aggregate | 主键 | 核心字段 | 唯一责任 |
|---|---|---|---|
| Site | SiteId | Name, Version, Policy | 基地治理，不拥有机台状态 |
| FabTemplateVersion | TemplateId, Version | Layout, Routes, Capabilities, BaseConfig, Hash | 不可变参考定义 |
| FabUnit | FabId | SiteId, TemplateVersion, Code, Parameters | 绑定蓝图，拥有实例命名空间 |
| Equipment | EquipmentId | FabId, GroupId, Model, State, Version | 设备加工/故障资源归属 |
| Chamber | ChamberId | EquipmentId, RecipeCapability, State | 多腔室加工与互斥 |
| Carrier | CarrierId | FabId, Location, Contents, State | 载体占用与晶圆装载 |
| Lot | LotId | FabId, RouteVersion, Step, Qty, Priority | 批次业务生命周期 |
| Wafer | WaferId | LotId, CarrierId?, State, History | 单片追踪与质量 |
| ProcessJob / ControlJob | JobId | EquipmentId, Recipe, MaterialSet, State | 与 GEM300 语义对应的工作项 |
| ScenarioVersion | ScenarioId, Version | TemplateHash, InitialState, RNGPlan, Mode | 不可变仿真输入 |
| SimulationRun | RunId | ScenarioVersion, EngineBuild, Seed, Status, FabBindings | 一次执行与产物；独立成员或共享协调域见 03/engineering/12 |
| SiteResource | ResourceId；运行态为 (SiteId, RunId, ResourceId) | OwnerSiteId, Kind, Capacity, Unit, Policy | 冻结资源定义及按 Run 实例化的唯一授权账本 |

## 3. 冻结与克隆策略

`FabTemplateVersion` 发布后禁止原地修改，调整时创建新版本；FabUnit 可以在新建 Scenario 时绑定新模板版本。三 FAB 可使用同一个模板及相同缺省值，但独立模式分别建立 state store、queue、RNG stream；共享模式保留分区实体/RNG 隔离，由同一执行器持有全域 queue/clock。发布新 Template 不得影响已启动运行。

冻结对象图包含模板、路线/配方、资源图/合同、策略、日历、单位精度、事件优先级和 RNG 派生规则的具体版本与内容哈希；不能只保留会指向最新版本的可变外键。Run 内对象和初始状态不能引用可变模板实例。业务发布新定义只供后续 ScenarioVersion 使用。

## 4. 必须执行的不变量

- `LOT-001`：Lot 的 fab_id 在整个生命周期不可变；跨 FAB 业务流转必须使用显式 Transfer API 与来源/目标追踪（缺省禁止）。
- `LOT-001a`：预留跨 FAB Transfer 不得原地改写已有 Lot 的 fab_id；若未来获批实现，必须以来源移出和目标新身份/谱系映射守恒记账。当前版本不因此开放跨 FAB 流转。
- `LOT-002`：Lot 数量与 Wafer 集合必须守恒；Scrap/Rework/Ship/Receive 为显式记账事件。
- `EQP-001`：单 Chamber 同时只加工符合配方与容量约束的任务；设备状态变化必须来自状态机转换。
- `CAR-001`：Carrier 同一时刻只能拥有一个权威位置及归属；占用 LoadPort 时与 Equipment 关系一致。
- `ROUTE-001`：Lot 引用已发布且冻结的 RouteVersion；工序跳转需明确条件。
- `TIME-001`：所有工艺事件具有有效仿真时刻；现场事件还需独立 wall_time。
- `FAB-001`：任意 fab_id 都不能读取/修改其他 FAB 的状态聚合，除具备专门授权的 Site 只读投影或共享资源协调接口。
- `SITE-001`：Site KPI 是聚合计算结果，不得成为各 FAB 状态的反向控制来源。
- `SHARED-001`：只有定义为 `SiteResource` 且配置允许的资源才可以跨 FAB 竞争。
- `RUN-001`：两个 Run 即使引用同一 FAB、设备或 SiteResource 定义，也没有共享的可变实例、RNG、去重记录或容量竞争；只有同一共享 Run 内声明的成员可以竞争其资源账本。

## 5. 设备状态与 SEMI 映射

内部具体状态例如：`Idle/Setup/Processing/Blocked/Starved/DownUnscheduled/DownScheduled/Engineering/Offline`，这是工程内部概念；必须通过 `EquipmentStateMapping` 映射到当前采用版本的 SEMI E10 统计分类，维护完整性与冲突检查；**不得将内部状态枚举直接等同于 E10 官方定义**。

## 6. 可扩展的工作域

域边界：`Manufacturing`（订单、WIP、Lot）、`Equipment`（机台、Recipe）、`MaterialHandling`（Carrier/OHT/Stocker）、`Maintenance`、`Quality`、`Simulation`、`SiteResources`、`Analytics`、`Identity`。以事件与契约交互；避免互相直接访问对方的数据库表。

## 7. 三 FAB 示例

`FAB-01.EQP-001` 与 `FAB-02.EQP-001` 可用相同显示号，但逻辑 ID 不同。独立 Run 中任何一次机台故障、Lot 释放或随机数消耗都不能影响另一个 FAB 的轨迹和随机流；若共享容量模式启用，允许仅通过共享资源授予影响其生产延迟，且所有影响必须可追溯。
