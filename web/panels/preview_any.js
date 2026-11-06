// 面板：PreviewAny 面板：白板卡片、媒体探测展示、3D 查看器、导出
// EzFlex-PreviewAny 任意预览节点（V1.3 简化版）。
// 输入为固定 input_1..N ANY 槽；前端按「已连接 + 1 空槽」自动展示卡片（连一个自动加一个）。
// 卡片可拖拽排序，卡片顺序即 socket 顺序；顶部为「存档开关 + 保存位置」，卡片带文件夹图标打开已保存文件。
// 参考 AUNPassthroughAnyMulti（onExecuted entries + 固定 ANY 输入槽）。
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { ezT, onLocaleChange, ezRelabel } from "../core/ezflex_i18n.js";
import { openEzListPreview } from "../core/ezflex_listview.js";
import { ezThemeInit } from "../core/ezflex_theme.js";
import { ezApplyDefaultSize,
  NODE_TYPES, registerNode, unregisterNode, nodeTypeOf,
  configWidget, writeConfig, readConfig, installResizeHandles, makeDomWidgetHitThrough, installEdgeLabels, hideNativeSlotText, ezPushModal, ezPopModal, ezIsTopModal, makeAudioPlayer, ezPruneDanglingLinks,
  ezCaptureSocketLinks, ezApplySocketLinks,
  scheduleOnRedraw, pumpFrames, on,
  ezDropInput } from "../core/ezflex_service.js";

const NODE = NODE_TYPES.PREVIEW_ANY;
const MAX_CARDS = 16;

const CSS = `
.ezpv-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezpv-shell .ezpv-root{pointer-events:auto;}
.ezpv-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:var(--ez-fg);background:var(--ez-bg);border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.ezpv-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.ezpv-hd{display:flex;gap:6px;align-items:center;flex-wrap:nowrap;min-width:0;} /* 顶部工具栏单行不换行 */
.ezpv-btn{background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:var(--ez-fg);font-family:inherit;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;height:30px;line-height:1;}
.ezpv-btn:hover{background:var(--ez-surface-3);}
.ezpv-save.on{background:var(--ez-ok-bg);border-color:var(--ez-ok-border);color:var(--ez-ok-fg);}
.ezpv-save.on:hover{background:var(--ez-ok-bg);}
.ezpv-save.off{background:var(--ez-surface-2);border-color:var(--ez-border);color:var(--ez-fg-muted);}
.ezpv-save .ezpv-auto{font-size:8px;line-height:1;margin-left:2px;}
.ezpv-fs{width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;border-radius:0!important;margin:0!important;left:0!important;top:0!important;transform:none!important;}
.ezpv-loc{background:var(--ez-strong);color:var(--ez-on-strong);border-color:var(--ez-strong);}
.ezpv-loc:hover{background:var(--ez-strong);}
.ezpv-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;}
.ezpv-card{display:flex;align-items:center;gap:8px;background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:10px;padding:6px 8px;flex-wrap:nowrap;}
.ezpv-card.dragging{opacity:.4;}
.ezpv-handle{cursor:grab;color:var(--ez-fg-muted);font-size:14px;line-height:1.6;padding:0 2px;}
.ezpv-handle:hover{color:var(--ez-fg);}
.ezpv-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;}
.ezpv-crow{display:flex;align-items:center;gap:6px;}
.ezpv-cname{font-size:12px;font-weight:500;color:var(--ez-fg);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ezpv-badge{font-size:9px;font-weight:480;color:var(--ez-on-strong);background:var(--ez-strong);padding:0 7px;border-radius:100px;line-height:16px;white-space:nowrap;}
.ezpv-fldr{background:transparent;border:none;color:var(--ez-fg-muted);font-size:15px;line-height:1;cursor:pointer;padding:1px 3px;flex:0 0 auto;}
.ezpv-fldr:hover{color:var(--ez-fg-3);}
.ezpv-prev{background:var(--ez-surface-2);border:1px solid var(--ez-border-2);border-radius:8px;padding:5px 8px;font-size:11px;color:var(--ez-fg-2);font-family:monospace;line-height:1.4;white-space:pre-wrap;word-break:break-all;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;cursor:pointer;pointer-events:auto;min-height:30px;}
.ezpv-prev.long{cursor:pointer;}
.ezpv-prev.img{position:relative;display:flex;align-items:center;justify-content:center;padding:4px;background:var(--ez-surface-3);cursor:pointer;}   /* 与 MediaLoader 缩略图底一致 */
.ezpv-prev.img img{max-width:100%;max-height:120px;border-radius:6px;display:block;}
.ezpv-prev.img .ezpv-badge{position:absolute;top:5px;right:5px;}
.ezpv-prev.img .ezpv-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:30px;height:30px;border-radius:50%;background:var(--ez-strong);color:var(--ez-on-strong);font-size:14px;display:flex;align-items:center;justify-content:center;padding-left:2px;}
.ezpv-prev .ph{color:var(--ez-fg-muted);font-family:Inter,sans-serif;font-style:italic;}
.ezpv-lmain{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;}
.ezpv-lmain img{max-width:100%;max-height:100%;border-radius:8px;display:block;}
.ezpv-prev.audio{display:flex;align-items:center;justify-content:center;padding:6px 10px;background:var(--ez-surface-3);cursor:pointer;}
.ezpv-prev.audio .ez-ap{width:100%;max-width:320px;padding:2px 8px;gap:6px;border-radius:6px;min-height:0;}
.ezpv-prev.audio .ez-ap-track{height:4px;}
.ezpv-prev.audio .ez-ap-time{font-size:10px;}
.ezpv-prev.d3{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:8px;background:var(--ez-surface-3);cursor:pointer;}
.ezpv-prev.d3 .ezpv-d3ic{font-size:32px;line-height:1;color:var(--ez-fg-muted);}
.ezpv-prev.d3 .ezpv-d3btn{background:var(--ez-strong);border:1px solid var(--ez-strong);color:var(--ez-on-strong);border-radius:9px;padding:5px 13px;font-size:12px;cursor:pointer;font-family:inherit;}
.ezpv-prev.d3 .ezpv-d3btn:hover{filter:brightness(1.06);}
.ezpv-empty{color:var(--ez-fg-muted);font-size:12px;text-align:center;padding:14px;}
.ezpv-ph{height:0;border-top:3px solid var(--ez-fg-3);border-radius:2px;margin:1px 0;opacity:.9;box-shadow:0 1px 6px rgba(43,58,74,.35);}
.ezpv-ph.hidden{display:none;}
.ezpv-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:9999;background:rgba(0,0,0,.35);}
.ezpv-modal.active{display:flex;}
.ezpv-modal-box{background:var(--ez-bg);border-radius:16px;padding:14px 16px;width:92%;max-width:560px;max-height:84vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.2);font-family:Inter,sans-serif;}
.ezpv-modal-hd{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--ez-border-2);padding-bottom:8px;}
.ezpv-modal-hd b{font-size:13px;color:var(--ez-fg);}
.ezpv-modal-box textarea{width:100%;min-height:180px;max-height:60vh;padding:8px;border:1px solid var(--ez-border);border-radius:9px;font:11px/1.5 monospace;color:var(--ez-fg);background:var(--ez-bg);resize:both;overflow:auto;box-sizing:border-box;outline:none;}
.ezpv-kv{display:flex;flex-direction:column;gap:4px;overflow:auto;max-height:60vh;border:1px solid var(--ez-border-2);border-radius:9px;padding:6px;}
.ezpv-kv-row{display:flex;gap:8px;font:11px/1.5 monospace;border-bottom:1px solid var(--ez-border-2);padding:3px 4px;}
.ezpv-kv-k{flex:0 0 45%;color:var(--ez-fg-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all;}
.ezpv-kv-v{flex:1 1 auto;color:var(--ez-fg);word-break:break-all;white-space:pre-wrap;}
.ezpv-fpath{font:11px/1.5 monospace;color:var(--ez-fg-2);background:var(--ez-surface-2);border:1px solid var(--ez-border-2);border-radius:8px;padding:6px 8px;word-break:break-all;}
.ezpv-fdirs{display:flex;flex-direction:column;gap:4px;overflow:auto;max-height:240px;}
.ezpv-fdirs button{text-align:left;background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:8px;padding:5px 10px;font-size:12px;color:var(--ez-fg);cursor:pointer;font-family:inherit;}
.ezpv-fdirs button:hover{background:var(--ez-surface-3);}
.ezpv-media{position:fixed;z-index:9998;background:var(--ez-bg);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);padding:12px;display:none;left:50%;top:50%;transform:translate(-50%,-50%);max-width:82vw;max-height:82vh;overflow:auto;pointer-events:auto;}
.ezpv-media img,.ezpv-media video,.ezpv-media audio{user-select:none;-webkit-user-select:none;-webkit-user-drag:none;user-drag:none;}
.ezpv-media.active{display:block;}
.ezpv-media-body{display:flex;flex-direction:column;gap:8px;justify-content:center;align-items:center;}
.ezpv-media.ezpv-fs .ezpv-media-body{height:100%;justify-content:center;}
/* 只作用于「主图」（body 直接子元素）；缩略图条里的 img 在 .ezpv-strip-item 下，不能被全屏规则连带放大 */
.ezpv-media-body > img{max-width:min(70vw,720px);max-height:70vh;border-radius:8px;display:block;}
.ezpv-media.ezpv-fs .ezpv-media-body > img{width:auto;height:auto;max-width:100vw;max-height:100vh;object-fit:contain;cursor:grab;border-radius:0;transform-origin:center;}
.ezpv-media.ezpv-fs.has-strip .ezpv-media-body > img{max-height:calc(100vh - 130px);}   /* 全屏也保留底部缩略图条：主图留出位置，不被盖住 */
.ezpv-media.ezpv-fs video{width:100vw;height:100vh;object-fit:cover;max-width:none!important;max-height:none!important;}
.ezpv-media-meta{font:11px/1.5 monospace;color:var(--ez-fg);background:var(--ez-surface-2);border:1px solid var(--ez-border-2);border-radius:8px;padding:10px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:0;}
.ezpv-media.ezpv-fs .ezpv-media-meta{display:none!important;}   /* 全屏看图时隐藏元信息栏（退出全屏自动恢复；!important 覆盖内联 display:block） */
.ezpv-media .cap{font-size:12px;color:var(--ez-fg);padding:0 4px;}
.ezpv-strip{display:none;align-items:center;gap:6px;width:100%;}
.ezpv-media.has-strip .ezpv-strip{display:flex;}   /* 全屏不隐藏：多图时底部缩略图条一直在 */
.ezpv-strip-btn{background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:7px;width:26px;height:26px;flex:0 0 auto;padding:0;cursor:pointer;color:var(--ez-fg-2);font-size:14px;line-height:1;}
.ezpv-strip-list{flex:1 1 auto;display:flex;gap:6px;overflow-x:auto;padding:2px 0;}
.ezpv-strip-item{position:relative;width:56px;height:56px;flex:0 0 auto;border-radius:6px;overflow:hidden;cursor:pointer;border:2px solid transparent;background:var(--ez-surface-3);display:flex;align-items:center;justify-content:center;}
.ezpv-strip-item.on{border-color:var(--ez-strong);}
.ezpv-strip-item img{width:100%;height:100%;object-fit:contain;display:block;}   /* 整图缩放（不裁切） */
.ezpv-strip-count{font-size:11px;color:var(--ez-fg-3);white-space:nowrap;flex:0 0 auto;}
.ezpv-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:3;width:40px;height:40px;border:none;border-radius:50%;background:var(--ez-surface);box-shadow:0 2px 12px rgba(0,0,0,.18);color:var(--ez-fg-2);font-size:22px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .15s;}
.ezpv-media.has-strip:hover .ezpv-nav{opacity:1;pointer-events:auto;}   /* 悬停显形的左右箭头：全屏同样可用（底部缩略图条也在） */
.ezpv-nav.l{left:2px;}
.ezpv-nav.r{right:2px;}
`;

let _styleInjected = false;
function injectStyle() {
  ezThemeInit(); if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
const fetchApi = (p, o) => (api && typeof api.fetchApi === 'function') ? api.fetchApi(p, o) : fetch(p, o);
// 为弹窗加「全屏」按钮：紧挨在 ✕ 左边。文字型弹窗插进标题栏，媒体弹窗（✕ 是绝对定位）贴其左侧。
function attachFullscreen(host, closeFn, onExit, closeBtn) {
  let fs = false;
  const doExit = () => { if (onExit) { try { onExit(); } catch (_) {} } };
  const btn = document.createElement('button');
  btn.textContent = '⛶'; btn.title = ezT('Fullscreen');
  const abs = !!(closeBtn && closeBtn.parentNode && closeBtn.style && closeBtn.style.position === 'absolute');
  if (closeBtn && closeBtn.parentNode && !abs) {
    // margin-left:auto 把「全屏 + ✕」这一对顶到标题栏右侧，标题留在左边
    btn.style.cssText = 'margin-left:auto;margin-right:6px;height:24px;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:9px;color:var(--ez-fg-3);cursor:pointer;font-size:12px;';
    closeBtn.parentNode.insertBefore(btn, closeBtn);
  } else {
    btn.style.cssText = 'position:absolute;top:8px;right:' + (abs ? '44px' : '6px') + ';z-index:8;width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:8px;color:var(--ez-fg-3);cursor:pointer;font-size:12px;';
    host.appendChild(btn);
  }
  // 退出全屏时把缩放/拖动复位：进全屏放大过再退出来，图片不该还停留在放大+偏移的状态。
  const resetView = () => { try { if (host._resetZoom) host._resetZoom(); } catch (_) {} };
  btn.addEventListener('click', (e) => { e.stopPropagation(); fs = !fs; host.classList.toggle('ezpv-fs', fs); if (!fs) { resetView(); doExit(); } });
  const dispose = () => { try { window.removeEventListener('keydown', key); } catch (_) {} };
  const key = (e) => {
    if (!host.isConnected) { dispose(); return; }   // 弹窗被其它路径关掉（点空白/删节点）：下次按键顺手解绑
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (fs) { fs = false; host.classList.remove('ezpv-fs'); resetView(); doExit(); }
      else { doExit(); dispose(); closeFn(); }
    }
  };
  window.addEventListener('keydown', key);
  if (closeBtn) closeBtn.addEventListener('click', dispose);
}

// 点空白关闭：只有在“按下时也在弹窗外”并且是干净的点击（按下在窗内不关，即使拖到窗外）才真正关。
function bindOutsideClose(popup, closeFn) {
  const onDown = (e) => { popup._downInside = !!popup.contains(e.target); };
  const onClick = (e) => { if (!popup._downInside && !popup.contains(e.target)) closeFn(); };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('click', onClick, true);
  popup._bindOutsideClose = true;
}

// ===== 状态 / 配置 =====
function stateFor(node) {
  if (!node._ezPrev) node._ezPrev = { save: false, savePath: '', saveFormats: {}, batchMode: 'auto', batchMax: 64, previewMode: 'normal', entries: [] };
  return node._ezPrev;
}
// ★★ 卡片画面来源，优先级：小图优先（卡片只有 64~120 px，没必要解码大图）
//   ① `thumb`（192px JPEG，存进 node.properties，能跨重启）
//   ② `thumb_src`（后端落盘的 320px PNG；本次会话内有效，重启后 temp 被清空会 404）
//   ③ `preview`（后端内联的卡片图 base64，兜底）
//   ④ `image_src`（原图 URL，最后兜底）
function entryThumbSrc(e) {
  if (!e) return null;
  if (e.thumb) return e.thumb;
  if (e.thumb_src) return e.thumb_src;
  if (e.preview) return 'data:image/png;base64,' + e.preview;
  if (e.image_src) return e.image_src;
  return null;
}
// 由预览的 base64 图生成 ~192px 的 JPEG data URL，存进 node.properties 一起走工作流。
// ComfyUI 启动时会 rmtree(temp)（app/assets/lifecycle.cleanup_temp_filesystem）⇒ 只有落进 properties
// 的小图能撑过重启；原来的 thumb_src 指向 temp，重启必丢。
function pvMakeThumb(entry, node) {
  try {
    if (!entry || entry.thumb || !entry.preview) return;
    let src = String(entry.preview);
    if (!/^data:/.test(src)) src = (src.indexOf('/9j/') === 0 ? 'data:image/jpeg;base64,' : 'data:image/png;base64,') + src;
    const img = new Image();
    img.onload = () => {
      try {
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        const sc = Math.min(1, 192 / Math.max(1, iw, ih));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(iw * sc)); cv.height = Math.max(1, Math.round(ih * sc));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        entry.thumb = cv.toDataURL('image/jpeg', 0.8);
        pvPersist(node);
      } catch (_) {}
    };
    img.onerror = () => {};
    img.src = src;
  } catch (_) {}
}
// ===== entries 持久化（撑过「切换工作流标签 / 重开图」）=====
// 切换工作流 = ComfyUI 重新 loadGraphData ⇒ 节点对象被**重建**，挂在节点上的 `_ezPrev.entries` 直接丢失
// （内置照片预览靠 nodeOutputStore 存活，我们的自定义 ui.entries 不在那个 store 里）。
// 所以每次 onExecuted 后把 entries 抄一份到 `node.properties.ezPrevEntries`（会随工作流 JSON 一起存），
// 下次 onConfigure / 节点重建时从那里还原。★ 只存轻量字段：丢掉 `preview`（1600px base64，会让工作流膨胀到 MB 级），
// 改用后端落盘的 `thumb_src` 小图 URL 还原画面。
const PV_PERSIST_KEYS = ['input', 'caption', 'type', 'value', 'full_value', 'thumb', 'thumb_src', 'image_src', 'images', 'batch_kind',
  'batch_total', 'audio', 'audio_src', 'video', 'video_src', 'model3d', 'frames', 'meta', 'gen_meta', 'saved_path'];
