// EzFlex-PreviewAny 任意预览节点（V1.3 简化版）。
// 输入为固定 input_1..N ANY 槽；前端按「已连接 + 1 空槽」自动展示卡片（连一个自动加一个）。
// 卡片可拖拽排序，卡片顺序即 socket 顺序；顶部为「存档开关 + 保存位置」，卡片带文件夹图标打开已保存文件。
// 参考 AUNPassthroughAnyMulti（onExecuted entries + 固定 ANY 输入槽）。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ezT, onLocaleChange } from "./ezflex_i18n.js";
import {
  NODE_TYPES, registerNode, unregisterNode, nodeTypeOf,
  configWidget, writeConfig, readConfig, installResizeHandles, makeDomWidgetHitThrough,
} from "./ezflex_service.js";

const NODE = NODE_TYPES.PREVIEW_ANY;
const MAX_CARDS = 16;

const CSS = `
.ezpv-shell{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;pointer-events:none;overflow:hidden;}
.ezpv-shell .ezpv-root{pointer-events:auto;}
.ezpv-root{position:absolute;inset:0 14px 14px 14px;font-family:Inter,sans-serif;color:#1a1a2e;background:#fff;border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;user-select:none;-webkit-user-select:none;min-width:0;min-height:0;overflow:hidden;}
.ezpv-root *{user-select:none;-webkit-user-select:none;box-sizing:border-box;}
.ezpv-hd{display:flex;gap:6px;align-items:center;flex-wrap:nowrap;min-width:0;} /* 顶部工具栏单行不换行 */
.ezpv-btn{background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:4px 11px;font-size:11px;font-weight:480;color:#1f2937;font-family:inherit;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;height:30px;line-height:1;}
.ezpv-btn:hover{background:#edf2fa;}
.ezpv-save.on{background:#ecfdf3;border-color:#a7f0c6;color:#065f46;}
.ezpv-save.on:hover{background:#d1fae5;}
.ezpv-save.off{background:#f6f8fc;border-color:#e2e8f0;color:#8492a6;}
.ezpv-save .ezpv-auto{font-size:8px;line-height:1;margin-left:2px;}
.ezpv-fs{width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;border-radius:0!important;margin:0!important;left:0!important;top:0!important;transform:none!important;}
.ezpv-loc{background:#1a1a2e;color:#fff;border-color:#1a1a2e;}
.ezpv-loc:hover{background:#2b3a4a;}
.ezpv-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;}
.ezpv-card{display:flex;align-items:center;gap:8px;background:#fbfcfe;border:1px solid #eef2f8;border-radius:10px;padding:6px 8px;flex-wrap:nowrap;}
.ezpv-card.dragging{opacity:.4;}
.ezpv-handle{cursor:grab;color:#8a99ae;font-size:14px;line-height:1.6;padding:0 2px;}
.ezpv-handle:hover{color:#1a1a2e;}
.ezpv-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;}
.ezpv-crow{display:flex;align-items:center;gap:6px;}
.ezpv-cname{font-size:12px;font-weight:500;color:#1a1f2b;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ezpv-badge{font-size:9px;font-weight:480;color:#fff;background:#5f6b7a;padding:0 7px;border-radius:100px;line-height:16px;white-space:nowrap;}
.ezpv-fldr{background:transparent;border:none;color:#b7c1cf;font-size:15px;line-height:1;cursor:pointer;padding:1px 3px;flex:0 0 auto;}
.ezpv-fldr:hover{color:#5f6b7a;}
.ezpv-prev{background:#f3f6fc;border:1px solid #e6edf7;border-radius:8px;padding:5px 8px;font-size:11px;color:#3a4a5e;font-family:monospace;line-height:1.4;white-space:pre-wrap;word-break:break-all;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;cursor:pointer;pointer-events:auto;min-height:30px;}
.ezpv-prev.long{cursor:pointer;}
.ezpv-prev.img{position:relative;display:flex;align-items:center;justify-content:center;padding:4px;background:#1f2933;cursor:pointer;}
.ezpv-prev.img img{max-width:100%;max-height:120px;border-radius:6px;display:block;}
.ezpv-prev.img .ezpv-badge{position:absolute;top:5px;right:5px;}
.ezpv-prev.img .ezpv-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:30px;height:30px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center;padding-left:2px;}
.ezpv-prev .ph{color:#8a99ae;font-family:Inter,sans-serif;font-style:italic;}
.ezpv-empty{color:#8a9aa8;font-size:12px;text-align:center;padding:14px;}
.ezpv-ph{height:0;border-top:3px solid #2b3a4a;border-radius:2px;margin:1px 0;opacity:.9;box-shadow:0 1px 6px rgba(43,58,74,.35);}
.ezpv-ph.hidden{display:none;}
.ezpv-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:9999;background:rgba(0,0,0,.35);}
.ezpv-modal.active{display:flex;}
.ezpv-modal-box{background:#fff;border-radius:16px;padding:14px 16px;width:92%;max-width:560px;max-height:84vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.2);font-family:Inter,sans-serif;}
.ezpv-modal-hd{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f4fc;padding-bottom:8px;}
.ezpv-modal-hd b{font-size:13px;color:#0f141f;}
.ezpv-modal-box textarea{width:100%;min-height:180px;max-height:60vh;padding:8px;border:1px solid #dce3ec;border-radius:9px;font:11px/1.5 monospace;color:#1a1f2b;background:#fff;resize:both;overflow:auto;box-sizing:border-box;outline:none;}
.ezpv-kv{display:flex;flex-direction:column;gap:4px;overflow:auto;max-height:60vh;border:1px solid #e6edf7;border-radius:9px;padding:6px;}
.ezpv-kv-row{display:flex;gap:8px;font:11px/1.5 monospace;border-bottom:1px solid #f0f4fc;padding:3px 4px;}
.ezpv-kv-k{flex:0 0 45%;color:#5f6b7a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all;}
.ezpv-kv-v{flex:1 1 auto;color:#1a1f2b;word-break:break-all;white-space:pre-wrap;}
.ezpv-fpath{font:11px/1.5 monospace;color:#3a4a5e;background:#f6f8fc;border:1px solid #e6edf7;border-radius:8px;padding:6px 8px;word-break:break-all;}
.ezpv-fdirs{display:flex;flex-direction:column;gap:4px;overflow:auto;max-height:240px;}
.ezpv-fdirs button{text-align:left;background:#fbfcfe;border:1px solid #eef2f8;border-radius:8px;padding:5px 10px;font-size:12px;color:#1a1f2b;cursor:pointer;font-family:inherit;}
.ezpv-fdirs button:hover{background:#edf2fa;}
.ezpv-media{position:fixed;z-index:9998;background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);padding:12px;display:none;left:50%;top:50%;transform:translate(-50%,-50%);max-width:82vw;max-height:82vh;overflow:auto;pointer-events:auto;}
.ezpv-media.active{display:block;}
.ezpv-media-body{display:flex;flex-direction:column;gap:8px;justify-content:center;align-items:center;}
.ezpv-media.ezpv-fs .ezpv-media-body{height:100%;justify-content:center;}
.ezpv-media img{max-width:min(70vw,720px);max-height:70vh;border-radius:8px;display:block;}
.ezpv-media.ezpv-fs img{width:auto;height:auto;max-width:100vw;max-height:100vh;object-fit:contain;cursor:grab;border-radius:0;transform-origin:center;}
.ezpv-media.ezpv-fs video{width:100vw;height:100vh;object-fit:cover;max-width:none!important;max-height:none!important;}
.ezpv-media-meta{font:11px/1.5 monospace;color:#1a1f2b;background:#f6f8fc;border:1px solid #e6edf7;border-radius:8px;padding:10px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:0;}
.ezpv-media .cap{font-size:12px;color:#1a1f2b;padding:0 4px;}
`;

