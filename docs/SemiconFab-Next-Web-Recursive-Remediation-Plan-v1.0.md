# SemiconFab-Next Web 全层级递归审计与整改实施规范

- 版本：1.0
- 基准仓库：`iphone2059/SemiconFab-Next`
- 基准提交：`67915c0eece848b0f45a64ccc5e1092b28bf5967`
- 范围：`web_app/` 全部 284 个文件、56 个目录；其中 `src/` 155 个 TypeScript/TSX 源文件；涵盖 `tests/`、`assets/`、`public/`、项目配置，且同步检查根目录生成器与架构检查脚本的产物关系。
- 证据状态：本轮基于远程仓库源码逐级审查；**没有独立运行最新测试、构建或实机 GPU 性能测试**。
- 指导原则：正确性 > 领域规范与安全 > 依赖和类型契约 > 性能 > 兼容性和重构成本。**不保留旧 API 兼容层、路径转发层、临时双实现**；在数据语义及预期产品行为未被确认之前不得擅自修改业务正确性。

## 0. 实施总规则

1. 锁定工作分支与基准提交。标注每个问题为“静态确认 / 测试复现 / 环境验证 / 风险评估”。
2. 先写失败测试，再修行为；随后允许一次性破坏旧签名并更新全量调用方。
3. 模块移动与语义改动分为独立的可审计提交；**不是为兼容而保留旧路径**，是为了差异审查可追踪。
4. 不得以 Vitest 全绿替代 Chrome/WebGPU 真机验证；也不得通过扩大 timeout、删除断言或跳过测试隐藏失败。
5. 生成产物必须由生成器写入；不得手工维护。
6. 不新增库/设计模式，除非现有标准库和技术栈确实无法满足业务约束；不为减少文件行数而机械拆分纯算法。
7. 每个阶段必须具备：涉及文件、修复规则、负向/正向验证、失败时回退路径、交付证据。

## 1. P1 — 先消除已定位的交互和 API 正确性风险

### R-01：键盘监听器过期闭包

**现状**：`src/features/twin/controllers/use-twin-keyboard.ts` 用 `useEffect(..., [])` 注册一次监听器，却直接调用首次渲染捕获的 `setCamera` 和 `onEscape`。`use-twin-actions.ts` 的 `setCamera(next)` 比较 `next === view` 以重置当前预设，后续渲染的 `view` 可能与闭包中的旧值不同。

**实施**：
1. 使用 `useEffectEvent`（确认 React 当前可用版本及事件调用位置契约）或 `useRef`/`useLayoutEffect` 保存最新回调；全局 `keydown` 监听器仍只注册一次。
2. 把键盘范围限制在 Twin 页面激活时；文本输入、`contenteditable`、Dialog、IME composition 时不得误触 1/2；Escape 的响应应符合最上层 Overlay 所有权。
3. 增加 `tests/twin-keyboard.test.tsx`：ISO→Top→拖动→再次按 2 必须重新居中；更新 onEscape 后监听器调用新回调；卸载后无事件；StrictMode 不重复注册；输入框/IME/模态焦点处理。
4. 严禁使用空依赖 Effect + 捕获变化回调的方案。

**验收**：实际浏览器中的快捷键、按钮和相机预设语义一致；注册数与资源释放测试通过。

### R-02：Tour 的唯一时间线/RAF 所有权

**现状**：`src/features/twin/controllers/use-tour-controller.ts` 的 `startTour()` 未先停止已有 RAF；若被重复调用，旧循环还可能持续读取新 `tourTimelineRef.current`，导致一条时间线被多条循环推进。

**实施**：
1. 显式定义 `IDLE/RUNNING/STOPPING` 或等价单生命周期状态；`startTour` 已启动时明确选择“幂等”或“先完全停止再重新启动”，不得隐式叠加。
2. 每条动画循环绑定 generation token；每次 RAF 回调先检查 token 和当前时间线实例，而不仅依赖共享 ref 非空。
3. 结束、相机手动输入、页面卸载、FAB 切换、Viewer 重新创建全部经过统一 `stop()`；取消 RAF、停 Timeline、清 HUD、释放对旧 Scene 的引用。
4. 改为可注入的 RAF/Clock，便于虚拟时间验证；不依赖 wall-clock 随机时序。
5. 新增测试：重复 start、start/stop/start、stop 后迟到 RAF、FAB 切换、StrictMode 重挂载；断言每一时刻最多一个活跃循环。

