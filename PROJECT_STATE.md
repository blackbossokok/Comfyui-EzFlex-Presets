# EzFlex 插件套件 · 项目交接文档

> 硬数据、无闲聊。改动前先看 §4「避坑」，下一步看 §8「待办」。
> **当前 V1.3.0**（`__version__` 在 `__init__.py` / `pyproject.toml` / README）。
> **⚠️ 经典模式与 Nodes 2.0（Vue）必须分开写作用域**（`.ezfx-is-vue` / `:not(.ezfx-is-vue)`）：禁止写对两种模式同时生效的规则；改一种前先确认另一种不受影响，两种分别回归。（历史：把「面板根穿透」写成全模式通用后，经典模式的滚动条与空白拖动一起被带坏。）

## 0. 环境与生效

| 项 | 值 |
| --- | --- |
| ComfyUI | `0.30.x`；**实跑前端 = Desktop `standalone-env` 的 `comfyui_frontend_package` 1.45.21**（认版本看 `static/assets/api-<hash>.js`）；`.venv` 里是 1.52.7，**只给 Python 测试用、不等于运行版本** |
| venv python | `<ComfyUI>\.venv\Scripts\python.exe` |
| 生效方式 | Python（节点类 / 路由）改动 → **完整重启 ComfyUI**；前端 JS → **Ctrl+F5 强刷** |
| 前端横幅 | 改前端时一并改 `web/prompt_helper.js` 的 `PH_BUILD`；控制台看 `[PromptHelper] module loaded · build …` |
| 依赖 | 必装 `mutagen>=1.46.0`；可选 `llama-cpp-python` / `gguf` / `onnx` / 外部 `ffprobe`（`shutil.which` 探测） |

## 1. 节点与文件

17 个节点，category 全 `EzFlex`。Add-Node 顺序：`MainControl → ModelsCombo → FreeLatent → NodeSwitchMaster → NodeSwitchGroup → ParamPresetControl → ParamPresetOutput → PreviewAny → PromptHelper → MediaLoader → MediaOut → MergeList → SplitList → Reroute → TimeLine → LoopStart → LoopEnd`。
- `__init__.py` 的 `NODE_CLASS_MAPPINGS` 与 `web/ezflex_service.js` 的 `NODE_TYPES` **必须一致**（增删/改名两处一起改）；`node_contract_test.py` 钉住节点契约。
- 后端全在 `__init__.py`。前端：每节点一个面板；共享 `ezflex_service.js`（helpers + EZ_PERF）、`ezflex_media_index.js`（编号引擎）、`ezflex_i18n.js`（词典）、`ezflex_theme.js`（主题）、`ezflex_listview.js`（共享预览壳）。
- 控制类（MainControl / NodeSwitchMaster / NodeSwitchGroup）**纯前端生效**：Python 只承载 config，`run()` 返回 `()`，mode 由浏览器改并随工作流序列化。
- Web 静态由 `_serve_no_store` 覆盖，刷新即生效。

## 2. 关键契约（勿回退）

- **媒体取值**：IMAGE `[B,H,W,3]` float32；VIDEO `VideoFromFile`；AUDIO `[1,C,T]` + `sample_rate`（可带 `path`，**必须带 batch 维**）；FILE_3D `Types.File3D`；MediaLoader 卡片 = `EZFLEX_MEDIA_CARD` dict（只给 MediaOut）。
- **`_ezItems` = 前端「媒体端口」约定**（只有媒体口才写）：写的人 = MediaLoader（每口 `mlPortItems`）/ MediaOut（每口同时写 `_ezFiles`，同值）/ MergeList（合并结果）/ SplitList（每口 1 项）；读的人 = MediaOut / MergeList / SplitList / TimeLine 读 `_ezItems`，**编号引擎读 MediaOut 的 `_ezFiles`**（两个名字各有消费者，别只顾着合并）。**纯数据口（INT/FLOAT/LATENT）不要盖** —— 否则 MediaOut、MergeList 会把描述当素材项。
- **端口盖章优先**：编号引擎 `readLoaderSlot` 先读 `sock._ezItems`，读不到才退回 config 的 `cards[slot]`（后者只在「按卡片」输出模式下 slot↔card 才对得上）。
- **动态输出**：统一用 `_DynamicOutputTypes`（越界槽返回 `*`）；口数由前端 POST `/xxx/outputs` 同步类 `RETURN_TYPES/NAMES`（带 `_EZ_OUTPUT_CAP` 上限 + 名字截断）。PromptHelper 例外：固定 33 个 STRING，运行期不收缩。
- **`ui` 契约**：每个键的值必须是列表（后端 `"k": [v]`，前端取 `[0]`）。
- **坐标换算用 canvas 元素**（`app.canvas` 本身没有 `getBoundingClientRect`）：`screen = (画布坐标 + ds.offset) * ds.scale`。
- **面板状态别占 config 输入口**：状态放 `node.properties`（LiteGraph 随工作流序列化）或 config widget；config 被画成输入口时用 `stripCoreSockets` 每帧清（Vue 下会被 hydrate 补回来）。

## 3. 各节点要点（压缩）

