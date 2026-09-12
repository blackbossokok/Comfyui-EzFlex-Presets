# Comfyui-EzFlex-Presets（V1.11 稳定版）

用于comfyui的灵活组合插件，使用ai构建完成，目前插件还在更新完善中。

![整体预览](./images/overview.png)
B站演示视频：[点击观看](https://www.bilibili.com/video/BV116tz6xE5V)

## EzFlex 节点列表：
- 总控制节点( `MainControl`）
- 模型组合加载器（`EzFlex-ModelsCombo`)
- 分辨率/Latent 选择器（`EzFlex-FreeLatent`）
- 节点总控制(`NodeSwitchMaster`)
- 节点开关组（`NodeSwitchGroup`)
- 参数预设控制节点（`ParamPresetControl`）
- 参数输出控制节点（`ParamPresetOutput`）
- 任意预览（`EzFlex-PreviewAny`）
- 提示词助手（`EzFlex-PromptHelper`）
- 素材加载器（`EzFlex-MediaLoader`）
- 素材输出（`EzFlex-MediaOut`）
- 共 **11 个节点**

## 版本更新内容：

- V1.11：提示词助手功能全面优化，修复bug。
- V1.1：插件节点全面完善、性能、提示词助手（`EzFlex-PromptHelper`）功能全面增强、修复适配bug。
- V1.05：提示词助手新增「引用媒体」：实时读取画布上生成节点（MiniMax H3 / Wan / LTX / 音频模型等）的媒体输入端口，按端口算出「图片N / 视频N / 音频N」编号与编译标签（`<Picture 1>` 等）；面板按生成节点分块预览素材（缩略图 / 名字 / 大小 / 格式 / 播放），右上角 +/− 一键插入或移除 @引用；多个生成节点各自独立编号，没接入生成节点的素材在 @ 菜单里标黄且不编号。
- V1.04：新增素材加载器( `EzFlex-MediaLoader`）与素材输出 (`EzFlex-MediaOut`）节点；全面优化提示词助手（`EzFlex-PromptHelper`）（仍在更新开发中）。
- V1.03：优化ReadMe描述，FreeLatent增加强制生效按键（忽略外部输入宽高及批次），修复对齐后端默认按照8对齐的问题，新增提示词助手节点。
- V1.02：优化ModelsCombo画廊浏览搜索逻辑。
- V1.01：优化参数预设控制节点切换预设连线逻辑。
- V1.0：稳定发行第一版。

## 安装

把本目录放到 `ComfyUI/custom_nodes/` 下，重启 ComfyUI。

依赖：本插件**只需要额外装 `mutagen`**（读音频/视频标签），其余（torch / numpy / Pillow / safetensors / av）ComfyUI 自带；不想手动装就 `pip install -r requirements.txt`。可选：`llama-cpp-python`（提示词助手的「进程内 llama-cpp-python」模式）、`gguf` / `onnx`（读这两类模型的元数据卡）。

## 使用

Comfyui节点列表中搜索EzFlex点击选择使用。

## 节点功能

### 总控制节点( `MainControl`）：

- 控制：控制总体节点行为。**卡片列表**（带预设下拉、可拖拽排序）＝ 模型组合加载器（`EzFlex-ModelsCombo`）、分辨率/Latent 选择器（`EzFlex-FreeLatent`）、节点总控制（`NodeSwitchMaster`）、参数预设控制节点（`ParamPresetControl`）。这四类都有各自的「预设」接口，总预设会把它们的当前预设一起记下来，切换总预设时级联下推。**节点开关组不在这里单独列** —— 它归「节点总控制」管。
- 加载：右上「加载全部」一键铺开 9 个节点，右下「— 加载节点 —」下拉可单独补一个。可加载清单＝模型组合加载器 / 分辨率·Latent 选择器 / 节点总控制 / 节点开关组 / 参数预设控制 / 参数输出控制 / **提示词助手** / **素材加载器** / **任意预览**；**素材输出（`MediaOut`）故意不在清单里**——素材加载器已经能承接它的输出。
- 加载全部的排布：以总控制节点自身位置为原点——同一行左边是素材加载器、右边是分辨率/Latent（中间就是总控制），第二行 4 个（模型组合 / 节点总控制 / 节点开关组 / 任意预览），第三行 3 个（提示词助手 / 参数预设控制 / 参数输出控制）。
- 预设：可自由组合保存删除总体节点行为预设。
- 快捷加载：可快捷加载其他EzFlex节点。

### 模型组合加载器（`EzFlex-ModelsCombo`)：

- 组合加载：可自由组合加载Unet、Clip、Vae、Checkpoint、Lora模型。
- 预设：可自由组合保存删除模型加载方式。
- 预览：可预览下拉列表模型封面。
- 画廊：可画廊式预览选择加载模型。(需要Comfyui-lora-magager插件通过c站生成json文件)
- 输出：根据模型数量（加载器卡片）及类型生成对应数量及类型输出端口，其中lora加载器串联在选择目标model后面，多个lora按卡片顺序串联，输出名称为`自定义名称_model/clip/vae`。
- 顺序：可自由调整卡片顺序。

### 分辨率/Latent 选择器（`EzFlex-FreeLatent`）：

- 画布：可自由拖拽画布生成对应空Latent，按住ctrl可取消吸附。
- 宽高输入：可手动输入宽高。
- 对齐分辨率：根据`优化/标准`算法按照`分辨率步数`计算相应宽高，目前影响`手动输入宽高、宽高预设选择、比例及Mp值计算后的宽高`。
- MP：百万像素。
- 比例预设：宽 : 高，可选择默认比例预设及自定义比例预设。
- 宽高预设：可选择默认宽高预设及自定义宽高预设，可自定义保存删除（`根据目前实际宽高`）。
- 自定义比例：可自定义保存删除输入的比例预设。
- 信息面板：实时显示实际宽高、比例、MP值。
- 输入：外部宽高、批次数量。
- 输出：空Latent、宽高、批次数量。
- 强制生效：绿色时忽略外部宽高/批次，强制面板值生效，并解除控件禁用（仅任一输入有值时可用）

### 节点总控制(`NodeSwitchMaster`)：

- 控制：控制节点开关组行为，可自定义组合保存删除预设。

### 节点开关组（`NodeSwitchGroup`)：

- 控制：控制节点（已分组）动作行为`开启/禁用/绕过（忽略）`
- 预设：可自由保存删除节点开关预设。
- 分组匹配：按名称/按颜色，子节点匹配。
- 顺序：按位置/名称自动排序卡片。
- 注意：该节点为实例预设，删除节点后对应预设同步消失。


### 参数预设控制节点（`ParamPresetControl`）：

- 控制：`参数绿/红按钮`：是否显示在输出列表及参数组卡片下拉列表中。`参数组下拉列表`：选择输出参数（输出或特定）。
- 预设：可自由保存删除参数组预设。
- 参数：目前有int、float、bool、string、complex、tuple、list、set、dictionary八种类型
- 顺序：参数组卡片、参数卡片均可自由拖动。
- 输出：根据参数组卡片数量生成对应输出端口，多参数红色，单参数灰色。

### 参数输出控制节点（`ParamPresetOutput`）：

- 控制：开启/禁用控制参数输出,int->0,bool->false，float->0.0，string等->空字符串。
- 类型提示：显示实际类型，若值与参数预设控制节点（`ParamPresetControl`）设定类型不一致，默认输出string并标红。
- 值预览：可点击弹窗预览。

### 任意预览（`EzFlex-PreviewAny`）：

- 预览类型：自动识别任意输入类型，渲染对应预览卡片（可拖拽排序，随连接自动增删）。
- 保存设置：自动保存点击后可保存否则仅预览，可选择保存位置、保存选项。
- 保存类型：

| 类型 | 接受数据 | 预览方式 | 支持格式 |
|---|---|---|---|
| IMAGE | tensor `[B,H,W,C]` | 缩略图 + 全屏原图 | PNG / JPEG / WebP / BMP / TIFF |
| MASK | 2D/3D tensor | 灰度 PNG | PNG |
| AUDIO | `{waveform,sample_rate}` 或 `(waveform,sr)` 或文件对象 | 播放器 | WAV / MP3 / FLAC / OGG / M4A / AAC |
| VIDEO | `VideoFromFile` / `VideoFromComponents` 对象 | 首帧封面 + 播放器 | MP4 / WebM / MOV / GIF / AVI / MKV |
| CONDITIONING | 含 `conditioning/context` 的 dict | 文本摘要 | — |
| LIST / TUPLE / SET | list / tuple / set | 索引值树（序号:值） | JSON |
| DICT | dict | 键值树（键:值） | JSON |
| STRING / INT / FLOAT / BOOLEAN | str / int / float / bool | 文本（截断 + 弹窗全文） | TXT / MD / JSON / CSV / LOG / HTML |
| LATENT | `{samples}` dict | shape / dtype 摘要 | — |
| FILE_3D | `File3D` 对象（内置 Load3D 同款） | three.js 查看器（离线） | glb / gltf / obj / fbx |
| MODEL_3D | File3D 对象（含 path/file） | three.js 查看器（离线） | glb / gltf / obj / fbx |
| MESH | `Types.MESH`（顶点/面张量，Hunyuan3D / Trellis / MoGe 等） | 顶点/面导成临时 OBJ → three.js 查看器 | 顶点 ≤50 万、面 ≤100 万（超了只给摘要） |
| SPLAT / VOXEL | `Types.SPLAT` / `Types.VOXEL`（张量） | 文本摘要（点数 / SH 系数 / 体素分辨率） | — |
| MODEL | ModelPatcher | 模型元数据卡 | safetensors / gguf / onnx / ckpt / pt |
| CLIP | comfy.sd CLIP | 元数据卡 | safetensors / gguf / onnx |
| VAE | comfy.sd VAE | 元数据卡 | safetensors / gguf / onnx |
| CONTROL_NET / CLIP_VISION / STYLE_MODEL / UPSCALE_MODEL / LORA_MODEL / GLIGEN / SAMPLER / SIGMAS / GUIDER / NOISE / SEGS | 对应 ComfyUI 对象 | 文本摘要 | — |
| EMPTY | 未连接 | “(未连接)” | — |

- 预览方式：数据预览弹窗/生成信息。

### 提示词助手（`EzFlex-PromptHelper`）：

- 卡片：增删 / 拖拽排序 / 双击改名；每张卡有「默认 / 优化提示词」两页和「合」开关（绿=进合并，灰=不进）。
- 编辑器：Word 风格工具条（加粗/斜体/下划线/删除线、对齐、字号、字体颜色、高亮、首行缩进、查找替换、取色器、全半角转换）+ skill 按键（选 *.md 按行插入光标处）。
- 引用媒体：实时读画布上生成节点的媒体端口，按端口算出 @图片N / @视频N / @音频N 编号；「引用媒体」窗口按生成节点分块列素材，+ 插入 / − 移除 / 右键设为全体引用库。
- 提示词规范：「设置·规则设置」里 16 条内置规范 + 自定义（可改可存、支持中英双语变体与 中|EN 切换），把引用标记编译成各家写法（<Picture 1>、@image1 …）。
- 优化：工具下拉「优化提示词 (API) / (TextGenerate) / (llama)」；可点一次用，也能开「运行期自动优化」；三个开关互斥，失败直接报错。
- 卡片管理：把卡片存成预设（userdata/prompts/<名称>.json），可只存点选的几张、选中即加载、删除。
- 端口：没有 CLIP 输入 —— 动态「综合媒体」口（ANY，图像/视频/音频/3D）+ 每卡一个文本输入口；输出「合并提示词」+ 每卡一个。
- 设置：通用 / 规则 / API / TextGenerate / llama / 路径 六个页签；扫描目录、选中模型、自定义厂商全局持久化。
- 面板头部按钮：总体编辑 / 设置 / 卡片管理 / ＋ 新增提示词卡片。

#### 优化 / 默认 / 卡片 / 总体编辑：行为规则

> 两层滑块：**卡片**弹窗里的「默认 / 优化」只管那张卡的输出端口；**总体编辑**里的管「合并提示词」端口。两层的优化内容各自成槽位，互不覆盖。

**一、工具优化**

- 卡片弹窗「工具 → 优化提示词」：源**固定取该卡「默认」页签**，结果写入该卡「优化」槽并把滑块切到优化，默认正文不动。
- 总体编辑「工具 → 优化提示词」：源 = 各卡**「默认」正文**按顺序用「卡片合并分隔符号」拼成一份（「合」灰卡、空卡不占位），**单次调用**；结果写进「整体优化结果」并把总编辑滑块切到优化，原卡内容不变。
- 两处遵守同一张表（有/无 → 填充/覆盖）：

| 滑块 | 默认 | 优化 | 行为 |
|---|---|---|---|
| 默认 / 优化 | 有 | 无 | 使用默认提示词进行优化 → 填满优化槽，滑块切到优化 |
| 默认 / 优化 | 有 | 有 | 使用默认提示词进行优化 → **覆盖**优化槽（不沿用手改过的优化） |
| 任意 | 空 | 有 / 无 | 弹「当前卡片没有可优化的提示词内容。」 |

**二、运行时优化—— 三个自动优化开关任一开**

> 自动优化失败（API / TextGenerate / llama 报错）**直接报红停止**。优化槽位是"记忆"：有内容就**不重复调用**，空才调用。

*总体层 → 「合并提示词」*（源 = 合=绿卡的**默认**正文合并，按卡片合并分隔符号）

| 总编辑滑块 | 默认 | 优化 | 行为 |
|---|---|---|---|
| 任意 | 有 | 无 | 先整体优化一次 → 写进「整体优化结果」→ 滑块切优化 → 输出它 |
| 优化 | 有/空 | 有 | 直接输出「整体优化结果」（**不重复优化**），滑块不动 |
| 默认 | 有 | 有 | 输出**默认合并**（优化版存着不用，也不优化），滑块不动 |
| 默认 | 空 | 有 | 输出「整体优化结果」，滑块切到优化 |
| 任意 | 空 | 空 | 输出空（用户自己没写），滑块不动 |

*各卡片 → 「卡片 i」端口*

- **「合」为绿**（进合并）：运行期**不单独优化**，严格按该卡滑块输出 —— 默认就输出默认、优化就输出优化；**指到空槽就输出空**（不回落）。卡片列表标记跟随滑块（「优」/「默」）。
- **「合」为灰**（不进合并）：运行期**按需单独优化**（结果只进它自己的端口）：

| 滑块 | 默认 | 优化 | 卡片端口 |
|---|---|---|---|
| 任意 | 有 | 无 | 拿默认单独优化一次 → 填满该卡优化槽 → 端口=结果，滑块切优化 |
| 默认 | 有 | 有 | 端口=默认（优化版存着不用，也不优化），滑块不动 |
| 优化 | 有 | 有 | 端口=优化版（不重复优化），滑块不动 |
| 任意 | 空 | 有 | 端口=优化版（不重复优化）；滑块在默认则切到优化 |
| 任意 | 空 | 空 | 端口=空，滑块不动 |

- 端口数量 = 卡片数 + 1（第 0 口「合并提示词」，其后「卡片 1..N」全是 STRING）；卡片增删/排序后端口跟着变。
- `card_in_i` 连了外部文本时覆盖该卡（面板上该卡置灰），也用它参与合并与优化。

**三、三个开关全关**（不做任何优化调用，与上面同一套"严格按滑块、空就空"规则）

- **总体编辑**：滑块在**默认** → 输出**默认合并**（各卡默认正文，按「合」过滤，灰卡不并）；在**优化** → 输出「整体优化结果」。空就空，不回落、不补齐。
- **各卡片**（「合」绿、「合」灰同一套）：默认 → 该卡默认正文；优化 → 该卡优化内容；空就空。
- 卡片滑块**不影响**「合并提示词」—— 合并口只取各卡的默认正文（这也是卡片优化内容只走"自己那个端口"的原因）。

**四、规范编译（引用媒体）在哪一步**

- 送去 API / TextGenerate / llama 的正文 = **未编译的原文**（就是你写的 `@图片1` / `@视频1` / `@音频1`）；系统提示明确要求模型**原样保留**这些标记（不翻译、不改写、不重新编号）。
- 两个优化槽位（该卡「优化提示词」/「整体优化结果」）里存的也是**模型原文**（未编译）—— 换个规范还能重新编，不会丢掉映射。
- **只有输出口才过规范编译**：`卡片 i` 端口，以及「合并提示词」用到的默认合并 / 整体优化内容；编译是幂等的。
- 模型**保留了** `@图片1` → 输出自动变成该规范写法（如 `<Picture 1>`）；模型把它**翻译/改写成自然语言**（"第一张图"）→ 标记没了，任何编译都救不回来（只能靠系统提示降低概率，或换更守规矩的模型）。

### 素材加载器（`EzFlex-MediaLoader`）：

- 预设：可保存删除分组及卡片组状态和名称。
- 参数：每行卡片数量、卡片高度倍数（默认 1）。
- 分组 / 卡片组 / 媒体卡片：拖拽排序、双击改名、右键菜单、长按拖拽合并、悬停信息、点击预览、删除。
- 浏览：文件资源管理器式（目录树、后退/前进/上级/刷新、手动路径输入、搜索、批量选择）。
- 输出：每张卡片一个端口，类型是专属的 EZFLEX_MEDIA_CARD（深红）—— 传的是「卡片对象」而不是媒体值，所以只能接 EzFlex-MediaOut（这样挡住误连内置节点）；要真正的媒体值请接 MediaOut。
- 可加载类型：图片 / 视频 / 音频 / 3D 模型 / 文本 / 其它，输出值与 ComfyUI 内置加载节点同款，可直接接标准节点。
- 支持扩展名：图片 .png .jpg .jpeg .webp .gif .bmp .tif .tiff｜视频 .mp4 .webm .mov .mkv .avi .m4v｜音频 .mp3 .wav .flac .ogg .aac .m4a .opus .wma｜3D .obj .glb .gltf .fbx .stl .ply .3ds .dae .blend｜文本/其它 → STRING（文本给文件内容、其它给路径）。
- 顶栏「加载输出」：一键生成一个 EzFlex-MediaOut 并连好线。

### 素材输出（`EzFlex-MediaOut`）：

- 输入：单一输入（专属类型 `EZFLEX_MEDIA_CARD`），接 `EzFlex-MediaLoader` 的某张卡片端口。
- 输出：按文件真实类型着色/定型的中性端口 —— IMAGE / VIDEO / AUDIO / FILE_3D / STRING（与内置加载节点同款，可直接接标准节点）。
- 模式：拆分 / 卡片 / 卡片组 / 分组（面板顶部按钮切换）；拆分 → 逐文件独立端口，卡片 / 卡片组 / 分组 → 按结构合并成一个端口。
- 合并：多图 → 批量张量 `[B,H,W,C]`（可接任何 IMAGE 输入，也能用内置 `ImageFromBatch` / `RebatchImages` 拆开）；多音频 → 按时间拼成一条音轨（采样率需一致，单声道自动升多声道）；多文本 → 换行拼接；类型混用 / 采样率不一致 → 报错并提示改用「拆分」（端口退化为 `*`，悬停标签带 `×N` 表示含几个文件）。
- 批量设置（卡片 / 卡片组 / 分组 模式下显示，对齐 KJNodes `Load Images From Folder`）：目标尺寸 `以第一张为准` / `指定尺寸`、适配方式 `等比裁剪` / `等比补边` / `拉伸`、`最多取几张`（0=全部）、`从第几张开始`（0 起）；尺寸 / 通道不一致时先按规则对齐再合并（控制台打印用了哪档规则）。
- 开关：可单开/单关；拆分模式下禁用保留端口并输出 `None`（重启用不用重连），其余模式禁用即从分组剔除。
- 翻页：翻页功能。


## 目录结构

```
Comfyui-EzFlex-Presets/
├── __init__.py          # 全部 11 节点类 + 预设路由 + 输出类型同步路由
├── pyproject.toml
├── README.md
├── user_data/           # 预设库（运行时由插件写入）：EzFlex-ModelsCombo.json / EzFlex-FreeLatent.json /
│                        #   EzFlex-NodeSwitchMaster.json / EzFlex-NodeSwitchGroup.json /
│                        #   EzFlex-MainControl.json / EzFlex-ParamPresetControl.json
│                        # 说明：这些由服务器预设路由运行期生成；你机器上若还有 EzFlex-PreviewAny.json 等，
│                        #   属本地运行产生，不是插件自带/固定的文件。
└── web/
    ├── modelscombo_node.js  # ModelsCombo 内嵌控件（addDOMWidget）
    ├── freelatent_node.js   # FreeLatent 内嵌 canvas 分辨率选择器
    ├── ezflex_service.js    # 共享：节点注册表 / 分组匹配 / node.mode / 预设库 API / 命名弹窗
    ├── node_switch_group.js # NodeSwitchGroup 面板
    ├── node_switch_master.js# NodeSwitchMaster 面板
    ├── main_control.js      # MainControl 面板
    ├── param_preset_control.js # ParamPresetControl 面板 + 动态端口
    ├── param_preset_output.js  # ParamPresetOutput 面板 + 动态端口
    ├── preview_any.js          # PreviewAny 白板 + 拖拽卡片 + 动态 socket + 预览
    ├── prompt_helper.js        # PromptHelper 提示词助手面板（开发中）
    ├── media_loader.js         # MediaLoader 素材加载器面板（分组/卡片/媒体/预览/预设 + 动态端口）
    ├── media_out.js            # MediaOut 素材输出面板（文件列表 + 启用开关 + 按真实类型着色端口）
    ├── ezflex_media_index.js   # 媒体编号引擎（扫描生成节点媒体输入端口 → 图片N/视频N/音频N + <Picture N>）
    └── libs/ utils/ curves/    # three.js 与加载器/曲线资源（本地离线，供 PreviewAny 3D 查看器用）
```

## 依赖
- **ComfyUI 自带**（列出来只为说明用途，不用单独装）：`torch`、`numpy`、`Pillow`、`safetensors`、`av`
- **本插件额外需要**：`mutagen>=1.46.0`（音频/视频标签与容器元数据）
- **可选增强**：`llama-cpp-python` —— 提示词助手的「设置·llama设置 → 进程内（llama-cpp-python）」模式要用（改用「llama.cpp 服务器(HTTP)」模式则不需要；本机验证过 0.3.46）
- **可选增强**：`gguf`、`onnx` —— 只在读这两种模型文件时用到，缺了会跳过该文件的「模型元数据卡」，不报错
- **外部可选**：`ffprobe`（探测到就用它取视频/音频容器信息，没有则只走同名 sidecar JSON 兜底）

