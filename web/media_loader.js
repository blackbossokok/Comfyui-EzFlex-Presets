// EzFlex-MediaLoader 素材加载器（内嵌 addDOMWidget 面板）。
// 数据模型（config widget JSON）：{ groups:[{id,name,cards:[{id,name,items:[{id,files:[{id,name,path,subfolder,dir,type}]}]}]}],
//   currentGroupId, currentPreset }。
// 面板结构仿 ModelsCombo/PreviewAny：透明外壳 .eml-shell 撑满节点，内层 .eml-root 带 margin 内缩露 socket。
// 每张「素材卡片」对应一个深红 * 输出端口，标签 = 分组名_卡片名，带半透明黑框标签叠加层。
// 文件来源：服务器 input 目录（/media_loader/files），非浏览器本地文件（无法拿到服务器路径）。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ezPruneDanglingLinks } from "./ezflex_service.js";
import { NODE_TYPES, nodeTypeOf, configWidget, installResizeHandles, makeDomWidgetHitThrough, installEdgeLabels, hideNativeSlotText, uiPrompt, uiConfirm, makeAudioPlayer, notifyConfigChanged, scheduleOnRedraw, pumpFrames, EZ_PERF, ezPushModal, ezPopModal, ezIsTopModal, TYPE_ICONS } from "./ezflex_service.js";
import { ezT, onLocaleChange } from "./ezflex_i18n.js";
import { ezThemeInit } from "./ezflex_theme.js";

const NODE = NODE_TYPES.MEDIA_LOADER;
const PRESET_API = "/media_loader/presets";
// 固定模式：槽位类型（顺序 = 下拉顺序）+ 内置预设 minimaxH3（对应 H3 的 ref_images / ref_videos / ref_video_audios / ref_audios）
const FIXED_TYPES = [['image', 'Image'], ['video', 'Video'], ['audio', 'Audio'], ['text', 'Text'], ['model3d', 'Model'], ['other', 'Other']];
const FIXED_DEFAULT_SLOTS = [{ type: 'image', n: 9 }, { type: 'video', n: 3 }, { type: 'audio', n: 3 }, { type: 'text', n: 0 }, { type: 'model3d', n: 0 }, { type: 'other', n: 0 }];
const FIXED_ZERO_SLOTS = FIXED_TYPES.map((t) => ({ type: t[0], n: 0 }));
const FIXED_BUILTIN = { default: FIXED_ZERO_SLOTS, minimaxH3: FIXED_DEFAULT_SLOTS };   // 内置预设（不可删）
const OUTPUT_API = "/media_loader/outputs";
// 卡片口专属类型：与 Python 侧 _MEDIA_CARD 一致（传的是卡片对象，只能接 EzFlex-MediaOut）
const CARD_TYPE = 'EZFLEX_MEDIA_CARD';
const CARD_COLOR = '#d94848';   // 深红（原来靠 '*' 的默认色，现在自定义类型自己上色）
// 输出口文件名黑框标签开关：绿=显示、灰=隐藏（localStorage 全局偏好）
const ML_LABELS_LS = 'ezflex.mlLabels';
let _mlLabels = null;
function mlLabelsOn() { if (_mlLabels === null) { try { _mlLabels = window.localStorage.getItem(ML_LABELS_LS) !== '0'; } catch (_) { _mlLabels = true; } } return _mlLabels; }
function mlLabelsSet(on) {
  _mlLabels = !!on;
  try { window.localStorage.setItem(ML_LABELS_LS, _mlLabels ? '1' : '0'); } catch (_) {}
  document.querySelectorAll('.eml-lblbtn').forEach((b) => { b.style.background = _mlLabels ? 'var(--ez-ok-bg)' : ''; b.style.borderColor = _mlLabels ? 'var(--ez-ok-border)' : ''; b.style.color = _mlLabels ? 'var(--ez-ok-fg)' : ''; });
  try { if (app && app.graph) app.graph.setDirtyCanvas(true, true); } catch (_) {}
}
const MIN_WIDTH = 680;

const CSS = `
.eml-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.eml-shell .eml-root{pointer-events:auto;}
.eml-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--ez-fg);background:var(--ez-bg);border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.eml-root *{box-sizing:border-box;user-select:none;-webkit-user-select:none;}
.eml-top{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;min-width:0;flex-shrink:0;} /* 顶部工具栏单行不换行（到「加载输出」为止） */
.eml-preset{appearance:none;-webkit-appearance:none;min-width:140px;height:32px;padding:4px 32px 4px 14px;border:1px solid var(--ez-border);border-radius:999px;background:var(--ez-surface-2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7a8e' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 14px center;font-size:12px;color:var(--ez-fg);cursor:pointer;flex:0 0 auto;outline:none;box-shadow:none;}
.eml-preset:focus,.eml-preset:active,.eml-preset:hover{border-color:var(--ez-strong);outline:none;box-shadow:none;background-color:var(--ez-bg);}
.eml-preset-btn{appearance:none;-webkit-appearance:none;min-width:150px;height:32px;padding:4px 32px 4px 14px;border:1px solid var(--ez-border);border-radius:999px;background:var(--ez-surface-2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7a8e' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 14px center;font-size:12px;color:var(--ez-fg);cursor:pointer;outline:none;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:inherit;}
.eml-preset-btn:focus,.eml-preset-btn:hover{border-color:var(--ez-strong);background-color:var(--ez-bg);}
.eml-preset-menu{display:none;position:absolute;top:36px;left:0;z-index:1200;min-width:160px;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:4px;max-height:260px;overflow:auto;}
.eml-preset-menu.open{display:block;}
.eml-num::-webkit-outer-spin-button,.eml-num::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.eml-num{-moz-appearance:textfield;appearance:textfield;}
.eml-preset-item{padding:6px 12px;font-size:12px;color:var(--ez-fg);border-radius:8px;cursor:pointer;white-space:nowrap;font-family:inherit;}
.eml-preset-item:hover{background:var(--ez-surface-3);}
.eml-preset-item.active{background:rgba(43,58,74,.08);font-weight:600;color:var(--ez-fg-2);}
.eml-btn{background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:var(--ez-fg);font-family:inherit;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;height:30px;line-height:1;}
.eml-btn:hover{background:var(--ez-surface-3);border-color:var(--ez-border-strong);}
.eml-btn.primary{background:var(--ez-strong);border-color:var(--ez-strong);color:var(--ez-on-strong);}
.eml-btn.danger{background:var(--ez-bad-bg);border-color:var(--ez-bad-border);color:var(--ez-bad-fg);}
.eml-tabs{display:flex;align-items:center;gap:4px;overflow-x:auto;padding-bottom:4px;border-bottom:1px solid var(--ez-border-2);flex-shrink:0;min-height:28px;}
.eml-tab{padding:4px 12px;font-size:12px;border-radius:8px 8px 0 0;border:1px solid transparent;border-bottom:none;color:var(--ez-fg-3);cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:4px;background:transparent;transition:.12s;}
.eml-tab.active{background:var(--ez-surface-3);color:var(--ez-fg);border-color:var(--ez-border-2);font-weight:600;}
.eml-tab .tname{outline:none;font:inherit;background:transparent;border:none;color:inherit;min-width:26px;padding:0 2px;}
.eml-tab .tclose{font-size:12px;color:var(--ez-fg-muted);cursor:pointer;line-height:1;}
.eml-tab .tclose:hover{color:var(--ez-bad-fg);}
.eml-addtab{background:transparent;border:1px dashed var(--ez-border);border-radius:8px;padding:3px 12px;font-size:12px;color:var(--ez-fg-3);cursor:pointer;white-space:nowrap;}
.eml-cards{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;}
.eml-card{background:var(--ez-surface);border:1px solid var(--ez-border);border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.03);padding:9px 12px 12px;transition:.15s;flex:0 0 auto;}   /* 别在 .eml-cards 这个滚动 flex 里被压缩，否则滚不到底 */
.eml-card:hover{box-shadow:0 4px 14px rgba(0,0,0,.06);}
.eml-card.dragging{opacity:.4;}
.eml-card-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px dashed var(--ez-border-2);touch-action:none;}
.eml-grip{flex:0 0 auto;width:16px;color:var(--ez-fg-3);cursor:grab;font-size:13px;text-align:center;user-select:none;-webkit-user-select:none;transition:.12s;}
.eml-grip:hover{color:var(--ez-fg);}
.eml-grip:active{cursor:grabbing;}
.eml-card.mgr{outline:2px dashed var(--ez-border-strong);outline-offset:-2px;}
.eml-card.mgr .ctitle{color:var(--ez-fg-muted);}
.eml-card.mgr-sel{background:rgba(59,130,246,.22);box-shadow:0 0 0 3px rgba(59,130,246,.72);}
.eml-media.mgr-sel{border-color:rgba(59,130,246,.95);box-shadow:0 0 0 3px rgba(59,130,246,.9);background:rgba(59,130,246,.2);}
.eml-media.mgr-sel .info{border-top:1px solid rgba(59,130,246,.7);background:var(--ez-surface);}
.eml-slot{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:1px dashed var(--ez-border-strong);border-radius:10px;background:var(--ez-surface-2);cursor:pointer;min-height:72px;opacity:.85;}
.eml-slot:hover{border-color:var(--ez-strong);background:var(--ez-surface-3);opacity:1;}
.eml-media.drop-target{box-shadow:0 0 0 3px rgba(34,197,94,.72);background:rgba(34,197,94,.16);}
.eml-media.dragging{opacity:.5;}
.eml-tab.mgr-sel{background:rgba(59,130,246,.2);border-color:rgba(59,130,246,.7);color:var(--ez-info-fg);}
.eml-managerbar{display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--ez-surface-3);border:1px solid var(--ez-border);border-radius:9px;font-size:12px;color:var(--ez-fg);flex-shrink:0;position:sticky;top:0;z-index:8;flex-wrap:wrap;}
.eml-bb-item.sel{background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.65);box-shadow:0 0 0 2px rgba(59,130,246,.5);}
.eml-bbtrow{display:flex;align-items:center;gap:4px;padding:6px 10px;cursor:pointer;border-left:3px solid transparent;font-size:12px;color:var(--ez-fg);white-space:nowrap;}
.eml-bbtrow:hover{background:var(--ez-surface-3);}
.eml-bbtrow.sel{background:rgba(43,58,74,.1);border-left-color:var(--ez-strong);color:var(--ez-fg-2);font-weight:500;}
.eml-bbtwist{width:16px;height:16px;display:flex;align-items:center;justify-content:center;transition:transform .2s;color:var(--ez-fg-muted);font-size:10px;flex-shrink:0;}
.eml-bbtwist.expanded{transform:rotate(90deg);}
.eml-bbtwist.leaf{opacity:0;pointer-events:none;}
.eml-bbficon{color:var(--ez-fg-muted);font-size:12px;flex-shrink:0;display:flex;align-items:center;}
.eml-bbtrow.sel .eml-bbficon{color:var(--ez-fg-2);}
.eml-bbfname{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;}
.eml-card-head .ctitle{font-size:14px;font-weight:600;color:var(--ez-fg);flex:1 1 auto;min-width:60px;outline:none;border:none;background:transparent;padding:2px 6px;border-radius:5px;cursor:default;}
.eml-card-head .ctitle.editing{cursor:text;background:var(--ez-bg);box-shadow:0 0 0 2px var(--ez-border);}
.eml-card-head .cdel{border:none;background:transparent;color:var(--ez-fg-3);font-size:12px;cursor:pointer;padding:2px 6px;border-radius:5px;}
.eml-card-head .cdel:hover{background:var(--ez-bad-bg);color:var(--ez-bad-fg);}
.eml-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;min-height:80px;position:relative;border-radius:8px;align-items:start;}
.eml-grid.dz{box-shadow:0 0 0 3px rgba(34,197,94,.72);}
.eml-grid .eml-drop-line{width:3px;background:var(--ez-strong);border-radius:2px;opacity:0;pointer-events:none;z-index:5;}
@media (max-width:920px){.eml-grid{grid-template-columns:repeat(3,1fr);}}
@media (max-width:640px){.eml-grid{grid-template-columns:repeat(2,1fr);}}
.eml-media{background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:9px;display:flex;flex-direction:column;min-height:192px;position:relative;cursor:pointer;transition:.15s;}
.eml-media:hover{border-color:var(--ez-border);box-shadow:0 4px 12px rgba(0,0,0,.06);}
.eml-media.mgr-sel:hover{border-color:rgba(59,130,246,.95);box-shadow:0 0 0 3px rgba(59,130,246,.9);background:rgba(59,130,246,.2);}
.eml-media .pv{width:100%;background:var(--ez-surface-3);display:flex;align-items:center;justify-content:center;position:relative;aspect-ratio:16/9;overflow:hidden;flex-shrink:0;border-radius:8px;}
.eml-media:hover .pv{border-radius:8px 8px 0 0;}   /* 底栏浮出时预览底角收平，别让圆角从底栏边上露出来 */
.eml-media.playing .pv{border-radius:8px;}
.eml-media .pv img,.eml-media .pv video{border-radius:0;}
.eml-media .pv img{width:100%;height:100%;object-fit:contain;background:var(--ez-surface-3);object-position:center;display:block;}
.eml-media .pv video{width:100%;height:100%;object-fit:contain;background:var(--ez-surface-3);object-position:center;}
.eml-media .pv audio{width:100%;height:44px;background:var(--ez-surface-4);border-radius:0;}
.eml-media .pv .ph{font-size:28px;color:var(--ez-fg-muted);opacity:.6;}
.eml-media .type-badge{position:absolute;top:5px;left:5px;background:var(--ez-surface);border-radius:30px;padding:1px 8px;font-size:10px;font-weight:600;color:var(--ez-fg);box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid var(--ez-border-2);pointer-events:none;z-index:3;}
.eml-media .rm{position:absolute;top:3px;right:3px;background:var(--ez-surface);border:none;border-radius:50%;width:20px;height:20px;font-size:11px;line-height:20px;text-align:center;color:var(--ez-fg-muted);cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.1);z-index:6;display:flex;align-items:center;justify-content:center;padding:0;opacity:0;transition:.12s;}
.eml-media:hover .rm{opacity:1;}
.eml-media .rm:hover{background:var(--ez-bad-bg);color:var(--ez-bad-fg);}
.eml-media .stack-badge{position:absolute;bottom:5px;right:5px;background:var(--ez-strong);color:var(--ez-on-strong);font-size:10px;padding:1px 8px;border-radius:20px;pointer-events:none;z-index:5;}
.eml-media .info{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:2px;padding:5px 8px 6px;background:var(--ez-surface);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-top:1px solid rgba(255,255,255,.5);border-radius:0 0 8px 8px;opacity:0;transform:translateY(4px);transition:.15s;pointer-events:none;z-index:5;}
.eml-media:hover .info{opacity:1;transform:none;}
.eml-media.playing .info{opacity:0;transform:translateY(4px);pointer-events:none;}
.eml-media.playing:hover .info{opacity:0;}
.eml-media .eml-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--ez-strong);color:var(--ez-on-strong);border:none;border-radius:50%;width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:6;font-size:16px;padding:0;opacity:0;pointer-events:none;transition:.15s;font-family:inherit;}
.eml-media:hover .eml-play{opacity:1;pointer-events:auto;}
.eml-media.playing .eml-play{opacity:0;pointer-events:none;}
.eml-media audio,.eml-pvmain audio{background:var(--ez-bg) !important;border-radius:8px;color-scheme:light;}
.eml-media audio::-webkit-media-controls-panel,.eml-pvmain audio::-webkit-media-controls-panel,.eml-media audio::-webkit-media-controls-enclosure,.eml-pvmain audio::-webkit-media-controls-enclosure{background:var(--ez-bg) !important;border-radius:8px;}
.eml-media audio::-webkit-media-controls-timeline,.eml-pvmain audio::-webkit-media-controls-timeline{background:var(--ez-bg);border-radius:4px;}
.eml-media .info .fname{font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ez-fg);}
.eml-root input[type=number]{-moz-appearance:textfield;appearance:textfield;}
.eml-root input[type=number]::-webkit-inner-spin-button,.eml-root input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
.eml-media .info .fmeta{font-size:10px;color:var(--ez-fg-3);display:flex;justify-content:space-between;}
.eml-media .info .fmeta .suffix{background:var(--ez-surface);padding:0 6px;border-radius:4px;border:1px solid rgba(255,255,255,.6);}
.eml-empty{background:var(--ez-surface);border:2px dashed var(--ez-border);border-radius:9px;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:192px;cursor:pointer;transition:.15s;color:var(--ez-fg-muted);gap:4px;}
.eml-empty:hover{border-color:var(--ez-border-strong);background:var(--ez-surface-3);}
.eml-empty .big{font-size:28px;font-weight:300;line-height:1;}
.eml-addbar{margin-top:8px;padding:8px 0;border-top:1px solid var(--ez-border-2);text-align:center;cursor:pointer;color:var(--ez-fg-3);font-size:13px;opacity:.6;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;}
.eml-addbar:hover{opacity:1;background:var(--ez-surface-3);}
/* 添加素材的浏览器：控件/图片/文字都不允许高亮选中（输入框除外，仍可选中输入的文字） */
.eml-browse{user-select:none;-webkit-user-select:none;}
.eml-browse input,.eml-browse textarea{user-select:text;-webkit-user-select:text;}
.eml-browse img{-webkit-user-drag:none;user-drag:none;}
.eml-socket-label{position:fixed;z-index:20;pointer-events:none;background:rgba(12,16,24,.4);color:#eef1f6;font-size:9px;line-height:1;padding:2px 6px;border-radius:3px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;user-select:none;display:inline-flex;align-items:center;}
.eml-socket-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;margin-right:5px;border:1px solid rgba(255,255,255,.3);}
`;

let _styleInjected = false;
let _widgetSeq = 0;
function injectStyle() {
  ezThemeInit(); if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function nextWidgetType() { _widgetSeq += 1; return 'eml-config__' + _widgetSeq.toString(36); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
function genId() { return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function uiToast(msg) {
  const t = el('div');
  t.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:var(--ez-strong);color:var(--ez-on-strong);padding:8px 20px;border-radius:30px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.2);z-index:10000;opacity:0;transition:opacity .3s;pointer-events:none;';
  t.textContent = msg; document.body.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; });
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2000);
}

// ===== 状态 / config =====
function stateFor(node) { if (!node._eml) node._eml = { groups: [], currentGroupId: null, currentPreset: 'default', gridCols: 3, gridRowH: 1, mode: 'card', merge: false, mergeScope: 'card', mergeTypes: { image: true, audio: true, other: true }, mergeFit: { size: 'first', fit: 'crop', cap: 0, start: 0 }, fixed: { on: false, current: 'minimaxH3', slots: FIXED_DEFAULT_SLOTS.map((s) => ({ type: s.type, n: s.n })) } }; return node._eml; }
function configWidgetOf(node) { return configWidget(node); }
function syncToConfig(node) {
  const st = stateFor(node); const w = configWidgetOf(node); if (!w) return;
  const json = JSON.stringify({ groups: st.groups, currentGroupId: st.currentGroupId, currentPreset: st.currentPreset, gridCols: st.gridCols || 3, gridRowH: (st.gridRowH == null ? 1 : st.gridRowH), mode: st.mode || 'card', merge: !!st.merge, mergeScope: st.mergeScope || 'card', mergeTypes: st.mergeTypes || { image: true, audio: true, other: true }, mergeFit: st.mergeFit || { size: 'first', fit: 'crop', cap: 0, start: 0 }, fixed: { on: !!(st.fixed && st.fixed.on), current: (st.fixed && st.fixed.current) || 'minimaxH3', slots: (st.fixed && st.fixed.slots) || [] } });
  w.value = json; if (typeof w.callback === 'function') w.callback(json);
  // 后端只认 config widget 的值：命名查找可能命中隐藏/重复的那个，这里对「第 0 个 config widget」再写一遍，保证执行与界面看的是同一份
  try { const w0 = (node.widgets || [])[0]; if (w0 && w0 !== w && w0.name === 'config') { w0.value = json; if (typeof w0.callback === 'function') w0.callback(json); } } catch (_) {}
  try { node.properties = node.properties || {}; node.properties.ezMediaConfig = json; } catch (_) {}   // 权威副本：widget 顺序/前端差异都可能让 widgets_values 错位，properties 一定随工作流走
  if (node.graph) node.graph.setDirtyCanvas(true, true); notifyConfigChanged(node);
}
function loadFromConfig(node) {
  const st = stateFor(node); const w = configWidgetOf(node);
  let data = {};
  const raw = (() => {
    // 后端读的是 widget；前端副本可能更新（properties），取「信息更多」的那份，避免界面固定槽位、执行还是普通顺序
    const wv = w ? (w.value || '{}') : '{}';
    try { const p = node.properties && node.properties.ezMediaConfig; if (typeof p === 'string' && p.length > wv.length) return p; } catch (_) {}
    return wv;
  })();
  try { data = JSON.parse(raw || '{}') || {}; } catch (_) { data = {}; }
  st.groups = Array.isArray(data.groups) ? data.groups : [];
  // 文件类型以扩展名为准：卡片里存的 type 可能是旧值/猜错的，会让预览、端口类型、编号都跑偏。
  st.groups.forEach((g) => (g.cards || []).forEach((c) => (c.items || []).forEach((it) => (it.files || []).forEach((f) => { const k = mediaKind(f.name || f.path); if (k !== 'other') f.type = k; }))));
  st.currentPreset = data.currentPreset || 'default';
  st.gridCols = Math.max(1, parseInt(data.gridCols, 10) || 3);
  st.gridRowH = parseFloat(data.gridRowH); if (!isFinite(st.gridRowH)) st.gridRowH = 1; st.gridRowH = Math.max(0, st.gridRowH);
  st.mode = ['card', 'row', 'group'].indexOf(data.mode) >= 0 ? data.mode : 'card';
  st.merge = !!data.merge;
  st.mergeScope = ['card', 'row', 'group'].indexOf(data.mergeScope) >= 0 ? data.mergeScope : 'card';
  st.mergeTypes = Object.assign({ image: true, audio: true, other: true }, (data.mergeTypes && typeof data.mergeTypes === 'object') ? data.mergeTypes : {});
  st.mergeFit = Object.assign({ size: 'first', fit: 'crop', cap: 0, start: 0 }, (data.mergeFit && typeof data.mergeFit === 'object') ? data.mergeFit : {});
  const fx = (data.fixed && typeof data.fixed === 'object') ? data.fixed : {};
  const ftypes = FIXED_TYPES.map((t) => t[0]);
  const fslots = (Array.isArray(fx.slots) ? fx.slots : []).map((s) => ({ type: String((s && s.type) || 'other'), n: Math.max(0, parseInt((s && s.n), 10) || 0) })).filter((s) => ftypes.indexOf(s.type) >= 0);
  const fknown = {}; fslots.forEach((s) => { fknown[s.type] = s.n; });
  const cur = String(fx.current || 'minimaxH3');
  const base = (FIXED_BUILTIN[cur] || FIXED_DEFAULT_SLOTS);
  st.fixed = {
    on: !!fx.on,
    current: cur,
    slots: FIXED_TYPES.map((t) => {
      const fromCfg = fknown[t[0]];
      const fromBase = (base.find((s) => s.type === t[0]) || {}).n;
      return { type: t[0], n: Math.max(0, parseInt(fromCfg === undefined ? fromBase : fromCfg, 10) || 0) };
    }),
  };
  if (!st.groups.length) { st.groups = [{ id: genId(), name: ezT('Group'), cards: [{ id: genId(), name: ezT('Card group 1'), items: [] }] }]; }
  st.currentGroupId = data.currentGroupId != null && st.groups.some((g) => g.id === data.currentGroupId) ? data.currentGroupId : st.groups[0].id;
}
function currentGroup(node) { const st = stateFor(node); return st.groups.find((g) => g.id === st.currentGroupId) || st.groups[0] || null; }

