# SemiconFab-Next Web 项目全面工程评审规范

## 版本与用途

> **文档编号：** SFN-WEB-REVIEW-STD-001  
> **版本：** 1.1（2026-10-29：Effect 4 终态同步）  
> **日期：** 2026-10-28  
> **状态：** 正式评审规范（供 AI Agent 与人工审查执行）  
> **适用范围：** `SemiconFab-Next/web_app` 及其与 Web 运行有关的前后端接口、静态资产、脚本和部署配置  
> **声明：** 本文定义审查方法、验收标准与产物格式，不代表已对任何一个新提交完成全量实测。


**使用规则：** 本文是完整评审标准，不是一次“已完成的代码审计报告”。任何审计必须先锁定真实 Commit SHA、运行平台、依赖版本与验证环境。没有运行证据不能写“已通过”。

## 目录

1. 目的、原则与评审边界
2. 全量评审维度 R01–R48
3. SemiconFab-Next 专项深度审计
4. 跨模块依赖与关键数据流
5. 证据级别、严重性与置信度
6. 工具与测试执行规范
7. 性能验收与基准方法
8. 综合评分与发布门禁
9. AI Agent 执行 SOP
10. 交付清单与报告模板
11. 反模式与非目标
12. 定义完成（DoD）
附录 A. 审计数据表结构
附录 B. 主要技术基线与来源

---

# 1. 目的、原则与评审边界

## 1.1 目标

从**用户价值、领域正确性、架构一致性、代码质量、运行行为、生产安全和交付治理**七个层面评估 Web 工程。产出可定位、可复现、可验收的审计结论，而非只提供风格偏好。

## 1.2 核心原则

- **正确性优先：** 权威业务数据、安全/权限、状态一致性先于性能与风格。
- **证据优先：** 静态推断、单元验证、真实浏览器复现、负载基准分别标注，不互相冒充。
- **可操作：** 每项问题须有具体位置、根因、影响、修复路径和回归验收。
- **风险排序：** 优先 P0/P1；禁止把代码行数、模块数量、理论复杂度直接等同于缺陷。
- **保留合理设计：** 审计必须记录“建议保留”的关键架构与算法，避免无意义重构。
- **最小扰动：** 默认只读评审，**不直接改动仓库、依赖、配置、`main` 或用户数据**。修改必须获得单独授权。
- **跨层一致性：** 分别评审单层代码与跨层边界，避免局部正确、整体失效。

## 1.3 范围与基线

正式执行时至少包含：`web_app/src`、`web_app/tests`、`web_app/assets`、`web_app/package.json`、`web_app/pnpm-lock.yaml`、`web_app/vite.config.ts`、TypeScript 配置、相关根目录脚本、API/SSE/Worker 契约与 WebGPU 生成资产。后端只审核与 Web 业务、权限和协议一致性相关的接口，完整后端性能/数据库审计作为独立工作流。

建立基线表：`repository`、`commit`、`dirty status`、`timestamp`、`Node`、`pnpm`、`TypeScript`、`React`、`Babylon Lite`、浏览器/OS、GPU/Driver、测试数据集、屏幕尺寸、DPR 和构建模式。

# 2. 全量评审维度 R01–R48

以下 12 组 48 项每一项都必须记录结果：`PASS`、`FINDING`、`NOT-APPLICABLE` 或 `NOT-VERIFIED`。**不能将 NOT-VERIFIED 统计成 PASS。**

## 01 业务与功能正确性

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R01 需求覆盖与追溯** | 逐项映射需求→实现→接口→测试；区分已交付、部分交付、设计预留。 | 需求追踪矩阵；找不到可验证实现的要求判为未证实。 |
| **R02 业务规则与领域语义** | 检查 Site/FAB/Equipment/Lot/Carrier/Recipe、MES/EAP/AMHS 规则；分清演示数据与真实数据。 | 边界用例、领域测试、权威后端契约、标准出处。 |
| **R03 数据正确性与数值精度** | 检查单位、时区、舍入、浮点误差、ID 保真、空值/缺失、重复和增量覆盖。 | 黄金向量、范围/精度断言、异常数据示例。 |
| **R04 核心不变量与隔离** | 验证 FAB 作用域、命令 Revision 单调、Run 一致性、时间线不变量及权限前置条件。 | 列出每个不变量的维护入口与失败注入测试。 |

