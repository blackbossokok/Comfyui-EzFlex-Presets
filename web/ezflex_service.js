// EzFlex 控制节点共享模块：节点注册表 / 画布分组匹配 / node.mode 控制 / 预设库 API / 命名弹窗。
// 参考 rgthree Fast Groups Muter/Bypasser：分组按 颜色+标题正则 匹配，控制 = node.mode 0/2/4。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 判断当前是否处于「Nodes 2.0」（Vue 节点编辑器）模式。
// ComfyUI 用 setting `Comfy.VueNodes.Enabled` 控制；addDOMWidget 的 `canvasOnly` 需要据此取反：
//   - Vue 模式：canvasOnly = false（否则节点空白）
//   - 普通 LiteGraph 模式：canvasOnly = true（否则节点空白）
// 懒读取（节点 setup 时才调用），app.ui.settings 此时已就绪；失败默认按普通模式处理（true）。
window.__ezflexIsVueNodes = window.__ezflexIsVueNodes || (() => {
  try {
    return !!(app && app.ui && app.ui.settings && typeof app.ui.settings.getSettingValue === 'function'
      && app.ui.settings.getSettingValue('Comfy.VueNodes.Enabled'));
  } catch (_) { return false; }
});

export const NODE_TYPES = {
  GROUP: "EzFlex-NodeSwitchGroup",
  MASTER: "EzFlex-NodeSwitchMaster",
  MAIN: "EzFlex-MainControl",
  PARAM_CTRL: "EzFlex-ParamPresetControl",
  PARAM_OUT: "EzFlex-ParamPresetOutput",
  PREVIEW_ANY: "EzFlex-PreviewAny",
  COMBO: "EzFlex-ModelsCombo",
  LATENT: "EzFlex-FreeLatent",
  PROMPT_HELPER: "EzFlex-PromptHelper",
  MEDIA_LOADER: "EzFlex-MediaLoader",
  MEDIA_OUT: "EzFlex-MediaOut",
};

export const MODE_NUM = { on: 0, off: 2, bypass: 4 }; // LiteGraph.ALWAYS / NEVER / BYPASS
export const BASE_PRESETS = ["全部开启", "全部禁用", "全部绕过"];
export function isBasePreset(k) { return BASE_PRESETS.indexOf(k) >= 0; }

// ===== 节点注册表（按类型收集画布上的 EzFlex 控制节点实例）=====
const _registry = new Map(); // type -> Map<nodeId, node>
export function registerNode(node) {
  const type = nodeTypeOf(node);
  if (!type) return;
  let m = _registry.get(type);
  if (!m) { m = new Map(); _registry.set(type, m); }
  m.set(String(node.id), node);
  emit('ezflex:changed', type);
}
export function unregisterNode(node) {
  const type = nodeTypeOf(node);
  if (!type) return;
  const m = _registry.get(type);
  if (m) m.delete(String(node.id));
  emit('ezflex:changed', type);
}
const _TYPE_NAMES = new Set(Object.values(NODE_TYPES));
export function nodeTypeOf(node) {
  if (!node) return null;
  const t = node.type
    || (node.comfyClass)
    || (node.constructor && node.constructor.nodeData && node.constructor.nodeData.name);
  return _TYPE_NAMES.has(t) ? t : null;
}
export function nodesOfType(type) {
  const m = _registry.get(type);
  const reg = m ? [...m.values()] : [];
  // 也扫描画布上未被 registerNode 登记的节点（如 ModelsCombo / FreeLatent -> 供 MainControl 发现）
  try {
    const graph = (app && (app.canvas && app.canvas.getCurrentGraph ? app.canvas.getCurrentGraph() : (app.graph || null))) || null;
    const all = graph && graph._nodes ? graph._nodes : [];
    for (const n of all) {
      if (nodeTypeOf(n) === type && !reg.some((x) => String(x.id) === String(n.id))) reg.push(n);
    }
  } catch (_) {}
  return reg.sort((a, b) => (a.pos && b.pos) ? (a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0]) : 0);
}
export function findNodeById(id) {
  for (const m of _registry.values()) {
    const n = m.get(String(id));
    if (n) return n;
  }
  return null;
}

