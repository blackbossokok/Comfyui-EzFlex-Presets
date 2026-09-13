// EzFlex-MediaLoader 素材加载器（内嵌 addDOMWidget 面板）。
// 数据模型（config widget JSON）：{ groups:[{id,name,cards:[{id,name,items:[{id,files:[{id,name,path,subfolder,dir,type}]}]}]}],
//   currentGroupId, currentPreset }。
// 面板结构仿 ModelsCombo/PreviewAny：透明外壳 .eml-shell 撑满节点，内层 .eml-root 带 margin 内缩露 socket。
// 每张「素材卡片」对应一个深红 * 输出端口，标签 = 分组名_卡片名，带半透明黑框标签叠加层。
// 文件来源：服务器 input 目录（/media_loader/files），非浏览器本地文件（无法拿到服务器路径）。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { NODE_TYPES, nodeTypeOf, configWidget, installResizeHandles, makeDomWidgetHitThrough, uiPrompt, uiConfirm, makeAudioPlayer, notifyConfigChanged, scheduleOnRedraw, pumpFrames, EZ_PERF } from "./ezflex_service.js";
import { ezT, onLocaleChange } from "./ezflex_i18n.js";

const NODE = NODE_TYPES.MEDIA_LOADER;
const PRESET_API = "/media_loader/presets";
const OUTPUT_API = "/media_loader/outputs";
// 卡片口专属类型：与 Python 侧 _MEDIA_CARD 一致（传的是卡片对象，只能接 EzFlex-MediaOut）
const CARD_TYPE = 'EZFLEX_MEDIA_CARD';
const CARD_COLOR = '#d94848';   // 深红（原来靠 '*' 的默认色，现在自定义类型自己上色）
const MIN_WIDTH = 640;

const CSS = `
.eml-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.eml-shell .eml-root{pointer-events:auto;}
.eml-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f2b;background:#fff;border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.eml-root *{box-sizing:border-box;user-select:none;-webkit-user-select:none;}
.eml-top{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;min-width:0;flex-shrink:0;} /* 顶部工具栏单行不换行（到「加载输出」为止） */
.eml-preset{appearance:none;-webkit-appearance:none;min-width:140px;height:32px;padding:4px 32px 4px 14px;border:1px solid #dce3ec;border-radius:999px;background:#f7f9fd url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7a8e' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 14px center;font-size:12px;color:#1a1f2b;cursor:pointer;flex:0 0 auto;outline:none;box-shadow:none;}
.eml-preset:focus,.eml-preset:active,.eml-preset:hover{border-color:#2b3a4a;outline:none;box-shadow:none;background-color:#fff;}
.eml-preset-btn{appearance:none;-webkit-appearance:none;min-width:150px;height:32px;padding:4px 32px 4px 14px;border:1px solid #dce3ec;border-radius:999px;background:#f7f9fd url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7a8e' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 14px center;font-size:12px;color:#1a1f2b;cursor:pointer;outline:none;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:inherit;}
.eml-preset-btn:focus,.eml-preset-btn:hover{border-color:#2b3a4a;background-color:#fff;}
.eml-preset-menu{display:none;position:absolute;top:36px;left:0;z-index:1200;min-width:160px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:4px;max-height:260px;overflow:auto;}
.eml-preset-menu.open{display:block;}
.eml-preset-item{padding:6px 12px;font-size:12px;color:#1a1f2b;border-radius:8px;cursor:pointer;white-space:nowrap;font-family:inherit;}
.eml-preset-item:hover{background:#f3f5f9;}
.eml-preset-item.active{background:rgba(43,58,74,.08);font-weight:600;color:#2b3a4a;}
.eml-btn{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:#1f2937;font-family:inherit;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;height:30px;line-height:1;}
.eml-btn:hover{background:#edf2fa;border-color:#bcc9db;}
.eml-btn.primary{background:#2b3a4a;border-color:#2b3a4a;color:#fff;}
.eml-btn.danger{background:#fef2f2;border-color:#fecaca;color:#991b1b;}
.eml-tabs{display:flex;align-items:center;gap:4px;overflow-x:auto;padding-bottom:4px;border-bottom:1px solid #eef1f6;flex-shrink:0;min-height:28px;}
.eml-tab{padding:4px 12px;font-size:12px;border-radius:8px 8px 0 0;border:1px solid transparent;border-bottom:none;color:#5f6b7a;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:4px;background:transparent;transition:.12s;}
.eml-tab.active{background:#fff;color:#1a1f2b;border-color:#eef1f6;font-weight:600;}
.eml-tab .tname{outline:none;font:inherit;background:transparent;border:none;color:inherit;min-width:26px;padding:0 2px;}
.eml-tab .tclose{font-size:12px;color:#94a3b8;cursor:pointer;line-height:1;}
.eml-tab .tclose:hover{color:#c0392b;}
.eml-addtab{background:transparent;border:1px dashed #dce3ec;border-radius:8px;padding:3px 12px;font-size:12px;color:#6b7a8e;cursor:pointer;white-space:nowrap;}
.eml-cards{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;}
.eml-card{background:#fff;border:1px solid #eef1f6;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.03);padding:9px 12px 12px;transition:.15s;}
.eml-card:hover{box-shadow:0 4px 14px rgba(0,0,0,.06);}
.eml-card.dragging{opacity:.4;}
.eml-card-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px dashed #eef1f6;touch-action:none;}
.eml-grip{flex:0 0 auto;width:16px;color:#6b7a8e;cursor:grab;font-size:13px;text-align:center;user-select:none;-webkit-user-select:none;transition:.12s;}
.eml-grip:hover{color:#1a1f2b;}
.eml-grip:active{cursor:grabbing;}
.eml-card.mgr{outline:2px dashed #6b7a8e;outline-offset:-2px;}
.eml-card.mgr .ctitle{color:#94a3b8;}
.eml-card.mgr-sel{background:rgba(59,130,246,.22);box-shadow:0 0 0 3px rgba(59,130,246,.72);}
.eml-media.mgr-sel{border-color:rgba(59,130,246,.95);box-shadow:0 0 0 3px rgba(59,130,246,.9);background:rgba(59,130,246,.2);}
.eml-media.mgr-sel .info{border-top:1px solid rgba(59,130,246,.7);background:rgba(255,255,255,.72);}
.eml-media.drop-target{box-shadow:0 0 0 3px rgba(34,197,94,.72);background:rgba(34,197,94,.16);}
.eml-media.dragging{opacity:.5;}
.eml-tab.mgr-sel{background:rgba(59,130,246,.2);border-color:rgba(59,130,246,.7);color:#1d4ed8;}
.eml-managerbar{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#f3f5f9;border:1px solid #dce3ec;border-radius:9px;font-size:12px;color:#1a1f2b;flex-shrink:0;position:sticky;top:0;z-index:8;flex-wrap:wrap;}
.eml-bb-item.sel{background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.65);box-shadow:0 0 0 2px rgba(59,130,246,.5);}
.eml-bbtrow{display:flex;align-items:center;gap:4px;padding:6px 10px;cursor:pointer;border-left:3px solid transparent;font-size:12px;color:#1a1f2b;white-space:nowrap;}
.eml-bbtrow:hover{background:#f3f5f9;}
.eml-bbtrow.sel{background:rgba(43,58,74,.1);border-left-color:#2b3a4a;color:#2b3a4a;font-weight:500;}
.eml-bbtwist{width:16px;height:16px;display:flex;align-items:center;justify-content:center;transition:transform .2s;color:#8a9aa8;font-size:10px;flex-shrink:0;}
.eml-bbtwist.expanded{transform:rotate(90deg);}
.eml-bbtwist.leaf{opacity:0;pointer-events:none;}
.eml-bbficon{color:#8a9aa8;font-size:12px;flex-shrink:0;display:flex;align-items:center;}
.eml-bbtrow.sel .eml-bbficon{color:#2b3a4a;}
.eml-bbfname{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;}
.eml-card-head .ctitle{font-size:14px;font-weight:600;color:#1a1f2b;flex:1 1 auto;min-width:60px;outline:none;border:none;background:transparent;padding:2px 6px;border-radius:5px;cursor:default;}
.eml-card-head .ctitle.editing{cursor:text;background:#fff;box-shadow:0 0 0 2px #dce3ec;}
.eml-card-head .cdel{border:none;background:transparent;color:#6b7a8e;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:5px;}
.eml-card-head .cdel:hover{background:#fdecec;color:#c0392b;}
.eml-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;min-height:80px;position:relative;border-radius:8px;}
@media (max-width:920px){.eml-grid{grid-template-columns:repeat(3,1fr);}}
@media (max-width:640px){.eml-grid{grid-template-columns:repeat(2,1fr);}}
.eml-media{background:#fbfcfe;border:1px solid #eef1f6;border-radius:9px;overflow:hidden;display:flex;flex-direction:column;min-height:192px;position:relative;cursor:pointer;transition:.15s;}
.eml-media:hover{border-color:#d0d5dd;box-shadow:0 4px 12px rgba(0,0,0,.06);}
.eml-media.mgr-sel:hover{border-color:rgba(59,130,246,.95);box-shadow:0 0 0 3px rgba(59,130,246,.9);background:rgba(59,130,246,.2);}
.eml-media .pv{width:100%;background:#eef1f6;display:flex;align-items:center;justify-content:center;position:relative;aspect-ratio:16/9;overflow:hidden;flex-shrink:0;}
.eml-media .pv img{width:100%;height:100%;object-fit:contain;background:#eef1f6;object-position:center;display:block;}
.eml-media .pv video{width:100%;height:100%;object-fit:contain;background:#eef1f6;object-position:center;}
.eml-media .pv audio{width:100%;height:44px;background:#e2e8f0;border-radius:0;}
.eml-media .pv .ph{font-size:28px;color:#94a3b8;opacity:.6;}
.eml-media .type-badge{position:absolute;top:5px;left:5px;background:rgba(255,255,255,.86);border-radius:30px;padding:1px 8px;font-size:10px;font-weight:600;color:#1a1f2b;box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid #eef1f6;pointer-events:none;z-index:3;}
.eml-media .rm{position:absolute;top:3px;right:3px;background:rgba(255,255,255,.88);border:none;border-radius:50%;width:20px;height:20px;font-size:11px;line-height:20px;text-align:center;color:#94a3b8;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.1);z-index:6;display:flex;align-items:center;justify-content:center;padding:0;opacity:0;transition:.12s;}
.eml-media:hover .rm{opacity:1;}
.eml-media .rm:hover{background:#fdecec;color:#c0392b;}
.eml-media .stack-badge{position:absolute;bottom:5px;right:5px;background:rgba(0,0,0,.72);color:#fff;font-size:10px;padding:1px 8px;border-radius:20px;pointer-events:none;z-index:5;}
.eml-media .info{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:2px;padding:5px 8px 6px;background:rgba(255,255,255,.62);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-top:1px solid rgba(255,255,255,.5);opacity:0;transform:translateY(4px);transition:.15s;pointer-events:none;z-index:5;}
.eml-media:hover .info{opacity:1;transform:none;}
.eml-media.playing .info{opacity:0;transform:translateY(4px);pointer-events:none;}
.eml-media.playing:hover .info{opacity:0;}
.eml-media .eml-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.55);color:#fff;border:none;border-radius:50%;width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:6;font-size:16px;padding:0;opacity:0;pointer-events:none;transition:.15s;font-family:inherit;}
.eml-media:hover .eml-play{opacity:1;pointer-events:auto;}
.eml-media.playing .eml-play{opacity:0;pointer-events:none;}
.eml-media audio,.eml-pvmain audio{background:#fff !important;border-radius:8px;color-scheme:light;}
.eml-media audio::-webkit-media-controls-panel,.eml-pvmain audio::-webkit-media-controls-panel,.eml-media audio::-webkit-media-controls-enclosure,.eml-pvmain audio::-webkit-media-controls-enclosure{background:#fff !important;border-radius:8px;}
.eml-media audio::-webkit-media-controls-timeline,.eml-pvmain audio::-webkit-media-controls-timeline{background:#fff;border-radius:4px;}
.eml-media .info .fname{font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1a1f2b;}
.eml-root input[type=number]{-moz-appearance:textfield;appearance:textfield;}
.eml-root input[type=number]::-webkit-inner-spin-button,.eml-root input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
.eml-media .info .fmeta{font-size:10px;color:#64748b;display:flex;justify-content:space-between;}
.eml-media .info .fmeta .suffix{background:rgba(255,255,255,.7);padding:0 6px;border-radius:4px;border:1px solid rgba(255,255,255,.6);}
.eml-empty{background:#fbfcfe;border:2px dashed #d1d5db;border-radius:9px;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:230px;cursor:pointer;transition:.15s;color:#94a3b8;gap:4px;}
.eml-empty:hover{border-color:#94a3b8;background:#f3f5f9;}
.eml-empty .big{font-size:28px;font-weight:300;line-height:1;}
.eml-addbar{margin-top:8px;padding:8px 0;border-top:1px solid #eef1f6;text-align:center;cursor:pointer;color:#6b7a8e;font-size:13px;opacity:.6;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;}
.eml-addbar:hover{opacity:1;background:#f3f5f9;}
.eml-socket-label{position:fixed;z-index:20;pointer-events:none;background:rgba(26,36,48,0.5);color:#e8e8f0;font-size:9px;line-height:1;padding:2px 6px;border-radius:3px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;user-select:none;display:inline-flex;align-items:center;}
.eml-socket-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;margin-right:5px;border:1px solid rgba(255,255,255,.3);}
`;