- **ModelsCombo**：隐藏 config；输出 `MODEL/CLIP/VAE 1..N`（`MAX_PORTS_PER_TYPE=32`）+ 固定末尾 STRING `trigger_words`。LoRA 按 id 顺序串联，`targetId` 为空则跳过。**载入守卫**：loaders 未载入时不重排端口。文件列表走内核 `/models/<folder>`，失败回落到我们自己的 `/models_combo/files?folder=`（见 §7）。
- **FreeLatent**（V3 `io.ComfyNode`）：`config` + `width/height/batch_size`（>0 覆盖）；面板状态随 config 持久化；`force` 仅任一输入已连接可切换；对齐非 8 倍数时 `execute` 抛清晰报错。
- **NodeSwitchGroup / Master / MainControl**：NSG 分组发现基准 = **节点自己的图**（`allGraphGroups(node.graph)`，不用 `getCurrentGraph`）；扫描定时器按节点存；NSM 行 = 画布上的 NSG；MainControl 被控 4 类。子图工作流已修（按实例去重 + 兼容 subgraphs 为数组/Map/对象 + 扫描链 try/catch）。
- **ParamPresetControl / Output**：Control 输出 = 分组数 1:1（`EZFLEX_PARAM_GROUP`）；Output 输出 = 参数数 1:1，禁用参数保留端口并输出中性值。socket 按 `_ezGroupId` → 位置 → 新建复用，不断连。
- **PreviewAny**：`input_1..16`(ANY) + 透传输出 + `OUTPUT_NODE=True`；类型判定按 `type(value).__module__ + __name__`。**文件直通勿回退**：文件型视频/音频不重新编码；生成信息链 PIL → sidecar → 容器(ffprobe/mutagen) → 工作流兜底。存档只允许白名单后缀，绝对 savePath 只允许 output / 本机登记目录。
- **PromptHelper**：动态 `media_in_1..16` + `card_in_1..N`；固定 33 个 STRING 输出。**循环模式（设置·其他设置里的开关，存 config `loopMode`）**：关时没有 `index` 口；开时末尾出现 `index:INT`（接循环），且第一个输出口从「合并提示词」改名「循环输出」、只出第 index 张卡，其余卡片输出口保持 1:1 不变。后端口 `RETURN_NAMES` 不动，改名只在前端口/黑框标签。引用媒体编号来自编号引擎（芯片 `span.eph-mref`，每次插一份）。三个自动优化开关**互斥**，失败**抛 ValueError**（否则表现为静默空提示词）。HTML 一律 `ezSanitizeHtml()` 后 `innerHTML`（XSS）。标签系统见 §9。
- **MediaLoader / MediaOut**：Loader 输出 = list（按卡片/卡片组/分组 + 拼接）；Out = 只拆分（`INPUT_IS_LIST=True`，一项一个真实类型口）。
- **固定模式（本轮定稿）**：Loader 顶部「循环」按钮（拼接与名称之间，左键开关 / 右键开设置弹窗）；弹窗左侧分栏 = **拼接设置 / 循环设置**，循环设置第一行是槽位预设（下拉 + 保存 + 删除，复用 `/media_loader/presets` 带 `kind:'fixed'`，内置 `default`（全 0）/ `minimaxH3`（图片9/视频3/音频3）不可删），第二行起是**卡片组布局**：固定 6 类（图片/视频/音频/文本/模型/其他，每行三个 → 默认两排），只填数量。config 存 `fixed:{on,current,slots:[{type,n}]}`；`_ml_fixed_items` 把一口的文件按槽位顺序排成 Σn 个值（缺槽 None；不在 6 类里的旧类型落 other），**固定与拼接互斥**。**循环模式优先级高于输出模式，只出一个口**：`_ml_fixed_segment(rows, index, slots, groups)` 按「分组→卡片组」的扁平顺序取第 index 个卡片组（越界 = 全 None），index 接 LoopStart.index，循环里画布不用重连。**MediaOut 自动跟随**：没有手动开关，`fixedSlotsOf` 读上游 loader 的 `fixed.slots`，端口 = 槽位（图片1..9 / 视频1..3 / 音频1..3），执行仍按位返回。**卡片组 = 槽位面板（已做）**：固定模式下每个卡片组的格子里只画预设槽位（空位带类型图标，点它开浏览器），没有自由「+」位；三条添加路径（拖拽上传 / 浏览器单加 / 浏览器批量加入）都过 `fixedTake` 按类型限容，满了只提示不加入（`FIXED_POOL` 把 面板类型 → 文件类型池：text 与 other 共池、model3d → model_3d）。`/media_loader/serve` 用 `private, no-cache`（别改回 no-store）。运行期空传：前端在 `api.queuePrompt` 包装里把指向禁用端口的输入从 prompt 摘掉。
- **循环模式补充（本轮）**：槽位图标用 MediaOut 同款 SVG（文本=文档纸、3D=三个面带缝+底下 3D 的专门 SVG）；没存过槽位时按 `current` 取内置预设（修「minimaxH3 全是 0」）；`fixedSlotsOf` 在全 0 时返回空表（= MediaOut 不出口，和 loader 的 0 槽位一致）。
- **MergeList / SplitList / Reroute**：三者的区别是**端口基数**，别混：MergeList N→1（多个值合成一个 list，`INPUT_IS_LIST=True`）；SplitList 1→N（把一份 list 拆成 N 个输出口，始终留 ≥1 口，**没接线的口不画黑框、徽标只数已连口**）；**Reroute 是逐口 1:1 透传**（第 i 个入口 → 第 i 个出口，不合并也不拆分）。Reroute 的入口 `input_1..32` / 出口全 `*`（ANY），口数与每口名字由面板维护存 `config.names`（数组，空串 = 未自定义 → 回落 `out_N`），增删口后 POST `/ezreroute/outputs` 同步类 RETURN_TYPES/NAMES。**删口必须按实例收口**：先断开该卡上下游连线再 `node.inputs/outputs.splice`（LiteGraph 的 `removeOutput` 会对越界 target_slot 置 link 抛错，整份工作流加载中止）；`route()` 返回长度按**实例当前口数**（`self.outputs.length` → `_ez_ports` → 按收到的最大 `input_N` 兜底），不能固定返 `_EZ_REROUTE_MAX`（类 RETURN_TYPES 全局共享，多返会产出悬空输出）。
- **TimeLine**：`_tl_plan` 按模型帧网格分段。**两个固定输入口：`index`（0 基，optional + `forceInput`，接 LoopStart.index / easy forLoop index）与 `video`（`*`，分段成片 list，第 i 项 = 第 i 段）**；两口都是深红 `#d94848` 圆点 + 黑框标签（`index` / `video`）。输出 `frames` / `overlap_frames` / `segments`（`OUTPUT_IS_LIST` 全 False）。布局 = 上方 16:9 大预览（按 `video` 第 i 项显示播放头所在段）+ 底部「视频拼接」单轨；控件在上、贴底。点视频段 = 播放头定位到该段净起点。播放条+缩放条是常驻件（`render()` 只回填，不重建）。旧工作流的 `materials_N` 口由 `stripTlSockets` 摘掉并自动补上 `video`。
- **LoopStart / LoopEnd（2026-10-04 端口重做，旧契约全部废弃）**：
  - `LoopStart`：面板**只有一个 `index` 框**（起始轮次，默认 0，运行期只读、每轮 +1）；输出固定 `index`(INT，**排第一**，接 PromptHelper / MediaLoader / TimeLine 的 index 输入) + 动态 `value1..20`（**连一个加一个**）；输入 `index`(optional，`forceInput`) + 动态 `initial value1..20`（**初值口**，通配 `*`，类型跟线走）。
  - `LoopEnd`：面板**只有一个「次数」框**（总轮数：0 = 只跑一次）；输入动态 `value1..20`（与 Start 输出一一对应）；输出 `out1..20`；`rounds` 在 `required`（放 optional 会不可序列化、值一存就丢）；`OUTPUT_NODE=True`（否则没往出口接线时 End 不被调度、循环只跑一轮）；两节点都 `IS_CHANGED → NaN`（否则重跑命中缓存、循环被跳过）。
  - **回喂隐式**：`End.valueK` 收到什么 → 下一轮 `Start.valueK` 就输出什么。**画布上不许连 End→Start**（真连上 = 反向边 → 内核 `graph.py:303` 抛 `DependencyCycleError`）；实现是展开时直接写克隆节点的字面量输入 `_ezfeedK`（`LoopStart._FEED_PREFIX = "_ezfeed"`），所以后端**不提供**声明式回连口。
  - **初值口是「运行报错」的解**：无回喂时（第 1 轮 / `idx <= start`）`valueK` 输出 `initial valueK`，**别返回 `None`**（下游 `torch.cat` / VAE 收 None 直接崩）。后端键名 = `"initial value%d"`（**带空格**，黑框标签照它显示）。
  - **★ 后端一口气声明 20 个动态口，前端必须裁**：`trimLoopSockets` 只留「已连最大编号 + 1」，裁完 `sortLoopSockets` + `reindexLinks`。不裁 = 20 口全画 = 看起来根本不是动态口。
  - 黑框标签照端口名（`portLabel`：`value1` / `out1` / `initial value1` / `index` / `rounds`），不缩成数字；面板**无卡片行**（`.ezlp-card` CSS 保留给 MergeList/SplitList/TimeLine 用）。
  - **旧工作流**：`cardN / productN / flow / total / loop_in / loop_out / prev / rounds` 与 `list/slice/for` 三种面板模式**全部废弃**，需重新拉节点。完整契约见 `docs/Loop_端口契约与回喂机制.md`（2026-10-04，最新）。

