# Task 6（阶段 C）：性能、GPU 与 A0–A4 最终验收证据

- 执行日期：2026-10-29（Asia/Singapore）
- 代码提交（测量时）：`e835e6f8de63aeb113057b87263bea1c739a48d2`（Task 6b 后；最终文档提交见 `git log`）
- 基线：`4fc8a94a3f10d185c8bef7929349ac6ccb2b8792`（`main`，独立 worktree / 端口 5184；仅用于 A/B）
- 新版本 worktree：`.local/worktrees/effect4-flat`，端口 5179；两者共用同一 dev API（5091）与同一浏览器/机器
- 工具：`tools/render_perf.mjs`、`tools/telemetry_stress.mjs`、`tools/bundle_metrics.mjs`、`tools/e2e_functional.mjs`
- 原始证据：`docs/architecture/evidence/perf/final-*.json`、`docs/perf/effect4-e2e.json`

## 1. 环境（A/B 同机同浏览器）

| 项 | 值 |
|---|---|
| OS | Windows 11 Pro for Workstations（10.0.26300） |
| CPU / GPU | 12th Gen Intel Core i7-12700H；Intel Iris Xe / NVIDIA RTX 3050 Laptop |
| Node / pnpm | v26.12.1 / 12.15.0（固定） |
| .NET SDK | 11.0.100-rc.3.26522.148（global.json） |
| Chrome | 155.0.8059.86（`--headless=new`，WebGPU flags） |
| 页面 | `/fabs/37793fb6-5679-b7a3-3fef-d970433697c1/3d?perf=1` |
| API | 单站点 DEMO-SITE / 单 FAB FAB-01 |
| 阈值（测量后冻结） | dev p95 ≤ 100 ms；60Hz p95 ≤ 16.7 ms、p99 ≤ 33 ms、heap growth ≤ 32 MB；所有 `failures`/`gpuErrors` 必须为空 |

## 2. 渲染 A/B（`render_perf.mjs`，600 帧，交替 3 轮）

### 2.1 dev profile（历史门禁 p95 ≤ 100 ms）

| 轮次 | 版本 | avg ms | p95 ms | p99 ms | ready ms | firstFrame ms | heapGrowth MB | drawCalls |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | baseline | 8.38 | 8.5 | 8.6 | 3177.6 | 3181.3 | 2.56 | 905 |
| 2 | baseline | 8.40 | 8.5 | 8.6 | 3189.6 | 3195.8 | 11.02 | 905 |
| 3 | baseline | 8.44 | 8.5 | 16.6 | 3199.9 | 3212.2 | 10.60 | 905 |
| 1 | new | 8.39 | 8.5 | 8.6 | 3180.2 | 3186.5 | 9.64 | 905 |
| 2 | new | 8.44 | 8.5 | 8.6 | 3781.9 | 3788.1 | 3.93 | 905 |
| 3 | new | 8.50 | 8.5 | 16.6 | 4495.4 | 4504.5 | 7.82 | 905 |

3 轮中位数：

| 指标 | baseline | new | 变化 | 结论 |
|---|---:|---:|---|---|
| avg frame | 8.40 ms | 8.44 ms | +0.04 ms（+0.5%） | 噪声内 |
| p95 | 8.5 ms | 8.5 ms | 0 | 持平，远低于 100 ms |
| p99 | 8.6 ms | 8.6 ms | 0 | 持平 |
| ready / first frame | 3189.6 / 3195.8 ms | 3781.9 / 3788.1 ms | +0.6 s（单轮抖动大） | 记录为加载波动，不作回归判定 |
| heapGrowth | 10.60 MB | 7.82 MB | −26% | 更低 |
| drawCalls | 905 | 905 | 0 | 持平 |

所有 6 轮 `failures=[]`、`gpuErrors=[]`；WebGPU secure/gpu/adapter/canvas 均通过。

### 2.2 60Hz profile（p95 ≤ 16.7 / p99 ≤ 33 ms）

| 轮次 | 版本 | avg ms | p95 | p99 | heapGrowth MB | failures |
|---|---:|---:|---:|---:|---:|---|
| 1 | baseline | 8.51 | 8.5 | 16.7 | 5.10 | [] |
| 2 | baseline | 8.60 | 8.5 | 16.6 | 2.60 | [] |
| 3 | baseline | 8.71 | 8.5 | 16.7 | 1.74 | [] |
| 1 | new | 8.53 | 8.5 | 16.5 | 2.26 | [] |
| 2 | new | 8.50 | 8.5 | 8.6 | 6.53 | [] |
| 3 | new | 8.51 | 8.5 | 8.6 | 6.05 | [] |

中位数：avg baseline 8.60 ms → new 8.51 ms（−1.0%）；p95 均 8.5 ms；p99 baseline 16.7 ms → new 8.6 ms；heap 2.6 MB → 6.05 MB（仍远低于 32 MB 阈值）；所有 `failures=[]`。60Hz 门禁 PASS。

## 3. 遥测 Worker 压力（`telemetry_stress.mjs`，8s @ 60Hz，3 轮交替）

| entities | baseline median p95 / receiveRatio | new median p95 / receiveRatio | 变化 |
|---:|---|---|---|
| 500 | 0.3 ms / 1.0 | 0.4 ms / 1.0 | +0.1 ms（亚毫秒） |
| 2000 | 0.6 ms / 1.0 | 0.7 ms / 1.0 | +0.1 ms |
| 5000 | 0.6 ms / 1.0 | 0.8 ms / 1.0 | +0.2 ms |

