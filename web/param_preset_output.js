// EzFlex-ParamPresetOutput 参数预设输出节点。
// 输入 = 一个 EZFLEX_PARAM_GROUP 分组端口（从 ParamPresetControl 对应分组端口连线）；
// 动态输出端口 = 该分组参数数 1:1，类型按参数类型映射（int->INT/float->FLOAT/string->STRING/bool->BOOLEAN，
// 复杂类型->STRING(JSON)；禁用参数由 Control 侧输出 None）。
// 参数增删/排序/类型变化/连接变化后端口跟随（ModelsCombo 经验：按参数 id 复用 socket、原地重排、
// 更新 o.links origin_slot、POST /param_preset_output/outputs 同步类 RETURN_TYPES）。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  NODE_TYPES, nodeTypeOf, findNodeById, installResizeHandles, makeDomWidgetHitThrough,
} from "./ezflex_service.js";

const NODE = NODE_TYPES.PARAM_OUT;
const API = "/param_preset_output/outputs";
const TYPE_MAP = { int: 'INT', float: 'FLOAT', string: 'STRING', bool: 'BOOLEAN', complex: 'STRING', tuple: 'STRING', list: 'STRING', set: 'STRING', dictionary: 'STRING' };

const CSS = `
.ezo-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezo-shell .ezo-root{pointer-events:auto;}
.ezo-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:#1a1a2e;background:#fff;border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.ezo-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.ezo-hd{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;}
.ezo-title{font-weight:550;font-size:13px;color:#0f141f;}
.ezo-status{font-size:10px;color:#8a99ae;white-space:nowrap;}
.ezo-status.on{color:#065f46;font-weight:500;}
.ezo-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;}
.ezo-row{display:flex;align-items:center;gap:8px;background:#fbfcfe;border:1px solid #f0f4fc;border-radius:10px;padding:5px 8px;flex-wrap:nowrap;min-width:0;} /* 单行不换行：名称过长时省略号截断 */
.ezo-name{font-size:12px;font-weight:480;flex:1 1 80px;min-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1a1f2b;}
.ezo-type{font-size:10px;color:#5f6b7a;background:#eef2f7;padding:0 10px;border-radius:100px;line-height:20px;white-space:nowrap;flex:0 0 auto;}
.ezo-type-bad{color:#d94848;background:#fdecec;}
.ezo-value{font-size:11px;color:#1a1f2b;font-family:monospace;min-width:40px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ezo-value-long{cursor:pointer;text-decoration:underline dotted #9aa7b5;}
.ezo-row.ezo-off{opacity:.55;}
.ezo-vprev{position:fixed;z-index:9998;}
.ezo-toggle{display:flex;background:#f1f4fa;border-radius:8px;padding:2px;border:1px solid #e2e8f0;flex:0 0 auto;}
.ezo-toggle button{background:transparent;border:none;padding:2px 10px;font-size:11px;font-weight:470;color:#4d5b6d;font-family:inherit;cursor:pointer;border-radius:6px;transition:all .1s;height:24px;line-height:1;}
.ezo-toggle button.active{background:#fff;color:#0f141f;box-shadow:0 1px 4px rgba(0,0,0,.06);font-weight:510;}
.ezo-toggle button.on.active{background:#ecfdf3;color:#065f46;border:1px solid #a7f0c6;}
.ezo-toggle button.off.active{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;}
.ezo-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:14px;}
`;

let _styleInjected = false;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }

