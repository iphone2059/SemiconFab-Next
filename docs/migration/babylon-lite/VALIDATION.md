# P0–P2 验证记录 — 2026-10-26

当前验收独立原生生命周期、P2a 设备和 P2b 厂房静态几何。产品状态仍是 `IMPLEMENTING / NOT_PARITY_VERIFIED`。最新完整记录见 [P2_STATIC_STRUCTURE.md](./P2_STATIC_STRUCTURE.md)，P2a 历史记录见 [P2_EQUIPMENT.md](./P2_EQUIPMENT.md)。

位置问题的后续修复见 [LAYOUT_PARITY.md](./LAYOUT_PARITY.md)：保留 TS 设备清单，修复坐标系/相机与楼层状态；实际 Next 与 Lite 五视角的 121 台机台、56 个黄光对象最大投影边界差 < 0.00003 px。此前 CPU 几何/可绘制性通过不能用于推断显示位置已对齐；本项也不接受照明、阴影和整图 Golden。

| 检查 | 结果 | 证据 |
|---|---|---|
| 迁移前前端基线 | PASS：49 文件、190 测试，typecheck/build | [baseline-tests.txt](./evidence/baseline-tests.txt)、[baseline-typecheck.txt](./evidence/baseline-typecheck.txt)、[baseline-build.txt](./evidence/baseline-build.txt) |
| 生命周期测试先失败后通过 | PASS：初版 10 项、审查后新增 7 项、P2a 再新增 2 项，总计 19 项通过 | [初版 RED](./evidence/runtime-red.txt)、[初版 GREEN](./evidence/runtime-green.txt)、[审查 RED](./evidence/review-red.txt)、[初始化恢复 RED](./evidence/initialization-recovery-red.txt)、[审查 GREEN](./evidence/review-green.txt)、[旧 RAF RED](./evidence/p2-instance-race-red.txt)、[连续丢失 RED](./evidence/p2-overlapping-loss-red.txt)、[最终全套](./evidence/p2-verify.txt) |
| 仓库总验证（修复后） | PASS：Python 16、.NET 67、前端 207；3 个 .NET 项目 Release 构建、类型检查、冻结锁文件安装、生产构建通过 | [verify.txt](./evidence/verify.txt) |
| 独立 Lite 构建 | PASS | [lite-build.txt](./evidence/lite-build.txt) |
| 初版真实 WebGPU：首帧、resize、卸载/重挂载、中止、3 次设备丢失恢复 | PASS（仅初版 `c00f1e0`，不覆盖审查后的修复）；Chrome 155.0.8059.86 / NVIDIA Ampere，GPU/console 错误均为 0 | [p1-browser.json](./evidence/p1-browser.json)、[p1-cube.png](./evidence/p1-cube.png) |
| 修复后的扩展原生 GPU 回归 | PASS（2026-10-26 恢复执行）：新专用 Chrome 155 / NVIDIA Ampere；三次恢复、恢复中卸载、初始 RAF 丢失、中止、重挂载、resize；GPU/console 错误 0 | [p1-browser-resumed.json](./evidence/p1-browser-resumed.json)、[p1-cube-resumed.png](./evidence/p1-cube-resumed.png)。保留历史 [超时](./evidence/browser-timeout.txt) / [adapter 不可用](./evidence/browser-gpu-unavailable.txt) 证据；旧会话根因未认定。 |
| 8 组原版冻结向量/翻译检查 | PASS：手动完整执行；新增 runtime 文件后重新生成 i18n 源码清单（只增加文件名） | [frozen-vectors.txt](./evidence/frozen-vectors.txt) |
| 12 个冻结源码/fixture 文件散列 | PASS：0 变化 | [BASELINE.json](./BASELINE.json) |
| 121 台 Lite 设备几何 | PASS（P2a）：51 批 / 936 零件实例，冻结几何/颜色/包围盒/身份对照、构建后 GPU 三次恢复及卸载/重挂载通过 | [P2 设备记录](./P2_EQUIPMENT.md)；全套 Python 16 / .NET 67 / 前端 213，typecheck/build PASS |
| 厂房结构 | PASS（P2b 几何）：1648 部件 / 396 批 / 10 灯，矩阵/包围盒/三角属性/材质输入对照通过；构建后 L1/FFU/B1/DUAL、三次恢复及重挂载通过 | [P2b 完整证据](./P2_STATIC_STRUCTURE.md)；最新总验证 Python 16 / .NET 67 / 前端 223，生命周期 23 项 |
| 产品拾取、完整 FAB 页面、阴影、模式组合 | NOT_RUN | P3–P9 后续门禁 |
| 原版/隔离旧 Next ISO/Top 参考捕获 | PASS（同 Chrome，1536×735，DPR 1，冻结 seed/clock），不等于完整 Golden 通过 | [清单](./evidence/p2-reference/manifest.json) |
| 原版/旧 Next/Lite 截图差异 | NOT_RUN | P1 cube 不等于 FAB Golden |
| 同机性能 A/B、60 分钟内存、浏览器矩阵 | NOT_RUN | 不推断性能收益或完整场景恢复能力 |
| 最终生产依赖禁止项 | NOT_RUN | 旧引擎待 P11 删除；本轮仅检查新 Lite 源码路径没有 core/compat/WebGL/私有 GPU API |

