# Comfyui-EzFlex-Presets（V1.0 稳定版）
用于comfyui的灵活组合插件，使用ai构建完成，包括这个ReadMe，目前插件还在更新完善中。

EzFlex 插件套件：模型组合加载器（`EzFlex-ModelsCombo`）+ 分辨率/Latent 选择器（`EzFlex-FreeLatent`）
+ 控制/参数预设节点（`NodeSwitchGroup` / `NodeSwitchMaster` / `MainControl` / `ParamPresetControl` / `ParamPresetOutput`）
+ 任意预览（`EzFlex-PreviewAny`），共 **8 个节点**，都在 ComfyUI 前端里用可视化面板配置，再通过节点真实加载/生成/控制。
下一步即将构建多媒体加载器、提示词助手、代码编辑器。

> 版本：`__version__="1.0.0"`、`pyproject.toml version="1.0.0"`。此前 1.4/1.6 等均为测试版/RC，现终定为 V1.0。
> 依赖：`mutagen>=1.46.0`（音频/视频标签读取）；`ffprobe`（外部可选，装则读视频容器标签）。

## 安装

把本目录放到 `ComfyUI/custom_nodes/` 下，重启 ComfyUI（如用 ComfyUI-Manager 会按 `pyproject.toml` 自动装 `mutagen`）。

## 使用

**节点内嵌控件（主界面，参考 comfyui-aaalice-nodes 的 addDOMWidget 做法）**

把 `EzFlex-ModelsCombo` 节点加到画布上，配置器控件会直接显示**在节点内部**：
- 顶部工具条：`+ 添加加载器`（Checkpoint/UNET/CLIP/VAE/LoRA）、`复制配置`
- 每个加载器一行：类型 / 名称 / 文件 / 额外参数（device、weight_dtype、clip type、LoRA 强度、LoRA 目标）
- 底部显示输出端口统计（MODEL / CLIP / VAE 数量）

改动会**实时写入节点的 `config` 输入框**（该输入进 prompt、驱动 Python 加载），
所以无需手动粘贴、无需刷新，也**不存在页面缓存旧版的问题**（控件由前端 JS 运行时生成）。

**全屏编辑器（可选）**

左侧边栏的「模型组合」按钮会打开一个独立的全屏配置页（支持拖拽排序、预设保存/加载），
改动同样写回同一份 `config` JSON，两处互通。
（页面通过 `modelscombo.html` 托管，已加 `no-store`，但更推荐直接用节点内嵌控件。）

## 节点

`EzFlex-ModelsCombo`（类别 `EzFlex`，类名 `ModelsComboLoader`）

- 输入：`config`（STRING，配置器页面生成的 JSON 数组，隐藏，由内嵌面板驱动）
- 输出：`MODEL 1..N`、`CLIP 1..N`、`VAE 1..N`（每种类型最多 32 个端口，
  与配置按主加载器出现顺序一一对应；未用端口返回 None）
- 面板背景为白色/淡灰卡片（与其它 EzFlex 节点统一）；**预设下拉「选中即生效」**（无需点「加载」按钮，
  按钮已移除），选到占位则清空内部。

`EzFlex-FreeLatent`（类别 `EzFlex`，类名 `FreeLatentNode`）

- 输入：`config`（STRING，socketless 隐藏，由 canvas 面板驱动的 JSON）；`width` / `height` / `batch_size`（INT 可连接 socket，接入>0 时覆盖面板值）
- 输出：`Latent`（`[batch, 4, h/8, w/8]`）、`Width`、`Height`、`Batch`（INT）

### 配置 JSON 结构

```json
[
  { "id": 1, "type": "checkpoint", "name": "主模型", "file": "xx.safetensors",
    "extra": { "weight_dtype": "fp16" }, "targetId": null },
  { "id": 2, "type": "unet", "name": "FP16 UNET", "file": "xx.safetensors",
    "extra": { "device": "default", "weight_dtype": "fp8_e4m3fn" }, "targetId": null },
  { "id": 3, "type": "lora", "name": "细节", "file": "lora.safetensors",
    "extra": { "strength_model": 1.0, "strength_clip": 1.0 }, "targetId": 1 }
]
```

- `type`：checkpoint / unet / clip / vae / lora
- checkpoint 同时产出 MODEL + CLIP + VAE 三个端口
- LoRA 通过 `targetId` 作用于目标主加载器的 MODEL/CLIP

### 参数映射（与内置节点一致）

| type       | 加载函数                          | 参数                          |
|------------|-----------------------------------|-------------------------------|
| checkpoint | `comfy.sd.load_checkpoint_guess_config` | weight_dtype, device     |
| unet       | `comfy.sd.load_diffusion_model`   | weight_dtype, device          |
| clip       | `comfy.sd.load_clip`              | type（CLIPLoader 同款列表）, device |
| vae        | `comfy.sd.VAE`                    | weight_dtype(fp16/bf16/fp32), device |
| lora       | `comfy.sd.load_lora_for_models`   | strength_model, strength_clip |