// 长值预览弹层（点缩略值展开，只读文本框可滚动/复制）
let _vprev = null;
function closeValuePreview() {
  if (_vprev && _vprev._raf) cancelAnimationFrame(_vprev._raf);
  if (_vprev && _vprev._onDown) document.removeEventListener('pointerdown', _vprev._onDown, true);
  if (_vprev && _vprev._onClick) document.removeEventListener('click', _vprev._onClick, true);
  if (_vprev && _vprev.parentNode) _vprev.remove();
  _vprev = null;
}
function openValuePreview(anchor, text) {
  if (_vprev) closeValuePreview();
  const rect = anchor.getBoundingClientRect();
  _vprev = el('div');
  _vprev.style.cssText = 'position:fixed;z-index:9998;background:#fff;border-radius:12px;border:1px solid #eef2f8;box-shadow:0 12px 40px rgba(0,0,0,.14);padding:10px 12px;width:340px;max-width:min(340px,92vw);font-family:Inter,sans-serif;box-sizing:border-box;';
  const hd = el('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f4fc;padding-bottom:6px;margin-bottom:6px;';
  const tt = el('b'); tt.textContent = '值预览'; tt.style.cssText = 'font-size:12px;color:#0f141f;';
  const close = el('button'); close.textContent = '✕'; close.style.cssText = 'background:transparent;border:none;font-size:12px;color:#8a99ae;cursor:pointer;padding:0 4px;';
  hd.appendChild(tt); hd.appendChild(close);
  const ta = el('textarea'); ta.readOnly = true; ta.spellcheck = false; ta.value = text;
  ta.style.cssText = 'width:100%;max-height:200px;min-height:64px;padding:6px 8px;border:1px solid #dce3ec;border-radius:9px;font:11px/1.5 monospace;color:#1a1f2b;background:#fbfcfe;resize:none;overflow:auto;box-sizing:border-box;outline:none;';
  _vprev.appendChild(hd); _vprev.appendChild(ta);
  _vprev.style.left = Math.min(rect.left, window.innerWidth - 356) + 'px';
  _vprev.style.top = (rect.bottom + 6) + 'px';
  document.body.appendChild(_vprev);
  // 跟随节点：每帧按锚点当前屏幕坐标重定位（画布平移/缩放时跟随）
  const follow = () => {
    if (!_vprev) return;
    const r = anchor.getBoundingClientRect();
    _vprev.style.left = Math.min(r.left, window.innerWidth - 356) + 'px';
    _vprev.style.top = (r.bottom + 6) + 'px';
    _vprev._raf = requestAnimationFrame(follow);
  };
  _vprev._raf = requestAnimationFrame(follow);
  close.addEventListener('click', () => closeValuePreview());
  setTimeout(() => {
    const onDown = (e) => { if (_vprev) _vprev._downInside = !!_vprev.contains(e.target); };
    const onClick = (e) => { if (_vprev && !_vprev._downInside && !_vprev.contains(e.target)) closeValuePreview(); };
    _vprev._onDown = onDown; _vprev._onClick = onClick;
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('click', onClick, true);
  }, 0);
}
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }

