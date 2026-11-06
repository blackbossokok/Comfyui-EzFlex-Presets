# EzFlex 项目进展 / 交接文档

> 硬数据、少闲聊。改代码前先看「关键契约」和「避坑」；排期看「待办」。
> **当前 V1.3.0 正式版**（`__version__` / `pyproject.toml` 均为 `1.3.0`，版本号按用户要求保持不动）。
> 生效方式：Python / 路由改动 → 完整重启 ComfyUI；前端 JS → `Ctrl+F5`。
> 经典模式与 Nodes 2.0（Vue）**分开写作用域**（`.ezfx-is-vue` / `:not(.ezfx-is-vue)`）；改一种前先确认另一种不受影响。

## 变更记录 2026-11-06（本轮）

**长视频接续：冻结模式（masked）正式可用**

| 项目 | 结论 |
|---|---|
| 冻结为什么之前无效 | latent 走了「自定义采样器」子图，重建 latent 时 `noise_mask` 被丢掉 → 直连 `SamplerCustomAdvanced` 即恢复 |
| 冻结 vs 条件性能 | 无冻结 25.96 s/it；冻结 22 帧 **455.92 s/it（约 17.6×）**；原因是 masking 让视频行变成**逐行时间步**，走慢路径 |
| 音频窗口 | `masked` 强制 `audio tick = 视频帧数折算`（22→37 tick、39→65 tick）；`keyframe` 仍可用 22↔24 |
| 尾部冻结 | `pin_next_head` 现在两种模式都生效：`keyframe` 加尾部 keyframe，`masked` 写尾部行 + `mask=0`；只在重跑且 `timeplan.nextRef` 存在时触发 |
| 参考帧裁剪 | LoopStart 的 `frames` 卡会把**回喂的整段**裁到最后 N 帧（视频/音频原样透传）；H3 参考视频只认 17k+5，非网格会向下裁（10→5）、<5 报错 |

**落盘格式对齐 ComfyUI**

- LoopEnd「其他」：LATENT → `.latent`（核心 `latent_tensor`）、单条目 CONDITIONING → `.safetensors`、MESH → `.glb`、AUDIO → `.wav`、VIDEO → `.mp4`、文本 → `.txt`、其它张量 → `.pt`；
- resume / `nextRef` 同时认 `.latent` 与 `.pt`（`.latent` 是 safetensors 内容，必须用 `safetensors.torch.load_file` 读，不能走 `comfy.utils.load_torch_file`）；
- PreviewAny 同步补：LATENT / CONDITIONING / MESH 落盘，JPEG/WebP 写 EXIF/XMP 元数据。

**面板与类型简化**

- LoopEnd 保存卡：`帧序列` / `其他`（非帧值自动按「其他」存，不再静默丢弃）；卡片带序号，端口黑框 `#K`；
- LoopStart 参考卡：角色（上一段/本段/下一段）+ 类型（帧序列 / 视频 / 音频 / latent）；正常跑不看卡片；
- TimePlan：视频上下文 ↔ 过渡音频联动（`ceil(n/3)*3`），钉头/钉尾共用同一个 `n`（`tolerance` 只裁不钉）。

**PromptHelper 标签补全三处修复**

| 症状 | 根因 | 修法 |
|---|---|---|
| 选完候选还留一半输入 | 60ms 防抖没在鼠标点选时冲刷 | `tgPick` 先 `_tgFlush()` |
| 组字提交把输入再插一遍 | 组字期间改 DOM | 记下待选，`compositionend` 后按标签名重放 |
| 残留查询 / 元素级光标不插入 | 单节点算长度、选区不在文本节点 | 跨文本节点删除 + 选区解析 + 首选 `execCommand('insertText')` |

**已知外部问题（非本插件）**

- 加速 LoRA 与本机 int8 模型不匹配：`adaln_proj.linear.weight shape '[96768, 8]' invalid`，每次运行约 400 条，LoRA 实际未生效且拖慢速度。

## 变更记录 2026-11-01（本轮）

**用户数据目录（`user/EzFlex/`）整理了一遍**

| 位置 | 内容 |
|---|---|
| `config/` | 12 个配置：`ezflex_roots / last_dir / model_paths / scan_paths / media_roots / media_target / api_hosts / custom_providers / prompt_tags / prompt_categories / prompt_rules / settings` |
| `presets/` | 各节点预设（`_preset_file()` → `user/EzFlex/presets/<节点>.json`，旧 `user_data/` 首次访问自动复制） |
| `prompts/` | 卡片/模板（`随机tag提示词模板.json` + 自动 `.bak`） |
| `taglib/` | 标签词库 17 个 CSV（从插件 `user_data/PromptHelperLib` **移动**，`_ph_migrate_dir`） |
| `logs/gen/` | 生成记录（原 `PromptHelperGen`，启动时迁移） |
| `card_preview/` `tag_preview/` | **保持顶层**：标签 JSON 里存相对路径 `tag_preview/xxx.webp`，搬进 `cache/` 会让已存预览图 404（已验证并回退） |
| `backup/` | 历史 `.bak` / `.migrate` / `.pre_migrate` 归档（代码不读，纯归档） |

插件目录下的 `user_data/` 已清空（预设已迁移、词库已移动、`settings.json` 为旧版残留）。

**根目录菜单（MediaLoader → 根目录按钮）**

