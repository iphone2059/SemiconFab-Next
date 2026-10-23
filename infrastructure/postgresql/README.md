# PostgreSQL 接入起点

`001_reference_seed.sql` 来自已审阅 v1.1 规范，只是约束与单表 RLS 的参考种子，尚未作为本应用的迁移执行。当前可运行切片使用显式的 Development 本地文件元数据适配器；API/Worker 在其他环境拒绝启动。

接入生产存储前需实现各 Owner 的 schema 迁移、完整 RLS/角色、事务 Outbox/Inbox、执行域租约和 fenced 提交、幂等 tombstone、备份恢复及真实 PostgreSQL 负测。不得把数据库容器启动或参考 SQL 存在当作这些门禁通过。