let _styleInjected = false;
let _widgetSeq = 0;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function nextWidgetType() { _widgetSeq += 1; return 'eml-config__' + _widgetSeq.toString(36); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
function genId() { return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function uiToast(msg) {
  const t = el('div');
  t.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:8px 20px;border-radius:30px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.2);z-index:10000;opacity:0;transition:opacity .3s;pointer-events:none;';
  t.textContent = msg; document.body.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; });
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2000);
}

// ===== 状态 / config =====
function stateFor(node) { if (!node._eml) node._eml = { groups: [], currentGroupId: null, currentPreset: 'default', gridCols: 3, gridRowH: 1 }; return node._eml; }
function configWidgetOf(node) { return configWidget(node); }
function syncToConfig(node) {
  const st = stateFor(node); const w = configWidgetOf(node); if (!w) return;
  const json = JSON.stringify({ groups: st.groups, currentGroupId: st.currentGroupId, currentPreset: st.currentPreset, gridCols: st.gridCols || 3, gridRowH: st.gridRowH || 1 });
  w.value = json; if (typeof w.callback === 'function') w.callback(json); if (node.graph) node.graph.setDirtyCanvas(true, true); notifyConfigChanged(node);
}
function loadFromConfig(node) {
  const st = stateFor(node); const w = configWidgetOf(node);
  let data = {};
  try { data = JSON.parse(w ? (w.value || '{}') : '{}') || {}; } catch (_) { data = {}; }
  st.groups = Array.isArray(data.groups) ? data.groups : [];
  // 文件类型以扩展名为准：卡片里存的 type 可能是旧值/猜错的，会让预览、端口类型、编号都跑偏。
  st.groups.forEach((g) => (g.cards || []).forEach((c) => (c.items || []).forEach((it) => (it.files || []).forEach((f) => { const k = mediaKind(f.name || f.path); if (k !== 'other') f.type = k; }))));
  st.currentPreset = data.currentPreset || 'default';
  st.gridCols = Math.max(1, parseInt(data.gridCols, 10) || 3);
  st.gridRowH = Math.max(0, parseInt(data.gridRowH, 10) || 1);
  if (!st.groups.length) { st.groups = [{ id: genId(), name: ezT('Group'), cards: [{ id: genId(), name: ezT('Card group 1'), items: [] }] }]; }
  st.currentGroupId = data.currentGroupId != null && st.groups.some((g) => g.id === data.currentGroupId) ? data.currentGroupId : st.groups[0].id;
}
function currentGroup(node) { const st = stateFor(node); return st.groups.find((g) => g.id === st.currentGroupId) || st.groups[0] || null; }