// 字典/list/set/tuple 参数值 → 可展开键值树（同 EzFlex-PreviewAny）
// 轻量 Python-字面量解析（单引号 dict/元组/集合/嵌套），供键值树使用
function parsePyLiteral(str) {
  const s = String(str); let i = 0;
  function skip() { while (i < s.length && /[\s\t\n\r]/.test(s[i])) i++; }
  function parseStr(q) { i++; let out = ''; while (i < s.length) { const c = s[i]; if (c === '\\') { out += s[i + 1] || ''; i += 2; continue; } if (c === q) { i++; return out; } out += c; i++; } return out; }
  function parseScalar() { skip(); const ch = s[i]; if (ch === '"' || ch === "'") return parseStr(ch); if (ch === '[' || ch === '(' || ch === '{') return parseContainer(ch); let j = i; while (j < s.length && !/[\s,}\]\]\)]/.test(s[j])) j++; const tok = s.slice(i, j); i = j; if (/^[+-]?\d+$/.test(tok)) return parseInt(tok, 10); if (/^[+-]?\d*\.\d+([eE][+-]?\d+)?$/.test(tok)) return parseFloat(tok); if (tok === 'True') return true; if (tok === 'False') return false; if (tok === 'None') return null; return tok.replace(/^["']|["']$/g, ''); }
  function parseContainer(open) { const close = open === '[' ? ']' : open === '(' ? ')' : '}'; const isDict = open === '{'; i++; skip(); if (s[i] === close) { i++; return isDict ? {} : []; } const arr = []; const obj = {}; let sawColon = false; while (true) { skip(); if (isDict) { const k = parseScalar(); skip(); if (s[i] === ':') { i++; sawColon = true; obj[String(k)] = parseScalar(); } else { arr.push(k); } } else { arr.push(parseScalar()); } skip(); if (s[i] === ',') { i++; continue; } if (s[i] === close) { i++; break; } break; } if (isDict && !sawColon) return arr; return isDict ? obj : arr; }
  skip();
  return parseScalar();
}
function openValueTree(anchor, type, text) {
  let data;
  try { data = JSON.parse(text); } catch (_) { try { data = parsePyLiteral(text); } catch (_) { openValuePreview(anchor, text); return; } }
  if (data == null || typeof data !== 'object') { openValuePreview(anchor, text); return; }
  const overlay = el('div', 'ezo-tree');
  overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99999;background:rgba(0,0,0,.35);';
  const box = el('div'); box.style.cssText = 'background:#fff;border-radius:16px;padding:14px 16px;width:92%;max-width:600px;max-height:84vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.2);font-family:Inter,sans-serif;box-sizing:border-box;';
  const hd = el('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f4fc;padding-bottom:8px;';
  const t = el('b'); t.textContent = type + ' 详情';
  const close = el('button'); close.textContent = '✕'; close.style.cssText = 'background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit;';
  hd.appendChild(t); hd.appendChild(close);
  const list = el('div'); list.style.cssText = 'display:flex;flex-direction:column;overflow:auto;max-height:60vh;border:1px solid #e6edf7;border-radius:9px;padding:6px;';
  box.appendChild(hd); box.appendChild(list); overlay.appendChild(box); document.body.appendChild(overlay);
  const render = (value, key, depth) => {
    const wrap = el('div'); const row = el('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;font:11px/1.5 monospace;border-bottom:1px solid #f0f4fc;padding:3px 6px;padding-left:' + (4 + depth * 16) + 'px;cursor:default;';
    if (value && typeof value === 'object') {
      const toggle = el('span'); toggle.textContent = '▸'; toggle.style.cssText = 'cursor:pointer;width:14px;text-align:center;color:#5f6b7a;flex:0 0 auto;';
      const kk = el('span'); kk.textContent = String(key) + (Array.isArray(value) ? ' [' + value.length + ']' : ' {' + Object.keys(value).length + '}');
      kk.style.cssText = 'flex:0 0 45%;color:#5f6b7a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all;';
      row.appendChild(toggle); row.appendChild(kk);
      const children = el('div'); children.style.display = 'none';
      const fn = (e) => { e.stopPropagation(); const open = toggle.textContent === '▸'; toggle.textContent = open ? '▾' : '▸'; children.style.display = open ? 'block' : 'none'; if (open && !children.childElementCount) { const l = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value); l.forEach(([k, v]) => children.appendChild(render(v, k, depth + 1))); } };
      toggle.addEventListener('click', fn); row.addEventListener('click', fn);
      wrap.appendChild(row); wrap.appendChild(children);
    } else {
      const kk = el('span'); kk.textContent = String(key); kk.style.cssText = 'flex:0 0 45%;color:#5f6b7a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all;';
      const vv = el('span'); vv.textContent = String(value); vv.style.cssText = 'flex:1 1 auto;color:#1a1f2b;word-break:break-all;white-space:pre-wrap;';
      row.appendChild(kk); row.appendChild(vv); wrap.appendChild(row);
    }
    return wrap;
  };
  const entries = Array.isArray(data) ? data.map((v, i) => [i, v]) : Object.entries(data);
  if (!entries.length) list.appendChild(el('div', 'ezo-empty')).textContent = '(空)';
  entries.forEach(([k, v]) => list.appendChild(render(v, k, 0)));
  const onDown = (e) => { overlay._downInside = !!box.contains(e.target); };
  const onClick = (e) => { if (!overlay._downInside && !box.contains(e.target)) { overlay.remove(); cleanup(); } };
  const cleanup = () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('click', onClick, true); };
  close.addEventListener('click', () => { overlay.remove(); cleanup(); });
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('click', onClick, true);
}

// ===== 读取所连分组（从输入 link -> Control 节点 -> 该分组端口）=====
function connectedGroup(node) {
  const inp = (node.inputs || [])[0];
  if (!inp || inp.link == null) return null;
  const graph = node.graph;
  const link = graph && graph.links && graph.links[inp.link];
  if (!link) return null;
  const control = findNodeById(link.origin_id) || (graph && graph._nodes ? graph._nodes.find((n) => n && String(n.id) === String(link.origin_id)) : null);
  if (!control || nodeTypeOf(control) !== NODE_TYPES.PARAM_CTRL) return null;
  const slot = link.origin_slot;
  const sock = (control.outputs || [])[slot];
  let groupId = sock && sock._ezGroupId;
  // Control 的输出与参数组 1:1（顺序一致）；加载/重启后 _ezGroupId 未打标时按槽位回退取组，避免过度依赖时序。
  if (groupId == null) {
    let groups = null;
    if (control._ezParamAPI && typeof control._ezParamAPI.groups === 'function') {
      try { groups = control._ezParamAPI.groups(); } catch (_) {}
    }
    if (!groups) {
      try {
        const w = (control.widgets || []).find((x) => x.name === 'config');
        const cfg = JSON.parse(w ? w.value : '{}') || {};
        groups = cfg.groups || [];
      } catch (_) { groups = []; }
    }
    const g = Array.isArray(groups) ? groups[slot] : null;
    if (g && g.id != null) groupId = g.id;
  }
  if (groupId == null) return null;
  let group = null;
  if (control._ezParamAPI && typeof control._ezParamAPI.getGroup === 'function') {
    group = control._ezParamAPI.getGroup(groupId);
  }
  if (!group) {
    try {
      const cfg = JSON.parse((control.widgets || []).find((w) => w.name === 'config') ? control.widgets.find((w) => w.name === 'config').value : '{}') || {};
      group = ((cfg.groups || [])).find((g) => String(g.id) === String(groupId)) || null;
    } catch (_) { group = null; }
  }
  return { control, groupId, group };
}

// 与 Control 侧一致的“实际生效参数”：全部绿色(启用)参数；若组设了 out（单个参数 id）则只保留该参数。
function activeParams(group) {
  const enabled = ((group && group.params) || []).filter((p) => p.enabled !== false);
  const out = group && group.out;
  if (out && out !== 'all') return enabled.filter((p) => String(p.id) === String(out));
  return enabled;
}

// Output 节点自身的 config widget：局部禁用参数集合（不写回控制节点，避免改到参数组卡片）。
function configWidget(node) {
  return (node.widgets || []).find((w) => w.name === 'config');
}
function readLocalOff(node) {
  const w = configWidget(node);
  if (!w) return {};
  try {
    const cfg = JSON.parse(w.value || '{}') || {};
    const off = cfg.off || [];
    const map = {};
    (Array.isArray(off) ? off : []).forEach((id) => { map[id] = true; });
    return map;
  } catch (_) { return {}; }
}
function writeLocalOff(node) {
  const w = configWidget(node);
  if (!w) return;
  const off = [];
  const map = node._ezLocalOff || {};
  Object.keys(map).forEach((k) => { if (map[k]) off.push(k); });
  w.value = JSON.stringify({ off });
  if (typeof w.callback === 'function') w.callback(w.value);
  if (node.graph) node.graph.setDirtyCanvas(true, true);
}
function hideConfigWidget(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && (_in.name === 'config')) { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}

  const w = configWidget(node);
  if (!w || w._ezOutCfgHid) return;
  w._ezOutCfgHid = true;
  try {
    w.origComputeSize = w.computeSize; w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0;
    w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
    if (w.element && w.element.style) { w.element.style.display = 'none'; w.element.style.height = '0'; w.element.style.minHeight = '0'; w.element.style.maxHeight = '0'; }
  } catch (_) {}
}

