# SemiconFab Next 工程基座与首个独立仿真切片 Implementation Plan

> 2026-10-23 布局迁移：本计划写于旧嵌套布局。项目已按 `docs/adr/0001-flat-project-layout.md` 改为根级扁平小写下划线目录、无总 solution、逐项目独立构建；下列路径已尽量机械更新。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. 用户已明确授权按审阅后的规范搭框架并开始编码，连续执行。

**Goal:** 建立完整模块工程布局，并交付可构建、可运行的三 FAB 独立仿真开发闭环。

**Architecture:** .NET 11 模块化单体，独立 Worker 可执行宿主；React/Vite 与引擎无关场景 Port、Babylon WebGPU 实现分离。首个开发切片用明确限定为 Development 的文件元数据适配器，无数据库时仍可运行；生产启动失败关闭，PostgreSQL 迁移和后续能力逐项登记。

**Tech Stack:** .NET SDK 11.0.100-rc.2.26504.105、Node 24、pnpm 12.15.0、React 19.3.1、TypeScript 7.0.2、Vite 8.3.5、Babylon 9.32.0。

**Spec:** `../SemiconFab-Next-Engineering-v1.1/README.md` 及 engineering/10、11、12、13、15、19、21 和 18 个模块规范。

## Global Constraints

- 当前 3 FAB，同一模板、不共享运行状态；数量可配置。首切片拒绝 SHARED_CAPACITY/COUPLED_FLOW，不伪装已实现。
- 权威 DES 在后端，整数微秒、稳定事件顺序、可序列化固定 RNG；DTO 的 64 位数使用十进制字符串。
- Contracts 不引用 Domain；Application 不互相引用；Core 不依赖 HTTP/DB/GPU。
- 只创建 WebGPUEngine，不存在 WebGL fallback；OT 默认禁止。
- 新目录是本次隔离工作区；不修改原参考项目，不发布远程仓库。

## Review Focus

- 无效数值、重复 FAB/未知 FAB、溢出与超大工作量必须拒绝。
- 相同输入轨迹相同；只改一个 FAB 不影响其它 FAB；暂停/检查点不能改变随机流。
- 同幂等键异请求冲突；过期租约旧 Worker 不能提交结果。
- 页面切换及迟到响应不能串 Run/FAB；缺少 WebGPU 明确提示。
- 非 Development、外部地址、缺少开发身份不允许使用演示存储或启动真实控制。

### Task 1: 工程/契约基座（主代理）

**Files:** global.json（无总 solution，各项目自带构建配置）、fab_* 共享库目录、全部模块 csproj、docs/modules、contracts/json-schema、tools/check_architecture.py。

**Interfaces:** `fab_contracts` 的 ScenarioDefinition、FabScenario、RunSummary、FabExecutionSummary、FabSimulationResult、RunResult；`simulation_runtime.FabSimulation.Execute(ScenarioDefinition,string,CancellationToken)`。

- [ ] 生成规范中的目录、项目引用和模块进度清单，空模块只保留项目与 README，不返回虚假成功。
- [ ] 定义 DTO 与 JSON Schema，前端从 Schema 生成 TS 类型，禁止手写第二份协议。
- [ ] 构建 solution 并通过依赖 DAG 检查。

### Task 2: 确定性内核（engine 任务）

**Files:** simulation_core、Models、Runtime，simulation_tests。

**Interfaces:** 固定契约见 Task 1；Runtime 公共 FabSimulation 无参构造，Execute 同步纯函数，可选内部 Checkpoint/恢复 API。

- [ ] 先写并运行失败测试：稳定顺序、同 seed/恢复轨迹一致、FAB 隔离、非法输入与取消。
- [ ] 实现 FIFO 单设备合成模型：每 FAB 独立 Lot 队列、整数加工时长和固定 RNG 派生；Warmup 用半开区间统计。
- [ ] 提供可序列化队列/RNG/状态快照并测试恢复；语义哈希排除 RunId/墙钟。
- [ ] 测试通过，记录具体数量及未覆盖的实际制造模型。

### Task 3: 编排与 Worker（orchestration 任务）

**Files:** orchestration_*、worker_service、orchestration_tests。

**Interfaces:** `AddLocalOrchestration(IServiceCollection,string)`；`IRunService.Submit(CreateRunRequest,string principal,string key) -> RunSummary`，Get(Guid)、List()、GetResults(Guid)；可选托管 `SimulationWorker`。

- [ ] 先写失败测试：幂等重试/冲突、跨进程可见、重复领取、过期租约 fencing、完成状态必须有结果。
- [ ] 实现 Development 文件适配器：每 Run 独立文件、独占锁、原子替换、每执行域租约、结果目录提交；清楚标注单机本地限制。
- [ ] Worker 在持久化事务外调用 Task 2；实现故障状态并拒绝旧租约提交。
- [ ] 提供独立 Worker 启动配置和清楚的生产禁用边界。

### Task 4: React 工作台与 WebGPU（frontend 任务）

**Files:** web_app、web_* 包目录 全部包、pnpm 配置、TS 生成工具与 frontend 测试。

**Interfaces:** REST GET /api/v1/sites、GET/POST /api/v1/runs、GET /api/v1/runs/{id}、GET /api/v1/runs/{id}/results。生成 DTO 与后端同源。

- [ ] 为 API 错误/迟到响应隔离/场景 scope 管理先写失败测试。
- [ ] 实现中文工作台：Site/FAB 概览、合成场景参数、创建 Run、运行状态与结果/KPI、明确数据来源与未实现能力。
- [ ] 实现 facade/backend 注入，三个 FAB 共享不可变几何、独立根和动态状态；右手系、米、WebGPU-only、卸载取消/释放。
- [ ] 安装精确依赖并锁定，类型检查、测试与生产构建通过。

### Task 5: API、开发启动与集成（主代理）

**Files:** api_service、Identity/Site/Analytics 实现、api_tests、scripts、infrastructure、CI。

- [ ] 先写请求验证、身份拒绝、Run 创建/查询全链路失败测试。
- [ ] 提供仅本地 Development 的显式身份与数据路径，非 Development 启动失败关闭；真实 OT/Reatime 宿主不启动业务假服务。
- [ ] 接入 Task 3，DTO/ProblemDetails/ETag/幂等，提供真实 API smoke、OpenAPI 和启动脚本。
- [ ] 保存 PostgreSQL 迁移起点/部署模板及后续工作清单，不将其列为已运行验收。

### Task 6: 交付验证与审查

- [ ] Debug/Release 构建、后端测试、前端检查/测试/构建、架构检查、真实 API smoke。
- [ ] 独立审查并修复重要发现，重新运行受影响检查。
- [ ] README 给出启动命令、已实现/框架/后续功能、工具版本及真实验证范围。

## Progress

初始：Task 1–6 待执行。后续结果记录在 `docs/IMPLEMENTATION-STATUS.md`；不以目录存在或构建成功代替功能验收。
