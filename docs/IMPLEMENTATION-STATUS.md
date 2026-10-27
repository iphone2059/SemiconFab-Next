# 实施状态（V2.1 最终）

- 状态：**M0–M6 已落地；M6 后补完成页面 features 归位、模拟后端命令/遥测链路、Worker 渲染接线与真实 Chrome/WebGPU 性能门禁。**
- 最后验证（提交前）：
  - 契约/架构检查 PASS
  - 8 个 Python 工具测试 PASS
  - 3 个 .NET 项目 Release 构建 + **73/73 测试 PASS**
  - 前端 `pnpm install --frozen-lockfile`、`tsc --noEmit` 0、Vitest **61 文件 / 271 测试 PASS**、`vite build` 0
  - `./scripts/verify.ps1` exit 0
  - 真实 Chrome/WebGPU 性能门禁：179 frames，avg 8.61ms，p95 8.5ms，avg 116.1fps，canvas 754×424（`.local/render-perf.json`）

## 当前架构

```text
React 19 + Vite 8 + TS 7
TanStack Router     URL/search/生成式路由树（canonical URL only）
TanStack Query      唯一 HTTP 缓存
Zustand             客户端 UI 状态
RxJS + Zod          实时类型化流/解码（CommandEventBridge 输入）
XState              命令工作流（CommandWorkflow 契约后；FabRuntime 按 FAB 装配）
Babylon Lite 1.36   WebGPU-only 渲染
```

- 产品 URL：`/`、`/fabs/{fabId}/3d`、`/equipment`、`/equipment/compare`；旧地址无重定向。
- 目录：`src/app`、`src/api`、`src/state`、`src/application`、`src/realtime`、`src/runtime`（含 `runtime/commands` XState 实现）、`src/features/{twin,catalog,workbench}`、`src/components`、`src/rendering/lite`。
- 旧 `src/render`、Redux/`src/store`、RTK Query、immer、Babylon 旧代码/旧迁移文档/parity 工具与测试均已删除（Git 历史保留）。

## 里程碑

| 阶段 | 结果 |
|---|---|
| M0 | V2.1 架构基线、ADR-0009/0010、专项文档 |
| M1 | Router/Query 基础设施、最终 URL、RQ-01/05 |
| M2a/b/c | 全端点 Query、RTK/Redux 删除、Zustand 接管 UI 状态、Router search、最终 URL |
| M3 | 实时契约、MessageDecoder/SequenceTracker、类型化流、CommandEventBridge/恢复（假源） |
| M4 | XState 工作流、FabRuntime/Factory/Registry/Lifecycle、三 FAB 隔离（测试源） |
| M5a | XState 正式产品接线、RuntimeBootstrap、多 FAB 数据驱动 UI、只读投影 |
| M5b | `src/rendering/lite` 归位、FrameRingBuffer/Worker 骨架、ARCH-11 检查、CPU 性能基线 |
| M6 | 旧迁移文档/证据/parity 工具与测试删除、verify 收口 |
| M6 后补 | 页面 `features/components` 归位；后端模拟命令 HTTP/SSE + 遥测 SSE；Worker → 渲染接线；真实 GPU 门禁 |

## 命令/遥测/渲染链路

- **命令**：Workbench `CommandConsole` → `POST /api/v1/sites/{siteId}/commands` → `FabRuntime.trackCommand` → 后端命令 SSE → `CommandEventBridge` → XState workflow；`GET /api/v1/commands/{id}` 供核对。浏览器实测 accepted → executing → succeeded。
- **遥测**：后端 20Hz 遥测 SSE → `TelemetryRuntime` → MessageDecoder → Worker FrameRingBuffer → 渲染 frame loop 的 `getToolStates()`；不经过 Query/Zustand/XState（ARCH-11）。
- **性能**：`tools/render_perf.mjs` 在 headless Chrome + 真实 WebGPU 上验证 `navigator.gpu`/adapter/canvas 并采集 rAF 帧；命令见根 README。

## 测试与门禁

- RQ-01..RQ-05、CE-01..CE-08：真实运行；CE-06 已有权威状态查询端点与集成测试。
- ARCH-01..12：Vitest 架构测试 + `tools/check_architecture.py` 可执行检查。
- 高频路径：`realtime-frame-buffer.test.ts`、`performance/telemetry-frame-buffer.test.ts`（CPU）+ `tools/render_perf.mjs`（真实 GPU）。
- 传输：`realtime-transport.test.ts` 覆盖 SSE 解码、HTTP gateway、命令提交、TelemetryRuntime Worker 链路。

## 已知边界

- 后端 `--realtime` WebSocket 仍是占位；当前产品使用 HTTP/SSE 模拟实现，WebSocket 生产传输后续可替换同契约。
- 后端状态为内存模拟，重启丢失；非模拟服务/持久恢复待真实后端。
- SharedArrayBuffer/COOP-COEP 未启用（OPEN-V21-14），Worker 走 postMessage。
- GPU 门禁为单机 headless Chrome 基线，不是生产设备矩阵/显存/长任务门禁。
- 当前产品数据为单 FAB；多 FAB runtime/UI 已数据驱动实现。