## 4. 避坑（结论）

1. **动态端口**：类 `RETURN_TYPES` 全局共享；ParamPreset 两兄弟同步「只增不减 + 动态槽统一 `*`」。重排 socket 后 `graph.links` 的槽位要一起改。
2. **Vue / 经典**：`addDOMWidget.canvasOnly = !window.__ezflexIsVueNodes()`；面板穿透靠常驻 CSS（`!important` + `:has()`）；后建控件要能点（`.ezfx-panel-shell button,…{pointer-events:auto!important}`），定时重建前先算内容签名，别把正在点的 DOM 删掉。
3. **媒体编号**：按目标生成节点自己的端口顺序、按类型各自从 1、只数已连接；节点标识用标题（不显示 #id）；端口名优先、文件扩展名兜底；`startIndexWatcher` 要传真实节点。
4. **@ 芯片**：每次插一份（`insertMediaRefOnce`）；用 Range 插入而非 `execCommand`；插入前 `range.deleteContents()`；改编号只改 `.eph-mref-txt`。
5. **总体编辑 contenteditable**：块首退格 / 块尾删除会破坏结构 → keydown 拦截 + `data-cardId` + `healAllEditor()` 三道防线。
6. **层级弹窗**：`_phLayers` 栈 + capture 协调器，只关「按下前已打开」的层、拖动不关、一次只关最上层；平铺层 `.ph-dock` 显式放行。
7. **弹窗按键挂 document 捕获阶段**（`addEventListener(keydown, fn, true)` + `stopImmediatePropagation`），否则弹窗翻页时底下画布一起动。
8. **row/group 输出模式的坑**：Loader 换「按卡片组 / 按分组」后后端口序号 ≠ 卡片序号 —— 凡是按 slot 取卡片的地方都要走「端口盖章优先」。
9. **socket 黑框标签**（多节点各一份 `installSocketLabels`，改要一起改）：显隐判断必须用**当前渲染的图** `app.canvas.graph`（`|| app.graph` 兜底）；没接线的口不画标签。
10. **list 端口九宫格**：ComfyUI 给 list 类端口画九宫格（`shape=6/7`）。要圆点就每帧 `sock.shape = null`（`dotSockets()`）。
11. **行尾注释别吞语句**：`… // 说明 p._tpPage = pgBar;` 会把赋值整句吃掉；赋值/调用一律单独一行。
12. **对象字面量里引用后面才定义的 const** = TDZ `ReferenceError`（共享预览壳踩过）。
13. **`pushMediaFile` 要求 `f.path`**：MediaLoader 端口项必须带 `path`，否则编号引擎整条丢掉盖章项。
14. **内置加载节点的值格式**：新前端带标注 `name.png [input|output|temp]`（要剥掉并用于 `/view` 的 `type=`）；`LoadImage` 的 value 可能自带相对子目录 `sub/name.png`（要带上 `subfolder`）。
15. **声明类型是标量（INT/FLOAT/STRING/BOOLEAN/COMBO）的端口不要靠文件扩展名升格成媒体口** —— 否则 `GetVideoComponents` 的 `fps/bit_depth/color_space` 会变成幽灵 `@视频1`。
16. **删死代码要精确匹配 + 断言**（曾批量误删致 NameError）；静态扫描把 `_dev_tests/` 一起算。
17. **源文件改写别用 PowerShell `Get-Content/Set-Content`**（会毁编码）；验证 JS 的副本放工作区内 `_tmp`，别用 `%TEMP%`。
18. **别留「UI 看不见、后端还认」的开关**；预览类型要主动跟（MESH/SPLAT/VOXEL、真 CONDITIONING 是 `[[cond, {…}]]`）。
19. **3D 用本地离线 three.js**（`web/libs|utils|curves`），serve 走 `/preview_any/3d/{path}`。
20. **分测合成一个文件**（曾把多个文件合成一个套件，再分开改）→ 现在测试都在 `_dev_tests/`，不入库。
21. **动态端口的「切换顺序 / 刷新 / 重启都不丢线」五条通用准则**（MediaOut / PreviewAny / PromptHelper / ParamPreset 两兄弟 / ModelsCombo / MediaLoader 都按这套；新加动态口照抄）：
    1. **链路就绪前不动端口**。重载顺序是「先建节点、后铺 `graph.links`」。若自己端口上的某个 link id 在 `graph.links` 里查不到、或上游口还没盖章（`_ezItems`/`_ezFiles`），这一轮**不重排、不删口**，`setTimeout` 120–250ms 重试。
    2. **类 schema 也不能在就绪前上报**。前端 POST `/xxx/outputs` 会改类 `RETURN_TYPES`；就绪前上报空表 = 类口数被清空 → 保存的端口与连线全丢。上报前先 `return`，等守卫放行（MediaOut `syncOutputTypes` 第一行就是这条）。
    3. **守卫必须放在任何 socket 被改动之前**。延后的那一轮若已经改过名字/类型/盖章，会污染下一轮「同类型补位」的判断（视频口被当图片口），断线判断就错了。顺序 = 算 want → 算 targetOf → 守卫/延后 → 才复用与改元数据。
    4. **能原地就不重排**。算出来的端口种类序列和现状完全一致时，只更元数据（名字/类型/标签/颜色/盖章），绝不重排 `node.outputs`、不碰链接 —— 连线一定保住。
    5. **要重排时：先写新口再删旧口**。新口（`addOutput` 建的）`links` 是 `null`，必须手动 `to.links.push(lid)`；旧口上的线先从 `s.links` 里 `splice` 掉再删口（`removeOutput` 会按 `socket.links` 断线）；同时改 `graph.links[lid].origin_slot` 与目标端口的 `input.link`/`target_slot`。

