# P0/P1 验证记录 — 2026-10-26

仅验收迁移起步和独立原生生命周期。产品状态仍是 `IMPLEMENTING / NOT_PARITY_VERIFIED`。

| 检查 | 结果 | 证据 |
|---|---|---|
| 迁移前前端基线 | PASS：49 文件、190 测试，typecheck/build | [baseline-tests.txt](./evidence/baseline-tests.txt)、[baseline-typecheck.txt](./evidence/baseline-typecheck.txt)、[baseline-build.txt](./evidence/baseline-build.txt) |
| 生命周期测试先失败后通过 | PASS：10 项从未实现状态失败至全部通过 | [runtime-red.txt](./evidence/runtime-red.txt)、[runtime-green.txt](./evidence/runtime-green.txt) |
| 仓库总验证 | PASS：Python 16、.NET 67、前端 200；3 个 .NET 项目 Release 构建、类型检查、冻结锁文件安装、生产构建通过 | [verify.txt](./evidence/verify.txt) |
| 独立 Lite 构建 | PASS | [lite-build.txt](./evidence/lite-build.txt) |
| 真实 WebGPU 首帧、resize、卸载/重挂载、中止、3 次设备丢失恢复 | PASS；Chrome 155.0.8059.86 / NVIDIA Ampere，GPU/console 错误均为 0 | [p1-browser.json](./evidence/p1-browser.json)、[p1-cube.png](./evidence/p1-cube.png) |
| 12 个冻结源码/fixture 文件散列 | PASS：0 变化 | [BASELINE.json](./BASELINE.json) |
| 121 台 Lite 几何、拾取、FAB 页面功能、阴影、模式组合 | NOT_RUN | P2–P9 后续门禁 |
| 原版/旧 Next/Lite 截图差异 | NOT_RUN | P1 cube 不等于 FAB Golden |
| 同机性能 A/B、60 分钟内存、浏览器矩阵 | NOT_RUN | 不推断性能收益或完整场景恢复能力 |
| 最终生产依赖禁止项 | NOT_RUN | 旧引擎待 P11 删除；本轮仅检查新 Lite 源码路径没有 core/compat/WebGL/私有 GPU API |

生产构建保留既有超过 500 kB chunk 的提示。当前产品构建的资源文件名和体积与迁移前相同，P1 测试入口不会进入产品构建；这不是最终 Lite 包体积验收。

浏览器初次运行因测试 HTML 没有 favicon 返回一个 404。为测试页增加内联空 favicon 后，另建全新 Chrome profile 复验通过；未忽略控制台错误。

`scripts/verify.ps1` 原有 `npx pnpm` 调用在此机器受全局 extensionless shim 影响。本轮仅用本地 PowerShell 函数将同一版本 pnpm 的调用转发到已安装的 `bin/pnpm.mjs`，随后完整执行原脚本；未改变验证内容。
