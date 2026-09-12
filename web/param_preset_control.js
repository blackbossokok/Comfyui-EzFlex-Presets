// EzFlex-ParamPresetControl 参数预设控制节点。
// 前端面板：预设库 / 参数组列表（可拖拽排序）/ 编辑弹窗（参数增删、拖拽排序、名/类型/值）。
// 动态输出端口 = 参数组数 1:1（EZFLEX_PARAM_GROUP 自定义类型，携带该组参数数据）；
// 分组增删/排序/改名后端口跟随（ModelsCombo 经验：按名/按 id 复用 socket、原地重排、更新 o.links origin_slot、
// 立即 POST /param_preset_control/outputs 同步类 RETURN_TYPES，并通知已连接的 ParamPresetOutput 刷新）。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  NODE_TYPES, registerNode, unregisterNode, nodeTypeOf,
  configWidget, writeConfig, readConfig,
  loadPresets, savePreset, deletePreset, uiPrompt, uiConfirm, installResizeHandles, makeDomWidgetHitThrough,
} from "./ezflex_service.js";

const NODE = NODE_TYPES.PARAM_CTRL;
const API = "/param_preset_control/presets";
const DEFAULT_PRESET = "default";
const TYPES = ['int', 'float', 'string', 'bool', 'complex', 'tuple', 'list', 'set', 'dictionary'];
// 轻量 Python-字面量解析器：字典/列表/元组/集合 + 单引号 + 嵌套 + True/False/None
function parsePyLiteral(str) {
  const s = String(str);
  let i = 0;
  function skip() { while (i < s.length && /[\s\t\n\r]/.test(s[i])) i++; }
  function parseStr(q) {
    i++; let out = '';
    while (i < s.length) { const c = s[i]; if (c === '\\') { out += s[i + 1] || ''; i += 2; continue; } if (c === q) { i++; return out; } out += c; i++; }
    return out;
  }
  function parseScalar() {
    skip();
    const ch = s[i];
    if (ch === '"' || ch === "'") return parseStr(ch);
    if (ch === '[' || ch === '(' || ch === '{') return parseContainer(ch);
    let j = i;
    while (j < s.length && !/[\s,}\]\]\)]/.test(s[j])) j++;
    const tok = s.slice(i, j); i = j;
    if (/^[+-]?\d+$/.test(tok)) return parseInt(tok, 10);
    if (/^[+-]?\d*\.\d+([eE][+-]?\d+)?$/.test(tok)) return parseFloat(tok);
    if (tok === 'True') return true;
    if (tok === 'False') return false;
    if (tok === 'None') return null;
    return tok.replace(/^["']|["']$/g, '');
  }
  function parseContainer(open) {
    const close = open === '[' ? ']' : open === '(' ? ')' : '}';
    const isDict = open === '{';
    i++; skip();
    if (s[i] === close) { i++; return isDict ? {} : []; }
    const arr = []; const obj = {}; let sawColon = false;
    while (true) {
      skip();
      if (isDict) {
        const k = parseScalar(); skip();
        if (s[i] === ':') { i++; sawColon = true; obj[String(k)] = parseScalar(); }
        else { arr.push(k); } // 集合（无冒号）元素
      } else {
        arr.push(parseScalar());
      }
      skip();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === close) { i++; break; }
      break;
    }
    if (isDict && !sawColon) return arr; // 无冒号 => 集合，返回数组
    return isDict ? obj : arr;
  }
  skip();
  return parseScalar();
}
// 类型感知且严格：只有容器的包围形式匹配类型才解析成原生，否则保留 string（输出即 string）
function parseParamValue(raw, type) {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim();
  if (type === 'string') return raw;
  if (type === 'int') return /^-?\d+$/.test(t) ? parseInt(t, 10) : raw;
  if (type === 'float') return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t) ? parseFloat(t) : raw;
  if (type === 'bool') return /^(true|false|True|False)$/.test(t) ? (t === 'true' || t === 'True') : raw;
  if (type === 'list') return (t.startsWith('[') && t.endsWith(']')) ? parsePyLiteral(t) : raw;
  if (type === 'tuple') return (t.startsWith('(') && t.endsWith(')')) ? parsePyLiteral(t) : raw;
  if (type === 'set') return (t.startsWith('{') && t.endsWith('}') && !t.includes(':')) ? parsePyLiteral(t) : raw;
  if (type === 'dictionary') {
    if (!(t.startsWith('{') && t.endsWith('}') && t.includes(':'))) return raw;
    const v = parsePyLiteral(t);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : raw;
  }
  if (type === 'complex') return raw; // 复数按字符串保留（输出即字符串）
  return raw;
}