## 5. 性能

- **交互期 `pumpFrames(ms=300)`**：醒后 300ms 内每帧更新，停手自动停 → 静止零开销；触发源 = `LGraphCanvas.setDirty` 补丁 + 画布 pointer/wheel + resize/scroll/`ezflex:changed`。**`onDrawForeground` 里只做同帧 `update()`，不要再额外 `pumpFrames()`**（会同一帧跑两遍）。
- 轮询全删，改画布重绘 + 事件驱动；编号引擎合并到帧（`refreshIndexSoon`，打开引用面板前 `refreshIndexNow`）。
- 总开关 `EZ_PERF`（`web/ezflex_service.js`）：`labelFallbackMs/mainPollMs/indexPollMs/groupPollMs` 默认 0、`render3d:'ondemand'`；出问题只改常数即回旧行为。
- **后端目录扫描缓存（本轮）**：`_scan_cached(key, roots, build)`（`__init__.py`，`_SCAN_CACHE_TTL_MS=5000`，可设 0 关闭）。只缓存**文件名/路径**这类元数据，绝不缓存模型对象 / 图片字节 / tensor → **不占显存**。失效 = 参与扫描的根目录 mtime 变化，或 TTL 到点。已接：`/models_combo/files`、`lora_meta`、`llama_models`/`clip_models`、`ph_resolve_model`/`_ph_resolve_gguf`（`_ph_root_index` 文件名索引）、`_ml_files`、`_mc_trigger_words`（按 metadata mtime）。
- **模型缓存上限（本轮）**：`_LLAMA_CACHE_MAX=2` / `_PH_CLIP_CACHE_MAX=4`，`_ph_cache_put` 淘汰最旧一个（llama 先 `close()`）。这两个缓存存的是**已加载模型**，是真正吃内存/显存的地方；`ph_clear_model_cache()` 可手动清空（`close()` + gc + `soft_empty_cache()`）。
- **删掉的重复**：`_image_to_base64` 不再 `optimize=True`（PNG 压缩很慢）；音频改为直接拿 WAV 字节（不再 base64 编一遍再解回来）。

## 6. 测试与本地验证

```powershell
$root="<ComfyUI>"; $py="$root\.venv\Scripts\python.exe"; $d="$root\custom_nodes\Comfyui-EzFlex-Presets"; $t="$d\_dev_tests"
$env:PYTHONIOENCODING="utf-8"
New-Item -ItemType Directory -Force -Path "$t\_tmp" | Out-Null
& $py -c "import ast,io; ast.parse(io.open(r'$d\__init__.py',encoding='utf-8').read()); print('PY OK')"
foreach($f in (Get-ChildItem "$d\web" -Filter *.js -Recurse)){ $tmp=Join-Path $t "_tmp\chk_$($f.BaseName).mjs"; Copy-Item $f.FullName $tmp -Force; node --check $tmp }
foreach($s in @('undefined_names','node_contract_test','loop_test','route_audit','route_security_test','route_coverage_test','loader_contract_test','media_merge_test','preview_fastpath_test','preview_save_test','preview_types_test','prompt_helper_test','prompt_helper_dock_test','ui_ux_test','dynamic_types_test','i18n_test','cjk_scan','py_ui_audit','tag_store_test','user_dir_test','timeline_plan_test','split_list_test','preview_ux_test')){ & $py "$t\$s.py" *> $null; if($LASTEXITCODE -ne 0){ Write-Output "FAIL $s" } }
foreach($s in @('import_test','media_out_prune_test','media_index_test','preset_mode_test','tag_panel_test','timeline_panel_test','preview_dedup_test','media_fixed_test','preview_exec_test')){ node "$t\$s.mjs" *> $null; if($LASTEXITCODE -ne 0){ Write-Output "FAIL $s" } }
```

- 基线：**28 py + 30 mjs 全绿** + JS/Python 语法检查。`_dev_tests` 不入库（里面写死了本机 ComfyUI 绝对路径）。
- **本轮新增两道门**：`node_contract_test.py`（**按 `NODE_CLASS_MAPPINGS` 枚举全部 17 个节点**：INPUT_TYPES/RETURN_TYPES/FUNCTION/方法存在 + 静态 RETURN_TYPES↔RETURN_NAMES 长度一致）、`route_coverage_test.py`（**枚举所有路由**：处理函数必须能到 `_ez_local(req)`，或在 `PUBLIC` 白名单显式登记）。
- 关键钉子：`loader_contract_test`（加载与内置同款）、`media_merge_test`（卡片/组/分组合并语义）、`preview_*`（文件直通/存档/98 种值类型）、`prompt_helper_test`（合并规则 + 优化矩阵）、`media_index_test`（编号引擎 + 端口盖章优先 + 子目录）、`tag_store_test`（标签存盘往返）、`import_test`（真模块导入抓漏 import/循环依赖）、`timeline_panel_test`（TimeLine 布局）。
- 数据：`user_data/PromptHelperLib/*.csv`（12 个，约 26 MB）**必须随仓库走**，否则标签面板既没库也没中文。

## 7. 安全收口

- **路径包含性**：`_ez_real` / `_ez_roots` / `_ez_inside`（realpath + commonpath，覆盖 `..` / 绝对路径 / 兄弟前缀 / 符号链接）；根外文件只有**本机预览**才复制进 temp 再服务。
- **本机限定 `_ez_local`**：回环 remote + 回环 Host + Origin/Referer 同源 + 拒 `Origin: null` 与 `Sec-Fetch-Site: cross-site`；覆盖 open / pick_folder / 各配置写入 / 根登记 / 预设写路由 / 动态输出同步。
- **出站**：`_ph_check_outbound` 主机允许列表（内置厂商 + 本机登记）+ 仅 http/https + **每跳重定向复核** + 代理也复核；`?root=` 仅本机；模型解析 `strict`（远端只认登记根）。无 Key 外泄（远端 `_ph_custom_load` 剥掉 apiKey）。
- **直链后缀白名单**：`/preview_any/serve_video|serve_3d` 只服务媒体/模型后缀（`_MEDIA_SERVE_EXT`）。
- **为什么以前老修不完**：旧 `route_security_test.py` 只验收口**助手** + 手挑片段，**不枚举路由** → 没被手挑进来的写路由永远测不到。现在由 `route_coverage_test.py` 按路由覆盖兜住。
- 低危残留（都需本机/回环）：`/preview_any/open` 用请求里的绝对路径拉起 explorer；`/media_loader/save_as` 的 `dest` 不限；预设 GET 只回名字。

