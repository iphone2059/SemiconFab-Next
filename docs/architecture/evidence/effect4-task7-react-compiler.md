# Task 7：Rust/Oxc React Compiler 接入与验收

- 执行日期：2026-10-29（Asia/Singapore）
- 分支：`refactor/effect4-flat-20261029`（基于 Task 6 `06a933e`）
- 实现：`@vitejs/plugin-react@6.1.2` 的 `compiler` 选项 → **`oxc-transform-react@0.156.0`**（Oxc/Rust，非 Babel）
- 静态门禁：`oxlint@1.90.0` + `web_app/.oxlintrc.json`（`plugins:["react"]`，`correctness:"error"`）
- 领域/架构不变：Effect 4 AppRuntime/AtomRegistry、Resource Atom、XState、code-based routing、严格单层目录均未改

## 1. 接入配置

```ts
// web_app/vite.config.ts
plugins: [react({ compiler: { target: '19', compilationMode: 'infer', reportDiagnostics: true } })],
```

- 未安装 `babel-plugin-react-compiler`、`@rolldown/plugin-babel`、`@babel/core`、`@types/babel__core`；未使用 `reactCompilerPreset`；未启用 Babel 管线。
- 未安装 React 17/18 的 `react-compiler-runtime`；React 19 从 `react/compiler-runtime` 导入。
- 原有 server/proxy/build/test 选项、alias、WebGPU chunk、端口和 `testTimeout` 未变；无 `tanstackRouter` 插件。
- Vite 与 Vitest 共用同一 `vite.config.ts` React 插件实例，未重复调用 `transformSync`。

### Peer 元数据偏差（已验证并显式登记）

`@vitejs/plugin-react@6.1.2` 的 optional peer 声明为 `oxc-transform-react@^0.152.0`（0.x caret 实际只允许 0.152.x），而本次候选为锁定 `0.156.0`。因此：

- `pnpm peers check` 初始报告 unmet peer；
- 在 `web_app/pnpm-workspace.yaml` 增加显式 **`peerDependencyRules.allowedVersions: { oxc-transform-react: '0.156.0' }`**，并完成 Windows x64 原生 binding、构建、transform fixture、全量测试与真实浏览器验证；
- 当前 `pnpm peers check` 为 **No peer dependency issues found**。该偏差属于插件 peer 元数据而非实际 API 不兼容，仍作为合并评审项保留。

## 2. 转换证明（8.3）

新增 `web_app/tests/architecture/oxc-react-compiler.test.ts`（4 测试）：

1. 用锁定的 `oxc-transform-react` 直接编译真实 TSX fixture：
   - `fatal === false`；
   - 输出包含 `import { c as _c } from "react/compiler-runtime"` 与 `_c(...)` 调用；
   - JSX 走 `react/jsx-runtime`；
   - 不断言缓存变量编号或整文件字节。
2. 静态验证 Vite 只有一个 Oxc compiler 管线、参数精确匹配且无 Babel/router plugin。
3. manifest/lockfile 中无 Babel compiler 包解析、存在精确 `oxc-transform-react@0.156.0`/`oxlint@1.90.0`，且 `lint` 脚本存在。
4. `.oxlintrc.json` 的 React correctness 配置固定。

构建日志 `docs/architecture/evidence/perf/task7-compiler-build.log`：构建 exit 0；出现 7 行可恢复诊断（try/finally、import 表达式、既有规则 suppression 导致个别函数跳过优化），无 fatal。**不以 build 通过声称所有组件都已优化**。

## 3. Oxlint 规则修复（46 → 0）

第一次 `oxlint src`：**46 errors / 19 files**，全部修复，无 suppress/关闭规则：

| 规则 | 数量 | 典型修复 |
|---|---:|---|
| `react-hooks(exhaustive-deps)` | 35 | 去掉不必要的 registry 依赖；把派生 search 值改为 primitives；稳定 entries/sites 数组；ref 生命周期改为 layout effect / module helper |
| `react(refs)` | 5 | render 期 ref 写入改为 `useLayoutEffect`；GPU mount 的 translator/fabCode 改用 layout-updated refs（避免重建 scene） |
| `react(set-state-in-effect)` | 2 | runtime-provider 改 `useSyncExternalStore`；Workbench fabIndex 移入 Atom reducer 并随 site 重置 |
| `react(purity)` | 2 | render 期 `Date.now()` 移出 render（inspector effect / projection 只读 Atom） |
| `react(use-memo)` | 1 | `useMemo(createToolStateMerger, …)` → inline callback |
| `eslint(no-control-regex)` | 1 | idempotency key 控制字符校验改为逐字符 codePoint 判定 |

最终：**0 warnings / 0 errors，201 files / 88 rules**；已加入 `verify.ps1`（在 typecheck 之后、test 之前执行）。

## 4. 编译器正确性缺陷与修复

任务中真实发现并修复了 3 类 Oxc/Compiler 引发的运行时问题（均有测试/浏览器验证）：