## 02 系统架构与模块设计

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R05 整体架构适配性** | 核对单一 Vite 站点、前后端职责、运行时装配与未来多 FAB 需求；识别过度设计。 | 上下文图/部署图、ADR、规模与约束。 |
| **R06 模块内聚与职责** | 审查 app/features/domain/application/runtime/realtime/rendering 之间的职责及变化原因。 | 模块责任矩阵、大文件职责清单、变更影响范围。 |
| **R07 依赖方向与环** | 建立真实 TypeScript import graph；查循环、反向依赖、跨层依赖、动态 import 逃逸。 | 依赖图及具体文件→文件边；测试架构规则。 |
| **R08 接口、契约与封装** | 审查最小接口、参数/返回/错误语义、可替换性、信息隐藏及二进制/协议契约。 | 调用者清单、兼容策略、接口契约测试。 |
| **R09 设计模式与抽象成本** | 评估 Adapter、Facade、Observer、State、Factory、DI 是否必要；查包装层和泛化过度。 | 明确每个抽象的变化点、成本和反例。 |
| **R10 扩展性与演进** | 评估新设备、新 FAB、新业务流、新可视化/协议接入时，是否需横切修改。 | 至少两个真实扩展场景的变更路径演练。 |

## 03 代码质量、组织与类型安全

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R11 目录与命名可发现性** | 归属、命名一致性、生成文件隔离、公共 API/内部实现边界、根目录拥挤。 | 文件清单、模块入口、单一事实来源。 |
| **R12 实现复杂度与可读性** | 超大组件、条件嵌套、隐藏副作用、职责过多、事件闭包、认知复杂度。 | 具体函数行号、复杂度与最小可行拆分。 |
| **R13 TypeScript 类型强度** | any、unknown 校验、as 断言、非空断言、品牌 ID、判别联合、精确只读约束。 | 类型检查结果、非法输入的编译负例。 |
| **R14 死代码、重复与迁移遗留** | 无引用导出、无效分支、重复入口、旧依赖、弃用协议、失效测试/文档。 | 全局引用分析、Bundle 证据、动态调用排除；谨慎删除。 |

## 04 算法、数据结构与数值计算

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R15 算法正确性与稳定性** | 搜索/排序、插值、路径、数值舍入、确定性 PRNG、仿真时钟。 | 属性测试、黄金向量、边界值、反例。 |
| **R16 时间复杂度与频率** | 审查 O(N²)、重复全扫描；乘以更新频率评估实际成本。 | 输入规模、调用频率、Profile 时间和复杂度推导。 |
| **R17 空间复杂度与分配** | 无界集合、临时数组/字符串、闭包保留、GC、拷贝/序列化放大。 | Heap/Allocation Profile、对象生命周期与容量界。 |
| **R18 数据结构与布局选择** | Array/Map/Set/TypedArray/RingBuffer/Heap/SpatialIndex 的语义、局部性与批处理。 | 基准对照，证明选型收益并覆盖最坏情况。 |

## 05 状态管理、事件与并发一致性

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R19 状态所有权** | AppRuntime/Resource Atom/XState/Worker/GPU 是否各有唯一权威所有者；防止镜像失步。 | 状态所有权表和跨边界更新链。 |
| **R20 订阅和更新粒度** | Selector、useShallow、Context、memo、React Commit、无效广播/重复更新。 | React Profiler、变更触发的重渲染矩阵。 |
| **R21 异步竞争与取消** | 请求乱序、Abort、过期 Promise、挂载卸载、FAB 切换、GPU 恢复后迟到回调。 | 受控调度测试、故障注入、事件时间线。 |
| **R22 事件语义与回压** | Epoch/Sequence/Revision、幂等、增量合并、去重、重放、pending 槽位、重连与一致性。 | 协议时序图、最后一帧故障/乱序/重复测试。 |

## 06 性能、加载与资源效率

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R23 主线程 CPU 与响应** | Long Tasks、事件到绘制、布局/样式计算、React Commit 和同步阻塞。 | Chrome Performance、INP 相关交互追踪、CPU 火焰图。 |
| **R24 内存、GC 与泄漏** | Heap/GC、缓存淘汰、事件监听器、Timer/RAF/Worker、对象池收益与残留。 | 长稳态曲线、Heap Snapshot 差分、重复挂载测试。 |
| **R25 GPU 与实时画面** | GPU 帧时间、Draw Calls、Thin Instances、Shader/Pipeline、Shadow、Picking、资源上传。 | 浏览器/驱动/Adapter 固定的 GPU 量测。 |
| **R26 加载与传输** | Bundle 拆分、动态 import、静态资产、缓存、压缩、请求瀑布、解码及冷/暖启动。 | 构建产物分析、Network Trace、首屏可交互时间。 |

