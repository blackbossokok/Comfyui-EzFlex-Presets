# Comfyui-EzFlex-Presets（V1.04 稳定版）

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

- V1.04：新增素材加载器( `EzFlex-MediaLoader`）与素材输出 (`EzFlex-MediaOut`）节点；全面优化提示词助手（`EzFlex-PromptHelper`）（仍在更新开发中）。
- V1.03：优化ReadMe描述，FreeLatent增加强制生效按键（忽略外部输入宽高及批次），修复对齐后端默认按照8对齐的问题，新增提示词助手节点。
- V1.02：优化ModelsCombo画廊浏览搜索逻辑。
- V1.01：优化参数预设控制节点切换预设连线逻辑。
- V1.0：稳定发行第一版。

## 安装

把本目录放到 `ComfyUI/custom_nodes/` 下，重启 ComfyUI。

## 使用

Comfyui节点列表中搜索EzFlex点击选择使用。

## 节点功能

### 总控制节点( `MainControl`）：

- 控制：控制总体节点行为，目前可控节点：模型组合加载器（`EzFlex-ModelsCombo`)、分辨率/Latent 选择器（`EzFlex-FreeLatent`）、节点总控制(`NodeSwitchMaster`)、参数预设控制节点（`ParamPresetControl`）。
- 预设：可自由组合保存删除总体节点行为预设。
- 快捷加载：可快捷加载其他EzFlex节点。

### 模型组合加载器（`EzFlex-ModelsCombo`)：

- 组合加载：可自由组合加载Unet、Clip、Vae、Checkpoint、Lora模型。
- 预设：可自由组合保存删除模型加载方式。
- 预览：可预览下拉列表模型封面。
- 画廊：可画廊式预览选择加载模型。
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
| VIDEO | 帧列表 或 VideoFrom 文件对象 | 首帧封面 + 播放器 | MP4 / WebM / MOV / GIF / AVI / MKV |
| CONDITIONING | 含 `conditioning/context` 的 dict | 文本摘要 | — |
| LIST / TUPLE / SET | list / tuple / set | 索引值树（序号:值） | JSON |
| DICT | dict | 键值树（键:值） | JSON |
| STRING | str | 文本（截断 + 弹窗全文） | TXT / MD / JSON / CSV / LOG / HTML |
| LATENT | `{samples}` dict | shape / dtype 摘要 | — |
| MODEL_3D | File3D 对象（含 path/file） | three.js 查看器（离线） | glb / gltf / obj / fbx / stl / dae / ply |
| MODEL | ModelPatcher | 模型元数据卡 | safetensors / gguf / onnx / ckpt / pt |
| CLIP | comfy.sd CLIP | 元数据卡 | safetensors / gguf / onnx |
| VAE | comfy.sd VAE | 元数据卡 | safetensors / gguf / onnx |
| CONTROL_NET / CLIP_VISION / STYLE_MODEL / UPSCALE_MODEL / LORA_MODEL / GLIGEN / SAMPLER / SIGMAS / GUIDER / NOISE / SEGS | 对应 ComfyUI 对象 | 文本摘要 | — |
| EMPTY | 未连接 | “(未连接)” | — |

- 预览方式：数据预览弹窗/生成信息。

### 提示词助手（`EzFlex-PromptHelper`）：

- 工具：提示词卡片管理 + 完整富文本编辑器（加粗/斜体/颜色/字号/Word 同款对齐图标/查找替换/取色器/规则弹窗）+ **「调用设置」弹窗**（①模型厂商（参照 Chatbox：OpenAI/DeepSeek/Gemini/Claude/SiliconFlow/OpenRouter/Ollama/Qwen/Kimi，含 API 主机预填 + 密钥 + 授权提示）、②内置 TextGenerate 参数、③llama-cpp 参数树状展开）+ 编辑工具条上的 **skill 下拉**（从 `models/skills` 读取 `*.md`，优化时一并上传）。
- 优化：工具下拉「优化提示词 (API) / (TextGenerate) / (llama)」；API 走 OpenAI 兼容（Claude 走 Anthropic messages、Ollama 免密钥），llama 支持**进程内 llama-cpp-python**（填 GGUF 模型路径）或 **llama.cpp 服务器**（`/prompt_helper/optimize`），TextGenerate 用已连接 **text-gen CLIP**（Gemma/Qwen3-VL/flux2 等，普通稳定扩散 CLIP 无 `generate` 会报清晰错误）在执行期生成（勾选「运行期自动生成」）。优化结果写入卡片「优化提示词」页签，可用卡片页脚「默认/优化提示词」切换合并输出。
- 输入：固定 `clip`(CLIP) + 动态「综合媒体」端口（红色 ANY，可接 图像/视频/音频/3D 模型 等任意媒体，连接后自动补一个空槽）+ 每卡一个文本输入端口（按顺序链接到卡片；某卡输入口被连接后对应卡片变灰）。
- 输出：固定「合并提示词」字符串 + 每卡一个字符串输出端口。
- 端口标签：输入/输出端口均带**半透明黑框标签**，随画布缩放；`媒体*` 圆点标识红色；卡片标题输入即实时刷新标签。缩进支持**首行缩进**（Word 式）。点击卡片弹窗外空白自动关闭并保存。
- 状态：V1.03 起列入节点清单；`MediaLoader/MediaOut` 定版后，**当前进入下一阶段：优化 `EzFlex-PromptHelper`**（富文本/优化/媒体引用已基本可用，继续打磨交互、多模态与稳定性）。

### 素材加载器（`EzFlex-MediaLoader`）：

- 预设：可保存删除分组及卡片组状态和名称。
- 参数：控制每行卡片数量、卡片高度（倍数，默认 1）。
- 分组：长按拖拽排序、双击改名、右键菜单、删除。
- 卡片组：拖手可拖拽排序、卡片标题可双击改名、右键菜单、删除，
- 媒体卡片：长按拖拽快速合并、右键菜单、悬停信息、点击弹窗预览、删除。
- 浏览（文件资源管理器式）：目录树、批量选择加载；顶栏 = 手动路径输入(回车跳转) + 后退/前进/上级/刷新 + 搜索；**右上角红色关闭**。
- 输出：按卡片数量（所有分组）生成对应端口；顶栏「加载输出」可一键生成一个 `EzFlex-MediaOut`。
- 可加载类型：
  - **图片**：`.png .jpg .jpeg .webp .gif .bmp .tif .tiff` → IMAGE
  - **视频**：`.mp4 .webm .mov .mkv .avi .m4v` → VIDEO（帧列表）
  - **音频**：`.mp3 .wav .flac .ogg .aac .m4a .opus .wma` → AUDIO（waveform）
  - **3D 模型**：`.obj .glb .gltf .fbx .stl .ply .3ds .dae .blend` → MODEL_3D
  - **文本**：`.txt .md .json .csv .log .py .js .jsx .ts .tsx .html .css .xml .yaml .yml .ini .cfg .sh .bat .toml .srt .ass .vtt` → STRING（返回**文件内容**）
  - **其它** → STRING（返回路径；压缩包 `.zip/.rar/.7z` 与 `.pmx` 模型**暂不解析**）

### 素材输出（`EzFlex-MediaOut`）：

- 输入：单一输入，连接 `EzFlex-MediaLoader` 。
- 模式：拆分 / 卡片 / 卡片组 / 分组（面板顶部按钮切换），拆分->逐文件独立端口，卡片/卡片组/分组->按结构合并。
- 开关：可单开/单关，禁用时保留端口、输出 `None`（重启用不用重连）。
- 翻页：翻页功能。


> 下一阶段：**优化 `EzFlex-PromptHelper`（提示词助手）**。


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
    └── libs/ utils/ curves/    # three.js 与加载器/曲线资源（本地离线，供 PreviewAny 3D 查看器用）
```

## 依赖
- torch
- numpy
- Pillow
- safetensors
- gguf
- onnx
- av
- mutagen>=1.46.0

