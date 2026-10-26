# P2b — 厂房静态结构原生迁移

2026-10-26。状态：P2 几何门禁 `PASS`；总体 `IMPLEMENTING / NOT_PARITY_VERIFIED`。

## 变更与数据来源

- [完整文件清单](./P2B_FILES.txt)。`static-structure.ts` 使用 Lite 公开 API 组装；静态数据位于 `web_app/assets/lite-static-structure.json`，不导入旧引擎。
- 数据从 `fadc3b4` 中既有 `procedural-fab.ts`、`original-environment.ts`、`subfab-utilities.ts`、`original-subfab-facilities.ts` 的独立 NullEngine 场景提取，原模块未修改。资产和独立测试 fixture 都记录来源 SHA。保留原版署名和 [许可说明](../twin-parity/attribution.md)。
- 这是既有 Next 静态几何的原生迁移，未补建旧 Next 原本就没有实现的原版设施。原版/Next/Lite 的完整 Golden 仍是后续接受门禁。
- 源 CPU 数组按原 GPU 上传格式转为 Float32；保留顶点/法线/UV/索引、层级累计世界矩阵、材质颜色/透明度/金属度/粗糙度/发光等输入。没有用简单包围盒替换管线或工业设施。

| 内容 | 数量 |
|---|---:|
| shell（地板、区带、墙柱、琥珀顶板、门/帘等） | 312 部件 |
| FFU/顶棚梁 | 343 部件 |
| B1 管线/支架/泵站/工业设施/地板 | 993 部件 |
| 去重顶点数据 / 材质定义 | 222 / 59 |
| B1 灯 | 10 |
| 原生静态批次 + 既有设备批次 | 396 + 51 = 447 Mesh |

透明部件使用普通 Mesh 的原生变换供距离排序，其余按几何/材质/层/阴影状态共享薄实例。shell/FFU/B1 根节点独立；B1 灯保持源语义：不随 Mesh 隐藏，跟随 B1 展开位移。

地板继续使用两套原始 512² Canvas2D 配方、线性编码、10 mip 和 95×70 / 28×60 UV 重复。原生 PBR 折射的 IBL 依赖用零辐射 HDR 环境解决；材质环境光强度为 0，没有新增天空或地板，没有自写 GPU 扩展。

## 验证证据

| 门禁 | 结果 |
|---|---|
| 静态 CPU 几何与材质 | 6 项 PASS；1648 个世界矩阵/包围盒、完整三角形属性、材质输入、透明排序中心、图层/灯位移、纹理失败清理；[初始 RED](./evidence/p2b-red.txt)、[最终全套](./evidence/p2b-verify.txt) |
| 生命周期 | 23 项 PASS；异步 composition 的中止/失败及注册前设备丢失清理均 RED→GREEN；[异步 RED](./evidence/p2b-async-red.txt)、[审查 RED](./evidence/p2b-review-red.txt) |
| 完整仓库验证 | Python 16 / .NET 67 / 前端 223 PASS；3 个 .NET Release 构建、typecheck、冻结锁文件安装、产品 build PASS；[输出](./evidence/p2b-verify.txt) |
| 来源重提取 | 离线 extractor `--check` PASS；[输出](./evidence/p2b-source-check.txt) |
| 冻结基线 | 原 12 文件 SHA-256 无变化，8 组原版向量/翻译门禁 PASS；[输出](./evidence/p2b-frozen-vectors.txt) |
| 独立 Lite build | PASS；[输出](./evidence/p2b-lite-build.txt)。包含静态数据的夹具存在大 chunk 提示，未据此报告性能收益。 |
| 构建后真实 GPU | Chrome 155 / NVIDIA Ampere，L1/FFU/B1/DUAL、三次恢复、卸载/重挂载 PASS，GPU/console 0 错误；[记录](./evidence/p2b-browser.json) |
| 既有设备与 P1 硬件回归 | 两组均 PASS，各自三次恢复；P1 另含 resize/恢复中卸载/首帧丢失/中止；[设备](./evidence/p2b-equipment-browser.json)、[P1](./evidence/p2b-runtime-browser.json) |

[L1 截图](./evidence/p2b-l1.png) · [FFU](./evidence/p2b-ffu.png) · [B1](./evidence/p2b-b1.png) · [DUAL](./evidence/p2b-dual.png)。截图用于实际可绘制性检查，不是全场景像素对齐或阴影接受证据。精确 legacyDecay/Gamma/Fog、透明深度状态、各向异性、阴影与性能 A/B 尚未接受；资产保留未映射的源参数。

## 复验

仓库根目录，独立数据提取检查：

```powershell
cd web_app
node node_modules/vite/bin/vite.js build --config tests/static-reference.vite.config.ts
node ../.local/lite-static-capture-bin/capture.mjs --check
npm run typecheck
npm test
npm run build
node node_modules/vite/bin/vite.js build --config tests/lite-runtime.vite.config.ts
node node_modules/vite/bin/vite.js preview --config tests/lite-runtime.vite.config.ts --host 127.0.0.1 --port 5177 --strictPort
```

另一个终端用独立 Chrome CDP 会话（示例 9493）执行：

```powershell
node tools/run_twin_browser.mjs lite-static 9493 http://127.0.0.1:5177 .local/lite-static.json
node tools/run_twin_browser.mjs lite-equipment 9493 http://127.0.0.1:5177 .local/lite-equipment.json
node tools/run_twin_browser.mjs lite 9493 http://127.0.0.1:5177 .local/lite-runtime.json
```

预览地址 `http://127.0.0.1:5177/?scene=structure`；当前产品 `/twin` 不在本轮切换。

## 审查与决定

只读独立审查发现 2 项 Important、1 项 Minor、无 Critical。两个 Important 已以回归先失败后通过修复：透明位置必须进入 native mesh.worldMatrix；注册前的设备丢失必须终止本次初始化并等待 composition/recovery 结束后清理。修复后全套与三组构建后硬件回归重新执行。

决定：按 P2 静态几何完成门禁继续，完整产品接入、光照/阴影、Golden、性能留在 P3–P10；代价是 `/twin` 尚不能换为纯 Lite。离线数据资产增加载荷，性能收益需 P10 同机 A/B。初始化上传中丢失分支通过生命周期双替身验证，未故意制造真实 GPU 崩溃；审查也未独立重跑全套/浏览器，执行证据来自本记录。

历史 Minor：测试预览入口在 attachControl 后、HDR cleanup catch 前同步失败可能遗漏控件 disposer；已在后续 [布局修复](./LAYOUT_PARITY.md) 中统一 composition 错误清理。

后续对照还发现 P2 CPU 数据门禁遗漏的 RH/LH 与相机差异，以及旧预览 B1/DUAL 的错误显示逻辑。原本三组 GPU 检查只证明可绘制/恢复，不能接受屏幕布局；后续真实 Next 对照及纠正结论以 [LAYOUT_PARITY.md](./LAYOUT_PARITY.md) 为准。
