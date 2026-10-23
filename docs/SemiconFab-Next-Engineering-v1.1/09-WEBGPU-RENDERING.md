# 09 — WebGPU-only 3D 渲染与 React 前端规范

## 1. 强制渲染约束

- **只能创建 Babylon.js `WebGPUEngine`**；禁止使用 Babylon `Engine`/`ThinEngine` WebGL 上下文作为运行路径；没有 WebGL fallback。
- 不得请求 `canvas.getContext('webgl'|'webgl2'|'experimental-webgl')`，构建扫描和运行时监测将其视为失败。
- 启动检查 secure context、WebGPU 实际支持、GPU 设备创建、所需 limits/features、设备丢失恢复能力；不满足显示明确错误与系统需求，不降级到 WebGL。
- WebGPU 仅允许通过现代 Babylon.js 官方引擎 API 与经过验证的 WGSL Shader/Compute 使用；未来切换 Babylon Lite 仍须保持上层数据契约不变。
- 非 3D 的普通 React 管理界面可以独立显示“3D 不可用”提示，但不得伪装为 3D 正常加载。

示例引擎启动：`examples/ts/webgpu-only.ts`。目标环境：最新稳定 Edge/Chrome、HTTPS 或 localhost、GPU/驱动准入清单；Windows Server/RDP/虚拟 GPU 需单独验证。

## 2. 前端模块

```text
apps/web/src/                         React 路由、权限、页面与 Composition Root
frontend/packages/
  ├── contracts/                     生成的协议类型
  ├── api-client/                    REST 客户端
  ├── realtime-sync/                 快照、增量与重同步
  ├── fab-scene/                     引擎无关场景、实体与渲染 Port
  ├── babylon-webgpu/                WebGPUEngine 及 Port 实现
  ├── app-ui/                        通用控件与设计 tokens
  ├── widgets/                       工作台组件
  └── charting/                      KPI 图表
```

具体目录和 package 名以 `engineering/10-REPOSITORY-SOLUTION-LAYOUT.md` 与 `engineering/15-FRONTEND-AND-WEBGPU-PROJECTS.md` 为准；不再维护第二套同义目录。

React 仅持有应用状态/选中实体/仪表盘视图，**不**直接存储数千 Babylon Mesh 或每条设备事件触发 React 组件树重渲染。场景管理对象生命周期独立于 React 状态生命周期。

## 3. 坐标与模型标准

- 3D 场景采用右手坐标，`+Y` 向上；1 单位 = 1 米。Babylon 场景创建时显式设置 `scene.useRightHandedSystem = true`；原始厂区坐标系、模型坐标转换和测量单位要在资产元数据声明，避免导入与实例化时重复转换。
- 模型交换统一 glTF 2.0 / GLB；GPU 材质应显式兼容当前 Babylon WebGPU 管线和物理材质。可选 KTX2/Basis、Draco、meshopt 压缩须纳入浏览器/引擎测试。
- `FabTemplateVersion` 包含可复用静态几何、建筑布局与设备插槽；`FabUnit` 实例化独立根 Transform、EntityId 与动态状态缓存。
- Site View 仅加载低 LOD 建筑/关键路径/汇总告警；Fab View 加载可见 Bay；设备 View 按需加载 Chamber/Port 细节，不默认同时加载三个 FAB 的全部细节。
- 共享设备 GLB/材质/纹理的 GPU 资源，实例 ID 与业务状态不得共享；避免跨 FAB 渲染状态串扰。

## 4. 高性能管线

- 分层 LOD、视锥裁剪、空间索引、可见集、批量动态实例属性更新（按实体变化合并）。
- 大量同类设备优先普通 Instancing 或 Thin Instances；需要单对象复杂动画时退化为独立 Mesh，按测量选用。
- 采用 GPU picking / ID buffer 或可测量的 CPU picking；禁止全场景每帧遍历所有设备复杂几何。
- GPU Shader 使用 WGSL；Compute Shader 仅用于可证明能加速的可视化计算，不承载权威生产状态。
- 分离 RenderClock / SimulationClock；回放时间线插值只能影响展示，不得写回权威 DES。
- 提供 GPU 资源监控、纹理压缩、内存与 draw-call 分析，GPU 设备丢失后重新创建资源并请求最新快照。

## 5. 性能指标与验收方式

建议首批候选目标（待目标硬件冻结后升级为合同指标）：目标基线 GPU/浏览器下 Site View 稳定 60 FPS，首屏 p95 < 5 s，典型操作响应 p95 < 100 ms；高密度单 FAB 与三 FAB 同屏应分别单独压测，明确分辨率、像素比、设备数、活跃实体比例、纹理预算及事件更新率。未指定硬件时这些只是目标而不是事实。

CI：TypeScript strict/ESLint/Vitest/Playwright；自托管真实 GPU Windows Runner 执行 WebGPU 可用性、帧率、资源泄漏、Device Lost 和禁用 WebGL 断言。使用普通无 GPU 云 Runner 的结果不能代替性能验收。
