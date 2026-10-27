# 实施状态

2026-10-24 最终布局：前端 9 包 → 1 个站点（ADR-0003）；共享库与仿真内核 → 单一 `fab_shared`（ADR-0004/0005）；全部域服务、平台服务与宿主 → 单一 `fab_app`，测试 → 单一 `fab_tests`（ADR-0006）。当前 .NET 项目 3 个、前端项目 1 个；C# 命名空间保持 `Fab.*` 不变。

首切片：框架、独立仿真、本地开发编排、React/WebGPU。其余能力待实现；本地文件适配器仅限 Development，不能声明 PostgreSQL/工业协议/共享容量已验收。

后续迁移首批已实现设备目录的数据导入、完整原文件保留、只读 API、目录/详情/对比页面；前端源码、测试和资产已分开。功能状态、验证证据及待办以 [迁移实施记录](migration/progress.md) 为准；这不代表 44 项原版功能全部迁移完成。

## V2.1 架构基线（2026-10-27）

- 基线文档：[架构基线](architecture.md)、[ADR-0009](adr/0009-tanstack-router-query-boundary.md)、[ADR-0010](adr/0010-command-event-bridge.md)，以及 [路由与查询集成](router-query-integration.md)、[状态管理](state-management.md)、[实时协议](realtime-protocol.md)、[命令事件桥](command-event-bridge.md)、[命令核对](command-reconciliation.md)、[FAB 运行时](fab-runtime.md)、[渲染管线](rendering.md) 7 篇专项文档。
- 状态：**M1、M2（含 M2c URL/search 清理）已落地并验证；M3–M6 未开始**。TanStack Router 接管顶层路由与 URL/search 状态（最终 URL 见 [架构基线](architecture.md) §4.1；目录筛选/Twin modal/mode/siteId 已迁 Router search），**全部 HTTP 端点由 TanStack Query 独占，RTK Query 已删除；客户端 UI 状态由 5 类 Zustand store 独占，Redux/react-redux/`src/store` 已删除**。旧产品 URL 与重定向已删除（无别名）。已安装 TanStack Router/Query、Zustand 5.0.16、RxJS 7.8.2、Zod 4.6.7、**XState 6.0.0-alpha.70**（用户指示直接用 v6）、jsdom/Testing Library。无实时命令管道（后端 `--realtime` 仍为占位）。Vite 仅新增路由生成插件，`server`/`build` 参数未变。
- 验证：RQ-01..RQ-05 **全部 PASS**（真实 QueryClient + Router 集成测试）；CE-01..08、性能门禁仍 **SPECIFIED / NOT RUN**。M2 实际运行：`tsc --noEmit` 0、`npx vitest run` 58 文件 / 262 测试 PASS、`vite build` 0、`./scripts/verify.ps1` exit 0（含 16 Python 工具、3 .NET 项目 + 67/67、冻结向量门禁）。详见 [架构基线](architecture.md) §15–§18。
- 迁移阶段、里程碑、风险与开放问题见 [架构基线](architecture.md) 的 §10–§14。功能迁移的既有状态仍以 [迁移实施记录](migration/progress.md) 为准；本次未修改该记录及相关迁移路径。