## 目录结构

```
Comfyui-EzFlex-Presets/
├── __init__.py          # 全部 7 节点类 + 预设路由 + 输出类型同步路由
├── pyproject.toml
├── README.md
├── user_data/           # 每节点一个预设库：EzFlex-ModelsCombo.json / EzFlex-FreeLatent.json /
│                        #   EzFlex-NodeSwitchMaster.json / EzFlex-MainControl.json /
│                        #   EzFlex-ParamPresetControl.json（NodeSwitchGroup 预设按实例存 config）
└── web/
    ├── modelscombo_node.js  # ModelsCombo 内嵌控件（addDOMWidget）
    ├── modelscombo.js       # 全屏编辑器（可选）侧边栏按钮 + 命令
    ├── modelscombo.html     # 全屏配置器页面（可选）
    ├── freelatent_node.js   # FreeLatent 内嵌 canvas 分辨率选择器
    ├── ezflex_service.js    # 共享：节点注册表 / 分组匹配 / node.mode / 预设库 API / 命名弹窗
    ├── node_switch_group.js # NodeSwitchGroup 面板
    ├── node_switch_master.js# NodeSwitchMaster 面板
    ├── main_control.js      # MainControl 面板
    ├── param_preset_control.js # ParamPresetControl 面板 + 动态端口
    ├── param_preset_output.js  # ParamPresetOutput 面板 + 动态端口
    └── preview_any.js          # PreviewAny 白板 + 拖拽卡片 + 动态 socket + 预览
```
> 废弃的 `freeswitch_node.js`（旧 FreeSwitch 拆分占位）已删除。

## EzFlex-FreeLatent（分辨率选择器）

`EzFlex-FreeLatent`（类别 `EzFlex`）在节点内嵌一个 canvas 可视化面板，用于自由选择 Latent 尺寸：

- **拖拽画布**：右下角/右缘/下缘手柄（Pointer Events）拖动宽高（Shift 保持比例，Ctrl 关闭 8 的倍数对齐）；输入 socket 稳定可连接，端口名用黑框标签（Latent/Width/Height/Batch）
- **顶部工具条**：最大限制边（1024/2048/4096/8192/自定义）、批次数量、宽高交换（上下错开箭头，干净 W↔H 互换）、算法切换（优=比例优先 / 标=标准四舍五入）
- **控制行**：宽度 / 高度 / 对齐倍数 / MP（百万像素）/ 比例下拉（含自定义比例）
- **预设**：下拉保存/加载/删除，保存弹自绘命名输入框，存到 `user_data/EzFlex-FreeLatent.json`（首启自动写入 14 个默认分辨率）
- **自定义比例**：预设行末 `[宽]:[高]` + 保存/删除，存到同一 json 的 `customRatios` 键（`/freelatent/presets/custom_ratios`）
- **输出**：`Latent`（`[batch, 4, h/8, w/8]`）+ `Width` / `Height` / `Batch`（INT）

配置由节点内 `config` 输入框（隐藏）承载，进 prompt 驱动 `FreeLatentNode` 创建 Latent，与 `ModelsComboLoader` 同一套每节点单文件预设机制。

## 控制/参数预设五节点（V1.2 稳定版，类别 `EzFlex`）

控制链：`EzFlex-MainControl` → `EzFlex-NodeSwitchMaster` → `EzFlex-NodeSwitchGroup` → 画布节点 mode（0/2/4）；
`EzFlex-ParamPresetControl` →（连线）→ `EzFlex-ParamPresetOutput`。

### `EzFlex-NodeSwitchGroup`（分组预设）
- **rgthree 式自动发现**：自动扫描工作流中的 ComfyUI 分组（Ctrl+G 建的组），按节点级
  `匹配颜色 / 匹配标题 / 子工作流生效 / 排序` 过滤后自动成行（无需手动加开关）。
- 每行 = 一个画布分组，3 态（开启/禁用/绕过）滑块一键给该分组内节点设 `node.mode` 0/2/4。
- 分组预设：全部开启/全部禁用/全部绕过（映射所有匹配分组）+ 自定义快照（**按实例存本节点 config**，
  多个 Group 节点同名预设、匹配条件不同也互不影响）。

### `EzFlex-NodeSwitchMaster`（节点控制总预设）
- 行 = 画布上的 NodeSwitchGroup 实例；总预设 = {分组节点 → 某分组预设} 映射；切换总预设时
  级联写入各分组节点的 config 并应用开关。命名总预设存 `user_data/EzFlex-NodeSwitchMaster.json`。

