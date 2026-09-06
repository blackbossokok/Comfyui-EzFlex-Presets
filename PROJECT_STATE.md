# EzFlex 插件套件 项目交接文档（V1.03 稳定版）

> 供新窗口继续开发使用。硬数据，无闲聊。
> 当前版本：`__version__="1.0.3"`、`pyproject.toml version="1.0.3"`（README 记为 `V1.03`）。
> 环境：ComfyUI `0.30.x`；前端 `comfyui_frontend_package`（Vue / Node 2.0，addDOMWidget）。
> venv python：`<ComfyUI>\.venv\Scripts\python.exe`。
> 插件目录：`D:\software\AI_software\Comfy-Desktop\ComfyUI-Installs\Comfyui0.30.1\ComfyUI\custom_nodes\Comfyui-EzFlex-Presets`

---

## 0. 当前状态（9 节点定版）

节点（类别均 `EzFlex`，Add-Node 菜单顺序）：
`EzFlex-MainControl → EzFlex-ModelsCombo → EzFlex-FreeLatent → EzFlex-NodeSwitchMaster → EzFlex-NodeSwitchGroup → EzFlex-ParamPresetControl → EzFlex-ParamPresetOutput → EzFlex-PreviewAny → EzFlex-PromptHelper`

- 版本：`__version__="1.0.3"`、`pyproject version="1.0.3"`、README `V1.03`。
- 控制链：`MainControl → Master → Group → node.mode(0/2/4)`；`ParamPresetControl →(连线)→ ParamPresetOutput`。
- 控制类节点（MainControl/Master/Group）为**纯前端生效**（rgthree 同款：Python 只承载 config，`run` 返回 `()`，mode 由浏览器端改、随工作流序列化）。
- `EzFlex-PromptHelper` 为**开发中**节点（V1.03 起列入清单，继续完善）。

---

## 1. 目录结构

```
Comfyui-EzFlex-Presets/
├── __init__.py              # 9 节点类 + 预设路由 + 输出类型同步路由 + 新增 PromptHelper。__version__="1.0.3"
├── pyproject.toml           # version="1.0.3"，dependencies=["mutagen>=1.46.0"]
├── README.md                # 使用说明（V1.03）
├── PROJECT_STATE.md         # 本文件
├── requirements.txt         # torch/numpy/Pillow/safetensors/gguf/onnx/av/mutagen
├── user_data/               # 预设库（运行期由服务器预设路由写入）
│   ├── EzFlex-ModelsCombo.json
│   ├── EzFlex-FreeLatent.json            # 宽高预设 + customRatios
│   ├── EzFlex-NodeSwitchMaster.json
│   ├── EzFlex-NodeSwitchGroup.json
│   ├── EzFlex-MainControl.json
│   └── EzFlex-ParamPresetControl.json
└── web/
    ├── modelscombo_node.js      # ModelsCombo 内嵌面板（addDOMWidget）
    ├── freelatent_node.js       # FreeLatent 内嵌 canvas 分辨率选择器 + 强
    ├── ezflex_service.js        # 共享：NODE_TYPES/注册表/事件总线/分组匹配/预设库API/弹窗/缩放手柄/面板穿透
    ├── node_switch_group.js     # NodeSwitchGroup 面板
    ├── node_switch_master.js    # NodeSwitchMaster 面板
    ├── main_control.js          # MainControl 面板
    ├── param_preset_control.js  # ParamPresetControl 面板 + 动态端口
    ├── param_preset_output.js   # ParamPresetOutput 面板 + 动态端口
    ├── preview_any.js           # PreviewAny 白板 + 拖拽卡片 + 动态 socket + 预览
    ├── prompt_helper.js         # PromptHelper 提示词助手面板（开发中）
    └── libs/ utils/ curves/     # three.js 与加载器/曲线资源（本地离线，供 3D 查看器）
```

> 注：`web/modelscombo.html`、`web/FreeLatent.HTML`、`web/modelscombo.js`、`freeswitch_node.js`、所有 `.bak_*` 均已删除。
> 注：`user_data/*.json` 由运行时写入；本地可能还有 `EzFlex-PreviewAny.json` 等，属运行期生成，非插件自带文件。

---

## 2. 各节点当前行为

