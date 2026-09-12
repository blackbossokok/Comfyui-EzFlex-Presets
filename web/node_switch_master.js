// EzFlex-NodeSwitchMaster 节点控制总预设节点。
// 总预设 = { NodeSwitchGroup 节点 id -> 该分组预设名 } 的映射；行 = 画布上的 NodeSwitchGroup 实例。
// 切换/应用总预设时，把映射写进各分组节点的 config.current 并触发其应用开关（级联）。
// 当前总预设名存 config；命名总预设存服务器 user_data 预设库（按节点名共享）。
import { app } from "../../scripts/app.js";
import {
  NODE_TYPES, BASE_PRESETS, isBasePreset,
  registerNode, unregisterNode, nodeTypeOf, nodesOfType,
  configWidget, writeConfig, readConfig,
  loadPresets, savePreset, deletePreset, uiPrompt, on, installResizeHandles, makeDomWidgetHitThrough,
  EZ_PERF, scheduleOnRedraw,
} from "./ezflex_service.js";

const NODE = NODE_TYPES.MASTER;
const API = "/nodeswitch_master/presets";

const CSS = `
.ezm-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezm-shell .ezm-root{pointer-events:auto;}
.ezm-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:#1a1a2e;background:#fff;border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.ezm-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.ezm-hd{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.ezm-hd select{appearance:none;background:#f7f9fd url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7a8e' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 10px center;border:1px solid #dce3ec;border-radius:10px;padding:5px 28px 5px 12px;font-size:12px;font-weight:450;color:#1a1f2b;font-family:inherit;cursor:pointer;min-width:110px;height:30px;line-height:1;flex:1 1 auto;}
.ezm-hd select:focus{border-color:#8fa7c5;outline:none;}
.ezm-btn{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:#1f2937;font-family:inherit;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;height:30px;line-height:1;}
.ezm-btn:hover{background:#edf2fa;border-color:#bcc9db;}
.ezm-btn.success{background:#ecfdf3;border-color:#a7f0c6;color:#065f46;}
.ezm-btn.success:hover{background:#d1fae5;}
.ezm-btn.danger{background:#fef2f2;border-color:#fecaca;color:#991b1b;}
.ezm-btn.danger:hover{background:#fee2e2;}
.ezm-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;}
.ezm-row{display:flex;gap:8px;align-items:center;padding:5px 8px;background:#fbfcfe;border:1px solid #eef2f8;border-radius:10px;flex-wrap:wrap;}
.ezm-row .gname{font-size:12px;font-weight:480;flex:1 1 90px;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1a1f2b;}
.ezm-row select{appearance:none;font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:9px;background:#f7f9fd url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7a8e' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 8px center;color:#1a1f2b;outline:none;padding:4px 24px 4px 10px;flex:1 1 100px;min-width:90px;max-width:170px;height:28px;line-height:1;}
.ezm-row select:focus{border-color:#8fa7c5;}
.ezm-tag{font-size:10px;padding:1px 10px;border-radius:100px;background:#eef2f7;color:#3d4a5c;white-space:nowrap;}
.ezm-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:14px;}
`;

let _styleInjected = false;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }

// ===== 节点状态（config 只存当前总预设名；行与映射来自画布发现 + 预设库）=====
function stateFor(node) {
  if (!node._ezMaster) node._ezMaster = { current: '全部开启' };
  return node._ezMaster;
}
function loadFromConfig(node) {
  const st = stateFor(node);
  const cfg = readConfig(node, {});
  st.current = (typeof cfg.current === 'string' && cfg.current) ? cfg.current : '全部开启';
}
function syncToConfig(node) {
  writeConfig(node, { current: stateFor(node).current });
}

// 基础总预设：把每个发现的 Group 实例映射到同名基础分组预设
function baseMapping(node, baseName) {
  const mapping = {};
  nodesOfType(NODE_TYPES.GROUP).forEach((g) => { mapping[String(g.id)] = baseName; });
  return mapping;
}
async function findLibPreset(name) {
  const list = await loadPresets(API);
  return list.find((p) => p.name === name || p.label === name) || null;
}

// 应用总预设：读映射 → 对每个分组实例 setCurrentAndApply（写其 config + 应用开关）
async function applyPreset(node, name) {
  const st = stateFor(node);
  let mapping = null;
  if (BASE_PRESETS.indexOf(name) >= 0) {
    mapping = baseMapping(node, name);
  } else {
    const p = await findLibPreset(name);
    if (!p) return false;
    mapping = p.groups || {};
  }
  nodesOfType(NODE_TYPES.GROUP).forEach((g) => {
    const key = String(g.id);
    const presetName = mapping[key] || (g._ezGroupAPI ? g._ezGroupAPI.current() : '全部开启');
    if (g._ezGroupAPI) g._ezGroupAPI.setCurrent(presetName);
  });
  st.current = name; syncToConfig(node); refreshUI(node);
  return true;
}
async function savePresetToLib(node) {
  const name = await uiPrompt('请输入总预设名称', '新总预设');
  if (!name || !name.trim()) return;
  const groups = {};
  nodesOfType(NODE_TYPES.GROUP).forEach((g) => {
    groups[String(g.id)] = (g._ezGroupAPI && g._ezGroupAPI.current()) || '全部开启';
  });
  await savePreset(API, { name: name.trim(), label: name.trim(), groups });
  stateFor(node).current = name.trim(); syncToConfig(node); refreshUI(node);
}
async function deletePresetFromLib(node) {
  const st = stateFor(node);
  if (isBasePreset(st.current)) return;
  await deletePreset(API, st.current);
  st.current = '全部开启'; syncToConfig(node); refreshUI(node);
}