const CSS = `
.ezpc-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezpc-shell .ezpc-root{pointer-events:auto;}
.ezpc-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:#1a1a2e;background:#fff;border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.ezpc-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.ezpc-hd{display:flex;gap:6px;align-items:center;flex-wrap:nowrap;min-width:0;} /* 工具条单行不换行 */
.ezpc-hd select,.ezpc-row input,.ezpc-row select{appearance:none;background:#f7f9fd;border:1px solid #dce3ec;border-radius:10px;padding:5px 28px 5px 12px;font-size:12px;font-weight:450;color:#1a1f2b;font-family:inherit;outline:none;height:30px;line-height:1;}
.ezpc-hd select{flex:1 1 0;min-width:0;} /* 基准 0：宽度只按剩余空间分配，不跟随预设名变长；不换行时靠它让位 */
.ezpc-hd input{flex:1 1 90px;min-width:80px;}
.ezpc-hd select:focus,.ezpc-row input:focus{border-color:#8fa7c5;}
.ezpc-btn{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:#1f2937;font-family:inherit;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;height:30px;line-height:1;}
.ezpc-btn:hover{background:#edf2fa;border-color:#bcc9db;}
.ezpc-btn.success{background:#ecfdf3;border-color:#a7f0c6;color:#065f46;}
.ezpc-btn.success:hover{background:#d1fae5;}
.ezpc-btn.danger{background:#fef2f2;border-color:#fecaca;color:#991b1b;}
.ezpc-btn.danger:hover{background:#fee2e2;}
.ezpc-btn.warn{background:#fffbeb;border-color:#fcd34d;color:#92400e;}
.ezpc-btn.warn:hover{background:#fef3c7;}
.ezpc-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;}
.ezpc-gitem{display:flex;align-items:center;gap:8px;background:#fbfcfe;border:1px solid #eef2f8;border-radius:10px;padding:6px 8px;flex-wrap:nowrap;min-width:0;} /* 单行不换行：名称过长时省略号截断 */
.ezpc-gitem.dragging{opacity:.4;}
.ezpc-handle{cursor:grab;color:#8a99ae;font-size:14px;line-height:1;padding:0 2px;}
.ezpc-handle:hover{color:#1a1a2e;}
.ezpc-gname{font-size:12px;font-weight:500;flex:1 1 80px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#1a1f2b;}
.ezpc-gcnt{font-size:10px;color:#5f6b7a;background:#eef2f7;padding:0 10px;border-radius:100px;line-height:20px;white-space:nowrap;flex:0 0 auto;} /* 「N 个参数」不许被压成两行 */
.ezpc-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:14px;}
.ezpc-ph{height:0;border-top:3px solid #2b3a4a;border-radius:2px;margin:1px 0;opacity:.9;box-shadow:0 1px 6px rgba(43,58,74,.35);}
.ezpc-ph.hidden{display:none;}
.ezpc-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:9999;background:rgba(0,0,0,.35);}
.ezpc-modal.active{display:flex;}
.ezpc-modal-box{background:#fff;border-radius:16px;padding:16px 18px;width:92%;max-width:560px;max-height:84vh;display:flex;flex-direction:column;gap:12px;box-shadow:0 20px 60px rgba(0,0,0,.2);font-family:Inter,sans-serif;}
.ezpc-modal-hd{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f4fc;padding-bottom:10px;}
.ezpc-modal-hd b{font-size:14px;color:#0f141f;}
.ezpc-modal-body{overflow-y:auto;display:flex;flex-direction:column;gap:10px;flex:1;}
.ezpc-gname-input{width:100%;padding:7px 11px;border:1px solid #dce3ec;border-radius:10px;font-size:13px;font-family:inherit;outline:none;color:#1a1f2b;background:#f7f9fd;transition:border .15s;}
.ezpc-gname-input:focus{border-color:#8fa7c5;background:#fff;}
.ezpc-params{display:flex;flex-direction:column;gap:6px;}
.ezpc-pitem{display:flex;align-items:center;gap:6px;background:#f9fbfd;border:1px solid #f0f4fc;border-radius:9px;padding:5px 8px;flex-wrap:wrap;}
.ezpc-pitem input,.ezpc-pitem select,.ezpc-pitem textarea{font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;background:#fff;color:#1a1f2b;outline:none;padding:4px 8px;box-sizing:border-box;}
.ezpc-pitem input:focus,.ezpc-pitem select:focus,.ezpc-pitem textarea:focus{border-color:#8fa7c5;}
.ezpc-pitem input.invalid,.ezpc-pitem textarea.invalid{border-color:#ef4444;box-shadow:0 0 0 2px rgba(239,68,68,.18);}
.ezpc-pname{flex:1 1 70px;min-width:60px;}
.ezpc-ptype{width:96px;}
.ezpc-enable{width:22px;height:22px;border-radius:50%;border:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;color:#fff;transition:filter .12s;flex:0 0 auto;padding:0;}
.ezpc-enable.on{background:#17a34a;}
.ezpc-enable.off{background:#e34d4d;}
.ezpc-enable:hover{filter:brightness(1.1);}
.ezpc-gsel{appearance:none;-webkit-appearance:none;background-color:#f7f9fd;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='6' viewBox='0 0 12 6'><path d='M1 1l5 4 5-4' fill='none' stroke='%235f6b7a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");background-repeat:no-repeat;background-position:right 6px center;border:1px solid #dce3ec;border-radius:8px;padding:3px 22px 3px 8px;font-size:11px;font-weight:450;color:#1f2937;font-family:inherit;outline:none;height:24px;line-height:1;max-width:150px;flex:0 1 120px;min-width:64px;} /* 固定 120px：选项文字（参数名）再长也不撑宽 */
.ezpc-pvalue{flex:1 1 70px;min-width:60px;min-height:28px;max-height:120px;resize:both;overflow-y:auto;white-space:pre-wrap;word-break:break-all;line-height:1.4;}
.ezpc-pvalue::-webkit-resizer{background:transparent;}
.ezpc-pvalue::-webkit-scrollbar{width:8px;height:8px;}
.ezpc-pvalue::-webkit-scrollbar-thumb{background:#c9d3e0;border-radius:6px;}
.ezpc-modal-ft{display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #f0f4fc;padding-top:10px;}
.ezpc-modal-box input,.ezpc-modal-box select,.ezpc-modal-box textarea{user-select:text;-webkit-user-select:text;pointer-events:auto;}
.ezpc-modal input,.ezpc-modal select{pointer-events:auto;}
`;