### EzFlex-ModelsCombo（模型组合加载器，经典 API）
- 输入 `config`（隐藏 STRING），输出 `MODEL/CLIP/VAE 1..N`（`RETURN_TYPES` 运行期/前端同步为 `*`，编辑时类型化）。
- 面板：添加加载器 + 每行类型/名称/文件/额外参数（device/weight_dtype/clip type/LoRA 强度/目标）。
- 预设下拉「选中即生效」（`加载` 按钮已删除），选到占位则清空内部。
- 换预设不断连：`updatePorts` 复用输出 socket，先按名称、名称变但「类型+位置」没变则按位置+类型复用，只改名不断连。
- 「⧉ 浏览」弹窗：读取 LoraManager 生成的 `<模型名>.metadata.json` + 同目录预览图（`/models_combo/lora_meta` 列表、`/models_combo/lora_meta_detail` 详情、预览复用 `/models_combo/preview`）；支持 checkpoint/unet/lora；顶部标签 + 文件夹树（树/列表切换、递归、全部折叠、隐藏侧栏）；卡片类型+架构徽章、右上角「+/-」、底部毛玻璃信息条；点卡片弹详情；头部搜索 + 搜索范围下拉（标题/作者/类别/基础模型/标签/触发词/描述/版本/文件名·路径/全部）。
- 实例 API：`node._ezComboAPI = { presetNames(), current(), setCurrent(name), refresh() }`。

### EzFlex-FreeLatent（分辨率/Latent 选择器，V3 io.ComfyNode）
- 输入 `config`（隐藏）+ `width/height/batch_size`（INT 可连接，>0 覆盖）；输出 `Latent/Width/Height/Batch`。
- 内嵌 canvas：拖拽画布选尺寸（Shift 保持比例、Ctrl 取消吸附）、最大边、批次、算法（优/标）、MP、比例下拉、宽高预设、自定义比例。
- **强（force，V1.03）**：顶部工具条「批次」后按钮，仅任一 `width/height/batch_size` 有输入时可切换；绿色=强制生效 → 忽略外部宽高/批次、用面板值，并解除所有被禁控件；输入全断开自动回落。点击**先 syncToConfig 再 loadFromConfig**（否则 loadFromConfig 读旧 config 把 force 覆盖回 false）。
- **对齐（V1.03）**：后端严格按面板 `align` 值对齐（任意值，`.5` 向上取整，与前端 JS `Math.round` 一致）；若对齐后宽高**不是 8 的倍数**，`execute` 抛清晰报错提示“请把对齐调成 8 的倍数或调整宽高”（latent = 像素/8）。
- 宽高预设 `/freelatent/presets` 下拉「选中即生效」；比例预设（`customRatios`）在预设行尾。
- 实例 API：`node._ezLatentAPI = { presetNames(), current(), setCurrent(name), refresh() }`（`presetNames` 用 `seedPresets` 规范化，默认置顶）。

### EzFlex-NodeSwitchGroup（分组预设，经典 API，纯前端）
- config：`{ filters:{mode:'title'|'color', match, showAllGraphs, sort}, states:{分组标题:mode}, presets:{名称:{label,states}}, current }`。
- rgthree 式自动发现：扫描画布分组（Ctrl+G）；上行=预设（全部开启 + 保存/删除），下行=匹配方式/匹配值/排序/`子`(子工作流生效)。
- 颜色模式色点 + 原生取色圆盘 + 保存/删除颜色预设（localStorage）。
- 命名预设**按实例存 config**（`presets` 键），多 Group 互不影响。
- 多 Group 同屏修复：分组发现定时器**按节点放**（`node._ezScanTimer`），不能共用模块级 `_scanTimer`，否则互相 `clearTimeout` → 分组/预设串线；节点删除清定时器。
- 同名分组状态键：用 `groupKey(st,g) = title + '##' + idx`（同名分组的出现序号），并保留旧 `title`-key 兜底。
- 实例 API：`node._ezGroupAPI = { presetNames(), states(), current(), setCurrent(name), refresh() }`。

### EzFlex-NodeSwitchMaster（节点控制总预设，经典 API）
- 行 = 画布上的 NodeSwitchGroup 实例（`nodesOfType(GROUP)`）；每行一个下拉选该分组的预设。
- 总预设 = `{nodeId: 分组预设名}`；命名总预设存 `/nodeswitch_master/presets`。
- 行下拉「点开即刷新」（mousedown→fill）+ 700ms 轮询。
- 实例 API：`node._ezMasterAPI = { presetNames(), current(), setCurrent(name), refresh() }`。