## 07 安全、权限与供应链

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R27 身份与资源级授权** | 请求身份、站点/FAB/设备资源授权、能力校验；不可仅依靠前端隐藏。 | 跨 FAB 越权负例、后端认证授权测试。 |
| **R28 Web 安全攻击面** | XSS/DOM 注入、CSRF、CORS、CSP、URL 参数、文件上传与内容渲染。 | 威胁模型、扫描与人工验证、PoC 最小复现。 |
| **R29 输入与协议健壮性** | Effect Schema/JSON 协议、消息大小、结构深度、恶意 SSE/Worker 载荷和资源耗尽。 | Fuzz/异常帧、上界与失败处理测试。 |
| **R30 依赖/密钥/许可** | 锁文件、依赖风险、构建完整性、第三方模型来源、密钥注入及版权许可。 | SBOM、依赖审计、许可证/出处清单。 |

## 08 交互体验、国际化与可访问性

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R31 输入与交互语义** | 鼠标/触摸/触控板/键盘、Drag-vs-Click、焦点、快捷键、Dialog、撤销。 | 设备/浏览器交互矩阵、录屏和 E2E。 |
| **R32 视觉/布局适配** | 缩放、DPI、不同分辨率、滚动/溢出、深浅主题和对比度。 | 多视口截图、布局与 DPR 检查。 |
| **R33 可访问性与国际化** | 语义 HTML、键盘可用性、屏幕阅读器、WCAG、中文/英文、文本膨胀。 | a11y 审计、键盘测试、语言切换验证。 |
| **R34 反馈、错误和状态解释** | 加载/空/错误/过期状态、恢复提示、操作确认、进度/失败可见性。 | 全状态截图及真实失败路径。 |

## 09 可靠性、容错与生命周期

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R35 错误模型与传播** | 错误是否吞掉、可恢复/终态区分、日志上下文、重试是否适当。 | 故障注入、日志、异常捕获回归。 |
| **R36 资源所有权与释放** | GPU 资源、Worker/SSE、订阅、Timer、RAF、AbortController、对象池的生命周期。 | 重复 mount/dispose、销毁后回调测试。 |
| **R37 恢复策略和故障域** | 断网、服务重启、设备丢失、数据过期、Worker 崩溃、重连对权威状态的影响。 | 恢复时间/失败率、代际隔离与故障注入。 |
| **R38 容量边界与降级** | 缓冲上界、重试上限、连接数、后端限流、无 WebGPU 环境的明确反馈。 | 极端输入和 8h/24h soak（按项目资源执行）。 |

## 10 测试策略、可信度与覆盖

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R39 测试层次与风险映射** | 单元、契约、集成、E2E、属性、状态机、Golden Vector 是否覆盖实际风险。 | 需求-风险-测试矩阵、缺口清单。 |
| **R40 测试断言与真实边界** | Mock 是否过多、测试是否仅验证实现细节、Flaky、无效断言及测试独立性。 | Mutation/负例验证、随机调度、多次重复。 |
| **R41 性能与回归基准** | 固定环境、原版 A/B、显著性与分位数、真实帧而非 RAF 假阳性。 | 基准 JSON、运行条件、原始 trace、统计分布。 |
| **R42 压力与故障注入** | 高事件频率、并发提交、Worker 卡死、重连乱序、GPU 恢复、慢服务器。 | 故障矩阵、重试/恢复断言、资源上界。 |

## 11 工程规范、文档与演进

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R43 静态规范与门禁** | tsc、ESLint、prettier/format、import graph、生成文件校验和构建模式。 | CI/脚本执行输出、失败用例。 |
| **R44 ADR/README 与源码一致性** | 失效的路径、过时依赖、错误测试数量、历史迁移状态标记。 | 文档漂移清单、当前基线更新时间。 |
| **R45 技术债与变更影响** | 测试可替换性、扩展成本、弃用计划、维护者理解成本、代码所有权。 | 变更波及面、风险/收益与迁移顺序。 |

## 12 构建发布、诊断与运维

| ID / 维度 | 必查项（检查对象） | 证据与验收准则 |
|---|---|---|
| **R46 构建可复现与交付** | 锁版本、Node/pnpm、CI、Bundle 产物、配置隔离、回滚与审计。 | 干净环境重建、产物摘要与构建日志。 |
| **R47 可观测性与性能诊断** | 错误日志、Correlation ID、GPU Errors、帧时间、Worker 健康状态和追踪。 | 指标字典、示例 trace、最小诊断流程。 |
| **R48 部署运行与恢复** | 健康检查、服务降级、缓存升级、生产/演示隔离、权限配置、版本兼容。 | 发布/回滚演练、运行手册、故障恢复演练。 |

# 3. SemiconFab-Next 专项深度审计

以下专项在 R01–R48 之上单列，并形成独立结论。通用 Web 审查不能代替 GPU、实时系统或工业数字孪生的验证。

## 3.1 React / TypeScript / Router / Effect 4 / XState

