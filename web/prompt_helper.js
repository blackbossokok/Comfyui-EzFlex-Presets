// EzFlex-PromptHelper 提示词卡片合并节点。
// 前端面板：完整富文本编辑器（卡片列表 + 格式工具条 + 颜色/字号/缩进 + 查找替换 + 取色器 + 规则弹窗）。
// 固定输入 clip/image/video/audio/model_3d；动态输入 = 卡片数 1:1（card_in_1..N，按顺序链接到卡片）；
// 输出固定「合并提示词」+ 动态卡片输出 = 卡片数 1:1（card_out_1..N）。
// 复用 ModelsCombo/ParamPreset/PreviewAny 动态端口经验：卡片增删/排序后复用 socket、回写 slot、
// POST /prompt_helper/outputs 同步类 RETURN_TYPES/RETURN_NAMES。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  NODE_TYPES, registerNode, unregisterNode, nodeTypeOf,
  configWidget, writeConfig, readConfig, installResizeHandles, makeDomWidgetHitThrough, uiConfirm,
} from "./ezflex_service.js";

const NODE = NODE_TYPES.PROMPT_HELPER;
const OUT_API = "/prompt_helper/outputs";
const MAX_CARDS = 32;
const FIXED_INPUTS = [
  { name: "clip", type: "CLIP", label: "CLIP" },
  { name: "image", type: "IMAGE", label: "图像" },
  { name: "video", type: "VIDEO", label: "视频" },
  { name: "audio", type: "AUDIO", label: "音频" },
  { name: "model_3d", type: "MODEL_3D", label: "3D 模型" },
];

const CSS = `
.eph-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.eph-shell .eph-root{pointer-events:auto;}
.eph-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:#1a1a2e;background:#fff;border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.eph-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.eph-hd{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.eph-btn{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:#1f2937;font-family:inherit;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;height:30px;line-height:1;}
.eph-btn:hover{background:#edf2fa;}
.eph-btn.success{background:#ecfdf3;border-color:#a7f0c6;color:#065f46;}
.eph-btn.success:hover{background:#d1fae5;}
.eph-btn.danger{background:#fef2f2;border-color:#fecaca;color:#991b1b;}
.eph-btn.danger:hover{background:#fee2e2;}
.eph-count{font-size:10px;color:#5f6b7a;background:#eef2f7;padding:0 10px;border-radius:100px;line-height:20px;}
.eph-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;}
.eph-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:16px;}
.eph-card{display:flex;align-items:center;gap:8px;background:#fbfcfe;border:1px solid #eef2f8;border-radius:10px;padding:6px 8px;flex-wrap:nowrap;}
.eph-card.dragging{opacity:.4;}
.eph-handle{cursor:grab;color:#8a99ae;font-size:14px;line-height:1.6;padding:0 2px;}
.eph-handle:hover{color:#1a1a2e;}
.eph-index{font-size:12px;font-weight:600;color:#5f6b7a;width:24px;text-align:center;flex:0 0 auto;}
.eph-title{flex:1 1 90px;min-width:70px;}
.eph-preview{flex:1 1 auto;min-width:0;font-size:11px;color:#5f6b7a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eph-time{background:#eef2f7;color:#5f6b7a;font-size:10px;padding:0 8px;border-radius:100px;line-height:20px;flex:0 0 auto;}
.eph-del{background:transparent;border:none;color:#b7c1cf;font-size:15px;cursor:pointer;padding:1px 4px;flex:0 0 auto;}
.eph-del:hover{color:#e34d4d;background:#fdecec;border-radius:6px;}
.eph-ph{height:0;border-top:3px solid #2b3a4a;border-radius:2px;margin:1px 0;opacity:.9;box-shadow:0 1px 6px rgba(43,58,74,.35);}
.eph-ph.hidden{display:none;}

/* 编辑器弹窗 */
.eph-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:99999;background:rgba(0,0,0,.35);}
.eph-modal.active{display:flex;}
.eph-modal-box{background:#fff;border-radius:14px;padding:0 0 12px;width:92%;max-width:760px;max-height:88vh;display:flex;flex-direction:column;gap:0;box-shadow:0 24px 80px rgba(0,0,0,.22);font-family:Inter,sans-serif;overflow:hidden;box-sizing:border-box;}
.eph-modal-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #edf2f8;}
.eph-modal-hd b{font-size:14px;color:#0f141f;}
.eph-modal-close{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:3px 11px;font-size:13px;cursor:pointer;font-family:inherit;color:#5f6b7a;}
.eph-modal-close:hover{background:#edf2fa;}
.eph-modal-body{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;overflow:auto;padding:10px 14px;}
.eph-modal-ft{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 16px 0;border-top:1px solid #edf2f8;}
.eph-btn-cancel{background:#f1f4fa;border:1px solid #e2e8f0;color:#4d5b6d;}
.eph-btn-save{background:#1a1a2e;border:1px solid #1a1a2e;color:#fff;}

/* 编辑器工具条 */
.eph-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px;background:#f8fafc;border-bottom:1px solid #e6edf7;}
.eph-tb-group{display:flex;align-items:center;gap:2px;position:relative;}
.eph-tb-btn{width:30px;height:30px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;border-radius:7px;color:#1a1a2e;cursor:pointer;font-size:13px;font-family:inherit;}
.eph-tb-btn:hover{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08);}
.eph-font-combo{display:flex;border:none;background:#fff;border-radius:8px;overflow:hidden;height:30px;box-shadow:0 1px 4px rgba(0,0,0,.06);}
.eph-font-combo input{border:none;width:44px;text-align:center;outline:none;font-size:12px;color:#1a1a2e;background:transparent;}
.eph-font-combo button{border:none;background:transparent;width:22px;cursor:pointer;position:relative;}
.eph-font-combo button::after{content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-70%);border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #94a3b8;}
.eph-font-list{position:absolute;top:34px;z-index:200;background:#fff;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.12);max-height:240px;overflow-y:auto;width:96px;display:none;padding:4px;}
.eph-font-list.active{display:block;}
.eph-font-list li{list-style:none;padding:7px;cursor:pointer;font-size:12px;text-align:center;border-radius:6px;}
.eph-font-list li:hover{background:#f1f4fa;}
.eph-color-btn{display:flex;align-items:center;gap:4px;padding:5px;border-radius:8px;cursor:pointer;border:none;background:transparent;}
.eph-color-btn:hover{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08);}
.eph-icon-a{font-weight:900;font-size:15px;font-family:sans-serif;position:relative;}
.eph-icon-a::after{content:'';position:absolute;left:2px;right:2px;bottom:1px;height:3px;background:#ef4444;border-radius:2px;}
.eph-icon-hl{position:relative;display:flex;flex-direction:column;align-items:center;}
.eph-icon-hl::before{content:'';width:3px;height:13px;background:#64748b;transform:rotate(45deg);position:absolute;top:-4px;}
.eph-icon-hl::after{content:'';width:13px;height:5px;background:#fde047;margin-top:2px;border-radius:2px;}
.eph-arrow-down{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #94a3b8;margin-left:2px;}
.eph-color-dropdown{position:absolute;top:34px;left:0;z-index:200;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.1);padding:12px;width:210px;display:none;}
.eph-color-dropdown.active{display:block;}
.eph-color-title{font-size:10px;font-weight:500;color:#94a3b8;margin:8px 0 6px;letter-spacing:.5px;text-transform:uppercase;}
.eph-color-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:4px;margin-bottom:8px;}
.eph-color-grid-sm{grid-template-columns:repeat(5,1fr);}
.eph-color-item{width:100%;aspect-ratio:1/1;border-radius:4px;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);transition:.1s;}
.eph-color-item:hover{transform:scale(1.1);}
.eph-no-color{background:#fff;background-image:linear-gradient(to top right,transparent calc(50% - 1px),#ef4444,transparent calc(50% + 1px));}
.eph-dropdown-btn{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:12px;color:#1a1a2e;background:#f1f4fa;margin-top:6px;font-weight:500;border:none;width:100%;font-family:inherit;}
.eph-dropdown-btn:hover{background:#e6edf7;}
.eph-dropdown-btn::after{content:'›';font-size:16px;color:#b7c1cf;}
.eph-tools-dropdown{position:absolute;top:34px;left:0;z-index:200;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.1);padding:6px;width:200px;display:none;}
.eph-tools-dropdown.active{display:block;}
.eph-tool-item{display:block;padding:7px 11px;border-radius:8px;cursor:pointer;font-size:12px;color:#1a1f2b;background:transparent;border:none;width:100%;text-align:left;font-family:inherit;}
.eph-tool-item:hover{background:#f1f4fa;}
.eph-indent-group{display:flex;align-items:center;gap:6px;}
.eph-indent-group label{font-size:11px;color:#5f6b7a;}
.eph-indent-input{width:52px;text-align:center;border:1px solid #dce3ec;border-radius:7px;padding:3px 6px;font-size:12px;font-family:inherit;outline:none;height:26px;}
.eph-tabs{display:flex;gap:2px;border-bottom:1px solid #e6edf7;margin-bottom:4px;}
.eph-tab{padding:7px 14px;font-size:12px;font-weight:500;color:#5f6b7a;cursor:pointer;border-bottom:2px solid transparent;}
.eph-tab.active{color:#1a1a2e;border-bottom-color:#1a1a2e;}
.eph-editor{min-height:200px;max-height:46vh;border:1px solid #dce3ec;border-radius:10px;padding:12px;outline:none;line-height:1.7;color:#1a1a2e;background:#fff;overflow:auto;font-size:14px;}
.eph-editor:focus{border-color:#94a3b8;}
.eph-timeline{display:flex;align-items:center;gap:6px;font-size:12px;color:#5f6b7a;}
.eph-timeline input{width:48px;text-align:center;border:1px solid #dce3ec;border-radius:7px;padding:3px 6px;font-size:12px;font-family:inherit;outline:none;height:26px;}
.eph-media-ref{display:flex;align-items:center;gap:4px;}
.eph-ref-label{font-size:11px;color:#5f6b7a;}

/* 查找/替换 */
.eph-fr{position:fixed;top:70px;right:90px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.16);width:360px;z-index:3000;display:none;overflow:hidden;}
.eph-fr.active{display:block;}
.eph-fr-header{display:flex;align-items:center;padding:8px 14px;border-bottom:1px solid #e6edf7;gap:10px;cursor:move;user-select:none;}
.eph-fr-tab{padding:6px 4px;font-size:12px;cursor:pointer;color:#5f6b7a;border-bottom:2px solid transparent;font-weight:500;background:transparent;border-top:none;border-left:none;border-right:none;}
.eph-fr-tab.active{color:#1a1a2e;border-bottom-color:#1a1a2e;}
.eph-fr-close{margin-left:auto;border:none;background:none;cursor:pointer;color:#94a3b8;font-size:16px;}
.eph-fr-body{padding:10px 14px;}
.eph-fr-row{display:flex;gap:6px;margin-bottom:6px;align-items:center;}
.eph-fr-row input{flex:1;border:1px solid #dce3ec;border-radius:7px;padding:7px;font-size:12px;outline:none;font-family:inherit;}
.eph-fr-btn{background:#1a1a2e;color:#fff;padding:6px 11px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-family:inherit;}
.eph-fr-hint{font-size:10px;color:#94a3b8;text-align:center;}

/* 标准取色器 */
.eph-picker{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:2000;background:rgba(0,0,0,.4);}
.eph-picker.active{display:flex;}
.eph-picker-box{background:#fff;border-radius:16px;padding:16px;width:320px;box-shadow:0 24px 80px rgba(0,0,0,.2);}
.eph-picker-preview{width:100%;height:36px;border-radius:8px;margin-bottom:14px;border:1px solid #e6edf7;}
.eph-picker-2d{position:relative;width:100%;aspect-ratio:1/1;border-radius:8px;margin-bottom:14px;cursor:crosshair;}
.eph-picker-2d-bg{position:absolute;inset:0;border-radius:8px;}
.eph-picker-2d-cursor{position:absolute;width:15px;height:15px;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);transform:translate(-50%,-50%);pointer-events:none;}
.eph-picker-hue{position:relative;width:100%;height:13px;border-radius:7px;margin:12px 0;background:linear-gradient(to right,#f00 0%,#ff0 17%,#0f0 33%,#0ff 50%,#00f 67%,#f0f 83%,#f00 100%);cursor:pointer;}
.eph-picker-thumb{position:absolute;top:50%;width:18px;height:18px;border-radius:50%;background:#fff;transform:translate(-50%,-50%);box-shadow:0 2px 6px rgba(0,0,0,.3);pointer-events:none;}
.eph-picker-modes{display:flex;gap:6px;margin-bottom:10px;}
.eph-picker-mode{flex:1;padding:5px;border:none;border-radius:6px;background:#f1f4fa;cursor:pointer;font-size:11px;font-weight:600;color:#5f6b7a;font-family:inherit;}
.eph-picker-mode.active{background:#1a1a2e;color:#fff;}
.eph-picker-row{display:flex;align-items:center;gap:6px;margin-bottom:6px;}
.eph-picker-row label{width:16px;font-size:11px;color:#5f6b7a;}
.eph-picker-row input[type=range]{flex:1;accent-color:#1a1a2e;}
.eph-picker-row input[type=number]{width:46px;border:1px solid #dce3ec;border-radius:6px;padding:4px;text-align:center;font-size:11px;outline:none;font-family:inherit;}
.eph-picker-ft{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;border-top:1px solid #e6edf7;padding-top:10px;}
.eph-picker-hex{flex:1;border:none;background:#f7f9fd;border-radius:8px;padding:8px 10px;font-size:13px;font-family:monospace;text-transform:uppercase;outline:none;}
.eph-picker-cancel{background:#f1f4fa;color:#4d5b6d;padding:8px 14px;border-radius:8px;border:none;cursor:pointer;font-family:inherit;}
.eph-picker-confirm{background:#1a1a2e;color:#fff;padding:8px 14px;border-radius:8px;border:none;cursor:pointer;font-family:inherit;}

/* 规则弹窗 */
.eph-rules{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:2001;background:rgba(0,0,0,.3);}
.eph-rules.active{display:flex;}
.eph-rules-box{background:#fff;border-radius:16px;width:640px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.2);overflow:hidden;}
.eph-rules-hd{display:flex;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e6edf7;}
.eph-rules-body{padding:14px 20px;overflow-y:auto;}
.eph-rule-sec{margin-bottom:16px;}
.eph-rule-title{font-weight:700;font-size:14px;margin-bottom:8px;color:#1a1a2e;}
.eph-rule-card{background:#f7f9fd;border-radius:8px;padding:10px;margin-bottom:6px;border-left:4px solid #3b82f6;}
.eph-rule-card strong{display:block;margin-bottom:3px;color:#1a1a2e;}
.eph-rule-card p{font-size:12px;color:#5f6b7a;line-height:1.5;}
.eph-rule-card code{background:#e2e8f0;padding:1px 3px;border-radius:4px;font-family:monospace;}
`;

