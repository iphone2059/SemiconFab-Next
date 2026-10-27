# scripts

在仓库根目录直接运行，支持 Windows PowerShell 5.1 和 PowerShell 7：

```powershell
./scripts/start-dev.ps1
```

默认启动 API `http://127.0.0.1:5080` 与 Web `http://127.0.0.1:5173/`，自动生成并复用 `.local/development-key`。需已安装仓库指定的 .NET SDK、Node.js/npm，并完成 `web_app` 依赖安装。前端沿用 `npm run dev`，无需全局 pnpm shim。

脚本等待 API 与 Web 就绪后显示地址。API、Web 输出分别写入 `.local/api.log`、`.local/web.log`，错误输出在同目录的 `*-error.log`；可在另一终端用 `Get-Content .local/web.log -Wait` 查看。按 Ctrl+C 会清理本次启动的 API、npm 与 Vite 子进程。端口占用会直接报错，已有服务不会被停止。

```powershell
# 仅 API（默认内嵌 Worker）
./scripts/start-dev.ps1 -ApiOnly

# 关闭 API 内嵌 Worker；仍需另行启动独立 Worker
./scripts/start-dev.ps1 -SeparateWorker

# 同时保留另一套服务：端口、密钥、数据、日志与构建产物均隔离
./scripts/start-dev.ps1 -ApiPort 5280 -WebPort 5273 -LocalDirectory '.local/second dev'

# 不启动产品服务的回归检查
./scripts/test-start-dev.ps1

# 实际启动、HTTP 冒烟与取消清理检查（默认使用 5280 / 5273）
./scripts/smoke-start-dev.ps1
./scripts/smoke-start-dev.ps1 -ApiOnly -SeparateWorker
```

启动构建产物保存在所选本地目录的 `artifacts/`，避免覆盖另一运行中 API 持有的默认 Debug DLL。脚本为本次启动显式设置 API 地址与 Vite 代理目标，退出后恢复调用终端的相关环境变量。冒烟检查保留 `.local/startup smoke */` 日志与隔离数据，便于诊断。

工程边界已预留；功能与验证状态见 `docs/IMPLEMENTATION-STATUS.md`。
