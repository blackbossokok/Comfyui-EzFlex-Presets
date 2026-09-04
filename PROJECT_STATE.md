# EzFlex 插件套件 项目交接文档（V1.02 稳定版）

> 供新窗口继续开发使用。硬数据，无闲聊。
> **本版为 V1.02 稳定版**（`__version__="1.0.2"`，`pyproject.toml` 同步 1.0.2）。此前 1.4/1.6/1.0 等均为**测试版/RC**，V1.01 定稿后进入稳定维护分支；本次升到 **1.0.2**。
> **V1.02 变更**：①ModelsCombo 浏览弹窗搜索增强（按 标题/作者/类别/基础模型/标签/触发词/描述/版本/文件/全部 字段过滤 + 「搜索范围」下拉）；②移除全屏编辑器页面 `web/modelscombo.html`、设计参考 `web/FreeLatent.HTML`；③删除孤儿 `web/modelscombo.js`（侧边栏「模型组合」菜单入口，无节点引用、指向已删页面）与 `.bak_*` 备份残留。
> **依赖**：`mutagen>=1.46.0`（音频/视频标签读取，可选增强）；`ffprobe` 外部可选（`shutil.which` 探测），不装则只走 sidecar JSON 兜底。
> **已删**：`web/freeswitch_node.js`（旧 FreeSwitch 拆分占位，未 serve/未引用）；`web/modelscombo.html`、`web/FreeLatent.HTML`（用户已删）；`web/modelscombo.js` 与 `web/*.js.bak_*`、`__init__.py.bak_*`（本次清理）。
> **环境**：ComfyUI `0.30.x`；前端 `comfyui_frontend_package`（Vue / Node 2.0，addDOMWidget）。
> venv python：`<ComfyUI>\.venv\Scripts\python.exe`。
> 插件目录：`D:\software\AI_software\Comfy-Desktop\ComfyUI-Installs\Comfyui0.30.1\ComfyUI\custom_nodes\Comfyui-EzFlex-Presets`
> **最新稳定版行为见文末「最新稳定版（V1.02 定稿）」**（历史“Blender g/r/s + 坐标球”方案已整体回退）。

---

## 0. 当前状态（8 节点定版）

节点（类别均 `EzFlex`，Add-Node 菜单顺序）：
`EzFlex-MainControl → EzFlex-ModelsCombo → EzFlex-FreeLatent → EzFlex-NodeSwitchMaster → EzFlex-NodeSwitchGroup → EzFlex-ParamPresetControl → EzFlex-ParamPresetOutput → EzFlex-PreviewAny`

- 版本：`__init__.py` `__version__="1.0.2"`；`pyproject.toml` `version="1.0.2"`。
- 控制链：`MainControl → Master → Group → node.mode(0/2/4)`；`ParamPresetControl →(连线)→ ParamPresetOutput`。
- `EzFlex-PreviewAny`：白板放置多个可拖拽排序的预览卡片，每卡一个 `input_N`(ANY) + `output_N`(STRING)，
  接收任意输入自动解析为文本/图像预览并逐个输出字符串；参考 AUNPassthroughAnyMulti。
- 控制类节点（MainControl/Master/Group）为**纯前端生效**（rgthree 同款：Python 只承载 config，`run` 返回 `()`，
  mode 在浏览器端改、随工作流序列化）。

---

## 1. 目录结构

```
Comfyui-EzFlex-Presets/
├── __init__.py              # 8 节点类 + 预设路由 + 输出类型同步路由。__version__="1.4.0"
├── pyproject.toml           # version=1.4.0
├── README.md                # 使用说明（本批已更新）
├── PROJECT_STATE.md         # 本文件
├── user_data/               # 每节点一个预设库（命名预设，按节点名共享，跨工作流复用）
│   ├── EzFlex-ModelsCombo.json
│   ├── EzFlex-FreeLatent.json            # 宽高预设 + customRatios
│   ├── EzFlex-NodeSwitchMaster.json
│   ├── EzFlex-MainControl.json
│   └── EzFlex-ParamPresetControl.json
└── web/
    ├── modelscombo_node.js        # ModelsCombo 内嵌面板（addDOMWidget）
    ├── freelatent_node.js         # FreeLatent 内嵌 canvas 分辨率选择器
    ├── ezflex_service.js          # 共享：NODE_TYPES/注册表/事件总线/分组匹配/预设库API/弹窗/缩放手柄
    ├── node_switch_group.js       # NodeSwitchGroup 面板
    ├── node_switch_master.js      # NodeSwitchMaster 面板
    ├── main_control.js            # MainControl 面板
    ├── param_preset_control.js    # ParamPresetControl 面板 + 动态端口
    ├── param_preset_output.js     # ParamPresetOutput 面板 + 动态端口
    ├── preview_any.js             # PreviewAny 白板 + 拖拽卡片 + 动态 socket + 预览
```
> 注：`web/modelscombo.html`、`web/FreeLatent.HTML`（用户已删）、`web/modelscombo.js`（孤儿入口，已删）、`freeswitch_node.js`（已删）均不再存在。
> 注：NodeSwitchGroup 的命名预设已改为**按实例存 config**（不再写服务器），故 `user_data` 里没有
> `EzFlex-NodeSwitchGroup.json`。

---

## 2. 各节点当前行为

### EzFlex-ModelsCombo（模型组合加载器，经典 API）
- 输入 `config`（隐藏 STRING），输出 `MODEL/CLIP/VAE 1..N`。
- 面板：添加加载器 + 每行类型/名称/文件/额外参数（device/weight_dtype/clip type/LoRA 强度/目标）。
- **背景已改白**（米黄 → `#ffffff`，卡片淡灰 `#f9fafb`，边框/文字中性化，与其它节点统一）。
- **预设下拉「选中即生效」**：`presetSel` 的 `change` 直接 `loadPreset`（`加载` 按钮已删除）；选到占位则清空内部。
- **(V1.4) 换预设不断连**：`updatePorts` 复用输出 socket 时，先按名称（拖拽排序时连接跟随同名 socket），名称变了但「类型+位置」没变（如 anima→krea2 都是 checkpoint）则按位置+类型复用该 socket，只改名不断连。
- **「⧉ 浏览」弹窗（新增）**：工具栏「添加加载器」与「预设名」之间新增「⧉ 浏览」按钮，打开全屏模型浏览器，读取 LoraManager 生成的 `<模型名>.metadata.json` + 同目录预览图（`/models_combo/lora_meta` 列表、`/models_combo/lora_meta_detail` 详情、预览复用 `/models_combo/preview`）。
  支持 checkpoint / unet（diffusion_models）/ lora 三种可映射类型（embeddings 跳过）；顶部标签栏分离「全部 / Checkpoint / UNET / LoRA」；左侧文件夹树（LoraManager 风格 SVG 图标，灰色文件夹；点文件夹名任意处即展开/收起并选中，含 树/列表切换、递归（开启即展开全部）、全部折叠、隐藏/展开侧栏（收缩成 34px 窄轨，与收缩按钮同一行）四个小按钮）；卡片为「类型+架构缩写」左上角徽章、右上角半透明「+ / −」按钮（可添加/移除对应加载器）、底部毛玻璃(blur)信息条只显示 标题 + 版本号（如 BMTOL_STYLE / v1.0）；卡片/详情预览同时尝试 img+video（视频取首帧作封面），无预览背景为灰色；点卡片弹详情子窗（描述按 Civitai HTML 原样渲染，标题/链接/段落不挤成一段）；白色简约风，全屏默认。
