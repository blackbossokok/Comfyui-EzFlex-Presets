// EzFlex-NodeSwitchGroup 分组预设节点（rgthree 式）。
// 自动扫描工作流中的 ComfyUI 分组（Ctrl+G），按 节点级 匹配颜色/匹配标题/子工作流/排序 过滤后自动成行；
// 每行 = 一个画布分组，3 态（开启/禁用/绕过）滑块一键给该分组内节点设 node.mode 0/2/4。
// 匹配配置存 config（面板可改，序列化保存）；分组预设（全部开启/全部禁用/全部绕过 + 自定义快照）存服务器 user_data。
import { app } from "../../scripts/app.js";
import { ezT, onLocaleChange } from "./ezflex_i18n.js";
import {
  NODE_TYPES, MODE_NUM, BASE_PRESETS, isBasePreset,
  registerNode, unregisterNode, nodeTypeOf,
  configWidget, writeConfig, readConfig,
  uiPrompt,
  allGraphGroups, groupNodes, changeModeOfNodes, normalizeColor, installResizeHandles, makeDomWidgetHitThrough,
  EZ_PERF, scheduleOnRedraw,
} from "./ezflex_service.js";

const NODE = NODE_TYPES.GROUP;

const CSS = `
.ezg-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezg-shell .ezg-root{pointer-events:auto;}
.ezg-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:#1a1a2e;background:#fff;border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.ezg-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.ezg-hd{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.ezg-hd select{appearance:none;background:#f7f9fd url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7a8e' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 10px center;border:1px solid #dce3ec;border-radius:10px;padding:5px 28px 5px 12px;font-size:12px;font-weight:450;color:#1a1f2b;font-family:inherit;cursor:pointer;min-width:110px;height:30px;line-height:1;flex:1 1 auto;}
.ezg-hd select:focus{border-color:#8fa7c5;outline:none;}
.ezg-btn{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:#1f2937;font-family:inherit;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;height:30px;line-height:1;}
.ezg-btn:hover{background:#edf2fa;border-color:#bcc9db;}
.ezg-btn.success{background:#ecfdf3;border-color:#a7f0c6;color:#065f46;}
.ezg-btn.success:hover{background:#d1fae5;}
.ezg-btn.danger{background:#fef2f2;border-color:#fecaca;color:#991b1b;}
.ezg-btn.danger:hover{background:#fee2e2;}
.ezg-btn.warn{background:#fffbeb;border-color:#fcd34d;color:#92400e;}
.ezg-btn.warn:hover{background:#fef3c7;}
.ezg-filters{display:flex;gap:6px;align-items:center;flex-wrap:nowrap;background:#f9fbfd;border:1px solid #eef2f8;border-radius:10px;padding:5px 8px;}
.ezg-filters select{appearance:none;background:#f7f9fd url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7a8e' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 7px center;border:1px solid #dce3ec;border-radius:8px;padding:4px 24px 4px 9px;font-size:11px;font-family:inherit;color:#1a1f2b;outline:none;cursor:pointer;height:26px;line-height:1;flex:0 0 auto;}
.ezg-filters select:focus{border-color:#8fa7c5;}
.ezg-filters input{flex:1 1 120px;min-width:60px;max-width:58%;font-family:inherit;font-size:11px;border:1px solid #dce3ec;border-radius:8px;background:#fff;color:#1a1a2e;outline:none;padding:4px 9px;height:26px;line-height:1;}
.ezg-filters input:focus{border-color:#8fa7c5;}
.ezg-sub{width:28px;height:26px;border-radius:8px;border:1px solid #dce3ec;background:#fff;color:#5f6b7a;font-size:13px;font-weight:600;line-height:1;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;}
.ezg-sub:hover{background:#edf2fa;border-color:#bcc9db;}
.ezg-sub.on{background:#ecfdf3;border-color:#a7f0c6;color:#065f46;box-shadow:0 1px 4px rgba(6,95,70,.16);}
.ezg-fvalues{display:flex;gap:6px;align-items:center;flex:1 1 auto;min-width:0;}
.ezg-swatch{width:22px;height:22px;border-radius:50%;border:2px solid #dce3ec;flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(0,0,0,.06);cursor:pointer;padding:0;}
.ezg-fvalues .ezg-btn{height:26px;padding:2px 9px;font-size:11px;flex:0 0 auto;}
.ezg-palette{font-family:Inter,sans-serif;}
.ezg-psep{width:100%;font-size:10px;color:#8a9aa8;border-top:1px solid #eef2f8;padding-top:4px;margin-top:2px;}
.ezg-pdot{width:20px;height:20px;border-radius:50%;border:1px solid rgba(0,0,0,.12);cursor:pointer;flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35);}
.ezg-pdot.sel{outline:2px solid #1a1f2b;outline-offset:1px;}
.ezg-filters input[type=color]{width:30px;height:26px;padding:0;border:1px solid #dce3ec;border-radius:8px;background:#fff;cursor:pointer;flex:0 0 auto;}
.ezg-filters input[type=color]::-webkit-color-swatch-wrapper{padding:1px;}
.ezg-filters input[type=color]::-webkit-color-swatch{border:none;border-radius:6px;}
.ezg-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;}
.ezg-row{display:flex;align-items:center;gap:8px;padding:6px 8px;background:#fbfcfe;border:1px solid #eef2f8;border-radius:10px;flex-wrap:wrap;}
.ezg-row .gname{font-size:12px;font-weight:480;color:#1a1f2b;flex:1 1 auto;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ezg-mode{display:flex;background:#f1f4fa;border-radius:9px;padding:2px;border:1px solid #e2e8f0;flex:0 0 auto;}
.ezg-mode button{background:transparent;border:none;padding:2px 12px;font-size:11px;font-weight:470;color:#4d5b6d;font-family:inherit;cursor:pointer;border-radius:7px;transition:all .1s;height:26px;line-height:1;}
.ezg-mode button.active{background:#fff;color:#0f141f;box-shadow:0 1px 4px rgba(0,0,0,.06);font-weight:510;}
.ezg-mode button.mode-on.active{background:#ecfdf3;color:#065f46;border:1px solid #a7f0c6;}
.ezg-mode button.mode-off.active{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;}
.ezg-mode button.mode-bypass.active{background:#fffbeb;color:#92400e;border:1px solid #fcd34d;}
.ezg-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:14px;}
/* 预设行 / 匹配行各配一条收起-展开三角（单独一条，放在该行下面）：无底边小三角，
   平时隐藏、鼠标悬停才显形；展开态朝上、收起态朝下。 */
.ezg-tri-row{display:flex;align-items:center;justify-content:center;height:12px;flex:0 0 auto;cursor:pointer;opacity:0;transition:opacity .15s;background:transparent;margin:-10px 0;}   /* 负 margin 吃掉 .ezg-root 的 10px gap：三角正好夹在两行中间、不占额外位置 */
.ezg-tri-row.no-above{margin-top:0;}   /* 上面那行收起了：不要再往上顶，否则会和上一行叠在一起（会闪烁、点不中） */
.ezg-tri-row:hover{opacity:1;background:rgba(43,58,74,.06);}
.ezg-tri-row i{display:block;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:6px solid #8a9aa8;transition:transform .15s;}
.ezg-hd.collapsed,.ezg-filters.collapsed{display:none;}
`;

