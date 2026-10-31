# Phase E 证据：UI Atom 所有权、源码债务清理、Oxc Compiler 等价与生产 bundle / GPU 门禁

- 状态：实现与本地证据完成；commit SHA 由 Lead 在最终提交后绑定（本文写作时 HEAD = 12ec565，工作树未提交）
- 依据：docs/architecture/05-correctness-first-target-spec.md §4/§5/§6（CORE-011/012）、09-gap-register-and-gates.md G13/G14/G15/G18/G19、Phase A ADR 冻结
- 执行日期：2026-10-30（Asia/Singapore）
- 环境：Windows 11；Node 26.12.1；pnpm 12.15.0（.local/tooling/pnpm/12.15.0 pinned）；.NET SDK 11.0.100-rc.3；Chrome 155.0.8059.86（固定本地安装）；GPU NVIDIA RTX 3050 Laptop（驱动 32.0.16.1692，WebGPU adapter vendor=nvidia/architecture=ampere）+ Intel Iris Xe
- 结论：CORE-011 ON/OFF 生产构建 trace 等价（10 场景、0 差异）；CORE-012 生产 bundle 浏览器回归 9/9 通过、真实 WebGPU 设备丢失/恢复 3/3 通过；Oxc peer 兼容改为“维护补丁 + 可执行 API 门禁”；typecheck 0 error、oxlint 0 warning/0 error、全量 142 files / 793 tests 通过。过程中发现并修复 2 个由 Compiler 缓存行为掩盖的真实缺陷（§4.2），不是仅“跑通”。

---

## 1. Atom 所有权重构（G13 / INV-11 / INV-12）

### 1.1 `state/runtime-store.ts` 删除 → 按 owner 拆分

| 旧 | 新 | Owner / 生命周期 |
|---|---|---|
| `RuntimeState.viewer`（epoch/generation/lifecycle/status/hover/selectionSync，整对象 keepAlive） | `state/viewer.atom.ts`：`viewerSessionAtom`（{epoch?,generation,lifecycle,status}）、`viewerHoverAtom`、`viewerSelectionSyncAtom`；`viewerActions.*`（动作名沿用） | RenderingScope / viewer 生命周期；hover(50ms 合并)与 selection handshake 按更新频率拆出 |
| `RuntimeState.fatalError` | `state/runtime.atom.ts`：`runtimeAtom`（{fatalError?}）、`runtimeActions.fatalErrorSet` | 应用级（app shell / error-boundary） |

- `state/runtime-store.ts` 已删除；全项目 import 更新（src 4 处、tests 7 处；`tests/integration/telemetry-render.test.tsx` 与 `tests/types/store-action-types.ts` 为最小 import/选择器改动，已告知 Lead）。
- `reset-ui-atoms.resetRuntimeState` 现在同时重置 app 与 viewer 三个 atom，现有调用点无需改动。

### 1.2 `twin/twin-page.atom.ts` 按 owner / 更新频率拆分

| 模块 | Owner / 频率 | 状态与动作 |
|---|---|---|
| `twin/twin-page.atom.ts` | FAB-scoped server/session（SSE 100ms 批量） | `TwinFabState`：siteId/siteError/liveStatusScope/liveToolStates/replayBase/statusFeed/mesJobs/inspectorMes；`twinPageActions` 仅 site/live/replay/mes 动作（EquipmentStatusPipeline 使用的 liveScopeActivated/liveSnapshotReceived/statusFeedStale 名称保留，pipeline 文件未改） |
| `twin/twin-page-ui.atom.ts` | 页面 UI（用户交互，低频） | selection/dialogs/sidebar/layerPreferences/oemDialog/archQuery 等 + `twinPageUiActions` |
| `twin/twin-wafer.atom.ts` | Wafer 离散 Actor 投影、HUD 与 follow 偏好 | `TwinWaferProjection` + `twinWaferActions.{projectionSet,hudSet,hudClear,followSet}`；逐帧 SceneCommands 归 `TwinWaferRuntime` |
| `twin/twin-yms.atom.ts` | YMS 分析工具（滑杆/悬停） | `YmsUiState` + `twinYmsActions.yms*` |
| `twin/twin-amhs.atom.ts` | 场景 AMHS 统计（~10Hz） | `twinAmhsAtom` + `twinAmhsActions.amhsSet` |

