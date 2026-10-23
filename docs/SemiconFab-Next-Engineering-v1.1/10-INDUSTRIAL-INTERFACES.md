# 10 — MES/EAP/GEM300/AMHS/厂务接口规范

## 1. 边界

`Fab.Domain` 处理制造语义；`Industrial.Adapters` 处理厂商/物理协议。真实生产设备接入默认禁止写操作，只有批准的专用 OT Gateway 可以连接 OT Zone。模拟器、测试驱动和实机适配器必须实现相同接口但采用独立身份与 endpoint；禁止用一个布尔值将仿真服务变成真实设备控制器。

## 2. 协议接口组

```
IEquipmentTelemetrySource  -> State, Alarm, Variable, Trace
IEquipmentCommandPort      -> SetRemote, Start/Stop, DownloadRecipe [授权]
ICarrierPort               -> Arrive, Identify, Dock, Undock, Depart
IProcessJobPort            -> Create, Select, Start, Pause, Abort, Complete
IControlJobPort            -> Create, Assign, Execute, Complete
ISubstrateTrackingPort     -> wafer location/history
ITransportDispatcher       -> TransportJob, assignment, handoff, timeout
IUtilityTelemetrySource    -> site resource capacity/availability
```

以上是内部 C# 接口建议，并不是对 SEMI 方法名或状态机的逐字转写。每个 Adapter 必须声明 `mode=SIMULATED | READ_ONLY | CONTROL_ENABLED`，而 `CONTROL_ENABLED` 只能通过独立的审批/身份/网络部署获得。

## 3. GEM300 领域与协议映射

- E5/E37：SECS-II/HSMS 传输编解码与会话层。
- E30：GEM 设备通信、远程控制、事件/报警/配方及宿主状态模型。
- E39/E40/E87/E90/E94：对象、ProcessJob、Carrier/LoadPort、Substrate、ControlJob 的模型及接口。
- E84：AMHS handoff 状态；物理 PIO 与模拟交接必须区分。
- E116/E157：设备追踪、模块/工艺过程数据。

必须定义 per-equipment Profile：制造商、型号、接口文件版本、支持的消息/变量/事件/报警、选项、超时、重试、相关通信依赖、符合性测试记录。不能因为 GEM300 总表列出能力就默认所有设备都支持。

## 4. MES 模拟器与调度

- WorkOrder → Product/Route/Recipe → Lot/Carrier → Operation → Equipment/Chamber。
- 明确 Dispatch Rule 与 Schedule Plan 区别：Dispatch Rule 选当前可加工 Lot；Schedule Plan 涉及跨时间与资源的生产计划。
- MES 仿真模拟 Hold/Release、Rework、Scrap、Split/Merge、TrackIn/TrackOut；每个操作有命令审计、工艺条件、权限与计量口径。
- 批次拆并、Wafer 状态、载具搬运要维护守恒；跨 FAB 默认禁用。

## 5. AMHS

每 FAB 独立 `TransportNetwork/Vehicle/Stocker/CarrierRoute`；共享物流 `SiteTransportNetwork` 只有现场确认且在 `COUPLED_FLOW` 显式启用才建模。固定运输时间可作为早期简化，但必须标记 `approximation=FIXED_DELAY`，不能宣称真实拥堵仿真。

车辆/资源抢占、单轨占用、安全距离、LoadPort/Stocker 交接状态、失效恢复在专用 AMHS 模型中实现。移动轨迹生成与 Babylon.js 动画不构成运输调度正确性证据。

## 6. 厂务共享容量

公用工程接口仅映射经审核的容量、动态折减、可用窗口及故障事件。若数据源未确认，可创建 `synthetic=true` 的实验性资源，不可显示为实际厂务状态。

## 7. 验收门禁

每个厂商/设备型号建立通信验收用例、版本锁定测试、模拟器对照测试、异常场景和真实生产安全审批。真实设备的远程操作不仅是协议问题，还需要明确安全联锁、失控风险及变更授权边界；此平台不代替安全控制器。
