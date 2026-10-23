# 17 — FAB 行业标准适用矩阵与模块设计证据

> 本文是公开标准目录的**工程适用性映射**，不是标准全文或正式认证。SEMI 标准经常收费且会修订；逐条符合性由现场获取正版标准及厂家 Interface Manual 后确认。请填写 `standard_edition / clause / applicability / implementation / test_case / evidence / reviewer`。

| 领域 | 主要标准与术语 | 对应模块 | 工程验证示例 |
|---|---|---|---|
| 制造运营 | ISA-95 / IEC 62264（Enterprise—MOM—Control） | M01/M02/M04/M10 | 主数据层级、生产订单、Lot 管理与系统职责 |
| 设备通信 | SEMI E4/E5/E37；SECS-II/HSMS | M14/M15（M03 消费领域状态） | 编码、会话、错误、心跳、timeout、关联序号；E4 仅在设备 Profile 要求 SECS-I 时采用 |
| GEM 设备状态 | SEMI E30 | M03/M14/M15 | Control/Communication/Processing State、事件、报警、配方与远程控制 Profile |
| GEM300 工单 | SEMI E39/E40/E94 | M02/M03/M04/M14/M15 | ProcessJob、ControlJob 生命周期、属性与控制权限 |
| Carrier / Substrate | SEMI E87/E90 | M02/M03/M05/M14/M15 | LoadPort/Carrier/Substrate 状态、位置与交接 |
| AMHS handoff | SEMI E84 | M05/M14/M15 | PIO/交接状态与设备互锁的模拟验证 |
| 设备状态与效率 | SEMI E10/E79/E116 | M03/M10/M13/M14/M17 | M14 提供协议追踪，M03 状态映射，M10 计算 KPI，M13/M17 分析；不混同协议和指标所有权 |
| 设施、洁净室 | ISO 14644 系列；设施适用规范 | M01/M08/M12 | 区域元数据、厂务容量及审计来源；3D 示意≠洁净室达标证明 |
| 工业网络安全 | IEC 62443 系列 | M15/M16/M18 | Zone/Conduit、安全等级目标、隔离、凭据与审计 |
| 数据质量 | 机构数据治理、统计方法、现场规范 | M13/M17 | 单位、校准、有效性、统计显著性和溯源 |

## 1. 编写规则

- 对每个 Equipment Profile 建立标准版本、厂商型号、支持的 GEM 特性、SxFy 消息、CEID/SVID/DVID/ALID、错误行为、测试条目及测试报告存储地址。
- 内部 `EquipmentState` 需经过映射表才能形成 E10/E79 指标；不能将自定义 Idle/Process 直接标记为标准状态。
- 仿真数据/合成设备消息必须带 `SIMULATED`/`SYNTHETIC` 来源，真实现场采集带 `OBSERVED` 与时钟偏差/质量标记。
- GEM300 是多个规范集合，不是一个可以通过启用布尔开关即认为“支持”的单协议。
- 实施状态、适用性和测试结果统一使用根目录 `02-INDUSTRY-STANDARDS.md` 第 3 节的字段及枚举。模拟测试通过以 `implementation_state=SIMULATED`、`test_result=PASS` 登记；不得另设同义状态或将其升级为现场互操作/条款符合性结论。

## 2. 信息安全和现场安全

ISA-95 属于制造运营职责/接口建模，不是完整的工业网络安全标准；IEC 62443 规范的 Zone/Conduit、风险和技术要求必须由业主负责评估。软件中的设备 `Stop`/`Start` 模拟不替代设备急停、安全 PLC/硬联锁。

## 3. 标准清单维护

维护 `StandardsRegister`：机构、编号、正式版次、购买/许可记录、受控副本位置、适用模块、审查负责人、确认日期、失效/更新提醒。不得将受版权保护的标准全文直接复制进公开仓库。

## 4. 公开权威入口

- SEMI Introduction to Communication Standards: https://www.semi.org/en/standards-watch-2022-Sept/intro-to-semi-communication-standards
- SEMI GEM300 Overview: https://www.semi.org/en/standards-watch-2021Dec/gem300-tutorial-overview
- ISA-95 Overview: https://www.isa.org/standards-and-publications/isa-standards/isa-95-standard
- IEC 62443 Overview: https://www.iec.ch/standards-development/industrial-automation
- ISO 14644 查询： https://www.iso.org/
