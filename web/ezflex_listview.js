// EzFlex 通用「媒体列表预览」弹窗：MediaLoader 式外壳（固定尺寸），PreviewAny 的列表视窗与
// TimeLine 的素材库弹窗共用同一份实现（以前三处各写一遍）。壳负责：遮罩 / 标题 / 计数 / 关闭 /
// 主区 / 底部缩略图条 + 悬停左右箭头 / ←→Esc（document 捕获阶段，不带动画布）/ 弹窗栈。
// 调用方只给 items + 渲染回调，媒体怎么画由回调或 ezMediaItemEl 决定。
import { ezT } from "./ezflex_i18n.js";
import { ezPushModal, ezPopModal, ezIsTopModal, makeAudioPlayer } from "./ezflex_service.js";
import { ezThemeInit } from "./ezflex_theme.js";

const CSS = `
.ezl-pv{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:9997;background:rgba(10,14,20,.55);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);}
.ezl-box{background:var(--ez-bg);border-radius:18px;padding:14px;width:92%;max-width:960px;height:min(88vh,780px);display:flex;flex-direction:column;gap:10px;font-family:Inter,system-ui,sans-serif;box-sizing:border-box;box-shadow:0 30px 90px rgba(0,0,0,.4);overflow:hidden;}
.ezl-hd{display:flex;align-items:center;gap:10px;flex:0 0 auto;}
.ezl-title{font-size:14px;font-weight:600;color:var(--ez-fg);flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ezl-cnt{font-size:12px;color:var(--ez-fg-3);flex:0 0 auto;font-variant-numeric:tabular-nums;}
.ezl-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;}
.ezl-x{background:var(--ez-surface-3);border:1px solid var(--ez-border);border-radius:10px;width:28px;height:28px;font-size:13px;cursor:pointer;color:var(--ez-fg-3);flex:0 0 auto;font-family:inherit;}
.ezl-main{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:var(--ez-surface-2);border-radius:12px;overflow:hidden;padding:12px;box-sizing:border-box;}
.ezl-main > img,.ezl-main > video{max-width:100%;max-height:100%;border-radius:8px;display:block;background:#000;}
.ezl-main > audio{width:100%;max-width:560px;}
.ezl-arrow{position:absolute;top:0;bottom:0;width:48px;display:flex;align-items:center;justify-content:center;opacity:0;transition:.15s;z-index:5;pointer-events:none;}
.ezl-arrow.l{left:0;} .ezl-arrow.r{right:0;}
.ezl-arrow .hit{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--ez-fg-2);background:var(--ez-surface);box-shadow:0 2px 12px rgba(0,0,0,.18);cursor:pointer;pointer-events:auto;user-select:none;}
.ezl-stripwrap{flex:0 0 auto;display:flex;align-items:center;gap:6px;}
.ezl-strip{flex:1 1 auto;display:flex;gap:6px;overflow-x:auto;padding:6px 2px;}
.ezl-strip::-webkit-scrollbar{height:8px;}
.ezl-strip::-webkit-scrollbar-thumb{background:var(--ez-border-strong);border-radius:4px;}
.ezl-thumb{position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;background:var(--ez-surface-3);display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--ez-fg-muted);cursor:pointer;flex:0 0 auto;border:2px solid transparent;box-sizing:border-box;}
.ezl-thumb img{width:100%;height:100%;object-fit:cover;display:block;}
.ezl-thumb.on{border-color:var(--ez-strong);}
.ezl-thumb svg{width:22px;height:22px;}
.ezl-ft{font-size:11px;color:var(--ez-fg-3);flex:0 0 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ezl-text{white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--ez-fg);max-width:70vw;max-height:100%;overflow:auto;text-align:left;font-family:ui-monospace,Menlo,Consolas,monospace;}
`;

let _css = false;
function injectCss() {
  ezThemeInit();
  if (_css || !document.head) return;
  _css = true;
  const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
}
function el(tag, cls, attrs) { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); return e; }
function chev(side) {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + (side === 'L' ? '<path d="M15 5l-7 7 7 7"/>' : '<path d="M9 5l7 7-7 7"/>') + '</svg>';
}

