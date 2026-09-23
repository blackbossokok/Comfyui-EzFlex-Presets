// EzFlex-FreeLatent 节点内嵌控件（canvas 分辨率选择器，参考「分辨率选择器 独立预设版」）。
// 直接在 FreeLatent 节点里渲染 canvas 面板：拖拽尺寸 / 比例算法 / MP / 对齐 / 预设。
// 状态实时写回 config 输入框，由 config 进 prompt、驱动 Python 节点创建 Latent。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { makeDomWidgetHitThrough, scheduleOnRedraw, pumpFrames } from "./ezflex_service.js";
import { ezT, onLocaleChange } from "./ezflex_i18n.js";
import { ezThemeInit, ezThemeColor, ezThemeAlpha, onThemeChange } from "./ezflex_theme.js";

// ===== 样式：颜色全部走主题变量（web/ezflex_theme.js），换主题即时生效 =====
const FL_CSS = `
.fl-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.fl-shell .fl-root{pointer-events:auto;}
.fl-root{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--ez-fg);background:var(--ez-bg);border-radius:10px;padding:8px 10px 10px;display:flex;flex-direction:column;gap:6px;width:auto;min-width:0;min-height:0;height:100%;box-sizing:border-box;user-select:none;-webkit-user-select:none;margin:0 12px;overflow:hidden;}
.fl-root *{user-select:none;-webkit-user-select:none;}
.fl-row{display:flex;gap:4px;align-items:center;flex-wrap:nowrap;}
.fl-row.wrap{flex-wrap:wrap;}
.fl-row label,.fl-top label{font-size:9px;color:var(--ez-fg-3);font-weight:500;letter-spacing:.2px;text-transform:uppercase;white-space:nowrap;user-select:none;-webkit-user-select:none;}
.fl-row select,.fl-row input,.fl-top select,.fl-top input{font-family:inherit;font-size:12px;padding:4px 7px;border:1px solid var(--ez-border);border-radius:7px;background:var(--ez-bg);color:var(--ez-fg);outline:none;transition:.15s ease;box-sizing:border-box;text-align:center;}
.fl-row select:focus,.fl-row input:focus,.fl-top select:focus,.fl-top input:focus{border-color:var(--ez-accent-border);box-shadow:0 0 0 3px rgba(107,107,255,.12);}
.fl-row select:disabled,.fl-row input:disabled,.fl-top select:disabled,.fl-top input:disabled{opacity:.45;background:var(--ez-surface-3);border-color:var(--ez-border);color:var(--ez-fg-muted);cursor:not-allowed;}
.fl-row input,.fl-top input{-moz-appearance:textfield;appearance:none;}
.fl-row input::-webkit-outer-spin-button,.fl-row input::-webkit-inner-spin-button,.fl-top input::-webkit-outer-spin-button,.fl-top input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.fl-num{flex:1 1 42px;min-width:36px;}
.fl-num-xs{flex:1 1 34px;min-width:30px;}
.fl-num-ratio{flex:1 1 28px;min-width:24px;}
.fl-btn{display:inline-flex;align-items:center;justify-content:center;padding:4px 10px;border-radius:7px;border:1px solid var(--ez-border);background:var(--ez-bg);color:var(--ez-fg-3);font-size:11px;font-weight:500;font-family:inherit;cursor:pointer;transition:.15s ease;white-space:nowrap;user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.fl-btn:hover{background:var(--ez-surface-2);border-color:var(--ez-border-strong);}   /* 悬停只换底色，不上浮、不改文字色 */
.fl-btn.primary{background:var(--ez-accent);border-color:var(--ez-accent-border);color:var(--ez-on-strong);}
.fl-btn.primary:hover{background:var(--ez-accent);border-color:var(--ez-accent-border);}
.fl-btn.success{background:var(--ez-ok);border-color:var(--ez-ok-border);color:var(--ez-on-strong);}
.fl-btn.success:hover{background:var(--ez-ok);border-color:var(--ez-ok-border);}
.fl-btn.danger{background:var(--ez-bad);border-color:var(--ez-bad-border);color:var(--ez-on-strong);}
.fl-btn.danger:hover{background:var(--ez-bad);border-color:var(--ez-bad-border);}
.fl-btn.sm{padding:3px 9px;font-size:10px;}
.fl-sel{flex:2 1 60px;min-width:60px;text-align:center;}
.fl-top{display:flex;gap:6px;align-items:center;flex:0 0 auto;width:100%;height:26px;}
.fl-top .fl-btn{white-space:nowrap;height:26px;}
.fl-top .fl-limit{flex:1 1 78px;min-width:60px;text-align:center;height:26px;}
.fl-top .fl-batch{flex:1 1 46px;min-width:42px;text-align:center;height:26px;}
.fl-top .fl-alg{flex:0 0 38px;min-width:34px;text-align:center;font-weight:600;background:var(--ez-accent-bg);border-color:var(--ez-accent-border);color:var(--ez-accent-fg);cursor:pointer;height:26px;}
.fl-top .fl-alg:hover{background:var(--ez-accent);color:var(--ez-on-strong);border-color:var(--ez-accent-border);}
.fl-top .fl-alg.opt{background:var(--ez-ok);border-color:var(--ez-ok-border);color:var(--ez-on-strong);}
.fl-top .fl-alg.opt:hover{background:var(--ez-ok);}
.fl-force{flex:0 0 30px;min-width:28px;height:26px;font-weight:700;}
.fl-force.on{background:var(--ez-ok);border-color:var(--ez-ok-border);color:var(--ez-on-strong);}
.fl-force.on:hover{background:var(--ez-ok);border-color:var(--ez-ok-border);}
.fl-top .fl-swap{flex:0 0 34px;min-width:30px;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:0;font-size:9px;line-height:1;letter-spacing:0;font-weight:700;text-align:center;padding:2px 5px;height:26px;}
.fl-top .fl-swap span{display:block;line-height:1;pointer-events:none;}
.fl-canvas-wrap{position:relative;flex:1 1 auto;min-height:150px;background:var(--ez-surface-2);border:1px solid var(--ez-border);border-radius:10px;overflow:visible;box-shadow:inset 0 2px 4px rgba(0,0,0,.02);}
.fl-canvas-wrap canvas{display:block;width:100%;height:100%;background:var(--ez-surface-2);border-radius:10px;cursor:default;touch-action:none;}
.fl-canvas-select{position:absolute;pointer-events:none;}
.fl-canvas-select .fl-handle{position:absolute;pointer-events:auto;background:var(--ez-accent);border:1px solid var(--ez-border);box-shadow:0 1px 6px rgba(0,0,0,.25);}
.fl-handle--both{width:16px;height:16px;right:-8px;bottom:-8px;border-radius:50%;cursor:nwse-resize;}
.fl-handle--width{width:9px;height:26px;right:-5px;top:50%;transform:translateY(-50%);border-radius:5px;cursor:ew-resize;}
.fl-handle--height{width:26px;height:9px;bottom:-5px;left:50%;transform:translateX(-50%);border-radius:5px;cursor:ns-resize;}
.fl-handle--both:active,.fl-handle--width:active,.fl-handle--height:active{background:var(--ez-accent);transform:scale(1.15);}
.fl-handle--width:active{transform:translateY(-50%) scale(1.15);}
.fl-handle--height:active{transform:translateX(-50%) scale(1.15);}
.fl-info{position:absolute;bottom:6px;left:6px;background:var(--ez-surface);backdrop-filter:blur(8px);padding:6px 10px;border-radius:8px;border:1px solid var(--ez-border);box-shadow:0 2px 10px rgba(0,0,0,.06);font-size:9px;color:var(--ez-fg-3);display:flex;flex-direction:column;gap:3px;pointer-events:none;font-variant-numeric:tabular-nums;z-index:10;line-height:1.5;user-select:none;-webkit-user-select:none;min-width:60px;width:max-content;max-width:calc(100% - 12px);}
.fl-info .rl{display:flex;gap:6px;align-items:baseline;white-space:nowrap;}
.fl-info .rl .k{color:var(--ez-fg-muted);font-weight:400;font-size:7px;text-transform:uppercase;letter-spacing:.2px;min-width:24px;}
.fl-info .rl .v{color:var(--ez-fg);font-weight:600;font-size:10px;}
.fl-info .rl .v.r{color:var(--ez-accent-fg);font-weight:500;}
.fl-info .rl .v.m{font-weight:500;color:var(--ez-fg-3);}
.fl-canvas-size{width:100%;height:100%;}
.fl-badge{font-size:9px;background:var(--ez-accent-bg);color:var(--ez-accent-fg);padding:2px 10px;border-radius:30px;border:1px solid rgba(107,107,255,.15);}
.fl-empty{flex:1 1 auto;display:flex;align-items:center;justify-content:center;color:var(--ez-fg-muted);font-size:12px;background:var(--ez-surface-3);border:1px dashed var(--ez-border);border-radius:7px;margin:2px;}
.fl-ratio-sep{color:var(--ez-fg-muted);font-weight:600;font-size:11px;user-select:none;-webkit-user-select:none;}
.fl-preset-btn{flex:2 1 60px;min-width:60px;text-align:center;overflow:hidden;text-overflow:ellipsis;}
.fl-pmenu{position:fixed;z-index:99990;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:9px;box-shadow:0 10px 28px rgba(20,30,50,.2);padding:4px;max-height:46vh;overflow:auto;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:var(--ez-fg);box-sizing:border-box;}
.fl-pmenu-item{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;}
.fl-pmenu-item:hover{background:var(--ez-surface-2);}
.fl-pmenu-lab{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;}
.fl-pmenu-sep{height:1px;background:var(--ez-surface-4);margin:4px 6px;}
.fl-defstar{flex:0 0 auto;color:#f6c343;font-size:13px;line-height:1;opacity:0;transform:scale(.4) rotate(-40deg);transition:opacity .16s ease,transform .2s cubic-bezier(.2,.9,.3,1.5);cursor:pointer;padding:0 2px;user-select:none;}
.fl-defstar.show,.fl-defstar.on{opacity:1;transform:scale(1) rotate(0deg);}
.fl-defstar:hover{color:#f0a800;transform:scale(1.2) rotate(0deg);}
.fl-socket-label{position:fixed;z-index:20;pointer-events:none;background:rgba(12,16,24,.4);color:#eef1f6;font-size:9px;line-height:1;padding:2px 6px;border-radius:3px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;user-select:none;display:inline-flex;align-items:center;}
.fl-dialog{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:9999;background:rgba(0,0,0,.35);}
.fl-dialog-box{background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:10px;padding:14px;box-shadow:0 10px 34px rgba(0,0,0,.2);display:flex;flex-direction:column;gap:10px;min-width:280px;max-width:380px;outline:none;}
.fl-dialog-label{font-size:12px;color:var(--ez-fg);user-select:none;}
.fl-dialog-input{font-family:inherit;font-size:13px;padding:6px 9px;border:1px solid var(--ez-border);border-radius:7px;outline:none;width:100%;box-sizing:border-box;}
.fl-dialog-input:focus{border-color:var(--ez-accent-border);box-shadow:0 0 0 3px rgba(107,107,255,.12);}
.fl-dialog-row{display:flex;gap:6px;justify-content:flex-end;}
@media (max-width:560px){.fl-port-group{display:none;}}
`;

