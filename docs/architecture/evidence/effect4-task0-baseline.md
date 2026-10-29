# Task 0：基线与文件归属冻结（执行记录）

- 执行日期：2026-10-29（Asia/Singapore）
- 基线提交：`4fc8a94a3f10d185c8bef7929349ac6ccb2b8792`（远端 main）
- 迁移工作树：`.local/worktrees/effect4-flat`
- 分支：`refactor/effect4-flat-20261029`
- 权威文档：`docs/architecture/`（01–04 + README）
- 状态：Task 0 已完成基线冻结（性能/浏览器功能基线见 §7 未完成项）。
- 批准依据：用户于 2026-10-29 指示“这些是新的重构文档，请严格按这个来”，本目录 01–04 + README 即成为实施约束。

## 1. 基线与工具链事实

| 项目 | 值 | 来源 |
|---|---|---|
| baseline commit | `4fc8a94a3f10d185c8bef7929349ac6ccb2b8792` | `git rev-parse HEAD` |
| Node | v26.12.1 | `node --version` |
| Python | 3.14.7 | `python --version` |
| .NET SDK（机器） | 11.0.100-rc.3.26522.148 | `dotnet --list-sdks` |
| .NET SDK（基线 global.json） | 11.0.100-rc.2.26504.105（rollForward=disable） | `global.json` |
| pnpm（全局） | 12.16.1 | `pnpm.cmd --version` |
| pnpm（项目固定） | 12.15.0 | `web_app/package.json` |
| TypeScript | 7.0.2 | `web_app/package.json` |
| 源码文件数 | 196（.ts/.tsx） | `web_app/src` 扫描 |
| 测试文件数 | 142（.ts/.tsx） | `web_app/tests` 扫描 |
| package.json SHA256 | `BA4843BC7A6CEE38DA25B69C2584C87F05FBC966C17F1F2339034A62BCF946A3` | `Get-FileHash` |
| pnpm-lock.yaml SHA256 | `64D2152DD80AAE770FF036B6AEE74019561778CB0429D0A1FF30D3415EC8EA2D` | `Get-FileHash` |

## 2. 基线依赖（远端 main）

生产依赖：`@babylonjs/lite 1.36.0`、`@tanstack/react-query 5.105.0`、`@tanstack/react-router 1.170.46`、`react 19.3.1`、`react-dom 19.3.1`、`rxjs 7.8.2`、`xstate 6.0.0-alpha.70`、`zod 4.6.7`、`zustand 5.0.16`。

开发依赖：`@tanstack/router-plugin 1.168.48`、`@testing-library/dom 10.4.2`、`@testing-library/react 16.3.3`、`@types/node 26.6.5`、`@types/react 19.3.0`、`@types/react-dom 19.3.0`、`@vitejs/plugin-react 6.1.2`、`jsdom 30.1.3`、`typescript 7.0.2`、`vite 8.3.5`、`vitest 5.0.5`。

`effect` / `@effect/atom-react` 不在基线依赖中，属于目标依赖，将在 Task 2 精确锁定。

## 3. Task 0 决策

### D1：文档落点

- 权威文档放 `docs/architecture/`，符合新 README 的建议落点，也避免与 `tools/check_architecture.py` 的 `docs/superpowers` 禁用规则冲突。
- 旧版草案与旧审查记录移入 `docs/architecture/archive/` 与 `docs/architecture/reviews/`，不再作为实施依据。
- 未放宽任何架构门禁规则；`python tools/check_architecture.py` 在基线 worktree 上通过。

### D2：.NET SDK pin

- 基线 `global.json` 固定 `11.0.100-rc.2.26504.105`，但验收机器仅安装 `11.0.100-rc.3.26522.148`。
- 决策：将 `global.json` pin 更新为 `11.0.100-rc.3.26522.148`（保持 `rollForward: disable`、`allowPrerelease: true`），并在本记录中声明环境能力与偏差；不依赖主工作树未提交修改。
- 影响：`dotnet --version` 与 .NET build/test 可在本环境执行；若后续验收环境使用 rc.2，需要重新对齐 pin。

### D3：pnpm 12.15.0 预置

- 全局 pnpm 为 12.16.1，不能用于本项目验收；`web_app/package.json` 固定 12.15.0。
- 决策：Task 0 使用 npx 缓存中的 12.15.0（`%LOCALAPPDATA%\npm-cache\_npx\bcfc56e7126ead17\node_modules\pnpm\bin\pnpm.mjs`）执行安装/门禁，并把该 JS 入口预置到 `web_app/node_modules/pnpm` 供现有 `verify.ps1` 候选搜索发现；`node_modules` 不入库。
- Task 6 仍需把固定 pnpm 的预置方式写入 `scripts/README.md` 与验收前置条件；干净目录 frozen-lockfile 安装需要网络或已预热 pnpm store，需在 Task 6 明确记录。

### D4：文档/spec 的旧门禁冲突

- `docs/superpowers` 不再作为文档落点，旧目录在 Task 0 分支中不存在（基线本身已清理）；无需修改 `tools/check_architecture.py` 的 legacy 断言。Task 6 只复核该断言与最终文档布局一致。

### D5：性能基线

- 现有工具：`tools/render_perf.mjs`、`tools/test_render_perf.browser.mjs`、`tools/telemetry_stress.mjs`、`scripts/perf-render.ps1`、`scripts/perf-telemetry.ps1`；历史证据在 `docs/perf/`。
- Task 0 将按新文档 §8/04 文档 §8 重新运行真实基线（至少 dev/60Hz profile），记录机器、浏览器、Node、commit 和原始 JSON；历史证据只作参考，不作为本次基线。

### D6：基线门禁策略

