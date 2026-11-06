// 面板：SplitVideo 面板：卡片换序搬线、按 timeplan 取本段素材
// EzFlex-SplitVideo：卡片式切源视频。**一张卡 = 一个 video_N 输入口 + 一个 Segment N 输出口**。
// 切分规则（模式 + 值）：
//   · 面板**顶部那条 = 总控制**（改它影响所有「总」按钮亮着的卡片）；
//   · **每张卡末尾有一个「总」按钮（默认亮/绿）**：亮 = 跟随总控制（自己的控件变灰、显示总控的值），
//     点一下灭掉 = 用这张卡自己的模式/值（存 config 的 cards[i]）。样式同 prompt_helper 的权重按钮（.on = 绿）。
// 输出第一个口是 timeplan 透传（后端返回，面板不碰）。
// 样式/交互照抄 preprocessor.js：工具条永远一行、卡片 .eph-card 令牌、拖拽插入横线（pointer 事件）、DOM 自愈四件套。
import { app } from "../../../scripts/app.js";
import { ezApplyDefaultSize, ezDropOutput, ezRestoreSavedSize,
  NODE_TYPES, nodeTypeOf, installResizeHandles, makeDomWidgetHitThrough,
  installEdgeLabels, hideNativeSlotText, readConfig, writeConfig,
} from "../core/ezflex_service.js";
import { ezT, onLocaleChange } from "../core/ezflex_i18n.js";

const SV = NODE_TYPES.SPLIT_VIDEO;
const MAX = 16;                // 与后端 _EZSV_MAX 一致（后端全声明，前端按卡片数裁）
const MIN_W = 540;             // 固定比例：小按钮 + 中等下拉 + 中等输入
const MIN_H = 60;
// 面板自己画的（原生 widget 全部藏起来；值仍走 widgets_values 序列化）
const HIDDEN = ["mode", "one_start", "one_end", "max_frames", "out_type", "start_frame", "end_frame", "select_every_nth", "config"];
const MODES = [["loop", "Loop (by index)"], ["one", "One segment"], ["frames", "Frame range"]];
// 每张卡切出来的东西以什么形态从这个口出去（后端 SplitVideoNode.out_type 同口径）
const OUT_TYPES = [["frames", "Frame sequence"], ["video", "Video (mp4)"], ["gif", "GIF"], ["audio", "Audio track"]];