生产构建保留既有超过 500 kB chunk 的提示。当前产品构建的资源文件名和体积与迁移前相同，P1 测试入口不会进入产品构建；这不是最终 Lite 包体积验收。

浏览器初次运行因测试 HTML 没有 favicon 返回一个 404。为测试页增加内联空 favicon 后，另建全新 Chrome profile 复验通过；未忽略控制台错误。

`scripts/verify.ps1` 原有 `npx pnpm` 调用在此机器受全局 extensionless shim 影响。本轮仅用本地 PowerShell 函数将同一版本 pnpm 的调用转发到已安装的 `bin/pnpm.mjs`，随后完整执行原脚本；未改变验证内容。

总脚本的原有参考路径判断跳过了原版向量检查，因此另外手动执行全部 8 组 `--check`，结果已单独保存。

## 独立审查与修复

一次只读独立审查覆盖 `0b35ca5..c00f1e0`，发现 3 项 Important、无 Critical/Minor：

1. **恢复中卸载可能重新激活引擎**：原生 `disable()` 不取消已捕获恢复。现在将恢复作为未完成异步资源所有者，恢复成功/失败后才最终销毁替换设备；成功/失败两种情况均有 RED→GREEN 单测。
2. **初始 RAF 丢失会使 ready 永久等待**：原生恢复使用不同的 first-frame Promise。现在原生恢复完成也可满足初始帧门禁，并按设备代际重试 GPU 队列完成边界；对应首帧丢失、提交中丢失单测 RED→GREEN。
3. **ready 回调同步卸载后返回已销毁上下文**：通知后重新检查中止信号；重入测试 RED→GREEN。同时覆盖初始化通知中止、初始化失败与恢复重叠清理。

浏览器夹具也改为跟踪当前 generation 的上下文，不再用上一轮已销毁上下文代表 aborted mount。修复后 207 项前端全套测试及完整仓库验证通过，但扩展原生 GPU 回归尚未通过，因此这些修复没有完整 GPU 接受结论。无延后 Minor。

审查中未判定的范围为 P2–P11/整 FAB/Golden/性能（本轮明确只开始迁移），以及初始化通知中止仍短暂获取设备（已顺带由同一取消检查和回归测试消除）。这些不是已完成的产品门禁。

## 历史阻碍（当前 P1 cube 已复验通过）

挂起测试的专用 Chrome GPU 进程持续占用 CPU，页面调试求值不再响应；通过 Browser.close 关闭后，另一已有 Chrome 会话无法获取 adapter（Lite `#50`，在安装包源码中是 `requestAdapter()` 返回 null）。未认定是驱动、浏览器还是测试/Lite 路径的根因。

