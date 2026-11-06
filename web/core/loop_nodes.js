// 模块：循环面板 + 时间轴公共工具（tl*：规划/悬停/下游通知）
// EzFlex 循环三节点面板：MergeList / LoopStart / LoopEnd。
// 卡片**跟着输入端口自动增减**（PreviewAny 式：已连的每个口一张卡 + 末尾留一个空槽），不手动加/减。
// 壳/铺满/端口黑框标签照 MediaLoader：forceShell + installEdgeLabels + widgets_start_y=0 + settle/retry。
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { ezApplyDefaultSize, NODE_TYPES, nodeTypeOf, installResizeHandles, makeDomWidgetHitThrough, installEdgeLabels, makeAudioPlayer, readConfig, writeConfig, TYPE_ICONS, model3dIcon, ezSanitizeHtml, uiPrompt, uiConfirm, uiToast, ezCaptureSocketLinks, ezApplySocketLinks } from "./ezflex_service.js";
import { ezT } from "./ezflex_i18n.js";
import { ezThemeInit } from "./ezflex_theme.js";

const MERGE_LIST = NODE_TYPES.MERGE_LIST;
const LOOP_START = NODE_TYPES.LOOP_START;
const LOOP_END = NODE_TYPES.LOOP_END;
const SPLIT_LIST = NODE_TYPES.SPLIT_LIST;
const TIME_LINE = NODE_TYPES.TIME_LINE;
// ★★ 必须声明：`tlUpstreamPlanNode` 要拿它比对上游节点类型。
//    以前漏了这行 ⇒ 严格模式里读未声明标识符直接 ReferenceError ⇒ 被 try/catch 吞掉 ⇒
//    函数永远返回 null ⇒ **TimeLine 永远读不到上游 EzFlex-TimePlan**（表现就是「timeplan 和
//    timeline 没形成联动，改 timeplan 时间轴不动」）。
const TIME_PLAN = NODE_TYPES.TIME_PLAN;
const MIN_W = 390;
const START_W = 380;
const MAX_SLOT = 16;
const SOCK_COLOR = '#2f8f5b';

const CSS = `
.ezlp-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezlp-shell .ezlp-root{pointer-events:auto;}
.ezlp-root{overflow:hidden;min-height:0;position:absolute;inset:0 12px 12px 12px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--ez-fg);background:var(--ez-bg);border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-height:0;overflow:hidden;}
.ezlp-root *{box-sizing:border-box;user-select:none;-webkit-user-select:none;}
.ezlp-root::-webkit-scrollbar{width:10px;}
.ezlp-root::-webkit-scrollbar-track{background:rgba(127,127,127,.10);border-radius:5px;}
.ezlp-root::-webkit-scrollbar-thumb{background:var(--ez-fg-muted);border-radius:5px;min-height:28px;}
.ezlp-root::-webkit-scrollbar-thumb:hover{background:var(--ez-fg-2);}
.ezlp-persist-cards::-webkit-scrollbar{width:10px;}
.ezlp-persist-cards::-webkit-scrollbar-track{background:rgba(127,127,127,.10);border-radius:5px;}
.ezlp-persist-cards::-webkit-scrollbar-thumb{background:var(--ez-fg-muted);border-radius:5px;min-height:28px;}
.ezlp-persist-cards::-webkit-scrollbar-thumb:hover{background:var(--ez-fg-2);}
.ezlp-hd{display:flex;align-items:center;gap:8px;flex:0 0 auto;}
.ezlp-title{font-weight:550;font-size:13px;}
.ezlp-badge{font-size:10px;color:var(--ez-fg-3);background:var(--ez-surface-3);padding:1px 8px;border-radius:100px;}
.ezlp-rows{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:5px;}
.ezlp-ctl{display:flex;align-items:center;gap:6px;flex:0 0 auto;flex-wrap:wrap;}
.ezlp-seg{display:flex;background:var(--ez-surface-3);border-radius:8px;padding:1px;border:1px solid var(--ez-border);}
.ezlp-segbtn{background:transparent;border:none;padding:2px 12px;font-size:11px;color:var(--ez-fg-2);font-family:inherit;cursor:pointer;border-radius:6px;height:22px;line-height:1;}
.ezlp-segbtn.active{background:var(--ez-bg);color:var(--ez-fg);font-weight:510;box-shadow:0 1px 4px rgba(0,0,0,.06);}
.ezlp-lbl{font-size:11px;color:var(--ez-fg-3);white-space:nowrap;}
.ezlp-num{width:52px;height:26px;padding:0 6px;border:1px solid var(--ez-border);border-radius:7px;background:var(--ez-bg);color:var(--ez-fg);font-family:inherit;text-align:center;box-sizing:border-box;appearance:textfield;}
.ezlp-num::-webkit-outer-spin-button,.ezlp-num::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
/* 接上 timeplan 后「次数」由规划决定 ⇒ 变灰（值仍显示规划算出来的段数） */
.ezlp-num:disabled{opacity:.5;cursor:default;}
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
.ezlp-row.only{justify-content:center;align-self:center;padding:0;background:transparent;border:none;}
.ezlp-row.only .ezlp-num{width:58px;}
.ezlp-refs{display:flex;flex-direction:column;gap:6px;width:100%;padding:6px 2px 2px;box-sizing:border-box;flex:1 1 auto;min-height:0;overflow-y:auto;}
.ezlp-ref{display:flex;align-items:center;gap:6px;background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:8px;padding:4px 6px;font-size:11px;color:var(--ez-fg-2);}
.ezlp-ref input[type=checkbox]{accent-color:var(--ez-strong);}
.ezlp-ref select{height:24px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-bg);color:var(--ez-fg);font:inherit;font-size:11px;padding:0 4px;outline:none;min-width:64px;}
.ezlp-ref .ezlp-no{min-width:18px;}
/* LoopEnd 的「续跑方式」开关（展开 / 队列），居中一行 */
.ezlp-mode{display:flex;align-items:center;justify-content:center;gap:6px;flex:0 0 auto;}
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
.eztl-fld-tip{cursor:help;}
.eztl-main{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:0;}   /* 上：大预览（可压缩）；下：控件+拼接轨（贴底） */
.eztl-bottom{flex:0 0 260px;display:flex;flex-direction:row;min-height:260px;}                 /* 底部控件固定高度，预览只吃剩余空间 */
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
.eztl-menu{position:fixed;z-index:100300;background:var(--ez-bg);border:1px solid var(--ez-border-strong);border-radius:8px;padding:4px;display:flex;flex-direction:column;min-width:168px;box-shadow:0 8px 24px rgba(0,0,0,.35);}
.eztl-menu button{display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:5px;background:transparent;color:var(--ez-fg);font-family:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}
.eztl-menu button:hover{background:var(--ez-surface-3);}
.eztl-mseg{position:absolute;top:5px;bottom:5px;border-radius:4px;overflow:hidden;display:flex;border:1.5px solid transparent;box-sizing:border-box;cursor:pointer;}
.eztl-mseg.eztl-msel{border-color:#2ea043;box-shadow:0 0 0 1px #2ea043;z-index:5;}
.eztl-mseg.eztl-mdone .eztl-mlbl::after{content:' \\2713';color:#2ea043;margin-left:3px;font-weight:700;}
.eztl-selbar{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:3px 2px 2px;flex-wrap:wrap;background:var(--ez-surface-2);border-bottom:1px solid var(--ez-border-2);}
.eztl-playmode{min-width:0!important;width:auto!important;max-width:92px;padding:0 4px;}
.eztl-selbar .eztl-selcnt{font-size:11px;color:var(--ez-fg-3);white-space:nowrap;margin-right:2px;}
.eztl-selbtn{height:22px;padding:0 9px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font-family:inherit;font-size:11px;cursor:pointer;white-space:nowrap;}
.eztl-selbtn:hover{background:var(--ez-surface-3);}
.eztl-selbtn.primary{background:var(--ez-strong);color:var(--ez-on-strong);border-color:var(--ez-strong);}
.eztl-textbtn{width:auto!important;min-width:auto!important;padding:0 8px!important;height:24px;font-size:11px;}
.ezlp-persist-top{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;white-space:nowrap;padding:4px 2px;min-width:0;}
.ezlp-ports{display:flex;flex-wrap:wrap;gap:4px;padding:3px 2px;flex:0 0 auto;}
.ezlp-filter{position:relative;}
.ezlp-filter>summary{list-style:none;height:22px;padding:0 8px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font-size:11px;cursor:pointer;display:flex;align-items:center;}
.ezlp-filter>summary::-webkit-details-marker{display:none;}
.ezlp-filter-body{position:absolute;top:26px;right:0;z-index:50;background:var(--ez-bg);border:1px solid var(--ez-border-strong);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:5px;min-width:220px;box-shadow:0 8px 24px rgba(0,0,0,.35);}
.ezlp-persist{display:flex;flex-direction:column;gap:4px;padding:4px 2px;flex:0 0 auto;}
.ezlp-persist-cards{display:flex;flex-direction:column;gap:5px;padding:4px 2px;flex:1 1 auto;min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--ez-fg-muted) transparent;}
.ezlp-persist-card{display:flex;align-items:center;gap:6px;background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:8px;padding:4px 6px;}
.ezlp-persist-no{min-width:14px;flex:0 0 auto;font-size:10px;color:var(--ez-fg-3);text-align:center;}
.ezlp-persist-card input[type=text]{min-width:0;width:90px;height:24px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-bg);color:var(--ez-fg);font:inherit;font-size:11px;padding:0 5px;}
.ezlp-persist-card select{height:24px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-bg);color:var(--ez-fg);font:inherit;font-size:11px;padding:0 4px;outline:none;}
.ezlp-persist-card input[type=text]:last-child{width:46px;text-align:center;}
.ezlp-persist-bar,.ezlp-persist-row{display:flex;align-items:center;gap:4px;flex-wrap:wrap;}
.ezlp-persist-grid{display:flex;flex-direction:column;gap:4px;}
.ezlp-chip{height:20px;padding:0 7px;border:1px solid var(--ez-border);border-radius:5px;background:var(--ez-surface-2);color:var(--ez-fg);font-family:inherit;font-size:10.5px;cursor:pointer;}
.ezlp-chip.on{background:#2ea043;border-color:#2ea043;color:#fff;}
.ezlp-pname{height:20px;width:58px;padding:0 5px;border:1px solid var(--ez-border);border-radius:5px;background:var(--ez-bg);color:var(--ez-fg);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;outline:none;}
.ezlp-pname:focus{border-color:var(--ez-strong);}
.eztl-mov{height:100%;flex:0 0 auto;}
.eztl-mnet{height:100%;flex:1 1 auto;display:flex;align-items:center;padding:0 8px;overflow:hidden;position:relative;}
.eztl-mlbl{font-size:9.5px;font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--ez-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eztl-mmax{position:absolute;top:2px;right:4px;font-size:8.5px;font-weight:700;color:#c47a1a;background:rgba(196,122,26,.16);padding:0 4px;border-radius:3px;font-family:ui-monospace,monospace;}
/* ★ 左右拖拽热区（替代旧把手）：平时不可见/不可点；段被选中后左右两条变可点 —— 鼠标放上去即变左右箭头（ew-resize）。
   不画任何装饰图形（不要「细粗细」那条），就靠外框 + 两端热区，做到「外框点击选中：黑 → 绿」。 */
.eztl-medge{position:absolute;top:0;bottom:0;width:12px;transform:translateX(-50%);pointer-events:none;cursor:ew-resize;z-index:7;}
.eztl-medge.on{pointer-events:auto;}
/* 拖动时的时长提示角标（跟随被拖的那条边，浮在段上方） */
.eztl-mdrag{position:absolute;transform:translateX(-50%);background:var(--ez-fg);color:var(--ez-bg);font-size:11px;font-weight:500;font-family:ui-monospace,Menlo,Consolas,monospace;padding:2px 6px;border-radius:4px;pointer-events:none;white-space:nowrap;z-index:30;}
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
.eztl-playbar{flex-wrap:wrap;row-gap:2px;flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:6px 12px;border-top:1px solid var(--ez-border-2);background:var(--ez-surface);}
.eztl-playbtn{width:28px;height:28px;border-radius:6px;border:1px solid var(--ez-border);background:var(--ez-surface-2);color:var(--ez-fg-2);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex:0 0 auto;font-family:inherit;}
.eztl-playbtn:hover{background:var(--ez-surface-3);color:var(--ez-fg);}
.eztl-playbtn.active{background:var(--ez-strong);border-color:var(--ez-strong);color:var(--ez-on-strong);}
.eztl-time{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--ez-fg-3);display:inline-flex;gap:6px;font-variant-numeric:tabular-nums;}
.eztl-time .cur{color:var(--ez-fg);font-weight:500;min-width:52px;text-align:right;}
.eztl-time .tot{min-width:52px;}
.eztl-timeinp,.eztl-zoominp{height:24px;padding:0 6px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;text-align:center;box-sizing:border-box;-moz-appearance:textfield;appearance:textfield;}
.eztl-timeinp{width:64px;}
.eztl-vol{width:74px;height:18px;accent-color:var(--ez-strong);flex:0 0 auto;cursor:pointer;}
.ezlp-root:fullscreen{width:100vw;height:100vh;border-radius:0;padding:14px;background:var(--ez-bg);}
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
.eztl-pane{flex:1 1 auto;width:100%;min-height:180px;position:relative;display:flex;align-items:center;justify-content:center;background:var(--ez-surface-2);border-radius:9px;border:1px solid var(--ez-border-2);overflow:hidden;}
.eztl-pane img{max-width:100%;max-height:100%;border-radius:6px;display:block;background:#000;}
.eztl-pane video{width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;display:block;background:#000;}
.eztl-pane audio{width:min(520px,92%);}
.eztl-panetag{position:absolute;top:4px;left:8px;max-width:calc(100% - 16px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--ez-fg-3);background:var(--ez-surface);border:1px solid var(--ez-border-2);border-radius:100px;padding:0 8px;line-height:16px;pointer-events:none;z-index:2;}
.eztl-panehint{font-size:11px;color:var(--ez-fg-muted);}
.eztl-paneth{display:flex;align-items:center;justify-content:center;width:100%;height:100%;max-width:100%;max-height:100%;min-height:0;}
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
/* 源视频切分：加载按钮 / 源名 / 切分模式 / 指定段起止 */
.eztl-srcbtn{flex:0 0 auto;}
.eztl-srcbtn.on{background:var(--ez-strong);border-color:var(--ez-strong);color:var(--ez-on-strong);}
.eztl-splitmode{flex:0 0 auto;min-width:132px;}
.eztl-vidfmt{flex:0 0 auto;min-width:112px;}
.eztl-panevid{width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;background:#000;border-radius:6px;display:block;}
.eztl-toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:var(--ez-strong);color:var(--ez-on-strong);padding:8px 20px;border-radius:30px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.2);z-index:100200;pointer-events:none;font-family:Inter,sans-serif;}

`;
let _css = false;
function inject() { ezThemeInit(); if (_css || !document.head) return; _css = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function el(t, c, a) { const e = document.createElement(t); if (c) e.className = c; if (a) Object.keys(a).forEach((k) => e.setAttribute(k, a[k])); return e; }

function forceShell(node) {
  const p = node && node._ezlpRoot; if (!p || !p.isConnected) return;
  const si = (t, prop, val) => { try { t.style.setProperty(prop, val, 'important'); } catch (_) {} };
  si(p, 'width', '100%'); si(p, 'max-width', '100%'); si(p, 'height', '100%'); si(p, 'max-height', '100%'); si(p, 'box-sizing', 'border-box');
  if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) {
    si(p, 'top', 'var(--ezfx-vue-title,30px)');
    si(p, 'height', 'calc(100% - var(--ezfx-vue-title,30px))');
    si(p, 'bottom', 'auto');
  }
}
// 面板重建推到下一帧、按节点合并一次：工作流加载时 onConfigure 是同步的，14 个面板一起重建 DOM
// 会顶出 300ms+ 的长任务（实测 LoopEnd 29ms / LoopStart 17ms / MergeList 18ms）。
// socket/端口这些图结构改动仍在 onConfigure 里同步做，只有纯 DOM 重绘延后。
const _ezLpPend = new WeakSet();
function deferPanelUpdate(node) {
  if (!node || _ezLpPend.has(node)) return;
  _ezLpPend.add(node);
  requestAnimationFrame(() => {
    _ezLpPend.delete(node);
    try { if (node._ezlpUpdate) node._ezlpUpdate(); } catch (_) {}
  });
}
function sockStyle(node) {
  (node.outputs || []).forEach((s) => { try { s.color_on = SOCK_COLOR; s.color_off = SOCK_COLOR; s.color = SOCK_COLOR; } catch (_) {} });
  (node.inputs || []).forEach((s) => { try { s.color_on = SOCK_COLOR; s.color_off = SOCK_COLOR; s.color = SOCK_COLOR; } catch (_) {} });
  // ★ 循环两节点例外：端口颜色要跟**上游**同色（像 Reroute），所以先铺底再按上游覆盖一次
  const t = nodeTypeOf(node);
  if (t === LOOP_START || t === LOOP_END) { try { syncLoopPortColors(node); } catch (_) {} }
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
    { serialize: false, hideOnZoom: false, canvasOnly: !window.__ezflexIsVueNodes(), margin: 4, getMinHeight: () => ((opts && opts.minH) || 120), getValue: () => '{}', setValue: () => {} });
  makeDomWidgetHitThrough(widget.element || shell);
  try { node.widgets_start_y = 0; } catch (_) {}
  try { const wi = node.widgets.indexOf(widget); if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); } } catch (_) {}
  installResizeHandles(node, shell);
  // 新建节点给默认尺寸（bare = 只有数字框的极简面板，窄一点）；加载回来的节点尺寸不动
  try {
    const w = (opts && opts.width) || (bare ? 240 : MIN_W);
    const h = (opts && opts.height) || (bare ? 96 : 170);
    ezApplyDefaultSize(node, w, h);
  } catch (_) {}
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
      const lk = tlLink(g, lid); if (!lk) return;
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
    const g = node.graph; const lk = tlLink(g, inp.link); if (!lk) return '';
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
function removeInputSockets(node, names) {
  try {
    for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
      const s = node.inputs[i];
      if (s && names.indexOf(String(s.name)) >= 0 && !sockLinked(s)) {
        try { node.removeInput(i); } catch (_) { try { node.inputs.splice(i, 1); } catch (_2) {} }
      }
    }
  } catch (_) {}
}
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