- **类型与接口：** 检查 `any`、不安全断言、无法表达 `FabId/RunId/CommandId` 区别的裸字符串；针对外部输入使用运行时 Schema。
- **Router：** code-based route tree（`routes/route-tree.ts`）URL/search/404/error 单一所有权；loader 通过 `ensureResource` 与页面共享 Resource Atom；核验无 routeTree 生成物/router plugin。
- **Effect 4 AppRuntime：** 单一 `ManagedRuntime`/`AtomRegistry`；`Effect.run*` 仅在 `app/app-runtime.ts`、`runtime/command-stream.ts`、`runtime/command-workflow-scope.ts` 与登记的 transport 边界；禁止第二 registry/cache。
- **Resource Atom：** 远程快照唯一 owner；检查 freshness/idle TTL/single-flight/previous-value/错误保留/取消；router loader、页面、mutation 共享同一实例；禁止第二 Map/Effect Cache/Store 快照。
- **XState/Effect：** actor 生命周期由 Effect Scope 管理；命令信号只经 `CommandEventSource` Stream；禁止 RxJS/Query/Zustand 参与命令状态；
- **高频路径：** telemetry TypedArray/Worker/Babylon 对象不进入 AtomRegistry；100ms 合批与逐帧 React state 禁令仍适用。
- **XState：** Actor 生命周期、终态保留、Revision 单调、命令去重、权威状态核对；UI 只读投影、不直连 Actor 实现。
- **组件：** Portal/Dialog/焦点恢复、错误边界、Suspense、Hydration/卸载清理、稳定的事件闭包。

## 3.2 WebGPU / Babylon Lite / 场景架构

- **渲染链路：** `ScenePort（application/ports/scene.ts）→ Lite Backend（rendering/lite-backend.ts）→ Scene/Engine → GPU`；React 不直接持有 Mesh/Material/GPUBuffer。
- **资源所有权：** GPUBuffer、Texture、Pipelines、材质、Picker、定时器、回调、设备丢失后旧代际引用必须释放或失效。
- **性能：** Draw Calls、实际 triangles、Thin Instance 上传、GPU 时间、CPU/GPU 同步、Shader 编译、阴影 Cascades、Transparent/PBR/IBL 成本。
- **Picking：** Hover/Click 并发顺序、GPU readback、移动节流、Drag-vs-Click、失效结果覆盖；要测实际输入到响应延迟。
- **相机：** CSS 尺寸与 DPR、轨道手感、阻尼、触控板/手势、相机视图恢复，不把交互体验误判为渲染 FPS。
- **场景恢复：** `device.lost`、重建资源、保留合理选择/相机状态、拦截迟到重放、GPU Error 计数。
- **高频 Hot Path：** 不允许每帧无界集合增长、不必要矩阵上传、不必要 React Commit；零分配只作为热点目标，不作为普遍强制原则。

## 3.3 实时数据、Worker、事件语义

- **链路：** `SSE → Decoder → Worker → TypedArray/RingBuffer → Scene State Binding`，明确哪些数据是完整快照、哪些是稀疏 Delta。
- **水位：** `fabId + stream generation + epoch/sequence` 的生命周期明确；跨重连不得沿用错误的旧水位。
- **回压：** 在途消息上界、Pending 合并语义、满队列策略、丢弃/覆盖合法性、最后一帧故障重放。
- **恢复：** Worker 构造失败、postMessage 抛异常、迟到回复、error/messageerror、定时器清理、SSE 持续断线。
- **真实负载：** 至少测试固定 16 槽演示路径与未来 500/2000/5000 实体规模；不能假设 16 槽实现具备多千实体通用性。

## 3.4 FAB 领域与工业边界

- **身份模型：** Site/FAB/Equipment/Chamber/Carrier/Lot/Run/Recipe 的身份、层级、权限和全局唯一性；物理设备与屏幕实例 ID 不得混淆。
- **三 FAB：** 独立身份与状态、独立/共享厂务两种拓扑模式、跨 FAB 聚合指标的来源追溯、边界隔离负例。
- **控制命令：** 前端操作不等于权限，服务端执行身份/能力/前置条件/重复提交校验；模拟与真实 OT 的通道必须隔离。
- **工业语义：** SEMI/GEM/GEM300/SECS/HSMS/AMHS/EAP 的映射和状态机仅在实现相应协议时评审；不得虚报不存在的合规能力。
- **权威性：** 界面展示值、仿真估计值、真实设备遥测和历史回放须有明确标识与来源，避免误导。

## 3.5 仿真、轨迹与时间一致性

- **时钟：** 权威仿真时钟、渲染时钟、UI 更新时间和现实时间明确分开；暂停/倍速/恢复不能重复推进。
- **确定性：** PRNG、种子、事件队列、Stable ID、同输入同结果；Golden Vector 与原版行为对照。
- **数值与轨迹：** 定步长、插值、路径弧长、最坏帧预算、浮点精度、设备动画离散步长。
- **场景副作用：** 改变 Camera/Layer/LOD 不应改变权威仿真结果；可视化异常不应污染仿真。

