// EzFlex-Reroute 转接点节点面板。
// 与内置 Reroute 一样做「原样转接」（逐口 1:1 透传，不合并/拆分），但：
//   ① 动态端口：连一根加一个（尾部常留 1 个空槽接下一根线），没有 +/- 按钮；
//   ② 每张卡片 = 第 i 个入口 → 第 i 个出口；卡片 = 拖手（⠿，可拖动换位）+ 序号 + 自定义名称输入框；
//   ③ 卡片数 = 已接线条数（不显示额外的空槽卡；空槽只存在于端口上，用来接下一根线）；
//   ④ 原生 socket 圆点从面板两侧 margin 露出，直接用原生端口拖线；
//   ⑤ 端口名实时画在节点外缘黑框里（每帧扫 socket 重建，改名立刻生效）。
//
// 实现参照 PreviewAny（syncSockets 动态端口 + 连线守卫 + 卡片拖拽排序）与 ModelsCombo（面板留端口位 + 每帧黑框）。
// ⚠️ 与 MergeList（N→1）/ SplitList（1→N）语义不同，三个节点都保留 —— Reroute 只做 1:1 透传。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ezT, onLocaleChange } from "./ezflex_i18n.js";
import { ezThemeInit } from "./ezflex_theme.js";
import {
  NODE_TYPES, registerNode, unregisterNode, nodeTypeOf,
  configWidget, writeConfig, readConfig,
  installResizeHandles, makeDomWidgetHitThrough,
  ezPruneDanglingLinks, scheduleOnRedraw, pumpFrames, on,
  hideNativeSlotText,
} from "./ezflex_service.js";

const NODE = NODE_TYPES.REROUTE;
const OUTPUTS_API = "/ezreroute/outputs";
const MAX_PORTS = 32;      // 与后端 _EZ_REROUTE_MAX 一致
// 尺寸：**照 PreviewAny 的做法** —— 不给「按内容自动长高」，改成
//   ① widget 固定最小高 MIN_H（不设 getMaxHeight，不覆盖 computeSize）；
//   ② 初始尺寸**显式压到 INIT_H**（不能跟 ComfyUI 默认大尺寸取 max，否则新节点会高得离谱）；
//   ③ 卡片多了由 .rzr-list 的 overflow:auto 内部滚动；
//   ④ 想更高/更宽由用户拖下缘、右下角手柄（installResizeHandles）。
// （ModelsCombo 那套「看到全部卡片所以自动长高」的语义不适合转接点，已被否决。）
const DEF_W = 300;         // 初始宽度
const MIN_H = 120;         // widget 固定最小高（= installResizeHandles 的 clamp 下限）
const INIT_H = 150;        // 新节点初始高度（固定，不随内容变）
const DEF_H = INIT_H;      // 兼容旧命名：node.size 缺失时的兜底值

const CSS = `
.rzr-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.rzr-shell .rzr-root{pointer-events:auto;}
/* 面板左右各留 14px：让原生 socket 圆点从节点边缘露出来（参照 ModelsCombo 的 margin:0 14px）。 */
.rzr-root{position:absolute;inset:0;margin:4px 14px 8px;font-family:Inter,sans-serif;color:var(--ez-fg);background:var(--ez-bg);border-radius:12px;padding:8px;display:flex;flex-direction:column;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.rzr-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.rzr-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:4px;padding:1px 2px;}
.rzr-card{display:flex;align-items:center;gap:6px;background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:8px;padding:3px 6px;flex:0 0 auto;}
.rzr-card:hover{border-color:var(--ez-border-strong);}
.rzr-card.dragging{opacity:.4;}
.rzr-grip{flex:0 0 auto;color:var(--ez-fg-3);cursor:grab;font-size:13px;line-height:1;padding:0 2px;}
.rzr-grip:hover{color:var(--ez-fg);}
.rzr-grip:active{cursor:grabbing;}
.rzr-idx{flex:0 0 auto;min-width:16px;text-align:center;font-size:10px;color:var(--ez-fg-muted);font-variant-numeric:tabular-nums;}
/* 输入框平时「隐形」：透明背景 + 无边框，跟卡片融为一体；悬停给浅底提示，聚焦才出现完整输入框。
   placeholder（默认名 Reroute N）**一直显示**，当作未命名卡片的占位文字。 */
.rzr-input{flex:1 1 auto;min-width:0;width:100%;height:22px;padding:2px 7px;font-family:inherit;font-size:12px;color:var(--ez-fg);background:transparent;border:1px solid transparent;border-radius:6px;outline:none;transition:background-color .12s,border-color .12s;}
.rzr-input:hover{background:var(--ez-surface-2);border-color:var(--ez-border);}
.rzr-input:focus{background:var(--ez-bg);border-color:var(--ez-border-strong);}
.rzr-input::placeholder{color:var(--ez-fg-muted);font-style:italic;}
.rzr-empty{font-size:11px;color:var(--ez-fg-muted);padding:2px 4px;line-height:1.4;}
.rzr-ph{height:0;border-top:3px solid var(--ez-fg-3);border-radius:2px;margin:1px 0;opacity:.9;box-shadow:0 1px 6px rgba(43,58,74,.35);}
.rzr-ph.hidden{display:none;}
`;

let _styleInjected = false;
function injectStyle() {
  ezThemeInit(); if (_styleInjected || !document.head) return; _styleInjected = true;
  const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
}
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

