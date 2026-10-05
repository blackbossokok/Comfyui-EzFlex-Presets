// EzFlex 循环三节点面板：MergeList / LoopStart / LoopEnd。
// 卡片**跟着输入端口自动增减**（PreviewAny 式：已连的每个口一张卡 + 末尾留一个空槽），不手动加/减。
// 壳/铺满/端口黑框标签照 MediaLoader：forceShell + installEdgeLabels + widgets_start_y=0 + settle/retry。
import { app } from "../../scripts/app.js";
import { NODE_TYPES, nodeTypeOf, installResizeHandles, makeDomWidgetHitThrough, installEdgeLabels, makeAudioPlayer, readConfig, writeConfig, TYPE_ICONS, model3dIcon, ezSanitizeHtml } from "./ezflex_service.js";
import { ezT } from "./ezflex_i18n.js";
import { ezThemeInit } from "./ezflex_theme.js";

const MERGE_LIST = NODE_TYPES.MERGE_LIST;
const LOOP_START = NODE_TYPES.LOOP_START;
const LOOP_END = NODE_TYPES.LOOP_END;
const SPLIT_LIST = NODE_TYPES.SPLIT_LIST;
const TIME_LINE = NODE_TYPES.TIME_LINE;
const MIN_W = 300;
const MAX_SLOT = 16;
const SOCK_COLOR = '#2f8f5b';