## 3.6 资产、生成代码与可追溯性

- **资产链：** 原始静态结构 JSON、Packed TypedArray/TS、设备目录、材质、位姿、源与目标 Hash；生成器必须可复现且有一致性测试。
- **几何：** 坐标系、米制、Y 轴约定、左右手系转换、世界矩阵；对不同来源资产应有统一验证。
- **许可证：** 原版 SemiconFab 内容/模型和第三方库分别核对授权；源代码可见不自动等于商业可用。
- **生成文件：** 标记只读、可再生、无需人工维护；不把 1.7MB 生成模块误报为普通复杂度问题。

# 4. 跨模块依赖与关键数据流

## 4.1 逻辑架构和允许依赖

```text
UI/Features ─┬──> Application/Use Cases ──> Domain Contracts
             ├──> Router / Query (HTTP server-cache owner)
             ├──> Zustand (UI state owner)
             └──> ScenePort (application/ports/scene.ts; rendering port)
App/Composition Root ──> Runtime + Realtime + Concrete Lite Backend
Runtime ──> CommandWorkflow contracts + Coordination + XState adapter
Realtime Transport ──> Message/Command contracts + Worker/Buffer
Rendering/Lite ──> Scene contracts + Pure domain projections
```

此图是建议的**依赖规则**，并不要求物理拆成 npm workspace。Composition Root 可以依赖具体实现；业务纯算法不得反向引用 React/Router/Babylon。

## 4.2 必须端到端追踪的链路

| 链路 | 关键检查 | 结果证明 |
|---|---|---|
| URL → Loader → Query → Feature | 预加载、新鲜度、导航/参数同步、FAB identity | 深链/前进后退/后台刷新集成测试 |
| REST + SSE → Ordered Gate → Query → UI | Epoch/Sequence、身份、迟到数据、订阅复用 | 乱序与重连故障测试 |
| Command UI → HTTP Gateway → SSE → Bridge → XState | 授权、幂等、终态恢复与寿命 | 命令时序与重复提交测试 |
| SSE → Worker → TypedArray → GPU | 回压、帧合并、渲染 Hot Path | 负载/GC/GPU/一致性对照 |
| User Input → Camera/Selection → Scene | 输入所有权、竞态、迟到 pick、Tour 冲突 | E2E 输入记录与帧追踪 |
| Static Asset → Generator → Lite GPU Resource | 内容 Hash、坐标/单位、GPU 生命周期 | 生成器 Check、黄金向量、设备丢失测试 |

# 5. 证据级别、严重性与置信度

## 5.1 证据分层（不得混淆）

| 级别 | 证据形式 | 可做出的结论 |
|---|---|---|
| E0 — 假设 | 经验推测、未看到源码 | 仅作为待调查事项 |
| E1 — 静态证据 | 具体源码行、配置、可推导路径 | 可宣告静态缺陷；不可宣告已发生运行时故障 |
| E2 — 自动化复现 | 运行通过的负例/单元/集成测试 | 可以确认可重现行为及其边界 |
| E3 — 真实运行复现 | 浏览器/OS/GPU/后端现场日志与最小步骤 | 可以确认实际环境影响 |
| E4 — 可重复测量 | 固定环境、重复样本、分布、原始 Trace | 可作性能/资源趋势对比结论 |

每项 Finding 必须保存 `confidence: high|medium|low` 和 `evidence_level: E0..E4`。置信度是判断可信程度，不等于严重性；高严重性低置信度必须先调查。

## 5.2 缺陷分级

| 级别 | 定义 | 发布决策 |
|---|---|---|
| P0 | 重大越权、权威数据破坏、严重安全/工业控制风险 | 阻断发布，立即修复 |
| P1 | 核心功能错误、重大并发竞态、频发崩溃/严重回退 | 发布前修复或有正式风险例外 |
| P2 | 可复现的局部错误、重要内存泄漏、明确的维护性破坏 | 近期排期并增加回归测试 |
| P3 | 有证据的局部效率、可读性和组织问题 | 按成本收益处理 |
| P4 | 风格偏好、可选模式、非必要整洁化 | 不作为强制整改项 |

还应区分 `Bug / Security / Performance / Architecture / Reliability / Maintainability / UX / Documentation / TestGap` 类型；一个发现不要为同一根因重复开多个单。

# 6. 工具与测试执行规范

## 6.1 基线操作