// ===== 状态：每张卡片的名字（**双通道**持久化，随工作流序列化）=====
// 为什么不能只靠 config widget（曾经「刷新/重启后自定义名消失」的根因）：
//   前端 1.52.x 的 `LGraphNode.configure()` 恢复 widget 值走的是**位置**配对
//   （`widgets_values[i]` → 第 i 个非 `serialize:false` 的 widget），
//   而 `LiteGraph.namedValuesRestore`（按名字恢复）**默认 false**
//   （`Comfy.Workflow.NamedValuesRestore`，见 LiteGraphGlobal.namedValuesRestore = false）。
//   我们的面板 DOM widget 是**运行期才插进去**的（`nodeCreated` → setupNode → addDOMWidget），
//   它在 `node.widgets` 里的位置会随「建节点 / 载工作流 / 折叠展开 / Vue 重建」变化，
//   一旦存盘与载入时的 widget 顺序/数量不一致，config 的 value 就会**错位落到别的 widget 上**
//   （或反过来被 DOM widget 的占位值 `"{}"` 覆盖）→ 名字整批丢失，且**不报任何错**。
// 所以这里改用两条通道，互为兜底：
//   ① config widget —— 老通道，随 widgets_values 序列化（保留兼容）；
//   ② node.properties —— LiteGraph 在 `configure()` **最开头**就把 `info.properties` 灌回来
//      （早于 widgets_values），与 widget 的顺序/数量完全无关，最稳。
//   另加 ③：`onConfigure(info)` 里直接读**原始序列化数据**（namesFromInfo），优先级最高。
const PROP_KEY = 'ezRerouteNames';
function stateFor(node) {
  if (!node._ezRz) node._ezRz = { names: [], sig: '' };
  return node._ezRz;
}
function defaultName(i) { return 'Reroute ' + (i + 1); }
// 入口 socket 的 name 必须是 input_N（后端 route() 按它取 kwargs），画布上不显示（由面板画）
function inputName(i) { return 'input_' + (i + 1); }

// 自带端口名文字（input_1 / output_1）由共享的 hideNativeSlotText 关掉 ——
// 它从面板上边距/圆角处露出来的机制与修法见 ezflex_service.js 里该函数的注释（MEMORY.md §4e）。
function normalizeNames(arr) {
  return arr.map((x) => (typeof x === 'string' ? x.slice(0, 128) : '')).slice(0, MAX_PORTS);
}
// 通道②：node.properties（LiteGraph configure 最开头恢复，不受 widget 顺序影响）
function propNames(node) {
  try {
    const v = (node.properties || {})[PROP_KEY];
    return Array.isArray(v) ? normalizeNames(v) : null;
  } catch (_) { return null; }
}
// 通道①：config widget
function cfgNames(node) {
  try {
    const n = readConfig(node, {}).names;
    return Array.isArray(n) ? normalizeNames(n) : null;
  } catch (_) { return null; }
}
// 通道③：直接读 onConfigure(info) 的原始序列化数据 —— 最可靠的一份。
//   新版：info.widgets_values_named.config；老版：按「config widget 当前下标」取 widgets_values[idx]；
//   下标已错位（正是本 bug 的症状）时再全文扫一遍所有字符串，取第一个能解析出 names 数组的。
function namesFromInfo(node, info) {
  if (!info) return null;
  const parse = (s) => {
    if (typeof s !== 'string') return null;
    try { const j = JSON.parse(s); return (j && Array.isArray(j.names)) ? normalizeNames(j.names) : null; } catch (_) { return null; }
  };
  try {
    const named = info.widgets_values_named;
    if (named) { const r = parse(named.config); if (r) return r; }
    const wv = info.widgets_values;
    if (Array.isArray(wv)) {
      const w = configWidget(node);
      const idx = w ? (node.widgets || []).indexOf(w) : -1;
      if (idx >= 0) { const r = parse(wv[idx]); if (r) return r; }
      for (const v of wv) { const r = parse(v); if (r) return r; }
    }
  } catch (_) {}
  return null;
}
// 只有确实读到「有效」的名字才覆盖内存 ——「读到空」≠「确实是空」：
// ComfyUI 恢复 config 时会先经历 undefined / 默认 "{}" 再填真值，
// 若在「还是默认值」时无条件覆盖，内存里的名字会被抹掉，
// 紧接着 syncToConfig 又把空值写回 config → 真值到达时已被自己的空值占了 → 永久丢失。
function applyNames(node, names) {
  const st = stateFor(node);
  if (!Array.isArray(names)) return false;
  if (!names.length && st.names.length) return false;
  st.names = normalizeNames(names);
  return true;
}
// 按可靠性从高到低依次尝试三条通道；空值一律当「还没恢复」，继续看下一条。
function loadFromConfig(node, info) {
  const st = stateFor(node);
  const cands = [namesFromInfo(node, info), cfgNames(node), propNames(node)];
  for (const c of cands) {
    if (!Array.isArray(c)) continue;
    if (!c.length && st.names.length) continue;
    applyNames(node, c);
    return;
  }
}
function syncToConfig(node) {
  const st = stateFor(node);
  const names = st.names.slice(0, MAX_PORTS);
  writeConfig(node, { names });
  try { if (!node.properties) node.properties = {}; node.properties[PROP_KEY] = names.slice(); } catch (_) {}
}
// 载入工作流后把「读回来的名字」补写回 config widget：
// 位置配对错位时 widget 里可能已经被写成 DOM widget 的占位值，不修的话下一次存盘又存错。
function repairConfig(node, names) {
  if (!Array.isArray(names) || !names.some((x) => x)) return;   // 本来就没有自定义名 → 没什么要修的（别把刚载入的工作流标脏）
  const cur = cfgNames(node);
  if (cur && cur.length === names.length && cur.every((v, i) => v === names[i])) return;   // 已一致就别动
  try { syncToConfig(node); } catch (_) {}
}
// 改名是「逐字符」的：像其它面板（PromptHelper / ModelsCombo / MediaLoader）那样**边输入边落盘**，
// 不能只挂在 blur 上 —— 面板 render 会重建卡片列表，聚焦中的 <input> 被换掉时 **blur 不触发**，
// 只写内存不写 config 的话，刷新/重启就整批丢。
// ⚠️ 去抖计时器必须**按节点**存（同屏多个 Reroute 各自改名不能互相取消）。
function scheduleSync(node) {
  if (node._ezRzSyncT) clearTimeout(node._ezRzSyncT);
  node._ezRzSyncT = setTimeout(() => {
    node._ezRzSyncT = null;
    try { syncToConfig(node); pushOutputs(node); } catch (_) {}
  }, 300);
}
function flushSync(node) {
  if (node._ezRzSyncT) { clearTimeout(node._ezRzSyncT); node._ezRzSyncT = null; }
  try { syncToConfig(node); } catch (_) {}
}

// 名字清洗：去首尾空白（保留内部空格），限长（后端也截 128）
function cleanName(s) { return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 128); }

