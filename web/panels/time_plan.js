// 面板：TimePlan 面板：参数栏 + 自定义分段弹窗，值直写 config
// EzFlex-TimePlan：规划节点（吃 index -> 算第 i 段帧数 + timeplan）。
// ★ 面板 = 参数栏，**与 TimeLine 同款**（类名/声明照抄 `.eztl-*`；悬停信息复用 `tlInfoTip`/`tlPlan`/`tlBindTip`）。
// ★ 布局：**三列网格**，每列「标签 + 输入框」左对齐、输入框上下对齐，
//   列间距放宽；预设 / 对齐两格不写标签。参数 + 规划库按钮正好 5 行 × 3 列。
// ★ 只保留 `index` 一个输入口：model/total/… 这些是 **widget 输入**，在 Nodes 2.0 里会被画成原生 socket
//   （全部挤在第一个口上重叠）⇒ 跟 TimeLine 的 stripTlSockets 一样直接从 node.inputs 里摘掉。
// ★ 参数 widget 全部藏起来（值仍走 widgets_values 序列化）；读写一律**按名字现取 widget**，
//   不做闭包捕获 —— 否则 configure 重建 widget 后面板就写到一个已经脱离的旧对象上（「值和原来不一样」）。
// ★ 下拉一律**保证选中**：选项表里没有当前值就把当前值补进去并选中（「默认给我选上」）。
import { app } from "../../../scripts/app.js";
import { ezApplyDefaultSize,
  NODE_TYPES, nodeTypeOf, installResizeHandles, makeDomWidgetHitThrough,
  installEdgeLabels, hideNativeSlotText, readConfig, writeConfig, configWidget,
  ezCaptureSocketLinks, ezApplySocketLinks, uiPrompt, uiConfirm,
} from "../core/ezflex_service.js";
import { ezT, onLocaleChange } from "../core/ezflex_i18n.js";
// ★ 与 TimeLine 共用同一套模型表 / 规划算法 / 悬停气泡（同模块 = 同外观，改一处两边一起变）。
//   `tlNotifyPlanDownstream` = 顺 `timeplan` 出口**递归**通知下游重画（可能隔着 EzFlex-SplitVideo
//   这种透传节点）⇒ 改这里的参数，下游 TimeLine 的时间轴**立刻**跟着变。
import { TL_MODELS, tlPlan, tlInfoTip, tlNotifyPlanDownstream, tlNum } from "../core/loop_nodes.js";

const TP = NODE_TYPES.TIME_PLAN;
const MIN_W = 400;
// 面板自己画的参数（原生 widget 全部藏起来，避免画两遍）
const HIDDEN = ["model", "total", "segment", "fps", "overlap", "tolerance", "trim_tail", "audio_context_length", "grid_b", "grid_s", "max_frames", "align", "config"];

