# SemiconFab 原版 `twin.html` → SemiconFab-Next 3D FAB 页面 1:1 对齐规范

**文档版本**：v2.0 · 2026-10-24  
**性质**：针对单一 3D FAB 页面、可交付 AI Agent 的源代码对照评估与实施/验收任务书  
**原版**：[jinjiefan2020/SemiconFab](https://github.com/jinjiefan2020/SemiconFab)（重点：`twin.html`）  
**目标**：[iphone2059/SemiconFab-Next](https://github.com/iphone2059/SemiconFab-Next)（重点：`web_app/src/`）  
**核查基线**：2026-10-24，原版 `main`：`b3666132e5d8cab2cebe4c4227fc04c52242eb28`；Next `main`：`06be9c1b894415d579c35c0bf3020a4eba8bc027`。如 Agent 开始实施时 HEAD 已更新，必须记录新 SHA 并重新盘点差异。  
**取证范围**：GitHub 仓库文件树，原版 `twin.html`（约 218 个命名函数、263 个静态 DOM id）、`TWIN-DATA-MAP.md` 与布局/回放数据；Next `babylon-webgpu.ts`、`legacy-site.ts`、`procedural-fab.ts`、`original-tool-geometry.ts`、`site-preview.tsx`、`preview-page.tsx`、`fab-scene.ts`、`EquipmentStatusService.cs` 和 `docs/migration`。函数/id 数量是检索计数，不是功能数。**本轮尚未独立运行两个浏览器实例或完成整页像素差分**，已有通过记录来自 Next 仓库的实施日志，不能当作此次重新实测。

---

## 0. 用户需求及范围边界（强制）

> **只迁移原版 SemiconFab 的 3D FAB 展示页面 `twin.html`。最终 Next 页面让用户在相同视口、语言、模式、输入和场景时间下，不易从可见页面及交互行为判断技术栈已经更换。**

- **包含**：3D FAB 画布、页面内顶栏和两侧面板、全部 HUD、设备与空间几何、灯光/阴影、AMHS/OHT/FOUP/人员、首次引导、五站 Cinematic Tour、相机/快捷键、L1/B1/DUAL/EXPLODED、空气动力/剖切/X-Ray、Research 回放/利用率、晶圆路线跟随、设备检查器、OEM 目录入口、模拟/设备状态、MES/SPC/Wafer Map/Yield、页面内架构弹窗、页面内中英/明暗及其偏好、页面内 URL/deep-link 语义。
- **不包含**：全站默认首页外观、Next 工作台入口、根站点导航、其他独立网页（如 `twin-osat.html`、`layout-editor.html`、五个工艺教学页、成本、Benchmark、设备提交独立页、SEO/404）的视觉 1:1；对它们只验证 **`twin.html` 内跳转按钮能到达有效目标**，不要求目标页外观一致。
- **单场景口径**：原版展示 **一个单 FAB**。Next 若未来在管理端支持三个独立 FAB，这是另一项架构需求；不要把三 FAB 卡片、站点选择器或共享设施配置强行叠加进本次 3D 页面。
- **“对齐”不是“更好看”**：不得擅自重排 HUD、更换颜色/图标、删去看似冗余的原控件、调整默认镜头或把技术栈替换演变成界面重新设计。原版具有可复现缺陷时，先冻结差异并登记“兼容保留/纠错变更”，未经确认不暗改。

### 0.1 本项目绝对技术栈约束

| 维度 | 唯一允许方案 | 严禁 |
|---|---|---|
| UI | **React**（React 函数组件 + Hooks）| Vue、Angular、Svelte、jQuery DOM 控制器、运行时嵌入旧 HTML 页面 |
| 代码语言 | **TypeScript**：逻辑使用 `.ts`，React 视图使用 `.tsx` | 新增手写 `.js/.jsx/.mjs` 业务源码、`any` 蔓延、以内联 `<script>` 复刻原版 |
| 三维引擎 | **Babylon.js** 的 ES Module `@babylonjs/core` | Three.js、react-three-fiber、TresJS、A-Frame、第二套 3D runtime |
| 图形后端 | **WebGPU only**：Babylon `WebGPUEngine` | `Engine` WebGL、WebGL1/2 fallback、Three.js WebGLRenderer、CSS 3D 冒充三维 |
| 着色器 | Babylon WebGPU 原生 WGSL 或 Babylon 官方兼容 shader/材质 API；WGSL 可作为 TS 模板字符串 | GLSL/WebGL shader 回退、多后端分叉、手动访问 WebGL context |
| 页面架构 | 保持 **单一 `web_app` React 应用**，在原有 `src` 内按场景拆文件 | 新建第二个独立网站、iframe 载入原版、把旧 `twin.html` 作为生产页面 |
| 服务端接口 | 允许继续复用当前 `.NET` API/SSE、静态 JSON 及未来数据服务；只约束本次 3D **前端栈** | 为了页面对齐引入新的浏览器运行时框架或替换现有 Next 后端架构 |
| 部署 | 继续使用当前 Vite 产物；CSS/图片/JSON 等静态资产可存在于 `assets/public` | 把 Tailwind CDN、Three CDN 和旧 HTML 外链直接注入新页面 |

**边界清楚**：CSS、SVG、图片、JSON、字体、测试工具不属于替代 3D 框架。Babylon GUI 包不是必需，原版 DOM HUD 原则上应由 React TSX + CSS 绘制。若 Babylon 内部通过 WebGPU 运行原生计算/渲染管线，必须由同一 `GPUDevice` 管理，严守设备生命周期。当前 Next 已不使用 glTF/GLB，继续优先程序化几何，不要为了“方便”悄悄改回加载原版模型。

### 0.2 必须可检验的静态技术约束

`web_app/src` 下仅有 `.ts` / `.tsx` 业务文件。构建检查须覆盖：

1. 生产依赖不得出现 `three`, `@react-three/fiber`, `@react-three/drei`, `react-babylonjs`（若未批准）, `pixi.js`, `@babylonjs/loaders`（当前禁止 glTF 负载）、旧版 CDN 注入；原版只准在隔离的参考运行环境加载 Three.js。
2. 搜索 `new Engine(`、`getContext('webgl')`、`webgl2` fallback、`THREE.` 或 `WebGLRenderer`；任何新前端运行时代码命中即 CI 失败；避免误报类型说明/对照文档，检查实际 runtime 依赖图。
3. WebGPU 入口只使用 `new WebGPUEngine(canvas, ...)` 和 `await initAsync()`；`navigator.gpu` 不可用时显示明确的“WebGPU 不可用”状态，不能静默启用 WebGL。
4. 保留 `react`, `react-dom`, `@babylonjs/core` 的明确版本与锁文件；版本升级必须重新跑视觉基线和 GPU 实测，不要让 Babylon 私有 Shader API 漂移后仍宣称通过。

---

## 1. 当前差异结论（只看 `twin.html`）

| 子系统 | 原版 `twin.html` | Next 当前可见实现 | 当前判断 | 后续任务 |
|---|---|---|---|---|
| 设备布局/几何 | 121 台，含模板/目录模型、原布局坐标/旋转 | `original-tool-geometry.ts`、`fab-layout.ts`，Next 日志称 121/121 世界包围盒对齐 | 已有强基线，**不是整页等价** | 保留几何基线，补全部材质/选中态/屏幕差分 |
| Cleanroom/Subfab | L1/B1、厂务、屋顶/HVAC、垂直联接 | `procedural-fab.ts`、`subfab-utilities.ts`、部分 B1 | 部分 | 建筑/层级/管线/FFU/屋顶及视图组合对齐 |
| 光照/阴影 | 原版 Three 灯光/雾/材质/设备接触与静态阴影 | WebGPU `native-static-shadows.ts`、`native-shadow-material.ts` | 部分；未证整页像素 | 相机基线、光色、阴影形态、透明/深度排序 |
| AMHS/OHT/FOUP | 双环 OHT、移动目标、LED、物流统计与显隐 | `legacy-site.ts` 有 24 车及部分 AMHS UI | 部分 | 轨迹、速度、队列、Stats、接触阴影与场景联动 |
| 人员 | Bunny Suit、巡检/状态看板、部分特殊交互 | `procedural-fab.ts` 有 6 名程序化人员/运动 | 部分 | 行为、位置、时序、引导/风淋事件 |
| HUD/页面布局 | 原版复杂上/下浮层、左设备面板、右检查器、底部工具组 | `site-preview.tsx` 是 Next 自有布局/功能子集 | **重要差距** | TSX + CSS 视觉 1:1 优先 |
| 模式 | visitor / engineer / research、不同 HUD 与自动行为 | 现有主要是场景/旅游布尔态 | **缺失完整状态机** | 实现模式切换与副作用 |
| 导览/引导 | 五个 tour 站点 + 3 步首次引导 + 跳过/禁用 | Next 有简化 Tour | **差距** | 站点镜头曲线、时间、互斥、偏好保留 |
| 视角及分层 | ISO/Top/Litho/Airshower/...、L1/B1/DUAL/EXPLODED | ISO/Top/B1/Explode | **差距** | 参数和按钮级恢复 |
| 空间工具 | Aero、Exploded 滑条、X/Y/Z Cut + Invert、分系统 X-Ray | Next 仅简化图层和线框 X-Ray | **明显缺失** | Babylon 剖切、ghost 材质、互斥状态机 |
| 研究回放 | JSONL 时间轴、1/10/100/500 倍速、WIP/Util | Next 尚无完整 Research 播放器 | **缺失** | 索引构建、seek、模式叠层、暂停/恢复 |
| 晶圆跟随 | A/B/C 路线、1/4/16 倍速、尾迹、相机跟随 | Next 无完整对应控制器 | **缺失** | 轨迹/相机/路线与 HUD |
| 设备操作 | 搜索、状态筛选、OEM、位置聚焦、完整检查器 | 设备拾取、目录检索及简化卡片 | 部分 | 恢复原版字段、来源、定位和交互 |
| 业务演示 | 情景、仿真开关、E10 状态、MES、SPC、Wafer Map、Yield | SSE 合成状态，未形成 twin 页面等价实现 | **缺失或仅雏形** | 逐按钮与公式、效果契约实现 |
| i18n / 主题 | 页面内中英及模式联动、明暗主题、原偏好 | Next 部分页面支持，twin UI 未完整逐项校验 | 部分 | 全控件双语、默认/持久化、像素对齐 |

**注意**：Next `docs/migration/feature-map.csv` 的 F09—F22 当前多处仍标 `PLANNED`，但部分场景源码已实现。Agent 应以具体源文件 + 浏览器证据纠正状态，不得机械认为 `PLANNED` = 源码不存在；也不能将“已渲染”认定为“对齐”。

---

## 2. 源码映射（不得以重写所有文件为借口丢失现有成果）

### 2.1 原版到 Next 的概念映射

| 原版代码/功能位置 | Next 已有起点 | 目标实现位置（建议） |
|---|---|---|
| `twin.html` — 入口、顶栏、全部 DOM HUD | `site-preview.tsx`, `preview-page.tsx`, `assets/styles.css` | `src/twin/TwinPage.tsx`, `TwinHud.tsx`, `TwinInspector.tsx`, `TwinSidebar.tsx`, `assets/twin.css` |
| `initThree`, `setupLighting`, render loop | `babylon-webgpu.ts` | `src/twin/render/TwinWebGpuRuntime.ts`（过渡期调用现有 facade） |
| `createSingleEquipment3D`, `getSilhouetteFamilyGeometries`, `renderLayoutTools` | `original-tool-geometry.ts`, `fab-layout.ts` | 保留；可逐步封装 `render/EquipmentRegistry.ts` |
| `createCleanroomEnvironment`, `buildSubfabIndustrialFacilities`, `buildSubfabUtilityPipeRack` | `procedural-fab.ts`, `subfab-utilities.ts` | `render/FacilityLayers.ts`，保留原始尺寸/标签 |
| `buildAmhsSystem`, `updateAmhsSimulation`, Bunny Suit | `legacy-site.ts`, `procedural-fab.ts` | `render/AmhsController.ts`, `PersonnelController.ts` |
| `switchEntryMode`, `startCinematicTour`, `initOnboarding` | `site-preview.tsx` 简化状态 | `state/twin-reducer.ts`, `controllers/TourController.ts`, `TwinOnboarding.tsx` |
| `toggleSpatialMode`, `updateCutPlane`, `applyXRayFilter` | `legacy-site.ts` 层/线框 | `render/SpatialController.ts`, `TwinSpatialHud.tsx` |
| `initResearchReplayEngine`, `applyResearchStateAtTime` | 目前缺少完整同等模块 | `replay/ResearchReplay.ts`, `TwinResearchHud.tsx` |
| `initWaferFollowSystem`, `computeWaferWaypoints`, `updateWaferTrailMesh` | 目前缺少完整同等模块 | `wafer/WaferRouteController.ts`, `TwinWaferHud.tsx` |
| `selectEquipment`, `renderTechnicalLineArtSVG`, OEM inspector | `fab-tool-inspector.tsx`、`catalog-data.ts` | `TwinInspector.tsx`, `TwinEquipmentList.tsx`，按原版内容恢复 |
| `simulationTick`, `manualSetEquipmentState`, `mesTrackInCurrent`, `updateInspectorSpc` | `EquipmentStatusService.cs` / SSE 数据源 | `model/TwinDemoState.ts`, `TwinMesPanel.tsx`, `TwinSpcPanel.tsx` |
| `renderWaferMapSvg`, `calculateTheoreticalYieldModels`, `renderYieldWaterfall` | 尚无完整页面内实现 | `analysis/WaferMap.tsx`, `YieldPanel.tsx`, `YieldMath.ts` |
| `toggleOpenArchitectureModal`, 工具提示/主题/双语 | 局部 UI/偏好模块 | `TwinArchitectureModal.tsx`, `TwinTooltip.tsx`, `twin-i18n.ts` |

目标路径是**拟新增模块**而非当前真实文件，执行前先以 HEAD 文件树核查；不为追求文件数而做一次性大重构。迁移期间 `SiteScene`/`SceneFacade` 对外 API 要保持兼容，先接入新组件，再逐个退役重复逻辑。

### 2.2 推荐的代码组织（本项目只能是 React + TS/TSX + Babylon WebGPU）

```text
web_app/
├── src/
│   ├── main.tsx                     # 现有入口，不要求改成原版首页
│   ├── preview-page.tsx             # 保留现有路由入口，可转发到 TwinPage
│   ├── fab-scene.ts                 # 现有 SceneFacade/API 契约
│   ├── babylon-webgpu.ts            # 现有 WebGPU 运行时（渐进分层）
│   ├── original-tool-geometry.ts   # 121 台几何的已验证实现
│   ├── native-static-shadows.ts    # 原生 WebGPU 阴影
│   ├── native-shadow-material.ts
│   └── twin/
│       ├── TwinPage.tsx            # 页面尺寸、容器、Error Boundary
│       ├── TwinHeader.tsx          # 模式、层、镜头、语言、主题
│       ├── TwinSidebar.tsx         # FAB 设备列表/状态/搜索/OEM
│       ├── TwinInspector.tsx       # 原版检查器与 CAD elevation
│       ├── TwinHud.tsx             # 底部状态与快捷控制
│       ├── TwinSpatialHud.tsx      # Aero/Explode/Cut/X-Ray
│       ├── TwinResearchHud.tsx     # 回放时间轴/利用率
│       ├── TwinWaferHud.tsx        # Wafer 跟随
│       ├── TwinTourHud.tsx         # Cinematic tour
│       ├── TwinOnboarding.tsx      # 3 步首次引导
│       ├── TwinMesPanel.tsx
│       ├── TwinSpcPanel.tsx
│       ├── TwinWaferMap.tsx
│       ├── TwinYieldPanel.tsx
│       ├── TwinArchitectureModal.tsx
│       ├── state/
│       │   ├── twin-types.ts
│       │   ├── twin-reducer.ts
│       │   └── twin-selectors.ts
│       ├── render/
│       │   ├── TwinWebGpuRuntime.ts
│       │   ├── CameraController.ts
│       │   ├── FacilityLayers.ts
│       │   ├── SpatialController.ts
│       │   ├── AmhsController.ts
│       │   └── PersonnelController.ts
│       ├── replay/
│       │   ├── ResearchReplay.ts
│       │   └── ReplayIndex.ts
│       ├── wafer/
│       │   └── WaferRouteController.ts
│       ├── analysis/
│       │   ├── YieldMath.ts
│       │   └── SpcMath.ts
│       ├── adapters/
│       │   ├── TwinDataProvider.ts
│       │   └── LegacyParityAdapter.ts
│       └── twin-i18n.ts
├── assets/
│   └── twin.css                     # 在原 CSS 基础上实现像素级样式
├── public/
│   └── twin/                        # 回放数据、许可允许的资料
└── tests/
    ├── twin-*.test.ts(x)             # React 与数学/状态测试
    ├── twin-*.browser.ts           # 双端截图/交互基线
    └── fixtures/twin/              # Oracle 快照和截图索引
```

不是强制立即创建全部文件；**先实现有测试、有调用的模块**。TSX 仅承担 React 视图，Babylon Scene/Mesh/Observable 应保留在 `.ts` 控制器，React 不在 `render()` 中 new Mesh 或持有 GPUDevice。测试、CSS、静态 JSON 与 `.ts/.tsx` 同级分离符合既有 Next 规范。

---

## 3. 视觉 1:1 规范（以原版真实浏览器截图为唯一最终参照）

### 3.1 页面画面分区

必须单独截取并校验：

- V01：默认加载的整页全屏画面（相机、顶栏、底栏、左设备列表、右侧默认空/详情状态）。
- V02：顶栏和相机控制区：按钮顺序、图标、默认态、悬停/禁用态、tooltip、语言/主题。
- V03：左侧设备列表：目录/FAB 切换、分类 Pills、搜索框、RUNNING/IDLE/DOWN/MAINT 过滤、计数、排序、滚动、选中态。
- V04：右侧检查器：品牌/国家/型号/晶圆尺寸/来源等级、Draft 警示、1:50 CAD elevation、规格、厂务关系、MES、SPC、下钻按钮与弹层。
- V05：底部 HUD：状态 KPI、AMHS、模式、4 层级键和 4 种空间子 HUD 及信息披露。
- V06：Research / Wafer / Tour 模式各自的悬浮窗、时间轴、按钮、数值、进度和互斥时的显隐。
- V07：所有模态框：架构弹窗、Wafer Map、Yield Waterfall、OEM 对话框以及提示。
- V08：浅色/深色、中文/英文、不同视口下文本不溢出、层级不遮挡、浮层不穿透画布。

### 3.2 固化视觉条件

对两端使用相同：浏览器内核、版本、操作系统、DPR、视口、语言、主题、字体、静态数据 SHA、运行种子、相机位置/目标、场景时刻及动画暂停状态；默认建议采样 **1920×1080 / DPR 1**、**1366×768 / DPR 1**，并增测 **2560×1440 / DPR 2** 和移动视口的功能可用性。GPU/驱动型号、抗锯齿设置、色彩空间、曝光也应记录。原版 Three.js 与 Babylon WebGPU 的像素级完全相等不现实，因此对主观“看不出差别”使用**截图差分 + 关键 ROI + 盲测**的组合门禁。

建议质量门槛（是拟议门槛，须由首轮 Golden 截图校准，并非本轮已通过）：

1. **完整控件清单 100% 存在**：不接受“看起来像”的缺项。
2. **DOM/HUD 核心视觉区域**：关键文本、图标、按钮尺寸、相对位置人工逐一确认；ROI 图像相似度 SSIM 可先以 `≥ 0.98` 作为调优目标，遇到反锯齿/字体差异记录白名单。
3. **3D 画布**：需逐视角比较结构、轮廓、材质、阴影、亮度、层切换；可先以固定机型下场景 ROI SSIM `≥ 0.95` 作为待校准目标；无论综合分数多高，缺模型、错误层级、显著错误阴影均判失败。
4. **动态行为**：重放固定种子/固定时间点的视频或关键帧，不能以随机场景的单张截图评价动画。
5. **盲测**：给验收者隐藏实现来源，比较原/新两端关键截图和任务流，记录可识别差异；反复能辨别的高显著性差异须关闭。

### 3.3 重点图形误差项

- 坐标为**米**、右手系/WorldMatrix/父变换保持原版几何基线；初始布局 121 台不能重新随机排布。Next 已声称 121/121 世界包围盒最大差 `8.52346417445915e-7 m`，这是历史验证记录，不等同材质/整页截图。
- THREE 的 PBR 参数/色彩空间迁至 Babylon 时，校准 roughness/metalness、tone mapping、gamma、环境光、光照强度、雾和半透明深度排序；绝不能只用相同十六进制颜色就认定像素相同。
- WebGPU 只允许 `WebGPUEngine`；静态 `depth32float` Shadow Map 与动态 OHT/人员接触阴影要分层，不将移动物体盲目烘焙进入静态阴影。设备切换、B1、FFU、屋顶、Cut/X-Ray 时必须正确失效缓存。
- `StandardMaterial`、`PBRMaterial` 和原生 WebGPU 插件必须覆盖实际接收阴影的材质种类；设备丢失/恢复和销毁后不留失效 texture/bind group。
- 明确特效属示意性质：气流、压力、AMHS 运行状态、Wafer 轨迹、设备告警不可被改造成未经核实的真实厂务/OT 遥测。

---

## 4. 完整的页面内交互与行为契约

### 4.1 模式、旅游与键盘

- M01 `visitor`：原版按钮/选择框含 `mode-select`, `opt-mode-visitor`；按原版定义显示导览工具和简化操作状态，检查首次进入与刷新行为。
- M02 `engineer`：恢复设备清单、工程操作、检查器和层级控制的对应布局及控件权限。
- M03 `research`：显示 `research-hud`、WIP/AMHS、Replay 时间轴、速度组、利用率显示，退出时不遗留定时器、材质污染或遮罩。
- M04 **Cinematic Tour 五站**：宏观 FAB、Litho/Airlock、Etch、OHT、B1，保留站点跳转按钮 `tour-dot-0` 至 `tour-dot-4`、上/下一站、跳过、倒计时、镜头轨迹及互斥规则；不能以简单 `camera.alpha += delta` 冒充五站 Tour。
- M05 **首次引导**：`onboarding-bubble` 的 3 步（进度/文案/上一步/下一步/跳过/不再展示）；兼容原 localStorage 键 `semicon_twin_onboarding_dismissed`。
- M06 **事件互斥**：原版启动 Tour 会关闭 Wafer Follow，并处理 Onboarding；Wafer 播放启动时停止 Tour。整理成可单测的纯 TS 状态迁移表，别分散在 `useEffect` 里。
- M07 键盘与鼠标：补齐原版每一个快捷键、双击、右键、滚轮缩放、鼠标悬停、Esc 关闭的真实响应；检查输入框焦点优先级，避免快捷键误触。

### 4.2 空间模式与相机

- S01 **相机预设**：`iso`, `top`, `litho`, `airshower` 及源码其余 presets，原版 `setCameraPreset()` 的初始位置、lookAt、duration、easing、控制器限位、panning/zoom/double-click 行为逐项采样。初始原版 ISO 示例从 `(38,48,58)` 指向 `(0,0,0)`，Top 从 `(0,95,0.1)` 指向原点；不要把 Next 仅按相似角度构建的 ArcRotateCamera 当作精确复现。对目标/镜头位姿做世界空间比较。
- S02 **楼层按钮**：`L1`, `B1`, `DUAL`, `EXPLODED`。`DUAL` 是上下层叠加/透视语义，**不能只用 B1 可见替代**；切换中要恢复之前隐藏的设施与材质。
- S03 **统一 Spatial HUD 互斥**：`aerodynamics | exploded | cut | xray | null`，重复点击关闭，切换先撤销之前模式。必须与 Level 切换状态机联动，非彼此独立的若干 Boolean。
- S04 **Aerodynamics**：热图/层流粒子/洁净室压力分布与 HUD 三组压力读数，动作与开关要可验证；示意数据标记来源。
- S05 **Exploded**：保留连续滑条、拆分因子读数、分层连线及恢复动作，而不是现在只有固定 2.4m 位移开关。
- S06 **Cut**：X/Y/Z 轴、滑条位置、Invert、读数与范围。原版有 `cut-axis-*`, `cut-slider`, `btn-cut-invert`，Next 必须在 Babylon 材质/clip plane 或受支持 WGSL 管线中实现真正几何裁剪；不是改 Alpha 或隐藏整组。
- S07 **X-Ray**：`all/upw/gas/vac/exhaust/amhs` 过滤、透明 ghost、原颜色/alpha 缓存及恢复；仅设置设备 `wireframe=true` 不算等价。要保证与 Cut、楼层及静态阴影相容。
- S08 **Roof/HVAC、FFU、Ceiling grid、OHT、Subfab 管线**：每一开关单独校验；原版屋顶示意 Badge/Tooltip 的鼠标位置和文字也是页面契约。

### 4.3 设备、动画与工业状态展示

- E01 以原版 `twin/layout-default.json` 的 121 台为唯一位置真值；区分 `recordId`（型号目录）与 **现场实例 ID**（121 个放置实例），同型号可多次出现，选中态不可使用 `recordId` 当唯一 Mesh 键。
- E02 检查器、左右边栏、搜索、Bay 定位、类别和状态过滤、OEM 入口逐字段对齐；保留来源等级/`draft` 提示及尺寸不确定性，不暗示量产工程认证。
- E03 `renderTechnicalLineArtSVG` 生成的 1:50 CAD elevation 需要按原版模型边界、标注、颜色、缩放和可点击项重建；可用 React SVG，而不是引入另一个三维引擎。
- E04 Universal SEMI E10 状态塔 Green/Amber/Red/Blue 亮灭/脉冲；设备状态变化时同步边栏、检查器、指标、场景灯塔和统计。
- E05 OHT 双环运行轨迹、车数（原版/Next 当前描述为 24）、车辆 LED、FOUP、AMHS HUD 的 jobs/avg/active、动线及时间尺度要和原版基线比；既有可用模型不得重写成箱体占位。
- E06 人员 6 名、Bunny Suit、巡检步态、风淋/气闸动效、告示板等需要固定脚本种子与关键帧，不能只校验“有 6 个人”。

### 4.4 Research Replay 与 Wafer Follow

- R01 读取原版 `twin/events-t1-fifo.jsonl`（现有迁移记录为 **27,263 行**），原封保存 SHA、事件类型、时间精度、排序，构建 seek index；**该文件是展示事件流，不是权威 Checkpoint/WAL**。
- R02 研究播放器支持 Play/Pause、拖动 `research-scrubber`、模拟时间读数、倍速 **1/10/100/500**、WIP/AMHS、分 Bay/设备 Utilization；越界、空数据、网断/加载失败要显示正确状态；任意 seek 不得仅靠“从开头每次重放所有帧”。
- R03 Research 模式的独立数据时间轴不能被 Next 的 8 秒合成 SSE 覆盖。SSE LIVE 和 Replay 是两种明确状态源，切换时卸载之前订阅或隔离数据层。
- R04 Wafer Follow 的 **A/B/C 产品路线**、步骤、工段/Recipe/设备、3D 轨迹、平滑镜头跟随、尾迹、重播、独立倍速 **1/4/16**、暂停与完成时 UI 状态逐项匹配；别与 Research 的速度语义混淆。
- R05 录制 Seek 目标点（0、25%、50%、75%、100%）、各种速度暂停/恢复、连续拖动、模式互斥和重入后状态；需要 Golden 数据而非肉眼推断。

### 4.5 页面内 MES / SPC / YMS / Yield

- B01 **场景控制**：Scenario 下拉、模拟 Play/Pause、状态 Tick、手动设置 RUNNING/IDLE/DOWN/MAINT、状态塔/统计联动。原版 `simulationTick` 使用约 1600ms 定时演示；New 后端可以换实现，但页面上的时序与结果必须有可回放参考。
- B02 **MES**：选中设备的 Carrier/Recipe/Job/Step 状态，以及 TrackIn/TrackOut/Hold。原版 `mesTrackInCurrent`, `mesTrackOutCurrent`, `mesHoldLotCurrent` 有本地演示状态变化。若 Next 使用后端 API，需要确定“严格复现演示”模式和“受控真实模型”模式边界；不能把模拟状态标成真实生产指令。
- B03 **SPC**：Cp/Cpk/Sigma/Nelson 警告、历史曲线、当前 Sensor/Target/Tolerance，缺样本时保留原版页面显示但标注演示口径。特别注意：原版 `updateInspectorSpc()` 样本少于 5 时曾返回示例常数 `Cp=1.75`, `Cpk=1.64`, `4.92σ`；此行为不是统计有效性证明，须写兼容例外，不得在真实数据场景当成实测值。
- B04 **Wafer Map**：Wafer SVG、不同缺陷图样预设、重新随机、Die hover、统计与导出 STDF-like JSON。SVG 可以由 React TSX 输出，不需要第二个 canvas/3D 框架。
- B05 **Yield**：8 阶段 waterfall、实际/预测指标、理论 Poisson/Murphy/Seeds 模型、输入滑条/面积/缺陷密度/聚集系数以及单位/格式。公式口径须从原版抽出为无 DOM 纯 TS 函数，并用 Golden vectors 对比。
- B06 **架构弹窗**、来源与声明、相关跳转入口保留原版页面行为；不是整个网站导航 1:1 的义务。

---

## 5. React 状态与 Babylon Runtime 的边界设计

### 5.1 单一 Source of Truth

前端必须存在独立的 `TwinUiState` 与 `TwinSceneState`；强类型区分：

```ts
export type EntryMode = 'visitor' | 'engineer' | 'research';
export type FabLevel = 'L1' | 'B1' | 'DUAL' | 'EXPLODED';
export type SpatialMode = null | 'aerodynamics' | 'exploded' | 'cut' | 'xray';
export type CutAxis = 'X' | 'Y' | 'Z';
export type XRayFilter = 'all' | 'upw' | 'gas' | 'vac' | 'exhaust' | 'amhs';
export type StatusSource = 'demo' | 'sse-live' | 'research-replay';

export interface TwinUiState {
  entryMode: EntryMode;
  level: FabLevel;
  spatialMode: SpatialMode;
  cut: { axis: CutAxis; positionM: number; invert: boolean };
  xray: XRayFilter;
  tour: { active: boolean; waypoint: number };
  onboarding: { open: boolean; step: number };
  wafer: { active: boolean; playing: boolean; speed: 1 | 4 | 16 };
  research: { playing: boolean; timeSec: number; speed: 1 | 10 | 100 | 500 };
  statusSource: StatusSource;
  selectedEquipmentInstanceId?: string;
}
```

允许在 `.ts` 中以 reducer/event 模型管理此状态，由 `.tsx` 使用 Hooks 订阅，触发 Babylon Runtime 的**幂等命令**。**禁止**把整个 `Scene`、Mesh、GPUBuffer 放进 React state；禁止把 `requestAnimationFrame` 逐帧值写进顶层 React Context 导致页面每帧重渲染。

### 5.2 渲染运行时生命周期

- 单一 Canvas/Scene/Camera/WebGPUEngine 所有权在 Runtime 中，React 仅 mount/unmount + UI 事件传递；支持 React StrictMode 双挂载生命周期检查。
- 所有 `Observer`、`ResizeObserver`、DOM listener、EventSource、timer、动画句柄可追踪释放；组件卸载后不再更新 `setState()`。
- WebGPU 设备丢失时暂停、标记不可用、恢复资源并重建静态阴影；不可编造“已恢复”信息，必须等待真实 Babylon 恢复事件及第一帧成功。
- 一切材质编辑（X-Ray、剖切、楼层）保存原值并可逆；避免开启新模式后把旧模式 ghost/alpha 留下。
- 静态阴影缓存由 Transform/Geometry/Visibility/Light/Device 事件失效；相机移动时不重建整个静态 Buffer，B1 隐藏/恢复要重建必要阴影。

### 5.3 Three.js → Babylon WebGPU 语义转换注意点

- THREE camera.position/lookAt → Babylon ArcRotate/FreeCamera 目标参数，必须校准投影视角，不能直接复制 `alpha,beta`。
- THREE PBR/颜色空间（sRGB/linear）→ Babylon PBR 的具体转换测试；所有灯具、静态 shadow bias 和透明排序都可能改变画面。
- THREE clippingPlanes → Babylon clip plane / WGSL 支持路径，验证所有 Standard/PBR 的统一裁剪行为，必须兼容 Submesh 和实例化 Mesh。
- THREE InstancedMesh → Babylon InstancedMesh/ThinInstances，注意 picking、alpha、颜色、world matrix、冻结缓存及每实例 shader 数据。
- THREE onBeforeRender 动画 → Babylon `onBeforeRenderObservable`；必须独立确定模拟时间，不依赖不稳定帧率。
- React 事件与 Babylon pointer/picking 互斥：UI overlay 按钮不得穿透到画布，按原版行为测试捕获/冒泡。

---

## 6. 实施工作包及 DoD（按依赖顺序执行）

下表每项应转成可追踪 Issue/任务；**不得因已经有相似按钮而关闭**。建议先完成 P0 → P1 → P2，不以“全局都能点击”为完成标记。

| 工作包 | 优先级 | 目标（Next 建议路径） | 必交产物和验收 |
|---|---|---|---|
| TWIN-00 基线冻结 | P0 | `tests/fixtures/twin`, `docs/migration/twin-parity/` | 固定两端 SHA、运行参数、截图/视频、相机姿态、263 id 的动态控件清单、关键操作轨迹；建立需求追踪表 |
| TWIN-01 Runtime 约束 | P0 | `babylon-webgpu.ts`, `twin/render/*` | WebGPUEngine only、完整资源所有权、DeviceLost 测试；生产源码无 Three/JS/GL fallback |
| TWIN-02 React 页面骨架 | P0 | `TwinPage.tsx`, `TwinHeader.tsx`, `TwinSidebar.tsx`, `TwinHud.tsx`, `assets/twin.css` | 与原版相同 UI 区域/尺寸/叠层/交互热点；入口仅改 3D 页面，不动全站工作台 |
| TWIN-03 现有几何锁定 | P0 | `original-tool-geometry.ts`, `procedural-fab.ts` | 121/121 身份、World AABB、投影轮廓回归；不破坏已有投射阴影和选择器 |
| TWIN-04 视觉定标 | P1 | `legacy-site.ts`, `native-*shadow*.ts`, `TwinWebGpuRuntime.ts` | ISO/Top/Litho/B1 等 Golden 截图、灯光/阴影/材质/天空/色彩空间逐项校准 |
| TWIN-05 相机/快捷键 | P1 | `CameraController.ts` | 所有预设、位置、目标、动画 easing、轮缩/拖拽/双击/快捷键与原版行为比对 |
| TWIN-06 Tour + Onboarding | P1 | `TourController.ts`, `TwinTourHud.tsx`, `TwinOnboarding.tsx` | 五站 Tour、3 步引导、定时/前后跳转/跳过/偏好及 Wafer 互斥齐全 |
| TWIN-07 空间状态机 | P1 | `SpatialController.ts`, `TwinSpatialHud.tsx` | L1/B1/DUAL/EXPLODED、Aero/Explode/Cut/Xray 状态互斥、滑条/轴/Invert/filter 全验收 |
| TWIN-08 设施/动态场景 | P1 | `FacilityLayers.ts`, `AmhsController.ts`, `PersonnelController.ts` | FFU、Roof、UPW/PCW/Gas/Vac/Exhaust、AMHS 24 车、FOUP、6 人关键帧/Stats |
| TWIN-09 设备列表/检查器 | P1 | `TwinSidebar.tsx`, `TwinInspector.tsx` | 搜索、类别/状态、OEM、选中/定位、Draft/Provenance、尺寸/CAD、Bay 信息完整 |
| TWIN-10 三模式完整切换 | P1 | `twin-reducer.ts`, `TwinHeader.tsx` | visitor/engineer/research 各控件和禁用态、进出模式副作用按表运行 |
| TWIN-11 Research Replay | P1 | `replay/*`, `TwinResearchHud.tsx` | 27,263 行 JSONL 基线、Seek、1/10/100/500、WIP/Util、暂停/连续播放与 SSE 隔离 |
| TWIN-12 Wafer Follow | P1 | `wafer/*`, `TwinWaferHud.tsx` | A/B/C、1/4/16、尾迹、Follow Camera、Recipe/TG/Bay、重播、互斥 |
| TWIN-13 Demo/State | P2 | `TwinDataProvider.ts`, `TwinDemoState.ts` | DEMO/SSE/Replay 清晰区分、时钟和状态统计一致，E10 灯塔/列表/检查器同步 |
| TWIN-14 MES/SPC | P2 | `TwinMesPanel.tsx`, `TwinSpcPanel.tsx`, `SpcMath.ts` | TrackIn/Out/Hold、Carrier/Recipe、传感器、Cp/Cpk/Nelson、样本不足时的兼容披露 |
| TWIN-15 Wafer Map/Yield | P2 | `TwinWaferMap.tsx`, `TwinYieldPanel.tsx`, `YieldMath.ts` | 缺陷预设/hover/导出、8 阶瀑布、Poisson/Murphy/Seeds 数值 Golden 向量 |
| TWIN-16 对话框/双语/主题 | P2 | `TwinArchitectureModal.tsx`, `twin-i18n.ts`, `twin.css` | 各弹窗、全部字段文案、主题/语言、tooltip、本地偏好持久化 |
| TWIN-17 差分验收 | P0-2 | `web_app/tests/`, `docs/migration/twin-parity/` | 覆盖所有关键状态、截图/视频、基线差异、真实 GPU/长时测试、不可忽略缺项 |
| TWIN-18 发布关闭 | P0 | `docs/migration/progress.md`, `feature-map.csv` | 更新 F09—F22 子项，提交审计结果、例外、截图签核和版本锁定；不得把整站标记完成 |

**交付节奏建议**：以 TWIN-00/01/02/03 为第一批次，TWIN-04—10 为第二批次，TWIN-11/12 为第三批次，TWIN-13—16 为第四批次，TWIN-17/18 贯穿各批次。任何 P0 阶段出现长时间 GPU 资源泄漏/设备丢失致命异常，应优先处理，不继续叠加 UI。

---

## 7. 每一工作包的执行模板（AI Agent 强制使用）

每个任务的 PR/变更说明必须具有以下字段：

```yaml
id: TWIN-XX
baseline:
  original_repo: jinjiefan2020/SemiconFab
  original_file: twin.html
  original_commit: <固定SHA>
  next_commit_before: <固定SHA>
  fixtures: [<原始截图/日志/输入数据SHA>]
behavior:
  controls: [<原版id/事件/文本>]
  interactions: [<动作与前后状态>]
  data: [<来源/版本>]
implementation:
  frontend_stack: React + TypeScript TS/TSX + Babylon.js WebGPU only
  changes: [<Next文件路径>]
acceptance:
  typescript: required
  vitest: required
  browser_diff: required
  gpu_validation: when_applicable
  evidence: [<截图,视频,日志,指标>]
known_deviations: []
status: BASELINED
```

状态只允许：`BASELINED → IMPLEMENTING → CODE_READY → DIFFERENTIAL_TESTED → VISUAL_REVIEWED → PARITY_VERIFIED`。无证据不得跳级。每个功能的截图需要至少两个方面：UI 控件存在/响应，以及 Babylon 场景实际像素或可测世界状态。对同一个按钮不能以“单测覆盖了 reducer”取代实际交互验收。

---

## 8. 验收测试矩阵（最低用例，不是完整自动生成清单）

| 用例 | 输入及动作 | 必须一致的输出 |
|---|---|---|
| A01 | 首次 `/twin` 或 `/preview` 打开，默认语言/主题 | 页面完整结构、默认相机、首帧画面、状态/免责声明 |
| A02 | 选每一种 FAB 设备类型，并开详情 | 选中高亮、聚焦相机、来源与尺寸、CAD、OEM/工艺字段 |
| A03 | 搜索、类别和 E10 状态四过滤 | 结果集、计数、排序、滚动、清空时状态 |
| A04 | 切换 visitor/engineer/research | 各自 HUD、可见控件、状态互斥、隐藏/恢复数据 |
| A05 | Tour 依次五站、直接跳第 4 站、跳过 | 镜头坐标、过渡、倒计时、站点说明、按钮状态 |
| A06 | 清空 onboarding 偏好后刷新/不再显示 | 3 步引导文案与持久化行为 |
| A07 | L1 → B1 → DUAL → EXPLODED → L1 | 各层准确显隐、镜头与透明材质不残留 |
| A08 | Aero On/Off，FFU/Roof/OHT/pipe 开关 | 粒子、管线、层流、HUD 数值、明暗恢复 |
| A09 | Explode 0/50/100% 滑动 | 设备/子层连续位移、连线、滑条读数 |
| A10 | Cut X/Y/Z，Invert，正负极端位置 | 真正的裁剪面、有效物体集合及数值 |
| A11 | X-Ray all/UPW/Gas/Vac/Exhaust/AMHS | 分系统可见/半透明，退出还原材质 |
| A12 | Research 0/25/50/75/100% seek，倍速 1/10/100/500 | 时间、设备、WIP/Util/AMHS、暂停重开无漂移 |
| A13 | Wafer A/B/C，播放/暂停/重播/跟随、1/4/16 | 路线序列、步数、轨迹、镜头、HUD 元数据 |
| A14 | Simulation Tick、设备四状态手动切换 | 灯塔、计数、检查器/列表同时更新 |
| A15 | MES TrackIn/Out/Hold，切设备，再回来 | Carrier/Recipe/Step、状态迁移与原版兼容语义 |
| A16 | SPC 历史数据/缺样本 | Cp/Cpk/Sigma/Nelson 与提示、演示数值不误称实测 |
| A17 | Wafer Map 切图案、随机种子、hover、导出 | Die 颜色/统计、导出结构、可复现条件 |
| A18 | Yield 输入区间与边界值 | 8 阶段瀑布、公式结果、数值格式/单位 |
| A19 | 主题/语言轮换、刷新、改变视口 | 全部按钮标签、HUD/弹层无遮挡、偏好一致 |
| A20 | 持续 60 分钟运行并多次进入退出、GPU device lost 注入 | 无 GPU validation errors、无不可恢复掉帧/资源增长、Canvas 正常恢复 |

对非确定性动画：将“模拟时钟”和“渲染时钟”分离，使用固定种子/特定关键帧测试，不靠截图时间偶然一致。多设备 GPU 性能验收应记录测试显卡/驱动/浏览器，不编造统一 FPS 实测值。

---

## 9. 集成检查与质量门禁

### 9.1 现有工程命令

在完整 Next 仓库的 `web_app` 下执行：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

在仓库根目录按既有验收脚本运行（若本机已配置）:

```powershell
pwsh -File .\scripts\verify.ps1
```

**注意**：类型检查/单元测试/Vite 构建通过只是基本门槛，无法证明画面相似度。真实 WebGPU 需在支持的浏览器、HTTPS/localhost、可用 GPU 设备下运行浏览器测试；若运行环境不支持 GPU，不得以 NullEngine 模拟测试冒充 WebGPU 场景验收。

### 9.2 自动化静态审计与运行检查

- ESLint React Hooks 规则；TS `strict`、`noUncheckedIndexedAccess`（在处理已有索引之后开启）及高风险 API 参数边界检查。
- 代码搜索 Three/WebGL/CDN/iframe；依赖树检查和 Bundle 分块检查。
- API/SSE `siteId + sequence` 或兼容时间戳门禁，Replay 期间必须隔离 LIVE 帧。原版 Demo UI 与 Next 后端合成状态时间基准需有一份明确的可比较脚本。
- Babylon GPU：Renderer/Draw Calls、P50/P95 CPU/GPU frame time、纹理/Buffer 生命周期、Device Lost，检查 2048² 静态阴影缓存是否错误重建或泄漏。
- 视觉：原版与 Next 各自同配置截图、标记关键 ROI、生成差异热图和静态/交互报告。

### 9.3 禁止的“伪完成”

1. 只把原版按钮文字复制出来，实际没有接通控制器。
2. 用 Tailwind/静态 CSS 把旧 3D 截图盖在 Babylon canvas 上。
3. `touring=true` 让相机不停旋转，但缺五站 Tour。
4. 将 `wireframe` 当成全部 X-Ray，将整个 Mesh 隐藏当成任意轴精确剖切。
5. 用 121 台近似几何的通过率替代 DOM/光照/材质/场景/业务验收。
6. 用 Synthetic FIFO/8 秒随机状态冒充原版 Research 回放/MES/SPC 有效测量。
7. 用原版 Three 页面 iframe、WebGL 备用分支绕过 WebGPU 限制。
8. 将 Next 多 FAB 控制台替换为原版网站首页，或者反向要求整个网站入口 1:1。

---

## 10. 接下来应立即启动的第一轮任务（可直接派发）

**Sprint A — 冻结并复刻 FAB 页面入口**

- [ ] A-01：从 `twin.html` 提取**所有静态与运行时控件**的 ID、文案、默认可见性、事件、CSS 盒尺寸、位置和层级；将原版源码中的 218 个命名函数按“UI/Camera/Scene/Research/Wafer/Industry/Utility”归类，而不是要求 218 个同名函数逐一翻译。
- [ ] A-02：启动原版 **独立参考环境**，锁定种子/相机/主题/语言/时间，采集完整首屏、tour、L1/B1/DUAL、Cut、X-Ray、Research、Wafer、MES/SPC、Wafer Map/Yield 的 Golden 截图/视频及操作序列。
- [ ] A-03：保留当前 Next `original-tool-geometry.ts` 和 WebGPU static shadows，给 121 台实例添加**稳定实例标识与测试映射**；确保后续 React Inspector 不按型号 UUID 混淆多次出现的设备。
- [ ] A-04：新增 `TwinPage.tsx` 与 `twin.css`，首先只复刻 `twin.html` 的 HTML 盒布局/控件外观，不额外设计新 UI；让现有 `SceneFacade` 渲染在中心 Canvas。
- [ ] A-05：建立 `TwinUiState` reducer 与 WebGPU Runtime adapter，接通相机 ISO/Top、层级 L1/B1、模式 visitor/engineer/research 的动作，随后逐项加入完整行为。
- [ ] A-06：通过 React UI 截图差分与真实 WebGPU 像素/交互测试，不关闭未完成项；每次提交存储差分证据。

**Sprint B — 完成最显著交互差异**：相机、五站 Tour、首次引导、L1/B1/DUAL/EXPLODED、连续 Explode、真实 Cut、分类 X-Ray、Aero/HVAC/FFU、人员/OHT 动态行为。  
**Sprint C — 完成科研和制造操作**：Research Replay、Wafer Follow、手动状态/情景、MES/SPC、Wafer Map/Yield、完整检查器与 OEM。  
**Sprint D — 最终验收**：双语/主题/不同视口、截图差分、动画关键帧、60 分钟运行、GPU 设备丢失/重建、许可证及变更审计。

**建议第一条 Agent 指令（可复制）**：

> 只针对原版 `jinjiefan2020/SemiconFab/twin.html` 做页面级 1:1 技术栈迁移到 `iphone2059/SemiconFab-Next` 的现有 `web_app`，最终运行时必须严格使用 React + TypeScript `.ts/.tsx` + Babylon.js `WebGPUEngine`（WebGPU-only），不允许 Three.js、WebGL/fallback、iframe 旧页面，也不要求 Next 主页/其他独立页面对齐。先固定双仓 SHA，建立控件及交互台账和 Golden 截图，再以现有 121 台几何/WebGPU 阴影为基础，按 TWIN-00 至 TWIN-18 顺序逐项实现。每项同时提交源码、单元与浏览器测试、截图/状态差分证据；严禁因按钮存在或编译通过就标记 PARITY_VERIFIED。保持 main 与源数据不被意外破坏。

---

## 11. 工程与法律提示

- 原版 README / LICENSE 标识为 **PolyForm Noncommercial License 1.0.0**。代码和资产复用应遵守其许可；商业部署需要单独核实授权。本规范不构成版权/商用授权意见。
- 原版部分物理模型/尺寸为推断或教学用，不能因像素对齐就标成厂商实测或 SEMI 标准认证。
- 本文是**静态源代码对比后生成的任务规范**。未进行真实浏览器双端联机截图差分/测试，也未替用户修改 GitHub 仓库。所有视觉阈值和性能目标均为建议验收门槛，需要 Golden 基线校准；不应被误写为已通过事实。

**最终交付定义**：在锁定条件下，`twin.html` 的可见元素、三维场景、动画、模式、控制与页面内业务演示均有 Next 对应路径、Golden 证据和差分验收记录，并且 Next 的 3D 前端运行时只有 **React + TS/TSX + Babylon.js WebGPU**。**整个网站首页或其他独立功能入口的 1:1 不属于本项目完成条件。**