- 实例 API：`node._ezComboAPI = { presetNames(), current(), setCurrent(name), refresh() }`
  （`current()` 优先读自身 `.mc-preset-sel` 的 value；`setCurrent('')` 清空 loaders + 重绘）。

### EzFlex-FreeLatent（分辨率/Latent 选择器，V3 io.ComfyNode）
- 输入 `config`（隐藏）+ `width/height/batch_size`（INT 可连接，>0 覆盖）；输出 `Latent/Width/Height/Batch`。
- 内嵌 canvas：拖拽画布选尺寸（Shift 保持比例、Ctrl 关 8 对齐）、最大边、批次、算法、MP、比例下拉。
- **宽高预设**（`/freelatent/presets`）下拉「选中即生效」；比例预设（`customRatios`）在预设行尾。
- 实例 API：`node._ezLatentAPI = { presetNames(), current(), setCurrent(name), refresh() }`
  （`presetNames()` 用 `seedPresets` 规范化——丢弃旧版比例尺寸预设、默认项置顶，与自身下拉一致；
  `current()` 读自身 `.els.presetSel` value；`setCurrent('')` 清当前）。

### EzFlex-NodeSwitchGroup（分组预设，经典 API，纯前端）
- config：`{ filters:{mode:'title'|'color', match, showAllGraphs, sort}, states:{分组标题:mode}, presets:{名称:{label,states}}, current }`。
- **rgthree 式自动发现**：扫描画布分组（Ctrl+G）。两行控件：上行=预设（全部开启 + 保存/删除预设）；
  下行=匹配方式(按标题/按颜色) + 匹配值 + 排序(按位置/按字母) + `子`(子工作流生效)。
- 颜色模式：色点调色盘（ComfyUI 精确 groupcolor：red=#A88/brown=#b06634/green=#8A8/blue=#88A/
  pale_blue=#3f789e/cyan=#8AA/purple=#a1309b/yellow=#b58b2a/black=#444）+ 原生取色圆盘 + 保存/删除颜色预设（localStorage）。
- **命名预设按实例存 config**（`presets` 键），同名/不同匹配条件的多个 Group 节点互不影响。
- ⚠️ **多 Group 同屏修复（V1.0）**：自动重扫的分组发现定时器**必须按节点放**（`node._ezScanTimer`），
  不能共用模块级 `_scanTimer`——否则多个 NodeSwitchGroup 会互相 `clearTimeout`，只剩最后一个在刷新分组列表，
  表现成“分组/预设串线”。节点删除时清 `clearInterval(_ezScanIv)` + `clearTimeout(_ezScanTimer)`。
- ⚠️ **同名分组状态键（V1.0 修复）**：同一节点内可能有两个**同名分组**（如都叫 `Group`）。若 `states` 只按
  `g.title` 作 key，保存/应用时后者覆盖前者 → 出现“双绕过/双禁用/双开启”。现在用 `groupKey(st, g)` =
  `title + '##' + idx`（同一节点内同名分组的出现序号）作键，并保留旧 `title`-key 兜底；非同名分组键=title（向后兼容旧预设）。
- 实例 API：`node._ezGroupAPI = { presetNames(), states(), current(), setCurrent(name), refresh() }`。
- 匹配用 `allGraphGroups`/`groupNodes`/`normalizeColor`；面板标题由节点标题栏编辑（轮询联动 Master/Main）。

### EzFlex-NodeSwitchMaster（节点控制总预设，经典 API）
- 行 = 画布上的 NodeSwitchGroup 实例（`nodesOfType(GROUP)`）；每行一个下拉选该分组的预设。
- 总预设 = `{nodeId: 分组预设名}`；命名总预设存 `/nodeswitch_master/presets`。
- **行下拉「点开即刷新」**（mousedown→fill）+ 700ms 轮询（标题/预设名/当前值）自动刷新。
- 实例 API：`node._ezMasterAPI = { presetNames(), current(), setCurrent(name), refresh() }`。

### EzFlex-MainControl（总控制节点，经典 API）
- **被控目标**：`EzFlex-ModelsCombo`、`EzFlex-FreeLatent`、`EzFlex-NodeSwitchMaster`、`EzFlex-ParamPresetControl`
  （卡片顺序 默认 Combo→Latent→Master→ParamCtrl）。
- **总预设 = `{nodeId:{type,preset}}`**；命名总预设存 `/main_control/presets`；**左上角预设只保留 `default` +
  服务器预设**（无“全部开启/禁用/绕过”基础项；`default` 为空操作）。
- 加载单个节点 / 加载全部：`SCAFFOLD_TYPES=[Combo,Latent,Master,Group,ParamCtrl,ParamOut]`；
  加载全部**按创建成功顺序紧凑 2 列排布**（第 1 列右对齐、逐行下堆叠，宽节点不重叠）。
- 卡片下拉：Combo/Latent 带常驻「—— 预设 ——」占位；点开即刷新；700ms 轮询 `syncCards` **就地更新**
  选中值/标题（不整卡重建，避免闪烁）。
- **卡片拖拽排序**：克隆影子 + 3px 高亮插入线 + pointer 捕获（`attachCardDnD`），落下存 `config.cardOrder` 并重排显示。
- 实例 API：`node._ezMainAPI = { presetNames(), current(), setCurrent(name), refresh() }`。

### EzFlex-ParamPresetControl（参数预设控制，经典 API，动态输出）
- config：`{ groups:[{id,name,params:[{id,name,type,value,enabled}]}], current }`；命名预设存
  `/param_preset_control/presets`（`default` 是**真实预设**，首启自动补空 default，同名保存即覆盖）。
