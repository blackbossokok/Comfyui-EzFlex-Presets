// 面板：SegmentPanel 面板：已落盘段/成片的实时快照与操作
// EzFlex-SegmentPanel 面板：段间检查站（裁头 + 落盘 + 清显存 + 收口）的配置面板。
//
// 以前是四个裸 widget：`save_dir` 靠手敲路径（极易错）、`fps` / `clean_vram` / `assemble` 一排在
// 节点底下。现在：
//   · 保存目录 = 文本框 + 「选择」（Windows 原生选目录对话框）+ 「打开」（资源管理器定位）；
//   · 帧率 / 清理显存 / 拼接成片 = 自绘（开关用分段按钮，同插件其它面板）。
//
// ★ 2026-10-15 用户要求删掉底部那行状态文字（「底下那两个说明文字不要」）⇒ 面板只留配置，
//   不再显示「总段数 / 裁头帧数 / 已落盘 N/M 段 / 成片」，也不再轮询 manifest。
//   后端那条只读路由（`GET /ezflex/segment_manifest`）和落盘时推的 `ezflex.segment` 事件
//   **都还在**（`__init__.py` + `segment_panel_test.py` 都覆盖着）⇒ 将来想显示回来直接接上即可。
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { ezApplyDefaultSize,
  NODE_TYPES, nodeTypeOf, installResizeHandles, makeDomWidgetHitThrough,
  installEdgeLabels, hideNativeSlotText, apiPost, ezCaptureSocketLinks, ezApplySocketLinks,
} from "../core/ezflex_service.js";
import { ezT, onLocaleChange } from "../core/ezflex_i18n.js";

const SP = NODE_TYPES.SEGMENT_PANEL;
const MIN_W = 420;
const OUT_ORDER = ["timeplan", "images", "audio", "video"];
function scheduleReorder(node) {
  if (!node || node._ezOutOrderPend) return;
  node._ezOutOrderPend = true;
  setTimeout(() => {
    node._ezOutOrderPend = false;
    try { reorderOutputs(node); } catch (_) {}
  }, 100);
}
function reorderOutputs(node) {
  const cur = (node.outputs || []).map((s) => String((s && s.name) || '').toLowerCase());
  if (!cur.length || cur[0] === OUT_ORDER[0]) return;
  if (OUT_ORDER.some((n) => cur.indexOf(n) < 0)) return;
  const cap = ezCaptureSocketLinks(node);
  const by = {};
  (node.outputs || []).forEach((s) => { by[String(s.name || '').toLowerCase()] = s; });
  // ★ 以前是 OUT_ORDER.map(...) 直接整体替换 ⇒ 不在名单里的端口（video）会被**删掉**。
  //   现在按顺序取，剩下的原样追加到后面，数量必须一致才动。
  const next = [];
  OUT_ORDER.forEach((n) => { if (by[n]) { next.push(by[n]); delete by[n]; } });
  Object.keys(by).forEach((k) => next.push(by[k]));
  if (next.length !== node.outputs.length) return;
  node.outputs.splice(0, node.outputs.length, ...next);
  next.forEach((s, i) => { try { s.slot_index = i; } catch (_) {} });
  ezApplySocketLinks(node, cap);
  try { node.setDirtyCanvas && node.setDirtyCanvas(true, true); } catch (_) {}
}

const MIN_H = 260;
const HIDDEN = ["save_dir", "fps", "clean_vram", "assemble", "trim_tail", "rerun_stop", "codec", "bit_depth", "color_space", "crf", "final_format", "final_codec", "final_crf", "final_bit_depth", "final_color_space", "final_follow", "final_fps", "blend_frames", "audio_xfade_ms"];