// 这些声明是从 loop_nodes.js 的 TimeLine 工具条**原样抄来的**（类名也一致）：
// 这样即使 loop_nodes.js 的样式还没注入，TimePlan 也长得跟 TimeLine 一模一样。
const CSS = `
.eztl-lbl{font-size:11px;color:var(--ez-fg-3);white-space:nowrap;flex:0 0 auto;}
.eztl-num,.eztl-sel{height:26px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);
  color:var(--ez-fg);font-family:inherit;font-size:12px;padding:0 6px;outline:none;box-sizing:border-box;min-width:0;width:100%;}
.eztl-sel{cursor:pointer;}
.eztl-num{text-align:center;-moz-appearance:textfield;appearance:textfield;}
.eztl-num::-webkit-outer-spin-button,.eztl-num::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.eztl-num:focus,.eztl-sel:focus{border-color:var(--ez-strong);}
.eztl-fld-tip{cursor:help;}
.eztp-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.eztp-shell .eztp-root{pointer-events:auto;}
.eztp-root{container-type:inline-size;position:absolute;inset:0 14px 14px 14px;font-family:inherit;color:var(--ez-fg);background:var(--ez-bg);
  border-radius:12px;padding:9px 11px 11px;display:flex;flex-direction:column;gap:7px;box-sizing:border-box;
  min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;justify-content:flex-start;}
/* ★ 三列参数网格：列宽等分、列间距清晰；每列都是「标签(定宽) + 输入框」，
   标签从同一左边界开始 ⇒ 一整列的输入框左右边界都对齐。model / align 不写标签，但仍占同宽标签位，
   这样它们的下拉框也跟下面几行的输入框对齐。 */
.eztp-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));column-gap:8px;row-gap:8px;
  width:100%;min-width:0;align-items:center;}
.eztp-fld{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:center;gap:6px;min-width:0;width:100%;box-sizing:border-box;}
.eztp-fld .eztl-lbl{min-width:0;white-space:nowrap;}
.eztp-fld .eztl-num,.eztp-fld .eztl-sel{width:100%;min-width:0;max-width:none;box-sizing:border-box;}
.eztp-fld .eztl-num{text-align:center;}
.eztp-fld .eztl-sel{text-align:left;}
.eztp-grid3 .eztp-pbtn,.eztp-grid3 .eztp-custom{width:100%;min-width:0;justify-content:center;}
.eztp-modal{position:fixed;inset:0;z-index:100300;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;}
.eztp-mbox{width:min(620px,94vw);max-height:84vh;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);display:flex;flex-direction:column;padding:12px 14px;box-sizing:border-box;}
.eztp-mhd{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid var(--ez-border-2);padding-bottom:8px;margin-bottom:8px;}
.eztp-mtitle{font-size:13px;font-weight:600;color:var(--ez-fg);}
.eztp-mclose{width:26px;height:26px;line-height:1;border:1px solid var(--ez-border);border-radius:7px;background:var(--ez-surface-2);color:var(--ez-fg);cursor:pointer;font:inherit;font-size:15px;padding:0;}
.eztp-mclose:hover{background:var(--ez-surface-3);}
.eztp-mbody{display:flex;flex-direction:column;gap:6px;min-height:0;overflow:auto;}
.eztp-dh,.eztp-dr{display:grid;grid-template-columns:34px minmax(90px,1fr) minmax(90px,1fr) 68px 26px;align-items:center;gap:8px;font-size:10px;color:var(--ez-fg-3);}
.eztp-dh{padding:0 2px;font-weight:600;text-align:center;}
.eztp-dr{padding:3px 2px;min-height:40px;text-align:center;border-bottom:1px solid var(--ez-border-2);background:var(--ez-bg);}
.eztp-dr:nth-child(even){background:var(--ez-surface);}
.eztp-dr input{height:28px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font:inherit;font-size:12px;padding:0 6px;min-width:0;box-sizing:border-box;text-align:center;appearance:textfield;-moz-appearance:textfield;}
.eztp-dr input::-webkit-outer-spin-button,.eztp-dr input::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.eztp-msum{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11px;color:var(--ez-fg-2);border:1px solid var(--ez-border-2);border-radius:7px;padding:7px 9px;background:var(--ez-surface);margin-bottom:6px;}
.eztp-msum b{color:var(--ez-fg);font-weight:600;}
.eztp-drows{display:flex;flex-direction:column;min-height:0;overflow:auto;}
.eztp-pbtn{height:26px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font:inherit;font-size:11px;padding:0 8px;cursor:pointer;white-space:nowrap;flex:0 0 auto;}
.eztp-pbtn:hover{background:var(--ez-surface-3);}
.eztp-custom{height:26px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg-3);font:inherit;font-size:11px;padding:0 8px;cursor:pointer;white-space:nowrap;flex:0 0 auto;pointer-events:auto;position:relative;z-index:2;}
.eztp-custom.on{background:#2ea043;border-color:#2ea043;color:#fff;font-weight:600;}
.eztp-dr .auto{color:var(--ez-fg-muted);text-align:center;font-variant-numeric:tabular-nums;}
.eztp-dr .act{color:var(--ez-fg);text-align:center;font-variant-numeric:tabular-nums;}
.eztp-dx{border:none;background:transparent;color:var(--ez-fg-muted);cursor:pointer;font-size:13px;line-height:1;padding:0;}
.eztp-dx:hover{color:var(--ez-bad-fg);}
.eztp-dbtns{display:flex;gap:6px;justify-content:flex-end;align-items:center;padding:6px 0 2px;position:sticky;bottom:0;background:var(--ez-bg);}
.eztp-dadd{margin-right:auto;}
.eztp-warn{font-size:10px;color:var(--ez-bad-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.eztp-dbtn{height:26px;border:1px solid var(--ez-border);border-radius:5px;background:var(--ez-surface-2);color:var(--ez-fg);font:inherit;font-size:11px;padding:0 10px;cursor:pointer;pointer-events:auto;}
.eztp-dbtn:hover{background:var(--ez-surface-3);}
.eztp-tip{position:fixed;z-index:100000;display:none;max-width:360px;padding:7px 10px;background:#fff;color:#1b1f24;
  border:1px solid #c9d1d9;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.18);font-size:11px;line-height:1.55;
  white-space:pre-line;pointer-events:none;}
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
// TimePlan 专用白板提示：不跟随系统深色 title（Windows 深色下原生 title 就是黑底白字）。
let _eztpTip = null;
function whiteTip() {
  if (!_eztpTip) { _eztpTip = el("div", "eztp-tip"); document.body.appendChild(_eztpTip); }
  return _eztpTip;
}
function bindWhiteTip(target, getText) {
  const move = (e) => {
    const t = whiteTip();
    const text = String(getText() || "");
    if (!text) { t.style.display = "none"; return; }
    t.textContent = text;
    t.style.display = "block";
    const pad = 10;
    let x = (e && e.clientX ? e.clientX : target.getBoundingClientRect().left) + 12;
    let y = (e && e.clientY ? e.clientY : target.getBoundingClientRect().top) + 16;
    const r = t.getBoundingClientRect();
    if (x + r.width + pad > window.innerWidth) x = window.innerWidth - r.width - pad;
    if (y + r.height + pad > window.innerHeight) y = y - r.height - 28;
    t.style.left = Math.max(pad, x) + "px";
    t.style.top = Math.max(pad, y) + "px";
  };
  const hide = () => { try { whiteTip().style.display = "none"; } catch (_) {} };
  target.addEventListener("mouseenter", move);
  target.addEventListener("mousemove", move);
  target.addEventListener("mouseleave", hide);
}
// ★ 一律按名字现取 widget（不做闭包捕获）：configure 重建 widget 后依然写到「当前那个」上
function widgetOf(node, name) { return ((node && node.widgets) || []).find((w) => w && w.name === name) || null; }
// widget 的候选值（COMBO 在 options.values；兼容 options 直接是数组 / 对象）
function optValues(w) {
  const v = w && w.options && (w.options.values || w.options);
  if (Array.isArray(v)) return v.map(String);
  if (v && typeof v === "object") return Object.keys(v);
  return [];
}

function hideWidget(w) {
  try {
    w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0; w.draw = () => {};
    w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
    if (w.element && w.element.style) { w.element.style.display = "none"; w.element.style.height = "0"; }
  } catch (_) {}
}
function hideParams(node) { HIDDEN.forEach((n) => { const w = widgetOf(node, n); if (w) hideWidget(w); }); }

// ★ 只留 index 一个输入口：其余都是 widget 输入，摘掉后就不会有一堆 socket 挤在第一个口上重叠。
//   （同 loop_nodes.js 的 stripTlSockets，只是这里固定口只有一个 index。）
function stripParamSockets(node) {
  const ins = node.inputs || [];
  for (let i = ins.length - 1; i >= 0; i--) {
    const s = ins[i];
    if (!s) continue;
    if (s.name === "index") { try { delete s.widget; } catch (_) {} continue; }   // 唯一的真输入口
    try { node.removeInput(i); } catch (_) { try { ins.splice(i, 1); } catch (_2) {} }
  }
}

function forceShell(node) {
  const p = node && node._eztpRoot;
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

function setWidget(node, name, val) {
  const w = widgetOf(node, name);
  if (!w) return;
  try { w.value = val; if (typeof w.callback === "function") w.callback(val, app.canvas, node, [0, 0], null); } catch (_) {}
  // 和隐藏 widget 双写：老工作流/隐藏 widget 被裁掉时，刷新/重启仍能从 properties 回填。
  try {
    node.properties = node.properties || {};
    node.properties.ezTp = node.properties.ezTp || {};
    node.properties.ezTp[name] = val;
  } catch (_) {}
  try { if (node.graph) node.graph.setDirtyCanvas(true, true); } catch (_) {}
}

// 一格参数：结构 / 类名 / 事件口径 / 悬停信息 都跟 TimeLine 的 field() 一致
// ★ 宽度一律交给 CSS（.eztp-grid3 三列等分 + 定宽标签）⇒ 三列输入框左右边界天然对齐；
//   标签为空（model / align）时仍留同宽空标签位，保证它们的下拉框和下面几行的输入框对得上。
function field(node, row, label, name, kind, tipKey) {
  const w0 = widgetOf(node, name);
  if (!w0) return null;                              // 老工作流缺这个 widget 就跳过，不硬造
  const g = el("div", "eztp-fld");
  // 预设 / 对齐两格不写标签：直接把控件铺满整格（连标签位都不留）
  if (label) {
    const l = el("span", "eztl-lbl"); l.textContent = label;
    // ★ 标签定宽 + 输入框吃满剩余宽度全部走 inline：面板里被别的样式表压过宽度时也不缩成小方块。
    // 不给 max-width：百分比在这里是循环依赖（网格轨道由内容撑），会把标签压成「总…」
    l.style.overflow = "hidden"; l.style.textOverflow = "ellipsis";
    l.title = label;
    g.appendChild(l);
  }
  let ctl;
  if (kind === "select") {
    let list = optValues(w0).map((v) => [v, (name === "model" ? ((TL_MODELS[v] && TL_MODELS[v].name) || v) : v)]);
    if (!list.length && name === "model") list = Object.keys(TL_MODELS).map((k) => [k, (TL_MODELS[k] && TL_MODELS[k].name) || k]);
    if (name === "align") list = [["align", ezT("Align total")], ["strict", ezT("Strict segment")]];
    const cur = String(w0.value == null ? "" : w0.value);
    // ★ 保证选中：选项表里没有当前值就补进去（否则下拉会显示空白）
    if (cur && !list.some(([v]) => String(v) === cur)) list = [[cur, cur]].concat(list);
    ctl = el("select", "eztl-sel");
    list.forEach(([v, t]) => { const o = el("option"); o.value = String(v); o.textContent = String(t); if (cur === String(v)) o.selected = true; ctl.appendChild(o); });
    ctl.addEventListener("change", () => {
      if (name === "model" && String(ctl.value).startsWith("plan:")) return;   // 自定义规划项由 build 里的专门监听处理
      setWidget(node, name, ctl.value);
      // 切模型：fps 回预设；overlap 按新模型网格向下吸附，输入框跟着显示对齐后的值。
      if (name === "model") {
        const m = TL_MODELS[ctl.value];
        if (m) {
          try {
            const put = (k, v) => {
              const w = widgetOf(node, k);
              if (!w) return;
              w.value = v;
              node.properties = node.properties || {};
              node.properties.ezTp = node.properties.ezTp || {};
              node.properties.ezTp[k] = v;
            };
            put("fps", m.fps);
            put("grid_b", m.B);
            put("grid_s", m.S);
            put("max_frames", m.maxF);
            const ow = widgetOf(node, "overlap");
            const raw = ow ? parseInt(ow.value, 10) : NaN;
            if (ow && isFinite(raw) && raw > 0) {
              const B = m.B, S = m.S;
              const snapped = raw <= B ? B : B + S * Math.floor((raw - B) / S);
              put("overlap", snapped);
            }
          } catch (_) {}
        }
      }
      changed(node);
    });
  } else {
    ctl = el("input", "eztl-num"); ctl.type = "number";
    const o = w0.options || {};
    ctl.step = (o.step !== undefined && o.step !== null) ? String(o.step) : "1";
    // 原生 widget 被 HIDDEN 隐藏后 min/max 只存在于 options 里：自绘框必须自己带上，
    // 否则能填出后端不接受的 0 / 负数（2026-11 复检 H-13）。
    if (o.min !== undefined && o.min !== null) ctl.min = String(o.min);
    if (o.max !== undefined && o.max !== null) ctl.max = String(o.max);
    ctl.value = String(w0.value == null ? "" : w0.value);
    const commit = () => {
      let v = parseFloat(ctl.value);
      if (!isNaN(v)) {
        const lo = (o.min !== undefined && o.min !== null) ? parseFloat(o.min) : NaN;
        const hi = (o.max !== undefined && o.max !== null) ? parseFloat(o.max) : NaN;
        if (isFinite(lo) && v < lo) v = lo;
        if (isFinite(hi) && v > hi) v = hi;
        // overlap 是钉帧/头重叠，必须落在 H3 的 5+17k 网格：优先向下取，没有下界就取上界。
        // tolerance 是生成后的额外头裁，不是网格参数，保持用户输入。
        if (name === "overlap") {
          const mw = widgetOf(node, "model");
          const m = TL_MODELS[String(mw && mw.value)] || TL_MODELS.minimax_h3;
          const B = m.B, S = m.S;
          v = v <= 0 ? 0 : (v <= B ? B : B + S * Math.floor((v - B) / S));
        }
        ctl.value = String(v);      // 夹取/吸附后的值回写输入框
        setWidget(node, name, v);
      }
      changed(node);
    };
    ctl.addEventListener("change", commit);
    ctl.addEventListener("blur", commit);   // 失焦也保存（不依赖浏览器补发 change）
  }
  // 输入框/下拉吃掉整格剩余宽度（inline，避免被别的 `.eztl-*` 宽度压回小方块）
  try {
    ctl.style.width = "100%";
    ctl.style.minWidth = "0";
    ctl.style.gridColumn = label ? "2" : "1 / -1";
  } catch (_) {}
  g.appendChild(ctl);
  // ★ 重叠/裁头：不要黑悬停，改成浏览器原生白悬停（title）。
  //   如果输入值被网格吸附（和“选的对齐”不一样），在 title 里额外写“输入 X → 对齐到 Y”。
  const plainTip = (html) => String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  if (tipKey === 'overlap') {
    bindWhiteTip(g, () => {
      let t = plainTip(tlInfoTip('overlap', tlPlan(node)));
      const w = widgetOf(node, 'overlap');
      const raw = w ? parseInt(w.value, 10) : NaN;
      const ov = tlPlan(node).ovF;
      if (isFinite(raw) && isFinite(ov) && raw !== ov) t = '输入 ' + raw + ' 帧 → 对齐到 ' + ov + ' 帧\n' + t;
      return t;
    });
  } else if (tipKey) {
    bindWhiteTip(g, () => plainTip(tlInfoTip(tipKey, tlPlan(node))));
  }
  row.appendChild(g);
  return { name: name, ctl: ctl, kind: kind };
}

// 面板 → 控件回填（configure 之后 widget 值才恢复，所以每次都要重填）
function fill(node) {
  ((node && node._eztpCtl) || []).forEach((it) => {
    const w = widgetOf(node, it.name);
    if (!w) return;
    try {
      if (it.kind === "select") {
        let cur = String(w.value == null ? "" : w.value);
        // 选中的是自定义 plan 时，model widget 里仍是内置模型名：直接回填会把下拉打回内置，
        // 之后一旦触发 change 就会 applyBuiltin → 删掉 segOverride/segCount（自定义 plan 丢失）。
        if (it.name === "model") {
          const c0 = readConfig(node) || {};
          const ap = String(c0.activePlan || "");
          if (ap && (Array.isArray(c0.plans) ? c0.plans : []).some((x) => x && String(x.name) === ap)) cur = "plan:" + ap;
        }
        if (cur && it.ctl.value !== cur) {
          if (!Array.prototype.some.call(it.ctl.options, (o) => o.value === cur)) {
            const o = el("option"); o.value = cur; o.textContent = cur; it.ctl.appendChild(o);
          }
          it.ctl.value = cur;
        }
      } else if (document.activeElement !== it.ctl) {
        it.ctl.value = (w.value == null ? "" : String(w.value));
      }
    } catch (_) {}
  });
}

function build(node, root) {
  root.innerHTML = "";
  root.style.alignItems = "stretch";
  const ctls = [];
  const grid = el("div", "eztp-grid3");
  const addField = (label, name, kind, tip) => {
    const it = field(node, grid, label, name, kind, tip);
    if (it) ctls.push(it);
    return it;
  };

  const saveBtn = el("button", "eztp-pbtn"); saveBtn.type = "button"; saveBtn.textContent = ezT("Save");
  const delBtn = el("button", "eztp-pbtn"); delBtn.type = "button"; delBtn.textContent = ezT("Delete");
  const customBtn = el("button", "eztp-custom");
  customBtn.type = "button"; customBtn.textContent = ezT("Custom");
  customBtn.title = ezT("Click to toggle custom planning; right-click to edit durations");

  // ★ 三列网格：前两行是下拉/按钮（预设、保存、删除 / 对齐、自定义、最大帧），
  //   下面三行是参数。预设 / 对齐两格不写标签，控件直接铺满整格。
  addField("", "model", "select", "model");
  grid.appendChild(saveBtn); grid.appendChild(delBtn);
  addField("", "align", "select", null);
  grid.appendChild(customBtn);
  addField("Max", "max_frames", "number", null);
  addField(ezT("Total s"), "total", "number", "total");
  addField(ezT("Segment s"), "segment", "number", "seg");
  addField("FPS", "fps", "number", "fps");
  addField(ezT("Overlap"), "overlap", "number", "overlap");
  addField(ezT("Head tolerance"), "tolerance", "number", "overlap");
  addField(ezT("Tail trim"), "trim_tail", "number", null);
  addField(ezT("Transition audio"), "audio_context_length", "number", null);
  addField("B", "grid_b", "number", null);
  addField("S", "grid_s", "number", null);

  // ★ 视频上下文 ↔ 过渡音频 联动（只在你手动改其中一格时触发，加载工作流不改值）：
  //   · 视频 → 音频：音频取「≥ 视频且能被 3 整除」的帧数，保证 audio_tick = 音频帧 × 5/3 是整数
  //     （官方示例 22↔24 就是这么来的：22 不在音频格上，补到 24 = 40 tick）。
  //   · 音频 → 视频：视频上下文必须落在模型网格 5+17k 上，取离音频值最近的那个（24→22、39→39、57→56）。
  const _ovCtl = (ctls.find((it) => it.name === "overlap") || {}).ctl;
  const _acCtl = (ctls.find((it) => it.name === "audio_context_length") || {}).ctl;
  const _syncAudioFromVideo = () => {
    const w = widgetOf(node, "overlap");
    const v = Math.max(0, parseInt(w && w.value, 10) || 0);
    if (!v) return;
    const a = Math.ceil(v / 3) * 3;
    setWidget(node, "audio_context_length", a);
    if (_acCtl) _acCtl.value = String(a);
  };
  const _syncVideoFromAudio = () => {
    const w = widgetOf(node, "audio_context_length");
    const a = Math.max(0, parseInt(w && w.value, 10) || 0);
    if (!a) return;
    const B = parseInt((widgetOf(node, "grid_b") || {}).value, 10) || 5;
    const S = parseInt((widgetOf(node, "grid_s") || {}).value, 10) || 17;
    let best = B;
    for (let f = B; f <= B + S * 16; f += S) {
      if (Math.abs(f - a) < Math.abs(best - a)) best = f;
    }
    setWidget(node, "overlap", best);
    if (_ovCtl) _ovCtl.value = String(best);
  };
  if (_ovCtl) _ovCtl.addEventListener("change", _syncAudioFromVideo);
  if (_acCtl) _acCtl.addEventListener("change", _syncVideoFromAudio);
  root.appendChild(grid);

  const modelCtl = (ctls.find((it) => it.name === "model") || {}).ctl;
  const PLAN_WIDGETS = ["model", "align", "total", "segment", "fps", "overlap", "tolerance", "trim_tail", "audio_context_length", "grid_b", "grid_s", "max_frames"];
  const snapshot = () => {
    const d = {};
    PLAN_WIDGETS.forEach((k) => { const w = widgetOf(node, k); if (w) d[k] = w.value; });
    const c = readConfig(node) || {};
    d.customOn = !!c.customOn;
    d.segOverride = c.segOverride && typeof c.segOverride === "object" ? Object.assign({}, c.segOverride) : null;
    d.segCount = parseInt(c.segCount, 10) || 0;
    return d;
  };
  const setW = (k, v) => {
    const w = widgetOf(node, k);
    if (!w || v === undefined) return;
    w.value = v;
    try { if (typeof w.callback === "function") w.callback(w.value); } catch (_) {}
    // ★ 和 properties.ezTp 双写：onConfigure 会用它回填，漏写会导致「切换预设后重载又变回旧值」
    try {
      node.properties = node.properties || {};
      node.properties.ezTp = node.properties.ezTp || {};
      node.properties.ezTp[k] = v;
    } catch (_) {}
  };
  const applyPlan = (p) => {
    if (!p || typeof p !== "object") return;
    PLAN_WIDGETS.forEach((k) => setW(k, p[k]));
    const c = readConfig(node) || {};
    c.customOn = !!p.customOn;
    if (p.segOverride && typeof p.segOverride === "object") c.segOverride = Object.assign({}, p.segOverride);
    else delete c.segOverride;
    c.segCount = parseInt(p.segCount, 10) || 0;
    if (!c.segCount) delete c.segCount;
    c.activePlan = String(p.name || "");
    writeCfgHard(node, c);
    try { fill(node); } catch (_) {}
    try { node._eztpCustomOn = !!c.customOn; } catch (_) {}
    try { if (node._eztpSyncCustom) node._eztpSyncCustom(); } catch (_) {}
    try { tlNotifyPlanDownstream(node); } catch (_) {}
  };
  const syncPlans = () => {
    const c = readConfig(node) || {};
    const plans = Array.isArray(c.plans) ? c.plans : [];
    const active = String(c.activePlan || "");
    if (modelCtl) {
      Array.from(modelCtl.options).forEach((o) => { if (o.dataset && o.dataset.plan === "1") o.remove(); });
      plans.forEach((p) => {
        if (!p || typeof p !== "object" || !p.name) return;
        const o = document.createElement("option");
        o.value = "plan:" + String(p.name); o.textContent = String(p.name); o.dataset.plan = "1";
        modelCtl.appendChild(o);
      });
      const hasActive = active && plans.some((p) => p && String(p.name) === active);
      modelCtl.value = hasActive ? "plan:" + active : currentModel();
    }
    const hasActive = active && plans.some((p) => p && String(p.name) === active);
    delBtn.disabled = !hasActive;
    delBtn.style.opacity = hasActive ? "" : ".45";
  };
  const applyBuiltin = (key) => {
    const m = TL_MODELS[key] || TL_MODELS.minimax_h3;
    setW("model", key);
    setW("total", 30);
    setW("segment", 5);
    setW("fps", m.fps);
    setW("overlap", (m.B || 0) + (m.S || 1));
    setW("tolerance", 0);
    setW("trim_tail", 0);
    setW("audio_context_length", 24);
    setW("grid_b", m.B);
    setW("grid_s", m.S);
    setW("max_frames", m.maxF);
    setW("align", "align");
    const c = readConfig(node) || {};
    delete c.segOverride; delete c.segCount;
    c.customOn = false; c.activePlan = key;
    writeCfgHard(node, c);
    try { fill(node); } catch (_) {}
    try { node._eztpCustomOn = false; } catch (_) {}
    try { if (node._eztpSyncCustom) node._eztpSyncCustom(); } catch (_) {}
    try { tlNotifyPlanDownstream(node); } catch (_) {}
  };
  const syncCustom = () => {
    const cfg = readConfig(node) || {};
    if (cfg.customOn !== undefined) node._eztpCustomOn = !!cfg.customOn;
    customBtn.classList.toggle("on", !!node._eztpCustomOn);
  };
  const currentModel = () => String(tlNum(node, "model", "minimax_h3") || "minimax_h3");
  saveBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const cfg = readConfig(node) || {};
    const plans = Array.isArray(cfg.plans) ? cfg.plans.slice() : [];
    const def = ezT("Time plan") + (plans.length + 1);
    uiPrompt(ezT("Plan name"), def).then((name) => {
      const nm = String(name || "").trim();
      if (!nm) return;
      const data = snapshot(); data.name = nm;
      const i = plans.findIndex((p) => p && String(p.name) === nm);
      if (i >= 0) plans[i] = data; else plans.push(data);
      cfg.plans = plans; cfg.activePlan = nm;
      writeCfgHard(node, cfg);
      syncPlans();
    });
  });
  delBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const cfg = readConfig(node) || {};
    const nm = String(cfg.activePlan || "");
    const plans = Array.isArray(cfg.plans) ? cfg.plans : [];
    if (!nm || !plans.some((p) => p && String(p.name) === nm)) return;
    uiConfirm(ezT("Delete this plan?") + " " + nm).then((ok) => {
      if (!ok) return;
      const c2 = readConfig(node) || {};
      c2.plans = (Array.isArray(c2.plans) ? c2.plans : []).filter((p) => p && String(p.name) !== nm);
      if (String(c2.activePlan || "") === nm) delete c2.activePlan;
      writeCfgHard(node, c2);
      syncPlans();
    });
  });
  customBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    node._eztpCustomOn = !node._eztpCustomOn;
    customBtn.classList.toggle("on", !!node._eztpCustomOn);
    const cfg = readConfig(node) || {};
    cfg.customOn = !!node._eztpCustomOn;
    writeCfgHard(node, cfg);
    try { node._eztpUpdate && node._eztpUpdate(); } catch (_) {}
    try { tlNotifyPlanDownstream(node); } catch (_) {}
  });
  customBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    openDurModal(node);
  });
  syncPlans(); syncCustom();
  if (modelCtl) {
    modelCtl.addEventListener("change", () => {
      const val = String(modelCtl.value || "");
      if (val.startsWith("plan:")) {
        const nm = val.slice(5);
        const c = readConfig(node) || {};
        const p = (Array.isArray(c.plans) ? c.plans : []).find((x) => x && String(x.name) === nm);
        if (p) applyPlan(p); else applyBuiltin(String(tlNum(node, "model", "minimax_h3")) || "minimax_h3");
        syncPlans(); syncCustom();
      } else {
        const c = readConfig(node) || {};
        const p = (Array.isArray(c.plans) ? c.plans : []).find((x) => x && String(x.name) === val);
        if (p) applyPlan(p); else applyBuiltin(val);
        syncPlans(); syncCustom();
      }
    });
  }
  node._eztpSyncCustom = syncCustom;
  node._eztpSyncPlans = syncPlans;
  node._eztpCtl = ctls;
}

function sync(node) {
  hideParams(node);
  stripParamSockets(node);
  fill(node);
  dropStalePlan(node);       // 面板规划参数变了 ⇒ 内存态作废
  renderDurs(node);          // 面板参数变了，开着的时长弹窗也要跟着重算
}

// ===== 自定义时长弹窗 =====
// 口径：数值是「净时长秒」，与后端 `_tl_build_override` / TimeLine 拖段完全一致。
// ★★ 草稿模式：
//   · 打开时把 config 的 segOverride / segCount 读进本地 draft；改时长 / 加段 / 删段只改 draft 并立刻重算。
//     **编辑过程中完全不写 config、也不依赖 config 回读** ⇒ 加段一定看得见（旧版每敲一下都整表重建，
//     还指望读 config，所以既丢焦点、又像「点了没反应」）。
//   · 右上角 × = 关闭**不保存**（和「取消」一样丢弃草稿）；点弹窗外 / 右下角「保存」= 保存。
function durOvr(node) {
  const out = {};
  const ovr = (readConfig(node) || {}).segOverride;
  if (ovr && typeof ovr === "object") {
    Object.keys(ovr).forEach((k) => {
      const i = parseInt(k, 10), v = parseFloat(ovr[k]);
      if (i >= 1 && v > 0) out[i] = v;
    });
  }
  return out;
}

// 规划快照：自动段值 / 网格 / fps / 头尾裁剪。tlPlan 出错时退回 widget 默认值，弹窗不会因此失灵。
function durBase(node) {
  let plan = {};
  try { plan = tlPlan(node) || {}; } catch (_) { plan = {}; }
  return {
    segs: plan.segs || [],
    defSec: Math.max(0.1, parseFloat(tlNum(node, "segment", 5)) || 5),
    B: Math.max(0, parseInt(tlNum(node, "grid_b", 5), 10) || 5),
    S: Math.max(1, parseInt(tlNum(node, "grid_s", 17), 10) || 17),
    fps: Math.max(1, parseFloat(plan.fps || tlNum(node, "fps", 24)) || 24),
    oeff: Math.max(0, parseInt(plan.ovF, 10) || 0) + Math.max(0, parseInt(plan.tol, 10) || 0),
    tf: Math.max(0, parseInt(plan.tail, 10) || 0),
  };
}

// 单段实际值（按网格吸附；首段没有头重叠可剪）
function durActual(base, n, i, sec) {
  const want = base.fps * sec + (i === 1 ? 0 : base.oeff);
  const k = Math.max(1, Math.round((want - base.B) / base.S));
  const gen = base.B + base.S * k;
  const tail = i < n ? base.tf : 0;
  const net = i === 1 ? Math.max(1, gen - tail) : Math.max(1, gen - base.oeff - tail);
  return { gen, net };
}

// 从 config 还原一份计划状态：段数 + 每段手动秒数（没手动过的段不进表，仍走自动平摊）
function planFromCfg(node) {
  const cfg = readConfig(node) || {};
  const base = durBase(node);
  const ovr = durOvr(node);
  const active = !!cfg.customOn;
  let n = Math.max(1, base.segs.length, active ? (parseInt(cfg.segCount, 10) || 0) : 0);
  if (active) Object.keys(ovr).forEach((k) => { n = Math.max(n, parseInt(k, 10) || 0); });
  const secs = {};
  if (active) Object.keys(ovr).forEach((k) => {
    const i = parseInt(k, 10);
    if (i >= 1 && i <= n) secs[i] = ovr[i];
  });
  return { count: n, secs };
}

// 打开弹窗：**和 PromptHelper 卡片一样，节点上留一份内存态 `_eztpPlan`**。
//   config 只是镜像（给后端/TimeLine 用）；弹窗读的是内存态 ⇒ 就算渲染层把 config 的文本顶回旧值，
//   关掉再打开也不会「变回原样」。只有重新载入工作流（onConfigure）或面板参数变了才会重建。
function initDraft(node) {
  const cfg = readConfig(node) || {};
  const plan = node._eztpPlan || planFromCfg(node);
  node._eztpDraft = plan;
  node._eztpBaseCfg = JSON.stringify(cfg);   // 「取消」回滚用
  node._eztpPlanSig = planSig(node);         // 面板参数指纹（变了就丢掉内存态，重新按参数算）
}

const PLAN_SIG_WIDGETS = ["model", "total", "segment", "fps", "overlap", "tolerance", "align", "trim_tail", "grid_b", "grid_s", "max_frames"];
function planSig(node) {
  try { return PLAN_SIG_WIDGETS.map((k) => String(tlNum(node, k, ""))).join("|"); } catch (_) { return ""; }
}

// 面板里的规划参数变了 ⇒ 内存态作废（段数/网格/fps 都该按新参数重算）
function dropStalePlan(node) {
  if (!node || !node._eztpPlan || node._eztpDurOpen) return;
  try { if (planSig(node) !== node._eztpPlanSig) node._eztpPlan = null; } catch (_) {}
}

// ★ 编辑期间就落盘（防抖）：这样不管用户怎么关（× / 点画布 / 关节点），改动都不会丢，
//   TimeLine 也能立刻跟着重铺。「保存 / 取消」只是「关窗」和「回滚到打开时」的区别。
function persistDraft(node) {
  const d = node && node._eztpDraft;
  if (!d) return;
  const ovr = {};
  for (let i = 1; i <= d.count; i++) { const v = d.secs[i]; if (v > 0) ovr[i] = v; }
  try { writeDurCfg(node, ovr, d.count); } catch (_) {}
  // 回读校验：写入失败就别装作成功（例如渲染层把 config 顶回旧值）
  try {
    const back = readConfig(node) || {};
    const ok = (parseInt(back.segCount, 10) || 0) === d.count;
    if (node._eztpWarn) node._eztpWarn.textContent = ok ? "" : ezT("Save failed");
  } catch (_) {}
}

function schedulePersist(node) {
  try { if (node._eztpCommitT) clearTimeout(node._eztpCommitT); } catch (_) {}
  node._eztpCommitT = setTimeout(() => { node._eztpCommitT = 0; persistDraft(node); }, 220);
}

// 提交草稿并关窗（× / 画布 / 保存 都走这里）；内存态留给下次打开
function saveDurs(node) {
  if (!node) return;
  try { if (node._eztpCommitT) { clearTimeout(node._eztpCommitT); node._eztpCommitT = 0; } } catch (_) {}
  persistDraft(node);
  closeDurModal(node);
}

// 取消：把 config 恢复到打开弹窗那一刻，内存态也作废，再关窗
function cancelDurs(node) {
  const base = node && node._eztpBaseCfg;
  try { if (node._eztpCommitT) { clearTimeout(node._eztpCommitT); node._eztpCommitT = 0; } } catch (_) {}
  if (base) {
    try { writeCfgHard(node, JSON.parse(base)); } catch (_) {}
    try { if (node._eztpUpdate) node._eztpUpdate(); } catch (_) {}
    try { tlNotifyPlanDownstream(node); } catch (_) {}
  }
  closeDurModal(node, true);
}

function makeDurRow(node, i) {
  const row = el("div", "eztp-dr");
  const idx = el("span"); idx.textContent = "#" + i; row.appendChild(idx);
  const inp = document.createElement("input");
  inp.type = "number"; inp.min = "0.1"; inp.step = "0.1";
  inp.title = ezT("Edit this segment's target duration (seconds)");
  // 输入只改草稿 + 立刻重算（不重建 DOM、不写 config）
  const apply = () => {
    const d = node._eztpDraft;
    if (!d) return;
    const v = parseFloat(inp.value);
    if (v > 0) d.secs[i] = v; else delete d.secs[i];
    paintDurs(node);
    schedulePersist(node);
  };
  inp.addEventListener("input", apply);
  inp.addEventListener("change", apply);
  inp.addEventListener("blur", () => { apply(); paintDurs(node, true); });
  row.appendChild(inp);
  const av = el("span", "act"); row.appendChild(av);
  const fr = el("span", "act"); row.appendChild(fr);
  const del = el("button", "eztp-dx"); del.type = "button"; del.textContent = "×";
  del.title = ezT("Remove this segment");
  del.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const d = node._eztpDraft;
    if (!d || d.count <= 1) return;
    const secs = {};
    for (let j = 1; j <= d.count; j++) {
      if (j === i) continue;
      const nj = j > i ? j - 1 : j;
      if (d.secs[j] != null) secs[nj] = d.secs[j];
    }
    d.count -= 1; d.secs = secs;
    renderDurs(node);
    persistDraft(node);
  });
  row.appendChild(del);
  return { row, inp, av, fr, del };
}

// 行数变了才重建（加段 / 删段），否则只更新值
function syncDurRows(node) {
  const box = node && node._eztpRows;
  const d = node && node._eztpDraft;
  if (!box || !d) return;
  const rows = node._eztpRowEls || (node._eztpRowEls = []);
  if (rows.length === d.count) return;
  box.innerHTML = "";
  rows.length = 0;
  for (let i = 1; i <= d.count; i++) {
    const r = makeDurRow(node, i);
    rows.push(r); box.appendChild(r.row);
  }
}

// 只改值：每段目标/实际/帧数 + 顶部合计（force = 连正在输入的框也回填，失焦时用）
function paintDurs(node, force) {
  const d = node._eztpDraft;
  if (!d) return;
  const base = durBase(node);
  const rows = node._eztpRowEls || [];
  let targetTotal = 0, actualTotal = 0, frameTotal = 0;
  for (let i = 1; i <= d.count; i++) {
    const r = rows[i - 1];
    if (!r) continue;
    if (document.activeElement === r.inp) {
      const v = parseFloat(r.inp.value);
      if (v > 0) d.secs[i] = v;
    }
    const manual = d.secs[i] != null;
    const target = manual ? d.secs[i] : base.defSec;
    const ca = durActual(base, d.count, i, target);
    const sr = base.segs[i - 1] || null;
    // 没手动过的段用规划算好的值（按总时长平摊）；手动 / 新增段按单段算式现算。
    const net = (!manual && sr) ? (Number(sr.net) || ca.net) : ca.net;
    const gen = (!manual && sr) ? (Number(sr.gen) || ca.gen) : ca.gen;
    if (force || document.activeElement !== r.inp) r.inp.value = Number(target).toFixed(2);
    r.av.textContent = (net / base.fps).toFixed(2) + "s";
    r.fr.textContent = String(gen);
    r.del.disabled = d.count <= 1;
    targetTotal += target;
    actualTotal += net / base.fps;
    frameTotal += gen;
  }
  const sum = node._eztpSum;
  if (sum) {
    sum.innerHTML = "";
    const mk = (label, value) => { const s = el("span"); s.innerHTML = ezT(label) + " <b>" + value + "</b>"; sum.appendChild(s); };
    mk("Target total", targetTotal.toFixed(2) + "s");
    mk("Actual total", actualTotal.toFixed(2) + "s");
    mk("Actual frames", String(frameTotal));
  }
}

function renderDurs(node) {
  if (!node || !node._eztpDurOpen || !node._eztpDurs || !node._eztpDraft) return;
  syncDurRows(node);
  paintDurs(node);
}

function writeDurCfg(node, ovr, count) {
  const cfg = readConfig(node) || {};
  if (ovr && Object.keys(ovr).length) cfg.segOverride = ovr;
  else delete cfg.segOverride;
  cfg.segCount = Math.max(1, parseInt(count, 10) || 1);
  cfg.customOn = true;
  writeCfgHard(node, cfg);
  try { if (node._eztpUpdate) node._eztpUpdate(); } catch (_) {}
  try { tlNotifyPlanDownstream(node); } catch (_) {}
}

// config 三写：widget.value + widget 的 DOM 元素 + properties.ezTp.config。
// 只写 widget.value 时，部分渲染层（Nodes 2.0 的文本域）会用元素里的旧文本把它顶回去，
// 表现就是「保存了但重新打开又是旧的」——这里把三条路都写一遍。
function writeCfgHard(node, cfg) {
  writeConfig(node, cfg);
  try {
    const json = JSON.stringify(cfg);
    const w = configWidget(node);
    if (w) {
      w.value = json;
      if (w.inputEl) w.inputEl.value = json;
      if (w.element && "value" in w.element) w.element.value = json;
    }
    node.properties = node.properties || {};
    node.properties.ezTp = node.properties.ezTp || {};
    node.properties.ezTp.config = json;
  } catch (_) {}
}

function closeDurModal(node, dropPlan) {
  const m = node && node._eztpDurEl;
  if (m) { try { m.remove(); } catch (_) {} }
  if (node) {
    try { if (node._eztpCommitT) { clearTimeout(node._eztpCommitT); node._eztpCommitT = 0; } } catch (_) {}
    // ★ 和 PromptHelper 卡片一样：关窗后把内存态留在节点上（`_eztpPlan`），下次打开直接用。
    if (dropPlan) node._eztpPlan = null;
    else if (node._eztpDraft) node._eztpPlan = node._eztpDraft;
    node._eztpDurEl = null; node._eztpDurs = null; node._eztpDurOpen = false;
    node._eztpSum = null; node._eztpRows = null; node._eztpRowEls = null; node._eztpDraft = null;
    node._eztpWarn = null; node._eztpBaseCfg = null;
  }
}

// 表头 / 合计 / 行容器 / 底部按钮只建一次；之后加段只补行，改值只改数字
function buildDurTable(node) {
  const box = node._eztpDurs;
  if (!box) return;
  box.innerHTML = "";
  const sum = el("div", "eztp-msum"); node._eztpSum = sum; box.appendChild(sum);
  const hd = el("div", "eztp-dh");
  ["#", ezT("Target duration"), ezT("Actual duration"), ezT("Actual frames"), ""].forEach((t) => {
    const c = el("span"); c.textContent = t; hd.appendChild(c);
  });
  box.appendChild(hd);
  const rowsBox = el("div", "eztp-drows"); node._eztpRows = rowsBox; node._eztpRowEls = [];
  box.appendChild(rowsBox);
  const btns = el("div", "eztp-dbtns");
  const add = el("button", "eztp-dbtn eztp-dadd"); add.type = "button"; add.textContent = "+ " + ezT("Add segment");
  const warn = el("span", "eztp-warn"); node._eztpWarn = warn;
  add.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const d = node._eztpDraft;
    if (!d) return;
    d.count += 1;
    d.secs[d.count] = durBase(node).defSec;   // 新段默认 = 「每段」时长
    renderDurs(node);
    persistDraft(node);
    const rows = node._eztpRowEls || [];
    const last = rows[rows.length - 1];
    if (last) { try { last.inp.focus(); last.inp.select(); } catch (_) {} }
  });
  const save = el("button", "eztp-dbtn"); save.type = "button"; save.textContent = ezT("Save");
  save.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); saveDurs(node); });
  const cancel = el("button", "eztp-dbtn"); cancel.type = "button"; cancel.textContent = ezT("Cancel");
  cancel.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); cancelDurs(node); });
  btns.appendChild(add); btns.appendChild(warn); btns.appendChild(save); btns.appendChild(cancel);
  box.appendChild(btns);
}

function openDurModal(node) {
  if (node._eztpDurEl) { renderDurs(node); return; }
  const modal = el("div", "eztp-modal");
  const box = el("div", "eztp-mbox");
  const hd = el("div", "eztp-mhd");
  const title = el("div", "eztp-mtitle"); title.textContent = ezT("Custom");
  // 右上角 × = 关闭**不保存**（和 PromptHelper 卡片的 ✕ 一样：✕ / 取消都是丢弃，保存靠「保存」或点弹窗外）
  const close = el("button", "eztp-mclose"); close.type = "button"; close.textContent = "×";
  close.title = ezT("Cancel");
  close.addEventListener("click", () => cancelDurs(node));
  hd.appendChild(title); hd.appendChild(close);
  const body = el("div", "eztp-mbody");
  box.appendChild(hd); box.appendChild(body); modal.appendChild(box);
  // ★ 点「弹窗外」（画布/遮罩）松开 = 保存并关闭。用 mousedown/mouseup 判定而不是 click：
  //   PromptHelper 卡片弹窗就是这套（画布上 click 可能被 Canvas 吞掉，mouseup 不会）。
  //   在框内按下、拖到框外松开不算「点外面」。
  let downInBox = false;
  modal.addEventListener("mousedown", (e) => { downInBox = box.contains(e.target); });
  modal.addEventListener("mouseup", (e) => {
    const startedInBox = downInBox; downInBox = false;
    if (!startedInBox && e.target === modal) saveDurs(node);
  });
  node._eztpDurEl = modal; node._eztpDurs = body; node._eztpDurOpen = true;
  document.body.appendChild(modal);
  buildDurTable(node);
  initDraft(node);
  renderDurs(node);
}

// ★ 参数被改：自己重画 + **顺 `timeplan` 出口递归通知下游**（TimeLine 的时间轴立刻按新规划重铺）。
//   这是「timeplan ↔ timeline 实时联动」的 TimePlan → TimeLine 方向。
//   ⚠️ 必须用 `tlNotifyPlanDownstream` 而不是 `notifyOut`：`timeplan` 可以被**透传**
//   （EzFlex-SplitVideo 的第 0 个出口就是原样透传），实际接线常常是
//   `TimePlan → SplitVideo.timeplan → TimeLine.timeplan` —— 只走一跳穿不过 SplitVideo。
function changed(node) {
  try { sync(node); } catch (_) {}
  try { tlNotifyPlanDownstream(node); } catch (_) {}
}

// ★★ `timeplan` 输出口排第 0 位。
//   为什么需要这个迁移：内核 `configure` 恢复端口用的是 `LiteGraph.cloneObject`，它是
//   `for (const i in r) target[i] = r[i]` —— **按序列化那份的数组下标**就地覆盖。
//   老工作流序列化的 outputs 是 `[frames, timeplan]`，会把类里第 0 位的 `timeplan` 槽位对象
//   就地改成 `frames/INT`（第 1 位改成 `timeplan`）⇒ 加载后**顺序还是老的**。
//   这里把 timeplan 挪到第 0 位、强制两个槽位的名字/类型，再把每条线改挂到它 socket 的新下标
//   （搬的是 socket 对象本身；不回写 link 的 origin_slot 的话内核按槽位取值会张冠李戴）。

// 一个出口槽「语义上是什么」：看**它自己那些连线的 `type`**。
//   ★ 为什么不能用名字：`cloneObject` 按源数组下标覆盖，而名字可能已经被上一版迁移就地改过
//   （名字改对了、socket 没搬）⇒ 只看名字会误判成「已经修好了」，于是**永远修不回来**。
//   ★ 为什么用 `link.type` 而不是去读目标节点的输入口类型：`link.type` 自包含，
//   不依赖目标节点是否已经 configure 完（加载早期目标可能还没建好）。
function planSlotRole(node, i) {
  const links = (node.graph && node.graph.links) || {};
  const o = (node.outputs || [])[i];
  if (!o) return "";
  const ids = [];
  if (Array.isArray(o.links)) ids.push(...o.links);
  if (o.link != null) ids.push(o.link);
  for (let k = 0; k < ids.length; k++) {
    const t = String((links[ids[k]] && links[ids[k]].type) || "");
    if (t === "EZFLEX_TIMEPLAN") return "plan";
    if (t === "INT") return "frames";
  }
  return "";
}

// ★★★ 端口迁移必须**语义化**：
//   坏状态长这样 —— slot0 叫 `timeplan` 却挂着去 `336.length`(INT) 的线，slot1 叫 `frames`
//   却挂着去两个 `timeplan` 口的线（上一版迁移只改了名字、没搬 socket，而早退判据是按名字的
//   ⇒ 判成「已修好」，再也不动）⇒ `tlUpstreamPlanNode` 在 `outputs[origin_slot].name === 'timeplan'`
//   那一步断掉、**静默退回默认规划**，表现就是「改 TimePlan 时间轴不动」。
//   现在：① 按连线类型认槽 → ② 认不出（新节点/没连线）才按名字 → ③ 都没有就补一个 → ④ 摘掉多余口。
function ensurePlanPort(node) {
  const outs = node.outputs || [];
  if (!outs.length) return;
  const cap = ezCaptureSocketLinks(node);   // 搬 socket 之前按对象拍连线快照（新版前端 socket.links 按下标变）
  let planAt = -1;
  outs.forEach((s, i) => { if (planAt < 0 && planSlotRole(node, i) === "plan") planAt = i; });
  if (planAt < 0) planAt = outs.findIndex((s) => s && String(s.name) === "timeplan");
  if (planAt < 0) {
    // 老工作流里根本没有 timeplan 口 ⇒ 补一个（`addOutput` 追加在末尾）再搬到最前
    try { node.addOutput("timeplan", "EZFLEX_TIMEPLAN"); outs.unshift(outs.pop()); } catch (_) {}
    planAt = 0;
  }
  if (planAt > 0) outs.unshift(outs.splice(planAt, 1)[0]);   // 搬的是 socket 对象 ⇒ 连线跟着走
  ezApplySocketLinks(node, cap);   // ★ 先把线改挂到新下标，再删多余口 —— 否则删口会按旧下标断掉 timeplan 的线
  try {
    if (outs[0]) { outs[0].name = "timeplan"; outs[0].type = "EZFLEX_TIMEPLAN"; }
    if (outs[1]) { outs[1].name = "frames"; outs[1].type = "INT"; }
  } catch (_) {}
  // 后端现在只声明 2 个口 ⇒ 多出来的（老工作流的 `trim_frames` 之类）摘掉，否则画布上有幽灵圆点。
  // ★ 有连线的绝不删（内核按槽位下标回填连线，少一个槽后面的线整体丢）。
  for (let i = outs.length - 1; i >= 2; i--) {
    const o = outs[i];
    const ids = [];
    if (o && Array.isArray(o.links)) ids.push(...o.links);
    if (o && o.link != null) ids.push(o.link);
    if (ids.length) continue;
    try { node.removeOutput(i); } catch (_) { try { outs.splice(i, 1); } catch (_2) {} }
  }
  ezApplySocketLinks(node, cap);   // 删口会把后面的线下标前移，再对一次
}

// ★ 迁移第一次跑时 `graph.links` 可能还没齐（`planSlotRole` 读的是连线类型）⇒ 短时重试几次，
//   跑完自停。同 `split_video.js#scheduleTrim` 的思路。
function schedulePlanPort(node, tries) {
  const n = (tries == null) ? 6 : tries;
  if (n <= 0) return;
  try {
    if (node._eztpPortT) clearTimeout(node._eztpPortT);
    node._eztpPortT = setTimeout(() => {
      node._eztpPortT = 0;
      if (!node.graph) return;                     // 节点已被删
      try { paintPorts(node); } catch (_) {}
      schedulePlanPort(node, n - 1);
    }, 200);
  } catch (_) {}
}

