# EzFlex 插件套件 · 项目交接文档

> 硬数据，无闲聊。唯一交接入口：改动前先看 §5「避坑」，下一步看 §7「待办」。
> **当前 V1.2.10**：ModelsCombo 第一个输出口在切窗口/刷新/重启后断连——`trigger_words` 只在 `loaders` 非空时追加，空载瞬态回到旧路径（空 `want`）；V1.2.9：生成信息兜底修（放大/检测/控制权重不再混进 Model，放大模型单列 Upscale model；EzFlex-ModelsCombo 的 config JSON 解出 model/clip/vae/lora；config JSON 不再污染 Prompt）+ NSG 分组发现以节点自己的图为基准 + 标题正则不中退回字面匹配 + 复制/载入后同步过滤器重扫行（修复制后偶发匹配不到分组）。V1.2.8：预览任意（PreviewAny）批次图片——整批缩略图条（非全屏在弹窗底部、全屏也保留）+ 全屏左右悬停箭头/键盘翻页，存档逐张落盘（单卡上限 64 帧）；各弹窗全屏键统一移到 ✕ 左侧；NSG 分组发现改为以节点自己的图为基准（不用 getCurrentGraph）+ 标题正则不中退回字面匹配 + 复制/载入后同步过滤器并重扫行（修「复制后偶发匹配不到分组」）；生成信息兜底修：放大/检测等权重不再顶替底模（放大模型单列 `Upscale model`），`EzFlex-ModelsCombo` config 里的 model/clip/vae/lora 能解出，config JSON 不再污染 `Prompt`；英文 README 严格对齐中文并升版本号。V1.2.7：预览图消失修复（标签库读失败不再当空存回；卡片管理只改内容时保留预览图）+ 黑框端口标签（PromptHelper 去圆点；ModelsCombo / MediaLoader / MediaOut / FreeLatent 纵向间距不再随节点高度压缩；新增 ParamPresetControl / ParamPresetOutput / PreviewAny 三个节点）+ 对齐官方节点（CLIP `yue2`、LoRA `safe_load`+`lora_metadata`、`intermediate_dtype/device`、`downscale_ratio_spacial`、3D `.spz/.splat/.ksplat`）+ 刷新 API 厂商与模型 ID。V1.2.6：主题系统（`web/ezflex_theme.js` 16 套配色 → 共享 `--ez-*` 变量，切主题全画布即时生效；原生控件 `color-scheme` 兜底；2D canvas 走 `ezThemeColor()`）+ FreeLatent 画布（跟主题上色、网格按需抽稀不再整块消失、边界四边等宽、预设下拉固定向下并跟随节点）+ 标签预览只保存一次（不再被旧内容覆盖）+ 标签面板翻页栏修复 + 全部 EzFlex 数据收进 `user/EzFlex/`（旧文件自动迁移）+ 清理不可达 canvas 子系统 / 调试日志 / 冗余 CSS。发布相关看 §9，标签系统（规范 + 状态）看 §10。
> **⚠️ 强制要求：经典模式与 Nodes 2.0（Vue）必须分开写作用域**（`.ezfx-is-vue` / `:not(.ezfx-is-vue)`）。禁止写对两种模式同时生效的行为规则；改一种前先确认另一种不受影响，两种分别回归。历史教训：把「面板根穿透」写成全模式通用后，经典模式的滚动条与空白拖动一起被带坏。

## 0. 环境与生效方式

| 项 | 值 |
| --- | --- |
| 版本 | `__version__ = "1.2.10"`（`__init__.py` / `pyproject.toml` / README） |
| ComfyUI | `0.30.x`；前端 `comfyui_frontend_package`（Vue / Nodes 2.0，`addDOMWidget`） |
| venv python | `<ComfyUI>\.venv\Scripts\python.exe` |
| 生效方式 | Python（节点类 / 路由）改动 → **完整重启 ComfyUI**；前端 JS → **Ctrl+F5 强刷** |
| 前端横幅 | 改前端时一并改 `web/prompt_helper.js` 的 `PH_BUILD`（当前 `2026-09-26-v129`），控制台看 `[PromptHelper] module loaded · build …` |
| 依赖 | 必装 `mutagen>=1.46.0`；可选 `llama-cpp-python` / `gguf` / `onnx` / 外部 `ffprobe`（`shutil.which` 探测）；其余 torch/numpy/Pillow/safetensors/av 由 ComfyUI 自带 |

## 1. 节点清单（11 个，category 全 `EzFlex`）

Add-Node 顺序：`MainControl → ModelsCombo → FreeLatent → NodeSwitchMaster → NodeSwitchGroup → ParamPresetControl → ParamPresetOutput → PreviewAny → PromptHelper → MediaLoader → MediaOut`

- `__init__.py` 的 `NODE_CLASS_MAPPINGS` 与 `web/ezflex_service.js` 的 `NODE_TYPES` 必须一致（增删/改名两处一起改）。
- 链路：`MainControl → Master → Group → node.mode(0/2/4)`；`ParamPresetControl →(连线)→ ParamPresetOutput`；`MediaLoader →(连线)→ MediaOut`；`PromptHelper` 旁挂。
- 控制类（MainControl / Master / Group）**纯前端生效**：Python 只承载 config，`run()` 返回 `()`，mode 由浏览器改并随工作流序列化。
- 文件：`__init__.py`（11 节点类 + 全部后端路由）；`web/*.js` 每节点一个面板 + `ezflex_service.js`（共享）+ `ezflex_media_index.js`（编号引擎）+ `ezflex_i18n.js`（面板词典）+ `ezflex_theme.js`（主题变量）；`web/libs|utils|curves` 为本地离线 three.js 与加载器；`locales/zh/nodeDefs.json` 为官方 i18n；`user_data/` 为运行期预设库（不跟踪）；`_dev_tests/` 为回归套件。

## 2. 各节点行为（只留关键点）

### ModelsCombo（模型组合加载器）
- 输入隐藏 `config`；输出 `MODEL/CLIP/VAE 1..N`（类 `RETURN_TYPES` 运行期/前端同步，编辑时类型化）。`MAX_PORTS_PER_TYPE = 32`。
- `parse_config` 校验 loader 类型/extra；`load_checkpoint/load_unet/load_clip/load_vae` 与内置节点同款，device/weight_dtype/clip_type 都有白名单校验。
- **LoRA 串联**：按 id 顺序依次 `load_lora_for_models`，`strength_model/strength_clip` 取自 `extra`；**目标 `targetId` 为空则该 LoRA 被跳过**（新增 LoRA 会自动指向第一个主加载器；把已有行切成 lora 后不会自动补，需手选目标）。
- **载入守卫：loaders 未载入时不重排端口**（V1.2.9）：`updatePorts` 开头判断 `!st.loaders.length && 仍有任一连线` → 直接 `return false`。config 还没解析进来时 `want` 为空/不全，按它删端口会把正在恢复的 MODEL/CLIP/VAE 连线割断（「刷新后第一个口断连」）。等 loaders 到位再正常重排；空节点（默认口无连线）不受影响。**避坑**：试过「保留有连线的多余口」与「新建前优先复用未用的有连线口」——在默认口 / 类型错位时会给新口新建、又保留旧口，凭空多出端口且重绘永不收敛，已废弃。
- **触发词串输出**：只要 `loaders` 非空就有一个固定 STRING 口 `trigger_words`（**固定排最后，不动前面 model/clip/vae 的顺序与复用**；没有 lora 时输出空串）；值 = 按 LoRA 顺序把各自 LoraManager `<模型>.metadata.json` 的触发词用 ", " 拼起来（没触发词 / 没 file / 没 metadata 的跳过）。**触发词取 `_lora_trained_words()`：顶层 `trainedWords` 为空就退回 `civitai.trainedWords`（实机 LoraManager 顶层就是空的，C 站的词在 civitai 下面）**，再退回 `activation_text`。**切预设不会摘掉它**（下游不断连）；但 `loaders` 尚未载入（空配置）时不追加——空载瞬态动端口会把刷新后恢复中的第一个口删掉。前后端同步点：`_mc_output_types` 与前端 `updatePorts` 都按「`loaders` 非空」追加。
- **面板选中态（V1.2.10）**：统一用 `ezPanelState(node, key[, value])` 存 `node.properties`（LiteGraph 随工作流序列化/还原，刷新、切工作台、重启自动恢复），O(1)，**不要拿当前配置反查预设表**（那是 O(节点×预设) 的字符串比较）。已接：ModelsCombo 预设 `ComboPreset`、FreeLatent 比例预设 `FlatPreset`。`ParamPresetControl`/`MainControl`/`NodeSwitchGroup`/`MediaLoader` 本来就存 config 的 `current`，无需改。
- 「⧉ 浏览」弹窗：读 LoraManager 的 `<模型名>.metadata.json` + 同目录预览图（`/models_combo/lora_meta`、`/lora_meta_detail`、`/preview`）。标签行最右多一个**「已加载」**页：它不是另一种视图，而是**一个筛选**（`_loadedFileSet()` 按文件名匹配节点里已选的模型文件），筛出来的就是**普通模型卡**（和 LoRA 页同一套卡片）。注意它只覆盖 LoraManager 有索引的 checkpoint / unet / lora（clip/vae 不在 LoraManager 索引里，故不出现）。
- 实例 API：`node._ezComboAPI`。