const CSS = `
.ezsp-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezsp-shell .ezsp-root{pointer-events:auto;}
.ezsp-rows{display:flex;flex-direction:column;gap:8px;min-width:0;}
.ezsp-root{position:absolute;inset:0 14px 14px 14px;font-family:inherit;color:var(--ez-fg);background:var(--ez-bg);
  border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;
  min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;}
.ezsp-two{gap:10px;}
.ezsp-two .ezsp-lbl{flex:0 0 auto;}
.ezsp-det{border:1px solid var(--ez-border-2);border-radius:8px;background:var(--ez-surface);padding:0 8px 6px;flex:0 0 auto;}
.ezsp-det>summary{cursor:pointer;font-size:11px;font-weight:600;color:var(--ez-fg-2);padding:6px 2px;user-select:none;}
.ezsp-det>summary::marker{color:var(--ez-fg-3);}
.ezsp-det[open]{padding-bottom:8px;}
/* 一行一个控件：左边固定宽度标签列 + 右边控件 */
.ezsp-row{display:flex;align-items:center;gap:6px;flex:0 0 auto;min-width:0;}
.ezsp-lbl{font-size:11px;color:var(--ez-fg-3);white-space:nowrap;flex:0 0 62px;text-align:left;overflow:hidden;
  text-overflow:ellipsis;}
.ezsp-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px;width:100%;min-width:0;}
.ezsp-fld{display:flex;align-items:center;gap:5px;min-width:0;}
.ezsp-fld .ezsp-lbl{flex:0 0 58px;}
.ezsp-fld .ezsp-sel,.ezsp-fld .ezsp-num{flex:1 1 auto;width:auto;min-width:0;}
.ezsp-chk{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--ez-fg-3);white-space:nowrap;cursor:pointer;min-width:0;}
.ezsp-chk input{accent-color:var(--ez-strong);margin:0;}
.ezsp-btn{height:26px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);
  color:var(--ez-fg);font-family:inherit;font-size:11px;padding:0 9px;cursor:pointer;flex:0 0 auto;
  white-space:nowrap;line-height:1;}
.ezsp-btn:hover{background:var(--ez-surface-3);}
/* 「保存位置」按钮：与 PreviewAny 的 .ezpv-loc 同款（实心强调色，点一下弹原生选目录对话框） */
.ezsp-btn.loc{background:var(--ez-strong);border-color:var(--ez-strong);color:var(--ez-on-strong);}
.ezsp-btn.loc:hover{background:var(--ez-strong);filter:brightness(1.06);}
.ezsp-fld{display:flex;align-items:center;gap:5px;flex:0 0 auto;min-width:0;}
.ezsp-num{height:26px;width:56px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);
  color:var(--ez-fg);font-family:inherit;font-size:12px;padding:0 6px;text-align:center;outline:none;box-sizing:border-box;
  -moz-appearance:textfield;appearance:textfield;flex:0 0 auto;}
.ezsp-num::-webkit-outer-spin-button,.ezsp-num::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.ezsp-num:disabled{opacity:.55;cursor:default;background:var(--ez-surface-3);}
.ezsp-sel:disabled{opacity:.55;cursor:default;background:var(--ez-surface-3);}
.ezsp-sw{display:flex;align-items:center;gap:5px;flex:0 0 auto;cursor:pointer;user-select:none;}
.ezsp-seg{display:inline-flex;border:1px solid var(--ez-border);border-radius:6px;overflow:hidden;background:var(--ez-surface-2);}
.ezsp-seg-i{padding:0 7px;height:24px;line-height:24px;font-size:11px;color:var(--ez-fg-muted);font-style:normal;cursor:pointer;}
/* 开 = 绿 / 禁 = 红（与 media_loader 的 On/Off 分段开关同一套约定） */
.ezsp-seg-i.on.active{background:var(--ez-ok-bg);border-color:var(--ez-ok-border);color:var(--ez-ok-fg);font-weight:600;}
.ezsp-seg-i.off.active{background:var(--ez-bad-bg);color:var(--ez-bad-fg);font-weight:600;}
.ezsp-sel{height:26px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font-family:inherit;font-size:11px;padding:0 6px;min-width:0;}
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
function normalizeWidgets(node) {
  const defs = { save_dir: '', fps: 24, clean_vram: true, assemble: true, trim_tail: 0, rerun_stop: -1, codec: 'auto', bit_depth: 'auto', color_space: 'sRGB', crf: 0, final_format: 'mp4', final_codec: 'auto', final_crf: 0, final_bit_depth: 'auto', final_color_space: 'sRGB', final_follow: false, final_fps: 0, blend_frames: 0, audio_xfade_ms: 0 };
  Object.keys(defs).forEach((nm) => {
    const w = widgetOf(node, nm);
    if (w && (w.value === null || w.value === undefined || (nm !== 'save_dir' && w.value === ''))) w.value = defs[nm];
  });
}
function forceShell(node) {
  const p = node && node._ezspRoot; if (!p || !p.isConnected) return;
  const si = (t, prop, val) => { try { t.style.setProperty(prop, val, 'important'); } catch (_) {} };
  si(p, 'width', '100%'); si(p, 'max-width', '100%'); si(p, 'height', '100%'); si(p, 'max-height', '100%'); si(p, 'box-sizing', 'border-box');
  if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) { si(p, 'top', 'var(--ezfx-vue-title,30px)'); si(p, 'height', 'calc(100% - var(--ezfx-vue-title,30px))'); si(p, 'bottom', 'auto'); }
}
function segSwitch(labelText, checked, onChange, onText, offText) {
  const l = el('label', 'ezsp-sw');
  const seg = el('span', 'ezsp-seg');
  const onS = el('em', 'ezsp-seg-i on'); onS.textContent = onText || ezT('On');
  const offS = el('em', 'ezsp-seg-i off'); offS.textContent = offText || ezT('Off');
  seg.appendChild(onS); seg.appendChild(offS);
  if (labelText) { const sp = el('span', 'ezsp-lbl'); sp.textContent = labelText; l.appendChild(sp); }
  l.appendChild(seg);
  let cur = !!checked;
  const upd = () => { onS.classList.toggle('active', cur); offS.classList.toggle('active', !cur); };
  const pick = (v) => (e) => { e.preventDefault(); e.stopPropagation(); if (cur === v) return; cur = v; upd(); onChange(v); };
  onS.addEventListener('click', pick(true));
  offS.addEventListener('click', pick(false));
  upd();
  l._set = (v) => { cur = !!v; upd(); };
  l._get = () => cur;
  return l;
}
function selectInput(val, options, onSet) {
  const s = el('select', 'ezsp-sel');
  options.forEach(([v, t]) => { const o = el('option'); o.value = String(v); o.textContent = String(t); if (String(v) === String(val)) o.selected = true; s.appendChild(o); });
  s.addEventListener('change', () => onSet(s.value));
  return s;
}
function numInput(val, onSet, min, max) {
  const i = el('input', 'ezsp-num');
  i.type = 'number'; i.min = String(min == null ? 1 : min); i.max = String(max == null ? 120 : max); i.step = '1'; i.value = String(val);
  const fire = () => { const v = parseInt(i.value, 10); if (!isNaN(v)) onSet(v); };
  i.addEventListener('change', fire);
  i.addEventListener('blur', fire);
  return i;
}

// ---- 渲染：一行一个控件----
//   ① 保存位置（PreviewAny 同款：一个实心按钮，点了弹原生选目录对话框）
//   ② 帧率  ③ 清理显存  ④ 拼接成片
//   ★ 「打开」打开的是**当前实际使用的**目录：`save_dir` 空 ⇒ 后端用默认的 `<output>/EzFlex_Segments`
//     （走 `POST /ezflex/segment_open`，后端自己做「仅本机 + 允许根内」收口）。
function render(node, main) {
  const dir = String(wval(node, 'save_dir', '') || '');
  const fps = parseInt(wval(node, 'fps', 24), 10) || 24;
  const clean = !!wval(node, 'clean_vram', true);
  const asm = !!wval(node, 'assemble', true);

  main.innerHTML = '';

  // ① 保存位置
  const r1 = el('div', 'ezsp-row');
  const l1 = el('span', 'ezsp-lbl'); l1.textContent = ezT('Save location');
  const loc = el('button', 'ezsp-btn loc'); loc.type = 'button'; loc.textContent = ezT('Save location');
  loc.title = dir || (ezT('Default folder') + '（output/EzFlex_Segments）');
  loc.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const r = await (api && api.fetchApi
        ? api.fetchApi('/preview_any/pick_folder', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        : fetch('/preview_any/pick_folder', { method: 'POST', headers: { 'Content-Type': 'application/json' } }));
      const d = r ? await r.json() : null;
      if (d && d.ok && d.path) { setWidget(node, 'save_dir', d.path); node._ezspRender && node._ezspRender(); }
    } catch (_) {}
  });
  const open = el('button', 'ezsp-btn'); open.type = 'button'; open.textContent = ezT('Open folder');
  open.title = dir || (ezT('Default folder') + '（output/EzFlex_Segments）');
  open.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const body = JSON.stringify({ dir: String(wval(node, 'save_dir', '') || '') });
      const r = await (api && api.fetchApi
        ? api.fetchApi('/ezflex/segment_open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        : fetch('/ezflex/segment_open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }));
      const d = r ? await r.json().catch(() => null) : null;
      if (d && d.error) console.warn('[EzFlex-SegmentPanel] open folder:', d.error);
    } catch (_) {}
  });
  // ★ 这一行必须真的挂上两个按钮：以前 appendChild 丢了 ⇒ 面板上「保存位置」整行是空的（用户找不到按钮）
  r1.appendChild(l1); r1.appendChild(loc); r1.appendChild(open);
  // ② 清理显存 + 拼接成片同一行
  const rSw = el('div', 'ezsp-row ezsp-two');
  rSw.appendChild(segSwitch(ezT('Clean VRAM'), clean,
                            (v) => { setWidget(node, 'clean_vram', v); node._ezspRender && node._ezspRender(); },
                            ezT('Enable'), ezT('Disable')));
  rSw.appendChild(segSwitch(ezT('Assemble'), asm,
                            (v) => { setWidget(node, 'assemble', v); node._ezspRender && node._ezspRender(); },
                            ezT('Enable'), ezT('Disable')));

  const mkFld = (label, ctl) => {
    const f = el('div', 'ezsp-fld');
    const lab = el('span', 'ezsp-lbl'); lab.textContent = label;
    f.appendChild(lab); f.appendChild(ctl); return f;
  };
  // ③ 接缝处理（清理显存下面一行）：画面混合帧数 + 音频交叉淡化毫秒
  const blend = parseInt(wval(node, 'blend_frames', 0), 10) || 0;
  const xfade = parseInt(wval(node, 'audio_xfade_ms', 0), 10) || 0;
  const rBlend = el('div', 'ezsp-row ezsp-two');
  const bIn = numInput(blend, (v) => { setWidget(node, 'blend_frames', Math.max(0, Math.min(24, v))); node._ezspRender && node._ezspRender(); }, 0, 24);
  bIn.title = ezT('Visible crossfade frames at each seam; 0 = off. The final gets shorter by this many frames per seam.');
  const aIn = numInput(xfade, (v) => { setWidget(node, 'audio_xfade_ms', Math.max(0, Math.min(2000, v))); node._ezspRender && node._ezspRender(); }, 0, 2000);
  aIn.title = ezT('Audio crossfade at each seam (ms); 0 = follow the video blend duration.');
  rBlend.appendChild(mkFld(ezT('Blend frames'), bIn));
  rBlend.appendChild(mkFld(ezT('Audio xfade (ms)'), aIn));
  node._ezspOpen = node._ezspOpen || { seg: false, fin: false };
  const mkDet = (key, title, open) => {
    const d = document.createElement('details'); d.className = 'ezsp-det';
    d.open = node._ezspOpen[key] == null ? !!open : !!node._ezspOpen[key];
    d.addEventListener('toggle', () => { node._ezspOpen[key] = d.open; });
    const s = document.createElement('summary'); s.textContent = title; d.appendChild(s);
    return d;
  };

  // ③ 分段编码：格式（固定 MP4，占位）/ 编码器 / FPS / CRF / 位深 / 色彩空间 —— 每两个一行
  const codec = String(wval(node, 'codec', 'auto') || 'auto');
  const bd = String(wval(node, 'bit_depth', 'auto') || 'auto');
  const cs = String(wval(node, 'color_space', 'sRGB') || 'sRGB');
  const crf = parseInt(wval(node, 'crf', 0), 10);
  const segDet = mkDet('seg', ezT('Segment encoding'), true);
  const segGrid = el('div', 'ezsp-grid');
  const segFmt = selectInput('mp4', [['mp4', 'MP4']], () => {});
  segFmt.disabled = true;
  segFmt.title = ezT('Segments always stay MP4 (looping / preview / concat)');
  segGrid.appendChild(mkFld(ezT('Format'), segFmt));
  segGrid.appendChild(mkFld(ezT('Encoder'), selectInput(codec,
    [['auto', 'auto'], ['h264', 'H.264'], ['av1', 'AV1']],
    (v) => { setWidget(node, 'codec', v); node._ezspRender && node._ezspRender(); })));
  const fIn = numInput(fps, (v) => { setWidget(node, 'fps', v); node._ezspRender && node._ezspRender(); });
  const _planOn = (node.inputs || []).some((s) => s && s.name === 'timeplan' && s.link != null);
  if (_planOn) { fIn.disabled = true; fIn.title = ezT('Follows TimePlan fps; this box is only a fallback'); }
  segGrid.appendChild(mkFld(ezT('FPS'), fIn));
  segGrid.appendChild(mkFld('CRF', numInput(isFinite(crf) ? crf : 0,
    (v) => { setWidget(node, 'crf', v); node._ezspRender && node._ezspRender(); }, 0, 63)));
  segGrid.appendChild(mkFld(ezT('Bit depth'), selectInput(bd,
    [['auto', 'auto'], ['8', '8-bit'], ['10', '10-bit']],
    (v) => { setWidget(node, 'bit_depth', v); node._ezspRender && node._ezspRender(); })));
  segGrid.appendChild(mkFld(ezT('Color space'), selectInput(cs,
    [['sRGB', 'sRGB'], ['HDR', 'HDR'], ['HDR PQ', 'HDR PQ']],
    (v) => { setWidget(node, 'color_space', v); node._ezspRender && node._ezspRender(); })));
  segDet.appendChild(segGrid);

  // ④ 成片编码：可跟随分段；容器始终独立
  const ffmt = String(wval(node, 'final_format', 'mp4') || 'mp4');
  const fcodec = String(wval(node, 'final_codec', 'auto') || 'auto');
  const fbd = String(wval(node, 'final_bit_depth', 'auto') || 'auto');
  const fcs = String(wval(node, 'final_color_space', 'sRGB') || 'sRGB');
  const fcrf = parseInt(wval(node, 'final_crf', 0), 10);
  const ffps = parseInt(wval(node, 'final_fps', 0), 10) || 0;
  const fFollow = !!wval(node, 'final_follow', false);
  const finDet = mkDet('fin', ezT('Final encoding'), false);
  const finGrid = el('div', 'ezsp-grid');
  const fFmt = selectInput(ffmt, [['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WebM']],
    (v) => { setWidget(node, 'final_format', v); node._ezspRender && node._ezspRender(); });
  const fCodec = selectInput(fcodec, [['auto', 'auto'], ['h264', 'H.264'], ['h265', 'H.265'], ['av1', 'AV1']],
    (v) => { setWidget(node, 'final_codec', v); node._ezspRender && node._ezspRender(); });
  const fBd = selectInput(fbd, [['auto', 'auto'], ['8', '8-bit'], ['10', '10-bit']],
    (v) => { setWidget(node, 'final_bit_depth', v); node._ezspRender && node._ezspRender(); });
  const fCs = selectInput(fcs, [['sRGB', 'sRGB'], ['HDR', 'HDR'], ['HDR PQ', 'HDR PQ']],
    (v) => { setWidget(node, 'final_color_space', v); node._ezspRender && node._ezspRender(); });
  const fCrf = numInput(isFinite(fcrf) ? fcrf : 0,
    (v) => { setWidget(node, 'final_crf', v); node._ezspRender && node._ezspRender(); }, 0, 63);
  const fFps = numInput(isFinite(ffps) ? ffps : 0,
    (v) => { setWidget(node, 'final_fps', v); node._ezspRender && node._ezspRender(); }, 0, 120);
  fFps.title = ezT('0 = follow segment fps');
  const followSw = segSwitch(ezT('Follow segment encoding'), fFollow,
    (v) => { setWidget(node, 'final_follow', !!v); syncFollow(); },
    ezT('On'), ezT('Off'));
  followSw.style.gridColumn = 'span 2';
  followSw.title = ezT('Use the segment codec / bit depth / color space / CRF for the final assemble');
  const syncFollow = () => {
    const on = !!followSw._get();
    [fCodec, fBd, fCs, fCrf, fFps].forEach((c) => { c.disabled = on; });
  };
  syncFollow();
  finGrid.appendChild(mkFld(ezT('Format'), fFmt));
  finGrid.appendChild(mkFld(ezT('Encoder'), fCodec));
  finGrid.appendChild(mkFld(ezT('FPS'), fFps));
  finGrid.appendChild(mkFld('CRF', fCrf));
  finGrid.appendChild(mkFld(ezT('Bit depth'), fBd));
  finGrid.appendChild(mkFld(ezT('Color space'), fCs));
  finGrid.appendChild(followSw);
  finDet.appendChild(finGrid);

  [r1, rSw, rBlend, segDet, finDet].forEach((r) => main.appendChild(r));   // 裁尾已移到 TimePlan（会影响规划时长）
}

// ★★ 端口清理（同 TimeLine / TimePlan / MotionContext 的做法，2026-10-15 用户报「第一个端口一堆重叠的」）：
//   Nodes 2.0 会把**widget 型输入**（`save_dir` / `fps` / `clean_vram` / `assemble`）也画成原生
//   socket，全部挤在第一个口上、连标签文字一起叠在一起。
//   ⇒ 从 `node.inputs` 里摘掉，画布上只留**真端口**：`images` / `timeplan` / `audio`。
const KEEP_IN = ["images", "timeplan", "audio"];
const hasLink = (s) => !!(s && (s.link != null || (Array.isArray(s.links) && s.links.length)));
function normalizeInputs(node) {
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    const s = node.inputs[i];
    if (!s || KEEP_IN.indexOf(String(s.name)) >= 0) continue;
    try { node.removeInput(i); } catch (_) { try { node.inputs.splice(i, 1); } catch (_2) {} }
  }
  (node.inputs || []).forEach((s) => { if (s && s.widget) { try { delete s.widget; } catch (_) {} } });
  // 去重（`cloneObject` 按源数组下标覆盖 ⇒ 老工作流少一个口时会让同名口复制成两份）
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
  // ★ `timeplan` 排**最上面**（用户要求）；搬 socket 之前先拍快照，搬完按快照回写 link.target_slot。
  const ix = (node.inputs || []).findIndex((s) => s && String(s.name) === "timeplan");
  if (ix > 0) {
    const cap = ezCaptureSocketLinks(node);
    node.inputs.unshift(node.inputs.splice(ix, 1)[0]);
    ezApplySocketLinks(node, cap);
  }
}
// 老工作流只有 images/audio 两个输出 ⇒ 补上第 3 个 `timeplan` 透传口（**追加在最后**，
// 不动前两个槽位，所以 images/audio 的连线不会错位）。
function ensurePlanOut(node) {
  if ((node.outputs || []).some((s) => s && String(s.name) === "timeplan")) return;
  try { node.addOutput("timeplan", "EZFLEX_TIMEPLAN"); } catch (_) {}
}
// 老工作流只有 3 个输出 ⇒ 末尾补 video（不移动旧槽位）。
function ensureVideoOut(node) {
  if ((node.outputs || []).some((s) => s && String(s.name) === "video")) return;
  try { node.addOutput("video", "VIDEO"); } catch (_) {}
}

function paintPorts(node) {
  try { normalizeInputs(node); } catch (_) {}
  try { ensurePlanOut(node); } catch (_) {}
  try { ensureVideoOut(node); } catch (_) {}
  ((node.inputs || [])).forEach((s) => { try { hideNativeSlotText(s); } catch (_) {} });
  ((node.outputs || [])).forEach((s) => { try { hideNativeSlotText(s); } catch (_) {} });
  try { installEdgeLabels(node, { side: 'both', rootOf: (n) => n._ezspRoot, labelOf: (s) => ((s && s.name) || '') }); } catch (_) {}
}

function mount(node) {
  if (!node || node._ezspSetup) return;
  node._ezspSetup = true;
  inject();
  const shell = el('div', 'ezsp-shell');
  const root = el('div', 'ezsp-root');
  // 一行一个控件 ⇒ 纵向排列（不再有工具条 / 底部状态行）
  const main = el('div', 'ezsp-rows');
  root.appendChild(main);
  shell.appendChild(root);
  node._ezspRoot = shell;
  const rerender = () => { render(node, main); paintPorts(node); };
  node._ezspRender = rerender;
  rerender();

  const widget = node.addDOMWidget("SegmentPanel", "ezsp__" + Math.random().toString(36).slice(2), shell, {
    serialize: false, hideOnZoom: false, canvasOnly: !(window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()),
    margin: 4, getMinHeight: () => MIN_H, getValue: () => "{}", setValue: () => {},
  });
  makeDomWidgetHitThrough(widget.element || shell);
  try { node.widgets_start_y = 0; } catch (_) {}
  try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
  installResizeHandles(node, shell);
  try {
    ezApplyDefaultSize(node, MIN_W, MIN_H);
  } catch (_) {}
  hideWidgets(node);
  forceShell(node);
  // ★ 自愈：宿主 widget 可能被重建（切图 / 折叠 / 切 tab）⇒ 重挂 + 短时主动轮询（到期自停）
  let retry = 0;
  (function again() {
    forceShell(node);
    try { hideWidgets(node); node._ezspRender && node._ezspRender(); } catch (_) {}
    if (retry < 10) { retry += 1; setTimeout(again, 120); }
  })();
}

function hook(nt) {
  if (!nt || nt.__ezspHooked) return;
  nt.__ezspHooked = true;
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
    try { if (!this._ezspSetup) mount(this); } catch (_) {}
    try { normalizeWidgets(this); } catch (_) {}
    try { hideWidgets(this); } catch (_) {}
    try { if (this._ezspRender) this._ezspRender(); else paintPorts(this); } catch (_) {}
    return r;
  };
  const pcc = nt.prototype.onConnectionsChange;
  nt.prototype.onConnectionsChange = function () {
    const r = pcc ? pcc.apply(this, arguments) : undefined;
    try { if (this._ezspRender) this._ezspRender(); else paintPorts(this); } catch (_) {}
    return r;
  };
  const pr = nt.prototype.onRemoved;
  nt.prototype.onRemoved = function () {
    const r = pr ? pr.apply(this, arguments) : undefined;
    try { if (this._ezspRoot) this._ezspRoot.remove(); } catch (_) {}
    this._ezspSetup = false;
    return r;
  };
}

onLocaleChange(() => {
  try {
    const g = (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
    ((g && g._nodes) || []).forEach((n) => {
      if (nodeTypeOf(n) !== SP) return;
      try { n._ezspRender && n._ezspRender(); } catch (_) {}
    });
  } catch (_) {}
});

app.registerExtension({
  name: "EzFlex.SegmentPanel",
  async beforeRegisterNodeDef(nt, nd) {
    if (nd && nd.name === SP) hook(nt);
  },
  nodeCreated(n) {
    if (nodeTypeOf(n) !== SP) return;
    // ★ 分开 try：面板挂失败也必须把端口清理/迁移做掉
    try { mount(n); } catch (_) {}
    try { paintPorts(n); } catch (_) {}
  },
});
