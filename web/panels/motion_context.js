// 面板：MotionContext 面板：钉帧来源与 plan 跟随状态
// EzFlex-MotionContext 面板：把「钉多少帧」这件事从裸 widget 变成能看懂的卡片。
//
// 它解决的问题：`context_length` 与 TimePlan 的 `overlap` 本来是**同一个数**，以前要手抄两遍，
// 改一处另一处不跟 ⇒ 出重复帧 / 丢帧。现在面板上有一个「跟随规划」开关：
//   · 开（默认）+ `timeplan` 接上了 ⇒ 上下文长度**直接取规划的 overlap + tolerance**，
//     手动框变灰并显示那个值（同 SplitVideo 的「总」按钮规矩）；
//   · 关 / 没接规划 ⇒ 用手动框的值。
//
// 三个 widget（context_length / context_audio_length / follow_plan）全部藏起来由面板自绘，
// 值仍走 widgets_values 序列化（面板只是显示层，后端读的还是 widget）。
import { app } from "../../../scripts/app.js";
import { ezApplyDefaultSize,
  NODE_TYPES, nodeTypeOf, installResizeHandles, makeDomWidgetHitThrough,
  installEdgeLabels, hideNativeSlotText, ezCaptureSocketLinks, ezApplySocketLinks,
} from "../core/ezflex_service.js";
import { ezT, onLocaleChange } from "../core/ezflex_i18n.js";
// ★ 与 TimePlan / TimeLine 共用同一套规划算法（同模块 = 同一个数，不会算歪）；
//   悬停气泡也用同一个 tlBindTip ⇒ 外观与 TimeLine/TimePlan 天然一致。
import { tlPlan, tlUpstreamPlanNode, tlInfoTip, tlBindTip } from "../core/loop_nodes.js";

const MC = NODE_TYPES.MOTION_CONTEXT;
const MIN_W = 330;
const MIN_H = 150;
const OUT_ORDER = ["timeplan", "positive", "latent"];
function scheduleReorder(node) {
  if (!node || node._ezOutOrderPend) return;
  node._ezOutOrderPend = true;
  setTimeout(() => {
    node._ezOutOrderPend = false;
    try { reorderOutputs(node); } catch (_) {}
  }, 100);
}
function reorderOutputs(node) {
  // 老工作流的第 1 口叫 trim_frames；先归一成 timeplan，再整体排到第 0 位。
  const legacy = (node.outputs || []).find((s) => s && String(s.name) === 'trim_frames');
  if (legacy) { try { legacy.name = 'timeplan'; legacy.type = 'EZFLEX_TIMEPLAN'; } catch (_) {} }
  let cur = (node.outputs || []).map((s) => String((s && s.name) || '').toLowerCase());
  // 修复已被旧 ensurePlanOut 改坏的工作流：第 1 口被误命名成 timeplan，改回 positive。
  if (cur.length >= 2 && cur[0] === 'timeplan' && cur[1] === 'timeplan') {
    try { node.outputs[1].name = 'positive'; node.outputs[1].type = 'CONDITIONING'; } catch (_) {}
    cur = (node.outputs || []).map((s) => String((s && s.name) || '').toLowerCase());
  }
  if (!cur.length || cur[0] === OUT_ORDER[0]) return;
  if (OUT_ORDER.some((n) => cur.indexOf(n) < 0)) return;
  const cap = ezCaptureSocketLinks(node);
  const by = {};
  (node.outputs || []).forEach((s) => { by[String(s.name || '').toLowerCase()] = s; });
  const next = OUT_ORDER.map((n) => by[n]);
  node.outputs.splice(0, node.outputs.length, ...next);
  next.forEach((s, i) => { try { s.slot_index = i; } catch (_) {} });
  ezApplySocketLinks(node, cap);
  try { node.setDirtyCanvas && node.setDirtyCanvas(true, true); } catch (_) {}
}
const MC_LABELS_LS = 'ezflex.mcLabels';
let _mcLabels = null;
function mcLabelsOn() { if (_mcLabels === null) { try { _mcLabels = window.localStorage.getItem(MC_LABELS_LS) !== '0'; } catch (_) { _mcLabels = true; } } return _mcLabels; }
function mcLabelsSet(on) { _mcLabels = !!on; try { window.localStorage.setItem(MC_LABELS_LS, _mcLabels ? '1' : '0'); } catch (_) {} }
const HIDDEN = ["context_length", "context_audio_length", "follow_plan", "pin_next_head", "mode"];
// 取 ComfyUI 里某类型的口色（各主题不同）：先问 LiteGraph 的配色表，再问 canvas，最后用默认值。
function mcTypeColor(type, fallback) {
  try {
    const LG = window.LiteGraph;
    const tables = [LG && LG.link_type_colors, LG && LG.NODE_TYPE_COLORS, app && app.canvas && app.canvas.default_connection_color_byType];
    for (const t of tables) {
      if (t && typeof t === 'object' && t[type]) return String(t[type]);
    }
  } catch (_) {}
  return fallback;
}

