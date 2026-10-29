# Task 3：Effect Schema 与可取消 HTTP transport（执行记录）

- 执行日期：2026-10-29（Asia/Singapore）
- 基线：`4fc8a94`；前序 Task 0 `b946996`、Task 1 `0d6ff12`、Task 2 `857b5ac`、Task 0 性能基线 `9ccebf3`
- 分支：`refactor/effect4-flat-20261029`
- 权威计划：`docs/architecture/03-migration-plan.md` Task 3；错误/取消语义见 `01-effect4-target-architecture.md` §11
- 状态：Task 3 完成；Zod 已从生产源码、manifest、lockfile 移除

## 1. 迁移内容

来源：旧分支提交 `9d10264`（在旧嵌套布局上已验证的 Effect Schema/HTTP 实现）；本次按 Task 1 扁平布局与 `@/` 别名移植，只保留当前计划允许的过渡适配。

### 1.1 Schema（Effect Schema）

| 文件 | 内容 |
|---|---|
| `src/api/primitives.schema.ts` | `nonEmptyString`、`finiteNumber`、`nonNegativeInteger`、`offsetDateTime`（ISO-8601 + 真实日历日期 + 偏移） |
| `src/api/sites.schema.ts` | Sites DTO 数组（真实 GUID、非空、至少 1 个 FAB） |
| `src/api/catalog.schema.ts` | Catalog 页面/条目、identity/domain/recordId 交叉校验、重复 recordId、count 约束、10000 上限 |
| `src/api/runs.schema.ts` | Run list/summary/results、scenario 定义（UUID、uint64/int64 范围、warmup、重复 FAB、最坏完成时间） |
| `src/api/command.schema.ts` | 设备命令输入/响应、GUID 规范化、identity 匹配、幂等键控制字符限制、outcome 联合 |

- 解码函数统一为 `Schema.decodeUnknownEffect`（HTTP 边界）或 `decodeUnknownSync`（Route search）。
- 所有未知字段策略、GUID 规范化、时间戳格式、ProblemDetails 语义、404 无记录 Option 与原行为保持一致（由迁移后的 API 测试覆盖）。

### 1.2 HTTP transport 与错误通道

- `src/api/http.transport.ts`：唯一 HTTP 策略；同源相对路径、`credentials: same-origin`、`cache: no-store`、禁止浏览器设置开发身份头、`AbortSignal` 传入真实 `fetch`。
- 类型化错误：`NetworkUnavailable`、`HttpFailure`、`IdempotencyConflict`、`InvalidServerResponse`、`CommandIdentityMismatch`、`InvalidRequest`；Schema 解码失败映射为 `InvalidServerResponse`，不进入网络重试。
- `src/api/http-command-gateway.ts`：命令权威查询返回 `Effect<Option<CommandResultEvent>, ApiError>`；404 → `Option.none()`。
- `src/api/commands.mutation.ts`、`runs.mutation.ts`、`api/*.resource.ts`：Effect 化；在 Task 5 迁移资源 Atom 前，Query `queryFn`/UI controller 仍是允许的过渡适配边界（见 §5）。

### 1.3 其他迁移

- `src/routes/route-search.ts`：Effect Schema `StructWithRest`，未知 search key 保留、非法值回退、序列化对称；所有 code route 的 `validateSearch` 使用 `decodeRouterSearch`。
- `src/realtime/message-decoder.ts`：realtime envelope/payload 解码改为 Effect Schema，保留大小上限与 topic/错误语义。
- `src/app/runtime-bootstrap.tsx`、`src/workbench/use-command-console.ts`、`src/workbench/use-run-submission.ts`：按旧提交的迁移方式接入 Effect HTTP，仍为 Task 4/5 前的过渡适配。
- 测试按旧提交迁移并适配扁平路径：`tests/api/*`、`tests/integration/{router-search,query-cache,router-query}`、`tests/realtime/realtime-protocol`、`tests/features/workbench/*`；新增 `tests/api/effect-http.test.ts`（真实 fetch abort、错误分类）与 `tests/types/effect-api-types.ts`（类型级契约）。

## 2. 依赖清理

- `web_app/package.json` 删除 `zod`；`pnpm install` 后 lockfile 中 `zod`/`@zod/*` 节点为 0。
- 新增 `tests/architecture/legacy-dependency-gate.test.ts`：当前激活 Zod 检查（生产源码导入、manifest、lockfile 解析节点）；Zustand/Query/RxJS 规则已建模并在 Task 4/5/6 逐项启用。
- 未提前删除 Query/Zustand/RxJS（按计划留待 Task 4/5/6）。

## 3. 门禁与过渡边界

- `tests/architecture/effect-runtime-boundary.test.ts` 的 `Effect.run*` allowlist 增加 9 个 Task 3 过渡适配文件（6 个 Query resource 适配器 + RuntimeBootstrap + 两个 Workbench controller），注释明确 Task 5 移除；其余业务模块仍禁止执行 Effect。
- R14 删除 Zod 时代的 `catalog.queries` 类型断言 allowlist 条目（新 schema 实现不再需要）。
- 未新增永久兼容层；未在 UI/组件层散布 `Effect.run*`。

## 4. 全量验证（Task 3 提交前）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | pinned pnpm `typecheck` | PASS |
| 全量测试 | pinned pnpm `test` | PASS：**111 文件 / 691 测试** |
| 构建 | pinned pnpm `build` | PASS |
| 完整验收脚本 | `./scripts/verify.ps1` | PASS（VERIFY_EXIT=0；含 frozen install/typecheck/test/build/.NET/架构门禁） |
| legacy dependency gate | vitest `legacy-dependency-gate` | PASS（Zod 源码/依赖/锁文件均为 0） |

## 5. 03 计划 Task 3 退出条件对照

- [x] 无生产代码导入 Zod（gate + grep 0）。
- [x] 所有 API 边界对响应执行类型化解码；未新增 `as`、`String()`、`Number()` 冒充校验（沿用既有已登记边界）。
- [x] Schema 错误不触发网络重试（错误通道映射 + 测试）。
- [x] 取消测试证明真实 `fetch` 收到 abort（`tests/api/effect-http.test.ts`）。
- [x] 生成契约与后端 contract 门禁通过（verify.ps1）。
- [x] 删除 zod 依赖与生产导入；Query/Zustand/RxJS 按计划保留。

## 6. 已知过渡点（Task 4/5 清除）

| 过渡点 | 现状态 | 计划 |
|---|---|---|
| Query `queryFn` 中的 `Effect.runPromise` | 允许在 6 个 resource 适配器与 RuntimeBootstrap/Workbench 两个 controller | Task 5 资源 Atom 接管后删除允许项 |
| `api/equipment-status-bridge.ts` | 仍为 Query cache + gate 协调 | Task 5/6 拆分 |
| `workbench.atom.ts` 等仍为 Zustand store | 未变 | Task 4 |
| RxJS CommandEventSource/Telemetry | 未变 | Task 6 |

Zod 不在此列表：Task 3 已从源码/依赖/锁文件移除。
