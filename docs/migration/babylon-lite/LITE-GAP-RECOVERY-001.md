# LITE-GAP-RECOVERY-001 — 薄实例旧设备缓存

版本固定为 `@babylonjs/lite@1.36.0` / `5241e29f5a88ff23534a11d3114ac8ea983c5961`。范围：P2a 设备夹具，非全部 Lite 功能的缺陷结论。

## 证据与原生 API 排查

- 121 个布局实例组成 51 个批次、936 个零件实例，首帧可绘制。强制 device loss 后收到 `thin-instance-matrices` 属于旧 Device、不能用于新 Device 的 validation error；见 [GPU RED](./evidence/p2-equipment-browser-red.txt)。
- 安装包 `lib/engine/recovery-rebuild.js::_rebuildMeshes` 重建 geometry/skeleton/morph，但不重置 `mesh.thinInstances`。`lib/mesh/thin-instance-gpu.js::syncThinInstanceGpuData` 复用已缓存的 buffer；`setThinInstances` 更新已有状态的版本，单独调用不会重新建立设备所有权。
- `lib/engine/device-lost-recovery.js` 先同步调用 `onLost`，再异步 import 恢复模块。若只在回调中重置实例状态，旧 RAF 可能在原生 `stopEngine` 之前再次绘制，重新填入旧设备 buffer。初次成功后复跑暴露此竞争。

## 最小处理与所有权

1. runtime 在 `onLost` 中同步 `stopEngine`，再通知资源所有者。
2. 设备模块的 `prepareForDeviceRecovery()` 保留公开的 matrices/count/colors，把公开 `mesh.thinInstances` 数据槽置空，再调用 `setThinInstances` / `setThinInstanceColors`；不读写私有 GPU 字段。
3. 继续使用 `enableDeviceLostSceneRecovery` 完成原生设备/场景重建。由于应用已经停止循环，native 不自动重启；runtime 重启并等待首帧与 `waitForGpuIdle` 后报告 ready。
4. 若初始化等待期间再次丢失，保留同一个未结束的恢复 Promise，只有最新代际完成后才解除等待。卸载和失败仍由原生恢复结束后释放 scene/engine。

这是对公开数据和应用生命周期的组合处理，不需要 `extensions/`、独立 RenderPass、GPUDevice 包装或修改 Lite。若后续 Lite 发布修复缓存失效，应先复验本案例，再移除此重置。

## 验证与限制

- 生命周期“停止旧帧后再通知”和“替换 RAF 前连续丢失”两项测试均 RED→GREEN；最终生命周期 19 项、前端总计 213 项通过。
- 构建后的 Lite 夹具在 Chrome 155 / NVIDIA Ampere 上三次设备丢失恢复、身份映射、卸载和重挂载通过；GPU/console 错误 0。见 [GPU GREEN](./evidence/p2-equipment-browser.json)。
- 60 分钟内存、复杂动态图层、完整 FAB 恢复及其他浏览器仍未运行；不推断这些门禁已经通过。