自动审批审查先拒绝批量强制结束专用测试 Chrome 进程，随后拒绝启动新测试 Chrome，均仅给出 `blocked by policy`。改用调试接口关闭故障会话，并尝试已有会话；CUA 清单没有其他浏览器可用。未修改 GPU/系统设置或以其他方式重试被拒绝的新进程启动。


## 2026-10-26 P4/P5 增量验证（源光照 / 原生 CSM 阴影 / 设施恢复）

状态：**IMPLEMENTING / NOT_PARITY_VERIFIED**。本轮仅接受预览中的有界 P4/P5 光照、阴影与设施恢复增量，不构成整产品/整 FAB/Golden/拾取/性能结论。证据：[evidence/lighting-shadows-facility-2026-10-26/README.md](./evidence/lighting-shadows-facility-2026-10-26/README.md)、[INVENTORY_2026-10-26.md](./INVENTORY_2026-10-26.md)。

| 检查 | 结果 | 证据 |
|---|---|---|
| 新增 GPU 验收 | PASS：`lite-lighting`、`lite-shadow`（真实 WebGPU，Chrome 155.0.8059.86 / NVIDIA RTX 3050，CDP），0 console/GPU 错误；每次运行均重新构建并通过 | `.local/lite-acceptance-final/{lite-lighting,lite-shadow}.json` 与 30+ PNG；提交副本见证据目录 |
| 既有 GPU 回归 | PASS：`lite`、`lite-equipment`、`lite-static`（三次恢复）、`lite-layout` 全部通过，0 错误 | 同一最终环境串行运行 |
| 源光照 | key 1.15 / fill 0.32 / ambient #cfd8dc×0.48，6 个源局部光 + 10 个结构 B1 + 2 个设施灯（18 打包）；开关实测：阴影 on/off 平均通道 Δ 3.73（11.87% ROI 像素变化，变化像素中位 Δ 28.67）；key off 平均亮度 229.71→175.61（−23.55%），且 key off 时阴影 on/off 归零；ambient/fill/locals Δ 26.37/12.82/5.90；全部恢复后与基线逐字节一致 | `lite-lighting.json` 的 `pixels` 块 |
| LinearEncoding | 冻结源 LinearEncoding 输出经 `scene.vImageInfos` 线性模式预补偿后，透射管线（rgba16float + 尾随图像处理 gamma）与无透射场景均输出线性显示值；同视角对比旧 Next 均值接近（见下） | `lighting.ts` 注释与 `comparison.json` |
| 原生 CSM 阴影 | 2048² depth32float × 2 层级联 + 原生静态缓存；195 caster 由显式数组捕获（721 输入 / 526 排除，透明、alphaBlend、顶点 alpha、LineMaterial、显式非 caster、禁用名零违规）；ISO/TOP/B1 贡献分别 Δ3.73/3.65/1.55；三次设备丢失均重建新 CSM 贴图并恢复；卸载+重挂载贡献一致；相同状态 PNG SHA-256 一致 | `lite-shadow.json` 的 `casters/pixels/lifecycle` 块 |
| 几何/相机回归 | PASS：121 台机台 + 56 个黄光对象，ISO/TOP/L1/B1/DUAL 最大投影误差 0.000021 px（其余 ≤0.000025 px） | `lite-layout.json` |
| 同视角外观对照 | HUD 隐藏的旧 Next 参考 vs Lite，场景 ROI [360,100,1500,700]、Pillow、无颜色校正：平均绝对 RGB 差 ISO 9.78 / TOP 13.11 / L1 12.32 / B1 16.75 / DUAL 19.68；P3/P6-P9 动态系统未迁移，不据此接受整图 | `comparison.json`（方法/ROI/哈希） |
| 设施恢复 | 1659 部件 / 274 原生 mesh / 1386 FFU 实例 / 2 风淋（含灯与标签）/ 6 粘尘垫/桁架/桥架/吊杆；逐部件源包围盒对照通过；源禁用早期程序化风淋近似与程序化天花板保持禁用；FFU 视图只显示恢复的原始天花板 | `lite-facility.test.ts`、`INVENTORY` R01/R02 |
| 前端与构建 | PASS：231/231 Vitest（55 文件）、tsc --noEmit、生产 build、Lite 独立 build（保留既有 >500 kB chunk 提示） | 本轮运行日志 |
| 仓库级验证 | PASS：Python 16/16、契约/架构/legacy-data 检查、8 组冻结向量、.NET 3 项目 Release 构建 + 67/67 测试；i18n 覆盖清单按新增源文件重新生成（仅新增文件名） | 本轮运行日志 |
| 原生实现边界 | 审计通过：`web_app/src/render/lite/**` 与预览入口无 `@babylonjs/core`/`compat`/`THREE`/WebGL 导入，无 Lite 私有下划线成员；光照用官方 MaterialPlugin + 公开材质 UBO，阴影用官方 CSM/静态缓存 API，几何用原生 mesh/thin-instance/billboard/ShaderMaterial；Canvas2D 仅生成源贴图/标签纹理 | 源码审计 |
| 独立只读审查 | 见下方“独立审查”记录 | `.local/review/REVIEW.md`（提交后记录结论） |

