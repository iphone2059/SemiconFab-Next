# SemiconFab-Next — Babylon Lite 原生迁移技术规范与实施计划

**日期**：2026-10-26  
**状态**：实施指南／设计方案；尚未迁移、编译、运行或实测  
**Next 基准**：`iphone2059/SemiconFab-Next@cba42250614f2bbadd1992f6711bb9b6be29e23f` (`main`)  
**Babylon Lite 稳定发布基准**：`@babylonjs/lite@1.36.0`（GitHub tag `npm-lite-v1.36.0`，2026-10-20 发布）  
**Babylon Lite 开发文档核对点**：`BabylonJS/Babylon-Lite@1a2728c6d44383ef3a79cfc680e2e761b4f1e986` (`master`)  
**原版视觉基准**：`jinjiefan2020/SemiconFab@b3666132e5d8cab2cebe4c4227fc04c52242eb28` 的 `twin.html?layout=/twin/layout-default.json&mode=engineer`。

> **核心决策**：彻底改写为 Babylon Lite 的原生数据导向架构。严禁 `@babylonjs/lite-compat`、构建时 import alias、Babylon.js 类名仿真层、WebGL fallback。Lite 已有可满足目标的能力，必须优先调用 Lite API；仅在具备明确缺失证据且不能通过现有 API 组合实现时，才自行编写局部的 TypeScript/WGSL/WebGPU 扩展。

## 0. 官方指南与核对顺序