### R-03：命令提交返回值全量校验

**现状**：`src/api/mutations/commands.mutations.ts` 仅确认 `commandId/fabId` 是字符串，剩余字段用 `String(...)` / `Number(...)` 强制转换，能把缺失字段污染成 `'undefined'`、`NaN`。

**实施**：
1. 在 `api/schemas/command.schema.ts` 建立运行时 Zod Schema：非空 `commandId/siteId/fabId/equipmentId/action`、有限非负整数 `revision`、权威 outcome 联合类型、格式有效的时间戳；不要通过 `String()`/`Number()` 隐式修复错误服务端响应。
2. 输入使用独立的 `SubmitEquipmentCommandInput` Schema；幂等键由明确的命令创建器产生，重试复用同一键。
3. 统一调用 `fetchJson` 或职责明确的 HTTP Transport，并在 `schema.parse` 后返回精确 TS 类型；检查提交上下文中的 site/fab/equipment 与响应一致性，若协议允许服务器标准化身份则明确定义规范化规则。
4. 新增边界测试：缺字段、错误类型、`revision=NaN`/小数/负值、非法 outcome、空字符串、跨 FAB 返回、HTML 错误页、网络失败。
5. 根据实际后端合同校对 Schema；不得假设未经验证的字段允许值。

## 2. P2 — 建立严格 Scene Port 与生命周期契约

**涉及**：`src/rendering/fab-scene.ts`、`rendering/lite-backend.ts`、`rendering/lite/world.ts`、`features/twin/fab-viewer.tsx`、`features/twin/controllers/use-twin-scene-sync.ts`、`state/runtimeStore.ts`。

1. 将浏览器页面依赖的抽象合同移至 `src/application/ports/scene.ts`（或者同等独立端口），`rendering/**` 实现端口；不让端口依赖 Babylon Lite 或 React。
2. 将当前可选 `setView?`/`resize?`/`selectTool?`/`setXRayFilter?` 等分为正式产品必需能力和确实允许缺失的独立 Capabilities。正式产品依赖必须由编译器强制存在。移除 Silent Optional Call `?.()` 伪成功路径。
3. 改变扁平的长 `mount(canvas,fabs,signal,onStatus,...)` 参数列表，使用带稳定身份、取消信号和只读回调集合的强类型 options。允许破坏旧签名，全部调用点同步迁移，不保留转发兼容实现。
4. 用结构化 `ViewerLifecycle = 'idle'|'initializing'|'ready'|'recovering'|'failed'|'disposed'` 或判别联合管理引擎状态；UI 展示文字单独提供。禁止 `status.startsWith('WebGPU')` 决定真实控制逻辑。
5. 将 `mount/dispose` 设为明确的幂等生命周期；区分 mount 失败、取消、GPU Device Lost 和可恢复重建；确保失效 GPU 资源不被旧回调操作。
6. 测试端口的类型负向例子、GPU 初始化失败、重复 dispose、late promise、GPU 恢复、相机预设恢复、FAB 切换。

**验收**：每一项正式产品能力缺失都会产生编译错误或明确的不可恢复错误；场景不存在“调用成功但什么都没发生”的隐式实现。

## 3. P2 — 领域层彻底净化并整理叶子模块

当前 `src/domain/` 有 20 个 TS 文件，分布在 `amhs/`、`contracts/`、`equipment/`、`fab/`、`personnel/`、`simulation/`、`wafer/`。大方向正确；进一步按以下规则修正：

### 3.1 时间线归位

- 将 `domain/wafer/tour-wafer-timeline.ts` 中 `Tour*` 模型、时间线和算法归入 `domain/simulation/tour-timeline.ts`；`Wafer*` 归入 `domain/wafer/wafer-timeline.ts`。将共用的 `Vec3`/插值函数提取到 `domain/math/`，仅当两个模块实际共享该实现时才提取。
- 更新 `domain/simulation/tour-scenario.ts`、`domain/wafer/wafer-scenario.ts`、`features/twin/controllers/use-tour-controller.ts`、`use-wafer-playback.ts` 与相关测试。
- 完全保留已明确要求的原版黄金向量语义；重新跑同一 fixtures，不保留旧 `tour-wafer-timeline.ts` 转发兼容层。