// ===== 动态端口同步（参照 PreviewAny.syncSockets）=====
function connectedCount(node) { return (node.inputs || []).filter((i) => i && i.link != null).length; }
function deferSync(node) {
  if (node._ezRzSyncTimer) clearTimeout(node._ezRzSyncTimer);
  node._ezRzSyncTimer = setTimeout(() => {
    node._ezRzSyncTimer = null;
    try { syncSockets(node); render(node); } catch (_) {}
  }, 120);
}
// 面板上报「输出名」→ 后端同步类 RETURN_TYPES/RETURN_NAMES（长度 = 当前输出口数）。
function pushOutputs(node) {
  const st = stateFor(node);
  const n = (node.outputs || []).length;
  const labels = [];
  for (let i = 0; i < n; i++) labels.push(cleanName(st.names[i]) || defaultName(i));
  let apiFetch = null;
  try { apiFetch = (api && api.fetchApi) ? api.fetchApi.bind(api) : fetch; } catch (_) { apiFetch = fetch; }
  return Promise.resolve()
    .then(() => apiFetch(OUTPUTS_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: labels }),
    }))
    .then((r) => (r && r.json ? r.json() : null))
    .catch(() => null);
}

// 收掉某个 link：下游输入置 null + 从上游输出 links 里摘掉 + 删 link 对象。
// 手写按实例收口（不动 socket 数组，避免索引错位）。
function killLink(node, lid) {
  const g = node.graph;
  if (lid == null || !g || !g.links) return;
  const L = g.links[lid];
  if (L) {
    try {
      const tgt = g.getNodeById ? g.getNodeById(L.target_id) : null;
      const ts = tgt && (tgt.inputs || [])[L.target_slot];
      if (ts && String(ts.link) === String(lid)) ts.link = null;
    } catch (_) {}
    try {
      const src = g.getNodeById ? g.getNodeById(L.origin_id) : null;
      const ss = src && (src.outputs || [])[L.origin_slot];
      if (ss && Array.isArray(ss.links)) { ss.links = ss.links.filter((x) => String(x) !== String(lid)); if (!ss.links.length) ss.links = null; }
    } catch (_) {}
  }
  try { delete g.links[lid]; } catch (_) { try { g.links[lid] = null; } catch (_2) {} }
}

// 收集 socket 上挂的 link id（links 数组 + link 单值，两种写法都兼容）
function linksOf(sock) {
  const ids = [];
  if (sock && Array.isArray(sock.links)) ids.push(...sock.links);
  if (sock && sock.link != null) ids.push(sock.link);
  return ids;
}

// ===== 端口颜色：跟着上游那个口的颜色走（VAE 红 / CLIP 黄 / MODEL 紫…）=====
// ComfyUI 的取色链（在实跑的前端 1.45.21 上核对过）：
//   SlotBase:      `slot.color_on || colorContext.getConnectedColor(slot.type)`
//   colourGetter:  `getConnectedColor(type) = default_connection_color_byType[type] || default_connection_color.output_on`
//   调色板（含用户自定义 palette 的 colors.node_slot）由 colorPaletteService **同时**灌进
//   `app.canvas.default_connection_color_byType` 与 `LGraphCanvas.link_type_colors`。
//   ⇒ 想跟上游同色：读上游输出槽的 `type` 查这两张表就行；上游自己设过 `color_on`（如 MediaLoader
//     的 CARD_COLOR）就直接沿用它的，这样自定色也能对上。
//   连线的颜色取 `link.color || link_type_colors[link.type]`，而 Reroute 出线的 type 是 `*`
//   → 顺手把出线的 `link.color` 也染上，否则线是灰的、只有圆点对色。
function typeColor(type) {
  if (!type) return null;
  try {
    const ds = (app && app.canvas) || null;
    const byType = ds && ds.default_connection_color_byType;
    if (byType && byType[type]) return byType[type];
  } catch (_) {}
  try {
    const LGC = (typeof LGraphCanvas !== 'undefined' && LGraphCanvas) ? LGraphCanvas : null;
    const ltc = LGC && LGC.link_type_colors;
    if (ltc && ltc[type]) return ltc[type];
  } catch (_) {}
  return null;
}
// 第 i 个入口所连「上游输出槽」的颜色；没接线 / 查不到 → null（回落默认色）
function upstreamSlotColor(node, i) {
  try {
    const inp = (node.inputs || [])[i];
    const lid = inp && inp.link;
    if (lid == null) return null;
    const g = node.graph;
    const L = (g && g.links) ? g.links[lid] : null;
    if (!L) return null;
    const src = g.getNodeById ? g.getNodeById(L.origin_id)
      : ((g._nodes || []).find((n) => n && String(n.id) === String(L.origin_id)));
    const s = src && src.outputs ? src.outputs[L.origin_slot] : null;
    if (!s) return null;
    return s.color_on || s.color || typeColor(s.type) || null;
  } catch (_) { return null; }
}
function syncPortColors(node) {
  const conn = connectedCount(node);
  const apply = (sock, i) => {
    if (!sock) return;
    const c = (i < conn) ? upstreamSlotColor(node, i) : null;
    try {
      if (c) { sock.color_on = c; sock.color_off = c; }
      else { delete sock.color_on; delete sock.color_off; }   // 没接 / 查不到 → 交回默认色
    } catch (_) {}
  };
  (node.inputs || []).forEach(apply);
  (node.outputs || []).forEach(apply);
  (node.outputs || []).forEach((o, i) => {
    const c = (i < conn) ? upstreamSlotColor(node, i) : null;
    linksOf(o).forEach((lid) => {
      try {
        const L = (node.graph && node.graph.links) ? node.graph.links[lid] : null;
        if (!L) return;
        if (c) L.color = c; else delete L.color;
      } catch (_) {}
    });
  });
}