// ===== 轻量事件总线（节点注册/注销时广播，供 Master/Main 刷新行、Output 刷新端口）=====
const _bus = {};
export function on(evt, fn) { (_bus[evt] = _bus[evt] || []).push(fn); }
export function emit(evt, arg) { (_bus[evt] || []).forEach((fn) => { try { fn(arg); } catch (_) {} }); }

// ===== 画布分组匹配（参考 rgthree fast_groups_service / utils.js）=====
export function allGraphGroups() {
  const graph = (app.canvas && app.canvas.getCurrentGraph && app.canvas.getCurrentGraph()) || app.graph;
  const groups = [...(graph._groups || [])];
  (graph.subgraphs || []).forEach((g) => { if (g && g._groups) groups.push(...g._groups); });
  return groups;
}
export function groupNodes(group) {
  if (!group) return [];
  if (group._children && group._children.size) return [...group._children].filter((n) => n instanceof LGraphNode);
  if (Array.isArray(group.nodes) && group.nodes.length) return group.nodes.filter((n) => n instanceof LGraphNode);
  // _children 为空：画布边界法（节点中心在分组矩形内即算成员）
  const bb = group.getBounding ? group.getBounding() : [group._pos[0], group._pos[1], group._size[0], group._size[1]];
  return ((group.graph && group.graph.nodes) || []).filter((n) => {
    const b = n.getBounding ? n.getBounding() : [n.pos[0], n.pos[1], n.size[0], n.size[1]];
    const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
    return cx >= bb[0] && cx < bb[0] + bb[2] && cy >= bb[1] && cy < bb[1] + bb[3];
  });
}
export function normalizeColor(c) {
  if (!c) return '';
  if (LGraphCanvas.node_colors[c]) c = LGraphCanvas.node_colors[c].groupcolor;
  c = c.replace('#', '').trim().toLowerCase();
  if (c.length === 3) c = c.replace(/(.)(.)(.)/, '$1$1$2$2$3$3');
  return '#' + c;
}
export function changeModeOfNodes(nodes, mode) {
  (nodes || []).forEach((n) => {
    n.mode = mode;
    if (n.graph) n.graph.setDirtyCanvas(true, true);
  });
  if (app.canvas) app.canvas.setDirty(true, true);
}

// ===== config widget 读写 =====
export function configWidget(node) {
  return (node.widgets || []).find((w) => w.name === 'config');
}
export function writeConfig(node, state) {
  const w = configWidget(node);
  if (!w) return;
  w.value = JSON.stringify(state);
  if (typeof w.callback === 'function') w.callback(w.value);
  if (node.graph) node.graph.setDirtyCanvas(true, true);
}
export function readConfig(node, fallback) {
  const w = configWidget(node);
  let cfg = {};
  try { cfg = JSON.parse(w ? w.value : '{}') || {}; } catch (_) { cfg = {}; }
  if (!cfg || typeof cfg !== 'object') cfg = {};
  if (fallback && typeof fallback === 'object') {
    Object.keys(fallback).forEach((k) => { if (cfg[k] === undefined) cfg[k] = fallback[k]; });
  }
  return cfg;
}

// ===== 预设库 API（服务器 user_data，按节点名共享）=====
export async function apiGet(path) { try { const r = await (api && api.fetchApi ? api.fetchApi(path) : fetch(path)); return r && r.ok ? await r.json() : []; } catch (_) { return []; } }
export async function apiPost(path, body) { try { await (api && api.fetchApi ? api.fetchApi(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) : fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })); } catch (_) {} }
export async function apiDelete(path) { try { await (api && api.fetchApi ? api.fetchApi(path, { method: 'DELETE' }) : fetch(path, { method: 'DELETE' })); } catch (_) {} }

