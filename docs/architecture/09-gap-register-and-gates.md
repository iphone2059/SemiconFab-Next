# 09 架构缺口登记、阶段门禁与环境约束（Phase A 冻结）

- 状态：Accepted（Phase A，2026-10-29）
- 基线：`1fb25ffc36b5b65813f031c8d889063964b4d1bd`；基线 verify.ps1 exit 0（122 测试文件/726 前端测试；后端 180 测试）。仅作历史证据，不证明本规范的不变量。
- 关联：`05-correctness-first-target-spec.md`；ADR-006/007/008。

## 1. 缺口登记（Gap Register）

| ID | 缺口（源码可证） | 不变量 | 阶段 | 可执行验证 |
|---|---|---|---|---|
| G01 | `api/resource.ts` 模块级 WeakMap 跨 Runtime 共享 in-flight | INV-01 | B | CORE-001 |
| G02 | `resourceFamily` 永久 Map；动态 Run 定义无限增长 | INV-06 | B | CORE-006 |
| G03 | `refreshResource` 捕获 previous 并通用 catch 写 Failure | INV-03 | B | CORE-003/004 |
| G04 | equipment accept 拒绝时把 previous 当作成功写回 Atom（P0） | INV-03 | B | CORE-003 |
| G05 | `useResource` 每组件自建轮询 interval | INV-05 | B | CORE-002 |
| G06 | 设备 gate 高水位与 Atom 快照分属两处，activate/reset 时序缺陷 | INV-03/04 | B | CORE-003/005 |
| G07 | `command-stream.ts` 全局 `Effect.runFork`；无 Scope 所有权 | INV-09/10 | C | CORE-008/014 |
| G08 | 单一 workflow Scope，无 per-command 子 Scope；驱逐直接 dispose | INV-09 | C | CORE-008/014 |
| G09 | 三条核对路径/无限流/无队列容量/无取消语义 | INV-08 | C | CORE-007 |
| G10 | `PubSub.unbounded` + 无 overflow gap 协议 | INV-10 | C | CORE-010 |
| G11 | `useCommandProjection` Atom+useState 双源；projectionRegistry 可选 | INV-11 | C | CORE-009 + 架构扫描 |
| G12 | `command-projection.atom.ts` Atom.family 无界 | INV-06 | C | CORE-009 |
| G13 | `state/runtime-store.ts` 命名与 keepAlive 大对象；`twin-page.atom.ts` 过宽 | INV-11/12 | E | 架构扫描 + CORE-011 |
| G14 | 过时测试 mock 引用 `src/features/twin/fab-viewer`；空/失效断言 | INV-14 | E | 负向 fixture + 扫描 |
| G15 | Compiler ON/OFF 无生产 bundle 等价证据；peer 范围靠 `allowedVersions` 放行 | INV-12 | E | CORE-011 + 生产 E2E |
| G16 | 后端命令/journal/幂等仅内存，重启丢失 | INV-13 | D | CORE-013 |
| G17 | 无“按 FAB 列举活动/未确认命令”恢复入口；浏览器刷新不可恢复 | INV-13 | D/C | CORE-013 + E2E 刷新恢复 |
| G18 | CI 无生产 bundle 浏览器 gate、无 GPU gate、无 SHА 绑定证据 | INV-12 | F | verify.ps1 + GPU gate + evidence |
| G19 | GPU 设备丢失/长稳未做真实硬件端到端验证 | INV-10/12 | F | CORE-012 + GPU gate |
| G20 | 旧 effect4 文档/证据与新规范冲突处未标记取代 | INV-14 | A/F | 文档审查（本文件 + README 状态） |

## 2. 阶段门禁（可执行）

### Phase A（本阶段）
- [x] 冻结规范原文（`05-*`）。
- [x] ADR-006/007/008；缺口登记（本文件）。
- [x] 冻结接口签名与身份/状态转移表（ADR-006 §2.8、ADR-007 §3、本文件 §3）。
- [x] 基线 verify.ps1 记录（exit 0）。
- Gate：接口/身份仍有歧义则不得进入 B/C/D；本阶段记录歧义为零（实现细节可在 ADR 修订记录中澄清，不得改变身份/状态语义）。

