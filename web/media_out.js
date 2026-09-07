// EzFlex-MediaOut 素材输出（内嵌 addDOMWidget 面板）。
// 输入 = 一个「素材卡片」端口（EzFlex-MediaLoader 的深红 * 输出）；
// 输出 = 该卡片内每个文件一个端口，类型按文件真实媒体类型（IMAGE/VIDEO/AUDIO/MODEL_3D）。
// 单文件卡片 = 1 个输出；多文件（批量）卡片 = N 个输出。局部禁用某文件时保留端口、输出 None。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { NODE_TYPES, nodeTypeOf, findNodeById, configWidget, installResizeHandles, makeDomWidgetHitThrough, TYPE_ICONS } from "./ezflex_service.js";

const NODE = NODE_TYPES.MEDIA_OUT;
const API = "/media_out/outputs";
const TYPE_MAP = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', model_3d: 'MODEL_3D', model: 'MODEL_3D', '3d': 'MODEL_3D', other: 'STRING', text: 'STRING' };
const TYPE_COLOR = { IMAGE: '#4a9eff', VIDEO: '#e0645c', AUDIO: '#34a853', MODEL_3D: '#b15bd6', STRING: '#9aa7b5' };

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
.emoo-socket-label{position:fixed;z-index:20;pointer-events:none;background:rgba(26,36,48,0.5);color:#e8e8f0;font-size:9px;line-height:1;padding:2px 6px;border-radius:3px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;user-select:none;display:inline-flex;align-items:center;}
`;

let _styleInjected = false;
let _widgetSeq = 0;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function nextWidgetType() { _widgetSeq += 1; return 'emoo-config__' + _widgetSeq.toString(36); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
function configWidgetOf(node) { return configWidget(node); }

// ===== config / 本地禁用 + 输出模式 =====
function readLocalOff(node) {
  const w = configWidgetOf(node); if (!w) return {};
  node._ezMode = 'split';
  try {
    const cfg = JSON.parse(w.value || '{}') || {};
    node._ezMode = ['card', 'row', 'group'].includes(cfg.mode) ? cfg.mode : 'split';
    const off = Array.isArray(cfg.off) ? cfg.off : []; const m = {};
    off.forEach((id) => { m[id] = true; });
    return m;
  } catch (_) { return {}; }
}
function writeLocalOff(node) {
  const w = configWidgetOf(node); if (!w) return;
  const off = []; const map = node._ezLocalOff || {};
  Object.keys(map).forEach((k) => { if (map[k]) off.push(k); });
  w.value = JSON.stringify({ mode: node._ezMode || 'split', off });
  if (typeof w.callback === 'function') w.callback(w.value);
  if (node.graph) node.graph.setDirtyCanvas(true, true);
}
function str(s) { return (s === undefined || s === null) ? '' : String(s); }
function enabledFiles(files, off) { return (files || []).filter((f) => !(off && off[f.id])); }

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
function structRows(cfg) {
  const rows = [];
  (cfg.groups || []).forEach((grp) => { const gname = (grp.name || '').trim() || '分组'; (grp.cards || []).forEach((c) => { const items = []; (c.items || []).forEach((it) => { const files = []; (it.files || []).forEach((f) => files.push({ id: f.id, name: f.name || '', type: f.type || kindOf(f.name) })); items.push({ id: it.id, files }); }); const cname = (c.name || '').trim() || '素材卡片组'; rows.push({ group: gname, cardId: c.id, label: gname + '_' + cname, items }); }); });
  return rows;
}
function oneGroup(files, name) {
  return { name: name || '素材', type: files.length === 1 ? (TYPE_MAP[(files[0].type || 'other').toLowerCase()] || 'STRING') : '*', files };
}
function moGroupings(mode, rows, off) {
  const offset = new Set(off || []); const keep = (f) => f && !offset.has(String(f.id)); const out = [];
  if (mode === 'card') { rows.forEach((row) => row.items.forEach((it) => { const files = (it.files || []).filter(keep); if (files.length) out.push(oneGroup(files, files[0].name || '素材')); })); }
  else if (mode === 'row') { rows.forEach((row) => { let files = []; row.items.forEach((it) => { files = files.concat((it.files || []).filter(keep)); }); if (files.length) out.push(oneGroup(files, row.label || '素材卡片组')); }); }
  else if (mode === 'group') { const byg = {}, order = []; rows.forEach((row) => { const g = row.group || '分组'; if (!(g in byg)) { byg[g] = []; order.push(g); } byg[g].push(row); }); order.forEach((g) => { let files = []; byg[g].forEach((row) => row.items.forEach((it) => { files = files.concat((it.files || []).filter(keep)); })); if (files.length) out.push(oneGroup(files, g)); }); }
  return out;
}

function updatePorts(node, noRedraw) {
  if (!node || !node.outputs) return false;
  const conn = connectedCard(node);
  const off = node._ezLocalOff || {};
  const mode = node._ezMode || 'split';
  let want;
  if (mode === 'split') {
    const files = conn ? conn.files : [];
    want = files.map((f) => ({ id: f.id, name: f.name || '文件', type: TYPE_MAP[(f.type || 'other').toLowerCase()] || 'STRING' }));
  } else {
    const loader = connectedLoader(node);
    const rows = loader ? structRows(loader.cfg) : [];
    const offIds = Object.keys(off).filter((k) => off[k]);
    const gs = moGroupings(mode, rows, offIds);
    want = gs.map((g, i) => ({ id: 'g' + i, name: g.name, type: g.type }));
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
    try { sock.label = ''; sock.hideName = true; sock.hidden = false; sock._ezLabel = w.name; } catch (_) {}
    const col = TYPE_COLOR[w.type];
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
  if (mode === 'split') body.files = (conn ? conn.files : []).map((x) => ({ id: x.id, name: x.name || '文件', type: x.type || 'other' }));
  else body.groups = (loader && loader.cfg && loader.cfg.groups) || [];
  try { const f = (api && typeof api.fetchApi === 'function') ? (p, o) => api.fetchApi(p, o) : (p, o) => fetch(p, o); f(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); } catch (_) {}
}
function renderMode(node) {
  const root = node && node._emooRoot; if (!root) return;
  const mode = node._ezMode || 'split';
  root.querySelectorAll('.emoo-mode button').forEach((b) => {
    const mm = b.dataset.m;
    b.className = mm === mode ? 'active' : '';
    if (!b._modeWired) { b._modeWired = true; b.addEventListener('click', () => { node._ezMode = mm; writeLocalOff(node); renderMode(node); renderPanel(node, connectedCard(node)); updatePorts(node, true); }); }
  });
}
function renderPanel(node, conn) {
  const root = node._emooRoot; if (!root) return;
  const panelRoot = root.querySelector('.emoo-root') || root;
  renderMode(node);
  const files = conn ? conn.files : [];
  const list = root.querySelector('.emoo-list'); if (!list) return; list.innerHTML = '';
  const status = root.querySelector('.emoo-status');
  if (!conn || !files.length) {
    status.textContent = conn ? '0 个文件' : '未连接素材卡片'; status.className = 'emoo-status';
    const e = el('div', 'emoo-empty'); e.textContent = conn ? '该素材卡片没有文件' : '请先连接 EzFlex-MediaLoader 的某个素材卡片输出端口'; list.appendChild(e);
    return;
  }
  const mode = node._ezMode || 'split';
  let nOut = files.length;
  if (mode !== 'split') {
    const loader = connectedLoader(node); const rows = loader ? structRows(loader.cfg) : [];
    nOut = moGroupings(mode, rows, Object.keys(node._ezLocalOff || {}).filter((k) => node._ezLocalOff[k])).length;
  }
  status.textContent = '输出 ' + nOut + ' 个端口（' + ({ split: '拆分', card: '卡片', row: '卡片组', group: '分组' })[mode] + '）'; status.className = 'emoo-status on';
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
    const col = TYPE_COLOR[TYPE_MAP[(f.type || 'other').toLowerCase()]] || '#9aa7b5';
    const sq = el('span', 'emoo-sq'); sq.innerHTML = TYPE_ICONS[(f.type || 'other').toLowerCase()] || TYPE_ICONS.other; row.appendChild(sq);
    const nm = el('span', 'emoo-name'); nm.textContent = (f.name || ('文件 ' + (start + idx + 1))) + (f.type ? ' · ' + f.type : ''); row.appendChild(nm);
    const type = el('span', 'emoo-type'); type.textContent = f.type || 'other'; row.appendChild(type);
    const toggle = el('div', 'emoo-toggle');
    const on = el('button'); on.className = 'on' + (!off ? ' active' : ''); on.textContent = '开';
    const offb = el('button'); offb.className = 'off' + (off ? ' active' : ''); offb.textContent = '关';
    const set = (enabled) => { node._ezLocalOff = node._ezLocalOff || {}; node._ezLocalOff[f.id] = !enabled; writeLocalOff(node); renderPanel(node, conn); updatePorts(node, true); };
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
  pr.appendChild(lbl('第 '));
  const pageInput = el('input'); pageInput.type = 'number'; pageInput.min = '1'; pageInput.max = totalPages; pageInput.value = String(node._moPage); pageInput.addEventListener('blur', () => { const v = parseInt(pageInput.value, 10); node._moPage = Math.min(totalPages, Math.max(1, isNaN(v) ? 1 : v)); renderPanel(node, conn); }); pr.appendChild(pageInput);
  pr.appendChild(lbl(' 页 · '));
  const perInput = el('input'); perInput.type = 'number'; perInput.min = '1'; perInput.value = String(node._moPerPage); perInput.title = '每页数量'; perInput.addEventListener('blur', () => { node._moPerPage = Math.max(1, parseInt(perInput.value, 10) || 10); node._moPage = 1; renderPanel(node, conn); }); pr.appendChild(perInput);
  pr.appendChild(lbl(' 个/页'));
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
    if (!rootEl || !rootEl.isConnected) { node._emooOutRaf = requestAnimationFrame(update); return; }
    if (app && app.graph && node.graph !== app.graph) { (node._emooOutEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); node._emooOutEls = []; return; }
    let rect = null; try { rect = rootEl.getBoundingClientRect(); } catch (_) { node._emooOutRaf = requestAnimationFrame(update); return; }
    if (!rect || rect.width <= 0) { node._emooOutRaf = requestAnimationFrame(update); return; }
    const nodeW0 = (node.size && node.size[0]) || 1; const sx0 = rect.width / nodeW0;
    if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight || sx0 < 0.35) { all.forEach((item) => { item.el.style.display = 'none'; }); node._emooOutRaf = requestAnimationFrame(update); return; }
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
    node._emooOutRaf = requestAnimationFrame(update);
  };
  update();
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
  root.innerHTML = '<div class="emoo-hd"><span class="emoo-title">素材输出</span><span class="emoo-mode"><button data-m="split">拆分</button><button data-m="card">卡片</button><button data-m="row">卡片组</button><button data-m="group">分组</button></span><span class="emoo-status">未连接</span></div><div class="emoo-list"></div>';
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
    const widget = node.addDOMWidget('素材输出', nextWidgetType(), root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 140, getValue: () => '{}', setValue: () => {} });
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
app.registerExtension({
  name: 'EzFlex.MediaOut',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() {
    try { if (typeof LGraphCanvas !== 'undefined' && LGraphCanvas.link_type_colors) { Object.assign(LGraphCanvas.link_type_colors, { VIDEO: '#e0645c', AUDIO: '#34a853', MODEL_3D: '#b15bd6', IMAGE: '#4a9eff' }); } } catch (_) {}
    ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); });
  },
});