function syncSockets(node) {
  if (!node || !node.inputs) return;

  // 移除 config 输入口，避免被当动态 input_* 重排/改名
  try {
    for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
      const _in = node.inputs[i];
      if (_in && _in.name === 'config') { try { node.inputs.splice(i, 1); } catch (_) { try { _in.hidden = true; } catch (_2) {} } }
    }
  } catch (_) {}

  const origInputs = (node.inputs || []).slice();
  const origOutputs = (node.outputs || []).slice();
  const linked = origInputs.filter((i) => i.link != null);
  const conn = linked.length;

  // 链路未恢复守卫：有带 link 的输入其 link 对象还没进 graph.links，此时不重排/改名/删槽。
  const pending = (node.inputs || []).some((i) => i.link != null && !(node.graph && node.graph.links && node.graph.links[i.link]));
  if (pending) { deferSync(node); return; }

  // ★ 关键顺序（修「换位/断线后连锁断裂」）：
  //   先按「新数组下标」回写 target_slot/origin_slot，再 prune。
  //   否则 prune 会把「刚换过位、slot 还没跟上」的有效线全判成 dangling 删掉。

  // ---- 输入：已连接前置 + 末尾留 1 个空槽（连一个加一个）----
  const desiredIn = Math.min(MAX_PORTS, Math.max(1, conn + 1));
  const emptyInputs = origInputs.filter((i) => i.link == null);
  const newInputs = [...linked, ...emptyInputs].slice(0, desiredIn);
  if (node.inputs.length !== newInputs.length || node.inputs.some((i, idx) => i !== newInputs[idx])) {
    node.inputs.splice(0, node.inputs.length, ...newInputs);
  }
  while (node.inputs.length < desiredIn) node.addInput(`input_${node.inputs.length + 1}`, '*');
  node.inputs.forEach((i, idx) => { try { i.name = inputName(idx); hideNativeSlotText(i); i.hidden = false; } catch (_) {} });

  // ---- 输出：与已连接卡片 1:1，跟着对应卡片走 ----
  // 按「卡片（已连接输入）」回溯它配对的旧输出 socket，**保持对象引用**，配对上的输出不会断线。
  const cardOutputs = linked.map((inp) => origOutputs[origInputs.indexOf(inp)]).filter(Boolean);
  const newOuts = cardOutputs.slice(0, conn);
  const wantOut = new Set(newOuts);

  // 先收「未配对的旧输出」上的连线，再删 socket（先收线更安全，避免 removeOutput 掉下游线）
  for (let i = origOutputs.length - 1; i >= 0; i--) {
    const o = origOutputs[i];
    if (!o || wantOut.has(o)) continue;
    linksOf(o).forEach((lid) => killLink(node, lid));
    try { o.links = null; o.link = null; } catch (_) {}
  }
  // 删未配对输出：从后往前（避免索引错位）
  for (let i = node.outputs.length - 1; i >= 0; i--) {
    if (!wantOut.has(node.outputs[i])) { try { node.removeOutput(i); } catch (_) {} }
  }
  if (node.outputs.length !== newOuts.length || node.outputs.some((o, idx) => o !== newOuts[idx])) {
    node.outputs.splice(0, node.outputs.length, ...newOuts);
  }
  while (node.outputs.length < conn) node.addOutput(`output_${node.outputs.length + 1}`, '*');
  // 输出 socket 的 name 保持 output_N（后端按槽位取），显示名由黑框标签 / 卡片负责
  node.outputs.forEach((o, idx) => { try { o.name = `output_${idx + 1}`; hideNativeSlotText(o); o.hidden = false; } catch (_) {} });

  // ---- ★ 先回写 slot（链路已就绪），再 prune ----
  node.inputs.forEach((i, idx) => {
    if (i.link != null && node.graph && node.graph.links && node.graph.links[i.link]) {
      try { node.graph.links[i.link].target_slot = idx; } catch (_) {}
    }
  });
  node.outputs.forEach((o, idx) => {
    linksOf(o).forEach((lid) => {
      if (lid != null && node.graph && node.graph.links && node.graph.links[lid]) {
        try { node.graph.links[lid].origin_slot = idx; } catch (_) {}
      }
    });
  });

  // 回写后再清坏线（此时 slot 已对齐，只会清掉真正越界的线）
  ezPruneDanglingLinks(node);

  // 端口/连线染色（跟上游输出口的颜色一致）——必须在 slot 与 link 都就位之后
  try { syncPortColors(node); } catch (_) {}

  if (node.graph) node.graph.setDirtyCanvas(true, true);
  pushOutputs(node);
  try { if (node._ezRzEdgeUpdate) node._ezRzEdgeUpdate(); } catch (_) {}
}

function redraw(node) {
  try { if (node.graph) node.graph.setDirtyCanvas(true, true); } catch (_) {}
  try { if (app.canvas && app.canvas.setDirty) app.canvas.setDirty(true, true); } catch (_) {}
}

// ===== 渲染 =====
// 卡片数 = 已接线条数（空槽只体现在端口的「尾巴空口」上，不额外画一张虚线卡）。
// ⚠️ 这里**不动节点尺寸**（照 PreviewAny）：卡片多了靠 .rzr-list 内部滚动，不再自动长高。
//
// ★★ 折叠（点左上角圆点）/ 刷新页面后「内容全消失」的根因 ★★
// Vue（Nodes 2.0）与经典模式在折叠/重建节点时都会**换掉 DOM widget 的宿主容器**（v-if 卸载再重建）。
// 我们手动 appendChild 进去的 `node._ezRoot` 就变成**脱离文档的幽灵节点**：对象还在、children 还在，
// 但 `isConnected === false` —— 之后所有 render() 都画进了这个没人看的树里 → 用户看到面板空掉。
// 所以：① 每次拿面板都从 `widget.element` 现取（不长期信 `_ezRoot`）；
//       ② 早退判断必须带 DOM 存活校验（`list.isConnected`）—— 否则「sig 没变 + children 数对得上」
//          就会直接 return，永远不重画。
function panelList(node) {
  // 优先用 widget 当前挂着的 element（Vue 重建后这里才是真相）；拿不到再退回落缓存的 _ezRoot。
  let shell = null;
  try {
    const w = (node.widgets || []).find((x) => x && x.type === 'rzr-panel');
    shell = (w && (w.element || w.el)) || null;
  } catch (_) { shell = null; }
  // `w.element` 就是 shell 本身；若上游给的是外层包裹再往下找 .rzr-shell
  if (shell && shell.querySelector && !shell.querySelector('.rzr-list')) {
    const inner = shell.querySelector('.rzr-shell');
    if (inner) shell = inner;
  }
  if ((!shell || !shell.querySelector) && node._ezRoot) shell = node._ezRoot;
  if (!shell || !shell.querySelector) return null;
  node._ezRoot = shell;                     // 回写：后续黑框标签等也用最新的
  return shell.querySelector('.rzr-list');
}