// ===== 媒体辅助 =====
function mediaKind(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (/^(png|jpe?g|webp|gif|bmp|tif?f|heic|avif|psd)$/.test(ext)) return 'image';
  if (/^(mp4|avi|mkv|mov|webm|flv|wmv|m4v|mpg|mpeg|3gp|ts|m2ts|vob)$/.test(ext)) return 'video';
  if (/^(mp3|wav|flac|aac|ogg|m4a|wma|opus|aiff|aif|mka|ac3|amr)$/.test(ext)) return 'audio';
  if (/^(gltf|glb|obj|fbx|stl|ply|spz|splat|ksplat|3ds|dae|blend|vrm|usdz|x3d|lwo|abc)$/.test(ext)) return 'model_3d';
  return 'other';
}
function mediaUrl(f) { return (f && (f.url || ('/media_loader/serve?path=' + encodeURIComponent((f && f.path) || '')))) || ''; }
function chevSvg(left, size) { const s = size || 18; return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + (left ? '<path d="M15 5l-7 7 7 7"/>' : '<path d="M9 5l7 7-7 7"/>') + '</svg>'; }
function typeShort(c) { return ({ image: ezT('Image'), video: ezT('Video'), audio: ezT('Audio'), model_3d: ezT('Model'), other: ezT('File') })[c] || ezT('File'); }
function suffix(name) { const p = (name || '').split('.'); return p.length > 1 ? '.' + p.pop().toLowerCase() : ''; }
function formatSize(b) { if (b == null) return ''; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }

// ===== 面板渲染 =====
function mkManagerBar(cfg) {
  const bar = el('div', 'eml-managerbar');
  const cnt = el('span'); cnt.textContent = cfg.label;
  const merge = el('button', 'eml-btn primary', { type: 'button' }); merge.textContent = cfg.merge;
  const all = el('button', 'eml-btn', { type: 'button' }); all.textContent = ezT('Select all');
  const clear = el('button', 'eml-btn', { type: 'button' }); clear.textContent = ezT('Clear selection');
  const invert = el('button', 'eml-btn', { type: 'button' }); invert.textContent = ezT('Invert');
  const exit = el('button', 'eml-btn', { type: 'button' }); exit.textContent = ezT('Exit manager');
  merge.addEventListener('click', cfg.onMerge);
  all.addEventListener('click', cfg.onAll); clear.addEventListener('click', cfg.onClear); invert.addEventListener('click', cfg.onInvert);
  exit.addEventListener('click', cfg.onExit);
  bar.appendChild(cnt); bar.appendChild(merge); bar.appendChild(all); bar.appendChild(clear); bar.appendChild(invert); bar.appendChild(exit);
  return bar;
}
// ===== 设置弹窗：左侧分栏（拼接 / 固定）+ 顶部固定槽位预设 =====
// 拼接面板正文（只有内容，弹窗外壳由 openLoaderSettings 提供）
function mergeSettingsBody(node) {
  const st = stateFor(node); const mode = mlMode(node); const rank = ML_RANK;
  const scopeKeys = ['card', 'row', 'group'];
  const scopeNames = [ezT('By card'), ezT('By card group'), ezT('By group')];
  const body = el('div'); body.style.cssText = 'padding:12px 14px;display:flex;flex-direction:column;gap:8px;font-size:12px;';
  const scopeRow = el('div'); scopeRow.style.cssText = 'display:flex;align-items:center;gap:10px;';
  const scopeLbl = el('span'); scopeLbl.style.cssText = 'font-weight:500;white-space:nowrap;'; scopeLbl.textContent = ezT('Merge scope'); scopeRow.appendChild(scopeLbl);
  let curScope = mlScope(node);
  const seg = el('div'); seg.style.cssText = 'display:flex;background:var(--ez-surface-3);border-radius:8px;padding:2px;border:1px solid var(--ez-border);';
  const segCss = 'background:transparent;border:none;padding:2px 12px;font-size:11px;color:var(--ez-fg-2);font-family:inherit;cursor:pointer;border-radius:6px;height:24px;line-height:1;';
  const segBtns = scopeKeys.map((k, i) => {
    const b = el('button'); b.type = 'button'; b.textContent = scopeNames[i]; b.style.cssText = segCss;
    if (rank[k] > rank[mode]) { b.disabled = true; b.style.opacity = '.35'; b.style.cursor = 'default'; b.title = ezT('Merge span exceeds the output content; limited to the output mode'); }
    b.addEventListener('click', () => { if (rank[k] > rank[mode]) { uiToast(ezT('Merge span exceeds the output content; limited to the output mode')); return; } curScope = k; syncSeg(); });
    seg.appendChild(b); return b;
  });
  const syncSeg = () => segBtns.forEach((b, i) => { const on = scopeKeys[i] === curScope; b.style.background = on ? 'var(--ez-bg)' : 'transparent'; b.style.color = on ? 'var(--ez-fg)' : 'var(--ez-fg-2)'; b.style.fontWeight = on ? '510' : '470'; b.style.boxShadow = on ? '0 1px 4px rgba(0,0,0,.06)' : ''; });
  syncSeg(); scopeRow.appendChild(seg); body.appendChild(scopeRow);
  const iCss = 'height:26px;padding:0 6px;border:1px solid var(--ez-border);border-radius:7px;background:var(--ez-bg);color:var(--ez-fg);font-family:inherit;text-align:center;box-sizing:border-box;';
  const typeRow = (key, label, params) => {
    const row = el('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--ez-border-2);flex-wrap:nowrap;';
    const nm = el('span'); nm.textContent = label; nm.style.cssText = 'font-weight:500;min-width:40px;'; row.appendChild(nm);
    if (params && params.length) { const wrap = el('div'); wrap.style.cssText = 'display:flex;align-items:center;gap:5px;flex-wrap:nowrap;flex:1 1 auto;min-width:0;'; params.forEach((n) => wrap.appendChild(n)); row.appendChild(wrap); }
    const tg = el('div'); tg.style.cssText = 'display:flex;background:var(--ez-surface-3);border-radius:8px;padding:2px;border:1px solid var(--ez-border);flex:0 0 auto;margin-left:auto;';
    const onB = el('button'); onB.type = 'button'; onB.textContent = ezT('On'); const offB = el('button'); offB.type = 'button'; offB.textContent = ezT('Off');
    const tgCss = 'background:transparent;border:none;padding:2px 10px;font-size:11px;color:var(--ez-fg-2);font-family:inherit;cursor:pointer;border-radius:6px;height:22px;line-height:1;';
    onB.style.cssText = tgCss; offB.style.cssText = tgCss;
    let on = (st.mergeTypes || {})[key] !== false;
    const syncTg = () => { onB.style.background = on ? 'var(--ez-ok-bg)' : 'transparent'; onB.style.color = on ? 'var(--ez-ok-fg)' : 'var(--ez-fg-2)'; offB.style.background = on ? 'transparent' : 'var(--ez-bad-bg)'; offB.style.color = on ? 'var(--ez-fg-2)' : 'var(--ez-bad-fg)'; };
    onB.addEventListener('click', () => { on = true; syncTg(); }); offB.addEventListener('click', () => { on = false; syncTg(); }); syncTg();
    tg.appendChild(onB); tg.appendChild(offB); row.appendChild(tg);
    return { row, isOn: () => on };
  };
  const fit = Object.assign({ fit: 'crop', cap: 0, start: 0 }, st.mergeFit || {});
  const sz0 = /^\d+x\d+$/i.test(String(fit.size)) ? String(fit.size).toLowerCase().split('x') : ['1024', '1024'];
  const wIn = el('input', 'eml-num'); wIn.type = 'number'; wIn.min = '16'; wIn.max = '8192'; wIn.value = sz0[0]; wIn.title = ezT('Width'); wIn.style.cssText = 'width:52px;' + iCss;
  const xSp = el('span'); xSp.textContent = '\u00d7'; xSp.style.color = 'var(--ez-fg-muted)';
  const hIn = el('input', 'eml-num'); hIn.type = 'number'; hIn.min = '16'; hIn.max = '8192'; hIn.value = sz0[1]; hIn.title = ezT('Height'); hIn.style.cssText = 'width:52px;' + iCss;
  const fitSel = el('select'); ['crop', 'pad', 'stretch'].forEach((v) => { const o = el('option'); o.value = v; o.textContent = v; fitSel.appendChild(o); }); fitSel.value = fit.fit || 'crop'; fitSel.style.cssText = 'height:26px;border:1px solid var(--ez-border);border-radius:7px;background:var(--ez-bg);color:var(--ez-fg);font-family:inherit;';
  const startLbl = el('span'); startLbl.textContent = ezT('Start'); startLbl.style.cssText = 'color:var(--ez-fg-3);font-size:11px;white-space:nowrap;';
  const startIn = el('input', 'eml-num'); startIn.type = 'number'; startIn.min = '0'; startIn.value = String(fit.start || 0); startIn.style.cssText = 'width:46px;' + iCss;
  const capLbl = el('span'); capLbl.textContent = ezT('Count'); capLbl.style.cssText = 'color:var(--ez-fg-3);font-size:11px;white-space:nowrap;';
  const capIn = el('input', 'eml-num'); capIn.type = 'number'; capIn.min = '0'; capIn.value = String(fit.cap || 0); capIn.style.cssText = 'width:46px;' + iCss;
  const imgRow = typeRow('image', ezT('Image'), [wIn, xSp, hIn, fitSel, startLbl, startIn, capLbl, capIn]);
  const audioRow = typeRow('audio', ezT('Audio'), []);
  const textRow = typeRow('other', ezT('Text'), []);
  body.appendChild(imgRow.row); body.appendChild(audioRow.row); body.appendChild(textRow.row);
  return { el: body, save: () => {
    st.mergeScope = curScope;
    st.mergeTypes = { image: imgRow.isOn(), audio: audioRow.isOn(), other: textRow.isOn() };
    st.mergeFit = { size: (Math.max(16, parseInt(wIn.value, 10) || 1024) + 'x' + Math.max(16, parseInt(hIn.value, 10) || 1024)), fit: fitSel.value, cap: Math.max(0, parseInt(capIn.value, 10) || 0), start: Math.max(0, parseInt(startIn.value, 10) || 0) };
  } };
}

// 固定槽位面板：每行三个「类型[数量]」+ 循环粒度（index 按什么前进）+ 输出模式跟随
// 循环设置面板：第一行预设（下拉 / 保存 / 删除），第二行起卡片组槽位布局
// 槽位 = 每个「卡片组」要摆的素材位（固定 6 类，每行三个、默认两排，只填数量）
function fixedSettingsBody(node) {
  const st = stateFor(node);
  const counts = {};
  FIXED_TYPES.forEach((t) => { const hit = (st.fixed.slots || []).find((s) => s.type === t[0]); counts[t[0]] = Math.max(0, parseInt(hit && hit.n, 10) || 0); });
  const body = el('div'); body.style.cssText = 'padding:12px 14px;display:flex;flex-direction:column;gap:10px;font-size:12px;';
  // 预设：下拉 + 保存 + 删除（内置 minimaxH3 不可删）
  const pRow = el('div'); pRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
  const psel = el('select', 'eml-preset'); psel.style.cssText = 'flex:0 1 200px;height:28px;min-width:120px;';
  const pSave = el('button', 'eml-btn', { type: 'button' }); pSave.textContent = ezT('Save');
  const pDel = el('button', 'eml-btn', { type: 'button' }); pDel.textContent = ezT('Delete');
  pRow.appendChild(psel); pRow.appendChild(pSave); pRow.appendChild(pDel); body.appendChild(pRow);
  // 槽位布局：6 类固定顺序，每行三个 → 默认两排
  const grid = el('div'); grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;'; body.appendChild(grid);
  const iCss = 'height:26px;padding:0 6px;border:1px solid var(--ez-border);border-radius:7px;background:var(--ez-bg);color:var(--ez-fg);font-family:inherit;box-sizing:border-box;';
  const drawGrid = () => {
    grid.innerHTML = '';
    FIXED_TYPES.forEach((t) => {
      const row = el('div'); row.style.cssText = 'display:flex;align-items:center;gap:6px;flex:0 0 calc((100% - 16px) / 3);min-width:0;';
      const nm = el('span'); nm.textContent = ezT(t[1]); nm.style.cssText = 'flex:1 1 auto;min-width:0;color:var(--ez-fg-2);'; row.appendChild(nm);
      const nIn = el('input', 'eml-num'); nIn.type = 'number'; nIn.min = '0'; nIn.step = '1'; nIn.value = String(counts[t[0]] || 0); nIn.style.cssText = 'width:56px;text-align:center;' + iCss;
      nIn.addEventListener('change', () => { const v = Math.max(0, parseInt(nIn.value, 10) || 0); nIn.value = String(v); counts[t[0]] = v; });
      row.appendChild(nIn); grid.appendChild(row);
    });
  };
  drawGrid();
  const save = () => { st.fixed.slots = FIXED_TYPES.map((t) => ({ type: t[0], n: counts[t[0]] || 0 })); };
  const loadP = async () => {
    psel.innerHTML = '';
    Object.keys(FIXED_BUILTIN).forEach((k) => { const o = el('option'); o.value = k; o.textContent = k; psel.appendChild(o); });
    try { const list = await (await fetch(PRESET_API)).json(); (Array.isArray(list) ? list : []).forEach((p) => { if (p && p.kind === 'fixed' && !FIXED_BUILTIN[p.name]) { const o = el('option'); o.value = p.name; o.textContent = p.name; psel.appendChild(o); } }); } catch (_) {}
    psel.value = st.fixed.current || 'minimaxH3';
  };
  const applyP = async (name) => {
    let slots = FIXED_BUILTIN[name] || FIXED_DEFAULT_SLOTS;
    if (!FIXED_BUILTIN[name]) {
      try { const list = await (await fetch(PRESET_API)).json(); const p = (list || []).find((x) => x.name === name && x.kind === 'fixed'); if (p && Array.isArray(p.slots)) slots = p.slots; } catch (_) {}
    }
    const m = {}; (slots || []).forEach((s) => { if (s && s.type) m[s.type] = Math.max(0, parseInt(s.n, 10) || 0); });
    FIXED_TYPES.forEach((t) => { counts[t[0]] = m[t[0]] || 0; });
    st.fixed.current = name; st.fixed.slots = FIXED_TYPES.map((t) => ({ type: t[0], n: counts[t[0]] || 0 }));
    drawGrid();
  };
  psel.addEventListener('change', () => applyP(psel.value));
  pSave.addEventListener('click', async () => {
    const nm = await uiPrompt(ezT('Enter preset name:'), st.fixed.current === 'minimaxH3' ? (ezT('Preset') + ' 1') : st.fixed.current);
    if (!nm || !nm.trim()) return;
    const name = nm.trim();
    if (FIXED_BUILTIN[name]) { uiToast(ezT('That name is reserved for a built-in preset')); return; }
    save();
    try { await fetch(PRESET_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, kind: 'fixed', slots: st.fixed.slots }) }); st.fixed.current = name; await loadP(); uiToast(ezT('Preset saved')); } catch (_) { uiToast(ezT('Save failed')); }
  });
  pDel.addEventListener('click', async () => {
    const name = psel.value;
    if (FIXED_BUILTIN[name]) { uiToast(ezT('The built-in preset cannot be deleted')); return; }
    try { await fetch(PRESET_API + '/' + encodeURIComponent(name), { method: 'DELETE' }); st.fixed.current = 'minimaxH3'; await applyP('minimaxH3'); await loadP(); uiToast(ezT('Preset deleted')); } catch (_) { uiToast(ezT('Delete failed')); }
  });
  loadP();
  return { el: body, save };
}
async function openLoaderSettings(node, tab) {
  const st = stateFor(node);
  const ov = el('div'); ov.style.cssText = 'position:fixed;inset:0;z-index:100090;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;';
  const box = el('div'); box.style.cssText = 'width:680px;max-width:94vw;max-height:88vh;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.24);font-family:Inter,sans-serif;color:var(--ez-fg);overflow:hidden;display:flex;flex-direction:column;';
  const hd = el('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--ez-border-2);';
  const tt = el('b'); tt.textContent = ezT('Media settings'); tt.style.fontSize = '14px'; hd.appendChild(tt);
  const xb = el('button'); xb.textContent = '\u2715'; xb.style.cssText = 'border:none;background:transparent;color:var(--ez-fg-muted);font-size:16px;cursor:pointer;';
  hd.appendChild(xb);
  const main = el('div'); main.style.cssText = 'display:flex;min-height:0;flex:1 1 auto;';
  const tabs = el('div'); tabs.style.cssText = 'flex:0 0 auto;width:110px;border-right:1px solid var(--ez-border-2);padding:8px;display:flex;flex-direction:column;gap:4px;background:var(--ez-surface);';
  const pane = el('div'); pane.style.cssText = 'flex:1 1 auto;min-width:0;overflow:auto;';
  main.appendChild(tabs); main.appendChild(pane);
  const panes = { merge: mergeSettingsBody(node), fixed: fixedSettingsBody(node) };
  let cur = (tab === 'fixed') ? 'fixed' : 'merge';
  const tabBtns = {};
  const show = () => {
    Object.keys(tabBtns).forEach((k) => { const b = tabBtns[k]; const on = k === cur; b.style.background = on ? 'var(--ez-surface-3)' : 'transparent'; b.style.fontWeight = on ? '600' : '400'; });
    pane.innerHTML = ''; pane.appendChild(panes[cur].el);
  };
  [['merge', ezT('Merge settings')], ['fixed', ezT('Loop settings')]].forEach((t) => {
    const b = el('button'); b.type = 'button'; b.textContent = t[1]; b.style.cssText = 'text-align:left;border:none;border-radius:8px;padding:8px 10px;font-size:12px;font-family:inherit;color:var(--ez-fg);cursor:pointer;background:transparent;';
    b.addEventListener('click', () => { cur = t[0]; show(); });
    tabBtns[t[0]] = b; tabs.appendChild(b);
  });
  show();
  const ft = el('div'); ft.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--ez-border-2);';
  const cancel = el('button', 'eml-btn', { type: 'button' }); cancel.textContent = ezT('Cancel'); cancel.addEventListener('click', () => ov.remove());
  const save = el('button', 'eml-btn primary', { type: 'button' }); save.textContent = ezT('Save');
  save.addEventListener('click', () => { panes.merge.save(); panes.fixed.save(); syncToConfig(node); ov.remove(); updatePorts(node, true); notifyDownstream(node); render(node); });   // 槽位改动不改端口名，得显式通知所连 MediaOut 重读 schema
  ft.appendChild(cancel); ft.appendChild(save);
  box.appendChild(hd); box.appendChild(main); box.appendChild(ft); ov.appendChild(box); document.body.appendChild(ov);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
  xb.addEventListener('click', () => ov.remove());
}
function openMergeSettings(node) { openLoaderSettings(node, 'merge'); }
function render(node) {
  const root = node._emlRoot; if (!root) return;
  const st = stateFor(node); const g = currentGroup(node);
  const panel = root;
  // 顶部预设
  const top = panel.querySelector('.eml-top'); top.innerHTML = '';
  const presetWrap = el('div'); presetWrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;flex:0 0 auto;';
  const presetSel = el('select', 'eml-preset'); presetSel._node = node; presetSel.style.cssText = 'display:none;';   // 只是 option 的载体，不能接收点击（否则会弹出系统原生下拉）
  const presetBtn = el('button', 'eml-preset-btn', { type: 'button' }); presetBtn.textContent = 'default';
  const presetMenu = el('div', 'eml-preset-menu');
  presetWrap.appendChild(presetSel); presetWrap.appendChild(presetBtn); presetWrap.appendChild(presetMenu);
  top.appendChild(presetWrap);
  presetSel._dd = { btn: presetBtn, menu: presetMenu };
  presetBtn.addEventListener('click', (e) => { e.stopPropagation(); presetMenu.classList.toggle('open'); });
  presetMenu.addEventListener('click', (e) => { const it = e.target.closest('.eml-preset-item'); if (!it) return; presetSel.value = it.dataset.v; presetMenu.classList.remove('open'); presetSel.dispatchEvent(new Event('change')); });
  document.addEventListener('click', () => { if (presetMenu.classList.contains('open')) presetMenu.classList.remove('open'); });
  presetBtn.style.maxWidth = '96px'; presetBtn.style.minWidth = '64px';   // 预设下拉收窄，给输出模式/拼接腾位置
  const saveBtn = el('button', 'eml-btn primary', { type: 'button' }); saveBtn.textContent = ezT('Save');
  const delBtn = el('button', 'eml-btn danger', { type: 'button' }); delBtn.textContent = ezT('Delete');
  top.appendChild(saveBtn); top.appendChild(delBtn);
  const gcLabel = el('span'); gcLabel.textContent = ezT('Columns'); gcLabel.style.cssText = 'font-size:11px;color:var(--ez-fg-3);white-space:nowrap;';
  const gcInput = el('input'); gcInput.type = 'number'; gcInput.min = '1'; gcInput.step = '1'; gcInput.value = String(st.gridCols || 3); gcInput.title = ezT('Cards per row');
  gcInput.style.cssText = 'width:48px;height:30px;padding:4px 6px;font-size:12px;border:1px solid var(--ez-border);border-radius:8px;text-align:center;background:var(--ez-bg);';
  gcInput.addEventListener('change', () => { const v = Math.max(1, parseInt(gcInput.value, 10) || 3); st.gridCols = v; gcInput.value = String(v); syncToConfig(node); render(node); });
  top.appendChild(gcLabel); top.appendChild(gcInput);
  const rhLabel = el('span'); rhLabel.textContent = ezT('Row height'); rhLabel.style.cssText = 'font-size:11px;color:var(--ez-fg-3);white-space:nowrap;';
  const rhInput = el('input', 'eml-num'); rhInput.type = 'number'; rhInput.min = '0'; rhInput.step = '0.1'; rhInput.value = String(st.gridRowH == null ? 1 : st.gridRowH); rhInput.title = ezT('Card height multiplier: 0 = fit 16:9; > 0 = 192px × value (decimals allowed)');
  rhInput.style.cssText = 'width:48px;height:30px;padding:4px 6px;font-size:12px;border:1px solid var(--ez-border);border-radius:8px;text-align:center;background:var(--ez-bg);';
  rhInput.addEventListener('change', () => { let v = parseFloat(rhInput.value); if (!isFinite(v)) v = 1; v = Math.max(0, v); st.gridRowH = v; rhInput.value = String(v); syncToConfig(node); render(node); });
  top.appendChild(rhLabel); top.appendChild(rhInput);
  // 输出模式：按卡片 / 按卡片组 / 按分组（默认按卡片）—— 决定输出口数量，每个口是一份 list
  const modeSel = el('select', 'eml-preset'); modeSel.title = ezT('Output mode: one port per card / card group / group');
  [['card', ezT('By card')], ['row', ezT('By card group')], ['group', ezT('By group')]].forEach(([v, t]) => { const o = el('option'); o.value = v; o.textContent = t; modeSel.appendChild(o); });
  modeSel.value = mlMode(node);
  modeSel.style.cssText = 'display:inline-block;min-width:0;width:80px;height:30px;padding:2px 20px 2px 7px;font-size:11px;flex:0 0 auto;';
  modeSel.addEventListener('change', () => { const st2 = stateFor(node); st2.mode = ['card', 'row', 'group'].indexOf(modeSel.value) >= 0 ? modeSel.value : 'card'; if (ML_RANK[st2.mergeScope] > ML_RANK[st2.mode]) st2.mergeScope = st2.mode; syncToConfig(node); render(node); });
  top.appendChild(modeSel);
  // 拼接开关：绿=生效；右键打开拼接设置
  const mergeBtn = el('button', 'eml-btn', { type: 'button' });
  const updMerge = () => { mergeBtn.textContent = ezT('Concatenate'); mergeBtn.title = ezT('Merge into one item per merge group (right-click for settings)'); mergeBtn.style.background = st.merge ? 'var(--ez-ok-bg)' : ''; mergeBtn.style.borderColor = st.merge ? 'var(--ez-ok-border)' : ''; mergeBtn.style.color = st.merge ? 'var(--ez-ok-fg)' : ''; };
  updMerge();
  mergeBtn.addEventListener('click', () => { st.merge = !st.merge; syncToConfig(node); render(node); });
  mergeBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openMergeSettings(node); });
  top.appendChild(mergeBtn);
  // 固定模式：每段素材按「类型 + 数量」固定槽位；左键开关，右键设置（拼接也并在那里）
  const fixedBtn = el('button', 'eml-btn', { type: 'button' });
  const updFixed = () => { fixedBtn.textContent = ezT('Loop'); fixedBtn.title = ezT('Loop mode: declare a per-card-group slot layout (right-click for settings)'); fixedBtn.style.background = st.fixed.on ? 'var(--ez-ok-bg)' : ''; fixedBtn.style.borderColor = st.fixed.on ? 'var(--ez-ok-border)' : ''; fixedBtn.style.color = st.fixed.on ? 'var(--ez-ok-fg)' : ''; };
  updFixed();
  fixedBtn.addEventListener('click', () => { st.fixed.on = !st.fixed.on; syncToConfig(node); updatePorts(node, true); render(node); });
  fixedBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openLoaderSettings(node, 'fixed'); });
  top.appendChild(fixedBtn);
  const lblBtn = el('button', 'eml-btn eml-lblbtn', { type: 'button' }); lblBtn.textContent = ezT('Names');
  const syncLbl = () => { lblBtn.style.background = mlLabelsOn() ? 'var(--ez-ok-bg)' : ''; lblBtn.style.borderColor = mlLabelsOn() ? 'var(--ez-ok-border)' : ''; lblBtn.style.color = mlLabelsOn() ? 'var(--ez-ok-fg)' : ''; };
  syncLbl();
  lblBtn.addEventListener('click', () => { mlLabelsSet(!mlLabelsOn()); syncLbl(); });
  top.appendChild(lblBtn);
  const outBtn = el('button', 'eml-btn', { type: 'button' }); outBtn.textContent = ezT('Load output'); outBtn.title = ezT('Add an EzFlex-MediaOut node after the current card group'); outBtn.addEventListener('click', () => addMediaOut(node)); top.appendChild(outBtn);
  loadPresetsInto(presetSel);
  saveBtn.addEventListener('click', () => saveCurrentPreset(node));
  delBtn.addEventListener('click', () => deletePreset(node));
  presetSel.addEventListener('change', () => { const v = presetSel.value; if (v) applyPreset(node, v); });

  // 分组 tabs
  const tabs = panel.querySelector('.eml-tabs'); tabs.innerHTML = '';
  st.groups.forEach((grp) => {
    const tab = el('div', 'eml-tab' + (grp.id === st.currentGroupId ? ' active' : ''));
    tab.dataset.gid = grp.id;
    if (node._ezGrpMgr && node._ezGrpSel && node._ezGrpSel.has(String(grp.id))) tab.classList.add('mgr-sel');
    const nm = el('span', 'tname'); nm.textContent = grp.name; nm.spellcheck = false;
    nm.addEventListener('dblclick', (e) => { e.stopPropagation(); editInline(nm, (v) => { grp.name = v || ezT('New group'); syncToConfig(node); render(node); }); });
    tab.appendChild(nm);
    const close = el('span', 'tclose'); close.textContent = '✕'; close.title = ezT('Delete this group');
    close.addEventListener('click', async (e) => { e.stopPropagation(); if (await uiConfirm(ezT('Delete group "') + (grp.name || '') + ezT('"?'))) deleteGroup(node, grp.id); });   // 分组 ✕ 挨着组名，误触代价大：先确认
    tab.appendChild(close);
    tab.addEventListener('click', () => { if (tab._grpDrag) { tab._grpDrag = false; return; } if (node._ezGrpMgr) { groupMgrClick(node, st.groups.indexOf(grp)); return; } if (st.currentGroupId !== grp.id) { st.currentGroupId = grp.id; syncToConfig(node); render(node); } });
    tab.addEventListener('mousedown', (e) => groupLongPress(e, node, st.groups.indexOf(grp), tab));
    tab.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openGroupMenu(e, node, st.groups.indexOf(grp)); });
    tabs.appendChild(tab);
  });
  const addTab = el('button', 'eml-addtab', { type: 'button' }); addTab.textContent = ezT('➕ New');
  addTab.addEventListener('click', () => addGroup(node));
  tabs.appendChild(addTab);

  // 卡片列表
  const cards = panel.querySelector('.eml-cards'); cards.innerHTML = '';
  if (node._ezMgr) cards.appendChild(mkManagerBar({ label: ezT('Manage: ') + (node._ezMgrSel ? node._ezMgrSel.size : 0) + ezT(' card groups selected'), merge: ezT('Merge selected'), onMerge: () => mergeSelected(node, g), onAll: () => selectAllCards(node, g), onClear: () => clearCards(node, g), onInvert: () => invertCards(node, g), onExit: () => toggleManager(node) }));
  if (node._ezItemMgr) cards.appendChild(mkManagerBar({ label: ezT('Manage cards: ') + (node._ezItemSel ? node._ezItemSel.size : 0) + ezT(' cards selected'), merge: ezT('Merge into batch card'), onMerge: () => { const cc = currentGroup(node); if (cc) mergeSelectedItems(node, cc); }, onAll: () => selectAllItems(node, g), onClear: () => clearItems(node, g), onInvert: () => invertItems(node, g), onExit: () => toggleItemManager(node) }));
  if (node._ezGrpMgr) cards.appendChild(mkManagerBar({ label: ezT('Manage groups: ') + (node._ezGrpSel ? node._ezGrpSel.size : 0) + ezT(' groups selected'), merge: ezT('Merge groups'), onMerge: () => mergeGroups(node), onAll: () => selectAllGroups(node), onClear: () => clearGroups(node), onInvert: () => invertGroups(node), onExit: () => toggleGroupManager(node) }));
  if (!g) { const e = el('div', 'eml-empty'); e.textContent = ezT('No editable group'); cards.appendChild(e); }
  else g.cards.forEach((card) => cards.appendChild(buildCard(node, g, card)));
  updatePorts(node, true);   // 端口跟随输出模式/拼接/文件变化
}