// ===== 实例 API（供 MainControl 调用）=====
function ensureAPI(node) {
  if (node._ezMasterAPI) return;
  node._ezMasterAPI = {
    presetNames: () => loadPresets(API).then((list) => BASE_PRESETS.concat(list.map((p) => p.name))),
    setCurrent: (name) => applyPreset(node, name),
    current: () => stateFor(node).current,
    refresh: () => refreshUI(node),
  };
}

// ===== 渲染 =====
function statusOf(groupNode) {
  try {
    const states = groupNode._ezGroupAPI ? groupNode._ezGroupAPI.states() : {};
    const vals = Object.values(states);
    if (!vals.length) return { label: '混合', cls: '' };
    if (vals.every((v) => v === 'on')) return { label: '全开', cls: 'on' };
    if (vals.every((v) => v === 'off')) return { label: '全静音', cls: 'off' };
    if (vals.every((v) => v === 'bypass')) return { label: '全绕过', cls: 'bypass' };
    return { label: '混合', cls: '' };
  } catch (_) { return { label: '混合', cls: '' }; }
}
const TAG_CSS = { on: 'background:#ecfdf3;color:#065f46;', off: 'background:#fef2f2;color:#991b1b;', bypass: 'background:#fffbeb;color:#92400e;' };

function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'ezm-shell');
  const root = el('div', 'ezm-root');
  shell.appendChild(root);
  node._ezRoot = shell;
  const hd = el('div', 'ezm-hd');
  const masterSel = el('select'); masterSel.title = '总预设';
  const saveBtn = el('button', 'ezm-btn success'); saveBtn.textContent = '保存';
  const delBtn = el('button', 'ezm-btn danger'); delBtn.textContent = '删除';
  hd.appendChild(masterSel); hd.appendChild(saveBtn); hd.appendChild(delBtn);
  const list = el('div', 'ezm-list');
  root.appendChild(hd); root.appendChild(list);

  async function render() {
    const st = stateFor(node);
    const lib = await loadPresets(API);
    masterSel.innerHTML = '';
    const opts = BASE_PRESETS.concat(lib.map((p) => p.name));
    if (opts.indexOf(st.current) < 0) { st.current = BASE_PRESETS[0]; syncToConfig(node); }
    opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; masterSel.appendChild(o); });

    const groups = nodesOfType(NODE_TYPES.GROUP);
    list.innerHTML = '';
    if (!groups.length) { list.appendChild(el('div', 'ezm-empty')).textContent = '画布上还没有 EzFlex-NodeSwitchGroup 节点'; return; }
    groups.forEach((g) => list.appendChild(renderRow(node, g, render)));
  }

  masterSel.addEventListener('change', () => applyPreset(node, masterSel.value));
  masterSel.addEventListener('mousedown', () => refreshPresetOptions(node, masterSel));
  saveBtn.addEventListener('click', () => savePresetToLib(node));
  delBtn.addEventListener('click', () => deletePresetFromLib(node));
  render();
  return shell;
}

// 点开预设下拉时强制从服务器刷新选项，保证跨实例/跨工作流新增的命名预设即时可见
async function refreshPresetOptions(node, sel) {
  const st = stateFor(node);
  const lib = await loadPresets(API, true);
  const opts = BASE_PRESETS.concat(lib.map((p) => p.name));
  if (opts.indexOf(st.current) < 0) st.current = BASE_PRESETS[0];
  sel.innerHTML = '';
  opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; sel.appendChild(o); });
}

function renderRow(masterNode, groupNode, refresh) {
  const row = el('div', 'ezm-row');
  const name = el('span', 'gname'); name.textContent = groupNode.title || '分组'; name.title = groupNode.title || '';
  const sel = el('select');
  const api = groupNode._ezGroupAPI;
  const status = statusOf(groupNode);
  const tag = el('span', 'ezm-tag'); tag.textContent = status.label; if (TAG_CSS[status.cls]) tag.style.cssText = TAG_CSS[status.cls];

  const fill = async () => {
    const cur = api ? api.current() : '全部开启';
    const names = api ? await api.presetNames() : BASE_PRESETS;
    sel.innerHTML = '';
    names.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === cur) o.selected = true; sel.appendChild(o); });
  };
  fill();
  sel.addEventListener('mousedown', () => fill()); // 点开该分组预设下拉即实时刷新
  sel.addEventListener('change', () => {
    if (api) api.setCurrent(sel.value);
    refresh();
  });
  row.appendChild(name); row.appendChild(sel); row.appendChild(tag);
  return row;
}