## 8. 待办

- [ ] 临时预览文件（`ezpv_*`，含 `ezpv_vid_*`）自动清理（真实占磁盘）。
- [ ] FreeLatent：DOM 类型下拉切 lora 不自动补 `targetId`（LoRA 静默跳过）。
- [ ] PromptHelper：全/半角转换用 `textContent` 整段替换，会丢格式与 @芯片。
- [ ] PromptHelper 卡片管理器搜索：防抖 + 原地过滤 + `cmFetchOne` 改 `Promise.all`（现在每键全量重建 + 串行请求）。
- [ ] `main_control` 每帧 `nodesOfType` ×4（复制 Map + 扫全部节点 + 排序）→ 事件驱动 + 防抖。
- [ ] `_ez_roots()` 每次 `_ez_inside` 都重读扫描路径 JSON + realpath 全部根（循环里被调）→ 每请求 memo。
- [ ] 编号引擎 `mediaFilesOfSlot` 对未注册节点忽略 slot（多输出第三方加载器会串文件）；`relayDepth=4` 超过会丢素材。
- [ ] TimeLine `tlSlotItems` 不做中继穿透（`LoadVideo → GetVideoComponents → TimeLine` 拿不到），编号引擎有 `filesUpstream` 可复用。
- [ ] 放大端口抓取半径在新前端静默失效（`SOCKET_RADIUS` / `get_socket_at` 已不存在）。
- [ ] Vue 黑框标签叠加层按 Vue 端口坐标再校准。
- [ ] MediaOut 可选增强（`count` / `image_path` 输出、JPEG/WebP 元数据、历史画廊）。

## 9. 标签系统（PromptHelper）要点

- **两套空间**：库侧 `place/fav/meta` + 我的侧 `mine` 副本；伪行 全部/已收藏/我的标签；固定真节点「未分类」；临时分类已删除。
- ⚠️ `_ph_libs_clean` 必须保留 `libs[lib].groups/place/fav/meta`；`_ph_tags_clean` 必须保留 `mine`（曾漏 → 库分组树/归类每次保存被冲掉、删掉的标签刷新又回来）。`tag_store_test.py` 钉住。
- 数据：`user_data/PromptHelperLib/` 下 12 个 CSV（8 标签库 + `_tag_kind` / `_zh_CN` / `_e621_species` / `_furry_extra`）。
- 性能关键（大库）：懒加载 + 单字不查（热度门槛）+ 中文走 `_zh_CN`；卡片管理器搜索是当前最大热点（见 §8）。
- 卡片存档：`user/EzFlex/prompts/<名称>.json`（名校验 + 签名防误删）；插入模式隐「添加/使用卡片」。
- **卡片尺寸 / 显示模式（本轮）**：图标行（row2）最右「数量 / 高度 / 显示模式」，0 = 默认；全局存 `localStorage['ezflex.tagCardSize']` / `ezflex.tagPreviewFit`，`tpCardWidth()` 设 `--tp-card-w/--tp-card-h`。显示模式是**全局**的：改完只重画当前页（`tpApplyFit`），换页/换分组重画时按全局值重上。
- **预览显示形式（本轮）**：`full` 用 `object-fit:contain`（灰底留白），默认 `cover`；不再存到标签记录里（`previewFit` 已删）。
- **收藏星（本轮）**：未收藏只在卡片悬停时出现；已收藏常驻并固定亮黄 `#ffd21e`（图片上也能看清）。点收藏只原地刷星（`tpRefreshStars`）+ 原地更新左栏「已收藏」计数（`tpRefreshFavCount`）；**但在「已收藏」视图 / 「只看收藏」筛选下要重画**（取消收藏得把卡片移掉）。**点击时现查** `tpCollected`（不能在构建时把 `on` 闭包进去，否则第二次点取消不掉）。
- **批量拖拽（本轮）**：`_tpDragKeys` —— 批量模式下拖动一张选中卡片带走整组 `_tpSel`；单张仍只拖自己。落地在 `renderCatRows` 的 drop 里消费。
- **插入不再卡（本轮）**：`tpAdd/tpRemove` 只原地改卡片高亮 + `renderTpIns()`（`tpRefreshTileStates`），不再 `renderTagPanel()`（大库每次点击全表重扫是卡顿来源）。
- **选图提示（本轮）**：`tpImagePreview` 的 canvas 异常不再让 Promise 悬空，失败统一点「无法读取这张图片」。

## 10. MinimaxH3 长视频功能接口约定（新窗口照着接）

> ⚠️ 本节按 **2026-10-04 重做后的循环契约** 写。旧写法（`flow`/`cardN`/`loop_in`/`loop_out`/`loop_product`/`prev`/`total`/`rounds` 手接、`list/slice/for` 面板模式）**已全部废弃**，勿再照旧接口接。

- **时间规划**：`EzFlex-TimeLine` 的 `index:INT`（0 基，optional+forceInput，**接 `LoopStart.index`** 或 easy forLoop index）→ `frames:INT`（该段生成帧数）+ `overlap_frames:INT` + `segments:INT`（总段数）。段数/每段帧数直接用它，别自己算 `17k+5`。**`segments` 不再需要手接 End 的「次数」**：`LoopEnd` 会用隐藏 `execution_list` 读 `LoopStart` 的输出自动推轮数（`_rounds_from_start`）；想显式控制才接 `rounds`（接了优先）。
- **段视频进时间轴**：TimeLine 的 `video` 输入 = `*`，**每段一个视频项的 list**，前端按 `_ezItems` 让第 i 项预览第 i 段。
- **段间参考**：`EzFlex-H3TailRef` 为**计划中节点**（暂未实现，不在当前 17 个节点内）—— 输入上一段 `LATENT`，输出尾帧 `IMAGE` 和/或尾端 latent 切片，按官方 `minimax_keyframes @ resolved_frame_index=0` 注入；音频窗**结束在接缝**（不是从接缝往前排）。
- **循环（新契约）**：段参数（提示词/时长/参考）用**动态 `value1..N`** 携带：`LoopStart.valueK` 接进本轮 body，body 产物接回 `LoopEnd.valueK`，下一轮由 `Start.valueK` 自动回喂（**不用连线**，连线 = `DependencyCycleError`）。第 1 轮还没有上一轮产物 → 给 `LoopStart.initial valueK` 接初值（下游吃实值的节点如 `torch.cat`/VAE 必须接，否则收 `None` 报错）。段时长直接把 `TimeLine.frames` 接进 body；上一段的 latent 走一对 `valueK` / `initial valueK`（TailRef 必须把首轮的初值当成「没有参考」原样放行）。`LoopEnd.out1..N` = 最后一轮的携带值，供最终解码/收尾。完整契约见 `docs/Loop_端口契约与回喂机制.md`。
- **逐段保存 + 拼接**：每段落 `output/h3_projects/<proj>/seg_NNN.mp4`，最后 ffmpeg `concat -c copy`；不要把全部帧攒到最后再编码。
- **显存**：恒定单段；每段后在**执行层**释放；attention 走 `MiniMaxH3MemoryEfficientSageAttentionPatch`，latent 二采走 `minimax_h3_latent_upscaler`。参考实现：`supElement/ComfyUI_MinimaxH3_AutoContext`、`bingling360/ComfyUI-minimaxH3-SequenceForge`、`NikoDemon80/ComfyUI-H3-Motion-Context`。