const _libCache = new Map(); // apiPath -> [{name,...}]
export async function loadPresets(apiPath, force) {
  if (!force && _libCache.has(apiPath)) return _libCache.get(apiPath);
  const items = await apiGet(apiPath);
  const list = Array.isArray(items) ? items.filter((p) => p && p.name) : [];
  _libCache.set(apiPath, list);
  return list;
}
export async function savePreset(apiPath, payload) {
  await apiPost(apiPath, payload);
  _libCache.delete(apiPath);
  return loadPresets(apiPath, true);
}
export async function deletePreset(apiPath, name) {
  await apiDelete(apiPath + '/' + encodeURIComponent(name));
  _libCache.delete(apiPath);
  return loadPresets(apiPath, true);
}

// ===== 自绘节点缩放手柄（参考 FreeLatent：Pointer Events + window 捕获，拖拽直接改 node.size）=====
export function installResizeHandles(node, shell) {
  if (!shell || shell._ezHandles) return;
  // Vue（Nodes 2.0）模式：节点由 Vue 渲染，自绘手柄定位会错位；交给原生手柄处理。
  if (typeof window !== 'undefined' && window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) return;
  shell._ezHandles = true;
  try { shell.style.overflow = 'visible'; } catch (_) {}
  const mk = (style, cursor, title, z) => {
    const d = document.createElement('div');
    d.title = title;
    d.style.cssText = 'position:absolute;pointer-events:auto;z-index:' + (z || 30) + ';background:transparent;border:none;box-shadow:none;' + style + ';cursor:' + cursor + ';';
    shell.appendChild(d);
    return d;
  };
  // 只保留竖向(下缘左侧，底部无 socket) + 斜向(右下角)；去掉横向右缘手柄，避免压住输出 socket 拖线。
  // 宽度调整可拖右下角斜向手柄（横向移动即只改宽）。
  const height = mk('width:26px;height:14px;bottom:-8px;left:0;', 'ns-resize', '拖动调整高度', 30);
  const both = mk('width:22px;height:22px;right:-10px;bottom:-10px;border-radius:50%;', 'nwse-resize', '拖动调整宽高', 35);
  const start = (mode, e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const sz = node.size || [300, 120];
    const ow = sz[0], oh = sz[1];
    const sx = e.clientX, sy = e.clientY;
    const scale = (app.canvas && app.canvas.ds && app.canvas.ds.scale) || 1;
    const move = (ev) => {
      const dW = (ev.clientX - sx) / scale, dH = (ev.clientY - sy) / scale;
      let w = ow + (mode === 'height' ? 0 : dW);
      let h = oh + (mode === 'width' ? 0 : dH);
      w = Math.max(280, w); h = Math.max(120, h);
      try { node.setSize([w, h]); } catch (_) {}
      if (node.graph) node.graph.setDirtyCanvas(true, true);
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      if (node.graph) node.graph.setDirtyCanvas(true, true);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  };
  both.addEventListener('pointerdown', (e) => start('both', e));
  height.addEventListener('pointerdown', (e) => start('height', e));
}

// ===== DOM widget 面板穿透（修复 socket 圆点触发范围小）=====
// 有些 ComfyUI 前端会给 addDOMWidget 的元素写内联 `pointer-events:auto`，会覆盖样式类的 `none`，
// 导致面板仍挡住 socket 命中区。这里把面板元素（及其 `.dom-widget` 包裹层）改回 `none`，只保留真正
// 交互控件为 `auto`；并用一条常驻 CSS + 公共标记类，压住 ComfyUI 重渲染时写回的内联 `auto`。

let _socketPanelBaseCss = false;
function injectSocketPanelBaseCSS() {
  if (_socketPanelBaseCss || !document.head) return;
  _socketPanelBaseCss = true;
  const s = document.createElement('style');
  s.textContent = `
.dom-widget.size-full:has(.ezfx-panel-shell){pointer-events:none!important;}
.lg-slot{position:relative!important;}
.lg-slot [slot-data]{position:relative!important;z-index:9999!important;}
.lg-slot [slot-data]::after{content:'';position:absolute;inset:var(--ezfx-socket-pad,-8px);pointer-events:auto;}
/* Vue（Nodes 2.0）：widget 容器 .lg-node-widgets 默认 pointer-events:auto，会挡住节点拖动。
   :has(.ezfx-is-vue) 只框定「包含本面板」的容器，置 none 让事件穿透到 lg-node(cursor-grab)，
   节点可整块拖动；控件仍有 pointer-events:auto。普通模式不命中这套类，不受影响。 */
.lg-node-widgets:has(.ezfx-is-vue){pointer-events:none!important;}
/* Vue：隐藏 EzFlex 节点四角缩放把手的视觉(对角斜线)，但保留缩放功能（不 disabled pointer-events，
   角落仍是可缩放热区，只是看不到图标） */
.lg-node:has(.ezfx-panel-shell) [class*="cursor-"][class*="-resize"]{opacity:0!important;}
/* Vue：隐藏 EzFlex 节点原生 socket 文字（圆点与面板间的残留字），只藏文本容器、不藏圆点 */
.lg-node:has(.ezfx-panel-shell) .lg-slot .flex.h-full.min-w-0,
.lg-node:has(.ezfx-panel-shell) .lg-slot span.truncate{display:none!important;}
/* Vue：面板体（各节点 .*-root）也穿透，节点可整块拖；按钮/下拉/输入/文本域保持可交互。 */
.ezfx-is-vue [class*="-root"]{pointer-events:none!important;}
.ezfx-is-vue [class*="-root"] button,.ezfx-is-vue [class*="-root"] select,.ezfx-is-vue [class*="-root"] input,.ezfx-is-vue [class*="-root"] textarea{pointer-events:auto!important;}
/* Vue：加宽面板(左右 inset 缩小)，让不透明白面板遮住原生 socket label，只在外缘留圆点可拖；
   不再靠隐藏 slot 内部(那条会把圆点一起藏掉) */
.ezfx-is-vue [class*="-root"]{left:var(--ezfx-vue-side,10px)!important;right:var(--ezfx-vue-side,10px)!important;}
/* Vue：面板 shell 带 h-full(100% 高)，直接 top 下移会让底溢出节点。
   改为 top 下移 + height 减去等量，让面板正好落在标题下方、底边齐平节点。
   --ezfx-vue-title 可在 DevTools 里调(document.documentElement.style.setProperty('--ezfx-vue-title','40px')) */
.ezfx-is-vue[class*="-shell"]{top:var(--ezfx-vue-title,30px)!important;height:calc(100% - var(--ezfx-vue-title,30px))!important;bottom:auto!important;}
`;
  document.head.appendChild(s);
  try { enlargeSocketHitArea(); } catch (_) {}
}

function _applyPanelHitThrough(element) {
  if (!element) return;
  try { element.classList.add('ezfx-panel-shell'); } catch (_) {}
  try { if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) element.classList.add('ezfx-is-vue'); } catch (_) {}
  injectSocketPanelBaseCSS();
  try { element.style.setProperty('pointer-events', 'none', 'important'); } catch (_) {}
  try {
    let cur = element.parentElement;
    while (cur && cur !== document.body) {
      const cls = cur.className;
      if (typeof cls === 'string' && /dom[-_]widget/i.test(cls)) {
        cur.style.setProperty('pointer-events', 'none', 'important');
      }
      cur = cur.parentElement;
    }
  } catch (_) {}
  try { element.querySelectorAll('button,select,input,textarea').forEach((x) => { try { x.style.setProperty('pointer-events', 'auto', 'important'); } catch (_) {} }); } catch (_) {}
}

