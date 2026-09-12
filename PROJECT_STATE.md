# EzFlex 插件套件 · 项目交接文档

> 硬数据，无闲聊。原版逐轮改动流水账已压缩掉，只留**必要参数 / 踩过的坑 / 解法**。
> 本文件是唯一交接入口；改动前先看 §5「经验与避坑」，本轮要做什么看 §8.1「体验优化」。

## 0. 环境与生效方式（必要参数）

| 项 | 值 |
| --- | --- |
| 版本 | `__version__ = "1.11"`（`__init__.py` / `pyproject.toml`，README 记 V1.11） |
| ComfyUI | `0.30.x`；前端 `comfyui_frontend_package`（Vue / Nodes 2.0，`addDOMWidget`） |
| venv python | `<ComfyUI>\.venv\Scripts\python.exe` |
| 插件目录 | `D:\software\AI_software\Comfy-Desktop\ComfyUI-Installs\Comfyui0.30.1\ComfyUI\custom_nodes\Comfyui-EzFlex-Presets` |
| 规模 | `__init__.py` ≈ 6261 行；`web/prompt_helper.js` ≈ 4064 行 |
| **生效方式** | Python（节点类 / 路由）改动 → **完整重启 ComfyUI**；前端 JS（`_serve_no_store`）→ **页面强刷 Ctrl+F5** |
| 依赖 | 唯一必须额外装的：`mutagen>=1.46.0`（音频/视频标签与容器元数据）；**可选**：`llama-cpp-python`（提示词助手"进程内 llama"模式；本机 0.3.46 验证过，看图要带 mtmd 的较新构建）、`gguf` / `onnx`（只有读这些模型才用到，缺了跳过"模型元数据卡"不报错）、`ffprobe` 外部可选（`shutil.which` 探测，没有就只走 sidecar JSON）；其余 torch/numpy/Pillow/safetensors/av 由 ComfyUI 自带 —— 见 `requirements.txt` 的分组注释 |
| 前端版本横幅 | 改前端时一并改 `web/prompt_helper.js` 的 `PH_BUILD`（当前 `2026-09-12-dockv9`），控制台看 `[PromptHelper] 模块已加载 · build …` |

## 1. 节点清单（11 个，category 全 `EzFlex`）

Add-Node 顺序：
`MainControl → ModelsCombo → FreeLatent → NodeSwitchMaster → NodeSwitchGroup → ParamPresetControl → ParamPresetOutput → PreviewAny → PromptHelper → MediaLoader → MediaOut`

- `__init__.py` 的 `NODE_CLASS_MAPPINGS` 与 `web/ezflex_service.js` 的 `NODE_TYPES` 必须一致（增删/改名节点两处一起改）。
- 链路：`MainControl → Master → Group → node.mode(0/2/4)`；`ParamPresetControl →(连线)→ ParamPresetOutput`；`MediaLoader →(连线)→ MediaOut`；`PromptHelper` 旁挂。
- 控制类（MainControl / Master / Group）**纯前端生效**（rgthree 同款）：Python 只承载 config，`run()` 返回 `()`，mode 由浏览器端改并随工作流序列化。
- 各节点 `DESCRIPTION` = README 短中文名，改完**必须重启**才在节点菜单生效。
- `EzFlex-ReadIndex` 已整节点删除（媒体编号改为扫描画布实时推导）。

### 目录结构

```
Comfyui-EzFlex-Presets/
├── __init__.py            # 11 节点类 + 全部后端路由（6261 行），__version__="1.11"
├── pyproject.toml         # version="1.11"，dependencies=["mutagen>=1.46.0"]
├── README.md              # 使用说明（V1.11）
├── requirements.txt       # 分组写明：ComfyUI 自带（torch/numpy/Pillow/safetensors/av）｜额外必装 mutagen>=1.46.0｜可选 llama-cpp-python / gguf / onnx
├── .gitignore             # 忽略 __pycache__ / user_data（运行期预设）/ _backups / *.corrupt-backup / _dev_tests（整套回归） / 三份手写笔记 / release.ps1 / *.tgz
├── user_data/             # 命名预设库（运行期由预设路由写入，每节点一个 json）
├── _dev_tests/            # 本地回归套件（§7）；其 extensions/ / scripts/ / _tmp/ 均为跑测试时自动生成，可随时删（详见 §7）
└── web/
    ├── ezflex_service.js       # 共享：NODE_TYPES / 注册表 / 事件总线 / 分组匹配 / 预设库 API / 弹窗 / 缩放手柄 / 面板穿透 / TYPE_ICONS / makeAudioPlayer / EZ_PERF
    ├── ezflex_media_index.js   # 媒体编号引擎：扫描画布生成节点媒体端口 → 编号表（@图片N / <Picture N>）
    ├── main_control.js / node_switch_master.js / node_switch_group.js
    ├── param_preset_control.js / param_preset_output.js
    ├── modelscombo_node.js / freelatent_node.js
    ├── media_loader.js / media_out.js / preview_any.js
    ├── prompt_helper.js        # PromptHelper 面板（4064 行）
    └── libs/ utils/ curves/    # three.js 与 GLTF/OBJ/FBX 加载器、NURBS 曲线（本地离线，供 3D 查看器）
```

## 2. 各节点行为与关键参数

### EzFlex-ModelsCombo（模型组合加载器，经典 API）
- 输入 `config`（隐藏 STRING）；输出 `MODEL/CLIP/VAE 1..N`（`RETURN_TYPES` 运行期/前端同步为 `*`，编辑时类型化）。
- 面板：添加加载器 + 每行类型/名称/文件/额外参数（device / weight_dtype / clip type / LoRA 强度 / 目标）；预设下拉「选中即生效」。
- **换预设不断连**：`updatePorts` 复用输出 socket —— 先按名称匹配，名称变但「类型+位置」没变则按位置+类型复用，只改名不断连。
- 「⧉ 浏览」弹窗：读 LoraManager 的 `<模型名>.metadata.json` + 同目录预览图（`/models_combo/lora_meta`、`/models_combo/lora_meta_detail`、`/models_combo/preview`）；支持 checkpoint/unet/lora；文件夹树 + 卡片 + 详情 + 多范围搜索。
- 实例 API：`node._ezComboAPI = { presetNames(), current(), setCurrent(name), refresh() }`。

### EzFlex-FreeLatent（分辨率 / Latent 选择器，V3 io.ComfyNode）
- 输入 `config`（隐藏）+ `width/height/batch_size`（INT 可连接，>0 覆盖）；输出 `Latent/Width/Height/Batch`。
- 内嵌 canvas：拖拽选尺寸（Shift 保持比例、Ctrl 取消吸附）、最大边、批次、算法（优/标）、MP、比例下拉、宽高预设、自定义比例。
- **强（force）**：顶部「批次」后按钮，仅任一 `width/height/batch_size` 有输入时可切换；绿色 = 忽略外部宽高/批次用面板值并解除被禁控件，输入全断开自动回落。点击**先 `syncToConfig` 再 `loadFromConfig`**（否则旧 config 把 force 覆盖回 false）。
- **对齐**：后端严格按面板 `align` 值对齐（`.5` 向上取整，与前端 `Math.round` 一致）；对齐后宽高**不是 8 的倍数**时 `execute` 抛清晰报错（latent = 像素/8）。
- **面板全部状态随 config 持久化**（含 `align`/`limit`/`batch_size`/`algorithm`/`force`，工作流 JSON 的 `widgets_values_named.config` 里能直接看到）；刷新/重启后由 `updateInfo()` 把这些控件回填成持久化值（见 §5.8 的「控件回填」坑）。
- 宽高预设 `/freelatent/presets`（下拉选中即生效）；比例预设 `customRatios` 在预设行尾。实例 API：`node._ezLatentAPI`。

### EzFlex-NodeSwitchGroup（分组预设，经典 API，纯前端）
- config：`{ filters:{mode:'title'|'color', match, showAllGraphs, sort}, states:{分组标题:mode}, presets:{名称:{label,states}}, current }`。
- rgthree 式自动发现画布分组（Ctrl+G）；上行 = 预设（全部开启 + 保存/删除），下行 = 匹配方式/匹配值/排序/「子」（子工作流生效）。
- 颜色模式色点 + 原生取色圆盘 + 颜色预设（存 localStorage）。
- **多 Group 同屏**：分组发现定时器必须**按节点放**（`node._ezScanTimer`），共用模块级 `_scanTimer` 会互相 `clearTimeout` → 分组/预设串线；节点删除要清定时器。
- 同名分组状态键：`groupKey = title + '##' + idx`（出现序号），保留旧 `title`-key 兜底。实例 API：`node._ezGroupAPI`。

### EzFlex-NodeSwitchMaster（节点控制总预设，经典 API）
- 行 = 画布上的 NodeSwitchGroup 实例（`nodesOfType(GROUP)`），每行一个下拉选该分组的预设；总预设 = `{nodeId: 分组预设名}`，存 `/nodeswitch_master/presets`。
- 行下拉「点开即刷新」（mousedown → fill）。实例 API：`node._ezMasterAPI`。

