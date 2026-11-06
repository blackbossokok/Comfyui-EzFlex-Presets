// 模块：循环轮次选择弹窗
// 共享：选择循环卡片参与哪些轮次（1-based）。默认全选；支持全选/反选/清空、Ctrl 加选、Shift 连选。
import { ezT } from "./ezflex_i18n.js";
import { ezPushModal, ezPopModal } from "./ezflex_service.js";

export function ezPickLoopIndices(opts) {
  const max = Math.max(1, parseInt(opts && opts.max, 10) || 1);
  const all = Array.from({ length: max }, (_, i) => i + 1);
  const init = opts && Array.isArray(opts.selected) ? opts.selected : all;
  const selected = new Set(init.map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= max));
  let follow = !!(opts && opts.follow);
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:100080;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);";
    const box = document.createElement("div");
    box.style.cssText = "width:420px;max-width:94vw;max-height:80vh;display:flex;flex-direction:column;background:var(--ez-bg);border:1px solid var(--ez-border);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.28);font-family:Inter,sans-serif;color:var(--ez-fg);overflow:hidden;";
    const hd = document.createElement("div");
    hd.style.cssText = "padding:12px 16px;border-bottom:1px solid var(--ez-border-2);font-size:13px;font-weight:600;";
    hd.textContent = (opts && opts.title) || ezT("Loop rounds");
    const tools = document.createElement("div");
    tools.style.cssText = "display:flex;gap:6px;padding:8px 16px;border-bottom:1px solid var(--ez-border-2);";
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px;padding:12px 16px;overflow:auto;";
    const ft = document.createElement("div");
    ft.style.cssText = "display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--ez-border-2);";
    const mkBtn = (txt, cls) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = txt;
      b.style.cssText = "height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--ez-border);background:var(--ez-surface-2);color:var(--ez-fg);font:inherit;font-size:11px;cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent;" + (cls || "");
      return b;
    };
    const sync = () => {
      grid.querySelectorAll("button[data-n]").forEach((x) => {
        const on = follow || selected.has(parseInt(x.dataset.n, 10));
        x.classList.toggle("on", on);
        x.setAttribute("aria-pressed", on ? "true" : "false");
        x.disabled = follow;
        x.style.opacity = follow ? "0.65" : "1";
        x.style.background = on ? "var(--ez-ok-bg)" : "var(--ez-surface-2)";
        x.style.borderColor = on ? "var(--ez-ok-border)" : "var(--ez-border)";
        x.style.color = on ? "var(--ez-ok-fg)" : "var(--ez-fg)";
      });
      if (followBtn) {
        followBtn.textContent = follow ? ezT("Following TimePlan") : ezT("Follow TimePlan");
        followBtn.style.background = follow ? "var(--ez-ok-bg)" : "var(--ez-surface-2)";
        followBtn.style.borderColor = follow ? "var(--ez-ok-border)" : "var(--ez-border)";
        followBtn.style.color = follow ? "var(--ez-ok-fg)" : "var(--ez-fg)";
      }
    };
    let followBtn = null;
    const addTool = (txt, fn) => { const b = mkBtn(txt); b.addEventListener("click", fn); tools.appendChild(b); return b; };
    addTool(ezT("Select all"), () => { follow = false; all.forEach((n) => selected.add(n)); sync(); });
    addTool(ezT("Invert"), () => { follow = false; all.forEach((n) => { if (selected.has(n)) selected.delete(n); else selected.add(n); }); sync(); });
    addTool(ezT("Clear"), () => { follow = false; selected.clear(); sync(); });
    followBtn = addTool(ezT("Follow TimePlan"), () => { follow = !follow; sync(); });
    followBtn.style.marginLeft = "auto";
    let anchor = 0;
    all.forEach((n) => {
      const b = document.createElement("button");
      b.type = "button"; b.dataset.n = String(n); b.textContent = "#" + n;
      b.style.cssText = "height:34px;border:1px solid var(--ez-border);border-radius:8px;background:var(--ez-surface-2);color:var(--ez-fg);font:inherit;font-size:12px;font-weight:600;cursor:pointer;user-select:none;outline:none;box-shadow:none;-webkit-tap-highlight-color:transparent;transition:background .12s,border-color .12s,color .12s;";
      b.className = selected.has(n) ? "on" : "";
      if (selected.has(n)) { b.style.background = "var(--ez-ok-bg)"; b.style.borderColor = "var(--ez-ok-border)"; b.style.color = "var(--ez-ok-fg)"; }
      // 用 mousedown 阻止 Shift 时的焦点/文字定位；click 仍然正常触发。
      b.addEventListener("mousedown", (e) => { if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault(); });
      b.addEventListener("click", (e) => {
        e.preventDefault();
        const want = !selected.has(n);
        if (e.shiftKey && anchor) {
          const a = Math.min(anchor, n), z = Math.max(anchor, n);
          for (let i = a; i <= z; i++) { if (want) selected.add(i); else selected.delete(i); }
        } else {
          if (want) selected.add(n); else selected.delete(n);
        }
        anchor = n;
        sync();
      });
      grid.appendChild(b);
    });
    sync();
    const cancel = mkBtn(ezT("Cancel")); cancel.addEventListener("click", () => close(null));
    const save = mkBtn(ezT("Save"), ";background:var(--ez-strong);border-color:var(--ez-strong);color:var(--ez-on-strong);");
    save.addEventListener("click", () => close({ indices: Array.from(selected).sort((a, b) => a - b), follow }));
    // 点弹窗外（含画布）自动保存，不丢当前勾选。
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) { e.preventDefault(); close({ indices: Array.from(selected).sort((a, b) => a - b), follow }); } });
    ft.appendChild(cancel); ft.appendChild(save);
    box.appendChild(hd); box.appendChild(tools); box.appendChild(grid); box.appendChild(ft); ov.appendChild(box); document.body.appendChild(ov);
    const token = ezPushModal({});
    // 捕获阶段先吃掉 Esc：否则同一次按键会继续传给下层的弹窗（把底层弹窗也关掉）
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(null); } };
    document.addEventListener("keydown", onKey, true);
    function close(val) {
      document.removeEventListener("keydown", onKey, true);
      try { ezPopModal(token); } catch (_) {}
      ov.remove(); resolve(val);
    }
  });
}