- 完整 `./scripts/verify.ps1` 必须真实执行并保存日志。任何无法执行或失败的门禁记录失败原因，不标记 PASS。
- 迁移期间每个 Task 完成时执行适用的门禁；最终 Task 6 执行完整 verify + A3/A4。

## 4. 基线门禁结果

（待 verify.ps1 完成后回填本表；失败项也如实记录。）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 架构终态检查 | `python tools/check_architecture.py` | PASS |
| 生成契约 | `python tools/generate_contracts.py --check` | PASS |
| Twin 翻译生成物 | `node tools/build_twin_translations.cjs --check` | PASS |
| 静态结构打包 | `node tools/pack_static_structure.mjs --check` | PASS |
| 生成物登记 | `node tools/check_generated_artifacts.mjs --check` | PASS |
| frozen assets | `node tools/check_frozen_assets.mjs` | PASS |
| 启动流程/工具测试 | `test-start-dev.ps1`、python/node tool tests | PASS |
| 前端安装 | pinned pnpm `install --frozen-lockfile` | PASS（2.4s，无漂移） |
| TypeScript | pinned pnpm `typecheck` | PASS |
| Vitest | pinned pnpm `test` | PASS：106 文件 / 664 测试 |
| Vite build | pinned pnpm `build` | PASS |
| .NET build/test | `verify.ps1` 内的 3 项目 Release | PASS：构建成功；fab_tests 180/180 |
| 完整 verify | `./scripts/verify.ps1` | PASS（VERIFY_EXIT=0） |

完整日志：Task 0 执行时保存于 worktree 本地 `.local/effect4-task0-verify-summary.md`（`.local` 不入库）；核心结果与提交 SHA 已记录在本表。最终 Task 6 需重新执行并把日志作为交付证据提交。

构建产物（vite build，minify 后 / gzip）：`index` 300.81/91.89 kB、`react` 322.78/102.67 kB、`gpu` 392.64/128.36 kB、`twin-page` 405.31/106.16 kB、`lite-backend` 1795.20/179.04 kB、`telemetryWorker` 2.60 kB；存在既有 “chunk > 500 kB” 提示（非失败）。

## 5. 行为契约基线记录

| 契约 | 基线事实 | 证据 |
|---|---|---|
| URL | `/`、`/equipment`、`/equipment/compare`、`/fabs/$fabId/3d`；无旧地址重定向 | `web_app/src/app/router/routes/**`、`docs/architecture.md` |
| 首页 sites 失败 | `/` loader 捕获 sites 错误，Workbench 显示可重试错误 | `routes/index.tsx`、`features/workbench/workbench.tsx` |
| 未知 FAB | `requireFabSites` 抛错进入 root `errorComponent` | `app/router/route-data.ts`、`routes/__root.tsx` |
| 未知 URL | root `notFoundComponent` 显示 404 | `routes/__root.tsx` |
| 预加载 | `defaultPreload: 'intent'`、`defaultPreloadStaleTime: 0` | `app/router/router.tsx` |
| 资源 freshness | sites 30s；catalog 60s；runs/equipment 0；research/wafer Infinity；默认 idle/gc 5min，research/wafer 10min | `api/queries/queryClient.ts` 与各 `*.queries.ts` |
| 轮询 | Runs 列表/详情 1500ms（结果仅完成后启用）；设备状态 REST 4000ms + SSE 共享门 | `features/workbench/workbench.tsx`、`features/twin/equipment-status-pipeline.tsx`、`api/queries/equipment.queries.ts` |
| 设备状态顺序 | 同一 epoch/sequence 门；FAB 切换先取消合批、激活新 Gate、清空旧投影；100ms UI 合批 | `realtime/equipment-status/gate.ts`、`api/cache/equipment-status-bridge.ts`、`features/twin/equipment-status-pipeline.tsx` |
| 命令身份 | idempotency key 绑定 `[siteId,fabId,equipmentId,action]`；XState 状态 idle/accepted/executing/succeeded/failed/cancelled；revision 严格递增 | `features/workbench/controllers/use-command-console.ts`、`runtime/commands/equipmentCommand.machine.ts`、`XStateCommandWorkflowAdapter.ts` |
| 命令保留 | pending 32/命令、256/总数；终态 64/300s；投影 128；sweep 15s；单命令核对合并 | `application/coordination/*`、`runtime/FabRuntime.ts` |
| 遥测 | 2s in-flight、250ms→8s 退避、单 in-flight + 槽位合并 pending、连接级序号重置、Worker generation | `realtime/telemetry/TelemetryRuntime.ts`、`realtime/workers/*` |
| 渲染 | Babylon Lite + WebGPU-only；无 WebGL context；Twin 路由动态分割 | `rendering/lite-backend.ts`、`vite.config.ts`、`tests/integration/route-code-splitting.test.ts` |
| 高频路径 | 遥测 Worker/TypedArray 不进入 Query/Zustand；React 低频投影 100ms 合批 | `docs/architecture.md`、`realtime/` |

## 6. 文件归属

生产源码逐文件的目标路径、owner 与迁移动作见 `effect4-task0-file-ownership.md`（196 个文件，未映射 0，目标冲突 0）。

## 7. 尚未完成的 Task 0 项

- 真实性能基线（dev + 60Hz profile）运行与原始 JSON 归档（需要启动 dev server + 真实 Chrome/WebGPU）。
- 路由/资源/命令行为的可执行基线测试清单与现有 142 个测试文件的 Task 1 更新映射（在 Task 1 中随目录迁移完成）。
- 基线连接数与 React render 次数测量（当前工具不覆盖，按新验收文档 §8.2 在实现测量工具后补齐；记录为已知缺口）。
- 基线浏览器功能场景（A3）目前无 harness；按新验收文档 §7 在实现 e2e 脚本后执行，Task 0 记录缺口。
