# web_app

SemiconFab-Next 唯一 Web 前端：Vite + React 单页站点，V2.1 架构（TanStack Router/Query、Zustand、RxJS、XState v6、Babylon Lite/WebGPU）。没有内部子包，也没有 pnpm workspace。

## 目录

```text
web_app/
├─ index.html
├─ package.json / pnpm-lock.yaml / tsconfig.json / vite.config.ts
├─ src/
│  ├─ main.tsx                 # 入口（src 根仅此文件 + contracts.ts；R6 门禁）
│  ├─ contracts.ts             # 生成契约的公开再导出
│  ├─ app/                     # providers；Router（routeTree.gen.ts、通用 search/url-mapping/route-data、routes/ 装配入口）
│  ├─ api/                     # TanStack Query 查询/变更与 HTTP 传输
│  ├─ application/             # CommandEvents/CommandWorkflow 契约、Bridge/恢复协调、coordination/ScopeGate
│  ├─ realtime/                # MessageDecoder、SSE 传输、TelemetryRuntime/Worker/帧缓冲、equipment-status
│  ├─ runtime/                 # FabRuntime/Factory/Registry/Lifecycle；runtime/commands XState 实现
│  ├─ state/                   # 共享客户端状态：runtimeStore / localeStore / preferences（类型安全 createSliceStore）
│  ├─ domain/                  # 纯领域模块：无 React/状态库/渲染依赖
│  │  ├─ fab/                  # fab-layout / process-control / fab-yield / cleanroom-pressure / layout-identities / original-twin-data / twin-spatial
│  │  ├─ amhs/ personnel/ wafer/ simulation/
│  │  ├─ equipment/            # tool-state-projection：遥测帧 → 设备状态投影（纯函数）
│  │  └─ contracts/            # 领域内共享类型（如 TwinLanguage）
│  ├─ features/                # 页面 + 功能专属状态，按功能内聚
│  │  ├─ twin/                 # 页面 + controllers/ + state/（twinUiStore/twinPageStore/twinDemoStore/twin-state）
│  │  │                        #   + twin-search.ts + wafer-session.ts + twin-translations.ts
│  │  ├─ catalog/              # catalog-page / catalog-data / search / state/catalogStore
│  │  └─ workbench/            # workbench / command-console / state/workbenchStore
│  ├─ components/              # 共享 UI：ui / widgets / charting / modal / error-boundary / class-names / original-icons
│  ├─ rendering/               # scene 契约 + 产品后端 + Lite/WebGPU 实现
│  │  ├─ fab-scene.ts          # 引擎无关 SceneBackend/SceneFacade 端口
│  │  ├─ lite-backend.ts       # 产品 SceneBackend（封装 Lite runtime/world）
│  │  └─ lite/                 # geometry / 光照 / 选择 / 裁剪 / 动效 / airflow-texture
│  ├─ generated/               # 生成物统一目录（禁止手改）
│  │  ├─ contracts.generated.ts
│  │  ├─ twin-translations.generated.ts
│  │  └─ static-structure-packed.ts
├─ tests/                      # Vitest 单元/契约/集成/性能测试（含真实 import 图架构门禁）
└─ assets/                     # CSS、i18n/许可与静态数据
```

## 运行

```powershell
cd web_app
npx --yes pnpm@12.15.0 install --frozen-lockfile
npm run dev                  # Vite 127.0.0.1:5173
```

根目录 `scripts/start-dev.ps1` 会同时启动 API（127.0.0.1:5080）与本项目，并注入开发密钥。

开发服务器排障：不要在其运行期间删除 `node_modules/.vite`（Vite 预打包缓存）。缓存与运行中服务器的依赖哈希不一致时，浏览器会收到 `504 Outdated Optimize Dep` 并显示空白页；需要重建缓存时先停掉 dev server，删除缓存后重启（或换独立端口用 `--force` 验证）。

- `/api` 代理到 `localhost:5080`；`FAB_API_TARGET` 只能指向本机 HTTP(S) 地址。
- 浏览器请求中的同名身份头会被移除并由代理注入服务器端开发密钥；不要使用 `VITE_` 变量保存密钥。
- 仅使用 WebGPU：缺少安全上下文 / `navigator.gpu` / adapter 时明确报错，不回退 WebGL。
- 产品 URL 只有 canonical 地址（`/`、`/fabs/{fabId}/3d`、`/equipment`、`/equipment/compare`），旧地址已删除。
- 设备状态走 REST 初值/轮询 + SSE；命令生命周期为 XState，通过后端 HTTP 命令 API + SSE 命令流 + 权威状态查询接线；遥测走 20Hz SSE → Worker → 渲染 frame loop。

## 验证

```powershell
cd web_app
npm run typecheck             # 含 noUnusedLocals / noUnusedParameters
npm test
npm run build
```

当前基线（2026-10-28）：`tsc --noEmit` 0、Vitest **90 文件 / 532 测试 PASS**、`vite build` 0（1823 modules）；`src` 根仅 `main.tsx` + `contracts.ts`（R6 门禁）。

CPU 密集型黄金向量套件（`tests/lite-motion.test.ts` 等）在 90-worker 并发下会超过 Vitest 默认 5s 时限，因此 `vite.config.ts` 统一设置 `testTimeout: 15000`（只放宽时限，断言强度不变）；默认并发全量运行 90 文件 / 532 测试 PASS。

架构/边界检查分三层：`tests/architecture-boundaries.test.ts` 保留原有正则规则；`tests/architecture-import-graph.test.ts` 用项目自带 TypeScript Compiler API 解析 `src/**/*.{ts,tsx}` 的真实 import 图（R0 相对 import 可解析 / R0b tsconfig 无别名、R1 运行图无环、R2 `app/router` 直接文件不依赖 features、R3 domain 纯度、R4 feature 隔离且跨 feature 需显式批准、R5 生成物登记/头注释/数据化、R6 `src` 根只允许 `main.tsx`/`contracts.ts`）；根目录 `tools/check_architecture.py` 检查终态目录/依赖/ARCH-11。

类型契约的负向用例由 `tests/types/store-action-types.ts` 提供（仅 `tsc --noEmit` 校验，Vitest 不执行）：非法字段、缺参、错误类型必须编译失败。真实浏览器/GPU 门禁见根目录 `scripts/perf-render.ps1`，本次架构清理的实测证据见 `docs/evidence/architecture-cleanup-2026-10-28.json`。