1. **BigInt 字面量/reduce 误编译**：Workbench 的 `fabs.reduce((sum, fab) => sum + BigInt(fab.completedLots), 0n)` 被编译为 `reduce(callback, undefined)`；即使改写显式 `0n` 初始化循环，组件内仍出现 `completedLots = undefined`。修复：把 BigInt 累加移到组件外的 `sumCompletedLots(fabs)` 普通函数；S1/S4 从失败转为 PASS。
2. **可变 Registry 读取被 memoize**：`useTelemetry` 中 `registry.get(fabId)` 的返回值在 registry 内容变化后仍为 undefined；`Workbench` 读取 `runtimeRegistry.size` 也一样。修复：
   - `FabTelemetryRegistry` 增加 subscription + `useSyncExternalStore`；
   - RuntimeProvider 暴露 `useFabRuntimeVersion()`，Workbench 以 context version 使 size 读取失效；
   - 相关运行时测试由 0 telemetry consumers / 缺 XSTATE RUNTIMES 恢复为 PASS。
3. **OXC 未支持构造导致跳优化**：try/finally、动态 import 等函数被跳过（可恢复诊断）。保留原语义，不以诊断为空作为目标。

这些是 Oxc React Compiler **experimental** 状态的实测风险；未做 suppress，均通过代码结构调整修复。

## 5. 基线（Compiler OFF，`06a933e`）

- typecheck：PASS；Vitest：**121 文件 / 722 测试 PASS**；build：PASS。
- 浏览器 e2e：10/10 × 3 轮 PASS（`task7-e2e-off-run1..3.json`）。
- 渲染：dev / 60Hz 各 3 轮（§6）；bundle：§7。
- Task 6 最终 verify 日志（`effect4-final-acceptance.md`，代码等同 `06a933e`）exit 0；本轮又用同一 OFF worktree 重新确认 typecheck/test/build。

## 6. 渲染 A/B（600 帧，同机同 Chrome，交替 3 轮）

### dev profile

| 指标（median） | OFF | ON | 变化 |
|---|---:|---:|---|
| avg frame | 8.39 ms | 8.38 ms | −0.01 ms |
| p95 | 8.5 ms | 8.5 ms | 0 |
| p99 | 8.6 ms | 8.5 ms | −0.1 ms |
| ready / first frame | 3193.7 / 3199.8 ms | 3195.2 / 3201.5 ms | +1.5 / +1.7 ms（噪声内） |
| heapGrowth（600 帧） | 9.76 MB | 11.43 MB | +1.67 MB（单轮抖动大；均远低 32 MB） |
| drawCalls | 905 | 905 | 0 |
| failures / gpuErrors | 0 / 0 | 0 / 0 | 0 |

### 60Hz profile

| 指标（median） | OFF | ON | 变化 |
|---|---:|---:|---|
| avg frame | 8.46 ms | 8.38 ms | −0.08 ms |
| p95 | 8.5 ms | 8.5 ms | 0 |
| p99 | 16.6 ms | 8.6 ms | −8.0 ms |
| ready / first frame | 3717.4 / 3723.6 ms | 3711.9 / 3722.4 ms | 持平 |
| heapGrowth | 2.89 MB | 11.59 MB | 单轮波动，仍低阈值 |
| drawCalls | 905 | 905 | 0 |
| failures / gpuErrors | 0 / 0 | 0 / 0 | 0 |

结论：渲染帧时间无退化；heap 单轮区间重叠（ON 0–11.75 MB，OFF 2.66–3.59 MB 在 60Hz；dev 1.53–12.43 MB），不足以声称内存改善，也不构成超阈值回归。

## 7. Bundle 与编译时间

同一 Vite 8.3.5 生产构建：

| 指标 | OFF | ON | 变化 |
|---|---:|---:|---|
| JS raw | 3,238,334 B | 3,317,946 B | +79,612 B（+2.46%） |
| JS gzip | 610,812 B | 643,596 B | +32,784 B（+5.37%） |
| CSS raw/gzip | 121,099 / 20,863 B | 同 | 0 |
| all gzip | 633,414 B | 666,198 B | +5.17% |
| build 时间 | 900 ms | 954 ms | +54 ms（+6.0%，单轮；verify 内 855 ms，抖动明显） |

开销主要来自 `index` 与 `twin-page` lazy chunk 注入的 compiler runtime/memo cache；React Babel compiler 未参与。gzip 增长是明确的构建期成本，合并前应接受。

## 8. 真实浏览器回归与 React commit A/B

浏览器 e2e（3 轮交替、每轮 10 场景）：OFF **30/30 PASS**，ON **30/30 PASS**。场景覆盖 Workbench/Run/错误边界、Catalog 筛选/比较/导入导出/历史、Twin DEMO/实时/REST/SSE/断线、StrictMode 应用入口（`main.tsx`）、FAB 错误、404、退出重进连接卫生。