let _styleInjected = false;
function injectStyle() { if (_styleInjected || !document.head) return; _styleInjected = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
const fetchApi = (p, o) => (api && typeof api.fetchApi === 'function') ? api.fetchApi(p, o) : fetch(p, o);
// 关闭后恢复窗口级 keydown 监听回退
let _escStack = [];
// 为弹窗加「全屏」按钮：全屏时仅 ESC / 右上角 X 退出；X 平时隐藏、靠近显示
function attachFullscreen(host, closeFn, onExit) {
  let fs = false;
  const doExit = () => { if (onExit) { try { onExit(); } catch (_) {} } };
  const btn = document.createElement('button');
  btn.textContent = '⛶'; btn.title = ezT('Fullscreen');
  btn.style.cssText = 'position:absolute;bottom:6px;right:6px;z-index:8;width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:#f7f9fd;border:1px solid #dce3ec;border-radius:8px;color:#5f6b7a;cursor:pointer;font-size:12px;';
  host.appendChild(btn);
  btn.addEventListener('click', (e) => { e.stopPropagation(); fs = !fs; host.classList.toggle('ezpv-fs', fs); if (!fs) doExit(); });
  const key = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (fs) { fs = false; host.classList.remove('ezpv-fs'); doExit(); }
      else { doExit(); closeFn(); }
    }
  };
  window.addEventListener('keydown', key);
  _escStack.push(() => window.removeEventListener('keydown', key));
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
  if (!node._ezPrev) node._ezPrev = { save: false, savePath: '', saveFormats: {}, entries: [] };
  return node._ezPrev;
}
function loadFromConfig(node) {
  const st = stateFor(node);
  const cfg = readConfig(node, {});
  st.save = !!cfg.save;
  st.savePath = typeof cfg.savePath === 'string' ? cfg.savePath : '';
  st.saveFormats = (cfg.saveFormats && typeof cfg.saveFormats === 'object') ? cfg.saveFormats : {};
  st.dirty = false;
}
function syncToConfig(node) {
  const st = stateFor(node);
  writeConfig(node, { save: st.save, savePath: st.savePath, saveFormats: st.saveFormats });
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
      if (_in && _in.name === 'config') { try { node.inputs.splice(i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } }
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
  node.inputs.forEach((i, idx) => { try { i.name = `input_${idx + 1}`; i.label = ''; i.hideName = true; i.hidden = false; } catch (_) {} });

  // ---- 输出：与已连接卡片 1:1，且跟着对应卡片走（处理中间断开后卡片的输出仍跟卡） ----
  // 由“链接卡片的原输入下标”回溯它配对的输出 socket，按卡片顺序重组；未配对的旧输出用 removeOutput 连 line 一起清掉。
  const cardOutputs = linkedInputs.map((inp) => origOutputs[origInputs.indexOf(inp)]).filter(Boolean);
  const newOuts = cardOutputs.slice(0, conn);
  const wantOut = new Set(newOuts);
  for (let i = node.outputs.length - 1; i >= 0; i--) {
    if (!wantOut.has(node.outputs[i])) { node.removeOutput(i); if (node.graph) node.graph.setDirtyCanvas(true, true); }
  }
  if (node.outputs.length !== newOuts.length || node.outputs.some((o, idx) => o !== newOuts[idx])) {
    node.outputs.splice(0, node.outputs.length, ...newOuts);
    if (node.graph) node.graph.setDirtyCanvas(true, true);
  }
  while (node.outputs.length < conn) { node.addOutput(`output_${node.outputs.length + 1}`, '*'); if (node.graph) node.graph.setDirtyCanvas(true, true); }
  node.outputs.forEach((o, idx) => { try { o.name = `output_${idx + 1}`; o.label = ''; o.hideName = true; o.hidden = false; } catch (_) {} });

  // ---- 回写 slot（链路已就绪，链接对象在）----
  node.inputs.forEach((i, idx) => { if (i.link != null && node.graph && node.graph.links && node.graph.links[i.link]) { try { node.graph.links[i.link].target_slot = idx; } catch (_) {} } });
  node.outputs.forEach((o, idx) => {
    const ids = [];
    if (Array.isArray(o.links)) ids.push(...o.links);
    if (o.link != null) ids.push(o.link);
    ids.forEach((lid) => { if (lid != null && node.graph && node.graph.links && node.graph.links[lid]) { try { node.graph.links[lid].origin_slot = idx; } catch (_) {} } });
  });

  if (node.graph) node.graph.setDirtyCanvas(true, true);
  syncOutputTypes(conn);
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
  box.style.cssText = 'background:#fff;border-radius:12px;padding:12px 14px;width:92%;max-width:640px;max-height:84vh;display:flex;flex-direction:column;gap:10px;border:1px solid #eef2f8;box-shadow:0 12px 40px rgba(0,0,0,.14);font-family:Inter,sans-serif;box-sizing:border-box;';
  const hd = document.createElement('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f4fc;padding-bottom:8px;';
  const title = document.createElement('b'); title.textContent = ezT('Preview');
  const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = 'background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit;';
  hd.appendChild(title); hd.appendChild(close);
  const ta = document.createElement('textarea'); ta.readOnly = true; ta.spellcheck = false;
  ta.style.cssText = 'width:100%;min-height:180px;max-height:60vh;padding:8px;border:1px solid #dce3ec;border-radius:9px;font:11px/1.5 monospace;color:#1a1f2b;background:#fbfcfe;resize:none;overflow:auto;box-sizing:border-box;outline:none;';
  box.appendChild(hd); box.appendChild(ta);
  _modal.appendChild(box); document.body.appendChild(_modal);
  _modal._ta = ta; _modal._title = title;
  close.addEventListener('click', () => { _modal.style.display = 'none'; });
  attachFullscreen(box, () => { _modal.style.display = 'none'; });
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
  box.style.cssText = 'background:#fff;border-radius:12px;padding:12px 14px;width:92%;max-width:600px;max-height:84vh;display:flex;flex-direction:column;gap:10px;border:1px solid #eef2f8;box-shadow:0 12px 40px rgba(0,0,0,.14);font-family:Inter,sans-serif;box-sizing:border-box;';
  const hd = document.createElement('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f4fc;padding-bottom:8px;';
  const title = document.createElement('b'); title.textContent = ezT('Details');
  const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = 'background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit;';
  hd.appendChild(title); hd.appendChild(close);
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:4px;overflow:auto;max-height:60vh;border:1px solid #e6edf7;border-radius:9px;padding:6px;';
  box.appendChild(hd); box.appendChild(list);
  _kv.appendChild(box); document.body.appendChild(_kv);
  _kv._title = title; _kv._list = list;
  close.addEventListener('click', () => { _kv.style.display = 'none'; });
  attachFullscreen(box, () => { _kv.style.display = 'none'; });
  bindOutsideClose(box, () => { _kv.style.display = 'none'; });
  return _kv;
}
const _META_HINTS = {
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
    row.style.cssText = 'display:flex;gap:6px;align-items:center;font:11px/1.5 monospace;border-bottom:1px solid #f0f4fc;padding:3px 6px;padding-left:' + (4 + depth * 16) + 'px;cursor:default;';
    if (node && typeof node === 'object') {
      const toggle = document.createElement('span'); toggle.textContent = '▸'; toggle.style.cssText = 'cursor:pointer;width:14px;text-align:center;color:#5f6b7a;flex:0 0 auto;';
      const kk = document.createElement('span');
      kk.textContent = (key === null ? '' : String(key)) + (Array.isArray(node) ? ' [' + node.length + ']' : ' {' + Object.keys(node).length + '}');
      kk.title = hintKey(key) || String(key);
      kk.style.cssText = 'flex:0 0 45%;color:#5f6b7a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all;';
      row.appendChild(toggle); row.appendChild(kk);
      const children = document.createElement('div'); children.style.display = 'none';
      const toggleFn = (e) => { e.stopPropagation(); const open = toggle.textContent === '▸'; toggle.textContent = open ? '▾' : '▸'; children.style.display = open ? 'block' : 'none'; if (open && !children.childElementCount) { const list = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node); list.forEach(([k, v]) => children.appendChild(renderNode(v, k, depth + 1))); } };
      toggle.addEventListener('click', toggleFn);
      row.addEventListener('click', toggleFn);
      wrap.appendChild(row); wrap.appendChild(children);
    } else {
      const kk = document.createElement('span'); kk.textContent = String(key); kk.title = hintKey(key) || String(key);
      kk.style.cssText = 'flex:0 0 45%;color:#5f6b7a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all;';
      const vv = document.createElement('span'); vv.textContent = (value === null ? 'null' : (value === undefined ? '' : String(value)));
      vv.style.cssText = 'flex:1 1 auto;color:#1a1f2b;word-break:break-all;white-space:pre-wrap;';
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
  m.style.display = 'flex';
}
function mediaEl() {
  if (_media && _media.parentNode) return _media;
  _media = el('div', 'ezpv-media');
  const body = el('div', 'ezpv-media-body');
  const img = el('img'); img.style.display = 'none';
  const video = document.createElement('video'); video.controls = true; video.style.display = 'none'; video.style.width = '100%'; video.style.maxWidth = '720px';
  const audio = document.createElement('audio'); audio.controls = true; audio.style.display = 'none'; audio.style.width = '100%';
  const meta = document.createElement('pre'); meta.className = 'ezpv-media-meta'; meta.style.display = 'none';
  const cap = el('div', 'cap');
  body.appendChild(video); body.appendChild(img); body.appendChild(audio); body.appendChild(meta); body.appendChild(cap);
  const closeBtn = document.createElement('button'); closeBtn.textContent = '✕'; closeBtn.title = ezT('Close');
  closeBtn.style.cssText = 'position:absolute;top:8px;right:8px;background:#f7f9fd;border:1px solid #dce3ec;border-radius:8px;padding:2px 9px;font-size:12px;cursor:pointer;font-family:inherit;z-index:2;';
  _media.appendChild(closeBtn);
  _media.appendChild(body); _media._img = img; _media._audio = audio; _media._meta = meta; _media._cap = cap; _media._video = video;
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
  const closeMedia = () => { pauseMedia(); resetZoom(); _media.classList.remove('active'); };
  closeBtn.addEventListener('click', closeMedia);
  attachFullscreen(_media, closeMedia, pauseMedia);
  bindOutsideClose(_media, () => { if (_media.classList.contains('active')) closeMedia(); });
  return _media;
}
function openMediaPreview(payload) {
  const m = mediaEl();
  m._img.style.display = 'none'; m._audio.style.display = 'none'; m._meta.style.display = 'none'; m._video.style.display = 'none';
  try { m._audio.pause(); } catch (_) {}
  try { m._video.pause(); } catch (_) {}
  if (payload.video || payload.video_src) { m._video.src = payload.video || payload.video_src; if (payload.poster) m._video.poster = payload.poster; m._video.style.display = 'block'; } // 不自动播放
  if (payload.image_src) { m._img.src = payload.image_src; m._img.style.display = 'block'; }
  else if (payload.image) { m._img.src = payload.image; m._img.style.display = 'block'; }
  if (payload.audio_src) { m._audio.src = payload.audio_src; m._audio.style.display = 'block'; }
  else if (payload.audio) { m._audio.src = payload.audio; m._audio.style.display = 'block'; } // 不自动播放，交给用户点 play
  if (payload.meta) { m._meta.textContent = payload.meta; m._meta.style.display = 'block'; }
  m._cap.textContent = payload.caption || '';
  if (m._resetZoom) m._resetZoom();
  m.classList.add('active');
}

function ext3d(url) {
  try {
    const u = new URL(url, location.href);
    const p = u.searchParams.get('path') || u.searchParams.get('filename') || u.pathname;
    const m = String(p).toLowerCase().match(/\.(gltf|glb|obj|fbx)$/);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}
let _threeModal = null;
function open3DViewer(url, title) {
  if (_threeModal && _threeModal.parentNode) _threeModal.remove();
  const THREE_BASE = '/preview_any/3d/libs/';
  _threeModal = document.createElement('div');
  _threeModal.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99999;background:rgba(10,14,20,.55);backdrop-filter:blur(2px);';
  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:18px;padding:14px;width:96%;max-width:1040px;height:88vh;display:flex;flex-direction:column;gap:12px;font-family:Inter,system-ui,sans-serif;box-sizing:border-box;box-shadow:0 30px 90px rgba(0,0,0,.4);overflow:hidden;';
  const hd = document.createElement('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;flex:0 0 auto;';
  const t = document.createElement('b'); t.style.cssText = 'font-size:14px;color:#0f141f;'; t.textContent = title || ezT('3D Model');
  const close = document.createElement('button'); close.textContent = '✕'; close.title = ezT('Close'); close.style.cssText = 'background:#f1f5f9;border:1px solid #dce3ec;border-radius:10px;width:28px;height:28px;font-size:13px;cursor:pointer;color:#64748b;';
  hd.appendChild(t); hd.appendChild(close);

  // 主体：左画布 + 右控制面板
  const body = document.createElement('div'); body.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;gap:12px;';
  const wrapEl = document.createElement('div'); wrapEl.style.cssText = 'flex:1 1 auto;min-width:0;position:relative;border-radius:14px;overflow:hidden;background:#f7f9fd;border:1px solid #e6edf7;';
  const canvas = document.createElement('canvas'); canvas.tabIndex = 0; canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;outline:none;touch-action:none;cursor:grab;';
  wrapEl.appendChild(canvas);
  const fsBtn = document.createElement('button'); fsBtn.textContent = '⛶'; fsBtn.title = ezT('Fullscreen / Exit fullscreen'); fsBtn.style.cssText = 'position:absolute;right:10px;bottom:10px;z-index:8;width:34px;height:34px;border:none;border-radius:10px;background:rgba(255,255,255,.92);color:#64748b;font-size:16px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15);';
  wrapEl.appendChild(fsBtn);

  // 右侧控制面板
  const ctrl = document.createElement('div'); ctrl.style.cssText = 'flex:0 0 250px;width:250px;overflow-y:auto;background:#f8fafc;border:1px solid #e6edf7;border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:10px;font-size:12px;color:#334155;';
  function grp(label, input) {
    const g = document.createElement('label'); g.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const s = document.createElement('span'); s.style.cssText = 'font-size:11px;font-weight:600;color:#64748b;'; s.textContent = label; g.appendChild(s); g.appendChild(input); return g;
  }
  const bgInput = document.createElement('input'); bgInput.type = 'color'; bgInput.value = '#f7f9fd'; bgInput.style.cssText = 'width:100%;height:26px;border:1px solid #dce3ec;border-radius:8px;padding:2px;background:#fff;cursor:pointer;';
  const matSel = document.createElement('select'); matSel.style.cssText = 'width:100%;font-size:12px;padding:5px 8px;border:1px solid #dce3ec;border-radius:8px;background:#fff;cursor:pointer;';
  [['original', ezT('Original')], ['clay', ezT('Clay')], ['glass', ezT('Glass')], ['plastic', ezT('Plastic')], ['metal', ezT('Metal')], ['wireframe', ezT('Wireframe')]].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === 'original') o.selected = true; matSel.appendChild(o); });
  const gridChk = document.createElement('input'); gridChk.type = 'checkbox'; gridChk.checked = true; gridChk.style.cssText = 'width:16px;height:16px;';
  const matColor = document.createElement('input'); matColor.type = 'color'; matColor.value = '#ffffff'; matColor.style.cssText = 'width:100%;height:26px;border:1px solid #dce3ec;border-radius:8px;padding:2px;background:#fff;cursor:pointer;';
  function slider(label, min, max, val, step) {
    const g = document.createElement('label'); g.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
    const s = document.createElement('span'); s.style.cssText = 'font-size:11px;font-weight:600;color:#64748b;'; s.textContent = label;
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const r = document.createElement('input'); r.type = 'range'; r.min = String(min); r.max = String(max); r.value = String(val); r.step = String(step || '0.01'); r.style.cssText = 'flex:1 1 auto;';
    const num = document.createElement('span'); num.style.cssText = 'font-size:10px;color:#64748b;width:34px;text-align:right;'; num.textContent = String(val);
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
    b.style.cssText = 'flex:1 1 0;background:#eef2f7;border:1px solid #dce3ec;border-radius:8px;padding:6px;font-size:12px;cursor:pointer;color:#334155;';
    b.dataset.mode = v; gizmoBtns[v] = b; gizmoBtnsWrap.appendChild(b);
  });
  const camSel = document.createElement('select'); camSel.style.cssText = 'width:100%;font-size:12px;padding:5px 8px;border:1px solid #dce3ec;border-radius:8px;background:#fff;cursor:pointer;';
  [['perspective', ezT('Perspective')], ['orthographic', ezT('Orthographic')]].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; camSel.appendChild(o); });
  const fovRange = document.createElement('input'); fovRange.type = 'range'; fovRange.min = '10'; fovRange.max = '120'; fovRange.value = '45'; fovRange.style.cssText = 'width:100%;';
  const fovNum = document.createElement('span'); fovNum.style.cssText = 'font-size:11px;color:#64748b;'; fovNum.textContent = '45°';
  const lightRange = document.createElement('input'); lightRange.type = 'range'; lightRange.min = '0'; lightRange.max = '3'; lightRange.step = '0.1'; lightRange.value = '0.9'; lightRange.style.cssText = 'width:100%;';
  const lightNum = document.createElement('span'); lightNum.style.cssText = 'font-size:11px;color:#64748b;'; lightNum.textContent = '0.9';
  const lightColor = document.createElement('input'); lightColor.type = 'color'; lightColor.value = '#ffffff'; lightColor.style.cssText = 'width:100%;height:26px;border:1px solid #dce3ec;border-radius:8px;padding:2px;background:#fff;cursor:pointer;';
  const resetBtn = document.createElement('button'); resetBtn.textContent = ezT('Reset view'); resetBtn.style.cssText = 'width:100%;background:#fff;border:1px solid #dce3ec;border-radius:9px;padding:7px;font-size:12px;cursor:pointer;color:#334155;';

  ctrl.appendChild(grp(ezT('Background'), bgInput));
  ctrl.appendChild(grp(ezT('Preset material'), matSel));
  const matResetBtn = document.createElement('button'); matResetBtn.textContent = ezT('Reset material'); matResetBtn.style.cssText = 'width:100%;background:#fff;border:1px solid #dce3ec;border-radius:9px;padding:7px;font-size:12px;cursor:pointer;color:#334155;';
  ctrl.appendChild(matResetBtn);
  // 材质参数（可收起）：颜色/滑块只对彩色预设（陶土/玻璃/塑料/金属）生效，原始/线框忽略颜色
  const det = document.createElement('details'); det.style.cssText = 'border:1px solid #e6edf7;border-radius:9px;padding:8px;background:#fff;';
  const sum = document.createElement('summary'); sum.textContent = ezT('Material parameters'); sum.style.cssText = 'cursor:pointer;font-size:12px;font-weight:600;color:#334155;';
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
  const toolLabel = document.createElement('span'); toolLabel.style.cssText = 'font-size:11px;font-weight:600;color:#64748b;'; toolLabel.textContent = ezT('Transform tool (drag model)');
  toolGrp.appendChild(toolLabel); toolGrp.appendChild(gizmoBtnsWrap);
  ctrl.appendChild(toolGrp);
  ctrl.appendChild(grp(ezT('Camera'), camSel));
  const fovGrp = grp(ezT('Field of view'), fovRange); fovGrp.appendChild(fovNum); ctrl.appendChild(fovGrp);
  const lightGrp = grp(ezT('Light intensity'), lightRange); lightGrp.appendChild(lightNum); ctrl.appendChild(lightGrp);
  ctrl.appendChild(grp(ezT('Light color'), lightColor));
  ctrl.appendChild(resetBtn);
  const resetModelBtn = document.createElement('button'); resetModelBtn.textContent = ezT('Reset model'); resetModelBtn.style.cssText = 'width:100%;background:#fff;border:1px solid #dce3ec;border-radius:9px;padding:7px;font-size:12px;cursor:pointer;color:#334155;';
  ctrl.appendChild(resetModelBtn);

  const status = document.createElement('div'); status.style.cssText = 'font-size:12px;color:#64748b;text-align:center;min-height:18px;line-height:1.4;word-break:break-word;';
  status.textContent = ezT('Loading 3D model…');
  const tip = document.createElement('div'); tip.style.cssText = 'font-size:11px;color:#94a3b8;';
  tip.textContent = ezT('Left drag = orbit · Shift/Right drag = pan · Wheel = zoom');

  body.appendChild(wrapEl); body.appendChild(ctrl);
  box.appendChild(hd); box.appendChild(body); box.appendChild(status); box.appendChild(tip);
  _threeModal.appendChild(box);
  document.body.appendChild(_threeModal);

  let _raf = 0, _listeners = [];
  const cleanup = () => {
    if (_raf) cancelAnimationFrame(_raf);
    _listeners.forEach((fn) => { try { fn(); } catch (_) {} });
    _listeners = [];
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
      } else {
        // 只随包带了 GLTF / FBX / OBJ 三个加载器：别的扩展名以前会落到 OBJLoader 里报一堆难懂的错误
        throw new Error(`${ezT('Unsupported 3D format .')}${ext || '?'}${ezT(' (only glb / gltf / obj / fbx are supported)')}`);
      }
      // 让加载器把相对贴图/缓冲 URL 解析到源文件所在目录（外部贴图由此能加载）
      loader.resourcePath = url.slice(0, url.lastIndexOf('/') + 1);
      try {
        const lm = new THREE.LoadingManager();
        lm.onError = (u) => { try { console.log('[3D texture/resource load failed]', u); } catch (_) {} };
        lm.onStart = (u, n, t) => { try { console.log('[3D loading resource]', u); } catch (_) {} };
        loader.manager = lm;
      } catch (_) {}

      loader.load(url,
        (obj) => {
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
              gizmoBtns[k].style.background = (k === t) ? '#dbeafe' : '#eef2f7';
              gizmoBtns[k].style.borderColor = (k === t) ? '#93c5fd' : '#dce3ec';
              gizmoBtns[k].style.color = (k === t) ? '#1d4ed8' : '#334155';
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

          const loop = () => { _raf = requestAnimationFrame(loop); const c = activeCam(); placeCam(c); renderer.render(scene, c); };
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

function renderPreview(entry) {
  if (!entry) {
    const box = el('div', 'ezpv-prev'); return box;
  }
  const val = entry.value || '';
  const full = entry.full_value || val;
  const type = (entry.type || '').toUpperCase();
  if (entry.audio || entry.audio_src) {
    const box = el('div', 'ezpv-prev'); const ph = el('span', 'ph'); ph.textContent = val || ezT('Audio'); box.appendChild(ph);
    box.title = ezT('Click to play audio');
    box.addEventListener('click', (e) => { e.stopPropagation(); openMediaPreview({ audio: entry.audio, audio_src: entry.audio_src, caption: (entry.caption || '') + '  ' + val }); });
    return box;
  }
  if (entry.video || entry.video_src) {
    const box = el('div', 'ezpv-prev img');
    const img = el('img'); if (entry.preview) img.src = 'data:image/png;base64,' + entry.preview; img.alt = val;
    box.appendChild(img);
    const play = el('span', 'ezpv-play'); play.textContent = '▶'; box.appendChild(play);
    if (entry.frames > 1) { const b = el('span', 'ezpv-badge'); b.textContent = entry.frames + ezT(' frames'); box.appendChild(b); }
    box.addEventListener('click', (e) => { e.stopPropagation(); openMediaPreview({ video: entry.video, video_src: entry.video_src, poster: entry.preview ? ('data:image/png;base64,' + entry.preview) : null, caption: (entry.caption || '') + '  ' + val }); });
    return box;
  }
  if (entry.preview) {
    const box = el('div', 'ezpv-prev img');
    box.style.position = 'relative';
    const img = el('img'); img.src = 'data:image/png;base64,' + entry.preview; img.alt = val;
    box.appendChild(img);
    if (entry.frames > 1) { const b = el('span', 'ezpv-badge'); b.textContent = entry.frames + ezT(' frames'); box.appendChild(b); }
    if (entry.gen_meta) {
      const g = el('span', 'ezpv-gen'); g.textContent = ezT('Generation info');
      g.style.cssText = 'position:absolute;top:4px;right:4px;z-index:5;background:rgba(255,255,255,.92);border:1px solid #dce3ec;border-radius:7px;padding:1px 7px;font-size:10px;cursor:pointer;color:#2563eb;box-shadow:0 1px 3px rgba(0,0,0,.12);';
      g.addEventListener('click', (e) => { e.stopPropagation(); try { openKeyValueModal((entry.caption || '') + ezT(' Generation info'), JSON.parse(entry.gen_meta)); } catch (_) { openTextModal((entry.caption || '') + ezT(' Generation info'), entry.gen_meta); } });
      box.appendChild(g);
    }
    box.addEventListener('click', (e) => { e.stopPropagation(); openMediaPreview({ image: img.src, image_src: entry.image_src, caption: (entry.caption || '') + '  ' + val, meta: entry.meta, frames: entry.frames, type }); });
    return box;
  }
  if (type === 'MODEL_3D' || type === 'FILE_3D' || type === 'MESH') {   // MESH：顶点/面张量已在后端导成临时 OBJ
    const box = el('div', 'ezpv-prev long');
    box.textContent = val;
    box.title = ezT('Click to open the 3D viewer (drag to rotate, wheel to zoom)');
    box.addEventListener('click', (e) => { e.stopPropagation(); if (entry.model3d) open3DViewer(entry.model3d, (entry.caption || '') + '  ' + val); });
    return box;
  }
  if (entry.meta || type === 'MODEL' || type === 'CLIP' || type === 'VAE') {
    const box = el('div', 'ezpv-prev long');
    box.textContent = val;
    box.title = ezT('Click to view details (metadata)');
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      const metaStr = entry.meta || full;
      if (typeof metaStr === 'string' && (metaStr.trim().startsWith('{') || metaStr.trim().startsWith('['))) {
        try { openKeyValueModal(entry.caption || ezT('Details'), JSON.parse(metaStr)); return; } catch (_) {}
      }
      openTextModal(entry.caption || ezT('Details'), typeof metaStr === 'string' ? metaStr : full);
    });
    return box;
  }
  if (val) {
    const box = el('div', 'ezpv-prev long');
    box.textContent = val;
    const isKV = type === 'DICT' || type === 'LIST' || type === 'TUPLE';
    box.title = isKV ? ezT('Click to view key-value details') : ezT('Click to view full content');
    box.addEventListener('click', (e) => { e.stopPropagation(); if (isKV) openKeyValueModal(entry.caption || ezT('Details'), full); else openTextModal(entry.caption || ezT('Preview'), full); });
    return box;
  }
  const box = el('div', 'ezpv-prev'); return box;
}