### FreeLatent（分辨率 / Latent 选择器，V3 `io.ComfyNode`）
- 输入隐藏 `config` + `width/height/batch_size`（INT 可连接，>0 覆盖）；输出 `Latent/Width/Height/Batch`。
- 面板全部状态随 config 持久化（width/height/batch_size/align/limit/algorithm/aspect/force/customRatios），刷新后由 `updateInfo()` 回填。
- **force**：仅任一输入已连接可切换；绿色 = 忽略外部用面板值。点击**先 syncToConfig 再 loadFromConfig**。
- **对齐**：后端严格按面板 `align` 对齐；结果非 8 的倍数时 `execute` 抛清晰报错。
- **宽高预设** `/freelatent/presets`：默认项（14 比例 + 8 固定分辨率）在上、自定义在下、中间 disabled 分隔行；`canonicalOrder` 折叠跨语言重复项、丢弃过期默认项。套用预设会一并还原 `batch_size`。
- **设为默认（V1.2.3 新增）**：预设下拉为自绘菜单（原生 select 隐藏）；**鼠标停在某项 0.5s → 右侧弹出 ★ → 点 ★ 设为默认**（再点同一个取消；只能有一个）。存 `GET/POST /freelatent/presets/default`（快照 name/width/height/batch_size），**空 config 的新建节点**自动套用；已有工作流尺寸不动。实例 API：`node._ezLatentAPI`。

### NodeSwitchGroup / NodeSwitchMaster / MainControl（纯前端）
- NSG config：`{filters:{mode,match,showAllGraphs,sort,presetCollapsed,matchCollapsed}, states, presets, current}`；分组发现定时器**必须按节点放**（`node._ezScanTimer`）；分组状态键 `groupKey = title + '##' + idx`；分组预设**存节点 config**（删节点即丢）。
- **（V1.2.9）分组发现基准 = NSG 自己的图**（`allGraphGroups(node.graph)`）：复制节点 / 在子图里操作时「当前视图」会变，用 `getCurrentGraph()` 会偶发扫到别的图 → 匹配不到分组。标题匹配：正则不命中（标题带 `( ) [ ] + . * ?` 等正则字符）时**退回字面包含**。`onConfigure`（复制/载入）后必须 `_ezSyncFilters()` 同步过滤器 DOM + `refreshUI` 重扫行（`setupNode` 可能先于 configure 跑，否则面板停在默认 match）。
- NSM：行 = 画布上的 NSG 实例，总预设 = `{nodeId: 分组预设名}`，存 `/nodeswitch_master/presets`。
- MainControl：被控 4 类（Combo/FreeLatent/NSM/ParamPreset）；总预设存 `/main_control/presets`；「加载全部」9 类，排布按视觉外框（`visualBox() + NODE_TITLE_HEIGHT`，排完 350ms 再对齐）。
- 主题：`web/ezflex_theme.js` 定义 16 套配色（浅色=原配色；藕荷/青苔取 Radix Colors 1..12 色阶；其余由「背景/卡片/控件底/描边/主文字/次文字/主色/浅主色」推全五级表面，配置在 ezflex_theme.js 的 USER 表里），每套给全五级表面 + 三级描边 + 四级文字（对比度兜底）+ `color-scheme`；变量挂根元素，面板 CSS 只写变量，切 `data-ez-theme` 即全画布即时生效（存 localStorage）。另有 `:where()` 原生控件兜底层，补没写颜色的 input/select 文字色。
- 三处下拉都禁止自定义预设占用内置名（`isReservedPresetName`）；内置预设用英文规范名，判定走 `basePresetMode`。

### ParamPresetControl / ParamPresetOutput（动态输出）
- Control config：`{groups:[{id,name,params:[{id,name,type,value,enabled}]}], current}`；输出 = 分组数 1:1（`EZFLEX_PARAM_GROUP`）。换预设/重排按 `_ezGroupId` → 位置 → 新建复用 socket，不断连。
- Output：输入 `group` + `config`；输出 = 参数数 1:1（int→INT / float→FLOAT / string→STRING / bool→BOOLEAN / 复杂→STRING）。**禁用参数保留端口并输出中性值**（int/bool→0、float→0.0、其余→空串）。socket 按 `_ezParamId` 复用。

### PreviewAny（任意预览）
- 输入 `input_1..16`(ANY)，输出透传原值（`RETURN_TYPES="*"`，可插在工作流中间），`OUTPUT_NODE=True`。
- `_infer_type` 按 `type(value).__module__ + __name__` 判定（不能靠 hasattr 探测 patcher）；覆盖 IMAGE/MASK/LATENT/AUDIO/VIDEO/CONDITIONING/LIST/DICT/标量/File3D/MESH/SPLAT/VOXEL/MODEL/CLIP/VAE…；**已知类型都不许落到裸 repr**（`preview_types_test.py` 98 条钉住）。
- **文件直通（勿回退）**：来自文件的视频/音频不重新编码（`_video_file_source` / `_audio_file_src`）；内存型 `VideoFromComponents` 用 `get_stream_source()` 落 `ezpv_vid_<sha1>.mp4`（保留音轨/帧率/时长）。
- **（V1.2.9）**生成信息链：PIL 内嵌文本 → 同名 sidecar → 容器内嵌（ffprobe，回落 mutagen）；内存张量（生成图/视频）再退回 `_workflow_gen_meta` 扫工作流。**兜底分类（V1.2.8 修）**：`_UPSCALE_HINTS`/`_AUX_HINTS` 把 `UpscaleModelLoader`、检测/控制/换脸权重从 `Model` 里剔出（放大模型单列 `Upscale model`）；`EzFlex-ModelsCombo` 的 config JSON 单独解析出 model/clip/vae/lora；`Prompt` 只取非模型、非 JSON config 的文本 widget。**穿透连线（V1.2.9）**：CLIPTextEncode 的 text 若是连线，按 `workflow.links` 上溯取正文 —— `EzFlex-PromptHelper` 按 origin_slot 取（slot 0 = 合并卡片，slot N = 第 N 张卡），其它文本节点取明文 widget、没有就继续上溯；正/负两段提示词都会列进 `Prompt`。
- **存档**：用 `entry["image_src"]` 原图，PNG 写 `PngInfo(workflow/prompt)`；**只允许白名单后缀**（`_SAVE_ALLOWED_EXTS`），**绝对 savePath 只允许 output 或本机「选择文件夹」登记过的目录**（`_pv_save_roots`），否则回落 output。
- **批次图片（V1.2.8）**：IMAGE 是 `[B,H,W,C]`，整批都能看/存。卡片角标显示张数（`entry.images`/只读的 `entry.batch_kind`），点开 = MediaLoader 式弹窗：主图 + 底部缩略图条 + 左右翻页（键盘 ←/→；全屏同样保留底部缩略图条，另加左右悬停箭头；各弹窗全屏键统一挨在 ✕ 左边）；存档逐张落盘 `name_<ms>_NN`（`entry.saved_paths`；单张命名不变），仍用原图 + workflow/prompt 元数据。单卡最多导出 `_PREVIEW_MAX_BATCH = 64` 帧，超出的帧数记在 `entry.batch_total`（不落临时文件）。**「批量出图」与「视频抽帧」张量本身区分不了**：只按工作流上游节点类名（含 video/frame/sequence/gif/webm/mp4/mov → `frames`，否则 `images`）给角标文案；HTTP API 直连没有工作流时一律按 `images`。