- 面板：预设下拉 / 保存 / 删除 / 重置 / 新增参数组，参数组列表**拖拽排序（插入线）**，编辑弹窗
  （参数增删、**拖拽排序（插入线）**、名/类型/**自动增高 textarea 值输入**）。
- **值类型校验**：int/float/bool 严格；string/复杂类型（complex/tuple/list/set/dictionary）不飘红
  （后端按 STRING 原样输出，不解析 Python 字面量）。
- 动态输出端口 = 参数组数 1:1（`EZFLEX_PARAM_GROUP`）；`updatePorts` 复用 socket（`_ezGroupId`）、重排、
  更新 `o.links`(∪`o.link`) `origin_slot`、POST `/param_preset_control/outputs` 同步类属性。
- **换预设不断连（V1.0 修复）**：`updatePorts` 复用顺序 = ①按 `_ezGroupId` 精确复用（同组仍在）→ ②**按位置复用
  第一个未使用旧 socket**（预设切换/重排时组 id 变化但端口“还在”，直接用旧 socket 顶替，保留 Control→Output 连线；
  类型恒为 `EZFLEX_PARAM_GROUP` 不与下游冲突）→ ③不足才新建。复用后覆盖 `_ezGroupId` 并 `notifyOutputs`，
  Output 侧 `connectedGroup` 读到新组 id 自己重算参数端口。刷新/重启的 `linkObjMissing`/`deferUnresolved` 守卫不变。
- 删除参数组用自绘 `uiConfirm`。

### EzFlex-ParamPresetOutput（参数预设输出，经典 API，动态输出）
- 输入 `group`（EZFLEX_PARAM_GROUP）；输出 = 参数数 1:1，按类型映射
  (int→INT/float→FLOAT/string→STRING/bool→BOOLEAN/complex…→STRING)。
- **禁用参数**：端口保留、输出该类型**中性默认值**（int→0、float→0.0、bool→False、其余→""），
  不再是 None/跳端口——保留接线、重开启无需重连。
- 面板：显示参数名/类型/值 + 开启/禁用；值 **>12 字符缩略显示**，点击弹只读文本框预览；禁用行半透明弱化。
- 端口 socket 只露圆点（`label=''`+`hideName`）；`updatePorts` 复用 socket（`_ezParamId`）、重排、更新 origin_slot、
  POST `/param_preset_output/outputs` 同步类属性。

---

## 3. 存储与路由

- 命名预设统一走 `_register_preset_routes(node_name, api_path)`（GET 列表 / POST 保存（同名覆盖）/ DELETE {name}；
  服务器 `user_data/<节点名>.json`，`utf-8-sig` 读）。路由：
  - `/models_combo/presets`（EzFlex-ModelsCombo）、`/freelatent/presets`（EzFlex-FreeLatent，with_ratios）
  - `/nodeswitch_master/presets`、`/main_control/presets`、`/param_preset_control/presets`
- 动态输出同步路由（前端 POST）：`POST /param_preset_control/outputs`、`POST /param_preset_output/outputs`。
- 节点当前状态存各自 config widget（随工作流）：Group(Master/Main) 存 current + 映射 + cardOrder；Group 存
  filters/states/presets/current；ParamPresetControl 存 groups/current。
- web 静态：`_serve_no_store` 覆盖全部 JS，前端刷新即生效；Python 改类需重启 ComfyUI。

---

## 4. 关键经验 / 坑

1. **动态输出用「类 RETURN_TYPES」而非画布 socket 类型**（execution.py 校验）。前端 POST 同步顺序。
   ⚠️ 类属性全局共享：多个同类型节点由最后 POST 者决定（ModelsCombo/ParamPreset 已知限制）。
2. **输出连接存 `o.links`（数组）/旧 `o.link`（单值）**；重排 socket 后必须遍历更新 `origin_slot`。
3. **动态端口按「逻辑 id」复用 socket**（`_ezGroupId`/`_ezParamId`），防重名；顺序 = want 数组顺序。
4. `window.prompt` 在 ComfyUI 不可靠 → 自绘 `uiPrompt`；确认用自绘 `uiConfirm`。
5. DOM 内拖拽用 **Pointer Events + window 捕获**（`attachDnD` 通用；克隆影子 + 占位线）。
6. 面板内层根 `position:absolute; inset:0 14px 14px 14px` 露出 socket 圆点；外壳透明。
   **缩放手柄** `installResizeHandles`：透明（无蓝线/圆点），只保留**竖向(下缘左)+斜向(右下角)**；
   **横向手柄已删除**（会挡住右缘输出 socket 拖线）；宽度靠斜向手柄横向拖。
   ⚠️ modelscombo/freelatent 仍有各自的边缘 overlay，若影响 socket 拖线需单独让位。
7. 复杂类型（tuple/list/set/dict/complex）无 ComfyUI 原生端口 → STRING 原样透传；前端不校验（不飘红）。
8. FreeLatent `presetNames` 用 `seedPresets`（丢旧比例预设/默认置顶），MainControl 读取要与之一致，
   否则两边选项数不同。
9. Combo 预设「选中即生效」；清空占位需同步清空内部（loaders/current），否则显示/内部不一致“固定”。
10. MainControl 轮询用 `syncCards` 就地更新 select 值（避免整卡重建闪烁）；卡片下拉用**签名缓存**避免点开闪。

---

## 5. 已回滚 / 不当方案（别再走弯路）

- 黑框定位用画布 DS 变换 → 错位，回滚到 DOM rect 版。
- `IS_CHANGED` 恒唯一 → 重跑，已删。
- `syncOutputTypes` 防抖 → 类属性滞后报错，改立即 POST。
- 经典 widget→socket 转换 → socket 漂移，改用 io `force_input`。
- Group/Master/Main 均用「实例注册表 + 事件总线」（`ezflex_service.js`）协同。

---

## 6. 已知注意 / 待办

- [ ] 类 RETURN_TYPES 全局共享（多实例由最后 POST 者决定）。
- [ ] modelscombo/freelatent 自身边缘 overlay 若挡住输出 socket 拖线，需单独让位（本次只修了 5 个 EzFlex 面板手柄）。
- [ ] MainControl 目标是 Combo/Latent/Master/ParamCtrl 的**预设**；Group/ParamOut 仅由「加载全部」创建，不直接控制。
- [ ] FreeLatent `seedPresets` 首启会写默认预设；`customRatios` 比例预设独立。
- [x] `web/freeswitch_node.js`、`web/modelscombo.html`、`web/FreeLatent.HTML`、`web/modelscombo.js`、`web/*.js.bak_20260902_021003`、`__init__.py.bak_20260902_021003` 均已删除（V1.02 清理）；`__init__.py` `_serve_no_store` 已同步移除 `modelscombo.html` 与 `modelscombo.js` 条目。
- [ ] 修改 Python（新节点/路由/类）需完整重启 ComfyUI；前端 JS no-store，刷新页面即生效。

---

## 7. 本地验证命令

```powershell
# Python 语法
python -c "import ast; ast.parse(open(r'<插件目录>\__init__.py',encoding='utf-8').read()); print('PY OK')"
# JS 语法（避免中文管道乱码）
Copy-Item <插件目录>\web\ezflex_service.js $env:TEMP\c.mjs ; node --check $env:TEMP\c.mjs ; Remove-Item $env:TEMP\c.mjs -Force
# venv 导入/实例化（Python 侧 PPO 禁用默认值等）
& "<ComfyUI>\.venv\Scripts\python.exe" <脚本>
# 前端：刷新 ComfyUI 页面即加载最新 JS（no-store）
```

---

# 本批新增 / 进展（预览·媒体·3D·参数值）

> 记录本项目（ComfyUI 自定义节点 `Comfyui-EzFlex-Presets`，分类 `EzFlex`，当前 v1.4.0）的关键设计、经验、数据与待办，便于后续接手/调试。

## 一、节点清单

| 节点 | 作用 |
|---|---|
| `EzFlex-ParamPresetControl` | 可视化编辑**参数组**（每个参数 name/type/value/enabled）；输出一个 `EZFLEX_PARAM_GROUP` 端口/组 |
| `EzFlex-ParamPresetOutput` | 接一个参数组；输出「整组数据(透传) + 每个激活参数一个端口」；做**二次校验与类型修正** |
| `EzFlex-PreviewAny` | 「任意预览」白板：`input_1..16`(ANY) + `STRING` 输出；按类型渲染预览卡片 |
| `EzFlex-ModelsCombo` / `FreeLatent` / `NodeSwitchGroup` / `NodeSwitchMaster` / `MainControl` | 其它控制/选择类节点 |

## 二、关键数据 / 常量（`__init__.py`）

- `_PREVIEW_MAX = 16`（PreviewAny 固定 16 槽）
- `_PREVIEW_MAX_IMG_SIDE = 1600`（图片/遮罩预览最大边，全屏需要高清所以调大；原先 400 全屏糊）
- `_PREVIEW_MAX_VALUE_LEN = 500`
- 类型映射：`PARAM_TYPE_MAP`（list/tuple/set/dict/complex→STRING；int→INT；float→FLOAT；bool→BOOLEAN）
- 临时预览文件目录：`folder_paths.get_temp_directory()` = `ComfyUI\temp`，serve 用 `/view?type=temp&filename=...`（生成型临时文件：`ezpv_img_*`/`ezpv_mask_*`/`ezpv_audio_*wav`/`ezpv3d_*`）；文件型原文件用 `/preview_any/serve_3d?path=...`

## 三、关键机制 / 方法（重要经验）

### 1. PreviewAny 的类型推断 `_infer_type`
- tensor→IMAGE/MASK/TENSOR；dict→LATENT/CONDITIONING/AUDIO/DICT；list→VIDEO/LIST/CONDITIONING；str→按容器识别 LIST/TUPLE/DICT/SET/STRING；bool/int/float。
- 对象按 `type(value).__name__` + **`type(value).__module__`** 判定（模块判定比属性探测可靠）：
  - `ModelPatcher*` 或 `comfy.model_patcher` → MODEL
  - `comfy.sd` 的 CLIP/VAE → CLIP/VAE
  - `VideoFrom*`/含 Video → VIDEO
  - `File3D*` → MODEL_3D
- **教训**：`hasattr(value,"cached_patcher_init")`/`hasattr(value,"patcher")` 在值经 ANY 代理后可能探测不到；模块判定更稳。

### 2. PreviewAny socket 方案（V1.4：动态「连一个加一个」）
- 已连接输入前置 + 末尾留 1 个空槽；输出与卡片 1:1（`connect one add one`）。
- `RETURN_TYPES` 动态（按实际连接数），由前端 POST `/preview_any/outputs` 同步 + `preview` 就地设置。
- 链路未恢复前不重排/删槽（`deferSync` 守卫），恢复后再重排并回写 `origin_slot/target_slot`。
- `OUTPUT_NODE = True`（避免「工作流未包含输出节点」）。
- 卡片顺序 = workflow 里 input 顺序（`_connected_inputs`）。

### 3. ParamPreset 三节点取值链路
- Control config JSON 存参数 `{id,name,type,value,enabled}`。
- **用户输入保持原样**（编辑卡不自动改写），失焦/变更只**校验**（类型不符红框）。
- 输出时：`parseParamValue(raw,type)` 类型感知——**符合→原生**（list/数组、tuple/set/数组、dict/对象、int/float/bool 数值），**不符合→字符串**。
- Output 二次校验：`实际类型 = string`（当值是字符串且声明类型非 string）否则`声明类型`；标签显示实际类型、不符标红；并在 `run` 里**修正组内 type**（无效→string），输出的组被 PreviewAny 读到修正后类型。
- 禁用参数中性值：`_ppo_disabled_value`：int/bool/complex→0、float→0.0、其它→空串。
- 复杂类型用 `parsePyLiteral`（JS 轻量 Python 字面量解析：单引号 dict/list/tuple/set/嵌套/True/False/None），Python 侧 `_python_to_json`（`ast.literal_eval`）。
- **教训**：`set` 集合 `{...}` 无冒号要在解析器里返回数组（否则被当成空 dict）。配置里复杂值需按类型严格匹配容器（list 只认 `[...]` 等），否则无效值会被解析成有效。

### 4. 预览媒体（全屏用原图/源文件，流式不编码）
- 图片/遮罩：卡片用缩略图；`image_src` = 原图 URL（写 ComfyUI temp，`/view?type=temp`）。
- 视频：文件型 `VideoFromFile` 有 `get_stream_source()`→挂源文件 URL（`video_src`，播放有声、不整段解码、只解首帧封面+元数据，避免卡）；图片序列才编码 WebM。
- 音频：文件型用源 URL；波形 dict → 写临时 WAV + serve URL（流式，避免 base64 大 payload 卡顿）。
- 3D：File3D → `MODEL_3D`，`save_to` 导出临时文件 + `/view?type=temp`；前端 three.js 本地包（`web/libs`）离线渲染 glb/gltf/obj/fbx。

### 5. 弹窗 / 全屏 / 关闭
- 弹窗点空白关闭用「pointerdown 记录是否在窗内 + click 门控」：按住拖出不关、单点窗内外才关。
- 全屏按钮在**右下角**；全屏时 ESC / 右上角 ✕ 退出（✕ 平时隐藏、靠近显示）；全屏退出自动停止媒体播放。
- 全屏 `.ezpv-fs`：`width:100%;height:100%;left:0;top:0;transform:none;max-*:none`（否则固定居中弹窗被 translate 平移出左上角）。
- 媒体全屏图片/视频：`width:100vw;height:100vh;object-fit:cover;max-width/height:none!important`（需覆盖内联 `video.style.maxWidth=720px`）。

### 6. 3D / 本地 three.js
- ComfyUI 内置 `Load3D` 支持 `.gltf/.glb/.obj/.fbx/.stl/.spz/.splat/.ply/.ksplat`，**不含 PMX**；PMX 需转 glb/obj/fbx。
- ComfyUI 前端打包的 `vendor-three-*.js` **非独立**（import 了 rolldown-runtime 等内部模块），不可复制。故把自包含 `three@0.160.0/build/three.module.js` + GLTF/OBJ/FBXLoader + BufferGeometryUtils + fflate + NURBSCurve 放进插件 `web/libs`、`web/utils`、`web/curves`，并把加载器 `from 'three'` 改成本地 `./three.module.js`。
- **serve**：新增后端路由 `GET /preview_any/3d/{path:.*}` 直接 serve 插件 `web/` 树（ComfyUI 默认不递归 expose `web/` 子目录，`/extensions/.../libs/` 会 404），前端 `THREE_BASE='/preview_any/3d/libs/'`。

### 7. config 输入口灰点/长提示
- 各节点输入口有个长标签「xxx面板生成的配置 JSON」+ 错位小灰点 = `config` STRING widget 的输入 socket。
- 解决：`hideConfigWidget` 里把名字为 `config` 的输入口**从 `node.inputs` splice 掉**（`i.hidden=true` 不生效）。不影响配置 widget（值在 `node.widgets`）。

### 8. 后端路由（`__init__.py`）
- `GET /preview_any/serve_video`、`GET /preview_any/serve_3d`（按 `?path=` serve 任意本地文件，带 Range）
- `POST /preview_any/folders`、`POST /preview_any/open`、`POST /preview_any/pick_folder`（tkinter 选目录）
- `GET /preview_any/3d/{path:.*}`（serve 插件 web 树）
- `GET /view?type=temp&filename=...`（ComfyUI 内置，serve temp）

## 四、Deps
- 必装：`numpy`、`torch`、`Pillow`（ComfyUI 自带）。
- 可选：`safetensors`、`gguf`、`onnx`、`av`（音频/视频编码/3D 解码）、`torchaudio`/`soundfile`。

## 五、工作流 / 运行注意
- Python 改动 → **重启 ComfyUI**（刷新页面 ≠ 重启后端）。
- JS 改动 → **Ctrl+F5 强刷**（普通 F5 会用旧缓存）。
- 临时预览文件（`ezpv_*`）会积累，建议加自动清理。

## 六、待办（下一步要解决的问题）

### ①（V1.4 已修）三段连线刷新后消失 / Control-Output 断连
`ParamPresetControl → ParamPresetOutput → PreviewAny` 连线在**工作流刷新/加载后消失**，以及 `Control→Output` **真实断连**。
- 根因：Control/Output 在链路恢复前就把动态输出 socket 收缩/重建，导致 `origin_slot/target_slot` 对应 socket 在 ComfyUI 接回 link 时不存在 → link 被丢。
- 修法（V1.4）：**链路恢复前不收缩**（`linkObjMissing` 守卫 + 自旋重试）+ **按位置复用旧 socket（保留 link）** + Control 侧 `connectedGroup` 按槽位回退解析 groupId；PreviewAny 加 `deferSync` 守卫。
- 现有复用/拖拽语义不变。

### ②（V1.4 尝试修复，待真机确认）model/clip/vae 显示 bare repr
- `_infer_type` 加强：`"ModelPatcher" in cls` / `"model_patcher" in mod`（覆盖 ModelPatcher 系列子类）、`comfy.sd` 下按 `CLIP`/`VAE` 类名识别；`_entry` 兜底 `is_model/is_clip/is_vae` 同步加宽。
- `_object_summary` 增加架构信息（`_model_type_str`），并**修复 `_model_type_str` 输出 bound method repr**（`callable` 时调用）；无名字时输出 `MODEL/CLIP/VAE object (类名)` 而非 `<... object at 0x...>`。
- `_model_meta` 现在**恒返回 JSON**（至少含「模型类型」），并读取 safetensors/gguf/onnx 的 architecture/author/title/tags/`ss_tag_frequency`（训练触发词/比重）等，点击模型卡片弹键值树可看（类似 lora-manager）。
- **关键修复**：`_model_meta` 原来是实例方法却用 `self._model_meta(...)` 调用 → 一直 `TypeError`，被外层 `except` 吞掉，导致元数据永远读不到（之前还会退化成 repr）。已加 `@staticmethod`。`_model_file_path` 也补成 `@staticmethod`。
- **`_model_file_path` 增加上游节点兜底**：从 `_connected_inputs` 拿到的上游加载节点 `widgets_values` 里按扩展名找模型/LoRA 文件名（如 LoraLoader 的 `lora_name`、UNETLoader 的 `unet_name` 等），再 `_resolve_model_path` 解析，解决「找不到模型文件路径」、从而能读到 LoRA 的触发词/训练比重。
- **读 LoRA 元数据**：`_model_file_path` 优先取上游节点 widget（LoraLoader 输出连到 PreviewAny 时读到的是 `lora_name` 的 LoRA 文件），这样点开卡片能看到该 LoRA 的 `ss_tag_frequency`（训练词/比重）、架构、作者等；大模型加载器读到的是大模型文件（元数据通常较少）。
- `_looks_like_file` 已放宽：匹配常见模型扩展名 / 含路径分隔符 / 含点且无空格的文件名；Lora 节点额外兜底任何含 `lora` 的字符串。
- `_resolve_model_path` 支持**子路径**（如 `画风\风格\Anima\kot2_Matte_s.safetensors`）：先按相对子路径找 `get_full_path`，再按 basename，再直接拼接各文件夹根目录。若仍读到大模型信息，多半是 PreviewAny 那格连的是“大模型输出”而不是“LoRA 加载器输出”。
- 模型文件名的可靠来源仍是 `cached_patcher_init`/`patcher` + 上游 widget 兜底。
- 需要**重启后端**后真机确认。

### ③（V1.4 尝试修复，待真机确认）3D 模型无法预览
- `_export_3d_url` 优先直接 serve 源文件路径（`File3D.path/file` → `/preview_any/serve_3d?path=`），失败才 `save_to` 导出到临时目录。
- 前端 `open3DViewer`：加状态栏（加载/进度/错误）；**只 import 需要的加载器**（原来无条件 import 全部 4 个，其中一个缺失会把整个 3D 预览拖垮）。
- `FBXLoader.js` 依赖 `web/curves/NURBSUtils.js`——已**补上该文件**（three.js NURBSUtils 移植，提供 `calcBSplinePoint`/`calcNURBSDerivatives` 及内部函数），FBX 也可加载。
- 加载器按 URL 扩展名挑（`ext3d()`，兼容 serve_3d 带查询串）。
- **V1.4 增强**：3D 查看器改为 Blender 风格导航——左键环绕 / Shift·右键平移 / 滚轮缩放；修复相机 `lookAt` 缺失导致的空白。
- **V1.4 现代 UI**：右侧控制面板（背景色、材质预设、材质颜色、网格、操作对象、相机透视/正射、视场、灯强、复位），右下角全屏按钮（复用 `.ezpv-fs`），材质预设含 原始/陶土/玻璃/塑料/金属/线框（`MeshStandard/MeshPhysicalMaterial`）。
- **操作对象**：右侧「操作对象」下拉 = 无(相机)/旋转对象/移动对象/缩放对象；左键拖拽执行对应对象变换；复位视角会同时复位对象位置/旋转/缩放。
- **Blender 风格**：左键在模型上**点击选中**（高亮+坐标球 X/Y/Z 箭头，可拖拽平移）；键盘 `g` 移动 / `r` 旋转 / `s` 缩放（鼠标移动调整，左键确认、右键或 ESC 取消）；ESC 再按关闭。
- **材质面板**：默认白色陶土；材质下拉含 原始/自定义/陶土/玻璃/塑料/金属/线框，滑块组对齐 Blender Principled：基础色、金属度、粗糙度、折射率IOR、Alpha、清漆、清漆粗糙度、透射、厚度、自发光、边缘光泽、光泽粗糙度、薄膜(Iridescence)、高光强度（MeshPhysicalMaterial）。
- 需真机确认：点击 3D 卡片能否弹窗渲染；若仍空看状态栏文本定位是模块加载还是文件解析。

## 七、验证要点
- 参数系统：编辑卡输入 `{'a':1}`(dict)、`(1,2,3)`(tuple)、`{1,2,3}`(set)、`[1,2,3]`(list)，失焦后不红框、输出原生/字符串符合类型；无效（list 写 `(1,2,3)`、int 写 abc、dict 写 `{1,2,3}`）红框 + 类型标签显示 string。
- Output：字典/list/tuple 弹键值树；set 走文本；无效值类型标签标红。
- PreviewAny：类型徽章按实际显示（不标红）；嵌套字典/元组/集合逐层展开；图片/遮罩全屏用原图；视频/音频流式；3D 用本地 three。

---

# 最新稳定版（V1.02 定稿）

> 当前定为**最新稳定版 V1.0.2**。`__version__="1.0.2"`、`pyproject.toml version="1.0.2"`。
> 此前的“Blender 风格 g/r/s + 坐标球 + 选中框 + 变换原点”已**整体回退**（无法真机验证且多处抖动/失效），
> 改为下面这套稳定、简洁的预览版。以下均为当前真机确认过的行为。
> **V1.0 关键新增**：socket 触发区/面板布局重做 + 普通模式 / Nodes 2.0（Vue）双模式兼容（见 H 节）；
> ModelsCombo 新增「⧉ 浏览」批量添加弹窗（LoraManager 元数据/卡片布局）；PreviewAny 图片/视频/3D/音频「生成信息」读取链。
> **V1.01 新增修复**：NodeSwitchGroup（多 Group 定时器按节点、同名分组 `groupKey` 状态键）、
> ParamPresetControl 换预设不断连（位置复用旧 socket 保连接）。
> **V1.02 变更**：ModelsCombo 浏览弹窗顶部搜索增强（见 I.1 节）——新增「搜索范围」下拉，可按 标题/作者/模型类别/基础模型/标签/触发词/描述/版本/文件名·路径/全部 过滤；移除 `web/modelscombo.html`、`web/FreeLatent.HTML`；删除孤儿 `web/modelscombo.js`（侧边栏「模型组合」入口，无节点引用）与 `.bak_*` 备份残留；`_serve_no_store` 同步移除 `modelscombo.html`/`modelscombo.js`。

## A. 3D 查看器（稳定版）
- **纯预览**：左键拖空白=环绕、右键/Shift 拖=平移、滚轮=缩放、⛶/ESC=全屏/退出。
- **右侧「变换工具（拖模型）」**：3 个按键 移动 / 旋转 / 缩放。点某个按钮后，**左键在模型上按住拖动**即按该工具变换
  （移动=相机朝向平面拖动、旋转=拖转、缩放=上下拖）。空白处拖动仍是环绕。
- **已删除**：点击选中（黄框 BoxHelper）、g/r/s + x/y/z 键盘约束、坐标球（移动箭头/旋转圆环/缩放方块/合一）、
  变换原点标记。右侧保留：材质预设(原始/陶土/玻璃/塑料/金属/线框)+材质参数、网格开关、相机透视/正射、视场、灯光强度/颜色、复位。
- 贴图：模型外部贴图未加载（黑底）时，靠 `/preview_any/fs/<绝对路径>` + `resourcePath` 解析；若模型引用了 Textures/Materials
  子文件夹的相对路径，`_preview_any_fs` 会**按 basename 在模型目录递归兜底**。已删除「手动加载贴图」按钮（用户确认该问题源于模型的
  UV/JSON 引用，单纯导入贴图无法修复）。
- 移除死文件 `web/libs/TransformControls.js`（曾放入但未接线）。

## B. PreviewAny 输出 = 通配 `*` + 透传原始值
- `preview()` 现在**透传已连接输入的原值**（`outputs.append(kwargs.get(name))`），不再是卡片的字符串摘要。
- `RETURN_TYPES` 设成 `("*", ...)`（`/preview_any/outputs` 同步），前端 `addOutput(name,'*')`。
- 因此 PreviewAny 可**插在工作流中间**：任意值进去→显示预览卡片→**同一原始值**原样继续往下传，输出能连到几乎所有类型端口。

## C. ModelsCombo 后端类型 `*` + 加载时同步
- `RETURN_TYPES` 默认、`/models_combo/outputs` 同步、`load_combo` 运行期都设成 `*`（通配），避免刷新/重启后
  “工作流无法校验已连接的节点”（KSampler/VAEDecode/CLIPTextEncode 报错）。
- 前端 `updatePorts` 在**加载工作流时强制 `syncOutputTypes`**（原来仅“变化”时同步，加载后端口没变导致类属性滞后）。
- 前端端口仍显示 `MODEL/CLIP/VAE`（编辑时类型化，不乱连）；校验/执行按 `*` 接受。交换卡片/复用 socket/连线不断逻辑未动。

## D. 图片「生成信息」
- 预览图卡片右上角有「生成信息」按钮（图片来自 LoadImage 且源 PNG 内嵌 `prompt`/`workflow`/`parameters` 时）。
- `_parse_img_meta` 现在**同时读 `prompt` 和 `workflow`**，并**扫描组合配置 JSON**（EzFlex-ModelsCombo 的 unet/clip/vae/lora
  描述数组，`type:"lora"` 项）→ 能识别**藏在不同加载器里的 LoRA**。
- 展示分组：模型/LoRA/CLIP/VAE/提示词/反向提示词/采样参数/来源文件/原始文本块。
- **通用回退解析（新增）**：`_parse_img_meta` 增加不经硬编码节点类名的扫描，按「像模型文件名的字符串」归类模型/LoRA/CLIP/VAE，并抓取 Sampler 类的 seed/steps/cfg/sampler_name/scheduler/denoise → 覆盖 krea2 / flux2 / qwen 等新加载器或自定义节点时的 prompt 元数据。
- **图片路径更稳（新增）**：`_image_gen_meta` 的路径查找同时搜 output/temp/input 目录（生成图多在 output），兼容 filename 带子路径；`_file_gen_meta` 复用同一解析，供文件型视频/动画 webp 读内嵌文本块。
- ⚠️ **视频/3D/音频的「生成信息」依赖容器是否内嵌工作流**：PNG/WEBP/动画 webp 能读（PIL info），mp4/webm/glb/obj 等一般不内嵌 ComfyUI 工作流，`_file_gen_meta` 读到空则不出「生成信息」按钮（属正常，非 bug）。MODEL/CLIP/VAE 卡片一直能看「模型自身元数据」。
- **当前工作流兜底（新增）**：PreviewAny 的 `preview` 从 `extra_pnginfo['workflow']` 取当前图，`_workflow_gen_meta` 按节点类型/widget 尽力提取「模型/LoRA/CLIP/VAE + 提示词 + 采样参数」，凡 `entry` 没有文件 gen_meta 也没有自身 meta 的类型（视频/3D/音频等）都挂上「生成信息」→ 即使文件不内嵌工作流，也能看到本次生成用了哪些模型/提示词/采样器。
- **文件元数据读取（新增）**：`_file_gen_meta` 顺序尝试 ①PIL 内嵌文本块（PNG/WEBP/JPEG/动画 webp）→ ②同名 sidecar（`<base>.json` / `<base>.metadata.json` / `<file>.json` / `<base>.txt`）→ ③容器内嵌元数据（GLB/glTF 的 asset/extras/网格材质动画数，mp4/webm/mov 用 ffprobe 标签，mp3/flac/ogg/m4a/wav 用 mutagen 标签）。视频/3D/音频文件型预览都会挂「生成信息」。

## E. 模型元数据信息卡
- `_model_meta` 重构：**模型 / LoRA 分叉**（两者都存在时），重要字段在前、中文标签，
  `全部元数据` 折叠在最后。
- 新增字段：版本、来源/链接（Civitai url 或拼 `civitai.com/models/{id}`）、使用提示词/触发词、
  主要触发词（`ss_tag_frequency` 按次数取前 8）、网络类型（lora/lycoris/locon）、是否内嵌 VAE
  （`modelspec.contains`/`ss_vae_hash`）、存放路径、大小、修改时间、哈希值（≤1GB 计算；更大显示占位避免阻塞）。
- 前后端都有 `ss_*`/`modelspec.*` 的**中文悬停 tooltip**（来源/作者/哈希值/训练词比重/分桶等）。
- 去重：删掉独立的「主要触发词」与「训练关键词/比重」重复项后又按用户要求**保留两项并存**；
  「使用提示词/触发词」与「描述」去重；「训练维度 dim/模块」→「训练维度 dim」（不再抢 `ss_network_module`）。

## F. 全屏图片
- 全屏图 `object-fit:contain`（**不裁切**，完整显示原图，长>高/宽>高都完整）。
- 全屏可**滚轮缩放** + **按住拖拽平移**（放大>1x 时），松开即停；非全屏不缩放/不拖拽。
- 缩放/拖拽用 pointer capture，避免原生滚动拦截；重置在重开时自动 1x。

## G. 验证要点
- 重启 ComfyUI + Ctrl+F5（前端 no-store）。Python 改动需完整重启。
- `node --check`（各 `web/*.js`）+ `python -c "import ast; ast.parse(...)"` 均通过。

## H. socket 触发区 / 面板布局重做 + 普通模式 & Nodes 2.0 双模式兼容（V1.01 稳定版定稿）

### 目标
修复「socket 触发范围小」，让面板控件居中、只露圆点、可拖线，并**同时兼容普通（LiteGraph）模式与 Nodes 2.0（Vue）模式**。

### 关键结论（真机确认）
1. `addDOMWidget` 的 `canvasOnly` 是**二选一**：`true`=只在画布模式渲染（普通正常、Vue 空白），`false`=只在 Vue 渲染（Vue 正常、普通空白）。
   **不要固定写死**，用模式检测取 `canvasOnly: !__ezflexIsVueNodes()`。
2. **检测 Vue 模式**：`window.__ezflexIsVueNodes()`（`ezflex_service.js`）读 ComfyUI 设置 `Comfy.VueNodes.Enabled`
   （`app.ui.settings.getSettingValue`）。切模式时节点重建、setup 重跑自动取新值。
3. **面板穿透（否则 socket 圆点被面板挡住点不到）**：
   - 普通模式外层是 `.dom-widget.size-full`，Vue 模式外层是 `.lg-node-widgets / .lg-node-widget`。
   - ComfyUI 会反复重渲染这些外层并写回内联 `pointer-events:auto`，**只靠 JS 一次性置 none 会被冲掉**；
     必须用**常驻 CSS + `!important` + `:has()` 精确框定**。
4. **socket 圆点命中区小**：用 CSS 放大 `.lg-slot [slot-data]` 的命中盒（`z-index:9999` + `::after{inset:var(--ezfx-socket-pad,-8px)}`）；
   旧 LiteGraph canvas 路径用 `LiteGraph.SOCKET_RADIUS/SLOT_RADIUS` 兜底。

### 共享助手（`web/ezflex_service.js`）
- `enlargeSocketHitArea(radius)`：放大 socket 命中区（SOCKET_RADIUS/SLOT_RADIUS + `get_socket_at` 回退）。
- `hideSocketNames(node)`：隐藏原生 socket 文字（只露圆点）。
- `_applyPanelHitThrough(element)`（`makeDomWidgetHitThrough` / `applyDomHitThrough` 共用）：
  给面板加 `.ezfx-panel-shell` 标记；Vue 模式再加 `.ezfx-is-vue`；沿祖先链把 `.dom-widget/.dom_widget` 置
  `pointer-events:none!important`；控件（button/select/input/textarea）回 `auto`；注入基础 CSS。
- `socketPanelCSS(side)`：面板基础布局 CSS。
- `window.__ezflexIsVueNodes()`：Vue 模式检测。

### 注入的常驻 CSS（`injectSocketPanelBaseCSS`）
```css
.dom-widget.size-full:has(.ezfx-panel-shell){pointer-events:none!important;}        /* 普通模式：面板穿透 */
.lg-slot{position:relative!important;}
.lg-slot [slot-data]{position:relative!important;z-index:9999!important;}           /* 圆点抬到面板之上 */
.lg-slot [slot-data]::after{content:'';position:absolute;inset:var(--ezfx-socket-pad,-8px);pointer-events:auto;} /* 命中放大 */
.lg-node-widgets:has(.ezfx-is-vue){pointer-events:none!important;}                   /* Vue：widget 容器穿透→节点可整块拖 */
.lg-node:has(.ezfx-panel-shell) [class*="cursor-"][class*="-resize"]{opacity:0!important;}  /* 隐藏四角缩放图标，但保留缩放热区 */
.lg-node:has(.ezfx-panel-shell) .lg-slot .flex.h-full.min-w-0,
.lg-node:has(.ezfx-panel-shell) .lg-slot span.truncate{display:none!important;}      /* 隐藏原生 socket 文字(只藏文本容器，不藏圆点) */
.ezfx-is-vue [class*="-root"]{pointer-events:none!important;}                        /* Vue：面板体穿透→可拖 */
.ezfx-is-vue [class*="-root"] button,.ezfx-is-vue [class*="-root"] select,.ezfx-is-vue [class*="-root"] input,.ezfx-is-vue [class*="-root"] textarea{pointer-events:auto!important;}
.ezfx-is-vue [class*="-root"]{left:var(--ezfx-vue-side,10px)!important;right:var(--ezfx-vue-side,10px)!important;} /* Vue：加宽面板遮文字 */
.ezfx-is-vue[class*="-shell"]{top:var(--ezfx-vue-title,30px)!important;height:calc(100% - var(--ezfx-vue-title,30px))!important;bottom:auto!important;} /* Vue：面板下移避标题、底不溢出 */
```

### 关键参数（可在 DevTools 实时改，改后把值写回并告诉我）
- `--ezfx-vue-title`（默认 `30px`，Vue 面板距顶部=标题区偏移）。
  DevTools：`document.documentElement.style.setProperty('--ezfx-vue-title','40px')`
- `--ezfx-vue-side`（默认 `10px`，Vue 面板左右收窄=遮 socket 文字的宽度）。
- ModelsCombo / FreeLatent 的 `_vueH()`（默认 `30`）：Vue 下节点高度 = `内容高 + _vueH()`（标题偏移）。
  - 节点高度跟随加载器数量（`panelH()`），凸出/留白由 `_vueH` 控制：凸出→调大，留白太多→调小。

### 已知限制（V1.01 接受）
- **Vue 模式**下，内容较重的 `EzFlex-ModelsCombo` 与 `EzFlex-FreeLatent` 白色面板**底部仍会略凸出一点点**（白色面板底边略超节点卡片）。
  已在普通模式完美（内容包住、不凸出）；Vue 模式为可接受的轻微瑕疵，**不回退白框**。
- 其它面板节点两模式均完美。

### 经验 / 教训（重要）
1. **Vue 节点高度** 不走普通模式的 `computeSize`。`computeSize/getMinHeight` 在 Vue 里**能**把节点随内容变高（ModelsCombo/FreeLatent 已验证），但**不能单独用 MutationObserver + setSize 去追**——`root.scrollHeight` 会随节点变高而变高，形成反馈循环 → 无限增高/抖动。且 **不要给 `.lg-node` 设 `min-height:0`**（会把节点压扁坍缩）。
2. **shell 带 `h-full`（height:100%）**：直接 `top` 下移会让底溢出节点；必须用 `top + height:calc(100% - top)` + `bottom:auto`。
3. **ModelsCombo 的黑框标签（`installOutsideLabels`）要保留**（用户明确要求保留模型名），不要因 Vue 错位而整层禁用。
4. **标签策略**：默认保留节点 socket 文字（`hideSocketNames` 为通用助手，当前未用于任何正式节点；如需“只露圆点”的极简效果再对单个节点启用）。
5. **`visible` 优先于 `opacity:0`**：隐藏四角缩放图标用 `opacity:0` 但保留 `pointer-events`，这样缩放功能还在。
6. Vue 下无法右键/DOM 拾取 socket 元素，定位问题主要靠 `getBoundingClientRect()` + `.lg-node` 相对坐标 + `getComputedStyle`。

### 说明
- 曾用于验证的测试节点 `EzFlex-SocketTest`（`web/socket_test.js` + `SocketTestNode`）已**删除**（V1.01 移除），不再出现在 Add-Node 菜单。
- 相关 `SOCKET_TEST` 类型、`_serve_no_store` 条目、`NODE_CLASS_MAPPINGS/NODE_DISPLAY_NAME_MAPPINGS` 条目均已同步清理；无残留引用。

### 验证
- 普通模式与 Nodes 2.0 下各节点面板居中、圆点可拖线、面板控件可点、socket 文字被面板遮住。
- ModelsCombo/FreeLatent 在普通模式内容包住；Vue 模式底部略凸（接受的限制）。

---

## I. V1.01 关键经验 / 参数（ModelsCombo 浏览弹窗 + PreviewAny 元数据读取链 + 连接修复）

> 本节为 V1.01 稳定版新增/修复的核心机制，供后续开发直接参考。

### I.1 ModelsCombo「⧉ 浏览」弹窗（LoraManager 风格批量添加）

**后端（`__init__.py`）**
- 路由：`GET /models_combo/lora_meta`（列表，精简摘要）、`GET /models_combo/lora_meta_detail`（单个完整元数据）；预览复用 `/models_combo/preview`。
- `_META_LOADER_FOLDERS = {"checkpoint":"checkpoints","unet":"diffusion_models","lora":"loras"}`；**embeddings 跳过**（组合加载器无此类型）。
- 扫描每个类型的 `folder_paths.get_folder_paths(folder)` 根目录下所有 `<模型名>.metadata.json`；相对路径用 `os.path.relpath(file_path, root)`（file_path 来自 metadata 的 `file_path`），这才是 ComfyUI 能解析的 `/models/<folder>` 相对路径。
- `_lora_meta_summary` 精简返回：type/file/file_name/model_name/base_model/size/preview_url/tags/modelDescription/usage_tips/trainedWords/civitai（含 images 缩略与 creator/stats）。

**前端（`web/modelscombo_node.js`）**
- 状态：`_bbItems/_bbTabType/_bbSelFolder/_bbRecursive/_bbSidebarMode/_bbSidebarHidden/_bbExpanded/_bbTree`。
- 卡片：左上角「类型+架构缩写」（`_baseAbbr`，`_BB_ABBR` 映射：Anima→ANI、Illustrious→IL、SDXL→XL、NoobAI→NAI…，不认识取首字母）；右上角**半透明圆形按钮**「+ / −」→ `toggleLoaderFromMeta`（内部 `addLoaderFromMeta` / `removeLoaderFromMeta`，按 `type+file` 匹配）；底部**毛玻璃**信息条只显示标题+版本（`.mc-b-info`）。
- 侧栏文件夹树：由已过滤（按 tab 类型）的 `item.file` 目录段 `_buildTree` 生成；**点文件夹行任意处=展开/收起并选中**；`_bbRecursive` 开启时 `_expandAllFolders()` 展开全部；四个按钮=树/列表切换、递归、全部折叠、隐藏侧栏（收缩成 34px 窄轨，展开/收缩同一行原位切换箭头）。
- 关键：`item.file` 必须是 ComfyUI 相对路径；`_isLoaded(node,type,file)` 防重复；`renderLoraBrowserGrid` 每次重建卡片并调 `renderFolderSidebar`。
- **头部搜索（`.mc-bb-search`）+ 搜索范围下拉（`.mc-bb-searchfield`，位于搜索框后）**：`input`/`change` 事件写入 `_bbQuery`/`_bbSearchField` 并即时 `renderLoraBrowserGrid`。搜索范围选项：全部字段 / 标题·名称 / 作者 / 模型类别 / 基础模型 / 标签 / 触发词 / 描述 / 版本 / 文件名·路径；字段提取自 `model_name/file_name/file/base_model/author` + `tags/trainedWords/modelDescription/description/usage_tips/notes` + `civitai`（name/modelName/baseModel/description/tags/creator/modelType）；数组元素归一化为字符串（兼容字符串、`{name}`/`{tag}`/`{label}`/`{text}` 对象及嵌套数组）。`author` 由后端 `_lora_meta_summary` 补充（优先 `meta.author`，再取 `meta.creator.username`）。
- 入口按钮在 `buildRoot` 的 `.mc-bar`：`addSel`（添加）之后插入 `browseBtn`，点击 `openLoraBrowser(node)`。

### I.2 PreviewAny「生成信息」读取链

**优先级**（`_file_gen_meta(path)`）
1. PIL 内嵌文本块（PNG/WEBP/JPEG/动画 webp）→ `_parse_img_meta`（含 `prompt`/`workflow`/`parameters`）。
2. 同名 sidecar：`<base>.json` / `<base>.metadata.json` / `<file>.json` / `<base>.txt`（`_read_sidecar_meta`）。
3. 容器内嵌：GLB（纯 Python 解析二进制 JSON chunk，`_glb_meta`）/ glTF（`_gltf_meta`）/ 视频（`ffprobe`，回落 `mutagen`，`_video_container_meta`）/ 音频（`mutagen` 标签，`_audio_tag_meta`）。

**工作流兜底**（`_workflow_gen_meta(extra_pnginfo["workflow"])`）：按节点类型/widget 尽力提取 模型/LoRA/CLIP/VAE + 提示词 + 采样参数；凡 `entry` 没有文件 gen_meta 也没有自身 meta 的类型（视频/3D/音频等）都挂「生成信息」。**防误导守卫**：若上游是 `Load*/FromFile`（文件加载），不拿当前工作流参数冒充外部文件的生成参数。

**关键点**
- 图片路径查找：`_image_gen_meta` 搜 `output/temp/input` 三个目录（生成图多在 output），兼容 filename 带子路径。
- `_parse_img_meta` 的**通用回退扫描**：不依赖硬编码节点类名，按「像模型文件名的字符串」归类（`.safetensors/.ckpt/.pt/.pth/.bin/.gguf/.sft/.onnx/.lora/.zip`），抓 Sampler 类 seed/steps/cfg/sampler_name/scheduler/denoise —— 覆盖 krea2/flux2/qwen 等新加载器或自定义节点。
- 前端：`entry.gen_meta` 出现即显示「生成信息」按钮（`openKeyValueModal`）；MODEL/CLIP/VAE 用自己的 `entry.meta`（模型元数据信息卡），不叠加 gen_meta。

### I.3 依赖 / 环境
- `pyproject.toml`：`version="1.0.2"`；`dependencies=["mutagen>=1.46.0"]`（音频/视频标签读取）；`ffprobe` 为外部可选（`shutil.which` 探测，不装则只走 sidecar JSON 兜底）。
- 前端 JS no-store；**Python 改动（新版路由/解析）需重启 ComfyUI**，前端 Ctrl+F5。
- 模型元数据读取只需 `safetensors`/`gguf`/`onnx`（ComfyUI 自带 `comfy.utils.load_torch_file`，缺失依赖时降级为「无元数据」）。
