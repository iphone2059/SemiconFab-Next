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

## 全量验证（verify.ps1）

```powershell
./scripts/verify.ps1
```

在仓库根目录按顺序执行，任一步失败立即退出：

1. **生成物一致性**：`python tools/generate_contracts.py --check`、`node tools/build_twin_translations.cjs --check`、`node tools/pack_static_structure.mjs --check`、`node tools/check_generated_artifacts.mjs --check`（登记表 `tools/generated-artifacts.json`）。
2. **架构检查**：`python tools/check_architecture.py`（扁平项目布局、前端终态目录/旧路径缺席、domain 分层、src 根白名单、feature 状态归属、生成物区域、禁用依赖、ARCH-11 高频边界、模块档案数量）。
3. 工具单测：`python -m unittest discover -s tools -p 'test_*.py'` 与 `node --test tools/test_render_perf_checks.mjs`。
4. 导入快照：`python tools/migrate_legacy_data.py --check`。
5. 3 个独立 .NET 项目 Release 构建，并对 `fab_tests` 执行 `dotnet test --no-build`。
6. `web_app` 内用 `package.json` 锁定的 pnpm 版本执行 `install --frozen-lockfile`、`typecheck`、`test`、`build`。

## 前端架构门禁

- `web_app/tests/architecture/architecture-boundaries.test.ts`：通用正则边界规则（分层 import、XState/工作流实现隔离等）。
- `web_app/tests/architecture/architecture-import-graph.test.ts`：用项目自带 TypeScript Compiler API 解析真实 import 图，执行 R0（相对 import 可解析）、R0b（无路径别名）、R1（运行图无环）、R2（`app/router` 通用文件不依赖 features）、R3（domain 纯度）、R4（feature 互不依赖）、R5（生成物登记/头注释/数据化）、R6（`src` 根白名单）。
- `web_app/tests/architecture/architecture-contract-rules.test.ts`：R7–R14（通用基础层不 import features；domain 无环境时钟/随机/DOM/定时器/网络；ScenePort 必需能力；全 import 边无环（含 type-only）；生成物登记校验；公共组件跨 feature 或设计系统角色；空依赖 effect 不捕获变化回调；无未登记 `any`/伪类型校验），每条规则都有 `tests/architecture/fixtures/**` 负向样例证明可失败。
- `web_app/tests/types/{store-action-types.ts,scene-port-types.ts}`：仅由 `tsc --noEmit` 校验的类型负向契约。
- `docs/modules/M*.md` 保持恰好 18 条模块档案（`tools/check_architecture.py` 断言）。

## 生成物登记与检查

`tools/generated-artifacts.json` 是全部提交生成物的机器可读登记表：每条记录输出路径、生成器命令/校验命令、输入源与 `sha256`。

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
