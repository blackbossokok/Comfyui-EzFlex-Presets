// EzFlex 媒体编号表：实时扫描画布上「生成节点」的媒体输入端口，算出哪个素材接在哪个编号端口上。
// 编号规则（通用，不写死某个模型）：按目标节点自身的输入端口顺序，按媒体类型各自从 1 开始，只数已连接的端口。
//   MiniMaxH3UnifiedToVideo → first_frame=图片1、last_frame=图片2、ref_image_1=图片3、
//                             ref_video_1=视频1、ref_video_audio_1=音频1、ref_audio_1=音频2
//   与 ComfyUI-MiniMax-ContextIR/h3_unified.py 的 <Picture i>/<Video k>/<Audio j> 一致（伴奏排在它的视频之前）。
// 多生成节点：各自独立编号（互不冲突），节点标识 = 画布上看到的节点标题（重命名后用新名字）。
// PromptHelper 的每个提示词卡片绑定一个生成节点，@ 引用按该节点自己的编号表算。
import { app } from "../../scripts/app.js";
import { EZ_PERF } from "./ezflex_service.js";

const MEDIA_WORDS = { image: '图片', video: '视频', audio: '音频', model: '模型' };
const TAG_WORDS = { image: 'Picture', video: 'Video', audio: 'Audio' };
function mediaTypeWord(type) { return MEDIA_WORDS[type] || '图片'; }
function mediaLabelOf(type, n) { return '@' + mediaTypeWord(type) + n; }
function mediaTagOf(type, n) { const w = TAG_WORDS[type]; return w ? '<' + w + ' ' + n + '>' : ''; }
export function mediaKeyOf(m) { return (m && (m.path || m.url || m.name)) || ''; }
export function mediaSizeText(b) { if (b == null || b === '') return ''; const n = Number(b); if (!isFinite(n)) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
export function mediaFormatOf(m) { const s = String((m && (m.name || m.path)) || ''); const t = s.match(/\.([a-z0-9]{1,6})(?:[?#]|$)/i); return t ? t[1].toLowerCase() : ''; }
// 媒体类型以扩展名为准（卡片里存的 type 可能是旧值/猜错的）
export function kindOfName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (/^(png|jpe?g|webp|gif|bmp|tif?f)$/.test(ext)) return 'image';
  if (/^(mp4|webm|mov|mkv|avi|m4v)$/.test(ext)) return 'video';
  if (/^(mp3|wav|flac|ogg|m4a|opus|aac|wma)$/.test(ext)) return 'audio';
  if (/^(obj|glb|gltf|fbx|stl|ply|3ds|dae|blend)$/.test(ext)) return 'model';
  return '';
}

function pushMediaFile(out, f) {
  if (!f || !f.path) return;
  const byName = kindOfName(f.name || f.path);
  const typ = byName || ((f.type || 'other') === 'model_3d' ? 'model' : (f.type || 'other'));
  out.push({
    id: f.id, name: f.name || '', path: f.path, type: typ, size: f.size,
    url: f.url || ('/view?type=input&filename=' + encodeURIComponent(f.name || '') + (f.subfolder ? '&subfolder=' + encodeURIComponent(f.subfolder) : '')),
  });
}
// 单个内置加载节点（Load Image / VHS 视频 / Load Audio …）widget 里的媒体文件。
function widgetMediaOfNode(n) {
  const out = []; const widgets = (n && n.widgets) || [];
  let subfolder = '';
  widgets.forEach((w) => { if (/subfolder|folder/i.test(String((w && w.name) || '')) && typeof w.value === 'string' && w.value) subfolder = w.value; });
  widgets.forEach((w) => {
    const v = w && w.value;
    if (typeof v !== 'string' || !v) return;
    const base = v.split(/[\\/]/).pop();
    const mt = base.match(/\.([a-z0-9]{2,5})$/i);
    if (!mt) return;
    const typ = kindOfName(base) || null;
    if (!typ) return;
    const url = '/view?filename=' + encodeURIComponent(base) + (subfolder ? '&subfolder=' + encodeURIComponent(subfolder) : '') + '&type=input';
    out.push({ name: base, path: v, type: typ, url });
  });
  return out;
}
// 读取 EzFlex-MediaLoader / EzFlex-MediaOut 节点里的素材文件（供 @ 媒体提及与编号使用）。
function ezMediaFilesOfNode(n, g) {
  const out = [];
  const parseCfg = (origin) => {
    let cfg = {};
    try { const w = (origin && origin.widgets || []).find((x) => x.name === 'config'); cfg = JSON.parse(w ? (w.value || '{}') : '{}') || {}; } catch (_) { cfg = {}; }
    return cfg;
  };
  try {
    if (n && n.type === 'EzFlex-MediaLoader') {
      const cfg = parseCfg(n);
      (cfg.groups || []).forEach((gr) => (gr.cards || []).forEach((c) => (c.items || []).forEach((it) => (it.files || []).forEach((f) => pushMediaFile(out, f)))));
      return out;
    }
    if (n && n.type === 'EzFlex-MediaOut') {
      const inp = (n.inputs || [])[0];
      if (!inp || inp.link == null) return [];
      const link = (g.links || {})[inp.link];
      if (!link || link.origin_id == null) return [];
      const origin = ((g._nodes || g.nodes) || []).find((x) => x && x.id === link.origin_id);
      if (!origin || origin.type !== 'EzFlex-MediaLoader') return [];
      const slot = link.origin_slot;
      const sock = (origin.outputs || [])[slot];
      let cardId = sock && sock._ezCardId;
      const cfg = parseCfg(origin);
      if (cardId == null) { const order = []; (cfg.groups || []).forEach((gr) => (gr.cards || []).forEach((c) => order.push(c))); const c = order[slot]; if (c) cardId = c.id; }
      let card = null;
      (cfg.groups || []).forEach((gr) => (gr.cards || []).forEach((c) => { if (String(c.id) === String(cardId)) card = c; }));
      if (!card) return [];
      (card.items || []).forEach((it) => (it.files || []).forEach((f) => pushMediaFile(out, f)));
    }
  } catch (_) {}
  return out;
}
// 上游节点某个输出槽对应的媒体文件（MediaLoader 卡片 / MediaOut 端口 / 内置加载节点 widget）
function mediaFilesOfSlot(up, slot) {
  if (!up) return [];
  const g = up.graph; const t = String(up.type || '');
  if (t === 'EzFlex-MediaLoader') {
    let cfg = {}; try { const w = (up.widgets || []).find((x) => x.name === 'config'); cfg = JSON.parse((w && w.value) || '{}') || {}; } catch (_) { cfg = {}; }
    const cards = []; (cfg.groups || []).forEach((gr) => (gr.cards || []).forEach((c) => cards.push(c)));
    const sock = (up.outputs || [])[slot];
    const cardId = sock && sock._ezCardId;
    const card = cardId != null ? cards.find((c) => String(c.id) === String(cardId)) : cards[slot];
    const out = []; if (card) (card.items || []).forEach((it) => (it.files || []).forEach((f) => pushMediaFile(out, f)));
    return out;
  }
  if (t === 'EzFlex-MediaOut') {
    const off = up._ezLocalOff || {};
    const sock = (up.outputs || [])[slot];
    // MediaOut 面板会把该输出端口实际承载的文件盖到 socket 上（拆分口=1 个文件，卡片/分组口=该组全部文件）。
    const stamped = sock && sock._ezFiles;
    if (stamped && stamped.length) { const out = []; stamped.forEach((f) => { if (!off[f.id]) pushMediaFile(out, f); }); return out; }
    // 没盖到章（面板还没铺开 / 链接指向的槽位已失效）：只做能精确对上的兜底 —— 按 _ezMediaId 找那一个文件，
    // 或拆分模式按槽位序号取。**绝不退回「整张卡片的文件列表」**：那会把 MediaLoader 里没接入生成节点、
    // 或已被「关」掉的素材一起带进编号表和引用媒体（实测踩过）。
    const all = ezMediaFilesOfNode(up, g) || [];
    const mid = sock && sock._ezMediaId;
    if (mid != null) {
      const hit = all.find((f, i) => String(f.id == null ? 'f' + i : f.id) === String(mid));
      if (hit) return off[hit.id] ? [] : [hit];
    }
    if ((up._ezMode || 'split') === 'split') { const f = all[slot]; if (f) return off[f.id] ? [] : [f]; }
    return [];
  }
  return widgetMediaOfNode(up);
}

// ===== 生成节点判定：有媒体输入端口、且不是加载/预览/保存/合成类节点 =====
const GEN_TYPE_HINT = /(minimax|h3|wan|ltx|hunyuan|seedance|veo|kling|sora|cogvideo|mochi|qwen|flux|sd3|sdxl|audio|voice|tts|music|sound)/i;
// 非生成节点（保存/预览/加载/解码/合成/图像处理 等）：即使端口叫 image1 也不算编号目标
const NOT_TARGET = /(save|preview|load|output|decode|encode|combine|merge|concat|batch|split|join|scale|resize|crop|upscale|interpolat|blend|composite|alpha|overlay|paste|stitch|grid|tile|mask|noise|quantize|filter|adjust|rotate|flip|blur|sharpen|repeat|text|note|reroute|primitive|switch|math|list)/i;
// 带编号/引用语义的端口名（first_frame / ref_image_1 / image_2 / video_1 / audio_3 …）
const PORT_STRONG = /((image|img|picture|photo|frame|video|audio|sound)(_?\d+)$)|((ref|reference)_(image|video|audio))|((first|last|start|end)_frame)/i;
const PORT_SKIP = /(mask|latent|noise|clip|cond|control_net|pose|depth|width|height|strength|seed|steps|cfg|scale|denoise)/i;
function portMediaType(inp) {
  // 先看端口名：H3 的 ref_video_1 声明是 io.Image（帧序列）但语义是「参考视频」，标签是 <Video 1>，
  // 所以命名语义优先（audio 要先判，ref_video_audio_1 属于音频）。
  const n = String((inp && inp.name) || '').toLowerCase();
  if (/audio|sound|voice|music|tts/.test(n)) return 'audio';
  if (/video|movie/.test(n)) return 'video';
  if (/image|img|picture|photo|frame/.test(n)) return 'image';
  if (/model_3d|file_3d|mesh|glb/.test(n)) return 'model';
  const t = String((inp && inp.type) || '').toUpperCase();
  if (t === 'IMAGE') return 'image';
  if (t === 'VIDEO') return 'video';
  if (t === 'AUDIO') return 'audio';
  if (t === 'MODEL_3D' || t === 'FILE_3D' || t === 'MESH' || t === 'TRIMESH') return 'model';
  return null;
}
// 节点标识：直接用画布上看到的节点标题（重命名过的就是新名字），不用 #id。
function nodeDisplayName(n) {
  try { const c = n.constructor; if (c && c.nodeData) return String(c.nodeData.display_name || c.nodeData.name || ''); } catch (_) {}
  try { const r = (typeof LiteGraph !== 'undefined' && LiteGraph.registered_node_types) ? LiteGraph.registered_node_types[n.type] : null; if (r && r.title) return String(r.title); } catch (_) {}
  return String(n.type || '');
}
function nodeKeyOf(n) { return String((n && n.title) || '') || nodeDisplayName(n); }
function isIndexTarget(n) {
  if (!n || !n.inputs || !n.inputs.length) return false;
  const type = String(n.type || '');
  if (/^EzFlex-/.test(type)) return false;
  if (NOT_TARGET.test(type)) return false;
  if (!GEN_TYPE_HINT.test(type) && !(n.inputs || []).some((i) => i && !PORT_SKIP.test(String(i.name || '')) && PORT_STRONG.test(String(i.name || '')))) return false;
  return (n.inputs || []).some((i) => i && !PORT_SKIP.test(String(i.name || '')) && portMediaType(i));
}
// 同一端口解析出的文件按媒体键去重：端口扇出 / MediaOut 端口复用时同一素材会被取到两次，
// 不去重会在「引用媒体」里出现重复卡片，编号表也跟着被撑大。
function dedupeFiles(arr) {
  const out = []; const seen = new Set();
  (arr || []).forEach((f) => { const k = mediaKeyOf(f) || (f && f.path); if (k) { if (seen.has(k)) return; seen.add(k); } out.push(f); });
  return out;
}
function filesOnInput(node, inp) {
  const g = node && node.graph; if (!g) return [];
  const link = (g.links || {})[inp.link]; if (!link) return [];
  const up = (((g._nodes || g.nodes) || [])).find((n) => n && String(n.id) === String(link.origin_id));
  return dedupeFiles(filesUpstream(up, link.origin_slot | 0, 0));
}
// 端口上的媒体：直接找到就用；碰到中转节点（内置 Get Video Components / Reroute 等）就顺着它的输入继续往上找。
// 视频现在按内置约定走 VIDEO 口，接生成节点的帧输入时中间会垫一个 Get Video Components，所以必须能穿透。
function filesUpstream(node, slot, depth) {
  if (!node || depth > 4) return [];
  let direct = [];
  try { direct = mediaFilesOfSlot(node, slot) || []; } catch (_) { direct = []; }
  if (direct.length) return direct;
  // ⚠️ EzFlex 自家的加载/输出节点是「端到端定义素材」：这个端口承载什么就是什么，端口空就是空。
  // 不许再顺着它的输入往上捞 —— 否则会捞到 MediaLoader 整张卡片，把没接入生成节点、或已被关掉的
  // 素材全带进编号表和引用媒体（用户实测：只要 MediaOut 接进了生成节点就冒全部已加载文件）。
  const st = String(node.type || '');
  if (st === 'EzFlex-MediaOut' || st === 'EzFlex-MediaLoader') return [];
  const g = node.graph; if (!g) return [];
  for (const inp of (node.inputs || [])) {
    if (!inp || inp.link == null) continue;
    const link = (g.links || {})[inp.link]; if (!link) continue;
    const up = (((g._nodes || g.nodes) || [])).find((n) => n && String(n.id) === String(link.origin_id));
    const got = filesUpstream(up, link.origin_slot | 0, depth + 1);
    if (got.length) return got;
  }
  return [];
}
// 单个目标节点的编号端口表（按输入端口顺序，按类型各自编号）
function scanTargetPorts(node) {
  const ports = []; const counts = {};
  (node.inputs || []).forEach((inp, slot) => {
    if (!inp || inp.link == null) return;
    const name = String(inp.name || '');
    if (PORT_SKIP.test(name)) return;
    const type = portMediaType(inp);
    if (!type) return;
    let files = [];
    try { files = filesOnInput(node, inp) || []; } catch (_) { files = []; }
    if (!files.length) return;
    counts[type] = (counts[type] || 0) + 1;
    ports.push({ slot: slot, name: name, type: type, n: counts[type], label: mediaLabelOf(type, counts[type]), tag: mediaTagOf(type, counts[type]), files: files });
  });
  return ports;
}

// ===== 编号表注册表：每个生成节点一张表（互不冲突），画布变化时实时重建 =====
const _reg = { sig: '', targets: [], maps: new Map(), active: null, listeners: [], timer: 0, hooked: false, dirty: false, pending: 0 };
export function indexTargets() { return _reg.targets; }
export function indexTargetById(id) { return _reg.targets.find((t) => t.id === String(id)) || null; }
export function activeIndexTarget() { return _reg.active; }
export function indexTargetCount() { return _reg.targets.filter((t) => t.ports.length).length; }
// 某个节点**自己输入端口**上的媒体文件（按端口顺序，带端口类型）：供 PromptHelper「点击即用」取它自己「综合媒体」口上的素材。
export function nodeInputMedia(node) {
  const out = [];
  (node && node.inputs || []).forEach((inp) => {
    if (!inp || inp.link == null) return;
    let files = [];
    try { files = filesOnInput(node, inp) || []; } catch (_) { files = []; }
    const portType = portMediaType(inp);
    files.forEach((f) => out.push({ m: f, type: portType || (f && f.type) || 'image', port: String(inp.name || '') }));
  });
  return out;
}
// 查某个素材的引用编号：targetId 省略 = 默认引用目标；返回 null 表示没接入该节点。
export function mediaIndex(key, targetId) {
  if (!key) return null;
  const m = (targetId != null && String(targetId) !== '' && String(targetId) !== 'auto') ? _reg.maps.get(String(targetId)) : (_reg.active ? _reg.maps.get(_reg.active.id) : null);
  return (m && m.get(key)) || null;
}
export function onIndexChange(fn) { _reg.listeners.push(fn); return () => { const i = _reg.listeners.indexOf(fn); if (i >= 0) _reg.listeners.splice(i, 1); }; }

// 编号表只按画布自动识别（每个生成节点一张表）。
// 目标节点所有输入端口的当前媒体（含卡片内换文件/局部禁用），作为「画布真的变了」的判据。
function targetPortSig(n) {
  return (n.inputs || []).map((i) => {
    if (!i) return '';
    if (i.link == null) return i.name + '=-';
    let keys = '';
    try { keys = (filesOnInput(n, i) || []).map(mediaKeyOf).join(','); } catch (_) { keys = ''; }
    return i.name + '=' + i.link + ':' + keys;
  }).join(',');
}
function graphSignature(g) {
  const parts = [];
  ((g && (g._nodes || g.nodes)) || []).forEach((n) => {
    if (!n || !isIndexTarget(n)) return;
    parts.push(String(n.id) + ':' + nodeKeyOf(n) + ':' + targetPortSig(n));
  });
  return parts.join('|');
}
function rebuildIndex(g) {
  const targets = []; const maps = new Map();
  ((g && (g._nodes || g.nodes)) || []).forEach((n) => {
    if (!n || !isIndexTarget(n)) return;
    let ports = [];
    try { ports = scanTargetPorts(n); } catch (_) { ports = []; }
    const t = { node: n, id: String(n.id), type: String(n.type || ''), title: nodeKeyOf(n), ports: ports };
    targets.push(t);
    const map = new Map();
    ports.forEach((p) => p.files.forEach((f) => {
      const k = mediaKeyOf(f);
      if (k && !map.has(k)) map.set(k, { type: p.type, n: p.n, label: p.label, tag: p.tag, port: p.name, targetId: t.id, targetKey: t.title });
    }));
    maps.set(t.id, map);
  });
  const usable = targets.filter((t) => t.ports.length);
  _reg.targets = targets; _reg.maps = maps; _reg.active = usable[0] || null;
  _reg.listeners.forEach((fn) => { try { fn(); } catch (_) {} });
}
// 画布有变化才重建（返回是否重建过），可随时安全调用。
export function refreshIndex() {
  const g = app && app.graph;
  if (!g) return false;
  const sig = graphSignature(g);
  if (!_reg.dirty && sig === _reg.sig) return false;
  _reg.dirty = false; _reg.sig = sig;
  rebuildIndex(g);
  return true;
}
// 合并重建：一帧内多次触发只重建一次（批量连线 / 加载工作流时不再逐个重建）。
export function refreshIndexSoon() {
  if (_reg.pending) return;
  _reg.pending = requestAnimationFrame(() => { _reg.pending = 0; try { refreshIndex(); } catch (_) {} });
}
// 立刻重建（打开引用媒体面板 / @ 菜单前调用，保证读到最新编号）。
export function refreshIndexNow() {
  if (_reg.pending) { cancelAnimationFrame(_reg.pending); _reg.pending = 0; }
  return refreshIndex();
}
function markIndexDirty() { _reg.dirty = true; refreshIndexSoon(); }
// 事件驱动：连线/断线/增删节点（LiteGraph 钩子）+ 媒体节点配置变更（ezflex:config-changed）。
function installIndexHooks() {
  if (_reg.hooked) return; _reg.hooked = true;
  try {
    const proto = (typeof LGraphNode !== 'undefined' && LGraphNode) ? LGraphNode.prototype : null;
    if (proto) {
      ['onConnectionsChange', 'onAdded', 'onRemoved'].forEach((k) => {
        if (typeof proto[k] !== 'function') return;
        const orig = proto[k];
        proto[k] = function () { const r = orig.apply(this, arguments); try { markIndexDirty(); } catch (_) {} return r; };
      });
    }
  } catch (_) {}
  try { window.addEventListener('ezflex:config-changed', () => { try { markIndexDirty(); } catch (_) {} }); } catch (_) {}
}
let _watch = 0;
// 事件驱动为主，低频轮询兜底（保证不漏：面板/第三方节点改了 config 但没发事件也能跟上）。
export function startIndexWatcher(node) {
  installIndexHooks();
  if (_watch) return;
  try { refreshIndex(); } catch (_) {}
  // 兜底不再用定时轮询：由消费者节点的画布重绘（onDrawForeground）触发一次合并刷新，
  // 覆盖「标题改名 / 第三方节点内部换素材」这类没有事件的情况；全静止时零开销。
  if (node) {
    const prevDraw = node.onDrawForeground;
    node.onDrawForeground = function (ctx) { if (prevDraw) prevDraw.call(this, ctx); refreshIndexSoon(); };
    if (typeof node._ezIdxCleanup !== 'function') node._ezIdxCleanup = () => {};
  }
  if (EZ_PERF.indexPollMs > 0) _watch = setInterval(() => { try { refreshIndex(); } catch (_) {} }, EZ_PERF.indexPollMs);
}