### 3.2 领域时钟

- `domain/fab/process-control.ts` 的 `createMesJob` / `createProcessMesJob` 默认 `now = Date.now()` 应取消默认，调用者显式提供权威时间参数（数字时间戳或语义化 Clock）。
- 将 MES Job、FDC Telemetry、SPC 计算按独立业务责任划分：若它们有独立的类型、演进或执行规则，可归入 `domain/mes/`、`domain/fdc/`、`domain/spc/`；不强制把紧密耦合的纯函数机械拆散。
- 明确定义时间单位、UTC/模拟时间来源、舍入和无效数值处理，并以固定时间构造黄金向量。

### 3.3 域模型与显示文本分离

- `domain/contracts/language.ts` 的 `TwinLanguage` 属于 UI 语言设置，不应成为通用制造领域模型的依赖。移至 `features/twin/i18n/` 或共享的 `localization/`；对需要本地化的原始资料提供纯数据 + 显示层投影，不在领域算法中耦合浏览器语言状态。
- `domain/fab/original-twin-data.ts` 同时有原始设备目录、选择模型、翻译筛选、信号注册表；将原始/规范化身份数据留在领域/参考数据层，目录搜索、语言文案移到 Feature 投影层。
- `domain/fab/fab-yield.ts`、`domain/simulation/twin-equipment.ts` 等仍保持纯函数/纯 Reducer；禁止 React、Router、Zustand、Babylon、DOM、隐式时间及隐藏随机源进入领域层。

### 3.4 测试

- 保证 `domain/` 的非显式输入不依赖 `Date.now()`、`Math.random()`、`window/document`、网络或隐式本地时区。
- 增加基于 seeded PRNG、固定时钟、无效设备身份、乱序事件、序列边界的属性测试或表驱动测试。

## 4. P2 — Babylon Lite 子树按资源所有权整理

### 4.1 保留的组合根

- `rendering/lite/world.ts` 负责创建/连接/销毁 Camera、Geometry、Environment、Motion、Selection、Lighting、Effects、Shadow、Tool State。这种组合根较长是正常的；不可仅因 584 行拆成多个同时管理生命周期的 Owner。
- `rendering/lite/runtime.ts` 负责 GPU Engine、设备丢失恢复、Scene Context 生命周期。
- `rendering/lite-backend.ts` 负责产品 Port 适配、状态和命令，不再存放 GPU 细节。

### 4.2 拆出拥有独立资源生命周期的效果

- `rendering/lite/effects.ts` ~742 行包含 X-Ray WGSL/CSM、Cut Plane、Wafer Marker/Trail/Light。目标结构：
  - `rendering/lite/effects/xray.ts`
  - `rendering/lite/effects/xray-shaders.ts`（WGSL 源码与 Uniform Contract）
  - `rendering/lite/effects/cut.ts`
  - `rendering/lite/effects/wafer.ts`
  - `rendering/lite/effects/index.ts`（仅能力装配）
- `rendering/lite/cut-plane.ts` 已拥有 PBR/Standard Cut Plugin；与新 cut Effect 明确区分“物理剪裁策略 owner”和“可视化切割器”，不得两者修改同一材质却没有唯一 Owner。
- 每个 Effect 显式 `create/update/dispose`、拥有其创建的材质、Buffer、Light/Texture 和回调释放；共享阴影纹理必须只借用，不越权释放。
- 对 X-Ray 传递 `ShaderUniform` 和纹理的精确结构化合同；测试目标计数、不同 Filter、重建后重绑、GPU 资源重复释放、Shader 编译失败。

### 4.3 Geometry / Motion / Selection 叶子目录

- `geometry/facility-*`、`tool-families.ts`、`original-tool-parts.ts`、`static-structure.ts` 归属基本合理。渲染参数数据可以与实现文件同域，但大规模的冻结资产声明建议移入独立 `data/` 子树，避免与可执行几何构建代码混在一起。
- `motion.ts` 中 AMHS 与 Personnel 有独立输入、动画状态和材质资源所有权时，允许拆成 `motion/amhs.ts`、`motion/personnel.ts`，由 motion/index 装配；必须保持 AMHS/Personnel 的原版向量一致。
- `selection.ts` 内保留 GPU Picking 的顺序、背压、最新结果覆盖和 dispose 语义；若进行拆分，以可测试的 Pick Resolver（纯）与 GPU Picking Runtime（副作用）为界，而不是按函数长度拆。