## 11. 本轮变更（2026-09-29）

- **修**：MergeList 调不存在的 `tlUpItems`；编号引擎「端口盖章优先」；内置加载节点标注值 / 子目录；TimeLine INT 输出不再盖 `_ezItems`；SplitList 初始不伪装 1 项；NSG 含子图工作流崩溃；ModelsCombo 兼容旧版/整合包（`/models_combo/files` 兜底）；安全（预设写路由补 `_ez_local`、直链后缀白名单）；settle 定时器随节点删除清理。
- **优化**：后端目录扫描缓存（mtime + TTL，元数据级）；模型缓存上限；PreviewAny 去双重编码 + 音频直写 WAV；前端五个面板去掉同帧重复 `pumpFrames()`。
- **瘦身**：删 3 个死函数（`_mout_parse_off` / `_mout_mode` / `_mout_flatten`）、1 个死 helper（`tlChooseStep`）等；`window.__ezDumpCombo` 系列调试工具**保留**（它们是给用户手动的调试入口，不是残留日志）。
- 备份：`_backup/20260929-215356`（本轮前）、`_backup/20260929-211403`。

## 12. 本轮变更（2026-10-01）

- **PromptHelper 标签面板**：图标行最右「数量 / 高度 / 显示模式」（0 = 默认，全局存 `ezflex.tagCardSize` / `ezflex.tagPreviewFit`）；显示模式改全局（缩略 cover / 全图 contain 灰底），只重画当前页、换页重上；数量/高度去掉上下箭头；收藏只原地刷星（修「点收藏卡一下」）；插入/取消插入原地刷新；选图失败提示 + canvas 异常不再悬空。
- **TimeLine 布局（本轮末）**：拖动缝（`.eztl-hsplit`）整个删掉，预览:底部 = `flex:2 1 0` : `flex:1 1 0`（`min-height:190px`）**固定比例随节点缩放**；悬停气泡加了全局兜底（`pointerdown` / 文档 `mouseout` / `scroll` / `blur` / `resize` / 面板 `mouseleave` + 重画前 `tlTipHide`，mousemove 补回），不再停在画布上。
- **TimeLine 重叠圆点（本轮）**：老工作流把 `index` 存成「widget 转输入」（`inputs[].widget={name:'index'}` + `widgets_values_named.index`）；定义改成 `forceInput` 后前端会同时画 widget 圆点和 socket。`stripTlSockets` 每次 render 里清掉 `input.widget`、从 `node.widgets` 删掉 index、并删 `widgets_values_named.index`。
- **TimeLine**：`index` 改 optional + `forceInput`（socket 用 MediaLoader 同款深红 `#d94848`，带 `index` 黑标签）；`frames` 标量 + 新增 `segments:INT`（给循环 total）；删素材库 / 提示词区 / `序号` 字段；大预览 `flex:1 1 auto;min-height:0`（普通弹性区：拖缝/改节点大小只压缩预览，绝不覆盖控件；视频自身仍 16:9，`object-fit:contain` 自动留边）；**控件在上、时间轴在下贴底**；显示模式下拉移到播放/停止那一行最右；缩放滑块恢复 `flex:1` 铺满整行；拖动缝线改浅灰。**点视频段不响应的真因**：`installBlankDrag` 在 pointerdown 上 `preventDefault` 会把兼容 mousedown 吞掉，而 `.eztl-lane/.eztl-mseg` 不在 `_BLANK_SKIP` 里 —— 已加入白名单。
- **循环排障**：用户 `Unsaved Workflow (2)` 里 `easy forLoopStart.total` 没接、`TimeLine.index` 没接（接的是 MediaLoader.index）；另有一处断链——节点 46 `MiniMaxH3ReferenceToVideo` 的 `ref_videos.ref_video_0` 指向不存在的 link 226，报 `No link found in parent graph for id [46] slot [4]`。接通 `segments → total`、`index → TimeLine.index` 并清掉断链即可。
- **循环模式槽位对齐（本轮修）**：固定/循环模式里空槽位原先让 `mlPortItems` 在 `x.f` 上抛错，整个 Segment 口的 `_ezItems` 变空 → MediaOut 端口全部没盖章 → 编号引擎回退按 config 顺序取 `all[slot]`，把「图片口」读成配置里第一段视频（用户 `Unsaved Workflow (2)` 正是如此）。现在空槽保留 `null` 占位（与后端 `_ml_fixed_items` 同形），MediaOut 按位对上槽位；编号引擎对「有 `_ezMediaId` 但查无素材」的口直接判空，不再回退 `all[slot]`。回归：`media_fixed_test.mjs`。
- **MediaLoader 小修（本轮）**：① 分组 tab 的 ✕ 紧挨组名、一点就没 → 删除前走 `uiConfirm`（媒体项那个悬停 ✕ 保持原样）。② 高度倍率原来只压预览（`pv.height` + `m.minHeight`），卡片组外框 `.eml-grid{min-height:80px}` 和 `.eml-empty/.eml-slot` 的固定 min-height 卡住了高度 → 现在卡片本体设 `m.height`、grid/空位/槽位 min-height 一起跟倍率收。
- **动态端口通用准则（本轮）**：把「重载不丢线」总结成 §4.21 五条（就绪前不动端口 / 就绪前不上报空 schema / 守卫前置 / 同布局原地更 / 先写新口再删旧口）。全部动态端口节点已按这套跑通「切换顺序 → 刷新 → 重启 → 跟随连线」，MediaOut 是这轮补齐第 1、2、3、4 条的地方。
- **MediaOut 重载保守化（本轮）**：`nodeCreated`/`loadedGraphNode` 建节点时打 `_ezMoFresh`：这次重排**先保守**——若布局和保存的不一致、且有连线找不到落点，就整轮跳过（**不碰任何 socket**，连线原样保住），最多重试 20 次兜底。只有 MediaLoader 明确回调 `_ezMediaOutUpdate`（切模式/改槽位/内容变）或重试超限时才真正重排/断线。另外「布局和保存完全一致」时走**原地更元数据**快路径，根本不重排。守卫必须放在**任何 socket 被改动之前**（否则延后的那轮仍会改名字/盖章，污染下一轮的 kind 判断）。回归：`media_fixed_test.mjs` 第 13 节。
- **MediaOut 刷新/重启丢连线（真因，本轮修）**：`setupNode` 在链路/上游还没就绪时就调 `syncOutputTypes`，拿空 items 上报 `{"files":[]}` → 后端把类 `RETURN_TYPES` 清空 → 保存的端口和连线全丢（比 `updatePorts` 那次更早、更狠）。现在 `syncOutputTypes` 未就绪直接 return；``mediaOutUpstreamReady`` 也加严：固定模式要等 loader 的 config 可读（否则 `fixedSlotsOf` 返回 null，会被当普通模式按空 items 重排），普通模式至少要有一个真实素材。回归：`media_fixed_test.mjs` 第 11（完整重载连线全在）/ 12（未就绪不上报空 schema）节。
- **MediaOut 刷新/重启丢连线（旧修）**：前端先建节点后铺 `graph.links`；链路没恢复（或上游 MediaLoader 还没盖章）时 `updatePorts` 会按空 items 把保存的端口全删 → 连线断。现在 `mediaOutUpstreamReady()` 判定未就绪就先 `setTimeout` 重试（最多 20 次兜底放行），不重排。回归：`media_fixed_test.mjs` 第 10 节。
- **PromptHelper 循环模式（本轮）**：设置·其他设置新增「循环模式」开关（`segSwitch`，开/禁滑块）。关：无 index 口；开：末尾出现 `index` 口 + 输出口改名「循环输出」+ 运行期只出第 index 张卡（Python 也校验 `cfg.loopMode`）。回归：`prompt_helper_test.py` 第 ⑧ 节。
- **index 三处统一（本轮）**：MediaLoader / TimeLine 的 `index` 输入口都是深红 `#d94848` 圆点 + 黑框 `index` 标签（原先 MediaLoader 没上色、TimeLine 的输入侧标签因 `installEdgeLabels` 的 `_ezEdgeOn` 守卫被第二次调用吞掉）；PromptHelper 末尾新增固定 `index` 输入口。`installEdgeLabels` 一个节点只能装一次 —— 要同时标输入和输出就用 `side:'both'`，别再调第二次。
- **TimeLine 参考输入 → `video`（本轮）**：删掉 `materials_1..8`（含 Python `_TL_MAX_SLOT`）与编辑器里的动态加口；改成固定 `video`（分段成片 list），大预览第 i 段显示第 i 项。回归：`timeline_panel_test.mjs`。
- **PreviewAny 保存选项重构（本轮）**：卡片上的「列表/普通」「多图保存类型」两个下拉挪进「保存选项」弹窗，**单页堆叠**（不做左侧分类）；两者都改成**全局**（config 的 `previewMode` / `batchMode`，一行搞定，不再按输入口）。**动图独立成一项**（对齐内置 SaveAnimatedWEBP/PNG：格式 webp/png/gif + 帧率 + **无损勾选框**（原来是 Yes/No 下拉）+ 质量），图片项只留静态格式。文件名那栏改名「文件名前缀」并去掉 placeholder（后端 `_name` 就是基名前缀）。
- **PreviewAny 参数增强（本轮）**：数值参数（质量/帧率/CRF/码率/采样率）从固定下拉改成 **number 输入 + 常用值 datalist**（可手输、也可点常用值）；动图新增「压缩速度」method；码率裸数字 <1000 当 kbps（`_bitrate_int`）。卡片主图改显示**最新一条**（原来累加后取到第一条），多条时名字带 `(N)`、点开是全部。
- **PreviewAny 存档后端 bug（本轮修）**：`_parse_config` 从来没把 `batchModes` 传下去，所以旧的「多图保存类型」下拉**根本没生效**；现在解析 `batchMode`（全局）并在 `_save_image_batch` 使用。动图参数从 `saveFormats.image.animfmt/alossless` 挪到独立 `saveFormats.animated`。
- **保存类型参数修正（本轮）**：视频「空编码器」原来在 `_encode_video` 落成 libvpx-vp9（写 mp4 会失败）、在 `_encode_frames_to_video` 落成 libx264（写 webm 会失败）→ 改成按容器默认（webm→vp9，其余→h264）；视频下拉去掉 `gif`（真视频→gif 要抽帧，后端不做）；3D 格式下拉只留「保持原样」（后端 `save_src` 只复制源文件、不转码）；音频补 `opus`。
- **PreviewAny 循环多轮累加（本轮）**：Easy-Use/EzFlex 循环展开时每轮都会对同一个节点 id 发一次 `onExecuted`；原来直接覆盖 entries → 只看到最后一轮。现在 `st.entries = st.entries.concat(message.entries)` 累加，`api.addEventListener('execution_start')` 换一次执行再清空。回归：`preview_exec_test.mjs`。
- **PreviewAny 去重可切换（本轮）**：后端 entries 现在**原样存**，卡片名称后加「列表 / 普通」下拉 —— 列表模式收敛广播重复（原来唯一行为），普通模式照实显示（重复项/单文件被广播 N 份都保留）。回归：`preview_dedup_test.mjs` + `timeline_panel_test.mjs` 静态断言。
- **MediaOut 换模式自动跟随连线（本轮）**：端口始终是「槽位/素材」，换输出模式或改槽位布局时连线自动重排 —— 先按素材身份（同素材的线跟着素材走），身份对不上再按「同类型里的第几个」补位（原来接第 2 张图的线落到新的「图片 2」上）；新布局里没有该类型的落点就干净断开，绝不错接到别的端口。实现要点：先把所有出线改到目标口，**再**删未复用的旧口（`removeOutput` 会按旧下标断线），并按「重排前」的身份/类型做映射（复用会覆盖 socket 上的 `_ezMediaId`）。 **socket.links 必须一起维护**：新版 LiteGraph 的 `addOutput` 给的是 `links:null`，而 `disconnectOutput`/`removeOutput` 都按 `socket.links` 找线、并按 `origin_slot` 平移；只改 `origin_slot` 不登记新口的 `links`，落在「新建口」上的视频/音频线就会丢（图片口多数是复用旧口，所以看起来只有图能跟）。 回归：`media_fixed_test.mjs` 第 5–9 节。
- 前端横幅：`PH_BUILD = 2026-10-01-v151`。
- 测试：`timeline_panel_test.mjs` 断言更新（无素材库/提示词区、单拖动缝、控件在下、点段定位预览）。

