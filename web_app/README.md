# web_app

唯一的 Web 前端项目：一个 Vite/React 单页站点，包含 Redux Toolkit + RTK Query 状态层、契约类型、工作台 UI、目录 UI 与 Babylon WebGPU 视图。页面按原版产品边界只展示一个 FAB（FAB-01），没有多 FAB 选择器。没有内部子包，也没有 pnpm workspace。

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
   ├─ fab-scene.ts            # 与引擎无关的场景 Port
   ├─ babylon-webgpu.ts       # 唯一 WebGPU 实现（含设备丢失恢复）
   ├─ babylon-lifecycle.ts
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

机台几何基线见 `tests/fixtures/original-tool-reference.json`：原版 121 台布局的运行时提取结果，仅用于测试。`original-tool-geometry.test.ts` 比较全部机台边界、八类顶点/颜色及四台目录模型的部件和材质。

已有隔离 Chromium CDP 会话（默认 9335，可设 `CDP_PORT`）并打开本地 `/twin` 时，可运行 `node tests/native-static-shadows.browser.ts`，验证真实 GPU 像素、静态缓存、层/光源失效与环境光隔离。它不会启动浏览器，也不改变渲染后端。连接浏览器时可传入 CDP transport 调用 `tests/twin.browser.ts` / `tests/twin-parity.browser.ts` 的导出验收函数，或传入支持的 tab 接口调用 `tests/remaining-state.browser.ts`。完整原版对齐状态及证据见 `../docs/migration/twin-parity/baseline.md`。
