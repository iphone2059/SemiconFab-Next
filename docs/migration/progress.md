# SemiconFab-main → Next 实施记录

日期：2026-10-24。首批实现分支为 `feat/main-to-next-migration`；GitHub 同步状态以远程 Git 记录为准，尚未部署生产版本。规划见 [迁移工作包](../superpowers/plans/2026-10-24-main-to-next-refactor.md)，逐功能状态见 [feature-map.csv](feature-map.csv)。

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

新增 `/twin` 页面级入口，作为 `twin.html` 1:1 对齐的 TWIN-02 起点；它复用现有单 FAB `SiteScene`/WebGPU 运行时，增加顶栏、相机预设、L1/B1/DUAL/EXPLODED、连续 0–100% Explode 滑条、X/Y/Z Cut 与 Invert、五站 Cinematic Tour、三步首次引导、All/UPW/Gas/Vac/Exhaust/AMHS X-Ray 过滤、Research JSONL 聚合回放（WIP/Active/UTIL/时间轴/倍速）、图层、设备清单、选中检查器、AMHS/KPI/底部 HUD。Cut 使用真实 `scene.clipPlane`；静态阴影在 Cut 期间关闭，避免未裁剪的阴影残留。原预览 `/preview` 保留。当前仍只是页面骨架，Research 回放明确标注未接入；未完成项与基线记录见 [twin-parity/baseline.md](twin-parity/baseline.md)。

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

最新验证：**TypeScript、45/45 Vitest、67/67 .NET 测试、生产构建和完整预览浏览器回归通过**；新增 GPU 像素/缓存及 121 台实际场景边界验收通过。PBR GPU 分块约 2.47 MB（gzip 579 KB），仍有 Vite 大分块提示。没有 glTF/GLB 资源、加载代码或 loader 依赖；Babylon 核心内仍有通用 `FALLOFF_GLTF`/错误码等符号，不能把“无 glTF 加载”误报为构建文本不含任何 glTF 字符串。

2026-10-24 再次合入 7 个修复：REST/SSE 快照按站点、数量和单调时间戳统一门禁；错误 `siteId` 不再静默回退；场景按 `siteId/fabId` 重挂载并阻断 Abort 后写入；原生静态阴影缓存增加 Alpha caster 筛选、索引/几何修订号缓存键和 GPU Buffer 容量复用；PCF texel 尺寸改为实际深度纹理尺寸；静态 caster 列表不再每帧分配；设备恢复后重置首帧时钟。新增快照门禁单测后为 45/45；`native-static-shadows.browser.ts` 实测 724 caster、11,756 三角形、96,918 个变暗像素、GPU validation 错误为 0；几何原地更新令缓存 pass 从 8 增至 9 并恢复至 10。

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
