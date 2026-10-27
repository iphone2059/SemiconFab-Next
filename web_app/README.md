# web_app

SemiconFab-Next 唯一 Web 前端：Vite + React 单页站点，V2.1 架构（TanStack Router/Query、Zustand、RxJS、XState v6、Babylon Lite/WebGPU）。没有内部子包，也没有 pnpm workspace。

## 目录

```text
web_app/
├─ index.html
├─ package.json / pnpm-lock.yaml / tsconfig.json / vite.config.ts
├─ src/
│  ├─ main.tsx                 # 入口
│  ├─ app/                     # providers、Router（routes/search/url-mapping）
│  ├─ api/                     # TanStack Query 查询/变更
│  ├─ state/                   # Zustand UI stores、遥测合批
│  ├─ application/             # CommandEvents/CommandWorkflow 契约、Bridge/恢复协调
│  ├─ realtime/                # MessageDecoder/SequenceTracker、类型化流、缓冲区/Worker
│  ├─ runtime/commands/     # XState v6 命令工作流实现
│  ├─ runtime/                 # FabRuntime/Factory/Registry/Lifecycle、命令源 seam
│  ├─ rendering/lite/          # Babylon Lite/WebGPU 渲染实现
│  ├─ contracts.generated.ts   # 由 tools/generate_contracts.py 生成，勿手改
│  ├─ contracts.ts
│  ├─ fab-scene.ts             # 引擎无关场景 Port/SceneFacade
│  ├─ lite-backend.ts          # 产品 SceneBackend
│  └─ ui.tsx / widgets.tsx / charting.tsx / scenario.ts
├─ tests/                      # Vitest 单元/契约/集成/性能测试
└─ assets/                     # CSS、i18n/许可与静态数据
```

## 运行

```powershell
cd web_app
npx --yes pnpm@12.15.0 install --frozen-lockfile
npm run dev                  # Vite 127.0.0.1:5173
```

根目录 `scripts/start-dev.ps1` 会同时启动 API（127.0.0.1:5080）与本项目，并注入开发密钥。

- `/api` 代理到 `localhost:5080`；`FAB_API_TARGET` 只能指向本机 HTTP(S) 地址。
- 浏览器请求中的同名身份头会被移除并由代理注入服务器端开发密钥；不要使用 `VITE_` 变量保存密钥。
- 仅使用 WebGPU：缺少安全上下文 / `navigator.gpu` / adapter 时明确报错，不回退 WebGL。
- 产品 URL 只有 canonical 地址（`/`、`/fabs/{fabId}/3d`、`/equipment`、`/equipment/compare`），旧地址已删除。
- 设备状态走 REST 初值/轮询 + SSE；命令生命周期为 XState v6，后端实时命令流未提供时使用空/可替换命令源。

## 验证

```powershell
cd web_app
npm run typecheck             # 含 noUnusedLocals / noUnusedParameters
npm test
npm run build
```

当前基线：`tsc --noEmit` 0、Vitest 60 文件 / 265 测试 PASS、`vite build` 0。架构/边界检查由 Vitest 的 `tests/architecture-boundaries.test.ts` 与根目录 `tools/check_architecture.py` 共同覆盖。