## 13. V1.3.0 关键经验与错误（精华）

- **版本**：`__version__` / `pyproject` / 两个 README 都是 **1.3.0**（未发布，1.3.0 内累积了循环节点重做 + 预览图文件化 + Ctrl+Z/Y 守卫）；节点共 **17 个**（V1.3.0 新增 MergeList / SplitList / LoopStart / LoopEnd / TimeLine / Reroute）。
- **循环只携带、不累积**（最反直觉）：`LoopEnd.outN` 都是**最后一轮**的携带值；预览节点是终端，接前接后都只能看到一轮。要累积必须走**携带变量**：`Start.valueN` →（MergeList / LatentBatch 合并）→ `End.valueN`（回喂隐式：`End.valueK` 收到什么，下一轮 `Start.valueK` 就输出什么），跑完即为全集。long-video 的「每段 latent / 尾部潜空间」全靠这条。
- **循环体由「谁喂进循环端」决定**：`LoopEnd.valueN` 收到什么就是循环体携带什么；什么都不接 = 空循环体 = 只跑一次（index=0）。轮数由面板「次数」框 / `rounds` 决定，无回喂时首轮取 `Start.initial valueN` 初值（**别给 None**）。
- **循环展开的 `onExecuted` 是「每轮一次」**：列表广播 = 一次调用里 N 条（`execution.py` 合并 ui）；循环展开 = N 次调用（同一 display id）→ 前端必须**累加** + `execution_start` 清空，卡片主图取**最新**一条。
- **动态端口五条 → §4.21**。两次踩坑：`updatePorts` 在链路未就绪时按空 items 删口（旧修）；`syncOutputTypes` 未就绪上报 `{"files":[]}` 把类 `RETURN_TYPES` 清空（真因，更狠）。守卫必须在**改动 socket 之前**，否则延后那轮仍会污染下一轮的类型判断。
- **`_parse_config` 会丢字段**：`batchModes` 从来没传进后端 → 旧「多图保存类型」形同虚设；改全局 `batchMode` 时顺手修了。
- **视频空编码器必须按容器给默认**：`_encode_video` 默认 vp9 写 mp4、`_encode_frames_to_video` 默认 libx264 写 webm 都会失败 → webm→vp9、其余→h264；`gif` 不能当视频容器（真视频→gif 要抽帧）。
- **存档参数对齐内置**：图片只列静态格式；动图独立一项（格式 + 帧率 + **无损勾选** + 质量 + 压缩速度）；数值参数用 number + 常用值 datalist。
- **清理**：删 `_backup/`（1.9 万文件；`.gitignore` 写的是 `_backups/`，没盖住）、根与测试的 `__pycache__`、测试生成的 `_dev_tests/{_tmp,extensions,scripts}`。