let _styleInjected = false;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }

// ===== 节点状态 =====
function stateFor(node) {
  if (!node._ezGroup) node._ezGroup = { filters: { mode: 'title', match: '', showAllGraphs: true, sort: 'position' }, states: {}, presets: {}, current: '全部开启', _groups: [], _lastSig: '' };
  return node._ezGroup;
}
function loadFromConfig(node) {
  const st = stateFor(node);
  const cfg = readConfig(node, {});
  const f = cfg.filters || {};
  st.filters = {
    mode: f.mode === 'color' ? 'color' : 'title',
    match: typeof f.match === 'string' ? f.match : '',
    showAllGraphs: f.showAllGraphs !== false,
    sort: f.sort === 'alpha' ? 'alpha' : 'position',
    presetCollapsed: !!f.presetCollapsed,   // 预设行收起（刷新/重启后保持）
    matchCollapsed: !!f.matchCollapsed,     // 匹配行收起
  };
  st.states = (cfg.states && typeof cfg.states === 'object') ? cfg.states : {};
  st.presets = (cfg.presets && typeof cfg.presets === 'object' && !Array.isArray(cfg.presets)) ? cfg.presets : {};
  st.current = (typeof cfg.current === 'string' && cfg.current) ? cfg.current : '全部开启';
  st._groups = []; st._lastSig = '';
}
function syncToConfig(node) {
  const st = stateFor(node);
  writeConfig(node, { filters: st.filters, states: st.states, presets: st.presets, current: st.current });
}
// 预设选项 = 基础三项 + 本实例 config 里保存的命名预设（按实例独立，同名不再互相覆盖）
function presetOptions(node) {
  const st = stateFor(node);
  return BASE_PRESETS.concat(Object.keys(st.presets));
}

