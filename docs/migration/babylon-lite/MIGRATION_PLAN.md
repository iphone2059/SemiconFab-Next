# Babylon Lite 原生迁移进度

状态：`IMPLEMENTING / NOT_PARITY_VERIFIED`。当前完成独立 P1 生命周期与 P2 设备/厂房静态几何；P3 产品后端接入及完整 FAB 对齐尚未完成。

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
| P3 后端/相机/拾取 | NOT_RUN | 保留 SceneBackend 领域接口；几何验证后接入完整 Lite 后端。 |
| P4–P10 材质/阴影/动态/业务/性能 | NOT_RUN | 按指南逐模块实现；原生能力优先。 |
| P11 删除旧引擎 | NOT_RUN | 完整模块替换和验证后再删除旧包，执行生产依赖图门禁。 |

独立测试入口支持 P1 立方体、`?scene=equipment` 和 `?scene=structure`（含 L1/B1/DUAL/FFU 按钮）。当前 `/twin` 仍使用已有渲染器。新 Lite 路径没有 `@babylonjs/core`、compat、alias、WebGL 或自制引擎兼容类；旧引擎仅用于隔离的离线数据提取工具和既有产品路径。完整像素对照和性能 A/B 尚未执行。

## 本轮实现决策

1. 在指南指定的 feature 分支、当前 checkout 执行 P0/P1；尚无旧/新视觉比较，因此不启动参考 worktree。后续 A/B 按指南使用独立旧版 worktree。
2. 保留指南历史基准，在此记录实际 Next 起点，避免丢失已有 Wafer/光照修复。
3. P0 Golden 尚未重新执行；允许开展独立 P1 生命周期验证，不将其视为产品视觉门禁通过。代价：P2 几何迁移前仍需补齐同环境参考截图。
4. 恢复执行时补齐 Chrome 155、1536×735、DPR 1 的原版/旧 Next ISO/Top 截图；旧 Next 从 `0b35ca5` 的独立只读 worktree 启动。仅冻结参考，完整 Golden 仍未通过。
5. P2 按有界模块拆为 P2a 设备与后续厂房结构；本次完成 P2a。身份使用现有 `TWIN_LAYOUT_IDENTITIES`，不以 recordId 去重；抽出纯几何零件供旧渲染器与 Lite 共用，旧几何回归 4 项通过。
6. P2b 从冻结 Next 的四个既有模块提取静态顶点/法线/UV/索引和世界矩阵，保留 source SHA，使用 Lite 原生 MeshFromData/LineSystem 重建。源数据按仓库规则位于 `web_app/assets`；代价是增加静态数据载荷，P10 再做同机性能评估。
7. 透明部件使用普通 Mesh 的原生世界变换，供 Lite 距离排序；不把透明位置藏在 thin matrix 中。原生折射所需的零辐射环境由官方 HDR loader 提供，材质环境光强度仍为 0，不添加天空/地板或自写 GPU 通道。

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
```

依赖安装使用仓库固定的 pnpm 12.15.0。此机器全局 Windows shim 无法执行 extensionless pnpm；实际执行入口为 `node C:/Users/han_qingyu/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.mjs`。未修改全局工具或绕过锁文件。