1. 查询远端 HEAD 并保存 SHA；如果存在未提交变更，必须报告；只读审计不得悄悄修改文件。
2. 读取 `README`、ADR、架构规范、`package.json`、`tsconfig`、Vite、实际目录树、入口和路由。
3. 生成导入依赖图和导出引用图；包含静态 import、动态 import、`import type`，标明运行时依赖与纯类型依赖的不同。
4. 从关键链路优先分析行为正确性，再抽样检查数据结构、算法、性能热点与低风险可读性。
5. 对可疑点设计最小失败输入；无法执行时保留为未验证风险，绝不写“已复现”。

## 6.2 建议工具链

| 工具/方法 | 任务 | 限制 |
|---|---|---|
| `tsc --noEmit` / TS Compiler API | 类型、符号和依赖图 | 编译通过不等于业务正确 |
| ESLint / 静态规则 | 一致性和潜在错误 | 规则须符合项目实际约束 |
| Vitest + Testing Library | 单元、契约、组件与集成 | Mock 不能替代真实 GPU |
| Chrome DevTools / React Profiler | CPU、Commit、GC、交互 | 需要固定浏览器和硬件 |
| WebGPU diagnostics / GPU timestamp（若支持） | GPU pass、draw、upload、errors | 不可假设全部 Adapter 支持 timestamp-query |
| E2E / 自动输入回放 | URL、键鼠触控、恢复、权限提示 | 注意环境和时序不稳定性 |
| Heap snapshots / soak | 内存与资源增长 | 区分正常缓存与泄漏 |
| 安全检查 / 后端负例 | 身份、FAB 隔离、协议污染 | 前端 UI 检查不能替代后端鉴权 |

## 6.3 验证要求

- 按测试单元记录运行命令、退出码、通过/失败/跳过数量、环境、时间、Commit 和 Evidence 文件路径。
- 引擎/GPU 测试必须区分 Headless、真实窗口、软件/硬件 Adapter；不能用 RAF 数量代替 GPU 真正渲染证据。
- 需要修改代码验证的场景必须创建独立测试分支或临时工作区，不得破坏当前开发分支；默认不生成 PR。
- 性能优化的证明包括 Before/After 与相同负载；仅凭“分配减少了”不能推出用户体感更快。

# 7. 性能验收与基准方法

## 7.1 场景矩阵

| 场景 | 关键负载 | 必采指标 |
|---|---|---|
| 冷启动/暖启动 | 3D 首次打开、缓存命中 | 首帧、可交互时间、JS/资源传输量 |
| 静止场景 | 60Hz/120Hz、不同 DPR、阴影开关 | GPU/CPU 帧时间、Draw Calls、VRAM |
| 相机拖动 | 旋转、平移、缩放、快速反向 | 输入-显示延迟、帧时间 p95/p99、丢帧 |
| Hover/Click | 高速移动、交错点击、双击 | GPU Picking 延迟、回压、错误命中 |
| AMHS/人员/晶圆 | 不同动画活跃率和倍速 | JS 分配、上传、GC、数值稳定性 |
| SSE/Worker 压力 | 16 槽及 500/2000/5000 实体演进目标 | 端到端延迟、丢弃/合并、CPU/堆、内存上界 |
| 模式切换 | FAB/楼层/图层/设备详情快速切换 | 资源释放、内存趋势、p99 延迟 |
| Device Lost / 网络故障 | 多次故障与重建 | 恢复时间、GPU Errors、丢失状态、泄漏 |

## 7.2 统计与可信度

- 同一浏览器、GPU、驱动、屏幕尺寸、CSS Canvas 尺寸、DPR、场景内容和功耗状态比较原版/Next 或新旧 Commit。
- 采集至少多个稳定样本，分别报告 p50/p95/p99、最大值、样本数、置信区间或重复差异；不要只报告平均 FPS。
- 为每次结果保留原始 Trace/JSON；基准要能够被同事在同一机型复现。
- 为性能预算设置明确数字时必须标记为 **项目目标值（非实测事实）**；目标由真实设备验收后冻结。

## 7.3 优化决策顺序

1. 先确认业务正确性和同步语义不被破坏。
2. 定位长尾（p95/p99）瓶颈，验证 CPU / GPU / 网络 / GC 中的实际主因。
3. 优先局部优化（数据结构、合批、缓存、资源复用），必要时再调整模块边界。
4. 有 Before/After 和回归覆盖后才接受；若收益不显著而复杂度上升，应回退优化。

# 8. 综合评分与发布门禁

## 8.1 加权参考（可随项目阶段调整）

| 类别 | 权重 |
|---|---:|
| 业务与功能正确性 | 20% |
| 架构与代码设计 | 15% |
| 性能与资源效率 | 15% |
| 安全与权限 | 15% |
| 稳定性与并发正确性 | 15% |
| 测试与验证质量 | 10% |
| 交互体验与可访问性 | 5% |
| 工程交付与运维 | 5% |