let _styleInjected = false;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
function genId() { return 'x_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
function deepClone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return Array.isArray(o) ? [] : {}; } }
// 参数组实际输出的参数：全部绿色(启用)参数；若组设了 out（单个参数 id）则只保留该参数。
function activeParams(group) {
  const enabled = ((group && group.params) || []).filter((p) => p.enabled !== false);
  const out = group && group.out;
  if (out && out !== 'all') return enabled.filter((p) => String(p.id) === String(out));
  return enabled;
}
function groupOutCount(group) { return activeParams(group).length; }
// 若组选中的单个参数被红色(禁用)或删除，则回退到「全部」。
function normalizeGroupOut(group) {
  if (!group) return;
  const out = group.out;
  if (out && out !== 'all' && !(group.params || []).some((p) => String(p.id) === String(out) && p.enabled !== false)) group.out = 'all';
}

// 参数值是否与类型匹配（模糊校验，焦点失去时标红提示）
function valueMismatch(pvalue, ptype) {
  const s = String(pvalue == null ? '' : pvalue).trim();
  if (ptype === 'int') return !/^-?\d+$/.test(s);
  if (ptype === 'float') return !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s);
  if (ptype === 'bool' || ptype === 'string') return false; // 非空即有效
  if (ptype === 'list') return !(s.startsWith('[') && s.endsWith(']'));
  if (ptype === 'tuple') return !(s.startsWith('(') && s.endsWith(')'));
  if (ptype === 'set') return !(s.startsWith('{') && s.endsWith('}'));
  if (ptype === 'dictionary') {
    if (!(s.startsWith('{') && s.endsWith('}'))) return true;
    try { return typeof JSON.parse(s) !== 'object'; } catch (_) { return !s.includes(':'); }
  }
  if (ptype === 'complex') return !(s === '' || (/\d/.test(s) && !/\s/.test(s)));
  return false;
}
function validateParamValue(input, p) {
  const ok = !valueMismatch(input.value, p.type);
  input.classList.toggle('invalid', !ok);
  input.title = ok ? '' : '类型不匹配';
}

// ===== 状态 =====
function stateFor(node) {
  if (!node._ezParam) node._ezParam = { groups: [], current: DEFAULT_PRESET, dirty: false, editingId: null };
  return node._ezParam;
}
function loadFromConfig(node) {
  const st = stateFor(node);
  const cfg = readConfig(node, {});
  st.groups = Array.isArray(cfg.groups) ? cfg.groups : [];
  st.groups.forEach((g) => { if (g && g.out == null) g.out = 'all'; if (g && !Array.isArray(g.params)) g.params = []; (g.params || []).forEach((p) => { if (p && typeof p.value === 'string') { p._raw = p.value; p.value = parseParamValue(p.value, p.type); } }); normalizeGroupOut(g); });
  st.current = (typeof cfg.current === 'string' && cfg.current) ? cfg.current : DEFAULT_PRESET;
  st.dirty = false;
}
function syncToConfig(node) {
  const st = stateFor(node);
  writeConfig(node, { groups: st.groups, current: st.current });
}

function presetNames() {
  return loadPresets(API).then((list) => {
    const names = list.map((p) => p.name);
    if (names.indexOf(DEFAULT_PRESET) < 0) names.unshift(DEFAULT_PRESET);
    return names;
  });
}
function findPreset(name) {
  return loadPresets(API).then((list) => {
    const p = list.find((x) => x.name === name || x.label === name);
    if (p) return p;
    if (name === DEFAULT_PRESET) return { name: DEFAULT_PRESET, label: 'default', groups: [] };
    return null;
  });
}
// default 作为真实预设存服务器（首启自动补一个空 default），保存同名会覆盖
async function ensureDefaultPreset() {
  const list = await loadPresets(API);
  if (!list.some((p) => p.name === DEFAULT_PRESET)) {
    await savePreset(API, { name: DEFAULT_PRESET, label: 'default', groups: [] });
  }
}