通过注入 React DevTools hook 统计每场景 commit 数（`task7-e2e-summary.json`）：

| 指标（3 轮 median） | OFF | ON | 变化 |
|---|---:|---:|---|
| 全部场景 commits 合计 | 196 | 190 | −3.1% |
| 全部场景主线程 TaskDuration 合计 | 5093.8 ms | 4085.7 ms | −19.8%（CDP 单轮波动大，不作通用性能承诺） |
| 场景通过数 | 30/30 | 30/30 | — |

逐场景 commits 中位：S1 14→13，S2 22→21，S4 69→69，S5 12→11，S10 17→12；Twin/S6-S9 基本不变。EventSource/Worker 数量逐场景不变（S6/S7/S10 2 EventSource、1–2 Worker）。

未把“−19.8% task duration”宣传为普遍加速；仅记录为同机、同场景、3 轮脚本化 e2e 的观测值。

## 9. 门禁与验证

- `verify.ps1` exit **0**，日志：`docs/architecture/evidence/perf/task7-verify.log`（421 行，含 Oxlint 0 warnings/errors、122 文件/726 测试、.NET 180/180、typecheck/build）。
- 新增 compiler fixture/gate：`web_app/tests/architecture/oxc-react-compiler.test.ts`（4 tests，verify 内执行）。
- `pnpm lint` = `oxlint src`；`verify.ps1` 强制该步骤。
- 未 push / 未 merge。

## 10. 已知边界

- Oxc React Compiler 仍标 **experimental**；build 可恢复诊断表明部分函数被跳过，未声称全量组件均优化。
- Oxc 0.156.0 的 BigInt/reduce 误编译是实测缺陷；通过组件外 helper 规避，升级版本后应回归验证。
- e2e TaskDuration 单轮波动大，严格结论以 3 轮中位数与区间为准；线程/GC 噪声无法完全消除。
- 真实 GPU 设备丢失、分钟级长稳内存不在本任务范围（沿用 Task 6 边界）。
- 本次未删除现有手写 useMemo/useCallback/memo；后续可在单独任务中按测量逐处移除。
## 11. 手写 memoization 清理（Task 7 后续，2026-10-29）

在 Compiler ON 通过 Oxlint/测试/浏览器门禁后，对 `useMemo/useCallback/React.memo` 做逐项清理：

- 初始统计：**87 处**（68 useMemo、18 useCallback、1 React.memo）。
- 最终保留：**8 处**；删除 **79 处**，无 suppress。
- 全程保持 `oxlint src` 0 errors、`tsc --noEmit` PASS、**122 文件 / 726 测试 PASS**。

保留项均为**外部身份/生命周期约束**，不是纯优化缓存：

| 位置 | 保留原因 |
|---|---|
| `twin/twin-equipment-status-pipeline.tsx` `scope` | 对象身份参与 layout effect/scope 依赖 |
| `twin/twin-equipment-status-pipeline.tsx` `batcher` | 100ms 合批器的 timer/取消身份必须跨 render 存活 |
| `twin/twin-page.tsx` `amhsBatcher` | 同上（AMHS 合批 timer） |
| `twin/twin-page.tsx` `mergeToolStates` | 帧循环引用缓存，必须跨 render 保留上一帧数组合并结果 |
| `workbench/use-run-submission.ts` `submissionScope` | ScopeToken/幂等键生命周期 owner |
| `twin/use-tour-controller.ts` `stop` / `cancelTourIfRunning` | 调度器/RAF 会话身份契约，effect 依赖其稳定 identity |
| `twin/use-wafer-playback.ts` `syncWaferHud` | 被播放 effect 依赖，identity 变化会无谓重启 RAF effect |

其余纯派生值/对象/处理器全部交给 React Compiler 自动 memoize（含 catalog 派生列表、Twin 投影/HUD 计算、路由 search 回调、context value、useSyncExternalStore 回调等）。

验证（当前工作树）：

- `verify.ps1` **exit 0**：Oxlint 0 errors、122/726 测试、typecheck、build、.NET 180/180；
- 真实浏览器 e2e **10/10 PASS**（`task7-memo-removal-e2e.json`）；
- 渲染 smoke：600 帧，p95 **8.5 ms**、p99 **8.6 ms**、drawCalls **905**、failures []；
- bundle 相对“Compiler ON + 手写 memo”版本：JS raw **−5,723 B**、gzip **−2,194 B**（`task7-memo-removal-bundle.json`）；
- e2e 全场景 React commit 数 188（清理前 3 轮中位 190），无场景回归。

注意：首次 verify 遇到一次既有后端 `IdempotencyReplayAfterPruneCreatesFreshCommand` 失败，重跑即时通过（记录为后端测试 flake，与本轮前端 memo 清理无关）；最终 verify log 为 `task7-memo-removal-verify.log`。

结论：**可以删除，且已删除 79/87**；剩余 8 处不能按编译器优化删除，必须保留其外部生命周期/identity 语义。
