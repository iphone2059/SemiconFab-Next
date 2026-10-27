# 实施状态（V2.1 最终）

- 状态：**M0–M6 已落地；旧 Redux/RTK/Babylon 旧迁移证据已退役；仅保留 V2.1 所需实现与测试。**
- 最后验证：`./scripts/verify.ps1` exit 0
  - 契约/架构检查 PASS
  - 8 个 Python 工具测试 PASS
  - 3 个 .NET 项目 Release 构建 + 67 测试 PASS
  - 前端 `pnpm install --frozen-lockfile`、`tsc --noEmit` 0、Vitest **60 文件 / 267 测试 PASS**、`vite build` 0

## 当前架构

```text
React 19 + Vite 8 + TS 7
TanStack Router     URL/search/生成式路由树（canonical URL only）
TanStack Query      唯一 HTTP 缓存
Zustand             客户端 UI 状态
RxJS + Zod          实时类型化流/解码（CommandEventBridge 输入）
XState v6           命令工作流（CommandWorkflow 契约后；FabRuntime 按 FAB 装配）
Babylon Lite 1.36   WebGPU-only 渲染
```

- 产品 URL：`/`、`/fabs/{fabId}/3d`、`/equipment`、`/equipment/compare`；旧地址无重定向。
- 目录：`src/app`、`src/api`、`src/state`、`src/application`、`src/realtime`、`src/workflows`、`src/runtime`、`src/rendering/lite`。
- 旧 `src/render`、Redux/`src/store`、RTK Query、immer、Babylon 旧代码/旧迁移文档/parity 工具与测试均已删除（Git 历史保留）。

## 里程碑

| 阶段 | 结果 |
|---|---|
| M0 | V2.1 架构基线、ADR-0009/0010、专项文档 |
| M1 | Router/Query 基础设施、最终 URL、RQ-01/05 |
| M2a/b/c | 全端点 Query、RTK/Redux 删除、Zustand 接管 UI 状态、Router search、最终 URL |
| M3 | 实时契约、MessageDecoder/SequenceTracker、类型化流、CommandEventBridge/恢复（假源） |
| M4 | XState v6 工作流、FabRuntime/Factory/Registry/Lifecycle、三 FAB 隔离（测试源） |
| M5a | XState v6 正式产品接线、RuntimeBootstrap、多 FAB 数据驱动 UI、只读投影 |
| M5b | `src/rendering/lite` 归位、FrameRingBuffer/Worker 骨架、ARCH-11 检查、CPU 性能基线 |
| M6 | 旧迁移文档/证据/parity 工具与测试删除、verify 收口、README/架构/状态文档收口 |

## 测试与门禁

- RQ-01..RQ-05：真实 QueryClient + Router 集成测试 PASS。
- CE-01..CE-05、CE-08：假源/假 gateway 集成测试 PASS。
- CE-06/CE-07：M4 测试源/假 gateway PASS；CE-06 生产链路待后端。
- ARCH-01..12：`web_app/tests/architecture-boundaries.test.ts` + `tools/check_architecture.py` 可执行检查。
- 高频路径：`tests/realtime-frame-buffer.test.ts` 与 `tests/performance/telemetry-frame-buffer.test.ts`（CPU 基线；GPU/浏览器门禁未建立）。
- 渲染：`tests/lite-*.test.ts` 等当前实现回归测试保留；旧 frozen/browser parity 套件已删除。

## 已知边界

- 后端实时命令流/命令状态端点仍是占位；产品命令源为空/可替换，命令提交 UI 未提供。
- Worker/遥测未接真实数据源；SharedArrayBuffer/COOP-COEP 策略未定（OPEN-V21-14）。
- GPU/WebGPU 性能门禁需真实 GPU 浏览器环境。
- 当前产品数据为单 FAB；多 FAB runtime/UI 已数据驱动实现。
- XState v6 为 alpha（6.0.0-alpha.70），升级需重跑契约/集成测试。