- 消费者更新：twin-viewer、use-twin-actions、use-twin-slices、use-twin-scene-sync、twin-page、twin-dialogs、twin-sidebar、twin-inspector（FAB MES 仍属页面 atom）、twin-yms、twin-wafer-hud、twin-amhs-hud、twin-wafer-runtime、use-wafer-playback、use-twin-route-state（后两者为 resource-owner 范围；仅 atom import/rename 行，映射已发 resource-owner，未再改动）。
- `tests/support/reset-ui-atoms.resetTwinPageState` 一次重置全部 5 个 page atom，现有集成测试调用点无需改动。

### 1.3 通知面收窄的可执行证明

- `web_app/tests/architecture/atom-ownership.test.ts`（3 用例）：旧模块不存在、`RuntimeState` 仅 `fatalError`、viewer atom 仅 4 字段且无 fatalError、`TwinFabState/TwinPageUiState/TwinWaferProjection/YmsUiState` 字段冻结、action namespace 互斥、`*-store.ts` 命名门禁、每个 `*.atom.ts` 的 keepAlive 对象 ≤12 字段、`LocaleStoreState → LocaleState` 去 Store 命名。
- `web_app/tests/state/atom-notification-surface.test.ts`（5 用例）：订阅 8 个源 atom（不依赖派生 selector 语义），断言 FAB 快照更新只通知 FAB atom；Wafer HUD projection 更新只通知 Wafer atom；逐帧场景写入由 runtime 测试证明不通知 Atom；AMHS 10 次只通知 AMHS；YMS/page-UI 编辑不通知 FAB/wafer；viewer hover/selection-sync 独立于 session；被替换 FAB scope 的迟到帧不产生任何通知。
- 命令：`cd web_app; pnpm test -- tests/architecture/atom-ownership.test.ts tests/state/atom-notification-surface.test.ts tests/architecture/ui-atoms.test.ts tests/architecture/remaining-state.test.ts` → 5 files / 19 tests passed。

---

## 2. 源码/测试债务清理（G14 / spec §5）

- 失效 mock：`tests/integration/twin-spc-strip.test.tsx` 的 `vi.mock('../../src/features/twin/fab-viewer')` 指向不存在的旧路径（mock 从未生效）。已改为 `vi.mock('@/twin/twin-viewer')`，并新增“mock 实际生效”断言（mock 渲染 `.scene.twin-canvas`，真实 FabViewport 会渲染 `<canvas>`，断言无 canvas）。该文件无其他 owner（Lead 已授权单文件修改）；`tests/integration/equipment-status-*`（resource-owner）未改。
- 扫描：对 `tests/features/**`、`tests/state/**`、`tests/components/**`、`tests/architecture/**` 共 37 个测试文件做 `vi.mock` 目标解析（相对路径按测试文件所在目录 + `@/` 别名），结果 `unresolved-mock = 0`；`it.skip/only`、无断言文件为 0。
- 同步更新的测试：ui-atoms（12 atom 快照）、remaining-state（Wafer projection / Tour 字段门禁）、fab-viewer-callbacks、wafer-playback-registry（twinWaferAtom）、oxc-react-compiler（生产 TSX 全量扫描 + peer 补丁门禁）、tests/types/store-action-types。

---

## 3. Oxc peer 兼容（G15）

### 3.1 registry / upstream 事实（2026-10-30 抓取）