let _styleInjected = false;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
function genId() { return 'ph_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
function deepClone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return Array.isArray(o) ? [] : {}; } }
function plainTextOf(html) { const d = document.createElement('div'); d.innerHTML = html || ''; return (d.textContent || '').trim(); }
const fetchApi = (p, o) => (api && typeof api.fetchApi === 'function') ? api.fetchApi(p, o) : fetch(p, o);

function stateFor(node) {
  if (!node._ezPh) node._ezPh = { cards: [], editingId: null, currentTab: 'default', dirty: false };
  return node._ezPh;
}
function loadFromConfig(node) {
  const st = stateFor(node);
  const cfg = readConfig(node, {});
  st.cards = Array.isArray(cfg.cards) ? deepClone(cfg.cards) : [];
  st.dirty = false;
}
function syncToConfig(node) {
  const st = stateFor(node);
  writeConfig(node, { cards: st.cards });
  markDirtyFalse(node);
}
function markDirtyFalse(node) { /* kept for clarity; no untracked dirty on config write */ }

// ===== 卡片操作 =====
function addCard(node) {
  const st = stateFor(node);
  st.cards.push({
    id: genId(), title: `第${st.cards.length + 1}幕`,
    content: '', contentHTML: '', contentOptimized: '', contentOptimizedHTML: '',
    timelineStart: '', timelineEnd: '', skill: '', modelType: 'text', model: '', provider: '',
  });
  syncToConfig(node); updatePorts(node); refreshUI(node);
}
function deleteCard(node, cardId) {
  const st = stateFor(node);
  const i = st.cards.findIndex((c) => c.id === cardId);
  if (i < 0) return;
  st.cards.splice(i, 1);
  syncToConfig(node); updatePorts(node); refreshUI(node);
}
function reorderCard(node, from, to) {
  const st = stateFor(node);
  if (from < 0 || from >= st.cards.length || to < 0 || to > st.cards.length) return;
  const [c] = st.cards.splice(from, 1);
  st.cards.splice(to, 0, c);
  syncToConfig(node); updatePorts(node); refreshUI(node);
}

