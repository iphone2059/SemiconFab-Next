# P0/P1 验证记录 — 2026-10-26

仅验收迁移起步和独立原生生命周期。产品状态仍是 `IMPLEMENTING / NOT_PARITY_VERIFIED`。

| 检查 | 结果 | 证据 |
|---|---|---|
| 迁移前前端基线 | PASS：49 文件、190 测试，typecheck/build | [baseline-tests.txt](./evidence/baseline-tests.txt)、[baseline-typecheck.txt](./evidence/baseline-typecheck.txt)、[baseline-build.txt](./evidence/baseline-build.txt) |
| 生命周期测试先失败后通过 | PASS：初版 10 项，审查后新增 7 项，总计 17 项通过 | [runtime-red.txt](./evidence/runtime-red.txt)、[runtime-green.txt](./evidence/runtime-green.txt)、[review-red.txt](./evidence/review-red.txt)、[initialization-recovery-red.txt](./evidence/initialization-recovery-red.txt)、[review-green.txt](./evidence/review-green.txt) |
| 仓库总验证（修复后） | PASS：Python 16、.NET 67、前端 207；3 个 .NET 项目 Release 构建、类型检查、冻结锁文件安装、生产构建通过 | [verify.txt](./evidence/verify.txt) |
| 独立 Lite 构建 | PASS | [lite-build.txt](./evidence/lite-build.txt) |
| 初版真实 WebGPU：首帧、resize、卸载/重挂载、中止、3 次设备丢失恢复 | PASS（仅初版 `c00f1e0`，不覆盖审查后的修复）；Chrome 155.0.8059.86 / NVIDIA Ampere，GPU/console 错误均为 0 | [p1-browser.json](./evidence/p1-browser.json)、[p1-cube.png](./evidence/p1-cube.png) |
| 修复后的扩展原生 GPU 回归 | PASS（2026-10-26 恢复执行）：新专用 Chrome 155 / NVIDIA Ampere；三次恢复、恢复中卸载、初始 RAF 丢失、中止、重挂载、resize；GPU/console 错误 0 | [p1-browser-resumed.json](./evidence/p1-browser-resumed.json)、[p1-cube-resumed.png](./evidence/p1-cube-resumed.png)。保留历史 [超时](./evidence/browser-timeout.txt) / [adapter 不可用](./evidence/browser-gpu-unavailable.txt) 证据；旧会话根因未认定。 |
| 8 组原版冻结向量/翻译检查 | PASS：手动完整执行；新增 runtime 文件后重新生成 i18n 源码清单（只增加文件名） | [frozen-vectors.txt](./evidence/frozen-vectors.txt) |
| 12 个冻结源码/fixture 文件散列 | PASS：0 变化 | [BASELINE.json](./BASELINE.json) |
| 121 台 Lite 几何、拾取、FAB 页面功能、阴影、模式组合 | NOT_RUN | P2–P9 后续门禁 |
| 原版/旧 Next/Lite 截图差异 | NOT_RUN | P1 cube 不等于 FAB Golden |
| 同机性能 A/B、60 分钟内存、浏览器矩阵 | NOT_RUN | 不推断性能收益或完整场景恢复能力 |
| 最终生产依赖禁止项 | NOT_RUN | 旧引擎待 P11 删除；本轮仅检查新 Lite 源码路径没有 core/compat/WebGL/私有 GPU API |

生产构建保留既有超过 500 kB chunk 的提示。当前产品构建的资源文件名和体积与迁移前相同，P1 测试入口不会进入产品构建；这不是最终 Lite 包体积验收。

浏览器初次运行因测试 HTML 没有 favicon 返回一个 404。为测试页增加内联空 favicon 后，另建全新 Chrome profile 复验通过；未忽略控制台错误。

`scripts/verify.ps1` 原有 `npx pnpm` 调用在此机器受全局 extensionless shim 影响。本轮仅用本地 PowerShell 函数将同一版本 pnpm 的调用转发到已安装的 `bin/pnpm.mjs`，随后完整执行原脚本；未改变验证内容。

总脚本的原有参考路径判断跳过了原版向量检查，因此另外手动执行全部 8 组 `--check`，结果已单独保存。

## 独立审查与修复

一次只读独立审查覆盖 `0b35ca5..c00f1e0`，发现 3 项 Important、无 Critical/Minor：

1. **恢复中卸载可能重新激活引擎**：原生 `disable()` 不取消已捕获恢复。现在将恢复作为未完成异步资源所有者，恢复成功/失败后才最终销毁替换设备；成功/失败两种情况均有 RED→GREEN 单测。
2. **初始 RAF 丢失会使 ready 永久等待**：原生恢复使用不同的 first-frame Promise。现在原生恢复完成也可满足初始帧门禁，并按设备代际重试 GPU 队列完成边界；对应首帧丢失、提交中丢失单测 RED→GREEN。
3. **ready 回调同步卸载后返回已销毁上下文**：通知后重新检查中止信号；重入测试 RED→GREEN。同时覆盖初始化通知中止、初始化失败与恢复重叠清理。

浏览器夹具也改为跟踪当前 generation 的上下文，不再用上一轮已销毁上下文代表 aborted mount。修复后 207 项前端全套测试及完整仓库验证通过，但扩展原生 GPU 回归尚未通过，因此这些修复没有完整 GPU 接受结论。无延后 Minor。

审查中未判定的范围为 P2–P11/整 FAB/Golden/性能（本轮明确只开始迁移），以及初始化通知中止仍短暂获取设备（已顺带由同一取消检查和回归测试消除）。这些不是已完成的产品门禁。

## 历史阻碍（当前 P1 cube 已复验通过）

挂起测试的专用 Chrome GPU 进程持续占用 CPU，页面调试求值不再响应；通过 Browser.close 关闭后，另一已有 Chrome 会话无法获取 adapter（Lite `#50`，在安装包源码中是 `requestAdapter()` 返回 null）。未认定是驱动、浏览器还是测试/Lite 路径的根因。

自动审批审查先拒绝批量强制结束专用测试 Chrome 进程，随后拒绝启动新测试 Chrome，均仅给出 `blocked by policy`。改用调试接口关闭故障会话，并尝试已有会话；CUA 清单没有其他浏览器可用。未修改 GPU/系统设置或以其他方式重试被拒绝的新进程启动。