const CSS = `
.ezsv-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezsv-shell .ezsv-root{pointer-events:auto;}
.ezsv-root{position:absolute;inset:0 14px 14px 14px;font-family:inherit;color:var(--ez-fg);background:var(--ez-bg);
  border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;
  min-width:0;min-height:0;overflow:hidden;}
/* 工具条：永远一行（放不下就压缩，不折行） */
.ezsv-tb{display:flex;align-items:center;gap:5px;flex:0 0 auto;flex-wrap:nowrap;padding-bottom:6px;
  border-bottom:1px solid var(--ez-border-2);overflow:hidden;min-width:0;}
.ezsv-tb select,.ezsv-tb input,.ezsv-sel,.ezsv-num{height:26px;border:1px solid var(--ez-border);border-radius:6px;
  background:var(--ez-surface-2);color:var(--ez-fg);font-family:inherit;font-size:12px;padding:0 6px;
  outline:none;box-sizing:border-box;min-width:0;}
/* 设置弹窗（第一行「设置」打开）：帧上限 / 抽帧，和 VHS 的 frame_load_cap / select_every_nth 同语义 */
.ezsv-modal{position:fixed;inset:0;z-index:100300;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;}
.ezsv-mbox{width:min(520px,94vw);background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);display:flex;flex-direction:column;padding:12px 14px;box-sizing:border-box;}
.ezsv-mhd{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid var(--ez-border-2);padding-bottom:8px;margin-bottom:10px;}
.ezsv-mtitle{font-size:13px;font-weight:600;color:var(--ez-fg);}
.ezsv-mclose{width:26px;height:26px;line-height:1;border:1px solid var(--ez-border);border-radius:7px;background:var(--ez-surface-2);color:var(--ez-fg);cursor:pointer;font:inherit;font-size:15px;padding:0;}
.ezsv-mclose:hover{background:var(--ez-surface-3);}
.ezsv-mbody{display:flex;flex-direction:column;gap:10px;}
.ezsv-srow{display:grid;grid-template-columns:110px 90px 1fr;align-items:center;gap:10px;}
.ezsv-slab{font-size:12px;color:var(--ez-fg);}
.ezsv-srow .ezsv-num{width:90px;flex:0 0 90px;text-align:center;}
.ezsv-shint{font-size:11px;line-height:1.45;color:var(--ez-fg-3);}
.ezsv-sbtns{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;}
.ezsv-tb select,.ezsv-sel{cursor:pointer;}
.ezsv-tb select{flex:0 0 110px;width:110px;min-width:100px;overflow:hidden;text-overflow:ellipsis;}
.ezsv-sel{flex:0 0 110px;width:110px;min-width:100px;}
.ezsv-tb input,.ezsv-num{flex:0 0 58px;width:58px;min-width:0;text-align:center;-moz-appearance:textfield;appearance:textfield;}
.ezsv-tb input::-webkit-outer-spin-button,.ezsv-tb input::-webkit-inner-spin-button,
.ezsv-num::-webkit-outer-spin-button,.ezsv-num::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.ezsv-tb input:disabled,.ezsv-sel:disabled,.ezsv-num:disabled{opacity:.45;cursor:default;}
.ezsv-lbl{font-size:11px;color:var(--ez-fg-3);white-space:nowrap;flex:0 0 auto;}
.ezsv-btn{height:26px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);
  color:var(--ez-fg);font-family:inherit;font-size:11px;padding:0 8px;cursor:pointer;flex:0 0 auto;
  white-space:nowrap;line-height:1;}
.ezsv-btn:hover{background:var(--ez-surface-3);}
.ezsv-btn.pri{background:var(--ez-strong);border-color:var(--ez-strong);color:var(--ez-on-strong);margin-left:0;}
.ezsv-btn.pri:hover{filter:brightness(1.06);}
.ezsv-list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;}
.ezsv-hint{font-size:11px;color:var(--ez-fg-muted);padding:10px 4px;text-align:center;}
/* 卡片：仿 prompt_helper .eph-card（surface 底 + 10 圆角） */
.ezsv-card{display:flex;align-items:center;gap:5px;background:var(--ez-surface);border:1px solid var(--ez-border-2);
  border-radius:10px;padding:7px 8px;flex:0 0 auto;width:100%;min-width:0;overflow:hidden;}
.ezsv-card.dragging{opacity:.4;}
.ezsv-card .ezsv-index{flex:0 0 16px;width:16px;}
.ezsv-card .ezsv-handle{flex:0 0 14px;width:14px;}
.ezsv-card .ezsv-sel{flex:0 1 100px;width:100px;min-width:70px;max-width:100px;}
.ezsv-card .ezsv-time{flex:1 1 150px;min-width:110px;max-width:none;}
.ezsv-card .ezsv-mbtn{flex:0 0 24px;}
.ezsv-card .ezsv-x{flex:0 0 16px;width:16px;padding:0;}
.ezsv-index{font-size:12px;font-weight:600;color:var(--ez-fg-3);width:18px;text-align:center;flex:0 0 auto;}
.ezsv-handle{cursor:grab;color:var(--ez-fg-muted);font-size:14px;line-height:1.5;width:16px;text-align:center;flex:0 0 auto;user-select:none;}
.ezsv-handle:hover{color:var(--ez-fg);}
.ezsv-handle:active{cursor:grabbing;}
/* 「总」按钮：亮 = 跟随上面的总控制（样式同 prompt_helper 权重按钮的 .on = 绿） */
.ezsv-mbtn{height:24px;width:24px;min-width:0;padding:0;border-radius:6px;border:1px solid var(--ez-border);
  background:var(--ez-surface-2);color:var(--ez-fg-muted);font-family:inherit;font-size:10px;font-weight:480;
  cursor:pointer;flex:0 0 auto;line-height:1;transition:all .12s;overflow:hidden;}
.ezsv-mbtn:hover{background:var(--ez-surface-3);color:var(--ez-fg);}
.ezsv-mbtn.on{background:var(--ez-ok-bg);border-color:var(--ez-ok-border);color:var(--ez-ok-fg);font-weight:600;}
.ezsv-mbtn.on:hover{background:var(--ez-ok-bg);color:var(--ez-ok-fg);}
/* 卡片里的两个下拉（模式 + 输出形态）压窄一点，窄节点也不会把 ✕ 挤出去 */
.ezsv-card .ezsv-sel{flex:0 1 100px;width:100px;min-width:70px;max-width:100px;overflow:hidden;text-overflow:ellipsis;}
.ezsv-time{display:flex;align-items:center;gap:3px;min-width:110px;min-height:26px;overflow:hidden;flex:1 1 150px;}
.ezsv-time .ezsv-num{flex:1 1 0;width:0;min-width:30px;padding:0 2px;}
.ezsv-time .ezsv-lbl{font-size:9px;overflow:hidden;text-overflow:ellipsis;max-width:28px;min-width:0;}
.ezsv-time .ezsv-lbl{flex:0 0 auto;}
.ezsv-x{background:transparent;border:none;color:var(--ez-fg-muted);font-size:15px;cursor:pointer;
  padding:1px 4px;flex:0 0 auto;line-height:1;}
.ezsv-x:hover{color:var(--ez-bad-fg);background:var(--ez-bad-bg);border-radius:6px;}
/* 拖拽「即将插入」横线（同 prompt_helper 的 .eph-ph） */
.ezsv-ph{height:0;border-top:3px solid var(--ez-strong);border-radius:2px;margin:1px 0;opacity:.9;
  box-shadow:0 1px 6px rgba(43,58,74,.35);flex:0 0 auto;}
.ezsv-ph.hidden{display:none;}
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
// 顶部「总控制」的当前值（卡片「总」按钮亮着时就用它）
function masterRule(node) {
  const g = (n, d) => { const w = widgetOf(node, n); return w && w.value !== undefined && w.value !== null ? w.value : d; };
  const m = String(g("mode", "loop")).toLowerCase();
  const mode = (m === "one" || m === "frames") ? m : "loop";
  return { mode: mode,
           oneStart: Number(g("one_start", 0)) || 0,
           oneEnd: Number(g("one_end", 5)) || 0,
           startFrame: parseInt(g("start_frame", 0), 10) || 0,
           endFrame: parseInt(g("end_frame", 0), 10) || 0,
           outType: normOut(g("out_type", "frames"), "frames") };
}
// 输出形态（后端 out_type）：frames = IMAGE 批次 / video = 切好的 mp4 / gif = 落盘的动图
function normOut(v, dflt) {
  const s = String(v == null ? "" : v).toLowerCase();
  return (s === "frames" || s === "video" || s === "gif" || s === "audio") ? s : dflt;
}

// ---- 面板状态（每张卡：useMaster 默认 true + 自己的模式/值/输出形态）----
function normCard(c, m) {
  c = (c && typeof c === "object") ? c : {};
  const mode = (c.mode === "loop" || c.mode === "one" || c.mode === "frames") ? c.mode : m.mode;
  return {
    useMaster: c.useMaster === undefined ? true : !!c.useMaster,   // ★ 默认跟随上面的总控制
    mode: mode,
    oneStart: typeof c.oneStart === "number" ? c.oneStart : m.oneStart,
    oneEnd: typeof c.oneEnd === "number" ? c.oneEnd : m.oneEnd,
    startFrame: Number.isFinite(parseInt(c.startFrame, 10)) ? parseInt(c.startFrame, 10) : m.startFrame,
    endFrame: Number.isFinite(parseInt(c.endFrame, 10)) ? parseInt(c.endFrame, 10) : m.endFrame,
    outType: normOut(c.outType, m.outType),                        // ★ 每张卡自己的输出形态
  };
}
function state(node) {
  let d = {};
  try { d = readConfig(node) || {}; } catch (_) { d = {}; }
  const m = masterRule(node);
  let cards = Array.isArray(d.cards) ? d.cards.slice(0, MAX) : [];
  // 删除最后一张卡时 config 写入若被宿主吞掉，用内存值兜住，避免“删了又回来”。
  if (Array.isArray(node._ezsvCards)) cards = node._ezsvCards.slice(0, MAX);
  return { cards: cards.map((c) => normCard(c, m)) };
}
function setState(node, st) {
  node._ezsvCards = (st && Array.isArray(st.cards)) ? st.cards.slice() : [];
  try { writeConfig(node, st); } catch (_) {}
}
function cardCount(node) { return Math.max(0, Math.min(MAX, state(node).cards.length)); }
// 节点级（总控制）输出形态
function outTypeOf(node) { return masterRule(node).outType; }

// ---- 端口：timeplan + video_1..n ‖ timeplan + Segment 1..n ----
// 后端一口气声明 MAX 个卡片位 ⇒ 这里按实际卡片数裁（同 LoopStart/LoopEnd 的做法）。
// ★★ 两条铁律（修「刷新后除了第一张卡，后面的输入输出连线都保持不住」）：
//   ① **绝不删有连线的口**。工作流加载时内核按**槽位下标**回填连线（`inputs[i].link` /
//      `outputs[i].links`）；少一个槽，后面的线就整体错位/丢弃。
//   ② `configure` 期间**只增不删**（`opts.trim === false`）。configure 里 `onConnectionsChange`
//      先于 `widgets_values` 恢复被调用，此刻读 config 只会得到空 ⇒ cardCount=1 ⇒
//      按 ① 虽然保住了有线的那几个，但「没连线的中间槽」还是会被抽掉、后面的线跟着错位。
//      所以 render 同步只增不删，真正的裁口交给 `scheduleTrim()` 延到 configure 结束后再跑。
function sockLinked(s) { return !!(s && (s.link != null || (Array.isArray(s.links) && s.links.length))); }
function ensureSockets(node, n, opts) {
  const trim = !(opts && opts.trim === false);
  // force = 用户**明确**删掉某张卡：这时连着的线也一起收掉（端口都没了，留着线没意义）。
  // 加载/自愈路径绝不 force —— 那正是「刷新后连线丢光」的来源。
  const force = !!(opts && opts.force);
  const cnt = Math.max(0, Math.min(MAX, n));
  const wantIn = ["timeplan"].concat(Array.from({ length: cnt }, (_, i) => "video_" + (i + 1)));
  const wantOut = ["timeplan"].concat(Array.from({ length: cnt }, (_, i) => "Segment " + (i + 1)));
  // 输入：从后往前删掉「不在名单里」的。widget 输入（mode/one_start/…/config）永远摘（它们不是真端口，
  // 留着会在 Nodes 2.0 里画成一堆挤在一起的原生 socket）；其余多出来的只有 trim 时才摘。
  const ins = node.inputs || [];
  for (let i = ins.length - 1; i >= 0; i--) {
    const s = ins[i];
    if (!s || wantIn.indexOf(String(s.name)) >= 0) continue;
    if (!force && sockLinked(s)) continue;             // ① 有连线 ⇒ 绝不删
    if (!trim && !s.widget) continue;                  // ② 未就绪 ⇒ 只摘 widget 输入
    try { node.removeInput(i); } catch (_) { try { ins.splice(i, 1); } catch (_2) {} }
  }
  wantIn.forEach((nm) => {
    if (!(node.inputs || []).some((s) => s && String(s.name) === nm)) {
      try { node.addInput(nm, "*"); } catch (_) {}
    }
  });
  // 输出：同理（第 0 个是 timeplan 透传，固定不动）
  const outs = node.outputs || [];
  for (let i = outs.length - 1; i >= 1; i--) {
    const s = outs[i];
    if (!s || wantOut.indexOf(String(s.name)) >= 0) continue;
    if (!force && sockLinked(s)) continue;             // ①
    if (!trim) continue;                               // ②
    if (!ezDropOutput(node, i)) { try { outs.splice(i, 1); } catch (_2) {} }
  }
  wantOut.forEach((nm) => {
    if (!(node.outputs || []).some((s) => s && String(s.name) === nm)) {
      try { node.addOutput(nm, "*"); } catch (_) {}
    }
  });
}

// 卡片顺序变了 ⇒ 把连线按新顺序搬到对应口上（连线跟着卡片走），再按位置重命名端口
function permutePorts(node, perm) {
  const g = node.graph;
  if (!g || !g.links) return;
  // 新版前端（frontend 1.55+）的 socket.links 只是按当前下标现拼的兼容视图：
  // 给它赋空值会真断开那几条线，赋 id 却什么也不会发生 ⇒ 新前端只改 link 的 target_slot/origin_slot。
  const store = g.links instanceof Map;
  const permIn = [0].concat(perm.map((p) => p + 1));
  const ins = node.inputs || [];
  const oldIn = ins.map((s) => (s && s.link != null ? s.link : null));
  const inMoves = [];
  // 只搬 permIn 覆盖的新位置；删除卡片时旧的末位端口不在映射里，留给 ensureSockets 收掉。
  ins.slice(0, permIn.length).forEach((s, i) => {
    const src = oldIn[permIn[i] == null ? i : permIn[i]];
    if (src == null || !s) return;
    inMoves.push({ s, lid: src, i });
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
  const permOut = [0].concat(perm.map((p) => p + 1));
  const outs = node.outputs || [];
  const oldOut = outs.map((s) => {
    const a = []; if (s && Array.isArray(s.links)) a.push(...s.links); if (s && s.link != null) a.push(s.link);
    return a;
  });
  outs.slice(0, permOut.length).forEach((s, i) => {
    if (!s) return;
    const ls = oldOut[permOut[i] == null ? i : permOut[i]] || [];
    if (!store) { try { s.links = ls.length ? ls.slice() : null; } catch (_) {} }
    ls.forEach((lid) => { const lk = g.links[lid]; if (lk) { try { lk.origin_id = node.id; lk.origin_slot = i; } catch (_) {} } });
  });
  (node.inputs || []).forEach((s, i) => { if (s && i >= 1) s.name = "video_" + i; });
  (node.outputs || []).forEach((s, i) => { if (s && i >= 1) s.name = "Segment " + i; });
}

function paintPorts(node) {
  ((node.inputs || [])).forEach((s) => { try { hideNativeSlotText(s); } catch (_) {} });
  ((node.outputs || [])).forEach((s) => { try { hideNativeSlotText(s); } catch (_) {} });
  try {
    installEdgeLabels(node, {
      side: "both",
      rootOf: (n) => n._ezsvRoot,
      labelOf: (s, i, isIn) => {
        const nm = String((s && s.name) || "");
        if (nm === "timeplan") return "timeplan";
        if (isIn) return ezT("Video") + " " + nm.replace(/\D/g, "");
        return ezT("Segment") + " " + nm.replace(/\D/g, "");
      },
    });
  } catch (_) {}
}

function forceShell(node) {
  const p = node && node._ezsvRoot;
  if (!p || !p.isConnected) return;
  const si = (t, prop, val) => { try { t.style.setProperty(prop, val, "important"); } catch (_) {} };
  si(p, "width", "100%"); si(p, "max-width", "100%"); si(p, "height", "100%"); si(p, "max-height", "100%");
  si(p, "box-sizing", "border-box");
  if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) {
    si(p, "top", "var(--ezfx-vue-title,30px)");
    si(p, "height", "calc(100% - var(--ezfx-vue-title,30px))");
    si(p, "bottom", "auto");
  }
}

function modeSelect(cur, onPick) {
  const s = el('select', 'ezsv-sel');
  MODES.forEach(([v, key]) => {
    const o = el('option'); o.value = v; o.textContent = ezT(key);
    if (String(cur) === v) o.selected = true;
    s.appendChild(o);
  });
  s.addEventListener('change', () => onPick(s.value));
  return s;
}
// 输出形态下拉（frames / video / gif）：顶部那条 = 总控制，每张卡也有自己的一个
function outSelect(cur, onPick) {
  const s = el('select', 'ezsv-sel');
  OUT_TYPES.forEach(([v, key]) => {
    const o = el('option'); o.value = v; o.textContent = ezT(key);
    if (String(cur) === v) o.selected = true;
    s.appendChild(o);
  });
  s.title = ezT("Output type");
  s.addEventListener('change', () => onPick(s.value));
  return s;
}
function numInput(val, step, onPick) {
  const i = el('input', 'ezsv-num'); i.type = 'number'; i.step = step || '0.1';
  i.value = String(val == null ? 0 : val);
  i.addEventListener('change', () => { const v = parseFloat(i.value); if (!isNaN(v)) onPick(v); });
  return i;
}

// 第一行 ⚙ = 设置弹窗：帧上限 / 抽帧（只对 frames / GIF 输出生效，三种切分方式都一样）
function openSettings(node) {
  try { if (node._ezsvSetEl) node._ezsvSetEl.remove(); } catch (_) {}
  node._ezsvSetEl = null;
  const cur = (name, dflt) => {
    const w = widgetOf(node, name);
    const n = parseInt(w && w.value != null ? w.value : dflt, 10);
    return isFinite(n) ? n : dflt;
  };
  const modal = el('div', 'ezsv-modal');
  const box = el('div', 'ezsv-mbox');
  const hd = el('div', 'ezsv-mhd');
  const title = el('div', 'ezsv-mtitle'); title.textContent = ezT('Settings');
  const close = el('button', 'ezsv-mclose'); close.type = 'button'; close.textContent = '×'; close.title = ezT('Cancel');
  hd.appendChild(title); hd.appendChild(close);
  const body = el('div', 'ezsv-mbody');
  const row = (label, hint, val, min, max) => {
    const r = el('div', 'ezsv-srow');
    const l = el('div', 'ezsv-slab'); l.textContent = label;
    const inp = el('input', 'ezsv-num'); inp.type = 'number'; inp.min = String(min); inp.max = String(max); inp.step = '1'; inp.value = String(val);
    const h = el('div', 'ezsv-shint'); h.textContent = hint;
    r.appendChild(l); r.appendChild(inp); r.appendChild(h);
    body.appendChild(r);
    return inp;
  };
  const mf = row(ezT('Max frames'), ezT('Only frames / GIF outputs are capped; 0 = no limit.'),
                 Math.max(0, cur('max_frames', 960)), 0, 20000);
  const ev = row(ezT('Every N'), ezT('Only frames / GIF outputs are sampled; 0 = no thinning.'),
                 Math.max(0, cur('select_every_nth', 0)), 0, 1000);
  const btns = el('div', 'ezsv-sbtns');
  const save = el('button', 'ezsv-btn pri'); save.type = 'button'; save.textContent = ezT('Save');
  const cancel = el('button', 'ezsv-btn'); cancel.type = 'button'; cancel.textContent = ezT('Cancel');
  btns.appendChild(save); btns.appendChild(cancel);
  box.appendChild(hd); box.appendChild(body); box.appendChild(btns); modal.appendChild(box);
  const closeIt = () => { try { modal.remove(); } catch (_) {} node._ezsvSetEl = null; };
  const applySave = () => {
    const mv = Math.max(0, Math.min(20000, parseInt(mf.value, 10) || 0));
    const sv = Math.max(0, Math.min(1000, parseInt(ev.value, 10) || 0));
    setWidget(node, 'max_frames', mv);
    setWidget(node, 'select_every_nth', sv);
    closeIt();
    node._ezsvRender && node._ezsvRender();
  };
  save.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); applySave(); });
  cancel.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeIt(); });
  close.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeIt(); });
  // 点弹窗外（画布/遮罩）松开 = 保存并关闭；框内按下拖出去不算
  let downInBox = false;
  modal.addEventListener('mousedown', (e) => { downInBox = box.contains(e.target); });
  modal.addEventListener('mouseup', (e) => {
    const startedInBox = downInBox; downInBox = false;
    if (!startedInBox && e.target === modal) applySave();
  });
  node._ezsvSetEl = modal;
  document.body.appendChild(modal);
}

// ★ 拖拽排序（照抄 preprocessor.js 的成熟做法：**pointer 事件 + window 捕获**；
//   mousedown/mousemove 会被画布/宿主吞掉 ⇒ 之前拖不动就是这个原因）
function attachDnD(container, itemSel, handleSel, onDrop) {
  container.querySelectorAll(".ezsv-ph").forEach((x) => x.remove());
  const ph = el("div", "ezsv-ph hidden");
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

// ---- 渲染 ----
// ★ 裁口（删多余端口）一律**延到下一个宏任务**再做：`configure` 里 `onConnectionsChange` 先于
//   `widgets_values` 恢复被调用，此刻 cardCount 还是 1；同步裁口会把后面几张卡的槽抽掉，
//   内核按槽位回填连线时那些线就丢了（「刷新后除了第一张，后面的连线都保持不住」）。
//   render 同步只做「只增不删」，真正的裁口交给 scheduleTrim 在 configure 结束后跑。
function scheduleTrim(node) {
  if (node._ezsvTrimT) return;
  try {
    node._ezsvTrimT = setTimeout(() => {
      node._ezsvTrimT = 0;
      try { ensureSockets(node, cardCount(node), { trim: true }); } catch (_) {}
      try { paintPorts(node); } catch (_) {}
    }, 0);
  } catch (_) {}
}
function render(node, tb, list) {
  ensureSockets(node, cardCount(node), { trim: false });   // 同步：保证口够（只增不删）
  const m = masterRule(node);
  const st = state(node);
  const n = st.cards.length;
  const saveCard = (i, patch) => {
    const s2 = state(node);
    if (!s2.cards[i]) return;
    Object.assign(s2.cards[i], patch);
    setState(node, s2);
  };

  // ---- 顶部**总控制**：模式（循环）在前 → 输出形态在后 → 值 → 新增切分卡片（永远一行）----
  tb.innerHTML = '';
  const mSel = modeSelect(m.mode, (v) => { setWidget(node, "mode", v); node._ezsvRender && node._ezsvRender(); });
  tb.appendChild(mSel);
  // ★ 输出形态（frames / video / gif）：顶部这条 = 总控制（卡片「总」亮着时用它）；每张卡也有自己的一个
  const oSel = outSelect(m.outType, (v) => { setWidget(node, "out_type", v); node._ezsvRender && node._ezsvRender(); });
  tb.appendChild(oSel);
  const mA = numInput(m.oneStart, '0.1', (v) => setWidget(node, "one_start", v));
  const mB = numInput(m.oneEnd, '0.1', (v) => setWidget(node, "one_end", v));
  const l1 = el('span', 'ezsv-lbl'); l1.textContent = ezT("Start"); tb.appendChild(l1);
  tb.appendChild(mA);
  const l2 = el('span', 'ezsv-lbl'); l2.textContent = ezT("End"); tb.appendChild(l2);
  tb.appendChild(mB);
  const mFA = numInput(m.startFrame, '1', (v) => setWidget(node, "start_frame", v));
  const mFB = numInput(m.endFrame, '1', (v) => setWidget(node, "end_frame", v));
  const lf1 = el('span', 'ezsv-lbl'); lf1.textContent = ezT("Start frame");
  const lf2 = el('span', 'ezsv-lbl'); lf2.textContent = ezT("End frame");
  tb.appendChild(lf1); tb.appendChild(mFA); tb.appendChild(lf2); tb.appendChild(mFB);
  const mSyncVal = () => {
    const one = mSel.value === 'one', frames = mSel.value === 'frames';
    [l1, mA, l2, mB].forEach((x) => { x.disabled = !one; x.style.display = one ? '' : 'none'; });
    [lf1, mFA, lf2, mFB].forEach((x) => { x.disabled = !frames; x.style.display = frames ? '' : 'none'; });
  };
  mSyncVal();
  const addBtn = el('button', 'ezsv-btn pri'); addBtn.type = 'button'; addBtn.textContent = '+ ' + ezT("New card");
  addBtn.title = ezT("Add");
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (n >= MAX) return;
    const s2 = state(node);
    s2.cards.push({});                              // 新卡默认 useMaster=true ⇒ 跟着总控制
    setState(node, s2);
    node._ezsvRender && node._ezsvRender();
  });
  tb.appendChild(addBtn);

  // ---- 第一行 ⚙：帧上限 / 抽帧放在设置弹窗里（只对 frames / GIF 生效）----
  const setBtn = el('button', 'ezsv-btn');
  setBtn.type = 'button'; setBtn.textContent = ezT('Settings');
  setBtn.title = ezT('Max frames') + ' / ' + ezT('Every N');
  setBtn.addEventListener('click', (e) => { e.stopPropagation(); openSettings(node); });
  tb.appendChild(setBtn);

  node._ezsvSync = () => {
    const mm = masterRule(node);
    if (mSel.value !== mm.mode) mSel.value = mm.mode;
    const ot = outTypeOf(node);
    if (oSel.value !== ot) oSel.value = ot;
    if (document.activeElement !== mA) mA.value = String(mm.oneStart);
    if (document.activeElement !== mB) mB.value = String(mm.oneEnd);
    if (document.activeElement !== mFA) mFA.value = String(mm.startFrame);
    if (document.activeElement !== mFB) mFB.value = String(mm.endFrame);
    mSyncVal();
  };

  // ---- 卡片列表：一张卡 = 一个 video_N 输入口 + 一个 Segment N 输出口 ----
  list.innerHTML = '';
  if (!n) {
    const h = el('div', 'ezsv-hint'); h.textContent = ezT("New card"); list.appendChild(h);
    return;
  }
  st.cards.forEach((c, i) => {
    const card = el('div', 'ezsv-card'); card.dataset.idx = String(i);
    const no = el('span', 'ezsv-index'); no.textContent = String(i + 1); card.appendChild(no);
    const hd = el('span', 'ezsv-handle'); hd.textContent = '⠿'; hd.title = ezT("Drag to reorder"); card.appendChild(hd);

    const useM = !!c.useMaster;
    const shown = useM ? m : c;                     // 「总」亮着 ⇒ 显示总控的值
    const sel = modeSelect(shown.mode, (v) => { saveCard(i, { mode: v }); node._ezsvRender && node._ezsvRender(); });
    sel.disabled = useM;
    card.appendChild(sel);
    // ★ 输出形态也上卡片（与顶部那条同款；「总」亮着时变灰、显示总控的值）
    const oIn = outSelect(shown.outType, (v) => { saveCard(i, { outType: v }); node._ezsvRender && node._ezsvRender(); });
    oIn.disabled = useM;
    card.appendChild(oIn);
    const aIn = numInput(shown.oneStart, '0.1', (v) => saveCard(i, { oneStart: v }));
    const bIn = numInput(shown.oneEnd, '0.1', (v) => saveCard(i, { oneEnd: v }));
    const la = el('span', 'ezsv-lbl'); la.textContent = ezT("Start");
    const lb = el('span', 'ezsv-lbl'); lb.textContent = ezT("End");
    const fA = numInput(shown.startFrame, '1', (v) => saveCard(i, { startFrame: v }));
    const fB = numInput(shown.endFrame, '1', (v) => saveCard(i, { endFrame: v }));
    const lfa = el('span', 'ezsv-lbl'); lfa.textContent = ezT("Start frame");
    const lfb = el('span', 'ezsv-lbl'); lfb.textContent = ezT("End frame");
    const timeBox = el('div', 'ezsv-time');
    [la, aIn, lb, bIn, lfa, fA, lfb, fB].forEach((x) => timeBox.appendChild(x));
    card.appendChild(timeBox);
    const syncVal = () => {
      const one = shown.mode === 'one', frames = shown.mode === 'frames';
      timeBox.style.display = '';                       // 保留占位：loop 模式也不让总/✕ 左移
      timeBox.style.visibility = (one || frames) ? 'visible' : 'hidden';
      [la, aIn, lb, bIn].forEach((x) => { x.style.display = one ? '' : 'none'; });
      [lfa, fA, lfb, fB].forEach((x) => { x.style.display = frames ? '' : 'none'; });
      aIn.disabled = useM; bIn.disabled = useM; fA.disabled = useM; fB.disabled = useM;
    };
    syncVal();

    // ★ 「总」按钮（在 ✕ 前面）：亮/绿 = 跟随上面的总控制；点一下切换（样式同 prompt_helper 权重按钮）
    const mBtn = el('button', 'ezsv-mbtn' + (useM ? ' on' : ''));
    mBtn.type = 'button'; mBtn.textContent = '总'; mBtn.title = ezT("Use master control");
    mBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      saveCard(i, { useMaster: !useM });
      node._ezsvRender && node._ezsvRender();
    });
    card.appendChild(mBtn);

    const x = el('button', 'ezsv-x'); x.type = 'button'; x.textContent = '✕'; x.title = ezT("Remove");
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      const s2 = state(node);
      const before = s2.cards.slice();
      if (!before.length) return;                    // 已经空了
      const arr = before.slice();
      arr.splice(i, 1);
      // 先删掉这张卡自己的口（removeInput/removeOutput 会断开它的线，并把后面的口前移）；
      // 再按当前位置把剩下 socket 上的 link 下标正回去，避免删中间卡后第 3 张接到第 2 张的源。
      try { node.removeInput(i + 1); } catch (_) {}
      ezDropOutput(node, i + 1);
      permutePorts(node, arr.map((_, j) => j));       // 口已前移 ⇒ 新位置 j 对应旧位置 j
      node._ezsvCards = arr.slice();                 // 先落内存，config 写入失败时也不会回弹
      setState(node, { cards: arr });
      ensureSockets(node, arr.length, { force: true });   // ★ 用户明确删卡：连着的线一起收
      node._ezsvRender && node._ezsvRender();
    });
    card.appendChild(x);
    list.appendChild(card);
  });
  scheduleTrim(node);   // 真正的裁口延到 configure 之后（见 scheduleTrim 注释）
  // ★ 拖拽手柄是每次 render 新建的（530 行先清空 list），而 attachDnD 只给「当时存在的」手柄挂
  //   pointerdown ⇒ 一旦重画过（加/删卡、改任何开关），新建的手柄再也不能拖。
  //   每次重画都补挂一次（attachDnD 内部用手柄上的 _ezDnD 去重）。
  try { if (node._ezsvBindDnD) node._ezsvBindDnD(); } catch (_) {}
}

function mount(node) {
  if (!node || node._ezsvSetup) return;
  node._ezsvSetup = true;
  inject();
  const shell = el('div', 'ezsv-shell');
  const root = el('div', 'ezsv-root');
  const tb = el('div', 'ezsv-tb');
  const list = el('div', 'ezsv-list');
  root.appendChild(tb); root.appendChild(list);
  shell.appendChild(root);
  node._ezsvRoot = shell;
  const rerender = () => { render(node, tb, list); paintPorts(node); };
  node._ezsvRender = rerender;
  rerender();

  const widget = node.addDOMWidget("SplitVideo", "ezsv__" + Math.random().toString(36).slice(2), shell, {
    serialize: false, hideOnZoom: false, canvasOnly: !(window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()),
    margin: 4, getMinHeight: () => 60, getValue: () => "{}", setValue: () => {},
  });
  makeDomWidgetHitThrough(widget.element || shell);
  try { node.widgets_start_y = 0; } catch (_) {}
  try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
  installResizeHandles(node, shell);
  // ★ 用**用户自己拖出来的尺寸**：只在没有尺寸/明显是默认值时回落到初始尺寸。
  //   以前这里无条件 setSize(..., MIN_H) ⇒ 每次重载/重挂都把高度打回默认，用户拖的高度白调。
  try { ezApplyDefaultSize(node, MIN_W, Math.max(MIN_H, 190)); } catch (_) {}   // 默认给一行卡片的高度（60 太矮，只剩标题条）
  node._ezsvBindDnD = () => attachDnD(list, '.ezsv-card', '.ezsv-handle', (from, to) => {
    const s2 = state(node);
    const arr = s2.cards.slice();
    const [mv] = arr.splice(from, 1);
    arr.splice(to, 0, mv);
    const perm = arr.map((c) => s2.cards.indexOf(c));      // perm[新位置] = 旧位置
    permutePorts(node, perm);
    setState(node, { cards: arr });
    rerender();
  });
  node._ezsvBindDnD();
  hideWidgets(node);
  forceShell(node);
  // ★ 自愈：宿主 widget 可能被重建（切图 / 折叠 / 切 tab）⇒ 重挂 + 短时主动轮询（到期自停）
  let retry = 0;
  (function again() {
    forceShell(node);
    try { hideWidgets(node); ensureSockets(node, cardCount(node), { trim: false }); node._ezsvSync && node._ezsvSync(); } catch (_) {}
    try { scheduleTrim(node); } catch (_) {}
    if (retry < 10) { retry += 1; setTimeout(again, 120); }
  })();
}

function hook(nt) {
  if (!nt || nt.__ezsvHooked) return;
  nt.__ezsvHooked = true;
  const pc = nt.prototype.onNodeCreated;
  nt.prototype.onNodeCreated = function () {
    const r = pc ? pc.apply(this, arguments) : undefined;
    try { mount(this); } catch (_) {}
    return r;
  };
  // ⚠️ configure **不重新挂载**（再 addDOMWidget 会多出一份面板），只重藏/裁口/重画
  // 旧版错位存档可能把 one_start/one_end 写成 'loop'、config 写成 '5'、out_type 写成 '960'：先拉回合法值。
  function sanitize(node) {
    const get = (n) => (node.widgets || []).find((w) => w && w.name === n);
    ["one_start", "one_end"].forEach((k) => { const w = get(k); if (w && !isFinite(Number(w.value))) w.value = 0; });
    const cw = get("config");
    if (cw) {
      try {
        const v = JSON.parse(cw.value || "{}");
        if (!v || typeof v !== "object" || Array.isArray(v)) cw.value = "{}";
      } catch (_) { cw.value = "{}"; }
    }
    const ow = get("out_type");
    if (ow && OUT_TYPES.every(([v]) => v !== String(ow.value))) ow.value = "frames";
    const ev = get("select_every_nth");
    if (ev) { const n0 = parseInt(ev.value, 10); ev.value = isFinite(n0) && n0 >= 0 ? n0 : 0; }
    const mf = get("max_frames");
    if (mf) { const n1 = parseInt(mf.value, 10); mf.value = isFinite(n1) && n1 >= 0 ? n1 : 960; }
  }
  const pm = nt.prototype.onConfigure;
  nt.prototype.onConfigure = function () { this.__ezSizeRestored = true;
    const r = pm ? pm.apply(this, arguments) : undefined;
  try { ezRestoreSavedSize(this, arguments[0]); } catch (_) {}
    try { sanitize(this); } catch (_) {}
    try {
      if (!this._ezsvSetup) mount(this);
      hideWidgets(this);
      // ★ 只走 _ezsvRender：它内部是「只增不删 + 延后裁口」⇒ 不会把 configure 刚恢复的连线槽抽掉
      this._ezsvRender && this._ezsvRender();
    } catch (_) {}
    return r;
  };
  const pcc = nt.prototype.onConnectionsChange;
  nt.prototype.onConnectionsChange = function () {
    const r = pcc ? pcc.apply(this, arguments) : undefined;
    try { this._ezsvRender && this._ezsvRender(); } catch (_) {}
    return r;
  };
  const pr = nt.prototype.onRemoved;
  nt.prototype.onRemoved = function () {
    const r = pr ? pr.apply(this, arguments) : undefined;
    try { if (this._ezsvRoot) this._ezsvRoot.remove(); } catch (_) {}
    try { if (this._ezsvTrimT) { clearTimeout(this._ezsvTrimT); this._ezsvTrimT = 0; } } catch (_) {}
    this._ezsvSetup = false;
    return r;
  };
}

onLocaleChange(() => {
  try {
    const g = (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
    ((g && g._nodes) || []).forEach((n) => {
      if (nodeTypeOf(n) !== SV) return;
      try { n._ezsvRender && n._ezsvRender(); } catch (_) {}
    });
  } catch (_) {}
});

app.registerExtension({
  name: "EzFlex.SplitVideo",
  async beforeRegisterNodeDef(nt, nd) {
    if (nd && nd.name === SV) hook(nt);
  },
  nodeCreated(n) {
    if (nodeTypeOf(n) !== SV) return;
    try { mount(n); } catch (_) {}
  },
});