// ===== 动态端口（输入 card_in_1..N / 输出 合并提示词 + card_out_1..N）=====
function syncOutputTypes(count) {
  try { fetchApi(OUT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: count || 0 }) }).catch(() => {}); } catch (_) {}
}
function removeConfigInput(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && _in.name === 'config') { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}
}
function deferSync(node) {
  if (node._ezPhSyncTimer) clearTimeout(node._ezPhSyncTimer);
  node._ezPhSyncTimer = setTimeout(() => { node._ezPhSyncTimer = null; try { updatePorts(node); refreshUI(node); } catch (_) {} }, 120);
}
function linksOf(o) {
  const ids = [];
  if (Array.isArray(o.links)) ids.push(...o.links);
  if (o.link != null) ids.push(o.link);
  return ids;
}
function updatePorts(node, noRedraw) {
  if (!node || !node.inputs || !node.outputs) return false;
  removeConfigInput(node);
  const st = stateFor(node);
  const count = Math.min(MAX_CARDS, st.cards.length);

  // 链路未恢复守卫：先不动 socket，延后再重排/删槽（否则保存的 target_slot/origin_slot 接不回去）
  const pending = (node.inputs || []).some((i) => i.link != null && !(node.graph && node.graph.links && node.graph.links[i.link]))
    || (node.outputs || []).some((o) => linksOf(o).some((lid) => lid != null && !(node.graph && node.graph.links && node.graph.links[lid])));
  if (pending) { deferSync(node); return false; }

  // ---- 输入：固定媒体前置 + 卡片输入按序 ----
  const FIXED = ['clip', 'image', 'video', 'audio', 'model_3d'];
  const fixed = FIXED.map((name) => {
    let s = (node.inputs || []).find((i) => i.name === name);
    if (!s) { node.addInput(name, FIXED_INPUTS.find((f) => f.name === name).type); s = node.inputs[node.inputs.length - 1]; }
    try { s.label = FIXED_INPUTS.find((f) => f.name === name).label; s.hideName = false; s.hidden = false; } catch (_) {}
    return s;
  });
  const fixedSet = new Set(fixed);
  const allCardSocks = (node.inputs || []).filter((i) => !fixedSet.has(i) && (i._ezCardId != null || /^card_in_\d+$/.test(i.name || '')));
  const used = new Set();
  const cardSeq = [];
  st.cards.forEach((card, idx) => {
    let sock = allCardSocks.find((x, i) => !used.has(i) && x._ezCardId != null && String(x._ezCardId) === String(card.id));
    if (!sock) sock = allCardSocks.find((x, i) => !used.has(i));
    if (!sock) { node.addInput(`card_in_${idx + 1}`, 'STRING'); sock = node.inputs[node.inputs.length - 1]; }
    const oi = allCardSocks.indexOf(sock);
    if (oi >= 0) used.add(oi);
    if (sock._ezCardId !== card.id) { sock._ezCardId = card.id; }
    if (sock.name !== `card_in_${idx + 1}`) { sock.name = `card_in_${idx + 1}`; }
    try { sock.label = ''; sock.hideName = true; sock.hidden = false; } catch (_) {}
    cardSeq.push(sock);
  });
  // 删除未被复用的旧卡片输入 socket
  allCardSocks.forEach((o, i) => {
    if (!used.has(i)) {
      const idx = node.inputs.indexOf(o);
      if (idx >= 0) node.removeInput(idx);
    }
  });
  const wantIn = [...fixed, ...cardSeq];
  if (node.inputs.length !== wantIn.length || node.inputs.some((i, x) => i !== wantIn[x])) {
    node.inputs.splice(0, node.inputs.length, ...wantIn);
  }
  node.inputs.forEach((i, idx) => {
    linksOf(i).forEach((lid) => { if (lid != null && node.graph && node.graph.links && node.graph.links[lid]) { try { node.graph.links[lid].target_slot = idx; } catch (_) {} } });
  });

  // ---- 输出：固定「合并提示词」红色圆点在首位 + 卡片输出按序 ----
  let mergedSock = (node.outputs || []).find((o) => o && o._ezMerged);
  if (!mergedSock && (node.outputs || [])[0] && (node.outputs || [])[0].name === '合并提示词') {
    mergedSock = (node.outputs || [])[0]; mergedSock._ezMerged = true;
  }
  if (!mergedSock) { node.addOutput('合并提示词', 'STRING', {}); mergedSock = node.outputs[node.outputs.length - 1]; mergedSock._ezMerged = true; }
  try { mergedSock.label = ''; mergedSock.hideName = true; mergedSock.hidden = false; } catch (_) {}
  if (mergedSock.color_on !== '#d94848') { mergedSock.color_on = '#d94848'; mergedSock.color_off = '#d94848'; mergedSock.color = '#d94848'; }

  const oldOuts = (node.outputs || []).filter((o) => o !== mergedSock);
  const usedOut = new Set();
  const outSeq = [];
  st.cards.forEach((card, idx) => {
    let sock = oldOuts.find((o, i) => !usedOut.has(i) && o._ezCardId != null && String(o._ezCardId) === String(card.id));
    if (!sock) sock = oldOuts.find((o, i) => !usedOut.has(i));
    if (!sock) { node.addOutput(`卡片 ${idx + 1}`, 'STRING', {}); sock = node.outputs[node.outputs.length - 1]; }
    const oi = oldOuts.indexOf(sock);
    if (oi >= 0) usedOut.add(oi);
    if (sock._ezCardId !== card.id) sock._ezCardId = card.id;
    if (sock.name !== `卡片 ${idx + 1}`) sock.name = `卡片 ${idx + 1}`;
    try { sock.label = ''; sock.hideName = true; sock.hidden = false; } catch (_) {}
    outSeq.push(sock);
  });
  oldOuts.forEach((o, i) => {
    if (!usedOut.has(i)) { const idx = node.outputs.indexOf(o); if (idx >= 0) node.removeOutput(idx); }
  });
  const wantOut = [mergedSock, ...outSeq];
  if (node.outputs.length !== wantOut.length || node.outputs.some((o, x) => o !== wantOut[x])) {
    node.outputs.splice(0, node.outputs.length, ...wantOut);
  }
  node.outputs.forEach((o, idx) => {
    linksOf(o).forEach((lid) => { if (lid != null && node.graph && node.graph.links && node.graph.links[lid]) { try { node.graph.links[lid].origin_slot = idx; } catch (_) {} } });
  });

  if (node.graph) node.graph.setDirtyCanvas(true, true);
  syncOutputTypes(count);
  return true;
}

// ===== 渲染卡片列表 =====
function attachDnD(container, itemSel, handleSel, onDrop) {
  container.querySelectorAll('.eph-ph').forEach((x) => x.remove());
  const placeholder = el('div', 'eph-ph hidden');
  container.appendChild(placeholder);
  container.querySelectorAll(handleSel).forEach((h) => {
    if (h._ezDnD) return; h._ezDnD = true;
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const item = h.closest(itemSel);
      if (!item) return;
      const items = [...container.querySelectorAll(itemSel)];
      const idx = items.indexOf(item);
      const rect = item.getBoundingClientRect();
      const clone = item.cloneNode(true);
      clone.style.cssText = `position:fixed;pointer-events:none;width:${rect.width}px;opacity:.85;z-index:99999;border:2px solid #2b3a4a;border-radius:6px;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,.12);top:${rect.top}px;left:${rect.left}px;transition:none;`;
      document.body.appendChild(clone);
      const st = { idx, clone, moved: false, targetIdx: idx };
      item.classList.add('dragging');
      items.forEach((c) => { if (c !== item) c.style.opacity = '0.5'; });
      const onMove = (ev) => {
        if (!st) return;
        st.moved = true;
        st.clone.style.top = (ev.clientY - 20) + 'px';
        const els = [...container.querySelectorAll(itemSel)];
        let insertIdx = els.length;
        for (let i = 0; i < els.length; i++) {
          const r = els[i].getBoundingClientRect();
          if (ev.clientY > r.top + r.height / 2) insertIdx = i + 1;
          else { insertIdx = i; break; }
        }
        const same = insertIdx === st.idx || insertIdx === st.idx + 1;
        placeholder.classList.toggle('hidden', same);
        if (!same) { if (insertIdx < els.length) els[insertIdx].before(placeholder); else els[els.length - 1].after(placeholder); }
        st.targetIdx = insertIdx;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        if (!st) return;
        if (st.clone && st.clone.parentNode) st.clone.parentNode.removeChild(st.clone);
        placeholder.classList.add('hidden');
        items.forEach((c) => { c.style.opacity = '1'; });
        const { idx, moved, targetIdx } = st;
        item.classList.remove('dragging');
        if (moved && targetIdx !== idx && targetIdx !== idx + 1) {
          let insert = targetIdx;
          if (insert > idx) insert -= 1;
          onDrop(idx, insert);
        }
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    });
  });
}