function paintPorts(node) {
  try { ensurePlanPort(node); } catch (_) {}
  ((node.inputs || [])).forEach((s) => { try { hideNativeSlotText(s); } catch (_) {} });
  ((node.outputs || [])).forEach((s) => { try { hideNativeSlotText(s); } catch (_) {} });
  // ★ 显式 labelOf：默认实现取 `s.name || s.type`，某些前端版本里槽的 name 可能为空
  //   （只剩 localized_name）⇒ 黑框要么空、要么显示 "INT"。这里按端口名写死，稳。
  try {
    installEdgeLabels(node, {
      side: "both",
      rootOf: (n) => n._eztpRoot,
      labelOf: (s) => String((s && (s.name || s.localized_name)) || ""),
    });
  } catch (_) {}
}

function mount(node) {
  if (!node || node._eztpSetup) return;
  node._eztpSetup = true;
  inject();
  const shell = el("div", "eztp-shell");
  const root = el("div", "eztp-root");
  shell.appendChild(root);
  node._eztpRoot = shell;      // 外层：定位 / 尺寸 / 端口标签锚点
  node._eztpInner = root;      // 内层：真正的面板容器（pointer-events:auto 只对它生效）
  build(node, root);
  sync(node);

  const widget = node.addDOMWidget("TimePlan", "eztp__" + Math.random().toString(36).slice(2), shell, {
    serialize: false, hideOnZoom: false, canvasOnly: !(window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()),
    margin: 4, getMinHeight: () => 140, getValue: () => "{}", setValue: () => {},
  });
  node._eztpWidget = widget;
  // ★ 给「外部改我 config」的调用方（TimeLine 拖分段）留一个刷新钩子
  node._eztpUpdate = function () {
    try { fill(node); } catch (_) {}

    try { if (node._eztpSyncCustom) node._eztpSyncCustom(); } catch (_) {}
    try { if (node._eztpSyncPlans) node._eztpSyncPlans(); } catch (_) {}
    // 弹窗没开时被外部通知（例如 TimeLine 拖段写了 config）⇒ 丢掉内存态，下次打开按 config 重建
    try { if (!node._eztpDurOpen) node._eztpPlan = null; } catch (_) {}
    try { renderDurs(node); } catch (_) {}
  };
  // ★ TimeLine 右键「设定整体时长」直接复用这里：打开的就是这个自定义规划弹窗（同一份实现/样式）
  node._eztpOpenCustom = function () { try { openDurModal(node); } catch (_) {} };
  makeDomWidgetHitThrough(widget.element || shell);
  try { node.widgets_start_y = 0; } catch (_) {}
  try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
  installResizeHandles(node, shell);
  try { ezApplyDefaultSize(node, MIN_W, 210); } catch (_) {}
  sync(node);
  forceShell(node);
  // ★ 自愈：宿主 widget 可能被重建（切图 / 折叠 / 切 tab）⇒ 重挂 + 短时主动轮询（到期自停）
  let retry = 0;
  (function again() {
    forceShell(node);
    try { sync(node); } catch (_) {}
    if (retry < 10) { retry += 1; setTimeout(again, 120); }
  })();
}

