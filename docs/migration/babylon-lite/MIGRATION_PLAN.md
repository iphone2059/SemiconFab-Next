# Babylon Lite 原生迁移进度

状态：`IMPLEMENTING / NOT_PARITY_VERIFIED`。当前完成独立 P1 生命周期与 P2a 设备几何；不代表整个 FAB 已迁移。

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
| P0 基线 | PASS（源码/单测/构建）；Golden NOT_RUN | 固定三方版本、冻结 fixtures；旧 Next 49 文件 / 190 项测试通过，typecheck/build 通过。未重新拍摄旧 Next/原版 Golden；不将历史视觉结果视为当前通过。 |
| P1 原生生命周期 | PASS（独立 cube） | 19 项生命周期单测；专用 Chrome/NVIDIA GPU 对构建后的夹具验证三次恢复、恢复中卸载、初始 RAF 丢失、中止、重挂载、resize。补齐恢复前停止旧 RAF 和重叠丢失共享等待边界；GPU/console 错误 0。此结论不外推到完整 FAB。 |
| P2 静态几何 | IMPLEMENTING；P2a PASS | 121 台设备、8 类模板和 4 个目录模型已迁移：51 个原生 thin-instance 批次、936 个零件实例。冻结顶点/颜色/包围盒/身份对照通过，构建后 GPU 三次恢复及重挂载通过；地板/区带/墙/FFU/柱/B1 尚未迁移。见 [P2_EQUIPMENT.md](./P2_EQUIPMENT.md)。 |
| P3 后端/相机/拾取 | NOT_RUN | 保留 SceneBackend 领域接口；几何验证后接入完整 Lite 后端。 |
| P4–P10 材质/阴影/动态/业务/性能 | NOT_RUN | 按指南逐模块实现；原生能力优先。 |
| P11 删除旧引擎 | NOT_RUN | 完整模块替换和验证后再删除旧包，执行生产依赖图门禁。 |

独立测试入口支持 P1 立方体和 `?scene=equipment` 的 P2a 设备场景。当前 `/twin` 仍使用已有渲染器。新 Lite 路径没有 `@babylonjs/core`、compat、alias、WebGL 或自制引擎兼容类；默认产品入口不导入测试场景。原版与隔离旧 Next 已重新捕获 ISO/Top 参考；Lite 尚未完成全场景像素对照或性能 A/B，不据此报告性能收益或产品视觉对齐。

## 本轮实现决策

1. 在指南指定的 feature 分支、当前 checkout 执行 P0/P1；尚无旧/新视觉比较，因此不启动参考 worktree。后续 A/B 按指南使用独立旧版 worktree。
2. 保留指南历史基准，在此记录实际 Next 起点，避免丢失已有 Wafer/光照修复。
3. P0 Golden 尚未重新执行；允许开展独立 P1 生命周期验证，不将其视为产品视觉门禁通过。代价：P2 几何迁移前仍需补齐同环境参考截图。
4. 恢复执行时补齐 Chrome 155、1536×735、DPR 1 的原版/旧 Next ISO/Top 截图；旧 Next 从 `0b35ca5` 的独立只读 worktree 启动。仅冻结参考，完整 Golden 仍未通过。
5. P2 按有界模块拆为 P2a 设备与后续厂房结构；本次完成 P2a。身份使用现有 `TWIN_LAYOUT_IDENTITIES`，不以 recordId 去重；抽出纯几何零件供旧渲染器与 Lite 共用，旧几何回归 4 项通过。

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
