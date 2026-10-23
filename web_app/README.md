# web_app

唯一的 Web 前端项目：一个 Vite/React 单页站点，包含 API 客户端、契约类型、工作台 UI、状态同步与 Babylon WebGPU 视图。没有内部子包，也没有 pnpm workspace。

## 文件

```text
web_app/
├─ index.html
├─ package.json / pnpm-lock.yaml / tsconfig.json / vite.config.ts
└─ src/
   ├─ main.tsx                # 站点入口与工作台
   ├─ contracts.generated.ts  # 由 tools/generate_contracts.py 生成，勿手改
   ├─ contracts.ts            # 生成契约的再导出
   ├─ api-client.ts           # REST 客户端（ETag / Idempotency / 取消）
   ├─ state-sync.ts           # 作用域/序号与开发轮询
   ├─ fab-scene.ts            # 与引擎无关的场景 Port
   ├─ babylon-webgpu.ts       # 唯一 WebGPU 实现（含设备丢失恢复）
   ├─ babylon-lifecycle.ts
   ├─ ui.tsx / widgets.tsx / charting.tsx
   ├─ scenario.ts
   └─ *.test.ts               # Vitest 单元测试
```

## 运行

```powershell
cd web_app
npx --yes pnpm@12.15.0 install --frozen-lockfile
npx --yes pnpm@12.15.0 dev          # Vite 127.0.0.1:5173
```

根目录 `scripts/start-dev.ps1` 会同时启动 API（127.0.0.1:5080）与本项目，并注入开发密钥。

- `/api` 代理到 `localhost:5080`；`FAB_API_TARGET` 只能指向本机 HTTP(S) 地址。
- 浏览器请求中的同名身份头会被移除并由代理注入服务器端开发密钥；不要使用 `VITE_` 变量保存密钥。
- 仅使用 WebGPU：缺少安全上下文 / `navigator.gpu` / adapter 时明确报错，不回退 WebGL。
- 当前无 WebSocket / SignalR / 二进制实时流，使用 HTTP 全量轮询。

## 验证

```powershell
cd web_app
npx --yes pnpm@12.15.0 typecheck
npx --yes pnpm@12.15.0 test
npx --yes pnpm@12.15.0 build
```