### EzFlex-MainControl（总控制节点，经典 API）
- 被控 4 类（`TARGET_TYPES`）：ModelsCombo / FreeLatent / NodeSwitchMaster / ParamPresetControl。**NodeSwitchGroup 刻意不列**（它由「节点总控制」级联管理）。
- 总预设 = `{nodeId:{type,preset}}`，存 `/main_control/presets`；预设下拉只有 `default` + 服务器预设。
- 卡片下拉带占位、点开即刷新、就地 `syncCards` 更新，不重建 DOM；卡片拖拽排序落盘 `config.cardOrder`。
- **「加载全部」可加载清单 `SCAFFOLD_TYPES` = 9 类**（下拉 + 加载全部），新增 PromptHelper / MediaLoader / PreviewAny；**MediaOut 刻意不放**（MediaLoader 能承接它的输出）。下拉显示中文名（`SCAFFOLD_LABEL`）。
- **「加载全部」排布**（以总控制自身为基准，间距 `SCAFFOLD_GAP = 30`，尺寸取各节点实际 `node.size`）：
  - 左列（右缘对齐，右缘 = 总控制左缘 − 30）：素材加载器（**底边与总控制平齐**）→ 模型组合 → 提示词助手，依次下移 30px；
  - 中列（左缘 = 总控制左缘）：节点总控制、参数预设控制，自总控制底边 +30px 起依次下移 30px；
  - 右列（左缘 = 总控制右缘）：节点开关组、参数输出控制，同上；
  - 分辨率：总控制右侧 +30px、**底部平齐**；任意预览：参数输出控制右侧 +30px、**底部平齐**。
  - ⚠️ 排布按**视觉外框**算（`visualBox()` + `LiteGraph.NODE_TITLE_HEIGHT`），不是裸 `node.pos`/`node.size`：标题栏画在 `pos` 上方，直接用 pos 排会「贴在一起」（见 §5.8）。
  - ⚠️ 排布后 **350ms 再对一次齐**：各节点 DOM 面板高度要等下一帧 `fitNode` 才定型（总控制自身卡片列表变长也会改高），只排一次会错位。
- 实例 API：`node._ezMainAPI`。

### EzFlex-ParamPresetControl（参数预设控制，经典 API，动态输出）
- config：`{ groups:[{id,name,params:[{id,name,type,value,enabled}]}], current }`；命名预设 `/param_preset_control/presets`（`default` 是真预设，首启自动补空）。
- 面板：预设下拉/保存/删除/重置/新增参数组；参数组与参数**拖拽排序（插入线）**；编辑弹窗。
- 值类型校验：int/float/bool 严格；复杂类型（complex/tuple/list/set/dictionary）**不飘红**（后端按 STRING 原样输出，不解析 Python 字面量）。
- 动态输出端口 = 参数组数 1:1（`EZFLEX_PARAM_GROUP`）。**换预设不断连**，复用顺序 ① 按 `_ezGroupId` 精确 → ② 按位置复用第一个未用旧 socket（保住 Control→Output 连线）→ ③ 新建；复用后覆盖 `_ezGroupId` 并 `notifyOutputs`。删除参数组用自绘 `uiConfirm`。

### EzFlex-ParamPresetOutput（参数预设输出，经典 API，动态输出）
- 输入 `group`（`EZFLEX_PARAM_GROUP`）；输出 = 参数数 1:1，按类型映射（int→INT / float→FLOAT / string→STRING / bool→BOOLEAN / complex…→STRING）。
- **禁用参数**：端口保留、输出中性默认值（int→0、float→0.0、bool→False、其余→`""`），重开启无需重连。
- 面板：参数名/类型/值 + 开/关；值 >12 字符缩略显示，点击弹只读预览；禁用行半透明。`updatePorts` 复用 socket（`_ezParamId`）。