// 与后端 `_EZMC_FPT` / `_ezmc_steps_for_frames` 完全同口径（每 5 个 latent step 覆盖 17 帧）
const FPT = [1, 4, 4, 4, 4];
function stepsForFrames(n) {
  n = parseInt(n, 10) || 0;
  if (n <= 0) return 0;
  let acc = 0;
  for (let k = 1; k < 512; k++) {
    acc += FPT[(k - 1) % 5];
    if (acc === n) return k;
    if (acc > n) return null;
  }
  return null;
}

const CSS = `
.ezmc-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezmc-shell .ezmc-root{pointer-events:auto;}
.ezmc-rows{display:flex;flex-direction:column;gap:8px;min-width:0;}
.ezmc-root{position:absolute;inset:0 14px 14px 14px;font-family:inherit;color:var(--ez-fg);background:var(--ez-bg);
  border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;
  min-width:0;min-height:0;overflow:hidden;}
.ezmc-fld{display:flex;align-items:center;gap:6px;flex:0 0 auto;min-width:0;}
/* 一行一个控件：左边固定宽度的标签列 + 右边控件 */
.ezmc-row{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-width:0;}
.ezmc-lbl{font-size:11px;color:var(--ez-fg-3);white-space:nowrap;flex:0 0 64px;text-align:right;overflow:hidden;
  text-overflow:ellipsis;}
.ezmc-name{height:24px;margin-left:auto;padding:0 8px;border:1px solid var(--ez-border);border-radius:6px;
  background:var(--ez-surface-2);color:var(--ez-fg);font-family:inherit;font-size:11px;cursor:pointer;flex:0 0 auto;}
.ezmc-name.on{background:var(--ez-ok-bg);border-color:var(--ez-ok-border);color:var(--ez-ok-fg);}
.ezmc-num{height:26px;width:58px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);
  color:var(--ez-fg);font-family:inherit;font-size:12px;padding:0 6px;text-align:center;outline:none;box-sizing:border-box;
  -moz-appearance:textfield;appearance:textfield;flex:0 0 auto;}
.ezmc-num::-webkit-outer-spin-button,.ezmc-num::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.ezmc-num:disabled{opacity:.5;cursor:default;}
.ezmc-sw{display:flex;align-items:center;gap:5px;flex:0 0 auto;cursor:pointer;user-select:none;}
.ezmc-seg{display:inline-flex;border:1px solid var(--ez-border);border-radius:6px;overflow:hidden;background:var(--ez-surface-2);}
.ezmc-seg-i{padding:0 7px;height:24px;line-height:24px;font-size:11px;color:var(--ez-fg-muted);font-style:normal;cursor:pointer;}
/* 开 = 绿 / 禁 = 红（与 media_loader 的 On/Off 分段开关同一套约定） */
.ezmc-seg-i.on.active{background:var(--ez-ok-bg);border-color:var(--ez-ok-border);color:var(--ez-ok-fg);font-weight:600;}
.ezmc-seg-i.off.active{background:var(--ez-bad-bg);color:var(--ez-bad-fg);font-weight:600;}
/* 模式切换不是「开/关」：选中色跟**对应主体**走 ——
   参考条件 = CONDITIONING 的口色，冻结 latent = LATENT 的口色（由面板按图的配色注入变量）。 */
.ezmc-sw.mode .ezmc-seg-i.on.active,
.ezmc-sw.mode .ezmc-seg-i.off.active{background:var(--ez-ok-bg);border-color:var(--ez-ok-border);color:var(--ez-ok-fg);font-weight:600;}
`;

