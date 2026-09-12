// EzFlex-MainControl 总控制节点。
// 总预设 = { 目标节点 id -> { type, preset } } 的映射，目标是画布上的
// EzFlex-NodeSwitchMaster / EzFlex-ParamPresetControl 实例；应用时级联下推（写目标 config.current 并触发其应用）。
// 前端先按 NodeSwitchMaster 卡片样式实现，后续由用户迭代调整。
import { app } from "../../scripts/app.js";
import { ezT, onLocaleChange, ezLocale, ezSetLocale } from "./ezflex_i18n.js";
import {
  NODE_TYPES, isBasePreset,
  registerNode, unregisterNode, nodeTypeOf, nodesOfType,
  configWidget, writeConfig, readConfig,
  loadPresets, savePreset, deletePreset, uiPrompt, on, installResizeHandles, makeDomWidgetHitThrough,
  EZ_PERF, scheduleOnRedraw,
} from "./ezflex_service.js";

const NODE = NODE_TYPES.MAIN;
const API = "/main_control/presets";
const MAIN_DEFAULT = 'default';
// 卡片列表：只放「顶层」可控节点（节点开关组由节点总控制管理，不在这里单独列）
const TARGET_TYPES = [NODE_TYPES.COMBO, NODE_TYPES.LATENT, NODE_TYPES.MASTER, NODE_TYPES.PARAM_CTRL];
// 可加载节点（下拉 + 加载全部）：素材输出 MediaOut 不放（MediaLoader 已经能承接它的输出）
const SCAFFOLD_TYPES = [
  NODE_TYPES.COMBO, NODE_TYPES.LATENT, NODE_TYPES.MASTER, NODE_TYPES.GROUP,
  NODE_TYPES.PARAM_CTRL, NODE_TYPES.PARAM_OUT,
  NODE_TYPES.PROMPT_HELPER, NODE_TYPES.MEDIA_LOADER, NODE_TYPES.PREVIEW_ANY,
];
const SCAFFOLD_LABEL = {
  [NODE_TYPES.COMBO]: 'Models Combo Loader',
  [NODE_TYPES.LATENT]: 'Resolution / Latent Selector',
  [NODE_TYPES.MASTER]: 'Node Switch Master',
  [NODE_TYPES.GROUP]: 'Node Switch Group',
  [NODE_TYPES.PARAM_CTRL]: 'Param Preset Control',
  [NODE_TYPES.PARAM_OUT]: 'Param Preset Output',
  [NODE_TYPES.PROMPT_HELPER]: 'Prompt Helper',
  [NODE_TYPES.MEDIA_LOADER]: 'Media Loader',
  [NODE_TYPES.PREVIEW_ANY]: 'Preview Any',
};
// 加载全部的排布（以「总控制」自身为基准，间距 30px）：
//   左列（右缘对齐，右缘 = 总控制左缘 − 30）：素材加载器（底边与总控制平齐）→ 模型组合 → 提示词助手，依次下移 30px
//   中列（左缘 = 总控制左缘）：节点总控制、参数预设控制，自总控制底边 +30px 起依次下移 30px
//   右列（左缘 = 总控制右缘）：节点开关组、参数输出控制，同上
//   分辨率：总控制右侧 +30px、底部平齐；任意预览：参数输出控制右侧 +30px、底部平齐
const SCAFFOLD_GAP = 30;

// ⚠️ LiteGraph 的 node.pos 是「标题栏下沿」的左上角，标题栏画在 pos 上方（高 = LiteGraph.NODE_TITLE_HEIGHT，
// 与渲染时用的那个常数同源）。纵向推进量必须算上标题栏，否则下一个节点的标题会顶在上一个节点身上（贴在一起）。
// 标题高度只取这个常数，**不要用 node.getBounding()**：它读的是节点的 boundingRect，刚建出来还没测量时是脏值，
// 拿它会算出离谱的偏移，把整列节点排到屏幕外。
function visualBox(node) {
  const p = (node && node.pos) || [0, 0];
  const s = (node && node.size) || [300, 200];
  const y = Number(p[1]), w = Number(s[0]), h = Number(s[1]);
  return { x: Number(p[0]) || 0, y: isFinite(y) ? y : 0, w: isFinite(w) ? w : 300, h: isFinite(h) ? h : 200 };
}