function editInline(elx, cb) {
  if (elx.isContentEditable) return;
  elx.contentEditable = 'true'; elx.classList.add('editing'); elx.focus();
  const range = document.createRange(); range.selectNodeContents(elx);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  const finish = () => { elx.contentEditable = 'false'; elx.classList.remove('editing'); cb(elx.textContent.trim()); elx.removeEventListener('blur', finish); elx.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); elx.blur(); } else if (e.key === 'Escape') { elx.textContent = elx.dataset.orig || elx.textContent; elx.blur(); } };
  elx.dataset.orig = elx.textContent;
  elx.addEventListener('blur', finish); elx.addEventListener('keydown', onKey);
}

// ===== 固定模式：每个卡片组 = 槽位面板（按类型摆空位，多余的素材收不进来）=====
const FIXED_POOL = { image: 'image', video: 'video', audio: 'audio', text: 'other', model3d: 'model_3d', other: 'other' };
// 槽位图标：图片/视频/音频/其他 与 MediaOut 黑框标签同一套 SVG；文本画成文档纸；3D 画三个带缝的面 + 底下标 3D
const SLOT_TEXT_ICON = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5h7.5L19 8v13.5H6z"/><path d="M13.5 2.5V8H19"/><path d="M9 12.5h6.5M9 15.5h6.5M9 18.5h4"/></svg>';
// 立方体：顶面 + 左右两个侧面按正常比例拼接（面相接处留 0.5 的缝），"3D" 略微压住底边
const SLOT_3D_ICON = '<svg viewBox="0 0 26 26" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M13 2.4l7.1 3.8L13 10 5.9 6.2z"/><path d="M3.2 7.4l7 3.8v8.2l-7-3.8z"/><path d="M15.8 11.2l7-3.8v8.2l-7 3.8z"/><text x="13" y="23.4" font-size="7" font-family="Inter,sans-serif" font-weight="700" fill="var(--ez-bg)" stroke="none" text-anchor="middle">3D</text><text x="13" y="23" font-size="7" font-family="Inter,sans-serif" font-weight="700" fill="currentColor" stroke="none" text-anchor="middle">3D</text></svg>';
const SLOT_COLOR = { image: '#4a9eff', video: '#e0645c', audio: '#34a853', text: '#9aa7b5', model3d: '#b15bd6', other: '#8b95a3' };
function slotIcon(t) { return t === 'text' ? SLOT_TEXT_ICON : (t === 'model3d' ? SLOT_3D_ICON : ((TYPE_ICONS[t] || TYPE_ICONS.other).replace('width="16" height="16"', 'width="26" height="26"'))); }
function fixedLayout(node) {
  return ((stateFor(node).fixed || {}).slots || []).filter((s) => (parseInt(s.n, 10) || 0) > 0).map((s) => ({ type: String(s.type), n: parseInt(s.n, 10) || 0 }));
}
function entryKind(f) {
  const k = mediaKind((f && (f.name || f.path)) || '');
  return k !== 'other' ? k : String((f && f.type) || 'other').toLowerCase();
}
function itemKindOf(item) { return entryKind(((item && item.files) || [])[0] || {}); }
function fixedCells(node, card) {
  const pool = {};
  (card.items || []).forEach((it) => { const k = itemKindOf(it); (pool[k] = pool[k] || []).push(it); });
  const used = {}; const cells = [];
  fixedLayout(node).forEach((s) => {
    const k = FIXED_POOL[s.type] || 'other'; const list = pool[k] || [];
    for (let i = 0; i < s.n; i++) { const idx = used[k] || 0; cells.push({ type: s.type, item: list[idx] || null }); used[k] = idx + 1; }
  });
  return cells;
}
// 固定模式下再加文件：每种类型的容量 = 它的槽位数，超出的不收
function fixedTake(node, card, list) {
  if (!stateFor(node).fixed.on) return { ok: list, full: 0 };
  const cap = {}; fixedLayout(node).forEach((s) => { const k = FIXED_POOL[s.type] || 'other'; cap[k] = (cap[k] || 0) + s.n; });
  const used = {}; (card.items || []).forEach((it) => { const k = itemKindOf(it); used[k] = (used[k] || 0) + 1; });
  const ok = []; let full = 0;
  (list || []).forEach((e) => { const k = entryKind(e); if ((used[k] || 0) < (cap[k] || 0)) { used[k] = (used[k] || 0) + 1; ok.push(e); } else full += 1; });
  return { ok, full };
}
// 空位格子：和「添加素材」一个用法（点它开浏览器），只是位置/类型是预设死的
function buildSlotCard(node, g, card, type) {
  const d = el('div', 'eml-media eml-slot');
  const rhs = stateFor(node).gridRowH;
  if (rhs > 0) d.style.minHeight = Math.max(48, rhs * 192) + 'px';   // 槽位要放图标+文字，给个下限
  d.title = ezT('Empty slot: click to add') + ' — ' + ezT(fixedTypeLabel(type));
  const ic = el('div'); ic.innerHTML = slotIcon(type); ic.style.cssText = 'display:flex;align-items:center;justify-content:center;color:' + (SLOT_COLOR[type] || 'var(--ez-fg-2)') + ';opacity:.9;';
  const nm = el('div'); nm.textContent = ezT(fixedTypeLabel(type)); nm.style.cssText = 'font-size:11px;color:var(--ez-fg-3);';
  d.appendChild(ic); d.appendChild(nm);
  d.addEventListener('click', (e) => { e.stopPropagation(); openBrowse(node, g, card); });
  return d;
}
function fixedTypeLabel(t) { const hit = FIXED_TYPES.find((x) => x[0] === t); return hit ? hit[1] : 'Other'; }

function buildCard(node, g, card) {
  const isMgr = node._ezMgr;
  const cardDiv = el('div', 'eml-card' + (isMgr ? ' mgr' : '') + (isMgr && node._ezMgrSel && node._ezMgrSel.has(String(card.id)) ? ' mgr-sel' : ''));
  cardDiv.dataset.cid = card.id; cardDiv.dataset.gid = g.id;
  if (isMgr) cardDiv.addEventListener('click', (e) => { if (e.target.closest('.eml-grip') || e.target.closest('.cdel') || (e.target.closest('.ctitle') && e.target.closest('.ctitle').isContentEditable)) return; managerCardClick(node, g, card); });
  const head = el('div', 'eml-card-head');
  const grip = el('span', 'eml-grip'); grip.textContent = '⠿'; grip.title = ezT('Drag to reorder card groups'); head.appendChild(grip);
  const title = el('span', 'ctitle'); title.textContent = card.name; title.spellcheck = false;
  title.addEventListener('dblclick', (e) => { e.stopPropagation(); editInline(title, (v) => { card.name = v || ezT('Unnamed card group'); syncToConfig(node); updatePorts(node, true); render(node); }); });
  head.appendChild(title);
  const del = el('button', 'cdel', { type: 'button', title: ezT('Delete this card group') }); del.textContent = '✕';
  del.addEventListener('click', (e) => { e.stopPropagation(); if (g.cards.length <= 1) { uiToast(ezT('Each group must keep at least one card group')); return; } g.cards = g.cards.filter((c) => c.id !== card.id); syncToConfig(node); updatePorts(node, true); render(node); });
  head.appendChild(del);
  cardDiv.appendChild(head);
  // 只有 ⠿ 拖手才可拖动排序
  grip.addEventListener('mousedown', (e) => { e.preventDefault(); startCardDrag(e, node, g, card); });
  const grid = el('div', 'eml-grid'); grid.dataset.cid = card.id;
  grid.style.gridTemplateColumns = 'repeat(' + Math.max(1, (stateFor(node).gridCols || 3)) + ',1fr)';
  const gridRh = stateFor(node).gridRowH;
  if (gridRh > 0) grid.style.minHeight = Math.max(24, gridRh * 192) + 'px';   // 卡片组外框跟着高度倍率收（原固定 80px 会卡住）
  if (stateFor(node).fixed.on) {
    fixedCells(node, card).forEach((c) => grid.appendChild(c.item ? buildMediaCard(node, g, card, c.item) : buildSlotCard(node, g, card, c.type)));   // 固定面板：只有预设的槽位，没有自由添加位
  } else {
    card.items.forEach((item) => grid.appendChild(buildMediaCard(node, g, card, item)));
    grid.appendChild(buildEmptyCard(node, g, card));
  }
  grid.addEventListener('dblclick', () => openBrowse(node, g, card));
  grid.addEventListener('dragover', (e) => { e.preventDefault(); cardDiv.classList.add('drag-over'); });
  grid.addEventListener('dragleave', (e) => { e.preventDefault(); cardDiv.classList.remove('drag-over'); });
  grid.addEventListener('drop', (e) => { e.preventDefault(); cardDiv.classList.remove('drag-over'); dropFilesToCard(e, node, g, card); });
  cardDiv.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openRowMenu(e, node, g, card); });
  cardDiv.appendChild(grid);
  return cardDiv;
}

const _mlPreview = {};
// 只把这张卡片的缩略图换掉：render(node) 会重建整个面板（卡片多时很慢），生成 3D 预览图后应该立刻就看得见。
function setCardThumb(node, itemId, url) {
  try {
    const root = node && node._emlRoot; if (!root || !url) return false;
    const card = root.querySelector('.eml-media[data-item-id="' + String(itemId).replace(/"/g, '\\"') + '"]');
    if (!card) return false;
    const pv = card.querySelector('.pv'); if (!pv) return false;
    let im = pv.querySelector('img');
    if (!im) { im = el('img'); im.style.cssText = 'width:100%;height:100%;object-fit:contain;'; pv.appendChild(im); }
    im.src = url;
    const ph = pv.querySelector('.ph'); if (ph) ph.remove();
    return true;
  } catch (_) { return false; }
}
function buildMediaCard(node, g, card, item) {
  const isItemMgr = node._ezItemMgr;
  const m = el('div', 'eml-media' + (isItemMgr && node._ezItemSel && node._ezItemSel.has(String(item.id)) ? ' mgr-sel' : ''));
  m.dataset.itemId = item.id; m.dataset.cid = card.id;
  m.draggable = false; m.addEventListener('dragstart', (e) => e.preventDefault());   // 别让浏览器原生拖图片/视频
  const files = item.files || []; const first = files[0] || {};
  m.title = (first.name || '') + (files.length > 1 ? ' (×' + files.length + ')' : '') + ' — ' + ezT('Click to preview');
  const pv = el('div', 'pv');
  const rowH = stateFor(node).gridRowH;
  if (rowH > 0) { const h = rowH * 192; pv.style.aspectRatio = 'auto'; pv.style.height = h + 'px'; m.style.height = h + 'px'; m.style.minHeight = h + 'px'; }
  else { m.style.height = ''; m.style.minHeight = '0'; }
  const rm = el('button', 'rm', { type: 'button', title: ezT('Remove media') }); rm.textContent = '✕';
  rm.addEventListener('click', (e) => { e.stopPropagation(); card.items = card.items.filter((x) => x.id !== item.id); syncToConfig(node); render(node); });
  pv.appendChild(rm);
  if (first.type === 'image') { const img = el('img'); img.src = first.url || ''; img.alt = first.name || ''; img.draggable = false; img.style.cssText = 'width:100%;height:100%;object-fit:contain;'; pv.appendChild(img); }
  else if (first.type === 'video') {
    const v = el('video'); v.src = first.url || ''; v.muted = true; v.preload = 'metadata'; v.draggable = false; v.style.cssText = 'width:100%;height:100%;object-fit:contain;'; pv.appendChild(v);
    const play = el('button', 'eml-play', { type: 'button' }); play.textContent = '▶'; play.title = ezT('Play preview');
    play.addEventListener('click', (e) => { e.stopPropagation(); try { v.muted = false; v.controls = true; v.play(); m.classList.add('playing'); } catch (_) {} });
    v.addEventListener('play', () => m.classList.add('playing'));
    v.addEventListener('pause', () => { v.controls = false; m.classList.remove('playing'); });
    pv.appendChild(play);
  }
  else if (first.type === 'audio') { const ap = makeAudioPlayer(first.url || ''); ap.style.cssText = 'width:100%;'; pv.appendChild(ap); }
  else if (first.type === 'model_3d') { const pvUrl = _mlPreview[item.id]; if (pvUrl) { const im = el('img'); im.src = pvUrl; im.draggable = false; im.style.cssText = 'width:100%;height:100%;object-fit:contain;'; pv.appendChild(im); } else { const ph = el('span', 'ph'); ph.textContent = '🧊'; pv.appendChild(ph); } }
  else {
    const tx = el('div'); tx.style.cssText = 'width:100%;height:100%;overflow:hidden;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:1.5;color:var(--ez-fg-2);white-space:pre-wrap;word-break:break-word;text-align:left;';
    if (first._text != null) tx.textContent = first._text;
    else if (first._text === null) tx.textContent = ezT('Loading…');
    else { first._text = null; tx.textContent = ezT('Loading…'); fetch(mediaUrl(first)).then((r) => r.text()).then((t) => { first._text = (t || '').slice(0, 2000); if (tx.isConnected) tx.textContent = first._text || ezT('(empty file)'); }).catch(() => { first._text = ''; if (tx.isConnected) tx.textContent = ezT('Cannot preview content'); }); }
    pv.appendChild(tx);
  }
  if (files.length > 1) { const b = el('span', 'stack-badge'); b.textContent = '×' + files.length; pv.appendChild(b); }
  m.appendChild(pv);
  const info = el('div', 'info');
  const row1 = el('div'); row1.style.cssText = 'display:flex;align-items:center;gap:6px;';
  const tb = el('span'); tb.textContent = typeShort(first.type); tb.style.cssText = 'flex:0 0 auto;background:var(--ez-surface);border:1px solid rgba(255,255,255,.6);color:var(--ez-fg);border-radius:30px;padding:0 8px;font-size:10px;font-weight:600;line-height:18px;'; row1.appendChild(tb);
  const fn = el('div', 'fname'); fn.textContent = first.name || ''; fn.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'; row1.appendChild(fn);
  info.appendChild(row1);
  const meta = el('div', 'fmeta'); const sz = el('span'); sz.textContent = formatSize(first.size); meta.appendChild(sz);
  const sf = el('span', 'suffix'); sf.textContent = suffix(first.name); meta.appendChild(sf); info.appendChild(meta);
  m.appendChild(info);
  m.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openItemMenu(e, node, g, card, item); });
  m.addEventListener('mousedown', (e) => mediaLongPress(e, node, g, card, item, m));
  m.addEventListener('click', (e) => {
    if (m._longDrag) { m._longDrag = false; return; }
    if (e.target.closest('button') || e.target.closest('audio') || e.target.closest('.ez-ap')) return;
    const vid = m.querySelector('video'); if (vid && !vid.paused) return;   // 播放中不打开大图
    if (isItemMgr) { itemMgrClick(node, g, card, item); return; }
    openPreview(node, item, card);   // 3D 也走统一预览，里面用「打开 3D 查看器」按钮进入（多点一次，换统一左右切换）
  });
  return m;
}

