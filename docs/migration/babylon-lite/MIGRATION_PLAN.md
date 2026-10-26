# Babylon Lite 原生迁移进度

状态：`IMPLEMENTING / NOT_PARITY_VERIFIED`。正式 `/twin` 已由原生 Lite 后端承载并通过生产构建产品验收（功能矩阵、三次设备丢失、同机性能 A/B）；旧 Babylon 源码与 `@babylonjs/core` 依赖已删除。仍缺完整冻结时钟 Golden、非 Chromium 浏览器矩阵、用户指示替代的 60 分钟 soak 与独立审查（进行中），因此不是完整 parity 通过。

规范：[2026-10-26 迁移指南](../../SemiconFab-Next_Babylon-Lite_Native-Migration_Guide_2026-10-26.md)。保留原文，阶段进度在此维护。

## 冻结起点

- 分支：`feat/twin-babylon-lite-native`。
- 当前 Next 起点：`0b35ca5000140415046c9689ad769395953f9d08`。指南中的历史起点 `cba4225` 后还包含 Wafer 和光照修复，迁移从实际 HEAD 继承这些改动。
- 原版只读参考：`b3666132e5d8cab2cebe4c4227fc04c52242eb28`，已用本机参考仓库 `git rev-parse HEAD` 核对。
- Lite：精确版本 `1.36.0`，tag `npm-lite-v1.36.0`，源码 `5241e29f5a88ff23534a11d3114ac8ea983c5961`。npm 包的 `babylonLiteRelease.sourceVersion` 与远端 annotated tag 的 peeled SHA 一致。
- [BASELINE.json](./BASELINE.json) 保存布局、领域接口、确定性时序和全部现有 fixture 的工作区 SHA-256；不复制或重建原始数据。

## 工作包

| 阶段 | 状态 | 本轮交付 / 门禁 |
|---|---|---|
| P0 基线 | PASS（源码/单测/构建）；完整 Golden NOT_RUN | 固定三方版本、冻结 fixtures；旧 Next 49 文件 / 190 项测试通过。原版/隔离旧 Next ISO/Top 参考已保留；没有完整 Golden 接受结论。 |
| P1 原生生命周期 | PASS（独立夹具） | 23 项生命周期单测；支持等待原生异步上传，注册前设备丢失终止本次初始化；三组构建后硬件回归均通过，GPU/console 错误 0。不外推完整 FAB/加载中丢失的 GPU 崩溃行为。 |
| P2 静态几何 | PASS（几何门禁） | P2a：121 台设备 / 51 批 / 936 零件实例。P2b：L1/区带/墙柱/FFU/B1 共 1648 部件 / 396 批，10 盏 B1 灯；冻结顶点、矩阵、包围盒和材质输入对照通过。构建后 L1/FFU/B1/展开、三次恢复及重挂载通过；完整像素对齐和生产拾取仍属后续门禁。见 [P2_EQUIPMENT.md](./P2_EQUIPMENT.md)、[P2_STATIC_STRUCTURE.md](./P2_STATIC_STRUCTURE.md)。 |
| P3 后端/相机/拾取 | PASS（产品） | `lite-backend.ts` 实现现有 SceneBackend/SceneFacade，`/twin` 由原生 Lite 世界承载：相机预设/轨道/缩放/open resize、GPU 拾取/悬停/选中框/双击聚焦、楼层/爆炸/图层/状态灯/X-Ray/剖切/wafer/tour/patrol/双语。真实 /twin 产品验收 0 console 错误。 |
| P4 材质/光照 | PASS（产品集成，完整矩阵 NOT_RUN） | 源光照在预览与产品一致；生产构建逐视角对照冻结旧 Next 的均值差 ISO 10.2 / TOP 13.7 / B1 17.7 / DUAL 20.6 / EXPLODED 14.6（动态时钟未冻结，不构成 Golden）。 |
| P5 阴影 | PASS（产品集成，Golden NOT_RUN） | 原生 CSM 在产品中持续开启；三次设备丢失后 0 GPU 错误；完整场景矩阵/Golden 未执行。 |
| P6–P10 动态/业务/性能 | PASS（产品功能），性能：生产 A/B PASS | AMHS/人员/巡检、Roof HVAC/气流/热力图、X-Ray/剖切/wafer、tour/HUD 已由 Lite 原生模块承载并通过产品验收。生产预览同机性能：Lite idle/orbit 57.2/52.2 fps vs 冻结旧渲染器 16.1/15.5 fps；冻结时钟视觉 A/B、1 分钟 soak（用户指示替代 60 分钟）与 Chrome 155+Edge 156 矩阵见验证表。 |
| P11 删除旧引擎 | PASS（待独立审查） | 17 个旧渲染源文件删除；旧 Scene 依赖的验收/单测与采集工具删除，`lite-facility.test.ts` 改为冻结 fixture 对照（保留 52 文件/241 测试）；`@babylonjs/core` 移出 package.json 与锁文件；src/tests/config/tools 0 旧导入；生产 dist 无旧引擎符号；`gpu` chunk 396 kB vs 旧 2.53 MB。 |