let _cssDone = false;
function inject() {
  if (_cssDone) return;
  _cssDone = true;
  try { const s = document.createElement("style"); s.textContent = CSS; document.head.appendChild(s); } catch (_) {}
}
function el(tag, cls) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  return d;
}
function widgetOf(node, name) { return ((node && node.widgets) || []).find((w) => w && w.name === name) || null; }
function hideWidget(w) {
  try {
    w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0; w.draw = () => {};
    w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
    if (w.element && w.element.style) { w.element.style.display = "none"; w.element.style.height = "0"; }
  } catch (_) {}
}
function hideWidgets(node) { HIDDEN.forEach((n) => { const w = widgetOf(node, n); if (w) hideWidget(w); }); }
function setWidget(node, name, val) {
  const w = widgetOf(node, name);
  if (!w) return;
  try { w.value = val; if (typeof w.callback === "function") w.callback(val, app.canvas, node, [0, 0], null); } catch (_) {}
  try { if (node.graph) node.graph.setDirtyCanvas(true, true); } catch (_) {}
}
function wval(node, name, dflt) {
  const w = widgetOf(node, name);
  return (w && w.value !== undefined && w.value !== null) ? w.value : dflt;
}
// 规划里「本段要钉多少帧」= overlap（tolerance 是自由生成的 burn-in，由 SegmentPanel 裁头，不参与钉入）
// ★ 与后端 segments_nodes.py 的 follow_plan 分支同口径：那里也只取 cur.overlapFrames。
function planPin(node) {
  try {
    if (!tlUpstreamPlanNode(node)) return null;      // timeplan 没接 / 追不到规划
    const p = tlPlan(node);
    if (!p || typeof p !== "object") return null;
    const n = Math.max(0, (parseInt(p.ovF, 10) || 0));
    return { frames: n, ov: parseInt(p.ovF, 10) || 0, tol: parseInt(p.tol, 10) || 0, plan: p };
  } catch (_) { return null; }
}
function forceShell(node) {
  const p = node && node._ezmcRoot; if (!p || !p.isConnected) return;
  const si = (t, prop, val) => { try { t.style.setProperty(prop, val, 'important'); } catch (_) {} };
  si(p, 'width', '100%'); si(p, 'max-width', '100%'); si(p, 'height', '100%'); si(p, 'max-height', '100%'); si(p, 'box-sizing', 'border-box');
  if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) { si(p, 'top', 'var(--ezfx-vue-title,30px)'); si(p, 'height', 'calc(100% - var(--ezfx-vue-title,30px))'); si(p, 'bottom', 'auto'); }
}

// ---- 分段开关（On / Off），样式同插件其它面板 ----
function segSwitch(labelText, checked, onChange, onText, offText) {
  const l = el('label', 'ezmc-sw');
  const seg = el('span', 'ezmc-seg');
  const onS = el('em', 'ezmc-seg-i on'); onS.textContent = onText || ezT('On');
  const offS = el('em', 'ezmc-seg-i off'); offS.textContent = offText || ezT('Off');
  seg.appendChild(onS); seg.appendChild(offS);
  if (labelText) { const sp = el('span', 'ezmc-lbl'); sp.textContent = labelText; l.appendChild(sp); }
  l.appendChild(seg);
  let cur = !!checked;
  const upd = () => { onS.classList.toggle('active', cur); offS.classList.toggle('active', !cur); };
  const pick = (v) => (e) => {
    e.preventDefault(); e.stopPropagation();
    if (cur === v) return;
    cur = v; upd(); onChange(v);
  };
  onS.addEventListener('click', pick(true));
  offS.addEventListener('click', pick(false));
  upd();
  l._set = (v) => { cur = !!v; upd(); };
  return l;
}
function numInput(val, onSet) {
  const i = el('input', 'ezmc-num');
  i.type = 'number'; i.min = '0'; i.step = '1'; i.value = String(val);
  const fire = () => { const v = parseInt(i.value, 10); if (!isNaN(v)) onSet(v); };
  i.addEventListener('change', fire);
  i.addEventListener('blur', fire);
  return i;
}