function buildEmptyCard(node, g, card) {
  const e = el('div', 'eml-empty');
  const rh0 = stateFor(node).gridRowH;
  if (rh0 > 0) e.style.minHeight = Math.max(24, rh0 * 192) + 'px';
  e.title = ezT('Click to browse and add media');
  const big = el('span', 'big'); big.textContent = '+'; e.appendChild(big);
  const t = el('span'); t.textContent = ezT('Add media'); e.appendChild(t);
  e.addEventListener('click', () => openBrowse(node, g, card));
  return e;
}

function addGroup(node) {
  const st = stateFor(node);
  const g = { id: genId(), name: ezT('Group') + (st.groups.length + 1), cards: [{ id: genId(), name: ezT('Card group 1'), items: [] }] };
  st.groups.push(g); st.currentGroupId = g.id; syncToConfig(node); render(node);
}
function deleteGroup(node, gid) {
  const st = stateFor(node);
  if (st.groups.length <= 1) { uiToast(ezT('Keep at least one group')); return; }
  st.groups = st.groups.filter((g) => g.id !== gid);
  if (st.currentGroupId === gid) st.currentGroupId = st.groups[0].id;
  syncToConfig(node); updatePorts(node, true); render(node);
}

// ===== 拖拽文件上传添加 =====
function dropFilesToCard(e, node, g, card) {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  uploadAndAddFiles(Array.from(files), node, g, card);
}
async function uploadAndAddFiles(files, node, g, card) {
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  try {
    const r = await fetch('/media_loader/upload', { method: 'POST', body: fd });
    if (r.status === 413) { uiToast(ezT('File too large for upload — raise ComfyUI --max-upload-size (default 100 MB)')); return; }
    const d = await r.json();
    const ups = d.files || [];
    if (!ups.length) { uiToast(ezT('No files to upload')); return; }
    const take = fixedTake(node, card, ups);
    if (!take.ok.length) { uiToast(ezT('Fixed layout: no empty slot for these files')); return; }
    // path 必须落下来：下游（PromptHelper 引用媒体 / MediaOut / 编号表）都靠它出缩略图，缺了 url 还能由 mediaUrl 回落 /media_loader/serve
    card.items.push({ id: genId(), files: take.ok.map((f) => ({ id: genId(), name: f.name, path: f.path || f.name, subfolder: f.subfolder || '', dir: 'input', type: f.type || mediaKind(f.name), url: f.url || undefined, size: f.size, mtime: f.mtime })) });
    syncToConfig(node); render(node);
    uiToast(take.full ? ezT('Fixed layout: only the empty slots were filled') : (ezT('Dropped ') + take.ok.length + ezT(' media files')));
  } catch (_) { uiToast(ezT('Upload failed')); }
}

// ===== 右键菜单（三级：单个卡片 / 素材卡片组 / 分组）=====
function buildMenu(e, items) {
  const menu = el('div');
  menu.style.cssText = 'position:fixed;z-index:10000;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.16);padding:4px;min-width:180px;';
  items.forEach((it) => {
    const b = el('button'); b.textContent = it.label; b.style.cssText = 'display:block;width:100%;text-align:left;background:none;border:none;padding:6px 12px;font-size:12px;color:var(--ez-fg);cursor:pointer;border-radius:6px;font-family:inherit;';
    b.addEventListener('click', () => { menu.remove(); it.fn(); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const events = ['mousedown', 'pointerdown', 'mouseup', 'pointerup', 'contextmenu'];
  const offMenu = () => events.forEach((t) => document.removeEventListener(t, close, true));
  const close = (ev) => { if (!menu.isConnected) { offMenu(); return; } if (!menu.contains(ev.target)) menu.remove(); };   // 不用 once；按下/抬起都在菜单外才关
  events.forEach((t) => document.addEventListener(t, close, true));
  menu.style.left = Math.min(e.clientX, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 220) + 'px';
}
// 单个卡片右键
function openItemMenu(e, node, g, card, item) {
  buildMenu(e, [
    { label: ezT('Merge'), fn: () => toggleItemManager(node) },
    { label: ezT('Split'), fn: () => splitItem(node, g, card, item) },
    { label: ezT('Open card location'), fn: () => openFileLocation(card) },
    { label: ezT('Save as…'), fn: () => saveAsCard(card) },
  ]);
}
// 素材卡片组右键
function openRowMenu(e, node, g, card) {
  buildMenu(e, [
    { label: ezT('Split into multiple card groups'), fn: () => splitCardGroup(node, g, card) },
    { label: ezT('Merge card groups'), fn: () => toggleManager(node) },
  ]);
}
// 分组右键
function openGroupMenu(e, node, gi) {
  buildMenu(e, [{ label: ezT('Merge groups'), fn: () => toggleGroupManager(node) }]);
}
function cardFiles(card) {
  const out = [];
  (card.items || []).forEach((it) => (it.files || []).forEach((f) => out.push(f)));
  return out;
}
// 素材卡片组级拆分：把一张「素材卡片组」裂成多个素材卡片组（仍在当前分组内）
async function splitCardGroup(node, g, card) {
  const total = cardFiles(card);
  if (total.length <= 1) { uiToast(ezT('This card group has only one file; nothing to split')); return; }
  const ok = await uiConfirm(ezT('Split "') + (card.name || ezT('Card group')) + ezT('" into ') + total.length + ezT(' card groups?'));
  if (!ok) return;
  const idx = g.cards.indexOf(card);
  const newCards = total.map((f) => ({ id: genId(), name: (card.name || ezT('Card group')) + '_' + (f.name || ''), items: [{ id: genId(), files: [f] }] }));
  g.cards.splice(idx, 1, ...newCards);
  syncToConfig(node); updatePorts(node, true); render(node); uiToast(ezT('Split the card group into ') + newCards.length + ezT(' card groups'));
}
// 单个卡片级拆分：把选中的「批量卡片」裂成单个卡片（仍在当前素材卡片组内，顶到后面）
function splitItem(node, g, card, item) {
  const files = item.files || [];
  if (files.length <= 1) { uiToast(ezT('This card is not a batch card; nothing to split')); return; }
  const idx = card.items.indexOf(item);
  const splits = files.map((f) => ({ id: genId(), files: [f] }));
  card.items.splice(idx, 1, ...splits);
  syncToConfig(node); render(node); uiToast(ezT('Split the batch card into ') + splits.length + ezT(' cards'));
}
function openFileLocation(card) {
  const files = cardFiles(card);
  if (!files.length) return;
  try { fetch('/media_loader/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: files[0].path }) }); } catch (_) {}
}
async function saveAsCard(card) {
  const files = cardFiles(card);
  if (!files.length) return;
  try {
    const d = await fetch('/media_loader/pick_folder', { method: 'POST' });
    const j = await d.json();
    if (!j.ok || !j.path) { uiToast(j.error ? (ezT('Failed to pick folder: ') + j.error) : ezT('No folder selected')); return; }
    const r = await fetch('/media_loader/save_as', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: files[0].path, dest: j.path }) });
    const res = await r.json();
    uiToast(res.ok ? (ezT('Saved as ') + res.dest) : (ezT('Save failed: ') + (res.error || '')));
  } catch (_) { uiToast(ezT('Save failed')); }
}

// ===== 管理模式（多选「素材卡片组」合并，卡片组级）=====
function updateMgrCount(node) {
  const root = node && node._emlRoot; if (!root) return;
  const bar = root.querySelector('.eml-managerbar'); if (!bar) return;
  const cnt = bar.querySelector('span'); if (!cnt) return;
  if (node._ezMgr) cnt.textContent = ezT('Manage: ') + (node._ezMgrSel ? node._ezMgrSel.size : 0) + ezT(' card groups selected');
  else if (node._ezItemMgr) cnt.textContent = ezT('Manage cards: ') + (node._ezItemSel ? node._ezItemSel.size : 0) + ezT(' cards selected');
  else if (node._ezGrpMgr) cnt.textContent = ezT('Manage groups: ') + (node._ezGrpSel ? node._ezGrpSel.size : 0) + ezT(' groups selected');
}
function toggleManager(node) {
  node._ezMgr = !node._ezMgr; node._ezMgrSel = node._ezMgrSel || new Set();
  if (!node._ezMgr) node._ezMgrSel.clear(); render(node);
}
function managerCardClick(node, g, card) {
  const sel = node._ezMgrSel || (node._ezMgrSel = new Set());
  const id = String(card.id);
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  const elm = node._emlRoot && node._emlRoot.querySelector('.eml-card[data-cid="' + id + '"]');
  if (elm) elm.classList.toggle('mgr-sel', sel.has(id));
  updateMgrCount(node);
}
function selectAllCards(node, g) { g.cards.forEach((c) => node._ezMgrSel.add(String(c.id))); node._ezMgrSel = node._ezMgrSel || new Set(); render(node); }
function clearCards(node, g) { node._ezMgrSel.clear(); render(node); }
function invertCards(node, g) { const sel = node._ezMgrSel || new Set(); const ids = new Set(g.cards.map((c) => String(c.id))); ids.forEach((id) => { if (sel.has(id)) sel.delete(id); else sel.add(id); }); render(node); }
function mergeSelected(node, g) {
  const sel = node._ezMgrSel || new Set();
  const cards = g.cards.filter((c) => sel.has(String(c.id)));
  if (cards.length < 2) { uiToast(ezT('Select at least 2 card groups first')); return; }
  const target = cards[0]; const others = [];
  cards.slice(1).forEach((c) => c.items.forEach((it) => { target.items.push({ id: genId(), files: it.files.slice() }); others.push(c); }));
  g.cards = g.cards.filter((c) => !others.includes(c));
  node._ezMgrSel.clear();
  syncToConfig(node); updatePorts(node, true); render(node); uiToast(ezT('Merged ') + cards.length + ezT(' card groups into "') + (target.name || ezT('Card group')) + ezT('"'));
}

// ===== 管理卡片（多选「单个卡片」合并，卡片级）=====
function toggleItemManager(node) {
  node._ezItemMgr = !node._ezItemMgr; node._ezItemSel = node._ezItemSel || new Set();
  if (!node._ezItemMgr) node._ezItemSel.clear(); render(node);
}
function itemMgrClick(node, g, card, item) {
  const sel = node._ezItemSel || (node._ezItemSel = new Set());
  const id = String(item.id);
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  const elm = node._emlRoot && node._emlRoot.querySelector('.eml-media[data-item-id="' + id + '"]');
  if (elm) elm.classList.toggle('mgr-sel', sel.has(id));
  updateMgrCount(node);
}
function selectAllItems(node, g) { (g.cards || []).forEach((c) => (c.items || []).forEach((it) => node._ezItemSel.add(String(it.id)))); node._ezItemSel = node._ezItemSel || new Set(); render(node); }
function clearItems(node, g) { node._ezItemSel.clear(); render(node); }
function invertItems(node, g) { const sel = node._ezItemSel || new Set(); const ids = new Set(); (g.cards || []).forEach((c) => (c.items || []).forEach((it) => ids.add(String(it.id)))); ids.forEach((id) => { if (sel.has(id)) sel.delete(id); else sel.add(id); }); render(node); }
function mergeSelectedItems(node, g) {
  const sel = node._ezItemSel || new Set();
  const found = [];
  (g.cards || []).forEach((c) => (c.items || []).forEach((it) => { if (sel.has(String(it.id))) found.push({ card: c, item: it }); }));
  if (found.length < 2) { uiToast(ezT('Select at least 2 cards first')); return; }
  const target = found[0].item; const others = [];
  found.slice(1).forEach((x) => { target.files = target.files.concat(x.item.files); others.push(x); });
  others.forEach((x) => { x.card.items = x.card.items.filter((it) => it !== x.item); });
  node._ezItemSel.clear();
  syncToConfig(node); render(node); uiToast(ezT('Merged ') + found.length + ezT(' cards into a batch card'));
}

// ===== 管理分组（多选「分组」合并，分组级）=====
function toggleGroupManager(node) {
  node._ezGrpMgr = !node._ezGrpMgr; node._ezGrpSel = node._ezGrpSel || new Set();
  if (!node._ezGrpMgr) node._ezGrpSel.clear(); render(node);
}
function groupMgrClick(node, gi) {
  const st = stateFor(node); const sel = node._ezGrpSel || (node._ezGrpSel = new Set());
  const id = String(st.groups[gi].id);
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  const elm = node._emlRoot && node._emlRoot.querySelector('.eml-tab[data-gid="' + id + '"]');
  if (elm) elm.classList.toggle('mgr-sel', sel.has(id));
  updateMgrCount(node);
}
function selectAllGroups(node) { const st = stateFor(node); st.groups.forEach((gr) => node._ezGrpSel.add(String(gr.id))); node._ezGrpSel = node._ezGrpSel || new Set(); render(node); }
function clearGroups(node) { node._ezGrpSel.clear(); render(node); }
function invertGroups(node) { const st = stateFor(node); const sel = node._ezGrpSel || new Set(); st.groups.forEach((gr) => { const id = String(gr.id); if (sel.has(id)) sel.delete(id); else sel.add(id); }); render(node); }
function mergeGroups(node) {
  const st = stateFor(node); const sel = node._ezGrpSel || new Set();
  const groups = st.groups.filter((gr) => sel.has(String(gr.id)));
  if (groups.length < 2) { uiToast(ezT('Select at least 2 groups first')); return; }
  const target = groups[0]; const others = [];
  groups.slice(1).forEach((gr) => { gr.cards.forEach((c) => target.cards.push({ id: genId(), name: c.name, items: deepClone(c.items) })); others.push(gr); });
  st.groups = st.groups.filter((gr) => !others.includes(gr));
  if (!st.groups.some((gr) => gr.id === st.currentGroupId)) st.currentGroupId = st.groups[0].id;
  node._ezGrpSel.clear();
  syncToConfig(node); updatePorts(node, true); render(node); uiToast(ezT('Merged ') + groups.length + ezT(' groups into "') + (target.name || ezT('Group')) + ezT('"'));
}

function startCardDrag(e, node, g, card) {
  const root = node._emlRoot; if (!root) return;
  const cardDiv = e.currentTarget.closest('.eml-card'); if (!cardDiv) return;
  const rect = cardDiv.getBoundingClientRect();
  const ghost = cardDiv.cloneNode(true); ghost.classList.add('dragging');
  ghost.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;opacity:.92;width:' + rect.width + 'px;left:' + rect.left + 'px;top:' + rect.top + 'px;';
  document.body.appendChild(ghost); cardDiv.classList.add('dragging');
  const offsetY = e.clientY - rect.top;
  const line = el('div'); line.style.cssText = 'height:5px;background:var(--ez-strong);border-radius:2px;flex:0 0 5px;opacity:0;pointer-events:none;';
  let curIdx = g.cards.findIndex((c) => c.id === card.id);
  let targetGid = g.id;
  const onMove = (ev) => {
    if (switchGroupIfHover(node, ev)) { targetGid = stateFor(node).currentGroupId; return; }
    targetGid = stateFor(node).currentGroupId;   // 跟着当前显示的分组走，不要重置回源分组
    const container = root.querySelector('.eml-cards'); if (!container) return;
    ghost.style.top = (ev.clientY - offsetY) + 'px';
    const all = Array.from(container.querySelectorAll('.eml-card')).filter((x) => x !== cardDiv);
    let insertIdx = all.length;
    // 以“素材卡片组标题行”上沿作为插入边界
    for (let i = 0; i < all.length; i++) { const head = all[i].querySelector('.eml-card-head'); const r = (head || all[i]).getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { insertIdx = i; break; } }
    if (line.parentNode) line.parentNode.removeChild(line);
    if (insertIdx < all.length) container.insertBefore(line, all[insertIdx]);
    else { const last = all[all.length - 1]; if (last) container.insertBefore(line, last.nextSibling); else container.appendChild(line); }
    line.style.opacity = '1';
    onMove._idx = insertIdx;
  };
  let _raf = 0, _lastEv = null;
  const onMoveRaf = (ev) => { _lastEv = ev; if (_raf) return; _raf = requestAnimationFrame(() => { _raf = 0; onMove(_lastEv); }); };
  const onUp = () => {
    if (_raf) cancelAnimationFrame(_raf);
    if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    cardDiv.classList.remove('dragging');
    if (line.parentNode) line.parentNode.removeChild(line);
    document.removeEventListener('mousemove', onMoveRaf); document.removeEventListener('mouseup', onUp);
    const st = stateFor(node);
    const tg = st.groups.find((x) => String(x.id) === String(targetGid)) || g;
    if (tg === g) {
      let target = onMove._idx != null ? onMove._idx : curIdx;
      if (onMove._idx != null && onMove._idx > curIdx) target -= 1;
      target = Math.max(0, Math.min(g.cards.length - 1, target));
      if (target !== curIdx) { const [moved] = g.cards.splice(curIdx, 1); g.cards.splice(target, 0, moved); syncToConfig(node); updatePorts(node, true); render(node); }
    } else {
      const [moved] = g.cards.splice(curIdx, 1); if (!moved) return;
      tg.cards = tg.cards || [];
      tg.cards.splice(Math.max(0, Math.min(tg.cards.length, onMove._idx != null ? onMove._idx : tg.cards.length)), 0, moved);
      syncToConfig(node); updatePorts(node, true); render(node);
    }
  };
  document.addEventListener('mousemove', onMoveRaf); document.addEventListener('mouseup', onUp);
  e.preventDefault();
}

// ===== 长按单个卡片 → 拖入另一卡片/批量卡片合并 =====
function mediaLongPress(e, node, g, card, item, elm) {
  if (e.button !== 0) return;
  if (e.target.closest('.rm') || e.target.closest('audio') || e.target.closest('button')) return;
  const timer = setTimeout(() => { elm._longDrag = true; beginItemDrag(node, g, card, item, elm); }, 220);
  elm.addEventListener('mouseup', () => { clearTimeout(timer); }, { once: true });
}
function beginItemDrag(node, g, card, item, elm) {
  const rect = elm.getBoundingClientRect();
  const ghost = elm.cloneNode(true); ghost.classList.add('dragging');
  ghost.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;opacity:.85;width:' + rect.width + 'px;left:' + rect.left + 'px;top:' + rect.top + 'px;box-shadow:0 12px 32px rgba(0,0,0,.2);';
  document.body.appendChild(ghost); elm.classList.add('dragging');
  const line = el('div', 'eml-drop-line');
  let drop = null;
  const clearDz = () => {
    document.querySelectorAll('.eml-media.drop-target').forEach((x) => x.classList.remove('drop-target'));
    document.querySelectorAll('.eml-grid.dz').forEach((x) => x.classList.remove('dz'));
    if (line.parentNode) line.parentNode.removeChild(line);
    line.style.opacity = '0';
    drop = null;
  };
  const move = (ev) => {
    ghost.style.left = (ev.clientX - rect.width / 2) + 'px'; ghost.style.top = (ev.clientY - 20) + 'px';
    if (switchGroupIfHover(node, ev)) { clearDz(); return; }   // 悬停分组标签：像浏览器一样切组
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const t = el && el.closest ? el.closest('.eml-media') : null;
    const gr = el && el.closest ? el.closest('.eml-grid') : null;
    clearDz();
    let insert = false;
    if (t && t !== elm) {
      const r = t.getBoundingClientRect();
      const rel = (ev.clientX - r.left) / Math.max(1, r.width);
      if (rel > 0.18 && rel < 0.82) { t.classList.add('drop-target'); drop = { mode: 'merge', el: t }; return; }
      insert = true;   // 卡片左/右边缘 = 插到它前面/后面
    } else if (gr) { insert = true; }
    if (!insert || !gr) return;
    const items = Array.from(gr.querySelectorAll('.eml-media')).filter((x) => x !== elm);
    const grRect = gr.getBoundingClientRect();
    const gScale = (gr.offsetWidth > 0 && grRect.width > 0) ? (grRect.width / gr.offsetWidth) : 1;   // 画布缩放：屏幕差要除回 CSS px
    // 按光标 Y 选行（多行网格只比 X 会挑错行），再在该行里按 X 找「两卡之间的居中缝」
    const rows = [];
    items.forEach((it, i) => {
      const r = it.getBoundingClientRect();
      let row = rows.find((rw) => Math.abs(rw[0].r.top - r.top) < 6);
      if (!row) { row = []; rows.push(row); }
      row.push({ it, i, r });
    });
    let row = null, rowD = Infinity;
    rows.forEach((rw) => {
      const top = Math.min(...rw.map((x) => x.r.top)), bottom = Math.max(...rw.map((x) => x.r.bottom));
      const d = (ev.clientY >= top && ev.clientY <= bottom) ? 0 : Math.min(Math.abs(ev.clientY - top), Math.abs(ev.clientY - bottom));
      if (d < rowD) { rowD = d; row = rw; }
    });
    line.style.position = 'absolute'; line.style.bottom = 'auto';
    let idx = 0;
    if (!row || !row.length) {
      const srcR = elm.getBoundingClientRect();   // 目标卡片组是空的：拿被拖卡片的实际高度当线高
      const hh = ((srcR.height > 4) ? srcR.height : grRect.height) / gScale;
      line.style.top = '2px'; line.style.height = Math.max(24, hh) + 'px'; line.style.left = '2px';
    } else {
      row.sort((a, b) => a.r.left - b.r.left);
      const r0 = row[0].r;
      let k = row.length;
      for (let j = 0; j < row.length; j++) { if (ev.clientX < row[j].r.left + row[j].r.width / 2) { k = j; break; } }
      let gapX;
      if (k === 0) gapX = r0.left - 5;
      else if (k === row.length) gapX = row[row.length - 1].r.right + 5;
      else gapX = (row[k - 1].r.right + row[k].r.left) / 2;   // 缝隙正中
      line.style.top = ((r0.top - grRect.top) / gScale) + 'px';
      line.style.height = (r0.height / gScale) + 'px';
      line.style.left = ((gapX - grRect.left) / gScale) + 'px';
      idx = (k < row.length) ? row[k].i : (row[row.length - 1].i + 1);
    }
    if (gr.dataset.cid === card.id && idx === (card.items || []).indexOf(item)) { clearDz(); return; }   // 原位不动：不画线
    gr.appendChild(line); line.style.opacity = '1';
    drop = { mode: 'insert', cid: gr.dataset.cid, idx };
  };
  let _raf = 0, _lastEv = null;
  const moveRaf = (ev) => { _lastEv = ev; if (_raf) return; _raf = requestAnimationFrame(() => { _raf = 0; move(_lastEv); }); };
  const up = (ev) => {
    if (_raf) cancelAnimationFrame(_raf);
    window.removeEventListener('pointermove', moveRaf, true); window.removeEventListener('pointerup', up, true);
    if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    elm.classList.remove('dragging');
    const d = drop; clearDz();
    if (!d) return;
    if (d.mode === 'merge') {
      const targetItem = findItemByEl(node, d.el);
      if (targetItem && targetItem !== item) {
        targetItem.files = targetItem.files.concat(item.files || []);
        (card.items || []).forEach((it, i) => { if (it === item) card.items.splice(i, 1); });
        syncToConfig(node); render(node); uiToast(ezT('Merged the card into the target card (now a batch card)'));
      }
      return;
    }
    const tcard = findCardById(node, d.cid); if (!tcard) return;
    (card.items || []).forEach((it, i) => { if (it === item) card.items.splice(i, 1); });
    tcard.items = tcard.items || [];
    tcard.items.splice(Math.max(0, Math.min(tcard.items.length, d.idx)), 0, item);
    syncToConfig(node); render(node);
  };
  window.addEventListener('pointermove', moveRaf, true); window.addEventListener('pointerup', up, true);
}
function switchGroupIfHover(node, ev) {
  const root = node._emlRoot; if (!root) return false;
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const tab = el && el.closest ? el.closest('.eml-tab') : null;
  const gid = tab && tab.dataset ? tab.dataset.gid : null;
  if (!gid) return false;
  const st = stateFor(node);
  if (String(st.currentGroupId) === String(gid)) return false;
  st.currentGroupId = gid; syncToConfig(node); render(node);
  return true;
}
function findCardById(node, cid) {
  const st = stateFor(node);
  for (const grp of st.groups) for (const c of (grp.cards || [])) { if (String(c.id) === String(cid)) return c; }
  return null;
}
function findItemByEl(node, elm) {
  const itemId = elm && elm.dataset ? elm.dataset.itemId : null;
  const st = stateFor(node);
  for (const grp of st.groups) for (const c of (grp.cards || [])) for (const it of (c.items || [])) { if (String(it.id) === String(itemId)) return it; }
  return null;
}
// ===== 分组长按拖动排序 =====
function groupLongPress(e, node, gi, tab) {
  if (e.button !== 0) return;
  if (e.target.closest('.tclose')) return;
  const timer = setTimeout(() => { tab._grpDrag = true; beginGroupDrag(e, node, gi, tab); }, 220);
  tab.addEventListener('mouseup', () => { clearTimeout(timer); }, { once: true });
}
function beginGroupDrag(e, node, gi, tab) {
  const st = stateFor(node);
  const tabsBar = node._emlRoot && node._emlRoot.querySelector('.eml-tabs');
  if (!tabsBar) return;
  const rect = tab.getBoundingClientRect();
  const ghost = tab.cloneNode(true);
  ghost.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;opacity:.9;width:' + rect.width + 'px;left:' + rect.left + 'px;top:' + rect.top + 'px;box-shadow:0 10px 28px rgba(0,0,0,.2);';
  document.body.appendChild(ghost); tab.classList.add('dragging');
  tabsBar.style.position = 'relative';
  const line = el('div'); line.style.cssText = 'position:absolute;top:2px;bottom:2px;width:3px;background:var(--ez-strong);border-radius:2px;opacity:0;z-index:5;pointer-events:none;';
  tabsBar.appendChild(line);
  let cur = gi;
  let _raf = 0, _lastEv = null;
  const move = (ev) => {
    ghost.style.left = (ev.clientX - rect.width / 2) + 'px';
    const tabs = Array.from(tabsBar.querySelectorAll('.eml-tab')).filter((t) => t !== line);
    let hover = 0;
    tabs.forEach((t, i) => { const r = t.getBoundingClientRect(); if (ev.clientX > r.left + r.width / 2) hover = i + 1; });
    // 竖线画在两张标签的居中缝里（绝对定位，不参与 flex 排布）
    const barR = tabsBar.getBoundingClientRect();
    const tScale = (tabsBar.offsetWidth > 0 && barR.width > 0) ? (barR.width / tabsBar.offsetWidth) : 1;
    let gx;
    if (!tabs.length) gx = 2;
    else if (hover === 0) gx = tabs[0].getBoundingClientRect().left - barR.left - 2;
    else if (hover >= tabs.length) gx = tabs[tabs.length - 1].getBoundingClientRect().right - barR.left + 2;
    else gx = ((tabs[hover - 1].getBoundingClientRect().right + tabs[hover].getBoundingClientRect().left) / 2) - barR.left;
    line.style.left = (gx / tScale) + 'px';
    line.style.opacity = '1';
    move._h = hover;
  };
  const moveRaf = (ev) => { _lastEv = ev; if (_raf) return; _raf = requestAnimationFrame(() => { _raf = 0; move(_lastEv); }); };
  const up = () => {
    if (_raf) cancelAnimationFrame(_raf);
    window.removeEventListener('pointermove', moveRaf, true); window.removeEventListener('pointerup', up, true);
    if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    tab.classList.remove('dragging');
    if (line.parentNode) line.parentNode.removeChild(line);
    const hover = move._h != null ? move._h : gi;
    if (hover !== gi && hover >= 0 && hover <= st.groups.length) {
      const idx = hover > gi ? hover - 1 : hover;
      const [g] = st.groups.splice(gi, 1); st.groups.splice(idx, 0, g);
      syncToConfig(node); updatePorts(node, true); render(node);
    }
  };
  window.addEventListener('pointermove', moveRaf, true); window.addEventListener('pointerup', up, true);
}

// ===== 预设 =====
async function loadPresetsInto(sel) {
  try {
    const r = await fetch(PRESET_API); const list = await r.json();
    const st = sel._node ? stateFor(sel._node) : null; sel.innerHTML = '';
    const dOpt = el('option'); dOpt.value = 'default'; dOpt.textContent = 'default'; if (st && st.currentPreset === 'default') dOpt.selected = true; sel.appendChild(dOpt);
    (Array.isArray(list) ? list : []).forEach((p) => { if (p && (p.name === 'default' || p.kind === 'fixed')) return; const o = el('option'); o.value = p.name; o.textContent = p.name; if (st && p.name === st.currentPreset) o.selected = true; sel.appendChild(o); });
    if (st && st.currentPreset && st.currentPreset !== 'default' && ![...sel.options].some((o) => o.value === st.currentPreset)) { const o = el('option'); o.value = st.currentPreset; o.textContent = st.currentPreset; sel.appendChild(o); }
    const dd = sel._dd;
    if (dd) {
      const cur = st ? st.currentPreset : (sel.value || 'default');
      dd.btn.textContent = cur;
      dd.menu.innerHTML = '';
      const opts = [...sel.options];
      if (!opts.length) { const e = el('div', 'eml-preset-item'); e.textContent = ezT('(No presets)'); e.style.cssText = 'padding:6px 12px;font-size:12px;color:var(--ez-fg-muted);'; dd.menu.appendChild(e); }
      opts.forEach((o) => { const it = el('div', 'eml-preset-item' + (o.value === cur ? ' active' : '')); it.textContent = o.value; it.dataset.v = o.value; dd.menu.appendChild(it); });
    }
  } catch (_) {}
}
async function saveCurrentPreset(node) {
  let dft = ezT('Preset 1');
  try { const l = await (await fetch(PRESET_API)).json(); dft = ezT('Preset') + ((l || []).length + 1); } catch (_) {}
  const name = await uiPrompt(ezT('Enter preset name:'), dft);
  if (!name || !name.trim()) return;
  if (name.trim() === 'default') { uiToast(ezT('That name is reserved for a built-in preset')); return; }   // default 是前端合成的内置项，同名存档不会显示
  const st = stateFor(node);
  try {
    await fetch(PRESET_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), groups: deepClone(st.groups), currentGroupId: st.currentGroupId }) });
    st.currentPreset = name.trim(); syncToConfig(node);
    const sel = node._emlRoot && node._emlRoot.querySelector('.eml-preset'); if (sel) { sel._node = node; loadPresetsInto(sel); }
    uiToast(ezT('Preset saved'));
  } catch (_) { uiToast(ezT('Save failed')); }
}
function applyPreset(node, name) {
  (async () => {
    try {
      const st = stateFor(node);
      if (name === 'default') {
        st.groups = [{ id: genId(), name: ezT('Group'), cards: [{ id: genId(), name: ezT('Card group 1'), items: [] }] }];
        st.currentPreset = 'default'; st.currentGroupId = st.groups[0].id;
        syncToConfig(node); updatePorts(node, true); render(node);
        return;
      }
      const list = await (await fetch(PRESET_API)).json();
      const p = (list || []).find((x) => x.name === name); if (!p) return;
      st.groups = deepClone(p.groups || []); st.currentPreset = name;
      st.currentGroupId = p.currentGroupId && st.groups.some((g) => g.id === p.currentGroupId) ? p.currentGroupId : (st.groups[0] && st.groups[0].id);
      if (!st.groups.length) { st.groups = [{ id: genId(), name: ezT('Group'), cards: [{ id: genId(), name: ezT('Card group 1'), items: [] }] }]; }
      syncToConfig(node); updatePorts(node, true); render(node);
    } catch (_) {}
  })();
}
async function deletePreset(node) {
  const sel = node._emlRoot && node._emlRoot.querySelector('.eml-preset'); const name = sel && sel.value;
  if (!name) { uiToast(ezT('No preset to delete')); return; }
  if (name === 'default') { uiToast(ezT('The default preset cannot be deleted')); return; }
  try { await fetch(PRESET_API + '/' + encodeURIComponent(name), { method: 'DELETE' }); stateFor(node).currentPreset = 'default'; syncToConfig(node); if (sel) { sel._node = node; loadPresetsInto(sel); } uiToast(ezT('Preset deleted')); } catch (_) { uiToast(ezT('Delete failed')); }
}