function scaffoldLayout(mainBox, boxes) {
  const G = SCAFFOLD_GAP, TITLE = LiteGraph.NODE_TITLE_HEIGHT || 30;
  const out = new Map();
  const boxOf = (t) => boxes.get(t) || { w: 300, h: 200 };
  const putLeft = (t, x, visTop) => { const b = boxOf(t); out.set(t, [Math.round(x), Math.round(visTop + TITLE)]); };
  const putRight = (t, visRight, visTop) => { const b = boxOf(t); out.set(t, [Math.round(visRight - b.w), Math.round(visTop + TITLE)]); };
  const putBottom = (t, x, visBottom) => { const b = boxOf(t); out.set(t, [Math.round(x), Math.round(visBottom - b.h)]); };

  const mLeft = mainBox.x, mRight = mainBox.x + mainBox.w, mBottom = mainBox.y + mainBox.h;

  // 左列：素材加载器底边与总控制平齐，模型组合 / 提示词助手依次下移，三者右缘对齐
  const leftRight = mLeft - G;
  putBottom(NODE_TYPES.MEDIA_LOADER, leftRight - boxOf(NODE_TYPES.MEDIA_LOADER).w, mBottom);
  let visTop = mBottom;
  [NODE_TYPES.COMBO, NODE_TYPES.PROMPT_HELPER].forEach((t) => {
    const b = boxOf(t); visTop += G; putRight(t, leftRight, visTop); visTop += TITLE + b.h;
  });

  // 中列：总控制下方，左缘与总控制平齐
  visTop = mBottom;
  [NODE_TYPES.MASTER, NODE_TYPES.PARAM_CTRL].forEach((t) => {
    const b = boxOf(t); visTop += G; putLeft(t, mLeft, visTop); visTop += TITLE + b.h;
  });

  // 右列：总控制右缘下方（记录末节点右缘/底边，供「任意预览」对齐）
  visTop = mBottom;
  let colRight = mRight, colBottom = mBottom;
  [NODE_TYPES.GROUP, NODE_TYPES.PARAM_OUT].forEach((t) => {
    const b = boxOf(t); visTop += G; putLeft(t, mRight, visTop); visTop += TITLE + b.h; colRight = mRight + b.w; colBottom = visTop;
  });

  // 分辨率：总控制右侧、底边平齐；任意预览：参数输出控制右侧、底边平齐
  putBottom(NODE_TYPES.LATENT, mRight + G, mBottom);
  putBottom(NODE_TYPES.PREVIEW_ANY, colRight + G, colBottom);
  return out;
}

function addNodeToCanvas(type, x, y) {
  try {
    const n = LiteGraph.createNode(type);
    if (!n) return null;
    n.pos = [x, y];
    app.graph.add(n);
    if (app.canvas) app.canvas.setDirty(true, true);
    return n;
  } catch (_) { return null; }
}
function addOneScaffold(node, type) {
  const base = node.pos || [0, 0]; const bs = node.size || [300, 200];
  return addNodeToCanvas(type, base[0] + bs[0] + 20, base[1]);
}
function addAllScaffold(node) {
  const base = node.pos || [0, 0];
  const created = new Map();
  SCAFFOLD_TYPES.forEach((t) => { const n = addNodeToCanvas(t, base[0], base[1]); if (n) created.set(t, n); });
  if (!created.size) return 0;
  const apply = () => {
    const boxes = new Map();
    created.forEach((n, t) => { if (n) boxes.set(t, visualBox(n)); });
    const pos = scaffoldLayout(visualBox(node), boxes);
    created.forEach((n, t) => { const p = pos.get(t); if (n && p && isFinite(p[0]) && isFinite(p[1])) n.pos = p; });
    if (app.canvas) app.canvas.setDirty(true, true);
  };
  apply();
  // 各节点 DOM 面板高度下一帧才定型（fitNode 会按内容改高），稍后再按新尺寸对一次齐
  clearTimeout(node._ezScaffoldTimer);
  node._ezScaffoldTimer = setTimeout(apply, 350);
  return created.size;
}