每类 0–10 分，`总分 = Σ(该类得分 / 10 × 权重)`，结果为 0–100。所有得分必须有证据依据。证据不足则填 `NOT-SCORED`，不得擅自补默认分。

## 8.2 阻断规则

- **存在未解决 P0：** 不允许通过发布门禁。
- **存在未批准例外的 P1：** 不允许通过发布门禁。
- **关键测试或 GPU 验证未执行：** 报告必须标注“条件性 / 未完成验收”，不能评为生产可用。
- **重要数据/权限边界未验证：** 不得借综合高分覆盖此风险。

# 9. AI Agent 执行 SOP

## 阶段 A：发现与建模

1. 锁定 SHA、环境和审计范围，识别生成文件与只读资产。
2. 构建模块清单、依赖图、入口调用图，识别公共接口及实际调用方。
3. 将全量 R01–R48 分配到真实文件或外部验收对象；记录 `NOT-APPLICABLE` 的理由。

## 阶段 B：分层源码审查

4. 按 `App/Router/Query → Feature/State → Application/Runtime → Realtime/Worker → Rendering/Lite → Domain/Assets` 顺序逐模块检查。
5. 对大文件使用责任清单与变化点分析，不以行数本身判错。
6. 对安全、业务、异步、数据边界优先生成最小失败输入；检查测试是否覆盖该输入。

## 阶段 C：可验证复现

7. 运行已有质量门禁，并记录真实结果；若工具权限有限，不得虚报。
8. 在允许的环境执行浏览器/GPU/故障注入与稳态测试，保留证据。
9. 对性能改进必须执行匹配的 A/B；对无法复现的问题降级为“风险或待调查”。

## 阶段 D：独立复核与结论

10. 每个 P0–P2 Finding 均由第二审查视角检查因果链、严重性、负例及与已有测试的冲突。
11. 将重复发现按同一根因归并，按价值/风险/依赖排序；标注无需整改的优良设计。
12. 形成完整报告、问题台账与阶段整改建议，未经授权不改代码、不建 PR、不推送。

## 9.1 Agent 强制检查清单

- [ ] 已锁定 Commit；不混合不同提交的现象与代码。
- [ ] 48 项均有结论或 N/A 原因。
- [ ] 每个 Finding 带有文件/行号或实际复现路径。
- [ ] 静态推断与运行实测严格区分。
- [ ] 涉及性能问题有可重复数据或标明待验证。
- [ ] 涉及安全问题有明确攻击边界与风险。
- [ ] 对生成文件、领域黄金向量、热路径不做机械格式化或拆分。
- [ ] 不将“建议”伪装成必须执行的缺陷修复。
- [ ] 报告包含正面确认与遗留风险。
- [ ] 修改授权和发布权限明确。

# 10. 交付清单与报告模板

## 10.1 最终交付物

| 产物 | 最低内容 | 推荐文件名 |
|---|---|---|
| 审计总报告 | 执行摘要、范围、评分、P0–P4、主要结论 | `web-review-report.md` |
| 模块与依赖矩阵 | 文件/模块职责、进出依赖、循环与违规边 | `module-dependency-review.csv` |
| 48 项检查矩阵 | R01–R48 结果、证据与 N/A 理由 | `review-checklist.csv` |
| 缺陷台账 | 位置、复现、严重性、风险、修复与验证 | `findings.json` |
| 性能与资源基准 | 工作负载、环境、原始数据、分位数 | `performance-evidence.json` |
| 测试覆盖/风险矩阵 | 行为、故障模式、测试文件、缺口 | `test-risk-matrix.md` |
| 整改路线图 | 依赖顺序、阶段范围、验收门禁 | `remediation-plan.md` |
| 证据索引 | 代码引用、Trace、日志、截图、生成器 Check | `evidence-index.md` |

## 10.2 单条 Finding 模板

```yaml
id: WEB-REV-001
title: "问题标题（具体、可定位）"
category: "Reliability"
severity: "P2"
confidence: "high"
evidence_level: "E2"
status: "OPEN"
baseline_commit: "<full SHA>"
locations:
  - path: "web_app/src/..."
    lines: "100-125"
problem: "观察到的错误行为/明确的设计缺口"
trigger: "触发条件/最小复现步骤"
expected: "期望行为或不变量"
actual: "已确认的实际行为（未实测则注明静态推断）"
root_cause: "可追溯根因"
impact: "受影响的 FAB/用户/设备/负载范围"
evidence:
  - "测试/日志/Trace/行号及提交信息"
recommendation: "最小必要修复方案"
alternatives: ["保留现状的条件", "其他方案及其成本"]
regression_test: "新增或更新的测试和断言"
acceptance: "可观察、可复现的通过标准"
```

## 10.3 总报告章节模板

