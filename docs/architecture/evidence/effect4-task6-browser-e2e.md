# Task 6（阶段 B）：真实浏览器功能验收

- 执行日期：2026-10-29（Asia/Singapore）
- 前序：Task 6a `964e49b`（RxJS → Effect Stream/PubSub）
- 权威验收：`04-acceptance-and-architecture-gates.md` §7
- 状态：10/10 浏览器场景 PASS；性能/GPU/最终签收见阶段 C

## 1. 唯一命令与实现

```powershell
# web_app 内
pnpm e2e
```

- `scripts/e2e.ps1`：复用已运行 dev 栈；未运行则在隔离端口（默认 API 5091 / Web 5179）启动 `start-dev.ps1`，结束后清理进程树。产物默认 `docs/perf/effect4-e2e.json`。
- `tools/e2e_functional.mjs`：Chrome DevTools Protocol 驱动，无额外 npm 依赖。每个场景记录场景 ID、起始 URL、步骤、期望/实际、pass/fail、console 错误、网络摘要（总数/EventSource/关键 API），失败自动截图。
- `web_app/package.json` 增加 `e2e` 脚本；`scripts/README.md` 登记命令、服务启动方式和产物路径。

## 2. 执行结果（2026-10-29，commit 待提交）

命令：`pnpm e2e`（等价于在已启动的 5179 dev 栈运行 `node tools/e2e_functional.mjs`）

| 场景 | 内容 | 结果 |
|---|---|---|
| S1 | `/` Sites 成功、Fetch 拦截制造失败、重试恢复 | PASS |
| S2 | `/equipment` 搜索收窄、Compare 视图切换 | PASS |
| S3 | URL `lang`/`theme` 刷新、前进、后退 | PASS |
| S4 | Workbench 表单校验、重复提交保护（1 个 POST）、错误态 | PASS |
| S5 | Catalog 非法 JSON 导入错误、合法 JSON 本地预览、导出下载 | PASS |
| S6 | Twin DEMO 播放/暂停、晶圆跟随、Research REPLAY | PASS |
| S7 | Twin REST 初始快照 + SSE、离线断线→CACHE→恢复 LIVE | PASS |
| S8 | 未知 FAB 路由错误，不渲染旧 FAB 数据 | PASS |
| S9 | 未知 URL 404 | PASS |
| S10 | Twin 退出/重进：无重复 active EventSource，Worker 数不增长 | PASS |

原始结果：`docs/perf/effect4-e2e.json`；关键截图：`docs/perf/e2e/S1-sites-failure.png`（Sites 失败态）、`docs/perf/e2e/S7-offline.png`（断线 CACHE 态）。

## 3. 本阶段发现并修复的真实缺陷

S2 暴露了 catalog 视图切换的 URL 竞态：点击头部 Compare 链接时，`openView` 已把 Atom 视图设为 compare，但旧 catalog 路由的 URL 回写 effect 在同一提交内以 `replace` 导航回 `/equipment?...`，取消了 `/equipment/compare` 路由导航，结果停留在 catalog 且自动选中 3 条 Lithography 记录。

修复（`src/catalog/use-catalog-route-state.ts`）：URL 回写 effect 在 `view !== initialView`（视图切换导航进行中）时直接返回，让 `onViewChange` 拥有路由导航；路由提交后 `initialView` 与 `view` 一致，回写恢复。修复后 S2 PASS。

## 4. 限制与覆盖说明

- 开发数据只有 1 个 FAB，因此 S7 无法做真实跨 FAB 浏览器隔离；跨 FAB Gate/Atom/Scope 由 `equipment-status-scope-cycle`、`twin-fab-scope` 等集成测试覆盖，已在 JSON `limitations` 中记录。
- S7 用 CDP `Network.emulateNetworkConditions` 模拟断线，非物理断网；真实 SSE/Worker 生命周期由单测覆盖。
- S5 断言下载文件出现在 CDP 下载目录，文件内容正确性由 `catalog-export` 单测覆盖。
- 浏览器环境：headless Chrome 155（与性能工具同机），console 错误按场景记录；预期的 404/断线日志与 React 路由错误日志在判定中列为预期噪声，仍完整保存在 JSON。

## 5. 验证

- 全量测试：**120 文件 / 718 测试 PASS**（catalog 修复后）。
- e2e：**10/10 PASS，exit 0**。
- 待阶段 C：构建产物大小、连接/Worker/React render 指标、3 轮性能 A/B、GPU 证据、`verify.ps1` 最终日志与签收清单。
