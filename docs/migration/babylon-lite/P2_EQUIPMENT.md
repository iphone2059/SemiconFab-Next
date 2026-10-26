# P2a — 121 台设备的原生 Lite 几何

日期：2026-10-26。状态：`PASS`（设备模块）；迁移总体 `IMPLEMENTING / NOT_PARITY_VERIFIED`。

完整变更文件清单：[P2_FILES.txt](./P2_FILES.txt)。P1 本机扩展复验提交为 `5ac89ae`；P2a 作为独立有界提交记录，保留在本地 `feat/twin-babylon-lite-native` 分支。

## 实现范围

- `original-tool-parts.ts` 提取原有纯零件数据，旧渲染器和 Lite 共用；`FAB_LAYOUT`、领域接口和全部冻结 fixture 未修改。
- `render/lite/geometry/tool-families.ts` 直接使用 Lite 的 Box/Cylinder/LineSystem、TransformNode、PBR 和 Thin Instances；按几何+材质分成 51 批，绘制 936 个零件实例。
- 全部 121 个 placement identity 来自既有 `TWIN_LAYOUT_IDENTITIES`；保留重复 recordId，每个零件以 `(mesh, instanceIndex)` 回映射到原 placement。这里只证明身份数据映射，原生 GPU picker/设备卡片属于 P3。
- 八类模板、四个目录模型、三份推断目录线框、状态灯和立杆保持原始几何。目录透明度、颜色、金属度、粗糙度保持原值；完整光照与色彩空间对齐属于 P4。
- 原生设备恢复的薄实例缓存问题已通过公开 API 处理，见 [LITE-GAP-RECOVERY-001](./LITE-GAP-RECOVERY-001.md)。没有新增自实现 GPU 渲染功能。

地板、区带、墙、FFU、柱、B1 尚未迁移；`/twin` 仍用原有完整渲染器。设备夹具只在独立测试入口 `/?scene=equipment`，不进入产品构建。

## 验证

| 门禁 | 结果 / 证据 |
|---|---|
| 新设备测试 | 4 项 PASS：全部 121 身份/非法索引、实际实例矩阵下的世界包围盒、8 类顶点+颜色、全部目录零件和线框边；[RED](./evidence/p2-equipment-red.txt)、[GREEN](./evidence/p2-equipment-green.txt) |
| 旧设备测试 | 原有 4 项 PASS，确保抽取纯数据未改旧渲染器 |
| 生命周期 | 19 项 PASS；新旧帧竞争和连续丢失回归均 RED→GREEN；[旧 RAF RED](./evidence/p2-instance-race-red.txt)、[连续丢失 RED](./evidence/p2-overlapping-loss-red.txt) |
| 仓库全套 | Python 16、.NET 67、前端 213 PASS；3 个 .NET Release 构建、typecheck、冻结锁文件安装、产品 build PASS；[完整输出](./evidence/p2-verify.txt) |
| 独立 Lite build | PASS；[输出](./evidence/p2-lite-build.txt) |
| 构建后真实 GPU | Chrome 155.0.8059.86 / NVIDIA Ampere，121 身份、51 批次、936 零件实例；三次丢失恢复、Top、卸载/重挂载 PASS，GPU/console 错误 0；[记录](./evidence/p2-equipment-browser.json)、[ISO](./evidence/p2-equipment-iso.png)、[Top](./evidence/p2-equipment-top.png) |
| P1 构建后回归 | cube 的恢复中卸载、初始 RAF 丢失、resize、中止和重挂载继续 PASS；[记录](./evidence/p1-browser-resumed.json) |
| 数据冻结 | BASELINE 的 12 个 SHA-256 均无变化；8 组原版向量/翻译/覆盖检查 PASS；[输出](./evidence/p2-frozen-vectors.txt) |
| 原版/隔离旧 Next 参考 | 同一 Chrome、1536×735、DPR 1、固定 seed/clock，ISO/Top 已拍摄；[清单](./evidence/p2-reference/manifest.json)。完整 Golden 图差、Lite 光照对齐、性能 A/B 仍 NOT_RUN。 |

参考原版保持 `b3666132`；旧 Next 从 `0b35ca5` 的独立 detached worktree 启动，不修改源参考。原版 Tailwind CDN 的两条既有 warning 原样记录；捕获 runtime/console errors 为 0。产品仍有既有超过 500 kB chunk 提示；不将夹具批次数视为产品性能收益。

## 复验

仓库根目录，已安装锁定依赖后：

```powershell
cd web_app
npm run typecheck
npm test
npm run build
node node_modules/vite/bin/vite.js build --config tests/lite-runtime.vite.config.ts
node node_modules/vite/bin/vite.js preview --config tests/lite-runtime.vite.config.ts --host 127.0.0.1 --port 5177 --strictPort
```

在另一个终端使用独立 Chrome CDP 会话（示例端口 9492）：

```powershell
node tools/run_twin_browser.mjs lite-equipment 9492 http://127.0.0.1:5177 .local/lite-equipment.json
node tools/run_twin_browser.mjs lite 9492 http://127.0.0.1:5177 .local/lite-runtime.json
```

参考捕获：原版使用 `tools/serve_twin_reference.py` 注入 `GOLDEN_CLOCK`，隔离旧 Next 使用 `tests/twin-golden.vite.config.ts` 并沿用本机 API 开发密钥（不写入证据），再执行：

```powershell
node tools/capture_lite_migration_baseline.mjs 9492 http://127.0.0.1:5179 http://127.0.0.1:5176 .local/lite-reference
```

## 审查与决策

一次只读独立审查：1 项 Important、无 Critical/Minor。连续丢失可能令初始化等待被替换的恢复 Promise；精确回归先失败后通过，现保留跨重叠丢失的同一等待边界。修复后前端 213 项全套、构建与硬件回归已重跑。

本次决策是按指南逐个有界模块完成 P2a；P2 的厂房结构及 P3–P11 保持未完成。审查未判定的完整 FAB/像素对齐、厂房结构、生产拾取和性能收益仍是后续门禁，不能由设备夹具外推；代价是当前 `/twin` 尚不能切换为纯 Lite。审查未独立重跑浏览器和全套验证，其结果以本记录的执行证据为准。没有延后 Minor。
