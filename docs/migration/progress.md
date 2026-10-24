# SemiconFab-main → Next 实施记录

日期：2026-10-24。首批实现分支为 `feat/main-to-next-migration`；GitHub 同步状态以远程 Git 记录为准，尚未部署生产版本。规划见 [迁移工作包](../superpowers/plans/2026-10-24-main-to-next-refactor.md)，逐功能状态见 [feature-map.csv](feature-map.csv)。

## Twin 最新增量（2026-10-25）

以下旧轮次记录保留为历史；当前页面边界、验收结果和未完成项以本节及 [Twin baseline](twin-parity/baseline.md) 为准。状态仍为 **IMPLEMENTING / NOT PARITY_VERIFIED**。

- 按用户确认，以 `SemiconFab/twin.html` 最终加载的 117 台模板机台 + 4 台目录模型为唯一机台构造参照。全部 121 台实际 WebGPU 场景边界复核通过，最大差异 `8.52346417445915e-7 m`；这不是厂家实测 CAD 认证。
- 删除独立 Preview 页面/组件和首页空间画布；网站入口只保留普通 3D FAB 新标签链接，旧 `/preview` 兼容地址规范化为 `/twin`。产品保持一个纯 WebGPU 3D 实现。
- 统一 Spatial/Tour/Wafer/Research/Onboarding 状态机、Esc 退出导览、B01 本地 DEMO 场景/1600ms tick/手动状态、精确原版别名回放。原始 217 台仿真设备仅 94 个别名有布局目标，碰撞按原版插入顺序最后写入生效；未映射机台保留当前会话快照。修复 Research 重入旧快照和英文工艺搜索。
- 原版 24 根立柱、55 块常显琥珀 FFU、地坪纹理/分区和软帘已移植；修正重复环境光、源衰减、LinearEncoding 输出与 fog。新增原版压差场及 1500 个层流粒子。完整一般 FFU/HVAC/屋顶和 B1 工业设施仍未完全对齐。
- 字体恢复原版 12px 微文本归一化规则；增加共享中英切换、原 storage 键、URL/刷新持久化和原版 SVG 控件。完整 HUD/边栏/检查器/弹窗/主题仍需继续。
- 真实深度阴影验收：783 caster / 12,454 三角形；78,917 个可见变暗像素、ambient 改变像素 0、GPU errors 0。Cut 下 25,301 个可见阴影像素；关闭 Cut 后深度覆盖精确恢复。
- 严格 device-loss 验收推翻了旧“等待首帧完成”误判：新增明确完成态和 validation scope，补齐 Babylon 9.32 WebGPU 恢复遗漏的场景几何重建。普通场景及 1500 粒子场景均通过实际 GPUDevice.destroy 恢复，错误 0、手动视角偏差 0。尚未做仪表化 60 分钟/显存/跨浏览器验收。
- 原版 263 个原始 ID 属性及 218 个命名函数已生成台账；11 组同视口候选 Golden PNG/DOM JSON 和 SSIM/diff 已保存。当前整页 SSIM 约 0.37–0.65，**不能当作视觉验收通过**。详见 [evidence](twin-parity/evidence/README.md)。

本次全量校验：15/15 Python、67/67 .NET、81/81 Vitest、类型检查、三个后端 Release 构建及前端生产构建通过。`verify.ps1` 的 Windows 全局 pnpm shim 仍有路径问题，本次在当前进程内将其同版本 pnpm 调用转发到已安装的 `pnpm.mjs`；未修改全局设置。生产 GPU 分块约 2.51 MB / gzip 590 KB，仍有大分块提示。原版源码哈希保持不变，无模型加载请求/资源/loader 依赖。

独立只读审查发现的回放快照、英文搜索、首次相机过渡被未启动导览取消的问题均已修复并复测；当前无 Critical/Important 源码问题遗留。完整视觉/性能发布门禁未被这次代码审查替代。

## 当前交付

首批覆盖 MIG-01 的数据导入与目录查询，以及 MIG-02 的目录/详情/对比。两个工作包仍有待办，不能整体标记完成。