### PromptHelper（持续开发中）
- 输入：`config` + 动态 `media_in_1..16`(ANY) + `card_in_1..N`(STRING)。输出：固定「Merged prompt」+ 每卡一个 STRING；**类 `RETURN_TYPES` 固定 33 个 STRING，运行期不收缩**。
- 每卡端口文本 = 外部 `card_in_i`（非空）→ 该卡优化槽（`useOptimized`）→ 默认正文；再按节点规范 `_ph_compile_card` 只替换引用写法。**「合」关掉的卡只影响合并，端口照常输出**。
- 三个自动优化开关（`autoTextgen/autoApi/autoLlama`）**互斥**，前端开一个自动关另两个、后端发现同开多个直接报错；三个全关 = 一定不优化。`clearCache` 独立，只清 PromptHelper 自己的 CLIP/llama 缓存。
- 优化分两层：**整体（先合并再优化一次）**；分卡只在卡片弹窗手动点。优化失败**抛 ValueError**（看 `logs/comfyui.log` 的 `[PromptHelper]`）。
- 设置存节点 config：`optimize`（含 `apiParams`）/ `rules`（mergeSep + 规范表）/ `ui`（dock 等）；卡片存档 `user/EzFlex/prompts/<名称>.json`（名校验 + 签名防误删）。
- 引用媒体：编号来自编号引擎，芯片 `span.eph-mref`（图标/文字分节点），`insertMediaRefOnce` 每次插一份。
- 平铺模式：三层浮层加 `.ph-dock`，位置记画布坐标随画布缩放；开关/尺寸/位置存 config（`ui.dock/dockOpen/dockMem`）。**改默认尺寸要 `PH_DOCK_SIZE_V` +1**。
- **XSS（V1.2.3）**：卡片/总体编辑 HTML 经 `ezSanitizeHtml()` 清洗后再 `innerHTML`（保留排版标签与芯片 svg，去掉 script/on*/危险 URL）。
- **卡片按钮 = 插入内容**：卡片弹窗/总体编辑工具栏的「卡片」→ `openCardMgr(node, editor)`（插入模式），**单点 = 选中、双击**把 `contentHTML` 插到光标处，**卡片组的所有卡片合成一块**（`cmInsertSaved`）；插入模式下隐藏「添加卡片/使用卡片」。
- **标签提示**：标签面板「标签提示」开关（localStorage `ezflex.tagHint`）→ 四个输入处打字弹候选（英文+中文），见 §10.6。
- **画师写法**：面板「画师写法」按钮（在「标签提示」后）按库存 `libs[库].artist`（'' / '@' / 'artist:'）→ `tpFmt` 给画师标签（CSV category=1）加前缀，只在插入/已插入框显示，搜索和卡片不变。后端 `_ph_libs_clean` 已放行 `artist`（**要重启 ComfyUI 才持久化**）。
- **面板布局**：工具栏行 = 标签库下拉（排第一、不写字只悬停提示、变窄时**先压它**）→ 搜索（`flex:0 1 130px`，尽量留着）→ 筛选/排序/+添加标签/标签提示/引用画师；四个小图标单独一行（收起分组栏只收这行）；标题栏只有「全屏 / ✕」。
- 标签系统语义 / 规则 / 存储：完整口径见 §10（两套空间：库侧 `place/fav/meta`，我的侧 `mine` 副本；伪行 全部/已收藏/我的标签；固定真节点「未分类」；**临时分类已删除**）。当前 PH_BUILD = 2026-09-26-v129。
- **总体编辑单卡折叠 / 标签批量移除预览图**：小标题行标题框后面加一颗 chevron（`.eph-all-fold`）单张收正文，状态按卡片 id 记在 `_allClosed`（重建块还原、删卡即清）；工具栏那颗仍是全局收起**小标题行**，两者靠 `.eph-all:not(.collapsed)` 隔开。标签批量栏加「移除预览图」（`tagRemoveSelPreviews`，按名字去重删记录 `preview`，二次确认）。生成预览图是**覆盖**（`t.preview = …`，非追加）；**删除标签时**预览 base64 随 `tpDropPreview` 一起清掉（清完没别的含义的空记录整个回收），其余操作不自动清，只落在 §10.9 的 `ezflex_prompt_tags.json`。
- **随机 tag**：工具栏「排序 | 随机 | ＋新增标签」。弹窗每行 = [分类按钮（点开 = 与「移动至」同一套 `tpCatPickMenu` 右侧层叠菜单，树根 CSV 分类 / 细分大类）+ 数量（居中、无上下箭头）+ 开关 + 减号]，右上「恢复默认随机组 / ＋新增随机分类」，右下「保存随机设置 / 生成随机tag」。弹窗里改的是**草稿**，点「保存随机设置」或「生成随机tag」才写 localStorage `ezflex.randGroups`（键 `{cat,n,on}`；关闭不保存）。默认六组 = 画师(`c1`)/角色(`c4`)/人物/服饰/表情动作/场景。生成按组抽样；标签面板「生成随机tag」先清掉已插入的标签再生成（不再累加）。右键入口三处：卡片菜单（在「编辑标签」和「生成预览」之间）/ 卡片区空白 / 已插入芯片面板空白。卡片弹窗工具栏在**「合」前面**加了「自动随机tag」（绿 = 运行期每次排队按当前设置重写本卡内容、灰 = 不重写；按卡片记 `autoRand`）和「随机tag」（单点：清空本卡再生成一次）——两者都**先清空再生成**。运行期随机在 `api.queuePrompt` 包装里做（`phRandPatchPrompt`）：**既改本次提交的 prompt（执行用这一份，不动磁盘上的工作流），也写回画布上的卡片**（`card.content` 覆盖 + `syncToConfig` + `refreshUI`，打开着的卡片弹窗同步换掉），所以执行完能看到随机结果、也能接着编辑；抽不到 tag 时**不清空卡片**并在控制台 warn（提示检查随机组 / 标签库）。HTTP API 直连不经前端则保持原内容。
- **实时接收卡**：卡片右键「实时接收文本卡（可编辑）」= 卡片 `liveIn`。接了 `card_in_i` 时**不变灰、正文可编辑**（其他卡照旧"覆盖 + 置灰"）；运行期**以卡片正文为准**（正文空才用外部输入兜底），并把收到的原文用 `ui.recv = [{id,text}]` 回传：前端在源变了时刷新卡片、源不变时**保留你在卡片里的临时编辑**（例如临时加个提升触发概率的词，不动 LoRA 本身的触发词）。**运行期三个自动优化一律不作用到实时卡**：只输出它的默认正文，不单独优化、不用优化槽，也不进整体优化的输入（整体优化结果里再把它的原文原样拼回去）。前端还会在 **ModelsCombo 配置变化 / 连线变化 / 载入**时直接按上游配置拉触发词（`phPullLiveCards`，metadata 按 file 缓存），**不用等运行**就能刷新。
- ⚠️ `_ph_libs_clean` 必须保留 `libs[lib].groups/place/fav/meta`、`_ph_tags_clean` 必须保留 `mine`（曾漏 → 库分组树/归类每次保存被冲掉、删掉的标签刷新又回来）；`tag_store_test.py` 钉住。

