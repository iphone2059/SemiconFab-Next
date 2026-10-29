# scripts

在仓库根目录直接运行，支持 Windows PowerShell 5.1 和 PowerShell 7：

```powershell
./scripts/start-dev.ps1
```

默认启动 API `http://127.0.0.1:5080` 与 Web `http://127.0.0.1:5173/`，自动生成并复用 `.local/development-key`。只需预装 `global.json` 指定的 .NET SDK、`web_app/package.json` 指定的 Node.js/npm；脚本会检查版本，不符合时显示所需版本。

每次启动先复用匹配版本的 pnpm JavaScript 入口；没有可用版本时自动安装到 `.local/tooling`，避开损坏的 Windows 全局 shim，不改全局工具。随后在 `web_app` 执行 `install --frozen-lockfile --prod=false`，由 pnpm 增量检查并补齐依赖，确保生产环境变量也不会省略 Vite。首次安装需能访问 npm registry；安装失败会停止启动并保留终端错误。前端仍沿用 `npm run dev` 与原 Vite 配置。

脚本等待 API、Web 页面与 sites/catalog 接口代理全部就绪后显示完整网址，Ctrl+点击即可浏览，不自动打开浏览器。API、Web 输出分别写入 `.local/api.log`、`.local/web.log`，错误输出在同目录的 `*-error.log`；可在另一终端用 `Get-Content .local/web.log -Wait` 查看。按 Ctrl+C 会清理本次启动的 API、npm 与 Vite 子进程。端口占用会直接报错，已有服务不会被停止。

```powershell
# 仅 API（默认内嵌 Worker）
./scripts/start-dev.ps1 -ApiOnly

# 关闭 API 内嵌 Worker；仍需另行启动独立 Worker
./scripts/start-dev.ps1 -SeparateWorker

# 同时保留另一套服务：端口、密钥、数据、日志与构建产物均隔离
./scripts/start-dev.ps1 -ApiPort 5280 -WebPort 5273 -LocalDirectory '.local/second dev'

# 不启动产品服务或浏览器的回归检查（包括隔离的完整启动顺序/失败测试）
./scripts/test-start-dev.ps1

# 实际启动、HTTP 冒烟与取消清理检查（默认使用 5280 / 5273）
./scripts/smoke-start-dev.ps1
./scripts/smoke-start-dev.ps1 -ApiOnly -SeparateWorker
```

启动构建产物保存在所选本地目录的 `artifacts/`，避免覆盖另一运行中 API 持有的默认 Debug DLL。脚本为本次启动显式设置 API 地址与 Vite 代理目标，退出后恢复调用终端的相关环境变量。冒烟检查保留 `.local/startup smoke */` 日志与隔离数据，便于诊断。

## 全量验证（verify.ps1）

```powershell
./scripts/verify.ps1
```

在仓库根目录按顺序执行，任一步失败立即退出：

1. **生成物一致性**：`python tools/generate_contracts.py --check`、`node tools/build_twin_translations.cjs --check`、`node tools/pack_static_structure.mjs --check`、`node tools/check_generated_artifacts.mjs --check`（登记表 `tools/generated-artifacts.json`）。
2. **冻结 JSON 校验**：`node tools/check_frozen_assets.mjs` 检查原始 Twin 设备/OEM/本地化数据与 SVG 标签/属性白名单；`node --test tools/test_check_frozen_assets.mjs` 用损坏样例证明校验器会拒绝错误资产。
3. **架构检查**：`python tools/check_architecture.py`（扁平项目布局、前端终态目录/旧路径缺席、domain 分层、src 根白名单、feature 状态归属、生成物区域、禁用依赖、ARCH-11 高频边界、模块档案数量）。
4. 工具单测：`./scripts/test-start-dev.ps1`、`python -m unittest discover -s tools -p 'test_*.py'` 与 `node --test tools/test_render_perf_checks.mjs`。
5. 导入快照：`python tools/migrate_legacy_data.py --check`。
6. 3 个独立 .NET 项目 Release 构建，并对 `fab_tests` 执行 `dotnet test --no-build`（含 Phase D 持久化/恢复测试，CORE-013）。
7. `web_app` 内用 `package.json` 锁定的 pnpm 版本执行 `install --frozen-lockfile`、`typecheck`、`test`、`build`（含 CORE-001..014 与 property/model 测试）。
8. **Oxc 兼容门禁**：`node tools/compiler_compat.mjs` 证明维护中的 `@vitejs/plugin-react` 兼容补丁生效、插件真实使用的 Oxc API 可用、无 Babel fallback（CORE-011/G15）。
9. **生产 bundle 浏览器回归**：`scripts/e2e-production.ps1` 用 `vite build` 产物 + `vite preview`（不是 dev server）+ 固定 Chrome 跑 9 个功能场景，证据写 `docs/architecture/evidence/browser/`。
10. **Compiler ON/OFF 等价**：`scripts/compiler-equivalence.ps1` 用同一确定性时钟/网络/事件序列比较两套生产构建的业务 trace（CORE-011），产物在 `docs/architecture/evidence/compiler/`。
11. **GPU gate（可选）**：设置 `FAB_RUN_GPU_GATE=1` 时执行 `scripts/gpu-gate.ps1`（真实 WebGPU、设备丢失注入、恢复与长稳；需本机 GPU 或 self-hosted GPU runner，CORE-012）。
12. 最后写 `docs/architecture/evidence/final-verify.json`（绑定受验 commit、工具版本与门禁清单）；调用方应把原始输出保存为 `final-verify-<sha>.log`。