- `tools/migrate_legacy_data.py`：保存八份原文件的完整字节、哈希及来源路径；生成内容哈希命名的不可变快照。相同输入不会生成第二个版本；坏行保存字段/索引问题，存在问题时不切换 `current.json`。
- 当前快照导入 253/253 条目录，拒绝 0 条；包含 116 条 OEM、86 条 OSAT、167 个价格项、103 行 BOM、121 项布局的原始资产。目录型号、BOM 行、布局项与模拟机台数量各自独立。
- `Fab.Catalog`：与 Site/Run 状态分开的只读目录；复用开发身份，支持领域/分类/搜索与单记录查询。缺失或损坏的资产返回 503；构建及发布产物携带数据文件。
- `/catalog`、`/catalog-demo.html`：FAB/OSAT、搜索、分类、隐藏 draft、分页、详情及字段来源、本地 JSON 预览、目录/记录导出。
- `/compare`、`/compare.html`：最多四项、字段并集对比、未知值与估价区间、查询参数分享。本地预览在目录/对比及前进后退之间保留；预览数据需导出 JSON 分享，URL 不包含这些记录。
- 中文/英文、明暗主题、原语言存储键及 `lang/theme` 参数；目录页仅渲染派生数据，不会将本地预览变成服务端审批或运行状态。
- `web_app/src/` 仅 TS/TSX；`tests/` 与 `assets/` 为同级目录。启动入口、工作台、错误边界分离。Babylon 由三维视图按需加载，目录页不加载 GPU 模块。

## Twin 页面骨架（2026-10-24）

新增 `/twin` 页面级入口，作为 `twin.html` 1:1 对齐的 TWIN-02 起点；它复用现有单 FAB `SiteScene`/WebGPU 运行时，增加顶栏、相机预设、L1/B1/DUAL/EXPLODED、连续 0–100% Explode 滑条、X/Y/Z Cut 与 Invert、五站 Cinematic Tour、三步首次引导、All/UPW/Gas/Vac/Exhaust/AMHS X-Ray 过滤、Research JSONL 聚合回放（WIP/Active/UTIL/时间轴/倍速）、Wafer Follow A/B/C（120/104/92 步、FOUP 本体/法兰/门、30 点渐隐轨迹、Catmull-Rom 75/25 过渡-停留、相机跟随、1×/4×/16×）、SEMI MES E40/E87/E94（Track-In/Track-Out/Hold）、FDC SPC（Cp/Cpk/σ/Nelson）、YMS（WM-811K 图谱、26×26 Die Map、STDF V4、8 段 Yield Waterfall、Poisson/Murphy/Seeds、LIVE+6 场景）、图层、设备清单、选中检查器、AMHS/KPI/底部 HUD。Cut 使用真实 `scene.clipPlane`；静态阴影在 Cut 期间关闭，避免未裁剪的阴影残留。原预览 `/preview` 保留。Research 的逐设备着色仍待机器 ID 映射；未完成项与基线记录见 [twin-parity/baseline.md](twin-parity/baseline.md)。

### 原版目录/检查器与 Roof HVAC（2026-10-25）