- 三级结构：`默认（input/output）` → `各节点默认（6）` → `自定义（4，固定占位）`；**点击展开**，不再悬停；
- 节点分组顺序：模型目录优先（`ModelsCombo` / `ControlnetPreprocessor`），再判「已登记」；
- 路径项**不带分类前缀**，点击 = 跳转 + 填入顶部输入框（配合「保存根目录 / 删除根目录」）；
- PreviewAny 保存根优先归「自定义 → PreviewAny」（比较用 `norm()` 归一化，不依赖 `owner` 字段）；
- `_ml_roots()` 只返回**真实存在**的目录（幽灵项不再出现），并纳入 PreviewAny 保存根；
- 模型目录单一来源：`_ML_MODEL_DIRS = tuple(LOADER_FOLDERS.values()) + ["unet","clip","clip_vision","controlnet"]`；
- 注册表的 `owner` 字段已不写不读（前端下拉已删除）。

**后端修复**

| 位置 | 改动 |
|---|---|
| `_ml_roots()` | 过滤不存在目录；补 PreviewAny 保存根 |
| `_ml_roots_post` | 不再解析/写 `owner` |
| `parse_media_cards` | 坏 config 打 warning（不再静默 0 卡） |
| `ParamPresetOutputNode.run` | 字符串值按声明类型转换（`"0"`→int 0，端口保持 INT）；转不了才退回 string 并 warning |
| `ControlnetPreprocessor` 多卡片 | 少返回输出时补 None 的同时打 warning（指出卡片与端口名） |
| LoopEnd 队列续跑 | `client_id` 取 `PromptExecutor.extra_data`，进度归属发起端（`progress_state` 仍广播，属上游行为） |

**前端修复**

| 位置 | 改动 |
|---|---|
| `segment_panel.js` | `OUT_ORDER` 补 `video`；重排改为「按名单取 + 其余追加 + 数量校验」，不再整体替换丢端口 |
| `param_preset_control.js` | Esc 监听记录句柄，`onRemoved` 释放；只有当前弹窗所属节点响应 |
| `node_switch_group.js` | `scheduleOnRedraw` → `ezScheduleNodeRedraw(node, …)`（删节点自动注销，不再每帧刷错） |
| `ezflex_loop_picker.js` | Esc `stopImmediatePropagation`，只关选择器自己 |
| `media_loader.js` | config 解析失败标记 `_ezCfgBroken`，保存时拒绝覆盖并提示 |
| `preview_any.js` | 「保存位置」按钮文字固定（不再带目录名）；Nodes 2.0 面板下移让开标题 |

**测试基建**

- 新增 `scripts/app.js`、`scripts/api.js`、`_dev_tests/scripts/`、`_dev_tests/extensions/core/` 桩；
- `_dev_tests/_sync_ext.py`：把 `web/core` + `web/panels` 同步到测试目录（`*_mod.mjs` 不覆盖）；
- `import_test.mjs`：**24 通过 / 3 失败**（剩 3 个是 `registerExtension` 断言与桩接口不匹配）。

**已验证的教训**

- 两个 ComfyUI 实例共用同一个 `comfyui.db` 会导致页面卡死、切不了工作流（不是插件问题）；
- 面板尺寸：`computeSize` 一旦跟随 `node.size` 会与前端布局互相喂 → 无限增高，面板一律不写 `computeSize`；
- 经典模式下 DOM widget 容器按内容撑高，需要按节点高度夹 `max-height`（仅在该面板确有凸出问题时才加）。

## 0. 环境

| 项 | 值 |
|---|---|
| ComfyUI | 0.30.x；实跑前端以 ComfyUI 自带 `comfyui_frontend_package` 为准 |
| venv python | `<ComfyUI>\.venv\Scripts\python.exe` |
| 依赖 | 必装 `mutagen>=1.46.0`；可选 `llama-cpp-python` / `gguf` / `onnx` / 外部 `ffprobe` |
| 测试 | `_dev_tests/`（不入库，里面写死本机路径）；Python 只收 `*_test.py`，mjs 排除 `_analysis` / `_jsdom` / `_probe` / `_real_wf` |

## 1. 规模与文件

**23 个节点**，category 全为 `EzFlex`。Add-Node 顺序：

`MainControl → ModelsCombo → FreeLatent → NodeSwitchMaster → NodeSwitchGroup → ParamPresetControl → ParamPresetOutput → PreviewAny → PromptHelper → MediaLoader → MediaOut → MergeList → SplitList → Reroute → TimePlan → MotionContext → SplitVideo → SegmentPanel → TimeLine → VideoComponents → ControlnetPreprocessor → LoopStart → LoopEnd`

- 后端全部在 `__init__.py`；前端每个节点一个面板，共享 `ezflex_service.js` / `ezflex_i18n.js` / `ezflex_theme.js` / `ezflex_media_index.js` / `ezflex_listview.js`。
- `__init__.py` 的 `NODE_CLASS_MAPPINGS` 与 `web/ezflex_service.js` 的 `NODE_TYPES` **必须一致**；`node_contract_test.py` 钉住节点契约。
- 控制类（MainControl / NodeSwitchMaster / NodeSwitchGroup）纯前端生效：Python 只承载 config，`run()` 返回 `()`，mode 由浏览器改并随工作流序列化。
- `web/**/*.js`（含 `core/`、`panels/`）由 `_serve_no_store` **递归**注册成 no-store（`os.walk`）；新增文件自动生效，不要再写手写名单。
- **前端目录**：`web/core/` = 共享模块（service / i18n / theme / listview / loop_picker / media_index / loop_nodes 的 `tl*` 工具）；`web/panels/` = 每个节点一个面板。面板引用共享模块写 `../core/xxx.js`，ComfyUI 自身模块写 `../../../scripts/app.js`。
- **3D 依赖放 `web_assets/3d/`，不放 `web/`**：ComfyUI 会把 `WEB_DIRECTORY` 下**所有** `.js` 递归当扩展自动 import（`server.py:428`），vendor 库留在 `web/` 等于每次开页面白拉 1.5 MB。前端只在打开 3D 预览时 `import('/preview_any/3d/libs/…')`，由 `_preview_any_static` 从 `web_assets/3d` 服务。`web/libs|curves|utils` 现在只剩 1 行占位注释，可随时物理删除。

