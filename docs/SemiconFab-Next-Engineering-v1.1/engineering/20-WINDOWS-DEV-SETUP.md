# 20 — Windows x64 开发环境、工程启动、构建与本地调试

## 1. 基线工具

- 使用仍在安全支持期的 Windows 11 x64 与 PowerShell 7；Windows 10 仅在明确记录受支持版本及扩展安全维护安排后进入兼容矩阵，不再将所有 Windows 10 版本视为默认支持环境。
- Visual Studio 2026 Enterprise + MSVC（C++ x64 编译/调试）；.NET 11 SDK 为目标线，由 `global.json` 固定。2026-10-23 的 RC2 验证需匹配官方说明的 VS 2026 Insiders 或受支持 CLI 环境；不能假定任意 VS 2026 安装均兼容。生产准入仍执行本项目 GA 与依赖验证门禁。
- Git、受支持的 Node.js LTS、pnpm、TypeScript 正式版本、PostgreSQL 受支持正式版本、Protobuf/Buf 生成器、CMake/Ninja（可选 Native）。固定确切版本及 Node engines 范围；Vite 8 官方最低要求为 Node 20.19+ / 22.12+，最低版本不等于仍受安全支持的推荐版本。
- Microsoft Edge/Chrome 最新经兼容验证版本、支持 WebGPU 的 GPU/驱动。远程桌面或 Windows Server 的 WebGPU 能力不能凭操作系统名推断。

工具状态与官方出处见 `90-DECISIONS-AND-OPEN-ITEMS.md`；版本快照须在每次建仓/发布时刷新，不根据本文自动安装 Preview 或切换项目目标框架。

## 2. 标准启动命令（示例，需要项目代码实际存在）

```powershell
# 根目录
pwsh -NoProfile

git clone <your-project-repo-url> SemiconFab-Next
Set-Location .\SemiconFab-Next

dotnet --info
node --version
pnpm --version

dotnet restore .\SemiconFab.slnx
pnpm install --frozen-lockfile

dotnet build .\SemiconFab.slnx --configuration Release --no-restore
pnpm -C .\apps\web build

dotnet test .\SemiconFab.slnx --configuration Release --no-build
pnpm -C .\apps\web test
```

**注意：这些是未来完成 Monorepo 后的约定命令，当前规范包仅有设计和示例工件，不包含可执行的 `SemiconFab.slnx` 和应用源码。** 不应误认为已生成完整项目。

## 3. 本地服务配置

- `appsettings.Development.json` 仅放非敏感缺省值；PostgreSQL 连接字符串、OIDC Client Secret 和 OT Device Key 用环境变量或开发 SecretStore，不写入 Git。
- 由 `Fab.Api` + `Fab.Worker` + 本地 PostgreSQL + `apps/web` Vite 启动最小环境；SiteResources 在 Independent 默认 disabled。
- 首次运行执行迁移、注入**合成**的 3 FAB 模板，然后用 `CreateScenario(INDEPENDENT)` 开始仿真。
- WebGPU `https://localhost` 或浏览器认可的受信任 localhost 开发模式；无真实 GPU 时 UI 可显示非 3D 页面，但 3D E2E 必须在真实准入 GPU 运行。
- OT Gateway 默认不启动，不提供真实设备网络通道；开发环境不包含真实设备密码或可用生产 IP。

## 4. 最小 Bootstrap 验收

`/health/live`、`/health/ready`、`GET /api/v1/sites`、`POST /api/v1/runs` 需独立验收；各进程分别报告自身依赖就绪状态，WebGPU 就绪由浏览器诊断上报，不能用服务端健康探针宣称客户端 GPU 可用。首次开发基准验证模板→三独立 FAB→事件→Run Manifest→KPI 的完整链路。

## 5. C++ 路线

`native/Fab.Native` 通过 MSVC x64 构建 `fab_native.dll`，仅暴露 `extern "C"` ABI：opaque handle、显式生命周期函数、版本号、错误码、`struct_size` 兼容字段、稳定整数与定点单位；禁止跨 ABI 抛异常、共享 STL/CRT 容器或使用不明确的内存所有权。只在 microbenchmark + 端到端对照证据证明有效时调用它。
