# React 仿真工作台

在仓库根使用 Node 24.22.0 和 `npx --yes pnpm@12.15.0 install --frozen-lockfile`。本地服务启动见根目录 `scripts/start-dev.ps1`；手动运行前须为 API 设置 `Fab__DevelopmentKey`，为前端代理设置相同的 `FAB_DEVELOPMENT_KEY`，再执行 `npx --yes pnpm@12.15.0 dev`。

Vite 仅绑定 127.0.0.1:5173；`/api` 默认代理至 localhost:5080。`FAB_API_TARGET` 只能指向本机 HTTP(S) 地址。开发密钥由代理读取并注入，浏览器请求中任何同名身份头都会被移除后覆盖。不要使用 `VITE_` 变量保存密钥。缺少开发密钥会显示真实的 API 身份错误。生产构建不含开发代理，尚未提供生产身份和部署入口。

工作台从 API 获取站点、FAB 和运行记录，创建 INDEPENDENT 合成 FIFO 场景，并以不重叠的 HTTP 全量轮询显示提交结果。轮询取消和代际隔离保护页面/Run 切换；没有 WebSocket、SignalR、二进制状态流、真实产线指标或 OT 控制。

8 个包边界遵循工程规范：`contracts` 为生成类型入口；`api-client` 为 HTTP；`realtime-sync` 对外名为 `@fab/state-sync`，当前只提供作用域/序号与开发轮询；`fab-scene` 定义引擎无关 Port；`babylon-webgpu` 实现 Port；`app-ui`、`widgets`、`charting` 提供 UI/指标/整数完成比例。React bootstrap 注入 backend，无反向引擎依赖。

3D 只创建 WebGPUEngine，共享静态几何并使用独立 FAB 根。坐标为米、右手系、+Y up；占位设备不是制造模型。缺少安全上下文、WebGPU 或 adapter 时明确报错；绝不回退 WebGL。卸载会取消异步初始化、停止帧循环并释放资源；设备丢失后停止提交，Babylon 重建设备及静态资源后恢复，亦可手动重新加载视图。目前不含动态设备状态快照。无 GPU 测试只验证准入和取消，不代表真实渲染、设备恢复或性能验收。

验证命令：`npx --yes pnpm@12.15.0 typecheck`、`npx --yes pnpm@12.15.0 test`、`npx --yes pnpm@12.15.0 build`。GPU 依赖单独成 chunk，当前约 1.9 MB（gzip 448 kB）；构建器的大 chunk 提示保留，以便后续量化优化。

生命周期适配针对 Babylon 9.32.0：其 WebGPU `dispose()` 不能安全处理尚未初始化的 helpers，故卸载先取消并停止提交，等待 `initAsync` settle 后恰好清理一次；初始化失败时销毁部分 device 并执行 Babylon DOM/base 清理。该版本相关路径需要在升级引擎时复核。

若 Windows 上 npx 缓存安装跳过 pnpm 自带安装脚本，可能无法执行 pnpm shim。先在该缓存的 `pnpm` 包目录执行 `node install.js`，再重新运行 npx；不需要全局安装。