## 2. 关键契约（勿回退）

- **媒体取值**：IMAGE `[B,H,W,3]` float32；VIDEO `VideoFromFile`；AUDIO `[1,C,T]` + `sample_rate`（可带 `path`，必须带 batch 维）；FILE_3D `Types.File3D`；MediaLoader 卡片 = `EZFLEX_MEDIA_CARD` dict（只给 MediaOut）。
- **`_ezItems`**：前端“媒体端口”约定，只有媒体口才写。写：MediaLoader（每口）、MediaOut（每口同时写 `_ezFiles`，同值）、MergeList、SplitList；读：MediaOut / MergeList / SplitList / TimeLine，编号引擎读 MediaOut 的 `_ezFiles`。纯数据口（INT/FLOAT/LATENT）不要盖。
- **端口盖章优先**：编号引擎 `readLoaderSlot` 先读 `sock._ezItems`，读不到才退回 config 的 `cards[slot]`。
- **动态输出**：统一用 `_DynamicOutputTypes`（越界槽返回 `*`）；口数由前端 POST `/xxx/outputs` 同步类的 `RETURN_TYPES/NAMES`。PromptHelper 例外：固定 33 个 STRING，运行期不收缩。
- **`ui` 契约**：每个键的值必须是列表（后端 `"k": [v]`，前端取 `[0]`）。
- **坐标换算用 canvas 元素**：`screen = (画布坐标 + ds.offset) * ds.scale`；不要用 rect 近似。
- **面板状态别占 config 输入口**：状态放 `node.properties`（随工作流序列化）或 config widget；config 被画成输入口时用 `stripCoreSockets` 每帧清。
- **动态端口五条**：链路就绪前不动端口 / 就绪前不上报空 schema / 守卫放在改 socket 之前 / 同布局原地更元数据 / 必须重排时先写新口再删旧口。

## 3. 各节点要点

### MainControl / NodeSwitchMaster / NodeSwitchGroup
- 纯前端；预设写服务端 `user_data`，工作流只存 config。
- NSG 分组发现基准 = 节点自己的图（`allGraphGroups(node.graph)`），扫描定时器按节点存；NSM 行 = 画布上的 NSG；MainControl 被控 4 类。
- 主题 16 套，集中在 `ezflex_theme.js`；语言 `ezflex.locale`。

### ModelsCombo
- 隐藏 config；输出 `MODEL/CLIP/VAE 1..32`（`MAX_PORTS_PER_TYPE=32`）+ 末尾 `trigger_words`。
- LoRA 按卡片顺序串联；`targetId` 为空则跳过；端口名 `自定义名称_类型`。
- 文件列表走内核 `/models/<folder>`，失败回落 `/models_combo/files?folder=`；加载器未载入时不重排端口。

### FreeLatent（V1 `INPUT_TYPES`）
- `config` + `width/height/batch_size`（>0 覆盖）；面板状态随 config 持久化。
- `force` 仅任一输入已连接时可切换；`align` 向 8 取整后，宽高必然是 8 的倍数。

### ParamPresetControl / ParamPresetOutput
- Control 输出 = 分组数 1:1（`EZFLEX_PARAM_GROUP`）；Output 输出 = 参数数 1:1。
- 禁用参数保留端口并输出中性值；socket 按 `_ezGroupId` → 位置 → 新建复用，不断连。
- 8 种参数类型：int / float / bool / string / complex / tuple / list / set / dictionary。

### PreviewAny
- `input_1..16`（ANY）+ 透传输出 + `OUTPUT_NODE=True`；类型判定按 `type(value).__module__ + __name__`。
- **文件直通**：文件型视频 / 音频不重新编码；生成信息链 PIL → sidecar → 容器（ffprobe/mutagen）→ 工作流兜底。
- 视频编码约束：`_VIDEO_CODECS_BY_FMT` / `_AUDIO_CODECS_BY_FMT` / `_FMTS_BY_VIDEO_CODEC` + `_video_combo_error` 前后端双重校验。
- HDR ↔ SDR 真实色调映射：`_hdr_tonemap_filter`（zscale，in/out 设 `tin:pin:min` + `p`/`m`）、`_tonemap_video_cli`、`_frames_tonemap_cli`；PyAV 颜色枚举是整数（trc 16/18、primaries 9）。
- copy 元数据：`_png_add_text`（PNG iTXt，不重编码）、`_remux_with_meta`（视频容器元数据）。
- 批次默认最多 256 帧（`_PREVIEW_MAX_BATCH`；batchMax=0 = 不限）；缩略图长边 1600；单条值截断 500。
- 存档只允许白名单后缀；绝对 savePath 只允许 output / 本机登记目录。

