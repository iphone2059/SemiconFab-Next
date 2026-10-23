# 02 — FAB 行业标准映射与合规边界

## 1. 解释规则

本文件将**领域适配要求**与**正式协议/产品符合性要求**分离。SEMI、IEC、ISO 标准版本与条款可能需要付费获取；本文件只引用公开范围、标准标识及内部设计规则，不再现非公开规范正文。不具备正版规范、专属 PICS/厂商接口文件及测试证据时不得作符合性声明。

## 2. 标准适用矩阵

| 标准/标准族 | 适用位置 | 内部实现要求 | 合规状态规则 |
|---|---|---|---|
| SEMI E5 | SECS-II 结构化消息 | 类型、SxFy、编码与版本化适配器 | 标准版次确认及互操作测试后方可声明 |
| SEMI E37 / E37.1 | HSMS 传输 | 会话、超时、重连、控制消息状态机 | 实际设备测试 |
| SEMI E30 GEM | Equipment Host Interface | 通信、控制、事件上报、报警、配方相关接口抽象 | 按设备 Profile 验收 |
| SEMI E39 | 设备对象模型 | ObjectId / 属性 / 状态及事件关联 | 按实际功能采用 |
| SEMI E40 | Process Job Management | ProcessJob、材料/Recipe 绑定与状态机 | 需逐条验证 |
| SEMI E87 | Carrier Management | Carrier、LoadPort、占用/访问状态 | 需逐条验证 |
| SEMI E90 | Substrate Tracking | Wafer 位置、搬移历史、载体关系 | 需逐条验证 |
| SEMI E94 | Control Job Management | ControlJob、ProcessJob 编排与状态机 | 需逐条验证 |
| SEMI E84 | Carrier Handoff | AMHS/LoadPort 交接抽象、超时/互锁模拟 | 物理 I/O 对接时单独验收 |
| SEMI E116 / E157 | 设备/模块过程追踪 | 可订阅设备追踪数据与模块加工事件 | 需逐条验证 |
| SEMI E10 / E79 | 设备可靠性与 OEE | 时间状态核算、设备生产力指标与分母口径 | 统计指标需标准版次和厂规复核 |
| SEMI E187 | FAB 设备网络安全 | 真实设备接入安全要求矩阵 | 根据集成范围审查 |
| ISA-95 / IEC 62264 | Enterprise—MOM—Control | Site/FAB 层级、制造操作语义与边界 | 不宣称产品认证 |
| IEC 62443（尤其 3-2、4-1） | OT 分区和安全开发流程 | Zone/Conduit、威胁模型、SL-T、SDL、安全补丁 | 项目级评估证据 |
| OPC UA / IEC 62541 | 可选设备或设施集成 | 信息模型、证书、Session、Subscription、安全策略 | 仅启用并测试时声明 |
| ISO 14644-1 | 洁净室布局与环境数据 | 清洁度等级作为有来源的可配置属性 | 3D 标注不构成环境认证 |
| SEMI S2/S8/S22 | 真实设备 EHS、人体工学、电气设计 | 可视化标注与危险信息的参考边界 | 不替代物理设备安全评估 |

### 特别注意

- **SEMI E116** 是 Equipment Performance Tracking，不是 Equipment Terminal Services。设备终端服务不得误用此编号。
- E10 的设备基本状态与工程内部设备微观状态不能简单等同；内部状态需映射至经版本批准的 E10 状态分类，并明确定义所有时间归属。
- E79/OEE 各指标必须确定时间窗、计划时间、有效生产时间、良率、重新加工与停机分类口径；未经定义不得跨 FAB 简单求算术平均。
- 标准要求的完整消息流程、数据字典、设备角色、可选项与时序，不以本项目示例代替。

## 3. 实施级别（每个标准单独评价）

统一使用以下三个独立字段，工程文档和 UI 不得另建同义状态枚举：

- `applicability`：`UNDECIDED | APPLICABLE | NOT_APPLICABLE`。
- `implementation_state`：`NOT_ASSESSED | PLANNED | MODEL_ONLY | SIMULATED | IMPLEMENTED_UNVERIFIED | TESTED_INTEROPERABLE | COMPLIANCE_EVIDENCED`。
- `test_result`：`NOT_ASSESSED | PASS | FAIL | NOT_APPLICABLE`，附实际测试范围；模拟器测试通过只表明该模拟用例通过。

`COMPLIANCE_EVIDENCED` 仅覆盖已登记版次、Profile 和条款，不自动扩大到整个标准、产品或其他设备。`NOT_APPLICABLE` 必须填写适用性判断依据与审查人。

每条符合性记录必须包含：`standard_id`、`edition`、`clause_reference`、`feature_profile`、`applicability`、`implementation_state`、`implementation_id`、`test_case_id`、`test_result`、`evidence_uri`、`reviewer`、`review_date`。禁止将 `MODEL_ONLY` 显示成 `COMPLIANCE_EVIDENCED`。

## 4. 最少行业测试

- GEM / HSMS：建立、断开、重连、T3/T5/T6/T7/T8 等超时按实际标准版次验收；错误消息与断线恢复。
- GEM300：Carrier、Process Job、Control Job、Wafer 映射与合法转换、拒绝错误命令、去重及异常恢复。
- AMHS：载体 handoff、状态超时、目标负载口占用、任务取消和运输恢复。
- E10/E79：内部累计统一使用半开区间 `[t0,t1)`，相邻窗口不重复计时；一台机器某时刻恰属于规定的一个顶级统计状态，状态映射按获批版次复核；产出与在制品守恒。
- ISA-95：Site/FAB/Area/WorkCenter/Equipment 层级映射，订单/作业/资源管理边界清楚。
- 安全：区域和通道隔离、最小权限、TLS、审计、威胁模型、补丁流程。

## 5. 官方参考入口（访问时复核现行版次）

- SEMI Information & Control：https://www.semi.org/en/products-services/standards/information_and_control
- SEMI E10：https://www.semi.org/en/Standards/CTR_031244
- SEMI Safety：https://www.semi.org/en/products-services/standards/safety
- SEMI 常见标准：https://www.semi.org/en/products-services/standards/top-10-standards
- ISA-95：https://www.isa.org/standards-and-publications/isa-standards/isa-95-standard
- IEC 62443-3-2：https://webstore.iec.ch/en/publication/30727
- IEC 62443-4-1：https://webstore.iec.ch/en/publication/33615
- ISO 14644-1：https://www.iso.org/standard/53394.html
- OPC UA：https://opcfoundation.org/about/opc-technologies/opc-ua/ua-companion-specifications/

**采购/法务门禁**：正式接口验收前取得适用 SEMI/IEC/ISO 版本以及供应商接口协议；审阅引入的第三方商业许可及原始 SemiconFab 代码 PolyForm Noncommercial 使用限制。