function refreshUI(node) {
  const root = node && node._ezRoot;
  if (root && root.querySelector('.ezm-list')) {
    const list = root.querySelector('.ezm-list');
    const groups = nodesOfType(NODE_TYPES.GROUP);
    list.innerHTML = '';
    if (!groups.length) { list.appendChild(el('div', 'ezm-empty')).textContent = '画布上还没有 EzFlex-NodeSwitchGroup 节点'; }
    groups.forEach((g) => list.appendChild(renderRow(node, g, () => refreshUI(node))));
    loadPresets(API).then((lib) => {
      const masterSel = root.querySelector('select');
      const st = stateFor(node);
      if (masterSel) {
        const opts = BASE_PRESETS.concat(lib.map((p) => p.name));
        if (opts.indexOf(st.current) < 0) st.current = BASE_PRESETS[0];
        masterSel.innerHTML = '';
        opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; masterSel.appendChild(o); });
      }
    });
  }
}
let _debounce = null;
function scheduleRefresh() {
  clearTimeout(_debounce);
  _debounce = setTimeout(() => {
    nodesOfType(NODE).forEach((n) => refreshUI(n));
  }, 80);
}
on('ezflex:changed', (type) => { if (type === NODE_TYPES.GROUP) scheduleRefresh(); });
// 标题实时联动：无 onTitleChanged 钩子，用轻量轮询检测目标节点标题变化（节点标题点击改名后自动刷新行名）
function startTitleWatch(node) {
  // 不再 700ms 轮询：画布重绘（onDrawForeground）+ resize/滚动/注册表变化 触发，一帧合并
  if (node._ezTitleBound) return;
  node._ezTitleBound = true;
  const check = () => {
    node._ezTitlePend = false;
    const targets = nodesOfType(NODE_TYPES.GROUP);
    const sig = targets.map((g) => {
      const api = g._ezGroupAPI;
      return ((g.title || '') + ':' + g.id + ':' + (api ? api.presetNames().join('|') : '') + ':' + (api ? api.current() : ''));
    }).join('|');
    if (sig !== node._ezTitleSig) { node._ezTitleSig = sig; refreshUI(node); }
  };
  const schedule = () => {
    if (node._ezTitlePend) return;
    node._ezTitlePend = true;
    node._ezTitleRaf = requestAnimationFrame(check);
  };
  {
    const prevDraw = node.onDrawForeground;
    node.onDrawForeground = function (ctx) { if (prevDraw) prevDraw.call(this, ctx); schedule(); };
    scheduleOnRedraw(schedule);
    if (EZ_PERF.mainPollMs > 0) node._ezTitleIv = setInterval(schedule, EZ_PERF.mainPollMs);
    schedule();
  }
}

// ===== 挂载 =====
function hideConfigWidget(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && (_in.name === 'config')) { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}

  const w = configWidget(node); if (!w || node._ezMstCfgHid) return; node._ezMstCfgHid = true;
  try {
    w.origComputeSize = w.computeSize; w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0;
    w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
    if (w.element && w.element.style) { w.element.style.display = 'none'; w.element.style.height = '0'; w.element.style.minHeight = '0'; w.element.style.maxHeight = '0'; }
  } catch (_) {}
}
function setupNode(node) {
  if (!node || node._ezMasterSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') return;
    node._ezMasterSetup = true;
    loadFromConfig(node);
    ensureAPI(node);
    const root = buildRoot(node);
    node._ezRoot = root;
    makeDomWidgetHitThrough(root);
    const widget = node.addDOMWidget('节点控制总预设', 'ezm-panel', root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 120, getValue: () => '{}', setValue: () => {} });
    makeDomWidgetHitThrough(widget.element || root);
    node.widgets_start_y = 0;
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
    setTimeout(hideConfigWidget, 60, node);
    installResizeHandles(node, root);
    startTitleWatch(node);
  } catch (e) { console.error('[NodeSwitchMaster] init failed:', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__ezMasterHooked) return; nt.__ezMasterHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = prevCfg ? prevCfg.apply(this, arguments) : undefined; loadFromConfig(this); return r; };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; clearInterval(this._ezTitleIv); try { if (this._ezTitleRaf) cancelAnimationFrame(this._ezTitleRaf); this._ezTitleRaf = 0; } catch (_) {} unregisterNode(this); try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {} this._ezMasterSetup = false; return r; };
  const prevAdded = nt.prototype.onAdded; nt.prototype.onAdded = function () { const r = prevAdded ? prevAdded.apply(this, arguments) : undefined; registerNode(this); return r; };
}
app.registerExtension({
  name: 'Comfy.EzFlex.NodeSwitchMaster',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() { ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); },
});
