# Next 布局投影修复

2026-10-26。范围为独立 Lite 预览的机台/黄光区空间位置、相机与楼层状态；完整材质光照、阴影、动态对象及产品交互仍为 `NOT_PARITY_VERIFIED`。

## 设备定义继续使用 TypeScript

设备清单保留 [`FAB_LAYOUT: readonly FabLayoutTool[]`](../../../web_app/src/fab-layout.ts)，不新增或转换为设备 JSON。

- `fab-layout.ts`：121 个放置项的坐标、朝向、类别、型号及标称尺寸。
- `original-tool-parts.ts`：沿用 Next 的具体几何零件、颜色和材质输入。draft 的标称尺寸是检查器标签，不能用来覆盖原来的分类轮廓尺寸。
- `layout-identities.ts`：独立放置身份，重复 `recordId` 不合并。
- `render/lite/geometry/tool-families.ts`：一次创建全部 121 台设备，按几何与材质组合为 51 批、936 个零件实例。

已有 `assets/lite-static-structure.json` 仅是 P2b 厂房结构的冻结提取资产；本修复未改动它，也未引入设备布局 JSON。12 个冻结源码/fixture 散列保持不变。

## 根因与修复

此前 CPU 单测只证明源矩阵/几何数据一致，无法证明实际屏幕位置一致。实际 Next 与 Lite 同视口比较发现：Next 使用右手坐标，Lite 原生相机使用左手坐标；预览还使用了另一套远景相机。原 ISO 的最大屏幕边界差异为 **458.342188 px**，不能据旧 P2 测试宣称显示布局已对齐。

`next-coordinate-frame.ts` 在渲染边界统一反射 Z，保持所有 TS 领域坐标不变。相机位置和目标同时转换，视角/FOV/裁剪面取自 `babylon-webgpu.ts:setView` 与 `twin-page.tsx:flyLevel`，使用公开 `enableMirroredMeshes` 处理镜像后的面朝向。设备、静态根和 B1 灯使用同一转换框架。

楼层切换按照 `legacy-site.ts:syncLevel`：B1/DUAL 保留 L1 设备，地板 alpha 分别为 0.2/0.35，隐藏楼板；DUAL 的 B1 位移为 0。下移 18 米属于爆炸展开。动态地板使用普通 Mesh，使透明排序读取真实世界位置；alphaBlend 改变后调用原生 `rebuildMaterial`。

预览新增 ISO/TOP 按钮。composition 统一捕获几何创建、镜像启用和环境加载错误，清理纹理及控制监听，覆盖此前记录的同步失败监听清理缺口。

## 实际浏览器对照

参考是 `0b35ca5` 独立 worktree 的真实 Next WebGPU 场景，使用同一个 Chrome、1536×735、DPR 1、确定性时钟。测试读取两边实际运行场景的全部顶点和最终变换/相机矩阵，按放置身份逐台比较屏幕边界；另比较黄光地面 `native-zone-0` 与 55 块 `original-amber-panel-*`，以及源地板透明度、楼板状态。

| 视角 | 机台 / 黄光对象 | 最大边界误差 px |
|---|---|---|
| ISO | 121 / 56 | 0.000021 |
| TOP | 121 / 56 | 0.000004 |
| L1 | 121 / 56 | 0.000006 |
| B1 | 121 / 56 | 0.000025 |
| DUAL | 121 / 56 | 0.000011 |

门槛为每个对象 0.1 px。[修复前失败](./evidence/layout-red.txt)、[楼层状态失败](./evidence/layout-level-red.txt)、[五视角运行记录](./evidence/layout-browser.json)。截图：[Next ISO](./evidence/layout-next-iso.png)、[Lite ISO](./evidence/layout-lite-iso.png)、[Next TOP](./evidence/layout-next-top.png)、[Lite TOP](./evidence/layout-lite-top.png)。

这些结果证明被比较对象的空间投影和楼层状态一致，**不是整张截图的像素相等**。当前 Lite 预览仍明显过亮，缺少源照明/阴影及后续动态模块；不能将这项空间回归当作完整外观或产品迁移验收。

## 验证与审查

- 完整仓库：Python 16、.NET 67、前端 223 通过；三项 Release 构建、typecheck、冻结锁文件安装与产品 build 通过。[输出](./evidence/layout-verify.txt)
- 原 12 文件散列未变化；8 组原版向量/翻译检查通过。[输出](./evidence/layout-frozen-vectors.txt)
- 构建后硬件 P1、设备、结构三组通过，各自三次设备恢复，GPU/console 错误 0。[P1](./evidence/layout-runtime-browser.json)、[设备](./evidence/layout-equipment-browser.json)、[结构](./evidence/layout-static-browser.json)
- 独立审查未发现 Critical/Important。发现快速切 B1→DUAL 时旧材质重建完成会覆盖新相机的 Minor，真实浏览器先失败后修复：相机在 await 前同步切换。[失败](./evidence/layout-race-red.txt)、修复后由结构硬件回归覆盖。审查独立检查了 native 变换、六个相机和地板/楼板分批，未独立重跑浏览器。

审查未判定范围：产品接入/拾取、照明/阴影/透明外观/Golden、浏览器矩阵及性能。决定保留这些后续门禁，代价是此提交只接受空间修复，不能切换默认产品为 Lite 或宣称完整视觉一致。

## 复验

先启动冻结 Next 参考服务（默认 5176）、构建并启动 Lite 预览（5177）与独立 Chrome CDP。随后在根目录运行：

```powershell
$env:NEXT_REFERENCE_URL = 'http://127.0.0.1:5176'
$env:LITE_EVIDENCE_DIR = '.local'
node tools/run_twin_browser.mjs lite-layout 9494 http://127.0.0.1:5177 .local/layout-browser.json
```
