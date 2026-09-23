// EzFlex 主题：全套面板共用一套配色变量（--ez-*），换主题只改根元素的 data-ez-theme。
// 面板 CSS 只写 var(--ez-...)，颜色数据集中在这里；改配色不用动面板。
// 每套给一整套「层次」：五级表面（面板/卡片/控件/悬停/选中）+ 三级描边 + 四级文字 + 强调/状态色；
// 层次由该套自己的中性色推出来（见 fromPalette），所以部件之间分得开、不会糊成一体色。
const THEME_KEY = 'ezflex.theme';

// 藕荷 / 青苔：Radix Colors 的 mauve / sage 色阶（1..12 档职责固定）
const RADIX = {
  mauve: { light: ['#fdfcfd', '#faf9fb', '#f2eff3', '#eae7ec', '#e3dfe6', '#dbd8e0', '#d0cdd7', '#bcbac7', '#8e8c99', '#84828e', '#65636d', '#211f26'], dark: ['#121113', '#1a191b', '#232225', '#2b292d', '#323035', '#3c393f', '#49474e', '#625f69', '#6f6d78', '#7c7a85', '#b5b2bc', '#eeeef0'] },
  sage: { light: ['#fbfdfc', '#f7f9f8', '#eef1f0', '#e6e9e8', '#dfe2e0', '#d7dad9', '#cbcfcd', '#b8bcba', '#868e8b', '#7c8481', '#5f6563', '#1a211e'], dark: ['#101211', '#171918', '#202221', '#272a29', '#2e3130', '#373b39', '#444947', '#5b625f', '#63706b', '#717d79', '#adb5b2', '#eceeed'] },
};
const SOLID = {
  violet: { light: '#6e56cf', dark: '#6e56cf' },
  grass: { light: '#46a758', dark: '#46a758' },
  green: { light: '#30a46c', dark: '#30a46c' },
  blue: { light: '#0090ff', dark: '#0090ff' },
  red: { light: '#e5484d', dark: '#e5484d' },
  amber: { light: '#ffc53d', dark: '#ffc53d' },
};

// 由色阶拼一套主题（中性 + 该色系暗色阶，强调色取同色系实心档）
function fromRadix(id, label, fam, mode, accentFam) {
  return { id: id, label: label, ramp: RADIX[fam][mode], accent: SOLID[accentFam][mode], onStrong: '#ffffff',
    ok: SOLID.green[mode], bad: SOLID.red[mode], warn: SOLID.amber[mode], info: SOLID.blue[mode] };
}

// 由「背景 / 卡片 / 控件底 / 描边 / 主文字 / 次文字 / 主色 / 悬停 / 浅主色 + 状态色」这套最小配色推全五级
function fromPalette(id, label, p) {
  const ramp = [
    p.bg,                              // 1 面板底
    p.surface,                         // 2 卡片
    p.surface2,                        // 3 控件底
    mix(p.surface2, p.border, 0.55),   // 4 悬停
    mix(p.border, p.text, 0.06),       // 5 选中
    p.border,                          // 6 柔和描边
    mix(p.border, p.text, 0.12),       // 7 描边
    mix(p.border, p.text, 0.32),       // 8 强描边
    mix(p.textSec, p.primary, 0.5),    // 9
    p.textSec,                         // 10 次级文字
    mix(p.textSec, p.text, 0.5),       // 11
    p.text,                            // 12 主文字
  ];
  // 主按钮文字：白 / 主文字 / 底色里挑对比最高的一个（浅色主题多半是白，深色主题是底色）
  let onStrong = '#ffffff', best = contrast(p.primary, onStrong);
  [p.text, p.bg].forEach((c) => { const r = contrast(p.primary, c); if (r > best) { best = r; onStrong = c; } });
  return { id: id, label: label, ramp: ramp, accent: p.primary, strong: p.primary, strongHover: p.primaryHover,
    soft: p.primarySoft, onStrong: onStrong,
    ok: p.ok, bad: p.bad, warn: p.warn, info: p.info };
}

const CLASSIC = [
  { id: 'light', label: 'Light', strong: '#1a1a2e', onStrong: '#ffffff',
    ramp: ['#ffffff','#fbfcfe','#f7f9fd','#f1f4fa','#eef2f8','#dce3ec','#cdd6e0','#b7c1cf','#8a9aa8','#aab2c0','#5f6b7a','#1a1f2b'],
    accent: '#6b6bff', ok: '#16a34a', bad: '#dc2626', warn: '#d97706', info: '#2563eb' },
  { id: 'nord', label: 'Nord', accent: '#88c0d0', onStrong: '#2e3440',
    ramp: ['#2e3440','#353b48','#3b4252','#434c5e','#4c566a','#4c566a','#5e6a82','#767f96','#8b95a9','#a3adc0','#d8dee9','#eceff4'],
    ok: '#a3be8c', bad: '#bf616a', warn: '#ebcb8b', info: '#81a1c1' },
];

