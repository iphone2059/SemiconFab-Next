# 原生 API 迁移矩阵

核对版本：`@babylonjs/lite@1.36.0` / `5241e29f5a88ff23534a11d3114ac8ea983c5961`。以安装包公开 `index.d.ts` 和相同 release tag 源码为准。

| 当前调用/约束 | 公开 Lite API | P1 实现及证据 |
|---|---|---|
| `WebGPUEngine` / `initAsync` | `createEngine(canvas)` | `runtime.ts`；中止后等 GPU 创建完成再销毁，不创建下一阶段资源。 |
| `new Scene(engine)` | `createSceneContext(engine)` / `addToScene` | composition 参数直接传原生数据；测试场景的几何、光源显式注册。 |
| Scene/材质延迟编译 | `registerScene(scene)` | 中止时等注册 Promise 完成再释放，避免编译与销毁竞争。 |
| `runRenderLoop` / 首帧成功 | `startEngine` / `waitForGpuIdle` | 只有首帧已提交且 GPU 队列完成后报告 ready；首帧 RAF 可取消等待，不等待一个被 stop 取消后永不 resolve 的 Promise。 |
| device lost / 私有设备恢复 | `enableDeviceLostSceneRecovery` | 创建资源前启用捕获；原生回调转为 lost/ready/failed；销毁后抑制迟到回调。 |
| 强制测试 GPU 丢失 | `forceWebGpuDeviceLossForTesting` | 只在 `tests/lite-runtime/main.ts` 中调用；真实 GPU 三次恢复测试。 |
| `ArcRotateCamera.attachControl` | `createArcRotateCamera` / `attachControl` | 测试 composition 返回 attachControl 的 disposer；生产相机/预设迁移属于 P3。 |
| `engine.resize` | `resizeEngine`（由 Lite 帧循环原生调用） | CDP 改变 viewport 后验证 backing size 为 1024×640。 |
| 场景/设备清理 | `stopEngine` → recovery.disable → controls disposer → `disposeScene` → `disposeEngine` | 幂等、失败清理、预中止、初始化中止、恢复失败；单测与真实 GPU 卸载/重挂载。 |
| 私有设备 validation listener | `onEngineGpuError` | 测试页使用公开 API 收集 GPU 错误，不读取 `_device`。 |
| 121 台几何/材质/拾取/阴影/粒子 | 见指南完整模块映射 | P2–P10 尚未实施，不以 P1 cube 替代产品验收。 |

已阅读的官方 release 资料：[Welcome](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/00-welcome.md)、[Getting Started](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/01-getting-started.md)、[Native Porting Guide](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/03-porting-guide.md)、[Device Lost Recovery](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/docs/lite/architecture/50-device-lost-recovery.md)、[public exports](https://github.com/BabylonJS/Babylon-Lite/blob/npm-lite-v1.36.0/packages/babylon-lite/src/index.ts)。实现时另查了安装包 `engine.js` 的 start/stop/resize 和 `scene-core.js` 的 deferred register/dispose 所有权。