function hook(nt) {
  if (!nt || nt.__eztpHooked) return;
  nt.__eztpHooked = true;
  const pc = nt.prototype.onNodeCreated;
  nt.prototype.onNodeCreated = function () {
    const r = pc ? pc.apply(this, arguments) : undefined;
    // ★ 面板挂载与端口迁移**分开 try**：面板挂失败也必须把端口顺序/迁移做掉
    //   （否则老工作流的 `timeplan` 就永远排不到第 0 位）。
    try { mount(this); } catch (_) {}
    try { paintPorts(this); } catch (_) {}
    return r;
  };
  // 旧版错位存档可能把 align 写成 0、config 写成 '0'：先拉回合法值。
  function sanitize(node) {
    const aw = widgetOf(node, "align");
    if (aw && String(aw.value) !== "align" && String(aw.value) !== "strict") {
      aw.value = "align";
      try { node.properties.ezTp = node.properties.ezTp || {}; node.properties.ezTp.align = "align"; } catch (_) {}
    }
    const cw = widgetOf(node, "config");
    if (cw) {
      try {
        const v = JSON.parse(cw.value || "{}");
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          cw.value = "{}";
          try { node.properties.ezTp = node.properties.ezTp || {}; node.properties.ezTp.config = "{}"; } catch (_) {}
        }
      } catch (_) {
        cw.value = "{}";
        try { node.properties.ezTp = node.properties.ezTp || {}; node.properties.ezTp.config = "{}"; } catch (_) {}
      }
    }
  }
  // ⚠️ configure **不重新挂载**：再 addDOMWidget 会多出一份面板（「重复了两边」）。
  const pm = nt.prototype.onConfigure;
  nt.prototype.onConfigure = function () { this.__ezSizeRestored = true;
    const r = pm ? pm.apply(this, arguments) : undefined;
    try {
      const p = this.properties && this.properties.ezTp;
      if (p && typeof p === "object") {
        Object.keys(p).forEach((k) => { const w = widgetOf(this, k); if (w) w.value = p[k]; });
      }
    } catch (_) {}
    try { sanitize(this); } catch (_) {}
    // 重新载入工作流 / undo-redo ⇒ 内存态作废，按 config 重建
    try { this._eztpPlan = null; } catch (_) {}
    try {
      // 老工作流存的节点很窄（336px），三列会挤成小方块 ⇒ 载入时只放大、不缩小
      const w = this.size ? this.size[0] : 0;
      if (w && w < MIN_W) this.setSize([MIN_W, Math.max(140, this.size[1] || 140)]);
    } catch (_) {}
    try { if (!this._eztpSetup) mount(this); } catch (_) {}
    try { sync(this); } catch (_) {}
    try { paintPorts(this); } catch (_) {}
    try { schedulePlanPort(this); } catch (_) {}   // ★ configure 才是连线真正到位的时刻 ⇒ 再重试几轮
    return r;
  };
  const pcc = nt.prototype.onConnectionsChange;
  nt.prototype.onConnectionsChange = function () {
    const r = pcc ? pcc.apply(this, arguments) : undefined;
    try { sync(this); } catch (_) {}
    try { paintPorts(this); } catch (_) {}
    return r;
  };
  const pr = nt.prototype.onRemoved;
  nt.prototype.onRemoved = function () {
    const r = pr ? pr.apply(this, arguments) : undefined;
    try { if (this._eztpPortT) { clearTimeout(this._eztpPortT); this._eztpPortT = 0; } } catch (_) {}
    try { closeDurModal(this, true); } catch (_) {}
    try { if (this._eztpRoot) this._eztpRoot.remove(); } catch (_) {}
    this._eztpRoot = null;
    this._eztpInner = null;
    this._eztpSetup = false;
    return r;
  };
}

