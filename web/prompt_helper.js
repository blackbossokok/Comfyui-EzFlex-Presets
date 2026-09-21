// EzFlex-PromptHelper 提示词卡片合并节点。
// 前端面板：完整富文本编辑器（卡片列表 + 格式工具条 + 颜色/字号/缩进 + 查找替换 + 取色器 + 媒体引用芯片）
// + 「设置」弹窗（调用 / 引用规则 / 引用识别 / API / TextGenerate / llama / 路径 / 其他）+ 「卡片管理」弹窗（userdata/prompts 存取卡片）。
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
  scheduleOnRedraw, pumpFrames, ezSanitizeHtml, pageRange,
} from "./ezflex_service.js";
import { ezT, onLocaleChange } from "./ezflex_i18n.js";
import {
  mediaKeyOf, mediaIndex, indexTargets, indexTargetById, activeIndexTarget,
  mediaSizeText, mediaFormatOf, startIndexWatcher, onIndexChange, nodeInputMedia,
  refreshIndexNow, refreshIndexSoon, mediaTargetDefaults, mediaTargetCfg, mediaWord, setMediaTargetCfg,
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

const PH_BUILD = '2026-09-14-cards145';
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
const PH_DOCK_ORDER = ['eph-modal', 'eph-all', 'eph-rb', 'eph-tp'];   // 同时开着时，默认位置按这个顺序错开
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
  const list = [_editModal, _allModal, _refBrowser, _tpEl];   // 标签面板和其它三个一样：跟着画布平移/缩放
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
  'eph-all': { wf: 0.42, hf: 0.30, minW: 360, minH: 200 },
  'eph-rb': { wf: 0.32, hf: 0.25, minW: 300, minH: 160 },
  'eph-tp': { wf: 0.42, hf: 0.44, minW: 380, minH: 260 },
};
// 默认尺寸/数值语义改了就把这个 +1：旧 config 里的 dockMem 尺寸作废一次，让新默认值生效
const PH_DOCK_SIZE_V = 3;
function phDockApply(ov, node) {
  if (!ov) return;
  if (node) ov._dockNode = node;
  const on = phDockOn(ov._dockNode || ov._node);
  ov.classList.toggle('ph-dock', on);
  try { ov.querySelectorAll('[contenteditable]').forEach((x) => { x.spellcheck = false; }); } catch (_) {}
  const _bx = ov.querySelector('.eph-modal-box, .eph-all-box, .eph-rb-box');
  if (_bx) {
    if (on) {   // 平铺：清掉弹窗模式留在盒子上的内联尺寸/偏移，交给 .ph-dock 的宽度规则
      _bx.style.width = ''; _bx.style.height = ''; _bx.style.maxWidth = ''; _bx.style.maxHeight = '';
      _bx.style.marginLeft = ''; _bx.style.marginTop = ''; _bx.style.transform = '';
    }
  }
  if (!on) { phPopApply(ov); requestAnimationFrame(() => phDockThumbs(ov)); ov.style.left = ov.style.top = ov.style.right = ov.style.bottom = ov.style.width = ov.style.height = ''; ov.style.zIndex = ''; ov.style.transform = ''; ov.style.transformOrigin = ''; return; }
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
// 平铺模式下「卡片弹窗 ⇄ 总体编辑」互斥：打开一个就把另一个关掉（"变成"另一个）；引用媒体不动（它是从卡片弹窗里点开的）
function phDockSwitchTo(keep) {
  if (!keep || !phDockOn(keep._dockNode || keep._node)) return;
  if (keep !== _editModal && _editModal && _editModal.classList.contains('active')) { try { closeEditModal(true); } catch (_) {} }
  if (keep !== _allModal && _allModal && _allModal.classList.contains('active')) { try { _allModal._phOnClose && _allModal._phOnClose(); } catch (_) {} try { _allModal.classList.remove('active'); } catch (_) {} try { closeTagPicker(); } catch (_) {} }
}
// 弹窗模式（非平铺）：标题栏拖动 + 右下角缩放；位置/尺寸和平铺共用同一份记忆（按节点持久化）
function phPopApply(ov) {
  const box = ov.querySelector('.eph-modal-box, .eph-all-box, .eph-rb-box');
  if (!box) return;
  const m = _phDockMem[phDockKey(ov)] || (_phDockMem[phDockKey(ov)] = {});
  if (m.pw && m.ph) {
    box.style.width = m.pw + 'px'; box.style.height = m.ph + 'px';
    box.style.maxWidth = 'none'; box.style.maxHeight = 'none';
  }
  if (m.px !== undefined) box.style.transform = 'translate(' + m.px + 'px,' + m.py + 'px)';
  phPopInstall(ov, box);
}
function phPopInstall(ov, box) {
  if (ov._popUi) return;
  const head = ov.querySelector('.eph-modal-hd, .eph-all-hd, .eph-rb-hd, .eph-tp-hd');
  if (!head) return;
  ov._popUi = true;
  const memOf = () => (_phDockMem[phDockKey(ov)] || (_phDockMem[phDockKey(ov)] = {}));
  // 右下角缩放手柄：挂在盒子上（弹窗模式浮层是全屏，挂浮层会跑屏幕角落）
  const size = el('div', 'eph-dock-size'); size.title = ezT('Drag to resize panel');
  box.appendChild(size);
  size.addEventListener('pointerdown', (e) => {
    if (ov.classList.contains('ph-dock') || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const r = box.getBoundingClientRect();
    const w0 = r.width, h0 = r.height, sx = e.clientX, sy = e.clientY;
    const mv = (ev) => {
      const m2 = memOf();
      m2.pw = Math.max(320, Math.round(w0 + ev.clientX - sx));
      m2.ph = Math.max(200, Math.round(h0 + ev.clientY - sy));
      box.style.width = m2.pw + 'px'; box.style.height = m2.ph + 'px';
      box.style.maxWidth = 'none'; box.style.maxHeight = 'none';
      // 居中盒子会长在两边：补掉左上被推走的一半 → 视觉上只把右边/下边拉出去
      box.style.transform = 'translate(' + ((m2.px || 0) + (m2.pw - w0) / 2) + 'px,' + ((m2.py || 0) + (m2.ph - h0) / 2) + 'px)';
      phDockThumbs(ov);   // 跟着新宽度重排页签滑块
    };
    const up = () => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
      const m2 = memOf();
      m2.px = Math.round((m2.px || 0) + (m2.pw - w0) / 2);   // 把补偿折进位置，后面拖动接着走
      m2.py = Math.round((m2.py || 0) + (m2.ph - h0) / 2);
      box.style.transform = 'translate(' + m2.px + 'px,' + m2.py + 'px)';
      try { phDockRemember(ov._dockNode || ov._node); } catch (_) {}
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
  // 拖标题行（没有额外拖手图标）
  head.addEventListener('pointerdown', (e) => {
    if (ov.classList.contains('ph-dock') || e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button,input,select,textarea,.eph-dd,.eph-modal-close,.eph-color-dropdown,.eph-tools-dropdown,.eph-font-dropdown')) return;
    const m = memOf();
    const sx = e.clientX, sy = e.clientY, px = m.px || 0, py = m.py || 0;
    e.preventDefault();
    const mv = (ev) => {
      const m2 = memOf();
      m2.px = Math.round(px + ev.clientX - sx); m2.py = Math.round(py + ev.clientY - sy);
      box.style.transform = 'translate(' + m2.px + 'px,' + m2.py + 'px)';   // transform 不走布局，跟手
    };
    const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); try { phDockRemember(ov._dockNode || ov._node); } catch (_) {} };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
  head.addEventListener('dblclick', () => {   // 双击标题栏复位
    if (ov.classList.contains('ph-dock')) return;
    const m2 = memOf();
    delete m2.px; delete m2.py; delete m2.pw; delete m2.ph;
    box.style.width = ''; box.style.height = ''; box.style.maxWidth = ''; box.style.maxHeight = '';
    box.style.transform = '';
    requestAnimationFrame(() => phDockThumbs(ov));
    try { phDockRemember(ov._dockNode || ov._node); } catch (_) {}
  });
}

function phDockInstall(ov) {   // 平铺面板的两种交互：标题栏拖动 + 右下角缩放，都只装一次
  if (ov._dockUi) return;
  const head = ov.querySelector('.eph-modal-hd, .eph-all-hd, .eph-rb-hd, .eph-tp-hd');
  if (!head) return;
  ov._dockUi = true;
  const grip = el('span', 'eph-dock-grip'); grip.textContent = '⠿'; grip.title = ezT('Drag to move panel (double-click title bar to restore default position)');
  if (!head.querySelector('.eph-dock-grip')) head.insertBefore(grip, head.firstChild);
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
  [_editModal, _allModal, _refBrowser, _tpEl].forEach((ov) => { if (ov) phDockApply(ov, ov._dockNode || ov._node || node); });
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
  st.ui.dockOpen = { card: cardOn ? (st.editingId || null) : null, all: on(_allModal), ref: on(_refBrowser), tp: on(_tpEl) };
  st.ui.dockSizeV = PH_DOCK_SIZE_V;
  const mems = {};
  PH_DOCK_ORDER.forEach((k) => { const m = _phDockMem[k]; if (m && m.w && m.h) mems[k] = { w: m.w, h: m.h, cx: m.cx, cy: m.cy }; });
  PH_DOCK_ORDER.forEach((k) => {                 // 弹窗模式的位置/尺寸也一起记
    const m = _phDockMem[k]; if (!m) return;
    const rec = mems[k] || {};
    if (m.pw && m.ph) { rec.pw = m.pw; rec.ph = m.ph; }
    if (m.px !== undefined) { rec.px = m.px; rec.py = m.py; }
    if (Object.keys(rec).length) mems[k] = rec;
  });
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
  Object.keys(mems).forEach((k) => { const m = mems[k]; if (!m) return; const t = _phDockMem[k] || (_phDockMem[k] = {}); if (m.pw && m.ph) { t.pw = m.pw; t.ph = m.ph; } if (m.px !== undefined) { t.px = m.px; t.py = m.py; } if (sizeOk) { if (m.w) t.w = m.w; if (m.h) t.h = m.h; } if (m.cx !== undefined) { t.cx = m.cx; t.cy = m.cy; } });
  const card = rec.card ? (st.cards || []).find((c) => c.id === rec.card) : null;
  if (rec.all) { try { openAllEditor(node); } catch (_) {} }
  if (card) { try { openEditModal(node, card.id); } catch (_) {} }
  if (rec.ref) {
    const ed = (_editModal && _editModal._node === node && _editModal.classList.contains('active') && _editModal._editor)
      || (_allModal && _allModal._node === node && _allModal.classList.contains('active') && _allModal._ed) || null;
    if (ed) { try { openRefBrowser(node, ed, card || null); } catch (_) {} }
  }
  if (rec.tp) {   // 标签面板也跟着恢复（绑到刚恢复的编辑器上）
    const ed = (_editModal && _editModal.classList.contains('active') && _editModal._node === node && _editModal._editor)
      || (_allModal && _allModal.classList.contains('active') && _allModal._node === node && _allModal._ed) || null;
    if (ed) { try { openTagPicker(ed, null); } catch (_) {} }
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
    n += 1; if (n < 14) setTimeout(tick, 80);
  };
  tick();   // 先立刻试一次（loadedGraphNode 时 config 通常已就位，不用再等）
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
.eph-badge-live{background:#2f9e63;}
.eph-preview{flex:1 1 auto;min-width:0;font-size:11px;color:#8a9aa8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;}
.eph-card.linked{opacity:.55;background:#f3f5f9;border-color:#e2e8f0;}
.eph-card.linked .eph-title{opacity:.5;}
.eph-batch{display:none;gap:6px;flex-wrap:wrap;padding:6px 2px 8px;}
.eph-batch.on{display:flex;}
.eph-card.on{background:#e7f7ec;border-color:#86d3a4;}

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
.eph-modal.ph-dock .eph-modal-full,.eph-all.ph-dock .eph-all-full,.eph-tp.ph-dock .eph-modal-full{display:none;}
.eph-tp.ph-dock{inset:auto;max-height:none;}
.eph-dock-grip{display:none;flex:0 0 auto;color:#9aa7b5;font-size:13px;line-height:1;cursor:move;letter-spacing:1px;}
.ph-dock .eph-dock-grip{display:inline-flex;}
.eph-modal:not(.ph-dock) .eph-dock-grip,.eph-all:not(.ph-dock) .eph-dock-grip,.eph-rb:not(.ph-dock) .eph-dock-grip{display:none;}   /* 拖动把手只在平铺模式露出来 */
.eph-dock-size{display:none;position:absolute;right:2px;bottom:2px;width:16px;height:16px;z-index:6;cursor:nwse-resize;}
.eph-dock-size::after{content:'';position:absolute;right:2px;bottom:2px;width:9px;height:9px;border-right:2px solid #aab4c2;border-bottom:2px solid #aab4c2;border-radius:1px;}
.eph-dock-size:hover::after{border-color:#5f6b7a;}
.ph-dock .eph-dock-size{display:block;}
.eph-modal:not(.ph-dock) .eph-dock-size,.eph-all:not(.ph-dock) .eph-dock-size,.eph-rb:not(.ph-dock) .eph-dock-size{display:block;}   /* 右下角拖拽缩放（仿节点） */
.eph-modal-body{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;overflow:auto;padding:10px 14px;}
.eph-modal-ft{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 16px 0;border-top:1px solid #edf2f8;}
.eph-btn-cancel{background:#f1f4fa;border:1px solid #e2e8f0;color:#4d5b6d;}
.eph-btn-save{background:#1a1a2e;border:1px solid #1a1a2e;color:#fff;}

/* 编辑器工具条 */
.eph-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 10px;background:#f8fafc;border-bottom:1px solid #e6edf7;}
/* 工具条收起/展开：自己占一行（工具条与「默认/优化」行中间），无底边小三角；
   平时隐藏、鼠标悬停才显形；展开态箭头朝上（点它收起），收起态朝下（点它展开）。 */
.eph-tb-toggle{display:flex;align-items:center;justify-content:center;height:10px;flex:0 0 auto;cursor:pointer;opacity:0;transition:opacity .15s;background:transparent;margin:0;}
.eph-modal-body > .eph-tb-toggle{margin:-8px 0;}   /* 吃掉 .eph-modal-body 的 8px gap，夹在工具条与页签之间 */
.eph-all-box > .eph-tb-toggle{margin:-6px 0 0;}   /* 吃掉 .eph-tabs 的 6px margin-bottom，夹在页签与工具条之间 */
.eph-tb-toggle:hover{opacity:1;background:rgba(43,58,74,.06);}
.eph-tb-toggle i{display:block;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:6px solid #8a9aa8;transition:transform .15s;}
.eph-toolbar.collapsed,.eph-all-toolbar.collapsed{display:none;}
.eph-tb-group{display:flex;align-items:center;gap:2px;position:relative;}
.eph-tb-btn{width:23px;height:23px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;border-radius:6px;color:#1a1a2e;cursor:pointer;font-size:12px;font-family:inherit;}
.eph-tb-btn:hover{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08);}
.eph-font-combo{display:flex;border:none;background:#fff;border-radius:7px;overflow:hidden;height:23px;box-shadow:0 1px 4px rgba(0,0,0,.06);}
.eph-font-combo input{border:none;width:32px;text-align:center;outline:none;font-size:11px;color:#1a1a2e;background:transparent;}
.eph-font-combo button{border:none;background:transparent;width:17px;cursor:pointer;position:relative;}
.eph-font-combo button::after{content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-70%);border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #94a3b8;}
.eph-font-list{position:absolute;top:34px;z-index:200;background:#fff;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.12);max-height:240px;overflow-y:auto;width:96px;display:none;padding:4px;}
.eph-font-list.active{display:block;}
.eph-font-list li{list-style:none;padding:7px;cursor:pointer;font-size:12px;text-align:center;border-radius:6px;}
.eph-font-list li:hover{background:#f1f4fa;}
.eph-color-btn{display:flex;align-items:center;gap:2px;padding:3px;border-radius:8px;cursor:pointer;border:none;background:transparent;}
.eph-color-btn:hover{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08);}
.eph-icon-a{font-weight:900;font-size:13px;font-family:sans-serif;position:relative;}
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
.eph-genprog{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:100040;display:none;align-items:center;gap:10px;background:#1f2937;color:#f8fafc;padding:8px 14px;border-radius:10px;font-size:12px;box-shadow:0 10px 28px rgba(0,0,0,.3);}
.eph-genprog.on{display:flex;}
.eph-genprog>i{display:block;width:180px;height:6px;border-radius:3px;background:rgba(255,255,255,.22);overflow:hidden;}
.eph-genprog>i>b{display:block;height:100%;width:0;background:#34a853;transition:width .15s;}
.eph-genprog-stop{margin-left:4px;border:1px solid rgba(255,255,255,.32);background:transparent;color:#f8fafc;border-radius:7px;padding:2px 9px;font-size:11px;font-family:inherit;cursor:pointer;}
.eph-genprog-stop:hover{background:rgba(255,255,255,.14);}
.eph-catcascade{position:fixed;z-index:100030;}
.eph-catcascade .eph-catpick{position:absolute;box-sizing:border-box;width:224px;max-height:min(62vh,420px);overflow-y:auto;scrollbar-gutter:stable;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.16);padding:6px;}
.eph-catpick-row{display:flex;align-items:center;}
.eph-catpick-root{font-weight:600;color:#334155;}
.eph-catpick-self{font-weight:600;color:#4338ca;background:#f5f3ff;}
.eph-catpick-cur{background:#eef2ff;}
.eph-catpick-tri{margin-left:auto;flex:0 0 auto;width:14px;color:#94a3b8;font-size:11px;text-align:right;user-select:none;cursor:pointer;}
.eph-catpick-tri:empty{cursor:default;}
.eph-catpick-nm{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eph-tool-item:hover{background:#f1f4fa;}
.eph-mref-ico{display:inline-flex;width:14px;height:14px;vertical-align:-2px;}
.eph-mref-ico svg{width:14px;height:14px;display:block;}
.eph-mref-num{color:#2563eb;font-weight:500;margin-right:5px;}
.eph-mref-num.off{color:#9aa7b5;}
.eph-mref-off{opacity:.5;}
.eph-mref-warn{font-size:10px;color:#c2410c;padding:2px 11px 5px;line-height:1.5;}
.eph-indent-group{display:flex;align-items:center;gap:4px;}
.eph-indent-group label{font-size:11px;color:#5f6b7a;}
.eph-indent-input{width:38px;text-align:center;border:1px solid #dce3ec;border-radius:6px;padding:2px 4px;font-size:11px;font-family:inherit;outline:none;height:23px;}
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
.eph-cm .eph-switch{display:flex;flex-direction:row;align-items:center;gap:6px;padding:0;cursor:pointer;user-select:none;}
.eph-seg{flex:0 0 auto;display:flex;background:#f1f4fa;border-radius:9px;padding:2px;}
.eph-seg-item{font-style:normal;font-size:11px;font-weight:600;padding:4px 12px;border-radius:7px;color:#94a3b8;cursor:pointer;transition:all .15s;}
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
.eph-all{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100005;background:rgba(0,0,0,.35);}
.eph-all-splitbar{display:none;align-items:center;gap:8px;padding:6px 16px;border-bottom:1px solid #edf2f8;background:#f7fbf8;}
.eph-all-splitbar.on{display:flex;}
.eph-all-splitlabel{flex:1 1 auto;font-size:12px;color:#15803d;}
.eph-cm-splitting .eph-all-block{cursor:pointer;}
.eph-cm-splitting .eph-all-block.sel{outline:2px solid #86d3a4;outline-offset:-2px;background:#e7f7ec;border-radius:8px;}
.eph-all.active{display:flex;}
.eph-all-box{background:#fff;border-radius:16px;width:96%;max-width:1080px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 26px 80px rgba(0,0,0,.28);font-family:Inter,sans-serif;box-sizing:border-box;}
.eph-all-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #edf2f8;}
.eph-all-hd b{font-size:14px;color:#0f141f;}
.eph-all-hd-right{display:flex;align-items:center;gap:8px;}
.eph-all-hd-right .eph-all-full{height:28px;padding:0 12px;font-size:12px;}
.eph-all-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid #edf2f8;background:#fbfcfe;}
.eph-all-toolbar label{display:flex;align-items:center;gap:4px;font-size:11px;color:#5f6b7a;}
.eph-all-toolbar input[type=color]{width:26px;height:26px;border:1px solid #dce3ec;border-radius:7px;padding:2px;background:#fff;cursor:pointer;}
.eph-all-editor{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 16px;outline:none;line-height:1.6;color:#1a1a2e;font-size:14px;}
.eph-all-block{padding:4px 0 10px;}
.eph-all-block-hd{display:flex;align-items:center;gap:8px;font-size:11px;color:#9aa7b5;padding:6px 18px;border-radius:0;margin:0 -8px 6px;background:#f4f6fa;}
.eph-all-block-hd .eph-merge-btn{margin-left:auto;}
.eph-all-block-hd .eph-all-ref{margin-left:0;}
.eph-all-fold{display:inline-flex;align-items:center;background:transparent;border:none;color:#9aa7b5;cursor:pointer;padding:0 2px;line-height:1;}
.eph-all-fold:hover{color:#334155;}
.eph-all-fold svg{transition:transform .15s;}
.eph-all-block.closed .eph-all-fold svg{transform:rotate(-90deg);}
/* 单张卡片折叠：只收正文，小标题行留着；工具栏的「收起小标题」是全局隐藏小标题行，两者互不干扰 */
.eph-all:not(.collapsed) .eph-all-block.closed .eph-all-block-body{display:none;}
.eph-all:not(.collapsed) .eph-all-block.closed{padding-bottom:0;}
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
.eph-rb-sub{font-size:12px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
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
.eph-tools-head{font-size:10px;color:#94a3b8;padding:8px 11px 2px;letter-spacing:.5px;font-weight:600;user-select:none;}
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
.eph-tb-btn.word-glyph{font-weight:900;font-size:12px;font-family:'Segoe UI',Inter,sans-serif;}
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
.eph-cm-hd{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #edf2f8;}
.eph-cm-hd b{font-size:14px;color:#0f141f;white-space:nowrap;}
.eph-cm-badge{font-size:11px;color:#6b7a8e;font-weight:500;white-space:nowrap;}
.eph-cm-search{flex:0 1 260px;max-width:360px;min-width:90px;font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:7px;padding:5px 9px;outline:none;background:#fff;color:#1a1f2b;}
.eph-cm-search:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(43,58,74,.06);}
.eph-cm-hd .eph-dd-trigger{height:26px;padding:0 8px;font-size:11px;border-radius:7px;}
.eph-cm-hdright{display:flex;align-items:center;gap:8px;margin-left:auto;}
.eph-cm-body{padding:12px 16px;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0;}
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
.eph-cm-hint{font-size:11px;color:#5f6b7a;background:#fff;line-height:1.6;min-height:16px;word-break:break-all;}
.eph-cm-hint.err{background:transparent;color:#991b1b;}
.eph-cm-hint.ok{background:transparent;color:#15803d;}
.eph-cm-split{display:flex;gap:10px;height:46vh;min-height:200px;}
.eph-cm-cats{flex:0 0 168px;overflow:auto;padding:0 8px 0 0;border-right:1px solid #eef2f8;}
.eph-cm-cat{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:7px;font-size:12px;color:#1a1f2b;cursor:pointer;user-select:none;-webkit-user-select:none;}
.eph-cm-cat:hover{background:#f1f4fa;}
.eph-cm-cat.on{background:#eef2ff;color:#3730a3;font-weight:600;}
.eph-cm-cat.drop-before{box-shadow:inset 0 2px 0 #1a1a2e;}
.eph-cm-cat.drop-after{box-shadow:inset 0 -2px 0 #1a1a2e;}
.eph-cm-cat.drop-in{background:#e7f7ec;}
.eph-cm-cat-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.eph-cm-cnt{margin-left:auto;font-size:11px;color:#8a94a8;flex:0 0 auto;}
.eph-cm-list{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:0 0 0 8px;display:flex;flex-wrap:wrap;gap:8px;align-content:flex-start;}
.eph-cm-item{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:8px;font-size:12px;color:#1a1f2b;cursor:pointer;user-select:none;-webkit-user-select:none;}
.eph-cm-item:hover{background:#f1f4fa;}
.eph-cm-item.on{background:#1a1a2e;color:#fff;}
.eph-cm-item-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.eph-cm-item-cnt{flex:0 0 auto;font-size:11px;color:#8a94a3;}
.eph-cm-item.on .eph-cm-item-cnt{color:#c7cdd8;}
.eph-cm-item.drop-in{background:#e7f7ec;box-shadow:inset 0 0 0 1px #86d3a4;}
.eph-cm-tile.mine{border-style:dashed;border-color:#b9a5e3;}   /* 虚线框 = 我的标签副本（自建） */
.eph-cm-tile{position:relative;transition:border-color .12s,background .12s,box-shadow .12s;flex:1 1 108px;max-width:150px;min-width:92px;box-sizing:border-box;border:1px solid #eef2f8;border-radius:9px;overflow:hidden;cursor:pointer;user-select:none;-webkit-user-select:none;background:#fff;display:flex;flex-direction:column;}
.eph-cm-tile:hover{border-color:#c9d6ea;background:#fbfcff;box-shadow:0 2px 8px rgba(15,23,42,.06);}
.eph-cm-tile.on{border-color:#7ea6f0;background:#f4f7ff;box-shadow:0 0 0 3px rgba(59,130,246,.16);}
.eph-cm-tile.sel{border-color:#3b82f6;background:#eef4ff;box-shadow:0 0 0 3px rgba(59,130,246,.22);}

.eph-cm-tile.drop-in{border-color:#86d3a4;box-shadow:0 0 0 2px #86d3a4;}
.eph-cm-tile-pv{position:relative;height:84px;background:#f7f9fd;display:flex;align-items:center;justify-content:center;overflow:hidden;}
.eph-cm-tile-pv img{width:100%;height:100%;object-fit:cover;}
.eph-cm-tile-txt{font-size:10px;color:#8a94a3;padding:6px;white-space:pre-wrap;overflow:hidden;max-height:84px;line-height:1.35;}
.eph-cm-tile-ico{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#c9d3e0;}
.eph-cm-tile-zh{font-size:11px;color:#4a5568;text-align:center;padding:3px 4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eph-cm-tile-badge{position:absolute;left:4px;top:4px;background:rgba(26,26,46,.72);color:#fff;font-size:10px;border-radius:5px;padding:1px 5px;}
.eph-cm-tile-del{position:absolute;right:3px;top:3px;width:18px;height:18px;line-height:1;border:none;border-radius:6px;background:rgba(255,255,255,.92);color:#8a94a3;cursor:pointer;font-size:13px;padding:0;opacity:0;transition:opacity .12s;}
.eph-cm-tile:hover .eph-cm-tile-del{opacity:1;}
.eph-cm-tile-del:hover{color:#e34d4d;}
.eph-cm-tile-name{font-size:11px;color:#1a1f2b;padding:1px 4px 4px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* 插入标签面板：可移动浮窗（同查找替换）；上方「已插入」框 + 左边分组 + 右边卡片 */
.eph-tp{position:fixed;top:90px;left:120px;width:560px;height:600px;max-height:84vh;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);z-index:100010;display:none;flex-direction:column;overflow:hidden;font-family:Inter,sans-serif;}
.eph-tp.active{display:flex;}
.eph-tp-hd{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #e6edf7;cursor:move;user-select:none;-webkit-user-select:none;}
.eph-tp-hd b{font-size:12px;color:#1a1f2b;white-space:nowrap;}
.eph-tp-hd .eph-modal-close{margin-left:auto;}
.eph-tp-hd .eph-dd{flex:0 1 200px;min-width:110px;}
.eph-tp-ins{margin:8px 12px 0;min-height:104px;max-height:184px;overflow-y:auto;border:1px solid #dce3ec;border-radius:8px;padding:3px 5px;background:#fff;display:flex;flex-wrap:wrap;gap:4px;align-content:flex-start;}
.eph-tp-ph{width:100%;min-height:94px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:11px;color:#a8b2c0;}
.eph-tp-grip{position:absolute;right:2px;bottom:2px;width:16px;height:16px;z-index:6;cursor:nwse-resize;}
.eph-tp-grip::after{content:'';position:absolute;right:2px;bottom:2px;width:9px;height:9px;border-right:2px solid #aab4c2;border-bottom:2px solid #aab4c2;}
.eph-tp-grip:hover::after{border-color:#5f6b7a;}
.eph-tp-caret{flex:0 0 auto;width:12px;text-align:center;color:#8a94a3;cursor:pointer;font-size:11px;transition:transform .12s;}
.eph-tp-caret.open{transform:rotate(90deg);}
.eph-tp-caret:hover{color:#1a1f2b;}
.eph-cm-tile-collect{position:absolute;right:4px;top:3px;color:#c7d2fe;cursor:pointer;font-size:12px;line-height:1;}
.eph-cm-tile-collect:hover{color:#6366f1;}
.eph-cm-tile-collect.on{color:#f5b301;}
.eph-tpi.w{background:#e0e7ff;border-color:#a5b4fc;}
.eph-tpi{cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;}
.eph-tpi.drag{opacity:.55;outline:2px dashed #a5b4fc;}
.eph-tpi.tmp{border-style:dashed;background:#fbfcff;}
.eph-tpe{display:flex;gap:14px;align-items:flex-start;}
.eph-tpe-pv{flex:0 0 172px;display:flex;flex-direction:column;gap:6px;}
.eph-tpe-frame{width:172px;height:172px;border:1px dashed #dce3ec;border-radius:10px;background:#fbfcfe;display:flex;align-items:center;justify-content:center;overflow:hidden;}
.eph-tpe-frame img{width:100%;height:100%;object-fit:cover;}
.eph-tpe-fields{flex:1 1 auto;display:flex;flex-direction:column;gap:10px;min-width:0;}
.eph-tpe-f{display:flex;flex-direction:column;gap:4px;}
.eph-tpe-lb{font-size:11px;color:#6b7a8e;}
.eph-tpe-f input{font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:6px 9px;outline:none;background:#fff;color:#1a1f2b;box-sizing:border-box;}
.eph-tpe-f input:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(43,58,74,.06);}
.eph-tpe-f input[type=color]{width:52px;height:28px;padding:0;}
.eph-tpe-f select{font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:6px 9px;outline:none;background:#fff;color:#1a1f2b;box-sizing:border-box;}
.eph-tpi-ph{display:inline-block;width:3px;min-height:22px;align-self:stretch;border-radius:2px;background:#3b82f6;margin:0 1px;box-shadow:0 0 0 2px rgba(59,130,246,.18);}
.eph-tpw{position:fixed;z-index:100030;display:none;background:#fff;border:1px solid #dce3ec;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);padding:6px;flex-direction:column;gap:5px;font-family:Inter,sans-serif;}
.eph-tpw.active{display:flex;}
.eph-tpw-row{display:flex;gap:5px;align-items:center;}
.eph-tpw-in{width:64px;font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:6px;padding:3px 6px;outline:none;background:#fff;color:#1a1f2b;}
.eph-tpw-grp{display:inline-flex;align-items:center;gap:2px;border:1px solid #eef2f8;border-radius:7px;padding:1px 4px;}
.eph-tpw-grp.on{background:#eef2ff;border-color:#c7d2fe;}
.eph-tpw-lb{font-size:11px;color:#4a5568;min-width:20px;text-align:center;}
.eph-tpw-b{width:18px;height:18px;line-height:1;border:1px solid #dce3ec;border-radius:5px;background:#f7f9fd;color:#4a5568;cursor:pointer;font-size:12px;padding:0;}
.eph-tpw-b:disabled{opacity:.35;cursor:default;}
.eph-tpw-b:hover:not(:disabled){background:#eef2ff;color:#3730a3;}
.eph-tp-edit{flex:1 1 100%;min-height:52px;max-height:96px;font-family:inherit;font-size:12px;border:1px solid #c7d2fe;border-radius:8px;padding:4px 6px;outline:none;resize:vertical;background:#fff;color:#1a1f2b;}
.eph-tpi-in{flex:1 1 110px;min-width:90px;font-family:inherit;font-size:11px;border:1px dashed #dce3ec;border-radius:6px;padding:2px 6px;outline:none;background:#fff;color:#1a1f2b;height:22px;}
.eph-cm-row input[type=color]{width:40px;height:24px;padding:0;border:1px solid #dce3ec;border-radius:6px;background:#fff;}
.eph-tpi{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;position:relative;background:#eef2ff;border:1px solid #c7d2fe;border-radius:7px;padding:2px 15px 2px 10px;line-height:1.25;min-width:52px;}
.eph-tpi-zh{font-size:11px;color:#3730a3;white-space:nowrap;text-align:center;}
.eph-tpi-ghost{position:fixed;z-index:100040;pointer-events:none;opacity:.92;box-shadow:0 8px 20px rgba(15,23,42,.22);transform:scale(.97);}
.eph-tpi-en{font-size:9px;color:#8189c9;white-space:nowrap;}
.eph-tpi-x{position:absolute;right:3px;top:0;cursor:pointer;color:#818cf8;font-weight:700;font-size:11px;}
.eph-tpi-x:hover{color:#e34d4d;}
.eph-tp-row{display:flex;gap:6px;align-items:center;padding:8px 12px;}
.eph-tp-row2{display:flex;gap:6px;align-items:center;padding:0 12px 8px;}
.eph-tp-row2.tp-collapsed > *{display:none;}
.eph-tp-row2.tp-collapsed > .eph-tp-side{display:inline-flex;}
.eph-tp-search{flex:0 1 130px;min-width:92px;}   /* 搜索框尽量留着 */
/* 随机 tag 弹窗：每行 = 分类下拉 + 数量 + 开关 + 减号 */
.eph-rand-list{display:flex;flex-direction:column;gap:6px;max-height:52vh;overflow:auto;padding:2px 0 6px;}
.eph-rand-row{display:flex;align-items:center;gap:8px;}
.eph-rand-cat{flex:1 1 auto;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.eph-rand-n{width:58px;height:26px;box-sizing:border-box;font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:2px 6px;outline:none;background:#fff;color:#1a1f2b;text-align:center;-moz-appearance:textfield;appearance:textfield;}
.eph-rand-n::-webkit-outer-spin-button,.eph-rand-n::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.eph-rand-sw{width:36px;height:18px;flex:0 0 auto;border-radius:9px;border:1px solid #dce3ec;background:#e8edf5;position:relative;cursor:pointer;padding:0;transition:background .12s;}
.eph-rand-sw::after{content:'';position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.18);transition:left .12s;}
.eph-rand-sw.on{background:#86d3a4;border-color:#5cb884;}
.eph-rand-sw.on::after{left:19px;}
.eph-rand-del{flex:0 0 auto;background:transparent;border:none;color:#b7c1cf;font-size:15px;line-height:1;cursor:pointer;padding:1px 5px;}
.eph-rand-del:hover{color:#e34d4d;background:#fdecec;border-radius:6px;}
.eph-tool-item{display:flex;align-items:center;}
.eph-tool-item.on{background:#eef2ff;color:#3730a3;font-weight:600;}
.eph-tool-item.on::after{content:'✓';margin-left:auto;padding-left:10px;color:#4f46e5;font-weight:600;}
.eph-tools-dropdown.eph-ctx{max-height:min(62vh,460px);overflow-y:auto;}
.eph-dd-menu{z-index:100200;}
.eph-gen-in{resize:none;}   /* 提示词框不要右下角拖手 */   /* 下拉菜单要盖过生图设置等弹层，否则开了看不见 = "点不动" */   /* 长的右键菜单（移动至分组等）能滚，别看不到下面 */
.eph-tp.full{left:0!important;top:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;box-sizing:border-box;border-radius:0;}
.eph-tp.full .eph-tp-split{flex:1 1 auto;min-height:0;}
.eph-tp.full .eph-cm-right,.eph-tp.full .eph-tp-list{flex:1 1 auto;min-width:0;}   /* 全屏时列表/右栏别留空档 */
.eph-tp-hd-right{margin-left:auto;display:flex;align-items:center;gap:6px;}
.eph-tp-row input{flex:1 1 auto;min-width:0;font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:7px;padding:5px 9px;outline:none;background:#fff;color:#1a1f2b;}
.eph-tp-fur{display:flex;align-items:center;gap:4px;flex:0 0 auto;font-size:11px;color:#5f6b7a;cursor:pointer;white-space:nowrap;}
.eph-tp-fur input{width:12px;height:12px;margin:0;}
.eph-tp-split{display:flex;gap:10px;padding:0 12px 12px;flex:1 1 auto;min-height:0;}
.eph-tp-cats{flex:0 0 158px;overflow-y:auto;border-right:1px solid #eef2f8;padding-right:6px;}
.eph-tp-cat{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;font-size:12px;color:#1a1f2b;cursor:pointer;user-select:none;-webkit-user-select:none;}
.eph-tp-cat:hover{background:#f1f4fa;}
.eph-tp-cat.on{background:#eef2ff;color:#3730a3;font-weight:600;}
.eph-tp-cat.drop-before{box-shadow:inset 0 2px 0 #1a1a2e;}
.eph-tp-cat.drop-after{box-shadow:inset 0 -2px 0 #1a1a2e;}
.eph-tp-cat.drop-in{background:#e7f7ec;}
.eph-gen-sub{font-size:11px;color:#8a94a3;margin:0 0 10px;}
.eph-gen-sec{border:1px solid #eef2f8;border-radius:10px;padding:10px 12px;margin-bottom:10px;background:#fcfdff;}
.eph-gen-t{font-size:12px;font-weight:600;color:#2b3a4a;margin-bottom:4px;}
.eph-gen-note{font-size:11px;color:#a0aab8;margin-bottom:8px;line-height:1.5;}
.eph-gen-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.eph-gen-api{font-size:11px;color:#6b7a8e;flex:1 1 auto;min-width:120px;}
.eph-gen-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;}
.eph-gen-grid4{grid-template-columns:repeat(4,minmax(0,1fr));}
.eph-gen-f{display:flex;flex-direction:column;gap:3px;min-width:0;}
.eph-gen-lb{font-size:11px;color:#6b7a8e;}
.eph-gen-hint{font-size:10px;color:#a8b2c0;}
.eph-gen-in{font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:5px 8px;outline:none;background:#fff;color:#1a1f2b;box-sizing:border-box;min-width:0;}
.eph-gen-in:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(43,58,74,.06);}
.eph-tp-rename{flex:1 1 auto;min-width:0;font-family:inherit;font-size:12px;border:1px solid #64748b;border-radius:5px;padding:1px 5px;outline:none;background:#fff;color:#1a1f2b;}
.eph-tp-cat-nm{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.eph-tp-cat-n{flex:0 0 auto;margin-left:auto;font-size:10px;color:#8a94a8;}
.eph-tp-cat.on .eph-tp-cat-n{color:#6366f1;}
.eph-tp-list{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start;min-height:60px;padding-right:6px;box-sizing:border-box;}   /* 右侧留一点缝，别贴着滚动条 */
.eph-tp-list .eph-cm-tile{flex:0 0 auto;width:var(--tp-card-w,110px);max-width:none;min-width:0;}   /* 宽度由 tpCardWidth() 算成整除值 */
.eph-tp-page{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:0 0 auto;padding-top:6px;border-top:1px solid #eef2f8;font-size:12px;color:#5f6b7a;}
.eph-tp-page-l{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;overflow:hidden;justify-content:flex-end;margin-right:6px;}   /* 靠着右边的跳转，间距 6px */
.eph-tp-page-r{display:flex;align-items:center;gap:4px;flex:0 0 auto;margin-left:auto;}   /* 永远贴右下角 */
.eph-tp-page-l span{width:16px;text-align:center;color:#94a3b8;}
.eph-tp-page button{background:#fff;border:1px solid #dce3ec;border-radius:6px;min-width:28px;height:24px;font-size:12px;cursor:pointer;color:#334155;padding:0 4px;text-align:center;font-family:inherit;font-variant-numeric:tabular-nums;box-sizing:border-box;}
.eph-tp-page button:disabled{opacity:.4;cursor:default;}
.eph-tp-page button.active{background:#2b3a4a;border-color:#2b3a4a;color:#fff;}
.eph-tp-page input{width:46px;height:24px;border:1px solid #dce3ec;border-radius:6px;font-size:12px;text-align:center;outline:none;font-family:inherit;}
.eph-tp-page input[type=number]{-moz-appearance:textfield;appearance:textfield;}
.eph-tp-page input[type=number]::-webkit-inner-spin-button,.eph-tp-page input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
.eph-tgh{position:fixed;z-index:100100;display:none;width:max-content;min-width:180px;max-width:min(560px,92vw);max-height:260px;overflow-y:auto;background:#fff;border:1px solid #dce3ec;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.16);padding:4px;font-family:Inter,sans-serif;}
.eph-tgh.on{display:block;}
.eph-tgh-row{display:flex;align-items:baseline;gap:8px;padding:5px 8px;border-radius:7px;font-size:12px;color:#1a1f2b;cursor:pointer;white-space:nowrap;overflow:hidden;}
.eph-tgh-row:hover{background:#f1f4fa;}
.eph-tgh-row.on{background:#1a1a2e;color:#fff;}
.eph-tgh-en{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.eph-tgh-zh{flex:0 0 auto;margin-left:auto;padding-left:10px;color:#8a94a3;font-size:11px;max-width:55%;overflow:hidden;text-overflow:ellipsis;}
.eph-tgh-row.on .eph-tgh-zh{color:#c7cdd8;}
.eph-tag{display:inline-flex;align-items:center;gap:3px;background:#eef2ff;border:1px solid #c7d2fe;color:#3730a3;border-radius:6px;padding:0 4px;margin:0 1px;font-size:12px;user-select:none;-webkit-user-select:none;}
.eph-tag-x{cursor:pointer;color:#818cf8;font-weight:700;}
.eph-tag-x:hover{color:#e34d4d;}
.eph-cm-card{display:flex;align-items:flex-start;gap:8px;border:1px solid #eef2f8;border-radius:9px;padding:7px 9px;cursor:pointer;}
.eph-cm-card:hover{background:#f7f9fd;border-color:#dce3ec;}
.eph-cm-caret{flex:0 0 auto;width:14px;text-align:center;color:#8a94a3;cursor:pointer;user-select:none;-webkit-user-select:none;transition:transform .12s;font-size:11px;}
.eph-cm-caret.open{transform:rotate(90deg);}
.eph-cm-caret:hover{color:#1a1f2b;}
.eph-ext{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding-left:20px;}
.eph-ext-list{display:flex;flex-wrap:wrap;gap:4px;}
.eph-ext-chip{display:inline-flex;align-items:center;gap:4px;background:#eef2f8;border-radius:6px;padding:2px 6px;font-size:11px;color:#1a1f2b;}
.eph-ext-x{cursor:pointer;color:#8a94a3;font-weight:700;}
.eph-ext-x:hover{color:#e34d4d;}
.eph-cm-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;border-top:1px solid #eef2f8;padding-top:10px;}
.eph-cm-right{flex:1 1 auto;display:flex;flex-direction:column;gap:6px;min-width:0;}
.eph-cm-bbar{display:none;gap:6px;flex-wrap:wrap;}
.eph-cm-bbar.on{display:flex;}
.eph-cm-tools{display:flex;align-items:center;gap:6px;padding:0 0 8px;flex-wrap:wrap;}
.eph-cm-tools-l{flex:0 0 168px;display:flex;align-items:center;gap:6px;justify-content:space-between;padding:0 8px 0 0;min-width:0;}
.eph-cm-tools.collapsed .eph-cm-tools-l{flex:0 0 auto;}
.eph-cm-tbtns{display:flex;align-items:center;gap:6px;}
.eph-cm-mini{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;padding:0;border:none;border-radius:3px;background:transparent;color:#6b7a8e;cursor:pointer;}
.eph-cm-mini:hover{background:#f1f4fa;color:#1a1f2b;}
.eph-cm-cats .eph-cm-caret{width:12px;}
.eph-cm-foot .eph-cm-hint{flex:1 1 auto;min-height:0;background:transparent;padding:0;}
.eph-cm-tlabel{font-size:16px;font-weight:600;color:#1a1f2b;align-self:center;white-space:nowrap;}
.eph-cm-tools.collapsed .eph-cm-catctl{display:none;}
.eph-cm.full .eph-cm-box{width:100vw;height:100vh;max-width:100vw;max-height:100vh;border-radius:0;}
.eph-cm.full .eph-cm-split{height:calc(100vh - 180px);}
.eph-cm-pick{z-index:100010;}
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
    if (n.classList && n.classList.contains('eph-tag-x')) return;   // 芯片上的删除按钮不进正文
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
  // 引用写法一直跟随「参与编号的媒体类型」：被排除的类型不写进卡片规范（编译时缺键 = 原样保留标记）
  const onKinds = mediaTargetCfg().kinds || [];
  const onIds = onKinds.filter((k) => k.on).map((k) => k.id);
  const refAll = rule.ref || {};
  const ref = {};
  Object.keys(refAll).forEach((k) => { if (onIds.indexOf(k) >= 0) ref[k] = refAll[k]; });
  const labels = {};
  onKinds.forEach((k) => { labels[k.id] = mediaWord(k.id); });   // 自定义类型没有中文词，用类型名当 @ 词
  st.cards.forEach((c) => { c.rule = { ref: ref, ts: rule.ts || {}, labels: labels }; });
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
  id = _normRuleId(id);
  const base = hasGlobalRules() ? _rulesGlobal : ((readConfig(node, {}).rules) || {});
  _rulesGlobal = Object.assign({}, base, { ruleId: id });
  applyGlobalRules();
  persistGlobalRules();
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
  if (!card) return;
  if (_refBrowser && _refBrowser.classList.contains('active') && _refBrowser._card === card && _refBrowser._subEl) _refBrowser._subEl.textContent = refBrowserCardLabel(node, card);
  if (!_editModal || !_editModal.classList.contains('active') || _editModal._node !== node) return;
  if (!_editModal._titleEl || stateFor(node).editingId !== card.id) return;
  _editModal._titleEl.textContent = card.title || ezT('Edit prompt');
}
function buildCardRow(node, card, index) {
  const linked = !!(node._ezLinkedCards && node._ezLinkedCards[card.id]);
  const live = !!card.liveIn;
  // 「实时接收卡」即使接了 card_in 也不变灰（正文可编辑、以卡片内容为准）
  const row = el('div', 'eph-card' + (linked && !live ? ' linked' : '')); row.dataset.id = card.id;
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
  if (live) { const lb = el('span', 'eph-badge eph-badge-live'); lb.textContent = ezT('Live'); lb.title = ezT('Live-editable input card'); ctitle.appendChild(lb); }
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
    if (node._ezBatch) { batchPickCard(node, index, e.shiftKey, e.ctrlKey || e.metaKey); return; }
    if (_rowDown) { const dx = e.clientX - _rowDown.x, dy = e.clientY - _rowDown.y; if (Math.hypot(dx, dy) > 4) { _rowDown = null; return; } _rowDown = null; }
    openEditModal(node, card.id);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (node._ezBatch) { toggleBatchSel(node, card.id); return; }
    cmMenu(e.clientX, e.clientY, [
      [ezT('Save this card'), () => saveSingleCard(node, card)],
      [ezT('Edit card'), () => openEditModal(node, card.id)],
      [(card.liveIn ? '✓ ' : '') + ezT('Live-editable input card'), () => { card.liveIn = !card.liveIn; syncToConfig(node); refreshUI(node); }],
    ]);
  });
  if (node._ezBatch && batchSelIds(node).has(card.id)) row.classList.add('on');
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
  const insCardBtn = el('button', 'eph-btn'); insCardBtn.textContent = ezT('Card');
  insCardBtn.title = ezT('Insert saved card');   // 点一份存档 → 内容插到光标处（卡片组合成一块）
  insCardBtn.addEventListener('click', (e) => { e.stopPropagation(); saveSelection(); openCardMgr((_allModal && _allModal._node) || (_editModal && _editModal._node), editor); });
  const insTagBtn = el('button', 'eph-btn'); insTagBtn.textContent = ezT('Tag');
  insTagBtn.addEventListener('click', (e) => { e.stopPropagation(); saveSelection(); openTagPicker(editor, insTagBtn); });
  toolbar.appendChild(insCardBtn); toolbar.appendChild(insTagBtn);

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
  tgAttach(editor);
  toolbar.appendChild(skillButton(editor));
  // 「合」放在 skill 后面：绿=合并进「合并提示词」，灰=不进（例如这张卡片是负面提示词/备选）
  const mergeBtn = el('button', 'eph-merge-btn'); mergeBtn.type = 'button'; mergeBtn.textContent = ezT('Merge'); mergeBtn.title = ezT('Merge into "Merged prompt": green = merged, gray = not merged');
  const updMerge = () => { const c = sameNodeCard(_editModal && _editModal._node); mergeBtn.classList.toggle('on', !(c && c.mergeOff)); };
  mergeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nd = _editModal && _editModal._node; const c = sameNodeCard(nd); if (!nd || !c) return;
    c.mergeOff = !c.mergeOff; syncToConfig(nd); updMerge(); refreshUI(nd);   // 同步面板卡片列表上的「合」
  });
  // 随机 tag：自动（运行期每次排队重生成）/ 单点（立刻清空本卡再生成）—— 放在「合」前面
  const autoRandBtn = el('button', 'eph-merge-btn'); autoRandBtn.type = 'button'; autoRandBtn.textContent = ezT('Auto random tag');
  autoRandBtn.title = ezT('Runtime at queue: clear this card and regenerate it with random tags every time');
  const updAutoRand = () => { const c = sameNodeCard(_editModal && _editModal._node); autoRandBtn.classList.toggle('on', !!(c && c.autoRand)); };
  autoRandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nd = _editModal && _editModal._node; const c = sameNodeCard(nd); if (!nd || !c) return;
    c.autoRand = !c.autoRand; syncToConfig(nd); updAutoRand();   // 同步面板卡片列表
  });
  const randOnceBtn = el('button', 'eph-btn'); randOnceBtn.type = 'button'; randOnceBtn.textContent = ezT('Random tag');
  randOnceBtn.title = ezT('Clear this card and generate random tags once');
  randOnceBtn.addEventListener('click', (e) => { e.stopPropagation(); saveSelection(); tpRandomToEditor(editor); });
  toolbar.appendChild(autoRandBtn); toolbar.appendChild(randOnceBtn); toolbar.appendChild(mergeBtn);
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
  _editModal._ruleDD = ruleDD; _editModal._hintBtn = hintBtn; _editModal._updMerge = updMerge; _editModal._updAutoRand = updAutoRand;
  ft.appendChild(timeline);
  const cancelBtn = el('button', 'eph-btn eph-btn-cancel'); cancelBtn.textContent = ezT('Cancel');
  const saveBtn = el('button', 'eph-btn eph-btn-save'); saveBtn.textContent = ezT('Save');
  const ftBtns = el('div'); ftBtns.style.cssText = 'display:flex;gap:8px;';
  ftBtns.appendChild(cancelBtn); ftBtns.appendChild(saveBtn); ft.appendChild(ftBtns);

  box.appendChild(hd); box.appendChild(body); box.appendChild(ft);
  _editModal.appendChild(box); document.body.appendChild(_editModal);

  // 绑定
  close.addEventListener('click', () => closeEditModal(false));
  cancelBtn.addEventListener('click', () => closeEditModal(false));
  saveBtn.addEventListener('click', () => {
    if (_editModal.classList.contains('ph-dock')) { editModalCommit(); phTip(ezT('Saved')); return; }   // 平铺：存下但不关，标签/引用面板留着
    closeEditModal(true);
  });
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
  const toolsItems = [[ezT('Optimize prompt (API)'), 'optimize'], [ezT('Optimize prompt (TextGenerate)'), 'textgen'], [ezT('Optimize prompt (llama)'), 'llama'],
    [ezT('Find / Replace'), 'find'],
    [ezT('Hyphens to underscores'), 'dashToUnderscore'], [ezT('Underscores to hyphens'), 'underscoreToDash'],
    [ezT('Hyphens to spaces'), 'dashToSpace'], [ezT('Underscores to spaces'), 'underscoreToSpace'],
    [ezT('Full-width to half-width'), 'fullToHalf'], [ezT('Half-width to full-width'), 'halfToFull']];
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
  // 自动保存只在平铺模式：焦点离开编辑器就落盘（弹窗模式不自动存，点「取消」仍能丢弃）
  editor.addEventListener('focusout', () => { if (_editModal.classList.contains('ph-dock')) { try { editModalCommit(); } catch (_) {} } });
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
  if (_editModal && _editModal.classList.contains('active') && _editModal._node === node && st.editingId && st.editingId !== cardId) editModalCommit(node);   // 换卡前先把上一张存了
  st.editingId = cardId;
  const tab = card.editTab || 'default';   // 记住上次所选页签
    st.currentTab = tab;
  const m = editModalEl(); m._node = node;
  phDockSwitchTo(m);
  if (m._titleEl) m._titleEl.textContent = card.title || ezT('Edit prompt');
  if (tab === 'optimized') {
    m._tabOptimized.classList.add('active'); m._tabDefault.classList.remove('active');
    m._editor.innerHTML = ezSanitizeHtml(card.contentOptimizedHTML || card.contentOptimized || '');
    unwrapTagChips(m._editor);
  } else {
    m._tabDefault.classList.add('active'); m._tabOptimized.classList.remove('active');
    m._editor.innerHTML = ezSanitizeHtml(card.contentHTML || card.content || '');
    unwrapTagChips(m._editor);
  }
  if (m._ruleDD) { m._ruleDD.setItems(ruleDropdownItems(node, false)); m._ruleDD.value = _normRuleId(phRulesModel(node).ruleId) || 'none'; }
  if (m._updMerge) m._updMerge();
  if (m._updAutoRand) m._updAutoRand();
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
    _editModal._editor.innerHTML = ezSanitizeHtml(card.contentHTML || card.content || '');
    unwrapTagChips(_editModal._editor);
  } else {
    _editModal._tabOptimized.classList.add('active'); _editModal._tabDefault.classList.remove('active');
    _editModal._editor.innerHTML = ezSanitizeHtml(card.contentOptimizedHTML || card.contentOptimized || '');
    unwrapTagChips(_editModal._editor);
  }
  requestAnimationFrame(moveTabThumb);
  // 切页签会把编辑器内容整段换掉（光标跟着丢），跟打开弹窗一样把光标落回正文末尾
  try { applyIndent(_editModal._indentInput.value); _editModal._editor.focus(); caretToEditorEnd(_editModal._editor); } catch (_) {}
}
// 把当前编辑器内容写回正在编辑的那张卡（自动保存 / 保存按钮 / 关窗共用）
function editModalCommit(nd) {
  const m = _editModal;
  const n = nd || (m && m._node);
  if (!m || !n || !m._editor) return false;
  const st = stateFor(n);
  const card = st.cards.find((c) => c.id === st.editingId);
  if (!card) return false;
  const html = m._editor.innerHTML;
  const plain = plainTextOf(html);
  if (st.currentTab === 'optimized') { card.contentOptimizedHTML = html; card.contentOptimized = plain; }
  else { card.contentHTML = html; card.content = plain; }
  card.indent = parseFloat(m._indentInput.value) || 0;
  syncToConfig(n); refreshUI(n);
  return true;
}
function closeEditModal(save) {
  const nd = _editModal && _editModal._node;
  if (save && nd) {
    editModalCommit(nd);
    updatePorts(nd);
    stateFor(nd).editingId = null;
  }
  _phActiveEditor = null;
  _editModal && _editModal.classList.remove('active');
  try { closeTagPicker(); } catch (_) {}   // 卡片弹窗关了 → 挂在它上面的插入标签面板一起收
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
  out.forEach((b) => {
    // 空段落垫一个 <br>：contenteditable 里没有行盒时 text-indent 不生效，光标会跑到最左边（得先打一个字才缩进）
    if (!String(b.textContent || '').trim() && !b.querySelector('br')) b.appendChild(document.createElement('br'));
    ed.appendChild(b);
  });
  if (!out.length) {   // 编辑器整个是空的：垫一个带缩进的空块，光标才落在缩进位置上
    const b = document.createElement('div');
    if (n) b.style.textIndent = n + 'em';
    b.appendChild(document.createElement('br'));
    ed.appendChild(b);
  }
  if (_editModal._indentInput && _editModal._indentInput.value !== String(n)) _editModal._indentInput.value = String(n);
  ed.focus();
  try { caretToEditorEnd(ed); } catch (_) {}
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
// 无选区时的高亮/上色：给作用域里**每个文本节点**包一个 span（和选中时同一套写法）——
// 不动块结构、逐行都看得见，壳落在 body.innerHTML 里，能随卡片内容一起保存。
function _wrapTextRuns(scope, prop, color, key) {
  if (!scope) return;
  const texts = [];
  const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
  while (w.nextNode()) {
    const t = w.currentNode;
    if (!t.nodeValue || !t.nodeValue.length) continue;
    const pe0 = t.parentElement;
    if (pe0 && pe0.closest && pe0.closest('.eph-mref,[contenteditable="false"]')) continue;   // 引用媒体芯片里的字不碰
    texts.push(t);
  }
  texts.forEach((t) => {
    const pe = t.parentElement;
    // 已经包过壳、且壳里没有块元素（块元素在里面背景色不显）→ 直接改这层壳的颜色
    const reuse = pe && pe.dataset && pe.dataset.wr === key
      && !Array.from(pe.children).some((c) => /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TABLE)$/.test(c.tagName));
    if (reuse) { pe.style[prop] = color; return; }
    const sp = document.createElement('span'); sp.dataset.wr = key; sp.style[prop] = color;
    try { t.replaceWith(sp); sp.appendChild(t); } catch (_) {}
  });
}
// 清一处高亮：抹掉内联背景色；若是自己包的壳、且再没别的样式，就把壳拆掉（别在正文里留一堆空 span）
function _clearHl(sp) {
  try {
    if (!(sp.style && sp.style.backgroundColor)) return;
    sp.style.backgroundColor = '';
    if (sp.dataset && sp.dataset.wr && !sp.getAttribute('style')) sp.replaceWith(...sp.childNodes);
  } catch (_) {}
}
// 颜色/高亮作用到「当前编辑器」：总体编辑 = 每张卡片正文，卡片弹窗 = 整个编辑器。
// 有选区只动选区；**没选中就整块生效**（所有卡片的所有文字）。清除高亮走同一套判定。
function applyColorOn(ed, target, color) {
  if (!ed) return;
  const prop = target === 'highlight' ? 'backgroundColor' : 'color';
  const clear = (target === 'highlight') && (color === 'transparent' || color === '');
  const sel = window.getSelection();
  const hasSel = !!(sel.rangeCount && !sel.isCollapsed && ed.contains(sel.getRangeAt(0).commonAncestorContainer));
  const bodies = ed.querySelectorAll ? Array.from(ed.querySelectorAll('.eph-all-block-body')) : [];
  const scopes = bodies.length ? bodies : [ed];   // 总体编辑 = 每张卡片正文；卡片弹窗 = 整段
  if (clear) {
    if (hasSel) {
      const range = sel.getRangeAt(0);
      let root = range.commonAncestorContainer;
      if (root && root.nodeType !== 1) root = root.parentElement;
      const hit = new Set();
      const self = (root && root.closest) ? root.closest('span,font,[data-wr]') : null;   // 整段被包在一个壳里时，壳本身也要算
      if (self) hit.add(self);
      if (root && root.querySelectorAll) root.querySelectorAll('span,font,[data-wr]').forEach((sp) => { try { if (range.intersectsNode(sp)) hit.add(sp); } catch (_) {} });
      hit.forEach(_clearHl);
    } else {
      scopes.forEach((sc) => { sc.querySelectorAll('span,font,[data-wr]').forEach(_clearHl); });   // 没选中 → 清掉所有卡片的高亮
    }
    ed.focus();
    return;
  }
  ed.focus();
  // ── 有选区：只改选区 ──
  if (hasSel) {
    const range = sel.getRangeAt(0);
    const sp = document.createElement('span'); sp.style[prop] = color;
    try { const frag = range.extractContents(); sp.appendChild(frag); range.insertNode(sp); } catch (_) {}
    sel.removeAllRanges();
    return;
  }
  // ── 没选中：整块生效（总体编辑 = 所有卡片的正文；卡片弹窗 = 整段文字） ──
  scopes.forEach((sc) => _wrapTextRuns(sc, prop, color, prop));
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
  // 只换这一个符号
  if (id === 'dashToUnderscore') { ed.textContent = text.replace(/-/g, '_'); saveSelection(); return; }
  if (id === 'underscoreToDash') { ed.textContent = text.replace(/_/g, '-'); saveSelection(); return; }
  if (id === 'dashToSpace') { ed.textContent = text.replace(/-/g, ' '); saveSelection(); return; }
  if (id === 'underscoreToSpace') { ed.textContent = text.replace(/_/g, ' '); saveSelection(); return; }
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
  const sub = el('span', 'eph-rb-sub');
  const close = el('button', 'eph-modal-close'); close.textContent = '✕'; close.style.marginLeft = 'auto';
  hd.appendChild(t); hd.appendChild(sub); hd.appendChild(close);
  const body = el('div', 'eph-rb-body');
  box.appendChild(hd); box.appendChild(body);
  _refBrowser.appendChild(box); document.body.appendChild(_refBrowser);
  _refBrowser._box = box; _refBrowser._body = body; _refBrowser._subEl = sub;
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
// 引用浏览器标题里标出"当前是哪张卡"（序号 + 标题），换标题时实时跟着变
function refBrowserCardLabel(node, card) {
  const st = node ? stateFor(node) : null;
  const idx = (st && card) ? st.cards.indexOf(card) : -1;
  return (idx >= 0 ? '#' + (idx + 1) : '') + (card && card.title ? (idx >= 0 ? ' · ' : '') + card.title : '');
}
function renderRefBrowser(node, ed, card) {
  const m = refBrowserEl();
  if (m._building) return;   // 防重入：refreshIndexNow 会同步通知监听者回调本函数，只用外层那次的结果
  m._building = true;
  try {
  m._node = node; m._ed = ed; m._card = card;
  if (m._subEl) m._subEl.textContent = refBrowserCardLabel(node, card);
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
      if (_editModal) { _editModal._editor.innerHTML = ezSanitizeHtml(card.contentOptimizedHTML); unwrapTagChips(_editModal._editor); }
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
    // 以前这一格只画了没接事件 → 点了没反应（清除高亮失效）。与 colorItem 同一套写法。
    noColor.addEventListener('mousedown', (e) => e.preventDefault());
    noColor.addEventListener('click', (e) => { e.stopPropagation(); applyColor(target, 'transparent'); if (dd) dd.classList.remove('active'); });
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
  trigger.addEventListener('mousedown', (e) => {
    if (e.button !== 0) { close(); return; }   // 只有左键开合下拉：右键留给自己的上下文菜单（别同时弹两个）
    e.preventDefault(); e.stopPropagation();
    menu.classList.contains('active') ? close() : open();
  });
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
  // 直接点 On / Off：显式改 checked 再派发 change（preventDefault 掉 label 的隐式切换，否则会二次翻转）
  const pick = (v) => (e) => { e.preventDefault(); if (cb.checked === v) return; cb.checked = v; upd(); cb.dispatchEvent(new Event('change', { bubbles: true })); };
  onS.addEventListener('click', pick(true));
  offS.addEventListener('click', pick(false));
  cb.addEventListener('change', upd); upd(); cb._upd = upd; l._upd = upd; l._cb = cb;
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

  // ---- 引用规则设置：提示词规范表（下拉选择 / 新建自定义 / 保存 / 删除 + 下方信息）----
  const grid1r = el('div', 'eph-settings-grid');
  // 「引用 XX」输入框一直跟随「参与编号的媒体类型」：默认三项（图/视/音）停用就变灰，启用的其它类型自动补一行（小标题 = 类型名）。
  const enabledKinds = () => {
    try { const mt = _settingsModal && _settingsModal._grid1x && _settingsModal._grid1x._mt; if (mt && mt.lists && mt.lists.kinds) return mt.lists.kinds.get().filter((k) => k.on).map((k) => k.id); } catch (_) {}
    return ['image', 'video', 'audio'];
  };
  const buildRefRows = () => {
    const onIds = enabledKinds();
    const shown = ['image', 'video', 'audio'].concat(onIds.filter((k) => k !== 'image' && k !== 'video' && k !== 'audio'));
    const seen = new Set();
    rfWrap.innerHTML = ''; Object.keys(rf).forEach((k) => delete rf[k]);
    shown.forEach((id) => {
      if (seen.has(id)) return; seen.add(id);
      const inp = mkIn(KIND_PH[id] || '');   // 只有默认几项带示例 placeholder，自定义类型留空
      const off = onIds.indexOf(id) < 0;
      inp.readOnly = off; inp.style.opacity = off ? '.45' : '';
      inp.value = refVals[id] || '';
      inp.addEventListener('input', () => { refVals[id] = inp.value; });
      rField(rfWrap, refLabelOf(id), inp);
      rf[id] = inp;
    });
  };
  const applyKindLocks = () => { buildRefRows(); };
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
  const rfWrap = el('div'); rfWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;'; rg.appendChild(rfWrap);
  const mkIn = (ph) => { const i = el('input'); i.placeholder = ph; return i; };
  const rf = {}; let refVals = {};
  const KIND_PH = { image: ezT('e.g. <Picture {n}>'), video: ezT('e.g. <Video {n}>'), audio: ezT('e.g. <Audio {n}>'), model: ezT('e.g. <Model {n}>') };
  const refLabelOf = (id) => {
    if (id === 'image') return ezT('Image ref');
    if (id === 'video') return ezT('Video ref');
    if (id === 'audio') return ezT('Audio ref');
    if (id === 'model') return ezT('3D ref');
    return ezT('ref') + ' ' + id;   // 自定义类型：引用在前，类型名在后
  };
  const rTpl = mkIn(ezT('start start time · end end time · dur duration · S shot no. · M time · text body'));
  setTip(rTpl, ezT('Time rule template: only placeholders written in the template take effect.\n{start} start time (s)\n{end} end time (s)\n{dur} duration (s; blank = end - start)\n{S} shot number\n{M} time (seconds auto-convert to 00:03.500)\n{text} card body (filled automatically, no need to enter)\nLeave the whole thing blank = this spec has no timestamp.'));
  const rNote = el('textarea');
  const rField = (host, labelText, node) => { const l = el('label'); l.appendChild(el('span')).textContent = labelText; l.appendChild(node); host.appendChild(l); return l; };
  rField(rg, ezT('Time rule'), rTpl);
  rField(rg, ezT('Rule hint'), rNote);
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
    refVals = {};
    Object.keys(ref).forEach((k) => { refVals[k] = String(ref[k] || ''); });
    rTpl.value = ts.tpl || '';
    rNote.value = rule.note || '';
    rName.value = isNew ? '' : (rule.label || '');
    const builtin = !!(raw && _BUILTIN_RULE_IDS.includes(raw.id));
    const changed = builtin && !!grid1r._state.overrides[raw.id];
    [rTpl, rNote, rName].forEach((i) => { i.readOnly = false; });
    rSave.disabled = false; rDel.disabled = builtin ? !changed : false;
    rDel.textContent = builtin ? ezT('Restore default') : ezT('Delete spec');
    rLangWrap.innerHTML = '';
    if (raw && raw.alt) {   // 这条规范有中英两版 → 显示切换
      rLangWrap.appendChild(mkLangToggle(grid1r._state.editLang, (k) => { grid1r._state.editLang = k; grid1r._state.lang = k; rSetEditing(raw, false); }));
    } else {
      grid1r._state.editLang = 'zh';
    }
    applyKindLocks();
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
    Object.keys(refVals).forEach((k) => { const v = String(refVals[k] || '').trim(); if (v) ref[k] = v; });   // 留空 = 不写规则，原样保留标记（实际输出再按参与编号的媒体过滤）
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

  // ---- 引用识别设置：列表式管理（默认值列在列表里，可增删 / 恢复默认）；穿透只有一行数量 ----
  const grid1x = el('div', 'eph-settings-grid');
  const mtDef = mediaTargetDefaults();
  const mtList = (labelText, defaults) => {
    const row = el('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const sp = el('span'); sp.style.cssText = 'flex:1 1 auto;font-size:11px;color:#5f6b7a;'; sp.textContent = labelText;
    const cnt = el('span'); cnt.style.cssText = 'font-size:11px;color:#8a94a3;';
    const open = el('button', 'eph-btn'); open.type = 'button'; open.textContent = ezT('Open editor');
    row.appendChild(sp); row.appendChild(cnt); row.appendChild(open);
    grid1x.appendChild(row);
    let items = defaults.slice();
    let dlg = null, listEl = null, onChange = null;
    const sync = () => { cnt.textContent = items.length + ' ' + ezT('entries'); };
    const notify = () => { if (onChange) { try { onChange(); } catch (_) {} } };
    const render = () => {
      if (!listEl) { sync(); return; }
      listEl.innerHTML = '';
      items.forEach((v, i) => {
        const r = el('div'); r.style.cssText = 'display:flex;align-items:center;gap:2px;';
        const inp = el('input'); inp.type = 'text'; inp.value = v;
        inp.style.cssText = 'font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:4px 7px;outline:none;background:#fff;color:#1a1f2b;flex:0 1 92px;min-width:0;';
        inp.addEventListener('input', () => { items[i] = inp.value.trim(); });
        const del = el('button', 'eph-btn danger'); del.type = 'button'; del.textContent = '−'; del.title = ezT('Delete this entry');
        del.style.cssText = 'flex:0 0 auto;padding:3px 8px;line-height:1;';
        del.addEventListener('click', () => { items.splice(i, 1); render(); notify(); });
        r.appendChild(inp); r.appendChild(del); listEl.appendChild(r);
      });
      sync();
    };
    const close = () => { if (dlg) dlg.style.display = 'none'; };
    const openEditor = () => {
      if (!dlg) {
        dlg = el('div'); dlg.style.cssText = 'position:fixed;inset:0;z-index:100090;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;';
        const box = el('div'); box.style.cssText = 'width:min(430px,92vw);max-height:70vh;background:#fff;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;font-family:Inter,sans-serif;';
        const hd = el('div'); hd.style.cssText = 'display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #eef2f8;';
        const tt = el('b'); tt.style.cssText = 'flex:1 1 auto;font-size:13px;color:#1a1f2b;'; tt.textContent = labelText;
        const rs = el('button', 'eph-btn'); rs.type = 'button'; rs.textContent = ezT('Restore default');
        const ad = el('button', 'eph-btn'); ad.type = 'button'; ad.textContent = ezT('+ Add');
        const x = el('button', 'eph-modal-close'); x.type = 'button'; x.textContent = '✕';
        hd.appendChild(tt); hd.appendChild(rs); hd.appendChild(ad); hd.appendChild(x);
        const body = el('div'); body.style.cssText = 'padding:12px 14px;overflow:auto;';
        listEl = el('div'); listEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;'; body.appendChild(listEl);
        const ft = el('div'); ft.style.cssText = 'padding:10px 14px;border-top:1px solid #eef2f8;display:flex;justify-content:flex-end;';
        const done = el('button', 'eph-btn eph-btn-save'); done.type = 'button'; done.textContent = ezT('Done');
        ft.appendChild(done);
        box.appendChild(hd); box.appendChild(body); box.appendChild(ft); dlg.appendChild(box); document.body.appendChild(dlg);
        x.addEventListener('click', close); done.addEventListener('click', close);
        dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(); });
        ad.addEventListener('click', () => { items.push(''); render(); const last = listEl.lastChild; if (last && last.firstChild) { try { last.firstChild.focus(); } catch (_) {} } notify(); });
        rs.addEventListener('click', () => { items = defaults.slice(); render(); notify(); });
      }
      render();
      dlg.style.display = 'flex';
    };
    open.addEventListener('click', openEditor);
    sync();
    return {
      get: () => items.map((v) => String(v).trim()).filter(Boolean),
      set: (arr) => { items = (arr || []).map((v) => String(v == null ? '' : v)); render(); sync(); },
      set onChange(fn) { onChange = fn; },
    };
  };
  // 媒体类型编辑器：每行 = 类型名 + 开/禁 + 展开后的「识别格式（扩展名）」。开关决定编号与引用规则里那一项是否生效。
  const MT_IN_CSS = 'font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:4px 7px;outline:none;background:#fff;color:#1a1f2b;min-width:0;';
  const mtKindList = (labelText, defaults) => {
    const row = el('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const sp = el('span'); sp.style.cssText = 'flex:1 1 auto;font-size:11px;color:#5f6b7a;'; sp.textContent = labelText;
    const cnt = el('span'); cnt.style.cssText = 'font-size:11px;color:#8a94a3;';
    const open = el('button', 'eph-btn'); open.type = 'button'; open.textContent = ezT('Open editor');
    row.appendChild(sp); row.appendChild(cnt); row.appendChild(open);
    grid1x.appendChild(row);
    const clone = (arr) => (arr || []).map((k) => ({ id: String(k.id || ''), exts: (k.exts || []).slice(), on: k.on !== false, open: false }));
    let items = clone(defaults);
    let dlg = null, listEl = null, onChange = null;
    const sync = () => { cnt.textContent = items.filter((k) => k.on).length + '/' + items.length + ' ' + ezT('entries'); };
    const notify = () => { if (onChange) { try { onChange(); } catch (_) {} } };
    const render = () => {
      if (!listEl) { sync(); return; }
      listEl.innerHTML = '';
      items.forEach((it, i) => {
        const box = el('div'); box.style.cssText = 'display:flex;flex-direction:column;gap:4px;border:1px solid #eef2f8;border-radius:9px;padding:6px 8px;';
        const line = el('div'); line.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const caret = el('span', 'eph-cm-caret' + (it.open ? ' open' : '')); caret.innerHTML = CM_CARET; caret.title = ezT('Expand');
        const name = el('input'); name.type = 'text'; name.value = it.id; name.placeholder = ezT('type name');
        name.style.cssText = MT_IN_CSS + 'flex:0 1 110px;';
        const spacer = el('span'); spacer.style.cssText = 'flex:1 1 auto;';
        const sw = segSwitch(''); sw.style.cssText = 'flex:0 0 auto;padding:0;';
        const swLab = sw.querySelector('.eph-sw-label'); if (swLab) swLab.style.display = 'none';
        sw._cb.checked = !!it.on; sw._upd && sw._upd();
        const del = el('button', 'eph-btn danger'); del.type = 'button'; del.textContent = '−'; del.title = ezT('Delete this entry');
        del.style.cssText = 'flex:0 0 auto;padding:3px 8px;line-height:1;';
        line.appendChild(caret); line.appendChild(name); line.appendChild(spacer); line.appendChild(sw); line.appendChild(del);
        // 识别的扩展名：每个一个小标签（× 删），输入框回车/逗号/空格新增
        const exts = el('div', 'eph-ext'); exts.style.display = it.open ? '' : 'none';
        const chipList = el('span', 'eph-ext-list');
        (it.exts || []).forEach((e, ei) => {
          const chip = el('span', 'eph-ext-chip'); chip.textContent = '.' + e;
          const x = el('b', 'eph-ext-x'); x.textContent = '×'; x.title = ezT('Delete this entry');
          x.addEventListener('click', () => { it.exts.splice(ei, 1); render(); notify(); });
          chip.appendChild(x); chipList.appendChild(chip);
        });
        const extsIn = el('input'); extsIn.type = 'text'; extsIn.placeholder = ezT('Add extension');
        extsIn.style.cssText = MT_IN_CSS + 'flex:0 1 110px;';
        extsIn.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ',' && e.key !== ' ') return;
          e.preventDefault();
          const v = extsIn.value.replace(/^\.+/, '').trim().toLowerCase();
          if (v && (it.exts || []).indexOf(v) < 0) { it.exts = it.exts || []; it.exts.push(v); }
          extsIn.value = '';
          render(); notify();
        });
        exts.appendChild(chipList); exts.appendChild(extsIn);
        caret.addEventListener('click', () => { it.open = !it.open; render(); });
        name.addEventListener('input', () => { it.id = name.value.trim(); notify(); });
        sw._cb.addEventListener('change', () => { it.on = sw._cb.checked; sync(); notify(); });
        del.addEventListener('click', () => { items.splice(i, 1); render(); notify(); });
        box.appendChild(line); box.appendChild(exts); listEl.appendChild(box);
      });
      sync();
    };
    const close = () => { if (dlg) dlg.style.display = 'none'; };
    const openEditor = () => {
      if (!dlg) {
        dlg = el('div'); dlg.style.cssText = 'position:fixed;inset:0;z-index:100090;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;';
        const box = el('div'); box.style.cssText = 'width:min(460px,92vw);max-height:70vh;background:#fff;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;font-family:Inter,sans-serif;';
        const hd = el('div'); hd.style.cssText = 'display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #eef2f8;';
        const tt = el('b'); tt.style.cssText = 'flex:1 1 auto;font-size:13px;color:#1a1f2b;'; tt.textContent = labelText;
        const rs = el('button', 'eph-btn'); rs.type = 'button'; rs.textContent = ezT('Restore default');
        const ad = el('button', 'eph-btn'); ad.type = 'button'; ad.textContent = ezT('+ Add');
        const x = el('button', 'eph-modal-close'); x.type = 'button'; x.textContent = '✕';
        hd.appendChild(tt); hd.appendChild(rs); hd.appendChild(ad); hd.appendChild(x);
        const body = el('div'); body.style.cssText = 'padding:12px 14px;overflow:auto;';
        listEl = el('div'); listEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;'; body.appendChild(listEl);
        const ft = el('div'); ft.style.cssText = 'padding:10px 14px;border-top:1px solid #eef2f8;display:flex;justify-content:flex-end;';
        const done = el('button', 'eph-btn eph-btn-save'); done.type = 'button'; done.textContent = ezT('Done');
        ft.appendChild(done);
        box.appendChild(hd); box.appendChild(body); box.appendChild(ft); dlg.appendChild(box); document.body.appendChild(dlg);
        x.addEventListener('click', close); done.addEventListener('click', close);
        dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(); });
        ad.addEventListener('click', () => { items.push({ id: '', exts: [], on: true, open: true }); render(); const last = listEl.lastChild; const inp = last && last.firstChild && last.firstChild.children[1]; if (inp) { try { inp.focus(); } catch (_) {} } notify(); });
        rs.addEventListener('click', () => { items = clone(defaults); render(); notify(); });
      }
      render();
      dlg.style.display = 'flex';
    };
    open.addEventListener('click', openEditor);
    sync();
    return {
      get: () => items.filter((k) => k.id).map((k) => ({ id: k.id, exts: (k.exts || []).slice(), on: !!k.on })),
      set: (arr) => {
        const src = Array.isArray(arr) ? arr : [];
        items = src.map((k) => {
          if (typeof k === 'string') { const d = defaults.find((x) => x.id === k); return { id: k, exts: d ? d.exts.slice() : [], on: true, open: false }; }
          const id = String((k && k.id) || ''); const d = defaults.find((x) => x.id === id);
          return { id: id, exts: (((k && k.exts) || (d ? d.exts : [])) || []).slice(), on: !(k && k.on === false), open: false };
        });
        render(); sync();
      },
      set onChange(fn) { onChange = fn; },
    };
  };
  secTitle(grid1x, ezT('Target node recognition'));
  const mtLists = {
    targetTypes: mtList(ezT('Generator node types'), mtDef.targetTypes),
    ignoreTypes: mtList(ezT('Ignored node types'), mtDef.ignoreTypes),
    targetPorts: mtList(ezT('Numbered input ports'), mtDef.targetPorts),
    ignorePorts: mtList(ezT('Ignored input ports'), mtDef.ignorePorts),
    kinds: mtKindList(ezT('Media types that take part'), mtDef.kinds),
  };
  mtLists.kinds.onChange = applyKindLocks;
  const mtNF = makeDropdown([
    { value: 'name', label: ezT('Port name first (default)') },
    { value: 'decl', label: ezT('Declared socket type first') },
  ]);
  fld2(grid1x, ezT('Media port type detection'), mtNF.el);
  secTitle(grid1x, ezT('Media sources (upstream)'));
  mtLists.ignoreSources = mtList(ezT('Ignore media source node types'), mtDef.ignoreSources);
  const mtDepth = el('input'); mtDepth.type = 'number'; mtDepth.min = '0'; mtDepth.max = '8'; mtDepth.step = '1';
  fld2(grid1x, ezT('Relay node limit (0 = no passthrough)'), mtDepth);
  grid1x._mt = { lists: mtLists, nameFirst: mtNF, depth: mtDepth };
  grid1x._fill = (mt) => {
    const d = mediaTargetDefaults();
    const v = (mt && typeof mt === 'object') ? mt : {};
    Object.keys(mtLists).forEach((k) => { mtLists[k].set(Array.isArray(v[k]) ? v[k] : d[k]); });
    mtDepth.value = String(v.relayDepth === undefined || v.relayDepth === null || v.relayDepth === '' ? d.relayDepth : v.relayDepth);
    mtNF.value = (v.nameFirst === false) ? 'decl' : 'name';
  };
  grid1x._fill(null);
  pane.appendChild(grid1x);

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
  const persistMode = (m) => { if (!_settingsNode) return; const cfg = readConfig(_settingsNode, {}); const opt = (cfg.optimize && typeof cfg.optimize === 'object') ? cfg.optimize : {}; opt.customMode = (m === 'custom'); writeConfig(_settingsNode, Object.assign({}, cfg, { optimize: opt })); };
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

  // ---- 其他设置：卡片合并分隔符号 ----
  const grid5 = el('div', 'eph-settings-grid');
  const sepIn = el('input'); sepIn.type = 'text'; sepIn.value = '\\n'; grid5._sep = sepIn;
  fld2(grid5, ezT('Card merge separator'), sepIn,
    ezT('When "Merge prompts" joins card bodies into one paragraph, this separator is inserted between cards.\nDefault \\n = newline; \\n\\n = blank line; you can also enter custom text such as ", " or "---".\nIn the box, \\n (newline) / \\t (tab) are treated as real control characters; blank = newline.'));
  pane.appendChild(grid5);

  const navItems = [['general', ezT('Call settings'), grid0], ['rules', ezT('Reference rule settings'), grid1r], ['recognize', ezT('Reference recognition'), grid1x], ['api', ezT('API settings'), grid1], ['textgen', ezT('TextGenerate settings'), grid2], ['llama', ezT('llama settings'), grid3], ['paths', ezT('Path settings'), grid4], ['other', ezT('Other settings'), grid5]];
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
  _settingsModal._grid2 = grid2; _settingsModal._grid3 = grid3; _settingsModal._grid0 = grid0; _settingsModal._grid4 = grid4; _settingsModal._grid1r = grid1r; _settingsModal._grid1 = grid1; _settingsModal._grid1x = grid1x; _settingsModal._grid5 = grid5;
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
  // 引用识别设置：目标识别 / 素材来源 / 穿透；引用规则设置：提示词规范表；其他设置：卡片合并分隔符
  await loadGlobalMediaTarget();
  await loadGlobalRules();
  const rules = hasGlobalRules() ? _rulesGlobal : phRulesModel(node);   // 全局规则优先；全局还没存过就用本节点旧的（保存一次即提升为全局）
  if (m._grid1x && m._grid1x._fill) m._grid1x._fill(_mediaTargetGlobal || {});   // 规范里的媒体锁要先知道参与识别的媒体
  const gr = m._grid1r;
  gr._fill(rules.ruleId, rules.custom, rules.overrides, rules.lang);
  if (m._grid5 && m._grid5._sep) m._grid5._sep.value = (rules.mergeSep === undefined || rules.mergeSep === null || rules.mergeSep === '') ? '\\n' : String(rules.mergeSep);
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
    mergeSep: (m._grid5 && m._grid5._sep) ? m._grid5._sep.value : '\\n',
    ruleId: m._grid1r._getRuleId(),
    custom: m._grid1r._getCustom(),
    overrides: m._grid1r._getOverrides(),
    lang: m._grid1r._getLang(),
  };
  _rulesGlobal = deepClone(st.rules);   // 引用规则改成全局：存 userdata，铺到所有 PromptHelper 节点
  persistGlobalRules();
  if (m._grid1x && m._grid1x._mt) {
    const x = m._grid1x._mt;
    const depthRaw = String(x.depth.value).trim();
    const mtCfg = { nameFirst: x.nameFirst.value !== 'decl', relayDepth: depthRaw === '' ? mediaTargetDefaults().relayDepth : parseFloat(depthRaw) };
    Object.keys(x.lists).forEach((k) => { mtCfg[k] = x.lists[k].get(); });
    _mediaTargetGlobal = mtCfg;
    setMediaTargetCfg(mtCfg);
    // 存全局 userdata：换节点 / 删节点 / 重启都还在
    try {
      fetchApi('/prompt_helper/media_target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaTarget: mtCfg }) })
        .then((r) => { if (r && r.ok === false) phTip(ezT('Failed to save the media-recognition settings: ') + 'HTTP ' + r.status); })
        .catch((e) => phTip(ezT('Failed to save the media-recognition settings: ') + (e && e.message ? e.message : e)));
    } catch (_) {}
  }
  syncToConfig(_settingsNode);
  syncRuleUI(_settingsNode, st.rules.ruleId);   // 卡片弹窗 / 总体编辑的规范下拉跟着一致
  applyGlobalRules();                            // 其它 PromptHelper 节点也换成同一份全局规则
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
  Object.keys(_LL_DEFAULTS).forEach((k) => { const inp = m._grid3._ll && m._grid3._ll[k]; if (!inp) return; if (inp.type === 'checkbox') { inp.checked = !!_LL_DEFAULTS[k]; inp._upd && inp._upd(); } else inp.value = String(_LL_DEFAULTS[k]); });
  if (m._grid1 && m._grid1._ap) { const g = m._grid1._ap; const d = _API_PARAMS_DEFAULTS; g.temperature.value = String(d.temperature); g.top_p.value = d.top_p; g.max_tokens.value = d.max_tokens; g.seed.value = d.seed; g.stop.value = d.stop; g.reasoning.value = d.reasoning; g.custom.value = ''; g.webSearch.checked = d.webSearch; g.webSearch._upd && g.webSearch._upd(); }
  m._provSel.value = 'OpenAI'; m._setModels();
  m._setCustomSelected(null); if (m._clearCustomFields) m._clearCustomFields(); if (m._customDD) m._customDD.value = ''; if (m._renderCustomDD) m._renderCustomDD();
  if (m._grid1x && m._grid1x._fill) m._grid1x._fill(mediaTargetDefaults());
  if (m._grid1r) m._grid1r._reset();
  if (m._grid5 && m._grid5._sep) m._grid5._sep.value = '\\n';
}

// ===== 引用识别设置：全局用户设置（存 userdata，换节点 / 删节点都不丢；所有 PromptHelper 共用）=====
let _mediaTargetGlobal = {};
let _mediaTargetPromise = null;
function loadGlobalMediaTarget() {
  if (!_mediaTargetPromise) _mediaTargetPromise = (async () => {
    try {
      const r = await fetchApi('/prompt_helper/media_target');
      const d = await r.json().catch(() => ({}));
      _mediaTargetGlobal = (d && typeof d.mediaTarget === 'object' && d.mediaTarget) ? d.mediaTarget : {};
      setMediaTargetCfg(_mediaTargetGlobal);
    } catch (_) { _mediaTargetGlobal = {}; }
    return _mediaTargetGlobal;
  })();
  return _mediaTargetPromise;
}

// ===== 引用规则设置：同样是全局用户设置（存 userdata；换节点 / 删节点不丢，所有 PromptHelper 共用）=====
// 节点 config 里仍会写一份镜像 —— 后端执行时 parse_prompt_rules(config) 要读合并分隔符与选中的规范。
let _rulesGlobal = {};
let _rulesPromise = null;
function hasGlobalRules() { return _rulesGlobal && Object.keys(_rulesGlobal).length > 0; }
function persistGlobalRules() {
  try { fetchApi('/prompt_helper/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: _rulesGlobal }) }).catch(() => {}); } catch (_) {}
}
function applyGlobalRules() {
  if (!hasGlobalRules()) return;
  const g = app && app.graph; const ns = (g && (g._nodes || g.nodes)) || [];
  const id = _normRuleId(_rulesGlobal.ruleId || 'none');
  ns.forEach((n) => {
    if (nodeTypeOf(n) !== NODE) return;
    try { const st = stateFor(n); st.rules = deepClone(_rulesGlobal); syncToConfig(n); updatePorts(n); refreshUI(n); } catch (_) {}
  });
  syncRuleUI(null, id);
}
function loadGlobalRules() {
  if (!_rulesPromise) _rulesPromise = (async () => {
    try {
      const r = await fetchApi('/prompt_helper/rules');
      const d = await r.json().catch(() => ({}));
      _rulesGlobal = (d && typeof d.rules === 'object' && d.rules) ? d.rules : {};
    } catch (_) { _rulesGlobal = {}; }
    applyGlobalRules();
    return _rulesGlobal;
  })();
  return _rulesPromise;
}

// ===== 卡片管理：把提示词卡片存成 userdata/prompts 下的一份 JSON，按名称加载 / 删除 =====
const CARDS_API = '/prompt_helper/prompt_cards';
const CATS_API = '/prompt_helper/prompt_categories';
let _cardMgr = null;
let _cmSaved = [];        // 已保存的卡片 / 卡片组 [{name,count,kind,category}]
let _cmCats = [];         // 分类树 [{id,name,children:[]}]
let _cmCatId = '';        // 选中的分类（'' = 全部）
const CM_ALL = '__all__';  // 分类栏最上面的「全部」（不是真实分类）
let _cmSideHidden = false;     // 分类栏收起
let _cmCatMode = 'tree';       // 分类栏：tree / list（同 ModelsCombo）
let _cmSearchQ = '', _cmSearchScope = 'all';   // 搜索：all / name / title / content
let _cmCardCache = new Map();  // 已保存条目 → 它的卡片（搜索标题/内容、方块预览用）
// 树里的展开箭头：细线条 chevron（比 ▸ 字符现代、对齐也稳）
const CM_CARET = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const CM_ICONS = {
  tree: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="3" width="6" height="4" rx="1"/><rect x="15" y="3" width="6" height="4" rx="1"/><rect x="9" y="17" width="6" height="4" rx="1"/><path d="M6 7v4a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7M12 13v4"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6h0.01M4 12h0.01M4 18h0.01M9 6h11M9 12h11M9 18h11"/></svg>',
  selected: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="6" cy="4" r="2.2"/><circle cx="6" cy="20" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 6.2v11.6M6 15c0-3.2 3-3.4 5-3.9s4-1 4-3.4"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19l6-6M11 13H7M11 13v4M19 5l-6 6M13 11h4M13 11v-4"/></svg>',
  hide: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg>',
  show: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6"/></svg>',
};
let _cmCollapsed = new Set();  // 折叠起来的分类 id
let _cmBatch = false;          // 弹窗内的「批量管理」模式
let _cmAnchorIdx = -1;         // Shift 连选的锚点（条目下标）
let _cmEntry = '';        // 右侧选中的已保存卡片 / 卡片组名
let _cmEntries = new Set();   // 右侧多选（Ctrl 点选；合并 / 批量删除用）
let _cmDragCat = '';      // 正在拖动的分类 id
let _cmDragEntry = '';    // 正在拖动的已保存条目名

function cmHint(text, kind) {
  const h = _cardMgr && _cardMgr._hint;
  if (!h) return;
  h.textContent = text || '';
  h.className = 'eph-cm-hint' + (kind ? ' ' + kind : '');
}
async function cmRefreshList() {
  try { const r = await fetchApi(CARDS_API); const d = await r.json().catch(() => ({})); _cmSaved = Array.isArray(d.cards) ? d.cards : []; }
  catch (_) { _cmSaved = []; }
  try { const r = await fetchApi(CATS_API); const d = await r.json().catch(() => ({})); _cmCats = Array.isArray(d.categories) ? d.categories : []; }
  catch (_) { _cmCats = []; }
  if (_cmEntry && !_cmSaved.some((x) => x.name === _cmEntry)) _cmEntry = '';
  _cmCardCache = new Map();
  cmRenderCats(); cmRenderEntries();
  cmPreloadCards().then(() => cmRenderEntries());
}
// 预取所有条目的卡片（方块预览 + 按标题/内容搜索要用）；只取没缓存的
async function cmPreloadCards() {
  const want = _cmSaved.filter((x) => !_cmCardCache.has(x.name));
  for (const x of want) {
    const d = await cmFetchOne(x.name);
    _cmCardCache.set(x.name, d ? d.cards : []);
  }
}
function cmSearchMatch(x) {
  const q = String(_cmSearchQ || '').trim().toLowerCase();
  if (!q) return true;
  const sc = _cmSearchScope || 'all';
  if ((sc === 'all' || sc === 'name') && x.name.toLowerCase().indexOf(q) >= 0) return true;
  if (sc === 'name') return false;
  const cards = _cmCardCache.get(x.name) || [];
  for (const c of cards) {
    if (sc !== 'content' && String(c.title || '').toLowerCase().indexOf(q) >= 0) return true;
    if (sc !== 'title' && String(c.content || '').toLowerCase().indexOf(q) >= 0) return true;
  }
  return false;
}

const CM_CARD_DEFAULTS = {
  title: ezT('Prompt'), content: '', contentHTML: '', contentOptimized: '', contentOptimizedHTML: '',
  timelineStart: '', timelineEnd: '', modelType: 'text', model: '', provider: '', apiUrl: '', indent: 0, useOptimized: false,
};
// replace=true = 用这些替换当前卡片列表；false = 追加到末尾。names 按选择顺序依次拼接。
async function cmApply(names, replace) {
  const m = _cardMgr; if (!m || !m._node) return;
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  if (!list.length) return;
  try {
    const st = stateFor(m._node);
    const incoming = [];
    for (const name of list) {
      const d = await cmFetchOne(name);
      if (!d) continue;
      // 逐张补默认字段并重新给 id（同一份卡片可以在不同节点上加载，id 不跨节点复用）
      d.cards.forEach((c) => incoming.push(Object.assign({}, CM_CARD_DEFAULTS, c, { id: genId() })));
    }
    if (!incoming.length) { cmHint(ezT('No prompt cards to save.'), 'err'); return; }
    st.cards = replace ? incoming : st.cards.concat(incoming);
    st.editingId = null;
    syncToConfig(m._node); updatePorts(m._node); refreshUI(m._node);
    cmHint((replace ? ezT('Replaced with "') : ezT('Added "')) + list.join(', ') + ezT('" (') + incoming.length + ezT(' cards)'), 'ok');
  } catch (e) { cmHint(ezT('Load failed: ') + (e && e.message ? e.message : e), 'err'); }
}
async function cmUse(names) {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  if (!list.length) return;
  if (!(await uiConfirm(ezT('Use "') + list.join(', ') + ezT('"? The current card list will be cleared and replaced.')))) return;
  await cmApply(list, true);
}
function cmAppend(names) { cmApply(names, false); }
async function cmFetchOne(name) {
  try {
    const r = await fetchApi(CARDS_API + '?name=' + encodeURIComponent(name));
    const d = await r.json().catch(() => ({}));
    return (r.ok && Array.isArray(d.cards)) ? d : null;
  } catch (_) { return null; }
}
async function cmDeleteEntries(names) {
  const uniq = Array.from(new Set((names || []).filter(Boolean)));
  if (!uniq.length) return;
  const msg = uniq.length === 1
    ? (ezT('Delete the saved card "') + uniq[0] + ezT('"? (file under userdata/prompts)'))
    : (ezT('Delete ') + uniq.length + ezT(' saved cards?'));
  if (!(await uiConfirm(msg))) return;
  for (const n of uniq) { try { await fetchApi(CARDS_API + '?name=' + encodeURIComponent(n), { method: 'DELETE' }); } catch (_) {} }
  uniq.forEach((n) => _cmEntries.delete(n));
  if (uniq.indexOf(_cmEntry) >= 0) _cmEntry = '';
  await cmRefreshList();
  cmHint(ezT('Deleted ') + uniq.length + ezT(' saved cards)'), 'ok');
}
// 合并：按选择顺序把后面的条目塞进第一个条目末尾，被合并的条目删除（不新建）。
async function cmMergeInto(names) {
  const uniq = Array.from(new Set((names || []).filter(Boolean)));
  if (uniq.length < 2) { cmHint(ezT('Select at least two saved cards to merge.'), 'err'); return; }
  const target = uniq[0];
  const dst = await cmFetchOne(target);
  if (!dst) return;
  let cards = dst.cards.slice();
  const gone = [];
  for (const n of uniq.slice(1)) {
    const s = await cmFetchOne(n);
    if (!s) continue;
    cards = cards.concat(s.cards);
    gone.push(n);
  }
  cards = cards.map((c) => { const o = Object.assign({}, c); delete o.id; return o; });
  try { await cmPostCard(target, cards, 'group', dst.category || ''); }
  catch (e) { cmHint(ezT('Save failed: ') + (e && e.message ? e.message : e), 'err'); return; }
  for (const n of gone) { try { await fetchApi(CARDS_API + '?name=' + encodeURIComponent(n), { method: 'DELETE' }); } catch (_) {} }
  _cmEntries = new Set([target]); _cmEntry = target;
  await cmRefreshList();
  cmHint(ezT('Merged ') + uniq.length + ezT(' saved cards into "') + target + ezT('".'), 'ok');
}
// 拖动/移动条目到某个分类
async function cmMoveEntryToCat(name, catId) {
  if (!name) return;
  const d = await cmFetchOne(name);
  if (!d) return;
  try { await cmPostCard(name, d.cards, d.kind || 'card', catId || ''); }
  catch (e) { cmHint(ezT('Save failed: ') + (e && e.message ? e.message : e), 'err'); return; }
  await cmRefreshList();
  cmHint(ezT('Moved "') + name + ezT('" to "') + (catId || ezT('Uncategorized')) + ezT('".'), 'ok');
}
// 卡片组 → 每张卡片各存一份单卡，然后删掉原组
async function cmSplitEntry(name) {
  const d = await cmFetchOne(name);
  if (!d) { cmHint(ezT('Load failed: ') + name, 'err'); return; }
  if (d.cards.length < 2) { cmHint(ezT('This saved card already contains a single card.'), 'err'); return; }
  if (!(await uiConfirm(ezT('Split "') + name + ezT('" into single cards? The saved card group will be removed.')))) return;
  const used = new Set((await cmFetchList()).map((x) => x.name));
  used.delete(name);
  let ok = 0;
  for (const c of d.cards) {
    let cn = (c.title || '').trim() || ('card-' + Date.now().toString(36) + '-' + ok);
    while (used.has(cn)) cn = cn + '-';
    const o = Object.assign({}, c); delete o.id;
    try { await cmPostCard(cn, [o], 'card', d.category || ''); used.add(cn); ok += 1; } catch (_) {}
  }
  try { await fetchApi(CARDS_API + '?name=' + encodeURIComponent(name), { method: 'DELETE' }); } catch (_) {}
  _cmEntries.delete(name); if (_cmEntry === name) _cmEntry = '';
  await cmRefreshList();
  cmHint(ezT('Split "') + name + ezT('" into ') + ok + ezT(' cards)'), 'ok');
}
// 在「总体编辑」里编辑这份已保存卡片：临时把它当当前卡片列表，关窗后写回存档并还原
// 临时把这份已保存卡片当成当前卡片列表，在总体编辑里改；关窗后写回存档并还原。
// 卡片管理界面不关（只被整体编辑盖住），关掉总体编辑后还回到卡片管理。
async function cmEditEntry(name) {
  const m = _cardMgr; if (!m || !m._node || !name) return;
  const d = await cmFetchOne(name);
  if (!d || !d.cards.length) { cmHint(ezT('Load failed: ') + name, 'err'); return; }
  const node = m._node; const st = stateFor(node);
  const backup = st.cards;
  st.cards = d.cards.map((c) => Object.assign({}, CM_CARD_DEFAULTS, c, { id: genId() }));
  st.editingId = null;
  openAllEditor(node);
  if (!_allModal) return;
  _allModal._cmBackup = backup;
  _allModal._cmEntryName = name;
  // 总体编辑里右键卡片标题：拆分 / 批量拆分
  if (!_allModal._cmTitleCtx) {
    _allModal._cmTitleCtx = (e) => {
      if (!_allModal._cmEntryName) return;
      const blk = e.target && e.target.closest ? e.target.closest('.eph-all-block') : null;
      if (!blk) return;
      e.preventDefault(); e.stopPropagation();
      const idx = Array.from(_allModal._ed.querySelectorAll('.eph-all-block')).indexOf(blk);
      cmMenu(e.clientX, e.clientY, [
        [ezT('Split'), () => cmSplitBlock(idx)],
        [ezT('Batch split'), () => cmSplitModeEnter()],
      ]);
    };
    _allModal._ed.addEventListener('contextmenu', _allModal._cmTitleCtx);
  }
  _allModal._afterClose = async (save) => {
    const edited = st.cards.map((c) => { const o = Object.assign({}, c); delete o.id; return o; });
    st.cards = _allModal._cmBackup || backup;
    _allModal._cmBackup = null;
    _allModal._cmEntryName = '';
    syncToConfig(node); updatePorts(node); refreshUI(node);
    if (save) {
      try { await cmPostCard(name, edited, d.kind || 'card', d.category || ''); phTip(ezT('Saved "') + name + ezT('".'), 2400); }
      catch (e) { phTip(ezT('Save failed: ') + (e && e.message ? e.message : e)); }
    }
    cmRefreshList();
  };
}
// 拆出这一张：单独存一张已保存卡片，并从当前编辑的存档里移除这张
async function cmSplitBlock(idx) {
  const modal = _allModal; if (!modal || !modal._node) return;
  const node = modal._node;
  try { syncAllContent(node); } catch (_) {}
  const st = stateFor(node);
  const card = st.cards[idx]; if (!card) return;
  const used = new Set(_cmSaved.map((x) => x.name));
  let name = (card.title || '').trim() || ('card-' + Date.now().toString(36));
  while (used.has(name)) name += '-';
  const o = Object.assign({}, card); delete o.id;
  try { await cmPostCard(name, [o], 'card', _cmCatId === CM_ALL ? '' : _cmCatId); }
  catch (e) { cmHint(ezT('Save failed: ') + (e && e.message ? e.message : e), 'err'); return; }
  st.cards.splice(idx, 1);
  renderAllEditor(node);
  await cmRefreshList();
  cmHint(ezT('Split "') + (card.title || '') + ezT('" → ') + name, 'ok');
}
// 批量拆分管理模式：点卡片多选，执行拆分把选中的每张另存为单卡并从当前编辑的存档里移除
function cmSplitUpdateCount() {
  const m = _allModal; if (!m || !m._splitLabel) return;
  m._splitLabel.textContent = (m._cmSplitSel ? m._cmSplitSel.size : 0) + ezT(' cards selected');
}
function cmSplitModeEnter() {
  const m = _allModal; if (!m || !m._ed) return;
  m._cmSplitMode = true; m._cmSplitSel = new Set();
  m._ed.classList.add('eph-cm-splitting');
  if (m._splitBar) m._splitBar.classList.add('on');
  if (!m._cmSplitClick) {
    m._cmSplitClick = (e) => {
      if (!m._cmSplitMode) return;
      const blk = e.target && e.target.closest ? e.target.closest('.eph-all-block') : null;
      if (!blk) return;
      e.preventDefault(); e.stopPropagation();
      const idx = Array.from(m._ed.querySelectorAll('.eph-all-block')).indexOf(blk);
      if (idx < 0) return;
      if (m._cmSplitSel.has(idx)) m._cmSplitSel.delete(idx); else m._cmSplitSel.add(idx);
      blk.classList.toggle('sel', m._cmSplitSel.has(idx));
      cmSplitUpdateCount();
    };
    m._ed.addEventListener('click', m._cmSplitClick, true);
  }
  cmSplitUpdateCount();
}
function cmSplitModeExit() {
  const m = _allModal; if (!m) return;
  m._cmSplitMode = false; m._cmSplitSel = new Set();
  if (m._ed) { m._ed.classList.remove('eph-cm-splitting'); m._ed.querySelectorAll('.eph-all-block.sel').forEach((b) => b.classList.remove('sel')); }
  if (m._splitBar) m._splitBar.classList.remove('on');
}
async function cmSplitRun() {
  const m = _allModal; if (!m || !m._node) return;
  const node = m._node;
  const sel = Array.from(m._cmSplitSel || []);
  if (!sel.length) { cmHint(ezT('Select the prompt cards to save first.'), 'err'); return; }
  try { syncAllContent(node); } catch (_) {}
  const st = stateFor(node);
  const used = new Set(_cmSaved.map((x) => x.name));
  let ok = 0;
  for (const idx of sel.slice().sort((a, b) => a - b)) {
    const card = st.cards[idx]; if (!card) continue;
    let name = (card.title || '').trim() || ('card-' + Date.now().toString(36) + '-' + ok);
    while (used.has(name)) name += '-';
    const o = Object.assign({}, card); delete o.id;
    try { await cmPostCard(name, [o], 'card', _cmCatId === CM_ALL ? '' : _cmCatId); used.add(name); ok += 1; }
    catch (e) { cmHint(ezT('Save failed: ') + (e && e.message ? e.message : e), 'err'); return; }
  }
  sel.slice().sort((a, b) => b - a).forEach((i) => st.cards.splice(i, 1));
  cmSplitModeExit();
  renderAllEditor(node);
  await cmRefreshList();
  cmHint(ezT('Split ') + ok + ezT(' cards)'), 'ok');
}
// ===== 通用小菜单（分类 / 已保存条目的右键）=====
let _cmMenu = null;
function cmMenu(x, y, items) {
  if (!_cmMenu || !_cmMenu.parentNode) {
    _cmMenu = el('div', 'eph-tools-dropdown eph-ctx');
    document.body.appendChild(_cmMenu);
    phLayerPush(_cmMenu);
  }
  _cmMenu.innerHTML = '';
  items.forEach(([label, fn]) => {
    if (label === '-') { _cmMenu.appendChild(el('div', 'eph-tools-sep')); return; }
    if (!fn) { const h = el('div', 'eph-tools-head'); h.textContent = label; _cmMenu.appendChild(h); return; }   // 分组标题：不可点
    const on = label.indexOf('\u2713 ') === 0;   // 选中项：去掉「✓ 」文字，用 .on 样式表示
    const b = el('button', 'eph-tool-item' + (on ? ' on' : '')); b.type = 'button'; b.textContent = on ? label.slice(2) : label;
    b.addEventListener('click', () => { _cmMenu.classList.remove('active'); fn(); });
    _cmMenu.appendChild(b);
  });
  _cmMenu.classList.add('active');
  const r = _cmMenu.getBoundingClientRect();
  _cmMenu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  _cmMenu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
}

// ===== 左侧分类树：增删改 + 拖动（上/下缘 = 同级前/后，中间 = 成为子分类）=====
function cmCatId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function cmCatWalk(list, fn) { (list || []).forEach((it) => { fn(it); cmCatWalk(it.children, fn); }); }
// 新分类默认名：新分组1、新分组2……（同级不重名），改名走右键
function catNextName(sibs) {
  const used = new Set((sibs || []).map((c) => String(c.name)));
  for (let i = 1; ; i++) { const n = ezT('New group') + i; if (!used.has(n)) return n; }
}
// 同一层级不允许同名分类：重名就加序号
function catUniqName(list, name, self) {
  const base = String(name || '').slice(0, 60) || ezT('New group');
  const used = new Set((list || []).filter((c) => c !== self).map((c) => String(c.name)));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) { const n = base + ' ' + i; if (!used.has(n)) return n; }
}
// 展开选中的分类及其全部子分类（一次性，不是状态）：全部都展开才无动作
function catExpandSelected(rootList, selId, collapsed, render) {
  const id = (selId && selId !== CM_ALL) ? String(selId) : '';
  const paths = new Set();
  if (!id) cmCatWalk(rootList, (it) => paths.add(String(it.id)));
  else {
    const walk = (list, chain) => (list || []).forEach((it) => {
      if (String(it.id) === id) { chain.concat([String(it.id)]).forEach((p) => paths.add(p)); cmCatWalk([it], (n) => paths.add(String(n.id))); }
      else walk(it.children, chain.concat([String(it.id)]));
    });
    walk(rootList, []);
  }
  if (!paths.size) return;   // 没选中 / 找不到 → 无动作
  let allOpen = true;
  paths.forEach((p) => { if (collapsed.has(p)) allOpen = false; });
  if (allOpen) return;       // 全部都展开 → 无动作
  paths.forEach((p) => collapsed.delete(p));
  render();
}
function cmExpandSelected() { catExpandSelected(_cmCats, _cmCatId, _cmCollapsed, cmRenderCats); }
function cmCatFind(id) {
  let hit = null;
  const walk = (list) => { (list || []).forEach((it, i) => { if (String(it.id) === String(id)) hit = { node: it, list: list, index: i }; else walk(it.children); }); };
  walk(_cmCats);
  return hit;
}
function cmCatRemove(id) { const h = cmCatFind(id); if (!h) return null; h.list.splice(h.index, 1); return h.node; }
function cmCatInsert(node, parentId, beforeId) {
  const p = parentId ? cmCatFind(parentId) : null;
  const list = p ? (p.node.children = p.node.children || []) : _cmCats;
  const i = beforeId ? list.findIndex((x) => String(x.id) === String(beforeId)) : -1;
  if (i >= 0) list.splice(i, 0, node); else list.push(node);
}
async function cmSaveCats() {
  try {
    const r = await fetchApi(CATS_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories: _cmCats }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) { cmHint(ezT('Save failed: ') + (d.error || ('HTTP ' + r.status)), 'err'); return; }
    if (Array.isArray(d.categories)) { _cmCats = d.categories; cmRenderCats(); }
  } catch (e) { cmHint(ezT('Save failed: ') + (e && e.message ? e.message : e), 'err'); }
}
function cmCatDrop(dragId, overId, p) {
  if (!dragId || String(dragId) === String(overId)) return;
  const src = cmCatFind(dragId); if (!src) return;
  let inside = false; cmCatWalk(src.node.children, (it) => { if (String(it.id) === String(overId)) inside = true; });
  if (inside) return;   // 不准拖进自己的子树
  const node = cmCatRemove(dragId); if (!node) return;
  if (overId && p > 0.3 && p < 0.7) { cmCatInsert(node, overId, ''); }
  else if (overId) {
    const t = cmCatFind(overId);
    if (!t) _cmCats.push(node);
    else if (p <= 0.3) t.list.splice(t.index, 0, node);
    else t.list.splice(t.index + 1, 0, node);
  } else _cmCats.push(node);
  cmRenderCats(); cmSaveCats();
}
// 右键「移动至分组」：列出可去的地方（比拖动精准）
function cmCatMoveMenu(x, y, node) {
  const banned = new Set([String(node.id)]);
  cmCatWalk([node], (it) => banned.add(String(it.id)));
  const items = [[ezT('Top level'), () => cmCatMoveUnder(node, '')]];
  const walk = (list, depth) => (list || []).forEach((c) => {
    if (!banned.has(String(c.id))) items.push(['\u3000'.repeat(depth) + c.name, () => cmCatMoveUnder(node, c.id)]);
    walk(c.children, depth + 1);
  });
  walk(_cmCats, 0);
  cmMenu(x, y, items);
}
function cmCatMoveUnder(node, parentId) {
  if (!node) return;
  const n = cmCatRemove(node.id); if (!n) return;
  cmCatInsert(n, parentId || '', '');
  cmRenderCats(); cmSaveCats();
}
function cmCatMenu(x, y, node) {
  const newCat = (parent) => {
    const rec = { id: cmCatId(), name: catNextName(parent ? parent.children : _cmCats), children: [] };
    if (parent) { parent.children = parent.children || []; parent.children.push(rec); _cmCollapsed.delete(parent.id); } else _cmCats.push(rec);
    cmRenderCats(); cmSaveCats();
  };
  if (!node) {
    const hit = _cmCatId ? cmCatFind(_cmCatId) : null;
    cmMenu(x, y, [[ezT('New category'), () => newCat(hit ? hit.node : null)]]);
    return;
  }
  cmMenu(x, y, [
    [ezT('New category'), () => newCat(node)],
    [ezT('Rename'), async () => { const n = await uiPrompt(ezT('Category name'), node.name); if (n && n.trim()) { node.name = n.trim().slice(0, 64); cmRenderCats(); cmSaveCats(); } }],
    [ezT('Move to group'), () => cmCatMoveMenu(x, y, node)],
    ['-'],
    [ezT('Delete category'), async () => {
      if (!(await uiConfirm(ezT('Delete category "') + node.name + ezT('" and its subcategories? (saved cards are kept)')))) return;
      cmCatRemove(node.id);
      if (String(_cmCatId) === String(node.id)) _cmCatId = '';
      cmRenderCats(); cmRenderEntries(); cmSaveCats();
    }],
  ]);
}
function cmRenderCats() {
  const m = _cardMgr; if (!m || !m._cats) return;
  const box = m._cats; box.innerHTML = '';
  const flat = _cmCatMode === 'list';
  const mkRow = (label, id, depth, node) => {
    const row = el('div', 'eph-cm-cat' + (String(_cmCatId) === String(id) ? ' on' : ''));
    row.style.paddingLeft = (4 + depth * (flat ? 10 : 14)) + 'px';
    if (!flat) {
      const caret = el('span', 'eph-cm-caret' + (node && !_cmCollapsed.has(node.id) ? ' open' : ''));
      caret.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M9 6l6 6-6 6z"/></svg>';
      caret.title = ezT('Expand');
      if (!node || !(node.children || []).length) caret.style.visibility = 'hidden';
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!node) return;
        if (_cmCollapsed.has(node.id)) _cmCollapsed.delete(node.id); else _cmCollapsed.add(node.id);
        cmRenderCats();
      });
      row.appendChild(caret);
    }
    const nm = el('span', 'eph-cm-cat-name'); nm.textContent = label; nm.title = label;
    row.appendChild(nm);
    if (node) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { _cmDragCat = node.id; try { e.dataTransfer.setData('text/plain', node.id); } catch (_) {} });
    }
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (_cmDragEntry) { row.classList.add('drop-in'); return; }
      const r = row.getBoundingClientRect(); const p = (e.clientY - r.top) / Math.max(1, r.height);
      row.classList.toggle('drop-in', p > 0.3 && p < 0.7);
      row.classList.toggle('drop-before', p <= 0.3);
      row.classList.toggle('drop-after', p >= 0.7);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-in', 'drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-in', 'drop-before', 'drop-after');
      const entry = _cmDragEntry;
      if (entry) { _cmDragEntry = ''; if (id !== CM_ALL) cmMoveEntryToCat(entry, id || ''); return; }
      if (!node) { cmCatDrop(_cmDragCat, '', 0.5); _cmDragCat = ''; return; }
      const r = row.getBoundingClientRect(); const p = (e.clientY - r.top) / Math.max(1, r.height);
      cmCatDrop(_cmDragCat, node.id, p);
      _cmDragCat = '';
    });
    // 点分类本身就能展开/收起（不用点三角），同时选中
    row.addEventListener('click', () => {
      _cmCatId = id;
      if (!flat && node && (node.children || []).length) { if (_cmCollapsed.has(node.id)) _cmCollapsed.delete(node.id); else _cmCollapsed.add(node.id); }
      cmRenderCats(); cmRenderEntries();
    });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); cmCatMenu(e.clientX, e.clientY, node); });
    box.appendChild(row);
    if (node && node.children && (flat || !_cmCollapsed.has(node.id))) node.children.forEach((ch) => mkRow(ch.name, ch.id, depth + 1, ch));
  };
  mkRow(ezT('All'), CM_ALL, 0, null);
  _cmCats.forEach((c) => mkRow(c.name, c.id, 1, c));
  mkRow(ezT('Uncategorized'), '', 0, null);
}

// ===== 右侧已保存的卡片 / 卡片组 =====
function cmEntryMenu(x, y, entry) {
  const names = cmEntriesSelected(entry.name);
  cmMenu(x, y, [
    [ezT('Add cards'), () => cmAppend(names)],
    [ezT('Use cards'), () => cmUse(names)],
    [ezT('Add as content'), () => cmInsertAsContent(x.name)],
    [ezT('Edit card'), () => cmEditEntry(entry.name)],
    [ezT('Quick split'), () => cmSplitEntry(entry.name)],
    [ezT('Batch manage'), () => cmBatchToggle(true)],
    [ezT('Delete'), () => cmDeleteEntries(cmEntriesSelected(entry.name))],
    ['-'],
    [ezT('Add preview image'), () => addPreviewImages(cmEntriesSelected(entry.name))],
    [ezT('Generate preview image'), () => cmHint(ezT('Generate preview image is not implemented yet.'), 'err')],
  ]);
}
function cmEntryInCat(x) { return _cmCatId === CM_ALL ? true : String(x.category || '') === String(_cmCatId || ''); }
async function cmPostPreview(name, preview) {
  const r = await fetchApi(CARDS_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, preview: preview }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}
function cmDownscale(url, max) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      try {
        const w = im.naturalWidth, h = im.naturalHeight;
        const k = Math.min(1, max / Math.max(w || 1, h || 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.82));
      } catch (e) { reject(e); }
    };
    im.onerror = reject;
    im.src = url;
  });
}
// 给选中的已保存卡片挂一张预览图（本地选图 → 缩到 320px 存进条目 JSON）
function addPreviewImages(names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) { cmHint(ezT('Select a saved card on the right first.'), 'err'); return; }
  const inp = el('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    try { inp.remove(); } catch (_) {}
    if (!f) return;
    try {
      const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result || '')); fr.onerror = rej; fr.readAsDataURL(f); });
      let small = url;
      try { small = await cmDownscale(url, 320); } catch (_) {}
      for (const n of list) await cmPostPreview(n, small);
      await cmRefreshList();
      cmHint(ezT('Added the preview image to ') + list.length + ezT(' saved cards)'), 'ok');
    } catch (e) { cmHint(ezT('Save failed: ') + (e && e.message ? e.message : e), 'err'); }
  });
  inp.click();
}
function cmEntriesSelected(fallback) {
  const names = Array.from(_cmEntries).filter((n) => _cmSaved.some((x) => x.name === n));
  if (!names.length && fallback) names.push(fallback);
  return names;
}
// 弹窗内「批量管理」：本界面多选 + 全选/反选/合并/删除，不离开卡片管理
function cmBatchToggle(on) {
  _cmBatch = !!on;
  const m = _cardMgr; if (m && m._batchBar) m._batchBar.classList.toggle('on', _cmBatch);
  cmRenderEntries();
}
// 拖动合并：把源条目里的卡片按顺序追加到目标条目末尾，源条目删除（不新建卡片组）
async function cmMoveEntry(from, to) {
  if (!from || !to || from === to) return;
  const src = await cmFetchOne(from); const dst = await cmFetchOne(to);
  if (!src || !dst) return;
  const cards = dst.cards.concat(src.cards).map((c) => { const o = Object.assign({}, c); delete o.id; return o; });
  try { await cmPostCard(to, cards, 'group', dst.category || ''); }
  catch (e) { cmHint(ezT('Save failed: ') + (e && e.message ? e.message : e), 'err'); return; }
  try { await fetchApi(CARDS_API + '?name=' + encodeURIComponent(from), { method: 'DELETE' }); } catch (_) {}
  _cmEntries.delete(from); if (_cmEntry === from) _cmEntry = '';
  if (!_cmEntries.has(to)) { _cmEntries.clear(); _cmEntries.add(to); _cmEntry = to; }
  await cmRefreshList();
  cmHint(ezT('Moved "') + from + ezT('" into "') + to + ezT('".'), 'ok');
}
// 把已保存卡片的内容插到当前编辑器光标处（卡片管理里右键 → 添加为内容）
async function cmInsertAsContent(name) {
  const d = await cmFetchOne(name);
  const ed = _phActiveEditor;
  if (!d || !ed) { cmHint(ezT('Load failed: ') + name, 'err'); return; }
  const text = d.cards.map((c) => String(c.content || plainTextOf(c.contentHTML || '') || '').trim()).filter(Boolean).join('\n');
  if (!text) return;
  ed.focus();
  let range = null;
  try { if (_editorRange && ed.contains(_editorRange.commonAncestorContainer)) { range = _editorRange.cloneRange(); range.collapse(false); } } catch (_) {}
  if (!range) { range = document.createRange(); range.selectNodeContents(ed); range.collapse(false); }
  let pre = '';
  try { pre = (range.startOffset > 0 && (ed.textContent || '').length) ? ', ' : ''; } catch (_) {}
  try { range.insertNode(document.createTextNode(pre + text)); } catch (_) {}
  ed.dispatchEvent(new Event('input', { bubbles: true }));
  cmHint(ezT('Add as content: ') + name, 'ok');
}
// 「卡片」按钮进来时用（双击卡片）：把一份存档插到编辑器光标处。
// 多张卡（卡片组）= 合成一块，规则和「合并提示词」一致：跳掉「合」为灰的卡，用节点级「卡片合并分隔符号」拼。
async function cmInsertSaved(ed, name) {
  const d = await cmFetchOne(name);
  if (!d || !ed) { cmHint(ezT('Load failed: ') + name, 'err'); return; }
  const nd = _cardMgr && _cardMgr._node;
  const cards = d.cards.length > 1 ? (d.cards.some((c) => !c.mergeOff) ? d.cards.filter((c) => !c.mergeOff) : d.cards) : d.cards;
  const htmlOf = (c) => ezSanitizeHtml(String(c.contentHTML || '')) || plainTextToHtml(String(c.content || ''));
  const parts = cards.map(htmlOf).filter((h) => String(h || '').replace(/<[^>]*>/g, '').trim());
  if (!parts.length) { cmHint(ezT('That saved card has no content.'), 'err'); return; }
  const sep = nd ? cardSeparator(nd) : '\n';
  const join = /[\r\n]/.test(sep) ? '<br>' : sep.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  ed.focus();
  try { restoreSelection(); } catch (_) {}
  let range = null;
  try { if (_editorRange && ed.contains(_editorRange.commonAncestorContainer)) { range = _editorRange.cloneRange(); range.collapse(false); } } catch (_) {}
  if (!range) { range = document.createRange(); range.selectNodeContents(ed); range.collapse(false); }
  const wrap = document.createElement('span');
  wrap.innerHTML = parts.join(join);
  while (wrap.firstChild) range.insertNode(wrap.firstChild);   // 插进光标处（insertNode 会顺序往后推，顺序不变）
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  saveSelection();
  ed.dispatchEvent(new Event('input', { bubbles: true }));
  cmHint(ezT('Insert') + ': ' + name, 'ok');
}
// 当前屏幕上真正显示的已保存条目（分类 + 搜索都对上）：渲染和全选/反选共用
function cmVisibleEntries() { return _cmSaved.filter(cmEntryInCat).filter(cmSearchMatch); }
function cmRenderEntries() {
  const m = _cardMgr; if (!m || !m._list) return;
  const list = m._list; list.innerHTML = '';
  const rows = cmVisibleEntries();
  if (!rows.length) { const e = el('div', 'eph-cm-empty'); e.textContent = ezT('No saved cards here.'); list.appendChild(e); return; }
  rows.forEach((x, idx) => {
    const r = el('div', 'eph-cm-tile' + (_cmEntries.has(x.name) ? ' on' : ''));
    const pv = el('div', 'eph-cm-tile-pv');
    if (x.preview) { const im = el('img'); im.src = x.preview; im.alt = ''; im.loading = 'lazy'; im.draggable = false; pv.appendChild(im); }
    else {
      const ic = el('div', 'eph-cm-tile-ico');
      ic.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4 17.5l5-5 4 4 3-3 4 4"/></svg>';
      pv.appendChild(ic);
    }
    const n = Number(x.count) || 0;
    const badge = el('span', 'eph-cm-tile-badge'); badge.textContent = (x.kind === 'group' || n > 1) ? ('+' + n) : String(n);
    pv.appendChild(badge);
    const del = el('button', 'eph-cm-tile-del'); del.type = 'button'; del.textContent = '×'; del.title = ezT('Delete the saved card');
    del.addEventListener('click', (e) => { e.stopPropagation(); cmDeleteEntries([x.name]); });   // 只删这一张，不受多选影响
    pv.appendChild(del);
    const nm = el('div', 'eph-cm-tile-name'); nm.textContent = x.name; nm.title = x.name;
    r.appendChild(pv); r.appendChild(nm);
    r.draggable = true;
    r.addEventListener('dragstart', (e) => { _cmDragEntry = x.name; try { e.dataTransfer.setData('text/plain', x.name); } catch (_) {} });
    r.addEventListener('dragover', (e) => { e.preventDefault(); r.classList.add('drop-in'); });
    r.addEventListener('dragleave', () => r.classList.remove('drop-in'));
    // 拖动合并：拖的是多选里的一员 → 把整组选中都合并进目标；否则只移动这一张
    r.addEventListener('drop', (e) => {
      e.preventDefault(); r.classList.remove('drop-in');
      const from = _cmDragEntry; _cmDragEntry = '';
      if (!from || from === x.name) return;
      if (_cmEntries.has(from) && _cmEntries.size > 1) cmMergeInto([x.name].concat(Array.from(_cmEntries).filter((nm2) => nm2 !== x.name)));
      else cmMoveEntry(from, x.name);
    });
    // 点选：单点单选 / Ctrl 多选切换 / Shift 连选（同 MediaLoader）；批量模式下点一下切换。
    // 插入模式（从「卡片」按钮进来）也是单点选中 —— 双击才把内容插到光标处。
    r.addEventListener('click', (e) => {
      if (e.shiftKey && _cmAnchorIdx >= 0) {
        const [a, b] = _cmAnchorIdx < idx ? [_cmAnchorIdx, idx] : [idx, _cmAnchorIdx];
        if (!(e.ctrlKey || e.metaKey) && !_cmBatch) _cmEntries.clear();
        for (let i = a; i <= b; i++) { if (rows[i]) _cmEntries.add(rows[i].name); }
      } else if (_cmBatch || e.ctrlKey || e.metaKey) {
        if (_cmEntries.has(x.name)) _cmEntries.delete(x.name); else _cmEntries.add(x.name);
      } else if (_cmEntries.size === 1 && _cmEntries.has(x.name)) {
        _cmEntries.clear();   // 再次点击已选中的 → 取消选择
      } else {
        _cmEntries.clear(); _cmEntries.add(x.name);
      }
      _cmAnchorIdx = idx;
      _cmEntry = _cmEntries.has(x.name) ? x.name : (Array.from(_cmEntries).pop() || '');
      cmRenderEntries();
    });
    r.addEventListener('dblclick', () => {
      if (_cardMgr && _cardMgr._insertEd) {   // 插入模式：双击 = 内容插到光标处并收工
        cmInsertSaved(_cardMgr._insertEd, x.name);
        _cardMgr.classList.remove('active');
        return;
      }
      cmUse([x.name]);
    });
    r.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!_cmEntries.has(x.name)) { _cmEntries = new Set([x.name]); _cmEntry = x.name; cmRenderEntries(); }
      cmEntryMenu(e.clientX, e.clientY, x);
    });
    list.appendChild(r);
  });
}

// 分类下拉项（缩进表示层级）：标签编辑弹窗的分类下拉用。
function flatCatItems(list, depth, out) {
  (list || []).forEach((c) => { out.push({ value: c.id, label: '\u3000'.repeat(depth) + c.name }); flatCatItems(c.children, depth + 1, out); });
  return out;
}
// ===== 标签：全局标签库（分类 + 标签）；「标签管理」弹窗 + 编辑器「插入标签」=====
const TAGS_API = '/prompt_helper/prompt_tags';
let _tagDoc = { categories: [], tags: [] };
let _tagPickTarget = null;   // 当前插入目标编辑器（卡片弹窗 / 总体编辑）
let _tpSort = 'default';        // 排序：default / name / count
let _tpFav = false, _tpEx621 = true, _tpExword = [], _tpExcat = [];   // 筛选：只看已收藏 / 排除 e621 / 排除关键词 / 排除分类
let _tpSel = new Set();         // 批量：选中的标签 id
let _tpBatch = false;           // 批量条是否展开
let _tpDragId = '';             // 正在拖动的标签 id
let _tpHideSide = false;        // 收起左侧分组栏
let _tpFlat = false;            // 左栏列表模式（不折叠子类）
let _myClosed = new Set();      // 「我的标签」侧收起的分类 id（默认展开，和库侧折叠键分开）
let _tpDragCat = '';            // 正在拖动的标签分类 id
let _tpScrollSel = false;       // 新建分类后把左栏滚到它那里
let _libTouched = false;        // 用户动过折叠开关没有（没动过就默认全展开）
let _tpMigrated = false;        // 旧数据结构是否已迁移到「库侧 / 我的副本」两套空间
const _tpAlt = new Map();       // 标签在正文里当前的实际写法（被转换工具改过之后）
const _tpW = new Map();         // 已插入标签的权重：name -> {w, br}

async function loadPromptTags() {
  _tpDocV++;   // 数据变了 → 计数缓存作废
  _tpCountsCache.clear();
  try { const r = await fetchApi(TAGS_API); const d = await r.json().catch(() => ({})); _tagDoc = { categories: Array.isArray(d.categories) ? d.categories : [], tags: Array.isArray(d.tags) ? d.tags : [], libs: (d.libs && typeof d.libs === 'object') ? d.libs : {} }; }
  catch (_) { _tagDoc = { categories: [], tags: [], libs: {} }; }
  _tpMigrated = false;                 // 数据换了 → 迁移标记重来
  if (_tpLibId) tpMigrateOnce();
}
async function savePromptTags() {
  _tpDocV++;   // 数据变了 → 计数缓存作废
  _tpCountsCache.clear();
  try {
    const r = await fetchApi(TAGS_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_tagDoc) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(d.tags)) _tagDoc = { categories: d.categories || [], tags: d.tags || [], libs: (d.libs && typeof d.libs === 'object') ? d.libs : (_tagDoc.libs || {}) };
  } catch (_) {}
}
// ===== 标签管理：批量条 + 拖动改分类（对齐卡片管理的多选/批量）=====
function tagBatchToggle(on) {
  _tpBatch = !!on;
  if (!_tpBatch) _tpSel = new Set();
  if (_tpEl && _tpEl._batchBar) _tpEl._batchBar.classList.toggle('on', _tpBatch);
  renderTagPanel();
}
function tagSelAll(invert) {
  const cur = _tpView.map((r) => r.key);   // 以当前显示的卡片为准（筛选/搜索/上限都算进去）
  _tpSel = invert ? new Set(cur.filter((n) => !_tpSel.has(n))) : new Set(cur);
  renderTagPanel();
}
async function tagDeleteSel() {
  if (!_tpSel.size) return;
  if (!(await uiConfirm(ezT('Delete ') + _tpSel.size + ezT(' selected tags?')))) return;
  const lib = _tpLibId ? _tpCache.get(_tpLibId) : null;
  const st = _tpLibId ? tpLibState(_tpLibId) : null;
  const hid = new Set((st && st.hidden) || []);
  _tpSel.forEach((key) => {
    const side = tpKeySide(key), name = tpKeyName(key);
    if (side === 'lib') { if (lib && lib.set && lib.set.has(name)) hid.add(name); else tpPlaceSet(name, ''); }   // 库原有：记隐藏（恢复默认能回来）；我加的：去掉归类
    else tpMineDrop(name);
    tpDropPreview(name);   // 删标签连预览图一起清（预览可重新生成）
  });
  if (st) st.hidden = Array.from(hid);
  _tpSel = new Set();
  await savePromptTags(); renderTagPanel();
}
// 批量移除预览图：预览存在标签记录里（两侧共用），按名字去重删 preview（本来就没有的不算）
async function tagRemoveSelPreviews() {
  if (!_tpSel.size) return;
  const names = new Set(Array.from(_tpSel).map((k) => tpKeyName(k)));
  if (!(await uiConfirm(ezT('Remove previews from ') + names.size + ezT(' tags with previews?')))) return;
  let n = 0;
  names.forEach((nm) => { const t = tpItem(nm); if (t && t.preview) { delete t.preview; n++; } });
  await savePromptTags(); renderTagPanel();
  phTip(ezT('Previews removed: ') + n);
}
// 统一归类：目标带 side（'mine' / 'lib'）
async function tagMoveTo(list, side, catId) {
  const to = String(catId || '');
  (list || []).forEach((key) => {
    const from = tpKeySide(key), name = tpKeyName(key);
    if (side === 'mine') {
      if (from !== 'mine') tpMineEnsure(name);                 // 从库侧复制一份到我的标签（库内那份不动）
      const t = tpMine(name); if (t) t.category = (String(to) === UNCAT_ID ? '' : to);
    } else {
      tpPlaceSet(name, to);                                    // 库内那份换归类（不动我的副本）
    }
  });
  _tpSel = new Set();
  await savePromptTags(); renderTagPanel();
}
// 归类候选树：两棵根 —— 我的标签(真实名) / 当前库(真实库名)
function tpTargetTree() {
  tpSpecialCats();
  const conv = (list, side) => (list || []).map((c) => ({ id: String(c.id), name: String(c.name || ''), side: side, cat: String(c.id), children: conv(c.children, side) }));
  const lst = _tagDoc.libs || {};
  const roots = [{ id: '__mine__', name: (lst['__mine__'] && lst['__mine__'].name) || ezT('My tags'), side: 'mine', root: true, children: conv(_tagDoc.categories, 'mine') }];
  if (_tpLibId) roots.push({ id: '__lib__', name: (lst[_tpLibId] && lst[_tpLibId].name) || _tpLibId, side: 'lib', root: true, children: conv(tpSeedLibTree(_tpLibId), 'lib') });
  return { roots };
}
// 层级归类菜单：右侧层叠展开（Windows 右键那种）。有子分类的节点点/悬停往右开新栏，
// 新栏第一行就是它自己（点 = 放到这里）；叶子节点点一下直接选中。根节点只作分组入口。
function tpCatPickMenu(x, y, onPick, opts) {
  opts = opts || {};
  const tree = opts.tree || tpTargetTree();
  const cur = opts.current || null;
  const PW = 224;
  const wrap = el('div', 'eph-catcascade eph-ctx active');
  const panels = [];
  let hoverT = null;
  function close() {
    wrap.remove();
    const i = _phLayers.indexOf(wrap); if (i >= 0) _phLayers.splice(i, 1);
    document.removeEventListener('pointerdown', out, true);
  }
  const out = (e) => { if (!wrap.contains(e.target)) close(); };
  function cutFrom(panel) {   // 关掉这一栏右边的所有栏
    const i = panels.indexOf(panel);
    if (i < 0) return;
    while (panels.length > i + 1) panels.pop().remove();
  }
  function isCur(it) {
    if (!cur || it.root) return false;
    const cc = String(cur.cat || '') === '' ? UNCAT_ID : String(cur.cat);
    const ic = String(it.cat || '') === '' ? UNCAT_ID : String(it.cat);
    return String(cur.side) === String(it.side) && cc === ic;
  }
  function entriesOf(node) {
    const out = [];
    if (!node.root || opts.roots) out.push({ self: true, side: node.side, cat: (node.root ? '' : node.cat), name: node.name, id: node.id + '·self' });
    (node.children || []).forEach((c) => out.push(c));
    return out;
  }
  // 每栏只在新增时摆一次位置（右侧放不下就翻到父栏左边），已经摆好的栏绝不再动 ——
  // 否则容器一挪，鼠标底下的行就换了，会连锁开栏/关栏（乱串）。
  function place(p, parent, rowEl) {
    const w = p.offsetWidth || PW, h = p.offsetHeight;
    let left = parent ? (parent.offsetLeft + parent.offsetWidth + 2) : 0;
    if (parent && wrap.offsetLeft + left + w > window.innerWidth - 6) left = parent.offsetLeft - w - 2;
    if (left < 0) left = 0;
    let top = parent ? (parent.offsetTop + (rowEl ? rowEl.offsetTop : 0)) : 0;
    const minTop = 6 - wrap.offsetTop, maxTop = window.innerHeight - 28 - h - wrap.offsetTop;
    if (top > maxTop) top = maxTop;
    if (top < minTop) top = minTop;
    p.style.left = left + 'px'; p.style.top = top + 'px';
  }
  function openPanel(panel, node, rowEl) {
    const i = panels.indexOf(panel);
    if (i < 0) return;
    if (panels[i + 1] && panels[i + 1]._node === node) return;   // 已经开着就不重开（防闪）
    cutFrom(panel);
    const p = el('div', 'eph-catpick'); p._node = node;
    entriesOf(node).forEach((it) => p.appendChild(makeRow(p, it)));
    panels.push(p); wrap.appendChild(p); place(p, panel, rowEl);
  }
  function makeRow(panel, it) {
    const kids = it.children || [];
    const r = el('div', 'eph-tool-item eph-catpick-row');
    const nm = el('span', 'eph-catpick-nm'); nm.textContent = it.name;
    const tri = el('span', 'eph-catpick-tri');
    if (isCur(it)) r.classList.add('eph-catpick-cur');
    if (it.self) r.classList.add('eph-catpick-self');
    else if (it.root) r.classList.add('eph-catpick-root');
    r.appendChild(nm); r.appendChild(tri);
    if (kids.length) {
      tri.textContent = '▸';
      r.addEventListener('mouseenter', () => { clearTimeout(hoverT); hoverT = setTimeout(() => openPanel(panel, it, r), 140); });   // 稍微延迟，鼠标路过不误开
      r.addEventListener('mouseleave', () => clearTimeout(hoverT));
      r.addEventListener('click', (e) => { e.stopPropagation(); clearTimeout(hoverT); openPanel(panel, it, r); });
    } else {
      r.addEventListener('click', (e) => { e.stopPropagation(); close(); onPick(it); });
    }
    return r;
  }
  wrap.style.left = Math.max(6, Math.min(x, window.innerWidth - PW - 6)) + 'px';
  wrap.style.top = Math.max(6, y) + 'px';
  const first = el('div', 'eph-catpick'); first._node = { id: '__roots__' };
  panels.push(first); wrap.appendChild(first);
  tree.roots.forEach((r0) => first.appendChild(makeRow(first, r0)));
  document.body.appendChild(wrap);
  if (y + first.offsetHeight > window.innerHeight - 28) wrap.style.top = Math.max(6, window.innerHeight - first.offsetHeight - 28) + 'px';   // 第一栏太高就往上收一点（留点下边距，别贴屏幕底）
  place(first, null, null);
  phLayerPush(wrap);
  setTimeout(() => document.addEventListener('pointerdown', out, true), 0);
}
// 移动至分类：所有入口共用
function tagMoveMenu(x, y, keys, row) {
  const list = (keys && keys.length) ? keys : Array.from(_tpSel);
  const cur = row ? { side: row.side, cat: row.side === 'lib' ? (tpPlaceOf(row.en) || tpDerivedCat(row.en)) : (tpMine(row.en) ? String(tpMine(row.en).category || '') : '') } : null;
  tpCatPickMenu(x, y, (it) => tagMoveTo(list, it.side, it.cat), { current: cur });
}
// 把某个分类挂到另一处：parentId 为空 = 放到顶层；topSide 决定哪棵树的顶层（'mine' / 'lib'）
async function tpCatMoveTo(catId, parentId, topSide) {
  if (String(catId) === UNCAT_ID) return;   // 未分类固定不动
  if (parentId && catInside(catId, parentId)) return;   // 不能拖进自己的子树
  const target = parentId ? catFind(parentId) : null;
  if (parentId && !target) return;
  if (target) await catMoveTo(catId, { side: catSideOf(target), list: target.children = target.children || [], openId: parentId });
  else {
    const side = (topSide === 'lib' && _tpLibId) ? 'lib' : 'mine';
    await catMoveTo(catId, { side: side, list: side === 'lib' ? tpSeedLibTree(_tpLibId) : _tagDoc.categories });
  }
}
// 跨树归类：库 → 我的标签 = 复制一份过去（库内那份不动）；其它都真的搬过去
async function catMoveTo(catId, dst) {
  const node0 = catFind(catId);
  if (!node0 || String(catId) === UNCAT_ID) return;
  const srcSide = catSideOf(node0);
  const at = () => {
    if (dst.beforeId) { const i = dst.list.findIndex((c) => String(c.id) === String(dst.beforeId)); return i >= 0 ? i : dst.list.length; }
    if (dst.afterId) { const i = dst.list.findIndex((c) => String(c.id) === String(dst.afterId)); return i >= 0 ? i + 1 : dst.list.length; }
    return dst.list.length;
  };
  if (srcSide === 'lib' && dst.side === 'mine') {
    const made = cloneCat(node0);
    made.clone.name = catUniqName(dst.list, made.clone.name, made.clone);
    dst.list.splice(at(), 0, made.clone);
    copyTagsToMine(node0, made.map);
  } else {
    const node = catDetach(catId);
    if (!node) return;
    node.name = catUniqName(dst.list, node.name, node);
    dst.list.splice(at(), 0, node);
    if (srcSide === 'mine' && dst.side === 'lib') {   // 我的 → 库：副本落回库侧
      const ids = new Set(); cmCatWalk([node], (it) => ids.add(String(it.id)));
      _tagDoc.tags.slice().forEach((t) => {
        if (!t.mine || !ids.has(String(t.category || ''))) return;
        tpPlaceSet(t.name, String(t.category));
        tpMineDrop(t.name);
      });
    }
  }
  if (dst.openId) tpOpenCat(dst.openId);
  await savePromptTags();
  renderTagPanel();
}
// 复制一棵分类子树（新 id），返回新子树 + 旧 id → 新 id 的映射
function cloneCat(node) {
  const map = {};
  const conv = (n) => { const id = cmCatId(); map[String(n.id)] = id; return { id: id, name: String(n.name || ''), children: (n.children || []).map(conv) }; };
  return { clone: conv(node), map: map };
}
// 库分组复制到我的标签：给它这一支里的库标签建我的副本（按默认位置或 place 归属），库侧 place 不动
function copyTagsToMine(node, map) {
  const ids = new Set(); cmCatWalk([node], (it) => ids.add(String(it.id)));
  const st = _tpLibId ? tpLibState(_tpLibId) : null;
  const place = (st && st.place) || {};
  const lib = _tpLibId ? _tpCache.get(_tpLibId) : null;
  const byName = tagMineOf();   // 一次建表；新建的副本边建边塞回去
  const put = (nm, cid) => {
    if (!cid || !ids.has(String(cid))) return;
    let t = byName.get(nm);
    if (!t) { t = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: nm, category: '' }; _tagDoc.tags.push(t); byName.set(nm, t); }
    t.mine = true;
    t.category = String(map[String(cid)] || cid);
  };
  if (lib) for (let i = 0; i < lib.names.length; i++) { const nm = lib.names[i]; put(nm, place[nm] || tpDefaultCat(lib, nm, i)); }
  Object.keys(place).forEach((nm) => { if (lib && lib.set && lib.set.has(nm)) return; put(nm, place[nm]); });
}
// 重命名第一层级节点（我的标签 / 库）
async function tpRenameRoot(which) {
  const st = which === 'mine' ? tpLibState('__mine__') : tpLibState(_tpLibId);
  const cur = st.name || (which === 'mine' ? ezT('My tags') : (_tpLibId || ''));
  const v = await uiPrompt(ezT('Group name'), cur);
  if (v && v.trim()) { st.name = v.trim().slice(0, 64); await savePromptTags(); renderTagPanel(); }
}
// 分组已经落到目标里之后把目标展开：否则新子分类藏在折叠的分组里，看起来像"拖了没反应"
function tpOpenCat(id) {
  if (!id) return;
  const k = String(id);
  if (tagCatNode(k)) { _myClosed.delete(k); return; }     // 我的标签侧：默认展开，只需取消"收起"
  _libOpen.add(k);
  if (k.slice(0, 2) === 'k:') _libOpen.add(k.slice(2));   // libCats 用裸 kind 名、tpLibRows 用 'k:' 前缀
  _libTouched = true;
}
// 一个分类节点现在在哪棵树（我的 = 'mine'，库 = 'lib'）
function catSideOf(node) {
  if (!node) return 'mine';
  let found = false;
  cmCatWalk(_tpLibId ? tpSeedLibTree(_tpLibId) : [], (it) => { if (it === node) found = true; });
  return found ? 'lib' : 'mine';
}

function catFind(id) {
  let hit = null;
  const walk = (arr) => (arr || []).forEach((c) => { if (String(c.id) === String(id)) hit = c; walk(c.children); });
  tpRoots().forEach(walk);
  return hit;
}
// 恢复默认标签（右键库侧卡片）：取消隐藏 + 清掉库侧归类和收藏；我的副本不动
async function tpRestoreTag(en) {
  if (!_tpLibId) return;
  const st = tpLibState(_tpLibId);
  st.hidden = (st.hidden || []).filter((v) => v !== en);
  tpPlaceSet(en, '');
  if (st.meta) delete st.meta[en];           // 库侧的中英/颜色/权重回默认（收藏不动）
  if (!tpMine(en)) {                          // 没有我的副本，才连记录里的覆盖一起清（预览图留着）
    const t = tpItem(en);
    if (t) { delete t.zh; delete t.color; delete t.weight; }
  }
  await savePromptTags(); renderTagPanel();
}
// 「未分类」：还没归类的标签都算它；固定节点（能改名、能在下面新建分类，不能移动/删除）
const UNCAT_ID = '__uncat__';
function tpSpecialCats() {
  const arr = _tagDoc.categories;
  let uncat = arr.find((c) => String(c.id) === UNCAT_ID);
  if (!uncat) { uncat = { id: UNCAT_ID, name: ezT('Uncategorized'), children: [] }; arr.unshift(uncat); }
  return { uncat: uncat };
}
// 某个分类子树里的所有 id（含自己）：点父分类就能看到整棵子树，和行上的计数一致
function tpSubIds(id) {
  const s = new Set([String(id)]);
  const walk = (list) => (list || []).forEach((c) => {
    if (String(c.id) === String(id)) { (function w(a) { (a || []).forEach((g) => { s.add(String(g.id)); w(g.children); }); })(c.children); }
    else walk(c.children);
  });
  walk(_tagDoc.categories);
  return s;
}
// 在未分类下按原分类的层级路径建（逐级复用同名节点）
function tpUncatPath(path) {
  const u = tpSpecialCats().uncat;
  let list = u.children = u.children || [];
  let node = null;
  (path && path.length ? path : [ezT('Uncategorized')]).forEach((nm) => {
    const n2 = String(nm || '').slice(0, 64) || ezT('Uncategorized');
    let g = list.find((c) => String(c.name) === n2);
    if (!g) { g = { id: cmCatId(), name: n2, children: [] }; list.push(g); }
    node = g; list = g.children = g.children || [];
  });
  return node;
}
// 恢复默认前先"回收"库侧归类：自建分类里的标签（含拖进来的原库标签）+ 原库分类下新建的标签
// 都变成我的标签副本、按原分类层级落进「未分类」；原库标签只是被挪到原库分类的，只清归类回默认。
function tpRecoverInto(roots) {
  const st = _tpLibId ? tpLibState(_tpLibId) : null;
  if (!st || !st.place) return 0;
  const ids = new Set(), nodeOf = new Map(), parentOf = new Map();
  (function w(a, p) { (a || []).forEach((g) => { ids.add(String(g.id)); nodeOf.set(String(g.id), g); parentOf.set(String(g.id), p); w(g.children, g); }); })(roots, null);
  const lib = _tpLibId ? _tpCache.get(_tpLibId) : null;
  const pathOf = (id) => { const out = []; let cur = nodeOf.get(String(id)); while (cur) { out.unshift(String(cur.name || '')); cur = parentOf.get(String(cur.id)); } return out; };
  const place = st.place;
  let n = 0;
  Object.keys(place).forEach((nm) => {
    const cid = String(place[nm] || '');
    if (!cid || !ids.has(cid)) return;
    const selfCat = !(/^c[01345x]$/.test(cid) || cid.slice(0, 2) === 'k:');
    const inLib = !!(lib && lib.set && lib.set.has(nm));
    delete place[nm];
    if (inLib && !selfCat) return;                 // 原库标签挪到原库分类：回默认位置即可
    const t = tpMineEnsure(nm);                     // 回收进「未分类」（保留原分类层级）
    if (t) { t.category = String(tpUncatPath(pathOf(cid)).id); n++; }
  });
  return n;
}
// 恢复默认库：库内自建分类里的标签 + 原库分类下新建的标签回收进「未分类」；然后把库恢复初始
async function tpRestoreLib() {
  const libId = _tpLibId;
  const lib = libId ? _tpCache.get(libId) : null;
  if (!lib) { phTip(ezT('My tags has no default')); return; }
  tpRecoverInto(tpSeedLibTree(libId));
  const st = tpLibState(libId);
  delete st.groups;                  // 分组树回默认
  delete st.place;                   // 归类清掉（该回收的已进未分类）
  delete st.hidden;                  // 删掉的默认标签也放回来（收藏是用户自己的标记，恢复默认库不动它）
  delete st.meta;                    // 库侧的中英/颜色/权重覆盖回默认
  _tagDoc.tags.forEach((t) => { if (!t.mine && lib.set && lib.set.has(String(t.name))) { delete t.zh; delete t.color; delete t.weight; } });   // 没有我的副本的记录也清干净（预览图留着）
  await savePromptTags();
  renderTagPanel();
}
// 新建分类：有 parent 就是它的子分类（父分组会自动展开），否则建在 root（缺省 = 当前树的根）
// 建完选中它 —— 接着再建就落在它里面，于是「我的标签」也能一层层套出子分类
async function newTagCategory(parent, root, first) {
  const list = parent ? (parent.children = parent.children || []) : (root || tpRoot());
  const rec = { id: cmCatId(), name: catNextName(list), children: [] };   // id 必须唯一，别只用毫秒时间戳（同一毫秒建两个就撞了）

  if (first) list.unshift(rec); else list.push(rec);
  if (parent) tpOpenCat(parent.id);
  await savePromptTags();
  _tpCat = String(rec.id);
  _tpScrollSel = true;
}
// 新建分类该挂在哪：选中的分组优先（我的分类 / 库分组），没选中就落在对应的树根
function tpNewCatTarget() {
  // 空白处右键 = 建在这一层的最后面（不再跟着"选中的那个分组"走：要子分类就右键那个分组 → 新建分类）
  return { parent: null, root: _tpLibId ? tpSeedLibTree(_tpLibId) : _tagDoc.categories };
}
// 大库模式：隐藏「+ 添加标签」和「批量管理」（大库只读）
// 插入标签芯片（可编辑文字、可删除）
// ===== 默认提示词里只写普通文字（标签样式只留在插入面板上方那个框里）=====
// 找编辑器里某个标签名那一段；前后挨着字母/数字/_/- 就不算（避免 hair 命中 long_hair）
// 早期版本把标签插成了芯片，现在改成普通文字：加载卡片时把旧芯片拆回文字（一次性兼容）
function unwrapTagChips(root) {
  // 载入时清掉开头空白/空 <br>：重启后第一行不会再被顶出一个空行
  try {
    let first = root.firstChild;
    while (first && first.nodeType === 3 && !String(first.nodeValue || '').trim()) {
      const nx = first.nextSibling; root.removeChild(first); first = nx;
    }
    if (first && first.nodeType === 1 && first.nodeName === 'BR') first.remove();
  } catch (_) {}
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('span.eph-tag').forEach((sp) => {
    const t = document.createTextNode(sp.dataset.tag || sp.textContent || '');
    if (sp.parentNode) sp.parentNode.replaceChild(t, sp);
  });
}
function phTagRangeOf(ed, name) {
  if (!ed || !name) return null;
  const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    const s = n.nodeValue || '';
    let i = s.indexOf(name);
    while (i >= 0) {
      const b = i > 0 ? s[i - 1] : '';
      const a = s[i + name.length] || '';
      if (!(b && /[A-Za-z0-9_-]/.test(b)) && !(a && /[A-Za-z0-9_-]/.test(a))) {
        let end = i + name.length;
        while (end < s.length && /[\s,]/.test(s[end])) end++;   // 连带吃掉后面的分隔符
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, end);
        return r;
      }
      i = s.indexOf(name, i + 1);
    }
  }
  return null;
}
// 把落点放到"最后一个块里面的文本节点"：
// applyIndent 重建后会留下块级 <div> 和空段落的 <br>，直接 collapse 到编辑器末尾会让插入变成
// 最后一个 div 的兄弟节点 → 浏览器另起一行。这里统一收进去，并把占位 <br> 清掉。
function phEndRange(ed) {
  try {
    let last = ed.lastChild;
    while (last && last.nodeType === 3 && !String(last.nodeValue || '').trim()) {
      const pv = last.previousSibling; ed.removeChild(last); last = pv;
    }
    let deep = last;
    while (deep && deep.nodeType === 1 && deep.lastChild) deep = deep.lastChild;
    if (last && last.nodeType === 1 && deep && deep.nodeName === 'BR' && !String(last.textContent || '').trim()) deep.remove();
    let node = ed.lastChild;
    while (node && node.nodeType === 1 && node.lastChild) node = node.lastChild;
    if (node && node.nodeType === 3) {
      const r = document.createRange();
      r.setStart(node, (node.nodeValue || '').length); r.collapse(true);
      return r;
    }
    if (node && node.nodeType === 1) {   // 空块：先造一个文本节点进去，光标才不会落在块外
      const tn = document.createTextNode('');
      node.appendChild(tn);
      const r = document.createRange();
      r.setStart(tn, 0); r.collapse(true);
      return r;
    }
  } catch (_) {}
  const r = document.createRange();
  r.selectNodeContents(ed); r.collapse(false);
  return r;
}
function phInsertPlain(ed, name) {
  if (!ed || !name) return;
  ed.focus();
  try { restoreSelection(); } catch (_) {}
  let range = null;
  try { if (_editorRange && ed.contains(_editorRange.commonAncestorContainer)) { range = _editorRange.cloneRange(); range.collapse(false); } } catch (_) {}
  if (!range) { range = document.createRange(); range.selectNodeContents(ed); range.collapse(false); }
  // 末尾那个空块里的 <br> 是缩进占位用的：插入时顶掉它，否则标签会掉到下一行
  try {
    const last = ed.lastChild;
    let deep = last;
    while (deep && deep.nodeType === 1 && deep.lastChild) deep = deep.lastChild;
    if (last && last.nodeType === 1 && deep && deep.nodeName === 'BR' && !String(last.textContent || '').trim()) {
      deep.remove();
      range.selectNodeContents(ed); range.collapse(false);
    }
  } catch (_) {}
  // 与缩进冲突的收尾：落点始终收进最后一个块内部（见 phEndRange 注释）
  try {
    if (!range || range.startContainer === ed) range = phEndRange(ed);
  } catch (_) {}
  let before = '';
  try { before = (range.startContainer.nodeType === 3 ? String(range.startContainer.nodeValue || '') : '').slice(range.startOffset - 1, range.startOffset); } catch (_) {}
  const tn = document.createTextNode((before && !/[\s,]/.test(before) ? ', ' : '') + name + ', ');
  try { range.insertNode(tn); range.setStartAfter(tn); range.collapse(true); } catch (_) {}
  ed.focus();
  const sel = window.getSelection(); if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  saveSelection();
  ed.dispatchEvent(new Event('input', { bubbles: true }));
}
// 把编辑器里的 oldTxt 换成 newTxt（权重变形用）
// 背景色深浅 → 自动配前景色（深底给白字）
function tpAutoFg(bg) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(bg || '').trim());
  if (!m) return '';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum < 0.6 ? '#fff' : '#1a1f2b';
}
function phReplaceText(ed, oldTxt, newTxt) {
  if (!ed || !oldTxt) return false;
  const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    const s = n.nodeValue || '';
    const i = s.indexOf(oldTxt);
    if (i < 0) continue;
    n.nodeValue = s.slice(0, i) + newTxt + s.slice(i + oldTxt.length);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return false;
}
function phRemovePlain(ed, name) {
  const r = phTagRangeOf(ed, name);
  if (!r) return;
  try { r.deleteContents(); } catch (_) {}
  ed.dispatchEvent(new Event('input', { bubbles: true }));
}
// ===== 插入标签面板：可移动浮窗（同查找替换），压在卡片/总体编辑弹窗之上但不遮住它们 =====
const LIB_LIST_API = '/prompt_helper/tag_libs', LIB_RAW_API = '/prompt_helper/tag_lib', LIB_ZH_API = '/prompt_helper/tag_zh', LIB_FURRY_API = '/prompt_helper/tag_furry', LIB_KIND_API = '/prompt_helper/tag_kind';
// CSV 第 2 列是 danbooru 分类号：0 通用 / 1 画师 / 3 版权 / 4 角色 / 5 meta，其余归「其他」
let _tpEl = null, _tpLibs = null, _tpLibId = '', _tpLib = null, _tpQ = '', _tpCat = CM_ALL, _tpZh = null;
let _tpDrop = null, _tpHideFurry = true;   // 兽类词表（e621 物种 + 追加黑名单）与「排除兽类」开关
let _tpKind = null, _tpObs = null;         // 细分分类表（tag→kind）与已插入区的编辑器监听
let _tpIns = [];                           // 上方「已插入」框里的标签名（有序、去重）
let _tpSyncTimer = null;                    // 编辑器改动同步防抖
const _tpCountsCache = new Map();
let _tpDocV = 0;   // 标签数据版本：变了就作废计数缓存
let _tpView = [];   // 当前视图的完整匹配列表（shift 区间 / 全选反选用）
const TP_PER = 100;                   // 每页张数（面板底部「x 个/页」可改）
let _tpPage = 1, _tpPer = TP_PER, _tpSig = '';   // 当前页 / 每页张数 / 视图签名（换库/分组/筛选/数据变了回第一页）
let _tpPages = 1, _tpTotalN = 0, _tpRo = null;   // 最近一次的页数/总数 + 面板尺寸观察者（缩放后重排翻页栏）
let _tpLast = '';   // 上次点选的卡片键（side:name，shift 起点）
let _tpMenuBtn = null;
let _tpwEl = null, _tpwEn = '', _tpwTimer = null, _tpwSuppress = false;
let _tpOutH = null;   // 面板外点击：先关面板，再关弹窗
let _tpSwallow = false;   // 吞掉关面板那一下的 click          // 当前开着的是哪个按钮的菜单（再点一次关掉）           // 分组计数：lib|hideFurry -> {c0..cx, k:xxx, ''}
const _libOpen = new Set();                 // 展开了哪些细分大类（子文件夹）
const _tpCache = new Map();

// tagcomplete 格式：name,category,count,"aliases"（字段可能带引号）
function tpFields(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c !== '"') { cur += c; continue; }
      if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
// 旧数据迁移：from 时代的单条记录拆成「库侧 place/fav」+「我的副本 mine」
function tpMigrate() {
  _tagDoc.libs = _tagDoc.libs || {};
  _tagDoc.categories = _tagDoc.categories.filter((c) => String(c.id) !== '__rec__');   // 临时分类已取消：老节点去掉，里面的标签由下面孤儿清理落回未分类
  const inMyTree = (id) => { let hit = false; cmCatWalk(_tagDoc.categories, (it) => { if (String(it.id) === String(id)) hit = true; }); return hit; };
  const stOf = (id) => { const k = String(id || ''); return _tagDoc.libs[k] || (_tagDoc.libs[k] = {}); };
  _tagDoc.tags.forEach((t) => {
    if (!t.name) return;
    if (t.from === undefined) return;   // 已是新格式（或刚被删掉 mine）：别再用 from 推回我的副本
    const from = String(t.from || '');
    const cat = String(t.category || '');
    const isLibCat = cat.slice(0, 2) === 'k:' || /^c[01345x]$/.test(cat);
    const isMy = !!cat && inMyTree(cat);
    if (from === '') {
      if (isLibCat) { const st = stOf(_tpLibId); st.place = st.place || {}; st.place[t.name] = cat; }
      else t.mine = true;
    } else if (from) {
      if (isLibCat) { const st = stOf(from); st.place = st.place || {}; st.place[t.name] = cat; }
      else if (isMy) t.mine = true;
      if (t.fav) { const st = stOf(from); st.fav = st.fav || []; if (st.fav.indexOf(t.name) < 0) st.fav.push(t.name); }
    } else if (t.fav) {
      const st = stOf(_tpLibId); st.fav = st.fav || []; if (st.fav.indexOf(t.name) < 0) st.fav.push(t.name);
    }
    delete t.from;
    if (!t.mine) t.category = '';
  });
  // 孤儿清理：我的副本指着一个已经不存在的分类 id → 落回「未分类」（否则只能从「我的标签」根下看到它）
  tpSpecialCats();
  const myIds = new Set();
  cmCatWalk(_tagDoc.categories, (it) => myIds.add(String(it.id)));
  _tagDoc.tags.forEach((t) => { if (t.mine && t.category && !myIds.has(String(t.category))) t.category = ''; });
  // 显示数据分侧：旧共用中英/颜色/权重复制一份到库侧 meta（记录保留，缩略图仍共用）
  if (_tpLibId) {
    const st = stOf(_tpLibId); st.meta = st.meta || {};
    _tagDoc.tags.forEach((t) => {
      const nm = String(t.name || ''); if (!nm || !(t.zh || t.color || t.weight)) return;
      const m = st.meta[nm] || (st.meta[nm] = {});
      if (t.zh && !m.zh) m.zh = t.zh;
      if (t.color && !m.color) m.color = t.color;
      if (t.weight && !m.weight) m.weight = t.weight;
    });
  }
  _tagDoc.tags = _tagDoc.tags.filter((t) => t.mine || t.zh || t.color || t.preview || t.weight || t.collectedFrom !== undefined);
}
function tpMigrateOnce() { if (_tpMigrated) return; _tpMigrated = true; tpMigrate(); savePromptTags(); }
async function tpLoadLibs() {
  if (_tpLibs) { tpMigrateOnce(); return; }
  _tpLibs = [];
  try {
    const d = await (await fetchApi(LIB_LIST_API)).json();
    (d.libs || []).forEach((x) => {
      const st = (_tagDoc.libs || {})[x.id] || {};
      if (st.disabled) return;                       // 我在界面里删掉的库：不出现
      _tpLibs.push({ id: x.id, label: st.name || x.id });
    });
    _tpLibs.sort((a, b) => a.id.localeCompare(b.id));
  } catch (_) {}
  if (!_tpLibId) _tpLibId = tpDefaultLib();
  tpMigrateOnce();
}
// 默认库：右键库下拉「设置为默认库」存本地；没设过就优先 Danbooru
function tpDefaultLib() {
  let saved = '';
  try { saved = localStorage.getItem('ezflex.tagLib') || ''; } catch (_) {}
  if (saved && _tpLibs.some((x) => x.id === saved)) return saved;
  const d = _tpLibs.find((x) => /danbooru/i.test(x.id));
  return d ? d.id : (_tpLibs[0] ? _tpLibs[0].id : '');
}
async function tpLoadZh() {
  if (_tpZh) return;
  _tpZh = new Map();
  try {
    const r = await fetchApi(LIB_ZH_API);
    if (!r.ok) return;
    (await r.text()).replace(/\uFEFF/g, '').split('\n').forEach((line) => {
      if (!line) return;
      const f = tpFields(line);
      if (f[0] && f[1]) _tpZh.set(f[0].trim(), f[1].trim());
    });
  } catch (_) {}
}
async function tpLoadKind() {
  if (_tpKind) return;
  _tpKind = new Map();
  try {
    const r = await fetchApi(LIB_KIND_API);
    if (!r.ok) return;
    (await r.text()).replace(/\uFEFF/g, '').split('\n').forEach((line) => {
      if (!line || line.charAt(0) === '#') return;
      const f = tpFields(line);
      if (f[0] && f[1]) _tpKind.set(f[0].trim(), f[1].trim());
    });
  } catch (_) {}
}
function tpKindOf(name) { return (_tpKind && (_tpKind.get(name) || _tpKind.get(name.replace(/-/g, '_')))) || ''; }
// 库内标签的默认落点（没设过 place 时它在库树里的位置）：细分大类优先，否则 CSV 分类桶
function tpDerivedCat(name) {
  const lib = _tpLibId ? _tpCache.get(_tpLibId) : null;
  if (!lib || !lib.set || !lib.set.has(name)) return '';
  return tpDefaultCat(lib, name, lib.names.indexOf(name));
}
// 库里某个标签的默认落点（细分大类优先，否则 CSV 分类桶）
function tpDefaultCat(lib, name, i) {
  const k = tpKindOf(name); if (k) return 'k:' + k;
  return 'c' + ('01345'.indexOf(lib.cats[i]) >= 0 ? lib.cats[i] : 'x');
}
const LIB_IMPORT_API = '/prompt_helper/tag_import';
// 导入：csv / tsv / txt / json / sql 都吃，后端自动认（tag 库进 PromptHelperLib，中英对照表并进 _zh_CN.csv）
function tpImport() {
  const inp = el('input'); inp.type = 'file'; inp.accept = '.csv,.tsv,.txt,.json,.sql';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const r = await fetchApi(LIB_IMPORT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name, text }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) { phTip(ezT('Import failed: ') + (d.error || ('HTTP ' + r.status))); return; }
      _tpLibs = null;
      _tpCountsCache.clear();
      if (d.kind === 'zh') { _tpZh = null; await tpLoadZh(); }
      else if (d.id) { _tpLibId = d.id; _tpCat = ''; await tpLoadLib(d.id); }
      await tpLoadLibs();
      tpSyncLibDD();
      renderTagPanel();
      phTip(ezT('Imported ') + d.rows + ezT(' tags.'));
    } catch (e) { phTip(ezT('Import failed: ') + (e && e.message ? e.message : e)); }
  });
  inp.click();
}
function tpSyncLibDD() {
  if (_tpEl && _tpEl._libDD) {
    _tpEl._libDD.setItems(_tpLibs.map((x) => ({ value: x.id, label: x.label })));
    _tpEl._libDD.value = _tpLibId;
  }
}
async function tpLoadDrop() {
  if (_tpDrop) return;
  _tpDrop = new Set();
  try {
    const r = await fetchApi(LIB_FURRY_API);
    if (!r.ok) return;
    (await r.text()).replace(/\uFEFF/g, '').split('\n').forEach((n) => { n = n.trim(); if (n && n.charAt(0) !== '#') _tpDrop.add(n); });
  } catch (_) {}
}
// 兽类判定：e621 专有分类桶（2 作者 / 6 无效 / 7 meta / 8 lore）+ 词表命中
function tpFurry(cat, name) {
  return cat === '2' || cat === '6' || cat === '7' || cat === '8' || (_tpDrop && _tpDrop.has(name));
}
async function tpLoadLib(id) {
  if (!id) { _tpLib = null; return; }
  if (_tpCache.has(id)) { _tpLib = _tpCache.get(id); return; }
  const r = await fetchApi(LIB_RAW_API + '?id=' + encodeURIComponent(id));
  const names = [], cats = [], alias = [], cnt = [];
  if (r.ok) {
    (await r.text()).split('\uFEFF').join('').split('\n').forEach((line) => {
      if (!line) return;
      const f = tpFields(line);
      const nm = (f[0] || '').trim();
      if (!nm) return;
      names.push(nm); cats.push((f[1] || '').trim()); alias.push((f[3] || '').trim()); cnt.push(Number(f[2]) || 0);
    });
  }
  _tpLib = { names, cats, alias, cnt, set: new Set(names) };
  _tpCache.set(id, _tpLib);
}
function tpZhOf(en) { return (_tpZh && _tpZh.get(en)) || ''; }
// ===== 分组树 / 卡片行：插入面板和标签管理共用（大库只读那半边）=====
const KIND_ORDER = ['person', 'clothing', 'expression', 'sex', 'scene', 'camera', 'object', 'style'];
const CAT_ORDER = [['c0', 'General'], ['c1', 'Artist'], ['c3', 'Copyright'], ['c4', 'Character'], ['c5', 'Meta'], ['cx', 'Other']];
const KIND_LABEL = {
  person: 'Person', 'person/hair': 'Hair', 'person/eyes': 'Eyes', 'person/body': 'Body', 'person/count': 'People count',
  clothing: 'Clothing', 'clothing/whole': 'Full outfit', 'clothing/top': 'Top', 'clothing/bottom': 'Bottom',
  'clothing/legwear': 'Legwear', 'clothing/footwear': 'Footwear', 'clothing/head': 'Headwear', 'clothing/accessory': 'Accessory', 'clothing/other': 'Clothing other',
  expression: 'Expression', 'expression/face': 'Facial expression', 'expression/pose': 'Pose', 'expression/action': 'Action',
  sex: 'Sexual', 'sex/act': 'Act', 'sex/body': 'Body', 'sex/gear': 'Gear',
  scene: 'Scene', 'scene/indoor': 'Indoor', 'scene/outdoor': 'Outdoor', 'scene/nature': 'Nature', 'scene/sky': 'Sky / weather', 'scene/background': 'Background',
  camera: 'Camera angle', 'camera/shot': 'Shot', 'camera/angle': 'Angle', 'camera/framing': 'Framing',
  object: 'Object', 'object/weapon': 'Weapon', 'object/food': 'Food', 'object/tool': 'Tool', 'object/toy': 'Toy', 'object/other': 'Furniture',
  style: 'Style / quality', 'style/medium': 'Medium', 'style/quality': 'Quality', 'style/color': 'Color / light',
  // >>> tag-groups（_gen_tag_kind_from_wiki.py 生成，别手改）
  'camera/image_composition': 'image_composition',
  'clothing/accessories': 'accessories',
  'clothing/attire': 'attire',
  'clothing/eyewear': 'eyewear',
  'clothing/headwear': 'headwear',
  'clothing/legwear': 'legwear',
  'expression/face_tags': 'face_tags',
  'expression/gestures': 'gestures',
  'expression/posture': 'posture',
  'expression/verbs_and_gerunds': 'verbs_and_gerunds',
  'object/_species_(female)': '_species_(female)',
  'object/_species_(male)': '_species_(male)',
  'object/artistic_license': 'artistic_license',
  'object/ass': 'ass',
  'object/audio_tags': 'audio_tags',
  'object/bra': 'bra',
  'object/breasts_tags': 'breasts_tags',
  'object/cards': 'cards',
  'object/cats': 'cats',
  'object/censorship': 'censorship',
  'object/character_count': 'character_count',
  'object/companies_and_brand_names': 'companies_and_brand_names',
  'object/covering': 'covering',
  'object/dances': 'dances',
  'object/dogs': 'dogs',
  'object/doors_and_gates': 'doors_and_gates',
  'object/drawing_software': 'drawing_software',
  'object/dress': 'dress',
  'object/ears_tags': 'ears_tags',
  'object/embellishment': 'embellishment',
  'object/family_relationships': 'family_relationships',
  'object/feet': 'feet',
  'object/fine_art_parody': 'fine_art_parody',
  'object/fire': 'fire',
  'object/flowers': 'flowers',
  'object/focus_tags': 'focus_tags',
  'object/food_tags': 'food_tags',
  'object/groups': 'groups',
  'object/hands': 'hands',
  'object/handwear': 'handwear',
  'object/history': 'history',
  'object/holidays_and_celebrations': 'holidays_and_celebrations',
  'object/japanese_dialects': 'japanese_dialects',
  'object/jobs': 'jobs',
  'object/lighting': 'lighting',
  'object/makeup': 'makeup',
  'object/mask': 'mask',
  'object/metatags': 'metatags',
  'object/nudity': 'nudity',
  'object/panties': 'panties',
  'object/patterns': 'patterns',
  'object/penis': 'penis',
  'object/phrases': 'phrases',
  'object/piercings': 'piercings',
  'object/pixiv_projects': 'pixiv_projects',
  'object/prints': 'prints',
  'object/pussy': 'pussy',
  'object/scan': 'scan',
  'object/shoulders': 'shoulders',
  'object/sleeves': 'sleeves',
  'object/subjective': 'subjective',
  'object/symbols': 'symbols',
  'object/tail': 'tail',
  'object/technology': 'technology',
  'object/text': 'text',
  'object/theme': 'theme',
  'object/visual_aesthetic': 'visual_aesthetic',
  'object/water': 'water',
  'object/wings': 'wings',
  'person/birds': 'birds',
  'person/body_parts': 'body_parts',
  'person/eyes_tags': 'eyes_tags',
  'person/hair': 'hair',
  'person/hair_color': 'hair_color',
  'person/hair_styles': 'hair_styles',
  'person/legendary_creatures': 'legendary_creatures',
  'person/neck_and_neckwear': 'neck_and_neckwear',
  'person/people': 'people',
  'person/skin_color': 'skin_color',
  'person/skin_folds': 'skin_folds',
  'scene/backgrounds': 'backgrounds',
  'scene/locations': 'locations',
  'scene/real_world_locations': 'real_world_locations',
  'scene/role-playing_games': 'role-playing_games',
  'scene/sports': 'sports',
  'sex/sex_acts': 'sex_acts',
  'sex/sex_objects': 'sex_objects',
  'sex/sexual_attire': 'sexual_attire',
  'sex/sexual_positions': 'sexual_positions',
  'sex/simulated_sex_acts': 'simulated_sex_acts',
  'style/board_games': 'board_games',
  'style/colors': 'colors',
  'style/fashion_style': 'fashion_style',
  'style/fighting_games': 'fighting_games',
  'style/meme': 'meme',
  'style/platform_games': 'platform_games',
  'style/shooter_games': 'shooter_games',
  'style/video_game': 'video_game',
  'style/visual_novel_games': 'visual_novel_games',
  'style/year_tags': 'year_tags',
  // <<< tag-groups
};
// 分组计数：跟着「排除兽类」走，按 库|是否排除 缓存
// 库侧计数：库内每个标签算一次；归类 = libs[libId].place，没有就按 CSV 桶 / 细分大类
function libCounts(libId, hideFurry) {
  const key = libId + '|' + (hideFurry ? 1 : 0) + '|' + (_tpFav ? 1 : 0) + '|' + _tpExword.join(',') + '|' + _tpExcat.join(',') + '|v' + _tpDocV;
  let c = _tpCountsCache.get(key);
  if (c) return c;
  const lib = _tpCache.get(libId);
  const hiddenSet = new Set(tpLibHidden(libId));   // 被我删掉的默认标签：数字里也别算
  const st = (_tagDoc.libs || {})[libId] || {};
  const place = st.place || {};
  const favs = new Set(st.fav || []);
  c = {};
  const seen = new Set();
  const cnt = (nm, cat, libCat) => {
    c[''] = (c[''] || 0) + 1;
    if (cat) {
      c[cat] = (c[cat] || 0) + 1;
      if (String(cat).slice(0, 2) === 'k:') { const pk = 'k:' + String(cat).slice(2).split('/')[0]; if (pk !== cat) c[pk] = (c[pk] || 0) + 1; }
    } else {
      const ck = 'c' + ('01345'.indexOf(libCat) >= 0 ? libCat : 'x');
      c[ck] = (c[ck] || 0) + 1;
      const k = tpKindOf(nm);
      if (k) { c['k:' + k] = (c['k:' + k] || 0) + 1; const pk = 'k:' + k.split('/')[0]; if (pk !== 'k:' + k) c[pk] = (c[pk] || 0) + 1; }
    }
  };
  if (lib) {
    for (let i = 0; i < lib.names.length; i++) {
      const nm = lib.names[i];
      if (hiddenSet.has(nm) || seen.has(nm)) continue;
      seen.add(nm);
      if (hideFurry && tpFurry(lib.cats[i], nm)) continue;
      if (_tpFav && !favs.has(nm)) continue;
      if (_tpExcat.length && _tpExcat.indexOf('c' + ('01345'.indexOf(lib.cats[i]) >= 0 ? lib.cats[i] : 'x')) >= 0) continue;
      if (_tpExword.length) {
        const rec = tpItem(nm);
        const hay = (nm + ' ' + (lib.alias[i] || '') + ' ' + ((rec && rec.zh) || tpZhOf(nm))).toLowerCase();
        if (_tpExword.some((w) => hay.indexOf(w) >= 0)) continue;
      }
      cnt(nm, place[nm] || '', lib.cats[i]);
    }
  }
  // 我加进这个库的标签（CSV 里没有，但有库侧归类）
  Object.keys(place).forEach((nm) => {
    if (seen.has(nm) || hiddenSet.has(nm)) return;
    if (lib && lib.set && lib.set.has(nm)) return;
    seen.add(nm);
    if (_tpFav && !favs.has(nm)) return;
    cnt(nm, place[nm], '');
  });
  _tpCountsCache.set(key, c);
  return c;
}
// 左栏：CSV 分类号桶 + 细分大类（可展开成子类文件夹）N
function libCats(libId, hideFurry) {
  const c = libCounts(libId, hideFurry);
  const rows = [{ id: CM_ALL, label: ezT('All'), n: c[''] || 0, depth: 0 }];
  CAT_ORDER.forEach(([v, l]) => { if (c[v]) rows.push({ id: v, label: ezT(l), n: c[v], depth: 0, canDrag: true, side: 'lib' }); });
  KIND_ORDER.forEach((k) => {
    const n = c['k:' + k] || 0;
    if (!_libOpen.size && !_libTouched) KIND_ORDER.forEach((x) => _libOpen.add(x));   // 默认全展开，细分组才看得见
  const open = _tpFlat || _libOpen.has(k);
    rows.push({ id: 'k:' + k, label: ezT(KIND_LABEL[k]), n, depth: 0, top: _tpFlat ? '' : k, open, canDrag: true, side: 'lib' });
    if (!open) return;
    const subs = [];
    Object.keys(c).forEach((key) => {
      if (key.slice(0, 2) !== 'k:') return;
      const kk = key.slice(2);
      if (kk === k || kk.split('/')[0] !== k) return;
      subs.push({ id: key, label: ezT(KIND_LABEL[kk] || kk.split('/')[1]), n: c[key], depth: 1 });
    });
    subs.sort((a, b) => b.n - a.n);
    subs.forEach((s) => rows.push(Object.assign({ side: 'lib' }, s)));
  });
  return rows;
}
// 「我的标签」是按名字覆盖库的：同名字条目的中文/颜色/权重算覆盖；记录里 mine=true 才代表存在副本
function tagMineOf() {
  const m = new Map();
  _tagDoc.tags.forEach((t) => { if (t.name) m.set(String(t.name), t); });
  return m;
}
// ===== 两套空间：库侧一份、我的标签副本一份，归类/收藏各自独立 =====
// 记录 mine=true 才代表有「我的标签副本」；库侧归类/收藏存在 libs[libId].place / .fav
function tpItem(name) { return tagMineOf().get(String(name)) || null; }              // 记录（可能只是库侧元数据）
function tpMine(name) { const t = tpItem(name); return (t && t.mine) ? t : null; }   // 我的标签副本
function tpMineEnsure(name) {
  const nm = String(name || ''); if (!nm) return null;
  let t = tpItem(nm);
  if (!t) { t = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: nm, category: '' }; _tagDoc.tags.push(t); }
  t.mine = true;
  return t;
}
function tpMineDrop(name) {   // 删掉我的标签副本；库侧的中英/颜色/预览还要用就留着记录
  const t = tpItem(name); if (!t) return;
  t.mine = false; delete t.fav;
  if (!t.category && !t.zh && !t.color && !t.preview && !t.weight && t.collectedFrom === undefined) _tagDoc.tags = _tagDoc.tags.filter((x) => x !== t);
}
// 删预览图：只有「删除标签」才调（不是「移动/恢复」）——base64 是 json 体积大头，删了可重新生成；
// 清完没别的含义就把这条空记录整个回收（不然删过的标签还会在 json 里留个只有预览的影子）。
function tpDropPreview(name) {
  const t = tpItem(name); if (!t || !t.preview) return;
  delete t.preview;
  if (!t.mine && !t.category && !t.zh && !t.color && !t.weight && t.collectedFrom === undefined) _tagDoc.tags = _tagDoc.tags.filter((x) => x !== t);
}
function tpPlaceOf(name) { const st = _tpLibId ? tpLibState(_tpLibId) : null; return (st && st.place && st.place[String(name)]) || ''; }
function tpPlaceSet(name, cat) {
  if (!_tpLibId) return;
  const st = tpLibState(_tpLibId); st.place = st.place || {};
  if (cat) st.place[String(name)] = String(cat); else delete st.place[String(name)];
}
function tpLibFavOf(name) { const st = _tpLibId ? tpLibState(_tpLibId) : null; return !!(st && st.fav && st.fav.indexOf(String(name)) >= 0); }
function tpLibFavSet(name, on) {
  if (!_tpLibId) return;
  const st = tpLibState(_tpLibId); st.fav = (st.fav || []).filter((x) => x !== String(name));
  if (on) st.fav.push(String(name));
}
// 库侧那份的显示覆盖（中英/颜色/权重）；预览图共用，存在记录里
function tpLibMeta(name) { const st = _tpLibId ? tpLibState(_tpLibId) : null; return (st && st.meta && st.meta[String(name)]) || null; }
function tpLibMetaSet(name, patch) {
  if (!_tpLibId) return;
  const st = tpLibState(_tpLibId); st.meta = st.meta || {};
  const nm = String(name);
  const m = st.meta[nm] || (st.meta[nm] = {});
  Object.keys(patch).forEach((k) => { const v = patch[k]; if (v === undefined || v === null || v === '') delete m[k]; else m[k] = v; });
  if (!Object.keys(m).length) delete st.meta[nm];
}
function tpKey(side, name) { return side + ':' + name; }
function tpKeySide(key) { const i = String(key).indexOf(':'); return i < 0 ? 'lib' : String(key).slice(0, i); }
function tpKeyName(key) { const i = String(key).indexOf(':'); return i < 0 ? String(key) : String(key).slice(i + 1); }

// 我的标签副本是否命中某个分类（不建名字表，批量筛选时才不会卡）；ids = 该分类整棵子树的 id
function mineHitRec(cat, rec, ids) {
  if (!rec) return false;
  if (cat === CM_ALL || cat === '__mine__') return true;
  if (cat === '__fav__') return !!rec.fav;
  const c = String(rec.category || '');
  if (cat === UNCAT_ID) return !c || !!(ids && ids.has(c));
  if (!c) return false;
  return ids ? ids.has(c) : c === String(cat);
}
// 库 + 我的合并成一张卡片表；同一标签两侧各出一张（side 区分）
function mergedRows(libId, cat, q, limit) {
  const lib = libId ? _tpCache.get(libId) : null;
  const hiddenSet = new Set(tpLibHidden());
  const st = (_tagDoc.libs || {})[libId] || {};
  const place = st.place || {};
  const favSet = new Set(st.fav || []);
  const meta = st.meta || {};                  // 库侧显示覆盖（中英/颜色/权重）
  const mineMap = tagMineOf();                 // 名字表只建一次（大库时别每条都重建）
  const catIds = (cat && cat !== CM_ALL && cat !== '__fav__' && cat !== '__mine__' && cat !== '__lib__') ? tpSubIds(cat) : null;
  const qq = String(q || '').trim().toLowerCase();
  const out = [];
  const libHit = (en, libCat) => {
    if (cat === CM_ALL || cat === '__lib__') return true;
    if (cat === '__fav__') return favSet.has(en);
    if (cat === UNCAT_ID || cat === '__mine__') return false;
    const p = place[en];
    if (p) return String(p) === String(cat);
    if (String(cat).slice(0, 2) === 'k:') {
      const want = String(cat).slice(2);
      const k = tpKindOf(en);
      return want.indexOf('/') >= 0 ? k === want : k.split('/')[0] === want;
    }
    return String(cat) === 'c' + ('01345'.indexOf(libCat) >= 0 ? libCat : 'x');
  };
  if (lib) {
    for (let i = 0; i < lib.names.length; i++) {
      const en = lib.names[i];
      if (hiddenSet.has(en)) continue;
      const aliases = lib.alias[i] || '';
      const rec = mineMap.get(en);
      const lm = meta[en] || null;
      const zh = (lm && lm.zh) || tpZhOf(en);   // 库侧显示只认库侧覆盖 + 自动中英
      if (!libHit(en, lib.cats[i])) continue;
      if (_tpFav && !favSet.has(en)) continue;
      if (_tpExcat.length && _tpExcat.indexOf('c' + ('01345'.indexOf(lib.cats[i]) >= 0 ? lib.cats[i] : 'x')) >= 0) continue;
      if (_tpEx621 && tpFurry(lib.cats[i], en)) continue;
      if (_tpExword && _tpExword.length && _tpExword.some((w) => (en + ' ' + aliases + ' ' + zh).toLowerCase().indexOf(w) >= 0)) continue;
      if (qq && en.toLowerCase().indexOf(qq) < 0 && String(zh || '').toLowerCase().indexOf(qq) < 0 && aliases.toLowerCase().indexOf(qq) < 0) continue;
      out.push({ en, zh: zh || '', color: (lm && lm.color) || '', weight: (lm && lm.weight) || '', preview: (rec && rec.preview) || '', n: Number(lib.cnt[i] || 0), side: 'lib', key: tpKey('lib', en), item: rec || null, fav: favSet.has(en) });
      if (limit && out.length >= limit) break;
    }
  }
  // 我加进库里的标签（CSV 里没有，但有库侧归类）
  const placeNames = Object.keys(place);
  for (let i = 0; i < placeNames.length; i++) {
    const en = placeNames[i];
    if (!en || hiddenSet.has(en) || (lib && lib.set && lib.set.has(en))) continue;
    if (!libHit(en, '')) continue;
    if (_tpFav && !favSet.has(en)) continue;
    if (_tpEx621 && tpFurry('', en)) continue;
    const rec = mineMap.get(en);
    const lm = meta[en] || null;
    const zh = (lm && lm.zh) || tpZhOf(en);
    if (_tpExword && _tpExword.length && _tpExword.some((w) => (en + ' ' + zh).toLowerCase().indexOf(w) >= 0)) continue;
    if (qq && en.toLowerCase().indexOf(qq) < 0 && String(zh || '').toLowerCase().indexOf(qq) < 0) continue;
    out.push({ en, zh: zh || '', color: (lm && lm.color) || '', weight: (lm && lm.weight) || '', preview: (rec && rec.preview) || '', n: 0, side: 'lib', key: tpKey('lib', en), item: rec || null, fav: favSet.has(en) });
    if (limit && out.length >= limit) break;
  }
  for (let i = 0; i < _tagDoc.tags.length; i++) {
    const t = _tagDoc.tags[i];
    if (!t.mine) continue;
    const en = String(t.name || '');
    if (!en) continue;
    if (!mineHitRec(cat, t, catIds)) continue;
    if (_tpFav && !t.fav) continue;
    if (_tpEx621 && tpFurry('', en)) continue;
    const lm = meta[en] || null;
    const zh = t.zh || (lm && lm.zh) || tpZhOf(en);   // 我的侧优先自己的覆盖，再退回库侧
    if (_tpExword && _tpExword.length && (en + ' ' + (zh || '')).toLowerCase().indexOf(_tpExword[0]) >= 0) continue;
    if (qq && en.toLowerCase().indexOf(qq) < 0 && String(zh || '').toLowerCase().indexOf(qq) < 0) continue;
    out.push({ en, zh: zh || '', color: t.color || (lm && lm.color) || '', weight: t.weight || (lm && lm.weight) || '', preview: t.preview || '', n: 0, side: 'mine', key: tpKey('mine', en), item: t, mine: true, own: !(lib && lib.set.has(en)), fav: !!t.fav });
    if (limit && out.length >= limit) break;
  }
  if (_tpSort === 'count') out.sort((a, b) => b.n - a.n);
  else if (_tpSort === 'name') out.sort((a, b) => a.en.localeCompare(b.en));
  return out;
}
// 面板里的卡片和标签管理用同一套样式：缩略区显示中文，下面一行英文
// 卡片：上面预览区（没预览图就一个小图图标，中文不放里面），下面「中文 / 英文」各一行居中
function tpTile(en, zh, onClick) {
  const tile = el('div', 'eph-cm-tile');
  tile.title = en;
  const pv = el('div', 'eph-cm-tile-pv');
  const ico = el('div', 'eph-cm-tile-ico');
  ico.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4 17.5l5-5 4 4 3-3 4 4"/></svg>';
  pv.appendChild(ico);
  tile.appendChild(pv);
  if (zh) { const z = el('div', 'eph-cm-tile-zh'); z.textContent = zh; tile.appendChild(z); }
  const nm = el('div', 'eph-cm-tile-name'); nm.textContent = en;
  tile.appendChild(nm);
  if (onClick) tile.addEventListener('click', onClick);
  return tile;
}
// ===== 面板上方那个「已插入」框：专门放标签样式（上中文下英文），提示词里只写普通文字 =====
// ===== 权重：cfg = { layers:['(', '['], w:1.2 }；layers[0] 是最里层，数值只写在 () 里 =====
// 引用画师：插入画师标签时的写法模板（全局一份，存 localStorage；{art} = 标签名，如 '@{art}' / 'artist:{art}'）
const ARTIST_FMT_LS = 'ezflex.artistFmt';
function tpArtistFmt() { try { return localStorage.getItem(ARTIST_FMT_LS) || ''; } catch (_) { return ''; } }
function tpSetArtistFmt(v) { try { v ? localStorage.setItem(ARTIST_FMT_LS, v) : localStorage.removeItem(ARTIST_FMT_LS); } catch (_) {} }
function tpArtistName(en) {
  const tpl = tpArtistFmt();
  const lib = _tpLibId ? _tpCache.get(_tpLibId) : null;
  if (!tpl || !lib || !lib.set || !lib.set.has(en)) return en;
  const i = lib.names.indexOf(en);
  return String(lib.cats[i] || '') === '1' ? tpl.replace('{art}', en) : en;   // 画师 = CSV category 1
}
function tpFmt(en, cfg) {
  const nm = tpArtistName(en);
  if (!cfg || !cfg.layers || !cfg.layers.length) return nm;
  let out = nm;
  cfg.layers.forEach((br) => {
    const close = br === '(' ? ')' : (br === '[' ? ']' : '}');
    const num = (br === '(' && cfg.w && Number(cfg.w) !== 1) ? ':' + cfg.w : '';
    out = br + out + num + close;
  });
  return out;
}
// [(tag:1.2)] -> { en:'tag', layers:['(', '['], w:1.2 }
function tpParsePiece(txt) {
  let t = String(txt || '').trim();
  const layers = [];
  let w = 1;
  const pair = { '(': ')', '[': ']', '{': '}' };
  for (;;) {
    const a = t.charAt(0), z = t.charAt(t.length - 1);
    if (!pair[a] || z !== pair[a] || t.length < 3) break;
    layers.push(a);
    t = t.slice(1, -1).trim();
  }
  layers.reverse();
  const m = /:([0-9.]+)$/.exec(t);
  if (m) { w = Number(m[1]) || 1; t = t.slice(0, m.index).trim(); }
  return { en: t.trim(), layers: layers, w: w };
}
function tpwCfg(en) {
  const c = _tpW.get(en);
  return { layers: (c && c.layers) ? c.layers.slice() : [], w: (c && c.w) ? c.w : 1 };
}
// 改权重：提示词里的写法同步改写
function tpwApply(en, cfg) {
  if (!en) return;
  const cur = _tpW.get(en) || null;
  const oldTxt = _tpAlt.get(en) || tpFmt(en, cur);
  if (cfg && cfg.layers && cfg.layers.length) _tpW.set(en, cfg); else _tpW.delete(en);
  const newTxt = tpFmt(en, _tpW.get(en) || null);
  if (cfg && cfg.layers && cfg.layers.length) _tpAlt.set(en, newTxt); else _tpAlt.delete(en);
  const ed = _tagPickTarget || _phActiveEditor;
  if (ed && oldTxt !== newTxt && !phReplaceText(ed, oldTxt, newTxt)) phReplaceText(ed, en, newTxt);
  if (_tpwEl) tpwFill(en);
  renderTagPanel();
}
function tpwFill(en) {
  const p = _tpwEl; if (!p) return;
  const cfg = tpwCfg(en);
  if (p._in && !p._busy) p._in.value = String(cfg.w);
  p._btns.forEach((b) => {
    const has = cfg.layers.indexOf(b._br) >= 0;
    b._minus.disabled = !has;
    b._grp.classList.toggle('on', has);
  });
}
function tpwEl() {
  if (_tpwEl && _tpwEl.parentNode) return _tpwEl;
  const p = el('div', 'eph-tpw');
  const r1 = el('div', 'eph-tpw-row');
  const inp = el('input', 'eph-tpw-in');
  inp.addEventListener('input', () => {
    const cfg = tpwCfg(_tpwEn);
    cfg.w = Number(inp.value) || 1;
    if (cfg.layers.indexOf('(') < 0) cfg.layers.push('(');
    p._busy = true; tpwApply(_tpwEn, cfg); p._busy = false;
  });
  const clr = el('button', 'eph-btn'); clr.textContent = ezT('Clear');
  clr.addEventListener('click', () => { tpwApply(_tpwEn, { layers: [], w: 1 }); if (p._in) p._in.value = '1'; });
  r1.appendChild(inp); r1.appendChild(clr);
  const r2 = el('div', 'eph-tpw-row');
  p._btns = [];
  ['(', '[', '{'].forEach((br) => {
    const grp = el('span', 'eph-tpw-grp');
    const lb = el('span', 'eph-tpw-lb');
    lb.textContent = br + (br === '(' ? ')' : (br === '[' ? ']' : '}'));
    const minus = el('button', 'eph-tpw-b'); minus.textContent = '−';
    const plus = el('button', 'eph-tpw-b'); plus.textContent = '+';
    const bump = (add) => {
      const cfg = tpwCfg(_tpwEn);
      const idx = cfg.layers.indexOf(br);
      if (add) cfg.layers.push(br);
      else if (idx >= 0) cfg.layers.splice(idx, 1);
      tpwApply(_tpwEn, cfg);
    };
    minus.addEventListener('click', () => bump(false));
    plus.addEventListener('click', () => bump(true));
    grp.appendChild(lb); grp.appendChild(minus); grp.appendChild(plus);
    r2.appendChild(grp);
    p._btns.push({ _br: br, _minus: minus, _grp: grp });
  });
  p.appendChild(r1); p.appendChild(r2);
  p.addEventListener('mouseenter', () => { if (_tpwTimer) { clearTimeout(_tpwTimer); _tpwTimer = null; } });
  p.addEventListener('mouseleave', () => tpwHide(260));
  document.body.appendChild(p);
  p._in = inp;
  _tpwEl = p;
  return p;
}
function tpwShow(en, anchor) {
  if (_tpwTimer) { clearTimeout(_tpwTimer); _tpwTimer = null; }
  const p = tpwEl();
  _tpwEn = en;
  tpwFill(en);
  p.classList.add('active');
  try {
    const r = anchor.getBoundingClientRect();
    const w = p.offsetWidth || 250, h = p.offsetHeight || 64;
    const left = Math.max(6, Math.min(r.left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(6, r.top - h - 6);
    p.style.left = left + 'px'; p.style.top = top + 'px';
  } catch (_) {}
}
function tpwHide(ms) {
  if (_tpwTimer) clearTimeout(_tpwTimer);
  _tpwTimer = setTimeout(() => { if (_tpwEl) _tpwEl.classList.remove('active'); _tpwTimer = null; }, ms || 0);
}
// 芯片：悬停出权重面板；点一下进手动编辑
function tpChip(en) {
  const cfg = _tpW.get(en);
  const sp = el('span', 'eph-tpi' + (cfg ? ' w' : ''));
  const mine = tagMineOf().get(en);
  const lm = tpLibMeta(en) || {};
  const a = el('span', 'eph-tpi-zh'); a.textContent = (mine && mine.zh) || lm.zh || tpZhOf(en) || en;
  const alt = _tpAlt.get(en) || '';
  const b = el('span', 'eph-tpi-en'); b.textContent = alt || tpFmt(en, cfg);   // 没权重也要过 tpFmt（引用画师前缀在里面）
  if (!tpInLibrary(en)) sp.classList.add('tmp');
  b.title = ezT('Click to change weight');
  const x = el('b', 'eph-tpi-x'); x.textContent = '×'; x.title = ezT('Delete');
  x.addEventListener('click', (e) => { e.stopPropagation(); tpwHide(0); tpRemove(en); });
  sp.addEventListener('mouseenter', () => { if (!_tpwSuppress) tpwShow(en, sp); });
  sp.addEventListener('mouseleave', () => tpwHide(260));
  sp.addEventListener('click', (e) => { e.stopPropagation(); tpwHide(0); tpInsEdit(); });
  sp.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    tpwHide(0);   // 右键先把悬停出来的权重小窗收掉，别再挡着菜单
    const inLib = !!(_tpLibId && _tpCache.get(_tpLibId) && _tpCache.get(_tpLibId).set.has(en));
    // 库内有的标签才能编辑；不在库里的只给「保存标签」（新增到我的标签）
    cmMenu(e.clientX, e.clientY, inLib
      ? [[ezT('Edit tag'), () => tpEditCard({ en: en, zh: (mine && mine.zh) || lm.zh || tpZhOf(en), color: (mine && mine.color) || lm.color || '', item: mine || null, side: tpMine(en) ? 'mine' : 'lib' })]]
      : [[ezT('Save tag'), () => tpEditCard({ new: true, en: en, zh: tpZhOf(en), item: null })]]);
  });
  const col = (mine && mine.color) || lm.color || '';
  if (col) {
    sp.style.background = col;
    sp.style.borderColor = 'rgba(15,23,42,.10)';
    const fg = tpAutoFg(col);
    if (fg) { sp.style.color = fg; a.style.color = fg; b.style.color = fg; }
  }
  tpDragChip(sp, en);
  sp.appendChild(b); sp.appendChild(a); sp.appendChild(x);   // 英文在上、中文在下
  return sp;
}
// 手动编辑：整个已插入框变成纯文本（默认提示词那种形式），改完再变回芯片
function tpInsEdit() {
  const p = _tpEl; if (!p || p._editing) return;
  const box = p._ins;
  p._editing = true;
  box.innerHTML = '';
  const area = el('textarea', 'eph-tp-edit');
  area.value = _tpIns.map((en) => tpFmt(en, _tpW.get(en))).join(', ');
  tgAttach(area);
  box.appendChild(area);
  area.focus();
  try { area.setSelectionRange(area.value.length, area.value.length); } catch (_) {}
  const commit = () => {
    if (!p._editing) return;
    p._editing = false;
    const pieces = area.value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
    const names = [], cfgs = [];
    pieces.forEach((pc) => { const o = tpParsePiece(pc); if (o.en) { names.push(o.en); cfgs.push(o); } });
    const ed = _tagPickTarget || _phActiveEditor;
    if (ed) {
      const olds = _tpIns.map((en) => tpFmt(en, _tpW.get(en)));
      const txt = ed.textContent || '';
      const spots = [];
      olds.forEach((f) => { const k = txt.indexOf(f); if (k >= 0) spots.push({ s: k, e: k + f.length }); });
      spots.sort((a, b) => a.s - b.s);
      if (spots.length) {
        let rest = txt;
        for (let k = spots.length - 1; k >= 0; k--) rest = rest.slice(0, spots[k].s) + rest.slice(spots[k].e);
        const at = Math.min(spots[0].s, rest.length);
        const head = rest.slice(0, at).replace(/[ ,]+$/, '');
        const tail = rest.slice(at).replace(/^[ ,]+/, '');
        const joined = names.map((nm, k) => tpFmt(nm, { layers: cfgs[k].layers, w: cfgs[k].w })).join(', ');
        ed.textContent = (head ? head + ', ' : '') + joined + (tail ? ', ' + tail : '');
        ed.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    _tpW.clear();
    _tpIns = names.slice();
    names.forEach((nm, k) => { if (cfgs[k].layers.length || cfgs[k].w !== 1) _tpW.set(nm, { layers: cfgs[k].layers, w: cfgs[k].w }); });
    renderTagPanel();
  };
  area.addEventListener('blur', commit);
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); area.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); area.blur(); }
  });
}

function renderTpIns() {
  const p = _tpEl; if (!p || p._editing) return;
  const box = p._ins; box.innerHTML = '';
  if (!_tpIns.length) { const ph = el('span', 'eph-tp-ph'); ph.textContent = ezT('No tags'); box.appendChild(ph); }
  _tpIns.forEach((en) => box.appendChild(tpChip(en)));
}
  // 长按 300ms 进入拖动：按指针位置实时移动芯片，松手结算顺序
function tpDragChip(sp, en) {
  sp.dataset.en = en;
  sp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const box = _tpEl && _tpEl._ins;
    if (!box) return;
    const x0 = e.clientX, y0 = e.clientY;
    let long = false;
    const ph = el('span', 'eph-tpi-ph');
    let ghost = null;
    const timer = setTimeout(() => {
      long = true; _tpwSuppress = true; tpwHide(0);
      const rc0 = sp.getBoundingClientRect();
      ghost = sp.cloneNode(true);
      ghost.className = 'eph-tpi eph-tpi-ghost';
      ghost.style.width = rc0.width + 'px';
      ghost.style.left = rc0.left + 'px'; ghost.style.top = rc0.top + 'px';
      document.body.appendChild(ghost);
      const tail0 = box.querySelector('.eph-tpi-in');
      if (tail0) box.insertBefore(ph, tail0); else box.appendChild(ph);
      sp.classList.add('drag');
      if (sp.parentNode) sp.remove();                      // 从流里拿掉，位置由指示条表示
    }, 300);
    const stop = () => {
      clearTimeout(timer);
      _tpwSuppress = false;
      if (ghost) { ghost.remove(); ghost = null; }
      sp.classList.remove('drag');
      document.removeEventListener('pointermove', mv);
      document.removeEventListener('pointerup', up);
    };
    const mv = (ev) => {
      if (!long) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) stop();
        return;
      }
      try { const sel = window.getSelection(); if (sel && sel.removeAllRanges) sel.removeAllRanges(); } catch (_) {}
      if (ghost) { ghost.style.left = (ev.clientX + 12) + 'px'; ghost.style.top = (ev.clientY + 10) + 'px'; }
      // 指示条放到鼠标所在的槽位（横排换行，按"行 + 水平中点"判断）
      const kids = Array.from(box.querySelectorAll('.eph-tpi'));
      let before = null;
      for (const k of kids) {
        const rc = k.getBoundingClientRect();
        const after = (ev.clientY > rc.bottom) || (ev.clientY >= rc.top && ev.clientX > rc.left + rc.width / 2);
        if (!after) { before = k; break; }
      }
      const tail = box.querySelector('.eph-tpi-in');
      if (before) box.insertBefore(ph, before);
      else if (tail) box.insertBefore(ph, tail);
      else box.appendChild(ph);
    };
    const up = () => {
      clearTimeout(timer);
      document.removeEventListener('pointermove', mv);
      document.removeEventListener('pointerup', up);
      sp.classList.remove('drag');
      _tpwSuppress = false;
      if (ghost) { ghost.remove(); ghost = null; }
      if (!long) { if (ph.parentNode) ph.remove(); return; }
      if (ph.parentNode) box.insertBefore(sp, ph);        // 落在指示条的位置
      ph.remove();
      const order = Array.from(box.querySelectorAll('.eph-tpi')).map((k) => k.dataset.en).filter(Boolean);
      if (order.length === _tpIns.length && order.join('|') !== _tpIns.join('|')) tpReorder(order);
    };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
  });
}
// 结算顺序：提示词里的片段跟着重排（编辑器里有引用媒体芯片时只重排上面的框，不动正文）
function tpReorder(order) {
  _tpIns = order;
  const ed = _tagPickTarget || _phActiveEditor;
  const frags = order.map((en) => tpFmt(en, _tpW.get(en)));
  if (ed && frags.every((f) => (ed.textContent || '').indexOf(f) >= 0)) {
    const hasRefChip = ed.querySelectorAll && ed.querySelectorAll('.eph-mref').length > 0;
    if (!hasRefChip) {
      const orig = ed.textContent;
      const segs = frags.map((f) => ({ s: orig.indexOf(f), e: orig.indexOf(f) + f.length })).sort((a, b) => a.s - b.s);
      let rest = orig;
      for (let i = segs.length - 1; i >= 0; i--) rest = rest.slice(0, segs[i].s) + rest.slice(segs[i].e);
      const ins = Math.min(segs[0].s, rest.length);
      const head = rest.slice(0, ins).replace(/[\s,]+$/, '');
      const tail = rest.slice(ins).replace(/^[\s,]+/, '');
      ed.textContent = (head ? head + ', ' : '') + frags.join(', ') + (tail ? ', ' + tail : '');
      saveSelection();
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  renderTagPanel();
}
// 点卡片 = 进上面的框 + 在光标处写普通文字（已经在框里就不重复写）
function tpAdd(en) {
  const ed = _tagPickTarget || _phActiveEditor;
  if (_tpIns.indexOf(en) < 0) _tpIns.push(en);
  if (ed && !phTagRangeOf(ed, en)) phInsertPlain(ed, tpArtistName(en));   // 写进编辑器时也带引用画师前缀
  renderTagPanel();
}
function tpRemove(en) {
  _tpIns = _tpIns.filter((x) => x !== en);
  const ed = _tagPickTarget || _phActiveEditor;
  const cfg = _tpW.get(en);
  if (ed) phReplaceText(ed, _tpAlt.get(en) || tpFmt(en, cfg), en);   // 先把括号/转换后的写法变回裸标签，再删
  if (ed) phRemovePlain(ed, en);
  _tpW.delete(en);
  renderTagPanel();
}
// 编辑器里把文字删了 → 框里也跟着去掉（300ms 防抖，别每敲一下都算）
function tpSyncFromEditor() {
  const ed = _tagPickTarget; if (!ed) return;
  // 已插入 = 默认提示词的镜像：按 , ， 、 切分，正文变了这边就跟着变
  const pieces = String(ed.textContent || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
  const names = [], alts = [];
  // 引用画师加了前缀（@xxx / artist:xxx）：比对时要还原成裸标签名，否则高亮对不上
  const tpl = tpArtistFmt();
  const cut = tpl.indexOf('{art}');
  const pre = cut >= 0 ? tpl.slice(0, cut) : '', suf = cut >= 0 ? tpl.slice(cut + 5) : '';
  const strip = (n) => {
    if (!pre || n.indexOf(pre) !== 0) return n;
    let v = n.slice(pre.length);
    if (suf && v.slice(-suf.length) === suf) v = v.slice(0, -suf.length);
    return v.trim();
  };
  pieces.forEach((pc) => { const o = tpParsePiece(pc); if (o.en) { names.push(strip(o.en)); alts.push(pc); } });
  const same = names.length === _tpIns.length && names.every((n, i) => n === _tpIns[i]);
  _tpIns = names;
  _tpAlt.clear();
  names.forEach((n, i) => { if (alts[i] !== n) _tpAlt.set(n, alts[i]); });
  if (!same) renderTpIns();
}
// 这个名字在不在当前库里（不在 = 临时标签，虚线显示）
// 当前库的分组树根：我的标签 = categories；其他库 = libs[lib].groups（没有就播默认）
function tpRoot() { return _tpLibId ? tpSeedLibTree(_tpLibId) : _tagDoc.categories; }
function tpLibTree(id) {
  const st = (_tagDoc.libs || {})[id || ''];
  return (st && st.groups) || null;
}
// 默认分组树：桶分组 + 细分分组（及其子分类）。
// 别用 libCats() 拼 —— 它只对「当前展开着」的细分组输出子行，折叠过之后重建默认树会把子分类弄丢。
function tpDefaultTree(id) {
  const c = libCounts(id, _tpHideFurry);
  const out = [];
  CAT_ORDER.forEach(([v, l]) => { if (c[v]) out.push({ id: v, name: ezT(l), children: [] }); });
  KIND_ORDER.forEach((k) => {
    const kids = [];
    Object.keys(c).forEach((key) => {
      if (key.slice(0, 2) !== 'k:') return;
      const kk = key.slice(2);
      if (kk === k || kk.split('/')[0] !== k) return;
      kids.push({ id: key, name: ezT(KIND_LABEL[kk] || kk.split('/')[1]), children: [] });
    });
    kids.sort((a, b) => (c[b.id] || 0) - (c[a.id] || 0));
    out.push({ id: 'k:' + k, name: ezT(KIND_LABEL[k]), children: kids });
  });
  return out;
}
// 细分表换代（如换成官方 tag_group 分组）：库里存着的树是"纯默认树"时自动按新表重建一次。
// 有自建分组的库不动（要靠右键「恢复默认库分组」手动换），所以不会丢东西。
const TAG_KIND_V = 2;
function tpPureDefaultTree(arr) {
  return (arr || []).every((g) => {
    const s = String(g.id);
    return (s.slice(0, 2) === 'k:' || CAT_ORDER.some((c) => c[0] === s)) && tpPureDefaultTree(g.children);
  });
}
function tpSeedLibTree(id) {
  const st = tpLibState(id);
  const vk = 'ezflex.kindV.' + id;
  let seen = 0;
  try { seen = Number(localStorage.getItem(vk) || 0); } catch (_) {}
  if (st.groups && seen !== TAG_KIND_V && tpPureDefaultTree(st.groups)) delete st.groups;
  if (!st.groups) st.groups = tpDefaultTree(id);
  if (seen !== TAG_KIND_V) { try { localStorage.setItem(vk, String(TAG_KIND_V)); } catch (_) {} }   // 记下代次：之后不再动这棵树
  return st.groups;
}
// 把树摊成左栏的行（数量用 libCounts 的 id 计数）
function tpLibRows(id) {
  // 没改过：直接用生成的默认分组；「全部」那行由 renderTagPanel 统一排在最前，两处都不要再出
  if (!tpLibTree(id)) return libCats(id, _tpHideFurry).filter((r) => r.id !== CM_ALL).map((r) => Object.assign({}, r, { depth: (r.depth || 0) + 1 }));
  const c = libCounts(id, _tpHideFurry);
  // 折叠键：细分分组和 libCats 一样用裸 kind 名（走同一套 _libOpen），其它分组用分组 id
  const openKey = (gid) => { const k = String(gid); return k.slice(0, 2) === 'k:' ? k.slice(2) : k; };
  const openAt = (gid) => (_tpFlat || _libOpen.has(openKey(gid)) || (!_libOpen.size && !_libTouched));
  const out = [];
  // 父分组数字 = 自己 + 子分类。但 kind 行（k:）的计数在 libCounts 里已经含了它的 kind 子类，
  // 再往下加就会重复计一遍（父看起来是子的两倍），所以 kind 父不再累加 kind 子；自建子分类仍要加。
  const sum = (node) => {
    const id = String(node.id);
    let n = c[id] || 0;
    (node.children || []).forEach((k) => { if (id.slice(0, 2) === 'k:' && String(k.id).slice(0, 2) === 'k:') return; n += sum(k); });
    return n;
  };
  const walk = (arr, d) => (arr || []).forEach((g) => {
    if (String(g.id) === CM_ALL) return;   // 老数据里存过「全部」伪分组：跳过（面板已经有一行）
    const kids = g.children || [];
    out.push({ id: g.id, label: g.name, n: sum(g), depth: d + 1, canDrag: true, side: 'lib', top: kids.length ? openKey(g.id) : undefined, open: openAt(g.id) });
    if (kids.length && openAt(g.id)) walk(kids, d + 1);
  });
  walk(tpLibTree(id), 0);
  return out;
}
// 两棵树的根：我的分类 + 当前库的分组树（左栏里它们是并列的分组）
function tpRoots() {
  const out = [_tagDoc.categories];
  const t = _tpLibId ? tpSeedLibTree(_tpLibId) : null;   // 没播种过也要在（否则库分组行找不到节点）
  if (t) out.push(t);
  return out.filter((x) => Array.isArray(x));
}
function tpGroupNode(id) {
  let hit = null;
  const walk = (arr) => (arr || []).forEach((g) => { if (String(g.id) === String(id)) hit = g; walk(g.children); });
  tpRoots().forEach(walk);
  return hit;
}
// 每个库的用户偏好：显示名 / 隐藏掉的默认标签（CSV 永不动）
function tpLibState(id) {
  _tagDoc.libs = _tagDoc.libs || {};
  const k = (id === undefined) ? _tpLibId : id;
  return _tagDoc.libs[k || ''] || (_tagDoc.libs[k || ''] = {});
}
function tpLibHidden(id) {
  const st = (_tagDoc.libs || {})[(id === undefined) ? (_tpLibId || '') : (id || '')];
  return (st && st.hidden) || [];
}
function tpIsDefault(en) {   // 当前库里"默认快照"有没有这个标签
  const lib = _tpLibId ? _tpCache.get(_tpLibId) : null;
  return !!(lib && lib.set && lib.set.has(en));
}
function tpInLibrary(en) {
  const lib = _tpLibId ? _tpCache.get(_tpLibId) : null;
  if (lib && lib.set && lib.set.has(en)) return true;
  return _tagDoc.tags.some((t) => t.name === en);
}
function tpWatch() {
  if (_tpObs) { _tpObs.disconnect(); _tpObs = null; }
  const ed = _tagPickTarget;
  if (!ed || !window.MutationObserver) return;
  _tpObs = new MutationObserver(() => { clearTimeout(_tpSyncTimer); _tpSyncTimer = setTimeout(tpSyncFromEditor, 120); });
  _tpObs.observe(ed, { childList: true, subtree: true, characterData: true });
}
// ★ 收藏：库侧和我的标签副本各算各的（同名字两边可以各收藏一次）
function tpCollected(name, side) { const t = side === 'mine' ? tpMine(name) : null; return side === 'mine' ? !!(t && t.fav) : tpLibFavOf(name); }
function tpCollect(name, side) {
  if (!name) return;
  if (side === 'mine') { const t = tpMine(name); if (t) t.fav = true; }
  else tpLibFavSet(name, true);
  savePromptTags(); renderTagPanel();
}
function tpUncollect(name, side) {
  if (side === 'mine') { const t = tpMine(name); if (t) delete t.fav; }
  else tpLibFavSet(name, false);
  savePromptTags(); renderTagPanel();
}
// 折叠/展开一个左栏分类：我的标签侧用 _myClosed（默认展开），库侧用 _libOpen
function catToggle(c) {
  if (!c || !c.top) return;
  if (c.my) { const k = String(c.id); if (_myClosed.has(k)) _myClosed.delete(k); else _myClosed.add(k); }
  else { if (_libOpen.has(c.top)) _libOpen.delete(c.top); else _libOpen.add(c.top); _libTouched = true; }
}
// 左栏渲染（插入面板 / 标签管理共用）：子文件夹可折叠
function renderCatRows(box, rows, sel, onPick, onToggle, onMenu) {
  box.innerHTML = '';
  rows.forEach((c) => {
    const row = el('div', 'eph-tp-cat' + (sel === c.id ? ' on' : ''));
    row.style.paddingLeft = (4 + (c.depth || 0) * 14) + 'px';   // 层级用真实缩进，别再用全角空格
    let caret = null;
    if (c.top) {
      caret = el('span', 'eph-tp-caret' + (c.open ? ' open' : ''));
      caret.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M9 6l6 6-6 6z"/></svg>';
      caret.title = ezT('Expand');
      caret.addEventListener('click', (e) => { e.stopPropagation(); catToggle(c); (onToggle || onPick)(); });
    }
    const nm = el('span', 'eph-tp-cat-nm'); nm.textContent = c.label; nm.title = c.label;
    c._nm = nm; c._label = c.label;
    const n = el('span', 'eph-tp-cat-n'); n.textContent = String(c.n);
    row.appendChild(nm); if (caret) row.appendChild(caret); row.appendChild(n);   // 三角放文字右侧
    if (sel === c.id && _tpScrollSel) { _tpScrollSel = false; try { row.scrollIntoView({ block: 'nearest' }); } catch (_) {} }
    row.addEventListener('click', () => { catToggle(c); onPick(c.id); });
    if (onMenu) row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); onMenu(c, e); });
    // 落点分区：行的上下 1/4 = 插到前/后，中间一半 = 放进这个分组（成子分类）
    const zoneOf = (e) => { const rc = row.getBoundingClientRect(); const q = (e.clientY - rc.top) / Math.max(1, rc.height); return q < 0.25 ? 'before' : (q > 0.75 ? 'after' : 'into'); };
    const dropCls = { before: 'drop-before', after: 'drop-after', into: 'drop-in' };
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      row.classList.remove('drop-in', 'drop-before', 'drop-after');
      if (_tpDragCat) row.classList.add(dropCls[zoneOf(e)]);
      else if (_tpDragId) row.classList.add('drop-in');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-in', 'drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault(); row.classList.remove('drop-in', 'drop-before', 'drop-after');
      if (_tpDragCat) {                                   // 拖的是分组：挪分组
        const from = _tpDragCat; _tpDragCat = '';
        if (from !== c.id) tpCatDrop(from, c.id, zoneOf(e));
        return;
      }
      const from = _tpDragId; _tpDragId = '';             // 拖的是卡片：归类 / 复制到我的标签
      if (from && c.side) tagMoveTo([from], c.side, c.id);
      else if (from && c.root) tagMoveTo([from], c.root, '');   // 拖到「我的标签」根 = 未分类；拖到「库」根 = 回默认位置
    });
    // 普通分组行可拖；固定节点（我的标签 / 库 / 未分类）不给拖
    if (!c.fixed) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        if (_tpLibId) tpSeedLibTree(_tpLibId);   // 库分组第一次编辑：先按默认播一份可编辑树
        _tpDragCat = c.id;
        try { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
      });
      row.addEventListener('dragend', () => { _tpDragCat = ''; });
    }
    box.appendChild(row);
  });
}
// 卡片右上角 ★：只收藏当前这一侧（side）
function tpCollectBtn(row) {
  const on = tpCollected(row.en, row.side);
  const col = el('b', 'eph-cm-tile-collect' + (on ? ' on' : '')); col.textContent = '★';
  col.title = on ? ezT('Remove from collected') : ezT('Add to collected');
  col.addEventListener('click', (e) => { e.stopPropagation(); if (on) tpUncollect(row.en, row.side); else tpCollect(row.en, row.side); });
  return col;
}
function tagCatNode(id) {
  let hit = null;
  cmCatWalk(_tagDoc.categories, (it) => { if (String(it.id) === String(id)) hit = it; });
  return hit;
}
// 行内重命名：直接把分组名变成输入框（不弹窗）
function tpRenameInline(c, node) {
  const span = c && c._nm;
  if (!span || !span.parentNode || !node) return;
  const inp = el('input', 'eph-tp-rename');
  inp.value = node.name;
  span.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const commit = async (ok) => {
    if (done) return;
    done = true;
    if (ok) { const v = inp.value.trim(); if (v) node.name = catUniqName(catParentList(node.id), v, node); await savePromptTags(); }
    renderTagPanel();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  inp.addEventListener('blur', () => commit(true));
}
function tagCatMenu(node, x, y, ctx) {
  // 未分类：固定节点，只能改名 + 在下面新建分类（不移动、不删除）
  const fixed = !!(node && String(node.id) === UNCAT_ID);
  const items = [[ezT('New category'), async () => { await newTagCategory(node || null); renderTagPanel(); }]];
  if (node) {
    items.push([ezT('Rename'), () => tpRenameInline(ctx, node)]);
    if (!fixed) items.push([ezT('Move to category'), () => tpCatPickMenu(x + 8, y + 8, (it) => tpCatMoveTo(node.id, it.cat, it.side), { tree: tpTargetTree(), roots: true })]);
    if (!fixed) items.push([ezT('Delete category'), async () => {
      const del = new Set(); cmCatWalk([node], (it) => del.add(String(it.id)));
      // 里面的我的标签副本一起删掉；中英/颜色这类库侧还要用的元数据留着
      _tagDoc.tags = _tagDoc.tags.filter((t) => {
        if (!t.mine || !del.has(String(t.category || ''))) return true;
        t.mine = false; delete t.fav;
        return !!(t.zh || t.color || t.preview || t.weight || t.collectedFrom !== undefined);
      });
      const st = _tpLibId ? tpLibState(_tpLibId) : null;
      if (st && st.place) Object.keys(st.place).forEach((nm) => { if (del.has(String(st.place[nm] || ''))) delete st.place[nm]; });
      const rm = (list) => (list || []).filter((c) => { if (del.has(String(c.id))) return false; c.children = rm(c.children || []); return true; });
      _tagDoc.categories = rm(_tagDoc.categories);                    // 我的标签树
      if (st && st.groups) st.groups = rm(st.groups);                 // 当前库的分组树
      if (del.has(String(_tpCat))) _tpCat = CM_ALL;
      await savePromptTags(); renderTagPanel();
    }]);
  }
  cmMenu(x, y, items);
}
// 从树里摘出一个分类（返回节点）
function catDetach(id) {
  const walk = (arr) => {
    for (let i = 0; i < (arr || []).length; i++) {
      if (String(arr[i].id) === String(id)) return arr.splice(i, 1)[0];
      const got = walk(arr[i].children || []);
      if (got) return got;
    }
    return null;
  };
  for (const root of tpRoots()) { const got = walk(root); if (got) return got; }
  return null;
}
// 找到某个分类所在的同级数组
function catParentList(id) {
  let hit = null;
  const walk = (arr) => {
    if (hit) return;
    for (const c of (arr || [])) {
      if (String(c.id) === String(id)) { hit = arr; return; }
      walk(c.children || []);
    }
  };
  for (const root of tpRoots()) { hit = null; walk(root); if (hit) return hit; }
  return _tagDoc.categories;
}
// 目标是不是 from 自己或它的子孙（拖进自己里会把整棵子树搬到顶层）
function catInside(from, toId) {
  const node = catFind(from);
  if (!node) return false;
  let hit = false;
  cmCatWalk([node], (it) => { if (String(it.id) === String(toId)) hit = true; });
  return hit;
}
// 拖动落地：into = 放进目标分组里（成子分类），否则插到目标前/后（同级重排）
async function tpCatDrop(from, toId, mode) {
  if (String(from) === UNCAT_ID) return;                            // 未分类固定不动
  if (String(toId) === CM_ALL) return;                              // 「全部」是筛选行，不可作为目标
  const tid = String(toId);
  if (tid === '__mine__' || tid === '__lib__') {                    // 拖到根 = 放到那棵树顶层（和未分类平级）
    const side = tid === '__lib__' ? 'lib' : 'mine';
    if (side === 'lib' && !_tpLibId) return;
    await catMoveTo(from, { side: side, list: side === 'lib' ? tpSeedLibTree(_tpLibId) : _tagDoc.categories });
    return;
  }
  const target = catFind(toId);                        // 其它伪行没有节点，直接不接
  if (!target || catInside(from, toId)) return;
  if (mode === 'into') { await catMoveTo(from, { side: catSideOf(target), list: target.children = target.children || [], openId: toId }); return; }
  const dst = { side: catSideOf(target), list: catParentList(toId) };
  if (mode === 'before') dst.beforeId = toId; else dst.afterId = toId;
  await catMoveTo(from, dst);
}
// 多选（批量管理 / Ctrl / Shift）：单点只选它、Ctrl 切换、Shift 从上次点到这次连选（同卡片管理）
function tpPickTile(key, shift, mod) {
  const keys = _tpView.map((x) => x.key);
  const a = keys.indexOf(_tpLast), b = keys.indexOf(key);
  if (shift && a >= 0 && b >= 0) {
    if (!mod) _tpSel = new Set();
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) _tpSel.add(keys[k]);
  } else if (mod) {
    if (_tpSel.has(key)) _tpSel.delete(key); else _tpSel.add(key);
  } else {
    _tpSel = new Set([key]);
  }
  _tpLast = key;
  renderTagPanel();
}
// 翻页栏（同 MediaOut）：右 = 「第[x]页 · [x]个/页」永远贴右下角；左 = 页码（首尾 + 当前附近，中间省略号）。
// 左边列几个页码，按「左箭头和右组之间剩下的宽度」算（面板拉宽就多列几个）。
function tpPageBar(bar, cur, totalPages, total) {
  if (!bar) return;
  bar.innerHTML = '';
  bar.style.display = total ? 'flex' : 'none';
  const lbl = (t) => { const s = el('span'); s.textContent = t; return s; };
  const go = (n) => {   // 翻页：回列表顶部（勾选之类的重画不跳）
    _tpPage = Math.min(totalPages, Math.max(1, n));
    renderTagPanel();
    if (_tpEl && _tpEl._list) _tpEl._list.scrollTop = 0;
  };
  const mkBtn = (text, dis, fn) => { const b = el('button'); b.type = 'button'; b.textContent = text; b.disabled = !!dis; b.addEventListener('click', fn); return b; };
  // 右组先建好量宽度（贴右下角那两个输入），左边才知道自己能占多宽
  const r = el('div', 'eph-tp-page-r');
  r.appendChild(lbl(ezT('Page ')));
  const pageIn = el('input'); pageIn.type = 'number'; pageIn.min = '1'; pageIn.max = String(totalPages); pageIn.value = String(cur);
  pageIn.addEventListener('blur', () => { const v = parseInt(pageIn.value, 10); go(isNaN(v) ? 1 : v); });
  pageIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pageIn.blur(); } });
  r.appendChild(pageIn);
  r.appendChild(lbl(ezT(' · ')));
  const perIn = el('input'); perIn.type = 'number'; perIn.min = '1'; perIn.value = String(_tpPer); perIn.title = ezT('Items per page');
  perIn.addEventListener('blur', () => { _tpPer = Math.max(1, Math.min(2000, parseInt(perIn.value, 10) || TP_PER)); go(1); });
  perIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); perIn.blur(); } });
  r.appendChild(perIn);
  r.appendChild(lbl(ezT(' per page')));
  bar.appendChild(r);
  const w = bar.clientWidth || 0;
  const rw = r.offsetWidth || 0;
  const slots = w ? Math.max(7, Math.min(21, Math.floor((w - rw - 2 * 30 - 24) / 34))) : 8;   // 按钮 28 + 间距 6
  const left = el('div', 'eph-tp-page-l');
  left.appendChild(mkBtn('<', cur <= 1, () => go(cur - 1)));
  pageRange(cur, totalPages, slots).forEach((n) => {
    if (n === '...') { const d = el('span'); d.textContent = '…'; left.appendChild(d); return; }
    const b = mkBtn(String(n), false, () => go(n));
    if (n === cur) b.className = 'active';
    left.appendChild(b);
  });
  left.appendChild(mkBtn('>', cur >= totalPages, () => go(cur + 1)));
  bar.insertBefore(left, r);
}
// 卡片宽度按容器宽度算出"正好整除"的值：整行刚好排满（右侧不留空带），
// 最后一行卡片仍是正常宽度（不会像 flex-grow 那样被拉宽）
function tpCardWidth() {
  const list = _tpEl && _tpEl._list;
  if (!list) return;
  const W = list.clientWidth - 6;   // 6 = .eph-tp-list 的 padding-right（右侧留的那条缝）
  if (W <= 40) return;
  const gap = 6, n = Math.max(1, Math.floor((W + gap) / (108 + gap)));
  const cw = Math.max(84, Math.floor((W - (n - 1) * gap) / n));
  list.style.setProperty('--tp-card-w', cw + 'px');
}
function renderTagPanel() {
  const p = _tpEl; if (!p) return;
  tpCardWidth();
  if (p._batchBar) p._batchBar.classList.toggle('on', _tpBatch);
  if (p._ownHint) p._ownHint.classList.toggle('on', tgState());
  if (p._ownArtist) {   // 引用画师模板（全局）
    const a = tpArtistFmt();
    p._ownArtist.textContent = a || ezT('Artist reference');
    p._ownArtist.classList.toggle('on', !!a);
  }
  if (p._tDel) p._tDel.textContent = ezT('Delete') + (_tpSel.size ? ' (' + _tpSel.size + ')' : '');
  if (p._tMove) p._tMove.textContent = ezT('Move to group') + (_tpSel.size ? ' (' + _tpSel.size + ')' : '');
  // ===== 左栏第一层级：全部 / 已收藏 / 我的标签 / 库 =====
  tpSpecialCats();   // 未分类先就位
  const lst = _tpLibId ? tpLibState(_tpLibId) : {};
  const hiddenSet = new Set(tpLibHidden());
  const libFav = new Set(lst.fav || []);
  let libFavN = 0; libFav.forEach((nm) => { if (!hiddenSet.has(nm)) libFavN++; });
  let mineN = 0, mineFavN = 0;
  _tagDoc.tags.forEach((t) => { if (t.mine) { mineN++; if (t.fav) mineFavN++; } });
  const libN = _tpLibId ? (libCounts(_tpLibId, _tpHideFurry)[''] || 0) : 0;
  const mineLabel = tpLibState('__mine__').name || ezT('My tags');
  const libLabel = _tpLibId ? (lst.name || _tpLibId) : ezT('Library');
  const rows = [
    { id: CM_ALL, label: ezT('All'), n: libN + mineN, depth: 0, fixed: true },
    { id: '__fav__', label: ezT('Collected'), n: libFavN + mineFavN, depth: 0, fixed: true },
    { id: '__mine__', label: mineLabel, n: mineN, depth: 0, root: 'mine', fixed: true },
  ];
  // 我的副本计数：一次遍历建「分类 -> 直接成员」，再一次后序汇总（别每个节点都 filter 一遍）
  const mc = new Map();
  _tagDoc.tags.forEach((t) => { if (t.mine) { const k = String(t.category || ''); mc.set(k, (mc.get(k) || 0) + 1); } });
  const directOf = (id) => String(id) === UNCAT_ID ? ((mc.get('') || 0) + (mc.get(UNCAT_ID) || 0)) : (mc.get(String(id)) || 0);
  const sub = new Map();
  const calcSub = (node) => {
    let s = directOf(node.id);
    (node.children || []).forEach((k) => { s += calcSub(k); });
    sub.set(String(node.id), s);
    return s;
  };
  _tagDoc.categories.forEach(calcSub);
  (function walkMy(list, d) {
    (list || []).forEach((c) => {
      const kids = c.children || [];
      const open = _tpFlat || !_myClosed.has(String(c.id));
      const fx = String(c.id) === UNCAT_ID;   // 固定节点：只能改名 / 建子分类
      rows.push({ id: c.id, label: c.name, n: sub.get(String(c.id)) || 0, depth: d, canDrag: !fx, fixed: fx, side: 'mine', my: true, top: kids.length ? c.id : undefined, open });
      if (kids.length && open) walkMy(kids, d + 1);
    });
  })(_tagDoc.categories, 1);   // 我的分类挂在「我的标签」下面
  if (_tpLibId) {
    rows.push({ id: '__lib__', label: libLabel, n: libN, depth: 0, root: 'lib', fixed: true });
    rows.push(...tpLibRows(_tpLibId));
  }
  if (!rows.some((r) => r.id === _tpCat)) _tpCat = CM_ALL;
  renderCatRows(p._cats, rows, _tpCat,
    (id) => { _tpCat = id; _tpSel = new Set(); renderTagPanel(); },
    () => renderTagPanel(),
    (c, e) => {
      if (c.root === 'mine') {
        cmMenu(e.clientX, e.clientY, [
          [ezT('New category'), async () => { await newTagCategory(null, _tagDoc.categories); renderTagPanel(); }],   // 追加到该层最后
          [ezT('Rename'), () => tpRenameRoot('mine')],
          ['-'],
          [ezT('Restore default library'), () => { tpRecoverInto(tpSeedLibTree(_tpLibId)); tpRestoreLib(); }],
        ]);
        return;
      }
      if (c.root === 'lib') {
        cmMenu(e.clientX, e.clientY, [
          [ezT('New category'), async () => { await newTagCategory(null, tpSeedLibTree(_tpLibId)); renderTagPanel(); }],
          [ezT('Rename'), () => tpRenameRoot('lib')],
          ['-'],
          [ezT('Restore default library'), () => { tpRecoverInto(tpSeedLibTree(_tpLibId)); tpRestoreLib(); }],
        ]);
        return;
      }
      if (c.id === CM_ALL || c.id === '__fav__') return;
      const node = tpGroupNode(c.id);
      if (node) tagCatMenu(node, e.clientX, e.clientY, c);
    });
  const list = p._list;
  // 完整匹配列表：全选/反选按它算（不截断）；只在库/分组/搜索/排序/筛选/数据变了时才重建整张表
  // （大库有十几万条，翻页/重画不能再全量扫一遍）
  const sig = [_tpLibId, _tpCat, _tpQ, _tpSort, _tpFav, _tpEx621, _tpExword.join(','), _tpExcat.join(','), _tpDocV].join('|');
  if (sig !== _tpSig) { _tpSig = sig; _tpPage = 1; _tpView = mergedRows(_tpLibId, _tpCat, _tpQ, 0); }   // 换库/分组/筛选/数据变了 → 回第一页
  const all = _tpView;
  const totalPages = Math.max(1, Math.ceil(all.length / _tpPer));
  if (_tpPage > totalPages) _tpPage = totalPages;
  const cards = all.slice((_tpPage - 1) * _tpPer, (_tpPage - 1) * _tpPer + _tpPer);
  const keepTop = list.scrollTop;
  list.innerHTML = '';
  if (!cards.length) { const e = el('div', 'eph-cm-empty'); e.textContent = ezT('No tags here.'); list.appendChild(e); }
  cards.forEach((r) => {
    const tile = tpTile(r.en, r.zh, (e) => {
      if (_tpBatch) { tpPickTile(r.key, !!(e && e.shiftKey), !!(e && (e.ctrlKey || e.metaKey))); return; }   // 批量模式才有多选
      if (_tpIns.indexOf(r.en) >= 0) tpRemove(r.en); else tpAdd(r.en);   // 平时只有插入 / 取消插入
    });
    if (r.side === 'mine') tile.classList.add('mine');
    if (_tpSel.has(r.key)) tile.classList.add('sel');
    if (_tpIns.indexOf(r.en) >= 0) tile.classList.add('on');

    const pv = tile.querySelector('.eph-cm-tile-pv');
    if (r.preview) { pv.innerHTML = ''; const im = el('img'); im.src = r.preview; im.draggable = false; pv.appendChild(im); }
    if (r.color) { const zhEl = tile.querySelector('.eph-cm-tile-zh'); if (zhEl) { zhEl.style.background = r.color; const fg2 = tpAutoFg(r.color); if (fg2) zhEl.style.color = fg2; } }
    pv.appendChild(tpCollectBtn(r));
    tile.draggable = true;                                  // 左键按住拖到左侧分类 = 归类 / 复制到我的标签
    tile.addEventListener('dragstart', (e) => {
      _tpDragId = r.key;
      try { e.dataTransfer.setData('text/plain', r.key); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
    });
    tile.addEventListener('dragend', () => { _tpDragId = ''; });
    tile.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); tpCardMenu(r, e.clientX, e.clientY); });
    list.appendChild(tile);
  });
  _tpPages = totalPages; _tpTotalN = all.length;
  tpPageBar(p._tpPage, _tpPage, totalPages, all.length);
  list.scrollTop = keepTop;
  renderTpIns();
}
// 卡片右键：收藏 / 恢复默认（只去掉这一条覆盖，不碰别的我的标签）/ 编辑中英 / 删除
function tpSetMine(en, patch) {   // 只写库侧元数据（中英/颜色/预览/权重）；是否是我的副本看 mine
  let t = tagMineOf().get(en);
  if (!t) { t = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: en, category: '' }; _tagDoc.tags.push(t); }
  Object.assign(t, patch);
  savePromptTags();
  return t;
}
// 缩略图：本地图片缩到 160px 再存（免得 json 爆掉）
function tpImagePreview(file) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas');
        const k = Math.min(1, 160 / Math.max(1, Math.max(im.width, im.height)));
        c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      im.onerror = () => resolve('');
      im.src = String(fr.result || '');
    };
    fr.onerror = () => resolve('');
    fr.readAsDataURL(file);
  });
}
// 卡片编辑弹窗：左预览图，右英文/中文/中文底色
function tpEditCard(r) {
  const cur = r.item || null;
  const icon = () => { const ic = el('div', 'eph-cm-tile-ico'); ic.innerHTML = '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4 17.5l5-5 4 4 3-3 4 4"/></svg>'; return ic; };
  const ov = el('div', 'eph-cm active'); ov.style.zIndex = '100020';
  const box = el('div', 'eph-cm-box');
  const hd = el('div', 'eph-cm-hd');
  const t = el('b'); t.textContent = r.new ? ezT('New tag') : ezT('Edit tag');
  const close = el('button', 'eph-modal-close'); close.textContent = '✕'; close.style.marginLeft = 'auto';
  hd.appendChild(t); hd.appendChild(close);
  const body = el('div', 'eph-cm-body');
  const grid = el('div', 'eph-tpe');
  const left = el('div', 'eph-tpe-pv');
  const frame = el('div', 'eph-tpe-frame');
  if (cur && cur.preview) { const im = el('img'); im.src = cur.preview; frame.appendChild(im); }
  else frame.appendChild(icon());
  const file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.style.display = 'none';
  const pick = el('button', 'eph-btn'); pick.textContent = ezT('Choose image');
  const rm = el('button', 'eph-btn'); rm.textContent = ezT('Remove image');
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0]; if (!f) return;
    const url = await tpImagePreview(f);
    if (!url) return;
    frame.innerHTML = ''; const im = el('img'); im.src = url; frame.appendChild(im); frame._data = url;
  });
  pick.addEventListener('click', () => file.click());
  rm.addEventListener('click', () => { frame.innerHTML = ''; frame.appendChild(icon()); frame._data = ''; });
  left.appendChild(frame); left.appendChild(pick); left.appendChild(rm); left.appendChild(file);
  const right = el('div', 'eph-tpe-fields');
  const mkField = (label, input) => {
    const w = el('label', 'eph-tpe-f');
    const lb = el('span', 'eph-tpe-lb'); lb.textContent = label;
    w.appendChild(lb); w.appendChild(input);
    return w;
  };
  const enIn = el('input'); enIn.value = r.en;
  const zhIn = el('input'); zhIn.value = r.zh || '';              // 当前这一侧的显示中英
  const clIn = el('input'); clIn.type = 'color'; clIn.value = r.color || '#eef2ff';
  // 分组下拉：和「移动至」同一套候选（我的标签侧 + 库侧）；根节点只作标题
  const catSel = el('button', 'eph-btn');
  const catLabelOf = (side, v) => {
    if (!v || v === UNCAT_ID) return ezT('Uncategorized');
    const n = catFind(v);
    if (n) return n.name;
    const g = libCats(_tpLibId, _tpHideFurry).find((rr) => String(rr.id) === String(v));
    return g ? String(g.label) : String(v);
  };
  const setCat = (side, v) => { catSel._side = side; catSel._cat = String(v || ''); catSel._changed = true; catSel.textContent = catLabelOf(side, v); };
  catSel.addEventListener('click', () => {
    const rr = catSel.getBoundingClientRect();
    tpCatPickMenu(rr.left, rr.bottom + 4, (it) => setCat(it.side, it.cat), { current: { side: catSel._side, cat: catSel._cat } });
  });
  const prefill = (side, v) => { setCat(side, v); catSel._changed = false; };   // 预填不算"改了"
  if (r.new) {
    const cc = String(_tpCat || '');
    if (cc && cc !== CM_ALL && cc !== '__mine__' && cc !== '__fav__' && cc !== '__lib__' && tagCatNode(cc)) prefill('mine', cc);
    else if (cc && cc !== CM_ALL && cc !== '__mine__' && cc !== '__fav__' && cc !== '__lib__' && _tpLibId && tpGroupNode(cc)) prefill('lib', cc);
    else prefill('mine', '');
  } else if (r.side === 'lib') {
    prefill('lib', tpPlaceOf(r.en) || tpDerivedCat(r.en));   // 当前位置一起显示（没有显式归类就显示默认位置）
  } else {
    const mt = tpMine(r.en);
    prefill('mine', mt ? String(mt.category || '') : '');
  }
  right.appendChild(mkField(ezT('Tag text'), enIn));
  right.appendChild(mkField(ezT('Tag description'), zhIn));
  right.appendChild(mkField(ezT('Tag color'), clIn));
  right.appendChild(mkField(ezT('Group'), catSel));
  grid.appendChild(left); grid.appendChild(right);
  body.appendChild(grid);
  const foot = el('div', 'eph-cm-foot');
  const cancel = el('button', 'eph-btn'); cancel.textContent = ezT('Cancel');
  const ok = el('button', 'eph-btn eph-btn-save'); ok.textContent = ezT('OK');
  foot.appendChild(cancel); foot.appendChild(ok);
  body.appendChild(foot);
  box.appendChild(hd); box.appendChild(body); ov.appendChild(box); document.body.appendChild(ov);
  const shut = () => ov.remove();
  close.addEventListener('click', shut);
  cancel.addEventListener('click', shut);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) shut(); });
  ok.addEventListener('click', async () => {
    const nm0 = enIn.value.trim() || r.en;
    if (!nm0) return;
    // 同名（英文）提示：按"在哪里新建"给不同措辞；确认了才存（记录按名字唯一，会合并成一条）
    const dup = _tagDoc.tags.some((x) => x.name === nm0 && x.id !== (cur && cur.id));
    if (dup && !(await uiConfirm(_tpLibId
      ? ezT('The library already has a tag with the same content. Save anyway?')
      : ezT('My tags already has a tag with the same content. Save anyway?')))) return;
    // 改名：记录 / 库侧归类 / 库侧收藏 / 隐藏都跟着走
    if (!r.new && r.en && r.en !== nm0) {
      if (cur) cur.name = nm0;
      if (_tpLibId) {
        const st = tpLibState(_tpLibId);
        if (st.place && st.place[r.en] !== undefined) { st.place[nm0] = st.place[r.en]; delete st.place[r.en]; }
        if (st.fav) st.fav = st.fav.map((x) => (x === r.en ? nm0 : x));
        if (st.hidden) st.hidden = st.hidden.map((x) => (x === r.en ? nm0 : x));
        if (st.meta && st.meta[r.en] !== undefined) { st.meta[nm0] = st.meta[r.en]; delete st.meta[r.en]; }
      }
    }
    const mside = r.new ? (catSel._side || 'mine') : (r.side || 'mine');
    if (mside === 'lib') tpLibMetaSet(nm0, { zh: zhIn.value.trim(), color: clIn.value });   // 库侧只写库侧覆盖
    else { const rec = cur || tpSetMine(nm0, {}); rec.zh = zhIn.value.trim(); rec.color = clIn.value; }
    if (frame._data !== undefined) {   // 预览图共用，永远存在记录里
      const rec2 = cur || tpSetMine(nm0, {});
      rec2.preview = frame._data; if (!frame._data) delete rec2.preview;
    }
    if (r.new || catSel._changed) {   // 选了新落点才动归类；库侧「保持原样」不碰
      const side = catSel._side || 'mine', cat = String(catSel._cat || '');
      if (side === 'mine') { const t2 = tpMineEnsure(nm0); if (t2) t2.category = (cat === UNCAT_ID ? '' : cat); }
      else tpPlaceSet(nm0, cat);
    }
    await savePromptTags();
    shut();
    renderTagPanel();
  });
}


// ===== 标签提示：开启后卡片弹窗 / 总体编辑 / 搜索框 / 已插入框里打字就弹候选（英文 + 中文），↑↓ 选、回车/Tab 采用 =====
const TG_LS = 'ezflex.tagHint';
const TG_PAGE = 60, TG_BATCH = 120, TG_STEP = 20000;   // 一次渲染多少行 / 一次懒查收多少条 / 一次最多扫多少行
let _tgOn = false, _tgEl = null, _tgEd = null, _tgLen = 0, _tgRows = [], _tgSel = 0, _tgRect = null, _tgShown = 0;
let _tgQ = '', _tgTerms = [], _tgMin = 0, _tgCjk = false, _tgCursor = 0, _tgDone = true;   // 懒查游标：滚到底就接着往下扫
try { _tgOn = localStorage.getItem(TG_LS) === '1'; } catch (_) {}
function tgState() { return _tgOn; }
function tgSet(on) {
  _tgOn = !!on;
  try { localStorage.setItem(TG_LS, _tgOn ? '1' : '0'); } catch (_) {}
  if (!_tgOn) tgHide();
}
function tgBox() {
  if (_tgEl && _tgEl.parentNode) return _tgEl;
  _tgEl = el('div', 'eph-tgh');
  _tgEl.addEventListener('mousedown', (e) => e.preventDefault());   // 别把编辑器的光标抢走
  // 滚到底继续补候选：整库匹配都看得到，不是只有第一页
  _tgEl.addEventListener('scroll', () => { if (_tgEl.scrollTop + _tgEl.clientHeight >= _tgEl.scrollHeight - 24) tgMore(); });
  document.body.appendChild(_tgEl);
  return _tgEl;
}
// 候选要用的表（库列表 / 当前库 / 中文对照）：开了标签提示但还没打开过插入面板时，首用时补一次
async function tgEnsure() {
  if (!_tpLibs) { try { await tpLoadLibs(); } catch (_) {} }
  if (_tpLibId && !_tpCache.has(_tpLibId)) { try { await tpLoadLib(_tpLibId); } catch (_) {} }
  if (!_tpZh) { try { await tpLoadZh(); } catch (_) {} }
}
function tgHide() { if (_tgEl) { _tgEl.classList.remove('on'); _tgEl.innerHTML = ''; } _tgRows = []; _tgSel = 0; _tgEd = null; _tgDone = true; }
function tgOpen() { return !!(_tgEl && _tgEl.classList.contains('on') && _tgRows.length); }
// 小写名表：整库 14 万条时别每敲一个键都对全表 toLowerCase（按库缓存一份）
function tgLower(lib) {
  if (!lib._lower || lib._lower.length !== lib.names.length) lib._lower = lib.names.map((x) => x.toLowerCase());
  return lib._lower;
}
// 热度门槛：查得越短越只留热词（14 万条的库里，单字查询能命中几万条，但真正有用的就那么些）
// 打 3 个字符以上就不设门槛了 —— 越具体越准、结果也越少。
function tgMinCount(s) {
  const n = String(s || '').length;
  if (n >= 3) return 0;
  return n === 1 ? 1000 : 100;
}
// 多词归一：输入 "long hair" 也当 long_hair / long-hair 来匹配
function tgTermsOf(s) {
  if (s.indexOf(' ') < 0) return [s];
  return [s, s.replace(/\s+/g, '_'), s.replace(/\s+/g, '-')];
}
// 一条库记录命中吗（前缀 0 / 词首 1 / 中间 2 / 别名与中文 3）；不命中返回 null
function tgRowAt(lib, i, mine, s, terms, minCnt, cjk) {
  if (Number(lib.cnt[i] || 0) < minCnt) return null;
  const en = lib.names[i];
  const low = tgLower(lib)[i];
  let pre = 3, hit = false;
  for (let k = 0; k < terms.length; k++) {
    const p = low.indexOf(terms[k]);
    if (p === 0) { hit = true; pre = 0; break; }
    if (p > 0) { hit = true; const b = low.charAt(p - 1); if (b === '_' || b === '-') pre = Math.min(pre, 1); else pre = Math.min(pre, 2); }
  }
  let zh = '';
  if (!hit) {
    const al = String(lib.alias[i] || '').toLowerCase();
    if (al && terms.some((t) => al.indexOf(t) >= 0)) { hit = true; pre = 3; }
  }
  if (!hit && cjk) {
    zh = String(tpZhOf(en) || '').toLowerCase();
    if (zh && terms.some((t) => zh.indexOf(t) >= 0)) { hit = true; pre = 3; }
  }
  if (!hit) return null;
  const m = mine.get(en);
  return { en: en, zh: String((m && m.zh) || tpZhOf(en) || ''), pre: pre };
}
// 懒查：从游标处继续扫，凑一批（TG_BATCH 条）或扫够 TG_STEP 行就停 —— 「滚到底再往下查」靠它
function tgScanMore() {
  const lib = _tpLibId ? _tpCache.get(_tpLibId) : null;
  if (!lib || _tgDone) return;
  const hidden = new Set(tpLibHidden());
  const mine = tagMineOf();
  const want = _tgRows.length + TG_BATCH;
  let scanned = 0;
  while (_tgCursor < lib.names.length && scanned < TG_STEP && _tgRows.length < want) {
    const i = _tgCursor++;
    scanned++;
    if (hidden.has(lib.names[i])) continue;
    const row = tgRowAt(lib, i, mine, _tgQ, _tgTerms, _tgMin, _tgCjk);
    if (row) _tgRows.push(row);
  }
  if (_tgCursor >= lib.names.length) _tgDone = true;
}
// 输入变了：重置游标 + 先查一批，弹窗立刻有内容，剩下的滚到底再续
function tgReset(ed, q, len, rect) {
  _tgEd = ed; _tgLen = len; _tgQ = q; _tgTerms = tgTermsOf(q); _tgMin = tgMinCount(q);
  _tgCjk = /[\u3400-\u9fff]/.test(q);
  _tgRows = []; _tgSel = 0; _tgShown = 0; _tgCursor = 0; _tgDone = false;
  tgScanMore();
  if (!_tgRows.length) { tgHide(); return; }
  tgPaint(rect);
}
// 再渲染一页候选（滚到底 / 键盘走到列表外时调用）；候选渲染完了就继续往下查
function tgMore() {
  if (_tgShown >= _tgRows.length && !_tgDone) tgScanMore();   // 渲染完了候选 → 继续往下扫
  const box = tgBox();
  const end = Math.min(_tgRows.length, _tgShown + TG_PAGE);
  for (let i = _tgShown; i < end; i++) {
    const r = _tgRows[i];
    const row = el('div', 'eph-tgh-row' + (i === _tgSel ? ' on' : ''));
    const en = el('span', 'eph-tgh-en'); en.textContent = r.en;
    row.appendChild(en);
    if (r.zh) { const zh = el('span', 'eph-tgh-zh'); zh.textContent = r.zh; row.appendChild(zh); }
    row.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); tgPick(i); });
    row.addEventListener('mouseenter', () => tgSelect(i, false));   // 鼠标停在哪就高亮哪（和键盘同一个高亮）
    box.appendChild(row);
  }
  _tgShown = end;
}
// 高亮第 i 行：键盘和鼠标共用一份状态（键盘走的时候把没渲染的页补上并滚进视野）
function tgSelect(i, scroll) {
  if (i < 0 || i >= _tgRows.length) return;
  _tgSel = i;
  if (!_tgEl) return;
  while (_tgShown <= i) tgMore();
  const kids = _tgEl.children;
  for (let k = 0; k < kids.length; k++) kids[k].classList.toggle('on', k === i);
  if (scroll && kids[i] && kids[i].scrollIntoView) { try { kids[i].scrollIntoView({ block: 'nearest' }); } catch (_) {} }
}
function tgPaint(rect) {
  if (rect) _tgRect = rect;
  const box = tgBox();
  box.innerHTML = '';
  _tgShown = 0;
  tgMore();
  box.classList.add('on');
  const rc = _tgRect || { left: 120, bottom: 120 };
  box.style.left = Math.max(6, Math.min(rc.left, window.innerWidth - box.offsetWidth - 8)) + 'px';
  const top = (rc.bottom || 0) + 4;
  box.style.top = Math.max(6, Math.min(top, window.innerHeight - box.offsetHeight - 8)) + 'px';
}
// 光标处正在输入的片段：从最后一个分隔符（, ， 、 换行）到光标
function tgProbe(ed) {
  if (ed.isContentEditable) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const rg = sel.getRangeAt(0);
    if (!ed.contains(rg.startContainer) || rg.startContainer.nodeType !== 3) return null;
    const m = /([^,，、\n\r]*)$/.exec(String(rg.startContainer.nodeValue || '').slice(0, rg.startOffset));
    let rc = null;
    try { rc = rg.getBoundingClientRect(); } catch (_) {}
    return { len: m ? m[1].length : 0, frag: m ? m[1].trim() : '', rect: (rc && (rc.bottom || rc.top)) ? rc : null };
  }
  const pos = ed.selectionStart;
  if (typeof pos !== 'number' || pos < 0) return null;
  const m = /([^,，、\n\r]*)$/.exec(String(ed.value || '').slice(0, pos));
  let rc = null;
  try { rc = ed.getBoundingClientRect(); } catch (_) {}
  return { len: m ? m[1].length : 0, frag: m ? m[1].trim() : '', rect: rc };
}
function tgCheck(ed) {
  if (!_tgOn) { tgHide(); return; }
  const p = tgProbe(ed);
  const q = p ? String(p.frag || '') : '';
  if (!p || !q.length || q.length > 40) { tgHide(); return; }
  tgReset(ed, q, p.len, p.rect);   // 先出一批，剩下的滚到底续查
}
// 采用候选：把刚输入的那一截换成完整标签名
// 搜索框里选中某个标签 → 把左栏切到它所在的分组并滚过去
// 归属优先：你记录里的 category → 细分表类别 → Danbooru 分类桶
async function tpGotoTag(en) {
  const m = tagMineOf().get(en);
  let cat = String((m && m.category) || '');
  const inRoots = (id) => {
    let hit = false;
    (function w(a) { (a || []).forEach((g) => { if (String(g.id) === String(id)) hit = true; w(g.children); }); })(tpRoot());
    return hit;
  };
  if (cat && tagCatNode(cat)) {                 // 归在你自己的分类里 → 切到「我的标签」视图
    if (_tpLibId) { _tpLibId = ''; tpSyncLibDD(); }
  } else if (cat && !inRoots(cat)) {
    cat = '';
  }
  if (!cat) {                                    // 没有归属（或不属于当前库）→ 找哪个库有它再算类别
    let libId = _tpLibId;
    const cur = libId ? _tpCache.get(libId) : null;
    if (!(cur && cur.set && cur.set.has(en))) {
      for (const L of (_tpLibs || [])) {
        const c = _tpCache.get(L.id);
        if (c && c.set && c.set.has(en)) { libId = L.id; break; }
      }
    }
    if (libId !== _tpLibId) { _tpLibId = libId || ''; await tpLoadLib(_tpLibId); tpSyncLibDD(); }
    const lib = _tpLibId ? _tpCache.get(_tpLibId) : null;
    if (lib && lib.set && lib.set.has(en)) {
      const k = tpKindOf(en);
      const i = lib.names.indexOf(en);
      cat = k ? 'k:' + k : 'c' + ('01345'.indexOf(lib.cats[i]) >= 0 ? lib.cats[i] : 'x');
    }
  }
  if (!cat) { renderTagPanel(); return; }
  _tpCat = cat;
  _libTouched = true;
  if (cat.slice(0, 2) === 'k:' && cat.indexOf('/') >= 0) tpOpenCat(cat.slice(2).split('/')[0]);   // 展开态用的是裸 key
  (function w(list, path) {   // 把祖先分组都展开
    (list || []).forEach((g) => {
      if (String(g.id) === String(cat)) path.forEach((id) => tpOpenCat(id));   // tpOpenCat 会同时登记 'k:x' 和裸 'x'
      w(g.children, path.concat([String(g.id)]));
    });
  })(tpRoot(), []);
  _tpScrollSel = true;
  renderTagPanel();
  // 再落到"这个标签所在的那一页"（换分组会把页码重置成 1，所以必须渲染完再定）
  const all = _tpView;   // renderTagPanel 刚按当前分组重建过
  const idx = all.findIndex((x) => x.en === en);
  if (idx >= 0) {
    const pg = Math.floor(idx / _tpPer) + 1;
    if (pg !== _tpPage) { _tpPage = pg; renderTagPanel(); }
  }
}
function tgPick(i) {
  const row = _tgRows[i];
  const ed = _tgEd;
  if (!row || !ed) { tgHide(); return; }
  if (ed._tpSearch) setTimeout(() => tpGotoTag(row.en), 0);   // 搜索框里选标签：插完字再跳分组
  if (ed.isContentEditable) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const rg = sel.getRangeAt(0);
      if (rg.startContainer.nodeType === 3 && rg.startOffset >= _tgLen) {
        const rr = document.createRange();
        rr.setStart(rg.startContainer, rg.startOffset - _tgLen);
        rr.setEnd(rg.startContainer, rg.startOffset);
        rr.deleteContents();
        const tn = document.createTextNode(row.en);
        rr.insertNode(tn);
        rr.setStartAfter(tn); rr.collapse(true);
        sel.removeAllRanges(); sel.addRange(rr);
        saveSelection();
      }
    }
  } else {
    const v = String(ed.value || ''), pos = ed.selectionStart || 0;
    ed.value = v.slice(0, pos - _tgLen) + row.en + v.slice(pos);
    try { ed.setSelectionRange(pos - _tgLen + row.en.length, pos - _tgLen + row.en.length); } catch (_) {}
  }
  ed.dispatchEvent(new Event('input', { bubbles: true }));
  tgHide();
}
function tgKey(e) {
  if (e.isComposing || e.keyCode === 229) return false;   // 中文输入法组字中：回车/方向键归输入法
  if (!tgOpen()) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    tgSelect((e.key === 'ArrowDown' ? _tgSel + 1 : _tgSel + _tgRows.length - 1) % _tgRows.length, true);
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    tgPick(_tgSel);
  } else if (e.key === 'Escape') {
    tgHide();
  } else {
    return false;
  }
  e.preventDefault(); e.stopPropagation();
  return true;
}
// 挂到编辑器 / 输入框 / 文本域上：只在开启时生效
function tgAttach(ed) {
  if (!ed || ed._tgBound) return;
  ed._tgBound = true;
  ed.addEventListener('input', () => {
    if (!_tgOn) return;
    if (!_tpZh || !_tpLibs || (_tpLibId && !_tpCache.has(_tpLibId))) { tgEnsure().then(() => tgCheck(ed)); return; }
    tgCheck(ed);
  });
  ed.addEventListener('keydown', (e) => { tgKey(e); });
  ed.addEventListener('blur', () => setTimeout(() => { if (_tgEd === ed) tgHide(); }, 150));
  ed.addEventListener('mousedown', () => tgHide());
}

// ===== 生图设置 + 生成预览图（参考「生图设置」面板：工作流与模型 / 生成参数 / 固定提示词 / 图片保存）=====
const GEN_SET_API = '/prompt_helper/gen_settings';
const GEN_DEF_POS = 'masterpiece, best quality, vibrant, very aesthetic, high contrast, highly detailed, absurdres,';
const GEN_DEF_NEG = 'lowres, worst quality, low quality, bad anatomy, bad proportions, signature, watermark, patreon, artist name, twitter username, simple background, borders';
const GEN_RUN_API = '/prompt_helper/gen_preview';
// 生成进度条（悬底）：文字 x/n + 填充条
let _genProgEl = null, _genStop = false;
function genProg(on, text, pct) {
  if (!_genProgEl) {
    _genProgEl = el('div', 'eph-genprog');
    _genProgEl.innerHTML = '<span></span><i><b></b></i>';
    const stop = el('button', 'eph-genprog-stop'); stop.type = 'button'; stop.textContent = ezT('Stop');
    stop.title = ezT('Stop generating and interrupt the current run');
    stop.addEventListener('click', () => { _genStop = true; try { fetchApi('/interrupt', { method: 'POST' }); } catch (_) {} });   // 停后续 + 中断正在跑的那张
    _genProgEl.appendChild(stop);
    document.body.appendChild(_genProgEl);
  }
  _genProgEl.classList.toggle('on', !!on);
  if (!on) return;
  _genProgEl.querySelector('span').textContent = text || '';
  _genProgEl.querySelector('b').style.width = Math.round(Math.max(0, Math.min(1, pct || 0)) * 100) + '%';
}
// 内置最小文生图工作流（没导 api.json 时用）：标准节点，后端按输入名注入
// 有 KJNodes 时两条路都摆在图里、用 LazySwitchKJ 选（lazy = 没选中的那条不会被求值）；没装就用对应单路径
let _kjOk = null;
async function genKjOk() {
  if (_kjOk === null) {
    try { _kjOk = (await fetchApi('/object_info/LazySwitchKJ')).ok; } catch (_) { _kjOk = false; }
  }
  return _kjOk;
}
function genBuiltinApi(mode, kj, lora, vae) {
  const unet = mode === 'unet';
  const src = { model: ['1', 0], clip: ['1', 1], vae: ['1', 2] };
  const n = { '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '' } } };
  if (unet) {
    n['11'] = { class_type: 'UNETLoader', inputs: { unet_name: '', weight_dtype: 'default' } };
    n['12'] = { class_type: 'CLIPLoader', inputs: { clip_name: '', type: 'stable_diffusion' } };
    n['13'] = { class_type: 'VAELoader', inputs: { vae_name: '' } };
    const u = { model: ['11', 0], clip: ['12', 0], vae: ['13', 0] };
    if (kj) {
      n['8'] = { class_type: 'LazySwitchKJ', inputs: { switch: true, on_false: src.model, on_true: u.model } };
      n['9'] = { class_type: 'LazySwitchKJ', inputs: { switch: true, on_false: src.clip, on_true: u.clip } };
      // 选了独立 VAE 就用它（Anima/Qwen 这类分离式加载不能借 checkpoint 的 VAE）；没选才退回 checkpoint 的
      n['10'] = { class_type: 'LazySwitchKJ', inputs: { switch: !!vae, on_false: src.vae, on_true: u.vae } };
      src.model = ['8', 0]; src.clip = ['9', 0]; src.vae = ['10', 0];
    } else { src.model = u.model; src.clip = u.clip; src.vae = vae ? u.vae : src.vae; }
  }
  if (lora) {   // 选了 LoRA 才挂节点（空名字会加载失败），串在选中的加载器后面
    n['14'] = { class_type: 'LoraLoader', inputs: { lora_name: '', strength_model: 1, strength_clip: 1, model: src.model, clip: src.clip } };
    src.model = ['14', 0]; src.clip = ['14', 1];
  }
  n['2'] = { class_type: 'CLIPTextEncode', inputs: { text: '', clip: src.clip } };
  n['3'] = { class_type: 'CLIPTextEncode', inputs: { text: '', clip: src.clip } };
  n['4'] = { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } };
  n['5'] = { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 6, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: src.model, positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } };
  n['6'] = { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: src.vae } };
  n['7'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'EzFlexPreview', images: ['6', 0] } };
  return JSON.stringify(n);
}
function isBuiltinApi(s) {
  // 内置模板的 SaveImage 固定用 EzFlexPreview 前缀，导入的 api.json 不会带这个标记
  if (!s) return false;
  try {
    return Object.values(JSON.parse(s)).some((nd) => nd && nd.class_type === 'SaveImage' && nd.inputs && nd.inputs.filename_prefix === 'EzFlexPreview');
  } catch (_) { return false; }
}
let _genCfg = null, _genOverlay = null, _genPending = null;   // 待生成的标签（从右键「生成预览图」进来时带过来）
async function genLoadCfg(force) {
  if (_genCfg && !force) return _genCfg;
  try { const r = await fetchApi(GEN_SET_API); const d = await r.json(); _genCfg = (d && d.settings) || {}; }
  catch (_) { _genCfg = {}; }
  return _genCfg;
}
async function genSaveCfg(cfg) {
  try {
    const r = await fetchApi(GEN_SET_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: cfg }) });
    const d = await r.json();
    _genCfg = (d && d.settings) || cfg;
  } catch (_) { _genCfg = cfg; }
  return _genCfg;
}
// 从 /object_info 拿模型下拉的候选（拿不到就退化成文本输入）
async function genOptions() {
  const out = { ckpt: [], unet: [], clip: [], vae: [], lora: [] };
  const grab = async (cls, key) => {
    try {
      const d = await (await fetchApi('/object_info/' + cls)).json();
      const inp = d && d[cls] && d[cls].input && (d[cls].input.required || {})[key];
      const list = inp && inp[0];
      if (Array.isArray(list)) return list.slice(0, 500);
    } catch (_) {}
    return [];
  };
  out.ckpt = await grab('CheckpointLoaderSimple', 'ckpt_name');
  out.clip = await grab('CLIPLoader', 'clip_name');
  out.vae = await grab('VAELoader', 'vae_name');
  out.unet = await grab('UNETLoader', 'unet_name');
  out.lora = await grab('LoraLoader', 'lora_name');
  return out;
}
function genField(label, node, hint) {
  const w = el('div', 'eph-gen-f');   // label 会把点击二次转发给里面的控件，下拉会"点不动"
  const lb = el('span', 'eph-gen-lb'); lb.textContent = label;
  w.appendChild(lb); w.appendChild(node);
  if (hint) { const h = el('span', 'eph-gen-hint'); h.textContent = hint; w.appendChild(h); }
  return w;
}
function genSec(title, note) {
  const sec = el('div', 'eph-gen-sec');
  const t = el('div', 'eph-gen-t'); t.textContent = title;
  sec.appendChild(t);
  if (note) { const n = el('div', 'eph-gen-note'); n.textContent = note; sec.appendChild(n); }
  return sec;
}
async function openGenSettings() {
  const cfg = Object.assign({
    api: '', ckpt: '', unet: '', clip: '', vae: '', lora: '', width: 512, height: 512, steps: 20, cfg: 6,
    sampler: 'euler', scheduler: 'simple', batch: 1, seedMode: 'random', seed: 0,
    positive: GEN_DEF_POS, negative: GEN_DEF_NEG, format: 'webp', quality: 80, size: 384,
  }, await genLoadCfg());
  const opts = await genOptions();
  const kj = await genKjOk();
  let bMode = cfg.builtinMode === 'unet' ? 'unet' : 'ckpt';
  if (!cfg.api || isBuiltinApi(cfg.api)) cfg.api = genBuiltinApi(bMode, kj, cfg.lora);   // 没导过（或就是内置的）→ 按开关重建
  if (!cfg.ckpt && opts.ckpt.length) cfg.ckpt = opts.ckpt[0];     // 默认挑第一个 checkpoint，开箱即用
  if (_genOverlay && _genOverlay.parentNode) _genOverlay.remove();
  const ov = el('div', 'eph-cm active'); ov.style.zIndex = '100020';
  const box = el('div', 'eph-cm-box'); box.style.width = '760px';
  const hd = el('div', 'eph-cm-hd');
  const t = el('b'); t.textContent = ezT('Generation settings');
  const close = el('button', 'eph-modal-close'); close.textContent = '✕'; close.style.marginLeft = 'auto';
  hd.appendChild(t); hd.appendChild(close);
  const body = el('div', 'eph-cm-body');
  const sub = el('div', 'eph-gen-sub');   // 不再要那行说明文字
  body.appendChild(sub);

  // 工作流与模型
  const s1 = genSec(ezT('Workflow'), '');
  const apiRow = el('div', 'eph-gen-row');
  const apiHint = ezT('Only the API-format json works (ComfyUI: Workflow → Export (API))');
  const apiName = el('span', 'eph-gen-api'); apiName.textContent = (!cfg.api || isBuiltinApi(cfg.api)) ? '' : ezT('Workflow loaded');
  const apiFile = el('input'); apiFile.type = 'file'; apiFile.accept = '.json,application/json'; apiFile.style.display = 'none';
  const apiBtn = el('button', 'eph-btn'); apiBtn.textContent = ezT('Replace workflow'); apiBtn.title = apiHint;
  const apiRst = el('button', 'eph-btn'); apiRst.textContent = ezT('Restore default workflow');
  apiBtn.addEventListener('click', () => apiFile.click());
  apiFile.addEventListener('change', async () => {
    const f = apiFile.files && apiFile.files[0]; if (!f) return;
    const text = await f.text();
    let ok = false;
    try { const j = JSON.parse(text); ok = !!j && typeof j === 'object' && !Array.isArray(j) && Object.values(j).every((v) => v && typeof v === 'object' && v.class_type); } catch (_) { ok = false; }
    if (!ok) { phTip(ezT('Import the API-format json (ComfyUI: Save (API Format)); the normal workflow json will not work')); apiFile.value = ''; return; }
    cfg.api = text;
    apiName.textContent = ezT('Workflow loaded') + ': ' + f.name;
  });
  apiRst.addEventListener('click', () => { cfg.api = ''; apiName.textContent = ''; cfg.ckpt = ''; cfg.clip = ''; cfg.vae = ''; cfg.lora = ''; cfg.width = 512; cfg.height = 512; cfg.steps = 20; cfg.cfg = 6; cfg.sampler = 'euler'; cfg.scheduler = 'simple'; cfg.batch = 1; cfg.seedMode = 'random'; cfg.seed = 0; cfg.positive = GEN_DEF_POS; cfg.negative = GEN_DEF_NEG; cfg.quality = 80; render(); });

  // 和设置里其它模型下拉一样用我们自己的 makeDropdown：点开就是完整列表，
  // 不像原生 datalist 那样"选了之后就只剩一个、得手动清空才出别的"
  const mkDD = (label, list, get, set) => {
    const w = genField(label, el('span'));
    // 第一项是空的 = 不注入这个字段（用工作流里原来的值）
    const dd = makeDropdown([{ value: '', label: ezT('(none)') }].concat((list || []).map((v) => ({ value: v, label: String(v) }))));
    dd.value = get() || '';
    dd.addEventListener('change', (v) => set(v));
    w.replaceChild(dd.el, w.children[1]);
    if (!list || !list.length) dd.el.classList.add('empty');
    return w;
  };
  const grid1 = el('div', 'eph-gen-grid');
  // checkpoint / unet 切换：默认 checkpoint，切一下就把内置模板换成对应那条路
  const segBox = el('span', 'eph-seg');
  const mCk = el('em', 'eph-seg-item on'), mUn = el('em', 'eph-seg-item on');
  mCk.textContent = 'checkpoint'; mUn.textContent = 'unet';
  const syncMode = () => { mCk.classList.toggle('active', bMode === 'ckpt'); mUn.classList.toggle('active', bMode === 'unet'); };
  const setMode = (m) => { bMode = m; cfg.builtinMode = m; if (!cfg.api || isBuiltinApi(cfg.api)) cfg.api = genBuiltinApi(m, kj, cfg.lora); syncMode(); };
  mCk.addEventListener('click', () => setMode('ckpt'));
  mUn.addEventListener('click', () => setMode('unet'));
  segBox.appendChild(mCk); segBox.appendChild(mUn); syncMode();
  const modelF = mkDD(ezT('Model'), opts.ckpt, () => cfg.ckpt, (v) => { cfg.ckpt = v; });
  modelF.style.gridColumn = '1 / -1';
  grid1.appendChild(modelF);
  grid1.appendChild(mkDD(ezT('Unet'), opts.unet, () => cfg.unet, (v) => { cfg.unet = v; }));
  grid1.appendChild(mkDD(ezT('Clip'), opts.clip, () => cfg.clip, (v) => { cfg.clip = v; }));
  grid1.appendChild(mkDD(ezT('Vae'), opts.vae, () => cfg.vae, (v) => { cfg.vae = v; }));
  const loraF = mkDD(ezT('Lora'), opts.lora, () => cfg.lora, (v) => { cfg.lora = v; if (!cfg.api || isBuiltinApi(cfg.api)) cfg.api = genBuiltinApi(bMode, kj, v); });
  loraF.style.gridColumn = '1 / -1';   // LoRA 单独一行，跟在 CLIP 那行下面
  grid1.appendChild(loraF);
  apiRow.appendChild(segBox);
  apiBtn.style.marginLeft = 'auto';   // 工作流按钮放滑块这行右侧末尾
  apiRow.appendChild(apiBtn); apiRow.appendChild(apiRst); apiRow.appendChild(apiFile);
  s1.appendChild(apiRow);
  s1.appendChild(apiName);
  grid1.style.gridTemplateColumns = '1fr 1fr 1fr';
  s1.appendChild(grid1);
  body.appendChild(s1);

  // 生成参数
  const s2 = genSec(ezT('Generation'), '');
  const grid2 = el('div', 'eph-gen-grid eph-gen-grid4');
  const num = (label, get, set, step) => {
    const inp = el('input', 'eph-gen-in'); inp.type = 'number'; inp.step = step || '1'; inp.value = get();
    inp.addEventListener('input', () => set(Number(inp.value) || 0));
    return genField(label, inp);
  };
  grid2.appendChild(num(ezT('Width'), () => cfg.width, (v) => { cfg.width = v; }));
  grid2.appendChild(num(ezT('Height'), () => cfg.height, (v) => { cfg.height = v; }));
  grid2.appendChild(num(ezT('Steps'), () => cfg.steps, (v) => { cfg.steps = v; }));
  grid2.appendChild(num(ezT('CFG'), () => cfg.cfg, (v) => { cfg.cfg = v; }, '0.1'));
  const txt = (label, get, set) => { const i = el('input', 'eph-gen-in'); i.value = get(); i.addEventListener('input', () => set(i.value.trim())); return genField(label, i); };
  grid2.appendChild(txt(ezT('Sampler'), () => cfg.sampler, (v) => { cfg.sampler = v; }));
  grid2.appendChild(txt(ezT('Scheduler'), () => cfg.scheduler, (v) => { cfg.scheduler = v; }));
  grid2.appendChild(num(ezT('Batch'), () => cfg.batch, (v) => { cfg.batch = v; }));
  const mode = el('select', 'eph-gen-in');
  [['random', ezT('Every time random')], ['fixed', ezT('Fixed')]].forEach(([v, l]) => { const o = el('option'); o.value = v; o.textContent = l; mode.appendChild(o); });
  mode.value = cfg.seedMode || 'random';
  mode.addEventListener('change', () => { cfg.seedMode = mode.value; });
  grid2.appendChild(genField(ezT('Seed mode'), mode));
  const seedF = num(ezT('Fixed seed'), () => cfg.seed, (v) => { cfg.seed = v; });   // 固定种子单独占一行
  seedF.style.gridColumn = '1 / -1';
  grid2.appendChild(seedF);
  s2.appendChild(grid2);
  body.appendChild(s2);

  // 固定提示词
  const s3 = genSec(ezT('Prompts'), '');
  const pRow = el('div', 'eph-gen-grid');
  pRow.style.gridTemplateColumns = '1fr';   // 正向/负面一上一下
  const pIn = el('textarea', 'eph-gen-in'); pIn.rows = 2; pIn.spellcheck = false; pIn.spellcheck = false; pIn.value = cfg.positive || ''; pIn.addEventListener('input', () => { cfg.positive = pIn.value; });
  const nIn = el('textarea', 'eph-gen-in'); nIn.rows = 2; nIn.spellcheck = false; nIn.spellcheck = false; nIn.value = cfg.negative || ''; nIn.addEventListener('input', () => { cfg.negative = nIn.value; });
  pRow.appendChild(genField(ezT('Positive prompt'), pIn));
  pRow.appendChild(genField(ezT('Negative prompt'), nIn));
  s3.appendChild(pRow);
  body.appendChild(s3);

  // 图片保存
  const s4 = genSec(ezT('Image saving'), '');
  const grid4 = el('div', 'eph-gen-grid');
  grid4.style.gridTemplateColumns = '1fr 1fr 1fr';   // 格式/质量/尺寸一行放完
  const fmt = el('select', 'eph-gen-in');
  ['webp', 'png'].forEach((v) => { const o = el('option'); o.value = v; o.textContent = v.toUpperCase(); fmt.appendChild(o); });
  fmt.value = cfg.format || 'webp'; fmt.addEventListener('change', () => { cfg.format = fmt.value; });
  grid4.appendChild(genField(ezT('Format'), fmt));
  grid4.appendChild(num(ezT('Quality'), () => cfg.quality, (v) => { cfg.quality = v; }));
  grid4.appendChild(num(ezT('Preview size'), () => cfg.size, (v) => { cfg.size = v; }));
  s4.appendChild(grid4);
  body.appendChild(s4);

  const foot = el('div', 'eph-cm-foot');
  const cancel = el('button', 'eph-btn'); cancel.textContent = ezT('Cancel');
  const ok = el('button', 'eph-btn eph-btn-save'); ok.textContent = ezT('Save settings');
  const genB = el('button', 'eph-btn eph-btn-save'); genB.textContent = ezT('Generate');   // 右下角：保存 + 直接开跑
  genB.addEventListener('click', async () => {
    await genSaveCfg(cfg);
    const list = (_genPending && _genPending.length) ? _genPending : Array.from(_tpSel).map((k) => tpKeyName(k));
    shut();
    if (list.length) genRun(list);
  });
  foot.appendChild(cancel); foot.appendChild(ok); foot.appendChild(genB);
  body.appendChild(foot);
  function render() { /* 只有恢复默认后需要刷新数值，重开即可 */ }
  box.appendChild(hd); box.appendChild(body); ov.appendChild(box); document.body.appendChild(ov);
  _genOverlay = ov;
  const shut = () => { ov.remove(); _genOverlay = null; };
  close.addEventListener('click', shut);
  cancel.addEventListener('click', shut);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) shut(); });
  ok.addEventListener('click', async () => { await genSaveCfg(cfg); shut(); phTip(ezT('Generation settings saved')); });
}
// 生成进度条（悬在底部）：x/n + 填充（同一个实现，声明只在上面一处）
// 右键「生成预览图」：先弹生成设置让你看一眼，点里面的「生成」才开跑
function genPreviews(names) {
  _genPending = (names || []).filter(Boolean);
  openGenSettings();
}
// 真正开跑：逐个生成 + 进度条
async function genRun(names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return;
  const cfg = await genLoadCfg();
  // 内置工作流按当前设置重建并落盘（后端读的是落盘的 settings.json）——滑块切模式 / 换 LoRA / 换 VAE / 模板升级都要换图。
  // 导入了自己的 api.json（不是内置模板）就原样用它。
  if (!cfg.api || isBuiltinApi(cfg.api)) {
    cfg.api = genBuiltinApi(cfg.builtinMode === 'unet' ? 'unet' : 'ckpt', await genKjOk(), cfg.lora, cfg.vae);
    if (!cfg.ckpt) { const o = await genOptions(); if (o.ckpt.length) cfg.ckpt = o.ckpt[0]; }
    await genSaveCfg(cfg);
  }
  // 逐个生成：每完成一个更新进度条 x/n（一次全发的话中间拿不到进度，某个失败还会让整批干等）
  const total = list.length;
  let done = 0, okN = 0;
  _genStop = false;
  genProg(true, ezT('Generating previews...') + ' 0/' + total, 0);
  for (const nm of list) {
    if (_genStop) break;
    try {
      const r = await fetchApi(GEN_RUN_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: [nm] }) });
      const d = await r.json();
      const got = Object.keys((d && d.previews) || {});
      if (got.length) {
        got.forEach((n2) => { const t = tpSetMine(n2, {}); t.preview = d.previews[n2]; });
        await savePromptTags();
        okN++;
      } else if (!_genStop) phTip(ezT('Generation failed: ') + nm + ' ' + ((d && d.error) || ''));
    } catch (e) { if (!_genStop) phTip(ezT('Generation failed: ') + nm + ' ' + (e && e.message ? e.message : e)); }
    done++;
    if (_genStop) break;
    genProg(true, ezT('Generating previews...') + ' ' + done + '/' + total, done / total);
    renderTagPanel();
  }
  genProg(false);
  if (_genStop) { phTip(ezT('Stopped')); return; }
  phTip(ezT('Generated ') + okN + '/' + total);
}

function tpCardMenu(r, x, y) {
  // 批量模式下右键的是"选中之一"就按整批处理（和底部批量栏一致），否则只处理这一张
  const multi = _tpBatch && _tpSel.has(r.key) && _tpSel.size > 1;
  const keys = multi ? Array.from(_tpSel) : [r.key];
  const names = multi ? keys.map((k) => tpKeyName(k)) : [r.en];
  const n = multi ? ' (' + keys.length + ')' : '';
  const items = [];
  items.push([ezT('New tag'), () => tpEditCard({ new: true, en: '', zh: '', item: null, side: 'mine' })]);
  items.push([ezT('Edit tag'), () => tpEditCard(r)]);
  items.push([ezT('Generate random tags'), () => tpGenerateRandom()]);
  items.push([ezT('Generate preview') + n, () => genPreviews(names)]);
  items.push([ezT('Move to group') + n, () => tagMoveMenu(x, y, keys, multi ? null : r)]);
  items.push([ezT('Batch manage'), () => tagBatchToggle(true)]);
  if (!multi && r.side === 'lib' && tpIsDefault(r.en)) items.push([ezT('Restore default tag'), () => tpRestoreTag(r.en)]);
  items.push(['-']);
  items.push([ezT('Delete tag') + n, () => (multi ? tagDeleteSel() : tagDeleteOne(r))]);
  cmMenu(x, y, items);
}
// 删一张卡：库侧 = 记隐藏（库原有）或去掉归类（我加的）；我的侧 = 删掉副本
async function tagDeleteOne(r) {
  const st = _tpLibId ? tpLibState(_tpLibId) : null;
  if (r.side === 'lib') {
    const lib = _tpLibId ? _tpCache.get(_tpLibId) : null;
    if (st && lib && lib.set && lib.set.has(r.en)) st.hidden = (st.hidden || []).filter((v) => v !== r.en).concat([r.en]);
    else tpPlaceSet(r.en, '');
  } else {
    tpMineDrop(r.en);
  }
  tpDropPreview(r.en);   // 删标签连预览图一起清（预览可重新生成）
  await savePromptTags(); renderTagPanel();
}
// ===== 随机 tag：分组配置（localStorage）+ 从指定分类随机抽 tag 追加到「已插入」 =====
const RAND_LS = 'ezflex.randGroups';
// 默认六组 = 画师(c1) / 角色(c4) / 人物 / 服饰 / 表情动作 / 场景
const RAND_DEFAULT = [
  { cat: 'c1', n: 1, on: true },
  { cat: 'c4', n: 1, on: true },
  { cat: 'k:person', n: 1, on: true },
  { cat: 'k:clothing', n: 1, on: true },
  { cat: 'k:expression', n: 1, on: true },
  { cat: 'k:scene', n: 1, on: true },
];
let _randGroups = null;
function randGroups() {
  if (_randGroups) return _randGroups;
  let out = null;
  try {
    const s = localStorage.getItem(RAND_LS);
    if (s) {
      const a = JSON.parse(s);
      if (Array.isArray(a)) out = a.filter((g) => g && g.cat).map((g) => ({ cat: String(g.cat), n: Math.max(1, Math.min(50, parseInt(g.n, 10) || 1)), on: g.on !== false }));
    }
  } catch (_) { out = null; }
  _randGroups = (out && out.length) ? out : RAND_DEFAULT.map((g) => Object.assign({}, g));
  return _randGroups;
}
function randSave() { try { localStorage.setItem(RAND_LS, JSON.stringify(randGroups())); } catch (_) {} }
// 分类候选：CSV 桶 + 细分大类（含子类，缩进显示）
function randCatItems() {
  const out = CAT_ORDER.map(([v, l]) => ({ value: v, label: ezT(l) }));
  KIND_ORDER.forEach((k) => { if (KIND_LABEL[k]) out.push({ value: 'k:' + k, label: ezT(KIND_LABEL[k]) }); });
  Object.keys(KIND_LABEL).filter((k) => k.indexOf('/') > 0).sort().forEach((k) => out.push({ value: 'k:' + k, label: '\u3000' + ezT(KIND_LABEL[k] || k.split('/')[1]) }));
  return out;
}
// 某个分类里能随机到的 tag 名：尊重隐藏 / 排除兽类 / 细分表 / CSV 桶
function tpRandPool(cat, libId) {
  const id = libId || _tpLibId;
  const lib = id ? _tpCache.get(id) : null;
  if (!lib) return [];
  const hidden = new Set(tpLibHidden(id));
  const isKind = String(cat).slice(0, 2) === 'k:';
  const kind = isKind ? String(cat).slice(2) : '';
  const out = [];
  for (let i = 0; i < lib.names.length; i++) {
    const nm = lib.names[i];
    if (hidden.has(nm)) continue;
    if (_tpHideFurry && tpFurry(lib.cats[i], nm)) continue;
    if (isKind) { const k = tpKindOf(nm); if (!k || (k !== kind && k.slice(0, kind.length + 1) !== kind + '/')) continue; }
    else { const c = 'c' + ('01345'.indexOf(lib.cats[i]) >= 0 ? lib.cats[i] : 'x'); if (c !== cat) continue; }
    out.push(nm);
  }
  return out;
}
// 从「随机组」抽一批 tag：标签面板一次性生成 / 卡片单点 / 排队运行期随机共用
async function tpRandPickTags() {
  if (!Array.isArray(_tpLibs) || !_tpLibs.length) { try { await tpLoadLibs(); } catch (_) {} }
  const groups = randGroups().filter((g) => g.on);
  if (!groups.length) return [];
  if (!Array.isArray(_tpLibs) || !_tpLibs.length) { console.warn('[PromptHelper] random tag: no tag library available'); return []; }
  let libId = _tpLibId;
  if (!libId) { try { libId = tpDefaultLib(); } catch (_) { libId = ''; } }   // 面板没开过也要能抽
  if (!libId) return [];
  try { if (!_tpCache.has(libId)) await tpLoadLib(libId); } catch (_) {} 
  try { await tpLoadKind(); } catch (_) {}
  if (!_tpCache.has(libId)) { console.warn('[PromptHelper] random tag: tag library failed to load (' + libId + ')'); return []; }
  const picks = [];
  groups.forEach((g) => {
    const pool = tpRandPool(g.cat, libId).filter((nm) => picks.indexOf(nm) < 0);
    const n = Math.max(0, Math.min(50, parseInt(g.n, 10) || 0));
    for (let k = 0; k < n && pool.length; k++) { const j = Math.floor(Math.random() * pool.length); picks.push(pool[j]); pool.splice(j, 1); }
  });
  return picks;
}
function tpInsertTags(ed, picks) {
  if (ed) { try { _editorRange = phEndRange(ed); } catch (_) {} }   // 落点=编辑器末尾
  picks.forEach((nm) => { if (_tpIns.indexOf(nm) < 0) _tpIns.push(nm); if (ed) phInsertPlain(ed, tpArtistName(nm)); });
}
// 把编辑器改动写回它所属的卡片 / 总体编辑（随机 tag 生成后立刻落盘，不只停在 DOM 里）
function phCommitTargetEditor(ed) {
  if (!ed) return;
  if (_editModal && _editModal.classList.contains('active') && ed === _editModal._editor) { try { editModalCommit(_editModal._node); } catch (_) {} return; }
  if (_allModal && _allModal.classList.contains('active') && ed === _allModal._ed) { try { syncAllContent(_allModal._node); } catch (_) {} return; }
}
// 清掉当前编辑器里「已插入」的标签（先把括号/转换写法还原成裸名再删），其它正文保留
function tpClearInserted(ed) {
  _tpIns.slice().forEach((en) => {
    const cfg = _tpW.get(en);
    try { phReplaceText(ed, _tpAlt.get(en) || tpFmt(en, cfg), en); } catch (_) {}
    try { phRemovePlain(ed, en); } catch (_) {}
  });
  _tpIns = []; _tpW.clear();
}
// 标签面板「生成随机tag」：先清除已插入的标签再生成（不然每次都在末尾累加）
async function tpGenerateRandom() {
  if (!randGroups().some((g) => g.on)) { phTip(ezT('No random group is enabled')); return; }
  const picks = await tpRandPickTags();
  if (!picks.length) { phTip(ezT('Nothing to generate (check random groups / tag library)')); return; }
  const ed = _tagPickTarget || _phActiveEditor;
  if (ed) tpClearInserted(ed);
  tpInsertTags(ed, picks);
  phCommitTargetEditor(ed);   // 写回当前随机生成所在的那张卡片
  renderTagPanel();
}
// 卡片弹窗「随机tag」单点：清空这张卡正文，再按当前设置生成一次
async function tpRandomToEditor(ed) {
  if (!randGroups().some((g) => g.on)) { phTip(ezT('No random group is enabled')); return; }
  const picks = await tpRandPickTags();
  if (!picks.length) { phTip(ezT('Nothing to generate (check random groups / tag library)')); return; }
  if (ed) { try { ed.textContent = ''; } catch (_) {} }
  _tpIns = []; _tpW.clear();
  tpInsertTags(ed, picks);
  phCommitTargetEditor(ed);   // 写回当前随机生成所在的那张卡片
  renderTagPanel();
}
// 运行期自动随机：排队提交时把「自动随机tag」卡片的 config 换成刚生成的随机 tag。
// 运行期自动随机：排队提交时把「自动随机tag」卡片重写成本轮的随机 tag。
// 既改本次提交的 prompt（执行用这一份），也写回画布上的卡片（能看到、能接着编辑）。
// HTTP API 直接排队不经前端，仍是原内容。
async function phRandPatchPrompt(output) {
  if (!output || typeof output !== 'object') return;
  for (const id of Object.keys(output)) {
    const slot = output[id];
    if (!slot || slot.class_type !== NODE || !slot.inputs) continue;
    let cfg = null;
    try { cfg = (typeof slot.inputs.config === 'string') ? JSON.parse(slot.inputs.config) : slot.inputs.config; } catch (_) { cfg = null; }
    if (!cfg || !Array.isArray(cfg.cards)) continue;
    const node = (app && app.graph && typeof app.graph.getNodeById === 'function') ? app.graph.getNodeById(Number(id)) : null;
    const st = node ? stateFor(node) : null;
    let hit = 0;
    for (const card of cfg.cards) {
      if (!card || !card.autoRand) continue;
      const picks = await tpRandPickTags();
      if (!picks.length) { console.warn('[PromptHelper] auto random tag: no tags generated (check enabled groups / tag library in the Random dialog)'); continue; }   // 抽不到就别清空卡片
      const text = picks.map((nm) => tpArtistName(nm)).join(', ');
      card.content = text;
      card.contentHTML = ''; card.contentOptimized = ''; card.contentOptimizedHTML = ''; card.useOptimized = false;
      const local = st && (st.cards || []).find((c) => c && String(c.id) === String(card.id));
      if (local) {
        local.content = text;
        local.contentHTML = ''; local.contentOptimized = ''; local.contentOptimizedHTML = ''; local.useOptimized = false;
      }
      hit++;
    }
    if (!hit) continue;
    slot.inputs.config = JSON.stringify(cfg);
    if (node) {
      syncToConfig(node);
      refreshUI(node);
      try {   // 卡片弹窗正开着这张卡 → 编辑器也换成随机内容（没在打字时才覆盖）
        const m = _editModal;
        if (m && m.classList.contains('active') && m._node === node && m._editor && !m._editor.contains(document.activeElement)) {
          const card = (st.cards || []).find((c) => c && String(c.id) === String(st.editingId));
          if (card && card.autoRand && st.currentTab !== 'optimized') { m._editor.innerHTML = ezSanitizeHtml(card.contentHTML || card.content || ''); unwrapTagChips(m._editor); }
        }
      } catch (_) {}
      try { console.log('[PromptHelper] runtime random tags: rewrote ' + hit + ' card(s)'); } catch (_) {}
    }
  }
}
function installQueueRand() {
  if (!api || api.__ezPhRandHooked || typeof api.queuePrompt !== 'function') return;
  api.__ezPhRandHooked = true;
  const prev = api.queuePrompt;
  api.queuePrompt = async function (number, prompt, extra) {
    try { await phRandPatchPrompt(prompt && prompt.output); } catch (e) { console.warn('[PromptHelper] runtime random tag failed (submitting as-is):', e); }
    return prev.apply(this, arguments);
  };
}
installQueueRand();
// 分类候选树：CSV 桶 + 细分大类（含子类）——交给 tpCatPickMenu，和「移动至」同一套右侧层叠菜单
function randCatTree() {
  const csv = { id: 'rndcsv', name: ezT('CSV category'), side: 'rand', root: true,
    children: CAT_ORDER.map(([v, l]) => ({ id: v, name: ezT(l), cat: v, side: 'rand', children: [] })) };
  const kinds = { id: 'rndkind', name: ezT('Tag group'), side: 'rand', root: true,
    children: KIND_ORDER.filter((k) => KIND_LABEL[k]).map((k) => {
      const subs = Object.keys(KIND_LABEL).filter((x) => x.indexOf('/') > 0 && x.split('/')[0] === k).sort();
      return { id: 'k:' + k, name: ezT(KIND_LABEL[k]), cat: 'k:' + k, side: 'rand',
        children: subs.map((x) => ({ id: 'k:' + x, name: ezT(KIND_LABEL[x] || x.split('/')[1]), cat: 'k:' + x, side: 'rand', children: [] })) };
    }) };
  return { roots: [csv, kinds] };
}
function randCatLabel(v) {
  const it = randCatItems().find((x) => x.value === v);
  return it ? it.label.replace(/^\u3000+/, '') : String(v || '');
}
let _randModal = null;
function openRandModal() {
  if (_randModal && _randModal.parentNode) { try { _randModal.remove(); } catch (_) {} _randModal = null; }
  const draft = randGroups().map((g) => Object.assign({}, g));   // 弹窗里改的是草稿：点「保存随机设置 / 生成随机tag」才落盘
  const ov = el('div', 'eph-cm active'); ov.style.zIndex = '100020';
  const box = el('div', 'eph-cm-box'); box.style.width = '560px';
  const hd = el('div', 'eph-cm-hd');
  const t = el('b'); t.textContent = ezT('Random tags');
  const rst = el('button', 'eph-btn'); rst.textContent = ezT('Restore default groups'); rst.style.marginLeft = 'auto';
  const add = el('button', 'eph-btn'); add.textContent = ezT('+ Random category');
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  hd.appendChild(t); hd.appendChild(rst); hd.appendChild(add); hd.appendChild(close);
  const body = el('div', 'eph-cm-body');
  const list = el('div', 'eph-rand-list');
  body.appendChild(list);
  const foot = el('div', 'eph-cm-foot');
  const save = el('button', 'eph-btn'); save.textContent = ezT('Save random settings');
  const gen = el('button', 'eph-btn eph-btn-save'); gen.textContent = ezT('Generate random tags');
  foot.appendChild(save); foot.appendChild(gen);
  body.appendChild(foot);
  box.appendChild(hd); box.appendChild(body); ov.appendChild(box); document.body.appendChild(ov);
  _randModal = ov;
  const shut = () => { try { ov.remove(); } catch (_) {} _randModal = null; };
  const commit = () => { _randGroups = draft; randSave(); };
  const renderRows = () => {
    list.innerHTML = '';
    draft.forEach((g, idx) => {
      const row = el('div', 'eph-rand-row');
      // 分类选择：和「移动至分组」同一套右侧层叠菜单（tpCatPickMenu），不用下拉
      const catBtn = el('button', 'eph-btn eph-rand-cat'); catBtn.type = 'button'; catBtn.textContent = randCatLabel(g.cat);
      catBtn.addEventListener('click', () => {
        const rr = catBtn.getBoundingClientRect();
        tpCatPickMenu(rr.left, rr.bottom + 4, (it) => { g.cat = String(it.cat || ''); catBtn.textContent = randCatLabel(g.cat); }, { tree: randCatTree(), current: { side: 'rand', cat: g.cat } });
      });
      const nIn = el('input', 'eph-rand-n'); nIn.type = 'number'; nIn.min = '1'; nIn.max = '50'; nIn.value = String(g.n); nIn.title = ezT('Random tag count');
      nIn.addEventListener('change', () => { g.n = Math.max(1, Math.min(50, parseInt(nIn.value, 10) || 1)); nIn.value = String(g.n); });
      const sw = el('button', 'eph-rand-sw' + (g.on ? ' on' : '')); sw.type = 'button'; sw.title = ezT('Enable / disable this random group');
      sw.addEventListener('click', () => { g.on = !g.on; sw.classList.toggle('on', g.on); });
      const del = el('button', 'eph-rand-del'); del.type = 'button'; del.textContent = '－'; del.title = ezT('Delete this random group');
      del.addEventListener('click', () => { draft.splice(idx, 1); renderRows(); });
      row.appendChild(catBtn); row.appendChild(nIn); row.appendChild(sw); row.appendChild(del);
      list.appendChild(row);
    });
  };
  rst.addEventListener('click', () => { draft.length = 0; RAND_DEFAULT.forEach((g) => draft.push(Object.assign({}, g))); renderRows(); });
  add.addEventListener('click', () => { draft.push({ cat: 'c1', n: 1, on: true }); renderRows(); });
  close.addEventListener('click', shut);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) shut(); });
  save.addEventListener('click', () => { commit(); phTip(ezT('Random settings saved')); });
  gen.addEventListener('click', () => { commit(); tpGenerateRandom(); shut(); });
  renderRows();
}
function closeTagPicker() {
  if (_tpObs) { _tpObs.disconnect(); _tpObs = null; }
  if (_tpEl) _tpEl.classList.remove('active');
  try { if (_tpEl && _tpEl._node) phDockRemember(_tpEl._node); } catch (_) {}
}
async function openTagPicker(targetEd, anchor) {
  await loadPromptTags();
  await tpLoadLibs();
  await tpLoadZh();
  await tpLoadDrop();
  await tpLoadKind();
  if (!_tpEl || !_tpEl.parentNode) {
    const p = el('div', 'eph-tp');
    const hd = el('div', 'eph-tp-hd');
    const libDD = makeDropdown([]);
    libDD.el.title = ezT('Tag library');              // 不写「标签库」三个字了，悬停给提示
    libDD.el.style.flex = '0 8 132px';               // 面板变窄时先压它
    libDD.el.style.minWidth = '56px';
    const close = el('button', 'eph-modal-close'); close.textContent = '✕';
    const fullBtn = el('button', 'eph-btn eph-modal-full'); fullBtn.type = 'button'; fullBtn.textContent = ezT('Fullscreen');   // 全屏编辑
    const hdRight = el('div', 'eph-tp-hd-right');
    hdRight.appendChild(fullBtn); hdRight.appendChild(close);
    hd.appendChild(hdRight);
    fullBtn.addEventListener('click', () => {
      p.classList.toggle('full');
      fullBtn.textContent = p.classList.contains('full') ? ezT('Exit fullscreen') : ezT('Fullscreen');
      renderTagPanel();
    });
    // 库下拉右键：导入标签库 / 设为默认库
    libDD.el.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      cmMenu(e.clientX, e.clientY, [
        [ezT('Import tag library (csv / tsv / txt / json / sql)'), () => tpImport()],
        [ezT('Rename library'), async () => {
          const cur = _tpLibId ? (((_tagDoc.libs || {})[_tpLibId] || {}).name || _tpLibId) : ezT('My tags');
          const v = await uiPrompt(ezT('Library name'), cur);
          if (v && v.trim()) {
            tpLibState(_tpLibId).name = v.trim().slice(0, 64);
            await savePromptTags();
            const cur2 = _tpLibId;
            _tpLibs = null;
            await tpLoadLibs();
            _tpLibId = cur2;
            tpSyncLibDD();
            renderTagPanel();
          }
        }],
        [ezT('Delete library'), async () => {
          if (!_tpLibId) { phTip(ezT('My tags cannot be deleted')); return; }
          if (!(await uiConfirm(ezT('Remove library from the list? (the csv file is kept)')))) return;
          tpLibState(_tpLibId).disabled = true;
          await savePromptTags();
          _tpLibs = null;
          await tpLoadLibs();
          _tpLibId = tpDefaultLib();
          tpSyncLibDD();
          renderTagPanel();
        }],
        [ezT('Restore default library'), () => { tpRecoverInto(tpSeedLibTree(_tpLibId)); tpRestoreLib(); }],
        ['-'],
        [ezT('Set as default library'), () => {
          try { localStorage.setItem('ezflex.tagLib', _tpLibId); } catch (_) {}
          phTip(ezT('Default library: ') + _tpLibId);
        }],
      ]);
    });
    const ins = el('div', 'eph-tp-ins');
    ins.addEventListener('contextmenu', (e) => {   // 已插入芯片面板空白处：也给随机 tag 入口
      if (e.target && e.target.closest && e.target.closest('.eph-tpi')) return;
      e.preventDefault(); e.stopPropagation();
      cmMenu(e.clientX, e.clientY, [[ezT('Generate random tags'), () => tpGenerateRandom()]]);
    });
    const row = el('div', 'eph-tp-row');
    const search = el('input'); search.placeholder = ezT('Search tags');
    search.classList.add('eph-tp-search');
    search._tpSearch = true;   // 标记：从这里选标签要跳分组
    tgAttach(search);
    const fur = el('label', 'eph-tp-fur');
    const furCb = el('input'); furCb.type = 'checkbox'; furCb.checked = _tpHideFurry;
    const furTx = el('span'); furTx.textContent = ezT('Hide furry');
    fur.appendChild(furCb); fur.appendChild(furTx);
    const filtBtn = el('button', 'eph-btn'); filtBtn.textContent = ezT('Filter');
    const sortBtn = el('button', 'eph-btn'); sortBtn.textContent = ezT('Sort');
    const randBtn = el('button', 'eph-btn'); randBtn.textContent = ezT('Random'); randBtn.title = ezT('Random tags');
    randBtn.addEventListener('click', openRandModal);
    const ownAdd = el('button', 'eph-btn'); ownAdd.textContent = ezT('+ Add tag');
    ownAdd.addEventListener('click', () => tpEditCard({ new: true, en: '', zh: '', item: null }));
    // 批量管理只走右键菜单（标签卡片/分组右键），这里放「标签提示」开关：开了打字就弹候选
    const ownArtist = el('button', 'eph-btn'); ownArtist.title = ezT('Artist reference');   // 插入画师标签的写法模板（全局）
    ownArtist.addEventListener('click', () => {
      const cur = tpArtistFmt();
      const mk = (v, label) => [(cur === v ? '✓ ' : '') + label, async () => {
        let tpl = v;
        if (v === '\u0001') {   // 自定义
          const v2 = await uiPrompt(ezT('Artist reference template ({art} = tag name)'), cur || '@{art}');
          if (!v2 || !v2.trim()) return;
          tpl = v2.trim();
          if (tpl.indexOf('{art}') < 0) tpl += '{art}';   // 没写占位符就当纯前缀
        }
        tpSetArtistFmt(tpl);
        renderTagPanel();
      }];
      const r = ownArtist.getBoundingClientRect();
      cmMenu(r.left, r.bottom + 4, [mk('', ezT('None')), mk('@{art}', '@'), mk('artist:{art}', 'artist:'), mk('\u0001', ezT('Custom'))]);
    });
    const ownHint = el('button', 'eph-btn'); ownHint.textContent = ezT('Tag hint');
    ownHint.title = ezT('Tag hint');
    ownHint.classList.toggle('on', tgState());
    ownHint.addEventListener('click', () => { tgSet(!tgState()); ownHint.classList.toggle('on', tgState()); if (tgState()) tgEnsure(); });
    const closeIfSame = (btn) => {   // 再点同一个按钮 = 关掉菜单（但菜单已经关了就照常重开，别要两下）
      if (_tpMenuBtn !== btn) { _tpMenuBtn = null; return false; }
      _tpMenuBtn = null;
      if (typeof _cmMenu !== 'undefined' && _cmMenu && _cmMenu.classList.contains('active')) { _cmMenu.classList.remove('active'); return true; }
      return false;   // 菜单已被别处关掉 → 这次当重新打开
    };
    const openMenu = (btn, items) => {
      if (closeIfSame(btn)) return;
      _tpMenuBtn = btn;
      const rb = btn.getBoundingClientRect();
      cmMenu(rb.left, rb.bottom + 4, items);
    };
    filtBtn.addEventListener('click', () => {
      if (closeIfSame(filtBtn)) return;
      const r = filtBtn.getBoundingClientRect();
      const exCat = () => {
        const rr = filtBtn.getBoundingClientRect();
        cmMenu(rr.left, rr.bottom + 4, CAT_ORDER.map(([v, l]) => [(_tpExcat.indexOf(v) >= 0 ? '✓ ' : '') + ezT(l), () => {
          const i = _tpExcat.indexOf(v);
          if (i >= 0) _tpExcat.splice(i, 1); else _tpExcat.push(v);
          renderTagPanel();
          exCat();
        }]));
      };
      _tpMenuBtn = filtBtn;
      cmMenu(r.left, r.bottom + 4, [
        [(_tpFav ? '✓ ' : '') + ezT('Favorites only'), () => { _tpFav = !_tpFav; renderTagPanel(); }],
        [(_tpEx621 ? '✓ ' : '') + ezT('Exclude e621 (furry)'), () => { _tpEx621 = !_tpEx621; _tpHideFurry = _tpEx621; furCb.checked = _tpEx621; renderTagPanel(); }],
        ['-'],
        [ezT('Exclude matching text...'), async () => {
          const v = await uiPrompt(ezT('Exclude keyword (space = several)'), _tpExword.join(' '));
          _tpExword = v ? String(v).toLowerCase().split(/\s+/).filter(Boolean) : [];
          renderTagPanel();
        }],
        [ezT('Exclude category...'), exCat],
      ]);
    });
    sortBtn.addEventListener('click', () => {
      if (closeIfSame(sortBtn)) return;
      _tpMenuBtn = sortBtn;
      const r = sortBtn.getBoundingClientRect();
      cmMenu(r.left, r.bottom + 4, [
        [(_tpSort === 'default' ? '✓ ' : '') + ezT('Default order'), () => { _tpSort = 'default'; renderTagPanel(); }],
        [(_tpSort === 'name' ? '✓ ' : '') + ezT('By name'), () => { _tpSort = 'name'; renderTagPanel(); }],
        [(_tpSort === 'count' ? '✓ ' : '') + ezT('By count (danbooru)'), () => { _tpSort = 'count'; renderTagPanel(); }],
      ]);
    });
    const row2 = el('div', 'eph-tp-row2');    // 四个小图标单独一行，不和工具栏挤一行
    const mkMini = (svg, title, fn) => { const b = el('button', 'eph-cm-mini'); b.type = 'button'; b.innerHTML = svg; b.title = title; b.addEventListener('click', fn); row2.appendChild(b); return b; };
    mkMini(CM_ICONS.selected, ezT('Expand'), () => { KIND_ORDER.forEach((k) => _libOpen.add(k)); _myClosed.clear(); renderTagPanel(); });   // 我的标签侧一起展开
    mkMini(CM_ICONS.collapse, ezT('Collapse all'), () => { _libOpen.clear(); _libTouched = true; cmCatWalk(_tagDoc.categories, (it) => _myClosed.add(String(it.id))); renderTagPanel(); });   // 我的标签侧一起收起

    const sideBtn = mkMini(_tpHideSide ? CM_ICONS.show : CM_ICONS.hide, _tpHideSide ? ezT('Show sidebar') : ezT('Hide sidebar'), () => {
      _tpHideSide = !_tpHideSide;
      cats.style.display = _tpHideSide ? 'none' : '';
      row2.classList.toggle('tp-collapsed', _tpHideSide);   // 只收这一行图标：标签库下拉和工具栏留着
      sideBtn.innerHTML = _tpHideSide ? CM_ICONS.show : CM_ICONS.hide;
      sideBtn.title = _tpHideSide ? ezT('Show sidebar') : ezT('Hide sidebar');
    });
    sideBtn.classList.add('eph-tp-side');
    row.appendChild(search); row.appendChild(filtBtn); row.appendChild(sortBtn); row.appendChild(randBtn); row.appendChild(ownAdd); row.appendChild(ownHint);
    row.appendChild(ownArtist);             // 引用画师放最后
    row.insertBefore(libDD.el, row.firstChild);   // 标签库下拉排第一个
    const treeBtn = el('button', 'eph-cm-mini'); treeBtn.type = 'button';
    treeBtn.innerHTML = _tpFlat ? CM_ICONS.list : CM_ICONS.tree;
    treeBtn.title = ezT('Toggle tree / list');
    treeBtn.addEventListener('click', () => {
      _tpFlat = !_tpFlat;
      treeBtn.innerHTML = _tpFlat ? CM_ICONS.list : CM_ICONS.tree;   // 点了立刻换图标
      renderTagPanel();
    });
    row2.insertBefore(treeBtn, row2.firstChild);                      // 排图标行最前面
    const split = el('div', 'eph-tp-split');
    const cats = el('div', 'eph-tp-cats');
    const right = el('div', 'eph-cm-right');
    const batchBar = el('div', 'eph-cm-bbar');
    const tAll = el('button', 'eph-btn'); tAll.textContent = ezT('Select all');
    const tInv = el('button', 'eph-btn'); tInv.textContent = ezT('Invert selection');
    const tMove = el('button', 'eph-btn'); tMove.textContent = ezT('Move to group');
    const tDel = el('button', 'eph-btn danger'); tDel.textContent = ezT('Delete');
    const tDone = el('button', 'eph-btn'); tDone.textContent = ezT('Done');
    const tGen = el('button', 'eph-btn'); tGen.textContent = ezT('Generate previews');
    tGen.addEventListener('click', () => genPreviews(Array.from(_tpSel).map((k) => tpKeyName(k))));
    const tRmPv = el('button', 'eph-btn'); tRmPv.textContent = ezT('Remove previews'); tRmPv.title = ezT('Remove the preview images of the selected tags');
    tRmPv.addEventListener('click', () => tagRemoveSelPreviews());
    batchBar.appendChild(tAll); batchBar.appendChild(tInv); batchBar.appendChild(tMove); batchBar.appendChild(tGen); batchBar.appendChild(tRmPv); batchBar.appendChild(tDel); batchBar.appendChild(tDone);
    const list = el('div', 'eph-tp-list');
    list.addEventListener('contextmenu', (e) => {   // 右侧卡片区空白处
      if (e.target && e.target.closest && e.target.closest('.eph-cm-tile')) return;
      e.preventDefault(); e.stopPropagation();
      cmMenu(e.clientX, e.clientY, [
        [ezT('New tag'), () => tpEditCard({ new: true, en: '', zh: '', item: null })],
        [ezT('Generate random tags'), () => tpGenerateRandom()],
        ['-'],
        [ezT('Restore default library'), () => { tpRecoverInto(tpSeedLibTree(_tpLibId)); tpRestoreLib(); }],
      ]);
    });
    list.addEventListener('click', (e) => { if (e.target === list) { _tpSel = new Set(); renderTagPanel(); } });

    const pgBar = el('div', 'eph-tp-page');   // 翻页栏（列表下方，同 MediaOut 的排法）
    right.appendChild(batchBar); right.appendChild(list); right.appendChild(pgBar);
    split.appendChild(cats); split.appendChild(right);
    const grip = el('div', 'eph-tp-grip');
    p.appendChild(hd); p.appendChild(ins); p.appendChild(row); p.appendChild(row2); p.appendChild(split); p.appendChild(grip);
    document.body.appendChild(p);
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const sw = p.offsetWidth, sh = p.offsetHeight, sx = e.clientX, sy = e.clientY;
      p.style.maxHeight = 'none';
      const mv = (ev) => {
        p.style.width = Math.max(380, sw + ev.clientX - sx) + 'px';
        p.style.height = Math.max(240, sh + ev.clientY - sy) + 'px';
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    p._list = list; p._cats = cats; p._ins = ins; p._search = search; p._libDD = libDD; p._batchBar = batchBar;
    try { p._ro = new ResizeObserver(() => tpCardWidth()); p._ro.observe(list); } catch (_) {}   // 面板改宽度（平铺缩放/窗口变化）时重算卡宽 p._tpPage = pgBar;
    // 面板缩放（拖右下角握把）后按新宽度重排页码：只重画翻页栏
    if (window.ResizeObserver) {
      _tpRo = new ResizeObserver(() => {
        clearTimeout(p._roT);
        p._roT = setTimeout(() => { if (_tpEl && _tpEl._tpPage) tpPageBar(_tpEl._tpPage, _tpPage, _tpPages, _tpTotalN); }, 80);
      });
      _tpRo.observe(p);
    }
    p._ownHint = ownHint; p._ownArtist = ownArtist; p._tDel = tDel; p._tMove = tMove; p._tAll = tAll; p._tInv = tInv;
    tAll.addEventListener('click', () => tagSelAll(false));
    tInv.addEventListener('click', () => tagSelAll(true));
    tDel.addEventListener('click', () => tagDeleteSel());
    tDone.addEventListener('click', () => tagBatchToggle(false));
    tMove.addEventListener('click', () => { if (!_tpSel.size) return; const r0 = tMove.getBoundingClientRect(); tagMoveMenu(r0.left, r0.bottom + 4); });
    cats.addEventListener('contextmenu', (e) => {
      if (e.target && e.target.closest && e.target.closest('.eph-tp-cat')) return;
      e.preventDefault(); e.stopPropagation();
      const tgt = tpNewCatTarget();   // 选中我的分类/库分组 → 在里面建子分类；「全部」→ 当前树的根
      cmMenu(e.clientX, e.clientY, [
        [ezT('New category'), async () => { await newTagCategory(tgt.parent, tgt.root); renderTagPanel(); }],
        ['-'],
        [ezT('Restore default library'), () => { tpRecoverInto(tpSeedLibTree(_tpLibId)); tpRestoreLib(); }],
      ]);
    });
    close.addEventListener('click', closeTagPicker);
    search.addEventListener('input', () => { _tpQ = search.value; renderTagPanel(); });
    libDD.addEventListener('change', async (v) => {
      _tpLibId = v; _tpCat = CM_ALL; _tpQ = ''; search.value = '';
      await tpLoadLib(v); renderTagPanel();
    });
    furCb.addEventListener('change', () => { _tpHideFurry = furCb.checked; _tpEx621 = furCb.checked; renderTagPanel(); });   // 两个变量一起改，否则只改计数不改列表
    // 拖动：按住标题栏移动（同查找替换）；点下拉/按钮不触发
    hd.addEventListener('mousedown', (e) => {
      if (p.classList.contains('ph-dock')) return;   // 平铺态交给 phDockInstall 的拖动
      if (e.target.closest('button') || e.target.closest('.eph-dd')) return;
      const sx = e.clientX, sy = e.clientY, ox = p.offsetLeft, oy = p.offsetTop;
      e.preventDefault();
      const mv = (ev) => { p.style.left = (ox + ev.clientX - sx) + 'px'; p.style.top = (oy + ev.clientY - sy) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTagPicker(); }, true);
    _tpEl = p;
    if (!_tpOutH) {   // 点面板外面：第一下只关插入面板，卡片弹窗/总体编辑要再点一次
      // 我们自己的浮层（右键菜单 / 下拉 / 卡片弹窗 / 总体编辑…）都算"面板内"，点它们不能关标签面板
      const inOwn = (t0) => {
        if (!t0) return false;
        if (t0.closest && t0.closest('.eph-ctx,.eph-tools-dropdown,.eph-color-dropdown,.eph-dd,.eph-dd-menu,.eph-tpw,.eph-tgh,.eph-cm,.eph-tp-rename,.eph-modal-box,.eph-all-box,.eph-rb-box')) return true;
        return _phLayers.some((L) => L && L.contains && L.contains(t0));
      };
      // 确认框 / 输入框（uiConfirm=100010 / uiPrompt=100150）开着时也别关面板
      const dlgOpen = () => {
        try { for (const k of document.body.children) { const z = parseInt((k.style && k.style.zIndex) || '0', 10); if (z >= 100010 && k.style.display !== 'none') return true; } } catch (_) {}
        return false;
      };
      _tpOutH = (e) => {
        const t0 = e.target;
        if (e.type === 'click' || e.type === 'mouseup') {
          if (!_tpSwallow) return;
          if (e.type === 'click') _tpSwallow = false;
          if (inOwn(t0)) return;                 // 点自己的菜单/浮层：别把点击吞掉（否则菜单项"点不动"）
          e.stopPropagation(); e.preventDefault();
          return;
        }
        if (!_tpEl || !_tpEl.classList.contains('active')) return;
        if (_tpEl.classList.contains('ph-dock')) return;   // 平铺面板：点外侧不关，只能 ✕
        if (_tpEl.contains(t0) || (_tpwEl && _tpwEl.contains(t0)) || inOwn(t0) || dlgOpen()) return;
        _tpSwallow = true;
        e.stopPropagation(); e.preventDefault();
        closeTagPicker();
      };
      document.addEventListener('mousedown', _tpOutH, true);
      document.addEventListener('mouseup', _tpOutH, true);
      document.addEventListener('click', _tpOutH, true);
    }
  }
  const target = targetEd || _phActiveEditor;
  if (_tpEl.classList.contains('active') && _tagPickTarget === target) { closeTagPicker(); return; }   // 再点一次收起
  _tagPickTarget = target;
  try { tpSyncFromEditor(); } catch (_) {}   // 打开就按默认提示词同步已插入
  tpWatch();
  _tpIns = _tpIns.filter((en) => phTagRangeOf(target, en));   // 只留这个编辑器里真有的
  _tpQ = '';
  _tpEl._search.value = '';
  _tpEl._libDD.setItems(_tpLibs.map((x) => ({ value: x.id, label: x.label })));
  _tpEl._libDD.value = _tpLibId;
  await tpLoadLib(_tpLibId);
  renderTagPanel();
  _tpEl.classList.add('active');
  try {
    const r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : null;
    const w = 560, h = Math.min(window.innerHeight * 0.76, 620);
    let left = r ? r.left : 120;
    let top = r ? (r.bottom + 6) : 90;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    if (r && top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    _tpEl.style.left = left + 'px'; _tpEl.style.top = top + 'px';
  } catch (_) {}
  const dnode = (_allModal && _allModal._node) || (_editModal && _editModal._node) || null;
  if (dnode) { _tpEl._node = dnode; if (phDockOn(dnode)) { try { phDockApply(_tpEl, dnode); } catch (_) {} } }
}

// 卡片管理 / 标签管理弹窗头（对齐 ModelsCombo 浏览）：标题 + PromptHelper 徽标 + 搜索（靠右）+ 全屏 / 关闭
function cmHeadEl(titleText, ph, onSearch, fullTitle) {
  const hd = el('div', 'eph-cm-hd');
  const t = el('b'); t.textContent = titleText;
  const badge = el('span', 'eph-cm-badge'); badge.textContent = 'PromptHelper';
  const search = el('input', 'eph-cm-search'); search.type = 'text'; search.placeholder = ph;
  search.addEventListener('input', () => onSearch(search.value));
  const full = el('button', 'eph-btn eph-modal-full'); full.textContent = ezT('Fullscreen'); full.title = fullTitle;
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  const right = el('div', 'eph-cm-hdright');
  right.appendChild(full); right.appendChild(close);
  hd.appendChild(t); hd.appendChild(badge); hd.appendChild(search);
  return { hd, search, full, close, end: () => { hd.appendChild(right); return hd; } };
}
function cmHeadWire(ov, head) {
  head.close.addEventListener('click', () => ov.classList.remove('active'));
  head.full.addEventListener('click', () => { ov.classList.toggle('full'); head.full.textContent = ov.classList.contains('full') ? ezT('Exit fullscreen') : ezT('Fullscreen'); });
}

function cardMgrEl() {
  if (_cardMgr && _cardMgr.parentNode) return _cardMgr;
  _cardMgr = el('div', 'eph-cm');
  const box = el('div', 'eph-cm-box');
  const head = cmHeadEl(ezT('Card manager'), ezT('Search saved cards'), (v) => { _cmSearchQ = v; cmPreloadCards().then(() => cmRenderEntries()); }, ezT('Card manager fullscreen / exit fullscreen'));
  const body = el('div', 'eph-cm-body');

  const split = el('div', 'eph-cm-split');
  const cats = el('div', 'eph-cm-cats');
  const right = el('div', 'eph-cm-right');
  const batchBar = el('div', 'eph-cm-bbar');
  const bAll = el('button', 'eph-btn'); bAll.textContent = ezT('Select all');
  const bInv = el('button', 'eph-btn'); bInv.textContent = ezT('Invert selection');
  const bMerge = el('button', 'eph-btn'); bMerge.textContent = ezT('Merge');
  const bDel = el('button', 'eph-btn danger'); bDel.textContent = ezT('Delete');
  const bDone = el('button', 'eph-btn'); bDone.textContent = ezT('Done');
  batchBar.appendChild(bAll); batchBar.appendChild(bInv); batchBar.appendChild(bMerge); batchBar.appendChild(bDel); batchBar.appendChild(bDone);
  const list = el('div', 'eph-cm-list');
  right.appendChild(batchBar); right.appendChild(list);
  split.appendChild(cats); split.appendChild(right);
  const tools = el('div', 'eph-cm-tools');
  const toolsL = el('div', 'eph-cm-tools-l');
  const toolsLabel = el('span', 'eph-cm-tlabel eph-cm-catctl'); toolsLabel.textContent = ezT('Group');
  const tbtns = el('div', 'eph-cm-tbtns');
  toolsL.appendChild(toolsLabel); toolsL.appendChild(tbtns);
  tools.appendChild(toolsL);
  const mkTool = (svg, title, fn) => { const b = el('button', 'eph-cm-mini'); b.type = 'button'; b.innerHTML = svg; b.title = title; b.addEventListener('click', fn); tbtns.appendChild(b); return b; };
  const treeBtn = mkTool(_cmCatMode === 'list' ? CM_ICONS.list : CM_ICONS.tree, ezT('Toggle tree / list'), () => {
    _cmCatMode = _cmCatMode === 'tree' ? 'list' : 'tree';
    treeBtn.innerHTML = _cmCatMode === 'list' ? CM_ICONS.list : CM_ICONS.tree;
    cmRenderCats();
  });
  treeBtn.classList.add('eph-cm-catctl');
  const selBtn = mkTool(CM_ICONS.selected, ezT('Expand selected folder'), () => cmExpandSelected());
  selBtn.classList.add('eph-cm-catctl');
  const colBtn = mkTool(CM_ICONS.collapse, ezT('Collapse all'), () => { _cmCollapsed = new Set(); cmCatWalk(_cmCats, (it) => _cmCollapsed.add(it.id)); cmRenderCats(); });
  colBtn.classList.add('eph-cm-catctl');
  const sideBtn = mkTool(_cmSideHidden ? CM_ICONS.show : CM_ICONS.hide, _cmSideHidden ? ezT('Show sidebar') : ezT('Hide sidebar'), () => {
    _cmSideHidden = !_cmSideHidden;
    cats.style.display = _cmSideHidden ? 'none' : '';
    tools.classList.toggle('collapsed', _cmSideHidden);   // 收起后只剩这个小箭头
    sideBtn.innerHTML = _cmSideHidden ? CM_ICONS.show : CM_ICONS.hide;
    sideBtn.title = _cmSideHidden ? ezT('Show sidebar') : ezT('Hide sidebar');
  });
  sideBtn.classList.add('eph-cm-side');
  const scopeDD = makeDropdown([
    { value: 'all', label: ezT('All') },
    { value: 'name', label: ezT('Card group title') },
    { value: 'title', label: ezT('Card title') },
    { value: 'content', label: ezT('Content') },
  ]);
  scopeDD.el.style.flex = '0 0 auto'; scopeDD.el.style.maxWidth = '104px'; scopeDD.value = 'all';
  head.hd.appendChild(scopeDD.el);
  scopeDD.addEventListener('change', (v) => { _cmSearchScope = v; cmPreloadCards().then(() => cmRenderEntries()); });
  body.appendChild(tools);
  body.appendChild(split);

  const foot = el('div', 'eph-cm-foot');
  const hint = el('div', 'eph-cm-hint');
  const addBtn = el('button', 'eph-btn'); addBtn.textContent = ezT('Add cards');
  const useBtn = el('button', 'eph-btn eph-btn-save'); useBtn.textContent = ezT('Use cards');
  foot.appendChild(hint); foot.appendChild(addBtn); foot.appendChild(useBtn);
  body.appendChild(foot);

  box.appendChild(head.end()); box.appendChild(body);
  _cardMgr.appendChild(box); document.body.appendChild(_cardMgr);
  _cardMgr._hint = hint; _cardMgr._cats = cats; _cardMgr._list = list; _cardMgr._batchBar = batchBar;
  _cardMgr._addBtn = addBtn; _cardMgr._useBtn = useBtn;
  cmHeadWire(_cardMgr, head);
  // 点外侧关闭，但「从弹窗内部拖到外面松开」不关闭（同卡片编辑弹窗）：比对按下时的落点
  let _cmDownInBox = false;
  _cardMgr.addEventListener('mousedown', (e) => { _cmDownInBox = box.contains(e.target); });
  _cardMgr.addEventListener('mouseup', (e) => {
    if (e.target === _cardMgr && !_cmDownInBox && (_phClosedEl === null || _phClosedEl === _cardMgr)) _cardMgr.classList.remove('active');
    _cmDownInBox = false;
  });
  // 分类栏空白处右键 = 在选中分类下新增分类（没选分类 = 根）
  cats.addEventListener('contextmenu', (e) => {
    if (e.target && e.target.closest && e.target.closest('.eph-cm-cat')) return;
    e.preventDefault(); e.stopPropagation();
    const hit = _cmCatId ? cmCatFind(_cmCatId) : null;
    cmCatMenu(e.clientX, e.clientY, hit ? hit.node : null);
  });
  bAll.addEventListener('click', () => { _cmEntries = new Set(cmVisibleEntries().map((x) => x.name)); cmRenderEntries(); });
  bInv.addEventListener('click', () => {
    const cur = new Set(_cmEntries);
    _cmEntries = new Set(cmVisibleEntries().filter((x) => !cur.has(x.name)).map((x) => x.name));
    cmRenderEntries();
  });
  bMerge.addEventListener('click', () => cmMergeInto(Array.from(_cmEntries)));
  bDel.addEventListener('click', () => cmDeleteEntries(Array.from(_cmEntries)));
  bDone.addEventListener('click', () => cmBatchToggle(false));
  addBtn.addEventListener('click', () => { const n = cmEntriesSelected(_cmEntry); if (n.length) cmAppend(n); else cmHint(ezT('Select a saved card on the right first.'), 'err'); });
  useBtn.addEventListener('click', () => { const n = cmEntriesSelected(_cmEntry); if (n.length) cmUse(n); else cmHint(ezT('Select a saved card on the right first.'), 'err'); });
  return _cardMgr;
}
// insertEd 给了编辑器 = 「插入模式」：点条目把内容插到那个编辑器光标处（卡片弹窗/总体编辑的「卡片」按钮）
async function openCardMgr(node, insertEd) {
  if (!node) return;
  const m = cardMgrEl();
  m._node = node;
  m._insertEd = insertEd || null;
  _cmCatId = CM_ALL; _cmEntry = ''; _cmEntries = new Set(); _cmAnchorIdx = -1;
  cmBatchToggle(false);
  if (m._addBtn) m._addBtn.style.display = m._insertEd ? 'none' : '';
  if (m._useBtn) m._useBtn.style.display = m._insertEd ? 'none' : '';
  cmHint(m._insertEd ? ezT('Double-click a saved card to insert its content at the cursor') : '');
  await cmRefreshList();
  m.classList.add('active');
}

// ===== 面板右键 / 批量保存（已保存条目走 CARDS_API）=====
async function cmFetchList() {
  try { const r = await fetchApi(CARDS_API); const d = await r.json().catch(() => ({})); return Array.isArray(d.cards) ? d.cards : []; }
  catch (_) { return []; }
}
async function cmPostCard(name, cards, kind, category) {
  const r = await fetchApi(CARDS_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, cards: cards, kind: kind, category: category || '' }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}
// 右键单张卡片：按当前卡片名称单独保存（没标题才弹名字）
async function saveSingleCard(node, card) {
  let name = (card.title || '').trim();
  if (!name) { const n = await uiPrompt(ezT('Save name (e.g. storyboard-night)')); name = (n || '').trim(); }
  if (!name) return;
  const list = await cmFetchList();
  if (list.some((x) => x.name === name) && !(await uiConfirm(ezT('A card named "') + name + ezT('" already exists. Overwrite?')))) return;
  try { await cmPostCard(name, [card], 'card', ''); phTip(ezT('Saved "') + name + ezT('".'), 2400); }
  catch (e) { phTip(ezT('Save failed: ') + (e && e.message ? e.message : e)); }
}
// 整份/选中卡片存成一个卡片组
async function saveGroupFromPanel(cards) {
  const list = Array.isArray(cards) ? cards : [];
  if (!list.length) { phTip(ezT('No prompt cards to save.')); return; }
  const n = await uiPrompt(ezT('Card group name'), 'group-' + Date.now().toString(36));
  const name = (n || '').trim();
  if (!name) return;
  const saved = await cmFetchList();
  if (saved.some((x) => x.name === name) && !(await uiConfirm(ezT('A card named "') + name + ezT('" already exists. Overwrite?')))) return;
  try { await cmPostCard(name, list, 'group', ''); phTip(ezT('Saved "') + name + ezT('" (') + list.length + ezT(' cards)'), 2400); }
  catch (e) { phTip(ezT('Save failed: ') + (e && e.message ? e.message : e)); }
}
function batchSelIds(node) { return node && node._ezBatchSel ? node._ezBatchSel : new Set(); }
function batchToggle(node, on) {
  node._ezBatch = !!on;
  node._ezBatchAnchor = -1;                                            // Shift 连选的锚点
  node._ezBatchSel = (on && node._ezBatchSel) ? node._ezBatchSel : new Set();
  const root = node && node._ezRoot;
  if (root) { const b = root.querySelector('.eph-batch'); if (b) b.classList.toggle('on', !!on); }
  refreshUI(node);
}
function toggleBatchSel(node, id) {
  if (!node._ezBatchSel) node._ezBatchSel = new Set();
  if (node._ezBatchSel.has(id)) node._ezBatchSel.delete(id); else node._ezBatchSel.add(id);
  refreshUI(node);
}
// 面板上的批量选择：单点只选它、Ctrl 切换、Shift 从上次点到这次连选（同卡片管理 / 标签面板）
function batchPickCard(node, idx, shift, mod) {
  const ids = stateFor(node).cards.map((c) => c.id);
  if (!ids[idx]) return;
  if (mod) { toggleBatchSel(node, ids[idx]); node._ezBatchAnchor = idx; return; }
  const anchor = node._ezBatchAnchor;
  if (shift && anchor >= 0 && ids[anchor]) {
    node._ezBatchSel = new Set();
    for (let k = Math.min(anchor, idx); k <= Math.max(anchor, idx); k++) node._ezBatchSel.add(ids[k]);
    refreshUI(node);
    return;
  }
  node._ezBatchSel = new Set([ids[idx]]);
  node._ezBatchAnchor = idx;
  refreshUI(node);
}
function batchSelectAll(node, invert) {
  const st = stateFor(node); const cur = batchSelIds(node);
  node._ezBatchSel = new Set((invert ? st.cards.filter((c) => !cur.has(c.id)) : st.cards).map((c) => c.id));
  node._ezBatchAnchor = -1;
  refreshUI(node);
}
async function batchSaveIndividual(node) {
  const st = stateFor(node);
  const sel = st.cards.filter((c) => batchSelIds(node).has(c.id));
  if (!sel.length) { phTip(ezT('Select the prompt cards to save first.')); return; }
  const saved = await cmFetchList();
  const dup = sel.map((c) => (c.title || '').trim()).filter((n) => n && saved.some((x) => x.name === n));
  if (dup.length && !(await uiConfirm(ezT('These saved cards will be overwritten: ') + dup.join(', ') + ezT('. Continue?')))) return;
  let ok = 0;
  try {
    for (const c of sel) {
      const name = (c.title || '').trim() || ('card-' + Date.now().toString(36));
      await cmPostCard(name, [c], 'card', '');
      ok += 1;
    }
    phTip(ezT('Saved ') + ok + ezT(' cards)'), 2400);
  } catch (e) { phTip(ezT('Save failed: ') + (e && e.message ? e.message : e)); }
}
async function batchSaveGroup(node) {
  const sel = stateFor(node).cards.filter((c) => batchSelIds(node).has(c.id));
  if (!sel.length) { phTip(ezT('Select the prompt cards to save first.')); return; }
  await saveGroupFromPanel(sel);
}

// ===== 总体编辑（Word 大纲：每条卡片=  左侧小标题行[序号/标题/时间轴/删除] + 下方内容；默认/优化滑块 + 工具栏（含 skill 插入）；点外面自动保存关闭）=====
let _allModal = null, _allTab = 'default';
const _allClosed = new Set();   // 总体编辑里单独折叠的卡片 id（摘要行留着、只收正文；重建块时按 id 还原）
function runToolOn(ed, id) {
  if (!ed) return;
  const mapFH = { '，': ',', '。': '.', '！': '!', '？': '?', '：': ':', '；': ';', '“': '"', '”': '"', '‘': "'", '’': "'", '（': '(', '）': ')', '【': '[', '】': ']', '《': '<', '》': '>', '、': ',', '—': '-', '～': '~' };
  const mapHF = { ',': '，', '.': '。', '!': '！', '?': '？', ':': '：', ';': '；', '"': '“', "'": '‘', '(': '（', ')': '）', '[': '【', ']': '】', '<': '《', '>': '》', '~': '～', '-': '—' };
  const convert = (s) => {
    if (id === 'fullToHalf') return s.replace(/[，。！？：；“”‘’（）【】《》、—～]/g, (ch) => mapFH[ch] || ch).replace(/\u3000/g, ' ');
    if (id === 'halfToFull') return s.replace(/[,\.!\?:;"'\(\)\[\]<>~-]/g, (ch) => mapHF[ch] || ch);
    if (id === 'dashToUnderscore') return s.replace(/-/g, '_');
    if (id === 'underscoreToDash') return s.replace(/_/g, '-');
    if (id === 'dashToSpace') return s.replace(/-/g, ' ');
    if (id === 'underscoreToSpace') return s.replace(/_/g, ' ');
    return s;
  };
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
  const insCardBtn2 = el('button', 'eph-btn'); insCardBtn2.textContent = ezT('Card');
  insCardBtn2.title = ezT('Insert saved card');   // 点一份存档 → 内容插到光标处（卡片组合成一块）
  insCardBtn2.addEventListener('click', (e) => { e.stopPropagation(); saveSelection(); openCardMgr((_allModal && _allModal._node) || (_editModal && _editModal._node), editor); });
  const insTagBtn2 = el('button', 'eph-btn'); insTagBtn2.textContent = ezT('Tag');
  insTagBtn2.addEventListener('click', (e) => { e.stopPropagation(); saveSelection(); openTagPicker(editor, insTagBtn2); });
  toolbar.appendChild(insCardBtn2); toolbar.appendChild(insTagBtn2);
  const editor = el('div', 'eph-all-editor'); editor.contentEditable = 'true';
  attachMention(editor, () => ({ node: _allModal._node, card: caretCard(_allModal._node) }));
  tgAttach(editor);
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
  // 批量拆分（管理模式）：点卡片多选，再执行拆分（同 MediaLoader 的批量拆分）
  const splitBar = el('div', 'eph-all-splitbar');
  const splitLabel = el('span', 'eph-all-splitlabel');
  const spAll = el('button', 'eph-btn'); spAll.textContent = ezT('Select all');
  const spInv = el('button', 'eph-btn'); spInv.textContent = ezT('Invert selection');
  const spRun = el('button', 'eph-btn eph-btn-save'); spRun.textContent = ezT('Run split');
  const spCancel = el('button', 'eph-btn'); spCancel.textContent = ezT('Cancel');
  splitBar.appendChild(splitLabel); splitBar.appendChild(spAll); splitBar.appendChild(spInv); splitBar.appendChild(spRun); splitBar.appendChild(spCancel);
  spAll.addEventListener('click', () => { const mv = _allModal; if (!mv || !mv._ed) return; const blocks = Array.from(mv._ed.querySelectorAll('.eph-all-block')); mv._cmSplitSel = new Set(blocks.map((_, i) => i)); blocks.forEach((b) => b.classList.add('sel')); cmSplitUpdateCount(); });
  spInv.addEventListener('click', () => { const mv = _allModal; if (!mv || !mv._ed) return; const blocks = Array.from(mv._ed.querySelectorAll('.eph-all-block')); const cur = mv._cmSplitSel || new Set(); mv._cmSplitSel = new Set(blocks.map((_, i) => i).filter((i) => !cur.has(i))); blocks.forEach((b, i) => b.classList.toggle('sel', mv._cmSplitSel.has(i))); cmSplitUpdateCount(); });
  spRun.addEventListener('click', () => cmSplitRun());
  spCancel.addEventListener('click', () => cmSplitModeExit());
  box.appendChild(hd); box.appendChild(tabs); box.appendChild(tbToggle); box.appendChild(toolbar); box.appendChild(splitBar); box.appendChild(editor); box.appendChild(ft);
  _allModal.appendChild(box); document.body.appendChild(_allModal);
  _allModal._box = box; _allModal._ed = editor; _allModal._indentIn = indentIn;
  // 自动保存只在平铺模式：焦点离开编辑器就写回（弹窗模式不自动存，点「取消」仍能丢弃）
  editor.addEventListener('focusout', () => { if (_allModal.classList.contains('ph-dock')) { const nd = _allModal && _allModal._node; if (nd) { try { syncAllContent(nd); } catch (_) {} } } });
  _allModal._splitBar = splitBar; _allModal._splitLabel = splitLabel;
  _allModal._tabDefault = tabDefault; _allModal._tabOptimized = tabOptimized; _allModal._tabThumb = tabThumb;
  _allModal._hlDD = hlDD; _allModal._fcDD = fcDD; _allModal._toolsDD = toolsDD;
  close.addEventListener('click', () => { _phActiveEditor = null; _allModal.classList.remove('active'); try { phDockRemember(_allModal._node); } catch (_) {} allFireAfterClose(true); });
  cancelBtn.addEventListener('click', () => { _phActiveEditor = null; _allModal.classList.remove('active'); try { closeTagPicker(); } catch (_) {} try { phDockRemember(_allModal._node); } catch (_) {} allFireAfterClose(false); });
  saveBtn.addEventListener('click', () => {
    if (_allModal.classList.contains('ph-dock')) { const nd = _allModal._node; if (nd) { syncAllContent(nd); phTip(ezT('Saved')); allFireAfterClose(true); } return; }   // 平铺：存下但不关
    saveAllEditor();
  });
  tabDefault.addEventListener('click', () => switchAllTab('default'));
  tabOptimized.addEventListener('click', () => switchAllTab('optimized'));
  toolbar.addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (b) { execCommandOn(editor, b.dataset.cmd); e.preventDefault(); } });
  indentIn.addEventListener('change', () => { editor.querySelectorAll('.eph-all-block-body').forEach((x) => { const n = parseFloat(indentIn.value) || 0; x.style.textIndent = n ? n + 'em' : ''; if (!String(x.textContent || '').trim() && !x.querySelector('br')) x.appendChild(document.createElement('br')); }); });
  addCardBtn.addEventListener('click', () => { const nd = _allModal._node; if (nd) { addCard(nd); openAllEditor(nd); } });
  // 工具 / 插入引用下拉
  [[ezT('Optimize prompt (API)'), 'api'], [ezT('Optimize prompt (TextGenerate)'), 'textgen'], [ezT('Optimize prompt (llama)'), 'llama'], [ezT('Find & replace'), 'find'], [ezT('Hyphens to underscores'), 'dashToUnderscore'], [ezT('Underscores to hyphens'), 'underscoreToDash'], [ezT('Hyphens to spaces'), 'dashToSpace'], [ezT('Underscores to spaces'), 'underscoreToSpace'], [ezT('Full-width to half-width'), 'fullToHalf'], [ezT('Half-width to full-width'), 'halfToFull']].forEach(([t, id]) => { const b = el('button', 'eph-tool-item'); b.textContent = t; b.addEventListener('click', () => { if (id === 'api' || id === 'textgen' || id === 'llama') { runBatchOptimize(_allModal && _allModal._node, id); } else if (id === 'find') { openFindModal('find', _allModal && _allModal._ed); } else { runToolOn(editor, id); } toolsDD.classList.remove('active'); }); toolsDD.appendChild(b); });
  toolsBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); toolsDD.classList.toggle('active'); if (toolsDD.classList.contains('active')) phFixedDD(toolsBtn, toolsDD); });
  // 点弹窗外空白自动保存关闭；卡片内部拖动到外面松开不关（只在外面点击才关）
  let _allStartInBox = false;
  _allModal.addEventListener('mousedown', (e) => { _allStartInBox = box.contains(e.target); });
  _allModal.addEventListener('mouseup', (e) => { if (!_allModal.classList.contains('ph-dock') && e.target === _allModal && _phDownTarget === _allModal && !_allStartInBox && (_phClosedEl === null || _phClosedEl === _allModal)) saveAllEditor(); _allStartInBox = false; });
  _allModal._phOnClose = () => { try { phDockRemember(_allModal._node); } catch (_) {} allFireAfterClose(true); };
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
    body.innerHTML = ezSanitizeHtml(st.overallOptimizedHTML || st.overallOptimized || '');
    unwrapTagChips(body);
    block.appendChild(rw); block.appendChild(body);
    ed.appendChild(block);
    finishAllEditor(node);
    return;
  }
  const liveIds = new Set(st.cards.map((c) => String(c.id)));
  Array.from(_allClosed).forEach((id) => { if (!liveIds.has(id)) _allClosed.delete(id); });   // 删掉的卡片别在折叠表里堆着
  st.cards.forEach((card, idx) => {
    const block = el('div', 'eph-all-block'); block.dataset.idx = String(idx); block.dataset.cardId = String(card.id);
    if (_allClosed.has(String(card.id))) block.classList.add('closed');
    // 左侧小标题行：序号 / 标题(可编辑) / 时间轴 / 删除(-)
    const rw = el('div', 'eph-all-block-hd'); rw.contentEditable = 'false';
    const num = el('span', 'eph-all-num'); num.textContent = String(idx + 1);
    const titleEl = el('span', 'eph-all-title'); titleEl.contentEditable = 'true'; titleEl.setAttribute('data-ph', ezT('Title'));
    titleEl.textContent = card.title || '';
    titleEl.addEventListener('input', () => { card.title = titleEl.textContent.replace(/\u200b/g, ''); syncToConfig(node); syncEditModalTitle(node, card); });
    // 单张卡片折叠（放在标题输入框后面）：只收正文，标题行留着可再点开；工具栏那颗是全局收起小标题行
    const foldEl = el('button', 'eph-all-fold'); foldEl.type = 'button'; foldEl.title = ezT('Collapse / expand this card');
    foldEl.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    foldEl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (block.classList.toggle('closed')) _allClosed.add(String(card.id)); else _allClosed.delete(String(card.id)); });
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
    rw.appendChild(num); rw.appendChild(titleEl); rw.appendChild(foldEl); rw.appendChild(mergeBtnH); rw.appendChild(refEl); rw.appendChild(delEl);
    block.appendChild(rw);
    // 下方内容（按当前页签）
        const body = el('div', 'eph-all-block-body');
    body.innerHTML = ezSanitizeHtml(card.contentHTML || card.content || '');
    unwrapTagChips(body);
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
  m._ed.querySelectorAll('.eph-all-block-body').forEach((x) => { x.style.textIndent = ni ? ni + 'em' : ''; if (!String(x.textContent || '').trim() && !x.querySelector('br')) x.appendChild(document.createElement('br')); });
  markBlankLines(m);
}
function openAllEditor(node) {
  const m = allEl(); m._node = node;
  try { cmSplitModeExit(); } catch (_) {}   // 每次打开都退出「批量拆分」管理模式
  phDockSwitchTo(m);
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
  try { closeTagPicker(); } catch (_) {}   // 总体编辑关了 → 插入标签面板一起收
  try { phDockRemember(nd); } catch (_) {}
  allFireAfterClose(true);
}
// 「已保存卡片在总体编辑里编辑」用：弹窗关掉后把编辑结果写回那份存档（save=false 表示取消，只还原）
function allFireAfterClose(save) {
  const m = _allModal; if (!m || !m._afterClose) return;
  const f = m._afterClose; m._afterClose = null;
  try { f(save); } catch (_) {}
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
  const batch = el('div', 'eph-batch');
  const bAll = el('button', 'eph-btn'); bAll.textContent = ezT('Select all');
  const bInv = el('button', 'eph-btn'); bInv.textContent = ezT('Invert selection');
  const bSave = el('button', 'eph-btn'); bSave.textContent = ezT('Save cards');
  const bGroup = el('button', 'eph-btn'); bGroup.textContent = ezT('Save card group');
  const bExit = el('button', 'eph-btn danger'); bExit.textContent = ezT('Exit batch');
  batch.appendChild(bAll); batch.appendChild(bInv); batch.appendChild(bSave); batch.appendChild(bGroup); batch.appendChild(bExit);
  root.appendChild(hd); root.appendChild(batch); root.appendChild(list);
  root._list = list; root._batch = batch;
  bAll.addEventListener('click', () => batchSelectAll(node, false));
  bInv.addEventListener('click', () => batchSelectAll(node, true));
  bSave.addEventListener('click', () => batchSaveIndividual(node));
  bGroup.addEventListener('click', () => batchSaveGroup(node));
  bExit.addEventListener('click', () => batchToggle(node, false));
  // 空白处右键：保存为卡片组 / 批量保存 / 打开卡片管理
  list.addEventListener('contextmenu', (e) => {
    if (e.target && e.target.closest && e.target.closest('.eph-card')) return;
    e.preventDefault(); e.stopPropagation();
    cmMenu(e.clientX, e.clientY, [
      [ezT('Save as card group'), () => saveGroupFromPanel(stateFor(node).cards.slice())],
      [ezT('Batch save cards'), () => batchToggle(node, true)],
      [ezT('Card manager'), () => openCardMgr(node)],
    ]);
  });
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
  // 「实时接收卡」：把本轮收到的外部文本写进卡片；源没变就保留用户在卡片里的临时编辑
  (uiList(ui.recv)).forEach((r) => {
    if (!r || r.id == null) return;
    const local = st.cards.find((x) => x && String(x.id) === String(r.id));
    if (!local || !local.liveIn) return;
    const text = String(r.text == null ? '' : r.text);
    if (String(local.liveRecv || '') === text) return;   // 源没变 → 保留卡片里的编辑
    local.liveRecv = text;
    local.content = text;
    local.contentHTML = '';
    local.useOptimized = false;
    changed = true;
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
  // 卡片弹窗正开着这张「实时接收卡」→ 把新收到的文本显示进编辑器（没在打字时才覆盖）
  try {
    const m = _editModal;
    if (m && m.classList.contains('active') && m._node === node && m._editor && !m._editor.contains(document.activeElement)) {
      const card = st.cards.find((c) => c && String(c.id) === String(st.editingId));
      if (card && card.liveIn && st.currentTab !== 'optimized') { m._editor.innerHTML = ezSanitizeHtml(card.contentHTML || card.content || ''); unwrapTagChips(m._editor); }
    }
  } catch (_) {}
}

// ===== 实时接收卡：不必等运行，直接按上游 ModelsCombo 的配置拉触发词（metadata 按 file 缓存） =====
const _phLoraTw = new Map();
function phTrainedWords(meta) {
  if (!meta || typeof meta !== 'object') return [];
  let tw = meta.trainedWords;
  if (!Array.isArray(tw) || !tw.length) { const c = meta.civitai; if (c && Array.isArray(c.trainedWords)) tw = c.trainedWords; }   // C 站的词在 civitai 下面
  if (!Array.isArray(tw)) tw = [];
  if (!tw.length && typeof meta.activation_text === 'string') tw = [meta.activation_text];
  return tw.map((w) => String(w == null ? '' : w).trim()).filter(Boolean);
}
async function phLoraWords(file) {
  if (_phLoraTw.has(file)) return _phLoraTw.get(file);
  let words = [];
  try {
    const r = await fetchApi('/models_combo/lora_meta_detail?type=lora&file=' + encodeURIComponent(file));
    if (r && r.ok) words = phTrainedWords(await r.json());
  } catch (_) {}
  _phLoraTw.set(file, words);
  return words;
}
function phComboLoaders(n) {
  const cfg = readConfig(n, []);
  return Array.isArray(cfg) ? cfg : ((cfg && Array.isArray(cfg.loaders)) ? cfg.loaders : []);
}
// 这张 PromptHelper 上，连着 ModelsCombo trigger_words 输出的实时卡
function phLiveJobs(node) {
  const st = stateFor(node);
  const jobs = [];
  st.cards.forEach((card) => {
    if (!card || !card.liveIn) return;
    const sock = (node.inputs || []).find((i) => i && String(i._ezCardId) === String(card.id));
    if (!sock || sock.link == null) return;
    const link = node.graph && node.graph.links && node.graph.links[sock.link];
    if (!link) return;
    const up = node.graph.getNodeById ? node.graph.getNodeById(link.origin_id) : null;
    if (!up || nodeTypeOf(up) !== 'EzFlex-ModelsCombo') return;
    const out = (up.outputs || [])[link.origin_slot];
    if (!out || out.name !== 'trigger_words') return;
    jobs.push({ card: card, up: up });
  });
  return jobs;
}
async function phPullLiveCards(node) {
  const jobs = phLiveJobs(node);
  if (!jobs.length) return;
  let changed = false;
  for (const j of jobs) {
    const files = phComboLoaders(j.up).filter((l) => l && l.type === 'lora' && l.file).map((l) => l.file);
    const words = [];
    for (const f of files) { const w = await phLoraWords(f); w.forEach((x) => { if (words.indexOf(x) < 0) words.push(x); }); }
    const text = words.join(', ');
    if (String(j.card.liveRecv || '') === text) continue;   // 源没变 → 保留卡片里的编辑
    j.card.liveRecv = text; j.card.content = text; j.card.contentHTML = ''; j.card.useOptimized = false;
    changed = true;
  }
  if (!changed) return;
  syncToConfig(node);
  refreshUI(node);
  try {   // 弹窗正开着这张实时卡 → 把新触发词显示进编辑器（没在打字时才覆盖）
    const m = _editModal;
    if (m && m.classList.contains('active') && m._node === node && m._editor && !m._editor.contains(document.activeElement)) {
      const st2 = stateFor(node);
      const card = st2.cards.find((c) => c && String(c.id) === String(st2.editingId));
      if (card && card.liveIn && st2.currentTab !== 'optimized') { m._editor.innerHTML = ezSanitizeHtml(card.contentHTML || card.content || ''); unwrapTagChips(m._editor); }
    }
  } catch (_) {}
}
// ModelsCombo 配置变了 → 连到它的 PromptHelper 实时卡跟着更新（不必等运行）
window.addEventListener('ezflex:config-changed', (e) => {
  const n = e && e.detail && e.detail.node;
  if (!n || nodeTypeOf(n) !== 'EzFlex-ModelsCombo') return;
  const g = app && app.graph;
  ((g && (g._nodes || g.nodes)) || []).forEach((ph) => { if (nodeTypeOf(ph) === NODE) { try { phPullLiveCards(ph); } catch (_) {} } });
});

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
  const hideAll = () => { all.forEach((item) => { try { item.el.style.display = 'none'; } catch (_) {} }); };
  const update = () => {
    const rootEl = node._ezRoot;
    if (!rootEl || !rootEl.isConnected) { hideAll(); return; }   // 控件没挂上/被临时摘掉：先把标签收掉，别留在屏幕上
    // 只在「当前渲染的那张图」里显示：子图（app.canvas.graph）也算当前图，别拿 app.graph 比
    const shown = (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
    if (shown && node.graph && node.graph !== shown) { hideAll(); return; }
    let rect = null;
    try { rect = rootEl.getBoundingClientRect(); } catch (_) { hideAll(); return; }
    if (!rect || rect.width <= 0) { hideAll(); return; }
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
    try { node.setSize([510, Math.max(120, Math.min(240, node.size ? node.size[1] : 120))]); } catch (_) {}
    hideConfigWidget(node);
    updatePorts(node, true);
    setTimeout(() => updatePorts(node), 80);
    installSocketLabels(node);
    phDockRestoreSoon(node);   // 上次平铺开着的面板（卡片弹窗/总体编辑/引用媒体）载入后自动恢复
  } catch (e) { console.error('[PromptHelper] init failed:', e); }
}
// 节点被删 / 新建工作流 / 切换工作流时，挂在它上面的浮层一起收掉，别留到新工作流里
function closeEzPanelsForNode(node) {
  if (!node) return;
  if (_tpEl && _tpEl._node === node) { try { closeTagPicker(); } catch (_) {} }
  [_editModal, _allModal, _refBrowser].forEach((ov) => {
    if (!ov || ov._node !== node || !ov.classList.contains('active')) return;
    if (ov === _refBrowser) { try { refBrowserCleanup(); } catch (_) {} }
    ov.classList.remove('active'); ov._node = null;
  });
  if (_phActiveEditor && !_phActiveEditor.isConnected) _phActiveEditor = null;
}
function closeAllEzPanels() {
  try { closeTagPicker(); } catch (_) {}
  [_editModal, _allModal, _refBrowser].forEach((ov) => {
    if (!ov || !ov.classList.contains('active')) return;
    if (ov === _refBrowser) { try { refBrowserCleanup(); } catch (_) {} }
    ov.classList.remove('active'); ov._node = null;
  });
  _phActiveEditor = null;
}
// LGraph.clear() 不一定给每个节点都走 onRemoved，这里再兜一层（新建 / 清空工作流）
function hookGraphClear() {
  const g = app && app.graph;
  const proto = g && Object.getPrototypeOf(g);
  if (!proto || proto.__ezPhClearHooked) return;
  proto.__ezPhClearHooked = true;
  const prev = proto.clear;
  proto.clear = function () { const r = prev.apply(this, arguments); try { closeAllEzPanels(); } catch (_) {} return r; };
}
function hookPrototype(nt) {
  if (!nt || nt.__ezPhHooked) return; nt.__ezPhHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; console.log('[PromptHelper] hook nodeCreated #' + this.id); setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = prevCfg ? prevCfg.apply(this, arguments) : undefined; loadFromConfig(this); updatePorts(this, true); refreshUI(this); try { phPullLiveCards(this); } catch (_) {} return r; };
  const prevConn = nt.prototype.onConnectionsChange; nt.prototype.onConnectionsChange = function (type, index, connected, link_info) {
    const r = prevConn ? prevConn.apply(this, arguments) : undefined;
    try { if (this._ezPhSetup) setTimeout(() => { updatePorts(this); refreshUI(this); try { phPullLiveCards(this); } catch (_) {} }, 0); } catch (_) {}
    return r;
  };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; unregisterNode(this); try { closeEzPanelsForNode(this); } catch (_) {} try { if (this._ezPhSyncTimer) clearTimeout(this._ezPhSyncTimer); } catch (_) {} try { if (this._ephOutRaf) cancelAnimationFrame(this._ephOutRaf); } catch (_) {} try { (this._ephOutEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); } catch (_) {} try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {} this._ezPhSetup = false; return r; };
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
  setup() { const g = app && app.graph; const ns = (g && (g._nodes || g.nodes)) || []; hookGraphClear(); loadGlobalMediaTarget(); loadGlobalRules(); ns.forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); startIndexWatcher(ns.find((n) => nodeTypeOf(n) === NODE)); onIndexChange(() => { refreshMediaChips(); refreshRefBrowser(); }); },
});