// ===== 分组发现（rgthree 式：自动扫描 + 匹配方式/匹配值/子工作流 过滤）=====
function discoverGroups(node) {
  const st = stateFor(node);
  const f = st.filters;
  let groups = allGraphGroups();
  if (!f.showAllGraphs) {
    const cur = (app.canvas && app.canvas.getCurrentGraph && app.canvas.getCurrentGraph()) || app.graph;
    groups = groups.filter((g) => (g.graph || app.graph) === cur);
  }
  const val = String(f.match || '').trim();
  if (val) {
    if (f.mode === 'color') {
      const want = val.split(',').map((c) => normalizeColor(c)).filter(Boolean);
      if (want.length) groups = groups.filter((g) => {
        const cs = [normalizeColor(g.color), normalizeColor(g._color)].filter(Boolean);
        return cs.some((c) => want.indexOf(c) >= 0);
      });
    } else {
      const re = new RegExp(val, 'i');
      groups = groups.filter((g) => { try { return re.exec(g.title || ''); } catch (_) { return false; } });
    }
  }
  groups = groups.slice().sort((a, b) => {
    if (f.sort === 'alpha') return (a.title || '').localeCompare(b.title || '');
    const ay = Math.floor((a._pos || [0])[1] / 30), by = Math.floor((b._pos || [0])[1] / 30);
    if (ay !== by) return ay - by;
    return Math.floor((a._pos || [0])[0] / 30) - Math.floor((b._pos || [0])[0] / 30);
  });
  return groups;
}
function sigOf(groups) { return groups.map((g) => ((g.title || '') + '/' + (g.color || '') + '/' + (g.graph ? g.graph.id : 0))).join('|'); }

// ===== 分组状态键 =====
// 同一节点里可能出现**同名分组**（如两个都叫 “Group”）。states 若只用 title 作 key，保存/应用时后者覆盖前者，
// 导致“双绕过/双禁用/双开启”。这里给同名分组加一个在该节点内唯一的序号后缀（title + '##' + idx），
// 并保留旧 title-key 兜底（之前保存的预设、或非同名分组仍兼容）。
function groupKey(st, g) {
  const title = (g && g.title) || '';
  const same = (st && st._groups || []).filter((x) => (x && x.title) === title);
  if (same.length <= 1) return title;
  const idx = same.indexOf(g);
  return title + '##' + idx;
}
function groupState(st, g) {
  const k = groupKey(st, g);
  if (st && st.states && st.states[k] != null) return st.states[k];
  const t = g && g.title;
  if (st && st.states && t && st.states[t] != null) return st.states[t];
  return 'on';
}

// ===== 应用（把状态写到画布分组内节点 mode）=====
function applyGroupMode(node, group, mode) {
  const m = MODE_NUM[mode] != null ? MODE_NUM[mode] : 0;
  changeModeOfNodes(groupNodes(group), m);
}
function applyAll(node) {
  const st = stateFor(node);
  st._groups.forEach((g) => applyGroupMode(node, g, groupState(st, g)));
}

