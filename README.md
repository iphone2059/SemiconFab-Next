# SemiconFab-Next

本仓库按 **扁平、独立、按名字关联、最少项目** 的原则组织：仓库根目录下每个子目录就是一个完全独立的项目；没有总 solution、没有 pnpm workspace，任何项目都可以单独构建。

## 组织原则

- **全部同级**：3 个 .NET 项目 + 1 个前端站点全部位于仓库根目录。
- **一个后端**：`fab_app` 合并全部域服务、平台服务与宿主，按运行模式（api/worker/realtime/ot）启动；服务之间不再有项目边界。
- **一个前端**：`web_app` 是唯一站点（Vite + React），自包含 package.json / lockfile / tsconfig。
- **一个共享内核**：`fab_shared` 持有 ID、生成契约、消息/可观测性/Host/配置基础与 M07/M08 确定性仿真内核。
- **一个测试项目**：`fab_tests` 合并原仿真、编排、API 测试。
- **完全独立**：每个 csproj 自带 TargetFramework、编译开关与包版本；仓库不含 `*.sln` / `*.slnx`。
- **按名字关联**：后端只用显式相对 `ProjectReference`；前端源码内部只用相对导入。
- **设计基线**：功能边界以 [docs/SemiconFab-Next-Engineering-v1.1](docs/SemiconFab-Next-Engineering-v1.1/README.md) 为准；布局及目录决策见 `docs/adr/`。
- **前端目录边界**：`web_app/src/` 仅放 `.ts` / `.tsx`；测试在同级 `web_app/tests/`，样式、许可及浏览器资产在同级 `web_app/assets/`。架构检查会阻止混放。

## 项目清单

```text
fab_shared/   共享内核：StableId、Generated/Contracts.g.cs、确定性 DES 引擎（FabSimulation 等）
fab_app/      唯一后端应用：API + Worker + Realtime/OT 占位模式（Sdk.Web）
fab_tests/    唯一测试项目：仿真 / 编排 / API 集成测试
web_app/      唯一前端站点：Vite + React + Babylon WebGPU
  src/        TS/TSX 应用源码与生成类型
  tests/      前端单元、代理及浏览器验收代码
  assets/     CSS、数据许可与前端静态资源
contracts/    JSON Schema（契约单一来源）、OpenAPI、protobuf
assets/legacy/ 版本化迁移数据、完整原文件与校验清单（后端读取）
docs/         模块档案 M01–M18、实施状态、ADR
infrastructure/ assets/ scripts/ tools/ .github/   # 部署参考、资产、脚本、工具、CI
```

## 运行与验证

```powershell
# 本地开发：API(127.0.0.1:5080) + Web(127.0.0.1:5173)
./scripts/start-dev.ps1

# 如默认端口已占用，可启动独立实例（数据、日志与构建产物也隔离）
./scripts/start-dev.ps1 -ApiPort 5280 -WebPort 5273 -LocalDirectory '.local/second dev'

# 单后端模式
dotnet run --project fab_app                 # API（默认，内嵌 Worker）
dotnet run --project fab_app -- --worker     # 独立 Worker
dotnet run --project fab_app -- --realtime   # 占位：退出码 2
dotnet run --project fab_app -- --ot         # 占位：退出码 2

# 全量校验：逐项目构建 + fab_tests + 契约/架构检查 + 前端检查
./scripts/verify.ps1

# 前端（在 web_app 内）
cd web_app
npx --yes pnpm@12.15.0 install --frozen-lockfile
npx --yes pnpm@12.15.0 typecheck
npx --yes pnpm@12.15.0 test
npx --yes pnpm@12.15.0 build
```

启动脚本支持 Windows PowerShell 5.1 / PowerShell 7；按 Ctrl+C 会停止本次 API、npm 与 Vite 进程。日志位置、`-ApiOnly` / `-SeparateWorker` 与启动冒烟检查见 [scripts/README.md](scripts/README.md)。

3D FAB 仅使用 `/twin` 页面（兼容 `/twin.html`）；首页不嵌入独立预览。旧 `/preview` 地址会规范化到同一页面。当前仍在对齐原版，尚未通过整页视觉 parity；[基线、差分与剩余门槛](docs/migration/twin-parity/baseline.md)。

## 文档

- 当前编码进度与验证：[迁移实施记录](docs/migration/progress.md)。首批设备目录位于 `/catalog`，对比位于 `/compare`；兼容 `/catalog-demo.html`、`/compare.html`。
- 原版到新版迁移规划：[功能迁移与重构规划](docs/superpowers/plans/2026-10-24-main-to-next-refactor.md)（含 44 项功能清单与原版资产基线；以当前四项目架构为准）
- 模块档案：`docs/modules/M01.md` … `M18.md`
- 实施状态：`docs/IMPLEMENTATION-STATUS.md`
- 决策记录：`docs/adr/`
- V2.1 架构基线：[架构基线](docs/architecture.md)（ADR-0009 Router/Query 边界、ADR-0010 Realtime/Workflow 桥接、ARCH-01…12 规则、M0–M6 迁移计划；状态：文档已采纳、代码迁移未开始）

## 原版数据导入

仓库已包含首份导入快照，正常运行不要求旁边存在旧仓库。重新导入时执行：

```powershell
python tools/migrate_legacy_data.py --source ../SemiconFab-main --output assets/legacy
python tools/migrate_legacy_data.py --check
```

相同输入保持同一版本；错误记录生成字段级问题清单，且不会替换当前快照。`Fab__CatalogDirectory` 可指定另一份导入目录。API 当前沿用开发身份；本地 JSON 载入仅影响浏览器预览，不会发布数据或改动基地设备。