## 14. 历史变更（2026-10-03，循环端口重做前的旧契约）

> ⚠️ **本节描述的是 2026-10-04 循环端口重做之前的旧契约**（`loop_in` / `total → rounds` 手接等）。这些端口与接法**已废弃**，保留仅作故障溯源参考；现行契约见 §3 与 `docs/Loop_端口契约与回喂机制.md`。

- **LoopStart / LoopEnd 加固**（`__init__.py`；端口契约与 `loop_test.py` 语义不变）：
  1. `loop_in` 加 `{"lazy": True}` —— 原为普通 optional 输入、tooltip 却引导「接 LoopEnd.loop_product」，真接上就是反向边 → 运行时 `DependencyCycleError`（`graph.py:303`，全内核唯一抛点）。lazy 不建依赖边，首轮取到 `None`（内核官方语义「connected-but-unevaluated → None」）。
  2. 两节点加 `IS_CHANGED → float("NaN")` —— 否则重跑同一份工作流命中缓存、**循环整个被跳过**。
  3. `LoopEndNode.OUTPUT_NODE = True` —— 否则「没往 End 出口接东西」（例如只在 body 里放预览）时 End 不被调度，**循环只跑一轮**。
  4. 新增 `_rounds_from_start`：用隐藏输入 `execution_list` 读 `LoopStart.total`（槽位 `_EZ_LOOP_MAX+1`）→ **不必再手动接 `total → rounds`**（slice 模式轮数 = 最长列表，光看 config 只能数出**卡片数**）。`rounds` 接了仍优先。
  5. 收口：`flow` 不是 LoopStart / 轮数算不出 → 抛清晰 ValueError（原来 `or 1` 静默只跑一轮，最难查）；输出节点扫描容错缺插件并排除 `EzFlex-LoopEnd`。
- **PreviewAny 默认展现模式改为「普通」**（`web/preview_any.js` 7 处）：列表模式会 `collapseEntries` 收敛重复项，看着不像真实输出。默认 `normal`；**只有显式存过 `previewMode: "list"` 才走列表**（老工作流不受影响，要切换在「保存选项」弹窗里改一次）。下拉顺序改成「普通 / 列表」，默认项在前。
- **PreviewAny 卡片主图固定显示该端口第 1 条**（`web/preview_any.js:1067-1068`）：原来是「最后一条」（当初为「循环多轮看最新一轮」定的），但**列表广播**场景（MediaLoader 固定模式 15 槽）会落到尾部空槽 → 卡片显示 `(not connected)`。现对齐内置语义（内置多张铺全部缩略图、单张才 `imageIndex=0`；EzFlex 卡片只有一个主图位 → 取第 1 条）。全部条目仍可点开列表看。回归：`preview_dedup_test.mjs` 第 6 节（静态断言）。
- **共享列表预览壳的缩略图条支持滚轮横向滚动**（`web/ezflex_listview.js`）：竖向滚轮 → `strip.scrollLeft += e.deltaY`（与 MediaLoader 预览弹窗 `media_loader.js:1552` 同款）。PreviewAny 的列表弹窗与 TimeLine 素材库共用这个壳，一起受益。⚠️ `.ezl-strip` **不在** `ezflex_service.js` 的 `_SCROLL_CLASSES` 里（那是面板专用），Vue 的全局滚轮也只在外壳矩形内生效、管不到弹窗 → 两种模式都靠这条显式绑定，且必须非被动（否则 `preventDefault` 无效）。回归：`preview_ux_test.py` 第 4 节。
- **已知行为（非 bug）**：MediaLoader 固定模式 `Segment` 是 Σn 个槽位、**缺槽补 `None`**（保 MediaOut「第 i 槽 = 第 i 端口」位置稳定）→ 直连 PreviewAny 会看到一串 `(not connected)`。要干净预览就走 MediaOut，或把槽位预设改成实际数量。另：ComfyUI 列表长短不一时**短的那条重复最后一个值**（`execution.py:261-262`），**从不补 None**。
- 前端横幅：`PH_BUILD = 2026-10-03-v153`。
- 测试：**23 py + 22 mjs 全绿**。