### PromptHelper
- 动态 `media_in_1..16` + `card_in_1..32`；固定 33 个 STRING 输出；卡片最多 32。
- 标签库 `user_data/PromptHelperLib/*.csv`（12 个，约 26 MB，随仓库走）；卡片预设 `user/EzFlex/prompts/<名称>.json`；标签数据 `ezflex_prompt_tags.json`。
- 循环模式（config `loopMode`）：末尾 `index` INT，第一个输出改名「循环输出」，只出第 index 张卡。
- 三个自动优化开关互斥，失败抛 ValueError；优化槽有内容不重复调用。
- HTML 一律 `ezSanitizeHtml()` 后 `innerHTML`；@ 芯片每次插一份，用 Range 插入。
- localStorage：`ezflex.apiKey.<provider>|<url>`、`ezflex.phDockMode`、`ezflex.tagCardSize`、`ezflex.tagPreviewFit`、`ezflex.tagLib`、`ezflex.randGroups`、`ezflex.cardMgr*` 等。

### MediaLoader / MediaOut
- Loader 输出 = list（按卡片 / 卡片组 / 分组 + 拼接）；Out 只拆分（`INPUT_IS_LIST=True`，一项一个真实类型口）。
- 固定模式：顶部「循环」按钮；`config.fixed:{on,current,slots:[{type,n}]}`；`_ml_fixed_items` 按槽位顺序排 Σn 个值（缺槽 None）；`_ml_fixed_segment(rows, index, slots, groups)` 按 index 取第 index 个卡片组（越界全 None）；固定与拼接互斥；MediaOut 自动跟随 `fixed.slots`。
- 槽位预设 `default` / `minimaxH3`（图片9/视频3/音频3）不可删；6 类：图片 / 视频 / 音频 / 文本 / 模型 / 其他。
- 上传上限 `_ML_UPLOAD_MAX = 4 GiB`（流式写盘）；`/media_loader/serve` 用 `private, no-cache`。
- 根目录白名单：默认 input / output；外部根需本机登记，拒绝整盘；`--listen 0.0.0.0` / 隧道 / 反代时注意暴露风险。

### MergeList / SplitList / Reroute
- MergeList N→1（16 口，`INPUT_IS_LIST=True`）；SplitList 1→N（16 口，至少 1 口）；Reroute 逐口 1:1 透传（32 口）。
- Reroute 口数由实例 `outputs` 决定，`route()` 不能固定返 `_EZ_REROUTE_MAX`；删口先断线再 splice。
- MergeList 顺序按画布从上到下（不是 input_N 数字）。

### TimePlan
- 输入：`model`（minimax_h3 / wan / ltx）、`total`、`segment`、`fps`、`overlap`、`tolerance`、`align`（align/strict）、`config`、`trim_tail`、`audio_context_length`、`grid_b`、`grid_s`、`max_frames`。
- 规划结果：`_tl_plan` 按帧网格（`B + S·k`）切段，段字段 `netStart / netDuration / dur / frames`；`segOverride`（1 基秒数）/ `segCount` / `customOn` 存 config。
- 三列面板：预设 / 保存 / 删除；对齐 / 自定义 / Max；总时长·每段·FPS；重叠·容差·尾裁；过渡音频·B·S。输入框内容居中，标签定宽 64，节点最小宽度 660。
- 自定义时长弹窗：内存态 `_eztpPlan` + config 镜像；加段 / 改时长立刻重算，`persistDraft` 防抖 220ms 落盘。
- `×` / 取消 = 回滚到打开时；保存 / 点弹窗外 = 保存并关。只在载入工作流 / undo-redo / 规划参数变化 / 外部写 config 时丢弃内存态。
- 所有写 widget / config 的路径同步 `properties.ezTp`（含 `total`、`config`），否则重载会被旧值盖回。
- 输出：`timeplan`（`EZFLEX_TIMEPLAN`）+ `frames`（INT）。
- TimePlan ↔ TimeLine 双向：TimeLine 拖段写 `segOverride`，TimePlan 改参数递归通知下游。

### MotionContext
- 输入：`positive`、`latent`、`context_length`（默认 22）、`context_audio_length`（默认 24）、`follow_plan`；可选 `context_latent`、`context_video_latent`、`context_audio_latent`、`timeplan`。
- 把上一段 AV latent 尾部切进 `minimax_keyframes`，`img_update=False`；**零 VAE 往返**，不 decode + encode。
- `follow_plan` 开：`context_length = plan.cur.overlapFrames`（**只钉 overlap**；`tolerance` 只裁不钉）；音频长度取 TimePlan 的 `audio_context_length`；overlap=0 不钉。
- 输出：`timeplan` + `positive`；**不输出 trim**，裁头由 SegmentPanel 做。
- `pin_next_head`（默认关，实验）：TimeLine 重跑本段且下一段 latent 存在时，按下一段 `overlap+tolerance` 偏移到**可见头**，钉到本段尾部；端口号由 TimeLine 从 `valueN → context_latent` 接线识别，写进 `nextRef.latentPort`。
- 重跑：`LoopEnd` 自动记录媒体类型（video 也记）；`LoopStart` 从 `seg_XXXX.mp4` 恢复 VIDEO；latent 按勾选落盘后由 `media.json` 的 `files` 映射恢复。
- `nextRef` 是实验路径：只有 `pin_next_head` 开着才用；下一段 latent 头部含自己的重叠区，代码已按下一段 `overlap+tolerance` 偏移到可见头。仍建议与“重跑到末尾”/AddGuide 可见首帧对比验证。
- 22 / 24 是 H3 官方推荐配对；不是所有模型通用。