### 4.4 数据类型循环消除

- 将 `PackedSourceEntity` 放在 `rendering/contracts/static-structure-data.ts` 或独立的数据生成 schema；生成器和渲染消费者共同从该合同生成/导入。
- `generated/static-structure-packed.ts` 不得反向 `import type` 渲染消费者；R1 架构门禁增加全依赖图（含 type-only 边）的无环检查。

## 5. P2 — 实时系统、状态所有权和缓存边界

### 5.1 已修复项不得回退

- `TelemetryRuntime.onWorkerFailure` 当前已将 unanswered frame 合并入 Pending，重建成功后 flush；保留相应的“最后一帧无新 SSE”测试。不得误报此前 P2。
- `FabTelemetryRegistry.acquire` 返回幂等 release 并检查旧 Runtime 身份；保留多消费者与 StrictMode 回归测试。

### 5.2 结构整理

- 将 `realtime/equipment-status.ts` 的 SSE Transport、协议解码与顺序 Gate 分离为明确的相邻模块；相同 Site/FAB Scope、Server Epoch 和 Sequence 规则只能有一个权威实现。
- `api/queries/equipment-status-bridge.ts` 是 REST/SSE 与 Query Cache 的投影桥；可归于 `api/cache/`，但应始终让 React Query 为已接受的服务端快照的唯一权威缓存；不可在两个 Store 维护平行原始快照。
- `realtime/telemetry/telemetry-buffer.ts` 的 CoalescedDispatcher 是通用调度原语，可归入 `shared/scheduling/`（如确有多个消费者），避免通用模块的名字暗示仅遥测使用。
- `domain/equipment/tool-state-projection.ts` 继续保持纯状态投影，Worker 数据解码与执行器不得侵入。

### 5.3 必测跨边界条件

- 同 FAB 两消费者、一消费者卸载、重复 release、Runtime replaceAll、旧 generation 异步回调、复连重复 Epoch/Sequence。
- FAB A→B→A：Query、Worker、Command Runtime、设备状态和 Scene 互不污染。
- SSE/REST 延迟、重排、重复、缺字段、大帧、Worker 超时、异常终止、后续不再出现数据。
- 后端命令必须重试幂等、按 FAB 隔离、终态不回退、Revision 不倒退。

## 6. P2/P3 — Features 子树模块化

### Twin

- 保留 `features/twin/controllers/`、`state/` 和 `equipment-status-pipeline.tsx` 分层。确保 Controller 之间不依赖彼此的内部数据；由页面/Feature 用例显式注入必须的函数。
- `use-twin-actions.ts` 负责 UI Commands，可以进一步拆成与清晰业务用例匹配的动作模块（camera / selection / MES / spatial），但只在实际变化原因独立时执行；共同 store 事务保持原子性。
- `use-twin-route-state.ts` 中 URL→Store 与 Store→URL 双向 Effect 必须明确单一权威来源；添加 URL Back/Forward、刷新、非法 Query、同步顺序和 SSR/Storage 被拒场景测试。
- `use-wafer-playback.ts` 的 RAF 要按 Viewer Epoch/FAB identity 设生命周期边界；避免关闭、切 FAB 或旧 RAF 中断后向新场景写入。高频数据通过 Ref/Scene，不逐帧写 React State。
- `twin-page.tsx` 已缩至 491 行，以 UI 组合根保留；不为压行数分解无独立责任的 JSX。

### Catalog

- `catalog-page.tsx` ~763 行，将页面分为目录数据选择/URL Search 协调、详情展示、比较视图、导出逻辑；建议分置 `catalog/controllers/`、`catalog/components/`、`catalog/export/`。
- 导出 Blob/ObjectURL 的 revoke 生命周期必须可测试，不以固定 1000ms Timer 作为唯一可信释放协议；按实际下载兼容性设计。
- 保留 Catalog 表示层 schema 与原始 Equipment Reference 数据源之间的边界；所有外部链接严格校验 URL Scheme。

### Workbench

- `workbench.tsx` ~429 行可保留作为页面组合根。若表单、运行列表和结果展示独立变化，可移动到 `workbench/components/`。
- `components/widgets.tsx` 的 Metric、`components/charting.tsx` 的 CompletionBar 如果只被 Workbench 引用，移至 Workbench 本地，不保留全局转发。
- `command-console.tsx` 与 `workbenchStore.ts` 权威状态分清 Query 与命令投影，不出现并列缓存。