function buildCardRow(node, card, index) {
  const row = el('div', 'eph-card'); row.dataset.id = card.id;
  const handle = el('span', 'eph-handle'); handle.textContent = '⠿';
  const idx = el('span', 'eph-index'); idx.textContent = String(index + 1);
  const title = el('input', 'eph-title'); title.value = card.title || ''; title.placeholder = '卡片标题';
  title.addEventListener('change', () => { card.title = title.value; syncToConfig(node); refreshUI(node); });
  const preview = el('span', 'eph-preview'); preview.textContent = card.content || '（空内容）';
  const time = el('span', 'eph-time'); time.textContent = (card.timelineStart && card.timelineEnd) ? `${card.timelineStart}-${card.timelineEnd}s` : '';
  const del = el('button', 'eph-del'); del.textContent = '×'; del.title = '删除卡片';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (await uiConfirm(`确定删除提示词卡片「${card.title || ''}」吗？`)) deleteCard(node, card.id);
  });
  row.addEventListener('click', (e) => {
    if (e.target.closest('input') || e.target.closest('button') || e.target.closest('.eph-handle')) return;
    openEditModal(node, card.id);
  });
  row.appendChild(handle); row.appendChild(idx); row.appendChild(title); row.appendChild(preview); row.appendChild(time); row.appendChild(del);
  return row;
}

function renderCards(node) {
  const st = stateFor(node);
  const root = node && node._ezRoot;
  if (!root) return;
  const list = root.querySelector('.eph-list');
  if (!list) return;
  list.innerHTML = '';
  if (!st.cards.length) { const e = el('div', 'eph-empty'); e.textContent = '暂无提示词卡片，点「＋ 新增提示词卡片」添加'; list.appendChild(e); return; }
  st.cards.forEach((c, i) => list.appendChild(buildCardRow(node, c, i)));
  attachDnD(list, '.eph-card', '.eph-handle', (from, to) => reorderCard(node, from, to));
  fitNode(node);
}

// ===== 编辑器弹窗 =====
let _editModal = null;
let _editorRange = null;
function saveSelection() { const sel = window.getSelection(); if (sel.rangeCount) _editorRange = sel.getRangeAt(0); }
function restoreSelection() {
  if (!_editorRange) return;
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(_editorRange);
}
function editModalEl() {
  if (_editModal && _editModal.parentNode) return _editModal;
  _editModal = el('div', 'eph-modal');
  const box = el('div', 'eph-modal-box');
  const hd = el('div', 'eph-modal-hd');
  const t = el('b'); t.textContent = '编辑提示词';
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  hd.appendChild(t); hd.appendChild(close);
  // 工具条
  const toolbar = el('div', 'eph-toolbar');
  toolbar.appendChild(el('button', 'eph-tb-btn')).textContent = 'B'; toolbar.lastChild.dataset.cmd = 'bold';
  toolbar.appendChild(el('button', 'eph-tb-btn')).textContent = 'I'; toolbar.lastChild.dataset.cmd = 'italic';
  toolbar.appendChild(el('button', 'eph-tb-btn')).textContent = 'U'; toolbar.lastChild.dataset.cmd = 'underline';
  toolbar.appendChild(el('button', 'eph-tb-btn')).textContent = 'S'; toolbar.lastChild.dataset.cmd = 'strikeThrough';
  toolbar.appendChild(el('button', 'eph-tb-btn')).textContent = '⇤'; toolbar.lastChild.dataset.cmd = 'justifyLeft';
  toolbar.appendChild(el('button', 'eph-tb-btn')).textContent = '⇹'; toolbar.lastChild.dataset.cmd = 'justifyCenter';
  toolbar.appendChild(el('button', 'eph-tb-btn')).textContent = '⇥'; toolbar.lastChild.dataset.cmd = 'justifyRight';
  toolbar.appendChild(el('button', 'eph-tb-btn')).textContent = '≣'; toolbar.lastChild.dataset.cmd = 'justifyFull';

  const fontGroup = el('div', 'eph-tb-group');
  const fontCombo = el('div', 'eph-font-combo');
  const fontInput = el('input'); fontInput.value = '16';
  const fontBtn = el('button'); const fontList = el('ul', 'eph-font-list');
  populateFontList(fontList);
  fontCombo.appendChild(fontInput); fontCombo.appendChild(fontBtn);
  fontGroup.appendChild(fontCombo); fontGroup.appendChild(fontList);
  toolbar.appendChild(fontGroup);

  const colorGroup = el('div', 'eph-tb-group');
  const hlBtn = el('button', 'eph-color-btn'); hlBtn.innerHTML = '<span class="eph-icon-hl"></span><span class="eph-arrow-down"></span>';
  const hlDD = el('div', 'eph-color-dropdown');
  colorGroup.appendChild(hlBtn); colorGroup.appendChild(hlDD);
  const fcBtn = el('button', 'eph-color-btn'); fcBtn.innerHTML = '<span class="eph-icon-a">A</span><span class="eph-arrow-down"></span>';
  const fcDD = el('div', 'eph-color-dropdown');
  colorGroup.appendChild(fcBtn); colorGroup.appendChild(fcDD);
  toolbar.appendChild(colorGroup);

  const indentGroup = el('div', 'eph-indent-group');
  indentGroup.appendChild(el('label')).textContent = '缩进';
  const indentInput = el('input', 'eph-indent-input'); indentInput.value = '0';
  indentGroup.appendChild(indentInput);
  toolbar.appendChild(indentGroup);

  const toolsGroup = el('div', 'eph-tb-group');
  const toolsBtn = el('button', 'eph-btn'); toolsBtn.textContent = '工具';
  const toolsDD = el('div', 'eph-tools-dropdown');
  toolsGroup.appendChild(toolsBtn); toolsGroup.appendChild(toolsDD);
  toolbar.appendChild(toolsGroup);

  const refGroup = el('div', 'eph-tb-group');
  const refBtn = el('button', 'eph-btn'); refBtn.textContent = '插入引用';
  const refDD = el('div', 'eph-tools-dropdown');
  refGroup.appendChild(refBtn); refGroup.appendChild(refDD);
  toolbar.appendChild(refGroup);

  const tabDefault = el('button', 'eph-tab active'); tabDefault.textContent = '默认提示词';
  const tabOptimized = el('button', 'eph-tab'); tabOptimized.textContent = '优化提示词';

  const body = el('div', 'eph-modal-body');
  body.appendChild(toolbar);
  const editorWrap = el('div', 'eph-tabs'); editorWrap.style.cssText = 'border-bottom:none;margin-bottom:4px;';
  editorWrap.appendChild(tabDefault); editorWrap.appendChild(tabOptimized);
  body.appendChild(editorWrap);
  const editor = el('div', 'eph-editor'); editor.contentEditable = 'true';
  body.appendChild(editor);

  const ft = el('div', 'eph-modal-ft');
  const timeline = el('div', 'eph-timeline');
  const tsLabel = el('span'); tsLabel.textContent = '时间轴';
  const tsStart = el('input'); tsStart.placeholder = '开始';
  const tsDash = el('span'); tsDash.textContent = '—';
  const tsEnd = el('input'); tsEnd.placeholder = '结束';
  const tsUnit = el('span'); tsUnit.textContent = 's';
  timeline.appendChild(tsLabel); timeline.appendChild(tsStart); timeline.appendChild(tsDash); timeline.appendChild(tsEnd); timeline.appendChild(tsUnit);
  const cancelBtn = el('button', 'eph-btn eph-btn-cancel'); cancelBtn.textContent = '取消';
  const saveBtn = el('button', 'eph-btn eph-btn-save'); saveBtn.textContent = '保存';
  ft.appendChild(timeline);
  const ftBtns = el('div'); ftBtns.style.cssText = 'display:flex;gap:8px;';
  ftBtns.appendChild(cancelBtn); ftBtns.appendChild(saveBtn); ft.appendChild(ftBtns);

  box.appendChild(hd); box.appendChild(body); box.appendChild(ft);
  _editModal.appendChild(box); document.body.appendChild(_editModal);

  // 绑定
  close.addEventListener('click', () => closeEditModal(false));
  cancelBtn.addEventListener('click', () => closeEditModal(false));
  saveBtn.addEventListener('click', () => closeEditModal(true));
  tabDefault.addEventListener('click', () => switchTab('default'));
  tabOptimized.addEventListener('click', () => switchTab('optimized'));
  toolbar.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => execCmd(b.dataset.cmd)));
  fontBtn.addEventListener('click', (e) => { e.stopPropagation(); fontList.classList.toggle('active'); });
  fontInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFontSize(fontInput.value); });
  fontList.addEventListener('click', (e) => { if (e.target.tagName === 'LI') { applyFontSize(e.target.dataset.value); fontInput.value = e.target.textContent; fontList.classList.remove('active'); } });
  indentInput.addEventListener('change', () => applyIndent(indentInput.value));
  hlBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); hlDD.classList.toggle('active'); fcDD.classList.remove('active'); });
  fcBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); fcDD.classList.toggle('active'); hlDD.classList.remove('active'); });
  toolsBtn.addEventListener('click', (e) => { e.stopPropagation(); toolsDD.classList.toggle('active'); });
  refBtn.addEventListener('click', (e) => { e.stopPropagation(); refDD.classList.toggle('active'); });

  // 颜色下拉 / 工具下拉 / 引用下拉
  initColorDropdown(hlDD, 'highlight');
  initColorDropdown(fcDD, 'font');
  const toolsItems = [['全角符号转半角', 'fullToHalf'], ['半角符号转全角', 'halfToFull'], ['优化提示词 (API)', 'optimize']];
  toolsItems.forEach(([label, id]) => {
    const b = el('button', 'eph-tool-item'); b.textContent = label;
    b.addEventListener('click', () => { runTool(id); toolsDD.classList.remove('active'); });
    toolsDD.appendChild(b);
  });
  const refItems = ['@图片1', '@视频1', '@音频1', '@3D模型1'];
  refItems.forEach((r) => { const b = el('button', 'eph-tool-item'); b.textContent = r; b.addEventListener('click', () => { insertText(r); refDD.classList.remove('active'); }); refDD.appendChild(b); });

  _editModal._box = box; _editModal._editor = editor; _editModal._tabDefault = tabDefault; _editModal._tabOptimized = tabOptimized;
  _editModal._fontInput = fontInput; _editModal._fontList = fontList; _editModal._indentInput = indentInput; _editModal._tsStart = tsStart; _editModal._tsEnd = tsEnd;
  _editModal._hlDD = hlDD; _editModal._fcDD = fcDD; _editModal._toolsDD = toolsDD; _editModal._refDD = refDD;
  document.addEventListener('mousedown', (e) => {
    if (!fontList.contains(e.target) && e.target !== fontBtn) fontList.classList.remove('active');
    if (!hlDD.contains(e.target) && !hlBtn.contains(e.target)) hlDD.classList.remove('active');
    if (!fcDD.contains(e.target) && !fcBtn.contains(e.target)) fcDD.classList.remove('active');
    if (!toolsDD.contains(e.target) && e.target !== toolsBtn) toolsDD.classList.remove('active');
    if (!refDD.contains(e.target) && e.target !== refBtn) refDD.classList.remove('active');
  });
  editor.addEventListener('keyup', saveSelection);
  editor.addEventListener('mouseup', saveSelection);
  return _editModal;
}