独立测试入口支持 P1 立方体、`?scene=equipment` 和 `?scene=structure`（含 L1/B1/DUAL/FFU 按钮）。当前 `/twin` 已由原生 Lite 后端承载（P3/P11 完成，见“产品完成阶段”）；新 Lite 路径没有 `@babylonjs/core`、compat、alias、WebGL 或自制引擎兼容类，旧引擎源码与依赖均已删除。完整冻结时钟 Golden 与性能以外的浏览器/Soak 门禁状态见验证表。

后续位置修复：设备继续由 `export const FAB_LAYOUT: readonly FabLayoutTool[]` 定义。旧 P2 CPU 数据门禁遗漏了 RH/LH 和预览相机差异；现补充真实 Next→Lite 的 ISO/TOP/L1/B1/DUAL 对照，121 台机台及 56 个黄光对象最大投影边界误差 < 0.00003 px。B1/DUAL 保留 L1 对象且 DUAL 不下移 B1。详见 [LAYOUT_PARITY.md](./LAYOUT_PARITY.md)。

P4/P5 增量（2026-10-26，有界）：预览恢复冻结源的 key/fill/ambient、琥珀点光/聚光、源雾/曝光与 legacy 局部衰减（18 个打包局部光：6 源 + 10 结构 B1 + 2 设施灯），修正冻结源 LinearEncoding 在 Lite 透射管线下的双重 gamma；以原生 CSM 2048² depth32float + 比较采样 + 原生静态缓存投射阴影，显式 195 caster；恢复冻结源设施/风淋/粘尘垫/原始天花板（1659 部件 / 274 原生 mesh / 1386 FFU 实例 / 2 风淋含灯与标签），并按源把早期程序化风淋近似与程序化天花板永久禁用。真实 GPU：新增 `lite-lighting`、`lite-shadow` 与既有 `lite`/`lite-equipment`/`lite-static`/`lite-layout` 全 PASS，0 console/GPU 错误；几何投影误差 ≤0.000025 px；同视角 ROI 平均绝对 RGB 差 ISO 9.78 / TOP 13.11 / L1 12.32 / B1 16.75 / DUAL 19.68（HUD 隐藏的 Next 参考 vs Lite，Pillow，无颜色校正）。人员/AMHS/气流热力图/Roof HVAC/Subfab 细节/状态灯/wafer/tour 等 P3、P6-P9 系统仍未迁移，因此**不**构成完整像素/Golden 通过。证据与剩余差异见 [INVENTORY_2026-10-26.md](./INVENTORY_2026-10-26.md) 与 [evidence/lighting-shadows-facility-2026-10-26/README.md](./evidence/lighting-shadows-facility-2026-10-26/README.md)。

## 本轮实现决策