1. [Babylon Lite Welcome](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/00-welcome.md) — 产品定位、兼容性和风险。
2. [Getting Started](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/01-getting-started.md) — 原生创建、场景、注册、启动。
3. [Native Porting Guide](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/03-porting-guide.md) — **只使用 Native API 表格与代码，忽略兼容层章节**。
4. [Feature Comparison](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/02-feature-comparison.md) — 缺口盘点；注意部分条目比实际 API 更新慢，必须再看源码。
5. [Lite package source](https://github.com/BabylonJS/Babylon-Lite/tree/npm-lite-v1.36.0/packages/babylon-lite/src) — **以目标发布 tag 的 `src/index.ts` 导出与类型定义为准**，不要直接按 `master` 尚未发布的接口开发。
6. [Official release](https://github.com/BabylonJS/Babylon-Lite/releases/tag/npm-lite-v1.36.0)。

## 1. 不可妥协的架构规则

- 前端 UI 继续 React 19 + TypeScript + Redux Toolkit；保留原有 Vite、ASP.NET Core、后端 API 和所有业务协议。
- `/twin` 仍是单 FAB 页面；三个独立 FAB 的后续扩展必须通过 `fabId/siteId` 作用域隔离。不得因换引擎改变领域模型或将三个 FAB 合并成共享状态场景。
- 完全禁止 `@babylonjs/core`、`babylonjs`、`@babylonjs/lite-compat`、Three.js 或 WebGL **出现在最终生产构建的渲染依赖图中**。临时视觉对照要用另一个 Git worktree 或独立启动的旧版站点完成，不共享 Scene 或 GPU 资源。
- 不创建诸如 `BjsScene`、`BabylonMeshBuilder`、`StandardMaterialCompat`、`scene.onBeforeRenderObservable` 仿真工具等迁移捷径。
- 保留应用既有的 `SceneBackend` **领域接口**，它仅传递工具选择、图层、相机、状态与回调，不暴露任何 Babylon.js 或 Lite 类型。它不是引擎兼容层，可保留。
- 场景构造遵循 Lite `createEngine → createSceneContext → addToScene → registerScene/registerSceneWithShadowSupport → startEngine`。Scene 是内容所有者；对象是数据、操作是独立函数。
- 固定数组容量并使用 TypedArray/薄实例/批量 Billboard；避免 121 台设备及 1500 粒子每帧新分配对象、重复构造 Shader/Material 或重复注册资源。
- 场景销毁调用 `stopEngine`、`disposeScene`、`disposeEngine`，同时注销浏览器 DOM 事件、计时器、异步任务及 GPU 特定资源。GPU 丢失恢复优先使用 Lite 的公开机制。
- **对缺失能力单独立项**：逐项记录目标效果、已排查的 Lite API、为什么无法原生实现、最小自实现范围、单测/可视验收与恢复策略。没有该证据记录不得新增底层渲染器。

## 2. 当前 Next 功能基线与 Lite 原生映射

| Next 文件/功能 | 当前 Babylon.js 用法 | Lite 原生策略 | 是否需要新写引擎功能 |
|---|---|---|---|
| `babylon-webgpu.ts` | `WebGPUEngine`、`Scene`、`ArcRotateCamera`、渲染循环 | `createEngine`、`createSceneContext`、`createArcRotateCamera`、`attachControl`、`registerScene`、`startEngine` | 否，重构生命周期 |
| `fab-scene.ts` | `SceneBackend`/facade | 领域接口完全保留，后端实现换成 `createLiteFabBackend()` | 否 |
| `legacy-site.ts` | 全场景总装、楼层/OHT/设施/材质/时钟 | 拆分 Lite scene composition、设施模块、仿真调度；用 `addToScene` 显式注册 | 否，主要是拆分重写 |
| `procedural-fab.ts` | `MeshBuilder`、`TransformNode`、原生材质 | `createBox/Sphere/Cylinder/Plane/Ground/Tube`、`createTransformNode`、`setParent`、`createPbrMaterial/createStandardMaterial` | 否 |
| `original-tool-geometry.ts` | 模板几何、厂商目录几何与线框 | Lite 程序几何；`createLineSystem/createLines`；纯几何数据继续直接复用 | 否 |
| `original-environment.ts` | Canvas 地板纹理、PBR、zone 平面 | `createDynamicTexture`、`updateDynamicTexture`、PBR、场景平面 | 否 |
| `original-roof-hvac.ts` | 3 MAU/5 排气、文本板、70 排气粒子 | Mesh + Lite 动态纹理 / Billboard；逐帧更新最小数据 | 否 |
| `original-facility-architecture.ts` | 两套风淋、玻璃、指示灯和标签 | Lite 材质、Mesh、动态图集、State→render 投影 | 否 |
| `original-subfab-facilities.ts` / `subfab-utilities.ts` | B1 设施、管线、泵站/交叉段 | Lite 几何/层级；重复支架和零件使用 thin instances | 否 |
| `original-exploded-links.ts` | 12 条连接、脉冲环 | Lite Cylinder/Torus、透明/发光材质、状态驱动动画 | 否 |
| `aerodynamics.ts` | 1500 `SpriteManager`/`Sprite` + 热力图 | `createFacingBillboardSystem`、`billboardBlendAdditive`、`addBillboardSpriteIndex/updateBillboardSpriteIndex`；热力图用 Lite 动态纹理 | 否；需要重写调用和布局 |
| `original-patrol-status.ts` | `DynamicTexture` 512×128 状态牌 | 独立 Canvas + `createDynamicTexture/updateDynamicTexture` + billboard/plane | 否 |
| `xray-hologram.ts` | `ShaderMaterial`、共享 WGSL、线段拓扑 | `createShaderMaterial` + Lite `line-list` 拓扑/Line Material；自定义 uniform、sampler | 基础 X-Ray 否；精准阴影耦合需证明 |
| `original-lighting.ts` | `MaterialPluginBase` 对生成 WGSL 进行正则替换 | Lite `enableMaterialPlugins` + 标准插槽；确实无法表达的距离衰减、Gamma/Fog 写为独立 WGSL 着色方案 | **可能需要局部 WGSL** |
| `native-shadow-material.ts` | 自定义 `CUSTOM_LIGHT0_COLOR` + Depth PCF | **先**使用 Lite PBR/Standard 自带阴影插件与 PCF/CSM；对比不达标且无插入点时才专门改写材质 Shader | **可能需要局部 WGSL** |
| `native-static-shadows.ts` | `_device`、`wrapWebGPUTexture`、2048² `depth32float` 自建缓存 | **先**用 `createPcfDirectionalShadowGenerator`/`createCsmDirectionalShadowGenerator` + `enableCsmStaticCache` + `setShadowTaskCasterMeshes` | 仅在行为无法满足时补自定义缓存 Pass |
| GPU 丢失 | `_device`、`_rebuildGeometries`、Babylon 生命周期 | `enableDeviceLostSceneRecovery` + Lite 场景重建；用 `forceWebGpuDeviceLossForTesting` 测试 | 自有 GPU 扩展需写恢复钩子 |
| `twin-page.tsx` 等 React 页面 | UI/控件 | 保留 Redux 与业务事件；只换掉 SceneBackend 具体实现 | 否 |

**当前领域特征**：121 台设备（117 个模板实例与 4 个目录模型）、24 辆 OHT、6 名人员、12 条 Exploded 连接、1500 个气流 Sprite；另有 Roof/HVAC、B1 管线、X-Ray、Cut、Tour、Wafer、研究回放、MES/SPC/YMS 等模式。所有数值必须从现有源代码或原版 fixture 读取，不能因迁移重新随机布局。

## 3. 目标目录结构（推荐）

```text
web_app/src/
  fab-scene.ts                     # 应用领域 SceneBackend 接口（保留）
  fab-layout.ts                    # 纯设备布局（保留）
  personnel-timeline.ts            # 纯确定性时序（保留）
  amhs-timeline.ts                 # 纯时序（保留）
  twin-spatial.ts                  # 纯展开系数/空间公式（保留）
  render/
    lite/
      runtime.ts                   # createEngine / register / start / stop / dispose
      fab-backend.ts               # 唯一 SceneBackend 实现，处理调用入口
      fab-world.ts                 # 场景装配；分模块注册
      scene-entities.ts            # ToolId、FabId 与 Lite mesh/instance 索引
      camera.ts                    # 原生 ArcRotateCamera 与视角/动画
      picking.ts                   # GPU Picker + identity 回映射 + 节流
      resources.ts                 # 纹理/材质/图集/销毁所有权清单
      frame-updates.ts             # deltaMs -> 固定 16 ms 业务 tick -> 最小 GPU 更新
      materials/
        factory.ts                 # PBR / Standard / Line / Shader Material
        original-lighting.ts      # 优先 Material Plugin，必要的 WGSL 附件
        xray.ts                   # 唯一 X-Ray WGSL 程序
      geometry/
        tool-families.ts          # 8 模板与 4 目录模型
        static-structure.ts       # L1/B1/墙柱/地板/屋顶
        meshlines.ts              # Lite native Line System
      facilities/
        oht.ts
        ffu.ts
        roof-hvac.ts
        airshower.ts
        subfab.ts
        exploded-links.ts
      effects/
        airflow.ts                # 批量 Billboard + 确定性粒子状态
        heatmap.ts                # Canvas / DynamicTexture
        labels.ts                 # Canvas + Lite 原生纹理
      shadows/
        native-lite-shadow.ts     # Lite 原生 PCF/CSM/缓存组织
      diagnostics/
        gpu-timing.ts
        device-lost.ts
        scene-counters.ts
      extensions/                  # 仅审核认定的 Lite 真正功能缺口
        README.md                 # 缺失证据、设计与测试
        legacy-lighting.wgsl.ts   # 如确有必要
        shadow-bridge.wgsl.ts     # 如确有必要
```

**注意**：文件目录是建议组织方式，不代表要为每个文件再造一个 Lite 包装类。实现必须直接使用 Lite 公共导出。除现存业务 `SceneBackend` 外，不定义 Babylon.js 风格的跨引擎抽象。

## 4. 原生启动示例（API 基于 v1.36.0）

```ts
import {
  createEngine, createSceneContext, createArcRotateCamera, attachControl,
  createHemisphericLight, createBox, createPbrMaterial,
  addToScene, registerScene, startEngine, stopEngine,
  disposeScene, disposeEngine, enableDeviceLostSceneRecovery,
} from '@babylonjs/lite';

export async function mountLiteSandbox(canvas: HTMLCanvasElement) {
  const engine = await createEngine(canvas);
  // 在创建场景资源前启用按需 GPU 恢复：测试完整场景时再接回调与状态机。
  const recovery = enableDeviceLostSceneRecovery(engine, {
    onLost: () => console.warn('WebGPU device lost'),
    onRecovered: () => console.info('WebGPU recovered'),
    onRecoveryFailed: (error) => console.error(error),
  });
  const scene = createSceneContext(engine);
  const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 8, { x: 0, y: 0, z: 0 });
  scene.camera = camera;
  attachControl(camera, canvas, scene);
  addToScene(scene, createHemisphericLight([0, 1, 0], 1));
  const box = createBox(engine, { size: 2 });
  box.material = createPbrMaterial({
    baseColorFactor: [0.2, 0.7, 0.9, 1],
    metallicFactor: 0.1,
    roughnessFactor: 0.55,
  });
  addToScene(scene, box);
  await registerScene(scene);
  await startEngine(engine);
  return () => {
    stopEngine(engine);
    recovery.disable();
    disposeScene(scene);
    disposeEngine(engine);
  };
}
```

这个示例只验证 **Lite 原生生命周期**，不是 SemiconFab 产品代码；尚未在此环境中编译执行。真实工程应使用 AbortSignal、幂等销毁、异步代际隔离和首帧成功确认，不要在组件卸载后继续更新 GPU。

### 动态纹理（无需自写渲染功能）

```ts
import { createDynamicTexture, updateDynamicTexture } from '@babylonjs/lite';
// engine 是 Lite EngineContext
const canvas = document.createElement('canvas');
canvas.width = 512;
canvas.height = 128;
const ctx = canvas.getContext('2d')!;
const labelTexture = createDynamicTexture(engine, 512, 128, { srgb: true });
ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, 512, 128);
ctx.fillStyle = '#ffffff'; ctx.fillText('FAB STATUS', 24, 60);
updateDynamicTexture(engine, labelTexture, canvas);
```

**不要**为了旧 Babylon `DynamicTexture.getContext()` 而开发同名接口。Canvas/Context 本来就应该由应用持有，Texture 由 Lite 管理。`srgb`、`invertY`、alpha/预乘色与旧原版截图必须分别验证。

### 1500 个气流 Sprite（无需自写 GPU SpriteRenderer）

使用官方 `createFacingBillboardSystem(atlas, { capacity: 1500, blendMode: billboardBlendAdditive })`、`addBillboardSpriteIndex(system, { position, sizeWorld, color, visible })`、`updateBillboardSpriteIndex(...)` 与 `addFacingBillboardSystem(scene, system)`。Atlas 用 `createGridSpriteAtlas` 或 `loadSpriteAtlas` 创建，精确接口以 v1.36.0 的公开声明为准。粒子的随机序列和 `advanceLaminarParticle()` 保持原逻辑；更新适当脏区，避免每帧重建系统/图集。

### 重复静态几何（优先 Thin Instances）

使用 `setThinInstances(mesh, Float32Array, count)`，一台同款模板一个几何源；按 **几何+材质+渲染状态**分组，不按设备名称分组。相同的盒子/柱子/FFU 等优先共享几何和材质。每个实例在 CPU 保存 `toolId ↔ (meshGroup, instanceIndex)` 映射，Picking 必须返回稳定的原始 ToolId，不得用重排后的数组下标替代设备身份。动态变换使用 Lite 支持的局部实例矩阵更新与必要的批量上传。

## 5. 阴影的强制决策顺序

1. 先用 Lite **`createPcfDirectionalShadowGenerator`**、**`createEsmDirectionalShadowGenerator`** 或 **`createCsmDirectionalShadowGenerator`** 建一个等价最小场景；为真实需求选型，不预设替换算法。
2. 用 `setShadowTaskCasterMeshes` 明确 caster 集合（当前主要为静态设备及厂房部件），通过 `registerSceneWithShadowSupport` 注册，避免手写独立 RenderPass。
3. 如果使用 CSM，先验证原生 **`enableCsmStaticCache`** 与模型几何/材质变化后的缓存失效，再考虑自实现缓存。
4. 验证 2048² 采样、阴影范围、接触边界、主光直射项、X-Ray 统一阴影、X-Ray/Cut/层变换、关光后阴影消失、视角切换不发生错误重建。
5. 若 native 方案无法在合理参数下满足原版目标，必须提交 `LITE-GAP-SHADOW-001` 缺失证据，再考虑用 Lite **`createRenderShader` / `createRenderDrawTask` / Frame Graph Task / ShaderMaterial** 组合构造独立阴影通道；能通过公开渲染 API 实现时仍不得直接修改 Lite 源码。
6. 最后才考虑手写 GPUTexture、GPUCommandEncoder 或 GPUDevice 集成，且只放在 `render/lite/extensions/`，明确该资源的初始化、销毁、resize、恢复与 Debug 标记。

**已知特别限制**：在核对的 v1.36 文档里，Lite 的设备丢失自动恢复支持 directional ESM / CSM，但 **PCF shadow generator 的恢复仍明确标记不支持**。这不是说 PCF 阴影无法绘制；而是选择 PCF 必须另行解决失效恢复，或改用可恢复的原生阴影方案。在决定做专用 PCF 之前要以锁定版本实际测试为准。

## 6. `OriginalLegacyLightFalloff` 的严格迁移规则

现有代码使用 Babylon 9 的正则 WGSL 片段替换 `toGammaSpace`、Fog、Range Falloff 与 Spot Falloff。Lite `MaterialPlugin` 只提供明确定义的注入点，如 `CUSTOM_FRAGMENT_DEFINITIONS`、`CUSTOM_FRAGMENT_BEFORE_LIGHTS`、`CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION`、`CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR`。

实施次序：

1. 先用 Lite `createPbrMaterial`/`createStandardMaterial` 的公开光照/雾效/色彩配置获得最佳匹配，固定原始色彩空间与曝光参数。
2. 可在官方插件插槽表达的改动用 `enableMaterialPlugins` + `material.plugins`。不要实现正则替换器，也不要 fork Lite WGSL 模板。
3. 若 **仅某个特定光源** 的漫反射/镜面反射乘法无法通过现有插槽表达，则该行为确为迁移缺口；用专用 WGSL `createShaderMaterial` 或可控 Frame Graph 路径，只对必要材质/模式启用。必须证明其他光源、环境光、发光项不被错误遮暗。
4. 对相机/光源/透明材质/X-Ray 的金色参考图做同环境像素差异对照。不允许通过牺牲阴影准确性来换 FPS。

## 7. 推荐 12 阶段实施顺序及每阶段验收

| 阶段 | 工作包（建议独立提交/PR） | 阶段准入/完成门禁 |
|---|---|---|
| P0 | 固定旧 Next、原版、Lite v1.36 三项 SHA/版本；保存样例数据与自动化测试 | 现有所有测试与 Golden 基线可重复执行；未经验证的项目明确标注 |
| P1 | 新建 `feat/twin-babylon-lite-native`；建立 `render/lite/`；引入 `@babylonjs/lite` **精确版本** | WebGPU、Engine/Scene 创建和销毁、设备丢失回调成功；无 compat |
| P2 | 迁移静态几何和坐标系：121 机台、地板、区带、墙、FFU、柱、B1 | 实际矩阵/包围盒、颜色、选中身份与既有 fixtures 对照 |
| P3 | 重写 `SceneBackend` Lite 具体实现及相机、resize、拾取、悬停 | 视角预设/滚轮/聚焦、原 ToolId 与设备卡片匹配；DOM 不回归 |
| P4 | 原生 PBR/Standard/贴图/Light；试验官方 material plugin | L1/Top/ISO 摄影条件稳定，固定材质/透明度图对比 |
| P5 | 优先 Lite 原生阴影及静态缓存；判断是否真有缺口 | 投射/遮挡/失效/恢复测试，GPU validation errors = 0 |
| P6 | OHT 24 辆、轨道、6 人与确定性时钟 | 固定 Tick/seed 轨迹、手动相机不因 Tour 异常归位 |
| P7 | 1500 Sprite、热力图、Roof/HVAC 70 粒子、风淋与标签 | 粒子位置/颜色、图层开关、标签语言、内存生命周期 |
| P8 | L1/B1/DUAL/Exploded 0/50/100%、12 连接、Cut/X-Ray 六过滤器 | 每种组合完整、没有悬空 GPU 资源或错误显隐 |
| P9 | Wafer/Tour/Research、MES/SPC/YMS、SSE/Redux 接入 | 状态权威来源不变，不新增第二套仿真时钟 |
| P10 | 进行 Lite 特有的数据导向性能优化：共享几何、Thin Instances、批量 Sprite、GPU Timing | 有同机 A/B 基准；FPS、p95 CPU/GPU 时间、Draw Calls、堆/显存均有记录 |
| P11 | 删除所有 Babylon 旧依赖、兼容 shim、旧生命周期与无用文件 | 禁用依赖零命中、锁文件无 core/compat、生产包无旧引擎代码 |

**不可先做的事**：不要在 P2 就全局移除旧包导致无法分模块回归；不要为了先看到图而把旧 Babylon 类封装成 Lite 代理；不要先实施自定义阴影再测试 Lite 原生阴影；不要把原本 121 台身份“优化”为无法选中的一个 Mesh；不要在视觉基线通过前同时更换模型、布局、数据随机序列和新材质风格。

## 8. 最终验证矩阵

### 静态事实

- 原版布局 121/121 identity、位置、方向、实际世界包围盒与既有 fixture 一致；8 个模板族和 4 个目录模型的结构与部件颜色无遗漏。
- 保留 24 OHT、6 人、12 条 B1↔L1 连接；当前单 FAB 的全部模式、控件与行为不减少。
- 没有 glTF/GLB 加载器也是当前项目的既有约束；不得为迁移无故引入。

### 场景矩阵

- 视角：ISO、Top、Litho、OHT、Airshower、Etch、Focus、Reset。
- 楼层：L1、B1、DUAL、Exploded 0/50/100%；反复进入退出。
- 视觉：Roof/FFU/Subfab、Cut XYZ 与 invert、X-Ray 六过滤器、热力图、气流、巡检/风淋、OHT、Research/Tour/Wafer。
- UI：中/英、隐藏/显示各种层、设备 Picking/悬停、Modal/键盘、视角过渡，窗口 resize 与 DPI。
- 完整生命周期：挂载→卸载→重挂载，快速切换 SiteId，Abort 后无事件、Promise、GPU 资源泄漏。
- GPU：至少 3 次连续设备丢失/恢复，恢复后完整场景和用户视角，连续运行 60 分钟；GPU validation/errors 为 0。若某阴影算法在该版本无法可靠恢复，必须变更方案或明确阻止发布。

### 性能实验与接受口径

现有 **历史 Headless Chrome 155 / NVIDIA Ampere** 基线：Idle 21.9 FPS、1,670 Draw Calls；Orbit 19.9 FPS、1,688 Draw Calls；约 189,534 顶点。仅作为旧证据，不能与不同硬件/分辨率的 Lite 结果直接比较。

必须在**同一台可见浏览器、同一 GPU/驱动、同一 Chrome/Edge 构建、同一分辨率/DPR、同一固定时钟、相同开关和同一场景资产**下交错测试 Babylon.js 与 Lite：

- 记录 FPS、RAF p50/p95/p99、Main Thread JS + React Commit、GPU Pass Timing、Draw Calls、活跃对象数、JS Heap、GPU 资源与加载体积。
- 分别测试 Idle、Orbit、Picking、Exploded、B1/DUAL、Roof+FFU、X-Ray、Airflow 1500 开启、设备状态频繁更新。
- 不把官方 3–4× RAF CPU 提升当作 Next 保证；性能结果应该由真实 FAB 帧数据证明。
- 视觉比较有 **双参考**：当前 Babylon 版本用于迁移防回归，冻结原版 Three.js 用于产品最终对齐。现有 Golden 尚未全部通过，因此不可借迁移直接宣布 1:1。
- 输出跨浏览器崩溃/画面差异报告，给未通过情形留下明确修复单。自定义扩展必须有集成测试和独立 GPU 恢复测试。

## 9. Windows / PowerShell 操作顺序（命令尽量单行）

```powershell
git fetch origin main
git switch main
git pull --ff-only origin main
git switch -c feat/twin-babylon-lite-native
cd web_app
corepack pnpm add -E @babylonjs/lite@1.36.0
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

**注意**：在重写所有 3D 模块之前，临时分支可能仍引用 Babylon.js，`typecheck` 只作为阶段性观察，不应假称迁移已完成。旧 Next 完整视觉对照应在另一个 worktree 运行；新渲染代码路径从 P1 起不得 import `@babylonjs/core`。版本 1.36.0 是已核实的最新官方 GitHub Release（2026-10-20）；不要直接把开发分支 `master` 的 API 当成已发布 API。

在全部模块替换完毕后：

```powershell
cd web_app
corepack pnpm remove @babylonjs/core
corepack pnpm install --frozen-lockfile
rg -n '@babylonjs/core|@babylonjs/lite-compat|from .babylonjs.|WebGPUEngine|_rebuildGeometries|wrapWebGPUTexture' src
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
cd ..
pwsh -File scripts/verify.ps1
```

`rg` 在此是**禁用项人工检查**，预期结果为零匹配、进程退出码 1。正式 CI 中应实现一个专用 `assert-no-legacy-renderer` 扫描脚本，禁止来自最终生产依赖图的 `@babylonjs/core`/`lite-compat`，并检查 lockfile/Vite 的 alias 和插件。旧对照引用仅可留在明确隔离的文档/测试夹具中。

## 10. AI Agent 严格执行约束

1. 只能在隔离分支提交。**未经明确要求不得修改 `main`**；不得从原版仓库篡改参考文件。
2. 先读上述 Lite **release tag** 文档、`src/index.ts`、必要的源实现和 Next 当前模块；用 `API_MIGRATION_MATRIX.md` 一条条列出原调用与公开 Lite 函数。
3. 每次迁移一个有界模块，提交可追溯变更；每步报告编译、单测、浏览器运行和实际 GPU 验收，不得根据静态阅读宣称“测试通过”。
4. 若原生 API 不能满足语义，先尝试组合官方 `MaterialPlugin`、`ShaderMaterial`、`FrameGraph`、`RenderShader`、Billboard、Shadow Generator，不得绕到兼容层。
5. 只有具备 `LITE_GAP.md` 证据的缺口可进入 `render/lite/extensions`；一旦官方补齐公开 API，应删除自实现。
6. 原有 Next React/Redux/ASP.NET Core、业务模型、协议、121 稳定 ToolId、确定性时钟和许可归属必须保留。原版使用 PolyForm Noncommercial 1.0.0；现有原版素材署名/许可通知不得因移动文件消失。
7. 将全部接受结果分为 `PASS`、`FAIL`、`NOT_RUN`、`BLOCKED`、`REVIEW_REQUIRED`；没有本机 GPU/浏览器时只可报告 `NOT_RUN`，不能猜测。
8. 最后必须提供：变更文件列表、按阶段提交记录、完整构建/测试输出、前后性能对照、截图差异、所有自实现缺口文档和最新 ZIP 或 GitHub 分支链接（需核实真正存在）。

## 11. 推荐交付文件

```text
docs/migration/babylon-lite/
  MIGRATION_PLAN.md              # 本指南，经实现追踪更新
  API_MIGRATION_MATRIX.md        # Legacy API ↔ 原生 Lite API
  FEATURE_GAPS.md                # 有源证据的缺失与自实现评审
  SHADOW_DECISION.md             # 原生 ESM/PCF/CSM 选择及像素/GPU 证据
  GOLDEN_RESULTS.md              # 原版+Next+Lite 三方对比
  PERFORMANCE_RESULTS.md         # 相同硬件/场景 A/B 数据
  DEVICE_LOST_RESULTS.md         # 3 次重建与 60min 检验
  RELEASE_CHECKLIST.md           # 禁止项/构建/行为/性能/许可
```

### 官方链接

- [Babylon Lite GitHub](https://github.com/BabylonJS/Babylon-Lite)
- [官方迁移指南](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/03-porting-guide.md)
- [官方功能矩阵](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/02-feature-comparison.md)
- [Material Plugin](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/architecture/26-material-plugin.md)
- [Shadows](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/architecture/16-shadow-generator.md)
- [Sprites](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/architecture/32-sprites.md)
- [Frame Graph](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/architecture/28-frame-graph.md)
- [Device Lost Recovery](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/architecture/50-device-lost-recovery.md)

**最终结论**：技术上可以设计成完全纯 Lite 的 Next 渲染层，而不增加任何 Babylon.js 兼容包。最大难点是与冻结 Three.js 参考相匹配的精确光照/阴影/色彩行为以及可靠 GPU 恢复，并非基础 Mesh、PBR、纹理、Sprite 或 Picking 缺失。只有经过真实 GPU 验收，才可判定这条迁移路径成功。