let _styleInjected = false;
function injectStyle() {
  ezThemeInit();
  if (_styleInjected || typeof document === 'undefined' || !document.head) return;
  _styleInjected = true;
  const s = document.createElement('style');
  s.textContent = FL_CSS;
  document.head.appendChild(s);
}

console.info('[FreeLatent] freelatent_node.js loaded (addDOMWidget canvas picker)');

(function () {
  'use strict';

  const NODE_NAME = 'EzFlex-FreeLatent';
  const PRESET_API = '/freelatent/presets';
  const RATIO_API = '/freelatent/presets/custom_ratios';
  const DEFAULT_API = '/freelatent/presets/default';
  const MIN_WIDTH = 520; // 节点初始/最小宽度（容纳信息栏 + 控制行 + 预设/自定义比例行）
  const DEFAULT_LIMIT = 1024;
  const LIMIT_STEPS = [1024, 2048, 4096, 8192]; // 最大边下拉的预设档

  // 比例列表
  const FIXED_RATIOS = ['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','9:21','10:16','16:9','16:10','21:9','2.35:1'];
  const RATIO_DESC = {
    '1:1':ezT('Square'),'4:5':ezT('Portrait 4:5'),'5:4':ezT('Landscape 5:4'),'3:4':ezT('Portrait 3:4'),'4:3':ezT('Landscape 4:3'),
    '2:3':ezT('Portrait 2:3'),'3:2':ezT('Landscape 3:2'),'16:9':ezT('Widescreen'),'9:16':ezT('Portrait'),'16:10':ezT('Widescreen 10'),
    '10:16':ezT('Portrait 10:16'),'21:9':ezT('Ultrawide'),'9:21':ezT('Portrait 9:21'),'2.35:1':ezT('Cinema widescreen')
  };

  // 参考预设（首次可写入 server user_data 作默认）。与最早独立版前端一致：
  // 先用「标准算法、1.0 MP、8 对齐」计算每个固定比例的宽高，再拼固定分辨率预设。
  const RESOLUTION_PRESETS = [
    { name: '720p HD - 1280x720 - (16:9)', width: 1280, height: 720 },
    { name: '1080p Full HD - 1920x1080 - (16:9)', width: 1920, height: 1080 },
    { name: '1440p 2K - 2560x1440 - (16:9)', width: 2560, height: 1440 },
    { name: '4K UHD - 3840x2160 - (16:9)', width: 3840, height: 2160 },
    { name: '8K UHD - 7680x4320 - (16:9)', width: 7680, height: 4320 },
    { name: 'Cinema 2.35:1 - 1920x817 - (2.35:1)', width: 1920, height: 817 },
    { name: 'Cinema 4K - 4096x1744 - (2.35:1)', width: 4096, height: 1744 },
    { name: 'Portrait 9:16 - 1080x1920 - (9:16)', width: 1080, height: 1920 },
  ];
  const DEFAULT_PRESETS = (function () {
    const out = [];
    FIXED_RATIOS.forEach((ratio) => {
      const r = computeStandard(1.0, ratio, 8);
      if (r) {
        const desc = RATIO_DESC[ratio] || ratio;
        out.push({ name: `${desc} - ${r.w}x${r.h} - (${ratio})`, width: r.w, height: r.h });
      }
    });
    return out.concat(RESOLUTION_PRESETS);
  })();

  function configWidget(node) { return (node.widgets || []).find((w) => w.name === 'config'); }
  function stateFor(node) {
    if (!node._fl) node._fl = {
      width: 1024, height: 1024, batchSize: 1, align: 8,
      limit: DEFAULT_LIMIT, useOptimized: true,
      selectedRatioLabel: '1:1', customRatios: [],
      loading: false, externalWH: false, wLinked: false, hLinked: false, bLinked: false,
      force: false
    };
    return node._fl;
  }

  function el(tag, className, attrs) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k]));
    return e;
  }

  function int(v, d) { const n = parseInt(v, 10); return isNaN(n) ? d : n; }
  function float(v, d) { const n = parseFloat(v); return isNaN(n) ? d : n; }

  // ===== 数学工具 =====
  function gcd(a, b) { a = Math.round(a); b = Math.round(b); while (b) { const t = b; b = a % b; a = t; } return a; }
  function calcAspect(w, h) {
    const g = gcd(w, h);
    const wr = w / g, hr = h / g;
    if (wr >= 1 && wr <= 30 && hr >= 1 && hr <= 30) return `${Math.round(wr)}:${Math.round(hr)}`;
    return (w / h).toFixed(3) + ':1';
  }

  function computeStandard(mp, ratioStr, mult) {
    const parts = String(ratioStr).split(/[:/]/).map(Number);
    if (parts.length !== 2 || parts.some(isNaN)) return null;
    const target = mp * 1024 * 1024;
    const aspect = parts[0] / parts[1];
    const theoW = Math.sqrt(target * aspect);
    const theoH = Math.sqrt(target / aspect);
    return {
      w: Math.max(1, Math.round(theoW / mult) * mult),
      h: Math.max(1, Math.round(theoH / mult) * mult)
    };
  }

  function computeOptimized(mp, ratioStr, mult) {
    const parts = String(ratioStr).split(/[:/]/).map(Number);
    if (parts.length !== 2 || parts.some(isNaN)) return null;
    const target = mp * 1024 * 1024;
    const targetRatio = parts[0] / parts[1];
    let theoW = Math.sqrt(target * targetRatio);
    let theoH = Math.sqrt(target / targetRatio);
    const range = Math.max(mult * 3, 64);
    const wStart = Math.max(1, Math.floor((theoW - range) / mult) * mult);
    const wEnd = Math.floor((theoW + range) / mult) * mult;
    const hStart = Math.max(1, Math.floor((theoH - range) / mult) * mult);
    const hEnd = Math.floor((theoH + range) / mult) * mult;
    let bestW = 1, bestH = 1, bestLoss = Infinity;
    for (let w = wStart; w <= wEnd; w += mult) {
      for (let h = hStart; h <= hEnd; h += mult) {
        const pixels = w * h;
        const ratio = w / h;
        const loss = Math.abs(pixels - target) / target + Math.abs(ratio - targetRatio) / targetRatio;
        if (loss < bestLoss) { bestLoss = loss; bestW = w; bestH = h; }
      }
    }
    if (bestW === 1 && bestH === 1) return computeStandard(mp, ratioStr, mult);
    return { w: bestW, h: bestH };
  }

  function computeResolution(mp, ratioStr, mult, opt) {
    return opt ? computeOptimized(mp, ratioStr, mult) : computeStandard(mp, ratioStr, mult);
  }

  // 把「最大边」下拉/自定义输入拉回 st.limit 的显示
  function syncLimitUI(st) {
    const els = st._els;
    if (!els || !els.limitSel) return;
    const custom = els.limitCustom;
    if (LIMIT_STEPS.indexOf(st.limit) >= 0) {
      els.limitSel.value = String(st.limit);
      if (custom) custom.style.display = 'none';
    } else {
      els.limitSel.value = 'custom';
      if (custom) { custom.style.display = 'inline-block'; custom.value = String(st.limit); }
    }
  }

  function applyBestLimit(theoryW, theoryH, st) {
    const maxDim = Math.max(theoryW, theoryH);
    let best = null;
    for (const lim of LIMIT_STEPS) { if (lim >= maxDim) { best = lim; break; } }
    if (best === null) best = maxDim;
    st.limit = best;
    syncLimitUI(st);
    return best;
  }

  function applyAlignLimit(w, h, st) {
    const mult = st.align || 8;
    const limit = st.limit || DEFAULT_LIMIT;
    let cw = Math.max(1, Math.round(w / mult) * mult);
    let ch = Math.max(1, Math.round(h / mult) * mult);
    if (cw > limit || ch > limit) {
      const s = Math.min(limit / cw, limit / ch);
      cw = Math.round(cw * s); ch = Math.round(ch * s);
      cw = Math.max(1, Math.round(cw / mult) * mult);
      ch = Math.max(1, Math.round(ch / mult) * mult);
      if (cw > limit) { cw = limit; ch = Math.round(limit * (h / w) / mult) * mult; }
      if (ch > limit) { ch = limit; cw = Math.round(limit * (w / h) / mult) * mult; }
      cw = Math.max(1, Math.round(cw / mult) * mult);
      ch = Math.max(1, Math.round(ch / mult) * mult);
    }
    return { w: Math.max(1, Math.min(limit, cw)), h: Math.max(1, Math.min(limit, ch)) };
  }

  // ===== 配置读写 =====
  function loadFromConfig(node) {
    const st = stateFor(node);
    const w = configWidget(node);
    let cfg = {};
    try { cfg = JSON.parse(w ? w.value : '{}') || {}; } catch (_) { cfg = {}; }
    if (!cfg || typeof cfg !== 'object') cfg = {};
    st.width = int(cfg.width, 1024);
    st.height = int(cfg.height, 1024);
    st.batchSize = int(cfg.batch_size, 1);
    st.align = int(cfg.align, 8);
    st.limit = int(cfg.limit, DEFAULT_LIMIT);
    st.useOptimized = cfg.algorithm !== 'standard';
    st.selectedRatioLabel = cfg.aspect || calcAspect(st.width, st.height);
    st.customRatios = Array.isArray(cfg.customRatios) ? cfg.customRatios.filter((r) => r && FIXED_RATIOS.indexOf(r) < 0) : [];
    st.force = !!cfg.force;
    st._hasCfg = (cfg.width != null || cfg.height != null);   // 新建节点（空 config）才套用默认预设
  }

  function syncToConfig(node) {
    const st = stateFor(node);
    const w = configWidget(node);
    if (!w) return;
    const json = JSON.stringify({
      width: st.width, height: st.height, batch_size: st.batchSize,
      align: st.align, algorithm: st.useOptimized ? 'optimized' : 'standard',
      limit: st.limit, aspect: st.selectedRatioLabel, customRatios: st.customRatios,
      force: !!st.force
    });
    w.value = json;
    if (typeof w.callback === 'function') w.callback(json);
    if (node.graph) node.graph.setDirtyCanvas(true, true);
  }

  // ===== 预设（server user_data）=====
  async function apiFetch(path, opts) {
    const f = (api && typeof api.fetchApi === 'function') ? (p, o) => api.fetchApi(p, o) : (p, o) => fetch(p, o);
    return f(path, opts);
  }

  async function loadPresetList() {
    try {
      const r = await apiFetch(PRESET_API);
      if (r && r.ok) return await r.json();
    } catch (_) { /* 忽略 */ }
    return [];
  }

  // ===== 「设为默认」：新建节点自动套用该预设 =====
  async function loadDefaultPreset(node) {
    try {
      const r = await apiFetch(DEFAULT_API);
      const d = (r && r.ok) ? await r.json() : {};
      node._ezDefaultPreset = (d && d.name) ? d : null;
    } catch (_) { node._ezDefaultPreset = null; }
    return node._ezDefaultPreset;
  }

  // 按「预设名」显式设置/清除默认（不依赖当前下拉值，避免误清成空）
  function setDefaultPresetByName(node, name, clear) {
    const st = stateFor(node);
    return loadPresetList().then((list) => {
      const body = { clear: !!(clear || !name) };
      if (!body.clear) {
        const p = list.find((x) => x.name === name);
        const c = (p && p.config) || { width: st.width, height: st.height, batch_size: st.batchSize };
        body.name = name; body.width = int(c.width, st.width); body.height = int(c.height, st.height);
        body.batch_size = Math.max(1, int(c.batch_size, st.batchSize));
      }
      return apiFetch(DEFAULT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }).then((r) => r.json()).then((d) => {
      node._ezDefaultPreset = (d && d.default && d.default.name) ? d.default : null;
      if (_flMenuEl) { closePresetMenu(); openPresetMenu(node); }   // 就地重画星标
    }).catch(() => {});
  }

  function syncPresetTrigger(node) {
    const st = stateFor(node); const els = st._els;
    if (!els || !els.presetBtn) return;
    els.presetBtn.textContent = els.presetSel.value || ezT('— Preset —');
  }

  // ===== 自绘预设下拉：原生 option 放不了「悬停 2 秒出现的星标」 =====
  let _flMenuEl = null, _flStarTimer = null;

  function closePresetMenu() {
    if (_flStarTimer) { clearTimeout(_flStarTimer); _flStarTimer = null; }
    if (_flMenuEl) { try { _flMenuEl.remove(); } catch (_) {} _flMenuEl = null; }
    try { document.removeEventListener('pointerup', _flDocUp, true); } catch (_) {}
    try { document.removeEventListener('wheel', _flDocUp, true); } catch (_) {}
  }

  function _flDocUp(e) {
    if (!_flMenuEl) return;
    const btn = _flMenuEl._btn;
    if (btn && btn.contains(e.target)) return;   // 点触发按钮交给它自己 toggle（第二下要能收起）
    if (!_flMenuEl.contains(e.target)) closePresetMenu();
  }

  // 菜单是 fixed 定位：画布平移/缩放时按按钮的当前屏幕位置重摆，别停在原地
  function placePresetMenu() {
    if (!_flMenuEl) return;
    const btn = _flMenuEl._btn;
    if (!btn || !btn.isConnected) { closePresetMenu(); return; }
    const r = btn.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return;   // 这一刻量不到（画布重排中），保持原位
    const m = _flMenuEl;
    const w = Math.max(220, r.width);
    m.style.width = w + 'px';
    m.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + 'px';
    m.style.maxHeight = Math.max(140, window.innerHeight - r.bottom - 14) + 'px';   // 只在按钮下方展开，放不下就内部滚动
    m.style.top = Math.round(r.bottom + 6) + 'px';
  }
  scheduleOnRedraw(placePresetMenu);

  // 新建 / 清空工作流时 LGraph.clear() 不一定走 onRemoved，这里再兜一层
  function hookGraphClear() {
    const proto = app.graph && Object.getPrototypeOf(app.graph);
    if (!proto || proto.__ezFlClearHooked) return;
    proto.__ezFlClearHooked = true;
    const prev = proto.clear;
    proto.clear = function () { const r = prev.apply(this, arguments); try { closePresetMenu(); } catch (_) {} return r; };
  }

  function openPresetMenu(node) {
    closePresetMenu();
    node._flCloseMenu = closePresetMenu;   // 节点被删时也要收掉，别留在画布上
    const st = stateFor(node); const els = st._els;
    if (!els || !els.presetSel) return;
    const menu = el('div', 'fl-pmenu');
    Array.from(els.presetSel.options).forEach((o) => {
      if (o.disabled) { menu.appendChild(el('div', 'fl-pmenu-sep')); return; }
      const item = el('div', 'fl-pmenu-item');
      const lab = el('span', 'fl-pmenu-lab'); lab.textContent = o.textContent || ezT('— Preset —');
      const star = el('span', 'fl-defstar'); star.textContent = '★';
      star.title = 'Set this preset as the default for new nodes (click again to clear)';
      if (node._ezDefaultPreset && o.value === node._ezDefaultPreset.name) star.classList.add('on');
      item.addEventListener('mouseenter', () => {
        if (!o.value || star.classList.contains('on')) return;
        _flStarTimer = setTimeout(() => star.classList.add('show'), 500);
      });
      item.addEventListener('mouseleave', () => {
        star.classList.remove('show');
        if (_flStarTimer) { clearTimeout(_flStarTimer); _flStarTimer = null; }
      });
      star.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        const isDef = !!(node._ezDefaultPreset && node._ezDefaultPreset.name === o.value);
        setDefaultPresetByName(node, o.value, isDef);
      });
      item.addEventListener('click', () => {
        els.presetSel.value = o.value;
        syncPresetTrigger(node);
        closePresetMenu();
        if (o.value) els.presetSel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      item.appendChild(lab); item.appendChild(star);
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    _flMenuEl = menu;
    menu._btn = els.presetBtn;
    placePresetMenu();
    setTimeout(() => { document.addEventListener('pointerup', _flDocUp, true); document.addEventListener('wheel', _flDocUp, true); }, 0);
  }

  // 空 config（新建节点）时套用默认预设；已有工作流尺寸的不动
  function applyDefaultIfNew(node) {
    const st = stateFor(node);
    if (st._hasCfg) return;
    loadDefaultPreset(node).then((d) => {
      if (!d || !d.width || !d.height || st._hasCfg) return;
      st.width = int(d.width, st.width);
      st.height = int(d.height, st.height);
      st.batchSize = Math.max(1, int(d.batch_size, st.batchSize));
      if (d.name && st._els && st._els.presetSel) { st._els.presetSel.value = d.name; syncPresetTrigger(node); }
      syncToConfig(node);
      refresh(node);
    });
  }

  // 解析预设名「描述 - WxH - (比例)」，用于识别旧版「同比例不同尺寸」的默认项
  function parsePresetName(name) {
    const m = /^(.*) - (\d+)x(\d+) - \(([^)]+)\)$/.exec(String(name || '').trim());
    if (!m) return null;
    return { desc: m[1].trim(), w: parseInt(m[2], 10), h: parseInt(m[3], 10), ratio: m[4].trim() };
  }
  // 预设项的「宽x高|比例」键：同一预设换过语言后会有中/英两个默认名各存一份，按内容认成同一项
  function presetKeyOf(name) {
    const info = parsePresetName(name);
    return (info && info.w > 0 && info.h > 0) ? (info.w + 'x' + info.h + '|' + info.ratio) : null;
  }
  // 是否旧的「比例描述 + 比例」但尺寸与当前默认不一致 → 视为被取代的默认项，丢弃不再展示
  function isStaleRatioPreset(name) {
    const info = parsePresetName(name);
    if (!info) return false;
    if (FIXED_RATIOS.indexOf(info.ratio) < 0) return false;
    if (Object.values(RATIO_DESC).indexOf(info.desc) < 0) return false;
    return DEFAULT_PRESETS.every((dp) => dp.name !== name);
  }
  // 把预设列表排成「默认项按 DEFAULT_PRESETS 顺序置顶 + 自定义项在后」，保证默认位置恒定。
  // 顺带折叠同一预设的跨语言重复项（中/英两个默认名各存一份，宽高比例完全一样，只留一份）。
  function canonicalOrder(list) {
    const byName = {};
    (Array.isArray(list) ? list : []).forEach((p) => { if (p && p.name && !(p.name in byName)) byName[p.name] = p; });
    const ordered = [];
    const defKeys = {};
    DEFAULT_PRESETS.forEach((dp) => {
      const k = presetKeyOf(dp.name);
      if (k) defKeys[k] = true;
      if (byName[dp.name]) { ordered.push(byName[dp.name]); delete byName[dp.name]; }
    });
    const rest = [];
    Object.keys(byName).forEach((n) => { if (isStaleRatioPreset(n)) { delete byName[n]; return; } rest.push(byName[n]); });
    const seenKey = {};
    rest.forEach((p) => {
      const k = presetKeyOf(p.name);
      if (k && (defKeys[k] || seenKey[k])) return;   // 与某个默认项同尺寸同比例（只是名字语言不同）→ 不重复展示
      if (k) seenKey[k] = true;
      ordered.push(p);
    });
    return ordered;
  }

  async function seedPresets(list) {
    // 首启：user_data 里没有任何预设时写入默认分辨率为模板；已有列表缺默认项时补齐（幂等）
    const byName = {};
    (Array.isArray(list) ? list : []).forEach((p) => { if (p && p.name && !(p.name in byName)) byName[p.name] = p; });
    const missing = DEFAULT_PRESETS.filter((p) => !(p.name in byName));
    if (missing.length) {
      const items = missing.map((p) => ({ name: p.name, config: { width: p.width, height: p.height, batch_size: 1 } }));
      for (const item of items) {
        try {
          await apiFetch(PRESET_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
          byName[item.name] = item;
        } catch (_) { /* 忽略 */ }
      }
      return canonicalOrder(byName);
    }
    return canonicalOrder(list);
  }

  // 下拉分两组：默认项（canonicalOrder 已把默认项置顶）+ 自定义项，中间插一条分隔行
  function splitPresets(list) {
    const defNames = {};
    DEFAULT_PRESETS.forEach((dp) => { defNames[dp.name] = true; });
    const defaults = [], customs = [];
    (Array.isArray(list) ? list : []).forEach((p) => {
      if (!p || !p.name) return;
      (defNames[p.name] ? defaults : customs).push(p);
    });
    return { defaults: defaults, customs: customs };
  }

  function refreshPresetSel(sel, noSeed) {
    return loadPresetList().then((list) => seedPresets(list)).then((list) => {
      sel.innerHTML = '';
      const d = el('option', null, { value: '' });
      d.textContent = ezT('— Preset —');
      sel.appendChild(d);
      const groups = splitPresets(list);
      groups.defaults.forEach((p) => {
        const o = el('option', null, { value: p.name });
        o.textContent = p.name;
        sel.appendChild(o);
      });
      if (groups.customs.length) {
        const div = el('option', null, { value: '' });
        div.disabled = true; div.className = 'divider'; div.textContent = '';   // 同比例下拉的分隔行
        sel.appendChild(div);
        groups.customs.forEach((p) => {
          const o = el('option', null, { value: p.name });
          o.textContent = p.name;
          sel.appendChild(o);
        });
      }
      return list;
    });
  }

  // ===== 自定义比例（存 user_data，即节点名称 json 的 customRatios 键）=====
  async function loadCustomRatios(node) {
    const st = stateFor(node);
    let server = [];
    try { const r = await apiFetch(RATIO_API); if (r && r.ok) server = Array.isArray(await r.json()) ? await r.json() : []; } catch (_) { server = []; }
    const merged = Array.isArray(server) ? [...server] : [];
    (st.customRatios || []).forEach((r) => { if (r && merged.indexOf(r) < 0) merged.push(r); });
    st.customRatios = merged.filter((r) => r && FIXED_RATIOS.indexOf(r) < 0);
    syncToConfig(node);
  }

  function persistCustomRatios(node) {
    const st = stateFor(node);
    return apiFetch(RATIO_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ratios: st.customRatios }) });
  }

  // 自定义命名弹窗（ComfyUI 里 window.prompt 常被禁用/遮挡，改自绘蒙层，返回 Promise<string|null>）
  let _flDialog = null;
  function uiPrompt(message, defaultValue) {
    return new Promise((resolve) => {
      if (!_flDialog || !_flDialog.parentNode) {
        _flDialog = el('div', 'fl-dialog');
        const box = el('div', 'fl-dialog-box');
        const lab = el('div', 'fl-dialog-label');
        const input = el('input', 'fl-dialog-input');
        input.type = 'text';
        const row = el('div', 'fl-dialog-row');
        const ok = el('button', 'fl-btn primary'); ok.textContent = ezT('OK');
        const cancel = el('button', 'fl-btn'); cancel.textContent = ezT('Cancel');
        row.appendChild(ok); row.appendChild(cancel);
        box.appendChild(lab); box.appendChild(input); box.appendChild(row);
        _flDialog.appendChild(box);
        document.body.appendChild(_flDialog);
        _flDialog._input = input;
      }
      const input = _flDialog._input;
      const onOk = () => { _flDialog.style.display = 'none'; resolve(input.value); };
      const onCancel = () => { _flDialog.style.display = 'none'; resolve(null); };
      _flDialog.querySelector('.fl-dialog-label').textContent = message;
      input.value = defaultValue || '';
      input.onkeydown = (e) => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
      const okBtn = _flDialog.querySelector('.fl-btn.primary');
      const cancelBtn = _flDialog.querySelector('.fl-dialog-row .fl-btn:not(.primary)');
      if (okBtn) okBtn.onclick = onOk;
      if (cancelBtn) cancelBtn.onclick = onCancel;
      _flDialog.style.display = 'flex';
      setTimeout(() => { try { input.focus(); input.select(); } catch (_) { /* 忽略 */ } }, 0);
    });
  }

  // ===== 黑框 socket 标签（仿 ModelsCombo）：面板盖住原生文字，只留圆点，框标端口名 =====
  function installOutsideLabels(node) {
    if (!node || node._flOutLabels) return;
    node._flOutLabels = true;
    let all = [];
    let sig = '';
    const mk = (text) => {
      const l = document.createElement('div');
      l.className = 'fl-socket-label';
      l.textContent = text || '';
      l.style.display = 'none';
      document.body.appendChild(l);
      return l;
    };
    const shortName = (name) => {
      const n = String(name || '');
      const parts = n.split('.');
      return parts[parts.length - 1];
    };
    const labelMap = (name) => {
      const s = shortName(name);
      if (/^latent$/i.test(s)) return 'Latent';
      if (/^width$/i.test(s)) return 'Width';
      if (/^height$/i.test(s)) return 'Height';
      if (/^batch/i.test(s) || /^batch_size$/i.test(s)) return 'Batch';
      return s;
    };
    const colorMap = (name) => {
      const s = shortName(name);
      if (/^latent$/i.test(s)) return '#a77bff';
      if (/width|height/i.test(s)) return '#3dbd72';
      return '#8a96a6';
    };
    const scan = () => {
      const cur = [];
      (node.inputs || []).forEach((s, i) => {
        if (!s || s.hidden || s.widget || /config/i.test(s.name || '')) return;
        cur.push({ in: true, i, name: s.name || s.type || '' });
      });
      (node.outputs || []).forEach((s, i) => {
        if (!s || s.hidden) return;
        cur.push({ in: false, i, name: s.name || s.type || '' });
      });
      const k = cur.map((x) => x.in + '|' + x.i + '|' + x.name).join(';');
      if (k !== sig) {
        sig = k;
        all.forEach((x) => { try { x.el.remove(); } catch (_) { /* 忽略 */ } });
        all = cur.map((x) => ({ el: mk(labelMap(x.name), colorMap(x.name)), in: x.in, i: x.i }));
        node._flOutEls = all.map((x) => x.el);
      }
    };
    const hideAll = () => { all.forEach((item) => { try { item.el.style.display = 'none'; } catch (_) { /* 忽略 */ } }); };
    const update = () => {
      const rootEl = node._flRoot;
      if (!rootEl || !rootEl.isConnected) { hideAll(); return; }   // 控件没挂上/被临时摘掉：先把标签收掉，别留在屏幕上
      // 只在「当前渲染的那张图」里显示：子图（app.canvas.graph）也算当前图，别拿 app.graph 比
      const shown = (app && app.canvas && app.canvas.graph) || (app && app.graph) || null;
      if (shown && node.graph && node.graph !== shown) { hideAll(); return; }
      let rect = null;
      try { rect = rootEl.getBoundingClientRect(); } catch (_) { hideAll(); return; }
      if (!rect || rect.width <= 0) { hideAll(); return; }
      // 节点被缩放/平移到视口外或缩得太小 → 隐藏黑框，避免残留在屏幕左侧
      const nodeW0 = (node.size && node.size[0]) || 1;
      const sx0 = rect.width / nodeW0;
      if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight || sx0 < 0.35) {
        all.forEach((item) => { item.el.style.display = 'none'; });
        return;
      }
      scan();
      const nodeW = (node.size && node.size[0]) || 1;
      const nodeH = (node.size && node.size[1]) || 1;
      const sx = rect.width / nodeW;
      const sy = rect.height / nodeH;
      all.forEach((item) => {
        let pos = null;
        try { pos = node.getConnectionPos(item.in, item.i, [0, 0]); } catch (_) { pos = null; }
        if ((!pos || !pos.length) ) { try { pos = item.in ? node.getInputPos(item.i) : node.getOutputPos(item.i); } catch (_2) { pos = null; } }
        if (!pos || !pos.length) { item.el.style.display = 'none'; return; }
        const np = node.pos || [0, 0];
        const nodeRelX = (Number(pos[0]) || 0) - (Number(np[0]) || 0);
        const nodeRelY = (Number(pos[1]) || 0) - (Number(np[1]) || 0);
        const cx = rect.left + nodeRelX * sx;
        const cy = rect.top + nodeRelY * sy;
        item.el.style.display = 'inline-flex';
        item.el.style.zIndex = '20';
        const zoom = Math.max(0.5, sx);
        item.el.style.fontSize = Math.max(8, 9 * zoom) + 'px';
        item.el.style.padding = (3 * zoom) + 'px ' + (7 * zoom) + 'px';
        const tw = item.el.offsetWidth;
        const th = item.el.offsetHeight || 16;
        const offX = 10 * zoom;
        item.el.style.left = (item.in ? cx - tw - offX : cx + offX) + 'px';
        item.el.style.top = (cy - th / 2) + 'px';
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
      onLocaleChange(update);
      onThemeChange(() => { try { drawCanvas(node); } catch (_) { /* 忽略 */ } });   // 画布颜色也跟着主题重画
      schedule();
    }
  }

  function buildRoot(node) {
    injectStyle();
    const shell = el('div', 'fl-shell');
    const root = el('div', 'fl-root');
    shell.appendChild(root);

    // 顶部工具条
    const top = el('div', 'fl-top');
    const limitSel = el('select', 'fl-limit');
    [['1024','1024'],['2048','2048'],['4096','4096'],['8192','8192'],['custom',ezT('Custom')]].forEach(([v, t]) => {
      const o = el('option', null, { value: v }); o.textContent = t; limitSel.appendChild(o);
    });
    limitSel.value = String(DEFAULT_LIMIT);
    const limitCustom = el('input', 'fl-num');
    limitCustom.type = 'number'; limitCustom.value = String(DEFAULT_LIMIT); limitCustom.title = ezT('Custom max edge');
    limitCustom.style.display = 'none';
    const swapBtn = el('button', 'fl-btn fl-swap'); swapBtn.title = ezT('Swap width and height');
    swapBtn.innerHTML = '<span>→</span><span>←</span>';
    const batchInput = el('input', 'fl-batch'); batchInput.type = 'number'; batchInput.value = '1'; batchInput.min = '1'; batchInput.title = ezT('Batch size');
    const forceBtn = el('button', 'fl-btn fl-force'); forceBtn.textContent = ezT('Force'); forceBtn.title = ezT('Force override: ignore external width/height/batch inputs and use the panel values (available only when an input is connected)');
    const algBtn = el('button', 'fl-btn fl-alg opt'); algBtn.textContent = ezT('Opt'); algBtn.title = ezT('Algorithm: Opt = ratio priority, Std = standard rounding');

    top.appendChild(limitSel); top.appendChild(limitCustom); top.appendChild(swapBtn);
    top.appendChild(batchInput); top.appendChild(forceBtn); top.appendChild(algBtn);

    // canvas + 可拖拽选区（右下角/右缘/下缘手柄，仿 Aaalice）
    const cw = el('div', 'fl-canvas-wrap');
    const canvas = document.createElement('canvas');
    canvas.className = 'fl-canvas-size';
    cw.appendChild(canvas);
    const selection = el('div', 'fl-canvas-select');
    const handleBoth = el('div', 'fl-handle fl-handle--both'); handleBoth.title = ezT('Drag to resize (both)');
    const handleWidth = el('div', 'fl-handle fl-handle--width'); handleWidth.title = ezT('Drag to resize width');
    const handleHeight = el('div', 'fl-handle fl-handle--height'); handleHeight.title = ezT('Drag to resize height');
    selection.appendChild(handleBoth); selection.appendChild(handleWidth); selection.appendChild(handleHeight);
    cw.appendChild(selection);
    const info = el('div', 'fl-info');
    info.innerHTML = '<div class="rl"><span class="k">' + ezT('Size') + '</span><span class="v" data-k="w">1024</span><span style="color:var(--ez-fg-muted);font-weight:300;">×</span><span class="v" data-k="h">1024</span></div>' +
      '<div class="rl"><span class="k">' + ezT('Ratio') + '</span><span class="v r" data-k="ratio">1:1</span></div>' +
      '<div class="rl"><span class="k">' + ezT('Actual MP') + '</span><span class="v m" data-k="mp">1.00</span></div>';
    cw.appendChild(info);

    // 控制行
    const ctrl = el('div', 'fl-row');
    const wInput = el('input', 'fl-num'); wInput.type = 'number'; wInput.value = '1024'; wInput.min = '1';
    const hInput = el('input', 'fl-num'); hInput.type = 'number'; hInput.value = '1024'; hInput.min = '1';
    const alignInput = el('input', 'fl-num-xs'); alignInput.type = 'number'; alignInput.value = '8'; alignInput.min = '1';
    const mpInput = el('input', 'fl-num'); mpInput.type = 'number'; mpInput.value = '1.0'; mpInput.step = 'any'; mpInput.min = '0.01';
    const aspectSel = el('select', 'fl-sel');
    ctrl.appendChild(el('label')).textContent = ezT('Width');
    ctrl.appendChild(wInput);
    ctrl.appendChild(el('label')).textContent = ezT('Height');
    ctrl.appendChild(hInput);
    ctrl.appendChild(el('label')).textContent = ezT('Align');
    ctrl.appendChild(alignInput);
    ctrl.appendChild(el('label')).textContent = 'MP';
    ctrl.appendChild(mpInput);
    ctrl.appendChild(el('label')).textContent = ezT('Ratio');
    ctrl.appendChild(aspectSel);

    // 预设行（选中即自动生效，无加载按钮）+ 自定义比例输入（放预设删除按钮之后）
    const presetRow = el('div', 'fl-row wrap');
    const presetSel = el('select', 'fl-sel'); presetSel.style.display = 'none';
    const presetBtn = el('button', 'fl-btn fl-preset-btn'); presetBtn.textContent = ezT('— Preset —');
    presetBtn.title = 'Open the preset list';
    const saveBtn = el('button', 'fl-btn success sm'); saveBtn.textContent = ezT('Save');
    const delBtn = el('button', 'fl-btn danger sm'); delBtn.textContent = ezT('Delete');
    const ratioW = el('input', 'fl-num-ratio'); ratioW.type = 'number'; ratioW.value = '1'; ratioW.min = '1'; ratioW.title = ezT('Custom ratio width');
    const ratioSep = el('span', 'fl-ratio-sep'); ratioSep.textContent = ':';
    const ratioH = el('input', 'fl-num-ratio'); ratioH.type = 'number'; ratioH.value = '1'; ratioH.min = '1'; ratioH.title = ezT('Custom ratio height');
    const saveRatioBtn = el('button', 'fl-btn success sm'); saveRatioBtn.textContent = ezT('Save'); saveRatioBtn.title = ezT('Save custom ratio');
    const delRatioBtn = el('button', 'fl-btn danger sm'); delRatioBtn.textContent = ezT('Delete'); delRatioBtn.title = ezT('Delete selected custom ratio');
    presetRow.appendChild(presetBtn); presetRow.appendChild(presetSel); presetRow.appendChild(saveBtn);
    presetRow.appendChild(delBtn);
    presetRow.appendChild(ratioW); presetRow.appendChild(ratioSep); presetRow.appendChild(ratioH);
    presetRow.appendChild(saveRatioBtn); presetRow.appendChild(delRatioBtn);

    root.appendChild(top);
    root.appendChild(cw);
    root.appendChild(ctrl);
    root.appendChild(presetRow);

    // 状态绑定
    const st = stateFor(node);
    st._els = { limitSel, limitCustom, swapBtn, batchInput, forceBtn, algBtn, canvas, info, selection, handleBoth, handleWidth, handleHeight, wInput, hInput, alignInput, mpInput, aspectSel, presetSel, presetBtn, saveBtn, delBtn, ratioW, ratioH, saveRatioBtn, delRatioBtn };

    // 初始化比例下拉
    buildAspectSel(aspectSel, st);
    // 初始化预设 + 自定义比例（从 user_data 读取）
    refreshPresetSel(presetSel).then(() => syncPresetTrigger(node)).catch(() => {});
    loadDefaultPreset(node);
    loadCustomRatios(node).then(() => buildAspectSel(aspectSel, st));
    // 同步默认控件显示
    limitSel.value = String(st.limit);
    batchInput.value = String(st.batchSize);
    algBtn.textContent = st.useOptimized ? ezT('Opt') : ezT('Std');
    algBtn.classList.toggle('opt', st.useOptimized);
    wInput.value = String(st.width);
    hInput.value = String(st.height);
    alignInput.value = String(st.align);
    mpInput.value = calcMP(st.width, st.height).toFixed(2);

    // 事件
    bindEvents(node);

    return shell;
  }

  function buildAspectSel(sel, st) {
    sel.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = ''; empty.textContent = ''; sel.appendChild(empty);
    FIXED_RATIOS.forEach((r) => {
      const o = document.createElement('option'); o.value = r; o.textContent = r;
      if (r === st.selectedRatioLabel) o.selected = true;
      sel.appendChild(o);
    });
    if (st.customRatios.length) {
      const div = document.createElement('option'); div.disabled = true; div.textContent = ''; div.className = 'divider'; sel.appendChild(div);
      st.customRatios.forEach((r) => {
        const o = document.createElement('option'); o.value = r; o.textContent = r;
        if (r === st.selectedRatioLabel) o.selected = true;
        sel.appendChild(o);
      });
    }
    sel.value = st.selectedRatioLabel && [...sel.options].some((o) => o.value === st.selectedRatioLabel) ? st.selectedRatioLabel : (FIXED_RATIOS[0] || '');
    st.selectedRatioLabel = sel.value;
  }

  function calcMP(w, h) { return (w * h) / (1024 * 1024); }

  // ===== 外部宽高输入端口（width/height 接入后覆盖面板，禁用预设/比例）=====
  function inputByName(node, name) {
    return ((node && node.inputs) || []).find((i) => i.name === name);
  }
  function isInputLinked(node, name) {
    const inp = inputByName(node, name);
    return !!(inp && inp.link != null && inp.link !== undefined);
  }
  function externalIntValue(node, name) {
    const inp = inputByName(node, name);
    if (!inp || inp.link == null || inp.link === undefined) return null;
    const g = node.graph;
    const link = g && g.links && g.links[inp.link];
    if (!link || link.origin_id == null) return null;
    const src = (g.getNodeById ? g.getNodeById(link.origin_id) : null);
    if (!src) return null;
    let val = null;
    try {
      if (src.widgets && src.widgets.length) val = Number(src.widgets[0].value);
      const out = src.outputs && src.outputs[link.origin_slot];
      if ((val == null || isNaN(val)) && out && out.value != null) val = Number(out.value);
    } catch (_) { val = null; }
    if (val == null || isNaN(val)) return null;
    return Math.max(1, Math.round(val));
  }
  function updateExternalWH(node) {
    const st = stateFor(node);
    // 各自独立：只禁接的那个端口；预设/比例/自定义比例只在接入 宽 或 高 时禁用（接入 batch 不禁用）
    st.wLinked = isInputLinked(node, 'width');
    st.hLinked = isInputLinked(node, 'height');
    st.bLinked = isInputLinked(node, 'batch_size');
    st.externalWH = st.wLinked || st.hLinked;
    // 没有任何输入端口有输入时，「强」失效并回落（否则控件禁用无从谈起）
    if (!(st.wLinked || st.hLinked || st.bLinked)) st.force = false;
    refreshForceUI(node);
    applyExternalDisable(node);
  }
  function applyExternalDisable(node) {
    const st = stateFor(node);
    const els = st._els;
    if (!els) return;
    const toggle = (el, on) => { if (on) el.setAttribute('disabled', ''); else el.removeAttribute('disabled'); };
    // 「强」激活时解除所有禁用，让面板值生效
    const forced = !!st.force && (st.wLinked || st.hLinked || st.bLinked);
    toggle(els.wInput, st.wLinked && !forced);
    toggle(els.hInput, st.hLinked && !forced);
    toggle(els.batchInput, st.bLinked && !forced);
    // 接入任一宽/高才禁预设/比例/自定义比例；只接 batch 不禁用
    toggle(els.presetSel, st.externalWH && !forced);
    toggle(els.aspectSel, st.externalWH && !forced);
    toggle(els.ratioW, st.externalWH && !forced);
    toggle(els.ratioH, st.externalWH && !forced);
    toggle(els.saveRatioBtn, st.externalWH && !forced);
    toggle(els.delRatioBtn, st.externalWH && !forced);
    refreshForceUI(node);
    if (st.wLinked || st.hLinked || st.bLinked) syncExternalDims(node, forced);
  }
  function syncExternalDims(node, forced) {
    const st = stateFor(node);
    const els = st._els;
    if (!els) return;
    const w = externalIntValue(node, 'width');
    const h = externalIntValue(node, 'height');
    const b = externalIntValue(node, 'batch_size');
    // 「强」开启时忽略外部宽高/批次，保留面板值（不覆盖）
    if (!forced) {
      if (w != null) st.width = w;
      if (h != null) st.height = h;
      if (b != null) st.batchSize = b;
    }
    updateInfo(st); drawCanvas(node);
    if (node.graph) node.graph.setDirtyCanvas(true, true);
  }
  function refreshForceUI(node) {
    const st = stateFor(node);
    const els = st._els;
    if (!els || !els.forceBtn) return;
    const active = !!st.force && (st.wLinked || st.hLinked || st.bLinked);
    els.forceBtn.classList.toggle('on', active);
    els.forceBtn.textContent = ezT('Force');
    els.forceBtn.title = active ? ezT('Force override active (ignore external width/height/batch, use panel values)') : ezT('Force override (available only when an input is connected)');
  }

  function drawCanvas(node) {
    const st = stateFor(node);
    const els = st._els;
    if (!els) return;
    const canvas = els.canvas;
    const cw = canvas.clientWidth || 320;
    const ch = canvas.clientHeight || 200;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr; canvas.height = ch * dpr;
      canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = ezThemeColor('bg', '#f7f8fc'); ctx.fillRect(0, 0, cw, ch);

    const limit = st.limit || DEFAULT_LIMIT;
    const pad = 32;
    const availW = cw - pad * 2, availH = ch - pad * 2;
    const scale = Math.min(availW / limit, availH / limit, 1.5);
    st._scale = scale;
    const mult = st.align || 8;
    // 屏幕上每格不足 6px 就按 2 倍抽稀，而不是整块不画：抽稀后的线仍落在对齐倍数上
    let step = mult;
    while (step * scale < 6 && step < limit) step *= 2;
    const gridStep = step * scale;
    const startX = pad + (cw - pad * 2 - limit * scale) / 2;
    const startY = pad + (ch - pad * 2 - limit * scale) / 2;

    if (gridStep >= 4) {
      ctx.strokeStyle = ezThemeColor('border', '#e2e6ee'); ctx.lineWidth = 0.5;
      for (let v = 0; v <= limit; v += step) {
        const px = startX + v * scale, py = startY + v * scale;
        if (px <= cw - pad) { ctx.beginPath(); ctx.moveTo(px, startY); ctx.lineTo(px, startY + limit * scale); ctx.stroke(); }
        if (py <= ch - pad) { ctx.beginPath(); ctx.moveTo(startX, py); ctx.lineTo(startX + limit * scale, py); ctx.stroke(); }
      }
      ctx.strokeStyle = ezThemeColor('border-strong', '#d0d5dd'); ctx.lineWidth = 0.8;
      ctx.strokeRect(startX, startY, limit * scale, limit * scale);   // 四边同宽（以前只描左边+下边，上/右显得细）
    }

    const rectW = Math.round(st.width * scale), rectH = Math.round(st.height * scale);
    const totalW = limit * scale, totalH = limit * scale;
    const offX = (cw - totalW) / 2, offY = (ch - totalH) / 2;
    const rx = Math.round(offX + (limit - st.width) / 2 * scale);
    const ry = Math.round(offY + (limit - st.height) / 2 * scale);
    st._rect = { x: rx, y: ry, w: rectW, h: rectH };
    // 拖拽选区盖在方块上（手柄在右缘/下缘/右下角），随方块一起缩放
    if (els.selection) {
      els.selection.style.left = rx + 'px';
      els.selection.style.top = ry + 'px';
      els.selection.style.width = rectW + 'px';
      els.selection.style.height = rectH + 'px';
    }

    ctx.fillStyle = ezThemeAlpha('accent', 0.06, '#6b6bff');   // 半透明，别挡住里面的对齐格
    ctx.shadowColor = ezThemeAlpha('accent', 0.08, '#6b6bff'); ctx.shadowBlur = 20;
    ctx.fillRect(rx, ry, rectW, rectH); ctx.shadowBlur = 0;
    ctx.strokeStyle = ezThemeColor('accent', '#6b6bff'); ctx.lineWidth = 2; ctx.strokeRect(rx, ry, rectW, rectH);
    ctx.strokeStyle = ezThemeColor('accent-border', '#c7d2fe'); ctx.lineWidth = 4; ctx.strokeRect(rx - 1, ry - 1, rectW + 2, rectH + 2);

    // 右下角圆点改由 DOM .fl-handle--both 承载（支持 Pointer Events 可靠拖拽，避免与画布重影）
    ctx.fillStyle = ezThemeColor('fg-3', '#5f6b7a'); ctx.font = '8px Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(`${st.width} px`, rx + rectW / 2, ry + rectH + 13);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`${st.height} px`, rx + rectW + 7, ry + rectH / 2);
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillStyle = ezThemeColor('fg-muted', '#8a9aa8'); ctx.font = '8px Inter, sans-serif';
    ctx.fillText(`${ezT('Limit')} ${limit}×${limit}`, cw - 10, 8);
  }

  function updateInfo(st) {
    const els = st._els;
    if (!els) return;
    const q = els.info.querySelector.bind(els.info);
    q('[data-k="w"]').textContent = st.width;
    q('[data-k="h"]').textContent = st.height;
    q('[data-k="ratio"]').textContent = calcAspect(st.width, st.height);
    q('[data-k="mp"]').textContent = calcMP(st.width, st.height).toFixed(2);
    els.wInput.value = st.width;
    els.hInput.value = st.height;
    const mp = calcMP(st.width, st.height);
    els.mpInput.value = mp.toFixed(2);
    // 控件回填：工作流恢复 config（onConfigure / 400ms 重同步）后要把面板拉回持久化的值，
    // 否则这些控件会一直显示建面板时的默认值（对齐 8 / 最大边 1024 / 批次 1 / 算法 优）。
    els.alignInput.value = st.align;
    syncLimitUI(st);
    els.batchInput.value = st.batchSize;
    els.algBtn.textContent = st.useOptimized ? ezT('Opt') : ezT('Std');
    els.algBtn.classList.toggle('opt', st.useOptimized);
  }

  function refresh(node) {
    const st = stateFor(node);
    updateInfo(st);
    drawCanvas(node);
    if (node.graph) node.graph.setDirtyCanvas(true, true);
  }

  function applyPresetByName(node, name) {
    return loadPresetList().then((list) => {
      const p = list.find((x) => x.name === name);
      if (!p) return;
      node._ezCurPreset = name;
      const cfg = p.config || {};
      const st = stateFor(node);
      const w = int(cfg.width, st.width);
      const h = int(cfg.height, st.height);
      if (cfg.batch_size != null) st.batchSize = Math.max(1, int(cfg.batch_size, st.batchSize));   // 预设里存过批次就一并还原
      applyBestLimit(w, h, st);
      const aligned = applyAlignLimit(w, h, st);
      st.width = aligned.w; st.height = aligned.h;
      syncToConfig(node);
      refresh(node);
    });
  }

  function bindEvents(node) {
    const st = stateFor(node);
    const els = st._els;
    if (!els || st._bound) return;
    st._bound = true;

    // 「强」：强制生效（仅任一输入端口有输入时切换），忽略外部宽高/批次并解除控件禁用
    els.forceBtn.addEventListener('click', () => {
      if (!(st.wLinked || st.hLinked || st.bLinked)) return; // 无输入不做改变
      st.force = !st.force;
      // 先写 config（force=true），再恢复面板值；避免 loadFromConfig 读旧 config 把 force 覆盖回 false
      syncToConfig(node);
      if (st.force) { loadFromConfig(node); }
      applyExternalDisable(node);
      refreshForceUI(node);
      refresh(node);
    });

    // 算法切换
    els.algBtn.addEventListener('click', () => {
      st.useOptimized = !st.useOptimized;
      els.algBtn.textContent = st.useOptimized ? ezT('Opt') : ezT('Std');
      els.algBtn.classList.toggle('opt', st.useOptimized);
      applyFromMP(node);
    });

    // 交换宽高：干净的 W↔H 互换，仅当互换后超出当前限制才提高限制（1:1 互换不再误跳到 2048）
    els.swapBtn.addEventListener('click', () => {
      let newW = st.height, newH = st.width;
      newW = Math.max(1, newW); newH = Math.max(1, newH);
      applyBestLimit(newW, newH, st);
      const aligned = applyAlignLimit(newW, newH, st);
      st.width = aligned.w; st.height = aligned.h;
      syncToConfig(node); refresh(node);
    });

    // 批次
    els.batchInput.addEventListener('input', () => {
      let v = int(els.batchInput.value, 1);
      if (v < 1) v = 1;
      st.batchSize = v; els.batchInput.value = v;
      syncToConfig(node);
    });

    // 限制
    els.limitSel.addEventListener('change', () => {
      if (els.limitSel.value === 'custom') {
        els.limitCustom.style.display = 'inline-block';
        st.limit = int(els.limitCustom.value, DEFAULT_LIMIT);
      } else {
        els.limitCustom.style.display = 'none';
        st.limit = int(els.limitSel.value, DEFAULT_LIMIT);
      }
      st.limit = Math.max(64, st.limit);
      const aligned = applyAlignLimit(st.width, st.height, st);
      st.width = aligned.w; st.height = aligned.h;
      syncToConfig(node); refresh(node);
    });
    els.limitCustom.addEventListener('input', () => {
      st.limit = Math.max(64, int(els.limitCustom.value, DEFAULT_LIMIT));
      const aligned = applyAlignLimit(st.width, st.height, st);
      st.width = aligned.w; st.height = aligned.h;
      syncToConfig(node); refresh(node);
    });

    // 宽高手动输入
    const applyWH = () => {
      const w = int(els.wInput.value, st.width);
      const h = int(els.hInput.value, st.height);
      applyBestLimit(w, h, st);
      const aligned = applyAlignLimit(w, h, st);
      st.width = aligned.w; st.height = aligned.h;
      syncToConfig(node); refresh(node);
    };
    els.wInput.addEventListener('change', applyWH);
    els.hInput.addEventListener('change', applyWH);
    els.wInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyWH(); });
    els.hInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyWH(); });

    // 对齐
    els.alignInput.addEventListener('change', () => {
      st.align = Math.max(1, int(els.alignInput.value, 8));
      const aligned = applyAlignLimit(st.width, st.height, st);
      st.width = aligned.w; st.height = aligned.h;
      syncToConfig(node); refresh(node);
    });

    // MP + 比例
    els.mpInput.addEventListener('change', () => applyFromMP(node));
    els.mpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFromMP(node); });
    els.aspectSel.addEventListener('change', () => {
      st.selectedRatioLabel = els.aspectSel.value || '1:1';
      applyFromMP(node);
    });
    els.aspectSel.addEventListener('click', (e) => {
      if (e.target.tagName === 'OPTION' && e.target.value === els.aspectSel.value) applyFromMP(node);
    });

    // 预设：选中即自动生效；保存 / 删除
    els.presetSel.addEventListener('change', () => {
      syncPresetTrigger(node);
      if (!els.presetSel.value) return;
      // 外部宽高接入时预览/预设常规禁用，但「强」生效时需解除该限制（否则预设无法应用）
      if (st.externalWH && !st.force) return;
      applyPresetByName(node, els.presetSel.value).then(() => {});
    });
    els.saveBtn.addEventListener('click', () => {
      const def = `${calcAspect(st.width, st.height)} - ${st.width}x${st.height} - (${calcAspect(st.width, st.height)})`;
      uiPrompt(ezT('Enter preset name:'), def).then((name) => {
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        apiFetch(PRESET_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: trimmed, config: { width: st.width, height: st.height, batch_size: st.batchSize } }) })
          .then(() => refreshPresetSel(els.presetSel))
          .then(() => { els.presetSel.value = trimmed; syncPresetTrigger(node); });
      });
    });
    els.delBtn.addEventListener('click', () => {
      const name = els.presetSel.value;
      if (!name) return;
      apiFetch(PRESET_API + '/' + encodeURIComponent(name), { method: 'DELETE' })
        .then(() => refreshPresetSel(els.presetSel))
        .then(() => syncPresetTrigger(node));
    });
    els.presetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_flMenuEl) closePresetMenu(); else openPresetMenu(node);
    });

    // 自定义比例（保存 / 删除），存 user_data（customRatios 键）
    els.saveRatioBtn.addEventListener('click', () => {
      const w = int(els.ratioW.value, 1);
      const h = int(els.ratioH.value, 1);
      if (w < 1 || h < 1) return;
      const ratio = `${w}:${h}`;
      if (FIXED_RATIOS.includes(ratio) || st.customRatios.includes(ratio)) return;
      st.customRatios = st.customRatios.concat([ratio]);
      syncToConfig(node);
      buildAspectSel(els.aspectSel, st);
      els.aspectSel.value = ratio; st.selectedRatioLabel = ratio;
      persistCustomRatios(node).then(() => applyFromMP(node));
    });
    els.delRatioBtn.addEventListener('click', () => {
      const sel = els.aspectSel.value;
      if (!sel || st.customRatios.indexOf(sel) < 0) return;
      st.customRatios = st.customRatios.filter((r) => r !== sel);
      syncToConfig(node);
      buildAspectSel(els.aspectSel, st);
      st.selectedRatioLabel = els.aspectSel.value || FIXED_RATIOS[0] || '1:1';
      els.aspectSel.value = st.selectedRatioLabel;
      persistCustomRatios(node).then(() => applyFromMP(node));
    });

    // canvas 拖拽：改为 DOM 手柄 + Pointer Events + window 捕获（仿 Aaalice，规避 Node 2.0 事件被吞导致拖不动）
    const startDrag = (mode, e) => {
      if (e.button !== 0 || st._flDrag) return;
      e.preventDefault(); e.stopPropagation();
      st._flDrag = { mode, sx: e.clientX, sy: e.clientY, ow: st.width, oh: st.height, scale: st._scale || 1 };
      const move = (ev) => {
        if (!st._flDrag) return;
        const scale = st._flDrag.scale;
        let dW = (ev.clientX - st._flDrag.sx) / scale;
        let dH = (ev.clientY - st._flDrag.sy) / scale;
        if (st._flDrag.mode === 'width') dH = 0;
        if (st._flDrag.mode === 'height') dW = 0;
        if (ev.shiftKey) {
          const asp = st._flDrag.ow / st._flDrag.oh;
          if (Math.abs(dW) > Math.abs(dH) * asp) dH = dW / asp;
          else dW = dH * asp;
        }
        let newW = st._flDrag.ow + dW, newH = st._flDrag.oh + dH;
        if (!(ev.ctrlKey || ev.metaKey)) { const m = st.align || 8; newW = Math.round(newW / m) * m; newH = Math.round(newH / m) * m; }
        newW = Math.max(1, newW); newH = Math.max(1, newH);
        const limit = st.limit || DEFAULT_LIMIT;
        if (newW > limit) { newW = limit; if (ev.shiftKey) newH = Math.round(newW / (st._flDrag.ow / st._flDrag.oh)); }
        if (newH > limit) { newH = limit; if (ev.shiftKey) newW = Math.round(newH * (st._flDrag.ow / st._flDrag.oh)); }
        if (!(ev.ctrlKey || ev.metaKey)) { const m = st.align || 8; newW = Math.round(newW / m) * m; newH = Math.round(newH / m) * m; }
        st.width = Math.max(1, newW); st.height = Math.max(1, newH);
        updateInfo(st); drawCanvas(node);
      };
      const up = (ev) => {
        if (!st._flDrag) return;
        st._flDrag = null;
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', up, true);
        syncToConfig(node);
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', up, true);
    };
    els.handleBoth.addEventListener('pointerdown', (e) => startDrag('both', e));
    els.handleWidth.addEventListener('pointerdown', (e) => startDrag('width', e));
    els.handleHeight.addEventListener('pointerdown', (e) => startDrag('height', e));
  }

  function applyFromMP(node) {
    const st = stateFor(node);
    const mp = float(st._els.mpInput.value, 1.0);
    if (mp < 0.01) return;
    let ratio = st._els.aspectSel.value || st.selectedRatioLabel || '1:1';
    st.selectedRatioLabel = ratio;
    const mult = st.align || 8;
    const res = computeResolution(mp, ratio, mult, st.useOptimized);
    if (!res) return;
    const theory = computeResolution(mp, ratio, 1, st.useOptimized);
    if (theory) applyBestLimit(theory.w, theory.h, st);
    const aligned = applyAlignLimit(res.w, res.h, st);
    st.width = aligned.w; st.height = aligned.h;
    syncToConfig(node); refresh(node);
  }

  function hideWidget(w) {
    if (!w) return;
    try {
      w.origComputeSize = w.computeSize;
      w.computeSize = () => [0, 0];
      w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0;
      w.draw = () => {};
      w.hidden = true;
      w.options = w.options || {};
      w.options.hidden = true;
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

  function hideConfigWidget(node) {
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && (_in.name === 'config')) { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}

    const w = configWidget(node);
    if (!w || node._flCfgHid) return;
    node._flCfgHid = true;
    hideWidget(w);
  }

  // 把宽/高/批次输入从「widget」转为可见 socket（左侧可连接外部参数）。
  // 此前端 widget 与 socket 会共存，移除 widget 对象并清空 input.widget 后，
  // onGraphConfigured 也不会再补回 widget，从而保留纯 socket。
  function convertPrimitiveToSocket(node) {
    ['width', 'height', 'batch_size'].forEach((name) => {
      const wi = (node.widgets || []).findIndex((w) => w.name === name);
      if (wi >= 0) { try { node.widgets.splice(wi, 1); } catch (_) { /* 忽略 */ } }
      const inp = inputByName(node, name);
      if (inp) { inp.hidden = false; inp.widget = null; }
    });
  }

  function layoutPanel(node) {
    const panel = node._flRoot;
    if (!panel || !panel.isConnected) return;
    const setImp = (target, prop, value) => {
      if (!target || !target.style) return;
      try { target.style.setProperty(prop, value, 'important'); } catch (_) { /* 忽略 */ }
    };
    setImp(panel, 'height', '100%');
    setImp(panel, 'max-height', '100%');
    setImp(panel, 'box-sizing', 'border-box');
    // Nodes 2.0：节点高 = 内容高 + 标题偏移（widget.computeSize 里 +30），壳必须下移并减掉这段，
    // 否则里面白面板底边会凸出节点底边（inline !important 会压过公共 CSS 的 calc，只能在这里补）。
    if (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) {
      setImp(panel, 'top', 'var(--ezfx-vue-title,30px)');
      setImp(panel, 'height', 'calc(100% - var(--ezfx-vue-title,30px))');
      setImp(panel, 'bottom', 'auto');
    }
  }

  function setupNode(node) {
    if (!node || node._flSetup) return;
    try {
      if (typeof node.addDOMWidget !== 'function') {
        console.warn('[FreeLatent] this ComfyUI frontend does not support addDOMWidget, node controls are disabled');
        return;
      }
      node._flSetup = true;
      loadFromConfig(node);
      convertPrimitiveToSocket(node);
      // 供 EzFlex-MainControl 读取/套用本节点宽高预设
      if (!node._ezLatentAPI) node._ezLatentAPI = {
        presetNames: () => loadPresetList().then((list) => seedPresets(list)).then((l) => l.map((p) => p.name)),
        current: () => { const s = stateFor(node)._els && stateFor(node)._els.presetSel; if (s) return s.value; return node._ezCurPreset || ''; },
        setCurrent: async (name) => {
          if (!name) { node._ezCurPreset = ''; const s = stateFor(node)._els && stateFor(node)._els.presetSel; if (s) s.value = ''; syncPresetTrigger(node); return; }
          const list = await loadPresetList();
          if (!list.some((p) => p.name === name)) return; // 预设不存在则不动
          node._ezCurPreset = name; await applyPresetByName(node, name);
          const s = stateFor(node)._els && stateFor(node)._els.presetSel; if (s && s.value !== name) { s.value = name; }
          syncPresetTrigger(node);
        },
        refresh: () => refresh(node),
      };

      const root = buildRoot(node);
      root.style.minHeight = '340px';
      node._flRoot = root;
      makeDomWidgetHitThrough(root);

      const widget = node.addDOMWidget('分辨率', 'fl-creator', root, {
        serialize: false,
        hideOnZoom: false,
        canvasOnly: !window.__ezflexIsVueNodes(),
        margin: 4,
        getMinHeight: () => 340,
        getValue: () => '{}',
        setValue: () => {}
      });
      makeDomWidgetHitThrough(widget.element || root);

      const minH = 340;
      const contentH = () => minH;
      const panelH = () => Math.max(340, contentH());
      node.__flPanelH = panelH;
      const desired = [MIN_WIDTH, panelH()];
      node.__flSize = desired;
      if (typeof node.setSize === 'function') node.setSize([...desired]);
      try { node.min_size = [0, minH]; } catch (_) { /* 忽略 */ }
      const _vueH = () => (window.__ezflexIsVueNodes && window.__ezflexIsVueNodes()) ? 30 : 0; // Vue 下节点高度 = 内容高 + 标题偏移
      widget.computeSize = function () {
        const s = node.size || node.__flSize || desired;
        return [Math.max(MIN_WIDTH, s[0]), panelH() + _vueH()];
      };
      widget.options = widget.options || {};
      widget.options.getMinHeight = () => Math.max(minH, panelH() + _vueH());
      widget.options.getMaxHeight = () => 2000;
      try { widget.y = 0; widget.last_y = 0; } catch (_) { /* 忽略 */ }

      try { node.widgets_start_y = 0; } catch (_) { /* 忽略 */ }
      try {
        const wi = node.widgets.indexOf(widget);
        if (wi > 0) { node.widgets.splice(wi, 1); node.widgets.unshift(widget); }
      } catch (_) { /* 忽略 */ }
      layoutPanel(node);
      setTimeout(hideConfigWidget, 60, node);
      setTimeout(convertPrimitiveToSocket, 60, node);
      installOutsideLabels(node);
      refresh(node);
      updateExternalWH(node);
      loadCustomRatios(node).then(() => { try { const s = stateFor(node); buildAspectSel(s._els.aspectSel, s); } catch (_) { /* 忽略 */ } });
      // 等 ComfyUI 恢复工作流里的 config 值后再同步一次
      setTimeout(() => { try { loadFromConfig(node); applyDefaultIfNew(node); refresh(node); updateExternalWH(node); installOutsideLabels(node); } catch (_) { /* 忽略 */ } }, 400);
      // canvas 尺寸随节点大小变化时重绘（节点拉大/缩小）
      try {
        const cv = root.querySelector('canvas');
        if (typeof ResizeObserver !== 'undefined' && cv) {
          const ro = new ResizeObserver(() => { drawCanvas(node); });
          ro.observe(cv);
          node._flRO = ro;
        }
      } catch (_) { /* 忽略 */ }
      let retry = 0;
      (function retryLayout() {
        layoutPanel(node);
        if (retry < 10) { retry += 1; setTimeout(retryLayout, 120); }
      })();
    } catch (e) {
      console.error('[FreeLatent] widget init failed:', e);
    }
  }

  function hookPrototype(nodeType) {
    if (!nodeType || nodeType.__flHooked) return;
    nodeType.__flHooked = true;
    const prev = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = prev ? prev.apply(this, arguments) : undefined;
      setupNode(this);
      return r;
    };
    const prevCfg = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = prevCfg ? prevCfg.apply(this, arguments) : undefined;
      loadFromConfig(this);
      convertPrimitiveToSocket(this);
      refresh(this);
      updateExternalWH(this);
      installOutsideLabels(this);
      loadCustomRatios(this).then(() => { try { const s = stateFor(this); buildAspectSel(s._els.aspectSel, s); } catch (_) { /* 忽略 */ } });
      return r;
    };
    const prevConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type) {
      const r = prevConn ? prevConn.apply(this, arguments) : undefined;
      // 输入端口（width/height）接入/断开时刷新外部宽高状态
      if (type === 1) { try { updateExternalWH(this); } catch (_) { /* 忽略 */ } }
      return r;
    };
    const prevRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined;
      try { if (this._flRO) this._flRO.disconnect(); } catch (_) { /* 忽略 */ }
      try { if (this._flOutRaf) cancelAnimationFrame(this._flOutRaf); } catch (_) { /* 忽略 */ }
      try { (this._flOutEls || []).forEach((x) => { try { x.remove(); } catch (_) { /* 忽略 */ } }); } catch (_) { /* 忽略 */ }
      this._flOutEls = [];
      try { if (this._flCloseMenu) this._flCloseMenu(); } catch (_) { /* 忽略 */ }
      try { if (this._fl) this._fl._flDrag = null; } catch (_) { /* 忽略 */ }
      try { if (this._flRoot) this._flRoot.remove(); } catch (_) { /* 忽略 */ }
      this._flSetup = false;
      return r;
    };
  }

  const extension = {
    name: 'Comfy.FreeLatent.Node',
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData && nodeData.name === NODE_NAME) hookPrototype(nodeType);
    },
    nodeCreated(node) { if (isFLNode(node)) setupNode(node); },
    loadedGraphNode(node) { if (isFLNode(node)) setupNode(node); },
    setup() {
      const nodes = (app.graph && app.graph._nodes) || [];
      nodes.forEach((n) => { if (isFLNode(n)) setupNode(n); });
      hookGraphClear();
    }
  };

  function isFLNode(node) {
    return !!(node && (
      node.type === NODE_NAME ||
      node.comfyClass === NODE_NAME ||
      (node.constructor && node.constructor.comfyClass === NODE_NAME) ||
      (node.constructor && node.constructor.nodeData && node.constructor.nodeData.name === NODE_NAME)
    ));
  }

  app.registerExtension(extension);
})();
