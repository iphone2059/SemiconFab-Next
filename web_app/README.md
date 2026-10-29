# web_app

SemiconFab-Next 唯一 Web 前端：Vite + React 单页站点。**Effect 4 + 严格单层 `src/<module>/<file>` + code-based routing** 重构已完成；无 Zustand/TanStack Query/Zod/RxJS/router plugin。

当前产品与所有测试仅使用一个活动 FAB（FAB-01）。按 FAB 装配的 Runtime/遥测/设备状态、复合身份与集合契约保留，支持将来扩展；当前不要求多 FAB 部署/验收。

## 目录（实际）

```text
web_app/
├─ package.json / pnpm-lock.yaml / pnpm-workspace.yaml（仅 pnpm 配置载体）
├─ tsconfig.json / vite.config.ts
├─ src/
│  ├─ main.tsx                 # src 根唯一入口
│  ├─ api/                     # Resource Atom/policy、Effect HTTP transport、Effect Schema
│  ├─ app/                     # AppRuntime/AppProviders/RuntimeBootstrap（唯一组合根）
│  ├─ catalog/ components/ contracts/ domain/ generated/ lib/ localization/
│  ├─ realtime/                # Effect Stream/PubSub SSE、遥测 Worker、设备状态 gate
│  ├─ rendering/               # Babylon Lite/WebGPU
│  ├─ routes/                  # code-based router、route-data、search schema
│  ├─ runtime/                 # FabRuntime、命令 bridge、XState Effect Scope
│  ├─ state/                   # UI Effect atoms
│  ├─ twin/                    # Twin 页面/HUD
│  └─ workbench/               # 工作台
└─ tests/                      # Vitest（120 文件/718 测试）+ architecture gates
```

## 关键边界

- 一个应用一个 `AtomRegistry`；Router context 与 React 树共用 `AppRuntime`。
- 远程快照唯一 owner 为 Resource Atom；Router loader 使用 `ensureResource`，与页面挂载共享同一 Atom/单飞读取。
- XState 命令生命周期由 Effect Scope 管理 actor；SSE 命令结果经 Effect PubSub/Stream 进入 bridge。
- 高频遥测/TypedArray/Worker/Babylon 对象不进入 AtomRegistry。
- 设备状态 REST 与 SSE 共用 per-registry 顺序 Gate；快照只写 FAB 作用域 Resource Atom。

## 命令

```powershell
node node_modules/pnpm/bin/pnpm.mjs typecheck
node node_modules/pnpm/bin/pnpm.mjs test
node node_modules/pnpm/bin/pnpm.mjs build
pnpm e2e   # 真实浏览器功能验收，产物 docs/perf/effect4-e2e.json
```

架构/验收文档：`docs/architecture/`；性能证据：`docs/architecture/evidence/perf/`。
