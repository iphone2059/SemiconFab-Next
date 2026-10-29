# 第二轮正确性整改：验收矩阵与执行顺序（Round 2）

- 审查基线：`main@9ab2fd3f3cc5304f030dbf7f8e46a414ccd4ebda`（2026-10-29 18:23 UTC）；对照基线 `1fb25ff`。
- 来源：第二轮审查报告（CR-01…CR-10）。本文件把每个缺陷映射到冻结 ADR、执行阶段与可执行验收；未重跑前不得标 PASS。
- 规则：只允许新增/加强断言，不允许降低阈值、放宽超时或加兼容层收尾；每项修复必须先有 RED 证据（或证明旧测试覆盖缺口）再有 GREEN；所有证据绑定最终 commit SHA。

## 1. 缺陷 → 阶段 → 验收映射

| ID | 缺陷 | ADR | 阶段 | 必做验收 |
|---|---|---|---|---|
| CR-01 | SSE 队列满后游标前进导致恢复跳过丢帧 | ADR-010 | F2 | 矩阵 1（capacity 4 + 100+ 帧 + 混合终态；dirty 精确 gapStart/delivered；acknowledged 不回退） |
| CR-02 | journal 无 epoch、单页恢复 | ADR-010/012 | F2+F3 | 矩阵 2（1/256/257/1000 页、epoch 替换 409、跨 FAB、空洞、重复页；循环到 latest） |
| CR-03 | 幂等/记录/journal 三写非原子 | ADR-012 | F3 | 矩阵 3（每个提交边界故障注入 + 重启；202 后同 key 返回同 commandId；无部分状态） |
| CR-04 | scheduler timeout 不取消底层网络 | ADR-011 | F4 | 矩阵 4（永不 resolve fetch 超时后 abort、物理 ≤4、旧结果不写 actor） |
| CR-05 | 通用 GET 覆盖更新的 mutation/recovery | ADR-013 §1.1 | F5 | 矩阵 5（GET-old/mutation-new/GET-old；双 Runtime 独立；设备 accept 不回归） |
| CR-06 | 恢复失败清 Dirty、无重试 | ADR-010 §4 | F2 | 矩阵 6（5xx 断续 Dirty 保持；恢复后自动补偿；无新 SSE 也可恢复；Unrecoverable 可见） |
| CR-07 | 同 key 异构定义静默混淆 | ADR-013 §1.2 | F5 | 矩阵 7a（kind/version 冲突抛错；TTL 释放后合法重建） |
| CR-08 | GPU 无限重建直至 descriptor heap OOM；scheduler overflow 二级容量截断 | ADR-011 §2.2 + F6 | F4/F6 | 矩阵 8（device-loss retry budget/circuit breaker：超预算 fail-closed 并完整释放；GPU 门禁 600s 内不进 OOM；溢出意图由持久 Dirty + 权威列表兜底） |
| CR-09 | 容量双水位永远无法到达 512 | ADR-013 §1.3 | F5 | 矩阵 7b（单一 256 硬限；边界/重入/并发） |
| CR-10 | 轮询 fork 回调缺 generation 校验 | ADR-013 §1.4 | F5 | 矩阵 7c（1000 次 retain/release 交错，pollFiber 唯一且无旧写） |

## 2. 必须追加的验收矩阵（定义）

1. **SSE 有界与丢帧恢复**：capacity 4/16/256；乱序、重复、overflow、gap 与终态混合；最终逐命令与后端权威一致；dirty 携带精确 delivered/gapStart；acknowledged 单调不回退；恢复后无命令状态丢失。
2. **Journal 分页与 epoch**：1/256/257/1000 条；epoch 替换；跨 FAB 稀疏序号；重复页/断页/空洞；断言无跳页、无重复应用、无静默 gap。
3. **持久化故障注入**：record/idempotency/journal/outbox/commit/response 每个边界注入故障；重启后：未确认前缀重试可产生一次新命令；已返回 202 的同 key+payload 返回同 commandId（保留窗口内）；无部分状态对外可见。
4. **物理取消**：永不 resolve 的 HTTP 在 timeout/dispose 后收到 abort；并发混合入口物理在途 ≤4；超时后的旧结果不得写 actor；不泄漏 permit。
5. **通用资源提交**：GET-old / mutation-new / GET-old，old 不得覆盖 new；每 AppRuntime 资源独立。
6. **恢复状态机**：恢复 API 断续 5xx 期间 Dirty 不清；网络恢复自动补偿；无新 SSE 事件时也可恢复；Unrecoverable 有界且可观察。
7. **资源身份/容量/轮询 generation**：7a 类型化身份冲突；7b 单一 256 容量边界；7c 1000 次 retain/release 交错无旧 fiber 夺取。
8. **GPU 安全退化 + 编译/浏览器**：大量设备丢失/进程崩溃时成功恢复或受控 fail-closed，不得非受控 descriptor heap 耗尽；Compiler ON/OFF 状态机业务等价 + 生产 bundle e2e。

## 3. 执行顺序

- **F1 规范冻结**：ADR-010/011/012/013 + 本矩阵；冻结接口 DTO/游标/容错语义。
- **F2 SSE/恢复重建**：transport 三游标 + bounded 队列 + dirty 精确缺口；FabRuntime 恢复状态机 + 多页 epoch journal 循环 + 权威 list 兜底；测试矩阵 1/2(前端)/6。
- **F3 事务持久化**：SQLite WAL + 唯一幂等 + 单事务提交 + outbox/response 重放；epoch 感知 journal API/nextAfterSequence；kill/重启故障注入；矩阵 2(后端)/3。
- **F4 取消与预算**：Gateway 原生 Effect 可取消；scheduler 真实 timeout + 物理预算 4 + 旧结果守卫；矩阵 4；与 F2 共享恢复预算。
- **F5 资源不变量**：通用提交 superseded-write；类型化 identity；单一 256；poll generation；矩阵 5/7。
- **F6 安全退化与端到端**：GPU device-loss retry budget/circuit breaker（诚实 fail-closed、完整释放）；Compiler ON/OFF 与生产 bundle e2e 回归；矩阵 8。
- **F7 最终签收**：`scripts/verify.ps1`（含新矩阵测试 + 生产浏览器 + GPU gate）绑定新 HEAD SHA，原始日志与证据；不得引用旧通过记录。

## 4. 证据规则

- 每个阶段写 `docs/architecture/evidence/round2-<phase>-*.md`：命令、原始输出、RED→GREEN 对照、seed/注入点、限制。
- 最终签收：`final-verify.json` + 原始 `final-verify-<sha>.log` + `correctness-refactor-acceptance.md` Round 2 章节；所有引用写新 SHA。
- 若某矩阵项无法在环境内验证（如真实进程 kill），必须写“未验证/限制”与替代证据，不得标 PASS。