const CSS = `
.ezc-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezc-shell .ezc-root{pointer-events:auto;}
.ezc-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:#1a1a2e;background:#fff;border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.ezc-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.ezc-hd{display:flex;gap:6px;align-items:center;flex-wrap:nowrap;}
.ezc-hd select{appearance:none;background:#f7f9fd url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7a8e' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 10px center;border:1px solid #dce3ec;border-radius:10px;padding:5px 28px 5px 12px;font-size:12px;font-weight:450;color:#1a1f2b;font-family:inherit;cursor:pointer;min-width:110px;height:30px;line-height:1;flex:1 1 auto;}
.ezc-hd select.ezc-hd-load{flex:0 1 160px;min-width:120px;}
.ezc-hd select:focus{border-color:#8fa7c5;outline:none;}
.ezc-btn{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:#1f2937;font-family:inherit;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;height:30px;line-height:1;}
.ezc-btn:hover{background:#edf2fa;border-color:#bcc9db;}
.ezc-btn.success{background:#ecfdf3;border-color:#a7f0c6;color:#065f46;}
.ezc-btn.success:hover{background:#d1fae5;}
.ezc-btn.danger{background:#fef2f2;border-color:#fecaca;color:#991b1b;}
.ezc-btn.danger:hover{background:#fee2e2;}
.ezc-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;}
.ezc-row{display:flex;gap:8px;align-items:center;padding:5px 8px;background:#fbfcfe;border:1px solid #eef2f8;border-radius:10px;flex-wrap:wrap;}
.ezc-row .gname{font-size:12px;font-weight:480;flex:1 1 90px;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1a1f2b;}
.ezc-row select{appearance:none;font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:9px;background:#f7f9fd url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7a8e' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 8px center;color:#1a1f2b;outline:none;padding:4px 24px 4px 10px;flex:1 1 100px;min-width:90px;max-width:170px;height:28px;line-height:1;}
.ezc-row select:focus{border-color:#8fa7c5;}
.ezc-handle{flex:0 0 auto;width:16px;color:#b8c0cc;cursor:grab;font-size:13px;text-align:center;user-select:none;}
.ezc-handle:hover{color:#5f6b7a;}
.ezc-ph{height:0;border-top:3px solid #2b3a4a;border-radius:2px;margin:1px 0;opacity:.9;box-shadow:0 1px 6px rgba(43,58,74,.35);}
.ezc-ph.hidden{display:none;}
.ezc-row.dragging{opacity:.6;}
.ezc-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:14px;}
`;

let _styleInjected = false;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }

// ===== 节点状态 =====
function stateFor(node) {
  if (!node._ezMain) node._ezMain = { current: MAIN_DEFAULT, cardOrder: [] };
  return node._ezMain;
}
function loadFromConfig(node) {
  const st = stateFor(node);
  const cfg = readConfig(node, {});
  st.current = (typeof cfg.current === 'string' && cfg.current) ? cfg.current : MAIN_DEFAULT;
  st.cardOrder = Array.isArray(cfg.cardOrder) ? cfg.cardOrder : [];
}
function syncToConfig(node) {
  writeConfig(node, { current: stateFor(node).current, cardOrder: stateFor(node).cardOrder });
}
function targetAPI(node) {
  // Master -> _ezMasterAPI；ParamPresetControl -> _ezParamAPI；ModelsCombo -> _ezComboAPI；FreeLatent -> _ezLatentAPI
  const t = nodeTypeOf(node);
  if (t === NODE_TYPES.MASTER) return node._ezMasterAPI || null;
  if (t === NODE_TYPES.PARAM_CTRL) return node._ezParamAPI || null;
  if (t === NODE_TYPES.COMBO) return node._ezComboAPI || null;
  if (t === NODE_TYPES.LATENT) return node._ezLatentAPI || null;
  return null;
}
async function findLibPreset(name) {
  const list = await loadPresets(API);
  return list.find((p) => p.name === name || p.label === name) || null;
}