// ---- 渲染：一行一个控件----
//   ① 上下文长度  ② 音频长度  ③ timeplan 开启 / 禁用（禁用 = 红色）
//   开关开着（默认）⇒ 上下文长度由规划决定，手动框变灰显示规划值；禁用 ⇒ 手动框可改。
function render(node, main) {
  const follow = !!wval(node, 'follow_plan', true);
  const pp = planPin(node);
  const usePlan = follow && !!pp;
  const effLen = usePlan ? pp.frames : (parseInt(wval(node, 'context_length', 22), 10) || 0);
  const planAudio = usePlan ? parseInt(pp.plan && pp.plan.audioContextFrames, 10) : NaN;
  const audioLen = usePlan
    ? (isFinite(planAudio) && planAudio > 0 ? planAudio : (effLen || 24))
    : (parseInt(wval(node, 'context_audio_length', 24), 10) || 0);
  const steps = stepsForFrames(effLen);

  main.innerHTML = '';

  // ① 上下文长度（钉入多少帧）
  const r1 = el('div', 'ezmc-row');
  const l1 = el('span', 'ezmc-lbl'); l1.textContent = ezT('Context length');
  const i1 = numInput(effLen, (v) => { setWidget(node, 'context_length', v); node._ezmcRender && node._ezmcRender(); });
  if (usePlan) i1.disabled = true;                 // 跟随规划 ⇒ 手动框变灰（显示规划算出来的值）
  i1.title = (effLen > 0)
    ? ((steps != null) ? (ezT('Pinned frames') + ': ' + effLen + ' · ' + steps + ' step')
                       : (ezT('Pin geometry') + ': ' + effLen + ' (H3 = 17k+5)'))
    : (ezT('Pinned frames') + ': 0');
  // 跟随规划时说明另一部分去哪了：tolerance 不钉，由 SegmentPanel 从头部裁掉。
  if (usePlan && pp.tol > 0) i1.title += ' · ' + ezT('Head trim') + ' ' + pp.tol;
  r1.appendChild(l1); r1.appendChild(i1);

  // ② 音频长度：和上下文长度同一行（用户要求）
  const l2 = el('span', 'ezmc-lbl'); l2.textContent = ezT('Audio length');
  const i2 = numInput(audioLen, (v) => { setWidget(node, 'context_audio_length', v); node._ezmcRender && node._ezmcRender(); });
  if (usePlan) i2.disabled = true;   // TimePlan 控制过渡音频；未接时仍可手动输入
  // ★ 悬停说明「这个数是干什么的」：H3 是音视频联合生成，只钉视频尾巴不钉音频尾巴，
  //   接缝处的音频会被重新生成（可能跳一下）。单位是**视频帧**（后端 ÷24×40 换成音频 token）。
  i2.title = ezT('Audio length') + '：' + (usePlan
    ? ezT('Controlled by TimePlan; this box is disabled while following the plan.')
    : ezT('0 = follow the context length above (audio is pinned too, 0.92s at 22). Official example: video 22 pairs with audio 24.'));
  r1.appendChild(l2); r1.appendChild(i2);

  // ③ 第一行：模式（参考条件 / 冻结 latent）+ 端口名称
  const r0 = el('div', 'ezmc-row');
  const maskedNow = String(wval(node, 'mode', 'keyframe')).toLowerCase() === 'masked';
  const swMode = segSwitch(ezT('Mode'), !maskedNow,
    (v) => { setWidget(node, 'mode', v ? 'keyframe' : 'masked'); node._ezmcRender && node._ezmcRender(); },
    ezT('Condition'), ezT('Freeze latent'));
  try {
    swMode.classList.add('mode');
    swMode.style.setProperty('--ezmc-c-cond', mcTypeColor('CONDITIONING', '#FFA931'));
    swMode.style.setProperty('--ezmc-c-latent', mcTypeColor('LATENT', '#FF9CF9'));
  } catch (_) {}
  swMode.title = ezT('Condition: the previous tail becomes conditioning rows (the model may reshape it). Freeze latent: copy the previous tail into this latent prefix and lock it (wire latent to the sampler).');
  r0.appendChild(swMode);
  const nameBtn = el('button', 'ezmc-name'); nameBtn.type = 'button'; nameBtn.textContent = ezT('Names');
  nameBtn.title = ezT('Show or hide the black port labels');
  const syncName = () => { nameBtn.classList.toggle('on', mcLabelsOn()); };
  syncName();
  nameBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    mcLabelsSet(!mcLabelsOn()); syncName();
    try { node._ezEdgeUpdate && node._ezEdgeUpdate(); } catch (_) {}
    try { if (node.graph) node.graph.setDirtyCanvas(true, true); } catch (_) {}
  });
  r0.appendChild(nameBtn);

  // ④ 第三行：timeplan 跟随 + 钉入下一段（冻结模式下不生效，正样本透传）
  const r3 = el('div', 'ezmc-row');
  const sw = segSwitch(ezT('timeplan'), follow,
                       (v) => { setWidget(node, 'follow_plan', v); node._ezmcRender && node._ezmcRender(); },
                       ezT('Enable'), ezT('Disable'));
  if (pp) { try { tlBindTip(sw, () => tlInfoTip('overlap', pp.plan)); } catch (_) {} }
  r3.appendChild(sw);
  const pinNext = !!wval(node, 'pin_next_head', false);
  const swNext = segSwitch(ezT('Pin next head'), pinNext,
    (v) => { setWidget(node, 'pin_next_head', v); node._ezmcRender && node._ezmcRender(); },
    ezT('Enable'), ezT('Disable'));
  swNext.title = ezT('Experimental: only when TimeLine re-runs this segment and the next segment has a saved latent. Not used in Freeze latent mode.');
  r3.appendChild(swNext);

  [r0, r1, r3].forEach((r) => main.appendChild(r));
}