function pvStripEntries(entries) {
  const arr = (entries || []).slice(-64);
  return arr.map((e, i) => {
    const o = {};
    if (!e) return o;
    PV_PERSIST_KEYS.forEach((k) => { if (e[k] !== undefined) o[k] = e[k]; });
    // ★ audio / video 是**整段**媒体编成的 data URI（每条几十 KB~几 MB）：全量写进 node.properties
    //   会让工作流 JSON 涨到几十 MB（2026-11 复检 H-14）。只给最后 4 条保留内联源
    //   （重开图还能听/看最近的结果），更早的留 thumb + *_src URL 即可。
    if (i < arr.length - 4) { delete o.audio; delete o.video; }
    return o;
  });
}
function pvPersist(node) {
  try {
    const st = stateFor(node);
    if (!node.properties) node.properties = {};
    node.properties.ezPrevEntries = pvStripEntries(st.entries);
  } catch (_) {}
}
function pvRestore(node) {
  try {
    const saved = node && node.properties && node.properties.ezPrevEntries;
    if (!Array.isArray(saved) || !saved.length) return;
    const st = stateFor(node);
    const cur = Array.isArray(st.entries) ? st.entries : [];
    // 本次会话已有更新鲜的 entries（刚执行完 / 循环累加中）就别用旧的覆盖
    if (cur.length && cur.some((e) => e && e.preview)) return;
    st.entries = saved.slice();
  } catch (_) {}
}
// ===== 「排队后切到别的工作流，跑完再切回来」的结果回填 =====
// 新版前端只把 executed 发给**当前显示图**上的节点（getNodeByExecutionId(this.rootGraph, …)），
// 而切工作流会 clean() 掉整张图（节点重建、app.nodeOutputs 清空）。⇒ 在别的 tab 跑完的结果
// 原来只能丢。这里自己收 executed，按「工作流 id + 节点 id」存一份（工作流 id = LGraph.id，
// 前端从工作流 JSON 的 id 恢复，切 tab 前后不变），节点重建/切回来时再从这份缓存回填。
function pvWorkflowId(graph) {
  // 子图里的节点用 rootGraph.id（= 工作流 id）；root 图返回自己
  try { const g = graph && (graph.rootGraph || graph); return String((g && g.id) || ''); } catch (_) { return ''; }
}
const _pvRuns = new Map();   // prompt_id → 排队时的工作流 id
const _pvBuf = new Map();    // 工作流 id|节点 id → entries[]（最近一次排队的结果）

// 用户按住卡片时不要重建列表：renderEntries 会 innerHTML='' 整块重建，如果重建正好发生在
// mousedown 与 mouseup 之间，两个事件落在不同节点上，click 根本不会触发 —— 表现就是
// 「偶尔点一下卡片没反应、点两下才开」。按住期间把重画挂起，松手后再补一次。
let _pvPress = 0, _pvPressWatch = 0;
const _pvPendNodes = new Set();

// 「偶尔点一下卡片没反应」：切换工作流 / 刚生成完时 ComfyUI 会重建节点的 DOM 宿主（我们也会重画卡片），
// 如果重建正好落在 pointerdown 与 pointerup 之间，两个事件落在不同元素上，浏览器根本不会派发 click。
// 这里补一条兜底：按下时记住卡片和它的打开函数，抬起时若还是同一点、也没怎么移动，就主动打开；
// 原生 click 正常触发时由 pvOpenOnce 去重（400ms 内只开一次）。
let _pvTap = null, _pvOpenAt = 0;
function pvOpenOnce(fn) {
  const now = performance.now();
  if (now - _pvOpenAt < 400) return;
  _pvOpenAt = now;
  try { fn(); } catch (_) {}
}
function pvTapInstall() {
  if (pvTapInstall._done) return;
  pvTapInstall._done = true;
  document.addEventListener('pointerdown', (e) => {
    _pvTap = null;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.ezpv-handle') || t.closest('.ezpv-badge') || t.closest('.ez-ap') || t.closest('button')) return;
    const card = t.closest('.ezpv-card');
    const box = card && card.querySelector('.ezpv-prev');
    if (box && typeof box._pvOpen === 'function') _pvTap = { x: e.clientX, y: e.clientY, t: performance.now(), open: box._pvOpen };
  }, true);
  document.addEventListener('pointerup', (e) => {
    const tap = _pvTap; _pvTap = null;
    if (!tap) return;
    if (performance.now() - tap.t > 800) return;
    if (Math.abs(e.clientX - tap.x) > 6 || Math.abs(e.clientY - tap.y) > 6) return;   // 拖动/选择文字不算点击
    setTimeout(() => { try { tap.open(); } catch (_) {} }, 0);   // 先让原生 click 跑，它没开才补
  }, true);
  document.addEventListener('pointercancel', () => { _pvTap = null; }, true);
}
try { pvTapInstall(); } catch (_) {}
function pvPressBegin() {
  _pvPress += 1;
  // 兜底：极端情况下收不到 pointerup（失焦/切窗口）也不能让面板永远不重画
  try { clearTimeout(_pvPressWatch); _pvPressWatch = setTimeout(pvPressEnd, 3000); } catch (_) {}
}
function pvPressEnd() {
  try { clearTimeout(_pvPressWatch); _pvPressWatch = 0; } catch (_) {}
  if (!_pvPress) return;
  _pvPress = 0;
  const pend = Array.from(_pvPendNodes); _pvPendNodes.clear();
  pend.forEach((n) => { try { renderEntries(n); } catch (_) {} });
}
try {
  window.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('.ezpv-root')) pvPressBegin();
  }, true);
  window.addEventListener('pointerup', pvPressEnd, true);
  window.addEventListener('pointercancel', pvPressEnd, true);
} catch (_) {}
function pvBufKey(wid, nid) { return wid + '|' + String(nid); }
function pvBufClear(wid) {
  if (!wid) return;
  Array.from(_pvBuf.keys()).forEach((k) => { if (k.indexOf(wid + '|') === 0) _pvBuf.delete(k); });
}
function pvBufAdd(wid, nid, entries) {
  if (!wid || !entries || !entries.length) return;
  const k = pvBufKey(wid, nid);
  _pvBuf.set(k, (_pvBuf.get(k) || []).concat(entries).slice(-64));
  while (_pvBuf.size > 64) _pvBuf.delete(_pvBuf.keys().next().value);
}
function pvBufGet(node) {
  try { return _pvBuf.get(pvBufKey(pvWorkflowId(node && node.graph) || pvWorkflowId(app && app.graph), node && node.id)) || null; } catch (_) { return null; }
}
function pvEntrySig(e) {
  if (!e) return '';
  const p = String(e.preview || '');
  return [e.input, e.caption, e.type, e.thumb_src, e.image_src, e.saved_path, e.value != null ? String(e.value) : '',
    e.batch_kind, e.batch_total, p.length, p.slice(0, 24)].join('|');
}
function pvEntriesSig(es) { return (es || []).map(pvEntrySig).join(','); }
function pvSyncBuffered(node) {
  const live = pvBufGet(node);
  if (!live || !live.length) return false;
  const st = stateFor(node);
  const cur = Array.isArray(st.entries) ? st.entries : [];
  if (pvEntriesSig(cur) === pvEntriesSig(live)) return false;
  st.entries = live.slice();
  live.forEach((e) => pvMakeThumb(e, node));
  pvPersist(node);
  return true;
}
function loadFromConfig(node) {
  const st = stateFor(node);
  const cfg = readConfig(node, {});
  st.save = !!cfg.save;
  st.savePath = typeof cfg.savePath === 'string' ? cfg.savePath : '';
  st.saveFormats = (cfg.saveFormats && typeof cfg.saveFormats === 'object') ? cfg.saveFormats : {};
  st.batchMode = ['auto', 'images', 'video', 'animation'].indexOf(cfg.batchMode) >= 0 ? cfg.batchMode : 'auto';
  st.batchMax = Number.isFinite(parseInt(cfg.batchMax, 10)) ? Math.max(0, parseInt(cfg.batchMax, 10)) : 64;
  st.previewMode = cfg.previewMode === 'list' ? 'list' : 'normal';   // 默认「普通」：只有显式存过 list 才用列表模式
  st.dirty = false;
  pvRestore(node);   // ★ 切工作流 / 重开图后从 node.properties 还原上次的预览卡片
}
function syncToConfig(node) {
  const st = stateFor(node);
  writeConfig(node, { save: st.save, savePath: st.savePath, saveFormats: st.saveFormats, batchMode: st.batchMode || 'auto', batchMax: st.batchMax == null ? 64 : st.batchMax, previewMode: st.previewMode || 'normal' });
}

// ===== socket：动态「连一个加一个」= 已连接输入前置 + 末尾 1 个空槽；输出与卡片 1:1。
// 关键：加载/重启后不能先于链路恢复就重排/删槽（否则 ComfyUI 按保存的 origin_slot/target_slot 接不回去），
// 先把端口同步延迟到 graph.links 就绪之后再重排并回写 slot。=====
function syncOutputTypes(count) {
  try {
    const fetcher = (api && typeof api.fetchApi === 'function') ? (p, o) => api.fetchApi(p, o) : (p, o) => fetch(p, o);
    fetcher('/preview_any/outputs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: count || 0 }) }).catch(() => {});
  } catch (_) {}
}
function deferSync(node) {
  if (node._ezPrevSyncTimer) clearTimeout(node._ezPrevSyncTimer);
  node._ezPrevSyncTimer = setTimeout(() => {
    node._ezPrevSyncTimer = null;
    try { syncSockets(node); refreshUI(node); } catch (_) {}
  }, 120);
}
function syncSockets(node) {
  if (!node || !node.inputs) return;
  const MAX = MAX_CARDS;

  // 始终移除 config 输入口（同 hideConfigWidget），避免被当动态 input_* 重排/改名。
  try {
    for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
      const _in = node.inputs[i];
      if (_in && _in.name === 'config') { try { ezDropInput(node, i); } catch (_) { try { _in.hidden = true; } catch (_) {} } }
    }
  } catch (_) {}

  const origInputs = (node.inputs || []).slice();
  const origOutputs = (node.outputs || []).slice();
  const linked = origInputs.filter((i) => i.link != null);
  const conn = linked.length;

  // 链路未恢复守卫：有带 link 的输入其 link 对象还没进 graph.links，此时不重排/改名/删槽，
  // 让 ComfyUI 按保存的 origin_slot/target_slot 把线接回原 socket；稍后延后再统一重排。
  const pending = (node.inputs || []).some((i) => i.link != null && !(node.graph && node.graph.links && node.graph.links[i.link]));
  if (pending) { deferSync(node); return; }

  // 重排前按 socket 拍连线快照：新版前端 socket.links/link 是按**当前下标**现拼的视图，
  // 搬完再读就指到别的口上了（旧版 LiteGraph 是挂在 socket 上的真数组，两种都靠快照才对）。
  const cap = ezCaptureSocketLinks(node);

  // ---- 输入：已连接前置 + 末尾留 1 个空槽（连一个加一个） ----
  const desiredIn = Math.min(MAX, Math.max(1, conn + 1));
  const linkedInputs = linked;
  const emptyInputs = origInputs.filter((i) => i.link == null);
  const newInputs = [...linkedInputs, ...emptyInputs].slice(0, desiredIn);
  if (node.inputs.length !== newInputs.length || node.inputs.some((i, idx) => i !== newInputs[idx])) {
    node.inputs.splice(0, node.inputs.length, ...newInputs);
    if (node.graph) node.graph.setDirtyCanvas(true, true);
  }
  while (node.inputs.length < desiredIn) { node.addInput(`input_${node.inputs.length + 1}`, '*'); if (node.graph) node.graph.setDirtyCanvas(true, true); }
  node.inputs.forEach((i, idx) => { try { i.name = `input_${idx + 1}`; hideNativeSlotText(i); i.hidden = false; } catch (_) {} });

  // ---- 输出：与已连接卡片 1:1，且跟着对应卡片走（处理中间断开后卡片的输出仍跟卡） ----
  // 由“链接卡片的原输入下标”回溯它配对的输出 socket，按卡片顺序重组；未配对的旧输出用 removeOutput 连 line 一起清掉。
  const cardOutputs = linkedInputs.map((inp) => origOutputs[origInputs.indexOf(inp)]).filter(Boolean);
  const newOuts = cardOutputs.slice(0, conn);
  const wantOut = new Set(newOuts);
  ezPruneDanglingLinks(node);   // 先拆坏线（target_slot 越界），否则 removeOutput 会踩空槽崩掉
  for (let i = node.outputs.length - 1; i >= 0; i--) {
    if (!wantOut.has(node.outputs[i])) { node.removeOutput(i); if (node.graph) node.graph.setDirtyCanvas(true, true); }
  }
  if (node.outputs.length !== newOuts.length || node.outputs.some((o, idx) => o !== newOuts[idx])) {
    node.outputs.splice(0, node.outputs.length, ...newOuts);
    if (node.graph) node.graph.setDirtyCanvas(true, true);
  }
  while (node.outputs.length < conn) { node.addOutput(`output_${node.outputs.length + 1}`, '*'); if (node.graph) node.graph.setDirtyCanvas(true, true); }
  node.outputs.forEach((o, idx) => { try { o.name = `output_${idx + 1}`; hideNativeSlotText(o); o.hidden = false; } catch (_) {} });

  // ---- 回写 slot（链路已就绪，链接对象在）：按快照改 link 的下标，不去读搬完后的 socket.links ----
  ezApplySocketLinks(node, cap);

  if (node.graph) node.graph.setDirtyCanvas(true, true);
  syncOutputTypes(conn);
  try { node._ezEdgeUpdate && node._ezEdgeUpdate(); } catch (_) {}
}
function connectedCount(node) { return (node.inputs || []).filter((i) => i.link != null).length; }

function reorderCard(node, from, to) {
  const conn = connectedCount(node);
  if (from < 0 || from >= conn || to < 0 || to >= conn) return;
  const [inp] = node.inputs.splice(from, 1);
  node.inputs.splice(to, 0, inp);
  const [out] = node.outputs.splice(from, 1);
  node.outputs.splice(to, 0, out);
  syncSockets(node);
  node.graph && node.graph.setDirtyCanvas(true, true);
}