### 共享 UI

- `components/modal.tsx` 统一原生 Dialog 的关闭、焦点、滚动锁、嵌套、Escape、inert 和解除挂载；禁止各 Feature 复制 Dialog 实现。
- `components/original-icons.tsx` 体积很大，若是冻结的 SVG 数据清单，应分出纯数据与渲染入口，但不能破坏图标的精确图形一致性。

## 7. P3 — 统一 API、应用、运行时和类型

- `api/queries/http.ts` 与 `api/queries/sites.queries.ts` 重复 `problemDetail`、`fetch`、错误检查：使用一个 `api/transport/http.ts`。为测试注入 `FetchLike`，请求/响应验证在独立 Schema 层；保留统一 `AbortSignal` 与安全身份头处理。
- `api/queries/queryClient.ts`、`queryKeys.ts` 可继续集中，单一 QueryClient/RouterContext 必须保留 `defaultPreloadStaleTime: 0`。
- `application/contracts/` 与 `application/coordination/` 的 Command Bridge/Correlation/Recovery 已有合理边界，不增加无意义的额外 Service/Facade。
- `runtime/commands` 集中 XState 适配器、机器、纯逻辑；`FabRuntime` 只负责 FAB 级执行和生命周期；`FabLifecycleCoordinator` 保证顺序及 StrictMode 幂等。
- `state/createSliceStore.ts` 的外部类型可由负向 `@ts-expect-error` 测试证实，但内部仍使用 `as unknown as SliceActions<M>`。若按“无不受约束类型断言”的严格规范，可将各 Store 的 actions 直接定义成类型化 Zustand Action，删掉通用 action factory；不得仅用 `any`/断言掩盖推导问题。
- `state/preferences.ts`、`localeStore.ts` 保持独立通用 UI 偏好，FAB 产品业务状态不放到共享 Store。

## 8. P3 — Generated、Assets、Public、Tests 全层级治理

### Generated

- `generated/contracts.generated.ts`、`twin-translations.generated.ts`、`static-structure-packed.ts` 统一登记 generator 的输入路径、输出路径、哈希及 `--check` 生成一致性测试。
- 大型 packed 几何数据是否应由 TS 常量转成二进制 asset，须比较解析/下载/CPU 初始化/GC 成本。若确实采用二进制格式，定义严格版本、长度、校验和、端序和 AbortSignal，并有原始几何黄金向量，不保留双套资产格式兼容实现。
- 生成物禁止手工编辑；编译入口不得从生成源码导入无关的业务逻辑。

### Assets 与 Public

- `assets/`：按 css/data/reference/licenses 清晰归属；明确哪些资源被 Vite 打包、哪些仅作为生成器输入。
- `public/twin/events-t1-fifo.jsonl` ~4.4MB，`routes.json` 为直接浏览器请求；其版本、哈希、许可证、缓存策略与部署一致性需审查。大 JSONL 在 React render/useMemo 中同步解析的 Long Task 要独立测量，必要时异步 Worker 解析。
- 避免 `assets/legacy-LICENSE.txt`、`public/licenses/semiconfab-LICENSE.txt` 存在不受控重复源：选一份权威许可证源，并由构建复制或生成。
- 根目录 scripts/tools 对资产生成/静态结构 pack 的路径必须与实际产物完全对应。

### Tests

- `tests/` 目前根目录平铺很多单测（AMHS/Domain/Lite/API/UI），少量 `contract/fixtures/integration/performance/support/types` 子目录。推荐按源码所有权镜像：`tests/domain/**`、`tests/features/**`、`tests/rendering/**`、`tests/realtime/**`、`tests/runtime/**`、`tests/api/**`、`tests/architecture/**`，专属 `fixtures/` 保持统一可追溯。
- 调整测试位置需更新 test import 的相对路径；允许修改路径，但不允许修改 golden fixture 或减弱断言。
- 需要保证测试命名反映真实依赖（例如 `redux-store.test.ts` 在无 Redux 后应改名为 `zustand-stores.test.ts`）。
- Type-level tests 与 Vitest runtime tests 必须双重门禁；不能仅看单次 Vitest 数字。