function renderEntries(node) {
  const st = stateFor(node);
  const root = node && node._ezRoot;
  if (!root) return;
  const list = root.querySelector('.ezpv-list');
  if (!list) return;
  const linked = (node.inputs || []).filter((i) => i.link != null);
  const conn = linked.length;
  list.innerHTML = '';
  if (!conn) { list.appendChild(el('div', 'ezpv-empty')).textContent = ezT('Drag a wire from an input port on the left to auto-create preview cards'); return; }
  for (let i = 0; i < conn; i++) list.appendChild(renderCard(node, i, (st.entries || [])[i]));
  attachDnD(list, '.ezpv-card', '.ezpv-handle', (from, to) => reorderCard(node, from, to));
  fitNode(node);
}

function renderCard(node, index, entry) {
  const row = el('div', 'ezpv-card');
  const handle = el('span', 'ezpv-handle'); handle.textContent = '⠿';
  const body = el('div', 'ezpv-body');
  const crow = el('div', 'ezpv-crow');
  const name = el('span', 'ezpv-cname'); name.textContent = (entry && entry.caption) || `${ezT('Input')} ${index + 1}`;
  const badge = el('span', 'ezpv-badge'); badge.textContent = (entry && entry.type) || 'ANY';
  const fldr = el('button', 'ezpv-fldr'); fldr.title = ezT('Open the save location and select the file');
  fldr.innerHTML = '<svg width="14" height="12" viewBox="0 0 24 20" fill="currentColor"><path d="M2 3h7l2 2h11v12H2z"/></svg>';
  fldr.addEventListener('click', () => { if (entry && entry.saved_path) openSavedFile(entry.saved_path); });
  crow.appendChild(name); crow.appendChild(badge); crow.appendChild(fldr);
  body.appendChild(crow);
  const prev = renderPreview(entry);
  if (prev) body.appendChild(prev);
  row.appendChild(handle); row.appendChild(body);
  return row;
}