### EzFlex-PreviewAny（任意预览，经典 API，动态 socket）
- 输入 `input_1..N`(ANY)，输出 = 卡片 1:1（STRING）；`OUTPUT_NODE=True`；卡片顺序 = 画布输入顺序。
- **类型推断 `_infer_type`**：tensor→IMAGE/MASK/TENSOR；dict→LATENT/AUDIO/DICT；list→VIDEO/LIST/**CONDITIONING**（ComfyUI 的 conditioning = `[[cond_tensor, {…}], …]`，判的是**第二个元素是 dict** —— 曾误判成 `value[0][0]`，真 CONDITIONING 一律显示成 LIST）；str/bool/int/float；`File3D`→FILE_3D；`comfy_api…geometry_types` 的 **MESH / SPLAT / VOXEL**（Hunyuan3D / Trellis / MoGe / 高斯泼溅等），不认就会掉进裸 repr。**必须按 `type(value).__module__ + __name__` 判定** —— `hasattr(...,'cached_patcher_init')` / `patcher` 经 ANY 代理后可能探测不到。
- **每种类型都要有像样的卡片**（`_dev_tests/preview_types_test.py` 98 条钉住）：MESH → 顶点/面导成临时 OBJ 交 3D 查看器（>50 万顶点 / 100 万面只给摘要）；SPLAT / VOXEL → 文本摘要（点数 / SH 系数 / 体素形状）；其余对象类 → `_object_summary` 摘要，**任何已知类型都不许落到 `str(value)` 裸 repr**。
- 输出 `preview()` 透传已连接输入的原值（`RETURN_TYPES="*"`，可插在工作流中间）。
- **文件直通（性能硬要求，勿回退）**：值本来就是「来自文件的视频/音频」时**不重新编码** —— `_video_file_source(value)` 命中就 serve 原文件 + 单帧海报；AUDIO 走 `_audio_file_src`（兼容 dict/str/**list**）。确实需要转码才走 `_video_to_webm`（≤512px、`deadline=realtime,cpu-used=8,lag-in-frames=0`，实测 0.70s / 1 KB）。
  - **内存型视频对象（内置 Create Video 的 `VideoFromComponents`）也直通**：`_video_stream_temp()` 用对象自己的 `get_stream_source()`（`save_to` 会把音轨一起写进去）落成 `ezpv_vid_<内容sha1>.mp4` 交 `/preview_any/serve_video` 播 —— **音轨、原始帧率、时长都不丢**。⚠️ 别再改回「抓前 60 帧重编码成无音轨 webm」：音轨会丢、帧率只能猜、长视频直接被截断。
- **存档 `_maybe_save` 用 `entry["image_src"]` = 原图**（不是屏幕上的缩略/全屏图）；PNG 用 PIL 重存并写 `PngInfo` 的 `workflow`/`prompt`；目标扩展名与源相同时音频/视频直接复制。
- 生成信息链 `_file_gen_meta(path)`：① PIL 内嵌文本块 → ② 同名 sidecar（`<base>.json` / `<base>.metadata.json` / `<file>.json` / `<base>.txt`）→ ③ 容器内嵌（GLB/glTF/视频用 ffprobe，回落 mutagen）。`_workflow_gen_meta` 从 `extra_pnginfo['workflow']` 兜底提模型/LoRA/CLIP/VAE + 提示词 + 采样参数；上游是 `Load*/FromFile` 时不冒充外部文件参数。
- 路由：`/preview_any/serve_video`、`/serve_3d`、`/3d/{path:.*}`（serve 插件 web 树给 three.js）、`/fs/{path:.*}`、`/folders`、`/open`、`/pick_folder`。

### EzFlex-PromptHelper（提示词助手，**持续开发中**）

**端口与数据**
- 输入：`config`(隐藏 STRING) + 动态「综合媒体」`media_in_1..16`（`_PH_MAX_MEDIA=16`，ANY，可接图像/视频/音频/3D，连接后自动补空槽）+ 动态 `card_in_1..N`(STRING，= 卡片数 1:1；某卡输入口被连接后对应卡片面板置灰)。
- 输出：固定「合并提示词」STRING（按卡片顺序拼接，**分隔符 = 设置·规则设置的「卡片合并分隔符号」**，默认 `\n`，空卡片不占位）+ 动态 `卡片 1..N`(STRING)（`_PH_MAX_CARDS=32`）。
- **每张卡片输出口（`卡片 i`）的逻辑**（与合并提示词、总体编辑优化、运行期整体优化**都无关**，就是"这张卡自己的文本"）：
  ① 该卡 `card_in_i` 连了外部文本（非空）→ 用它（面板上该卡置灰）；② 否则该卡停在「优化」页签（`card.useOptimized`）→ 用该卡 `contentOptimized`（空则退回默认正文）；③ 否则用默认正文 `content`（没存就 `contentHTML` 转纯文本）。
  再按节点级规范 `_ph_compile_card` 编译：只换引用写法（`@图片N`→该规范的写法；留空/缺键 = 原样保留），编号与时间戳都不动，最后压缩连续空格 + `strip()`（没写 `rule` 的卡不 strip）。
  **「合」关掉的卡在 `卡片 i` 上照常输出**（只影响合并提示词）；空卡片输出空串（端口仍在，不省略）。端口数 = 卡片数 + 1（**只是画布上的 socket 数**）；**类 `RETURN_TYPES/RETURN_NAMES` 固定成「最大卡片数 + 1 = 33 个 STRING」，运行期不收缩**（见 §4.1）。
- **没有 CLIP 输入**：运行期 TextGenerate 用「设置·TextGenerate设置」里的 clip 路径 + 类型自加载（`_ph_clip_instance`）。
- 卡片数据（`parse_prompt_cards`）：`{id,title,content,contentHTML,contentOptimized,contentOptimizedHTML,timelineStart,timelineEnd,modelType,model,provider,apiUrl,indent,indentMode,useOptimized}`；前端另有 `card.refTarget`（绑定的生成节点）。
- 优化时**整体收集**媒体：所有张量当图像（批次保留）、带 waveform 的 dict 当音频、带 `get_stream_source` 的对象当视频。

**设置**（`openSettings`，侧边栏：通用 / 规则 / API / TextGenerate / llama / 路径；窄 520px）
- 通用设置：四个滑块开关 —— `optimize.autoTextgen` / `autoApi` / `autoLlama` / `clearCache`。**三个自动优化互斥**：前端 `mkSwitch` 开一个就自动关另外两个（`_AUTO_KEYS`）；后端 `run()` 发现同开多个**直接报错**（不保留任何优先级兜底）。**三个全关 = 一定不优化**（老配置里 `textgen.enabled` 那个看不见的遗留触发已删）。`clearCache` 独立。
- 规则设置：第一条 = **卡片合并分隔符号**（`rules.mergeSep`，`\n`/\t 转真控制符，空值回落换行）；下面 = 提示词规范表编辑器（下拉：新建自定义｜内置｜分隔线｜自定义 + 删除 + 命名 + 保存，字段 = 引用图片/视频/音频模板、时间规则、规则提示、负面提示词）。存节点 config `rules = { mergeSep, ruleId, lang, custom, overrides }`。
- 后端编译 `_ph_compile_card(text, card)`：**只做引用媒体替换**（把 `@图片N` 按该节点规范的 `ref` 模板换成目标写法；留空/缺键=原样保留）。**时间戳与镜头号不进自动输出**，只由「提示」气泡手动生成复制。
- API 设置：默认/自定义滑块；页底「调用参数」= 温度 / Top P / 最大 token / 种子 / 停止串 / 思考强度 / 联网搜索 / 自定义参数(JSON)，存 `optimize.apiParams`，留空 = 不发送该字段。后端 `_ph_apply_api_params()` 按厂商映射（OpenAI / Anthropic / OpenRouter / Qwen / xAI 各有专属字段；不支持的厂商开联网**明确报错**，不静默假装）。
- TextGenerate 设置：`tg.clip_path` + `tg.clip_type`，参数与官方 TextGenerate 节点一一对应。
- llama 设置：拆「LLM 文本编码模型 / mmproj 视觉编码模型」，分模型/加载/视觉/采样四段。加载期走 `_PH_LLAMA_LOAD_FIELDS` 白名单（避免 `Llama(**kwargs)` 静默吞键）；KV 量化经 `_PH_KV_TYPES` 映射；视觉期经 `_ph_llama_vision_kwargs` 以 `chat_handler_kwargs` 传给 mtmd；进程内按 `create_chat_completion` **真实签名过滤 kwargs**，多模态用 OpenAI content parts 而不是 `images=`。
- 路径设置：三个扫描目录 + 浏览（`POST /prompt_helper/pick_folder`），全局 `userdata/ezflex_scan_paths.json` 持久化，节点 config 另存快照；选中模型路径存 `userdata/ezflex_model_paths.json` 作兜底。
- 参数说明浮层：`data-tip` + `_TIP_DELAY = 2000`（停留 2 秒才弹，原生 `title` 不支持换行）；**只挂 TextGenerate / llama 参数**。
- **生效情况**：四个开关后端 `run()` 都读且都生效；`clearCache` 清的是 **PromptHelper 自己的 CLIP/llama 缓存**（逐个 `close()` → 清缓存 → `gc.collect()` → `soft_empty_cache()`），**不是** ComfyUI 主模型显存。llama `mode=local` 解析不到模型**直接报错**（不再静默回退服务器）。

**优化 / 媒体参与**
- **规范编译的阶段（别搞混）**：**输入原文、槽位存原文、输出才编译** —— 送给 API/TextGenerate/llama 的是未编译原文（带 `@图片1`），系统提示（`_PH_OPT_SYSTEM`，api / Anthropic / 进程内 llama 三处共用）要求模型原样保留标记；两个优化槽存模型原文，所以换规范还能重编；只有 `卡片 i` 端口和「合并提示词」在输出前过 `_ph_compile_card`（幂等）。顺带修了：Anthropic 分支原来算了 `system` 却没放进 body（Claude 一直收不到系统提示）。
- **优化分两层（2026-09-12 起）**：① **整体**（运行期自动优化 / 总体编辑「工具→优化提示词」）= **先合并再优化一次** —— 合并源 = 将要参与合并输出的卡片正文（顺序不变、非空、**「合」为灰的不进**，卡片级优化结果优先），结果放进「总体编辑·优化」那一块；② **分卡**只在卡片弹窗里由用户手动点工具优化，写回该卡 `contentOptimized*`。**别再改回逐卡片运行期优化**。
- 工具下拉「优化提示词 (API) / (TextGenerate) / (llama)」→ `POST /prompt_helper/optimize`，核心 `_ph_optimize_impl` 同步可复用。「点击即用」也会带图：卡片弹窗取该卡片引用目标的全部图片、总体编辑取整个节点的全部图片，上限 8 张（`_PH_MAX_VISION_IMAGES`）。
  - API/llama：图片 + 视频从头到尾**均匀抽帧**（`_ph_vision_tensors`，每视频 ≤8 帧，整体 ≤8 张 data URL）；音频不发。
  - textgen：图片批次 + 视频帧张量（`_ph_video_frames` 按 ~1fps 解码、最长边 512、≤48 帧，带 fps；Gemma4 才按视频处理）+ 首个音频；多图先 `_ph_concat_images` 合成批次。
  - `textgen` 仅运行期可用，且仅对 text-gen 编码器（Gemma / Qwen3-VL / flux2）生效，普通 `stable_diffusion` CLIP 无 `generate` → 抛清晰错误。
  - clip 的 `seed` 必须是整数（`None` 会让 `manual_seed` 报错），设置项统一走 `_ph_num` 容错。
- **优化 / 默认 / 卡片 / 总体编辑 的完整行为矩阵见 README「优化 / 默认 / 卡片 / 总体编辑：行为规则」**（工具优化一张表 + 运行期总体层/各卡两张表 + 三开关全关）。要点：① 每个槽位只由**自己那一层**的滑块决定（卡片滑块只管该卡端口，总编辑滑块只管合并口），**空就空、不回落**；② 合=绿卡运行期不单独优化、严格按滑块；合=灰卡不进合并、运行期按需**单独优化一次**（结果只进它自己的端口，并回传前端写回优化槽+切滑块）；③ 优化调用是"记忆式"的——槽里有内容就不重复调用，空才调用；④ 任何一次优化失败（API/llama/TextGen 报错）**直接抛 `ValueError`** 停止，不再静默输出空提示词。
- 运行期回显：`ui.optimized` → 前端 `applyExecutedOptimized` 写进「总体编辑·优化」并把 `overallUseOptimized` 置真（挂 `onExecuted`）。**自动优化开着时运行期结果会覆盖手动优化那份**（要保留手动结果就把三个开关全关，走优先级 ②）。
- 节点级状态：`overallOptimized` / `overallOptimizedHTML` / `overallUseOptimized` 存 config（对应卡片级的 `contentOptimized` / `useOptimized`）；`overallUseOptimized` 与总体编辑的「默认/优化」页签一一对应，打开总体编辑会回到当前生效的那一页。

**卡片管理**（头部按钮 → `eph-cm`）
- 一行：保存名称输入框 + 保存卡片 + 已保存下拉框（`cmRefreshList()`，选中**即直接加载**）+ 删除卡片；下半 = 可视化点选（点一下变绿、再点变灰，Ctrl 加减 / Shift 连选；**一个都不点 = 整份保存**）。
- 存 `userdata/prompts/<名称>.json`；名称含 `\ / : * ? " < > |`、以点开头、空、超 64 字一律拒（并做目录包含校验）。
- 选中/保存时记签名 `cmSig(node)=JSON.stringify(cards)`；之后又编辑过 → 签名不符 → **删除/加载被拦下要求重新选择**。

**媒体引用（@ 芯片 + 引用媒体窗口）**
- 编号引擎在 `web/ezflex_media_index.js`：实时扫描画布「生成节点」的媒体输入端口，**按目标节点自己的端口顺序、按类型各自从 1 开始、只数已连接端口**；节点标识 = 画布上看到的**标题**（**从不显示 `#id`**）。导出 `mediaIndex/indexTargets/refreshIndex/startIndexWatcher/installIndexHooks`。
- 例（MiniMax H3 统一节点）：`first_frame=图片1`、`last_frame=图片2`、`ref_image_1=图片3`、`ref_video_1=视频1`、`ref_video_audio_1=音频1`、`ref_audio_1=音频2`；`<Picture i>/<Video k>/<Audio j>` 与之对齐。`mediaFilesOfSlot` 对上游穿透 ≤4 层（Get Video Components / Reroute），优先吃 MediaOut 盖在 socket 上的 `sock._ezFiles`。
- 芯片 DOM `span.eph-mref`（`contentEditable=false`）+ 子节点 `span.eph-mref-ico`（图标）+ `span.eph-mref-txt`（文字）。插入走 `insertMediaRefOnce`：**每次都插一份**（同一素材可重复引用）。
- 「引用媒体」窗口（`_refBrowser`，`eph-rb`）：一个生成节点一块，卡片 `+` 插入 / `−` 移除一份 / `×N` 计数；右键弹 `.eph-ctx` 菜单（设为全体引用库 / 取消全体引用 / 仅本卡片引用）。引用目标只在窗口里体现（选中节点卡片标浅绿），工具条不做提示。