const USER = [
  fromPalette('minimal', 'Minimal', { bg: '#F7F8FA', surface: '#FFFFFF', surface2: '#F0F2F5', border: '#E4E7EC', text: '#111827', textSec: '#667085', primary: '#2563EB', primaryHover: '#1D4ED8', primarySoft: '#EFF6FF', ok: '#16A34A', warn: '#D97706', bad: '#DC2626', info: '#0EA5E9' }),
  fromPalette('caramel', 'Caramel', { bg: '#FAF9F7', surface: '#FFFFFF', surface2: '#F2EFEA', border: '#E6E1D8', text: '#1C1B19', textSec: '#6B655E', primary: '#B86B3D', primaryHover: '#9A552E', primarySoft: '#F7EDE6', ok: '#16A34A', warn: '#D97706', bad: '#DC2626', info: '#0EA5E9' }),
  fromPalette('mistblue', 'Mist Blue', { bg: '#F5F7F9', surface: '#FFFFFF', surface2: '#EBEFF3', border: '#DDE3E9', text: '#101418', textSec: '#5C6672', primary: '#4A6D8C', primaryHover: '#3A5873', primarySoft: '#EAF0F5', ok: '#16A34A', warn: '#D97706', bad: '#DC2626', info: '#0EA5E9' }),
  fromPalette('deepspace', 'Deep Space', { bg: '#0A0C0F', surface: '#12161B', surface2: '#1A2027', border: '#26303A', text: '#F2F5F7', textSec: '#98A6B3', primary: '#2DD4BF', primaryHover: '#14B8A6', primarySoft: '#CCFBF1', ok: '#4ADE80', warn: '#FBBF24', bad: '#F87171', info: '#38BDF8' }),
  fromPalette('morandi', 'Morandi', { bg: '#F6F5F8', surface: '#FFFFFF', surface2: '#EEEBF2', border: '#E1DDE8', text: '#1D1B22', textSec: '#6E6878', primary: '#7C6F9F', primaryHover: '#665A85', primarySoft: '#F0EDF6', ok: '#16A34A', warn: '#D97706', bad: '#DC2626', info: '#0EA5E9' }),
  fromPalette('mermaid', 'Mermaid', { bg: '#F0F7FA', surface: '#FFFFFF', surface2: '#E0F0F5', border: '#C8E0E8', text: '#0B1C2C', textSec: '#4A6D7C', primary: '#5BA8B8', primaryHover: '#4A8F9E', primarySoft: '#D6EEF5', ok: '#16A34A', warn: '#D97706', bad: '#DC2626', info: '#7FA3BF' }),
  fromPalette('chocolate', 'Chocolate', { bg: '#F7F3EE', surface: '#FFFFFF', surface2: '#EFE8DF', border: '#DDD2C4', text: '#2C1F14', textSec: '#7A6654', primary: '#6B4C3B', primaryHover: '#543B2D', primarySoft: '#EDE4DA', ok: '#16A34A', warn: '#D97706', bad: '#DC2626', info: '#0EA5E9' }),
  fromPalette('klein', 'Klein Blue', { bg: '#F5F6FA', surface: '#FFFFFF', surface2: '#EAECF5', border: '#D8DCEB', text: '#0A0E1F', textSec: '#5A6180', primary: '#1500E1', primaryHover: '#1100B8', primarySoft: '#E8E6FF', ok: '#16A34A', warn: '#D97706', bad: '#DC2626', info: '#0EA5E9' }),
  fromPalette('cloud', 'Cloud', { bg: '#F0EEE9', surface: '#FAF9F6', surface2: '#E8E5DE', border: '#DAD6CD', text: '#2A2723', textSec: '#706B62', primary: '#8C8579', primaryHover: '#736C61', primarySoft: '#E5E1D8', ok: '#16A34A', warn: '#D97706', bad: '#DC2626', info: '#0EA5E9' }),
  fromPalette('banana', 'Banana', { bg: '#FFFDF5', surface: '#FFFFFF', surface2: '#FFF8E1', border: '#F0E6C0', text: '#1F1A0A', textSec: '#7A6E4A', primary: '#D4A020', primaryHover: '#B88A18', primarySoft: '#FFF4D6', ok: '#16A34A', warn: '#D97706', bad: '#DC2626', info: '#0EA5E9' }),
  fromPalette('burgundy', 'Burgundy', { bg: '#F8F4F2', surface: '#FFFFFF', surface2: '#F0E4E0', border: '#E0CCC6', text: '#2A0F0A', textSec: '#7A5048', primary: '#8B1A2B', primaryHover: '#6E1422', primarySoft: '#F5E0E2', ok: '#16A34A', warn: '#D97706', bad: '#DC2626', info: '#0EA5E9' }),
  fromPalette('deepteal', 'Deep Teal', { bg: '#F0F5F4', surface: '#FFFFFF', surface2: '#E0EDEB', border: '#C5DAD6', text: '#0A1C1A', textSec: '#4A6E68', primary: '#1C4D4D', primaryHover: '#143A3A', primarySoft: '#D6E8E6', ok: '#16A34A', warn: '#D97706', bad: '#DC2626', info: '#0EA5E9' }),
];