```powershell
# 生产 bundle 浏览器验收（自动 build + API(start-dev -ApiOnly) + vite preview + Chrome）
./scripts/e2e-production.ps1
./scripts/e2e-production.ps1 -SkipBuild -Out docs/architecture/evidence/browser/production-e2e.json

# Compiler ON/OFF 等价（自行 build 两套 + 隔离 API + Chrome）
./scripts/compiler-equivalence.ps1 -OutDir docs/architecture/evidence/compiler

# 真实 WebGPU 设备丢失/恢复 + 长稳（默认 600 秒）
$env:FAB_RUN_GPU_GATE = '1'
./scripts/verify.ps1
# 或单独：
./scripts/gpu-gate.ps1 -DurationSeconds 600
```

## 浏览器功能验收（e2e）

```powershell
# web_app 内执行；必要时自动启动隔离 dev 栈（API 5091 / Web 5179）
pnpm e2e
```

- 实现：`tools/e2e_functional.mjs`（Chrome CDP；无额外浏览器依赖）+ `scripts/e2e.ps1`。
- 目标环境：默认 `http://127.0.0.1:5179`；启动方式与端口、证据路径均可由脚本参数覆盖（`-ApiPort/-WebPort/-Out/-Chrome`）。
- 产物：`docs/perf/effect4-e2e.json`（场景、步骤、期望/实际、pass/fail、console 错误、网络摘要）+ `docs/perf/e2e/*.png`（关键失败/断线截图）。
- 场景：Sites 成功/失败/重试、设备目录筛选/搜索/视图、URL lang/theme 刷新/前进后退、Workbench 校验/重复提交/错误、Catalog 导入/导出、Twin DEMO/晶圆/Research、Twin REST/SSE/断线恢复、未知 FAB、未知 URL、页面退出重进连接卫生。

```
## 性能、GPU 与构建产物证据（A4）

```powershell
# 需要已启动 dev（API+Vite）；基线 worktree 使用 4fc8a94 与独立端口
node tools/render_perf.mjs --url http://127.0.0.1:5173/fabs/<fabId>/3d --frames 600 --profile dev
node tools/render_perf.mjs --url http://127.0.0.1:5173/fabs/<fabId>/3d --frames 600 --profile 60hz
node tools/telemetry_stress.mjs --url http://127.0.0.1:5173/tests/telemetry-stress.html --seconds 8 --rate 60