- https://registry.npmjs.org/@vitejs/plugin-react ：latest = 6.1.2，peer `oxc-transform-react: ^0.152.0`；其 main 分支（未发布）package.json devDependencies 已是 `oxc-transform-react: ^0.155.0`（https://raw.githubusercontent.com/vitejs/vite-plugin-react/main/packages/plugin-react/package.json）。
- https://registry.npmjs.org/oxc-transform-react ：latest = 0.156.0；版本线 0.152.0 … 0.156.0（无 0.152.x patch 版；无任何 plugin-react 发布声明 ^0.156）。
- 结论：不存在官方 peer 覆盖 0.156.0 的发布组合；按 spec §4 “维护有 CI 证据的版本补丁”处理，**不降级**（降级会丢失 0.153–0.156 的修复，属 Lead 明确不同意的“强行降级”）。

### 3.2 实施

- 删除 `pnpm-workspace.yaml` 的 `peerDependencyRules.allowedVersions`（无 bypass）。
- 新增维护补丁 `web_app/patches/@vitejs__plugin-react@6.1.2.patch`：仅把安装包的 `peerDependencies.oxc-transform-react` 从 `^0.152.0` 改为 `>=0.152.0 <0.157.0`；`pnpm-workspace.yaml` 以 `patchedDependencies` 固定，lockfile 记录 patch hash `1d30e13c54dc4069336c477b98c7db2303ec5a1ed76499145a451aa1c3119a01`。
- 可执行 API 兼容门禁 `tools/compiler_compat.mjs`（无依赖，11 项检查，支持 `--out` JSON）：
  - 锁定版本 0.156.0（package/lock/installed 三处）；
  - 无 peerDependencyRules/allowedVersions；补丁在 workspace/lock/安装清单三处生效且与上游元数据偏差可审计；
  - 插件 dist 真实消费 API：动态 `import("oxc-transform-react")`、`await transform(...)`、reactCompiler/jsx/sourcemap 选项、`result.fatal/errors/code`；无 Babel fallback 安装/声明/引用；
  - 真实调用：`transformSync/transform` 在插件同等选项形状下编译 fixture，ON 输出 `react/compiler-runtime`+`_c(`，OFF 无 compiler runtime；
  - 插件级证据：导入安装的 `@vitejs/plugin-react`，`react({compiler})` 安装 `vite:react-compiler` 插件（`react({})` 不安装），并调用其 transform handler 得到 compiler runtime。
- 命令与结果：`node tools/compiler_compat.mjs` → 11 项 PASS，`COMPILER COMPAT PASS`（Node 26 / win32-x64 / binding native）。
- frozen install：`node .local/tooling/pnpm/12.15.0/node_modules/pnpm/bin/pnpm.mjs install --frozen-lockfile` → `Lockfile is up to date`（exit 0），补丁随 frozen install 应用。
- 如实限制：`pnpm peers check` 仍报告 unmet peer `^0.152.0`，因为该命令读取 lockfile 中记录的上游 registry 元数据而非安装清单里的补丁；CI/门禁以 compiler_compat + frozen install + build/test 为证据，不以 peers check 为证明。

---

## 4. CORE-011：React Compiler ON/OFF 生产构建等价

### 4.1 Harness（`tools/compiler_equivalence.mjs`；CLI: --out-dir --chrome [--commit] [--api-url-on --api-url-off] [--dev-key] [--reuse-trace]）