const CSS = `
.ezlp-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezlp-shell .ezlp-root{pointer-events:auto;}
.ezlp-root{position:absolute;inset:0 12px 12px 12px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--ez-fg);background:var(--ez-bg);border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-height:0;overflow:hidden;}
.ezlp-root *{box-sizing:border-box;user-select:none;-webkit-user-select:none;}
.ezlp-hd{display:flex;align-items:center;gap:8px;flex:0 0 auto;}
.ezlp-title{font-weight:550;font-size:13px;}
.ezlp-badge{font-size:10px;color:var(--ez-fg-3);background:var(--ez-surface-3);padding:1px 8px;border-radius:100px;}
.ezlp-rows{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:5px;}
.ezlp-ctl{display:flex;align-items:center;gap:6px;flex:0 0 auto;flex-wrap:wrap;}
.ezlp-seg{display:flex;background:var(--ez-surface-3);border-radius:8px;padding:2px;border:1px solid var(--ez-border);}
.ezlp-segbtn{background:transparent;border:none;padding:2px 12px;font-size:11px;color:var(--ez-fg-2);font-family:inherit;cursor:pointer;border-radius:6px;height:24px;line-height:1;}
.ezlp-segbtn.active{background:var(--ez-bg);color:var(--ez-fg);font-weight:510;box-shadow:0 1px 4px rgba(0,0,0,.06);}
.ezlp-lbl{font-size:11px;color:var(--ez-fg-3);white-space:nowrap;}
.ezlp-num{width:52px;height:26px;padding:0 6px;border:1px solid var(--ez-border);border-radius:7px;background:var(--ez-bg);color:var(--ez-fg);font-family:inherit;text-align:center;box-sizing:border-box;appearance:textfield;}
.ezlp-num::-webkit-outer-spin-button,.ezlp-num::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.ezlp-row{display:flex;align-items:center;gap:8px;flex:0 0 auto;background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:9px;padding:6px 10px;}
.ezlp-row .ezlp-lbl{font-weight:510;color:var(--ez-fg-2);}
.ezlp-row .ezlp-num{width:64px;}
.ezlp-row .ezlp-st{margin-left:auto;text-align:right;}
.ezlp-card{position:relative;display:flex;align-items:center;gap:7px;background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:9px;padding:5px 8px;font-size:12px;cursor:pointer;flex-wrap:wrap;}
.ezlp-card:hover{border-color:var(--ez-border-strong);}
.ezlp-card.run{border-color:var(--ez-strong);}
.ezlp-card.off{opacity:.55;}
.ezlp-card.empty{border-style:dashed;color:var(--ez-fg-muted);cursor:default;}
.ezlp-grip{width:14px;color:var(--ez-fg-3);cursor:grab;text-align:center;user-select:none;}
.ezlp-no{min-width:14px;flex:0 0 auto;font-size:10px;color:var(--ez-fg-3);text-align:center;}
.ezlp-card.plain{flex-wrap:nowrap;}
.ezlp-card.plain .ezlp-nm{flex:1 1 auto;min-width:0;text-align:center;padding:0 10px;text-overflow:ellipsis;}
.ezlp-tg{background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:100px;font-size:10px;color:var(--ez-fg-3);cursor:pointer;padding:1px 8px;font-family:inherit;line-height:1.4;}
.ezlp-tg.on{background:var(--ez-ok-bg);border-color:var(--ez-ok-border);color:var(--ez-ok-fg);}
.ezlp-nm{flex:1 1 auto;min-width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;outline:none;}
.ezlp-st{font-size:10px;color:var(--ez-fg-muted);}
.ezlp-fb{font-size:10px;color:var(--ez-info-fg,#3b82f6);border:1px solid currentColor;border-radius:100px;padding:0 6px;}
.ezlp-det{flex:1 1 100%;max-height:150px;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:var(--ez-fg-2);border-top:1px dashed var(--ez-border-2);margin-top:4px;padding-top:4px;}
.ezlp-detline{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ezlp-dragline{height:3px;background:var(--ez-strong);border-radius:2px;flex:0 0 3px;}
.ezlp-menu{position:fixed;z-index:10000;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.16);padding:4px;min-width:180px;}
.ezlp-menu-item{display:block;width:100%;text-align:left;background:none;border:none;padding:6px 12px;font-size:12px;color:var(--ez-fg);cursor:pointer;border-radius:6px;font-family:inherit;}
.ezlp-menu-item:hover{background:var(--ez-surface-3);}
.ezlp-hint{font-size:10px;color:var(--ez-fg-muted);line-height:1.6;flex:0 0 auto;}
/* LoopStart / LoopEnd 的「极简面板」：只有一个居中的数字框（见 setupLoopStart 注释） */
.ezlp-root.ezlp-bare{gap:0;padding-top:9px;}
.ezlp-row.only{justify-content:center;align-self:center;padding:5px 14px;}
.ezlp-row.only .ezlp-num{width:58px;}
/* TimeLine：工具条 / 素材库 / 分段轨道（配色与悬停信息参照 loop.HTML 原型） */
.eztl-tb{display:flex;align-items:center;gap:10px;flex:0 0 auto;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--ez-border-2);}
.eztl-fld{display:inline-flex;align-items:center;gap:6px;}
.eztl-lbl{font-size:11px;color:var(--ez-fg-3);white-space:nowrap;}
.eztl-div{width:1px;height:18px;background:var(--ez-border-2);flex:0 0 auto;}
.eztl-num,.eztl-sel{height:26px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font-family:inherit;font-size:12px;padding:0 6px;outline:none;box-sizing:border-box;}
.eztl-num{width:58px;text-align:center;-moz-appearance:textfield;appearance:textfield;}
.eztl-num::-webkit-outer-spin-button,.eztl-num::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.eztl-sel{cursor:pointer;min-width:104px;}
.eztl-info{width:14px;height:14px;border-radius:50%;background:var(--ez-surface-3);color:var(--ez-fg-muted);font-size:9px;display:inline-flex;align-items:center;justify-content:center;cursor:help;flex:0 0 auto;font-style:italic;}
.eztl-main{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:0;}   /* 上：大预览（可压缩）；下：控件+拼接轨（贴底） */
.eztl-bottom{flex:1 1 0;display:flex;flex-direction:row;min-height:190px;}                 /* 与预览按比例分高度，太矮保底 190 */
/* 没有拖动缝：上下按固定比例随节点缩放 */
.eztl-iconbtn:hover{color:var(--ez-fg);background:var(--ez-surface-3);}

.eztl-sec{margin-bottom:6px;}
.eztl-grp{font-size:10px;color:var(--ez-fg-muted);text-transform:uppercase;letter-spacing:.08em;padding:6px 4px 4px;font-weight:500;}
.eztl-li{display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--ez-bg);border:1px solid var(--ez-border-2);border-radius:6px;cursor:pointer;margin-bottom:4px;}
.eztl-li:hover{background:var(--ez-surface-2);}
.eztl-li.on{border-color:var(--ez-strong);box-shadow:0 0 0 2px var(--ez-strong);}
.eztl-lith{width:30px;height:30px;border-radius:5px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;color:#fff;cursor:pointer;}
.eztl-lith svg{width:15px;height:15px;}
.eztl-lith video{width:100%;height:100%;object-fit:cover;display:block;}
.eztl-liinfo{flex:1 1 auto;min-width:0;}
.eztl-linm{font-size:11px;color:var(--ez-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eztl-lity{font-size:9px;color:var(--ez-fg-muted);font-family:ui-monospace,Menlo,Consolas,monospace;margin-top:2px;letter-spacing:.03em;}
.eztl-tl{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:9px;overflow:hidden;}
.eztl-trow{flex:0 0 auto;min-height:0;display:flex;overflow-x:hidden;overflow-y:auto;}
.eztl-vp{flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;position:relative;align-self:flex-start;}
.eztl-vp::-webkit-scrollbar{height:8px;}
.eztl-vp::-webkit-scrollbar-thumb{background:var(--ez-border-strong);border-radius:4px;}
.eztl-content{position:relative;min-width:100%;}
.eztl-ruler{height:26px;background:var(--ez-surface-2);border-bottom:1px solid var(--ez-border-2);position:relative;cursor:pointer;overflow:hidden;box-sizing:border-box;}
.eztl-tick{position:absolute;top:13px;bottom:0;width:1px;background:var(--ez-fg-3);opacity:.5;}
.eztl-tick.major{top:7px;background:var(--ez-fg-2);opacity:1;}
.eztl-tick span{position:absolute;top:-1px;left:5px;font-size:9.5px;color:var(--ez-fg-3);font-family:ui-monospace,Menlo,Consolas,monospace;white-space:nowrap;pointer-events:none;}
.eztl-lane{position:relative;border-bottom:1px solid var(--ez-border-2);background:var(--ez-bg);box-sizing:border-box;}
.eztl-lane.merge{background:var(--ez-surface-2);}
.eztl-lane.drop{background:var(--ez-surface-3);}
.eztl-mseg{position:absolute;top:5px;bottom:5px;border-radius:4px;overflow:hidden;display:flex;border:1px solid transparent;box-sizing:border-box;cursor:pointer;}
.eztl-mov{height:100%;flex:0 0 auto;}
.eztl-mnet{height:100%;flex:1 1 auto;display:flex;align-items:center;padding:0 8px;overflow:hidden;position:relative;}
.eztl-mlbl{font-size:9.5px;font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--ez-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eztl-mmax{position:absolute;top:2px;right:4px;font-size:8.5px;font-weight:700;color:#c47a1a;background:rgba(196,122,26,.16);padding:0 4px;border-radius:3px;font-family:ui-monospace,monospace;}
.eztl-band{position:absolute;top:0;bottom:0;pointer-events:none;border-left:1px solid transparent;border-right:1px solid transparent;box-sizing:border-box;}
.eztl-segno{position:absolute;top:4px;font-size:9px;font-family:ui-monospace,Menlo,Consolas,monospace;pointer-events:none;opacity:.85;}
.eztl-cell{position:absolute;top:4px;bottom:4px;display:flex;align-items:center;gap:2px;overflow:hidden;box-sizing:border-box;padding:0 2px;}
.eztl-th{width:64px;height:64px;border-radius:6px;flex:0 0 auto;overflow:hidden;background:rgba(255,255,255,.45);border:1px solid var(--ez-border);display:flex;align-items:center;justify-content:center;color:rgba(30,40,55,.8);cursor:pointer;}
.eztl-th img,.eztl-th video{width:100%;height:100%;object-fit:cover;display:block;}
.eztl-th svg{width:14px;height:14px;}
.eztl-th.auto{border-style:dashed;}
.eztl-th.on{border-color:var(--ez-strong);box-shadow:0 0 0 1px var(--ez-strong);}
.eztl-play{position:absolute;top:0;bottom:0;width:1px;background:var(--ez-strong);pointer-events:none;z-index:4;box-shadow:0 0 4px rgba(74,123,239,.4);}
.eztl-play::before{content:'';position:absolute;top:0;left:-5px;width:11px;height:11px;background:var(--ez-strong);clip-path:polygon(0 0,100% 0,50% 100%);}
.eztl-cbar{flex:0 0 auto;display:flex;flex-direction:column;}
.eztl-playbar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:6px 12px;border-top:1px solid var(--ez-border-2);background:var(--ez-surface);}
.eztl-playbtn{width:28px;height:28px;border-radius:6px;border:1px solid var(--ez-border);background:var(--ez-surface-2);color:var(--ez-fg-2);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex:0 0 auto;font-family:inherit;}
.eztl-playbtn:hover{background:var(--ez-surface-3);color:var(--ez-fg);}
.eztl-playbtn.active{background:var(--ez-strong);border-color:var(--ez-strong);color:var(--ez-on-strong);}
.eztl-time{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--ez-fg-3);display:inline-flex;gap:6px;font-variant-numeric:tabular-nums;}
.eztl-time .cur{color:var(--ez-fg);font-weight:500;min-width:52px;text-align:right;}
.eztl-time .tot{min-width:52px;}
.eztl-timeinp,.eztl-zoominp{height:24px;padding:0 6px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;text-align:center;box-sizing:border-box;-moz-appearance:textfield;appearance:textfield;}
.eztl-timeinp{width:64px;}
.eztl-zoominp{width:56px;display:none;}
.eztl-zoominp.on{display:inline-block;}
.eztl-zoompct{display:inline-block;width:56px;height:24px;line-height:22px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ez-fg-muted);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;text-align:center;box-sizing:border-box;cursor:text;user-select:none;}
.eztl-zoompct:hover{color:var(--ez-fg-2);background:var(--ez-surface-2);border-color:var(--ez-border-2);}
.eztl-zoominp::-webkit-outer-spin-button,.eztl-zoominp::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.eztl-timeinp::-webkit-outer-spin-button,.eztl-timeinp::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.eztl-zoombar{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:5px 12px;border-top:1px solid var(--ez-border-2);background:var(--ez-surface);}
.eztl-zoomlbl{font-size:10px;color:var(--ez-fg-muted);font-family:ui-monospace,Menlo,Consolas,monospace;min-width:44px;}
.eztl-zoomlbl.right{text-align:right;min-width:64px;}
.eztl-zoom{flex:1 1 auto;-webkit-appearance:none;appearance:none;height:3px;background:var(--ez-border-2);border-radius:2px;outline:none;cursor:pointer;min-width:60px;}
.eztl-playmode{margin-left:auto;flex:0 0 auto;min-width:104px;}
.eztl-zoom::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;background:var(--ez-strong);border-radius:50%;cursor:pointer;border:2px solid var(--ez-surface);box-shadow:0 0 0 1px var(--ez-border-2);}
.eztl-tip{position:fixed;display:none;background:var(--ez-bg);border:1px solid var(--ez-border-strong);border-radius:8px;padding:8px 12px;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--ez-fg);pointer-events:none;z-index:100000;box-shadow:0 8px 24px rgba(20,30,60,.18);white-space:nowrap;line-height:1.7;}
.eztl-tip strong{color:var(--ez-strong);font-weight:600;}
.eztl-tipdot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:middle;}
/* 大预览区：轨道上方，显示当前选中轨道在播放头处的媒体 */
.eztl-pane{flex:2 1 0;width:100%;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;background:var(--ez-surface-2);border-radius:9px;border:1px solid var(--ez-border-2);overflow:hidden;}
.eztl-pane img{max-width:100%;max-height:100%;border-radius:6px;display:block;background:#000;}
.eztl-pane video{max-width:100%;max-height:100%;border-radius:6px;display:block;background:#000;}
.eztl-pane audio{width:min(520px,92%);}
.eztl-panetag{position:absolute;top:4px;left:8px;max-width:calc(100% - 16px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--ez-fg-3);background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:100px;padding:0 8px;line-height:16px;pointer-events:none;z-index:2;}
.eztl-panehint{font-size:11px;color:var(--ez-fg-muted);}
.eztl-paneth{display:flex;align-items:center;justify-content:center;max-width:100%;max-height:100%;}
/* 素材卡片：每个输入口一张，点开展开分类 */
.eztl-card{border:1px solid var(--ez-border-2);border-radius:8px;margin-bottom:6px;background:var(--ez-bg);overflow:hidden;}
.eztl-cardhd{display:flex;align-items:center;gap:6px;padding:5px 6px;cursor:pointer;}
.eztl-cardhd:hover{background:var(--ez-surface-2);}
.eztl-cardchev{color:var(--ez-fg-3);display:inline-flex;width:12px;justify-content:center;flex:0 0 auto;}
.eztl-cardnm{flex:1 1 auto;min-width:0;font-size:11px;color:var(--ez-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eztl-cardcnt{font-size:9px;color:var(--ez-on-strong);background:var(--ez-strong);border-radius:100px;padding:0 6px;line-height:15px;flex:0 0 auto;}
.eztl-cardall{background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:6px;color:var(--ez-fg-3);font-size:10px;padding:1px 6px;cursor:pointer;font-family:inherit;flex:0 0 auto;}
.eztl-cardall:hover{color:var(--ez-fg);background:var(--ez-surface-3);}
.eztl-cardbd{padding:2px 6px 6px;border-top:1px dashed var(--ez-border-2);}
/* 已经铺到轨道上的素材：绿底 + 勾 */
.eztl-li.placed{background:var(--ez-ok-bg);border-color:var(--ez-ok-border);}
.eztl-li.placed .eztl-linm{color:var(--ez-ok-fg);}
.eztl-li.placed .eztl-lity{color:var(--ez-ok-fg);opacity:.8;}
.eztl-li.placed::after{content:'\\2713';color:var(--ez-ok-fg);font-size:11px;flex:0 0 auto;}
.eztl-li.autoplaced{border-color:var(--ez-ok-border);border-style:dashed;}
/* 轨道栏下面的虚线 +：加一条自定义轨道（不自动铺） */
.eztl-addlane{display:flex;align-items:center;justify-content:center;height:28px;margin:5px 6px;border:1px dashed var(--ez-border-strong);border-radius:7px;color:var(--ez-fg-muted);cursor:pointer;font-size:17px;line-height:1;background:transparent;font-family:inherit;}
.eztl-addlane:hover{color:var(--ez-fg);border-color:var(--ez-strong);background:var(--ez-surface-2);}
.eztl-lanex{background:none;border:none;color:var(--ez-fg-muted);cursor:pointer;padding:0 2px;font-family:inherit;font-size:12px;margin-left:auto;flex:0 0 auto;}
.eztl-lanex:hover{color:var(--ez-warn-fg);}
/* 选中轨道变绿 */
/* 轨道不再画绿色选中框 */

`;
let _css = false;
function inject() { ezThemeInit(); if (_css || !document.head) return; _css = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function el(t, c, a) { const e = document.createElement(t); if (c) e.className = c; if (a) Object.keys(a).forEach((k) => e.setAttribute(k, a[k])); return e; }

function forceShell(node) {
  const p = node && node._ezlpRoot; if (!p || !p.isConnected) return;
  const si = (t, prop, val) => { try { t.style.setProperty(prop, val, 'important'); } catch (_) {} };
  si(p, 'width', '100%'); si(p, 'max-width', '100%'); si(p, 'height', '100%'); si(p, 'max-height', '100%'); si(p, 'box-sizing', 'border-box');
  if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) { si(p, 'top', 'var(--ezfx-vue-title,30px)'); si(p, 'height', 'calc(100% - var(--ezfx-vue-title,30px))'); si(p, 'bottom', 'auto'); }
}
function sockStyle(node) {
  (node.outputs || []).forEach((s) => { try { s.color_on = SOCK_COLOR; s.color_off = SOCK_COLOR; s.color = SOCK_COLOR; } catch (_) {} });
  (node.inputs || []).forEach((s) => { try { s.color_on = SOCK_COLOR; s.color_off = SOCK_COLOR; s.color = SOCK_COLOR; } catch (_) {} });
}
function stripCoreSockets(node) {
  // TimeLine / LoopStart 的 index 是固定输入口（接 LoopStart.index），别当普通 widget 输入口摘掉；
  // LoopEnd 的 rounds 也不能摘（后端把它放在 required，就是靠它做输入口 + 序列化落点）
  const t = nodeTypeOf(node);
  const keepIndex = (t === TIME_LINE || t === LOOP_START);
  const keepRounds = (t === LOOP_END);
  try {
    const ins = node.inputs || [];
    for (let i = ins.length - 1; i >= 0; i--) {
      const s = ins[i];
      if (!s) continue;
      // ★ _ezfeedK 是「上一轮回喂值」的内部落点（后端 optional 声明，必须声明否则值被丢）。
      //   它不是画布端口：一律摘掉，别让用户看到/连上（连了就会跟隐式回喂冲突）。
      if (s.name === 'config' || s.name === '__ezround' || /^_ezfeed\d+$/.test(s.name)
          || (s.name === 'index' && !keepIndex) || (s.name === 'rounds' && !keepRounds)) {
        try { node.removeInput(i); } catch (_) { try { ins.splice(i, 1); } catch (_2) {} }
      }
    }
  } catch (_) {}
}
function hideConfigWidget(node) {
  stripCoreSockets(node);
  if (node._ezlpCfgHid) return;
  node._ezlpCfgHid = true;
  // ★ 只藏 config。index / rounds 的值面板要用（LoopStart 的起始轮次、LoopEnd 的次数），
  //   藏了它们就读不到；它们的显示由面板自己盖住。
  (node.widgets || []).forEach((w) => {
    if (!w || w.name !== 'config') return;
    try { w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0; w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true; w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0; if (w.element && w.element.style) { w.element.style.display = 'none'; w.element.style.height = '0'; } } catch (_) {}
  });
}
function mount(node, title, build, opts) {
  if (!node || node._ezlpSetup) return;
  node._ezlpSetup = true;
  inject();
  const shell = el('div', 'ezlp-shell'); const root = el('div', 'ezlp-root'); shell.appendChild(root);
  node._ezlpRoot = shell;
  // opts.bare：不要标题行 / 徽标（LoopStart · LoopEnd 的极简面板只要一个数字框）
  const bare = !!(opts && opts.bare);
  if (bare) root.classList.add('ezlp-bare');
  const hd = el('div', 'ezlp-hd'); const t = el('span', 'ezlp-title'); t.textContent = title; hd.appendChild(t);
  const badge = el('span', 'ezlp-badge'); hd.appendChild(badge);
  if (bare) hd.style.display = 'none'; else root.appendChild(hd);
  build(root, badge);
  const widget = node.addDOMWidget(title, 'ezlp__' + Math.random().toString(36).slice(2), shell,
    { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => 120, getValue: () => '{}', setValue: () => {} });
  makeDomWidgetHitThrough(widget.element || shell);
  try { node.widgets_start_y = 0; } catch (_) {}
  try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
  installResizeHandles(node, shell);
  try { node.setSize([MIN_W, 170]); } catch (_) {}
  hideConfigWidget(node);
  forceShell(node);
  let retry = 0; (function again() { forceShell(node); if (retry < 12) { retry += 1; setTimeout(again, 120); } })();
}
// ===== 端口 <-> 卡片 =====
function slotsOf(node, re) {
  const ins = node.inputs || [];
  const conn = []; let firstEmpty = -1;
  for (let i = 0; i < ins.length; i++) {
    if (!re.test(ins[i].name)) continue;
    if (ins[i].link != null) conn.push(i); else if (firstEmpty < 0) firstEmpty = i;
  }
  return { conn, firstEmpty };
}
function notifyOut(node) {
  const g = node.graph; if (!g || !g.links) return;
  (node.outputs || []).forEach((o) => {
    const ids = []; if (Array.isArray(o.links)) ids.push(...o.links); if (o.link != null) ids.push(o.link);
    ids.forEach((lid) => {
      const lk = g.links[lid]; if (!lk) return;
      const t = (g.getNodeById ? g.getNodeById(lk.target_id) : null) || ((g._nodes || []).find((n) => n && String(n.id) === String(lk.target_id)));
      if (!t) return;
      if (typeof t._ezMediaOutUpdate === 'function') { try { t._ezMediaOutUpdate(); } catch (_) {} }
      else if (typeof t._ezlpUpdate === 'function') { try { t._ezlpUpdate(); } catch (_) {} }
    });
  });
}
function upstreamLabel(node, slot) {
  try {
    const inp = (node.inputs || [])[slot]; if (!inp || inp.link == null) return '';
    const g = node.graph; const lk = g && g.links ? g.links[inp.link] : null; if (!lk) return '';
    const origin = (g.getNodeById ? g.getNodeById(lk.origin_id) : null) || ((g._nodes || []).find((n) => n && String(n.id) === String(lk.origin_id)));
    const sock = origin && origin.outputs ? origin.outputs[lk.origin_slot] : null;
    // ⚠️ 面板为了关掉「自带端口名文字」会把 label 设成空格（见 ezflex_service.hideNativeSlotText），
    //    空格是 truthy —— 直接 `sock.label || sock.name` 会拿到空白，把 TimeLine 的输入卡片名弄空。
    //    所以：① 先看面板自画名 _ezLabel；② label 必须 trim 后非空才算数。
    const lab = sock && (sock._ezLabel || sock.label);
    return ((lab && String(lab).trim()) ? lab : (sock && sock.name))
      || (origin && (origin.title || origin.type)) || '';
  } catch (_) { return ''; }
}
function upstreamTitle(node, slot) {
  try {
    const inp = (node.inputs || [])[slot]; if (!inp || inp.link == null) return '';
    const g = node.graph; const lk = g && g.links ? g.links[inp.link] : null; if (!lk) return '';
    const origin = (g.getNodeById ? g.getNodeById(lk.origin_id) : null) || ((g._nodes || []).find((n) => n && String(n.id) === String(lk.origin_id)));
    return origin ? (origin.title || origin.type || '') : '';
  } catch (_) { return ''; }
}
// ===== MergeList：输入口跟着连线自动增/减（末尾永远留一个空）=====
// ★★ 拼接顺序 = **从上到下的端口顺序**（后端按 prompt 的键顺序拼，而键顺序就是端口数组顺序）。
//    所以这里必须让**名字顺序 == 上下顺序**：面板会回收空口、再补一个「最小空闲编号」的新口，
//    这会让名字顺序和上下顺序错位（用户在下面那口接的线其实叫 input_1 ⇒ 合并时排在最前）。
//    做法：把已连口按数组顺序重命名为 input_1..n（先临时名再落最终名，避免中途撞名）。
function renumberMergeInputs(node) {
  try {
    const re = /^input_\d+$/;
    const list = (node.inputs || []).filter((s) => s && re.test(s.name));
    if (list.length < 2) return;      // 只有一口不用动（名字已经是 input_1 或即将被补成 input_1）
    let changed = false;
    list.forEach((s, k) => { if (s.name !== 'input_' + (k + 1)) changed = true; });
    if (!changed) return;
    list.forEach((s, k) => { s.name = '__ezmg' + (k + 1); });
    list.forEach((s, k) => { s.name = 'input_' + (k + 1); });
  } catch (_) {}
}
function syncMergeInputs(node) {
  stripCoreSockets(node);
  const re = /^input_\d+$/;
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) { const s = node.inputs[i]; if (re.test(s.name) && s.link == null) node.removeInput(i); }   // 断中间也回收
  const have = new Set((node.inputs || []).filter((s) => re.test(s.name)).map((s) => (parseInt(s.name.replace(/\D/g, ''), 10) || 0)));
  const conn = have.size;
  if (conn < MAX_SLOT) { for (let n = 1; n <= MAX_SLOT; n++) { if (!have.has(n)) { node.addInput('input_' + n, '*'); break; } } }   // 只补一个空位
  renumberMergeInputs(node);   // ★ 名字顺序 == 上下顺序（见 renumberMergeInputs 注释）
  sockStyle(node);
}
function cardRow(node, slot, opts) {
  const r = el('div', 'ezlp-card' + (opts.cls || ''));
  const no = el('span', 'ezlp-no'); no.textContent = String(opts.no); r.appendChild(no);
  const nm = el('span', 'ezlp-nm'); nm.textContent = opts.name; r.appendChild(nm);
  return { row: r };
}
// ===== MergeList 面板 =====
function setupMergeList(node) {
  mount(node, ezT('Merge List'), (root, badge) => {
    // ★ 用户踩过「顺序反了」：明确写出拼接顺序，别让人猜
    const hint = el('div', 'ezlp-hint'); hint.textContent = ezT('merged in port order · the top port comes first');
    root.appendChild(hint);
    const rows = el('div', 'ezlp-rows'); root.appendChild(rows);
    const render = () => {
      syncMergeInputs(node);
      const { conn } = slotsOf(node, /^input_\d+$/);
      const all = [];
      conn.forEach((slot) => { const its = tlSlotItems(node, slot); if (its) its.forEach((it) => all.push(it)); });
      if (node.outputs && node.outputs[0]) node.outputs[0]._ezItems = all;
      notifyOut(node);
      rows.innerHTML = '';
      conn.forEach((slot, k) => {
        const { row } = cardRow(node, slot, { no: k + 1, name: upstreamLabel(node, slot) || (node.inputs[slot] ? node.inputs[slot].name : ''), cls: ' plain', noDet: true });
        rows.appendChild(row);
      });
      badge.textContent = conn.length + ' ' + ezT('inputs');
    };
    node._ezlpUpdate = render;
    render();
  });
  sockStyle(node);
  installEdgeLabels(node, { side: 'in', rootOf: (n) => n._ezlpRoot, labelOf: (s) => {
    if (!s || s.link == null) return '';   // 没卡片就不画黑框
    const on = (node.inputs || []).filter((x) => /^input_\d+$/.test(x.name) && x.link != null);
    const k = on.indexOf(s);
    return k >= 0 ? String(k + 1) : '';
  } });
}
// ===== LoopStart / LoopEnd：两个数字框 + 动态 valueN 口 =====
// 新契约（2026-10-04 重做）：
//   LoopStart 面板只有一个 index 框（本次从第几轮开始，默认 0；运行期每轮 +1）
//            输出：固定 index（INT）排第一 + value1 / value2 / …（动态，连一个加一个）
//   LoopEnd   面板只有一个「次数」框（总轮数：0=不循环，1=再点一次，…）
//            输入：value1 / value2 / …（动态，与 Start 的一一对应）
// ★ 回喂是**隐式**的：End 每个输入口收到什么，下一轮 Start 同编号口就输出什么。画布上不要连
//   End → Start：那会成环（内核唯一的环抛点在 comfy_execution/graph.py:303），一提交就报
//   "Dependency cycle detected"（校验期不做环检测）。
const LOOP_MAX_SLOT = 20;