**平铺模式（弹窗 ⇄ 右侧浮层）**
- 头部按钮「⧉ 平铺 / 🗗 弹窗」→ `phDockToggle(node)`：开关存节点 config `ui.dock`（`stateFor` 默认 / `loadFromConfig` 读 / `syncToConfig` 写），同时写 `localStorage['ezflex.phDockMode']` 作**新节点默认**（节点里显式存过就以节点为准）。
- 三个浮层（`eph-modal` 卡片编辑 / `eph-all` 总体编辑 / `eph-rb` 引用媒体）加类 `ph-dock`：`inset:auto` + 内联 left/top/width/height/z-index、无遮罩、点外侧不关；**位置记的是画布坐标**（跟节点一样「放在哪就在哪」）：`phDockXform()` 取 `app.canvas.ds` 的 `scale/offset` + 画布元素 rect（与 modelscombo 的取法同源），`phDockAnchorTo()` 把屏幕位换算成 `cx/cy` 存进 `_phDockMem`，`phDockPlace()` 再按当前变换摆回屏幕；`phDockTrack()` 注册进 `scheduleOnRedraw`，**画布平移/缩放（setDirty）时面板跟着走**。画布被拖远后重开面板会 `phDockVisible()` 判定不可见 → 复位到右侧默认位（不然窗口会丢在画面外）。`phDockApply()` 在三处 open 时调用；`phDockInstall()` 只装一次，装两样东西：**标题栏拖动**（`⠿` 把手 + 视口内夹取）和**右下角缩放**（`.eph-dock-size`，拖拽改 width/height，最小 320×200，结果一起记进 `_phDockMem`）。平铺态**无遮罩、无阴影**（`box-shadow:none`），并隐藏「全屏」键。
- **关闭语义沿用原样**：✕ / 取消 = 放弃（`closeEditModal(false)`、`_allModal` 直接 remove active），保存 = 提交。弹窗模式的「点外侧自动保存」在平铺下不存在（没有遮罩）→ 平铺要保存必须点「保存」。
- 两三个面板同开时默认位置按 `PH_DOCK_ORDER` 错开 44px，露出下面那层的 ⠿ 把手；应用/拖动都会把该层抬到最上。
- **摆放/拖动都不夹取**（用户要求可以挪到视窗外）：`phDockPlace()` 只按画布变换算屏幕位，拖标题栏也不夹；**双击标题栏**回默认位（`mem.cx/cy = undefined` → 按右侧默认位重落）。默认高度 **60vh**、默认 top 96。
- **尺寸跟节点一样随画布缩放（滚轮）**：`mem.w/h` 存**画布单位**，`phDockPlace()` 里按 `ds.scale` 设 `transform: scale(k)` + `transform-origin: 0 0`（锚点不动）；所有落点换算都要 `/k`（`save()` 写回、缩放起手 `rw/rh`）。**最小尺寸按画布单位 320×240**（逻辑固定、屏幕上随缩放变 —— 早先按屏幕 380px 卡，缩小极限会随画布缩放漂）。
- **默认落点挂节点**：`phDockDefaultAnchor()` 按 PromptHelper 的 `pos/size` 算 —— 卡片编辑 / 总体编辑落在**节点右侧**隔 40px（两者纵错 36px），**引用媒体落在节点下方** 40px；**每次打开都回到这个默认位**（拿不到节点才退回屏幕右侧），打开后仍可拖走、跟画布走。
- **层叠放在 ComfyUI 之下**：`PH_DOCK_Z_BASE = 900 / MAX = 998`（`phDockRaise()` 段内递增）—— ComfyUI 前端的菜单/节点列表弹窗在 999~99999，平铺面板压在上面会挡住它们（实测挡过双击打开的节点列表和顶部工具栏）。我们自己的模态仍在 99999+，弹窗模式不受影响。
- **引用媒体去重**：`filesOnInput` 出口过 `dedupeFiles()`（按 `mediaKeyOf` = path/url/name），渲染层再按媒体键去重（计数 + 列表）—— 修 MediaOut 端口复用/扇出时「引用媒体」出现重复卡片的问题（弹窗模式同样生效）。
- **平铺模式差异：引用媒体自动跟新** —— `onIndexChange(phRefAutoRefresh)`：编号引擎靠 `LGraphNode.onConnectionsChange/onAdded/onRemoved` 钩子打脏标记 → rAF 重建 → 广播；只有「面板开着**且**是平铺」才重渲染，弹窗模式维持「打开时刷新」。**没有新增轮询/定时器**（复用引擎既有事件）。
- **页签滑块（默认/优化 那个胶囊）**：`phDockThumbs()` 在铺开/换模式/拖拽缩放改尺寸时调 `moveTabThumb()` / `moveAllTabThumb()` 重排，否则宽度变了它停在旧值、得点一下才正。

**已知限制**
- 类 `RETURN_TYPES` 全局共享（多实例由最后 POST 者决定）。
- 富文本仍用 `document.execCommand`（弃用但可用）。
- API/llama 优化需用户自备主机/密钥/服务并联网；无 OAuth。
- Vue 模式下黑框标签叠加层可能需按 Vue 端口坐标再校准。

### EzFlex-MediaLoader（素材加载器）
- 输出：每张「素材卡片」一个端口，**类型 = `EZFLEX_MEDIA_CARD`（`_MEDIA_CARD`）**（深红 `#d94848`，只给 MediaOut 消费）；标签 = `分组名_卡片名`；卡片数量无上限。
- config：`{ groups:[{id,name,cards:[{id,name,items:[{id,files:[{id,name,path,subfolder,dir,type}]}]}]}], currentGroupId, currentPreset }`。
- **与内置节点同款取值（勿回退）**：图像 `_ml_load_image`（PIL + `ImageOps.exif_transpose`，`[1,H,W,3]` float32）；视频 → `InputImpl.VideoFromFile(path)`（懒加载）；音频 → `{"waveform":[1,C,T],"sample_rate":rate,"path":abspath}`（**必须有 batch 维**，否则 H3 报 `must use [batch,channels,samples]`）；3D → `Types.File3D(abspath)`。`_file_kind`/`_media_kind` 以扩展名优先。
- 浏览（文件资源管理器式）：`GET /media_loader/browse?path=`（默认 input 目录）；文件统一 `/media_loader/serve?path=`；前端失败/空回退 `/media_loader/files`。顶栏含手动路径输入（回车跳转）+ 搜索；左侧可展开目录树；右侧列表/大/小/详细 + 全选/反选/清除 + 拖上传。
- 参数：`gridCols`（每行卡片数，默认 3）+ `gridRowH`（卡片高度倍数，`pv.height = max(1,gridRowH)*192px`；≤0 走 16:9）。
- 顶栏「加载输出」：`createNode('EzFlex-MediaOut')` + 放到右侧 60px + `connect(0,n,0)`。

### EzFlex-MediaOut（素材输出）
- 输入 `card`（`EZFLEX_MEDIA_CARD`）+ `config`；4 模式 `split/card/row/group`；输出端口类型 = 真实媒体类型对应的内置类型（image→IMAGE、video→VIDEO、audio→AUDIO、model_3d→FILE_3D，混合→`*` 且运行期明确报错）。
- **多文件必须给下游能吃的值，不能给 Python list**（`_mo_merge_values`）：图片 → 批张量（镜像内置 Batch Images，通道补齐、alpha=1.0）；音频 → 按时间拼接音轨；字符串 → `"\n".join`；类型不兼容 → `ValueError` 提示拆分。
- config `{off:[文件id]}` 局部禁用（保留端口、输出 `None`）。**批量设置**弹窗：尺寸（按第一张 / 自定义 WxH）+ 适配（crop/pad/stretch）+ 最多取几张 + 从第几张开始（对齐 KJNodes `Load Images From Folder`）；后端 `_mout_fit` → `{size,fit,cap,start}`。
- 输出端口写 `sock._ezMediaId` / `sock._ezLabel` / **`sock._ezFiles`**（供编号引擎读真实承载文件）。

## 3. 存储与路由

- 命名预设统一走 `_register_preset_routes(node_name, api_path)`（GET 列表 / POST 同名覆盖 / DELETE；服务器 `user_data/<节点名>.json`，`utf-8-sig` 读）：
  `/models_combo/presets`、`/freelatent/presets`（带 ratios）、`/nodeswitch_master/presets`、`/nodeswitch_group/presets`、`/main_control/presets`、`/param_preset_control/presets`、`/media_loader/presets`。