// 语言切换：整块重画（标签要跟着中/英切）
onLocaleChange(() => {
  try {
    const g = (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
    ((g && g._nodes) || []).forEach((n) => {
      if (nodeTypeOf(n) !== TP) return;
      // ★ 必须重画进内层 .eztp-root：外层 .eztp-shell 是 pointer-events:none，
      //   把 grid 直接挂上去会让整块面板失去点击（只有 .eztp-shell .eztp-root 恢复 auto）。
      try { if (n._eztpInner && n._eztpInner.isConnected) { build(n, n._eztpInner); sync(n); } } catch (_) {}
    });
  } catch (_) {}
});

app.registerExtension({
  name: "EzFlex.TimePlan",
  async beforeRegisterNodeDef(nt, nd) {
    if (nd && nd.name === TP) hook(nt);
  },
  nodeCreated(n) {
    if (nodeTypeOf(n) !== TP) return;
    // ★ 分开 try：面板挂失败也必须把端口顺序/迁移做掉（否则老工作流的 timeplan 排不到第 0 位）
    try { mount(n); } catch (_) {}
    try { paintPorts(n); } catch (_) {}
    try { schedulePlanPort(n); } catch (_) {}      // 连线类型要等 graph.links 齐 ⇒ 短时重试
  },
});