### SplitVideo
- 最多 **16 卡**（`_EZSV_MAX=16`）；`timeplan`（可选）+ 每卡 `video_N`，输出 `timeplan` + 16 个 `Segment N`。
- 输入：`mode`（loop/one/frames）、`one_start/one_end`、`max_frames`（0 = 不限）、`config`、`out_type`（frames/video/gif/audio）、`start_frame/end_frame`、`select_every_nth`（0 = 不抽帧，N = 每 N 帧取 1）。
- `_ezsv_probe`：按路径 + mtime + size 缓存帧数 / fps；`_ezsv_card_range` 解窗口（输入若已裁剪，帧号 / 时间相对输入，叠加 offset）。
- `_ezsv_card_cut`：`_tl_slice_frames(..., budget, stride)`；缓存 key 含 budget / stride。
- `_ezsv_card_media`：
  - video → `VideoFromFile(path).as_trimmed(rel, du, strict_duration=False)`（懒裁剪，不编码不落盘；失败才回落 `_tl_trim_video`）；
  - audio → `_tl_slice_audio`（采样级）；
  - gif → 复用 `_ezsv_card_cut` 的帧缓存，再 `_tl_save_gif`。
- `_tl_slice_frames` 用 `container.decode()`（自动 flush，H.264 尾部 B 帧不丢），支持 stride / budget；`_tl_frames_tensor` 一次性 float 转换，峰值内存更低。
- `_video_stream_temp`（PreviewAny）：未裁剪直接返回源文件；裁剪对象按 `源 + 窗口` 哈希转一次 `ezpv_trim_*.mp4` 缓存。
- 前端：第一行「设置」文字按钮打开帧上限 / 抽帧弹窗；每卡可覆盖模式 / 输出形态；`MAX=16` 与后端一致；挂载时保留用户拖出的尺寸（宽度 >200、高度 >120 才采纳），`getMinHeight=120`。
- 输入已裁剪时，窗口相对该输入（与内置 Video Slice 一致）。

### SegmentPanel
- 输入：`images`、`timeplan`（可选）、`audio`；字段：`save_dir`、`fps`、`clean_vram`、`assemble`、`trim_tail`、`rerun_stop`、分段编码（`codec` / `bit_depth` / `color_space` / `crf`）、成片编码（`final_format` / `final_codec` / `final_crf` / `final_bit_depth` / `final_color_space` / `final_follow` / `final_fps`）。
- 分段固定 MP4；分段编码器 auto/h264/av1；成片 mp4/mkv/webm，编码器 auto/h264/h265/av1；可跟随分段编码。
- `clean_vram` = `gc.collect()` + `soft_empty_cache()`：只清 Python 垃圾 + 空闲 CUDA 缓存块，**不卸载模型**；模型是否重载由 ComfyUI 的显存管理决定。
- 每段落盘 + manifest；`_ezsp_concat` 末段 / 区间终点收口；`_ezsp_trim_segment` / `_ezsp_replace_segment` 修改后重新 concat；`rerun_stop` 写回同一次 run。
- 接缝处理（清理显存下一行）：`blend_frames`（xfade 帧数，0 = 关）+ `audio_xfade_ms`（PCM 等功率交叉淡化，0 = 跟随视频）；manifest 存 `blendFrames` / `audioXfadeMs`；`_ezsp_concat_blend` 实现，失败回落纯拼接。成片每接缝缩短 `blend_frames` 帧，TimeLine 重拼复用。
- 输出：`timeplan`、`images`、`audio`、`video`。
- HDR 只标色彩，不做色调映射；分段固定 MP4 是预览 / 循环 / 拼接的稳定基线。

### TimeLine
- 输入：`timeplan`（可选）+ `video`（分段成片 list）；面板：大预览 + 拼接轨 + 播放 / 停止 / 静音 / 全屏 / 音量（顺序：静音 → 全屏 → 音量）。
- 右键菜单定稿：设定该段时长（#n）、设定整体时长、重新生成本段、重新生成至末尾、重新生成指定段、裁切头尾、恢复未裁切、替换本段、替换整片、清理本段缓存。
- 「设定整体时长」= 调上游 TimePlan 的 `_eztpOpenCustom()` → `openDurModal`（同一份实现 / 样式）。
- 裁切 / 替换 / 重跑都写 manifest 并重新收口；`tlSeek` 统一播放头；`drawPane` 切换段视频时按 `currentTime` 差值对齐（local=0 也对齐，修“点回第一段要点两下”）。

### VideoComponents
- 输入 `VIDEO`；输出 9 路：images / audio / fps / bit_depth / color_space / frame_count / duration / width / height。
- 核心 `video.get_components()`；元数据优先 `video.get_bit_depth()` / `get_color_space()`，与内置 Get Video Components 对齐；`frame_count` 为实际解码帧数。

### ControlnetPreprocessor
- 一卡一个预处理器，按上游真实输入 / 输出口展开；`_EZ_PREP_MAX=64` 个输入位；端口类型 `*`。
- 收录**全部**预处理器（含 Inpaint / Unimatch / MaskOptFlow / Pose Keypoint Postprocess 这类多输入或首输出非 IMAGE 的），
  只排除裸分类 `ControlNet Preprocessors` 下的工具节点（Selector / ExecuteAll / AddText，`AIO_Preprocessor` 除外）。
- 需 `comfyui_controlnet_aux`；不内嵌副本。

### LoopStart / LoopEnd
- Start：`index`（INT，第一）+ `value1..20`；输入 `index` + `initial value1..20`（初值口）。
- End：`rounds`（总轮数，0/1 = 一次）；`value1..20`；输出 `timeplan` + `out1..20`；`OUTPUT_NODE=True`；`IS_CHANGED → NaN`。
- 回喂隐式：End.valueK → 下一轮 Start.valueK（写克隆节点 `_ezfeedK`），画布不许 End→Start。
- 队列续跑：配对 Start 的 `config.queue=true`；每轮新 prompt 回队列；list 值包 `{"__value__":[...]}`，`_unwrap_literal` 拆；每轮独立 prompt，跨轮累积预览会丢。
- 后端声明 20 口，前端 `trimLoopSockets` 只留「已连最大编号 + 1」。

