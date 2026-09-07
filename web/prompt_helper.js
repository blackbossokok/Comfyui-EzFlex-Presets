// EzFlex-PromptHelper 提示词卡片合并节点。
// 前端面板：完整富文本编辑器（卡片列表 + 格式工具条 + 颜色/字号/缩进 + 查找替换 + 取色器 + 规则弹窗 + API 厂商/模型/链接）。
// 固定输入 clip；动态「综合媒体」输入（红色 ANY，可接图像/视频/音频/3D 模型等，连接后自动补一个空槽）；
// 动态输入 = 卡片数 1:1（card_in_1..N，按顺序链接到卡片，连接后对应卡片变灰）；
// 输出固定「合并提示词」+ 动态卡片输出 = 卡片数 1:1。
// 复用 ModelsCombo/ParamPreset/PreviewAny 动态端口经验：卡片增删/排序后复用 socket、回写 slot、
// POST /prompt_helper/outputs 同步类 RETURN_TYPES/RETURN_NAMES。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  NODE_TYPES, registerNode, unregisterNode, nodeTypeOf,
  configWidget, writeConfig, readConfig, installResizeHandles, makeDomWidgetHitThrough, uiConfirm, TYPE_ICONS, makeAudioPlayer,
} from "./ezflex_service.js";

const NODE = NODE_TYPES.PROMPT_HELPER;
const OUT_API = "/prompt_helper/outputs";
const MAX_CARDS = 32;
const MAX_MEDIA = 16;
const MEDIA_PORT_COLOR = '#d94848';

// ===== 分层弹出的关闭协调：点击外层才关一层；拖动·松开不关 =====
const _phLayers = [];
let _phClosedEl = null;
let _phDownOpen = new Set();
function phLayerPush(el) { if (el && !_phLayers.includes(el)) _phLayers.push(el); }
let _phDown = { x: 0, y: 0 };
document.addEventListener('pointerdown', (e) => { _phDown.x = e.clientX; _phDown.y = e.clientY; _phClosedEl = null; _phDownOpen = new Set(_phLayers); }, true);
document.addEventListener('pointerup', (e) => {
  if (Math.max(Math.abs(e.clientX - _phDown.x), Math.abs(e.clientY - _phDown.y)) > 6) return;   // 拖动松开不关
  const t = e.target;
  for (let i = _phLayers.length - 1; i >= 0; i--) {
    const el = _phLayers[i];
    if (!_phDownOpen.has(el)) continue;                     // 本次刚打开的层（点开关按钮）不立刻关
    const open = el && el.classList && (el.classList.contains('active') || el.classList.contains('open'));
    if (!el || !el.isConnected) { _phLayers.splice(i, 1); continue; }
    if (!open) { _phLayers.splice(i, 1); continue; }
    if (el.contains(t) && t !== el) break;               // 点在层内内容 → 保留这一层及以下
    el.classList.remove('active'); el.classList.remove('open'); _phLayers.splice(i, 1); _phClosedEl = el; break;   // 只关最上面这一层
  }
}, true);
let _phWatchStarted = false;
function phLayerWatch() {
  if (_phWatchStarted) return; _phWatchStarted = true;
  const ob = new MutationObserver((muts) => {
    muts.forEach((m) => { const el = m.target; if (!el || el.nodeType !== 1) return; if (!/(^|\s)eph-/.test(el.className || '')) return; const open = el.classList.contains('active') || el.classList.contains('open'); if (open) { if (!_phLayers.includes(el)) _phLayers.push(el); } else { const i = _phLayers.indexOf(el); if (i >= 0) _phLayers.splice(i, 1); } });
  });
  ob.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
}
phLayerWatch();

const CSS = `
.eph-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.eph-shell .eph-root{pointer-events:auto;}
.eph-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:#1a1a2e;background:#fff;border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.eph-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.eph-hd{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
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
.eph-card{display:flex;align-items:center;gap:10px;background:#fbfcfe;border:1px solid #eef2f8;border-radius:10px;padding:9px 10px;flex-wrap:nowrap;}
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

/* 卡片：样式化标题 + 链接后变灰 */
.eph-ctitle{flex:0 0 30%;min-width:0;display:inline-flex;align-items:center;gap:6px;max-width:30%;}
.eph-ctitle-input{display:inline-block;min-width:24px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:none;border-radius:8px;background:transparent;font:600 12px Inter,sans-serif;color:#1a1f2b;outline:none;padding:2px 4px;cursor:text;text-align:left;flex:1 1 auto;min-width:0;}
.eph-ctitle-input:empty::before{content:attr(data-ph);color:#c4cdda;}  /* 空标题占位 */
.eph-badge{font-size:9px;font-weight:480;color:#fff;background:#5f6b7a;padding:0 6px;border-radius:100px;line-height:15px;white-space:nowrap;flex:0 0 auto;}
.eph-preview{flex:1 1 auto;min-width:0;font-size:11px;color:#8a9aa8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;}
.eph-card.linked{opacity:.55;background:#f3f5f9;border-color:#e2e8f0;}
.eph-card.linked .eph-title{opacity:.5;}

/* 黑框 socket 标签（仿 ModelsCombo installOutsideLabels） */
.eph-socket-label{position:fixed;z-index:40;pointer-events:none;background:rgba(16,22,32,.5);color:#e8eef6;font-size:9px;line-height:1;padding:2px 6px;border-radius:3px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;user-select:none;display:inline-flex;align-items:center;box-shadow:0 1px 4px rgba(0,0,0,.25);}
.eph-socket-label .eph-socket-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;margin-right:5px;border:1px solid rgba(255,255,255,.35);}

/* 编辑器弹窗 */
.eph-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:99999;background:rgba(0,0,0,.35);}
.eph-modal.active{display:flex;}
.eph-modal-box{background:#fff;border-radius:14px;padding:0 0 12px;width:92%;max-width:760px;max-height:88vh;display:flex;flex-direction:column;gap:0;box-shadow:0 24px 80px rgba(0,0,0,.22);font-family:Inter,sans-serif;box-sizing:border-box;}
.eph-modal-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #edf2f8;}
.eph-modal-hd b{font-size:14px;color:#0f141f;}
.eph-modal-close{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:3px 11px;font-size:13px;cursor:pointer;font-family:inherit;color:#5f6b7a;}
.eph-modal-close:hover{background:#edf2fa;}
.eph-modal-body{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;overflow:auto;padding:10px 14px;}
.eph-modal-ft{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 16px 0;border-top:1px solid #edf2f8;}
.eph-btn-cancel{background:#f1f4fa;border:1px solid #e2e8f0;color:#4d5b6d;}
.eph-btn-save{background:#1a1a2e;border:1px solid #1a1a2e;color:#fff;}

/* 编辑器工具条 */
.eph-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px;background:#f8fafc;border-bottom:1px solid #e6edf7;}
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
.eph-indent-group{display:flex;align-items:center;gap:6px;}
.eph-indent-group label{font-size:11px;color:#5f6b7a;}
.eph-indent-input{width:52px;text-align:center;border:1px solid #dce3ec;border-radius:7px;padding:3px 6px;font-size:12px;font-family:inherit;outline:none;height:26px;}
.eph-tabs{position:relative;display:flex;gap:2px;background:#f1f4fa;border-radius:999px;padding:3px;margin:0 0 6px;}
.eph-tabs-thumb{position:absolute;top:3px;bottom:3px;left:0;width:0;border-radius:999px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.14);border:1px solid #eef2f8;transition:left .28s cubic-bezier(.4,0,.2,1),width .28s cubic-bezier(.4,0,.2,1);z-index:0;}
.eph-tab{position:relative;z-index:1;flex:1 1 50%;padding:6px 12px;font-size:12px;font-weight:500;color:#5f6b7a;cursor:pointer;background:transparent;border:none;border-radius:999px;transition:color .2s;font-family:inherit;}
.eph-tab:hover{color:#1a1f2b;}
.eph-tab.active{color:#1a1a2e;font-weight:600;}
.eph-editor{min-height:200px;max-height:46vh;border:1px solid #dce3ec;border-radius:10px;padding:12px;outline:none;line-height:1.7;color:#1a1a2e;background:#fff;overflow:auto;font-size:14px;}
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

/* 调用设置弹窗 */
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
/* 调用设置下拉（图三风格：白底圆角列表 + 滚动条）*/
.eph-dd{width:100%;position:relative;}
.eph-dd-trigger{display:flex;align-items:center;justify-content:space-between;width:100%;box-sizing:border-box;font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:6px 9px;background:#fff;color:#1a1f2b;cursor:pointer;outline:none;}
.eph-dd-trigger:hover{border-color:#b7c1cf;}
.eph-dd-input{padding-right:26px;}
.eph-dd-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eph-dd-arrow{flex:0 0 auto;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #94a3b8;margin-left:6px;}
.eph-dd-menu{position:fixed;z-index:100020;background:#fff;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.16);max-height:220px;overflow-y:auto;padding:4px;display:none;}
.eph-dd-menu.active{display:block;}
.eph-dd-item{display:block;width:100%;text-align:left;padding:7px 10px;border:none;background:transparent;border-radius:7px;font-size:12px;color:#1a1f2b;cursor:pointer;font-family:inherit;}
.eph-dd-item:hover{background:#f1f4fa;}
.eph-dd-item.active{background:#1a1a2e;color:#fff;}
.eph-dd-empty{font-size:12px;color:#94a3b8;padding:8px 10px;text-align:center;}
.eph-login-btn{display:inline-flex;align-items:center;gap:6px;background:#1a1a2e;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-family:inherit;cursor:pointer;font-weight:500;}
.eph-login-btn:hover{background:#2d2d4a;}
.eph-settings-note{font-size:10px;color:#94a3b8;line-height:1.4;padding:0 12px 10px;}
.eph-settings-nav-btn:hover{background:#f1f4fa;}
.eph-settings-nav-btn.active{background:#1a1a2e;color:#fff;}
.eph-settings-pane .eph-settings-grid{display:none;}
.eph-settings-pane .eph-settings-grid.active{display:grid;}
/* 去掉数字输入框的上下箭头 */
.eph-settings-grid input[type=number]{appearance:textfield;-moz-appearance:textfield;}
.eph-settings-grid input[type=number]::-webkit-outer-spin-button,
.eph-settings-grid input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}

/* 总体编辑弹窗 */
.eph-all{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100004;background:rgba(0,0,0,.35);}
.eph-all.active{display:flex;}
.eph-all-box{background:#fff;border-radius:16px;width:96%;max-width:1080px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 26px 80px rgba(0,0,0,.28);font-family:Inter,sans-serif;box-sizing:border-box;}
.eph-all-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #edf2f8;}
.eph-all-hd b{font-size:14px;color:#0f141f;}
.eph-btn.skill-on{background:#d9f2e4;border-color:#b7e5c9;color:#15803d;}
.eph-all-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 16px;border-bottom:1px solid #edf2f8;background:#fbfcfe;}
.eph-all-toolbar label{display:flex;align-items:center;gap:4px;font-size:11px;color:#5f6b7a;}
.eph-all-toolbar input[type=color]{width:26px;height:26px;border:1px solid #dce3ec;border-radius:7px;padding:2px;background:#fff;cursor:pointer;}
.eph-all-editor{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 16px;outline:none;line-height:1.7;color:#1a1a2e;font-size:14px;}
.eph-all-block{padding:4px 0 10px;}
.eph-all-block-hd{display:flex;align-items:center;gap:8px;font-size:11px;color:#9aa7b5;padding:6px 8px;border-radius:8px;margin-bottom:6px;background:#f4f6fa;}
.eph-all.collapsed .eph-all-block-hd{display:none;}
.eph-all-num{font-weight:700;color:#8a99ae;flex:0 0 auto;}
.eph-all-title{flex:0 0 150px;min-width:0;width:150px;font-weight:600;color:#2b3448;cursor:text;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:22px;height:22px;padding:0 6px;border:1px solid #dce3ec;border-radius:6px;background:#fff;outline:none;text-align:left;}
.eph-all-title:focus{border-color:#8a99ae;}
.eph-all-title:empty::before{content:attr(data-ph);color:#a5b1c0;}
.eph-all-time{flex:0 0 auto;display:inline-flex;align-items:center;gap:2px;font-size:10px;color:#9aa7b5;}
.eph-all-ts{width:34px;height:22px;border:1px solid #dce3ec;border-radius:6px;background:#fff;font-size:11px;line-height:20px;text-align:center;outline:none;color:#5f6b7a;padding:0;box-shadow:none;}
.eph-all-tspreview{color:#2563eb;font-size:10px;margin-left:4px;white-space:nowrap;}
.eph-all-del{margin-left:auto;background:transparent;border:none;color:#b7c1cf;font-size:14px;line-height:1;cursor:pointer;padding:1px 4px;}
.eph-all-del:hover{color:#e34d4d;background:#fdecec;border-radius:6px;}
.eph-all-block-body{outline:none;min-height:60px;background:transparent;}
.eph-all-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:16px;}
.eph-all-ft{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid #edf2f8;}

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
.eph-tools-sep{font-size:10px;color:#94a3b8;padding:8px 10px 2px;letter-spacing:.5px;font-weight:500;}
.ph-mref-item{display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eph-rp{position:fixed;z-index:100040;background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.2);padding:8px;width:240px;box-sizing:border-box;font-family:Inter,sans-serif;}
.eph-rp-media{display:block;width:100%;max-height:180px;border-radius:6px;object-fit:contain;background:#000;}
.eph-rp-cap{font-size:10px;color:#5f6b7a;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eph-mv{position:fixed;inset:0;z-index:100050;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);}
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

/* skill 设置弹窗（文件夹树） */
.eph-skb{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100005;background:rgba(0,0,0,.35);}
.eph-skb.active{display:flex;}
.eph-skb-box{background:#fff;border-radius:16px;width:92%;max-width:560px;max-height:70vh;display:flex;flex-direction:column;box-shadow:0 26px 80px rgba(0,0,0,.28);overflow:hidden;font-family:Inter,sans-serif;box-sizing:border-box;}
.eph-skb-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #edf2f8;}
.eph-skb-hd b{font-size:14px;color:#0f141f;}
.eph-skb-sideroot{flex:1 1 auto;min-height:0;display:flex;}
.eph-skb-tree{flex:0 0 190px;min-width:0;overflow:auto;padding:8px;border-right:1px solid #eef2f8;display:flex;flex-direction:column;gap:3px;}
.eph-skb-dir{text-align:left;padding:7px 9px;border:1px solid #eef2f8;border-radius:8px;font-size:12px;color:#1a1f2b;background:#fff;cursor:pointer;font-family:inherit;word-break:break-all;}
.eph-skb-dir:hover{border-color:#dce3ec;background:#f7f9fd;}
.eph-skb-dir.on{background:#1a1a2e;color:#fff;border-color:#1a1a2e;}
.eph-skb-main{flex:1 1 auto;min-width:0;overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:5px;}
.eph-skb-maint{font-size:11px;color:#5f6b7a;font-weight:600;padding-bottom:4px;border-bottom:1px solid #eef2f8;margin-bottom:4px;}
.eph-skb-card{text-align:left;padding:7px 10px;border:1px solid #eef2f8;border-radius:8px;font-size:12px;color:#1a1f2b;background:#fff;cursor:pointer;font-family:inherit;}
.eph-skb-card:hover{border-color:#dce3ec;background:#f7f9fd;}
.eph-skb-card.on{background:#1a1a2e;color:#fff;border-color:#1a1a2e;}
.eph-skb-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:16px;}

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

/* 规则弹窗 */
.eph-rules{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100002;background:rgba(0,0,0,.3);}
.eph-rules.active{display:flex;}
.eph-rules-box{background:#fff;border-radius:16px;width:640px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.2);overflow:hidden;}
.eph-rules-hd{display:flex;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e6edf7;}
.eph-rules-body{padding:14px 20px;overflow-y:auto;}
.eph-rule-sel{display:flex;flex-direction:column;gap:6px;margin-bottom:14px;}
.eph-rule-sel>span{font-size:12px;color:#1a1a2e;font-weight:600;}
.eph-rule-note{font-size:11px;color:#5f6b7a;background:#f2f5fa;border-radius:8px;padding:8px 10px;line-height:1.6;}
.eph-rule-custom{display:flex;flex-direction:column;gap:6px;margin-top:6px;}
.eph-rule-custom>span{font-size:12px;color:#1a1a2e;font-weight:600;}
.eph-rule-custom input{font-family:inherit;font-size:12px;border:1px solid #dce3ec;border-radius:8px;padding:6px 9px;outline:none;background:#fff;color:#1a1f2b;box-sizing:border-box;width:100%;}
.eph-rules-body .eph-btn-save{margin-top:10px;}
.eph-rule-sec{margin-bottom:16px;}
.eph-rule-title{font-weight:700;font-size:14px;margin-bottom:8px;color:#1a1a2e;}
.eph-rule-card{background:#f7f9fd;border-radius:8px;padding:10px;margin-bottom:6px;border-left:4px solid #3b82f6;}
.eph-rule-card strong{display:block;margin-bottom:3px;color:#1a1a2e;}
.eph-rule-card p{font-size:12px;color:#5f6b7a;line-height:1.5;}
.eph-rule-card code{background:#e2e8f0;padding:1px 3px;border-radius:4px;font-family:monospace;}
`;