// ---- 原生 widget 的读写 / 收起 ----
function widgetOf(node, name) { return (node.widgets || []).find((w) => w && w.name === name) || null; }
function numFrom(v, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, n) : dflt; }

// 把原生 widget 藏起来（值仍然序列化、仍然能读能写）。
// 只碰指定名字，不能复用 hideConfigWidget —— 那个会把 index 一起藏了。
function hideOneWidget(node, name) {
  const w = widgetOf(node, name);
  if (!w) return;
  try {
    w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0;
    w.draw = () => {}; w.hidden = true;
    w.options = w.options || {};
    w.options.hidden = true; w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
    if (w.element && w.element.style) {
      w.element.style.display = 'none';
      w.element.style.height = '0'; w.element.style.minHeight = '0'; w.element.style.maxHeight = '0';
    }
  } catch (_) {}
}
// 输入口上的原生 widget 关联（老工作流把 index / rounds 存成「widget 转输入」）要摘掉，否则口上叠控件
function stripInputWidgets(node, names) {
  try {
    (node.inputs || []).forEach((s) => { if (s && names.indexOf(s.name) >= 0 && s.widget) s.widget = null; });
  } catch (_) {}
}

function indexWidget(node) { return widgetOf(node, 'index'); }
function startRound(node) {
  const w = indexWidget(node);
  const v = w ? numFrom(w.value, NaN) : NaN;
  if (Number.isFinite(v)) return v;
  const d = readConfig(node) || {};
  return numFrom(d.start, 0);
}
function setStartRound(node, v) {
  const n = Math.max(0, parseInt(v, 10) || 0);
  const w = indexWidget(node);
  if (w) { w.value = n; try { w.callback && w.callback(n); } catch (_) {} }
  const d = readConfig(node) || {}; d.start = n; writeConfig(node, d);
  return n;
}
function roundsOf(node) {
  const w = widgetOf(node, 'rounds');
  const v = w ? numFrom(w.value, NaN) : NaN;
  if (Number.isFinite(v)) return v;
  const d = readConfig(node) || {};
  return numFrom(d.rounds, 1);
}
function setRounds(node, v) {
  const n = Math.max(0, parseInt(v, 10) || 0);
  const w = widgetOf(node, 'rounds');
  if (w) { w.value = n; try { w.callback && w.callback(n); } catch (_) {} }
  const d = readConfig(node) || {}; d.rounds = n; writeConfig(node, d);
  return n;
}

// 循环总轮数：看同一个 prompt 里 End 的「次数」。Start 的徽标用它显示 n / N。
function loopTotalRounds(node) {
  const g = node.graph;
  if (g && g._nodes) {
    const ends = g._nodes.filter((n) => n && nodeTypeOf(n) === LOOP_END);
    if (ends.length === 1) return roundsOf(ends[0]);
    if (ends.length > 1) {   // 多个循环同时在图上：只显示最小的那个（保守，别把轮数说大）
      return Math.min.apply(null, ends.map((n) => roundsOf(n)));
    }
  }
  return 0;
}

function numberedSlots(node, re, side) {
  const arr = ((side === 'in' ? node.inputs : node.outputs) || []).filter((s) => s && re.test(s.name));
  const nums = arr.map((s) => parseInt(String(s.name).replace(/\D/g, ''), 10) || 0);
  return { arr, nums };
}
// 初值口（Start 输入侧）：后端也声明了 20 个，前端按 value 口数量裁。
// 保留「已连的」+ 到 want 号为止的落脚位；比 want 大又没连的删掉。
function trimInitSockets(node, want) {
  const maxN = LOOP_MAX_SLOT;
  want = Math.min(maxN, Math.max(1, want || 1));
  const linkMax = (() => {
    const { arr, nums } = numberedSlots(node, /^initial value\d+$/, 'in');
    let m = want;
    nums.forEach((n, k) => { if (sockLinked(arr[k])) m = Math.max(m, n); });
    return Math.min(maxN, m);
  })();
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    const s = node.inputs[i];
    const n = parseInt(String(s && s.name).replace(/\D/g, ''), 10) || 0;
    if (/^initial value\d+$/.test(s.name) && !sockLinked(s) && n > linkMax) node.removeInput(i);
  }
  const have = new Set(numberedSlots(node, /^initial value\d+$/, 'in').nums);
  for (let n = 1; n <= linkMax && have.size < linkMax; n++) { if (!have.has(n)) { node.addInput('initial value' + n, '*'); have.add(n); } }
}
function sockLinked(s) { return !!(s && (s.link != null || (Array.isArray(s.links) && s.links.length))); }
function oname(s) { return String((s && s.name) || ''); }

// 口顺序/数量变了要回写连线槽位（内核按槽位取值，不回写就会把数据当成别的口）
function reindexLinks(node, side) {
  const links = node.graph && node.graph.links;
  if (!links) return;
  if (side !== 'out') {
    (node.inputs || []).forEach((s, i) => {
      const lid = s && s.link;
      if (lid != null && links[lid]) { try { links[lid].target_slot = i; } catch (_) {} }
    });
  }
  if (side !== 'in') {
    (node.outputs || []).forEach((o, i) => {
      try { o.slot_index = i; } catch (_) {}
      const ids = []; if (o && Array.isArray(o.links)) ids.push(...o.links); if (o && o.link != null) ids.push(o.link);
      ids.forEach((lid) => { if (links[lid]) { try { links[lid].origin_slot = i; } catch (_) {} } });
    });
  }
}