1. Executive Summary：当前状态、核心风险、阻断项、无需改动项。
2. Baseline：SHA、环境、范围、无法获取的证据。
3. Architecture：目录、模块边界、依赖/状态所有权图。
4. Correctness and Reliability：领域正确性、竞态、错误恢复。
5. Performance：CPU、GPU、内存、加载、真实测量。
6. Security and UX：安全、权限、a11y、I18N、交互。
7. Findings：按级别和根因整理，所有 Finding 可验证。
8. Testing and Evidence：测试矩阵、未覆盖风险、原始数据。
9. Recommendations：局部修复优先、分阶段门禁、暂缓事项。
10. Limitations：只读、工具限制、未测模块、待验证声明。

# 11. 反模式与非目标

- 不为追求“架构纯洁”建立多余的 npm workspace、Repository/Service/DTO 层。
- 不把高频动画、矩阵、实时遥测放入 React State 或常规 Query 缓存。
- 不按文件长度惩罚经生成器产生的 TypedArray 数据或完整、纯粹的仿真算法。
- 不把 `any` 数量、圈复杂度阈值、文件数量当成没有上下文的唯一质量指标。
- 不在缺乏 Profile 时盲目引入对象池、缓存、手写内存管理或 GPU Compute。
- 不将前端设备按钮隐藏视为后端授权安全性。
- 不把 CI 模拟环境的 GPU 测试当作真实浏览器/驱动验收。
- 不要求没有实现的 OT/SEMI 协议宣称符合生产标准。
- 不将源代码可见直接视为开源许可证允许的再利用范围。

# 12. 定义完成（Definition of Done）

只有同时满足以下条件，才能声明“全面评审已完成”：

- [ ] 范围和 SHA 固定；所有工具限制已披露。
- [ ] 48 个维度与六类 SemiconFab 专项均有结果和证据索引。
- [ ] 所有 P0–P2 问题可定位、可复现或有明确静态证明，并经过独立复核。
- [ ] 功能、状态、权限、数据隔离的关键不变量有负例测试。
- [ ] 真实运行的 GPU/内存/交互/加载结论具有原始证据；没有测试的指标标记 NOT-VERIFIED。
- [ ] 保留项、风险接受项、待调查项与整改建议分开呈现。
- [ ] 评分和发布结论遵守阻断规则，不以综合分数覆盖 P0/P1。
- [ ] 所有报告与机器可读台账一致；没有未经授权的代码修改。

# 附录 A. 审计数据表结构

## A.1 检查矩阵字段

`dimension_id, category, scope, status, severity, confidence, evidence_level, commit, owner, findings, evidence_refs, tested_at, notes`

## A.2 基准数据字段

`scenario_id, baseline_commit, browser, os, gpu, driver, adapter, viewport_css, dpr, refresh_hz, entity_count, simulation_hz, samples, frame_p50_ms, frame_p95_ms, frame_p99_ms, gpu_p95_ms, pick_p95_ms, heap_delta_mb, gpu_errors, trace_path`

## A.3 验收例外记录

`finding_id, risk_owner, reason, compensating_control, expires_at, follow_up, approval_ref`。P0 不允许例外；P1 例外须由明确的责任人批准。

# 附录 B. 主要技术基线与参考原则

**当前项目技术参考（2026-10-29）：** React 19、TypeScript 7、Vite 8、TanStack Router（code-based）、Effect 4 + @effect/atom-react、XState v6 alpha、Babylon Lite/WebGPU、Worker/TypedArray、ASP.NET Core/.NET 11。Zustand/TanStack Query/Zod/RxJS 已移除。执行评审时以实际锁文件和 HEAD 为准。

**建议参照：** ISO/IEC 25010（质量特性分类）；OWASP ASVS 与 OWASP Top 10（Web 安全）；W3C WCAG（无障碍）；浏览器 Web Vitals/Performance API（体验）；TypeScript 官方类型设计；WebGPU 规范及浏览器实现限制；适用的 SEMI 规范与后端工业安全边界。

**项目内部资料（审计前先确认与 HEAD 一致）：** `web_app/README.md`、`scripts/README.md`、`web_app/tests/architecture/architecture-import-graph.test.ts`（R0–R6）、`web_app/tests/architecture/architecture-contract-rules.test.ts`（R7–R14）、`tools/check_architecture.py`、`tools/generated-artifacts.json`、`docs/architecture.md`（§30 为递归整改终态）、`docs/state-management.md`、`docs/rendering.md`、`docs/realtime-protocol.md`、`docs/adr/0009-tanstack-router-query-boundary.md`、`docs/adr/0010-command-event-bridge.md`。

---

**使用建议：** 将 Markdown 版本提交到仓库的 `docs/` 目录作为规范，按本文件的检查矩阵逐项审计。Word 版本用于评审会议、批注与归档。
