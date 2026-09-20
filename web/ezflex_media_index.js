// EzFlex 媒体编号表：实时扫描画布上「生成节点」的媒体输入端口，算出哪个素材接在哪个编号端口上。
// 编号规则（通用，不写死某个模型）：按目标节点自身的输入端口顺序，按媒体类型各自从 1 开始，只数已连接的端口。
//   MiniMaxH3UnifiedToVideo → first_frame=图片1、last_frame=图片2、ref_image_1=图片3、
//                             ref_video_1=视频1、ref_video_audio_1=音频1、ref_audio_1=音频2
//   与 ComfyUI-MiniMax-ContextIR/h3_unified.py 的 <Picture i>/<Video k>/<Audio j> 一致（伴奏排在它的视频之前）。
// 多生成节点：各自独立编号（互不冲突），节点标识 = 画布上看到的节点标题（重命名后用新名字）。
// PromptHelper 的每个提示词卡片绑定一个生成节点，@ 引用按该节点自己的编号表算。
import { app } from "../../scripts/app.js";
import { EZ_PERF } from "./ezflex_service.js";

const BUILTIN_WORDS = { image: '图片', video: '视频', audio: '音频', model: '模型' };
const TAG_WORDS = { image: 'Picture', video: 'Video', audio: 'Audio' };
// 媒体类型显示词：内置四种用中文词；自定义类型直接用类型名（编号就是 @other1）。
export function mediaWord(type) { return BUILTIN_WORDS[type] || String(type || '图片'); }
function mediaLabelOf(type, n) { return '@' + mediaWord(type) + n; }
function mediaTagOf(type, n) { const w = TAG_WORDS[type]; return w ? '<' + w + ' ' + n + '>' : ''; }

