# orchestration_tests

运行 `dotnet test orchestration_tests/orchestration_tests.csproj`。

覆盖幂等重试与冲突/身份范围、重建 Store 后持久化可见、两个实例及两个真实 dotnet 子进程抢占、过期租约与旧 epoch fencing、结果先于成功状态、提交瞬间租约过期（完成/续租/失败）、结果 checksum、索引恢复、真实引擎 UUID 规范化、计算期间可查询与续租、失败可见、生产环境关闭。

测试程序集保留一个仅供测试使用的进程入口（`dotnet orchestration_tests.dll claim <directory>`），用于证明 FileShare.None 的跨进程互斥，不扩展生产 CLI。没有验证断电、真实 PostgreSQL、多机/共享磁盘、完整故障注入与长时间运行能力。