async function applyPreset(node, name) {
  const st = stateFor(node);
  if (name === MAIN_DEFAULT) { st.current = MAIN_DEFAULT; syncToConfig(node); refreshUI(node); return true; }
  let targets = null;
  const p = await findLibPreset(name);
  if (!p) return false;
  targets = p.targets || {};
  for (const [id, spec] of Object.entries(targets)) {
    const target = nodesOfType(spec && spec.type).find((n) => String(n.id) === id) || null;
    const api = target && targetAPI(target);
    if (api && spec && spec.preset) {
      try { await api.setCurrent(spec.preset); } catch (_) {}
    }
  }
  st.current = name; syncToConfig(node); refreshUI(node);
  return true;
}
async function savePresetToLib(node) {
  const name = await uiPrompt(ezT('Enter a master preset name'), ezT('New master preset'));
  if (!name || !name.trim()) return;
  const targets = {};
  TARGET_TYPES.forEach((type) => {
    nodesOfType(type).forEach((n) => {
      const api = targetAPI(n);
      if (api) targets[String(n.id)] = { type, preset: api.current() || '全部开启' };
    });
  });
  await savePreset(API, { name: name.trim(), label: name.trim(), targets });
  stateFor(node).current = name.trim(); syncToConfig(node); refreshUI(node);
}
async function deletePresetFromLib(node) {
  const st = stateFor(node);
  if (isBasePreset(st.current) || st.current === MAIN_DEFAULT) return;
  await deletePreset(API, st.current);
  st.current = MAIN_DEFAULT; syncToConfig(node); refreshUI(node);
}

// ===== 实例 API（供其它控制器调用；预留）=====
function ensureAPI(node) {
  if (node._ezMainAPI) return;
  node._ezMainAPI = {
    presetNames: () => loadPresets(API).then((list) => [MAIN_DEFAULT].concat(list.map((p) => p.name))),
    setCurrent: (name) => applyPreset(node, name),
    current: () => stateFor(node).current,
    refresh: () => refreshUI(node),
  };
}

// ===== 渲染 =====
function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'ezc-shell');
  const root = el('div', 'ezc-root');
  shell.appendChild(root);
  node._ezRoot = shell;
  const hd = el('div', 'ezc-hd');
  const masterSel = el('select'); masterSel.title = ezT('Master preset');
  const saveBtn = el('button', 'ezc-btn success'); saveBtn.textContent = ezT('Save');
  const delBtn = el('button', 'ezc-btn danger'); delBtn.textContent = ezT('Delete');
  const loadSel = el('select', 'ezc-hd-load'); loadSel.title = ezT('Load a single node');
  const placeholder = el('option'); placeholder.value = ''; placeholder.textContent = ezT('— Load node —'); loadSel.appendChild(placeholder);
  SCAFFOLD_TYPES.forEach((t) => { const o = el('option'); o.value = t; o.textContent = ezT(SCAFFOLD_LABEL[t] || t); loadSel.appendChild(o); });
  const loadAllBtn = el('button', 'ezc-btn');
  // 语言切换：默认跟随 ComfyUI 语言，这里可手动覆盖（存 localStorage，全部面板共用）
  const langBtn = el('button', 'ezc-btn');
  langBtn.title = ezT('UI language (follows ComfyUI language by default; manual override is remembered on this machine)');
  const applyLang = () => {
    masterSel.title = ezT('Master preset');
    saveBtn.textContent = ezT('Save');
    delBtn.textContent = ezT('Delete');
    loadSel.title = ezT('Load a single node');
    placeholder.textContent = ezT('— Load node —');
    loadAllBtn.textContent = ezT('Load all');
    langBtn.textContent = ezLocale() === 'zh' ? 'EN' : '中文';
    SCAFFOLD_TYPES.forEach((t, i) => { const o = loadSel.options[i + 1]; if (o) o.textContent = ezT(SCAFFOLD_LABEL[t] || t); });
  };
  langBtn.addEventListener('click', () => { ezSetLocale(ezLocale() === 'zh' ? 'en' : 'zh'); applyLang(); });
  try { window.addEventListener('ezflex:locale', applyLang); } catch (_) {}
  hd.appendChild(masterSel); hd.appendChild(saveBtn); hd.appendChild(delBtn); hd.appendChild(loadSel); hd.appendChild(loadAllBtn); hd.appendChild(langBtn);
  applyLang();
  const list = el('div', 'ezc-list');
  root.appendChild(hd); root.appendChild(list);

  async function render() {
    const st = stateFor(node);
    const lib = await loadPresets(API);
    masterSel.innerHTML = '';
    const opts = [MAIN_DEFAULT].concat(lib.map((p) => p.name));
    if (opts.indexOf(st.current) < 0) { st.current = MAIN_DEFAULT; syncToConfig(node); }
    opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; masterSel.appendChild(o); });

    list.innerHTML = '';
    const targets = collectTargets(node);
    if (!targets.length) list.appendChild(el('div', 'ezc-empty')).textContent = ezT('No controllable nodes on the canvas yet (Models Combo Loader / Resolution / Node Switch Master / Param Preset Control). Click "Load all" in the top right to lay them out in one click.');
    targets.forEach((t) => { const row = renderRow(node, t.node); row._ezKey = t.key; list.appendChild(row); });
    attachCardDnD(list, node);
    fitNode(node);
  }

  masterSel.addEventListener('change', () => applyPreset(node, masterSel.value));
  masterSel.addEventListener('mousedown', () => refreshPresetOptions(node, masterSel));
  saveBtn.addEventListener('click', () => savePresetToLib(node));
  delBtn.addEventListener('click', () => deletePresetFromLib(node));
  loadSel.addEventListener('change', () => { const t = loadSel.value; if (t) { addOneScaffold(node, t); loadSel.value = ''; scheduleRefresh(); } });
  loadAllBtn.addEventListener('click', () => { addAllScaffold(node); scheduleRefresh(); });
  render();
  return shell;
}