### MediaLoader / MediaOut
- Loader：每卡一个 `EZFLEX_MEDIA_CARD` 端口（深红）。取值与内置节点同款：图像 `[1,H,W,3]` float32、视频 `VideoFromFile`、音频 `{"waveform":[1,C,T],"sample_rate", "path"}`（**必须带 batch 维**）、3D `Types.File3D`。
- `/media_loader/serve` 用 `Cache-Control: private, no-cache`（协商缓存，别改回 no-store）。3D 缩略图缩到 480px 再用 JPEG；ResizeObserver 重排后必须重画。
- Out：4 模式 `split/card/row/group`；多文件合并成下游能吃的值（图片批张量、音频按时间拼接、文本换行、不兼容报错）；`{off:[id]}` 局部禁用；批量设置 `{size,fit,cap,start}`。端口写 `sock._ezFiles` 供编号引擎。
- 运行期空传：前端在 `api.queuePrompt` 包装里把指向禁用端口的输入从 prompt 摘掉（保守：没盖章/混合/找不到节点不动）。

## 3. 存储与路由

- 命名预设统一走 `_register_preset_routes(node_name, api_path)`（GET 列表 / POST 同名覆盖 / DELETE；`user_data/<节点名>.json`，`utf-8-sig` 读）：`/models_combo/presets`、`/freelatent/presets`（带 custom_ratios）、`/nodeswitch_master/presets`、`/main_control/presets`、`/param_preset_control/presets`、`/media_loader/presets`。
- `/freelatent/presets/default`（V1.2.3）：GET 读 / POST 设或清（`{clear:true}`）FreeLatent 默认预设。
- 动态输出同步（前端 POST，带 `_EZ_OUTPUT_CAP` 上限 + 名字截断）：`/models_combo/outputs`、`/param_preset_control/outputs`、`/param_preset_output/outputs`、`/preview_any/outputs`、`/media_loader/outputs`、`/media_out/outputs`。`/prompt_helper/outputs` 已删。
- PromptHelper：`/optimize`、`/custom_providers`(GET/POST/DELETE)、`/api_hosts`、`/pick_folder`、`/pick_skill`、`/scan_roots|scan_paths|model_paths`、`/llama_models|clip_models`、`/prompt_cards`。
- MediaLoader：`/files`、`/browse`、`/serve`、`/upload`、`/open`、`/save_as`、`/pick_folder`、`/roots`。PreviewAny：`/serve_video|serve_3d`、`/3d/{path}`、`/fs/{path}`、`/folders`、`/open`、`/pick_folder`。ModelsCombo：`/preview`、`/lora_meta`、`/lora_meta_detail`。
- 全局持久化：全部收在 `user_directory/EzFlex/` 下（`ezflex_scan_paths.json`、`ezflex_model_paths.json`、`ezflex_custom_providers.json`、`ezflex_api_hosts.json`、`ezflex_save_roots.json`、`ezflex_media_roots.json`、`ezflex_media_target.json`、`ezflex_prompt_rules.json`、`ezflex_prompt_categories.json`、`ezflex_prompt_tags.json`）；卡片存档 `EzFlex/prompts/<名称>.json`。旧的散落在 `user/` 根下的同名文件由 `_ezflex_user_file()` 首次访问时自动迁移（`_dev_tests/user_dir_test.py` 守着）。
- web 静态由 `_serve_no_store` 覆盖，刷新即生效。

## 4. 媒体取值契约（勿回退）

IMAGE `[1,H,W,3]` float32；VIDEO `VideoFromFile`；AUDIO `[1,C,T]` + `sample_rate`（+ 非标准 `path`）；FILE_3D `File3D`；MediaLoader 卡片 = `EZFLEX_MEDIA_CARD` dict（只给 MediaOut）；MediaOut 单类型口 = 对应内置类型，混合口 = `*` + 运行期报错。

## 5. 避坑（只留结论）

1. **动态端口**：类 `RETURN_TYPES` 全局共享；动态端口节点统一用 `_DynamicOutputTypes`（越界槽位返回 `*`，不再 `IndexError`），ParamPreset 两兄弟的同步「只增不减 + 动态槽统一 `*`」；PromptHelper 用固定 33 张表。重排 socket 后必须遍历更新 `origin_slot/target_slot`；按逻辑 id（`_ezGroupId/_ezParamId/_ezCardId/_ezMediaId`）复用。`hideConfigWidget` 直接把 `config` 输入口从 `node.inputs` splice 掉（`hidden=true` 不生效）。
2. **Vue / 经典**：`addDOMWidget.canvasOnly = !window.__ezflexIsVueNodes()`；面板穿透靠常驻 CSS（`!important` + `:has()`）；Vue 壳要带 title 偏移（`top:30px; height:calc(100% - 30px)`），**凡往壳上写内联 important 都要自带该偏移**；经典/Vue 的空白拖动与滚轮**分开实现**。
3. **媒体编号**：按目标生成节点自己的端口顺序、按类型各自从 1、只数已连接；节点标识用标题（**不显示 #id**）；端口类型端口名优先、文件类型扩展名优先；`startIndexWatcher` 要传真实节点（否则 onDrawForeground 兜底不生效）；`EzFlex-MediaOut/MediaLoader` 命中即终止上溯；端口没盖 `_ezFiles` 时不要退回「整张卡片」。
4. **@ 芯片**：每次插一份（`insertMediaRefOnce`）；用 Range 插入而非 `execCommand('insertHTML')`；插入前 `range.deleteContents()`；`@` 从最后一个 `@` 起算；改编号只改 `.eph-mref-txt`（写 `sp.textContent` 会抹掉图标）。
5. **总体编辑 contenteditable**：块首退格/块尾删除会破坏结构 → keydown 拦截 + `data-cardId` + `healAllEditor()` 三道防线。
6. **层级弹窗**：`_phLayers` 栈 + capture 协调器，只关「按下前已打开」的层、拖动不关、一次只关最上层；平铺层（`.ph-dock`）显式放行。
7. **坐标换算用 canvas 元素**（`app.canvas` 本身没有 `getBoundingClientRect`）：`screen = (画布坐标 + ds.offset) * ds.scale`。
8. **后建控件要能点**：常驻 CSS `.ezfx-panel-shell button,…{pointer-events:auto!important}`；定时重建前先算内容签名，别把正在点的 DOM 删掉。
9. **`ui` 契约：每个键的值必须是列表**（后端一律 `"key": [value]`，前端取 `[0]`）。
10. **优化/跑错不要只 print**：PromptHelper 优化结果就是主输出，失败要抛 `ValueError`（否则表现为静默空提示词）。
11. **别留「UI 看不见、后端还认」的开关**（历史 `textgen.enabled`）；**预览类型更新要主动跟**（MESH/SPLAT/VOXEL、真 CONDITIONING 是 `[[cond, {…}]]`）。
12. **DOM 控件要在「状态 → UI」函数里回填**：`setupNode` 先于 config 恢复，只在建面板时写一次会一直显示默认值。
13. **排布节点别用 `node.pos` / `getBounding()`**：视觉顶 = `pos[1] - NODE_TITLE_HEIGHT`；`getBounding()` 在未 measure 时是脏值。
14. 删死代码要**精确匹配 + 断言**（曾批量误删致 NameError）；静态扫描把 `_dev_tests/` 一起算。
15. 3D 用**本地离线** three.js（`web/libs|utils|curves`），serve 走 `/preview_any/3d/{path}`。
16. **socket 黑框标签**（5 个节点各一份 `installSocketLabels`，改要一起改）：显隐判断必须用**当前渲染的图** `app.canvas.graph`（`|| app.graph` 兜底）——用 `app.graph` 会把子图里的标签全隐藏；`_ezRoot` 未连接或 rect 无效时要 **hide 标签再 return**，不能直接 return（否则快速平移、控件被临时摘掉时标签会冻在屏幕上，看着像粘在左侧工具栏）。

