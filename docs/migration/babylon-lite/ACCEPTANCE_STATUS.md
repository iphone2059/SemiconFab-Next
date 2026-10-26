# Babylon Lite 产品迁移验收状态（目标门禁）

状态：**NOT_PARITY_VERIFIED**（保持不虚报）。正式 `/twin` 由原生 Babylon Lite 1.36 后端承载，
旧渲染器源码与 `@babylonjs/core` 已清零；功能、性能、三次设备恢复与 Chromium 浏览器矩阵已通过
真实验收，视觉以冻结时钟对照记录（整产品 Golden 仍未定义/未通过），其余缺口逐项如下。
最后更新：2026-10-27（分支 `feat/twin-babylon-lite-native`，最近实现提交 `faf8195`；本状态页随最终验证提交，本地不合并）。

| # | 目标门禁 | 状态 | 证据 |
|---|---|---|---|
| 1 | `/twin` 全部功能由 Lite 后端承载 | **PASS** | [MIGRATION_PLAN.md](./MIGRATION_PLAN.md) P3/P11；`web_app/src/lite-backend.ts`、`render/lite/world.ts`；产品验收覆盖全部功能面 |
| 2 | 旧 Babylon 产品路径源码清零 | **PASS** | 17 个旧渲染源文件删除；`fab-viewer.tsx` 仅加载 `lite-backend`；src/tests/config/tools 0 旧导入；dist 无旧引擎符号 |
| 3 | `@babylonjs/core` 依赖清零 | **PASS** | `web_app/package.json` + `pnpm-lock.yaml` 无 core；`--frozen-lockfile` 通过；dist grep 0 |
| 4 | 功能验收（真实 /twin） | **PASS** | Chrome 155 + Edge 156：拾取/悬停/选中框/双击聚焦、相机、L1/B1/DUAL/EXPLODED、全部图层、状态灯、X-Ray、剖切、wafer、tour/patrol、双语；0 console 错误。证据 [acceptance.json](./evidence/product-completion-2026-10-26/acceptance.json)、[acceptance-edge.json](./evidence/product-completion-2026-10-26/acceptance-edge.json) |
| 5 | 视觉验收 | **PARTIAL（NOT_PARITY）** | 冻结时钟 7 视角对照可复现（`tools/frozen_visual_compare.mjs`）：ISO 9.88 / TOP 13.47 / B1 17.75 / DUAL 19.94 / EXPLODED 8.30 / CUT 5.58 / **X-RAY 28.69**。**整产品冻结时钟 Golden NOT_RUN**（指南未定义阈值；X-Ray 仍有可见差距，已记录为对冻结产品外观的近似）。见 [README §3](./evidence/product-completion-2026-10-26/README.md) |
| 6 | 性能验收 | **PASS** | 生产构建、全新单一前台浏览器重复三次：Lite idle/orbit 52.5/45.8 fps vs 冻结旧 Next 38.2/37.4 fps（≈1.2–1.35×），0 console 错误；[perf-ab.json](./evidence/product-completion-2026-10-26/perf-ab.json) |
| 7 | 三次设备丢失恢复 | **PASS** | cut/X-Ray/无空间模式三轮真实 `device.destroy()`：0 GPU/console 错误，相机、121 工具状态、无模式轮选中框保持，Redux 同步恢复；重建中的二次丢失排队重建 |
| 8 | 60 分钟 soak | **NOT_RUN（按用户指示取消）** | 用户明确要求以 1 分钟替代；最终构建 1 分钟 soak：3,088 帧 / 51.5 fps / p95 33.4 ms / 0 long task / heap 37.5 MB / 0 GPU+console 错误（[soak.json](./evidence/product-completion-2026-10-26/soak.json)）。60 分钟不得记为通过 |
| 9 | 浏览器矩阵 | **PARTIAL PASS** | Chrome 155.0.8059.86 与 Edge 156.0.4314.42（Chromium/WebGPU）产品验收+UI 回归 PASS；非 Chromium WebGPU 浏览器本机不可用、未下载，**NOT_RUN** |
| 10 | 独立审查 | **PASS（无阻塞缺陷）** | 独立 reviewer 对冻结树给出 no Critical/no blocking；唯一 Important 为文档口径（已修）。[REVIEW.md](./evidence/product-completion-2026-10-26/REVIEW.md)（含 Lead 处置与后续增补） |
| 11 | 仓库级检查 | **PASS** | 契约/架构检查、Python 16/16、legacy-data 快照、8 组冻结向量、.NET 3 项目构建 + 67/67 测试、前端 tsc 0 + 52 文件/241 测试 + vite build 0 |
| 12 | 旧产品 UI 回归 | **PASS** | `twin.browser.ts` 原样运行于 Lite /twin（Chrome+Edge），0 console 错误：[ui.json](./evidence/product-completion-2026-10-26/ui.json)、[ui-edge.json](./evidence/product-completion-2026-10-26/ui-edge.json) |