// ===== 媒体辅助 =====
function mediaKind(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (/^(png|jpe?g|webp|gif|bmp|tif?f|heic|avif|psd)$/.test(ext)) return 'image';
  if (/^(mp4|avi|mkv|mov|webm|flv|wmv|m4v)$/.test(ext)) return 'video';
  if (/^(mp3|wav|flac|aac|ogg|m4a|wma|opus)$/.test(ext)) return 'audio';
  if (/^(gltf|glb|obj|fbx|stl|ply|3ds|dae|blend)$/.test(ext)) return 'model_3d';
  return 'other';
}
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
function render(node) {
  const root = node._emlRoot; if (!root) return;
  const st = stateFor(node); const g = currentGroup(node);
  const panel = root;
  // 顶部预设
  const top = panel.querySelector('.eml-top'); top.innerHTML = '';
  const presetWrap = el('div'); presetWrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;flex:0 0 auto;';
  const presetSel = el('select', 'eml-preset'); presetSel._node = node; presetSel.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:0;height:0;left:0;top:0;';
  const presetBtn = el('button', 'eml-preset-btn', { type: 'button' }); presetBtn.textContent = 'default';
  const presetMenu = el('div', 'eml-preset-menu');
  presetWrap.appendChild(presetSel); presetWrap.appendChild(presetBtn); presetWrap.appendChild(presetMenu);
  top.appendChild(presetWrap);
  presetSel._dd = { btn: presetBtn, menu: presetMenu };
  presetBtn.addEventListener('click', (e) => { e.stopPropagation(); presetMenu.classList.toggle('open'); });
  presetMenu.addEventListener('click', (e) => { const it = e.target.closest('.eml-preset-item'); if (!it) return; presetSel.value = it.dataset.v; presetMenu.classList.remove('open'); presetSel.dispatchEvent(new Event('change')); });
  document.addEventListener('click', () => { if (presetMenu.classList.contains('open')) presetMenu.classList.remove('open'); });
  const saveBtn = el('button', 'eml-btn primary', { type: 'button' }); saveBtn.textContent = ezT('Save preset');
  const delBtn = el('button', 'eml-btn danger', { type: 'button' }); delBtn.textContent = ezT('Delete preset');
  top.appendChild(saveBtn); top.appendChild(delBtn);
  const gcLabel = el('span'); gcLabel.textContent = ezT('Columns'); gcLabel.style.cssText = 'font-size:11px;color:#5f6b7a;';
  const gcInput = el('input'); gcInput.type = 'number'; gcInput.min = '1'; gcInput.step = '1'; gcInput.value = String(st.gridCols || 3); gcInput.title = ezT('Cards per row');
  gcInput.style.cssText = 'width:48px;height:30px;padding:4px 6px;font-size:12px;border:1px solid #dce3ec;border-radius:8px;text-align:center;background:#fff;';
  gcInput.addEventListener('change', () => { const v = Math.max(1, parseInt(gcInput.value, 10) || 3); st.gridCols = v; gcInput.value = String(v); syncToConfig(node); render(node); });
  top.appendChild(gcLabel); top.appendChild(gcInput);
  const rhLabel = el('span'); rhLabel.textContent = ezT('Row height'); rhLabel.style.cssText = 'font-size:11px;color:#5f6b7a;';
  const rhInput = el('input'); rhInput.type = 'number'; rhInput.min = '0'; rhInput.step = '1'; rhInput.value = String(st.gridRowH || 1); rhInput.title = ezT('Card height multiplier: 0 = fit 16:9; >= 1 = default height (192px) × value');
  rhInput.style.cssText = 'width:48px;height:30px;padding:4px 6px;font-size:12px;border:1px solid #dce3ec;border-radius:8px;text-align:center;background:#fff;';
  rhInput.addEventListener('change', () => { const v = Math.max(0, parseInt(rhInput.value, 10) || 1); st.gridRowH = v; rhInput.value = String(v); syncToConfig(node); render(node); });
  top.appendChild(rhLabel); top.appendChild(rhInput);
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
    close.addEventListener('click', (e) => { e.stopPropagation(); deleteGroup(node, grp.id); });
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
  card.items.forEach((item) => grid.appendChild(buildMediaCard(node, g, card, item)));
  grid.appendChild(buildEmptyCard(node, g, card));
  grid.addEventListener('dblclick', () => openBrowse(node, g, card));
  grid.addEventListener('dragover', (e) => { e.preventDefault(); cardDiv.classList.add('drag-over'); });
  grid.addEventListener('dragleave', (e) => { e.preventDefault(); cardDiv.classList.remove('drag-over'); });
  grid.addEventListener('drop', (e) => { e.preventDefault(); cardDiv.classList.remove('drag-over'); dropFilesToCard(e, node, g, card); });
  cardDiv.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openRowMenu(e, node, g, card); });
  cardDiv.appendChild(grid);
  return cardDiv;
}

const _mlPreview = {};
function buildMediaCard(node, g, card, item) {
  const isItemMgr = node._ezItemMgr;
  const m = el('div', 'eml-media' + (isItemMgr && node._ezItemSel && node._ezItemSel.has(String(item.id)) ? ' mgr-sel' : ''));
  m.dataset.itemId = item.id; m.dataset.cid = card.id;
  const files = item.files || []; const first = files[0] || {};
  m.title = (first.name || '') + (files.length > 1 ? ' (+' + (files.length - 1) + ')' : '') + ' — ' + ezT('Click to preview');
  const pv = el('div', 'pv');
  const rowH = stateFor(node).gridRowH;
  if (rowH > 0) { pv.style.aspectRatio = 'auto'; pv.style.height = Math.max(1, rowH) * 192 + 'px'; }
  const rm = el('button', 'rm', { type: 'button', title: ezT('Remove media') }); rm.textContent = '✕';
  rm.addEventListener('click', (e) => { e.stopPropagation(); card.items = card.items.filter((x) => x.id !== item.id); syncToConfig(node); render(node); });
  pv.appendChild(rm);
  if (first.type === 'image') { const img = el('img'); img.src = first.url || ''; img.alt = first.name || ''; img.draggable = false; img.style.cssText = 'width:100%;height:100%;object-fit:contain;'; pv.appendChild(img); }
  else if (first.type === 'video') {
    const v = el('video'); v.src = first.url || ''; v.muted = true; v.preload = 'metadata'; v.style.cssText = 'width:100%;height:100%;object-fit:contain;'; pv.appendChild(v);
    const play = el('button', 'eml-play', { type: 'button' }); play.textContent = '▶'; play.title = ezT('Play preview');
    play.addEventListener('click', (e) => { e.stopPropagation(); try { v.muted = false; v.controls = true; v.play(); m.classList.add('playing'); } catch (_) {} });
    v.addEventListener('play', () => m.classList.add('playing'));
    v.addEventListener('pause', () => { v.controls = false; m.classList.remove('playing'); });
    pv.appendChild(play);
  }
  else if (first.type === 'audio') { const ap = makeAudioPlayer(first.url || ''); ap.style.cssText = 'width:100%;'; pv.appendChild(ap); }
  else if (first.type === 'model_3d') { const pvUrl = _mlPreview[item.id]; if (pvUrl) { const im = el('img'); im.src = pvUrl; im.style.cssText = 'width:100%;height:100%;object-fit:contain;'; pv.appendChild(im); } else { const ph = el('span', 'ph'); ph.textContent = '🧊'; pv.appendChild(ph); } }
  else { const ph = el('span', 'ph'); ph.textContent = '📄'; pv.appendChild(ph); }
  if (files.length > 1) { const b = el('span', 'stack-badge'); b.textContent = '+' + (files.length - 1); pv.appendChild(b); }
  m.appendChild(pv);
  const info = el('div', 'info');
  const row1 = el('div'); row1.style.cssText = 'display:flex;align-items:center;gap:6px;';
  const tb = el('span'); tb.textContent = typeShort(first.type); tb.style.cssText = 'flex:0 0 auto;background:rgba(255,255,255,.7);border:1px solid rgba(255,255,255,.6);color:#1a1f2b;border-radius:30px;padding:0 8px;font-size:10px;font-weight:600;line-height:18px;'; row1.appendChild(tb);
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
    if (first.type === 'model_3d') { open3d(node, item, card); return; } openPreview(node, item, card);
  });
  return m;
}