// 通用媒体项渲染：{ kind, url, name, text }
// 图 → <img>；视频 → <video controls>；音频 → 播放器；文本 → 文本；3D → 图标 + 「Open 3D viewer」按钮；其它 url 当文本读。
export function ezMediaItemEl(it, onOpen3D) {
  const kind = String((it && it.kind) || 'other');
  const url = (it && it.url) || '';
  if (kind === 'image' && url) { const im = el('img'); im.src = url; im.alt = (it && it.name) || ''; return im; }
  if (kind === 'video' && url) { const v = el('video'); v.controls = true; v.src = url; return v; }
  if (kind === 'audio' && url) { const ap = makeAudioPlayer(url); ap.style.cssText = 'width:100%;'; return ap; }
  if (kind === 'model_3d') {
    const wrap = el('div'); wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;';
    const ic = el('div'); ic.textContent = '🧊'; ic.style.cssText = 'font-size:40px;line-height:1;color:var(--ez-fg-muted);'; wrap.appendChild(ic);
    if (onOpen3D) {
      const b = el('button', null, { type: 'button' }); b.textContent = ezT('Open 3D viewer');
      b.style.cssText = 'background:var(--ez-strong);border:1px solid var(--ez-strong);color:var(--ez-on-strong);border-radius:9px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;';
      b.addEventListener('click', () => { try { onOpen3D(it); } catch (_) {} });
      wrap.appendChild(b);
    }
    return wrap;
  }
  const tx = el('div', 'ezl-text');
  if (it && it.text != null) tx.textContent = it.text;
  else if (url) {
    tx.textContent = ezT('Loading…');
    fetch(url).then((r) => r.text()).then((t) => { if (tx.isConnected) tx.textContent = (t || ezT('(empty file)')).slice(0, 60000); }).catch(() => { if (tx.isConnected) tx.textContent = ezT('Cannot preview content'); });
  } else tx.textContent = (it && it.name) || '';
  return tx;
}