## 3.5 避坑（结论）

1. **动态端口**：类 `RETURN_TYPES` 全局共享；同步“只增不减 + 动态槽统一 `*`”；重排 socket 后 `graph.links` 的槽位要一起改。
2. **Vue / 经典**：`addDOMWidget.canvasOnly = !window.__ezflexIsVueNodes()`；面板穿透靠常驻 CSS（`!important` + `:has()`）；后建控件要能点；定时重建前先算内容签名，别把正在点的 DOM 删掉。
3. **媒体编号**：按目标生成节点自己的端口顺序、按类型各自从 1、只数已连接；节点标识用标题；端口名优先、扩展名兜底；`startIndexWatcher` 要传真实节点。
4. **@ 芯片**：每次插一份；用 Range 插入而非 `execCommand`；插入前 `range.deleteContents()`；改编号只改 `.eph-mref-txt`。
5. **总体编辑 contenteditable**：块首退格 / 块尾删除会破坏结构 → keydown 拦截 + `data-cardId` + `healAllEditor()` 三道防线。
6. **层级弹窗**：`_phLayers` 栈 + capture 协调器，只关“按下前已打开”的层、拖动不关、一次只关最上层。
7. **弹窗按键挂 document 捕获阶段**；否则弹窗翻页时底下画布一起动。
8. **row / group 输出模式**：Loader 换「按卡片组 / 按分组」后后端口序号 ≠ 卡片序号 —— 按 slot 取卡片的地方必须走“端口盖章优先”。
9. **socket 黑框标签**：显隐判断用当前渲染图 `app.canvas.graph`（`|| app.graph` 兜底）；没接线的口不画标签。
10. **list 端口九宫格**：ComfyUI 给 list 类端口画九宫格（`shape=6/7`）；要圆点就每帧 `sock.shape = null`。
11. **行尾注释别吞语句**：`… // 说明 p._tpPage = pgBar;` 会把赋值整句吃掉；赋值 / 调用一律单独一行。
12. **对象字面量里引用后面才定义的 const** = TDZ `ReferenceError`。
13. **`pushMediaFile` 要求 `f.path`**：MediaLoader 端口项必须带 `path`，否则编号引擎整条丢掉盖章项。
14. **内置加载节点的值格式**：新前端带 `name.png [input|output|temp]`（剥掉并用于 `/view` 的 `type=`）；`LoadImage` 的 value 可能带子目录。
15. **标量端口不要靠扩展名升格成媒体口**（`GetVideoComponents` 的 `fps/bit_depth/color_space` 会变幽灵 `@视频1`）。
16. **删死代码要精确匹配 + 断言**；静态扫描把 `_dev_tests/` 一起算。
17. **源文件改写别用 PowerShell `Get-Content/Set-Content`**（毁编码）；验证 JS 的副本放工作区内 `_tmp`，别用 `%TEMP%`。
18. **别留“UI 看不见、后端还认”的开关**；预览类型要主动跟（MESH/SPLAT/VOXEL、真 CONDITIONING 是 `[[cond, {…}]]`）。
19. **3D 用本地离线 three.js**（`web/libs|utils|curves`），serve 走 `/preview_any/3d/{path}`。
20. **新增 `web/*.js` 自动进 no-store**（路由按目录枚举）；`hardening_test.py` 钉住。
21. **预处理器卡片 = 多端口**：按上游真实输入 / 输出口展开；`slot ↔ (card, port)` 映射走 `ezPortAt()`，不要假设“一卡一口”。
22. **层协调器的逐层 veto 钩子 `el._phKeepOnUp(t)`**：挂在别的元素上的浮层要实现它，否则点宿主会被当成点外面收掉。

## 3.6 PromptHelper 标签系统

- 两套空间：库侧 `place/fav/meta` + 我的侧 `mine` 副本；伪行 全部 / 已收藏 / 我的标签；固定真节点「未分类」。
- ⚠️ `_ph_libs_clean` 必须保留 `libs[lib].groups/place/fav/meta`；`_ph_tags_clean` 必须保留 `mine`（曾漏 → 库分组树 / 归类每次保存被冲掉、删掉的标签刷新又回来）。
- 数据：`user_data/PromptHelperLib/` 下 12 个 CSV（8 标签库 + `_tag_kind` / `_zh_CN` / `_e621_species` / `_furry_extra`）。
- 性能：懒加载 + 单字不查（热度门槛）+ 中文走 `_zh_CN`；卡片管理器搜索是当前最大热点。
- 卡片存档：`user/EzFlex/prompts/<名称>.json`（名校验 + 签名防误删）。
- 卡片尺寸 / 显示模式：`localStorage['ezflex.tagCardSize']` / `ezflex.tagPreviewFit`；显示模式全局，改完只重画当前页。
- 收藏星：未收藏只在悬停出现，已收藏常驻亮黄 `#ffd21e`；点收藏只原地刷星 + 原地更新「已收藏」计数，但在「已收藏」视图 / 「只看收藏」筛选下要重画。
- 批量拖拽：`_tpDragKeys`，批量模式下拖一张带走整组；单张只拖自己。

## 4. 长视频流程