async function setCurrentPreset(node, name) {
  const st = stateFor(node);
  if (st.dirty && name !== st.current) {
    const save = await uiPrompt(`当前有未保存修改，输入名称保存到「${st.current}」（留空=放弃）`, st.current);
    if (save != null && save.trim()) await savePresetToLib(node, save.trim());
  }
  const p = await findPreset(name);
  if (!p) { refreshUI(node); return; }
  st.groups = deepClone(p.groups || []);
  st.groups.forEach((g) => { if (g && g.out == null) g.out = 'all'; if (g && !Array.isArray(g.params)) g.params = []; (g.params || []).forEach((pp) => { if (pp && typeof pp.value === 'string') { pp._raw = pp.value; pp.value = parseParamValue(pp.value, pp.type); } }); normalizeGroupOut(g); });
  st.current = p.name;
  st.dirty = false;
  syncToConfig(node);
  updatePorts(node);
  refreshUI(node);
}
async function savePresetToLib(node, forcedName) {
  const st = stateFor(node);
  const name = forcedName != null ? forcedName : await uiPrompt('请输入预设名称', st.current === DEFAULT_PRESET ? '新预设' : st.current);
  if (!name || !name.trim()) return;
  await savePreset(API, { name: name.trim(), label: name.trim(), groups: deepClone(st.groups) });
  st.current = name.trim(); st.dirty = false; syncToConfig(node); refreshUI(node);
}
async function deletePresetFromLib(node) {
  const st = stateFor(node);
  if (st.current === DEFAULT_PRESET) return;
  await deletePreset(API, st.current);
  st.current = DEFAULT_PRESET; st.dirty = false; syncToConfig(node); updatePorts(node); refreshUI(node);
}
async function resetAll(node) {
  const st = stateFor(node);
  st.groups = []; st.current = DEFAULT_PRESET; st.dirty = false; syncToConfig(node); updatePorts(node); refreshUI(node);
}

// ===== 分组操作 =====
function markDirty(node) { stateFor(node).dirty = true; syncToConfig(node); updatePorts(node); refreshUI(node); }
function addGroup(node) {
  const st = stateFor(node);
  st.groups.push({ id: genId(), name: `参数组 ${st.groups.length + 1}`, out: 'all', params: [] });
  markDirty(node);
}
function deleteGroup(node, groupId) {
  const st = stateFor(node);
  const i = st.groups.findIndex((g) => g.id === groupId);
  if (i < 0) return;
  st.groups.splice(i, 1);
  markDirty(node);
}