async function refreshPresetOptions(node, sel) {
  const st = stateFor(node);
  const lib = await loadPresets(API, true);
  const opts = [MAIN_DEFAULT].concat(lib.map((p) => p.name));
  if (opts.indexOf(st.current) < 0) st.current = MAIN_DEFAULT;
  sel.innerHTML = '';
  opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; sel.appendChild(o); });
}

function renderRow(mainNode, targetNode) {
  const row = el('div', 'ezc-row');
  const handle = el('span', 'ezc-handle'); handle.textContent = '⠿'; handle.title = ezT('Drag to reorder');
  const name = el('span', 'gname'); name.textContent = targetNode.title || ezT('Node'); name.title = targetNode.title || '';
  const sel = el('select');
  const api = targetAPI(targetNode);
  const isOptional = nodeTypeOf(targetNode) === NODE_TYPES.COMBO || nodeTypeOf(targetNode) === NODE_TYPES.LATENT;
  const fill = async () => {
    const cur = api ? api.current() : '';
    const names = api ? (await api.presetNames()) : [];
    const sig = JSON.stringify(names) + (isOptional ? '|opt' : '');
    if (sel._ezSig === sig) { if (cur && sel.value !== cur && Array.from(sel.options).some((o) => o.value === cur)) sel.value = cur; return; }
    sel._ezSig = sig;
    sel.innerHTML = '';
    if (isOptional) { const ph = el('option'); ph.value = ''; ph.textContent = ezT('—— Preset ——'); if (!cur) ph.selected = true; sel.appendChild(ph); }
    names.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === cur) o.selected = true; sel.appendChild(o); });
  };
  fill();
  sel.addEventListener('mousedown', () => fill()); // 点开该卡片下拉即实时刷新预设
  sel.addEventListener('change', () => {
    if (api) { try { api.setCurrent(sel.value); } catch (_) {} }
    syncCards(mainNode);
  });
  row.appendChild(handle); row.appendChild(name); row.appendChild(sel);
  return row;
}

// 收集全部目标卡片，按 cardOrder（拖拽后的顺序）排序，新增节点追加在末尾
function collectTargets(node) {
  const st = stateFor(node);
  const all = [];
  TARGET_TYPES.forEach((type) => nodesOfType(type).forEach((n) => all.push({ type, node: n, key: type + ':' + n.id })));
  const order = st.cardOrder || [];
  const idx = new Map(); order.forEach((k, i) => idx.set(k, i));
  all.sort((a, b) => {
    const ai = idx.has(a.key) ? idx.get(a.key) : Number.MAX_SAFE_INTEGER;
    const bi = idx.has(b.key) ? idx.get(b.key) : Number.MAX_SAFE_INTEGER;
    return ai - bi || 0;
  });
  return all;
}