- 动态输出同步（前端 POST）：`/models_combo/outputs`、`/param_preset_control/outputs`、`/param_preset_output/outputs`、`/preview_any/outputs`、`/media_loader/outputs`、`/media_out/outputs`。
  ⚠️ `/prompt_helper/outputs` **已删**：PromptHelper 的类 `RETURN_TYPES` 固定成「`_PH_MAX_CARDS` + 1 = 33 个 STRING」不再收缩（见 §4.1），前端那侧也不用再同步。
- PromptHelper：`/prompt_helper/optimize`、`/custom_providers`(GET/POST/DELETE)、`/pick_folder`、`/pick_skill`、`/scan_roots`、`/scan_paths`、`/model_paths`、`/llama_models`、`/clip_models`、`/prompt_cards`（GET 无 name = 清单 / `?name=` = 读一份 / POST = 存 / DELETE `?name=` = 删）。
- MediaLoader：`/media_loader/files`、`/browse`、`/serve`、`/upload`、`/open`、`/save_as`、`/pick_folder`。ModelsCombo：`/models_combo/preview`、`/lora_meta`、`/lora_meta_detail`。
- 全局持久化 JSON（`folder_paths.user_directory`，本机 `<ComfyUI>/user/default/`）：`ezflex_scan_paths.json`、`ezflex_model_paths.json`、`ezflex_custom_providers.json`；卡片存档 `userdata/prompts/<名称>.json`。
- 节点当前状态存各自 config widget（随工作流序列化）。web 静态由 `_serve_no_store` 覆盖，刷新即生效。

## 4. 媒体取值契约（勿回退）

IMAGE `[1,H,W,3]` float32；VIDEO `VideoFromFile`；AUDIO `[1,C,T]` + `sample_rate`（+ 非标准 `path`）；FILE_3D `File3D`；MediaLoader 卡片 = `EZFLEX_MEDIA_CARD` dict（只给 MediaOut）；MediaOut 单类型口 = 对应内置类型，混合口 = `*` + 运行期报错。

## 5. 经验与避坑（踩过的坑 + 解法）

### 5.1 动态端口 / 序列化（通用）
1. **动态输出必须看「类 RETURN_TYPES」而非画布 socket 类型**（`execution.py:934`：`RETURN_TYPES[链接的槽位序号]` 取上游类型再和下游输入类型比对）。⚠️ **类属性全局共享**：同屏多实例卡数不同时，谁最后同步谁说了算 —— 收缩后别的实例高位槽一取就 `IndexError`（报错信息很难懂）。**PromptHelper 已按"固定最大表"解决**：`RETURN_TYPES = ("STRING",) * (_PH_MAX_CARDS + 1)` 且不再改（全 STRING + 够长 → 任何槽位都取得到、多实例互不干扰，也不需要 `/prompt_helper/outputs` 同步了）。**其它动态端口节点（ModelsCombo / ParamPreset* / PreviewAny / MediaLoader / MediaOut）仍是精确同步**，类型会变（`*`/真实媒体类型/EZFLEX_*），别照搬固定最大表（槽位类型会错位 → 误报 return_type_mismatch）。
2. 输出连接存 `o.links`（数组）/旧 `o.link`（单值）；重排 socket 后**必须遍历更新 `origin_slot`/`target_slot`**。
3. 动态端口按**逻辑 id** 复用 socket（`_ezGroupId`/`_ezParamId`/`_ezCardId`/`_ezMediaId`）防重名；顺序 = want 数组顺序。
4. **链路恢复守卫** `linkObjMissing`/`deferSync`：未恢复前不重排/删槽，否则 `origin_slot/target_slot` 对应的 socket 不存在 → link 被丢。
5. **config 输入口灰点**：`hideConfigWidget` 把名为 `config` 的输入口**从 `node.inputs` splice 掉**（`i.hidden=true` 不生效）；config widget 值在 `node.widgets`。
6. 节点删除必须在 `onRemoved` 清掉挂在 `document.body` 的黑框标签 DOM（`node._emlOutEls`/`_emooOutEls`）与各定时器，否则残留。

### 5.2 Vue（Nodes 2.0）/ 普通模式双兼容
- `addDOMWidget.canvasOnly` 是**二选一**：`canvasOnly: !window.__ezflexIsVueNodes()`（后者读 `Comfy.VueNodes.Enabled`）。
- 面板穿透需**常驻 CSS（`!important` + `:has()`）**（`injectSocketPanelBaseCSS`）：`.dom-widget.size-full:has(.ezfx-panel-shell)`、`.lg-slot [slot-data]` 抬 z-index + `::after` 放大命中盒、`.lg-node-widgets:has(.ezfx-is-vue)`、`.ezfx-is-vue [class*="-root"]` 里 button/select/input 回 `pointer-events:auto`、隐藏四角缩放图标（`opacity:0` 留热区）。
- Vue 面板偏移用 `--ezfx-vue-title`（默认 30px）/ `--ezfx-vue-side`（默认 10px）；shell 用 `top + height:calc(100% - top)` + `bottom:auto`（**勿设 `min-height:0`**）。
- 面板内层根 `position:absolute; inset:0 14px 14px 14px` 露 socket 圆点；`installResizeHandles` 只保留竖向（下缘左）+ 斜向（右下角），横向已删（会挡输出 socket 拖线）。

### 5.3 媒体编号引擎（`ezflex_media_index.js`）
- 编号**必须按目标生成节点自己的输入端口**算，不能全局顺排；多生成节点各一张表。
- 节点身份 = 画布上看到的**标题**（重命名后跟新名字），**永远不要显示 `#id`**。
- 端口媒体类型**以端口名优先**（`ref_video_1` → video，即使 socket 类型是 `*`）；文件类型**以扩展名优先**（存下来的 `type` 可能是旧值/猜错的）。
- 变化检测：`startIndexWatcher()` + `LGraphNode.prototype.onConnectionsChange/onAdded/onRemoved`；重命名/换素材后要**重编号 + 同步已插芯片**。

### 5.4 @ 芯片插入（血泪）
- 别用「切换」语义：同一素材要能引用多次 → `insertMediaRefOnce` 每次都插。
- **别用 `execCommand('insertHTML')`**：不可编辑芯片会把光标留在芯片前，还可能多包一层块导致自动换行。用 **Range 插入**「芯片 + 逗号」，光标落到逗号后。
- **插入前必须 `range.deleteContents()` 删掉用户敲的「@关键词」**，否则留下多余 `@`（看着像 `@@图片1`）。
- **`@` 触发不能用整段的 `/(@[^\s…]*)$/`**：正则取最左匹配，残留/前文的 `@` 会把逗号一起吞进搜索词（`",@"`）→ 菜单「无匹配媒体」。要从**最后一个 `@`** 起算（`lastIndexOf('@')` + 空白判定）。
- `range.setStartAfter(sp)` 在**游离节点**上会抛异常 → 先 clone 已保存的 `_editorRange`，失败再退回「选到末尾」。
- 无编号的素材（没接到生成节点）**标黄且不可插入**；编号按**本卡片的引用目标**算，不在目标端口上的项标灰。菜单定位要**贴底翻转 + 左右收边**。
- 芯片里多了 `span.eph-mref-ico` 子节点 → 改编号**只能改 `.eph-mref-txt` 的 textContent**，写 `sp.textContent` 会把图标抹掉。

### 5.5 总体编辑的 contenteditable 块结构（血泪）
- 卡片正文 `.eph-all-block-body` 与小标题行活在**同一个 contenteditable** 里：**块首退格 / 块尾删除**会让浏览器把正文包甚至整行小标题当字符删掉 → 「引用媒体」取不到正文（点了没反应）、输入也没反应，只有重开总体编辑才恢复。
- 三道防线：① `keydown` 拦截「光标正好在正文最前/最后」的 Backspace/Delete，改成把光标挪到相邻卡片正文（用 `range.cloneContents().childNodes.length` 判定，块内删空行不拦）；② 每块打 `data-cardId`，`syncAllContent` 按卡片 id 认块；③ `healAllEditor()` 结构不合法就地重建（输入时兜底、1.2s 节流），重建后光标放回原卡片。
- 收起小标题（`.eph-all.collapsed`）时该行 `display:none`，**「引用媒体」「−」就是故意不可见**（用户明确要求：悬停不许冒出卡片标题）。

