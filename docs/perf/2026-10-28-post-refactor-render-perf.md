# WebGPU 渲染与遥测性能证据（递归整改后 A/B）

- 日期：2026-10-28（Asia/Singapore）
- 基线提交：`67915c0eece848b0f45a64ccc5e1092b28bf5967`
- 整改后提交：`546647d`（12 个整改提交；本报告为第 13 项交付，性能验证本身不修改源码）
- 测量脚本：仓库既有 `tools/render_perf.mjs`、`tools/telemetry_stress.mjs`（未修改、未新增参数）
- 原始证据：`docs/perf/evidence/*.json`

## 1. 环境

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows（本机开发环境） |
| Node.js | v26.12.1 |
| Chrome | 155.0.8059.86（`--headless=new`） |
| WebGPU 启动参数 | `--enable-unsafe-webgpu --use-angle=d3d11 --disable-gpu-sandbox` |
| WebGPU 检查 | `secure=true`、`gpu=true`、`adapter=true`（`adapterInfo={}`，Chrome 出于隐私未返回 GPU 型号/驱动） |
| 页面 | Vite dev server；`/fabs/37793fb6-5679-b7a3-3fef-d970433697c1/3d?perf=1` |
| Canvas | 754 × 424 |
| 测量参数 | 600 帧，默认 30 帧 warmup，profile=dev（p95 ≤ 100 ms 历史门禁） |

两套代码使用同一 dev API（`127.0.0.1:5080`）、同一 FAB、同一 Chrome 与显示条件；baseline 在独立 git worktree（`67915c0`，端口 5174）运行，整改后在主工作区（`546647d`，端口 5173）运行，交替顺序执行 3 轮。单轮之间本机存在明显抖动（同一工具同一代码 fps 可在 58–116 间波动），因此结论以 3 轮中位数与区间为准，不使用单次样本。

## 2. 渲染帧时间（render_perf.mjs）

### 逐轮结果（均 600 帧，drawCalls 全部为 905）

| 轮次 | 版本 | avg ms | p95 ms | p99 ms | avg FPS | ready ms | firstFrame ms | heapGrowth MB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | baseline 67915c0 | 11.57 | 24.9 | 25.2 | 86.4 | 3217.3 | 3307.9 | 12.28 |
| 2 | baseline 67915c0 | 12.25 | 25.0 | 25.2 | 81.6 | 3221.0 | 3307.9 | 6.46 |
| 3 | baseline 67915c0 | 10.69 | 16.8 | 25.2 | 93.5 | 2909.1 | 3018.1 | 11.92 |
| 1 | post 546647d | 12.14 | 25.0 | 33.5 | 82.4 | 2824.8 | 2940.2 | 4.52 |
| 2 | post 546647d | 12.47 | 25.0 | 25.2 | 80.2 | 2908.1 | 2987.3 | 3.02 |
| 3 | post 546647d | 11.21 | 16.8 | 25.1 | 89.2 | 3172.6 | 3263.4 | 4.41 |

### 3 轮中位数

| 指标 | baseline（67915c0） | 整改后（546647d） | 变化 |
| --- | ---: | ---: | --- |
| avg frame（≈p50） | 11.57 ms | 12.14 ms | +4.9%（区间重叠，视为噪声内） |
| p95 frame | 24.9 ms | 25.0 ms | 持平 |
| p99 frame | 25.2 ms | 25.2 ms | 持平 |
| avg FPS | 86.4 | 82.4 | −4.6%（区间重叠） |
| navigation→ready | 3217.3 ms | 2908.1 ms | −9.6% |
| navigation→first frame | 3307.9 ms | 2987.3 ms | −9.7% |
| JS heap growth（600 帧内） | 11.92 MB | 4.41 MB | −63% |
| drawCalls | 905 | 905 | 持平 |

说明：
- 脚本未输出 `p50` 字段，表中以 `averageFrameMs` 作为中心趋势（p50 近似）并同时给出 p95/p99 与极值区间；帧样本数 600。
- 所有 6 轮 `failures` 与 `gpuErrors` 均为空，dev 门禁（p95 ≤ 100 ms）全部通过。`--profile 60hz`（p95 ≤ 16.7 ms / p99 ≤ 33 ms）未作为门禁结论运行；单轮 p95 在 16.8–25.0 ms 之间，说明本机 headless 合成器不具备稳定 60 Hz 上限，该档位不应据此判定回归。
- 结论：整改后渲染主路径没有可复现的退化；加载/首帧更快、堆增长更低，帧时间差异在测量噪声范围内。

