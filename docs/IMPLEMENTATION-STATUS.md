# 实施状态

2026-10-23 布局重建：按 [ADR-0001](adr/0001-flat-project-layout.md) 改为根级扁平、全小写+下划线、无总 solution、逐项目独立构建；代码与测试从基线提交原样迁移，C# 命名空间保持 `Fab.*`。

首切片：框架、独立仿真、本地开发编排、React/WebGPU。其余能力待实现；本地文件适配器仅限 Development，不能声明 PostgreSQL/工业协议/共享容量已验收。
