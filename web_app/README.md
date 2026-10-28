# web_app

SemiconFab-Next 唯一 Web 前端：Vite + React 单页站点，V2.1 架构（TanStack Router/Query、Zustand、RxJS、XState v6、Babylon Lite/WebGPU）。没有内部子包，也没有 pnpm workspace。

## 目录

2026-10-28 递归整改（R-01…R-14）后的真实布局；架构与门禁细节见 `docs/architecture.md` §30。

```text
web_app/
├─ index.html
├─ package.json / pnpm-lock.yaml / pnpm-workspace.yaml（仅 pnpm 配置载体，不是 workspace）
├─ .npmrc / tsconfig.json / vite.config.ts
├─ src/
│  ├─ main.tsx                 # 唯一入口（R6：src 根只允许 main.tsx + contracts.ts）
│  ├─ contracts.ts             # 生成契约的公开再导出
│  ├─ app/
│  │  ├─ providers/            # AppProviders / QueryProvider / RuntimeProvider / RuntimeBootstrap / TelemetryProvider（装配根）
│  │  └─ router/               # router / search / url-mapping / route-data / routeTree.gen.ts / routes/（唯一允许组合 features 的位置）
│  ├─ application/
│  │  ├─ contracts/            # CommandEvents / CommandGateway / CommandWorkflow（公共契约单点）
│  │  ├─ coordination/         # CommandEventBridge / CommandEventRecovery / CommandCorrelationRegistry / ScopeGate
│  │  └─ ports/scene.ts        # ScenePort：必需 SceneCommands + 强类型 SceneMountOptions + mount/dispose 生命周期（R-04/R9）
│  ├─ api/
│  │  ├─ transport/http.ts     # 唯一 HTTP transport（同源相对路径、no-store、ProblemDetails、FetchLike 注入）
│  │  ├─ schemas/              # 运行时 Zod 合同（command.schema.ts，R-03）
│  │  ├─ cache/                # equipment-status-bridge：REST/SSE 经唯一 acceptance gate 写入 Query 缓存
│  │  ├─ queries/              # queryClient / queryKeys / sites|equipment|catalog|runs|research|wafer.queries
│  │  └─ mutations/            # runs / commands.mutations
│  ├─ realtime/
│  │  ├─ equipment-status/     # protocol / gate / stream / index（FAB 作用域、epoch/sequence 唯一权威）
│  │  ├─ protocol/             # MessageDecoder（SSE envelope 解码）
│  │  ├─ telemetry/            # TelemetryRuntime / FabTelemetryRegistry（acquire/release）
│  │  ├─ transport/            # SseCommandEventSource / HttpCommandGateway
│  │  ├─ workers/              # createTelemetryWorker / telemetryWorker(.logic)
│  │  └─ buffers/              # FrameRingBuffer
│  ├─ runtime/                 # FabRuntime / Factory / Registry / LifecycleCoordinator / commandSources
│  │  └─ commands/             # XState v6 实现（经 CommandWorkflow 契约暴露，目录位置非强制）
│  ├─ state/                   # 共享客户端状态：runtimeStore / localeStore / preferences（类型安全 createSliceStore）
│  ├─ domain/                  # 纯领域模块（无 React/状态库/渲染/隐式时钟）
│  │  ├─ fab/                  # fab-layout / process-control / fab-yield / cleanroom-pressure / layout-identities / original-twin-data / twin-spatial
│  │  ├─ amhs/ personnel/      # 时间线模型
│  │  ├─ equipment/            # tool-state-projection（遥测帧 → FabToolState 纯函数）
│  │  ├─ simulation/           # tour-timeline / tour-scenario / original-tour / research-replay / scenario / twin-equipment
│  │  ├─ wafer/                # wafer-timeline / wafer-scenario / wafer-route / wafer-map
│  │  └─ math/                 # vec3 / round（Tour 与 Wafer 时间线共享的数学原语）
│  ├─ localization/language.ts # TwinLanguage（UI 语言，不进入 domain）
│  ├─ shared/scheduling/       # coalesced-dispatcher（通用低频合批，不绑定遥测）
│  ├─ features/                # 页面 + feature 专属状态，按功能内聚
│  │  ├─ twin/                 # twin-page + controllers/（10 个控制器）+ state/ + twin-search.ts + wafer-session.ts
│  │  │                        #   + equipment-status-pipeline.tsx + HUD/侧栏/对话框子组件
│  │  ├─ catalog/              # catalog-page/data/search/labels/types + components/ + controllers/ + export/ + state/
│  │  └─ workbench/            # workbench / command-console + components/ + controllers/ + state/
│  ├─ components/              # 共享设计系统：ui / modal / error-boundary / class-names / original-icons(+original-icons-data)
│  ├─ rendering/
│  │  ├─ lite-backend.ts       # 实现 application/ports/scene 的 ScenePort（Lite runtime/world、设备丢失恢复）
│  │  ├─ contracts/            # static-structure-data.ts：生成物 payload 的手写类型合同（仅 type-only 被生成物引用）
│  │  └─ lite/                 # runtime / world / camera / lighting / selection / cut-plane / motion / airflow-texture …
│  │     ├─ effects/           # xray / xray-shaders / cut / wafer / index：独立 create/update/dispose 资源所有者
│  │     ├─ geometry/          # facility / tool-families / original-tool-parts / static-structure …
│  │     └─ shadows/
│  ├─ generated/               # 生成物统一目录（禁止手改；登记于 tools/generated-artifacts.json）
│  │  ├─ contracts.generated.ts
│  │  ├─ twin-translations.generated.ts
│  │  └─ static-structure-packed.ts
├─ tests/                      # 镜像式 Vitest 布局 + 架构门禁 + fixtures/support/types（见下）
├─ assets/                     # Vite 打包的 CSS/i18n/原始参考数据与生成器输入
└─ public/                     # 浏览器 URL 直接请求的数据与许可证副本
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

## 测试布局

`tests/` 按源码所有权镜像（历史平铺测试已迁移，移动时同步更新相对 import；golden fixtures 未改动）：

```text
tests/
├─ api/ application/ components/ contract/ domain/ features/ integration/ performance/ realtime/ rendering/ state/
├─ architecture/            # 门禁：architecture-boundaries（正则）、architecture-import-graph（R0–R6）、
│                           # architecture-contract-rules（R7–R14）、feature-ui-ownership、static-structure-pack 等
│                           # fixtures/r7…r14：每条门禁的负向/正向样例
├─ fixtures/                # 黄金向量、原版参考清单与几何/动作 fixture
├─ support/                 # 测试专用工具（native-dialog polyfill、scene-port-stub、png、perf-metrics…）
└─ types/                   # 仅 tsc 校验的类型负向契约（store-action-types、scene-port-types）
```

`telemetry-stress.html` / `telemetry-stress.ts` 是真实浏览器 Worker 压测页（由 `scripts/perf-telemetry.ps1` 驱动），不是 Vitest 套件。

## 验证

```powershell
cd web_app
npm run typecheck             # 含 noUnusedLocals / noUnusedParameters
npm test
npm run build
```

- 测试数量以当次 `npm test` 输出为准，本文件不硬编码（历史基线见 `docs/IMPLEMENTATION-STATUS.md`）。
- CPU 密集型黄金向量套件在默认并发下会超过 Vitest 5s 时限，`vite.config.ts` 统一设置 `testTimeout: 15000`（只放宽时限，断言强度不变）。
- 架构门禁三层：`tests/architecture/architecture-boundaries.test.ts` 正则边界；`tests/architecture/architecture-import-graph.test.ts` 用项目自带 TypeScript Compiler API 解析 `src/**/*.{ts,tsx}` 真实 import 图（R0–R6）；`tests/architecture/architecture-contract-rules.test.ts` R7–R14（ScenePort 必需能力、type-only 无环、生成物登记、组件所有权、空依赖 effect、`any`/伪校验）且每条有负向 fixture；根目录 `tools/check_architecture.py` 检查终态目录/依赖/ARCH-11。
- 生成物由 `node tools/check_generated_artifacts.mjs --check` 按 `tools/generated-artifacts.json` 校验（R11）；生成器各自的 `--check` 由根目录 `scripts/verify.ps1` 统一执行。
- 类型负向用例由 `tests/types/{store-action-types.ts,scene-port-types.ts}` 提供（仅 `tsc --noEmit` 校验，Vitest 不执行）。
- 真实浏览器/GPU 门禁见 `scripts/perf-render.ps1` 与 `scripts/perf-telemetry.ps1`；最近一次架构清理证据见 `docs/evidence/architecture-cleanup-2026-10-28.json`。
