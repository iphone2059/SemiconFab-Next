# Lite 缺口记录

本轮 P1 没有需要自实现 GPU 功能的已证实缺口，没有新增 `extensions/` 或兼容层。

`startEngine()` 的 Promise 在首个 RAF resolve，而 `stopEngine()` 仅取消 RAF。应用生命周期需要自行 race AbortSignal，防止卸载前等待永远悬挂。这是应用取消语义，不是新增渲染能力；实现位于 `runtime.ts`，有取消测试。

独立审查还确认 `enableDeviceLostSceneRecovery().disable()` 不会取消已开始的原生恢复。runtime 因此必须等待恢复完成/失败再销毁替换设备；初始 RAF 若被恢复流程取消，则使用恢复后的首帧重新确认 GPU 门禁。扩展 GPU 回归历史上曾挂起，根因未隔离；新会话复跑及最新构建后回归已通过，见 [VALIDATION.md](./VALIDATION.md)。

P2a 已证实 [LITE-GAP-RECOVERY-001](./LITE-GAP-RECOVERY-001.md)：1.36 的 Scene 恢复保留薄实例 GPU 缓存。采用公开数据槽和原生 setter 重置即可恢复；runtime 必须先停止旧 RAF，防止异步原生恢复启动前旧帧重填缓存。没有新增 GPU 扩展、私有字段访问或引擎分叉。恢复后显式首帧和队列完成才报告 ready；连续丢失保留同一未结束等待边界。

P4/P5 审查修复另证实 [LITE-GAP-RECOVERY-002](./LITE-GAP-RECOVERY-002.md)：1.36 的 deferred billboard 不随 Scene 自动恢复，默认 MSAA 叠加还与透射重定向冲突。标签使用独立原生 SceneContext 与公开 RenderTask 组合；runtime 等注册与替换 GPU 帧完成后才 ready。可见性 on/off、三次丢失、关闭灯光状态保持与上下文数量均有实际像素回归。

官方 release 文档明确 directional ESM/CSM 支持恢复、PCF 自动恢复不支持。P1 没有阴影，不据此选择最终阴影算法。P5 必须先验证 Lite 原生阴影，再按指南提交缺口证据。

## P2b 的原生 API 约束

- `setTextureTransform` 写入纹理变换后，手工创建的 PBR 材质仍需 `enableMaterialUvTransform` 显式启用；新增 RED→GREEN 检查，构建后验证两套重复参数。
- 1.36 `refraction-rtt-fragment.js` 声明 `ibl` 依赖。没有环境时，原生 composer 的 topoSort 直接抛错；[GPU RED](./evidence/p2b-shader-red.txt) 保留栈。本实现用 `loadHdrEnvironment` 加载全黑 4×2 RGBE，面尺寸 16、关闭天空/地板，提供原生依赖。材质 `environmentIntensity` 保持 0，loader 的 exposure/contrast 改动恢复为进入前值。此组合通过三次设备恢复，无需扩展目录。
- Lite 的透明距离排序使用 `mesh.worldMatrix` 平移，不包含 thin matrix。192 个透明部件改为普通 Mesh 变换，其余继续薄实例；对应排序中心回归 RED→GREEN。这里只验证原生排序输入，不宣布透明材质的像素对齐已完成。
- 原生自动恢复只遍历已注册 Scene。异步 composition/初次注册期间丢失设备时，本次 mount 必须失败并清理，不能把旧几何继续注册；后续挂载可新建引擎。成功/失败与清理时序由单测验证；没有人为制造 GPU 崩溃来验证这一分支。

尚未迁移的精确 per-light legacyDecay、Gamma/Fog、PBR 深度偏移/透明深度写入和地板各向异性等配置仍由 P4 验证；保留源输入，不增加未经审查的 WGSL 通道。


## 产品完成阶段（P3/P6–P11）新增缺口与决策 — 2026-10-26

