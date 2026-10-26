# web_app

唯一的 Web 前端项目：一个 Vite/React 单页站点，包含 Redux Toolkit + RTK Query 状态层、契约类型、工作台 UI、目录 UI 与基于 Babylon Lite 的原生 WebGPU 视图。页面按原版产品边界只展示一个 FAB（FAB-01），没有多 FAB 选择器。没有内部子包，也没有 pnpm workspace。

## 文件

```text
web_app/
├─ index.html
├─ package.json / pnpm-lock.yaml / tsconfig.json / vite.config.ts
├─ src/
   ├─ main.tsx                # 站点入口与工作台
   ├─ contracts.generated.ts  # 由 tools/generate_contracts.py 生成，勿手改
   ├─ contracts.ts            # 生成契约的再导出
   ├─ store/                  # configureStore、slices、RTK Query endpoints 与 typed hooks
   ├─ state-sync.ts           # 活动提交作用域与取消门禁
   ├─ fab-scene.ts            # 与引擎无关的场景 Port/SceneFacade
   ├─ lite-backend.ts         # 产品 SceneBackend：原生 Babylon Lite runtime + world
   ├─ render/lite/            # 原生世界组合、相机、拾取、状态灯、特效、剖切、环境、阴影、恢复
   ├─ ui.tsx / widgets.tsx / charting.tsx
   └─ scenario.ts
└─ tests/                     # Vitest / 浏览器验收；support/ 为验收统计工具
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
- 工作台 Run 使用 RTK Query HTTP 轮询；Twin 机台状态使用 REST 初值/轮询与 SSE 推送。当前无 WebSocket / SignalR / 二进制实时流。

## 验证

```powershell
cd web_app
npm run typecheck             # 含 noUnusedLocals / noUnusedParameters
npm test
npm run build
```

机台/厂房冻结基线见 `tests/fixtures/original-tool-reference.json`、`tests/fixtures/lite-static-structure-reference.json`、`tests/fixtures/lite-facility-reference.json`：原版数据的运行时提取结果，仅用于测试；原生 Lite 几何与之对照。

浏览器验收需要隔离的 Chromium CDP 会话并打开本地 `/twin`：

```powershell
# 真实产品页（原生 Lite）：功能/状态/三次设备丢失矩阵
node ../tools/run_twin_browser.mjs lite-product 9490 http://127.0.0.1:5173 .local/acceptance.json
# 旧产品 DOM 回归套件（现在运行于 Lite 页面）
node ../tools/run_twin_browser.mjs ui 9490 http://127.0.0.1:5173 .local/ui.json
```

迁移状态、产品级验收与环境说明见 `../docs/migration/babylon-lite/MIGRATION_PLAN.md`；最近一轮证据见 `../docs/migration/babylon-lite/evidence/product-completion-2026-10-26/README.md`。注意：隐藏/被遮挡的标签页会暂停 requestAnimationFrame，浏览器验收必须使用前台可见窗口。