function syncOutputTypes(params) {
  try {
    const fetcher = (api && typeof api.fetchApi === 'function') ? (p, o) => api.fetchApi(p, o) : (p, o) => fetch(p, o);
    fetcher(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params: params || [] }) }).catch(() => {});
  } catch (_) {}
}

const GROUP_RED = '#d94848';

function updatePorts(node, noRedraw) {
  if (!node || !node.outputs) return false;
  const conn = connectedGroup(node);
  const group = conn ? conn.group : null;
  const active = conn ? activeParams(group) : [];
  // 只保留激活参数 socket（绿色/下拉选中）；用 slot 复用让下拉/卡片切换时接线不中断。
  const want = active.map((p) => ({ id: p.id, name: (p.name || '参数'), type: TYPE_MAP[(p.type || 'string').toLowerCase()] || 'STRING' }));
  let changed = false;

  // ---- 固定整组数据红色圆点（透传 EZFLEX_PARAM_GROUP），恒在输出最上方 ----
  // 加载/重启后 _ezFixedGroup 未打标：用输出第 0 个（约定恒为 EZFLEX_PARAM_GROUP）识别，避免被当参数 socket 复用。
  let groupSock = (node.outputs || []).find((o) => o && o._ezFixedGroup);
  if (!groupSock && (node.outputs || [])[0] && String((node.outputs || [])[0].type) === 'EZFLEX_PARAM_GROUP') {
    groupSock = (node.outputs || [])[0];
    groupSock._ezFixedGroup = true;
  }
  if (!groupSock) {
    node.addOutput('数据组合', 'EZFLEX_PARAM_GROUP', {});
    groupSock = node.outputs[node.outputs.length - 1];
    groupSock._ezFixedGroup = true;
    changed = true;
  }
  try { groupSock.label = ''; groupSock.hideName = true; groupSock.hidden = false; } catch (_) {}
  if (groupSock.color_on !== GROUP_RED) { groupSock.color_on = GROUP_RED; groupSock.color_off = GROUP_RED; groupSock.color = GROUP_RED; changed = true; }

  // ---- 参数 socket：先按参数 id 匹配复用（单->全部时保留下拉选中的参数 socket），
  //      再按位置复用加载后未打标的旧 socket（保留其 link），不足则新增 ----
  const old = (node.outputs || []).filter((o) => o && o !== groupSock);

  // 加载/链路恢复窗口守卫：此时 group 还没解析出来（graph.links 未就绪）但已有参数 socket。
  // 不要在这里收敛成只剩组 socket（会丢掉 Output->PreviewAny 的槽位），留到链路恢复后再处理。
  const inp = (node.inputs || [])[0];
  const linkId = inp && inp.link;
  const linkObj = (linkId != null && node.graph && node.graph.links) ? node.graph.links[linkId] : null;
  const deferUnresolved = !group && old.length && linkId != null && !linkObj;
  if (deferUnresolved) {
    // 链路就绪前不收缩参数 socket；稍后重试直到 group 能解析出来。
    if (node._ezOutSyncTimer) clearTimeout(node._ezOutSyncTimer);
    node._ezOutSyncTimer = setTimeout(() => { node._ezOutSyncTimer = null; try { updatePorts(node); } catch (_) {} }, 250);
    if (node.graph) node.graph.setDirtyCanvas(true, true);
    renderPanel(node, conn);
    return false;
  }
  if (node._ezOutSyncTimer) { clearTimeout(node._ezOutSyncTimer); node._ezOutSyncTimer = null; }

  const used = new Set();
  const assign = new Array(want.length).fill(-1);
  want.forEach((w, wi) => {
    for (let i = 0; i < old.length; i++) {
      if (!used.has(i) && old[i]._ezParamId != null && String(old[i]._ezParamId) === String(w.id)) { assign[wi] = i; used.add(i); break; }
    }
  });
  want.forEach((w, wi) => {
    if (assign[wi] !== -1) return;
    for (let i = 0; i < old.length; i++) {
      if (!used.has(i) && old[i]._ezParamId == null) { assign[wi] = i; used.add(i); break; }
    }
  });
  want.forEach((w, wi) => {
    if (assign[wi] !== -1) return;
    for (let i = 0; i < old.length; i++) {
      if (!used.has(i)) { assign[wi] = i; used.add(i); break; }
    }
  });
  const seq = [];
  want.forEach((w, wi) => {
    let sock = null;
    if (assign[wi] !== -1) sock = old[assign[wi]];
    else {
      node.addOutput(w.name, w.type, {});
      sock = node.outputs[node.outputs.length - 1];
      sock._ezParamId = w.id;
      changed = true;
    }
    if (sock._ezParamId !== w.id) { sock._ezParamId = w.id; changed = true; }
    if (sock.name !== w.name) { sock.name = w.name; changed = true; }
    if (sock.type !== w.type) { try { sock.type = w.type; } catch (_) {} changed = true; }
    try { sock.label = ''; sock.hideName = true; sock.hidden = false; } catch (_) {}
    seq.push(sock);
  });
  // 删除未被复用的旧参数 socket（其连线随之消失）
  old.forEach((o, i) => {
    if (!used.has(i)) {
      const idx = node.outputs.indexOf(o);
      if (idx >= 0) { node.removeOutput(idx); changed = true; }
    }
  });

  // ---- 组装最终输出：[groupSock, ...参数seq]，回写 origin_slot ----
  const finalSeq = [groupSock, ...seq];
  if (node.outputs.length !== finalSeq.length || node.outputs.some((o, i) => o !== finalSeq[i])) {
    for (let i = 0; i < finalSeq.length; i++) node.outputs[i] = finalSeq[i];
    node.outputs.length = finalSeq.length;
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
    syncOutputTypes([{ type: 'EZFLEX_PARAM_GROUP', name: '数据组合' }, ...want.map((w) => ({ type: w.type, name: w.name }))]);
  }
  renderPanel(node, conn);
  return changed;
}