function buildEmptyCard(node, g, card) {
  const e = el('div', 'eml-empty');
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
    const d = await r.json();
    const ups = d.files || [];
    if (!ups.length) { uiToast(ezT('No files to upload')); return; }
    card.items.push({ id: genId(), files: ups.map((f) => ({ id: genId(), name: f.name, path: f.path, subfolder: f.subfolder || '', dir: 'input', type: f.type || mediaKind(f.name), url: f.url, size: f.size, mtime: f.mtime })) });
    syncToConfig(node); render(node); uiToast(ezT('Dropped ') + ups.length + ezT(' media files'));
  } catch (_) { uiToast(ezT('Upload failed')); }
}

// ===== 右键菜单（三级：单个卡片 / 素材卡片组 / 分组）=====
function buildMenu(e, items) {
  const menu = el('div');
  menu.style.cssText = 'position:fixed;z-index:10000;background:#fff;border:1px solid #dce3ec;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.16);padding:4px;min-width:180px;';
  items.forEach((it) => {
    const b = el('button'); b.textContent = it.label; b.style.cssText = 'display:block;width:100%;text-align:left;background:none;border:none;padding:6px 12px;font-size:12px;color:#1a1f2b;cursor:pointer;border-radius:6px;font-family:inherit;';
    b.addEventListener('click', () => { menu.remove(); it.fn(); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const close = (ev) => { if (!menu.contains(ev.target)) menu.remove(); };
  document.addEventListener('mousedown', close, { once: true });
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
  const container = root.querySelector('.eml-cards');
  const line = el('div'); line.style.cssText = 'height:5px;background:#2b3a4a;border-radius:2px;flex:0 0 5px;opacity:0;pointer-events:none;';
  let curIdx = g.cards.findIndex((c) => c.id === card.id);
  const onMove = (ev) => {
    ghost.style.top = (ev.clientY - offsetY) + 'px';
    const all = Array.from(container.querySelectorAll('.eml-card')).filter((x) => x !== cardDiv);
    let insertIdx = all.length;
    // 以“素材卡片组标题行”上沿作为插入边界
    for (let i = 0; i < all.length; i++) { const head = all[i].querySelector('.eml-card-head'); const r = (head || all[i]).getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { insertIdx = i; break; } }
    if (line.parentNode) line.parentNode.removeChild(line);
    if (insertIdx < all.length) container.insertBefore(line, all[insertIdx]);
    else { const last = all[all.length - 1]; if (last) container.insertBefore(line, last.nextSibling); else container.appendChild(line); }
    line.style.opacity = '1';
    let targetIdx;
    if (insertIdx >= all.length) targetIdx = g.cards.length - 1;   // 拖到最底部
    else { targetIdx = insertIdx; if (insertIdx > curIdx) targetIdx -= 1; }
    onMove._t = Math.max(0, Math.min(g.cards.length - 1, targetIdx));
  };
  let _raf = 0, _lastEv = null;
  const onMoveRaf = (ev) => { _lastEv = ev; if (_raf) return; _raf = requestAnimationFrame(() => { _raf = 0; onMove(_lastEv); }); };
  const onUp = () => {
    if (_raf) cancelAnimationFrame(_raf);
    const target = onMove._t != null ? onMove._t : curIdx;
    if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    cardDiv.classList.remove('dragging');
    if (line.parentNode) line.parentNode.removeChild(line);
    document.removeEventListener('mousemove', onMoveRaf); document.removeEventListener('mouseup', onUp);
    if (target !== curIdx && target >= 0 && target < g.cards.length) { const [moved] = g.cards.splice(curIdx, 1); g.cards.splice(target, 0, moved); syncToConfig(node); updatePorts(node, true); render(node); }
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
  const move = (ev) => {
    ghost.style.left = (ev.clientX - rect.width / 2) + 'px'; ghost.style.top = (ev.clientY - 20) + 'px';
    document.querySelectorAll('.eml-media.drop-target').forEach((x) => x.classList.remove('drop-target'));
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const t = el && el.closest ? el.closest('.eml-media') : null;
    if (t && t !== elm) t.classList.add('drop-target');
  };
  let _raf = 0, _lastEv = null;
  const moveRaf = (ev) => { _lastEv = ev; if (_raf) return; _raf = requestAnimationFrame(() => { _raf = 0; move(_lastEv); }); };
  const up = (ev) => {
    if (_raf) cancelAnimationFrame(_raf);
    window.removeEventListener('pointermove', moveRaf, true); window.removeEventListener('pointerup', up, true);
    if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    elm.classList.remove('dragging');
    const targets = document.querySelectorAll('.eml-media'); Array.from(targets).forEach((x) => x.classList.remove('drop-target'));
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const t = el && el.closest ? el.closest('.eml-media') : null;
    if (t && t !== elm) {
      const targetItem = findItemByEl(node, t);
      if (targetItem) {
        targetItem.files = targetItem.files.concat(item.files || []);
        (card.items || []).forEach((it, i) => { if (it === item) card.items.splice(i, 1); });
        syncToConfig(node); render(node); uiToast(ezT('Merged the card into the target card (now a batch card)'));
      }
    }
  };
  window.addEventListener('pointermove', moveRaf, true); window.addEventListener('pointerup', up, true);
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
  const line = el('div'); line.style.cssText = 'width:3px;align-self:stretch;background:#2b3a4a;border-radius:2px;opacity:0;flex:0 0 3px;';
  tabsBar.appendChild(line);
  let cur = gi;
  let _raf = 0, _lastEv = null;
  const move = (ev) => {
    ghost.style.left = (ev.clientX - rect.width / 2) + 'px';
    const tabs = Array.from(tabsBar.querySelectorAll('.eml-tab')).filter((t) => t !== line);
    let hover = 0;
    tabs.forEach((t, i) => { const r = t.getBoundingClientRect(); if (ev.clientX > r.left + r.width / 2) hover = i + 1; });
    if (hover < tabs.length) tabsBar.insertBefore(line, tabs[hover]); else { const add = tabsBar.querySelector('.eml-addtab'); if (add) tabsBar.insertBefore(line, add); else tabsBar.appendChild(line); }
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
    (Array.isArray(list) ? list : []).forEach((p) => { if (p && p.name === 'default') return; const o = el('option'); o.value = p.name; o.textContent = p.name; if (st && p.name === st.currentPreset) o.selected = true; sel.appendChild(o); });
    if (st && st.currentPreset && st.currentPreset !== 'default' && ![...sel.options].some((o) => o.value === st.currentPreset)) { const o = el('option'); o.value = st.currentPreset; o.textContent = st.currentPreset; sel.appendChild(o); }
    const dd = sel._dd;
    if (dd) {
      const cur = st ? st.currentPreset : (sel.value || 'default');
      dd.btn.textContent = cur;
      dd.menu.innerHTML = '';
      const opts = [...sel.options];
      if (!opts.length) { const e = el('div', 'eml-preset-item'); e.textContent = ezT('(No presets)'); e.style.cssText = 'padding:6px 12px;font-size:12px;color:#94a3b8;'; dd.menu.appendChild(e); }
      opts.forEach((o) => { const it = el('div', 'eml-preset-item' + (o.value === cur ? ' active' : '')); it.textContent = o.value; it.dataset.v = o.value; dd.menu.appendChild(it); });
    }
  } catch (_) {}
}
async function saveCurrentPreset(node) {
  let dft = ezT('Preset 1');
  try { const l = await (await fetch(PRESET_API)).json(); dft = ezT('Preset') + ((l || []).length + 1); } catch (_) {}
  const name = await uiPrompt(ezT('Enter preset name:'), dft);
  if (!name || !name.trim()) return;
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
  const ov = el('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:9998;background:#f5f6f8;color:#1a1f2b;font-family:Inter,sans-serif;display:flex;flex-direction:column;';
  ov.innerHTML = '<div class="eml-toolbar" style="display:flex;align-items:center;gap:6px;padding:10px 18px 10px 46px;background:#fff;border-bottom:1px solid #e6e9ef;flex-shrink:0;flex-wrap:wrap;position:relative;"><b style="font-size:15px;white-space:nowrap;">' + ezT('Media browser') + '</b>' +
    '<button class="eml-navb" title="' + ezT('Back') + '" style="background:#fff;border:1px solid #dce3ec;border-radius:8px;width:28px;height:28px;color:#4d5b6d;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex:0 0 auto;">←</button>' +
    '<button class="eml-navf" title="' + ezT('Forward') + '" style="background:#fff;border:1px solid #dce3ec;border-radius:8px;width:28px;height:28px;color:#4d5b6d;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex:0 0 auto;">→</button>' +
    '<button class="eml-navup" title="' + ezT('Parent directory') + '" style="background:#fff;border:1px solid #dce3ec;border-radius:8px;width:28px;height:28px;color:#4d5b6d;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex:0 0 auto;">↑</button>' +
    '<button class="eml-navr" title="' + ezT('Refresh') + '" style="background:#fff;border:1px solid #dce3ec;border-radius:8px;width:28px;height:28px;color:#4d5b6d;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex:0 0 auto;">↻</button>' +
    '<input class="eml-bbsearch" placeholder="' + ezT('Search this folder…') + '" style="flex:1 1 auto;max-width:360px;min-width:120px;padding:6px 10px;font-size:12px;border:1px solid #dce3ec;border-radius:7px;background:#fff;outline:none;font-family:inherit;">' +
    '<input class="eml-path" placeholder="' + ezT('Enter a path…') + '" title="' + ezT('Type a drive/path and press Enter to go') + '" style="flex:0 1 auto;max-width:260px;min-width:130px;background:#fff;border:1px solid #dce3ec;border-radius:7px;padding:6px 10px;font-size:12px;outline:none;font-family:inherit;" />' +
    '<button class="eml-bbclose" style="position:absolute;top:8px;right:14px;width:28px;height:28px;border-radius:50%;border:1px solid rgba(220,38,38,.32);background:rgba(220,38,38,.1);color:#dc2626;font-size:15px;cursor:pointer;">✕</button></div>' +
    '<div style="flex:1;display:flex;min-height:0;"><div class="eml-bbtree" style="width:240px;flex-shrink:0;background:#fff;border-right:1px solid #e6e9ef;overflow:auto;padding:6px 0;"></div><div style="flex:1;display:flex;flex-direction:column;min-width:0;"><div class="eml-panebar" style="display:flex;align-items:center;gap:6px;padding:6px 14px;background:#fff;border-bottom:1px solid #eef1f6;flex-shrink:0;flex-wrap:wrap;"><span class="eml-viewbar" style="display:flex;gap:2px;background:#f1f4fa;border-radius:8px;padding:2px;border:1px solid #e2e8f0;"><button data-v="list" title="' + ezT('List') + '">☰</button><button data-v="big" title="' + ezT('Large icons') + '">▦</button><button data-v="small" title="' + ezT('Small icons') + '">▤</button><button data-v="detail" title="' + ezT('Detail view') + '">≡</button></span>' +
    '<button class="eml-selall" title="' + ezT('Select all') + '" style="background:#f7f9fd;border:1px solid #dce3ec;border-radius:7px;padding:4px 10px;font-size:12px;cursor:pointer;">' + ezT('Select all') + '</button>' +
    '<button class="eml-selinv" title="' + ezT('Invert') + '" style="background:#f7f9fd;border:1px solid #dce3ec;border-radius:7px;padding:4px 10px;font-size:12px;cursor:pointer;">' + ezT('Invert') + '</button>' +
    '<button class="eml-selclr" title="' + ezT('Deselect') + '" style="background:#f7f9fd;border:1px solid #dce3ec;border-radius:7px;padding:4px 10px;font-size:12px;cursor:pointer;">' + ezT('Clear') + '</button>' +
    '<span class="eml-bbcount" style="font-size:12px;color:#6b7a8e;">' + ezT('Selected ') + 0 + ezT(' item(s)') + '</span></div><div class="eml-bblist" style="flex:1;overflow:auto;padding:12px 18px;"></div></div></div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 18px;background:#fff;border-top:1px solid #e6e9ef;flex-shrink:0;"><span style="font-size:11px;color:#94a3b8;">' + ezT('Drag files here to upload / drag files onto cards') + '</span><button class="eml-bbadd" style="background:#2b3a4a;border:1px solid #2b3a4a;color:#fff;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer;">' + ezT('Add to card group') + '</button></div>';
  document.body.appendChild(ov);
  // 「＋根」：把输入框/当前目录登记为「可浏览根目录」（后端只允许本机登记；浏览器只能在根目录内导航）
  try {
    const pb = ov.querySelector('.eml-path');
    if (pb && pb.parentNode) {
      const rb = el('button', 'eml-addroot'); rb.style.flex = '0 0 auto';
      rb.textContent = ezT('Save root');
      rb.title = ezT('Add the folder in the field above as a browsable root and enter it (local only). To limit unauthorized reads, the browser can only navigate inside roots.');
      rb.style.cssText = 'background:#f7f9fd;border:1px solid #dce3ec;border-radius:7px;padding:6px 10px;font-size:12px;color:#4d5b6d;cursor:pointer;white-space:nowrap;';
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
      rs.style.cssText = 'background:#f7f9fd;border:1px solid #dce3ec;border-radius:7px;padding:5px 8px;font-size:12px;color:#4d5b6d;max-width:230px;min-width:130px;flex:0 0 auto;';
      rs.addEventListener('change', () => { pinnedRoot = rs.value; syncDelBtn(); if (rs.value) navigate(rs.value, false); });
      const host = pb.parentNode || ov.querySelector('.eml-toolbar') || ov;
      const rx = el('button', 'eml-rmroot'); rx.style.flex = '0 0 auto';
      rx.textContent = ezT('Delete root');
      rx.title = ezT('Delete the root selected in the dropdown (built-in roots are always available)');
      rx.style.cssText = 'background:#fff;border:1px solid #dce3ec;border-radius:7px;padding:6px 10px;font-size:12px;color:#b3352f;cursor:pointer;white-space:nowrap;';
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
    rx.style.color = on ? '#b3352f' : '#8a94a3';
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
    if (!dirs.length) { const e = el('div'); e.textContent = ezT('(No subfolders)'); e.style.cssText = 'padding:8px 12px;font-size:11px;color:#94a3b8;'; tree.appendChild(e); }
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
    if (!removed) card.items.push({ id: genId(), files: [fileEntryOf(f)] });
    card.items = card.items.filter((it) => (it.files || []).length);
    syncToConfig(node); render(node);
    return !removed;
  };
  const mkAddBtn = (f) => {
    const b = el('button'); b.type = 'button';
    b.style.cssText = 'position:absolute;top:6px;right:6px;z-index:3;width:26px;height:26px;border-radius:50%;border:1px solid rgba(255,255,255,.5);background:rgba(255,255,255,.55);color:#1a1f2b;font-size:16px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:.15s;font-family:inherit;padding:0;';
    const refresh = () => { const on = cardHasFile(f); b.textContent = on ? '−' : '+'; b.title = on ? ezT('Remove from card group') : ezT('Add to card group'); b.style.background = on ? 'rgba(74,106,90,.85)' : 'rgba(255,255,255,.55)'; b.style.color = on ? '#fff' : '#1a1f2b'; };
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
    if (!listF.length) { const e = el('div'); e.textContent = ezT('No media files found'); e.style.cssText = 'color:#8a9aa8;text-align:center;padding:40px 12px;font-size:13px;'; list.appendChild(e); return; }
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
      const sv = el('span'); sv.textContent = typeShort(f.type); sv.style.cssText = 'color:#6b7a8e;font-size:10px;background:#f3f5f9;padding:0 8px;border-radius:30px;'; row.appendChild(sv);
      row.appendChild(mkAddBtn(f));
      row.addEventListener('click', (e) => toggleSel(listF.indexOf(f), e));
      return row;
    };
    const renderTile = (f) => {
      const tile = el('div'); tile.classList.add('eml-bb-item'); tile.style.cssText = 'cursor:pointer;border:1px solid #eef1f6;border-radius:9px;overflow:hidden;background:#fff;align-self:start;position:relative;'; tile.dataset.path = f.path || f.name;
      const pv = el('div'); pv.style.cssText = 'height:88px;max-height:88px;min-height:88px;background:#eef1f6;display:flex;align-items:center;justify-content:center;font-size:30px;color:#94a3b8;overflow:hidden;';
      if (isAbsImg(f)) { const im = el('img'); im.src = fileUrl(f); im.style.cssText = 'display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;'; pv.appendChild(im); } else pv.textContent = icon(f.type);
      const nm = el('div'); nm.textContent = f.name; nm.style.cssText = 'font-size:10px;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      tile.appendChild(pv); tile.appendChild(nm); tile.appendChild(mkAddBtn(f));
      tile.addEventListener('click', (e) => toggleSel(listF.indexOf(f), e));
      return tile;
    };
    if (view === 'big') { list.style.display = 'grid'; list.style.gridTemplateColumns = 'repeat(5,1fr)'; list.style.gridAutoRows = '112px'; list.style.gridAutoFlow = 'row'; list.style.gap = '10px'; list.style.alignItems = 'start'; listF.forEach((f) => list.appendChild(renderTile(f))); }
    else if (view === 'small') { list.style.display = 'grid'; list.style.gridTemplateColumns = 'repeat(8,1fr)'; list.style.gridAutoRows = '96px'; list.style.gridAutoFlow = 'row'; list.style.gap = '6px'; list.style.alignItems = 'start'; listF.forEach((f) => list.appendChild(renderTile(f))); }
    else if (view === 'detail') { list.style.display = 'flex'; list.style.flexDirection = 'column'; list.style.gap = '2px'; listF.forEach((f) => { const row = renderRow(f); const sz = el('span'); sz.textContent = formatSize(f.size); sz.style.cssText = 'color:#6b7a8e;font-size:10px;min-width:64px;'; row.appendChild(sz); const mt = el('span'); mt.textContent = f.mtime || ''; mt.style.cssText = 'color:#94a3b8;font-size:10px;min-width:120px;'; row.appendChild(mt); list.appendChild(row); }); }
    else { list.style.display = 'flex'; list.style.flexDirection = 'column'; list.style.gap = '2px'; listF.forEach((f) => list.appendChild(renderRow(f))); }
  };
  try { drawTree(); drawPane(); } catch (err) { try { list.innerHTML = ''; const e = el('div'); e.textContent = ezT('Failed to render browser: ') + (err && err.message || err); e.style.cssText = 'color:#c0392b;text-align:center;padding:20px;font-size:13px;'; list.appendChild(e); } catch (_) {} }
  ov.querySelector('.eml-navb').addEventListener('click', () => { if (histIdx > 0) { histIdx--; navigate(hist[histIdx], false); } });
  ov.querySelector('.eml-navf').addEventListener('click', () => { if (histIdx < hist.length - 1) { histIdx++; navigate(hist[histIdx], false); } });
  ov.querySelector('.eml-navup').addEventListener('click', () => {
    if (curData.parent) navigate(curData.parent);
    else uiToast(ezT('Already inside a browsable root; to go up, enter that parent folder in the path field above and click "Add as root"'));
  });
  ov.querySelector('.eml-navr').addEventListener('click', () => { navigate(cur, false); });
  ov.querySelector('.eml-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = (e.target.value || '').trim(); if (v) navigate(v); } });
  ov.querySelectorAll('.eml-viewbar button').forEach((b) => { b.style.cssText = 'background:transparent;border:none;padding:2px 8px;font-size:12px;color:#4d5b6d;cursor:pointer;border-radius:6px;'; if (b.dataset.v === view) b.style.background = '#fff'; b.addEventListener('click', () => { view = b.dataset.v; ov.querySelectorAll('.eml-viewbar button').forEach((x) => x.style.background = 'transparent'); b.style.background = '#fff'; drawPane(); }); });
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
    card.items.push({ id: genId(), files: picked.map((f) => fileEntryOf(f)) });
    syncToConfig(node); render(node); closeBrowse(); uiToast(ezT('Added ') + picked.length + ezT(' media files'));
  });
  try { navigate(''); } catch (err) { try { const e = el('div'); e.textContent = ezT('Failed to load browser: ') + (err && err.message || err); e.style.cssText = 'color:#c0392b;text-align:center;padding:20px;font-size:13px;'; list.appendChild(e); } catch (_) {} }
}

// ===== 预览模态框 =====
function openPreview(node, item, card) {
  const files = item.files || [];
  if (!files.length) return;
  if (node && node._emlRoot) node._emlRoot.querySelectorAll('audio,video').forEach((a) => { try { a.pause(); } catch (_) {} });   // 打开弹窗时停掉面板里所有播放
  const ov = el('div');
  const stopPv = () => { try { ov.querySelectorAll('audio,video').forEach((a) => { try { a.pause(); } catch (_) {} }); } catch (_) {} };
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:2000;';
  const box = el('div'); box.style.cssText = 'background:#fff;border-radius:12px;width:92vw;max-width:920px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.2);overflow:hidden;';
  box.innerHTML = '<div class="eml-pvhd" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 20px;border-bottom:1px solid #eef1f6;flex-shrink:0;"><span class="eml-pvtt" style="font-size:15px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span><span class="eml-pvmode" style="display:flex;gap:6px;"></span><button class="eml-pvx" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8;">✕</button></div>' +
    '<div class="eml-pvbody" style="flex:1;padding:14px 20px;overflow:auto;display:flex;flex-direction:column;gap:10px;min-height:280px;"><div class="eml-pvmain" style="position:relative;width:100%;max-height:52vh;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:#fff;"></div><div class="eml-pvstripwrap" style="display:flex;align-items:center;gap:6px;flex-shrink:0;"><button class="eml-stripL">‹</button><div class="eml-pvstrip" style="flex:1;display:flex;gap:6px;overflow-x:auto;padding:6px 0;border-top:1px solid #eef1f6;"></div><button class="eml-stripR">›</button></div></div>' +
    '<div class="eml-pvfoot" style="padding:10px 20px;border-top:1px solid #eef1f6;font-size:12px;color:#6b7a8e;display:flex;justify-content:space-between;"></div>';
  ov.appendChild(box); document.body.appendChild(ov);
  const tt = box.querySelector('.eml-pvtt'), mode = box.querySelector('.eml-pvmode'), main = box.querySelector('.eml-pvmain'), strip = box.querySelector('.eml-pvstrip'), foot = box.querySelector('.eml-pvfoot'), stripL = box.querySelector('.eml-stripL'), stripR = box.querySelector('.eml-stripR');
  stripL.style.cssText = stripR.style.cssText = 'background:none;border:none;font-size:22px;color:#94a3b8;cursor:pointer;padding:2px;line-height:1;flex:0 0 auto;';
  let idx = 0; let batch = false; let selSet = new Set();
  const mkArrow = (side) => { const a = el('div'); a.innerHTML = side === 'L' ? '‹' : '›'; a.style.cssText = 'position:absolute;top:0;bottom:0;' + (side === 'L' ? 'left:0' : 'right:0') + ';width:48px;display:flex;align-items:center;justify-content:center;font-size:34px;color:#8a9aa8;text-shadow:0 1px 3px rgba(0,0,0,.12);cursor:pointer;opacity:0;transition:.15s;z-index:5;user-select:none;'; main.appendChild(a); return a; };
  const aL = mkArrow('L'), aR = mkArrow('R');
  main.addEventListener('mouseenter', () => { aL.style.opacity = '1'; aR.style.opacity = '1'; });
  main.addEventListener('mouseleave', () => { aL.style.opacity = '0'; aR.style.opacity = '0'; });
  aL.addEventListener('click', () => { if (files.length > 1) { idx = (idx - 1 + files.length) % files.length; draw(); } });
  aR.addEventListener('click', () => { if (files.length > 1) { idx = (idx + 1) % files.length; draw(); } });
  const prev = () => { if (files.length > 1) idx = (idx - 1 + files.length) % files.length; draw(); };
  const next = () => { if (files.length > 1) idx = (idx + 1) % files.length; draw(); };
  const openLoc = (f) => { try { fetch('/media_loader/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.path }) }); } catch (_) {} };
  const openSave = async (f) => { if (!f) return; try { const d = await fetch('/media_loader/pick_folder', { method: 'POST' }); const j = await d.json(); if (!j.ok || !j.path) { uiToast(j.error || ezT('No folder selected')); return; } const r = await fetch('/media_loader/save_as', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.path, dest: j.path }) }); const res = await r.json(); uiToast(res.ok ? (ezT('Saved as ') + res.dest) : (ezT('Save failed: ') + (res.error || ''))); } catch (_) { uiToast(ezT('Save failed')); } };
  const buildMenu = (e, f, i) => {
    const menu = el('div'); menu.style.cssText = 'position:fixed;z-index:10000;background:#fff;border:1px solid #dce3ec;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.16);padding:4px;min-width:170px;';
    const mk = (label, fn) => { const b = el('button'); b.textContent = label; b.style.cssText = 'display:block;width:100%;text-align:left;background:none;border:none;padding:6px 12px;font-size:12px;color:#1a1f2b;cursor:pointer;border-radius:6px;font-family:inherit;'; b.addEventListener('click', () => { menu.remove(); fn(); }); menu.appendChild(b); };
    const fi = i != null ? i : idx;
    mk(ezT('Split'), () => { const ff = files[fi]; if (!ff) return; if (files.length <= 1) { uiToast(ezT('Only one file; nothing to split')); return; } const splits = [{ id: genId(), files: [ff] }]; files.splice(fi, 1); const i0 = card.items.indexOf(item); if (i0 >= 0) card.items.splice(i0 + 1, 0, ...splits); if (!files.length) card.items = card.items.filter((it) => it !== item); syncToConfig(node); render(node); ov.remove(); });
    mk(ezT('Batch split'), () => { batch = true; selSet = new Set(); renderMode(); draw(); });
    mk(ezT('Open file location'), () => openLoc(f));
    mk(ezT('Save as…'), () => openSave(f));
    document.body.appendChild(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) menu.remove(); };
    document.addEventListener('mousedown', close, { once: true });
    menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px'; menu.style.top = Math.min(e.clientY, window.innerHeight - 200) + 'px';
  };
  const renderMode = () => {
    mode.innerHTML = '';
    const mkBtn = (label, cls, fn) => { const b = el('button'); b.textContent = label; b.className = cls || ''; b.style.cssText = 'background:#f7f9fd;border:1px solid #dce3ec;border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit;'; b.addEventListener('click', fn); mode.appendChild(b); };
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
    const d = files[idx]; if (!d) return;
    const t = d.type || 'other';
    const mk = () => {
      if (t === 'image') { const m = el('img'); m.src = d.url; m.style.cssText = 'max-width:100%;max-height:52vh;object-fit:contain;background:#fff;'; return m; }
      if (t === 'video') { const m = el('video'); m.src = d.url; m.controls = true; m.style.cssText = 'max-width:100%;max-height:52vh;background:#fff;'; return m; }
      if (t === 'audio') { const m = makeAudioPlayer(d.url); m.style.cssText = 'width:100%;max-width:100%;'; return m; }
      if (t === 'model_3d') { const m = el('div'); m.textContent = ezT('🧊 3D model preview'); m.style.cssText = 'font-size:54px;color:#9099a5;'; return m; }
      const m = el('div'); m.style.cssText = 'width:100%;min-height:120px;max-height:52vh;overflow:auto;background:#fff;border-radius:8px;padding:12px 14px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:#1a1f2b;'; m.textContent = ezT('Loading…');
      fetch(fileUrl(d)).then((r) => { if (!r.ok) throw new Error('bad'); return r.text(); }).then((txt) => { if (m.isConnected) m.textContent = (txt || ezT('(empty file)')).slice(0, 60000); }).catch(() => { if (m.isConnected) m.textContent = ezT('Cannot preview content'); });
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
      const th = el('div'); th.style.cssText = 'position:relative;width:56px;height:56px;border-radius:6px;overflow:hidden;cursor:pointer;border:2px solid ' + (sel ? '#34a853' : (i === idx ? '#2b3a4a' : 'transparent')) + ';background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:18px;color:#94a3b8;flex-shrink:0;';
      if (x.type === 'image') { const im = el('img'); im.src = x.url; im.style.cssText = 'width:100%;height:100%;object-fit:cover;'; th.appendChild(im); } else th.textContent = ({ image: '🖼', video: '🎬', audio: '🎵', model_3d: '🧊' })[x.type] || '📄';
      const del = el('button'); del.textContent = '✕'; del.title = ezT('Delete from this card group'); del.style.cssText = 'position:absolute;top:0;right:0;width:16px;height:16px;line-height:16px;font-size:10px;background:rgba(0,0,0,.62);color:#fff;border:none;border-radius:0 5px 0 9px;cursor:pointer;padding:0;';
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
  const keyHandler = (e) => {
    if (!ov.isConnected) { document.removeEventListener('keydown', keyHandler); return; }
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'VIDEO' || ae.tagName === 'AUDIO')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); } else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
  };
  document.addEventListener('keydown', keyHandler);
  renderMode(); draw();
}

// ===== 3D 预览模态框（内联 three.js，复用 /preview_any/3d/libs/）=====
function ext3d(url) {
  try { const u = new URL(url, location.href); const p = u.searchParams.get('path') || u.searchParams.get('filename') || u.pathname; const m = String(p).toLowerCase().match(/\.(gltf|glb|obj|fbx)$/); return m ? m[1] : ''; } catch (_) { return ''; }
}
function open3d(node, item, card) {
  const f = (item.files || [])[0]; if (!f) return;
  const url = f.url || ('/media_loader/serve?path=' + encodeURIComponent(f.path || ''));
  const ov = el('div'); ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,14,20,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:9999;';
  const box = el('div'); box.style.cssText = 'background:#fff;border-radius:14px;padding:12px;width:95%;max-width:1040px;height:86vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 30px 90px rgba(0,0,0,.4);overflow:hidden;';
  const hd = el('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;flex:0 0 auto;';
  const t = el('b'); t.style.cssText = 'font-size:14px;color:#0f141f;'; t.textContent = f.name || ezT('3D model'); hd.appendChild(t);
  const close = el('button'); close.textContent = '✕'; close.title = ezT('Close'); close.style.cssText = 'background:#f1f5f9;border:1px solid #dce3ec;border-radius:10px;width:28px;height:28px;font-size:13px;cursor:pointer;color:#64748b;'; hd.appendChild(close);
  const bodyWrap = el('div'); bodyWrap.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;gap:10px;';
  const body = el('div'); body.style.cssText = 'flex:1 1 auto;position:relative;border-radius:12px;overflow:hidden;background:#f7f9fd;border:1px solid #e6edf7;';
  const canvas = el('canvas'); canvas.tabIndex = 0; canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;outline:none;touch-action:none;cursor:grab;';
  body.appendChild(canvas);
  const panel = el('div'); panel.style.cssText = 'width:170px;flex:0 0 170px;display:flex;flex-direction:column;gap:8px;background:#f8fafc;border:1px solid #e6edf7;border-radius:12px;padding:10px;overflow:auto;font-size:12px;color:#334155;';
  panel.innerHTML = '<div class="pvlbl" style="font-size:11px;font-weight:600;color:#64748b;">' + ezT('Display') + '</div>' +
    '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" class="pvwf"> ' + ezT('Wireframe') + '</label>' +
    '<div class="pvlbl" style="font-size:11px;font-weight:600;color:#64748b;">' + ezT('Material') + '</div><select class="pvmat" style="width:100%;font-size:12px;padding:5px 8px;border:1px solid #dce3ec;border-radius:8px;background:#fff;cursor:pointer;">' +
    '<option value="original">' + ezT('Original') + '</option><option value="clay">' + ezT('Clay') + '</option><option value="glass">' + ezT('Glass') + '</option><option value="plastic">' + ezT('Plastic') + '</option><option value="metal">' + ezT('Metal') + '</option><option value="wire">' + ezT('Wireframe') + '</option></select>' +
    '<div class="pvlbl" style="font-size:11px;font-weight:600;color:#64748b;">' + ezT('Background color') + '</div><input type="color" class="pvbg" value="#f7f9fd" style="width:100%;height:26px;border:1px solid #dce3ec;border-radius:8px;padding:2px;background:#fff;cursor:pointer;">' +
    '<button class="pvreset" style="background:#fff;border:1px solid #dce3ec;border-radius:8px;padding:6px;font-size:12px;cursor:pointer;color:#334155;">' + ezT('Reset view') + '</button>' +
    '<button class="pvshot" style="background:#2b3a4a;border:1px solid #2b3a4a;color:#fff;border-radius:8px;padding:6px;font-size:12px;cursor:pointer;">' + ezT('Generate preview image') + '</button>' +
    '<button class="pvfs" style="background:#fff;border:1px solid #dce3ec;border-radius:8px;padding:6px;font-size:12px;cursor:pointer;color:#334155;">' + ezT('Fullscreen') + '</button>';
  bodyWrap.appendChild(body); bodyWrap.appendChild(panel);
  const status = el('div'); status.style.cssText = 'font-size:12px;color:#64748b;text-align:center;min-height:16px;'; status.textContent = ezT('Loading 3D model…');
  const tip = el('div'); tip.style.cssText = 'font-size:11px;color:#94a3b8;'; tip.textContent = ezT('Left drag = orbit · wheel = zoom · Shift/right drag = pan');
  box.appendChild(hd); box.appendChild(bodyWrap); box.appendChild(status); box.appendChild(tip);
  ov.appendChild(box); document.body.appendChild(ov);
  let cleanup = () => {};
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
      renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600, false);
      const ro = new ResizeObserver(() => { try { renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600, false); camera.aspect = (canvas.clientWidth || 800) / (canvas.clientHeight || 600); camera.updateProjectionMatrix(); } catch (_) {} });
      ro.observe(canvas);
      scene.add(new THREE.AmbientLight(0xffffff, 0.9));
      const dir = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(5, 10, 7); scene.add(dir);
      const ext = ext3d(url);
      let loader;
      if (ext === 'glb' || ext === 'gltf') { const gltf = await import(THREE_BASE + 'GLTFLoader.js'); loader = new gltf.GLTFLoader(); }
      else if (ext === 'fbx') { const fbx = await import(THREE_BASE + 'FBXLoader.js'); loader = new fbx.FBXLoader(); }
      else if (ext === 'obj') { const objs = await import(THREE_BASE + 'OBJLoader.js'); loader = new objs.OBJLoader(); }
      // 只随包带了 GLTF / FBX / OBJ 三个加载器：别的扩展名以前会落到 OBJLoader 里报一堆难懂的错误
      else { throw new Error(ezT('Unsupported 3D format .') + (ext || '?') + ezT(' (only glb / gltf / obj / fbx are supported)')); }
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
        if (EZ_PERF.render3d === 'loop') { const loop = () => { render(); raf = requestAnimationFrame(loop); }; loop(); } else { apply(); }
        const doShot = (silent) => { try { apply(); renderer.render(scene, camera); const u2 = renderer.domElement.toDataURL('image/png'); _mlPreview[item.id] = u2; if (node) render(node); if (!silent) uiToast(ezT('Generated 3D preview image')); } catch (_) { if (!silent) uiToast(ezT('Failed to generate preview')); } };
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
      }, undefined, (err) => { status.textContent = ezT('Load error: ') + (err && err.message || err); });
    } catch (e) { status.textContent = ezT('3D viewer failed to initialize: ') + (e && e.message || e); }
  })();
}