const RADIX_THEMES = [
  fromRadix('lilac', 'Lilac', 'mauve', 'light', 'violet'),
  fromRadix('sage', 'Sage', 'sage', 'light', 'grass'),
];
// 顺序：浅色放第一个（默认），颜色相近的挨着放（中性 -> 蓝 -> 紫 -> 暖色 -> 绿青 -> 暗色）
const ORDER = ['light', 'cloud', 'mistblue', 'minimal', 'klein', 'lilac', 'morandi',
  'burgundy', 'caramel', 'chocolate', 'banana', 'sage', 'mermaid', 'deepteal', 'deepspace', 'nord'];
const BY_ID = {};
RADIX_THEMES.concat(CLASSIC, USER).forEach((t) => { BY_ID[t.id] = t; });
const THEMES = ORDER.map((id) => BY_ID[id]);

// ===== 颜色工具 =====
function toRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function toHex(rgb) { return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function mix(a, b, t) {   // t = b 的占比
  const x = toRgb(a), y = toRgb(b);
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t));
}
function lum(hex) {
  const v = toRgb(hex).map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
// 把色往黑或白推，直到在底色上够清楚（色相基本不动）
function readable(color, bg, target) {
  const pole = lum(bg) > 0.4 ? '#000000' : '#ffffff';
  let out = color;
  for (let i = 0; i < 24 && contrast(out, bg) < target; i++) out = mix(out, pole, 0.08);
  return out;
}
// 下拉箭头跟着主题走（stroke 用当前主题的次级文字色）
function arrowUrl(color) {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M1 1l4 4 4-4' stroke='" + color + "' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>";
  return 'url("data:image/svg+xml,' + encodeURIComponent(svg).replace(/%20/g, ' ') + '")';
}

// 主题数据 -> 全套变量
function tokens(t) {
  const n = t.ramp;
  const strong = t.strong || t.accent;
  const o = {
    '--ez-bg': n[0],
    '--ez-surface': n[1],
    '--ez-surface-2': n[2],
    '--ez-surface-3': n[3],
    '--ez-surface-4': n[4],
    '--ez-strong': readable(t.strong || t.accent, t.onStrong, 4.5),
    '--ez-strong-hover': t.strongHover || mix(strong, n[0], 0.2),
    '--ez-border': n[5],
    '--ez-border-2': n[3],
    '--ez-border-strong': n[7],
    '--ez-scheme': lum(n[0]) < 0.45 ? 'dark' : 'light',
    // 文字色按最亮/最暗那级表面兜底，任何一级表面上都读得出来
    '--ez-fg': readable(n[11], n[4], 4.5),
    '--ez-fg-2': readable(mix(n[11], n[10], 0.45), n[4], 4.2),
    '--ez-fg-3': readable(n[10], n[4], 3.2),
    '--ez-fg-muted': readable(mix(n[10], n[0], 0.28), n[4], 2.9),
    '--ez-on-strong': t.onStrong,
  };
  [['ok', t.ok], ['bad', t.bad], ['warn', t.warn], ['accent', t.accent], ['info', t.info]].forEach(([k, c]) => {
    // 作者给的浅主色只在它本来就贴近底色时采用（深色主题给的浅色软底离底色太远，会把强调文字压暗）
    const soft = (k === 'accent' && t.soft && contrast(t.soft, n[0]) < 1.6) ? t.soft : mix(n[0], c, 0.16);
    o['--ez-' + k] = readable(c, t.onStrong, 3.2);   // 实心色块要压得住 on-strong 上的文字
    o['--ez-' + k + '-bg'] = soft;
    o['--ez-' + k + '-border'] = mix(n[0], c, 0.45);
    o['--ez-' + k + '-fg'] = readable(c, soft, 4.5);
  });
  o['--ez-arrow'] = arrowUrl(n[10]);
  return o;
}

// 面板里的原生控件兜底：文字跟主题走 + color-scheme 让浏览器原生下拉/滚动条也对上明暗。
// 用 :where() 把优先级压到 0，面板自己的规则一定盖得住，只补没写颜色的控件。
const BASE =
  ':where([class^="eph-"],[class*=" eph-"],[class^="eml-"],[class*=" eml-"],[class^="emoo-"],[class*=" emoo-"],[class^="ezc-"],[class*=" ezc-"],[class^="ezg-"],[class*=" ezg-"],[class^="ezm-"],[class*=" ezm-"],[class^="ezo-"],[class*=" ezo-"],[class^="ezpc-"],[class*=" ezpc-"],[class^="ezpv-"],[class*=" ezpv-"],[class^="ezfx-"],[class*=" ezfx-"],[class^="fl-"],[class*=" fl-"],[class^="mc-"],[class*=" mc-"]){color-scheme:var(--ez-scheme);}' +
  '\n' + ':where([class^="eph-"],[class*=" eph-"],[class^="eml-"],[class*=" eml-"],[class^="emoo-"],[class*=" emoo-"],[class^="ezc-"],[class*=" ezc-"],[class^="ezg-"],[class*=" ezg-"],[class^="ezm-"],[class*=" ezm-"],[class^="ezo-"],[class*=" ezo-"],[class^="ezpc-"],[class*=" ezpc-"],[class^="ezpv-"],[class*=" ezpv-"],[class^="ezfx-"],[class*=" ezfx-"],[class^="fl-"],[class*=" fl-"],[class^="mc-"],[class*=" mc-"]) :where(input,select,textarea){color:var(--ez-fg);}' +
  '\n' + ':where([class^="eph-"],[class*=" eph-"],[class^="eml-"],[class*=" eml-"],[class^="emoo-"],[class*=" emoo-"],[class^="ezc-"],[class*=" ezc-"],[class^="ezg-"],[class*=" ezg-"],[class^="ezm-"],[class*=" ezm-"],[class^="ezo-"],[class*=" ezo-"],[class^="ezpc-"],[class*=" ezpc-"],[class^="ezpv-"],[class*=" ezpv-"],[class^="ezfx-"],[class*=" ezfx-"],[class^="fl-"],[class*=" fl-"],[class^="mc-"],[class*=" mc-"]) :where(input,select,textarea)::placeholder{color:var(--ez-fg-muted);}';

// ===== 应用 =====
let _style = null;
let _theme = null;
let _inited = false;
const _hooks = new Set();

export function ezThemeList() { return THEMES.map((t) => ({ id: t.id, label: t.label })); }

export function ezTheme() {
  if (!_theme) {
    let v = null;
    try { v = window.localStorage.getItem(THEME_KEY); } catch (_) {}
    _theme = THEMES.some((t) => t.id === v) ? v : 'light';
  }
  return _theme;
}

export function ezThemeSet(id) {
  _theme = THEMES.some((t) => t.id === id) ? id : 'light';
  try { window.localStorage.setItem(THEME_KEY, _theme); } catch (_) {}
  try { document.documentElement.setAttribute('data-ez-theme', _theme); } catch (_) {}
  _hooks.forEach((fn) => { try { fn(_theme); } catch (_) {} });
  try { window.dispatchEvent(new CustomEvent('ezflex:theme', { detail: { theme: _theme } })); } catch (_) {}
}

function css() {
  const at = (sel, vars) => sel + '{' + Object.keys(vars).map((k) => k + ':' + vars[k] + ';').join('') + '}';
  return at(':root', tokens(THEMES[0])) + '\n' + THEMES.map((t) => at(':root[data-ez-theme="' + t.id + '"]', tokens(t))).join('\n') + '\n' + BASE;
}

// 每个面板注入自己的样式前调一次：把主题变量挂上（只挂一次，最先加载的面板负责）
export function ezThemeInit() {
  if (_inited || !document.head) return;   // head 还没就绪就下次再说
  _inited = true;
  _style = document.createElement('style');
  _style.textContent = css();
  document.head.appendChild(_style);
  ezThemeSet(ezTheme());
}

export function onThemeChange(fn) { if (typeof fn === 'function') _hooks.add(fn); }

// 2D canvas / Three.js 这类要「实际颜色值」的地方用（它们吃不了 CSS 变量）
export function ezThemeColor(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ez-' + name).trim();
    if (v) return v;
  } catch (_) {}
  return fallback || '#000000';
}

// 同上，但要半透明的时候用（canvas 没有透明度继承，必须给 rgba）
export function ezThemeAlpha(name, alpha, fallback) {
  const hex = ezThemeColor(name, fallback);
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + alpha + ')';
}
