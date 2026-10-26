# 原生 API 迁移矩阵

核对版本：`@babylonjs/lite@1.36.0` / `5241e29f5a88ff23534a11d3114ac8ea983c5961`。以安装包公开 `index.d.ts` 和相同 release tag 源码为准。

| 当前调用/约束 | 公开 Lite API | P1 实现及证据 |
|---|---|---|
| `WebGPUEngine` / `initAsync` | `createEngine(canvas)` | `runtime.ts`；中止后等 GPU 创建完成再销毁，不创建下一阶段资源。 |
| `new Scene(engine)` | `createSceneContext(engine)` / `addToScene` | composition 参数直接传原生数据；测试场景的几何、光源显式注册。 |
| Scene/材质延迟编译 | `registerScene(scene)` | 中止时等注册 Promise 完成再释放，避免编译与销毁竞争。 |
| `runRenderLoop` / 首帧成功 | `startEngine` / `waitForGpuIdle` | 只有首帧已提交且 GPU 队列完成后报告 ready；首帧 RAF 可取消等待，不等待一个被 stop 取消后永不 resolve 的 Promise。 |
| device lost / 私有设备恢复 | `enableDeviceLostSceneRecovery`、`stopEngine`、`startEngine`、`waitForGpuIdle` | 创建资源前启用捕获；丢失时先停止旧 RAF，再通知资源所有者；原生重建后由 runtime 重启并确认 GPU 完成；重叠丢失共用未结束的等待边界。 |
| 强制测试 GPU 丢失 | `forceWebGpuDeviceLossForTesting` | 只在 `tests/lite-runtime/main.ts` 中调用；真实 GPU 三次恢复测试。 |
| `ArcRotateCamera.attachControl` | `createArcRotateCamera` / `attachControl` | 测试 composition 返回 attachControl 的 disposer；生产相机/预设迁移属于 P3。 |
| `engine.resize` | `resizeEngine`（由 Lite 帧循环原生调用） | CDP 改变 viewport 后验证 backing size 为 1024×640。 |
| 场景/设备清理 | `stopEngine` → recovery.disable → controls disposer → `disposeScene` → `disposeEngine` | 幂等、失败清理、预中止、初始化中止、恢复失败；单测与真实 GPU 卸载/重挂载。 |
| 私有设备 validation listener | `onEngineGpuError` | 测试页使用公开 API 收集 GPU 错误，不读取 `_device`。 |
| 121 台设备的模板/目录几何 | `createBox`、`createCylinder`、`createTransformNode`、`setParent`、`createLineSystem` | P2a `geometry/tool-families.ts`；八类模板和四个目录模型，真实顶点及包围盒对照 frozen fixture。`setParent` 保持 world TRS，组装局部零件后显式还原局部旋转/缩放。 |
| 每零件 Mesh / 设备身份 | `setThinInstances`、现有 `TWIN_LAYOUT_IDENTITIES` | 按几何+材质分为 51 批；CPU 保存 `(mesh, instanceIndex) → 121 个独立 placement identity`，保留重复 recordId。GPU picker 尚属 P3。 |
| 设备 PBR/状态灯 | `createPbrMaterial`、`setPbrEmissive` | 保留基色/透明度/金属度/粗糙度；材质共享。只通过数据/几何门禁，完整光照视觉属于 P4。 |
| 薄实例设备恢复 | 公开 `mesh.thinInstances` 数据槽、`setThinInstances`、`setThinInstanceColors` | 旧 RAF 停止后丢弃旧实例状态并重建，避免 Lite 1.36 保留旧设备缓存；构建后真实 GPU 三次恢复通过。见 [缺口证据](./LITE-GAP-RECOVERY-001.md)。 |
| 厂房 L1/墙柱/区带/FFU/B1 | `createMeshFromData`、`createLineSystem`、`setThinInstances`、`decomposeMat4` | P2b 离线保留原顶点/法线/UV/索引与完整矩阵；1648 部件、396 批。透明 Mesh 自身持有世界变换，保留原生排序中心。没有旧引擎运行依赖。 |
| 地板穿孔纹理/重复 UV | `createDynamicTexture`、`updateDynamicTexture`、`setTextureTransform`、`enableMaterialUvTransform` | 两张 512² 线性纹理、10 mip，原 Canvas2D 配方，95×70 / 28×60 重复；creator 引用单独释放，含上传失败清理。 |
| B1 显隐/展开/灯 | `createTransformNode`、`setParent`、`setSubtreeVisible`、`createPointLight` | shell/FFU/B1 独立根；B1 灯不随 Mesh 隐藏，随 B1 offset 移动。10 盏灯的位置/颜色/范围/强度保留，legacyDecay 输入保留在 metadata，精确光照仍属 P4。 |
| 原生 PBR 折射依赖 | `setPbrTransmission`、`loadHdrEnvironment` | 1.36 折射片段依赖 IBL；通过全黑 RGBE 和官方 loader 提供，environmentIntensity=0，恢复 loader 修改的 imageProcessing。无自实现 shader。见 [原生能力记录](./FEATURE_GAPS.md)。 |
| 异步初始化/注册前丢失 | 等待 compose Promise、AbortSignal、原生恢复回调 | 不在上传未结束时释放设备；注册前丢失终止本次挂载，等待 composition/recovery 都结束再清理，禁止注册旧设备资源。 |
| 产品拾取/阴影/粒子 | 见指南完整模块映射 | P3–P10 尚未实施；静态预览不替代完整产品验收。 |

已阅读的官方 release 资料：[Welcome](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/00-welcome.md)、[Getting Started](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/01-getting-started.md)、[Native Porting Guide](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/03-porting-guide.md)、[Device Lost Recovery](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/architecture/50-device-lost-recovery.md)、[public exports](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/packages/babylon-lite/src/index.ts)。实现时另查了安装包 `engine.js` 的 start/stop/resize 和 `scene-core.js` 的 deferred register/dispose 所有权。