17. **行尾注释别吞语句**：`… // 说明 p._tpPage = pgBar;` 会把赋值整句吃掉（标签翻页栏空了一整版）；赋值/调用一律单独一行。
18. **批量正则改 CSS 要自检**：脚本拼 `"background" + 捕获组` 出错会写出 15 处 `backgroundundefined:`（非法声明 → 元素丢背景，深色下看不见）；改完扫一遍 `undefined:` 并做深色主题回归。

## 6. 性能设计（EZ_PERF）

- 交互期 `pumpFrames(ms=300)`：醒后 300ms 内每帧更新，停手自动停 → 静止零开销；触发源 = `setDirty` 补丁 + 画布 pointer 事件 + resize/scroll/`ezflex:changed`。**只靠 `onDrawForeground` 会慢一拍**，必须配 pumpFrames。
- 轮询全删，改画布重绘 + 事件驱动；媒体索引合并到帧（`refreshIndexSoon`，打开引用面板前 `refreshIndexNow`）。
- 总开关 `EZ_PERF`（`web/ezflex_service.js`）：`labelFallbackMs/mainPollMs/indexPollMs/groupPollMs` 默认 0、`render3d:'ondemand'`；出问题只改常数即回旧行为。

## 7. 待办

- [ ] 临时预览文件（`ezpv_*`，含 `ezpv_vid_*`）自动清理（真实占磁盘）。
- [ ] FreeLatent：DOM 类型下拉切 lora 不自动补 `targetId`（LoRA 静默跳过）——待修。
- [ ] PromptHelper：全/半角转换用 `textContent` 整段替换，会丢格式与 @芯片——待修。
- [x] 死代码清理：ModelsCombo 不可达 canvas 簇（343 行）、`setDims`、`import zlib`、每节点调试日志、3 条冗余 CSS 已删（V1.2.6）；剩未用后端方法待清。
- [ ] Vue 黑框标签叠加层按 Vue 端口坐标再校准。
- [ ] MediaOut 可选增强（`count`/`image_path` 输出、JPEG/WebP 元数据、登记历史画廊）。
- [ ] PromptHelper 规范缺「画面构成 / shot at 时间」字段；`rules` 全局复用（`userdata/ezflex_rules.json`）。
- [ ] 综合媒体端口目前只计数/引用，不参与合并文本。
- [ ] 图生图/视频生视频、图像缩放等后续节点。
- [ ] 提示词规范缺官方条目（素材数量/时长上限、字幕/水印约束、Kling 长度上限、负面提示词处理等）。
- [ ] 仓库待 `git push`（V1.2.10）。
- [ ] 富文本仍用 `document.execCommand`（弃用但可用）。
- [ ] 从 HTTP API 直接排队（不经前端）时，MediaOut 禁用端口仍是 `None` 语义（README 已说明）。

## 8. 本地验证

```powershell
$root="<ComfyUI>"; $py="$root\.venv\Scripts\python.exe"; $d="$root\custom_nodes\Comfyui-EzFlex-Presets"; $t="$d\_dev_tests"
$env:PYTHONIOENCODING="utf-8"
New-Item -ItemType Directory -Force -Path "$t\_tmp" | Out-Null   # 干净检出也能跑：下面 JS 语法检查的副本放这
& $py -c "import ast,io; ast.parse(io.open(r'$d\__init__.py',encoding='utf-8').read()); print('PY OK')"
& $py "$t\undefined_names.py"; & $py "$t\route_audit.py"
foreach($f in (Get-ChildItem "$d\web" -Filter *.js -Recurse)){ $tmp=Join-Path $t "_tmp\chk_$($f.BaseName).mjs"; Copy-Item $f.FullName $tmp -Force; node --check $tmp }
foreach($s in @('loader_contract_test.py','media_merge_test.py','preview_fastpath_test.py','preview_save_test.py','preview_types_test.py','prompt_helper_test.py','prompt_helper_dock_test.py','ui_ux_test.py','dynamic_types_test.py','route_security_test.py','i18n_test.py','cjk_scan.py','py_ui_audit.py','tag_store_test.py')){ & $py "$t\$s" }
foreach($s in @('import_test.mjs','media_out_prune_test.mjs','media_index_test.mjs','preset_mode_test.mjs','tag_panel_test.mjs')){ node "$t\$s" }
```

- 基线：**17 套件 + 4 个静态扫描全绿**。`_dev_tests` 不入库（见 `.gitignore`）：测试里写死了本机 ComfyUI 绝对路径，换机器跑不了。旧会话留下的 `_tmp`（一次能到 16 MB / 800 文件）与 `extensions|scripts` 全是跑测试自动生成，已清；随时可删、别提交。

| 文件 | 钉住什么 |
|---|---|
| `loader_contract_test.py` | MediaLoader 三个加载函数与内置节点同款：图像 `[1,H,W,3]`、音频 `[1,C,T]`、视频 `VideoFromFile` |
| `media_merge_test.py` | MediaOut 卡片/卡片组/分组：图片→批量张量、音频→拼轨、文本→合并；类型/尺寸不一致明确报错 |
| `preview_fastpath_test.py` | PreviewAny 文件型视频/音频不重新编码 |
| `preview_save_test.py` | PreviewAny 存档：存原图、PNG 带 workflow/prompt、格式转换也从原图转 |
| `preview_types_test.py` | 98 条「ComfyUI 能产出的值类型」都能被 PreviewAny 接收，已知类型不许落裸 repr |
| `prompt_helper_test.py` | 合并规则（mergeSep/空卡/card_in）+ 卡片存档往返与名称拒绝 + API 参数映射 + 媒体收集 + 规范编译 + 运行期优化矩阵 |
| `prompt_helper_dock_test.py` | 平铺态四个浮层的记忆/恢复、尺寸版本闸、`_phOnClose` 落盘 |
| `ui_ux_test.py` | 平铺 / 中英实时切换 / 工具条收起 / 卡片弹窗标题 / Nodes2.0 可点的静态接缝 |
| `dynamic_types_test.py` | `_ez_sync_dynamic_types` 两条不变量：长度只增不减 + 动态槽统一 `*` |
| `route_security_test.py` | 48 条：路径逃逸/根外转存/本机限/Origin null/跨站/scheme、apiKey 掩码、upload 限制、outputs 截断、重定向逐跳、出站白名单 |
| `i18n_test.py` | schema 文案全英文；`ezT` 词条与 `EZ_ZH` 一一对上（现 998 用 / 1341 有）；`_i18n/*.json` 已并入 |
| `tag_store_test.py` | 标签分类树/库分组树/记录存盘往返（含 `collectedFrom`、preview 上限、非法名称拒绝） |
| `import_test.mjs` | 按 `/extensions/EzFlex/` 深度导入真实模块，抓漏 import / 循环依赖 / 模块级报错 |
| `media_out_prune_test.mjs` | 运行时把「已禁用但仍连着」的输入从提交 prompt 摘掉，画布/连线/工作流不动 |
| `media_index_test.mjs` | 媒体编号引擎：按端口类型各自从 1、命中即终止上溯、端口没盖 `_ezFiles` 不退回整卡 |
| `preset_mode_test.mjs` | 基础预设按 config key 判定（不能用中文名比 mode） |
| `tag_panel_test.mjs` | 分类树新建/嵌套、库分组树、切库不丢、全选按完整匹配、标签提示（单字/中文/热度门槛/懒查）、翻页栏槽位、恢复默认标签/库 |