// 旧工作流迁移 → 新端口名。能沿用的连线尽量保（card0 / product0 → value1，out0/prev → out1），
// flow / total / loop_in / loop_out / loop_product 这些没有对应关系的口，把线收掉再删口。
function migrateLoopSockets(node) {
  const start = nodeTypeOf(node) === LOOP_START;
  const g = node.graph;
  const killLink = (lid) => {
    if (lid == null || !g || !g.links) return;
    const lk = g.links[lid];
    if (lk) {
      try {
        const on = g.getNodeById ? g.getNodeById(lk.origin_id) : null;
        const tn = g.getNodeById ? g.getNodeById(lk.target_id) : null;
        if (on && on.outputs && on.outputs[lk.origin_slot] && Array.isArray(on.outputs[lk.origin_slot].links)) {
          const i = on.outputs[lk.origin_slot].links.indexOf(lid);
          if (i >= 0) on.outputs[lk.origin_slot].links.splice(i, 1);
        }
        if (tn && tn.inputs && tn.inputs[lk.target_slot] && tn.inputs[lk.target_slot].link == lid) tn.inputs[lk.target_slot].link = null;
      } catch (_) {}
    }
    delete g.links[lid];
  };
  const dropSlot = (s, arr, i) => {
    [s.link, ...(Array.isArray(s.links) ? s.links : [])].forEach(killLink);
    s.link = null; s.links = []; s.widget = null;
    if (start) node.removeOutput(i); else node.removeInput(i);
  };
  const arr = (start ? (node.outputs || []) : (node.inputs || [])).slice();
  // ① 先按名映射（顺序别动，等重名清完再统一排）
  arr.forEach((s) => {
    if (!s) return;
    const m = /^card(\d+)$/.exec(s.name) || /^product(\d+)$/.exec(s.name);
    if (m) { s.name = 'value' + (parseInt(m[1], 10) + 1); return; }
    if (s.name === 'loop_out' || s.name === 'loop_in' || s.name === 'loop_product' || s.name === 'loop_from') { s.name = 'value1'; return; }
    if (s.name === 'prev') { s.name = 'out1'; return; }
    if (s.name === 'flow') { s.name = '__ezdrop'; return; }   // 新契约没有 flow 口，回喂是隐式的
    if (s.name === 'total') { s.name = '__ezdrop'; return; }
    if (s.name === 'rounds' && !start) { s.name = '__ezdrop'; return; }   // 次数挪到面板（widget 还在，别删 widget）
  });
  // ② 重名 / 该删的，从后往前清（removeInput/removeOutput 会自己修后续 slot）
  const seen = new Set();
  const live = (start ? (node.outputs || []) : (node.inputs || [])).slice();
  for (let i = live.length - 1; i >= 0; i--) {
    const s = live[i];
    if (!s) continue;
    if (s.name === '__ezdrop' || (s.name === 'index' && !start)) { dropSlot(s, live, i); continue; }
    if (s.name === 'index' && start) continue;
    if (/^value\d+$/.test(s.name)) {
      const n = parseInt(s.name.replace(/\D/g, ''), 10) || 0;
      if (!n || seen.has(n)) { dropSlot(s, live, i); continue; }
      seen.add(n); continue;
    }
    if (!start && /^out\d+$/.test(s.name)) continue;   // End 的 outN 保留
  }
  // ③ Start 补 index 输出（必须排第一，后面 trim 会挪）
  if (start && !(node.outputs || []).some((s) => s && s.name === 'index')) node.addOutput('index', 'INT');
}

// 动态口增减（连一个加一个）。
// Start 输出：value 口要够「已连最大编号 + 1」（下一个空位）；index 恒定排第一。
// End   输入：value 口只要「已连最大编号 + 1」（下一个空位）。
// ★ 后端 INPUT_TYPES 里一口气声明了 20 个 valueN（为了让任意编号都能接），前端必须把没连的那些**删掉**，
//   否则 20 个口全画出来 = 看起来完全不是动态口。这条是「LoopEnd 不是动态输入端口」的根因。
function trimLoopSockets(node) {
  const start = nodeTypeOf(node) === LOOP_START;
  const maxN = LOOP_MAX_SLOT;
  if (start) {
    const outs = node.outputs || [];
    const ix = outs.findIndex((s) => s && s.name === 'index');
    if (ix > 0) { outs.unshift(outs.splice(ix, 1)[0]); reindexLinks(node, 'out'); }
    const { arr, nums } = numberedSlots(node, /^value\d+$/, 'out');
    const used = nums.filter((n, k) => sockLinked(arr[k]));
    const want = Math.min(maxN, Math.max(1, (used.length ? Math.max.apply(null, used) : 0) + 1));
    for (let i = (node.outputs || []).length - 1; i >= 0; i--) {
      const s = node.outputs[i];
      const n = parseInt(String(s && s.name).replace(/\D/g, ''), 10) || 0;
      if (/^value\d+$/.test(s.name) && !sockLinked(s) && n > want) node.removeOutput(i);
    }
    const have = new Set(numberedSlots(node, /^value\d+$/, 'out').nums);
    for (let n = 1; n <= maxN && have.size < want; n++) { if (!have.has(n)) { node.addOutput('value' + n, '*'); have.add(n); } }
    // 初值口：和 value 口同进同退（valueN 有几个，就给几个 initial valueN 的落脚点）
    trimInitSockets(node, have.size);
  } else {
    const { arr, nums } = numberedSlots(node, /^value\d+$/, 'in');
    let want = 1;
    nums.forEach((n, k) => { if (sockLinked(arr[k])) want = Math.max(want, n + 1); });
    want = Math.min(maxN, want);
    for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
      const s = node.inputs[i];
      const n = parseInt(String(s && s.name).replace(/\D/g, ''), 10) || 0;
      if (/^value\d+$/.test(s.name) && !sockLinked(s) && n > want) node.removeInput(i);
    }
    const have = new Set(numberedSlots(node, /^value\d+$/, 'in').nums);
    for (let n = 1; n <= maxN && have.size < want; n++) { if (!have.has(n)) { node.addInput('value' + n, '*'); have.add(n); } }
    // ★ 输出侧 outN：后端 RETURN_TYPES 声明了 20 个，前端必须裁 ——
    //   否则画面上挂 20 个 out1..out20 的尾巴，用户根本不知道哪个有用（他问的就是这个）。
    //   规则：留「已连最大编号 + 1」个（与 value 口一致），收到最后一个收尾用的那根线即可。
    const { arr: oarr, nums: onums } = numberedSlots(node, /^out\d+$/, 'out');
    const oused = onums.filter((n, k) => sockLinked(oarr[k]));
    const owant = Math.min(maxN, Math.max(1, (oused.length ? Math.max.apply(null, oused) : 0) + 1));
    for (let i = (node.outputs || []).length - 1; i >= 0; i--) {
      const s = node.outputs[i];
      const n = parseInt(String(s && s.name).replace(/\D/g, ''), 10) || 0;
      if (/^out\d+$/.test(s.name) && !sockLinked(s) && n > owant) node.removeOutput(i);
    }
    const ohave = new Set(numberedSlots(node, /^out\d+$/, 'out').nums);
    for (let n = 1; n <= maxN && ohave.size < owant; n++) { if (!ohave.has(n)) { node.addOutput('out' + n, '*'); ohave.add(n); } }
  }
  sortLoopSockets(node, start);
  stripCoreSockets(node);
  stripInputWidgets(node, start ? ['index'] : ['rounds']);
  reindexLinks(node, 'both');
  sockStyle(node);
}

// 端口排顺：迁移过来的口顺序是乱的（product1 可能排在 product0 前面）。
// 规则：Start 侧 index → value1..N → initial value1..N；End 侧 value1..N → 其它保留口。
// ★ 重排后必须 reindexLinks，否则内核按槽位取值会张冠李戴。
function sortLoopSockets(node, start) {
  const key = (s) => {
    const n = String((s && s.name) || '');
    if (n === 'index') return [0, 0];
    if (n === 'rounds') return [9, 0];
    let m = /^value(\d+)$/.exec(n);
    if (m) return [1, parseInt(m[1], 10) || 0];
    m = /^initial value(\d+)$/.exec(n);
    if (m) return [2, parseInt(m[1], 10) || 0];
    m = /^out(\d+)$/.exec(n);
    if (m) return [3, parseInt(m[1], 10) || 0];
    return [8, 0];   // 其它（保留口）排最后
  };
  const seq = (arr) => (arr || []).map((s, i) => ({ s, i })).sort((a, b) => {
    const ka = key(a.s); const kb = key(b.s);
    return ka[0] !== kb[0] ? ka[0] - kb[0] : (ka[1] !== kb[1] ? ka[1] - kb[1] : a.i - b.i);
  }).map((x) => x.s);
  if (start) node.outputs = seq(node.outputs);
  else node.inputs = seq(node.inputs);
}

// 端口黑框标签：**照端口名原样显示**（value1 / value2 / out1 / initial value1），不要缩成 1 / 2。
// 用户明确要求：「黑框标签里应该是 value1、value2……而不是 1、2……」
// 只有旧工作流迁移没覆盖到的口才回落空串（不画标签）。
function portLabel(s) {
  if (!s) return '';
  const n = String(s.name || '');
  if (n === 'index' || n === 'rounds') return n;
  if (/^(initial value|value|out)\d+$/.test(n)) return n;
  return '';
}

// ---- 面板行：一个数字框 ----
function numRow(label, value, note, onSet) {
  const box = el('div', 'ezlp-row');
  const lb = el('span', 'ezlp-lbl'); lb.textContent = label;
  const inp = el('input', 'ezlp-num'); inp.type = 'number'; inp.min = '0'; inp.value = String(value);
  const nt = el('span', 'ezlp-st'); nt.textContent = note;
  const fire = () => { onSet(parseInt(inp.value, 10) || 0); };
  inp.addEventListener('change', fire);
  inp.addEventListener('blur', fire);
  box.appendChild(lb); box.appendChild(inp); box.appendChild(nt);
  return { box, inp, note: nt };
}
function slotRows(rows, node, side, noteEmpty) {
  const { arr, nums } = numberedSlots(node, /^value\d+$/, side);
  rows.innerHTML = '';
  arr.forEach((s, k) => {
    const n = nums[k];
    const up = side === 'in' ? upstreamTitle(node, (node.inputs || []).indexOf(s)) : '';
    const on = sockLinked(s);
    const { row } = cardRow(node, -1, {
      no: n,
      name: oname(s) + (on ? (up ? '   ←  ' + up : '   ●') : '   ' + ezT(noteEmpty)),
      noDet: true,
      cls: on ? ' run' : ' empty',
    });
    rows.appendChild(row);
  });
  if (!arr.length) {
    const { row } = cardRow(node, -1, { no: '—', name: ezT('(no slot yet)'), noDet: true, cls: ' empty' });
    rows.appendChild(row);
  }
}

// ===== LoopStart 面板：只有一个 index 框 =====
// ★ 不画卡片行：端口黑框上已经写着 index / value1 / value2…，面板里再列一遍是重复信息（用户要求删掉）。
//   端口增减照旧由 trimLoopSockets 在 render 里做，与面板 DOM 无关。
// ★★ 极简面板（用户要求）：**只有一个居中的数字框** —— 没有标题行、没有徽标、没有「数据口跟着连线走」
//    这类提示文字。动态口的增删照旧（`trimLoopSockets` 是功能不是显示），端口黑框标签也照旧。
//    LoopStart 的框是 index（起始轮次），LoopEnd 的框是「次数」（总轮数）。
function setupLoopStart(node) {
  migrateLoopSockets(node);
  stripInputWidgets(node, ['index']);
  mount(node, ezT('Loop Start'), (root) => {
    const render = () => {
      const { box, note } = numRow('index', startRound(node), '', (v) => { setStartRound(node, v); paint(); });
      box.classList.add('only');
      if (note && note.remove) note.remove();     // ⚠️ 别用 querySelector（测试的极简 DOM 没实现）
      root.innerHTML = ''; root.appendChild(box);
      trimLoopSockets(node);
    };
    const paint = () => { try { render(); } catch (_) {} };
    node._ezlpUpdate = render;
    render();
  }, { bare: true });
  sockStyle(node);
  installEdgeLabels(node, { side: 'both', rootOf: (n) => n._ezlpRoot, labelOf: (s) => portLabel(s) });
}