### 5.6 多重弹窗分层关闭（只关最上层）
- `_phLayers` 栈 + capture `pointerdown`/`pointerup` 协调器。
- **只关「按下前已打开」的层**：`pointerdown` 快照 `_phDownOpen`，`pointerup` 里 `if (!_phDownOpen.has(el)) continue;`（否则点开关按钮会在同一击里把刚打开的下拉关掉）。
- **拖动不关**：`pointerup` 时 `max(|dx|,|dy|)>6` 直接 return。**一次只关最上层**：从栈顶往下找第一个不包含 `target` 的层，关掉即 break。
- 自动注册：`MutationObserver` 监听 `eph-*` 的 class，出现 `.active/.open` 就入栈，去掉即出栈。**删掉旧的「各自 mousedown 关自己」**（会导致点外面一下全关）。
- 关层时调 `el._phOnClose()` 做收尾（停播媒体 / 关放大预览）。**模态背板**：只有「本次关的就是自己」才关。
- ⚠️ **画布坐标换算拿 rect 要用 canvas 元素**：`app.canvas` 是 LGraphCanvas 实例，**它自己没有 `getBoundingClientRect`**（调用直接抛错）。换算公式是 ComfyUI 版 litegraph 的 `ds.convertOffsetToCanvas` / `convertCanvasToOffset`：`screen(元素内) = (画布坐标 + ds.offset) * ds.scale`，`画布坐标 = screen / scale - offset`，再叠加 `元素.getBoundingClientRect()` 的 left/top。取元素用 `canvas.canvas || canvas.canvasEl || canvas.ds.element`。踩坑记录：一开始照抄 modelscombo 的 `canvas.getBoundingClientRect()`（那处被 try/catch 吞掉，实际一直走鼠标坐标兜底），结果平铺面板拿不到变换 → **一直钉在屏幕上不跟画布走**。
- **平铺面板必须显式放行**：协调器里加 `if (el.classList.contains('ph-dock')) continue;` —— 平铺层没有全屏遮罩，点画布外侧时 `el.contains(t)` 永远为假，不放行就会第一下点外侧把它关掉（这正是平铺模式要避免的）。
- ⚠️ **面板里「后建」的控件要能点**：`makeDomWidgetHitThrough()` 把面板设成 `pointer-events:none`，只对**调用当时已存在**的 `button/select/input/textarea` 逐个写内联 `auto`；之后动态重建的行（MediaOut 的 开/关、翻页）没人管 → 表现是「点不动、要先点一下节点面板才点得动」。修法：`injectSocketPanelBaseCSS()` 里加常驻 CSS `.ezfx-panel-shell button,…{pointer-events:auto!important;}`（经典模式也要，Vue 原来就有）。
- ⚠️ **定时重建会吃掉点击**：MediaOut 的 `settle` 定时器每 250ms 调 `renderPanel()`，`list.innerHTML=''` 一重建，按下还没松手的那次点击就没了（现象：开/关 要点两下）。修法：`renderPanel()` 先算内容签名（模式 / 页码 / 每页 / 文件 id+名字 / 开关状态），签名没变直接 return。`set()` 里把 `node._moSig` 清掉强制重建。另外卡片弹窗 / 总体编辑各自的 `mouseup` 点外侧回调也要加 `!classList.contains('ph-dock')` 守卫。

### 5.7 MediaOut / MediaLoader
- **拆分口串号（已修）**：3 个文件都显示 `@图片1`，根因是 socket 解析丢了文件 `id` → `media_out.js` 往 socket 盖 `sock._ezFiles`（拆分口 = 1 个文件，卡片/分组口 = 该组全部文件），编号引擎优先读它。
- 前端**函数名必须一致**：曾定义叫 `renderPane`、调用叫 `drawPane` → `ReferenceError` → 弹窗空白。重命名后要 `node --check` + 真开一次弹窗。
- **后端路由未加载**时前端 fetch 静态失败 → 空列表：必须**新路由 → 旧路由回退**。
- 大/小图标 tile 预览要**固定高度 + object-fit:contain + overflow:hidden + gridAutoRows**，否则图片按原图尺寸把格子撑成条。
- 3D `autoShot` 只在**首次未拍**时自动拍，否则每次打开都重置到正面重拍。
- 浏览器原生 `<audio>` 控件**无法完全刷白**（`::-webkit-media-controls-*` 不可靠）→ 自绘 `makeAudioPlayer`；`<audio>` 用**屏外隐藏** `position:absolute;left:-9999px`（不是 `display:none`）。
- 预览切素材**复用同类型媒体元素**（仅换 `src`）避免闪屏。播放键要用 **CSS 类定位**（曾写成 `el('button','eml-play')` 没给样式 → 跑到右边）。
- 翻页页栏要 append 到 `.emoo-root` 面板根，**不能 append 到 `.emoo-shell` 外壳**（会被 `inset:0 14px` 裁掉看不见）。数字输入框去上下箭头：`appearance:textfield` + `::-webkit-inner/outer-spin-button{none}`。

- ⚠️ **端口没盖 `_ezFiles` 时不要退回「整张卡片」**：编号引擎的兜底一度是 `ezMediaFilesOfNode()`（= 该卡片**全部**文件），于是 MediaOut 关掉 1 个或几个素材、或端口/槽位刚重建时，引用媒体会冒出 MediaLoader 已加载、但没接入生成节点（或已被关）的所有文件。现在只做精确兜底：按 `_ezMediaId` 找一个文件，或**拆分模式**按槽位序号取，其余返回空。`media_index_test.mjs` 有对应断言。

- ⚠️ **EzFlex 节点在「媒体上溯」里必须是终点**：`filesUpstream()` 本来「本端口取不到就顺着输入继续往上找」（为穿透内置 Get Video Components 而设），结果 MediaOut 端口没盖 `_ezFiles` 时会一路捞到它的输入 = MediaLoader 的**整张卡片** —— 只要该 MediaOut 接进了生成节点，引用媒体就冒出全部已加载文件（含没接入、已被关掉的）。现在 `EzFlex-MediaOut` / `EzFlex-MediaLoader` 命中即 `return []` 终止上溯（`media_index_test.mjs` 用「两个文件的卡片」断言守住）。

### 5.7.1 运行期空传（禁用端口 → prompt 里摘掉这条输入）
- 背景：拆分模式禁用端口输出 `None`，下游若「可选 + 默认 None + 不判 None」照样崩（对节点来说"没连"的默认值也是 None）。
- 做法（`media_out.js` 的 `moPruneDisabledInputs()` + `api.queuePrompt` 包装）：**前端排队提交前**，把指向「已禁用端口」的输入键从 prompt 里删掉 —— 不改画布、不拔线、不闪。判定用 prompt 里 MediaOut 的 `inputs.config.off` + 活节点 `outputs[slot]._ezFiles`（面板盖的章）；**没盖章 / 混合端口 / 找不到节点 → 一律保守不动**。先算完再删，分析出错不会留"删一半"的 prompt；包装层 try/catch，任何异常都按原样提交。
- 后端因此看到的是「这条输入不存在」：可选输入 → 用节点自己的默认值；**必需输入 → `execution.py:898-913` 校验直接拦下并指名报错**（前端显示「缺少连接 — {节点} 缺少必需的输入：{输入}」）。
- 覆盖范围：比 `/prompt` 更靠前的网络入口只有 `api.queuePrompt`（前端包里 `fetchApi('/prompt')` 直连 0 处）；**从 HTTP API / API 格式 JSON 排队不经前端，盖不到 → 仍是 `None`**。
- 测试：`_dev_tests/media_out_prune_test.mjs`（14 条：正常摘 / 混合组保留 / 没盖章保留 / off 空 / 源不对 / 找不到节点 / 幂等 / 包装层与返回值）。