- 用 pinned pnpm/Vite 对同一工作树构建两次：`FAB_REACT_COMPILER=on` vs `off`（vite.config 仅在该开关下给 `react()` 传 compiler 选项，默认 ON）。
- 构建产物自证：vite 内联插件 `fab-compiler-marker` 给每个 chunk 加 `/* FAB_COMPILER=on|off */` banner；harness 断言 ON 产物只有 on marker、OFF 只有 off marker、两者 hash 不同（防止把 dev/错误构建当对照）。
- 每模式独立静态服务器（OS 随机端口，SPA fallback + `/api` 流式代理并注入 `X-Fab-Dev-Key`）；调用方用两个干净隔离 API（`--api-url-on/--api-url-off`）保证 fixture 初始状态相同；401 响应数必须为 0（report.auth）。
- 浏览器确定性：固定 Chrome；`Page.addScriptToEvaluateOnNewDocument` 注入 seeded `Math.random` 与计数式 `crypto.randomUUID`；每个 scenario 前重置请求/console 记录。
- 比较：10 个场景的 quiescent step 快照（业务选择器文本、规范化 DOM、`/api` method+path 集合）逐项比较；允许执行次数/时序差异；后端生成的 run/command id、截断 SHA 等 identity token 归一化（视为 identity，不是业务语义）；任何差异/场景失败/401 → exit 非 0。
- 场景（spec §4 要求全覆盖）：empty-list、run-submit、bigint、closure-capture、dynamic-import-gpu、atom-subscriptions（Effect/Atom 订阅）、fab-switch、external-mutable-registry、external-atom-hook（外部 Atom-only 自定义 hook）、workbench-root（#185 回归门禁）。

### 4.2 发现并修复的真实 Compiler 语义缺陷（非仅通过）

1. **Workbench 根组件在 OFF 下 React #185（Maximum update depth exceeded）**
   - 现象：OFF 生产构建/dev 打开 `/` 立即 error boundary「工作台无法显示数据」，Error #185；ON 正常。
   - 根因：`workbench.tsx` 的 `scopedRuns = (runsView.data ?? []).filter(...)` 每次 render 新建数组，并被作为 `useEffect` 依赖；effect 内 `workbenchActions.runsReceived` 在 runId 为空时总是产生新 state（即使是空列表），Atom 通知 → re-render → 新数组 → effect 再跑，无限循环。ON 时 Oxc 缓存了 filter 结果，deps 稳定而“恰好不循环”——正是 spec §4 禁止的“依赖编译器缓存保证正确性”。
   - 修复：`workbench.tsx` 用稳定派生 key 作 effect 依赖（`runIdsKey = runIds.join('|')`，仅 key/siteId/registry 变化时 dispatch）；`workbench.atom.ts` 的 `runsReceived` 幂等（`nextRunId === state.runId` 返回原 state），即使 effect 重跑也不会再通知。
   - 回归：`tests/features/workbench/workbench-runs-received.test.ts`（重复 projection 0 通知、首次 1 通知、foreign site 不变更）；CORE-011 harness 新增 `workbench-root` 场景，OFF 出现 #185 即场景失败（门禁），修复后 ON/OFF 均通过。
2. **仅外部 Atom 订阅的自定义 hook 被 Compiler 按调用参数缓存（Oxc 实验性缺陷）**
   - 现象（command-owner 发现）：`useCommandProjection(fabId, commandId)` 的唯一响应式输入是 external Atom 订阅，ON `infer` 模式按调用参数缓存后投影不更新（「等待 SSE 事件…」不消失）。
   - 修复：hook 显式 `'use no memo'`（`src/app/runtime-provider.tsx`，含根因注释）；该 hook 无优化价值，按 spec §4 不依赖 compiler 缓存。
   - 证据：CORE-011 单测断言编译 ON 后该 hook 体内无 `_c(` 且保留 `use no memo`，同模块其它组件仍被编译；harness `external-atom-hook` 场景真实提交命令，ON/OFF 均渲染到 `succeeded · rev #` 且无「等待 SSE 事件…」残留。
   - 限制：这是 Oxc React Compiler 实验性缺陷 workaround，不是上游修复；升级后必须重跑本 harness（已写入门禁）。

### 4.3 结果（`docs/architecture/evidence/phase-e-equivalence/equivalence-trace.json`）

- `equal: true`；`differences: 0`；`scenarioFailures: 0`；`auth: { sites: 1, devKeyProvided: true, unauthorizedResponses: 0 }`；Chrome `Chrome/155.0.8059.86`。
- 构建：ON 16 files / 860ms / marker 6；OFF 16 files / 764ms / marker 6；两套 hash 全不同。关键 chunk：