// ===== 文件浏览（可导航任意路径：path bar + 左侧目录 + 底部图标工具栏 + ctrl/shift 多选）=====
async function fetchBrowse(path) {
  try { const r = await fetch('/media_loader/browse?path=' + encodeURIComponent(path || '')); const d = await r.json(); if (d && d.error) uiToast(ezT('Browse failed: ') + d.error); if (d && ((d.files && d.files.length) || (d.dirs && d.dirs.length) || d.path)) return { path: d.path || '', parent: d.parent || '', name: d.name || '', dirs: d.dirs || [], files: d.files || [], roots: d.roots || [], mine: d.mine || [] }; } catch (_) {}
  try { const r = await fetch('/media_loader/files'); const d = await r.json(); const fl = d.files || []; return { path: '', parent: '', name: 'input', dirs: [], files: fl, _legacy: true }; } catch (_) {}
  return { path: '', parent: '', name: '', dirs: [], files: [] };
}
function openBrowse(node, g, card) {
  const ov = el('div', 'eml-browse');
  ov.style.cssText = 'position:fixed;inset:0;z-index:9998;background:var(--ez-surface-2);color:var(--ez-fg);font-family:Inter,sans-serif;display:flex;flex-direction:column;';
  ov.innerHTML = '<div class="eml-toolbar" style="display:flex;align-items:center;gap:6px;padding:10px 18px 10px 46px;background:var(--ez-bg);border-bottom:1px solid var(--ez-border);flex-shrink:0;flex-wrap:wrap;position:relative;"><b style="font-size:15px;white-space:nowrap;">' + ezT('Media browser') + '</b>' +
    '<button class="eml-navb" title="' + ezT('Back') + '" style="background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:8px;width:28px;height:28px;color:var(--ez-fg-2);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex:0 0 auto;">←</button>' +
    '<button class="eml-navf" title="' + ezT('Forward') + '" style="background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:8px;width:28px;height:28px;color:var(--ez-fg-2);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex:0 0 auto;">→</button>' +
    '<button class="eml-navup" title="' + ezT('Parent directory') + '" style="background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:8px;width:28px;height:28px;color:var(--ez-fg-2);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex:0 0 auto;">↑</button>' +
    '<button class="eml-navr" title="' + ezT('Refresh') + '" style="background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:8px;width:28px;height:28px;color:var(--ez-fg-2);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex:0 0 auto;">↻</button>' +
    '<input class="eml-bbsearch" placeholder="' + ezT('Search this folder…') + '" style="flex:1 1 auto;max-width:360px;min-width:120px;padding:6px 10px;font-size:12px;border:1px solid var(--ez-border);border-radius:7px;background:var(--ez-bg);outline:none;font-family:inherit;">' +
    '<input class="eml-path" placeholder="' + ezT('Enter a path…') + '" title="' + ezT('Type a drive/path and press Enter to go') + '" style="flex:0 1 auto;max-width:260px;min-width:130px;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:7px;padding:6px 10px;font-size:12px;outline:none;font-family:inherit;" />' +
    '<button class="eml-bbclose" style="position:absolute;top:8px;right:14px;width:28px;height:28px;border-radius:50%;border:1px solid rgba(220,38,38,.32);background:rgba(220,38,38,.1);color:var(--ez-bad-fg);font-size:15px;cursor:pointer;">✕</button></div>' +
    '<div style="flex:1;display:flex;min-height:0;"><div class="eml-bbtree" style="width:240px;flex-shrink:0;background:var(--ez-bg);border-right:1px solid var(--ez-border);overflow:auto;padding:6px 0;"></div><div style="flex:1;display:flex;flex-direction:column;min-width:0;"><div class="eml-panebar" style="display:flex;align-items:center;gap:6px;padding:6px 14px;background:var(--ez-bg);border-bottom:1px solid var(--ez-border-2);flex-shrink:0;flex-wrap:wrap;"><span class="eml-viewbar" style="display:flex;gap:2px;background:var(--ez-surface-3);border-radius:8px;padding:2px;border:1px solid var(--ez-border);"><button data-v="list" title="' + ezT('List') + '">☰</button><button data-v="big" title="' + ezT('Large icons') + '">▦</button><button data-v="small" title="' + ezT('Small icons') + '">▤</button><button data-v="detail" title="' + ezT('Detail view') + '">≡</button></span>' +
    '<button class="eml-selall" title="' + ezT('Select all') + '" style="background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:7px;padding:4px 10px;font-size:12px;cursor:pointer;">' + ezT('Select all') + '</button>' +
    '<button class="eml-selinv" title="' + ezT('Invert') + '" style="background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:7px;padding:4px 10px;font-size:12px;cursor:pointer;">' + ezT('Invert') + '</button>' +
    '<button class="eml-selclr" title="' + ezT('Deselect') + '" style="background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:7px;padding:4px 10px;font-size:12px;cursor:pointer;">' + ezT('Clear') + '</button>' +
    '<span class="eml-bbcount" style="font-size:12px;color:var(--ez-fg-3);">' + ezT('Selected ') + 0 + ezT(' item(s)') + '</span></div><div class="eml-bblist" style="flex:1;overflow:auto;padding:12px 18px;"></div></div></div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 18px;background:var(--ez-bg);border-top:1px solid var(--ez-border);flex-shrink:0;"><span style="font-size:11px;color:var(--ez-fg-muted);">' + ezT('Drag files here to upload / drag files onto cards') + '</span><button class="eml-bbadd" style="background:var(--ez-strong);border:1px solid var(--ez-strong);color:var(--ez-on-strong);border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer;">' + ezT('Add to card group') + '</button></div>';
  document.body.appendChild(ov);
  // 鼠标在浏览器里就能滚（经典模式没有全局滚轮兜底，以前必须去拖滚动条）
  ov.addEventListener('wheel', (e) => {
    let el = e.target;
    while (el && el !== ov && !(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) el = el.parentElement;
    if (!el || el === ov) return;
    const mult = e.deltaMode === 1 ? 16 : 1;
    if (el.scrollHeight > el.clientHeight + 1) el.scrollTop += e.deltaY * mult;
    else if (el.scrollWidth > el.clientWidth + 1) el.scrollLeft += e.deltaY * mult;
    e.preventDefault(); e.stopPropagation();
  }, { passive: false });
  // 「＋根」：把输入框/当前目录登记为「可浏览根目录」（后端只允许本机登记；浏览器只能在根目录内导航）
  try {
    const pb = ov.querySelector('.eml-path');
    if (pb && pb.parentNode) {
      const rb = el('button', 'eml-addroot'); rb.style.flex = '0 0 auto';
      rb.textContent = ezT('Save root');
      rb.title = ezT('Add the folder in the field above as a browsable root and enter it (local only). To limit unauthorized reads, the browser can only navigate inside roots.');
      rb.style.cssText = 'background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:7px;padding:6px 10px;font-size:12px;color:var(--ez-fg-2);cursor:pointer;white-space:nowrap;';
      rb.addEventListener('click', async () => {
        const v = (pb.value || '').trim() || cur;
        if (!v) { uiToast(ezT('Enter a folder in the path field first')); return; }
        try {
          const r = await fetch('/media_loader/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: v }) });
          const d = await r.json().catch(() => ({}));
          if (d && d.ok) { uiToast((d.note ? ezT('Already a root: ') : ezT('Added as browsable root: ')) + v); await refreshRoots(v); navigate(v, false); }
          else uiToast(ezT('Failed to add root: ') + ((d && d.error) || ('HTTP ' + r.status)));
        } catch (err) { uiToast(ezT('Failed to add root: ') + (err && err.message || err)); }
      });
      const rs = el('select', 'eml-roots');
      const rph = el('option'); rph.value = ''; rph.textContent = ezT('— Root —'); rs.appendChild(rph);
      rs.title = ezT('Browsable roots: remote/web sessions can only see inside roots; locally you can use "Add as root" on the right to add other folders');
      rs.style.cssText = 'background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:7px;padding:5px 8px;font-size:12px;color:var(--ez-fg-2);max-width:230px;min-width:130px;flex:0 0 auto;';
      rs.addEventListener('change', () => { pinnedRoot = rs.value; syncDelBtn(); if (rs.value) navigate(rs.value, false); });
      const host = pb.parentNode || ov.querySelector('.eml-toolbar') || ov;
      const rx = el('button', 'eml-rmroot'); rx.style.flex = '0 0 auto';
      rx.textContent = ezT('Delete root');
      rx.title = ezT('Delete the root selected in the dropdown (built-in roots are always available)');
      rx.style.cssText = 'background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:7px;padding:6px 10px;font-size:12px;color:var(--ez-bad-fg);cursor:pointer;white-space:nowrap;';
      rx.addEventListener('click', async () => {
        const v = (rs.value || '').trim() || (pb.value || '').trim() || cur;
        if (!v) return;
        try {
          const r = await fetch('/media_loader/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remove: v }) });
          const d = await r.json().catch(() => ({}));
          uiToast((d && d.ok) ? (ezT('Removed from browsable roots: ') + v) : (ezT('Failed to remove root: ') + ((d && d.error) || ('HTTP ' + r.status))));
          if (d && d.ok) await refreshRoots('');
          navigate(cur || '', false);
        } catch (err) { uiToast(ezT('Failed to remove root: ') + (err && err.message || err)); }
      });
      host.insertBefore(rs, pb);
      host.insertBefore(rb, pb.nextSibling);
      host.insertBefore(rx, rb.nextSibling);
    }
  } catch (_) {}
  const closeBrowse = () => { document.removeEventListener('mousedown', onDown); if (ov.parentNode) ov.parentNode.removeChild(ov); };
  const onDown = (e) => { if (!ov.contains(e.target)) closeBrowse(); };
  document.addEventListener('mousedown', onDown);
  ov.querySelector('.eml-bbclose').addEventListener('click', closeBrowse);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeBrowse(); });
  const tree = ov.querySelector('.eml-bbtree'), list = ov.querySelector('.eml-bblist'), count = ov.querySelector('.eml-bbcount'), search = ov.querySelector('.eml-bbsearch');
  const icons = { image: '🖼', video: '🎬', audio: '🎵', model_3d: '🧊' };
  const icon = (t) => icons[t] || '📄';
  const isAbsImg = (f) => f.type === 'image';
  let cur = ''; let curData = { files: [], dirs: [], parent: '', path: '' };
  let selFolder = ''; let paneFiles = [];
  let selected = new Set(); let lastAnchor = -1; let view = 'big';
  let hist = []; let histIdx = -1; let mineRoots = []; let pinnedRoot = '';
  const fileUrl = (f) => { if (f.url) return f.url; return '/media_loader/serve?path=' + encodeURIComponent(f.path || ''); };
  // 用后端刚返回的 roots 立刻重建下拉（保存/删除根目录后不用再手点一次）
  const rootLabel = (p) => { const s = String(p || ''); const parts = s.split(s.indexOf('\\') >= 0 ? '\\' : '/').filter(Boolean); return parts.pop() || s; };
  const applyRoots = (roots, pick, mine) => {
    const rs = ov.querySelector('.eml-roots');
    if (!rs) return;
    if (Array.isArray(mine)) mineRoots = mine;
    const list = roots || [];
    const sig = list.join('|');
    if (rs.dataset.sig !== sig) {
      rs.dataset.sig = sig;
      rs.innerHTML = '';
      if (!list.length) { const ph = el('option'); ph.value = ''; ph.textContent = ezT('— Root (backend not ready) —'); rs.appendChild(ph); }
      list.forEach((p) => { const o = el('option'); o.value = p; o.textContent = rootLabel(p); o.title = p; rs.appendChild(o); });
    }
    if (pick) rs.value = pick;
    syncDelBtn();
  };
  // 删除按钮只对「自己登记的根」可用：内置 input/output 与扫描目录不可删（灰掉而不是点了没反应）
  const syncDelBtn = () => {
    const rs = ov.querySelector('.eml-roots'), rx = ov.querySelector('.eml-rmroot');
    if (!rs || !rx) return;
    const on = mineRoots.indexOf(String(rs.value || '')) >= 0;
    rx.disabled = !on;
    rx.style.opacity = on ? '' : '.45';
    rx.style.cursor = on ? 'pointer' : 'default';
    rx.style.color = on ? 'var(--ez-bad-fg)' : 'var(--ez-fg-muted)';
  };
  const refreshRoots = async (pick) => {
    try { const r = await fetch('/media_loader/roots'); const d = await r.json(); applyRoots(d.roots || [], pick || '', d.mine || []); } catch (_) {}
  };
  const navigate = async (path, push = true) => {
    if (push && path !== cur) { hist = hist.slice(0, histIdx + 1); hist.push(path); histIdx = hist.length - 1; }
    const d = await fetchBrowse(path);
    curData = d; cur = d.path || path;
    selFolder = cur; paneFiles = (d.files || []).slice();
    selected = new Set(); lastAnchor = -1;
    treeCache[cur] = (d.dirs || []).map((x) => ({ name: x.name, path: x.path }));
    // 根目录下拉 + 「上级」可用状态（到根就是底，不再往上爬）
    try {
      const rp = String(d.path || '');
    const inPin = !!pinnedRoot && (rp === pinnedRoot || (rp.indexOf(pinnedRoot) === 0 && (rp[pinnedRoot.length] === '\\' || rp[pinnedRoot.length] === '/')));
    if (!inPin) pinnedRoot = '';
    applyRoots(d.roots || [], inPin ? pinnedRoot : (d.root || (d.roots || [])[0] || ''), d.mine || []);
      const up = ov.querySelector('.eml-navup');
      if (up) { up.style.opacity = d.parent ? '' : '.45'; up.title = d.parent ? ezT('Parent directory') : ezT('Already at the root (to go to a parent folder, click "Add as root")'); }
    } catch (_) {}
    drawTree(); drawPane();
  };
  const _fSVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
  const treeCache = {}; const treeExpanded = {};
  const loadChildren = async (path) => { if (treeCache[path]) return treeCache[path]; const d = await fetchBrowse(path); treeCache[path] = d.dirs || []; return treeCache[path]; };
  const _homeSVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 3l9 8h-3v9h-4v-6H10v6H6v-9H3z"/></svg>';
  const _chevSVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 6l6 6-6 6z"/></svg>';
  const drawTree = () => {
    tree.innerHTML = '';
    const home = el('div', 'eml-bbtrow' + (selFolder === '' ? ' sel' : ''));
    const htw = el('div', 'eml-bbtwist leaf'); htw.innerHTML = _chevSVG;
    const hic = el('span', 'eml-bbficon'); hic.innerHTML = _homeSVG;
    const hnm = el('div', 'eml-bbfname'); hnm.textContent = ezT('All media');
    home.appendChild(htw); home.appendChild(hic); home.appendChild(hnm);
    home.addEventListener('click', () => navigate(''));
    tree.appendChild(home);
    const dirs = treeCache[cur] || curData.dirs || [];
    if (!dirs.length) { const e = el('div'); e.textContent = ezT('(No subfolders)'); e.style.cssText = 'padding:8px 12px;font-size:11px;color:var(--ez-fg-muted);'; tree.appendChild(e); }
    const mkNode = (d, depth) => {
      const row = el('div', 'eml-bbtrow' + (selFolder === d.path ? ' sel' : '')); row.style.paddingLeft = (10 + depth * 26) + 'px';
      const twist = el('div', 'eml-bbtwist' + (treeExpanded[d.path] ? ' expanded' : '')); twist.innerHTML = _chevSVG;
      const ic = el('span', 'eml-bbficon'); ic.innerHTML = _fSVG;
      const nm = el('div', 'eml-bbfname'); nm.textContent = d.name; nm.title = d.path;
      row.appendChild(twist); row.appendChild(ic); row.appendChild(nm);
      row.addEventListener('click', async (e) => { e.stopPropagation(); if (treeExpanded[d.path]) { delete treeExpanded[d.path]; } else { await loadChildren(d.path); treeExpanded[d.path] = true; } const dd = await fetchBrowse(d.path); selFolder = d.path; paneFiles = (dd.files || []).slice(); selected = new Set(); lastAnchor = -1; drawTree(); drawPane(); });
      tree.appendChild(row);
      if (treeExpanded[d.path]) (treeCache[d.path] || []).forEach((c) => mkNode(c, depth + 1));
    };
    dirs.forEach((d) => mkNode(d, 0));
  };
  const refreshSel = () => { list.querySelectorAll('.eml-bb-item').forEach((x) => x.classList.toggle('sel', selected.has(x.dataset.path))); count.textContent = ezT('Selected ') + selected.size + ezT(' item(s)'); };
  // 卡片右上角 +/− 按钮（ModelsCombo 同款）：把一个素材加入/移出当前素材卡片。
  const fileEntryOf = (f) => ({ id: genId(), name: f.name, path: f.path || f.name, subfolder: '', dir: 'input', type: f.type || mediaKind(f.name), url: fileUrl(f), size: f.size, mtime: f.mtime });
  const cardHasFile = (f) => (card.items || []).some((it) => (it.files || []).some((x) => (x.path || x.name) === (f.path || f.name)));
  const toggleCardFile = (f) => {
    const p = f.path || f.name;
    let removed = false;
    (card.items || []).forEach((it) => { const before = (it.files || []).length; it.files = (it.files || []).filter((x) => (x.path || x.name) !== p); if (it.files.length !== before) removed = true; });
    if (!removed) { if (fixedTake(node, card, [f]).full) { uiToast(ezT('Fixed layout: no empty slot for these files')); return false; } card.items.push({ id: genId(), files: [fileEntryOf(f)] }); }
    card.items = card.items.filter((it) => (it.files || []).length);
    syncToConfig(node); render(node);
    return !removed;
  };
  const mkAddBtn = (f) => {
    const b = el('button'); b.type = 'button';
    b.style.cssText = 'position:absolute;top:6px;right:6px;z-index:3;width:26px;height:26px;border-radius:50%;border:1px solid rgba(255,255,255,.5);background:var(--ez-surface);color:var(--ez-fg);font-size:16px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:.15s;font-family:inherit;padding:0;';
    const refresh = () => { const on = cardHasFile(f); b.textContent = on ? '−' : '+'; b.title = on ? ezT('Remove from card group') : ezT('Add to card group'); b.style.background = on ? 'rgba(74,106,90,.85)' : 'rgba(255,255,255,.55)'; b.style.color = on ? 'var(--ez-on-strong)' : 'var(--ez-fg)'; };
    refresh();
    b.addEventListener('mouseenter', () => { b.style.transform = 'scale(1.05)'; });
    b.addEventListener('mouseleave', () => { b.style.transform = ''; });
    b.addEventListener('click', (e) => { e.stopPropagation(); toggleCardFile(f); refresh(); });
    return b;
  };
  const drawPane = () => {
    const q = (search.value || '').toLowerCase();
    let listF = (paneFiles || []).filter((f) => !q || (f.name || '').toLowerCase().indexOf(q) >= 0);
    list.innerHTML = '';
    if (!listF.length) { const e = el('div'); e.textContent = ezT('No media files found'); e.style.cssText = 'color:var(--ez-fg-muted);text-align:center;padding:40px 12px;font-size:13px;'; list.appendChild(e); return; }
    const toggleSel = (i, ev) => {
      const f = listF[i]; const p = f.path || f.name;
      if (ev.shiftKey && lastAnchor >= 0) {
        const a = Math.min(lastAnchor, i), b = Math.max(lastAnchor, i);
        selected = new Set(listF.slice(a, b + 1).map((x) => x.path || x.name));
        lastAnchor = i;
      } else if (ev.ctrlKey) { if (selected.has(p)) selected.delete(p); else selected.add(p); lastAnchor = i; }
      else { selected = new Set([p]); lastAnchor = i; }
      refreshSel();
    };
    const renderRow = (f) => {
      const row = el('div'); row.classList.add('eml-bb-item'); row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;font-size:12px;position:relative;'; row.dataset.path = f.path || f.name;
      const ic = el('span'); ic.textContent = icon(f.type); row.appendChild(ic);
      const nm = el('span'); nm.textContent = f.name; nm.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'; row.appendChild(nm);
      const sv = el('span'); sv.textContent = typeShort(f.type); sv.style.cssText = 'color:var(--ez-fg-3);font-size:10px;background:var(--ez-surface-3);padding:0 8px;border-radius:30px;'; row.appendChild(sv);
      row.appendChild(mkAddBtn(f));
      row.addEventListener('click', (e) => toggleSel(listF.indexOf(f), e));
      return row;
    };
    const renderTile = (f) => {
      const tile = el('div'); tile.classList.add('eml-bb-item'); tile.style.cssText = 'cursor:pointer;border:1px solid var(--ez-border-2);border-radius:9px;overflow:hidden;background:var(--ez-bg);align-self:start;position:relative;'; tile.dataset.path = f.path || f.name;
      const pv = el('div'); pv.style.cssText = 'height:88px;max-height:88px;min-height:88px;background:var(--ez-surface-3);display:flex;align-items:center;justify-content:center;font-size:30px;color:var(--ez-fg-muted);overflow:hidden;';
      if (isAbsImg(f)) { const im = el('img'); im.src = fileUrl(f); im.style.cssText = 'display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;'; pv.appendChild(im); } else pv.textContent = icon(f.type);
      const nm = el('div'); nm.textContent = f.name; nm.style.cssText = 'font-size:10px;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      tile.appendChild(pv); tile.appendChild(nm); tile.appendChild(mkAddBtn(f));
      tile.addEventListener('click', (e) => toggleSel(listF.indexOf(f), e));
      return tile;
    };
    if (view === 'big') { list.style.display = 'grid'; list.style.gridTemplateColumns = 'repeat(5,1fr)'; list.style.gridAutoRows = '112px'; list.style.gridAutoFlow = 'row'; list.style.gap = '10px'; list.style.alignItems = 'start'; listF.forEach((f) => list.appendChild(renderTile(f))); }
    else if (view === 'small') { list.style.display = 'grid'; list.style.gridTemplateColumns = 'repeat(8,1fr)'; list.style.gridAutoRows = '96px'; list.style.gridAutoFlow = 'row'; list.style.gap = '6px'; list.style.alignItems = 'start'; listF.forEach((f) => list.appendChild(renderTile(f))); }
    else if (view === 'detail') { list.style.display = 'flex'; list.style.flexDirection = 'column'; list.style.gap = '2px'; listF.forEach((f) => { const row = renderRow(f); const sz = el('span'); sz.textContent = formatSize(f.size); sz.style.cssText = 'color:var(--ez-fg-3);font-size:10px;min-width:64px;'; row.appendChild(sz); const mt = el('span'); mt.textContent = f.mtime || ''; mt.style.cssText = 'color:var(--ez-fg-muted);font-size:10px;min-width:120px;'; row.appendChild(mt); list.appendChild(row); }); }
    else { list.style.display = 'flex'; list.style.flexDirection = 'column'; list.style.gap = '2px'; listF.forEach((f) => list.appendChild(renderRow(f))); }
  };
  try { drawTree(); drawPane(); } catch (err) { try { list.innerHTML = ''; const e = el('div'); e.textContent = ezT('Failed to render browser: ') + (err && err.message || err); e.style.cssText = 'color:var(--ez-bad-fg);text-align:center;padding:20px;font-size:13px;'; list.appendChild(e); } catch (_) {} }
  ov.querySelector('.eml-navb').addEventListener('click', () => { if (histIdx > 0) { histIdx--; navigate(hist[histIdx], false); } });
  ov.querySelector('.eml-navf').addEventListener('click', () => { if (histIdx < hist.length - 1) { histIdx++; navigate(hist[histIdx], false); } });
  ov.querySelector('.eml-navup').addEventListener('click', () => {
    if (curData.parent) navigate(curData.parent);
    else uiToast(ezT('Already inside a browsable root; to go up, enter that parent folder in the path field above and click "Add as root"'));
  });
  ov.querySelector('.eml-navr').addEventListener('click', () => { navigate(cur, false); });
  ov.querySelector('.eml-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = (e.target.value || '').trim(); if (v) navigate(v); } });
  ov.querySelectorAll('.eml-viewbar button').forEach((b) => { b.style.cssText = 'background:transparent;border:none;padding:2px 8px;font-size:12px;color:var(--ez-fg-2);cursor:pointer;border-radius:6px;'; if (b.dataset.v === view) b.style.background = 'var(--ez-bg)'; b.addEventListener('click', () => { view = b.dataset.v; ov.querySelectorAll('.eml-viewbar button').forEach((x) => x.style.background = 'transparent'); b.style.background = 'var(--ez-bg)'; drawPane(); }); });
  ov.querySelector('.eml-selall').addEventListener('click', () => { selected = new Set(paneFiles.map((f) => f.path || f.name)); lastAnchor = paneFiles.length - 1; refreshSel(); });
  ov.querySelector('.eml-selinv').addEventListener('click', () => { const all = new Set(paneFiles.map((f) => f.path || f.name)); const inv = new Set(); all.forEach((p) => { if (!selected.has(p)) inv.add(p); }); selected = inv; lastAnchor = -1; refreshSel(); });
  ov.querySelector('.eml-selclr').addEventListener('click', () => { selected = new Set(); lastAnchor = -1; refreshSel(); });
  search.addEventListener('input', drawPane);
  ov.addEventListener('dragover', (e) => { e.preventDefault(); });
  ov.addEventListener('drop', async (e) => {
    e.preventDefault();
    const fl = e.dataTransfer && e.dataTransfer.files;
    if (!fl || !fl.length) return;
    const fd = new FormData(); Array.from(fl).forEach((f) => fd.append('files', f));
    try { await fetch('/media_loader/upload', { method: 'POST', body: fd }); await navigate(cur, false); uiToast(ezT('Uploaded ') + fl.length + ezT(' files to the input folder')); } catch (_) { uiToast(ezT('Upload failed')); }
  });
  ov.querySelector('.eml-bbadd').addEventListener('click', () => {
    const picked = (paneFiles||[]).filter((f) => selected.has(f.path || f.name));
    if (!picked.length) { uiToast(ezT('Select files first')); return; }
    const take = fixedTake(node, card, picked);
    if (!take.ok.length) { uiToast(ezT('Fixed layout: no empty slot for these files')); return; }
    card.items.push({ id: genId(), files: take.ok.map((f) => fileEntryOf(f)) });
    syncToConfig(node); render(node); closeBrowse();
    uiToast(take.full ? ezT('Fixed layout: only the empty slots were filled') : (ezT('Added ') + take.ok.length + ezT(' media files')));
  });
  try { navigate(''); } catch (err) { try { const e = el('div'); e.textContent = ezT('Failed to load browser: ') + (err && err.message || err); e.style.cssText = 'color:var(--ez-bad-fg);text-align:center;padding:20px;font-size:13px;'; list.appendChild(e); } catch (_) {} }
}

// ===== 预览模态框 =====
function openPreview(node, item, card) {
  const files = item.files || [];
  if (!files.length) return;
  if (node && node._emlRoot) node._emlRoot.querySelectorAll('audio,video').forEach((a) => { try { a.pause(); } catch (_) {} });   // 打开弹窗时停掉面板里所有播放
  const ov = el('div');
  const stopPv = () => { try { ov.querySelectorAll('audio,video').forEach((a) => { try { a.pause(); } catch (_) {} }); } catch (_) {} };
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:2000;';
  const box = el('div'); box.style.cssText = 'background:var(--ez-bg);border-radius:12px;width:92vw;max-width:920px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.2);overflow:hidden;';
  box.innerHTML = '<div class="eml-pvhd" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 20px;border-bottom:1px solid var(--ez-border-2);flex-shrink:0;"><span class="eml-pvtt" style="font-size:15px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span><span class="eml-pvmode" style="display:flex;gap:6px;"></span><button class="eml-pvx" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--ez-fg-muted);">✕</button></div>' +
    '<div class="eml-pvbody" style="flex:1;padding:14px 20px;overflow:auto;display:flex;flex-direction:column;gap:10px;min-height:280px;"><div class="eml-pvmain" style="position:relative;width:100%;height:52vh;min-height:280px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:var(--ez-bg);"></div><div class="eml-pvstripwrap" style="display:flex;align-items:center;gap:6px;flex-shrink:0;"><button class="eml-stripL">‹</button><div class="eml-pvstrip" style="flex:1;display:flex;gap:6px;overflow-x:auto;padding:6px 0;border-top:1px solid var(--ez-border-2);"></div><button class="eml-stripR">›</button></div></div>' +
    '<div class="eml-pvfoot" style="padding:10px 20px;border-top:1px solid var(--ez-border-2);font-size:12px;color:var(--ez-fg-3);display:flex;justify-content:space-between;"></div>';
  ov.appendChild(box); document.body.appendChild(ov);
  const tt = box.querySelector('.eml-pvtt'), mode = box.querySelector('.eml-pvmode'), main = box.querySelector('.eml-pvmain'), strip = box.querySelector('.eml-pvstrip'), foot = box.querySelector('.eml-pvfoot'), stripL = box.querySelector('.eml-stripL'), stripR = box.querySelector('.eml-stripR');
  stripL.style.cssText = stripR.style.cssText = 'background:none;border:none;display:flex;align-items:center;justify-content:center;color:var(--ez-fg-muted);cursor:pointer;padding:2px;flex:0 0 auto;';
  stripL.innerHTML = chevSvg(true, 18); stripR.innerHTML = chevSvg(false, 18);
  let idx = 0; let batch = false; let selSet = new Set();
  // 左右翻页箭头：容器整高但 **不吃点击**（pointer-events:none），只有中间那个圆形手柄可点。
  // 以前是 48px 宽、整高的可点条 —— 正好压在视频原生控制条左边的播放三角上，点三角当然没反应。
  const mkArrow = (side) => {
    const a = el('div');
    a.style.cssText = 'position:absolute;top:0;bottom:0;' + (side === 'L' ? 'left:0' : 'right:0') + ';width:48px;display:flex;align-items:center;justify-content:center;opacity:0;transition:.15s;z-index:5;pointer-events:none;';
    const hit = el('span');
    hit.innerHTML = chevSvg(side === 'L', 18);
    hit.style.cssText = 'width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--ez-fg-2);background:var(--ez-surface);box-shadow:0 2px 12px rgba(0,0,0,.18);cursor:pointer;pointer-events:auto;user-select:none;';
    a.appendChild(hit); a._hit = hit;
    main.appendChild(a);
    return a;
  };
  const aL = mkArrow('L'), aR = mkArrow('R');
  main.addEventListener('mouseenter', () => { aL.style.opacity = '1'; aR.style.opacity = '1'; });
  main.addEventListener('mouseleave', () => { aL.style.opacity = '0'; aR.style.opacity = '0'; });
  aL._hit.addEventListener('click', () => { if (files.length > 1) { idx = (idx - 1 + files.length) % files.length; draw(); } });
  aR._hit.addEventListener('click', () => { if (files.length > 1) { idx = (idx + 1) % files.length; draw(); } });
  const prev = () => { if (files.length > 1) idx = (idx - 1 + files.length) % files.length; draw(); };
  const next = () => { if (files.length > 1) idx = (idx + 1) % files.length; draw(); };
  const openLoc = (f) => { try { fetch('/media_loader/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.path }) }); } catch (_) {} };
  const openSave = async (f) => { if (!f) return; try { const d = await fetch('/media_loader/pick_folder', { method: 'POST' }); const j = await d.json(); if (!j.ok || !j.path) { uiToast(j.error || ezT('No folder selected')); return; } const r = await fetch('/media_loader/save_as', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.path, dest: j.path }) }); const res = await r.json(); uiToast(res.ok ? (ezT('Saved as ') + res.dest) : (ezT('Save failed: ') + (res.error || ''))); } catch (_) { uiToast(ezT('Save failed')); } };
  const buildMenu = (e, f, i) => {
    const menu = el('div'); menu.style.cssText = 'position:fixed;z-index:10000;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.16);padding:4px;min-width:170px;';
    const mk = (label, fn) => { const b = el('button'); b.textContent = label; b.style.cssText = 'display:block;width:100%;text-align:left;background:none;border:none;padding:6px 12px;font-size:12px;color:var(--ez-fg);cursor:pointer;border-radius:6px;font-family:inherit;'; b.addEventListener('click', () => { menu.remove(); fn(); }); menu.appendChild(b); };
    const fi = i != null ? i : idx;
    mk(ezT('Split'), () => { const ff = files[fi]; if (!ff) return; if (files.length <= 1) { uiToast(ezT('Only one file; nothing to split')); return; } const splits = [{ id: genId(), files: [ff] }]; files.splice(fi, 1); const i0 = card.items.indexOf(item); if (i0 >= 0) card.items.splice(i0 + 1, 0, ...splits); if (!files.length) card.items = card.items.filter((it) => it !== item); syncToConfig(node); render(node); ov.remove(); });
    mk(ezT('Batch split'), () => { batch = true; selSet = new Set(); renderMode(); draw(); });
    mk(ezT('Open file location'), () => openLoc(f));
    mk(ezT('Save as…'), () => openSave(f));
    document.body.appendChild(menu);
    const events = ['mousedown', 'pointerdown', 'mouseup', 'pointerup', 'contextmenu'];
    const offMenu = () => events.forEach((t) => document.removeEventListener(t, close, true));
    const close = (ev) => { if (!menu.isConnected) { offMenu(); return; } if (!menu.contains(ev.target)) menu.remove(); };
    events.forEach((t) => document.addEventListener(t, close, true));
    menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px'; menu.style.top = Math.min(e.clientY, window.innerHeight - 200) + 'px';
  };
  const renderMode = () => {
    mode.innerHTML = '';
    const mkBtn = (label, cls, fn) => { const b = el('button'); b.textContent = label; b.className = cls || ''; b.style.cssText = 'background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit;'; b.addEventListener('click', fn); mode.appendChild(b); };
    if (!batch) { mkBtn(ezT('Batch split'), 'eml-btn', () => { batch = true; selSet = new Set(); renderMode(); draw(); }); }
    else {
      mkBtn(ezT('Run split'), 'eml-btn', () => doBatchSplit());
      mkBtn(ezT('Invert'), 'eml-btn', () => { selSet = new Set(files.map((x, i) => i).filter((i) => !selSet.has(i))); draw(); });
      mkBtn(ezT('Deselect'), 'eml-btn', () => { selSet = new Set(); draw(); });
      mkBtn(ezT('Exit batch split'), 'eml-btn', () => { batch = false; selSet = new Set(); renderMode(); draw(); });
    }
  };
  const doBatchSplit = () => {
    const parts = [...selSet].sort((a, b) => a - b);
    if (!parts.length) { uiToast(ezT('Select the files to split first')); return; }
    const splits = parts.map((i) => ({ id: genId(), files: [files[i]] }));
    const remain = files.filter((x, i) => !selSet.has(i));
    const idx0 = card.items.indexOf(item);
    const insert = [];
    splits.forEach((s) => insert.push(s));
    if (remain.length) insert.push({ id: genId(), files: remain });
    card.items.splice(idx0, 1, ...insert);
    syncToConfig(node); render(node); ov.remove(); uiToast(ezT('Batch split ') + parts.length + ezT(' files'));
  };
  let _pvMedia = null, _pvType = '';
  const draw = () => {
    if (!files.length) { ov.remove(); return; }
    if (idx >= files.length) idx = files.length - 1;
    const showArrows = files.length > 1;   // 单文件没得翻：整个箭头都不显示，别挡控制条
    aL.style.display = showArrows ? 'flex' : 'none';
    aR.style.display = showArrows ? 'flex' : 'none';
    const d = files[idx]; if (!d) return;
    const t = d.type || 'other';
    const mk = () => {
      if (t === 'image') { const m = el('img'); m.src = d.url; m.style.cssText = 'max-width:100%;max-height:52vh;object-fit:contain;background:var(--ez-bg);'; return m; }
      if (t === 'video') { const m = el('video'); m.src = d.url; m.controls = true; m.style.cssText = 'max-width:100%;max-height:52vh;background:var(--ez-bg);'; return m; }
      if (t === 'audio') { const wrap = el('div'); wrap.style.cssText = 'width:100%;max-width:520px;background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:12px;padding:10px 12px;'; const m = makeAudioPlayer(d.url); m.style.cssText = 'width:100%;'; wrap.appendChild(m); return wrap; }
      if (t === 'model_3d') {
        const m = el('div'); m.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;';
        const ic = el('div'); ic.textContent = '🧊'; ic.style.cssText = 'font-size:54px;color:var(--ez-fg-muted);'; m.appendChild(ic);
        const b = el('button'); b.textContent = ezT('Open 3D viewer'); b.style.cssText = 'background:var(--ez-strong);border:1px solid var(--ez-strong);color:var(--ez-on-strong);border-radius:9px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;';
        b.addEventListener('click', (e) => { e.stopPropagation(); open3d(node, item, card, d); });
        m.appendChild(b); return m;
      }
      const m = el('div'); m.style.cssText = 'width:100%;min-height:120px;max-height:52vh;overflow:auto;background:var(--ez-bg);border-radius:8px;padding:12px 14px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--ez-fg);'; m.textContent = ezT('Loading…');
      fetch(mediaUrl(d)).then((r) => { if (!r.ok) throw new Error('bad'); return r.text(); }).then((txt) => { if (m.isConnected) m.textContent = (txt || ezT('(empty file)')).slice(0, 60000); }).catch(() => { if (m.isConnected) m.textContent = ezT('Cannot preview content'); });
      return m;
    };
    const same = _pvMedia && _pvMedia.parentNode && (_pvType === t) && (t === 'image' || t === 'video');
    if (!same) {
      Array.from(main.children).forEach((c) => { if (c !== aL && c !== aR) c.remove(); });
      _pvMedia = mk(); _pvType = t;
      main.insertBefore(_pvMedia, aL);
      main.style.paddingLeft = main.style.paddingRight = (t === 'audio' ? '44px' : '0');
    } else {
      _pvMedia.src = d.url; main.style.paddingLeft = main.style.paddingRight = '0';
    }
    tt.textContent = d.name || ezT('Preview');
    foot.textContent = [d.size ? (ezT('Size: ') + formatSize(d.size)) : '', ezT('Type: ') + typeShort(d.type)].filter(Boolean).join('   ');
    strip.innerHTML = '';
    files.forEach((x, i) => {
      const sel = batch && selSet.has(i);
      const th = el('div'); th.style.cssText = 'position:relative;width:56px;height:56px;border-radius:6px;overflow:hidden;cursor:pointer;border:2px solid ' + (sel ? 'var(--ez-ok)' : (i === idx ? 'var(--ez-strong)' : 'transparent')) + ';background:var(--ez-surface-3);display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--ez-fg-muted);flex-shrink:0;';
      if (x.type === 'image') { const im = el('img'); im.src = x.url; im.style.cssText = 'width:100%;height:100%;object-fit:cover;'; th.appendChild(im); } else th.textContent = ({ image: '🖼', video: '🎬', audio: '🎵', model_3d: '🧊' })[x.type] || '📄';
      const del = el('button'); del.textContent = '✕'; del.title = ezT('Delete from this card group'); del.style.cssText = 'position:absolute;top:0;right:0;width:16px;height:16px;line-height:16px;font-size:10px;background:var(--ez-strong);color:var(--ez-on-strong);border:none;border-radius:0 5px 0 9px;cursor:pointer;padding:0;';
      del.addEventListener('click', (e) => { e.stopPropagation(); files.splice(i, 1); if (!files.length) { card.items = card.items.filter((it) => it.id !== item.id); syncToConfig(node); render(node); ov.remove(); } else syncToConfig(node); draw(); });
      th.appendChild(del);
      th.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); buildMenu(e, x, i); });
      th.addEventListener('click', (e) => { if (batch) { if (selSet.has(i)) selSet.delete(i); else selSet.add(i); renderMode(); draw(); return; } idx = i; draw(); });
      strip.appendChild(th);
    });
  };
  strip.addEventListener('wheel', (e) => { if (e.target === strip || strip.contains(e.target)) { e.preventDefault(); strip.scrollLeft += (e.deltaY || e.deltaX); } });
  stripL.addEventListener('click', () => strip.scrollLeft -= 120);
  stripR.addEventListener('click', () => strip.scrollLeft += 120);
  box.addEventListener('contextmenu', (e) => { e.preventDefault(); buildMenu(e, files[idx], idx); });
  box.querySelector('.eml-pvx').addEventListener('click', () => { stopPv(); ov.remove(); });
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) { stopPv(); ov.remove(); } });
  const pvTok = ezPushModal({});
  const keyHandler = (e) => {
    if (!ov.isConnected) { ezPopModal(pvTok); document.removeEventListener('keydown', keyHandler, true); return; }
    if (!ezIsTopModal(pvTok)) return;   // 上面还有弹窗时不动
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'VIDEO' || ae.tagName === 'AUDIO')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); prev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); next(); }
  };
  document.addEventListener('keydown', keyHandler, true);   // 捕获阶段：先于画布的左右键处理，弹窗翻页时底下画布不动
  renderMode(); draw();
}

