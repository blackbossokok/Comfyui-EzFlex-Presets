// EzFlex-MediaOut 素材输出（内嵌 addDOMWidget 面板）。
// 输入 = 一个「素材卡片」端口（EzFlex-MediaLoader 的深红 * 输出）；
// 输出 = 该卡片内每个文件一个端口，类型按文件真实媒体类型（IMAGE/VIDEO/AUDIO/MODEL_3D）。
// 单文件卡片 = 1 个输出；多文件（批量）卡片 = N 个输出。局部禁用某文件时保留端口、输出 None。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { NODE_TYPES, nodeTypeOf, findNodeById, configWidget, installResizeHandles, makeDomWidgetHitThrough, hideNativeSlotText, TYPE_ICONS, model3dIcon, notifyConfigChanged, scheduleOnRedraw, pumpFrames, pageRange } from "./ezflex_service.js";
import { ezT, onLocaleChange } from "./ezflex_i18n.js";
import { ezThemeInit } from "./ezflex_theme.js";

// 3D 模型统一用 PNG 图标（TYPE_ICONS.model_3d 是 SVG，别的节点仍用）
const is3dKind = (k) => /^(model_3d|model|3d)$/.test(String(k || '').toLowerCase());
const iconFor = (k, s) => (is3dKind(k) ? model3dIcon(s) : (TYPE_ICONS[k] || TYPE_ICONS.other));

const NODE = NODE_TYPES.MEDIA_OUT;
const API = "/media_out/outputs";
// 媒体类型 → ComfyUI 端口类型：与内置加载节点一致（Load Image→IMAGE / Load Video→VIDEO / Load Audio→AUDIO / Load3D→FILE_3D）
const CARD_COLOR = '#d94848';   // 卡片口深红（专属类型没有内置默认色，显式上色）
const TYPE_MAP = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', model_3d: 'FILE_3D', model: 'FILE_3D', '3d': 'FILE_3D', other: 'STRING', text: 'STRING' };
const TYPE_COLOR = { IMAGE: '#4a9eff', VIDEO: '#e0645c', AUDIO: '#34a853', FILE_3D: '#b15bd6', MODEL_3D: '#b15bd6', STRING: '#9aa7b5' };
// 端口着色按「文件真实类型」走（视频端口类型是 '*'，取不到颜色）
const KIND_COLOR = { image: '#4a9eff', video: '#e0645c', audio: '#34a853', model_3d: '#b15bd6', other: '#9aa7b5' };

const CSS = `
.emoo-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.emoo-shell .emoo-root{pointer-events:auto;}
.emoo-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:var(--ez-fg);background:var(--ez-bg);border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.emoo-root *{box-sizing:border-box;user-select:none;-webkit-user-select:none;}
.emoo-hd{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;}
.emoo-title{font-weight:550;font-size:13px;color:var(--ez-fg);}
.emoo-mode{display:flex;background:var(--ez-surface-3);border-radius:8px;padding:2px;border:1px solid var(--ez-border);flex:0 0 auto;}
.emoo-mode button{background:transparent;border:none;padding:2px 10px;font-size:11px;font-weight:470;color:var(--ez-fg-2);font-family:inherit;cursor:pointer;border-radius:6px;transition:all .1s;height:24px;line-height:1;}
.emoo-mode button.active{background:var(--ez-bg);color:var(--ez-fg);box-shadow:0 1px 4px rgba(0,0,0,.06);font-weight:510;}
.emoo-status{font-size:10px;color:var(--ez-fg-muted);white-space:nowrap;}
.emoo-status.on{color:var(--ez-ok-fg);font-weight:500;}
.emoo-lblbtn{display:inline-flex;align-items:center;gap:3px;height:24px;padding:0 8px;border-radius:8px;border:1px solid var(--ez-border);background:var(--ez-surface-3);color:var(--ez-fg-muted);font-family:inherit;font-size:11px;font-weight:500;cursor:pointer;flex:0 0 auto;line-height:1;}
.emoo-lblbtn:hover{background:var(--ez-surface-4);}
.emoo-lblbtn.on{background:var(--ez-ok-bg);border-color:var(--ez-ok-border);color:var(--ez-ok-fg);}
.emoo-lblbtn.off{background:var(--ez-surface-3);border-color:var(--ez-border);color:var(--ez-fg-muted);}
.emoo-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;}
.emoo-page{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:0 0 auto;padding-top:4px;border-top:1px solid var(--ez-border-2);font-size:12px;color:var(--ez-fg-3);justify-content:space-between;}
.emoo-page-l,.emoo-page-r{display:flex;align-items:center;gap:4px;flex:0 0 auto;}
.emoo-page-r input{width:52px;}
.emoo-page button{background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:6px;min-width:24px;height:24px;font-size:12px;cursor:pointer;color:var(--ez-fg-2);padding:0 6px;font-family:inherit;}
.emoo-page button:disabled{opacity:.4;cursor:default;}
.emoo-page button.active{background:var(--ez-strong);border-color:var(--ez-strong);color:var(--ez-on-strong);}
.emoo-page input{width:46px;height:24px;border:1px solid var(--ez-border);border-radius:6px;font-size:12px;text-align:center;outline:none;font-family:inherit;}
.emoo-root input[type=number]{-moz-appearance:textfield;appearance:textfield;}
.emoo-root input[type=number]::-webkit-inner-spin-button,.emoo-root input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
.emoo-row{display:flex;align-items:center;gap:8px;background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:10px;padding:6px 8px;flex-wrap:wrap;}
.emoo-sq{width:22px;height:22px;border-radius:6px;flex:0 0 auto;background:var(--ez-surface-3);border:1px solid var(--ez-border-2);display:flex;align-items:center;justify-content:center;color:var(--ez-fg-2);}
.emoo-name{font-size:12px;font-weight:480;flex:1 1 90px;min-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ez-fg);}
.emoo-type{font-size:10px;color:var(--ez-fg-3);background:var(--ez-surface-3);padding:0 10px;border-radius:100px;line-height:20px;}
.emoo-toggle{display:flex;background:var(--ez-surface-3);border-radius:8px;padding:2px;border:1px solid var(--ez-border);flex:0 0 auto;}
.emoo-toggle button{background:transparent;border:none;padding:2px 10px;font-size:11px;font-weight:470;color:var(--ez-fg-2);font-family:inherit;cursor:pointer;border-radius:6px;transition:all .1s;height:24px;line-height:1;}
.emoo-toggle button.active{background:var(--ez-bg);color:var(--ez-fg);box-shadow:0 1px 4px rgba(0,0,0,.06);font-weight:510;}
.emoo-toggle button.on.active{background:var(--ez-ok-bg);color:var(--ez-ok-fg);border:1px solid var(--ez-ok-border);}
.emoo-toggle button.off.active{background:var(--ez-bad-bg);color:var(--ez-bad-fg);border:1px solid var(--ez-bad-border);}
.emoo-empty{color:var(--ez-fg-muted);font-size:12px;text-align:center;padding:14px;}
.emoo-fitbar{display:flex;gap:6px;flex:0 0 auto;}
.emoo-fitbar .emoo-fit-btn{height:24px;font-size:11px;padding:0 10px;}
.emoo-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100070;background:rgba(0,0,0,.35);font-family:Inter,sans-serif;}
.emoo-modal.active{display:flex;}
.emoo-modal-box{background:var(--ez-bg);border-radius:14px;width:420px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.24);box-sizing:border-box;}
.emoo-modal-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--ez-border-2);}
.emoo-modal-hd b{font-size:14px;color:var(--ez-fg);}
.emoo-modal-close{border:none;background:transparent;color:var(--ez-fg-muted);font-size:16px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;font-family:inherit;}
.emoo-modal-close:hover{background:var(--ez-surface-3);color:var(--ez-fg-2);}
.emoo-modal-body{padding:12px 16px;display:flex;flex-direction:column;gap:10px;overflow:auto;}
.emoo-setf{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--ez-fg-3);}
.emoo-setf > span{font-weight:500;}
.emoo-setrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.emoo-sethint{font-size:10px;color:var(--ez-fg-muted);line-height:1.6;}
.emoo-setx{color:var(--ez-fg-muted);}
.emoo-btn{background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:var(--ez-fg);font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;line-height:1;}
.emoo-btn:hover{background:var(--ez-surface-3);}
.emoo-btn.primary{background:var(--ez-strong);border-color:var(--ez-strong);color:var(--ez-on-strong);}
.emoo-btn.primary:hover{background:var(--ez-strong);}
.emoo-modal select,.emoo-modal input{height:26px;border:1px solid var(--ez-border);border-radius:7px;font-size:11px;font-family:inherit;color:var(--ez-fg-2);background:var(--ez-bg);outline:none;padding:0 6px;}
.emoo-modal input[type=number]{width:76px;text-align:center;}
.emoo-modal input:disabled{background:var(--ez-surface-3);color:var(--ez-fg-muted);}
.emoo-modal-ft{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--ez-border-2);}
.emoo-socket-label{position:fixed;z-index:20;pointer-events:none;background:rgba(12,16,24,.4);color:#eef1f6;font-size:9px;line-height:1;padding:2px 6px;border-radius:3px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;user-select:none;display:inline-flex;align-items:center;}
.emoo-socket-label svg{width:1.2em;height:1.2em;flex:0 0 auto;}
.emoo-socket-label .emoo-sockic{display:inline-flex;align-items:center;margin-right:1px;}
.emoo-no{min-width:14px;flex:0 0 auto;font-size:10px;color:var(--ez-fg-3);text-align:right;font-variant-numeric:tabular-nums;}
`;