// ★★ 端口清理（同 TimeLine / TimePlan 的做法，2026-10-15 用户报「第一个端口一堆重叠的」）：
//   Nodes 2.0 会把**widget 型输入**（`context_length` / `context_audio_length` / `follow_plan`）
//   也画成原生 socket，全部挤在第一个口上、连标签文字一起叠在一起。
//   ⇒ 从 `node.inputs` 里摘掉，画布上只留**真端口**：`positive` / `latent` / `context_latent` / `timeplan`。
const KEEP_IN = ["positive", "latent", "context_latent", "context_video_latent", "context_audio_latent", "timeplan"];
const hasLink = (s) => !!(s && (s.link != null || (Array.isArray(s.links) && s.links.length)));
function normalizeInputs(node) {
  // ① 摘 widget 型输入（它们不是画布端口，留着会叠成一堆）
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    const s = node.inputs[i];
    if (!s || KEEP_IN.indexOf(String(s.name)) >= 0) continue;
    try { node.removeInput(i); } catch (_) { try { node.inputs.splice(i, 1); } catch (_2) {} }
  }
  (node.inputs || []).forEach((s) => { if (s && s.widget) { try { delete s.widget; } catch (_) {} } });
  // ② 去重：`cloneObject` 按**源数组下标**覆盖 ⇒ 老工作流少一个口时会让同名口复制成两份
  //    （例：没有 follow_plan 的老工作流会把 timeplan 复制一份到 follow_plan 的位置）。
  const by = {};
  (node.inputs || []).forEach((s, i) => { const nm = String((s && s.name) || ''); if (nm) (by[nm] = by[nm] || []).push(i); });
  const drop = new Set();
  Object.keys(by).forEach((nm) => {
    const idxs = by[nm];
    if (idxs.length < 2) return;
    const wl = idxs.find((i) => hasLink(node.inputs[i]));
    const keepIdx = (wl === undefined) ? idxs[0] : wl;
    idxs.forEach((i) => { if (i !== keepIdx) drop.add(i); });
  });
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    if (!drop.has(i)) continue;
    try { node.removeInput(i); } catch (_) { try { node.inputs.splice(i, 1); } catch (_2) {} }
  }
  // ③ `timeplan` 排**最上面**（用户要求）。搬 socket 之前先按对象拍连线快照，
  //    搬完再按快照回写 target_slot（新版前端 input.link 是按当前下标现拼的，搬完再读会指错口）。
  const ix = (node.inputs || []).findIndex((s) => s && String(s.name) === "timeplan");
  if (ix > 0) {
    const cap = ezCaptureSocketLinks(node);
    node.inputs.unshift(node.inputs.splice(ix, 1)[0]);
    ezApplySocketLinks(node, cap);
  }
}
function paintPorts(node) {
  try { normalizeInputs(node); } catch (_) {}
  ((node.inputs || [])).forEach((s) => { try { hideNativeSlotText(s); } catch (_) {} });
  ((node.outputs || [])).forEach((s) => { try { hideNativeSlotText(s); } catch (_) {} });
  try { installEdgeLabels(node, { side: 'both', rootOf: (n) => n._ezmcRoot, labelOf: (s) => ((s && s.name) || ''), enabled: () => mcLabelsOn() }); } catch (_) {}
}