function render(node) {
  const st = stateFor(node);
  const list = panelList(node);
  if (!list) return;
  const conn = connectedCount(node);
  const total = conn;                              // 卡片数 = 已接线条数
  const empty = total === 0;
  const sig = st.names.slice(0, Math.max(1, total)).map((x) => x || '').join('\u0001') + '\u0002' + conn;
  // ★ DOM 还活着 且 结构没变 才早退。
  //   `!list.isConnected` = 宿主被 Vue/折叠换掉了 → 必须无条件重建（画进新宿主才看得见）。
  //   ⚠️ 判据必须数 `.rzr-card`，**不能数 `list.children.length`** —— attachDnD 会往 list 里
  //   追加一个 `.rzr-ph` 占位条，children 恒为 total+1，那个「早退」永远不成立 →
  //   每次 render 都整表重建（连聚焦中的 input 一起换掉，blur 不触发 → 改名丢）。
  const alive = (list.isConnected === undefined) ? true : !!list.isConnected;
  const cardCount = list.querySelectorAll('.rzr-card').length;
  if (alive && sig === st.sig && cardCount === (empty ? 0 : total)
      && (empty === !!list.querySelector('.rzr-empty'))) return;
  // 有输入框正在聚焦时不整体重建（否则输入焦点/IME 会断）
  if (alive && list.querySelector('.rzr-input:focus')) return;
  st.sig = sig;
  list.innerHTML = '';
  if (empty) {
    const tip = el('div', 'rzr-empty');
    tip.textContent = ezT('Connect a wire to the left input port to create a card');
    list.appendChild(tip);
    return;
  }
  for (let i = 0; i < total; i++) list.appendChild(renderCard(node, i));
  attachDnD(list, node);
}

function renderCard(node, i) {
  const st = stateFor(node);
  const card = el('div', 'rzr-card');
  card.dataset.rzIdx = String(i);

  const grip = el('span', 'rzr-grip');
  grip.textContent = '⠿';
  grip.title = ezT('Drag to reorder');

  const idx = el('span', 'rzr-idx');
  idx.textContent = String(i + 1);

  const box = el('input', 'rzr-input');
  box.type = 'text';
  box.maxLength = 128;
  box.value = st.names[i] || '';
  box.placeholder = defaultName(i);
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();                       // 别让画布吃按键
    if (e.key === 'Enter') { e.preventDefault(); box.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); box.value = st.names[i] || ''; box.blur(); }
  });
  // ★ 边输入边落盘（去抖 300ms）：不能只靠 blur —— 卡片列表重建会换掉聚焦中的 input，
  //   而移除聚焦元素**不会**触发 blur，只写内存的名字刷新后就没了。
  box.addEventListener('input', () => {
    st.names[i] = cleanName(box.value);
    scheduleSync(node);
    if (node._ezRzEdgeUpdate) { try { node._ezRzEdgeUpdate(); } catch (_) {} }   // 黑框标签实时跟随
  });
  box.addEventListener('blur', () => {
    const v = cleanName(box.value);
    const old = st.names[i] || '';
    if (v !== old) {
      st.names[i] = v;
      flushSync(node);                 // 立即落盘（取消失抖里的那次）
      pushOutputs(node);
      redraw(node);
      if (node._ezRzEdgeUpdate) { try { node._ezRzEdgeUpdate(); } catch (_) {} }
    } else if (box.value !== v) {
      box.value = v;
    } else {
      flushSync(node);                 // 值没变也确保 config / properties 是最新的
    }
  });

  card.appendChild(grip); card.appendChild(idx); card.appendChild(box);
  return card;
}

// ===== 卡片拖拽排序（参照 PreviewAny.attachDnD）=====
function attachDnD(container, node) {
  if (!container) return;
  container.querySelectorAll('.rzr-ph').forEach((x) => x.remove());
  const placeholder = el('div', 'rzr-ph hidden');
  container.appendChild(placeholder);
  container.querySelectorAll('.rzr-grip').forEach((h) => {
    if (h._ezRzDnD) return; h._ezRzDnD = true;
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const item = h.closest('.rzr-card');
      if (!item) return;
      const items = [...container.querySelectorAll('.rzr-card')];
      const idx = items.indexOf(item);
      if (idx < 0) return;
      const rect = item.getBoundingClientRect();
      const clone = item.cloneNode(true);
      clone.style.cssText = 'position:fixed;pointer-events:none;width:' + rect.width + 'px;opacity:.85;z-index:99999;border:2px solid var(--ez-strong);border-radius:6px;background:var(--ez-bg);box-shadow:0 8px 24px rgba(0,0,0,.12);top:' + rect.top + 'px;left:' + rect.left + 'px;transition:none;';
      document.body.appendChild(clone);
      const st = { idx, clone, moved: false, targetIdx: idx };
      item.classList.add('dragging');
      items.forEach((c) => { if (c !== item) c.style.opacity = '0.5'; });
      const onMove = (ev) => {
        st.moved = true;
        st.clone.style.top = (ev.clientY - 20) + 'px';
        const els = [...container.querySelectorAll('.rzr-card')];
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
        window.removeEventListener('pointercancel', onUp, true);
        if (st.clone && st.clone.parentNode) st.clone.parentNode.removeChild(st.clone);
        placeholder.classList.add('hidden');
        items.forEach((c) => { c.style.opacity = '1'; });
        const from = st.idx, moved = st.moved, targetIdx = st.targetIdx;
        item.classList.remove('dragging');
        if (moved && targetIdx !== from && targetIdx !== from + 1) {
          let insert = targetIdx;
          if (insert > from) insert -= 1;
          reorderCard(node, from, insert);
        }
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    });
  });
}