let _styleInjected = false;
let _widgetSeq = 0;
// 输出端口文件名黑框标签的全局开关：绿=显示、灰=隐藏（文件名太长看不见画布时用）
const MO_LABELS_LS = 'ezflex.moLabels';
let _moLabels = null;
function moLabelsOn() {
  if (_moLabels === null) { try { _moLabels = window.localStorage.getItem(MO_LABELS_LS) !== '0'; } catch (_) { _moLabels = true; } }
  return _moLabels;
}
function moLabelsSet(on) {
  _moLabels = !!on;
  try { window.localStorage.setItem(MO_LABELS_LS, _moLabels ? '1' : '0'); } catch (_) {}
  document.querySelectorAll('.emoo-lblbtn').forEach((b) => { b.classList.toggle('on', _moLabels); b.classList.toggle('off', !_moLabels); b.title = _moLabels ? ezT('Hide port labels') : ezT('Show port labels'); });
  try { if (app && app.graph) app.graph.setDirtyCanvas(true, true); } catch (_) {}
  try { pumpFrames(); } catch (_) {}
}
const MO_LABEL_ICON = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2V4h9.4l7.8 7.8a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.1"/></svg>';
function injectStyle() {
  ezThemeInit(); if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function nextWidgetType() { _widgetSeq += 1; return 'emoo-config__' + _widgetSeq.toString(36); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
function configWidgetOf(node) { return configWidget(node); }

// ===== config：只保留「局部禁用」（输出模式/拼接已移到 MediaLoader）=====
function readLocalOff(node) {
  const w = configWidgetOf(node); if (!w) return {};
  try {
    const cfg = JSON.parse(w.value || '{}') || {};
    const off = Array.isArray(cfg.off) ? cfg.off : []; const m = {};
    off.forEach((id) => { m[id] = true; });
    return m;
  } catch (_) { return {}; }
}
function writeLocalOff(node) {
  const w = configWidgetOf(node); if (!w) return;
  const map = node._ezLocalOff || {};
  const items = (connectedItems(node) || {}).items || [];
  const off = []; const offIdx = [];
  Object.keys(map).forEach((k) => { if (map[k]) { off.push(k); const i = items.findIndex((x) => String(x.id) === String(k)); if (i >= 0) offIdx.push(i); } });
  w.value = JSON.stringify({ off, offIdx });
  if (typeof w.callback === 'function') w.callback(w.value);
  if (node.graph) node.graph.setDirtyCanvas(true, true);
  notifyConfigChanged(node);
}
function str(s) { return (s === undefined || s === null) ? '' : String(s); }

// ===== 读取所连 MediaLoader 口上的项（loader 端 mlPortItems 算好挂在 socket._ezItems）=====
function connectedItems(node) {
  const inp = (node.inputs || [])[0];
  if (!inp || inp.link == null) return null;
  const graph = node.graph;
  const link = graph && graph.links && graph.links[inp.link];
  if (!link) return null;
  const origin = findNodeById(link.origin_id) || (graph && graph._nodes ? graph._nodes.find((n) => n && String(n.id) === String(link.origin_id)) : null);
  if (!origin) return null;
  const sock = (origin.outputs || [])[link.origin_slot];
  // 任何上游口只要挂了 _ezItems 就能拆（MediaLoader 一定有；MergeList/SplitList/TimeLine 也会挂）
  return { origin, items: (sock && Array.isArray(sock._ezItems)) ? sock._ezItems : [] };
}
function kindOf(n) {
  const ext = (n || '').split('.').pop().toLowerCase();
  if (/^(png|jpe?g|webp|gif|bmp|tif?f)$/.test(ext)) return 'image';
  if (/^(mp4|avi|mkv|mov|webm|m4v)$/.test(ext)) return 'video';
  if (/^(mp3|wav|flac|aac|ogg|m4a|wma|opus)$/.test(ext)) return 'audio';
  if (/^(gltf|glb|obj|fbx|stl|ply|3ds|dae|blend)$/.test(ext)) return 'model_3d';
  return 'other';
}
// 文件类型以扩展名为准（卡片里存的 type 可能是旧值/猜错的，会导致端口类型不对、连不上目标节点的输入）
function fileKind(f) {
  const byName = kindOf((f && (f.name || f.path)) || '');
  if (byName !== 'other') return byName;
  return String((f && f.type) || 'other').toLowerCase();
}
// 端口承载的媒体类型（盖过章的按文件类型，没盖章的退回端口声明类型）——切换输出模式时按它「同类型补位」
function sockKind(s) {
  const files = (s && (s._ezFiles || s._ezItems)) || [];
  const f0 = Array.isArray(files) ? files.find((x) => x) : null;
  if (f0) { const k = fileKind(f0); if (k !== 'other') return k; }
  const t = String((s && s.type) || '').toUpperCase();
  const byType = ({ IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', FILE_3D: 'model_3d', MODEL_3D: 'model_3d' })[t];
  if (byType) return byType;
  const n = String((s && s.name) || '');   // 类型是 '*' 的旧工作流：从端口名兜底（文件名带扩展名，槽位口叫 Image 1 / Video 1）
  const byName = kindOf(n);
  if (byName !== 'other') return byName;
  if (/video|视频/i.test(n)) return 'video';
  if (/audio|音频/i.test(n)) return 'audio';
  if (/image|图片|picture/i.test(n)) return 'image';
  if (/model|3d|模型/i.test(n)) return 'model_3d';
  return 'other';
}
// 输出口类型/名字由 loader 端 _ezItems 提供，这里不再按整张结构归组。

// 卡片输入口上色（专属类型 EZFLEX_MEDIA_CARD 没有内置默认色，按文档保持深红）
function paintCardSocket(node) {
  try {
    const inp = (node.inputs || [])[0];
    if (inp) { inp.color_on = CARD_COLOR; inp.color_off = CARD_COLOR; inp.color = CARD_COLOR; }
  } catch (_) {}
}
// 固定模式：端口跟随上游 MediaLoader 的槽位声明（类型+数量），运行期值由 loader 按槽位排好
function fixedSlotsOf(node) {
  const conn = connectedItems(node); const up = conn && conn.origin;
  if (!up || !Array.isArray(up.widgets)) return null;
  const w = up.widgets.find((x) => x && x.name === 'config');
  if (!w) return null;
  try {
    const cfg = JSON.parse(w.value || '{}') || {};
    const fx = cfg.fixed || {};
    if (!fx.on || !Array.isArray(fx.slots)) return null;
    return fx.slots.filter((s) => s && s.type && (parseInt(s.n, 10) || 0) > 0);   // 全 0 时返回空表 = 不出口，和 loader 的 0 槽位一致
  } catch (_) { return null; }
}
const SLOT_KIND = { image: 'image', video: 'video', video_audio: 'audio', audio: 'audio', model3d: 'model_3d', text: 'other', other: 'other' };
const SLOT_TYPE = { image: 'IMAGE', video: 'VIDEO', video_audio: 'AUDIO', audio: 'AUDIO', model3d: 'FILE_3D', text: 'STRING', other: 'STRING' };
const SLOT_NAME = { image: 'Image', video: 'Video', video_audio: 'Video audio', audio: 'Audio', model3d: 'Model', text: 'Text', other: 'Other' };
function fixedWant(slots, items) {
  const want = []; let i = 0;
  (slots || []).forEach((s) => {
    const t = String(s.type); const n = Math.max(0, parseInt(s.n, 10) || 0);
    for (let k = 0; k < n; k++) {
      const it = (items && items[i]) || null; i += 1;   // 上游 Segment 口是按槽位顺序给的，按位对上（有 path/url 才出缩略图）
      const key = (it && it.id != null) ? String(it.id) : ('slot:' + t + ':' + k);   // 有素材 → 端口身份 = 素材 id
      want.push({ id: 'slot:' + t + ':' + k, key, name: (SLOT_NAME[t] || t) + ' ' + (k + 1), ord: k + 1, n: 0,
                  type: SLOT_TYPE[t] || 'STRING', kind: SLOT_KIND[t] || 'other', back: SLOT_KIND[t] || 'other', files: it ? [it] : [] });
    }
  });
  return want;
}
// 刷新/重启时前端是先建节点、后铺 graph.links：链路没恢复就重排，会按空 items 把保存的端口全删掉 —— 连线就断了。
// 上游口还没盖章（面板没铺）同理：先等，最多等一小会儿（第三方上游永远不盖章时兜底放行）。
function mediaOutUpstreamReady(node, inp) {
  const g = node.graph;
  const L = g && g.links && g.links[inp.link];
  if (!L) return false;
  const up = (g.getNodeById ? g.getNodeById(L.origin_id) : null) || (((g._nodes || g.nodes) || []).find((n) => n && String(n.id) === String(L.origin_id)));
  const sock = up && up.outputs && up.outputs[L.origin_slot];
  if (!sock || !Array.isArray(sock._ezItems)) return false;
  // 固定模式要等 loader 的 config 能读到：否则 fixedSlotsOf 返回 null，会被当成普通模式按空 items 重排。
  if (fixedSlotsOf(node)) return true;
  return sock._ezItems.some((x) => x);   // 普通模式：至少有一个真实素材才算铺好
}
// 给一个端口盖上素材身份/名字/类型/标签/颜色。返回是否真的改了（用来决定要不要通知下游）。
function applySockMeta(sock, w) {
  let changed = false;
  const kk = (w.key != null) ? String(w.key) : String(w.id);
  if (sock._ezMediaId !== kk) { sock._ezMediaId = kk; changed = true; }
  if (sock.name !== w.name) { sock.name = w.name; changed = true; }
  if (String(sock.type) !== w.type) { try { sock.type = w.type; } catch (_) {} changed = true; }
  try {
    const lab = String(w.ord) + (w.n > 1 ? (' ×' + w.n) : '');
    hideNativeSlotText(sock); sock.hidden = false;
    sock._ezLabel = lab;
    sock._ezLabelHtml = '<span class="emoo-sockic">' + iconFor(w.kind) + '</span>_' + lab;
    sock._ezFiles = w.files || []; sock._ezItems = w.files || [];
  } catch (_) {}
  const col = TYPE_COLOR[w.type] || KIND_COLOR[w.kind];
  if (col && (sock.color_on !== col || sock.color !== col)) { sock.color_on = col; sock.color_off = col; sock.color = col; changed = true; }
  return changed;
}
function updatePorts(node, noRedraw) {
  if (!node || !node.outputs) return false;
  paintCardSocket(node);
  const inp0 = (node.inputs || [])[0];
  if (inp0 && inp0.link != null && !mediaOutUpstreamReady(node, inp0)) {
    node._ezMoDeferN = (node._ezMoDeferN || 0) + 1;
    if (node._ezMoDeferN <= 20) {
      if (!node._ezMoDeferIv) node._ezMoDeferIv = setTimeout(() => { node._ezMoDeferIv = null; try { updatePorts(node, noRedraw); } catch (_) {} }, 120);
      return false;
    }
  } else { node._ezMoDeferN = 0; }
  const conn = connectedItems(node);
  const items = conn ? conn.items : [];
  const slots = fixedSlotsOf(node);   // 上游 MediaLoader 开了固定模式就自动跟随，不需要手动开关
  // 固定模式：端口 = 槽位（缺槽运行期 None）；否则一个 list 项 → 一个输出口
  const want = slots ? fixedWant(slots, items) : items.map((it, i) => {
    const k = fileKind(it);
    return { id: String(it.id != null ? it.id : ('f' + i)), name: it.name || ezT('File'), ord: i + 1, n: parseInt(it.n, 10) || 0,
             type: it.mixed ? '*' : (TYPE_MAP[k] || 'STRING'), kind: k, files: [it] };
  });
  let changed = false;
  const old = (node.outputs || []).slice();
  const gl = (node.graph && node.graph.links) || {};
  // 本节点所有出线（新前端不保证维护 socket.links，graph.links 才准）；slot = 旧端口下标
  const outgoing = [];
  Object.keys(gl).forEach((lid) => {
    const L = gl[lid];
    if (!L || String(L.origin_id) !== String(node.id) || L.origin_slot == null) return;
    outgoing.push({ lid: (L.id != null ? L.id : (isFinite(Number(lid)) ? Number(lid) : lid)), slot: Number(L.origin_slot) || 0 });
  });
  const linked = new Set(); outgoing.forEach((o) => linked.add(o.slot));
  // 复用与补位都要看「重排前」的身份/类型：下面的复用会把 socket 上的 _ezMediaId/_ezFiles 覆盖掉
  const oldMeta = old.map((s) => ({ mid: s._ezMediaId != null ? String(s._ezMediaId) : null, kind: sockKind(s) }));

  // 重载/重跑：端口布局和保存的一模一样（种类序列相同）→ 只原地更元数据，绝不重排/删口。
  // 这是刷新/重启不丢线的兜底：不碰 node.outputs、不碰任何链接。
  if (old.length === want.length && old.every((s, i) => sockKind(s) === (want[i].kind || 'other'))) {
    let meta = false;
    want.forEach((w, i) => { if (applySockMeta(old[i], w)) meta = true; });
    node._ezMoFresh = false;
    if (meta) { syncOutputTypes(node); notifyOut(node); if (node.graph) node.graph.setDirtyCanvas(true, true); }
    return meta;
  }

  // 旧端口 → 新端口：先按素材身份（同一素材的线跟着素材走），剩下的按「同类型里的第几个」补位 ——
  // 切模式时类型顺序会重排，原来接第 2 张图的线要落到新的「图片 2」上，不能按端口下标硬套。
  const wantKey = want.map((w) => (w.key != null ? String(w.key) : String(w.id)));
  const kindQueue = new Map();
  want.forEach((w, j) => { const k = w.kind || 'other'; if (!kindQueue.has(k)) kindQueue.set(k, []); kindQueue.get(k).push(j); });
  const claimed = new Set(); const targetOf = new Map();
  old.forEach((s, i) => {
    if (!linked.has(i) || oldMeta[i].mid == null) return;
    const j = wantKey.indexOf(oldMeta[i].mid);
    if (j >= 0 && !claimed.has(j)) { claimed.add(j); targetOf.set(i, j); }
  });
  old.forEach((s, i) => {
    if (!linked.has(i) || targetOf.has(i)) return;
    const q = kindQueue.get(oldMeta[i].kind) || [];
    const j = q.find((x) => !claimed.has(x));
    if (j != null) { claimed.add(j); targetOf.set(i, j); }
  });

  // 刚重载完、布局和保存的对不上（上游内容/配置还没铺好）：这次先不动，免得把保存的连线按新布局删掉。
  // 上游配置变化会走 _ezMediaOutUpdate（那里清 _ezMoFresh），用户切模式/改槽位时才真正重排。
  if (node._ezMoFresh && outgoing.some((o) => !targetOf.has(o.slot))) {
    node._ezMoDeferN = (node._ezMoDeferN || 0) + 1;
    if (node._ezMoDeferN <= 20) {
      if (!node._ezMoDeferIv) node._ezMoDeferIv = setTimeout(() => { node._ezMoDeferIv = null; try { updatePorts(node, noRedraw); } catch (_) {} }, 120);
      return false;
    }
  }
  node._ezMoFresh = false;

  const used = new Set(); const seq = [];
  want.forEach((w) => {
    const kk = (w.key != null) ? String(w.key) : String(w.id);
    const wk = w.kind || 'other';
    let sock = null;
    // 1) 同一素材的端口优先复用（线也在它身上，位置不动）
    for (let i = 0; i < old.length; i++) { if (!used.has(i) && oldMeta[i].mid === kk) { sock = old[i]; used.add(i); break; } }
    // 2) 同类型复用：切模式后端口类型顺序会重排，别把视频口套到图片口上
    if (!sock) { for (let i = 0; i < old.length; i++) { if (!used.has(i) && oldMeta[i].kind === wk) { sock = old[i]; used.add(i); break; } } }
    // 3) 剩下按位置复用（保住端口对象/颜色/标签）
    if (!sock) { for (let i = 0; i < old.length; i++) { if (!used.has(i)) { sock = old[i]; used.add(i); break; } } }
    if (!sock) { node.addOutput(w.name, w.type, {}); sock = node.outputs[node.outputs.length - 1]; changed = true; }
    if (applySockMeta(sock, w)) changed = true;
    seq.push(sock);
  });
  if (old.length !== seq.length || old.some((o, i) => seq[i] !== o)) changed = true;

  // 组装：seq 在前、未复用的旧口垫后（删尾不移位）。必须先把线写到目标口再删旧口，
  // 否则 removeOutput 会按旧下标把线一起断掉 —— 表现就是「换模式后要重新连线」。
  const surplus = old.filter((o) => !seq.includes(o));
  node.outputs.length = 0;
  seq.forEach((s) => node.outputs.push(s));
  surplus.forEach((s) => node.outputs.push(s));
  const byId = (id) => (node.graph && node.graph.getNodeById ? node.graph.getNodeById(id) : null) || (((node.graph && node.graph._nodes) || []).find((n) => n && String(n.id) === String(id)));
  let moved = false;
  outgoing.forEach((o) => {
    const L = gl[o.lid]; if (!L) return;
    const s = old[o.slot];
    if (!targetOf.has(o.slot)) {
      // 新布局里没有同类型的落点（比如视频槽位被关成 0）：断开这条线。
      // 不能把它原地留下 —— 旧下标现在可能已经是另一个类型的口，会错接上去。
      if (s && Array.isArray(s.links)) { const p = s.links.indexOf(o.lid); if (p >= 0) s.links.splice(p, 1); }
      const t = byId(L.target_id); const tin = t && t.inputs && t.inputs[L.target_slot];
      if (tin && String(tin.link) === String(o.lid)) tin.link = null;
      try { delete gl[o.lid]; } catch (_) {}
      try { const m = node.graph && node.graph._links; if (m && typeof m.delete === 'function') m.delete(o.lid); } catch (_) {}   // 新版 LiteGraph 用 _links(Map) 存链接
      moved = true;
      return;
    }
    const at = targetOf.get(o.slot);
    if (s && Array.isArray(s.links)) { const p = s.links.indexOf(o.lid); if (p >= 0) s.links.splice(p, 1); }
    // 新口（addOutput 建的）links 是 null：必须把 link id 记上，否则前端按 socket.links 画的线/后续 disconnect 都看不到它
    const to = node.outputs[at];
    if (to) { if (!Array.isArray(to.links)) to.links = []; if (to.links.indexOf(o.lid) < 0) to.links.push(o.lid); }
    if (Number(L.origin_slot) !== at) { try { L.origin_slot = at; } catch (_) {} moved = true; }
  });
  for (let i = node.outputs.length - 1; i >= seq.length; i--) node.removeOutput(i);
  if ((moved || changed) && node.graph) node.graph.setDirtyCanvas(true, true);
  if (changed) { syncOutputTypes(node); notifyOut(node); }   // 下游 MergeList/SplitList/TimeLine 跟着重算
  return changed;
}
function notifyOut(node) {
  const g = node.graph; if (!g || !g.links) return;
  (node.outputs || []).forEach((o) => {
    const ids = []; if (Array.isArray(o.links)) ids.push(...o.links); if (o.link != null) ids.push(o.link);
    ids.forEach((lid) => {
      const lk = g.links[lid]; if (!lk) return;
      const t = (g.getNodeById ? g.getNodeById(lk.target_id) : null) || ((g._nodes || []).find((n) => n && String(n.id) === String(lk.target_id)));
      if (!t) return;
      if (typeof t._ezlpUpdate === 'function') { try { t._ezlpUpdate(); } catch (_) {} }
      else if (typeof t._ezMediaOutUpdate === 'function') { try { t._ezMediaOutUpdate(); } catch (_) {} }
    });
  });
}
function syncOutputTypes(node) {
  // 上游/链路没就绪时会上报空 files → 后端把类 RETURN_TYPES 清空 → 保存的端口与连线全丢（刷新/重启断线的真凶）。
  const inp0 = (node.inputs || [])[0];
  if (inp0 && inp0.link != null && !mediaOutUpstreamReady(node, inp0)) return;
  const conn = connectedItems(node);
  const items = conn ? conn.items : [];
  const slots = fixedSlotsOf(node);
  // 只同步端口名/类型；本地禁用由运行期 config 交给节点，不用上报
  const body = { files: slots ? fixedWant(slots).map((w) => ({ id: w.id, name: w.name, type: w.back }))
                              : items.map((it, i) => ({ id: it.id != null ? it.id : ('f' + i), name: it.name || ezT('File'), type: it.mixed ? 'other' : fileKind(it) })) };
  try { const f = (api && typeof api.fetchApi === 'function') ? (p, o) => api.fetchApi(p, o) : (p, o) => fetch(p, o); f(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); } catch (_) {}
}

function renderPanel(node, conn) {
  const root = node._emooRoot; if (!root) return;
  const panelRoot = root.querySelector('.emoo-root') || root;
  const slots = fixedSlotsOf(node);
  const files = slots ? fixedWant(slots).map((w) => ({ id: w.id, name: w.name, type: w.back })) : (conn ? conn.items : []);   // 循环模式下列槽位（没有逐文件元数据）
  // 内容没变就不重建：settle 定时器每 250ms 会摸一次面板，重建会把「按下还没松手」的那次点击吃掉
  // （现象：开/关 要点两下、或者先点一下面板才点得动）。签名覆盖翻页/文件/开关状态。
  const sig = ['split', node._moPage, node._moPerPage,
    files.map((f) => ((f && f.id) + ':' + ((f && f.name) || ''))).join(','),
    files.map((f) => ((node._ezLocalOff && node._ezLocalOff[f.id]) ? '1' : '0')).join('')].join('|');
  if (node._moSig === sig) return;
  node._moSig = sig;
  const list = root.querySelector('.emoo-list'); if (!list) return; list.innerHTML = '';
  const status = root.querySelector('.emoo-status');
  if (!conn || !files.length) {
    status.textContent = conn ? ezT('0 files') : ezT('No card connected'); status.className = 'emoo-status';
    const e = el('div', 'emoo-empty'); e.textContent = conn ? ezT('This card group has no files') : ezT('Connect an EzFlex-MediaLoader card group output first'); list.appendChild(e);
    return;
  }
  const nOut = files.length;
  status.textContent = ezT('Total') + ' ' + nOut + ezT(' items'); status.className = 'emoo-status on';
  node._moPerPage = Math.max(1, parseInt(node._moPerPage, 10) || 10);
  node._moPage = Math.max(1, parseInt(node._moPage, 10) || 1);
  const total = files.length;
  const totalPages = Math.max(1, Math.ceil(total / node._moPerPage));
  if (node._moPage > totalPages) node._moPage = totalPages;
  const start = (node._moPage - 1) * node._moPerPage;
  const pageFiles = files.slice(start, start + node._moPerPage);
  pageFiles.forEach((f, idx) => {
    const off = !!(node._ezLocalOff && node._ezLocalOff[f.id]);
    const row = el('div', 'emoo-row' + (off ? ' emoo-off' : ''));
    const fkind = fileKind(f);
    const col = KIND_COLOR[fkind] || '#9aa7b5';
    const no = el('span', 'emoo-no'); no.textContent = String(start + idx + 1); row.appendChild(no);   // 序号与黑框标签一致（口序号）
    const sq = el('span', 'emoo-sq'); sq.innerHTML = iconFor(fkind); row.appendChild(sq);
    const nm = el('span', 'emoo-name'); nm.textContent = (f.name || (ezT('File ') + (start + idx + 1))); row.appendChild(nm);
    const type = el('span', 'emoo-type'); type.textContent = fkind; row.appendChild(type);
    const toggle = el('div', 'emoo-toggle');
    const on = el('button'); on.className = 'on' + (!off ? ' active' : ''); on.textContent = ezT('Enabled');
    const offb = el('button'); offb.className = 'off' + (off ? ' active' : ''); offb.textContent = ezT('Disabled');
    const set = (enabled) => { node._ezLocalOff = node._ezLocalOff || {}; node._ezLocalOff[f.id] = !enabled; node._moSig = ''; writeLocalOff(node); renderPanel(node, conn); updatePorts(node, true); };
    on.addEventListener('click', () => set(true)); offb.addEventListener('click', () => set(false));
    toggle.appendChild(on); toggle.appendChild(offb); row.appendChild(toggle);
    list.appendChild(row);
  });
  // 翻页栏：左=页码列表，右=第[x]页 + [x]个/页（固定宽度）
  let pg = panelRoot.querySelector('.emoo-page');
  if (!pg) { pg = el('div', 'emoo-page'); panelRoot.appendChild(pg); }
  pg.innerHTML = '';
  const pl = el('div', 'emoo-page-l');
  const prev = el('button'); prev.textContent = '<'; prev.disabled = node._moPage <= 1; prev.addEventListener('click', () => { if (node._moPage > 1) { node._moPage--; renderPanel(node, conn); } }); pl.appendChild(prev);
  const range = pageRange(node._moPage, totalPages);
  range.forEach((p) => { if (p === '...') { const d = el('span'); d.textContent = '…'; pl.appendChild(d); return; } const b = el('button'); b.textContent = String(p); if (p === node._moPage) b.className = 'active'; b.addEventListener('click', () => { node._moPage = p; renderPanel(node, conn); }); pl.appendChild(b); });
  const next = el('button'); next.textContent = '>'; next.disabled = node._moPage >= totalPages; next.addEventListener('click', () => { if (node._moPage < totalPages) { node._moPage++; renderPanel(node, conn); } }); pl.appendChild(next);
  pg.appendChild(pl);
  const pr = el('div', 'emoo-page-r');
  const lbl = (t) => { const s = el('span'); s.textContent = t; return s; };
  pr.appendChild(lbl(ezT('Page ')));
  const pageInput = el('input'); pageInput.type = 'number'; pageInput.min = '1'; pageInput.max = totalPages; pageInput.value = String(node._moPage); pageInput.addEventListener('blur', () => { const v = parseInt(pageInput.value, 10); node._moPage = Math.min(totalPages, Math.max(1, isNaN(v) ? 1 : v)); renderPanel(node, conn); }); pr.appendChild(pageInput);
  pr.appendChild(lbl(ezT(' · ')));
  const perInput = el('input'); perInput.type = 'number'; perInput.min = '1'; perInput.value = String(node._moPerPage); perInput.title = ezT('Items per page'); perInput.addEventListener('blur', () => { node._moPerPage = Math.max(1, parseInt(perInput.value, 10) || 10); node._moPage = 1; renderPanel(node, conn); }); pr.appendChild(perInput);
  pr.appendChild(lbl(ezT(' per page')));
  pg.appendChild(pr);
}
function forceShell(node) {
  const p = node && node._emooRoot; if (!p || !p.isConnected) return;
  const si = (t, prop, val) => { try { t.style.setProperty(prop, val, 'important'); } catch (_) {} };
  si(p, 'width', '100%'); si(p, 'max-width', '100%'); si(p, 'height', '100%'); si(p, 'max-height', '100%'); si(p, 'box-sizing', 'border-box');
  if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) { si(p, 'top', 'var(--ezfx-vue-title,30px)'); si(p, 'height', 'calc(100% - var(--ezfx-vue-title,30px))'); si(p, 'bottom', 'auto'); }
}
function installOutsideLabels(node) {
  if (!node || node._emooOutLabels) return;
  node._emooOutLabels = true;
  let all = []; let sig = '';
  const mk = (html, text) => { const l = el('div', 'emoo-socket-label'); if (html) l.innerHTML = html; else l.textContent = text || ''; l.style.display = 'none'; document.body.appendChild(l); return l; };
  const scan = () => {
    const cur = (node.outputs || []).map((s, i) => ({ i, name: s._ezLabel || s.name || '', html: s._ezLabelHtml || '', type: s.type })).filter((x) => x.type !== 'EZFLEX_PARAM_GROUP');
    const s = cur.map((x) => x.i + '|' + x.name).join(';');
    if (s !== sig) { sig = s; all.forEach((x) => { try { x.el.remove(); } catch (_) {} }); all = cur.map((x) => ({ el: mk(x.html, x.name), i: x.i })); node._emooOutEls = all.map((x) => x.el); }
  };
  const hideAll = () => { all.forEach((item) => { try { item.el.style.display = 'none'; } catch (_) {} }); };
  const update = () => {
    if (!moLabelsOn()) { hideAll(); return; }
    const rootEl = node._emooRoot;
    if (!rootEl || !rootEl.isConnected) { hideAll(); return; }   // 控件没挂上/被临时摘掉：先把标签收掉，别留在屏幕上
    // 只在「当前渲染的那张图」里显示：子图（app.canvas.graph）也算当前图，别拿 app.graph 比
    const shown = (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
    if (shown && node.graph && node.graph !== shown) { hideAll(); return; }
    let rect = null; try { rect = rootEl.getBoundingClientRect(); } catch (_) { hideAll(); return; }
    if (!rect || rect.width <= 0) { hideAll(); return; }
    const nodeW0 = (node.size && node.size[0]) || 1; const sx0 = rect.width / nodeW0;
    if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight || sx0 < 0.35) { all.forEach((item) => { item.el.style.display = 'none'; }); return; }
    scan();
    const sy = sx0;   // 纵向也按画布缩放（=节点宽度比）：别用 rect.height/nodeH，节点拉高后 rect 高不跟着长会把黑框间距压扁
    all.forEach((item) => {
      let pos = null; try { pos = node.getOutputPos(item.i); } catch (_) { pos = null; }
      if (!pos || !pos.length) { item.el.style.display = 'none'; return; }
      const nodeW = (node.size && node.size[0]) || 1; const sx = rect.width / nodeW; const np = node.pos || [0, 0];
      const cx = rect.left + ((pos[0] || 0) - (np[0] || 0)) * sx; const cy = rect.top + ((pos[1] || 0) - (np[1] || 0)) * sy;
      item.el.style.display = 'inline-flex'; item.el.style.zIndex = '20';
      const zoom = Math.max(0.5, sx); item.el.style.fontSize = Math.max(8, 9 * zoom) + 'px'; item.el.style.padding = (3 * zoom) + 'px ' + (7 * zoom) + 'px';
      const tw = item.el.offsetWidth; const th = item.el.offsetHeight || 16; const offX = 10 * zoom;
      item.el.style.left = (cx + offX) + 'px'; item.el.style.top = (cy - th / 2) + 'px';
    });
  };
  // 不再每帧自递归：画布重绘（onDrawForeground）+ resize/滚动 触发，一帧最多一次；静止时零开销
  const schedule = () => pumpFrames();
  {
    const prevDraw = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
        if (prevDraw) prevDraw.call(this, ctx);
        // 与画布同帧同步更新（不再经过 rAF，避免比画布慢一拍出现「流体感」）；
        // 不再额外 pumpFrames()：setDirty/指针/滚轮/resize 已在 pump，否则同一帧 update 跑两遍
        update();
      };
    scheduleOnRedraw(update);
    onLocaleChange(() => { node._moSig = ''; update(); });   // 语言切换：清内容签名强制重画
    schedule();
  }
}
function hideConfigWidget(node) {
  try { const ins = node.inputs || []; for (let i = ins.length - 1; i >= 0; i--) { if (ins[i] && ins[i].name === 'config') { try { node.inputs.splice(i, 1); } catch (_) { try { ins[i].hidden = true; } catch (_) {} } } } } catch (_) {}
  const w = configWidgetOf(node); if (!w || node._emooCfgHid) return;
  node._emooCfgHid = true;
  try { w.origComputeSize = w.computeSize; w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0; w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true; w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0; if (w.element && w.element.style) { w.element.style.display = 'none'; w.element.style.height = '0'; w.element.style.minHeight = '0'; w.element.style.maxHeight = '0'; } } catch (_) {}
}

function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'emoo-shell');
  const root = el('div', 'emoo-root');
  shell.appendChild(root);
  root.innerHTML = '<div class="emoo-hd"><span class="emoo-title">' + ezT('Media Out') + '</span><span class="emoo-status">' + ezT('Not connected') + '</span></div>' +
    '<div class="emoo-list"></div>';
  // 端口信息行：显示/隐藏文件名黑框标签的开关（绿=显示、灰=隐藏）
  const hd = root.querySelector('.emoo-hd');
  const lblBtn = el('button', 'emoo-lblbtn'); lblBtn.type = 'button';
  const syncLbl = () => {
    const on = moLabelsOn();
    lblBtn.classList.toggle('on', on); lblBtn.classList.toggle('off', !on);
    lblBtn.innerHTML = MO_LABEL_ICON + '<span>' + ezT('Labels') + '</span>';
    lblBtn.title = on ? ezT('Hide port labels') : ezT('Show port labels');
  };
  lblBtn.addEventListener('click', (e) => { e.stopPropagation(); moLabelsSet(!moLabelsOn()); });
  onLocaleChange(syncLbl);
  syncLbl();
  if (hd) hd.appendChild(lblBtn);
  return shell;
}
function fitNode(node) {
  try { const root = node && node._emooRoot && node._emooRoot.querySelector('.emoo-root'); if (!root || typeof node.setSize !== 'function') return; const cur = node.size || [460, 140]; const contentH = root.scrollHeight + 12; if (contentH > cur[1] + 4) node.setSize([Math.max(460, cur[0]), Math.min(760, contentH)]); } catch (_) {}
}
function setupNode(node) {
  if (!node || node._emooSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') return;
    node._emooSetup = true;
    node._ezMediaOutUpdate = () => { node._ezMoFresh = false; try { updatePorts(node, true); renderPanel(node, connectedItems(node)); } catch (_) {} };   // MediaLoader 内容变了会回调这里（这里才允许按新布局重排）
    node._ezLocalOff = readLocalOff(node);
    const root = buildRoot(node);
    node._emooRoot = root;
    makeDomWidgetHitThrough(root);
    const widget = node.addDOMWidget(ezT('Media Out'), nextWidgetType(), root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 140, getValue: () => '{}', setValue: () => {} });
    makeDomWidgetHitThrough(widget.element || root);
    try { node.widgets_start_y = 0; } catch (_) {}
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
    installResizeHandles(node, root);
    try { node.setSize([460, 200]); } catch (_) {}
    hideConfigWidget(node);
    updatePorts(node, true); syncOutputTypes(node);
    renderPanel(node, connectedItems(node));
    installOutsideLabels(node);
    forceShell(node);
    let settleN = 0;   // setInterval 返回的是数字 id，不能往上面挂属性（严格模式会抛 TypeError）
    const settle = setInterval(() => { forceShell(node); const a = updatePorts(node, true); renderPanel(node, connectedItems(node)); installOutsideLabels(node); if (!a) { settleN += 1; if (settleN >= 4) clearInterval(settle); } }, 250);
    node._ezSettleIv = settle;   // 节点被删时 onRemoved 要能停掉它
    let retry = 0; (function again() { forceShell(node); installOutsideLabels(node); if (retry < 12) { retry += 1; setTimeout(again, 120); } })();
    setTimeout(() => { try { updatePorts(node, true); syncOutputTypes(node); renderPanel(node, connectedItems(node)); fitNode(node); } catch (_) {} }, 400);
  } catch (e) { console.error('[MediaOut] init failed', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__emooHooked) return; nt.__emooHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevConn = nt.prototype.onConnectionsChange; nt.prototype.onConnectionsChange = function (type, index, connected, link_info) {
    const r = prevConn ? prevConn.apply(this, arguments) : undefined;
    try { if (this._emooSetup) setTimeout(() => { updatePorts(this, true); syncOutputTypes(this); renderPanel(this, connectedItems(this)); }, 0); } catch (_) {}
    return r;
  };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; try { (this._emooOutEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); this._emooOutEls = []; } catch (_) {} try { clearInterval(this._ezSettleIv); } catch (_) {} try { if (this._emooRoot) this._emooRoot.remove(); } catch (_) {} this._emooSetup = false; return r; };
}
// ===== 运行期空传：排队提交前，把「已禁用但仍连着」的端口从 prompt 里摘掉（不改画布） =====
// 服务器拿到的 prompt 里那条输入**根本不存在** → 下游按「没提供」走：
//   可选输入 → 用它自己的默认值；必需输入 → ComfyUI 校验直接拦下并指名报错（Required input is missing）。
// 画布 / 连线 / 保存的工作流一律不动：不拔线、不闪、不需要恢复；只影响这一次提交。
export function moPruneDisabledInputs(output) {
  if (!output || typeof output !== 'object') return [];
  const offById = {};
  Object.keys(output).forEach((id) => {
    const pn = output[id]; if (!pn || pn.class_type !== 'EzFlex-MediaOut') return;
    let cfg = {}; try { cfg = JSON.parse((pn.inputs && pn.inputs.config) || '{}') || {}; } catch (_) { cfg = {}; }
    const off = Array.isArray(cfg.off) ? cfg.off.map(String) : [];
    if (off.length) offById[String(id)] = new Set(off);
  });
  if (!Object.keys(offById).length) return [];
  const g = app && app.graph;
  const nodeById = (id) => findNodeById(id) || (((g && (g._nodes || g.nodes)) || []).find((x) => x && String(x.id) === String(id))) || null;
  const cut = [];   // 先算完再删：分析中途出错就不会留下"删一半"的 prompt
  Object.keys(output).forEach((id) => {
    const pn = output[id]; const ins = pn && pn.inputs; if (!ins) return;
    Object.keys(ins).forEach((k) => {
      const v = ins[k];
      if (!Array.isArray(v) || v.length < 2 || Array.isArray(v[0])) return;   // 只认 [上游节点 id, 槽位] 这种连线
      const off = offById[String(v[0])]; if (!off) return;
      const slot = parseInt(v[1], 10); if (!isFinite(slot)) return;
      const node = nodeById(v[0]);
      const sock = node && node.outputs && node.outputs[slot];
      const files = (sock && sock._ezFiles) || [];   // 面板盖的章：这个端口承载哪些文件
      if (!files.length || !files.every((f) => f && off.has(String(f.id)))) return;   // 没盖章 / 不是全禁用 → 不动
      cut.push({ node: pn, key: k, title: ((pn._meta && pn._meta.title) || pn.class_type || ('#' + id)) });
    });
  });
  cut.forEach((c) => { delete c.node.inputs[c.key]; });
  return cut.map((c) => c.title + ' - ' + c.key);
}
function installQueuePrune() {
  if (!api || api.__ezMoPruneHooked || typeof api.queuePrompt !== 'function') return;
  api.__ezMoPruneHooked = true;
  const prev = api.queuePrompt;
  api.queuePrompt = async function (number, prompt, extra) {
    let cut = [];
    try { cut = moPruneDisabledInputs(prompt && prompt.output); } catch (e) { console.warn('[MediaOut] failed to prune disabled port inputs (submitting as-is):', e); }
    if (cut.length) console.log('[MediaOut] submitting ' + cut.length + ' disabled port input(s) as disconnected: ' + cut.join(', '));
    return prev.apply(this, arguments);
  };
}
installQueuePrune();
app.registerExtension({
  name: 'EzFlex.MediaOut',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) { n._ezMoFresh = true; setupNode(n); } },   // 建节点/重载建节点：这次重排先保守
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) { n._ezMoFresh = true; setupNode(n); } },   // 重载：这次重排先保守，别删保存的连线
  setup() {
    try { if (typeof LGraphCanvas !== 'undefined' && LGraphCanvas.link_type_colors) { Object.assign(LGraphCanvas.link_type_colors, { VIDEO: '#e0645c', AUDIO: '#34a853', MODEL_3D: '#b15bd6', FILE_3D: '#b15bd6', IMAGE: '#4a9eff', EZFLEX_MEDIA_CARD: CARD_COLOR }); } } catch (_) {}
    ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); });
  },
});