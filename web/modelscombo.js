// ModelsCombo 前端扩展：把「模型组合配置器」页面挂进 ComfyUI 界面。
// 页面由本节点的 web/ 目录托管：/extensions/Comfyui-Modelscombo/modelscombo.html
import { app } from "../../scripts/app.js";

(function () {
  'use strict';

  // 用时间戳参数破除浏览器对 modelscombo.html 的缓存，确保每次打开都拿到最新版
  let pageUrl;
  try {
    pageUrl = new URL('modelscombo.html', import.meta.url).href;
  } catch (_) {
    const base = (app.api && app.api.api_base) || '';
    pageUrl = base + '/extensions/Comfyui-Modelscombo/modelscombo.html';
  }
  pageUrl += (pageUrl.includes('?') ? '&' : '?') + 't=' + Date.now();

  let overlay = null;

  function openConfigurator() {
    if (overlay && document.body.contains(overlay)) {
      overlay.remove();
      overlay = null;
      return;
    }
    overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:9999;background:rgba(12,12,12,0.55);' +
      'display:flex;align-items:center;justify-content:center;';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeConfigurator();
    });

    const box = document.createElement('div');
    box.style.cssText =
      'position:relative;width:min(1200px,96vw);height:min(900px,94vh);' +
      'background:#f5f2ed;border-radius:10px;overflow:hidden;' +
      'box-shadow:0 14px 44px rgba(0,0,0,0.4);';

    const iframe = document.createElement('iframe');
    iframe.src = pageUrl;
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
    iframe.allow = 'clipboard-write';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = '关闭';
    closeBtn.style.cssText =
      'position:absolute;top:8px;right:10px;z-index:10;width:28px;height:28px;' +
      'border:none;border-radius:50%;background:rgba(255,255,255,0.94);color:#1e1c1a;' +
      'font-size:15px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.25);';
    closeBtn.addEventListener('click', closeConfigurator);

    box.append(iframe, closeBtn);
    overlay.append(box);
    document.body.append(overlay);
  }

  function closeConfigurator() {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  const extension = {
    name: 'Comfy.ModelsCombo',
    commands: [
      {
        id: 'Comfy.ModelsCombo.OpenConfigurator',
        label: '打开模型组合配置器',
        icon: 'pi pi-objects-column',
        function: openConfigurator,
      },
    ],
    async setup() {
      const menu = document.querySelector('.comfy-menu');
      if (!menu) return;
      const button = document.createElement('button');
      button.textContent = '模型组合';
      button.title = '模型组合配置器（ModelsCombo）';
      button.style.cssText =
        'width:100%;margin:6px 0 0;padding:6px 8px;border:1px solid var(--border-color,#444);' +
        'border-radius:4px;background:var(--comfy-menu-bg,#1f1f1f);color:var(--fg-color,#ddd);' +
        'font-size:12px;cursor:pointer;text-align:left;';
      button.addEventListener('click', openConfigurator);
      menu.appendChild(button);
    },
  };

  app.registerExtension(extension);
})();