### 5.8 其它
- **ComfyUI 的 `ui` 契约：每个键的值必须是「列表」**（`execution.py:413` 用 `{k: [y for x in uis for y in x[k]]}` 把多个 ui dict 合并成**值列表**）。踩坑：PromptHelper 的 ui 给了标量 —— `useOverallOptimized: True` 当场 `TypeError: 'bool' object is not iterable`（节点执行失败，栈却停在 execution.py，很难联想到是自己返回的 ui）；字符串更阴：不报错，但被**拆成一个个字符**。**规矩：后端一律 `"key": [value]`，前端 `onExecuted` 拿到的就是值列表、要取 `[0]`**（前端用 `uiScalar/uiList` 兼容标量与列表两种形状）。同轮删掉了没人读的 `ui.counts`/`ui.merged` 与 `_ph_media_count`。
- **优化失败不要只 `print` 到控制台**：PromptHelper 运行期自动优化的结果**就是节点的主输出**，早期写法是 `try/except → print → opt_text=""`，于是「llama 的 n_ctx 装不下合并正文」这类失败在界面上只表现为**输出空提示词**，用户完全看不出原因（实测排查：`logs/comfyui.log` 里才有 `[PromptHelper] … 失败: You MUST increase n_ctx`）。现在改成抛 `ValueError`（llama 再附一句"把「设置·llama设置」的 n_ctx 调大"），节点直接报红。**排障第一步：看 `logs/comfyui.log` 里的 `[PromptHelper]`。**
- **ComfyUI 出新值类型时，PreviewAny 会「静默降级」而不是报错**，必须主动跟：0.30 新增 `Types.MESH / SPLAT / VOXEL`（Hunyuan3D / Trellis / MoGe / 高斯泼溅节点），`_infer_type` 不认就掉到 `cls.upper()` + 裸 repr；同类还有两个实测踩到的：① 内存型 `VideoFromComponents` 只抓前 60 帧重编码 → 音轨丢、帧率靠猜；② CONDITIONING 的真身是 `[[cond_tensor, {…}]]`，旧判断看的是 `value[0][0]` → 真 conditioning 全被当成 LIST。**做法：新类型先在 `_infer_type` 里显式认出来，再在 `_entry` 里给一个像样的卡片（能可视化就导文件交给现成查看器，不能就文本摘要），最后在 `_dev_tests/preview_types_test.py` 里加一条断言** —— 别让「不认识」这件事故意变成「一张裸 repr」。
- **别留「UI 上看不见、后端还认」的开关**：老版本在 TextGenerate 设置里有个 `enabled`，后来改成通用设置的三个滑块（`autoTextgen`）后，后端还继续读 `textgen.enabled` 作兼容。结果：用户把三个开关全关，老配置里那个看不见的 true 仍会让运行期跑 textgen「关不掉」。已删（前端 `_TG_DEFAULTS` 里的死字段 + 后端两处读取），现在**三个全关 = 一定不优化**。
- `window.prompt` 在 ComfyUI 不可靠 → 自绘 `uiPrompt` / `uiConfirm`；DOM 拖拽用 **Pointer Events + window 捕获**（克隆影子 + 插入线 + 占位线）。
- 共享前端工具放 `ezflex_service.js`：`TYPE_ICONS`、`makeAudioPlayer`、`decorateSelect`。⚠️ 装饰器会隐藏原生 `<select>`，很多节点原有 `.value/.options/.change` 逻辑依赖原生元素 → **已回退这些节点到原生 select**（仅媒体加载器预设下拉保留自绘）。
- **删死代码翻过车**：批量删除脚本过度删除（`_ph_clip_models`、模型列表路由块、`_MEDIA_*_EXTS` 被误删 → 运行期 NameError）。修法：从快照恢复后（快照目录 `_backups/` 已清理，回退改走发布仓库 git 历史）改用**精确匹配 + 断言**重做，并新增 `undefined_names.py` / `route_audit.py` 作守卫。**静态扫描必须把 `_dev_tests/` 一起算进去**（`indexTargetCount` 被测试用到过）。
- 文件恢复操作会产生**相邻重复行** → 合并前先全仓扫相邻重复行。
- PreviewAny 性能/存档的用户原话：视频/音频「本来就是的不要编码，正常传过去就行」；存档「全屏时用原图」。
- **DOM 面板控件要在「状态 → UI」函数里统一回填**：ComfyUI 建节点时 `nodeCreated`/`setupNode` **先于** `widgets_values` 恢复（`onConfigure` 才拿到工作流里的 config），所以只在 buildPanel 里写一次的控件，刷新/重启后会**一直显示默认值**（实测：FreeLatent 的「对齐」存的是 32，界面却显示 8，而 config 与后端一直用的是 32 —— 值没丢，纯粹是没人回填）。改法：把这类控件（对齐/最大边下拉+自定义框/批次/算法按钮）都放进 `updateInfo()` 从 `st` 回填，`refresh()` 一调就同步。
- **排布节点别直接用 `node.pos`，也别用 `node.getBounding()`**：LiteGraph 的 `node.pos` 是「标题栏下沿」的左上角，标题栏画在 `pos` 上方（高 `LiteGraph.NODE_TITLE_HEIGHT`，30px）。按 pos 排两个节点、间隔取 30，视觉上就是**贴在一起**。正确做法：视觉顶 = `pos[1] - NODE_TITLE_HEIGHT`，**下一节点的视觉顶 = 上一节点的 body 底边 + 间距**，纵向推进量 = `NODE_TITLE_HEIGHT + size[1]`；「底部平齐」对齐的是 body 底边（`pos[1] + size[1]`，下方没有额外内容）。`NODE_TITLE_HEIGHT` 直接取常数（与渲染同源）。**标题高度不要用 `node.getBounding()` 取**：litegraph 里 `getBounding()` 返回的是节点的 `boundingRect`（`measure()` 时才写），**刚建出来的节点还没测量，读到的是脏值** → 算出离谱偏移，整列节点被排到屏幕外（实测踩过）。另外坐标要 `isFinite` 兜底再赋给 `node.pos`。MainControl「加载全部」见 §2，排完 350ms 还要再对一次齐（DOM 面板高度下一帧才定型）。
- 3D 用**本地离线** three.js：ComfyUI 内置 `vendor-three-*.js` 非独立（import 内部模块），故把自包含 `three@0.160.0` + GLTF/OBJ/FBXLoader + BufferGeometryUtils + fflate + NURBSCurve 放 `web/libs`、`web/utils`、`web/curves`；serve 走 `/preview_any/3d/{path}`（ComfyUI 默认不递归 expose `web/` 子目录）。

## 6. 性能设计（EZ_PERF，V1.1）

> 原则：**只改刷新时机与频率，不动连通逻辑**（registerNode / ezflex:changed / api.current() / 引用编号语义未改）；后端 `__init__.py` 执行路径零改动。

- **交互期连续帧泵 `pumpFrames(ms=300)`**（`ezflex_service.js`）：唤醒后 300ms 内每帧跑所有标签更新（等价旧的 60fps），停手 300ms 自动停 → 静止零开销。触发源三重保险：① `LGraphCanvas.prototype.setDirty` 打补丁；② 画布元素上的 `pointerdown/pointermove/pointerup/wheel`（Vue 模式兜底）；③ resize / scroll / `ezflex:changed`。各节点 `onDrawForeground` 里**同帧同步 `update()`** 并续上泵帧。
  - ⚠️ **只靠 `onDrawForeground` 触发会比鼠标慢一拍**（实测所有黑框「像流体一样」），该钩子并非每帧都触发，必须配 pumpFrames。
- **轮询全部删除**：MainControl / NodeSwitchMaster / NodeSwitchGroup / 媒体索引 改「画布重绘 + ezflex:changed」驱动；`scheduleScan` 由 500ms 去抖改成**前沿节流 400ms**（连续拖动 ≤2.5 次/秒）。
- **媒体索引合并到帧**：`markIndexDirty` → `refreshIndexSoon()`（一帧内多次变化只重建一次）；`refreshIndexNow()` 在**打开引用媒体面板前 / cardRefFiles** 强制同步。`renderRefBrowser` 加 `_building` 防重入闸门（里的 `refreshIndexNow()` 会同步回头调用自己，否则出现两份一样的卡片）。
- **3D 预览按需渲染**：去掉常驻 `renderer.render()` 自递归，拖拽/滚轮/材质/线框/背景/重置/截图各自触发一次。
- **总开关 `EZ_PERF`**：`labelFallbackMs` / `mainPollMs` / `indexPollMs` / `groupPollMs` 默认全 0（关闭兜底轮询）、`render3d:'ondemand'`。出问题**只改常数**即可回到旧行为。
- 当前开销：完全静止 = 0 定时器 / 0 rAF / 0 强制 reflow；交互时每帧一次布局读写；交互结束 300ms 内静默。
- 原始《性能优化方案·改动前后对比》已随笔记清理删除；**回滚点全在 `EZ_PERF`**（`web/ezflex_service.js:33`）：`labelFallbackMs` / `mainPollMs` / `indexPollMs` / `groupPollMs` / `render3d`，改常数即回旧行为。

## 7. 本地验证（每次改完必跑）

```powershell
$root="D:\software\AI_software\Comfy-Desktop\ComfyUI-Installs\Comfyui0.30.1\ComfyUI"; $py="$root\.venv\Scripts\python.exe"
$d="$root\custom_nodes\Comfyui-EzFlex-Presets"; $t="$d\_dev_tests"
$env:PYTHONIOENCODING="utf-8"   # 否则中文输出在 GBK 控制台是乱码

# 1) Python 语法
& $py -c "import ast,io; ast.parse(io.open(r'$d\__init__.py',encoding='utf-8').read()); print('PY OK')"
# 2) 静态扫描：未定义私有名 + 路由（前端 fetch ↔ 后端注册，看「缺: 0」）
& $py "$t\undefined_names.py" ; & $py "$t\route_audit.py"
# 3) JS 语法（.js 是 ESM，复制成 .mjs 再 check；别走管道避免中文乱码）
foreach($f in (Get-ChildItem "$d\web" -Filter *.js -Recurse)){ $tmp=Join-Path $env:TEMP ("chk_"+$f.BaseName+".mjs"); Copy-Item $f.FullName $tmp -Force; & node --check $tmp; Remove-Item $tmp -Force }
# 4) 真 venv Python 套件（AST 抽模块级代码跑，不整体 import，避免注册 PromptHelper 路由）
& $py "$t\loader_contract_test.py"      # 11 条：图像/视频/音频/3D 与内置同款
& $py "$t\media_merge_test.py"          # 27 条：MediaOut 多文件输出可消费
& $py "$t\preview_fastpath_test.py"     # 21 条：文件视频/音频不重编码 + 内存型视频（音轨/帧率不丢）
& $py "$t\preview_save_test.py"         #  9 条：存档用原图 + PNG 元数据
& $py "$t\preview_types_test.py"        # 98 条：每种值类型的识别 + 卡片内容（MESH/SPLAT/VOXEL、CONDITIONING、无裸 repr）
& $py "$t\prompt_helper_test.py"        # 160 条：卡片合并规则 / 卡片管理 / API 调用参数 / 综合媒体 / 规范编译 / 先合并再整体优化
& $py "$t\prompt_helper_dock_test.py"   #  61 条：平铺模式接线（CSS/持久化/三处 open/点外守卫/协调器放行/拖动·缩放/跟随画布+随缩放/不夹视口+双击复位/节点默认落点/层叠 900/页签重排/引用自动跟新/去重/动态控件/防重建）
# 5) Node 套件
node "$t\import_test.mjs"               # 11 个 registerExtension + NODE_TYPES 一致性
node "$t\media_out_prune_test.mjs"      # 14 条：运行期空传 —— 禁用端口在提交前从 prompt 摘掉（混合组/没盖章/找不到节点一律不动）
node "$t\media_index_test.mjs"          # 48 条：编号表（含过期 type / 非 EzFlex 中转节点穿透 GVC←卡片·GVC←MediaOut / 端口重复去重 / 端口没盖章不冒整张卡片 / EzFlex 节点终止上溯）
```