let _styleInjected = false;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
function genId() { return 'ph_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
function deepClone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return Array.isArray(o) ? [] : {}; } }
function plainTextOf(html) { const d = document.createElement('div'); d.innerHTML = html || ''; return (d.textContent || '').trim(); }
const fetchApi = (p, o) => (api && typeof api.fetchApi === 'function') ? api.fetchApi(p, o) : fetch(p, o);

// Word 同款对齐图标（横线表示对齐方式）
function alignSVG(type) {
  const widths = type === 'justify' ? [16, 16, 16, 16] : [16, 16, 10, 7];
  const xof = (w) => (type === 'left' ? 0 : type === 'center' ? (16 - w) / 2 : 16 - w);
  const rects = widths.map((w, i) => `<rect x="${xof(w)}" y="${2 + i * 4}" width="${w}" height="2" rx="1" fill="currentColor"/>`).join('');
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">${rects}</svg>`;
}

function stateFor(node) {
  if (!node._ezPh) node._ezPh = { cards: [], optimize: {}, rules: {}, editingId: null, currentTab: 'default', dirty: false };
  return node._ezPh;
}
function loadFromConfig(node) {
  const st = stateFor(node);
  const cfg = readConfig(node, {});
  st.cards = Array.isArray(cfg.cards) ? deepClone(cfg.cards) : [];
  st.optimize = (cfg.optimize && typeof cfg.optimize === 'object') ? deepClone(cfg.optimize) : {};
  st.rules = (cfg.rules && typeof cfg.rules === 'object') ? deepClone(cfg.rules) : {};
  st.dirty = false;
}
function syncToConfig(node) {
  const st = stateFor(node);
  writeConfig(node, { optimize: st.optimize || {}, cards: st.cards, rules: st.rules || {} });
  markDirtyFalse(node);
}
function markDirtyFalse(node) { /* kept for clarity; no untracked dirty on config write */ }

