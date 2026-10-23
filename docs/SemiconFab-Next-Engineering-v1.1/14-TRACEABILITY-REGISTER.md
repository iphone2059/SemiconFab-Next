# 14 — 系统需求 → 设计 → 标准 → 测试追踪矩阵

> 该矩阵是架构与研发验收基线，非外部标准审计结论。每项证据 URL/路径均应由 CI 或审核人上传，未产生的证据状态标记 `NOT_ASSESSED`。

| 需求 ID | 设计证据 | 测试用例 | 行业标准关联 | 初始状态 |
|---|---|---|---|---|
| REQ-001 N FAB | 03, 04, 07 | SHARED-007 | ISA-95 | NOT_ASSESSED |
| REQ-002 同一模板 | 04, 07 | TEST-P0-002 | ISA-95 领域层次 | NOT_ASSESSED |
| REQ-003 FAB 状态隔离 | 04, 05, 06 | TEST-P0-003, SHARED-001 | ISA-95 + 本项目约束 | NOT_ASSESSED |
| REQ-004 Site KPI | 07, 08 | TEST-P0-012 | SEMI E10/E79 | NOT_ASSESSED |
| REQ-005 可配置共享资源 | 06, 07 | SHARED-002 | 厂务业务合同约束 | NOT_ASSESSED |
| REQ-006 运行版本不可变 | 03, 05, 07 | TEST-P0-013 | 可重复性/审计 | NOT_ASSESSED |
| REQ-007 状态机合法性 | 04, 10 | TEST-P0-014, TEST-P0-011 | E30/E40/E87/E90/E94 | NOT_ASSESSED |
| REQ-008 决定性回放 | 05 | TEST-P0-001 | 科研复现实验要求 | NOT_ASSESSED |
| REQ-009 崩溃恢复 | 05, 07, 11 | TEST-P0-006 | IEC 62443 安全可用性 | NOT_ASSESSED |
| REQ-010 WebGPU Only | 09 | TEST-P0-008 | W3C WebGPU / 项目约束 | NOT_ASSESSED |
| REQ-011 协议渲染解耦 | 03, 09, 10 | TEST-P0-015 | E5/E30/E37 | NOT_ASSESSED |
| REQ-012 现场只读 | 10, 11 | TEST-P0-016 | SEMI E187 / IEC 62443 | NOT_ASSESSED |
| REQ-013 跨 FAB 搬运禁用 | 04, 06, 10 | TEST-P0-007 | MES/Carrier 业务定义 | NOT_ASSESSED |
| REQ-014 契约版本化 | 08 | TEST-P0-017, TEST-P0-020 | 内部 API 契约 | NOT_ASSESSED |

## 共享模式附加合规条目

| 需求 | 证据 | 测试 | 通过定义 |
|---|---|---|---|
| SiteResource 权威仲裁 | 06 的时序规则 | TEST-P0-004/005 | 不超配、可重放 |
| 权限与资源范围 | 07 RLS、11 RBAC | TEST-P0-009 | 不得越权 |
| 故障/撤销/恢复 | 05+06 | SHARED-004/005 | 不重复授予、不负容量 |
| 共享与独立 A/B 比较 | 05+06+12 | Scenario 实验验收 | 同样基线、可解释差异 |
| 执行域租约与 fencing | 11、engineering/12、engineering/13 | TEST-P0-018 | 不独占整个独立 Run、不接受过期提交 |
| 数据隔离失败关闭 | 07、engineering/13、SQL 示例 | TEST-P0-019 | 缺失权限不放行，不串用连接池上下文 |
| 前端投影流与整数精度 | 08、engineering/14、engineering/15 | TEST-P0-010/020 | 可重同步、不误判过滤造成的序号跳跃 |
| 多 Run 资源隔离 | 05/06、M07/M08/M09 | SHARED-009 | 同一资源定义的不同实验不争用模拟账本 |
| 多资源原子分配与降容 | 06、engineering/12、M08 | SHARED-010 | 不部分占用等待，每个提交边界不超配 |
| 活动资源授权整体恢复 | 05/06、engineering/12 | SHARED-011 | 等待/授予/去重记录与 FAB 一致恢复 |
| 成员控制与 Run 汇总 | engineering/12、M09 | TEST-P0-021 | 局部暂停/停止不伪造整个 Run 的终态 |

## 证据登记记录模板

```
RequirementID:
ImplementedBy: commit/review URL
Standard: designation / exact edition / clause (licensed copy reference)
TestCaseID: test suite / case id
RunEnvironment: OS, GPU, browser, .NET, PostgreSQL, HW
ObservedResult: PASS / FAIL / NOT_ASSESSED / NOT_APPLICABLE
EvidenceURI: artifact with checksum
ReviewedBy:
ReviewedAtUTC:
```

未经证据更新，表中所有 `NOT_ASSESSED` 不可被项目宣传、投标、客户报告替换成 `PASS`。
