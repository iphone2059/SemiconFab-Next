# 渲染管线（Rendering）

- 版本：V2.1 / 2026-10-27（2026-10-28 递归整改 R-04/R-06 同步）
- 状态：**M5b/M5c 已完成 rendering/lite 归位、遥测 SSE→Worker→渲染接线与真实 Chrome/WebGPU 性能门禁；2026-10-28 递归整改把场景入口收口为应用侧 ScenePort、GPU Effect 拆为独立资源所有者**（当前使用 Babylon Lite 1.36）
- 依据：[ADR-0010](adr/0010-command-event-bridge.md) 的 `ARCH-11`、[ADR-0003](adr/0003-single-web-app.md) 的 WebGPU-only、宿主规范 [09-WEBGPU-RENDERING](SemiconFab-Next-Engineering-v1.1/09-WEBGPU-RENDERING.md) 与 [15-FRONTEND](SemiconFab-Next-Engineering-v1.1/engineering/15-FRONTEND-AND-WEBGPU-PROJECTS.md)
- 总览：[架构基线](architecture.md) §4/§30；状态所有权：[状态管理](state-management.md)；实时协议：[实时协议](realtime-protocol.md)
- 原版资产署名见 [attribution](attribution.md)。`TelemetryRuntime` 将后端 20Hz 遥测帧经 Worker/FrameRingBuffer 提供给渲染 frame loop；设备槽位/`FabToolState` 投影为纯函数 `domain/equipment/tool-state-projection.ts`；场景入口是 `application/ports/scene.ts` 的 `ScenePort`（R9），由 `rendering/lite-backend.ts` 实现；GPU 效果按 `rendering/lite/effects/{xray,xray-shaders,cut,wafer,index}.ts` 独立 create/update/dispose（R-06）。`tools/render_perf.mjs` 记录真实 GPU 门禁（历史证据：179 frames，p95 8.5ms，见 `docs/evidence/`）。

## 1. 强制约束

1. **唯一 3D 引擎是 Babylon Lite**（当前版本 1.36.0，见 `web_app/package.json`）；不引入第二个 3D/渲染引擎。
2. **只允许 WebGPU**：运行前检查 `window.isSecureContext`、`navigator.gpu`、adapter/device limits；不支持时显示明确错误，**不回退 WebGL**。仓库架构检查已禁止 WebGL context 创建语句。
3. **引擎对象不进入状态容器**：scene/mesh/material/GPUBuffer 等只存在于渲染封装（ref/单例）中，不进入 Query/Zustand/Redux/XState（沿用 ADR-0008 原则并强化）。
4. **设备丢失可恢复**：`device.lost` 后停止提交帧、重建资源、从快照/状态恢复；不复用 lost device 的资源。
5. **渲染进程不是业务权威**：3D 表现不写回 DES/后端权威状态（Engineering 09）。
6. **高频数据旁路**：高频遥测/变换不得经过 Query/Zustand/XState，也不得以逐帧 `setState`/dispatch 更新 React（ARCH-11）。

## 2. 分层与目录

当前实现（2026-10-28 终态，事实）：

| 现有路径 | 作用 |
|---|---|
| `src/application/ports/scene.ts` | 应用侧唯一 **ScenePort**：必需 `SceneCommands`、强类型 `SceneMountOptions{viewerId,canvas,fabs,signal,callbacks}`、判别式 `SceneMountOutcome`、只读 `SceneLifecycleEvent`；不允许 optional 产品能力（R9） |
| `src/rendering/lite-backend.ts` | `ScenePort` 的 Lite 实现：GPU 获取/首帧/设备丢失恢复、runtime+world 装配、单一幂等 mount/dispose 生命周期 |
| `src/rendering/lite/` | Babylon Lite 运行时、世界/几何/材质/光照/选择/裁剪/动效/设备恢复、source-orbit-input 等 |
| `src/rendering/lite/effects/{xray,xray-shaders,cut,wafer,index}.ts` | X-Ray/WGSL、Cut、Wafer marker/trail 的独立资源所有者（create/update/dispose） |
| `src/rendering/contracts/static-structure-data.ts` | 静态结构生成物的手写类型合同（生成物仅 type-only 引用；R5/R11） |
| `src/state/runtimeStore.ts` | `ViewerLifecycle = idle|initializing|ready|recovering|failed|disposed` 与控制流；`status` 仅为展示文案 |
| `src/features/twin/fab-viewer.tsx` 等 | React 侧挂载/生命周期/HUD 交互（页面模块在 `features/twin/`） |
| `src/generated/static-structure-packed.ts` | 静态结构构建期打包数据（只读；由 `tools/pack_static_structure.mjs` 生成，经数据合同被 `rendering/lite/geometry/static-structure.ts` 消费） |

