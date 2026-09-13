// EzFlex-PromptHelper 提示词卡片合并节点。
// 前端面板：完整富文本编辑器（卡片列表 + 格式工具条 + 颜色/字号/缩进 + 查找替换 + 取色器 + 媒体引用芯片）
// + 「设置」弹窗（通用 / 规则 / API / TextGenerate / llama / 路径）+ 「卡片管理」弹窗（userdata/prompts 存取卡片）。
// 固定输入 clip；动态「综合媒体」输入（红色 ANY，可接图像/视频/音频/3D 模型等，连接后自动补一个空槽）；
// 动态输入 = 卡片数 1:1（card_in_1..N，按顺序链接到卡片，连接后对应卡片变灰）；
// 输出固定「合并提示词」+ 动态卡片输出 = 卡片数 1:1。
// 复用 ModelsCombo/ParamPreset/PreviewAny 动态端口经验：卡片增删/排序后复用 socket、回写 slot、
// 类 RETURN_TYPES/RETURN_NAMES 固定成「最大卡片数 + 1」（全 STRING），不按实例收缩 —— 见 __init__.py 的说明。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  NODE_TYPES, registerNode, unregisterNode, nodeTypeOf,
  configWidget, writeConfig, readConfig, installResizeHandles, makeDomWidgetHitThrough, uiConfirm, uiPrompt, TYPE_ICONS, makeAudioPlayer,
  scheduleOnRedraw, pumpFrames,
} from "./ezflex_service.js";
import { ezT, onLocaleChange } from "./ezflex_i18n.js";
import {
  mediaKeyOf, mediaIndex, indexTargets, indexTargetById, activeIndexTarget,
  mediaSizeText, mediaFormatOf, startIndexWatcher, onIndexChange, nodeInputMedia,
  refreshIndexNow, refreshIndexSoon,
} from "./ezflex_media_index.js";

const NODE = NODE_TYPES.PROMPT_HELPER;
const MAX_CARDS = 32;
const MAX_MEDIA = 16;
const MEDIA_PORT_COLOR = '#d94848';
// 加载标记：用于确认浏览器实际加载的是哪一版（改动本文件时请更新）
// 轻量提示条：不用 window.alert（原生模态抢焦点，关掉后 ComfyUI 的 DOM 面板会短暂点不动）
function phTip(msg, ms) {
  try {
    const t = document.createElement('div');
    t.textContent = String(msg == null ? '' : msg);
    t.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:100120;max-width:70vw;background:rgba(24,30,42,.92);color:#fff;font-family:Inter,sans-serif;font-size:12px;line-height:1.5;padding:8px 14px;border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.28);pointer-events:none;white-space:pre-wrap;';
    document.body.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, ms || 2800);
  } catch (_) {}
}

const PH_BUILD = '2026-09-13-i18nv16';
console.log('[PromptHelper] module loaded · build ' + PH_BUILD);

// ===== 分层弹出的关闭协调：点击外层只关最上面一层；拖动·松开不关 =====
const _phLayers = [];
let _phClosedEl = null;   //  本次点击已经关掉的那一层（下层弹窗看到它就不再自己关，避免一次点击连关两层）
let _phDownOpen = new Set();
function phLayerPush(el) { if (el && !_phLayers.includes(el)) _phLayers.push(el); }
function phLayerIsOpen(el) { return !!(el && el.classList && (el.classList.contains('active') || el.classList.contains('open'))); }
// 受协调器自动跟踪的弹出层：下拉菜单/字体列表/颜色面板 + 图片查看器/取色器/查找替换。
// 有了它们，点「图片查看器 / 取色器 / 查找替换」的背景时只关自己那一层，不会连带关掉下面的卡片弹窗或总体编辑弹窗。
const _PH_POPUP = ['eph-dd-menu', 'eph-tools-dropdown', 'eph-font-list', 'eph-color-dropdown', 'eph-mv', 'eph-picker', 'eph-fr', 'eph-rb', 'eph-ctx'];
let _phDown = { x: 0, y: 0 }, _phDownTarget = null;
document.addEventListener('pointerdown', (e) => { _phDown.x = e.clientX; _phDown.y = e.clientY; _phClosedEl = null; _phDownTarget = e.target; _phDownOpen = new Set(_phLayers); }, true);
document.addEventListener('pointerup', (e) => {
  if (Math.max(Math.abs(e.clientX - _phDown.x), Math.abs(e.clientY - _phDown.y)) > 6) return;   // 拖动松开不关
  const t = e.target;
  for (let i = _phLayers.length - 1; i >= 0; i--) {
    const el = _phLayers[i];
    if (!_phDownOpen.has(el)) continue;                     //  本次刚打开的层（点开关按钮）不立刻关
    const open = phLayerIsOpen(el);
    if (!el || !el.isConnected) { _phLayers.splice(i, 1); continue; }
    if (!open) { _phLayers.splice(i, 1); continue; }
    if (el.classList.contains('ph-dock')) continue;   // 平铺面板：点外侧不关，只能 ✕/取消 关
    if (el.contains(t) && t !== el) break;               // 点在层内内容 → 保留这一层及以下
    el.classList.remove('active'); el.classList.remove('open'); _phLayers.splice(i, 1); _phClosedEl = el;
    // 该层自己的收尾（如引用媒体窗口要停掉里面正在播的视频/音频并关掉放大预览）
    try { if (typeof el._phOnClose === 'function') el._phOnClose(); } catch (_) {}
    break;   //  只关最上面这一层
    }
}, true);
let _phWatchStarted = false;
function phLayerWatch() {
  if (_phWatchStarted) return; _phWatchStarted = true;
  const ob = new MutationObserver((muts) => {
    muts.forEach((m) => { const el = m.target; if (!el || el.nodeType !== 1) return; if (!/(^|\s)eph-/.test(el.className || '')) return; if (!_PH_POPUP.some((c) => el.classList.contains(c))) return; const open = el.classList.contains('active') || el.classList.contains('open'); if (open) { if (!_phLayers.includes(el)) _phLayers.push(el); } else { const i = _phLayers.indexOf(el); if (i >= 0) _phLayers.splice(i, 1); } });
  });
  ob.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
}
phLayerWatch();

// ===== 平铺模式：卡片弹窗 / 总体编辑 / 引用媒体 三个浮层可切成右侧面板 =====
// 弹窗模式（默认）：全屏遮罩，点外侧关闭，开着就不能操作画布上其他节点。
// 平铺模式：只占右侧一块，标题栏可拖动；点外侧不关，只能 ✕ / 取消 关 —— 可以一边看引用媒体一边操作别的节点。
const _phDockMem = {};      // 各浮层拖动后的落点（本次会话内记住；尺寸默认按窗口比例算）
const PH_DOCK_ORDER = ['eph-modal', 'eph-all', 'eph-rb'];   // 两个面板同时开着时，默认位置按这个顺序错开
const PH_DOCK_LS = 'ezflex.phDockMode';   // 全局偏好：新节点默认沿用上次选的模式（节点 config 里的 ui.dock 优先）
function phDockPref() { try { return window.localStorage.getItem(PH_DOCK_LS) === '1'; } catch (_) { return false; } }
// 层叠：放在画布/节点之上，但**低于 ComfyUI 自己的菜单与节点列表弹窗**（前端 z-index 分布 999~99999），
// 否则平铺面板会挡住双击打开的节点列表和顶部工具栏。每次应用/点标题栏在本段内抬到最上。
const PH_DOCK_Z_BASE = 900, PH_DOCK_Z_MAX = 998;
let _phDockZ = PH_DOCK_Z_BASE;
function phDockRaise() { _phDockZ = (_phDockZ >= PH_DOCK_Z_MAX) ? PH_DOCK_Z_BASE : _phDockZ + 1; return _phDockZ; }
function phDockOn(node) {
  if (!node) return false;
  try { const ui = stateFor(node).ui; return !!(ui && ui.dock); } catch (_) { return false; }
}
function phDockKey(ov) { return String(ov.className || '').split(' ')[0] || 'eph'; }
// 画布变换（取法与 modelscombo 一致）：screen = (画布坐标 + offset) * scale，再加画布元素自身的页面偏移
function phDockXform() {
  let canvas = null;
  try { canvas = (app && app.canvas) || null; } catch (_) { canvas = null; }
  if (!canvas || !canvas.ds) return null;
  // LGraphCanvas 自身没有 getBoundingClientRect —— 必须拿它包着的 canvas 元素（ds.element / .canvas）
  const el = canvas.canvas || canvas.canvasEl || canvas.ds.element || null;
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  let rect = null; try { rect = el.getBoundingClientRect(); } catch (_) { rect = null; }
  if (!rect) return null;
  return { rect: rect, scale: canvas.ds.scale || 1, off: canvas.ds.offset || [0, 0] };
}
// 把想要的屏幕位置换算成画布坐标存下来（拿不到画布就退回屏幕坐标）
function phDockAnchorTo(mem, sx, sy) {
  const t = phDockXform();
  if (t) { mem.cx = (sx - t.rect.left) / t.scale - t.off[0]; mem.cy = (sy - t.rect.top) / t.scale - t.off[1]; }
  mem.sx = sx; mem.sy = sy;
}
// 按当前画布变换把面板摆到屏幕上（画布平移/缩放都跟着动，跟节点一样「放在哪就在哪」）
function phDockPlace(ov, mem) {
  const t = phDockXform();
  const k = (t && t.scale) || 1;
  if (t) { mem.sx = t.rect.left + (mem.cx + t.off[0]) * t.scale; mem.sy = t.rect.top + (mem.cy + t.off[1]) * t.scale; }
  // 尺寸跟着画布缩放一起缩（跟节点一样）；transform-origin 左上角 → 位置锚点不动
  if (mem.k !== k) { mem.k = k; ov.style.transform = 'scale(' + k + ')'; ov.style.transformOrigin = '0 0'; }
  // 位置不夹取：允许挪到视窗外（双击标题栏回默认位）
  ov.style.left = Math.round(mem.sx) + 'px';
  ov.style.top = Math.round(mem.sy) + 'px';
}
// 默认落点（画布坐标）：卡片编辑 / 总体编辑 → PromptHelper 右侧隔 40px（彼此错开一点）；引用媒体 → 节点下方
function phDockDefaultAnchor(ov, node) {
  const n = node || ov._dockNode || ov._node;
  if (!n || !n.pos || !n.size) return null;
  const gap = 40;
  if (phDockKey(ov) === 'eph-rb') return [n.pos[0], n.pos[1] + n.size[1] + gap];
  return [n.pos[0] + n.size[0] + gap, n.pos[1] + Math.max(0, PH_DOCK_ORDER.indexOf(phDockKey(ov))) * 36];
}
// 面板尺寸变了要重排页签滑块（默认/优化 那个胶囊），不然它还停在旧宽度上，得点一下才正
function phDockThumbs(ov) {
  if (ov === _editModal) { try { moveTabThumb(); } catch (_) {} return; }
  if (ov === _allModal) { try { moveAllTabThumb(); } catch (_) {} }
}
// 画布平移/缩放时把所有开着的平铺面板一起挪（由 ezflex_service 的 setDirty/指针/滚轮泵帧唤醒）
function phDockTrack() {
  // 平铺的引用媒体面板开着时，顺带让编号引擎按需重算（签名没变直接返回 → 零额外开销、无新定时器）
  const rb = _refBrowser;
  if (rb && rb.classList.contains('active') && rb.classList.contains('ph-dock')) { try { refreshIndexSoon(); } catch (_) {} }
  const list = [_editModal, _allModal, _refBrowser];
  for (let i = 0; i < list.length; i++) {
    const ov = list[i];
    if (!ov || !ov.classList.contains('ph-dock') || !ov.classList.contains('active')) continue;
    const mem = _phDockMem[phDockKey(ov)];
    if (mem && mem.cx !== undefined) phDockPlace(ov, mem);
  }
}
// 各浮层的默认尺寸（窗口比例）：卡片弹窗矮一半、引用媒体小一号
const PH_DOCK_DEFAULT = {
  'eph-modal': { wf: 0.42, hf: 0.30, minW: 320, minH: 200 },
  'eph-rb': { wf: 0.32, hf: 0.50, minW: 300, minH: 220 },
};
// 默认尺寸/数值语义改了就把这个 +1：旧 config 里的 dockMem 尺寸作废一次，让新默认值生效
const PH_DOCK_SIZE_V = 2;
function phDockApply(ov, node) {
  if (!ov) return;
  if (node) ov._dockNode = node;
  const on = phDockOn(ov._dockNode || ov._node);
  ov.classList.toggle('ph-dock', on);
  if (!on) { ov.style.left = ov.style.top = ov.style.right = ov.style.bottom = ov.style.width = ov.style.height = ''; ov.style.zIndex = ''; ov.style.transform = ''; ov.style.transformOrigin = ''; return; }
  const mem = _phDockMem[phDockKey(ov)] || (_phDockMem[phDockKey(ov)] = {});
  const k0 = (phDockXform() || {}).scale || 1;
  // 尺寸存**画布单位**：滚轮缩放时面板跟节点一样一起缩；首次打开按窗口比例换算出来
  if (!mem.w || !mem.h) {
    const d = PH_DOCK_DEFAULT[phDockKey(ov)];
    if (d) { mem.w = Math.max(d.minW, Math.round(window.innerWidth * d.wf)) / k0; mem.h = Math.max(d.minH, Math.round(window.innerHeight * d.hf)) / k0; }
    else { mem.w = Math.max(320, Math.round(window.innerWidth * 0.42)) / k0; mem.h = Math.max(240, Math.round(window.innerHeight * 0.6)) / k0; }
  }
  const ord = Math.max(0, PH_DOCK_ORDER.indexOf(phDockKey(ov)));   // 错开默认位置，露出下面那个面板的拖动把手
  // 只在**没有记忆位置**时回「PromptHelper 右侧 / 下方」默认落点；拖过 / 刷新重启恢复的都保持原位置（双击标题栏才复位）
  const def = phDockDefaultAnchor(ov, node);
  if (mem.cx === undefined) {
    if (def) { mem.cx = def[0]; mem.cy = def[1]; }
    else phDockAnchorTo(mem, window.innerWidth - mem.w * k0 - 24 - ord * 44, 96);
  }
  ov.style.right = 'auto'; ov.style.bottom = 'auto';
  ov.style.width = mem.w + 'px'; ov.style.height = mem.h + 'px'; ov.style.zIndex = String(phDockRaise());
  phDockPlace(ov, mem);
  phDockInstall(ov);
  scheduleOnRedraw(phDockTrack);   // 画布平移/缩放时面板跟着走（Set 去重，只装一次）
  requestAnimationFrame(() => phDockThumbs(ov));   // 面板刚铺开/换模式：页签滑块按新宽度重排一次
  try { phDockRemember(ov._dockNode || ov._node); } catch (_) {}   // 记「开着」+ 当前尺寸/位置（放在最后：此时 mem 已初始化）
}
function phDockInstall(ov) {   // 平铺面板的两种交互：标题栏拖动 + 右下角缩放，都只装一次
  if (ov._dockUi) return;
  const head = ov.querySelector('.eph-modal-hd, .eph-all-hd, .eph-rb-hd');
  if (!head) return;
  ov._dockUi = true;
  const grip = el('span', 'eph-dock-grip'); grip.textContent = '⠿'; grip.title = ezT('Drag to move panel (double-click title bar to restore default position)');
  head.insertBefore(grip, head.firstChild);
  let on = false, sx = 0, sy = 0, ox = 0, oy = 0;
  const save = () => { const r = ov.getBoundingClientRect(); const m = _phDockMem[phDockKey(ov)] || (_phDockMem[phDockKey(ov)] = {}); const k = (phDockXform() || {}).scale || 1; m.w = r.width / k; m.h = r.height / k; phDockAnchorTo(m, r.left, r.top); try { phDockRemember(ov._dockNode || ov._node); } catch (_) {} };   // 拖完/缩完立刻落盘（否则刷新时刚调好的位置尺寸会丢）
  head.addEventListener('pointerdown', (e) => {
    if (!ov.classList.contains('ph-dock') || e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button,input,select,.eph-dd-menu,.eph-tools-dropdown,.eph-color-dropdown,.eph-font-list')) return;
    const r = ov.getBoundingClientRect();
    on = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    ov.style.right = 'auto'; ov.style.bottom = 'auto'; ov.style.left = ox + 'px'; ov.style.top = oy + 'px';
    ov.style.zIndex = String(phDockRaise());
    try { head.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!on) return;
    // 不夹取：可以拖到视窗外（双击标题栏回默认位）
    ov.style.left = (ox + e.clientX - sx) + 'px';
    ov.style.top = (oy + e.clientY - sy) + 'px';
    e.preventDefault();
  });
  const stop = () => { if (!on) return; on = false; save(); };
  head.addEventListener('pointerup', stop);
  head.addEventListener('pointercancel', stop);
  // 双击标题栏：回默认位置（面板允许挪到视窗外，靠这个找回来）
  head.addEventListener('dblclick', () => {
    if (!ov.classList.contains('ph-dock')) return;
    const m = _phDockMem[phDockKey(ov)];
    if (m) { m.cx = undefined; m.cy = undefined; }
    phDockApply(ov);
  });
  // 右下角缩放：跟 LiteGraph 节点一个用法（只改尺寸，不改结构）
  const size = el('div', 'eph-dock-size'); size.title = ezT('Drag to resize panel');
  ov.appendChild(size);
  let rz = false, rx = 0, ry = 0, rw = 0, rh = 0, rl = 0, rt = 0, rk = 1;
  size.addEventListener('pointerdown', (e) => {
    if (!ov.classList.contains('ph-dock') || e.button !== 0) return;
    const r = ov.getBoundingClientRect();
    rk = (phDockXform() || {}).scale || 1;
    rz = true; rx = e.clientX; ry = e.clientY; rw = r.width / rk; rh = r.height / rk; rl = r.left; rt = r.top;
    ov.style.right = 'auto'; ov.style.bottom = 'auto'; ov.style.left = rl + 'px'; ov.style.top = rt + 'px';
    ov.style.zIndex = String(phDockRaise());
    try { size.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
  });
  size.addEventListener('pointermove', (e) => {
    if (!rz) return;
    // 最小尺寸按**画布单位**卡（跟节点一样：逻辑最小尺寸固定，屏幕上随缩放变）—— 否则缩小极限会随缩放漂
    const w = Math.max(320, Math.min(rw + (e.clientX - rx) / rk, (window.innerWidth - rl - 8) / rk));
    const h = Math.max(240, Math.min(rh + (e.clientY - ry) / rk, (window.innerHeight - rt - 8) / rk));
    ov.style.width = w + 'px'; ov.style.height = h + 'px';
    phDockThumbs(ov);   // 跟着新宽度重排页签滑块
    e.preventDefault();
  });
  const rzStop = () => { if (!rz) return; rz = false; save(); };
  size.addEventListener('pointerup', rzStop);
  size.addEventListener('pointercancel', rzStop);
}
// 面板头部那颗按钮：弹窗 ⇄ 平铺（状态写在节点 config 的 ui.dock）
function phDockSyncBtn(node) {
  const b = node && node._ezDockBtn;
  if (!b) return;
  const on = phDockOn(node);
  b.textContent = on ? '🗗 ' + ezT('Popup') : '⧉ ' + ezT('Dock');
  b.title = on ? ezT('Current: docked panel (right-side overlay, draggable; closes only via ✕/Cancel, other nodes stay usable) → click to switch back to popup')
               : ezT('Current: popup mode (full-screen backdrop, click outside to close) → click to switch to the docked panel (does not block other nodes)');
  b.classList.toggle('on', on);
}
// 平铺模式下「引用媒体」面板一直开着：画布上新连/断开素材要自己跟上。
// 走编号引擎已有的变更通知（Lnode 钩子 → markIndexDirty → refreshIndex → 广播），不加轮询/定时器；
// 弹窗模式保持原样（打开时刷新），只有平铺模式做这个差异。
function phRefAutoRefresh() {
  const m = _refBrowser;
  if (!m || !m.classList.contains('active') || !m.classList.contains('ph-dock')) return;
  try { refreshRefBrowser(); } catch (_) {}
}
onIndexChange(phRefAutoRefresh);
function phDockToggle(node) {
  const st = stateFor(node);
  st.ui = st.ui || {};
  st.ui.dock = !st.ui.dock;
  try { window.localStorage.setItem(PH_DOCK_LS, st.ui.dock ? '1' : '0'); } catch (_) {}   // 下次新建节点也按这个来
  syncToConfig(node);
  phDockSyncBtn(node);
  [_editModal, _allModal, _refBrowser].forEach((ov) => { if (ov) phDockApply(ov, ov._dockNode || ov._node || node); });
}
// ===== 平铺状态持久化（刷新/重启后保持打开）=====
// 记进节点 config 的 ui.dockOpen / ui.dockMem：三个浮层谁开着（卡片弹窗还记是哪张卡）+ 面板尺寸。
// 只在平铺态记录（弹窗态点外侧即关，没有"一直开着"的语义）。
function phDockRemember(node) {
  if (!node) return;
  const st = stateFor(node);
  st.ui = st.ui || {};
  const on = (ov) => !!(ov && ov.classList.contains('active') && ov._node === node);
  const cardOn = on(_editModal);
  st.ui.dockOpen = { card: cardOn ? (st.editingId || null) : null, all: on(_allModal), ref: on(_refBrowser) };
  st.ui.dockSizeV = PH_DOCK_SIZE_V;
  const mems = {};
  PH_DOCK_ORDER.forEach((k) => { const m = _phDockMem[k]; if (m && m.w && m.h) mems[k] = { w: m.w, h: m.h, cx: m.cx, cy: m.cy }; });
  if (Object.keys(mems).length) st.ui.dockMem = mems;
  syncToConfig(node);
}
// 载入后恢复：config 要等 onConfigure 才到位，所以从 setupNode 起按 250ms 重试几次。
function phDockRestore(node) {
  const st = stateFor(node);
  const rec = st.ui && st.ui.dockOpen;
  if (!rec) return false;                       // config 还没读进来 → 继续重试
  node._ezDockRestored = true;
  if (!phDockOn(node)) return true;             // 当前不是平铺模式：不恢复
  const mems = (st.ui && st.ui.dockMem) || {};
  const sizeOk = st.ui && st.ui.dockSizeV === PH_DOCK_SIZE_V;   // 尺寸版本不符就别用旧值（默认尺寸改过）
  Object.keys(mems).forEach((k) => { const m = mems[k]; if (!m) return; const t = _phDockMem[k] || (_phDockMem[k] = {}); if (sizeOk) { if (m.w) t.w = m.w; if (m.h) t.h = m.h; } if (m.cx !== undefined) { t.cx = m.cx; t.cy = m.cy; } });
  const card = rec.card ? (st.cards || []).find((c) => c.id === rec.card) : null;
  if (rec.all) { try { openAllEditor(node); } catch (_) {} }
  if (card) { try { openEditModal(node, card.id); } catch (_) {} }
  if (rec.ref) {
    const ed = (_editModal && _editModal._node === node && _editModal.classList.contains('active') && _editModal._editor)
      || (_allModal && _allModal._node === node && _allModal.classList.contains('active') && _allModal._ed) || null;
    if (ed) { try { openRefBrowser(node, ed, card || null); } catch (_) {} }
  }
  return true;
}
function phDockRestoreSoon(node) {
  if (!node || node._ezDockRestoring) return;
  node._ezDockRestoring = true;
  let n = 0;
  const tick = () => {
    if (node._ezDockRestored) return;
    try { if (phDockRestore(node)) return; } catch (_) {}
    n += 1; if (n < 8) setTimeout(tick, 250);
  };
  setTimeout(tick, 400);
}

const CSS = `
.eph-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.eph-shell .eph-root{pointer-events:auto;}
.eph-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:#1a1a2e;background:#fff;border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.eph-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.eph-hd{display:flex;gap:6px;align-items:center;flex-wrap:nowrap;min-width:0;} /* 顶部工具栏单行不换行 */
.eph-btn{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:#1f2937;font-family:inherit;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;height:30px;line-height:1;}
.eph-btn:hover{background:#edf2fa;}
.eph-btn.success{background:#ecfdf3;border-color:#a7f0c6;color:#065f46;}
.eph-btn.success:hover{background:#d1fae5;}
.eph-btn.primary{background:#1a1a2e;border-color:#1a1a2e;color:#fff;}
.eph-btn.primary:hover{background:#2b3a4a;}
.eph-btn.danger{background:#fef2f2;border-color:#fecaca;color:#991b1b;}
.eph-btn.danger:hover{background:#fee2e2;}
.eph-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;}
.eph-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:16px;}
.eph-card{display:flex;align-items:center;gap:10px;background:#fbfcfe;border:1px solid #eef2f8;border-radius:10px;padding:9px 10px;flex-wrap:nowrap;cursor:pointer;}
.eph-card.dragging{opacity:.4;}
.eph-handle{cursor:grab;color:#8a99ae;font-size:14px;line-height:1.6;padding:0 2px;}
.eph-handle:hover{color:#1a1a2e;}
.eph-index{font-size:12px;font-weight:600;color:#5f6b7a;width:24px;text-align:center;flex:0 0 auto;}
.eph-title{flex:1 1 90px;min-width:70px;}
.eph-preview{flex:1 1 auto;min-width:0;font-size:11px;color:#5f6b7a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eph-time{background:#eef2f7;color:#5f6b7a;font-size:10px;padding:0 8px;border-radius:100px;line-height:20px;flex:0 0 auto;min-width:50px;text-align:left;}
.eph-del{background:transparent;border:none;color:#b7c1cf;font-size:15px;cursor:pointer;padding:1px 4px;flex:0 0 auto;}
.eph-del:hover{color:#e34d4d;background:#fdecec;border-radius:6px;}
.eph-ph{height:0;border-top:3px solid #2b3a4a;border-radius:2px;margin:1px 0;opacity:.9;box-shadow:0 1px 6px rgba(43,58,74,.35);}
.eph-ph.hidden{display:none;}

/* 卡片：样式化标题  + 链接后变灰 */
.eph-ctitle{flex:0 0 30%;min-width:0;display:inline-flex;align-items:center;gap:6px;max-width:30%;}
.eph-ctitle-input{display:inline-block;min-width:24px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:none;border-radius:8px;background:transparent;font:600 12px Inter,sans-serif;color:#1a1f2b;outline:none;padding:2px 4px;cursor:text;text-align:left;flex:1 1 auto;min-width:0;}
.eph-ctitle-input:empty::before{content:attr(data-ph);color:#c4cdda;}  /* 空标题占位 */
.eph-badge{font-size:9px;font-weight:480;color:#fff;background:#5f6b7a;padding:0 6px;border-radius:100px;line-height:15px;white-space:nowrap;flex:0 0 auto;}
.eph-badge-opt{background:#2563eb;}
.eph-preview{flex:1 1 auto;min-width:0;font-size:11px;color:#8a9aa8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;}
.eph-card.linked{opacity:.55;background:#f3f5f9;border-color:#e2e8f0;}
.eph-card.linked .eph-title{opacity:.5;}

/* 黑框  socket 标签（仿 ModelsCombo installOutsideLabels） */
.eph-socket-label{position:fixed;z-index:40;pointer-events:none;background:rgba(16,22,32,.5);color:#e8eef6;font-size:9px;line-height:1;padding:2px 6px;border-radius:3px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;user-select:none;display:inline-flex;align-items:center;box-shadow:0 1px 4px rgba(0,0,0,.25);}
.eph-socket-label .eph-socket-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;margin-right:5px;border:1px solid rgba(255,255,255,.35);}

/* 编辑器弹窗 */
.eph-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:99999;background:rgba(0,0,0,.35);}
.eph-modal.active{display:flex;}
.eph-modal-box{background:#fff;border-radius:14px;padding:0 0 12px;width:94%;max-width:880px;max-height:88vh;display:flex;flex-direction:column;gap:0;box-shadow:0 24px 80px rgba(0,0,0,.22);font-family:Inter,sans-serif;box-sizing:border-box;}
.eph-modal-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #edf2f8;}
.eph-modal-hd-right{display:flex;align-items:center;gap:8px;}
.eph-modal-full{height:26px;padding:0 10px;font-size:12px;}
.eph-modal.full .eph-modal-box{width:100%;max-width:none;height:100%;max-height:none;border-radius:0;}
.eph-modal.full .eph-editor{max-height:none;}
.eph-modal-hd b{font-size:14px;color:#0f141f;}
.eph-modal-close{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:3px 11px;font-size:13px;cursor:pointer;font-family:inherit;color:#5f6b7a;}
.eph-modal-close:hover{background:#edf2fa;}
.eph-btn.on{background:#eef2ff;border-color:#c7d2fe;color:#3730a3;}
/* ===== 平铺模式：卡片弹窗 / 总体编辑 / 引用媒体 三个浮层改成右侧可拖动面板 =====
   弹窗模式（默认）：全屏遮罩，点外侧关闭；平铺模式：只占自己那一块，点外侧不关，只能 ✕/取消 关，
   所以能一边开面板（尤其「引用媒体」）一边操作画布上的其他节点。 */
.eph-modal.ph-dock,.eph-all.ph-dock,.eph-rb.ph-dock{inset:auto;background:transparent;align-items:stretch;justify-content:stretch;overflow:hidden;box-sizing:border-box;}
.eph-modal.ph-dock.active,.eph-all.ph-dock.active,.eph-rb.ph-dock.active{display:flex;}
.eph-modal.ph-dock .eph-modal-box,.eph-all.ph-dock .eph-all-box,.eph-rb.ph-dock .eph-rb-box{width:100%;height:100%;max-width:100%;max-height:100%;box-sizing:border-box;overflow:auto;border-radius:12px;box-shadow:none;}
.eph-modal.ph-dock .eph-modal-body,.eph-all.ph-dock .eph-all-editor,.eph-rb.ph-dock .eph-rb-body{flex:1 1 auto;min-height:0;}   /* 缩小时先吃中间那块，页脚/工具条不被顶出去 */
.eph-modal.ph-dock .eph-modal-hd,.eph-all.ph-dock .eph-all-hd,.eph-rb.ph-dock .eph-rb-hd{cursor:move;user-select:none;-webkit-user-select:none;}
.eph-modal.ph-dock .eph-modal-full,.eph-all.ph-dock .eph-all-full{display:none;}
.eph-dock-grip{display:none;flex:0 0 auto;color:#9aa7b5;font-size:13px;line-height:1;cursor:move;letter-spacing:1px;}
.ph-dock .eph-dock-grip{display:inline-flex;}   /* 拖动把手只在平铺模式露出来 */
.eph-dock-size{display:none;position:absolute;right:2px;bottom:2px;width:16px;height:16px;z-index:6;cursor:nwse-resize;}
.eph-dock-size::after{content:'';position:absolute;right:2px;bottom:2px;width:9px;height:9px;border-right:2px solid #aab4c2;border-bottom:2px solid #aab4c2;border-radius:1px;}
.eph-dock-size:hover::after{border-color:#5f6b7a;}
.ph-dock .eph-dock-size{display:block;}   /* 右下角拖拽缩放（仿节点） */
.eph-modal-body{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;overflow:auto;padding:10px 14px;}
.eph-modal-ft{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 16px 0;border-top:1px solid #edf2f8;}
.eph-btn-cancel{background:#f1f4fa;border:1px solid #e2e8f0;color:#4d5b6d;}
.eph-btn-save{background:#1a1a2e;border:1px solid #1a1a2e;color:#fff;}

/* 编辑器工具条 */
.eph-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px;background:#f8fafc;border-bottom:1px solid #e6edf7;}
/* 工具条收起/展开：自己占一行（工具条与「默认/优化」行中间），无底边小三角；
   平时隐藏、鼠标悬停才显形；展开态箭头朝上（点它收起），收起态朝下（点它展开）。 */
.eph-tb-toggle{display:flex;align-items:center;justify-content:center;height:10px;flex:0 0 auto;cursor:pointer;opacity:0;transition:opacity .15s;background:transparent;margin:0;}
.eph-modal-body > .eph-tb-toggle{margin:-8px 0;}   /* 吃掉 .eph-modal-body 的 8px gap，夹在工具条与页签之间 */
.eph-all-box > .eph-tb-toggle{margin:-6px 0 0;}   /* 吃掉 .eph-tabs 的 6px margin-bottom，夹在页签与工具条之间 */
.eph-tb-toggle:hover{opacity:1;background:rgba(43,58,74,.06);}
.eph-tb-toggle i{display:block;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:6px solid #8a9aa8;transition:transform .15s;}
.eph-toolbar.collapsed,.eph-all-toolbar.collapsed{display:none;}
.eph-tb-group{display:flex;align-items:center;gap:2px;position:relative;}
.eph-tb-btn{width:30px;height:30px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;border-radius:7px;color:#1a1a2e;cursor:pointer;font-size:13px;font-family:inherit;}
.eph-tb-btn:hover{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08);}
.eph-font-combo{display:flex;border:none;background:#fff;border-radius:8px;overflow:hidden;height:30px;box-shadow:0 1px 4px rgba(0,0,0,.06);}
.eph-font-combo input{border:none;width:44px;text-align:center;outline:none;font-size:12px;color:#1a1a2e;background:transparent;}
.eph-font-combo button{border:none;background:transparent;width:22px;cursor:pointer;position:relative;}
.eph-font-combo button::after{content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-70%);border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #94a3b8;}
.eph-font-list{position:absolute;top:34px;z-index:200;background:#fff;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.12);max-height:240px;overflow-y:auto;width:96px;display:none;padding:4px;}
.eph-font-list.active{display:block;}
.eph-font-list li{list-style:none;padding:7px;cursor:pointer;font-size:12px;text-align:center;border-radius:6px;}
.eph-font-list li:hover{background:#f1f4fa;}
.eph-color-btn{display:flex;align-items:center;gap:4px;padding:5px;border-radius:8px;cursor:pointer;border:none;background:transparent;}
.eph-color-btn:hover{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08);}
.eph-icon-a{font-weight:900;font-size:15px;font-family:sans-serif;position:relative;}
.eph-icon-a::after{content:'';position:absolute;left:2px;right:2px;bottom:1px;height:3px;background:#ef4444;border-radius:2px;}
.eph-icon-hl{position:relative;display:flex;flex-direction:column;align-items:center;}
.eph-icon-hl::before{content:'';width:3px;height:13px;background:#64748b;transform:rotate(45deg);position:absolute;top:-4px;}
.eph-icon-hl::after{content:'';width:13px;height:5px;background:#fde047;margin-top:2px;border-radius:2px;}
.eph-arrow-down{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #94a3b8;margin-left:2px;}
.eph-color-dropdown{position:absolute;top:34px;left:0;z-index:200;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.1);padding:12px;width:210px;display:none;}
.eph-color-dropdown.active{display:block;}
.eph-color-title{font-size:10px;font-weight:500;color:#94a3b8;margin:8px 0 6px;letter-spacing:.5px;text-transform:uppercase;}
.eph-color-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:4px;margin-bottom:8px;}
.eph-color-grid-sm{grid-template-columns:repeat(5,1fr);}
.eph-color-item{width:100%;aspect-ratio:1/1;border-radius:4px;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);transition:.1s;}
.eph-color-item:hover{transform:scale(1.1);}
.eph-no-color{background:#fff;background-image:linear-gradient(to top right,transparent calc(50% - 1px),#ef4444,transparent calc(50% + 1px));}
.eph-dropdown-btn{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:12px;color:#1a1a2e;background:#f1f4fa;margin-top:6px;font-weight:500;border:none;width:100%;font-family:inherit;}
.eph-dropdown-btn:hover{background:#e6edf7;}
.eph-dropdown-btn::after{content:'›';font-size:16px;color:#b7c1cf;}
.eph-tools-dropdown{position:absolute;top:34px;left:0;z-index:200;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.1);padding:6px;width:200px;display:none;}
.eph-tools-dropdown.active{display:block;}
.eph-tool-item{display:block;padding:7px 11px;border-radius:8px;cursor:pointer;font-size:12px;color:#1a1f2b;background:transparent;border:none;width:100%;text-align:left;font-family:inherit;}
.eph-tool-item:hover{background:#f1f4fa;}
.eph-mref-ico{display:inline-flex;width:14px;height:14px;vertical-align:-2px;}
.eph-mref-ico svg{width:14px;height:14px;display:block;}
.eph-mref-num{color:#2563eb;font-weight:500;margin-right:5px;}
.eph-mref-num.off{color:#9aa7b5;}
.eph-mref-off{opacity:.5;}
.eph-mref-warn{font-size:10px;color:#c2410c;padding:2px 11px 5px;line-height:1.5;}
.eph-indent-group{display:flex;align-items:center;gap:6px;}
.eph-indent-group label{font-size:11px;color:#5f6b7a;}
.eph-indent-input{width:52px;text-align:center;border:1px solid #dce3ec;border-radius:7px;padding:3px 6px;font-size:12px;font-family:inherit;outline:none;height:26px;}
.eph-tabs{position:relative;display:flex;gap:2px;background:#f1f4fa;border-radius:999px;padding:3px;margin:0 0 6px;}
.eph-tabs-thumb{position:absolute;top:3px;bottom:3px;left:0;width:0;border-radius:999px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.14);border:1px solid #eef2f8;transition:left .28s cubic-bezier(.4,0,.2,1),width .28s cubic-bezier(.4,0,.2,1);z-index:0;}
.eph-tab{position:relative;z-index:1;flex:1 1 50%;padding:6px 12px;font-size:12px;font-weight:500;color:#5f6b7a;cursor:pointer;background:transparent;border:none;border-radius:999px;transition:color .2s;font-family:inherit;}
.eph-tab:hover{color:#1a1f2b;}
.eph-tab.active{color:#1a1a2e;font-weight:600;}
.eph-editor{min-height:200px;max-height:46vh;border:1px solid #dce3ec;border-radius:10px;padding:12px;outline:none;line-height:1.6;color:#1a1a2e;background:#fff;overflow:auto;font-size:14px;}
/* 粘贴/浏览器默认的 <p> 自带上下 margin，会让换行看起来多一行；编辑器内统一清零 */
.eph-editor p,.eph-editor div,.eph-editor h1,.eph-editor h2,.eph-editor h3,.eph-all-editor p,.eph-all-editor div,.eph-all-block-body p,.eph-all-block-body div{margin:0;padding:0;}
.eph-editor:focus{border-color:#94a3b8;}
.eph-timeline{display:flex;align-items:center;gap:6px;font-size:12px;color:#5f6b7a;}
.eph-timeline input{width:48px;text-align:center;border:1px solid #dce3ec;border-radius:7px;padding:3px 6px;font-size:12px;font-family:inherit;outline:none;height:26px;}
.eph-media-ref{display:flex;align-items:center;gap:4px;}
.eph-ref-label{font-size:11px;color:#5f6b7a;}

/* API 配置行（模型厂商/模型/API 链接） */
.eph-api-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;background:#fbfcfe;border:1px solid #eef2f8;border-radius:10px;margin-bottom:6px;}
.eph-api-row label{font-size:11px;color:#5f6b7a;white-space:nowrap;}
.eph-api-row input{font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:5px 8px;outline:none;background:#fff;color:#1a1f2b;height:28px;box-sizing:border-box;}
.eph-api-row input:hover{border-color:#b7c1cf;}
.eph-api-row .eph-api-link{flex:1 1 180px;min-width:150px;}
.eph-api-row .eph-api-prov{flex:0 0 108px;}
.eph-api-row .eph-api-model{flex:1 1 140px;min-width:110px;}

/* 设置弹窗 */
.eph-settings{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100003;background:rgba(0,0,0,.35);}
.eph-settings.active{display:flex;}
.eph-settings-box{background:#fff;border-radius:16px;width:680px;max-width:94vw;height:50vh;max-height:52vh;display:flex;flex-direction:column;box-shadow:0 26px 80px rgba(0,0,0,.28);overflow:hidden;font-family:Inter,sans-serif;box-sizing:border-box;}
.eph-settings-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #edf2f8;}
.eph-settings-hd b{font-size:14px;color:#0f141f;}
.eph-settings-body{padding:12px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0;}
.eph-settings-ft{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid #edf2f8;}
.eph-settings-sideroot{display:flex;gap:12px;min-height:0;}
.eph-settings-nav{flex:0 0 104px;display:flex;flex-direction:column;gap:3px;border-right:1px solid #eef2f8;padding-right:8px;}
.eph-settings-nav-btn{text-align:left;padding:8px 10px;border:none;background:transparent;border-radius:9px;font-size:12px;font-weight:500;color:#5f6b7a;cursor:pointer;font-family:inherit;transition:background .15s;}
.eph-settings-nav-btn:hover{background:#f1f4fa;}
.eph-settings-nav-btn.active{background:#1a1a2e;color:#fff;}
.eph-settings-pane{flex:1 1 auto;min-width:0;overflow-y:auto;}
.eph-settings-grid{display:grid;grid-template-columns:1fr;gap:10px;padding:4px 2px 10px;}
.eph-settings-grid label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:#5f6b7a;}
.eph-settings-grid input,.eph-settings-grid textarea{font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:6px 9px;outline:none;background:#fff;color:#1a1f2b;box-sizing:border-box;width:100%;text-align:left;}
.eph-settings-grid input:hover,.eph-settings-grid textarea:hover{border-color:#b7c1cf;}
.eph-settings-grid input[type=number]{text-align:left;}
.eph-settings-grid textarea{min-height:54px;resize:vertical;line-height:1.4;}
/* 分段开关（开启/禁用）*/
.eph-settings-grid label.eph-switch{display:flex;flex-direction:row;align-items:center;gap:10px;padding:6px 2px;cursor:pointer;user-select:none;font-size:12px;color:#1a1f2b;}
.eph-switch input{display:none;}
.eph-switch .eph-sw-label{flex:1 1 auto;font-size:12px;color:#1a1f2b;}
.eph-seg{flex:0 0 auto;display:flex;background:#f1f4fa;border-radius:9px;padding:2px;}
.eph-seg-item{font-style:normal;font-size:11px;font-weight:600;padding:4px 12px;border-radius:7px;color:#94a3b8;transition:all .15s;}
.eph-seg-item.on.active{background:#d9f2e4;color:#15803d;}
.eph-seg-item.off.active{background:#fdecec;color:#c0392b;}
/* 设置下拉（图三风格：白底圆角列表 + 滚动条）*/
.eph-dd{width:100%;position:relative;}
.eph-dd-trigger{display:flex;align-items:center;justify-content:space-between;width:100%;box-sizing:border-box;font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:6px 9px;background:#fff;color:#1a1f2b;cursor:pointer;outline:none;}
.eph-dd-trigger:hover{border-color:#b7c1cf;}
.eph-dd-input{padding-right:26px;}
.eph-dd-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:15px;}
.eph-dd-arrow{flex:0 0 auto;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #94a3b8;margin-left:6px;}
.eph-dd-menu{position:fixed;z-index:100020;background:#fff;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.16);max-height:220px;overflow-y:auto;padding:4px;display:none;}
.eph-dd-menu.active{display:block;}
.eph-dd-item{display:block;width:100%;text-align:left;padding:7px 10px;border:none;background:transparent;border-radius:7px;font-size:12px;color:#1a1f2b;cursor:pointer;font-family:inherit;}
.eph-dd-item:hover{background:#f1f4fa;}
.eph-dd-item.active{background:#1a1a2e;color:#fff;}
.eph-dd-empty{font-size:12px;color:#94a3b8;padding:8px 10px;text-align:center;}
.eph-settings-note{font-size:10px;color:#94a3b8;line-height:1.4;padding:0 12px 10px;}
.eph-settings-nav-btn:hover{background:#f1f4fa;}
.eph-settings-nav-btn.active{background:#1a1a2e;color:#fff;}
.eph-settings-pane .eph-settings-grid{display:none;}
.eph-settings-pane .eph-settings-grid.active{display:grid;}
/* 去掉数字输入框的上下箭头  */
.eph-settings-grid input[type=number]{appearance:textfield;-moz-appearance:textfield;}
.eph-settings-grid input[type=number]::-webkit-outer-spin-button,
.eph-settings-grid input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.eph-settings-sub{display:flex;flex-direction:column;gap:10px;}
.eph-custom-list{display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;}
.eph-custom-item{display:flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid #eef2f8;border-radius:9px;font-size:12px;color:#1a1f2b;cursor:pointer;background:#fbfcfe;}
.eph-custom-item:hover{border-color:#b7c1cf;}
.eph-custom-item.sel{background:#1a1a2e;color:#fff;border-color:#1a1a2e;}
.eph-custom-item.sel .eph-custom-del{color:#cdd!important;}
.eph-custom-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.eph-custom-del{background:transparent;border:none;color:#b7c1cf;font-size:14px;line-height:1;cursor:pointer;padding:1px 4px;flex:0 0 auto;}
.eph-custom-del:hover{color:#e34d4d;background:#fdecec;border-radius:6px;}
.eph-custom-empty{font-size:11px;color:#94a3b8;padding:8px 4px;text-align:center;}
.eph-path-row{display:flex;align-items:center;gap:6px;}
.eph-path-row input{flex:1 1 auto;min-width:0;}
.eph-path-row .eph-btn{flex:0 0 auto;}
.eph-mode{display:flex;background:#f1f4fa;border-radius:9px;padding:2px;}
.eph-mode-opt{flex:1;font-style:normal;font-size:11px;font-weight:600;padding:5px 12px;border-radius:7px;color:#94a3b8;border:none;background:transparent;cursor:pointer;font-family:inherit;transition:background .15s;}
.eph-mode-opt.active{background:#1a1a2e;color:#fff;}
.eph-settings-btnrow{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;}
.eph-set-sec{font-size:11px;font-weight:600;color:#1a1a2e;letter-spacing:.4px;padding:9px 2px 1px;margin-top:2px;border-top:1px solid #eef2f8;}
.eph-set-sec:first-child{border-top:none;padding-top:1px;}
.eph-settings-sub input,.eph-settings-sub textarea,.eph-settings-sub select,.eph-settings-sub .eph-dd-trigger{pointer-events:auto;user-select:auto;-webkit-user-select:auto;}
.eph-settings-grid label[data-tip]>span:first-child,.eph-settings-grid label.eph-switch[data-tip]>.eph-sw-label{border-bottom:1px dotted #b7c1cf;}
/* 参数说明浮层：鼠标在 [data-tip] 元素上停留 2 秒才显示（原生 title 延迟太长且不能换行）；只给 TextGenerate / llama 参数用 */
.eph-tip{position:fixed;left:0;top:0;z-index:100100;max-width:330px;background:#1a1a2e;color:#fff;font-family:Inter,sans-serif;font-size:11px;line-height:1.65;padding:7px 10px;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.28);white-space:pre-line;display:none;pointer-events:none;}
.eph-tip.active{display:block;}

/* 总体编辑弹窗 */
.eph-all{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100004;background:rgba(0,0,0,.35);}
.eph-all.active{display:flex;}
.eph-all-box{background:#fff;border-radius:16px;width:96%;max-width:1080px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 26px 80px rgba(0,0,0,.28);font-family:Inter,sans-serif;box-sizing:border-box;}
.eph-all-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #edf2f8;}
.eph-all-hd b{font-size:14px;color:#0f141f;}
.eph-all-hd-right{display:flex;align-items:center;gap:8px;}
.eph-all-hd-right .eph-all-full{height:28px;padding:0 12px;font-size:12px;}
.eph-all-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 16px;border-bottom:1px solid #edf2f8;background:#fbfcfe;}
.eph-all-toolbar label{display:flex;align-items:center;gap:4px;font-size:11px;color:#5f6b7a;}
.eph-all-toolbar input[type=color]{width:26px;height:26px;border:1px solid #dce3ec;border-radius:7px;padding:2px;background:#fff;cursor:pointer;}
.eph-all-editor{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 16px;outline:none;line-height:1.6;color:#1a1a2e;font-size:14px;}
.eph-all-block{padding:4px 0 10px;}
.eph-all-block-hd{display:flex;align-items:center;gap:8px;font-size:11px;color:#9aa7b5;padding:6px 18px;border-radius:0;margin:0 -8px 6px;background:#f4f6fa;}
.eph-all-block-hd .eph-merge-btn{margin-left:auto;}
.eph-all-block-hd .eph-all-ref{margin-left:0;}
.eph-all.collapsed .eph-all-block-hd{display:none;}
.eph-all-num{font-weight:700;color:#8a99ae;flex:0 0 auto;}
.eph-all-title{flex:0 0 150px;min-width:0;width:150px;font-weight:600;color:#2b3448;cursor:text;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:22px;height:22px;padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;outline:none;text-align:left;}
.eph-all-title:focus{border-color:#dce3ec;background:#fff;}
.eph-all-title:focus{border-color:#8a99ae;}
.eph-all-title:empty::before{content:attr(data-ph);color:#a5b1c0;}
.eph-all-tspreview{color:#2563eb;font-size:10px;margin-left:4px;white-space:nowrap;}
.eph-all-del{margin-left:auto;background:transparent;border:none;color:#b7c1cf;font-size:14px;line-height:1;cursor:pointer;padding:1px 4px;}
.eph-all-del:hover{color:#e34d4d;background:#fdecec;border-radius:6px;}
.eph-all-ref{margin-left:auto;background:#f7f9fd;border:1px solid #dce3ec;border-radius:7px;color:#334155;font-size:11px;line-height:18px;cursor:pointer;padding:0 8px;font-family:inherit;}
.eph-all-rulebar{display:flex;align-items:center;gap:6px;margin-right:auto;min-height:22px;}
.eph-all-ref:hover{background:#edf2fa;}
.eph-all-ref + .eph-all-del{margin-left:6px;}
.eph-all-block-body{outline:none;min-height:60px;background:transparent;}
/* 收起小标题：各卡片之间用一条细灰线分隔，并隐藏空白行 */
.eph-all.collapsed .eph-all-block{padding:2px 0 6px;}
.eph-all.collapsed .eph-all-block + .eph-all-block{border-top:1px solid #e8ecf2;margin-top:2px;padding-top:8px;}
.eph-all.collapsed .eph-all-block-body{min-height:0;}
.eph-all.collapsed .eph-all-block-body div:empty,
.eph-all.collapsed .eph-all-block-body p:empty{display:none;}
.eph-all-blank{display:none;}
/* 全屏 */
.eph-all.full .eph-all-box{width:100%;max-width:none;height:100%;max-height:none;border-radius:0;}
.eph-all-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:16px;}
.eph-all-ft{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid #edf2f8;}

/* 引用媒体：一个生成节点一块，块内是该节点各媒体端口上的素材卡片（预览效果与 MediaLoader 一致） */
.eph-rb{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100060;background:rgba(0,0,0,.35);font-family:Inter,sans-serif;}
.eph-rb.active{display:flex;}
.eph-rb-box{background:#fff;border-radius:14px;width:94%;max-width:1020px;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.24);box-sizing:border-box;}
.eph-rb-hd{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #edf2f8;}
.eph-rb-hd b{font-size:14px;color:#0f141f;}
.eph-rb-hd .eph-modal-close{margin-left:auto;}
.eph-rb-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:14px;}
.eph-rb-node{border:1px solid #eef2f8;border-radius:12px;padding:10px 12px 12px;background:#fbfcfe;}
.eph-rb-node.current{border-color:#86d3a4;background:#f2fbf5;}
.eph-rb-nhd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer;padding:2px 4px;border-radius:8px;}
.eph-rb-nhd:hover{background:rgba(0,0,0,.03);}
.eph-rb-node.current .eph-rb-nhd:hover{background:rgba(22,163,74,.07);}
.eph-rb-num{font-size:12px;font-weight:600;color:#8a99ae;flex:0 0 auto;min-width:14px;}
.eph-rb-name{flex:1 1 160px;min-width:120px;font-size:12px;color:#1a1f2b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.eph-rb-node.current .eph-rb-name{color:#15803d;font-weight:600;}
.eph-rb-cnt{font-size:11px;color:#5f6b7a;background:#eef2f7;border-radius:100px;padding:2px 10px;flex:0 0 auto;}
.eph-rb-grid{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;}
.eph-rb-hint{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:7px 10px;font-size:11px;line-height:1.6;}
.eph-rb-tile{width:168px;background:#fbfcfe;border:1px solid #eef1f6;border-radius:9px;overflow:hidden;display:flex;flex-direction:column;cursor:pointer;transition:.15s;position:relative;}
.eph-rb-tile:hover{border-color:#d0d5dd;box-shadow:0 4px 12px rgba(0,0,0,.06);}
.eph-rb-tile.added{border-color:#a7f0c6;background:#f6fffa;}
.eph-rb-tile.flash{box-shadow:0 0 0 2px rgba(22,163,74,.4);}
.eph-rb-pv{width:100%;background:#eef1f6;display:flex;align-items:center;justify-content:center;position:relative;aspect-ratio:16/9;overflow:hidden;flex-shrink:0;}
.eph-rb-pv img{width:100%;height:100%;object-fit:contain;background:#eef1f6;display:block;}
.eph-rb-pv video{width:100%;height:100%;object-fit:contain;background:#eef1f6;}
.eph-rb-pv audio{width:100%;height:44px;background:#e2e8f0;border-radius:0;}
.eph-rb-pv .ez-ap{width:100%;}
.eph-rb-pv .eph-rb-ph{font-size:28px;color:#94a3b8;opacity:.6;}
.eph-rb-type{position:absolute;top:5px;left:5px;display:inline-flex;align-items:center;gap:3px;background:rgba(255,255,255,.86);border-radius:30px;padding:1px 8px;font-size:10px;font-weight:600;color:#1a1f2b;box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid #eef1f6;pointer-events:none;z-index:3;}
.eph-rb-type-ico{display:inline-flex;color:#4d5b6d;}
.eph-rb-type-ico svg{width:11px;height:11px;display:block;}
.eph-rb-pv .eph-rb-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.55);color:#fff;border:none;border-radius:50%;width:38px;height:38px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:6;font-size:14px;padding:0;opacity:0;pointer-events:none;transition:.15s;font-family:inherit;}
.eph-rb-tile:hover .eph-rb-play{opacity:1;pointer-events:auto;}
.eph-rb-tile.playing .eph-rb-play{opacity:0;pointer-events:none;}
.eph-rb-add{position:absolute;top:8px;right:8px;z-index:7;width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,.5);background:rgba(255,255,255,.55);color:#1a1f2b;font-size:17px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:.15s;font-family:inherit;padding:0;}
.eph-rb-add:hover{background:rgba(255,255,255,.8);transform:scale(1.05);}
.eph-rb-add.added{background:rgba(74,106,90,.85);border-color:rgba(74,106,90,.9);color:#fff;}
.eph-rb-add.added:hover{background:rgba(61,90,77,.95);}
.eph-rb-info{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:2px;padding:5px 8px 6px;background:rgba(255,255,255,.62);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-top:1px solid rgba(255,255,255,.5);opacity:0;transform:translateY(4px);transition:.15s;pointer-events:none;z-index:5;}
.eph-rb-tile:hover .eph-rb-info{opacity:1;transform:none;}
.eph-rb-tile.playing .eph-rb-info{opacity:0;}
.eph-rb-fname{font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1a1f2b;}
.eph-rb-fmeta{font-size:10px;color:#64748b;display:flex;justify-content:space-between;gap:6px;}
.eph-rb-suffix{background:rgba(255,255,255,.7);padding:0 6px;border-radius:4px;border:1px solid rgba(255,255,255,.6);}
.eph-rb-foot{display:flex;align-items:center;gap:6px;padding:5px 8px 6px;border-top:1px solid #eef1f6;background:#fff;}
.eph-rb-minus{margin-left:auto;background:transparent;border:1px solid #e2e8f0;border-radius:6px;color:#94a3b8;font-size:12px;line-height:1;cursor:pointer;padding:1px 6px;font-family:inherit;}
.eph-rb-minus:hover{color:#c0392b;background:#fdecec;border-color:#fecaca;}
.eph-rb-foot .eph-rb-cnt{font-size:10px;color:#15803d;background:#f2fbf5;border:1px solid #bbf7d0;border-radius:6px;padding:0 5px;line-height:16px;}
.eph-rb-lab{font-size:12px;font-weight:600;color:#2563eb;}
.eph-rb-tile.added .eph-rb-lab{color:#16a34a;}
.eph-rb-ins{font-size:10px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:0 5px;line-height:16px;}
.eph-rb-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:18px;line-height:1.8;}
/* 引用媒体窗口的右键菜单 */
.eph-ctx{position:fixed;z-index:100075;width:auto;min-width:210px;max-width:340px;padding:4px;}
.eph-ctx .eph-tool-item{white-space:nowrap;}

/* 优化调用进度弹窗 */
.eph-prog{position:fixed;z-index:100030;width:290px;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:10px 12px;display:none;font-family:Inter,sans-serif;box-sizing:border-box;cursor:pointer;}
.eph-prog.active{display:block;}
.eph-prog-hd{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.eph-prog-title{flex:1 1 auto;font-size:12px;font-weight:600;color:#1a1f2b;}
.eph-prog-count{font-size:11px;color:#5f6b7a;}
.eph-prog-close{border:none;background:transparent;color:#94a3b8;font-size:14px;line-height:1;cursor:pointer;padding:0 2px;}
.eph-prog-close:hover{color:#e34d4d;}
.eph-prog-bar{height:8px;border-radius:100px;background:#eef2f7;overflow:hidden;}
.eph-prog-fill{height:100%;width:0;border-radius:100px;background:linear-gradient(90deg,#34a853,#5ec98b);transition:width .25s ease;}
.eph-prog-fill.indeterminate{width:40%!important;animation:eph-prog-slide 1.1s ease-in-out infinite;}
@keyframes eph-prog-slide{0%{margin-left:-40%}100%{margin-left:100%}}
.eph-prog-detail{display:none;margin-top:8px;max-height:150px;overflow-y:auto;font-size:11px;color:#5f6b7a;line-height:1.7;}
.eph-prog.open .eph-prog-detail{display:block;}
.eph-prog-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eph-prog-line.done{color:#34a853;}
.eph-prog-line.err{color:#c0392b;}

/* 媒体引用：插入的 @ 芯片 + 悬停预览 + 点击查看器 */
.eph-mref{color:#2563eb;cursor:pointer;font-weight:500;white-space:nowrap;user-select:none;background:transparent;border:none;padding:0;border-radius:0;}
.eph-mref:hover{color:#1d4ed8;}
.eph-mref .eph-mref-ico{width:13px;height:13px;vertical-align:-2.5px;margin-left:3px;}
.eph-mref .eph-mref-ico svg{width:13px;height:13px;}
.eph-tools-sep{font-size:10px;color:#94a3b8;padding:8px 10px 2px;letter-spacing:.5px;font-weight:500;}
.ph-mref-item{display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eph-rp{position:fixed;z-index:100040;background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.2);padding:8px;width:240px;box-sizing:border-box;font-family:Inter,sans-serif;}
.eph-rp-media{display:block;width:100%;max-height:180px;border-radius:6px;object-fit:contain;background:#000;}
.eph-rp-cap{font-size:10px;color:#5f6b7a;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eph-mv{position:fixed;inset:0;z-index:100080;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);}
.eph-mv.active{display:flex;}
.eph-mv-box{background:#fff;border-radius:14px;padding:10px;padding-top:40px;max-width:82vw;max-height:82vh;display:flex;flex-direction:column;gap:8px;box-shadow:0 26px 80px rgba(0,0,0,.4);font-family:Inter,sans-serif;box-sizing:border-box;}
.eph-mv-box .eph-modal-close{position:absolute;top:8px;right:8px;z-index:20;}
.eph-mv-box{position:relative;}
.eph-mv-media{display:block;max-width:100%;max-height:70vh;border-radius:8px;object-fit:contain;background:#000;}
audio.eph-mv-media,audio.eph-rp-media{background:#fff !important;border-radius:8px;color-scheme:light;}
audio.eph-mv-media::-webkit-media-controls-panel,audio.eph-rp-media::-webkit-media-controls-panel,audio.eph-mv-media::-webkit-media-controls-enclosure,audio.eph-rp-media::-webkit-media-controls-enclosure{background:#fff !important;border-radius:8px;}
audio.eph-mv-media::-webkit-media-controls-timeline,audio.eph-rp-media::-webkit-media-controls-timeline{background:#fff;border-radius:4px;}
.eph-mv-cap{font-size:12px;color:#1a1f2b;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

/* 查找匹配列表 + Word 式高亮（独立覆盖层，不改 DOM、不依赖 browser API） */
.eph-fr-matches{margin-top:8px;max-height:150px;overflow-y:auto;border-top:1px solid #eef2f8;padding-top:6px;display:none;}
.eph-fr-match{display:flex;gap:8px;align-items:center;padding:5px 8px;border-radius:7px;cursor:pointer;font-size:12px;color:#1f2937;white-space:nowrap;overflow:hidden;}
.eph-fr-match:hover{background:#f1f4fa;}
.eph-fr-match.current{background:#fff3cd;color:#b45309;}
.eph-fr-match-n{flex:0 0 auto;color:#94a3b8;font-size:10px;min-width:18px;text-align:right;}
.eph-fr-match-t{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;}
.eph-ph-overlay{position:fixed;z-index:100006;background:#aab2c0;pointer-events:none;border-radius:2px;opacity:.5;}
.eph-ph-overlay.current{background:#4b5563;opacity:.62;}

/* 对齐工具图标（Word 同款） */
.eph-tb-btn svg{display:block;}
.eph-tb-btn.word-glyph{font-weight:900;font-size:15px;font-family:'Segoe UI',Inter,sans-serif;}
.eph-tb-btn.bold-glyph{font-weight:800;}
.eph-tb-btn.italic-glyph{font-family:Georgia,serif;font-style:italic;}
.eph-tb-btn.underline-glyph{text-decoration:underline;}
.eph-tb-btn.strike-glyph{text-decoration:line-through;}
.eph-tb-btn.active{background:#dbe7f8;color:#1a56db;}

/* 查找/替换 */
.eph-fr{position:fixed;top:70px;right:90px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.16);width:360px;z-index:100010;display:none;overflow:hidden;}
.eph-fr.active{display:block;}
.eph-fr-header{display:flex;align-items:center;padding:8px 14px;border-bottom:1px solid #e6edf7;gap:10px;cursor:move;user-select:none;}
.eph-fr-tab{padding:6px 4px;font-size:12px;cursor:pointer;color:#5f6b7a;border-bottom:2px solid transparent;font-weight:500;background:transparent;border-top:none;border-left:none;border-right:none;}
.eph-fr-tab.active{color:#1a1a2e;border-bottom-color:#1a1a2e;}
.eph-fr-close{margin-left:auto;border:none;background:none;cursor:pointer;color:#94a3b8;font-size:16px;}
.eph-fr-body{padding:10px 14px;}
.eph-fr-row{display:flex;gap:6px;margin-bottom:6px;align-items:center;}
.eph-fr-row input{flex:1;border:1px solid #dce3ec;border-radius:7px;padding:7px;font-size:12px;outline:none;font-family:inherit;}
.eph-fr-btn{background:#1a1a2e;color:#fff;padding:6px 11px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-family:inherit;}
.eph-fr-hint{font-size:10px;color:#94a3b8;text-align:center;}

/* 标准取色器 */
.eph-picker{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100095;background:rgba(0,0,0,.4);}
.eph-picker.active{display:flex;}
.eph-picker-box{background:#fff;border-radius:16px;padding:16px;width:320px;box-shadow:0 24px 80px rgba(0,0,0,.2);}
.eph-picker-preview{width:100%;height:36px;border-radius:8px;margin-bottom:14px;border:1px solid #e6edf7;}
.eph-picker-2d{position:relative;width:100%;aspect-ratio:1/1;border-radius:8px;margin-bottom:14px;cursor:crosshair;}
.eph-picker-2d-bg{position:absolute;inset:0;border-radius:8px;}
.eph-picker-2d-cursor{position:absolute;width:15px;height:15px;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);transform:translate(-50%,-50%);pointer-events:none;}
.eph-picker-hue{position:relative;width:100%;height:13px;border-radius:7px;margin:12px 0;background:linear-gradient(to right,#f00 0%,#ff0 17%,#0f0 33%,#0ff 50%,#00f 67%,#f0f 83%,#f00 100%);cursor:pointer;}
.eph-picker-thumb{position:absolute;top:50%;width:18px;height:18px;border-radius:50%;background:#fff;transform:translate(-50%,-50%);box-shadow:0 2px 6px rgba(0,0,0,.3);pointer-events:none;}
.eph-picker-modes{display:flex;gap:6px;margin-bottom:10px;}
.eph-picker-mode{flex:1;padding:5px;border:none;border-radius:6px;background:#f1f4fa;cursor:pointer;font-size:11px;font-weight:600;color:#5f6b7a;font-family:inherit;}
.eph-picker-mode.active{background:#1a1a2e;color:#fff;}
.eph-picker-row{display:flex;align-items:center;gap:6px;margin-bottom:6px;}
.eph-picker-row label{width:16px;font-size:11px;color:#5f6b7a;}
.eph-picker-row input[type=range]{flex:1;accent-color:#1a1a2e;}
.eph-picker-row input[type=number]{width:46px;border:1px solid #dce3ec;border-radius:6px;padding:4px;text-align:center;font-size:11px;outline:none;font-family:inherit;}
.eph-picker-ft{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;border-top:1px solid #e6edf7;padding-top:10px;}
.eph-picker-hex{flex:1;border:none;background:#f7f9fd;border-radius:8px;padding:8px 10px;font-size:13px;font-family:monospace;text-transform:uppercase;outline:none;}
.eph-picker-cancel{background:#f1f4fa;color:#4d5b6d;padding:8px 14px;border-radius:8px;border:none;cursor:pointer;font-family:inherit;}
.eph-picker-confirm{background:#1a1a2e;color:#fff;padding:8px 14px;border-radius:8px;border:none;cursor:pointer;font-family:inherit;}

/* 设置·规则设置页 */
.eph-rule-sel{display:flex;flex-direction:column;gap:6px;margin-bottom:14px;}
.eph-rule-sel>span{font-size:12px;color:#1a1a2e;font-weight:600;}
.eph-rule-note{font-size:11px;color:#5f6b7a;background:#f2f5fa;border-radius:8px;padding:8px 10px;line-height:1.6;}
.eph-rule-custom{display:flex;flex-direction:column;gap:6px;margin-top:6px;}
.eph-rule-custom>span{font-size:12px;color:#1a1a2e;font-weight:600;}
.eph-rule-custom input{font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:6px 9px;outline:none;background:#fff;color:#1a1f2b;box-sizing:border-box;width:100%;}

/* 卡片管理弹窗（保存 / 加载 / 删除 userdata/prompts 里的提示词卡片） */
.eph-cm{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100004;background:rgba(0,0,0,.35);font-family:Inter,sans-serif;}
.eph-cm.active{display:flex;}
.eph-cm-box{background:#fff;border-radius:16px;width:640px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 26px 80px rgba(0,0,0,.28);overflow:hidden;box-sizing:border-box;}
.eph-cm-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #edf2f8;}
.eph-cm-hd b{font-size:14px;color:#0f141f;}
.eph-cm-body{padding:12px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0;}
.eph-cm-row{display:flex;align-items:center;gap:8px;}
.eph-cm-row input{flex:1 1 auto;min-width:0;font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:6px 9px;outline:none;background:#fff;color:#1a1f2b;box-sizing:border-box;}
.eph-cm-row .eph-dd{flex:1 1 auto;min-width:0;}
.eph-cm-row .eph-btn{flex:0 0 auto;}
.eph-cm-pick{display:flex;flex-wrap:wrap;gap:6px;border:1px solid #eef2f8;background:#fbfcfe;border-radius:10px;padding:8px;min-height:54px;align-content:flex-start;}
.eph-cm-chip{border:1px solid #dce3ec;background:#fff;border-radius:8px;padding:5px 9px;font-size:11px;color:#1a1f2b;cursor:pointer;user-select:none;-webkit-user-select:none;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:inherit;}
.eph-cm-chip:hover{border-color:#b7c1cf;background:#f7f9fd;}
.eph-cm-chip.on{background:#e7f7ec;border-color:#86d3a4;color:#15803d;font-weight:600;}
.eph-cm-idx{color:#8a99ae;margin-right:4px;}
.eph-cm-chip.on .eph-cm-idx{color:#16a34a;}
.eph-cm-empty{color:#8a9aa8;font-size:11px;padding:6px;}
.eph-cm-hint{font-size:11px;color:#5f6b7a;background:#f2f5fa;border-radius:8px;padding:7px 10px;line-height:1.6;min-height:16px;word-break:break-all;}
.eph-cm-hint.err{background:#fef2f2;color:#991b1b;}
.eph-cm-hint.ok{background:#f2fbf5;color:#15803d;}
/* 提示词规范：卡片/总体编辑左下角下拉 + 提示气泡（不遮挡，向下弹） */
.eph-rule-row{display:flex;align-items:center;gap:4px;flex:0 0 auto;}
.eph-rule-dd{width:136px;}
.eph-rule-dd .eph-dd-trigger{padding:2px 6px;font-size:11px;min-height:22px;}
.eph-rule-hint{height:22px;border-radius:7px;border:1px solid #dce3ec;background:#fff;color:#5f6b7a;font-size:11px;line-height:1;cursor:pointer;font-family:inherit;flex:0 0 auto;padding:0 8px;}
.eph-rule-hint:hover{border-color:#8a99ae;color:#1a1a2e;}
.eph-merge-btn{height:22px;min-width:26px;padding:0 7px;border-radius:6px;border:1px solid #dce3ec;background:#f1f4fa;color:#94a3b8;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;flex:0 0 auto;line-height:1;}
.eph-merge-btn.on{background:#d9f2e4;border-color:#86d3a4;color:#15803d;}
.eph-rule-pop{position:fixed;z-index:100040;width:440px;max-width:92vw;max-height:70vh;overflow:auto;background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.2);padding:10px 12px;font-family:Inter,sans-serif;font-size:11px;color:#334155;line-height:1.6;box-sizing:border-box;}
.eph-rule-pop-t{font-size:12px;font-weight:600;color:#0f141f;margin-bottom:6px;}
.eph-rule-pop-hd{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
.eph-rule-pop-hd .eph-rule-pop-t{margin-bottom:0;flex:1 1 auto;min-width:0;}
.eph-lang{display:flex;flex:0 0 auto;border:1px solid #dce3ec;border-radius:7px;overflow:hidden;}
.eph-lang-btn{border:0;border-radius:0;background:#fff;color:#5f6b7a;font-family:inherit;font-size:10px;line-height:1;padding:4px 8px;cursor:pointer;}
.eph-lang-btn+.eph-lang-btn{border-left:1px solid #dce3ec;}
.eph-lang-btn.active{background:#2563eb;color:#fff;}
.eph-lang-wrap{margin:2px 0 2px;}
.eph-rule-pop-note{background:#f2f5fa;border-radius:8px;padding:7px 9px;white-space:pre-line;}
.eph-rule-pop-ex{margin-top:8px;border-top:1px solid #eef2f8;padding-top:6px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;}
.eph-rule-pop-ts{margin-top:8px;border-top:1px solid #eef2f8;padding-top:6px;display:flex;flex-direction:column;gap:6px;}
.eph-rule-shots-in{display:flex;flex-direction:column;gap:4px;user-select:none;-webkit-user-select:none;}
.eph-rule-shot-row{display:flex;align-items:center;gap:5px;}
.eph-rule-shot-row input{width:46px;text-align:center;border:1px solid #dce3ec;border-radius:6px;padding:3px 5px;font-size:11px;font-family:inherit;outline:none;height:24px;box-sizing:border-box;user-select:none;-webkit-user-select:none;}
.eph-rule-shot-btn{width:20px;height:20px;border-radius:6px;border:1px solid #dce3ec;background:#fff;color:#5f6b7a;font-size:12px;line-height:1;cursor:pointer;font-family:inherit;padding:0;flex:0 0 auto;user-select:none;-webkit-user-select:none;}
.eph-rule-shot-btn:hover{border-color:#8a99ae;color:#1a1a2e;}
/* 生成结果集中成一块，方便一次框选 */
.eph-rule-shots-out{display:flex;flex-direction:column;gap:2px;user-select:text;-webkit-user-select:text;}
.eph-rule-shot-pv{color:#2563eb;font-size:11px;white-space:pre;overflow-x:auto;max-width:100%;}
.eph-rule-pop-pair{display:inline-flex;align-items:center;gap:3px;font-size:11px;}
.eph-rule-pop-from{color:#5f6b7a;}
.eph-rule-pop-arrow{color:#b7c1cf;}
.eph-rule-pop-to{color:#2563eb;font-weight:500;}
.eph-dd-sep{height:1px;background:#eef2f8;margin:4px 6px;}
/* 规范设置页 */
.eph-rule-box{display:flex;flex-direction:column;gap:8px;}
.eph-rule-grid{display:grid;grid-template-columns:1fr;gap:8px;}
.eph-rule-grid label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:#5f6b7a;}
.eph-rule-grid input,.eph-rule-grid textarea{font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:6px 9px;outline:none;background:#fff;color:#1a1f2b;box-sizing:border-box;width:100%;}
.eph-rule-grid textarea{min-height:160px;resize:none;line-height:1.5;}
.eph-rule-btns{display:flex;gap:8px;flex-wrap:wrap;}
`;

let _styleInjected = false;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
function genId() { return 'ph_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
function deepClone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return Array.isArray(o) ? [] : {}; } }
function plainTextOf(html) {
  const d = document.createElement('div'); d.innerHTML = html || '';
  // 按块级边界补换行：直接取 textContent 会把多行提示词粘成一行（<div>a</div><div>b</div> 之间没有换行）。
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3) { out.push(n.nodeValue || ''); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase();
    if (tag === 'br') { out.push('\n'); return; }
    const block = /^(div|p|li|h[1-6]|tr|blockquote)$/.test(tag);
    if (block && out.length && out[out.length - 1] !== '\n') out.push('\n');
    Array.from(n.childNodes).forEach(walk);
    if (block && out.length && out[out.length - 1] !== '\n') out.push('\n');
  };
  Array.from(d.childNodes).forEach(walk);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const fetchApi = (p, o) => (api && typeof api.fetchApi === 'function') ? api.fetchApi(p, o) : fetch(p, o);

// 参数说明：给任意元素挂 data-tip，鼠标停留 2 秒后才弹出说明浮层（含换行，原生 title 做不到）。
// 目前只挂在「TextGenerate设置」「llama设置」两类参数上（API 厂商/模型/路径等不给，误挡输入框）。
// 停留时间不能太短：一放上去就弹会挡住正在看的输入框。
  const _TIP_DELAY = 2000;
let _tipEl = null, _tipTimer = null, _tipFor = null;
function setTip(node, text) { if (node && text) node.dataset.tip = text; return node; }
function placeTip(t) {
  if (!_tipEl || !_tipEl.parentNode) { _tipEl = el('div', 'eph-tip'); document.body.appendChild(_tipEl); }
  _tipEl.textContent = t.dataset.tip; _tipEl.classList.add('active');
  const r = t.getBoundingClientRect(); const b = _tipEl.getBoundingClientRect();
  _tipEl.style.left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - b.width - 8)) + 'px';
  const below = r.bottom + 8;
  _tipEl.style.top = ((below + b.height > window.innerHeight - 8) ? Math.max(8, r.top - b.height - 8) : below) + 'px';
}
function hideTip() {
  if (_tipTimer) { clearTimeout(_tipTimer); _tipTimer = null; }
  _tipFor = null;
  if (_tipEl) _tipEl.classList.remove('active');
}
document.addEventListener('mouseover', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
  if (t === _tipFor) return;              // 还在同一个字段内部移动：既不重计时也不隐藏
  if (!t) return;
  _tipFor = t;
  _tipTimer = setTimeout(() => { _tipTimer = null; if (_tipFor === t) placeTip(t); }, _TIP_DELAY);
});
document.addEventListener('mouseout', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
  if (!t || t !== _tipFor) return;
  const to = e.relatedTarget;
  if (to && to.nodeType === 1 && t.contains(to)) return;   // 字段内的子元素之间移动，不算移出
  hideTip();
});
window.addEventListener('scroll', hideTip, true);

// Word 同款对齐图标（横线表示对齐方式）
function alignSVG(type) {
  const widths = type === 'justify' ? [16, 16, 16, 16] : [16, 16, 10, 7];
  const xof = (w) => (type === 'left' ? 0 : type === 'center' ? (16 - w) / 2 : 16 - w);
  const rects = widths.map((w, i) => `<rect x="${xof(w)}" y="${2 + i * 4}" width="${w}" height="2" rx="1" fill="currentColor"/>`).join('');
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">${rects}</svg>`;
}

function stateFor(node) {
  if (!node._ezPh) node._ezPh = {
    cards: [], optimize: {}, rules: {}, ui: { dock: phDockPref() },
    // 「总体编辑」那份整体优化内容（所有卡片合并后优化一次）+ 是否用它输出（对应卡片级的 contentOptimized / useOptimized）
    overallOptimized: '', overallOptimizedHTML: '', overallUseOptimized: false,
    editingId: null, currentTab: 'default', dirty: false,
  };
  return node._ezPh;
}
function loadFromConfig(node) {
  const st = stateFor(node);
  const cfg = readConfig(node, {});
  st.cards = Array.isArray(cfg.cards) ? deepClone(cfg.cards) : [];
  st.optimize = (cfg.optimize && typeof cfg.optimize === 'object') ? deepClone(cfg.optimize) : {};
  st.rules = (cfg.rules && typeof cfg.rules === 'object') ? deepClone(cfg.rules) : {};
  st.ui = (cfg.ui && typeof cfg.ui === 'object') ? deepClone(cfg.ui) : { dock: phDockPref() };
  st.overallOptimized = String(cfg.overallOptimized || '');
  st.overallOptimizedHTML = String(cfg.overallOptimizedHTML || '');
  st.overallUseOptimized = !!cfg.overallUseOptimized;
  st.dirty = false;
  phDockSyncBtn(node);
}
function syncToConfig(node) {
  const st = stateFor(node);
  // 规范是「节点级」的一份选择：所有卡片都用它（后端编译直接用，不动配置里的规范表）
  const customs = (st.rules && Array.isArray(st.rules.custom)) ? st.rules.custom : _customRules(node);
  const ovs = (st.rules && st.rules.overrides && typeof st.rules.overrides === 'object') ? st.rules.overrides : {};
  const lang = (st.rules && st.rules.lang === 'en') ? 'en' : 'zh';
  const ruleId = _normRuleId((st.rules && st.rules.ruleId) || 'none');
  const rule = _PROMPT_RULES.map((x) => _pickLang(_applyOverride(x, ovs[x.id]), lang))
    .concat(customs.map((c) => _pickLang(c, lang))).find((x) => x.id === ruleId) || _PROMPT_RULES[0];
  st.cards.forEach((c) => { c.rule = { ref: rule.ref || {}, ts: rule.ts || {} }; });
  writeConfig(node, {
    optimize: st.optimize || {}, cards: st.cards, rules: st.rules || {},
    overallOptimized: st.overallOptimized || '', overallOptimizedHTML: st.overallOptimizedHTML || '',
    overallUseOptimized: !!st.overallUseOptimized,
    ui: st.ui || { dock: phDockPref() },
  });
  markDirtyFalse(node);
}
// 规范下拉在卡片弹窗 / 总体编辑 / 设置页三处任意一处改动，其余都跟着走
function syncRuleUI(node, id) {
  id = _normRuleId(id);
  try { if (_editModal && _editModal.classList.contains('active') && _editModal._ruleDD) _editModal._ruleDD.value = id; } catch (_) {}
  try { if (_allModal && _allModal.classList.contains('active') && _allModal._ruleDD) _allModal._ruleDD.value = id; } catch (_) {}
  try { const g = _settingsModal && _settingsModal._grid1r; if (g && g._setRule) g._setRule(id); } catch (_) {}
}
function setNodeRule(node, id) {
  const st = stateFor(node);
  id = _normRuleId(id);
  st.rules = Object.assign({}, st.rules || {}, { ruleId: id });
  syncToConfig(node);
  syncRuleUI(node, id);
}
function markDirtyFalse(node) { /* kept for clarity; no untracked dirty on config write */ }

// ===== 卡片操作 =====
function addCard(node) {
  const st = stateFor(node);
  st.cards.push({
    id: genId(), title: ezT('Act {n}').replace('{n}', String(st.cards.length + 1)),
    content: '', contentHTML: '', contentOptimized: '', contentOptimizedHTML: '',
    timelineStart: '', timelineEnd: '', modelType: 'text', model: '', provider: '', apiUrl: '', indent: 0, useOptimized: false,
  });
  syncToConfig(node); updatePorts(node); refreshUI(node);
}
function deleteCard(node, cardId) {
  const st = stateFor(node);
  const i = st.cards.findIndex((c) => c.id === cardId);
  if (i < 0) return;
  st.cards.splice(i, 1);
  syncToConfig(node); updatePorts(node); refreshUI(node);
}
function reorderCard(node, from, to) {
  const st = stateFor(node);
  if (from < 0 || from >= st.cards.length || to < 0 || to > st.cards.length) return;
  const [c] = st.cards.splice(from, 1);
  st.cards.splice(to, 0, c);
  syncToConfig(node); updatePorts(node); refreshUI(node);
}

// ===== 动态端口（输入 card_in_1..N / 输出 合并提示词 + card_out_1..N）====
function removeConfigInput(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && _in.name === 'config') { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}
}
function deferSync(node) {
  if (node._ezPhSyncTimer) clearTimeout(node._ezPhSyncTimer);
  node._ezPhSyncTimer = setTimeout(() => { node._ezPhSyncTimer = null; try { updatePorts(node); refreshUI(node); } catch (e) { console.error('[PromptHelper] port sync failed (panel may not render):', e); } }, 120);
}
function linksOf(o) {
  const ids = [];
  if (Array.isArray(o.links)) ids.push(...o.links);
  if (o.link != null) ids.push(o.link);
  return ids;
}
function updatePorts(node, noRedraw) {
  if (!node || !node.inputs || !node.outputs) return false;
  removeConfigInput(node);
  const st = stateFor(node);
  const count = Math.min(MAX_CARDS, st.cards.length);

  // 链路变更复用守卫：先不动 socket，延后再重排/删槽（否则保存的 target_slot/origin_slot 接不回去）。
  const pending = (node.inputs || []).some((i) => i.link != null && !(node.graph && node.graph.links && node.graph.links[i.link]))
    || (node.outputs || []).some((o) => linksOf(o).some((lid) => lid != null && !(node.graph && node.graph.links && node.graph.links[lid])));
  if (pending) { deferSync(node); return false; }

  // ---- 输入：综合媒体动态（红色 ANY，连接后自动补一个空槽）+ 卡片输入按序（clip 输入口已移除，TextGenerate 走设置）----

  // 综合媒体：任意类型(ANY)红色端口，可接 图像/视频/音频/3D 模型等。已连接的媒体端口数 + 1  个空槽。
    const mediaExists = (node.inputs || []).filter((i) => i._ezMedia != null || /^media_in_\d+$/.test(i.name || ''));
  const connectedMedia = mediaExists.filter((s) => linksOf(s).length > 0).length;
  const mediaWant = Math.min(MAX_MEDIA, Math.max(1, connectedMedia + 1));
  const mediaSeq = [];
  const usedMedia = new Set();
  for (let mi = 0; mi < mediaWant; mi++) {
    let sock = mediaExists.find((x, i) => !usedMedia.has(i) && x._ezMedia != null && x._ezMedia === mi);
    if (!sock) sock = mediaExists.find((x, i) => !usedMedia.has(i));
    if (!sock) { node.addInput(`media_in_${mi + 1}`, '*'); sock = node.inputs[node.inputs.length - 1]; }
    const oi = mediaExists.indexOf(sock);
    if (oi >= 0) usedMedia.add(oi);
    if (sock._ezMedia !== mi) sock._ezMedia = mi;
    if (sock.name !== `media_in_${mi + 1}`) sock.name = `media_in_${mi + 1}`;
    try {
      const lab = ezT('Combined media') + ' ' + (mi + 1);
      sock.label = lab; sock.hideName = true; sock.hidden = false; sock._ezLabel = lab;
      if (sock.color_on !== MEDIA_PORT_COLOR || sock.color_off !== MEDIA_PORT_COLOR || sock.color !== MEDIA_PORT_COLOR) {
        sock.color_on = MEDIA_PORT_COLOR; sock.color_off = MEDIA_PORT_COLOR; sock.color = MEDIA_PORT_COLOR;
      }
    } catch (_) {}
    mediaSeq.push(sock);
  }
  mediaExists.forEach((o, i) => { if (!usedMedia.has(i)) { const idx = node.inputs.indexOf(o); if (idx >= 0) node.removeInput(idx); } });

  // 提示词文本输入：卡片数 1:1，逻辑不变；某卡输入口被连接则对应卡片变灰。
    const allCardSocks = (node.inputs || []).filter((i) => (i._ezCardId != null || /^card_in_\d+$/.test(i.name || '')));
  const used = new Set();
  const cardSeq = [];
  st.cards.forEach((card, idx) => {
    let sock = allCardSocks.find((x, i) => !used.has(i) && x._ezCardId != null && String(x._ezCardId) === String(card.id));
    if (!sock) sock = allCardSocks.find((x, i) => !used.has(i));
    if (!sock) { node.addInput(`card_in_${idx + 1}`, 'STRING'); sock = node.inputs[node.inputs.length - 1]; }
    const oi = allCardSocks.indexOf(sock);
    if (oi >= 0) used.add(oi);
    if (sock._ezCardId !== card.id) { sock._ezCardId = card.id; }
    if (sock.name !== `card_in_${idx + 1}`) { sock.name = `card_in_${idx + 1}`; }
    try { sock.label = ''; sock.hideName = true; sock.hidden = false; sock._ezLabel = (card.title || (ezT('Prompt') + ' ' + (idx + 1))); } catch (_) {}
    cardSeq.push(sock);
  });
  // 删除未被复用的旧卡片输入 socket
  allCardSocks.forEach((o, i) => {
    if (!used.has(i)) {
      const idx = node.inputs.indexOf(o);
      if (idx >= 0) node.removeInput(idx);
    }
  });
  // 记录「卡片输入口已连接」→ 渲染时卡片变灰
    const linked = {};
  cardSeq.forEach((sock, idx) => { if (linksOf(sock).length > 0 && st.cards[idx]) linked[st.cards[idx].id] = true; });
  node._ezLinkedCards = linked;

  const wantIn = [...mediaSeq, ...cardSeq];
  if (node.inputs.length !== wantIn.length || node.inputs.some((i, x) => i !== wantIn[x])) {
    node.inputs.splice(0, node.inputs.length, ...wantIn);
  }
  node.inputs.forEach((i, idx) => {
    linksOf(i).forEach((lid) => { if (lid != null && node.graph && node.graph.links && node.graph.links[lid]) { try { node.graph.links[lid].target_slot = idx; } catch (_) {} } });
  });

  // ---- 输出：固定「合并提示词」红色圆点在首位 + 卡片输出按序 ----
  let mergedSock = (node.outputs || []).find((o) => o && o._ezMerged);
  if (!mergedSock && (node.outputs || [])[0] && (node.outputs || [])[0].name === 'Merged prompt') {
    mergedSock = (node.outputs || [])[0]; mergedSock._ezMerged = true;
  }
  if (!mergedSock) { node.addOutput('Merged prompt', 'STRING', {}); mergedSock = node.outputs[node.outputs.length - 1]; mergedSock._ezMerged = true; }
  try { mergedSock.label = ''; mergedSock.hideName = true; mergedSock.hidden = false; mergedSock._ezLabel = ezT('Merged prompt'); } catch (_) {}
  if (mergedSock.color_on !== '#d94848') { mergedSock.color_on = '#d94848'; mergedSock.color_off = '#d94848'; mergedSock.color = '#d94848'; }

  const oldOuts = (node.outputs || []).filter((o) => o !== mergedSock);
  const usedOut = new Set();
  const outSeq = [];
  st.cards.forEach((card, idx) => {
    let sock = oldOuts.find((o, i) => !usedOut.has(i) && o._ezCardId != null && String(o._ezCardId) === String(card.id));
    if (!sock) sock = oldOuts.find((o, i) => !usedOut.has(i));
    if (!sock) { node.addOutput(`Card ${idx + 1}`, 'STRING', {}); sock = node.outputs[node.outputs.length - 1]; }
    const oi = oldOuts.indexOf(sock);
    if (oi >= 0) usedOut.add(oi);
    if (sock._ezCardId !== card.id) sock._ezCardId = card.id;
    if (sock.name !== `Card ${idx + 1}`) sock.name = `Card ${idx + 1}`;
    try { sock.label = ''; sock.hideName = true; sock.hidden = false; sock._ezLabel = (card.title || (ezT('Card') + ' ' + (idx + 1))); } catch (_) {}
    outSeq.push(sock);
  });
  oldOuts.forEach((o, i) => {
    if (!usedOut.has(i)) { const idx = node.outputs.indexOf(o); if (idx >= 0) node.removeOutput(idx); }
  });
  const wantOut = [mergedSock, ...outSeq];
  if (node.outputs.length !== wantOut.length || node.outputs.some((o, x) => o !== wantOut[x])) {
    node.outputs.splice(0, node.outputs.length, ...wantOut);
  }
  node.outputs.forEach((o, idx) => {
    linksOf(o).forEach((lid) => { if (lid != null && node.graph && node.graph.links && node.graph.links[lid]) { try { node.graph.links[lid].origin_slot = idx; } catch (_) {} } });
  });

  if (node.graph) node.graph.setDirtyCanvas(true, true);
  return true;
}

// ===== 渲染卡片列表 =====
function attachDnD(container, itemSel, handleSel, onDrop) {
  container.querySelectorAll('.eph-ph').forEach((x) => x.remove());
  const placeholder = el('div', 'eph-ph hidden');
  container.appendChild(placeholder);
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
        if (!same) { if (insertIdx < els.length) els[insertIdx].before(placeholder); else els[els.length - 1].after(placeholder); }
        st.targetIdx = insertIdx;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        if (!st) return;
        if (st.clone && st.clone.parentNode) st.clone.parentNode.removeChild(st.clone);
        placeholder.classList.add('hidden');
        items.forEach((c) => { c.style.opacity = ''; });   // 清掉拖动时临时内联透明度，避免覆盖 .linked 变灰
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
}

// 卡片弹窗开着时，面板 / 总体编辑里改卡片标题要实时反映到弹窗标题上（不用重开）
function syncEditModalTitle(node, card) {
  if (!card || !_editModal || !_editModal.classList.contains('active') || _editModal._node !== node) return;
  if (!_editModal._titleEl || stateFor(node).editingId !== card.id) return;
  _editModal._titleEl.textContent = card.title || ezT('Edit prompt');
}
function buildCardRow(node, card, index) {
  const linked = !!(node._ezLinkedCards && node._ezLinkedCards[card.id]);
  const row = el('div', 'eph-card' + (linked ? ' linked' : '')); row.dataset.id = card.id;
  row.title = (card.title ? card.title + ' — ' : '') + ezT('Click to edit card');
  const handle = el('span', 'eph-handle'); handle.textContent = '⠿';
  const idx = el('span', 'eph-index'); idx.textContent = String(index + 1);
  const ctitle = el('div', 'eph-ctitle');
  const title = el('span', 'eph-ctitle-input'); title.contentEditable = 'true'; title.setAttribute('data-ph', ezT('Title')); title.title = ezT('Card title');
  title.textContent = card.title || '';
  // 输入即更新（实时刷新黑框标签文字，类似 ModelsCombo）；失焦再重排/刷新列表。
  title.addEventListener('input', () => { card.title = title.textContent.replace(/\u200b/g, ''); syncToConfig(node); updateSocketLabels(node, card.id, card.title || ezT('Prompt')); syncEditModalTitle(node, card); });
  title.addEventListener('blur', () => { card.title = title.textContent.replace(/\u200b/g, ''); syncToConfig(node); updatePorts(node); refreshUI(node); });
  ctitle.appendChild(title);
  let badge = null;
  const prov = (card.provider || card.apiUrl) ? (card.provider || 'API') : '';
  if (prov) { badge = el('span', 'eph-badge'); badge.textContent = prov; badge.title = [card.provider, card.model, card.apiUrl].filter(Boolean).join(' · '); }
  if (badge) ctitle.appendChild(badge);
  // 「优 / 默」跟随该卡滑块：在「优化提示词」页签显示优，在「默认」页签显示默
  const ob = el('span', 'eph-badge' + (card.useOptimized ? ' eph-badge-opt' : ''));
  ob.textContent = card.useOptimized ? ezT('Opt') : ezT('Def');
  ob.title = card.useOptimized
    ? ezT('Output uses the "Optimized prompt" tab: ') + (card.contentOptimized ? String(card.contentOptimized).slice(0, 200) : ezT(' (still empty)'))
    : ezT('Output uses the "Default" tab');
  ctitle.appendChild(ob);
  // 预览文字跟随该卡滑块：在「优化提示词」页签显示优化后的正文，在「默认」页签显示默认正文
  const preview = el('span', 'eph-preview'); preview.textContent = (card.useOptimized ? card.contentOptimized : card.content) || '';
  const time = el('span', 'eph-time'); time.textContent = (card.timelineStart && card.timelineEnd) ? `${card.timelineStart}-${card.timelineEnd}s` : '';
  const mg = el('button', 'eph-merge-btn' + (card.mergeOff ? '' : ' on')); mg.textContent = ezT('Merge'); mg.title = ezT('Merge into "Merged prompt": green = merged, gray = not merged');
  mg.addEventListener('click', (e) => { e.stopPropagation(); card.mergeOff = !card.mergeOff; syncToConfig(node); refreshUI(node); });
  const del = el('button', 'eph-del'); del.textContent = '×'; del.title = ezT('Delete card');
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (await uiConfirm(`${ezT('Delete prompt card "')}${card.title || ''}${ezT('"?')}`)) deleteCard(node, card.id);
  });
  //  只有「单点」卡片（无拖动位移）才打开编辑弹窗，避免在标题里拖动误触。
    let _rowDown = null;
  row.addEventListener('pointerdown', (e) => { _rowDown = { x: e.clientX, y: e.clientY }; });
  row.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('.eph-handle') || e.target.closest('[contenteditable]')) return;
    if (_rowDown) { const dx = e.clientX - _rowDown.x, dy = e.clientY - _rowDown.y; if (Math.hypot(dx, dy) > 4) { _rowDown = null; return; } _rowDown = null; }
    openEditModal(node, card.id);
  });
  row.appendChild(handle); row.appendChild(idx); row.appendChild(ctitle); row.appendChild(preview); row.appendChild(time); row.appendChild(mg); row.appendChild(del);
  return row;
}
function updateSocketLabels(node, cardId, label) {
  try {
    (node.inputs || []).forEach((i) => { if (i && i._ezCardId === cardId) i._ezLabel = label; });
    (node.outputs || []).forEach((o) => { if (o && o._ezCardId === cardId) o._ezLabel = label; });
  } catch (_) {}
}

function renderCards(node) {
  const st = stateFor(node);
  const root = node && node._ezRoot;
  if (!root) return;
  const list = root.querySelector('.eph-list');
  if (!list) return;
  list.innerHTML = '';
  if (!st.cards.length) { const e = el('div', 'eph-empty'); e.textContent = ezT('No prompt cards yet. Click "+ Add prompt card" to add.'); list.appendChild(e); return; }
  st.cards.forEach((c, i) => list.appendChild(buildCardRow(node, c, i)));
  attachDnD(list, '.eph-card', '.eph-handle', (from, to) => reorderCard(node, from, to));
  fitNode(node);
}

// ===== 编辑器弹窗 =====
let _editModal = null;
let _phActiveEditor = null;   // 当前居中的富文本编辑器（卡片弹窗 / 总体编辑），供颜色等工具作用到正确的编辑器
  let _editorRange = null;
function saveSelection() { const sel = window.getSelection(); if (sel.rangeCount) _editorRange = sel.getRangeAt(0); }
function restoreSelection() {
  if (!_editorRange) return;
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(_editorRange);
}
// 光标放到编辑器末尾（打开卡片弹窗时用：接着往下写，或直接点「引用媒体」的 + / 打 @，引用都落在末尾）。
function caretToEditorEnd(ed) {
  if (!ed) return;
  try {
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    saveSelection();
  } catch (_) {}
  try { ed.scrollTop = ed.scrollHeight; } catch (_) {}
}
// 工具条「收起 / 展开」：单独一行（工具条与「默认/优化」行中间），无底边小三角；平时隐藏、悬停才显形。
// 状态存节点 config 的 ui（cardToolbar / allToolbar），刷新/重启后保持。
function toolbarToggleRow(getNode, key) {
  const bar = el('div', 'eph-tb-toggle');
  bar.appendChild(el('i'));
  bar.addEventListener('click', (e) => {
    e.stopPropagation();
    const nd = getNode(); if (!nd) return;
    const st = stateFor(nd); st.ui = st.ui || {};
    st.ui[key] = !st.ui[key];
    syncToConfig(nd);
    applyToolbarToggle(bar, st.ui[key]);
  });
  return bar;
}
function applyToolbarToggle(bar, collapsed) {
  if (!bar) return;
  const box = bar.parentNode;
  const tb = box && box.querySelector('.eph-toolbar, .eph-all-toolbar');
  if (tb) tb.classList.toggle('collapsed', !!collapsed);
  const i = bar.querySelector('i');
  if (i) i.style.transform = collapsed ? 'rotate(180deg)' : '';
  bar.title = collapsed ? ezT('Expand toolbar') : ezT('Collapse toolbar');
}
function editModalEl() {
  if (_editModal && _editModal.parentNode) return _editModal;
  _editModal = el('div', 'eph-modal');
  const box = el('div', 'eph-modal-box');
  const hd = el('div', 'eph-modal-hd');
  const t = el('b'); t.textContent = ezT('Edit prompt');
  _editModal._titleEl = t;   // 打开时改成该卡片的自定义名（总体编辑不改）
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  const fullBtn = el('button', 'eph-btn eph-modal-full'); fullBtn.type = 'button'; fullBtn.textContent = ezT('Fullscreen'); fullBtn.title = ezT('Fullscreen / exit fullscreen');
  const hdRight = el('div', 'eph-modal-hd-right');
  hdRight.appendChild(fullBtn); hdRight.appendChild(close);
  hd.appendChild(t); hd.appendChild(hdRight);
  fullBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = _editModal; if (!m) return;
    m.classList.toggle('full');
    fullBtn.textContent = m.classList.contains('full') ? ezT('Exit fullscreen') : ezT('Fullscreen');
    requestAnimationFrame(() => { try { moveTabThumb(); } catch (_) {} });
  });
  // 工具条
    const toolbar = el('div', 'eph-toolbar');
  const tb = (cls, title, cmd, inner) => { const b = el('button', 'eph-tb-btn ' + (cls || '')); b.title = title; b.dataset.cmd = cmd; b.innerHTML = inner; toolbar.appendChild(b); return b; };
  tb('word-glyph bold-glyph', ezT('Bold'), 'bold', '<span>B</span>');
  tb('word-glyph italic-glyph', ezT('Italic'), 'italic', '<span>I</span>');
  tb('word-glyph underline-glyph', ezT('Underline'), 'underline', '<span>U</span>');
  tb('word-glyph strike-glyph', ezT('Strikethrough'), 'strikeThrough', '<span>S</span>');
  tb('', ezT('Align left'), 'justifyLeft', alignSVG('left'));
  tb('', ezT('Align center'), 'justifyCenter', alignSVG('center'));
  tb('', ezT('Align right'), 'justifyRight', alignSVG('right'));
  tb('', ezT('Justify'), 'justifyFull', alignSVG('justify'));

  const fontGroup = el('div', 'eph-tb-group');
  const fontCombo = el('div', 'eph-font-combo');
  const fontInput = el('input'); fontInput.value = '16';
  const fontBtn = el('button'); const fontList = el('ul', 'eph-font-list');
  populateFontList(fontList);
  fontCombo.appendChild(fontInput); fontCombo.appendChild(fontBtn);
  fontGroup.appendChild(fontCombo); fontGroup.appendChild(fontList);
  toolbar.appendChild(fontGroup);

  const colorGroup = el('div', 'eph-tb-group');
  const hlBtn = el('button', 'eph-color-btn'); hlBtn.innerHTML = '<span class="eph-icon-hl"></span><span class="eph-arrow-down"></span>';
  const hlDD = el('div', 'eph-color-dropdown');
  colorGroup.appendChild(hlBtn); colorGroup.appendChild(hlDD);
  const fcBtn = el('button', 'eph-color-btn'); fcBtn.innerHTML = '<span class="eph-icon-a">A</span><span class="eph-arrow-down"></span>';
  const fcDD = el('div', 'eph-color-dropdown');
  colorGroup.appendChild(fcBtn); colorGroup.appendChild(fcDD);
  toolbar.appendChild(colorGroup);

  const indentGroup = el('div', 'eph-indent-group');
  indentGroup.appendChild(el('label')).textContent = ezT('Indent');
  const indentInput = el('input', 'eph-indent-input'); indentInput.value = '0'; indentInput.title = ezT('First-line indent amount (em, applies to the first line of each paragraph)');
  indentGroup.appendChild(indentInput);
  toolbar.appendChild(indentGroup);

  const toolsGroup = el('div', 'eph-tb-group');
  const toolsBtn = el('button', 'eph-btn'); toolsBtn.textContent = ezT('Tools');
  const toolsDD = el('div', 'eph-tools-dropdown');
  toolsGroup.appendChild(toolsBtn); toolsGroup.appendChild(toolsDD);
  toolbar.appendChild(toolsGroup);

  const refGroup = el('div', 'eph-tb-group');
  const refBtn = el('button', 'eph-btn'); refBtn.textContent = ezT('Reference media');
  refGroup.appendChild(refBtn);
  toolbar.appendChild(refGroup);

  const tabDefault = el('button', 'eph-tab active'); tabDefault.textContent = ezT('Default prompt');
  const tabOptimized = el('button', 'eph-tab'); tabOptimized.textContent = ezT('Optimized prompt');

  const body = el('div', 'eph-modal-body');
  const tbToggle = toolbarToggleRow(() => _editModal && _editModal._node, 'cardToolbar');
  body.appendChild(toolbar);
  body.appendChild(tbToggle); _editModal._toolbarToggle = tbToggle;
  const tabThumb = el('span', 'eph-tabs-thumb');
  const editorWrap = el('div', 'eph-tabs');
  editorWrap.appendChild(tabThumb);
  editorWrap.appendChild(tabDefault); editorWrap.appendChild(tabOptimized);
  body.appendChild(editorWrap);
  const editor = el('div', 'eph-editor'); editor.contentEditable = 'true';
  attachMention(editor, () => ({ node: _editModal._node, card: sameNodeCard(_editModal._node) }));
  toolbar.appendChild(skillButton(editor));
  // 「合」放在 skill 后面：绿=合并进「合并提示词」，灰=不进（例如这张卡片是负面提示词/备选）
  const mergeBtn = el('button', 'eph-merge-btn'); mergeBtn.type = 'button'; mergeBtn.textContent = ezT('Merge'); mergeBtn.title = ezT('Merge into "Merged prompt": green = merged, gray = not merged');
  const updMerge = () => { const c = sameNodeCard(_editModal && _editModal._node); mergeBtn.classList.toggle('on', !(c && c.mergeOff)); };
  mergeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nd = _editModal && _editModal._node; const c = sameNodeCard(nd); if (!nd || !c) return;
    c.mergeOff = !c.mergeOff; syncToConfig(nd); updMerge(); refreshUI(nd);   // 同步面板卡片列表上的「合」
  });
  toolbar.appendChild(mergeBtn);
  body.appendChild(editor);

  const ft = el('div', 'eph-modal-ft');
  const timeline = el('div', 'eph-timeline');
  // 左下角：规范「参考卡」（下拉只切换看哪条规范，不写进卡片）+「?」提示
  const ruleRow = el('div', 'eph-rule-row');
  const ruleDD = makeDropdown(ruleDropdownItems(null, false));
  ruleDD.el.classList.add('eph-rule-dd');
  const hintBtn = el('button', 'eph-rule-hint'); hintBtn.type = 'button'; hintBtn.textContent = ezT('Hint'); hintBtn.title = ezT('See writing rules / reference syntax for this spec');
  ruleRow.appendChild(ruleDD.el); ruleRow.appendChild(hintBtn);
  timeline.appendChild(ruleRow);
  ruleDD.addEventListener('change', (v) => {
    const nd = _editModal && _editModal._node; if (!nd) return;
    setNodeRule(nd, v);   // 节点级选择：设置页 / 总体编辑同步
    if (_rulePop && _rulePop._anchor === hintBtn) { const p = openRulePop(hintBtn, nd, { ruleId: v }); p._anchor = hintBtn; }
  });
  hintBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_rulePop && _rulePop._anchor === hintBtn) { closeRulePop(); return; }
    const nd = _editModal && _editModal._node; if (!nd) return;
    const p = openRulePop(hintBtn, nd, { ruleId: ruleDD.value });
    p._anchor = hintBtn;
  });
  _editModal._ruleDD = ruleDD; _editModal._hintBtn = hintBtn; _editModal._updMerge = updMerge;
  ft.appendChild(timeline);
  const cancelBtn = el('button', 'eph-btn eph-btn-cancel'); cancelBtn.textContent = ezT('Cancel');
  const saveBtn = el('button', 'eph-btn eph-btn-save'); saveBtn.textContent = ezT('Save');
  ft.appendChild(timeline);
  const ftBtns = el('div'); ftBtns.style.cssText = 'display:flex;gap:8px;';
  ftBtns.appendChild(cancelBtn); ftBtns.appendChild(saveBtn); ft.appendChild(ftBtns);

  box.appendChild(hd); box.appendChild(body); box.appendChild(ft);
  _editModal.appendChild(box); document.body.appendChild(_editModal);

  // 绑定
  close.addEventListener('click', () => closeEditModal(false));
  cancelBtn.addEventListener('click', () => closeEditModal(false));
  saveBtn.addEventListener('click', () => closeEditModal(true));
  tabDefault.addEventListener('click', () => switchTab('default'));
  tabOptimized.addEventListener('click', () => switchTab('optimized'));
  toolbar.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => execCmd(b.dataset.cmd)));
  fontBtn.addEventListener('click', (e) => { e.stopPropagation(); fontList.classList.toggle('active'); if (fontList.classList.contains('active')) { phFixedDD(fontBtn, fontList); phLayerPush(fontList); } });
  fontInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFontSize(fontInput.value); });
  fontList.addEventListener('click', (e) => { if (e.target.tagName === 'LI') { applyFontSize(e.target.dataset.value); fontInput.value = e.target.textContent; fontList.classList.remove('active'); } });
  indentInput.addEventListener('change', () => applyIndent(indentInput.value));
  hlBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); hlDD.classList.toggle('active'); fcDD.classList.remove('active'); if (hlDD.classList.contains('active')) phCenterPopup(hlDD); });
  fcBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); fcDD.classList.toggle('active'); hlDD.classList.remove('active'); if (fcDD.classList.contains('active')) phCenterPopup(fcDD); });
  toolsBtn.addEventListener('click', (e) => { e.stopPropagation(); toolsDD.classList.toggle('active'); if (toolsDD.classList.contains('active')) phFixedDD(toolsBtn, toolsDD); });
  refBtn.addEventListener('click', (e) => { e.stopPropagation(); openRefBrowser(_editModal._node, editor, sameNodeCard(_editModal._node)); });

  // 颜色下拉 / 工具下拉 / 引用下拉
  initColorDropdown(hlDD, 'highlight');
  initColorDropdown(fcDD, 'font');
  const toolsItems = [[ezT('Find / Replace'), 'find'], [ezT('Full-width to half-width'), 'fullToHalf'], [ezT('Half-width to full-width'), 'halfToFull'],
    [ezT('Optimize prompt (API)'), 'optimize'], [ezT('Optimize prompt (TextGenerate)'), 'textgen'], [ezT('Optimize prompt (llama)'), 'llama']];
  toolsItems.forEach(([label, id]) => {
    const b = el('button', 'eph-tool-item'); b.textContent = label;
    b.addEventListener('click', () => { toolsDD.classList.remove('active'); if (id === 'find') openFindModal('find', _editModal && _editModal._editor); else runTool(id); });
    toolsDD.appendChild(b);
  });
  // 插入引用：改由「引用浏览器」按生成节点分块预览素材后点击插入（见 openRefBrowser）。

  _editModal._box = box; _editModal._editor = editor; _editModal._tabDefault = tabDefault; _editModal._tabOptimized = tabOptimized; _editModal._tabThumb = tabThumb;
  _editModal._fontInput = fontInput; _editModal._fontList = fontList; _editModal._indentInput = indentInput;
  _editModal._hlDD = hlDD; _editModal._fcDD = fcDD; _editModal._toolsDD = toolsDD;
  [fontList, hlDD, fcDD, toolsDD].forEach((el) => { if (el && el.classList.contains('active')) phLayerPush(el); });
  editor.addEventListener('keyup', saveSelection);
  editor.addEventListener('mouseup', saveSelection);
  // 点击弹窗外（backdrop）→ 关闭并保存；卡片内部拖动到外面松开不关闭（避免误关）。
  // _phDownTarget 守卫：全屏浮层（图片查看器/取色器）在 mousedown 时就把自己藏起来了，鼠标松开时命中的会变成下层弹窗，
  // 若不比对按下目标，就会“一次点击连关两层”。
  let _ecStartInBox = false;
  _editModal.addEventListener('mousedown', (e) => { _ecStartInBox = box.contains(e.target); });
  _editModal.addEventListener('mouseup', (e) => { if (!_editModal.classList.contains('ph-dock') && e.target === _editModal && _phDownTarget === _editModal && !_ecStartInBox && (_phClosedEl === null || _phClosedEl === _editModal)) closeEditModal(true); _ecStartInBox = false; });
  _editModal._phOnClose = () => { try { phDockRemember(_editModal._node); } catch (_) {} };   // 点外侧关掉时也把平铺状态记回 config
  return _editModal;
}

function openEditModal(node, cardId) {
  const st = stateFor(node);
  const card = st.cards.find((c) => c.id === cardId);
  if (!card) return;
  st.editingId = cardId;
  const tab = card.editTab || 'default';   // 记住上次所选页签
    st.currentTab = tab;
  const m = editModalEl(); m._node = node;
  if (m._titleEl) m._titleEl.textContent = card.title || ezT('Edit prompt');
  if (tab === 'optimized') {
    m._tabOptimized.classList.add('active'); m._tabDefault.classList.remove('active');
    m._editor.innerHTML = card.contentOptimizedHTML || card.contentOptimized || '';
  } else {
    m._tabDefault.classList.add('active'); m._tabOptimized.classList.remove('active');
    m._editor.innerHTML = card.contentHTML || card.content || '';
  }
  if (m._ruleDD) { m._ruleDD.setItems(ruleDropdownItems(node, false)); m._ruleDD.value = _normRuleId(phRulesModel(node).ruleId) || 'none'; }
  if (m._updMerge) m._updMerge();
  m._indentInput.value = String(card.indent || 0);
  if (m._toolbarToggle) applyToolbarToggle(m._toolbarToggle, !!(stateFor(node).ui && stateFor(node).ui.cardToolbar));
  m.classList.add('active');
  phDockApply(m, node);
  _phActiveEditor = m._editor;
  requestAnimationFrame(moveTabThumb);
  // applyIndent 会重建编辑器 DOM（光标丢失），所以重建完再把光标放到末尾：接着写 / 插引用都在末尾
  setTimeout(() => { try { applyIndent(m._indentInput.value); m._editor.focus(); caretToEditorEnd(m._editor); } catch (_) {} }, 100);
}
function switchTab(tab) {
  const nd = _editModal && _editModal._node;
  if (!nd) return;
  const st = stateFor(nd);
  const card = st.cards.find((c) => c.id === st.editingId);
  if (!card) return;
  if (st.currentTab !== tab) {
    // 切页签前先把当前页签未保存内容写回卡片
        const html = _editModal._editor.innerHTML; const plain = plainTextOf(html);
    if (st.currentTab === 'optimized') { card.contentOptimizedHTML = html; card.contentOptimized = plain; }
    else { card.contentHTML = html; card.content = plain; }
  }
  st.currentTab = tab;
  card.editTab = tab;   // 记住本次所选页签
    card.useOptimized = (tab === 'optimized');   // 滑块决定输出用默认还是优化
    syncToConfig(nd);
  refreshUI(nd);   // 卡片列表的预览文字 / 优默标记跟着滑块走
  if (tab === 'default') {
    _editModal._tabDefault.classList.add('active'); _editModal._tabOptimized.classList.remove('active');
    _editModal._editor.innerHTML = card.contentHTML || card.content || '';
  } else {
    _editModal._tabOptimized.classList.add('active'); _editModal._tabDefault.classList.remove('active');
    _editModal._editor.innerHTML = card.contentOptimizedHTML || card.contentOptimized || '';
  }
  requestAnimationFrame(moveTabThumb);
  // 切页签会把编辑器内容整段换掉（光标跟着丢），跟打开弹窗一样把光标落回正文末尾
  try { applyIndent(_editModal._indentInput.value); _editModal._editor.focus(); caretToEditorEnd(_editModal._editor); } catch (_) {}
}
function closeEditModal(save) {
  const nd = _editModal && _editModal._node;
  if (save && nd) {
    const st = stateFor(nd);
    const card = st.cards.find((c) => c.id === st.editingId);
    if (card) {
      const html = _editModal._editor.innerHTML;
      const plain = plainTextOf(html);
      if (st.currentTab === 'optimized') { card.contentOptimizedHTML = html; card.contentOptimized = plain; }
      else { card.contentHTML = html; card.content = plain; }
      card.indent = parseFloat(_editModal._indentInput.value) || 0;
      syncToConfig(nd); updatePorts(nd); refreshUI(nd);
    }
    st.editingId = null;
  }
  _phActiveEditor = null;
  _editModal && _editModal.classList.remove('active');
  try { phDockRemember(nd); } catch (_) {}
}
function moveTabThumb() {
  const m = _editModal;
  if (!m || !m.classList || !m.classList.contains('active')) return;
  const active = m.querySelector('.eph-tab.active');
  const thumb = m.querySelector('.eph-tabs-thumb');
  if (!active || !thumb) return;
  thumb.style.left = active.offsetLeft + 'px';
  thumb.style.width = active.offsetWidth + 'px';
}
function execCmd(cmd, val = null) { const ed = _editModal && _editModal._editor; if (ed) { ed.focus(); document.execCommand(cmd, false, val); saveSelection(); } }
function populateFontList(list) {
  if (!list || list._populated) return; list._populated = true;
  const sizeMap = { [ezT('Chuhao')]: '48px', [ezT('Xiaochu')]: '36px', [ezT('No. 1')]: '26pt', [ezT('No. 1 Small')]: '24pt', [ezT('No. 2')]: '22pt', [ezT('No. 2 Small')]: '18pt', [ezT('No. 3')]: '16pt', [ezT('No. 3 Small')]: '15pt', [ezT('No. 4')]: '14pt', [ezT('No. 4 Small')]: '12pt', [ezT('No. 5')]: '10.5pt', [ezT('No. 5 Small')]: '9pt' };
  Object.keys(sizeMap).forEach((label) => { const li = el('li'); li.textContent = label; li.dataset.value = sizeMap[label]; list.appendChild(li); });
  [5, 6.5, 8, 9, 10.5, 12, 14, 16, 18, 22, 26, 36, 48, 72].forEach((n) => { const li = el('li'); li.textContent = String(n); li.dataset.value = n + 'px'; list.appendChild(li); });
}
function applyFontSize(val) {
  const ed = _editModal && _editModal._editor; if (!ed) return;
  ed.focus(); const sel = window.getSelection();
  if (sel.isCollapsed) { const r = document.createRange(); r.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(r); }
  document.execCommand('fontSize', false, '7'); document.execCommand('fontName', false, '');
  // 统一改用 span 内联 fontSize 更稳
  ed.querySelectorAll('font[size="7"]').forEach((f) => { const s = document.createElement('span'); s.style.fontSize = val; s.innerHTML = f.innerHTML; f.replaceWith(s); });
  saveSelection();
}
function applyIndent(val) {
  const ed = _editModal && _editModal._editor; if (!ed) return;
  const n = parseFloat(val) || 0;
  // 首行缩进（Word 式）：对每个「回车产生的段落块」设  text-indent，首行缩进、换行不缩进。
    const blocks = _collectBlocks(ed);
  ed.innerHTML = '';
  const out = blocks.map((arr) => {
    let block;
    if (arr.length === 1 && arr[0] && arr[0].nodeType === 1 && (arr[0].tagName === 'DIV' || arr[0].tagName === 'P')) block = arr[0];
    else { block = document.createElement('div'); arr.forEach((x) => block.appendChild(x)); }
    if (n) block.style.textIndent = n + 'em'; else block.style.textIndent = '';
    return block;
  });
  out.forEach((b) => ed.appendChild(b));
  if (_editModal._indentInput && _editModal._indentInput.value !== String(n)) _editModal._indentInput.value = String(n);
  ed.focus();
}
// 把 contenteditable 编辑器内容切成「段落」数组（每个 = 一组顶部节点）。
// 块元素 DIV/P/LI；回车产生的块元素与裸文本 \n 作为段落分隔；<br> 是段内软换行（留在段内，不缩进）。
  function _collectBlocks(ed) {
  const paras = [];
  let cur = [];
  const flush = () => { if (cur.length) { paras.push(cur); cur = []; } };
  Array.from(ed.childNodes).forEach((node) => {
    if (node.nodeType === 3) {
      node.textContent.split('\n').forEach((p, i) => { if (i > 0) flush(); if (p) cur.push(document.createTextNode(p)); });
    } else if (node.nodeType === 1) {
      const tag = node.tagName;
      if (tag === 'DIV' || tag === 'P' || tag === 'LI') { flush(); paras.push([node]); }
      else if (tag === 'BR') { cur.push(node); }
      else cur.push(node); // 内联元素整体并入当前段（含 <br>  软换行）
    } else { cur.push(node); }
  });
  flush();
  return paras;
}
function applyColorOn(ed, target, color) {
  if (!ed) return;
  const prop = target === 'highlight' ? 'backgroundColor' : 'color';
  const clear = (target === 'highlight') && (color === 'transparent' || color === '');
  const sel = window.getSelection();
  const hasSel = !!(sel.rangeCount && !sel.isCollapsed && ed.contains(sel.getRangeAt(0).commonAncestorContainer));
  // ── 清除高亮：有选区只清选区；没选中清整块（所有卡片正文） ──
  if (clear) {
    if (hasSel) {
      const range = sel.getRangeAt(0);
      const root = range.commonAncestorContainer;
      const node = (root && root.nodeType === 1) ? root : (root && root.parentElement);
      if (node && node.querySelectorAll) node.querySelectorAll('span,font').forEach((sp) => { try { if (sp.style && sp.style.backgroundColor && range.intersectsNode(sp)) { sp.style.backgroundColor = ''; if (!sp.getAttribute('style')) sp.removeAttribute('style'); } } catch (_) {} });
    } else {
      ed.querySelectorAll('span,font').forEach((sp) => { try { if (sp.style && sp.style.backgroundColor) { sp.style.backgroundColor = ''; if (!sp.getAttribute('style')) sp.removeAttribute('style'); } } catch (_) {} });
    }
    ed.focus();
    return;
  }
  ed.focus();
  // ── 上色：有选区只改选区；没选中则整块（卡片编辑器整段 / 总体编辑每张卡片正文） ──
  if (hasSel) {
    const range = sel.getRangeAt(0);
    const sp = document.createElement('span'); sp.style[prop] = color;
    try { const frag = range.extractContents(); sp.appendChild(frag); range.insertNode(sp); } catch (_) {}
    sel.removeAllRanges();
    return;
  }
  const bodies = ed.querySelectorAll ? ed.querySelectorAll('.eph-all-block-body') : [];
  if (bodies.length) { bodies.forEach((b) => _wrapStyle(b, prop, color, prop)); ed.focus(); return; }
  const range = document.createRange(); range.selectNodeContents(ed);
  const sp = document.createElement('span'); sp.style[prop] = color;
  try { const frag = range.extractContents(); sp.appendChild(frag); range.insertNode(sp); }
  catch (_) { const sp2 = document.createElement('span'); sp2.style[prop] = color; while (ed.firstChild) sp2.appendChild(ed.firstChild); ed.appendChild(sp2); }
  sel.removeAllRanges(); saveSelection && saveSelection();
}
function _phActiveEd() {
  try { if (_editModal && _editModal.classList.contains('active') && _editModal._editor) return _editModal._editor; } catch (_) {}
  try { if (_allModal && _allModal.classList.contains('active') && _allModal._ed) return _allModal._ed; } catch (_) {}
  return _phActiveEditor || (_editModal && _editModal._editor) || null;
}
function applyColor(target, color) {
  applyColorOn(_phActiveEd(), target, color);
}
function insertText(text) {
  const ed = _editModal && _editModal._editor; if (!ed) return;
  ed.focus(); restoreSelection();
  document.execCommand('insertText', false, text);
  saveSelection();
}
function runTool(id) {
  const ed = _editModal && _editModal._editor;
  if (!ed) return;
  const text = ed.textContent;
  if (id === 'fullToHalf') {
    // 只把全角标点 + 全角空格 转半角，不碰字母/数字/文字。
    const map = { '，': ',', '。': '.', '！': '!', '？': '?', '：': ':', '；': ';', '“': '"', '”': '"', '‘': "'", '’': "'", '（': '(', '）': ')', '【': '[', '】': ']', '《': '<', '》': '>', '、': ',', '—': '-', '～': '~' };
    ed.textContent = text.replace(/[，。！？：；“”‘’（）【】《》、—～]/g, (ch) => map[ch] || ch).replace(/\u3000/g, ' ');
    saveSelection(); return;
  }
  if (id === 'halfToFull') {
    // 把半角标点转全角，不碰字母/数字/文字/空格。
    const map = { ',': '，', '.': '。', '!': '！', '?': '？', ':': '：', ';': '；', '"': '“', "'": '‘', '(': '（', ')': '）', '[': '【', ']': '】', '<': '《', '>': '》', '~': '～', '-': '—' };
    ed.textContent = text.replace(/[,\.!\?:;"'\(\)\[\]<>~-]/g, (ch) => map[ch] || ch);
    saveSelection(); return;
  }
  if (id === 'optimize' || id === 'textgen' || id === 'llama') { runOptimize(id, ed); }
}
// ===== 优化调用进度弹窗 =====
let _phProg = null;
function phProgEl(node) {
  if (_phProg && _phProg.parentNode) return _phProg;
  _phProg = el('div', 'eph-prog');
  const hd = el('div', 'eph-prog-hd');
  const title = el('span', 'eph-prog-title'); title.textContent = ezT('Settings');
  const count = el('span', 'eph-prog-count'); count.textContent = '';
  const close = el('button', 'eph-prog-close'); close.textContent = '✕'; close.title = ezT('Close progress');
  hd.appendChild(title); hd.appendChild(count); hd.appendChild(close);
  const bar = el('div', 'eph-prog-bar'); const fill = el('div', 'eph-prog-fill'); bar.appendChild(fill);
  const detail = el('div', 'eph-prog-detail');
  _phProg.appendChild(hd); _phProg.appendChild(bar); _phProg.appendChild(detail);
  _phProg._title = title; _phProg._count = count; _phProg._fill = fill; _phProg._detail = detail;
  _phProg.addEventListener('click', (e) => { if (e.target === close) { phProgHide(); return; } _phProg.classList.toggle('open'); });
  close.addEventListener('click', (e) => { e.stopPropagation(); phProgHide(); });
  document.body.appendChild(_phProg);
  return _phProg;
}
function phProgPos(node) {
  const m = phProgEl(node);
  try { m.style.left = Math.max(16, (window.innerWidth - 290) / 2) + 'px'; m.style.top = '70px'; } catch (_) {}
}
function phProgShow(node, total, method) {
  const m = phProgEl(node);
  m._total = Math.max(1, total | 0);
  m._done = 0;
  m._title.textContent = (method ? method + ' · ' : '') + ezT('Optimizing');
  m._count.textContent = m._total > 1 ? ('0/' + m._total) : '';
  m._fill.style.width = '0%';
  m._fill.className = 'eph-prog-fill' + (m._total > 1 ? '' : ' indeterminate');
  m._detail.innerHTML = '';
  if (m._hideTimer) { clearTimeout(m._hideTimer); m._hideTimer = null; }   // 上一轮的自动收起作废
  m.classList.add('active'); m.classList.remove('open');
  phProgPos(node);
}
function phProgTick(node, done, label) {
  const m = phProgEl(node);
  m._done = done;
  const pct = Math.round(done / m._total * 100);
  m._fill.style.width = pct + '%';
  if (m._total > 1) { m._count.textContent = done + '/' + m._total; m._fill.className = 'eph-prog-fill'; }
  if (label) { const line = el('div', 'eph-prog-line'); line.textContent = '✓ ' + label; m._detail.appendChild(line); }
}
function phProgErr(node, msg) {
  const m = phProgEl(node);
  m._title.textContent = ezT('Call failed');
  m._fill.style.width = '100%'; m._fill.className = 'eph-prog-fill'; m._fill.style.background = '#e34d4d';
  const line = el('div', 'eph-prog-line err'); line.textContent = '✕ ' + msg; m._detail.appendChild(line);
  // 失败信息留 6 秒后自动收起：否则它一直浮在卡片弹窗上层，挡住编辑器点不进去
  if (m._hideTimer) clearTimeout(m._hideTimer);
  m._hideTimer = setTimeout(() => { m._hideTimer = null; phProgHide(); }, 6000);
}
function phProgDone(node) {
  const m = phProgEl(node);
  m._fill.className = 'eph-prog-fill'; m._fill.style.width = '100%';
  if (m._total > 1) { m._count.textContent = m._total + '/' + m._total; }
  m._title.textContent = ezT('Done');
  if (m._hideTimer) clearTimeout(m._hideTimer);
  m._hideTimer = setTimeout(() => { m._hideTimer = null; phProgHide(); }, 1200);
}
function phProgHide() { if (_phProg) { _phProg.classList.remove('active'); _phProg.classList.remove('open'); } }
// 把下拉定位到按钮正下方（fixed，永不裁剪），解决「颜色/工具在弹窗下面操作不了」的层叠问题。
function phFixedDD(btn, dd) {
  if (!btn || !dd) return;
  if (dd.parentNode && dd.parentNode !== document.body) document.body.appendChild(dd);
  dd.style.position = 'fixed'; dd.style.zIndex = '100080'; dd.style.pointerEvents = 'auto';
  try { const r = btn.getBoundingClientRect(); dd.style.left = r.left + 'px'; dd.style.top = (r.bottom + 4) + 'px'; } catch (_) {}
}
// 颜色更可靠：居中弹出（不再受弹窗层叠/位置影响）。
function phCenterPopup(dd) {
  if (!dd) return;
  if (dd.parentNode && dd.parentNode !== document.body) document.body.appendChild(dd);
  dd.style.position = 'fixed'; dd.style.zIndex = '100090'; dd.style.pointerEvents = 'auto';
  try { const w = dd.offsetWidth || 210, h = dd.offsetHeight || 200; dd.style.left = Math.max(10, (window.innerWidth - w) / 2) + 'px'; dd.style.top = Math.max(10, (window.innerHeight - h) / 2) + 'px'; } catch (_) {}
}
// ===== 媒体引用：画布媒体 + 悬停预览 + 点击查看（编号见下）=====

// ===== 媒体引用编号：编号表由画布上「生成节点的媒体输入端口」实时给出（每个生成节点一张，互不冲突）=====
// 每个提示词卡片绑定一个生成节点（card.refTarget，缺省用画布上第一个接入素材的生成节点），编号按该节点自己的端口表算。
// ===== 媒体引用编号：编号表由「生成节点的媒体输入端口」实时给出（每个生成节点一张，互不冲突）=====
// 没有接入任何生成节点的素材不编号：@ 菜单里标黄、且不能插入。
function mediaRefLabel(m, targetId) {
  const hit = mediaIndex(mediaKeyOf(m), targetId);
  return hit ? hit.label : '';
}
// 接线/换素材后编号表会变：把编辑器里已插入的 @引用芯片同步成新编号（同一个素材始终同一个号）。
function refreshMediaChips() {
  const editors = new Set();
  document.querySelectorAll('.eph-mref').forEach((sp) => {
    const hit = mediaIndex(sp.dataset.key || sp.dataset.path || sp.dataset.url || '', sp.dataset.target || '');
    const lab = sp.querySelector('.eph-mref-txt');
    if (!hit || (lab ? lab.textContent : sp.textContent) === hit.label) return;
    sp.dataset.n = String(hit.n);
    if (lab) lab.textContent = hit.label; else sp.textContent = hit.label;
    if (hit.tag) { sp.dataset.tag = hit.tag; sp.title = ezT('Target node reference tag: ') + hit.tag; }
    const ed = sp.closest ? sp.closest('.eph-editor, .eph-all-editor') : null;
    if (ed) editors.add(ed);
  });
  editors.forEach((ed) => ed.dispatchEvent(new Event('input', { bubbles: true })));
}
// 该编辑器里这个素材的引用芯片（可能有多个——同一个媒体允许在提示词里被引用多次）
function mediaChipsOf(ed, m) {
  const out = [];
  if (!ed) return out;
  const key = mediaKeyOf(m);
  if (!key) return out;
  ed.querySelectorAll('.eph-mref').forEach((c) => { if ((c.dataset.key || c.dataset.path || c.dataset.url) === key) out.push(c); });
  return out;
}
// 插入一份引用芯片（每次调用都插入一份：同一媒体可多次引用）。返回是否插入成功。
function insertMediaRefOnce(ed, m, targetId) {
  if (!ed) return false;
  const hit = mediaIndex(mediaKeyOf(m), targetId);
  const label = (hit && hit.label) || mediaRefLabel(m, targetId);
  if (!label) return false;   // 没接入生成节点的素材没有编号，不插入
  const t = indexTargetById(targetId);
  const sp = el('span', 'eph-mref'); sp.contentEditable = 'false';
  sp.dataset.url = m.url || ''; sp.dataset.type = m.type || 'image'; sp.dataset.name = m.name || ''; sp.dataset.path = m.path || '';
  sp.dataset.key = mediaKeyOf(m); sp.dataset.n = String(label.replace(/[^\d]/g, ''));
  if (hit) { sp.dataset.target = hit.targetId; sp.dataset.tag = hit.tag || ''; sp.title = hit.targetKey + ' · ' + hit.port + (hit.tag ? ' → ' + hit.tag : ''); }
  else if (t) sp.title = t.title;
  const lab = el('span', 'eph-mref-txt'); lab.textContent = label; sp.appendChild(lab);
  // 芯片带 MediaOut 同款类型小图标（图像/视频/音频/模型），图标沿用芯片的蓝色，放在 @xx 之后
  const ico = el('span', 'eph-mref-ico'); ico.innerHTML = mediaIcon(m.type || 'image'); sp.appendChild(ico);
  // 按 Range 直接插「芯片 + 逗号」，并把光标放到逗号后面。
  // （用 execCommand('insertHTML') 时，不可编辑的芯片会把光标留在芯片前面，还可能多包一层块导致自动换行）
  let range = null;
  try { if (_editorRange && ed.contains(_editorRange.commonAncestorContainer)) { range = _editorRange.cloneRange(); range.collapse(false); } } catch (_) { range = null; }
  if (!range) { range = document.createRange(); range.selectNodeContents(ed); range.collapse(false); }
  const comma = document.createTextNode(',');
  try {
    range.insertNode(sp); range.setStartAfter(sp); range.collapse(true);
    range.insertNode(comma); range.setStart(comma, 1); range.collapse(true);
  } catch (_) {
    const r2 = document.createRange(); r2.selectNodeContents(ed); r2.collapse(false);
    r2.insertNode(sp); r2.setStartAfter(sp); r2.collapse(true);
    r2.insertNode(comma); r2.setStart(comma, 1); r2.collapse(true);
    range = r2;
  }
  ed.focus();
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  saveSelection(); ed.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

// ===== 引用浏览器：一个生成节点一块，块内是该节点各媒体端口上的素材预览，点一下就把 @引用 插进提示词 =====
let _refBrowser = null;
function sameNodeCard(node) {
  if (!node) return null;
  try { const st = stateFor(node); return st.cards.find((c) => c.id === st.editingId) || null; } catch (_) { return null; }
}
// 总体编辑里光标所在块对应的卡片
function caretCard(node) {
  try {
    const st = stateFor(node); const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return st.cards[0] || null;
    let n = sel.getRangeAt(0).startContainer;
    while (n && n.nodeType === 3) n = n.parentNode;
    const blk = n && n.closest ? n.closest('.eph-all-block') : null;
    if (!blk) return st.cards[0] || null;
    return st.cards[parseInt(blk.dataset.idx, 10)] || st.cards[0] || null;
  } catch (_) { return null; }
}
// 引用目标只体现在「引用媒体」窗口里（选中的生成节点卡片标浅绿），工具条上不做任何提示。
// 引用媒体窗口的收尾：停掉窗口里正在播放的视频/音频，并顺手关掉放大预览层。
function refBrowserCleanup() {
  stopMediaIn(_refBrowser);
  if (_mvModal && _mvModal.classList.contains('active')) phMediaViewerStop();
}
function refBrowserEl() {
  if (_refBrowser && _refBrowser.parentNode) return _refBrowser;
  _refBrowser = el('div', 'eph-rb');
  const box = el('div', 'eph-rb-box');
  const hd = el('div', 'eph-rb-hd');
  const t = el('b'); t.textContent = ezT('Reference media');
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  hd.appendChild(t); hd.appendChild(close);
  const body = el('div', 'eph-rb-body');
  box.appendChild(hd); box.appendChild(body);
  _refBrowser.appendChild(box); document.body.appendChild(_refBrowser);
  _refBrowser._box = box; _refBrowser._body = body;
  const closeBrowser = () => { refBrowserCleanup(); _refBrowser.classList.remove('active'); try { phDockRemember(_refBrowser._node); } catch (_) {} };
  _refBrowser._close = closeBrowser;
  _refBrowser._phOnClose = () => { refBrowserCleanup(); try { phDockRemember(_refBrowser._node); } catch (_) {} };   // 点外侧时由层协调器调用（只关这一层，不连带关下面的弹窗）
  close.addEventListener('click', closeBrowser);
  phLayerPush(_refBrowser);
  return _refBrowser;
}
const MEDIA_SHORT = { image: 'Image', video: 'Video', audio: 'Audio', model: 'Model' };
// 素材卡片：预览效果对齐 EzFlex-MediaLoader（左上类型角标 / 悬停信息条 / 视频播放 / 音频播放器），
// 引用数量变化后刷新所有卡片上的计数/按钮状态（同一个素材可能插了多份）
function refreshRefTiles() {
  const l = (_refBrowser && _refBrowser._refreshers) || [];
  l.forEach((f) => { try { f(); } catch (_) {} });
}
// 右上角是 ModelsCombo 同款 +/− 按钮：＋ 每次插入一份引用（同一个素材可多次引用），− 移除一份。
function rbTile(ed, node, card, target, port, m) {
  const tile = el('div', 'eph-rb-tile');
  const pv = el('div', 'eph-rb-pv');
  const type = port.type;
  if (type === 'image') {
    const im = el('img'); im.src = m.url; im.alt = m.name || ''; im.loading = 'lazy'; im.draggable = false; pv.appendChild(im);
  } else if (type === 'video') {
    const v = document.createElement('video'); v.src = m.url; v.muted = true; v.preload = 'metadata'; pv.appendChild(v);
    const play = el('button', 'eph-rb-play'); play.textContent = '▶'; play.title = ezT('Play preview');
    v.addEventListener('play', () => { v.controls = true; tile.classList.add('playing'); play.textContent = '❚❚'; });
    v.addEventListener('pause', () => { v.controls = false; tile.classList.remove('playing'); play.textContent = '▶'; });
    play.addEventListener('click', (e) => { e.stopPropagation(); try { if (v.paused) { v.muted = false; v.play(); } else v.pause(); } catch (_) {} });
    pv.appendChild(play);
  } else if (type === 'audio') {
    const ap = makeAudioPlayer(m.url); ap.style.cssText = 'width:100%;'; pv.appendChild(ap);
  } else {
    const ph = el('span', 'eph-rb-ph'); ph.textContent = '🧊'; pv.appendChild(ph);
  }
  const badge = el('span', 'eph-rb-type');
  const bico = el('span', 'eph-rb-type-ico'); bico.innerHTML = mediaIcon(type); badge.appendChild(bico);
  badge.appendChild(document.createTextNode(ezT(MEDIA_SHORT[type] || 'File'))); pv.appendChild(badge);
  const addBtn = el('button', 'eph-rb-add');
  const info = el('div', 'eph-rb-info');
  const fn = el('div', 'eph-rb-fname'); fn.textContent = m.name || m.path || ''; fn.title = m.path || '';
  const meta = el('div', 'eph-rb-fmeta');
  const sz = el('span'); sz.textContent = mediaSizeText(m.size);
  const sf = el('span', 'eph-rb-suffix'); sf.textContent = mediaFormatOf(m) ? '.' + mediaFormatOf(m) : '';
  meta.appendChild(sz); meta.appendChild(sf);
  info.appendChild(fn); info.appendChild(meta); pv.appendChild(info);
  tile.appendChild(pv);
  const foot = el('div', 'eph-rb-foot');
  const lab = el('span', 'eph-rb-lab'); lab.textContent = port.label;
  const cnt = el('span', 'eph-rb-cnt'); cnt.style.display = 'none';
  const minus = el('button', 'eph-rb-minus'); minus.textContent = '−'; minus.title = ezT('Remove one reference');
  foot.appendChild(lab);
  // 本卡片的引用目标不是这个生成节点时，插进去的号会按目标节点算：把「实际插入的号」也标出来，免得看着对不上。
  const insLabel = (cardRefId(card) && cardRefId(card) !== String(target.id))
    ? (mediaIndex(mediaKeyOf(m), cardRefId(card)) || {}).label || '' : '';
  if (insLabel && insLabel !== port.label) {
    const ins = el('span', 'eph-rb-ins'); ins.textContent = '→ ' + insLabel;
    ins.title = ezT('The reference target of this card is not "') + (target.title || target.type) + ezT('"; clicking + inserts the number from the target node ') + insLabel;
    foot.appendChild(ins);
  }
  foot.appendChild(cnt); foot.appendChild(minus);
  tile.appendChild(foot);
  const refresh = () => {
    const n = mediaChipsOf(ed, m).length;
    addBtn.textContent = '+';
    addBtn.classList.toggle('added', n > 0);
    addBtn.title = n ? (ezT('Insert another reference (already referenced ') + n + ezT(' times)')) : ezT('Insert this reference');
    tile.classList.toggle('added', n > 0);
    cnt.style.display = n ? '' : 'none';
    cnt.textContent = '×' + n;
    minus.style.display = n ? '' : 'none';
  };
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // 编号一定要按「本卡片的引用目标」算：同一个素材可能同时接在多个生成节点上（都编号 @图片1），
    // 而这张卡片的提示词只会喂给它自己的目标节点，用素材所在节点的号会串号。
    // 卡片没设引用目标时，才退回用素材所在节点。
    const want = cardRefId(card) || target.id;
    if (!insertMediaRefOnce(ed, m, want)) {
      const tn = indexTargetById(want);
      rbHint(ezT('Media "') + (m.name || m.path || '') + ezT('" is not on an input port of the reference target "') + ((tn && tn.title) || want) + ezT('" of this card, so the inserted @number will not match: connect the media to that generator node, or right-click "')
        + (target.title || target.type) + ezT('" to set it as the reference target of this card.'));
      return;
    }
    refreshRefTiles();
    tile.classList.add('flash'); setTimeout(() => tile.classList.remove('flash'), 420);
  });
  minus.addEventListener('click', (e) => {
    e.stopPropagation();
    const list = mediaChipsOf(ed, m);
    const last = list[list.length - 1];
    if (last) {
      const nxt = last.nextSibling;
      if (nxt && nxt.nodeType === 3 && nxt.nodeValue === ',') nxt.remove();
      last.remove();
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    }
    refreshRefTiles();
  });
  // 点卡片本体 = 放大预览（同 MediaLoader），插/移引用用右上角 +/− 按钮。
  tile.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('audio') || e.target.closest('.ez-ap')) return;
    const vid = tile.querySelector('video'); if (vid && !vid.paused) return;
    if (type === 'audio') return;
    if (type === 'model') { window.open(m.url, '_blank'); return; }
    phMediaViewer(m.url, type, m.name);
  });
  refresh();
  tile.title = port.name + (port.tag ? ' → ' + port.tag : '') + (insLabel ? ezT(' (click + to insert ') + insLabel + ezT(': numbered by the reference target of this card)') : '');
  pv.appendChild(addBtn);
  // 别的卡片/端口插入后，本卡的计数也要跟着变
  if (!_refBrowser._refreshers) _refBrowser._refreshers = [];
  _refBrowser._refreshers.push(refresh);
  return tile;
}
// 引用媒体窗口里的一条提示（比如「该素材不在本卡片的引用目标上」），几秒后自动消失。
let _rbHintTimer = 0;
function rbHint(text) {
  const m = _refBrowser;
  if (!m || !m._body) return;
  let h = m._body.querySelector('.eph-rb-hint');
  if (!h) { h = el('div', 'eph-rb-hint'); m._body.insertBefore(h, m._body.firstChild); }
  h.textContent = text;
  if (_rbHintTimer) clearTimeout(_rbHintTimer);
  _rbHintTimer = setTimeout(() => { try { h.remove(); } catch (_) {} }, 3600);
}
// 本卡片引用的生成节点 id（'' = 都不引用/未选）
function cardRefId(card) { return (card && card.refTarget) ? String(card.refTarget) : ''; }
// 设为「总体引用库」：所有卡片都引用这个生成节点（右键菜单）。
function setGlobalRefTarget(node, targetId) {
  const st = node ? stateFor(node) : null;
  if (!st) return;
  st.cards.forEach((c) => { c.refTarget = targetId ? String(targetId) : ''; });
  syncToConfig(node);
  refreshMediaChips();
}
// 引用媒体窗口的右键菜单（一个生成节点卡片 = 一个菜单）
let _rbMenu = null;
function rbMenuEl() {
  if (_rbMenu && _rbMenu.parentNode) return _rbMenu;
  _rbMenu = el('div', 'eph-tools-dropdown eph-ctx');
  _rbMenu.style.position = 'fixed';
  document.body.appendChild(_rbMenu);
  phLayerPush(_rbMenu);
  return _rbMenu;
}
function hideRbMenu() { if (_rbMenu) _rbMenu.classList.remove('active'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideRbMenu(); }, true);
function openRbMenu(x, y, node, card, target, ed) {
  const menu = rbMenuEl();
  menu.innerHTML = '';
  const st = stateFor(node);
  const total = (st.cards || []).length;
  const allSet = total > 0 && (st.cards || []).every((c) => cardRefId(c) === String(target.id));
  const item = (label, fn, tip) => {
    const b = el('button', 'eph-tool-item'); b.type = 'button'; b.textContent = label;
    if (tip) b.title = tip;
    b.addEventListener('click', () => { hideRbMenu(); fn(); });
    menu.appendChild(b);
    return b;
  };
  const sep = (text) => { const d = el('div', 'eph-tools-sep'); d.textContent = text; menu.appendChild(d); };
  sep((target.title || target.type) + ' · #' + target.id);
  item(ezT('Set as global reference source (all ') + total + ezT(' cards use it)'), () => {
    setGlobalRefTarget(node, target.id);
    renderRefBrowser(node, ed, card);
  }, ezT('Set the reference target of every prompt card to this node'));
  if (allSet) item(ezT('Clear global reference (no card references anything)'), () => {
    setGlobalRefTarget(node, '');
    renderRefBrowser(node, ed, card);
  }, ezT('No card sets a reference target (numbering falls back to automatic: the first generator node with media on the canvas)'));
  item(cardRefId(card) === String(target.id) ? ezT('This card stops referencing it') : ezT('Only this card references it'), () => {
    if (card) { card.refTarget = cardRefId(card) === String(target.id) ? '' : String(target.id); syncToConfig(node); }
    renderRefBrowser(node, ed, card);
  });
  menu.classList.add('active');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
}
function renderRefBrowser(node, ed, card) {
  const m = refBrowserEl();
  if (m._building) return;   // 防重入：refreshIndexNow 会同步通知监听者回调本函数，只用外层那次的结果
  m._building = true;
  try {
  m._node = node; m._ed = ed; m._card = card;
  try { refreshIndexNow(); } catch (_) {}   // 先同步刷编号表（可能触发一次嵌套渲染，被上面的闸门挡掉）
  const body = m._body;
  body.innerHTML = '';
  hideRbMenu();          // 重建时顺手收起右键菜单
  m._refreshers = [];   // 重建后重新收集各卡片的计数刷新回调
  const targets = indexTargets().filter((t) => t.ports.length);
  if (!targets.length) {
    const e = el('div', 'eph-rb-empty');
    e.innerHTML = ezT('No generator node with media on the canvas yet.<br>Connect media to the media input ports of a generator node (video / audio / model), for example the first_frame / ref_image_1 ports of MiniMax H3, and the numbers and compile tags will be listed here in real time.');
    body.appendChild(e);
  }
  const cur = cardRefId(card);
  targets.forEach((t, i) => {
    const on = cur === String(t.id);
    const box = el('div', 'eph-rb-node' + (on ? ' current' : ''));
    const hd = el('div', 'eph-rb-nhd');
    const num = el('span', 'eph-rb-num'); num.textContent = String(i + 1);
    const nm = el('span', 'eph-rb-name'); nm.textContent = t.title || t.type;
    // 同一素材被同一节点的多个端口引用（端口扇出 / MediaOut 端口复用）时只列一次：按媒体键去重，保留第一个端口的标签
    const seen = new Set(); const shown = [];
    t.ports.forEach((p) => p.files.forEach((f) => { const k = mediaKeyOf(f) || (f && f.path); if (k) { if (seen.has(k)) return; seen.add(k); } shown.push({ p: p, f: f }); }));
    const cnt = el('span', 'eph-rb-cnt'); cnt.textContent = ezT('Media') + ' ' + shown.length;
    hd.appendChild(num); hd.appendChild(nm); hd.appendChild(cnt);
    // 点卡片面板 = 本卡片引用它；再点一次 = 取消引用（可以都不引用）
    hd.title = on ? ezT('Click again to clear the reference (this card references no generator node)') : ezT('Click: this card references this generator node');
    hd.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!card) return;
      card.refTarget = on ? '' : String(t.id);
      syncToConfig(node);
      renderRefBrowser(node, ed, card);
    });
    // 右键：弹出菜单，可把这个生成节点设为「全体引用库」（所有卡片一起改）
    const ctx = (e) => { e.preventDefault(); e.stopPropagation(); openRbMenu(e.clientX, e.clientY, node, card, t, ed); };
    hd.addEventListener('contextmenu', ctx);
    box.addEventListener('contextmenu', ctx);
    box.appendChild(hd);
    const grid = el('div', 'eph-rb-grid');
    shown.forEach((it) => grid.appendChild(rbTile(ed, node, card, t, it.p, it.f)));
    box.appendChild(grid);
    body.appendChild(box);
  });
  } finally { m._building = false; }
}
function openRefBrowser(node, ed, card) {
  if (!ed) return;
  const m = refBrowserEl();
  renderRefBrowser(node, ed, card);
  m.classList.add('active');
  phDockApply(m, node);
  _phActiveEditor = ed;
}
// 编号表/节点重命名变化时，若浏览器开着就实时刷新（下拉框里的节点名字同步）。
function refreshRefBrowser() {
  const m = _refBrowser;
  if (!m || !m.classList.contains('active') || !m._ed) return;
  renderRefBrowser(m._node, m._ed, m._card);
}

let _mvModal = null;
// 停掉某个容器里正在播放的媒体（原生 video/audio + 自定义音频播放器里的 audio）。
function stopMediaIn(root) {
  if (!root) return;
  try { root.querySelectorAll('video,audio').forEach((v) => { try { v.pause(); } catch (_) {} }); } catch (_) {}
}
function phMediaViewerStop() {
  const m = _mvModal; if (!m) return;
  stopMediaIn(m._box); m.classList.remove('active');
}
function phMediaViewer(url, type, name) {
  if (!url) return;
  if (type === 'model' || type === '3d') { let w = window; try { w.open(url, '_blank'); } catch (_) {} return; }   // 3D 模型浏览器无法内联渲染，新标签打开
  let m = _mvModal; if (!m || !m.parentNode) {
    m = _mvModal = el('div', 'eph-mv');
    const box = el('div', 'eph-mv-box');
    const close = el('button', 'eph-modal-close'); close.textContent = '✕';
    box.appendChild(close);
    m.appendChild(box); document.body.appendChild(m);
    m._box = box; m._cap = el('div', 'eph-mv-cap');
    m._phOnClose = phMediaViewerStop;   // 被层协调器关掉时也要把里面播放的视频/音频停掉
    close.addEventListener('click', phMediaViewerStop);
    m.addEventListener('mousedown', (e) => { if (e.target === m && (_phClosedEl === null || _phClosedEl === m)) { _phClosedEl = m; phMediaViewerStop(); } });
  }
  const box = m._box;
  stopMediaIn(box);   // 换素材前先停掉上一个
  box.querySelectorAll('.eph-mv-media, .ez-ap').forEach((x) => x.remove());
  const isVid = /\.(mp4|webm|mov|mkv|avi)([?#]|$)/i.test(url), isAud = /\.(mp3|wav|flac|ogg|m4a|opus)([?#]|$)/i.test(url);
  const tag = isVid ? 'video' : isAud ? 'audio' : 'img';
  const media = isAud ? makeAudioPlayer(url) : document.createElement(tag);
  if (media.className !== 'ez-ap') { media.className = 'eph-mv-media'; media.controls = true; media.src = url; if (tag === 'video') media.autoplay = true; }
  m._cap.textContent = name || '';
  box.appendChild(media); box.appendChild(m._cap);
  m.classList.add('active');
}
let _rpEl = null;
function refPreviewEl() {
  if (_rpEl && _rpEl.parentNode) return _rpEl;
  _rpEl = el('div', 'eph-rp'); _rpEl.style.display = 'none'; document.body.appendChild(_rpEl);
  return _rpEl;
}
function refPreviewShow(btn, m) {
  const elm = refPreviewEl(); elm.innerHTML = '';
  const tag = m.type === 'video' ? 'video' : m.type === 'audio' ? 'audio' : 'img';
  const media = tag === 'audio' ? makeAudioPlayer(m.url) : document.createElement(tag);
  if (media.className !== 'ez-ap') { media.className = 'eph-rp-media'; media.src = m.url; if (tag === 'video' || tag === 'audio') { media.controls = true; media.muted = true; media.autoplay = true; } }
  const cap = el('div', 'eph-rp-cap'); cap.textContent = m.name || '';
  elm.appendChild(media); elm.appendChild(cap);
  const r = btn.getBoundingClientRect();
  elm.style.left = r.left + 'px'; elm.style.top = (r.bottom + 4) + 'px'; elm.style.display = 'block';
}
function refPreviewHide() {
  const elm = refPreviewEl(); elm.style.display = 'none';
  const v = elm.querySelector('video,audio'); if (v) { try { v.pause(); } catch (_) {} }
  try { refPreviewEl().innerHTML = ''; } catch (_) {}
}
// ===== 输入框内 @ 触发媒体提及 =====
let _mentionMenu = null;
function mentionMenuEl() {
  if (_mentionMenu && _mentionMenu.parentNode) return _mentionMenu;
  _mentionMenu = el('div', 'eph-dd-menu'); document.body.appendChild(_mentionMenu);
  return _mentionMenu;
}
function hideMention() { if (_mentionMenu) _mentionMenu.classList.remove('active'); }
// 在编辑器文本里定位到 charIndex 字符所在的文本节点+偏移（递归走全部文本节点，跳过芯片内文本）。
  function _frLocateChar(ed, charIndex) {
  let n = 0;
  const walk = (node) => {
    if (node.nodeType === 3) { const len = (node.nodeValue || '').length; if (charIndex <= n + len) return { node, offset: charIndex - n }; n += len; return null; }
    if (node.nodeType === 1) {
      if (node.classList && node.classList.contains('eph-mref')) return null;   // 跳过媒体芯片
      for (let i = 0; i < node.childNodes.length; i++) { const r = walk(node.childNodes[i]); if (r) return r; }
    }
    return null;
  };
  return walk(ed) || { node: null, offset: 0 };
}
// 读出光标前的「可编辑文本」（跳过媒体芯片），保证与 _frLocateChar  一致。
function _frBeforeText(ed, container, offset) {
  const out = []; let reached = false;
  const walk = (node) => {
    if (reached) return;
    if (node.nodeType === 3) { if (node === container) { out.push((node.nodeValue || '').slice(0, offset)); reached = true; } else { out.push(node.nodeValue || ''); } return; }
    if (node.nodeType === 1) {
      if (node.classList && node.classList.contains('eph-mref')) return;
      for (let i = 0; i < node.childNodes.length; i++) { walk(node.childNodes[i]); if (reached) return; }
    }
  };
  walk(ed);
  return out.join('');
}
function attachMention(ed, ctxGetter) {
  ed.addEventListener('keyup', () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return hideMention();
    const rng = sel.getRangeAt(0);
    const before = _frBeforeText(ed, rng.startContainer, rng.startOffset);
    // 从「最后一个 @」起算搜索词：用正则从头匹配的话，前面残留的 @ 会被一起吞进来
    // （如 "@,@图片1" 会把搜索词算成 ",@"），菜单就变成「无匹配媒体」＝看起来列表没了。
    const at = before.lastIndexOf('@');
    if (at < 0) return hideMention();
    const q = before.slice(at + 1);
    if (/[\s\n\u200b\u3000]/.test(q)) return hideMention();   // 搜索词里出现空白 → 已经不是在打 @ 引用了
    const startPos = _frLocateChar(ed, at);
    if (!startPos || !startPos.node) return hideMention();
    mentionShow(ctxGetter ? ctxGetter() : null, q, startPos.node, startPos.offset, rng, ed);
  });
}
// @ 菜单：优先列「当前卡片引用的生成节点」端口上的媒体；该卡片还没指定/该节点没素材时，
// 退回列出画布上其他生成节点的素材（免得菜单空着像"消失了"）。
function cardRefFiles(card) {
  try { refreshIndexSoon(); } catch (_) {}   // 编号表有变化时下一帧补齐（不阻塞本帧）
  const own = card && card.refTarget ? indexTargetById(card.refTarget) : null;
  const t = own || activeIndexTarget();
  const out = [];
  const push = (tg, fallback) => (tg.ports || []).forEach((p) => p.files.forEach((f) => out.push({ m: f, port: p, from: tg, fallback: !!fallback })));
  if (t) push(t, false);
  if (!out.length) indexTargets().filter((x) => x.ports.length).forEach((x) => push(x, true));
  return out;
}
async function mentionShow(ctx, q, startNode, startOff, rng, ed) {
  const card = ctx && ctx.card;
  const targetId = (card && card.refTarget) || '';
  const all = cardRefFiles(card);
  const matched = all.filter((x) => ((x.m.name || x.m.path || '').toLowerCase().indexOf(q.toLowerCase()) >= 0));
  const menu = mentionMenuEl(); menu.innerHTML = '';
  if (matched.length) menu.appendChild(el('div', 'eph-tools-sep')).textContent = ezT('Media');
  else menu.appendChild(el('div', 'eph-dd-empty')).textContent = q ? ezT('No matching media') : ezT('No media on the canvas can be used as a reference');
  matched.forEach((x) => {
    const m = x.m;
    // 编号按本卡片的引用目标算（素材可能同时接在多个生成节点上，都编 @图片1）；卡片没设目标时用素材所在节点。
    const want = targetId || x.from.id;
    const canInsert = !!mediaIndex(mediaKeyOf(m), want);
    const b = el('button', 'eph-tool-item ph-mref-item'); b.type = 'button';
    const ico = document.createElement('span'); ico.className = 'eph-mref-ico'; ico.innerHTML = mediaIcon(x.port.type);
    const tag = el('span', 'eph-mref-num'); tag.textContent = x.port.label;
    b.appendChild(tag); b.appendChild(ico); b.appendChild(document.createTextNode(' ' + (m.name || m.path)));
    b.title = (x.fallback ? x.from.title + ' · ' : '') + x.port.name + ' · ' + (x.port.tag || x.port.label);
    if (!canInsert) {
      // 不在本卡片的引用目标端口上：插进去的编号对不上，标灰不给点（先用「引用媒体」把引用目标改过来）
      b.classList.add('eph-mref-off');
      const tn = indexTargetById(want);
      b.title = ezT('Not on an input port of the reference target of this card "') + ((tn && tn.title) || want) + ezT('": cannot be referenced; connect the media to that generator node, or change the reference target in "Reference media" to "') +
        (x.from.title || x.from.type) + ezT('".');
    }
    b.addEventListener('mouseenter', () => refPreviewShow(b, m));
    b.addEventListener('mouseleave', refPreviewHide);
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!canInsert) return;   // 标灰项：不插入，避免插入一个对不上的编号
      const s = window.getSelection();
      let rr = null;
      try { rr = document.createRange(); rr.setStart(startNode, startOff); rr.setEnd(rng.startContainer, rng.startOffset); } catch (_) { rr = null; }
      if (rr) {
        // 先把用户敲的「@关键词」删掉，芯片顶替它；不删就会留下一个多余的 @（变成 @@图片1），
        // 而且残留的 @ 会让下一次的 @ 触发把逗号等一起算进搜索词（@ 菜单看起来"没有文件"）。
        try { rr.deleteContents(); } catch (_) {}
        s.removeAllRanges(); s.addRange(rr);
        saveSelection();
      }
      // 每次都插入一份新引用（同一媒体可以多次引用），已存在也照插
      insertMediaRefOnce(ed, m, want);
      hideMention();
    });
    menu.appendChild(b);
  });
  menu.classList.add('active');
  // 先显示再量尺寸：光标靠下/靠右时把菜单翻到上方、往左收，否则菜单会跑到屏幕外（看起来像"@ 列表没了"）。
  try {
    const rect = rng.getBoundingClientRect();
    menu.style.minWidth = '180px'; menu.style.width = '180px';
    const mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 0;
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - mw - 8)) + 'px';
    const below = rect.bottom + 4;
    menu.style.top = ((below + mh > window.innerHeight - 8) ? Math.max(8, rect.top - mh - 4) : below) + 'px';
  } catch (_) { menu.style.left = '20px'; menu.style.top = '20px'; }
}

function mediaIcon(type) {
  const t = (type || '').toLowerCase();
  if (t === 'video') return TYPE_ICONS.video;
  if (t === 'audio') return TYPE_ICONS.audio;
  if (t === 'model' || t === '3d' || t === 'model_3d') return TYPE_ICONS.model_3d;
  if (t === 'text' || t === 'txt' || t === 'other') return TYPE_ICONS.text;
  return TYPE_ICONS.image;
}
// 点击编辑器里已插入的「@媒体」芯片 → 打开预览/播放
document.addEventListener('click', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('.eph-mref') : null;
  if (t) { e.preventDefault(); e.stopPropagation(); phMediaViewer(t.dataset.url, t.dataset.type, t.dataset.name); }
});
// 点击即用的素材来源：**优先本节点自己「综合媒体」口上的**，其次卡片引用目标（画布生成节点）上的。
// （只读画布生成节点是不够的：用户通常把素材直接接在 PromptHelper 的综合媒体口上。）
function clickMedias(node, card) {
  const out = [];
  try { nodeInputMedia(node).forEach((x) => { if (x && x.m) out.push(x); }); } catch (_) {}
  const lists = card ? [cardRefFiles(card)] : stateFor(node).cards.map((c) => cardRefFiles(c));
  for (const list of lists) for (const x of list) { if (x && x.m) out.push({ m: x.m, type: x.m.type }); }
  return out;
}
// 点击即用的优化也带图：收集图片转成 data URL 列表发给 API / llama / textgen。
async function cardImageDataUrls(node, card) {
  const picked = []; const seen = new Set();
  for (const x of clickMedias(node, card)) {
    const m = x.m; const t = x.type || m.type;
    if (t !== 'image' || !m.url || seen.has(m.url)) continue;
    seen.add(m.url); picked.push(m);
    if (picked.length >= 8) break;
  }
  const out = [];
  for (const m of picked) {
    try {
      const r = await fetch(m.url);
      if (!r.ok) continue;
      const blob = await r.blob();
      const d = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result || '')); fr.onerror = () => res(''); fr.readAsDataURL(blob); });
      if (d) out.push(fixDataUrlMime(d, m.url));
    } catch (_) {}
  }
  return out;
}
// 透传原始 data URL 前把 MIME 补成 image/*（serve 端点可能给 application/octet-stream）。
function fixDataUrlMime(d, url) {
  if (!d || d.indexOf('data:image/') === 0) return d;
  const mm = String(url || '').match(/\.([a-z0-9]{1,6})(?:[?#]|$)/i);
  let ext = mm ? mm[1].toLowerCase() : 'png';
  if (ext === 'jpg') ext = 'jpeg';
  return d.replace(/^data:[^;,]*/, 'data:image/' + ext);
}
// 点击即用要带的视频/音频：只发路径给后端，由后端解码加载（浏览器里转 base64 不现实）。
function cardMediaRefs(node, card) {
  const out = []; const seen = new Set();
  for (const x of clickMedias(node, card)) {
    const m = x.m; const t = x.type || m.type;
    if (!m.path || (t !== 'video' && t !== 'audio') || seen.has(m.path)) continue;
    seen.add(m.path); out.push({ type: t, path: m.path, name: m.name || '' });
    if (out.length >= 4) return out;
  }
  return out;
}
// 调用后端优化：method 映射 api / textgen / llama，参数来自节点全局「设置」。
async function runOptimize(id, ed) {
  const nd = _editModal && _editModal._node;
  if (!nd) return;
  const st = stateFor(nd);
  const card = st.cards.find((c) => c.id === st.editingId);
  // 源固定取「默认提示词」页签（与滑块无关，也不退回编辑器里当前那份 —— 默认是空的就没有可优化的东西）。
  const src = card ? (card.contentHTML || card.content || '') : '';
  const plain = plainTextOf(src);
  if (!plain.trim()) { phTip(ezT('This card has no prompt content to optimize.')); return; }
  const cfg = optimizeFor(nd);
  const method = id === 'optimize' ? 'api' : id;
  const keyOptional = (cfg.provider === 'Ollama');
  if (method === 'api' && !keyOptional && !cfg.apiKey) { phTip(ezT('To call "Optimize prompt (API)", fill in the provider API Key under "Settings · API settings" first (also check the model provider / API host).')); return; }
  const payload = { method, prompt: plain, provider: cfg.provider || '', model: cfg.model || '', apiUrl: cfg.apiUrl || '', apiKey: cfg.apiKey || '', proxy: cfg.proxy || '', textgen: cfg.textgen || {}, llama: cfg.llama || {}, apiParams: cfg.apiParams || {}, clearCache: !!cfg.clearCache };
  phProgShow(nd, 1, ezT('Optimized prompt'));
  phProgTick(nd, 0, (card  ?  card.title : '') + ezT(' calling…'));
  const imgs = await cardImageDataUrls(nd, card);
  if (imgs.length) payload.images = imgs;
  const medias = cardMediaRefs(nd, card);
  if (medias.length) payload.media = medias;
  if (imgs.length || medias.length) phProgTick(nd, 0, (card  ?  card.title : '') + ' ' + ezT('attached ') + (imgs.length ? imgs.length + ' ' + ezT('images') : '') + (medias.length ? (imgs.length ? ' + ' : '') + medias.length + ' ' + ezT('video/audio') : '') + ezT(', calling…'));
  try {
    const res = await (async () => { const r = await fetchApi('/prompt_helper/optimize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return r; })();
    const data = await res.json().catch(() => ({ error: ezT('Failed to parse response') }));
    if (!res.ok || data.error) { phProgErr(nd, (data.error || ('HTTP ' + res.status))); phTip(ezT('Optimization failed: ')  + (data.error || ('HTTP ' + res.status))); return; }
    const outText = data.text || '';
    // 切到「优化提示词」页签并写入结果
    if (card) {
      card.contentOptimizedHTML = plainTextToHtml(outText);
      card.contentOptimized = outText;
      card.useOptimized = true;   // 滑块切到「优化提示词」（已经在优化页签就是无操作）
      const tabOpt = _editModal && _editModal._tabOptimized;
      const tabDef = _editModal && _editModal._tabDefault;
      if (tabOpt) { tabOpt.classList.add('active'); tabDef && tabDef.classList.remove('active'); }
      st.currentTab = 'optimized';
      if (_editModal) { _editModal._editor.innerHTML = card.contentOptimizedHTML; }
      requestAnimationFrame(moveTabThumb);
      syncToConfig(nd);
      refreshUI(nd);   // 列表里的预览文字 / 优默标记立刻切到优化版
    }
    phProgDone(nd);
  } catch (e) { phProgErr(nd, (e && e.message  ?  e.message : e)); phTip(ezT('Optimization request failed: ')  + (e && e.message  ?  e.message : e)); }
}
function plainTextToHtml(text) {
  const d = document.createElement('div');
  text.split(/\r?\n/).forEach((line) => { const p = document.createElement('div'); p.textContent = line; d.appendChild(p); });
  return d.innerHTML;
}
function optimizeFor(node) {
  const cfg = readConfig(node, {});
  const o = cfg.optimize || {};
  return {
    provider: o.provider || 'OpenAI',
    model: o.model || '',
    apiUrl: o.apiUrl || '',
    apiKey: o.apiKey || '',
    proxy: o.proxy || '',
    autoTextgen: !!o.autoTextgen,
    autoApi: !!o.autoApi,
    autoLlama: !!o.autoLlama,
    clearCache: !!o.clearCache,
    customMode: !!o.customMode,
    customPreset: o.customPreset || '',
    textgen: (o.textgen && typeof o.textgen === 'object') ? o.textgen : {},
    llama: (o.llama && typeof o.llama === 'object') ? o.llama : {},
    apiParams: (o.apiParams && typeof o.apiParams === 'object') ? o.apiParams : {},
  };
}
// skill 按键：弹 Windows 资源管理器选 md（默认定位 models/skills），把文件内容插入当前编辑位置。
// 光标先于弹窗抓取：原生文件对话框会夺走焦点，回来后再还原 Range 插入。
function phInsertRange(ed) {
  const sel = window.getSelection();
  if (sel.rangeCount) {
    const r = sel.getRangeAt(0);
    if (ed.contains(r.commonAncestorContainer)) return r.cloneRange();
  }
  const blocks = ed.querySelectorAll('.eph-all-block-body');
  const target = blocks.length ? blocks[blocks.length - 1] : ed;
  const r = document.createRange();
  r.selectNodeContents(target); r.collapse(false);
  return r;
}
async function insertSkillFile(ed) {
  if (!ed) return;
  const range = phInsertRange(ed);
  try {
    const r = await fetchApi('/prompt_helper/pick_skill', { method: 'POST' });
    const data = await r.json().catch(() => ({ error: ezT('Failed to parse') }));
    if (data.error) { phTip(ezT('Failed to insert skill: ')  + data.error); return; }
    if (!data.ok) return;   // 用户取消选择
    const text = String(data.text || '');
    if (!text.trim()) { phTip(ezT('This skill file has no content.')); return; }
    const html = plainTextToHtml(text.replace(/\r\n/g, '\n'));
    ed.focus();
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.execCommand('insertHTML', false, html);
  } catch (e) { phTip(ezT('Failed to insert skill: ')  + (e && e.message  ?  e.message : e)); }
}
function skillButton(ed) {
  const group = el('div', 'eph-tb-group');
  const b = el('button', 'eph-btn'); b.textContent = 'skill'; b.title = ezT('Pick a skill file (md, defaults to models/skills) and insert it at the cursor');
  b.addEventListener('mousedown', (e) => e.preventDefault());   // 保住编辑区光标
    b.addEventListener('click', () => insertSkillFile(ed));
  group.appendChild(b);
  return group;
}
// GGUF 模型下拉：从共享 models 文件夹读取 *.gguf（相对路径），供 llama 进程内推理选取。
// 给文本输入框挂一个「文件下拉」（图三风格）：聚焦/点击弹出可用文件列表，点选回填；仍可手动输入任意路径。
  function attachFileMenu(input, endpoint, rootGetter) {
  if (!input || input._ephFileMenu) return input; input._ephFileMenu = true;
  const wrap = el('div', 'eph-dd'); input.classList.add('eph-dd-input');
  if (input.parentNode) input.parentNode.removeChild(input);
  wrap.appendChild(input);
  const caret = el('span', 'eph-dd-arrow'); caret.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none;';
  wrap.appendChild(caret);
  const menu = el('div', 'eph-dd-menu'); document.body.appendChild(menu);
  const openMenu = async () => {
    try {
      let ep = endpoint;
      const rv = rootGetter ? (rootGetter() || '') : '';
      if (rv) ep = endpoint + (endpoint.indexOf('?') >= 0 ? '&' : '?') + 'root=' + encodeURIComponent(rv);
      const r = await fetchApi(ep);
      const data = await r.json().catch(() => ({}));
      const models = data.models || [];
      menu.innerHTML = '';
      if (!models.length) menu.appendChild(el('div', 'eph-dd-empty')).textContent = ezT('(none)');
      models.forEach((m) => {
        const b = el('button', 'eph-dd-item'); b.type = 'button'; b.textContent = m.path; b.title = m.path;
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => { e.stopPropagation(); input.value = m.path; menu.classList.remove('active'); try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {} });
        menu.appendChild(b);
      });
    } catch (_) { menu.innerHTML = ''; menu.appendChild(el('div', 'eph-dd-empty')).textContent = ezT('(load failed)'); }
    const rect = input.getBoundingClientRect();
    menu.style.left = rect.left + 'px'; menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.minWidth = Math.max(rect.width, 140) + 'px'; menu.style.width = Math.max(rect.width, 140) + 'px';
    menu.style.maxHeight = '240px';
    menu.classList.add('active');
  };
  input.addEventListener('focus', openMenu);
  input.addEventListener('click', (e) => { e.stopPropagation(); openMenu(); });
  window.addEventListener('resize', () => menu.classList.remove('active'));
  return wrap;
}

// ===== 颜色下拉 =====
const _THEME_COLORS = ['#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
const _STD_COLORS = ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0'];
function initColorDropdown(dd, target) {
  const grid = el('div', 'eph-color-grid');
  const gridSm = el('div', 'eph-color-grid eph-color-grid-sm');
  // 高亮保留「无颜色」以快捷清除高亮（hiliteColor  传 transparent 会把高亮折叠为透明）。
    // 文字颜色不提供无颜色（foreColor  的 transparent 无效）。
    if (target === 'highlight') {
    const noColor = el('div', 'eph-color-item eph-no-color'); noColor.dataset.color = 'transparent'; noColor.title = ezT('Clear highlight');
    grid.appendChild(noColor);
  }
  (target === 'highlight' ? _STD_COLORS : _THEME_COLORS).forEach((c) => grid.appendChild(colorItem(c, target, dd)));
  const title2 = el('div', 'eph-color-title'); title2.textContent = ezT('Standard colors');
  _STD_COLORS.forEach((c) => gridSm.appendChild(colorItem(c, target, dd)));
  const more = el('button', 'eph-dropdown-btn'); more.textContent = ezT('More colors (M)...');
  dd.appendChild(grid); dd.appendChild(title2); dd.appendChild(gridSm); dd.appendChild(more);
  more.addEventListener('click', (e) => { e.stopPropagation(); openColorPicker(target); dd.classList.remove('active'); });
}
function colorItem(c, target, dd) {
  const d = el('div', 'eph-color-item'); d.style.background = c; d.dataset.color = c;
  d.addEventListener('mousedown', (e) => e.preventDefault());
  d.addEventListener('click', (e) => { e.stopPropagation(); applyColor(target, c); if (dd) dd.classList.remove('active'); });
  return d;
}

// =====  自定义取色器 =====
let _pickerModal = null, _pickerTarget = null;
let _pcR = 255, _pcG = 255, _pcB = 255, _pcH = 200, _pcS = 100, _pcL = 50, _pcHSV_S = 100, _pcHSV_V = 100, _pcMode = 'hex';
function rgbToHsl(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); let h, s, l = (max + min) / 2; if (max === min) { h = s = 0; } else { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; } return { h: h * 360, s: s * 100, l: l * 100 }; }
function rgbToHsv(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); const d = max - min; let h; if (d === 0) h = 0; else if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60; else if (max === g) h = ((b - r) / d + 2) * 60; else h = ((r - g) / d + 4) * 60; return { h, s: (max === 0 ? 0 : d / max) * 100, v: max * 100 }; }
function hslToRgb(h, s, l) { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return { r: Math.round(255 * f(0)), g: Math.round(255 * f(8)), b: Math.round(255 * f(4)) }; }
function hsvToRgb(h, s, v) { s /= 100; v /= 100; const i = Math.floor(h / 60); const f = h / 60 - i; const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - (1 - f) * s); let r, g, b; switch (i % 6) { case 0: r = v; g = t; b = p; break; case 1: r = q; g = v; b = p; break; case 2: r = p; g = v; b = t; break; case 3: r = p; g = q; b = v; break; case 4: r = t; g = p; b = v; break; case 5: r = v; g = p; b = q; break; } return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) }; }
function rgbToHex(r, g, b) { return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase(); }
function pickerEl() {
  if (_pickerModal && _pickerModal.parentNode) return _pickerModal;
  _pickerModal = el('div', 'eph-picker');
  const box = el('div', 'eph-picker-box');
  const preview = el('div', 'eph-picker-preview');
  const area = el('div', 'eph-picker-2d'); const bg = el('div', 'eph-picker-2d-bg'); const cursor = el('div', 'eph-picker-2d-cursor');
  area.appendChild(bg); area.appendChild(cursor);
  const hue = el('div', 'eph-picker-hue'); const thumb = el('div', 'eph-picker-thumb'); hue.appendChild(thumb);
  const modes = el('div', 'eph-picker-modes');
  ['hex', 'rgb', 'hsl', 'hsv'].forEach((m) => { const b = el('button', 'eph-picker-mode'); b.textContent = m.toUpperCase(); b.dataset.mode = m; if (m === 'hex') b.classList.add('active'); modes.appendChild(b); });
  const hexInput = el('input', 'eph-picker-hex'); hexInput.maxLength = 7; hexInput.value = '#000000';
  const rows = el('div'); rows.style.cssText = 'display:flex;flex-direction:column;';
  const ft = el('div', 'eph-picker-ft');
  const cancel = el('button', 'eph-picker-cancel'); cancel.textContent = ezT('Cancel');
  const confirm = el('button', 'eph-picker-confirm'); confirm.textContent = ezT('OK');
  ft.appendChild(hexInput); ft.appendChild(cancel); ft.appendChild(confirm);
  box.appendChild(preview); box.appendChild(area); box.appendChild(hue); box.appendChild(modes); box.appendChild(rows); box.appendChild(ft);
  _pickerModal.appendChild(box); document.body.appendChild(_pickerModal);
  _pickerModal._preview = preview; _pickerModal._area = area; _pickerModal._bg = bg; _pickerModal._cursor = cursor; _pickerModal._hue = hue; _pickerModal._thumb = thumb; _pickerModal._hex = hexInput; _pickerModal._rows = rows; _pickerModal._modes = modes;
  _pickerModal._cancel = cancel; _pickerModal._confirm = confirm; _pickerModal._box = box;
  modes.querySelectorAll('.eph-picker-mode').forEach((b) => b.addEventListener('click', () => setPickerMode(b.dataset.mode)));
  hexInput.addEventListener('input', () => { if (/^#[0-9A-Fa-f]{6}$/.test(hexInput.value)) { setFromHex(hexInput.value); updatePickerUI(); } });
  cancel.addEventListener('click', () => closePicker());
  confirm.addEventListener('click', () => { applyColor(_pickerTarget, hexInput.value); closePicker(); });
  area.addEventListener('mousedown', (e) => { e.preventDefault(); drag2d(e); const mv = (ev) => drag2d(ev); const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); });
  hue.addEventListener('mousedown', (e) => { e.preventDefault(); dragHue(e); const mv = (ev) => dragHue(ev); const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); });
  // 点击取色器外部空白 → 自动关闭（不保存，仅点「确定」才应用颜色/不影响卡片弹窗）。
  _pickerModal.addEventListener('mousedown', (e) => { if (e.target === _pickerModal && (_phClosedEl === null || _phClosedEl === _pickerModal)) { _phClosedEl = _pickerModal; closePicker(); } });
  return _pickerModal;
}
function setPickerMode(mode) {
  _pcMode = mode;
  _pickerModal.querySelectorAll('.eph-picker-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  buildPickerRows(); updatePickerUI();
}
function buildPickerRows() {
  const rows = _pickerModal._rows; rows.innerHTML = '';
  const addRow = (label, key, min, max) => {
    const ro = el('div', 'eph-picker-row');
    const lab = el('label'); lab.textContent = label;
    const range = el('input'); range.type = 'range'; range.min = String(min); range.max = String(max);
    const num = el('input'); num.type = 'number'; num.min = String(min); num.max = String(max);
    ro.appendChild(lab); ro.appendChild(range); ro.appendChild(num); rows.appendChild(ro);
    const sync = (v) => { num.value = range.value = v; setFromInputs(); };
    range.addEventListener('input', () => { num.value = range.value; setFromInputs(); });
    num.addEventListener('input', () => { range.value = num.value; setFromInputs(); });
    _pickerModal['_row_' + key] = { range, num };
  };
  if (_pcMode === 'rgb') { addRow('R', 'r', 0, 255); addRow('G', 'g', 0, 255); addRow('B', 'b', 0, 255); }
  else if (_pcMode === 'hsl') { addRow('H', 'h', 0, 360); addRow('S', 's', 0, 100); addRow('L', 'l', 0, 100); }
  else if (_pcMode === 'hsv') { addRow('H', 'h', 0, 360); addRow('S', 's', 0, 100); addRow('V', 'v', 0, 100); }
}
function setFromInputs() {
  if (_pcMode === 'rgb') { _pcR = parseInt(_pickerModal._row_r.num.value) || 0; _pcG = parseInt(_pickerModal._row_g.num.value) || 0; _pcB = parseInt(_pickerModal._row_b.num.value) || 0; }
  else if (_pcMode === 'hsl') { _pcH = parseFloat(_pickerModal._row_h.num.value) || 0; _pcS = parseFloat(_pickerModal._row_s.num.value) || 0; _pcL = parseFloat(_pickerModal._row_l.num.value) || 0; const rgb = hslToRgb(_pcH, _pcS, _pcL); _pcR = rgb.r; _pcG = rgb.g; _pcB = rgb.b; }
  else if (_pcMode === 'hsv') { _pcH = parseFloat(_pickerModal._row_h.num.value) || 0; _pcHSV_S = parseFloat(_pickerModal._row_s.num.value) || 0; _pcHSV_V = parseFloat(_pickerModal._row_v.num.value) || 0; const rgb = hsvToRgb(_pcH, _pcHSV_S, _pcHSV_V); _pcR = rgb.r; _pcG = rgb.g; _pcB = rgb.b; }
  updatePickerUI();
}
function setFromHex(hex) { _pcR = parseInt(hex.substring(1, 3), 16); _pcG = parseInt(hex.substring(3, 5), 16); _pcB = parseInt(hex.substring(5, 7), 16); const hsl = rgbToHsl(_pcR, _pcG, _pcB); const hsv = rgbToHsv(_pcR, _pcG, _pcB); _pcH = hsl.h; _pcS = hsl.s; _pcL = hsl.l; _pcHSV_S = hsv.s; _pcHSV_V = hsv.v; }
function drag2d(e) {
  const rect = _pickerModal._area.getBoundingClientRect();
  let x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  let y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
  if (_pcMode === 'rgb' || _pcMode === 'hex') { _pcR = Math.round((x / rect.width) * 255); _pcG = Math.round(255 - (y / rect.height) * 255); }
  else if (_pcMode === 'hsl') { _pcS = Math.round((x / rect.width) * 100); _pcL = Math.round(100 - (y / rect.height) * 100); const rgb = hslToRgb(_pcH, _pcS, _pcL); _pcR = rgb.r; _pcG = rgb.g; _pcB = rgb.b; }
  else if (_pcMode === 'hsv') { _pcHSV_S = Math.round((x / rect.width) * 100); _pcHSV_V = Math.round(100 - (y / rect.height) * 100); const rgb = hsvToRgb(_pcH, _pcHSV_S, _pcHSV_V); _pcR = rgb.r; _pcG = rgb.g; _pcB = rgb.b; }
  updatePickerUI();
}
function dragHue(e) {
  const rect = _pickerModal._hue.getBoundingClientRect();
  let x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  _pcH = Math.round((x / rect.width) * 360);
  const rgb = hslToRgb(_pcH, _pcS, _pcL); _pcR = rgb.r; _pcG = rgb.g; _pcB = rgb.b;
  updatePickerUI();
}
function updatePickerUI() {
  const hex = rgbToHex(_pcR, _pcG, _pcB);
  _pickerModal._preview.style.background = hex;
  _pickerModal._hex.value = hex;
  _pickerModal._thumb.style.left = (_pcH / 360 * 100) + '%';
  if (_pcMode === 'rgb' || _pcMode === 'hex') { _pickerModal._bg.style.background = `linear-gradient(to bottom, rgb(0,0,${_pcB}), rgb(255,0,${_pcB})), linear-gradient(to right,#000,#fff)`; _pickerModal._bg.style.backgroundBlendMode = 'multiply'; _pickerModal._cursor.style.left = (_pcR / 255 * 100) + '%'; _pickerModal._cursor.style.top = (100 - _pcG / 255 * 100) + '%'; }
  else if (_pcMode === 'hsl') { const base = hslToRgb(_pcH, 100, 50); _pickerModal._bg.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,rgb(${base.r},${base.g},${base.b}))`; _pickerModal._bg.style.backgroundBlendMode = 'normal'; _pickerModal._cursor.style.left = _pcS + '%'; _pickerModal._cursor.style.top = (100 - _pcL) + '%'; }
  else if (_pcMode === 'hsv') { const base = hsvToRgb(_pcH, 100, 100); _pickerModal._bg.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,rgb(${base.r},${base.g},${base.b}))`; _pickerModal._bg.style.backgroundBlendMode = 'normal'; _pickerModal._cursor.style.left = _pcHSV_S + '%'; _pickerModal._cursor.style.top = (100 - _pcHSV_V) + '%'; }
  if (_pcMode === 'rgb' && _pickerModal._row_r) { _pickerModal._row_r.range.value = _pickerModal._row_r.num.value = _pcR; _pickerModal._row_g.range.value = _pickerModal._row_g.num.value = _pcG; _pickerModal._row_b.range.value = _pickerModal._row_b.num.value = _pcB; }
  else if (_pcMode === 'hsl' && _pickerModal._row_h) { _pickerModal._row_h.range.value = _pickerModal._row_h.num.value = Math.round(_pcH); _pickerModal._row_s.range.value = _pickerModal._row_s.num.value = Math.round(_pcS); _pickerModal._row_l.range.value = _pickerModal._row_l.num.value = Math.round(_pcL); }
  else if (_pcMode === 'hsv' && _pickerModal._row_h) { _pickerModal._row_h.range.value = _pickerModal._row_h.num.value = Math.round(_pcH); _pickerModal._row_s.range.value = _pickerModal._row_s.num.value = Math.round(_pcHSV_S); _pickerModal._row_v.range.value = _pickerModal._row_v.num.value = Math.round(_pcHSV_V); }
}
function openColorPicker(target) {
  _pickerTarget = target;
  const m = pickerEl();
  _pcR = 100; _pcG = 200; _pcB = 255; _pcH = 200; _pcS = 100; _pcL = 50; _pcHSV_S = 100; _pcHSV_V = 100; _pcMode = 'hex';
  m.querySelectorAll('.eph-picker-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'hex'));
  buildPickerRows(); updatePickerUI(); m.classList.add('active');
}
function closePicker() { _pickerModal && _pickerModal.classList.remove('active'); }

// ===== 查找/替换弹窗（可拖动）====
let _frModal = null, _frDrag = null, _frEditor = null;
// 在指定 contenteditable 内查找下一个匹配（沿文档顺序，从当前光标往后，越界回到开头）。
  function _frNodes(ed) { const out = []; const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); while (w.nextNode()) out.push(w.currentNode); return out; }
let _frMatches = [], _frCur = -1, _frEd = null, _frOverlays = [];
function _frCollect(ed, query) {
  if (!query) return [];
  const ranges = [];
  _frNodes(ed).forEach((n) => {
    const t = n.nodeValue || ''; let idx = 0;
    while ((idx = t.indexOf(query, idx)) >= 0) {
      const r = document.createRange(); r.setStart(n, idx); r.setEnd(n, idx + query.length); ranges.push(r);
      idx += query.length;
    }
  });
  return ranges;
}
function _frRemoveOverlays() { (_frOverlays || []).forEach((d) => { try { if (d && d.parentNode) d.parentNode.removeChild(d); } catch (_) {} }); _frOverlays = []; }
function _frRebuildOverlays() {
  _frRemoveOverlays();
  if (!_frMatches.length) return;
  _frOverlays = _frMatches.map((r, i) => {
    const d = el('div', 'eph-ph-overlay' + (i === _frCur ? ' current' : ''));
    try { const rect = r.getBoundingClientRect(); d.style.left = rect.left + 'px'; d.style.top = rect.top + 'px'; d.style.width = rect.width + 'px'; d.style.height = rect.height + 'px'; } catch (_) { d.style.display = 'none'; }
    document.body.appendChild(d);
    return d;
  });
}
function _frHighlightAll() { _frRebuildOverlays(); }
function _frHighlightCur() { _frRebuildOverlays(); }
function _frRenderList() {
  if (!_frModal || !_frModal._matches) return;
  const list = _frModal._matches; list.innerHTML = '';
  list.style.display = _frMatches.length ? 'block' : 'none';
  _frMatches.forEach((r, i) => {
    const b = el('div', 'eph-fr-match' + (i === _frCur ? ' current' : ''));
    const n = el('span', 'eph-fr-match-n'); n.textContent = String(i + 1);
    const t = el('span', 'eph-fr-match-t');
    try { t.textContent = r.toString(); } catch (_) {}
    b.appendChild(n); b.appendChild(t);
    b.addEventListener('click', (e) => { e.stopPropagation(); _frSetCurrent(i); });
    list.appendChild(b);
  });
}
function _frFindAll(ed, query) {
  if (!ed || !query) { _frMatches = []; _frCur = -1; _frEd = null; _frHighlightAll(); _frRenderList(); return false; }
  _frEd = ed;
  _frMatches = _frCollect(ed, query);
  _frCur = _frMatches.length ? 0 : -1;
  _frHighlightAll(); _frRenderList();
  if (_frCur >= 0) _frSetCurrent(_frCur);
  return _frMatches.length > 0;
}
function _frFindIn(ed, query) { return _frFindAll(ed, query); }
function _frSetCurrent(i) {
  if (i < 0 || i >= _frMatches.length) return;
  _frCur = i;
  try { _frEd && _frEd.scrollIntoView({ block: 'center' }); } catch (_) {}
  _frHighlightCur(); _frRenderList();
}
function _frReplaceIn(ed, query, repl) {
  if (!ed || !query) return false;
  if (!_frMatches.length) { if (!_frFindAll(ed, query)) return false; }
  const r = _frMatches[_frCur];
  if (!r) return false;
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  document.execCommand('insertText', false, repl);
  sel.removeAllRanges();
  _frFindAll(ed, query);
  return true;
}
function _frClear() {
  _frMatches = []; _frCur = -1; _frEd = null;
  _frRemoveOverlays();
  if (_frModal && _frModal._matches) { _frModal._matches.innerHTML = ''; _frModal._matches.style.display = 'none'; }
}
function frEl() {
  if (_frModal && _frModal.parentNode) return _frModal;
  _frModal = el('div', 'eph-fr');
  const header = el('div', 'eph-fr-header');
  const findTab = el('button', 'eph-fr-tab active'); findTab.textContent = ezT('Find');
  const replaceTab = el('button', 'eph-fr-tab'); replaceTab.textContent = ezT('Replace');
  const close = el('button', 'eph-fr-close'); close.textContent = '✕';
  header.appendChild(findTab); header.appendChild(replaceTab); header.appendChild(close);
  const body = el('div', 'eph-fr-body');
  const findSec = el('div'); const findRow = el('div', 'eph-fr-row'); const fi = el('input'); fi.placeholder = ezT('Find text');
  const fbtn = el('button', 'eph-fr-btn'); fbtn.textContent = ezT('Find'); findRow.appendChild(fi); findRow.appendChild(fbtn);
  const fhint = el('p', 'eph-fr-hint'); fhint.textContent = ezT('Enter = find all and list');
  findSec.appendChild(findRow); findSec.appendChild(fhint);
  const replaceSec = el('div'); replaceSec.style.display = 'none';
  const rr1 = el('div', 'eph-fr-row'); const fi2 = el('input'); fi2.placeholder = ezT('Find text'); const fb2 = el('button', 'eph-fr-btn'); fb2.textContent = ezT('Find'); rr1.appendChild(fi2); rr1.appendChild(fb2);
  const rr2 = el('div', 'eph-fr-row'); const ri = el('input'); ri.placeholder = ezT('Replace with'); const rb = el('button', 'eph-fr-btn'); rb.textContent = ezT('Replace'); rr2.appendChild(ri); rr2.appendChild(rb);
  const rhint = el('p', 'eph-fr-hint'); rhint.textContent = ezT('Click a list item below to jump to it');
  replaceSec.appendChild(rr1); replaceSec.appendChild(rr2); replaceSec.appendChild(rhint);
  body.appendChild(findSec); body.appendChild(replaceSec);
  const matches = el('div', 'eph-fr-matches');
  _frModal.appendChild(header); _frModal.appendChild(body); _frModal.appendChild(matches); document.body.appendChild(_frModal);
  _frModal._fi = fi; _frModal._fi2 = fi2; _frModal._ri = ri; _frModal._matches = matches;
  findTab.addEventListener('click', () => { findTab.classList.add('active'); replaceTab.classList.remove('active'); findSec.style.display = 'block'; replaceSec.style.display = 'none'; });
  replaceTab.addEventListener('click', () => { replaceTab.classList.add('active'); findTab.classList.remove('active'); findSec.style.display = 'none'; replaceSec.style.display = 'block'; });
  close.addEventListener('click', () => { _frClear(); _frModal.classList.remove('active'); });
  fbtn.addEventListener('click', () => { _frFindIn(_frEditor || (_editModal && _editModal._editor), fi.value); });
  fi.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _frFindIn(_frEditor || (_editModal && _editModal._editor), fi.value); } });
  fb2.addEventListener('click', () => { _frFindIn(_frEditor || (_editModal && _editModal._editor), fi2.value); });
  fi2.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _frFindIn(_frEditor || (_editModal && _editModal._editor), fi2.value); } });
  rb.addEventListener('click', () => { _frReplaceIn(_frEditor || (_editModal && _editModal._editor), fi2.value, ri.value); });
  ri.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _frReplaceIn(_frEditor || (_editModal && _editModal._editor), fi2.value, ri.value); } });
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    _frDrag = { sx: e.clientX, sy: e.clientY, ox: _frModal.offsetLeft, oy: _frModal.offsetTop };
    e.preventDefault();
    const mv = (ev) => { if (!_frDrag) return; _frModal.style.left = (_frDrag.ox + ev.clientX - _frDrag.sx) + 'px'; _frModal.style.top = (_frDrag.oy + ev.clientY - _frDrag.sy) + 'px'; };
    const up = () => { _frDrag = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  return _frModal;
}
function openFindModal(tab, editorEl) {
  _frEditor = editorEl || _phActiveEditor || (_allModal && _allModal.classList.contains('active') && _allModal._ed) || (_editModal && _editModal._editor) || null;
  const m = frEl(); m.classList.add('active');
  m.querySelectorAll('.eph-fr-tab').forEach((b) => b.classList.remove('active'));
  const t = tab === 'replace' ? m.querySelectorAll('.eph-fr-tab')[1] : m.querySelectorAll('.eph-fr-tab')[0];
  if (t) t.classList.add('active');
  const findSec = m.querySelectorAll('.eph-fr-body > div')[0];
  const replaceSec = m.querySelectorAll('.eph-fr-body > div')[1];
  findSec.style.display = tab === 'replace' ? 'none' : 'block';
  replaceSec.style.display = tab === 'replace' ? 'block' : 'none';
  const focusI = tab === 'replace' ? m._fi2 : m._fi;
  if (focusI) { focusI.focus(); focusI.select(); }
}

// ===== 规则预设（「设置·规则设置」页的数据源）=====
// ===== 提示词规范表（默认；自定义存在节点 config 的 rules.custom）=====
// ref：正文里引用媒体的写法（'' = 不写，媒体走生成节点的独立输入）；{n} = 该类型序号
// ts ：时间规则单模板（仅在「提示」气泡里生成给用户复制，不进自动编译）。{S}=镜头号；{start}/{end}=秒数；{M}=时刻(MM:SS.mmm)；{text}=正文
const _PROMPT_RULES = [
  { id: 'none', label: '不编译', ref: {}, ts: { off: true },
    note: '原样输出，不做编译。' },
  { id: 'api', label: '使用 API', ref: { image: '@Image{n}', video: '@Video{n}', audio: '@Audio{n}' }, ts: { off: true },
    note: '用于 API 节点。' },
  { id: 'h3', label: 'MiniMax H3', base: 'en', ref: { image: '<Picture {n}>', video: '<Video {n}>', audio: '<Audio {n}>' },
    ts: { tpl: '[Shot {S}] At {M}, {text}' },
    note: '画面 = 主体 + 动作 + 场景 + 风格 + 运镜 + 声音 + 对白（官方三字段：integrated_multimodal_description / overall_soundscape / non_diegetic_music）。\n首镜写 [Shot 1] 不带时间；后续 [Shot 2] At 00:03.500, the camera cuts to…（切点严格递增）。\n运镜写成句中的自然英文动作 + 幅度 + 速度（The camera pushes in with small amplitude at slow speed…）。\n参考模式（Ref2VA）另有 <Subject 1>（可复用主体：人物/场景/服装/风格/动作，可由多图/多视频定义，如 <Subject 1> is the woman whose appearance comes from <Picture 1> and whose walking motion comes from <Video 1>.），配六段结构 subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music；对白用 (S1) 与 <d>[English] …</d>。',
    alt: { ref: { image: '<Picture {n}>', video: '<Video {n}>', audio: '<Audio {n}>' },
      ts: { tpl: '[镜头 {S}] At {M}, {text}' },
      note: '（中文为社区写法，官方指南只有英文版）\n画面 = 主体 + 动作 + 场景 + 风格 + 运镜 + 声音 + 对白（官方三字段：integrated_multimodal_description / overall_soundscape / non_diegetic_music）。\n首镜写 [镜头 1] 不带时间；后续 [镜头 2] At 00:03.500, the camera cuts to…（切点严格递增）。\n运镜写成句中的自然英文动作 + 幅度 + 速度（The camera pushes in with small amplitude at slow speed…）。\n参考模式（Ref2VA）另有 <Subject 1>，配六段结构 subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music。' } },
  { id: 'seedance', label: 'Seedance', base: 'zh', ref: { image: '<图片{n}>', video: '<视频{n}>', audio: '<音频{n}>' },
    ts: { tpl: '{start}-{end} 秒：{text}' },
    note: '画面 = 主体 + 运动 + 环境 + 运镜/切镜 + 美学描述 + 声音（后三项非必须）。\n引用写「参考<图片1>中的<主体1>」，绑定主体写「张三@图片1」。\n分镜：2.0 只认「镜头1、镜头2」；2.5 才认整数秒区间，且时间轴要连续。\n声音记号：音乐 ()、音效 <>、台词 {}、字幕 【】。',
    alt: { ref: { image: 'Image {n}', video: 'Video {n}', audio: 'Audio {n}' },
      ts: { tpl: '[{start}s-{end}s] {text}' },
      note: '画面 = Subject + Motion + Environment + Cut + Aesthetic + Sound。\n引用写 Image 1；分镜写 Shot 1、Shot 2（2.0 只认镜头序号，2.5 才认整数秒区间）。\n（官方英文文档未公开，此版按中文版对应，非官方原文）' } },
  { id: 'kling', label: 'Kling 3', base: 'en', ref: { image: '@image{n}', video: '@video{n}' },
    ts: { tpl: 'shot {S}, {dur}, {text};' },
    note: '分镜 = shot 1, 时长秒, 内容; shot 2, …;（分号分隔，≤6 段，各段 ≥1s，时长和 = 总时长，每段 ≤512 字符）。\n引用写 @image1 / @video1 / @Zhang；官方没给画面公式，正文自由写。',
    alt: { ref: { image: '@image{n}', video: '@video{n}' },
      ts: { tpl: '镜头{S}, {dur}, {text};' },
      note: '（中文为社区写法，官方只有英文文档）\n分镜 = 镜头1, 时长秒, 内容; 镜头2, …;（分号分隔，≤6 段，各段 ≥1s，时长和 = 总时长，每段 ≤512 字符）。\n引用写 @image1 / @video1 / @Zhang；官方没给画面公式，正文自由写。' } },
  { id: 'wan3', label: 'Wan 3', base: 'en', ref: { image: '@image{n}', video: '@video{n}', audio: '@audio{n}' },
    ts: { tpl: 'Shot {S} [{start}–{end} s] {text}' },
    note: '画面 = 主体 + 场景 + 运动；（进阶）+ 美学控制（光源/景别/视角/镜头/运镜）+ 风格化。\n多镜头 = 总体描述 + 镜头序号 + 时间戳 + 分镜内容，如 Shot 1 [0–3 s] 内容, Shot 2 [3–6 s] 内容；一镜到底写 Generate single shot.\n参考写 Image 1 / Video 1；控制短语 No dialogue. / No background music.',
    alt: { ref: { image: '@image{n}', video: '@video{n}', audio: '@audio{n}' },
      ts: { tpl: '镜头{S}[{start}-{end}秒] {text}' },
      note: '画面 = 主体 + 场景 + 运动；（进阶）+ 美学控制（光源/景别/视角/镜头/运镜）+ 风格化。\n多镜头 = 总体描述 + 镜头序号 + 时间戳 + 分镜内容，如 镜头1[0-3秒] 内容，镜头2[3-6秒] 内容；一镜到底写「生成单镜头」。\n参考写「图1 / 视频1」；控制短语「无台词」「无背景音乐」。' } },
  { id: 'wan22', label: 'Wan 2.2', ref: {}, ts: { off: true },
    note: '画面 = 主体 + 场景 + 运动；（进阶）主体描述 + 场景描述 + 运动描述 + 美学控制 + 风格化。\n图生视频 = 运动 + 运镜；官方建议开启 prompt extension 扩写。' },
  { id: 'ltx', label: 'LTX 2.5', ref: {}, ts: { off: true },
    note: '画面 = 景别 + 场景 + 动作 + 角色 + 运镜 + 音频，写成一段连续散文（≤200 词，从动作开始、按时间顺序）。\n不要编号、时间戳，也不要凭空写运镜；多镜头用散文点名剪接（A hard cut transitions to…）。\n负面词（官方默认）：has_subtitles, has_blurbox, transition from black, transition to black, speech_ending_short, blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, excessive noise, grainy texture, poor lighting, flickering, motion blur, distorted proportions, unnatural skin tones, deformed facial features, asymmetrical face, missing facial features, extra limbs, disfigured hands, wrong hand count, artifacts around text, inconsistent perspective, camera shake, incorrect depth of field, background too sharp, background clutter, distracting reflections, harsh shadows, inconsistent lighting direction, color banding, cartoonish rendering, 3D CGI look, unrealistic materials, uncanny valley effect, incorrect ethnicity, wrong gender, exaggerated expressions, wrong gaze direction, mismatched lip sync, silent or muted audio, distorted voice, robotic voice, echo, background noise, off-sync audio, incorrect dialogue, added dialogue, repetitive speech, jittery movement, awkward pauses, incorrect timing, unnatural transitions, inconsistent framing, tilted camera, flat lighting, inconsistent tone, cinematic oversaturation, stylized filters, AI artifacts' },
  { id: 'hunyuan', label: 'Hunyuan 1.5', ref: {}, ts: { off: true },
    note: '画面 = 主体 + 运动 + 场景 + [景别] + [运镜] + [灯光] + [风格] + [氛围]（方括号可省）。\n图生视频 = 主体动态 + 场景动态 + [运镜]；运镜用整句（The camera moves forward），用户没说静止不要自己加「镜头静止」。' },
  { id: 'qwen', label: 'Qwen-Image', base: 'zh', ref: { image: '图{n}', video: '', audio: '' }, ts: { off: true },
    note: '画面 = 主体 + 场景 + 细节 + 风格，用描述式自然语言；编辑图才用指令式。\n多图写「图1」「图2」（1–3 张最佳）。\n负面词（官方示例）：低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。',
    alt: { ref: { image: 'Image {n}', video: '', audio: '' }, ts: { off: true },
      note: '画面 = Subject + Scene + Detail + Style，描述式自然语言；编辑图才用指令式。\n多图写 Image 1、Image 2（1–3 张最佳）。\n负面词（官方示例为中文）：低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。' } },
  { id: 'flux2', label: 'FLUX.2', ref: { image: 'image {n}', video: '', audio: '' }, ts: { off: true },
    note: '画面 = Subject + Action + Style + Context。\n多图写 image 1、image 2；不要写负面提示词，用正向替换。' },
  { id: 'hailuo', label: 'Hailuo 02', ref: {}, ts: { off: true },
    note: '官方没给公式，自然语言描述。\n运镜用方括号命令：[Push in] [Pan left] [Zoom in] [Static shot] 等 15 条（一个 [] 内最多 3 个，按顺序生效）。' },
  { id: 'vidu', label: 'Vidu', ref: { image: '@subject{n}', video: '', audio: '' }, ts: { off: true },
    note: '正文用 @subject1 指代参考主体；参考图走独立输入，每个主体最多 3 张。\n官方没给公式，自然语言描述。' },
  { id: 'pixverse', label: 'PixVerse', ref: { image: '@ref{n}', video: '@ref{n}', audio: '' }, ts: { off: true },
    note: '正文用 @ref_name 指代参考（@ 后留空格，名字要与参考里定义的一致）；参考图走独立输入。\n官方没给公式，自然语言描述。' },
  { id: 'runway', label: 'Runway Gen-4', ref: {}, ts: { off: true },
    note: '参考图带 tag（3–16 字符、字母开头、字母/数字/下划线），正文写 @tag 引用（≤3 张）。\nprompts should be descriptive, not conversational；不要写负面提示词。' },
];
const _BUILTIN_RULE_IDS = _PROMPT_RULES.map((r) => r.id);
function _customRules(node) { const c = (node ? phRulesModel(node).custom : null); return Array.isArray(c) ? c.filter((r) => r && r.id && !_BUILTIN_RULE_IDS.includes(r.id)) : []; }
// 内置规范也能改：设置页「保存规范」把改动写进节点 config 的 rules.overrides[id]，可「恢复默认」删掉
function _ruleOverrides(node) { const o = (node ? phRulesModel(node).overrides : null); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
function _applyOverride(r, ov) {
  if (!ov || typeof ov !== 'object') return r;
  const out = { id: r.id,
    label: (typeof ov.label === 'string' && ov.label.trim()) ? ov.label : r.label,
    ref: (ov.ref && typeof ov.ref === 'object') ? ov.ref : r.ref,
    ts: (ov.ts && typeof ov.ts === 'object') ? ov.ts : r.ts,
    note: typeof ov.note === 'string' ? ov.note : r.note };
  const alt = (ov.alt && typeof ov.alt === 'object') ? ov.alt : r.alt;
  if (alt) out.alt = alt;
  const base = ov.base || r.base;
  if (base) out.base = base;
  return out;
}
// 语言变体：base 表示 ref/ts/note 本身的语言，alt = { ref, ts, note } 是另一种语言那份（没有 alt 的规范不受语言开关影响）
// seedance_en 是本轮之前拆出来的旧 id，合并进 seedance（语言 en）后仍要能认出来
const _RULE_ALIAS = { seedance_en: { id: 'seedance', lang: 'en' } };
function _normRuleId(id) { const a = _RULE_ALIAS[id]; return a ? a.id : id; }
function _nodeLang(node) {
  const m = phRulesModel(node);
  if (m.lang === 'en' || m.lang === 'zh') return m.lang;
  const a = _RULE_ALIAS[m.ruleId];
  return (a && a.lang) || 'zh';
}
function _pickLang(rule, lang) {
  if (!rule || !rule.alt) return rule;
  const base = rule.base === 'en' ? 'en' : 'zh';
  if (lang === base) return rule;
  const other = base === 'en' ? 'zh' : 'en';   // 换过来的那份：base 跟着变，alt 反过来存原来那份（保证来回切对称）
  return { id: rule.id, label: rule.label, base: other, alt: { ref: rule.ref || {}, ts: rule.ts || {}, note: rule.note || '' }, ref: rule.alt.ref || {}, ts: rule.alt.ts || {}, note: rule.alt.note || '' };
}
function allRules(node) {
  const ovs = _ruleOverrides(node), lang = _nodeLang(node);
  return _PROMPT_RULES.map((r) => _pickLang(_applyOverride(r, ovs[r.id]), lang))
    .concat(_customRules(node).map((c) => _pickLang(c, lang)));
}
function findRule(node, id) { const rid = _normRuleId(id); return allRules(node).find((r) => r.id === rid) || _PROMPT_RULES[0]; }
function setNodeLang(node, lang) {
  const st = stateFor(node);
  st.rules = Object.assign({}, st.rules || {}, { lang: lang === 'en' ? 'en' : 'zh' });
  syncToConfig(node);
}
// 卡片/总体编辑下拉的选项：新建自定义 | 默认规范 | 分隔线 | 自定义规范
function ruleDropdownItems(node, withNew) {
  const items = [];
  if (withNew) items.push({ value: '__new__', label: ezT('+ New custom spec…') });   // 只有设置页有
  const ovs = _ruleOverrides(node);
  _PROMPT_RULES.forEach((r) => items.push({ value: r.id, label: _applyOverride(r, ovs[r.id]).label }));
  const cs = _customRules(node);
  if (cs.length) { items.push({ divider: true }); cs.forEach((r) => items.push({ value: r.id, label: r.label })); }
  return items;
}
// 时间格式：sec = 秒数；mmss = MM:SS.mmm（只用于气泡里生成时间戳给用户复制）
function fmtRuleTime(v, fmt) {
  const n = parseFloat(String(v == null ? '' : v));
  if (!isFinite(n)) return '';
  if (fmt === 'mmss') { const total = Math.round(n * 1000); const m = Math.floor(total / 60000); const s = (total - m * 60000) / 1000; return String(m).padStart(2, '0') + ':' + s.toFixed(3).padStart(6, '0'); }
  return String(Math.round(n * 1000) / 1000);
}
// 按规范渲染气泡那一排输入：{start}/{end} 秒数 · {dur}=end-start · {M} 时刻(数字→MM:SS.mmm) · {S} 镜头号 · {text} 正文
function renderRuleTs(rule, vals) {
  const ts = (rule && rule.ts) || {};
  if (ts.off || !String(ts.tpl || '').trim()) return '';
  const v = vals || {};
  const mRaw = String(v.M == null ? '' : v.M).trim();
  const mOut = /^-?\d+(\.\d+)?$/.test(mRaw) ? fmtRuleTime(mRaw, 'mmss') : mRaw;
  const sec = parseFloat(String(v.start == null ? '' : v.start));
  const eec = parseFloat(String(v.end == null ? '' : v.end));
  const durRaw = String(v.dur == null ? '' : v.dur).trim();
  const dur = durRaw || (isFinite(sec) && isFinite(eec) ? String(Math.round((eec - sec) * 1000) / 1000) : '');
  return String(ts.tpl)
    .replace(/\{dur\}/g, dur)
    .replace(/\{S\}/g, String(v.S == null ? '' : v.S).trim())
    .replace(/\{M\}/g, mOut)
    .replace(/\{start\}/g, String(v.start == null ? '' : v.start).trim())
    .replace(/\{end\}/g, String(v.end == null ? '' : v.end).trim())
    .replace(/\{text\}/g, '')
    .trim();
}
// 规范提示气泡：点「?」弹出，**只作参考**（书写规则 + 引用写法 + 时间戳生成），不写进卡片。不遮挡、向下弹。
let _rulePop = null;
let _rulePopTs = [{ start: '', end: '', dur: '', S: '', M: '' }];   // 气泡里的多排输入（会话内记住，不落卡片）
// 中/EN 小开关（只有该规范有双语版本时才用）
function mkLangToggle(current, onPick) {
  const box = el('div', 'eph-lang');
  [['zh', '中'], ['en', 'EN']].forEach(([k, t]) => {
    const b = el('button', 'eph-lang-btn'); b.type = 'button'; b.textContent = t;
    if (current === k) b.classList.add('active');
    b.addEventListener('click', (ev) => { ev.stopPropagation(); if (current === k) return; onPick(k); });
    box.appendChild(b);
  });
  return box;
}
function closeRulePop() { if (_rulePop) { try { _rulePop.remove(); } catch (_) {} _rulePop = null; } }
function openRulePop(anchor, node, card) {
  closeRulePop();
  const rule = findRule(node, (card && card.ruleId) || phRulesModel(node).ruleId || 'none');
  const pop = el('div', 'eph-rule-pop');
  const hd = el('div', 'eph-rule-pop-hd');
  hd.appendChild(el('div', 'eph-rule-pop-t')).textContent = rule.label || '';
  if (rule.alt) {   // 有中英双版才显示切换
    const langNow = _nodeLang(node);
    hd.appendChild(mkLangToggle(langNow, (k) => { setNodeLang(node, k); openRulePop(anchor, node, card); }));
  }
  pop.appendChild(hd);
  if (rule.note) pop.appendChild(el('div', 'eph-rule-pop-note')).textContent = rule.note;
  const ex = el('div', 'eph-rule-pop-ex');
  const ref = rule.ref || {};
  const has = (k) => ref[k] !== undefined && ref[k] !== null && String(ref[k]).trim() !== '';
  if (!['image', 'video', 'audio'].some(has)) {
    ex.appendChild(el('span', 'eph-rule-pop-note')).textContent = ezT('No media reference needed');
  } else {
    [['image', '@图片1'], ['video', '@视频1'], ['audio', '@音频1']].forEach(([k, src]) => {
      if (!has(k)) return;
      const pair = el('span', 'eph-rule-pop-pair');
      pair.appendChild(el('span', 'eph-rule-pop-from')).textContent = src;
      pair.appendChild(el('span', 'eph-rule-pop-arrow')).textContent = '→';
      pair.appendChild(el('span', 'eph-rule-pop-to')).textContent = ruleRefPreview(rule, k);
      ex.appendChild(pair);
    });
  }
  pop.appendChild(ex);
  // 输入框按模板里用到的占位符生成（{start}/{end}/{dur}/{S}/{M}，{text} 取正文不用填）→ 生成文字给你复制
  const ts = rule.ts || {};
  const tpl = String(ts.tpl || '');
  if (!ts.off && tpl.trim()) {
    const fields = [
      ['start', 'start', '46px'], ['end', 'end', '46px'], ['dur', 'dur', '40px'], ['S', 'S', '40px'], ['M', 'M', '66px'],
    ].filter(([key]) => tpl.includes('{' + key + '}'));
    const FIELD_TIP = {
      start: ezT('start: shot start time (s)'),
      end: ezT('end: shot end time (s)'),
      dur: ezT('dur: shot duration (s); blank = end - start'),
      S: ezT('S: shot number (e.g. 1, 2)'),
      M: ezT('M: time; seconds auto-convert to 00:03.500, anything else is output as-is'),
    };
    const box = el('div', 'eph-rule-pop-ts');
    const insWrap = el('div', 'eph-rule-shots-in');   // 输入控件：不可选中
    const outWrap = el('div', 'eph-rule-shots-out');  // 生成结果集中一块：可一次框选复制
    const upd = () => {
      outWrap.innerHTML = '';
      _rulePopTs.forEach((v) => {
        if (!fields.some(([key]) => String(v[key] || '').trim())) return;   // 这排一个字都没填 → 不预览
        const t = renderRuleTs(rule, v);
        if (t) outWrap.appendChild(el('div', 'eph-rule-shot-pv')).textContent = t;
      });
    };
    const render = () => {
      insWrap.innerHTML = '';
      _rulePopTs.forEach((v, i) => {
        const line = el('div', 'eph-rule-shot-row');
        fields.forEach(([key, ph, w]) => {
          if (key === 'end' && fields.some((f) => f[0] === 'start')) line.appendChild(el('span')).textContent = '—';
          const inp = el('input'); inp.type = 'text'; inp.inputMode = 'decimal';
          inp.value = v[key] || ''; inp.placeholder = ph; inp.style.width = w;
          setTip(inp, FIELD_TIP[key] || '');
          inp.addEventListener('input', () => { v[key] = inp.value; upd(); });
          line.appendChild(inp);
        });
        const add = el('button', 'eph-rule-shot-btn'); add.type = 'button'; add.textContent = '＋'; add.title = ezT('Add another row');
        add.addEventListener('click', () => { _rulePopTs.push({ start: '', end: '', dur: '', S: '', M: '' }); render(); });
        line.appendChild(add);
        if (i > 0) {
          const del = el('button', 'eph-rule-shot-btn'); del.type = 'button'; del.textContent = '−'; del.title = ezT('Remove row');
          del.addEventListener('click', () => { _rulePopTs.splice(i, 1); render(); });
          line.appendChild(del);
        }
        insWrap.appendChild(line);
      });
      upd();
    };
    box.appendChild(insWrap); box.appendChild(outWrap);
    pop.appendChild(box);
    render();
  }
  document.body.appendChild(pop);
  try {
    const r = anchor.getBoundingClientRect(); const w = pop.offsetWidth || 330, h = pop.offsetHeight || 200;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    pop.style.top = top + 'px';
  } catch (_) {}
  _rulePop = pop;
  return pop;
}
// 点气泡外面 / Esc 关闭（点「?」按钮自身不关，交给按钮自己切换）
document.addEventListener('mousedown', (e) => {
  if (!_rulePop) return;
  const t = e.target;
  if (_rulePop.contains(t)) return;
  if (t && t.classList && t.classList.contains('eph-rule-hint')) return;
  closeRulePop();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRulePop(); });

// 卡片当前规范的「引用媒体编译后样子」：@图片1 → <Picture 1>
function ruleRefPreview(rule, kind) {
  const tpl = ((rule && rule.ref) || {})[kind];
  if (tpl === undefined || tpl === null || String(tpl).trim() === '') return ezT('(unchanged, kept as-is)');
  return String(tpl).replace(/\{n\}/g, '1');
}
// ===== 设置弹窗（模型与接口 / TextGenerate / llama 三排）====
let _settingsModal = null, _settingsNode = null;
const _SET_PROVIDERS = [
  { value: 'OpenAI', label: 'OpenAI', host: 'https://api.openai.com/v1',
    models: ['gpt-6-astra', 'gpt-6-astra-pro', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-cyber', 'gpt-5.5-pro', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex-spark', 'gpt-4.1'] },
  { value: 'DeepSeek', label: 'DeepSeek', host: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro-0813', 'deepseek-v4-flash-0731'] },
  { value: 'Google Gemini', label: 'Gemini', host: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-image', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-image'] },
  { value: 'Anthropic Claude', label: 'Claude', host: 'https://api.anthropic.com/v1',
    models: ['claude-fable-5.1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  { value: 'Alibaba Qwen', label: 'Qwen Portal', host: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-max-0902', 'qwen3.8-flash', 'qwen3.8-max-preview', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash', 'qwen3.6-plus', 'qwen3.5-flash', 'qwen3.5-plus', 'qwen3-max', 'qwen3-coder-next', 'qwen-flash', 'qvq-max'] },
  { value: 'Moonshot Kimi', label: 'Moonshot Kimi', host: 'https://api.moonshot.ai/v1',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-8k-vision-preview'] },
  { value: 'xAI Grok', label: 'xAI Grok', host: 'https://api.x.ai/v1',
    models: ['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-reasoning', 'grok-4.20-non-reasoning', 'grok-latest'] },
  { value: 'Mistral', label: 'Mistral', host: 'https://api.mistral.ai/v1',
    models: ['mistral-large-3', 'mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'magistral-medium-latest', 'magistral-small-latest', 'codestral-latest', 'devstral-medium-latest'] },
  { value: 'Groq', label: 'Groq', host: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'deepseek-r1-distill-llama-70b'] },
  { value: 'SiliconFlow', label: 'SiliconFlow', host: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V2.5', 'deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2-7B-Instruct', 'THUDM/glm-4-9b-chat', 'stabilityai/stable-diffusion-xl-base-1.0'] },
  { value: 'OpenRouter', label: 'OpenRouter', host: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-6-astra', 'openai/gpt-6-astra-pro', 'anthropic/claude-fable-5.1', 'anthropic/claude-opus-5', 'anthropic/claude-sonnet-5', 'google/gemini-3.8-flash', 'google/gemini-3.7-flash', 'x-ai/grok-4.6', 'deepseek/deepseek-v4.1-flash', 'qwen/qwen3.8-max-0902', 'moonshotai/kimi-k3', 'openai/gpt-oss-120b'] },
  { value: 'Ollama', label: 'Ollama (local)', host: 'http://localhost:11434/v1', customHost: true, keyOptional: true, models: ['llama2', 'llama3', 'llama3.1', 'llama3.2', 'llama4', 'gemma', 'gemma2', 'gemma3', 'gemma4', 'qwen', 'qwen2', 'qwen2.5', 'qwen3', 'mistral', 'phi', 'deepseek-r1', 'codellama'] },
];
const _PROVIDER_BASE = (() => { const m = {}; _SET_PROVIDERS.forEach((p) => { m[p.value] = p.host; }); return m; })();
const _TG_DEFAULTS = { clip_path: '', clip_type: 'stable_diffusion', clip_root: '', max_length: 512, sampling_mode: 'on', temperature: 0.7, top_k: 64, top_p: 0.95, min_p: 0.05, repetition_penalty: 1.05, seed: 0, presence_penalty: 0.0, thinking: false, use_default_template: true };
const _CLIP_TYPES = ['stable_diffusion', 'stable_cascade', 'sd3', 'stable_audio', 'mochi', 'ltxv', 'pixart', 'cosmos', 'lumina2', 'wan', 'hidream', 'chroma', 'ace', 'omnigen2', 'qwen_image', 'hunyuan_image', 'flux2', 'ovis', 'longcat_image', 'cogvideox', 'lens', 'pixeldit', 'ideogram4', 'boogu', 'krea2', 'joyimage', 'mage', 'minimax'];
// API 调用参数默认值：'' = 不发送该字段（用厂商默认）；温度 0.7 与原写死值一致。
const _API_PARAMS_DEFAULTS = { temperature: 0.7, top_p: '', max_tokens: '', seed: '', stop: '', reasoning: 'off', webSearch: false };
// llama 默认值：采样参数取 llama.cpp 官方默认，加载参数取 llama-cpp-python 默认（不填就用库自身的值）
const _LL_DEFAULTS = { mode: 'local', model: '', mmproj: '', model_root: '', mmproj_root: '', server: 'http://127.0.0.1:8080', chat_format: '', n_ctx: 2048, n_gpu_layers: 0, n_batch: 512, n_ubatch: 512, n_threads: 0, n_threads_batch: 0, flash_attn: 'auto', use_mmap: false, use_mlock: false, offload_kqv: true, type_k: '', type_v: '', image_min_tokens: -1, image_max_tokens: -1, batch_max_tokens: 1024, vision_use_gpu: true, vision_add_vision_id: false, max_tokens: 256, temperature: 0.7, top_p: 0.95, top_k: 40, min_p: 0.05, typical_p: 1.0, repeat_penalty: 1.1, penalty_last_n: 64, presence_penalty: 0.0, frequency_penalty: 0.0, seed: 0, stop: '' };
// ===== 设置下拉（图三风格：白底圆角列表 + 滚动条）=====
function makeDropdown(items) {
  const root = el('div', 'eph-dd');
  const trigger = el('button', 'eph-dd-trigger'); trigger.type = 'button';
  const label = el('span', 'eph-dd-label');
  const arrow = el('span', 'eph-dd-arrow');
  trigger.appendChild(label); trigger.appendChild(arrow);
  root.appendChild(trigger);
  const menu = el('div', 'eph-dd-menu');
  document.body.appendChild(menu);
  let value = '', onChange = null; const opts = (items || []).slice();
  const lfor = (v) => { const it = opts.find((x) => !(x && x.divider) && (typeof x === 'string' ? x : x.value) === v); return it ? (typeof it === 'string' ? it : it.label) : v; };
  const close = () => menu.classList.remove('active');
  const closeAll = () => document.querySelectorAll('.eph-dd-menu.active').forEach((m) => m.classList.remove('active'));
  const open = () => {
    closeAll();
    const r = trigger.getBoundingClientRect();
    const maxH = Math.max(160, Math.min(300, window.innerHeight - r.bottom - 24));
    menu.style.minWidth = Math.max(r.width, 120) + 'px';
    menu.style.left = r.left + 'px';
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.maxHeight = maxH + 'px';
    menu.style.width = Math.max(r.width, 120) + 'px';
    menu.classList.add('active');
  };
  const render = () => {
    menu.innerHTML = '';
    if (!opts.length) { const e = el('div', 'eph-dd-empty'); e.textContent = ezT('(none)'); menu.appendChild(e); }
    opts.forEach((it) => {
      if (it && it.divider) { menu.appendChild(el('div', 'eph-dd-sep')); return; }
      const v = typeof it === 'string' ? it : it.value;
      const l = typeof it === 'string' ? it : it.label;
      const b = el('button', 'eph-dd-item'); b.type = 'button'; b.textContent = l;
      if (v === value) b.classList.add('active');
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.stopPropagation(); if (v !== value) { value = v; render(); if (onChange) onChange(v); } close(); });
      menu.appendChild(b);
    });
    label.textContent = lfor(value) || '';
  };
  trigger.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); menu.classList.contains('active') ? close() : open(); });
  window.addEventListener('resize', close);
  render();
  const api = {
    el: root,
    get value() { return value; },
    set value(v) { value = String(v || ''); render(); },
    setItems(arr) { opts.length = 0; (arr || []).forEach((x) => opts.push(x)); render(); },
    get count() { return opts.length; },
    onSelect(fn) { onChange = fn; },
    addEventListener(t, fn) { if (t === 'change') onChange = fn; },
    focus() { trigger.focus(); },
  };
  return api;
}
// 分段开关（开启/禁用，图四风格）
function segSwitch(labelText) {
  const cb = el('input'); cb.type = 'checkbox';
  const l = el('label', 'eph-switch');
  const sp = el('span', 'eph-sw-label'); sp.textContent = labelText;
  const seg = el('span', 'eph-seg');
  const onS = el('em', 'eph-seg-item on'); onS.textContent = ezT('On');
  const offS = el('em', 'eph-seg-item off'); offS.textContent = ezT('Off');
  seg.appendChild(onS); seg.appendChild(offS);
  l.appendChild(cb); l.appendChild(sp); l.appendChild(seg);
  const upd = () => { onS.classList.toggle('active', cb.checked); offS.classList.toggle('active', !cb.checked); };
  cb.addEventListener('change', upd); upd(); cb._upd = upd; l._cb = cb;
  return l;
}
function settingsEl() {
  if (_settingsModal && _settingsModal.parentNode) return _settingsModal;
  _settingsModal = el('div', 'eph-settings');
  const box = el('div', 'eph-settings-box');
  const hd = el('div', 'eph-settings-hd');
  const t = el('b'); t.textContent = ezT('Settings');
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  hd.appendChild(t); hd.appendChild(close);
  const body = el('div', 'eph-settings-body');

  // 侧边栏：左侧导航 + 右侧面板（API设置 / TextGenerate设置 / llama设置）
    const sideroot = el('div', 'eph-settings-sideroot');
  const nav = el('div', 'eph-settings-nav');
  const pane = el('div', 'eph-settings-pane');
  sideroot.appendChild(nav); sideroot.appendChild(pane);
  body.appendChild(sideroot);

  //  路径设置：模型扫描目录（前置于 textgen/llama 面板，供 clipboard 下拉用）。
    const clipRootIn = el('input'); clipRootIn.placeholder = ezT('clip model scan directory');
  const llmModelRootIn = el('input'); llmModelRootIn.placeholder = ezT('LLM text encoder model scan directory');
  const mmprojRootIn = el('input'); mmprojRootIn.placeholder = ezT('mmproj vision encoder model scan directory');
  const mkPathRow = (label, inp) => {
    const row = el('label'); const sp = el('span'); sp.textContent = label; row.appendChild(sp);
    const r = el('div', 'eph-path-row'); r.appendChild(inp);
    const b = el('button', 'eph-btn'); b.textContent = ezT('Browse'); r.appendChild(b);
    b.addEventListener('click', async () => {
      try { const res = await fetchApi('/prompt_helper/pick_folder', { method: 'POST' }); const d = await res.json().catch(() => ({})); if (d.ok && d.path) { inp.value = d.path; try { inp.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {} } else if (!d.ok && d.error) phTip(ezT('Selection failed: ')  + d.error); }
      catch (e) { phTip(ezT('Selection failed: ')  + (e && e.message  ?  e.message : e)); }
    });
    row.appendChild(r);
    return row;
  };

  // ---- 通用设置：运行期自动优化（滑块开关，显示  开启/禁用；三者互斥，最多一个生效）----
  const grid0 = el('div', 'eph-settings-grid active');
  const _AUTO_KEYS = ['autoTextgen', 'autoApi', 'autoLlama'];
  const mkSwitch = (label, key) => {
    const l = segSwitch(label);
    const cb = l._cb;
    cb.addEventListener('change', () => {
      //  只在「三种自动优化方式」之间互斥；clearCache  可独立开关。
            if (cb.checked && _AUTO_KEYS.includes(key)) { _AUTO_KEYS.forEach((k) => { if (k !== key && grid0._auto[k]) { grid0._auto[k].checked = false; grid0._auto[k]._upd && grid0._auto[k]._upd(); } }); }
    });
    grid0._auto = grid0._auto || {}; grid0._auto[key] = cb;
    grid0.appendChild(l);
    return cb;
  };
  mkSwitch(ezT('Runtime auto-optimize (TextGenerate)'), 'autoTextgen');
  mkSwitch(ezT('Runtime auto-optimize (API)'), 'autoApi');
  mkSwitch(ezT('Runtime auto-optimize (llama)'), 'autoLlama');
  mkSwitch(ezT('Clear model cache after call'), 'clearCache');
  pane.appendChild(grid0);

  // ---- 规则设置：卡片合并分隔符号 + 提示词规范表（下拉选择 / 新建自定义 / 保存 / 删除 + 下方信息）----
  const grid1r = el('div', 'eph-settings-grid');
  const sepIn = el('input'); sepIn.type = 'text'; sepIn.value = '\\n'; grid1r._sep = sepIn;
  fld2(grid1r, ezT('Card merge separator'), sepIn,
    ezT('When "Merge prompts" joins card bodies into one paragraph, this separator is inserted between cards.\nDefault \\n = newline; \\n\\n = blank line; you can also enter custom text such as ", " or "---".\nIn the box, \\n (newline) / \\t (tab) are treated as real control characters; blank = newline.'));
  secTitle(grid1r, ezT('Prompt specs (media refs / time rules / rule hints)'));
  const rbox = el('div', 'eph-rule-box');
  // 一行：规范下拉 + 删除规范 + 自定义名称 + 保存规范
  const rTop = el('div', 'eph-cm-row');
  const rDD = makeDropdown([]); rDD.el.style.flex = '1 1 auto';
  const rDel = el('button', 'eph-btn danger'); rDel.textContent = ezT('Delete spec');
  const rName = el('input'); rName.placeholder = ezT('Custom spec name');
  const rSave = el('button', 'eph-btn'); rSave.textContent = ezT('Save spec');
  rTop.appendChild(rDD.el); rTop.appendChild(rDel); rTop.appendChild(rName); rTop.appendChild(rSave);
  const rg = el('div', 'eph-rule-grid');
  const mkIn = (ph) => { const i = el('input'); i.placeholder = ph; return i; };
  const rf = { image: mkIn(ezT('e.g. <Picture {n}>')), video: mkIn(ezT('e.g. <Video {n}>')), audio: mkIn(ezT('e.g. <Audio {n}>')) };
  const rTpl = mkIn(ezT('start start time · end end time · dur duration · S shot no. · M time · text body'));
  setTip(rTpl, ezT('Time rule template: only placeholders written in the template take effect.\n{start} start time (s)\n{end} end time (s)\n{dur} duration (s; blank = end - start)\n{S} shot number\n{M} time (seconds auto-convert to 00:03.500)\n{text} card body (filled automatically, no need to enter)\nLeave the whole thing blank = this spec has no timestamp.'));
  const rNote = el('textarea');
  const rField = (labelText, node) => { const l = el('label'); l.appendChild(el('span')).textContent = labelText; l.appendChild(node); rg.appendChild(l); return l; };
  rField(ezT('Image ref'), rf.image);
  rField(ezT('Video ref'), rf.video);
  rField(ezT('Audio ref'), rf.audio);
  rField(ezT('Time rule'), rTpl);
  rField(ezT('Rule hint'), rNote);
  const rLangWrap = el('div', 'eph-lang-wrap');   // 中/EN（只有双语规范才显示）
  rbox.appendChild(rTop); rbox.appendChild(rLangWrap); rbox.appendChild(rg);
  grid1r.appendChild(rbox);
  grid1r._state = { custom: [], overrides: {}, ruleId: 'none' };
  const rItems = () => {
    const arr = [{ value: '__new__', label: ezT('+ New custom spec…') }];
    _PROMPT_RULES.forEach((r) => { const ov = grid1r._state.overrides[r.id]; arr.push({ value: r.id, label: (ov && ov.label) || r.label }); });
    if (grid1r._state.custom.length) { arr.push({ divider: true }); grid1r._state.custom.forEach((r) => arr.push({ value: r.id, label: r.label })); }
    return arr;
  };
  const rRuleRaw = (id) => {   // 不分语言，含 alt
    const base = _PROMPT_RULES.concat(grid1r._state.custom).find((r) => r.id === id) || null;
    return (base && _BUILTIN_RULE_IDS.includes(base.id)) ? _applyOverride(base, grid1r._state.overrides[base.id]) : base;
  };
  const rRuleOf = (id) => _pickLang(rRuleRaw(id), grid1r._state.editLang);
  const rSetEditing = (raw, isNew) => {
    const rule = _pickLang(raw, grid1r._state.editLang) || { ref: {}, ts: {}, note: '' };
    const ref = rule.ref || {}, ts = rule.ts || {};
    rf.image.value = ref.image || ''; rf.video.value = ref.video || ''; rf.audio.value = ref.audio || '';
    rTpl.value = ts.tpl || '';
    rNote.value = rule.note || '';
    rName.value = isNew ? '' : (rule.label || '');
    const builtin = !!(raw && _BUILTIN_RULE_IDS.includes(raw.id));
    const changed = builtin && !!grid1r._state.overrides[raw.id];
    [rf.image, rf.video, rf.audio, rTpl, rNote, rName].forEach((i) => { i.readOnly = false; });
    rSave.disabled = false; rDel.disabled = builtin ? !changed : false;
    rDel.textContent = builtin ? ezT('Restore default') : ezT('Delete spec');
    rLangWrap.innerHTML = '';
    if (raw && raw.alt) {   // 这条规范有中英两版 → 显示切换
      rLangWrap.appendChild(mkLangToggle(grid1r._state.editLang, (k) => { grid1r._state.editLang = k; grid1r._state.lang = k; rSetEditing(raw, false); }));
    } else {
      grid1r._state.editLang = 'zh';
    }
  };
  grid1r._fill = (ruleId, custom, overrides, lang) => {
    grid1r._state.custom = Array.isArray(custom) ? deepClone(custom) : [];
    grid1r._state.overrides = (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) ? deepClone(overrides) : {};
    grid1r._state.ruleId = _normRuleId(ruleId) || 'none';
    grid1r._state.editLang = (lang === 'en') ? 'en' : 'zh';
    grid1r._state.lang = grid1r._state.editLang;
    rDD.setItems(rItems()); rDD.value = grid1r._state.ruleId;
    rSetEditing(rRuleRaw(grid1r._state.ruleId), false);
  };
  grid1r._reset = () => grid1r._fill('none', [], {}, 'zh');
  grid1r._getCustom = () => grid1r._state.custom;
  grid1r._getOverrides = () => grid1r._state.overrides;
  grid1r._getLang = () => grid1r._state.lang;
  grid1r._getRuleId = () => grid1r._state.ruleId;
  grid1r._setRule = (id) => { id = _normRuleId(id); grid1r._state.ruleId = id; rDD.value = id; rSetEditing(rRuleRaw(id), false); };
  rDD.addEventListener('change', (v) => {
    if (v === '__new__') { rDD.value = grid1r._state.ruleId; rSetEditing(null, true); return; }
    grid1r._state.ruleId = v; rSetEditing(rRuleRaw(v), false);
  });
  rSave.addEventListener('click', () => {
    const ts = { tpl: rTpl.value.trim() };
    if (!ts.tpl) ts.off = true;
    const ref = {};
    ['image', 'video', 'audio'].forEach((k) => { const v = rf[k].value.trim(); if (v) ref[k] = v; });   // 留空 = 不写规则，原样保留标记
    const cur = rRuleRaw(grid1r._state.ruleId);
    if (cur && _BUILTIN_RULE_IDS.includes(cur.id)) {   // 内置规范：存成覆盖，不新增自定义
      const base = _PROMPT_RULES.find((x) => x.id === cur.id) || {};
      const baseLang = cur.base === 'en' ? 'en' : 'zh';
      const ov = Object.assign({}, grid1r._state.overrides[cur.id] || {});
      if (grid1r._state.editLang === baseLang) {   // 改的是默认语言那一份
        ov.ref = ref; ov.ts = ts; ov.note = rNote.value;
      } else {                                     // 改的是另一种语言那一份
        ov.alt = Object.assign({}, (ov.alt && typeof ov.alt === 'object') ? ov.alt : (cur.alt || {}), { ref, ts, note: rNote.value });
      }
      if (cur.alt) ov.base = baseLang;
      const label = rName.value.trim();
      if (label && label !== base.label) ov.label = label; else delete ov.label;
      grid1r._state.overrides[cur.id] = ov;
      grid1r._state.ruleId = cur.id;
      rDD.setItems(rItems()); rDD.value = cur.id; rSetEditing(rRuleRaw(cur.id), false);
      return;
    }
    const name = rName.value.trim();
    if (!name) { phTip(ezT('Enter a custom spec name first.')); return; }
    const id = (cur && !_BUILTIN_RULE_IDS.includes(cur.id)) ? cur.id : ('cust_' + Date.now().toString(36));
    const rec = { id, label: name, ref, ts, note: rNote.value };
    const i = grid1r._state.custom.findIndex((x) => x.id === id);
    if (i >= 0) grid1r._state.custom[i] = rec; else grid1r._state.custom.push(rec);
    grid1r._state.ruleId = id;
    rDD.setItems(rItems()); rDD.value = id; rSetEditing(rec, false);
  });
  rDel.addEventListener('click', () => {
    const cur = rRuleOf(grid1r._state.ruleId);
    if (cur && _BUILTIN_RULE_IDS.includes(cur.id)) {   // 内置规范：恢复默认（删掉覆盖）
      if (!grid1r._state.overrides[cur.id]) return;
      delete grid1r._state.overrides[cur.id];
      rDD.setItems(rItems()); rDD.value = cur.id; rSetEditing(rRuleOf(cur.id), false);
      return;
    }
    if (!cur) return;
    grid1r._state.custom = grid1r._state.custom.filter((x) => x.id !== cur.id);
    grid1r._state.ruleId = 'none';
    rDD.setItems(rItems()); rDD.value = 'none'; rSetEditing(rRuleOf('none'), false);
  });
  pane.appendChild(grid1r);

  // ---- API设置 ----
  const grid1 = el('div', 'eph-settings-grid');
  const provDD = makeDropdown(_SET_PROVIDERS.map((p) => ({ value: p.value, label: ezT(p.label) })));
  const modelDD = makeDropdown();
  const apiUrlIn = el('input'); apiUrlIn.placeholder = ezT('API host (auto-filled by default)'); apiUrlIn.value = '';
  const apiKeyIn = el('input'); apiKeyIn.type = 'password'; apiKeyIn.placeholder = 'API Key';
  const proxyIn = el('input'); proxyIn.value = ''; proxyIn.placeholder = ezT('e.g. http://127.0.0.1:7890 (blank = direct)');
  const mkFld = (host, labelText, node) => { const l = el('label'); const sp = el('span'); sp.textContent = labelText; l.appendChild(sp); l.appendChild(node); host.appendChild(l); return l; };
  const cNameIn = el('input'); cNameIn.placeholder = ezT('Name (e.g. My-Proxy)');
  const cProviderIn = el('input'); cProviderIn.placeholder = ezT('e.g. OpenAI / DeepSeek / Claude');
  const cModelIn = el('input'); cModelIn.placeholder = ezT('Model ID (e.g. my-model-v1)');
  const cUrlIn = el('input'); cUrlIn.placeholder = ezT('API host (auto-filled by default)');
  const cKeyIn = el('input'); cKeyIn.type = 'password'; cKeyIn.placeholder = 'API Key';
  const cProxyIn = el('input'); cProxyIn.placeholder = ezT('e.g. http://127.0.0.1:7890 (blank = direct)');

  // 模式切换：默认 / 自定义（滑到哪个用哪个，另一侧不用）
  const modeWrap = el('div', 'eph-mode');
  const mDef = el('button', 'eph-mode-opt'); mDef.type = 'button'; mDef.textContent = ezT('Default');
  const mCus = el('button', 'eph-mode-opt'); mCus.type = 'button'; mCus.textContent = ezT('Custom');
  modeWrap.appendChild(mDef); modeWrap.appendChild(mCus);
  grid1.appendChild(modeWrap);

  //  中间按钮行（右侧）：新增自定义api / 保存为自定义 / 保存api设置 / 删除自定义api
  const btnRow = el('div', 'eph-settings-btnrow');
  const btnNewCustom = el('button', 'eph-btn'); btnNewCustom.textContent = ezT('New custom API');
  const btnSaveAsCustom = el('button', 'eph-btn eph-btn-save'); btnSaveAsCustom.textContent = ezT('Save as custom'); btnSaveAsCustom.style.cssText = 'background:#1a1a2e;border-color:#1a1a2e;color:#fff;';
  const btnSaveEdit = el('button', 'eph-btn eph-btn-save'); btnSaveEdit.textContent = ezT('Save API settings'); btnSaveEdit.style.cssText = 'background:#1a1a2e;border-color:#1a1a2e;color:#fff;';
  const btnDeleteCustom = el('button', 'eph-btn eph-btn-cancel'); btnDeleteCustom.textContent = ezT('Delete custom API');
  btnRow.appendChild(btnNewCustom); btnRow.appendChild(btnSaveAsCustom); btnRow.appendChild(btnSaveEdit); btnRow.appendChild(btnDeleteCustom);
  grid1.appendChild(btnRow);

  // 默认厂商模式
  const defaultWrap = el('div', 'eph-settings-sub'); grid1.appendChild(defaultWrap);
  mkFld(defaultWrap, ezT('Model provider'), provDD.el);
  mkFld(defaultWrap, ezT('Model selection'), modelDD.el);
  mkFld(defaultWrap, ezT('API host'), apiUrlIn);
  mkFld(defaultWrap, 'API Key', apiKeyIn);
  mkFld(defaultWrap, ezT('Proxy (optional)'), proxyIn);

  //  自定义厂商模式：下拉选择已保存预设 + 下方显示参数
  const customWrap = el('div', 'eph-settings-sub'); grid1.appendChild(customWrap);
  const customDD = makeDropdown();
  mkFld(customWrap, ezT('Custom API'), customDD.el);
  mkFld(customWrap, ezT('Custom name'), cNameIn);
  mkFld(customWrap, ezT('Model provider'), cProviderIn);
  mkFld(customWrap, ezT('Model ID'), cModelIn);
  mkFld(customWrap, ezT('API host'), cUrlIn);
  mkFld(customWrap, 'API Key', cKeyIn);
  mkFld(customWrap, ezT('Proxy (optional)'), cProxyIn);

  // ---- API 调用参数（API 优化用；留空 = 不发送该字段，用厂商默认）----
  secTitle(grid1, ezT('Call parameters'));
  const apWrap = el('div', 'eph-settings-sub');
  const apTemp = el('input'); apTemp.type = 'number';
  const apTopP = el('input'); apTopP.type = 'number';
  const apMax = el('input'); apMax.type = 'number';
  const apSeed = el('input'); apSeed.type = 'number';
  const apStop = el('input'); apStop.type = 'text';
  const apReason = makeDropdown([{ value: 'off', label: ezT('None') }, { value: 'low', label: ezT('Low') }, { value: 'medium', label: ezT('Medium') }, { value: 'high', label: ezT('High') }]);
  const apWeb = segSwitch(ezT('Web search'));
  mkFld(apWrap, ezT('Temperature'), apTemp);
  mkFld(apWrap, 'Top P', apTopP);
  mkFld(apWrap, ezT('Max tokens max_tokens'), apMax);
  mkFld(apWrap, ezT('Seed'), apSeed);
  mkFld(apWrap, ezT('Stop strings (comma-separated)'), apStop);
  mkFld(apWrap, ezT('Reasoning effort'), apReason.el);
  const apCustom = el('textarea'); apCustom.placeholder = '{"reasoning_effort":"high"}';
  mkFld(apWrap, ezT('Custom parameters (JSON key-value pairs)'), apCustom);
  apWrap.appendChild(apWeb);
  grid1.appendChild(apWrap);
  grid1._ap = { temperature: apTemp, top_p: apTopP, max_tokens: apMax, seed: apSeed, stop: apStop, reasoning: apReason, webSearch: apWeb._cb, custom: apCustom };

  const providerMeta = () => _SET_PROVIDERS.find((x) => x.value === provDD.value) || {};
  const setModels = () => {
    const p = _SET_PROVIDERS.find((x) => x.value === provDD.value);
    const models = (p && Array.isArray(p.models)) ? p.models : [];
    const cur = modelDD.value;
    const ms = models.slice();
    if (cur && !ms.includes(cur)) ms.unshift(cur);
    modelDD.setItems(ms);
    if (cur && ms.includes(cur)) modelDD.value = cur;
    else if (ms.length) modelDD.value = ms[0];
    apiKeyIn.placeholder = providerMeta().keyOptional  ?  ezT('API Key (can be blank for Ollama)') : 'API Key';
  };
  provDD.addEventListener('change', () => { if (_PROVIDER_BASE[provDD.value]) apiUrlIn.value = _PROVIDER_BASE[provDD.value]; modelDD.value = ''; setModels(); });

  // 自定义 API 预设（与 userdata 同文件；custom=true 为自定义厂商，custom=false 为默认厂商保存的预设）
  let _curMode = 'default';
  const _customProviders = [];
  let _customSelected = null;
  const renderCustomDD = () => {
    const items = _customProviders.map((p) => ({ value: p.name, label: p.name }));
    customDD.setItems(items);
    if (_customSelected && _customProviders.some((p) => p.name === _customSelected.name)) customDD.value = _customSelected.name;
    else customDD.value = '';
  };
  const applyCustomFields = (p) => { cNameIn.value = p.name || ''; cNameIn.readOnly = false; cProviderIn.value = p.provider || p.name || ''; cModelIn.value = p.model || ''; cUrlIn.value = p.apiUrl || ''; cKeyIn.value = p.apiKey || ''; cProxyIn.value = p.proxy || ''; };
  const clearCustomFields = () => { cNameIn.value = ''; cNameIn.readOnly = false; cProviderIn.value = ''; cModelIn.value = ''; cUrlIn.value = ''; cKeyIn.value = ''; cProxyIn.value = ''; };
  const loadCustom = async () => {
    try { const r = await fetchApi('/prompt_helper/custom_providers'); const d = await r.json().catch(() => ({})); const arr = Array.isArray(d.providers)  ?  d.providers : []; _customProviders.length = 0; arr.forEach((x) => { _customProviders.push({ name: x.name || '', provider: x.provider || x.name || '自定义', model: x.model || '', apiUrl: x.apiUrl || '', apiKey: x.apiKey || '', proxy: x.proxy || '', custom: x.custom !== false }); }); } catch (_) { _customProviders.length = 0; }
    renderCustomDD();
  };
  const deleteCustom = async (name) => {
    try { await fetchApi('/prompt_helper/custom_providers?name=' + encodeURIComponent(name), { method: 'DELETE' }); } catch (_) {}
    if (_customSelected && _customSelected.name === name) { _customSelected = null; clearCustomFields(); }
    await loadCustom();
  };
  const saveCustom = async () => {
    // 保存api设置：更新当前选中的预设（改名则先删旧再建新），或新增（点击保存才生效）
        const editingExisting = !!_customSelected;
    const name = cNameIn.value.trim(); if (!name) { phTip(ezT('Enter a custom name first')); return; }
    const provider = cProviderIn.value.trim() || (editingExisting ? _customSelected.provider : name);
    const rec = { name, provider, model: cModelIn.value.trim(), apiUrl: cUrlIn.value.trim(), apiKey: cKeyIn.value.trim(), proxy: cProxyIn.value.trim(), custom: editingExisting ? !!_customSelected.custom : true };
    if (editingExisting && name !== _customSelected.name) {
      try { await fetchApi('/prompt_helper/custom_providers?name=' + encodeURIComponent(_customSelected.name), { method: 'DELETE' }); } catch (_) {}
    }
    try { const r = await fetchApi('/prompt_helper/custom_providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) }); const d = await r.json().catch(() => ({})); if (d.error) { phTip(ezT('Save failed: ')  + d.error); return; } _customSelected = rec; await loadCustom(); } catch (e) { phTip(ezT('Save failed: ')  + (e && e.message  ?  e.message : e)); }
  };
  const saveCurrent = async () => {
    // 保存为自定义：把当前默认厂商所选的 provider/model/apiKey 存为新命名预设（默认  deepseek1/2…）
    await loadCustom();
    const provider = provDD.value; const base = (provider || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const nums = _customProviders.map((x) => /^([a-z0-9]+)(\d+)$/.exec((x.name || '').toLowerCase())).filter((m) => m && m[1] === base).map((m) => parseInt(m[2], 10));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    const name = (await uiPrompt(ezT('Name for saved custom API:'), base + next)) || ''; if (!name.trim()) return;
    const rec = { name: name.trim(), provider, model: modelDD.value, apiUrl: apiUrlIn.value.trim(), apiKey: apiKeyIn.value.trim(), proxy: proxyIn.value.trim(), custom: false };
    try { const r = await fetchApi('/prompt_helper/custom_providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) }); const d = await r.json().catch(() => ({})); if (d.error) { phTip(ezT('Save failed: ')  + d.error); return; } await loadCustom(); } catch (e) { phTip(ezT('Save failed: ')  + (e && e.message  ?  e.message : e)); }
  };
  const setMode = (m) => {
    _curMode = m;
    mDef.classList.toggle('active', m === 'default');
    mCus.classList.toggle('active', m === 'custom');
    defaultWrap.style.display = m === 'default' ? '' : 'none';
    customWrap.style.display = m === 'custom' ? '' : 'none';
    btnSaveAsCustom.style.display = m === 'default' ? '' : 'none';
    btnNewCustom.style.display = m === 'custom' ? '' : 'none';
    btnSaveEdit.style.display = m === 'custom' ? '' : 'none';
    btnDeleteCustom.style.display = m === 'custom' ? '' : 'none';
    if (m === 'custom') loadCustom();
  };
  const persistMode = (m) => { if (!_settingsNode) return; const cfg = readConfig(_settingsNode, {}); const opt = (cfg.optimize && typeof cfg.optimize === 'object') ? cfg.optimize : {}; opt.customMode = (m === 'custom'); writeConfig(_settingsNode, { optimize: opt, cards: cfg.cards, rules: cfg.rules }); };
  mDef.addEventListener('click', () => { if (_curMode !== 'default') { setMode('default'); persistMode('default'); } });
  mCus.addEventListener('click', () => { if (_curMode !== 'custom') { setMode('custom'); persistMode('custom'); } });
  btnNewCustom.addEventListener('click', () => { _customSelected = null; clearCustomFields(); renderCustomDD(); });
  btnSaveAsCustom.addEventListener('click', saveCurrent);
  btnSaveEdit.addEventListener('click', saveCustom);
  btnDeleteCustom.addEventListener('click', async () => {
    if (!_customSelected) { phTip(ezT('Select the preset to delete in the dropdown first')); return; }
    if (!(await uiConfirm(ezT('Delete custom API "')  + _customSelected.name + ezT('"?')))) return;
    await deleteCustom(_customSelected.name);
  });
  customDD.addEventListener('change', (v) => { const p = _customProviders.find((x) => x.name === v); if (p) { _customSelected = p; applyCustomFields(p); } });
  setMode('default');

  pane.appendChild(grid1);

  // ---- TextGenerate设置（参数与 ComfyUI 官方 TextGenerate 节点一一对应）---
  const grid2 = el('div', 'eph-settings-grid');
  const numField = (labelText, key, def, tipText) => { const inp = el('input'); inp.type = 'number'; inp.value = String(def); grid2._tg = grid2._tg || {}; grid2._tg[key] = inp; fld2(grid2, labelText, inp, tipText); return inp; };
  const tgDD = (labelText, key, opts, tipText) => { const dd = makeDropdown((opts || []).map(([v, l]) => ({ value: v, label: l }))); grid2._tg = grid2._tg || {}; grid2._tg[key] = dd; fld2(grid2, labelText, dd.el, tipText); return dd; };
  const tgChk = (labelText, key, def, tipText) => { const l = segSwitch(labelText); l._cb.checked = !!def; l._cb._upd(); grid2._tg = grid2._tg || {}; grid2._tg[key] = l._cb; setTip(l, tipText); grid2.appendChild(l); return l._cb; };
  // CLIP 模型选择（放最上面，点击即用 textgen，像 llama  一样自加载）
    const clipPath = el('input'); clipPath.type = 'text'; clipPath.value = ''; clipPath.placeholder = ezT('e.g. text_encoders/...safetensors');
  const clipTypeDD = makeDropdown(_CLIP_TYPES.map((t) => ({ value: t, label: t })));
  grid2._tg = grid2._tg || {}; grid2._tg.clip_path = clipPath; grid2._tg.clip_type = clipTypeDD; grid2._tg.clip_root = clipRootIn;
  secTitle(grid2, ezT('Model'));
  fld2(grid2, ezT('clip model'), attachFileMenu(clipPath, '/prompt_helper/clip_models', () => clipRootIn.value.trim()),
    ezT('Text encoder used by TextGenerate (a text-gen CLIP with generate capability: Gemma / Qwen3-VL / flux2, etc.).\nClick the input to pick a file scanned from the "Paths" directories; a plain stable_diffusion CLIP cannot generate text.'));
  fld2(grid2, ezT('CLIP type'), clipTypeDD.el, ezT('ComfyUI CLIPType matching the clip model (e.g. qwen_image / flux2).\nA wrong choice fails to load or produces garbled output.'));
  secTitle(grid2, ezT('Sampling'));
  numField(ezT('Max length'), 'max_length', _TG_DEFAULTS.max_length, ezT('Maximum number of tokens to generate (new tokens beyond the prompt).\n512 ≈ 300-400 Chinese characters; larger is slower and uses more VRAM.'));
  tgDD(ezT('Sampling mode'), 'sampling_mode', [['on', 'on'], ['off', 'off']], ezT('on = random sampling by the temperature / Top K / Top P below; off = greedy decoding (same result every time, stable but rigid).'));
  numField(ezT('Temperature'), 'temperature', _TG_DEFAULTS.temperature, ezT('Randomness. Low (0.2-0.5) is stable and conservative, high (0.9-1.2) is divergent and creative; official default 0.7.'));
  numField('Top K', 'top_k', _TG_DEFAULTS.top_k, ezT('Sample only from the K most likely candidates, 0 = disable this filter; official default 64.'));
  numField('Top P', 'top_p', _TG_DEFAULTS.top_p, ezT('Nucleus sampling: only candidates within cumulative probability P participate, smaller is more conservative; official default 0.95.'));
  numField(ezT('Min P'), 'min_p', _TG_DEFAULTS.min_p, ezT('A candidate is kept only if its probability ≥ max probability × min_p (cuts obviously impossible tokens); official default 0.05.'));
  numField(ezT('Repetition penalty'), 'repetition_penalty', _TG_DEFAULTS.repetition_penalty, ezT('>1 suppresses repeated words (1.05 mild, 1.2 strong), 1.0 = no penalty; too high makes sentences stiff.'));
  numField(ezT('Seed'), 'seed', _TG_DEFAULTS.seed, ezT('0 or blank = random each time; a fixed value = the same result each time (reproducible).'));
  numField(ezT('Presence penalty'), 'presence_penalty', _TG_DEFAULTS.presence_penalty, ezT('Presence penalty: once a word has appeared, its probability is lowered to encourage new content; 0 = off.'));
  secTitle(grid2, ezT('Options'));
  tgChk(ezT('Thinking mode'), 'thinking', _TG_DEFAULTS.thinking, ezT('Let thinking-capable models (e.g. Qwen3-VL) output their reasoning before the result.\nUnsupported models will output extra irrelevant content.'));
  tgChk(ezT('Use default template'), 'use_default_template', _TG_DEFAULTS.use_default_template, ezT('Wrap the prompt with the model built-in system / chat template; turn off to feed plain text directly.'));
  pane.appendChild(grid2);

  // ---- llama设置 ----
  const grid3 = el('div', 'eph-settings-grid');
  const llField = (labelText, key, def, tipText) => { const inp = el('input'); inp.type = 'number'; inp.value = String(def); if (key === 'model' || key === 'mmproj' || key === 'server' || key === 'stop' || key === 'chat_format') { inp.type = 'text'; } grid3._ll = grid3._ll || {}; grid3._ll[key] = inp; fld2(grid3, labelText, inp, tipText); return inp; };
  const llDD = (labelText, key, opts, tipText) => { const dd = makeDropdown((opts || []).map(([v, l]) => ({ value: v, label: l }))); grid3._ll = grid3._ll || {}; grid3._ll[key] = dd; fld2(grid3, labelText, dd.el, tipText); return dd; };
  const llChk = (labelText, key, def, tipText) => { const l = segSwitch(labelText); l._cb.checked = !!def; l._cb._upd(); grid3._ll = grid3._ll || {}; grid3._ll[key] = l._cb; setTip(l, tipText); grid3.appendChild(l); return l._cb; };
  secTitle(grid3, ezT('Model'));
  const llModeDD = makeDropdown([{ value: 'local', label: ezT('In-process llama-cpp-python') }, { value: 'server', label: ezT('llama.cpp server (HTTP)') }]);
  grid3._ll = grid3._ll || {}; grid3._ll.mode = llModeDD; fld2(grid3, ezT('Call mode'), llModeDD.el,
    ezT('In-process = this process loads the GGUF directly with llama-cpp-python (no server needed, uses local RAM/VRAM);\nServer (HTTP) = call an already-running llama.cpp server (the loading options below do not apply, sampling options are still sent).'));
  grid3._ll.model_root = llmModelRootIn; grid3._ll.mmproj_root = mmprojRootIn;
  const llModel = el('input'); llModel.type = 'text'; llModel.value = String(_LL_DEFAULTS.model); llModel.placeholder = ezT('Relative or absolute path');
  grid3._ll.model = llModel;
  fld2(grid3, ezT('LLM text encoder model'), attachFileMenu(llModel, '/prompt_helper/llama_models', () => llmModelRootIn.value.trim()),
    ezT('Main GGUF model (text inference). A file name is enough; searched recursively under the "Paths" directories; an absolute path also works.'));
  const llMmproj = el('input'); llMmproj.type = 'text'; llMmproj.value = String(_LL_DEFAULTS.mmproj); llMmproj.placeholder = ezT('e.g. mmproj-Qwen3-VL-8B-Instruct-Q8_0.gguf');
  grid3._ll.mmproj = llMmproj;
  fld2(grid3, ezT('mmproj vision encoder model'), attachFileMenu(llMmproj, '/prompt_helper/llama_models', () => mmprojRootIn.value.trim()),
    ezT('Multimodal projection model (mmproj GGUF). Must match the main model family; required for image input;\nleave blank for text-only models, in which case images report "does not support image inputs".'));
  const llServer = llField(ezT('Server address'), 'server', _LL_DEFAULTS.server, ezT('Used only in "llama.cpp server (HTTP)" mode, e.g. http://127.0.0.1:8080.\nYou must start the server yourself first (llama-server -m model.gguf --mmproj ...).')); llServer.placeholder = ezT('e.g. http://127.0.0.1:8080');
  llField(ezT('Chat template chat_format'), 'chat_format', _LL_DEFAULTS.chat_format, ezT('Chat template name used for in-process loading (e.g. qwen2-vl / llama-3 / chatml).\nBlank = use the tokenizer.chat_template bundled in the GGUF; usually fine to leave blank.'));
  secTitle(grid3, ezT('Loading (in-process mode only)'));
  llField(ezT('Context length n_ctx'), 'n_ctx', _LL_DEFAULTS.n_ctx, ezT('Context window: total token limit for prompt + generation.\nLarger uses more RAM/VRAM; images add vision tokens (a few hundred to a thousand per image for Qwen3-VL).'));
  llField(ezT('GPU layers n_gpu_layers'), 'n_gpu_layers', _LL_DEFAULTS.n_gpu_layers, ezT('Layers offloaded to the GPU: 0 = CPU only (default, least VRAM but slow);\n99 or ≥ the model layer count offloads everything (a 4B Q4 needs about 3-4 GB VRAM).'));
  llField('batch n_batch', 'n_batch', _LL_DEFAULTS.n_batch, ezT('Logical batch size: tokens processed per submission, affects prompt processing speed.\nSmaller uses less VRAM.'));
  llField(ezT('Micro batch n_ubatch'), 'n_ubatch', _LL_DEFAULTS.n_ubatch, ezT('Physical micro-batch size, must be ≤ n_batch.\nLower it (e.g. 128 / 256) when VRAM is tight or long prompts report out of memory.'));
  llField(ezT('CPU threads n_threads'), 'n_threads', _LL_DEFAULTS.n_threads, ezT('CPU generation/decoding threads.\n0 or -1 = auto (about half the physical cores); the default is usually fine.'));
  llField(ezT('CPU batch threads n_threads_batch'), 'n_threads_batch', _LL_DEFAULTS.n_threads_batch, ezT('CPU threads for prompt processing (prefill/image encoding), affects time to first token.\n0 or -1 = auto (about the physical core count); for CPU inference set it equal to the physical core count.'));
  llDD('Flash Attention', 'flash_attn', [['auto', ezT('auto (follow runtime)')], ['on', ezT('on (enabled)')], ['off', ezT('off (disabled)')]],
    ezT('Attention acceleration: on saves VRAM and is faster (when the backend supports it); off disables it; auto lets the runtime decide.\nReload the model to apply; required when using q4_0/q8_0 V-cache quantization.'));
  llDD(ezT('K cache type type_k'), 'type_k', [['', ezT('Default (f16, no quantization)')], ['q8_0', ezT('q8_0 (about half the K VRAM)')], ['q4_0', ezT('q4_0 (about 3/4 less, slight precision loss)')]],
    ezT('Data type of K in the KV cache: quantization clearly saves VRAM with long contexts / large n_ctx.\nDefault f16 without quantization; reload the model after changing.'));
  llDD(ezT('V cache type type_v'), 'type_v', [['', ezT('Default (f16, no quantization)')], ['q8_0', ezT('q8_0 (about half the V VRAM)')], ['q4_0', ezT('q4_0 (about 3/4 less, slight precision loss)')]],
    ezT('Data type of V in the KV cache. When not f16, llama.cpp requires Flash Attention (set Flash Attention to on on this page), otherwise loading fails.'));
  llChk(ezT('Memory mapping use_mmap'), 'use_mmap', _LL_DEFAULTS.use_mmap, ezT('On = map the model file from disk on demand (faster startup, lower peak memory);\nOff = read it into memory at once (default). Reload the model to apply.'));
  llChk(ezT('Lock memory use_mlock'), 'use_mlock', _LL_DEFAULTS.use_mlock, ezT('Lock the model in physical memory to keep it from being paged out (avoids stutter).\nWith too little physical memory this is slower or even fails.'));
  llChk(ezT('KQV offload offload_kqv'), 'offload_kqv', _LL_DEFAULTS.offload_kqv, ezT('Run K/Q/V attention computation on the GPU too (default on, trades VRAM for speed).\nTurning it off saves VRAM but is clearly slower.'));
  secTitle(grid3, ezT('Vision (mmproj; set the vision encoder model)'));
  llField(ezT('Image max tokens image_max_tokens'), 'image_max_tokens', _LL_DEFAULTS.image_max_tokens, ezT('With vision (mmproj), the maximum number of tokens one image is split into - the "image token cap".\nDefault -1 = unlimited (use the mmproj bundled setting); lower values (e.g. 512/256) save VRAM and speed up vision but lose detail.\nNote: below 1024 the Qwen-VL family makes llama.cpp warn "require at minimum 1024 image tokens" and fine-grained grounding gets worse.\nTakes effect only when mmproj is set.'));
  llField(ezT('Image min tokens image_min_tokens'), 'image_min_tokens', _LL_DEFAULTS.image_min_tokens, ezT('With vision (mmproj), the minimum number of tokens kept per image.\nDefault -1 = unlimited; must be ≤ image max tokens or loading fails.'));
  llField(ezT('Vision batch cap batch_max_tokens'), 'batch_max_tokens', _LL_DEFAULTS.batch_max_tokens, ezT('Maximum tokens the vision encoder processes at once (mmproj batch cap, default 1024).\nLower it (e.g. 512 / 256) when large images report out of memory.'));
  llChk(ezT('Vision encoding on GPU vision_use_gpu'), 'vision_use_gpu', _LL_DEFAULTS.vision_use_gpu, ezT('Whether the mmproj vision encoder runs on the GPU (default on).\nTurn off for CPU encoding: saves VRAM but vision is clearly slower; you can keep it on even with n_gpu_layers=0.'));
  llChk(ezT('Annotate image index add_vision_id'), 'vision_add_vision_id', _LL_DEFAULTS.vision_add_vision_id, ezT('Add an index prefix like "Picture 1:" to each image in the prompt (a variable supported by Qwen-VL family templates).\nUseful to tell multiple images apart; negligible effect with a single image.'));
  secTitle(grid3, ezT('Sampling (both modes)'));
  llField(ezT('Max tokens'), 'max_tokens', _LL_DEFAULTS.max_tokens, ezT('Maximum number of tokens to generate (output length cap).'));
  llField(ezT('Temperature'), 'temperature', _LL_DEFAULTS.temperature, ezT('Randomness: low (0.2-0.5) is stable, high (0.9+) diverges; llama.cpp official default 0.8.'));
  llField('Top P', 'top_p', _LL_DEFAULTS.top_p, ezT('Nucleus sampling, official default 0.95; smaller is more conservative.'));
  llField('Top K', 'top_k', _LL_DEFAULTS.top_k, ezT('Sample only from the K most likely candidates, 0 = off, official default 40.'));
  llField(ezT('Min P min_p'), 'min_p', _LL_DEFAULTS.min_p, ezT('Keep a candidate only if its probability ≥ max probability × min_p, official default 0.05.'));
  llField(ezT('Typical sampling typical_p'), 'typical_p', _LL_DEFAULTS.typical_p, ezT('Locally typical sampling: 1.0 = off (default), around 0.9 makes word choice more "typical".'));
  llField(ezT('Repetition penalty repeat_penalty'), 'repeat_penalty', _LL_DEFAULTS.repeat_penalty, ezT('>1 suppresses repetition, official default 1.1; 1.0 = off.'));
  llField(ezT('Penalty lookback penalty_last_n'), 'penalty_last_n', _LL_DEFAULTS.penalty_last_n, ezT('How many tokens back the repetition/presence/frequency penalties look: 64 is common;\n0 = disable penalties, -1 = the whole context.'));
  llField(ezT('Presence penalty presence_penalty'), 'presence_penalty', _LL_DEFAULTS.presence_penalty, ezT('Once a word has appeared its probability stays lowered (encourages new topics); 0 = off.'));
  llField(ezT('Frequency penalty frequency_penalty'), 'frequency_penalty', _LL_DEFAULTS.frequency_penalty, ezT('Lowers probability in proportion to occurrence count (gentler than presence penalty); 0 = off.'));
  llField(ezT('Seed'), 'seed', _LL_DEFAULTS.seed, ezT('0 or -1 = random each time; any other value = fixed result (reproducible).'));
  const llStop = llField('stop', 'stop', _LL_DEFAULTS.stop, ezT('Stop words: generation stops at these strings. Separate multiple with commas; blank = none.')); llStop.placeholder = ezT('Separate multiple with commas');
  pane.appendChild(grid3);

  // ----  路径设置 ----
  const grid4 = el('div', 'eph-settings-grid');
  grid4._paths = { clipRoot: clipRootIn, llmModelRoot: llmModelRootIn, mmprojRoot: mmprojRootIn };
  grid4.appendChild(mkPathRow(ezT('clip model path'), clipRootIn));
  grid4.appendChild(mkPathRow(ezT('LLM text encoder model path'), llmModelRootIn));
  grid4.appendChild(mkPathRow(ezT('mmproj vision encoder model path'), mmprojRootIn));
  pane.appendChild(grid4);

  const navItems = [['general', ezT('Call settings'), grid0], ['rules', ezT('Rule settings'), grid1r], ['api', ezT('API settings'), grid1], ['textgen', ezT('TextGenerate settings'), grid2], ['llama', ezT('llama settings'), grid3], ['paths', ezT('Path settings'), grid4]];
  const showGrid = (g) => { pane.querySelectorAll('.eph-settings-grid').forEach((x) => { x.style.display = 'none'; }); g.style.display = 'grid'; };
  const navBtns = navItems.map(([key, label, g], i) => {
    const b = el('button', 'eph-settings-nav-btn'); b.textContent = label; if (i === 0) b.classList.add('active');
    b.addEventListener('click', () => { navBtns.forEach((x) => x.classList.remove('active')); b.classList.add('active'); showGrid(g); });
    nav.appendChild(b); return b;
  });
  showGrid(grid0);

  const ft = el('div', 'eph-settings-ft');
  const resetBtn = el('button', 'eph-btn eph-btn-cancel'); resetBtn.textContent = ezT('Restore default');
  const cancelBtn = el('button', 'eph-btn eph-btn-cancel'); cancelBtn.textContent = ezT('Cancel');
  const saveBtn = el('button', 'eph-btn eph-btn-save'); saveBtn.textContent = ezT('Save');
  ft.appendChild(resetBtn); ft.appendChild(cancelBtn); ft.appendChild(saveBtn);
  box.appendChild(hd); box.appendChild(body); box.appendChild(ft);
  _settingsModal.appendChild(box); document.body.appendChild(_settingsModal);

  close.addEventListener('click', () => _settingsModal.classList.remove('active'));
  cancelBtn.addEventListener('click', () => _settingsModal.classList.remove('active'));
  saveBtn.addEventListener('click', saveSettings);
  resetBtn.addEventListener('click', () => { resetSettings(); });
  _settingsModal._box = box; _settingsModal._provSel = provDD; _settingsModal._modelIn = modelDD; _settingsModal._apiUrlIn = apiUrlIn; _settingsModal._apiKeyIn = apiKeyIn; _settingsModal._proxyIn = proxyIn; _settingsModal._cNameIn = cNameIn; _settingsModal._cProviderIn = cProviderIn; _settingsModal._cModelIn = cModelIn; _settingsModal._cUrlIn = cUrlIn; _settingsModal._cKeyIn = cKeyIn; _settingsModal._cProxyIn = cProxyIn; _settingsModal._setModels = setModels; _settingsModal._defaultWrap = defaultWrap; _settingsModal._customWrap = customWrap; _settingsModal._customDD = customDD; _settingsModal._setMode = setMode; _settingsModal._getMode = () => _curMode; _settingsModal._loadCustom = loadCustom; _settingsModal._renderCustomDD = renderCustomDD; _settingsModal._applyCustomFields = applyCustomFields; _settingsModal._clearCustomFields = clearCustomFields; _settingsModal._setCustomSelected = (p) => { _customSelected = p; }; _settingsModal._getCustomSelected = () => _customSelected; _settingsModal._getCustomProviders = () => _customProviders; _settingsModal._saveAsCustomBtn = btnSaveAsCustom; _settingsModal._saveEditBtn = btnSaveEdit; _settingsModal._deleteCustomBtn = btnDeleteCustom; _settingsModal._newCustomBtn = btnNewCustom;
  _settingsModal._grid2 = grid2; _settingsModal._grid3 = grid3; _settingsModal._grid0 = grid0; _settingsModal._grid4 = grid4; _settingsModal._grid1r = grid1r; _settingsModal._grid1 = grid1;
  return _settingsModal;
}
function fld2(grid, labelText, input, tipText) { const l = el('label'); const sp = el('span'); sp.textContent = labelText; l.appendChild(sp); l.appendChild(input); grid.appendChild(l); return setTip(l, tipText); }
function secTitle(grid, text) { const d = el('div', 'eph-set-sec'); d.textContent = text; grid.appendChild(d); }
async function openSettings(node) {
  if (!node) return;
  _settingsNode = node;
  const o = optimizeFor(node);
  const m = settingsEl();
  // 通用设置（第  1 排）
  ['autoTextgen', 'autoApi', 'autoLlama', 'clearCache'].forEach((k) => { const cb = m._grid0 && m._grid0._auto && m._grid0._auto[k]; if (cb) { cb.checked = !!o[k]; cb._upd && cb._upd(); } });
  // 规则设置：卡片合并分隔符 + 提示词规范表
  const rules = phRulesModel(node);
  const gr = m._grid1r;
  gr._sep.value = (rules.mergeSep === undefined || rules.mergeSep === null || rules.mergeSep === '') ? '\\n' : String(rules.mergeSep);
  gr._fill(rules.ruleId, rules.custom, rules.overrides, rules.lang);
  m._apiUrlIn.value = o.apiUrl || ''; m._apiKeyIn.value = o.apiKey || ''; m._proxyIn.value = o.proxy || '';
  if (m._grid1 && m._grid1._ap) {
    const g = m._grid1._ap;
    const ap = Object.assign({}, _API_PARAMS_DEFAULTS, (o.apiParams && typeof o.apiParams === 'object') ? o.apiParams : {});
    const fillAp = (inp, v) => { inp.value = (v === '' || v === null || v === undefined) ? '' : String(v); };
    fillAp(g.temperature, ap.temperature); fillAp(g.top_p, ap.top_p); fillAp(g.max_tokens, ap.max_tokens); fillAp(g.seed, ap.seed);
    g.stop.value = ap.stop || '';
    g.reasoning.value = ap.reasoning || 'off';
    g.custom.value = (ap.custom && typeof ap.custom === 'object' && Object.keys(ap.custom).length) ? JSON.stringify(ap.custom, null, 2) : '';
    g.webSearch.checked = !!ap.webSearch; g.webSearch._upd && g.webSearch._upd();
  }
  // 模式：默认/自定义（滑到哪个用哪个，滑块状态存节点 config 不随重开/重启变）
  const customMode = !!o.customMode;
  m._setMode(customMode ? 'custom' : 'default');
  if (customMode) {
    await m._loadCustom();
    const presets = m._getCustomProviders();
    const want = o.customPreset || o.provider;
    let sel = null;
    if (presets.length) sel = presets.find((p) => p.name === want) || presets.find((p) => p.provider === o.provider) || presets[0];
    m._setCustomSelected(sel);
    if (sel) { m._applyCustomFields(sel); m._customDD.value = sel.name; } else { m._clearCustomFields(); m._customDD.value = ''; }
  } else {
    m._provSel.value = _SET_PROVIDERS.some((p) => p.value === (o.provider || '')) ? o.provider : 'OpenAI';
    m._modelIn.value = o.model || '';
    m._setModels();
  }
  // 第 2 排 TextGenerate
  const tg = Object.assign({}, _TG_DEFAULTS, o.textgen || {});
  Object.keys(_TG_DEFAULTS).forEach((k) => { const inp = m._grid2._tg && m._grid2._tg[k]; if (!inp) return; if (inp.type === 'checkbox') { inp.checked = !!tg[k]; inp._upd && inp._upd(); } else inp.value = String(tg[k]); });
  // 第 3 排 llama
  const ll = Object.assign({}, _LL_DEFAULTS, o.llama || {});
  Object.keys(_LL_DEFAULTS).forEach((k) => { const inp = m._grid3._ll && m._grid3._ll[k]; if (!inp) return; if (inp.type === 'checkbox') { inp.checked = !!ll[k]; inp._upd && inp._upd(); } else inp.value = String(ll[k]); });
  //  路径设置：未设自定义路径时，优先用全局保存的扫描路径（删除节点/重启不丢），否则显示默认扫描根
    try {
    const [rg, rr] = await Promise.all([fetchApi('/prompt_helper/scan_paths'), fetchApi('/prompt_helper/scan_roots')]);
    const gd = await rg.json().catch(() => ({}));
    const rd = await rr.json().catch(() => ({}));
    const paths = m._grid4 && m._grid4._paths;
    const fill = (inp, defArr, gkey) => {
      if (!inp || inp.value.trim()) return;
      const g = (gd[gkey] || '').trim();
      if (g) inp.value = g;
      else if (Array.isArray(defArr) && defArr.length) inp.value = defArr[0];
    };
    if (paths) { fill(paths.clipRoot, rd.clip, 'clip_root'); fill(paths.llmModelRoot, rd.model, 'model_root'); fill(paths.mmprojRoot, rd.mmproj, 'mmproj_root'); }
  } catch (_) {}
  // 模型选择：未设时，用全局保存的 clip/LLM/mmproj 模型（删除节点/重启不丢）
    try {
    const rp = await fetchApi('/prompt_helper/model_paths');
    const pd = await rp.json().catch(() => ({}));
    const fillM = (inp, key) => { const v = (pd[key] || '').trim(); if (inp && !inp.value.trim() && v) inp.value = v; };
    fillM(m._grid2._tg && m._grid2._tg.clip_path, 'clip_path');
    fillM(m._grid3._ll && m._grid3._ll.model, 'model');
    fillM(m._grid3._ll && m._grid3._ll.mmproj, 'mmproj');
  } catch (_) {}
  m.classList.add('active');
}
function saveSettings() {
  if (!_settingsNode) return;
  const m = _settingsModal; if (!m) return;
  const st = stateFor(_settingsNode);
  const prev = st.optimize || {};
  const customMode = (m._getMode && m._getMode()) === 'custom';
  const sel = (customMode && m._getCustomSelected) ? m._getCustomSelected() : null;
  const tg = {};
  Object.keys(_TG_DEFAULTS).forEach((k) => { const inp = m._grid2._tg && m._grid2._tg[k]; if (!inp) return; tg[k] = inp.type === 'checkbox' ? inp.checked : (inp.type === 'number' ? parseFloat(inp.value) : inp.value); });
  const ll = {};
  Object.keys(_LL_DEFAULTS).forEach((k) => { const inp = m._grid3._ll && m._grid3._ll[k]; if (!inp) return; ll[k] = inp.type === 'checkbox' ? inp.checked : (inp.type === 'number' ? (inp.value === '' ? _LL_DEFAULTS[k] : parseFloat(inp.value)) : inp.value); });
  const provider = customMode  ?  (m._cProviderIn.value.trim() || (sel  ?  (sel.provider || sel.name) : '自定义')) : m._provSel.value;
  const model = customMode ? m._cModelIn.value.trim() : m._modelIn.value.trim();
  const apiUrl = customMode ? m._cUrlIn.value.trim() : m._apiUrlIn.value.trim();
  const apiKey = customMode ? m._cKeyIn.value.trim() : m._apiKeyIn.value.trim();
  const proxy = customMode ? m._cProxyIn.value.trim() : m._proxyIn.value.trim();
  const g1ap = m._grid1 && m._grid1._ap;
  const apNum = (inp) => { const v = inp ? String(inp.value).trim() : ''; if (v === '') return ''; const n = parseFloat(v); return isFinite(n) ? n : ''; };
  let apCustom = {};
  if (g1ap) {
    const raw = String(g1ap.custom.value || '').trim();
    if (raw) {
      try {
        apCustom = JSON.parse(raw);
        if (!apCustom || typeof apCustom !== 'object' || Array.isArray(apCustom)) throw new Error(ezT('must be a JSON object'));
      } catch (err) { phTip(ezT('"Custom parameters" is not a valid JSON object: ') + (err && err.message ? err.message : err)); return; }
    }
  }
  const apiParams = g1ap ? {
    temperature: apNum(g1ap.temperature),
    top_p: apNum(g1ap.top_p),
    max_tokens: apNum(g1ap.max_tokens),
    seed: apNum(g1ap.seed),
    stop: g1ap.stop.value.trim(),
    reasoning: g1ap.reasoning.value || 'off',
    webSearch: !!(g1ap.webSearch && g1ap.webSearch.checked),
    custom: apCustom,
  } : (prev.apiParams || {});
  st.optimize = Object.assign({}, prev, {
    autoTextgen: !!(m._grid0._auto && m._grid0._auto.autoTextgen && m._grid0._auto.autoTextgen.checked),
    autoApi: !!(m._grid0._auto && m._grid0._auto.autoApi && m._grid0._auto.autoApi.checked),
    autoLlama: !!(m._grid0._auto && m._grid0._auto.autoLlama && m._grid0._auto.autoLlama.checked),
    clearCache: !!(m._grid0._auto && m._grid0._auto.clearCache && m._grid0._auto.clearCache.checked),
    customMode,
    customPreset: customMode ? (sel ? sel.name : '') : '',
    provider,
    model,
    apiUrl,
    apiKey,
    proxy,
    textgen: tg,
    llama: ll,
    apiParams,
  });
  st.rules = {
    mergeSep: m._grid1r._sep.value,
    ruleId: m._grid1r._getRuleId(),
    custom: m._grid1r._getCustom(),
    overrides: m._grid1r._getOverrides(),
    lang: m._grid1r._getLang(),
  };
  syncToConfig(_settingsNode);
  syncRuleUI(_settingsNode, st.rules.ruleId);   // 卡片弹窗 / 总体编辑的规范下拉跟着一致
  //  扫描路径  + 选中的模型 持久化到全局 userdata（删除节点/重启不丢失）
  try {
    const clip_root = (m._grid2._tg && m._grid2._tg.clip_root && m._grid2._tg.clip_root.value) || '';
    const model_root = (m._grid3._ll && m._grid3._ll.model_root && m._grid3._ll.model_root.value) || '';
    const mmproj_root = (m._grid3._ll && m._grid3._ll.mmproj_root && m._grid3._ll.mmproj_root.value) || '';
    fetchApi('/prompt_helper/scan_paths', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clip_root, model_root, mmproj_root }) }).catch(() => {});
    const clip_path = (m._grid2._tg && m._grid2._tg.clip_path && m._grid2._tg.clip_path.value) || '';
    const model = (m._grid3._ll && m._grid3._ll.model && m._grid3._ll.model.value) || '';
    const mmproj = (m._grid3._ll && m._grid3._ll.mmproj && m._grid3._ll.mmproj.value) || '';
    fetchApi('/prompt_helper/model_paths', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clip_path, model, mmproj }) }).catch(() => {});
  } catch (_) {}
  // 安全：把自定义 API / llama 服务器主机登记进服务端「出站允许列表」（只有列表里的主机允许被调用）
  try {
    const urls = [apiUrl, (ll && ll.server) || '', proxy].filter(Boolean);   // 代理也要登记，否则出站代理会被允许列表拦下
    if (urls.length) fetchApi('/prompt_helper/api_hosts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls }) }).catch(() => {});
  } catch (_) {}
  m.classList.remove('active');
}
async function resetSettings() {
  const m = _settingsModal; if (!m) return;
  if (!(await uiConfirm(ezT('Restore default settings?')))) return;
  m._modelIn.value = ''; m._apiUrlIn.value = ''; m._apiKeyIn.value = ''; m._proxyIn.value = '';
  m._cNameIn.value = ''; m._cProviderIn.value = ''; m._cModelIn.value = ''; m._cUrlIn.value = ''; m._cKeyIn.value = ''; m._cProxyIn.value = '';
  ['autoTextgen', 'autoApi', 'autoLlama', 'clearCache'].forEach((k) => { const cb = m._grid0 && m._grid0._auto && m._grid0._auto[k]; if (cb) { cb.checked = false; cb._upd && cb._upd(); } });
  m._setMode('default');
  Object.keys(_TG_DEFAULTS).forEach((k) => { const inp = m._grid2._tg && m._grid2._tg[k]; if (!inp) return; if (inp.type === 'checkbox') { inp.checked = !!_TG_DEFAULTS[k]; inp._upd && inp._upd(); } else inp.value = String(_TG_DEFAULTS[k]); });
  Object.keys(_LL_DEFAULTS).forEach((k) => { const inp = m._grid3._ll && m._grid3._ll[k]; if (!inp) return; inp.value = String(_LL_DEFAULTS[k]); });
  if (m._grid1 && m._grid1._ap) { const g = m._grid1._ap; const d = _API_PARAMS_DEFAULTS; g.temperature.value = String(d.temperature); g.top_p.value = d.top_p; g.max_tokens.value = d.max_tokens; g.seed.value = d.seed; g.stop.value = d.stop; g.reasoning.value = d.reasoning; g.custom.value = ''; g.webSearch.checked = d.webSearch; g.webSearch._upd && g.webSearch._upd(); }
  m._provSel.value = 'OpenAI'; m._setModels();
  m._setCustomSelected(null); if (m._clearCustomFields) m._clearCustomFields(); if (m._customDD) m._customDD.value = ''; if (m._renderCustomDD) m._renderCustomDD();
  if (m._grid1r) { m._grid1r._sep.value = '\\n'; m._grid1r._reset(); }
}

// ===== 卡片管理：把提示词卡片存成 userdata/prompts 下的一份 JSON，按名称加载 / 删除 =====
const CARDS_API = '/prompt_helper/prompt_cards';
let _cardMgr = null;
let _cmSaved = [];        // 已保存卡片清单 [{name,count}]（下拉框数据源）
let _cmSel = new Set();   // 下面点成绿色的卡片 id（Ctrl / Shift 多选，同 Windows 文件操作）
let _cmAnchor = -1;       // Shift 连选的锚点（上次点击的下标）
let _cmName = '';         // 下拉框选中的已保存卡片名（'' = 没选中）
let _cmSig = '';          // 选中/保存那一刻的卡片签名：之后再编辑内容 → 选中的已经不是那张卡片

function cmHint(text, kind) {
  const h = _cardMgr && _cardMgr._hint;
  if (!h) return;
  h.textContent = text || '';
  h.className = 'eph-cm-hint' + (kind ? ' ' + kind : '');
}
// 卡片签名（标题/正文/时间轴/引用目标全在内）：用来判断「选中的那份卡片」有没有被编辑过
function cmSig(node) {
  try { return JSON.stringify(stateFor(node).cards); } catch (_) { return ''; }
}
// 要保存的卡片：下面点了绿的就存这些，一个都没点 = 整份保存
function cmCardsToSave(node) {
  const st = stateFor(node);
  return _cmSel.size ? st.cards.filter((c) => _cmSel.has(c.id)) : st.cards.slice();
}
async function cmRefreshList() {
  try { const r = await fetchApi(CARDS_API); const d = await r.json().catch(() => ({})); _cmSaved = Array.isArray(d.cards) ? d.cards : []; }
  catch (_) { _cmSaved = []; }
  const dd = _cardMgr && _cardMgr._dd;
  if (!dd) return;
  dd.setItems(_cmSaved.map((x) => ({ value: x.name, label: x.name + ezT(' (') + x.count + ezT(' cards)') })));
  if (_cmName && !_cmSaved.some((x) => x.name === _cmName)) _cmName = '';   // 被删掉/改名了：下拉框跟着清空
  dd.value = _cmName;
}
function cmRenderPick() {
  const m = _cardMgr; if (!m || !m._node) return;
  const st = stateFor(m._node);
  const pick = m._pick; pick.innerHTML = '';
  const ids = new Set(st.cards.map((c) => c.id));
  _cmSel.forEach((id) => { if (!ids.has(id)) _cmSel.delete(id); });   // 卡片增删/换过一份之后，丢掉不存在的选中项
  if (!st.cards.length) { const e = el('div', 'eph-cm-empty'); e.textContent = ezT('No prompt cards currently.'); pick.appendChild(e); return; }
  st.cards.forEach((c, i) => {
    const chip = el('button', 'eph-cm-chip' + (_cmSel.has(c.id) ? ' on' : '')); chip.type = 'button';
    const ix = el('span', 'eph-cm-idx'); ix.textContent = String(i + 1);
    chip.appendChild(ix); chip.appendChild(document.createTextNode(c.title || ezT('Prompt')));
    chip.title = (c.title || '') + ezT(': ') + String(c.content || '').slice(0, 90);
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', (e) => cmPickCard(c.id, i, e));
    pick.appendChild(chip);
  });
}
function cmPickCard(id, idx, e) {
  const st = stateFor(_cardMgr._node);
  if (e.shiftKey && _cmAnchor >= 0) {
    const [a, b] = _cmAnchor < idx ? [_cmAnchor, idx] : [idx, _cmAnchor];
    if (!(e.ctrlKey || e.metaKey)) _cmSel.clear();
    for (let i = a; i <= b; i++) { if (st.cards[i]) _cmSel.add(st.cards[i].id); }
  } else if (e.ctrlKey || e.metaKey) {
    if (_cmSel.has(id)) _cmSel.delete(id); else _cmSel.add(id);
    _cmAnchor = idx;
  } else if (_cmSel.has(id)) {
    _cmSel.clear(); _cmAnchor = idx;   // 再点一次变灰（取消选中）
  } else {
    _cmSel.clear(); _cmSel.add(id); _cmAnchor = idx;
  }
  cmRenderPick();
}
async function cmSave() {
  const m = _cardMgr; if (!m || !m._node) return false;
  const st = stateFor(m._node);
  const name = m._nameIn.value.trim();
  if (!name) { cmHint(ezT('Enter a save name first.'), 'err'); return false; }
  if (!st.cards.length) { cmHint(ezT('No prompt cards to save.'), 'err'); return false; }
  const cards = cmCardsToSave(m._node);
  if (_cmSaved.some((x) => x.name === name) && !(await uiConfirm(ezT('A card named "') + name + ezT('" already exists. Overwrite?')))) { cmHint(ezT('Save cancelled.')); return false; }
  try {
    const r = await fetchApi(CARDS_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, cards: cards }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) { cmHint(ezT('Save failed: ') + (d.error || ('HTTP ' + r.status)), 'err'); return false; }
    _cmName = ''; _cmSig = '';   // 保存后下拉框保持未选中：再点开列表选这份预设才能真正加载
    await cmRefreshList();
    cmHint(ezT('Saved "') + name + ezT('" (') + cards.length + ezT(' cards) → userdata/prompts/') + name + '.json', 'ok');
    return true;
  } catch (e) { cmHint(ezT('Save failed: ') + (e && e.message ? e.message : e), 'err'); return false; }
}
async function cmLoad(name) {
  const m = _cardMgr; if (!m || !m._node || !name) return;
  try {
    const r = await fetchApi(CARDS_API + '?name=' + encodeURIComponent(name));
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) { cmHint(ezT('Load failed: ') + (d.error || ('HTTP ' + r.status)), 'err'); return; }
    const st = stateFor(m._node);
    // 逐张补默认字段并重新给 id（同一份卡片可以在不同节点上加载，id 不跨节点复用）
    st.cards = (Array.isArray(d.cards) ? d.cards : []).map((c) => Object.assign({
      title: ezT('Prompt'), content: '', contentHTML: '', contentOptimized: '', contentOptimizedHTML: '',
      timelineStart: '', timelineEnd: '', modelType: 'text', model: '', provider: '', apiUrl: '', indent: 0, useOptimized: false,
    }, c, { id: genId() }));
    st.editingId = null;
    _cmSel.clear(); _cmAnchor = -1;
    syncToConfig(m._node); updatePorts(m._node); refreshUI(m._node);
    _cmName = name; _cmSig = cmSig(m._node);
    if (m._dd) m._dd.value = name;
    cmRenderPick();
  } catch (e) { cmHint(ezT('Load failed: ') + (e && e.message ? e.message : e), 'err'); }
}
async function cmDelete() {
  const m = _cardMgr; if (!m || !m._node) return;
  if (!_cmName) { cmHint(ezT('Select the card to delete in the dropdown above first.'), 'err'); return; }
  if (cmSig(m._node) !== _cmSig) {
    cmHint(ezT('The card was edited after selection, so the current content is no longer "') + _cmName + ezT('"; select it again in the dropdown to delete.'), 'err');
    return;
  }
  if (!(await uiConfirm(ezT('Delete the saved card "') + _cmName + ezT('"? (file under userdata/prompts)')))) return;
  try {
    const r = await fetchApi(CARDS_API + '?name=' + encodeURIComponent(_cmName), { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) { cmHint(ezT('Delete failed: ') + (d.error || ('HTTP ' + r.status)), 'err'); return; }
    const gone = _cmName; _cmName = '';
    await cmRefreshList();
    cmHint(ezT('Deleted "') + gone + ezT('".'), 'ok');
  } catch (e) { cmHint(ezT('Delete failed: ') + (e && e.message ? e.message : e), 'err'); }
}
function cardMgrEl() {
  if (_cardMgr && _cardMgr.parentNode) return _cardMgr;
  _cardMgr = el('div', 'eph-cm');
  const box = el('div', 'eph-cm-box');
  const hd = el('div', 'eph-cm-hd');
  const t = el('b'); t.textContent = ezT('Card manager');
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  hd.appendChild(t); hd.appendChild(close);
  const body = el('div', 'eph-cm-body');

  const row = el('div', 'eph-cm-row');
  const nameIn = el('input'); nameIn.placeholder = ezT('Save name (e.g. storyboard-night)'); nameIn.title = ezT('Saved to userdata/prompts/<name>.json');
  const saveBtn = el('button', 'eph-btn'); saveBtn.textContent = ezT('Save cards');
  const dd = makeDropdown([]);
  const delBtn = el('button', 'eph-btn danger'); delBtn.textContent = ezT('Delete cards');
  row.appendChild(nameIn); row.appendChild(saveBtn); row.appendChild(dd.el); row.appendChild(delBtn);
  body.appendChild(row);
  const pick = el('div', 'eph-cm-pick');
  body.appendChild(pick);
  const hint = el('div', 'eph-cm-hint');
  body.appendChild(hint);

  box.appendChild(hd); box.appendChild(body);
  _cardMgr.appendChild(box); document.body.appendChild(_cardMgr);
  _cardMgr._dd = dd; _cardMgr._nameIn = nameIn; _cardMgr._pick = pick; _cardMgr._hint = hint;
  close.addEventListener('click', () => _cardMgr.classList.remove('active'));
  // 点外侧关闭，但「从弹窗内部拖到外面松开」不关闭（同卡片编辑弹窗）：比对按下时的落点
  let _cmDownInBox = false;
  _cardMgr.addEventListener('mousedown', (e) => { _cmDownInBox = box.contains(e.target); });
  _cardMgr.addEventListener('mouseup', (e) => {
    if (e.target === _cardMgr && !_cmDownInBox && (_phClosedEl === null || _phClosedEl === _cardMgr)) _cardMgr.classList.remove('active');
    _cmDownInBox = false;
  });
  saveBtn.addEventListener('click', () => { cmSave(); });
  delBtn.addEventListener('click', () => { cmDelete(); });
  dd.addEventListener('change', (v) => { cmLoad(v); });
  // 下拉框绑定刷新列表：每次点开都重拉一遍（别处删了/加了文件也能看到）
  const ddTrig = dd.el.querySelector('.eph-dd-trigger');
  if (ddTrig) ddTrig.addEventListener('mousedown', () => { cmRefreshList(); });
  return _cardMgr;
}
async function openCardMgr(node) {
  if (!node) return;
  const m = cardMgrEl();
  m._node = node;
  _cmSel.clear(); _cmAnchor = -1;
  _cmName = ''; _cmSig = '';                             // 每次打开都从「没选中」开始：加载过的内容和要保存的不要混在一起
  if (m._nameIn) m._nameIn.value = '';
  cmHint('');
  cmRenderPick();
  await cmRefreshList();
  m.classList.add('active');
}

// ===== 总体编辑（Word 大纲：每条卡片=  左侧小标题行[序号/标题/时间轴/删除] + 下方内容；默认/优化滑块 + 工具栏（含 skill 插入）；点外面自动保存关闭）=====
let _allModal = null, _allTab = 'default';
function runToolOn(ed, id) {
  if (!ed) return;
  const mapFH = { '，': ',', '。': '.', '！': '!', '？': ',', '：': ':', '；': ';', '“': '"', '”': '"', '‘': "'", '’': "'", '（': '(', '）': ')', '【': '[', '】': ']', '《': '<', '》': '>', '、': ',', '—': '-', '～': '~' };
  const mapHF = { ',': '，', '.': '。', '!': '！', '?': '？', ':': '：', ';': '；', '"': '“', "'": '‘', '(': '（', ')': '）', '[': '【', ']': '】', '<': '《', '>': '》', '~': '～', '-': '—' };
  const convert = (s) => id === 'fullToHalf'  ?  s.replace(/[，。！？：；“”‘’（）【】《》、—～]/g, (ch) => mapFH[ch] || ch).replace(/\u3000/g, ' ') : s.replace(/[,\.!\?:;"'\(\)\[\]<>~-]/g, (ch) => mapHF[ch] || ch);
  const bodies = ed.querySelectorAll('.eph-all-block-body');
  (bodies.length ? Array.from(bodies) : [ed]).forEach((b) => { b.textContent = convert(b.textContent); });
}
function execCommandOn(ed, cmd) {
  if (!ed) return;
  ed.focus();
  document.execCommand(cmd, false, null);
}
//  用 span 包装某块内容并写样式（避免 execCommand 在多块编辑器中失效；span 落在 innerHTML 里可随保存持久化）。
function _wrapStyle(body, cssProp, val, key) {
  if (!body) return;
  let sp = null;
  if (body.childNodes) { for (let i = 0; i < body.childNodes.length; i++) { const cn = body.childNodes[i]; if (cn.nodeType === 1 && cn.dataset && cn.dataset.wr === key) { sp = cn; break; } } }
  if (!sp) {
    sp = document.createElement('span'); sp.setAttribute('data-wr', key);
    while (body.firstChild) sp.appendChild(body.firstChild);
    body.appendChild(sp);
  }
  sp.style[cssProp] = val;
}
function applyFontSizeOn(ed, val) {
  if (!ed) return;
  const bodies = ed.querySelectorAll('.eph-all-block-body');
  if (bodies.length) { bodies.forEach((b) => _wrapStyle(b, 'fontSize', val, 'fs')); ed.focus(); return; }
  ed.focus(); const sel = window.getSelection();
  if (sel.isCollapsed) { const r = document.createRange(); r.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(r); }
  document.execCommand('fontSize', false, '7'); document.execCommand('fontName', false, '');
  ed.querySelectorAll('font[size="7"]').forEach((f) => { const s = document.createElement('span'); s.style.fontSize = val; s.innerHTML = f.innerHTML; f.replaceWith(s); });
}
function allEl() {
  if (_allModal && _allModal.parentNode) return _allModal;
  _allModal = el('div', 'eph-all');
  const box = el('div', 'eph-all-box');
  const hd = el('div', 'eph-all-hd');
  const t = el('b'); t.textContent = ezT('Overall edit');
  // 全屏 / 退出全屏放在右上角（和关闭按钮同一排）
  const fullBtn = el('button', 'eph-btn eph-all-full'); fullBtn.textContent = ezT('Fullscreen'); fullBtn.title = ezT('Overall edit fullscreen / exit fullscreen');
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  const hdRight = el('div', 'eph-all-hd-right');
  hdRight.appendChild(fullBtn); hdRight.appendChild(close);
  hd.appendChild(t); hd.appendChild(hdRight);
  fullBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = _allModal; if (!m) return;
    m.classList.toggle('full');
    fullBtn.textContent = m.classList.contains('full') ? ezT('Exit fullscreen') : ezT('Fullscreen');
    requestAnimationFrame(() => { try { moveAllTabThumb(); } catch (_) {} });   // 全屏切换后滑块宽度会滞留，重新量一次
  });
  // 默认/优化滑块
  const tabThumb = el('span', 'eph-tabs-thumb');
  const tabs = el('div', 'eph-tabs');
  const tabDefault = el('button', 'eph-tab active'); tabDefault.textContent = ezT('Default prompt');
  const tabOptimized = el('button', 'eph-tab'); tabOptimized.textContent = ezT('Optimized prompt');
  tabs.appendChild(tabThumb); tabs.appendChild(tabDefault); tabs.appendChild(tabOptimized);
  // 工具栏（与卡片一致）
  const toolbar = el('div', 'eph-all-toolbar');
  const TB = (cls, cmd, inner) => { const b = el('button', 'eph-tb-btn ' + cls); b.title = cmd; b.dataset.cmd = cmd; b.innerHTML = inner; toolbar.appendChild(b); return b; };
  TB('word-glyph bold-glyph', 'bold', '<span>B</span>');
  TB('word-glyph italic-glyph', 'italic', '<span>I</span>');
  TB('word-glyph underline-glyph', 'underline', '<span>U</span>');
  TB('word-glyph strike-glyph', 'strikeThrough', '<span>S</span>');
  TB('', 'justifyLeft', alignSVG('left'));
  TB('', 'justifyCenter', alignSVG('center'));
  TB('', 'justifyRight', alignSVG('right'));
  TB('', 'justifyFull', alignSVG('justify'));
  // 字号下拉（放在 position:relative 的组里，下拉随按钮定位）
  const fontGroup = el('div', 'eph-tb-group');
  const fontCombo = el('div', 'eph-font-combo');
  const fontIn = el('input'); fontIn.value = '16';
  const fontBtn = el('button');
  const fontList = el('ul', 'eph-font-list'); populateFontList(fontList);
  fontCombo.appendChild(fontIn); fontCombo.appendChild(fontBtn);
  fontGroup.appendChild(fontCombo); fontGroup.appendChild(fontList);
  toolbar.appendChild(fontGroup);
  fontBtn.addEventListener('click', (e) => { e.stopPropagation(); fontList.classList.toggle('active'); if (fontList.classList.contains('active')) { phFixedDD(fontBtn, fontList); phLayerPush(fontList); } });
  fontIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { applyFontSizeOn(editor, fontIn.value); } });
  fontList.addEventListener('click', (e) => { if (e.target.tagName === 'LI') { applyFontSizeOn(editor, e.target.dataset.value); fontIn.value = e.target.textContent; fontList.classList.remove('active'); } });
  const indentL = el('label'); indentL.textContent = ezT('Indent');
  const indentIn = el('input', 'eph-indent-input'); indentIn.value = '0'; indentIn.title = ezT('First-line indent');
  indentL.appendChild(indentIn); toolbar.appendChild(indentL);
  // 颜色（与卡片一致：色块下拉）
    const colorGroup = el('div', 'eph-tb-group');
  const hlBtn = el('button', 'eph-color-btn'); hlBtn.innerHTML = '<span class="eph-icon-hl"></span><span class="eph-arrow-down"></span>';
  const hlDD = el('div', 'eph-color-dropdown');
  const fcBtn = el('button', 'eph-color-btn'); fcBtn.innerHTML = '<span class="eph-icon-a">A</span><span class="eph-arrow-down"></span>';
  const fcDD = el('div', 'eph-color-dropdown');
  colorGroup.appendChild(hlBtn); colorGroup.appendChild(hlDD); colorGroup.appendChild(fcBtn); colorGroup.appendChild(fcDD);
  toolbar.appendChild(colorGroup);
  initColorDropdown(hlDD, 'highlight');
  initColorDropdown(fcDD, 'font');
  hlBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); hlDD.classList.toggle('active'); fcDD.classList.remove('active'); if (hlDD.classList.contains('active')) phCenterPopup(hlDD); });
  fcBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); fcDD.classList.toggle('active'); hlDD.classList.remove('active'); if (fcDD.classList.contains('active')) phCenterPopup(fcDD); });
  // 工具（引用媒体改成每张卡片自己一个按钮，见 renderAllEditor）
  const toolsGroup = el('div', 'eph-tb-group');
  const toolsBtn = el('button', 'eph-btn'); toolsBtn.textContent = ezT('Tools');
  const toolsDD = el('div', 'eph-tools-dropdown');
  toolsGroup.appendChild(toolsBtn); toolsGroup.appendChild(toolsDD); toolbar.appendChild(toolsGroup);
  const collapseBtn = el('button', 'eph-btn'); collapseBtn.textContent = ezT('Collapse headers'); collapseBtn.title = ezT('Collapse/expand each card header row');
  collapseBtn.addEventListener('click', (e) => { e.stopPropagation(); const m = _allModal; if (m) { m.classList.toggle('collapsed'); collapseBtn.textContent = m.classList.contains('collapsed')  ?  ezT('Expand headers')  : ezT('Collapse headers'); markBlankLines(m); } });
  toolbar.appendChild(collapseBtn);
  const addCardBtn = el('button', 'eph-btn success'); addCardBtn.textContent = ezT('+ Add card'); toolbar.appendChild(addCardBtn);
  const editor = el('div', 'eph-all-editor'); editor.contentEditable = 'true';
  attachMention(editor, () => ({ node: _allModal._node, card: caretCard(_allModal._node) }));
  toolbar.insertBefore(skillButton(editor), collapseBtn);
  const tbToggle = toolbarToggleRow(() => _allModal && _allModal._node, 'allToolbar');
  _allModal._toolbarToggle = tbToggle;
  // 卡片正文之间隔着不可编辑的小标题行：在块首退格 / 块尾删除时，浏览器会拿这些不可编辑元素和正文包
  // 开刀（删掉 .eph-all-block-body 甚至小标题行），结构一坏「引用媒体」取不到正文、输入也失效。
  // 这里拦住跨块删除（把光标挪到相邻卡片正文），并在结构已经坏了时就地重建一次。
  editor.addEventListener('keydown', (e) => {
    const nd = _allModal && _allModal._node; if (!nd) return;
    healAllEditor(nd);   // 结构已经被删坏就地重建（内部节流）；重建后下面的守卫按新 DOM 再判一次
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    const r = sel.getRangeAt(0);
    const startEl = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode;
    const body = (startEl && startEl.closest) ? startEl.closest('.eph-all-block-body') : null;
    if (!body) return;
    const probe = document.createRange();
    // 「光标正好在正文的最前/最后」才算跨块删除（再删就要碰到小标题行/正文包了）；
    // 块内删空行（前面还有个空 div）不算，照常让浏览器删。
    const atBodyStart = () => {
      try { probe.setStart(body, 0); probe.setEnd(r.startContainer, r.startOffset); } catch (_) { return false; }
      return probe.collapsed || probe.cloneContents().childNodes.length === 0;
    };
    const atBodyEnd = () => {
      try { probe.setStart(r.startContainer, r.startOffset); probe.setEnd(body, body.childNodes.length); } catch (_) { return false; }
      return probe.collapsed || probe.cloneContents().childNodes.length === 0;
    };
    const moveTo = (target, atEnd) => { const rr = document.createRange(); rr.selectNodeContents(target); rr.collapse(!atEnd); sel.removeAllRanges(); sel.addRange(rr); };
    const blk = body.parentNode ? body.parentNode.closest('.eph-all-block') : null;
    if (e.key === 'Backspace' && atBodyStart()) {
      e.preventDefault();
      const prev = blk && blk.previousElementSibling;
      const pb = (prev && prev.querySelector) ? prev.querySelector('.eph-all-block-body') : null;
      if (pb) moveTo(pb, true);
    } else if (e.key === 'Delete' && atBodyEnd()) {
      e.preventDefault();
      const next = blk && blk.nextElementSibling;
      const nb = (next && next.querySelector) ? next.querySelector('.eph-all-block-body') : null;
      if (nb) moveTo(nb, false);
    }
  });
  // 兜底：不管是哪种编辑操作把块结构弄坏了，输入时立刻按卡片重建（内容已按 cardId 写回，不会丢）
  editor.addEventListener('input', () => { const nd = _allModal && _allModal._node; if (nd) healAllEditor(nd); });
  // 和卡片弹窗一样记下光标：点某张卡片的「引用媒体」时，+/− 就插在光标处（不在本卡片正文里才退回正文末尾）
  editor.addEventListener('keyup', saveSelection);
  editor.addEventListener('mouseup', saveSelection);
  const ft = el('div', 'eph-all-ft');
  // 规范「参考卡」放在保存/取消同一行（左下角）
  const ruleBar = el('div', 'eph-all-rulebar');
  const ruleDD = makeDropdown(ruleDropdownItems(_allModal && _allModal._node, false));
  ruleDD.el.classList.add('eph-rule-dd');
  const ruleHint = el('button', 'eph-rule-hint'); ruleHint.type = 'button'; ruleHint.textContent = ezT('Hint'); ruleHint.title = ezT('View writing rules / reference syntax for this spec');
  ruleDD.addEventListener('change', (v) => {
    const nd = _allModal && _allModal._node; if (!nd) return;
    setNodeRule(nd, v);
    if (_rulePop && _rulePop._anchor === ruleHint) { const p = openRulePop(ruleHint, nd, { ruleId: v }); p._anchor = ruleHint; }
  });
  ruleHint.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_rulePop && _rulePop._anchor === ruleHint) { closeRulePop(); return; }
    const nd = _allModal && _allModal._node; if (!nd) return;
    const p = openRulePop(ruleHint, nd, { ruleId: ruleDD.value }); p._anchor = ruleHint;
  });
  ruleBar.appendChild(ruleDD.el); ruleBar.appendChild(ruleHint);
  _allModal._ruleDD = ruleDD;
  const cancelBtn = el('button', 'eph-btn eph-btn-cancel'); cancelBtn.textContent = ezT('Cancel');
  const saveBtn = el('button', 'eph-btn eph-btn-save'); saveBtn.textContent = ezT('Save');
  ft.appendChild(ruleBar); ft.appendChild(cancelBtn); ft.appendChild(saveBtn);
  box.appendChild(hd); box.appendChild(tabs); box.appendChild(tbToggle); box.appendChild(toolbar); box.appendChild(editor); box.appendChild(ft);
  _allModal.appendChild(box); document.body.appendChild(_allModal);
  _allModal._box = box; _allModal._ed = editor; _allModal._indentIn = indentIn;
  _allModal._tabDefault = tabDefault; _allModal._tabOptimized = tabOptimized; _allModal._tabThumb = tabThumb;
  _allModal._hlDD = hlDD; _allModal._fcDD = fcDD; _allModal._toolsDD = toolsDD;
  close.addEventListener('click', () => { _phActiveEditor = null; _allModal.classList.remove('active'); try { phDockRemember(_allModal._node); } catch (_) {} });
  cancelBtn.addEventListener('click', () => { _phActiveEditor = null; _allModal.classList.remove('active'); try { phDockRemember(_allModal._node); } catch (_) {} });
  saveBtn.addEventListener('click', () => saveAllEditor());
  tabDefault.addEventListener('click', () => switchAllTab('default'));
  tabOptimized.addEventListener('click', () => switchAllTab('optimized'));
  toolbar.addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (b) { execCommandOn(editor, b.dataset.cmd); e.preventDefault(); } });
  indentIn.addEventListener('change', () => { editor.querySelectorAll('.eph-all-block-body').forEach((x) => { const n = parseFloat(indentIn.value) || 0; x.style.textIndent = n ? n + 'em' : ''; }); });
  addCardBtn.addEventListener('click', () => { const nd = _allModal._node; if (nd) { addCard(nd); openAllEditor(nd); } });
  // 工具 / 插入引用下拉
  [[ezT('Find & replace'), 'find'], [ezT('Full-width to half-width'), 'fullToHalf'], [ezT('Half-width to full-width'), 'halfToFull'], [ezT('Optimize prompt (API)'), 'api'], [ezT('Optimize prompt (TextGenerate)'), 'textgen'], [ezT('Optimize prompt (llama)'), 'llama']].forEach(([t, id]) => { const b = el('button', 'eph-tool-item'); b.textContent = t; b.addEventListener('click', () => { if (id === 'api' || id === 'textgen' || id === 'llama') { runBatchOptimize(_allModal && _allModal._node, id); } else if (id === 'find') { openFindModal('find', _allModal && _allModal._ed); } else { runToolOn(editor, id); } toolsDD.classList.remove('active'); }); toolsDD.appendChild(b); });
  toolsBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); toolsDD.classList.toggle('active'); if (toolsDD.classList.contains('active')) phFixedDD(toolsBtn, toolsDD); });
  // 点弹窗外空白自动保存关闭；卡片内部拖动到外面松开不关（只在外面点击才关）
  let _allStartInBox = false;
  _allModal.addEventListener('mousedown', (e) => { _allStartInBox = box.contains(e.target); });
  _allModal.addEventListener('mouseup', (e) => { if (!_allModal.classList.contains('ph-dock') && e.target === _allModal && _phDownTarget === _allModal && !_allStartInBox && (_phClosedEl === null || _phClosedEl === _allModal)) saveAllEditor(); _allStartInBox = false; });
  _allModal._phOnClose = () => { try { phDockRemember(_allModal._node); } catch (_) {} };
  return _allModal;
}
function switchAllTab(tab) {
  const m = _allModal; if (!m) return;
  const nd = m._node;
  if (nd && _allTab !== tab) syncAllContent(nd);   // 切页签前先把当前页签未保存的内容写回卡片
  _allTab = tab;
  const good = tab === 'optimized';
  m._tabOptimized.classList.toggle('active', good);
  m._tabDefault.classList.toggle('active', !good);
  const t = m.querySelector('.eph-tab.active'); const th = m._tabThumb;
  if (t && th) { th.style.left = t.offsetLeft + 'px'; th.style.width = t.offsetWidth + 'px'; }
  if (nd) {
    const st = stateFor(nd);
    // 切页签会整篇重建编辑器（光标丢），所以先记住光标在哪张卡片，重建后把光标放回那张卡片的末尾
    const idx = allCaretCardIdx();
    st.overallUseOptimized = good;   // 节点级：合并提示词用「整体优化」还是按卡片拼（卡片级 useOptimized 只在卡片弹窗里改）
    syncToConfig(nd);
    renderAllEditor(nd);
    if (st.cards.length) allCaretToBlockEnd(idx >= 0 ? idx : 0);
  }
}
// 一个块里的正文 HTML：正常是 .eph-all-block-body；结构被浏览器编辑操作吃掉时，用整块内容去掉小标题行兜底。
function blockContentHTML(b) {
  if (!b) return '';
  const body = b.querySelector('.eph-all-block-body');
  if (body) return body.innerHTML;
  const clone = b.cloneNode(true);
  const hd = clone.querySelector('.eph-all-block-hd');
  if (hd) hd.remove();
  return clone.innerHTML;
}
// 总体编辑的块结构（小标题行 + 正文）都活在 contenteditable 里：在块首退格 / 块尾删除时，
// 浏览器会把正文包 .eph-all-block-body、甚至小标题行/整块删掉，之后「引用媒体」取不到正文、
// 输入也没反应，只有重开总体编辑才恢复。这里检查结构是否还对得上卡片，坏了就按卡片就地重建。
function allStructureOk(ed, cards) {
  if (!ed) return true;
  const blocks = Array.from(ed.querySelectorAll('.eph-all-block'));
  if (_allTab === 'optimized') return blocks.length === 1 && !!blocks[0].querySelector('.eph-all-block-body');   // 优化页签只有「整体优化」一块
  if (blocks.length !== cards.length) return false;
  return blocks.every((b) => !!b.querySelector('.eph-all-block-body'))
    && cards.every((c, i) => String(blocks[i].dataset.cardId || '') === String(c.id));
}
let _healAllAt = 0;
// 光标当前在第几张卡片（总体编辑按块顺序）；光标不在任何卡片正文里时返回 -1。
function allCaretCardIdx() {
  const m = _allModal;
  if (!m || !m._ed) return -1;
  try {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const n = sel.getRangeAt(0).startContainer;
    const el0 = n && (n.nodeType === 1 ? n : n.parentNode);
    const blk = (el0 && el0.closest) ? el0.closest('.eph-all-block') : null;
    if (!blk) return -1;
    return Array.from(m._ed.querySelectorAll('.eph-all-block')).indexOf(blk);
  } catch (_) { return -1; }
}
// 把光标放到第 idx 张卡片的正文末尾（重建/换页签后调用），并把它滚进视野。
function allCaretToBlockEnd(idx) {
  const m = _allModal;
  if (!m || !m._ed || idx < 0) return;
  try {
    const blk = m._ed.querySelectorAll('.eph-all-block')[idx];
    const body = blk && blk.querySelector('.eph-all-block-body');
    if (!body) return;
    const r = document.createRange(); r.selectNodeContents(body); r.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    saveSelection();
    if (body.scrollIntoView) body.scrollIntoView({ block: 'nearest' });
  } catch (_) {}
}
function healAllEditor(node) {
  const m = _allModal;
  if (!m || !m._ed || !node) return false;
  const st = stateFor(node);
  if (allStructureOk(m._ed, st.cards)) return false;
  const now = Date.now();
  if (now - _healAllAt < 1200) return false;   // 节流：结构始终不合法时别每次按键都重建
  _healAllAt = now;
  const idx = allCaretCardIdx();             // 记住光标原来在哪张卡片，重建后放回该卡片正文末尾
  syncAllContent(node);      // 按卡片 id 写回（缺正文的块走整块兜底），不丢已输入内容
  renderAllEditor(node);
  allCaretToBlockEnd(idx >= 0 ? idx : 0);
  return true;
}
function syncAllContent(nd) {
  const st = stateFor(nd);
  if (_allTab === 'optimized') {
    const b = _allModal._ed.querySelector('.eph-all-block');
    if (!b) return;
    const htmlO = blockContentHTML(b);
    st.overallOptimizedHTML = htmlO;
    st.overallOptimized = plainTextOf(htmlO);
    syncToConfig(nd); updatePorts(nd); refreshUI(nd);
    return;
  }
  const blocks = _allModal._ed.querySelectorAll('.eph-all-block');
  Array.from(blocks).forEach((b, i) => {
    // 按块上的 cardId 认卡片（块被浏览器删过也不会错位），老 DOM 没有 cardId 时退回按顺序。
    const card = st.cards.find((c) => String(c.id) === String(b.dataset.cardId || '')) || st.cards[i];
    if (!card) return;
    const html = blockContentHTML(b);
    card.contentHTML = html;
    card.content = plainTextOf(html);
  });
  syncToConfig(nd); updatePorts(nd); refreshUI(nd);
}
function phRulesModel(node) { try { return (readConfig(node, {}).rules) || {}; } catch (_) { return {}; } }
// 节点级「卡片合并分隔符号」：输入框里写的 \n / \t / \r 还原成真控制符（与后端 parse_prompt_rules 同一套规则，空则换行）
function cardSeparator(node) {
  const raw = String((stateFor(node).rules && stateFor(node).rules.mergeSep) || '');
  return raw.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t') || '\n';
}
// 收起小标题时隐藏空行（只剩 <br> 的行、空 div/p）；展开时全部恢复。
function markBlankLines(m) {
  if (!m || !m._ed) return;
  const on = m.classList.contains('collapsed');
  m._ed.querySelectorAll('.eph-all-block-body').forEach((b) => {
    Array.from(b.children).forEach((ch) => {
      const blank = !ch.textContent.trim() && !ch.querySelector('img,video,audio,.eph-mref,.ez-ap');
      ch.classList.toggle('eph-all-blank', on && blank);
    });
  });
}
function renderAllEditor(node) {
  const st = stateFor(node);
  const m = allEl(); const ed = m._ed;
  ed.innerHTML = '';
  if (!st.cards.length) {
    ed.appendChild(el('div', 'eph-all-empty')).textContent = ezT('No prompt cards yet. Click "+ Add card" above to add one.');
    return;
  }
  if (_allTab === 'optimized') {
    // 「优化」页签 = 所有卡片合并后整体优化一次的结果（一整块，不按卡片分；分卡优化只在卡片弹窗里手动做）
    const block = el('div', 'eph-all-block');
    const rw = el('div', 'eph-all-block-hd'); rw.contentEditable = 'false';
    const num = el('span', 'eph-all-num'); num.textContent = ezT('Merge');
    const ttl = el('span', 'eph-all-title'); ttl.textContent = ezT('Overall optimized result');
    ttl.title = ezT('Result of runtime auto-optimize / Overall edit "Tools → Optimize prompt": only the default bodies of cards whose merge badge is green are merged (gray cards are skipped); editable directly');
    rw.appendChild(num); rw.appendChild(ttl);
    const body = el('div', 'eph-all-block-body');
    body.innerHTML = st.overallOptimizedHTML || st.overallOptimized || '';
    block.appendChild(rw); block.appendChild(body);
    ed.appendChild(block);
    finishAllEditor(node);
    return;
  }
  st.cards.forEach((card, idx) => {
    const block = el('div', 'eph-all-block'); block.dataset.idx = String(idx); block.dataset.cardId = String(card.id);
    // 左侧小标题行：序号 / 标题(可编辑) / 时间轴 / 删除(-)
    const rw = el('div', 'eph-all-block-hd'); rw.contentEditable = 'false';
    const num = el('span', 'eph-all-num'); num.textContent = String(idx + 1);
    const titleEl = el('span', 'eph-all-title'); titleEl.contentEditable = 'true'; titleEl.setAttribute('data-ph', ezT('Title'));
    titleEl.textContent = card.title || '';
    titleEl.addEventListener('input', () => { card.title = titleEl.textContent.replace(/\u200b/g, ''); syncToConfig(node); syncEditModalTitle(node, card); });
    const delEl = el('button', 'eph-all-del'); delEl.textContent = '－'; delEl.title = ezT('Delete this card');
    delEl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); deleteCard(node, card.id); renderAllEditor(node); });
    // 每张卡片自己的「引用媒体」：插进本卡片内容里，引用状态与卡片弹窗共用（同一个 card.refTarget）
    const refEl = el('button', 'eph-all-ref'); refEl.textContent = ezT('Reference media'); refEl.title = ezT('Browse media from generation nodes referenced by this card; +/- inserts or removes a reference');
    refEl.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      // 块结构被删坏时先重建，否则这里取不到正文 →「引用媒体」点了没反应（重开后块对象已换，按序重找一次）
      healAllEditor(node);
      let blk = block;
      if (!blk.isConnected) {
        const idx = stateFor(node).cards.indexOf(card);
        blk = _allModal._ed.querySelectorAll('.eph-all-block')[idx] || blk;
      }
      const body = blk.querySelector('.eph-all-block-body');
      if (!body) return;
      _phActiveEditor = body;
      // 光标默认落在本卡片内容末尾：这样点 +/− 就插到这张卡片里
      if (!_editorRange || !body.contains(_editorRange.commonAncestorContainer)) {
        const r = document.createRange(); r.selectNodeContents(body); r.collapse(false);
        _editorRange = r;
      }
      openRefBrowser(node, body, card);
    });
    // 「合」放在小标题行、引用媒体按钮前面
    const mergeBtnH = el('button', 'eph-merge-btn'); mergeBtnH.type = 'button'; mergeBtnH.textContent = ezT('Merge'); mergeBtnH.title = ezT('Merge into the merged prompt: green = merge, gray = skip');
    mergeBtnH.classList.toggle('on', !card.mergeOff);
    mergeBtnH.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); card.mergeOff = !card.mergeOff; syncToConfig(node); mergeBtnH.classList.toggle('on', !card.mergeOff); refreshUI(node); });
    rw.appendChild(num); rw.appendChild(titleEl); rw.appendChild(mergeBtnH); rw.appendChild(refEl); rw.appendChild(delEl);
    block.appendChild(rw);
    // 下方内容（按当前页签）
        const body = el('div', 'eph-all-block-body');
    body.innerHTML = card.contentHTML || card.content || '';
    block.appendChild(body);
    ed.appendChild(block);
  });
  finishAllEditor(node);
}
// 渲染收尾：规范下拉同步 + 总体缩进还原（render 重建全部块，需按当前缩进值还原）
function finishAllEditor(node) {
  const m = allEl();
  if (m._ruleDD) { m._ruleDD.setItems(ruleDropdownItems(node, false)); m._ruleDD.value = _normRuleId(phRulesModel(node).ruleId) || 'none'; }
  const ni = parseFloat(m._indentIn.value) || 0;
  m._ed.querySelectorAll('.eph-all-block-body').forEach((x) => { x.style.textIndent = ni ? ni + 'em' : ''; });
  markBlankLines(m);
}
function openAllEditor(node) {
  const m = allEl(); m._node = node;
  _allTab = stateFor(node).overallUseOptimized ? 'optimized' : 'default';   // 回到当前生效的那一页
  _phActiveEditor = m._ed;   // 让颜色等工具作用到总体编辑
  renderAllEditor(node);
  requestAnimationFrame(moveAllTabThumb);
  if (m._toolbarToggle) applyToolbarToggle(m._toolbarToggle, !!(stateFor(node).ui && stateFor(node).ui.allToolbar));
  m.classList.add('active');
  phDockApply(m, node);
}
function moveAllTabThumb() {
  const m = _allModal; if (!m) return;
  const t = m.querySelector('.eph-tab.active'); const th = m._tabThumb;
  if (t && th) { th.style.left = t.offsetLeft + 'px'; th.style.width = t.offsetWidth + 'px'; }
}
function saveAllEditor() {
  const nd = _allModal && _allModal._node; if (!nd) return;
  syncAllContent(nd);
  _phActiveEditor = null;
  _allModal.classList.remove('active');
  try { phDockRemember(nd); } catch (_) {}
}
// 总体编辑「工具→优化提示词」：把所有卡片（按「合」过滤）合并成一份、整体优化一次；
// 结果只写进「总体编辑·优化」，不逐卡片回写（分卡优化只在卡片弹窗里由用户手动触发）。
async function runBatchOptimize(node, method) {
  if (!node) return;
  const st = stateFor(node);
  // 先把编辑器里还没保存的改动写回卡片（否则合并的是旧内容）
  if (_allModal && _allModal.classList.contains('active') && _allModal._node === node) syncAllContent(node);
  const cfg = optimizeFor(node);
  if (method === 'api' && cfg.provider !== 'Ollama' && !cfg.apiKey) { phTip(ezT('Optimizing with the API requires an API Key for this provider in Settings > API settings.')); return; }
  // 源 = 每张卡**默认**页签的正文（不看卡片滑块、不取优化版），跳「合」灰卡、空的不占位，用「卡片合并分隔符号」拼成一份
  const parts = [];
  st.cards.forEach((c) => {
    if (c.mergeOff) return;
    const s = String(c.content || plainTextOf(c.contentHTML || '') || '').trim();
    if (s) parts.push(s);
  });
  if (!parts.length) { phTip(ezT('The current cards have no prompt content to optimize.')); return; }
  const merged = parts.join(cardSeparator(node));
  phProgShow(node, 1, ezT('Overall optimize'));
  phProgTick(node, 0, ezT('Merging ') + parts.length + ezT(' cards, single call…'));
  const payload = { method, prompt: merged, provider: cfg.provider || '', model: cfg.model || '', apiUrl: cfg.apiUrl || '', apiKey: cfg.apiKey || '', proxy: cfg.proxy || '', image: '', textgen: cfg.textgen || {}, llama: cfg.llama || {}, apiParams: cfg.apiParams || {}, clearCache: !!cfg.clearCache };
  const imgs = await cardImageDataUrls(node, null);
  if (imgs.length) payload.images = imgs;
  const medias = cardMediaRefs(node, null);
  if (medias.length) payload.media = medias;
  if (imgs.length || medias.length) phProgTick(node, 0, ezT('Merging ') + parts.length + ezT(' cards, attached ') + (imgs.length ? imgs.length + ' ' + ezT('images') : '') + (medias.length ? (imgs.length ? ' + ' : '') + medias.length + ' ' + ezT('video/audio') : '') + '…');
  try {
    const r = await fetchApi('/prompt_helper/optimize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) { phProgErr(node, d.error || ('HTTP ' + r.status)); phTip(ezT('Optimization failed: ')  + (d.error || ('HTTP ' + r.status))); return; }
    const out = d.text || '';
    // 结果 = 「总体编辑」里那份整体优化（不写进每张卡片）
    st.overallOptimized = out;
    st.overallOptimizedHTML = plainTextToHtml(out);
    st.overallUseOptimized = true;
    phProgDone(node);
    syncToConfig(node); updatePorts(node); refreshUI(node);
    _allTab = 'optimized'; if (_allModal && _allModal.classList.contains('active')) switchAllTab('optimized');
  } catch (e) { phProgErr(node, (e && e.message  ?  e.message : e)); phTip(ezT('Optimization request failed: ')  + (e && e.message  ?  e.message : e)); }
}

// ===== 面板 =====
function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'eph-shell');
  const root = el('div', 'eph-root');
  shell.appendChild(root);
  node._ezRoot = shell;
  const hd = el('div', 'eph-hd');
  const allBtn = el('button', 'eph-btn primary'); allBtn.textContent = ezT('Overall edit');
  const settingsBtn = el('button', 'eph-btn'); settingsBtn.textContent = ezT('Settings');
  const cmBtn = el('button', 'eph-btn'); cmBtn.textContent = ezT('Card manager'); cmBtn.title = ezT('Save / load prompt cards (userdata/prompts)');
  const addBtn = el('button', 'eph-btn'); addBtn.textContent = ezT('+ Add prompt card');
  const dockBtn = el('button', 'eph-btn'); dockBtn.style.flex = '0 0 auto';
  node._ezDockBtn = dockBtn; phDockSyncBtn(node);   // 弹窗 ⇄ 平铺（状态持久化在节点 config 的 ui.dock）
  hd.appendChild(allBtn); hd.appendChild(dockBtn); hd.appendChild(settingsBtn); hd.appendChild(cmBtn); hd.appendChild(addBtn);
  const list = el('div', 'eph-list');
  root.appendChild(hd); root.appendChild(list);
  root._list = list;
  addBtn.addEventListener('click', () => addCard(node));
  dockBtn.addEventListener('click', () => phDockToggle(node));
  settingsBtn.addEventListener('click', () => openSettings(node));
  allBtn.addEventListener('click', () => openAllEditor(node));
  cmBtn.addEventListener('click', () => openCardMgr(node));
  //  键盘  Ctrl+F / Ctrl+H（卡片或总体编辑打开时都可用）
    document.addEventListener('keydown', (e) => {
    const editOpen = _editModal && _editModal.classList.contains('active');
    const allOpen = _allModal && _allModal.classList.contains('active');
    if (!(editOpen || allOpen)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); openFindModal('find'); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'h') { e.preventDefault(); openFindModal('replace'); }
  });
  refreshUI(node);
  return shell;
}
function fitNode(node) {
  try {
    const root = node && node._ezRoot && node._ezRoot.querySelector('.eph-root');
    if (!root || typeof node.setSize !== 'function') return;
    const cur = node.size || [0, 96];
    const contentH = root.scrollHeight + 12;
    if (contentH > cur[1] + 4) node.setSize([Math.max(380, cur[0]), Math.min(560, contentH)]);
  } catch (_) {}
}
function refreshUI(node) {
  const root = node && node._ezRoot;
  if (!root) return;
  renderCards(node);
}
// 运行期回写（后端 run() 的 ui）：
//   optimized           本轮新算出来的整体优化内容 → 写进「整体优化结果」
//   useOverallOptimized 这次输出用的是整体优化 → 总编辑滑块切到「优化」
//   cardUpdates         运行期动过的卡（合=灰的单卡优化结果 / 滑块切换）
// ComfyUI 的 ui 契约：后端每个键的值是**列表**（execution.py 按值列表合并），所以这里取 [0]；
// 同时兼容直接给标量 / 直接给数组的写法。
function uiScalar(v) { return Array.isArray(v) ? v[0] : v; }
function uiList(v) {
  if (!Array.isArray(v)) return [];
  return (v.length === 1 && Array.isArray(v[0])) ? v[0] : v;
}
function applyExecutedOptimized(node, ui) {
  if (!node || !ui) return;
  const st = stateFor(node);
  let changed = false;
  const text = String(uiScalar(ui.optimized) || '');
  if (text) {
    st.overallOptimized = text;
    st.overallOptimizedHTML = plainTextToHtml(text);
    changed = true;
  }
  if (uiScalar(ui.useOverallOptimized) && !st.overallUseOptimized) { st.overallUseOptimized = true; changed = true; }
  (uiList(ui.cardUpdates)).forEach((c) => {
    if (!c || c.id == null) return;
    const local = st.cards.find((x) => x && String(x.id) === String(c.id));
    if (!local) return;
    if (c.contentOptimized) {
      local.contentOptimized = c.contentOptimized;
      local.contentOptimizedHTML = plainTextToHtml(c.contentOptimized);
      changed = true;
    }
    if (c.useOptimized && !local.useOptimized) { local.useOptimized = true; changed = true; }
  });
  if (!changed) return;
  syncToConfig(node);
  refreshUI(node);
  // 「总体编辑」开着且没在焦点里打字时，按新槽位重绘
  try {
    const m = _allModal;
    if (m && m.classList.contains('active') && m._node === node && m._ed && !m._ed.contains(document.activeElement)) {
      _allTab = st.overallUseOptimized ? 'optimized' : _allTab;
      renderAllEditor(node);
    }
  } catch (_) {}
}

// 节点外黑框 socket 标签（仿 ModelsCombo installOutsideLabels：DOM 覆盖层逐帧对齐 socket 圆点）。
// 输入端口标签在圆点左侧、输出在右侧，随画布缩放，socket 列表变化时重建。
function installSocketLabels(node) {
  if (!node || node._ephOutLabels) return;
  node._ephOutLabels = true;
  let all = [];
  let sig = '';
  const dotColor = (t) => (t === '*' ? MEDIA_PORT_COLOR
    : t === 'CLIP' ? '#fbbf24'
    : t === 'MODEL' ? '#a78bfa'
    : t === 'MODEL_3D' ? '#a78bfa'
    : t === 'AUDIO' ? '#34d399'
    : t === 'VIDEO' ? '#60a5fa'
    : t === 'IMAGE' ? '#f87171'
    : t === 'STRING' ? '#94a3b8'
    : '#cbd5e1');
  const mk = (text) => {
    const l = el('div', 'eph-socket-label');
    const dot = el('span', 'eph-socket-dot');
    const span = el('span'); span.textContent = text || '';
    l.appendChild(dot); l.appendChild(span);
    l.style.display = 'none';
    document.body.appendChild(l);
    return { el: l, dot, remove: () => { try { l.remove(); } catch (_) {} } };
  };
  const scan = () => {
    const cur = [];
    (node.inputs || []).forEach((s, i) => {
      if (s && !s.hidden && s.name !== 'config') cur.push({ in: true, i, name: s._ezLabel || s.name || s.type, type: s.type });
    });
    (node.outputs || []).forEach((s, i) => {
      if (s && !s.hidden) cur.push({ in: false, i, name: s._ezLabel || s.name || s.type, type: s.type });
    });
    const s = cur.map((x) => x.in + '|' + x.i + '|' + x.name).join(';');
    if (s !== sig) {
      sig = s;
      all.forEach((x) => { try { x.remove(); } catch (_) {} });
      all = cur.map((x) => { const l = mk(x.name); l.i = x.i; l.in = x.in; l.type = x.type; return l; });
      node._ephOutEls = all;
    }
  };
  const update = () => {
    const rootEl = node._ezRoot;
    if (!rootEl || !rootEl.isConnected) { return; }
    if (app && app.graph && node.graph !== app.graph) {
      (node._ephOutEls || []).forEach((x) => { try { x.el.style.display = 'none'; } catch (_) {} });
      return;
    }
    let rect = null;
    try { rect = rootEl.getBoundingClientRect(); } catch (_) { return; }
    if (!rect || rect.width <= 0) { return; }
    const nodeW0 = (node.size && node.size[0]) || 1;
    const sx0 = rect.width / nodeW0;
    if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight || sx0 < 0.3) {
      all.forEach((item) => { item.el.style.display = 'none'; });
      return;
    }
    scan();
    const nodeH = (node.size && node.size[1]) || 1;
    const sy = rect.height / nodeH;
    all.forEach((item) => {
      let pos = null;
      try { pos = node.getConnectionPos(item.in, item.i, [0, 0]); } catch (_) { pos = null; }
      if (!pos || !pos.length) { try { pos = item.in ? node.getInputPos(item.i) : node.getOutputPos(item.i); } catch (_2) { pos = null; } }
      if (!pos || !pos.length) { item.el.style.display = 'none'; return; }
      const sx = rect.width / nodeW0;
      const np = node.pos || [0, 0];
      const cx = rect.left + (pos[0] - (np[0] || 0)) * sx;
      const cy = rect.top + (pos[1] - (np[1] || 0)) * sy;
      item.el.style.display = 'inline-flex';
      const zoom = Math.max(0.5, sx);
      item.el.style.fontSize = Math.max(8, 9 * zoom) + 'px';
      item.el.style.padding = (3 * zoom) + 'px ' + (7 * zoom) + 'px';
      item.el.style.borderRadius = (3 * zoom) + 'px';
      item.el.style.boxShadow = '0 1px ' + (3 * zoom) + 'px rgba(0,0,0,.25)';
      const tw = item.el.offsetWidth;
      const th = item.el.offsetHeight || 16;
      const offX = 11 * zoom;
      item.el.style.left = (item.in ? cx - tw - offX : cx + offX) + 'px';
      item.el.style.top = (cy - th / 2) + 'px';
      try { item.dot.style.background = dotColor(item.type); } catch (_) {}
    });
  };
  // 不再每帧自递归：与画布同帧同步更新（onDrawForeground），resize/滚动/注册表变化时经 rAF 补
  const schedule = () => pumpFrames();
  {
    const prevDraw = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
      if (prevDraw) prevDraw.call(this, ctx);
      update();
        pumpFrames();
    };
    scheduleOnRedraw(update);
    onLocaleChange(() => { try { refreshUI(node); } catch (_) {} update(); });   // 语言切换即时重画
    scheduleOnRedraw(phDockTrack);   // 平铺面板跟着画布平移/缩放
    schedule();
  }
}

// ===== 挂载 =====
function hideConfigWidget(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && _in.name === 'config') { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}
  const w = configWidget(node); if (!w || node._ezPhCfgHid) return; node._ezPhCfgHid = true;
  try {
    w.origComputeSize = w.computeSize; w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0;
    w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
  } catch (_) {}
}
// DOM widget 类型名每个实例唯一（同类型节点并存时避免 widget/socket 混淆，与 MediaLoader/MediaOut 写法一致）
let _phWidgetSeq = 0;
function nextPhWidgetType() { _phWidgetSeq += 1; return 'eph-config__' + _phWidgetSeq.toString(36); }
function setupNode(node) {
  if (!node || node._ezPhSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') { console.warn('[PromptHelper] this frontend does not support addDOMWidget, panel cannot mount (node #' + node.id + ')'); return; }
    node._ezPhSetup = true;
    loadFromConfig(node);
    const root = buildRoot(node);
    node._ezRoot = root;
    makeDomWidgetHitThrough(root);
    const widget = node.addDOMWidget('提示词卡片', nextPhWidgetType(), root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 120, getValue: () => '{}', setValue: () => {} });
    makeDomWidgetHitThrough(widget.element || root);
    node.widgets_start_y = 0;
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
    installResizeHandles(node, root);
    try { node.setSize([430, Math.max(120, Math.min(240, node.size ? node.size[1] : 120))]); } catch (_) {}
    hideConfigWidget(node);
    updatePorts(node, true);
    setTimeout(() => updatePorts(node), 80);
    installSocketLabels(node);
    phDockRestoreSoon(node);   // 上次平铺开着的面板（卡片弹窗/总体编辑/引用媒体）载入后自动恢复
  } catch (e) { console.error('[PromptHelper] init failed:', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__ezPhHooked) return; nt.__ezPhHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; console.log('[PromptHelper] hook nodeCreated #' + this.id); setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = prevCfg ? prevCfg.apply(this, arguments) : undefined; loadFromConfig(this); updatePorts(this, true); refreshUI(this); return r; };
  const prevConn = nt.prototype.onConnectionsChange; nt.prototype.onConnectionsChange = function (type, index, connected, link_info) {
    const r = prevConn ? prevConn.apply(this, arguments) : undefined;
    try { if (this._ezPhSetup) setTimeout(() => { updatePorts(this); refreshUI(this); }, 0); } catch (_) {}
    return r;
  };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; unregisterNode(this); try { if (this._ezPhSyncTimer) clearTimeout(this._ezPhSyncTimer); } catch (_) {} try { if (this._ephOutRaf) cancelAnimationFrame(this._ephOutRaf); } catch (_) {} try { (this._ephOutEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); } catch (_) {} try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {} this._ezPhSetup = false; return r; };
  const prevAdded = nt.prototype.onAdded; nt.prototype.onAdded = function () { const r = prevAdded ? prevAdded.apply(this, arguments) : undefined; registerNode(this); setupNode(this); return r; };
  // 运行期整体优化结果回写（后端 run() 返回 ui.optimized → 写进「总体编辑·优化」）
  const prevExec = nt.prototype.onExecuted; nt.prototype.onExecuted = function (message) {
    const r = prevExec ? prevExec.apply(this, arguments) : undefined;
    try { applyExecutedOptimized(this, message); } catch (_) {}
    return r;
  };
}
app.registerExtension({
  name: 'Comfy.EzFlex.PromptHelper',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() { const g = app && app.graph; const ns = (g && (g._nodes || g.nodes)) || []; ns.forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); startIndexWatcher(this); onIndexChange(() => { refreshMediaChips(); refreshRefBrowser(); }); },
});