export function makeDomWidgetHitThrough(element) { _applyPanelHitThrough(element); }
export function applyDomHitThrough(element) { _applyPanelHitThrough(element); }

let _dlg = null;
export function uiPrompt(msg, def) {
  return new Promise((resolve) => {
    if (!_dlg || !_dlg.parentNode) {
      _dlg = document.createElement('div');
      _dlg.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100010;background:rgba(0,0,0,.35);';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;border:1px solid #d0d5dd;border-radius:10px;padding:14px;box-shadow:0 10px 34px rgba(0,0,0,.2);display:flex;flex-direction:column;gap:10px;min-width:280px;max-width:380px;font-family:Inter,sans-serif;';
      const lab = document.createElement('div'); lab.style.cssText = 'font-size:12px;color:#1a1a2e;';
      const input = document.createElement('input'); input.type = 'text';
      input.style.cssText = 'font-family:inherit;font-size:13px;padding:6px 9px;border:1px solid #d0d5dd;border-radius:7px;outline:none;width:100%;box-sizing:border-box;';
      const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
      const ok = document.createElement('button'); ok.textContent = '确定';
      const cancel = document.createElement('button'); cancel.textContent = '取消';
      [ok, cancel].forEach((b) => { b.style.cssText = 'font-family:inherit;font-size:12px;font-weight:500;cursor:pointer;padding:5px 14px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#1a1a2e;'; });
      ok.style.cssText += 'background:#34a853;border-color:#34a853;color:#fff;';
      row.appendChild(ok); row.appendChild(cancel);
      box.appendChild(lab); box.appendChild(input); box.appendChild(row);
      _dlg.appendChild(box); document.body.appendChild(_dlg);
      _dlg._input = input; _dlg._lab = lab; _dlg._ok = ok; _dlg._cancel = cancel;
    }
    const onOk = () => { _dlg.style.display = 'none'; resolve(_dlg._input.value); };
    const onCancel = () => { _dlg.style.display = 'none'; resolve(null); };
    _dlg._lab.textContent = msg;
    _dlg._input.value = def || '';
    _dlg._input.onkeydown = (e) => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    _dlg._ok.onclick = onOk; _dlg._cancel.onclick = onCancel;
    _dlg.style.display = 'flex';
    setTimeout(() => { try { _dlg._input.focus(); _dlg._input.select(); } catch (_) {} }, 0);
  });
}

