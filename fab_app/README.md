# fab_app

唯一的后端应用：合并了原来的 12 个域服务、2 个平台服务与 4 个宿主。同一个可执行文件支持多种运行模式：

```powershell
dotnet run --project fab_app                 # API 模式（默认，127.0.0.1:5080）
dotnet run --project fab_app -- --worker     # Worker 模式（独立消费 Run）
dotnet run --project fab_app -- --realtime   # 占位：返回错误码 2（实时流未实现）
dotnet run --project fab_app -- --ot         # 占位：返回错误码 2（OT 未实现）
```

- API 与 Worker 都要求 `DOTNET_ENVIRONMENT=Development`；生产身份、PostgreSQL 与真实 OT 尚未实现，非 Development 启动会失败关闭。
- 默认数据目录为内容根下的 `.local/data`；可用 `Fab__DataDirectory` 覆盖。API 与 Worker 使用同一目录共享 Run 元数据。
- API 默认内嵌 Worker；设置 `Fab__EmbeddedWorker=false` 后由独立 Worker 进程执行。
- API 需要 `Fab__DevelopmentKey`（≥32 字符）；根目录 `scripts/start-dev.ps1` 会自动生成开发密钥并启动 API + `web_app`。

模块代码仍在命名空间 `Fab.Site`、`Fab.Orchestration`、`Fab.Analytics`、`Fab.Identity` 等中；跨模块协作通过 `fab_shared` 中的契约与仿真内核。

HTTP API（仅 Development、开发密钥鉴权）：
`GET /health/live`、`GET /health/ready`、`GET /api/v1/sites`、`GET /api/v1/capabilities`、
`GET|POST /api/v1/runs`、`GET /api/v1/runs/{id}`、`GET /api/v1/runs/{id}/results`、`GET /api/v1/sites/{siteId}/kpi`。
