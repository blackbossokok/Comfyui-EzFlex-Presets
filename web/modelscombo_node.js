// ModelsCombo 节点内嵌控件（参考 comfyui-aaalice-nodes 的 addDOMWidget 做法）。
// 直接在 ModelsComboLoader 节点里渲染配置器 HTML/CSS/JS，状态实时写回 config 输入框，
// 由 config 输入框进 prompt、驱动 Python 节点 → 不再依赖会被缓存的独立 HTML 页面。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { makeDomWidgetHitThrough, scheduleOnRedraw, pumpFrames } from "./ezflex_service.js";

// ===== 现代乳白风样式（ModelsCombo 内嵌面板同套观感）=====
const MC_CSS = `
.mc-socket-strip{position:absolute;top:0;bottom:0;width:30px;pointer-events:none;z-index:5;}
.mc-socket-strip-l{left:0;}
.mc-socket-strip-r{right:0;}
.mc-node-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.mc-node-shell .mc-node-root{pointer-events:auto;}
.mc-node-root{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f2b;background:#ffffff;border-radius:10px;padding:10px 2px 0px;display:flex;flex-direction:column;gap:4px;width:auto;min-width:0;min-height:0;height:100%;box-sizing:border-box;user-select:none;-webkit-user-select:none;margin:0 14px;overflow:hidden;}
.mc-node-root select{user-select:none;-webkit-user-select:none;}
.mc-bar{display:flex;gap:4px;align-items:center;}
.mc-add{flex:0.7;min-width:0;height:26px;padding:4px 8px;font-size:11px;border:1px solid #dce3ec;border-radius:6px;background:#fff;color:#1a1f2b;outline:none;cursor:pointer;transition:.15s ease;font-family:inherit;box-sizing:border-box;}
.mc-add:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(43,58,74,.06);}
.mc-list{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:4px;overflow:auto;padding:2px;}
.mc-row{display:flex;flex-wrap:nowrap;gap:2px;align-items:center;padding:5px 6px;border:1px solid #eef1f6;border-radius:7px;background:#f9fafb;box-shadow:0 1px 3px rgba(0,0,0,.03);transition:.15s ease;}
.mc-row:hover{border-color:#dce3ec;box-shadow:0 3px 10px rgba(0,0,0,.05);}
.mc-idx{flex:0 0 auto;font-size:9px;color:#8a9aa8;min-width:15px;text-align:center;font-feature-settings:"tnum";}
.mc-type{flex:0 0 56px;min-width:0px;padding:3px 4px;font-size:9px;border:1px solid #dce3ec;border-radius:5px;background:#f3f5f9;color:#1a1f2b;outline:none;cursor:pointer;font-family:inherit;}
.mc-name{flex:0.3 1 0;min-width:0;width:100%;padding:3px 4px;font-size:9px;border:1px solid #dce3ec;border-radius:5px;background:#fff;outline:none;font-family:inherit;transition:.15s ease;box-sizing:border-box;}
.mc-name:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(43,58,74,.06);}
.mc-param{flex:0.7 1 0;min-width:0;display:flex;align-items:center;gap:2px;background:rgba(0,0,0,.02);border:1px solid #eef1f6;border-radius:5px;padding:3px 2px;}
.mc-plabel{font-size:8px;color:#64748b;font-weight:600;letter-spacing:.2px;white-space:nowrap;text-transform:uppercase;}
.mc-param select{flex:1 1 0;min-width:0;width:100%;padding:2px 4px;font-size:10px;border:1px solid #dce3ec;border-radius:4px;background:#fff;outline:none;cursor:pointer;font-family:inherit;box-sizing:border-box;}
.mc-param select:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(43,58,74,.06);}
.mc-range-wrap{display:flex;align-items:center;gap:3px;flex:1 1 0;min-width:54px;margin-right:8px;border:1px dashed transparent;}
.mc-range-wrap:last-child{margin-right:0;}
.mc-range{flex:1 1 auto;min-width:0;max-width:none;height:4px;-webkit-appearance:none;appearance:none;background:#dce3ec;border-radius:2px;outline:none;padding:0;margin:0;}
.mc-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:#2b3a4a;cursor:pointer;border:1px solid #1a2530;}
.mc-range::-webkit-slider-thumb:hover{transform:scale(1.1);}
.mc-range::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#2b3a4a;cursor:pointer;border:1px solid #1a2530;}
.mc-range-num{flex:0 0 22px;width:22px;padding:2px 0;font-size:9px;border:1px solid #dce3ec;border-radius:4px;background:#fff;outline:none;font-family:inherit;-moz-appearance:textfield;text-align:center;box-sizing:border-box;}
.mc-range-num::-webkit-outer-spin-button,.mc-range-num::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.mc-target{flex:0.4 1 0;min-width:40px;padding:3px 3px;font-size:9px;border:1px solid #dce3ec;border-radius:5px;background:#f3f5f9;outline:none;cursor:pointer;font-family:inherit;}
.mc-target:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(43,58,74,.06);}
.mc-del{flex:0 0 auto;width:22px;height:22px;border:none;border-radius:5px;background:transparent;color:#6b7a8e;cursor:pointer;font-size:12px;line-height:1;transition:.15s ease;}
.mc-del:hover{background:#f5dede;color:#c0392b;}
.mc-empty{display:flex;align-items:center;justify-content:center;min-height:0 px;flex:1 1 auto;color:#6b7a8e;background:rgba(0,0,0,.02);border:1px dashed #dce3ec;border-radius:6px;margin:2px;font-size:12px;}
.mc-warn{font-size:10px;color:#b3261e;background:#fdeaec;border:1px solid #f2b8b5;border-radius:5px;padding:5px 8px;font-weight:500;}
.mc-preview-popup{position:fixed;pointer-events:none;z-index:9999;background:#fff;border:1px solid #dce3ec;border-radius:8px;box-shadow:0 10px 34px rgba(0,0,0,.16);padding:6px;display:none;}
.mc-preview-popup.visible{display:block;}
.mc-preview-img{max-width:380px;max-height:300px;width:auto;height:auto;object-fit:contain;border-radius:4px;background:#f0ece6;display:block;}
.mc-preview-video{max-width:380px;max-height:300px;width:auto;height:auto;border-radius:4px;background:#000;display:none;}
.mc-preview-label{font-size:10px;color:#64748b;text-align:center;padding-top:4px;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mc-preview-ph{background:#e8e2da;display:flex;align-items:center;justify-content:center;color:#8a9aa8;font-size:11px;width:120px;height:90px;}
.mc-grip{flex:0 0 auto;width:16px;height:auto;color:#6b7a8e;cursor:grab;font-size:11px;text-align:center;user-select:none;}
.mc-grip:hover{color:#64748b;}
.mc-grip::before{content:'⠿';}
.mc-preset-name{flex:0.3 0 84px;min-width:58px;height:26px;padding:4px 8px;font-size:10px;border:1px solid #dce3ec;border-radius:5px;background:#fff;outline:none;font-family:inherit;box-sizing:border-box;}
.mc-preset-btn{height:25px;padding:4px 12px;font-size:10px;font-weight:600;border:1px solid #2b3a4a;border-radius:5px;background:#2b3a4a;color:#fff;cursor:pointer;white-space:nowrap;font-family:inherit;transition:.15s ease;box-sizing:border-box;}
.mc-preset-btn:hover{background:#1f2c39;border-color:#1f2c39;box-shadow:0 4px 10px rgba(43,58,74,.18);}
.mc-preset-sel{flex:0 0 92px;min-width:64px;height:26px;padding:4px 6px;font-size:10px;border:1px solid #dce3ec;border-radius:5px;background:#fff;outline:none;cursor:pointer;font-family:inherit;box-sizing:border-box;}
.mc-combo{position:relative;flex:1.5 1 0;min-width:0;}
.mc-combo-trigger{width:100%;height:26px;padding:4px 6px;font-size:10px;border:1px solid #dce3ec;border-radius:5px;background:#fff;outline:none;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px;box-sizing:border-box;}
.mc-combo-trigger:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(43,58,74,.06);}
.mc-combo-value{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;color:#1a1f2b;}
.mc-combo-arrow{flex:0 0 auto;font-size:8px;color:#8a9aa8;}
.mc-combo-list{position:fixed;z-index:9998;background:#fff;border:1px solid #dce3ec;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.14);max-height:240px;overflow:auto;display:none;min-width:220px;padding:4px;}
.mc-combo-list.visible{display:block;}
.mc-combo-option{padding:4px 8px;font-size:10px;color:#64748b;cursor:default;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:inherit;}
.mc-combo-option:hover,.mc-combo-option.sel{background:#e9eef5;color:#1a1f2b;}
.mc-combo-empty{padding:6px 8px;font-size:10px;color:#8a9aa8;}
.mc-row.mc-drop-target{outline:2px dashed #64748b;outline-offset:-2px;border-color:#64748b;background:#f3f5f9;}
.mc-lora-divider{display:flex;align-items:center;gap:8px;margin:4px 10px 4px;height:10px;flex:0 0 auto;}
.mc-lora-divider::before,.mc-lora-divider::after{content:'';flex:1 1 0;height:1px;background:linear-gradient(90deg,rgba(0,0,0,0),rgba(0,0,0,.14));}
.mc-lora-divider::after{background:linear-gradient(90deg,rgba(0,0,0,.14),rgba(0,0,0,0));}
.mc-lora-divider .mc-lora-tag{flex:0 0 auto;font-size:8px;color:#8a9aa8;letter-spacing:.4px;text-transform:uppercase;user-select:none;}
.mc-drop-line{position:fixed;height:3px;background:#64748b;border-radius:2px;z-index:9999;pointer-events:none;display:none;box-shadow:0 0 8px rgba(138,122,106,.7);}
.mc-socket-label{position:fixed;z-index:20;pointer-events:none;background:rgba(26,36,48,0.5);color:#e8e8f0;font-size:9px;line-height:1;padding:2px 6px;border-radius:3px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;user-select:none;display:inline-flex;align-items:center;}
.mc-socket-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;margin-right:5px;border:1px solid rgba(255,255,255,.3);}
.mc-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px;}
.mc-browse{flex:0 0 auto;min-width:52px;height:26px;padding:4px 8px;font-size:11px;border:1px solid #dce3ec;border-radius:6px;background:#f3f5f9;color:#1a1f2b;outline:none;cursor:pointer;font-family:inherit;transition:.15s ease;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:2px;}
.mc-browse:hover{background:#e9eef5;border-color:#64748b;}
.mc-bb-overlay{position:fixed;inset:0;z-index:9998;background:#f5f6f8;color:#1a1f2b;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:none;flex-direction:column;}
.mc-bb-overlay.open{display:flex;}
.mc-bb-header{display:flex;align-items:center;gap:10px;padding:12px 54px 12px 18px;background:#fff;border-bottom:1px solid #e6e9ef;flex-shrink:0;position:relative;}
.mc-bb-title{font-size:15px;font-weight:600;white-space:nowrap;}
.mc-bb-badge{font-size:11px;color:#6b7a8e;font-weight:500;}
.mc-bb-search{flex:1 1 auto;max-width:360px;min-width:120px;padding:6px 10px;font-size:12px;border:1px solid #dce3ec;border-radius:7px;background:#fff;outline:none;font-family:inherit;}
.mc-bb-search:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(43,58,74,.06);}
.mc-bb-searchfield{flex:0 0 auto;min-width:100px;max-width:150px;height:32px;padding:4px 8px;font-size:12px;border:1px solid #dce3ec;border-radius:7px;background:#fff;outline:none;font-family:inherit;cursor:pointer;box-sizing:border-box;}
.mc-bb-searchfield:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(43,58,74,.06);}
.mc-bb-count{font-size:12px;color:#6b7a8e;white-space:nowrap;}
.mc-bb-close{position:absolute;top:10px;right:12px;z-index:5;width:30px;height:30px;border-radius:50%;border:1px solid rgba(220,38,38,.32);background:rgba(220,38,38,.1);color:#dc2626;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;box-shadow:0 2px 8px rgba(0,0,0,.06);}
.mc-bb-close:hover{background:rgba(220,38,38,.22);color:#b91c1c;border-color:rgba(220,38,38,.5);}
.mc-bb-tabs{display:flex;align-items:center;gap:6px;padding:8px 18px;border-bottom:1px solid #e6e9ef;background:#fff;flex-shrink:0;}
.mc-bb-tab{padding:5px 14px;font-size:12px;border-radius:7px;border:1px solid #e6e9ef;background:#fff;color:#6b7a8e;cursor:pointer;font-family:inherit;transition:.15s;}
.mc-bb-tab:hover{background:#f3f5f9;color:#1a1f2b;}
.mc-bb-tab.active{background:#2b3a4a;color:#fff;border-color:#2b3a4a;}
.mc-bb-body{flex:1 1 auto;overflow:hidden;display:flex;min-height:0;}
.mc-bb-side{width:230px;flex-shrink:0;background:#fff;border-right:1px solid #e6e9ef;display:flex;flex-direction:column;overflow:hidden;transition:width .2s;}
.mc-bb-side.collapsed{width:34px;border-right:1px solid #e6e9ef;}
.mc-bb-side.collapsed .mc-bb-side-title,
.mc-bb-side.collapsed .mc-bb-sbtn:not(.mc-bb-sbtn-hide){display:none;}
.mc-bb-side.collapsed .mc-bb-tree{display:none;}
.mc-bb-side.collapsed .mc-bb-sidehead{justify-content:center;padding:8px 0;border-bottom:none;}
.mc-bb-sidehead{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:8px 10px;border-bottom:1px solid #eef1f6;flex-shrink:0;}
.mc-bb-side-title{font-size:12px;font-weight:600;color:#1a1f2b;flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mc-bb-sidebtns{display:flex;gap:2px;flex-shrink:0;}
.mc-bb-sbtn{width:22px;height:22px;background:transparent;border:none;color:#6b7a8e;cursor:pointer;border-radius:4px;font-size:11px;display:flex;align-items:center;justify-content:center;}
.mc-bb-sbtn:hover{background:#eef1f6;color:#1a1f2b;}
.mc-bb-sbtn.active{background:rgba(43,58,74,.12);color:#2b3a4a;}
.mc-bb-tree{flex:1 1 auto;overflow:auto;padding:6px 0;}
.mc-bb-tnode{user-select:none;}
.mc-bb-trow{display:flex;align-items:center;gap:4px;padding:6px 10px;cursor:pointer;border-left:3px solid transparent;font-size:12px;color:#1a1f2b;white-space:nowrap;}
.mc-bb-trow:hover{background:#f3f5f9;}
.mc-bb-trow.sel{background:rgba(43,58,74,.1);border-left-color:#2b3a4a;color:#2b3a4a;font-weight:500;}
.mc-bb-twist{width:16px;height:16px;display:flex;align-items:center;justify-content:center;transition:transform .2s;color:#8a9aa8;font-size:10px;flex-shrink:0;}
.mc-bb-twist.expanded{transform:rotate(90deg);}
.mc-bb-twist.leaf{opacity:0;pointer-events:none;}
.mc-bb-ficon{color:#8a9aa8;font-size:12px;flex-shrink:0;display:flex;align-items:center;}
.mc-bb-trow.sel .mc-bb-ficon{color:#2b3a4a;}
.mc-bb-fname{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;}
.mc-bb-tkids{overflow:hidden;max-height:0;transition:max-height .25s;}
.mc-bb-tkids.expanded{max-height:50000px;}
.mc-bb-tkids .mc-bb-trow{padding-left:26px;}
.mc-bb-tkids .mc-bb-tkids .mc-bb-trow{padding-left:42px;}
.mc-bb-listmode{padding:6px 8px;display:flex;flex-direction:column;gap:2px;}
.mc-bb-listrow{padding:6px 10px;font-size:12px;color:#1a1f2b;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:6px;}
.mc-bb-listrow:hover{background:#f3f5f9;}
.mc-bb-listrow.sel{background:rgba(43,58,74,.1);color:#2b3a4a;font-weight:500;}
.mc-bb-main{flex:1 1 auto;overflow:auto;padding:16px 18px;min-width:0;}
.mc-bb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;}
.mc-bb-empty,.mc-bb-loading{color:#8a9aa8;text-align:center;padding:48px 16px;font-size:13px;}
.mc-bb-empty{background:#fff;border:1px dashed #dce3ec;border-radius:12px;}
.mc-b-card{position:relative;background:#fff;border:1px solid #eef1f6;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.04);transition:.15s ease;cursor:pointer;}
.mc-b-card:hover{border-color:#dce3ec;box-shadow:0 6px 18px rgba(0,0,0,.06);transform:translateY(-1px);}
.mc-b-thumb{position:relative;aspect-ratio:3/4;background:#e8ebf0;overflow:hidden;}
.mc-b-thumb img,.mc-b-thumb video{width:100%;height:100%;object-fit:cover;display:block;}
.mc-b-noph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#8a9aa8;font-size:11px;background:#e8ebf0;}
.mc-b-type{position:absolute;top:8px;left:8px;padding:2px 8px;font-size:10px;font-weight:600;border-radius:6px;background:rgba(26,31,43,.72);color:#fff;backdrop-filter:blur(2px);}
.mc-b-type.checkpoint{background:rgba(74,127,168,.85);}
.mc-b-type.unet{background:rgba(58,138,106,.85);}
.mc-b-type.lora{background:rgba(168,90,106,.85);}
.mc-b-info{position:absolute;left:0;right:0;bottom:0;padding:10px 10px 8px;display:flex;flex-direction:column;gap:3px;background:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,.42) 55%,rgba(0,0,0,.62) 100%);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}
.mc-b-name{font-size:12px;font-weight:700;color:#fff;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;text-shadow:0 1px 2px rgba(0,0,0,.45);}
.mc-b-version{display:inline-flex;align-self:flex-start;padding:1px 8px;font-size:10px;font-weight:600;color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:5px;background:rgba(255,255,255,.22);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);}
.mc-b-add{position:absolute;top:8px;right:8px;z-index:3;width:30px;height:30px;border-radius:50%;border:1px solid rgba(255,255,255,.5);background:rgba(255,255,255,.35);color:#1a1f2b;font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:.15s;}
.mc-b-add:hover{background:rgba(255,255,255,.6);transform:scale(1.05);}
.mc-b-add.added{background:rgba(74,106,90,.85);border-color:rgba(74,106,90,.9);color:#fff;}
.mc-b-add.added:hover{background:rgba(61,90,77,.95);}
.mc-bd-overlay{position:fixed;inset:0;z-index:9999;background:rgba(17,22,30,.42);display:none;align-items:center;justify-content:center;padding:20px;}
.mc-bd-overlay.open{display:flex;}
.mc-bd-box{background:#fff;border-radius:14px;width:min(720px,94vw);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.22);overflow:hidden;}
.mc-bd-head{display:flex;align-items:center;gap:10px;padding:12px 54px 12px 16px;border-bottom:1px solid #eef1f6;flex-shrink:0;position:relative;}
.mc-bd-title{flex:1 1 auto;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mc-bd-type{flex:0 0 auto;padding:2px 8px;font-size:10px;font-weight:600;border-radius:6px;background:#eef1f6;color:#1a1f2b;}
.mc-bd-add{flex:0 0 auto;padding:6px 12px;font-size:12px;font-weight:600;border:1px solid #2b3a4a;border-radius:7px;background:#2b3a4a;color:#fff;cursor:pointer;font-family:inherit;}
.mc-bd-add:hover{background:#1f2c39;}
.mc-bd-add.added{background:#4a6a5a;border-color:#4a6a5a;}
.mc-bd-add.added:hover{background:#3d5a4d;}
.mc-bd-close{position:absolute;top:10px;right:12px;z-index:5;width:28px;height:28px;border-radius:50%;border:1px solid #eef1f6;background:#fff;color:#6b7a8e;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;box-shadow:0 2px 6px rgba(0,0,0,.06);}
.mc-bd-close:hover{background:#eef1f6;color:#1a1f2b;}
.mc-bd-body{flex:1 1 auto;overflow:auto;padding:16px 18px;display:flex;flex-direction:column;gap:14px;}
.mc-bd-img{width:100%;max-height:360px;object-fit:cover;border-radius:10px;background:#e8ebf0;display:block;}
.mc-bd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px 14px;}
.mc-bd-field{padding:8px 10px;background:#fafbfc;border:1px solid #eef1f6;border-radius:8px;display:flex;flex-direction:column;gap:3px;min-width:0;}
.mc-bd-fk{font-size:10px;color:#6b7a8e;font-weight:600;text-transform:uppercase;letter-spacing:.3px;}
.mc-bd-fv{font-size:12px;color:#1a1f2b;word-break:break-word;}
.mc-bd-sec{border-top:1px solid #eef1f6;padding-top:12px;display:flex;flex-direction:column;gap:6px;}
.mc-bd-sec-title{font-size:12px;font-weight:600;color:#1a1f2b;}
.mc-bd-text{font-size:12px;color:#3a4350;line-height:1.6;word-break:break-word;white-space:pre-wrap;}
.mc-bd-desc{font-size:12px;color:#3a4350;line-height:1.6;word-break:break-word;}
.mc-bd-desc h1,.mc-bd-desc h2,.mc-bd-desc h3{font-size:13px;color:#1a1f2b;margin:6px 0 4px;}
.mc-bd-desc p{margin:4px 0;}
.mc-bd-desc a{color:#4a7fa8;}
.mc-bd-desc ul,.mc-bd-desc ol{margin:4px 0 4px 18px;}
.mc-bd-desc li{margin:2px 0;}
.mc-bd-desc code{background:#f0f2f6;border-radius:4px;padding:1px 4px;font-size:11px;}
.mc-bd-desc pre{background:#f0f2f6;border-radius:6px;padding:8px;overflow:auto;font-size:11px;}
.mc-bd-desc hr{border:none;border-top:1px solid #e6e9ef;margin:6px 0;}
.mc-bd-chips{display:flex;flex-wrap:wrap;gap:6px;}
.mc-bd-chip{padding:3px 9px;font-size:11px;border-radius:6px;background:#f3f5f9;border:1px solid #e6e9ef;color:#3a4350;}
.mc-bd-gallery{display:flex;flex-wrap:wrap;gap:8px;}
.mc-bd-gal{width:88px;height:88px;object-fit:cover;border-radius:6px;border:1px solid #eef1f6;cursor:pointer;background:#f0ece6;}
.mc-bd-link{font-size:12px;color:#4a7fa8;text-decoration:none;word-break:break-all;}
`;