// ===== 动态输出端口（卡片 1:1）=====
function cardList(node) {
  const st = stateFor(node); const out = [];
  st.groups.forEach((g) => g.cards.forEach((c) => out.push({ id: c.id, label: g.name + '_' + c.name })));
  return out;
}
function updatePorts(node, noRedraw) {
  if (!node || !node.outputs) return false;
  const want = cardList(node);
  let changed = false;
  const old = (node.outputs || []).slice();
  const used = new Set(); const seq = [];
  want.forEach((w) => {
    let sock = null;
    for (let i = 0; i < old.length; i++) { if (!used.has(i) && old[i]._ezCardId != null && String(old[i]._ezCardId) === String(w.id)) { sock = old[i]; used.add(i); break; } }
    if (!sock) { for (let i = 0; i < old.length; i++) { if (!used.has(i)) { sock = old[i]; used.add(i); break; } } }
    if (!sock) { node.addOutput(w.label, CARD_TYPE, {}); sock = node.outputs[node.outputs.length - 1]; changed = true; }
    if (sock._ezCardId !== w.id) { sock._ezCardId = w.id; changed = true; }
    if (sock.name !== w.label) { sock.name = w.label; changed = true; }
    if (String(sock.type) !== CARD_TYPE) { try { sock.type = CARD_TYPE; } catch (_) {} changed = true; }
    try { sock.label = ''; sock.hideName = true; sock.hidden = false; sock._ezLabel = w.label; sock.color_on = CARD_COLOR; sock.color_off = CARD_COLOR; sock.color = CARD_COLOR; } catch (_) {}
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
  return changed;
}
function syncOutputTypes(node) {
  const labels = cardList(node).map((x) => x.label);
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
    const cur = (node.outputs || []).map((s, i) => ({ i, name: s._ezLabel || s.name || '', type: s.type })).filter((x) => x.type === CARD_TYPE);
    const s = cur.map((x) => x.i + '|' + x.name).join(';');
    if (s !== sig) { sig = s; all.forEach((x) => { try { x.el.remove(); } catch (_) {} }); all = cur.map((x) => ({ el: mk(x.name), i: x.i })); node._emlOutEls = all.map((x) => x.el); }
  };
  const update = () => {
    const rootEl = node._emlRoot;
    if (!rootEl || !rootEl.isConnected) { return; }
    if (app && app.graph && node.graph !== app.graph) { (node._emlOutEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); node._emlOutEls = []; return; }
    let rect = null; try { rect = rootEl.getBoundingClientRect(); } catch (_) { return; }
    if (!rect || rect.width <= 0) { return; }
    const nodeW0 = (node.size && node.size[0]) || 1; const sx0 = rect.width / nodeW0;
    if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight || sx0 < 0.35) { all.forEach((item) => { item.el.style.display = 'none'; }); return; }
    scan();
    const nodeH = (node.size && node.size[1]) || 1; const sy = rect.height / nodeH;
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
        // 与画布同帧同步更新（不再经过 rAF，避免比画布慢一拍出现「流体感」）
        update();
        pumpFrames();
      };
    scheduleOnRedraw(update);
    onLocaleChange(() => { try { render(node); } catch (_) {} });   // 语言切换即时重画
    schedule();
  }
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
    const widget = node.addDOMWidget(ezT('Media Loader'), nextWidgetType(), root, { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 170, getValue: () => '{}', setValue: () => {} });
    makeDomWidgetHitThrough(widget.element || root);
    try { node.widgets_start_y = 0; } catch (_) {}
    try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
    installResizeHandles(node, root);
    try { node.setSize([MIN_WIDTH + 30, 390]); } catch (_) {}
    hideConfigWidget(node);
    render(node);
    updatePorts(node, true); syncOutputTypes(node);
    installOutsideLabels(node);
    forceShell(node);
    const settle = setInterval(() => { forceShell(node); const a = updatePorts(node, true); installOutsideLabels(node); if (!a) { settle._n = (settle._n || 0) + 1; if (settle._n >= 4) clearInterval(settle); } }, 250);
    let retry = 0; (function retry() { forceShell(node); installOutsideLabels(node); if (retry < 12) { retry += 1; setTimeout(retry, 120); } })();
    setTimeout(() => { try { loadFromConfig(node); render(node); updatePorts(node, true); fitNode(node); } catch (_) {} }, 400);
  } catch (e) { console.error('[MediaLoader] init failed', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__emlHooked) return; nt.__emlHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = prevCfg ? prevCfg.apply(this, arguments) : undefined; loadFromConfig(this); updatePorts(this, true); render(this); return r; };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; try { (this._emlOutEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); this._emlOutEls = []; } catch (_) {} try { if (this._emlRoot) this._emlRoot.remove(); } catch (_) {} this._emlSetup = false; return r; };
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