// ===== 编辑弹窗 =====
let _modal = null;
function modalEl() {
  if (_modal && _modal.parentNode) return _modal;
  _modal = el('div', 'ezpc-modal');
  const box = el('div', 'ezpc-modal-box');
  box.style.cssText = (box.style.cssText || '') + ';pointer-events:auto;user-select:text;-webkit-user-select:text;';
  const hd = el('div', 'ezpc-modal-hd');
  const title = el('b'); title.textContent = '编辑参数组';
  const closeBtn = el('button', 'ezpc-btn danger'); closeBtn.textContent = '✕';
  hd.appendChild(title); hd.appendChild(closeBtn);
  const body = el('div', 'ezpc-modal-body');
  const nameInput = el('input', 'ezpc-gname-input'); nameInput.placeholder = '参数组名称';
  const params = el('div', 'ezpc-params');
  const addParamBtn = el('button', 'ezpc-btn success'); addParamBtn.textContent = '+ 新增参数';
  body.appendChild(nameInput);
  const paramsHd = el('div'); paramsHd.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
  const paramsLbl = el('span'); paramsLbl.textContent = '参数列表'; paramsLbl.style.cssText = 'font-size:12px;font-weight:500;color:#1a1a2e;';
  paramsHd.appendChild(paramsLbl); paramsHd.appendChild(addParamBtn);
  body.appendChild(paramsHd); body.appendChild(params);
  const ft = el('div', 'ezpc-modal-ft');
  const okBtn = el('button', 'ezpc-btn success'); okBtn.textContent = '确认修改';
  const cancelBtn = el('button', 'ezpc-btn'); cancelBtn.textContent = '取消';
  ft.appendChild(okBtn); ft.appendChild(cancelBtn);
  box.appendChild(hd); box.appendChild(body); box.appendChild(ft);
  _modal.appendChild(box); document.body.appendChild(_modal);
  _modal._nameInput = nameInput; _modal._params = params; _modal._addParam = addParamBtn;
  _modal._ok = okBtn; _modal._cancel = cancelBtn; _modal._close = closeBtn;
  return _modal;
}
function openEditModal(node, groupId) {
  const st = stateFor(node);
  const group = st.groups.find((g) => g.id === groupId);
  if (!group) return;
  st.editingId = groupId;
  st._editBackup = deepClone(group);
  const m = modalEl();
  m._node = node; // 记录当前编辑节点，确保弹窗按钮始终作用于它（多实例时防串）
  m._nameInput.value = group.name;
  renderParamList(node);
  m.classList.add('active');
}
function cancelModal(node) {
  const st = stateFor(node);
  if (st.editingId != null && st._editBackup) {
    const i = st.groups.findIndex((g) => g.id === st.editingId);
    if (i >= 0) st.groups[i] = st._editBackup;
    updatePorts(node); // 还原后端口跟着还原
    notifyOutputs(node); // 端口未变时也要让已连接的 Output 刷新面板
    refreshUI(node);
  }
  st.editingId = null; st._editBackup = null;
  const m = modalEl(); m.classList.remove('active');
}
function confirmModal(node) {
  const st = stateFor(node);
  if (st.editingId != null) {
    const group = st.groups.find((g) => g.id === st.editingId);
    if (group) {
      const nm = modalEl()._nameInput.value.trim();
      if (!nm) return;
      group.name = nm;
      st.dirty = true; syncToConfig(node); updatePorts(node); notifyOutputs(node); refreshUI(node);
    }
  }
  st.editingId = null; st._editBackup = null;
  modalEl().classList.remove('active');
}
function renderParamList(node) {
  try {
    const st = stateFor(node);
    const group = st.groups.find((g) => g.id === st.editingId);
    const container = modalEl()._params;
    if (!group) { container.innerHTML = ''; return; }
    container.innerHTML = '';
    if (!(group.params || []).length) { const e = el('div', 'ezpc-empty'); e.textContent = '暂无参数，点「+ 新增参数」添加'; container.appendChild(e); }
    (group.params || []).forEach((p) => container.appendChild(renderParamItem(node, p)));
    attachDnD(container, '.ezpc-pitem', '.ezpc-handle', (from, to) => {
      const arr = group.params || [];
      const [it] = arr.splice(from, 1);
      arr.splice(to, 0, it);
      st.dirty = true;
      // 弹窗编辑中不落 config，但让已连接的 Output 实时跟随参数顺序/数量
      notifyOutputs(node);
      renderParamList(node);
    });
  } catch (_) {}
}
function renderParamItem(node, p) {
  const row = el('div', 'ezpc-pitem');
  const handle = el('span', 'ezpc-handle'); handle.textContent = '⠿';
  const isOn = p.enabled !== false;
  const enable = el('button', 'ezpc-enable ' + (isOn ? 'on' : 'off'));
  enable.title = isOn ? '使用该参数' : '不使用该参数';
  enable.addEventListener('click', () => {
    const st = stateFor(node);
    const grp = st.groups.find((g) => g.id === st.editingId);
    if (!grp) return;
    p.enabled = (p.enabled !== false) ? false : true;
    normalizeGroupOut(grp);
    st.dirty = true;
    const on = p.enabled !== false;
    enable.classList.toggle('on', on); enable.classList.toggle('off', !on);
    enable.title = on ? '使用该参数' : '不使用该参数';
    updatePorts(node);
    refreshUI(node);
  });
  const name = el('input', 'ezpc-pname'); name.value = p.name || ''; name.placeholder = '参数名';
  name.addEventListener('input', () => { p.name = name.value || '未命名'; });
  const type = el('select', 'ezpc-ptype');
  TYPES.forEach((t) => { const o = el('option'); o.value = t; o.textContent = t; if (t === (p.type || 'int')) o.selected = true; type.appendChild(o); });
  type.addEventListener('change', () => { p.type = type.value; });
  const value = el('textarea', 'ezpc-pvalue'); value.value = (p._raw != null ? p._raw : (p.value != null ? String(p.value) : '')); value.placeholder = '参数值'; value.rows = 1; value.spellcheck = false;
  const autosize = () => { value.style.height = 'auto'; const h = Math.min(120, Math.max(28, value.scrollHeight + 2)); value.style.height = h + 'px'; value.style.overflowY = value.scrollHeight > 116 ? 'auto' : 'hidden'; };
  const normalizeValue = () => { const raw = value.value; p._raw = raw; p.value = parseParamValue(raw, p.type); };
  value.addEventListener('input', () => { p.value = value.value; autosize(); });
  value.addEventListener('change', () => { normalizeValue(); validateParamValue(value, p); });
  value.addEventListener('blur', () => { normalizeValue(); validateParamValue(value, p); });
  value.addEventListener('blur', () => validateParamValue(value, p));
  autosize();
  const del = el('button', 'ezpc-btn danger'); del.textContent = '×'; del.title = '删除参数';
  del.addEventListener('click', () => {
    const st = stateFor(node);
    const group = st.groups.find((g) => g.id === st.editingId);
    if (!group) return;
    const i = (group.params || []).indexOf(p);
    if (i >= 0) { group.params.splice(i, 1); normalizeGroupOut(group); st.dirty = true; updatePorts(node); refreshUI(node); renderParamList(node); }
  });
  row.appendChild(handle); row.appendChild(name); row.appendChild(enable); row.appendChild(type); row.appendChild(value); row.appendChild(del);
  return row;
}
function addParamToModal(node) {
  const st = stateFor(node);
  const group = st.groups.find((g) => g.id === st.editingId);
  if (!group) return;
  (group.params = group.params || []).push({ id: genId(), name: `参数${group.params.length + 1}`, type: 'int', value: '0', enabled: true });
  st.dirty = true;
  updatePorts(node);
  refreshUI(node);
  renderParamList(node);
}

// ===== 通用指针拖拽排序（Node 2.0 用 Pointer Events + window 捕获阶段）=====
function attachDnD(container, itemSel, handleSel, onDrop) {
  container.querySelectorAll('.ezpc-ph').forEach((x) => x.remove());
  const placeholder = el('div', 'ezpc-ph hidden');
  container.appendChild(placeholder);
  const bind = () => {
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
  };
  bind();
}