## 9. 升级自动化架构门禁

现有 `tests/architecture-import-graph.test.ts` 已覆盖 R0、R0b、R1、R2、R3、R4、R5、R6。继续完善：

- **R7**：`api/realtime/runtime/rendering/components/state` 等通用基础模块不得导入 `features/**`；装配根 `app/providers`、`app/router/routes` 显式豁免。
- **R8**：`domain/**` 禁止非注入式 Date/Random/DOM/Timer/Network；对于 Reference Data 的静态 JSON 引用，要求明确授权并禁止副作用。
- **R9**：生产 `ScenePort` 必需能力完整实现，不存在 silent optional methods；必要时通过 TS `satisfies`/contract test 校验。
- **R10**：所有 import edge（运行时 + type-only）无环；对现有生成物类型反向引用先消除再开启严格门禁。
- **R11**：每个生成文件登记唯一 Generator、源码数据、校验和；新增/删除文件时 CI 失败并提示登记项。
- **R12**：公共组件必须有可核查的跨 Feature 使用或明确全局设计系统角色；避免随意提升局部组件。
- **R13**：禁止用户交互基础设施中使用空依赖 Effect 捕获会变化的回调；采用 ESLint React Hooks 检查及行为测试。
- **R14**：在源码中禁止无契约 `any`、无说明的 `as unknown as`、数据响应 `String/Number` 伪校验，例外严格审查并记录依据。

实现方式：使用 TypeScript Compiler API 解析 import/export/dynamic import、类型边和别名，解析失败即阻断。不要维护一个与项目实际 TS 解析逻辑不一致的假依赖图；架构测试本身应有反向/违规 fixture，证明每条门禁真的能够失败。

## 10. 推荐终态目录布局

```text
web_app/
  assets/
    css/                 # 由 Vite 打包的应用样式
    reference/           # 冻结原版参考资料与生成器输入
    licenses/            # 权威许可证源
  public/
    twin/                # 公开按 URL 请求的版本化数据
    licenses/            # 构建生成或受约束的公开许可证副本
  src/
    main.tsx
    contracts.ts         # 若要保留公开类型出口，必须仅 type export
    app/
      providers/
      router/
        routes/
    api/
      transport/
      schemas/
      cache/
      queries/
      mutations/
    application/
      contracts/
      ports/
      coordination/
    domain/
      amhs/
      equipment/
      fab/
      fdc/              # 如独立承担传感器/数据语义
      mes/              # 如独立承担 Job 规则
      personnel/
      simulation/
      spc/              # 如独立承担统计过程规则
      wafer/
      math/             # 仅放真正共享的数学原语
    features/
      catalog/
        components/
        controllers/
        state/
      twin/
        components/     # 如有足够独立性
        controllers/
        i18n/
        state/
      workbench/
        components/
        state/
    realtime/
      buffers/
      equipment-status/
      protocol/
      telemetry/
      transport/
      workers/
    rendering/
      lite-backend.ts
      lite/
        camera.ts
        effects/
        geometry/
        motion/
        shadows/
        # world/runtime/environment/selection/lighting...
    runtime/
      commands/
    state/               # 真正共享的客户端状态
    components/          # 真正共享的设计系统及底层 UI
    generated/           # 无手写代码的生成产物
  tests/
    api/
    application/
    architecture/
    domain/
    features/
    realtime/
    rendering/
    runtime/
    integration/
    performance/
    fixtures/
    support/
    types/
  package.json
  pnpm-lock.yaml
  tsconfig.json
  vite.config.ts
```

注：上面的子目录是**目标所有权图**，不要求强行创建空文件夹；只有在职责或文件数量支持时创建。如发生更合理的领域归属，以具体依赖结构为准。

## 11. 执行顺序与独立提交计划