// 内嵌确认弹窗（无输入框，返回 true/false）
let _confirm = null;
export function uiConfirm(msg) {
  return new Promise((resolve) => {
    if (!_confirm || !_confirm.parentNode) {
      _confirm = document.createElement('div');
      _confirm.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100010;background:rgba(0,0,0,.35);';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;border:1px solid #d0d5dd;border-radius:12px;padding:16px 18px;box-shadow:0 14px 44px rgba(0,0,0,.24);display:flex;flex-direction:column;gap:14px;min-width:300px;max-width:380px;font-family:Inter,sans-serif;';
      const lab = document.createElement('div'); lab.style.cssText = 'font-size:13px;color:#1a1a2e;line-height:1.5;word-break:break-all;';
      const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      const ok = document.createElement('button'); ok.textContent = '确定';
      const cancel = document.createElement('button'); cancel.textContent = '取消';
      [ok, cancel].forEach((b) => { b.style.cssText = 'font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;padding:6px 16px;border:1px solid #dce3ec;border-radius:10px;background:#fff;color:#1a1f2b;transition:all .12s;'; });
      ok.style.cssText += 'background:#ea4335;border-color:#ea4335;color:#fff;';
      cancel.addEventListener('mouseenter', () => { cancel.style.background = '#edf2fa'; });
      cancel.addEventListener('mouseleave', () => { cancel.style.background = '#fff'; });
      row.appendChild(ok); row.appendChild(cancel);
      box.appendChild(lab); box.appendChild(row);
      _confirm.appendChild(box); document.body.appendChild(_confirm);
      _confirm._lab = lab; _confirm._ok = ok; _confirm._cancel = cancel;
    }
    const onOk = () => { _confirm.style.display = 'none'; resolve(true); };
    const onCancel = () => { _confirm.style.display = 'none'; resolve(false); };
    _confirm._lab.textContent = msg;
    _confirm._ok.onclick = onOk; _confirm._cancel.onclick = onCancel;
    _confirm.style.display = 'flex';
  });
}