// ===== 卡片操作 =====
function addCard(node) {
  const st = stateFor(node);
  st.cards.push({
    id: genId(), title: `第${st.cards.length + 1}幕`,
    content: '', contentHTML: '', contentOptimized: '', contentOptimizedHTML: '',
    timelineStart: '', timelineEnd: '', skill: '', modelType: 'text', model: '', provider: '', apiUrl: '', indent: 0, useOptimized: false,
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

// ===== 动态端口（输入 card_in_1..N / 输出 合并提示词 + card_out_1..N）=====
function syncOutputTypes(count) {
  try { fetchApi(OUT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: count || 0 }) }).catch(() => {}); } catch (_) {}
}
function removeConfigInput(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && _in.name === 'config') { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}
}
function deferSync(node) {
  if (node._ezPhSyncTimer) clearTimeout(node._ezPhSyncTimer);
  node._ezPhSyncTimer = setTimeout(() => { node._ezPhSyncTimer = null; try { updatePorts(node); refreshUI(node); } catch (_) {} }, 120);
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

  // 链路未恢复守卫：先不动 socket，延后再重排/删槽（否则保存的 target_slot/origin_slot 接不回去）
  const pending = (node.inputs || []).some((i) => i.link != null && !(node.graph && node.graph.links && node.graph.links[i.link]))
    || (node.outputs || []).some((o) => linksOf(o).some((lid) => lid != null && !(node.graph && node.graph.links && node.graph.links[lid])));
  if (pending) { deferSync(node); return false; }

  // ---- 输入：综合媒体动态（红色 ANY，连接后自动补一个空槽）+ 卡片输入按序（clip 输入口已移除，TextGenerate 走调用设置配置）----

  // 综合媒体：任意类型(ANY)红色端口，可接 图像/视频/音频/3D 模型等。已连接的媒体端口数 + 1 个空槽。
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
      const lab = `综合媒体 ${mi + 1}`;
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
    try { sock.label = ''; sock.hideName = true; sock.hidden = false; sock._ezLabel = (card.title || `提示词 ${idx + 1}`); } catch (_) {}
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
  if (!mergedSock && (node.outputs || [])[0] && (node.outputs || [])[0].name === '合并提示词') {
    mergedSock = (node.outputs || [])[0]; mergedSock._ezMerged = true;
  }
  if (!mergedSock) { node.addOutput('合并提示词', 'STRING', {}); mergedSock = node.outputs[node.outputs.length - 1]; mergedSock._ezMerged = true; }
  try { mergedSock.label = ''; mergedSock.hideName = true; mergedSock.hidden = false; mergedSock._ezLabel = '合并提示词'; } catch (_) {}
  if (mergedSock.color_on !== '#d94848') { mergedSock.color_on = '#d94848'; mergedSock.color_off = '#d94848'; mergedSock.color = '#d94848'; }

  const oldOuts = (node.outputs || []).filter((o) => o !== mergedSock);
  const usedOut = new Set();
  const outSeq = [];
  st.cards.forEach((card, idx) => {
    let sock = oldOuts.find((o, i) => !usedOut.has(i) && o._ezCardId != null && String(o._ezCardId) === String(card.id));
    if (!sock) sock = oldOuts.find((o, i) => !usedOut.has(i));
    if (!sock) { node.addOutput(`卡片 ${idx + 1}`, 'STRING', {}); sock = node.outputs[node.outputs.length - 1]; }
    const oi = oldOuts.indexOf(sock);
    if (oi >= 0) usedOut.add(oi);
    if (sock._ezCardId !== card.id) sock._ezCardId = card.id;
    if (sock.name !== `卡片 ${idx + 1}`) sock.name = `卡片 ${idx + 1}`;
    try { sock.label = ''; sock.hideName = true; sock.hidden = false; sock._ezLabel = (card.title || `卡片 ${idx + 1}`); } catch (_) {}
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
  syncOutputTypes(count);
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

function buildCardRow(node, card, index) {
  const linked = !!(node._ezLinkedCards && node._ezLinkedCards[card.id]);
  const row = el('div', 'eph-card' + (linked ? ' linked' : '')); row.dataset.id = card.id;
  const handle = el('span', 'eph-handle'); handle.textContent = '⠿';
  const idx = el('span', 'eph-index'); idx.textContent = String(index + 1);
  const ctitle = el('div', 'eph-ctitle');
  const title = el('span', 'eph-ctitle-input'); title.contentEditable = 'true'; title.setAttribute('data-ph', '标题'); title.title = '卡片标题';
  title.textContent = card.title || '';
  // 输入即更新（实时刷新黑框标签文字，类似 ModelsCombo）；失焦再重排/刷新列表。
  title.addEventListener('input', () => { card.title = title.textContent.replace(/\u200b/g, ''); syncToConfig(node); updateSocketLabels(node, card.id, card.title || '提示词'); });
  title.addEventListener('blur', () => { card.title = title.textContent.replace(/\u200b/g, ''); syncToConfig(node); updatePorts(node); refreshUI(node); });
  ctitle.appendChild(title);
  let badge = null;
  const prov = (card.provider || card.apiUrl) ? (card.provider || 'API') : '';
  if (prov) { badge = el('span', 'eph-badge'); badge.textContent = prov; badge.title = [card.provider, card.model, card.apiUrl].filter(Boolean).join(' · '); }
  if (badge) ctitle.appendChild(badge);
  const preview = el('span', 'eph-preview'); preview.textContent = card.content || '';
  const time = el('span', 'eph-time'); time.textContent = (card.timelineStart && card.timelineEnd) ? `${card.timelineStart}-${card.timelineEnd}s` : '';
  const del = el('button', 'eph-del'); del.textContent = '×'; del.title = '删除卡片';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (await uiConfirm(`确定删除提示词卡片「${card.title || ''}」吗？`)) deleteCard(node, card.id);
  });
  // 只有「单点」卡片（无拖动位移）才打开编辑弹窗，避免在标题里拖动误触。
  let _rowDown = null;
  row.addEventListener('pointerdown', (e) => { _rowDown = { x: e.clientX, y: e.clientY }; });
  row.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('.eph-handle') || e.target.closest('[contenteditable]')) return;
    if (_rowDown) { const dx = e.clientX - _rowDown.x, dy = e.clientY - _rowDown.y; if (Math.hypot(dx, dy) > 4) { _rowDown = null; return; } _rowDown = null; }
    openEditModal(node, card.id);
  });
  row.appendChild(handle); row.appendChild(idx); row.appendChild(ctitle); row.appendChild(preview); row.appendChild(time); row.appendChild(del);
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
  if (!st.cards.length) { const e = el('div', 'eph-empty'); e.textContent = '暂无提示词卡片，点「＋ 新增提示词卡片」添加'; list.appendChild(e); return; }
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
function editModalEl() {
  if (_editModal && _editModal.parentNode) return _editModal;
  _editModal = el('div', 'eph-modal');
  const box = el('div', 'eph-modal-box');
  const hd = el('div', 'eph-modal-hd');
  const t = el('b'); t.textContent = '编辑提示词';
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  hd.appendChild(t); hd.appendChild(close);
  // 工具条
  const toolbar = el('div', 'eph-toolbar');
  const tb = (cls, title, cmd, inner) => { const b = el('button', 'eph-tb-btn ' + (cls || '')); b.title = title; b.dataset.cmd = cmd; b.innerHTML = inner; toolbar.appendChild(b); return b; };
  tb('word-glyph bold-glyph', '加粗', 'bold', '<span>B</span>');
  tb('word-glyph italic-glyph', '斜体', 'italic', '<span>I</span>');
  tb('word-glyph underline-glyph', '下划线', 'underline', '<span>U</span>');
  tb('word-glyph strike-glyph', '删除线', 'strikeThrough', '<span>S</span>');
  tb('', '左对齐', 'justifyLeft', alignSVG('left'));
  tb('', '居中对齐', 'justifyCenter', alignSVG('center'));
  tb('', '右对齐', 'justifyRight', alignSVG('right'));
  tb('', '两端对齐', 'justifyFull', alignSVG('justify'));

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
  indentGroup.appendChild(el('label')).textContent = '缩进';
  const indentInput = el('input', 'eph-indent-input'); indentInput.value = '0'; indentInput.title = '首行缩进量（em，对每段首行生效）';
  indentGroup.appendChild(indentInput);
  toolbar.appendChild(indentGroup);

  const toolsGroup = el('div', 'eph-tb-group');
  const toolsBtn = el('button', 'eph-btn'); toolsBtn.textContent = '工具';
  const toolsDD = el('div', 'eph-tools-dropdown');
  toolsGroup.appendChild(toolsBtn); toolsGroup.appendChild(toolsDD);
  toolbar.appendChild(toolsGroup);

  const refGroup = el('div', 'eph-tb-group');
  const refBtn = el('button', 'eph-btn'); refBtn.textContent = '插入引用';
  const refDD = el('div', 'eph-tools-dropdown');
  refGroup.appendChild(refBtn); refGroup.appendChild(refDD);
  toolbar.appendChild(refGroup);

  const tabDefault = el('button', 'eph-tab active'); tabDefault.textContent = '默认提示词';
  const tabOptimized = el('button', 'eph-tab'); tabOptimized.textContent = '优化提示词';

  const body = el('div', 'eph-modal-body');
  body.appendChild(toolbar);
  const tabThumb = el('span', 'eph-tabs-thumb');
  const editorWrap = el('div', 'eph-tabs');
  editorWrap.appendChild(tabThumb);
  editorWrap.appendChild(tabDefault); editorWrap.appendChild(tabOptimized);
  body.appendChild(editorWrap);
  const editor = el('div', 'eph-editor'); editor.contentEditable = 'true';
  attachMention(editor, () => _editModal._node);
  body.appendChild(editor);

  const ft = el('div', 'eph-modal-ft');
  const timeline = el('div', 'eph-timeline');
  const tsLabel = el('span'); tsLabel.textContent = '时间轴';
  const tsStart = el('input');
  const tsDash = el('span'); tsDash.textContent = '—';
  const tsEnd = el('input');
  const tsUnit = el('span'); tsUnit.textContent = 's';
  const tsPreview = el('span', 'eph-all-tspreview');
  const updTsPreview = () => { const nd = _editModal && _editModal._node; const rules = nd ? phRulesModel(nd) : {}; tsPreview.textContent = formatTimeText(rules.tsModel, tsStart.value, tsEnd.value); };
  [tsStart, tsEnd].forEach((inp) => inp.addEventListener('input', updTsPreview));
  timeline.appendChild(tsLabel); timeline.appendChild(tsStart); timeline.appendChild(tsDash); timeline.appendChild(tsEnd); timeline.appendChild(tsUnit); timeline.appendChild(tsPreview);
  _editModal._tsPreview = tsPreview; _editModal._updTsPreview = updTsPreview;
  ft.appendChild(timeline);
  const cancelBtn = el('button', 'eph-btn eph-btn-cancel'); cancelBtn.textContent = '取消';
  const saveBtn = el('button', 'eph-btn eph-btn-save'); saveBtn.textContent = '保存';
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
  refBtn.addEventListener('click', (e) => { e.stopPropagation(); refDD.classList.toggle('active'); if (refDD.classList.contains('active')) { phFixedDD(refBtn, refDD); addMediaFileItems(refDD, editor, (_m) => insertMediaRef(editor, _m), _editModal._node); } });

  // 颜色下拉 / 工具下拉 / 引用下拉
  initColorDropdown(hlDD, 'highlight');
  initColorDropdown(fcDD, 'font');
  const toolsItems = [['查找替换', 'find'], ['全角符号转半角', 'fullToHalf'], ['半角符号转全角', 'halfToFull'],
    ['优化提示词 (API)', 'optimize'], ['优化提示词 (TextGenerate)', 'textgen'], ['优化提示词 (llama)', 'llama']];
  toolsItems.forEach(([label, id]) => {
    const b = el('button', 'eph-tool-item'); b.textContent = label;
    b.addEventListener('click', () => { toolsDD.classList.remove('active'); if (id === 'find') openFindModal('find', _editModal && _editModal._editor); else runTool(id); });
    toolsDD.appendChild(b);
  });
  // 插入引用：扫描节点已连接的「综合媒体」输入端口（编辑期仅能列出端口/标签，预览需运行期拿到媒体值）。
  addMediaFileItems(refDD, editor, (_m) => insertMediaRef(editor, _m), _editModal._node);

  _editModal._box = box; _editModal._editor = editor; _editModal._tabDefault = tabDefault; _editModal._tabOptimized = tabOptimized; _editModal._tabThumb = tabThumb;
  _editModal._fontInput = fontInput; _editModal._fontList = fontList; _editModal._indentInput = indentInput; _editModal._tsStart = tsStart; _editModal._tsEnd = tsEnd;
  _editModal._hlDD = hlDD; _editModal._fcDD = fcDD; _editModal._toolsDD = toolsDD; _editModal._refDD = refDD;
  [fontList, hlDD, fcDD, toolsDD, refDD].forEach((el) => { if (el && el.classList.contains('active')) phLayerPush(el); });
  editor.addEventListener('keyup', saveSelection);
  editor.addEventListener('mouseup', saveSelection);
  // 点击弹窗外（backdrop）→ 关闭并保存；卡片内部拖动到外面松开不关闭（避免误关）。
  let _ecStartInBox = false;
  _editModal.addEventListener('mousedown', (e) => { _ecStartInBox = box.contains(e.target); });
  _editModal.addEventListener('mouseup', (e) => { if (e.target === _editModal && !_ecStartInBox && (_phClosedEl === null || _phClosedEl === _editModal)) closeEditModal(true); _ecStartInBox = false; });
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
  if (tab === 'optimized') {
    m._tabOptimized.classList.add('active'); m._tabDefault.classList.remove('active');
    m._editor.innerHTML = card.contentOptimizedHTML || card.contentOptimized || '';
  } else {
    m._tabDefault.classList.add('active'); m._tabOptimized.classList.remove('active');
    m._editor.innerHTML = card.contentHTML || card.content || '';
  }
  m._tsStart.value = card.timelineStart || ''; m._tsEnd.value = card.timelineEnd || '';
  if (m._updTsPreview) m._updTsPreview();
  m._indentInput.value = String(card.indent || 0);
  m.classList.add('active');
  _phActiveEditor = m._editor;
  requestAnimationFrame(moveTabThumb);
  setTimeout(() => { try { applyIndent(m._indentInput.value); m._editor.focus(); } catch (_) {} }, 100);
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
  if (tab === 'default') {
    _editModal._tabDefault.classList.add('active'); _editModal._tabOptimized.classList.remove('active');
    _editModal._editor.innerHTML = card.contentHTML || card.content || '';
  } else {
    _editModal._tabOptimized.classList.add('active'); _editModal._tabDefault.classList.remove('active');
    _editModal._editor.innerHTML = card.contentOptimizedHTML || card.contentOptimized || '';
  }
  requestAnimationFrame(moveTabThumb);
  try { applyIndent(_editModal._indentInput.value); } catch (_) {}
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
      card.timelineStart = _editModal._tsStart.value.trim();
      card.timelineEnd = _editModal._tsEnd.value.trim();
      card.indent = parseFloat(_editModal._indentInput.value) || 0;
      syncToConfig(nd); updatePorts(nd); refreshUI(nd);
    }
    st.editingId = null;
  }
  _phActiveEditor = null;
  _editModal && _editModal.classList.remove('active');
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
function nodeOfEditModal() { return (_editModal && _editModal._node && _editModal._node instanceof Object) ? _editModal._node : null; }
function execCmd(cmd, val = null) { const ed = _editModal && _editModal._editor; if (ed) { ed.focus(); document.execCommand(cmd, false, val); saveSelection(); } }
function populateFontList(list) {
  if (!list || list._populated) return; list._populated = true;
  const sizeMap = { 初号: '48px', 小初: '36px', 一号: '26pt', 小一: '24pt', 二号: '22pt', 小二: '18pt', 三号: '16pt', 小三: '15pt', 四号: '14pt', 小四: '12pt', 五号: '10.5pt', 小五: '9pt' };
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
  // 首行缩进（Word 式）：对每个「回车产生的段落块」设 text-indent，首行缩进、换行不缩进。
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
// 把 contenteditable 编辑器内容切成「段落」数组（每段 = 一组顶部节点）。
// 段 = 块元素 DIV/P/LI；回车产生的块元素与裸文本 \n 作为段落分隔；<br> 是段内软换行（留在段内，不缩进）。
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
      else cur.push(node); // 内联元素整体并入当前段（含 <br> 软换行）
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
  // —— 清除高亮：有选中只清选中；没选中清整块（所有卡片正文） ——
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
  // —— 上色：有选中只包选中；没选中则整块（卡片编辑器整块 / 总体编辑每张卡片正文） ——
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
    // 只把半角标点转全角，不碰字母/数字/文字/空格。
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
  const title = el('span', 'eph-prog-title'); title.textContent = '调用中…';
  const count = el('span', 'eph-prog-count'); count.textContent = '';
  const close = el('button', 'eph-prog-close'); close.textContent = '✕'; close.title = '关闭进度';
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
  m._title.textContent = (method ? method + ' · ' : '') + '优化中';
  m._count.textContent = m._total > 1 ? ('0/' + m._total) : '';
  m._fill.style.width = '0%';
  m._fill.className = 'eph-prog-fill' + (m._total > 1 ? '' : ' indeterminate');
  m._detail.innerHTML = '';
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
  m._title.textContent = '调用失败';
  m._fill.style.width = '100%'; m._fill.className = 'eph-prog-fill'; m._fill.style.background = '#e34d4d';
  const line = el('div', 'eph-prog-line err'); line.textContent = '✕ ' + msg; m._detail.appendChild(line);
}
function phProgDone(node) {
  const m = phProgEl(node);
  m._fill.className = 'eph-prog-fill'; m._fill.style.width = '100%';
  if (m._total > 1) { m._count.textContent = m._total + '/' + m._total; }
  m._title.textContent = '完成';
  setTimeout(() => phProgHide(), 1200);
}
function phProgHide() { if (_phProg) { _phProg.classList.remove('active'); _phProg.classList.remove('open'); } }
function phProgToggle(node) {
  const m = phProgEl(node);
  phProgPos(node);
  if (m.classList.contains('active')) { m.classList.toggle('open'); return; }
  m._title.textContent = '暂无进行中的优化'; m._count.textContent = '';
  m._fill.style.width = '0%'; m._fill.className = 'eph-prog-fill';
  m._detail.innerHTML = '';
  m.classList.add('active'); m.classList.remove('open');
}
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
// ===== 媒体引用：扫描画布媒体文件 + 下拉悬停预览 + 点击查看 =====
let _MEDIA_CACHE = null;
async function loadMediaFiles() {
  if (_MEDIA_CACHE && _MEDIA_CACHE.length) return _MEDIA_CACHE;
  try { const r = await fetchApi('/prompt_helper/media_files'); const d = await r.json().catch(() => ({})); _MEDIA_CACHE = d.media || []; } catch (_) { _MEDIA_CACHE = []; }
  return _MEDIA_CACHE;
}
// 读取 EzFlex-MediaLoader / EzFlex-MediaOut 节点里的素材文件（供 @ 媒体提及）。
function ezMediaFilesOfNode(n, g) {
  const out = [];
  const pushFile = (f) => {
    if (f && f.path) {
      const typ = (f.type || 'other') === 'model_3d' ? 'model' : (f.type || 'other');
      const url = f.url || ('/view?type=input&filename=' + encodeURIComponent(f.name || '') + (f.subfolder ? '&subfolder=' + encodeURIComponent(f.subfolder) : ''));
      out.push({ name: f.name || '', path: f.path, type: typ, url });
    }
  };
  const parseCfg = (origin) => {
    let cfg = {};
    try { const w = (origin && origin.widgets || []).find((x) => x.name === 'config'); cfg = JSON.parse(w ? (w.value || '{}') : '{}') || {}; } catch (_) { cfg = {}; }
    return cfg;
  };
  try {
    if (n && n.type === 'EzFlex-MediaLoader') {
      const cfg = parseCfg(n);
      (cfg.groups || []).forEach((gr) => (gr.cards || []).forEach((c) => (c.items || []).forEach((it) => (it.files || []).forEach(pushFile))));
      return out;
    }
    if (n && n.type === 'EzFlex-MediaOut') {
      const inp = (n.inputs || [])[0];
      if (!inp || inp.link == null) return [];
      const link = (g.links || {})[inp.link];
      if (!link || link.origin_id == null) return [];
      const origin = ((g._nodes || g.nodes) || []).find((x) => x && x.id === link.origin_id);
      if (!origin || origin.type !== 'EzFlex-MediaLoader') return [];
      const slot = link.origin_slot;
      const sock = (origin.outputs || [])[slot];
      let cardId = sock && sock._ezCardId;
      const cfg = parseCfg(origin);
      if (cardId == null) { const order = []; (cfg.groups || []).forEach((gr) => (gr.cards || []).forEach((c) => order.push(c))); const c = order[slot]; if (c) cardId = c.id; }
      let card = null;
      (cfg.groups || []).forEach((gr) => (gr.cards || []).forEach((c) => { if (String(c.id) === String(cardId)) card = c; }));
      if (!card) return [];
      (card.items || []).forEach((it) => (it.files || []).forEach(pushFile));
    }
  } catch (_) {}
  return out;
}
// 读取「当前工作流画布」里加载了媒体的节点（Load Image / 视频 / 音频 等）对应的文件，只列出本工作流用到的媒体。
function graphMediaFiles(node) {
  try {
    const g = node && node.graph;
    if (!g) return [];
    const all = [];
    const pushNodes = (arr) => { (arr || []).forEach((n) => { if (n) all.push(n); }); };
    pushNodes(g._nodes || g.nodes);
    // 额外把本节点「综合媒体」输入连到的上游节点也纳入（这才是当前画布真正用到的媒体）。
    try {
      (node.inputs || []).forEach((inp) => {
        if (!inp || inp._ezMedia == null || inp.link == null) return;
        const link = (g.links || {})[inp.link];
        if (!link || link.origin_id == null) return;
        const up = all.find((n2) => n2 && n2.id === link.origin_id);
        if (up) all.push(up);
      });
    } catch (_) {}
    const out = []; const seen = new Set();
    all.forEach((n) => {
      const t = String((n && n.type) || '').toLowerCase();
      // EzFlex 媒体节点：直接把素材文件供 @ 菜单使用。
      if (t === 'ezflex-medialoader' || t === 'ezflex-mediaout') {
        try { (ezMediaFilesOfNode(n, g) || []).forEach((m) => { if (m.path != null && !seen.has(m.path)) { seen.add(m.path); out.push(m); } }); } catch (_) {}
        return;
      }
      const widgets = (n.widgets) || [];
      let subfolder = '';
      widgets.forEach((w2) => { if (/subfolder|folder/i.test(String(w2 && w2.name || '')) && typeof w2.value === 'string' && w2.value) subfolder = w2.value; });
      widgets.forEach((w) => {
        const v = w && w.value;
        if (typeof v !== 'string' || !v) return;
        const base = v.split(/[\\/]/).pop();
        const mt = base.match(/\.([a-z0-9]{2,5})$/i);
        if (!mt) return;
        const ext = mt[1].toLowerCase();
        const typ = /mp4|webm|mov|mkv|avi/.test(ext) ? 'video' : /mp3|wav|flac|ogg|m4a|opus/.test(ext) ? 'audio' : /obj|glb|gltf|fbx|stl/.test(ext) ? 'model' : /png|jpe?g|webp|gif|bmp|tif?f/.test(ext) ? 'image' : null;
        if (!typ || seen.has(v)) return; seen.add(v);
        const url = '/view?filename=' + encodeURIComponent(base) + (subfolder ? '&subfolder=' + encodeURIComponent(subfolder) : '') + '&type=input';
        out.push({ name: base, path: v, type: typ, url });
      });
    });
    const dedup = []; const su = new Set();
    out.forEach((m) => { if (!su.has(m.url)) { su.add(m.url); dedup.push(m); } });
    return dedup;
  } catch (_) { return []; }
}
function mediaRefLabel(type, ed) {
  const t = (type === 'video') ? '视频' : (type === 'audio') ? '音频' : (type === 'model' || type === '3d') ? '3D模型' : '图片';
  const n = (ed.querySelectorAll ? ed.querySelectorAll('.eph-mref[data-type="' + type + '"]').length : 0) + 1;
  return '@' + t + n;
}
function insertMediaRef(ed, m) {
  if (!ed) return;
  ed.focus();
  const sel = window.getSelection();
  let range = (sel.rangeCount && sel.getRangeAt(0)) || null;
  if (!range || !ed.contains(range.commonAncestorContainer)) { range = document.createRange(); range.selectNodeContents(ed); range.collapse(false); }
  const type = m.type || 'image';
  const sp = el('span', 'eph-mref'); sp.contentEditable = 'false';
  sp.dataset.url = m.url || ''; sp.dataset.type = type; sp.dataset.name = m.name || ''; sp.dataset.path = m.path || '';
  sp.textContent = mediaRefLabel(type, ed);   // 超链接样式，显示 @图片1 / @视频1 …（按类型顺序编号）
  range.deleteContents(); range.insertNode(sp);
  // 后面自动补一个逗号
  const comma = document.createTextNode(',');
  range.setStartAfter(sp); range.collapse(true); range.insertNode(comma);
  range.setStartAfter(comma); range.collapse(true);
  sel.removeAllRanges(); sel.addRange(range);
  saveSelection && saveSelection(); ed.dispatchEvent(new Event('input', { bubbles: true }));
}
let _mvModal = null;
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
    const stop = () => { m._box.querySelectorAll('video,audio').forEach((v) => { try { v.pause(); } catch (_) {} }); m.classList.remove('active'); };
    close.addEventListener('click', stop);
    m.addEventListener('mousedown', (e) => { if (e.target === m && (_phClosedEl === null || _phClosedEl === m)) stop(); });
  }
  const box = m._box;
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
// 在编辑器文本里定位第 charIndex 个字符所在的文本节点+偏移（递归走全部文本节点，含芯片内文本）。
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
// 读出光标前的「可编辑文本」（跳过媒体芯片），保证与 _frLocateChar 一致。
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
function attachMention(ed, nodeGetter) {
  ed.addEventListener('keyup', () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return hideMention();
    const rng = sel.getRangeAt(0);
    const before = _frBeforeText(ed, rng.startContainer, rng.startOffset);
    const m = before.match(/(@[^\s\n\u200b\u3000]*)$/);
    if (!m) return hideMention();
    const token = m[1]; const q = token.slice(1);
    const startPos = _frLocateChar(ed, before.length - token.length);
    if (!startPos || !startPos.node) return hideMention();
    mentionShow(nodeGetter ? nodeGetter() : null, q, startPos.node, startPos.offset, rng, ed);
  });
}
async function mentionShow(node, q, startNode, startOff, rng, ed) {
  const list = graphMediaFiles(node) || [];   // 只列当前画布接入的媒体
  const matched = list.filter((m) => ((m.name || m.path || '').toLowerCase().indexOf(q.toLowerCase()) >= 0));
  const menu = mentionMenuEl(); menu.innerHTML = '';
  if (matched.length) menu.appendChild(el('div', 'eph-tools-sep')).textContent = '媒体';
  else menu.appendChild(el('div', 'eph-dd-empty')).textContent = q ? '无匹配媒体' : '未检测到画布媒体（请先给节点接入媒体）';
  matched.forEach((m) => {
    const b = el('button', 'eph-tool-item ph-mref-item'); b.type = 'button';
    const ico = document.createElement('span'); ico.className = 'eph-mref-ico'; ico.innerHTML = mediaIcon(m.type);
    b.appendChild(ico); b.appendChild(document.createTextNode(' ' + (m.name || m.path)));
    b.addEventListener('mouseenter', () => refPreviewShow(b, m));
    b.addEventListener('mouseleave', refPreviewHide);
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const s = window.getSelection(); const rr = document.createRange();
      try { rr.setStart(startNode, startOff); rr.setEnd(rng.startContainer, rng.startOffset); } catch (_) {}
      s.removeAllRanges(); s.addRange(rr);
      insertMediaRef(ed, m);
      hideMention();
    });
    menu.appendChild(b);
  });
  try { const rect = rng.getBoundingClientRect(); menu.style.left = rect.left + 'px'; menu.style.top = (rect.bottom + 4) + 'px'; menu.style.minWidth = '180px'; menu.style.width = '180px'; }
  catch (_) { menu.style.left = '20px'; menu.style.top = '20px'; }
  menu.classList.add('active');
}