// 卡片换位：同步 splice inputs / outputs / names，再重排 + 回写 slot。
function reorderCard(node, from, to) {
  const conn = connectedCount(node);
  if (from < 0 || from >= conn || to < 0 || to >= conn || from === to) return;
  const st = stateFor(node);
  const [inp] = node.inputs.splice(from, 1);
  node.inputs.splice(to, 0, inp);
  const [out] = node.outputs.splice(from, 1);
  if (out) node.outputs.splice(to, 0, out);
  const nm = st.names.splice(from, 1);
  if (nm.length) st.names.splice(to, 0, nm[0]);
  flushSync(node);                 // 换位立刻落盘（取消失抖里的那次，避免旧顺序写回）
  st.sig = '';
  syncSockets(node);
  render(node);
  redraw(node);
}

// ===== 构建/挂载 =====
function buildRoot() {
  const shell = el('div', 'rzr-shell');
  const root = el('div', 'rzr-root');
  root.appendChild(el('div', 'rzr-list'));
  shell.appendChild(root);
  return shell;
}

// ===== 把 config widget 彻底藏掉（否则它的 JSON 会从面板的边距/圆角处露出来）=====
// config 是后端 required 的 multiline STRING → 前端用 useStringWidget 建的是 **DOM textarea**，
// 渲染结构（DomWidget.vue）：
//   <div class="dom-widget size-full" v-show="widgetState.visible">   ← 容器（ComfyUI 把元素 append 进来）
//     <textarea class="comfy-multiline-input h-full w-full" data-testid="dom-widget-textarea">
// ⚠️ 只藏 textarea 不够稳：`v-show` 的 `widgetState.visible` 是 domWidgetStore 里的标志（默认 true），
//    宿主重建/重挂后我们的内联样式会被冲掉 → 文字从面板的 4px 上边距 + 12px 圆角处露出来。
//    所以：① 压死 widget 自身的绘制判据（hidden / isWidgetVisible / isVisible / draw / drawWidget）；
//          ② 藏元素；③ **连它的 .dom-widget 宿主容器一起藏**（容器没了，里面就不可能画东西）。
//    三条都幂等、且由 healDom / 每帧 update 反复重设。
function killConfigWidget(node) {
  const cw = configWidget(node);
  if (!cw) return;
  try {
    cw.hidden = true;
    cw.options = cw.options || {};
    cw.options.hidden = true;
    if (!cw.origComputeSize) cw.origComputeSize = cw.computeSize;
    cw.computeSize = () => [0, 0];
    cw.computedHeight = 0; cw.y = 0; cw.last_y = 0; cw.width = 0;
    cw.draw = () => {};
    cw.drawWidget = () => {};
    cw.isWidgetVisible = () => false;   // 画布绘制判据：即便 hidden 被别处改回来也不会画
    cw.isVisible = () => false;         // DOM widget 的可见性判据
  } catch (_) {}
  const el = cw.element || cw.el || cw.inputEl || null;
  if (!el || !el.style) return;
  try {
    const st = el.style;
    st.setProperty('display', 'none', 'important');
    st.setProperty('visibility', 'hidden', 'important');
    st.setProperty('height', '0', 'important');
    st.setProperty('min-height', '0', 'important');
    st.setProperty('max-height', '0', 'important');
    st.setProperty('margin', '0', 'important');
    st.setProperty('padding', '0', 'important');
  } catch (_) {}
  // 往上找它的 .dom-widget 宿主容器，一起藏（**只藏这一个**，别把整个 DOM widget 图层藏了）
  try {
    let host = el.parentElement;
    let hop = 0;
    while (host && hop < 6) {
      const cls = (typeof host.className === 'string') ? host.className : '';
      if (/dom[-_]widget/i.test(cls)) break;
      host = host.parentElement; hop += 1;
    }
    // 安全阀：这个容器里若装着我们自己的面板，就绝不能藏
    if (host && host.style && !(host.contains && host.contains(node._ezRoot))) {
      host.style.setProperty('display', 'none', 'important');
    }
  } catch (_) {}
}

function hideConfigWidget(node) {
  try {
    const ins = node.inputs || [];
    for (let i = ins.length - 1; i >= 0; i--) {
      const inp = ins[i];
      if (inp && inp.name === 'config') { try { ins.splice(i, 1); } catch (_) { try { inp.hidden = true; } catch (_2) {} } }
    }
  } catch (_) {}
  const w = configWidget(node); if (!w || node._ezRzCfgHid) return; node._ezRzCfgHid = true;
  try {
    w.options = w.options || {};
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
  } catch (_) {}
  killConfigWidget(node);
}