// ===== 新 socket 面板方案（V1.5 起）：面板居中 + 端口列穿透 + 隐藏端口文字 + 放大原生命中区 =====
// 不再用 modelscombo 的「黑框标签 + 自绘 SVG 拖线」。面板只占据节点中央，左右端口列完全穿透，
// 端口命中交给 ComfyUI 原生（LiteGraph canvas），并把 socket 命中半径调大，拖线更容易。

let _socketHitDone = false;
export function enlargeSocketHitArea(radius) {
  if (_socketHitDone) return;
  _socketHitDone = true;
  const R = Number(radius) > 0 ? Number(radius) : 14;
  const g = (typeof window !== 'undefined') ? window : globalThis;
  try { if (g.LiteGraph) { g.LiteGraph.SOCKET_RADIUS = R; if (g.LiteGraph.SLOT_RADIUS !== undefined) g.LiteGraph.SLOT_RADIUS = R; } } catch (_) {}
  const P = g.LGraphNode && g.LGraphNode.prototype;
  if (P && typeof P.get_socket_at === 'function') {
    const orig = P.get_socket_at;
    P.get_socket_at = function (pos, returnObj) {
      const hit = orig ? orig.call(this, pos, returnObj) : null;
      if (hit) return hit;
      try {
        const near = (s) => {
          if (!s) return false;
          const p = Array.isArray(s.pos) ? s.pos : null;
          if (!p) return false;
          const dx = (p[0] || 0) - (pos[0] || 0);
          const dy = (p[1] || 0) - (pos[1] || 0);
          return (dx * dx + dy * dy) <= R * R;
        };
        for (let i = 0; i < (this.inputs || []).length; i++) { if (near(this.inputs[i])) return returnObj ? this.inputs[i] : i; }
        for (let i = 0; i < (this.outputs || []).length; i++) { if (near(this.outputs[i])) return returnObj ? this.outputs[i] : i; }
      } catch (_) {}
      return null;
    };
  }
}

export function hideSocketNames(node) {
  if (!node) return;
  (node.inputs || []).forEach((i) => { try { i.label = ''; i.hideName = true; i.hidden = false; } catch (_) {} });
  (node.outputs || []).forEach((o) => { try { o.label = ''; o.hideName = true; o.hidden = false; } catch (_) {} });
}

// 内嵌面板基础布局 CSS：shell 全节点穿透；root 居中（左右留 SIDE=20px 端口列）；端口列绝对穿透。
export function socketPanelCSS(side) {
  const S = Number(side) > 0 ? Number(side) : 20;
  return `
.ezfx-sh-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezfx-sh-root{position:absolute;inset:0 ${S}px 0 ${S}px;box-sizing:border-box;pointer-events:auto;background:#fff;border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;font-family:Inter,sans-serif;color:#1a1a2e;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.ezfx-sh-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.ezfx-sh-strip{position:absolute;top:0;bottom:0;width:${S}px;pointer-events:none;z-index:2;}
.ezfx-sh-strip-l{left:0;}
.ezfx-sh-strip-r{right:0;}
`;
}