### EzFlex-MainControl（总控制节点，经典 API）
- 被控目标：`EzFlex-ModelsCombo`、`EzFlex-FreeLatent`、`EzFlex-NodeSwitchMaster`、`EzFlex-ParamPresetControl`。
- 总预设 = `{nodeId:{type,preset}}`；存 `/main_control/presets`；左上角预设只保留 `default` + 服务器预设（无基础项）。
- 加载单个/全部：`SCAFFOLD_TYPES=[Combo,Latent,Master,Group,ParamCtrl,ParamOut]`；加载全部按创建成功顺序紧凑 2 列排布。
- 卡片下拉带占位、点开即刷新、700ms 轮询 `syncCards` 就地更新；卡片拖拽排序（克隆影子 + 插入线 + pointer 捕获），落盘 `config.cardOrder`。
- 实例 API：`node._ezMainAPI = { presetNames(), current(), setCurrent(name), refresh() }`。

### EzFlex-ParamPresetControl（参数预设控制，经典 API，动态输出）
- config：`{ groups:[{id,name,params:[{id,name,type,value,enabled}]}], current }`；命名预设存 `/param_preset_control/presets`（`default` 是真预设，首启自动补空）。
- 面板：预设下拉/保存/删除/重置/新增参数组；参数组列表与参数**拖拽排序（插入线）**；编辑弹窗（参数增删、名/类型/自动增高 textarea 值输入）。
- 值类型校验：int/float/bool 严格；复杂类型（complex/tuple/list/set/dictionary）不飘红（后端按 STRING 原样输出，不解析 Python 字面量）。
- 动态输出端口 = 参数组数 1:1（`EZFLEX_PARAM_GROUP`）；`updatePorts` 复用 socket（`_ezGroupId`）、重排、更新 `o.links`(∪`o.link`) `origin_slot`、POST `/param_preset_control/outputs` 同步类属性。
- **换预设不断连**：复用顺序 = ①按 `_ezGroupId` 精确 → ②按位置复用第一个未用旧 socket（保留 Control→Output 连线）→ ③新建；复用后覆盖 `_ezGroupId` 并 `notifyOutputs`。刷新/重启用 `linkObjMissing`/`deferUnresolved` 守卫。
- 删除参数组用自绘 `uiConfirm`。

### EzFlex-ParamPresetOutput（参数预设输出，经典 API，动态输出）
- 输入 `group`（EZFLEX_PARAM_GROUP）；输出 = 参数数 1:1，按类型映射（int→INT/float→FLOAT/string→STRING/bool→BOOLEAN/complex…→STRING）。
- 禁用参数：端口保留、输出中性默认值（int→0、float→0.0、bool→False、其余→""），保留接线重开启无需重连。
- 面板：参数名/类型/值 + 开启/禁用；值 >12 字符缩略显示，点击弹只读文本框预览；禁用行半透明。
- 端口只露圆点；`updatePorts` 复用 socket（`_ezParamId`）、重排、更新 origin_slot、POST `/param_preset_output/outputs` 同步类属性。

