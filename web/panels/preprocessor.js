// 面板：ControlnetPreprocessor 面板：预处理器卡片与参数
// EzFlex-ControlnetPreprocessor：把 comfyui_controlnet_aux 的预处理器做成「卡片列表」。
// 一张卡 = 一个预处理器实例 = 一对 输入 / 输出 端口；参数存 config（随工作流序列化）。
// 预设 = 整套卡片快照，存后端（/ezflex_prep/presets，复用 _register_preset_routes）。
// 卡片样式 + 拖拽插入横线：参考 prompt_helper.js 的 .eph-card / .eph-ph / attachDnD。
import { app } from "../../../scripts/app.js";
import { ezApplyDefaultSize, NODE_TYPES, nodeTypeOf, installResizeHandles, makeDomWidgetHitThrough, installEdgeLabels,
         readConfig, writeConfig, uiPrompt, uiConfirm, ezPruneDanglingLinks, ezPanelState, hideNativeSlotText } from "../core/ezflex_service.js";
import { ezT, ezLocale, onLocaleChange } from "../core/ezflex_i18n.js";
import { ezThemeInit } from "../core/ezflex_theme.js";

const PREP = NODE_TYPES.PREPROCESSOR;
const CAT_API = "/ezflex_prep/nodes";
const OUT_API = "/ezflex_prep/outputs";
const PRESET_API = "/ezflex_prep/presets";
const MIN_W = 450;
const CARD_COLOR = "#2f8f5b";
// 后端只声明 image_1..64（__init__.py: _EZ_PREP_MAX = 64）：超过的输入口在后端根本不存在，
// 对应卡片会静默拿到 None。这里只提示，不裁口 —— 裁口会把用户已连的线一起剪掉。
const MAX_IN = 64;
// 折叠用的「钝角」大三角（14×9 宽扁形，顶点角 >100°）。下拉框那边不要三角了。
const SVG_CHEV = '<svg viewBox="0 0 14 9" width="14" height="9" aria-hidden="true"><path d="M1.4 3.1 L7 6.9 L12.6 3.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CSS = `
.ezpp-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezpp-shell .ezpp-root{pointer-events:auto;}
.ezpp-root{position:absolute;inset:0 14px 14px 14px;font-family:inherit;color:var(--ez-fg);background:var(--ez-bg);border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;min-width:0;min-height:0;overflow:hidden;}
/* 工具条：永远一行（不换行；放不下就压缩，不折行） */
.ezpp-tb{display:flex;align-items:center;gap:5px;flex:0 0 auto;flex-wrap:nowrap;padding-bottom:6px;border-bottom:1px solid var(--ez-border-2);overflow:hidden;min-width:0;}
.ezpp-tb select,.ezpp-tb input{height:26px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font-family:inherit;font-size:12px;padding:0 6px;outline:none;box-sizing:border-box;min-width:0;}
.ezpp-preset{flex:0 0 auto;width:104px;min-width:64px;cursor:pointer;}
.ezpp-pname{flex:0 0 auto;width:70px;}
.ezpp-btn{height:26px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font-family:inherit;font-size:11px;padding:0 7px;cursor:pointer;flex:0 0 auto;white-space:nowrap;line-height:1;}
.ezpp-btn:hover{background:var(--ez-surface-3);}
.ezpp-btn.pri{background:var(--ez-strong);border-color:var(--ez-strong);color:var(--ez-on-strong);}
.ezpp-btn.pri:hover{filter:brightness(1.06);}
.ezpp-list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;}
.ezpp-hint{font-size:11px;color:var(--ez-fg-muted);padding:8px 4px;text-align:center;}
/* 卡片：仿 prompt_helper .eph-card（surface 底 + 10 圆角 + 10 间距） */
.ezpp-card{display:flex;flex-direction:column;background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:10px;overflow:hidden;flex:0 0 auto;min-width:0;}
.ezpp-card.dragging{opacity:.4;}
.ezpp-card.closed{border-style:dashed;}
.ezpp-hd{display:flex;align-items:center;gap:7px;padding:7px 10px;flex-wrap:nowrap;min-width:0;}
.ezpp-index{font-size:12px;font-weight:600;color:var(--ez-fg-3);width:18px;text-align:center;flex:0 0 auto;}
.ezpp-handle{cursor:grab;color:var(--ez-fg-muted);font-size:14px;line-height:1.5;width:16px;text-align:center;flex:0 0 auto;user-select:none;}
.ezpp-handle:hover{color:var(--ez-fg);}
.ezpp-handle:active{cursor:grabbing;}
.ezpp-type{display:flex;align-items:center;flex:0 0 auto;width:118px;min-width:0;text-align:left;height:26px;border:1px solid var(--ez-border);border-radius:8px;background:var(--ez-surface-2);color:var(--ez-fg);font-family:inherit;font-size:11px;padding:0 8px;cursor:pointer;}
.ezpp-type:hover{background:var(--ez-surface-3);}
.ezpp-type .n{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ezpp-type.empty .n{color:var(--ez-fg-muted);font-style:italic;}
.ezpp-name{flex:0 0 auto;width:84px;height:24px;border:none;border-bottom:1px dashed var(--ez-border);border-radius:0;background:transparent;color:var(--ez-fg);font:600 12px Inter,sans-serif;padding:0 3px;box-sizing:border-box;outline:none;text-align:left;text-overflow:ellipsis;}
.ezpp-name::placeholder{font-weight:400;color:var(--ez-fg-muted);}
.ezpp-name:focus{border-bottom-color:var(--ez-strong);}
/* 后半个卡片都是「展开/折叠」热区（含折叠三角），点哪都行 */
.ezpp-foldzone{flex:1 1 auto;min-width:26px;align-self:stretch;display:flex;align-items:center;justify-content:flex-end;cursor:pointer;border-radius:6px;padding:0 3px;}
.ezpp-foldzone:hover{background:var(--ez-surface-2);}
.ezpp-chev{color:var(--ez-fg-3);flex:0 0 auto;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;line-height:0;pointer-events:none;}
.ezpp-foldzone:hover .ezpp-chev{color:var(--ez-fg);}
.ezpp-chev svg{display:block;transition:transform .12s;}
.ezpp-x{background:transparent;border:none;color:var(--ez-fg-muted);font-size:15px;cursor:pointer;padding:1px 4px;flex:0 0 auto;line-height:1;margin-left:6px;}
.ezpp-x:hover{color:var(--ez-bad-fg);background:var(--ez-bad-bg);border-radius:6px;}
.ezpp-params{padding:2px 10px 9px 46px;display:flex;flex-direction:column;gap:5px;border-top:1px dashed var(--ez-border-2);}
.ezpp-card.closed .ezpp-params{display:none;}
.ezpp-row{display:flex;align-items:center;gap:6px;border-radius:6px;}
.ezpp-row:hover{background:var(--ez-surface-2);}
.ezpp-lab{font-size:11px;color:var(--ez-fg-3);min-width:100px;flex:0 0 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;}
.ezpp-row select,.ezpp-row input{flex:1 1 auto;min-width:0;height:24px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font-family:inherit;font-size:11px;padding:0 6px;box-sizing:border-box;outline:none;}
.ezpp-row input[type=number]{-moz-appearance:textfield;appearance:textfield;}
.ezpp-row input[type=number]::-webkit-outer-spin-button,.ezpp-row input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
/* 拖拽时的「即将插入」横线（仿 prompt_helper .eph-ph） */
.ezpp-ph{height:0;border-top:3px solid var(--ez-strong);border-radius:2px;margin:1px 0;opacity:.9;box-shadow:0 1px 6px rgba(43,58,74,.35);}
.ezpp-ph.hidden{display:none;}
.ezpp-menu{position:fixed;display:none;background:var(--ez-bg);border:1px solid var(--ez-border-strong);border-radius:8px;box-shadow:0 10px 30px rgba(20,30,60,.2);z-index:100120;max-height:60vh;overflow-y:auto;min-width:210px;padding:3px;}
.ezpp-mi{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;font-size:12px;color:var(--ez-fg);cursor:pointer;white-space:nowrap;}
.ezpp-mi:hover{background:var(--ez-surface-2);}
.ezpp-mi .n{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.ezpp-mi .c{font-size:10px;color:var(--ez-fg-muted);font-family:ui-monospace,monospace;flex:0 0 auto;}
.ezpp-mi.on{background:var(--ez-strong);color:var(--ez-on-strong);}
.ezpp-tip{position:fixed;display:none;background:var(--ez-bg);border:1px solid var(--ez-border-strong);border-radius:8px;padding:7px 10px;font-size:11px;color:var(--ez-fg);z-index:100121;pointer-events:none;max-width:300px;line-height:1.6;box-shadow:0 8px 24px rgba(20,30,60,.18);}
.ezpp-mi.dis{opacity:.45;cursor:default;}
.ezpp-mi.dis:hover{background:transparent;}
`;

let _css = false;
function inject() {
  ezThemeInit();
  if (_css || !document.head) return;
  _css = true;
  const s = document.createElement("style"); s.textContent = CSS; document.head.appendChild(s);
}
function el(t, c, a) { const e = document.createElement(t); if (c) e.className = c; if (a) Object.keys(a).forEach((k) => e.setAttribute(k, a[k])); return e; }
function forceShell(node) {
  const p = node && node._ezppRoot; if (!p || !p.isConnected) return;
  const si = (t, prop, val) => { try { t.style.setProperty(prop, val, "important"); } catch (_) {} };
  si(p, "width", "100%"); si(p, "max-width", "100%"); si(p, "height", "100%"); si(p, "max-height", "100%"); si(p, "box-sizing", "border-box");
  if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) { si(p, "top", "var(--ezfx-vue-title,30px)"); si(p, "height", "calc(100% - var(--ezfx-vue-title,30px))"); si(p, "bottom", "auto"); }
}
function hideConfigWidget(node) {
  if (node._ezppCfgHid) return;
  node._ezppCfgHid = true;
  (node.widgets || []).forEach((w) => {
    if (!w || w.name !== "config") return;
    try {
      w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0; w.draw = () => {};
      w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
      w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
      if (w.element && w.element.style) { w.element.style.display = "none"; w.element.style.height = "0"; }
    } catch (_) {}
  });
}
function mount(node, title, build) {
  if (!node || node._ezppSetup) return;
  node._ezppSetup = true;
  inject();
  const shell = el("div", "ezpp-shell"); const root = el("div", "ezpp-root"); shell.appendChild(root);
  node._ezppRoot = shell;
  build(root);
  const widget = node.addDOMWidget(title, "ezpp__" + Math.random().toString(36).slice(2), shell,
    { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 160, getValue: () => "{}", setValue: () => {} });
  makeDomWidgetHitThrough(widget.element || shell);
  try { node.widgets_start_y = 0; } catch (_) {}
  try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
  installResizeHandles(node, shell);
  try { ezApplyDefaultSize(node, MIN_W, 220); } catch (_) {}
  hideConfigWidget(node);
  forceShell(node);
  let retry = 0; (function again() { forceShell(node); if (retry < 12) { retry += 1; setTimeout(again, 120); } })();
}

// ===== 状态 / 目录 =====
let _catalog = null;       // [{cat,label,labelZh,nodes:[{key,name,desc,params}]}]
let _catalogLoading = false;
const _byKey = {};         // key -> {name, desc, params, cat, label}

function indexCatalog(cats) {
  _catalog = cats || [];
  Object.keys(_byKey).forEach((k) => delete _byKey[k]);
  _catalog.forEach((c) => (c.nodes || []).forEach((n) => { _byKey[n.key] = Object.assign({ cat: c.cat, label: c.label, labelZh: c.labelZh }, n); }));
}
async function loadCatalog(node, rerender) {
  if (_catalog || _catalogLoading) return;
  _catalogLoading = true;
  try {
    // ⚠️ 必须包一层：直接 `const f = api.fetchApi` 会丢 this，调用即抛错（目录永远空）
    const r = await apiFetch(CAT_API);
    const j = await r.json();
    indexCatalog(j && j.cats);
  } catch (_) { indexCatalog([]); }
  _catalogLoading = false;
  if (rerender) { try { rerender(); } catch (_) {} }
}
function defParams(key) {
  const m = _byKey[key];
  const out = {};
  if (m) (m.params || []).forEach((p) => { out[p.name] = p.default; });
  return out;
}
// 卡片显示名：自定义名 > 预处理器显示名 > Card N
function nodeName(card, i) {
  const nm = String((card && card.name) || "").trim();
  if (nm) return nm;
  const m = _byKey[card && card.cls];
  return (m && m.name) || String((card && card.cls) || ("Card " + (i + 1)));
}
// ===== 端口模型：一卡 N 进 M 出 =====
// 卡片 → 输入/输出端口定义。catalog 没加载 / 卡片没选预处理器 ⇒ 回退 1 进 1 出（与后端 run() 同口径）。
function cardInPorts(card) {
  const m = _byKey[card && card.cls];
  const ins = m && Array.isArray(m.inputs) && m.inputs.length ? m.inputs : null;
  return ins || [{ name: "image", type: "IMAGE" }];
}
function cardOutPorts(card) {
  const m = _byKey[card && card.cls];
  const outs = m && Array.isArray(m.outputs) && m.outputs.length ? m.outputs : null;
  return outs || [{ name: "image", type: "IMAGE" }];
}
// 第 i 个（扁平）端口 → {card, i, port}；越界 ⇒ null
function ezPortAt(cards, i, isIn) {
  let k = 0;
  for (let ci = 0; ci < (cards || []).length; ci++) {
    const ports = isIn ? cardInPorts(cards[ci]) : cardOutPorts(cards[ci]);
    for (let pi = 0; pi < ports.length; pi++) {
      if (k === i) return { card: cards[ci], i: ci, port: ports[pi] };
      k += 1;
    }
  }
  return null;
}
function ezPortSlug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9_]+/g, "").trim(); }
// 端口名：入口 = <名>_<输入口名>；出口 = <名>_<输出口名小写>。「名」= 自定义名 > 预处理器显示名 > Card N。
function inPortName(card, i, port) {
  return nodeName(card, i) + "_" + (ezPortSlug(port && port.name) || "image");
}
function outPortName(card, i, port) {
  return nodeName(card, i) + "_" + (ezPortSlug(port && port.name) || "image");
}

function stateFor(node) {
  if (!node._ezpp) node._ezpp = { cards: [] };
  return node._ezpp;
}
function readState(node) {
  const st = stateFor(node);
  let cfg = {};
  try { cfg = readConfig(node) || {}; } catch (_) { cfg = {}; }
  const cards = Array.isArray(cfg.cards) ? cfg.cards.filter((c) => c && typeof c === "object") : [];
  st.cards = cards.map((c) => ({
    id: c.id || ("c" + Math.random().toString(36).slice(2, 9)),
    cls: String(c.cls || ""),
    name: String(c.name || ""),
    params: (c.params && typeof c.params === "object") ? Object.assign({}, c.params) : {},
    open: c.open === undefined ? true : !!c.open,
  }));
  return st.cards;
}
function syncToConfig(node) {
  const st = stateFor(node);
  try { writeConfig(node, { cards: st.cards }); } catch (_) {}
}

// ===== 端口 =====
function deferSync(node) {
  if (node._ezppDefer) return;
  node._ezppDefer = setTimeout(() => { node._ezppDefer = 0; try { if (node._ezppSync) node._ezppSync(); } catch (_) {} }, 400);
}
function linksReady(node) {
  for (const s of (node.inputs || [])) {
    if (s && s.link != null && !(node.graph && node.graph.links && node.graph.links[s.link])) return false;
  }
  return true;
}
function postNames(names) {
  try {
    apiFetch(OUT_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names }) }).catch(() => {});
  } catch (_) {}
}
// 当前所有输出口的名字（扁平；按节点上实际存在的输出口数算）
function currentOutNames(node) {
  const cards = stateFor(node).cards;
  const names = [];
  for (let i = 0; i < (node.outputs || []).length; i++) {
    const meta = ezPortAt(cards, i, false);
    names.push(meta ? outPortName(meta.card, meta.i, meta.port) : ("out_" + (i + 1)));
  }
  return names;
}
// 改名时别每敲一个字就发一次请求
function postNamesSoon(node) {
  if (node._ezppPostT) clearTimeout(node._ezppPostT);
  node._ezppPostT = setTimeout(() => {
    node._ezppPostT = 0;
    postNames(currentOutNames(node));
  }, 350);
}
function syncSockets(node, cards) {
  if (!linksReady(node)) { deferSync(node); return; }
  // ★ configure 顺序是「onConnectionsChange → 恢复 widgets_values → onConfigure」：
  //   这之前读 config 只有空 cards，若按空布局裁口会把已保存的端口和连线一起删掉。
  //   ⇒ 配置还没真正恢复、节点上却已有连线时先不裁，等 onConfigure 之后再来。
  if (!(cards && cards.length) && !node._ezppLoaded) {
    const hasLinks = (node.inputs || []).some((s) => s && s.link != null) || (node.outputs || []).some((o) => o && Array.isArray(o.links) && o.links.length);
    if (hasLinks) { deferSync(node); return; }
  }
  // 扁平端口表：每张卡的每个输入/输出口各占一个槽位（多输入/多输出卡会吃好几个）
  const inPorts = [], outPorts = [];
  (cards || []).forEach((card, i) => {
    cardInPorts(card).forEach((p) => inPorts.push({ card, i, port: p }));
    cardOutPorts(card).forEach((p) => outPorts.push({ card, i, port: p }));
  });
  // 后端只声明 64 个 image_i 口：多出来的卡片即使画了端口，内核也不会把值传进来（静默不跑）。
  // 这里就裁到 64，配合下面的 toast 告诉用户去拆节点（2026-11 复检 C-6）。
  const wantIn = Math.max(1, Math.min(MAX_IN, inPorts.length));
  const wantOut = Math.max(1, outPorts.length);
  if (inPorts.length > MAX_IN) {
    if (!node._ezppCapWarned) {
      node._ezppCapWarned = true;
      try { ezppToast(ezT('Too many preprocessor inputs: the backend accepts 64 ports per node, so the extra cards will not run. Split them into two nodes.')); } catch (_) {}
    }
  } else if (node._ezppCapWarned) {
    node._ezppCapWarned = false;   // 拆回 64 口以内就复位，下次再超限还会提示一次
  }
  // 输入口：多的从后往前摘
  let ins = node.inputs || [];
  for (let i = ins.length - 1; i >= wantIn; i--) { try { node.removeInput(i); } catch (_) { try { ins.splice(i, 1); } catch (_2) {} } }
  ins = node.inputs || [];
  for (let i = ins.length; i < wantIn; i++) node.addInput("image_" + (i + 1), "*");
  // 输出口：删之前先 prune 悬空线（否则越界 target_slot 会让整份工作流加载中止）
  let outs = node.outputs || [];
  if (outs.length > wantOut) {
    try { ezPruneDanglingLinks(node); } catch (_) {}
    for (let i = outs.length - 1; i >= wantOut; i--) { try { node.removeOutput(i); } catch (_) { try { outs.splice(i, 1); } catch (_2) {} } }
  }
  outs = node.outputs || [];
  for (let i = outs.length; i < wantOut; i++) node.addOutput("out_" + (i + 1), "*");
  const names = [];
  for (let i = 0; i < wantOut; i++) {
    const meta = outPorts[i];
    const nm = meta ? outPortName(meta.card, meta.i, meta.port) : ("out_" + (i + 1));
    names.push(nm);
    const o = (node.outputs || [])[i];
    if (o) { try { hideNativeSlotText(o); } catch (_) {} o.name = nm; try { o.color_on = o.color_off = o.color = CARD_COLOR; if (o.shape != null) o.shape = null; } catch (_) {} }
  }
  for (let i = 0; i < wantIn; i++) {
    const s = (node.inputs || [])[i];
    if (s) { try { hideNativeSlotText(s); } catch (_) {} try { s.color_on = s.color_off = s.color = CARD_COLOR; if (s.shape != null) s.shape = null; } catch (_) {} }
  }
  postNames(names);
  try { node.setDirtyCanvas(true, true); } catch (_) {}
}
// 改名实时刷新：只改名字，不增删端口（结构由 syncSockets 管）
function refreshPortNames(node) {
  const cards = stateFor(node).cards;
  for (let i = 0; i < (node.outputs || []).length; i++) {
    const meta = ezPortAt(cards, i, false);
    try { (node.outputs[i]).name = meta ? outPortName(meta.card, meta.i, meta.port) : ("out_" + (i + 1)); } catch (_) {}
  }
  postNamesSoon(node);
  try { if (node._ezEdgeUpdate) node._ezEdgeUpdate(); } catch (_) {}
  try { node.setDirtyCanvas(true, true); } catch (_) {}
}

// ===== 类型选择弹窗：分类 → 节点，**子菜单向右展开**（不原地替换）=====
let _menuA = null, _menuB = null, _tip = null;
function _ensureMenus() {
  if (!_menuA || !_menuA.parentNode) {
    _menuA = el("div", "ezpp-menu");
    document.body.appendChild(_menuA);
    _menuB = el("div", "ezpp-menu");
    document.body.appendChild(_menuB);
    document.addEventListener("pointerdown", (e) => {
      if (_menuA && !_menuA.contains(e.target) && _menuB && !_menuB.contains(e.target)) menuHide();
    }, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") menuHide(); }, true);
    // 窗口失焦（切到别的程序）也收起来。
    // ⚠️ 千万别用捕获期（第三参 true）：blur 不冒泡，但**捕获**会收到页面上任何元素失焦
    //    （比如点菜单时卡片里的 <input> 失焦）⇒ 菜单「点一下就没了」。
    window.addEventListener("blur", () => menuHide());
  }
  return [_menuA, _menuB];
}
function tipEl() {
  if (_tip && _tip.parentNode) return _tip;
  _tip = el("div", "ezpp-tip");
  document.body.appendChild(_tip);
  return _tip;
}
function menuHide() {
  if (_menuA) _menuA.style.display = "none";
  if (_menuB) _menuB.style.display = "none";
  if (_tip) _tip.style.display = "none";
}
function tipShow(text, e) {
  const t = tipEl();
  t.textContent = text || "";
  t.style.display = "block";
  t.style.left = Math.min((window.innerWidth || 1200) - 330, (e.clientX || 0) + 14) + "px";
  t.style.top = ((e.clientY || 0) + 16) + "px";
}
function tipHide() { if (_tip) _tip.style.display = "none"; }

function openTypeMenu(anchor, card, onPick) {
  const [A, B] = _ensureMenus();
  A.innerHTML = "";
  B.style.display = "none";
  if (!_catalog || !_catalog.length) {
    const r = el("div", "ezpp-mi");
    r.textContent = ezT("No preprocessors found (is comfyui_controlnet_aux installed?)");
    A.appendChild(r);
  }
  const showCat = (catShort) => {
    B.innerHTML = "";
    const cat = (_catalog || []).find((c) => c.cat === catShort);
    (cat ? cat.nodes : []).forEach((n) => {
      const row = el("div", "ezpp-mi" + (card.cls === n.key ? " on" : ""));
      const t = el("span", "n"); t.textContent = n.name || n.key;
      row.appendChild(t);
      const info = (n.name || n.key) + (n.desc ? ("\n" + n.desc) : "") +
        "\n" + ezT("Params") + ": " + ((n.params || []).map((p) => p.name).join(", ") || ezT("none"));
      row.addEventListener("mouseenter", (e) => tipShow(info, e));
      row.addEventListener("mousemove", (e) => tipShow(info, e));
      row.addEventListener("mouseleave", tipHide);
      row.addEventListener("click", (e) => { e.stopPropagation(); menuHide(); onPick(n.key); });
      B.appendChild(row);
    });
    // 紧贴 A 的右边展开；右边放不下就翻到 A 的左边
    const ra = A.getBoundingClientRect();
    B.style.display = "block";
    const wB = Math.max(210, B.offsetWidth || 210);
    let left = ra.right + 2;
    if (left + wB > (window.innerWidth || 1200) - 8) left = Math.max(8, ra.left - wB - 2);
    B.style.left = left + "px";
    B.style.top = Math.min(ra.top, Math.max(8, (window.innerHeight || 800) - 220)) + "px";
  };
  (_catalog || []).forEach((c) => {
    const row = el("div", "ezpp-mi");
    // 一级分类用英文（跟 Add-Node 列表一致）；中文放 title 里
    const n = el("span", "n"); n.textContent = c.label || c.cat;
    const k = el("span", "c"); k.textContent = "\u203a";
    if (c.labelZh) row.title = c.labelZh;
    row.appendChild(n); row.appendChild(k);
    // ★ 只有「点击」才展开右面板，鼠标划过不展开；展开后常驻（点画布/别处、Esc、失焦才收）
    row.addEventListener("click", (e) => {
      e.stopPropagation(); tipHide();
      A.querySelectorAll(".ezpp-mi").forEach((x) => x.classList.remove("on"));
      row.classList.add("on");
      showCat(c.cat);
    });
    A.appendChild(row);
  });
  const r = anchor.getBoundingClientRect();
  A.style.display = "block";
  A.style.left = Math.min(r.left, Math.max(8, (window.innerWidth || 1200) - 230)) + "px";
  A.style.top = Math.min(r.bottom + 3, Math.max(8, (window.innerHeight || 800) - 220)) + "px";
  A.onmouseleave = () => { tipHide(); };
}

// ===== 右键菜单：打开模型文件夹 =====
// ★ 安全：后端只认「预处理器 key」，目录路径完全由服务端按固定映射算出（前端不传路径）⇒ 无路径注入面。
let _ezppCtx = null;
function ezppCtxHide() {
  if (_ezppCtx && _ezppCtx.parentNode) _ezppCtx.parentNode.removeChild(_ezppCtx);
  _ezppCtx = null;
  document.removeEventListener("pointerdown", _ezppCtxOut, true);
  document.removeEventListener("keydown", _ezppCtxEsc, true);
  window.removeEventListener("blur", ezppCtxHide);
}
function _ezppCtxOut(ev) { if (_ezppCtx && !_ezppCtx.contains(ev.target)) ezppCtxHide(); }
function _ezppCtxEsc(ev) { if (ev.key === "Escape") ezppCtxHide(); }
function ezppCtxShow(e, items) {
  ezppCtxHide();
  const m = el("div", "ezpp-menu");
  items.forEach((it) => {
    const row = el("div", "ezpp-mi" + (it.disabled ? " dis" : ""));
    const n = el("span", "n"); n.textContent = it.label; row.appendChild(n);
    if (!it.disabled) row.addEventListener("click", (ev) => { ev.stopPropagation(); ezppCtxHide(); try { it.fn(); } catch (_) {} });
    m.appendChild(row);
  });
  document.body.appendChild(m);
  m.style.display = "block";
  m.style.minWidth = "180px";
  m.style.left = Math.min(e.clientX, Math.max(8, (window.innerWidth || 1200) - 200)) + "px";
  m.style.top = Math.min(e.clientY, Math.max(8, (window.innerHeight || 800) - 140)) + "px";
  _ezppCtx = m;
  setTimeout(() => {
    if (!_ezppCtx) return;
    document.addEventListener("pointerdown", _ezppCtxOut, true);
    document.addEventListener("keydown", _ezppCtxEsc, true);
    window.addEventListener("blur", ezppCtxHide);   // ⚠️ 别加捕获期：否则面板里 input 失焦就把菜单收掉
  }, 0);
}
function ezppToast(msg) {
  const t = el("div");
  t.style.cssText = "position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:var(--ez-strong);color:var(--ez-on-strong);padding:8px 20px;border-radius:30px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.2);z-index:100130;opacity:0;transition:opacity .3s;pointer-events:none;";
  t.textContent = msg; document.body.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = "1"; });
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 400); }, 2200);
}
function openCardMenu(e, card) {
  const hasAux = !!(_catalog && _catalog.length);
  const items = [{ label: ezT("Open model folder"), disabled: !card || !card.cls, fn: () => openModelFolder(card) }];
  if (!hasAux) items.push({ label: ezT("Requires comfyui_controlnet_aux"), disabled: true, fn: () => {} });
  ezppCtxShow(e, items);
}
async function openModelFolder(card) {
  if (!card || !card.cls) { ezppToast(ezT("Pick a preprocessor first")); return; }
  if (!(_catalog && _catalog.length)) { ezppToast(ezT("Requires comfyui_controlnet_aux")); return; }
  let j = null;
  try {
    const r = await apiFetch("/ezflex_prep/open_model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cls: card.cls }) });
    j = await r.json();
  } catch (_) { ezppToast(ezT("Failed to open the folder")); return; }
  if (j && j.ok) { if (!j.exists) ezppToast(ezT("Model not downloaded yet — opened the nearest folder")); return; }
  const why = (j && j.reason) || "";
  if (why === "aux_missing") ezppToast(ezT("Requires comfyui_controlnet_aux"));
  else if (why === "unknown_preprocessor") ezppToast(ezT("This preprocessor is unavailable"));
  else ezppToast(ezT("Failed to open the folder"));
}

// ===== 预设 =====
// ⚠️ 统一入口：`app.api.fetchApi` 直接取引用会丢 this（插件里其它文件都包了一层箭头）
function apiFetch(path, opt) {
  if (app && app.api && typeof app.api.fetchApi === "function") return app.api.fetchApi(path, opt);
  return fetch(path, opt);
}
async function api(path, opt) {
  const r = await apiFetch(path, opt);
  return r.json();
}
async function refreshPresetSel(sel, node) {
  let items = [];
  try { const j = await api(PRESET_API); items = Array.isArray(j) ? j : (j.items || []); } catch (_) { items = []; }
  const cur = ezPanelState(node, "PrepPreset") || "";
  sel.innerHTML = "";
  const d = el("option"); d.value = ""; d.textContent = ezT("— Preset —"); sel.appendChild(d);
  items.forEach((p) => {
    const o = el("option"); o.value = p.name; o.textContent = p.name; if (p.name === cur) o.selected = true; sel.appendChild(o);
  });
  return items;
}
async function savePreset(node, sel, name) {
  const st = stateFor(node);
  if (!name) { uiPrompt(ezT("Preset name"), ezPanelState(node, "PrepPreset") || "").then((v) => { if (v) savePreset(node, sel, String(v).trim()); }); return; }
  try {
    const r = await api(PRESET_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, cards: st.cards }) });
    if (!r || r.ok === false) throw new Error('save failed');
  } catch (_) {
    try { ezppToast(ezT('Save failed') + ': ' + name); } catch (_) {}
    return;
  }
  ezPanelState(node, "PrepPreset", name);
  await refreshPresetSel(sel, node);
}
async function deletePreset(node, sel) {
  const name = sel.value || ezPanelState(node, "PrepPreset");
  if (!name) return;
  if (!(await uiConfirm(ezT("Delete this preset?") + " " + name))) return;
  try {
    const r = await api(PRESET_API + "/" + encodeURIComponent(name), { method: "DELETE" });
    if (!r || r.ok === false) throw new Error('delete failed');
  } catch (_) {
    try { ezppToast(ezT('Delete failed') + ': ' + name); } catch (_) {}
    return;
  }
  ezPanelState(node, "PrepPreset", "");
  await refreshPresetSel(sel, node);
}
async function loadPreset(node, sel, name, rerender) {
  if (!name) return;
  let items = [];
  try { items = await api(PRESET_API); } catch (_) {}
  const p = (items || []).find((x) => x.name === name);
  if (!p) return;
  const st = stateFor(node);
  st.cards = (Array.isArray(p.cards) ? p.cards : []).map((c) => ({
    id: c.id || ("c" + Math.random().toString(36).slice(2, 9)),
    cls: String(c.cls || ""), name: String(c.name || ""),
    params: (c.params && typeof c.params === "object") ? Object.assign({}, c.params) : {},
    open: c.open === undefined ? true : !!c.open,
  }));
  ezPanelState(node, "PrepPreset", name);
  syncToConfig(node);
  rerender();
}

// ===== 拖拽排序（插入横线提示，仿 prompt_helper.attachDnD）=====
function attachDnD(container, itemSel, handleSel, onDrop) {
  container.querySelectorAll(".ezpp-ph").forEach((x) => x.remove());
  const ph = el("div", "ezpp-ph hidden");
  container.appendChild(ph);
  container.querySelectorAll(handleSel).forEach((h) => {
    if (h._ezDnD) return; h._ezDnD = true;
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const item = h.closest(itemSel);
      if (!item) return;
      const items = [...container.querySelectorAll(itemSel)];
      const idx = items.indexOf(item);
      if (idx < 0) return;
      const rect = item.getBoundingClientRect();
      const clone = item.cloneNode(true);
      clone.style.cssText = "position:fixed;pointer-events:none;width:" + rect.width + "px;opacity:.85;z-index:100140;border:2px solid var(--ez-strong);border-radius:10px;background:var(--ez-bg);box-shadow:0 8px 24px rgba(0,0,0,.12);top:" + rect.top + "px;left:" + rect.left + "px;transition:none;";
      document.body.appendChild(clone);
      const st = { idx, clone, moved: false, targetIdx: idx };
      item.classList.add("dragging");
      items.forEach((c) => { if (c !== item) c.style.opacity = "0.5"; });
      const onMove = (ev) => {
        if (!st) return;
        st.moved = true;
        st.clone.style.top = (ev.clientY - 20) + "px";
        const els = [...container.querySelectorAll(itemSel)];
        let insertIdx = els.length;
        for (let i = 0; i < els.length; i++) {
          const r = els[i].getBoundingClientRect();
          if (ev.clientY > r.top + r.height / 2) insertIdx = i + 1;
          else { insertIdx = i; break; }
        }
        const same = insertIdx === st.idx || insertIdx === st.idx + 1;
        ph.classList.toggle("hidden", same);
        if (!same) { if (insertIdx < els.length) els[insertIdx].before(ph); else els[els.length - 1].after(ph); }
        st.targetIdx = insertIdx;
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        if (!st) return;
        if (st.clone && st.clone.parentNode) st.clone.parentNode.removeChild(st.clone);
        ph.classList.add("hidden");
        items.forEach((c) => { c.style.opacity = ""; });
        const { idx: from, moved, targetIdx } = st;
        item.classList.remove("dragging");
        if (moved && targetIdx !== from && targetIdx !== from + 1) {
          let insert = targetIdx;
          if (insert > from) insert -= 1;
          onDrop(from, insert);
        }
      };
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
    });
  });
}

// ===== 渲染 =====
function setup(node) {
  mount(node, ezT("Preprocessor"), (root) => {
    root.addEventListener("mouseleave", () => { tipHide(); });
    const tb = el("div", "ezpp-tb"); root.appendChild(tb);
    const list = el("div", "ezpp-list"); root.appendChild(list);

    const rerender = () => render(node, tb, list, rerender);
    node._ezppRender = rerender;

    // 顶部工具条（永远一行）：预设下拉 + 预设名 + 保存 + 删除 + 新增 + 全部展开/收起
    const presetSel = el("select", "ezpp-preset", { title: ezT("Preset") });
    const nameInp = el("input", "ezpp-pname", { placeholder: ezT("Preset name") });
    const btnSave = el("button", "ezpp-btn", { type: "button", title: ezT("Save as preset") }); btnSave.textContent = ezT("Save");
    const btnDel = el("button", "ezpp-btn", { type: "button", title: ezT("Delete selected preset") }); btnDel.textContent = ezT("Delete");
    const btnAdd = el("button", "ezpp-btn pri", { type: "button", title: ezT("Add preprocessor") }); btnAdd.textContent = ezT("Add");
    const btnFold = el("button", "ezpp-btn", { type: "button", title: ezT("Expand / collapse all") });
    btnFold.textContent = ezT("Collapse all");
    node._ezppFold = btnFold;
    tb.appendChild(presetSel); tb.appendChild(nameInp); tb.appendChild(btnSave); tb.appendChild(btnDel); tb.appendChild(btnAdd); tb.appendChild(btnFold);

    presetSel.addEventListener("change", () => { loadPreset(node, presetSel, presetSel.value, rerender); });
    btnSave.addEventListener("click", () => savePreset(node, presetSel, (nameInp.value || "").trim()));
    btnDel.addEventListener("click", () => deletePreset(node, presetSel));
    btnAdd.addEventListener("click", () => {
      const st = stateFor(node);
      st.cards.push({ id: "c" + Math.random().toString(36).slice(2, 9), cls: "", name: "", params: {}, open: true });
      syncToConfig(node); rerender();
    });
    // 一个键搞定「全部展开 / 收起全部」：只要还有一张开着就全收，否则全开
    btnFold.addEventListener("click", () => {
      const st = stateFor(node);
      const anyOpen = st.cards.some((c) => c.open !== false);
      st.cards.forEach((c) => { c.open = !anyOpen; });
      syncToConfig(node); rerender();
    });

    refreshPresetSel(presetSel, node);
    loadCatalog(node, () => rerender());
    readState(node);
    rerender();
  });
  setTimeout(() => { try { hideConfigWidget(node); } catch (_) {} }, 60);
  if (!node._ezppPost) {
    node._ezppPost = true;
    try { ezApplyDefaultSize(node, MIN_W, 220); } catch (_) {}
    installEdgeLabels(node, { side: "both", rootOf: (n) => n._ezppRoot, labelOf: (s, i, isIn) => {
      const cards = stateFor(node).cards;
      if (isIn) {
        if (!/^image_\d+$/.test(String(s && s.name))) return "";
        const meta = ezPortAt(cards, i, true);
        return meta ? inPortName(meta.card, meta.i, meta.port) : "";
      }
      const meta = ezPortAt(cards, i, false);
      return meta ? outPortName(meta.card, meta.i, meta.port) : "";
    } });
  }
}

function render(node, tb, list, rerender) {
  const cards = readState(node);
  // 「全部展开/收起」按钮的文字跟着当前状态走
  try {
    const b = node._ezppFold;
    if (b) b.textContent = (cards.length && cards.every((c) => c.open === false)) ? ezT("Expand all") : ezT("Collapse all");
  } catch (_) {}
  // 端口（先同步结构，再画卡片）
  try { syncSockets(node, cards); } catch (_) {}
  node._ezppSync = () => { try { syncSockets(node, readState(node)); } catch (_) {} };

  list.innerHTML = "";
  if (!cards.length) {
    const h = el("div", "ezpp-hint");
    h.textContent = ezT("No cards yet — click \"Add\" above.");
    list.appendChild(h);
  }
  cards.forEach((card, i) => list.appendChild(cardRow(node, card, i, list, rerender)));
  attachDnD(list, ".ezpp-card", ".ezpp-handle", (from, to) => {
    const st = stateFor(node);
    if (from < 0 || from >= st.cards.length) return;
    const before = st.cards.slice();
    const c = st.cards.splice(from, 1)[0];
    st.cards.splice(Math.max(0, Math.min(to, st.cards.length)), 0, c);
    // 端口跟着卡片走：预处理器是扁平端口表（一张卡可能占多个槽位），按 (cardId, portIndex) 算位置置换。
    try {
      const bIn = flatPortKeys(before, true), aIn = flatPortKeys(st.cards, true);
      const bOut = flatPortKeys(before, false), aOut = flatPortKeys(st.cards, false);
      const pIn = aIn.map((k) => bIn.indexOf(k)), pOut = aOut.map((k) => bOut.indexOf(k));
      if (pIn.every((x) => x >= 0) && pOut.every((x) => x >= 0)) permuteFlatLinks(node, pIn, pOut);
    } catch (_) {}
    syncToConfig(node);
    rerender();
  });
}

// 扁平端口表的位置置换：一张卡可能有多个输入/输出口，所以按 (cardId, portIndex) 生成键。
function flatPortKeys(cards, isIn) {
  const out = [];
  (cards || []).forEach((card) => {
    const ps = isIn ? cardInPorts(card) : cardOutPorts(card);
    (ps || []).forEach((p, pi) => out.push(String(card.id) + ":" + pi));
  });
  return out;
}
// 拖拽排序后把连线搬到对应口上（同 split_video 的 permutePorts，只是这里没有固定的 0 号口）。
// perm[新位置] = 旧位置；新前端的 socket.links 只是兼容视图，只改 link 的 target_slot/origin_slot。
function permuteFlatLinks(node, permIn, permOut) {
  const g = node && node.graph;
  if (!g || !g.links) return;
  const store = g.links instanceof Map;
  const ins = node.inputs || [];
  const oldIn = ins.map((s) => (s && s.link != null ? s.link : null));
  const inMoves = [];
  permIn.forEach((src, i) => {
    const lid = src >= 0 ? oldIn[src] : null;
    if (lid != null && ins[i]) inMoves.push({ s: ins[i], lid: lid, i: i });
  });
  if (!store) ins.forEach((s) => { if (s) s.link = null; });
  if (store) {   // 先挪到不存在的临时槽，否则两条线抢同一个输入槽会被 updateEndpoint 拒绝
    const tmp = ins.length + 1;
    inMoves.forEach((m, k) => { const lk = g.links[m.lid]; if (lk) { try { lk.target_slot = tmp + k; } catch (_) {} } });
  }
  inMoves.forEach((m) => {
    if (!store) { try { m.s.link = m.lid; } catch (_) {} }
    const lk = g.links[m.lid];
    if (lk) { try { lk.target_id = node.id; lk.target_slot = m.i; } catch (_) {} }
  });
  const outs = node.outputs || [];
  const oldOut = outs.map((s) => {
    const a = []; if (s && Array.isArray(s.links)) a.push(...s.links); if (s && s.link != null) a.push(s.link);
    return a;
  });
  permOut.forEach((src, i) => {
    const s = outs[i];
    if (!s) return;
    const ls = (src >= 0 && oldOut[src]) ? oldOut[src] : [];
    if (!store) { try { s.links = ls.length ? ls.slice() : null; } catch (_) {} }
    ls.forEach((lid) => { const lk = g.links[lid]; if (lk) { try { lk.origin_id = node.id; lk.origin_slot = i; } catch (_) {} } });
  });
}

function cardRow(node, card, i, list, rerender) {
  const st = stateFor(node);
  const row = el("div", "ezpp-card");
  row.dataset.idx = String(i);
  const closed = card.open === false;
  if (closed) row.classList.add("closed");
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openCardMenu(e, card); });
  const hd = el("div", "ezpp-hd"); row.appendChild(hd);

  // 顺序：序号 → 六点拖手 → 预处理器下拉框 → 自定义名称 → 折叠 → ✕
  const no = el("span", "ezpp-index"); no.textContent = String(i + 1);
  const grip = el("span", "ezpp-handle", { title: ezT("Drag to reorder") }); grip.textContent = "\u283F";
  const typeBtn = el("button", "ezpp-type" + (card.cls ? "" : " empty"), { type: "button", title: ezT("Pick preprocessor") });
  const tName = el("span", "n");
  tName.textContent = card.cls ? ((_byKey[card.cls] && _byKey[card.cls].name) || card.cls) : ezT("— pick preprocessor —");
  typeBtn.appendChild(tName);
  const nameInp = el("input", "ezpp-name", { placeholder: ezT("Name"), title: ezT("Custom name (becomes the port name)") });
  nameInp.value = card.name || "";
  // 折叠热区：从自定义名称右边一直到 ✕ 前面，整块都能点（三角只是指示）
  const foldZone = el("div", "ezpp-foldzone", { title: ezT("Expand / collapse parameters") });
  const chev = el("span", "ezpp-chev");
  chev.innerHTML = SVG_CHEV;
  try { const sv = chev.querySelector("svg"); if (sv && closed) sv.style.transform = "rotate(-90deg)"; } catch (_) {}
  foldZone.appendChild(chev);
  foldZone.addEventListener("click", (e) => { e.stopPropagation(); card.open = closed; syncToConfig(node); rerender(); });
  const x = el("button", "ezpp-x", { type: "button", title: ezT("Remove card") }); x.textContent = "\u2715";

  hd.appendChild(no); hd.appendChild(grip); hd.appendChild(typeBtn); hd.appendChild(nameInp); hd.appendChild(foldZone); hd.appendChild(x);

  typeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openTypeMenu(typeBtn, card, (key) => {
      card.cls = key;
      card.params = defParams(key);
      syncToConfig(node); rerender();
    });
  });
  // ★ 实时：改名 → 输出端口名 + 黑框标签跟着变（不必等失焦）
  nameInp.addEventListener("input", () => {
    card.name = nameInp.value;
    syncToConfig(node);
    try { refreshPortNames(node); } catch (_) {}
  });
  nameInp.addEventListener("change", () => { card.name = nameInp.value; syncToConfig(node); try { refreshPortNames(node); } catch (_) {} });
  nameInp.addEventListener("keydown", (e) => { e.stopPropagation(); });
  x.addEventListener("click", () => {
    st.cards.splice(i, 1);
    syncToConfig(node); rerender();
  });

  // 参数
  if (card.cls) {
    const meta = _byKey[card.cls];
    const body = el("div", "ezpp-params"); row.appendChild(body);
    if (!meta) {
      const h = el("div", "ezpp-hint");
      h.textContent = ezT("This preprocessor is not available (comfyui_controlnet_aux missing?)");
      body.appendChild(h);
    } else if (!(meta.params || []).length) {
      const h = el("div", "ezpp-hint"); h.textContent = ezT("No parameters."); body.appendChild(h);
    } else {
      (meta.params || []).forEach((p) => {
        const r = el("div", "ezpp-row");
        // 中文界面显示中文参数名（悬停里带英文原名）；英文界面一律显示原名
        const zh = (ezLocale() === "zh") ? String(p.labelZh || "") : "";
        const lab = el("div", "ezpp-lab", { title: p.name }); lab.textContent = zh || p.name;
        r.appendChild(lab);
        // 悬停解释：优先用后端给的 desc，没有就退化成「名字 + 类型 + 范围」
        const rng = (p.min !== undefined || p.max !== undefined) ? ("  [" + (p.min !== undefined ? p.min : "") + " ~ " + (p.max !== undefined ? p.max : "") + "]") : "";
        const head = zh ? (zh + "  ·  " + p.name) : p.name;
        const info = head + "  (" + p.type + rng + ")\n" + (p.desc || ezT("No description."));
        r.addEventListener("mouseenter", (e) => tipShow(info, e));
        r.addEventListener("mousemove", (e) => tipShow(info, e));
        r.addEventListener("mouseleave", tipHide);
        const cur = (card.params && card.params[p.name] !== undefined) ? card.params[p.name] : p.default;
        if (p.type === "COMBO") {
          const sel = el("select");
          const onames = Array.isArray(p.optionNames) ? p.optionNames : null;
          (p.options || []).forEach((o, oi) => {
            const op = el("option"); op.value = o; op.textContent = (onames && onames[oi]) || o;
            if (String(cur) === o) op.selected = true; sel.appendChild(op);
          });
          sel.addEventListener("change", () => { card.params[p.name] = sel.value; syncToConfig(node); });
          r.appendChild(sel);
        } else if (p.type === "INT" || p.type === "FLOAT") {
          const inp = el("input"); inp.type = "number";
          if (p.min !== undefined) inp.min = String(p.min);
          if (p.max !== undefined) inp.max = String(p.max);
          if (p.step !== undefined) inp.step = String(p.step);
          inp.value = String(cur === undefined ? 0 : cur);
          inp.addEventListener("change", () => {
            let v = parseFloat(inp.value);
            if (!isFinite(v)) v = p.default;
            if (p.min !== undefined) v = Math.max(p.min, v);
            if (p.max !== undefined) v = Math.min(p.max, v);
            card.params[p.name] = (p.type === "INT") ? Math.round(v) : v;
            inp.value = String(card.params[p.name]);
            syncToConfig(node);
          });
          inp.addEventListener("keydown", (e) => e.stopPropagation());
          r.appendChild(inp);
        } else if (p.type === "BOOLEAN") {
          const sel = el("select");
          [["true", ezT("On")], ["false", ezT("Off")]].forEach(([v, t]) => { const op = el("option"); op.value = v; op.textContent = t; if (String(cur === undefined ? true : cur) === v) op.selected = true; sel.appendChild(op); });
          sel.addEventListener("change", () => { card.params[p.name] = (sel.value === "true"); syncToConfig(node); });
          r.appendChild(sel);
        } else {
          const inp = el("input"); inp.type = "text"; inp.value = String(cur === undefined ? "" : cur);
          inp.addEventListener("change", () => { card.params[p.name] = inp.value; syncToConfig(node); });
          inp.addEventListener("keydown", (e) => e.stopPropagation());
          r.appendChild(inp);
        }
        body.appendChild(r);
      });
    }
  }

  return row;
}

function hook(nt) {
  if (!nt || nt.__ezppHooked) return;
  nt.__ezppHooked = true;
  const pc = nt.prototype.onNodeCreated;
  nt.prototype.onNodeCreated = function () { const r = pc ? pc.apply(this, arguments) : undefined; setup(this); return r; };
  const pm = nt.prototype.onConfigure;
  nt.prototype.onConfigure = function () { this.__ezSizeRestored = true;
    const r = pm ? pm.apply(this, arguments) : undefined;
    try {
      forceShell(this);
      readState(this);
      this._ezppLoaded = true;   // widgets 已恢复：之后才允许按 config 裁口
      if (this._ezppSync) this._ezppSync();
      if (this._ezppRender) this._ezppRender();
    } catch (_) {}
    return r;
  };
  const pcn = nt.prototype.onConnectionsChange;
  nt.prototype.onConnectionsChange = function () {
    const r = pcn ? pcn.apply(this, arguments) : undefined;
    // 延到本轮 configure 结束（widgets_values 恢复之后）再同步端口，别在 onConnectionsChange 里按空 config 裁口
    const self = this;
    setTimeout(() => { try { if (self._ezppSync) self._ezppSync(); } catch (_) {} }, 0);
    return r;
  };
  const pr = nt.prototype.onRemoved;
  nt.prototype.onRemoved = function () {
    const r = pr ? pr.apply(this, arguments) : undefined;
    try { if (this._ezppRoot) this._ezppRoot.remove(); } catch (_) {}
    try { if (this._ezppDefer) clearTimeout(this._ezppDefer); } catch (_) {}
    try { if (this._ezppPostT) clearTimeout(this._ezppPostT); } catch (_) {}
    this._ezppSetup = false;
    return r;
  };
}

// 语言切换：画布上所有预处理器面板重画一遍（参数名要跟着中/英切）
onLocaleChange(() => {
  try {
    const g = (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
    ((g && g._nodes) || []).forEach((n) => { try { if (nodeTypeOf(n) === PREP && n._ezppRender) n._ezppRender(); } catch (_) {} });
  } catch (_) {}
});

app.registerExtension({
  name: "EzFlex.Preprocessor",
  async beforeRegisterNodeDef(nt, nd) {
    if (nd && nd.name === PREP) hook(nt);
  },
  nodeCreated(n) { if (nodeTypeOf(n) === PREP) setup(n); },
});