- 实测全绿基线：`PY OK`、`OK：没有"用了但没定义"的私有名字`、路由 `缺: 0`（`DEAD` 几条为误报：路径由动态字符串拼出，如 `/extensions/Comfyui-EzFlex-Presets/`、`/preview_any/serve_3d`、`/preview_any/serve_video`、`/preview_any/folders`）、全 `web/**/*.js` `node --check` 通过、9 个套件全通过（7 个 Python + 2 个 Node）。
- 测试脚本注意：`_dev_tests/_tmp` 用于临时文件（ComfyUI temp 目录在沙箱外会 `PermissionError`）；PreviewAny 存档测试需要 `folder_paths` shim。
- ⚠️ **源文件改写不要用 PowerShell `Get-Content`/`Set-Content`**（会毁编码，曾把 `web/prompt_helper.js` 写坏；那份损坏备份已清理）；用编辑器工具或 Python `newline=''`。
- `_dev_tests/` 里 `extensions/`（web 副本）、`scripts/`（app.js/api.js 桩）、`_tmp/`（素材与存档）**全是跑测试时自动生成的**：两个 `.mjs` 测试开头就 `mkdirSync + readdirSync(web/) + copyFileSync`，Python 套件自己 `makedirs` 写素材。所以这三个目录随时可删，跑测试会重建；反过来说，**改完 `web/*.js` 直接跑测试拿到的就是最新副本，不存在副本过期**。

## 8. 待办

### 8.1 体验优化（待做，按用户痛点排序）

- [ ] **临时预览文件（`ezpv_*`，含新的 `ezpv_vid_*`）会一直积累** → 自动清理（启动时扫一次 + 定期清）。视频临时文件按内容 sha1 命名，同一段视频反复预览只占一个，但换内容仍会涨。
- [ ] **Vue（Nodes 2.0）下 ModelsCombo / FreeLatent 白面板底部略凸**；黑框标签叠加层可能需按 Vue 端口坐标再校准（两处都是观感问题，不回退白框）。
- [ ] **MediaOut 可选增强**（用户尚未点头）：额外 `count` / `image_path` 输出端口；JPEG/WebP 存档也写工作流元数据；存档登记进 ComfyUI 历史画廊。
- [ ] **PromptHelper 规范还缺「画面构成 / shot at 时间」的对应字段**（是卡片级字段还是模板片段未定，先定数据再进模板）；`rules` 现在只存节点 config，若要「一次设置全局复用」需加 `userdata/ezflex_rules.json` 兜底（可抄 `_ph_scan_paths_file()` / `_ph_model_paths_file()`）。
- [ ] 综合媒体端口目前只做计数/引用提示（编号、@ 菜单可用），**不参与合并文本**。
- [ ] 图生图 / 视频生视频后续单独拆节点，不再塞进 FreeLatent；图像缩放（按比例/按像素/按固定宽高）、VAE 编码、获取图像尺寸 由内置节点承担，或后续做 EzFlex 单功能节点。

- [ ] **提示词规范仍缺官方条目**（V1.11 核对结论，详见 §9.4）：素材数量/时长上限（Seedance 2.5 图 0-30/视 0-10/音 0-10 且 [4,30]s；2.0 图 1-9/视 0-3/音 0-3 且 [4,15]s）、字幕/Logo/水印约束句模板、素材按上传顺序编号 + `<主体N>@<图片N>` 绑定规则、Kling prompt ≤3072（建议 ≤2500）与每镜头 ≤512 字符、负面提示词处理（Kling 3.0 写在正向提示词里的否定句）、Seedance 按 1.0/1.5/2.0/2.5 拆成多条规范。
### 8.2 技术注意（非体验）

- [ ] 类 `RETURN_TYPES` 全局共享（多实例由最后 POST 者决定）—— **PromptHelper 已改为固定最大表、不受影响**；ModelsCombo / ParamPreset* / PreviewAny / MediaLoader / MediaOut 仍在精确同步，多实例卡数不同时高位槽可能取越界（见 §4.1）。
- [ ] 富文本仍用 `document.execCommand`（弃用但可用）。
- [ ] 仓库 `blackbossokok/Comfyui-EzFlex-Presets` 落后于本地（建议提交；github.com API 可达，raw.githubusercontent.com 不可达）。
- [ ] Python 改动（新节点/路由/类）需完整重启 ComfyUI；前端 JS no-store，刷新页面即生效。

## 9. 外部规范核对（已归档）

原独立文件 **`_prompt_spec_audit.md`**（223 行官方核对报告）、**`提示词规范对照_官方与社区.txt`**（699 行素材）、**`性能优化方案_改动前后对比.txt`**（201 行）已清理，结论全部并入本节与 §6 / §8.1。

### 9.1 规范本体在哪

- `web/prompt_helper.js` 的 `_PROMPT_RULES`（2383–2431 行）= **15 条内置条目**：`none`(不编译) / `api`(使用 API) + 13 家厂商 `h3` / `seedance` / `kling` / `wan3` / `wan22` / `ltx` / `hunyuan` / `qwen` / `flux2` / `hailuo` / `vidu` / `pixverse` / `runway`。（README 早先写「16 条」是笔误，已按 15 条改正。）
- 每条结构：`{ id, label, base, ref{image,video,audio}, ts{tpl|off}, note }`；`alt` = 另一种语言那一份（中|EN 开关切），`base` 标明本体语言，`ts.off` = 该家不用时间戳。
- 用户改动存 `rules.overrides[id]`（`_applyOverride` 只覆盖 label/ref/ts/note/base/alt），自定义规范存 `rules.custom`；旧 id `seedance_en` 由 `_RULE_ALIAS` 归并到 `seedance`(lang=en)。

### 9.2 官方文档怎么取（下次核实照这个来）

- **火山方舟**（Seedance / Seedream）：文档页是 SPA，正文走内容接口 `https://www.volcengine.com/api/doc/getDocDetail?DocumentID=<id>`（返回 Quill delta）。
- **可灵**（Kling）：任意文档 URL 末尾加 `.md` 直接拿 Markdown；索引 `https://kling.ai/document-api/llms.txt`。
- **BytePlus 英文页**（`docs.byteplus.com/en/docs/ModelArk/…`）是 SPA，正文取不到、加 `&Language=en` 也只回中文 → **Seedance 英文引用写法至今没有官方原文**，`alt` 里那一版是「按中文版对应」，不要对外声称与官方一致。

### 9.3 已按核对结果修掉的（V1.11）

| 项 | 官方原文要点 | 现在怎么写 |
|---|---|---|
| Kling 分镜第二字段 | `shot n, m, words;`，**m = 该镜头时长秒**（不是起始秒） | `ts.tpl = 'shot {S}, {dur}, {text};'`，note 写明「≤6 段、各段 ≥1s、时长和 = 总时长、每段 ≤512 字符」（后三条官方一致） |
| Kling 引用 | 3.0 Omni 支持正文 `@image_1` / `@Zhang` / `@video_1` | `ref = { image: '@image{n}', video: '@video{n}' }` |
| Seedance 引用 | 2.0 用 `<图片N>`、2.5 用 `图片N`、1.0/1.5 正文不写引用（走 API role） | `<图片{n}>`，note 补「参考<图片1>中的<主体1>」「张三@图片1」绑定 |
| Seedance 时间戳 | 2.0 官方明说精确时间不稳定；2.5 才支持整数秒区间且时间轴要连续 | note 写「2.0 只认镜头1/镜头2；2.5 才认整数秒区间」 |
| Seedance 声音记号 | 音乐 `()`、音效 `<>`、台词 `{}`、字幕 `【】` | 已进 note |
| Seedance 结构公式 | 1.5：主体+运动+环境（非必须）+运镜/切镜（非必须）+美学描述（非必须）+声音（非必须） | note 顺序/用词已对齐，不再写「场景/风格/镜头」 |

**未采纳**（官方无原文，属社区写法，保留但已在 note 里标注）：Kling「每段都要重复关键特征」、Kling 画面公式、Seedance 英文引用写法。

### 9.4 仍缺的官方条目（已进 §8.1）

素材数量/时长上限（Seedance 2.5 图 0-30 / 视 0-10 / 音 0-10 且 [4,30]s；2.0 图 1-9 / 视 0-3 / 音 0-3 且 [4,15]s）、字幕/Logo/水印约束句模板、素材按上传顺序编号 + `<主体N>@<图片N>` 绑定规则、Kling prompt ≤3072（建议 ≤2500）、负面提示词处理、Seedance 按 1.0/1.5/2.0/2.5 拆成多条（四版规则互相冲突：时间戳/引用语法/素材数量/时长范围全不同）。