// ===== 续跑方式（V1.3.7）：图展开 / 队列续跑 =====
// ★ 模式存在**配对 LoopStart 的 config** 里（`queue: true`）。为什么不放 End 自己：
//   End 没有 config 输入口，而给它新声明一个 widget 会让老工作流的 `widgets_values` **位置配对整体错位**
//   （面板自绘框 + rounds + __ezround 三段，插一个就全串位）。Start 本来就有 config，零风险。
//   配对方式与后端一致：图上**唯一**一个 LoopStart 才算数（多个就不敢猜）。
function pairedLoopStart(node) {
  const g = node.graph;
  if (g && g._nodes) {
    const starts = g._nodes.filter((n) => n && nodeTypeOf(n) === LOOP_START);
    if (starts.length === 1) return starts[0];
  }
  return null;
}
function loopQueueMode(node) {
  const s = pairedLoopStart(node);
  if (!s) return false;
  const d = readConfig(s) || {};
  return !!d.queue;
}
function setLoopQueueMode(node, on) {
  const s = pairedLoopStart(node);
  if (!s) return false;
  const d = readConfig(s) || {};
  d.queue = !!on;
  writeConfig(s, d);
  return true;
}
function loopModeRow(node, onChange) {
  const row = el('div', 'ezlp-mode');
  const seg = el('div', 'ezlp-seg');
  const cur = loopQueueMode(node);
  const mk = (on, label, tip) => {
    const b = el('button', 'ezlp-segbtn' + (cur === on ? ' active' : ''));
    b.textContent = label; b.title = tip;
    // ★ 每次点击都现查配对 LoopStart：面板首次构建时 graph 可能还没挂上 Start（加载工作流早期），
    //   若在构建时把 s 闭包住，按钮会永久失效（「点不动，改一下次数才好使」）。
    b.addEventListener('click', () => { if (!pairedLoopStart(node)) return; setLoopQueueMode(node, on); onChange && onChange(); });
    return b;
  };
  seg.appendChild(mk(false, ezT('Expand'), ezT('Unroll the whole loop inside one prompt (default).')));
  seg.appendChild(mk(true, ezT('Queue'), ezT('One prompt per round, enqueued by Loop End. Flat memory, cancellable between rounds.')));
  row.appendChild(seg);
  if (!pairedLoopStart(node)) row.title = ezT('Add exactly one Loop Start node to switch the running mode');
  return row;
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

// 口顺序/数量变了要回写连线槽位（内核按槽位取值，不回写就会把数据当成别的口）
// cap = 搬 socket 之前用 ezCaptureSocketLinks 拍的快照（新版前端的 socket.links/link 按当前下标现拼，
// 搬完再读就指到别的口上 ⇒ 必须按快照回写）。不传时退回旧写法（按当前 socket 读，等价于旧版 LiteGraph）。
// D-8：graph.links 可能是普通对象，也可能是 Map（新前端）。所有连线读取/删除统一走这里，
// 别再直接 g.links[id] —— 换成 Map 后那样会静默拿到 undefined（黑框端口名空、重排不搬线、不通知下游）。
function tlLink(g, lid) {
  const L = g && g.links;
  if (!L || lid == null) return null;
  try { return (typeof L.get === 'function') ? (L.get(lid) || null) : (L[lid] || null); } catch (_) { return null; }
}
function tlDropLink(g, lid) {
  const L = g && g.links;
  if (!L || lid == null) return;
  try { if (typeof L.delete === 'function') L.delete(lid); else delete L[lid]; } catch (_) {}
}
function reindexLinks(node, side, cap) {
  const g = node.graph; const links = g && g.links;
  if (!links) return;
  (node.outputs || []).forEach((o, i) => { try { o.slot_index = i; } catch (_) {} });
  if (cap) { ezApplySocketLinks(node, cap); return; }
  if (side !== 'out') {
    (node.inputs || []).forEach((s, i) => {
      const lid = s && s.link;
      const lk = tlLink(g, lid); if (lk) { try { lk.target_slot = i; } catch (_) {} }
    });
  }
  if (side !== 'in') {
    (node.outputs || []).forEach((o, i) => {
      const ids = []; if (o && Array.isArray(o.links)) ids.push(...o.links); if (o && o.link != null) ids.push(o.link);
      ids.forEach((lid) => { const lk = tlLink(g, lid); if (lk) { try { lk.origin_slot = i; } catch (_) {} } });
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
    const lk = tlLink(g, lid);
    if (!lk) return;
    // 新版前端：链接在 graph.links(LinkMap) 里，socket.links 只是按下标现拼的视图（改它会断线）。
    // 交给内核 removeLink 连带清目标输入口；旧版才手改 socket.links / input.link。
    if (g.links instanceof Map && typeof g.removeLink === 'function') {
      try { g.removeLink(lid); } catch (_) { tlDropLink(g, lid); }
      return;
    }
    try {
      const on = g.getNodeById ? g.getNodeById(lk.origin_id) : null;
      const tn = g.getNodeById ? g.getNodeById(lk.target_id) : null;
      if (on && on.outputs && on.outputs[lk.origin_slot] && Array.isArray(on.outputs[lk.origin_slot].links)) {
        const i = on.outputs[lk.origin_slot].links.indexOf(lid);
        if (i >= 0) on.outputs[lk.origin_slot].links.splice(i, 1);
      }
      if (tn && tn.inputs && tn.inputs[lk.target_slot] && tn.inputs[lk.target_slot].link == lid) tn.inputs[lk.target_slot].link = null;
    } catch (_) {}
    tlDropLink(g, lid);
  };
  const dropSlot = (s, arr, i) => {
    [s.link, ...(Array.isArray(s.links) ? s.links : [])].forEach(killLink);
    s.link = null; if (!(g && g.links instanceof Map)) s.links = []; s.widget = null;
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
function ensureFixedLoopOutputs(node) {
  if (nodeTypeOf(node) !== LOOP_START) return;
  for (let i = (node.outputs || []).length - 1; i >= 0; i--) {
    const s = node.outputs[i];
    const n = String((s && s.name) || '');
    if (n === 'next_video' || n === 'next_latent' || /^ref\d+$/.test(n)) node.removeOutput(i);
  }
}
function trimLoopSockets(node) {
  const start = nodeTypeOf(node) === LOOP_START;
  ensurePlanPort(node);          // ★ End 的 timeplan 输入/输出口：老工作流里没有，先补齐再排顺
  if (start) ensureFixedLoopOutputs(node);
  const cap = ezCaptureSocketLinks(node);   // ★ 下面要搬 socket 顺序：先按对象拍连线快照
  const maxN = LOOP_MAX_SLOT;
  if (start) {
    const outs = node.outputs || [];
    const ix = outs.findIndex((s) => s && s.name === 'index');
    if (ix > 0) { outs.unshift(outs.splice(ix, 1)[0]); reindexLinks(node, 'out', cap); }
    const { arr, nums } = numberedSlots(node, /^value\d+$/, 'out');
    const used = nums.filter((n, k) => sockLinked(arr[k]));
    let want = Math.min(maxN, Math.max(1, (used.length ? Math.max.apply(null, used) : 0) + 1));
    for (let i = (node.outputs || []).length - 1; i >= 0; i--) {
      const s = node.outputs[i];
      const n = parseInt(String(s && s.name).replace(/\D/g, ''), 10) || 0;
      if (/^value\d+$/.test(s.name) && !sockLinked(s) && n > want) node.removeOutput(i);
    }
    // ★ 与配对的 LoopEnd 输入口实时对应：End 有 value1..3（即使 Start 这边没连线），
    //   Start 也显示 value1..3；Start 自己连了下一位时仍按 want 补空口。
    const _end = pairedLoopEnd(node);
    if (_end) {
      const _e = numberedSlots(_end, /^value\d+$/, 'in');
      const _en = _e.nums.filter((n, k) => sockLinked(_e.arr[k]));
      if (_en.length) want = Math.max(want, Math.max.apply(null, _en));
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
    // ★ 输出口数量跟输入口对齐（valueN 有 6 个就 out1..out6），再并上「已连最大编号+1」
    const owant = Math.min(maxN, Math.max(want, (oused.length ? Math.max.apply(null, oused) : 0) + 1));
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
  // widget 型输入在 Nodes 2.0 会被画成 socket，挤在第一个口上 → 直接摘掉（widget 本身还在）
  if (!start) removeInputSockets(node, ['rounds', 'rerun_stop', 'persist']);
  stripInputWidgets(node, start ? ['index'] : ['rounds']);
  reindexLinks(node, 'both', cap);
  sockStyle(node);
}

// 端口排顺：迁移过来的口顺序是乱的（product1 可能排在 product0 前面）。
// 规则：Start 侧 index → value1..N → initial value1..N；End 侧 timeplan → value1..N → 其它保留口，
//       出口 timeplan → out1..N（**timeplan 必须排第一**，用户要求）。
// ★ 重排后必须 reindexLinks，否则内核按槽位取值会张冠李戴。
function sortLoopSockets(node, start) {
  const key = (s) => {
    const n = String((s && s.name) || '');
    if (n === 'timeplan') return [-1, 0];      // ★ 规划透传口永远排最前（输入/输出都是）
    if (n === 'index') return [0, 0];
    if (n === 'rounds') return [9, 0];
    let m = /^value(\d+)$/.exec(n);
    if (m) return [1, parseInt(m[1], 10) || 0];
    m = /^initial value(\d+)$/.exec(n);
    if (m) return [2, parseInt(m[1], 10) || 0];
    m = /^out(\d+)$/.exec(n);
    if (m) return [3, parseInt(m[1], 10) || 0];
    m = /^ref(\d+)$/.exec(n);
    if (m) return [4, parseInt(m[1], 10) || 0];
    return [8, 0];   // 其它（保留口）排最后
  };
  const seq = (arr) => (arr || []).map((s, i) => ({ s, i })).sort((a, b) => {
    const ka = key(a.s); const kb = key(b.s);
    return ka[0] !== kb[0] ? ka[0] - kb[0] : (ka[1] !== kb[1] ? ka[1] - kb[1] : a.i - b.i);
  }).map((x) => x.s);
  if (start) node.outputs = seq(node.outputs);
  else { node.inputs = seq(node.inputs); node.outputs = seq(node.outputs); }
}

// ★ LoopEnd 的 `timeplan` **输出**口迁移（老工作流没有这个口）。
//   为什么必须补：内核 `configure` 恢复端口时 `LiteGraph.cloneObject` 是**按源数组下标**逐个覆盖的
//   （`for (const i in r) target[i] = r[i]`）—— 老工作流序列化的 outputs 是 `[out1, out2, …]`，
//   会把类里声明在第 0 位的 `timeplan` **整个顶掉**，于是加载后根本没有 timeplan 口。
//   这里补一个（append 到末尾），随后 `sortLoopSockets` 把它挪到第 0 位、`reindexLinks` 重盖
//   所有连线的 `origin_slot`，老工作流的 outN 连线不会错位。
//   ⚠️ 输入口同样会丢：类里 `optional.timeplan` 在第 0 位，老工作流序列化的 inputs 是
//      `[value1, value2, …]`，一样会把它顶掉 ⇒ 输入/输出都要补。
function ensurePlanPort(node) {
  if (nodeTypeOf(node) !== LOOP_END) return;
  if (!(node.inputs || []).some((s) => s && s.name === 'timeplan')) {
    try { node.addInput('timeplan', 'EZFLEX_TIMEPLAN'); } catch (_) {}
  }
  if (!(node.outputs || []).some((s) => s && s.name === 'timeplan')) {
    try { node.addOutput('timeplan', 'EZFLEX_TIMEPLAN'); } catch (_) {}
  }
}

// 端口黑框标签：**照端口名原样显示**（value1 / value2 / out1 / initial value1），不要缩成 1 / 2。
// 用户明确要求：「黑框标签里应该是 value1、value2……而不是 1、2……」
// 只有旧工作流迁移没覆盖到的端口才回落空串（不画标签）。
function portLabel(s) {
  if (!s) return '';
  const custom = String(s._ezLabel || '').trim();
  if (custom) return custom;
  const n = String(s.name || '');
  if (n === 'index' || n === 'rounds') return n;
  if (n === 'timeplan') return n;          // LoopEnd 的规划透传口（输入 + 输出同名）
  if (/^(initial value|value|out)\d+$/.test(n)) return n;
  if (/^ref\d+$/.test(n)) return n;
  return '';
}

// ===== ★ 端口「名字 + 类型」（像 Reroute）：连上就知道这根线里跑的是什么 =====
// 类型取**上游那个输出口**的 type，颜色也跟上游同色（VAE 红 / CLIP 黄 / MODEL 紫…）。
//   · LoopEnd 的 valueK 入口  → 直接看它连着的上游
//   · LoopEnd 的 outK 出口    → 同号 valueK 入口的上游（回喂给下一轮的就是这个值）
//   · LoopStart 的 valueK 出口 → **配对 LoopEnd** 同号 valueK 入口的上游；
//                              拿不到就退回本节点 `initial valueK`（第 0 轮走的就是它）
// 取色链与 reroute_node.js 一致：`slot.color_on || colorContext.getConnectedColor(type)`。
function loopTypeColor(type) {
  if (!type) return null;
  try { const byType = app && app.canvas && app.canvas.default_connection_color_byType; if (byType && byType[type]) return byType[type]; } catch (_) {}
  try {
    const LGC = (typeof LGraphCanvas !== 'undefined' && LGraphCanvas) ? LGraphCanvas : null;
    const ltc = LGC && LGC.link_type_colors;
    if (ltc && ltc[type]) return ltc[type];
  } catch (_) {}
  return null;
}
function loopSockColor(s) {
  if (!s) return null;
  return s.color_on || s.color || loopTypeColor(s.type) || null;
}
function loopSockName(s) {
  if (!s) return '';
  const l = s._ezLabel || s.label;
  const t = (l && String(l).trim()) ? String(l).trim() : '';   // ' ' 是 truthy，必须 trim
  return t || String(s.name || '');
}
function loopUpstreamSock(node, slot) {
  try {
    const up = tlUpstream(node, slot);
    const s = (up && up.origin && up.origin.outputs) ? up.origin.outputs[up.slot] : null;
    if (!s) return null;
    return { name: loopSockName(s), type: String(s.type == null ? '' : s.type), color: loopSockColor(s) };
  } catch (_) { return null; }
}
function pairedLoopEnd(node) {
  const g = node.graph;
  if (g && g._nodes) {
    const ends = g._nodes.filter((n) => n && nodeTypeOf(n) === LOOP_END);
    if (ends.length === 1) return ends[0];
  }
  return null;
}
function sockIndex(node, name, isIn) {
  const arr = (isIn ? node.inputs : node.outputs) || [];
  return arr.findIndex((s) => s && String(s.name) === name);
}
// 这个出口里的值「从哪来」（用来取类型 / 颜色）
function loopOutSource(node, sock) {
  const nm = String((sock && sock.name) || '');
  const isStart = nodeTypeOf(node) === LOOP_START;
  // ★ LoopEnd 的 timeplan 透传出口：来源 = 本节点 timeplan 入口的上游（类型/颜色都照它）
  if (!isStart && nm === 'timeplan') {
    const si = sockIndex(node, 'timeplan', true);
    return si >= 0 ? loopUpstreamSock(node, si) : null;
  }
  if (isStart) {
    const m = /^value(\d+)$/.exec(nm);
    if (!m) return null;
    const end = pairedLoopEnd(node);
    if (end) {
      const si = sockIndex(end, 'value' + m[1], true);
      if (si >= 0) { const u = loopUpstreamSock(end, si); if (u && u.type) return u; }
    }
    const ii = sockIndex(node, 'initial value' + m[1], true);
    return ii >= 0 ? loopUpstreamSock(node, ii) : null;
  }
  const m = /^out(\d+)$/.exec(nm);
  if (!m) return null;
  const si = sockIndex(node, 'value' + m[1], true);
  return si >= 0 ? loopUpstreamSock(node, si) : null;
}
// 黑框标签：端口名（value1 / out1 / initial value1 / index / rounds）+「 · 类型」
function loopPortLabel(node, s, i, isIn) {
  const nm = portLabel(s);
  if (!nm) return '';
  const raw = String((s && s.name) || '');
  const mm = /^(?:initial\s+)?value(\d+)$/.exec(raw) || /^out(\d+)$/.exec(raw);
  const num = mm ? String(parseInt(mm[1], 10)) : '';
  const custom = String((s && s._ezLabel) || '').trim();
  // ★ 编号常显：卡片/端口多了以后光看名字对不上（用户要求）。有自定义名就 "#K 名字"。
  if (custom) return num ? ('#' + num + ' ' + custom) : custom;
  if (nm === 'index' || nm === 'rounds') return nm;
  const src = isIn ? loopUpstreamSock(node, i) : loopOutSource(node, s);
  const t = (src && src.type && src.type !== '*') ? src.type : '';
  const base = num ? ('#' + num) : nm;
  return t ? (base + ' · ' + t) : base;
}
// 端口颜色跟上游同色；没接 / 查不到 ⇒ 回落本插件统一的绿
function syncLoopPortColors(node) {
  const apply = (s, i, isIn) => {
    if (!s) return;
    let c = null;
    try {
      const src = isIn ? loopUpstreamSock(node, i) : loopOutSource(node, s);
      c = src ? src.color : null;
    } catch (_) { c = null; }
    try { if (c) { s.color_on = c; s.color_off = c; } else { s.color_on = SOCK_COLOR; s.color_off = SOCK_COLOR; } } catch (_) {}
  };
  (node.inputs || []).forEach((s, i) => apply(s, i, true));
  (node.outputs || []).forEach((s, i) => apply(s, i, false));
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
      const d = readConfig(node) || {};
      // 新建节点（config 里还没有 refs）只给一个 index 框 —— 和 LoopEnd 的「次数」框对称。
      // 参考卡片是长视频工作流才用的：只有 config.refs 存在（老图/显式配置过）时才显示。
      if (!Array.isArray(d.refs) || !d.refs.length) {
        // 新建节点：**连出去几个 value，就画几张卡片**（编号 + 自定义名 + 类型），和 LoopEnd 的 value 卡片对称。
        // 没有连线 → 面板为空（index 框以前就删过，别再加回来）。
        root.innerHTML = '';
        trimLoopSockets(node);
        const conf = (d.values && typeof d.values === 'object') ? d.values : {};
        const save = () => { const c = readConfig(node) || {}; c.values = conf; writeConfig(node, c); };
        const wrap = el('div', 'ezlp-refs');
        let rows = 0;
        (node.outputs || []).forEach((s) => {
          const m = /^value(\d+)$/.exec(s && s.name ? s.name : '');
          if (!m || !(s.links && s.links.length)) return;      // 没连出去就不画
          const k = parseInt(m[1], 10);
          const c = conf[k] || (conf[k] = { name: '', type: 'auto' });
          const row = el('div', 'ezlp-ref');
          const no = el('span', 'ezlp-no'); no.textContent = String(k);
          const nm = el('input'); nm.type = 'text'; nm.value = c.name || ''; nm.placeholder = 'value' + k;
          nm.title = ezT('Custom port name');
          nm.style.cssText = 'flex:1 1 auto;min-width:0;height:24px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-bg);color:var(--ez-fg);font:inherit;font-size:11px;padding:0 6px;';
          nm.addEventListener('change', () => {
            c.name = String(nm.value || '').trim();
            save();
            try { s._ezLabel = c.name; } catch (_) {}
            try { node.setDirtyCanvas && node.setDirtyCanvas(true, false); } catch (_) {}
          });
          const typ = el('select');
          [['frames', ezT('Frames')], ['video', ezT('Video')], ['audio', ezT('Audio')], ['latent', ezT('Latent')]].forEach(([v, tx]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = tx; typ.appendChild(o);
          });
          typ.value = (c.type === 'frames' || c.type === 'image') ? 'frames'
            : (c.type === 'video' || c.type === 'audio') ? c.type : 'latent';
          typ.title = ezT('Value type (display only)');
          typ.addEventListener('change', () => { c.type = typ.value; save(); });
          row.appendChild(no); row.appendChild(nm); row.appendChild(typ);
          wrap.appendChild(row);
          rows += 1;
          try { s._ezLabel = c.name || ''; } catch (_) {}
        });
        if (rows) root.appendChild(wrap);
        return;
      }
      let refs = Array.isArray(d.refs) ? d.refs.slice(0, 4) : null;
      if (!refs) refs = [
        { role: 'prev', type: 'frames', timeline: true, count: 5 },
        { role: 'next', type: 'frames', timeline: true, count: 5 },
        { role: 'cur', type: 'latent', timeline: false, count: 1 },
        { role: 'next', type: 'audio', timeline: false, count: 5 },
      ];
      while (refs.length < 4) refs.push({ role: 'prev', type: 'frames', timeline: false, count: 5 });
      const saveRefs = () => {
        const c = readConfig(node) || {};
        c.refs = refs.slice(0, 4);
        writeConfig(node, c);
      };
      const wrap = el('div', 'ezlp-refs');
      refs.forEach((c, i) => {
        const row = el('div', 'ezlp-ref');
        const no = el('span', 'ezlp-no'); no.textContent = String(i + 1);
        const tl = el('button', 'ezlp-tg'); tl.type = 'button';
        tl.textContent = 'TimeLine';
        tl.title = ezT('Receive TimeLine control');
        const paintTl = () => { tl.classList.toggle('on', c.timeline !== false); };
        tl.addEventListener('click', () => { c.timeline = (c.timeline === false); paintTl(); saveRefs(); });
        paintTl();
        const role = el('select');
        [['prev', ezT('Prev segment')], ['cur', ezT('Current segment')], ['next', ezT('Next segment')]].forEach(([v, t]) => {
          const o = document.createElement('option'); o.value = v; o.textContent = t; role.appendChild(o);
        });
        role.value = c.role || 'prev';
        role.addEventListener('change', () => { c.role = role.value; saveRefs(); });
        const typ = el('select');
        [['frames', ezT('Frames')], ['video', ezT('Video')], ['audio', ezT('Audio')], ['latent', ezT('Latent')]].forEach(([v, t]) => {
          const o = el('option'); o.value = v; o.textContent = t; typ.appendChild(o);
        });
        // 旧类型映射：image→frames，mask/tensor/conditioning/auto→latent（读文件时同一套加载分支）
        typ.value = (c.type === 'frames' || c.type === 'image') ? 'frames'
          : (c.type === 'video' || c.type === 'audio') ? c.type : 'latent';
        const rng = el('input'); rng.type = 'text'; rng.value = String(c.range || (c.count ? '-' + c.count : '-5'));
        rng.style.cssText = 'width:42px;height:24px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-bg);color:var(--ez-fg);font:inherit;font-size:11px;text-align:center;';
        rng.title = ezT('Range: -5 = last 5, 0 = all');
        const paintRng = () => { rng.style.display = (typ.value === 'frames') ? '' : 'none'; };
        typ.addEventListener('change', () => { c.type = typ.value; paintRng(); saveRefs(); });
        paintRng();
        rng.addEventListener('change', () => { c.range = String(rng.value || '').trim() || '-5'; rng.value = c.range; saveRefs(); });
        row.appendChild(no); row.appendChild(tl); row.appendChild(role); row.appendChild(typ); row.appendChild(rng);
        wrap.appendChild(row);
      });
      root.innerHTML = ''; root.appendChild(wrap);
      trimLoopSockets(node);
      const end = pairedLoopEnd(node);
      if (end) { try { applyPersistLabels(end, readPersist(end)); } catch (_) {} }
    };
    const paint = () => { try { render(); } catch (_) {} };
    node._ezlpUpdate = render;
    render();
  }, { bare: true, width: START_W, height: 120, minH: 96 });
  sockStyle(node);
  installEdgeLabels(node, { side: 'both', rootOf: (n) => n._ezlpRoot, labelOf: (s, i, isIn) => loopPortLabel(node, s, i, isIn) });
}

// ★★ 接上 `timeplan` 时「次数」自动跟着**规划的段数**走。
//   以前 TimePlan 明明知道 total，却没有任何口能喂进 LoopEnd，只能手抄段数 —— 改了 TimePlan 的
//   每段时长就忘了改次数 ⇒ 少跑/多跑一轮。后端 `_total_from` 已改成「有 timeplan 就以它为准」，
//   这里让面板**显示同一个数**（并把手动框变灰），免得面板显示的和实际跑的对不上。
//   返回 null = 没接规划 / 追不到 ⇒ 用手动框。
function planRounds(node) {
  try {
    if (!tlUpstreamPlanNode(node)) return null;
    const p = tlPlan(node);
    const n = (p && Array.isArray(p.segs)) ? p.segs.length : 0;
    return n > 0 ? n : null;
  } catch (_) { return null; }
}

// ===== LoopEnd 面板：只有一个「次数」框 =====
// ★ 同样不画卡片行、不画标题/徽标/提示（见 setupLoopStart 注释）。端口动态增减仍在 render 里。
function readPersist(node) {
  const w = widgetOf(node, 'persist');
  let d = null;
  try { d = JSON.parse((w && w.value) || '{}'); } catch (_) { d = null; }
  const p = node && node.properties && node.properties.ezPersist;
  if ((!d || (!Array.isArray(d.ports) && !Array.isArray(d.types))) && p && typeof p === 'object') {
    d = p;
    if (w && !w.value) w.value = JSON.stringify(p);   // 老图/隐藏 widget 没存值时，从 properties 回填
  }
  d = (d && typeof d === 'object') ? d : {};
  const names = {};
  if (d.names && typeof d.names === 'object') {
    Object.keys(d.names).forEach((k) => {
      const kk = parseInt(k, 10);
      const v = String(d.names[k] || '').trim();
      if (kk > 0 && v) names[kk] = v;
    });
  }
  return { ports: new Set((d.ports || []).map((x) => parseInt(x, 10))), types: new Set(d.types || []), names, cards: (d.cards && typeof d.cards === 'object') ? d.cards : {} };
}
function savePersist(node, st) {
  const names = {};
  Object.keys(st.names || {}).forEach((k) => {
    const kk = parseInt(k, 10);
    const v = String(st.names[k] || '').trim();
    if (kk > 0 && v) names[kk] = v;
  });
  Object.keys(st.cards || {}).forEach((k) => {
    const kk = parseInt(k, 10);
    if (!(kk > 0)) return;
    const nm = String((st.cards[k] || {}).name || '').trim();
    if (nm) names[kk] = nm;
    else delete names[kk];        // ★ 卡片名被清空 ⇒ 旧名必须一起删，否则重载又冒出来
  });
  const data = { ports: Array.from(st.ports).sort((a, b) => a - b), types: Array.from(st.types), names, cards: st.cards || {} };
  const w = widgetOf(node, 'persist');
  if (w) w.value = JSON.stringify(data);
  try {
    node.properties = node.properties || {};
    node.properties.ezPersist = data;               // 刷新/切工作流后从 properties 还原
    node.setDirtyCanvas && node.setDirtyCanvas(true, true);
  } catch (_) {}
}
const EZ_PERSIST_TYPES = ['latent', 'image', 'audio', 'video', 'mask', 'tensor', 'conditioning'];
function persistPanel(node, paint) {
  const st = readPersist(node);
  const wrap = el('div', 'ezlp-persist');
  const bar = el('div', 'ezlp-persist-bar');
  const mk = (txt, fn) => { const b = el('button', 'ezlp-chip', { type: 'button' }); b.textContent = txt; b.addEventListener('click', fn); return b; };
  const repaint = () => { try { paint(); } catch (_) {} };   // 由 setupLoopEnd 传入
  bar.appendChild(mk(ezT('Select all'), () => {
    (node.inputs || []).forEach((s) => { const m = /^value(\d+)$/.exec(s.name || ''); if (m && s.link != null) st.ports.add(parseInt(m[1], 10)); });
    EZ_PERSIST_TYPES.forEach((t) => st.types.add(t)); savePersist(node, st); repaint();
  }));
  bar.appendChild(mk(ezT('Invert'), () => {
    const all = (node.inputs || []).map((s) => { const m = /^value(\d+)$/.exec(s.name || ''); return (m && s.link != null) ? parseInt(m[1], 10) : 0; }).filter(Boolean);
    st.ports = new Set(all.filter((k) => !st.ports.has(k)));
    st.types = new Set(EZ_PERSIST_TYPES.filter((t) => !st.types.has(t)));
    savePersist(node, st); repaint();
  }));
  bar.appendChild(mk(ezT('Clear'), () => { st.ports.clear(); st.types.clear(); savePersist(node, st); repaint(); }));
  wrap.appendChild(bar);
  // 端口（已连接的 valueK）：1 行 3 个，点击变绿 = 落盘
  const grid = el('div', 'ezlp-persist-grid');
  let row = null;
  (node.inputs || []).forEach((s) => {
    const m = /^value(\d+)$/.exec(s.name || '');
    if (!m || s.link == null) return;
    const k = parseInt(m[1], 10);
    if (!row || row.childNodes.length >= 3) { row = el('div', 'ezlp-persist-row'); grid.appendChild(row); }
    const c = el('button', 'ezlp-chip' + (st.ports.has(k) ? ' on' : ''), { type: 'button' });
    c.textContent = 'value' + k;
    c.addEventListener('click', () => { if (st.ports.has(k)) st.ports.delete(k); else st.ports.add(k); savePersist(node, st); repaint(); });
    row.appendChild(c);
  });
  wrap.appendChild(grid);
  // 类型筛选：点击变绿
  const trow = el('div', 'ezlp-persist-row');
  EZ_PERSIST_TYPES.forEach((t) => {
    const c = el('button', 'ezlp-chip' + (st.types.has(t) ? ' on' : ''), { type: 'button' });
    c.textContent = t;
    c.addEventListener('click', () => { if (st.types.has(t)) st.types.delete(t); else st.types.add(t); savePersist(node, st); repaint(); });
    trow.appendChild(c);
  });
  wrap.appendChild(trow);
  return wrap;
}
function persistFilter(node, paint) {
  const st = readPersist(node);
  const d = el('details', 'ezlp-filter');
  d.open = !!node._ezPersistOpen;
  const sum = el('summary'); sum.textContent = ezT('Persist filter');
  d.appendChild(sum);
  try {
    if (node._ezPersistDoc) document.removeEventListener('pointerdown', node._ezPersistDoc, true);
  } catch (_) {}
  d.addEventListener('toggle', () => {
    node._ezPersistOpen = !!d.open;
    if (node._ezPersistOpen) {
      node._ezPersistDoc = (ev) => {
        if (d.contains(ev.target)) return;
        node._ezPersistOpen = false;
        try { document.removeEventListener('pointerdown', node._ezPersistDoc, true); } catch (_) {}
        node._ezPersistDoc = null;
        paint();
      };
      document.addEventListener('pointerdown', node._ezPersistDoc, true);
    } else {
      try { if (node._ezPersistDoc) document.removeEventListener('pointerdown', node._ezPersistDoc, true); } catch (_) {}
      node._ezPersistDoc = null;
    }
  });
  const body = el('div', 'ezlp-filter-body');
  const mk = (txt, fn, on) => { const b = el('button', 'ezlp-chip' + (on ? ' on' : ''), { type: 'button' }); b.textContent = txt; b.addEventListener('click', fn); return b; };
  const row = el('div', 'ezlp-persist-bar');
  row.appendChild(mk(ezT('Select all'), () => { EZ_PERSIST_TYPES.forEach((t) => st.types.add(t)); savePersist(node, st); paint(); }, st.types.size === EZ_PERSIST_TYPES.length));
  row.appendChild(mk(ezT('Invert'), () => { st.types = new Set(EZ_PERSIST_TYPES.filter((t) => !st.types.has(t))); savePersist(node, st); paint(); }, false));
  row.appendChild(mk(ezT('Clear'), () => { st.types.clear(); savePersist(node, st); paint(); }, false));
  body.appendChild(row);
  const trow = el('div', 'ezlp-persist-row');
  EZ_PERSIST_TYPES.forEach((t) => {
    const c = mk(t, () => { if (st.types.has(t)) st.types.delete(t); else st.types.add(t); savePersist(node, st); paint(); }, st.types.has(t));
    trow.appendChild(c);
  });
  body.appendChild(trow);
  d.appendChild(body);
  return d;
}
function persistCards(node, paint) {
  const st = readPersist(node);
  st.cards = (st.cards && typeof st.cards === 'object') ? st.cards : {};
  const wrap = el('div', 'ezlp-persist-cards');
  (node.inputs || []).forEach((s) => {
    const m = /^value(\d+)$/.exec(s.name || '');
    if (!m || s.link == null) return;
    const k = parseInt(m[1], 10);
    const c = st.cards[k] || (st.cards[k] = { enabled: st.ports.has(k), name: st.names[k] || '', type: 'auto', range: '-5' });
    const row = el('div', 'ezlp-persist-card');
    const no = el('span', 'ezlp-persist-no'); no.textContent = String(k);   // 卡片序号（不带 #）：和端口上的 #K 对应
    no.title = ezT('Port number');
    const tl = el('button', 'ezlp-tg'); tl.type = 'button'; tl.textContent = 'Save';
    const paintTl = () => tl.classList.toggle('on', !!c.enabled);
    tl.addEventListener('click', () => { c.enabled = !c.enabled; paintTl(); savePersist(node, st); applyPersistLabels(node, st); });
    paintTl();
    const nm = el('input'); nm.type = 'text'; nm.value = c.name || ''; nm.placeholder = 'value' + k;
    nm.title = ezT('Custom saved name');
    nm.addEventListener('input', () => { c.name = String(nm.value || '').trim(); applyPersistLabels(node, st); });
    nm.addEventListener('change', () => { c.name = String(nm.value || '').trim(); savePersist(node, st); applyPersistLabels(node, st); });
    const typ = el('select');
    [['frames', ezT('Frames')], ['auto', ezT('Other')]].forEach(([v, t]) => {
      const o = el('option'); o.value = v; o.textContent = t; typ.appendChild(o);
    });
    // 旧工作流里的其它类型（latent/audio/video/mask…）统一按「其他」处理：接收啥存啥。
    typ.value = (c.type === 'frames') ? 'frames' : 'auto';
    const rng = el('input'); rng.type = 'text'; rng.value = c.range || '-5'; rng.title = ezT('Range: -5 = last 5, 0 = all');
    const paintRng = () => { rng.style.display = (typ.value === 'frames') ? '' : 'none'; };
    typ.addEventListener('change', () => { c.type = typ.value; paintRng(); savePersist(node, st); });
    paintRng();
    rng.addEventListener('change', () => { c.range = String(rng.value || '').trim() || '-5'; savePersist(node, st); });
    row.appendChild(no); row.appendChild(tl); row.appendChild(nm); row.appendChild(typ); row.appendChild(rng);
    wrap.appendChild(row);
  });
  applyPersistLabels(node, st);
  return wrap;
}
function applyPersistLabels(node, st) {
  const names = st && st.names ? st.names : {};
  const start = pairedLoopStart(node);
  // ★ 卡片存在时以卡片名为准（**空串也算准**）：以前空串会回退到 names[k] 里的旧名，
  //   于是「把黑框标签的内容删掉」之后标签还显示旧文字（用户报过）。
  const nameOf = (k) => {
    const c = st.cards && st.cards[k];
    if (c && typeof c.name === 'string') return c.name;
    return names[k] || '';
  };
  (node.inputs || []).forEach((s) => {
    const m = /^value(\d+)$/.exec(s && s.name ? s.name : '');
    if (m) { try { s._ezLabel = nameOf(m[1]); } catch (_) {} }
  });
  (node.outputs || []).forEach((s) => {
    const m = /^out(\d+)$/.exec(s && s.name ? s.name : '');
    if (m) { try { s._ezLabel = nameOf(m[1]); } catch (_) {} }
  });
  if (start) {
    (start.outputs || []).forEach((s) => {
      const m = /^value(\d+)$/.exec(s && s.name ? s.name : '');
      if (m) { try { s._ezLabel = nameOf(m[1]); } catch (_) {} }
    });
    (start.inputs || []).forEach((s) => {
      const m = /^initial value(\d+)$/.exec(s && s.name ? s.name : '');
      if (m) { try { s._ezLabel = nameOf(m[1]); } catch (_) {} }
    });
  }
  try { node.graph && node.graph.setDirtyCanvas && node.graph.setDirtyCanvas(true, true); } catch (_) {}
  try { if (node._eztlRefresh) node._eztlRefresh(); } catch (_) {}
}
function persistPorts(node, paint) {
  const st = readPersist(node);
  const wrap = el('div', 'ezlp-ports');
  let anchor = -1;
  (node.inputs || []).forEach((s) => {
    const m = /^value(\d+)$/.exec(s.name || '');
    if (!m || s.link == null) return;
    const k = parseInt(m[1], 10);
    const labelOf = () => 'value' + k + (st.names[k] ? ' · ' + st.names[k] : '');
    const c = el('button', 'ezlp-chip' + (st.ports.has(k) ? ' on' : ''), { type: 'button' });
    c.textContent = labelOf();
    c.title = ezT('Click to toggle; double-click to rename the saved file');
    let clickTimer = 0;
    const toggle = (e) => {
      if (e.shiftKey && anchor > 0) {
        const all = (node.inputs || []).map((x) => { const mm = /^value(\d+)$/.exec(x.name || ''); return (mm && x.link != null) ? parseInt(mm[1], 10) : 0; }).filter(Boolean);
        const a = all.indexOf(anchor), b = all.indexOf(k);
        if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) st.ports.add(all[i]); }
      } else if (e.ctrlKey || e.metaKey) {
        if (st.ports.has(k)) st.ports.delete(k); else st.ports.add(k);
      } else {
        st.ports.clear(); st.ports.add(k);
      }
      anchor = k;
      savePersist(node, st); paint();
    };
    c.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.detail > 1) { if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0; } return; }
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { clickTimer = 0; toggle(e); }, 180);
    });
    c.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0; }
      const inp = el('input', 'ezlp-pname');
      inp.type = 'text';
      inp.value = st.names[k] || '';
      inp.placeholder = 'value' + k;
      inp.title = ezT('Double-click to edit; blur/Enter saves');
      c.style.display = 'none';
      wrap.insertBefore(inp, c.nextSibling);
      const done = () => {
        if (!inp.isConnected) return;
        const v = String(inp.value || '').trim();
        if (v) st.names[k] = v; else delete st.names[k];
        savePersist(node, st);
        inp.remove();
        c.style.display = '';
        c.textContent = labelOf();
      };
      inp.addEventListener('blur', done);
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
        else if (ev.key === 'Escape') { inp.value = st.names[k] || ''; inp.blur(); }
      });
      setTimeout(() => { try { inp.focus(); inp.select(); } catch (_) {} }, 0);
    });
    wrap.appendChild(c);
  });
  return wrap;
}
function setupLoopEnd(node) {
  migrateLoopSockets(node);
  try {
    const oldCfg = node.onConfigure;
    node.onConfigure = function () {
      const r = oldCfg ? oldCfg.apply(this, arguments) : undefined;
      try {
        const p = this.properties && this.properties.ezPersist;
        const w = widgetOf(this, 'persist');
        if (p && w) w.value = JSON.stringify(p);
      } catch (_) {}
      return r;
    };
  } catch (_) {}
  // 老工作流可能把 rerun_stop 存成空串/字符串 → 队列校验会报 "无法转换为 INT"；加载时归一成 -1。
  try {
    const w = widgetOf(node, 'rerun_stop');
    if (w && !/^-?\d+$/.test(String(w.value == null ? '' : w.value).trim())) w.value = -1;
  } catch (_) {}
  hideOneWidget(node, 'rounds');
  hideOneWidget(node, '__ezround');
  hideOneWidget(node, 'rerun_stop');   // 区间重跑内部参数：不是给用户看的
  hideOneWidget(node, 'persist');      // 落盘配置由面板绘制
  mount(node, ezT('Loop End'), (root) => {
    const render = () => {
      try {
        const rw = widgetOf(node, 'rerun_stop');
        if (rw && !/^-?\d+$/.test(String(rw.value == null ? '' : rw.value).trim())) rw.value = -1;
        const rdw = widgetOf(node, 'rounds');
        if (rdw && !/^\d+$/.test(String(rdw.value == null ? '' : rdw.value).trim())) rdw.value = 1;
        const pw = widgetOf(node, 'persist');
        if (pw) { try { JSON.parse(pw.value || ''); } catch (_) { pw.value = ''; } }
      } catch (_) {}
      // ★ 接上 `timeplan` ⇒ 次数由规划说了算（框里显示规划算出来的段数，并变灰）
      const pr = planRounds(node);
      const { box, inp, note } = numRow(ezT('Rounds'), (pr != null) ? pr : roundsOf(node), '',
                                        (v) => { setRounds(node, v); paint(); });
      if (note && note.remove) note.remove();     // ⚠️ 别用 querySelector（测试的极简 DOM 没实现）
      if (pr != null && inp) {
        try {
          inp.disabled = true;
          inp.title = ezT('Follow plan') + ' · ' + pr;
        } catch (_) {}
      }
      const top = el('div', 'ezlp-persist-top');
      box.classList.add('only');
      top.appendChild(box);
      top.appendChild(loopModeRow(node, paint));   // 次数 + 续跑方式同一行
      root.innerHTML = ''; root.appendChild(top);
      root.appendChild(persistCards(node, paint));   // 每口一张：落盘 / 名称 / 类型 / 范围
      trimLoopSockets(node);
      try { applyPersistLabels(node, readPersist(node)); } catch (_) {}
      hideOneWidget(node, 'rounds');
      hideOneWidget(node, '__ezround');
      // ★ 把 valueK 入口上的「媒体项」（_ezItems：MediaOut / MergeList / SplitList 会盖章）镜像到
      //   对应的 outK 出口上 —— 下游 TimeLine 的 video 口读的正是**上游 socket 的 _ezItems**，
      //   不镜像的话接到 LoopEnd 上预览是空的。
      //   ⚠️ 必须**按名字**找 outN：`timeplan` 现在占了出口第 0 位，用下标 `outs[k]` 会整体错一位。
      const outs = node.outputs || [];
      outs.forEach((o) => { if (o) o._ezItems = []; });
      (node.inputs || []).forEach((s, slot) => {
        const m = /^value(\d+)$/.exec(s && s.name ? s.name : '');
        if (!m) return;
        const oi = sockIndex(node, 'out' + (parseInt(m[1], 10) || 0), false);
        if (oi < 0 || !outs[oi]) return;
        const its = tlSlotItems(node, slot);
        if (its && its.length) outs[oi]._ezItems = its;
      });
      notifyOut(node);
      // ★ 配对 LoopStart 的出口颜色/类型是「反查 End 的 valueK 入口」得来的 ⇒ End 这边一变就
      //   立刻刷一次 Start（不然 Start 上的黑框类型/颜色会停在旧值）。
      try {
        const st = pairedLoopStart(node);
        if (st && st !== node && typeof st._ezlpUpdate === 'function') st._ezlpUpdate();
      } catch (_) {}
    };
    const paint = () => { try { render(); } catch (_) {} };
    node._ezlpUpdate = render;
    render();
    // ★ 加载工作流早期 graph 可能还没挂上配对 LoopStart ⇒ 首次算出的「当前模式」档位可能不对。
    //   稍后再重画一次，让 mode 行显示正确档位（此时按钮也已可点）。
    try { setTimeout(() => { try { render(); } catch (_) {} }, 400); } catch (_) {}
  }, { bare: true, width: START_W, height: 120, minH: 96 });
  sockStyle(node);
  installEdgeLabels(node, { side: 'both', rootOf: (n) => n._ezlpRoot, labelOf: (s, i, isIn) => loopPortLabel(node, s, i, isIn) });
}