// ===== 实例 API（供 NodeSwitchMaster 调用）=====
function ensureAPI(node) {
  if (node._ezGroupAPI) return;
  node._ezGroupAPI = {
    presetNames: () => presetOptions(node),
    states: () => stateFor(node).states,
    current: () => stateFor(node).current,
    setCurrent: (name) => setCurrentPreset(node, name),
    refresh: () => refreshUI(node),
  };
}

// ===== 预设操作（按实例存 config，避免多节点同名互串；同节点内同名分组用 groupKey 区分）=====
async function setCurrentPreset(node, name) {
  const st = stateFor(node);
  if (BASE_PRESETS.indexOf(name) >= 0) {
    const mode = name === '全部开启' ? 'on' : (name === '全部禁用' ? 'off' : 'bypass');
    st._groups.forEach((g) => { st.states[groupKey(st, g)] = mode; });
    st.current = name;
  } else {
    const p = st.presets[name];
    if (!p) { refreshUI(node); return; }
    st._groups.forEach((g) => {
      const k = groupKey(st, g);
      let v = 'on';
      if (p.states) {
        if (p.states[k] != null) v = p.states[k];
        else if (p.states[g.title] != null) v = p.states[g.title];
      }
      st.states[k] = v;
    });
    st.current = name;
  }
  syncToConfig(node);
  applyAll(node);
  refreshUI(node);
}
async function savePresetToLib(node) {
  const name = await uiPrompt(ezT('Enter group preset name'), ezT('New preset'));
  if (!name || !name.trim()) return;
  const st = stateFor(node);
  const states = {};
  st._groups.forEach((g) => { states[groupKey(st, g)] = groupState(st, g); });
  const key = name.trim();
  st.presets[key] = { label: key, states };
  st.current = key;
  syncToConfig(node);
  applyAll(node);
  refreshUI(node);
}
async function deletePresetFromLib(node) {
  const st = stateFor(node);
  if (isBasePreset(st.current)) return;
  delete st.presets[st.current];
  st.current = '全部开启'; syncToConfig(node); applyAll(node); refreshUI(node);
}

// ===== 渲染 =====
// 行的收起/展开：一条单独的三角行（放在要收起的那行下面），悬停才显形；状态存 config.filters
function triRow(node, getRow, key) {
  const bar = el('div', 'ezg-tri-row');
  bar.appendChild(el('i'));
  bar.addEventListener('click', (e) => { e.stopPropagation(); const st = stateFor(node); st.filters[key] = !st.filters[key]; syncToConfig(node); applyTri(bar, getRow(), st.filters[key]); });
  return bar;
}
function applyTri(bar, row, collapsed) {
  bar.classList.toggle('no-above', !!collapsed);   // 收起 = 上面那行不在了，三角不能再往上拉
  if (row) row.classList.toggle('collapsed', !!collapsed);
  const i = bar.querySelector('i'); if (i) i.style.transform = collapsed ? 'rotate(180deg)' : '';
  bar.title = collapsed ? ezT('Expand toolbar') : ezT('Collapse toolbar');
}
function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'ezg-shell');
  const root = el('div', 'ezg-root');
  shell.appendChild(root);
  node._ezRoot = shell; // 先挂引用，render()/refreshRows 内部要用它定位列表

  const hd = el('div', 'ezg-hd');
  const presetSel = el('select'); presetSel.title = ezT('Group preset');
  const saveBtn = el('button', 'ezg-btn success'); saveBtn.textContent = ezT('Save preset');
  const delBtn = el('button', 'ezg-btn danger'); delBtn.textContent = ezT('Delete preset');
  hd.appendChild(presetSel); hd.appendChild(saveBtn); hd.appendChild(delBtn);
  const presetTri = triRow(node, () => hd, 'presetCollapsed');
  applyTri(presetTri, hd, stateFor(node).filters.presetCollapsed);

  // 匹配过滤行（节点级，rgthree 属性式）
  const filters = buildFilters(node, () => { refreshRows(node); });
  const matchTri = triRow(node, () => filters, 'matchCollapsed');
  applyTri(matchTri, filters, stateFor(node).filters.matchCollapsed);
  const list = el('div', 'ezg-list');

  root.appendChild(hd); root.appendChild(presetTri); root.appendChild(filters); root.appendChild(matchTri); root.appendChild(list);

  async function render() {
    const st = stateFor(node);
    presetSel.innerHTML = '';
    const opts = presetOptions(node);
    if (opts.indexOf(st.current) < 0) { st.current = BASE_PRESETS[0]; syncToConfig(node); }
    opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; presetSel.appendChild(o); });
    refreshRows(node);
    fitNode(node); // 仅初次渲染自适应一次，后续交给用户手动缩放
  }
  presetSel.addEventListener('change', () => setCurrentPreset(node, presetSel.value));
  presetSel.addEventListener('mousedown', () => refreshPresetOptions(node, presetSel));
  saveBtn.addEventListener('click', () => savePresetToLib(node));
  delBtn.addEventListener('click', () => deletePresetFromLib(node));

  render();
  return shell;
}