| chunk | ON sha256 | OFF sha256 |
|---|---|---|
| index js | 2adb1011a01d6a7313cbf2200b3d5a68b8573a0889dd135db80ff4ff66ce10c9（index-BNaxjjRz.js） | 6bfe88ebc451aca5e9be31d88aaa320a6f1594014d57438b715baa355a7b2a53（index-DsqcrN5o.js） |
| twin-page js | 11422b952145d48a9d57d61429b76e267db8653d680cbc209de3e755808ba543（twin-page-Cw_cNQaa.js） | b54b0bcca4b907e253165210f1645a520ebb2270ce5e2b35e8d03a5bfcdcd539（twin-page-C2waIf6-.js） |
| react js | 56b7f827865c0bdb4e3f2cecc993d94a3152d8f506751b4b5cbf61fba32f9632（react-3Dcbn-Qc.js） | 0c14db850df9f8fa3b8eab6ed6694c6d6d7e9fbf3bde63e8688b48324a654b35（react-BKaDdqJq.js） |

- 每场景 step 数：empty-list 1、run-submit 2、bigint 1、closure-capture 2、dynamic-import-gpu 3、atom-subscriptions 2、fab-switch 2、external-mutable-registry 2、external-atom-hook 2、workbench-root 1。
- 复现：`node tools/compiler_equivalence.mjs --out-dir docs/architecture/evidence/phase-e-equivalence --chrome "C:/Program Files/Google/Chrome/Application/chrome.exe" --commit <sha> --api-url-on http://127.0.0.1:<a> --api-url-off http://127.0.0.1:<b> --dev-key <key>`（两个干净隔离 API；Lead 的 scripts/compiler-equivalence.ps1 可按此接线）
- 限制：wall-clock 计时器为真实时间（未冻结）；比较的是 quiescent step 的 DOM/业务/HTTP 语义（执行次数/时序允许差异）；run/command id 属 identity 已归一化；单 FAB fixture（跨 FAB 由集成测试覆盖）。离线 `--reuse-trace` 仅用于修正“identity 归一化”比较逻辑，原始 trace 未重跑（已在 report.comparisonNotes 记录）。

---

## 5. CORE-012：生产 bundle 浏览器回归 + WebGPU 设备丢失/恢复

### 5.1 生产 preview 功能回归（`tools/e2e_production.mjs`）

- CLI：`--web-url --api-url --out --chrome --commit [--mode dev|on|off]`；只驱动浏览器、不启动服务器；生产 `vite build` 产物由 `vite preview` 提供（vite.config 增加 `preview.proxy`，与 dev 相同 target/key 校验）。
- 环境：本地隔离 API（clean data dir）+ `vite preview` 4173 + 固定 Chrome 155.0.8059.86。
- 结果：`docs/architecture/evidence/phase-e-e2e.json` → 9/9 PASS，0 failed，console errors 0：
  P1 工作台 shell（生产 bundle）/ P2 catalog 搜索过滤 / P3 URL lang+theme 刷新保持 / P4 run 校验+提交（经 preview `/api` 代理）/ P5 Twin WebGPU 场景（footer=WebGPU、canvas webgpu=true/webgl=false、工具选择 inspector、DEMO 时钟推进）/ P6 realtime REST+SSE LIVE / P7 未知 FAB 失败关闭 / P8 退出重进无重复 EventSource / P9 external-Atom-only hook 投影更新（compiler workaround）。
- 关键截图：`docs/architecture/evidence/screenshots/P1.png`（工作台生产 shell，E2E 生成）。

### 5.2 GPU 设备丢失/恢复 gate（`tools/gpu_gate.mjs`）