// ===== LoopEnd 面板：只有一个「次数」框 =====
// ★ 同样不画卡片行、不画标题/徽标/提示（见 setupLoopStart 注释）。端口动态增减仍在 render 里。
function setupLoopEnd(node) {
  migrateLoopSockets(node);
  hideOneWidget(node, 'rounds');
  hideOneWidget(node, '__ezround');   // 内部轮次标记：不是给用户看的（后端已改成 forceInput，这里兜老工作流/已加载的图）
  mount(node, ezT('Loop End'), (root) => {
    const render = () => {
      const { box, note } = numRow(ezT('Rounds'), roundsOf(node), '', (v) => { setRounds(node, v); paint(); });
      box.classList.add('only');
      if (note && note.remove) note.remove();     // ⚠️ 别用 querySelector（测试的极简 DOM 没实现）
      root.innerHTML = ''; root.appendChild(box);
      trimLoopSockets(node);
      hideOneWidget(node, 'rounds');
      hideOneWidget(node, '__ezround');
      // ★ 把 valueK 入口上的「媒体项」（_ezItems：MediaOut / MergeList / SplitList 会盖章）镜像到
      //   对应的 outK 出口上 —— 下游 TimeLine 的 video 口读的正是**上游 socket 的 _ezItems**，
      //   不镜像的话接到 LoopEnd 上预览是空的。
      const outs = node.outputs || [];
      outs.forEach((o) => { if (o) o._ezItems = []; });
      (node.inputs || []).forEach((s, slot) => {
        const m = /^value(\d+)$/.exec(s && s.name ? s.name : '');
        if (!m) return;
        const k = parseInt(m[1], 10) - 1;
        if (k < 0 || k >= outs.length || !outs[k]) return;
        const its = tlSlotItems(node, slot);
        if (its && its.length) outs[k]._ezItems = its;
      });
      notifyOut(node);
    };
    const paint = () => { try { render(); } catch (_) {} };
    node._ezlpUpdate = render;
    render();
  }, { bare: true });
  sockStyle(node);
  installEdgeLabels(node, { side: 'both', rootOf: (n) => n._ezlpRoot, labelOf: (s) => portLabel(s) });
}