- 静态扫描：`undefined_names.py`（模块级用而未定义的私有名）、`route_audit.py`（路由注册去重/命名）、`cjk_scan.py`（JS 非注释中文 = 待翻）、`py_ui_audit.py`（`__init__.py` 用户可见中文）。
- 数据/词典重建脚本（留在 `_dev_tests/`；平时不跑，改数据才跑）：`_gen_tag_kind_from_wiki.py`（Danbooru wiki tag_group → `PromptHelperLib/_tag_kind.csv`，40720 行 / 8 大类）、`_gen_tag_kind.py`（同表的关键词规则版，wiki 版没覆盖的沿用它的 kind）、`_gen_zh_from_danbooru.py`（中文对照 → `_zh_CN.csv`，~61823 条）、`_i18n_merge2.py` + `_i18n/*.json` + `_i18n_base.json`（确定性重建 `web/ezflex_i18n.js` 的 EZ_ZH）。
- 标签系统的数据 `user_data/PromptHelperLib/*.csv`（12 个：8 个标签库 + `_tag_kind` / `_zh_CN` / `_e621_species` / `_furry_extra`，约 26 MB）**必须随仓库走**，否则标签面板既没库也没中文；`.gitignore` 只放行这一类 CSV。
- ⚠️ 源文件改写别用 PowerShell `Get-Content/Set-Content`（会毁编码），用编辑器或 Python `newline=''`。验证 JS 的副本要放工作区内（`_tmp`），别用 `%TEMP%`。

## 9. 安全与发布

**已收口**
- 路径包含性：`_ez_real/_ez_roots/_ez_inside`（realpath + commonpath，覆盖 `..`/绝对/兄弟前缀/符号链接）；`/preview_any/serve_video|serve_3d|fs|3d|folders`、`/media_loader/serve|browse|save_as` 限根。
- 本机限定 `_ez_local`：回环 remote + 回环 Host + Origin/Referer 同源 + 拒 `Origin: null` 与 `Sec-Fetch-Site: cross-site`；覆盖 `open/pick_folder/pick_skill`、各配置写入、根登记；**V1.2.4 再补 25 条**（模型预览 / lora 元数据 / `preview_any` 文件与目录 / `media_loader serve|browse|files|upload` / 各 `*/outputs` / FreeLatent 默认预设 / 用户数据 GET）。有意不限本机的只剩 `/prompt_helper/media_target`（无敏感路径）与公开标签表。
- 出站：`_ph_check_outbound` 主机允许列表（内置厂商 + 本机登记）+ **仅 http/https** + 每跳重定向校验 + 代理也校验；`?root=` 仅本机；模型解析 `strict`（远端只认登记根）。

**V1.2.6 变更**
- 主题系统（新）：`web/ezflex_theme.js` 定 16 套配色（浅色=原配色 / 藕荷 / 青苔 / 北境 / 极简冷灰 / 暖白焦糖 / 冷灰雾蓝 / 深空黑 / 莫兰迪紫灰 / 人鱼核 / 巧克力棕 / 克莱因蓝 / 云舞白 / 香蕉黄 / 勃艮第红 / 深青绿），每套给五级表面 + 三级描边 + 四级文字 + 状态色（`readable()` 对比度兜底）；切 `data-ez-theme` 全画布即时生效（localStorage `ezflex.theme`，默认浅色，入口在 MainControl 头部 en 右侧）。全部面板 CSS 只用 `var(--ez-*)`；原生控件用 `:where()` 兜底层补 `color` + `color-scheme`（系统下拉/滚动条也随主题明暗）；2D canvas 用 `ezThemeColor()/ezThemeAlpha()` 取实际色值。
- FreeLatent：画布颜色跟主题走（`onThemeChange` 触发重画）；网格按需抽稀（每格不足 6px 就把步长翻倍，不再整块不画）；画布边界改完整方框、选区矩形坐标取整（四边等宽）；预设下拉固定向下展开、跟随按钮重摆，点画布/滚轮/删节点/清空工作流都会收，第二下能收起。
- 标签预览：生成后只保存一次（原来 `tpSetMine` 内部先存一次不含预览、紧接着又存一次，两次互不等待，先发的后到会把预览覆盖回旧内容）。
- 标签面板翻页栏：`p._tpPage = pgBar` 曾被行尾注释吃掉 → 页码 / 「每页」输入整栏空白，已复原。
- 存储收口：`user_directory/EzFlex/` 统一放 10 个 `ezflex_*.json` + `prompts/`（卡片）；旧位置散落的同名文件由 `_ezflex_user_file()` 首次访问自动迁移（不覆盖新文件），`_dev_tests/user_dir_test.py` 守着这条规则。
- 清理与修复：ModelsCombo 不可达 canvas 面板/画布菜单/拖线簇（343 行）、`setDims`、`import zlib`、每节点调试日志、3 条冗余 CSS 已删；修 15 处 `backgroundundefined:` 坏声明（声明非法 → 元素丢背景，深色下看不见）。
- 界面微调：卡片弹窗工具栏 `skill` 移到「合」前；总编辑工具栏尾部顺序改「收起小标题 | 卡片 | 标签 | skill | ＋新增卡片」；FreeLatent 预设项悬停不再上浮、不改文字色；星星恢复亮金 `#f6c343`。

**V1.2.5 变更**
- 标签系统：工具栏「排序 | 随机 | ＋新增标签」加「随机」弹窗（每行 分类层叠选择 / 数量 / 开关 / 减号；右上 恢复默认随机组 / ＋新增随机分类；右下 保存随机设置 / 生成随机tag）；卡片菜单与卡片区空白、已插入芯片面板空白加「生成随机tag」；配置存 localStorage `ezflex.randGroups`（弹窗内是草稿，保存/生成才落盘）。默认六组 = 画师 `c1` / 角色 `c4` / 人物 `k:person` / 服饰 `k:clothing` / 表情动作 `k:expression` / 场景 `k:scene`。生成一律**先清空再生成**（标签面板清已插入标签；卡片单点清本卡正文），并写回当前卡片。默认标签库 CSV 随包（`user_data/PromptHelperLib`）。删标签 / 批量「移除预览图」清预览（`tpDropPreview`）。
- 运行期随机：卡片弹窗「合」前有「自动随机tag」（绿=生效，按卡片记 `autoRand`）与「随机tag」（单点）。自动随机在 `api.queuePrompt` 包装里做：既重写本次提交的 config（`content` 覆盖 + 清优化槽 + 滑块回默认），也写回画布卡片（`syncToConfig`+`refreshUI`，弹窗开着就同步编辑器）；抽不到 tag 不清空、控制台 warn。HTTP API 直连不经前端则不变。
- ModelsCombo 触发词：`_lora_trained_words()` 取触发词（顶层 `trainedWords` 空则退 `civitai.trainedWords`，再退 `activation_text`）；配置里有 lora 行就加**固定的末尾 STRING 口 `trigger_words`**（按 LoRA 顺序拼、跳过空的；不动前面 model/clip/vae 顺序）。浏览弹窗标签行加「已加载」页 = 按节点已选文件筛出的**普通模型卡**。
- PromptHelper「实时接收卡」（卡片右键，记 `liveIn`）：接 `card_in` 不变灰、正文可编辑，运行期以正文为准（空才用外部输入兜底），`ui.recv` 回传、源变才刷新；**三种运行期优化一律不作用到它**（原文原样并入，不送优化输入）。前端在 ModelsCombo 配置变化 / 连线变化 / 载入时直接拉触发词（`phPullLiveCards`，按 file 缓存），不必等运行。
- 修复：黑色 socket 标签子图不显示 + 快速平移残留 —— 5 个节点各一份 `installSocketLabels`，显隐判断改用当前渲染图 `app.canvas.graph`（`|| app.graph` 兜底），`isConnected`/rect 无效时 **hide 而非直接 return**，出图由 remove 改 hide（回来还能显示）。
- 总体编辑：单卡折叠（小标题行 chevron，按卡片 id 记状态）。

