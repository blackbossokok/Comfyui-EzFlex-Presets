export const app = {
  graph: null, canvas: null, ui: { settings: {} }, extensionManager: null,
  _exts: [],
  registerExtension(ext) { if (ext && ext.name) app._exts.push(String(ext.name)); return ext; },
  get extensions() { return app._exts; },
};
export const ComfyApp = app;
export default app;