// 打开列表预览。opts: title / items / index / renderItem(it,api) / thumb(it,i,api) / footer(it) /
// actions(api) / onPick(it,i,api) / onOpen3D(it) / onClose()
// 返回句柄 { close, redraw, index, items, setIndex(i), setItems(list) }
export function openEzListPreview(opts) {
  injectCss();
  const items = Array.isArray(opts.items) ? opts.items.slice() : [];
  let idx = Math.max(0, Math.min(items.length - 1, parseInt(opts.index, 10) || 0));
  const ov = el('div', 'ezl-pv');
  const box = el('div', 'ezl-box');
  const hd = el('div', 'ezl-hd');
  const tt = el('b', 'ezl-title'); tt.textContent = opts.title || ezT('Media'); hd.appendChild(tt);
  const cnt = el('span', 'ezl-cnt'); hd.appendChild(cnt);
  const act = el('div', 'ezl-actions'); hd.appendChild(act);
  const x = el('button', 'ezl-x', { type: 'button' }); x.textContent = '✕'; x.title = ezT('Close'); hd.appendChild(x);
  const main = el('div', 'ezl-main');
  const foot = el('div', 'ezl-ft');
  const swrap = el('div', 'ezl-stripwrap');
  const strip = el('div', 'ezl-strip'); swrap.appendChild(strip);
  box.appendChild(hd); box.appendChild(main); box.appendChild(swrap); box.appendChild(foot);
  ov.appendChild(box); document.body.appendChild(ov);
  const tok = ezPushModal({});
  let aL = null, aR = null;
  const draw = () => {
    const it = items[idx];
    cnt.textContent = items.length ? ((idx + 1) + ' / ' + items.length) : '0 / 0';
    main.querySelectorAll('.ezl-item').forEach((e) => e.remove());
    if (it !== undefined) {
      let item = null;
      try { item = opts.renderItem ? opts.renderItem(it, api) : null; } catch (_) { item = null; }
      if (!item) item = ezMediaItemEl(it, opts.onOpen3D);
      item.classList.add('ezl-item');
      main.insertBefore(item, aL);
    }
    Array.from(strip.children).forEach((c, i) => c.classList.toggle('on', i === idx));
    if (opts.footer) { try { foot.textContent = opts.footer(it) || ''; } catch (_) { foot.textContent = ''; } }
    const cur = strip.children[idx];
    if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (_) {} }
  };
  const go = (d) => { if (items.length < 2) return; idx = (idx + d + items.length) % items.length; draw(); };
  const mkArrow = (side) => {
    const a = el('div', 'ezl-arrow ' + (side === 'L' ? 'l' : 'r'));
    const hit = el('span', 'hit'); hit.innerHTML = chev(side);
    hit.addEventListener('click', () => go(side === 'L' ? -1 : 1));
    a.appendChild(hit); main.appendChild(a); return a;
  };
  aL = mkArrow('L'); aR = mkArrow('R');
  main.addEventListener('mouseenter', () => { aL.style.opacity = '1'; aR.style.opacity = '1'; });
  main.addEventListener('mouseleave', () => { aL.style.opacity = '0'; aR.style.opacity = '0'; });
  const buildStrip = () => {
    strip.innerHTML = '';
    items.forEach((it, i) => {
      let th = null;
      try { th = opts.thumb ? opts.thumb(it, i, api) : null; } catch (_) { th = null; }
      if (!th) th = el('div');
      if (!(th.className || '').split(/\s+/).includes('ezl-thumb')) th.classList.add('ezl-thumb');
      if (!th.childNodes || !th.childNodes.length) {
        if (it && it.kind === 'image' && it.url) { const im = el('img'); im.src = it.url; im.loading = 'lazy'; th.appendChild(im); }
        else th.textContent = ({ image: '🖼', video: '🎬', audio: '🎵', model_3d: '🧊' })[String((it && it.kind) || '')] || '📄';
      }
      th.title = (it && (it.name || it.caption)) || '';
      th.addEventListener('click', () => {
        if (opts.onPick && opts.onPick(it, i, api) === true) return;
        idx = i; draw();
      });
      strip.appendChild(th);
    });
  };
  if (opts.actions) { try { const a = opts.actions(api); if (a) act.appendChild(a); } catch (_) {} }
  const close = () => {
    try { main.querySelectorAll('video,audio').forEach((m) => { try { m.pause(); } catch (_) {} }); } catch (_) {}
    try { ov.remove(); } catch (_) {}
    document.removeEventListener('keydown', onKey, true);
    if (tok) ezPopModal(tok);
    if (opts.onClose) { try { opts.onClose(); } catch (_) {} }
  };
  const onKey = (e) => {
    if (!ov.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
    if (!ezIsTopModal(tok)) return;   // 上面还有弹窗时不动
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); go(1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  };
  const api = {
    index: () => idx,
    items: () => items,
    redraw: () => draw(),
    setIndex: (i) => { idx = Math.max(0, Math.min(items.length - 1, i | 0)); draw(); },
    setItems: (list) => { items.length = 0; (list || []).forEach((v) => items.push(v)); idx = Math.min(idx, Math.max(0, items.length - 1)); buildStrip(); draw(); },
    close: () => close(),
  };
  x.addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  // 缩略图条：竖向滚轮 → 横向前后滚（与 MediaLoader 预览弹窗同款）。共享壳没进 ezflex_service 的
  // _SCROLL_CLASSES（那是面板专用），Vue 的全局滚轮也只在外壳矩形内生效、管不到弹窗 → 两种模式都靠这条显式绑定。
  strip.addEventListener('wheel', (e) => { e.preventDefault(); strip.scrollLeft += (e.deltaY || e.deltaX); }, { passive: false });
  document.addEventListener('keydown', onKey, true);   // 捕获阶段：先于画布的方向键处理
  buildStrip(); draw();
  return api;
}