1. 在指南指定的 feature 分支、当前 checkout 执行 P0/P1；尚无旧/新视觉比较，因此不启动参考 worktree。后续 A/B 按指南使用独立旧版 worktree。
2. 保留指南历史基准，在此记录实际 Next 起点，避免丢失已有 Wafer/光照修复。
3. P0 Golden 尚未重新执行；允许开展独立 P1 生命周期验证，不将其视为产品视觉门禁通过。代价：P2 几何迁移前仍需补齐同环境参考截图。
4. 恢复执行时补齐 Chrome 155、1536×735、DPR 1 的原版/旧 Next ISO/Top 截图；旧 Next 从 `0b35ca5` 的独立只读 worktree 启动。仅冻结参考，完整 Golden 仍未通过。
5. P2 按有界模块拆为 P2a 设备与后续厂房结构；本次完成 P2a。身份使用现有 `TWIN_LAYOUT_IDENTITIES`，不以 recordId 去重；抽出纯几何零件供旧渲染器与 Lite 共用，旧几何回归 4 项通过。
6. P2b 从冻结 Next 的四个既有模块提取静态顶点/法线/UV/索引和世界矩阵，保留 source SHA，使用 Lite 原生 MeshFromData/LineSystem 重建。源数据按仓库规则位于 `web_app/assets`；代价是增加静态数据载荷，P10 再做同机性能评估。
7. 透明部件使用普通 Mesh 的原生世界变换，供 Lite 距离排序；不把透明位置藏在 thin matrix 中。原生折射所需的零辐射环境由官方 HDR loader 提供，材质环境光强度仍为 0，不添加天空/地板或自写 GPU 通道。
8. P4/P5 只用官方插件槽与公开材质/灯光 API 表达源光照：源环境光/局部光进材质 UBO（24 容量内），key/fill 保留原生光源槽；不引入正则替换器、不 fork Lite WGSL、不写私有 GPU 通道。冻结源 LinearEncoding 与 Lite 透射管线的差异在插件输出端按 `scene.vImageInfos` 线性模式预补偿，并在无透射场景直接输出线性值。
9. P5 caster 选择完全由冻结源数据/材质决定：显式 `setShadowTaskCasterMeshes`，排除地板/楼板/线/状态灯/透明/顶点 alpha 与 `staticShadowCaster:false`；关闭 key 光必须使阴影贡献归零。静态缓存与 thin-instance 世界包围盒使用 Lite 原生能力。
10. 设施恢复严格按冻结源参数与部件名；源在运行时禁用的早期程序化风淋近似与程序化天花板在 Lite 中保持禁用，FFU 视图只显示恢复的原始天花板，避免以“先看到图”为由保留非源几何。

审查后收尾：保留本地 feature 分支，不合并/推送。2026-10-26 恢复执行时，P1 扩展原生 GPU 回归已在新会话通过；旧会话挂起的根因仍未认定，不将新会话成功解释为驱动或 Lite 缺陷已修复。完整审查与门禁见 [VALIDATION.md](./VALIDATION.md)。

## 重复验证

PowerShell，仓库根目录：

```powershell
cd web_app
npm run typecheck
npm test
npm run build
node node_modules/vite/bin/vite.js build --config tests/lite-runtime.vite.config.ts
node node_modules/vite/bin/vite.js --config tests/lite-runtime.vite.config.ts
```

最后一个命令是独立测试服务器，端口 5175。在另一个终端启动独立 Chrome CDP 会话后执行：

```powershell
node tools/run_twin_browser.mjs lite 9490 http://127.0.0.1:5175 .local/lite-runtime-browser.json
node tools/run_twin_browser.mjs lite-lighting 9490 http://127.0.0.1:5175 .local/lite-lighting.json
node tools/run_twin_browser.mjs lite-shadow 9490 http://127.0.0.1:5175 .local/lite-shadow.json
```

`lite-layout` 额外需要冻结 Next 参考服务器（product 入口 + `tests/twin-golden.vite.config.ts` 注入冻结时钟）与 API key：

```powershell
$env:FAB_DEVELOPMENT_KEY = (Get-Content .local/development-key -Raw).Trim()
node node_modules/vite/bin/vite.js --config tests/twin-golden.vite.config.ts --port 5176 --strictPort --host 127.0.0.1
$env:NEXT_REFERENCE_URL = 'http://127.0.0.1:5176'
node tools/run_twin_browser.mjs lite-layout 9490 http://127.0.0.1:5175 .local/lite-layout.json
```