// ===== 引用识别设置（设置页 · 引用识别设置）：默认值 = 原来的硬编码规则，全部按列表存在配置里 =====
// 类型 / 端口列表逐条「包含匹配」（大小写不敏感、不拼正则）；素材来源默认全读，ignoreSources 里的节点类型不读。
// 媒体类型 = [{ id, exts, on }]：exts 决定文件按扩展名归到哪一类，on = 参与编号（也决定引用规则里那一项是否出现/生效）。
const KIND_EXT_DEFAULTS = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'aac', 'wma'],
  model: ['obj', 'glb', 'gltf', 'fbx', 'stl', 'ply', '3ds', 'dae', 'blend'],
};
const MEDIA_DEFAULTS = {
  targetTypes: ['minimax', 'h3', 'wan', 'ltx', 'hunyuan', 'seedance', 'veo', 'kling', 'sora', 'cogvideo', 'mochi', 'qwen', 'flux', 'sd3', 'sdxl', 'audio', 'voice', 'tts', 'music', 'sound'],
  ignoreTypes: ['save', 'preview', 'load', 'output', 'decode', 'encode', 'combine', 'merge', 'concat', 'batch', 'split', 'join', 'scale', 'resize', 'crop', 'upscale', 'interpolat', 'blend', 'composite', 'alpha', 'overlay', 'paste', 'stitch', 'grid', 'tile', 'mask', 'noise', 'quantize', 'filter', 'adjust', 'rotate', 'flip', 'blur', 'sharpen', 'repeat', 'text', 'note', 'reroute', 'primitive', 'switch', 'math', 'list'],
  targetPorts: ['first_frame', 'last_frame', 'start_frame', 'end_frame', 'ref_image', 'ref_video', 'ref_audio', 'reference_image', 'reference_video', 'reference_audio'],
  ignorePorts: ['mask', 'latent', 'noise', 'clip', 'cond', 'control_net', 'pose', 'depth', 'width', 'height', 'strength', 'seed', 'steps', 'cfg', 'scale', 'denoise'],
  ignoreSources: [],
  kinds: [{ id: 'image', on: true }, { id: 'video', on: true }, { id: 'audio', on: true }, { id: 'model', on: false }],
  nameFirst: true,
  relayDepth: 4,
};
const _asList = (v, def) => {
  if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(/[\s,;，、]+/).map((s) => s.trim()).filter(Boolean);
  return def.slice();
};
function normKinds(v) {
  const src = Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? v.split(/[\s,;，、]+/) : MEDIA_DEFAULTS.kinds);
  const out = [];
  (src || []).forEach((k) => {
    if (k == null) return;
    const obj = (typeof k === 'object') ? k : { id: k, on: true };
    const id = String(obj.id || '').trim();
    if (!id || out.some((x) => x.id === id)) return;
    const def = KIND_EXT_DEFAULTS[id] || [];
    const exts = _asList(obj.exts != null ? obj.exts : ((typeof k === 'string') ? def : null), def)
      .map((e) => String(e).replace(/^\.+/, '').toLowerCase()).filter(Boolean);
    out.push({ id: id, exts: exts, on: obj.on !== false });
  });
  return out;
}
function normMediaCfg(o) {
  const c = (o && typeof o === 'object') ? o : {};
  const raw = (c.relayDepth !== undefined && c.relayDepth !== null && c.relayDepth !== '') ? Number(c.relayDepth) : MEDIA_DEFAULTS.relayDepth;
  return {
    targetTypes: _asList(c.targetTypes, MEDIA_DEFAULTS.targetTypes),
    ignoreTypes: _asList(c.ignoreTypes, MEDIA_DEFAULTS.ignoreTypes),
    targetPorts: _asList(c.targetPorts, MEDIA_DEFAULTS.targetPorts),
    ignorePorts: _asList(c.ignorePorts, MEDIA_DEFAULTS.ignorePorts),
    ignoreSources: _asList(c.ignoreSources, MEDIA_DEFAULTS.ignoreSources),
    kinds: normKinds(c.kinds),
    nameFirst: c.nameFirst !== false,
    relayDepth: Math.max(0, Math.min(8, isFinite(raw) ? raw : MEDIA_DEFAULTS.relayDepth)),
  };
}
const _hitAny = (list, text) => { const t = String(text || '').toLowerCase(); return list.some((w) => { const s = String(w || '').toLowerCase(); return s && t.indexOf(s) >= 0; }); };
// 素材来源：MediaLoader / MediaOut 各用专用读取器，其它节点扫 widget；ignoreSources 命中的节点类型一律不读。
function sourceBlocked(type) { return _hitAny(_mediaCfg.ignoreSources, type); }
let _mediaCfg = normMediaCfg(null);
export function mediaTargetDefaults() { return normMediaCfg(null); }
export function mediaTargetCfg() { return _mediaCfg; }
// 设置页保存后调用：换配置 + 强制重建编号表（下一帧合并重建）。
export function setMediaTargetCfg(o) { _mediaCfg = normMediaCfg(o); _reg.dirty = true; try { refreshIndexSoon(); } catch (_) {} }
export function mediaKeyOf(m) { return (m && (m.path || m.url || m.name)) || ''; }
export function mediaSizeText(b) { if (b == null || b === '') return ''; const n = Number(b); if (!isFinite(n)) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
export function mediaFormatOf(m) { const s = String((m && (m.name || m.path)) || ''); const t = s.match(/\.([a-z0-9]{1,6})(?:[?#]|$)/i); return t ? t[1].toLowerCase() : ''; }
// 媒体类型以扩展名为准（卡片里存的 type 可能是旧值/猜错的）
export function kindOfName(name) {
  const m = String(name || '').match(/\.([a-z0-9]{1,6})(?:[?#]|$)/i);
  if (!m) return '';
  const ext = m[1].toLowerCase();
  for (const k of _mediaCfg.kinds) { if ((k.exts || []).indexOf(ext) >= 0) return k.id; }
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
      if (sourceBlocked('EzFlex-MediaLoader')) return [];
      const cfg = parseCfg(n);
      (cfg.groups || []).forEach((gr) => (gr.cards || []).forEach((c) => (c.items || []).forEach((it) => (it.files || []).forEach((f) => pushMediaFile(out, f)))));
      return out;
    }
    if (n && n.type === 'EzFlex-MediaOut') {
      if (sourceBlocked('EzFlex-MediaOut')) return [];
      const inp = (n.inputs || [])[0];
      if (!inp || inp.link == null) return [];
      const link = (g.links || {})[inp.link];
      if (!link || link.origin_id == null) return [];
      const origin = ((g._nodes || g.nodes) || []).find((x) => x && x.id === link.origin_id);
      if (!origin || origin.type !== 'EzFlex-MediaLoader' || sourceBlocked(origin.type)) return [];
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
// ===== 素材读取器注册表：节点类型 → { read(node, slot), terminal } =====
// 以后新增自家「读素材」节点（或要特判的第三方节点）只需 registerMediaSource(type, read)，不用再改下面的 if。
// terminal = 该节点端到端定义素材：这个端口取不到就是没有，不再顺着它的输入往上捞（MediaLoader/MediaOut 就是这种）。
const _srcReaders = new Map();
export function registerMediaSource(type, read, opts) { _srcReaders.set(String(type), { read: read, terminal: !(opts && opts.relay) }); }
function readLoaderSlot(up, slot) {
  let cfg = {}; try { const w = (up.widgets || []).find((x) => x.name === 'config'); cfg = JSON.parse((w && w.value) || '{}') || {}; } catch (_) { cfg = {}; }
  const cards = []; (cfg.groups || []).forEach((gr) => (gr.cards || []).forEach((c) => cards.push(c)));
  const sock = (up.outputs || [])[slot];
  const cardId = sock && sock._ezCardId;
  const card = cardId != null ? cards.find((c) => String(c.id) === String(cardId)) : cards[slot];
  const out = []; if (card) (card.items || []).forEach((it) => (it.files || []).forEach((f) => pushMediaFile(out, f)));
  return out;
}
function readMediaOutSlot(up, slot) {
  const off = up._ezLocalOff || {};
  const sock = (up.outputs || [])[slot];
  // MediaOut 面板会把该输出端口实际承载的文件盖到 socket 上（拆分口=1 个文件，卡片/分组口=该组全部文件）。
  const stamped = sock && sock._ezFiles;
  if (stamped && stamped.length) { const out = []; stamped.forEach((f) => { if (!off[f.id]) pushMediaFile(out, f); }); return out; }
  // 没盖到章（面板还没铺开 / 链接指向的槽位已失效）：只做能精确对上的兜底 —— 按 _ezMediaId 找那一个文件，
  // 或拆分模式按槽位序号取。**绝不退回「整张卡片的文件列表」**：那会把 MediaLoader 里没接入生成节点、
  // 或已被「关」掉的素材一起带进编号表和引用媒体（实测踩过）。
  const all = ezMediaFilesOfNode(up, up.graph) || [];
  const mid = sock && sock._ezMediaId;
  if (mid != null) {
    const hit = all.find((f, i) => String(f.id == null ? 'f' + i : f.id) === String(mid));
    if (hit) return off[hit.id] ? [] : [hit];
  }
  if ((up._ezMode || 'split') === 'split') { const f = all[slot]; if (f) return off[f.id] ? [] : [f]; }
  return [];
}
registerMediaSource('EzFlex-MediaLoader', readLoaderSlot);
registerMediaSource('EzFlex-MediaOut', readMediaOutSlot);
// 上游节点某个输出槽对应的媒体文件：注册的专用读取器优先，其余节点扫 widget（内置 / 第三方加载节点）。
function mediaFilesOfSlot(up, slot) {
  if (!up) return [];
  const t = String(up.type || '');
  const rd = _srcReaders.get(t);
  if (rd) { if (sourceBlocked(t)) return []; try { return rd.read(up, slot) || []; } catch (_) { return []; } }
  return sourceBlocked(t) ? [] : widgetMediaOfNode(up);
}

// ===== 生成节点判定：有媒体输入端口、且不是加载/预览/保存/合成类节点（类型/端口名单见上方 MEDIA_DEFAULTS）=====
// 带编号语义的端口名：媒体词 + 数字结尾（image_1 / ref_video_2 / audio3 …）。结构化规则不放进列表。
const PORT_NUMBERED = /(image|img|picture|photo|frame|video|audio|sound)(_?\d+)$/i;
function nameMediaType(n) {
  if (/audio|sound|voice|music|tts/.test(n)) return 'audio';
  if (/video|movie/.test(n)) return 'video';
  if (/image|img|picture|photo|frame/.test(n)) return 'image';
  if (/model_3d|file_3d|mesh|glb/.test(n)) return 'model';
  return null;
}
function declMediaType(t) {
  t = String(t || '').toUpperCase();
  if (t === 'IMAGE') return 'image';
  if (t === 'VIDEO') return 'video';
  if (t === 'AUDIO') return 'audio';
  if (t === 'MODEL_3D' || t === 'FILE_3D' || t === 'MESH' || t === 'TRIMESH') return 'model';
  return null;
}
function portMediaType(inp) {
  // 先看端口名：H3 的 ref_video_1 声明是 io.Image（帧序列）但语义是「参考视频」，标签是 <Video 1>，
  // 默认命名语义优先（audio 要先判，ref_video_audio_1 属于音频）；「引用识别设置」可切成声明类型优先。
  const byName = nameMediaType(String((inp && inp.name) || '').toLowerCase());
  const byDecl = declMediaType(inp && inp.type);
  const t = _mediaCfg.nameFirst ? (byName || byDecl) : (byDecl || byName);
  return (t && _mediaCfg.kinds.some((k) => k.on && k.id === t)) ? t : null;
}
// 节点标识：直接用画布上看到的节点标题（重命名过的就是新名字），不用 #id。
function nodeDisplayName(n) {
  try { const c = n.constructor; if (c && c.nodeData) return String(c.nodeData.display_name || c.nodeData.name || ''); } catch (_) {}
  try { const r = (typeof LiteGraph !== 'undefined' && LiteGraph.registered_node_types) ? LiteGraph.registered_node_types[n.type] : null; if (r && r.title) return String(r.title); } catch (_) {}
  return String(n.type || '');
}
function nodeKeyOf(n) { return String((n && n.title) || '') || nodeDisplayName(n); }
function portIgnored(name) { return _hitAny(_mediaCfg.ignorePorts, name); }
function isIndexTarget(n) {
  if (!n || !n.inputs || !n.inputs.length) return false;
  const type = String(n.type || '');
  if (/^EzFlex-/.test(type)) return false;
  if (_hitAny(_mediaCfg.ignoreTypes, type)) return false;
  const strong = (n.inputs || []).some((i) => i && !portIgnored(i.name) && (PORT_NUMBERED.test(String(i.name || '')) || _hitAny(_mediaCfg.targetPorts, i.name)));
  if (!_hitAny(_mediaCfg.targetTypes, type) && !strong) return false;
  return (n.inputs || []).some((i) => i && !portIgnored(i.name) && portMediaType(i));
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
  if (!node || depth > _mediaCfg.relayDepth) return [];
  let direct = [];
  try { direct = mediaFilesOfSlot(node, slot) || []; } catch (_) { direct = []; }
  if (direct.length) return direct;
  // ⚠️ EzFlex 自家的加载/输出节点是「端到端定义素材」：这个端口承载什么就是什么，端口空就是空。
  // 不许再顺着它的输入往上捞 —— 否则会捞到 MediaLoader 整张卡片，把没接入生成节点、或已被关掉的
  // 素材全带进编号表和引用媒体（用户实测：只要 MediaOut 接进了生成节点就冒全部已加载文件）。
  const src = _srcReaders.get(String(node.type || ''));
  if (src && src.terminal) return [];
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
// 端口名 / 声明类型都认不出来时，用上游文件的扩展名归类（自定义媒体类型走这条）
function kindFromFiles(files) {
  for (const f of (files || [])) {
    const t = f && f.type;
    if (t && _mediaCfg.kinds.some((k) => k.on && k.id === t)) return t;
  }
  return null;
}
// 单个目标节点的编号端口表（按输入端口顺序，按类型各自编号）
function scanTargetPorts(node) {
  const ports = []; const counts = {};
  (node.inputs || []).forEach((inp, slot) => {
    if (!inp || inp.link == null) return;
    const name = String(inp.name || '');
    if (portIgnored(name)) return;
    let files = [];
    try { files = filesOnInput(node, inp) || []; } catch (_) { files = []; }
    if (!files.length) return;
    const type = portMediaType(inp) || kindFromFiles(files);
    if (!type) return;
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