// ===== 动态输出端口（ModelsCombo 经验）=====
function wantPorts(node) {
  return (stateFor(node).groups || []).map((g) => ({ id: g.id, name: (g.name || '参数组'), type: 'EZFLEX_PARAM_GROUP' }));
}
function syncOutputTypes(node) {
  try {
    const fetcher = (api && typeof api.fetchApi === 'function') ? (p, o) => api.fetchApi(p, o) : (p, o) => fetch(p, o);
    fetcher('/param_preset_control/outputs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups: stateFor(node).groups }) }).catch(() => {});
  } catch (_) {}
}
function notifyOutputs(node) {
  const graph = node.graph;
  (node.outputs || []).forEach((o) => {
    const ids = [];
    if (Array.isArray(o.links)) ids.push(...o.links);
    if (o.link != null) ids.push(o.link);
    ids.forEach((lid) => {
      if (lid == null || !graph || !graph.links || !graph.links[lid]) return;
      const target = graph.links[lid].target_id != null ? findNodeInGraph(graph, graph.links[lid].target_id) : null;
      if (target && target._ezOutAPI && typeof target._ezOutAPI.update === 'function') {
        try { target._ezOutAPI.update(); } catch (_) {}
      }
    });
  });
}
function findNodeInGraph(graph, id) {
  if (graph && typeof graph.getNodeById === 'function') { try { return graph.getNodeById(id); } catch (_) {} }
  return ((graph && graph._nodes) || []).find((n) => n && String(n.id) === String(id)) || null;
}
function updatePorts(node, noRedraw) {
  if (!node || !node.outputs) return false;
  const want = wantPorts(node);
  let changed = false;

  // Load/重启窗口守卫：当前输出 socket 上还有连线，但对应 link 对象还没进 graph.links（链路未恢复）。
  // 此时不要删/重建 socket（否则下游 Control->Output 连线会丢），延迟到链路就绪后处理。
  const linkObjMissing = (node.outputs || []).some((o) => {
    const ids = [];
    if (Array.isArray(o.links)) ids.push(...o.links);
    if (o.link != null) ids.push(o.link);
    return ids.some((lid) => !(node.graph && node.graph.links && node.graph.links[lid]));
  });
  if (linkObjMissing) {
    if (node._ezParamSyncTimer) clearTimeout(node._ezParamSyncTimer);
    node._ezParamSyncTimer = setTimeout(() => { node._ezParamSyncTimer = null; try { updatePorts(node, true); } catch (_) {} }, 250);
    if (node.graph) node.graph.setDirtyCanvas(true, true);
    return false;
  }

  // 参数组 socket：优先按 _ezGroupId 匹配复用；加载后未打标的旧 socket 按位置复用（保留其 link），
  // 不足才新建。顺序 = want（与 groups 同序，位置即组序）。
  const old = (node.outputs || []).slice();
  const used = new Set();
  const seq = [];
  let dotChanged = false;
  const grpById = {};
  (stateFor(node).groups || []).forEach((g) => { grpById[String(g.id)] = g; });
  want.forEach((w, wi) => {
    let sock = null;
    // 1) 优先按 _ezGroupId 精确复用（同组在预设切换/拖动排序后仍在时，id 不变）
    for (let i = 0; i < old.length; i++) {
      if (!used.has(i) && old[i]._ezGroupId != null && String(old[i]._ezGroupId) === String(w.id)) { sock = old[i]; used.add(i); break; }
    }
    // 2) 换预设/重排时组 id 可能变了：只要“输出端口还在”（仍有旧 socket 可顶替该槽位）就**按位置复用旧 socket**，
    //    保留 Control→Output 的连线（类型 EZFLEX_PARAM_GROUP 恒同，不与下游起冲突），只在 _ezGroupId/name 上改写。
    if (!sock) {
      for (let i = 0; i < old.length; i++) {
        if (!used.has(i)) { sock = old[i]; used.add(i); break; }
      }
    }
    // 3) 无旧 socket 可复用 → 新建（无连接）
    if (!sock) {
      node.addOutput(w.name, w.type, {});
      sock = node.outputs[node.outputs.length - 1];
      changed = true;
    }
    // 注意：位置复用会覆盖 _ezGroupId，Output 侧 connectedGroup 读到的就是新组 id，经 notifyOutputs 后自行重算参数端口。
    if (sock._ezGroupId !== w.id) { sock._ezGroupId = w.id; changed = true; }
    if (sock.name !== w.name) { sock.name = w.name; changed = true; }
    if (sock.type !== w.type) { try { sock.type = w.type; } catch (_) {} changed = true; }
    try { sock.label = ''; } catch (_) {} // 只露圆点，不显示 socket 文字
    sock.hideName = true;
    sock.hidden = false;
    // 输出端口圆点：输出多个生效参数=红，仅输出一个=灰
    const dot = groupOutCount(grpById[String(w.id)]) > 1 ? '#d94848' : '#98a3b3';
    if (sock.color_on !== dot) { sock.color_on = dot; sock.color_off = dot; sock.color = dot; dotChanged = true; }
    seq.push(sock);
  });
  // 删除未被复用的旧 socket（含 _ezGroupId 不在 want 的；其连线随 removeOutput 一并清掉）
  old.forEach((o, i) => {
    if (!used.has(i)) {
      const idx = node.outputs.indexOf(o);
      if (idx >= 0) { node.removeOutput(idx); changed = true; }
    }
  });
  if (node.outputs.length !== seq.length || node.outputs.some((o, i) => o !== seq[i])) {
    node.outputs.splice(0, node.outputs.length, ...seq);
    changed = true;
  }
  node.outputs.forEach((o, i) => {
    const ids = [];
    if (Array.isArray(o.links)) ids.push(...o.links);
    if (o.link != null) ids.push(o.link);
    ids.forEach((lid) => {
      if (lid != null && node.graph && node.graph.links && node.graph.links[lid]) {
        try { node.graph.links[lid].origin_slot = i; } catch (_) {}
      }
    });
  });
  if (changed) {
    if (node.graph) node.graph.setDirtyCanvas(true, true);
    syncOutputTypes(node);
  } else if (dotChanged && node.graph) {
    node.graph.setDirtyCanvas(true, true);
  }
  // out/启用 变化不影响本节点端口结构，但必须通知已连接的 Output 重算其端口
  notifyOutputs(node);
  return changed;
}

// ===== 实例 API（供 MainControl / ParamPresetOutput 调用）=====
function ensureAPI(node) {
  if (node._ezParamAPI) return;
  node._ezParamAPI = {
    presetNames: () => presetNames(),
    setCurrent: (name) => setCurrentPreset(node, name),
    current: () => stateFor(node).current,
    refresh: () => refreshUI(node),
    getGroup: (groupId) => (stateFor(node).groups || []).find((g) => String(g.id) === String(groupId)) || null,
    groups: () => stateFor(node).groups,
  };
}

// ===== 渲染 =====
function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'ezpc-shell');
  const root = el('div', 'ezpc-root');
  shell.appendChild(root);
  node._ezRoot = shell; // 先挂引用，render()/fitNode 内部要用
  const hd = el('div', 'ezpc-hd');
  const presetSel = el('select'); presetSel.title = '预设';
  const saveBtn = el('button', 'ezpc-btn success'); saveBtn.textContent = '保存';
  const delBtn = el('button', 'ezpc-btn danger'); delBtn.textContent = '删除';
  const resetBtn = el('button', 'ezpc-btn warn'); resetBtn.textContent = '重置';
  const addGroupBtn = el('button', 'ezpc-btn'); addGroupBtn.textContent = '+ 新增参数组';
  hd.appendChild(presetSel); hd.appendChild(saveBtn); hd.appendChild(delBtn); hd.appendChild(resetBtn); hd.appendChild(addGroupBtn);
  const list = el('div', 'ezpc-list');
  root.appendChild(hd); root.appendChild(list);

  async function render() {
    const st = stateFor(node);
    const opts = await presetNames();
    presetSel.innerHTML = '';
    if (opts.indexOf(st.current) < 0) { st.current = DEFAULT_PRESET; syncToConfig(node); }
    opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; presetSel.appendChild(o); });

    list.innerHTML = '';
    if (!st.groups.length) { list.appendChild(el('div', 'ezpc-empty')).textContent = '暂无参数组，点「+ 新增参数组」添加'; }
    st.groups.forEach((g) => list.appendChild(renderGroupItem(node, g)));
    attachDnD(list, '.ezpc-gitem', '.ezpc-handle', (from, to) => {
      const [it] = st.groups.splice(from, 1);
      st.groups.splice(to, 0, it);
      markDirty(node);
    });
    fitNode(node);
  }

  presetSel.addEventListener('change', () => setCurrentPreset(node, presetSel.value));
  presetSel.addEventListener('mousedown', () => refreshPresetOptions(node, presetSel));
  saveBtn.addEventListener('click', () => savePresetToLib(node));
  delBtn.addEventListener('click', () => deletePresetFromLib(node));
  resetBtn.addEventListener('click', () => resetAll(node));
  addGroupBtn.addEventListener('click', () => addGroup(node));

  const m = modalEl();
  m._ok.onclick = () => confirmModal(m._node || node);
  m._cancel.onclick = () => cancelModal(m._node || node);
  m._close.onclick = () => cancelModal(m._node || node);
  m._addParam.onclick = () => addParamToModal(m._node || node);
  m.addEventListener('pointerdown', (e) => { m._downOnBackdrop = (e.target === m); });
  m.addEventListener('click', (e) => {
    if (e.target === m && m._downOnBackdrop && stateFor(m._node || node).editingId != null) confirmModal(m._node || node);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalEl().classList.contains('active') && stateFor(m._node || node).editingId != null) cancelModal(m._node || node); });

  render();
  return shell;
}