### `EzFlex-MainControl`（总控制节点）
- 行 = 画布上的 ModelsCombo + FreeLatent + NodeSwitchMaster + ParamPresetControl 实例（卡片可拖拽排序）；
  总预设 = {目标节点 → 该节点预设} 映射，一键级联下推。命名总预设存 `user_data/EzFlex-MainControl.json`；
  左上角预设只保留 `default` + 命名总预设（无“全部开启/禁用/绕过”基础项）。
- 顶栏可「加载单个节点 / 加载全部」（6 节点 2 列排布），便于搭控制网。

### `EzFlex-ParamPresetControl`（参数预设控制）
- 面板：预设下拉（default + 命名预设）/ 保存/删除/重置，参数组列表（**指针拖拽排序**），编辑弹窗
  （参数增删、拖拽排序、名称/类型/值）。
- **动态输出端口 = 参数组数 1:1**（类型 `EZFLEX_PARAM_GROUP`，携带组数据）；分组增删/排序/改名后
  端口与连接跟随（同 ModelsCombo 机制：复用 socket、重排、更新 link origin_slot、同步类 RETURN_TYPES）。
- 命名预设存 `user_data/EzFlex-ParamPresetControl.json`。

### `EzFlex-ParamPresetOutput`（参数预设输出）
- 输入 = 一个分组端口（从 ParamPresetControl 对应分组端口连线）；面板显示参数名/类型/值 + 开启/禁用。
- **动态输出端口 = 参数数 1:1**，按参数类型映射：int→INT、float→FLOAT、string→STRING、bool→BOOLEAN、
  复杂类型（complex/tuple/list/set/dictionary）→ STRING；**禁用参数端口保留、输出该类型中性默认值**
  （int→0 / float→0.0 / bool→False / 其余→""），重新开启无需重接线。
- 参数增删/排序/类型变化/连接变化后输出端口与连接跟随。

### `EzFlex-PreviewAny`（任意预览）
- **`OUTPUT_NODE=True`**（可作为输出节点被触发执行）；输入为 `input_1..N`(ANY) 固定槽，**每连一个输入自动增加一个槽/卡片**（已连接 + 1 空槽），卡片**可拖拽排序**，顺序即 socket 顺序（复用 socket、重排、更新 target_slot/origin_slot）。
- 顶部只有两个控件：**存档开关**（绿=自动保存 / 浅阴影=不保存）与**保存位置**（弹窗选择，默认 ComfyUI 输出目录）；无预设。
- 卡片尾部有**浅色文件夹图标**，点击在系统文件管理器中打开已保存文件并选中它。
- 输入任意类型自动解析：文本/数字/信息类正常显示、过长点开弹文本框；IMAGE 走 base64 内联预览放大；VIDEO 取首帧 + 帧数；AUDIO 转 WAV 可播放；MODEL/CLIP/VAE 显示文件名并尽量读取元数据（safetensors/gguf/onnx，缺失依赖降级）。
- 3D 模型旋转/缩放等大媒体侧栏播放为后续扩展。

## V1.0 稳定版新增

### ModelsCombo「⧉ 浏览」批量添加
- 工具栏「添加加载器」与「预设名」之间新增「⧉ 浏览」按钮，打开**全屏模型浏览器**，读取 LoraManager 生成的 `<模型名>.metadata.json` + 同目录预览图。
- 支持 checkpoint / unet / lora 三种可映射类型（embeddings 跳过）；顶部标签栏分离「全部 / Checkpoint / UNET / LoRA」。
- 左侧文件夹树（LoraManager 风格 SVG 图标、点文件夹名任意处即展开/收起并选中、递归开启即展开全部、树/列表切换、全部折叠、隐藏/展开侧栏同一行）。
- 卡片：左上角「类型+架构缩写」、右上角半透明「+ / −」按钮（添加/移除对应加载器）、底部毛玻璃只显示 标题+版本号；点卡片弹详情子窗。
- 后端：`/models_combo/lora_meta`（列表）、`/models_combo/lora_meta_detail`（单个）、预览复用 `/models_combo/preview`。

### PreviewAny「生成信息」
- 图片/视频/3D/音频等任意预览卡片，能读取到元数据时右上角出现「生成信息」。
- 读取链：①PIL 内嵌文本块（PNG/WEBP/动画 webp）→ ②同名 sidecar JSON/txt → ③容器内嵌元数据（GLB/glTF asset/extras、视频 ffprobe、音频 mutagen）。
- 若文件本身不带元数据，会从**当前工作流**（`extra_pnginfo['workflow']`）兜底提取用的模型/提示词/采样参数；对从文件加载的媒体不会用当前工作流参数冒充（有守卫）。
- MODEL/CLIP/VAE 卡片继续走「模型自身元数据」（架构/触发词/训练参数等）。

### 依赖
- `mutagen>=1.46.0`：音频/视频标签读取；`ffprobe`：外部可选，视频容器标签。
- **Python 改动需重启 ComfyUI**；前端 JS no-store，刷新（Ctrl+F5）即生效。
