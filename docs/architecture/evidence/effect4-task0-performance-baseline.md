# Task 0：真实性能基线（4fc8a94 vs Task 2 后）

- 执行日期：2026-10-29（Asia/Singapore）
- 基线提交：`4fc8a94a3f10d185c8bef7929349ac6ccb2b8792`（独立 worktree `.local/worktrees/effect4-baseline`）
- 迁移对照提交：`857b5ac`（branch `refactor/effect4-flat-20261029`，Task 3 之前）
- 工具：`tools/render_perf.mjs`（headless Chrome + CDP）、`tools/telemetry_stress.mjs`、`scripts/perf-render.ps1`、`scripts/perf-telemetry.ps1`
- 原始 JSON：`docs/architecture/evidence/perf/`
  - `baseline-4fc8a94-render-perf-dev.json`
  - `baseline-4fc8a94-render-perf-60hz.json`
  - `baseline-4fc8a94-telemetry-stress.json`
  - `post-task2-render-perf-dev.json`、`post-task2-render-perf-60hz.json`、`post-task2-telemetry-stress.json`

## 1. 环境

| 项 | 值 |
|---|---|
| OS | Windows 11 Pro for Workstations 10.0.26300 |
| CPU | 12th Gen Intel Core i7-12700H |
| GPU | Intel Iris Xe Graphics；NVIDIA GeForce RTX 3050 Laptop GPU |
| Chrome | Chrome/155.0.8059.86（headless=new，WebGPU） |
| Node | v26.12.1 |
| pnpm | 12.15.0（固定，npx 缓存预置） |
| .NET SDK | 11.0.100-rc.3.26522.148（global.json 已按 Task 0 决策对齐） |
| API 数据 | 单站点 DEMO-SITE / 单 FAB `37793fb6-5679-b7a3-3fef-d970433697c1`（FAB-01），121 tools |

端口说明：默认 5173/5174 被前序会话遗留 dev server 占用且当前会话无法停止；为保证可比性，两组测量均使用隔离端口并验证为各自源码：
- 4fc8a94 基线：API `5083`，Web `5182`（页面源码断言含 `routeTree.gen`）。
- Task 2 后：API `5082`，Web `5180`（页面源码断言含 `applicationRuntime`）。
两者使用同一机器、同一 Chrome、同一 API 数据、同一路由与场景（`/fabs/{fabId}/3d?perf=1`、180 frames、dev 与 60hz profile）。

## 2. 结果

### 2.1 真实渲染（render_perf，180 帧，WebGPU）

| 指标 | 4fc8a94 基线 | Task 2 后（857b5ac） | 阈值 |
|---|---|---|---|
| renderer ready | ready，frames 211 | ready，frames 211 | 必须 ready |
| 引擎推进帧 | 211 | 211 | >0 且推进 |
| drawCalls | 905 | 905 | >0 |
| dev p95 frame | 8.4 ms | 8.5 ms | ≤100 ms |
| dev p99 frame | 25 ms | 33.2 ms | — |
| dev 平均 FPS | 116.8 | 115.5 | — |
| 60hz p95 | 8.5 ms | 8.5 ms | ≤16.7 ms |
| 60hz p99 | 16.6 ms | 25 ms | ≤33 ms |
| 60hz heap growth | 11.1 MB | 6.79 MB | ≤32 MB |
| ready / first frame | 3159.3 / 3163.3 ms | 3185.2 / 3190.7 ms | — |
| GPU / browser errors | [] / [] | [] / [] | 必须为空 |
| failures | [] | [] | 必须为空 |

单轮测量；Task 6 将按 04 验收文档要求做同机串行交替 ≥3 轮并冻结阈值，不在 Task 0 声称最终性能验收通过。

### 2.2 Worker 遥测压力（500/2000/5000 entities，60Hz，5s）

| entities | 4fc8a94 基线 receiveRatio / p95 | Task 2 后 receiveRatio / p95 |
|---|---|---|
| 500 | 1.0 / 0.3 ms | 1.0 / 0.3 ms |
| 2000 | 1.0 / 0.4 ms | 1.0 / 0.8 ms |
| 5000 | 1.0 / 0.5 ms | 1.0 / 0.9 ms |

两组均 `failures: []`、`browserErrors: []`，Worker 收发比 100%；单轮数据，Task 6 重新执行多轮对比。

## 3. 为可复现性修复的测量工具

Task 0 运行中发现现有遥测压力工具的两个可复现性问题，已修复（属于测量工具，不改变产品行为）：

1. `tools/telemetry_stress.mjs`：Chrome 启动后立即读取 `/json/list`，可能仍看到 `about:blank`；改为连接 page target 后执行 `Page.enable` + `Page.navigate` 再轮询结果，避免依赖启动 URL 的竞态。
2. `tools/telemetry_stress.mjs`：`scripts/perf-telemetry.ps1 -Url <root>` 传入的是应用根地址，而工具原先把 `--url` 当完整 stress 页面 URL，导致永远等待；当 pathname 为 `/` 时补全为 `/tests/telemetry-stress.html`。

两项修复使 `scripts/perf-telemetry.ps1 -Url http://127.0.0.1:<port>/ ...` 按 README 文档可执行；Task 6 的最终 A4 将复用同一工具。

## 4. 边界

- 本轮只测单轮基线/对照，不能替代 Task 6 的 A3/A4 最终验收（多轮、阈值冻结、功能 e2e、包体/连接数/React render 计数等尚未测量）。
- 基线 JSON 与 commit/machine 绑定；后续环境变化需重新采集。
- 旧会话遗留的 5173/5174 dev server 未被使用或修改；本会话测量均在隔离端口并完成身份校验。