### EzFlex-PreviewAny（任意预览，经典 API，动态 socket）
- 输入 `input_1..N`(ANY)，输出 = 卡片 1:1（STRING）；`OUTPUT_NODE=True`；卡片顺序 = 画布输入顺序。
- 类型推断 `_infer_type`：tensor→IMAGE/MASK/TENSOR；dict→LATENT/CONDITIONING/AUDIO/DICT；list→VIDEO/LIST/CONDITIONING；str→LIST/TUPLE/DICT/SET/STRING；bool/int/float。
  对象按 `type(value).__module__` + `type(value).__name__` 判定（ModelPatcher→MODEL，comfy.sd CLIP/VAE，VideoFrom→VIDEO，File3D→MODEL_3D）。**教训**：`hasattr(...,'cached_patcher_init')/`patcher` 在值时经 ANY 代理后可能探测不到，模块判定更稳。
- 输出 `preview()` 透传已连接输入的原值（`RETURN_TYPES="*"`，可插在工作流中间）。
- `RETURN_TYPES/TYPES` 动态（按实际连接数），前端 POST `/preview_any/outputs` 同步；链路未恢复前不重排/删槽（`deferSync` 守卫），恢复后重排并回写 `origin_slot/target_slot`。
- 预览类型与格式见 README「保存类型」表（IMAGE/MASK/AUDIO/VIDEO/CONDITIONING/LIST·TUPLE·SET/DICT/STRING/LATENT/MODEL_3D/MODEL/CLIP/VAE/各类控制模型/EMPTY）。媒体全屏（图片滚轮缩放/拖拽、视频/音频播放、3D three.js 查看器）、生成信息、模型元数据卡、保存导出、数据预览弹窗。
- 模型元数据：`_model_meta` 恒返回 JSON（至少含类型），读 safetensors/gguf/onnx 的 architecture/author/title/tags/`ss_tag_frequency`；`_model_file_path` 从上游加载节点 widget 兜底（LoraLoader 的 `lora_name` 等）解析路径；`_looks_like_file` 放宽。

### EzFlex-PromptHelper（提示词助手，V1.03 开发中）
- 输入：`config`(隐藏) + 固定 `clip`/`image`/`video`/`audio`/`model_3d`（后四者可批量）+ 动态 `card_in_1..N`(STRING，= 卡片数 1:1，按顺序链接到卡片)。
- 输出：固定「合并提示词」STRING（按卡片顺序 `\n` 拼接）+ 动态卡片输出 `卡片 1..N`(STRING)。
- 前端 `web/prompt_helper.js`：完整富文本编辑器面板（卡片增删/拖拽排序 + 编辑弹窗 默认/优化 tab、格式工具条、颜色/字号/缩进、工具 全半角转换/优化占位、插入媒体引用、查找替换、取色器、规则弹窗）。
- 动态端口复用 ModelsCombo/ParamPreset/PreviewAny 经验：按 `_ezCardId` 复用、重排、回写 `origin_slot/target_slot`、`deferSync` 守卫；卡片数变化 POST `/prompt_helper/outputs` 同步类 `RETURN_TYPES/RETURN_NAMES`。
- 已知限制：类 `RETURN_TYPES` 全局共享；富文本用 `document.execCommand`（已弃用但可用）；「优化提示词 (API)」为占位；媒体输入仅计数/引用提示，不参与合并文本。

---

## 3. 存储与路由

- 命名预设统一走 `_register_preset_routes(node_name, api_path)`（GET 列表 / POST 保存同名覆盖 / DELETE {name}；服务器 `user_data/<节点名>.json`，`utf-8-sig` 读）。路由：
  - `/models_combo/presets`（ModelsCombo）、`/freelatent/presets`（FreeLatent，with_ratios）
  - `/nodeswitch_master/presets`、`/nodeswitch_group/presets`、`/main_control/presets`、`/param_preset_control/presets`
- 动态输出同步路由（前端 POST）：`/param_preset_control/outputs`、`/param_preset_output/outputs`、`/preview_any/outputs`、`/prompt_helper/outputs`。
- PreviewAny 媒体/3D 路由：`GET /preview_any/serve_video`、`GET /preview_any/serve_3d`（按 `?path=` serve 本地文件带 Range）、`GET /preview_any/3d/{path:.*}`（serve 插件 web 树，供 three.js 本地资源）、`GET /preview_any/fs/{path:.*}`、`POST /preview_any/folders`、`POST /preview_any/open`、`POST /preview_any/pick_folder`（tkinter）。
- 节点当前状态存各自 config widget（随工作流序列化）。
- web 静态：`_serve_no_store` 覆盖全部 JS，前端刷新即生效；Python 改类需重启 ComfyUI。

---

## 4. 关键技术 / 经验（避坑）

1. **动态输出用「类 RETURN_TYPES」而非画布 socket 类型**（execution.py 校验）。前端 POST 同步顺序。⚠️ 类属性全局共享：多个同类型节点由最后 POST 者决定（已知限制）。
2. **输出连接存 `o.links`（数组）/旧 `o.link`（单值）**；重排 socket 后必须遍历更新 `origin_slot`/`target_slot`。
3. **动态端口按「逻辑 id」复用 socket**（`_ezGroupId`/`_ezParamId`/`_ezCardId`），防重名；顺序 = want 数组顺序。
4. **链路恢复守卫**：`linkObjMissing`/`deferSync`（未恢复前不重排/删槽，否则 `origin_slot/target_slot` 对应 socket 不存在 → link 被丢）。
5. `window.prompt` 在 ComfyUI 不可靠 → 自绘 `uiPrompt`；确认用自绘 `uiConfirm`。
6. DOM 拖拽用 **Pointer Events + window 捕获**（克隆影子 + 插入线 + 占位线）。
7. 面板内层根 `position:absolute; inset:0 14px 14px 14px` 露 socket 圆点；外壳透明；`installResizeHandles` 只保留竖向(下缘左)+斜向(右下角)，横向已删（挡输出 socket 拖线）。
8. **config 输入口灰点**：`hideConfigWidget` 把名字为 `config` 的输入口**从 `node.inputs` splice 掉**（`i.hidden=true` 不生效）；config widget 值在 `node.widgets`。
9. **Vue / 普通模式双兼容**：
   - `addDOMWidget.canvasOnly` 是**二选一**，用 `canvasOnly: !window.__ezflexIsVueNodes()`；`__ezflexIsVueNodes()` 读 `Comfy.VueNodes.Enabled`。
   - 面板穿透需**常驻 CSS（`!important` + `:has()`）**（`injectSocketPanelBaseCSS`）：`.dom-widget.size-full:has(.ezfx-panel-shell)`、`.lg-slot [slot-data]` 抬 z-index + `::after` 放大命中盒、`.lg-node-widgets:has(.ezfx-is-vue)`、`.ezfx-is-vue [class*="-root"]` button/select/input 回 `pointer-events:auto`、隐藏四角缩放图标（`opacity:0` 留热区）。
   - Vue 面板偏移：`--ezfx-vue-title`（默认 30px）、`--ezfx-vue-side`（默认 10px）；shell 用 `top + height:calc(100% - top)` + `bottom:auto`（勿设 `min-height:0`）。
10. **3D 本地 three.js**：ComfyUI 内置 `vendor-three-*.js` 非独立（import 内部模块），故把自包含 `three@0.160.0` + GLTF/OBJ/FBXLoader + BufferGeometryUtils + fflate + NURBSCurve 放 `web/libs`、`web/utils`、`web/curves`；`FBXLoader` 依赖 `web/curves/NURBSUtils.js`（已补）。serve 用 `/preview_any/3d/{path}`（ComfyUI 默认不递归 expose `web/` 子目录）。加载器按 URL 扩展名挑；未知格式为空时看状态栏文本定位。
11. **PreviewAny 生成信息读取链** `_file_gen_meta(path)`：①PIL 内嵌文本块（PNG/WEBP/JPEG/动画 webp）→ ②同名 sidecar（`<base>.json`/`<base>.metadata.json`/`<file>.json`/`<base>.txt`）→ ③容器内嵌（GLB/glTF/视频用 ffprobe 回落 mutagen/音频用 mutagen 标签）。`_workflow_gen_meta` 从 `extra_pnginfo['workflow']` 兜底提取模型/LoRA/CLIP/VAE+提示词+采样参数；若上游是 `Load*/FromFile` 则不冒充外部文件参数（防误导守卫）。
12. **模型标签工具提示**：前后端都有 `ss_*`/`modelspec.*` 的中文悬停 tooltip（来源/作者/哈希/训练词比重/分桶等）。

---

## 5. 依赖

- 必装：`numpy`、`torch`、`Pillow`（ComfyUI 自带）。
- 必需/增强：`mutagen>=1.46.0`（音频/视频标签读取）；`safetensors`/`gguf`/`onnx`（模型元数据）、`av`（音频/视频编码/3D 解码）。
- `ffprobe` 外部可选（`shutil.which` 探测），不装则只走 sidecar JSON 兜底。
- 对应的 `requirements.txt`：`torch / numpy / Pillow / safetensors / gguf / onnx / av / mutagen>=1.46.0`。

---

## 6. 本地验证命令

```powershell
# Python 语法
python -c "import ast; ast.parse(open(r'<插件目录>\__init__.py',encoding='utf-8').read()); print('PY OK')"
# JS 语法（避免中文管道乱码）
Copy-Item <插件目录>\web\ezflex_service.js $env:TEMP\c.mjs ; node --check $env:TEMP\c.mjs ; Remove-Item $env:TEMP\c.mjs -Force
# venv 导入/实例化（Python 侧校验）
& "<ComfyUI>\.venv\Scripts\python.exe" <脚本>
# 前端：重启 ComfyUI + Ctrl+F5 强刷（JS no-store）
```

---

## 7. 已知注意 / 待办

- [ ] 类 `RETURN_TYPES` 全局共享（多实例由最后 POST 者决定）。
- [ ] Vue（Nodes 2.0）下 `EzFlex-ModelsCombo` 与 `EzFlex-FreeLatent` 白色面板底部略凸（可接受，不回退白框）。
- [ ] `web/modelscombo.js` 侧边栏入口、`web/modelscombo.html`、`web/FreeLatent.HTML`、`freeswitch_node.js`、所有 `.bak_*` 均已删；`_serve_no_store` 已同步移除对应条目。
- [ ] 图生图 / 视频生视频 后续单独拆节点，不再塞进 FreeLatent；图像缩放（按比例/按像素/按固定宽高）、VAE 编码、获取图像尺寸 由内置节点承担或后续做 EzFlex 单功能节点。
- [ ] `EzFlex-PromptHelper` 开发中：类 `RETURN_TYPES` 全局共享；`document.execCommand` 富文本（弃用但可用）；「优化提示词 (API)」占位待后端接入；媒体输入目前仅计数/引用提示。
- [ ] 临时预览文件（`ezpv_*`）会积累，建议自动清理。
- [ ] Python 改动（新节点/路由/类）需完整重启 ComfyUI；前端 JS no-store，刷新页面即生效。