// ===== SplitList 面板：把一份 list 拆成 N 个输出口 =====
function listInputItems(node) {
  try {
    const inp = (node.inputs || []).find((s) => s.name === 'list'); if (!inp || inp.link == null) return null;
    const g = node.graph; const lk = tlLink(g, inp.link); if (!lk) return null;
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
// 「加载视频」按钮：胶片格
function tlIcon(kind, size) { return kind === 'merge' ? TL_MERGE_ICON : (kind === 'model_3d' ? model3dIcon(size || 16) : (TYPE_ICONS[kind] || TYPE_ICONS.other)); }
function tlPal(i) { return TL_PALETTE[(Math.max(1, i) - 1) % TL_PALETTE.length]; }
function tlRgba(hex, a) {
  const h = String(hex || '#888888').replace('#', '');
  const s = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  const n = parseInt(s, 16) || 0;
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
// TimeLine 的播放/时间/缩放/选中状态：挂在节点上（以前是文件级变量，同屏两个 TimeLine 会互相踩：
// A 播放推进 B 的播放头、B 点分段把 A 的预览跳走）。所有读写都走 tlS(node)。
function tlS(node) {
  if (!node) return { playing: false, time: 0, zoom: 1, lastTick: 0, selSeg: 0 };
  return node._eztlS || (node._eztlS = { playing: false, time: 0, zoom: 1, lastTick: 0, selSeg: 0 });
}
// 多选：段号集合（1 基）。普通点击=单选；Ctrl/Cmd=加减；Shift=从锚点连选。
function tlSelOf(node) { if (!node._eztlSel) node._eztlSel = new Set(); return node._eztlSel; }
function tlPaintSel(root, node) {
  const sel = tlSelOf(node);
  try {
    root.querySelectorAll('.eztl-mseg').forEach((b) => {
      b.classList.toggle('eztl-msel', sel.has(parseInt(b.dataset.seg, 10)));
    });
    root.querySelectorAll('.eztl-medge').forEach((g) => {
      g.classList.toggle('on', sel.size === 1 && sel.has(parseInt(g.dataset.seg, 10)));
    });
    if (node._eztlUpdateSel) node._eztlUpdateSel();
  } catch (_) {}
}
// 最小刻度 1s（缩放再大也不出小数点刻度）；100% 时就是 1s 小刻度 / 5s 大刻度（大刻度 = 每 5 个小刻度）
function tlFmtTick(sec) {
  if (sec >= 60) { const m = Math.floor(sec / 60); return m + ':' + String(Math.floor(sec - m * 60)).padStart(2, '0'); }
  return (sec < 1 ? sec.toFixed(1) : String(sec)) + 's';
}
function tlFmtPlay(sec) {
  const m = Math.floor(sec / 60); const s = sec - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
}
// ★ TimeLine 的「规划宿主」= 上游连着的 EzFlex-TimePlan：面板读它的 widget 算规划，
//   拖动分段改时长也写它的 config.segOverride（用户要求「拉动分段要同步影响连着的 timeplan 实际值」）。
// 这个节点自己带「规划参数」吗？（TimePlan 本体，或任何被中转过来的等价节点）
function tlHasPlanWidgets(n) {
  if (!n || !n.widgets) return false;
  const has = (name) => n.widgets.some((w) => w && w.name === name);
  return has('model') && has('total') && has('segment');
}
// ★★ 顺 `timeplan` 口**一路往上游追**，直到找到真正带规划参数的那个节点。
//   为什么必须递归：`timeplan` 是可以被**透传**的 —— EzFlex-SplitVideo 的第 0 个出口就是
//   `timeplan` 原样透传（好让下游继续串）。用户的实际接线是
//     `TimePlan.timeplan → SplitVideo.timeplan(入口) → SplitVideo.timeplan(出口) → TimeLine.timeplan`
//   只追一跳会撞到 SplitVideo（既不是 TimePlan、也没有 model/total/segment widget）⇒ 返回 null
//   ⇒ TimeLine 退回自己的兜底默认值 ⇒ 表现就是「改 TimePlan，TimeLine 完全不动」。
//   判据：上游节点的**这个出口**也叫 `timeplan` ⇒ 它只是中转 ⇒ 继续追它自己的 `timeplan` 入口。
function tlUpstreamPlanNode(node, depth) {
  try {
    depth = depth || 0;
    if (!node || depth > 12) return null;
    const i = (node.inputs || []).findIndex((s) => s && s.name === 'timeplan');
    if (i < 0) return null;
    const up = tlUpstream(node, i);
    const o = up && up.origin;
    if (!o) return null;
    // ★ 用模块内常量比对（`TIME_PLAN` 必须在本文件顶部声明，否则严格模式下读未声明标识符
    //   会抛 ReferenceError、被下面 catch 吞掉 ⇒ 永远返回 null ⇒ 联动静默失效）
    if (nodeTypeOf(o) === TIME_PLAN || tlHasPlanWidgets(o)) return o;
    // 中转节点（出口名还是 timeplan）⇒ 继续往上追
    // ★ 上游那个口优先**按 link id 在 socket.links 里反查**（`origin_slot` 可能过期）。
    let os = null;
    if (up.linkId != null) {
      os = (o.outputs || []).find((s) => s && (s.link === up.linkId
        || (Array.isArray(s.links) && s.links.indexOf(up.linkId) >= 0))) || null;
    }
    if (!os) os = (o.outputs || [])[up.slot];
    if (os && String(os.name) === 'timeplan') return tlUpstreamPlanNode(o, depth + 1);
    return null;
  } catch (_) { return null; }
}
function tlOverrideHost(node) { return tlUpstreamPlanNode(node) || node; }
// ★ 通知「规划宿主」刷新自己（TimeLine 拖段改的是上游 TimePlan 的 config.segOverride，
//   TimePlan 面板要立刻把「手动段」标出来 —— 这是用户要的「互相影响实时可见」的另一半）。
function tlNotifyPlanHost(node) {
  try {
    const h = tlUpstreamPlanNode(node);
    if (h && typeof h._eztpUpdate === 'function') h._eztpUpdate();
  } catch (_) {}
}
// ★★ 反方向：TimePlan 改了参数 ⇒ 顺 `timeplan` 出口**递归往下通知**。
//   同样必须递归：TimePlan → SplitVideo（透传）→ TimeLine / SegmentPanel。
//   （`notifyOut` 只走一跳，而且不认 SplitVideo 的 `_ezsvRender` ⇒ 穿不过去。）
//   只顺名字叫 `timeplan` 的出口走，`seen` 去重防止同一节点被刷两次。
function tlNotifyPlanDownstream(node, seen, depth) {
  try {
    if (!node || !node.graph || !node.graph.links) return;
    seen = seen || new Set();
    depth = depth || 0;
    if (depth > 12 || seen.has(node)) return;
    seen.add(node);
    (node.outputs || []).forEach((o) => {
      if (!o || String(o.name) !== 'timeplan') return;
      const ids = [];
      if (Array.isArray(o.links)) ids.push(...o.links);
      if (o.link != null) ids.push(o.link);
      ids.forEach((lid) => {
        const lk = tlLink(node.graph, lid);
        if (!lk) return;
        const t = (node.graph.getNodeById ? node.graph.getNodeById(lk.target_id) : null)
          || ((node.graph._nodes || []).find((n) => n && String(n.id) === String(lk.target_id)));
        if (!t || seen.has(t)) return;
        if (typeof t._ezlpUpdate === 'function') { try { t._ezlpUpdate(); } catch (_) {} }
        else if (typeof t._ezsvRender === 'function') { try { t._ezsvRender(); } catch (_) {} }
        // ★ MotionContext / SegmentPanel 的刷新钩子也要认：它们面板上的「跟随规划」数字
        //   （钉入帧数）来自 plan，不刷就会显示上一个参数下的旧值。
        else if (typeof t._ezmcRender === 'function') { try { t._ezmcRender(); } catch (_) {} }
        else if (typeof t._ezspRender === 'function') { try { t._ezspRender(); } catch (_) {} }
        else if (typeof t._ezMediaOutUpdate === 'function') { try { t._ezMediaOutUpdate(); } catch (_) {} }
        else if (typeof t._eztpUpdate === 'function') { try { t._eztpUpdate(); } catch (_) {} }
        tlNotifyPlanDownstream(t, seen, depth + 1);
      });
    });
  } catch (_) {}
}
function tlWidget(node, name) { return (node.widgets || []).find((w) => w.name === name); }
function tlNum(node, name, dflt) { const w = tlWidget(node, name); const v = w ? w.value : dflt; return v; }
// ★ 与后端 `_tl_parse_override` 同步：手动每段时长 {段号(1-based): 秒} 归一化（忽略非法项；首段也允许）。
function tlParseOverride(segOverride) {
  const out = {};
  if (!segOverride || typeof segOverride !== 'object') return out;
  Object.keys(segOverride).forEach((k) => {
    const idx = parseInt(k, 10);
    const sec = parseFloat(segOverride[k]);
    if (isFinite(idx) && isFinite(sec) && idx >= 1 && sec > 0) out[idx] = sec;
  });
  return out;
}
// ★ 与后端 `_tl_build_override` 同步：把手动每段时长套进自动 klist（返回新 klist）。
//   ① 段号 ≤ 自动段数 → 就地替换该段步数；② 段号 > 自动段数 → 追加（中间空号用「自动段步数」补齐）。
function tlBuildOverride(klist, ovr, B, S, fps, oeff, maxF, segCount) {
  const segs = klist.slice();
  if (segCount != null) {
    const cnt = Math.max(1, parseInt(segCount, 10) || segs.length);
    if (cnt < segs.length) segs.length = cnt;
    while (cnt > segs.length) segs.push(segs.length ? segs[segs.length - 1] : 1);
  }
  if (!ovr || !Object.keys(ovr).length) return segs;
  const kmax = maxF ? Math.max(1, Math.floor((maxF - B) / S)) : null;
  const step = (sec, i) => {
    const want = fps * sec + (i === 0 ? 0 : oeff);
    let kk = Math.max(1, Math.round((want - B) / S));
    return kmax ? Math.min(kk, kmax) : kk;
  };
  Object.keys(ovr).map(Number).sort((a, b) => a - b).forEach((idx) => {
    const i = idx - 1;
    if (i < 0) return;
    if (i < segs.length) { segs[i] = step(ovr[idx], i); return; }
    while (segs.length < i) segs.push(segs.length > 1 ? segs[segs.length - 1] : segs[0]);
    segs.push(step(ovr[idx], i));
  });
  return segs;
}
// 读节点 config 里的手动每段时长
function tlOverrides(node) {
  try { return tlParseOverride((readConfig(tlOverrideHost(node)) || {}).segOverride); } catch (_) { return {}; }
}
function tlSegCount(node) {
  try {
    const c = parseInt((readConfig(tlOverrideHost(node)) || {}).segCount, 10);
    return isFinite(c) && c > 0 ? c : null;
  } catch (_) { return null; }
}
// ===== 整体时长：直接打开上游 TimePlan 的「自定义」规划弹窗 =====
function tlSetOverall(node) {
  // ★ 和 TimePlan 的「自定义」是同一个功能：直接调用它的弹窗（同一份实现 / 样式 / 保存逻辑）
  const host = tlUpstreamPlanNode(node);
  if (!host) { uiConfirm(ezT('Connect a TimePlan first')); return; }
  if (typeof host._eztpOpenCustom === 'function') { host._eztpOpenCustom(); return; }
  uiConfirm(ezT('Connect a TimePlan first'));
}

// ===== 段右键菜单 / 区间重跑 =====
let _tlMenuEl = null;
function tlCloseMenu() { try { if (_tlMenuEl) _tlMenuEl.remove(); } catch (_) {} _tlMenuEl = null; }
function tlShowMenu(items, x, y) {
  tlCloseMenu();
  const m = el('div', 'eztl-menu');
  items.forEach((it) => {
    const b = el('button');
    b.type = 'button'; b.textContent = it.label;
    b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); tlCloseMenu(); try { it.fn(); } catch (_) {} });
    m.appendChild(b);
  });
  document.body.appendChild(m);
  m.style.left = Math.max(4, Math.min(window.innerWidth - 180, x || 0)) + 'px';
  m.style.top = Math.max(4, Math.min(window.innerHeight - 40 - items.length * 30, y || 0)) + 'px';
  _tlMenuEl = m;
  setTimeout(() => {
    const close = (ev) => { if (_tlMenuEl && m.contains(ev.target)) return; tlCloseMenu(); document.removeEventListener('pointerdown', close, true); };
    document.addEventListener('pointerdown', close, true);
  }, 0);
}
// 段号（UI 1 基）→ index（0 基）；把「从 K 到 M 段」塞回队列：
//   LoopStart.index=K、config.resumeDir=run 目录（上一段 handoff 从缓存读）
//   LoopEnd.__ezround=K + rerun_stop=M（跑到 M 就停，不再入队）
//   SegmentPanel.rerun_stop=M + save_dir=run 目录（写回同一次 run，末段收口）
function tlRunDir(node) {
  // 以时间轴里最靠前的已落盘段所在目录为准；段可能横跨旧 run，旧目录甚至已被删。
  // 不能让后面的段或路径条数把目录带跑。
  try {
    const done = (node && node._ezSegDone) || {};
    const keys = Object.keys(done)
      .filter((k) => String((done[k] || {}).path || ''))
      .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
    if (keys.length) {
      const p = String(done[keys[0]].path || '');
      const d = p.replace(/[\\/][^\\/]*$/, '');
      if (d) return d;
    }
  } catch (_) {}
  const d = String((node && node._ezSegDir) || '').trim();
  if (d) return d;
  const f = String((node && node._ezSegFinal) || '');
  if (f) return f.replace(/[\\/][^\\/]*$/, '');
  // 老工作流/还没记录段时：退到画布上 SegmentPanel 的 save_dir（用户选过目录就能直接替换）。
  try {
    const sp = ((app && app.graph && app.graph._nodes) || []).find((n) => n && (n.type === 'EzFlex-SegmentPanel' || String(n.type).indexOf('SegmentPanel') >= 0));
    const w = sp && (sp.widgets || []).find((x) => x && x.name === 'save_dir');
    if (w && String(w.value || '').trim()) return String(w.value).trim();
  } catch (_) {}
  return '';
}
// 从 LoopStart 的输出连线反推各 valueN 的语义，换端口也能恢复上一段。
function tlLoopPortMap(ls) {
  const out = { latent: 0, video: 0, audio: 0, image: 0 };
  try {
    const g = ls && ls.graph;
    if (!g || !g.links) return out;
    const linkOf = (lid) => tlLink(g, lid);
    (ls.outputs || []).forEach((s, si) => {
      const m = /^value(\d+)$/.exec(String((s && s.name) || ''));
      if (!m) return;
      const port = parseInt(m[1], 10) || 0;
      if (!port) return;
      const ids = [];
      if (Array.isArray(s.links)) ids.push(...s.links);
      if (s.link != null) ids.push(s.link);
      if (!ids.length) {
        try {
          Object.keys(g.links).forEach((lid) => {
            const lk = linkOf(lid);
            if (lk && String(lk.origin_id) === String(ls.id) && parseInt(lk.origin_slot, 10) === si) ids.push(lid);
          });
        } catch (_) {}
      }
      ids.forEach((lid) => {
        const lk = linkOf(lid);
        if (!lk) return;
        const tn = (g.getNodeById ? g.getNodeById(lk.target_id) : null)
          || ((g._nodes || []).find((n) => n && String(n.id) === String(lk.target_id)));
        const inp = tn && tn.inputs && tn.inputs[lk.target_slot];
        const nm = String((inp && inp.name) || '');
        const ty = String((inp && inp.type) || '');
        if (nm === 'context_latent') { if (!out.latent) out.latent = port; return; }
        if (nm === 'context_video_latent' || nm === 'context_audio_latent') return;
        if (ty === 'AUDIO' || /audio/i.test(nm)) { if (!out.audio) out.audio = port; return; }
        if (ty === 'VIDEO' || /^video_/i.test(nm)
          || (tn && String(tn.type || '').indexOf('SplitVideo') >= 0)) {
          if (!out.video) out.video = port;
          return;
        }
        if (ty === 'IMAGE') { if (!out.image) out.image = port; }
      });
    });
  } catch (_) {}
  return out;
}
async function tlResolveRunDir(node) {
  let dir = tlRunDir(node);
  if (dir && /[\\/]run_/.test(dir)) return dir;
  try {
    const q = dir ? '?dir=' + encodeURIComponent(dir) : '';
    const r = await api.fetchApi('/ezflex/latest_run' + q);
    const d = await r.json().catch(() => null);
    if (d && d.ok && d.dir) {
      node._ezSegDir = String(d.dir);
      try { node.properties = node.properties || {}; node.properties.ezSegDir = node._ezSegDir; } catch (_) {}
      return node._ezSegDir;
    }
  } catch (_) {}
  return dir;
}
async function tlClearCache(node, idx) {
  // 按**实际落盘路径**清理：段 K 的文件在哪就清哪（不再只清 tlRunDir，避免旧目录/根目录漏清）
  const dirs = new Set();
  const done = (node && node._ezSegDone) || {};
  if (idx != null) {
    const p = String((done[idx + 1] || {}).path || '');
    if (p) dirs.add(p.replace(/[\\/][^\\/]*$/, ''));
  } else {
    Object.keys(done).forEach((k) => {
      const p = String((done[k] || {}).path || '');
      if (p) dirs.add(p.replace(/[\\/][^\\/]*$/, ''));
    });
  }
  const runDir = tlRunDir(node);
  if (runDir) dirs.add(runDir);
  if (!dirs.size) { uiToast(ezT('No cache files')); return; }
  let files = 0, bytes = 0, failed = 0;
  for (const dir of dirs) {
    try {
      const r = await api.fetchApi('/ezflex/segment_cache_clear', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: dir, index: (idx == null ? null : idx) }),
      });
      const j = await r.json();
      if (j && j.ok) { files += Number(j.files) || 0; bytes += Number(j.bytes) || 0; }
      else failed += 1;
    } catch (_) { failed += 1; }
  }
  // 以前这里不读响应：删 0 个也"没反应"。现在给出真实数量，按钮是否生效一眼可见。
  if (failed) uiToast(ezT('Cache cleanup failed') + ' (' + failed + ')');
  else if (files) uiToast(ezT('Cache cleared') + ': ' + files + ' / ' + (bytes / 1048576).toFixed(1) + ' MB');
  else uiToast(ezT('No cache files'));
}
// "2,4-6" → [1,3,4,5]（0 基）；只保留合法段号
function tlParseSegSpec(s, total) {
  const out = new Set();
  String(s || '').split(/[,，\s]+/).forEach((part) => {
    if (!part) return;
    const m = /^(\d+)(?:\s*[-~]\s*(\d+))?$/.exec(part);
    if (!m) return;
    const a = parseInt(m[1], 10) - 1;
    const b = m[2] ? parseInt(m[2], 10) - 1 : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { if (i >= 0 && i < total) out.add(i); }
  });
  return Array.from(out).sort((x, y) => x - y);
}
async function tlReplaceSrc(dir) {
  try {
    const pr = await api.fetchApi('/ezflex/pick_video', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: dir }),
    });
    const pj = await pr.json().catch(() => null);
    if (!pj || !pj.ok || !pj.path) {
      if (pj && pj.error) uiConfirm(ezT('Replace failed') + ': ' + pj.error);
      return '';
    }
    return String(pj.path);
  } catch (_) { return ''; }
}
async function tlPickVersion(node, idx, final, x, y) {
  const dir = await tlResolveRunDir(node);
  if (!dir) { uiConfirm(ezT('No run folder yet — run a segment first')); return; }
  const base = final ? 'final' : ('seg_' + String(idx).padStart(4, '0'));
  try {
    const rr = await api.fetchApi('/ezflex/segment_versions?dir=' + encodeURIComponent(dir) + '&base=' + encodeURIComponent(base));
    const rj = await rr.json();
    if (!rj || !rj.ok) { uiConfirm(ezT('Version load failed') + ': ' + ((rj && rj.error) || '?')); return; }
    const items = (rj.items || []).map((it) => ({
      label: '#' + it.id + ' · ' + (it.kind || 'version') + (it.id === rj.current ? '  ✓' : ''),
      fn: async () => {
        const sr = await api.fetchApi('/ezflex/segment_version_set', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: dir, base: base, id: it.id }),
        });
        const sj = await sr.json().catch(() => null);
        if (!sj || !sj.ok) { uiConfirm(ezT('Version switch failed') + ': ' + ((sj && sj.error) || '?')); return; }
        if (final) node._ezSegFinal = String(sj.dir || dir) + '/final.mp4';
        else node._ezSegDone[idx + 1] = { path: String(sj.dir || dir) + '/' + base + '.mp4', file: base + '.mp4' };
        node._ezSegDir = String(sj.dir || dir);
        node._ezSegVer = (node._ezSegVer || 0) + 1;
        try { node.properties.ezSegDone = Object.assign({}, node._ezSegDone); node.properties.ezSegDir = node._ezSegDir; node.properties.ezSegFinal = node._ezSegFinal || ''; } catch (_) {}
        try { await tlSyncManifest(node); } catch (_) {}
        if (node._eztlRefresh) node._eztlRefresh();
      },
    }));
    if (!items.length) { uiToast(ezT('No versions')); return; }
    tlShowMenu(items, x, y);
  } catch (err) {
    uiConfirm(ezT('Version load failed') + ': ' + ((err && err.message) || '?'));
  }
}
async function tlClearVersions(node, idx, final) {
  const dir = await tlResolveRunDir(node);
  if (!dir) return;
  const base = final ? 'final' : ('seg_' + String(idx).padStart(4, '0'));
  if (!(await uiConfirm(ezT('Keep only the latest version of ') + base + '?'))) return;
  try {
    const r = await api.fetchApi('/ezflex/versions_clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: dir, base: base, keep: 1 }),
    });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) { uiConfirm(ezT('Version cleanup failed') + ': ' + ((j && j.error) || '?')); return; }
    uiToast(ezT('Versions kept: ') + j.kept + ezT(', removed: ') + j.removed);
  } catch (err) {
    uiConfirm(ezT('Version cleanup failed') + ': ' + ((err && err.message) || '?'));
  }
}
async function tlReplaceSegment(node, idx) {
  const dir = await tlResolveRunDir(node);
  if (!dir) { uiConfirm(ezT('No run folder yet — run a segment first')); return; }
  try {
    const src = await tlReplaceSrc(dir);
    if (!src) return;
    const rr = await api.fetchApi('/ezflex/segment_replace', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: dir, index: idx, src: src }),
    });
    const rj = await rr.json();
    if (!rj || !rj.ok) { uiConfirm(ezT('Replace failed') + ': ' + ((rj && rj.error) || '?')); return; }
    if (!node._ezSegDone) node._ezSegDone = {};
    node._ezSegDone[idx + 1] = { path: String(rj.dir || dir) + '/' + String(rj.file || ''), file: String(rj.file || '') };
    node._ezSegDir = String(rj.dir || dir);
    node._ezSegFinal = String(rj.final || '');
    node._ezSegVer = (node._ezSegVer || 0) + 1;
    try { node.properties.ezSegDone = Object.assign({}, node._ezSegDone); node.properties.ezSegDir = node._ezSegDir; node.properties.ezSegFinal = node._ezSegFinal; } catch (_) {}
    try { await tlSyncManifest(node); } catch (_) {}
    if (node._eztlRefresh) node._eztlRefresh();
  } catch (_) {}
}
function tlTrimDialog(idx, head, tail) {
  if (!document.getElementById('eztl-trim-css')) {
    const st = document.createElement('style'); st.id = 'eztl-trim-css';
    st.textContent = '.eztl-trim-inp::-webkit-outer-spin-button,.eztl-trim-inp::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;}.eztl-trim-inp{appearance:textfield;-moz-appearance:textfield;}';
    document.head.appendChild(st);
  }
  return new Promise((resolve) => {
    const ov = el('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:100400;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
    const box = el('div');
    box.style.cssText = 'width:min(380px,92vw);background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);padding:14px 16px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;';
    const title = el('div'); title.textContent = ezT('Trim segment head/tail…') + ' · #' + (idx + 1);
    title.style.cssText = 'font-size:13px;font-weight:600;color:var(--ez-fg);';
    const mkRow = (label, value) => {
      const row = el('div'); row.style.cssText = 'display:flex;align-items:center;gap:10px;';
      const lab = el('span'); lab.textContent = label; lab.style.cssText = 'flex:0 0 108px;font-size:12px;color:var(--ez-fg-3);text-align:left;';
      const inp = document.createElement('input'); inp.type = 'number'; inp.className = 'eztl-trim-inp'; inp.min = '0'; inp.step = '1'; inp.value = String(value || 0);
      inp.style.cssText = 'flex:1 1 auto;min-width:0;height:28px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);text-align:center;font:inherit;padding:0 6px;appearance:textfield;outline:none;box-shadow:none;';
      row.appendChild(lab); row.appendChild(inp); return { row, inp };
    };
    const h = mkRow(ezT('Extra head frames'), head);
    const t = mkRow(ezT('Extra tail frames'), tail);
    const btns = el('div'); btns.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding-top:2px;';
    const cancel = el('button'); cancel.type = 'button'; cancel.textContent = ezT('Cancel');
    cancel.style.cssText = 'height:28px;border:1px solid var(--ez-border);border-radius:6px;background:var(--ez-surface-2);color:var(--ez-fg);font:inherit;font-size:12px;padding:0 12px;cursor:pointer;outline:none;box-shadow:none;';
    const apply = el('button'); apply.type = 'button'; apply.textContent = ezT('Apply');
    apply.style.cssText = 'height:28px;border:1px solid var(--ez-strong);border-radius:6px;background:var(--ez-strong);color:var(--ez-on-strong);font:inherit;font-size:12px;padding:0 12px;cursor:pointer;outline:none;box-shadow:none;';
    const close = (val) => { try { ov.remove(); } catch (_) {} document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(null); if (ev.key === 'Enter') { ev.preventDefault(); apply.click(); } };
    apply.addEventListener('click', () => close({ head: Math.max(0, parseInt(h.inp.value, 10) || 0), tail: Math.max(0, parseInt(t.inp.value, 10) || 0) }));
    cancel.addEventListener('click', () => close(null));
    ov.addEventListener('click', (ev) => { if (ev.target === ov) close(null); });
    document.addEventListener('keydown', onKey);
    btns.appendChild(cancel); btns.appendChild(apply);
    box.appendChild(title); box.appendChild(h.row); box.appendChild(t.row); box.appendChild(btns);
    ov.appendChild(box); document.body.appendChild(ov);
    setTimeout(() => { try { h.inp.focus(); h.inp.select(); } catch (_) {} }, 30);
  });
}

async function tlTrimSegment(node, idx, restore) {
  const dir = await tlResolveRunDir(node);
  if (!dir) { uiConfirm(ezT('No run folder yet — run a segment first')); return; }
  const done = (node._ezSegDone && node._ezSegDone[idx + 1]) || {};
  const curHead = Math.max(0, parseInt(done.editHead, 10) || 0);
  const curTail = Math.max(0, parseInt(done.editTail, 10) || 0);
  let head = 0, tail = 0;
  if (restore) {
    if (!(await uiConfirm(ezT('Restore this segment to its original trim?')))) return;
  } else {
    const r = await tlTrimDialog(idx, curHead, curTail);
    if (!r) return;
    head = Math.max(0, parseInt(r.head, 10) || 0);
    tail = Math.max(0, parseInt(r.tail, 10) || 0);
  }
  try {
    const rr = await api.fetchApi('/ezflex/segment_trim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: dir, index: idx, head: head, tail: tail }),
    });
    const rj = await rr.json();
    if (!rj || !rj.ok) { uiConfirm(ezT('Trim failed') + ': ' + ((rj && rj.error) || '?')); return; }
    uiToast(ezT('Segment trimmed: head ') + rj.head + ezT(', tail ') + rj.tail + ezT(', frames ') + rj.frames);
    await tlSyncManifest(node);
    if (node._eztlRefresh) node._eztlRefresh();
  } catch (err) {
    uiConfirm(ezT('Trim failed') + ': ' + ((err && err.message) || '?'));
  }
}
// 「继续生成」= 补齐缺段：从**第一个没落盘的段**开始，用它在 timeplan 里的段号当 index，
// 参考上一段（LoopStart 的参考卡设置，走 resumeDir），**不改** TimePlan.total。
// 上限 = timeplan 段数 − 已落盘段数（只能补没生成的部分）。
async function tlContinue(node, add) {
  const dir = tlRunDir(node);
  const p0 = tlPlan(node);
  const total = (p0.segs || []).length;
  if (!dir) { uiConfirm(ezT('No run folder yet — run a segment first')); return; }
  if (total <= 0) return;
  await tlSyncManifest(node);      // 以磁盘为准刷新「哪些段已落盘」
  const done = (node && node._ezSegDone) || {};
  const missing = [];
  for (let i = 1; i <= total; i++) if (!done[i]) missing.push(i);   // 1-based 段号
  if (!missing.length) { uiConfirm(ezT('All segments are already generated')); return; }
  const k0 = missing[0];
  let k1 = k0;
  while (missing.indexOf(k1 + 1) >= 0) k1++;                        // 连着的缺段区间（rerun_stop 只能表达连续区间）
  const want = Math.min(Math.max(1, add | 0 || 1), missing.length);
  const last = Math.min(k0 + want - 1, k1);
  const p = await app.graphToPrompt();
  const out = p && p.output; if (!out) return;
  Object.keys(out).forEach((id) => {
    const nn = out[id]; if (!nn || !nn.inputs) return;
    if (nn.class_type === 'EzFlex-LoopStart') {
      nn.inputs.index = k0 - 1;      // 0-based：从缺的那一段开始（timeplan 按这个 index 取段）
      let cfg = {}; try { cfg = JSON.parse(nn.inputs.config || '{}') || {}; } catch (_) { cfg = {}; }
      cfg.resumeDir = dir; nn.inputs.config = JSON.stringify(cfg);
    } else if (nn.class_type === 'EzFlex-LoopEnd') {
      nn.inputs.__ezround = k0 - 1; nn.inputs.rerun_stop = String(last - 1);
    } else if (nn.class_type === 'EzFlex-SegmentPanel') {
      nn.inputs.rerun_stop = last - 1; nn.inputs.save_dir = dir;
    }
  });
  if (want > last - k0 + 1) uiToast(ezT('Only consecutive missing segments are filled per run'));   // 中间有空号：再点一次补下一段
  await api.queuePrompt(0, p);
}
async function tlReplaceFinal(node) {
  const dir = await tlResolveRunDir(node);
  if (!dir) { uiConfirm(ezT('No run folder yet — run a segment first')); return; }
  try {
    const src = await tlReplaceSrc(dir);
    if (!src) return;
    const rr = await api.fetchApi('/ezflex/final_replace', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: dir, src: src }),
    });
    const rj = await rr.json();
    if (!rj || !rj.ok) { uiConfirm(ezT('Replace failed') + ': ' + ((rj && rj.error) || '?')); return; }
    node._ezSegFinal = String(rj.final || '');
    node._ezSegVer = (node._ezSegVer || 0) + 1;
    try { node.properties = node.properties || {}; node.properties.ezSegFinal = node._ezSegFinal; } catch (_) {}
    try { await tlSyncManifest(node); } catch (_) {}
    if (node._eztlRefresh) node._eztlRefresh();
  } catch (_) {}
}
async function tlRerunSpec(node, ids) {
  // 连续选中的段属于同一组，但执行仍然一段一个 prompt；
  // 组只决定边界：组首用外部上一段，组尾用外部下一段，中间段靠前一段刚生成的结果。
  const uniq = Array.from(new Set((ids || []).map((x) => parseInt(x, 10)).filter((x) => x >= 0))).sort((a, b) => a - b);
  let i = 0;
  while (i < uniq.length) {
    let j = i;
    while (j + 1 < uniq.length && uniq[j + 1] === uniq[j] + 1) j += 1;
    for (let k = uniq[i]; k <= uniq[j]; k++) {
      try { await tlRerunSegments(node, k, k, uniq[i], uniq[j]); } catch (_) {}
    }
    i = j + 1;
  }
}
async function tlRerunSegments(node, k, m, groupStart, groupEnd) {
  const dir = tlRunDir(node);
  if (!dir) { console.warn('[EzFlex] 该工作流还没落过段（没有 run 目录），无法按段重跑'); return; }
  const p = await app.graphToPrompt();
  const out = p && p.output; if (!out) return;
  // 先按当前接线解析 LoopStart 的 valueN：latent / 上一段视频 / 音频 / 图片。
  const portById = {};
  let latentPort = 0;
  Object.keys(out).forEach((id) => {
    if (!out[id] || out[id].class_type !== 'EzFlex-LoopStart') return;
    const gn = (app.graph && app.graph.getNodeById ? app.graph.getNodeById(id) : null)
      || ((app.graph && app.graph._nodes) || []).find((n) => n && String(n.id) === String(id));
    const pm = tlLoopPortMap(gn);
    portById[id] = pm;
    if (pm.latent && !latentPort) latentPort = pm.latent;
  });
  let nStart = 0, nEnd = 0, nSp = 0;
  const _gs = (groupStart == null) ? k : groupStart;
  const _ge = (groupEnd == null) ? m : groupEnd;
  const _rolePaths = (key) => {
    const p = String((((node._ezSegDone || {})[key]) || {}).path || '');
    if (!p) return {};
    const m = /seg_(\d+)/i.exec(p);
    if (!m) return { video: p };
    const dir = p.replace(/[\\/][^\\/]*$/, '');
    const base = 'seg_' + m[1];
    const isVer = /[\\/]versions[\\/]/i.test(p);
    return {
      video: p,
      latent: dir + '\\' + base + '_v2.pt',
      audio: isVer ? (dir + '\\audio.wav') : (dir + '\\' + base + '.wav'),
      image: dir + '\\' + (isVer ? 'ref' : (base + '.ref')),
    };
  };
  const _nextPaths = _rolePaths(_ge + 2);
  const _nextLatentName = _nextPaths.latent || '';
  Object.keys(out).forEach((id) => {
    const nn = out[id]; if (!nn || !nn.inputs) return;
    if (nn.class_type === 'EzFlex-LoopStart') {
      nn.inputs.index = k;
      let cfg = {}; try { cfg = JSON.parse(nn.inputs.config || '{}') || {}; } catch (_) { cfg = {}; }
      cfg.resumeDir = dir;
      cfg.groupStart = _gs;
      cfg.groupEnd = _ge;
      cfg.fps = (function () { try { const p = tlPlan(node); return (p && p.fps) || 24; } catch (_) { return 24; } })();
      cfg.refPaths = {
        prev: (k === _gs) ? _rolePaths(_gs) : {},
        cur: _rolePaths(k + 1),
        next: (k === _ge) ? _rolePaths(_ge + 2) : {},
      };
      const pm = portById[id] || {};
      cfg.resumeMedia = {};
      if (pm.video) cfg.resumeMedia[pm.video] = 'video';
      if (pm.audio) cfg.resumeMedia[pm.audio] = 'audio';
      if (pm.image) cfg.resumeMedia[pm.image] = 'image';
      nn.inputs.config = JSON.stringify(cfg);
      nStart += 1;
    } else if (nn.class_type === 'EzFlex-TimePlan') {
      let cfg = {}; try { cfg = JSON.parse(nn.inputs.config || '{}') || {}; } catch (_) { cfg = {}; }
      // 只写 nextRef 元数据；MotionContext 的 pin_next_head 开关关着时不会用它。
      cfg.nextRef = { dir: dir, index: _ge + 1, latentPort: latentPort || 2, latentPath: _nextLatentName };
      nn.inputs.config = JSON.stringify(cfg);
    } else if (nn.class_type === 'EzFlex-LoopEnd') {
      nn.inputs.__ezround = k;
      nn.inputs.rerun_stop = String(m);
      // 下一次重跑需要读这一段的 latent；确保当前 latent 口在 LoopEnd 的保存列表里。
      try {
        let pv = nn.inputs.persist;
        if (typeof pv === 'string') pv = JSON.parse(pv || '{}');
        if (!pv || typeof pv !== 'object' || Array.isArray(pv)) pv = {};
        const ports = Array.isArray(pv.ports) ? pv.ports.map((x) => parseInt(x, 10)).filter((x) => x > 0) : [];
        if (latentPort && ports.indexOf(latentPort) < 0) ports.push(latentPort);
        pv.ports = ports;
        nn.inputs.persist = JSON.stringify(pv);
      } catch (_) {}
      nEnd += 1;
    } else if (nn.class_type === 'EzFlex-SegmentPanel') {
      nn.inputs.rerun_stop = _ge;
      nn.inputs.save_dir = dir;
      nSp += 1;
    }
  });
  if (!nStart || !nEnd || !nSp) { console.warn('[EzFlex] 工作流里缺少 LoopStart/LoopEnd/SegmentPanel，无法按段重跑'); return; }
  await api.queuePrompt(0, p);
}
// 写 / 删手动每段时长（秒）。seg = 0 表示整体清空。
// ★ 写到**上游 TimePlan** 的 config（它才是规划的主人；后端 TimePlanNode.run() 读同一份）。
function tlSetOverride(node, seg, sec) {
  try {
    const host = tlOverrideHost(node);
    const d = readConfig(host) || {};
    const ovr = tlParseOverride(d.segOverride);
    if (!seg) { delete d.segOverride; }
    else if (sec == null || !(parseFloat(sec) > 0)) { delete ovr[seg]; if (Object.keys(ovr).length) d.segOverride = ovr; else delete d.segOverride; }
    else {
      ovr[seg] = parseFloat(sec); d.segOverride = ovr;
      d.customOn = true;                               // 手动改段 = 自动启用自定义规划
      const c = parseInt(d.segCount, 10);
      if (!isFinite(c) || c < seg) d.segCount = seg;   // TimeLine 拖到表外：段数跟着扩
    }
    writeConfig(host, d);
    // ★ TimePlan 的 config 在 properties 里也有副本（onConfigure 回填）⇒ 这里同步，否则拖段结果重载会被旧值盖回
    try {
      host.properties = host.properties || {};
      host.properties.ezTp = host.properties.ezTp || {};
      host.properties.ezTp.config = JSON.stringify(d);
    } catch (_) {}
    // ★ 实时联动：TimePlan 面板要立刻反映「哪几段被手动改过」
    if (host !== node) tlNotifyPlanHost(node);
    else if (host && typeof host._eztpUpdate === 'function') host._eztpUpdate();
  } catch (_) {}
}
// 把「秒数」吸附到该模型的最接近网格步（返回实际会得到的净时长秒数，供 UI 回显）
function tlSnapSec(model, fps, sec, isFirst, ovF, tol) {
  const m = TL_MODELS[model] || TL_MODELS.minimax_h3;
  const B = m.B, S = m.S, maxF = m.maxF;
  const oeff = ovF + tol;
  const want = fps * sec + (isFirst ? 0 : oeff);
  let k = Math.max(1, Math.round((want - B) / S));
  if (maxF) k = Math.min(k, Math.max(1, Math.floor((maxF - B) / S)));
  const gen = B + S * k;
  return isFirst ? gen / fps : Math.max(1, gen - oeff) / fps;
}
function tlPlan(node, opts) {
  // ★ 规划来自**上游的 EzFlex-TimePlan**（TimeLine 自己已经没有 model/total/… 这些 widget 了）。
  //   传进来的本来可能就是 TimePlan 节点（time_plan.js 的悬停要用）⇒ 解析不到上游就用自己的。
  node = tlUpstreamPlanNode(node) || node;
  const key = String(tlNum(node, 'model', 'minimax_h3'));
  const m = TL_MODELS[key] || TL_MODELS.minimax_h3;
  // 0 是 grid_b 的合法值（无前置帧）：`parseInt(...) || m.B` 会把 0 换成默认值，与后端不一致。
  const _gi = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  const B = Math.max(0, _gi(tlNum(node, 'grid_b', m.B), m.B));
  const S = Math.max(1, parseInt(tlNum(node, 'grid_s', m.S), 10) || m.S);
  const maxF = Math.max(1, parseInt(tlNum(node, 'max_frames', m.maxF), 10) || m.maxF);
  const fps = Math.max(1, parseInt(tlNum(node, 'fps', m.fps), 10) || m.fps);
  const T = Math.max(0.1, parseFloat(tlNum(node, 'total', 30)) || 30);
  const n = Math.max(0.1, parseFloat(tlNum(node, 'segment', 5)) || 5);
  const raw = Math.max(0, parseInt(tlNum(node, 'overlap', 22), 10) || 0);
  const tol = Math.max(0, parseInt(tlNum(node, 'tolerance', 1), 10) || 0);
  const tf = Math.max(0, parseInt(tlNum(node, 'trim_tail', 0), 10) || 0);
  const actx = Math.max(0, parseInt(tlNum(node, 'audio_context_length', 24), 10) || 0);
  const strict = String(tlNum(node, 'align', 'align')) === 'strict';
  const snapDown = (f) => (f <= B ? (f <= 0 ? 0 : B) : B + S * Math.floor((f - B) / S));
  // ★ 与后端 _tl_plan 同步：overlap 吸附到网格（向下）；tolerance 是「生成后」额外剪掉的量
  const ovF = raw <= 0 ? 0 : snapDown(raw);
  const oeff = ovF + tol;
  const N = Math.max(1, Math.round(T / n)) - 1;
  const _cfg = (() => { try { return readConfig(node) || {}; } catch (_) { return {}; } })();
  const _customOn = !!(opts && opts.auto) ? false : !!_cfg.customOn;
  const ovr = _customOn ? tlOverrides(node) : {};   // 手动每段时长（秒）；空 = 纯自动
  const segCount = _customOn ? tlSegCount(node) : null;
  // ★ 与后端 `_tl_plan` 同步：
  //   align  = 总时长优先（首段向上取整 + 反解总步数平摊）
  //   strict = 段长优先（每段步数锁定 fps*n；段数±2 + 除首段外总步数±N 步去压总偏差）
  const segs = [];
  const allocSteps = (mtot, kk1, NN) => {
    const snet = mtot - kk1;
    if (snet < NN) return new Array(NN).fill(Math.max(1, Math.floor(snet / NN)));
    const mb = Math.floor(snet / NN), r = snet - NN * mb;
    return Array.from({ length: NN }, (_, i) => (i < r ? mb + 1 : mb));
  };
  // ★ 与后端 `_tl_spread_steps` 同步：把 total 个步分给 M 段（Σ 恰为 total），floor/ceil 交错分布
  const spreadSteps = (total, M, _base) => {
    if (M <= 0) return [];
    total = Math.round(total);
    if (total < M) return new Array(M).fill(1);
    const lo = Math.floor(total / M), rem = total - M * lo;
    const res = new Array(M).fill(lo);
    if (rem <= 0) return res;
    const stride = M / rem;
    for (let i = 0; i < rem; i++) res[Math.floor(i * stride)] += 1;
    return res;
  };
  if (strict) {
    // ---- ★★ 每段时长绝对统一（除首段），总时长靠「增减段数」逼近 ----
    //   ✗ 旧版把余量「交错撒」到各段 ⇒ 段长不统一（前长后短）；段数还被卡在 N0±2。
    //   ✓ 所有非首段用同一个 kseg，段数 N 是唯一自由度，遍历 N 挑 Σnet 最贴近 fps*T。
    //   ⚠️ 下面三行必须与后端 `_tl_plan_strict`（segments_nodes.py）逐字一致：
    //      净增和误差目标里都**不**出现 tf / tol（它们由每段 netEff = gen - oeff - tf 自己扣）。
    //      以前这边多扣了 tf、目标里又减了 N*tol+N*tf，两套规划器会选出不同的段数
    //      （实测 768 组参数里 278 组不同）⇒ 面板画 9 段、实际跑 10 段，手动每段时长全部错位。
    const k1 = Math.max(1, Math.round((fps * n - B) / S));
    const kseg = Math.max(1, Math.round((fps * n + oeff - B) / S));
    const gen1 = B + S * k1;
    const netseg = Math.max(1, B + S * kseg - oeff);
    const N0 = Math.max(1, Math.round(T / n));
    const hi = Math.max(1, 2 * N0 + 2);          // 段数上限放宽到 ~2 倍（不受 N0±2 限制）
    let bestNt = 1, bestKey = null;
    for (let Nt = 1; Nt <= hi; Nt++) {
      const NN = Nt - 1;
      const sNet = gen1 + NN * netseg;
      const err = Math.abs(sNet - fps * T);
      const key = [err, Math.abs(Nt - N0), Nt];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) { bestKey = key; bestNt = Nt; }
    }
    // ★ 手动每段时长覆盖（与后端 _tl_build_override 同口径）；段号超出时等于「手动加段」
    const klist = tlBuildOverride(new Array(bestNt).fill(0).map((_, t) => (t === 0 ? k1 : kseg)), ovr, B, S, fps, oeff, maxF, segCount);
    let cursor = 0;
    for (let t = 0; t < klist.length; t++) {
      const kk = klist[t];
      const gen = B + S * kk;
      const tail = tf;
      if (t === 0) {
        const tf0 = klist.length > 1 ? tail : 0;
        const net0 = Math.max(1, gen - tf0);
        segs.push({ i: 1, gen, net: net0, ov: 0, tol: 0, tail: tf0, start: 0, dur: gen / fps, netStart: 0, netDur: net0 / fps, exceed: gen > maxF });
        cursor = net0 / fps;
        continue;
      }
      const tfI = t < klist.length - 1 ? tail : 0;
      const netEff = Math.max(1, gen - oeff - tfI);
      segs.push({ i: t + 1, gen, net: netEff, ov: ovF, tol, tail: tfI, start: cursor - oeff / fps, dur: gen / fps, netStart: cursor, netDur: netEff / fps, exceed: gen > maxF });
      cursor += netEff / fps;
    }
    return { segs, ovF, oeff, tol, tail: tf, audioContextFrames: actx, fps, maxF, model: key, actualTotal: cursor, targetFrames: Math.round(fps * T) };
  }
  // ---- 总时长优先（align）----
  const k1 = Math.max(1, Math.ceil((fps * n - B) / S));
  const F1 = B + S * k1;
  segs.push({ i: 1, gen: F1, net: F1, ov: 0, tol: 0, start: 0, dur: F1 / fps, netStart: 0, netDur: F1 / fps, exceed: F1 > maxF });
  let cursor = F1 / fps;
  if (N > 0) {
    // ★ 与后端同步：在「网格步数空间」解总步数。
    //   首段不剪头 ⇒ Σnet = (N+1)*B + S*mtot - N*oeff
    //   ⇒ mtot = (fps*T - (N+1)*B + N*oeff) / S
    // 只补偿 overlap；裁头/裁尾是生成后的额外裁剪（总时长会相应变短）
    const idealK = (fps * T - (N + 1) * B + N * ovF) / S;
    const cands = Array.from(new Set([Math.floor(idealK), Math.floor(idealK) + 1, Math.round(idealK)]));
    let best = null;
    cands.forEach((mtot) => {
      if (mtot < k1 + N) return;
      const kl = allocSteps(mtot, k1, N);
      // ⚠️ 首段不减 oeff：它没有需要剪掉的过渡头帧
      const sNet = F1 + kl.reduce((a, k) => a + (B + S * k - oeff), 0) - N * tf;
      const err = Math.abs(sNet - (fps * T - N * tol - N * tf));   // 裁头/裁尾只缩短，不补偿生成
      if (!best || err < best[0]) best = [err, kl];
    });
    const klistRaw = best ? best[1] : allocSteps(k1 + N, k1, N);
    // ★ 手动每段时长覆盖（与后端 _tl_build_override 同口径）；首段并进 klist 一起过覆盖
    const klist = tlBuildOverride([k1].concat(klistRaw), ovr, B, S, fps, oeff, maxF, segCount);
    // 首段可能被手动改过 → 重算 F1
    const F1f = B + S * klist[0];
    const tf1 = klist.length > 1 ? tf : 0;
    const net1 = Math.max(1, F1f - tf1);
    segs[0] = { i: 1, gen: F1f, net: net1, ov: 0, tol: 0, tail: tf1, start: 0, dur: F1f / fps, netStart: 0, netDur: net1 / fps, exceed: F1f > maxF };
    cursor = net1 / fps;
    klist.slice(1).forEach((kk, i) => {
      const gen = B + S * kk;                    // gen 天然落在网格上（步数直接展开）
      const tfI = i < klist.length - 2 ? tf : 0;
      const netEff = Math.max(1, gen - oeff - tfI);    // 真实净增（允许不在网格上）
      segs.push({ i: i + 2, gen, net: netEff, ov: ovF, tol, tail: tfI, start: cursor - oeff / fps, dur: gen / fps, netStart: cursor, netDur: netEff / fps, exceed: gen > maxF });
      cursor += netEff / fps;
    });
  }
  return { segs, ovF, oeff, tol, tail: tf, audioContextFrames: actx, fps, maxF, model: key, actualTotal: cursor, targetFrames: Math.round(fps * T) };
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
function tlUpstream(node, slot) {
  try {
    const inp = (node.inputs || [])[slot]; if (!inp || inp.link == null) return null;
    const g = node.graph; const lk = tlLink(g, inp.link); if (!lk) return null;
    const origin = (g.getNodeById ? g.getNodeById(lk.origin_id) : null) || ((g._nodes || []).find((n) => n && String(n.id) === String(lk.origin_id)));
    // ★ 一并给出 link 本身 / link id：调用方要按 **link id 反查 socket**，
    //   因为 `origin_slot` 可能过期（老工作流的端口顺序改过，而 `cloneObject` 是按源数组下标覆盖的）。
    return origin ? { origin, slot: lk.origin_slot, link: lk, linkId: inp.link } : null;
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
// 落盘过的分段成片：SegmentPanel 落一段就发一条 ezflex.segment（index/dir/file/saved），
// 前端把「段号 → 文件」记在节点上并随工作流存进 properties。循环累积链（LoopStart/LoopEnd/MergeList）
// 本来就没有 _ezItems 可读 ⇒ video 口空的时候用它兜底，TimeLine 的大预览才能回看每段成片。
function tlSavedItems(node) {
  // 成片已收口（末段事件带 final）⇒ 时间轴直接回看整条成片；跑的过程中仍按分段实时显示。
  const fin = (node && node._ezSegFinal) || '';
  if (fin) {
    const name = String(fin).split(/[\\/]/).pop();
    const ver = node && node._ezSegVer ? '&v=' + node._ezSegVer : '';
    return [{ id: 'ezfinal', name, kind: 'video', url: '/preview_any/serve_video?path=' + encodeURIComponent(fin) + ver, path: fin }];
  }
  const done = (node && node._ezSegDone) || null;
  if (!done) return [];
  const keys = Object.keys(done).map((x) => parseInt(x, 10)).filter((n) => n > 0 && isFinite(n)).sort((a, b) => a - b);
  const out = [];
  keys.forEach((i) => {
    const rec = done[i] || {};
    // 旧版本把 rename 前的 .tmp 路径写进了 properties/manifest：显示前剥掉，线上一律指向真实文件。
    const p0 = String(rec.path || '');
    const p = p0.endsWith('.tmp') ? p0.slice(0, -4) : p0;
    if (!p) return;
    const name = rec.file || p.split(/[\\/]/).pop();
    const ver = node && node._ezSegVer ? '&v=' + node._ezSegVer : '';
    out.push({ id: 'ezseg:' + p, name, kind: 'video', url: '/preview_any/serve_video?path=' + encodeURIComponent(p) + ver });
  });
  return out;
}
function tlRestoreSaved(node) {
  try {
    const p = (node && node.properties) || {};
    if (p.ezSegDone && typeof p.ezSegDone === 'object') node._ezSegDone = Object.assign({}, p.ezSegDone);
    if (p.ezSegDir) node._ezSegDir = String(p.ezSegDir);
    if (p.ezSegFinal) node._ezSegFinal = String(p.ezSegFinal);
  } catch (_) {}
}
// 从 manifest.json 同步「哪些段已落盘」：properties 可能是旧快照，磁盘才是真源。
// 只读、不会覆盖正在跑的段；替换段/成片后也用它刷新。
async function tlSyncManifest(node) {
  const dir = await tlResolveRunDir(node);
  if (!dir) return;
  try {
    const r = await api.fetchApi('/ezflex/segment_manifest?dir=' + encodeURIComponent(dir));
    const d = await r.json().catch(() => null);
    if (!d || !d.ok || !d.manifest) return;
    const mani = d.manifest || {};
    const segs = Array.isArray(mani.segments) ? mani.segments : [];
    const done = {};
    segs.forEach((s) => {
      if (!s || s.i == null) return;
      const i = Number(s.i);
      const p0 = String(s.path || '');
      const path = p0.endsWith('.tmp') ? p0.slice(0, -4) : p0;   // 见 tlSavedItems：历史 manifest 里的 .tmp 一律剥掉
      if (!Number.isFinite(i) || !path) return;
      done[i + 1] = { path: path, file: path.split(/[\\/]/).pop(), frames: s.frames, editHead: s.editHead || 0, editTail: s.editTail || 0 };
    });
    if (!Object.keys(done).length) return;
    node._ezSegDone = done;
    node._ezSegDir = String(d.dir || dir);
    if (mani.final) node._ezSegFinal = String(mani.final);
    try {
      node.properties = node.properties || {};
      node.properties.ezSegDone = Object.assign({}, done);
      node.properties.ezSegDir = node._ezSegDir;
      if (node._ezSegFinal) node.properties.ezSegFinal = node._ezSegFinal;
    } catch (_) {}
    if (node._eztlRefresh) node._eztlRefresh();
  } catch (_) {}
}
function tlAllItems(node) {
  if (node && node._ezSegFinal) return tlSavedItems(node);   // 成片收口后优先回看整条成片
  const i = (node.inputs || []).findIndex((s) => s && s.name === 'video');
  const items = i < 0 ? [] : (tlSlotItems(node, i) || []);
  return items.length ? items : tlSavedItems(node);
}
// 自定义轨道（轨道栏下面的虚线 + 加出来的）：类型任意，只装手动拖进去的素材，不参与自动铺
// 播放头当前所在的分段（用来决定大预览显示哪个素材）
function tlSegAt(plan, node) {
  const t = tlS(node).time;
  for (const sg of plan.segs) { const a = (sg.netStart || 0), b = a + (sg.netDur || sg.dur || 0); if (t >= a && t < b) return sg; }
  return plan.segs[plan.segs.length - 1] || null;
}
// 同款，但整体平移 off 秒（one 模式：段画在源视频的起止位置上）
function tlSegAtOff(plan, off, node) {
  if (!off) return tlSegAt(plan, node);
  const t = tlS(node).time;
  for (const sg of plan.segs) { const a = off + (sg.netStart || 0), b = a + (sg.netDur || sg.dur || 0); if (t >= a && t < b) return sg; }
  return plan.segs[plan.segs.length - 1] || null;
}
// 大预览区里的媒体（视频给控件、音频给播放器、图给图）
// 段视频预加载池：切段时复用**已经加载好的** video 元素，避免每段重建 <video> 造成黑屏一闪。
function tlPoolEl(node) {
  if (!node._eztlPre) {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none;left:0;top:0;';
    document.body.appendChild(d);
    node._eztlPre = d;
    node._eztlPool = new Map();
  }
  return node._eztlPre;
}
function tlVideoFor(node, it) {
  if (!node || !it || it.kind !== 'video' || !it.url) return null;
  const box = tlPoolEl(node);
  let v = node._eztlPool.get(it.url);
  if (!v) {
    v = document.createElement('video');
    v.src = it.url; v.controls = false; v.muted = !!node._eztlMuted; v.volume = node._eztlVolume == null ? 1 : node._eztlVolume;
    v.preload = 'auto'; v.playsInline = true; v.draggable = false;
    v.className = 'eztl-panevid';
    try { v.load(); } catch (_) {}
    box.appendChild(v);
    node._eztlPool.set(it.url, v);
    while (node._eztlPool.size > 4) {
      const k = node._eztlPool.keys().next().value;
      const old = node._eztlPool.get(k);
      node._eztlPool.delete(k);
      try { old.pause(); old.removeAttribute('src'); old.load(); old.remove(); } catch (_) {}
    }
  }
  return v;
}
function tlMediaEl(it, vid, node) {
  const t = el('div', 'eztl-paneth');
  if (!it) return t;
  if (it.kind === 'image' && it.url) { const im = el('img'); im.src = it.url; im.alt = it.name || ''; im.draggable = false; t.appendChild(im); }
  else if (it.kind === 'video' && it.url) {
    const v = vid || (() => { const x = el('video', 'eztl-panevid'); x.src = it.url; x.controls = false; x.muted = !!(node && node._eztlMuted); x.volume = node && node._eztlVolume != null ? node._eztlVolume : 1; x.preload = 'auto'; x.draggable = false; return x; })();
    t.appendChild(v);
  }
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
// TimeLine 只认 src（切分源视频）+ video（分段成片 list）+ index 三个输入口。老工作流里还存着 config、
// 旧素材口，以及 model/total/… 这些 widget 输入 —— 在 Nodes 2.0 里它们会被画成原生 socket（和第一个口重叠的圆点）。
// 跟别的面板节点一样，直接从 node.inputs 里摘掉；不再逐帧扫描、也不改节点定义。
function stripTlSockets(node) {
  const ins = node.inputs || [];
  for (let i = ins.length - 1; i >= 0; i--) {
    const s = ins[i];
    if (!s || s.name === 'timeplan' || s.name === 'video') continue;   // ★ 只剩这两个固定输入口，别摘
    try { node.removeInput(i); } catch (_) { try { ins.splice(i, 1); } catch (_2) {} }
  }
  // ★ 其余「widget 转输入」（老工作流里的 model/total/… / index / src）一律清掉：
  //   Nodes 2.0 会把它们画成原生 socket，全挤在第一个口上重叠（跟 TimePlan 一个坑）。
  ins.forEach((s) => { if (s && s.widget) { try { delete s.widget; } catch (_) {} } });
  // ★★ **TimeLine 没有输出口**（契约见 PROJECT_STATE §21）。老工作流里存着改造前的
  //   `frames` / `overlap_frames` / `src` 三个输出 —— `configure` 会把它们从序列化数据里还原回来
  //   ⇒ 画布上冒出幽灵输出圆点。这里一个不留（用户：「TimeLine 不需要输出端口」）。
  const outs = node.outputs || [];
  for (let i = outs.length - 1; i >= 0; i--) {
    try { node.removeOutput(i); } catch (_) { try { outs.splice(i, 1); } catch (_2) {} }
  }
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
// 三个固定输入口：video（分段成片 list）/ index（接 LoopStart.index / easy forLoop index）/
// src（切分源视频）。老工作流缺哪个补哪个。
function syncTlInputs(node) {
  stripTlSockets(node);
  // ★ 只剩两个口：timeplan（规划，来自 EzFlex-TimePlan）+ video（成片 list，回看用）
  if (!(node.inputs || []).some((s) => s.name === 'timeplan')) node.addInput('timeplan', 'EZFLEX_TIMEPLAN');
  if (!(node.inputs || []).some((s) => s.name === 'video')) node.addInput('video', '*');
  sockStyle(node);
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
// 悬停信息：分段（段号 / 生成时长(帧) / 净增(帧) / 过渡 / 容差 / 超限）
//   ★ 秒数后面**带括号写帧数**（用户要的：光有秒看不出到底要生成几帧，跟网格对不上时也一眼能看出来）。
function tlSegTip(sg, plan) {
  const p = tlPal(sg.i);
  let html = '<span class="eztl-tipdot" style="background:' + tlRgba(p, 0.3) + ';border:1px solid ' + tlRgba(p, 0.7) + '"></span>';
  html += '<strong>' + ezT('Segment') + ' #' + sg.i + '</strong><br>';
  html += ezT('Generation length') + ': ' + sg.dur.toFixed(3) + 's (' + sg.gen + ezT(' frames') + ')<br>';
  html += ezT('Net increase') + ': ' + sg.netDur.toFixed(3) + 's (' + sg.net + ezT(' frames') + ')';
  if (sg.ov > 0) html += '<br>' + ezT('overlap') + ': ' + sg.ov + ezT(' frames');
  if (sg.tol > 0) html += '<br>' + ezT('tolerance') + ': ' + sg.tol + ezT(' frames');
  if (sg.exceed) html += '<br><span style="color:var(--ez-warn-fg)">' + ezT('Over max by') + ' ' + (sg.gen - plan.maxF) + ezT(' frames') + '</span>';
  return html;
}
// 悬停信息：工具条那几个 i（模型/总时长/每段/FPS/过渡）
function tlInfoTip(key, plan) {
  const m = TL_MODELS[plan.model] || TL_MODELS.minimax_h3;
  if (key === 'model') return '<strong>' + m.name + '</strong><br>' + ezT('Default FPS') + ': ' + m.fps + '<br>' + ezT('Frame grid') + ': ' + m.B + ' + ' + m.S + 'k<br>' + ezT('Segment cap') + ': ' + m.maxF + ezT(' frames') + '（' + (m.maxF / m.fps).toFixed(2) + 's）';
  if (key === 'total') {
    // ★ 用户 2026-10-16：「总时长那里加一个实际生成时长和实际生成帧和现在的实际总时长、实际净增帧区分开」。
    //   两组数说的不是一件事：
    //     实际总时长 / 实际净增帧 = **拼接成片之后**真正留下的量（= 时间轴长度 × fps）
    //     实际生成时长 / 实际生成帧 = **模型要出图的总量**（每段都含被裁掉的重叠头 ⇒ 一定 ≥ 上面那组）
    const genF = plan.segs.reduce((a, s) => a + (Number(s.gen) || 0), 0);
    const netF = plan.segs.reduce((a, s) => a + (Number(s.net) || 0), 0);
    const genS = genF / Math.max(1, plan.fps);
    return ezT('Target frames') + ': <strong>' + plan.targetFrames + '</strong>'
      + '<br>' + ezT('Actual duration') + ': <strong>' + plan.actualTotal.toFixed(3) + 's</strong>'
      + '<br>' + ezT('Actual frames') + ': <strong>' + netF + '</strong>'
      + '<br><span style="opacity:.55">' + ezT('Generated before trimming') + '</span>'
      + '<br>' + ezT('Actual generated duration') + ': <strong>' + genS.toFixed(3) + 's</strong>'
      + '<br>' + ezT('Actual generated frames') + ': <strong>' + genF + '</strong>';
  }
  if (key === 'seg') {
    const over = plan.segs.filter((s) => s.exceed);
    return ezT('Number of segments') + ': <strong>' + plan.segs.length + '</strong><br>' + (over.length ? ('<span style="color:var(--ez-warn-fg)">' + ezT('Over the limit') + ': ' + over.length + '（' + over.map((s) => '#' + s.i).join(', ') + '）</span>') : ezT('No segment over the limit'));
  }
  if (key === 'fps') return '<strong>' + ezT('Current FPS') + ': ' + plan.fps + '</strong><br>' + ezT('Default FPS') + ': ' + m.fps;
  if (key === 'overlap') return ezT('Aligned to') + ': <strong>' + plan.ovF + ezT(' frames') + '</strong>（' + m.B + '+' + m.S + 'k）<br>' + ezT('Trimmed off head') + ': <strong>' + (plan.ovF + plan.tol) + ezT(' frames') + '</strong> = ' + ezT('overlap') + ' ' + plan.ovF + ' + ' + ezT('tolerance') + ' ' + plan.tol;
  return '';
}
function setupTimeLine(node) {
  if (!node._ezSegDone) node._ezSegDone = {};
  tlRestoreSaved(node);
setTimeout(() => { try { tlSyncManifest(node); } catch (_) {} }, 200);
  mount(node, ezT('Time Line'), (root, badge) => {
    // ★ 左上角那行（面板标题 + 「N 段 · M 帧已裁」徽标）不要：节点在画布上已经有标题了，
    //   这行纯占高。直接藏掉头部（badge 的父节点就是 .ezlp-hd）。
    try { const hd = badge && badge.parentNode; if (hd && hd.style) hd.style.display = 'none'; } catch (_) {}
    root.addEventListener('mouseleave', tlTipHide);   // 指针离开面板就收掉悬停气泡
    node._eztlRoot = root;
    const main = el('div', 'eztl-main'); root.appendChild(main);
    // 上：大预览；下：控件 + 视频拼接轨。上下按固定比例随节点缩放（不再有拖动缝）
    const pane = el('div', 'eztl-pane'); main.appendChild(pane);
    const bottom = el('div', 'eztl-bottom'); main.appendChild(bottom);
    // 多选工具条：放在视频和播放控件中间（临时常驻）
    const selBar = el('div', 'eztl-selbar');
    selBar.style.display = 'none';   // 只有「重新生成指定段」才进入选择模式
    const selCnt = el('span', 'eztl-selcnt');
    const mkSel = (txt, cls, fn) => { const b = el('button', 'eztl-selbtn' + (cls ? ' ' + cls : ''), { type: 'button' }); b.textContent = ezT(txt); b.addEventListener('click', fn); return b; };
    const selAll = () => { const p = tlPlan(node); const sel = tlSelOf(node); sel.clear(); (p.segs || []).forEach((s) => sel.add(s.i)); tlS(node).selSeg = 0; tlPaintSel(lanesBox, node); };
    const selInv = () => { const p = tlPlan(node); const sel = tlSelOf(node); const all = (p.segs || []).map((s) => s.i); const next = all.filter((i) => !sel.has(i)); sel.clear(); next.forEach((i) => sel.add(i)); tlS(node).selSeg = 0; tlPaintSel(lanesBox, node); };
    const selClr = () => { tlSelOf(node).clear(); tlS(node).selSeg = 0; tlPaintSel(lanesBox, node); };
    const selRun = () => {
      const ids = Array.from(tlSelOf(node)).sort((a, b) => a - b).map((i) => i - 1);
      if (ids.length) tlRerunSpec(node, ids);
    };
    selBar.appendChild(selCnt);
    selBar.appendChild(mkSel('Select all', '', selAll));
    selBar.appendChild(mkSel('Invert', '', selInv));
    selBar.appendChild(mkSel('Clear', '', selClr));
    selBar.appendChild(mkSel('Regenerate', 'primary', selRun));
    main.insertBefore(selBar, bottom);   // 选择条：视频和播放控件中间（默认隐藏）
    const enterSelMode = () => {
      selBar.style.display = 'flex';
      node._eztlSelMode = true;
      node._eztlUpdateSel();
    };
    const exitSelMode = () => {
      selBar.style.display = 'none';
      node._eztlSelMode = false;
      tlSelOf(node).clear();
      tlS(node).selSeg = 0;
      tlPaintSel(lanesBox, node);
    };
    const selCancel = () => exitSelMode();
    selBar.appendChild(mkSel('Cancel', '', selCancel));
    node._eztlEnterSelMode = enterSelMode;
    node._eztlExitSelMode = exitSelMode;
    node._eztlUpdateSel = () => {
      const p = tlPlan(node); const total = (p.segs || []).length;
      const sel = tlSelOf(node);
      Array.from(sel).forEach((i) => { if (i < 1 || i > total) sel.delete(i); });
      selCnt.textContent = ezT('Selected') + ': ' + sel.size + ' / ' + total;
    };
    node._eztlUpdateSel();
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
    const btnPlay = mkBtn(TL_PLAY_ICON, ezT('Play / Pause'), () => { if (tlS(node).playing) pausePlay(); else startPlay(); });
    btnPlay.classList.add('eztl-playicon');
    const updatePlayIcon = () => { btnPlay.innerHTML = tlS(node).playing ? TL_PAUSE_ICON : TL_PLAY_ICON; btnPlay.classList.toggle('active', tlS(node).playing); };
    // 播放/暂停抽出来：播放按钮、拼接轨点击、时间输入都走同一份（暂停只翻图标，不再整块重画）
    // 源视频在场时，播放/暂停/定位都同步到那个 <video>（PR 式：时间轴就是它的进度条）
    const tlVid = () => { const v = node._eztlVid; return (v && v.__ezUrl) ? v : null; };
    // ★ 播放头定位的唯一入口：改时间 → 同步源视频 currentTime → 重画播放头 + 大预览。
    //   点分段、拖刻度尺、改时间输入框都走这里（以前点分段只改 tlTime 不 seek，预览区不动）。
    const tlSeek = (sec) => {
      tlS(node).playing = false;
      tlS(node).lastTick = 0;
      tlS(node).time = Math.max(0, Math.min(headEl._total || 0, sec));
      const vd = tlVid();
      if (vd) {
        const st = Number(node._eztlSegStart) || 0, du = Number(node._eztlSegDur) || 0;
        try { vd.pause(); vd.currentTime = Math.max(0, Math.min(du || 1e9, tlS(node).time - st)); } catch (_) {}
      }
      updatePlayIcon(); drawHead(); try { drawPane(); } catch (_) {}
    };
    const startPlay = () => {
      const total = headEl._total || 0;
      if (tlS(node).time >= total) tlS(node).time = 0;
      tlS(node).playing = true; tlS(node).lastTick = 0; updatePlayIcon();
      node._eztlStarting = true;   // 让 drawPane 只建元素、不要抢先 play（否则它的静音兜底会覆盖这次用户手势的声音）
      try { drawPane(); } catch (_) {}
      node._eztlStarting = false;
      const v = tlVid();
      if (v) {
        const st = Number(node._eztlSegStart) || 0, du = Number(node._eztlSegDur) || 0;
        try {
          const _m = !!node._eztlMuted;
          v.muted = _m; v.defaultMuted = _m; if (_m) v.setAttribute("muted", ""); else v.removeAttribute("muted"); v.volume = node._eztlVolume == null ? 1 : node._eztlVolume;
        } catch (_) {}   // 用户点播放 = 手势；静音开关优先
        try { v.currentTime = Math.max(0, Math.min(du || 1e9, tlS(node).time - st)); } catch (_) {}
        // 只有浏览器真的以“自动播放策略”拒绝时才静音兜底；
        // 元数据未就绪导致的 Abort/NotSupported 不能改 muted，否则第一次播放会永久静音。
        try {
          const pr = v.play();
          if (pr && pr.catch) pr.catch((err) => {
            if (err && err.name === "NotAllowedError") {
              try { v.muted = true; v.play(); } catch (_) {}
            } else {
              const retry = () => {
                try { v.muted = false; v.defaultMuted = false; v.removeAttribute("muted"); v.play(); } catch (_) {}
              };
              if (v.readyState >= 2) retry();
              else v.addEventListener("canplay", retry, { once: true });
            }
          });
        } catch (_) {}
      }
      requestAnimationFrame(tick);
    };
    const pausePlay = () => { tlS(node).playing = false; updatePlayIcon(); const v = tlVid(); if (v) { try { v.pause(); } catch (_) {} } try { drawPane(); } catch (_) {} };
    const btnStop = mkBtn(TL_STOP_ICON, ezT('Stop'), () => { tlS(node).playing = false; tlS(node).time = 0; tlS(node).lastTick = 0; updatePlayIcon(); const v = tlVid(); if (v) { try { v.pause(); v.currentTime = 0; } catch (_) {} } drawHead(); try { drawPane(); } catch (_) {} });
    const tspan = el('span', 'eztl-time');
    const timeCur = el('span', 'cur'); const timeTot = el('span', 'tot');
    const sep = el('span', 'sep'); sep.textContent = '/';
    tspan.appendChild(timeCur); tspan.appendChild(sep); tspan.appendChild(timeTot);
    // 播放头时间输入框（无上下箭头）：指到哪就从哪开始播
    const timeInp = el('input', 'eztl-timeinp'); timeInp.type = 'number'; timeInp.min = '0'; timeInp.step = '0.1';
    timeInp.title = ezT('Playhead time (s)');
    timeInp.addEventListener('change', () => { const v = parseFloat(timeInp.value); if (!isFinite(v)) return; tlSeek(v); });
    timeInp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); timeInp.blur(); timeInp.dispatchEvent(new Event('change')); } });

    // 自定义静音 / 全屏：预览 <video> 不再显示原生控件
    const btnMute = mkBtn(node._eztlMuted ? '🔇' : '🔊', ezT('Mute') + ' / ' + ezT('Unmute'), () => {
      node._eztlMuted = !node._eztlMuted;
      const v = tlVid() || node._eztlVid;
      if (v) { try { v.muted = !!node._eztlMuted; } catch (_) {} }
      btnMute.innerHTML = node._eztlMuted ? '🔇' : '🔊';
      btnMute.classList.toggle('active', !!node._eztlMuted);
    });
    btnMute.classList.toggle('active', !!node._eztlMuted);
    const vol = el('input', 'eztl-vol'); vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.01';
    vol.value = String(node._eztlVolume == null ? 1 : node._eztlVolume);
    vol.title = ezT('Volume');
    vol.addEventListener('input', () => {
      const val = Math.max(0, Math.min(1, parseFloat(vol.value) || 0));
      node._eztlVolume = val;
      const v = tlVid() || node._eztlVid; if (v) { try { v.volume = val; } catch (_) {} }
    });
    const btnFull = mkBtn('⛶', ezT('Fullscreen'), () => {
      const v = tlVid() || node._eztlVid;
      if (!v) return;
      try {
        v.controls = true;
        v.muted = !!node._eztlMuted;
        v.volume = node._eztlVolume == null ? 1 : node._eztlVolume;
      } catch (_) {}
      node._eztlFullVid = v;
      const pr = v.requestFullscreen ? v.requestFullscreen() : null;
      if (pr && pr.catch) pr.catch(() => { try { v.controls = false; } catch (_) {} });
    });
    if (!node._eztlFsBound) {
      node._eztlFsBound = true;
      // 句柄存到节点上：删除节点时 onRemoved 要能摘掉，否则删掉的 TimeLine 还继续响应全屏切换
      node._eztlFsH = () => {
        const v = node._eztlFullVid || node._eztlVid;
        if (!v) return;
        if (document.fullscreenElement === v) {
          try { v.controls = true; } catch (_) {}
        } else {
          try { v.controls = false; } catch (_) {}
          node._eztlMuted = !!v.muted;
          node._eztlVolume = Number(v.volume);
          btnMute.innerHTML = node._eztlMuted ? '🔇' : '🔊';
          btnMute.classList.toggle('active', node._eztlMuted);
          vol.value = String(node._eztlVolume);
          tlS(node).playing = !v.paused;
          updatePlayIcon();
        }
      };
      document.addEventListener('fullscreenchange', node._eztlFsH);
    }
    pbar.appendChild(btnPlay); pbar.appendChild(btnStop); pbar.appendChild(btnMute); pbar.appendChild(btnFull);
    pbar.appendChild(vol); pbar.appendChild(tspan); pbar.appendChild(timeInp);
    // 缩放常态只显示百分比（透明无边框，跟底栏融在一起），点一下才变成可输入的框
    const zoomPct = el('span', 'eztl-zoompct', { title: ezT('Zoom (%)') });
    zoomPct.textContent = Math.round(tlS(node).zoom * 100) + '%';
    const zoomInp = el('input', 'eztl-zoominp'); zoomInp.type = 'number'; zoomInp.min = '30'; zoomInp.max = '800'; zoomInp.step = '5';
    zoomInp.value = String(Math.round(tlS(node).zoom * 100)); zoomInp.title = ezT('Zoom (%)');
    const zoomEdit = () => { zoomPct.style.display = 'none'; zoomInp.classList.add('on'); zoomInp.value = String(Math.round(tlS(node).zoom * 100)); try { zoomInp.focus(); zoomInp.select(); } catch (_) {} };
    const zoomShow = () => { zoomPct.style.display = ''; zoomInp.classList.remove('on'); };
    zoomPct.addEventListener('click', zoomEdit);
    zoomInp.addEventListener('change', () => { const v = parseFloat(zoomInp.value); if (!isFinite(v)) { zoomShow(); return; } tlS(node).zoom = Math.max(0.3, Math.min(8, v / 100)); zoomInput.value = String(Math.round(tlS(node).zoom * 100)); zoomShow(); renderSoon(); });
    zoomInp.addEventListener('keydown', (e) => { e.stopPropagation && e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault && e.preventDefault(); zoomInp.blur(); zoomInp.dispatchEvent(new Event('change')); } });
    zoomInp.addEventListener('blur', zoomShow);
    const zoomInput = el('input', 'eztl-zoom'); zoomInput.type = 'range'; zoomInput.min = '30'; zoomInput.max = '800';
    zoomInput.value = String(Math.round(tlS(node).zoom * 100));
    zoomInput.addEventListener('input', () => { tlS(node).zoom = (parseInt(zoomInput.value, 10) || 100) / 100; if (document.activeElement !== zoomInp) zoomInp.value = String(Math.round(tlS(node).zoom * 100)); renderSoon(); });
    // 显示模式：含重叠（原样）/ 不含重叠（每段从净起点铺，去掉过渡那段）
    const modeSel = el('select', 'eztl-sel eztl-playmode');
    [['overlap', ezT('With overlap')], ['trim', ezT('No overlap')]].forEach(([v, tx]) => { const o = el('option'); o.value = v; o.textContent = tx; modeSel.appendChild(o); });
    modeSel.title = ezT('Merge view');
    modeSel.addEventListener('change', () => { const s = eztlState(node); s.mergeView = modeSel.value === 'trim' ? 'trim' : 'overlap'; eztlSave(node, s); renderSoon(); });
    pbar.appendChild(modeSel);   // 显示模式：播放/停止那一行最右
    const btnCache = mkBtn('', ezT('Clear cache'), () => {
      uiConfirm(ezT('Delete cached handoff files (seg_*.v*.pt) of this run?')).then((ok) => { if (ok) tlClearCache(node, null); });
    });
    btnCache.textContent = ezT('Clear cache');   // 文字，不用图标；放在「不重叠」后面
    btnCache.classList.add('eztl-textbtn');
    pbar.appendChild(btnCache);
    const btnGo = mkBtn('', ezT('Continue generating'), () => {
      uiPrompt(ezT('How many segments to fill?'), '1').then((v) => {
        const n = parseInt(v, 10);
        if (n > 0) tlContinue(node, n);
      });
    });
    btnGo.title = ezT('Fill the missing segments after the last generated one (never grows the plan)');
    btnGo.textContent = ezT('Continue generating');
    btnGo.classList.add('eztl-textbtn');
    pbar.appendChild(btnGo);
    const ppsLbl = el('span', 'eztl-zoomlbl right');
    zbar.appendChild(zoomPct); zbar.appendChild(zoomInp); zbar.appendChild(zoomInput); zbar.appendChild(ppsLbl);

    const drawHead = () => {
      const pps = headEl._pps || 1;
      headEl.style.left = (Math.min(tlS(node).time, headEl._total || 0) * pps) + 'px';
      if (timeCur) timeCur.textContent = tlFmtPlay(tlS(node).time);
      if (timeInp && document.activeElement !== timeInp) timeInp.value = (Math.round(tlS(node).time * 100) / 100).toFixed(2);
    };
    let lastPaneSeg = -1;
    const tick = (now) => {
      if (!node._ezlpRoot || !node._ezlpRoot.isConnected) { tlS(node).playing = false; updatePlayIcon(); return; }
      if (!tlS(node).playing) return;
      const total = headEl._total || 0;
      const vd = tlVid();
      const dt = tlS(node).lastTick ? Math.min(0.25, Math.max(0, (now - tlS(node).lastTick) / 1000)) : 0;
      tlS(node).lastTick = now;
      let t;
      if (vd && node._eztlSegDur) {    // 分段/成片预览：视频自身进度是「段内时间」，换成全局时间
        const st = Number(node._eztlSegStart) || 0, du = Number(node._eztlSegDur) || 0;
        const ct = Number(vd.currentTime);
        t = st + (isFinite(ct) ? Math.min(ct, du || ct) : 0);
        if (vd.ended) t = st + du;
      } else if (vd) {
        const ct = Number(vd.currentTime);
        t = isFinite(ct) ? ct : tlS(node).time;
        if (vd.ended) t = total;
      } else {
        // ★ 没有视频的段：按该段自己的时钟走，不能用全局 wall clock（否则会一下冲到段尾 / 总时长）
        const segSt = Number(node._eztlSegStart) || 0;
        const segDu = Number(node._eztlSegDur) || 0;
        t = Math.min(segSt + segDu, Math.max(segSt, tlS(node).time + dt));
      }
      tlS(node).time = t >= total ? total : t;
      // 播放时大预览只跟视频拼接轨（参考轨不参与“播放”），按当前段变化重画
      const segs = headEl._segs || [];
      const off = headEl._off || 0;
      let si = segs.length ? segs[segs.length - 1].i : 0;
      for (const sg of segs) { const a = off + (sg.netStart || 0); if (tlS(node).time >= a && tlS(node).time < a + (sg.netDur || sg.dur || 0)) { si = sg.i; break; } }
      // 段结束：下一段**已经落盘**就继续（切 <video> 接着播）；还没生成就停在它的**开头**（不是段尾）
      const itemsNow = tlAllItems(node);
      const curIt = itemsNow[si - 1] || null;          // si 是 1 基段号，items 是 0 基
      const endedNow = !!(vd && vd.ended);
      if (t >= total || (endedNow && !(curIt && curIt.kind === 'video'))) {
        tlS(node).playing = false; updatePlayIcon();
        if (endedNow && t < total) {
          const curSeg = segs.find((sg) => sg.i === si);
          if (curSeg) tlS(node).time = off + (Number(curSeg.netStart) || 0);
        }
      }
      drawHead();
      if (si !== lastPaneSeg) { lastPaneSeg = si; try { drawPane(); } catch (_) {} }
      if (tlS(node).playing) requestAnimationFrame(tick);
    };
    const render = () => {
      node._eztlRefresh = renderSoon;
      stripTlSockets(node);
      syncTlInputs(node);
      dotSockets(node);
      const plan = tlPlan(node);                           // ★ 规划来自上游 EzFlex-TimePlan
      const viewOff = 0;                                   // 没有源视频了：时间轴就按规划铺
      const trim = eztlState(node).mergeView === 'trim';   // false = 含重叠（原样），true = 不含重叠
      const ovrNow = tlOverrides(node);                    // 手动每段时长（秒）→ 用于角标 / 拖拽基准
      const ovF0 = plan.ovF, tol0 = plan.tol;
      if (modeSel.value !== (trim ? 'trim' : 'overlap')) modeSel.value = trim ? 'trim' : 'overlap';
      const items = tlAllItems(node);
      const lanes = [TL_LANES[0]];   // 只有「视频拼接」一条轨
      const fps = plan.fps;
      badge.textContent = plan.segs.length + ' ' + ezT('segments') + ' · ' + (plan.ovF + plan.tol) + ' ' + ezT(' trimmed');
      // ★ 工具条整块删掉：规划参数都在上游 EzFlex-TimePlan 上，源视频切分已独立成 EzFlex-SplitVideo，
      //   这里只有「时间轴 + 回看」。
      // ---- 时间轴（比例尺按面板宽度自适应；zoom 只改 px/s）----
      const vw = Math.max(120, vp.clientWidth || 420);
      const total = Math.max(plan.actualTotal || 1, 0.5);   // 刻度按规划的实际总时长铺
      const basePps = Math.max(4, vw / (total + 1));
      const pps = basePps * tlS(node).zoom;
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
      // ---- 大预览区 ----
      // 有源视频 ⇒ 直接放「可播放的源视频」（PR 式：播放头就是它的进度条，切分位置画在下面的时间轴上）；
      // 没有 ⇒ 按老规矩显示播放头所在段的成片（video 输入口的第 i 项）。
      drawPane = () => {
        const segNow = tlSegAtOff(plan, viewOff, node);
        const single = items.length === 1;                          // 成片（或只有一段）：整条时间轴都是它
        const it = single ? items[0] : ((segNow && items[segNow.i - 1]) || null);
        const segStart = single ? 0 : (segNow ? (Number(segNow.netStart) || 0) : 0);
        const segDur = single ? (Number(plan.actualTotal) || 0) : (segNow ? (Number(segNow.netDur) || Number(segNow.dur) || 0) : 0);
        // ★ 空段（未生成视频）也要先落“本段起点 / 时长”：否则 tlSeek 和空段播放会沿用上一段的 start/dur，
        //   表现就是点空段 / 播到空段时跳到段尾。
        node._eztlSegStart = segStart; node._eztlSegDur = segDur;
        // ★ 原生 <video> 全屏时不能清空/搬走这个元素，否则浏览器会立刻退出全屏。
        //   多段连续播放时复用同一个全屏 video，只换 src；退出全屏后再恢复正常重建。
        const fsVid = (document.fullscreenElement && document.fullscreenElement.tagName === 'VIDEO') ? document.fullscreenElement : null;
        if (fsVid && fsVid === node._eztlVid && it && it.kind === 'video' && it.url) {
          const vid = fsVid;
          node._eztlSegStart = segStart; node._eztlSegDur = segDur;
          if (vid.__ezUrl !== it.url) {
            vid.__ezUrl = it.url;
            try { vid.src = it.url; vid.load(); } catch (_) {}
          }
          const local = Math.max(0, Math.min(segDur || 1e9, tlS(node).time - segStart));
          if (Math.abs((Number(vid.currentTime) || 0) - local) > 0.02) { try { vid.currentTime = local; } catch (_) {} }
          if (tlS(node).playing && !node._eztlStarting) {
            try {
              const pr = vid.play();
              if (pr && pr.catch) pr.catch(() => { try { vid.muted = true; vid.play(); } catch (_) {} });
            } catch (_) {}
          }
          return;
        }
        if (node._eztlVid) { try { node._eztlVid.pause(); } catch (_) {} node._eztlVid = null; }
        node._eztlPaneBuilt = false; node._eztlPaneTag = null;
        pane.innerHTML = '';   // 池里的 <video> 只是被摘下来，不会被销毁
        if (it) {
          const ptag = el('div', 'eztl-panetag');
          ptag.textContent = (single ? ezT('Final video') : (ezT('Video merge') + ' · ' + ezT('Segment') + ' #' + segNow.i)) + ' · ' + (it.name || '');
          pane.appendChild(ptag);
          const poolVid = tlVideoFor(node, it);          // 预加载池：同一段复用已加载好的元素
          const mel = tlMediaEl(it, poolVid, node);
          pane.appendChild(mel);
          // 顺手预取下一段（播放跨段时不再现加载 → 没有黑屏）
          try {
            const nx = items[segNow.i];
            if (nx && nx.kind === 'video') tlVideoFor(node, nx);
          } catch (_) {}
          // ★ 把预览里的 <video> 交给播放条：播放/暂停/拖动时间都是这同一个控件（以前 _eztlVid 从来没赋值，
          //   播放条只动播放头，预览里的视频完全不动）。
          const vid = mel.querySelector ? mel.querySelector('video') : null;
          node._eztlSegStart = segStart; node._eztlSegDur = segDur;
          if (vid) {
            node._eztlVid = vid; vid.__ezUrl = it.url;
            if (!vid.__ezSync) {   // 原生控件也驱动下面播放头
              vid.__ezSync = true;
              vid.addEventListener('play', () => {
                if (vid !== node._eztlVid) return;   // 池里换下来的旧 video 不再驱动播放条
                try {
                  if (!tlS(node).playing) { tlS(node).playing = true; updatePlayIcon(); requestAnimationFrame(tick); }
                } catch (_) {}
              });
              vid.addEventListener('pause', () => {
                if (vid !== node._eztlVid) return;
                try { if (!vid.ended) { tlS(node).playing = false; updatePlayIcon(); } } catch (_) {}
              });
              const syncFromVid = () => {
                // ★ 关键：旧 video 的 seeked/timeupdate 会在切到「无视频段」之后才冒出来；
                //   它已经不在 _eztlVid 上，不能再按新段的 start 反算，否则点击空段会跳到段尾。
                if (vid !== node._eztlVid) return;
                try {
                  const st = Number(node._eztlSegStart) || 0;
                  const total = headEl._total || 0;
                  tlS(node).time = Math.min(total, st + (Number(vid.currentTime) || 0));
                  drawHead();
                } catch (_) {}
              };
              vid.addEventListener('timeupdate', syncFromVid);
              vid.addEventListener('seeked', syncFromVid);
            }
            const local = Math.max(0, Math.min(segDur || 1e9, tlS(node).time - segStart));
            if (Math.abs((Number(vid.currentTime) || 0) - local) > 0.02) { try { vid.currentTime = local; } catch (_) {} }   // 定位/跨段时对齐到播放头（local=0 也要对齐）
            if (tlS(node).playing && !node._eztlStarting) {   // 播放中跨段：新元素从当前时间接着播；用户刚点播放时交给 startPlay 处理
              try {
                const pr = vid.play();
                if (pr && pr.catch) pr.catch(() => { try { vid.muted = true; vid.play(); } catch (_) {} });
              } catch (_) {}
            }
          }
          return;
        }
        const h = el('div', 'eztl-panehint');
        h.textContent = (tlS(node).playing ? ezT('Playing') + ' · ' : '') + ezT('Video merge') + ' · ' + ezT('Segment') + ' #' + (segNow ? segNow.i : 1);
        pane.appendChild(h);
      };
      tlTipHide();   // 重画前先收掉（旧的分段元素被抽走时不会触发 mouseleave）
      lanesBox.innerHTML = '';
      if (node._eztlUpdateSel) node._eztlUpdateSel();
      const mergeBoxes = {};   // 段号 → { box, sg }：拖拽时实时改宽/移后面段用
      lanes.forEach((lane) => {
        const row = el('div', 'eztl-lane' + (lane.id === 'merge' ? ' merge' : ''));
        row.style.height = TL_LANE_H + 'px';
        row.dataset.lane = lane.id;
        plan.segs.forEach((sg) => {
          const p = tlPal(sg.i);
          if (lane.id === 'merge') {
            const box = el('div', 'eztl-mseg');
            const segLeft = (viewOff + (trim ? sg.netStart : sg.start)) * pps;
            const segW = Math.max(6, (trim ? (sg.netDur || sg.dur) : sg.dur) * pps - 2);
            box.style.left = segLeft + 'px';       // 不含重叠：从净起点铺
            box.style.width = segW + 'px';
            box.style.background = tlRgba(p, 0.22);
            if (node._eztlSel && node._eztlSel.has(sg.i)) box.classList.add('eztl-msel');   // 多选/单选：外框变绿
            if (node._ezSegDone && node._ezSegDone[sg.i]) box.classList.add('eztl-mdone');   // ★ 该段已落盘完成（循环中实时标记）
            box.dataset.seg = String(sg.i);
            mergeBoxes[sg.i] = { box, sg, left: segLeft, w: segW };
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
            tlBindTip(box, () => tlSegTip(sg, plan));   // 悬停信息（段号/生成时长/净增/重叠/容差/超限）
            box.addEventListener('mousedown', (e) => {   // 点视频段 = 选中该段（立即变绿）+ 播放头定位到该段开头
              if (e.button !== 0) return;
              e.stopPropagation();
              const sel = tlSelOf(node);
              if (e.shiftKey && node._eztlAnchor) {
                const a = node._eztlAnchor;
                for (let i = Math.min(a, sg.i); i <= Math.max(a, sg.i); i++) sel.add(i);
              } else if (e.ctrlKey || e.metaKey) {
                if (sel.has(sg.i)) sel.delete(sg.i); else sel.add(sg.i);
              } else {
                sel.clear(); sel.add(sg.i);
              }
              node._eztlAnchor = sg.i;
              tlS(node).selSeg = sel.size === 1 ? Array.from(sel)[0] : 0;
              tlPaintSel(lanesBox, node);
              tlSeek(viewOff + (sg.netStart || 0));               // ★ 走统一入口：源视频跟着跳到这一段开头
              // drawPane/tlSeek 可能重建预览，重新落一次选中态；避免“点回第 1 段要点两下”。
              requestAnimationFrame(() => { try { tlPaintSel(lanesBox, node); } catch (_) {} });
            });
            box.addEventListener('click', (e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              const sel = tlSelOf(node);
              if (sel.has(sg.i)) return;                         // 已经由 mousedown 选中
              e.stopPropagation();
              sel.clear(); sel.add(sg.i); node._eztlAnchor = sg.i;
              tlS(node).selSeg = sg.i; tlPaintSel(lanesBox, node);
              tlSeek(viewOff + (sg.netStart || 0));
              requestAnimationFrame(() => { try { tlPaintSel(lanesBox, node); } catch (_) {} });
            });
            // ★★ 右键菜单：改段时长 / 重新生成本段 / 从本段重跑到末尾（写回同一次 run）
            box.addEventListener('contextmenu', (e) => {
              e.preventDefault(); e.stopPropagation();
              // 右键先选中这一段，再开菜单；否则菜单操作的是上一次选中的段。
              const rsel = tlSelOf(node); rsel.clear(); rsel.add(sg.i); node._eztlAnchor = sg.i;
              tlS(node).selSeg = sg.i; tlPaintSel(lanesBox, node);
              const cur = ovrNow[sg.i] != null ? ovrNow[sg.i] : (trim ? (sg.netDur || sg.dur) : sg.dur);
              const last = Math.max(0, (plan.segs || []).length - 1);
              tlShowMenu([
                { label: ezT('Set segment duration (#n)').replace('#n', sg.i), fn: () => {
                  uiPrompt(ezT('Set segment duration (#n)').replace('#n', sg.i), cur.toFixed(3)).then((v) => {
                    if (v == null) return;
                    const t = String(v).trim();
                    if (!t) { tlSetOverride(node, sg.i, null); renderSoon(); return; }   // 清空 = 恢复自动
                    const sec = parseFloat(t);
                    if (!(sec > 0)) return;
                    tlSetOverride(node, sg.i, sec);
                    renderSoon();
                  });
                } },
                { label: ezT('Set overall duration'), fn: () => tlSetOverall(node) },
                { label: ezT('Regenerate this segment'), fn: () => { tlRerunSegments(node, sg.i - 1, sg.i - 1); } },
                { label: ezT('Regenerate to the end'), fn: () => { tlRerunSegments(node, sg.i - 1, last); } },
                { label: ezT('Regenerate selected segments'), fn: () => { if (node._eztlEnterSelMode) node._eztlEnterSelMode(); } },
                { label: ezT('Trim segment head/tail'), fn: () => { tlTrimSegment(node, sg.i - 1, false); } },
                { label: ezT('Restore segment trim'), fn: () => { tlTrimSegment(node, sg.i - 1, true); } },
                { label: ezT('Replace this segment video'), fn: () => { tlReplaceSegment(node, sg.i - 1); } },
                { label: ezT('Select segment version…'), fn: () => { tlPickVersion(node, sg.i - 1, false, e.clientX, e.clientY); } },
                { label: ezT('Select final version…'), fn: () => { tlPickVersion(node, 0, true, e.clientX, e.clientY); } },
                { label: ezT('Clean old versions'), fn: () => { tlClearVersions(node, sg.i - 1, false); } },
                { label: ezT('Clean old final versions'), fn: () => { tlClearVersions(node, 0, true); } },
                { label: ezT('Replace final video'), fn: () => { tlReplaceFinal(node); } },
                { label: ezT('Clear this segment cache'), fn: () => { tlClearCache(node, sg.i - 1); } },
              ], e.clientX, e.clientY);
            });
            // ★★ 左右拖拽热区：挂在 lane（row）上、精确压在段的左右边框线上（box 有 overflow:hidden，
            //   放 box 内会被裁）。平时 pointer-events:none 不可点，选中该段后才可点（鼠标放上去 = 左右箭头）。
            //   拖动时实时改这一段（及后面所有段）的 left/width，长度随拖动变化（不是只变秒数）。
            const mkEdge = (side) => {
              const g = el('div', 'eztl-medge eztl-medge-' + side + ' ' + side);
              g.dataset.seg = String(sg.i); g.dataset.side = side;
              const place = () => {   // 热区对准 box 的对应边（读实时 left/width，拖动时也跟得上）
                const b = mergeBoxes[sg.i].box;
                const l = parseFloat(b.style.left) || 0;
                const w = parseFloat(b.style.width) || 0;
                g.style.left = (side === 'l' ? l : l + w) + 'px';
              };
              place();
              if (tlS(node).selSeg === sg.i) g.classList.add('on');
              const snapOf = (sec) => tlSnapSec(plan.model, fps, sec, sg.i === 1, ovF0, tol0);   // 吸附后的秒数（网格帧）
              g.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation(); e.preventDefault();
                const r0 = content.getBoundingClientRect();
                const domW0 = content.offsetWidth || r0.width || 1;
                const scale = domW0 / (r0.width || domW0);                 // 画布缩放比：屏幕 px → DOM px
                const dpx = (clientX) => (clientX - r0.left) * scale;       // 屏幕 → DOM px
                const startX = e.clientX;
                const base = ovrNow[sg.i] != null ? ovrNow[sg.i] : (trim ? (sg.netDur || sg.dur) : sg.dur);
                const followers = Object.keys(mergeBoxes).map(Number).sort((a, b) => a - b).filter((n) => n > sg.i).map((n) => mergeBoxes[n]);
                const baseLefts = followers.map((f) => f.left);
                let lastSec = base;
                // ★ 拖动中的时长提示角标：跟随被拖的那条边、浮在段上方
                const tip = el('div', 'eztl-mdrag'); tip.textContent = base.toFixed(2) + 's';
                content.appendChild(tip);
                const placeTip = () => {
                  const b = mergeBoxes[sg.i].box;
                  const l = parseFloat(b.style.left) || 0;
                  const w = parseFloat(b.style.width) || 0;
                  const cw = content.offsetWidth || 0;
                  const x = Math.min(Math.max(side === 'l' ? l : l + w, 26), Math.max(26, cw - 26));   // 夹在内容内，别撑出横向滚动
                  let ty = 2;
                  try { ty = Math.max(2, (b.getBoundingClientRect().top - r0.top) * scale - 24); } catch (_) {}
                  tip.style.left = x + 'px'; tip.style.top = ty + 'px';
                };
                placeTip();
                const move = (ev) => {
                  const deltaPx = (side === 'r' ? 1 : -1) * (dpx(ev.clientX) - dpx(startX));
                  const sec = Math.max(0.05, base + deltaPx / pps);   // ★ 拖动中**不吸附**（否则大网格/大缩放下一跳一跳，像不跟手）；松手才吸
                  lastSec = sec;
                  const cur = mergeBoxes[sg.i];
                  const newW = Math.max(6, sec * pps - 2);
                  const dW = newW - cur.w;
                  cur.box.style.width = newW + 'px';
                  if (side === 'r') {
                    followers.forEach((f, k) => { f.box.style.left = (baseLefts[k] + dW) + 'px'; });   // 右沿外移 → 后面的段整体平移
                  } else {
                    cur.box.style.left = (cur.left - dW) + 'px';   // 左沿外移、右沿不动 → 后面的段不动（从左边生长/收缩，视觉才顺）
                  }
                  place(); placeTip();   // 热区 + 角标都跟着走
                  lbl.textContent = '#' + sg.i + ' · ' + sec.toFixed(2) + 's';
                  tip.textContent = sec.toFixed(2) + 's';
                };
                const up = () => {
                  document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
                  try { tip.remove(); } catch (_) {}
                  tlSetOverride(node, sg.i, parseFloat(snapOf(lastSec).toFixed(3)));   // ★ 松手才吸附到帧网格
                  renderSoon();
                };
                document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
              });
              return g;
            };
            row.appendChild(box);
            row.appendChild(mkEdge('l'));   // 热区常驻（选中才可点），点击即用、无需重画
            row.appendChild(mkEdge('r'));
            return;
          }
        });
        lanesBox.appendChild(row);
      });
      drawPane();
      headEl._pps = pps; headEl._total = total; headEl._segs = plan.segs; headEl._off = viewOff;
      if (timeInp) timeInp.max = total.toFixed(2);
      drawHead();
      // ---- 播放条 / 缩放条：常驻件，这里只回填值（见上面 renderSoon 的说明）----
      timeCur.textContent = tlFmtPlay(tlS(node).time);
      timeTot.textContent = tlFmtPlay(total);
      updatePlayIcon();
      const zv = String(Math.round(tlS(node).zoom * 100));
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
        tlSeek(xDom / pps);
      };
      const beginScrub = (e2) => {
        if (e2.button !== 0) return;
        if (e2.target && e2.target.closest && e2.target.closest('.eztl-th,.eztl-play,.eztl-mseg,.eztl-medge')) return;   // 点素材/点视频段/拖热区不在这里定位
        if (tlS(node).selSeg || (node._eztlSel && node._eztlSel.size)) { tlSelOf(node).clear(); tlS(node).selSeg = 0; tlPaintSel(lanesBox, node); }   // 点空白 = 取消选中
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
  }, { minH: 540 });
  // 尺寸完全交给用户（重开工作流也不改）；面板内容超出走内部滚动条。
  hideNativeWidgets(node);
  // 和别的面板节点同款：setup 时 node.inputs/widgets 还没最终定型，稍后再裁一次残留的 config / widget 输入口
  setTimeout(() => { try { hideConfigWidget(node); stripTlSockets(node); } catch (_) {} }, 60);
  if (!node._eztlPost) {   // setup 会被调两次（onNodeCreated + nodeCreated/loadedGraphNode）：尺寸只定一次
    node._eztlPost = true;
    try { ezApplyDefaultSize(node, 800, 720); } catch (_) {}
    installEdgeLabels(node, { side: 'both', rootOf: (n) => n._ezlpRoot, labelOf: (s, i, isIn) => {
      const nm = String((s && (s.name || s.localized_name)) || '');
      if (!isIn) return nm;
      // ★ `timeplan` 以前没列进来 ⇒ 返回空串 ⇒ 那个口没有黑框标签（用户问的就是这个）。
      if (nm === 'timeplan') return 'timeplan';
      if (nm === 'index') return 'index';
      if (nm === 'video') return 'video';
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
  const pc = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = pc ? pc.apply(this, arguments) : undefined; try { setup(this); } catch (_) {} try { const t = nodeTypeOf(this); if (t === LOOP_START || t === LOOP_END) trimLoopSockets(this); if (t === TIME_LINE) stripTlSockets(this); } catch (_) {} return r; };
  const pm = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { this.__ezSizeRestored = true; const r = pm ? pm.apply(this, arguments) : undefined; try { forceShell(this); stripCoreSockets(this); if (nodeTypeOf(this) === TIME_LINE) { stripTlSockets(this); tlRestoreSaved(this); setTimeout(() => { try { tlSyncManifest(this); } catch (_) {} }, 200); } ensurePlanPort(this); if (this._ezlpUpdate) deferPanelUpdate(this); } catch (_) {} return r; };
  const prz = nt.prototype.onResize; nt.prototype.onResize = function () { const r = prz ? prz.apply(this, arguments) : undefined; try { forceShell(this); } catch (_) {} return r; };
  const pcn = nt.prototype.onConnectionsChange; nt.prototype.onConnectionsChange = function () { const r = pcn ? pcn.apply(this, arguments) : undefined; try { if (this._ezlpUpdate) deferPanelUpdate(this); } catch (_) {} return r; };
  const pr = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = pr ? pr.apply(this, arguments) : undefined; try { (this._ezEdgeEls || []).forEach((x) => { try { x.remove(); } catch (_) {} }); this._ezEdgeEls = []; } catch (_) {} try { if (this._eztlPool) { this._eztlPool.forEach((v) => { try { v.pause(); v.remove(); } catch (_) {} }); this._eztlPool.clear(); } if (this._eztlPre) this._eztlPre.remove(); } catch (_) {} try { if (this._ezlpRoot) this._ezlpRoot.remove(); } catch (_) {} this._ezlpSetup = false; try { if (this._eztlFsH) document.removeEventListener('fullscreenchange', this._eztlFsH); } catch (_) {} return r; };
}

// ===== 监听 SegmentPanel 落盘事件，循环中每段完成后实时更新 TimeLine =====
try {
  api.addEventListener("ezflex.segment", (e) => {
    const d = e.detail || {};
    const { index, total, saved, file } = d;
    if (index == null || total == null) return;
    try {
      const nodes = (app.graph && app.graph._nodes) || [];
      for (const n of nodes) {
        if (nodeTypeOf(n) !== TIME_LINE) continue;
        try {
          const plan = tlPlan(n);
          if (!plan || !plan.segs) continue;   // 不要求 total 完全相等：重跑时 TimePlan 可能被临时扩展
          if (!n._ezSegDone) n._ezSegDone = {};
          if (d.dir) n._ezSegDir = String(d.dir);          // ★ 本次 run 的实际目录（不是旧属性）
          if (Number(index) === 0) { n._ezSegFinal = ""; try { delete n.properties.ezSegFinal; } catch (_) {} }
          n._ezSegDone[index + 1] = { path: saved || "", file: file || "" };
          n._ezSegVer = (n._ezSegVer || 0) + 1;   // 同一路径换内容：URL 加版本，避免浏览器/池子拿旧视频
          try {   // 随工作流落盘：刷新/重启后还能回看已落盘的分段成片
            n.properties = n.properties || {};
            n.properties.ezSegDone = Object.assign({}, n._ezSegDone);
            if (d.dir) n.properties.ezSegDir = String(d.dir);
            if (d.final) { n._ezSegFinal = String(d.final); n.properties.ezSegFinal = String(d.final); }
          } catch (_) {}
          if (n._ezlpUpdate) n._ezlpUpdate();
        } catch (_) {}
      }
    } catch (_) {}
  });
} catch (_) {}

app.registerExtension({
  name: 'EzFlex.LoopNodes',
  async beforeRegisterNodeDef(nt, nd) {
    if (!nd) return;
    if (nd.name === MERGE_LIST || nd.name === LOOP_START || nd.name === LOOP_END || nd.name === SPLIT_LIST || nd.name === TIME_LINE) hook(nt);
  },
  nodeCreated(n) {
    const t = nodeTypeOf(n);
    if (!(t === MERGE_LIST || t === LOOP_START || t === LOOP_END || t === SPLIT_LIST || t === TIME_LINE)) return;
    try { setup(n); } catch (_) {}
    // ★ 端口兜底（2026-10-15）：**端口契约不能依赖面板挂载成功** —— 面板挂失败时也要把
    //   `LoopEnd` 的 `timeplan` 口补上/排到第 0 位（`ensurePlanPort` 在 `trimLoopSockets` 里），
    //   以及 `TimeLine` 的输出口清干净。同 `time_plan.js` / `motion_context.js` / `segment_panel.js`。
    try {
      if (t === LOOP_START || t === LOOP_END) trimLoopSockets(n);
      if (t === TIME_LINE) stripTlSockets(n);
    } catch (_) {}
  },
});
// 供其它面板复用（EzFlex-TimePlan 的参数栏要与 TimeLine **完全同款**：字段顺序、
// 模型显示名、以及悬停信息 tlInfoTip 的实时内容）。tlBindTip 用的是本模块的 _tlTip 气泡，
// 所以悬停外观也天然一致。
// ★ `notifyOut` / `tlNotifyPlanDownstream` 也导出：TimePlan 改参数后要顺着 `timeplan` 出口
//   **递归**通知下游（可能隔着 EzFlex-SplitVideo 这种透传节点），否则「改 timeplan 时间轴不动」。
export { TL_MODELS, tlPlan, tlInfoTip, tlBindTip, tlNum, tlWidget, notifyOut, tlUpstreamPlanNode, tlNotifyPlanDownstream };
export { tlSavedItems, tlRestoreSaved };   // 落盘分段回看（测试用）