// ===== 端口黑框标签（参照 ModelsCombo.installOutsideLabels）=====
// 每帧扫 socket 列表，签名变了就重建黑框；名字实时跟随。只画已接线的端口。
// 位置以 **node.getConnectionPos 的绝对图坐标** 换到屏幕坐标（不依赖面板 rect，避免面板留边导致错位）。
function installOutsideLabels(node) {
  if (!node || node._ezRzOutLabels) return;
  node._ezRzOutLabels = true;
  let all = [];
  let sig = '';
  const mk = () => {
    const l = document.createElement('div');
    l.className = 'ezfx-socket-label';
    l.style.display = 'none';
    document.body.appendChild(l);
    return l;
  };
  const scan = (conn) => {
    const cur = [];
    (node.inputs || []).forEach((s, i) => {
      if (i < conn && s && !s.hidden) cur.push({ in: true, i, text: cleanName((stateFor(node).names || [])[i]) || defaultName(i) });
    });
    (node.outputs || []).forEach((s, i) => {
      if (i < conn && s && !s.hidden) cur.push({ in: false, i, text: cleanName((stateFor(node).names || [])[i]) || defaultName(i) });
    });
    const s = cur.map((x) => (x.in ? 'i' : 'o') + x.i + ':' + x.text).join(';');
    if (s !== sig) {
      sig = s;
      all.forEach((x) => { try { x.el.remove(); } catch (_) {} });
      all = cur.map((x) => { const e = mk(); e.textContent = x.text; return { el: e, in: x.in, i: x.i }; });
    }
  };
  const hideAll = () => { all.forEach((item) => { try { item.el.style.display = 'none'; } catch (_) {} }); };
  // 图坐标 → 屏幕坐标（与画布 ds 一致，不用面板 rect）
  const graphToScreen = (gx, gy, cr, sc, off) => [cr.left + (gx + (off[0] || 0)) * sc, cr.top + (gy + (off[1] || 0)) * sc];
  const update = () => {
    // ★ 每帧（含画布重绘调度 + 兜底 interval）都重压一遍 config 的隐藏：
    //   不能只依赖 `onDrawForeground → healDom` —— 那个回调一旦被别处替换/节点未被绘制就断了，
    //   config 的 textarea 就会从面板的上边距/圆角处把 JSON 露出来。
    try { killConfigWidget(node); } catch (_) {}
    const rootEl = node._ezRoot;
    if (!rootEl || !rootEl.isConnected) { hideAll(); return; }
    const shown = (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
    if (shown && node.graph && node.graph !== shown) { hideAll(); return; }
    let rect = null;
    try { rect = rootEl.getBoundingClientRect(); } catch (_) { hideAll(); return; }
    if (!rect || rect.width <= 0) { hideAll(); return; }
    const canvasEl = (app && app.canvas && (app.canvas.canvas || app.canvas.canvasEl)) || null;
    if (!canvasEl || !canvasEl.getBoundingClientRect) { hideAll(); return; }
    let cr = null;
    try { cr = canvasEl.getBoundingClientRect(); } catch (_) { hideAll(); return; }
    if (!cr || cr.width <= 0) { hideAll(); return; }
    const ds = (app.canvas && app.canvas.ds) || {};
    const sc = ds.scale || 1;
    const off = ds.offset || [0, 0];
    if (cr.right < 0 || cr.left > window.innerWidth || cr.bottom < 0 || cr.top > window.innerHeight || sc < 0.35) { hideAll(); return; }
    const conn = connectedCount(node);
    scan(conn);
    const zoom = Math.max(0.5, sc);
    all.forEach((item) => {
      let pos = null;
      try { pos = node.getConnectionPos(item.in, item.i, [0, 0]); } catch (_) { pos = null; }
      if (!pos || !pos.length) { try { pos = item.in ? node.getInputPos(item.i) : node.getOutputPos(item.i); } catch (_2) { pos = null; } }
      if (!pos || !pos.length) { item.el.style.display = 'none'; return; }
      const pt = graphToScreen(pos[0] || 0, pos[1] || 0, cr, sc, off);
      const cx = pt[0], cy = pt[1];
      item.el.style.display = 'inline-flex';
      item.el.style.zIndex = '20';
      item.el.style.fontSize = Math.max(8, 9 * zoom) + 'px';
      item.el.style.padding = (3 * zoom) + 'px ' + (7 * zoom) + 'px';
      const tw = item.el.offsetWidth;
      const th = item.el.offsetHeight || 16;
      const offX = 11 * zoom;                       // 往节点外侧偏移（输入往左、输出往右）
      item.el.style.left = (item.in ? cx - tw - offX : cx + offX) + 'px';
      item.el.style.top = (cy - th / 2) + 'px';
    });
  };
  const schedule = () => pumpFrames();
  const prevDraw = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    if (prevDraw) prevDraw.call(this, ctx);
    // ★ 折叠/展开、Vue 重建节点后 DOM 宿主会被换掉，这里每帧兜一次：
    //   `_ezRoot` 已脱离文档、或 widget 现在的 element 不是它 → 立刻重挂 + 重画。
    //   不这么做就没人告诉我们「DOM 换了」，面板会一直空着（用户报的「内容全消失」）。
    try {
      if (!node.collapsed) healDom(node);
    } catch (_) {}
    update();
  };
  scheduleOnRedraw(update);
  onLocaleChange(() => { try { node._ezRz.sig = ''; render(node); } catch (_) {} update(); });
  schedule();
  node._ezRzEdgeUpdate = update;
}

// ===== DOM 宿主自愈（折叠 / 展开 / 刷新 / Vue 重建后内容空掉、config 文字露出）=====
// ComfyUI（Vue / 经典）在折叠、展开、载入工作流、刷新时会卸载并重建 widget 宿主 + **重写 widget 内联样式**。
// 后果有两个，都在这里一次修掉：
//   ① 我们的 shell 变成脱离文档的「幽灵 DOM」→ 卡片画进去看不见（内容全消失）；
//   ② config 的 textarea 被重建 → hideConfigWidget 设的 display:none 丢失 → 文字露在面板下面。
function healDom(node) {
  if (!node || !node._ezRoot) return;
  const shell = node._ezRoot;
  const list = (shell.querySelector && shell.querySelector('.rzr-list')) || null;
  if (!list) return;
  const connected = (el) => (el && el.isConnected === undefined) ? true : !!(el && el.isConnected);
  const host = (() => {
    try { const w = (node.widgets || []).find((x) => x && x.type === 'rzr-panel'); return (w && (w.element || w.el)) || null; } catch (_) { return null; }
  })();

  // (A) config widget 每次都要重新藏一遍（ComfyUI 重建宿主时会把它显示回来）。
  //     注意别信 `node._ezRzCfgHid`（那只标记「首次藏过」），这里**无条件重设**：
  //     widget 绘制判据 + 元素内联样式 + 它的 .dom-widget 宿主容器，三处一起压死。
  try { killConfigWidget(node); } catch (_) {}

  // (B) shell 的尺寸也每次都硬设一遍：ComfyUI 重建容器时可能把它压扁 → 面板盖不满、底下露内容。
  try {
    const si = (p, v) => { try { shell.style.setProperty(p, v, 'important'); } catch (_) {} };
    si('position', 'absolute'); si('inset', '0'); si('width', '100%'); si('height', '100%');
    si('max-width', '100%'); si('max-height', '100%'); si('box-sizing', 'border-box');
    if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) {
      si('top', 'var(--ezfx-vue-title,30px)');
      si('height', 'calc(100% - var(--ezfx-vue-title,30px))');
      si('bottom', 'auto');
    }
  } catch (_) {}

  // (C) 宿主对不上就重挂
  const shellOk = connected(shell) && connected(list);
  const hostOk = !host || host === shell || !!(host.contains && host.contains(shell));
  if (shellOk && hostOk) return;
  try {
    if (host && host !== shell && host.appendChild) host.appendChild(shell);
  } catch (_) {}
  // (D) 强制重画（清掉签名缓存，绕过早退）
  try { if (node._ezRz) node._ezRz.sig = ''; } catch (_) {}
  try { render(node); } catch (_) {}
  try { if (node._ezRzEdgeUpdate) node._ezRzEdgeUpdate(); } catch (_) {}
}