// 参数组卡片「输出端口参数」下拉：全部(绿色生效) + 每个当前绿色的参数名，值 = 参数 id。
function fillGroupOutOptions(sel, g) {
  const enabled = ((g && g.params) || []).filter((p) => p.enabled !== false);
  normalizeGroupOut(g);
  sel.innerHTML = '';
  const all = el('option'); all.value = 'all'; all.textContent = '全部';
  sel.appendChild(all);
  enabled.forEach((p) => { const o = el('option'); o.value = p.id; o.textContent = p.name || '参数'; sel.appendChild(o); });
  sel.value = (g.out && g.out !== 'all' && enabled.some((p) => String(p.id) === String(g.out))) ? g.out : 'all';
}
function renderGroupItem(node, g) {
  const row = el('div', 'ezpc-gitem');
  row.dataset.id = g.id;
  const handle = el('span', 'ezpc-handle'); handle.textContent = '⠿';
  const name = el('span', 'ezpc-gname'); name.textContent = g.name || '未命名'; name.title = g.name || '未命名';
  const sel = el('select', 'ezpc-gsel'); sel.title = '输出端口参数';
  fillGroupOutOptions(sel, g);
  sel.addEventListener('mousedown', () => fillGroupOutOptions(sel, g));
  sel.addEventListener('change', () => {
    const st = stateFor(node);
    const grp = st.groups.find((x) => x.id === g.id);
    if (!grp) return;
    grp.out = sel.value;
    normalizeGroupOut(grp);
    markDirty(node);
  });
  const cnt = el('span', 'ezpc-gcnt'); cnt.textContent = `${(g.params || []).length} 个参数`;
  const editBtn = el('button', 'ezpc-btn'); editBtn.textContent = '编辑';
  const delBtn = el('button', 'ezpc-btn danger'); delBtn.textContent = '×'; delBtn.title = '删除参数组';
  editBtn.addEventListener('click', () => openEditModal(node, g.id));
  delBtn.addEventListener('click', async () => {
    if (await uiConfirm(`确定删除参数组「${g.name || ''}」吗？`)) deleteGroup(node, g.id);
  });
  row.appendChild(handle); row.appendChild(name); row.appendChild(sel); row.appendChild(cnt); row.appendChild(editBtn); row.appendChild(delBtn);
  return row;
}