let _styleInjected = false;
function injectStyle() {
  if (_styleInjected || typeof document === 'undefined' || !document.head) return;
  _styleInjected = true;
  const s = document.createElement('style');
  s.textContent = MC_CSS;
  document.head.appendChild(s);
}

console.info('[ModelsCombo] modelscombo_node.js loaded, addDOMWidget support:',
  typeof (window.LGraphNode && window.LGraphNode.prototype) === 'object' ? 'litegraph present' : 'no litegraph');

(function () {
  'use strict';

  const NODE = 'EzFlex-ModelsCombo';
  const MIN_WIDTH = 600;

  const TYPE_ORDER = ['unet', 'clip', 'vae', 'checkpoint', 'lora'];
  const MAIN_TYPES = ['unet', 'clip', 'vae', 'checkpoint'];
  const FOLDER_BY_TYPE = {
    checkpoint: 'checkpoints',
    unet: 'diffusion_models',
    clip: 'text_encoders',
    vae: 'vae',
    lora: 'loras'
  };

  const WEIGHT_OPTS = ['default', 'fp16', 'bf16', 'fp32', 'fp8_e4m3fn', 'fp8_e4m3fn_fast', 'fp8_e5m2'];
  const CLIP_TYPES = [
    'stable_diffusion', 'stable_cascade', 'sd3', 'stable_audio', 'mochi', 'ltxv', 'pixart',
    'cosmos', 'lumina2', 'wan', 'hidream', 'chroma', 'ace', 'omnigen2', 'qwen_image',
    'hunyuan_image', 'flux2', 'ovis', 'longcat_image', 'cogvideox', 'lens', 'pixeldit',
    'ideogram4', 'boogu', 'krea2', 'joyimage', 'mage', 'minimax'
  ];
  const DEVICE_OPTS = ['default', 'cuda', 'cpu', 'cuda:0', 'cuda:1'];

  const LABEL = { checkpoint: 'Checkpoint', unet: 'UNET', clip: 'CLIP', vae: 'VAE', lora: 'LoRA' };
  const DOT = { checkpoint: '#4a7fa8', unet: '#3a8a6a', clip: '#b8954a', vae: '#7a5a9a', lora: '#a85a6a' };

  const EXTRA = {
    checkpoint: [{ key: 'weight_dtype', label: '权重类型', type: 'select', opts: WEIGHT_OPTS }],
    unet: [
      { key: 'device', label: '设备', type: 'select', opts: DEVICE_OPTS },
      { key: 'weight_dtype', label: '权重类型', type: 'select', opts: WEIGHT_OPTS }
    ],
    clip: [
      { key: 'type', label: '类型', type: 'select', opts: CLIP_TYPES },
      { key: 'device', label: '设备', type: 'select', opts: DEVICE_OPTS }
    ],
    vae: [
      { key: 'device', label: '设备', type: 'select', opts: DEVICE_OPTS },
      { key: 'weight_dtype', label: '权重类型', type: 'select', opts: ['default', 'fp16', 'bf16', 'fp32'] }
    ],
    lora: [
      { key: 'strength_model', label: '模型', type: 'range', def: 1.0, min: -5, max: 5, step: 0.1 },
      { key: 'strength_clip', label: 'CLIP', type: 'range', def: 1.0, min: -5, max: 5, step: 0.1 }
    ]
  };

  function stateFor(node) {
    if (!node._mc) node._mc = { loaders: [], files: {} };
    return node._mc;
  }

  function configWidget(node) {
    return (node.widgets || []).find((w) => w.name === 'config');
  }

  function defaultExtra(type) {
    const out = {};
    (EXTRA[type] || []).forEach((f) => {
      if (f.type === 'range') out[f.key] = f.def;
      else out[f.key] = (f.opts || [])[0] || '';
    });
    return out;
  }

  function isMainType(type) { return MAIN_TYPES.includes(type); }

  function parseLoaders(text) {
    if (!text) return [];
    try {
      const data = JSON.parse(text);
      const arr = Array.isArray(data) ? data : (data && Array.isArray(data.loaders) ? data.loaders : []);
      return arr.map((l) => ({
        id: typeof l.id === 'number' ? l.id : -1,
        type: TYPE_ORDER.includes(l.type) ? l.type : 'unet',
        name: l.name || '',
        file: l.file || '',
        extra: { ...defaultExtra(l.type || 'unet'), ...(l.extra || {}) },
        targetId: l.targetId || null
      }));
    } catch (_) {
      return [];
    }
  }

  function syncToConfig(node) {
    const st = stateFor(node);
    const w = configWidget(node);
    if (!w) return;
    const json = JSON.stringify(st.loaders);
    w.value = json;
    if (typeof w.callback === 'function') w.callback(json);
    if (node.graph) node.graph.setDirtyCanvas(true, true);
  }

  function loadFromConfig(node) {
    const st = stateFor(node);
    const w = configWidget(node);
    st.loaders = parseLoaders(w ? w.value : '');
  }

  function portCounts(loaders) {
    const mains = loaders.filter((l) => isMainType(l.type));
    let models = 0, clips = 0, vaes = 0;
    mains.forEach((l) => {
      if (l.type === 'checkpoint') { models++; clips++; vaes++; }
      else if (l.type === 'unet') models++;
      else if (l.type === 'clip') clips++;
      else if (l.type === 'vae') vaes++;
    });
    return { models, clips, vaes };
  }

  function mainDisplayName(l) {
    return l.name || (LABEL[l.type] || l.type) + '_' + (typeof l.id === 'number' ? l.id : '');
  }

  // 估算「一行放得下所有加载器参数」所需的最小宽度（节点初始/最小宽度据此设定）
  function estimateRowWidth(node) {
    const list = stateFor(node).loaders.length ? stateFor(node).loaders : [null];
    let maxW = 0;
    list.forEach((l) => {
      const type = l ? l.type : 'unet';
      let w = 15 + 50 + 64 + 108 + 22 + 20; // idx + type + name + file + del + 上下移按钮
      (EXTRA[type] || []).forEach((f) => {
        w += (f.type === 'range') ? 96 : 64; // label + control + gaps
      });
      if (type === 'lora') w += 64; // target select
      const items = 5 + (EXTRA[type] || []).length + (type === 'lora' ? 1 : 0);
      w += Math.max(0, items - 1) * 5; // 相邻 item 间距
      w += 18; // 行内 padding
      if (w > maxW) maxW = w;
    });
    return Math.max(MIN_WIDTH, maxW);
  }

  // 输出口按实际配置动态重建（MODEL…/CLIP…/VAE…，数量随加载器），并同步标签=加载器名
  function updatePorts(node, noRedraw) {
    if (!node || !node.outputs) return false;
    const st = stateFor(node);
    const mains = st.loaders.filter((l) => ['checkpoint', 'unet', 'clip', 'vae'].indexOf(l.type) >= 0);
    const sr = (nm) => String(nm || '').split('.').pop() || '';
    // 输出顺序 = 加载器顺序：每个主加载器按自身类型依次产出 model/clip/vae（checkpoint 三者相邻），与 Python load_combo 一致
    const want = [];
    mains.forEach((l) => {
      const b = sr(l.name || l.type);
      if (['checkpoint', 'unet'].indexOf(l.type) >= 0) want.push(['MODEL', b + '_model']);
      if (['checkpoint', 'clip'].indexOf(l.type) >= 0) want.push(['CLIP', b + '_clip']);
      if (['checkpoint', 'vae'].indexOf(l.type) >= 0) want.push(['VAE', b + '_vae']);
    });
    let changed = false;
    // 快照旧输出：优先按「名称」复用（拖拽排序时连接跟随同名 socket）。
    // 名称变了但「类型+位置」没变（如 anima→krea2 都是 checkpoint）时按位置+类型复用该 socket（保留连接，只改名）。
    const old = (node.outputs || []).slice();
    const used = new Set();
    const byName = {};
    old.forEach((o, i) => { if (o && o.name) byName[o.name] = i; });
    const seq = [];
    want.forEach((w, wi) => {
      let sock = null;
      // 1) 按名称复用同名 socket
      if (byName[w[1]] != null && !used.has(byName[w[1]])) { sock = old[byName[w[1]]]; used.add(byName[w[1]]); }
      // 2) 名称变了但同一位置的类型没变：复用该位置 socket（保留连接，只改名）
      if (!sock && old[wi] && !used.has(wi) && old[wi].type === w[0]) { sock = old[wi]; used.add(wi); }
      // 3) 无法复用：新建（无连接）
      if (!sock) { node.addOutput(w[1], w[0], {}); sock = node.outputs[node.outputs.length - 1]; changed = true; }
      if (sock.type !== w[0]) { try { sock.type = w[0]; } catch (_) { /* 忽略 */ } changed = true; }
      if (sock.name !== w[1]) { sock.name = w[1]; changed = true; }
      sock.hidden = false;
      seq.push(sock);
    });
    // 删除未被复用的旧 socket（其连接随 removeOutput 一并清除）
    old.forEach((o, i) => {
      if (!used.has(i)) {
        const idx = node.outputs.indexOf(o);
        if (idx >= 0) { node.removeOutput(idx); changed = true; }
      }
    });
    // 3) 原地重排 node.outputs 成 want 顺序（保持数组引用不变），并把每个输出 link 的 origin_slot 改成它在新数组里的下标
    if (node.outputs.length !== seq.length || node.outputs.some((o, i) => o !== seq[i])) {
      for (let i = 0; i < seq.length; i++) node.outputs[i] = seq[i];
      node.outputs.length = seq.length;
      changed = true;
    }
    // 连接存的是 o.links（数组，兼容旧版 o.link）。重排后把每个 link 的 origin_slot 改成它在新数组里的下标，
    // 这样下游实际接的是哪个输出才对得上（不重排的话视觉对但真实连接错）。
    node.outputs.forEach((o, i) => {
      const ids = [];
      if (Array.isArray(o.links)) ids.push(...o.links);
      if (o.link != null) ids.push(o.link);
      ids.forEach((lid) => {
        if (lid != null && node.graph && node.graph.links && node.graph.links[lid]) {
          try { node.graph.links[lid].origin_slot = i; } catch (_) { /* 忽略 */ }
        }
      });
    });
    // 清理残留的 model_in/clip_in/vae_in 输入口（本节点只输出不输入）
    (node.inputs || []).slice().forEach((x) => {
      if (x && x.name && /^(model_in|clip_in|vae_in)_/.test(x.name)) { node.removeInput(node.inputs.indexOf(x)); changed = true; }
    });
    if (changed && node.graph) node.graph.setDirtyCanvas(true, true);
    if (changed && !noRedraw && typeof node.setSize === 'function') {
      const s = node.size || [MIN_WIDTH, 200];
      node.setSize([Math.max(MIN_WIDTH, s[0]), Math.max(160, s[1])]);
    }
    // 把当前输出排列同步到 Python 类 RETURN_TYPES，避免 ComfyUI 校验时读类属性导致类型不匹配
    if (changed) syncOutputTypes(node);
    return changed;
  }

  // 把模型组合的 config 交给后端，让 ModelsComboLoader.RETURN_TYPES/RETURN_NAMES 与前端 socket 保持一致。
  // 立即 POST（不防抖）：拖动/编辑一旦提交（updatePorts 只在 commit 时调用），类 RETURN_TYPES/RETURN_NAMES
  // 必须立刻跟上 socket 顺序，否则其它依赖这些类属性判定端口类型/名称的节点（如读模型名）会读到旧值而报「不兼容」。
  function syncOutputTypes(node) {
    try {
      const fetcher = api && typeof api.fetchApi === 'function' ? (p, o) => api.fetchApi(p, o) : (p, o) => fetch(p, o);
      fetcher('/models_combo/outputs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: JSON.stringify(stateFor(node).loaders) }) }).catch(() => {});
    } catch (_) { /* 忽略 */ }
  }

  // 诊断：列出每个输出 socket 挂载的加载器（名称/主索引/是其第几个端口），用于验证拖动后输出是否随加载器顺序变化。
  // 浏览器控制台使用：__ezDumpCombo() （自动找到所有 ModelsCombo 节点）；或 __ezDumpBindings(node)。
  function dumpLoadersOf(node) {
    const st = stateFor(node);
    const mains = st.loaders.filter((l) => isMainType(l.type));
    const rows = (node.outputs || []).map((o, i) => {
      let pos = 0, owner = null, slot = -1;
      for (let k = 0; k < mains.length; k++) {
        const l = mains[k];
        const cnt = (l.type === 'checkpoint' ? 3 : (['unet', 'clip', 'vae'].indexOf(l.type) >= 0 ? 1 : 0));
        if (cnt > 0 && i >= pos && i < pos + cnt) { owner = l; slot = i - pos; break; }
        pos += cnt;
      }
      return { socket: i, label: o.name, type: o.type, loaderName: owner ? (owner.name || owner.type) : '-', loaderIdx: owner ? (mains.indexOf(owner) + 1) : '-', slotInLoader: slot >= 0 ? slot : '-' };
    });
    // 也打印「实际写入 config widget 的顺序」，用来核对 load_combo 收到的加载器顺序
    const cfgW = configWidget(node);
    let cfgOrder = [];
    try { cfgOrder = JSON.parse(cfgW ? cfgW.value : '[]').map((l) => (l.type || '') + ':' + (l.name || '')); } catch (_) {}
    return { rows, configOrder: cfgOrder };
  }
  window.__ezDumpBindings = function (node) {
    try {
      const d = dumpLoadersOf(node);
      console.log('[EzFlex] 输出端口→加载器绑定', JSON.stringify(d.rows, null, 2));
      console.log('[EzFlex] 写入 config 的加载器顺序', JSON.stringify(d.configOrder));
      return d;
    }
    catch (e) { console.error('[EzFlex] dump failed', e); return null; }
  };
  window.__ezDumpCombo = function () {
    const nodes = ((app && app.graph && app.graph._nodes) || []).filter((n) => n && n.type === 'EzFlex-ModelsCombo');
    nodes.forEach((n) => { console.log('--- ModelsCombo node id=', n.id); window.__ezDumpBindings(n); });
    if (!nodes.length) console.warn('[EzFlex] 未找到 EzFlex-ModelsCombo 节点');
  };

  // LoRA「目标加载器」下拉实时跟随主加载器自定义名称变化（不重建整行，避免输入失焦）
  function refreshLoraTargets(node) {
    const root = node && node._mcRoot;
    if (!root) return;
    const st = stateFor(node);
    const loras = st.loaders.filter((l) => l.type === 'lora');
    const mains = st.loaders.filter((l) => isMainType(l.type));
    root.querySelectorAll('.mc-target').forEach((tgt, k) => {
      const lora = loras[k];
      if (!lora) return;
      const cur = tgt.value;
      tgt.innerHTML = '';
      const d = el('option', null, { value: '' });
      d.textContent = 'default';
      if (!lora.targetId) d.selected = true;
      tgt.appendChild(d);
      mains.forEach((m) => {
        const o = el('option', null, { value: String(typeof m.id === 'number' ? m.id : '') });
        o.textContent = mainDisplayName(m);
        if (m.id === lora.targetId) o.selected = true;
        tgt.appendChild(o);
      });
      if (cur && [...tgt.options].some((o) => o.value === cur)) tgt.value = cur;
      else if (lora.targetId != null) tgt.value = String(lora.targetId);
    });
  }

  function updateInputs(node, noRedraw) {
    return false;
  }

  function enforceSlots(node) { updatePorts(node, true); updateInputs(node, true); }

  function ensureFiles(node) {
    const st = stateFor(node);
    Object.keys(FOLDER_BY_TYPE).forEach((type) => { if (!st.files[type] || !st.files[type].length) st.files[type] = []; });
  }

  async function fetchFiles(node) {
    const st = stateFor(node);
    const fetcher = api && typeof api.fetchApi === 'function' ? (p) => api.fetchApi(p) : (p) => fetch(p);
    await Promise.all(Object.entries(FOLDER_BY_TYPE).map(async ([type, folder]) => {
      try {
        const res = await fetcher('/models/' + folder);
        if (res && res.ok) {
          const list = await res.json();
          if (Array.isArray(list) && list.length) st.files[type] = list;
        }
      } catch (_) { /* 忽略 */ }
    }));
    render(node);
  }

  // ===== 模型文件夹随点随刷：不后台轮询（避免无谓性能开销），改为「点击某加载器的文件下拉」时，
  // 先重新拉取该加载器所属文件夹的文件列表，再展开下拉 → 文件夹新增模型后，点开下拉就能看到。=====
  async function refreshFolderFor(node, type) {
    const st = stateFor(node);
    if (!st.files) return st.files;
    const folder = FOLDER_BY_TYPE[type];
    try {
      const fetcher = api && typeof api.fetchApi === 'function' ? (p) => api.fetchApi(p) : (p) => fetch(p);
      const res = await fetcher('/models/' + folder);
      if (res && res.ok) {
        const list = await res.json();
        if (Array.isArray(list)) st.files[type] = list;
      }
    } catch (_) { /* 忽略 */ }
    return st.files;
  }

  function el(tag, className, attrs) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (attrs) Object.keys(attrs).forEach((k) => { e.setAttribute(k, attrs[k]); });
    return e;
  }

  // ===== 悬停预览（读取模型文件夹内同名图片，由后端 /models_combo/preview 提供）=====
  const PREVIEW_PH = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="130"><rect width="200" height="130" fill="#e8e2da"/><text x="100" y="66" font-size="12" text-anchor="middle" fill="#8a9aa8" font-family="Inter">无预览图</text></svg>'
  );

  let _pv = null;
  function previewPopup() {
    if (!_pv) {
      const popup = el('div', 'mc-preview-popup');
      const img = el('img', 'mc-preview-img');
      img.alt = '预览';
      const video = document.createElement('video');
      video.className = 'mc-preview-video';
      video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true; video.alt = '预览';
      const lab = el('div', 'mc-preview-label');
      popup.appendChild(img); popup.appendChild(video); popup.appendChild(lab);
      document.body.appendChild(popup);
      _pv = { popup, img, video, lab };
    }
    return _pv;
  }

  function previewUrl(loader) {
    const type = loader.type || '';
    const file = loader.file || '';
    const qs = 'type=' + encodeURIComponent(type) + '&file=' + encodeURIComponent(file);
    return (api && typeof api.apiURL === 'function')
      ? api.apiURL('/models_combo/preview?' + qs)
      : ('/models_combo/preview?' + qs);
  }

  // 同时加载 <img> 和 <video>，哪个能播放/加载就显示哪个（图片/视频预览通用）
  let _mediaToken = 0;
  function loadMedia(pv, url, label) {
    const { img, video, lab } = pv;
    const t = ++_mediaToken;
    lab.textContent = label || '';
    img.classList.remove('mc-preview-ph');
    img.onload = () => { if (_mediaToken === t) { video.pause(); video.removeAttribute('src'); video.load(); video.style.display = 'none'; img.style.display = 'block'; } };
    img.onerror = () => { if (_mediaToken === t) { img.style.display = 'none'; } };
    video.onloadeddata = () => { if (_mediaToken === t) { img.style.display = 'none'; video.style.display = 'block'; try { video.play().catch(() => {}); } catch (_) {} } };
    video.onerror = () => { if (_mediaToken === t) { video.pause(); video.removeAttribute('src'); video.load(); video.style.display = 'none'; if (!img.src) { img.classList.add('mc-preview-ph'); img.style.display = 'block'; img.src = PREVIEW_PH; } } };
    img.style.display = 'block'; video.style.display = 'none'; video.pause();
    img.src = url; video.src = url;
  }

  function showPreview(e, loader) {
    if (_drag) return; // 拖动时不显示预览
    if (!loader || !loader.file) return;
    const { popup } = previewPopup();
    loadMedia(previewPopup(), previewUrl(loader), loader.file || loader.name || '');
    popup.classList.add('visible');
    const w = 212, h = 150;
    let left = e.clientX + 14;
    let top = e.clientY + 14;
    if (left + w > window.innerWidth) left = e.clientX - w - 14;
    if (top + h > window.innerHeight) top = window.innerHeight - h - 8;
    if (top < 8) top = 8;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }

  function hidePreview() {
    try { if (_pv && _pv.video) _pv.video.pause(); } catch (_) { /* 忽略 */ }
    if (_pv) _pv.popup.classList.remove('visible');
  }

  // 下拉模型变化时，若预览弹窗已打开则刷新
  function refreshPreview(loader) {
    if (!_pv || !_pv.popup.classList.contains('visible')) return;
    if (!loader || !loader.file) { loadMedia(_pv, PREVIEW_PH, loader ? loader.file || '' : ''); return; }
    loadMedia(_pv, previewUrl(loader), loader.file || '');
  }

  function buildRoot(node) {
    injectStyle();
    // 透明外壳 = 全节点尺寸（不遮圆点）；内部不透明面板带 margin 内缩（盖文字）
    const shell = el('div', 'mc-node-shell');
    const root = el('div', 'mc-node-root');
    shell.appendChild(root);

    const bar = el('div', 'mc-bar');
    const addSel = el('select', 'mc-add');
    addSel.appendChild(el('option', null, { value: '' })).textContent = '+ 添加加载器…';
    TYPE_ORDER.forEach((t) => {
      const o = el('option', null, { value: t });
      o.textContent = LABEL[t];
      addSel.appendChild(o);
    });
    const browseBtn = el('button', 'mc-browse');
    browseBtn.textContent = '⧉ 浏览';
    browseBtn.title = '浏览 LoraManager 模型并批量添加加载器';
    const presetName = el('input', 'mc-preset-name');
    presetName.type = 'text';
    presetName.placeholder = '预设名';
    const savePresetBtn = el('button', 'mc-preset-btn');
    savePresetBtn.textContent = '保存';
    savePresetBtn.title = '保存为预设';
    const presetSel = el('select', 'mc-preset-sel');
    const delPresetBtn = el('button', 'mc-preset-btn');
    delPresetBtn.textContent = '删除';
    delPresetBtn.title = '删除所选预设';

    bar.appendChild(addSel);
    bar.appendChild(browseBtn);
    bar.appendChild(presetName);
    bar.appendChild(savePresetBtn);
    bar.appendChild(presetSel);
    bar.appendChild(delPresetBtn);
    refreshPresetSel(presetSel);

    const list = el('div', 'mc-list');
    const main = el('div', 'mc-main');
    main.appendChild(bar);
    main.appendChild(list);
    root.appendChild(main);

    addSel.addEventListener('change', () => {
      if (!addSel.value) return;
      addLoader(node, addSel.value);
      addSel.value = '';
    });
    browseBtn.addEventListener('click', () => openLoraBrowser(node));
    savePresetBtn.addEventListener('click', () => savePreset(node, presetSel, presetName.value));
    // 选中即生效（同 FreeLatent）：下拉选到某个预设立即应用；选到占位则清空内部
    presetSel.addEventListener('change', () => {
      if (!presetSel.value) { node._ezCurPreset = ''; stateFor(node).loaders = []; syncToConfig(node); render(node); return; }
      loadPreset(node, presetSel, presetSel.value);
    });
    delPresetBtn.addEventListener('click', () => deletePreset(node, presetSel));

    return shell;
  }

  function rowEls(node, loader, idx) {
    const st = stateFor(node);
    const row = el('div', 'mc-row');

    const idxSpan = el('span', 'mc-idx');
    idxSpan.textContent = String(idx + 1);

    const typeSel = el('select', 'mc-type');
    TYPE_ORDER.forEach((t) => {
      const o = el('option', null, { value: t });
      o.textContent = LABEL[t];
      if (t === loader.type) o.selected = true;
      typeSel.appendChild(o);
    });

    const nameIn = el('input', 'mc-name');
    nameIn.type = 'text';
    nameIn.value = loader.name;
    nameIn.placeholder = '名称';

    const fileCombo = fileComboEl(node, loader, st.files[loader.type] || []);

    const delBtn = el('button', 'mc-del');
    delBtn.textContent = '✕';
    delBtn.title = '删除';

    row.appendChild(idxSpan);
    row.appendChild(typeSel);
    row.appendChild(nameIn);
    row.appendChild(fileCombo);

    (EXTRA[loader.type] || []).forEach((f) => {
      const grp = el('div', 'mc-param');
      const lab = el('label', 'mc-plabel');
      lab.textContent = f.label;
      grp.appendChild(lab);

      let ctl;
      if (f.type === 'range') {
        const wrap = el('div', 'mc-range-wrap');
        const range = el('input', 'mc-range');
        range.type = 'range';
        range.min = String(f.min); range.max = String(f.max); range.step = String(f.step);
        range.value = String(loader.extra[f.key] != null ? loader.extra[f.key] : f.def);
        const num = el('input', 'mc-range-num');
        num.type = 'number';
        num.min = String(f.min); num.max = String(f.max); num.step = String(f.step);
        num.value = Number(loader.extra[f.key] != null ? loader.extra[f.key] : f.def).toFixed(1);
        range.addEventListener('input', () => { num.value = Number(range.value).toFixed(1); setExtra(node, loader, f.key, parseFloat(range.value)); });
        num.addEventListener('input', () => { if (!isNaN(parseFloat(num.value))) { const v = parseFloat(num.value); range.value = v; setExtra(node, loader, f.key, v); } });
        wrap.appendChild(range); wrap.appendChild(num);
        ctl = wrap;
      } else {
        ctl = el('select');
        ((f.opts) || []).forEach((o) => {
          const op = el('option', null, { value: o });
          op.textContent = o;
          if (o === (loader.extra[f.key] != null ? loader.extra[f.key] : (f.opts[0]))) op.selected = true;
          ctl.appendChild(op);
        });
        ctl.addEventListener('change', () => setExtra(node, loader, f.key, ctl.value));
      }
      grp.appendChild(ctl);
      row.appendChild(grp);
    });

    if (loader.type === 'lora') {
      const tgt = el('select', 'mc-target');
      const mains = st.loaders.filter((l) => isMainType(l.type));
      const d = el('option', null, { value: '' });
      d.textContent = 'default';
      if (!loader.targetId) d.selected = true;
      tgt.appendChild(d);
      mains.forEach((m) => {
        const o = el('option', null, { value: String(typeof m.id === 'number' ? m.id : '') });
        o.textContent = mainDisplayName(m);
        if (m.id === loader.targetId) o.selected = true;
        tgt.appendChild(o);
      });
      tgt.addEventListener('change', () => {
        loader.targetId = tgt.value ? parseInt(tgt.value, 10) : null;
        syncToConfig(node);
      });
      row.appendChild(tgt);
    }

    // 拖动排序（#3）：用把手拖动行
    const grip = el('div', 'mc-grip');
    grip.title = '拖动排序';
    row.appendChild(grip);
    row.appendChild(delBtn);
    makeRowDraggable(node, row, loader);

    // 悬停显示预览图（模型文件夹内同名图片）
    row.addEventListener('mouseenter', (e) => showPreview(e, loader));
    row.addEventListener('mouseleave', hidePreview);

    typeSel.addEventListener('change', () => {
      const oldType = loader.type;
      loader.type = typeSel.value;
      loader.extra = defaultExtra(loader.type);
      const files = st.files[loader.type] || [];
      loader.file = files.length ? files[0] : '';
      if (oldType === 'lora' || loader.type === 'lora') loader.targetId = null;
      enforceOrder(node);
      syncToConfig(node);
      render(node);
    });
    nameIn.addEventListener('input', () => { loader.name = nameIn.value; syncToConfig(node); updatePorts(node, true); refreshLoraTargets(node); if (node.graph) node.graph.setDirtyCanvas(true, true); });
    delBtn.addEventListener('click', () => {
      st.loaders = st.loaders.filter((l) => l !== loader);
      enforceOrder(node);
      syncToConfig(node);
      render(node);
    });

    return row;
  }

  function setExtra(node, loader, key, value) {
    loader.extra[key] = value;
    syncToConfig(node);
  }

  function enforceOrder(node) {
    const st = stateFor(node);
    const mains = st.loaders.filter((l) => isMainType(l.type));
    const loras = st.loaders.filter((l) => l.type === 'lora');
    st.loaders = [...mains, ...loras];
  }

  // ===== 拖动排序（#3）：只上下调整，克隆体平滑跟随，插入线指示落点 =====
  let _drag = null;
  let _dropLine = null;
  function dropLine() {
    if (!_dropLine || !_dropLine.parentNode) {
      _dropLine = el('div', 'mc-drop-line');
      document.body.appendChild(_dropLine);
    }
    return _dropLine;
  }
  function makeRowDraggable(node, row, loader) {
    const grip = row.querySelector('.mc-grip');
    if (!grip) return;
    grip.addEventListener('mousedown', (e) => startDragRow(node, e, row, loader));
  }
  function startDragRow(node, e, row, loader) {
    e.preventDefault();
    const listEl = row.parentNode;
    const rect = row.getBoundingClientRect();
    const clone = row.cloneNode(true);
    clone.style.position = 'fixed';
    clone.style.pointerEvents = 'none';
    clone.style.width = rect.width + 'px';
    clone.style.opacity = '0.9';
    clone.style.zIndex = '9999';
    clone.style.top = rect.top + 'px';
    clone.style.left = rect.left + 'px';
    clone.style.willChange = 'top';
    clone.style.background = '#fff';
    clone.style.boxShadow = '0 10px 28px rgba(0,0,0,.16)';
    clone.style.border = '1px solid #64748b';
    document.body.appendChild(clone);

    _drag = { node, loader, row, listEl, clone, moved: false, targetIdx: null, dim: null, listRect: null };
    // 一次性缓存各行的纵向中点/边，避免每帧 getBoundingClientRect(布局抖动)
    _drag.listRect = listEl.getBoundingClientRect();
    _drag.dim = [...listEl.querySelectorAll('.mc-row')].map((el) => {
      const r = el.getBoundingClientRect();
      return { el, top: r.top, bottom: r.bottom, mid: r.top + r.height / 2 };
    });
    listEl.querySelectorAll('.mc-row').forEach((r) => { if (r !== row) r.style.opacity = '0.35'; });
    row.style.opacity = '0.25';

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }
  function onDragMove(e) {
    if (!_drag) return;
    if (_drag._raf) return; // 合并到下一帧，避免每 mousemove 都跑
    _drag._raf = true;
    _drag._ev = e;
    requestAnimationFrame(applyDrag);
  }
  function applyDrag() {
    const d = _drag;
    if (!d) return;
    d._raf = false;
    const e = d._ev;
    d.moved = true;
    // 只纵向移动，横向保持原位（只能上下排序）
    d.clone.style.top = (e.clientY - 14) + 'px';
    const dim = d.dim;
    if (!dim || !dim.length) return;
    let insertIdx = dim.length;
    const my = e.clientY;
    for (let i = 0; i < dim.length; i++) {
      if (my > dim[i].mid) insertIdx = i + 1;
      else { insertIdx = i; break; }
    }
    const st = stateFor(d.node);
    const firstLora = st.loaders.findIndex((l) => l.type === 'lora');
    const isMain = isMainType(d.loader.type);
    if (isMain && firstLora !== -1 && insertIdx > firstLora) insertIdx = firstLora;
    if (!isMain && firstLora !== -1 && insertIdx < firstLora) insertIdx = Math.max(0, firstLora);
    insertIdx = Math.max(0, Math.min(dim.length, insertIdx));
    d.targetIdx = insertIdx;
    // 插入线落点：在目标行上边界或最后一行下边界
    let lineY;
    if (insertIdx < dim.length) lineY = dim[insertIdx].top - 2;
    else lineY = dim[dim.length - 1].bottom + 2;
    const lr = d.listRect;
    const dl = dropLine();
    dl.style.display = 'block';
    dl.style.top = lineY + 'px';
    dl.style.left = (lr.left + 6) + 'px';
    dl.style.width = (lr.width - 12) + 'px';
    // 仅在落点变化时切换高亮，避免每帧改类名
    if (d._lastIdx !== insertIdx) {
      d._lastIdx = insertIdx;
      dim.forEach((x, i) => {
        if (x.el === d.row) return;
        x.el.classList.toggle('mc-drop-target', i === insertIdx || (i === insertIdx - 1 && insertIdx === dim.length));
      });
    }
  }
  function onDragEnd(e) {
    if (!_drag) return;
    const d = _drag;
    if (d.clone.parentNode) d.clone.parentNode.removeChild(d.clone);
    if (_dropLine) { _dropLine.style.display = 'none'; }
    d.listEl.querySelectorAll('.mc-row').forEach((r) => { r.style.opacity = '1'; r.classList.remove('mc-drop-target'); });
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    const st = stateFor(d.node);
    const from = st.loaders.indexOf(d.loader);
    if (d.moved && d.targetIdx != null && from !== -1) {
      let to = d.targetIdx;
      if (to > from) to -= 1;
      const firstLora = st.loaders.findIndex((l) => l.type === 'lora');
      const isMain = isMainType(d.loader.type);
      if (isMain && firstLora !== -1 && to >= firstLora) to = firstLora - 1;
      if (!isMain && firstLora !== -1 && to < firstLora) to = firstLora;
      to = Math.max(0, Math.min(st.loaders.length - 1, to));
      if (to >= 0 && to !== from) {
        const [item] = st.loaders.splice(from, 1);
        st.loaders.splice(to, 0, item);
        syncToConfig(d.node);
        _drag = null; // 先清拖拽态再渲染，否则 showPreview 因 _drag 未清永远不显示预览
        render(d.node);
        return;
      }
    }
    render(d.node);
    _drag = null;
  }

  // ===== 自定义文件下拉：每个选项 hover 都能跟随预览（参考 Better Combos）=====
  let _openList = null;
  let _comboListEl = null;
  let _comboDocBound = false;
  function comboListEl() {
    if (!_comboListEl || !_comboListEl.parentNode) {
      _comboListEl = el('div', 'mc-combo-list');
      _comboListEl.addEventListener('mouseleave', hidePreview);
      document.body.appendChild(_comboListEl);
    }
    return _comboListEl;
  }
  function openCombo(listEl, trigger) {
    const r = trigger.getBoundingClientRect();
    listEl.style.top = (r.bottom + 4) + 'px';
    listEl.style.left = Math.max(4, r.left) + 'px';
    listEl.classList.add('visible');
    _openList = listEl;
  }
  function closeAllCombos() { hidePreview(); if (_openList) _openList.classList.remove('visible'); _openList = null; }
  function bindComboDoc() {
    if (_comboDocBound || typeof document === 'undefined') return;
    _comboDocBound = true;
    document.addEventListener('click', closeAllCombos);
  }
  function fileComboEl(node, loader, files) {
    bindComboDoc();
    const wrap = el('div', 'mc-combo');
    const trigger = el('button', 'mc-combo-trigger');
    const valSpan = el('span', 'mc-combo-value');
    valSpan.textContent = loader.file || '选择模型…';
    const arrow = el('span', 'mc-combo-arrow'); arrow.textContent = '▾';
    trigger.appendChild(valSpan); trigger.appendChild(arrow);
    const populateCombo = (l, optsArr) => {
      l.innerHTML = '';
      const opts = (optsArr && optsArr.length) ? optsArr : ['(无可用文件)'];
      opts.forEach((f) => {
        const opt = el('div', 'mc-combo-option');
        opt.textContent = f;
        if (f === loader.file) opt.classList.add('sel');
        opt.addEventListener('mouseenter', (ev) => showPreview(ev, Object.assign({}, loader, { file: f })));
        opt.addEventListener('click', (ev) => {
          ev.stopPropagation();
          loader.file = f;
          valSpan.textContent = f;
          closeAllCombos();
          syncToConfig(node);
          refreshPreview(loader);
        });
        l.appendChild(opt);
      });
      if (!(optsArr && optsArr.length)) { const empty = el('div', 'mc-combo-empty'); empty.textContent = '暂无文件'; l.appendChild(empty); }
      openCombo(l, trigger);
    };
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const listEl = comboListEl();
      const wasOpen = listEl.classList.contains('visible');
      closeAllCombos();
      if (!wasOpen) {
        // 打开前先刷新该加载器所属文件夹的文件列表（无后台轮询，性能最优）
        refreshFolderFor(node, loader.type).then(() => {
          const st = stateFor(node);
          populateCombo(listEl, (st.files && st.files[loader.type]) || files);
        });
      }
    });
    wrap.appendChild(trigger);
    return wrap;
  }

  const MAX_PER_TYPE = 32; // 与 Python 端 MAX_PORTS_PER_TYPE 保持一致

  // 每种加载器对 model/clip/vae 输出口的贡献（lora 不占输出口）
  function typeContrib(type) {
    if (type === 'checkpoint') return { model: 1, clip: 1, vae: 1 };
    if (type === 'unet') return { model: 1 };
    if (type === 'clip') return { clip: 1 };
    if (type === 'vae') return { vae: 1 };
    return { model: 0, clip: 0, vae: 0 };
  }

  function addLoader(node, type) {
    const st = stateFor(node);
    const files = st.files[type] || [];
    // 超出单类输出上限则提示并拒绝添加
    const c = portCounts(st.loaders);
    const add = typeContrib(type);
    if (c.models + add.model > MAX_PER_TYPE || c.clips + add.clip > MAX_PER_TYPE || c.vaes + add.vae > MAX_PER_TYPE) {
      showWarn(node, `超出上限：每种输出最多 ${MAX_PER_TYPE} 个，请拆分配置。`);
      return;
    }
    let id = 1;
    st.loaders.forEach((l) => { if (typeof l.id === 'number' && l.id >= id) id = l.id + 1; });
    const loader = {
      id,
      type,
      name: (LABEL[type] || type) + '_' + st.loaders.filter((l) => l.type === type).length,
      file: files.length ? files[0] : '',
      extra: defaultExtra(type),
      targetId: null
    };
    const ml = st.loaders.find((l) => isMainType(l.type));
    if (type === 'lora' && ml) loader.targetId = ml.id;
    st.loaders.push(loader);
    enforceOrder(node);
    syncToConfig(node);
    render(node);
  }

  function changeType(node, idx, type) {
    const st = stateFor(node);
    const l = st.loaders[idx];
    if (!l || l.type === type) return;
    const tmp = st.loaders.map((x, i) => (i === idx ? Object.assign({}, x, { type }) : x));
    const c = portCounts(tmp);
    const add = typeContrib(type);
    const rm = typeContrib(l.type);
    if (c.models - rm.model + add.model > MAX_PER_TYPE || c.clips - rm.clip + add.clip > MAX_PER_TYPE || c.vaes - rm.vae + add.vae > MAX_PER_TYPE) {
      showWarn(node, `超出上限：每种输出最多 ${MAX_PER_TYPE} 个`);
      return;
    }
    l.type = type;
    l.extra = defaultExtra(type);
    if (type !== 'lora') l.targetId = null;
  }

  function render(node) {
    const st = stateFor(node);
    const root = node._mcRoot;
    if (!root) return;
    const list = root.querySelector('.mc-list');
    if (list) {
      list.innerHTML = '';
      if (!st.loaders.length) {
        const empty = el('div', 'mc-empty');
        empty.textContent = '暂无加载器';
        list.appendChild(empty);
      } else {
        let dividerDone = false;
        st.loaders.forEach((loader, idx) => {
          // 在主模型与 lora 之间插入渐变分隔线
          if (!dividerDone && loader.type === 'lora' && st.loaders.slice(0, idx).some((l) => isMainType(l.type))) {
            const dv = el('div', 'mc-lora-divider');
            const tag = el('span', 'mc-lora-tag');
            tag.textContent = 'LoRA';
            dv.appendChild(tag);
            list.appendChild(dv);
            dividerDone = true;
          }
          list.appendChild(rowEls(node, loader, idx));
        });
      }
    }
    updatePorts(node);
    updateInputs(node);
    // 内容变化（增删加载器）→ 节点高度跟随内容自动缩放
    if (typeof node.__mcPanelH === 'function') {
      try {
        const h = Math.max(140, node.__mcPanelH());
        const w = (node.size && node.size[0]) || 600;
        if (typeof node.setSize === 'function') node.setSize([w, h]);
      } catch (_) { /* 忽略 */ }
    }
    if (node.graph) node.graph.setDirtyCanvas(true, true);
  }

  // 在「添加加载器」栏下方显示一条临时警告（如某种输出口超出 4 个上限）
  function showWarn(node, msg) {
    const root = node._mcRoot;
    if (!root) return;
    let warn = root.querySelector('.mc-warn');
    if (!warn) {
      warn = el('div', 'mc-warn');
      root.insertBefore(warn, root.querySelector('.mc-list'));
    }
    warn.textContent = msg;
    clearTimeout(warn._t);
    warn._t = setTimeout(() => { warn.remove(); }, 3000);
  }

  // ===== 预设（服务端 user_data 文件夹，JSON；readPresets/writePresets 保留给 canvas 旧路径）=====
  const PRESET_KEY = 'modelscombo_presets';
  const PRESET_API = '/models_combo/presets';
  function readPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || []; } catch (_) { return []; } }
  function writePresets(list) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); } catch (_) { /* 忽略 */ } }
  async function refreshPresetSel(sel) {
    if (!sel) return;
    sel.innerHTML = '';
    const d = el('option', null, { value: '' });
    d.textContent = '—预设—';
    sel.appendChild(d);
    let list = [];
    try { const r = await fetch(PRESET_API); list = await r.json(); } catch (_) { list = []; }
    list.forEach((p) => { const o = el('option', null, { value: p.name }); o.textContent = p.name; sel.appendChild(o); });
  }
  async function savePreset(node, sel, name) {
    name = (name || '').trim();
    if (!name) { showWarn(node, '请输入预设名称'); return; }
    if (!stateFor(node).loaders.length) { showWarn(node, '没有加载器可保存'); return; }
    const cur = { name, loaders: JSON.parse(JSON.stringify(stateFor(node).loaders)) };
    try {
      await fetch(PRESET_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cur) });
    } catch (_) { /* 忽略 */ }
    await refreshPresetSel(sel);
    sel.value = name;
    showWarn(node, '已保存预设 ' + name);
  }
  async function loadPreset(node, sel, name) {
    if (!name) { showWarn(node, '请选择预设'); return; }
    let list = [];
    try { const r = await fetch(PRESET_API); list = await r.json(); } catch (_) { list = []; }
    const p = list.find((x) => x.name === name);
    if (!p) { showWarn(node, '预设不存在'); return; }
    node._ezCurPreset = name;
    stateFor(node).loaders = parseLoaders(JSON.stringify(p.loaders));
    let mx = 0;
    stateFor(node).loaders.forEach((l) => { if (typeof l.id === 'number' && l.id > mx) mx = l.id; });
    enforceOrder(node);
    syncToConfig(node);
    render(node);
  }
  async function deletePreset(node, sel) {
    const name = sel && sel.value;
    if (!name) { showWarn(node, '请选择预设'); return; }
    try { await fetch(PRESET_API + '/' + encodeURIComponent(name), { method: 'DELETE' }); } catch (_) { /* 忽略 */ }
    await refreshPresetSel(sel);
    sel.value = '';
    showWarn(node, '已删除预设 ' + name);
  }

  // ===== 浏览弹窗（读取 LoraManager 生成的 metadata.json + 预览图）=====
  let _bbOverlay = null, _bbNode = null, _bbItems = [], _bbTabType = '', _bbQuery = '', _bbSearchField = 'all', _bbEscBound = false;
  let _bbSelFolder = '', _bbRecursive = true, _bbSidebarMode = 'tree', _bbSidebarHidden = false;
  let _bbTree = {}, _bbExpanded = new Set();
  let _bdOverlay = null, _bdItem = null, _bdNode = null;

  const _SVG = {
    folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
    home: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 3l9 8h-3v9h-4v-6H10v6H6v-9H3z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 6l6 6-6 6z"/></svg>',
    chevLeft: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg>',
    chevRight: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6"/></svg>',
    tree: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="3" width="6" height="4" rx="1"/><rect x="15" y="3" width="6" height="4" rx="1"/><rect x="9" y="17" width="6" height="4" rx="1"/><path d="M6 7v4a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7M12 13v4"/></svg>',
    branch: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="6" cy="4" r="2.2"/><circle cx="6" cy="20" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 6.2v11.6M6 15c0-3.2 3-3.4 5-3.9s4-1 4-3.4"/></svg>',
    compress: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v6M12 3l-2.5 2.5M12 3l2.5 2.5M12 21v-6M12 21l-2.5-2.5M12 21l2.5-2.5"/></svg>'
  };

  const _BB_ABBR = {
    anima: 'ANI', illustrious: 'IL', sdxl: 'XL', 'sdxl 1.0': 'XL', 'sdxl lightning': 'XL', 'sdxl hyper': 'XL',
    noobai: 'NAI', 'noobai xl': 'NAI', 'sd 1.4': 'SD1', 'sd 1.5': 'SD1', 'sd 1.5 lcm': 'SD1', 'sd 1.5 hyper': 'SD1',
    'sd 2.0': 'SD2', 'sd 2.1': 'SD2', 'sd 3': 'SD3', 'sd 3.5': 'SD3', 'flux.1 d': 'F1D', 'flux.1 s': 'F1S',
    'flux.1 krea': 'F1KR', 'flux.1 kontext': 'F1KX', 'flux.2 d': 'F2D', 'flux2': 'F2D', 'pony': 'PONY', 'pony v7': 'PNY7',
    hidream: 'HID', 'hidream-o1': 'HIO1', qwen: 'QWEN', 'qwen 2': 'QWN2', lumina: 'L', kolors: 'KLR', 'hunyuan 1': 'HY',
    'pixart a': 'PXA', 'pixart e': 'PXE', auraflow: 'AF', chroma: 'CHR', 'wan video': 'WAN', ltxv: 'LTXV',
    ltxv2: 'LTV2', mochi: 'MCHI', cogvideox: 'CVX', svd: 'SVD', 'hunyuan video': 'HYV', 'krea 2': 'KR2',
    lens: 'LENS', mai: 'MAI', boogu: 'BOOG', ernie: 'ERNI', 'ideogram 4.0': 'ID40', grok: 'GROK',
    happyhorse: 'HAPP', 'zimage turbo': 'ZIT', zimage: 'ZIB', upscaler: 'UPSC'
  };

  function _baseAbbr(base) {
    if (!base) return '';
    const key = String(base).trim().toLowerCase();
    if (_BB_ABBR[key]) return _BB_ABBR[key];
    for (const [k, v] of Object.entries(_BB_ABBR)) { if (key.includes(k)) return v; }
    const tokens = key.split(/[\s_-]+/).filter(Boolean);
    const init = tokens.map((t) => t[0]).join('').toUpperCase().slice(0, 4);
    if (init.length >= 2) return init;
    const alnum = key.replace(/[^a-z0-9]/g, '');
    return (alnum || 'XXX').slice(0, 4).toUpperCase();
  }

  function _expandAllFolders() {
    const items = _bbTabType ? _bbItems.filter((x) => x.type === _bbTabType) : _bbItems;
    items.forEach((x) => {
      const parts = _itemDir(x).split('/').filter(Boolean);
      let acc = '';
      parts.forEach((p) => { acc = acc ? acc + '/' + p : p; _bbExpanded.add(acc); });
    });
  }

  function removeLoaderFromMeta(node, type, file) {
    if (!node) return;
    const st = stateFor(node);
    const before = st.loaders.length;
    st.loaders = st.loaders.filter((l) => !(l.type === type && l.file === file));
    if (st.loaders.length === before) return;
    enforceOrder(node);
    syncToConfig(node);
    render(node);
    if (_bbOverlay) renderLoraBrowserGrid();
  }

  function toggleLoaderFromMeta(node, item) {
    if (!node || !item) return;
    if (_isLoaded(node, item.type, item.file)) removeLoaderFromMeta(node, item.type, item.file);
    else addLoaderFromMeta(node, item);
  }

  function _fmtBytes(n) {
    try {
      n = Number(n);
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
      return (n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
    } catch (_) { return ''; }
  }

  function _fmtMtime(t) {
    try { return new Date(Number(t) * 1000).toLocaleString(); } catch (_) { return ''; }
  }

  function _metaPreviewUrl(item) {
    const qs = 'type=' + encodeURIComponent(item.type) + '&file=' + encodeURIComponent(item.file);
    return (api && typeof api.apiURL === 'function')
      ? api.apiURL('/models_combo/preview?' + qs)
      : ('/models_combo/preview?' + qs);
  }

  function _metaRemoteThumb(item) {
    const c = item.civitai;
    if (c && Array.isArray(c.images)) {
      for (const im of c.images) { if (im && im.url) return im.url; }
    }
    return '';
  }

  // 同时尝试 <img> 与 <video>：图片资源走 img，视频资源（mp4/webm…）走 video 首帧，
  // 两者都失败时触发 noPreview 回调（用于远程封面兜底 / “无预览”占位）。
  function _attachMedia(container, url, imgClass, alt, noPreview) {
    const img = document.createElement('img');
    if (imgClass) img.className = imgClass;
    img.alt = alt || '';
    img.loading = 'lazy';
    const video = document.createElement('video');
    video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'metadata';
    if (imgClass) video.className = imgClass;
    video.style.display = 'none';
    let imgFailed = false, videoFailed = false, shown = false, remoteTried = false;
    const maybeFallback = () => { if (!shown && !remoteTried && imgFailed && videoFailed) { remoteTried = true; if (noPreview) noPreview({ img, video }); } };
    img.onload = () => { if (!shown) { shown = true; video.pause(); video.style.display = 'none'; img.style.display = 'block'; } };
    img.onerror = () => { imgFailed = true; img.style.display = 'none'; maybeFallback(); };
    video.onloadeddata = () => { if (!shown) { shown = true; img.style.display = 'none'; video.style.display = 'block'; try { video.play().catch(() => { }); } catch (_) { } } };
    video.onerror = () => { videoFailed = true; video.style.display = 'none'; maybeFallback(); };
    container.appendChild(img); container.appendChild(video);
    img.src = url;
    video.src = url + '#t=0.01';
    return { img, video };
  }

  function _isLoaded(node, type, file) {
    if (!node) return false;
    return stateFor(node).loaders.some((l) => l.type === type && l.file === file);
  }

  function _uniqueLoaderName(node, type, base) {
    const st = stateFor(node);
    const seed = (base || '').trim() || (LABEL[type] || type);
    let name = seed, n = 2;
    while (st.loaders.some((l) => l.type === type && l.name === name)) { name = seed + ' ' + n; n += 1; }
    return name;
  }

  function addLoaderFromMeta(node, item) {
    if (!node) return;
    const st = stateFor(node), type = item.type;
    if (_isLoaded(node, type, item.file)) return;
    const c = portCounts(st.loaders), add = typeContrib(type);
    if (c.models + add.model > MAX_PER_TYPE || c.clips + add.clip > MAX_PER_TYPE || c.vaes + add.vae > MAX_PER_TYPE) {
      showWarn(node, '超出上限：每种输出最多 ' + MAX_PER_TYPE + ' 个，请拆分配置。');
      return;
    }
    let id = 1;
    st.loaders.forEach((l) => { if (typeof l.id === 'number' && l.id >= id) id = l.id + 1; });
    const loader = {
      id,
      type,
      name: _uniqueLoaderName(node, type, item.model_name || item.file_name || item.file),
      file: item.file,
      extra: defaultExtra(type),
      targetId: null
    };
    if (type === 'lora') {
      const ml = st.loaders.find((l) => isMainType(l.type));
      if (ml) loader.targetId = ml.id;
    }
    st.loaders.push(loader);
    enforceOrder(node);
    syncToConfig(node);
    render(node);
    if (_bbOverlay) renderLoraBrowserGrid();
  }

  function browserEl() {
    if (_bbOverlay && _bbOverlay.parentNode) return _bbOverlay;
    const ov = el('div', 'mc-bb-overlay');
    const header = el('div', 'mc-bb-header');
    const title = el('div', 'mc-bb-title'); title.textContent = '模型浏览器';
    const badge = el('div', 'mc-bb-badge'); badge.textContent = 'LoraManager';
    const search = el('input', 'mc-bb-search'); search.type = 'text'; search.placeholder = '搜索名称 / 标签…';
    const searchField = el('select', 'mc-bb-searchfield');
    [['all','全部字段'],['title','标题/名称'],['author','作者'],['category','模型类别'],['base','基础模型'],['tags','标签'],['trained','触发词'],['desc','描述'],['version','版本'],['file','文件名/路径']].forEach(([v,label]) => {
      const o = el('option', null, { value: v });
      o.textContent = label;
      searchField.appendChild(o);
    });
    searchField.value = 'all';
    const count = el('div', 'mc-bb-count'); count.textContent = '0';
    const close = el('button', 'mc-bb-close'); close.textContent = '✕'; close.title = '关闭'; close.setAttribute('aria-label', '关闭');
    header.appendChild(title); header.appendChild(badge); header.appendChild(search); header.appendChild(searchField); header.appendChild(count); header.appendChild(close);
    const tabs = el('div', 'mc-bb-tabs');
    const body = el('div', 'mc-bb-body');
    const side = el('div', 'mc-bb-side');
    const sidehead = el('div', 'mc-bb-sidehead');
    const sideTitle = el('div', 'mc-bb-side-title'); sideTitle.textContent = '文件夹';
    const sidebtns = el('div', 'mc-bb-sidebtns');
    const b1 = el('button', 'mc-bb-sbtn'); b1.innerHTML = _SVG.tree; b1.title = '树/列表切换';
    const b2 = el('button', 'mc-bb-sbtn'); b2.innerHTML = _SVG.branch; b2.title = '递归（含子文件夹）';
    b2.classList.add('active');
    const b3 = el('button', 'mc-bb-sbtn'); b3.innerHTML = _SVG.compress; b3.title = '全部折叠';
    const b4 = el('button', 'mc-bb-sbtn mc-bb-sbtn-hide'); b4.innerHTML = _SVG.chevLeft; b4.title = '隐藏侧栏';
    sidebtns.appendChild(b1); sidebtns.appendChild(b2); sidebtns.appendChild(b3); sidebtns.appendChild(b4);
    sidehead.appendChild(sideTitle); sidehead.appendChild(sidebtns);
    const tree = el('div', 'mc-bb-tree');
    side.appendChild(sidehead); side.appendChild(tree);
    const main = el('div', 'mc-bb-main');
    const grid = el('div', 'mc-bb-grid');
    main.appendChild(grid);
    body.appendChild(side); body.appendChild(main);
    ov.appendChild(header); ov.appendChild(tabs); ov.appendChild(body);
    document.body.appendChild(ov);
    close.addEventListener('click', closeLoraBrowser);
    search.addEventListener('input', () => { _bbQuery = search.value.toLowerCase(); renderLoraBrowserGrid(); });
    searchField.addEventListener('change', () => { _bbSearchField = searchField.value; renderLoraBrowserGrid(); });
    b1.addEventListener('click', () => { _bbSidebarMode = _bbSidebarMode === 'tree' ? 'list' : 'tree'; b1.classList.toggle('active', _bbSidebarMode === 'list'); renderFolderSidebar(); });
    b2.addEventListener('click', () => { _bbRecursive = !_bbRecursive; b2.classList.toggle('active', _bbRecursive); if (_bbRecursive) _expandAllFolders(); renderLoraBrowserGrid(); });
    b3.addEventListener('click', () => { _bbExpanded.clear(); renderFolderSidebar(); });
    b4.addEventListener('click', () => toggleSidebarHidden());
    _bbOverlay = ov;
    _bbOverlay._grid = grid; _bbOverlay._count = count; _bbOverlay._search = search; _bbOverlay._searchField = searchField;
    _bbOverlay._tabs = tabs; _bbOverlay._side = side; _bbOverlay._tree = tree; _bbOverlay._main = main;
    return _bbOverlay;
  }

  function renderTabs() {
    const tabs = _bbOverlay._tabs; tabs.innerHTML = '';
    const defs = [['', '全部'], ['checkpoint', 'Checkpoint'], ['unet', 'UNET'], ['lora', 'LoRA']];
    defs.forEach(([v, label]) => {
      const b = el('button', 'mc-bb-tab' + (v === _bbTabType ? ' active' : ''));
      b.textContent = label;
      b.addEventListener('click', () => { _bbTabType = v; _bbSelFolder = ''; tabs.querySelectorAll('.mc-bb-tab').forEach((x) => x.classList.toggle('active', x === b)); renderLoraBrowserGrid(); });
      tabs.appendChild(b);
    });
  }

  function toggleSidebarHidden() {
    _bbSidebarHidden = !_bbSidebarHidden;
    if (!_bbOverlay) return;
    _bbOverlay._side.classList.toggle('collapsed', _bbSidebarHidden);
    const b4 = _bbOverlay._side.querySelector('.mc-bb-sbtn-hide');
    if (b4) {
      b4.innerHTML = _bbSidebarHidden ? _SVG.chevRight : _SVG.chevLeft;
      b4.title = _bbSidebarHidden ? '展开侧栏' : '隐藏侧栏';
    }
    renderFolderSidebar();
  }

  function openLoraBrowser(node) {
    const ov = browserEl();
    _bbNode = node;
    _bbQuery = ''; _bbTabType = ''; _bbSelFolder = ''; _bbExpanded.clear(); _bbSearchField = 'all';
    ov._search.value = '';
    if (ov._searchField) ov._searchField.value = 'all';
    ov._side.classList.remove('collapsed'); _bbSidebarHidden = false;
    const b4 = ov._side.querySelector('.mc-bb-sbtn-hide');
    if (b4) { b4.innerHTML = _SVG.chevLeft; b4.title = '隐藏侧栏'; }
    ov.classList.add('open');
    renderTabs();
    loadLoraMetaIntoBrowser(ov);
    if (!_bbEscBound) {
      _bbEscBound = true;
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (_bdOverlay && _bdOverlay.classList.contains('open')) { closeLoraDetail(); }
        else if (_bbOverlay && _bbOverlay.classList.contains('open')) { closeLoraBrowser(); }
      });
    }
  }

  function closeLoraBrowser() {
    if (_bbOverlay) {
      _bbOverlay.classList.remove('open');
      _bbOverlay._side.classList.remove('collapsed');
      _bbSidebarHidden = false;
      const b4 = _bbOverlay._side.querySelector('.mc-bb-sbtn-hide');
      if (b4) { b4.innerHTML = _SVG.chevLeft; b4.title = '隐藏侧栏'; }
    }
    closeLoraDetail();
  }

  async function loadLoraMetaIntoBrowser(ov) {
    const grid = ov._grid;
    grid.innerHTML = '';
    const loading = el('div', 'mc-bb-loading'); loading.textContent = '加载中…'; grid.appendChild(loading);
    ov._count.textContent = '';
    try {
      const fetcher = api && typeof api.fetchApi === 'function' ? (p) => api.fetchApi(p) : (p) => fetch(p);
      const r = await fetcher('/models_combo/lora_meta');
      _bbItems = (r && r.ok) ? (await r.json()) : [];
    } catch (_) { _bbItems = []; }
    renderLoraBrowserGrid();
  }

  function _itemDir(item) {
    const f = item.file || '';
    const i = f.lastIndexOf('/');
    return i >= 0 ? f.slice(0, i) : '';
  }

  function _itemInFolder(item, folder) {
    const d = _itemDir(item);
    if (!folder) return true;
    if (_bbRecursive) return d === folder || d.startsWith(folder + '/');
    return d === folder;
  }

  function renderLoraBrowserGrid() {
    const ov = _bbOverlay;
    if (!ov) return;
    const grid = ov._grid;
    grid.innerHTML = '';
    let items = _bbItems;
    if (_bbTabType) items = items.filter((x) => x.type === _bbTabType);
    if (_bbQuery) {
      const q = (_bbQuery || '').trim().toLowerCase();
      const words = (v) => {
        if (!v) return [];
        const arr = Array.isArray(v) ? v : [v];
        const out = [];
        arr.forEach((w) => {
          if (w == null) return;
          if (Array.isArray(w)) { out.push(...words(w)); return; }
          if (typeof w === 'string') { out.push(w); return; }
          if (typeof w === 'number' || typeof w === 'boolean') { out.push(String(w)); return; }
          if (typeof w === 'object') {
            if (typeof w.name === 'string') out.push(w.name);
            else if (typeof w.tag === 'string') out.push(w.tag);
            else if (typeof w.label === 'string') out.push(w.label);
            else if (typeof w.text === 'string') out.push(w.text);
            else out.push(JSON.stringify(w));
            return;
          }
          out.push(String(w));
        });
        return out;
      };
      const field = _bbSearchField || 'all';
      const pick = (x) => {
        const civ = x.civitai || {};
        switch (field) {
          case 'title': return words([x.model_name, civ.modelName]);
          case 'file': return words([x.file_name, x.file]);
          case 'author': return words([x.author, x.creator, civ.creator]);
          case 'category': return words([(LABEL[x.type] || x.type || ''), civ.modelType]);
          case 'base': return words([x.base_model, civ.baseModel]);
          case 'tags': return words([x.tags, civ.tags]);
          case 'trained': return words(x.trainedWords);
          case 'desc': return words([x.modelDescription, x.description, x.usage_tips, civ.description]);
          case 'version': return words(civ.name);
          default: return words([
            x.model_name, x.file_name, x.file, x.base_model,
            x.author, x.creator, civ.creator,
            x.modelDescription, x.description, x.usage_tips, x.notes,
            x.tags, x.trainedWords,
            civ.tags, civ.name, civ.baseModel, civ.description, civ.modelName, civ.modelType,
            (LABEL[x.type] || x.type || '')
          ]);
        }
      };
      items = items.filter((x) => {
        const blob = pick(x).flat().filter(Boolean).join(' ').toLowerCase();
        return blob.indexOf(q) >= 0;
      });
    }
    if (_bbSelFolder) items = items.filter((x) => _itemInFolder(x, _bbSelFolder));
    ov._count.textContent = items.length + ' 个';
    if (!items.length) {
      const empty = el('div', 'mc-bb-empty');
      empty.textContent = _bbItems.length ? '没有匹配的模型' : '未找到 LoraManager 元数据（请先让 LoraManager 扫描模型）';
      grid.appendChild(empty);
    } else {
      items.forEach((item) => grid.appendChild(buildLoraBrowserCard(item)));
    }
    renderFolderSidebar();
  }

  function _buildTree(items) {
    const root = {};
    items.forEach((item) => {
      const d = _itemDir(item);
      if (!d) return;
      let cur = root, acc = '';
      d.split('/').forEach((p) => {
        acc = acc ? acc + '/' + p : p;
        if (!cur[p]) cur[p] = {};
        cur = cur[p];
      });
    });
    return root;
  }

  function renderTreeNode(node, base) {
    return Object.keys(node).sort((a, b) => a.localeCompare(b, 'zh')).map((name) => {
      const path = base ? base + '/' + name : name;
      const kids = node[name];
      const has = Object.keys(kids).length > 0;
      const expanded = _bbExpanded.has(path);
      const div = el('div', 'mc-bb-tnode');
      const row = el('div', 'mc-bb-trow' + (_bbSelFolder === path ? ' sel' : ''));
      const twist = el('div', 'mc-bb-twist' + (expanded ? ' expanded' : '') + (has ? '' : ' leaf'));
      twist.innerHTML = _SVG.chevron;
      const icon = el('span', 'mc-bb-ficon'); icon.innerHTML = _SVG.folder;
      const nameEl = el('div', 'mc-bb-fname'); nameEl.textContent = name;
      row.appendChild(twist); row.appendChild(icon); row.appendChild(nameEl);
      row.addEventListener('click', () => {
        if (has) { if (_bbExpanded.has(path)) _bbExpanded.delete(path); else _bbExpanded.add(path); }
        _bbSelFolder = path;
        renderLoraBrowserGrid();
      });
      div.appendChild(row);
      if (has) {
        const kidsEl = el('div', 'mc-bb-tkids' + (expanded ? ' expanded' : ''));
        renderTreeNode(kids, path).forEach((k) => kidsEl.appendChild(k));
        div.appendChild(kidsEl);
      }
      return div;
    });
  }

  function _topFolders(items) {
    const s = new Set();
    items.forEach((x) => { const d = _itemDir(x); if (d) s.add(d.split('/')[0]); });
    return [...s].sort((a, b) => a.localeCompare(b, 'zh'));
  }

  function renderFolderSidebar() {
    const ov = _bbOverlay;
    if (!ov) return;
    const tree = ov._tree;
    tree.innerHTML = '';
    if (_bbSidebarHidden) return;
    const items = _bbTabType ? _bbItems.filter((x) => x.type === _bbTabType) : _bbItems;
    const rootRow = el('div', 'mc-bb-trow' + (!_bbSelFolder ? ' sel' : ''));
    const twist = el('div', 'mc-bb-twist leaf');
    const icon = el('span', 'mc-bb-ficon'); icon.innerHTML = _SVG.home;
    const nameEl = el('div', 'mc-bb-fname'); nameEl.textContent = '全部模型';
    rootRow.appendChild(twist); rootRow.appendChild(icon); rootRow.appendChild(nameEl);
    rootRow.addEventListener('click', () => { _bbSelFolder = ''; renderLoraBrowserGrid(); });
    tree.appendChild(rootRow);
    if (_bbSidebarMode === 'list') {
      const list = el('div', 'mc-bb-listmode');
      _topFolders(items).forEach((p) => {
        const row = el('div', 'mc-bb-listrow' + (p === _bbSelFolder ? ' sel' : ''));
        row.textContent = p;
        row.addEventListener('click', () => { _bbSelFolder = p; renderLoraBrowserGrid(); });
        list.appendChild(row);
      });
      tree.appendChild(list);
    } else {
      _bbTree = _buildTree(items);
      renderTreeNode(_bbTree, '').forEach((n) => tree.appendChild(n));
    }
  }

  function buildLoraBrowserCard(item) {
    const card = el('div', 'mc-b-card');
    const thumb = el('div', 'mc-b-thumb');
    _attachMedia(thumb, _metaPreviewUrl(item), '', item.model_name || item.file_name || '', ({ img }) => {
      const remote = _metaRemoteThumb(item);
      if (remote) { img.onerror = null; img.src = remote; }
      else if (!thumb.querySelector('.mc-b-noph')) {
        const ph = el('div', 'mc-b-noph'); ph.textContent = '无预览'; thumb.appendChild(ph);
      }
    });
    const typeBadge = el('div', 'mc-b-type ' + (item.type || ''));
    const abbr = _baseAbbr(item.base_model);
    typeBadge.textContent = (LABEL[item.type] || item.type || '') + (abbr ? ' ' + abbr : '');
    thumb.appendChild(typeBadge);
    const addBtn = el('button', 'mc-b-add');
    const refreshAdd = () => {
      const added = _isLoaded(_bbNode, item.type, item.file);
      addBtn.textContent = added ? '−' : '+';
      addBtn.classList.toggle('added', added);
      addBtn.title = added ? '移除加载器' : '添加为加载器';
    };
    refreshAdd();
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleLoaderFromMeta(_bbNode, item); refreshAdd(); });
    thumb.appendChild(addBtn);
    const info = el('div', 'mc-b-info');
    const name = el('div', 'mc-b-name');
    name.textContent = item.model_name || item.file_name || item.file || '';
    name.title = name.textContent;
    info.appendChild(name);
    const ver = item.civitai && item.civitai.name;
    if (ver) { const v = el('div', 'mc-b-version'); v.textContent = ver; info.appendChild(v); }
    thumb.appendChild(info);
    card.appendChild(thumb);
    card.addEventListener('click', () => openLoraDetail(item));
    return card;
  }

  function detailEl() {
    if (_bdOverlay && _bdOverlay.parentNode) return _bdOverlay;
    const ov = el('div', 'mc-bd-overlay');
    const box = el('div', 'mc-bd-box');
    const head = el('div', 'mc-bd-head');
    const title = el('div', 'mc-bd-title');
    const type = el('div', 'mc-bd-type');
    const add = el('button', 'mc-bd-add'); add.textContent = '＋ 添加到组合';
    const close = el('button', 'mc-bd-close'); close.textContent = '✕';
    head.appendChild(title); head.appendChild(type); head.appendChild(add); head.appendChild(close);
    const body = el('div', 'mc-bd-body');
    box.appendChild(head); box.appendChild(body);
    ov.appendChild(box);
    document.body.appendChild(ov);
    add.addEventListener('click', () => {
      toggleLoaderFromMeta(_bdNode, _bdItem);
      const added = _isLoaded(_bdNode, _bdItem.type, _bdItem.file);
      add.textContent = added ? '− 移除' : '＋ 添加到组合';
      add.classList.toggle('added', added);
    });
    close.addEventListener('click', closeLoraDetail);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeLoraDetail(); });
    _bdOverlay = ov;
    _bdOverlay._title = title; _bdOverlay._type = type; _bdOverlay._body = body; _bdOverlay._add = add;
    return _bdOverlay;
  }

  function openLoraDetail(item) {
    _bdItem = item;
    _bdNode = _bbNode;
    const ov = detailEl();
    ov.classList.add('open');
    renderLoraDetail(ov, item);
  }

  function closeLoraDetail() {
    if (_bdOverlay) _bdOverlay.classList.remove('open');
  }

  function _bdField(container, label, value) {
    if (value === undefined || value === null || value === '') return;
    const f = el('div', 'mc-bd-field');
    const k = el('div', 'mc-bd-fk'); k.textContent = label;
    const v = el('div', 'mc-bd-fv'); v.textContent = String(value);
    f.appendChild(k); f.appendChild(v);
    container.appendChild(f);
  }

  async function renderLoraDetail(ov, item) {
    const body = ov._body;
    body.innerHTML = '';
    ov._title.textContent = item.model_name || item.file_name || item.file || '';
    ov._type.textContent = LABEL[item.type] || item.type || '';
    const has = _isLoaded(_bbNode, item.type, item.file);
    ov._add.textContent = has ? '− 移除' : '＋ 添加到组合';
    ov._add.classList.toggle('added', has);
    let meta = item;
    try {
      const qs = 'type=' + encodeURIComponent(item.type) + '&file=' + encodeURIComponent(item.file);
      const fetcher = api && typeof api.fetchApi === 'function' ? (p) => api.fetchApi(p) : (p) => fetch(p);
      const r = await fetcher('/models_combo/lora_meta_detail?' + qs);
      if (r && r.ok) { const d = await r.json(); if (d && typeof d === 'object') meta = d; }
    } catch (_) { /* 忽略 */ }
    const civ = meta.civitai || {};
    _attachMedia(body, _metaPreviewUrl(item), 'mc-bd-img', '预览', ({ img }) => {
      const remote = _metaRemoteThumb(item);
      if (remote) { img.onerror = null; img.src = remote; }
      else { img.style.display = 'none'; }
    });
    const grid = el('div', 'mc-bd-grid');
    _bdField(grid, '版本', civ.name);
    if (meta.file_name) _bdField(grid, '文件名', meta.file_name + (item.file ? '.' + item.file.split('.').pop() : ''));
    _bdField(grid, '基础模型', meta.base_model || civ.baseModel);
    _bdField(grid, '大小', _fmtBytes(meta.size));
    _bdField(grid, '修改时间', _fmtMtime(meta.modified));
    _bdField(grid, 'SHA256', meta.sha256 ? (String(meta.sha256).slice(0, 16) + '…') : '');
    const locParts = (meta.file_path || '').split(/[\\/]/).slice(0, -1).join('/');
    _bdField(grid, '位置', locParts || (item.file ? item.file.split('/').slice(0, -1).join('/') || '/' : ''));
    body.appendChild(grid);
    // 触发词
    const trained = (meta.trainedWords && meta.trainedWords.length) ? meta.trainedWords : (civ.trainedWords || []);
    if (trained && trained.length) {
      const sec = el('div', 'mc-bd-sec');
      const st = el('div', 'mc-bd-sec-title'); st.textContent = '触发词';
      sec.appendChild(st);
      const txt = el('div', 'mc-bd-text'); txt.textContent = trained.join(', ');
      sec.appendChild(txt); body.appendChild(sec);
    }
    // 使用提示
    let tipsHtml = '';
    try {
      const parsed = JSON.parse(meta.usage_tips || '{}');
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length) {
        tipsHtml = Object.keys(parsed).map((k) => k + ': ' + parsed[k]).join('\n');
      }
    } catch (_) { /* 忽略 */ }
    if (!tipsHtml && meta.usage_tips && meta.usage_tips !== '{}') tipsHtml = meta.usage_tips;
    if (tipsHtml) {
      const sec = el('div', 'mc-bd-sec');
      const st = el('div', 'mc-bd-sec-title'); st.textContent = '使用提示';
      sec.appendChild(st);
      const txt = el('div', 'mc-bd-text'); txt.textContent = tipsHtml;
      sec.appendChild(txt); body.appendChild(sec);
    }
    // 附加备注
    if (meta.notes) {
      const sec = el('div', 'mc-bd-sec');
      const st = el('div', 'mc-bd-sec-title'); st.textContent = '附加备注';
      sec.appendChild(st);
      const txt = el('div', 'mc-bd-text'); txt.textContent = meta.notes;
      sec.appendChild(txt); body.appendChild(sec);
    }
    // 关于此版本 / 模型描述（Civitai description 是 HTML，原样渲染，与 LoraManager 一致）
    const descHtml = meta.modelDescription || civ.description || (civ.model && civ.model.description) || '';
    if (descHtml) {
      const sec = el('div', 'mc-bd-sec');
      const st = el('div', 'mc-bd-sec-title'); st.textContent = '关于此版本';
      sec.appendChild(st);
      const txt = el('div', 'mc-bd-desc'); txt.innerHTML = descHtml;
      sec.appendChild(txt); body.appendChild(sec);
    }
    // 标签
    const tags = (meta.tags || []).concat(civ.tags || []).concat((civ.model && civ.model.tags) || []);
    if (tags.length) {
      const sec = el('div', 'mc-bd-sec');
      const st = el('div', 'mc-bd-sec-title'); st.textContent = '标签';
      sec.appendChild(st);
      const chips = el('div', 'mc-bd-chips');
      tags.forEach((t) => { const c = el('div', 'mc-bd-chip'); c.textContent = t; chips.appendChild(c); });
      sec.appendChild(chips); body.appendChild(sec);
    }
    // Civitai 链接 / 作者 / 统计
    if (civ.modelId || civ.id || civ.creator || civ.stats) {
      const sec = el('div', 'mc-bd-sec');
      const st = el('div', 'mc-bd-sec-title'); st.textContent = '来源';
      sec.appendChild(st);
      const link = el('a', 'mc-bd-link');
      link.target = '_blank'; link.rel = 'noopener';
      link.textContent = civ.modelId ? ('civitai.com/models/' + civ.modelId + (civ.id ? '?modelVersionId=' + civ.id : '')) : (civ.downloadUrl || '');
      link.href = civ.modelId ? ('https://civitai.com/models/' + civ.modelId + (civ.id ? '?modelVersionId=' + civ.id : '')) : (civ.downloadUrl || '#');
      sec.appendChild(link);
      if (civ.creator) { const c = el('div', 'mc-bd-text'); c.textContent = '作者: ' + civ.creator; sec.appendChild(c); }
      if (civ.stats) {
        const parts = [];
        if (civ.stats.downloadCount != null) parts.push('下载 ' + Number(civ.stats.downloadCount).toLocaleString());
        if (civ.stats.thumbsUpCount != null) parts.push('喜欢 ' + Number(civ.stats.thumbsUpCount).toLocaleString());
        if (parts.length) { const c = el('div', 'mc-bd-text'); c.textContent = parts.join(' · '); sec.appendChild(c); }
      }
      body.appendChild(sec);
    }
    // 图片来源预览
    if (civ.images && civ.images.length) {
      const sec = el('div', 'mc-bd-sec');
      const st = el('div', 'mc-bd-sec-title'); st.textContent = '示例图';
      sec.appendChild(st);
      const gal = el('div', 'mc-bd-gallery');
      civ.images.slice(0, 12).forEach((im) => {
        if (!im.url) return;
        const g = document.createElement('img');
        g.className = 'mc-bd-gal'; g.src = im.url; g.alt = '';
        g.loading = 'lazy';
        g.onclick = () => { try { window.open(im.url, '_blank'); } catch (_) { /* 忽略 */ } };
        gal.appendChild(g);
      });
      sec.appendChild(gal); body.appendChild(sec);
    }
  }

  function isNode(node) {
    return !!(node && (
      node.type === NODE ||
      node.comfyClass === NODE ||
      (node.constructor && node.constructor.comfyClass === NODE) ||
      (node.constructor && node.constructor.nodeData && node.constructor.nodeData.name === NODE)
    ));
  }

  let _widgetSeq = 0;
  function nextWidgetType() { _widgetSeq += 1; return 'mc-config__' + _widgetSeq.toString(36); }

  // ===== Canvas 面板（onDrawForeground）：不依赖 Node 2.0，端口与面板同画布 =====
  const CANVAS_BG = '#ffffff', CANVAS_CARD = '#fff', CANVAS_BORDER = '#d9d2c8',
        CANVAS_TXT = '#1a1f2b', CANVAS_MUTED = '#8a9aa8', CANVAS_BTN = '#233043',
        CANVAS_DD = '#3d5a80';
  function cmR(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }

  // 命中区注册表：draw 时填充，mouse 时判断
  function clearRegions(node) { node._mcRegions = []; }
  function addRegion(node, x, y, w, h, name, data) {
    node._mcRegions = node._mcRegions || [];
    node._mcRegions.push({ x, y, w, h, name, data });
  }
  function hitRegion(node, mx, my) {
    const rs = node._mcRegions || [];
    for (let i = rs.length - 1; i >= 0; i -= 1) {
      const r = rs[i];
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return r;
    }
    return null;
  }

  function cdrawButton(ctx, node, x, y, w, h, label, name, data, opts) {
    opts = opts || {};
    cmR(ctx, x, y, w, h, 6);
    ctx.fillStyle = opts.bg || CANVAS_BTN;
    ctx.fill();
    ctx.fillStyle = opts.fg || '#fff';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
    addRegion(node, x, y, w, h, name, data);
  }
  function cdrawChip(ctx, node, x, y, w, h, label, name, data, color) {
    cmR(ctx, x, y, w, h, 5);
    ctx.fillStyle = color || '#8b5cf6';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
    addRegion(node, x, y, w, h, name, data);
  }

  function canvasDrawInterface(ctx, node) {
    const st = stateFor(node);
    const W = Math.max(240, node.size[0]);
    const H = Math.max(140, node.size[1]);
    const TOP = 26; // 面板贴近标题下方
    clearRegions(node);
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    // 背景
    cmR(ctx, 0, TOP - 6, W, H - TOP + 6, 8);
    ctx.fillStyle = CANVAS_BG;
    ctx.fill();
    // 两侧 socket 标签交给节点外的 DOM 覆盖层（installOutsideLabels），这里面板内容居中、留出边缘
    const LG = 10, RG = 10; // 左右留白，避免盖住节点边缘的 socket 圆点
    // 顶部工具栏（居中）
    const TB = { x: LG, y: TOP, w: W - LG - RG, h: 30 };
    cmR(ctx, TB.x, TB.y, TB.w, TB.h, 7);
    ctx.fillStyle = CANVAS_CARD; ctx.fill();
    ctx.strokeStyle = CANVAS_BORDER; ctx.lineWidth = 1; ctx.stroke();
    cdrawButton(ctx, node, TB.x + 6, TB.y + 5, 116, 20, '+ 添加加载器…', 'add', null, { bg: CANVAS_DD });
    ctx.fillStyle = CANVAS_MUTED; ctx.font = '11px Inter, system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(st.presetName || '预设名', TB.x + 130, TB.y + 16);
    addRegion(node, TB.x + 128, TB.y + 3, 120, 24, 'presetName', null);
    cdrawButton(ctx, node, TB.x + TB.w - 144, TB.y + 5, 46, 20, '保存', 'save', null);
    cdrawButton(ctx, node, TB.x + TB.w - 94, TB.y + 5, 46, 20, '加载', 'load', null);
    cdrawButton(ctx, node, TB.x + TB.w - 44, TB.y + 5, 42, 20, '删除', 'delete', null);
    let y = TB.y + TB.h + 8;
    const rowX = LG, rowW = W - LG - RG;

    if (!st.loaders.length) {
      ctx.fillStyle = CANVAS_MUTED; ctx.font = '12px Inter, system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('暂无加载器（点上方「+ 添加加载器…」）', W / 2, y + 30);
    } else {
      st.loaders.forEach((loader, idx) => {
        const rh = 34;
        const ry = y;
        cmR(ctx, rowX, ry, rowW, rh, 7);
        ctx.fillStyle = CANVAS_CARD; ctx.fill();
        ctx.strokeStyle = CANVAS_BORDER; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = CANVAS_MUTED; ctx.font = '10px Inter, system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(String(idx + 1), rowX + 12, ry + rh / 2 + 0.5);
        const tCol = loader.type === 'checkpoint' ? '#8b5cf6' : loader.type === 'unet' ? '#3b82f6'
          : loader.type === 'clip' ? '#fbbf24' : loader.type === 'vae' ? '#ef4444' : '#10b981';
        cdrawChip(ctx, node, rowX + 24, ry + 6, 74, 22, loader.type.toUpperCase(), 'type', { idx }, tCol);
        const fileX = rowX + 104, fileW = rowW - 132;
        cmR(ctx, fileX, ry + 6, fileW, 22, 5);
        ctx.fillStyle = CANVAS_BG; ctx.fill();
        ctx.strokeStyle = CANVAS_BORDER; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = CANVAS_TXT; ctx.font = '10px Inter, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText((loader.file || '选择模型…').slice(0, Math.floor(fileW / 5.2)), fileX + 6, ry + rh / 2 + 0.5);
        addRegion(node, fileX, ry + 4, fileW, 26, 'file', { idx });
        cdrawButton(ctx, node, rowX + rowW - 34, ry + 7, 26, 20, '×', 'remove', { idx }, { bg: '#c0392b' });
        y = ry + rh + 6;
        if (y > H - 8) return;
      });
    }
    if (st._mcWarn) {
      ctx.fillStyle = CANVAS_MUTED; ctx.font = '10px Inter, system-ui, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(st._mcWarn, LG + 4, H - 6);
      st._mcWarn = null;
    }
    ctx.restore();
  }

  function canvasMouseDown(node, e, pos, canvas) {
    const rx = (canvas ? e.canvasX : pos[0]) - node.pos[0];
    const ry = (canvas ? e.canvasY : pos[1]) - node.pos[1];
    // 打开的菜单优先
    if (node._mcMenu) {
      const menu = node._mcMenu;
      for (let i = 0; i < menu.items.length; i += 1) {
        const my = menu.y + i * 24;
        if (rx >= menu.x && rx <= menu.x + menu.w && ry >= my && ry <= my + 22) {
          const item = menu.items[i];
          node._mcMenu = null;
          menu.onPick(item.value);
          canvasRedraw(node);
          return true;
        }
      }
      node._mcMenu = null;
      canvasRedraw(node);
      return true;
    }
    const r = hitRegion(node, rx, ry);
    if (!r) return false;
    if (r.name === 'add') {
      openMenu(node, rx, ry, [
        { label: 'Checkpoint (模型+CLIP+VAE)', value: 'checkpoint', color: '#a78bfa' },
        { label: 'UNET (模型)', value: 'unet', color: '#60a5fa' },
        { label: 'CLIP (文本编码)', value: 'clip', color: '#fbbf24' },
        { label: 'VAE', value: 'vae', color: '#f87171' },
        { label: 'LoRA', value: 'lora', color: '#34d399' },
      ], (type) => { addLoader(node, type); syncToConfig(node); canvasRedraw(node); });
      canvasRedraw(node);
      return true;
    }
    if (r.name === 'type') {
      const idx = r.data.idx;
      openMenu(node, rx, ry, [
        { label: 'UNET', value: 'unet' }, { label: 'CLIP', value: 'clip' },
        { label: 'VAE', value: 'vae' }, { label: 'Checkpoint', value: 'checkpoint' },
        { label: 'LoRA', value: 'lora' },
      ], (type) => { changeType(node, idx, type); syncToConfig(node); canvasRedraw(node); });
      canvasRedraw(node);
      return true;
    }
    if (r.name === 'file') {
      const idx = r.data.idx;
      const loader = stateFor(node).loaders[idx];
      const files = (stateFor(node).files[loader.type] || []);
      if (!files.length) { canvasRedraw(node); return true; }
      openMenu(node, rx, ry, files.map((f) => ({ label: f, value: f })), (f) => {
        stateFor(node).loaders[idx].file = f;
        syncToConfig(node); canvasRedraw(node);
      });
      canvasRedraw(node);
      return true;
    }
    if (r.name === 'remove') {
      const idx = r.data.idx;
      stateFor(node).loaders.splice(idx, 1);
      syncToConfig(node); canvasRedraw(node);
      return true;
    }
    if (r.name === 'save') {
      const st = stateFor(node);
      const presets = readPresets();
      const name = st.presetName && st.presetName.trim() ? st.presetName.trim() : '预设_' + (presets.length + 1);
      const obj = { name, loaders: st.loaders.map(function (l) { return JSON.parse(JSON.stringify(l)); }) };
      const i = presets.findIndex(function (p) { return p.name === name; });
      if (i >= 0) presets[i] = obj; else presets.push(obj);
      writePresets(presets);
      st._mcWarn = '已保存预设：' + name;
      canvasRedraw(node);
      return true;
    }
    if (r.name === 'load') {
      const presets = readPresets();
      if (presets.length) {
        openMenu(node, rx, ry, presets.map(function (p) { return { label: p.name, value: p.name }; }), function (name) {
          const p = readPresets().find(function (x) { return x.name === name; });
          if (p && Array.isArray(p.loaders)) {
            const st = stateFor(node);
            st.loaders = p.loaders.map(function (l) { return Object.assign({}, l, { extra: Object.assign(defaultExtra(l.type), l.extra || {}) }); });
            const ml = st.loaders.find(function (l) { return isMainType(l.type); });
            st.loaders.forEach(function (l) { if (l.type === 'lora') l.targetId = ml ? ml.id : null; });
            syncToConfig(node); canvasRedraw(node);
          }
        });
      }
      canvasRedraw(node);
      return true;
    }
    if (r.name === 'delete') {
      const presets = readPresets();
      if (presets.length) {
        openMenu(node, rx, ry, presets.map(function (p) { return { label: p.name, value: p.name }; }), function (name) {
          writePresets(readPresets().filter(function (x) { return x.name !== name; }));
          canvasRedraw(node);
        });
      }
      canvasRedraw(node);
      return true;
    }
    return false;
  }

  function canvasMouseMove(node, e, pos, canvas) {
    if (!node._mcMenu) return false;
    canvasRedraw(node);
    return node._mcMenu ? true : false;
  }

  function canvasRedraw(node) { if (node.graph) node.graph.setDirtyCanvas(true, true); }

  // canvas 模式：onDrawForeground 画面板（不依赖 Node 2.0），config widget 仍供执行
  function canvasSetup(node) {
    if (node._mcCanvasSetup) return;
    node._mcCanvasSetup = true;
    if (!stateFor(node).loaders) stateFor(node).loaders = [];
    const st = stateFor(node);
    if (!st.files) st.files = {};
    const w = configWidget(node);
    if (w) st.loaders = parseLoaders(w.value);
    node.onDrawForeground = function (ctx) {
      if (this.flags.collapsed) return;
      canvasDrawInterface(ctx, this);
      drawMenu(ctx, this);
    };
    node.onMouseDown = function (e, pos, canvas) { return canvasMouseDown(this, e, pos, canvas); };
    node.onMouseMove = function (e, pos, canvas) { return canvasMouseMove(this, e, pos, canvas); };
    setTimeout(hideConfigWidget, 60, node);
    canvasRedraw(node);
    void fetchFiles(node);
    installOutsideLabels(node);
  }

  // 在节点外画黑框 socket 标签（仿 WebUI-Prompt-Bridge 的 drawSide / installBridgeSlotLabelOverlay）
  // 自绘拖线：从 socket 连接点画 SVG 线，松手命中目标后 connect（放大触发区 + 修正触发起点的偏差）
  let _mcWire = null;
  function mcWireStart(node, isInput, index, e) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const canvas = (app && app.canvas) || null;
    let pos = null;
    try { pos = node.getConnectionPos(isInput, index, [0, 0]); } catch (_) { pos = null; }
    let cx = e.clientX, cy = e.clientY;
    if (pos && pos.length && canvas) {
      const scale = (canvas.ds && canvas.ds.scale) || 1;
      const off = (canvas.ds && canvas.ds.offset) || [0, 0];
      let rect = null; try { rect = canvas.getBoundingClientRect(); } catch (_) { rect = null; }
      if (rect) { cx = rect.left + (pos[0] + off[0]) * scale; cy = rect.top + (pos[1] + off[1]) * scale; }
    }
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;overflow:visible;';
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('stroke', '#3b82f6'); path.setAttribute('stroke-width', '2.5'); path.setAttribute('fill', 'none');
    svg.appendChild(path); svg.dataset.mcWire = '1'; document.body.appendChild(svg);
    _mcWire = { node, isInput, index, cx, cy, mx: cx, my: cy, path, svg };
    document.addEventListener('mousemove', mcWireMove);
    document.addEventListener('mouseup', mcWireUp);
    mcWireDraw();
  }
  function mcWireDraw() {
    if (!_mcWire) return;
    const d = _mcWire, x1 = d.cx, y1 = d.cy, x2 = d.mx, y2 = d.my;
    const midX = x1 + (x2 - x1) * 0.5;
    d.path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2);
  }
  function mcWireMove(e) { if (!_mcWire) return; _mcWire.mx = e.clientX; _mcWire.my = e.clientY; mcWireDraw(); }
  function mcWireUp(e) {
    const d = _mcWire; if (!d) return;
    document.removeEventListener('mousemove', mcWireMove);
    document.removeEventListener('mouseup', mcWireUp);
    if (d.svg && d.svg.parentNode) d.svg.parentNode.removeChild(d.svg);
    _mcWire = null;
    const canvas = (app && app.canvas) || null; const graph = canvas && canvas.graph;
    if (!graph || !canvas) return;
    let mouse = null;
    try { mouse = canvas.convertEventToCanvasOffset(e); } catch (_) { mouse = null; }
    if (!mouse) return;
    const n = graph.getNodeOnPos ? graph.getNodeOnPos(mouse[0], mouse[1], null, 12) : null;
    if (!n || n === d.node) return;
    const arr = d.isInput ? (n.outputs || []) : (n.inputs || []);
    const posFn = d.isInput ? ((i) => n.getOutputPos && n.getOutputPos(i)) : ((i) => n.getInputPos && n.getInputPos(i));
    for (let i = 0; i < arr.length; i += 1) {
      const p = posFn(i);
      if (p && Math.hypot(mouse[0] - p[0], mouse[1] - p[1]) < 26) {
        try { if (d.isInput) n.connect(i, d.node, d.index); else d.node.connect(d.index, n, i); } catch (_) { /* 忽略 */ }
        break;
      }
    }
    if (canvas.setDirty) canvas.setDirty(true, true);
  }

  function installOutsideLabels(node) {
    if (!node || node._mcOutLabels) return;
    node._mcOutLabels = true;
    let all = [];
    let sig = '';
    const mk = (text, color) => {
      const l = document.createElement('div');
      l.className = 'mc-socket-label';
      l.textContent = text || '';
      l.style.display = 'none';
      document.body.appendChild(l);
      return l;
    };
    const typeColor = (t) => (t === 'MODEL' ? '#a78bfa' : t === 'CLIP' ? '#fbbf24' : '#f87171');
    // socket 名可能是 Autogrow 的「父.子」（如 model_in.model_in_1），截短后只留最右段
    const shortName = (s) => {
      const n = (s && (s.name || s.type)) || '';
      const parts = String(n).split('.');
      return parts[parts.length - 1];
    };
    // 每帧检测 socket 列表，变了就重建黑框（Autogrow 新增端口时同步）
    const scan = () => {
      const cur = [];
      // 只画输出标签（无输入口）
      (node.outputs || []).forEach((s, i) => {
        if (['MODEL', 'CLIP', 'VAE'].indexOf(s.type) >= 0 && !s.hidden) cur.push({ in: false, i, name: s.name || s.type, type: s.type });
      });
      const s = cur.map((x) => x.in + '|' + x.i + '|' + x.name).join(';');
      if (s !== sig) {
        sig = s;
        all.forEach((x) => { try { x.el.remove(); } catch (_) { /* 忽略 */ } });
        all = cur.map((x) => ({ el: mk(shortName({ name: x.name }), typeColor(x.type)), in: x.in, i: x.i }));
        node._mcOutEls = all.map((x) => x.el);
      }
    };
    const update = () => {
      const rootEl = node._mcRoot;
      if (!rootEl || !rootEl.isConnected) { return; }
      // 节点不在当前图（子图切换/隐藏）→ 移除黑框并停止，避免残留
      if (app && app.graph && node.graph !== app.graph) {
        (node._mcOutEls || []).forEach((el) => { try { el.remove(); } catch (_) { /* 忽略 */ } });
        node._mcOutEls = [];
        return;
      }
      let rect = null;
      try { rect = rootEl.getBoundingClientRect(); } catch (_) { return; }
      if (!rect || rect.width <= 0) { return; }
      // 节点被缩放/平移到视口外或缩得太小 → 隐藏黑框，避免残留在屏幕左侧
      const nodeW0 = (node.size && node.size[0]) || 1;
      const sx0 = rect.width / nodeW0;
      if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight || sx0 < 0.35) {
        all.forEach((item) => { item.el.style.display = 'none'; });
        return;
      }
      scan();
      const nodeH = (node.size && node.size[1]) || 1;
      const sy = rect.height / nodeH;
      node._mcOutLogged = true;
      all.forEach((item) => {
        let pos = null;
        try { pos = node.getConnectionPos(item.in, item.i, [0, 0]); } catch (_) { pos = null; }
        if (!pos || !pos.length) {
          try { pos = item.in ? node.getInputPos(item.i) : node.getOutputPos(item.i); } catch (_2) { pos = null; }
        }
        if (!pos || !pos.length) { item.el.style.display = 'none'; return; }
        // 标签对齐【原生 socket 圆点】：用节点 DOM rect + socket 相对坐标（位置最准）
        const nodeW = (node.size && node.size[0]) || 1;
        const sx = rect.width / nodeW;
        const gx = (pos && pos[0]) || 0;
        const gy = (pos && pos[1]) || 0;
        const np = node.pos || [0, 0];
        const nodeRelX = gx - (np[0] || 0);
        const nodeRelY = gy - (np[1] || 0);
        const cx = rect.left + nodeRelX * sx;
        const cy = rect.top + nodeRelY * sy;
        item.el.style.display = 'inline-flex';
        item.el.style.zIndex = '20';
        const zoom = Math.max(0.5, sx);
        // 黑框字号/内边距随画布缩放（放大后文字+框一起变大，匹配圆点）
        item.el.style.fontSize = Math.max(8, 9 * zoom) + 'px';
        item.el.style.padding = (3 * zoom) + 'px ' + (7 * zoom) + 'px';
        const tw = item.el.offsetWidth;
        const th = item.el.offsetHeight || 16;
        const offX = 10 * zoom;
        item.el.style.left = (item.in ? cx - tw - offX : cx + offX) + 'px';
        item.el.style.top = (cy - th / 2) + 'px';
        node._mcOutPosLogged = true;
      });
    };
    // 不再每帧自递归：画布重绘（onDrawForeground）+ resize/滚动/注册表变化 触发，一帧最多一次；静止时零开销
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
      schedule();
    }
  }

  function openMenu(node, x, y, items, onPick) {
    node._mcMenu = { x, y, w: 160, items, onPick };
  }
  function drawMenu(ctx, node) {
    const menu = node._mcMenu;
    if (!menu) return;
    ctx.save();
    ctx.font = '11px Inter, system-ui, sans-serif';
    menu.items.forEach((m, i) => {
      const my = menu.y + i * 24;
      cmR(ctx, menu.x, my, menu.w, 22, 5);
      ctx.fillStyle = i % 2 ? '#2c3e50' : '#34495e';
      ctx.fill();
      ctx.fillStyle = m.color || '#fff';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(m.label, menu.x + 8, my + 11);
    });
    ctx.restore();
  }

  // 隐藏 Python 端暴露的 config 文本框（完全归零，像 WebUI-Prompt-Bridge 那样，让面板从顶部填充）
  function hideConfigWidget(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && (_in.name === 'config')) { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}

    const w = configWidget(node);
    if (!w || node._mcCfgHid) return;
    node._mcCfgHid = true;
    try {
      w.origComputeSize = w.computeSize;
      w.computeSize = () => [0, 0];
      w.computedHeight = 0;
      w.y = 0;
      w.last_y = 0;
      w.width = 0;
      w.draw = () => {};
      w.hidden = true;
      w.options = w.options || {};
      w.options.hidden = true; // 新版（Vue widget 渲染）读 options.hidden
      w.options.getMinHeight = () => 0;
      w.options.getMaxHeight = () => 0;
      if (w.element && w.element.style) {
        w.element.style.display = 'none';
        w.element.style.height = '0';
        w.element.style.minHeight = '0';
        w.element.style.maxHeight = '0';
      }
    } catch (_) { /* 忽略 */ }
  }

  // 面板宽度 100% + 高度 100%（填满节点，底边始终挨着节点底边；拖动拉高时面板跟随填满）。
  // socket 圆点由「透明壳 + 面板左右 margin:14px」从节点边缘露出来（不在此处内缩，曾触发增高/崩溃）。
  function applySocketOverlayLayout(node) {
    const panel = node._mcRoot;
    if (!panel || !panel.isConnected) return;
    const setImp = (target, property, value) => {
      if (!target || !target.style) return;
      try { target.style.setProperty(property, value, 'important'); } catch (_) { /* 忽略 */ }
    };
    // 面板宽度 100% + 高度 100%（填满节点，底边始终挨着节点底边；拖动拉高时面板跟随填满）
    setImp(panel, 'width', '100%');
    setImp(panel, 'max-width', '100%');
    setImp(panel, 'height', '100%');
    setImp(panel, 'max-height', '100%');
    setImp(panel, 'box-sizing', 'border-box');
  }

  function setupNode(node) {
    if (!node || node._mcSetup) return;
    try {
      if (typeof node.addDOMWidget !== 'function') {
        console.warn('[ModelsCombo] 该 ComfyUI 前端不支持 addDOMWidget，节点控件未启用（改用全屏编辑器）');
        return;
      }
      node._mcSetup = true;
      ensureFiles(node);
      loadFromConfig(node);
      // 供 EzFlex-MainControl 读取/套用本节点预设
      if (!node._ezComboAPI) node._ezComboAPI = {
        presetNames: async () => { try { const r = await fetch(PRESET_API); return (await r.json()).map((p) => p.name); } catch (_) { return []; } },
        current: () => { const s = node._mcRoot && node._mcRoot.querySelector('.mc-preset-sel'); if (s) return s.value; return node._ezCurPreset || ''; },
        setCurrent: async (name) => {
          if (!name) {
            node._ezCurPreset = '';
            stateFor(node).loaders = []; syncToConfig(node); render(node);
            const s = node._mcRoot && node._mcRoot.querySelector('.mc-preset-sel'); if (s) s.value = '';
            return;
          }
          const list = await (async () => { try { const r = await fetch(PRESET_API); return await r.json(); } catch (_) { return []; } })();
          if (!list.some((p) => p.name === name)) return; // 预设不存在则不动
          node._ezCurPreset = name; await loadPreset(node, null, name);
          const s = node._mcRoot && node._mcRoot.querySelector('.mc-preset-sel'); if (s && s.value !== name) { s.value = name; }
        },
        refresh: () => render(node),
      };

      const root = buildRoot(node);
      root.style.minHeight = '135px';
      node._mcRoot = root;
      makeDomWidgetHitThrough(root);

      const widget = node.addDOMWidget('模型组合', nextWidgetType(), root, {
        serialize: false,
        hideOnZoom: false,
        canvasOnly: !window.__ezflexIsVueNodes(),
        margin: 4,
        getMinHeight: () => 200,
        getValue: () => JSON.stringify(stateFor(node).loaders),
        setValue: (v) => { stateFor(node).loaders = parseLoaders(v); render(node); }
      });
      makeDomWidgetHitThrough(widget.element || root);

      // 高度逻辑：节点 = max(最小高度 minH, 内容高 contentH)（哪个大用哪个）。
      // 主渲染面板 height:100% 填满节点，底边始终挨着节点底边；初始压一次到 140，之后可自由拖动。
      const MIN_H = 140, baseH = 80, rowH = 41;
      const minH = Math.max(140, MIN_H );
      const contentH = () => {
        const n = (stateFor(node).loaders || []).length;
        return Math.max(minH, baseH + n * rowH);
      };
      const panelH = () => Math.max(minH, contentH());
      node.__mcPanelH = panelH; // 供 render 在内容变化时自动缩放节点高度
      const desired = [MIN_WIDTH, panelH()]; // 初始/最小宽度 = 600
      node.__mcSize = desired;
      if (typeof node.setSize === 'function') node.setSize([...desired]);
      try { node.min_size = [0, minH]; } catch (_) { /* 忽略 */ }
      const GUTTER = { x: 72, y: 20 };
      node._mcGutter = GUTTER;
      const _vueH = () => (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) ? 30 : 0; // Vue 下节点高度 = 内容高 + 标题偏移
      widget.computeSize = function () {
        // widget 最小宽 = max(600, 内容行宽)，不随节点当前宽变——避免「widget=节点宽」反馈导致拉不回去
        const s = node.size || node.__mcSize || desired;
        const cw = Math.max(MIN_WIDTH, estimateRowWidth(node));
        return [Math.max(200, cw), panelH() + _vueH()];
      };
      widget.options = widget.options || {};
      widget.options.getMinHeight = () => Math.max(minH, panelH() + _vueH());
      widget.options.getMaxHeight = () => 2000;
      // webui-prompt-bridge：清 y + 贴顶
      try { widget.y = 0; widget.last_y = 0; } catch (_) { /* 忽略 */ }

      render(node);
      // 面板贴顶 + 端口槽叠在面板边缘（Vue 节点布局）
      try { node.widgets_start_y = 0; } catch (_) { /* 忽略 */ }
      try {
        const wi = node.widgets.indexOf(widget);
        if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); }
      } catch (_) { /* 忽略 */ }
      // 面板填满节点（height:100%），节点高度由 computeSize 决定（max(最小高度, 内容高)）
      applySocketOverlayLayout(node);
      installOutsideLabels(node);
      // 动态隐藏未用的输入/输出口：多档重试 + 每帧强制（有的前端会重建 socket）
      enforceSlots(node);
      let ticks = 0;
      node._mcInitOk = true; // 允许 settle 里压一次初始高度到 140
      const settleIv = setInterval(() => {
        const a = updatePorts(node, true);
        const b = updateInputs(node, true);
        applySocketOverlayLayout(node);
        installOutsideLabels(node);
        if (a || b) { if (node.graph) node.graph.setDirtyCanvas(true, true); ticks = 0; }
        else { ticks += 1; if (ticks >= 4) clearInterval(settleIv); }
        // 初始只压一次到目标高度（140），之后不再强制（用户可自由拖动）
        if (!node._mcInitH && node._mcInitOk) {
          node._mcInitH = true;
          const w = (node.size && node.size[0]) || desired[0];
          if (typeof node.setSize === 'function') node.setSize([w, 140]);
          if (node.graph) node.graph.setDirtyCanvas(true, true);
        }
      }, 250);
      let retry = 0;
      (function retryOverlay() {
        applySocketOverlayLayout(node);
        installOutsideLabels(node);
        if (retry < 10) { retry += 1; setTimeout(retryOverlay, 120); }
      })();
      const prevDraw = node.onDrawForeground;
      node.onDrawForeground = function (ctx) {
        const r = prevDraw ? prevDraw.apply(this, arguments) : undefined;
        // 每帧 enforceSlots 会反复触发重排/增高，改为真正变化时才处理（settle 循环已覆盖）
        return r;
      };
      setTimeout(hideConfigWidget, 60, node);
      void fetchFiles(node);
      // 延迟再读一次 config（等 ComfyUI 恢复工作流里的 config 值后），否则自定义名会丢
      setTimeout(() => { try { loadFromConfig(node); render(node); updatePorts(node, true); syncOutputTypes(node); } catch (_) { /* 忽略 */ } }, 400);
    } catch (e) {
      console.error('[ModelsCombo] widget init failed:', e);
    }
  }

  function hookPrototype(nodeType) {
    if (!nodeType || nodeType.__mcHooked) return;
    nodeType.__mcHooked = true;
    const prev = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = prev ? prev.apply(this, arguments) : undefined;
      setupNode(this);
      return r;
    };
    const prevConfig = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = prevConfig ? prevConfig.apply(this, arguments) : undefined;
      loadFromConfig(this);
      render(this);
      return r;
    };
    const prevRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined;
      cleanupMcNode(this);
      return r;
    };
  }

  // 节点删除时清理：停掉 rAF + 移除外部黑框标签 + 移除 DOM 面板
  function cleanupMcNode(node) {
    (node._mcOutEls || []).forEach((el) => { try { el.remove(); } catch (_) { /* 忽略 */ } });
    node._mcOutEls = [];
    try { if (node._mcRoot) node._mcRoot.remove(); } catch (_) { /* 忽略 */ }
    try { if (_bbNode === node) closeLoraBrowser(); } catch (_) { /* 忽略 */ }
    node._mcSetup = false;
    node._mcCanvasSetup = false;
  }

  const extension = {
    name: 'Comfy.ModelsCombo.Node',
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData && nodeData.name === NODE) hookPrototype(nodeType);
    },
    nodeCreated(node) { if (isNode(node)) setupNode(node); },
    loadedGraphNode(node) { if (isNode(node)) setupNode(node); },
    setup() {
      const nodes = (app.graph && app.graph._nodes) || [];
      nodes.forEach((n) => { if (isNode(n)) setupNode(n); });
    }
  };

  app.registerExtension(extension);
})();