// ===== 3D 预览模态框（内联 three.js，复用 /preview_any/3d/libs/）=====
function ext3d(url) {
  try { const u = new URL(url, location.href); const p = u.searchParams.get('path') || u.searchParams.get('filename') || u.pathname; const m = String(p).toLowerCase().match(/\.(gltf|glb|obj|fbx)$/); return m ? m[1] : ''; } catch (_) { return ''; }
}
function open3d(node, item, card, file) {
  const f = file || (item.files || [])[0]; if (!f) return;
  const url = f.url || ('/media_loader/serve?path=' + encodeURIComponent(f.path || ''));
  const ov = el('div'); ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,14,20,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:9999;';
  const box = el('div'); box.style.cssText = 'background:var(--ez-bg);border-radius:14px;padding:12px;width:95%;max-width:1040px;height:86vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 30px 90px rgba(0,0,0,.4);overflow:hidden;';
  const hd = el('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;flex:0 0 auto;';
  const t = el('b'); t.style.cssText = 'font-size:14px;color:var(--ez-fg);'; t.textContent = f.name || ezT('3D model'); hd.appendChild(t);
  const close = el('button'); close.textContent = '✕'; close.title = ezT('Close'); close.style.cssText = 'background:var(--ez-surface-3);border:1px solid var(--ez-border);border-radius:10px;width:28px;height:28px;font-size:13px;cursor:pointer;color:var(--ez-fg-3);'; hd.appendChild(close);
  const bodyWrap = el('div'); bodyWrap.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;gap:10px;';
  const body = el('div'); body.style.cssText = 'flex:1 1 auto;position:relative;border-radius:12px;overflow:hidden;background:var(--ez-surface-2);border:1px solid var(--ez-border-2);';
  const canvas = el('canvas'); canvas.tabIndex = 0; canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;outline:none;touch-action:none;cursor:grab;';
  body.appendChild(canvas);
  const panel = el('div'); panel.style.cssText = 'width:170px;flex:0 0 170px;display:flex;flex-direction:column;gap:8px;background:var(--ez-surface-2);border:1px solid var(--ez-border-2);border-radius:12px;padding:10px;overflow:auto;font-size:12px;color:var(--ez-fg-2);';
  panel.innerHTML = '<div class="pvlbl" style="font-size:11px;font-weight:600;color:var(--ez-fg-3);">' + ezT('Display') + '</div>' +
    '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" class="pvwf"> ' + ezT('Wireframe') + '</label>' +
    '<div class="pvlbl" style="font-size:11px;font-weight:600;color:var(--ez-fg-3);">' + ezT('Material') + '</div><select class="pvmat" style="width:100%;font-size:12px;padding:5px 8px;border:1px solid var(--ez-border);border-radius:8px;background:var(--ez-bg);cursor:pointer;">' +
    '<option value="original">' + ezT('Original') + '</option><option value="clay">' + ezT('Clay') + '</option><option value="glass">' + ezT('Glass') + '</option><option value="plastic">' + ezT('Plastic') + '</option><option value="metal">' + ezT('Metal') + '</option><option value="wire">' + ezT('Wireframe') + '</option></select>' +
    '<div class="pvlbl" style="font-size:11px;font-weight:600;color:var(--ez-fg-3);">' + ezT('Background color') + '</div><input type="color" class="pvbg" value="#f7f9fd" style="width:100%;height:26px;border:1px solid var(--ez-border);border-radius:8px;padding:2px;background:var(--ez-bg);cursor:pointer;">' +
    '<button class="pvreset" style="background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:8px;padding:6px;font-size:12px;cursor:pointer;color:var(--ez-fg-2);">' + ezT('Reset view') + '</button>' +
    '<button class="pvshot" style="background:var(--ez-strong);border:1px solid var(--ez-strong);color:var(--ez-on-strong);border-radius:8px;padding:6px;font-size:12px;cursor:pointer;">' + ezT('Generate preview image') + '</button>' +
    '<button class="pvfs" style="background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:8px;padding:6px;font-size:12px;cursor:pointer;color:var(--ez-fg-2);">' + ezT('Fullscreen') + '</button>';
  bodyWrap.appendChild(body); bodyWrap.appendChild(panel);
  const status = el('div'); status.style.cssText = 'font-size:12px;color:var(--ez-fg-3);text-align:center;min-height:16px;'; status.textContent = ezT('Loading 3D model…');
  const tip = el('div'); tip.style.cssText = 'font-size:11px;color:var(--ez-fg-muted);'; tip.textContent = ezT('Left drag = orbit · wheel = zoom · Shift/right drag = pan');
  box.appendChild(hd); box.appendChild(bodyWrap); box.appendChild(status); box.appendChild(tip);
  ov.appendChild(box); document.body.appendChild(ov);
  let cleanup = () => { try { ov.remove(); } catch (_) {} };   // 加载失败也要能关掉
  close.addEventListener('click', () => cleanup());
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) cleanup(); });
  const wfCb = panel.querySelector('.pvwf'), bgIn = panel.querySelector('.pvbg'), resetBtn = panel.querySelector('.pvreset'), shotBtn = panel.querySelector('.pvshot'), fsBtn = panel.querySelector('.pvfs'), matSel = panel.querySelector('.pvmat');
  let fsOn = false;
  fsBtn.addEventListener('click', () => { fsOn = !fsOn; document.fullscreenElement ? document.exitFullscreen().catch(()=>{}) : (box.requestFullscreen && box.requestFullscreen().catch(()=>{})); });
  (async () => {
    try {
      const THREE_BASE = '/preview_any/3d/libs/';
      const THREE = await import(THREE_BASE + 'three.module.js');
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0xf7f9fd);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000); camera.position.set(3, 2.4, 4);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      let repaint = () => {};   // 模型就绪后由加载回调填上；ResizeObserver setSize 会清空画布，必须跟着重画
      const fit = () => { try { const w = canvas.clientWidth || 800, h = canvas.clientHeight || 600; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); } catch (_) {} };
      fit();
      const ro = new ResizeObserver(() => { fit(); repaint(); });
      ro.observe(canvas);
      scene.add(new THREE.AmbientLight(0xffffff, 0.9));
      const dir = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(5, 10, 7); scene.add(dir);
      const ext = ext3d(url);
      let loader;
      if (ext === 'glb' || ext === 'gltf') { const gltf = await import(THREE_BASE + 'GLTFLoader.js'); loader = new gltf.GLTFLoader(); }
      else if (ext === 'fbx') { const fbx = await import(THREE_BASE + 'FBXLoader.js'); loader = new fbx.FBXLoader(); }
      else if (ext === 'obj') { const objs = await import(THREE_BASE + 'OBJLoader.js'); loader = new objs.OBJLoader(); }
      else if (ext === 'splat') { const sp = await import(THREE_BASE + 'SplatLoader.js'); loader = new sp.SplatLoader(THREE); }   // 本地极简高斯泼溅加载器
      // 只随包带了 GLTF / FBX / OBJ / Splat 四个加载器：别的扩展名以前会落到 OBJLoader 里报一堆难懂的错误
      else { throw new Error(ezT('Unsupported 3D format .') + (ext || '?') + ezT(' (only glb / gltf / obj / fbx / splat are supported)')); }
      loader.load(url, (obj) => {
        status.textContent = '';
        const wrap = new THREE.Group(); wrap.add(obj);
        const b3 = new THREE.Box3().setFromObject(wrap); const size = b3.getSize(new THREE.Vector3()); const center = b3.getCenter(new THREE.Vector3());
        const maxD = Math.max(size.x, size.y, size.z) || 1;
        obj.position.sub(center); scene.add(wrap);
        const grid = new THREE.GridHelper(maxD * 2, 10, 0x9aa7b5, 0xd6dce6); grid.position.y = -maxD * 0.5; scene.add(grid);
        // 简易轨道：左键环绕 / 滚轮缩放 / Shift+右键平移
        let theta = 0.6, phi = 1.0, radius = maxD * 3 || 4; const target = new THREE.Vector3(0, maxD * 0.2, 0);
        let drag = null;
        const render = () => { try { renderer.render(scene, camera); } catch (_) {} };
        const apply = () => { camera.position.set(target.x + radius * Math.sin(phi) * Math.sin(theta), target.y + radius * Math.cos(phi), target.z + radius * Math.sin(phi) * Math.cos(theta)); camera.lookAt(target); render(); };
        canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); drag = { x: e.clientX, y: e.clientY, btn: e.button }; canvas.setPointerCapture(e.pointerId); });
        canvas.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; if (drag.btn === 2 || e.shiftKey) { const sx = (dx / 600) * radius, sy = (dy / 600) * radius, right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), theta), up = new THREE.Vector3(Math.cos(phi) * Math.sin(theta), -Math.sin(phi), Math.cos(phi) * Math.cos(theta)); target.add(right.multiplyScalar(-sx)); target.add(up.multiplyScalar(sy)); } else { theta -= dx * 0.01; phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi - dy * 0.01)); } apply(); });
        canvas.addEventListener('wheel', (e) => { e.preventDefault(); radius = Math.max(0.2, radius * (1 + (e.deltaY > 0 ? 0.09 : -0.09))); apply(); }, { passive: false });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        const up = () => { drag = null; };
        canvas.addEventListener('pointerup', up); canvas.addEventListener('pointerleave', up); canvas.addEventListener('pointercancel', up);
        let raf = 0;
        repaint = () => { try { apply(); } catch (_) {} };
        if (EZ_PERF.render3d === 'loop') { const loop = () => { render(); raf = requestAnimationFrame(loop); }; loop(); } else { apply(); }
        // 首次出画：弹窗尺寸这一两帧才定型，ResizeObserver 的 setSize 又会把画面清掉 —— 补两次，免得「一片空白，动一下鼠标才显示」
        requestAnimationFrame(() => { fit(); repaint(); });
        setTimeout(() => { fit(); repaint(); }, 120);
        // 缩略图不需要原分辨率：先缩到 480px 宽的离屏 canvas 再编码。整幅 PNG 编码（toDataURL）是同步 GPU 回读 + PNG 压缩，
        // 上千像素时能卡主线程几百毫秒，存下来还是张几百 KB 的 dataURL（卡片每次都重新解码，越用越慢）。
        const doShot = (silent) => {
          try {
            apply(); renderer.render(scene, camera);
            const src = renderer.domElement;
            const W = 480, H = Math.max(1, Math.round(W * (src.height || 1) / (src.width || 1)));
            const shot = document.createElement('canvas'); shot.width = W; shot.height = H;
            shot.getContext('2d').drawImage(src, 0, 0, W, H);
            _mlPreview[item.id] = shot.toDataURL('image/jpeg', 0.85);
            if (!setCardThumb(node, item.id, _mlPreview[item.id]) && node) render(node);
            if (!silent) uiToast(ezT('Generated 3D preview image'));
          } catch (_) { if (!silent) uiToast(ezT('Failed to generate preview')); }
        };
        if (!_mlPreview[item.id]) { const autoShot = () => { theta = 0; phi = 1.0; radius = maxD * 3 || 4; target.set(0, maxD * 0.2, 0); apply(); doShot(true); }; setTimeout(autoShot, 320); }
        wfCb.addEventListener('change', () => { wrap.traverse((o) => { if (o.isMesh && o.material) o.material.wireframe = wfCb.checked; }); render(); });
        matSel.addEventListener('change', () => {
          const mode = matSel.value;
          wrap.traverse((o) => {
            if (!o.isMesh || !o.material) return;
            if (mode === 'clay') o.material = new THREE.MeshStandardMaterial({ color: 0xd8c7b0, roughness: 0.9, metalness: 0 });
            else if (mode === 'glass') o.material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, roughness: 0.1, metalness: 0 });
            else if (mode === 'metal') o.material = new THREE.MeshStandardMaterial({ color: 0x9aa7b5, metalness: 0.9, roughness: 0.2 });
            else if (mode === 'plastic') o.material = new THREE.MeshStandardMaterial({ color: 0x4d5b6d, roughness: 0.4, metalness: 0 });
            else if (mode === 'wire') { o.material.wireframe = true; }
            else { o.material.wireframe = false; }
          });
          render();
        });
        bgIn.addEventListener('input', () => { scene.background = new THREE.Color(bgIn.value || '#f7f9fd'); render(); });
        resetBtn.addEventListener('click', () => { theta = 0.6; phi = 1.0; radius = maxD * 3 || 4; target.set(0, maxD * 0.2, 0); apply(); });
        shotBtn.addEventListener('click', () => doShot());
        cleanup = () => { cancelAnimationFrame(raf); try { ro.disconnect(); } catch (_) {} try { renderer.dispose(); } catch (_) {} ov.remove(); };
      }, (xhr) => { try { if (xhr && xhr.total) status.textContent = ezT('Loading 3D model…') + ' ' + Math.round((xhr.loaded / xhr.total) * 100) + '%'; } catch (_) {} },
      (err) => { status.textContent = ezT('Load error: ') + (err && err.message || err); });
    } catch (e) { status.textContent = ezT('3D viewer failed to initialize: ') + (e && e.message || e); }
  })();
}