- 冻结原版最终目录为 **18 行**（12 个 B1 设施、2 个风淋、4 台目录机型），116 条 OEM 记录保持页内浏览；220 个原版信号键按源顺序和最后写入者规则投影到 121 台布局实例。
- 左侧恢复双标签、横向类别、四态计数和原版设备卡片；右侧检查器按 reference/OEM/layout 三种选择恢复 CAD 立面、重量/尺寸/来源等级、规格、来源链接、FDC、MES、SPC 和联动设备。
- 新增原版 `buildRoofHVACLayer` 的 Babylon 移植：85×60 m 屋面、4 段女儿墙、3 台 MAU、3 条送风主管、3 条支管、12 个下送风口、5 根排风烟囱与 70 个排风粒子；`Roof/HVAC` 独立开关并按语言刷新 3 张 MAU 标签。
- 新增原版两座风淋/气闸、6 块粘尘垫与 1569 mesh FFU 天花网格，替换早期近似风淋和简化天花；FFU 独立图层、12 秒 purge 动画、双语告示板。
- 全站引入 Redux Toolkit + RTK Query：Twin、工作台、目录、语言和仿真表单由 slices/query cache 统一管理，SSE 仍作为推送源，新增 `tests/redux-store.test.ts`。
- 新增数字孪生性能边界：Babylon 对象不进 Store；SSE/AMHS 遥测经 100ms 合并缓冲；Babylon 帧循环用 `store.getState()` 读取 demo/live 状态；高频 action 从 DevTools/序列化检查中过滤；Hover 拾取 50ms 节流。
- 新增 B1 密集工业层：3 条 94m 螺旋风管及吊架/支管/阀箱、5 条 84m 二次工艺管及阀轮、21 台干泵撬、4 台洗涤塔、4 台冷水机、68 台 MCC 柜、安全通道和高棚灯；B1/DUAL 独立显示。
- 新增巡检工程师相机跟随、Cut Invert、Research 利用率开关、页脚 ID 与 6m 网格/Subfab 深度徽标。
- 最新验证：TypeScript、118/118 Vitest、生产构建和 `/twin` 浏览器验收通过。Roof 模块 9 个 NullEngine 测试通过；尚未完成原版整页逐控件视觉阈值。

## 单 FAB 产品边界（2026-10-24）

原版 SemiconFab 只展示一个洁净室 FAB，本项目据此收敛多 FAB 入口：

- `SiteDirectory` 固定只生成 `FAB-01`，删除 `Fab:FabCount` 配置和 3 FAB 构造参数；场景成员必须恰好一个，否则 API 返回 400。
- 工作台只渲染一张 `FAB-01` 卡片；指标、表单文案、空状态和 Run 提交都按单 FAB 表达，不再出现“三个 FAB”“每 FAB Lot 数”或多 FAB 列表。
- `/preview` 与旧工作台空间预览继续只取该 FAB；API 对外仍沿用 `fabs` 数组以保持契约兼容，但数组长度恒为 1。

## FAB 单场景与 WebGPU 程序化验收（2026-10-24）

单 FAB 空间预览已完成程序化替代，不再加载 `fab.gltf` 或任何 glTF/GLB 资源，保留原版的单 FAB 边界。

- `web_app/src/procedural-fab.ts`：程序化生成 121 台设备、洁净室、Stocker/FOUP、FFU、空气淋浴、墙柱、Subfab 管线和 6 名 Bunny Suit 巡检人员；设备按原版 `layout-default.json` 的 rotation 数据旋转。
- `web_app/src/legacy-site.ts`：双环 OHT（24 车）、状态塔、层切换、B1 地下剖切、Explode、人员步态和 SSE 状态同步；设备阴影现由原生 WebGPU 静态深度缓存生成，详见下方追加验收。
- `/preview?siteId=…`：独立新标签页、单 FAB、全屏画布、LIVE SSE 状态、层控制、缩放、视图/模式、Tour、设备卡片和 OEM 目录入口。
- 仅使用 `WebGPUEngine`，无 WebGL fallback；`@babylonjs/loaders`、`babylonjs-gltf2interface` 及 glTF 资源已从源码、`node_modules` 和锁文件移除。

验证：TypeScript 通过；前端 32/32 Vitest 通过；Vite 生产构建通过；`site-preview.browser.ts` 通过（新标签页、单 FAB、实时状态、层、模式、设备/人员、缩放）。GPU 分块约 1.93 MB（gzip 约 456 KB）。

上述 32 项为此前一轮验证。当前新增验收如下；完整 HUD、整页像素一致性和真实 GPU 性能仍需单独验收。

### 原生深度阴影与 121 台机台逐台对齐（追加于 2026-10-24）