1. **整产品设备丢失策略 = 替换设备上重建原生场景**。Lite 1.36 原生 in-place Scene 恢复会重放记录的材质组/Standard MaterialPlugin UBO；产品一旦启用过 X-Ray 的 ShaderMaterial 调色板并要求稳定恢复，该路径会抛错（`rebuilding material groups`/missing sampler/旧 device buffer）。产品 backend 因此在 lost 时释放旧 runtime 与新设备上重建 world，并恢复相机位姿、选中项；React/Redux 重新施加楼层/图层/X-Ray/剖切/工具状态。bounded `lite-*` 夹具继续验证原生 in-place 恢复路径。产品三次丢失、0 GPU/console 错误、状态保持已实测（证据包）。
2. **X-Ray 全息 = CSM receiver + depth-only caster + 冻结产品 legibility floor**。1.36 在 X-Ray 激活的材质重建帧里，若暗色调色板既作 caster 又采样同一 2 层 depth texture，WebGPU 会拒绝该 usage scope（每次激活约 16 条 validation error）。产品通过 `setShadowCasterMaterial` 让调色板以 depth-only Standard 视图投射阴影，调色板再以 comparison sampler 采样 CSM receiver（`shadowLinked=true`，三次设备丢失后 0 GPU 错误）。源全息使用其自有 static depth pass，其响应整体读作 legibility floor（参考高亮区中位亮度 117，原始 CSM 响应下产品为 164）；产品保留 CSM 调制但折叠进冻结产品的可见亮度：`lit = 0.35 + (1-0.35)*shadow*0.35`（`XRAY_LIT_FLOOR`/`XRAY_SHADOW_CONTRAST`，见 `render/lite/effects.ts`）。这是**冻结产品外观的视觉近似决策**，不是复刻旧 depth pass。冻结时钟 X-Ray 差从 43.86 → 35.04（原始 CSM）→ **28.69**；仍为已知视觉缺口，不宣布 X-Ray 视觉通过。
3. **剖切仅裁剪原生 PBR 材质**。Standard MaterialPlugin 的 plugin UBO 不由 1.36 原生恢复重建；为避免产品恢复路径被破坏，产品不对 Standard 材质（OHT/人员等动态 actor）挂剖切插件，保留其源外观。整厂房/设备/设施/地板/环境等 PBR 表面均被裁剪。
4. **X-Ray/剖切互斥与楼层/爆炸组合** 沿用冻结 `spatialState` 语义（单一 spatialMode），产品验收已覆盖。
5. **旧引擎验收套件清退**：删除 `twin-wafer/level/exploded/parity/goldens/tour/xray-acceptance/original-lighting/native-static-shadows` 等依赖旧 Scene 内部结构或已删除构建器的套件；产品行为由 `tests/twin-lite.browser.ts`（真实 /twin）覆盖，DOM 回归保留 `twin.browser.ts`。冻结时钟的 tour 时序 Golden 因此 NOT_RUN。
6. **跨浏览器矩阵 PARTIAL**：Chrome 155 与 Edge 156（Chromium/WebGPU 实测）产品验收与 UI 回归均 PASS；非 Chromium WebGPU 浏览器本机不可用且未下载，NOT_RUN。
7. **整产品 Golden NOT_RUN**：已用参考 golden 的 GOLDEN_CLOCK 手动步进做冻结时钟 7 视角比较（证据包 §3，可用 `tools/frozen_visual_compare.mjs` 复现：ISO 9.88 / TOP 13.47 / B1 17.75 / DUAL 19.94 / EXPLODED 8.30 / CUT 5.58 / X-RAY 28.69），但迁移指南未定义整产品 Golden 阈值且 X-Ray 缺口可见，不能当 Golden PASS；生产构建验收、性能 A/B、三次恢复已通过。按用户指示以 1 分钟 soak 替代 60 分钟（最终生产构建 51.5 fps、0 long task、0 GPU/console 错误、heap 37.5 MB）；60 分钟 soak 因此 NOT_RUN。
8. **性能口径**：早期 A/B（Lite 57.9/53.9 vs 旧 15.8/14.0）因 legacy tab 被遮挡节流而撤回；全新单一前台浏览器重复三次的诚实结果是 Lite 52.5/45.8 vs 旧 38.2/37.4 fps（≈1.2–1.35×），仍为 PASS 但优势有限。
9. **独立审查**：无 Critical/阻塞缺陷；1 项 docs-only Important（文档与冻结证据口径，本轮已修）与 10 项 Minor 残留风险（camera 恢复计时顺序、restartPending 无自动化覆盖、gpuErrors 订阅时机、cut 无像素断言、decodePng 无单测等）记录于 [REVIEW.md](./evidence/product-completion-2026-10-26/REVIEW.md)。