**V1.2.4 变更**
- 后端：修 `prompt_queue.put` 队列项少一个元素（`prompt_worker` 取 `item[5]` 抛 IndexError → 执行线程退出 → 之后所有排队任务都不跑、生图永远 0/1）；删 4 个零引用静态方法（`_video_to_webm_np`/`_video_np_summary`/`_model_file_path`/`_format_meta`）。
- 前端 Prompt Helper：标签面板接入 dock 体系（`PH_DOCK_ORDER` 加 `eph-tp`，按节点记录/恢复，随工作流载入秒恢复）；归类菜单改右侧层叠（Windows 风格）；平铺态 `focusout` 自动保存（弹窗态保持"取消=丢弃"）；卡片右键在批量选中时按整批处理；引用媒体标题带 `#序号 · 卡片标题` 并实时同步；新建/切换工作流时收掉挂在旧节点上的浮层。
- 生成预览：内置工作流每次按设置重建（模式/LoRA/VAE 改了都生效），unet 模式改用独立 VAE（原来固定取 checkpoint 的），只接受 API 格式的 api.json 导入并给悬停提示。

**V1.2.3 新增修复**
- PreviewAny 存档：后缀白名单 `_SAVE_ALLOWED_EXTS`；绝对 `savePath` 收敛到 output/本机登记目录（`_pv_save_roots`，`pick_folder` 时登记），回落 output 并提示。
- `GET /prompt_helper/custom_providers`：非本机响应**不下发 apiKey**。
- `POST /media_loader/upload`：只收媒体后缀、单文件 4 GiB 流式写盘、重名不覆盖（`_ml_unique_name`）。
- 存储型 XSS：`ezSanitizeHtml()` 清洗 ModelsCombo 模型描述与 PromptHelper 卡片/总体编辑 HTML；`isUnsafeUrl()` 挡 `javascript:` 等。
- `*/outputs` 统一 `_EZ_OUTPUT_CAP` + 名字逐条截断。

**仍保留/有意不改**
- `_ez_local` 只比主机名、不比端口（本机跨端口页面在 `--enable-cors-header` 下可借；默认中间件会拦）。
- 跨站写路由的 CSRF 依赖 ComfyUI 默认 `origin_only` 中间件；插件侧未再强制。
- `/preview_any/open` 接受任意绝对路径（已本机限，Popen 用 list 不进 shell）；根内读取不限本机；`browse/folders` 对远端泄露绝对路径。

**发布**
- `pyproject.toml`：`version` 必须三位 `X.Y.Z`；`license = { file = "LICENSE" }`；`[tool.comfy] PublisherId` 走 Registry 必填、只给 Manager 提 PR 则不需要。
- i18n：源码英文，中文进 `locales/zh/nodeDefs.json`（节点 schema）与 `web/ezflex_i18n.js` 的 `EZ_ZH`（面板）；词典由 `_dev_tests/_i18n/*.json` + `_i18n_merge2.py` 确定性重建。新增 `ezT` 词条要同步词典，否则 `i18n_test.py` 会挂。

## 10. 标签系统（PromptHelper，规范 + 状态）

> 目标行为 + 当前实现；与旧注释冲突以本节为准。前端 `web/prompt_helper.js` ｜ 后端 `__init__.py` ｜ 词典 `web/ezflex_i18n.js`。静态文件 no-store 直发：**改完刷新页面即可**；后端字段改动才要重启 ComfyUI。

### 10.1 数据模型：两套空间
同一个标签可同时存在于「库」和「我的标签」，**允许重复**；卡片键 = `side + ':' + 名字`，同一个名字在「全部」里出**两张卡**（各自收藏、各计一次）。
```
_tagDoc.categories                 // 我的分类树（含 __uncat__ 未分类）
_tagDoc.tags[]                     // 一条名字一条记录
  mine: true                       // 存在我的标签副本；没有就是只承载库侧元数据
  category                         // 我的副本的分类 id（'' = 未分类）
  fav                              // 我的副本的收藏
  zh color weight                  // 我的侧显示覆盖（编辑我的卡片写这里）
  preview                          // 两侧共用（base64，存记录里，不落盘）
_tagDoc.libs[libId] = { name, groups, place{名→分类id}, fav[名], meta{名:{zh,color,weight}}, hidden[名], disabled }
```
- 显示取值：**库侧 = `meta` → 自动中英（不看记录）**；**我的侧 = 记录 → `meta` → 自动中英**；预览图两侧都取记录。
- 伪 id：`__all__`(全部) / `__fav__`(已收藏) / `__mine__`(我的标签根) / `__lib__`(库根，运行时) / `__uncat__`(未分类，真节点)。**临时分类已删除**，恢复默认回收直接进未分类。
- 计数：库行按 `place` 或默认位置（细分大类 / CSV 桶）各一次；我的行按 mine 副本各一次；**全部 / 已收藏 = 两侧相加**；父分类数字 = 自己 + 子树。
- 旧数据迁移 `tpMigrate()`（加载时一次）：`from===''` → `mine`；`from==库id` + `category` 是 `k:`/`c0..c5` → 写 `place`；`from==库id` + 是我的分类 → `mine`；只有 `fav` → 写 `fav`；迁移后删 `from`。**`from` 字段不存在 = 已迁移（或刚删除），不能再推回 mine。**

### 10.2 左栏结构
第一层固定四个：**全部 / 已收藏 / 我的标签 / 库(真实库名)**；都可重命名，但「我的标签」「库」不可拖动 / 删除。
- 我的标签下：**未分类（固定节点）** + 自建分类（可嵌套）；库下：CSV 桶(通用…meta) + 细分大类(人物…画风) + 库内自建分类。
- 未分类：能改名、能在下面新建分类；**不能移动、不能删除**；子分类是普通分类。恢复默认回收的标签按**原分类层级**挂在它下面。
- 层级用真实缩进（`4 + depth*14 px`），展开三角在**文字右侧**；我的侧折叠用 `_myClosed`（默认展开），库侧用 `_libOpen`。四个小图标：展开 / 收起（两侧一起）、树·列表、收侧栏。

### 10.3 归类规则
标签（`tagMoveTo`）：目标在我的侧 = **复制**一份到我的标签（库内那份不动）；目标在库侧 = 改**库侧那份**的归类（副本不动）。
分类（`catMoveTo`）：
- 库 → 我的标签 = **复制整棵子树**（新 id）+ 给这支里的库标签建我的副本（按 `place` 或默认位置）；库侧分组 / `place` **全不动**。
- 库 → 库 = 正常移动；我的 → 我的 = 正常移动；我的 → 库 = 搬到库侧（写 place、去 mine）。
- 候选菜单 `tpCatPickMenu` 是**右侧层叠**的（Windows 右键那种）：第一栏列两个根，移上去/点一下往右开新栏；新栏第一行是**该分类自己**（点 = 放到这里），下面是它的子分类，递归；叶子点一下直接选中，当前所在分类高亮。编辑/新增标签的分组下拉与「移动至」同一套。
- 「我的标签」来源共 6 条：芯片保存 / 新增标签 / 右键库标签卡「移动至」我的侧 / 右键库分类「移动至」我的标签（复制）/ 拖动库标签到我的侧 / 拖动库分类到我的侧（复制）。
- 同一层级不允许同名分类（新建 / 重命名 / 移动后都要唯一，`catUniqName`）；分类 id 用 `cmCatId()`（带随机后缀，别只时间戳）。

### 10.4 收藏 / 删除
- ★ 按卡片的 side 收藏，两侧独立。筛选/排序菜单选中项必须写 `'✓ ' + 文案`（开头打勾才会被 `cmMenu` 渲染成 `.on`）。
- 删卡片：库侧原有 → 记 `hidden`；库侧我加的 → 去 `place`；我的副本 → `tpMineDrop`（若还有库侧元数据则留记录）。删除时一律再走 `tpDropPreview` 把**预览图一起清掉**（base64 不留在 json 里；预览可重新生成）。注意 `tpMineDrop` 也被「我的分类 → 库」移动调用，那条路径**不清预览**。
- 删分类 = 里面的 mine 副本一起删（库侧元数据记录留着）；库侧 `place` 指向它也清掉。