依赖安装使用仓库固定的 pnpm 12.15.0。此机器全局 Windows shim 无法执行 extensionless pnpm；实际执行入口为 `node C:/Users/han_qingyu/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.mjs`。未修改全局工具或绕过锁文件。

## 产品完成阶段（2026-10-26，本轮）

- **正式产品切到 Lite**：`web_app/src/fab-viewer.tsx` 动态加载 `lite-backend.ts`（原 `babylon-webgpu`），产品状态仍通过 SceneBackend/SceneFacade 与 Redux 交互。`render/lite/world.ts` 组合设备/静态厂房/设施/光照/原生 CSM 阴影/AMHS/人员/环境/特效，使用单一 RH→LH 渲染边界与单帧循环；`render/lite/cut-plane.ts` 用公开 MaterialPlugin 为 PBR 材质补齐全场景剖切；`render/lite/selection.ts`+`tool-states.ts` 提供原生 GPU 拾取与状态灯；billboard 使用共享 `overlay-billboards.ts`（LITE-GAP-RECOVERY-002 组合）。
- **产品验收**：`web_app/tests/twin-lite.browser.ts` 在真实 `/twin` 上覆盖拾取/悬停/选中框/双击聚焦、相机预设/轨道/缩放/resize、L1/B1/DUAL/EXPLODED、全部图层（含 heatmap/airflow 时钟）、工具状态帧同步、X-Ray 过滤/恢复、剖切平面/极性/互斥语义、wafer/轨迹/跟随相机、巡游/巡检/双语，以及**三次真实设备丢失**（cut/X-Ray/无空间模式三种前置状态，0 GPU 错误，相机/121 状态/无模式轮选中框与选中项保持，Redux 同步恢复；重建中的二次丢失会排队重建）。生产构建预览上同一套件与旧 `twin.browser.ts` UI 套件均 PASS，0 console 错误。证据：[evidence/product-completion-2026-10-26/README.md](./evidence/product-completion-2026-10-26/README.md)。
- **冻结时钟视觉 A/B**：对冻结旧 Next（`0b35ca5`）用参考 golden 的 GOLDEN_CLOCK 手动步进（相同虚拟帧数）捕获 7 视角，ROI 均值差 ISO 9.834 / TOP 13.406 / B1 17.668 / DUAL 19.834 / EXPLODED 8.191 / CUT 5.111 / X-RAY 43.860；X-Ray 为已知视觉缺口（不采样 CSM 深度、偏亮），整体仍记录为比较而非 Golden。
- **性能 A/B（生产构建）**：Lite 57.2/52.2 fps（idle/orbit）vs 旧渲染器 16.1/15.5 fps，0 console 错误；Lite gpu chunk 396,492 B vs 旧 2,528,822 B。
- **P11 清理**：17 个旧渲染源文件删除，旧 Scene 依赖的验收/单测与采集工具清退（保留 52 文件/241 测试，设施测试改为冻结 fixture 对照，新增接受度 PNG 解码器单测）；`@babylonjs/core` 从 package.json/锁文件移除；生产依赖图与 dist 无旧引擎导入/符号；前端 241 测试、typecheck、build 通过。
- **已知产品级取舍**（详见 [FEATURE_GAPS.md](./FEATURE_GAPS.md)）：整产品设备恢复采用替换设备上重建场景（原生 in-place 恢复仍由 bounded 夹具覆盖）；X-Ray 全息不采样 CSM 深度且冻结帧整体偏亮（冻结时钟视觉差 43.86，记录为已知缺口）；剖切仅作用于 PBR 材质；依赖旧 Scene 内部结构的旧验收脚本已清退，由产品验收套件替代。
- **Soak**：按用户指示改为 1 分钟 soak（最终生产构建：56.3 fps、0 long task、0 GPU/console 错误、heap 29.6 MB）；60 分钟 soak 因此 NOT_RUN，不虚报。
- **浏览器矩阵**：Chrome 155 与 Edge 156 产品验收+UI 回归均 PASS；非 Chromium WebGPU 浏览器本机不可用，NOT_RUN。
- **仍未完成**：完整冻结时钟 Golden、独立审查（REVIEW.md 收敛中）。