- CLI：`--web-url --api-url --out --chrome --commit [--duration-seconds 600] [--cycles 3]`。
- 注入方式（主门禁）：页面以 `?perf` 打开，使用产品验收面 `window.__SEMICONFAB_PERF__.forceDeviceLoss()`（lite-backend installPerf/acceptance，触发 Lite 原生 device loss → 产品策略 status lost → 场景重建 → ready，与真实设备丢失同一恢复路径），每轮等待 lifecycle recoveries 增长且 status=ready。
- 附加信息项（不参与 pass）：一次真实 GPU 进程崩溃 `Browser.crashGpuProcess`（Chrome 155 的 CDP 该命令在 Browser 域，Page 域不存在），结果写入 `auxiliaryProbe`；若失败写 limitation，不静默。
- 结果：`docs/architecture/evidence/phase-e-gpu.json` → `pass: true`；Chrome 155.0.8059.86；adapter vendor=nvidia/architecture=ampere；3/3 轮 forceDeviceLoss 全部 sawLoss+recovered（losses 1→3，recoveries 1→3，GPUDevice 1→7）；最终状态 ready、webgpu=true、webgl/webgl2=false；consoleErrors=0；`auxiliaryProbe: Browser.crashGpuProcess recovered=true`（losses 3→4、recoveries 3→4、devices 7→9）；heap 采样见 JSON heapSamples。
- 复现：`node tools/gpu_gate.mjs --web-url http://127.0.0.1:4173 --api-url http://127.0.0.1:5080 --out docs/architecture/evidence/phase-e-gpu.json --chrome "C:/Program Files/Google/Chrome/Application/chrome.exe" --commit <sha> --duration-seconds 600 --cycles 3`
- 限制（如实）：本次本地为 120s 短跑（3 轮）；600s 长稳由 Lead 在最终 verify 执行；GPU gate 需真实 WebGPU 硬件，GitHub 托管 runner 无 GPU（09 §4，gpu workflow 依赖 self-hosted runner，由 Lead 负责）。早期注入尝试（Page.crashGpuProcess）已废弃，仅作为历史限制记录：Chrome 155 无该 Page 域命令，第二次连续 GPU 进程崩溃会落入 GPU 进程重启窗口（adapter 暂不可用），该现象已由“一次 crash 探针”单独记录，不作为主门禁。

---

## 6. 验证/构建门禁（本工作树，最终改动后）

| 命令（web_app） | 结果 |
|---|---|
| `pnpm typecheck` | 0 error（exit 0） |
| `pnpm lint` | oxlint src：0 warnings / 0 errors（209 files / 88 rules） |
| `pnpm test`（全量，含 B/C/D 测试） | **142 files / 793 tests 全部通过**（exit 0；含本阶段新增 5 个测试文件） |
| `pnpm build`（compiler ON） | exit 0；ON marker 生效；dist 关键 chunk 见 §4.3 |
| `node tools/compiler_compat.mjs` | 11 checks PASS，`COMPILER COMPAT PASS` |
| frozen install（pinned pnpm 12.15.0） | `Lockfile is up to date`，补丁生效 |
| `node tools/compiler_equivalence.mjs ...` | `CORE-011 COMPILER ON/OFF EQUIVALENCE PASS`（equal=true） |
| `node tools/e2e_production.mjs ...` | 9/9 PASS |
| `node tools/gpu_gate.mjs ...` | GPU GATE PASS（3/3 recovered） |

说明：全量测试断言本工作树最终状态；B/C 阶段的 CORE-001..010/014 测试由对应 owner 负责，本文件不重复其证据。

---

## 7. 限制清单（未验证/环境限制，不得据本文宣称 PASS 的项）