## 2026-10-26 代码审查四项修复（后续验证）

本节是上述 P4/P5 历史快照之后的修复验证，完整记录见 [review-fixes evidence](evidence/review-fixes-2026-10-26/README.md)。旧版“恢复后无错误”的检查没有覆盖 billboard 可见性，不能作为标签完整恢复的证据。

- 修复标签在 device-loss 后消失：公开原生 SceneContext / Billboard / RenderTask 组合，未修改 Lite、未使用私有 API。新增 `beforeStart` 注册等待与所有代际的未完成任务计数，防止过期恢复重启或卸载提前释放设备。
- 修复环境光开关仅更新 PBR 的分裂状态：同步原生 Standard 环境光强度。
- 修复自定义输出覆盖原生 unlit：通过 `getPbrUnlit` 保留库的材质语义。
- 修复未设置 `LITE_EVIDENCE_DIR` 时两项验收在返回截图路径处崩溃。
- 最终本轮实测：**238/238** 前端测试（55 文件）、类型检查、产品构建、Lite 构建通过；构建保留已有大 chunk 提示。
- 构建产物上的 `lite-lighting` / `lite-shadow` / `lite-static` / `lite-equipment` / `lite` 五套真实 WebGPU 验收通过，无 console/runtime/GPU 错误。Chrome 155 / **Intel gen-12lp**；本轮不沿用历史 NVIDIA 环境结论。灯光/阴影套件还验证了有截图目录和无截图目录两种路径。
- 标签 on/off 平均通道差 **0.3955**；关闭 ambient/fill/locals 后连续三次丢失，恢复画面差均为 **0**、上下文稳定为 **2**；恢复全灯后基线图片 SHA-256 完全相同。原生 unlit 灯光开关差为 **0**，Standard 环境光亮度贡献 **12.6455**。
- 独立只读审查无未解决的实质问题；随后视觉 QA 发现并修复默认 MSAA overlay 与透射的冲突，新增可见性 RED→GREEN 断言。审查建议的恢复失败/旧注册仍挂起组合也已覆盖，无延后项。

本轮没有重新运行布局投影参考套件（相关几何及坐标模块未改），也没有新增跨浏览器、60 分钟 soak 或整产品 Golden 结论。整体仍为 **IMPLEMENTING / NOT_PARITY_VERIFIED**。

## 2026-10-26 产品完成阶段验证（正式 /twin 原生 Lite）

状态：**IMPLEMENTING / NOT_PARITY_VERIFIED**。产品功能/生产构建验收、三次设备恢复、性能 A/B、1 分钟 soak（用户指示替代 60 分钟）与 Chrome+Edge 矩阵已通过，独立审查无 Critical/阻塞缺陷；仍缺完整冻结时钟 Golden、非 Chromium 浏览器、60 分钟 soak，故不宣布完整 parity。
证据包：[evidence/product-completion-2026-10-26/README.md](./evidence/product-completion-2026-10-26/README.md)。

