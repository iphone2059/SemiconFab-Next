# fab_shared

唯一的共享内核项目，合并自原 fab_ids / fab_contracts / fab_contracts_adapters / fab_messaging /
fab_observability / fab_hosting / fab_configuration / fab_industrial_profiles /
fab_security_policies / fab_optimization_abstractions。

- 稳定 ID 与基础值类型：`StableId.cs`（命名空间 `Fab.Ids`）。
- 版本化公开契约 DTO：`Generated/Contracts.g.cs`（由 `tools/generate_contracts.py` 生成，勿手改）。
- 消息/可观测性/Host/配置/行业 Profile/安全策略/优化抽象：保留命名空间，后续在本项目内实现。

业务服务只依赖本共享内核；共享内核不引用任何业务项目。