// ===== 统一自定义下拉（非破坏：隐藏原生 select，叠一个圆角按钮 + 自绘菜单，value/change 走原 select）=====
let _ezddInjected = false;
export function decorateSelect(sel) {
  if (!sel || sel.nodeName !== 'SELECT' || sel._ezdd) return sel;
  sel._ezdd = true;
  if (!_ezddInjected) {
    _ezddInjected = true;
    const st = document.createElement('style');
    st.textContent = '.ez-dd-wrap{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;}.ez-dd-btn{appearance:none;-webkit-appearance:none;min-width:120px;height:32px;padding:4px 30px 4px 12px;border:1px solid #dce3ec;border-radius:999px;background:#f7f9fd url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' stroke=\'%236b7a8e\' stroke-width=\'1.5\' fill=\'none\' stroke-linecap=\'round\'/%3E%3C/svg%3E") no-repeat right 13px center;font-size:12px;color:#1a1f2b;cursor:pointer;outline:none;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:inherit;}.ez-dd-btn:hover,.ez-dd-btn:focus{border-color:#2b3a4a;background-color:#fff;}.ez-dd-menu{display:none;position:absolute;top:35px;left:0;z-index:1200;min-width:160px;max-width:280px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:4px;max-height:260px;overflow:auto;}.ez-dd-menu.open{display:block;}.ez-dd-item{padding:6px 12px;font-size:12px;color:#1a1f2b;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:inherit;}.ez-dd-item:hover{background:#f3f5f9;}.ez-dd-item.active{background:rgba(43,58,74,.08);font-weight:600;color:#2b3a4a;}';
    document.head.appendChild(st);
  }
  const wrap = document.createElement('div'); wrap.className = 'ez-dd-wrap';
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ez-dd-btn';
  const menu = document.createElement('div'); menu.className = 'ez-dd-menu';
  const holder = sel.parentNode;
  if (!holder) return sel;
  holder.insertBefore(wrap, sel);
  sel.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:0;height:0;left:0;top:0;';
  wrap.appendChild(sel); wrap.appendChild(btn); wrap.appendChild(menu);
  const refresh = () => {
    btn.textContent = sel.value || (sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '');
    menu.innerHTML = '';
    if (!sel.options.length) { const e = document.createElement('div'); e.className = 'ez-dd-item'; e.textContent = '（无）'; e.style.color = '#94a3b8'; menu.appendChild(e); }
    for (let i = 0; i < sel.options.length; i++) {
      const o = sel.options[i]; const it = document.createElement('div'); it.className = 'ez-dd-item' + (o.selected ? ' active' : ''); it.textContent = o.textContent || o.value; it.dataset.v = o.value;
      it.addEventListener('click', () => { sel.value = o.value; try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {} refresh(); menu.classList.remove('open'); });
      menu.appendChild(it);
    }
  };
  sel.addEventListener('change', refresh);
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  document.addEventListener('click', () => { menu.classList.remove('open'); });
  refresh();
  return sel;
}
const _ddState = { roots: new Set(), ob: null };
export function decorateSelectsIn(root) {
  if (root && root.querySelectorAll) _ddState.roots.add(root);
  if (!_ddState.ob) {
    _ddState.ob = new MutationObserver((muts) => {
      muts.forEach((m) => m.addedNodes.forEach((n) => {
        const sels = n.nodeName === 'SELECT' ? [n] : (n.querySelectorAll ? Array.from(n.querySelectorAll('select')) : []);
        sels.forEach((s) => { if (!s._ezdd && _ddState.roots.size && [..._ddState.roots].some((r) => r.contains(s))) decorateSelect(s); });
      }));
    });
    _ddState.ob.observe(document.body, { childList: true, subtree: true });
  }
  const scope = (root && root.querySelectorAll ? root : document);
  scope.querySelectorAll('select').forEach((s) => { if (!s._ezdd) decorateSelect(s); });
}

export const TYPE_ICONS = {
  image: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="16" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M3 17l4-5 4 4 3-3 4 4"/></svg>',
  video: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>',
  audio: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="2" y="10" width="2.2" height="4" rx="1.1"/><rect x="5.5" y="7" width="2.2" height="10" rx="1.1"/><rect x="9" y="3" width="2.2" height="18" rx="1.1"/><rect x="12.5" y="8" width="2.2" height="8" rx="1.1"/><rect x="16" y="5" width="2.2" height="14" rx="1.1"/><rect x="19.5" y="9" width="2.2" height="6" rx="1.1"/></svg>',
  model_3d: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4.5v9L12 20l-8-4.5v-9L12 2z"/><path d="M12 2v9M4 6.5l8 4.5 8-4.5M12 20v-8.5"/></svg>',
  other: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M9 13h6M9 17h6"/></svg>',
  text: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M9 13h6M9 17h6"/></svg>',
};