// ===== SplitList 面板：把一份 list 拆成 N 个输出口 =====
function listInputItems(node) {
  try {
    const inp = (node.inputs || []).find((s) => s.name === 'list'); if (!inp || inp.link == null) return null;
    const g = node.graph; const lk = g && g.links ? g.links[inp.link] : null; if (!lk) return null;
    const origin = (g.getNodeById ? g.getNodeById(lk.origin_id) : null) || ((g._nodes || []).find((n) => n && String(n.id) === String(lk.origin_id)));
    const sock = origin && origin.outputs ? origin.outputs[lk.origin_slot] : null;
    return (sock && Array.isArray(sock._ezItems)) ? sock._ezItems : null;
  } catch (_) { return null; }
}
function trimSplitListSockets(node, count) {
  stripCoreSockets(node);
  const re = /^item\d+$/;
  const num = (s) => (parseInt(String(s.name).replace(/\D/g, ''), 10) || 0);
  for (let i = (node.outputs || []).length - 1; i >= 0; i--) { const s = node.outputs[i]; const linked = (s.link != null || (Array.isArray(s.links) && s.links.length)); if (re.test(s.name) && !linked && num(s) >= count) node.removeOutput(i); }
  const have = new Set((node.outputs || []).filter((s) => re.test(s.name)).map(num));
  let need = count - have.size;
  for (let n = 0; n < MAX_SLOT && need > 0; n++) { if (!have.has(n)) { node.addOutput('item' + n, '*'); need -= 1; } }
  sockStyle(node);
}
function setupSplitList(node) {
  mount(node, ezT('Split List'), (root, badge) => {
    const rows = el('div', 'ezlp-rows'); root.appendChild(rows);
    const render = () => {
      const up = listInputItems(node);
      const linkedOut = (node.outputs || []).filter((s) => /^item\d+$/.test(s.name) && (s.link != null || (Array.isArray(s.links) && s.links.length))).length;
      // 口：始终留至少 1 个空位（不然没得连），上游列表已知就按它开。
      const cnt = Math.min(MAX_SLOT, Math.max(1, up ? up.length : 0, linkedOut + 1));
      // 项：= 已知的项 ∪ 已接出去的口 ∪ （输入接着但项未知时的 1 个）。空位（还没连线的那个口）不是项：
      // 没连输入时项数跟着已接的输出口走；纯字符串链路（MergeList / 内置多行字符串）上游没有 _ezItems，
      // 项数无从得知，至少留一项，不然面板上什么都看不到。
      const inConnected = !!(node.inputs || []).find((s) => s.name === 'list' && s.link != null);
      const rowCount = Math.min(MAX_SLOT, Math.max(up ? up.length : 0, linkedOut, inConnected ? 1 : 0));
      trimSplitListSockets(node, cnt);
      (node.outputs || []).forEach((o) => {
        const mm = /^item(\d+)$/.exec(o.name);
        if (!mm) return;
        const linked = (o.link != null || (Array.isArray(o.links) && o.links.length));
        const it = up && up[parseInt(mm[1], 10)];
        o._ezItems = (linked && it) ? [it] : [];   // 没接线的口不算已有项
      });
      notifyOut(node);
      rows.innerHTML = '';
      for (let i = 0; i < rowCount; i++) {
        const nm = (up && up[i] && (up[i].name || up[i].id)) ? String(up[i].name || up[i].id) : (ezT('item') + ' ' + (i + 1));
        const { row } = cardRow(node, -1, { no: i + 1, name: nm, cls: ' plain', noDet: true });
        rows.appendChild(row);
      }
      badge.textContent = linkedOut + ' ' + ezT('items');   // 只数真正接出去的口
    };
    node._ezlpUpdate = render;
    render();
  });
  sockStyle(node);
  installEdgeLabels(node, { side: 'out', rootOf: (n) => n._ezlpRoot, labelOf: (s) => {
    if (!s || !/^item\d+$/.test(s.name)) return '';
    const linked = (s.link != null || (Array.isArray(s.links) && s.links.length));
    if (!linked) return '';   // 没接的输出不画黑框（和 MergeList 一致）
    return String((parseInt(s.name.replace(/\D/g, ''), 10) || 0) + 1);
  } });
}
// ===== TimeLine 面板：左侧素材库（连线 list 端口 / 内置 load 节点）+ 右侧分段轨道 =====
// 视觉与悬停信息参照原型 loop.HTML：分段配色、拼接轨（重叠斜纹 + max 角标）、刻度尺、三角播放头、
// 播放条 + 缩放条、素材库图标（MediaOut 同款 SVG）。所有原生 widget 收起，面板自己画。
const TL_MODELS = {
  minimax_h3: { name: 'MiniMax H3', fps: 24, B: 5, S: 17, maxF: 362 },
  wan: { name: 'Wan 2.2', fps: 16, B: 1, S: 4, maxF: 121 },
  ltx: { name: 'LTX 2.3/2.5', fps: 24, B: 1, S: 8, maxF: 257 },
};
const TL_LANE_H = 84;     // 轨道行高（放得下 64px 预览图 / 视频控件 / 音频控件）
const TL_RULER_H = 26;    // 刻度尺高
const TL_LANES = [
  { id: 'merge', label: 'Video merge', icon: 'merge' },
  { id: 'image', label: 'Ref image', icon: 'image' },
  { id: 'video', label: 'Ref video', icon: 'video' },
  { id: 'audio', label: 'Ref audio', icon: 'audio' },
  { id: 'text', label: 'Prompt', icon: 'text' },
  { id: 'other', label: 'Other', icon: 'other' },
];
// 分段配色（原型 SEG_PALETTE 取主色，画的时候按 alpha 叠，深色主题也不刺眼）
const TL_PALETTE = ['#4a7bef', '#8b6be0', '#e0679b', '#e08a45', '#4aa86a', '#3fa8ad', '#5a72c8', '#c8913f', '#7a6fc0', '#6ba84a'];
const TL_MERGE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5h6M2 11h6"/><path d="M8 5c2 0 3 3 5 3"/><path d="M8 11c2 0 3-3 5-3"/><path d="M12 6l2 2-2 2"/></svg>';
const TL_PLAY_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4 2.5l10 5.5-10 5.5z"/></svg>';
const TL_PAUSE_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/></svg>';
const TL_STOP_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="4" y="4" width="8" height="8"/></svg>';
function tlIcon(kind, size) { return kind === 'merge' ? TL_MERGE_ICON : (kind === 'model_3d' ? model3dIcon(size || 16) : (TYPE_ICONS[kind] || TYPE_ICONS.other)); }
function tlPal(i) { return TL_PALETTE[(Math.max(1, i) - 1) % TL_PALETTE.length]; }
function tlRgba(hex, a) {
  const h = String(hex || '#888888').replace('#', '');
  const s = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  const n = parseInt(s, 16) || 0;
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
let tlPlaying = false, tlTime = 0, tlStart = 0, tlZoom = 1;
// 最小刻度 1s（缩放再大也不出小数点刻度）；100% 时就是 1s 小刻度 / 5s 大刻度（大刻度 = 每 5 个小刻度）
function tlFmtTick(sec) {
  if (sec >= 60) { const m = Math.floor(sec / 60); return m + ':' + String(Math.floor(sec - m * 60)).padStart(2, '0'); }
  return (sec < 1 ? sec.toFixed(1) : String(sec)) + 's';
}
function tlFmtPlay(sec) {
  const m = Math.floor(sec / 60); const s = sec - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
}
function tlWidget(node, name) { return (node.widgets || []).find((w) => w.name === name); }
function tlNum(node, name, dflt) { const w = tlWidget(node, name); const v = w ? w.value : dflt; return v; }
function tlPlan(node) {
  const key = String(tlNum(node, 'model', 'minimax_h3'));
  const m = TL_MODELS[key] || TL_MODELS.minimax_h3;
  const B = m.B, S = m.S, maxF = m.maxF;
  const fps = Math.max(1, parseInt(tlNum(node, 'fps', m.fps), 10) || m.fps);
  const T = Math.max(0.1, parseFloat(tlNum(node, 'total', 30)) || 30);
  const n = Math.max(0.1, parseFloat(tlNum(node, 'segment', 5)) || 5);
  const raw = Math.max(1, parseInt(tlNum(node, 'overlap', 22), 10) || 1);
  const tol = Math.max(0, parseInt(tlNum(node, 'tolerance', 1), 10) || 0);
  const strict = String(tlNum(node, 'align', 'align')) === 'strict';
  const grid = (f) => (f <= B ? B : B + S * Math.ceil((f - B) / S));
  const ovF = grid(raw), oeff = ovF + tol;
  const N = Math.max(1, Math.round(T / n)) - 1;
  const k1 = strict ? Math.max(1, Math.round((fps * n - B) / S)) : Math.max(1, Math.ceil((fps * n - B) / S));
  const F1 = B + S * k1;
  const segs = [{ i: 1, gen: F1, net: F1, ov: 0, start: 0, dur: F1 / fps, netStart: 0, netDur: F1 / fps, exceed: F1 > maxF }];
  let cursor = F1 / fps;
  const ovSec = oeff / fps;
  if (N > 0) {
    let mlist;
    if (strict) mlist = new Array(N).fill(Math.max(1, Math.round((fps * n) / S)));
    else {
      const snet = Math.round((fps * T - B) / S) - k1;
      if (snet < N) mlist = new Array(N).fill(Math.max(1, Math.floor(snet / N)));
      else { const base = Math.floor(snet / N), r = snet - N * base; mlist = Array.from({ length: N }, (_, i) => (i < r ? base + 1 : base)); }
    }
    mlist.forEach((mm, i) => {
      const net = S * mm, gen = net + oeff;
      segs.push({ i: i + 2, gen, net, ov: oeff, start: cursor - ovSec, dur: gen / fps, netStart: cursor, netDur: net / fps, exceed: gen > maxF });
      cursor += net / fps;
    });
  }
  return { segs, ovF, oeff, fps, maxF, model: key, actualTotal: cursor, targetFrames: Math.round(fps * T) };
}
// 扩展名 → 媒体类型；认不出来返回 ''（别把上游节点里的普通字符串当素材）
function tlMediaKind(name) {
  const m = String(name || '').match(/\.([a-z0-9]{1,6})(?:[?#]|$)/i);
  if (!m) return '';
  const ext = m[1].toLowerCase();
  if (/^(png|jpe?g|webp|gif|bmp|tif?f|heic|avif|psd)$/.test(ext)) return 'image';
  if (/^(mp4|webm|mov|mkv|avi|m4v|flv|wmv|mpg|mpeg|ts)$/.test(ext)) return 'video';
  if (/^(mp3|wav|flac|aac|ogg|m4a|wma|opus|aiff|mka)$/.test(ext)) return 'audio';
  if (/^(gltf|glb|obj|fbx|stl|ply|spz|splat|ksplat|3ds|dae|blend)$/.test(ext)) return 'model_3d';
  return '';
}
// 媒体类型 → 内置轨道：图/视/音各一条；3D 模型走「其他」；文本/提示词/未知标量走「文本」（模型不再混进提示词）
function tlLaneOf(kind) {
  const k = String(kind || '');
  if (k === 'image' || k === 'video' || k === 'audio') return k;
  if (k === 'model_3d') return 'other';
  return 'text';
}
function tlUpstream(node, slot) {
  try {
    const inp = (node.inputs || [])[slot]; if (!inp || inp.link == null) return null;
    const g = node.graph; const lk = g && g.links ? g.links[inp.link] : null; if (!lk) return null;
    const origin = (g.getNodeById ? g.getNodeById(lk.origin_id) : null) || ((g._nodes || []).find((n) => n && String(n.id) === String(lk.origin_id)));
    return origin ? { origin, slot: lk.origin_slot } : null;
  } catch (_) { return null; }
}
// 非媒体文本 widget（内置多行字符串 / 文本类节点）：出口是 STRING 就给 1 个「文本项」，
// Merge/SplitList 才看得见它。节点自己盖过章的走不到这里；采样器那种非 STRING 出口也不认。
function tlTextWidgetItem(origin) {
  if (!(origin.outputs || []).some((o) => String((o && o.type) || '').toUpperCase() === 'STRING')) return null;
  for (const w of (origin.widgets || [])) {
    const v = w && w.value;
    if (typeof v !== 'string' || !v.trim()) continue;
    if (/^(config|subfolder|folder|control_after_generate)$/i.test(String((w && w.name) || ''))) continue;
    if (tlMediaKind(String(v).split(/[\\/]/).pop())) continue;   // 文件路径那种走媒体分支
    return { id: String(origin.id) + ':text0', name: String(v).split('\n')[0].slice(0, 40), kind: 'text', type: 'text', text: v };
  }
  return null;
}
// 内置 load 类节点（Load Image / Load Video / Load Audio / Load 3D …）widget 里的媒体文件
function tlWidgetItems(origin) {
  const out = []; let sub = '';
  (origin.widgets || []).forEach((w) => { if (/subfolder|folder/i.test(String((w && w.name) || '')) && typeof w.value === 'string' && w.value) sub = w.value; });
  (origin.widgets || []).forEach((w) => {
    let v = w && w.value;
    if (typeof v !== 'string' || !v) return;
    const anno = / \[(input|output|temp)\]$/i.exec(v);   // LoadImageOutput 这类标注值：name.png [output]
    if (anno) v = v.slice(0, -anno[0].length);
    const viewType = anno ? anno[1].toLowerCase() : 'input';
    const parts = v.split(/[\\/]/); const base = parts.pop();
    const kind = tlMediaKind(base);
    if (!kind) return;
    // 内置 LoadImage 的 value 可能是相对子目录（sub/name.png）；绝对路径不当子目录用
    const dir = ((/^[A-Za-z]:[\\/]/.test(v) || /^[\\/]/.test(v)) ? '' : parts.join('/'));
    const sf = sub || dir;
    out.push({ id: v + '|' + sf, name: base, kind, url: '/view?filename=' + encodeURIComponent(base) + (sf ? ('&subfolder=' + encodeURIComponent(sf)) : '') + '&type=' + viewType });
  });
  if (out.length) return out;
  const t = tlTextWidgetItem(origin);
  return t ? [t] : out;
}
// 一个输入口上的素材：优先取上游端口盖章的 list 项（MediaLoader / MergeList / SplitList…），没有就按内置 load 节点读文件
function tlSlotItems(node, slot) {
  const up = tlUpstream(node, slot); if (!up) return null;
  const sock = up.origin.outputs ? up.origin.outputs[up.slot] : null;
  if (sock && Array.isArray(sock._ezItems)) {
    return sock._ezItems.map((it, i) => {
      const o = it || {};
      const kind = tlMediaKind(o.name) || String(o.type || '').toLowerCase();
      return { id: String(o.id != null ? o.id : ('tl' + slot + '_' + i)), name: o.name || '', kind, url: o.url || '', text: o.text };
    });
  }
  return tlWidgetItems(up.origin);
}
// 分段视频：一个 video 输入口收一份 list，第 i 项就是第 i 段的成片（用来在大预览里按段回看）
function tlAllItems(node) {
  const i = (node.inputs || []).findIndex((s) => s && s.name === 'video');
  if (i < 0) return [];
  return tlSlotItems(node, i) || [];
}
function tlThumbEl(it, cls) {
  const t = el('div', cls || 'eztl-th');
  if (it.kind === 'image' && it.url) { const im = el('img'); im.src = it.url; im.alt = it.name || ''; im.draggable = false; t.appendChild(im); }
  else if (it.kind === 'video' && it.url) {   // 视频缩略图：静音 video 只读元数据，浏览器会给第一帧
    const v = el('video'); v.src = it.url; v.muted = true; v.preload = 'metadata'; v.draggable = false; t.appendChild(v);
  } else t.innerHTML = tlIcon(it.kind);
  t.title = it.name || '';
  return t;
}
// 自定义轨道（轨道栏下面的虚线 + 加出来的）：类型任意，只装手动拖进去的素材，不参与自动铺
// 播放头当前所在的分段（用来决定大预览显示哪个素材）
function tlSegAt(plan) {
  const t = tlTime;
  for (const sg of plan.segs) { const a = (sg.netStart || 0), b = a + (sg.netDur || sg.dur || 0); if (t >= a && t < b) return sg; }
  return plan.segs[plan.segs.length - 1] || null;
}
// 大预览区里的媒体（视频给控件、音频给播放器、图给图）
function tlMediaEl(it) {
  const t = el('div', 'eztl-paneth');
  if (!it) return t;
  if (it.kind === 'image' && it.url) { const im = el('img'); im.src = it.url; im.alt = it.name || ''; im.draggable = false; t.appendChild(im); }
  else if (it.kind === 'video' && it.url) { const v = el('video'); v.src = it.url; v.controls = true; v.muted = true; v.preload = 'metadata'; v.draggable = false; t.appendChild(v); }
  else if (it.kind === 'audio' && it.url) { t.appendChild(makeAudioPlayer(it.url)); }
  else if (it.kind === 'model_3d') { t.innerHTML = tlIcon('model_3d', 48); t.title = it.name || ''; }
  else { t.textContent = it.name || (it.text != null ? String(it.text) : ''); }
  return t;
}
// —— 悬停信息（原型里的 tooltip）——
let _tlTip = null, _tlTipBound = false;
function tlTipBindGlobal() {   // 面板重画会把悬停元素抽走（mouseleave 不触发），这些兜底保证气泡一定会收
  if (_tlTipBound || typeof document === 'undefined') return;
  _tlTipBound = true;
  document.addEventListener('pointerdown', tlTipHide, true);
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) tlTipHide(); }, true);   // 指针离开文档
  window.addEventListener('scroll', tlTipHide, true);
  window.addEventListener('blur', tlTipHide);
  window.addEventListener('resize', tlTipHide);
}
function tlTipEl() {
  if (_tlTip && _tlTip.parentNode) return _tlTip;
  _tlTip = el('div', 'eztl-tip');
  tlTipBindGlobal();
  document.body.appendChild(_tlTip);
  return _tlTip;
}
// 气泡内容走 innerHTML：这里加一道消毒闸门。目前调用方传的都是图标/静态片段，
// 但函数本身不能假定「以后只传安全的」——提示词/文件名一旦接进来就是注入口。
function tlTipShow(html, e) { const t = tlTipEl(); t.innerHTML = ezSanitizeHtml(html); t.style.display = 'block'; tlTipMove(e); }
function tlTipMove(e) { if (!_tlTip || _tlTip.style.display === 'none') return; _tlTip.style.left = ((e.clientX || 0) + 16) + 'px'; _tlTip.style.top = ((e.clientY || 0) + 16) + 'px'; }
function tlTipHide() { if (_tlTip) _tlTip.style.display = 'none'; }
function tlBindTip(elm, htmlFn) {
  elm.addEventListener('mouseenter', (e) => { try { tlTipShow(htmlFn(), e); } catch (_) {} });
  // 鼠标原地不动、元素被重画后：下一次 mousemove 把气泡补回来（否则一直空着）
  elm.addEventListener('mousemove', (e) => { if (!_tlTip || _tlTip.style.display === 'none') { try { tlTipShow(htmlFn(), e); } catch (_) {} } else tlTipMove(e); });
  elm.addEventListener('mouseleave', tlTipHide);
}
// ComfyUI 会把「list 类端口」画成九宫格（输出 shape=6 / 输入 shape=7）；这里强制回圆点，和 MediaLoader 的端口一致。
function dotSockets(node) {
  (node.inputs || []).forEach((s) => { try { if (s && s.shape != null) s.shape = null; } catch (_) {} });
  (node.outputs || []).forEach((s) => { try { if (s && s.shape != null) s.shape = null; } catch (_) {} });
}
// TimeLine 只认 video（分段成片 list）+ index 两个输入口。老工作流里还存着 config、旧素材口，
// 以及 model/total/… 这些 widget 输入 —— 在 Nodes 2.0 里它们会被画成原生 socket（和第一个口重叠的那个圆点）。
// 跟别的面板节点一样，直接从 node.inputs 里摘掉；不再逐帧扫描、也不改节点定义。
function stripTlSockets(node) {
  const ins = node.inputs || [];
  for (let i = ins.length - 1; i >= 0; i--) {
    const s = ins[i];
    if (!s || s.name === 'index' || s.name === 'video') continue;   // 两个固定输入口，别摘
    try { node.removeInput(i); } catch (_) { try { ins.splice(i, 1); } catch (_2) {} }
  }
  // index 在定义里是 forceInput 纯输入口。老工作流把它存成「widget 转输入」（inputs[].widget + widgets.index），
  // 不清掉前端会同时画 widget 圆点和输入口 —— 第一个口上就叠一个点。
  const ix = ins.find((s) => s && s.name === 'index');
  if (ix && ix.widget) { try { delete ix.widget; } catch (_) {} }
  if (Array.isArray(node.widgets)) {
    for (let i = node.widgets.length - 1; i >= 0; i--) {
      const w = node.widgets[i];
      if (w && w.name === 'index' && String(w.type || '').indexOf('ezlp__') !== 0) node.widgets.splice(i, 1);
    }
  }
  try { if (node.widgets_values_named && node.widgets_values_named.index !== undefined) delete node.widgets_values_named.index; } catch (_) {}
  sockStyle(node);
}
// TimeLine 面板状态存 node.properties（随工作流序列化），不占 config 输入端口
function eztlState(node) {
  try {
    const v = node.properties && node.properties.eztl;
    if (v && typeof v === 'object') { if (!v.assets || typeof v.assets !== 'object') v.assets = {}; if (!Array.isArray(v.tracks)) v.tracks = []; return v; }
  } catch (_) {}
  return { assets: {}, tracks: [] };
}
function eztlSave(node, st) { try { if (!node.properties) node.properties = {}; node.properties.eztl = st; } catch (_) {} }
// 两个固定输入口：video（分段成片 list）/ index（接 LoopStart.index / easy forLoop index）。老工作流缺哪个补哪个。
function syncTlInputs(node) {
  stripTlSockets(node);
  if (!(node.inputs || []).some((s) => s.name === 'video')) node.addInput('video', '*');
  if (!(node.inputs || []).some((s) => s.name === 'index')) node.addInput('index', 'INT');
  sockStyle(node);
  const is = (node.inputs || []).find((s) => s.name === 'index');   // index 用 MediaLoader 同款深红
  if (is) { try { is.color = is.color_on = is.color_off = '#d94848'; if (is.shape != null) is.shape = null; } catch (_) {} }
}
// 原生 widget 全部收起来，面板自己画（值仍写回隐藏的 widget，后端照旧读）
function hideNativeWidgets(node) {
  const shell = node && node._ezlpRoot;
  (node.widgets || []).forEach((w) => {
    if (!w) return;
    if (String(w.type || '').indexOf('ezlp__') === 0) return;
    if (w.element && (w.element === shell || (w.element.contains && shell && w.element.contains(shell)))) return;
    try {
      w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0; w.draw = () => {};
      w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
      w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
      if (w.element && w.element.style) { w.element.style.display = 'none'; w.element.style.height = '0'; w.element.style.minHeight = '0'; w.element.style.maxHeight = '0'; }
    } catch (_) {}
  });
}
// 悬停信息：分段（段号/生成时长/净增/重叠/超限）
function tlSegTip(sg, plan) {
  const p = tlPal(sg.i);
  let html = '<span class="eztl-tipdot" style="background:' + tlRgba(p, 0.3) + ';border:1px solid ' + tlRgba(p, 0.7) + '"></span>';
  html += '<strong>' + ezT('Segment') + ' #' + sg.i + (sg.i === 1 ? ('（' + ezT('first') + '）') : '') + '</strong><br>';
  html += ezT('Generation length') + ': ' + sg.dur.toFixed(3) + 's（' + sg.gen + ezT(' frames') + '）<br>';
  html += ezT('Net increase') + ': ' + sg.netDur.toFixed(3) + 's（' + sg.net + ezT(' frames') + '）';
  if (sg.ov > 0) html += '<br>' + ezT('Overlap') + ': ' + sg.ov + ezT(' frames') + '（' + (sg.ov / plan.fps).toFixed(3) + 's）';
  if (sg.exceed) html += '<br><span style="color:var(--ez-warn-fg)">' + ezT('Over max by') + ' ' + (sg.gen - plan.maxF) + ezT(' frames') + '</span>';
  return html;
}
// 悬停信息：工具条那几个 i（模型/总时长/每段/FPS/过渡）
function tlInfoTip(key, plan) {
  const m = TL_MODELS[plan.model] || TL_MODELS.minimax_h3;
  if (key === 'model') return '<strong>' + m.name + '</strong><br>' + ezT('Default FPS') + ': ' + m.fps + '<br>' + ezT('Frame grid') + ': ' + m.B + ' + ' + m.S + 'k<br>' + ezT('Segment cap') + ': ' + m.maxF + ezT(' frames') + '（' + (m.maxF / m.fps).toFixed(2) + 's）';
  if (key === 'total') return ezT('Target frames') + ': <strong>' + plan.targetFrames + '</strong><br>' + ezT('Actual duration') + ': <strong>' + plan.actualTotal.toFixed(3) + 's</strong><br>' + ezT('Actual frames') + ': <strong>' + plan.segs.reduce((a, s) => a + s.net, 0) + '</strong>';
  if (key === 'seg') {
    const over = plan.segs.filter((s) => s.exceed);
    return ezT('Number of segments') + ': <strong>' + plan.segs.length + '</strong><br>' + (over.length ? ('<span style="color:var(--ez-warn-fg)">' + ezT('Over the limit') + ': ' + over.length + '（' + over.map((s) => '#' + s.i).join(', ') + '）</span>') : ezT('No segment over the limit'));
  }
  if (key === 'fps') return '<strong>' + ezT('Current FPS') + ': ' + plan.fps + '</strong><br>' + ezT('Default FPS') + ': ' + m.fps;
  if (key === 'overlap') return ezT('Aligned to') + ': <strong>' + plan.ovF + ezT(' frames') + '</strong>（' + m.B + '+' + m.S + 'k）<br>' + ezT('Effective overlap') + ': <strong>' + plan.oeff + ezT(' frames') + '</strong><br>' + ezT('Tolerance') + ': ' + (plan.oeff - plan.ovF);
  return '';
}
function setupTimeLine(node) {
  mount(node, ezT('Time Line'), (root, badge) => {
    root.addEventListener('mouseleave', tlTipHide);   // 指针离开面板就收掉悬停气泡
    const tb = el('div', 'eztl-tb'); root.appendChild(tb);
    const main = el('div', 'eztl-main'); root.appendChild(main);
    // 上：大预览；下：控件 + 视频拼接轨。上下按固定比例随节点缩放（不再有拖动缝）
    const pane = el('div', 'eztl-pane'); main.appendChild(pane);
    const bottom = el('div', 'eztl-bottom'); main.appendChild(bottom);
    const tlBox = el('div', 'eztl-tl'); bottom.appendChild(tlBox);
    const cbar = el('div', 'eztl-cbar'); tlBox.appendChild(cbar);    // 控件在上
    const pbar = el('div', 'eztl-playbar'); cbar.appendChild(pbar);
    const zbar = el('div', 'eztl-zoombar'); cbar.appendChild(zbar);
    const trow = el('div', 'eztl-trow'); tlBox.appendChild(trow);   // 时间轴在控件下面、贴底
    const vp = el('div', 'eztl-vp'); trow.appendChild(vp);
    const content = el('div', 'eztl-content'); vp.appendChild(content);
    const ruler = el('div', 'eztl-ruler'); content.appendChild(ruler);
    const lanesBox = el('div', 'eztl-lanes'); content.appendChild(lanesBox);
    const headEl = el('div', 'eztl-play'); content.appendChild(headEl);
    // 播放条 / 缩放条是**常驻**的：render() 只回填值，不重建 —— 重建会把正在拖的滑块从指针下抽走，
    // 表现就是「缩放条只能点、不能顺滑拖」。
    let rafId = 0;
    let doRender = () => {};
    let drawPane = () => {};
    const renderSoon = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = 0; try { doRender(); } catch (_) {} });
    };
    const mkBtn = (html, title, fn) => {
      const b = el('button', 'eztl-playbtn', { type: 'button', title: title }); b.innerHTML = html;
      b.addEventListener('click', fn); return b;
    };
    const btnPlay = mkBtn(TL_PLAY_ICON, ezT('Play / Pause'), () => { if (tlPlaying) pausePlay(); else startPlay(); });
    btnPlay.classList.add('eztl-playicon');
    const updatePlayIcon = () => { btnPlay.innerHTML = tlPlaying ? TL_PAUSE_ICON : TL_PLAY_ICON; btnPlay.classList.toggle('active', tlPlaying); };
    // 播放/暂停抽出来：播放按钮、拼接轨点击、时间输入都走同一份（暂停只翻图标，不再整块重画）
    const startPlay = () => {
      const total = headEl._total || 0;
      if (tlTime >= total) tlTime = 0;
      tlPlaying = true; tlStart = performance.now() - tlTime * 1000; updatePlayIcon(); try { drawPane(); } catch (_) {}
      requestAnimationFrame(tick);
    };
    const pausePlay = () => { tlPlaying = false; updatePlayIcon(); try { drawPane(); } catch (_) {} };
    const btnStop = mkBtn(TL_STOP_ICON, ezT('Stop'), () => { tlPlaying = false; tlTime = 0; updatePlayIcon(); drawHead(); try { drawPane(); } catch (_) {} });
    const tspan = el('span', 'eztl-time');
    const timeCur = el('span', 'cur'); const timeTot = el('span', 'tot');
    const sep = el('span', 'sep'); sep.textContent = '/';
    tspan.appendChild(timeCur); tspan.appendChild(sep); tspan.appendChild(timeTot);
    // 播放头时间输入框（无上下箭头）：指到哪就从哪开始播
    const timeInp = el('input', 'eztl-timeinp'); timeInp.type = 'number'; timeInp.min = '0'; timeInp.step = '0.1';
    timeInp.title = ezT('Playhead time (s)');
    timeInp.addEventListener('change', () => { const v = parseFloat(timeInp.value); if (!isFinite(v)) return; tlPlaying = false; tlTime = Math.max(0, Math.min(headEl._total || 0, v)); updatePlayIcon(); drawHead(); try { drawPane(); } catch (_) {} });
    timeInp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); timeInp.blur(); timeInp.dispatchEvent(new Event('change')); } });
    pbar.appendChild(btnPlay); pbar.appendChild(btnStop); pbar.appendChild(tspan); pbar.appendChild(timeInp);
    // 缩放常态只显示百分比（透明无边框，跟底栏融在一起），点一下才变成可输入的框
    const zoomPct = el('span', 'eztl-zoompct', { title: ezT('Zoom (%)') });
    zoomPct.textContent = Math.round(tlZoom * 100) + '%';
    const zoomInp = el('input', 'eztl-zoominp'); zoomInp.type = 'number'; zoomInp.min = '30'; zoomInp.max = '800'; zoomInp.step = '5';
    zoomInp.value = String(Math.round(tlZoom * 100)); zoomInp.title = ezT('Zoom (%)');
    const zoomEdit = () => { zoomPct.style.display = 'none'; zoomInp.classList.add('on'); zoomInp.value = String(Math.round(tlZoom * 100)); try { zoomInp.focus(); zoomInp.select(); } catch (_) {} };
    const zoomShow = () => { zoomPct.style.display = ''; zoomInp.classList.remove('on'); };
    zoomPct.addEventListener('click', zoomEdit);
    zoomInp.addEventListener('change', () => { const v = parseFloat(zoomInp.value); if (!isFinite(v)) { zoomShow(); return; } tlZoom = Math.max(0.3, Math.min(8, v / 100)); zoomInput.value = String(Math.round(tlZoom * 100)); zoomShow(); renderSoon(); });
    zoomInp.addEventListener('keydown', (e) => { e.stopPropagation && e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault && e.preventDefault(); zoomInp.blur(); zoomInp.dispatchEvent(new Event('change')); } });
    zoomInp.addEventListener('blur', zoomShow);
    const zoomInput = el('input', 'eztl-zoom'); zoomInput.type = 'range'; zoomInput.min = '30'; zoomInput.max = '800';
    zoomInput.value = String(Math.round(tlZoom * 100));
    zoomInput.addEventListener('input', () => { tlZoom = (parseInt(zoomInput.value, 10) || 100) / 100; if (document.activeElement !== zoomInp) zoomInp.value = String(Math.round(tlZoom * 100)); renderSoon(); });
    // 显示模式：含重叠（原样）/ 不含重叠（每段从净起点铺，去掉过渡那段）
    const modeSel = el('select', 'eztl-sel eztl-playmode');
    [['overlap', ezT('With overlap')], ['trim', ezT('No overlap')]].forEach(([v, tx]) => { const o = el('option'); o.value = v; o.textContent = tx; modeSel.appendChild(o); });
    modeSel.title = ezT('Merge view');
    modeSel.addEventListener('change', () => { const s = eztlState(node); s.mergeView = modeSel.value === 'trim' ? 'trim' : 'overlap'; eztlSave(node, s); renderSoon(); });
    pbar.appendChild(modeSel);   // 显示模式：播放/停止那一行最右
    const ppsLbl = el('span', 'eztl-zoomlbl right');
    zbar.appendChild(zoomPct); zbar.appendChild(zoomInp); zbar.appendChild(zoomInput); zbar.appendChild(ppsLbl);

    const drawHead = () => {
      const pps = headEl._pps || 1;
      headEl.style.left = (Math.min(tlTime, headEl._total || 0) * pps) + 'px';
      if (timeCur) timeCur.textContent = tlFmtPlay(tlTime);
      if (timeInp && document.activeElement !== timeInp) timeInp.value = (Math.round(tlTime * 100) / 100).toFixed(2);
    };
    let lastPaneSeg = -1;
    const tick = (now) => {
      if (!node._ezlpRoot || !node._ezlpRoot.isConnected) { tlPlaying = false; updatePlayIcon(); return; }
      if (!tlPlaying) return;
      const total = headEl._total || 0, t = (now - tlStart) / 1000;
      tlTime = t >= total ? total : t;
      if (t >= total) { tlPlaying = false; updatePlayIcon(); }
      drawHead();
      // 播放时大预览只跟视频拼接轨（参考轨不参与“播放”），按当前段变化重画
      const segs = headEl._segs || [];
      let si = segs.length ? segs[segs.length - 1].i : 0;
      for (const sg of segs) { const a = sg.netStart || 0; if (tlTime >= a && tlTime < a + (sg.netDur || sg.dur || 0)) { si = sg.i; break; } }
      if (si !== lastPaneSeg) { lastPaneSeg = si; try { drawPane(); } catch (_) {} }
      if (tlPlaying) requestAnimationFrame(tick);
    };
    const render = () => {
      stripTlSockets(node);
      syncTlInputs(node);
      dotSockets(node);
      const plan = tlPlan(node);
      const trim = eztlState(node).mergeView === 'trim';   // false = 含重叠（原样），true = 不含重叠
      if (modeSel.value !== (trim ? 'trim' : 'overlap')) modeSel.value = trim ? 'trim' : 'overlap';
      const items = tlAllItems(node);
      const lanes = [TL_LANES[0]];   // 只有「视频拼接」一条轨
      const fps = plan.fps;
      badge.textContent = plan.segs.length + ' ' + ezT('segments') + ' · ' + plan.oeff + ' ' + ezT(' frames');
      // ---- 工具条（文本框 + 悬停信息 i；输入框不带上下箭头）----
      tb.innerHTML = '';
      const field = (label, w, opts, unit, tipKey) => {
        if (!w) return;
        const g = el('span', 'eztl-fld');
        const l = el('span', 'eztl-lbl'); l.textContent = label; g.appendChild(l);
        if (opts) {
          const s = el('select', 'eztl-sel');
          opts.forEach(([v, t]) => { const o = el('option'); o.value = v; o.textContent = t; if (String(w.value) === v) o.selected = true; s.appendChild(o); });
          s.addEventListener('change', () => { w.value = s.value; try { if (typeof w.callback === 'function') w.callback(s.value); } catch (_) {} render(); });
          g.appendChild(s);
        } else {
          const i = el('input', 'eztl-num'); i.type = 'number'; i.step = (w.options && w.options.step) ? String(w.options.step) : '1'; i.value = String(w.value);
          i.addEventListener('change', () => { const v = parseFloat(i.value); if (!isNaN(v)) w.value = v; try { if (typeof w.callback === 'function') w.callback(w.value); } catch (_) {} render(); });
          g.appendChild(i);
        }
        if (unit) { const u = el('span', 'eztl-lbl'); u.textContent = unit; g.appendChild(u); }
        if (tipKey !== null) { const info = el('span', 'eztl-info', { 'data-tip': tipKey || '' }); info.textContent = 'i'; tlBindTip(info, () => tlInfoTip(tipKey, plan)); g.appendChild(info); }
        tb.appendChild(g);
      };
      field(ezT('Model'), tlWidget(node, 'model'), Object.keys(TL_MODELS).map((k) => [k, TL_MODELS[k].name]), '', 'model');
      tb.appendChild(el('span', 'eztl-div'));
      field(ezT('Total s'), tlWidget(node, 'total'), null, 's', 'total');
      field(ezT('Segment s'), tlWidget(node, 'segment'), null, 's', 'seg');
      field(ezT('FPS'), tlWidget(node, 'fps'), null, '', 'fps');
      field(ezT('Overlap'), tlWidget(node, 'overlap'), null, ezT(' frames'), 'overlap');
      field(ezT('Tolerance'), tlWidget(node, 'tolerance'), null, ezT(' frames'), null);
      field(ezT('Align'), tlWidget(node, 'align'), [['align', ezT('Align total')], ['strict', ezT('Strict segment')]], '', null);
      // ---- 时间轴（比例尺按面板宽度自适应；zoom 只改 px/s）----
      const vw = Math.max(120, vp.clientWidth || 420);
      const total = Math.max(plan.actualTotal || 1, 0.5);
      const basePps = Math.max(4, vw / (total + 1));
      const pps = basePps * tlZoom;
      const contentW = Math.max(vw, (total + 1) * pps);
      content.style.width = contentW + 'px';
      const maxSec = contentW / pps;
      ruler.innerHTML = '';
      // 1s 一小刻度、5s 一大刻度（缩得太小就不画 1s，免得糊成一片；大刻度只保证标签不挤）
      const minorStep = 1;
      let majorStep = 300;
      for (const s of [5, 10, 15, 30, 60, 120, 300]) { if (s * pps >= 40) { majorStep = s; break; } }
      const drawMinor = minorStep * pps >= 3;
      for (let t = 0; t <= maxSec + 1e-6; t += minorStep) {
        const major = Math.round(t) % majorStep === 0;
        if (!major && !drawMinor) continue;
        const tk = el('div', 'eztl-tick' + (major ? ' major' : ''));
        tk.style.left = (t * pps) + 'px';
        if (major) { const sp = el('span'); sp.textContent = tlFmtTick(t); tk.appendChild(sp); }
        ruler.appendChild(tk);
      }
      // ---- 大预览区（16:9）：显示播放头所在段对应的素材（素材按序号 → 段序号对位）----
      drawPane = () => {
        pane.innerHTML = '';
        const segNow = tlSegAt(plan);
        const it = (segNow && items[segNow.i - 1]) || null;
        if (it) {
          const ptag = el('div', 'eztl-panetag');
          ptag.textContent = ezT('Video merge') + ' · ' + ezT('Segment') + ' #' + segNow.i + ' · ' + (it.name || '');
          pane.appendChild(ptag);
          pane.appendChild(tlMediaEl(it));
          return;
        }
        const h = el('div', 'eztl-panehint');
        h.textContent = (tlPlaying ? ezT('Playing') + ' · ' : '') + ezT('Video merge') + ' · ' + ezT('Segment') + ' #' + (segNow ? segNow.i : 1);
        pane.appendChild(h);
      };
      tlTipHide();   // 重画前先收掉（旧的分段元素被抽走时不会触发 mouseleave）
      lanesBox.innerHTML = '';
      lanes.forEach((lane) => {
        const row = el('div', 'eztl-lane' + (lane.id === 'merge' ? ' merge' : ''));
        row.style.height = TL_LANE_H + 'px';
        row.dataset.lane = lane.id;
        plan.segs.forEach((sg) => {
          const p = tlPal(sg.i);
          if (lane.id === 'merge') {
            const box = el('div', 'eztl-mseg');
            box.style.left = ((trim ? sg.netStart : sg.start) * pps) + 'px';       // 不含重叠：从净起点铺
            box.style.width = Math.max(6, (trim ? (sg.netDur || sg.dur) : sg.dur) * pps - 2) + 'px';
            box.style.background = tlRgba(p, 0.22);
            box.style.borderColor = tlRgba(p, 0.55);
            if (!trim && sg.ov > 0) {
              const prev = tlPal(sg.i - 1);
              const ov = el('div', 'eztl-mov');
              ov.style.width = (sg.ov / fps * pps) + 'px';
              ov.style.background = 'repeating-linear-gradient(135deg,' + tlRgba(prev, 0.5) + ' 0px,' + tlRgba(prev, 0.5) + ' 4px,' + tlRgba(p, 0.5) + ' 4px,' + tlRgba(p, 0.5) + ' 8px)';
              box.appendChild(ov);
            }
            const net = el('div', 'eztl-mnet');
            const lbl = el('div', 'eztl-mlbl'); lbl.textContent = '#' + sg.i; net.appendChild(lbl);
            if (sg.exceed) { const mx = el('div', 'eztl-mmax'); mx.textContent = 'max'; net.appendChild(mx); }
            box.appendChild(net);
            tlBindTip(box, () => tlSegTip(sg, plan));
            box.addEventListener('mousedown', (e) => {   // 点视频段 = 播放头定位到该段开头（不含重叠部分）
              if (e.button !== 0) return;
              e.stopPropagation();
              tlPlaying = false; tlTime = Math.min(total, Math.max(0, sg.netStart));
              updatePlayIcon(); drawHead(); try { drawPane(); } catch (_) {}
            });
            row.appendChild(box);
            return;
          }
        });
        lanesBox.appendChild(row);
      });
      drawPane();
      headEl._pps = pps; headEl._total = total; headEl._segs = plan.segs;
      if (timeInp) timeInp.max = total.toFixed(2);
      drawHead();
      // ---- 播放条 / 缩放条：常驻件，这里只回填值（见上面 renderSoon 的说明）----
      timeCur.textContent = tlFmtPlay(tlTime);
      timeTot.textContent = tlFmtPlay(total);
      updatePlayIcon();
      const zv = String(Math.round(tlZoom * 100));
      if (zoomInput.value !== zv) zoomInput.value = zv;   // 拖拽中不回写，免得和指针打架
      if (!zoomInp.classList.contains('on') && zoomInp.value !== zv) zoomInp.value = zv;   // 正在输入时不回写
      const pct = zv + '%';
      if (zoomPct.style.display !== 'none' && zoomPct.textContent !== pct) zoomPct.textContent = pct;
      ppsLbl.textContent = pps.toFixed(1) + ' px/s';
      // 点/拖刻度尺或轨道空白 = 播放头到哪（按住连续拖）；点在素材缩略图/音频控件上不抢
      const seekTo = (clientX) => {
        // 画布缩放时 DOM 面板整体被 CSS 放大：用 rect 与 offsetWidth 的比值把屏幕像素换回面板 DOM 像素，
        // 否则 pps（DOM px/s）和鼠标位移对不上，播放头会“跟不上鼠标”。
        const r = content.getBoundingClientRect();
        const domW = content.offsetWidth || r.width || 1;
        const xDom = (clientX - r.left) * (domW / (r.width || domW));
        tlPlaying = false; tlTime = Math.max(0, Math.min(total, xDom / pps));
        updatePlayIcon(); drawHead();
      };
      const beginScrub = (e2) => {
        if (e2.button !== 0) return;
        if (e2.target && e2.target.closest && e2.target.closest('.eztl-th,.eztl-play,.eztl-mseg')) return;   // 点素材/点视频段不在这里定位（视频段自己定位到段首）
        seekTo(e2.clientX);
        const move = (ev) => seekTo(ev.clientX);
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      };
      ruler.onmousedown = beginScrub;
      content.onmousedown = beginScrub;
      // 不再往 INT 输出上盖 _ezItems：那是「媒体端口」的约定，MediaOut/MergeList 会把分段描述当成素材项。
      // 下游循环拿的是后端真实 list（走连线），不依赖这个前端镜像。
      notifyOut(node);
    };
    doRender = render;
    node._ezlpUpdate = render;
    render();
  });
  hideNativeWidgets(node);
  // 和别的面板节点同款：setup 时 node.inputs/widgets 还没最终定型，稍后再裁一次残留的 config / widget 输入口
  setTimeout(() => { try { hideConfigWidget(node); stripTlSockets(node); } catch (_) {} }, 60);
  if (!node._eztlPost) {   // setup 会被调两次（onNodeCreated + nodeCreated/loadedGraphNode）：尺寸只定一次
    node._eztlPost = true;
    try { node.setSize([800, 720]); } catch (_) {}
    installEdgeLabels(node, { side: 'both', rootOf: (n) => n._ezlpRoot, labelOf: (s, i, isIn) => {
      if (!isIn) return (s && s.name) || '';
      if (s && s.name === 'index') return 'index';
      if (s && s.name === 'video') return 'video';
      return '';
    } });
  } else if (node._ezlpUpdate) {
    try { node._ezlpUpdate(); } catch (_) {}
  }
  // 面板宽度变了（拉节点 / 首次挂上 DOM）就重算比例尺
  try {
    if (node._eztlRO) node._eztlRO.disconnect();
    const ro = new ResizeObserver((ent) => {
      const now = Math.round((ent && ent[0] && ent[0].contentRect && ent[0].contentRect.width) || 0);
      if (Math.abs(now - (node._eztlRootW || 0)) < 3) return;
      node._eztlRootW = now;
      if (node._ezlpUpdate) node._ezlpUpdate();
    });
    ro.observe(node._ezlpRoot);
    node._eztlRO = ro;
  } catch (_) {}
}