// ===== 预览侧栏 / 文本弹框 =====
let _modal = null, _media = null;
function modalEl() {
  if (_modal && _modal.parentNode) return _modal;
  _modal = document.createElement('div');
  _modal.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:99999;background:rgba(0,0,0,.35);';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--ez-bg);border-radius:12px;padding:12px 14px;width:92%;max-width:640px;max-height:84vh;display:flex;flex-direction:column;gap:10px;border:1px solid var(--ez-border-2);box-shadow:0 12px 40px rgba(0,0,0,.14);font-family:Inter,sans-serif;box-sizing:border-box;';
  const hd = document.createElement('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--ez-border-2);padding-bottom:8px;';
  const title = document.createElement('b'); title.textContent = ezT('Preview');
  const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = 'background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:9px;padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit;';
  hd.appendChild(title); hd.appendChild(close);
  const ta = document.createElement('textarea'); ta.readOnly = true; ta.spellcheck = false;
  ta.style.cssText = 'width:100%;min-height:180px;max-height:60vh;padding:8px;border:1px solid var(--ez-border);border-radius:9px;font:11px/1.5 monospace;color:var(--ez-fg);background:var(--ez-surface);resize:none;overflow:auto;box-sizing:border-box;outline:none;';
  box.appendChild(hd); box.appendChild(ta);
  _modal.appendChild(box); document.body.appendChild(_modal);
  _modal._ta = ta; _modal._title = title;
  close.addEventListener('click', () => { _modal.style.display = 'none'; });
  attachFullscreen(box, () => { _modal.style.display = 'none'; }, close);
  bindOutsideClose(box, () => { _modal.style.display = 'none'; });
  return _modal;
}
function openTextModal(title, text) { const m = modalEl(); m._title.textContent = title; m._ta.value = text; m.style.display = 'flex'; }

let _kv = null;
function kvModalEl() {
  if (_kv && _kv.parentNode) return _kv;
  _kv = document.createElement('div');
  _kv.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:99999;background:rgba(0,0,0,.35);';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--ez-bg);border-radius:12px;padding:12px 14px;width:92%;max-width:600px;max-height:84vh;display:flex;flex-direction:column;gap:10px;border:1px solid var(--ez-border-2);box-shadow:0 12px 40px rgba(0,0,0,.14);font-family:Inter,sans-serif;box-sizing:border-box;';
  const hd = document.createElement('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--ez-border-2);padding-bottom:8px;';
  const title = document.createElement('b'); title.textContent = ezT('Details');
  const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = 'background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:9px;padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit;';
  hd.appendChild(title); hd.appendChild(close);
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:4px;overflow:auto;max-height:60vh;border:1px solid var(--ez-border-2);border-radius:9px;padding:6px;';
  box.appendChild(hd); box.appendChild(list);
  _kv.appendChild(box); document.body.appendChild(_kv);
  _kv._title = title; _kv._list = list;
  close.addEventListener('click', () => { _kv.style.display = 'none'; });
  attachFullscreen(box, () => { _kv.style.display = 'none'; }, close);
  bindOutsideClose(box, () => { _kv.style.display = 'none'; });
  return _kv;
}
const _META_HINTS = {
  'Upscale model': 'Upscale / super-resolution model applied after generation (not the base model)',
  'modelspec.architecture': 'Architecture: determines loader/plugin compatibility (e.g. stable_diffusion_xl / diffusion_transformer)',
  'modelspec.author': 'Author / source',
  'modelspec.title': 'Model display name',
  'modelspec.description': 'Description / style notes',
  'modelspec.tags': 'Tags',
  'modelspec.organization': 'Organization / affiliation',
  'modelspec.usage': 'Usage notes',
  'modelspec.thumbnail': 'Thumbnail',
  'ss_base_model_version': 'Base model: which base model the LoRA is bound to (a mismatch breaks the style)',
  'ss_network_dim': 'Training dim: model capacity, larger is stronger',
  'ss_network_dims': 'Training dims (multiple networks)',
  'ss_network_alpha': 'Training scaling alpha: regularization strength',
  'ss_network_module': 'Network structure module',
  'ss_tag_frequency': 'Training keywords / trigger words and their counts (weight)',
  'ss_optimizer': 'Optimizer',
  'ss_optimizer_args': 'Optimizer arguments',
  'ss_learning_rate': 'Learning rate',
  'ss_lr': 'Learning rate',
  'ss_unet_lr': 'UNet learning rate',
  'ss_text_encoder_lr': 'Text encoder learning rate',
  'ss_train_batch_size': 'Training batch size',
  'ss_batch_size': 'Training batch size',
  'ss_num_batches_per_epoch': 'Batches per epoch',
  'ss_training_steps': 'Training steps',
  'ss_epoch': 'Epochs',
  'ss_resolution': 'Training resolution',
  'ss_clip_skip': 'CLIP skip layers',
  'ss_mixed_precision': 'Mixed precision',
  'ss_noise_offset': 'Noise offset (affects brightness dynamics)',
  'ss_prior_loss_weight': 'Prior loss weight',
  'ss_seed': 'Seed',
  'ss_gradient_accumulation_steps': 'Gradient accumulation steps (affects VRAM/stability)',
  'ss_warmup_steps': 'Warmup steps',
  'ss_keep_tokens': 'Keep tokens',
  'ss_shuffle_caption': 'Shuffle captions',
  'ss_weighted_captions': 'Weighted captions',
  'ss_caption_dropout_rate': 'Caption dropout rate',
  'ss_tag_dropout_rate': 'Tag dropout rate',
  'ss_enable_bucket': 'Bucket training',
  'ss_min_bucket_reso': 'Minimum bucket resolution',
  'ss_max_bucket_reso': 'Maximum bucket resolution',
  'ss_bucket_info': 'Bucket resolution distribution: the most common bucket = best output resolution',
  'ss_num_images': 'Training image count',
  'ss_dataset_repeats': 'Dataset repeats',
  'ss_cache_latents': 'Cache latents',
  'ss_flip_aug': 'Random flip augmentation',
  'ss_color_aug': 'Color augmentation',
  'ss_face_crop_aug_range': 'Face crop augmentation range',
  'ss_output_name': 'Output name',
  'ss_sd_model_hash': 'Base model hash',
  'ss_sd_model_name': 'Base model name',
  'ss_vae_hash': 'Built-in VAE hash (empty = external VAE required)',
  'ss_text_encoder_hash': 'Text encoder hash',
  'ss_training_comment': 'Training comment',
  'ss_model_description': 'Model description',
  'ss_caption': 'Prompt',
  'ss_creator': 'Creator',
  'ss_network_module': 'Network module',
  'ss_full_bf16': 'Full bf16',
  'ss_lowram': 'Low VRAM mode',
  'ss_latents_upscaler': 'Latent upscaler',
  'ss_module': 'Module',
  'ss_sd_model_arch': 'Base model architecture',
  'ss_resolution': 'Training resolution'
};
function hintKey(k) { return ezT(_META_HINTS[String(k)] || ''); }

function openKeyValueModal(title, obj) {
  const m = kvModalEl();
  m._title.textContent = title;
  m._list.innerHTML = '';
  let data = obj;
  if (typeof obj === 'string') { try { data = JSON.parse(obj); } catch (_) { data = null; } }
  const renderNode = (value, key, depth) => {
    let node = value;
    // “长得像 JSON 的字符串”也解析成可展开对象，避免到第二层就停
    if (typeof value === 'string') {
      const s = value.trim();
      if (s.startsWith('{') || s.startsWith('[')) {
        try { const p = JSON.parse(s); if (p && typeof p === 'object') node = p; } catch (_) {}
      }
    }
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;font:11px/1.5 monospace;border-bottom:1px solid var(--ez-border-2);padding:3px 6px;padding-left:' + (4 + depth * 16) + 'px;cursor:default;';
    if (node && typeof node === 'object') {
      const toggle = document.createElement('span'); toggle.textContent = '▸'; toggle.style.cssText = 'cursor:pointer;width:14px;text-align:center;color:var(--ez-fg-3);flex:0 0 auto;';
      const kk = document.createElement('span');
      const kkTxt = document.createElement('span'); kkTxt.textContent = (key === null ? '' : String(key));   // 值单独一个文本节点，ezRelabel 才能整串匹配
      const kkSuf = document.createElement('span'); kkSuf.textContent = Array.isArray(node) ? ' [' + node.length + ']' : ' {' + Object.keys(node).length + '}';
      kk.appendChild(kkTxt); kk.appendChild(kkSuf);
      kk.title = hintKey(key) || String(key);
      kk.style.cssText = 'flex:0 0 45%;color:var(--ez-fg-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all;';
      row.appendChild(toggle); row.appendChild(kk);
      const children = document.createElement('div'); children.style.display = 'none';
      const toggleFn = (e) => { e.stopPropagation(); const open = toggle.textContent === '▸'; toggle.textContent = open ? '▾' : '▸'; children.style.display = open ? 'block' : 'none'; if (open && !children.childElementCount) { const list = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node); list.forEach(([k, v]) => children.appendChild(renderNode(v, k, depth + 1))); } };
      toggle.addEventListener('click', toggleFn);
      row.addEventListener('click', toggleFn);
      wrap.appendChild(row); wrap.appendChild(children);
    } else {
      const kk = document.createElement('span'); kk.textContent = String(key); kk.title = hintKey(key) || String(key);
      kk.style.cssText = 'flex:0 0 45%;color:var(--ez-fg-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all;';
      const vv = document.createElement('span'); vv.textContent = (value === null ? 'null' : (value === undefined ? '' : String(value)));
      vv.style.cssText = 'flex:1 1 auto;color:var(--ez-fg);word-break:break-all;white-space:pre-wrap;';
      row.appendChild(kk); row.appendChild(vv);
      wrap.appendChild(row);
    }
    return wrap;
  };
  if (data && typeof data === 'object') {
    const list = Array.isArray(data) ? data.map((v, i) => [i, v]) : Object.entries(data);
    if (!list.length) m._list.appendChild(renderNode({}, '', 0));
    list.forEach(([k, v]) => m._list.appendChild(renderNode(v, k, 0)));
  } else if (data != null) {
    m._list.appendChild(renderNode(data, 'value', 0));
  }
  try { ezRelabel(m); } catch (_) {}   // 元数据键是英文源串，按当前语言就地译
  m.style.display = 'flex';
}
function mediaEl() {
  if (_media && _media.parentNode) return _media;
  _media = el('div', 'ezpv-media');
  const body = el('div', 'ezpv-media-body');
  const img = el('img'); img.style.display = 'none'; img.draggable = false;
  const video = document.createElement('video'); video.controls = true; video.style.display = 'none'; video.style.width = '100%'; video.style.maxWidth = '720px';
  const audio = document.createElement('audio'); audio.controls = true; audio.style.display = 'none'; audio.style.width = '100%';
  const meta = document.createElement('pre'); meta.className = 'ezpv-media-meta'; meta.style.display = 'none';
  const cap = el('div', 'cap');
  const strip = el('div', 'ezpv-strip');
  const stripList = el('div', 'ezpv-strip-list');
  const stripCount = el('span', 'ezpv-strip-count');
  const stripPrev = el('button', 'ezpv-strip-btn'); stripPrev.textContent = '‹'; stripPrev.title = ezT('Previous');
  const stripNext = el('button', 'ezpv-strip-btn'); stripNext.textContent = '›'; stripNext.title = ezT('Next');
  stripPrev.addEventListener('click', (e) => { e.stopPropagation(); _media._imgPrev(); });
  stripNext.addEventListener('click', (e) => { e.stopPropagation(); _media._imgNext(); });
  strip.appendChild(stripPrev); strip.appendChild(stripList); strip.appendChild(stripNext); strip.appendChild(stripCount);
  body.appendChild(video); body.appendChild(img); body.appendChild(audio); body.appendChild(meta); body.appendChild(cap); body.appendChild(strip);
  const closeBtn = document.createElement('button'); closeBtn.textContent = '✕'; closeBtn.title = ezT('Close');
  closeBtn.style.cssText = 'position:absolute;top:8px;right:8px;background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:8px;padding:2px 9px;font-size:12px;cursor:pointer;font-family:inherit;z-index:2;';
  const navL = el('button', 'ezpv-nav l'); navL.textContent = '‹'; navL.title = ezT('Previous');
  const navR = el('button', 'ezpv-nav r'); navR.textContent = '›'; navR.title = ezT('Next');
  navL.addEventListener('click', (e) => { e.stopPropagation(); _media._imgPrev(); });
  navR.addEventListener('click', (e) => { e.stopPropagation(); _media._imgNext(); });
  _media.appendChild(closeBtn);
  _media.appendChild(body); _media.appendChild(navL); _media.appendChild(navR);
  _media._img = img; _media._audio = audio; _media._meta = meta; _media._cap = cap; _media._video = video;
  document.body.appendChild(_media);
  const pauseMedia = () => { try { _media._video.pause(); } catch (_) {} try { _media._audio.pause(); } catch (_) {} };
  let zm = 1, pan = { x: 0, y: 0 }, panDrag = { on: false, sx: 0, sy: 0, pid: null };
  const applyZoom = () => { try { _media._img.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zm})`; } catch (_) {} };
  const isFs = () => _media.classList.contains('ezpv-fs');
  _media.addEventListener('wheel', (e) => {
    if (!isFs() || !_media._img || _media._img.style.display === 'none') return;
    e.preventDefault();
    zm = Math.max(1, Math.min(12, zm * (e.deltaY < 0 ? 1.15 : 0.87)));
    if (zm <= 1) { pan.x = 0; pan.y = 0; }
    applyZoom();
  }, { passive: false });
  _media.addEventListener('pointerdown', (e) => {
    if (!isFs() || zm <= 1 || e.target !== _media._img) return;
    e.preventDefault();
    panDrag.on = true; panDrag.sx = e.clientX - pan.x; panDrag.sy = e.clientY - pan.y;
    if (panDrag.pid) { try { _media.releasePointerCapture(panDrag.pid); } catch (_) {} }
    panDrag.pid = e.pointerId;
    try { _media.setPointerCapture(e.pointerId); } catch (_) {}
  });
  _media.addEventListener('pointermove', (e) => { if (panDrag.on) { e.preventDefault(); pan.x = e.clientX - panDrag.sx; pan.y = e.clientY - panDrag.sy; applyZoom(); } });
  _media.addEventListener('pointerup', () => { panDrag.on = false; });
  _media.addEventListener('pointercancel', () => { panDrag.on = false; });
  const resetZoom = () => { zm = 1; pan.x = 0; pan.y = 0; applyZoom(); };
  _media._resetZoom = resetZoom;
  // 批次图片：主图 + 底部缩略图条 + 左右翻页（视频/音频/单图不显示）。
  let _imgs = null, _idx = 0, _total = 0;
  const showImage = () => {
    if (!_imgs || !_imgs.length) return;
    _idx = ((_idx % _imgs.length) + _imgs.length) % _imgs.length;
    _media._img.src = _imgs[_idx];
    stripCount.textContent = (_idx + 1) + ' / ' + _imgs.length + (_total > _imgs.length ? ' (' + _total + ')' : '');
    Array.prototype.forEach.call(stripList.children, (x, i) => x.classList.toggle('on', i === _idx));
    resetZoom();
  };
  _media._imgPrev = () => { if (_imgs && _imgs.length > 1) { _idx -= 1; showImage(); } };
  _media._imgNext = () => { if (_imgs && _imgs.length > 1) { _idx += 1; showImage(); } };
  _media._setImages = (list, index, total) => {
    _imgs = (list && list.length) ? list.slice() : null;
    _idx = index || 0;
    _total = total || 0;
    stripList.innerHTML = '';
    if (!_imgs || _imgs.length < 2) { _media.classList.remove('has-strip'); stripCount.textContent = ''; return; }
    _media.classList.add('has-strip');
    _imgs.forEach((u, i) => {
      const th = el('div', 'ezpv-strip-item');
      const im = el('img'); im.src = u; im.loading = 'lazy'; im.alt = String(i + 1); th.appendChild(im);
      th.addEventListener('click', (ev) => { ev.stopPropagation(); _idx = i; showImage(); });
      stripList.appendChild(th);
    });
    showImage();
  };
  document.addEventListener('keydown', (e) => {
    if (!_media.classList.contains('active') || !_imgs || _imgs.length < 2) return;
    if (!_mediaTok || !ezIsTopModal(_mediaTok)) return;   // 上面还有弹窗时不动
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'VIDEO' || ae.tagName === 'AUDIO')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); _media._imgPrev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); _media._imgNext(); }
  }, true);   // 捕获阶段：先于画布的左右键处理，翻批次图时底下画布不动
  const closeMedia = () => { pauseMedia(); resetZoom(); _media.classList.remove('active'); if (_mediaTok) { ezPopModal(_mediaTok); _mediaTok = null; } };
  closeBtn.addEventListener('click', closeMedia);
  attachFullscreen(_media, closeMedia, pauseMedia, closeBtn);
  bindOutsideClose(_media, () => { if (_media.classList.contains('active')) closeMedia(); });
  return _media;
}
function openMediaPreview(payload) {
  const m = mediaEl();
  m._img.style.display = 'none'; m._audio.style.display = 'none'; m._meta.style.display = 'none'; m._video.style.display = 'none';
  try { m._audio.pause(); } catch (_) {}
  try { m._video.pause(); } catch (_) {}
  const imgs = (payload.images && payload.images.length) ? payload.images : null;
  m._setImages(imgs, payload.index || 0, payload.batch_total || 0);
  if (payload.video || payload.video_src) { m._video.src = payload.video || payload.video_src; if (payload.poster) m._video.poster = payload.poster; m._video.style.display = 'block'; } // 不自动播放
  if (imgs) { m._img.style.display = 'block'; }   // 主图已由 _setImages 填好
  else if (payload.image_src) { m._img.src = payload.image_src; m._img.style.display = 'block'; }
  else if (payload.image) { m._img.src = payload.image; m._img.style.display = 'block'; }
  if (payload.audio_src) { m._audio.src = payload.audio_src; m._audio.style.display = 'block'; }
  else if (payload.audio) { m._audio.src = payload.audio; m._audio.style.display = 'block'; } // 不自动播放，交给用户点 play
  if (payload.meta) { m._meta.textContent = payload.meta; m._meta.style.display = 'block'; }
  m._cap.textContent = payload.caption || '';
  try { ezRelabel(m); } catch (_) {}   // meta 摘要同样是英文源串
  if (m._resetZoom) m._resetZoom();
  m.classList.add('active');
  _mediaTok = ezPushModal({});
}

function ext3d(url) {
  try {
    const u = new URL(url, location.href);
    const p = u.searchParams.get('path') || u.searchParams.get('filename') || u.pathname;
    const m = String(p).toLowerCase().match(/\.(gltf|glb|obj|fbx)$/);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}
let _mediaTok = null;
let _threeModal = null;
function open3DViewer(url, title) {
  if (_threeModal && _threeModal.parentNode) _threeModal.remove();
  const THREE_BASE = '/preview_any/3d/libs/';
  _threeModal = document.createElement('div');
  _threeModal.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99999;background:rgba(10,14,20,.55);backdrop-filter:blur(2px);';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--ez-bg);border-radius:18px;padding:14px;width:96%;max-width:1040px;height:88vh;display:flex;flex-direction:column;gap:12px;font-family:Inter,system-ui,sans-serif;box-sizing:border-box;box-shadow:0 30px 90px rgba(0,0,0,.4);overflow:hidden;';
  const hd = document.createElement('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;flex:0 0 auto;';
  const t = document.createElement('b'); t.style.cssText = 'font-size:14px;color:var(--ez-fg);'; t.textContent = title || ezT('3D Model');
  const close = document.createElement('button'); close.textContent = '✕'; close.title = ezT('Close'); close.style.cssText = 'background:var(--ez-surface-3);border:1px solid var(--ez-border);border-radius:10px;width:28px;height:28px;font-size:13px;cursor:pointer;color:var(--ez-fg-3);';
  hd.appendChild(t); hd.appendChild(close);

  // 主体：左画布 + 右控制面板
  const body = document.createElement('div'); body.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;gap:12px;';
  const wrapEl = document.createElement('div'); wrapEl.style.cssText = 'flex:1 1 auto;min-width:0;position:relative;border-radius:14px;overflow:hidden;background:var(--ez-surface-2);border:1px solid var(--ez-border-2);';
  const canvas = document.createElement('canvas'); canvas.tabIndex = 0; canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;outline:none;touch-action:none;cursor:grab;';
  wrapEl.appendChild(canvas);
  const fsBtn = document.createElement('button'); fsBtn.textContent = '⛶'; fsBtn.title = ezT('Fullscreen / Exit fullscreen'); fsBtn.style.cssText = 'margin-left:auto;margin-right:6px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;background:var(--ez-surface-3);border:1px solid var(--ez-border);border-radius:10px;color:var(--ez-fg-3);font-size:14px;cursor:pointer;';
  hd.insertBefore(fsBtn, close);   // 3D 查看器全屏键也挨着 ✕ 左边

  // 右侧控制面板
  const ctrl = document.createElement('div'); ctrl.style.cssText = 'flex:0 0 250px;width:250px;overflow-y:auto;background:var(--ez-surface-2);border:1px solid var(--ez-border-2);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:10px;font-size:12px;color:var(--ez-fg-2);';
  function grp(label, input) {
    const g = document.createElement('label'); g.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const s = document.createElement('span'); s.style.cssText = 'font-size:11px;font-weight:600;color:var(--ez-fg-3);'; s.textContent = label; g.appendChild(s); g.appendChild(input); return g;
  }
  const bgInput = document.createElement('input'); bgInput.type = 'color'; bgInput.value = '#f7f9fd'; bgInput.style.cssText = 'width:100%;height:26px;border:1px solid var(--ez-border);border-radius:8px;padding:2px;background:var(--ez-bg);cursor:pointer;';
  const matSel = document.createElement('select'); matSel.style.cssText = 'width:100%;font-size:12px;padding:5px 8px;border:1px solid var(--ez-border);border-radius:8px;background:var(--ez-bg);cursor:pointer;';
  [['original', ezT('Original')], ['clay', ezT('Clay')], ['glass', ezT('Glass')], ['plastic', ezT('Plastic')], ['metal', ezT('Metal')], ['wireframe', ezT('Wireframe')]].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === 'original') o.selected = true; matSel.appendChild(o); });
  const gridChk = document.createElement('input'); gridChk.type = 'checkbox'; gridChk.checked = true; gridChk.style.cssText = 'width:16px;height:16px;';
  const matColor = document.createElement('input'); matColor.type = 'color'; matColor.value = '#ffffff'; matColor.style.cssText = 'width:100%;height:26px;border:1px solid var(--ez-border);border-radius:8px;padding:2px;background:var(--ez-bg);cursor:pointer;';
  function slider(label, min, max, val, step) {
    const g = document.createElement('label'); g.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
    const s = document.createElement('span'); s.style.cssText = 'font-size:11px;font-weight:600;color:var(--ez-fg-3);'; s.textContent = label;
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const r = document.createElement('input'); r.type = 'range'; r.min = String(min); r.max = String(max); r.value = String(val); r.step = String(step || '0.01'); r.style.cssText = 'flex:1 1 auto;';
    const num = document.createElement('span'); num.style.cssText = 'font-size:10px;color:var(--ez-fg-3);width:34px;text-align:right;'; num.textContent = String(val);
    r.addEventListener('input', () => { num.textContent = Number(r.value).toFixed((step || 0.01) < 1 ? 2 : 0); });
    row.appendChild(r); row.appendChild(num);
    g.appendChild(s); g.appendChild(row);
    return { g, r, num };
  }
  // 变换工具：3 个按键（移动/旋转/缩放），点击后拖动模型即按该工具变换；无坐标球/选中框
  const gizmoBtnDefs = [['move', ezT('Move')], ['rotate', ezT('Rotate')], ['scale', ezT('Scale')]];
  const gizmoBtnsWrap = document.createElement('div'); gizmoBtnsWrap.style.cssText = 'display:flex;gap:4px;';
  const gizmoBtns = {};
  gizmoBtnDefs.forEach(([v, l]) => {
    const b = document.createElement('button'); b.textContent = l;
    b.style.cssText = 'flex:1 1 0;background:var(--ez-surface-3);border:1px solid var(--ez-border);border-radius:8px;padding:6px;font-size:12px;cursor:pointer;color:var(--ez-fg-2);';
    b.dataset.mode = v; gizmoBtns[v] = b; gizmoBtnsWrap.appendChild(b);
  });
  const camSel = document.createElement('select'); camSel.style.cssText = 'width:100%;font-size:12px;padding:5px 8px;border:1px solid var(--ez-border);border-radius:8px;background:var(--ez-bg);cursor:pointer;';
  [['perspective', ezT('Perspective')], ['orthographic', ezT('Orthographic')]].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; camSel.appendChild(o); });
  const fovRange = document.createElement('input'); fovRange.type = 'range'; fovRange.min = '10'; fovRange.max = '120'; fovRange.value = '45'; fovRange.style.cssText = 'width:100%;';
  const fovNum = document.createElement('span'); fovNum.style.cssText = 'font-size:11px;color:var(--ez-fg-3);'; fovNum.textContent = '45°';
  const lightRange = document.createElement('input'); lightRange.type = 'range'; lightRange.min = '0'; lightRange.max = '3'; lightRange.step = '0.1'; lightRange.value = '0.9'; lightRange.style.cssText = 'width:100%;';
  const lightNum = document.createElement('span'); lightNum.style.cssText = 'font-size:11px;color:var(--ez-fg-3);'; lightNum.textContent = '0.9';
  const lightColor = document.createElement('input'); lightColor.type = 'color'; lightColor.value = '#ffffff'; lightColor.style.cssText = 'width:100%;height:26px;border:1px solid var(--ez-border);border-radius:8px;padding:2px;background:var(--ez-bg);cursor:pointer;';
  const resetBtn = document.createElement('button'); resetBtn.textContent = ezT('Reset view'); resetBtn.style.cssText = 'width:100%;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:9px;padding:7px;font-size:12px;cursor:pointer;color:var(--ez-fg-2);';

  ctrl.appendChild(grp(ezT('Background'), bgInput));
  ctrl.appendChild(grp(ezT('Preset material'), matSel));
  const matResetBtn = document.createElement('button'); matResetBtn.textContent = ezT('Reset material'); matResetBtn.style.cssText = 'width:100%;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:9px;padding:7px;font-size:12px;cursor:pointer;color:var(--ez-fg-2);';
  ctrl.appendChild(matResetBtn);
  // 材质参数（可收起）：颜色/滑块只对彩色预设（陶土/玻璃/塑料/金属）生效，原始/线框忽略颜色
  const det = document.createElement('details'); det.style.cssText = 'border:1px solid var(--ez-border-2);border-radius:9px;padding:8px;background:var(--ez-bg);';
  const sum = document.createElement('summary'); sum.textContent = ezT('Material parameters'); sum.style.cssText = 'cursor:pointer;font-size:12px;font-weight:600;color:var(--ez-fg-2);';
  det.appendChild(sum);
  det.appendChild(grp(ezT('Material color'), matColor));
  const mats = {};
  mats.metal = slider(ezT('Metalness'), 0, 1, 0);
  mats.rough = slider(ezT('Roughness'), 0, 1, 0.85);
  mats.clear = slider(ezT('Clearcoat'), 0, 1, 0);
  mats.clearR = slider(ezT('Clearcoat roughness'), 0, 1, 0.1);
  mats.trans = slider(ezT('Transmission'), 0, 1, 0);
  mats.opacity = slider(ezT('Opacity'), 0, 1, 1);
  mats.ior = slider(ezT('Index of refraction (IOR)'), 1, 2.5, 1.45);
  mats.thick = slider(ezT('Thickness (subsurface/transmission)'), 0, 3, 0.2);
  mats.emiss = slider(ezT('Emissive'), 0, 2, 0);
  mats.sheen = slider(ezT('Sheen'), 0, 1, 0);
  mats.sheenR = slider(ezT('Sheen roughness'), 0, 1, 0.5);
  mats.iri = slider(ezT('Iridescence (rainbow)'), 0, 1, 0);
  mats.iriIOR = slider(ezT('Iridescence IOR'), 1, 2.5, 1.3);
  mats.spec = slider(ezT('Specular intensity'), 0, 1, 0.5);
  det.appendChild(mats.metal.g); det.appendChild(mats.rough.g); det.appendChild(mats.clear.g); det.appendChild(mats.clearR.g);
  det.appendChild(mats.trans.g); det.appendChild(mats.opacity.g); det.appendChild(mats.ior.g); det.appendChild(mats.thick.g);
  det.appendChild(mats.emiss.g); det.appendChild(mats.sheen.g); det.appendChild(mats.sheenR.g); det.appendChild(mats.iri.g);
  det.appendChild(mats.iriIOR.g); det.appendChild(mats.spec.g);
  ctrl.appendChild(det);
  ctrl.appendChild(grp(ezT('Show grid'), gridChk));
  const toolGrp = document.createElement('div'); toolGrp.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  const toolLabel = document.createElement('span'); toolLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--ez-fg-3);'; toolLabel.textContent = ezT('Transform tool (drag model)');
  toolGrp.appendChild(toolLabel); toolGrp.appendChild(gizmoBtnsWrap);
  ctrl.appendChild(toolGrp);
  ctrl.appendChild(grp(ezT('Camera'), camSel));
  const fovGrp = grp(ezT('Field of view'), fovRange); fovGrp.appendChild(fovNum); ctrl.appendChild(fovGrp);
  const lightGrp = grp(ezT('Light intensity'), lightRange); lightGrp.appendChild(lightNum); ctrl.appendChild(lightGrp);
  ctrl.appendChild(grp(ezT('Light color'), lightColor));
  ctrl.appendChild(resetBtn);
  const resetModelBtn = document.createElement('button'); resetModelBtn.textContent = ezT('Reset model'); resetModelBtn.style.cssText = 'width:100%;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:9px;padding:7px;font-size:12px;cursor:pointer;color:var(--ez-fg-2);';
  ctrl.appendChild(resetModelBtn);

  const status = document.createElement('div'); status.style.cssText = 'font-size:12px;color:var(--ez-fg-3);text-align:center;min-height:18px;line-height:1.4;word-break:break-word;';
  status.textContent = ezT('Loading 3D model…');
  const tip = document.createElement('div'); tip.style.cssText = 'font-size:11px;color:var(--ez-fg-muted);';
  tip.textContent = ezT('Left drag = orbit · Shift/Right drag = pan · Wheel = zoom');

  body.appendChild(wrapEl); body.appendChild(ctrl);
  box.appendChild(hd); box.appendChild(body); box.appendChild(status); box.appendChild(tip);
  _threeModal.appendChild(box);
  document.body.appendChild(_threeModal);

  let _raf = 0, _listeners = [];
  let _closed = false, _freeGL = null;
  const cleanup = () => {
    _closed = true;
    if (_raf) cancelAnimationFrame(_raf);
    _listeners.forEach((fn) => { try { fn(); } catch (_) {} });
    _listeners = [];
    if (_freeGL) { try { _freeGL(); } catch (_) {} _freeGL = null; }
    if (_threeModal) { _threeModal.remove(); _threeModal = null; }
  };
  close.addEventListener('click', cleanup);
  // 拖拽（环绕/平移/操作对象/gizmo）若在弹窗外松开，不应关闭；只有单点弹窗外空白才关闭
  let _suppressClose = false;
  _threeModal.addEventListener('click', (e) => {
    if (e.target !== _threeModal) return;
    if (_suppressClose) { _suppressClose = false; return; }
    cleanup();
  });
  let fsOn = false;
  const setFs = (v) => { fsOn = v; box.classList.toggle('ezpv-fs', fsOn); };

  (async () => {
    try {
      const THREE = await import(THREE_BASE + 'three.module.js');
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0xf7f9fd);
      const persp = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
      const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100000);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600, false);
      // 关闭弹窗时释放 WebGL 上下文：浏览器同时存活的上下文有限，3D 预览反复开关会掉帧/黑屏
      _freeGL = () => { try { renderer.dispose(); renderer.forceContextLoss(); } catch (_) {} };
      const ro = new ResizeObserver(() => { try { renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600, false); const a = (canvas.clientWidth || 800) / (canvas.clientHeight || 600); persp.aspect = a; persp.updateProjectionMatrix(); } catch (_) {} });
      ro.observe(canvas);
      _listeners.push(() => { try { ro.disconnect(); } catch (_) {} });
      const ambient = new THREE.AmbientLight(0xffffff, 0.9); scene.add(ambient);
      const dir = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(5, 10, 7); scene.add(dir);

      let loader;
      const ext = ext3d(url);
      if (ext === 'glb' || ext === 'gltf') {
        const gltf = await import(THREE_BASE + 'GLTFLoader.js');
        loader = new gltf.GLTFLoader();
      } else if (ext === 'fbx') {
        const fbx = await import(THREE_BASE + 'FBXLoader.js');
        loader = new fbx.FBXLoader();
      } else if (ext === 'obj') {
        const objs = await import(THREE_BASE + 'OBJLoader.js');
        loader = new objs.OBJLoader();
      } else if (ext === 'splat') {
        // 本地极简高斯泼溅加载器（32 字节/点，核心 three.js 出软圆点）；.spz/.ksplat 是压缩格式，仍走下面的报错
        const sp = await import(THREE_BASE + 'SplatLoader.js');
        loader = new sp.SplatLoader(THREE);
      } else {
        // 只随包带了 GLTF / FBX / OBJ / Splat 四个加载器：别的扩展名以前会落到 OBJLoader 里报一堆难懂的错误
        throw new Error(`${ezT('Unsupported 3D format .')}${ext || '?'}${ezT(' (only glb / gltf / obj / fbx / splat are supported)')}`);
      }
      // 让加载器把相对贴图/缓冲 URL 解析到源文件所在目录（外部贴图由此能加载）
      loader.resourcePath = url.slice(0, url.lastIndexOf('/') + 1);
      try {
        const lm = new THREE.LoadingManager();
        lm.onError = (u) => { try { console.log('[3D texture/resource load failed]', u); } catch (_) {} };
            loader.manager = lm;
      } catch (_) {}

      loader.load(url,
        (obj) => {
          if (_closed) return;          // 加载期间弹窗已关：别再往已卸载的画布上挂场景
          status.textContent = '';
          const wrap = new THREE.Group(); wrap.add(obj);
          const b3 = new THREE.Box3().setFromObject(wrap);
          const size = b3.getSize(new THREE.Vector3()); const center = b3.getCenter(new THREE.Vector3());
          const maxD = Math.max(size.x, size.y, size.z) || 1;
          // 让模型几何中心落在 wrap 局部原点，wrap 本身在世界原点 → 旋转/缩放以模型中心为轴心
          obj.position.sub(center);
          wrap.position.set(0, 0, 0); scene.add(wrap);
          wrap.userData._basePos = wrap.position.clone();
          wrap.userData._baseRot = wrap.rotation.clone();
          wrap.userData._baseScale = wrap.scale.x || 1;
          const grid = new THREE.GridHelper(maxD * 2, 10, 0x9aa7b5, 0xd6dce6);
          grid.position.y = -maxD * 0.5; scene.add(grid);
          // 不要默认的全局坐标轴三条线（会压在模型上）；坐标球由选中/切换时显示

          // 轨道相机状态
          const target = new THREE.Vector3(0, 0, 0);
          let radius = maxD * 2.6;
          let theta = Math.PI * 0.32, phi = Math.PI * 0.36;
          const defaultView = () => { radius = maxD * 2.6; theta = Math.PI * 0.32; phi = Math.PI * 0.36; target.set(0, 0, 0); };
          const activeCam = () => (camSel.value === 'orthographic' ? ortho : persp);
          function placeCam(c) {
            const sp = new THREE.Vector3(radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.cos(theta));
            c.position.copy(target).add(sp);
            c.lookAt(target);
            if (c === ortho) {
              const r = Math.max(radius * 1.3, maxD * 0.5);
              ortho.left = -r; ortho.right = r; ortho.top = r; ortho.bottom = -r;
              ortho.near = 0.01; ortho.far = radius * 10 + maxD * 20;
            }
            c.updateProjectionMatrix();
          }

          // 材质：预设 + 自定义（Principled 风格参数：BaseColor/Metallic/Roughness/Clearcoat/Transmission/IOR/Alpha/Emissive）
          const PRESETS = {
            clay: { metal: 0.0, rough: 0.85, clear: 0, clearR: 0.1, trans: 0, opacity: 1, ior: 1.45, thick: 0.2, emiss: 0, sheen: 0, sheenR: 0.5, iri: 0, iriIOR: 1.3, spec: 0.5, color: '#ffffff' },
            glass: { metal: 0.0, rough: 0.06, clear: 0, clearR: 0.1, trans: 0.92, opacity: 0.55, ior: 1.45, thick: 0.4, emiss: 0, sheen: 0, sheenR: 0.5, iri: 0, iriIOR: 1.3, spec: 0.5, color: '#ffffff' },
            plastic: { metal: 0.0, rough: 0.22, clear: 1.0, clearR: 0.08, trans: 0, opacity: 1, ior: 1.45, thick: 0.2, emiss: 0, sheen: 0, sheenR: 0.5, iri: 0, iriIOR: 1.3, spec: 0.5, color: '#2b3a4a' },
            metal: { metal: 1.0, rough: 0.28, clear: 0, clearR: 0.1, trans: 0, opacity: 1, ior: 1.45, thick: 0.2, emiss: 0, sheen: 0, sheenR: 0.5, iri: 0, iriIOR: 1.3, spec: 0.5, color: '#b0b6c2' }
          };
          const MAT_KEYS = ['metal', 'rough', 'clear', 'clearR', 'trans', 'opacity', 'ior', 'thick', 'emiss', 'sheen', 'sheenR', 'iri', 'iriIOR', 'spec'];
          function setPreset(name) {
            const p = PRESETS[name]; if (!p) return;
            MAT_KEYS.forEach((k) => {
              const c = mats[k]; if (!c) return;
              c.r.value = p[k];
              c.num.textContent = Number(p[k]).toFixed(p[k] < 1 ? 2 : 0);
            });
            matColor.value = p.color;
          }
          function readMat() {
            const out = {};
            MAT_KEYS.forEach((k) => { out[k] = Number(mats[k].r.value); });
            return out;
          }
          function restoreOriginal() {
            wrap.traverse((n) => {
              if (!n.isMesh) return;
              const o = n.userData._origMat;
              if (o !== undefined) n.material = Array.isArray(o) ? o.slice() : o;
            });
          }
          function applyMaterial(mode) {
            wrap.traverse((n) => {
              if (!n.isMesh) return;
              if (n.userData._origMat === undefined) n.userData._origMat = Array.isArray(n.material) ? n.material.slice() : n.material;
              if (mode === 'wireframe') {
                // 用克隆线框材质，避免污染原材质（否则回“原始”也会带线框）
                const orig = n.userData._origMat;
                const wf = (ms) => { const m = ms.clone(); m.wireframe = true; return m; };
                n.material = Array.isArray(orig) ? orig.map(wf) : wf(orig);
                return;
              }
              // 原始：保留贴图/底色，把材质参数（粗糙度/金属度/清漆/透射/IOR/…）覆写到克隆的原始材质上
              const m = readMat();
              const applyParams = (mat) => {
                if (!mat) return;
                try { mat.metalness = m.metal; mat.roughness = m.rough; } catch (_) {}
                try { mat.clearcoat = m.clear; mat.clearcoatRoughness = m.clearR; } catch (_) {}
                if ('transmission' in mat) mat.transmission = m.trans;
                try { mat.transparent = (m.opacity < 1 || m.trans > 0); mat.opacity = m.opacity; } catch (_) {}
                if ('ior' in mat) mat.ior = m.ior;
                if ('thickness' in mat) mat.thickness = m.thick;
                try { mat.emissiveIntensity = m.emiss; } catch (_) {}
                if ('sheen' in mat) { mat.sheen = m.sheen; mat.sheenRoughness = m.sheenR; }
                if ('iridescence' in mat) { mat.iridescence = m.iri; mat.iridescenceIOR = m.iriIOR; }
                if ('specularIntensity' in mat) mat.specularIntensity = m.spec;
                mat.needsUpdate = true;
              };
              if (mode === 'original') {
                const orig = n.userData._origMat;
                const cl = Array.isArray(orig) ? orig.map((x) => x.clone()) : orig.clone();
                if (Array.isArray(cl)) cl.forEach(applyParams); else applyParams(cl);
                n.material = cl;
                return;
              }
              const mat = new THREE.MeshPhysicalMaterial({
                color: new THREE.Color(matColor.value || '#ffffff'),
                metalness: m.metal, roughness: m.rough,
                clearcoat: m.clear, clearcoatRoughness: m.clearR,
                transmission: m.trans, transparent: (m.opacity < 1 || m.trans > 0), opacity: m.opacity,
                ior: m.ior, thickness: m.thick,
                emissive: new THREE.Color(0x000000), emissiveIntensity: m.emiss,
                sheen: m.sheen, sheenRoughness: m.sheenR, sheenColor: new THREE.Color(0xffffff),
                iridescence: m.iri, iridescenceIOR: m.iriIOR,
                specularIntensity: m.spec, specularColor: new THREE.Color(0xffffff)
              });
              n.material = mat;
            });
          }
          // 预设材质选中即生效；彩色预设（陶土/玻璃/塑料/金属）可用「材质参数」里的颜色/滑块调，
          // 原始/线框忽略颜色（原始用模型贴图颜色）
          setPreset('clay');

          function render() { const c = activeCam(); placeCam(c); renderer.render(scene, c); }
          const fit = () => { renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600, false); const a = (canvas.clientWidth || 800) / (canvas.clientHeight || 600); persp.aspect = a; persp.updateProjectionMatrix(); render(); };



          // 简单浏览 + 拖动模型变换：左键拖空白=环绕，右键/Shift=平移，滚轮=缩放。
          // 点「变换工具」按某按钮后，左键在模型上拖动即按该工具变换（无坐标球/无选中框/无 g r s）。
          const raycaster = new THREE.Raycaster();
          const pointer = new THREE.Vector2();
          const ndc = (e) => { const r = canvas.getBoundingClientRect(); pointer.x = ((e.clientX - r.left) / (r.width || 1)) * 2 - 1; pointer.y = -((e.clientY - r.top) / (r.height || 1)) * 2 + 1; };
          const pickMesh = (e) => {
            ndc(e); const c = activeCam(); try { c.updateMatrixWorld(); } catch (_) {}
            raycaster.setFromCamera(pointer, c);
            const hits = raycaster.intersectObjects(wrap.children, true);
            return hits.length ? hits[0].object : null;
          };
          let gzTool = 'move';
          const setTool = (t) => {
            gzTool = t;
            Object.keys(gizmoBtns).forEach((k) => {
              gizmoBtns[k].style.background = (k === t) ? 'var(--ez-surface-4)' : 'var(--ez-surface-3)';
              gizmoBtns[k].style.borderColor = (k === t) ? 'var(--ez-info-border)' : 'var(--ez-border)';
              gizmoBtns[k].style.color = (k === t) ? 'var(--ez-info-fg)' : 'var(--ez-fg-2)';
            });
          };
          Object.keys(gizmoBtns).forEach((k) => gizmoBtns[k].addEventListener('click', (e) => { e.stopPropagation(); setTool(k); }));

          let dragging = false, px = 0, py = 0, panning = false, mode = '';
          const onDown = (e) => {
            if (e.button !== 0 && e.button !== 2) return;
            e.preventDefault();
            _suppressClose = true;
            try { canvas.focus(); } catch (_) {}
            dragging = true; px = e.clientX; py = e.clientY;
            panning = (e.button === 2 || e.shiftKey);
            mode = 'orbit';
            if (e.button === 0 && !panning) {
              const m = pickMesh(e);
              if (m) { mode = 'obj_' + gzTool; canvas.style.cursor = 'move'; return; }
            }
            canvas.style.cursor = 'grabbing';
          };
          const onMove = (e) => {
            if (!dragging) return;
            const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY;
            if (mode === 'obj_rotate') { wrap.rotation.y += dx * 0.006; wrap.rotation.x += dy * 0.006; render(); }
            else if (mode === 'obj_move') {
              const fwd = new THREE.Vector3(); const c = activeCam(); c.getWorldDirection(fwd);
              const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
              const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
              const s = radius * 0.0018;
              wrap.position.addScaledVector(right, dx * s).addScaledVector(up, -dy * s); render();
            } else if (mode === 'obj_scale') {
              const f = Math.exp(-dy * 0.012);
              wrap.scale.setScalar(Math.max(0.05, Math.min(20, wrap.scale.x * f))); render();
            } else if (panning) {
              const fwd = new THREE.Vector3(); const c = activeCam(); c.getWorldDirection(fwd);
              const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
              const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
              const s = radius * 0.0022;
              target.addScaledVector(right, -dx * s); target.addScaledVector(up, dy * s); render();
            } else {
              theta -= dx * 0.006; phi -= dy * 0.006;
              phi = Math.max(0.02, Math.min(Math.PI - 0.02, phi)); render();
            }
          };
          const onUp = () => { dragging = false; mode = ''; canvas.style.cursor = 'grab'; setTimeout(() => { _suppressClose = false; }, 0); };
          const onWheel = (e) => { e.preventDefault(); const f = e.deltaY > 0 ? 1.1 : 0.9; radius = Math.max(maxD * 0.05, Math.min(maxD * 40, radius * f)); render(); };
          const onCtx = (e) => { e.preventDefault(); };
          canvas.addEventListener('pointerdown', onDown);
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
          canvas.addEventListener('wheel', onWheel, { passive: false });
          canvas.addEventListener('contextmenu', onCtx);
          const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (fsOn) setFs(false); else cleanup(); } };
          window.addEventListener('keydown', onKey, true);
          _listeners.push(() => { canvas.removeEventListener('pointerdown', onDown); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('contextmenu', onCtx); window.removeEventListener('keydown', onKey, true); });

          // 控件绑定
          bgInput.addEventListener('input', () => { scene.background = new THREE.Color(bgInput.value); render(); });
          const isColorPreset = () => ['clay', 'glass', 'plastic', 'metal'].indexOf(matSel.value) >= 0;
          matSel.addEventListener('change', () => {
            const v = matSel.value;
            if (PRESETS[v]) setPreset(v);
            applyMaterial(v);       // 预设/原始/线框 选中即生效；原始也用材质参数（保留贴图），线框忽略参数
            render();
          });
          matColor.addEventListener('input', () => { if (isColorPreset()) { applyMaterial(matSel.value); render(); } });
          Object.keys(mats).forEach((k) => { mats[k].r.addEventListener('input', () => { if (matSel.value !== 'wireframe') { applyMaterial(matSel.value); render(); } }); });
          matResetBtn.addEventListener('click', () => { matSel.value = 'original'; restoreOriginal(); render(); });
          gridChk.addEventListener('change', () => { grid.visible = gridChk.checked; render(); });
          camSel.addEventListener('change', () => { fit(); });
          fovRange.addEventListener('input', () => { const v = Number(fovRange.value); fovNum.textContent = v + '°'; persp.fov = v; persp.updateProjectionMatrix(); render(); });
          lightRange.addEventListener('input', () => { const v = Number(lightRange.value); lightNum.textContent = String(v); ambient.intensity = v; dir.intensity = v * 0.9; render(); });
          lightColor.addEventListener('input', () => { const c = new THREE.Color(lightColor.value); ambient.color.set(c); dir.color.set(c); render(); });
          // 复位视角：只复位相机/视场，不复位材质、不动模型
          resetBtn.addEventListener('click', () => {
            defaultView();
            fovRange.value = '45'; fovNum.textContent = '45°'; persp.fov = 45; persp.updateProjectionMatrix();
            camSel.value = 'perspective';
            fit();
          });
          // 复位模型：只复位模型位置/旋转/缩放
          resetModelBtn.addEventListener('click', () => {
            if (wrap.userData._basePos) { wrap.position.copy(wrap.userData._basePos); wrap.rotation.copy(wrap.userData._baseRot); wrap.scale.setScalar(wrap.userData._baseScale || 1); }
            render();
          });
          fsBtn.addEventListener('click', (e) => { e.stopPropagation(); setFs(!fsOn); setTimeout(fit, 60); });

          // ★ 关闭时不能只靠 cleanup 里那一次 cancelAnimationFrame：模型可能还在加载，
          //   回调晚于关闭才启动渲染链 ⇒ 这里必须自己认 _closed，否则 rAF 会一直空转。
          const loop = () => {
            if (_closed) { _raf = 0; return; }
            _raf = requestAnimationFrame(loop);
            const c = activeCam(); placeCam(c); renderer.render(scene, c);
          };
          _raf = requestAnimationFrame(loop);
          defaultView();
          setTimeout(fit, 60);
        },
        (ev) => { const pct = (ev && ev.total) ? Math.round(ev.loaded / ev.total * 100) : ''; status.textContent = pct ? `${ezT('Loading…')} ${pct}%` : ezT('Loading…'); },
        (err) => { status.textContent = ezT('Load failed: ') + (((err && err.message) || err) || ''); }
      );
    } catch (e) {
      status.textContent = ezT('3D init failed: ') + (((e && (e.message || e)) || e));
    }
  })();
}

// 「生成信息」角标：卡片和列表弹窗主区共用
function genInfoBadge(entry) {
  const g = el('span', 'ezpv-gen'); g.textContent = ezT('Generation info');
  g.style.cssText = 'position:absolute;top:4px;right:4px;z-index:5;background:var(--ez-surface);border:1px solid var(--ez-border);border-radius:7px;padding:1px 7px;font-size:10px;cursor:pointer;color:var(--ez-info-fg);box-shadow:0 1px 3px rgba(0,0,0,.12);';
  g.addEventListener('click', (e) => { e.stopPropagation(); try { openKeyValueModal((entry.caption || '') + ezT(' Generation info'), JSON.parse(entry.gen_meta)); } catch (_) { openTextModal((entry.caption || '') + ezT(' Generation info'), entry.gen_meta); } });
  return g;
}
function renderPreview(entry) {
  if (!entry) {
    const box = el('div', 'ezpv-prev'); return box;
  }
  const val = entry.value || '';
  const full = entry.full_value || val;
  const type = (entry.type || '').toUpperCase();
  if (entry.audio || entry.audio_src) {   // 卡片上直接给播放控件（以前是一行占位字，还得再点开）
    const box = el('div', 'ezpv-prev audio');
    const ap = makeAudioPlayer(entry.audio_src || entry.audio || '');
    ap.style.cssText = 'width:100%;';
    box.appendChild(ap);
    box.title = ((entry.caption || '') + '  ' + val).trim();
    // 控件左右收窄、上下居中，两边留灰：点灰边（不是播放控件）开大预览弹窗；列表卡片整块由 list 的捕获点击先接管
    const openA = () => pvOpenOnce(() => openMediaPreview({ audio: entry.audio, audio_src: entry.audio_src, caption: ((entry.caption || '') + '  ' + val).trim() }));
    box._pvOpen = openA;
    box.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('.ez-ap')) return;
      e.stopPropagation();
      openA();
    });
    return box;
  }
  if (entry.video || entry.video_src) {
    const box = el('div', 'ezpv-prev img');
    const thumb = entryThumbSrc(entry);
    const img = el('img'); if (thumb) img.src = thumb; img.alt = val;
    box.appendChild(img);
    const play = el('span', 'ezpv-play'); play.textContent = '▶'; box.appendChild(play);
    if (entry.frames > 1) { const b = el('span', 'ezpv-badge'); b.textContent = entry.frames + ezT(' frames'); box.appendChild(b); }
    const openV = () => pvOpenOnce(() => openMediaPreview({ video: entry.video, video_src: entry.video_src, poster: thumb, caption: (entry.caption || '') + '  ' + val }));
    box._pvOpen = openV;
    box.addEventListener('click', (e) => { e.stopPropagation(); openV(); });
    return box;
  }
  if (entry.preview || entry.thumb_src || entry.image_src) {
    const box = el('div', 'ezpv-prev img');
    box.style.position = 'relative';
    const img = el('img'); img.src = entryThumbSrc(entry); img.alt = val;
    box.appendChild(img);
    const imgs = entry.images || [];
    if (imgs.length > 1) {
      const b = el('span', 'ezpv-badge'); b.textContent = imgs.length + ezT(entry.batch_kind === 'frames' ? ' frames' : ' images');
      b.style.left = '5px'; b.style.right = 'auto'; box.appendChild(b);
    }
    if (entry.gen_meta) box.appendChild(genInfoBadge(entry));
    const openI = () => pvOpenOnce(() => openMediaPreview({ images: imgs, batch_total: entry.batch_total, image: img.src, image_src: entry.image_src, caption: (entry.caption || '') + '  ' + val, meta: entry.meta, frames: entry.frames, type }));
    box._pvOpen = openI;
    box.addEventListener('click', (e) => { e.stopPropagation(); openI(); });
    return box;
  }
  if (type === 'MODEL_3D' || type === 'FILE_3D' || type === 'MESH') {   // MESH：顶点/面张量已在后端导成临时 OBJ
    if (!entry.model3d) {   // 没导出 url 才退回文字（正常都有）
      const box = el('div', 'ezpv-prev long');
      box.textContent = val;
      return box;
    }
    // 和 MediaLoader 同款：卡片 = 3D 图标 + 「打开 3D 查看器」，摘要文字挪进查看器标题
    const box = el('div', 'ezpv-prev d3');
    const open = () => pvOpenOnce(() => open3DViewer(entry.model3d, ((entry.caption || '') + '  ' + val).trim()));
    box._pvOpen = open;
    const ic = el('div', 'ezpv-d3ic'); ic.textContent = '🧊'; box.appendChild(ic);
    const btn = el('button', 'ezpv-d3btn', { type: 'button' }); btn.textContent = ezT('Open 3D viewer');
    btn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    box.appendChild(btn);
    box.title = ezT('Click to open the 3D viewer (drag to rotate, wheel to zoom)');
    box.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    return box;
  }
  if (entry.meta || type === 'MODEL' || type === 'CLIP' || type === 'VAE') {
    const box = el('div', 'ezpv-prev long');
    box.textContent = val;
    box.title = ezT('Click to view details (metadata)');
    const openMeta = () => pvOpenOnce(() => {
      const metaStr = entry.meta || full;
      if (typeof metaStr === 'string' && (metaStr.trim().startsWith('{') || metaStr.trim().startsWith('['))) {
        try { openKeyValueModal(entry.caption || ezT('Details'), JSON.parse(metaStr)); return; } catch (_) {}
      }
      openTextModal(entry.caption || ezT('Details'), typeof metaStr === 'string' ? metaStr : full);
    });
    box._pvOpen = openMeta;
    box.addEventListener('click', (e) => { e.stopPropagation(); openMeta(); });
    return box;
  }
  if (val) {
    const box = el('div', 'ezpv-prev long');
    box.textContent = val;
    const isKV = type === 'DICT' || type === 'LIST' || type === 'TUPLE';
    box.title = isKV ? ezT('Click to view key-value details') : ezT('Click to view full content');
    const openText = () => pvOpenOnce(() => { if (isKV) openKeyValueModal(entry.caption || ezT('Details'), full); else openTextModal(entry.caption || ezT('Preview'), full); });
    box._pvOpen = openText;
    box.addEventListener('click', (e) => { e.stopPropagation(); openText(); });
    return box;
  }
  const box = el('div', 'ezpv-prev'); return box;
}

// ===== DOM 宿主自愈（切换工作流 / 折叠 / 刷新 / Vue 重建后内容空掉）=====
// ComfyUI（Vue 或经典）在**切换工作流标签**、折叠、展开、载入、刷新时会卸载并重建 DOM widget 的宿主容器。
// 我们手动挂进去的 `node._ezRoot` 于是变成**脱离文档的幽灵 DOM**：对象/children 都还在，但 `isConnected === false`
// —— 之后所有 renderEntries 都画进这棵没人看的树里，用户看到面板【内容全消失】（数据没丢，只是画到了废树）。
// 所以：① 每次拿面板列表都从 `widget.element` 现取（不长期信 `_ezRoot`）；② 早退判断带 `isConnected` 校验。
function pvHost(node) {
  try { const w = (node.widgets || []).find((x) => x && x.type === 'ezpv-panel'); return (w && (w.element || w.el)) || null; } catch (_) { return null; }
}
// ★★ 两个坑都要防：
//   ① widget 宿主被重建后是**空壳**（里面没有我们的 .ezpv-list）→ 直接采纳它会丢结构，必须仍用缓存 shell。
//   ② 缓存 shell 已脱离文档（幽灵）→ 要回挂进新宿主（healDom 干这事），而不是继续用它。
//   ⇒ 只有「宿主里真的挂着我们的面板」时才把它当 shell；否则回落到缓存的 _ezRoot（由 healDom 负责搬进去）。
function pvShell(node) {
  let host = pvHost(node);
  if (host && host.querySelector && !host.querySelector('.ezpv-list')) host = null;   // 空壳，不认
  let shell = host || (node && node._ezRoot) || null;
  if (shell && shell.querySelector && !shell.querySelector('.ezpv-list') && node && node._ezRoot && node._ezRoot.querySelector && node._ezRoot.querySelector('.ezpv-list')) shell = node._ezRoot;
  if (!shell || !shell.querySelector) return null;
  node._ezRoot = shell;                    // 回写：黑框标签等也用最新的
  return shell;
}
function panelList(node) { const s = pvShell(node); return (s && s.querySelector) ? s.querySelector('.ezpv-list') : null; }

function healDom(node) {
  if (!node || !node._ezRoot) return;
  const shell = node._ezRoot;
  const list = (shell.querySelector && shell.querySelector('.ezpv-list')) || null;
  if (!list) return;
  const connected = (el) => (el && el.isConnected === undefined) ? true : !!(el && el.isConnected);
  const host = pvHost(node);

  // (A) config widget 每次都要重新藏一遍（ComfyUI 重建宿主时会把它显示回来）。
  try { hideConfigWidget(node); } catch (_) {}

  // (B) shell 尺寸也每次硬设一遍：ComfyUI 重建容器时可能把它压扁 → 面板盖不满、底下露内容。
  try {
    const si = (p, v) => { try { shell.style.setProperty(p, v, 'important'); } catch (_) {} };
    si('position', 'absolute'); si('inset', '0'); si('width', '100%'); si('height', '100%');
    si('max-width', '100%'); si('max-height', '100%'); si('box-sizing', 'border-box');
  } catch (_) {}

  // (C) 宿主对不上就重挂
  const shellOk = connected(shell) && connected(list);
  // ★ 宿主若已重建（新宿主里**没有**我们的 .ezpv-list，或干脆不含 shell）→ 必须把 shell 搬进去。
  //   只比 `host.contains(shell)` 不够：新宿主是空壳时 contains 为 false，这里正好要重挂。
  const hostHasShell = !!(host && host.contains && host.contains(shell));
  const hostOk = !host || host === shell || hostHasShell;
  if (shellOk && hostOk) {
    // 结构没问题，但可能「宿主里另有旧壳」→ 清掉重复的，避免两份面板
    try {
      if (host && host !== shell) {
        Array.prototype.slice.call(host.querySelectorAll('.ezpv-shell')).forEach((s) => { if (s !== shell) s.remove(); });
      }
    } catch (_) {}
    return;
  }
  try { if (host && host !== shell && host.appendChild) host.appendChild(shell); } catch (_) {}
  // (D) 强制重画
  try { renderEntries(node); } catch (_) {}
}

function renderEntries(node) {
  const st = stateFor(node);
  const root = pvShell(node);
  if (!root) return;
  const list = root.querySelector('.ezpv-list');
  if (!list) return;
  if (_pvPress) { _pvPendNodes.add(node); return; }   // 按住期间不重建（见 pvPressBegin 注释）
  const linked = (node.inputs || []).filter((i) => i.link != null);
  const conn = linked.length;
  list.innerHTML = '';
  if (!conn) { list.appendChild(el('div', 'ezpv-empty')).textContent = ezT('Drag a wire from an input port on the left to auto-create preview cards'); return; }
  const ents = st.entries || [];
  // 后端每个已连输入口发一条 entry（带 input = 端口名），按端口名对位；老后端没有 input 字段时才退回按下标取。
  const legacy = !ents.some((e) => e && e.input);
  for (let i = 0; i < conn; i++) {
    const inp = linked[i];
    const key = inp && inp.name;
    const own = key ? ents.filter((e) => e && e.input === key) : [];   // 该端口的全部条目（循环多轮 / 列表广播都会有多条）
    const entry = own.length ? own[0] : (legacy ? (ents[i] || null) : null);   // 卡片主图固定显示第 1 条（对齐内置 imageIndex=0）；全部条目点开列表看
    list.appendChild(renderCard(node, i, entry, inp));
  }
  attachDnD(list, '.ezpv-card', '.ezpv-handle', (from, to) => reorderCard(node, from, to));
  try { ezRelabel(root); } catch (_) {}   // 后端返回的是英文源串，按当前语言就地译一次（切语言时各面板重画后再走这里）
}
function entriesOfInput(node, input, entry) {
  const key = (entry && entry.input) || (input && input.name) || '';
  if (!key) return entry ? [entry] : [];
  return (stateFor(node).entries || []).filter((e) => e && e.input === key);
}
// 本节点没声明 INPUT_IS_LIST，ComfyUI 会对 list 输入逐项广播执行（每次一条 ui），前端再把多次 ui
// 合成一个数组 —— 同一端口的 entry 会重复 N 遍，连没接 list 的口也跟着重复。这里按「端口 + 内容签名」
// 收敛：内容一样的重复项只留一条，内容不同的才是真列表项（不用改输入类型就能判断出这是广播重复）。
// 一次性临时件（每次执行都重新随机命名，内容再一样 URL 也变）：不参与签名，否则 list 广播产生的
// 同值重复项永远收敛不掉 —— 一张图会被撑成 N 份（图/蒙版/内存音频都走这条路）。
const SIG_TMP = /ezpv_(img|mask|audio)_[0-9a-f]{32}/g;
function sigUrl(u) { return String(u || '').replace(SIG_TMP, 'ezpv_$1_*'); }
function entrySig(e) {
  if (!e) return '';
  return [e.type, e.value, e.full_value, e.preview, e.audio, sigUrl(e.audio_src), sigUrl(e.video), sigUrl(e.video_src),
    sigUrl(e.image_src), sigUrl(e.model3d), (e.images || []).length, e.frames || 0, e.batch_total || 0].join('|');
}
function collapseEntries(entries) {
  const out = []; const seen = {};
  (entries || []).forEach((e) => {
    if (!e) return;
    const key = String(e.input || '') + '#' + entrySig(e);
    if (seen[key]) return;
    seen[key] = 1;
    out.push(e);
  });
  return out;
}
function listThumb(e) {
  const th = el('div'); th.style.cssText = 'position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;background:var(--ez-surface-3);display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--ez-fg-muted);cursor:pointer;flex:0 0 auto;border:2px solid transparent;box-sizing:border-box;';
  const src = entryThumbSrc(e);
  if (src) { const im = el('img'); im.src = src; im.style.cssText = 'width:100%;height:100%;object-fit:cover;'; th.appendChild(im); }
  else th.textContent = ({ IMAGE: '🖼', VIDEO: '🎬', AUDIO: '🎵', MODEL_3D: '🧊', FILE_3D: '🧊' })[String((e && e.type) || '').toUpperCase()] || '📄';
  return th;
}
// 列表弹窗主区：能直接播的直接放（图/视/音都和 MediaLoader 一样一眼就是媒体），
// 只有「拼好的图片张量」和「3D 模型」保留卡片（前者点开看整批、后者点「打开 3D 查看器」）。
function listMainItem(e) {
  if (e && (e.audio || e.audio_src)) {   // 列表弹窗里的音频就地给播放器，不再套一层弹窗（和 MediaLoader 一样）
    const wrap = el('div', 'ezpv-lmain');
    wrap.style.cssText = 'width:100%;padding:0 44px;box-sizing:border-box;';   // 左右让开悬停翻页箭头
    const ap = makeAudioPlayer(e.audio_src || e.audio || '');
    ap.style.cssText = 'width:100%;max-width:520px;';
    wrap.appendChild(ap);
    return wrap;
  }
  if (e && (e.video || e.video_src)) {
    const v = el('video'); v.controls = true; v.src = e.video || e.video_src;
    v.style.cssText = 'max-width:100%;max-height:100%;border-radius:8px;background:#000;';
    const poster = entryThumbSrc(e);
    if (poster) v.poster = poster;
    return v;
  }
  if (e && (e.preview || e.thumb || e.thumb_src || e.image_src) && ((e.images || []).length <= 1)) {   // 单图直接铺在主区（批次图仍是卡片：点开看整批）
    const wrap = el('div', 'ezpv-lmain');
    const img = el('img'); img.src = entryThumbSrc(e); img.alt = e.value || '';
    wrap.appendChild(img);
    if (e.gen_meta) wrap.appendChild(genInfoBadge(e));
    return wrap;
  }
  return renderPreview(e);
}
function openListPreview(entries, caption) {
  if (!entries || !entries.length) return;
  openEzListPreview({
    title: caption || ezT('List'),
    items: entries,
    renderItem: (e) => listMainItem(e),
    thumb: (e) => listThumb(e),
    footer: (e) => [e && e.caption, e && e.value, e && e.type].filter(Boolean).join('   '),
  });
}
function renderCard(node, index, entry, input) {
  const row = el('div', 'ezpv-card');
  const handle = el('span', 'ezpv-handle'); handle.textContent = '⠿';
  const body = el('div', 'ezpv-body');
  const crow = el('div', 'ezpv-crow');
  // 只算「自己这个输入端口」的条目：以前按全局下标兜底，一个列表项的条目会铺到所有卡上（连数量一起变成最大值）
  const listMode = (stateFor(node).previewMode || 'normal') === 'list';   // 全局的「卡片视图」设置；默认「普通」（列表模式收敛重复项，看着不像真实输出）
  const grp = listMode ? collapseEntries(entriesOfInput(node, input, entry)) : entriesOfInput(node, input, entry);   // 列表模式：收敛广播重复；普通模式：原样收，重复项也留着
  const isList = grp.length > 1;
  const name = el('span', 'ezpv-cname');
  name.textContent = ((entry && entry.caption) || (ezT('Input') + ' ' + (index + 1))) + (isList ? (' (' + grp.length + ')') : '');
  // 列表/普通模式 + 多图保存类型都挪到「保存选项」弹窗里了（卡片上只留名字/角标/打开位置）
  const badge = el('span', 'ezpv-badge'); badge.textContent = isList ? 'LIST' : ((entry && entry.type) || 'ANY');
  const fldr = el('button', 'ezpv-fldr'); fldr.title = ezT('Open the save location and select the file');
  fldr.innerHTML = '<svg width="14" height="12" viewBox="0 0 24 20" fill="currentColor"><path d="M2 3h7l2 2h11v12H2z"/></svg>';
  fldr.addEventListener('click', () => { if (entry && entry.saved_path) openSavedFile(entry.saved_path); });
  crow.appendChild(name); crow.appendChild(badge); crow.appendChild(fldr);
  body.appendChild(crow);
  const prev = renderPreview(entry);
  if (prev) {
    if (isList) {
      // 列表卡：点开列表预览。同样登记 _pvOpen，让「按住→抬起」的兜底也能打开（click 被重建吞掉时）
      const openList = () => pvOpenOnce(() => openListPreview(grp, (entry && entry.caption) || ''));
      prev._pvOpen = openList;
      prev.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); openList(); }, true);
    }
    body.appendChild(prev);
  }
  row.appendChild(handle); row.appendChild(body);
  return row;
}
function openSavedFile(path) {
  fetchApi('/preview_any/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).catch(() => {});
}
function pickFolder(node) {
  fetchApi('/preview_any/pick_folder', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).then((r) => r.json()).then((data) => {
    if (data.ok && data.path) { const st = stateFor(node); st.savePath = data.path; syncToConfig(node); refreshUI(node); }
  }).catch(() => {});
}
// 「保存位置」按钮上直接显示当前选中的目录名（空 = 默认 output），否则用户看不出选没选上
function syncLocBtn(btn, p) {
  const s = String(p || '').trim();
  // 按钮文字固定「保存位置」，目录名只放 title（和 SegmentPanel 等节点保持一致）
  btn.textContent = ezT('Save location');
  btn.title = s || ezT('Default: output');
}
let _fmtModal = null;
function formatModalEl() {
  if (_fmtModal && _fmtModal.parentNode) return _fmtModal;
  _fmtModal = document.createElement('div');
  _fmtModal.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:99999;background:rgba(0,0,0,.35);';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--ez-bg);border-radius:16px;padding:14px 16px;width:92%;max-width:560px;max-height:84vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.2);font-family:Inter,sans-serif;box-sizing:border-box;';
  const hd = document.createElement('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--ez-border-2);padding-bottom:8px;';
  const title = document.createElement('b'); title.textContent = ezT('Save options');
  const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = 'background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:9px;padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit;';
  hd.appendChild(title); hd.appendChild(close);
  const fields = document.createElement('div'); fields.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow:auto;';
  // 图片只列静态图格式；动图独立成一项（对齐内置 SaveAnimatedWEBP/PNG：格式 + 帧率 + 无损 + 质量，
  // 无损是勾选框不是 Yes/No 下拉）。gif 不作为「视频」容器：真视频→gif 要抽帧，后端不做。
  const opts = { image: ['', 'png', 'jpeg', 'webp', 'bmp', 'tiff'], animated: ['webp', 'png', 'gif'], audio: ['', 'wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'opus'], video: ['', 'auto', 'mp4', 'webm', 'mov', 'avi', 'mkv'], text: ['txt', 'md', 'json', 'csv', 'log', 'html'], model3d: [''] };
  const labels = { image: ezT('Image'), animated: ezT('Animated'), audio: ezT('Audio'), video: ezT('Video'), text: ezT('Text'), model3d: ezT('3D model') };
  // 只有有损格式才显示「质量」：png/bmp/tiff 无损、wav/flac 无损（码率由内容决定）。
  // 数值参数一律可手输（number + 常用值 datalist），枚举才用下拉
  const subDefs = {
    image: [{ key: 'quality', label: ezT('Quality'), number: { min: 1, max: 100, step: 1, presets: ['90', '95', '100'] }, when: (f) => f === 'jpeg' || f === 'webp' }],
    animated: [
      { key: 'afps', label: ezT('Frame rate'), number: { min: 0.01, max: 1000, step: 0.01, presets: ['6', '12', '24', '30'] } },
      { key: 'alossless', label: ezT('Lossless'), check: true },
      { key: 'quality', label: ezT('Quality'), number: { min: 1, max: 100, step: 1, presets: ['80', '90', '95', '100'] }, when: (f) => f === 'webp' },
      { key: 'method', label: ezT('Compression'), values: ['', 'fastest', 'default', 'slowest'], when: (f) => f === 'webp' },
    ],
    audio: [{ key: 'bitrate', label: ezT('Bitrate (kbps)'), number: { min: 8, max: 512, step: 1, presets: ['128', '192', '320'] }, when: (f) => f !== 'wav' && f !== 'flac' }, { key: 'sr', label: ezT('Sample rate (Hz)'), number: { min: 0, max: 384000, step: 1, presets: ['22050', '44100', '48000'] } }],
    video: [{ key: 'codec', label: ezT('Encoder'), labels: { h265: 'h265 (extra)', vp9: 'vp9 (extra)' }, values: ['', 'auto', 'h264', 'h265', 'vp9', 'av1'] }, { key: 'crf', label: ezT('Quality CRF'), number: { min: 0, max: 63, step: 1, presets: ['18', '24', '32'] } }, { key: 'fps', label: ezT('Frame rate') + ' ' + ezT('(extra)'), number: { min: 0.01, max: 240, step: 0.01, presets: ['24', '30', '60'] } }, { key: 'bit_depth', label: ezT('Bit depth'), values: ['', '8', '10'] }, { key: 'color_space', label: ezT('Color space'), values: ['', 'sRGB', 'HDR', 'HDR PQ'] }, { key: 'preset', label: ezT('Preset'), values: ['', 'fast', 'medium', 'slow'] }, { key: 'acodec', label: ezT('Audio codec') + ' ' + ezT('(extra)'), values: ['', 'copy', 'aac', 'opus', 'mp3'] }, { key: 'abitrate', label: ezT('Audio bitrate') + ' ' + ezT('(extra)'), number: { min: 8, max: 512, step: 1, presets: ['128', '192', '320'] } }, { key: 'asr', label: ezT('Audio sample rate') + ' ' + ezT('(extra)'), number: { min: 0, max: 384000, step: 1, presets: ['32000', '44100', '48000'] } }],
    text: [], model3d: []
  };
  const selects = {}; const subSelects = {}; const subRows = [];
  Object.keys(opts).forEach((cat) => {
    const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;border:1px solid var(--ez-border-2);border-radius:10px;padding:6px 8px;';
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const tog = document.createElement('span'); tog.textContent = '▸'; tog.style.cssText = 'cursor:pointer;width:14px;text-align:center;color:var(--ez-fg-3);flex:0 0 auto;';
    const lab = document.createElement('span'); lab.textContent = labels[cat]; lab.style.cssText = 'flex:0 0 48px;font-size:12px;color:var(--ez-fg);';
    const sel = document.createElement('select'); sel.style.cssText = 'flex:1 1 auto;appearance:none;background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:9px;padding:5px 10px;font-size:12px;font-family:inherit;';
    const fmtLabels = { mov: 'mov (extra)', avi: 'avi (extra)' };
    opts[cat].forEach((f) => { const o = document.createElement('option'); o.value = f; o.textContent = (fmtLabels[f] || f) || ezT('Keep source'); sel.appendChild(o); });
    row.appendChild(tog); row.appendChild(lab); row.appendChild(sel);
    wrap.appendChild(row);
    const sub = document.createElement('div'); sub.style.cssText = 'display:none;flex-direction:column;gap:6px;padding-left:18px;';
    (subDefs[cat] || []).forEach((sd) => {
      const srow = document.createElement('div'); srow.style.cssText = 'display:flex;align-items:center;gap:8px;';
      const sl = document.createElement('span'); sl.textContent = sd.label; sl.style.cssText = 'flex:0 0 62px;font-size:11px;color:var(--ez-fg-3);';
      let ss;
      if (sd.check) {
        ss = document.createElement('input'); ss.type = 'checkbox'; ss.checked = true;
        ss.style.cssText = 'width:14px;height:14px;accent-color:var(--ez-strong);cursor:pointer;margin:0;flex:0 0 auto;';
      } else if (sd.number) {
        ss = document.createElement('input'); ss.type = 'number';
        ss.min = String(sd.number.min); ss.max = String(sd.number.max); ss.step = String(sd.number.step);
        ss.style.cssText = 'flex:1 1 auto;min-width:0;background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:8px;padding:3px 8px;font-size:11px;font-family:inherit;color:var(--ez-fg);';
        ss.title = ezT('Click a preset or double-click to type a custom value');
        ss.addEventListener('dblclick', () => { try { ss.focus(); ss.select(); } catch (_) {} });
        if (sd.number.presets && sd.number.presets.length) {
          const dl = document.createElement('datalist'); dl.id = 'ezpv-dl-' + cat + '-' + sd.key;
          sd.number.presets.forEach((v) => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); });
          ss.setAttribute('list', dl.id); sub.appendChild(dl);
        }
      } else {
        ss = document.createElement('select'); ss.style.cssText = 'flex:1 1 auto;appearance:none;background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:8px;padding:3px 8px;font-size:11px;font-family:inherit;';
        sd.values.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = (sd.labels && sd.labels[v]) || v || ezT('Keep original'); ss.appendChild(o); });
      }
      if (sd.when) { srow._when = sd.when; subRows.push({ cat: cat, row: srow, when: sd.when }); }
      srow.appendChild(sl); srow.appendChild(ss); sub.appendChild(srow);
      subSelects[cat + '.' + sd.key] = ss;
    });
    wrap.appendChild(sub);
    tog.addEventListener('click', (e) => { e.stopPropagation(); const open = tog.textContent === '▸'; tog.textContent = open ? '▾' : '▸'; sub.style.display = open ? 'flex' : 'none'; });
    fields.appendChild(wrap);
    selects[cat] = sel;
  });
  const subVals = (cat) => { const o = {}; (subDefs[cat] || []).forEach((sd) => { const ss = subSelects[cat + '.' + sd.key]; if (ss) o[sd.key] = sd.check ? !!ss.checked : ss.value; }); return o; };
  const extraNote = document.createElement('div');
  extraNote.style.cssText = 'font-size:11px;color:var(--ez-fg-3);padding:2px 0 0 18px;';
  extraNote.textContent = ezT('Uses the PreviewAny extra encoder (PyAV), not the built-in path');
  fields.appendChild(extraNote);
  const updateExtraNote = () => {
    const v = subVals('video');
    const on = ['mov', 'avi'].includes(String(selects.video.value || '').toLowerCase())
      || ['h265', 'vp9'].includes(String(v.codec || '').toLowerCase())
      || !!(v.fps || v.acodec || v.abitrate || v.asr);
    extraNote.style.display = on ? '' : 'none';
  };
  const applySubs = () => { subRows.forEach((g) => { g.row.style.display = (!g.when || g.when(selects[g.cat].value, subVals(g.cat))) ? 'flex' : 'none'; }); };
  // ★ 与内置 DynamicCombo 同方向：容器 ↔ 视频编码 ↔ 音频编码 三项互相约束（非法项禁用 + 回正）。
  //   表与后端 __init__.py 的 _VIDEO_CODECS_BY_FMT / _AUDIO_CODECS_BY_FMT 一一对应；
  //   后端编码前还会再校验一次（旧工作流里可能存着非法组合）。
  const V_CODECS = {
    '': null, auto: null,
    mp4: ['h264', 'h265', 'av1'], mov: ['h264', 'h265'],
    webm: ['vp9', 'av1'], avi: ['h264'], mkv: ['h264', 'h265', 'vp9', 'av1']
  };
  const A_CODECS = {
    '': null, auto: null,
    mp4: ['aac', 'mp3'], mov: ['aac', 'mp3'],
    webm: ['opus'], avi: ['mp3', 'aac'], mkv: ['aac', 'opus', 'mp3']
  };
  // 反方向：选了编码器后，容器跟着收敛（vp9 只能 webm/mkv …；选编码器时不留「跟随源」）
  const FMT_OF_CODEC = {
    h264: ['mp4', 'mov', 'avi', 'mkv'],
    h265: ['mp4', 'mov', 'mkv'],
    vp9: ['webm', 'mkv'],
    av1: ['mp4', 'webm', 'mkv']
  };
  const disOpts = (sel, ok) => {
    if (!sel) return;
    Array.from(sel.options).forEach((o) => { if (String(o.value) !== '') o.disabled = !ok(String(o.value).toLowerCase()); });
  };
  const curOptDisabled = (sel) => !!(sel && sel.selectedOptions && sel.selectedOptions[0] && sel.selectedOptions[0].disabled);
  const syncVideoCombo = () => {
    const cSel = subSelects['video.codec'];
    const aSel = subSelects['video.acodec'];
    const csSel = subSelects['video.color_space'];
    const bdSel = subSelects['video.bit_depth'];
    for (let pass = 0; pass < 2; pass++) {
      const vf = String(selects.video.value || '').toLowerCase();
      // ① 容器 → 编码器 / 音频编码：容器不吃的编码直接禁用，已被选中的回正
      disOpts(cSel, (v) => !V_CODECS[vf] || V_CODECS[vf].includes(v));
      disOpts(aSel, (v) => v === 'copy' || !A_CODECS[vf] || A_CODECS[vf].includes(v));
      if (curOptDisabled(cSel)) cSel.value = '';
      if (curOptDisabled(aSel)) aSel.value = '';
      // ② 编码器 → 容器：当前容器装不下这个编码器就自动切到第一个能装下的
      const codec = String(cSel && cSel.value || '').toLowerCase();
      const okFmts = codec ? FMT_OF_CODEC[codec] : null;
      disOpts(selects.video, (f) => !okFmts || okFmts.includes(f));
      if (okFmts && !okFmts.includes(vf)) {
        selects.video.value = okFmts[0];
        continue;                       // 容器变了 ⇒ 再跑一遍，把编码器/音频选项跟着收敛
      }
      // ③ HDR 必须是 10 bit：HDR 时禁掉 8bit 并自动切到 10bit
      const hdr = ['hdr', 'hdr pq'].includes(String(csSel && csSel.value || '').toLowerCase());
      disOpts(bdSel, (v) => !(hdr && v === '8'));
      if (hdr && bdSel && String(bdSel.value) === '8') bdSel.value = '10';
    }
  };
  Object.keys(selects).forEach((cat) => selects[cat].addEventListener('change', () => { applySubs(); if (cat === 'video') syncVideoCombo(); updateExtraNote(); }));
  Object.keys(subSelects).forEach((k) => subSelects[k].addEventListener('change', () => {
    if (k.startsWith('video.')) syncVideoCombo();   // 改编码器/色彩空间会反过来约束容器与位深
    applySubs(); updateExtraNote();
  }));
  applySubs(); syncVideoCombo(); updateExtraNote();
  // 文件名模板（%year% %month% %day% %hour% %minute% %second%），空 = 用卡片名
  const nameRow = document.createElement('div'); nameRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
  const nameLab = document.createElement('span'); nameLab.textContent = ezT('File name prefix'); nameLab.style.cssText = 'flex:0 0 96px;font-size:12px;color:var(--ez-fg);';
  const nameInput = document.createElement('input'); nameInput.type = 'text';
  nameInput.style.cssText = 'flex:1 1 auto;background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:8px;padding:4px 8px;font-size:11px;font-family:inherit;';
  nameRow.appendChild(nameLab); nameRow.appendChild(nameInput);
  const ft = document.createElement('div'); ft.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--ez-border-2);padding-top:10px;';
  const save = document.createElement('button'); save.textContent = ezT('OK'); save.style.cssText = 'background:var(--ez-strong);color:var(--ez-on-strong);border:1px solid var(--ez-strong);border-radius:9px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit;';
  ft.appendChild(save);
  // 全局设置（一行搞定，不按输入口分开）：多图保存为 + 卡片视图
  const gbox = document.createElement('div'); gbox.style.cssText = 'display:flex;flex-direction:column;gap:6px;border:1px solid var(--ez-border-2);border-radius:10px;padding:6px 8px;';
  const mkGlobal = (labelText, options, cur) => {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const lab = document.createElement('span'); lab.textContent = labelText; lab.style.cssText = 'flex:0 0 96px;font-size:12px;color:var(--ez-fg);';
    const sel = document.createElement('select'); sel.style.cssText = 'flex:1 1 auto;appearance:none;background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:9px;padding:5px 10px;font-size:12px;font-family:inherit;';
    options.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); });
    sel.value = cur;
    row.appendChild(lab); row.appendChild(sel); gbox.appendChild(row);
    return sel;
  };
  const batchSel = mkGlobal(ezT('Multi-image display / save'), [['auto', ezT('Auto')], ['images', ezT('Image sequence')], ['video', ezT('Video')], ['animation', ezT('Animated')]], 'auto');
  const modeSel = mkGlobal(ezT('List / Normal'), [['normal', ezT('Normal')], ['list', ezT('List')]], 'normal');
  batchSel.addEventListener('change', () => { const n = _fmtModal._node; if (!n) return; stateFor(n).batchMode = batchSel.value; syncToConfig(n); });
  modeSel.addEventListener('change', () => { const n = _fmtModal._node; if (!n) return; stateFor(n).previewMode = modeSel.value === 'list' ? 'list' : 'normal'; syncToConfig(n); renderEntries(n); });
  const maxRow = document.createElement('div'); maxRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:nowrap;';
  const maxLab = document.createElement('span'); maxLab.textContent = ezT('Frame sequence limit'); maxLab.style.cssText = 'flex:0 0 96px;font-size:12px;color:var(--ez-fg);white-space:nowrap;';
  const maxInp = document.createElement('input'); maxInp.type = 'text'; maxInp.inputMode = 'numeric'; maxInp.placeholder = '64';
  maxInp.title = ezT('Default 64; there is no upper limit. 0 = unlimited.');
  maxInp.style.cssText = 'flex:1 1 auto;min-width:0;box-sizing:border-box;background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:9px;padding:5px 10px;font-size:12px;font-family:inherit;';
  maxInp.addEventListener('change', () => { const n = _fmtModal._node; if (!n) return; const v = Math.max(0, parseInt(maxInp.value, 10) || 0); maxInp.value = String(v); stateFor(n).batchMax = v; syncToConfig(n); });
  maxRow.appendChild(maxLab); maxRow.appendChild(maxInp); gbox.appendChild(maxRow);
  fields.insertBefore(gbox, fields.firstChild);   // 全局两块放最上面
  fields.appendChild(nameRow);
  box.appendChild(hd); box.appendChild(fields); box.appendChild(ft);
  _fmtModal.appendChild(box); document.body.appendChild(_fmtModal);
  attachFullscreen(box, () => { _fmtModal.style.display = 'none'; }, close);
  _fmtModal._selects = selects; _fmtModal._subSelects = subSelects; _fmtModal._subDefs = subDefs; _fmtModal._subVals = subVals; _fmtModal._applySubs = applySubs; _fmtModal._syncVideoCombo = syncVideoCombo; _fmtModal._nameInput = nameInput; _fmtModal._batchSel = batchSel; _fmtModal._modeSel = modeSel; _fmtModal._batchMax = maxInp; _fmtModal._node = null;
  close.addEventListener('click', () => { _fmtModal.style.display = 'none'; });
  _fmtModal.addEventListener('click', (e) => { if (e.target === _fmtModal) _fmtModal.style.display = 'none'; });
  save.addEventListener('click', () => {
    if (!_fmtModal._node) return;
    const st = stateFor(_fmtModal._node);
    st.saveFormats._name = _fmtModal._nameInput.value.trim();
    Object.keys(_fmtModal._selects).forEach((cat) => {
      const o = { fmt: _fmtModal._selects[cat].value };
      const sv = _fmtModal._subVals(cat);
      (_fmtModal._subDefs[cat] || []).forEach((sd) => { const ss = _fmtModal._subSelects[cat + '.' + sd.key]; if (ss && (!sd.when || sd.when(_fmtModal._selects[cat].value, sv))) o[sd.key] = sd.check ? !!ss.checked : ss.value; });
      st.saveFormats[cat] = o;
    });
    syncToConfig(_fmtModal._node);
    _fmtModal.style.display = 'none';
  });
  return _fmtModal;
}
function openFormatModal(node) {
  const m = formatModalEl();
  m._node = node;
  const st = stateFor(node);
  Object.keys(m._selects).forEach((cat) => {
    const v = st.saveFormats[cat];
    if (v && typeof v === 'object') {
      if (v.fmt) m._selects[cat].value = v.fmt;
      (m._subDefs[cat] || []).forEach((sd) => {
        const ss = m._subSelects[cat + '.' + sd.key]; if (!ss) return;
        if (sd.check) ss.checked = !(v[sd.key] === false || String(v[sd.key]).toLowerCase() === 'no' || String(v[sd.key]).toLowerCase() === 'false');
        else if (v[sd.key] != null && String(v[sd.key]) !== '') ss.value = v[sd.key];
      });
    } else if (typeof v === 'string') m._selects[cat].value = v;
  });
  if (m._nameInput) m._nameInput.value = st.saveFormats._name || '';
  if (m._batchSel) m._batchSel.value = st.batchMode || 'auto';
  if (m._modeSel) m._modeSel.value = st.previewMode === 'list' ? 'list' : 'normal';
  if (m._batchMax) m._batchMax.value = String(st.batchMax == null ? 64 : st.batchMax);
  if (m._applySubs) m._applySubs();   // 按当前格式显示/隐藏质量、码率等
  if (m._syncVideoCombo) m._syncVideoCombo();   // 旧工作流里的非法组合（webm+h264 等）在打开时回正
  m.style.display = 'flex';
}
let _dpModal = null;
function openDataPreviewModal() {
  if (_dpModal && _dpModal.parentNode) _dpModal.remove();
  _dpModal = document.createElement('div');
  _dpModal.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99999;background:rgba(15,20,31,.5);';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--ez-bg);border-radius:16px;padding:14px 16px;width:94%;max-width:560px;max-height:84vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:Inter,sans-serif;box-sizing:border-box;';
  const hd = document.createElement('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--ez-border-2);padding-bottom:8px;';
  const t = document.createElement('b'); t.textContent = ezT('Data preview types / formats');
  const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = 'background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:9px;padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit;';
  hd.appendChild(t); hd.appendChild(close);
  const rows = [
    ['IMAGE', ezT('PNG / JPEG / WebP / BMP / TIFF (zoom to view); batches can save as image sequence / video / animated WebP-PNG-GIF')],
    ['MASK', ezT('Grayscale PNG')],
    ['AUDIO', ezT('WAV / MP3 / FLAC / OGG / M4A / AAC (play)')],
    ['VIDEO', ezT('MP4 / WebM / MOV / GIF / AVI / MKV (poster + playback)')],
    ['STRING / INT / FLOAT / BOOLEAN', 'TXT / MD / JSON / CSV / LOG / HTML'],
    ['DICT', ezT('Key-value tree (key:value)')],
    ['LIST / TUPLE / SET', ezT('Index-value tree (index:value)')],
    ['LATENT / CONDITIONING', ezT('shape + description (no file)')],
    ['MODEL(ckpt/unet)', ezT('safetensors / gguf / onnx / ckpt / pt (name/architecture/organization/author/trigger words)')],
    ['CLIP / VAE', 'safetensors / gguf / onnx'],
    ['MODEL_3D', ezT('glb / gltf / obj / fbx (three.js viewer)')],
    ['FILE_3D', ezT('FILE_3D model from the built-in Load3D (glb / gltf / obj / fbx)')],
    ['MESH', ezT('Vertex/face tensors → temporary OBJ + three.js viewer (Hunyuan3D / Trellis / MoGe, etc.)')],
    ['SPLAT / VOXEL', ezT('Gaussian splats / voxels: summary only (visualization not supported yet)')],
    ['CONTROL_NET / CLIP_VISION / STYLE_MODEL / UPSCALE_MODEL / LORA_MODEL / GLIGEN', ezT('Text summary')],
    ['SAMPLER / SIGMAS / GUIDER / NOISE / SEGS', ezT('Text summary')],
    ['EMPTY', ezT('"(not connected)"')],
  ];
  const list = document.createElement('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:4px;overflow:auto;';
  rows.forEach(([k, v]) => { const r = document.createElement('div'); r.style.cssText = 'display:flex;gap:8px;font-size:12px;'; const kk = document.createElement('b'); kk.textContent = k; kk.style.cssText = 'flex:0 0 180px;color:var(--ez-fg);'; const vv = document.createElement('span'); vv.textContent = v; vv.style.cssText = 'flex:1 1 auto;color:var(--ez-fg-3);word-break:break-all;'; r.appendChild(kk); r.appendChild(vv); list.appendChild(r); });
  box.appendChild(hd); box.appendChild(list); _dpModal.appendChild(box); document.body.appendChild(_dpModal);
  attachFullscreen(box, () => { if (_dpModal) { _dpModal.remove(); _dpModal = null; } }, close);
  close.addEventListener('click', () => { _dpModal.remove(); _dpModal = null; });
  _dpModal.addEventListener('click', (e) => { if (e.target === _dpModal) { _dpModal.remove(); _dpModal = null; } });
}

// ===== 渲染面板 =====
// 卡片「名称」开关：全局偏好（localStorage ezflex.pvLabels）
const PV_LABELS_LS = 'ezflex.pvLabels';
let _pvLabels = null;
function pvLabelsOn() { if (_pvLabels === null) { try { _pvLabels = window.localStorage.getItem(PV_LABELS_LS) !== '0'; } catch (_) { _pvLabels = true; } } return _pvLabels; }
function pvLabelsSet(on) {
  _pvLabels = !!on;
  try { window.localStorage.setItem(PV_LABELS_LS, _pvLabels ? '1' : '0'); } catch (_) {}
  try { if (app && app.graph) app.graph.setDirtyCanvas(true, true); } catch (_) {}   // 黑框标签每帧重算，重绘即可隐/显
}
function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'ezpv-shell');
  const root = el('div', 'ezpv-root');
  // Nodes 2.0：addDOMWidget 传的是 root（不是 shell），必须让 root 从标题栏下方开始，否则标题被盖住
  if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) {
    root.style.top = 'var(--ezfx-vue-title, 30px)';
  }
  shell.appendChild(root);
  node._ezRoot = shell;
  const hd = el('div', 'ezpv-hd');
  const saveBtn = el('button', 'ezpv-btn ezpv-save');
  const locBtn = el('button', 'ezpv-btn ezpv-loc'); locBtn.textContent = ezT('Save location');
  syncLocBtn(locBtn, stateFor(node).savePath);
  const fmtBtn = el('button', 'ezpv-btn'); fmtBtn.textContent = ezT('Save options');
  const infoBtn = el('button', 'ezpv-btn'); infoBtn.textContent = ezT('Data preview');
  const nameBtn = el('button', 'ezpv-btn'); nameBtn.textContent = ezT('Names');
  const syncName = () => { const on = pvLabelsOn(); nameBtn.style.background = on ? 'var(--ez-ok-bg)' : ''; nameBtn.style.borderColor = on ? 'var(--ez-ok-border)' : ''; nameBtn.style.color = on ? 'var(--ez-ok-fg)' : ''; };
  nameBtn.addEventListener('click', () => { pvLabelsSet(!pvLabelsOn()); syncName(); });
  hd.appendChild(saveBtn); hd.appendChild(locBtn); hd.appendChild(fmtBtn); hd.appendChild(infoBtn); hd.appendChild(nameBtn); syncName();
  const list = el('div', 'ezpv-list');
  root.appendChild(hd); root.appendChild(list);
  saveBtn.addEventListener('click', () => {
    const st = stateFor(node);
    st.save = !st.save;
    syncToConfig(node);
    refreshSaveBtn(saveBtn, st.save);
    refreshUI(node);
  });
  locBtn.addEventListener('click', () => pickFolder(node));
  fmtBtn.addEventListener('click', () => openFormatModal(node));
  infoBtn.addEventListener('click', () => openDataPreviewModal());
  root._saveBtn = saveBtn;
  render();
  renderSaveBtn(saveBtn, stateFor(node).save);
  function render() { renderEntries(node); }
  return shell;
}
function refreshSaveBtn(btn, save) {
  if (!btn) return;
  btn.classList.toggle('on', !!save);
  btn.classList.toggle('off', !save);
  btn.title = ezT('Whether to save');
  if (!btn._docIcon) {
    // 软盘图标 + 内部小 auto 字样
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5a1 1 0 0 1 1-1h11l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><rect x="7" y="3.6" width="7" height="5" rx="1"/><path d="M6 14.5h12v6H6z"/></svg><span class="ezpv-auto">auto</span>';
    btn._docIcon = true;
  }
}
function renderSaveBtn(btn, save) { refreshSaveBtn(btn, save); }

function refreshUI(node) {
  const root = pvShell(node);
  if (!root) return;
  const saveBtn = root.querySelector('.ezpv-save');
  if (saveBtn) renderSaveBtn(saveBtn, stateFor(node).save);
  const locBtn = root.querySelector('.ezpv-loc');
  if (locBtn) syncLocBtn(locBtn, stateFor(node).savePath);
  renderEntries(node);
}

// ===== 通用指针拖拽排序 =====
function attachDnD(container, itemSel, handleSel, onDrop) {
  container.querySelectorAll('.ezpv-ph').forEach((x) => x.remove());
  const placeholder = el('div', 'ezpv-ph hidden');
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
        clone.style.cssText = `position:fixed;pointer-events:none;width:${rect.width}px;opacity:.85;z-index:99999;border:2px solid var(--ez-strong);border-radius:6px;background:var(--ez-bg);box-shadow:0 8px 24px rgba(0,0,0,.12);top:${rect.top}px;left:${rect.left}px;transition:none;`;
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

// ===== 挂载 =====
function hideConfigWidget(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && (_in.name === 'config')) { try { ezDropInput(node, _i); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}

  const w = configWidget(node); if (!w) return; node._ezPrevCfgHid = true;
  // ★ 幂等、每次重压一遍：切换工作流 / 刷新时 config 的宿主会被重建，`display:none` 会丢失 → 文字露在面板下。
  try {
    w.origComputeSize = w.computeSize; w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0;
    w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
    if (w.element && w.element.style) { w.element.style.display = 'none'; w.element.style.height = '0'; w.element.style.minHeight = '0'; w.element.style.maxHeight = '0'; }
    // 连它的 .dom-widget 宿主容器一起藏（容器没了，里面就不可能画东西）
    // ⚠️ 判断「这是不是**我们预览面板**的宿主」用 pvHost(node)（按 widget.type==='ezpv-panel' 找），
    //    绝不能用「里面有没有 .ezpv-shell」—— 切工作流后新宿主是空壳，那时 shell 还没搬进去，会被误藏。
    try {
      let host = w.element && w.element.parentElement; let hop = 0;
      while (host && host.classList && !host.classList.contains('dom-widget') && hop < 6) { host = host.parentElement; hop += 1; }
      const pv = pvHost(node);
      let pvWrap = pv && pv.parentElement; let h2 = 0;
      while (pvWrap && pvWrap.classList && !pvWrap.classList.contains('dom-widget') && h2 < 6) { pvWrap = pvWrap.parentElement; h2 += 1; }
      const isPreviewWrap = !!(pvWrap && host && pvWrap === host);
      if (host && host.style && !isPreviewWrap) host.style.setProperty('display', 'none', 'important');
    } catch (_) {}
  } catch (_) {}
}
function setupNode(node) {
  if (!node || node._ezPrevSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') return;
    node._ezPrevSetup = true;
    loadFromConfig(node);
    const root = buildRoot(node);
    node._ezRoot = root;
    makeDomWidgetHitThrough(root);
    const widget = node.addDOMWidget('任意预览', 'ezpv-panel', root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 120, getValue: () => '{}', setValue: () => {} });
    makeDomWidgetHitThrough(widget.element || root);
    node.widgets_start_y = 0;
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
    installResizeHandles(node, root);
    try { ezApplyDefaultSize(node, 410, 200); } catch (_) {}
    hideConfigWidget(node);
    syncSockets(node);
    refreshUI(node);
    // 黑框标签：输入/输出端口都用对应预览卡片的名（卡片名 = entry.caption，回传后 onExecuted 里刷新）
    installEdgeLabels(node, {
      side: 'both',
      labelOf: (sock, index, isIn) => {
        if (!pvLabelsOn()) return '';                   // 「名称」关掉就不画端口黑框标签
        const ents = stateFor(node).entries || [];
        const linked = (node.inputs || []).filter((i) => i.link != null);
        // 输入口按端口名对位；输出口（output_N）没有自己的 entry，按位置映射到第 index 个已连输入。
        // 以前一律取 entries[index]：同一个口有多条 entry（列表广播 / 循环多轮）时整体错位，后面的端口会显示成别人的标题。
        const own = entriesOfInput(node, isIn ? sock : (linked[index] || null));
        const legacy = !ents.some((e) => e && e.input);
        const e = own.length ? own[0] : (legacy ? ents[index] : null);
        if (e && e.caption) return e.caption;
        if (index >= connectedCount(node)) return '';   // 末尾那个空输入槽还没有卡片
        return ezT('Input') + ' ' + (index + 1);
      },
    });
    setTimeout(() => { syncSockets(node); refreshUI(node); }, 80);
  } catch (e) { console.error('[PreviewAny] init failed:', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__ezPrevHooked) return; nt.__ezPrevHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { this.__ezSizeRestored = true;
    const r = prevCfg ? prevCfg.apply(this, arguments) : undefined;
    loadFromConfig(this); pvSyncBuffered(this); syncSockets(this); refreshUI(this);
    // ★ 切换工作流 / 载入图：DOM 宿主可能刚被重建 → 延后自愈两次（结构 + 布局各一次）
    setTimeout(() => { try { healDom(this); refreshUI(this); } catch (_) {} }, 60);
    setTimeout(() => { try { healDom(this); refreshUI(this); } catch (_) {} }, 400);
    return r;
  };
  const prevConn = nt.prototype.onConnectionsChange; nt.prototype.onConnectionsChange = function (type, index, connected, link_info) {
    const r = prevConn ? prevConn.apply(this, arguments) : undefined;
    try { if (this._ezPrevSetup) { setTimeout(() => { syncSockets(this); refreshUI(this); }, 0); } } catch (_) {}
    return r;
  };
  const prevExec = nt.prototype.onExecuted; nt.prototype.onExecuted = function (message) {
    const r = prevExec ? prevExec.apply(this, arguments) : undefined;
    // 循环展开时每轮都会来一次 onExecuted（都挂在本节点 id 上）：累加各轮，换一次执行再清空 ——
    // 直接覆盖会只剩最后一轮的值。原样存，去不去重在卡片上的模式里决定。
    // ★ 内存里那份也要封顶（与 pvStripEntries 的 64 一致）：每条 entry 带一张 640 px base64 预览，
    //   长循环不封顶会攒到上百 MB（2026-11 审计 P2-12）。
    try { if (message && message.entries) { const st = stateFor(this); const added = message.entries; st.entries = (Array.isArray(st.entries) ? st.entries : []).concat(added).slice(-64); pvPersist(this); added.forEach((e) => pvMakeThumb(e, this)); renderEntries(this); if (this._ezEdgeUpdate) this._ezEdgeUpdate(); } } catch (_) {}
    return r;
  };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; unregisterNode(this); try { if (this._ezPrevSyncTimer) { clearTimeout(this._ezPrevSyncTimer); this._ezPrevSyncTimer = null; } } catch (_) {} try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {} this._ezPrevSetup = false; return r; };
  const prevAdded = nt.prototype.onAdded; nt.prototype.onAdded = function () {
    const r = prevAdded ? prevAdded.apply(this, arguments) : undefined; registerNode(this);
    // ★ 展开折叠 / 重新加回画布 / 切回本工作流：宿主可能刚被重建，延后自愈两次。
    setTimeout(() => { try { healDom(this); refreshUI(this); } catch (_) {} }, 0);
    setTimeout(() => { try { healDom(this); refreshUI(this); } catch (_) {} }, 120);
    return r;
  };
  // ★ 每帧兜一次（画布重绘时）：折叠/切工作流后 DOM 宿主被换掉时没人通知我们，
  //   只有这里能发现 `_ezRoot` 已脱离文档并重挂 + 重画。`!collapsed` 时才有意义。
  //   多实例时每帧都查太贵（拖动画布掉帧）→ 限流 200ms。
  const prevDraw = nt.prototype.onDrawForeground; nt.prototype.onDrawForeground = function (ctx) {
    if (prevDraw) prevDraw.call(this, ctx);
    const _now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!this._ezPrevSetup || this.collapsed) return;
    if (_now - (this._ezHealAt || 0) < 200) return;
    this._ezHealAt = _now;
    try { healDom(this); } catch (_) {}
  };
}
// 语言切换后重画同类型节点的面板（ezT 在渲染时求值，重画即换语言）
onLocaleChange(() => {
  ((app && app.graph && app.graph._nodes) || []).forEach((n) => { if (n && n.type === NODE) { try { refreshUI(n); } catch (_) {} } });
});

// 一次执行 = 一个 prompt：**排队时**清空本工作流所有 PreviewAny 的 entries（循环累加只在一轮执行内生效）。
// 以前挂 execution_start：排队后立刻切到别的工作流时，执行开始那一刻会把**当前显示的那个**工作流清空。
function previewAnyNodes(graph) {
  const g = graph || (app && app.graph);
  return ((g && g._nodes) || []).filter((n) => n && nodeTypeOf(n) === NODE);
}
function resetPreviewEntries(graph) {
  previewAnyNodes(graph).forEach((n) => {
    try { stateFor(n).entries = []; pvPersist(n); renderEntries(n); if (n._ezEdgeUpdate) n._ezEdgeUpdate(); } catch (_) {}
  });
}
// 排队：记下「这个 prompt 属于哪个工作流」+ 清空本工作流旧预览与旧结果缓存
function pvHookQueue() {
  if (!api || api.__ezPrevQueueHooked || typeof api.queuePrompt !== 'function') return;
  api.__ezPrevQueueHooked = true;
  const prev = api.queuePrompt;
  api.queuePrompt = function (number, prompt, extra) {
    let wid = '';
    try {
      const g = (app && app.graph) || null;
      wid = pvWorkflowId(g);
      if (wid) { resetPreviewEntries(g); pvBufClear(wid); }
    } catch (_) {}
    const res = prev.apply(this, arguments);
    try {
      Promise.resolve(res).then((r) => {
        const pid = r && r.prompt_id;
        if (pid != null && wid) {
          _pvRuns.set(String(pid), wid);
          while (_pvRuns.size > 32) _pvRuns.delete(_pvRuns.keys().next().value);
        }
      }).catch(() => {});
    } catch (_) {}
    return res;
  };
}
// 自己收 executed：即使节点不在当前显示的工作流里，也按「工作流 id|节点 id」存一份结果
function pvCollectExecuted(ev) {
  try {
    const d = (ev && ev.detail) || {};
    const entries = d.output && d.output.entries;
    if (!Array.isArray(entries) || !entries.length) return;
    const pid = d.prompt_id != null ? String(d.prompt_id) : '';
    const wid = pid ? _pvRuns.get(pid) : '';
    if (!wid) return;   // 不是本插件排队的 prompt（别的客户端 / 队列面板补跑）：不猜，免得把别的工作流的结果串过来
    pvBufAdd(wid, String(d.node != null ? d.node : '').split(':').pop(), entries);
  } catch (_) {}
}
pvHookQueue();
try { api.addEventListener('executed', pvCollectExecuted); } catch (_) {}

// ★★ 切换工作流标签的兜底自愈：切 tab 时 ComfyUI 只换 `app.graph`，本节点的 onConfigure/onAdded 不一定再触发，
//    而此时 DOM widget 的宿主已被重建 → `_ezRoot` 变幽灵 DOM → 面板空掉。这里每次画布重绘都巡检一遍：
//    发现「本节点在当前显示图里、但 shell 已脱离文档」→ 立刻 healDom + 重画。
// ⚠️⚠️ 但**只挂 scheduleOnRedraw 不够**：切换工作流是纯 UI 动作，用户不动鼠标就不会触发 pumpFrames
//    （EZ_PERF.labelFallbackMs = 0，没有兜底定时器）→ 巡检永远不跑 → 症状「切回来后要再点一下画布才显示」。
//    所以下面**另加一个只在「疑似切换」期间才活的短时轮询**（400ms 内每 40ms 巡检一次，之后自动停，静止零开销）。
const PV_SWITCH_POLL_MS = 40, PV_SWITCH_WINDOW_MS = 600;
let _pvLastGraph = null, _pvPollTimer = 0, _pvPollUntil = 0;
function pvSweep(force) {
  try {
    const shown = (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
    const switched = shown !== _pvLastGraph;
    if (switched) { _pvLastGraph = shown; pvArmSwitchPoll(); }   // 发现换图 → 起一轮短时轮询
    if (!force && !switched) {
      // 图没换：只在「有幽灵 shell」时才逐节点巡检（静止时零开销）
      let any = false;
      for (const n of previewAnyNodes()) { const sh = n && n._ezRoot; if (sh && sh.isConnected === false) { any = true; break; } }
      if (!any) return;
    }
    for (const n of previewAnyNodes()) {
      if (!n || !n._ezPrevSetup) continue;
      try { pvSyncBuffered(n); } catch (_) {}   // 切回来：把「在别的 tab 跑完」的结果补上
      healDom(n); refreshUI(n);
    }
  } catch (_) {}
}
function pvArmSwitchPoll() {
  _pvPollUntil = Date.now() + PV_SWITCH_WINDOW_MS;
  if (_pvPollTimer) return;
  const tick = () => {
    pvSweep(true);
    if (Date.now() < _pvPollUntil) { _pvPollTimer = setTimeout(tick, PV_SWITCH_POLL_MS); }
    else { _pvPollTimer = 0; }
  };
  _pvPollTimer = setTimeout(tick, 0);
}
scheduleOnRedraw(() => pvSweep(false));
// 切换工作流也可能是「新图先挂上、DOM 稍后才重建」：换图那一刻起多扫几轮（只在这一小段时间里跑）
// ★ ComfyApp 是普通 class、没有 addEventListener：这些事件在 api 上（以前挂 app 被 try 吞掉，
//   切工作流后的主动巡检从来没生效过）。graphConfigured 事件不存在 ⇒ 用扩展钩子 afterConfigureGraph。
try { api.addEventListener('graphChanged', () => pvArmSwitchPoll()); } catch (_) {}
try { api.addEventListener('graphCleared', () => pvArmSwitchPoll()); } catch (_) {}

app.registerExtension({
  name: 'Comfy.EzFlex.PreviewAny',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  afterConfigureGraph() { try { pvArmSwitchPoll(); } catch (_) {} },
  setup() { ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); },
});