function refreshPresetOptions(node, sel) {
  const st = stateFor(node);
  const opts = presetOptions(node);
  if (opts.indexOf(st.current) < 0) st.current = BASE_PRESETS[0];
  sel.innerHTML = '';
  opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; sel.appendChild(o); });
}

const COLOR_PRESET_KEY = 'ezflex_group_color_presets';
function loadColorPresets() { try { return JSON.parse(localStorage.getItem(COLOR_PRESET_KEY) || '[]'); } catch (_) { return []; } }
function saveColorPresets(arr) { try { localStorage.setItem(COLOR_PRESET_KEY, JSON.stringify(arr)); } catch (_) {} }
// ComfyUI 内置节点/分组颜色的确切 groupcolor（来自前端 bundle），保证预设色与 ComfyUI 一致
const COMFY_GROUP_COLORS = [
  ['red', '#A88'], ['brown', '#b06634'], ['green', '#8A8'], ['blue', '#88A'],
  ['pale_blue', '#3f789e'], ['cyan', '#8AA'], ['purple', '#a1309b'], ['yellow', '#b58b2a'], ['black', '#444'],
];
function comfyColorPalette() {
  const out = COMFY_GROUP_COLORS.map(([name, gc]) => ({ name, hex: toHexColor(gc) || gc }));
  try {
    const nc = (typeof LGraphCanvas !== 'undefined' && LGraphCanvas.node_colors) ? LGraphCanvas.node_colors : {};
    for (const k of Object.keys(nc)) {
      if (out.some((p) => p.name === k)) continue;
      const h = toHexColor(nc[k].groupcolor);
      if (h) out.push({ name: k, hex: h });
    }
  } catch (_) {}
  return out;
}

function toHexColor(v) {
  if (!v) return '';
  const s = String(v).trim();
  const t = s.replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(t)) return '#' + t;
  if (/^[0-9a-f]{3}$/i.test(t)) return '#' + t.replace(/(.)(.)(.)/, '$1$1$2$2$3$3');
  const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const hex = [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(255, parseInt(x, 10))).toString(16).padStart(2, '0')).join('');
    return '#' + hex;
  }
  try {
    if (typeof LGraphCanvas !== 'undefined' && LGraphCanvas.node_colors && LGraphCanvas.node_colors[s.toLowerCase()]) {
      return toHexColor(LGraphCanvas.node_colors[s.toLowerCase()].groupcolor);
    }
  } catch (_) {}
  return '';
}

