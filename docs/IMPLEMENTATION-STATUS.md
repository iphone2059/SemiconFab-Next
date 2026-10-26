# 实施状态

2026-10-24 最终布局：前端 9 包 → 1 个站点（ADR-0003）；共享库与仿真内核 → 单一 `fab_shared`（ADR-0004/0005）；全部域服务、平台服务与宿主 → 单一 `fab_app`，测试 → 单一 `fab_tests`（ADR-0006）。当前 .NET 项目 3 个、前端项目 1 个；C# 命名空间保持 `Fab.*` 不变。

首切片：框架、独立仿真、本地开发编排、React/WebGPU。其余能力待实现；本地文件适配器仅限 Development，不能声明 PostgreSQL/工业协议/共享容量已验收。

后续迁移首批已实现设备目录的数据导入、完整原文件保留、只读 API、目录/详情/对比页面；前端源码、测试和资产已分开。功能状态、验证证据及待办以 [迁移实施记录](migration/progress.md) 为准；这不代表 44 项原版功能全部迁移完成。

## V2.1 架构基线（2026-10-27）

- 基线文档：[架构基线](architecture.md)、[ADR-0009](adr/0009-tanstack-router-query-boundary.md)、[ADR-0010](adr/0010-command-event-bridge.md)，以及 [路由与查询集成](router-query-integration.md)、[状态管理](state-management.md)、[实时协议](realtime-protocol.md)、[命令事件桥](command-event-bridge.md)、[命令核对](command-reconciliation.md)、[FAB 运行时](fab-runtime.md)、[渲染管线](rendering.md) 7 篇专项文档。
- 状态：**文档基线已采纳，代码迁移未开始**。当前前端仍是 ADR-0008 的 Redux Toolkit + RTK Query、`src/main.tsx` 自定义 pathname 切换、单 FAB Babylon Lite 1.36；未安装 TanStack Router/Query、Zustand、XState、RxJS、Zod，没有实时命令管道，后端 `--realtime` 仍是占位模式。本基线不改变这些事实，也未新增依赖或改动 Vite 配置。
- 验证：ARCH-01..12、RQ-01..05、CE-01..08 均已定义，当前标签为 **SPECIFIED / NOT RUN**；本文件与 V2.1 文档不提供任何通过证据，也不改变既有功能迁移结论。
- 迁移阶段、里程碑、风险与开放问题见 [架构基线](architecture.md) 的 §10–§14。功能迁移的既有状态仍以 [迁移实施记录](migration/progress.md) 为准；本次未修改该记录及相关迁移路径。