1. `pnpm peers check` 读到的是 lockfile 中上游 registry 元数据，仍会显示 oxc `^0.152.0` unmet；兼容性证明是可执行门禁（compiler_compat + build/test + 等价 harness），不是 peers check（§3.2）。
2. Oxc React Compiler 仍是实验性：`'use no memo'` 与把 BigInt 聚合移出组件都是 workaround，不是上游缺陷修复；升级 Oxc/plugin 后必须重跑 compiler_compat + CORE-011。
3. CORE-011 的 wall-clock 未冻结；比较的是 quiescent step 的 DOM/业务/HTTP 语义（执行次数允许差异）。单 FAB dev fixture，跨 FAB 由集成测试覆盖。
4. CORE-012 本地 GPU 证据为 120s / 3 轮；600s 长稳与最终 SHA 绑定由 Lead 的最终 verify/gpu gate 执行。GPU CI 需要 self-hosted GPU runner（未提供则按 09 §4 登记限制）。
5. `pnpm install` 由本任务执行过一次（peer 元数据补丁 + lock 更新），之后 frozen install 已验证；最终提交前 Lead 会按 verify.ps1 再跑 frozen install。
6. 未修改任何兼容层/旧 shim；`state/runtime-store.ts` 与旧 twin 单对象均已删除（零引用，见 §1）。

---

## 8. 产物索引

| 文件 | 说明 |
|---|---|
| `docs/architecture/evidence/phase-e-compiler.md` | 本文件 |
| `docs/architecture/evidence/phase-e-equivalence/equivalence-trace.json` | CORE-011 原始 trace（ON/OFF 全量 step）、比较结果、构建 hash、Chrome/auth 元数据 |
| `docs/architecture/evidence/phase-e-equivalence/build-on.log` / `build-off.log` | 两次生产构建原始日志 |
| `docs/architecture/evidence/phase-e-e2e.json` | 生产 bundle 浏览器 9 场景原始结果（console/network/steps/screenshot 路径） |
| `docs/architecture/evidence/phase-e-gpu.json` | GPU gate 原始结果（adapter/cycles/lifecycle/heap/aux probe/limitations） |
| `docs/architecture/evidence/screenshots/P1.png` | 生产 preview 工作台页面（E2E P1 生成） |
| `docs/architecture/evidence/screenshots/gpu-ready.png` | WebGPU 场景就绪（GPU gate 生成） |
| `web_app/patches/@vitejs__plugin-react@6.1.2.patch` | 维护的 peer 元数据兼容补丁（lock 记录 patch hash） |
| `tools/compiler_compat.mjs` / `tools/compiler_equivalence.mjs` / `tools/e2e_production.mjs` / `tools/gpu_gate.mjs` / `tools/lib/browser-driver.mjs` | 本阶段新增的可执行门禁 |
| `web_app/tests/architecture/atom-ownership.test.ts` / `tests/state/atom-notification-surface.test.ts` / `tests/features/workbench/workbench-runs-received.test.ts` / `tests/core/core-011-compiler-equivalence.test.ts` / `tests/core/core-012-production-gpu.test.ts` | 本阶段新增回归/门禁测试 |

（SHA 绑定：本文 JSON 证据的 `commit` 字段为 pending，由 Lead 在最终提交后以同一命令重跑并回填最终 SHA；原始日志不手写 PASS。）
## Lead 绑定（2026-10-30）

- Phase E 实现提交：`d0c6f19e7038baaba78e9f118d64f04d854f7fd2`。
- 本文所有“SHA pending / 由 Lead 绑定”指该提交；最终整树验收证据见 `docs/architecture/evidence/final-verify.json` 与 `correctness-refactor-acceptance.md`（绑定最终 verify 的 commit）。
- 本文原始输出均可按文中命令重跑；未重跑的推断不得视为 PASS。

## 最终整树验收（Lead，2026-10-30）

- 验证提交：`af002f46b6a63599205b21132538075bbfaa15a7`；`scripts/verify.ps1` exit 0（GPU gate 开启，600s）。
- 原始输出：`docs/architecture/evidence/final-verify-af002f4.log`；机器摘要：`final-verify.json`；门禁矩阵：`correctness-refactor-acceptance.md`。
- 本文件早先记录的“pending”已被最终验证取代：最终 evidence 均绑定该提交；未覆盖/限制项见验收索引。