### Phase B（资源）
- CORE-001..006 先 RED（在基线提交上运行）→ 实现 → GREEN；旧 API 零引用（`rg` 门禁）。
- `pnpm typecheck`、`pnpm lint`、`pnpm test` 通过；资源导入图无第二 registry/runner。
- 证据：`evidence/phase-b-resource-<sha>.md`（RED/GREEN 日志、统计、堆/节点数据）。

### Phase C（命令）
- CORE-007..010、CORE-014 通过；调度器唯一入口架构测试；全局 Effect runner 扫描为 0（白名单=app-runtime）。
- 有界流 overflow → dirty + 调度核对测试；模型测试 seed 记录。
- 证据：`evidence/phase-c-command-<sha>.md`。

### Phase D（后端）
- `CommandPersistenceTests` + CORE-013 通过；`generate_contracts.py --check` 通过；重启/host 重建测试。
- 证据：`evidence/phase-d-backend-<sha>.md`。

### Phase E（UI/Compiler）
- CORE-011 通过；生产 `vite build` + preview 的浏览器 E2E；ON/OFF 业务 trace 等价；无 fallback state；旧 mock 清理。
- peer 兼容性：升级/锁定真正匹配版本，或维护有 CI 证据的补丁；不得只靠 allowedVersions。
- 证据：`evidence/phase-e-compiler-<sha>.md`。

### Phase F（签收）
- `scripts/verify.ps1` 全绿（含新增门禁）；生产浏览器 E2E；GPU gate（本机 + 可选 self-hosted runner）；5–30 分钟长稳；负向门禁；文档清理。
- 未覆盖项必须写“未验证/限制”，不得标 PASS。证据绑定 commit SHA。

## 3. 身份/状态冻结摘要（歧义清零）

- 资源身份：`ResourceKey` 字符串；静态定义不可变；动态定义 manager 有界缓存。
- 资源状态：Initial/Loading/Ready/Refreshing/FailedWithoutValue/FailedWithPrevious（AsyncResult 映射，ADR-006 §2.3）。
- 命令身份：(siteId, fabId, commandId) + 后端单调 revision。
- 设备快照：(siteId, fabId) + epoch:number + sequence:number；只经 EquipmentStatusCommit。
- Scope 身份：App/Resource/Fab(gen)/Transport(conn gen)/Command；关闭 owner 唯一。
- 恢复语义：后端保留窗口内权威恢复（ADR-008）；窗口外明确 404/gap，不是“静默成功”。

## 4. 环境约束（如实记录）

- OS/工具链：Windows 11；Node 26.12.1；pnpm 12.16.1（项目锁 12.15.0，verify.ps1 使用固定安装）；.NET SDK 11.0.100-rc.3；Chrome 已安装；GPU：NVIDIA RTX 3050 Laptop + Intel Iris Xe（WebGPU 用 Chrome/NVIDIA）。
- Rust 工具链（rustc/cargo）不在 PATH：Oxc React Compiler 通过 `oxc-transform-react` npm 包（预编译 Rust 二进制）使用，不需要本机 cargo；不得以“无 Rust”为由关闭 Compiler。
- GPU CI：GitHub 托管 runner 无可用 WebGPU 硬件；本仓库新增 `gpu` workflow 需 self-hosted `[self-hosted, windows, gpu]` runner（若用户/组织未提供，登记为限制并在本机执行 GPU gate，保留原始日志与 SHA）。
- 浏览器 E2E：当前部署默认 1 个 FAB（架构支持 1–32）；浏览器场景可聚焦单个 FAB 渲染，多 FAB 隔离由显式配置的集成测试覆盖；生产构建用 `vite preview`。
- 网络：真实 HTTP/SSE 使用本地 API（127.0.0.1:5080）；不得 mock 生产浏览器 gate 的 HTTP 层。

## 5. 测试基础设施

- 模型/property 测试使用仓库内确定性 PRNG（`tests/support/property.ts`，SplitMix64 + seed 输出 + 最小反例收缩），不新增外部依赖，避免 lockfile/peer 风险；失败必须打印 seed 与最小反例。
- 受控交错使用 `Deferred`/手动 resolve 的 fake transport；fake clock 用 `Date.now` 注入或 vitest fake timers。
- 所有新测试文件放在 `web_app/tests/core/`（CORE-xxx）与各领域目录；后端在 `fab_tests/src/`。
- 证据文件禁止手写 PASS；必须引用可重跑命令与日志路径。