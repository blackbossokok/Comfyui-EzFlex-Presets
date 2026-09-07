# EzFlex 插件套件 项目交接文档（V1.04 稳定版）

> 供新窗口继续开发使用。硬数据，无闲聊。
> 当前版本：`__version__="1.0.4"`、`pyproject.toml version="1.0.4"`（README 记为 `V1.04`）。
> 环境：ComfyUI `0.30.x`；前端 `comfyui_frontend_package`（Vue / Node 2.0，addDOMWidget）。
> venv python：`<ComfyUI>\.venv\Scripts\python.exe`。
> 插件目录：`D:\software\AI_software\Comfy-Desktop\ComfyUI-Installs\Comfyui0.30.1\ComfyUI\custom_nodes\Comfyui-EzFlex-Presets`

---

## 0. 当前状态（11 节点定版）

节点（类别均 `EzFlex`，Add-Node 菜单顺序）：
`EzFlex-MainControl → EzFlex-ModelsCombo → EzFlex-FreeLatent → EzFlex-NodeSwitchMaster → EzFlex-NodeSwitchGroup → EzFlex-ParamPresetControl → EzFlex-ParamPresetOutput → EzFlex-PreviewAny → EzFlex-PromptHelper → EzFlex-MediaLoader → EzFlex-MediaOut`

- 版本：`__version__="1.0.4"`、`pyproject version="1.0.4"`、README `V1.04`。
- 控制链：`MainControl → Master → Group → node.mode(0/2/4)`；`ParamPresetControl →(连线)→ ParamPresetOutput`；`MediaLoader →(连线)→ MediaOut`。
- 控制类节点（MainControl/Master/Group）为**纯前端生效**（rgthree 同款：Python 只承载 config，`run` 返回 `()`，mode 由浏览器端改、随工作流序列化）。
- `EzFlex-PromptHelper` 为**开发中**节点（V1.03 起列入清单，继续完善）；**当前阶段：`MediaLoader/MediaOut`（V1.04）基本完成，进入 `EzFlex-PromptHelper` 交互/多模态优化**。
- `EzFlex-MediaLoader` / `EzFlex-MediaOut` 为 **V1.04 新增**：素材组织/拆分，详见各节点小节。

---

## 1. 目录结构

