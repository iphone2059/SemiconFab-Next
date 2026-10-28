# ADR-0003 — 前端合并为单一 web_app 站点项目

- 状态：已采纳（2026-10-23）
- 关联：延续 [ADR-0001](0001-flat-project-layout.md) 的扁平/独立原则；前端在 ADR-0002 后仍是 9 个包

## 背景

用户提出“前端为什么会有这么多？难道不是只打开一个网站吗”。实际情况是：只有一个网站（一个 Vite dev server、一个构建产物），但按 v1.1 规范拆成了 9 个 pnpm 包（web_app + contracts/api-client/ui/widgets/charting/fab-scene/babylon-webgpu/state-sync），并依赖仓库根的 pnpm workspace 汇总。这与“一个站点、一个独立项目”的心智模型不一致。

## 决策

1. **只保留一个前端项目 `web_app`**：原 8 个包的源码合并进 `web_app/src/`，使用相对导入；不再有内部 `@fab/*` 包。
2. **前端项目自包含**：`web_app/package.json`、`web_app/pnpm-lock.yaml`、`web_app/tsconfig.json`、`web_app/.npmrc` 独立维护；仓库根不再有 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`。
3. **契约生成目标**：`tools/generate_contracts.py` 直接生成 `web_app/src/generated/contracts.generated.ts`，由 `contracts.ts` 再导出（2026-10-28 生成物统一到 `src/generated/`）。
4. **保持单站点边界**：WebGPU 仅在 `rendering/lite-backend.ts` + `rendering/lite/` 实现；应用侧场景 Port 在 `src/application/ports/scene.ts`（`ScenePort`，由 `rendering/lite-backend.ts` 实现；2026-10-28 前为 `src/rendering/fab-scene.ts`）；只允许 WebGPU，禁止 WebGL；测试位于 `web_app/tests/`（`src` 不放测试，由 `tools/check_architecture.py` 校验），2026-10-28 起按所有权镜像布局。
5. **构建与校验**：`scripts/verify.ps1` 改为进入 `web_app` 执行 install/typecheck/test/build；`scripts/start-dev.ps1` 直接在该项目内启动 Vite。

## 合并映射

| 原包 | 合并后文件 |
|---|---|
| `@fab/contracts` | `src/generated/contracts.generated.ts` + `src/contracts.ts` |
| `@fab/api-client` | `src/api-client.ts` |
| `@fab/ui` | `src/ui.tsx` |
| `@fab/widgets` | `src/widgets.tsx` |
| `@fab/charting` | `src/charting.tsx` |
| `@fab/fab-scene` | `src/fab-scene.ts` |
| `@fab/babylon-webgpu` | `src/babylon-webgpu.ts` + `src/babylon-lifecycle.ts` |
| `@fab/state-sync` | `src/state-sync.ts` |

> 历史映射保留合并当时路径。2026-10-28 清理后：`fab-scene` → `src/rendering/fab-scene.ts`，`state-sync` → `src/application/coordination/ScopeGate.ts`，功能 store 归位 `features/*/state/`（见 architecture §29.6）。**递归整改后终态：** `fab-scene` 的端口与 DTO 迁至 `src/application/ports/scene.ts`（`ScenePort`）并由 `src/rendering/lite-backend.ts` 实现；`src/generated/contracts.generated.ts` 的生成者与检查/登记为 `tools/generate_contracts.py` + `tools/generated-artifacts.json`；测试改为镜像式 `web_app/tests/**`（见 architecture §30 与 `web_app/README.md`）。

## 结果

- 前端由 9 个包降为 **1 个自包含站点项目**；整个仓库仍无总 solution/总 workspace，每个项目独立构建。
- `tools/check_architecture.py` 改为校验“只有一个 web_app、无根 workspace、无内部 @fab 依赖、web_app 自带 lockfile、禁止 WebGL”。
- 后续若要拆分部署或复用组件，可再按需拆包，但默认保持在单站点项目内。
