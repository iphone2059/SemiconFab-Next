# Lite 缺口记录

本轮 P1 没有需要自实现 GPU 功能的已证实缺口，没有新增 `extensions/` 或兼容层。

`startEngine()` 的 Promise 在首个 RAF resolve，而 `stopEngine()` 仅取消 RAF。应用生命周期需要自行 race AbortSignal，防止卸载前等待永远悬挂。这是应用取消语义，不是新增渲染能力；实现位于 `runtime.ts`，有取消测试。

官方 release 文档明确 directional ESM/CSM 支持恢复、PCF 自动恢复不支持。P1 没有阴影，不据此选择最终阴影算法。P5 必须先验证 Lite 原生阴影，再按指南提交缺口证据。