| 检查 | 结果 | 证据 |
|---|---|---|
| 正式产品切到 Lite | PASS：`/twin` 挂载 `lite-backend.ts` → `render/lite/world.ts`；旧引擎不再在产品图内 | 源码；`vite build` dist 无 `WebGPUEngine`/`NullEngine`/core 符号 |
| 原生产品验收（dev + 生产构建预览 + Edge 156） | PASS，0 console 错误：拾取/悬停/选中框/双击聚焦、相机预设/轨道/页面自主缩放/resize、L1/B1/DUAL/EXPLODED、全部图层（含 heatmap/airflow 时钟）、状态灯同步、X-Ray 过滤/恢复、剖切平面与互斥语义、wafer/轨迹/跟随、tour/patrol/双语、三次真实设备丢失（cut/X-Ray/无空间模式，0 GPU 错误，相机、121 状态、无模式轮选中框保持，Redux 同步恢复） | `twin-lite.browser.ts`；acceptance.json / acceptance-edge.json（最终构建）；截图 |
| 旧产品 UI 回归 | PASS，0 console 错误（`twin.browser.ts` 原样运行于 Lite /twin，Chrome+Edge） | ui-final-run.json / ui-edge.json |
| 冻结时钟视觉 A/B | 比较（非 Golden，GOLDEN_CLOCK 手动步进）：ROI[400,120,1500,680] 均值差 ISO 9.831 / TOP 13.401 / B1 17.670 / DUAL 19.826 / EXPLODED 8.182 / CUT 5.108 / X-RAY 34.976；X-Ray 调色板已接入 CSM receiver（shadowLinked true、0 GPU 错误），差异从 43.86 降到 34.98，但仍为已知视觉缺口，其余视角 8–20 | frozen-clock-diff.json、frozen-clock-manifest.json、ref-*/lite-* PNG |
| 同机性能 A/B（生产构建） | PASS：Lite idle/orbit 57.9/53.9 fps vs 冻结旧 Next 15.8/14.0 fps，0 console 错误；dist gpu chunk 396,492 B vs 旧 2,528,822 B | perf-ab.json |
| P11 旧引擎清理 | PASS（独立审查确认）：17 旧源码删除，旧 Scene 依赖测试/采集工具清退（保留 52 文件/241 测试，含接受度 PNG 解码器单测）；`@babylonjs/core` 移出 manifest+锁文件（frozen-lockfile 验证）；src/tests/config/tools 0 旧导入 | 清理报告；dist grep；`pnpm --frozen-lockfile` |
| 前端检查 | PASS：`tsc --noEmit` 0；`vitest run` 52 文件 / 241 测试；`vite build` 0（仅既有 >500kB 提示） | 本轮运行 |
| 仓库级检查 | PASS：Python 16/16、契约/架构/legacy-data 检查、8 组冻结向量（i18n coverage 已重新生成并通过）、.NET 3 项目 Release 构建 + 67/67 测试 | 本轮运行 |
| Soak | 按用户指示以 1 分钟替代 60 分钟：生产构建最终版本 3,471 帧、均值 17.27 ms（57.9 fps）、p95 33.3 ms、0 long task、heap 85.7 MB、0 GPU/console 错误 | soak.json；**60 分钟 soak NOT_RUN**（用户指示） |
| 跨浏览器矩阵 | PARTIAL PASS：Chrome 155 + Edge 156 均通过产品验收与 UI 回归（0 错误）；非 Chromium WebGPU 浏览器本机不可用，NOT_RUN | acceptance-edge/ui-edge.json |
| 完整冻结时钟 Golden | NOT_RUN | — |
| 独立审查 | PASS：无 Critical/阻塞缺陷；REVIEW.md 记录 1 项 docs-only Important（D-1，本轮已修）与 10 项 Minor 残留风险 | REVIEW.md |
