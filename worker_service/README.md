# worker_service

独立开发 Worker 调用真实后端确定性引擎，与 API 共用本机文件存储。必须指定 Development；其它环境启动抛错退出，不连接真实 OT。

从仓库根目录运行：

```powershell
$env:DOTNET_ENVIRONMENT = 'Development'
$env:Fab__DataDirectory = 'C:\FAB\SemiconFab-Next\.data'
dotnet run --project worker_service
```

API 使用相同绝对 `Fab__DataDirectory`；需要仅独立 Worker 执行时将 API 的 `Fab__EmbeddedWorker` 设为 `false`。未配置路径时 Worker 使用当前内容根下的 `.data`。Ctrl+C 关闭后，未完成作业会在租约到期后由后续 Worker 从冻结输入重新计算。

每个 Worker 顺序处理一个 FAB，可在同机启动多实例。当前提供本机开发用的持久化、幂等与租约 fencing，不提供 PostgreSQL、多机调度、持久 checkpoint、暂停/取消或 OT；详见 `orchestration_infrastructure/README.md`。
