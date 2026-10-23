# 实施状态

2026-10-23 布局演进：先按 [ADR-0001](adr/0001-flat-project-layout.md) 改为根级扁平、全小写下划线、无总 solution、逐项目独立构建；再按 [ADR-0002](adr/0002-merge-domain-layers-into-services.md) 把每个流域的三层合并为单一 `*_service`（.NET 项目 65 → 32）。代码与测试从基线原样迁移，C# 命名空间保持 `Fab.*` 不变。

前端由 9 个包合并为单一自包含 `web_app` 站点（[ADR-0003](adr/0003-single-web-app.md)）；共享内核由 10 个库合并为单一 `fab_shared`（[ADR-0004](adr/0004-merge-shared-kernel.md)，.NET 项目 32 → 23）。

首切片：框架、独立仿真、本地开发编排、React/WebGPU。其余能力待实现；本地文件适配器仅限 Development，不能声明 PostgreSQL/工业协议/共享容量已验收。