// 卡片拖拽排序（克隆影子 + 占位 + pointer 捕获，参考 ParamPresetControl）
function attachCardDnD(list, node) {
  (list.querySelectorAll('.ezc-ph') || []).forEach((x) => { try { x.remove(); } catch (_) {} });
  const placeholder = el('div', 'ezc-ph hidden');
  list.appendChild(placeholder);
  (list.querySelectorAll('.ezc-handle') || []).forEach((h) => {
    if (h._ezDnD) return; h._ezDnD = true;
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
      const item = h.closest('.ezc-row'); if (!item) return;
      const items = [...list.querySelectorAll('.ezc-row')];
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
        const els = [...list.querySelectorAll('.ezc-row')];
        let insertIdx = els.length;
        for (let i = 0; i < els.length; i++) {
          const r = els[i].getBoundingClientRect();
          if (ev.clientY > r.top + r.height / 2) insertIdx = i + 1;
          else { insertIdx = i; break; }
        }
        const same = insertIdx === st.idx || insertIdx === st.idx + 1;
        placeholder.classList.toggle('hidden', same);
        if (!same) {
          if (insertIdx < els.length) els[insertIdx].before(placeholder);
          else els[els.length - 1].after(placeholder);
        }
        st.targetIdx = insertIdx;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        if (!st) return;
        if (st.clone && st.clone.parentNode) st.clone.parentNode.removeChild(st.clone);
        placeholder.classList.toggle('hidden', true);
        items.forEach((c) => { c.style.opacity = '1'; });
        const { idx, moved, targetIdx } = st;
        item.classList.remove('dragging');
        if (moved && targetIdx !== idx && targetIdx !== idx + 1) {
          let insert = targetIdx;
          if (insert > idx) insert -= 1;
          const order = [...list.querySelectorAll('.ezc-row')].map((r) => r._ezKey).filter(Boolean);
          const elKey = order.splice(idx, 1)[0]; if (elKey != null) order.splice(insert, 0, elKey);
          if (node && node._ezMain) { node._ezMain.cardOrder = order; try { syncToConfig(node); } catch (_) {} }
          try { refreshUI(node); } catch (_) {} // 按新顺序重排显示
        }
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    });
  });
}

function fitNode(node) {
  try {
    const root = node && node._ezRoot && node._ezRoot.querySelector('.ezc-root');
    if (!root || typeof node.setSize !== 'function') return;
    const cur = node.size || [0, 96];
    const contentH = root.scrollHeight + 12;
    if (contentH > cur[1] + 4) node.setSize([Math.max(400, cur[0]), Math.min(420, contentH)]);
  } catch (_) {}
}
function refreshUI(node) {
  const root = node && node._ezRoot;
  if (!root || !root.querySelector('.ezc-list')) return;
  const list = root.querySelector('.ezc-list');
  list.innerHTML = '';
  const targets = collectTargets(node);
  if (!targets.length) list.appendChild(el('div', 'ezc-empty')).textContent = ezT('No controllable nodes on the canvas yet (Models Combo Loader / Resolution / Node Switch Master / Param Preset Control). Click "Load all" in the top right to lay them out in one click.');
  targets.forEach((t) => { const row = renderRow(node, t.node); row._ezKey = t.key; list.appendChild(row); });
  attachCardDnD(list, node);
  loadPresets(API).then((lib) => {
    const masterSel = root.querySelector('select');
    const st = stateFor(node);
    if (masterSel) {
      const opts = [MAIN_DEFAULT].concat(lib.map((p) => p.name));
      if (opts.indexOf(st.current) < 0) st.current = MAIN_DEFAULT;
      masterSel.innerHTML = '';
      opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; masterSel.appendChild(o); });
    }
  });
}
let _debounce = null;
function scheduleRefresh() {
  clearTimeout(_debounce);
  _debounce = setTimeout(() => {
    nodesOfType(NODE).forEach((n) => refreshUI(n));
  }, 80);
}
on('ezflex:changed', (type) => { if (SCAFFOLD_TYPES.indexOf(type) >= 0) scheduleRefresh(); });
// 标题实时联动（无 onTitleChanged 钩子，用轻量轮询检测目标标题变化）
// 就地同步各卡片下拉的当前值/标题（不重建 DOM，避免闪烁）
function syncCards(node) {
  const root = node && node._ezRoot; if (!root) return;
  const list = root.querySelector('.ezc-list'); if (!list) return;
  const byKey = new Map(collectTargets(node).map((t) => [t.key, t.node]));
  (list.querySelectorAll('.ezc-row') || []).forEach((row) => {
    const key = row._ezKey; if (!key) return;
    const target = byKey.get(key); if (!target) return;
    const api = targetAPI(target); if (!api) return;
    const cur = api.current() || '';
    const sel = row.querySelector('select'); if (sel && Array.from(sel.options).some((o) => o.value === cur) && sel.value !== cur) sel.value = cur;
    const name = row.querySelector('.gname'); if (name && name.textContent !== (target.title || ezT('Node'))) name.textContent = target.title || ezT('Node');
  });
}
function startTitleWatch(node) {
  // 不再定时轮询：画布重绘（onDrawForeground）+ 节点注册表变化事件 触发，一帧合并；全静止时零开销。
  const check = () => {
    node._ezTitlePend = false;
    const targets = nodesOfType(NODE_TYPES.COMBO).concat(nodesOfType(NODE_TYPES.LATENT), nodesOfType(NODE_TYPES.MASTER), nodesOfType(NODE_TYPES.PARAM_CTRL));
    const ids = targets.map((g) => String(g.id)).join(',');
    const detail = targets.map((g) => { const a = targetAPI(g); return ((g.title || '') + ':' + (a ? a.current() : '')); }).join('|');
    const sig = ids + '::' + detail;
    if (sig !== node._ezTitleSig) {
      node._ezTitleSig = sig;
      if (node._ezTitleIds !== ids) { node._ezTitleIds = ids; refreshUI(node); } // 目标增/删 → 重建卡片
      else syncCards(node); // 仅标题/当前值变化 → 就地更新，避免闪烁
    }
  };
  const schedule = () => {
    if (node._ezTitlePend) return;
    node._ezTitlePend = true;
    node._ezTitleRaf = requestAnimationFrame(check);
  };
  node._ezTitleSchedule = schedule;
  {
    const prevDraw = node.onDrawForeground;
    node.onDrawForeground = function (ctx) { if (prevDraw) prevDraw.call(this, ctx); schedule(); };
    scheduleOnRedraw(schedule);   // resize / 滚动 / 节点注册表变化 都会醒一次
    onLocaleChange(() => { node._ezTitleSig = ''; try { refreshUI(node); } catch (_) {} });   // 语言切换即时重画
    if (EZ_PERF.mainPollMs > 0) node._ezTitleIv = setInterval(schedule, EZ_PERF.mainPollMs);
    schedule();
  }
}