## 进入完整 parity 仍缺（如实列出）

1. **X-Ray 视觉差距**：冻结时钟均值差 28.69（从 43.86 收敛）。根因是冻结产品全息使用其自有 static
   depth pass，其亮度分布与原生 CSM 不同；产品保留 CSM 调制并按冻结产品可见亮度做 legibility-floor
   近似（`XRAY_LIT_FLOOR`/`XRAY_SHADOW_CONTRAST`，见 [FEATURE_GAPS.md](./FEATURE_GAPS.md) 第 2 条）。
2. **整产品冻结时钟 Golden**：迁移指南未定义整产品 Golden 阈值，且受第 1 条影响，仍 NOT_RUN。X-Ray 残余分析显示差异主要是色相/叠层合成（高亮区参考均值 (65,135,166) vs 产品 (117,166,179)；非高亮区中位差仅 6；全局亮度对齐后差反而升到 35），说明继续调 lit 无法闭合；要完全复刻源自有 static depth pass 与合成，需要新增自定义固定光深 pass/材质叠层，属于迁移指南要求单独立项的新渲染器工作，超出本次迁移范围。
3. **非 Chromium 浏览器**：本机与下载策略下不可用，NOT_RUN。
4. **60 分钟 soak**：用户指示取消，NOT_RUN（1 分钟结果已记录）。
5. 审查残留 Minor（相机恢复计时、cascading-loss 无自动化覆盖、cut 无像素断言、gpuErrors 订阅时机等）
   记录在 REVIEW.md，未阻塞。

## 复现

```powershell
# 产品验收（Chrome CDP 9490；需前台可见窗口）
node tools/run_twin_browser.mjs lite-product 9490 http://127.0.0.1:5178 .local/acceptance.json
node tools/run_twin_browser.mjs ui 9490 http://127.0.0.1:5178 .local/ui.json
# 冻结时钟视觉对照（Lite 生产预览 5178 vs 冻结旧 Next 5179）
node tools/frozen_visual_compare.mjs --ref http://127.0.0.1:5179 --lite http://127.0.0.1:5178 --port 9490 --out .local/frozen-visual
# 前端
cd web_app; npx tsc --noEmit; npx vitest run; npx vite build
```

> 隐藏/被遮挡的标签页会暂停 requestAnimationFrame 并卡住 Lite 启动；验收必须使用前台可见窗口。
> 累积的多窗口 CDP 浏览器会造成 demo 定时器节流（曾导致 wafer 步骤超时），必要时用干净 profile 重启。

## 本机无法继续闭合的门禁（具体条件）

- **X-Ray 完全视觉对齐**：需要复刻源自有 static depth pass 与合成（自定义固定光深 pass/材质叠层），
  这是迁移指南要求单独立项的新渲染器工作；现有 Lite 1.36 公开 API 只提供透视 CSM，无法作为其等价物。
  已把差异量化到色相/叠层层面（见上），继续调亮度/lit 无收益。
- **整产品 Golden**：迁移指南未定义整产品 Golden 阈值（“现有 Golden 尚未全部通过，不可宣布 1:1”）。
- **非 Chromium 浏览器**：本机仅 Chrome 155 / Edge 156（Chromium），未安装也未下载 Firefox/Safari 等
  WebGPU 浏览器，NOT_RUN。
- **60 分钟 soak**：用户明确指示以 1 分钟替代（已记录 1 分钟结果），60 分钟门禁按指示不再执行。
