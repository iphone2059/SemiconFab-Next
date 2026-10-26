# Lite 缺口记录

本轮 P1 没有需要自实现 GPU 功能的已证实缺口，没有新增 `extensions/` 或兼容层。

`startEngine()` 的 Promise 在首个 RAF resolve，而 `stopEngine()` 仅取消 RAF。应用生命周期需要自行 race AbortSignal，防止卸载前等待永远悬挂。这是应用取消语义，不是新增渲染能力；实现位于 `runtime.ts`，有取消测试。

独立审查还确认 `enableDeviceLostSceneRecovery().disable()` 不会取消已开始的原生恢复。runtime 因此必须等待恢复完成/失败再销毁替换设备；初始 RAF 若被恢复流程取消，则使用恢复后的首帧重新确认 GPU 门禁。扩展 GPU 回归历史上曾挂起，根因未隔离；新会话复跑及最新构建后回归已通过，见 [VALIDATION.md](./VALIDATION.md)。

P2a 已证实 [LITE-GAP-RECOVERY-001](./LITE-GAP-RECOVERY-001.md)：1.36 的 Scene 恢复保留薄实例 GPU 缓存。采用公开数据槽和原生 setter 重置即可恢复；runtime 必须先停止旧 RAF，防止异步原生恢复启动前旧帧重填缓存。没有新增 GPU 扩展、私有字段访问或引擎分叉。恢复后显式首帧和队列完成才报告 ready；连续丢失保留同一未结束等待边界。

官方 release 文档明确 directional ESM/CSM 支持恢复、PCF 自动恢复不支持。P1 没有阴影，不据此选择最终阴影算法。P5 必须先验证 Lite 原生阴影，再按指南提交缺口证据。