let _palette = null;
function closePalette() {
  if (_palette && _palette._onDown) document.removeEventListener('pointerdown', _palette._onDown, true);
  if (_palette && _palette.parentNode) _palette.remove();
  _palette = null;
}
function openColorPalette(node, anchor, current, onPick) {
  if (_palette && _palette.parentNode) _palette.remove();
  _palette = el('div', 'ezg-palette');
  const rect = anchor.getBoundingClientRect();
  _palette.style.cssText = 'position:fixed;z-index:9999;background:#fff;border:1px solid #dce3ec;border-radius:10px;padding:8px;box-shadow:0 8px 28px rgba(0,0,0,.18);display:flex;flex-wrap:wrap;gap:6px;max-width:260px;left:' + rect.left + 'px;top:' + (rect.bottom + 6) + 'px;';
  const addDot = (hex, title) => {
    const d = el('span', 'ezg-pdot'); d.title = title || hex || ''; d.style.background = hex || '#ccc';
    if (hex && toHexColor(current) === toHexColor(hex)) d.classList.add('sel');
    d.addEventListener('click', (e) => { e.stopPropagation(); onPick(hex || ''); closePalette(); });
    _palette.appendChild(d);
  };
  const sep = el('div', 'ezg-psep'); sep.textContent = ezT('ComfyUI colors'); _palette.appendChild(sep);
  comfyColorPalette().forEach((p) => addDot(p.hex, p.name));
  // 当前工作流分组实际颜色（直接可匹配）
  const wfColors = [];
  allGraphGroups().forEach((g) => {
    const h = toHexColor(g.color) || toHexColor(g._color);
    if (h && wfColors.indexOf(h) < 0) wfColors.push(h);
  });
  if (wfColors.length) { const sep2 = el('div', 'ezg-psep'); sep2.textContent = ezT('Workflow colors'); _palette.appendChild(sep2); wfColors.forEach((c) => addDot(c, c)); }
  const saved = loadColorPresets();
  if (saved.length) { const sp = el('div', 'ezg-psep'); sp.textContent = ezT('Saved'); _palette.appendChild(sp); saved.forEach((c) => addDot(c, c)); }
  document.body.appendChild(_palette);
  setTimeout(() => {
    const onDown = (e) => { if (_palette && !_palette.contains(e.target)) closePalette(); };
    _palette._onDown = onDown;
    document.addEventListener('pointerdown', onDown, true);
  }, 0);
}

function buildFilters(node, onChange) {
  const st = stateFor(node);
  const wrap = el('div', 'ezg-filters');
  const modeSel = el('select');
  [['title', ezT('By title')], ['color', ezT('By color')]].forEach(([v, l]) => { const o = el('option'); o.value = v; o.textContent = l; if (v === st.filters.mode) o.selected = true; modeSel.appendChild(o); });
  const rest = el('div', 'ezg-fvalues');
  const sortSel = el('select');
  [['position', ezT('By position')], ['alpha', ezT('By letter')]].forEach(([v, l]) => { const o = el('option'); o.value = v; o.textContent = l; if (v === (st.filters.sort || 'position')) o.selected = true; sortSel.appendChild(o); });
  sortSel.title = ezT('Sort');
  sortSel.addEventListener('change', () => { st.filters.sort = sortSel.value; syncToConfig(node); onChange(); });

  function buildMode() {
    rest.innerHTML = '';
    if (st.filters.mode === 'color') {
      const swatch = el('button', 'ezg-swatch'); swatch.title = ezT('Color presets (click to open)');
      swatch.style.background = st.filters.match || '#a4d399';
      swatch.addEventListener('click', (e) => { e.stopPropagation(); openColorPalette(node, swatch, st.filters.match, (hex) => { st.filters.match = hex; swatch.style.background = st.filters.match || '#a4d399'; wheel.value = toHexColor(st.filters.match) || '#a4d399'; syncToConfig(node); onChange(); }); });
      const wheel = el('input'); wheel.type = 'color'; wheel.value = toHexColor(st.filters.match) || '#a4d399'; wheel.title = ezT('Pick color');
      const applyColor = (hex) => { st.filters.match = hex; syncToConfig(node); swatch.style.background = hex; onChange(); };
      wheel.addEventListener('input', () => applyColor(wheel.value));
      wheel.addEventListener('change', () => applyColor(wheel.value));
      const save = el('button', 'ezg-btn small'); save.textContent = ezT('Save'); save.title = ezT('Save current color preset');
      save.addEventListener('click', () => { const c = st.filters.match || wheel.value; if (c) { const a = loadColorPresets(); if (a.indexOf(c) < 0) { a.push(c); saveColorPresets(a); } } });
      const del = el('button', 'ezg-btn small'); del.textContent = ezT('Delete'); del.title = ezT('Remove current color from presets');
      del.addEventListener('click', () => { const c = st.filters.match || wheel.value; saveColorPresets(loadColorPresets().filter((x) => x !== c)); });
      rest.appendChild(swatch); rest.appendChild(wheel); rest.appendChild(save); rest.appendChild(del);
    } else {
      const txt = el('input'); txt.value = st.filters.match; txt.placeholder = ezT('Match title (regex)');
      txt.addEventListener('change', () => { st.filters.match = txt.value; syncToConfig(node); onChange(); });
      rest.appendChild(txt);
    }
    const sub = el('button', 'ezg-sub'); sub.textContent = ezT('Sub'); sub.title = ezT('Apply to subworkflows');
    sub.classList.toggle('on', !!st.filters.showAllGraphs);
    sub.addEventListener('click', () => { st.filters.showAllGraphs = !st.filters.showAllGraphs; sub.classList.toggle('on', !!st.filters.showAllGraphs); syncToConfig(node); onChange(); });
    rest.appendChild(sub);
  }
  modeSel.addEventListener('change', () => { st.filters.mode = modeSel.value; syncToConfig(node); buildMode(); onChange(); });
  buildMode();
  wrap.appendChild(modeSel); wrap.appendChild(rest); wrap.appendChild(sortSel);
  return wrap;
}

