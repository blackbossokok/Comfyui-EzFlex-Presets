// EzFlex-MediaOut 素材输出（内嵌 addDOMWidget 面板）。
// 输入 = 一个「素材卡片」端口（EzFlex-MediaLoader 的深红 * 输出）；
// 输出 = 该卡片内每个文件一个端口，类型按文件真实媒体类型（IMAGE/VIDEO/AUDIO/MODEL_3D）。
// 单文件卡片 = 1 个输出；多文件（批量）卡片 = N 个输出。局部禁用某文件时保留端口、输出 None。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { NODE_TYPES, nodeTypeOf, findNodeById, configWidget, installResizeHandles, makeDomWidgetHitThrough, TYPE_ICONS, notifyConfigChanged, scheduleOnRedraw, pumpFrames } from "./ezflex_service.js";
import { ezT, onLocaleChange } from "./ezflex_i18n.js";

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
.emoo-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:#1a1a2e;background:#fff;border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.emoo-root *{box-sizing:border-box;user-select:none;-webkit-user-select:none;}
.emoo-hd{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;}
.emoo-title{font-weight:550;font-size:13px;color:#0f141f;}
.emoo-mode{display:flex;background:#f1f4fa;border-radius:8px;padding:2px;border:1px solid #e2e8f0;flex:0 0 auto;}
.emoo-mode button{background:transparent;border:none;padding:2px 10px;font-size:11px;font-weight:470;color:#4d5b6d;font-family:inherit;cursor:pointer;border-radius:6px;transition:all .1s;height:24px;line-height:1;}
.emoo-mode button.active{background:#fff;color:#0f141f;box-shadow:0 1px 4px rgba(0,0,0,.06);font-weight:510;}
.emoo-status{font-size:10px;color:#8a99ae;white-space:nowrap;}
.emoo-status.on{color:#065f46;font-weight:500;}
.emoo-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;}
.emoo-page{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:0 0 auto;padding-top:4px;border-top:1px solid #eef1f6;font-size:12px;color:#5f6b7a;justify-content:space-between;}
.emoo-page-l,.emoo-page-r{display:flex;align-items:center;gap:4px;flex:0 0 auto;}
.emoo-page-r input{width:52px;}
.emoo-page button{background:#fff;border:1px solid #dce3ec;border-radius:6px;min-width:24px;height:24px;font-size:12px;cursor:pointer;color:#334155;padding:0 6px;font-family:inherit;}
.emoo-page button:disabled{opacity:.4;cursor:default;}
.emoo-page button.active{background:#2b3a4a;border-color:#2b3a4a;color:#fff;}
.emoo-page input{width:46px;height:24px;border:1px solid #dce3ec;border-radius:6px;font-size:12px;text-align:center;outline:none;font-family:inherit;}
.emoo-root input[type=number]{-moz-appearance:textfield;appearance:textfield;}
.emoo-root input[type=number]::-webkit-inner-spin-button,.emoo-root input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
.emoo-row{display:flex;align-items:center;gap:8px;background:#fbfcfe;border:1px solid #f0f4fc;border-radius:10px;padding:6px 8px;flex-wrap:wrap;}
.emoo-sq{width:22px;height:22px;border-radius:6px;flex:0 0 auto;background:#f3f5f9;border:1px solid #eef1f6;display:flex;align-items:center;justify-content:center;color:#4d5b6d;}
.emoo-name{font-size:12px;font-weight:480;flex:1 1 90px;min-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1a1f2b;}
.emoo-type{font-size:10px;color:#5f6b7a;background:#eef2f7;padding:0 10px;border-radius:100px;line-height:20px;}
.emoo-toggle{display:flex;background:#f1f4fa;border-radius:8px;padding:2px;border:1px solid #e2e8f0;flex:0 0 auto;}
.emoo-toggle button{background:transparent;border:none;padding:2px 10px;font-size:11px;font-weight:470;color:#4d5b6d;font-family:inherit;cursor:pointer;border-radius:6px;transition:all .1s;height:24px;line-height:1;}
.emoo-toggle button.active{background:#fff;color:#0f141f;box-shadow:0 1px 4px rgba(0,0,0,.06);font-weight:510;}
.emoo-toggle button.on.active{background:#ecfdf3;color:#065f46;border:1px solid #a7f0c6;}
.emoo-toggle button.off.active{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;}
.emoo-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:14px;}
.emoo-fitbar{display:flex;gap:6px;flex:0 0 auto;}
.emoo-fitbar .emoo-fit-btn{height:24px;font-size:11px;padding:0 10px;}
.emoo-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100070;background:rgba(0,0,0,.35);font-family:Inter,sans-serif;}
.emoo-modal.active{display:flex;}
.emoo-modal-box{background:#fff;border-radius:14px;width:420px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.24);box-sizing:border-box;}
.emoo-modal-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #edf2f8;}
.emoo-modal-hd b{font-size:14px;color:#0f141f;}
.emoo-modal-close{border:none;background:transparent;color:#94a3b8;font-size:16px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;font-family:inherit;}
.emoo-modal-close:hover{background:#f1f4fa;color:#334155;}
.emoo-modal-body{padding:12px 16px;display:flex;flex-direction:column;gap:10px;overflow:auto;}
.emoo-setf{display:flex;flex-direction:column;gap:4px;font-size:11px;color:#5f6b7a;}
.emoo-setf > span{font-weight:500;}
.emoo-setrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.emoo-sethint{font-size:10px;color:#8a99ae;line-height:1.6;}
.emoo-setx{color:#8a99ae;}
.emoo-btn{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:#1f2937;font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;line-height:1;}
.emoo-btn:hover{background:#edf2fa;}
.emoo-btn.primary{background:#1a1a2e;border-color:#1a1a2e;color:#fff;}
.emoo-btn.primary:hover{background:#2b3a4a;}
.emoo-modal select,.emoo-modal input{height:26px;border:1px solid #dce3ec;border-radius:7px;font-size:11px;font-family:inherit;color:#334155;background:#fff;outline:none;padding:0 6px;}
.emoo-modal input[type=number]{width:76px;text-align:center;}
.emoo-modal input:disabled{background:#f3f5f9;color:#a8b3c2;}
.emoo-modal-ft{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid #edf2f8;}
.emoo-socket-label{position:fixed;z-index:20;pointer-events:none;background:rgba(26,36,48,0.5);color:#e8e8f0;font-size:9px;line-height:1;padding:2px 6px;border-radius:3px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;user-select:none;display:inline-flex;align-items:center;}
`;

let _styleInjected = false;
let _widgetSeq = 0;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function nextWidgetType() { _widgetSeq += 1; return 'emoo-config__' + _widgetSeq.toString(36); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
function configWidgetOf(node) { return configWidget(node); }

// ===== config / 本地禁用 + 输出模式 + 图片合并对齐 =====
function readLocalOff(node) {
  const w = configWidgetOf(node); if (!w) return {};
  node._ezMode = 'split';
  node._ezFit = { size: 'first', fit: 'crop' };
  try {
    const cfg = JSON.parse(w.value || '{}') || {};
    node._ezMode = ['card', 'row', 'group'].includes(cfg.mode) ? cfg.mode : 'split';
    const f = cfg.fit;
    if (f && typeof f === 'object') {
      if (typeof f.size === 'string' && f.size) node._ezFit.size = f.size;
      if (['crop', 'pad', 'stretch'].includes(f.fit)) node._ezFit.fit = f.fit;
    }
    const off = Array.isArray(cfg.off) ? cfg.off : []; const m = {};
    off.forEach((id) => { m[id] = true; });
    return m;
  } catch (_) { return {}; }
}
function writeLocalOff(node) {
  const w = configWidgetOf(node); if (!w) return;
  const off = []; const map = node._ezLocalOff || {};
  Object.keys(map).forEach((k) => { if (map[k]) off.push(k); });
  w.value = JSON.stringify({ mode: node._ezMode || 'split', off, fit: node._ezFit || { size: 'first', fit: 'crop' } });
  if (typeof w.callback === 'function') w.callback(w.value);
  if (node.graph) node.graph.setDirtyCanvas(true, true);
  notifyConfigChanged(node);
}
function str(s) { return (s === undefined || s === null) ? '' : String(s); }

// ===== 读取所连卡片（MediaLoader 输出）=====
function connectedCard(node) {
  const inp = (node.inputs || [])[0];
  if (!inp || inp.link == null) return null;
  const graph = node.graph;
  const link = graph && graph.links && graph.links[inp.link];
  if (!link) return null;
  const origin = findNodeById(link.origin_id) || (graph && graph._nodes ? graph._nodes.find((n) => n && String(n.id) === String(link.origin_id)) : null);
  if (!origin || nodeTypeOf(origin) !== NODE_TYPES.MEDIA_LOADER) return null;
  const slot = link.origin_slot;
  const sock = (origin.outputs || [])[slot];
  let cardId = sock && sock._ezCardId;
  let cfg = {};
  try { const w = configWidgetOf(origin); cfg = JSON.parse(w ? (w.value || '{}') : '{}') || {}; } catch (_) { cfg = {}; }
  if (cardId == null) { const order = []; (cfg.groups || []).forEach((g) => (g.cards || []).forEach((c) => order.push(c))); const c = order[slot]; if (c) cardId = c.id; }
  let card = null;
  (cfg.groups || []).forEach((g) => (g.cards || []).forEach((c) => { if (String(c.id) === String(cardId)) card = c; }));
  if (!card) return null;
  const files = [];
  (card.items || []).forEach((it) => (it.files || []).forEach((f) => files.push(f)));
  return { origin, cardId, card, files };
}
// 读取所连 MediaLoader 的完整配置（供 card/row/group 模式按整张结构归组）
function connectedLoader(node) {
  const inp = (node.inputs || [])[0];
  if (!inp || inp.link == null) return null;
  const graph = node.graph;
  const link = graph && graph.links && graph.links[inp.link];
  if (!link) return null;
  const origin = findNodeById(link.origin_id) || (graph && graph._nodes ? graph._nodes.find((n) => n && String(n.id) === String(link.origin_id)) : null);
  if (!origin || nodeTypeOf(origin) !== NODE_TYPES.MEDIA_LOADER) return null;
  let cfg = {};
  try { const w = configWidgetOf(origin); cfg = JSON.parse(w ? (w.value || '{}') : '{}') || {}; } catch (_) { cfg = {}; }
  return { origin, cfg };
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
function structRows(cfg) {
  const rows = [];
  (cfg.groups || []).forEach((grp) => { const gname = (grp.name || '').trim() || ezT('Group'); (grp.cards || []).forEach((c) => { const items = []; (c.items || []).forEach((it) => { const files = []; (it.files || []).forEach((f) => files.push(Object.assign({}, f, { name: f.name || '', type: fileKind(f) }))); items.push({ id: it.id, files }); }); const cname = (c.name || '').trim() || ezT('Card group'); rows.push({ group: gname, cardId: c.id, label: gname + '_' + cname, items }); }); });
  return rows;
}
// 分组的端口类型：同一类型就用该类型（多张图=IMAGE 批量张量、多段音频=AUDIO 拼接），混用才退化成 '*'
// 后端 _mo_one / _mo_merge_values 是同一套规则，两边必须一致。
function oneGroup(files, name) {
  const kinds = new Set((files || []).map((f) => fileKind(f)));
  const k = kinds.size === 1 ? Array.from(kinds)[0] : '';
  const type = k ? (TYPE_MAP[k] || 'STRING') : '*';
  const label = (name || ezT('Media')) + (files.length > 1 ? ' ×' + files.length : '');
  return { name: label, type, kind: k, files };
}
function moGroupings(mode, rows, off) {
  const offset = new Set(off || []); const keep = (f) => f && !offset.has(String(f.id)); const out = [];
  if (mode === 'card') { rows.forEach((row) => row.items.forEach((it) => { const files = (it.files || []).filter(keep); if (files.length) out.push(oneGroup(files, files[0].name || ezT('Media'))); })); }
  else if (mode === 'row') { rows.forEach((row) => { let files = []; row.items.forEach((it) => { files = files.concat((it.files || []).filter(keep)); }); if (files.length) out.push(oneGroup(files, row.label || ezT('Card group'))); }); }
  else if (mode === 'group') { const byg = {}, order = []; rows.forEach((row) => { const g = row.group || ezT('Group'); if (!(g in byg)) { byg[g] = []; order.push(g); } byg[g].push(row); }); order.forEach((g) => { let files = []; byg[g].forEach((row) => row.items.forEach((it) => { files = files.concat((it.files || []).filter(keep)); })); if (files.length) out.push(oneGroup(files, g)); }); }
  return out;
}

// 卡片输入口上色（专属类型 EZFLEX_MEDIA_CARD 没有内置默认色，按文档保持深红）
function paintCardSocket(node) {
  try {
    const inp = (node.inputs || [])[0];
    if (inp) { inp.color_on = CARD_COLOR; inp.color_off = CARD_COLOR; inp.color = CARD_COLOR; }
  } catch (_) {}
}
function updatePorts(node, noRedraw) {
  if (!node || !node.outputs) return false;
  paintCardSocket(node);
  const conn = connectedCard(node);
  const off = node._ezLocalOff || {};
  const mode = node._ezMode || 'split';
  let want;
  if (mode === 'split') {
    const files = conn ? conn.files : [];
    want = files.map((f) => { const k = fileKind(f); return { id: f.id, name: f.name || ezT('File'), type: TYPE_MAP[k] || 'STRING', kind: k, files: [f] }; });
  } else {
    const loader = connectedLoader(node);
    const rows = loader ? structRows(loader.cfg) : [];
    const offIds = Object.keys(off).filter((k) => off[k]);
    const gs = moGroupings(mode, rows, offIds);
    want = gs.map((g, i) => ({ id: 'g' + i, name: g.name, type: g.type, kind: g.kind, files: g.files }));
  }
  let changed = false;
  const old = (node.outputs || []).slice();
  const used = new Set(); const seq = [];
  want.forEach((w) => {
    let sock = null;
    for (let i = 0; i < old.length; i++) { if (!used.has(i) && old[i]._ezMediaId != null && String(old[i]._ezMediaId) === String(w.id)) { sock = old[i]; used.add(i); break; } }
    if (!sock) { for (let i = 0; i < old.length; i++) { if (!used.has(i)) { sock = old[i]; used.add(i); break; } } }
    if (!sock) { node.addOutput(w.name, w.type, {}); sock = node.outputs[node.outputs.length - 1]; changed = true; }
    if (sock._ezMediaId !== w.id) { sock._ezMediaId = w.id; changed = true; }
    if (sock.name !== w.name) { sock.name = w.name; changed = true; }
    if (String(sock.type) !== w.type) { try { sock.type = w.type; } catch (_) {} changed = true; }
    try { sock.label = ''; sock.hideName = true; sock.hidden = false; sock._ezLabel = w.name; sock._ezFiles = w.files || []; } catch (_) {}
    const col = TYPE_COLOR[w.type] || KIND_COLOR[w.kind];
    if (col) { if (sock.color_on !== col || sock.color !== col) { sock.color_on = col; sock.color_off = col; sock.color = col; changed = true; } }
    seq.push(sock);
  });
  old.forEach((o, i) => { if (!used.has(i)) { const idx = node.outputs.indexOf(o); if (idx >= 0) { node.removeOutput(idx); changed = true; } } });
  if (node.outputs.length !== seq.length || node.outputs.some((o, i) => o !== seq[i])) { for (let i = 0; i < seq.length; i++) node.outputs[i] = seq[i]; node.outputs.length = seq.length; changed = true; }
  node.outputs.forEach((o, i) => {
    const ids = []; if (Array.isArray(o.links)) ids.push(...o.links); if (o.link != null) ids.push(o.link);
    ids.forEach((lid) => { if (lid != null && node.graph && node.graph.links && node.graph.links[lid]) { try { node.graph.links[lid].origin_slot = i; } catch (_) {} } });
  });
  if (changed && node.graph) node.graph.setDirtyCanvas(true, true);
  if (changed) syncOutputTypes(node);
  return changed;
}
function syncOutputTypes(node) {
  const conn = connectedCard(node);
  const off = Object.keys(node._ezLocalOff || {}).filter((k) => node._ezLocalOff[k]);
  const mode = node._ezMode || 'split';
  const loader = connectedLoader(node);
  const body = { mode, off };
  if (mode === 'split') body.files = (conn ? conn.files : []).map((x) => ({ id: x.id, name: x.name || ezT('File'), type: fileKind(x) }));
  else body.groups = (loader && loader.cfg && loader.cfg.groups) || [];
  try { const f = (api && typeof api.fetchApi === 'function') ? (p, o) => api.fetchApi(p, o) : (p, o) => fetch(p, o); f(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); } catch (_) {}
}
// ===== 「批量设置」弹窗：多文件端口的合并方式（卡片/卡片组/分组模式）
// 选项对齐 KJNodes Load Images From Folder：目标尺寸（可直接填宽高）/ 适配方式 / 最多取几张 / 从第几张开始。
function fitSummary(node) {
  const f = node._ezFit || { size: 'first', fit: 'crop' };
  const sizeTxt = /^\d+x\d+$/i.test(String(f.size)) ? String(f.size) : ezT('First image');
  const fitTxt = { crop: ezT('Crop'), pad: ezT('Pad'), stretch: ezT('Stretch') }[f.fit] || ezT('Crop');
  const capTxt = Number(f.cap) > 0 ? (ezT('Take ') + f.cap + ezT(' items')) : ezT('Take all');
  return sizeTxt + '·' + fitTxt + '·' + capTxt;
}
function moField(host, label, node) {
  const l = el('label', 'emoo-setf'); const sp = el('span'); sp.textContent = label;
  l.appendChild(sp); l.appendChild(node); host.appendChild(l); return l;
}
function openFitSettings(node) {
  const m = el('div', 'emoo-modal');
  const box = el('div', 'emoo-modal-box');
  const hd = el('div', 'emoo-modal-hd'); const t = el('b'); t.textContent = ezT('Batch settings');
  const close = el('button', 'emoo-modal-close'); close.textContent = '✕';
  hd.appendChild(t); hd.appendChild(close);
  box.appendChild(hd);
  const body = el('div', 'emoo-modal-body');
  const f = Object.assign({ size: 'first', fit: 'crop', cap: 0, start: 0 }, node._ezFit || {});

  const sizeSel = el('select'); [['first', ezT('Follow the first image')], ['custom', ezT('Custom size')]].forEach(([v, tx]) => { const o = el('option'); o.value = v; o.textContent = tx; sizeSel.appendChild(o); });
  const isCustom0 = /^\d+x\d+$/i.test(String(f.size));
  sizeSel.value = isCustom0 ? 'custom' : 'first';
  const wIn = el('input'); wIn.type = 'number'; wIn.min = '16'; wIn.max = '8192';
  const hIn = el('input'); hIn.type = 'number'; hIn.min = '16'; hIn.max = '8192';
  const [cw0, ch0] = isCustom0 ? String(f.size).toLowerCase().split('x') : ['1024', '1024'];
  wIn.value = cw0; hIn.value = ch0;
  const sizeRow = el('div', 'emoo-setrow'); sizeRow.appendChild(sizeSel); sizeRow.appendChild(wIn);
  const x = el('span', 'emoo-setx'); x.textContent = '×'; sizeRow.appendChild(x); sizeRow.appendChild(hIn);
  const syncSize = () => { const on = sizeSel.value === 'custom'; wIn.disabled = !on; hIn.disabled = !on; };
  sizeSel.addEventListener('change', syncSize); syncSize();

  const fitSel = el('select');
  [['crop', ezT('Crop (center-crop the overflow, keep ratio)')], ['pad', ezT('Pad (fill with edge color, keep ratio)')], ['stretch', ezT('Stretch (ignore aspect ratio)')]].forEach(([v, tx]) => { const o = el('option'); o.value = v; o.textContent = tx; fitSel.appendChild(o); });
  fitSel.value = f.fit || 'crop';

  const capIn = el('input'); capIn.type = 'number'; capIn.min = '0'; capIn.max = '4096'; capIn.value = String(Number(f.cap) || 0);
  const startIn = el('input'); startIn.type = 'number'; startIn.min = '0'; startIn.max = '4096'; startIn.value = String(Number(f.start) || 0);

  moField(body, ezT('Target size'), sizeRow);
  moField(body, ezT('Fit mode'), fitSel);
  moField(body, ezT('Max items (0 = all)'), capIn);
  moField(body, ezT('Start index (0-based)'), startIn);
  const hint = el('div', 'emoo-sethint');
  hint.textContent = ezT('Only affects ports with multiple files (images) in Card / Card group / Group mode: first align sizes by the rules above, then merge into one IMAGE batch tensor; if only the size is set without changing the ratio, the fit mode is used.');
  body.appendChild(hint);
  box.appendChild(body);
  const ft = el('div', 'emoo-modal-ft');
  const cancel = el('button', 'emoo-btn'); cancel.textContent = ezT('Cancel');
  const save = el('button', 'emoo-btn primary'); save.textContent = ezT('Save');
  ft.appendChild(cancel); ft.appendChild(save);
  box.appendChild(ft);
  m.appendChild(box); document.body.appendChild(m);
  m.classList.add('active');
  const done = () => { try { m.remove(); } catch (_) {} };
  close.addEventListener('click', done); cancel.addEventListener('click', done);
  m.addEventListener('mousedown', (e) => { if (e.target === m) done(); });
  save.addEventListener('click', () => {
    const size = sizeSel.value === 'custom'
      ? (Math.max(16, parseInt(wIn.value, 10) || 1024) + 'x' + Math.max(16, parseInt(hIn.value, 10) || 1024))
      : 'first';
    node._ezFit = { size, fit: fitSel.value, cap: Math.max(0, parseInt(capIn.value, 10) || 0), start: Math.max(0, parseInt(startIn.value, 10) || 0) };
    writeLocalOff(node);
    renderMode(node);
    done();
  });
}

function renderMode(node) {
  const root = node && node._emooRoot; if (!root) return;
  const mode = node._ezMode || 'split';
  root.querySelectorAll('.emoo-mode button').forEach((b) => {
    const mm = b.dataset.m;
    b.className = mm === mode ? 'active' : '';
    if (!b._modeWired) { b._modeWired = true; b.addEventListener('click', () => { node._ezMode = mm; writeLocalOff(node); renderMode(node); renderPanel(node, connectedCard(node)); updatePorts(node, true); }); }
  });
  // 「批量设置」只在卡片/卡片组/分组模式下可用（拆分模式下一个端口只有一个文件）
  const btn = root.querySelector('.emoo-fit-btn');
  if (btn) {
    const on = mode !== 'split';
    btn.style.display = on ? '' : 'none';
    btn.textContent = ezT('Batch settings (') + fitSummary(node) + ezT(')');
    if (!btn._wired) { btn._wired = true; btn.addEventListener('click', (e) => { e.stopPropagation(); openFitSettings(node); }); }
  }
}
function renderPanel(node, conn) {
  const root = node._emooRoot; if (!root) return;
  const panelRoot = root.querySelector('.emoo-root') || root;
  renderMode(node);
  const files = conn ? conn.files : [];
  // 内容没变就不重建：settle 定时器每 250ms 会摸一次面板，重建会把「按下还没松手」的那次点击吃掉
  // （现象：开/关 要点两下、或者先点一下面板才点得动）。签名覆盖模式/翻页/文件/开关状态。
  const sig = [(node._ezMode || 'split'), node._moPage, node._moPerPage,
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
  const mode = node._ezMode || 'split';
  let nOut = files.length;
  if (mode !== 'split') {
    const loader = connectedLoader(node); const rows = loader ? structRows(loader.cfg) : [];
    nOut = moGroupings(mode, rows, Object.keys(node._ezLocalOff || {}).filter((k) => node._ezLocalOff[k])).length;
  }
  status.textContent = ezT('Output ') + nOut + ezT(' ports (') + ({ split: ezT('Split'), card: ezT('Card'), row: ezT('Card group'), group: ezT('Group') })[mode] + ezT(')'); status.className = 'emoo-status on';
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
    const sq = el('span', 'emoo-sq'); sq.innerHTML = TYPE_ICONS[fkind] || TYPE_ICONS.other; row.appendChild(sq);
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
function pageRange(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const set = new Set([1, total, cur - 1, cur, cur + 1]); const out = [];
  for (let i = 1; i <= total; i++) { if (set.has(i)) out.push(i); }
  const res = []; let last = 0;
  out.forEach((n) => { if (last && n - last > 1) res.push('...'); res.push(n); last = n; });
  return res;
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
  const mk = (text) => { const l = el('div', 'emoo-socket-label'); l.textContent = text || ''; l.style.display = 'none'; document.body.appendChild(l); return l; };
  const scan = () => {
    const cur = (node.outputs || []).map((s, i) => ({ i, name: s._ezLabel || s.name || '', type: s.type })).filter((x) => x.type !== 'EZFLEX_PARAM_GROUP');
    const s = cur.map((x) => x.i + '|' + x.name).join(';');
    if (s !== sig) { sig = s; all.forEach((x) => { try { x.el.remove(); } catch (_) {} }); all = cur.map((x) => ({ el: mk(x.name), i: x.i })); node._emooOutEls = all.map((x) => x.el); }
  };
  const update = () => {
    const rootEl = node._emooRoot;
    if (!rootEl || !rootEl.isConnected) { return; }
    if (app && app.graph && node.graph !== app.graph) { (node._emooOutEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); node._emooOutEls = []; return; }
    let rect = null; try { rect = rootEl.getBoundingClientRect(); } catch (_) { return; }
    if (!rect || rect.width <= 0) { return; }
    const nodeW0 = (node.size && node.size[0]) || 1; const sx0 = rect.width / nodeW0;
    if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight || sx0 < 0.35) { all.forEach((item) => { item.el.style.display = 'none'; }); return; }
    scan();
    const nodeH = (node.size && node.size[1]) || 1; const sy = rect.height / nodeH;
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
        // 与画布同帧同步更新（不再经过 rAF，避免比画布慢一拍出现「流体感」）
        update();
        pumpFrames();
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
  root.innerHTML = '<div class="emoo-hd"><span class="emoo-title">' + ezT('Media Out') + '</span><span class="emoo-mode"><button data-m="split">' + ezT('Split') + '</button><button data-m="card">' + ezT('Card') + '</button><button data-m="row">' + ezT('Card group') + '</button><button data-m="group">' + ezT('Group') + '</button></span><span class="emoo-status">' + ezT('Not connected') + '</span></div>' +
    '<div class="emoo-fitbar"><button class="emoo-btn emoo-fit-btn" style="display:none">' + ezT('Batch settings') + '</button></div>' +
    '<div class="emoo-list"></div>';
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
    renderPanel(node, connectedCard(node));
    installOutsideLabels(node);
    forceShell(node);
    const settle = setInterval(() => { forceShell(node); const a = updatePorts(node, true); renderPanel(node, connectedCard(node)); installOutsideLabels(node); if (!a) { settle._n = (settle._n || 0) + 1; if (settle._n >= 4) clearInterval(settle); } }, 250);
    let retry = 0; (function retry() { forceShell(node); installOutsideLabels(node); if (retry < 12) { retry += 1; setTimeout(retry, 120); } })();
    setTimeout(() => { try { updatePorts(node, true); syncOutputTypes(node); renderPanel(node, connectedCard(node)); fitNode(node); } catch (_) {} }, 400);
  } catch (e) { console.error('[MediaOut] init failed', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__emooHooked) return; nt.__emooHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevConn = nt.prototype.onConnectionsChange; nt.prototype.onConnectionsChange = function (type, index, connected, link_info) {
    const r = prevConn ? prevConn.apply(this, arguments) : undefined;
    try { if (this._emooSetup) setTimeout(() => { updatePorts(this, true); syncOutputTypes(this); renderPanel(this, connectedCard(this)); }, 0); } catch (_) {}
    return r;
  };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; try { (this._emooOutEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); this._emooOutEls = []; } catch (_) {} try { if (this._emooRoot) this._emooRoot.remove(); } catch (_) {} this._emooSetup = false; return r; };
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
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() {
    try { if (typeof LGraphCanvas !== 'undefined' && LGraphCanvas.link_type_colors) { Object.assign(LGraphCanvas.link_type_colors, { VIDEO: '#e0645c', AUDIO: '#34a853', MODEL_3D: '#b15bd6', FILE_3D: '#b15bd6', IMAGE: '#4a9eff', EZFLEX_MEDIA_CARD: CARD_COLOR }); } } catch (_) {}
    ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); });
  },
});