// ===== 动态输出端口：按输出模式分组，每个口的值是一份 list =====
const ML_RANK = { card: 0, row: 1, group: 2 };
function mlMode(node) { const m = stateFor(node).mode; return ML_RANK.hasOwnProperty(m) ? m : 'card'; }
function mlScope(node) { const st = stateFor(node); let s = ML_RANK.hasOwnProperty(st.mergeScope) ? st.mergeScope : 'card'; if (ML_RANK[s] > ML_RANK[mlMode(node)]) s = mlMode(node); return s; }
function mlFileKind(f) { const k = (f && (f.type || mediaKind(f.name || f.path))) || 'other'; return String(k).toLowerCase(); }
function mlPorts(node) {
  const st = stateFor(node); const mode = mlMode(node); const order = []; const map = {};
  const add = (k, g, c, it) => { if (!(k in map)) { map[k] = { g, c, it, files: [] }; order.push(k); } return map[k]; };
  if (mode === 'group') {
    st.groups.forEach((g) => {   // 空分组也留口（输出空 list）
      const b = add('g:' + g.id, g, null, null);
      (g.cards || []).forEach((c) => (c.items || []).forEach((it) => (it.files || []).forEach((f) => b.files.push({ f, g, c, it }))));
    });
  } else if (mode === 'row') {
    st.groups.forEach((g) => (g.cards || []).forEach((c) => {   // 空卡片组也留口
      const b = add('c:' + c.id, g, c, null);
      (c.items || []).forEach((it) => (it.files || []).forEach((f) => b.files.push({ f, g, c, it })));
    }));
  } else {
    st.groups.forEach((g) => (g.cards || []).forEach((c) => {
      const items = (c.items || []);
      if (!items.length) { add('i:' + c.id + ':', g, c, null); return; }   // 空卡片组：占位口
      items.forEach((it, k) => { const b = add('i:' + c.id + ':' + it.id, g, c, it); b.no = k + 1; (it.files || []).forEach((f) => b.files.push({ f, g, c, it })); });
    }));
  }
  return order.map((k) => {
    const b = map[k];
    let name = (b.g.name || '') + '_' + (b.c ? (b.c.name || 'Card') : '');
    if (mode === 'group') name = b.g.name || 'Group';           // 按分组 = 分组名
    else if (mode === 'row') name = (b.g.name || '') + '_' + (b.c.name || 'Card');
    else if (b.it && (b.it.files || []).length) name = (b.g.name || '') + '_' + (b.c.name || 'Card') + '_' + ezT('Card') + (b.no || 1);   // 按卡片 = 分组_卡片组_卡片n
    else if (b.it === null) name = ezT('Empty card');
    return { id: k, name, files: b.files };
  });
}
// 一个口里的项（前端镜像后端 _ml_ports）：拼接关=逐文件；拼接开=按拼接对象再分组、同类型且该类型开着就合成 1 项
// 循环模式的 Segment 口也要带素材元数据（path/url）：MediaOut 端口、编号引擎、PromptHelper 引用媒体都靠它出缩略图
// 必须和槽位同序（图片槽先、再视频、再音频…）：MediaOut 是按位接的，给"素材原顺序"会让 Image 1 装到视频。
// 取第一张卡片组当作"第 1 轮"的元数据（缩略图/编号表用它；运行期每轮的值由 Python 按 index 真出）。
function mlSegmentFiles(node) {
  const g = currentGroup(node);
  const card = ((g && g.cards) || [])[0];
  if (!card) return [];
  return fixedCells(node, card).map((c) => { const it = c.item; const f = it && (it.files || [])[0]; return f ? { f, c: card, it, g } : null; });
}
function mlPortItems(node, port) {
  const st = stateFor(node); const items = [];
  // 固定/循环模式：按槽位顺序逐位给，空格位保留 null 占位（MediaOut 要按位对上槽位；后端 _ml_fixed_items 也是这个形状）。
  // null 不能顺手丢掉：一丢位置就错位，MediaOut 的 Image 1 会装到视频。固定模式无视拼接（后端同样优先槽位）。
  if (st.fixed.on || !st.merge) { port.files.forEach((x) => items.push(x ? { id: x.f.id, name: x.f.name, type: mlFileKind(x.f), url: mediaUrl(x.f), path: x.f.path } : null)); return items; }   // path 必须带上：编号表（引用识别）读 MediaOut 端口时按 path 判定素材
  const scope = mlScope(node); const mt = st.mergeTypes || {};
  const order = []; const map = {};
  port.files.forEach((x) => { const k = scope === 'card' ? ('i:' + x.c.id + ':' + x.it.id) : (scope === 'row' ? ('c:' + x.c.id) : '__all__'); if (!(k in map)) { map[k] = []; order.push(k); } map[k].push(x); });
  order.forEach((k) => {
    const grp = map[k];
    const kinds = new Set(grp.map((x) => mlFileKind(x.f)));
    if (kinds.size > 1) { items.push({ id: k, name: ezT('Mixed'), type: '*', mixed: true }); return; }
    const kind = kinds.size ? Array.from(kinds)[0] : 'other';
    const on = kind === 'image' ? mt.image !== false : (kind === 'audio' ? mt.audio !== false : mt.other !== false);
    if (grp.length > 1 && on) items.push({ id: 'm_' + grp[0].f.id, name: (grp[0].f.name || 'Media') + ' ×' + grp.length, type: kind, n: grp.length, url: mediaUrl(grp[0].f), path: grp[0].f.path });   // 合并项也要带 url + path：下游（TimeLine/MediaOut/编号表）要拿它出缩略图和预览
    else grp.forEach((x) => items.push({ id: x.f.id, name: x.f.name, type: mlFileKind(x.f), url: mediaUrl(x.f), path: x.f.path }));
  });
  return items;
}
// 加载期守卫：onConfigure 触发时下游槽位还没恢复，此时 addOutput/removeOutput 会让
// LiteGraph 去重设未恢复的 slot.link → "Cannot set properties of undefined (setting 'link')"，
// 整份工作流加载被中止。链路（端口上的 link id 不在 graph.links 里）没齐时先跳过，
// 并延后重试一次，等图恢复完再把端口补正。与 syncOutputTypes 的 stale 判定保持同一口径，
// 也与 prompt_helper.js 的 deferSync 写法一致。
function mlDeferSync(node) {
  if (!node || node._emlSyncTimer) return;
  node._emlSyncTimer = setTimeout(() => {
    node._emlSyncTimer = null;
    try { updatePorts(node); syncOutputTypes(node); render(node); } catch (e) { console.error('[MediaLoader] port sync failed (panel may not render):', e); }
  }, 120);
}
// 拆掉本节点上「去路已不存在」的坏线（实现见 ezflex_service.js）。
// 工作流里可能残留 target_slot 越界的 link，这种线在 removeOutput → disconnectOutput 里
// 会去取 target.inputs[越界] → undefined → "Cannot set properties of undefined (setting 'link')"，
// 直接把整份工作流加载中止。
function mlPruneDanglingLinks(node) { return ezPruneDanglingLinks(node); }
function updatePorts(node, noRedraw) {
  if (!node || !node.outputs) return false;
  if (!portLinksReady(node)) { mlDeferSync(node); return false; }
  mlPruneDanglingLinks(node);   // 先拆掉坏线，避免 removeOutput → disconnectOutput 踩到越界槽
  // 固定/循环模式优先级高于输出模式：只出一个口（当前段），端口数量与输出模式无关
  const want = stateFor(node).fixed.on ? [{ id: 'segment', name: 'Segment', files: mlSegmentFiles(node) }] : mlPorts(node);
  let changed = false;
  const old = (node.outputs || []).slice();
  const used = new Set(); const seq = [];
  want.forEach((w) => {
    let sock = null;
    // 1) 结构 id 复用（换模式/重排时连线跟着条目走）
    for (let i = 0; i < old.length; i++) { if (!used.has(i) && old[i]._ezPortId != null && String(old[i]._ezPortId) === String(w.id)) { sock = old[i]; used.add(i); break; } }
    // 2) 名称没变 → 复用（结构 id 变了也能接上）
    if (!sock) { for (let i = 0; i < old.length; i++) { if (!used.has(i) && old[i].name === w.name) { sock = old[i]; used.add(i); break; } } }
    // 3) 位置复用，保留连线（类型恒 '*'，不会类型冲突）
    if (!sock) { for (let i = 0; i < old.length; i++) { if (!used.has(i)) { sock = old[i]; used.add(i); break; } } }
    if (!sock) { node.addOutput(w.name, '*', {}); sock = node.outputs[node.outputs.length - 1]; changed = true; }
    if (sock._ezPortId !== w.id) { sock._ezPortId = w.id; changed = true; }
    if (sock.name !== w.name) { sock.name = w.name; changed = true; }
    if (String(sock.type) !== '*') { try { sock.type = '*'; } catch (_) {} changed = true; }
    try { hideNativeSlotText(sock); sock.hidden = false; sock._ezLabel = w.name + ((w.files && w.files.length > 1) ? (' ×' + w.files.length) : ''); sock.color_on = CARD_COLOR; sock.color_off = CARD_COLOR; sock.color = CARD_COLOR; } catch (_) {}
    try {
      const its = mlPortItems(node, w);
      const sig = JSON.stringify(its);
      if (sock._ezItemsSig !== sig) { sock._ezItemsSig = sig; changed = true; }   // 端口没变但内容变了（跨分组移动）也要通知下游
      sock._ezItems = its;
    } catch (_) { sock._ezItems = []; }
    seq.push(sock);
  });
  old.forEach((o, i) => { if (!used.has(i)) { const idx = node.outputs.indexOf(o); if (idx >= 0) { node.removeOutput(idx); changed = true; } } });
  if (node.outputs.length !== seq.length || node.outputs.some((o, i) => o !== seq[i])) { for (let i = 0; i < seq.length; i++) node.outputs[i] = seq[i]; node.outputs.length = seq.length; changed = true; }
  node.outputs.forEach((o, i) => {
    const ids = []; if (Array.isArray(o.links)) ids.push(...o.links); if (o.link != null) ids.push(o.link);
    ids.forEach((lid) => { if (lid != null && node.graph && node.graph.links && node.graph.links[lid]) { try { node.graph.links[lid].origin_slot = i; } catch (_) {} } });
  });
  if (changed && node.graph) node.graph.setDirtyCanvas(true, true);
  if (changed) syncOutputTypes(node);
  if (changed) notifyDownstream(node);   // 所连 MediaOut 的口要跟着内容变
  return changed;
}
function notifyDownstream(node) {
  const graph = node.graph; if (!graph || !graph.links) return;
  const byId = (id) => (graph.getNodeById ? graph.getNodeById(id) : null) || ((graph._nodes || []).find((n) => n && String(n.id) === String(id)));
  (node.outputs || []).forEach((o) => {
    const ids = []; if (Array.isArray(o.links)) ids.push(...o.links); if (o.link != null) ids.push(o.link);
    ids.forEach((lid) => {
      const lk = graph.links[lid]; if (!lk) return;
      const t = byId(lk.target_id);
      if (!t) return;
      if (typeof t._ezMediaOutUpdate === 'function') { try { t._ezMediaOutUpdate(); } catch (_) {} }
      else if (typeof t._ezlpUpdate === 'function') { try { t._ezlpUpdate(); } catch (_) {} }   // MergeList/SplitList/TimeLine 也要跟着重算
    });
  });
}
// 链路是否已恢复：输出口上挂的 link id 必须都能在 graph.links 里找到，且 graph 已挂上。
// 工作流加载中途（onConfigure 早于图恢复完成）会为 false，此时不能增删端口。
function portLinksReady(node) {
  if (!node || !node.graph || !node.graph.links) return false;
  const outs = node.outputs || [];
  for (let i = 0; i < outs.length; i++) {
    const o = outs[i]; if (!o) continue;
    const ids = Array.isArray(o.links) ? o.links : [];
    for (let k = 0; k < ids.length; k++) { const lid = ids[k]; if (lid != null && !node.graph.links[lid]) return false; }
  }
  const ins = node.inputs || [];
  for (let i = 0; i < ins.length; i++) {
    const s = ins[i]; if (!s) continue;
    if (s.link != null && !node.graph.links[s.link]) return false;
  }
  return true;
}
function syncOutputTypes(node) {
  // 链路没恢复（端口上的 link id 还不在 graph.links 里）时别上报：空 labels 会把类口数清空，保存的连线就断了。
  if (!portLinksReady(node)) return;
  const labels = mlPorts(node).map((x) => x.name);
  try { const f = (api && typeof api.fetchApi === 'function') ? (p, o) => api.fetchApi(p, o) : (p, o) => fetch(p, o); f(OUTPUT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labels }) }).catch(() => {}); } catch (_) {}
}