// ===== 挂载 =====
function hideConfigWidget(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && (_in.name === 'config')) { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}

  const w = configWidget(node); if (!w || node._ezMainCfgHid) return; node._ezMainCfgHid = true;
  try {
    w.origComputeSize = w.computeSize; w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0;
    w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
    if (w.element && w.element.style) { w.element.style.display = 'none'; w.element.style.height = '0'; w.element.style.minHeight = '0'; w.element.style.maxHeight = '0'; }
  } catch (_) {}
}
function setupNode(node) {
  if (!node || node._ezMainSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') return;
    node._ezMainSetup = true;
    loadFromConfig(node);
    ensureAPI(node);
    const root = buildRoot(node);
    node._ezRoot = root;
    makeDomWidgetHitThrough(root);
    const widget = node.addDOMWidget('总控制', 'ezc-panel', root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 120, getValue: () => '{}', setValue: () => {} });
    makeDomWidgetHitThrough(widget.element || root);
    node.widgets_start_y = 0;
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
    try { node.setSize([Math.max(400, (node.size ? node.size[0] : 320) + 110), (node.size ? node.size[1] : 200) + 70]); } catch (_) {} // MainControl 初始加宽（头部多了语言按钮，太窄会挡住）tupNode 内）
    setTimeout(hideConfigWidget, 60, node);
    installResizeHandles(node, root);
    startTitleWatch(node);
  } catch (e) { console.error('[MainControl] init failed:', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__ezMainHooked) return; nt.__ezMainHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = prevCfg ? prevCfg.apply(this, arguments) : undefined; loadFromConfig(this); return r; };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; clearInterval(this._ezTitleIv); clearTimeout(this._ezScaffoldTimer); try { if (this._ezTitleRaf) cancelAnimationFrame(this._ezTitleRaf); this._ezTitleRaf = 0; } catch (_) {} unregisterNode(this); try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {} this._ezMainSetup = false; return r; };
  const prevAdded = nt.prototype.onAdded; nt.prototype.onAdded = function () { const r = prevAdded ? prevAdded.apply(this, arguments) : undefined; registerNode(this); return r; };
}
app.registerExtension({
  name: 'Comfy.EzFlex.MainControl',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() { ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); },
});