```text
TimePlan（规划）
  └─ timeplan / frames
       ├─ MotionContext（钉上一段 latent 尾）
       │     └─ positive → 采样器
       ├─ SegmentPanel（images / audio / timeplan）
       │     ├─ 每段裁头 + 落盘 + manifest
       │     └─ 末段 _ezsp_concat → final
       └─ TimeLine（timeplan + video list）
             └─ 右键：重跑 / 裁切 / 替换 → 同一 manifest / concat
```

- 循环：`LoopStart.index` 驱动 TimePlan / MediaLoader；`LoopStart.valueK` 回喂上一段 latent 给 MotionContext；`SegmentPanel.video` 进 `MergeList` 或 TimeLine。
- 分段时间：`netStart / netDuration` 已扣掉重叠；`overlap + tolerance` 是 MotionContext 钉入长度，也是 SegmentPanel 裁头长度。
- 不要把整段视频对象攒在 list 里（帧张量会爆显存）；每段落盘，只回喂路径 / latent。

## 5. 数据与持久化

- **随工作流**：`widgets_values`、`config`、`node.properties`。保存过的图重载都在。
- **node.properties 镜像**：`ezTp`（TimePlan：`total` / `config` 等）、`ezMediaConfig`、`ezPersist`（Loop）、`eztl`（TimeLine）、`ezSegDir` / `ezSegDone` / `ezSegFinal`（SegmentPanel）。
- **服务端**：插件目录 `user_data/`（每节点预设文件、`PromptHelperLib/` 标签 CSV、`ezflex_media_target.json`、`ezflex_api_hosts.json`）；卡片 `user/EzFlex/prompts/*.json`；标签数据 `ezflex_prompt_tags.json`。
- **localStorage**：`ezflex.locale`、`ezflex.theme`、`ezflex.apiKey.*`、`ezflex.phDockMode`、`ezflex.tagCardSize`、`ezflex.tagPreviewFit`、`ezflex.tagLib`、`ezflex.randGroups`、`ezflex.cardMgr*`、`ezflex.mlLabels` / `moLabels` / `mcLabels` / `pvLabels` —— 换浏览器 / 清缓存会丢。
- **临时目录**：ComfyUI 每次启动清空 `temp/`（`cleanup_temp_filesystem()` → `shutil.rmtree(temp)`），只用于预览 / 切段缓存；成品在 `output/`。
- **已知风险**：
  - PromptHelper 正文只在保存 / 关窗 / 点外面时提交（弹窗模式下改一半刷新会丢）。
  - MediaLoader 的 properties 以“字符串更长”为准，删除操作在写入失败时可能被旧副本盖回。
  - TimePlan 最后 220ms 的输入可能未落盘。
  - Loop / TimeLine 的运行进度只有保存过工作流才带。

## 6. 安全

- 路径包含性：`_ez_real` / `_ez_roots` / `_ez_inside`（realpath + commonpath，覆盖 `..` / 绝对路径 / 兄弟前缀 / 符号链接）；根外文件只有本机预览才复制进 temp。
- 本机限定 `_ez_local`：回环 remote + 回环 Host + Origin/Referer 同源 + 拒 `Origin: null` / `Sec-Fetch-Site: cross-site`；覆盖 open / pick_folder / 配置写入 / 根登记 / 预设写 / 动态输出同步。
- 出站：`_ph_check_outbound` 主机允许列表 + 仅 http/https + 每跳重定向复核 + 代理复核；模型解析 strict。
- 直链后缀白名单 `_MEDIA_SERVE_EXT`；绝对保存路径限制。
- 低危残留（均需本机 / 回环）：`/preview_any/open` 拉起 explorer、`/media_loader/save_as` 的 dest、预设 GET 只回名字。

## 7. 性能

- 交互期 `pumpFrames(ms=300)`：醒后 300ms 每帧更新，停手自动停；`onDrawForeground` 只做同帧 `update()`，不额外 pump。
- 后端目录扫描缓存 `_scan_cached(key, roots, build)`（TTL 5s，可 0 关闭）；只缓存文件名 / 路径元数据，不缓存模型 / 图片 / tensor。
- 模型缓存上限：`_LLAMA_CACHE_MAX=2`、`_PH_CLIP_CACHE_MAX=4`；`ph_clear_model_cache()` 可手动清。
- SplitVideo：`_EZSV_PROBE_CACHE` 缓存 probe；同窗口 frames / audio / lazy trim 复用；gif 复用 frames 缓存；`_tl_frames_tensor` 少一份整份拷贝。
- PreviewAny：文件直通、PNG 不做慢压缩、音频直接写 WAV 字节。

## 8. 验证

```powershell
$root="<ComfyUI>"; $py="$root\.venv\Scripts\python.exe"; $d="$root\custom_nodes\Comfyui-EzFlex-Presets"; $t="$d\_dev_tests"
$env:PYTHONIOENCODING="utf-8"
& $py -c "import ast,io; ast.parse(io.open(r'$d\__init__.py',encoding='utf-8').read()); print('PY OK')"
foreach($f in (Get-ChildItem "$d\web" -Filter *.js -Recurse)){ $tmp=Join-Path $t "_tmp\chk_$($f.BaseName).mjs"; Copy-Item $f.FullName $tmp -Force; node --check $tmp }
# Python 只收 *_test.py；mjs 排除 _analysis/_jsdom/_probe/_real_wf；两者不要并发跑
Get-ChildItem "$t\*_test.py" | Where-Object { $_.Name -notmatch '_i18n_|undefined_names' } | ForEach-Object { & $py $_.FullName *> $null; if($LASTEXITCODE -ne 0){ "FAIL $($_.Name)" } }
Get-ChildItem "$t\*_test.mjs" | Where-Object { $_.Name -notmatch '_analysis|_jsdom|_probe|_real_wf' } | ForEach-Object { node $_.FullName *> $null; if($LASTEXITCODE -ne 0){ "FAIL $($_.Name)" } }
```