已删除/不再存在：`rendering/fab-scene.ts`、`SceneFacade`、`SceneBackend` 名称与旧长参数 `mount(canvas,fabs,signal,...)`。目标目录（V2.1）中 `realtime/synchronization/` 未创建（低频合批原语在 `shared/scheduling/coalesced-dispatcher.ts`）。

## 3. 高频渲染数据流

```text
当前（HTTP/SSE 模拟链路）:
FAB 级遥测 SSE -> realtime/telemetry/TelemetryRuntime -> realtime/workers（解码/合批）
              -> realtime/buffers/FrameRingBuffer（TypedArray）
              -> rendering/lite-backend（ScenePort 实现：实例属性/材质更新）-> WebGPU

目标（真实 WebSocket 接入后）:
WebSocket -> realtime/transport -> MessageDecoder（或在 Worker 内）
         -> realtime/workers -> realtime/buffers -> ScenePort 实现 -> WebGPU
```

规则：

- Worker 与主线程之间使用 transferable `ArrayBuffer`（或经批准后的 SharedArrayBuffer，OPEN-V21-14）；避免逐条对象消息。
- 缓冲写入按帧/批合并；渲染循环在有界预算内消费，不阻塞 UI。
- 帧/时钟：`RenderClock` 与仿真时钟分离；回放插值只影响展示（Engineering 09）。
- 数据源身份（stream_id/run/fab）进入缓冲元数据；切换视图/run 时必须失效旧缓冲，晚到批次不得写入新场景（沿用现有 ScopeGate/epoch 思路，见 `src/application/coordination/ScopeGate.ts` 与 `state/runtimeStore.ts` 的 viewer epoch）。
- 不在渲染循环内读 Query/Zustand/XState；渲染所需状态来自缓冲与 `ScenePort` 的参数/回调。

## 4. 数据频率与所有者

| 数据 | 典型频率 | 所有者 | 进入 React？ |
|---|---|---|---|
| 高频设备状态/变换/遥测帧 | 高（Hz 级及以上，具体上限由后端 maxHz/预算决定） | Worker/缓冲区 -> 渲染 | 否 |
| 告警 | 低频、事件型 | 实时流 -> UI/AlarmStream | 是（事件驱动，需节流） |
| 选择/悬停/相机 | 交互频率 | 渲染层/ref；必要时节流进 Zustand/组件 | 少量 |
| 页面 KPI/汇总 | 低频 | Query（若为 HTTP）或低频投影流 | 是 |
| 命令生命周期 | 事件型 | XState 工作流（经契约） | 通过展示投影/Query 权威状态 |
| 引擎资源（mesh/material/GPU） | 生命周期型 | 渲染封装 | 否 |

“低频/高频”的阈值在 M5 性能测试中冻结；本基线不写死数值，避免虚构性能事实。

## 5. 当前实现事实（不夸大）

- `src/rendering/lite` 已有 Babylon Lite 运行时、场景/几何/光照/选择/裁剪等模块（M5b 从 `src/render/lite` 归位）；`lite-backend.ts` 实现 `application/ports/scene.ts` 的 `ScenePort`，在挂载前检查 `isSecureContext`/`navigator.gpu`/adapter 与纹理限制，并发 `SceneLifecycleEvent`（initializing/ready/recovering/failed）驱动 `state/runtimeStore.ts` 的 `ViewerLifecycle`；设备丢失后按代码注释说明的 Native 1.36 库限制就地重建。
- 当前场景是原版 121 台设备的单 FAB 布局数据（`src/domain/fab/fab-layout.ts`）；产品按 3 FAB 数据驱动，3D 页面按选中 FAB 渲染一屏。
- 高频遥测链路已落地：FAB 级 20Hz SSE → `TelemetryRuntime` → Worker `FrameRingBuffer` → 渲染 frame loop；渲染循环不读 Query/Zustand/XState。
- GPU/浏览器性能门禁已建立：`tools/render_perf.mjs` + `scripts/perf-render.ps1`（headless Chrome + 真实 WebGPU，179 采集帧 p95 8.5ms；持续门禁 600 帧）。旧迁移/parity 证据已在 M6 删除。