### 10.5 恢复默认
- **恢复默认标签**（库侧卡片菜单）：取消隐藏 + 清 place + 删该名字的库侧 `meta`（有我的副本就只清库侧；没有副本才连记录里的覆盖一起清）。**收藏不动。**
- **恢复默认库**（我的标签根 / 库根 / 库下拉）：先把库内自建分类里的标签 + 原库分类下新建的标签，按原分类层级回收成**未分类下的分类树**；再删 `groups/place/hidden/meta`（**两侧收藏都保留**），并把没有副本的库内记录的 `zh/color/weight` 清掉（预览留着）。

### 10.6 功能清单（一屏）
- 库下拉右键：生图设置… / 导入标签库… / 重命名库 / 删除库(停用) / 恢复默认库 / 设置为默认库。
- 工具行：树·列表 / 搜索 / 筛选(已收藏、排除 e621、排除匹配文字、排除分类) / 排序(默认、名称、数量) / 随机 / +新增标签 / 批量管理 / 展开·收起·收侧栏。
- 卡片点击=插入或取消插入；批量模式或 Ctrl/Cmd/Shift=多选；选中 `.sel`，已插入 `.on`，我的副本是**虚线框**；批量选中时**右键也跟着整批**（生成/移动/删除后带数量）。
- 批量模式底部栏：全选 / 反选 / 移动至分组 / 生成预览图 / 移除预览图 / 删除 / 完成。
- 卡片右键：新增标签 / 编辑标签 / 生成预览图 / 移动至 / 批量管理 / [恢复默认标签] / 删除标签。
- 芯片（已插入区）：悬停权重面板（`()[]{}` 加层、数值只用 `()`）、单击手动编辑、长按 300ms 拖动排序、右键(保存标签 / 编辑标签，库内没有的只给保存)。
- 标签提示 `tg*`：卡片编辑器 / 总体编辑 / 搜索框 / 已插入框打字弹候选，懒查 + 滚到底续扫，热度门槛 1字≥1000 / 2字≥100 / 3字不限。
- 搜索框定位：优先记录里的 `category` → 否则找真正包含它的库 → 再按细分/桶算，展开祖先 + 选中 + **翻到它所在那页**。
- **平铺模式**：标签面板也接进统一 dock 体系（`PH_DOCK_ORDER` 加 `eph-tp`），跟节点的 `ui.dock` 走：右侧一块面板、标题栏可拖、右下角可缩放、**跟画布缩放一起缩**、点外侧不关（只能 ✕）、尺寸/位置按节点记忆、**随工作流载入秒恢复**。
- **平铺 ≠ 弹窗（特意的差异）**：卡片弹窗/总体编辑在平铺态**保存 = 原地存下、不关窗**（标签/引用面板留着）并弹「已保存」；弹窗态仍是"存下并关闭"。**自动保存只在平铺态**：编辑器 `focusout` 时写回卡片并同步节点（`editModalCommit` / `syncAllContent`）；弹窗态不自动存，点「取消」仍能丢弃。换卡/换页签/关窗本来就会存。
- 引用浏览器标题带 **`#序号 · 卡片标题`**，改标题时实时同步（`refBrowserCardLabel` + `syncEditModalTitle`）。
- **生成预览**：底部进度条（x/n）右侧有「停止」——点了停掉后续 + `POST /interrupt` 中断当前那张；内置工作流每次按当前设置重建，unet 模式用独立 VAE；只接受 API 格式的 api.json（按钮悬停有提示）。

### 10.7 性能关键点（大库 14 万条）
- `mergedRows` 只在 `_tpSig`（库/分组/搜索/排序/筛选/数据版本）变化时重建；翻页/重画直接用 `_tpView` 缓存。
- `mergedRows` 里名字表 `tagMineOf()` **只建一次**（曾每条库标签建一次 → O(n²)，卡顿主因）。
- 我的标签计数：一次遍历按分类分桶 + 一次后序求子树和（不再每节点 filter 一遍）。`copyTagsToMine` 用同一张名字表边建边塞。
- **kind 父行不要再加 kind 子行**：`libCounts` 给 `k:person/xxx` 计数时已经给 `k:person` 加过，父行只再加**自建**子分类。`libCounts` 结果带缓存（键含 `_tpDocV` + 筛选）。
- 卡片宽度由 `tpCardWidth()` 按容器宽度算"正好整除"值（整行排满、最后一行不被拉宽），`ResizeObserver` 跟面板缩放重算。

### 10.8 踩过的坑（务必看）
1. 后端白名单：`_ph_tags_clean` 必须留 `mine`；`_ph_libs_clean` 必须留 `groups/place/fav/meta`。漏一个保存就静默丢（**要重启 ComfyUI**）。
2. `tpMigrate` 不能用 `String(t.from||'')===''` 判断"老记录"，否则把已删除的记录重新标成 mine（表现：删了刷新又回来）。
3. 同层分类名必须唯一；分类 id 用 `cmCatId()`。
4. 浮层豁免：`_tpOutH` 判断"面板内"要看类名 + `_phLayers`；对话框判定用 `z >= 100010`（`uiPrompt` 是 100150，曾被误判成面板外）。`click/mouseup` 点在自家浮层不要吞事件，否则菜单项"点不动"。
5. 插入面板与卡片弹窗/总体编辑同开：点面板本体不关，点真正空白才一层层关。
6. 新建 `ezT` 文案必须补词条（`i18n_test` 会打印缺失键名）。
7. 别用"括号配对"切函数体改代码（字符串里的 `{}` 会截断）；每次只改一个点 + 立刻 `node --check` + 跑相关测试。
8. 节点被删 / 新建或切换工作流时，挂在它上面的浮层要一起收（`closeEzPanelsForNode` + `LGraph.clear` 兜底），否则会带到下一个工作流里。

9. 标签面板翻页栏靠 `p._tpPage = pgBar` 挂到面板上；这句曾被行尾注释吃掉 → `tpPageBar()` 拿不到 bar 直接 return，页码与「每页」输入整栏空白。

### 10.9 数据与存储
| 内容 | 位置 | 事实 |
|---|---|---|
| 标签库（只读） | `user_data/PromptHelperLib/*.csv` | `tag,category,count,"aliases"`；Danbooru 140779 行 |
| 细分大类 | `.../_tag_kind.csv` | `tag,kind`，40720 行；8 个顶层 person 10025 / object 9479 / clothing 8347 / sex 3617 / scene 3336 / style 2897 / expression 2514 / camera 505；**全部是 `顶层/子类`**，所以默认树里父行 = 子行之和 |
| 中英对照 | `.../_zh_CN.csv` | `tag,zh`；已并到 ~61823 条；中文列 + 中文搜索的唯一来源 |
| 用户数据 | `<user_directory>/EzFlex/ezflex_prompt_tags.json` | `{categories, tags, libs}`；标签预览图 = `tags[].preview`（base64 data URL，单条 <400000 字符；两侧共用；删标签时随 `tpDropPreview` 清掉，其余不自动清）；CSV 永不改写 |
| 生图设置 | `user_data/PromptHelperGen/settings.json` | 工作流 api.json 文本 + 模型/参数/固定提示词。**不入库**（模型路径是本机的）；文件缺失时用代码默认：后端 `_PGEN_DEFAULT`、前端 `openGenSettings` 字面量 + `GEN_DEF_POS/GEN_DEF_NEG`（512²、steps 20、cfg 6、euler/simple、webp/80/384 + 那对 Anime 质量正负提示词；`builtinMode` 默认 `ckpt`）。模型字段留空由用户选，ckpt 模式会自动挑第一个 checkpoint |

### 10.10 待办（标签相关）
- 生图未实测（需要真实 api.json 跑一张）。
- 库分组树没有"只重建骨架、不动 place/fav/hidden"的轻量入口（现在只能「恢复默认库」）。
- 标签提示（`tg*`）未做前缀索引 / 热门词预筛 / 首字母缩写。