function renderRow(node, group, refresh) {
  const st = stateFor(node);
  const row = el('div', 'ezg-row');
  const name = el('span', 'gname'); name.textContent = group.title || ezT('Unnamed group'); name.title = group.title || '';
  const mode = el('div', 'ezg-mode');
  const cur = groupState(st, group);
  const mk = (v, label) => {
    const b = el('button', 'mode-' + v); b.textContent = label;
    if (cur === v) b.classList.add('active');
    b.addEventListener('click', () => {
      st.states[groupKey(st, group)] = v;
      applyGroupMode(node, group, v);
      syncToConfig(node);
      const btns = mode.querySelectorAll('button');
      btns.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    });
    mode.appendChild(b);
  };
  mk('on', ezT('On')); mk('off', ezT('Off')); mk('bypass', ezT('Bypass'));
  row.appendChild(name); row.appendChild(mode);
  return row;
}

function refreshRows(node) {
  const st = stateFor(node);
  const groups = discoverGroups(node);
  st._groups = groups;
  st._lastSig = sigOf(groups);
  const list = node._ezRoot ? node._ezRoot.querySelector('.ezg-list') : null;
  if (!list) return;
  list.innerHTML = '';
  if (!groups.length) { list.appendChild(el('div', 'ezg-empty')).textContent = ezT('No groups matched (create a group with Ctrl+G in the workflow, or adjust the match filters above)'); return; }
  groups.forEach((g) => list.appendChild(renderRow(node, g, null)));
}
function refreshUI(node) {
  const st = stateFor(node);
  st._groups = discoverGroups(node);
  st._lastSig = sigOf(st._groups);
  const list = node && node._ezRoot ? node._ezRoot.querySelector('.ezg-list') : null;
  if (!list) return;
  list.innerHTML = '';
  if (!st._groups.length) { list.appendChild(el('div', 'ezg-empty')).textContent = ezT('No groups matched (create a group with Ctrl+G in the workflow, or adjust the match filters above)'); }
  st._groups.forEach((g) => list.appendChild(renderRow(node, g, null)));
  const presetSel = node._ezRoot.querySelector('.ezg-hd select');
  const opts = presetOptions(node);
  if (opts.indexOf(st.current) < 0) st.current = BASE_PRESETS[0];
  presetSel.innerHTML = '';
  opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; presetSel.appendChild(o); });
}
function fitNode(node) {
  try {
    const root = node && node._ezRoot && node._ezRoot.querySelector('.ezg-root');
    if (!root || typeof node.setSize !== 'function') return;
    const cur = node.size || [300, 96];
    const contentH = root.scrollHeight + 12;
    if (contentH > cur[1] + 4) node.setSize([Math.max(320, cur[0]), Math.min(420, contentH)]);
  } catch (_) {}
}