function refreshPresetOptions(node, sel) {
  const st = stateFor(node);
  presetNames().then((opts) => {
    if (opts.indexOf(st.current) < 0) st.current = DEFAULT_PRESET;
    sel.innerHTML = '';
    opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; sel.appendChild(o); });
  });
}
function fitNode(node) {
  try {
    const root = node && node._ezRoot && node._ezRoot.querySelector('.ezpc-root');
    if (!root || typeof node.setSize !== 'function') return;
    const cur = node.size || [0, 96];
    const contentH = root.scrollHeight + 12;
    if (contentH > cur[1] + 4) node.setSize([Math.max(320, cur[0]), Math.min(420, contentH)]);
  } catch (_) {}
}
function refreshUI(node) {
  const root = node && node._ezRoot;
  if (!root) return;
  const st = stateFor(node);
  const presetSel = root.querySelector('select');
  const list = root.querySelector('.ezpc-list');
  if (!presetSel || !list) return;
  presetNames().then((opts) => {
    if (opts.indexOf(st.current) < 0) { st.current = DEFAULT_PRESET; syncToConfig(node); }
    presetSel.innerHTML = '';
    opts.forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; if (k === st.current) o.selected = true; presetSel.appendChild(o); });
  });
  list.innerHTML = '';
  if (!st.groups.length) { list.appendChild(el('div', 'ezpc-empty')).textContent = '暂无参数组，点「+ 新增参数组」添加'; }
  st.groups.forEach((g) => list.appendChild(renderGroupItem(node, g)));
  attachDnD(list, '.ezpc-gitem', '.ezpc-handle', (from, to) => {
    const [it] = st.groups.splice(from, 1);
    st.groups.splice(to, 0, it);
    markDirty(node);
  });
}

// ===== 挂载 =====
function hideConfigWidget(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && (_in.name === 'config')) { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}

  const w = configWidget(node); if (!w || node._ezParamCfgHid) return; node._ezParamCfgHid = true;
  try {
    w.origComputeSize = w.computeSize; w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0;
    w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
    if (w.element && w.element.style) { w.element.style.display = 'none'; w.element.style.height = '0'; w.element.style.minHeight = '0'; w.element.style.maxHeight = '0'; }
  } catch (_) {}
}
function setupNode(node) {
  if (!node || node._ezParamSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') return;
    node._ezParamSetup = true;
    loadFromConfig(node);
    ensureAPI(node);
    const root = buildRoot(node);
    node._ezRoot = root;
    makeDomWidgetHitThrough(root);
    const widget = node.addDOMWidget('参数预设控制', 'ezpc-panel', root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 120, getValue: () => '{}', setValue: () => {} });
    makeDomWidgetHitThrough(widget.element || root);
    node.widgets_start_y = 0;
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
    installResizeHandles(node, root);
    try { node.setSize([430, Math.max(140, node.size ? node.size[1] : 140)]); } catch (_) {} // 初始宽度收窄 30px
    updatePorts(node, true);
    ensureDefaultPreset(); // 首启补建 default 真实预设，使同名保存可覆盖
    setTimeout(hideConfigWidget, 60, node);
  } catch (e) { console.error('[ParamPresetControl] init failed:', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__ezParamHooked) return; nt.__ezParamHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = prevCfg ? prevCfg.apply(this, arguments) : undefined; loadFromConfig(this); updatePorts(this, true); return r; };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; unregisterNode(this); try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {} this._ezParamSetup = false; return r; };
  const prevAdded = nt.prototype.onAdded; nt.prototype.onAdded = function () { const r = prevAdded ? prevAdded.apply(this, arguments) : undefined; registerNode(this); return r; };
}
app.registerExtension({
  name: 'Comfy.EzFlex.ParamPresetControl',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() { ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); },
});