// ===== 面板 =====
function renderPanel(node, conn) {
  const root = node && node._ezRoot;
  if (!root) return;
  const status = root.querySelector('.ezo-status');
  const list = root.querySelector('.ezo-list');
  if (!status || !list) return;
  if (!conn || !conn.group) {
    status.textContent = '未连接';
    status.classList.remove('on');
    list.innerHTML = '';
    list.appendChild(el('div', 'ezo-empty')).textContent = '未连接：从 ParamPresetControl 的分组端口拖线连接';
    return;
  }
  status.textContent = `已连接: ${conn.group.name || '参数组'}`;
  status.classList.add('on');
  const params = activeParams(conn.group);
  list.innerHTML = '';
  if (!params.length) { list.appendChild(el('div', 'ezo-empty')).textContent = '该参数组暂无参数'; return; }
  params.forEach((p) => list.appendChild(renderRow(node, conn, p)));
}

function renderRow(node, conn, p) {
  const row = el('div', 'ezo-row');
  // 启/禁用是 Output 节点局部的显示开关，不写回控制节点，不改变参数组卡片
  const localOff = !!(node._ezLocalOff && node._ezLocalOff[p.id]);
  if (localOff) row.classList.add('ezo-off');
  const name = el('span', 'ezo-name'); name.textContent = p.name || '参数'; name.title = p.name || '';
  const actualType = (typeof p.value === 'string' && p.type !== 'string') ? 'string' : (p.type || 'string');
  const typeMismatch = actualType !== p.type;
  const type = el('span', 'ezo-type' + (typeMismatch ? ' ezo-type-bad' : '')); type.textContent = actualType; type.title = typeMismatch ? `声明 ${p.type}，实际 ${actualType}` : '';
  const vs = p.value != null ? (typeof p.value === 'object' ? (Array.isArray(p.value) ? (p.type === 'tuple' ? '(' + p.value.join(', ') + ')' : p.type === 'set' ? '{' + p.value.join(', ') + '}' : JSON.stringify(p.value)) : JSON.stringify(p.value)) : String(p.value)) : '';
  const isTree = p.type === 'dictionary' || p.type === 'list' || p.type === 'tuple';
  const value = el('span', 'ezo-value'); value.title = vs;
  if (vs.length > 12) {
    value.textContent = vs.slice(0, 12) + '…'; value.classList.add('ezo-value-long');
    value.addEventListener('click', (e) => { e.stopPropagation(); if (isTree) openValueTree(value, p.type, vs); else openValuePreview(value, vs); });
  } else value.textContent = vs;
  const toggle = el('div', 'ezo-toggle');
  const mk = (v, label) => {
    const b = el('button', v); b.textContent = label;
    if ((v === 'off') === localOff) b.classList.add('active');
    b.addEventListener('click', () => {
      node._ezLocalOff = node._ezLocalOff || {};
      node._ezLocalOff[p.id] = (v === 'off');
      writeLocalOff(node);
      const off = node._ezLocalOff[p.id];
      row.classList.toggle('ezo-off', off);
      row.querySelectorAll('.ezo-toggle button').forEach((bb) => bb.classList.remove('active'));
      const target = row.querySelector('.ezo-toggle button.' + (off ? 'off' : 'on'));
      if (target) target.classList.add('active');
    });
    toggle.appendChild(b);
  };
  mk('on', '开启'); mk('off', '禁用');
  row.appendChild(name); row.appendChild(type); row.appendChild(value); row.appendChild(toggle);
  return row;
}