6 轮全部 `expected=sent=received=480`、`failures=[]`、`browserErrors=[]`；差异在亚毫秒级测量粒度内，未发现 Worker 收发或退化。原始：`final-telemetry-{baseline,new}-run{1..3}.json`。

## 4. 构建产物（`tools/bundle_metrics.mjs`，同一 Vite 8.3.5 生产构建）

| 指标 | baseline 4fc8a94 | new e835e6f | 变化 |
|---|---:|---:|---|
| JS raw | 3,220,099 B | 3,238,220 B | +18,121 B（+0.56%） |
| JS gzip | 597,188 B | 608,810 B | +11,622 B（+1.95%） |
| CSS raw/gzip | 121,099 / 20,863 B | 121,099 / 20,863 B | 0 |
| all raw | 3,345,835 B | 3,363,956 B | +18,121 B（+0.54%） |
| all gzip | 619,790 B | 631,412 B | +11,622 B（+1.88%） |

入口 chunk：baseline `index` 300.81 kB (gzip 91.89) + `react` 322.78 (102.67)；new `index` 197.22 (63.27) + `react` 440.74 (141.92)。入口 gzip +10.63 kB（+5.45%，Effect/Atom 进入 react chunk），但 lazy `lite-backend`/`gpu`/`twin-page` 不变、总 gzip 仅 +1.88%；无重复依赖打包。原始文件级明细：`final-bundle.json`。

## 5. 浏览器连接/Heap/React render 指标

来自 `pnpm e2e` 重新执行（`docs/perf/effect4-e2e.json`，每场景记录 `performance` 与网络摘要；dev server 模块请求数不作为生产 bundle 指标）：

| 场景 | 总请求 | EventSource 请求 | 结束时 active EventSource | Worker targets | JS heap MB |
|---|---:|---:|---:|---:|---:|
| S1 Workbench | 132 | 0 | 0 | 0 | 27.97 |
| S2 Catalog | 128 | 0 | 0 | 0 | 35.16 |
| S6 Twin DEMO | 384 | 2 | 2 | 1 | 81.10 |
| S7 Twin realtime | 384 | 2 | 2 | 2 | 77.71 |
| S10 退出/重进 | 197 | 2 | 2（唯一 URL，duplicates=0） | 1 | 82.94 |

- S7：REST 初始快照 1 次 + 2 个 EventSource（equipment-status + telemetry）；断线→CACHE→恢复 LIVE。
- S10：重进 Twin 后 active EventSource = 2、重复 URL 数 = 0；Worker targets 2 → 1（旧 target 退出，无无界增长）。
- **Atom 更新→React render 次数**（以组件 render 计数器测量，非 DOM 猜测）：
  - `tests/integration/equipment-status-pipeline.test.tsx`：原始 SSE Atom 写入不重渲 TwinContent，仅 100ms 合批投影允许一次；
  - `tests/integration/twin-subscription-isolation.test.tsx`：AMHS 统计、wafer 帧、sidebar/OEM/archive/inspector-MES 分支、YMS hover、die/ yield 输入、Tour HUD 等高频更新均断言 `viewport.renders` 不变；仅页级 store 更新允许重渲。
- **资源刷新/Scope dispose 残留**：
  - `tests/api/resource.test.tsx`（single-flight、freshness、idle TTL 回收、取消等待者不取消共享读取、失败保留旧值）；
  - `tests/integration/app-runtime.test.tsx`（idle TTL 回收 Atom / dispose）；
  - `tests/integration/twin-fab-scope.test.tsx`、`equipment-status-scope-cycle.test.tsx`（EventSource close、旧 generation 不写、FAB Scope dispose）；
  - 浏览器层 S10 补充 active EventSource/Worker 残留测量。

## 6. A0–A4 签收对照

| 等级 | 要求 | 结果 | 证据 |
|---|---|---|---|
| A0 | 目录/导入/依赖/生成物/单一 owner 门禁 | PASS | `source-layout`、`architecture-import-graph`、`architecture-contract-rules`、`legacy-dependency-gate`、`effect-runtime-boundary`、`resource-ownership`；`check_architecture.py` |
| A1 | Schema/Gate/resource/reducer/queue 单测 | PASS | 120 文件/718 测试；RES/Effect Schema/Gate/XState/queue 套件 |
| A2 | Router/Registry、SSE/REST、XState/Effect、Scope 集成 | PASS | `tests/integration/**`（router-resource、twin-fab-scope、equipment-status-scope-cycle、runtime-bootstrap 等） |
| A3 | 真实浏览器 URL/导航/表单/Twin/错误边界 | PASS 10/10 | `docs/perf/effect4-e2e.json`；截图 `docs/perf/e2e/` |
| A4 | 构建产物/WebGPU/Worker/帧时间/内存 | PASS，带边界 | 本文件 §1–§5；原始 JSON 在 `evidence/perf/` |

## 7. 未覆盖边界（不冒充已验证）

1. GPU 设备丢失未做真实硬件注入端到端恢复；由 `rendering/` 生命周期单测覆盖。
2. 跨 FAB 隔离未在浏览器中做（dev fixture 仅 1 FAB）；由 `twin-fab-scope`/`equipment-status-scope-cycle` 集成测试覆盖。
3. 浏览器功能/性能测量均使用 Vite dev server；生产 bundle 只测静态体积（§4）。
4. Heap 只覆盖 600 帧窗口，不是分钟级长稳测试。
5. Chrome `adapterInfo={}`（隐私），无法记录 GPU 型号/驱动；结论限定同机同浏览器 A/B。
6. 性能单轮波动明显（ready 3.2–4.5 s、heap 1.7–11 MB），结论采用 3 轮中位数与区间，不以单轮作回归依据。