function openEditModal(node, cardId) {
  const st = stateFor(node);
  const card = st.cards.find((c) => c.id === cardId);
  if (!card) return;
  st.editingId = cardId;
  st.currentTab = 'default';
  const m = editModalEl(); m._node = node;
  m._tabDefault.classList.add('active'); m._tabOptimized.classList.remove('active');
  m._editor.innerHTML = card.contentHTML || card.content || '';
  m._tsStart.value = card.timelineStart || ''; m._tsEnd.value = card.timelineEnd || '';
  m._indentInput.value = '0';
  m.classList.add('active');
  setTimeout(() => { try { m._editor.focus(); } catch (_) {} }, 100);
}
function switchTab(tab) {
  const nd = _editModal && _editModal._node;
  if (!nd) return;
  const st = stateFor(nd);
  const card = st.cards.find((c) => c.id === st.editingId);
  if (!card) return;
  st.currentTab = tab;
  if (tab === 'default') {
    _editModal._tabDefault.classList.add('active'); _editModal._tabOptimized.classList.remove('active');
    _editModal._editor.innerHTML = card.contentHTML || card.content || '';
  } else {
    _editModal._tabOptimized.classList.add('active'); _editModal._tabDefault.classList.remove('active');
    _editModal._editor.innerHTML = card.contentOptimizedHTML || card.contentOptimized || '';
  }
}
function closeEditModal(save) {
  const nd = _editModal && _editModal._node;
  if (save && nd) {
    const st = stateFor(nd);
    const card = st.cards.find((c) => c.id === st.editingId);
    if (card) {
      const html = _editModal._editor.innerHTML;
      const plain = plainTextOf(html);
      if (st.currentTab === 'optimized') { card.contentOptimizedHTML = html; card.contentOptimized = plain; }
      else { card.contentHTML = html; card.content = plain; }
      card.timelineStart = _editModal._tsStart.value.trim();
      card.timelineEnd = _editModal._tsEnd.value.trim();
      syncToConfig(nd); updatePorts(nd); refreshUI(nd);
    }
    st.editingId = null;
  }
  _editModal && _editModal.classList.remove('active');
}
function nodeOfEditModal() { return (_editModal && _editModal._node && _editModal._node instanceof Object) ? _editModal._node : null; }
function execCmd(cmd, val = null) { const ed = _editModal && _editModal._editor; if (ed) { ed.focus(); document.execCommand(cmd, false, val); saveSelection(); } }
function populateFontList(list) {
  if (!list || list._populated) return; list._populated = true;
  const sizeMap = { 初号: '48px', 小初: '36px', 一号: '26pt', 小一: '24pt', 二号: '22pt', 小二: '18pt', 三号: '16pt', 小三: '15pt', 四号: '14pt', 小四: '12pt', 五号: '10.5pt', 小五: '9pt' };
  Object.keys(sizeMap).forEach((label) => { const li = el('li'); li.textContent = label; li.dataset.value = sizeMap[label]; list.appendChild(li); });
  [5, 6.5, 8, 9, 10.5, 12, 14, 16, 18, 22, 26, 36, 48, 72].forEach((n) => { const li = el('li'); li.textContent = String(n); li.dataset.value = n + 'px'; list.appendChild(li); });
}
function applyFontSize(val) {
  const ed = _editModal && _editModal._editor; if (!ed) return;
  ed.focus(); const sel = window.getSelection();
  if (sel.isCollapsed) { const r = document.createRange(); r.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(r); }
  document.execCommand('fontSize', false, '7'); document.execCommand('fontName', false, '');
  // 统一改用 span 内联 fontSize 更稳
  ed.querySelectorAll('font[size="7"]').forEach((f) => { const s = document.createElement('span'); s.style.fontSize = val; s.innerHTML = f.innerHTML; f.replaceWith(s); });
  saveSelection();
}
function applyIndent(val) {
  const ed = _editModal && _editModal._editor; if (!ed) return;
  const n = parseFloat(val) || 0;
  ed.querySelectorAll('p,div').forEach((b) => { b.style.marginLeft = n + 'em'; });
  ed.focus();
}
function applyColor(target, color) {
  const ed = _editModal && _editModal._editor; if (!ed) return;
  ed.focus(); const sel = window.getSelection();
  if (sel.isCollapsed) { const r = document.createRange(); r.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(r); }
  document.execCommand(target === 'highlight' ? 'hiliteColor' : 'foreColor', false, color);
  sel.removeAllRanges();
  saveSelection();
}
function insertText(text) {
  const ed = _editModal && _editModal._editor; if (!ed) return;
  ed.focus(); restoreSelection();
  document.execCommand('insertText', false, text);
  saveSelection();
}
function runTool(id) {
  const ed = _editModal && _editModal._editor;
  if (!ed) return;
  const text = ed.textContent;
  let out = text;
  if (id === 'fullToHalf') {
    const map = { '，': ',', '。': '.', '！': '!', '？': '?', '：': ':', '；': ';', '“': '"', '”': '"', '‘': "'", '’': "'", '（': '(', '）': ')', '【': '[', '】': ']', '《': '<', '》': '>', '、': ',', '—': '-', '～': '~' };
    out = text.replace(/[，。！？：；“”‘’（）【】《》、—～]/g, (ch) => map[ch] || ch).replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
  } else if (id === 'halfToFull') {
    const map = { ',': '，', '.': '。', '!': '！', '?': '？', ':': '：', ';': '；', '"': '“', "'": '‘', '(': '（', ')': '）', '[': '【', ']': '】', '<': '《', '>': '》', '~': '～', '-': '—' };
    out = text.replace(/[,\.!\?:;"'\(\)\[\]<>~-]/g, (ch) => map[ch] || ch).replace(/[\x21-\x7E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).replace(/ /g, '\u3000');
  } else if (id === 'optimize') {
    window.alert('优化提示词为占位功能：将在后端 API 接入后生效。'); return;
  }
  ed.textContent = out; saveSelection();
}

// ===== 颜色下拉 =====
const _THEME_COLORS = ['#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
const _STD_COLORS = ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0'];
function initColorDropdown(dd, target) {
  const noColor = el('div', 'eph-color-item eph-no-color'); noColor.dataset.color = 'transparent'; noColor.title = '无颜色';
  const grid = el('div', 'eph-color-grid');
  const gridSm = el('div', 'eph-color-grid eph-color-grid-sm');
  grid.appendChild(noColor);
  // 高亮：无颜色 + 标准色；前景：主题色 + 标准色
  (target === 'highlight' ? _STD_COLORS : _THEME_COLORS).forEach((c) => grid.appendChild(colorItem(c, target)));
  const title2 = el('div', 'eph-color-title'); title2.textContent = '标准色';
  _STD_COLORS.forEach((c) => gridSm.appendChild(colorItem(c, target)));
  const more = el('button', 'eph-dropdown-btn'); more.textContent = '其他颜色(M)...';
  dd.appendChild(grid); dd.appendChild(title2); dd.appendChild(gridSm); dd.appendChild(more);
  more.addEventListener('click', (e) => { e.stopPropagation(); openColorPicker(target); dd.classList.remove('active'); });
}
function colorItem(c, target) {
  const d = el('div', 'eph-color-item'); d.style.background = c; d.dataset.color = c;
  d.addEventListener('mousedown', (e) => e.preventDefault());
  d.addEventListener('click', (e) => { e.stopPropagation(); applyColor(target, c); const dd = _editModal && (target === 'highlight' ? _editModal._hlDD : _editModal._fcDD); if (dd) dd.classList.remove('active'); });
  return d;
}

// ===== 自定义取色器 =====
let _pickerModal = null, _pickerTarget = null;
let _pcR = 255, _pcG = 255, _pcB = 255, _pcH = 200, _pcS = 100, _pcL = 50, _pcHSV_S = 100, _pcHSV_V = 100, _pcMode = 'hex';
function rgbToHsl(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); let h, s, l = (max + min) / 2; if (max === min) { h = s = 0; } else { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; } return { h: h * 360, s: s * 100, l: l * 100 }; }
function rgbToHsv(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); const d = max - min; let h; if (d === 0) h = 0; else if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60; else if (max === g) h = ((b - r) / d + 2) * 60; else h = ((r - g) / d + 4) * 60; return { h, s: (max === 0 ? 0 : d / max) * 100, v: max * 100 }; }
function hslToRgb(h, s, l) { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return { r: Math.round(255 * f(0)), g: Math.round(255 * f(8)), b: Math.round(255 * f(4)) }; }
function hsvToRgb(h, s, v) { s /= 100; v /= 100; const i = Math.floor(h / 60); const f = h / 60 - i; const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - (1 - f) * s); let r, g, b; switch (i % 6) { case 0: r = v; g = t; b = p; break; case 1: r = q; g = v; b = p; break; case 2: r = p; g = v; b = t; break; case 3: r = p; g = q; b = v; break; case 4: r = t; g = p; b = v; break; case 5: r = v; g = p; b = q; break; } return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) }; }
function rgbToHex(r, g, b) { return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase(); }
function pickerEl() {
  if (_pickerModal && _pickerModal.parentNode) return _pickerModal;
  _pickerModal = el('div', 'eph-picker');
  const box = el('div', 'eph-picker-box');
  const preview = el('div', 'eph-picker-preview');
  const area = el('div', 'eph-picker-2d'); const bg = el('div', 'eph-picker-2d-bg'); const cursor = el('div', 'eph-picker-2d-cursor');
  area.appendChild(bg); area.appendChild(cursor);
  const hue = el('div', 'eph-picker-hue'); const thumb = el('div', 'eph-picker-thumb'); hue.appendChild(thumb);
  const modes = el('div', 'eph-picker-modes');
  ['hex', 'rgb', 'hsl', 'hsv'].forEach((m) => { const b = el('button', 'eph-picker-mode'); b.textContent = m.toUpperCase(); b.dataset.mode = m; if (m === 'hex') b.classList.add('active'); modes.appendChild(b); });
  const hexInput = el('input', 'eph-picker-hex'); hexInput.maxLength = 7; hexInput.value = '#000000';
  const rows = el('div'); rows.style.cssText = 'display:flex;flex-direction:column;';
  const ft = el('div', 'eph-picker-ft');
  const cancel = el('button', 'eph-picker-cancel'); cancel.textContent = '取消';
  const confirm = el('button', 'eph-picker-confirm'); confirm.textContent = '确定';
  ft.appendChild(hexInput); ft.appendChild(cancel); ft.appendChild(confirm);
  box.appendChild(preview); box.appendChild(area); box.appendChild(hue); box.appendChild(modes); box.appendChild(rows); box.appendChild(ft);
  _pickerModal.appendChild(box); document.body.appendChild(_pickerModal);
  _pickerModal._preview = preview; _pickerModal._area = area; _pickerModal._bg = bg; _pickerModal._cursor = cursor; _pickerModal._hue = hue; _pickerModal._thumb = thumb; _pickerModal._hex = hexInput; _pickerModal._rows = rows; _pickerModal._modes = modes;
  _pickerModal._cancel = cancel; _pickerModal._confirm = confirm; _pickerModal._box = box;
  modes.querySelectorAll('.eph-picker-mode').forEach((b) => b.addEventListener('click', () => setPickerMode(b.dataset.mode)));
  hexInput.addEventListener('input', () => { if (/^#[0-9A-Fa-f]{6}$/.test(hexInput.value)) { setFromHex(hexInput.value); updatePickerUI(); } });
  cancel.addEventListener('click', () => closePicker());
  confirm.addEventListener('click', () => { applyColor(_pickerTarget, hexInput.value); closePicker(); });
  area.addEventListener('mousedown', (e) => { e.preventDefault(); drag2d(e); const mv = (ev) => drag2d(ev); const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); });
  hue.addEventListener('mousedown', (e) => { e.preventDefault(); dragHue(e); const mv = (ev) => dragHue(ev); const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); });
  return _pickerModal;
}
function setPickerMode(mode) {
  _pcMode = mode;
  _pickerModal.querySelectorAll('.eph-picker-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  buildPickerRows(); updatePickerUI();
}
function buildPickerRows() {
  const rows = _pickerModal._rows; rows.innerHTML = '';
  const addRow = (label, key, min, max) => {
    const ro = el('div', 'eph-picker-row');
    const lab = el('label'); lab.textContent = label;
    const range = el('input'); range.type = 'range'; range.min = String(min); range.max = String(max);
    const num = el('input'); num.type = 'number'; num.min = String(min); num.max = String(max);
    ro.appendChild(lab); ro.appendChild(range); ro.appendChild(num); rows.appendChild(ro);
    const sync = (v) => { num.value = range.value = v; setFromInputs(); };
    range.addEventListener('input', () => { num.value = range.value; setFromInputs(); });
    num.addEventListener('input', () => { range.value = num.value; setFromInputs(); });
    _pickerModal['_row_' + key] = { range, num };
  };
  if (_pcMode === 'rgb') { addRow('R', 'r', 0, 255); addRow('G', 'g', 0, 255); addRow('B', 'b', 0, 255); }
  else if (_pcMode === 'hsl') { addRow('H', 'h', 0, 360); addRow('S', 's', 0, 100); addRow('L', 'l', 0, 100); }
  else if (_pcMode === 'hsv') { addRow('H', 'h', 0, 360); addRow('S', 's', 0, 100); addRow('V', 'v', 0, 100); }
}
function setFromInputs() {
  if (_pcMode === 'rgb') { _pcR = parseInt(_pickerModal._row_r.num.value) || 0; _pcG = parseInt(_pickerModal._row_g.num.value) || 0; _pcB = parseInt(_pickerModal._row_b.num.value) || 0; }
  else if (_pcMode === 'hsl') { _pcH = parseFloat(_pickerModal._row_h.num.value) || 0; _pcS = parseFloat(_pickerModal._row_s.num.value) || 0; _pcL = parseFloat(_pickerModal._row_l.num.value) || 0; const rgb = hslToRgb(_pcH, _pcS, _pcL); _pcR = rgb.r; _pcG = rgb.g; _pcB = rgb.b; }
  else if (_pcMode === 'hsv') { _pcH = parseFloat(_pickerModal._row_h.num.value) || 0; _pcHSV_S = parseFloat(_pickerModal._row_s.num.value) || 0; _pcHSV_V = parseFloat(_pickerModal._row_v.num.value) || 0; const rgb = hsvToRgb(_pcH, _pcHSV_S, _pcHSV_V); _pcR = rgb.r; _pcG = rgb.g; _pcB = rgb.b; }
  updatePickerUI();
}
function setFromHex(hex) { _pcR = parseInt(hex.substring(1, 3), 16); _pcG = parseInt(hex.substring(3, 5), 16); _pcB = parseInt(hex.substring(5, 7), 16); const hsl = rgbToHsl(_pcR, _pcG, _pcB); const hsv = rgbToHsv(_pcR, _pcG, _pcB); _pcH = hsl.h; _pcS = hsl.s; _pcL = hsl.l; _pcHSV_S = hsv.s; _pcHSV_V = hsv.v; }
function drag2d(e) {
  const rect = _pickerModal._area.getBoundingClientRect();
  let x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  let y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
  if (_pcMode === 'rgb' || _pcMode === 'hex') { _pcR = Math.round((x / rect.width) * 255); _pcG = Math.round(255 - (y / rect.height) * 255); }
  else if (_pcMode === 'hsl') { _pcS = Math.round((x / rect.width) * 100); _pcL = Math.round(100 - (y / rect.height) * 100); const rgb = hslToRgb(_pcH, _pcS, _pcL); _pcR = rgb.r; _pcG = rgb.g; _pcB = rgb.b; }
  else if (_pcMode === 'hsv') { _pcHSV_S = Math.round((x / rect.width) * 100); _pcHSV_V = Math.round(100 - (y / rect.height) * 100); const rgb = hsvToRgb(_pcH, _pcHSV_S, _pcHSV_V); _pcR = rgb.r; _pcG = rgb.g; _pcB = rgb.b; }
  updatePickerUI();
}
function dragHue(e) {
  const rect = _pickerModal._hue.getBoundingClientRect();
  let x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  _pcH = Math.round((x / rect.width) * 360);
  const rgb = hslToRgb(_pcH, _pcS, _pcL); _pcR = rgb.r; _pcG = rgb.g; _pcB = rgb.b;
  updatePickerUI();
}
function updatePickerUI() {
  const hex = rgbToHex(_pcR, _pcG, _pcB);
  _pickerModal._preview.style.background = hex;
  _pickerModal._hex.value = hex;
  _pickerModal._thumb.style.left = (_pcH / 360 * 100) + '%';
  if (_pcMode === 'rgb' || _pcMode === 'hex') { _pickerModal._bg.style.background = `linear-gradient(to bottom, rgb(0,0,${_pcB}), rgb(255,0,${_pcB})), linear-gradient(to right,#000,#fff)`; _pickerModal._bg.style.backgroundBlendMode = 'multiply'; _pickerModal._cursor.style.left = (_pcR / 255 * 100) + '%'; _pickerModal._cursor.style.top = (100 - _pcG / 255 * 100) + '%'; }
  else if (_pcMode === 'hsl') { const base = hslToRgb(_pcH, 100, 50); _pickerModal._bg.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,rgb(${base.r},${base.g},${base.b}))`; _pickerModal._bg.style.backgroundBlendMode = 'normal'; _pickerModal._cursor.style.left = _pcS + '%'; _pickerModal._cursor.style.top = (100 - _pcL) + '%'; }
  else if (_pcMode === 'hsv') { const base = hsvToRgb(_pcH, 100, 100); _pickerModal._bg.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,rgb(${base.r},${base.g},${base.b}))`; _pickerModal._bg.style.backgroundBlendMode = 'normal'; _pickerModal._cursor.style.left = _pcHSV_S + '%'; _pickerModal._cursor.style.top = (100 - _pcHSV_V) + '%'; }
  if (_pcMode === 'rgb' && _pickerModal._row_r) { _pickerModal._row_r.range.value = _pickerModal._row_r.num.value = _pcR; _pickerModal._row_g.range.value = _pickerModal._row_g.num.value = _pcG; _pickerModal._row_b.range.value = _pickerModal._row_b.num.value = _pcB; }
  else if (_pcMode === 'hsl' && _pickerModal._row_h) { _pickerModal._row_h.range.value = _pickerModal._row_h.num.value = Math.round(_pcH); _pickerModal._row_s.range.value = _pickerModal._row_s.num.value = Math.round(_pcS); _pickerModal._row_l.range.value = _pickerModal._row_l.num.value = Math.round(_pcL); }
  else if (_pcMode === 'hsv' && _pickerModal._row_h) { _pickerModal._row_h.range.value = _pickerModal._row_h.num.value = Math.round(_pcH); _pickerModal._row_s.range.value = _pickerModal._row_s.num.value = Math.round(_pcHSV_S); _pickerModal._row_v.range.value = _pickerModal._row_v.num.value = Math.round(_pcHSV_V); }
}
function openColorPicker(target) {
  _pickerTarget = target;
  const m = pickerEl();
  _pcR = 100; _pcG = 200; _pcB = 255; _pcH = 200; _pcS = 100; _pcL = 50; _pcHSV_S = 100; _pcHSV_V = 100; _pcMode = 'hex';
  m.querySelectorAll('.eph-picker-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'hex'));
  buildPickerRows(); updatePickerUI(); m.classList.add('active');
}
function closePicker() { _pickerModal && _pickerModal.classList.remove('active'); }

// ===== 查找/替换弹窗（可拖动）=====
let _frModal = null, _frDrag = null;
function frEl() {
  if (_frModal && _frModal.parentNode) return _frModal;
  _frModal = el('div', 'eph-fr');
  const header = el('div', 'eph-fr-header');
  const findTab = el('button', 'eph-fr-tab active'); findTab.textContent = '查找';
  const replaceTab = el('button', 'eph-fr-tab'); replaceTab.textContent = '替换';
  const close = el('button', 'eph-fr-close'); close.textContent = '✕';
  header.appendChild(findTab); header.appendChild(replaceTab); header.appendChild(close);
  const body = el('div', 'eph-fr-body');
  const findSec = el('div'); const findRow = el('div', 'eph-fr-row'); const fi = el('input'); fi.placeholder = '查找内容';
  const fbtn = el('button', 'eph-fr-btn'); fbtn.textContent = '查找'; findRow.appendChild(fi); findRow.appendChild(fbtn);
  const fhint = el('p', 'eph-fr-hint'); fhint.textContent = '使用浏览器原生搜索(Ctrl+F)';
  findSec.appendChild(findRow); findSec.appendChild(fhint);
  const replaceSec = el('div'); replaceSec.style.display = 'none';
  const rr1 = el('div', 'eph-fr-row'); const fi2 = el('input'); fi2.placeholder = '查找内容'; const fb2 = el('button', 'eph-fr-btn'); fb2.textContent = '查找'; rr1.appendChild(fi2); rr1.appendChild(fb2);
  const rr2 = el('div', 'eph-fr-row'); const ri = el('input'); ri.placeholder = '替换为'; const rb = el('button', 'eph-fr-btn'); rb.textContent = '替换'; rr2.appendChild(ri); rr2.appendChild(rb);
  const rhint = el('p', 'eph-fr-hint'); rhint.textContent = '替换前请先选中目标文字';
  replaceSec.appendChild(rr1); replaceSec.appendChild(rr2); replaceSec.appendChild(rhint);
  body.appendChild(findSec); body.appendChild(replaceSec);
  _frModal.appendChild(header); _frModal.appendChild(body); document.body.appendChild(_frModal);
  findTab.addEventListener('click', () => { findTab.classList.add('active'); replaceTab.classList.remove('active'); findSec.style.display = 'block'; replaceSec.style.display = 'none'; });
  replaceTab.addEventListener('click', () => { replaceTab.classList.add('active'); findTab.classList.remove('active'); findSec.style.display = 'none'; replaceSec.style.display = 'block'; });
  close.addEventListener('click', () => _frModal.classList.remove('active'));
  fbtn.addEventListener('click', () => { const ed = _editModal && _editModal._editor; if (ed) { ed.focus(); } window.find(fi.value); });
  fb2.addEventListener('click', () => { const ed = _editModal && _editModal._editor; if (ed) { ed.focus(); } window.find(fi2.value); });
  rb.addEventListener('click', () => { const ed = _editModal && _editModal._editor; if (ed) { ed.focus(); } document.execCommand('insertText', false, ri.value); });
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    _frDrag = { sx: e.clientX, sy: e.clientY, ox: _frModal.offsetLeft, oy: _frModal.offsetTop };
    e.preventDefault();
    const mv = (ev) => { if (!_frDrag) return; _frModal.style.left = (_frDrag.ox + ev.clientX - _frDrag.sx) + 'px'; _frModal.style.top = (_frDrag.oy + ev.clientY - _frDrag.sy) + 'px'; };
    const up = () => { _frDrag = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  return _frModal;
}
function openFindModal(tab) {
  const m = frEl(); m.classList.add('active');
  m.querySelectorAll('.eph-fr-tab').forEach((b) => b.classList.remove('active'));
  const t = tab === 'replace' ? m.querySelectorAll('.eph-fr-tab')[1] : m.querySelectorAll('.eph-fr-tab')[0];
  if (t) t.classList.add('active');
  const findSec = m.querySelectorAll('.eph-fr-body > div')[0];
  const replaceSec = m.querySelectorAll('.eph-fr-body > div')[1];
  findSec.style.display = tab === 'replace' ? 'none' : 'block';
  replaceSec.style.display = tab === 'replace' ? 'block' : 'none';
}

// ===== 规则弹窗 =====
let _rulesModal = null;
function rulesEl() {
  if (_rulesModal && _rulesModal.parentNode) return _rulesModal;
  _rulesModal = el('div', 'eph-rules');
  const box = el('div', 'eph-rules-box');
  const hd = el('div', 'eph-rules-hd');
  const t = el('b'); t.textContent = '规则设置';
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  hd.appendChild(t); hd.appendChild(close);
  const body = el('div', 'eph-rules-body');
  const sec1 = el('div', 'eph-rule-sec'); sec1.appendChild(el('div', 'eph-rule-title')).textContent = '@媒体引用规则';
  [
    ['MiniMax H3', '前端显示 <code>@图片1</code> / <code>@视频1</code> / <code>@音频1</code>，提交时编译为 <code>&lt;Picture 1&gt;</code> / <code>&lt;Video 1&gt;</code> / <code>&lt;Audio 1&gt;</code> 尖括号标签'],
    ['Seedance', '使用 <code>@图片1</code>、<code>@视频1</code>、<code>声音参考音频1</code>，单次最多 30 图 + 10 视频 + 10 音频'],
    ['Wan', '使用 <code>@Video1</code> / <code>@Video2</code> 等标签引用参考视频'],
    ['Krea 2', '官方使用 <code>image_style_references</code> 数组，每个参考图片可设置 strength（范围 -2 到 2）'],
  ].forEach(([a, b]) => { const c = el('div', 'eph-rule-card'); c.innerHTML = `<strong>${a}</strong><p>${b}</p>`; sec1.appendChild(c); });
  const sec2 = el('div', 'eph-rule-sec'); sec2.appendChild(el('div', 'eph-rule-title')).textContent = '时间戳规则';
  [
    ['MiniMax H3', '<code>[Shot 1]</code> 开头不加时间戳，后续 <code>[Shot 2] At 00:03.500, ...</code>，切点须严格递增'],
    ['Seedance', '官方格式为 <code>0-5s:</code> / <code>6-10s:</code> / <code>11-20s:</code>，每段须同时交代镜头怎么动+主体做什么'],
    ['Wan 2.6', '多镜头模式使用 <code>[镜头 1] [0-5s]</code> / <code>[镜头 2] [5-10s]</code> 时间轴语法'],
    ['Seedance 2.5', '支持整秒时间戳 <code>[0s]</code>、<code>[2s]</code> 及区间 <code>0-3s</code>'],
  ].forEach(([a, b]) => { const c = el('div', 'eph-rule-card'); c.innerHTML = `<strong>${a}</strong><p>${b}</p>`; sec2.appendChild(c); });
  body.appendChild(sec1); body.appendChild(sec2);
  box.appendChild(hd); box.appendChild(body); _rulesModal.appendChild(box); document.body.appendChild(_rulesModal);
  close.addEventListener('click', () => _rulesModal.classList.remove('active'));
  _rulesModal.addEventListener('click', (e) => { if (e.target === _rulesModal) _rulesModal.classList.remove('active'); });
  return _rulesModal;
}

// ===== 面板 =====
function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'eph-shell');
  const root = el('div', 'eph-root');
  shell.appendChild(root);
  node._ezRoot = shell;
  const hd = el('div', 'eph-hd');
  const addBtn = el('button', 'eph-btn success'); addBtn.textContent = '＋ 新增提示词卡片';
  const rulesBtn = el('button', 'eph-btn'); rulesBtn.textContent = '规则设置';
  const count = el('span', 'eph-count'); count.textContent = '0 张';
  hd.appendChild(addBtn); hd.appendChild(rulesBtn); hd.appendChild(count);
  const list = el('div', 'eph-list');
  root.appendChild(hd); root.appendChild(list);
  root._count = count; root._list = list;
  addBtn.addEventListener('click', () => addCard(node));
  rulesBtn.addEventListener('click', () => rulesEl().classList.add('active'));
  // 键盘 Ctrl+F / Ctrl+H
  document.addEventListener('keydown', (e) => {
    const editOpen = _editModal && _editModal.classList.contains('active');
    if (!editOpen) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); openFindModal('find'); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'h') { e.preventDefault(); openFindModal('replace'); }
  });
  refreshUI(node);
  return shell;
}
function fitNode(node) {
  try {
    const root = node && node._ezRoot && node._ezRoot.querySelector('.eph-root');
    if (!root || typeof node.setSize !== 'function') return;
    const cur = node.size || [0, 96];
    const contentH = root.scrollHeight + 12;
    if (contentH > cur[1] + 4) node.setSize([Math.max(380, cur[0]), Math.min(560, contentH)]);
  } catch (_) {}
}
function refreshUI(node) {
  const root = node && node._ezRoot;
  if (!root) return;
  const count = root.querySelector('.eph-count');
  if (count) count.textContent = `${stateFor(node).cards.length} 张`;
  renderCards(node);
}