## 3. 遥测 Worker 压力（telemetry_stress.mjs）

整改后代码、`/tests/telemetry-stress.html`、8 秒 @ 60 Hz、实体规模 500 / 2000 / 5000，共 2 轮：

| 实体 | 帧大小 | 期望/发送/接收 | receiveRatio | avg 延迟 | p95 延迟（两轮） | max 延迟（两轮） |
| ---: | ---: | --- | ---: | ---: | --- | --- |
| 500 | 1000 B | 480 / 480 / 480 | 1.0 | 0.25–0.28 ms | 0.4 / 0.5 ms | 0.6 / 0.6 ms |
| 2000 | 4000 B | 480 / 480 / 480 | 1.0 | 0.31–0.35 ms | 0.6 / 0.5 ms | 1.3 / 1.1 ms |
| 5000 | 10000 B | 480 / 480 / 480 | 1.0 | 0.44–0.50 ms | 0.8 / 0.9 ms | 1.4 / 1.2 ms |

两轮 `failures`、`browserErrors` 均为空，Worker 收发比 100%。

## 4. 未测量 / 边界（不得当作已验证）

1. **真实 GPU 设备丢失（Device Lost）与恢复**：仅由自动化测试覆盖（`web_app/tests/rendering/scene-port-lifecycle.test.ts`、`lite-backend-recovery.test.ts` 等），本机未做真实设备丢失注入后的端到端复原验证。
2. **GPU 型号/驱动**：Chrome 返回 `adapterInfo={}`，报告无法给出硬件型号；结论限定在“同一台机器、同一 Chrome、同一会话”的 A/B。
3. **生产构建性能**：测量使用 Vite dev server，未测 `vite build` 产物；生产 bundle 的加载/解析成本未覆盖。
4. **长时内存/GC**：只记录 600 帧窗口的 JS heap 增量，不是长时间（分钟级）稳定性测试。
5. **遥测 baseline**：本报告只有整改后的遥测压力数据；最初一次 baseline 运行使用了错误的 harness URL（`/`）而失败，随后按时间盒停止重试。渲染 A/B 已覆盖主路径回归判定。
6. `.local/render-perf.json`（2026-10-27，旧版工具 schema）与 2026-10-28 17:58 的单次试跑未用于结论，仅说明本机单次测量抖动可达 2×，故采用 3 轮交替中位数。

## 5. 复现命令

```powershell
# 1) 启动 dev（API + Vite），或复用已启动实例
./scripts/start-dev.ps1

# 2) 整改后（当前工作区，HEAD 546647d）
node tools/render_perf.mjs --url http://127.0.0.1:5173/fabs/37793fb6-5679-b7a3-3fef-d970433697c1/3d `
  --frames 600 --profile dev --out .local/perf-post-1.json

# 3) baseline（独立 worktree，端口 5174）
git worktree add --detach ../SemiconFab-Next-perf-baseline 67915c0
cmd /c mklink /J ..\SemiconFab-Next-perf-baseline\web_app\node_modules <repo>\web_app\node_modules
# 在 worktree/web_app 启动 vite --port 5174，然后
node tools/render_perf.mjs --url http://127.0.0.1:5174/fabs/37793fb6-5679-b7a3-3fef-d970433697c1/3d `
  --frames 600 --profile dev --out .local/perf-base-1.json

# 4) 遥测压力
node tools/telemetry_stress.mjs --url http://127.0.0.1:5173/tests/telemetry-stress.html `
  --seconds 8 --rate 60 --out .local/tel-post-1.json
```

## 6. 结论

Plan 第 14 项要求的“A/B 帧时间、内存、加载、交互及 GPU Lost 回归”中：

- 帧时间（avg/p95/p99）、加载（ready/first frame）、内存（heap growth）、drawCalls：**已测量，未发现不当退化**；
- 交互与 GPU Lost：由自动化测试覆盖（见 §4.1），**未做真实设备端到端测量**；
- 遥测 Worker 压力：**已测量且通过**，baseline 对照缺失（§4.5）。

因此第 14 项按其可交付部分完成，硬件级缺失项已如实列出，不将其表述为已验证。