- `original-tool-geometry.ts` 直接移植原版 `getSilhouetteFamilyGeometries` 与 `createCatalogToolMesh` 的参数化形状。原版该布局实际为 **117 台八类模板 + 4 台目录模型**。删除旧的统一 1.55 倍放大、猜测性腔体、屋顶附件及重复旋转数据；尺寸、位置、旋转与模板选择由原始布局/目录决定。
- `tests/fixtures/original-tool-reference.json` 来自只读运行原版 `../SemiconFab/twin.html?layout=/twin/layout-default.json&mode=engineer` 的几何、材质与世界边界，记录三个来源文件的 SHA-256。仅为测试基线，不随产品加载。目录模型选中时的呼吸缩放在基线中归一化为 1；信号灯颜色继续由现有 SSE 状态控制。
- 单元比较覆盖全部 121 台的身份、坐标、旋转和边界、八类模板的顶点/颜色，以及四台目录模型每个部件的几何、材质颜色、透明度、金属度、粗糙度和线框边。原版来源文件哈希保持不变。
- **真实 WebGPU 场景复核 121/121 通过**：世界包围盒最大浮点差异 `8.52346417445915e-7 m`；这是程序几何一致性，不是厂家尺寸实测认证。原版概念模板的尺寸状态仍保留。
- `native-static-shadows.ts` 使用同一 GPUDevice 上的 `depth32float`、2048² 纹理和原生 depth-only pipeline；`native-shadow-material.ts` 在 Standard/PBR 主渲染中用 `textureSampleCompare` 过滤深度，只调制主光直射项。原有设备 Canvas 烘焙阴影已删除；移动 OHT/人员与状态灯不进入静态 caster 缓存。
- 当前静态深度记录 724 个 caster、11,756 个三角形。相机移动时保持一次生成；机台变换、FFU 显隐和光向变化各按需重建。像素读回测得 82,662 个明显变暗像素；关闭主光时阴影开关改变像素为 0，GPU validation errors 为 0。设备丢失后的 native 资源重建路径已实现，尚未单独进行设备丢失注入验收。
- 卡片增加原始 OEM 规格、工艺能力、来源、draft 标识和实时状态；定位框与鼠标拾取改为实际模型边界/三角形。修正滚动、Escape 关闭、FFU 初始状态、重载状态恢复及 B1 隐藏/恢复层的行为。
- B1 增加原版四条 84m 主管（UPW/PCW/气体/化学品）、五组穿板前级管/PCW 支管、套管、波纹节、支架与泵站，地坪恢复到 -7m。完整 B1 工业设施仍未宣称像素一致。

最新验证：**TypeScript、118/118 Vitest、67/67 .NET 测试、生产构建和完整预览浏览器回归通过**；新增 GPU 像素/缓存及 121 台实际场景边界验收通过。PBR GPU 分块约 2.47 MB（gzip 579 KB），仍有 Vite 大分块提示。没有 glTF/GLB 资源、加载代码或 loader 依赖；Babylon 核心内仍有通用 `FALLOFF_GLTF`/错误码等符号，不能把“无 glTF 加载”误报为构建文本不含任何 glTF 字符串。

2026-10-24 再次合入 7 个修复：REST/SSE 快照按站点、数量和单调时间戳统一门禁；错误 `siteId` 不再静默回退；场景按 `siteId/fabId` 重挂载并阻断 Abort 后写入；原生静态阴影缓存增加 Alpha caster 筛选、索引/几何修订号缓存键和 GPU Buffer 容量复用；PCF texel 尺寸改为实际深度纹理尺寸；静态 caster 列表不再每帧分配；设备恢复后重置首帧时钟。新增快照门禁单测后为 54/54；`native-static-shadows.browser.ts` 实测 724 caster、11,756 三角形、96,918 个变暗像素、GPU validation 错误为 0；几何原地更新令缓存 pass 从 8 增至 9 并恢复至 10。