```
Comfyui-EzFlex-Presets/
├── __init__.py              # 11 节点类 + 预设路由 + 输出类型同步路由 + PromptHelper。__version__="1.0.4"
├── pyproject.toml           # version="1.0.4"，dependencies=["mutagen>=1.46.0"]
├── README.md                # 使用说明（V1.04）
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
    ├── media_loader.js          # MediaLoader 素材加载器面板 + 动态端口
    ├── media_out.js             # MediaOut 素材输出面板 + 动态端口
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

### EzFlex-PromptHelper（提示词助手，V1.03 起开发；V1.04 优化中）
- 输入：`config`(隐藏) + 固定 `clip`(CLIP) + 动态「综合媒体」端口（红色 ANY，可接 图像/视频/音频/3D 模型 等任意媒体，连接后自动补一个空槽）+ 动态 `card_in_1..N`(STRING，= 卡片数 1:1，按顺序链接到卡片；某卡输入口被连接后对应卡片变灰)。
- 输出：固定「合并提示词」STRING（按卡片顺序 `\n` 拼接）+ 动态卡片输出 `卡片 1..N`(STRING)。
- 端口标签：输入输出端口用**节点外黑框标签**叠加层（仿 ModelsCombo `installOutsideLabels`：DOM 覆盖层逐帧对齐 socket 圆点、随画布缩放、**半透明 50%**；标题输入即实时刷新标签文字；media `*` 圆点红、CLIP 黄、STRING 灰）。`hideConfigWidget` 隐藏 config 输入口。
- 前端 `web/prompt_helper.js`：完整富文本编辑器面板（卡片增删/拖拽排序 + 编辑弹窗 默认/优化 tab（**白色简约分段滑块、丝滑切换**）、**Word/Office 风格图标工具条**（B/I/U/S + 左/中/右/两端对齐 SVG）、颜色/字号/**缩进（首行缩进 text-indent，对每段首行生效）**、工具 全半角转换（**仅标点**）/优化、插入媒体引用、查找替换、取色器、规则弹窗；时间轴开始/结束无 placeholder 留空；**卡片标题为白底圆角可编辑块、未聚焦灰色、聚焦白底无高亮边框、空时显示灰色“标题”**；**只在单点卡片(无拖动位移)才打开编辑弹窗**；点击卡片弹窗外空白自动关闭并保存（卡片内拖动到外面松开不关）；取色器等颜色弹窗点击外面自动关闭但不关卡片弹窗。面板头部按钮序：**整体编辑(黑) / 调用设置 / 规则设置 / skill设置 / ＋新增提示词卡片(灰)**。**调用设置**弹窗按**侧边栏**切分：**[通用设置 / API设置 / TextGenerate设置 / llama设置]**，较窄(520px)、**一行一列**、输入左对齐、**数字无上下箭头**；通用设置有**三个滑块开关**（运行期自动优化 TextGenerate / API / llama），分别驱动 run 期三种自动优化。**skill 设成弹窗 `skill设置`**：仿 ModelsCombo 浏览，左侧文件夹树可展开、选中即写入 `optimize.skill`（列出 `SKILL.cn.md` 与 `SKILL.md` 分别以“· 中文/· 英文”显示，不再默认预览 cn）。**「整体编辑」Word 大纲**：每条卡片= 左侧浅矮小标题行[序号 / 可编辑标题 / 时间轴(两个可输入框) / 删除「－」] + 下方内容；顶部 skill 提示 + 默认/优化滑块 + 工具栏（B/I/U/S+对齐+字号+缩进+颜色/高亮+新增卡片）；块内标题/时间轴灰色、无高亮，每卡正文 min-height≈3行；点外面空白自动保存关闭。
- 缩进：**首行缩进**（text-indent，对每个回车产生的段落生效，`<br>` 软换行不缩进）；`card.indent` 持久化，打开编辑弹窗回填并重新施加；无段落/换行模式下拉框。
- 优化：工具下拉「优化提示词 (API) / (TextGenerate) / (llama)」；`POST /prompt_helper/optimize` 按 method 分发（核心 `_ph_optimize_impl` 同步可复用）。**媒体参与优化**：执行期会把已连接的「综合媒体」传给优化——本地 CLIP(textgen) 把 image/video/audio 随 prompt 一起喂给 `clip.tokenize`（同内置 TextGenerate）；「调用设置」①新增「运行期自动优化」选择（不 / API / llama），选 api/llama 且连了图像时，run 期把首张图编码成 base64 data URL 传给视觉接口（API 走 OpenAI 兼容 image_url / Anthropic image block；llama 进程内需 vision GGUF+mmproj 才读图）。`textgen` 仅运行期可用（`run` 时若 `optimize.textgen.enabled=true` 且 clip `generate` 可用则自动生成优化提示词，带 skill+媒体）。**clip 生成说明**：仅对 text-gen 编码器（Gemma/Qwen3-VL/flux2 等有 `generate`）生效；普通 `stable_diffusion` CLIP 无 `generate`，已启用时会抛清晰错误（不再静默失效）。**说明**：远程 API/llama 需用户填主机/密钥或 GGUF 模型路径并联网/本机推理；本地 CLIP 生成仅在执行期可用。**优化结果写入卡片「优化提示词」页签**，卡片编辑页脚有「默认/优化提示词」下拉切换合并输出用哪个（`card.useOptimized`）。
- 动态端口复用 ModelsCombo/ParamPreset/PreviewAny 经验：按 `_ezCardId`/`_ezMedia` 复用、重排、回写 `origin_slot/target_slot`、`deferSync` 守卫；卡片数变化 POST `/prompt_helper/outputs` 同步类 `RETURN_TYPES/RETURN_NAMES`；media `*` 端口顺序 = 已连接媒体数 + 1（自动补空槽）。
- 已知限制：类 `RETURN_TYPES` 全局共享；富文本用 `document.execCommand`（弃用但可用）；「优化提示词 (API)/(llama)」需用户提供主机/密钥/服务并联网；OAuth 登录未实现（OAI/Claude 用密钥+主机模式）；textgen 仅运行期可用（且需 text-gen CLIP，普通 CLIP 会报清晰错误）；综合媒体仅计数/引用提示，不参与合并文本；厂商/模型列表为参照 Chatbox 的建议项（可编辑，可能随厂商变动）。

### EzFlex-MediaLoader（素材加载器，V1.04，基本完成）
- 输入：`config`(隐藏 STRING，承载分组/卡片/文件)。输出：每张「素材卡片」一个 `*` 通配端口（深红），标签=`分组名_卡片名`，带半透明黑框标签叠加层（仿 ModelsCombo `installOutsideLabels`）；节点删除时清理标签。
- config 数据模型：`{ groups:[{id,name,cards:[{id,name,items:[{id,files:[{id,name,path,subfolder,dir,type}]}]}]}], currentGroupId, currentPreset }`；卡片内 `items` 是媒体网格项，每项可含 1..N 个文件（批量堆叠，右下 `+N`）。
- 运行期：`load()` 按「分组顺序→卡片顺序」加载（图像→张量、视频→帧列表、音频→`{waveform,sample_rate}`、3D→描述 dict、**文本类→文件内容字符串**），输出 `{_kind:"ezflex_media_card", cardId,label,files:[{id,name,type,value,path}]}`；文本由 `_ml_load_media` 对 `_TEXT_EXTS` 读取内容（≤1MB，utf-8 容错），非文本 `other` 输出路径。
- 浏览（文件资源管理器式）：`GET /media_loader/browse?path=`（默认 input 目录，返回 dirs/files/roots/parent；文件 `url=""` + `/media_loader/serve?path=` 出内容）；`_ml_roots()` 含 Windows 盘符 + `D:\storge\EdgeDownload`；前端回退 `/media_loader/files`。顶栏 `素材浏览`+后退/前进/上级/刷新+**手动路径输入 `.eml-path`（默认空，回车跳转）**+搜索；**红色 ✕ 在右上角**（toolbar `position:relative` + `.eml-bbclose{position:absolute;top:8px;right:14px}`）；左侧**可展开目录树**（点整行展开一层/收起、当前文件夹高亮、右侧显示其文件不含子目录）；右侧视图 列表/大/小/详细 + 全选/反选/清除 + 已选 + 右下「添加到素材卡片」；ctrl/shift 多选、拖上传。`storeRoots` 不再填下拉（输入框保持空）。
- 面板参数：`gridCols`（每行卡片数，默认 3）+ `gridRowH`（**卡片高度倍数**，默认 1；`pv.height = max(1,gridRowH)*96px`，`gridRowH<=0` 走 16:9 aspect）。顶栏「**加载输出**」按钮：`window.LiteGraph.createNode('EzFlex-MediaOut')` + `app.graph.add` + `n.pos=[node.pos[0]+node.size[0]+60,node.pos[1]]` + `node.connect(0,n,0)`（失败 toast）。
- 预设 `/media_loader/presets`；`POST /media_loader/outputs` 同步类 `RETURN_TYPES/RETURN_NAMES`；`default` 始终可选项；新分组/卡片组自动命名 `分组1/卡片组1…`。
- 前端 `web/media_loader.js`：自定义圆角预设下拉（PromptHelper 风格）；视频卡片悬停居中播放键（播放显示原生控件、隐藏信息面板、暂停恢复）；音频自绘白色播放条（进度可点、音量滑条+静音）；3D three.js 查看器（材质/线框/背景/复位/生成预览图/全屏 + 首次自动拍不重拍）；文本预览显示内容；顶栏「加载输出」按钮用 `LiteGraph.createNode('EzFlex-MediaOut')` 自动加一个 MediaOut 并尝试连第一个卡片端口。

### EzFlex-MediaOut（素材输出，V1.04）
- 输入：`card`（`*` 通配，深红，来自 MediaLoader 某张卡片）+ `config`(隐藏)。输出按模式：`split`=逐文件独立端口；`card`/`row`/`group`=按结构合并（每端口类型按真实媒体类型 `IMAGE/VIDEO/AUDIO/MODEL_3D`）。
- config：`{off:[文件id]}` 局部禁用（保留端口、输出 `None`）。
- 前端 `web/media_out.js`：4 模式切换（拆分/卡片/卡片组/分组）；每行**类型图标**（TYPE_ICONS 共享）+ 名称/类型 + 开/关；**翻页**底部一栏（左页码列表 `< 1 … >`，右固定宽 `第[ ]页` `[10]个/页`，失焦生效，默认 10/页）；`_mout_mode` 返回模式、`_mo_groupings` 分组；节点删除清标签。
- **PromptHelper @ 兼容**：`graphMediaFiles` 识别 `EzFlex-MediaLoader` / `EzFlex-MediaOut` 节点，素材文件纳入 `@` 媒体下拉。

---

## 3. 存储与路由

- 命名预设统一走 `_register_preset_routes(node_name, api_path)`（GET 列表 / POST 保存同名覆盖 / DELETE {name}；服务器 `user_data/<节点名>.json`，`utf-8-sig` 读）。路由：
  - `/models_combo/presets`（ModelsCombo）、`/freelatent/presets`（FreeLatent，with_ratios）
  - `/nodeswitch_master/presets`、`/nodeswitch_group/presets`、`/main_control/presets`、`/param_preset_control/presets`
  - `/media_loader/presets`（MediaLoader）
- 动态输出同步路由（前端 POST）：`/param_preset_control/outputs`、`/param_preset_output/outputs`、`/preview_any/outputs`、`/prompt_helper/outputs`、`/media_loader/outputs`、`/media_out/outputs`。
- MediaLoader 文件浏览：`GET /media_loader/files`（input 目录媒体，含子目录/大小/时间/`/view` URL）。
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

### 4.1 V1.04 专项经验（MediaLoader / MediaOut / PromptHelper 交互，硬数据）

**MediaLoader 浏览（文件资源管理器式）**
- 前端一定要**函数名一致**：`const renderPane` 定义 / `drawPane()` 调用，曾因定义叫 `renderPane` 调用叫 `drawPane` 直接 `ReferenceError: drawPane is not defined` → 弹窗渲染中断空白。教训：重命名/改调用后 `node --check` + 实际打开弹窗验证。
- **后端路由未加载**时前端 fetch 会静默失败 → 空列表。`fetchBrowse` 必须**回退**：先 `/media_loader/browse`，失败或空就回退旧的 `/media_loader/files`（input 目录）。教训：前端对新路由做旧路由兜底，否则不重启 ComfyUI 就一片空白；前端 JS = `_serve_no_store`（Ctrl+F5 生效），后端路由改动需完全重启。
- 浏览默认打开 input 目录；`_ml_roots()` 返回盘符 + 常用目录快速入口（`D:\storge\EdgeDownload`）。文件 `url=""`，统一用 `/media_loader/serve?path=<abs>` 出内容（`_ml_resolve` 兼容绝对/相对）。
- 左树**点整行展开一层/再点收起**，不“进入”；右侧只显示**选中文件夹的文件（不含子目录）**（子目录已在左树展开）。目录树用 `treeCache/treeExpanded`（懒加载：点开才 fetch 子目录）。
- 顶部导航：后退/前进/上级/刷新 + 盘符 + 搜索；视图 列表/大/小/详细 置**右上/右列顶部**（用户多次调整位置，按“顶栏只留导航、视图/选择在文件面板上方一行、添加在右下”的最终版）。选中用 `refreshSel()`（切 class 不整列表重绘，避免闪烁）；大/小图标 tile 预览**固定高度 + object-fit:contain + overflow:hidden + gridAutoRows**（否则图片按原图尺寸把格子纵向撑成条）。

**MediaLoader 媒体卡 / 预览**
- 相机/预览：3D `autoShot` 只**首次未拍时**自动拍（`if (!_mlPreview[item.id]) setTimeout(autoShot,320)`），否则每次打开都重置到正面→重复拍。
- 视频卡片：自定义悬停**居中播放键**（`▶`），`playing` 态隐藏 `.info` 信息面板、隐藏播放键、显示原生控件（`video.controls=true`）；暂停恢复信息+播放键；播放中点卡片不弹大图。**播放键用 CSS 类定位**（上次写成 `el('button','eml-play')` 没给样式 → 跑到右边）。
- 音频：浏览器原生 `<audio>` 控件**无法完全刷白**（进度条是内部 `::-webkit-media-controls-timeline`/`::-webkit-slider-runnable-track`，vendor 伪元素不可靠）。**自绘 `makeAudioPlayer`**（白底圆角 + ▶/暂停、可点进度（`isFinite(audio.duration)` 守卫）、音量滑条+静音；`<audio>` 用**屏外隐藏** `position:absolute;left:-9999px` 而非 `display:none`，避免某些浏览器不加载/不播放）。教训：要对控件完全可控就得自绘，别死磕原生样式。
- 文本类（`.txt/.md/.json…`）：预览 fetch `/media_loader/serve` 内容显示在**等宽白底可滚动**卡片（`min-height:120px` + `pre-wrap` + 错误兜底），避免纯空白。
- 预览切素材**复用同类型媒体元素**（`_pvMedia/_pvType`，仅换 `src`）避免整块重建→闪屏；音频预览时 `main` 左右 `padding:44px` 给左右箭头让位。
- 删除节点：`onRemoved` 必须清理 `node._emlOutEls`/`_emooOutEls`（黑框标签 DOM 挂在 body，忘了清会残留）。

**MediaOut**
- 4 模式：`_mout_mode` 返回 `split/card/row/group`；`split` 用 `card['files']`，`card/row/group` 用 `card.get('_rows')`（MediaLoader `load()` 挂共享引用，**不做 tensor 复制**）。禁用文件（`off` config）保留端口、输出 `None`（重启用不断连）。
- 翻页：`node._moPage/_moPerPage`（默认 10）；**页栏要 append 到 `.emoo-root` 面板根**，`node._emooRoot` 是 `.emoo-shell`（外层壳）——append 到壳会被 `inset:0 14px` 面板裁掉看不到。底部一栏：左=页码列表 `< 1 … >`，右=固定宽 `第[ ]页 [10]个/页`（`justify-content:space-between`）。
- 数字输入框去上下箭头：`.emoo-root input[type=number]{-moz-appearance:textfield;appearance:textfield}` + `::-webkit-inner/outer-spin-button{none}`（MediaLoader 同理 `.eml-root`）。

**PromptHelper 多重弹窗一层层关闭（本轮踩坑）**
- 目标：点**最外层只关最上面一层**，点卡片弹窗/总体编辑内部不关；**拖动在外面松开不关**；点开关按钮（高亮/取色）**不闪关**。
- 方案：一个**分层协调器**（`_phLayers` 栈 + capture `pointerdown`/`pointerup`）。
  - **只关“按下前已打开”的层**：`pointerdown` 快照 `_phDownOpen=new Set(_phLayers)`；`pointerup` 里 `if (!_phDownOpen.has(el)) continue;`——否则点开关按钮（按钮在下拉外）会在同一击里把刚打开的下拉关掉（闪一下关闭）。
  - **拖动不关**：`pointerup` 时 `Math.max(|dx|,|dy|)>6` 直接 return。
  - **一次只关最上层**：从栈顶往下找第一个不包含 `target`（且 `target !== el`，即点在层内内容时保留）的层，关掉就 `break`。
  - 自动注册：`MutationObserver` 监听 `eph-*` 元素 class，出现 `.active/.open` 就 `phLayerPush`，去掉即出栈。
  - **删除旧“整批关闭”**：过去 `document.addEventListener('mousedown', ...)` 各自关自己的弹窗，导致点外面一下子全关；统一删掉，只留协调器。
  - **模态背板**：协调器记录本次关掉的层 `_phClosedEl`；各模态背板关闭（编辑器 `closeEditModal`、`@` 媒体查看器 `stop`、取色器 `closePicker`、规则窗口）改成 `if (target === modal && (_phClosedEl === null || _phClosedEl === modal)) close()`——只有“本次关的就是自己”才关，避免内层刚关外层又跟着关。
  - 编辑器背板：`_editModal` 的 `mouseup` 只有 `_phClosedEl===null||===_editModal` 才 `closeEditModal(true)`（内层弹窗打开时点背板先关内层，不动编辑器）。

**其它**
- “加载输出”按钮（MediaLoader 顶栏）：`window.LiteGraph.createNode('EzFlex-MediaOut')` 生成节点并 `app.graph.add`，`n.pos=[node.pos[0]+node.size[0]+60, node.pos[1]]`，尝试 `node.connect(0,n,0)` 连第一个卡片端口（失败 toast）。
- 共享前端工具放 `web/ezflex_service.js`：`TYPE_ICONS`（图片/视频/音频/3D/文本 SVG）、`makeAudioPlayer`、`decorateSelect/decorateSelectsIn`（**注意**：装饰器会隐藏原生 `<select>`，很多节点原有 `.value/.options/.change` 逻辑依赖原生元素，强行覆盖后“原界面看不见”——已回退这些节点到原生 select；仅媒体加载器预设下拉保留自绘）。
- 每个新的弹窗/下拉参考 `phFixedDD`/`phCenterPopup`（定位）、`uiPrompt`/`uiConfirm`（自绘弹窗）。

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
- [ ] `EzFlex-PromptHelper` **下一阶段优化**：类 `RETURN_TYPES` 全局共享；`document.execCommand` 富文本（弃用但可用）；「优化提示词 (API)/(llama)」需用户提供接口/密钥/llama-server 地址并联网调用（`/prompt_helper/optimize`），textgen 仅运行期可用；综合媒体端口目前仅计数/引用提示；媒体端口 `*` 类型连接校验依赖 ComfyUI 通配，Vue 模式下黑框标签叠加层可能需按 Vue 端口坐标再校准。
- [ ] 临时预览文件（`ezpv_*`）会积累，建议自动清理。
- [ ] Python 改动（新节点/路由/类）需完整重启 ComfyUI；前端 JS no-store，刷新页面即生效。