// 定时重扫：分组被移动/改色/改名时自动更新列表（rgthree 服务轮询思路，防抖）
// ⚠️ 定时器必须**按节点**存放（node._ezScanTimer），不能共用全局变量——否则多个 NodeSwitchGroup
//    同屏时彼此的 scheduleScan 会互相 clearTimeout，导致只有最后一个节点在刷新分组列表（表现成分组/预设串）。
function scheduleScan(node) {
  // 前沿节流：距上次扫描够久就立刻扫（刚加了组/改了组马上能看到），连续拖动时最多 2.5 次/秒
  clearTimeout(node._ezScanTimer);
  const run = () => {
    node._ezScanAt = Date.now();
    const st = stateFor(node);
    const groups = discoverGroups(node);
    const sig = sigOf(groups);
    if (sig !== st._lastSig) { st._lastSig = sig; st._groups = groups; refreshRows(node); }
  };
  const gap = 400 - (Date.now() - (node._ezScanAt || 0));
  if (gap <= 0) { run(); return; }
  node._ezScanTimer = setTimeout(run, gap);
}
function startAutoScan(node) {
  // 不再 1s 轮询：画布重绘（onDrawForeground）+ resize/滚动/节点注册表变化 触发；scheduleScan 内部还有 500ms 去抖
  if (node._ezScanBound) return;
  node._ezScanBound = true;
  const prevDraw = node.onDrawForeground;
  node.onDrawForeground = function (ctx) { if (prevDraw) prevDraw.call(this, ctx); scheduleScan(this); };
  scheduleOnRedraw(() => scheduleScan(node));
  onLocaleChange(() => { try { refreshUI(node); } catch (_) {} scheduleScan(node); });   // 语言切换即时重画
  if (EZ_PERF.groupPollMs > 0) node._ezScanIv = setInterval(() => scheduleScan(node), EZ_PERF.groupPollMs);
}

// ===== 挂载 =====
function hideConfigWidget(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && (_in.name === 'config')) { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}

  const w = configWidget(node); if (!w || node._ezCfgHid) return; node._ezCfgHid = true;
  try {
    w.origComputeSize = w.computeSize; w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0;
    w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
    if (w.element && w.element.style) { w.element.style.display = 'none'; w.element.style.height = '0'; w.element.style.minHeight = '0'; w.element.style.maxHeight = '0'; }
  } catch (_) {}
}
function setupNode(node) {
  if (!node || node._ezGroupSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') return;
    node._ezGroupSetup = true;
    loadFromConfig(node);
    ensureAPI(node);
    const root = buildRoot(node);
    node._ezRoot = root;
    makeDomWidgetHitThrough(root);
    const widget = node.addDOMWidget(ezT('Group preset'), 'ezg-panel', root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 0, getMinHeight: () => 150, getValue: () => '{}', setValue: () => {} });
    makeDomWidgetHitThrough(widget.element || root);
    node.widgets_start_y = 0;
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
    setTimeout(hideConfigWidget, 60, node);
    installResizeHandles(node, root);
    startAutoScan(node);
  } catch (e) { console.error('[NodeSwitchGroup] init failed:', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__ezGroupHooked) return; nt.__ezGroupHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = prevCfg ? prevCfg.apply(this, arguments) : undefined; loadFromConfig(this); return r; };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; clearInterval(this._ezScanIv); clearTimeout(this._ezScanTimer); try { if (this._ezTitleRaf) cancelAnimationFrame(this._ezTitleRaf); this._ezTitleRaf = 0; } catch (_) {} unregisterNode(this); try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {} this._ezGroupSetup = false; return r; };
  const prevAdded = nt.prototype.onAdded; nt.prototype.onAdded = function () { const r = prevAdded ? prevAdded.apply(this, arguments) : undefined; registerNode(this); return r; };
}
app.registerExtension({
  name: 'Comfy.EzFlex.NodeSwitchGroup',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() { ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); },
});