// ===== 文件系统 =====
function openSavedFile(path) {
  fetchApi('/preview_any/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).catch(() => {});
}
function pickFolder(node) {
  fetchApi('/preview_any/pick_folder', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).then((r) => r.json()).then((data) => {
    if (data.ok && data.path) { const st = stateFor(node); st.savePath = data.path; syncToConfig(node); refreshUI(node); }
  }).catch(() => {});
}
let _fmtModal = null;
function formatModalEl() {
  if (_fmtModal && _fmtModal.parentNode) return _fmtModal;
  _fmtModal = document.createElement('div');
  _fmtModal.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:99999;background:rgba(0,0,0,.35);';
  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:16px;padding:14px 16px;width:92%;max-width:420px;max-height:84vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.2);font-family:Inter,sans-serif;box-sizing:border-box;';
  const hd = document.createElement('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f4fc;padding-bottom:8px;';
  const title = document.createElement('b'); title.textContent = ezT('Save types');
  const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = 'background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit;';
  hd.appendChild(title); hd.appendChild(close);
  const fields = document.createElement('div'); fields.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow:auto;';
  const opts = { image: ['png', 'jpeg', 'webp', 'bmp', 'tiff'], audio: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac'], video: ['mp4', 'webm', 'mov', 'gif', 'avi', 'mkv'], text: ['txt', 'md', 'json', 'csv', 'log', 'html'] };
  const labels = { image: ezT('Image'), audio: ezT('Audio'), video: ezT('Video'), text: ezT('Text') };
  const subDefs = {
    image: [{ key: 'quality', label: ezT('Quality'), values: ['90', '95', '100'] }],
    audio: [{ key: 'codec', label: ezT('Encoder'), values: ['aac', 'mp3', 'flac', 'opus'] }, { key: 'bitrate', label: ezT('Bitrate'), values: ['128k', '192k', '320k'] }, { key: 'sr', label: ezT('Sample rate (Hz)'), values: ['44100', '48000', '22050'] }],
    video: [{ key: 'codec', label: ezT('Encoder'), values: ['h264', 'vp9', 'av1'] }, { key: 'crf', label: ezT('Quality CRF'), values: ['18', '23', '28'] }, { key: 'fps', label: ezT('Frame rate'), values: ['24', '30'] }],
    text: []
  };
  const selects = {}; const subSelects = {};
  Object.keys(opts).forEach((cat) => {
    const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;border:1px solid #eef2f8;border-radius:10px;padding:6px 8px;';
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const tog = document.createElement('span'); tog.textContent = '▸'; tog.style.cssText = 'cursor:pointer;width:14px;text-align:center;color:#5f6b7a;flex:0 0 auto;';
    const lab = document.createElement('span'); lab.textContent = labels[cat]; lab.style.cssText = 'flex:0 0 48px;font-size:12px;color:#1a1f2b;';
    const sel = document.createElement('select'); sel.style.cssText = 'flex:1 1 auto;appearance:none;background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:5px 10px;font-size:12px;font-family:inherit;';
    opts[cat].forEach((f) => { const o = document.createElement('option'); o.value = f; o.textContent = f; sel.appendChild(o); });
    row.appendChild(tog); row.appendChild(lab); row.appendChild(sel);
    wrap.appendChild(row);
    const sub = document.createElement('div'); sub.style.cssText = 'display:none;flex-direction:column;gap:6px;padding-left:18px;';
    (subDefs[cat] || []).forEach((sd) => {
      const srow = document.createElement('div'); srow.style.cssText = 'display:flex;align-items:center;gap:8px;';
      const sl = document.createElement('span'); sl.textContent = sd.label; sl.style.cssText = 'flex:0 0 62px;font-size:11px;color:#5f6b7a;';
      const ss = document.createElement('select'); ss.style.cssText = 'flex:1 1 auto;appearance:none;background:#f7f9fd;border:1px solid #dce3ec;border-radius:8px;padding:3px 8px;font-size:11px;font-family:inherit;';
      sd.values.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; ss.appendChild(o); });
      srow.appendChild(sl); srow.appendChild(ss); sub.appendChild(srow);
      subSelects[cat + '.' + sd.key] = ss;
    });
    wrap.appendChild(sub);
    tog.addEventListener('click', (e) => { e.stopPropagation(); const open = tog.textContent === '▸'; tog.textContent = open ? '▾' : '▸'; sub.style.display = open ? 'flex' : 'none'; });
    fields.appendChild(wrap);
    selects[cat] = sel;
  });
  const ft = document.createElement('div'); ft.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #f0f4fc;padding-top:10px;';
  const save = document.createElement('button'); save.textContent = ezT('OK'); save.style.cssText = 'background:#1a1a2e;color:#fff;border:1px solid #1a1a2e;border-radius:9px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit;';
  ft.appendChild(save);
  box.appendChild(hd); box.appendChild(fields); box.appendChild(ft);
  _fmtModal.appendChild(box); document.body.appendChild(_fmtModal);
  attachFullscreen(box, () => { _fmtModal.style.display = 'none'; });
  _fmtModal._selects = selects; _fmtModal._subSelects = subSelects; _fmtModal._subDefs = subDefs; _fmtModal._node = null;
  close.addEventListener('click', () => { _fmtModal.style.display = 'none'; });
  _fmtModal.addEventListener('click', (e) => { if (e.target === _fmtModal) _fmtModal.style.display = 'none'; });
  save.addEventListener('click', () => {
    if (!_fmtModal._node) return;
    const st = stateFor(_fmtModal._node);
    Object.keys(_fmtModal._selects).forEach((cat) => {
      const o = { fmt: _fmtModal._selects[cat].value };
      (_fmtModal._subDefs[cat] || []).forEach((sd) => { const ss = _fmtModal._subSelects[cat + '.' + sd.key]; if (ss) o[sd.key] = ss.value; });
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
    if (v && typeof v === 'object') { if (v.fmt) m._selects[cat].value = v.fmt; (m._subDefs[cat] || []).forEach((sd) => { const ss = m._subSelects[cat + '.' + sd.key]; if (ss && v[sd.key]) ss.value = v[sd.key]; }); }
    else if (typeof v === 'string') m._selects[cat].value = v;
  });
  m.style.display = 'flex';
}
let _dpModal = null;
function openDataPreviewModal() {
  if (_dpModal && _dpModal.parentNode) _dpModal.remove();
  _dpModal = document.createElement('div');
  _dpModal.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99999;background:rgba(15,20,31,.5);';
  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:16px;padding:14px 16px;width:94%;max-width:560px;max-height:84vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:Inter,sans-serif;box-sizing:border-box;';
  const hd = document.createElement('div'); hd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f4fc;padding-bottom:8px;';
  const t = document.createElement('b'); t.textContent = ezT('Data preview types / formats');
  const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = 'background:#f7f9fd;border:1px solid #dce3ec;border-radius:9px;padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit;';
  hd.appendChild(t); hd.appendChild(close);
  const rows = [
    ['IMAGE', ezT('PNG / JPEG / WebP / BMP / TIFF (zoom to view)')],
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
  rows.forEach(([k, v]) => { const r = document.createElement('div'); r.style.cssText = 'display:flex;gap:8px;font-size:12px;'; const kk = document.createElement('b'); kk.textContent = k; kk.style.cssText = 'flex:0 0 180px;color:#1a1f2b;'; const vv = document.createElement('span'); vv.textContent = v; vv.style.cssText = 'flex:1 1 auto;color:#5f6b7a;word-break:break-all;'; r.appendChild(kk); r.appendChild(vv); list.appendChild(r); });
  box.appendChild(hd); box.appendChild(list); _dpModal.appendChild(box); document.body.appendChild(_dpModal);
  attachFullscreen(box, () => { if (_dpModal) { _dpModal.remove(); _dpModal = null; } });
  close.addEventListener('click', () => { _dpModal.remove(); _dpModal = null; });
  _dpModal.addEventListener('click', (e) => { if (e.target === _dpModal) { _dpModal.remove(); _dpModal = null; } });
}

// ===== 渲染面板 =====
function buildRoot(node) {
  injectStyle();
  const shell = el('div', 'ezpv-shell');
  const root = el('div', 'ezpv-root');
  shell.appendChild(root);
  node._ezRoot = shell;
  const hd = el('div', 'ezpv-hd');
  const saveBtn = el('button', 'ezpv-btn ezpv-save');
  const locBtn = el('button', 'ezpv-btn ezpv-loc'); locBtn.textContent = ezT('Save location');
  const fmtBtn = el('button', 'ezpv-btn'); fmtBtn.textContent = ezT('Save options');
  const infoBtn = el('button', 'ezpv-btn'); infoBtn.textContent = ezT('Data preview');
  hd.appendChild(saveBtn); hd.appendChild(locBtn); hd.appendChild(fmtBtn); hd.appendChild(infoBtn);
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

function fitNode(node) {
  try {
    const root = node && node._ezRoot && node._ezRoot.querySelector('.ezpv-root');
    if (!root || typeof node.setSize !== 'function') return;
    const cur = node.size || [0, 96];
    const contentH = root.scrollHeight + 12;
    if (contentH > cur[1] + 4) node.setSize([Math.max(340, cur[0]), Math.min(560, contentH)]);
  } catch (_) {}
}
function refreshUI(node) {
  const root = node && node._ezRoot;
  if (!root) return;
  const saveBtn = root.querySelector('.ezpv-save');
  if (saveBtn) renderSaveBtn(saveBtn, stateFor(node).save);
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
  try { const _ins = node.inputs || []; for (let _i = _ins.length - 1; _i >= 0; _i--) { const _in = _ins[_i]; if (_in && (_in.name === 'config')) { try { node.inputs.splice(_i, 1); } catch (_) { try { _in.hidden = true; } catch (_) {} } } } } catch (_) {}

  const w = configWidget(node); if (!w || node._ezPrevCfgHid) return; node._ezPrevCfgHid = true;
  try {
    w.origComputeSize = w.computeSize; w.computeSize = () => [0, 0]; w.computedHeight = 0; w.y = 0; w.last_y = 0; w.width = 0;
    w.draw = () => {}; w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.options.getMinHeight = () => 0; w.options.getMaxHeight = () => 0;
    if (w.element && w.element.style) { w.element.style.display = 'none'; w.element.style.height = '0'; w.element.style.minHeight = '0'; w.element.style.maxHeight = '0'; }
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
    try { node.setSize([460, Math.max(150, node.size ? node.size[1] : 150)]); } catch (_) {}
    hideConfigWidget(node);
    syncSockets(node);
    refreshUI(node);
    setTimeout(() => { syncSockets(node); refreshUI(node); }, 80);
  } catch (e) { console.error('[PreviewAny] init failed:', e); }
}
function hookPrototype(nt) {
  if (!nt || nt.__ezPrevHooked) return; nt.__ezPrevHooked = true;
  const prevCreated = nt.prototype.onNodeCreated; nt.prototype.onNodeCreated = function () { const r = prevCreated ? prevCreated.apply(this, arguments) : undefined; setupNode(this); return r; };
  const prevCfg = nt.prototype.onConfigure; nt.prototype.onConfigure = function () { const r = prevCfg ? prevCfg.apply(this, arguments) : undefined; loadFromConfig(this); syncSockets(this); refreshUI(this); return r; };
  const prevConn = nt.prototype.onConnectionsChange; nt.prototype.onConnectionsChange = function (type, index, connected, link_info) {
    const r = prevConn ? prevConn.apply(this, arguments) : undefined;
    try { if (this._ezPrevSetup) { setTimeout(() => { syncSockets(this); refreshUI(this); }, 0); } } catch (_) {}
    return r;
  };
  const prevExec = nt.prototype.onExecuted; nt.prototype.onExecuted = function (message) {
    const r = prevExec ? prevExec.apply(this, arguments) : undefined;
    try { if (message && message.entries) { stateFor(this).entries = message.entries; renderEntries(this); } } catch (_) {}
    return r;
  };
  const prevRemoved = nt.prototype.onRemoved; nt.prototype.onRemoved = function () { const r = prevRemoved ? prevRemoved.apply(this, arguments) : undefined; unregisterNode(this); try { if (this._ezRoot) this._ezRoot.remove(); } catch (_) {} this._ezPrevSetup = false; return r; };
  const prevAdded = nt.prototype.onAdded; nt.prototype.onAdded = function () { const r = prevAdded ? prevAdded.apply(this, arguments) : undefined; registerNode(this); return r; };
}
// 语言切换后重画同类型节点的面板（ezT 在渲染时求值，重画即换语言）
onLocaleChange(() => {
  ((app && app.graph && app.graph._nodes) || []).forEach((n) => { if (n && n.type === NODE) { try { refreshUI(n); } catch (_) {} } });
});

app.registerExtension({
  name: 'Comfy.EzFlex.PreviewAny',
  async beforeRegisterNodeDef(nt, nd) { if (nd && nd.name === NODE) hookPrototype(nt); },
  nodeCreated(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  loadedGraphNode(n) { if (nodeTypeOf(n) === NODE) setupNode(n); },
  setup() { ((app.graph && app.graph._nodes) || []).forEach((n) => { if (nodeTypeOf(n) === NODE) setupNode(n); }); },
});
