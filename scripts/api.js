// 测试桩：最小 api 对象，避免 .mjs 测试因为缺少 ComfyUI 运行时直接 import 失败。
export const api = {
  fetchApi: async () => ({ ok: true, json: async () => ({}) }),
  addEventListener() {}, removeEventListener() {}, apiURL: (p) => p,
};
export default api;