function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'ezo-shell');
  const root = el('div', 'ezo-root');
  shell.appendChild(root);
  const hd = el('div', 'ezo-hd');
  const title = el('span', 'ezo-title'); title.textContent = '参数预设输出';
  const status = el('span', 'ezo-status'); status.textContent = '未连接';
  hd.appendChild(title); hd.appendChild(status);
  const list = el('div', 'ezo-list');
  root.appendChild(hd); root.appendChild(list);
  return shell;
}

// ===== 实例 API（ParamPresetControl 修改后调用 update）=====
function ensureAPI(node) {
  if (node._ezOutAPI) return;
  node._ezOutAPI = {
    update: () => { updatePorts(node); },
  };
}

// ===== 挂载 =====
function setupNode(node) {
  if (!node || node._ezOutSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') return;
    node._ezOutSetup = true;
    ensureAPI(node);
    node._ezLocalOff = readLocalOff(node);
    const root = buildRoot(node);
    node._ezRoot = root;
    makeDomWidgetHitThrough(root);
    const widget = node.addDOMWidget('参数预设输出', 'ezo-panel', root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 120, getValue: () => '{}', setValue: () => {} });
    makeDomWidgetHitThrough(widget.element || root);
    node.widgets_start_y = 0;
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
    installResizeHandles(node, root);
    try { node.setSize([400, Math.max(140, node.size ? node.size[1] : 140)]); } catch (_) {} // 默认宽度变为约两倍
    (node.inputs || []).forEach((i) => { try { i.hideName = true; } catch (_) {} }); // 输入端口只露圆点
    hideConfigWidget(node);
    updatePorts(node, true);
    // 图加载时 link 可能晚于节点配置恢复，延迟再校一次
    setTimeout(() => updatePorts(node), 150);
  } catch (e) { console.error('[ParamPresetOutput] init failed:', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__ezOutHooked) return; nt.__ezOutHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevConn = nt.prototype.onConnectionsChange; nt.prototype.onConnectionsChange = function (type, index, connected, link_info) {
    const r = prevConn ? prevConn.apply(this, arguments) : undefined;
    try { if (this._ezOutSetup) setTimeout(() => updatePorts(this), 0); } catch (_) {}
    return r;
  };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {} this._ezOutSetup = false; return r; };
}
app.registerExtension({
  name: 'Comfy.EzFlex.ParamPresetOutput',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() { ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); },
});