let _apInjected = false;
export function makeAudioPlayer(url) {
  if (!_apInjected) {
    _apInjected = true;
    const st = document.createElement('style');
    st.textContent = '.ez-ap{display:flex;align-items:center;gap:8px;width:100%;background:#fff;border-radius:8px;padding:8px 10px;box-sizing:border-box;color:#1a1f2b;font-family:Inter,sans-serif;}.ez-ap button{background:none;border:none;color:#1a1f2b;font-size:14px;cursor:pointer;padding:0;line-height:1;font-family:inherit;}.ez-ap-time{font-size:12px;color:#6b7a8e;white-space:nowrap;flex:0 0 auto;font-variant-numeric:tabular-nums;}.ez-ap-track{flex:1 1 auto;height:6px;background:#eef1f6;border-radius:4px;position:relative;cursor:pointer;}.ez-ap-fill{position:absolute;left:0;top:0;bottom:0;background:#5f6b7a;border-radius:4px;width:0;}.ez-ap-vol{flex:0 0 auto;color:#1a1f2b;}';
    document.head.appendChild(st);
  }
  const wrap = document.createElement('div'); wrap.className = 'ez-ap';
  const audio = document.createElement('audio'); audio.src = url; audio.preload = 'metadata'; audio.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  const play = document.createElement('button'); play.type = 'button'; play.textContent = '▶'; play.title = '播放/暂停';
  const time = document.createElement('span'); time.className = 'ez-ap-time'; time.textContent = '0:00 / 0:00';
  const track = document.createElement('div'); track.className = 'ez-ap-track';
  const fill = document.createElement('div'); fill.className = 'ez-ap-fill'; track.appendChild(fill);
  const volBtn = document.createElement('button'); volBtn.type = 'button'; volBtn.className = 'ez-ap-vol'; volBtn.textContent = '🔊'; volBtn.title = '静音/取消静音';
  const volRange = document.createElement('input'); volRange.type = 'range'; volRange.min = '0'; volRange.max = '100'; volRange.value = '100'; volRange.title = '音量'; volRange.style.cssText = 'width:46px;height:4px;accent-color:#5f6b7a;';
  const fmt = (s) => { const m = Math.floor((s || 0) / 60), ss = Math.floor((s || 0) % 60); return m + ':' + String(ss).padStart(2, '0'); };
  play.addEventListener('click', () => { if (audio.paused) audio.play(); else audio.pause(); });
  audio.addEventListener('timeupdate', () => { if (isFinite(audio.duration) && audio.duration > 0) fill.style.width = Math.min(100, audio.currentTime / audio.duration * 100) + '%'; time.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration); });
  audio.addEventListener('loadedmetadata', () => { time.textContent = '0:00 / ' + fmt(audio.duration); });
  audio.addEventListener('play', () => { play.textContent = '❚❚'; });
  audio.addEventListener('pause', () => { play.textContent = '▶'; });
  track.addEventListener('click', (e) => { const r = track.getBoundingClientRect(); if (isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Math.max(0, Math.min(audio.duration, (e.clientX - r.left) / r.width * audio.duration)); });
  volBtn.addEventListener('click', () => { audio.muted = !audio.muted; volBtn.textContent = audio.muted ? '🔇' : '🔊'; volRange.value = audio.muted ? '0' : String(Math.round((audio.volume || 1) * 100)); });
  volRange.addEventListener('input', () => { audio.volume = Number(volRange.value) / 100; audio.muted = Number(volRange.value) === 0; volBtn.textContent = Number(volRange.value) === 0 ? '🔇' : '🔊'; });
  wrap.appendChild(audio); wrap.appendChild(play); wrap.appendChild(time); wrap.appendChild(track); wrap.appendChild(volBtn); wrap.appendChild(volRange);
  return wrap;
}
