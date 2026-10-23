# orchestration_infrastructure

已实现单机 Development 文件编排，公开 `AddLocalOrchestration(IServiceCollection, string dataDirectory)`、`FileRunStore` 和可用 `AddHostedService<SimulationWorker>()` 注册的 `SimulationWorker`。默认执行端口 `LocalSimulationExecution` 调用真实 `FabSimulation`。注册工厂与 Worker 启动均要求 `IHostEnvironment.IsDevelopment()`；直接构造 `FileRunStore` 留给显式测试。

每个 Run 一个 `runs/{id}.json`，结果保存在 `results/` 的 epoch 专属文件。全局 `.store.lock` 以 `FileShare.None` 提供跨进程互斥；锁仅保护读写和提交，不覆盖引擎执行。所有状态变更持锁读取当前值，校验 owner/epoch/租约期限后提交；结果先写入并 flush，再通过同卷原子替换发布包含 checksum 的 Run 元数据。提交边缘再次检查租约有效期。查询已完成执行时验证结果存在及 checksum，损坏结果不会作为成功结果返回。

幂等范围为规范化 Site UUID / principal / CreateRun / key；相同请求重放原始 QUEUED/version 1 创建响应，即使 Run 后续已完成；当前状态通过 Get/List 查询。异请求抛 `orchestration_application.IdempotencyConflictException`，不依赖 HTTP。Run 先落盘再更新索引；进程在中间退出时，下一次相同范围提交从 Run 文件修复索引，创建响应也从冻结记录重建。请求被序列化复制后冻结，并通过引擎公开验证入口检查格式、模式、重复成员、工作量与整数边界；Site/FAB 业务目录绑定由 API 的 SiteDirectory 校验。

每个 Independent FAB 一个租约，默认 30 秒；Worker 每 10 秒续租。过期或重启后的执行从冻结输入重跑，新领取递增 epoch，旧 epoch 不能续租、提交结果或失败状态。失败成员保持 FAILED，不自动重试，其余已排队成员继续执行，Run 始终汇总 FAILED。只有全部结果已登记才汇总 COMPLETED。没有暂停/取消命令、持久化引擎 checkpoint、连续事件账本、Outbox 或完整运行 Manifest。

边界：仅本机本地磁盘与受信开发身份，不提供 PostgreSQL 事务、多机/共享文件系统能力、容灾、清理策略或真实 OT。UNC 数据目录拒绝。文件 flush 与原子替换覆盖进程崩溃窗口；未验证断电/磁盘故障恢复，孤立结果和临时文件可能需要人工清理，存储损坏会失败关闭。单个 Worker 顺序执行 FAB；可在同机启动多个 Worker，共用同一绝对数据目录。