| 顺序 | 独立整改提交 | 主要完成标准 |
|---:|---|---|
| 01 | `fix(twin): stable keyboard callback ownership` | P1 相机快捷键重置 + StrictMode/IME 测试 |
| 02 | `fix(twin): single-owner tour timeline` | 重复 start 不产生第二 RAF；所有退出路径释放资源 |
| 03 | `fix(api): strict command result validation` | 所有非法服务端响应被拒绝；跨 FAB 响应不进入状态 |
| 04 | `refactor(scene): explicit scene port and lifecycle` | 所有必需方法强制实现；状态枚举不依赖 UI 文案 |
| 05 | `refactor(domain): deterministic clocks and semantic ownership` | 纯领域无隐式时间；Tour/Wafer 不同模块、向量全部通过 |
| 06 | `refactor(rendering): independent GPU effect owners` | Shader/CSM/Clip/Wafer 生命周期和恢复测试通过 |
| 07 | `refactor(data): generated contract DAG and provenance` | 运行 + 类型 import 无环；generator check 通过 |
| 08 | `refactor(realtime): transport and projection boundaries` | 完整 SSE/Worker/Query 多 FAB 竞态测试通过 |
| 09 | `refactor(features): catalog/workbench ownership cleanup` | 每个功能在 Feature 内自洽；无共享状态和导入越权 |
| 10 | `refactor(api): one validated transport and schemas` | 无重复 HTTP 错误处理；无隐式数据强制转换 |
| 11 | `refactor(tests): ownership-based test layout` | 测试迁移后总断言强度不变，负向类型测试继续失败 |
| 12 | `test(architecture): enforce recursive dependency contract` | R0–R14 规则及违规 fixtures 全通过 |
| 13 | `docs(web): synchronize contracts and structure` | 所有 README/ADR/工程文档按新事实同步 |
| 14 | `perf(webgpu): compare post-refactor GPU behavior` | A/B 帧时间、内存、加载、交互及 GPU Lost 回归无不当退化 |

强制提交前检查：`git status --short` 和 `git diff --check`。新文件必须 staged，且每个提交仅对应一个可独立验证的职责变化；不保留临时别名、兼容转发文件或双写路径。

## 12. Windows PowerShell 验收命令

在仓库根目录运行，保持用户偏好的单行命令：

```powershell
cd web_app; npx --yes pnpm@12.15.0 install --frozen-lockfile; npm run typecheck; npm test; npm run build
```

仓库根目录（从 `web_app` 返回）：

```powershell
cd ..; python tools/check_architecture.py; git diff --check; git status --short
```

生成器按仓库实际 `--check` CLI 验收，禁止编造不存在的参数或脚本名；实机 GPU 验收使用仓库 `scripts/perf-render.ps1`，并保存脚本输出、Chrome/Adapter/驱动、分辨率、DPR、场景及实验样本数。

### 最小发布/合并门禁

1. TypeScript 严格检查 0 错，非法类型示例得到预期编译错误。
2. 全量 Vitest、契约、黄金向量和 E2E 通过；不得以增加 timeout 掩盖可复现竞态。
3. Vite 生产构建通过；生成器 `--check` 通过；Import Graph 的所有适用规则通过。
4. React StrictMode、URL Back/Forward、FAB A↔B、Tour/wafer/Camera、Modal/Focus/IME 真实 Chrome 交互通过。
5. Worker 超时/异常、REST/SSE 乱序、重复消息、后端重启、旧 Callback、GPU Device Lost 与恢复场景测试通过。
6. WebGPU GPU/CPU/GC 与加载性能基准没有非预期回退；结果包含 p50/p95/p99 和样本数。
7. 许可证、生成资产来源、README/ADR、类型合同、部署产物版本全部相互一致。

## 13. 修复完成的定义（Definition of Done）

- 结构：每个模块有唯一归属、职责和依赖方向，无运行时及类型环。
- 正确性：键盘、Tour、API、场景生命周期和多 FAB 一致性均通过负向与边界测试。
- 契约：必需能力不可选，网络响应不能靠强制转换变为合法数据，领域计算无隐式不确定输入。
- 资源：RAF/Timer/EventSource/Worker/GPU 资源均按唯一 Owner 可证明释放。
- 生成与测试：生成器/CI/归档和实际构建路径一致，所有测试移动与新增均可复现。
- 性能：没有为了“架构更优雅”把 60Hz 数据重新搬到 React 状态，或引入不可测的渲染抖动。
- 兼容性：没有不必要的旧入口兼容层；有意移除旧签名后，全量消费者同步更新。

**审计结论与边界**：此文档是当前仓库版本上的整改实施规范，并非所有风险均已动态复现，也并非已经实施代码修复。若后续主分支变化，实施前必须重新锁定提交、重新分析 Diff，特别是已修复的遥测恢复逻辑，不得按历史问题单重复修改。