服务端状态快照随后增加每站点单调 `sequence`（8 秒仿真 tick），REST/SSE 在同一 tick 返回同一序号；前端优先按序号拒绝迟到/重复帧，旧服务端缺少 `sequence` 时回退到时间戳。静态阴影几何 hook 接入 Babylon `onGeometryUpdated`，原地更新顶点/索引会自动递增修订号并失效缓存；直接写 GPU buffer 仍需显式 `invalidate('geometry')`。OHT 保留既有接触阴影，人员增加程序化地面接触圆盘；移动对象不进入静态 caster 集合，与原版静态设备阴影采用的分层方式一致。

本地证据：`.local/original-reference-top.png`、`.local/original-matched-top.png`、`.local/original-geometry-browser-acceptance.json`、`.local/native-shadow-acceptance.json`。这些属于本机验收工件，不包含在发布包中。完整原版 HUD/研究模式等仍按功能清单继续，不据本次机台与阴影验收标记整个迁移 complete。

## 验证与范围

执行入口：`./scripts/verify.ps1`，覆盖契约生成漂移、架构约束、导入校验、三个 .NET 项目的 Release 构建和测试、前端类型/单元检查及构建。本批最终结果：导入工具 8/8、后端 65/65、前端 27/27 通过；三个 .NET 项目 Release 构建、TS 类型检查与 Vite 构建通过，契约与架构检查通过。Vite 仍提示 Babylon GPU 分块约 1.9 MB（gzip 约 448 KB）；已按需加载，未据此宣称 GPU 性能达标。

浏览器入口：`node web_app/tests/catalog.browser.ts`，需要本地开发站点与监听 `127.0.0.1:9335` 的隔离 Chromium/Edge。已验证 253 条加载、隐藏 draft 后 9 条、OSAT 86 条与分页、真实输入搜索、详情/Escape、四项对比限制、旧入口/查询、本地导入失败保留数据、自定义新增/修改记录对比、前进后退、主题及原工作台 Run 完成。目录页未请求 Babylon/GPU 资源；本批浏览器运行未出现未捕获异常。

`dotnet publish fab_app/fab_app.csproj -c Release --no-build --no-restore -o .local/catalog-publish` 成功；发布目录中的 11 个数据工件与源工件逐字节一致。额外的独立进程启动冒烟检查被自动审批拒绝（仅返回 `blocked by policy`，无具体理由），因此不声称该项已通过。全部 139 个原版文件的哈希保持不变。

本批仅检查和保留原版 L1/draft 标签，**没有重新执行完整 L1/L2/L3 设备 Schema 校验**。没有进行真实 GPU 帧时/显存压测、工业接口认证或生产部署验收。

## 审查与修正

一次独立只读审查发现三项重要问题，均增加失败用例后修正：

1. 补回原版“隐藏 draft”，默认关闭；9 个非 draft 项包含 OSAT 的 Accretech SS20。
2. 本地预览对比改为保留同一页面数据状态，覆盖修改既有 ID 与新增 ID，避免导航后悄悄改用服务器记录。
3. 非字符串布局/BOM 引用与超大百分比改为字段级拒绝，避免异常绕过导入报告。

浏览器检查另复现并修复了默认 `fetch` 的接收者错误，以及目录页提前加载渲染器。主题 URL 覆盖已补回。中文作为新工作台默认语言保留，显式语言参数和原偏好优先；这是统一 Next 默认值的交互微调。

## 后续工作

- MIG-00：完整控件台账、Python 实际行为样例与 D01—D10 的模型裁决仍需继续，静态基线不算完整运行验证。
- MIG-01：补齐完整设备 Schema 等级/双语校验、OEM/OSAT 与发布目录的语义来源映射；当前只提供导入结构与引用检查。
- MIG-02：迁移首页知识内容、标准/验证说明、完整旧 URL/SEO/404、自动离线快照及其他横向页面能力。
- MIG-03 起：模板与二维布局、提交/替换、完整制造模型、FAB/OSAT 场景、两套成本与质量分析、五类工艺教学，继续按功能清单推进。
- 正式 PostgreSQL、身份/授权、实时流、共享资源与工业接口仍按各自门禁实现；当前开发模式不能直接解除环境限制发布生产版本。

原版源码、独有资料与唯一原始数据均保留；尚未删除旧项目或旧入口。