// 供 PromptHelper graphMediaFiles 读取本节点素材文件

// ===== 黑框标签（输出 socket 深红圆点 + 半透明黑框）=====
function forceShell(node) {
  const p = node && node._emlRoot; if (!p || !p.isConnected) return;
  const si = (t, prop, val) => { try { t.style.setProperty(prop, val, 'important'); } catch (_) {} };
  si(p, 'width', '100%'); si(p, 'max-width', '100%'); si(p, 'height', '100%'); si(p, 'max-height', '100%'); si(p, 'box-sizing', 'border-box');
  if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) { si(p, 'top', 'var(--ezfx-vue-title,30px)'); si(p, 'height', 'calc(100% - var(--ezfx-vue-title,30px))'); si(p, 'bottom', 'auto'); }
}
function installOutsideLabels(node) {
  if (!node || node._emlOutLabels) return;
  node._emlOutLabels = true;
  let all = []; let sig = '';
  const mk = (text) => { const l = el('div', 'eml-socket-label'); l.textContent = text || ''; l.style.display = 'none'; document.body.appendChild(l); return l; };
  const scan = () => {
    const cur = (node.outputs || []).map((s, i) => ({ i, name: s._ezLabel || s.name || '', type: s.type })).filter((x) => x.name);   // 名字还没铺上的空口不画空黑框
    const s = cur.map((x) => x.i + '|' + x.name).join(';');
    if (s !== sig) { sig = s; all.forEach((x) => { try { x.el.remove(); } catch (_) {} }); all = cur.map((x) => ({ el: mk(x.name), i: x.i })); node._emlOutEls = all.map((x) => x.el); }
  };
  const hideAll = () => { all.forEach((item) => { try { item.el.style.display = 'none'; } catch (_) {} }); };
  const update = () => {
    if (!mlLabelsOn()) { hideAll(); return; }
    const rootEl = node._emlRoot;
    if (!rootEl || !rootEl.isConnected) { hideAll(); return; }   // 控件没挂上/被临时摘掉：先把标签收掉，别留在屏幕上
    // 只在「当前渲染的那张图」里显示：子图（app.canvas.graph）也算当前图，别拿 app.graph 比
    const shown = (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
    if (shown && node.graph && node.graph !== shown) { hideAll(); return; }
    let rect = null; try { rect = rootEl.getBoundingClientRect(); } catch (_) { hideAll(); return; }
    if (!rect || rect.width <= 0) { hideAll(); return; }
    const nodeW0 = (node.size && node.size[0]) || 1; const sx0 = rect.width / nodeW0;
    if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight || sx0 < 0.35) { all.forEach((item) => { item.el.style.display = 'none'; }); return; }
    scan();
    const sy = sx0;   // 纵向也按画布缩放（=节点宽度比）：别用 rect.height/nodeH，节点拉高后 rect 高不跟着长会把黑框间距压扁
    all.forEach((item) => {
      let pos = null; try { pos = node.getOutputPos(item.i); } catch (_) { pos = null; }
      if (!pos || !pos.length) { item.el.style.display = 'none'; return; }
      const nodeW = (node.size && node.size[0]) || 1; const sx = rect.width / nodeW; const np = node.pos || [0, 0];
      const cx = rect.left + ((pos[0] || 0) - (np[0] || 0)) * sx; const cy = rect.top + ((pos[1] || 0) - (np[1] || 0)) * sy;
      item.el.style.display = 'inline-flex'; item.el.style.zIndex = '20';
      const zoom = Math.max(0.5, sx); item.el.style.fontSize = Math.max(8, 9 * zoom) + 'px'; item.el.style.padding = (3 * zoom) + 'px ' + (7 * zoom) + 'px';
      const tw = item.el.offsetWidth; const th = item.el.offsetHeight || 16; const offX = 10 * zoom;
      item.el.style.left = (cx + offX) + 'px'; item.el.style.top = (cy - th / 2) + 'px';
    });
  };
  // 不再每帧自递归：画布重绘（onDrawForeground）+ resize/滚动 触发，一帧最多一次；静止时零开销
  const schedule = () => pumpFrames();
  {
    const prevDraw = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
        if (prevDraw) prevDraw.call(this, ctx);
        // 与画布同帧同步更新（不再经过 rAF，避免比画布慢一拍出现「流体感」）；
        // 不再额外 pumpFrames() —— setDirty/指针/滚轮/resize 已经在 pump，否则同一帧 update 跑两遍
        update();
      };
    scheduleOnRedraw(update);
    onLocaleChange(() => { try { render(node); } catch (_) {} });   // 语言切换即时重画
    schedule();
  }
}
// index 输入口和 TimeLine 保持一致：同款深红 + 圆点 + 黑框 "index" 标签
function styleIndexInput(node) {
  const s = (node.inputs || []).find((x) => x && x.name === 'index');
  if (!s) return;
  try { s.color = s.color_on = s.color_off = '#d94848'; if (s.shape != null) s.shape = null; } catch (_) {}
}
function installIndexLabel(node) {
  installEdgeLabels(node, { side: 'in', rootOf: (n) => n._emlRoot, labelOf: (s) => ((s && s.name === 'index') ? 'index' : '') });
}
function hideConfigWidget(node) {
  try { const ins = node.inputs || []; for (let i = ins.length - 1; i >= 0; i--) { if (ins[i] && ins[i].name === 'config') { try { node.inputs.splice(i, 1); } catch (_) { try { ins[i].hidden = true; } catch (_) {} } } } } catch (_) {}
  const w = configWidgetOf(node); if (!w || node._emlCfgHid) return;
  node._emlCfgHid = true;
  try { w.origComputeSize = w.computeSize; w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0; w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true; w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0; if (w.element && w.element.style) { w.element.style.display = 'none'; w.element.style.height = '0'; w.element.style.minHeight = '0'; w.element.style.maxHeight = '0'; } } catch (_) {}
}

// ===== 搭建 =====
function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'eml-shell');
  const root = el('div', 'eml-root');
  shell.appendChild(root);
  root.innerHTML = '<div class="eml-top"></div><div class="eml-tabs"></div><div class="eml-cards"></div><div class="eml-addbar">' + ezT('▼ Add card group') + '</div>';
  root.querySelector('.eml-addbar').addEventListener('click', () => addCard(node));
  return shell;
}
function addCard(node) {
  const g = currentGroup(node); if (!g) return;
  g.cards.push({ id: genId(), name: ezT('Card group ') + (g.cards.length + 1), items: [] });
  syncToConfig(node); updatePorts(node, true); render(node);
}
function addMediaOut(node) {
  try {
    let n = null;
    try { const L = (typeof window !== 'undefined' && window.LiteGraph) || (typeof LiteGraph !== 'undefined' ? LiteGraph : null); if (L && L.createNode) n = L.createNode('EzFlex-MediaOut'); } catch (_) { n = null; }
    if (!n) { uiToast(ezT('EzFlex-MediaOut node type not found')); return; }
    if (!n.pos) n.pos = [0, 0];
    const np = (node && node.pos) || [0, 0]; const nw = (node && node.size && node.size[0]) || 300;
    n.pos = [np[0] + nw + 60, np[1]];
    if (app && app.graph) app.graph.add(n);
    try { const o0 = node && node.outputs && node.outputs[0]; if (n.inputs && n.inputs[0] && o0 && node.connect) node.connect(0, n, 0); } catch (_) {}
    uiToast(ezT('Loaded EzFlex-MediaOut'));
  } catch (_) { uiToast(ezT('Failed to load output')); }
}
function fitNode(node) {
  try { const root = node && node._emlRoot && node._emlRoot.querySelector('.eml-root'); if (!root || typeof node.setSize !== 'function') return; const cur = node.size || [MIN_WIDTH, 170]; const contentH = root.scrollHeight + 12; if (contentH > cur[1] + 4) node.setSize([Math.max(MIN_WIDTH, cur[0]), Math.min(900, contentH)]); } catch (_) {}
}
function setupNode(node) {
  if (!node || node._emlSetup) return;
  try {
    if (typeof node.addDOMWidget !== 'function') { console.warn('[MediaLoader] addDOMWidget is not supported by this frontend'); return; }
    node._emlSetup = true;
    loadFromConfig(node);
    const root = buildRoot(node);
    node._emlRoot = root;
    makeDomWidgetHitThrough(root);
    // 别给 DOM widget getValue/setValue：它被 unshift 到 widgets[0]，再带一个固定 '{}' 的取值回调，
    // 序列化时会把 widgets_values[0] 写成 '{}'，刷新后 config 就变回空了（素材全丢）。
    const widget = node.addDOMWidget(ezT('Media Loader'), nextWidgetType(), root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 170 });
    makeDomWidgetHitThrough(widget.element || root);
    try { node.widgets_start_y = 0; } catch (_) {}
    // 别把面板 widget 插到 widgets[0]：widgets_values 是按下标对应的，错位会让 config 读到面板的值（刷新后素材全空）
    installResizeHandles(node, root);
    try { node.setSize([MIN_WIDTH + 40, 390]); } catch (_) {}
    hideConfigWidget(node);
    render(node);
    updatePorts(node, true); syncOutputTypes(node);
    installOutsideLabels(node);
    styleIndexInput(node);
    installIndexLabel(node);
    forceShell(node);
    let settleN = 0;   // setInterval 返回的是数字 id，不能往上面挂属性（严格模式会抛 TypeError）
    const settle = setInterval(() => { forceShell(node); styleIndexInput(node); const a = updatePorts(node, true); installOutsideLabels(node); if (!a) { settleN += 1; if (settleN >= 4) clearInterval(settle); } }, 250);
    node._ezSettleIv = settle;   // 节点被删时 onRemoved 要能停掉它
    let retry = 0; (function again() { forceShell(node); installOutsideLabels(node); if (retry < 12) { retry += 1; setTimeout(again, 120); } })();
    setTimeout(() => { try { loadFromConfig(node); render(node); updatePorts(node, true); fitNode(node); } catch (_) {} }, 400);
  } catch (e) { console.error('[MediaLoader] init failed', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__emlHooked) return; nt.__emlHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = prevCfg ? prevCfg.apply(this, arguments) : undefined; loadFromConfig(this); updatePorts(this, true); render(this); return r; };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; try { (this._emlOutEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); this._emlOutEls = []; } catch (_) {} try { clearInterval(this._ezSettleIv); } catch (_) {} try { clearTimeout(this._emlSyncTimer); this._emlSyncTimer = null; } catch (_) {} try { if (this._emlRoot) this._emlRoot.remove(); } catch (_) {} this._emlSetup = false; return r; };
}
app.registerExtension({
  name: 'EzFlex.MediaLoader',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() {
    try { if (typeof LGraphCanvas !== 'undefined' && LGraphCanvas.link_type_colors) { LGraphCanvas.link_type_colors[CARD_TYPE] = CARD_COLOR; } } catch (_) {}
    ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); });
  },
});