function setup(node) {
  const t = nodeTypeOf(node);
  if (t === MERGE_LIST) setupMergeList(node);
  else if (t === LOOP_START) setupLoopStart(node);
  else if (t === LOOP_END) setupLoopEnd(node);
  else if (t === SPLIT_LIST) setupSplitList(node);
  else if (t === TIME_LINE) setupTimeLine(node);
}
function hook(nt) {
  if (!nt || nt.__ezlpHooked) return; nt.__ezlpHooked = true;
  const pc = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = pc ? pc.apply(this, arguments) : undefined; setup(this); return r; };
  const pm = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = pm ? pm.apply(this, arguments) : undefined; try { forceShell(this); stripCoreSockets(this); if (nodeTypeOf(this) === TIME_LINE) stripTlSockets(this); if (this._ezlpUpdate) this._ezlpUpdate(); } catch (_) {} return r; };
  const pcn = nt.prototype.onConnectionsChange; nt.prototype.onConnectionsChange = function () { const r = pcn ? pcn.apply(this, arguments) : undefined; try { if (this._ezlpUpdate) this._ezlpUpdate(); } catch (_) {} return r; };
  const pr = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = pr ? pr.apply(this, arguments) : undefined; try { (this._ezEdgeEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); this._ezEdgeEls = []; } catch (_) {} try { if (this._ezlpRoot) this._ezlpRoot.remove(); } catch (_) {} this._ezlpSetup = false; return r; };
}
app.registerExtension({
  name: 'EzFlex.LoopNodes',
  async beforeRegisterNodeDef(nt, nd) {
    if (!nd) return;
    if (nd.name === MERGE_LIST || nd.name === LOOP_START || nd.name === LOOP_END || nd.name === SPLIT_LIST || nd.name === TIME_LINE) hook(nt);
  },
  nodeCreated(n) { const t = nodeTypeOf(n); if (t === MERGE_LIST || t === LOOP_START || t === LOOP_END || t === SPLIT_LIST || t === TIME_LINE) setup(n); },
});
