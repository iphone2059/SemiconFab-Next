# Fab.Simulation.Models

实现 `SyntheticFifoModel`：每 FAB 一台设备、一个工序，整批 Lot 在零时刻按整数实体序号释放，非抢占 FIFO。每次服务时间为 `processTimeUs + (SplitMix64.Next() % (floor(processTimeUs/10)+1))`，即 0..10% 的整数非负受控 jitter；小于 10 微秒时 jitter 为零。取模方案有微小离散偏差，这是冻结的合成负载定义。

无实际工艺路线、设备故障、返工、搬运、共享资源、真实 MES 数据或工厂物理精度声明。当前模型用于确定性开发闭环，不代表真实制造模型。