function setupNode(node) {
  if (!node || node._ezRzSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') return;
    node._ezRzSetup = true;
    injectStyle();
    loadFromConfig(node);
    const shell = buildRoot();
    node._ezRoot = shell;
    makeDomWidgetHitThrough(shell);
    const widget = node.addDOMWidget('Reroute', 'rzr-panel', shell, {
      serialize: false, hideOnZoom: false,
      canvasOnly: !(window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()),
      margin: 4,
      getMinHeight: () => 120,          // 固定最小高，不随内容变（照 PreviewAny）
      getValue: () => '{}', setValue: () => {},
    });
    makeDomWidgetHitThrough(widget.element || shell);
    node.widgets_start_y = 0;
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}

    // ===== 尺寸（照 PreviewAny）=====
    // 不覆盖 computeSize / 不设 getMaxHeight：让 DOM widget 只吃它自己那点空间，
    // 面板高度由 node.size 决定；卡片溢出走 .rzr-list 的内部滚动条，想更高就拖下缘手柄。
    // 初始尺寸**显式压到 INIT_H**（不能跟 ComfyUI 默认大尺寸取 max，否则新节点会高得离谱）。
    node.min_size = [220, MIN_H];
    if (typeof node.setSize === 'function') node.setSize([DEF_W, INIT_H]);
    else node.size = [DEF_W, INIT_H];

    setTimeout(hideConfigWidget, 60, node);
    installResizeHandles(node, shell);
    syncSockets(node);
    render(node);
    installOutsideLabels(node);
    startAuto(node);
    // ★ 重试循环（照 MediaLoader 的做法 12 × 120ms）：
    //   ComfyUI 载入工作流 / 刷新时，widget 值恢复、DOM 重建、config 内联样式重写
    //   都可能发生在 setupNode 之后，单次 setTimeout 兜不住 → 密集重试一小段时间。
    //   每轮都：重新藏 config widget + 自愈 DOM + 重读 config（名字）+ 重画。
    let retry = 0;
    (function again() {
      try {
        healDom(node);                       // 内含「重藏 config + 硬设 shell 尺寸」
        loadFromConfig(node);                // 重新读名字（widget 值此刻可能才恢复）
        node._ezRz.sig = '';
        render(node);
        syncSockets(node);
        if (node._ezRzEdgeUpdate) node._ezRzEdgeUpdate();
      } catch (_) {}
      if (retry < 12) { retry += 1; setTimeout(again, 120); }
    })();
  } catch (e) { console.error('[EzFlex-Reroute] init failed:', e); }
}

function startAuto(node) {
  if (node._ezRzAuto) return;
  node._ezRzAuto = true;
}

function hookPrototype(nt) {
  if (!nt || nt.__ezRzHooked) return; nt.__ezRzHooked = true;
  const prevCreated = nt.prototype.onNodeCreated;
  nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure;
  nt.prototype.onConfigure = function (info) {
    const r = prevCfg ? prevCfg.apply(this, arguments) : undefined;
    // ★★ 载入工作流 / 刷新 / 重启 / 复制粘贴的唯一可靠入口：
    //   `info` 是**原始序列化数据**，直接从这里把名字捞出来，
    //   不依赖 widget 值恢复的顺序（位置配对会错位）与时机（widgets_values 可能晚于本钩子）。
    loadFromConfig(this, info);
    try { repairConfig(this, this._ezRz.names); } catch (_) {}
    try { syncSockets(this); } catch (_) {}
    try { this._ezRz.sig = ''; render(this); } catch (_) {}
    // ① widget 值 / DOM 宿主此刻可能还没就位 → 延后再读一次（带 info 兜底，不再只读 widget）；
    // ② DOM 宿主被 Vue 重建时自愈。
    setTimeout(() => {
      try { loadFromConfig(this, info); this._ezRz.sig = ''; render(this); healDom(this); } catch (_) {}
    }, 60);
    setTimeout(() => {
      try { loadFromConfig(this, info); this._ezRz.sig = ''; render(this); healDom(this); } catch (_) {}
    }, 400);
    return r;
  };
  // 接线/断线后同步端口（连一个加一个）+ 刷新面板与外缘黑框。
  // ⚠️ 用 setTimeout(0) 延后，等 LiteGraph 把 graph.links 里的 link 对象补上，pending 守卫生效。
  const prevConn = nt.prototype.onConnectionsChange;
  nt.prototype.onConnectionsChange = function () {
    const r = prevConn ? prevConn.apply(this, arguments) : undefined;
    if (this._ezRzSetup) {
      setTimeout(() => {
        try {
          syncSockets(this);
          this._ezRz.sig = '';
          render(this);
          if (this._ezRzEdgeUpdate) this._ezRzEdgeUpdate();
        } catch (_) {}
      }, 0);
    }
    return r;
  };
  const prevRemoved = nt.prototype.onRemoved;
  nt.prototype.onRemoved = function () {
    const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined;
    try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {}
    this._ezRzSetup = false; this._ezRzAuto = false;
    unregisterNode(this);
    return r;
  };
  const prevAdded = nt.prototype.onAdded;
  nt.prototype.onAdded = function () {
    const r = prevAdded ? prevAdded.apply(this, arguments) : undefined;
    registerNode(this);
    // ★ 展开折叠 / 重新加回画布：DOM 宿主可能刚被重建，延后自愈一次。
    setTimeout(() => { try { healDom(this); } catch (_) {} }, 0);
    setTimeout(() => { try { healDom(this); } catch (_) {} }, 120);
    return r;
  };
}

app.registerExtension({
  name: 'Comfy.EzFlex.Reroute',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() { ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); },
});