# 生产构建后测量 raw/gzip（对每个 worktree 的 web_app/dist/assets 执行）
node web_app/node_modules/vite/bin/vite.js build   # 在对应 web_app 内
node tools/bundle_metrics.mjs --dir <worktree>/web_app/dist/assets --out docs/architecture/evidence/perf/final-bundle.json
```

- 原始 JSON：`docs/architecture/evidence/perf/final-*.json`。
- 汇总与边界：`docs/architecture/evidence/effect4-task6-performance-a4.md`（3 轮交替 A/B、bundle、连接/Worker/heap、A0–A4 对照）。
- 浏览器功能证据：`docs/perf/effect4-e2e.json`（`pnpm e2e` 生成，含每场景网络与性能字段）。

## React Compiler 门禁（Task 7）

```powershell
cd web_app
pnpm lint                  # oxlint src（React correctness，0 errors）
pnpm typecheck
pnpm test                  # 含 tests/architecture/oxc-react-compiler.test.ts 直接 transform fixture
pnpm build                 # Oxc React Compiler（reportDiagnostics: true）
```

- 实现：`@vitejs/plugin-react` 的 `compiler` → `oxc-transform-react@0.156.0`（Rust/Oxc，非 Babel，experimental）。
- `verify.ps1` 在 typecheck 后强制运行 `oxlint src`；compiler fixture 属 Vitest 套件。
- 证据：`docs/architecture/evidence/perf/task7-*.json` 与 `docs/architecture/evidence/effect4-task7-react-compiler.md`。

## 前端架构门禁

- `web_app/tests/architecture/architecture-boundaries.test.ts`：通用正则边界规则（分层 import、XState/工作流实现隔离等）。
- `web_app/tests/architecture/architecture-import-graph.test.ts`：用项目自带 TypeScript Compiler API 解析真实 import 图，执行 R0（相对 import 可解析）、R0b（无路径别名）、R1（运行图无环）、R2（`app/router` 通用文件不依赖 features）、R3（domain 纯度）、R4（feature 互不依赖）、R5（生成物登记/头注释/数据化）、R6（`src` 根白名单）。
- `web_app/tests/architecture/legacy-dependency-gate.test.ts`：Zod/Zustand/TanStack Query/RxJS 在源码、manifest 与 lockfile 中均为零。
- `web_app/tests/architecture/effect-runtime-boundary.test.ts`：`Effect.run*`、`AtomRegistry.make`、`ManagedRuntime.make`、`RegistryContext.Provider` 只允许组合根/已登记 Stream 适配器。
- `web_app/tests/architecture/source-layout.test.ts`：`src` 严格单层模块目录（无二级目录、无 `features/` 旧路径）。
- `web_app/tests/architecture/architecture-contract-rules.test.ts`：R7–R14（通用基础层不 import features；domain 无环境时钟/随机/DOM/定时器/网络；ScenePort 必需能力；全 import 边无环（含 type-only）；生成物登记校验；公共组件跨 feature 或设计系统角色；空依赖 effect 不捕获变化回调；无未登记 `any`/伪类型校验），每条规则都有 `tests/architecture/fixtures/**` 负向样例证明可失败。
- `web_app/tests/types/{store-action-types.ts,scene-port-types.ts}`：仅由 `tsc --noEmit` 校验的类型负向契约。
- `docs/modules/M*.md` 保持恰好 18 条模块档案（`tools/check_architecture.py` 断言）。

## 生成物登记与检查

`tools/generated-artifacts.json` 是全部提交生成物的机器可读登记表：每条记录输出路径、生成器命令/校验命令、输入源与 `sha256`。`app/router/routeTree.gen.ts` 是例外：由构建期 `@tanstack/router-plugin` 生成、位置为工具链约定，不登记在本 registry，可复现性由 `route-tree-generation` 架构门禁验证。

```powershell
node tools/check_generated_artifacts.mjs --check   # CI/verify 门禁：registry 形状、输出/输入 hash、生成器/--check 声明、src/generated 全覆盖（R11）
node tools/check_generated_artifacts.mjs --update  # 生成器重新产出后重新记录 hash（随后必须再跑 --check）
```

当前登记的三个生成物与生成器：

| 生成物 | 生成器 | 校验 |
|---|---|---|
| `web_app/src/generated/contracts.generated.ts` | `tools/generate_contracts.py` | `python tools/generate_contracts.py --check` |
| `web_app/src/generated/twin-translations.generated.ts` | `tools/build_twin_translations.cjs` | `node tools/build_twin_translations.cjs --check` |
| `web_app/src/generated/static-structure-packed.ts` | `tools/pack_static_structure.mjs` | `node tools/pack_static_structure.mjs --check` |

生成物禁止手工编辑；只能由生成器写入并重新登记 hash。`tools/build_twin_hud_css.cjs` 输出 `web_app/assets/original-twin-hud.css`，依赖本地 gitignored 的 `.local/parity-tools` postcss 环境，因此**不在** `verify.ps1` 中执行。

## 性能门禁

真实 GPU/浏览器门禁需要先启动 `./scripts/start-dev.ps1`，再运行：

```powershell
./scripts/perf-render.ps1 -Url http://127.0.0.1:5173/fabs/{fabId}/3d
```

Worker/遥测压力门禁（同样需要先启动 dev server）：

```powershell
./scripts/perf-telemetry.ps1 -Url http://127.0.0.1:5173/ -Seconds 10 -Rate 60
```

结果分别写入 `.local/render-perf.json`、`.local/telemetry-stress.json`；两项都依赖本机 Chrome/GPU，不在 `verify.ps1` 中执行。

前端测试布局（镜像式）与工程边界见 `web_app/README.md`；功能与验证状态见 `docs/IMPLEMENTATION-STATUS.md`。