## 6. V2.1 迁移落点（M5）

| 工作 | 说明 | 依赖 |
|---|---|---|
| Worker 解码/合批 | 高频遥测在 Worker 内处理，主线程只收摘要/缓冲 | OPEN-V21-06/15（协议/topic） |
| TypedArray 缓冲 | 变换/状态/告警标记的有界缓冲与脏实体集合 | 帧预算定义 |
| Lite 接入 | 渲染循环消费缓冲，保持应用侧 `ScenePort`（`application/ports/scene.ts`）端口 | 现有 Lite 迁移收尾 |
| 目录归位 | `render/lite` -> `rendering/lite`（M5b 完成）；相关 React 入口 -> `features/twin/`（M6 后补完成） | 已完成 |
| 性能测试 | `web_app/tests/performance` 与 `web_app/tests/rendering`；记录基线而非宣称达标 | 真实 GPU/驱动冻结 |

约束：M5 不得改变 Vite `server`/`build` 参数（G-01）；Worker 打包方式若需要 Vite 配置调整，必须确认属于允许的插件/配置范围或改用 `new Worker(new URL(...), { type: 'module' })` 的现有能力。

## 7. 性能与验收

- Engineering 09 第 5 节的 60 FPS、首屏 p95 < 5s 等是**候选目标**，不是已验证事实；V2.1 不重复声明。
- 性能测试必须在明确硬件/浏览器/分辨率/设备数/活跃实体比例/更新率下记录；无 GPU 的 CI 结果不能作为 WebGPU 性能证据（Engineering 12）。
- 真实 GPU 门禁已运行：`tools/render_perf.mjs`（headless Chrome + 真实 WebGPU）记录 179 frames / p95 8.5ms / 116fps，持续门禁 600 帧；命令见根 README 与 §26。
- CPU/负载门禁：`web_app/tests/performance/telemetry-frame-buffer.test.ts`、`telemetry-load.test.ts`（500/2000/5000 实体）；`web_app/tests/rendering/lite-*.test.ts` 是渲染实现单元/回归测试（另有 `scene-port-lifecycle.test.ts` 验证 ScenePort 生命周期/负向类型）；原 frozen/browser parity 套件已在 M6 删除。

## 8. 与命令/Runtime 的边界

- FabRuntime 只装配命令/实时链路，不拥有渲染生命周期；渲染由 `ScenePort`（`application/ports/scene.ts`）/ `rendering/lite-backend.ts` 管理（[FAB 运行时](fab-runtime.md)）。
- 命令工作流不消费高频遥测，也不驱动逐帧渲染；命令结果只影响 UI/业务状态与必要时的一次性场景标记。
- 高频告警若要改变 3D 标记，通过缓冲/渲染状态进入，不经过 XState/Query。
- 渲染层不得 import `runtime/commands`/`application/coordination`。

## 9. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| Worker/主线程协议设计不当 | 帧预算超支、GC 抖动 | TypedArray/transferable；帧预算测试；避免对象风暴 |
| SharedArrayBuffer 需要 COOP/COEP | 部署限制 | OPEN-V21-14；先走 transferable |
| 设备丢失重建 | 视觉/状态回退 | 现有 Lite 策略 + 快照/相机恢复；回归测试 |
| 三 FAB 同屏规模 | 显存/帧率 | 分 FAB 订阅/LOD；单 FAB 先验收 |
| 测试硬件不可用 | 无法声称性能达标 | 记录环境；无 GPU CI 不作为证据 |
| 原版资产署名/许可见 [attribution](attribution.md) | 许可合规 | 保留署名文件；渲染数据来源记录在代码注释 |

开放问题：OPEN-V21-14（SharedArrayBuffer）、OPEN-V21-15（topic/订阅范围）、OPEN-V21-06（实时协议）；见 [架构基线](architecture.md) 第 14 节。