- 判失败看退出码 ≠ 0 或输出 `^FAIL`；`tag_store_test` / `user_dir_test` / `prompt_helper_test` / `route_security_test` 在临时目录累计时可能因沙箱删除守卫假失败。
- `_dev_tests/_i18n_merge2.py` 是生成器不是测试，跑它会重写 `web/ezflex_i18n.js`，批跑必须排除。

最近通过：
- `py_compile __init__.py`；全部 `web/*.js` 语法检查。
- `preview_any_media_test.py`（22 项：约束 / HDR↔SDR / copy 元数据）。
- `time_plan_panel_test.mjs`（78 项）、`split_video_test.py` / `split_video_panel_test.mjs`。
- `timeplan_test.py` / `timeline_plan_test.py` / `hardening_test.py` / `node_contract_test.py` / `i18n_test.py` / `preview_ux_test.py`。
- 已知沙箱失败：`timeline_panel_test.mjs`（写 `_dev_tests/extensions` EPERM）；`motion_segment_panel_test.mjs` 仍是旧布局断言。

需要真实 GUI 回归：
- SplitVideo 三种模式 / 四类输出 / 懒裁剪预览。
- MotionContext 灰值、TimeLine 预览 / 控件 / 右键。
- SegmentPanel 各容器与编码器、TimePlan 规划库与时长弹窗、PreviewAny 额外参数。

## 9. 已知问题 / 待办

- [ ] TimePlan 裁头尾合并弹窗未做。
- [ ] SegmentPanel 的 HDR 仍是只标色彩，未走色调映射。
- [ ] TimeLine 预览 mkv / avi 依赖浏览器解码能力。
- [ ] 22 / 24 是 H3 推荐配对，不是所有模型通用。
- [ ] FreeLatent：DOM 类型下拉切 LoRA 不自动补 `targetId`（LoRA 静默跳过）。
- [ ] PromptHelper：全/半角转换用 `textContent` 整段替换，会丢格式与 @芯片。
- [ ] PromptHelper 卡片管理器搜索：防抖 + 原地过滤 + 批量请求。
- [ ] `_ez_roots()` 每请求 memo；编号引擎 `relayDepth=4` 上限。
- [ ] TimeLine `tlSlotItems` 不做中继穿透（`LoadVideo → GetVideoComponents → TimeLine`）。
- [ ] 放大端口抓取半径在新前端失效；Vue 黑框标签叠加层按端口坐标再校准。

## 10. 备份与清理

- 全部备份集中在 `backup/`（已在 `.gitignore` / `.comfyignore` 里，不会进仓库也不会进发布包）：
  - `backup/dsh/ezflex_20261029-1845`：ModelsCombo 端口名/0 强度触发词两处修改**之前**（完整快照，6479 文件 / 102.85 MB）。
  - `backup/dsh/ezflex_20261029-1940`：两处修改**之后**、结构优化开始之前（完整快照，同上）。
  - `backup/dsh/`：原 `_dsh_backups/` 整体迁入（上述快照 + 各轮 audit/分片脚本 + `CODE_MAP.md`）。
  - `backup/old_init_p3bak/`：拆分前的 5 个 `__init__.py.p3bak*` 单文件（原在根目录，会被发布包带走）。
  - `backup/p3_before_<时间戳>/`：每次动手前的定点备份（只含本次要改的文件）。
- 旧 `backup/*.tar.gz`（10-19 ~ 10-25 共 7 个）已删；以后不再堆积 tar 包，改快照目录。
- 已删除：`_blend_test/`、`web/time_plan_v2.js`、`web/_dshtest.txt`、`web/__dshtest.tmp`（后三个文件受 Windows 完整性级别限制删不掉时，改用占位/忽略，不影响运行）。
- 3D vendor（`three.module.js` 等 9 个）已复制到 `web_assets/3d/`，`web/libs|curves|utils` 原地改成 1 行占位注释（不再被自动 import）。

## 11. 最近变更（2026-10-24 / 25）

- SplitVideo：`video` 改懒裁剪；`max_frames=0` 不限；`select_every_nth` 0 = 不抽帧、N = 每 N 帧取 1；解码 flush 修尾部少帧；输入已裁剪时帧号相对输入；卡片上限 8 → 16；设置改为第一行文字按钮 + 弹窗；设置弹窗只保留“仅帧序列 / GIF 生效”提示；挂载保留用户尺寸，`getMinHeight` 降到 120。
- TimeLine：右键菜单文案 / 顺序定稿；「设定整体时长」改为直接复用 TimePlan 自定义弹窗；全屏 / 音量互换；修“点回第一段要点两下”（`drawPane` 按 currentTime 差值对齐，local=0 也对齐）。
- VideoComponents：元数据优先取 VIDEO 对象，和内置 Get Video Components 对齐。
- TimePlan：输入框内容居中；`select_every_nth` 默认 0。
- SegmentPanel：新增 `blend_frames` / `audio_xfade_ms`（清理显存下一行）；`_ezsp_concat_blend` 用 xfade + WAV 等功率交叉淡化；manifest 存 `blendFrames` / `audioXfadeMs`；TimeLine 重拼复用。成片每接缝缩短 `blend_frames` 帧。
- 备份：`backup/ezflex-V1.3.0-20261024-1558.tar.gz`。