function mediaIcon(type) {
  const t = (type || '').toLowerCase();
  if (t === 'video') return TYPE_ICONS.video;
  if (t === 'audio') return TYPE_ICONS.audio;
  if (t === 'model' || t === '3d' || t === 'model_3d') return TYPE_ICONS.model_3d;
  if (t === 'text' || t === 'txt' || t === 'other') return TYPE_ICONS.text;
  return TYPE_ICONS.image;
}
async function addMediaFileItems(dd, ed, insertFn, node) {
  dd.querySelectorAll('.ph-mref-item').forEach((x) => x.remove());
  Array.from(dd.querySelectorAll('.eph-tools-sep')).forEach((s) => s.remove());
  // 优先列「当前工作流画布」里的媒体节点（真正做到只读本工作流）；画布里没有就用 input 目录扫描兜底。
  let files = graphMediaFiles(node);
  if (!files.length) files = await loadMediaFiles();
  if (!files.length) return;
  dd.appendChild(el('div', 'eph-tools-sep')).textContent = '媒体文件';
  files.forEach((m) => {
    const b = el('button', 'eph-tool-item ph-mref-item'); b.type = 'button';
    b.innerHTML = '<span class="eph-mref-ico">' + mediaIcon(m.type) + '</span><span>' + (m.name || m.path) + '</span>';    b.addEventListener('mouseenter', () => refPreviewShow(b, m));
    b.addEventListener('mouseleave', refPreviewHide);
    b.addEventListener('click', (e) => { e.stopPropagation(); insertMediaRef(ed, m); dd.classList.remove('active'); });
    dd.appendChild(b);
  });
}
// 点击编辑器里已插入的「@媒体」芯片 → 打开预览/播放
document.addEventListener('click', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('.eph-mref') : null;
  if (t) { e.preventDefault(); e.stopPropagation(); phMediaViewer(t.dataset.url, t.dataset.type, t.dataset.name); }
});
// 调用后端优化：method 映射 api / textgen / llama，参数来自节点全局「调用设置」。
async function runOptimize(id, ed) {
  const nd = _editModal && _editModal._node;
  if (!nd) return;
  const st = stateFor(nd);
  const card = st.cards.find((c) => c.id === st.editingId);
  // 优化始终以「默认提示词」为源（不沿用用户手改的优化结果）。
  const src = (card ? (card.contentHTML || card.content || (ed ? ed.textContent : '')) : '');
  const plain = plainTextOf(src) || (ed ? ed.textContent : '');
  if (!plain.trim()) { window.alert('当前卡片没有可优化的提示词内容。'); return; }
  const cfg = optimizeFor(nd);
  const method = id === 'optimize' ? 'api' : id;
  const keyOptional = (cfg.provider === 'Ollama');
  if (method === 'api' && !keyOptional && !cfg.apiKey) { window.alert('调用「优化提示词 (API)」需要先在「调用设置」里填写该厂商的 API Key（模型厂商/API 主机也请确认）。'); return; }
  const payload = { method, prompt: plain, skill: cfg.skill || '', provider: cfg.provider || '', model: cfg.model || '', apiUrl: cfg.apiUrl || '', apiKey: cfg.apiKey || '', proxy: cfg.proxy || '', textgen: cfg.textgen || {}, llama: cfg.llama || {}, clearCache: !!cfg.clearCache };
  phProgShow(nd, 1, '优化提示词');
  phProgTick(nd, 0, (card ? card.title : '') + ' 调用中…');
  try {
    const res = await (async () => { const r = await fetchApi('/prompt_helper/optimize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return r; })();
    const data = await res.json().catch(() => ({ error: '响应解析失败' }));
    if (!res.ok || data.error) { phProgErr(nd, (data.error || ('HTTP ' + res.status))); window.alert('优化失败：' + (data.error || ('HTTP ' + res.status))); return; }
    const outText = data.text || '';
    // 切到「优化提示词」页签并写入结果
    if (card) {
      card.contentOptimizedHTML = plainTextToHtml(outText);
      card.contentOptimized = outText;
      const tabOpt = _editModal && _editModal._tabOptimized;
      const tabDef = _editModal && _editModal._tabDefault;
      if (tabOpt) { tabOpt.classList.add('active'); tabDef && tabDef.classList.remove('active'); }
      st.currentTab = 'optimized';
      if (_editModal) { _editModal._editor.innerHTML = card.contentOptimizedHTML; }
      requestAnimationFrame(moveTabThumb);
      syncToConfig(nd);
    }
    phProgDone(nd);
  } catch (e) { phProgErr(nd, (e && e.message ? e.message : e)); window.alert('优化请求失败：' + (e && e.message ? e.message : e)); }
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
    skill: o.skill || '',
    skillFile: o.skillFile || '',
    autoTextgen: !!o.autoTextgen,
    autoApi: !!o.autoApi,
    autoLlama: !!o.autoLlama,
    clearCache: !!o.clearCache,
    textgen: (o.textgen && typeof o.textgen === 'object') ? o.textgen : {},
    llama: (o.llama && typeof o.llama === 'object') ? o.llama : {},
  };
}
// skill 设置：从 models(实例+共享)/skills 递归读 md（已在后端聚合），选中即把内容写进 config.optimize.skill。
async function loadSkillContent(node, file) {
  const st = stateFor(node);
  st.optimize = st.optimize || {};
  if (!file) { st.optimize.skill = ''; st.optimize.skillFile = ''; syncToConfig(node); return; }
  try {
    const r = await fetchApi('/prompt_helper/skills/content?file=' + encodeURIComponent(file));
    const data = await r.json().catch(() => ({ error: '解析失败' }));
    if (data.error) { window.alert('读取 skill 失败：' + data.error); return; }
    st.optimize.skill = data.text || '';
    st.optimize.skillFile = file;
    syncToConfig(node);
  } catch (e) { window.alert('读取 skill 失败：' + (e && e.message ? e.message : e)); }
}
// ===== skill 设置弹窗（文件夹树，仿 ModelsCombo 浏览）=====
let _skillBrowser = null;
function skillBrowserEl() {
  if (_skillBrowser && _skillBrowser.parentNode) return _skillBrowser;
  _skillBrowser = el('div', 'eph-skb');
  const box = el('div', 'eph-skb-box');
  const hd = el('div', 'eph-skb-hd'); hd.appendChild(el('b')).textContent = 'skill设置';
  const close = el('button', 'eph-modal-close'); close.textContent = '✕'; hd.appendChild(close);
  const sideroot = el('div', 'eph-skb-sideroot');
  const tree = el('div', 'eph-skb-tree');
  const main = el('div', 'eph-skb-main');
  sideroot.appendChild(tree); sideroot.appendChild(main);
  box.appendChild(hd); box.appendChild(sideroot);
  _skillBrowser.appendChild(box); document.body.appendChild(_skillBrowser);
  _skillBrowser._tree = tree; _skillBrowser._main = main;
  close.addEventListener('click', () => _skillBrowser.classList.remove('active'));
  return _skillBrowser;
}
async function openSkillBrowser(node) {
  const m = skillBrowserEl(); m._node = node;
  m._tree.innerHTML = ''; m._main.innerHTML = '';
  const renderEmpty = () => {
    const b = el('button', 'eph-skb-card'); b.textContent = '🚫 不使用 skill（空）';
    if (!optimizeFor(node).skillFile) b.classList.add('on');
    b.addEventListener('click', () => { loadSkillContent(node, ''); _skillBrowser.classList.remove('active'); });
    m._main.appendChild(b);
  };
  try {
    const r = await fetchApi('/prompt_helper/skills');
    const data = await r.json().catch(() => ({}));
    const skills = data.skills || [];
    if (!skills.length) { renderEmpty(); m.classList.add('active'); return; }
    // 按文件夹分组
    const folders = {};
    skills.forEach((s) => { const dir = s.file.split('/').slice(0, -1).join('/') || '根目录'; (folders[dir] = folders[dir] || []).push(s); });
    const dirs = Object.keys(folders).sort();
    const renderFiles = (dir) => {
      m._main.innerHTML = '';
      renderEmpty();
      const t = el('div', 'eph-skb-maint'); t.textContent = '📁 ' + dir; m._main.appendChild(t);
      (folders[dir] || []).forEach((s) => {
        const c = el('button', 'eph-skb-card'); c.textContent = '📄 ' + s.file.split('/').pop();
        if (optimizeFor(node).skillFile === s.file) c.classList.add('on');
        c.addEventListener('click', () => { loadSkillContent(node, s.file); _skillBrowser.classList.remove('active'); });
        m._main.appendChild(c);
      });
    };
    dirs.forEach((dir, i) => {
      const b = el('button', 'eph-skb-dir'); b.textContent = '📁 ' + dir; if (i === 0) b.classList.add('on');
      b.addEventListener('click', () => { m._tree.querySelectorAll('.eph-skb-dir').forEach((x) => x.classList.remove('on')); b.classList.add('on'); renderFiles(dir); });
      m._tree.appendChild(b);
    });
    renderFiles(dirs[0]);
  } catch (_) { renderEmpty(); m._main.appendChild(el('div', 'eph-skb-empty')).textContent = '读取 skill 列表失败'; }
  m.classList.add('active');
}
// GGUF 模型下拉：从共享 models 文件夹读取 *.gguf（相对路径），供 llama 进程内推理选取。
// 给文本输入框挂一个「文件下拉」（图三风格）：聚焦/点击弹出可用文件列表，点选回填；仍可手动输入任意路径。
function attachFileMenu(input, endpoint) {
  if (!input || input._ephFileMenu) return input; input._ephFileMenu = true;
  const wrap = el('div', 'eph-dd'); input.classList.add('eph-dd-input');
  if (input.parentNode) input.parentNode.removeChild(input);
  wrap.appendChild(input);
  const caret = el('span', 'eph-dd-arrow'); caret.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none;';
  wrap.appendChild(caret);
  const menu = el('div', 'eph-dd-menu'); document.body.appendChild(menu);
  const openMenu = async () => {
    try {
      const r = await fetchApi(endpoint);
      const data = await r.json().catch(() => ({}));
      const models = data.models || [];
      menu.innerHTML = '';
      if (!models.length) menu.appendChild(el('div', 'eph-dd-empty')).textContent = '（无）';
      models.forEach((m) => {
        const b = el('button', 'eph-dd-item'); b.type = 'button'; b.textContent = m.path; b.title = m.path;
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => { e.stopPropagation(); input.value = m.path; menu.classList.remove('active'); try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {} });
        menu.appendChild(b);
      });
    } catch (_) { menu.innerHTML = ''; menu.appendChild(el('div', 'eph-dd-empty')).textContent = '（加载失败）'; }
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
  // 高亮保留「无颜色」以快捷清除高亮（hiliteColor 传 transparent 会把高亮折叠为透明）。
  // 文字颜色不提供无颜色（foreColor 的 transparent 无效）。
  if (target === 'highlight') {
    const noColor = el('div', 'eph-color-item eph-no-color'); noColor.dataset.color = 'transparent'; noColor.title = '清除高亮';
    grid.appendChild(noColor);
  }
  (target === 'highlight' ? _STD_COLORS : _THEME_COLORS).forEach((c) => grid.appendChild(colorItem(c, target, dd)));
  const title2 = el('div', 'eph-color-title'); title2.textContent = '标准色';
  _STD_COLORS.forEach((c) => gridSm.appendChild(colorItem(c, target, dd)));
  const more = el('button', 'eph-dropdown-btn'); more.textContent = '其他颜色(M)...';
  dd.appendChild(grid); dd.appendChild(title2); dd.appendChild(gridSm); dd.appendChild(more);
  more.addEventListener('click', (e) => { e.stopPropagation(); openColorPicker(target); dd.classList.remove('active'); });
}
function colorItem(c, target, dd) {
  const d = el('div', 'eph-color-item'); d.style.background = c; d.dataset.color = c;
  d.addEventListener('mousedown', (e) => e.preventDefault());
  d.addEventListener('click', (e) => { e.stopPropagation(); applyColor(target, c); if (dd) dd.classList.remove('active'); });
  return d;
}

// ===== 自定义取色器 =====
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
  const cancel = el('button', 'eph-picker-cancel'); cancel.textContent = '取消';
  const confirm = el('button', 'eph-picker-confirm'); confirm.textContent = '确定';
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
  _pickerModal.addEventListener('mousedown', (e) => { if (e.target === _pickerModal && (_phClosedEl === null || _phClosedEl === _pickerModal)) closePicker(); });
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

// ===== 查找/替换弹窗（可拖动）=====
let _frModal = null, _frDrag = null, _frEditor = null;
// 在指定 contenteditable 内查找下一个匹配（沿文档顺序，从当前光标往后，越界回到开头）。
function _frNodes(ed) { const out = []; const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); while (w.nextNode()) out.push(w.currentNode); return out; }
function _frSelect(ed, n, idx, query) {
  const sel = window.getSelection(); const r = document.createRange();
  r.setStart(n, idx); r.setEnd(n, idx + query.length);
  sel.removeAllRanges(); sel.addRange(r);
  try { ed.scrollIntoView({ block: 'center' }); } catch (_) {}
  return true;
}
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
  const findTab = el('button', 'eph-fr-tab active'); findTab.textContent = '查找';
  const replaceTab = el('button', 'eph-fr-tab'); replaceTab.textContent = '替换';
  const close = el('button', 'eph-fr-close'); close.textContent = '✕';
  header.appendChild(findTab); header.appendChild(replaceTab); header.appendChild(close);
  const body = el('div', 'eph-fr-body');
  const findSec = el('div'); const findRow = el('div', 'eph-fr-row'); const fi = el('input'); fi.placeholder = '查找内容';
  const fbtn = el('button', 'eph-fr-btn'); fbtn.textContent = '查找'; findRow.appendChild(fi); findRow.appendChild(fbtn);
  const fhint = el('p', 'eph-fr-hint'); fhint.textContent = '回车=查找全部并列出';
  findSec.appendChild(findRow); findSec.appendChild(fhint);
  const replaceSec = el('div'); replaceSec.style.display = 'none';
  const rr1 = el('div', 'eph-fr-row'); const fi2 = el('input'); fi2.placeholder = '查找内容'; const fb2 = el('button', 'eph-fr-btn'); fb2.textContent = '查找'; rr1.appendChild(fi2); rr1.appendChild(fb2);
  const rr2 = el('div', 'eph-fr-row'); const ri = el('input'); ri.placeholder = '替换为'; const rb = el('button', 'eph-fr-btn'); rb.textContent = '替换'; rr2.appendChild(ri); rr2.appendChild(rb);
  const rhint = el('p', 'eph-fr-hint'); rhint.textContent = '点下方列表项跳到对应位置';
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

// ===== 规则弹窗 =====
let _rulesModal = null;
const _MEDIA_REF_RULES = {
  'MiniMax H3': '前端 @图片1/@视频1/@音频1，提交时编译为 <Picture 1>/<Video 1>/<Audio 1> 尖括号标签',
  'Seedance': '使用 @图片1、@视频1、声音参考音频1，单次最多 30 图+10 视频+10 音频',
  'Wan': '使用 @Video1 / @Video2 标签引用参考视频',
  'Krea 2': '官方用 image_style_references 数组，每个参考图可设 strength(-2..2)',
  'HunyuanVideo': '使用 @image1 / @video1 标签引用',
  '通用': '保持 @图片1 / @视频1 / @音频1 标签',
};
const _TS_RULES = {
  'MiniMax H3': '[Shot 1] 开头不加时间戳，后续 [Shot 2] At 00:03.500, ...，切点严格递增',
  'Seedance': '0-5s: / 6-10s: / 11-20s:，每段须交代镜头动作+主体',
  'Wan 2.6': '[镜头 1] [0-5s] / [镜头 2] [5-10s] 时间轴语法',
  'Seedance 2.5': '支持整秒时间戳 [0s]、[2s] 及区间 0-3s',
  '通用': '[0-5s] / [5-10s] 区间时间戳',
};
function rulesEl() {
  if (_rulesModal && _rulesModal.parentNode) return _rulesModal;
  _rulesModal = el('div', 'eph-rules');
  const box = el('div', 'eph-rules-box');
  const hd = el('div', 'eph-rules-hd');
  const t = el('b'); t.textContent = '规则设置';
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  hd.appendChild(t); hd.appendChild(close);
  const body = el('div', 'eph-rules-body');
  const mkSel = (labelText, presets, key) => {
    const l = el('label', 'eph-rule-sel');
    l.appendChild(el('span')).textContent = labelText;
    const dd = makeDropdown(Object.keys(presets).map((v) => ({ value: v, label: v })));
    const note = el('div', 'eph-rule-note'); note.textContent = presets[dd.value] || '';
    dd.addEventListener('change', (v) => { note.textContent = presets[v] || ''; });
    l.appendChild(dd.el); l.appendChild(note);
    body.appendChild(l);
    _rulesModal['_sel_' + key] = dd;
    return dd;
  };
  mkSel('媒体引用规则（选模型套用格式）', _MEDIA_REF_RULES, 'mediaRef');
  mkSel('时间戳规则（选模型套用格式）', _TS_RULES, 'ts');
  const custom = el('label', 'eph-rule-custom'); custom.appendChild(el('span')).textContent = '自定义规则';
  const mIn = el('input'); mIn.placeholder = '媒体引用格式，如 <Picture {n}> 或 @图片{n}';
  const tIn = el('input'); tIn.placeholder = '时间戳格式，如 [Shot {n}] At {t}';
  custom.appendChild(mIn); custom.appendChild(tIn);
  body.appendChild(custom);
  const save = el('button', 'eph-btn eph-btn-save'); save.textContent = '保存规则'; save.style.alignSelf = 'flex-end';
  save.addEventListener('click', () => { saveRules(); });
  body.appendChild(save);
  box.appendChild(hd); box.appendChild(body); _rulesModal.appendChild(box); document.body.appendChild(_rulesModal);
  _rulesModal._mIn = mIn; _rulesModal._tIn = tIn;
  close.addEventListener('click', () => _rulesModal.classList.remove('active'));
  _rulesModal.addEventListener('click', (e) => { if (e.target === _rulesModal && (_phClosedEl === null || _phClosedEl === _rulesModal)) _rulesModal.classList.remove('active'); });
  return _rulesModal;
}
function openRules(node) {
  const m = rulesEl(); m._node = node;
  const r = stateFor(node).rules || {};
  try { m._sel_mediaRef.value = r.mediaRefModel || '通用'; } catch (_) {}
  try { m._sel_ts.value = r.tsModel || '通用'; } catch (_) {}
  m._mIn.value = r.mediaRef || ''; m._tIn.value = r.ts || '';
  const note1 = m._sel_mediaRef.el.parentNode && m._sel_mediaRef.el.parentNode.querySelector('.eph-rule-note');
  if (note1) note1.textContent = _MEDIA_REF_RULES[m._sel_mediaRef.value] || '';
  const note2 = m._sel_ts.el.parentNode && m._sel_ts.el.parentNode.querySelector('.eph-rule-note');
  if (note2) note2.textContent = _TS_RULES[m._sel_ts.value] || '';
  m.classList.add('active');
}
function saveRules() {
  const m = _rulesModal; if (!m || !m._node) return;
  const st = stateFor(m._node);
  st.rules = { mediaRefModel: m._sel_mediaRef.value, tsModel: m._sel_ts.value, mediaRef: m._mIn.value, ts: m._tIn.value };
  syncToConfig(m._node);
  m.classList.remove('active');
}

// ===== 调用设置弹窗（模型与接口 / TextGenerate / llama 三排）=====
let _settingsModal = null, _settingsNode = null;
const _SET_PROVIDERS = [
  { value: 'OpenAI', label: 'OpenAI', host: 'https://api.openai.com/v1', oauth: true, loginUrl: 'https://platform.openai.com',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-cyber', 'gpt-5.5-pro', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex-spark', 'gpt-4.1'] },
  { value: 'DeepSeek', label: 'DeepSeek', host: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro-0813', 'deepseek-v4-flash-0731'] },
  { value: 'Google Gemini', label: 'Gemini', host: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-image', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-image'] },
  { value: 'Anthropic Claude', label: 'Claude', host: 'https://api.anthropic.com/v1', oauth: true, loginUrl: 'https://console.anthropic.com', anthropic: true,
    models: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  { value: 'Alibaba Qwen', label: 'Qwen Portal', host: 'https://dashscope.aliyuncs.com/compatible-mode/v1', oauth: true, loginUrl: 'https://bailian.console.aliyun.com',
    models: ['qwen3.8-max-preview', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash', 'qwen3.6-plus', 'qwen3.5-flash', 'qwen3.5-plus', 'qwen3-max', 'qwen3-coder-next', 'qwen-flash', 'qvq-max'] },
  { value: 'Moonshot Kimi', label: 'Moonshot Kimi', host: 'https://api.moonshot.ai/v1',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-8k-vision-preview'] },
  { value: 'SiliconFlow', label: 'SiliconFlow', host: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V2.5', 'deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2-7B-Instruct', 'THUDM/glm-4-9b-chat', 'stabilityai/stable-diffusion-xl-base-1.0'] },
  { value: 'OpenRouter', label: 'OpenRouter', host: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-5.6-luna', 'openai/gpt-oss-120b', 'google/gemini-3.7-flash', 'anthropic/claude-opus-5', 'anthropic/claude-fable-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4.5', 'openai/gpt-6-astra'] },
  { value: 'Ollama', label: 'Ollama（本机）', host: 'http://localhost:11434/v1', customHost: true, keyOptional: true, models: ['llama2', 'llama3', 'llama3.1', 'llama3.2', 'llama4', 'gemma', 'gemma2', 'gemma3', 'gemma4', 'qwen', 'qwen2', 'qwen2.5', 'qwen3', 'mistral', 'phi', 'deepseek-r1', 'codellama'] },
];
const _PROVIDER_BASE = (() => { const m = {}; _SET_PROVIDERS.forEach((p) => { m[p.value] = p.host; }); return m; })();
const _TG_DEFAULTS = { enabled: false, clip_path: '', clip_type: 'stable_diffusion', max_length: 512, sampling_mode: 'on', temperature: 0.7, top_k: 64, top_p: 0.95, min_p: 0.05, repetition_penalty: 1.05, seed: 0, presence_penalty: 0.0, thinking: false, use_default_template: true };
const _CLIP_TYPES = ['stable_diffusion', 'stable_cascade', 'sd3', 'stable_audio', 'mochi', 'ltxv', 'pixart', 'cosmos', 'lumina2', 'wan', 'hidream', 'chroma', 'ace', 'omnigen2', 'qwen_image', 'hunyuan_image', 'flux2', 'ovis', 'longcat_image', 'cogvideox', 'lens', 'pixeldit', 'ideogram4', 'boogu', 'krea2', 'joyimage', 'mage', 'minimax'];
const _LL_DEFAULTS = { mode: 'local', model: '', mmproj: '', server: 'http://127.0.0.1:8080', n_ctx: 2048, n_gpu_layers: 0, n_batch: 512, max_tokens: 256, temperature: 0.7, top_p: 0.95, top_k: 40, repeat_penalty: 1.1, seed: 0, stop: '' };
// ===== 调用设置下拉（图三风格：白底圆角列表 + 滚动条）=====
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
  const lfor = (v) => { const it = opts.find((x) => (typeof x === 'string' ? x : x.value) === v); return it ? (typeof it === 'string' ? it : it.label) : v; };
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
    if (!opts.length) { const e = el('div', 'eph-dd-empty'); e.textContent = '（无）'; menu.appendChild(e); }
    opts.forEach((it) => {
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
  const onS = el('em', 'eph-seg-item on'); onS.textContent = '开启';
  const offS = el('em', 'eph-seg-item off'); offS.textContent = '禁用';
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
  const t = el('b'); t.textContent = '调用设置';
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  hd.appendChild(t); hd.appendChild(close);
  const body = el('div', 'eph-settings-body');

  // 侧边栏：左侧导航 + 右侧面板（API设置 / TextGenerate设置 / llama设置）
  const sideroot = el('div', 'eph-settings-sideroot');
  const nav = el('div', 'eph-settings-nav');
  const pane = el('div', 'eph-settings-pane');
  sideroot.appendChild(nav); sideroot.appendChild(pane);
  body.appendChild(sideroot);

  // ---- 通用设置：运行期自动优化（滑块开关，显示 开启/禁用；三者互斥，最多一个生效）----
  const grid0 = el('div', 'eph-settings-grid active');
  const _AUTO_KEYS = ['autoTextgen', 'autoApi', 'autoLlama'];
  const mkSwitch = (label, key) => {
    const l = segSwitch(label);
    const cb = l._cb;
    cb.addEventListener('change', () => {
      // 只在「三种自动优化方式」之间互斥；clearCache 可独立开关。
      if (cb.checked && _AUTO_KEYS.includes(key)) { _AUTO_KEYS.forEach((k) => { if (k !== key && grid0._auto[k]) { grid0._auto[k].checked = false; grid0._auto[k]._upd && grid0._auto[k]._upd(); } }); }
    });
    grid0._auto = grid0._auto || {}; grid0._auto[key] = cb;
    grid0.appendChild(l);
    return cb;
  };
  mkSwitch('运行期自动优化 (TextGenerate / 本地 CLIP)', 'autoTextgen');
  mkSwitch('运行期自动优化 (API，带图像)', 'autoApi');
  mkSwitch('运行期自动优化 (llama，带图像)', 'autoLlama');
  mkSwitch('调用后清除模型缓存(省显存)', 'clearCache');
  pane.appendChild(grid0);

  // ---- API设置 ----
  const grid1 = el('div', 'eph-settings-grid');
  const provDD = makeDropdown([{ value: '自定义', label: '自定义' }].concat(_SET_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))));
  const modelDD = makeDropdown();
  const apiUrlIn = el('input'); apiUrlIn.placeholder = 'API 主机（默认自动填充）'; apiUrlIn.value = '';
  const apiKeyIn = el('input'); apiKeyIn.type = 'password'; apiKeyIn.placeholder = 'API Key';
  const loginBtn = el('button', 'eph-login-btn'); loginBtn.textContent = '登录';
  const customNameIn = el('input'); customNameIn.placeholder = '厂商名（如 My-Proxy）';
  const customModelIn = el('input'); customModelIn.placeholder = '模型 ID（如 my-model-v1）';
  const fld = (labelText, ...nodes) => { const l = el('label'); const sp = el('span'); sp.textContent = labelText; l.appendChild(sp); nodes.forEach((n) => l.appendChild(n)); grid1.appendChild(l); return l; };
  const provF = fld('模型厂商', provDD.el);
  const modelF = fld('模型选择', modelDD.el);
  const customNameF = fld('自定义厂商名', customNameIn);
  const customModelF = fld('自定义模型 ID', customModelIn);
  const saveCustomBtn = el('button', 'eph-btn'); saveCustomBtn.textContent = '保存到 userdata';
  saveCustomBtn.addEventListener('click', async () => {
    const name = customNameIn.value.trim(); if (!name) { window.alert('请先填写厂商名'); return; }
    try { const r = await fetchApi('/prompt_helper/custom_providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, model: customModelIn.value.trim(), apiUrl: apiUrlIn.value.trim(), apiKey: apiKeyIn.value.trim(), proxy: proxyIn.value.trim() }) }); const d = await r.json().catch(() => ({})); if (d.error) window.alert('保存失败：' + d.error); else window.alert('已保存到 userdata'); } catch (e) { window.alert('保存失败：' + (e && e.message ? e.message : e)); }
  });
  const saveCustomF = fld('保存到 userdata', saveCustomBtn);
  const urlF = fld('API 主机', apiUrlIn);
  const keyF = fld('API Key', apiKeyIn);
  const proxyIn = el('input'); proxyIn.value = ''; proxyIn.placeholder = '如 http://127.0.0.1:7890（留空=直连）';
  const proxyF = fld('代理地址（可选）', proxyIn);
  const loginF = fld('登录授权', loginBtn);
  const providerMeta = () => _SET_PROVIDERS.find((x) => x.value === provDD.value) || {};
  const applyProviderUI = () => {
    const p = providerMeta(); const isCustom = provDD.value === '自定义';
    const oauth = !!p.oauth, keyOptional = !!p.keyOptional;
    urlF.style.display = '';                           // 始终显示主机（可改）
    modelF.style.display = isCustom ? 'none' : '';
    customNameF.style.display = isCustom ? '' : 'none';
    customModelF.style.display = isCustom ? '' : 'none';
    saveCustomF.style.display = isCustom ? '' : 'none';
    loginF.style.display = oauth ? '' : 'none';
    apiKeyIn.placeholder = keyOptional ? 'API Key（Ollama 可留空）' : 'API Key';
    loginBtn.title = '打开 ' + (p.label || '') + ' 授权页登录';
  };
  const setModels = () => {
    const p = _SET_PROVIDERS.find((x) => x.value === provDD.value);
    const models = (p && Array.isArray(p.models)) ? p.models : [];
    const cur = modelDD.value;
    const ms = models.slice();
    if (cur && !ms.includes(cur)) ms.unshift(cur);
    modelDD.setItems(ms);
    if (cur && ms.includes(cur)) modelDD.value = cur;
    else if (ms.length) modelDD.value = ms[0];
    applyProviderUI();
  };
  provDD.addEventListener('change', () => { const isCustom = provDD.value === '自定义'; if (!isCustom && _PROVIDER_BASE[provDD.value]) apiUrlIn.value = _PROVIDER_BASE[provDD.value]; setModels(); });
  loginBtn.addEventListener('click', () => { const p = providerMeta(); const url = (p && (p.loginUrl || _PROVIDER_BASE[p.value])) || ''; if (url) window.open(url, '_blank'); });
  pane.appendChild(grid1);

  // ---- TextGenerate设置 ----
  const grid2 = el('div', 'eph-settings-grid');
  const numField = (labelText, key, def) => { const inp = el('input'); inp.type = 'number'; inp.value = String(def); grid2._tg = grid2._tg || {}; grid2._tg[key] = inp; fld2(grid2, labelText, inp); return inp; };
  const tgDD = (labelText, key, opts) => { const dd = makeDropdown((opts || []).map(([v, l]) => ({ value: v, label: l }))); grid2._tg = grid2._tg || {}; grid2._tg[key] = dd; fld2(grid2, labelText, dd.el); return dd; };
  const tgChk = (labelText, key, def) => { const l = segSwitch(labelText); l._cb.checked = !!def; l._cb._upd(); grid2._tg = grid2._tg || {}; grid2._tg[key] = l._cb; grid2.appendChild(l); return l._cb; };
  // CLIP 模型选择（放最上面，点击即用 textgen，像 llama 一样自加载）
  const clipPath = el('input'); clipPath.type = 'text'; clipPath.value = ''; clipPath.placeholder = '如 text_encoders/...safetensors';
  const clipTypeDD = makeDropdown(_CLIP_TYPES.map((t) => ({ value: t, label: t })));
  grid2._tg = grid2._tg || {}; grid2._tg.clip_path = clipPath; grid2._tg.clip_type = clipTypeDD;
  fld2(grid2, 'CLIP 模型路径', attachFileMenu(clipPath, '/prompt_helper/clip_models'));
  fld2(grid2, 'CLIP 类型', clipTypeDD.el);
  numField('最大长度', 'max_length', _TG_DEFAULTS.max_length);
  tgDD('采样模式', 'sampling_mode', [['on', 'on'], ['off', 'off']]);
  numField('温度', 'temperature', _TG_DEFAULTS.temperature);
  numField('Top K', 'top_k', _TG_DEFAULTS.top_k);
  numField('Top P', 'top_p', _TG_DEFAULTS.top_p);
  numField('最小概率', 'min_p', _TG_DEFAULTS.min_p);
  numField('重复惩罚', 'repetition_penalty', _TG_DEFAULTS.repetition_penalty);
  numField('种子', 'seed', _TG_DEFAULTS.seed);
  numField('presence_penalty', 'presence_penalty', _TG_DEFAULTS.presence_penalty);
  tgChk('思考模式', 'thinking', _TG_DEFAULTS.thinking);
  tgChk('use_default_template', 'use_default_template', _TG_DEFAULTS.use_default_template);
  pane.appendChild(grid2);

  // ---- llama设置 ----
  const grid3 = el('div', 'eph-settings-grid');
  const llField = (labelText, key, def) => { const inp = el('input'); inp.type = 'number'; inp.value = String(def); if (key === 'model' || key === 'mmproj' || key === 'server' || key === 'stop') { inp.type = 'text'; } grid3._ll = grid3._ll || {}; grid3._ll[key] = inp; fld2(grid3, labelText, inp); return inp; };
  const llModeDD = makeDropdown([{ value: 'local', label: '进程内 llama-cpp-python' }, { value: 'server', label: 'llama.cpp 服务器(HTTP)' }]);
  grid3._ll = grid3._ll || {}; grid3._ll.mode = llModeDD; fld2(grid3, '调用方式', llModeDD.el);
  const llModel = el('input'); llModel.type = 'text'; llModel.value = String(_LL_DEFAULTS.model); llModel.placeholder = '可填相对或绝对路径';
  grid3._ll.model = llModel;
  fld2(grid3, 'GGUF 模型路径', attachFileMenu(llModel, '/prompt_helper/llama_models'));
  const llMmproj = el('input'); llMmproj.type = 'text'; llMmproj.value = String(_LL_DEFAULTS.mmproj); llMmproj.placeholder = '如 mmproj-Qwen3-VL-8B-Instruct-Q8_0.gguf';
  grid3._ll.mmproj = llMmproj;
  fld2(grid3, 'mmproj(看图)', attachFileMenu(llMmproj, '/prompt_helper/llama_models'));
  const llServer = llField('服务器地址', 'server', _LL_DEFAULTS.server); llServer.placeholder = '如 http://127.0.0.1:8080';
  llField('上下文长度 n_ctx', 'n_ctx', _LL_DEFAULTS.n_ctx);
  llField('GPU 层数 n_gpu_layers', 'n_gpu_layers', _LL_DEFAULTS.n_gpu_layers);
  llField('batch n_batch', 'n_batch', _LL_DEFAULTS.n_batch);
  llField('最大 token', 'max_tokens', _LL_DEFAULTS.max_tokens);
  llField('温度', 'temperature', _LL_DEFAULTS.temperature);
  llField('Top P', 'top_p', _LL_DEFAULTS.top_p);
  llField('Top K', 'top_k', _LL_DEFAULTS.top_k);
  llField('重复惩罚', 'repeat_penalty', _LL_DEFAULTS.repeat_penalty);
  llField('种子', 'seed', _LL_DEFAULTS.seed);
  const llStop = llField('stop', 'stop', _LL_DEFAULTS.stop); llStop.placeholder = '多个用逗号分隔';
  pane.appendChild(grid3);

  const navItems = [['通用设置', grid0], ['API设置', grid1], ['TextGenerate设置', grid2], ['llama设置', grid3]];
  const showGrid = (g) => { pane.querySelectorAll('.eph-settings-grid').forEach((x) => { x.style.display = 'none'; }); g.style.display = 'grid'; };
  navItems.forEach(([label, g], i) => {
    const b = el('button', 'eph-settings-nav-btn'); b.textContent = label; if (i === 0) b.classList.add('active');
    b.addEventListener('click', () => { nav.querySelectorAll('.eph-settings-nav-btn').forEach((x) => x.classList.remove('active')); b.classList.add('active'); showGrid(g); });
    nav.appendChild(b);
  });
  showGrid(grid0);

  const ft = el('div', 'eph-settings-ft');
  const resetBtn = el('button', 'eph-btn eph-btn-cancel'); resetBtn.textContent = '恢复默认';
  const cancelBtn = el('button', 'eph-btn eph-btn-cancel'); cancelBtn.textContent = '取消';
  const saveBtn = el('button', 'eph-btn eph-btn-save'); saveBtn.textContent = '保存';
  ft.appendChild(resetBtn); ft.appendChild(cancelBtn); ft.appendChild(saveBtn);
  box.appendChild(hd); box.appendChild(body); box.appendChild(ft);
  _settingsModal.appendChild(box); document.body.appendChild(_settingsModal);

  close.addEventListener('click', () => _settingsModal.classList.remove('active'));
  cancelBtn.addEventListener('click', () => _settingsModal.classList.remove('active'));
  saveBtn.addEventListener('click', saveSettings);
  resetBtn.addEventListener('click', () => { resetSettings(); });
  _settingsModal._box = box; _settingsModal._provSel = provDD; _settingsModal._modelIn = modelDD; _settingsModal._apiUrlIn = apiUrlIn; _settingsModal._apiKeyIn = apiKeyIn; _settingsModal._proxyIn = proxyIn; _settingsModal._customNameIn = customNameIn; _settingsModal._customModelIn = customModelIn; _settingsModal._setModels = setModels;
  _settingsModal._grid2 = grid2; _settingsModal._grid3 = grid3; _settingsModal._grid0 = grid0;
  return _settingsModal;
}
function fld2(grid, labelText, input) { const l = el('label'); const sp = el('span'); sp.textContent = labelText; l.appendChild(sp); l.appendChild(input); grid.appendChild(l); return l; }
function openSettings(node) {
  if (!node) return;
  _settingsNode = node;
  const o = optimizeFor(node);
  const m = settingsEl();
  // 通用设置（第 1 排）
  ['autoTextgen', 'autoApi', 'autoLlama', 'clearCache'].forEach((k) => { const cb = m._grid0 && m._grid0._auto && m._grid0._auto[k]; if (cb) cb.checked = !!o[k]; });
  m._apiKeyIn.value = o.apiKey || '';
  m._proxyIn.value = o.proxy || '';
  // 若是自定义厂商（不在预设列表）→ 切「自定义」并填入名称/模型；否则按已知厂商
  const known = _SET_PROVIDERS.some((p) => p.value === (o.provider || 'OpenAI')) || (o.provider === '自定义');
  if (!known) {
    m._provSel.value = '自定义';
    m._customNameIn.value = (o.provider || '').trim();
    m._customModelIn.value = (o.model || '').trim();
  } else {
    m._provSel.value = o.provider || 'OpenAI';
    m._modelIn.value = o.model || '';
    m._customNameIn.value = ''; m._customModelIn.value = '';
  }
  m._setModels();
  // 第 2 排 TextGenerate
  const tg = Object.assign({}, _TG_DEFAULTS, o.textgen || {});
  Object.keys(_TG_DEFAULTS).forEach((k) => { const inp = m._grid2._tg && m._grid2._tg[k]; if (!inp) return; if (inp.type === 'checkbox') inp.checked = !!tg[k]; else inp.value = String(tg[k]); });
  // 第 3 排 llama
  const ll = Object.assign({}, _LL_DEFAULTS, o.llama || {});
  Object.keys(_LL_DEFAULTS).forEach((k) => { const inp = m._grid3._ll && m._grid3._ll[k]; if (!inp) return; if (inp.type === 'checkbox') inp.checked = !!ll[k]; else inp.value = String(ll[k]); });
  m.classList.add('active');
}
function saveSettings() {
  if (!_settingsNode) return;
  const m = _settingsModal; if (!m) return;
  const st = stateFor(_settingsNode);
  const prev = st.optimize || {};
  const tg = {};
  Object.keys(_TG_DEFAULTS).forEach((k) => { const inp = m._grid2._tg && m._grid2._tg[k]; if (!inp) return; tg[k] = inp.type === 'checkbox' ? inp.checked : (inp.type === 'number' ? parseFloat(inp.value) : inp.value); });
  const ll = {};
  Object.keys(_LL_DEFAULTS).forEach((k) => { const inp = m._grid3._ll && m._grid3._ll[k]; if (!inp) return; ll[k] = inp.type === 'checkbox' ? inp.checked : (inp.type === 'number' ? (inp.value === '' ? _LL_DEFAULTS[k] : parseFloat(inp.value)) : inp.value); });
  st.optimize = Object.assign({}, prev, {
    autoTextgen: !!(m._grid0._auto && m._grid0._auto.autoTextgen && m._grid0._auto.autoTextgen.checked),
    autoApi: !!(m._grid0._auto && m._grid0._auto.autoApi && m._grid0._auto.autoApi.checked),
    autoLlama: !!(m._grid0._auto && m._grid0._auto.autoLlama && m._grid0._auto.autoLlama.checked),
    clearCache: !!(m._grid0._auto && m._grid0._auto.clearCache && m._grid0._auto.clearCache.checked),
    provider: (m._provSel.value === '自定义') ? (m._customNameIn.value.trim() || '自定义') : m._provSel.value,
    model: (m._provSel.value === '自定义') ? (m._customModelIn.value.trim()) : m._modelIn.value.trim(),
    apiUrl: m._apiUrlIn.value.trim(),
    apiKey: m._apiKeyIn.value.trim(),
    proxy: m._proxyIn.value.trim(),
    textgen: tg,
    llama: ll,
  });
  syncToConfig(_settingsNode);
  m.classList.remove('active');
}
async function resetSettings() {
  const m = _settingsModal; if (!m) return;
  if (!(await uiConfirm('恢复默认调用设置？'))) return;
  m._modelIn.value = ''; m._apiUrlIn.value = ''; m._apiKeyIn.value = ''; m._proxyIn.value = '';
  ['autoTextgen', 'autoApi', 'autoLlama', 'clearCache'].forEach((k) => { const cb = m._grid0 && m._grid0._auto && m._grid0._auto[k]; if (cb) cb.checked = false; });
  Object.keys(_TG_DEFAULTS).forEach((k) => { const inp = m._grid2._tg && m._grid2._tg[k]; if (!inp) return; if (inp.type === 'checkbox') inp.checked = !!_TG_DEFAULTS[k]; else inp.value = String(_TG_DEFAULTS[k]); });
  Object.keys(_LL_DEFAULTS).forEach((k) => { const inp = m._grid3._ll && m._grid3._ll[k]; if (!inp) return; inp.value = String(_LL_DEFAULTS[k]); });
  m._provSel.value = 'OpenAI'; m._setModels();
}

// ===== 总体编辑（Word 大纲：每条卡片= 左侧小标题行[序号/标题/时间轴/删除] + 下方内容；顶部 skill 提示 + 默认/优化滑块 + 工具栏；点外面自动保存关闭）=====
let _allModal = null, _allTab = 'default';
function runToolOn(ed, id) {
  if (!ed) return;
  const mapFH = { '，': ',', '。': '.', '！': '!', '？': '?', '：': ':', '；': ';', '“': '"', '”': '"', '‘': "'", '’': "'", '（': '(', '）': ')', '【': '[', '】': ']', '《': '<', '》': '>', '、': ',', '—': '-', '～': '~' };
  const mapHF = { ',': '，', '.': '。', '!': '！', '?': '？', ':': '：', ';': '；', '"': '“', "'": '‘', '(': '（', ')': '）', '[': '【', ']': '】', '<': '《', '>': '》', '~': '～', '-': '—' };
  const convert = (s) => id === 'fullToHalf' ? s.replace(/[，。！？：；“”‘’（）【】《》、—～]/g, (ch) => mapFH[ch] || ch).replace(/\u3000/g, ' ') : s.replace(/[,\.!\?:;"'\(\)\[\]<>~-]/g, (ch) => mapHF[ch] || ch);
  const bodies = ed.querySelectorAll('.eph-all-block-body');
  (bodies.length ? Array.from(bodies) : [ed]).forEach((b) => { b.textContent = convert(b.textContent); });
}
function insertTextOn(ed, text) {
  if (!ed) return;
  ed.focus();
  document.execCommand('insertText', false, text);
}
function execCommandOn(ed, cmd) {
  if (!ed) return;
  ed.focus();
  document.execCommand(cmd, false, null);
}
// 用 span 包装某块内容并写样式（避免 execCommand 在多块编辑器中失效；span 落在 innerHTML 里可随保存持久化）。
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
  const t = el('b'); t.textContent = '总体编辑';
  const close = el('button', 'eph-modal-close'); close.textContent = '✕';
  hd.appendChild(t); hd.appendChild(close);
  // 默认/优化滑块
  const tabThumb = el('span', 'eph-tabs-thumb');
  const tabs = el('div', 'eph-tabs');
  const tabDefault = el('button', 'eph-tab active'); tabDefault.textContent = '默认提示词';
  const tabOptimized = el('button', 'eph-tab'); tabOptimized.textContent = '优化提示词';
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
  const indentL = el('label'); indentL.textContent = '缩进';
  const indentIn = el('input', 'eph-indent-input'); indentIn.value = '0'; indentIn.title = '首行缩进';
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
  // 工具 / 插入引用（与卡片一致）
  const toolsGroup = el('div', 'eph-tb-group');
  const toolsBtn = el('button', 'eph-btn'); toolsBtn.textContent = '工具';
  const toolsDD = el('div', 'eph-tools-dropdown');
  toolsGroup.appendChild(toolsBtn); toolsGroup.appendChild(toolsDD); toolbar.appendChild(toolsGroup);
  const refGroup = el('div', 'eph-tb-group');
  const refBtn = el('button', 'eph-btn'); refBtn.textContent = '插入引用';
  const refDD = el('div', 'eph-tools-dropdown');
  refGroup.appendChild(refBtn); refGroup.appendChild(refDD); toolbar.appendChild(refGroup);
  const collapseBtn = el('button', 'eph-btn'); collapseBtn.textContent = '收起小标题'; collapseBtn.title = '折叠/展开每张卡片的小标题行';
  collapseBtn.addEventListener('click', (e) => { e.stopPropagation(); const m = _allModal; if (m) { m.classList.toggle('collapsed'); collapseBtn.textContent = m.classList.contains('collapsed') ? '展开小标题' : '收起小标题'; } });
  toolbar.appendChild(collapseBtn);
  const addCardBtn = el('button', 'eph-btn success'); addCardBtn.textContent = '＋ 新增卡片'; toolbar.appendChild(addCardBtn);
  const editor = el('div', 'eph-all-editor'); editor.contentEditable = 'true';
  attachMention(editor, () => _allModal._node);
  const ft = el('div', 'eph-all-ft');
  const cancelBtn = el('button', 'eph-btn eph-btn-cancel'); cancelBtn.textContent = '取消';
  const saveBtn = el('button', 'eph-btn eph-btn-save'); saveBtn.textContent = '保存';
  ft.appendChild(cancelBtn); ft.appendChild(saveBtn);
  box.appendChild(hd); box.appendChild(tabs); box.appendChild(toolbar); box.appendChild(editor); box.appendChild(ft);
  _allModal.appendChild(box); document.body.appendChild(_allModal);
  _allModal._box = box; _allModal._ed = editor; _allModal._indentIn = indentIn;
  _allModal._tabDefault = tabDefault; _allModal._tabOptimized = tabOptimized; _allModal._tabThumb = tabThumb;
  _allModal._hlDD = hlDD; _allModal._fcDD = fcDD; _allModal._toolsDD = toolsDD; _allModal._refDD = refDD;
  close.addEventListener('click', () => { _phActiveEditor = null; _allModal.classList.remove('active'); });
  cancelBtn.addEventListener('click', () => { _phActiveEditor = null; _allModal.classList.remove('active'); });
  saveBtn.addEventListener('click', () => saveAllEditor());
  tabDefault.addEventListener('click', () => switchAllTab('default'));
  tabOptimized.addEventListener('click', () => switchAllTab('optimized'));
  toolbar.addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (b) { execCommandOn(editor, b.dataset.cmd); e.preventDefault(); } });
  indentIn.addEventListener('change', () => { editor.querySelectorAll('.eph-all-block-body').forEach((x) => { const n = parseFloat(indentIn.value) || 0; x.style.textIndent = n ? n + 'em' : ''; }); });
  addCardBtn.addEventListener('click', () => { const nd = _allModal._node; if (nd) { addCard(nd); openAllEditor(nd); } });
  // 工具 / 插入引用下拉
  [['查找替换', 'find'], ['全角符号转半角', 'fullToHalf'], ['半角符号转全角', 'halfToFull'], ['优化提示词 (API)', 'api'], ['优化提示词 (llama)', 'llama']].forEach(([t, id]) => { const b = el('button', 'eph-tool-item'); b.textContent = t; b.addEventListener('click', () => { if (id === 'api' || id === 'llama') { runBatchOptimize(_allModal && _allModal._node, id); } else if (id === 'find') { openFindModal('find', _allModal && _allModal._ed); } else { runToolOn(editor, id); } toolsDD.classList.remove('active'); }); toolsDD.appendChild(b); });
  addMediaFileItems(refDD, editor, (_m) => insertMediaRef(editor, _m), _allModal._node);
  const closeAllDD = (e) => { if (!toolsDD.contains(e.target) && e.target !== toolsBtn) toolsDD.classList.remove('active'); if (!refDD.contains(e.target) && e.target !== refBtn) refDD.classList.remove('active'); };
  toolsBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); toolsDD.classList.toggle('active'); refDD.classList.remove('active'); if (toolsDD.classList.contains('active')) phFixedDD(toolsBtn, toolsDD); });
  refBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); refDD.classList.toggle('active'); toolsDD.classList.remove('active'); if (refDD.classList.contains('active')) { phFixedDD(refBtn, refDD); addMediaFileItems(refDD, editor, (_m) => insertMediaRef(editor, _m), _allModal._node); } });
  // 点弹窗外空白自动保存关闭；卡片内部拖动到外面松开不关（只在外面点击才关）
  let _allStartInBox = false;
  _allModal.addEventListener('mousedown', (e) => { _allStartInBox = box.contains(e.target); });
  _allModal.addEventListener('mouseup', (e) => { if (e.target === _allModal && !_allStartInBox) saveAllEditor(); _allStartInBox = false; });
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
    st.cards.forEach((c) => { c.useOptimized = good; });
    syncToConfig(nd);
    renderAllEditor(nd);
  }
}
function syncAllContent(nd) {
  const st = stateFor(nd);
  const blocks = _allModal._ed.querySelectorAll('.eph-all-block');
  Array.from(blocks).forEach((b, i) => {
    const card = st.cards[i]; if (!card) return;
    const body = b.querySelector('.eph-all-block-body');
    const html = body ? body.innerHTML : b.innerHTML;
    const plain = plainTextOf(html);
    if (_allTab === 'optimized') { card.contentOptimizedHTML = html; card.contentOptimized = plain; }
    else { card.contentHTML = html; card.content = plain; }
  });
  syncToConfig(nd); updatePorts(nd); refreshUI(nd);
}
function phRulesModel(node) { try { return (readConfig(node, {}).rules) || {}; } catch (_) { return {}; } }
function formatTimeText(model, start, end) {
  const s = String(start || '').trim(), e = String(end || '').trim();
  if (!s && !e) return '';
  const num = parseFloat(s) || 0;
  const mm = String(Math.floor(num / 60)).padStart(2, '0'), ss = String(Math.floor(num % 60)).padStart(2, '0');
  if (model === 'MiniMax H3') return `[Shot] At ${mm}:${ss}.000`;
  if (model === 'Seedance') return `${s}-${(e || s)}s:`;
  if (model === 'Wan 2.6') return `${s}-${(e || s)}s`;
  if (model === 'Seedance 2.5') return e ? `${s}-${e}s` : `[${s}s]`;
  return e ? `[${s}-${e}s]` : `[${s}s]`;
}
function renderAllEditor(node) {
  const st = stateFor(node);
  const m = allEl(); const ed = m._ed;
  const rules = phRulesModel(node);
  ed.innerHTML = '';
  if (!st.cards.length) {
    ed.appendChild(el('div', 'eph-all-empty')).textContent = '暂无提示词卡片，点上面「＋ 新增卡片」添加。';
    return;
  }
  st.cards.forEach((card, idx) => {
    const block = el('div', 'eph-all-block'); block.dataset.idx = String(idx);
    // 左侧小标题行：序号 / 标题(可编辑) / 时间轴 / 删除(-)
    const rw = el('div', 'eph-all-block-hd'); rw.contentEditable = 'false';
    const num = el('span', 'eph-all-num'); num.textContent = String(idx + 1);
    const titleEl = el('span', 'eph-all-title'); titleEl.contentEditable = 'true'; titleEl.setAttribute('data-ph', '标题');
    titleEl.textContent = card.title || '';
    titleEl.addEventListener('input', () => { card.title = titleEl.textContent.replace(/\u200b/g, ''); syncToConfig(node); });
    const tsStart = el('input', 'eph-all-ts'); tsStart.value = card.timelineStart || ''; tsStart.title = '时间轴开始';
    const tsDash = el('span'); tsDash.textContent = '－';
    const tsEnd = el('input', 'eph-all-ts'); tsEnd.value = card.timelineEnd || ''; tsEnd.title = '时间轴结束';
    const tsPreview = el('span', 'eph-all-tspreview'); tsPreview.textContent = '';
    const updTs = () => { tsPreview.textContent = formatTimeText(rules.tsModel, tsStart.value, tsEnd.value); };
    [tsStart, tsEnd].forEach((inp) => { inp.addEventListener('input', () => { card.timelineStart = tsStart.value.trim(); card.timelineEnd = tsEnd.value.trim(); syncToConfig(node); tsStart.style.display = (card.timelineStart || card.timelineEnd) ? '' : 'none'; tsEnd.style.display = (card.timelineStart || card.timelineEnd) ? '' : 'none'; updTs(); }); });
    const timeEl = el('span', 'eph-all-time');
    timeEl.appendChild(tsStart); timeEl.appendChild(tsDash); timeEl.appendChild(tsEnd); timeEl.appendChild(el('span')).textContent = 's'; timeEl.appendChild(tsPreview);
    updTs();
    const delEl = el('button', 'eph-all-del'); delEl.textContent = '－'; delEl.title = '删除此卡片';
    delEl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); deleteCard(node, card.id); renderAllEditor(node); });
    rw.appendChild(num); rw.appendChild(titleEl); rw.appendChild(timeEl); rw.appendChild(delEl);
    block.appendChild(rw);
    // 下方内容（按当前页签）
    const body = el('div', 'eph-all-block-body');
    body.innerHTML = (_allTab === 'optimized') ? (card.contentOptimizedHTML || card.contentOptimized || '') : (card.contentHTML || card.content || '');
    block.appendChild(body);
    ed.appendChild(block);
  });
  // 重新应用总体缩进：render 重建全部块，需按当前缩进值还原（新增卡片后不丢失）。
  const ni = parseFloat(m._indentIn.value) || 0;
  ed.querySelectorAll('.eph-all-block-body').forEach((x) => { x.style.textIndent = ni ? ni + 'em' : ''; });
}
function openAllEditor(node) {
  const m = allEl(); m._node = node;
  _allTab = 'default';
  _phActiveEditor = m._ed;   // 让颜色等工具作用到总体编辑
  renderAllEditor(node);
  requestAnimationFrame(moveAllTabThumb);
  m.classList.add('active');
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
}
// 总体编辑「工具→优化提示词」：合并所有卡片内容为一份，单次调用（textgen 需运行期用 CLIP，故不在此列）。
async function runBatchOptimize(node, method) {
  if (!node) return;
  const st = stateFor(node);
  const cfg = optimizeFor(node);
  if (method === 'api' && cfg.provider !== 'Ollama' && !cfg.apiKey) { window.alert('调用「优化提示词 (API)」需要先在「调用设置」里填写该厂商的 API Key。'); return; }
  const parts = [];
  st.cards.forEach((c) => { const s = (c.content || plainTextOf(c.contentHTML || '')).trim(); if (s) parts.push(s); });
  if (!parts.length) { window.alert('没有可优化的卡片内容。'); return; }
  const merged = parts.join('\n\n');
  phProgShow(node, 1, '总体优化');
  phProgTick(node, 0, '合并 ' + parts.length + ' 张卡片，单次调用…');
  const payload = { method, prompt: merged, skill: cfg.skill || '', provider: cfg.provider || '', model: cfg.model || '', apiUrl: cfg.apiUrl || '', apiKey: cfg.apiKey || '', proxy: cfg.proxy || '', image: '', textgen: cfg.textgen || {}, llama: cfg.llama || {}, clearCache: !!cfg.clearCache };
  try {
    const r = await fetchApi('/prompt_helper/optimize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) { phProgErr(node, d.error || ('HTTP ' + r.status)); window.alert('优化失败：' + (d.error || ('HTTP ' + r.status))); return; }
    const out = d.text || '';
    const outHtml = plainTextToHtml(out);
    st.cards.forEach((c) => { c.contentOptimized = out; c.contentOptimizedHTML = outHtml; });
    phProgDone(node);
    syncToConfig(node); updatePorts(node); refreshUI(node);
    _allTab = 'optimized'; if (_allModal && _allModal.classList.contains('active')) switchAllTab('optimized');
  } catch (e) { phProgErr(node, (e && e.message ? e.message : e)); window.alert('优化请求失败：' + (e && e.message ? e.message : e)); }
}

// ===== 面板 =====
function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'eph-shell');
  const root = el('div', 'eph-root');
  shell.appendChild(root);
  node._ezRoot = shell;
  const hd = el('div', 'eph-hd');
  const allBtn = el('button', 'eph-btn primary'); allBtn.textContent = '总体编辑';
  const settingsBtn = el('button', 'eph-btn'); settingsBtn.textContent = '调用设置';
  const rulesBtn = el('button', 'eph-btn'); rulesBtn.textContent = '规则设置';
  const skillBtn = el('button', 'eph-btn'); skillBtn.textContent = 'skill设置';
  const progBtn = el('button', 'eph-btn'); progBtn.textContent = '进度'; progBtn.title = '查看优化进度';
  const addBtn = el('button', 'eph-btn'); addBtn.textContent = '＋ 新增提示词卡片';
  hd.appendChild(allBtn); hd.appendChild(settingsBtn); hd.appendChild(rulesBtn); hd.appendChild(skillBtn); hd.appendChild(progBtn); hd.appendChild(addBtn);
  const list = el('div', 'eph-list');
  root.appendChild(hd); root.appendChild(list);
  root._list = list;
  root._skillBtn = skillBtn;
  addBtn.addEventListener('click', () => addCard(node));
  settingsBtn.addEventListener('click', () => openSettings(node));
  allBtn.addEventListener('click', () => openAllEditor(node));
  rulesBtn.addEventListener('click', () => openRules(node));
  skillBtn.addEventListener('click', () => openSkillBrowser(node));
  progBtn.addEventListener('click', (e) => { e.stopPropagation(); phProgToggle(node); });
  // 键盘 Ctrl+F / Ctrl+H（卡片或总体编辑打开时都可用）
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
  const sb = root._skillBtn;
  if (sb) sb.classList.toggle('skill-on', !!(optimizeFor(node).skillFile));
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
    if (!rootEl || !rootEl.isConnected) { node._ephOutRaf = requestAnimationFrame(update); return; }
    if (app && app.graph && node.graph !== app.graph) {
      (node._ephOutEls || []).forEach((x) => { try { x.el.style.display = 'none'; } catch (_) {} });
      node._ephOutRaf = requestAnimationFrame(update);
      return;
    }
    let rect = null;
    try { rect = rootEl.getBoundingClientRect(); } catch (_) { node._ephOutRaf = requestAnimationFrame(update); return; }
    if (!rect || rect.width <= 0) { node._ephOutRaf = requestAnimationFrame(update); return; }
    const nodeW0 = (node.size && node.size[0]) || 1;
    const sx0 = rect.width / nodeW0;
    if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight || sx0 < 0.3) {
      all.forEach((item) => { item.el.style.display = 'none'; });
      node._ephOutRaf = requestAnimationFrame(update);
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
    node._ephOutRaf = requestAnimationFrame(update);
  };
  update();
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
function setupNode(node) {
  if (!node || node._ezPhSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') return;
    node._ezPhSetup = true;
    loadFromConfig(node);
    const root = buildRoot(node);
    node._ezRoot = root;
    makeDomWidgetHitThrough(root);
    const widget = node.addDOMWidget('提示词卡片', 'eph-panel', root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 120, getValue: () => '{}', setValue: () => {} });
    makeDomWidgetHitThrough(widget.element || root);
    node.widgets_start_y = 0;
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
    installResizeHandles(node, root);
    try { node.setSize([430, Math.max(120, Math.min(240, node.size ? node.size[1] : 120))]); } catch (_) {}
    hideConfigWidget(node);
    updatePorts(node, true);
    setTimeout(() => updatePorts(node), 80);
    installSocketLabels(node);
  } catch (e) { console.error('[PromptHelper] init failed:', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__ezPhHooked) return; nt.__ezPhHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = prevCfg ? prevCfg.apply(this, arguments) : undefined; loadFromConfig(this); updatePorts(this, true); refreshUI(this); return r; };
  const prevConn = nt.prototype.onConnectionsChange; nt.prototype.onConnectionsChange = function (type, index, connected, link_info) {
    const r = prevConn ? prevConn.apply(this, arguments) : undefined;
    try { if (this._ezPhSetup) setTimeout(() => { updatePorts(this); refreshUI(this); }, 0); } catch (_) {}
    return r;
  };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; unregisterNode(this); try { if (this._ezPhSyncTimer) clearTimeout(this._ezPhSyncTimer); } catch (_) {} try { if (this._ephOutRaf) cancelAnimationFrame(this._ephOutRaf); } catch (_) {} try { (this._ephOutEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); } catch (_) {} try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {} this._ezPhSetup = false; return r; };
  const prevAdded = nt.prototype.onAdded; nt.prototype.onAdded = function () { const r = prevAdded ? prevAdded.apply(this, arguments) : undefined; registerNode(this); return r; };
}
app.registerExtension({
  name: 'Comfy.EzFlex.PromptHelper',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() { ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); },
});
