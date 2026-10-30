# web_app

SemiconFab-Next 唯一 Web 前端：Vite + React 单页站点。**Effect 4 + 严格单层 `src/<module>/<file>` + code-based routing** 重构已完成；无 Zustand/TanStack Query/Zod/RxJS/router plugin。

React Compiler 使用 **Rust/Oxc**：`@vitejs/plugin-react@6.1.2` 的 `compiler` 选项驱动 `oxc-transform-react@0.156.0`（experimental，非 Babel）；`oxlint@1.90.0` 的 React correctness 规则作为静态门禁。

当前部署默认 1 个 FAB；架构必须支持 1–32 个相互独立、完整配置的 FAB（`Fab:FabCount` 显式配置），统一管理与监控。前端按 FAB 装配 Runtime/遥测/设备状态并用复合身份 `(siteId, fabId)` 隔离，页面/路由/数据层不得假设只有一个 FAB；浏览器验收可聚焦单个 FAB 渲染（跨 FAB 隔离由集成测试覆盖）。命令恢复仅保证活动命令，终态历史跨刷新不保证（ADR-010 §6.6）。

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
- 远程快照唯一 owner 为 Resource Atom；Router loader 使用 `runtime.resources.ensure(handle)`，与页面挂载共享同一 Atom/单飞读取。
- XState 命令生命周期由 Effect Scope 管理 actor；SSE 命令结果经 Effect PubSub/Stream 进入 bridge。
- 高频遥测/TypedArray/Worker/Babylon 对象不进入 AtomRegistry。
- 设备状态 REST 与 SSE 共用 ResourceManager 内的同步顺序提交规则；快照只写 FAB 作用域 Resource Atom。
- payload 的 Publish/Ignore 与读取控制态分离：有效同版本、同内容读取可结束刷新并清旧错误，但不替换 payload、推进 timestamp 或 writeSeq。
- 资源 load 默认 30 秒超时（`ResourcePolicy.loadTimeoutMs` 可覆盖），实际中断 fetch/响应体消费；零订阅 GET 可短暂共享，但不得因挂起而续期 idleTTL。
- 遥测 SSE 错误或默认 15 秒无有效递增帧会失活并回退设备基线；重连打开不等于恢复，只有当前有效帧及匹配 Worker 回复才能恢复 live。
- research 回放基线随复合 FAB 身份原子隔离；跨 FAB/新身份深链接使用默认基线，同身份重挂载保留固定基线，后续 live 帧不重写回放。

## 命令

```powershell
node node_modules/pnpm/bin/pnpm.mjs typecheck
node node_modules/pnpm/bin/pnpm.mjs test
node node_modules/pnpm/bin/pnpm.mjs build
pnpm lint   # oxlint src；verify.ps1 也会执行
pnpm e2e   # 真实浏览器功能验收，产物 docs/perf/effect4-e2e.json
```

架构/验收文档：`docs/architecture/`；性能证据：`docs/architecture/evidence/perf/`。