// ===== 挂载 =====
function hideConfigWidget(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && _in.name === 'config') { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}
  const w = configWidget(node); if (!w || node._ezPhCfgHid) return; node._ezPhCfgHid = true;
  try {
    w.origComputeSize = w.computeSize; w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0;
    w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
  } catch (_) {}
}
function setupNode(node) {
  if (!node || node._ezPhSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') return;
    node._ezPhSetup = true;
    loadFromConfig(node);
    const root = buildRoot(node);
    node._ezRoot = root;
    makeDomWidgetHitThrough(root);
    const widget = node.addDOMWidget('提示词卡片', 'eph-panel', root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 120, getValue: () => '{}', setValue: () => {} });
    makeDomWidgetHitThrough(widget.element || root);
    node.widgets_start_y = 0;
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
    installResizeHandles(node, root);
    try { node.setSize([430, Math.max(150, node.size ? node.size[1] : 150)]); } catch (_) {}
    hideConfigWidget(node);
    updatePorts(node, true);
    setTimeout(() => updatePorts(node), 80);
  } catch (e) { console.error('[PromptHelper] init failed:', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__ezPhHooked) return; nt.__ezPhHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = prevCfg ? prevCfg.apply(this, arguments) : undefined; loadFromConfig(this); updatePorts(this, true); refreshUI(this); return r; };
  const prevConn = nt.prototype.onConnectionsChange; nt.prototype.onConnectionsChange = function (type, index, connected, link_info) {
    const r = prevConn ? prevConn.apply(this, arguments) : undefined;
    try { if (this._ezPhSetup) setTimeout(() => updatePorts(this), 0); } catch (_) {}
    return r;
  };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; unregisterNode(this); try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {} this._ezPhSetup = false; return r; };
  const prevAdded = nt.prototype.onAdded; nt.prototype.onAdded = function () { const r = prevAdded ? prevAdded.apply(this, arguments) : undefined; registerNode(this); return r; };
}
app.registerExtension({
  name: 'Comfy.EzFlex.PromptHelper',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() { ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); },
});