function normalizeWidgets(node) {
  const defs = { context_length: 22, context_audio_length: 24, follow_plan: true, pin_next_head: false, mode: "keyframe" };
  Object.keys(defs).forEach((nm) => {
    const w = widgetOf(node, nm);
    if (w && (w.value === null || w.value === undefined || w.value === '')) w.value = defs[nm];
  });
}
function mount(node) {
  if (!node || node._ezmcSetup) return;
  node._ezmcSetup = true;
  inject();
  const shell = el('div', 'ezmc-shell');
  const root = el('div', 'ezmc-root');
  // 一行一个控件 ⇒ 纵向排列（不再有工具条 / 徽标 / 底部状态行）
  const main = el('div', 'ezmc-rows');
  root.appendChild(main);
  shell.appendChild(root);
  node._ezmcRoot = shell;
  const rerender = () => { render(node, main); paintPorts(node); };
  node._ezmcRender = rerender;
  rerender();

  const widget = node.addDOMWidget("MotionContext", "ezmc__" + Math.random().toString(36).slice(2), shell, {
    serialize: false, hideOnZoom: false, canvasOnly: !(window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()),
    margin: 4, getMinHeight: () => MIN_H, getValue: () => "{}", setValue: () => {},
  });
  makeDomWidgetHitThrough(widget.element || shell);
  try { node.widgets_start_y = 0; } catch (_) {}
  try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
  installResizeHandles(node, shell);
  try { ezApplyDefaultSize(node, MIN_W, MIN_H); } catch (_) {}
  hideWidgets(node);
  forceShell(node);
  // ★ 自愈：宿主 widget 可能被重建（切图 / 折叠 / 切 tab）⇒ 重挂 + 短时主动轮询（到期自停）
  let retry = 0;
  (function again() {
    forceShell(node);
    try { hideWidgets(node); node._ezmcRender && node._ezmcRender(); } catch (_) {}
    if (retry < 10) { retry += 1; setTimeout(again, 120); }
  })();
}

function hook(nt) {
  if (!nt || nt.__ezmcHooked) return;
  nt.__ezmcHooked = true;
  const pc = nt.prototype.onNodeCreated;
  nt.prototype.onNodeCreated = function () {
    const r = pc ? pc.apply(this, arguments) : undefined;
    try { mount(this); } catch (_) {}
    try { paintPorts(this); } catch (_) {}      // ★ 面板挂失败也要保证端口干净
    return r;
  };
  const pm = nt.prototype.onConfigure;
  nt.prototype.onConfigure = function () { this.__ezSizeRestored = true;
    const r = pm ? pm.apply(this, arguments) : undefined;
    try { scheduleReorder(this); } catch (_) {}
    try { if (!this._ezmcSetup) mount(this); } catch (_) {}
    try { normalizeWidgets(this); } catch (_) {}
    try { hideWidgets(this); } catch (_) {}
    try { if (this._ezmcRender) this._ezmcRender(); else paintPorts(this); } catch (_) {}
    return r;
  };
  const pcc = nt.prototype.onConnectionsChange;
  nt.prototype.onConnectionsChange = function () {
    const r = pcc ? pcc.apply(this, arguments) : undefined;
    try { if (this._ezmcRender) this._ezmcRender(); else paintPorts(this); } catch (_) {}
    return r;
  };
  const pr = nt.prototype.onRemoved;
  nt.prototype.onRemoved = function () {
    const r = pr ? pr.apply(this, arguments) : undefined;
    try { if (this._ezmcRoot) this._ezmcRoot.remove(); } catch (_) {}
    this._ezmcSetup = false;
    return r;
  };
}

onLocaleChange(() => {
  try {
    const g = (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
    ((g && g._nodes) || []).forEach((n) => {
      if (nodeTypeOf(n) !== MC) return;
      try { n._ezmcRender && n._ezmcRender(); } catch (_) {}
    });
  } catch (_) {}
});

app.registerExtension({
  name: "EzFlex.MotionContext",
  async beforeRegisterNodeDef(nt, nd) {
    if (nd && nd.name === MC) hook(nt);
  },
  nodeCreated(n) {
    if (nodeTypeOf(n) !== MC) return;
    // ★ 分开 try：面板挂失败也必须把端口清理/迁移做掉
    try { mount(n); } catch (_) {}
    try { paintPorts(n); } catch (_) {}
  },
});
