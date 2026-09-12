"""EzFlex 插件套件：模型/分辨率/控制/参数预设节点

- EzFlex-ModelsCombo          模型组合加载器（checkpoint/unet/clip/vae + lora 串联）
- EzFlex-FreeLatent           分辨率/Latent 选择器（拖拽画布 + 预设）
- EzFlex-NodeSwitchGroup      分组预设：一组开关，按画布分组 颜色/标题正则 匹配并设节点 mode
- EzFlex-NodeSwitchMaster     节点控制总预设：把每个 NodeSwitchGroup 实例映射到某分组预设
- EzFlex-MainControl          总控制节点：把 NodeSwitchMaster / ParamPresetControl 实例映射到其预设
- EzFlex-ParamPresetControl   参数预设控制：分组卡片驱动，动态输出端口 = 分组数 1:1
- EzFlex-ParamPresetOutput    参数预设输出：连接某分组端口，动态输出端口 = 参数数 1:1（按类型映射）
- EzFlex-PreviewAny           任意预览：白板放置多个可拖拽排序预览卡片，每卡一个任意输入 + 一个字符串输出

控制类节点（NodeSwitchGroup/Master/MainControl）是纯前端生效的配置容器（参考 rgthree
Fast Groups Muter/Bypasser：node.mode 0/2/4 由浏览器端设置），Python 只承载隐藏 config。
"""

import base64
import inspect
import json
import os
import random
import re
import struct
import zlib

import numpy as np
import torch

import folder_paths


def _fmt_size(n):
    try:
        n = float(n)
        for u in ("B", "KB", "MB", "GB", "TB"):
            if n < 1024 or u == "TB":
                return f"{n:.1f} {u}"
            n /= 1024
    except Exception:
        return str(n)
    return str(n)


def _fmt_mtime(t):
    try:
        from datetime import datetime
        return datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(t)


def _sha256(p):
    try:
        import hashlib
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return ""
import comfy.sd

from comfy_api.latest import io, InputImpl, Types

__version__ = "1.2.0"

WEB_DIRECTORY = "./web"

# 给 web 目录里的页面/脚本设置 no-store，杜绝 Comfy-Desktop / 浏览器把它们缓存成旧版。
# 在自定义节点加载阶段注册路由，早于 server.py 添加 /extensions 静态路由，因此优先生效。
try:
    from server import PromptServer
    from aiohttp import web as _web

    _WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

    def _serve_no_store(name):
        _path = os.path.join(_WEB_DIR, name)

        async def _handler(request):
            return _web.FileResponse(_path, headers={"Cache-Control": "no-store"})

        return _handler

    _routes = PromptServer.instance.routes
    for _fname in ("modelscombo_node.js", "freelatent_node.js",
                   "ezflex_service.js", "node_switch_group.js", "node_switch_master.js",
                   "main_control.js", "param_preset_control.js", "param_preset_output.js",
                   "preview_any.js", "prompt_helper.js",
                   "media_loader.js", "media_out.js"):
        _routes.get("/extensions/Comfyui-EzFlex-Presets/" + _fname)(_serve_no_store(_fname))
except Exception:
    pass

MAX_PORTS_PER_TYPE = 32

LOADER_FOLDERS = {
    "checkpoint": "checkpoints",
    "unet": "diffusion_models",
    "clip": "text_encoders",
    "vae": "vae",
    "lora": "loras",
}

WEIGHT_DTYPES = {
    "default": None,
    "fp16": torch.float16,
    "bf16": torch.bfloat16,
    "fp32": torch.float32,
    "fp8_e4m3fn": torch.float8_e4m3fn,
    "fp8_e4m3fn_fast": torch.float8_e4m3fn,
    "fp8_e5m2": torch.float8_e5m2,
}

# 与内置 CLIPLoader 的 type 选项保持一致
CLIP_TYPES = [
    "stable_diffusion", "stable_cascade", "sd3", "stable_audio", "mochi", "ltxv",
    "pixart", "cosmos", "lumina2", "wan", "hidream", "chroma", "ace", "omnigen2",
    "qwen_image", "hunyuan_image", "flux2", "ovis", "longcat_image", "cogvideox",
    "lens", "pixeldit", "ideogram4", "boogu", "krea2", "joyimage", "mage", "minimax",
]

# 页面 device 下拉提供的选项
DEVICES = ("default", "cpu", "cuda", "cuda:0", "cuda:1")

# VAE 只接受这些 dtype（fp8 不适用）
VAE_DTYPES = ("default", "fp16", "bf16", "fp32")

# 悬停预览：按「模型文件同名」的图片/视频返回，供前端 hover 展示
_MEDIA_EXTS = (
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
    ".mp4", ".webm", ".mov", ".m4v",
)


async def _preview_handler(request):
    folder = request.query.get("type", "")
    file = request.query.get("file", "")
    if folder not in LOADER_FOLDERS or not file:
        return _web.Response(status=400, text="bad request")
    try:
        path = folder_paths.get_full_path_or_raise(LOADER_FOLDERS[folder], file)
    except Exception:
        return _web.Response(status=404, text="model not found")
    base = os.path.splitext(path)[0]
    for ext in _MEDIA_EXTS:
        cand = base + ext
        if os.path.isfile(cand):
            return _web.FileResponse(cand, headers={"Cache-Control": "no-store"})
    return _web.Response(status=404, text="no preview")


# ===== 安全收口（评审要求）：路径包含性 / 本机限定 / 出站主机允许列表 =====
# 原则：前端能碰到的路径先落到「服务端自己的根目录」里（realpath + commonpath）；落不进去的
# 要么转存进临时目录再服务，要么直接拒绝。拉起本机程序 / 弹本机对话框 / 改允许列表：只认本机客户端。
def _ez_real(p):
    """规范化路径；空串一律返回 ''（注意：os.path.abspath('') 会得到进程 CWD，不能当路径用）。"""
    try:
        s = str(p).strip()
        return os.path.realpath(os.path.abspath(s)) if s else ""
    except Exception:
        return ""


def _ez_plugin_scan_dirs():
    """用户在「设置·路径设置」里登记的扫描目录（服务端自己的状态，不是请求参数）。"""
    out = []
    try:
        fn = _ph_scan_paths_file()
        if fn and os.path.isfile(fn):
            with open(fn, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                out.extend([x for x in data if isinstance(x, str)])
            elif isinstance(data, dict):
                for k in ("scan", "models", "dirs", "paths"):
                    v = data.get(k)
                    if isinstance(v, list):
                        out.extend([x for x in v if isinstance(x, str)])
    except Exception:
        pass
    return out


def _ez_roots():
    """允许前端读写的根目录 = ComfyUI 的 input/output/temp/models + 用户登记过的扫描目录。"""
    out = []
    for fn in ("get_input_directory", "get_output_directory", "get_temp_directory"):
        try:
            f = getattr(folder_paths, fn, None)
            if callable(f):
                v = f()
                if v:
                    out.append(v)
        except Exception:
            pass
    try:
        md = getattr(folder_paths, "models_dir", None)
        if md:
            out.append(md)
    except Exception:
        pass
    try:
        out.extend(_ph_media_input_dirs())
    except Exception:
        pass
    try:
        out.extend(_ez_plugin_scan_dirs())
    except Exception:
        pass
    roots, seen = [], set()
    for p in out:
        r = _ez_real(p)
        if r and r not in seen:
            seen.add(r)
            roots.append(r)
    return roots


def _ez_inside(path, roots=None):
    """realpath + commonpath：只有落在某个根目录内才返回规范路径，否则返回 ''。"""
    p = _ez_real(path)
    if not p:
        return ""
    for r in (roots if roots is not None else _ez_roots()):
        rr = _ez_real(r)
        if not rr:
            continue
        try:
            if p == rr or os.path.commonpath([p, rr]) == rr:
                return p
        except Exception:
            continue
    return ""


def _ez_adopt_to_temp(path):
    """根外文件：复制一份进 ComfyUI 临时目录再服务 —— 保住「任意来源也能预览」，但不放开任意读。"""
    try:
        import shutil
        import hashlib
        if not path or not os.path.isfile(path):
            return ""
        tmp_root = _ez_real(folder_paths.get_temp_directory())
        if not tmp_root:
            return ""
        src = _ez_real(path)
        ext = os.path.splitext(src)[1].lower()
        dest = os.path.join(tmp_root, "ezflex_serve_" + hashlib.sha1(src.encode("utf-8", "replace")).hexdigest()[:16] + ext)
        if not os.path.isfile(dest) or os.path.getsize(dest) != os.path.getsize(src):
            shutil.copy2(src, dest)
        return dest
    except Exception:
        return ""


def _ez_local(req):
    """敏感动作（拉起系统程序 / 弹本机对话框 / 改服务端允许列表）只允许本机客户端。
    另外校验来源头：任意网页也能从浏览器打到 localhost，所以带 Origin/Referer 时必须与 Host 同源。"""
    try:
        host = str(getattr(req, "remote", "") or "").strip()
    except Exception:
        host = ""
    if host not in ("127.0.0.1", "::1", "localhost"):
        return False
    # Host 也必须是回环名：挡 DNS rebinding（恶意域名解析到 127.0.0.1 时，浏览器给的 Host 是那个域名）
    try:
        raw_host = str(req.headers.get("Host") or "").strip().lower()
    except Exception:
        raw_host = ""
    if raw_host.startswith("["):
        req_host = raw_host[1:raw_host.find("]")] if "]" in raw_host else raw_host
    else:
        req_host = raw_host.split(":", 1)[0]
    if req_host and req_host not in ("127.0.0.1", "localhost", "::1"):
        return False
    try:
        origin = str(req.headers.get("Origin") or req.headers.get("Referer") or "")
    except Exception:
        origin = ""
    if origin and origin.strip().lower() != "null":
        ref = origin.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0].strip().lower()
        req_host = str(req.headers.get("Host") or "").split(":", 1)[0].strip().lower()
        if ref and req_host and ref != req_host:
            return False
    return True


try:
    PromptServer.instance.routes.get("/models_combo/preview")(_preview_handler)
except Exception:
    pass

# ===== LoraManager 元数据浏览（ModelsCombo「浏览」弹窗）=====
# 读取 LoraManager 在模型目录生成的 <模型名>.metadata.json（以及同目录预览图），
# 返回给前端做「批量添加加载器」的模型浏览器。只列能映射成组合加载器类型的目录。
_META_LOADER_FOLDERS = {
    "checkpoint": "checkpoints",
    "unet": "diffusion_models",
    "lora": "loras",
}


def _meta_relative_file(folder, meta, meta_path):
    """把 LoraManager 元数据对应的模型文件，换算成 ComfyUI /models/<folder> 的相对路径。"""
    fp = (meta.get("file_path") or "").strip()
    fp_n = os.path.normpath(fp) if fp else None
    roots = [os.path.normpath(r) for r in folder_paths.get_folder_paths(folder) if r]
    if fp_n:
        for root in roots:
            try:
                if os.path.commonpath([root, fp_n]) == root:
                    return os.path.relpath(fp_n, root).replace("\\", "/")
            except Exception:
                pass
    # 兜底：按 metadata 文件位置推算（模型文件与元数据同 basename，只差后缀）
    base = meta_path[:-len(".metadata.json")] if meta_path.endswith(".metadata.json") else os.path.splitext(meta_path)[0]
    base_n = os.path.normpath(base)
    for root in roots:
        try:
            if os.path.commonpath([root, base_n]) != root:
                continue
            base_rel = os.path.relpath(base_n, root).replace("\\", "/")
            for ext in (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".sft", ".lora"):
                if os.path.isfile(os.path.join(root, base_rel + ext)):
                    return base_rel + ext
            return base_rel
        except Exception:
            pass
    return ""


def _civitai_summary(c):
    if not isinstance(c, dict):
        return None
    imgs = []
    for img in (c.get("images") or []):
        if not isinstance(img, dict):
            continue
        imgs.append({
            "url": img.get("url"),
            "width": img.get("width"),
            "height": img.get("height"),
            "nsfwLevel": img.get("nsfwLevel"),
            "type": img.get("type"),
        })
    model = c.get("model") if isinstance(c.get("model"), dict) else {}
    creator = c.get("creator") if isinstance(c.get("creator"), dict) else {}
    return {
        "id": c.get("id"),
        "modelId": c.get("modelId"),
        "name": c.get("name"),
        "nsfwLevel": c.get("nsfwLevel"),
        "baseModel": c.get("baseModel"),
        "modelType": c.get("type"),
        "modelName": model.get("name"),
        "description": model.get("description"),
        "tags": model.get("tags") if isinstance(model.get("tags"), list) else [],
        "creator": creator.get("username"),
        "stats": c.get("stats") if isinstance(c.get("stats"), dict) else {},
        "downloadUrl": c.get("downloadUrl"),
        "images": imgs,
    }


def _lora_meta_summary(type_, rel, meta):
    tags = meta.get("tags")
    trained = meta.get("trainedWords")
    creator_meta = meta.get("creator")
    author = meta.get("author")
    if not author and isinstance(creator_meta, dict):
        author = creator_meta.get("username") or creator_meta.get("name")
    if not author and isinstance(creator_meta, str):
        author = creator_meta
    return {
        "type": type_,
        "file": rel,
        "file_name": meta.get("file_name"),
        "model_name": meta.get("model_name"),
        "base_model": meta.get("base_model"),
        "author": author,
        "size": meta.get("size"),
        "modified": meta.get("modified"),
        "sha256": meta.get("sha256"),
        "preview_url": meta.get("preview_url"),
        "preview_nsfw_level": meta.get("preview_nsfw_level", 0),
        "notes": meta.get("notes", ""),
        "from_civitai": meta.get("from_civitai", False),
        "tags": tags if isinstance(tags, list) else [],
        "modelDescription": meta.get("modelDescription", ""),
        "usage_tips": meta.get("usage_tips", ""),
        "trainedWords": trained if isinstance(trained, list) else [],
        "favorite": meta.get("favorite", False),
        "exclude": meta.get("exclude", False),
        "civitai": _civitai_summary(meta.get("civitai")),
    }


async def _lora_meta_list(req):
    out = []
    seen = set()
    for type_, folder in _META_LOADER_FOLDERS.items():
        for root in folder_paths.get_folder_paths(folder):
            if not root or not os.path.isdir(root):
                continue
            root = os.path.normpath(root)
            for dirpath, _dirs, files in os.walk(root):
                for fn in files:
                    if not fn.endswith(".metadata.json"):
                        continue
                    meta_path = os.path.join(dirpath, fn)
                    try:
                        with open(meta_path, "r", encoding="utf-8-sig") as fh:
                            meta = json.load(fh)
                    except Exception:
                        continue
                    if not isinstance(meta, dict):
                        continue
                    rel = _meta_relative_file(folder, meta, meta_path)
                    if not rel:
                        continue
                    key = (type_, rel)
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append(_lora_meta_summary(type_, rel, meta))
    out.sort(key=lambda x: (x.get("type") or "", x.get("model_name") or x.get("file_name") or ""))
    return _web.json_response(out)


async def _lora_meta_detail(req):
    type_ = req.query.get("type", "")
    file = req.query.get("file", "")
    folder = LOADER_FOLDERS.get(type_)
    if not folder or not file:
        return _web.Response(status=400, text="bad request")
    try:
        path = folder_paths.get_full_path_or_raise(folder, file)
    except Exception:
        return _web.Response(status=404, text="not found")
    meta_path = os.path.splitext(path)[0] + ".metadata.json"
    if not os.path.isfile(meta_path):
        return _web.Response(status=404, text="no metadata")
    try:
        with open(meta_path, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)
    return _web.json_response(data)


try:
    PromptServer.instance.routes.get("/models_combo/lora_meta")(_lora_meta_list)
    PromptServer.instance.routes.get("/models_combo/lora_meta_detail")(_lora_meta_detail)
except Exception:
    pass

# ===== 预设存储：插件目录 user_data（每个节点一个存档文件，存该节点全部预设）=====
# 文件可能被编辑器加上 UTF-8 BOM，读取用 utf-8-sig 兼容（否则 json.load 抛 BOM 错，被 except 吞成 []）。
_USER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user_data")
try:
    os.makedirs(_USER_DIR, exist_ok=True)
except Exception:
    pass


def _preset_file(node_name):
    return os.path.join(_USER_DIR, node_name + ".json")


def _read_doc(node_name):
    """读取存档，返回 (doc_dict, presets_list)。兼容两种形状：
    纯列表（ModelsCombo 旧格式）→ 包装成 {'presets': list}；对象 → 取 presets 键。"""
    try:
        with open(_preset_file(node_name), "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except Exception:
        return {}, []
    if isinstance(data, dict):
        presets = data.get("presets", [])
        return data, presets if isinstance(presets, list) else []
    if isinstance(data, list):
        return {"presets": data}, data
    return {}, []


def _read_all(node_name):
    return _read_doc(node_name)[1]


def _write_all(node_name, items):
    doc, _ = _read_doc(node_name)
    doc["presets"] = items
    # 仅当还有额外键（如 customRatios）时写对象，否则维持纯列表（ModelsCombo 旧格式不变）
    extra = {k: v for k, v in doc.items() if k != "presets"}
    out = doc if extra else items
    try:
        with open(_preset_file(node_name), "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _read_ratios(node_name):
    doc, _ = _read_doc(node_name)
    ratios = doc.get("customRatios", [])
    return ratios if isinstance(ratios, list) else []


def _write_ratios(node_name, ratios):
    doc, presets = _read_doc(node_name)
    doc["presets"] = presets
    doc["customRatios"] = ratios
    try:
        with open(_preset_file(node_name), "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
    except Exception:
        pass


# 同一套预设路由按 node_name 参数化：GET 列表 / POST 保存 / DELETE {name}。
# 保存时保留客户端除 name 外的全部字段（modelscombo 存 loaders，freelatent 存 config）。
def _register_preset_routes(node_name, api_path, with_ratios=False):
    async def _list(req):
        return _web.json_response(_read_all(node_name))

    async def _save(req):
        try:
            data = await req.json()
            name = (data.get("name") or "").strip()
            if not name:
                return _web.json_response({"error": "no name"}, status=400)
            items = _read_all(node_name)
            obj = {"name": name}
            for k, v in data.items():
                if k != "name":
                    obj[k] = v
            i = next((k for k, p in enumerate(items) if p.get("name") == name), -1)
            if i >= 0:
                items[i] = obj
            else:
                items.append(obj)
            _write_all(node_name, items)
            return _web.json_response({"ok": True, "name": name})
        except Exception as e:
            return _web.json_response({"error": str(e)}, status=500)

    async def _delete(req):
        try:
            name = req.match_info.get("name", "")
            items = [p for p in _read_all(node_name) if p.get("name") != name]
            _write_all(node_name, items)
            return _web.json_response({"ok": True})
        except Exception as e:
            return _web.json_response({"error": str(e)}, status=500)

    if with_ratios:
        async def _ratio_list(req):
            return _web.json_response(_read_ratios(node_name))

        async def _ratio_save(req):
            try:
                data = await req.json()
                if isinstance(data.get("ratios"), list):
                    ratios = [str(r).strip() for r in data["ratios"] if str(r).strip()]
                else:
                    ratio = (data.get("ratio") or "").strip()
                    if not ratio:
                        return _web.json_response({"error": "no ratio"}, status=400)
                    ratios = _read_ratios(node_name)
                    if ratio not in ratios:
                        ratios = ratios + [ratio]
                _write_ratios(node_name, ratios)
                return _web.json_response({"ok": True, "ratios": ratios})
            except Exception as e:
                return _web.json_response({"error": str(e)}, status=500)

        async def _ratio_delete(req):
            try:
                ratio = req.match_info.get("ratio", "")
                ratios = [r for r in _read_ratios(node_name) if r != ratio]
                _write_ratios(node_name, ratios)
                return _web.json_response({"ok": True, "ratios": ratios})
            except Exception as e:
                return _web.json_response({"error": str(e)}, status=500)

        try:
            PromptServer.instance.routes.get(api_path + "/custom_ratios")(_ratio_list)
            PromptServer.instance.routes.post(api_path + "/custom_ratios")(_ratio_save)
            PromptServer.instance.routes.delete(api_path + "/custom_ratios/{ratio}")(_ratio_delete)
        except Exception:
            pass

    try:
        PromptServer.instance.routes.get(api_path)(_list)
        PromptServer.instance.routes.post(api_path)(_save)
        PromptServer.instance.routes.delete(api_path + "/{name}")(_delete)
    except Exception:
        pass


_register_preset_routes("EzFlex-ModelsCombo", "/models_combo/presets")
_register_preset_routes("EzFlex-FreeLatent", "/freelatent/presets", with_ratios=True)
_register_preset_routes("EzFlex-MediaLoader", "/media_loader/presets")


# ComfyUI 校验节点输出类型时读的是「类 RETURN_TYPES」（execution.py validate），
# 而 ModelsCombo 的输出随 config 变化，运行期 load_combo 改类属性赶不上校验。
# 因此前端在每次输出结构变化时 POST 到这里，把类 RETURN_TYPES/RETURN_NAMES 同步成当前排列，
# 这样校验（VAE→VAE 解码、CLIP→CLIP 文本编码、MODEL→采样器）类型才对得上。
def _mc_output_types(loaders):
    mains = [l for l in (loaders or []) if l.get("type") != "lora"]
    out_types, out_names = [], []
    for l in mains:
        nm = (l.get("name") or "").strip() or l.get("type") or ""
        if l.get("type") in ("checkpoint", "unet"):
            out_types.append("MODEL"); out_names.append(nm + "_model")
        if l.get("type") in ("checkpoint", "clip"):
            out_types.append("CLIP"); out_names.append(nm + "_clip")
        if l.get("type") in ("checkpoint", "vae"):
            out_types.append("VAE"); out_names.append(nm + "_vae")
    return out_types, out_names


async def _mc_outputs(req):
    try:
        data = await req.json()
        config = data.get("config", "")
        loaders = parse_config(config) if isinstance(config, str) else (config or [])
        out_types, out_names = _mc_output_types(loaders)
        ModelsComboLoader.RETURN_TYPES = tuple("*" for _ in out_types)
        ModelsComboLoader.RETURN_NAMES = tuple(out_names)
        return _web.json_response({"ok": True, "types": out_types, "names": out_names})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


try:
    PromptServer.instance.routes.post("/models_combo/outputs")(_mc_outputs)
except Exception:
    pass


def parse_config(config):
    if isinstance(config, str):
        if not config.strip():
            return []
        try:
            data = json.loads(config)
        except json.JSONDecodeError as e:
            raise ValueError(f"config is not valid JSON: {e}") from e
    else:
        data = config
    if isinstance(data, dict):
        data = data.get("loaders", [])
    if not isinstance(data, list):
        raise ValueError("config must be a list of loaders, or an object with a loaders list")

    loaders = []
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        ltype = item.get("type")
        if ltype not in LOADER_FOLDERS:
            raise ValueError(f"unknown loader type: {ltype!r} (expected one of: {', '.join(LOADER_FOLDERS)})")
        extra = item.get("extra") or {}
        if not isinstance(extra, dict):
            raise ValueError(f"loader {ltype!r} extra must be an object")
        loaders.append({
            "id": item.get("id", f"idx{i}"),
            "type": ltype,
            "name": item.get("name") or ltype,
            "file": item.get("file") or "",
            "extra": extra,
            "target_id": item.get("targetId"),
        })
    return loaders


def device_options(extra):
    device = extra.get("device", "default")
    if device not in DEVICES:
        raise ValueError(f"unsupported device: {device!r} (expected one of: {', '.join(DEVICES)})")
    if device == "default":
        return {}
    dev = torch.device(device)
    opts = {"load_device": dev}
    if dev.type == "cpu":
        opts["offload_device"] = dev
    return opts


def dtype_options(extra, allowed=WEIGHT_DTYPES):
    weight_dtype = extra.get("weight_dtype", "default")
    if weight_dtype not in allowed:
        raise ValueError(f"unsupported weight_dtype: {weight_dtype!r} (expected one of: {', '.join(allowed)})")
    dtype = allowed[weight_dtype]
    opts = {}
    if dtype is not None:
        opts["dtype"] = dtype
        if weight_dtype == "fp8_e4m3fn_fast":
            opts["fp8_optimizations"] = True
    return opts


def model_options(extra):
    opts = {}
    opts.update(dtype_options(extra))
    opts.update(device_options(extra))
    return opts


def load_checkpoint(loader):
    path = folder_paths.get_full_path_or_raise("checkpoints", loader["file"])
    out = comfy.sd.load_checkpoint_guess_config(
        path, output_vae=True, output_clip=True,
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
        model_options=model_options(loader["extra"]),
    )
    return out[0], out[1], out[2]


def load_unet(loader):
    path = folder_paths.get_full_path_or_raise("diffusion_models", loader["file"])
    return comfy.sd.load_diffusion_model(path, model_options=model_options(loader["extra"]))


def load_clip(loader):
    path = folder_paths.get_full_path_or_raise("text_encoders", loader["file"])
    clip_type_name = loader["extra"].get("type", "stable_diffusion")
    if clip_type_name not in CLIP_TYPES:
        raise ValueError(f"unsupported CLIP type: {clip_type_name!r} (expected one of: {', '.join(CLIP_TYPES)})")
    clip_type = getattr(comfy.sd.CLIPType, clip_type_name.upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
    return comfy.sd.load_clip(
        ckpt_paths=[path],
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
        clip_type=clip_type,
        model_options=model_options(loader["extra"]),
    )


def load_vae(loader):
    path = folder_paths.get_full_path_or_raise("vae", loader["file"])
    sd, metadata = comfy.utils.load_torch_file(path, return_metadata=True)
    extra = loader["extra"]
    device = extra.get("device", "default")
    if device not in DEVICES:
        raise ValueError(f"unsupported device: {device!r} (expected one of: {', '.join(DEVICES)})")
    vae_device = None if device == "default" else torch.device(device)
    dtype = dtype_options(extra, allowed=dict((k, v) for k, v in WEIGHT_DTYPES.items() if k in VAE_DTYPES)).get("dtype")
    vae = comfy.sd.VAE(sd=sd, metadata=metadata, device=vae_device, dtype=dtype)
    vae.throw_exception_if_invalid()
    return vae


class ModelsComboLoader:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "config": ("STRING", {
                    "multiline": True,
                    "default": "[]",
                    "tooltip": "JSON config copied from the Models Combo panel (loader array).",
                }),
            },
        }

    RETURN_TYPES = tuple(["*"] * (MAX_PORTS_PER_TYPE * 3))
    RETURN_NAMES = (
        tuple([f"MODEL {i + 1}" for i in range(MAX_PORTS_PER_TYPE)])
        + tuple([f"CLIP {i + 1}" for i in range(MAX_PORTS_PER_TYPE)])
        + tuple([f"VAE {i + 1}" for i in range(MAX_PORTS_PER_TYPE)])
    )
    FUNCTION = "load_combo"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Models Combo Loader"

    def load_combo(self, config, **kwargs):
        loaders = parse_config(config)
        mains = [l for l in loaders if l["type"] != "lora"]
        loras = [l for l in loaders if l["type"] == "lora"]

        model_count = sum(1 for l in mains if l["type"] in ("checkpoint", "unet"))
        clip_count = sum(1 for l in mains if l["type"] in ("checkpoint", "clip"))
        vae_count = sum(1 for l in mains if l["type"] in ("checkpoint", "vae"))
        if max(model_count, clip_count, vae_count) > MAX_PORTS_PER_TYPE:
            raise ValueError(
                f"too many ports: at most {MAX_PORTS_PER_TYPE} per type "
                f"(currently models={model_count}, clips={clip_count}, vaes={vae_count}); split the config."
            )

        by_id = {}
        for loader in mains:
            if loader["type"] == "checkpoint":
                model, clip, vae = load_checkpoint(loader)
                by_id[loader["id"]] = {"model": model, "clip": clip, "vae": vae}
            elif loader["type"] == "unet":
                by_id[loader["id"]] = {"model": load_unet(loader), "clip": None, "vae": None}
            elif loader["type"] == "clip":
                by_id[loader["id"]] = {"model": None, "clip": load_clip(loader), "vae": None}
            elif loader["type"] == "vae":
                by_id[loader["id"]] = {"model": None, "clip": None, "vae": load_vae(loader)}

        # 多 LoRA 串联：按序号（id）顺序依次打补丁，后一个在前一个结果上继续，最终输出到 MODEL/CLIP 槽位
        ordered_loras = sorted(
            loras,
            key=lambda x: (x["id"] if isinstance(x["id"], (int, float)) else 0),
        )
        for lora in ordered_loras:
            target = by_id.get(lora["target_id"])
            if target is None:
                print(f"[ModelsCombo] LoRA '{lora['name']}'：目标加载器不存在，已跳过")
                continue
            model, clip = target["model"], target["clip"]
            if model is None and clip is None:
                print(f"[ModelsCombo] LoRA '{lora['name']}'：目标没有 MODEL/CLIP，已跳过")
                continue
            lora_path = folder_paths.get_full_path_or_raise("loras", lora["file"])
            lora_sd = comfy.utils.load_torch_file(lora_path)
            strength_model = float(lora["extra"].get("strength_model", 1.0))
            strength_clip = float(lora["extra"].get("strength_clip", 1.0))
            new_model, new_clip = comfy.sd.load_lora_for_models(model, clip, lora_sd, strength_model, strength_clip)
            # 无论返回什么，都把「当前模型/CLIP」保留给下一个 lora 继续串联
            if new_model is not None:
                target["model"] = new_model
            elif model is not None:
                target["model"] = model
            if new_clip is not None:
                target["clip"] = new_clip
            elif clip is not None:
                target["clip"] = clip

        # 动态输出：按「加载器顺序」逐个产出其拥有的端口（checkpoint=model/clip/vae 相邻、unet=model、clip=clip、vae=vae，
        # lora 不占输出端口）。保证与前端 updatePorts 的顺序一致，其它节点接线时类型才对得上。
        out_types, out_names, outputs = [], [], []
        for loader in mains:
            entry = by_id[loader["id"]]
            nm = (loader.get("name") or "").strip() or loader["type"]
            if loader["type"] in ("checkpoint", "unet") and entry["model"] is not None:
                out_types.append("MODEL"); out_names.append(nm + "_model"); outputs.append(entry["model"])
            if loader["type"] in ("checkpoint", "clip") and entry["clip"] is not None:
                out_types.append("CLIP"); out_names.append(nm + "_clip"); outputs.append(entry["clip"])
            if loader["type"] in ("checkpoint", "vae") and entry["vae"] is not None:
                out_types.append("VAE"); out_names.append(nm + "_vae"); outputs.append(entry["vae"])

        self.__class__.RETURN_TYPES = tuple("*" for _ in out_types)
        self.__class__.RETURN_NAMES = tuple(out_names)
        return tuple(outputs)


# ===== EzFlex-FreeLatent：按「分辨率选择器」面板配置生成空 Latent =====
def parse_freelatent_config(config):
    if isinstance(config, str):
        if not config.strip():
            return 1024, 1024, 1
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            data = {}
    else:
        data = config
    if not isinstance(data, dict):
        data = {}

    def to_int(v, default):
        try:
            return int(v)
        except (TypeError, ValueError):
            return default

    w = to_int(data.get("width"), 1024)
    h = to_int(data.get("height"), 1024)
    b = to_int(data.get("batch_size", data.get("batch")), 1)

    # 严格按面板「对齐」值对齐（.5 向上，与前端一致；是否 8 的倍数在 execute 校验）
    mult = _freelatent_align(config)
    return _fl_round_step(w, mult), _fl_round_step(h, mult), max(1, b)


def _freelatent_force(config):
    """读取「强(force)」标志：为真时忽略外部 width/height/batch，强制用面板值。"""
    if isinstance(config, str):
        if not config.strip():
            return False
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            return False
    else:
        data = config
    if isinstance(data, dict):
        return bool(data.get("force"))
    return False


def _freelatent_align(config):
    """读取面板「对齐」值（原样返回，不做 8 约束）；最终 generate 时若结果非 8 的倍数会报错提示。"""
    if isinstance(config, str):
        if not config.strip():
            return 8
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            return 8
    else:
        data = config
    if isinstance(data, dict):
        a = int(data.get("align") or 8)
        return a if a >= 1 else 8
    return 8


def _fl_round_step(v, mult, lo=64):
    """按 mult 四舍五入（.5 向上取整），与前端 JS Math.round 一致；并保底 lo。"""
    return max(lo, int(v / mult + 0.5) * mult)


class FreeLatentNode(io.ComfyNode):
    """V3 节点：output 为 Latent/Width/Height/Batch；width/height/batch_size 用 force_input 保证是
    可连接 socket（不再走 widget→socket 转换 hack，避免 socket 圆点悬停漂移），未连接时用面板 config 值。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="EzFlex-FreeLatent",
            display_name="EzFlex-FreeLatent",
            category="EzFlex",
            description="Resolution / Latent Selector",
            inputs=[
                io.String.Input("config", socketless=True, default="{}",
                                tooltip="Config JSON generated by the resolution panel (width / height / batch / algorithm / ratio)."),
                io.Int.Input("width", display_name="Width", optional=True, default=0,
                             min=0, max=32768, step=8, force_input=True,
                             tooltip="External width: >0 overrides the panel width (0 / empty = use the panel value)."),
                io.Int.Input("height", display_name="Height", optional=True, default=0,
                             min=0, max=32768, step=8, force_input=True,
                             tooltip="External height: >0 overrides the panel height (0 / empty = use the panel value)."),
                io.Int.Input("batch_size", display_name="Batch", optional=True, default=0,
                             min=0, max=4096, force_input=True,
                             tooltip="External batch: >0 overrides the panel batch (0 / empty = use the panel value)."),
            ],
            outputs=[
                io.Latent.Output("Latent", tooltip="Empty latent (batch, 4, height/8, width/8)"),
                io.Int.Output("Width", tooltip="Width in pixels"),
                io.Int.Output("Height", tooltip="Height in pixels"),
                io.Int.Output("Batch", tooltip="Batch size"),
            ],
        )

    @classmethod
    def execute(cls, config="{}", width=0, height=0, batch_size=0):
        w, h, batch = parse_freelatent_config(config)
        # 「强(force)」生效时忽略外部 width/height/batch，强制用面板值
        if not _freelatent_force(config):
            if width and width > 0:
                w = width
            if height and height > 0:
                h = height
            if batch_size and batch_size > 0:
                batch = batch_size
        # 严格按面板「对齐」值对齐（.5 向上，与前端一致）；最终宽高必须是 8 的倍数，否则报错提示用户调整
        mult = _freelatent_align(config)
        w, h = _fl_round_step(w, mult), _fl_round_step(h, mult)
        if (w % 8) != 0 or (h % 8) != 0:
            raise ValueError(
                f"[EzFlex-FreeLatent] the aligned size {w}x{h} (align={mult}) is not a multiple of 8; "
                f"latent dimensions must be divisible by 8 (latent = pixels / 8). Set align to a multiple of 8, or change the width/height."
            )
        batch = max(1, int(batch))
        latent = torch.zeros([batch, 4, h // 8, w // 8], dtype=torch.float32)
        return io.NodeOutput({"samples": latent}, w, h, batch)


def _control_input_types(tooltip):
    """控制类节点的标准输入：隐藏 config STRING 承载面板状态。"""
    return {
        "required": {
            "config": ("STRING", {
                "multiline": True,
                "default": "{}",
                "tooltip": tooltip,
            }),
        },
    }


class NodeSwitchGroupNode:
    """分组预设（方案A，参考 rgthree Fast Groups Muter/Bypasser）：前端内嵌面板管理
    「开关 → 匹配（画布分组 颜色/标题正则）→ node.mode 0/2/4」。
    开关列表与当前预设名存 config；命名分组预设存服务器 user_data 预设库（按节点名共享）。"""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "Config JSON produced by the Node Switch Group panel (switch list / match rules / current preset).",
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Node Switch Group"

    def run(self, config="{}", **kwargs):
        return ()


class NodeSwitchMasterNode:
    """节点控制总预设：总预设 = {NodeSwitchGroup 节点 id -> 该分组预设名} 的映射。
    行（目标分组节点）由前端从画布发现；应用时前端把映射写进各分组节点的 config.current 并触发其应用。"""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "Config JSON produced by the Node Switch Master panel (current master preset name).",
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Node Switch Master"

    def run(self, config="{}", **kwargs):
        return ()


class MainControlNode:
    """总控制节点：总预设 = {目标节点 id -> 该节点预设名} 的映射，目标是画布上的
    EzFlex-NodeSwitchMaster / EzFlex-ParamPresetControl / EzFlex-ModelsCombo / EzFlex-FreeLatent
    实例。应用时级联下推。"""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "Config JSON produced by the Main Control panel (current master preset name).",
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Main Control"

    def run(self, config="{}", **kwargs):
        return ()


class ParamPresetControlNode:
    """参数预设控制：前端面板管理参数组（组/参数可拖拽排序），动态输出端口与参数组卡片一一对应
    （一个分组一个 EZFLEX_PARAM_GROUP 端口，携带该组参数数据）。分组增删/排序后由前端 POST
    /param_preset_control/outputs 同步类 RETURN_TYPES/RETURN_NAMES（校验用），execute 再按实际数据设置。"""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "Config JSON produced by the Param Preset Control panel (parameter group list + current preset name).",
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Param Preset Control"

    def run(self, config="{}", **kwargs):
        groups = parse_param_groups(config)
        types, names = _ppc_output_types(groups)
        self.__class__.RETURN_TYPES = types
        self.__class__.RETURN_NAMES = names
        return tuple(groups)


class ParamPresetOutputNode:
    """参数预设输出：输入一个 EZFLEX_PARAM_GROUP 分组端口（从 ParamPresetControl 对应分组端口连线）。
    输出端口 = 固定的整组数据红色圆点（透传 EZFLEX_PARAM_GROUP 整组数据）+ 每个激活参数一个端口
    （int->INT / float->FLOAT / string->STRING / bool->BOOLEAN，复杂类型 -> STRING(JSON)；
    红色/未选中的参数不占端口；Output 面板局部禁用的参数输出该类型中性默认值）。
    参数增删/排序/连接变化后由前端 POST /param_preset_output/outputs 同步类 RETURN_TYPES/RETURN_NAMES。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "group": ("EZFLEX_PARAM_GROUP", {
                    "tooltip": "A parameter-group output from EzFlex-ParamPresetControl.",
                }),
                "config": ("STRING", {
                    "multiline": True,
                    "default": "{}",
                    "tooltip": "Config JSON generated by the Param Preset Output panel (ids of disabled parameters).",
                }),
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Param Preset Output"

    def run(self, group=None, config="{}", **kwargs):
        group = group or {}
        off = _parse_local_off(config)
        # 按实际修正参数组类型：值若是 string（无效输入）则类型改 string
        group = dict(group)
        params = []
        for p in (group.get("params") or []):
            p = dict(p)
            ptype = (p.get("type") or "string").lower()
            val = p.get("value")
            actual = "string" if (isinstance(val, str) and ptype != "string") else ptype
            p["type"] = actual
            params.append(p)
        group["params"] = params
        active = _ppo_effective_params(group)
        types, names, outputs = ["EZFLEX_PARAM_GROUP"], ["数据组合"], [group]
        for i, p in enumerate(active):
            ptype = (p.get("type") or "string").lower()
            types.append(PARAM_TYPE_MAP.get(ptype, "STRING"))
            names.append((p.get("name") or "").strip() or f"参数 {i + 1}")
            if str(p.get("id")) in off:
                outputs.append(_ppo_disabled_value(ptype))
            else:
                outputs.append(param_value_to_comfy(p.get("value"), ptype))
        self.__class__.RETURN_TYPES = tuple(types)
        self.__class__.RETURN_NAMES = tuple(names)
        return tuple(outputs)


# ===== EzFlex-PreviewAny：任意预览 =====
# 参考 AUNPassthroughAnyMulti 的做法：固定 input_1..N ANY 输入槽 + STRING 输出；
# 前端白板管理卡片（拖拽排序/增删），卡片顺序通过 workflow 里的 input 顺序读取。
class _AlwaysEqualProxy(str):
    def __eq__(self, _): return True
    def __ne__(self, _): return False

_ANY = _AlwaysEqualProxy("*")
# MediaLoader 卡片 → MediaOut 的专属端口类型：这两个口传的是「卡片对象」而不是媒体值，
# 用专属类型可以挡住误连（内置节点拖不上去），但 PreviewAny 这类 * 口仍可透传。
_MEDIA_CARD = "EZFLEX_MEDIA_CARD"
_PREVIEW_MAX = 16
_PREVIEW_MAX_VALUE_LEN = 500
_PREVIEW_MAX_IMG_SIDE = 1600


def _pv_truncate(s, max_len=_PREVIEW_MAX_VALUE_LEN):
    if max_len and len(s) > max_len:
        return s[:max_len] + "... [truncated]", s
    return s, None


def _pv_str(value):
    try:
        return str(value)
    except Exception:
        return f"Object (type={type(value).__name__}, unable to display)"


def _pv_sanitize(obj):
    """递归确保对象树可 JSON 序列化。"""
    if isinstance(obj, dict):
        return {k: _pv_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_pv_sanitize(v) for v in obj]
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    return _pv_str(obj)


def _file3d_source(value):
    """File3D 对象（内置 Load3D 的 FILE_3D 类型）落到磁盘文件的绝对路径；没有则 ''。"""
    try:
        src = value.get_source() if hasattr(value, "get_source") else None
        if isinstance(src, str) and os.path.isfile(src):
            return os.path.abspath(src)
    except Exception:
        pass
    return ""


class PreviewAnyNode:
    """EzFlex-PreviewAny：一块白板，内含多个可拖拽排序的预览卡片；每个卡片对应一个任意输入端口 +
    一个字符串输出端口（同 AUNPassthroughAnyMulti 的思路：输出该卡解析后的字符串）。"""

    @classmethod
    def INPUT_TYPES(cls):
        inputs = {
            "required": {
                "config": ("STRING", {
                    "multiline": True,
                    "default": "{\"save\":false,\"savePath\":\"\"}",
                    "tooltip": "Preview Any settings (save to disk + relative save folder).",
                }),
            },
            "optional": {},
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
        }
        for i in range(1, _PREVIEW_MAX + 1):
            inputs["optional"][f"input_{i}"] = (_ANY, {"forceInput": True, "tooltip": f"Any input {i}."})
        return inputs

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    OUTPUT_NODE = True
    FUNCTION = "preview"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Preview Any"

    def preview(self, config="{}", unique_id=None, extra_pnginfo=None, **kwargs):
        cfg = self._parse_config(config)
        connected = self._connected_inputs(unique_id, extra_pnginfo)
        wf_meta = PreviewAnyNode._workflow_gen_meta((extra_pnginfo or {}).get("workflow", {}))
        entries, outputs = [], []
        for i, (name, label, upstream) in enumerate(connected):
            entry = self._entry(label or f"输入 {i + 1}", kwargs.get(name), upstream, wf_meta)
            entry = self._maybe_save(entry, cfg, label or f"card_{i + 1}", extra_pnginfo)
            entries.append(entry)
            outputs.append(kwargs.get(name))   # 透传原始值（不是卡文字），供工作流中间连接继续传递
        # 用 "*" 通配类型，让输出能连到任意类型的输入端口（透传原始值）
        self.__class__.RETURN_TYPES = tuple("*" for _ in range(len(outputs)))
        self.__class__.RETURN_NAMES = tuple(f"output_{i + 1}" for i in range(len(outputs)))
        return {"ui": {"entries": _pv_sanitize(entries)}, "result": tuple(outputs)}

    # ── 配置 / 已连接输入 ──────────────────────────────────────────
    def _parse_config(self, config):
        if isinstance(config, str):
            if not config.strip():
                return {"save": False, "savePath": ""}
            try:
                data = json.loads(config)
            except json.JSONDecodeError:
                return {"save": False, "savePath": ""}
        else:
            data = config or {}
        if not isinstance(data, dict):
            data = {}
        return {"save": bool(data.get("save")), "savePath": str(data.get("savePath") or ""),
                "saveFormats": data.get("saveFormats") if isinstance(data.get("saveFormats"), dict) else {}}

    def _connected_inputs(self, unique_id, extra_pnginfo):
        """返回已连接输入 (name, label)，按 workflow 里 input 顺序。label 取上游输出标签。"""
        names = []
        if unique_id is None or extra_pnginfo is None:
            return names
        workflow = extra_pnginfo.get("workflow", {})
        nodelist = workflow.get("nodes", [])
        my_node = next((n for n in nodelist if str(n.get("id")) == str(unique_id)), None)
        if not my_node:
            return names
        inputs_data = my_node.get("inputs", [])
        input_list = inputs_data.values() if isinstance(inputs_data, dict) else inputs_data if isinstance(inputs_data, list) else []
        # ComfyUI 工作流的 links 可能是 dict，也可能是数组 [id, origin_id, origin_slot, ...]，两种都兼容
        links = {}
        for l in (workflow.get("links") or []):
            if isinstance(l, dict):
                links[str(l.get("id"))] = l
            elif isinstance(l, (list, tuple)) and len(l) >= 2:
                links[str(l[0])] = {"id": l[0], "origin_id": l[1], "origin_slot": l[2] if len(l) > 2 else None,
                                    "target_id": l[3] if len(l) > 3 else None, "target_slot": l[4] if len(l) > 4 else None}
        for slot in input_list:
            if not isinstance(slot, dict):
                continue
            nm = slot.get("name", "")
            if not nm.startswith("input_"):
                continue
            link_id = slot.get("link")
            if link_id is None:
                continue
            label = (slot.get("label") or "").strip()
            link = links.get(str(link_id))
            upstream = None
            if link:
                for n in nodelist:
                    if str(n.get("id")) == str(link.get("origin_id")):
                        upstream = n
                        if not label:
                            outs = n.get("outputs", [])
                            if isinstance(outs, list) and link.get("origin_slot") is not None and link["origin_slot"] < len(outs):
                                o = outs[link["origin_slot"]]
                                if isinstance(o, dict):
                                    label = (o.get("label") or "").strip() or o.get("name", "") or ""
                        break
            names.append((nm, label or nm, upstream))
        return names

    # ── 单卡解析 ────────────────────────────────────────────────────
    def _entry(self, caption, value, upstream=None, wf_meta=None):
        entry = {"caption": caption or "", "type": "", "value": "", "full_value": None, "preview": None,
                 "audio": None, "frames": 0, "meta": None}
        if value is None:
            entry["type"] = "EMPTY"
            entry["value"] = "(未连接)"
            return entry
        try:
            type_name = self._infer_type(value)
            entry["type"] = type_name
            if type_name == "IMAGE":
                entry["preview"] = self._image_to_base64(value)
                src = self._export_image_url(value)
                if src:
                    entry["image_src"] = src
                val, full = self._image_summary(value)
                entry["value"] = val
                if full:
                    entry["full_value"] = full
                gm = PreviewAnyNode._image_gen_meta(upstream)
                if gm:
                    entry["gen_meta"] = json.dumps(gm, ensure_ascii=False, default=str)
            elif type_name == "MASK":
                entry["preview"] = self._mask_to_base64(value)
                msrc = self._export_mask_url(value)
                if msrc:
                    entry["image_src"] = msrc
                val, full = _pv_truncate(f"Mask shape={list(value.shape)}")
                entry["value"] = val
                if full:
                    entry["full_value"] = full
            elif type_name == "AUDIO":
                entry["value"] = self._audio_summary(value)
                src = self._audio_file_src(value)
                if src:
                    entry["audio_src"] = src
                    try:
                        from urllib.parse import urlparse, parse_qs, unquote
                        p = (parse_qs(urlparse(src).query).get("path") or [None])[0]
                        if p:
                            apath = unquote(p)
                            if os.path.isfile(apath):
                                gm = self._file_gen_meta(apath)
                                if gm:
                                    entry["gen_meta"] = json.dumps(gm, ensure_ascii=False, default=str)
                    except Exception:
                        pass
                else:
                    entry["audio"] = self._audio_to_data_uri(value)
            elif type_name == "VIDEO":
                # 1) 底层是磁盘上的视频文件（内置 Load Video / 我们的 MediaOut 都是）：直接挂原文件播放，绝不重编码。
                # 2) 内存型视频对象（内置 Create Video 的 VideoFromComponents 等）：它自己 get_stream_source() 出来的就是
                #    「带音轨 + 原始帧率」的完整视频（save_to 会把 audio 一起写进去），落一个临时文件同样直接播 ——
                #    音轨 / 帧率 / 时长都不丢。（原来是只抓前 60 帧重编码成无音轨 webm：音轨丢了，帧率也是猜的。）
                # 先问「自己那股流」（文件型直接给路径、内存型只编码这一次），再退回路径探测
                fsrc = None
                if not isinstance(value, (dict, list, tuple)) and hasattr(value, "get_stream_source"):
                    fsrc = PreviewAnyNode._video_stream_temp(value)
                if not fsrc:
                    fsrc = PreviewAnyNode._video_file_source(value)
                if fsrc:
                    from urllib.parse import quote
                    entry["video_src"] = "/preview_any/serve_video?path=" + quote(fsrc)
                    poster, vfps, dims = self._video_file_poster(fsrc)
                    if poster:
                        entry["preview"] = poster
                    entry["fps"] = vfps
                    entry["value"] = self._video_file_summary(vfps, dims)
                    gm = self._file_gen_meta(fsrc)
                    if gm:
                        entry["gen_meta"] = json.dumps(gm, ensure_ascii=False, default=str)
                elif isinstance(value, (dict, list, tuple)) or not hasattr(value, "get_stream_source"):
                    first, count = self._video_first_frame(value)
                    entry["preview"] = first
                    entry["frames"] = count
                    frames, fps = self._video_frames(value)
                    entry["fps"] = fps
                    entry["value"] = self._video_summary(frames, fps)
                    webm = self._video_to_webm(frames, fps)
                    if webm:
                        entry["video"] = webm
                else:
                    entry["value"] = "视频"   # 内存型视频但拿不到它的编码流，只能显示个类型
            elif type_name == "CONDITIONING":
                entry["value"] = self._conditioning_summary(value)
                entry["full_value"] = entry["value"]
            elif type_name in ("LIST", "TUPLE", "SET", "DICT"):
                norm = self._python_to_json(value)
                val, full = self._safe_json(norm)
                entry["value"] = val
                if full:
                    entry["full_value"] = full
            elif type_name == "STRING":
                val, full = _pv_truncate(str(value))
                entry["value"] = val
                if full:
                    entry["full_value"] = full
            elif type_name == "LATENT":
                val, full = self._latent_summary(value)
                entry["value"] = val
                entry["meta"] = ("Latent 是扩散模型的隐藏潜在空间（压缩后的特征），shape=[B,C,H,W] 含义："
                                 "B=批次(batch)、C=通道(channel，通常为 4)、H=高度、W=宽度。它不是最终图像，"
                                 "需经 VAE 解码成图像。这里给出的是它的 shape/dtype 统计。")
                if full:
                    entry["full_value"] = full
            elif type_name in ("MODEL_3D", "FILE_3D"):
                entry["value"] = self._object_3d_summary(value)
                url = self._export_3d_url(value)
                if url:
                    entry["model3d"] = url
                p3d = getattr(value, "path", None) or getattr(value, "file", None)
                if isinstance(p3d, str) and os.path.isfile(p3d):
                    gm = self._file_gen_meta(p3d)
                    if gm:
                        entry["gen_meta"] = json.dumps(gm, ensure_ascii=False, default=str)
            elif type_name in ("MESH", "SPLAT", "VOXEL"):
                entry["value"] = self._geometry_summary(value, type_name)
                entry["full_value"] = entry["value"]
                if type_name == "MESH":
                    url = PreviewAnyNode._mesh_obj_url(value)   # 顶点/面张量 → 临时 OBJ，交给内置 3D 查看器
                    if url:
                        entry["model3d"] = url
            elif type_name in ("MODEL", "CLIP", "VAE", "CONTROL_NET", "CLIP_VISION", "STYLE_MODEL",
                               "UPSCALE_MODEL", "LORA_MODEL", "GLIGEN", "SAMPLER", "SIGMAS", "GUIDER",
                               "NOISE", "SEGS"):
                entry["value"] = self._object_summary(value, type_name)
                if type_name in ("MODEL", "CLIP", "VAE"):
                    meta = self._model_meta(value, type_name, upstream)
                    if meta:
                        entry["meta"] = meta
            elif isinstance(value, dict):
                norm = self._python_to_json(value)
                val, full = self._safe_json(norm)
                entry["value"] = val
                if full:
                    entry["full_value"] = full
            elif isinstance(value, (list, tuple)):
                norm = self._python_to_json(value)
                val, full = self._safe_json(norm)
                entry["value"] = val
                if full:
                    entry["full_value"] = full
            elif isinstance(value, torch.Tensor):
                val, full = _pv_truncate(
                    f"Tensor(shape={list(value.shape)}, dtype={value.dtype}, device={value.device})"
                )
                entry["value"] = val
                if full:
                    entry["full_value"] = full
            else:
                # 兜底：模型类对象（类名/模块/属性探测）若未被识别，给出摘要而非裸 repr
                _mod = type(value).__module__ or ""
                _nm = type(value).__name__
                is_model = ("model_patcher" in _mod) or ("ModelPatcher" in _nm) or getattr(value, "cached_patcher_init", None) is not None
                is_clip = (_mod.startswith("comfy.sd") and (_nm == "CLIP" or "CLIP" in _nm)) or getattr(value, "patcher", None) is not None
                is_vae = _mod.startswith("comfy.sd") and (_nm == "VAE" or "VAE" in _nm)
                if is_model or is_clip or is_vae:
                    mtype = "MODEL" if is_model else ("CLIP" if is_clip else "VAE")
                    entry["type"] = mtype
                    entry["value"] = self._object_summary(value, mtype)
                    meta = self._model_meta(value, mtype, upstream)
                    if meta:
                        entry["meta"] = meta
                else:
                    val, full = _pv_truncate(str(value))
                    entry["value"] = val
                    if full:
                        entry["full_value"] = full
        except Exception:
            try:
                # 兜底：模型/CLIP/VAE 对象即使前面某步异常，也尽量给摘要而非裸 repr
                _mod = type(value).__module__ or ""
                _nm = type(value).__name__
                if "model_patcher" in _mod or "ModelPatcher" in _nm:
                    mtype = "MODEL"
                elif _mod.startswith("comfy.sd") and ("CLIP" in _nm or _nm == "CLIP"):
                    mtype = "CLIP"
                elif _mod.startswith("comfy.sd") and ("VAE" in _nm or _nm == "VAE"):
                    mtype = "VAE"
                else:
                    mtype = None
                if mtype:
                    entry["type"] = mtype
                    entry["value"] = self._object_summary(value, mtype)
                    try:
                        meta = self._model_meta(value, mtype, upstream)
                        if meta:
                            entry["meta"] = meta
                    except Exception:
                        pass
                else:
                    entry["value"] = _pv_str(value)
                    entry["type"] = _nm.upper()
            except Exception:
                entry["value"] = _pv_str(value)
                entry["type"] = type(value).__name__.upper()
        # 视频/3D/音频等「文件不含生成元数据」的类型，若当前工作流图能提取到使用的模型/提示词/采样参数，
        # 则也挂上「生成信息」，让用户看到本次生成用了哪些模型（MODEL/CLIP/VAE 卡片已有自身元数据，不再覆盖）。
        # 但若上游是「从文件加载」（LoadImage/LoadVideo/VideoFromFile/Load3D 等），说明该值不是本次生成的，
        # 不能用当前工作流参数冒充，避免误导。
        _up_type = (upstream.get("type") or "") if isinstance(upstream, dict) else ""
        _is_file_src = ("Load" in _up_type or "FromFile" in _up_type) and "Save" not in _up_type and "Sampler" not in _up_type
        if not entry.get("gen_meta") and not entry.get("meta") and wf_meta and not _is_file_src:
            entry["gen_meta"] = json.dumps(wf_meta, ensure_ascii=False, default=str)
        return entry

    @staticmethod
    def _infer_type(value):
        if isinstance(value, torch.Tensor):
            if value.ndim == 4 and value.shape[-1] in (1, 3, 4):
                return "IMAGE"
            if value.ndim == 3 and value.shape[-1] in (1, 3, 4):
                return "IMAGE"
            if value.ndim in (2, 3):
                return "MASK"
            return "TENSOR"
        if isinstance(value, dict):
            if "samples" in value:
                return "LATENT"
            if "conditioning" in value or "context" in value:
                return "CONDITIONING"
            if "waveform" in value or "audio" in value or "sample_rate" in value:
                return "AUDIO"
            return "DICT"
        if isinstance(value, (list, tuple)):
            # 一列图像帧 -> 视频
            if len(value) > 1 and all(isinstance(x, torch.Tensor) and x.ndim in (3, 4) for x in value):
                return "VIDEO"
            if len(value) == 1 and isinstance(value[0], torch.Tensor) and value[0].ndim == 4:
                return "VIDEO"
            # 列表里含视频对象（MediaOut 卡片/卡片组/分组模式的批量输出）→ 也按视频预览
            if any(hasattr(x, "get_stream_source") or hasattr(x, "get_components") for x in value):
                return "VIDEO"
            # ComfyUI 的 CONDITIONING 是 [[cond_tensor, {…}], …]：**第二个元素**才是元数据 dict
            # （原来判的是 value[0][0]，真 CONDITIONING 一律被当成 LIST）
            if value and isinstance(value[0], (list, tuple)) and len(value[0]) >= 2 and isinstance(value[0][1], dict):
                return "CONDITIONING"
            return "LIST"
        if isinstance(value, str):
            s = value.strip()
            if s.startswith("[") and s.endswith("]"):
                return "LIST"
            if s.startswith("(") and s.endswith(")"):
                return "TUPLE"
            if s.startswith("{") and s.endswith("}") and ":" in s:
                return "DICT"
            if s.startswith("{") and s.endswith("}") and ":" not in s:
                return "SET"
            return "STRING"
        if isinstance(value, bool):
            return "BOOLEAN"
        if isinstance(value, int):
            return "INT"
        if isinstance(value, float):
            return "FLOAT"
        # ComfyUI 对象类型（按类名识别）
        cls = type(value).__name__
        if cls.startswith("VideoFrom") or "Video" in cls or cls in ("VideoFile", "VideoFrame"):
            return "VIDEO"
        if cls == "File3D" or hasattr(value, "get_source") and hasattr(value, "save_to") and hasattr(value, "format"):
            return "FILE_3D"
        mod = type(value).__module__ or ""
        # ComfyUI 0.30 的 3D 几何类型（comfy_api.latest.Types 的 MESH / SPLAT / VOXEL，
        # 出自 Hunyuan3D / Trellis / MoGe / 高斯泼溅 等节点）—— 不认的话会掉进「裸 repr」那条兜底
        if mod.endswith("geometry_types") and cls in ("MESH", "SPLAT", "VOXEL"):
            return cls
        # 模型/CLIP/VAE：按类名 + 模块判定（模块判定比属性探测更稳，覆盖 ModelPatcher 系列子类）
        if ("ModelPatcher" in cls or cls in ("CLIPModel", "ModelPatcher", "ModelPatcherDynamic")) or ("model_patcher" in mod):
            return "MODEL"
        if cls in ("CLIP",) or (mod.startswith("comfy.sd") and cls == "CLIP"):
            return "CLIP"
        if cls in ("VAE",) or (mod.startswith("comfy.sd") and cls == "VAE"):
            return "VAE"
        if cls in ("ControlNet", "ContrlNet", "Controlnet"):
            return "CONTROL_NET"
        if cls in ("CLIPVisionModel", "CLIPVision", "CLIPVisionModelWrapper", "CLIPVisionModelProjection"):
            return "CLIP_VISION"
        if cls in ("StyleModel",):
            return "STYLE_MODEL"
        if cls in ("UpscaleModel", "UpscaleModelLoader"):
            return "UPSCALE_MODEL"
        if cls in ("LoraModel", "LoRA", "Lora"):
            return "LORA_MODEL"
        if cls in ("GLIGEN",):
            return "GLIGEN"
        if cls in ("KSampler", "Sampler", "SamplerCustom"):
            return "SAMPLER"
        if cls in ("SigmaSchedule", "Sigmas", "SIGMAS"):
            return "SIGMAS"
        if cls in ("CFGGuider", "Guider"):
            return "GUIDER"
        if cls in ("Noise",):
            return "NOISE"
        if cls in ("SEGS", "Segs", "SEG"):
            return "SEGS"
        if hasattr(value, "cached_patcher_init") and "model_patcher" in mod:
            return "MODEL"
        if cls.startswith("File3D") or cls in ("File3D", "File3DAny"):
            return "MODEL_3D"
        if hasattr(value, "patcher") and mod.startswith("comfy.sd"):
            return "CLIP"
        if mod.startswith("comfy.sd"):
            if cls == "CLIP" or "CLIP" in cls:
                return "CLIP"
            if cls == "VAE" or "VAE" in cls:
                return "VAE"
        return cls.upper()

    @staticmethod
    def _image_to_base64(tensor):
        try:
            if isinstance(tensor, torch.Tensor):
                t = tensor
                if t.dim() == 3:
                    t = t.unsqueeze(0)
                if t.dim() == 4:
                    t = t[0]
                img_np = t.detach().cpu().numpy()
            else:
                return None
            img_np = np.clip(img_np * 255, 0, 255).astype(np.uint8)
            if img_np.ndim == 3 and img_np.shape[2] == 1:
                img_np = img_np[:, :, 0]
            from io import BytesIO
            from PIL import Image
            img = Image.fromarray(img_np)
            if max(img.size) > _PREVIEW_MAX_IMG_SIDE:
                img.thumbnail((_PREVIEW_MAX_IMG_SIDE, _PREVIEW_MAX_IMG_SIDE), Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="PNG", optimize=True)
            return base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            return None

    @staticmethod
    def _export_image_url(tensor):
        """保存原图到临时文件并返回可访问 URL（全屏用原图）。"""
        try:
            if isinstance(tensor, torch.Tensor):
                t = tensor
                if t.dim() == 3:
                    t = t.unsqueeze(0)
                if t.dim() == 4:
                    t = t[0]
                img_np = t.detach().cpu().numpy()
            else:
                return None
            img_np = np.clip(img_np * 255, 0, 255).astype(np.uint8)
            if img_np.ndim == 3 and img_np.shape[2] == 1:
                img_np = img_np[:, :, 0]
            from PIL import Image
            import uuid
            import tempfile
            img = Image.fromarray(img_np)
            tmp = os.path.join(folder_paths.get_temp_directory(), f"ezpv_img_{uuid.uuid4().hex}.png")
            img.save(tmp, format="PNG")
            from urllib.parse import quote
            return "/view?type=temp&filename=" + quote(os.path.basename(tmp))
        except Exception:
            return None

    @staticmethod
    def _image_summary(tensor, max_len=_PREVIEW_MAX_VALUE_LEN):
        if isinstance(tensor, torch.Tensor):
            t = tensor
            if t.dim() == 4:
                t = t[0]
            if t.dim() == 3:
                h, w = t.shape[0], t.shape[1]
                return f"{w} x {h}", None
        return _pv_truncate(str(tensor), max_len)

    @staticmethod
    def _video_file_source(value):
        """视频值底层是否对应磁盘上的文件：是则返回绝对路径（预览直接播原文件，不编码）。
        支持 VideoFromFile / 带 get_source()·path·file 的对象 / 字符串路径 / 列表·字典里的第一个视频项。"""
        def from_obj(v):
            for attr in ("get_stream_source", "get_source"):
                fn = getattr(v, attr, None)
                if callable(fn):
                    try:
                        p = fn()
                    except Exception:
                        p = None
                    if isinstance(p, str) and p and os.path.isfile(p):
                        return os.path.abspath(p)
            for attr in ("path", "file", "source_path"):
                p = getattr(v, attr, None)
                if isinstance(p, str) and p and os.path.isfile(p):
                    return os.path.abspath(p)
            if isinstance(v, str) and v and os.path.isfile(v):
                return os.path.abspath(v)
            return None
        try:
            if isinstance(value, (list, tuple)):
                for it in value:
                    hit = from_obj(it)
                    if hit:
                        return hit
                return None
            if isinstance(value, dict):
                for key in ("path", "file", "src", "video", "video_src", "frames", "images"):
                    hit = from_obj(value.get(key))
                    if hit:
                        return hit
                return None
            return from_obj(value)
        except Exception:
            return None

    @staticmethod
    def _audio_file_src(data):
        """音频：文件型用原 URL；否则把波形写临时 WAV 并返回 serve URL（流式，避免 base64 卡顿）。"""
        try:
            from urllib.parse import quote
            def _url(p):
                if isinstance(p, str) and p and os.path.exists(p):
                    return "/preview_any/serve_3d?path=" + quote(os.path.abspath(p))
                return None
            if isinstance(data, dict):
                u = _url(data.get("file") or data.get("path") or data.get("src"))
                if u:
                    return u
            elif isinstance(data, (list, tuple)):
                # 多文件（MediaOut 卡片/卡片组/分组模式）：第一个能落到文件的就用它，不重新编码
                for it in data:
                    if isinstance(it, dict):
                        u = _url(it.get("file") or it.get("path") or it.get("src"))
                    else:
                        u = _url(getattr(it, "path", None) or getattr(it, "file", None))
                    if u:
                        return u
            else:
                src = None
                if hasattr(data, "get_stream_source"):
                    try:
                        src = data.get_stream_source()
                    except Exception:
                        src = None
                if not src:
                    src = getattr(data, "path", None) or getattr(data, "file", None) or getattr(data, "name", None)
                u = _url(src)
                if u:
                    return u
            # 无文件 → 写临时 WAV
            uri = PreviewAnyNode._audio_to_data_uri(data)
            if uri and uri.startswith("data:audio/wav;base64,"):
                wav = base64.b64decode(uri.split(",", 1)[1])
                import uuid
                import tempfile
                tmp = os.path.join(folder_paths.get_temp_directory(), f"ezpv_audio_{uuid.uuid4().hex}.wav")
                with open(tmp, "wb") as fh:
                    fh.write(wav)
                return "/view?type=temp&filename=" + quote(os.path.basename(tmp))
            return None
        except Exception:
            return None

    @staticmethod
    def _audio_to_data_uri(data):
        """把 ComfyUI 音频（dict 含 waveform/sample_rate，或 (waveform, sample_rate)）编码为 WAV data URI。"""
        try:
            waveform = None
            sample_rate = 44100
            if isinstance(data, dict):
                waveform = data.get("waveform", data.get("audio"))
                sample_rate = data.get("sample_rate", sample_rate)
            elif isinstance(data, (list, tuple)) and len(data) >= 2:
                waveform, sample_rate = data[0], data[1]
            else:
                waveform = data
            if waveform is None:
                return None
            w = waveform.detach().cpu().numpy() if isinstance(waveform, torch.Tensor) else np.asarray(waveform)
            w = np.clip(w.reshape(-1), -1.0, 1.0)
            audio16 = (w * 32767).astype(np.int16)
            from io import BytesIO
            import wave
            buf = BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(int(sample_rate))
                wf.writeframes(audio16.tobytes())
            return "data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            return None

    @staticmethod
    def _audio_summary(data):
        try:
            if isinstance(data, dict):
                sample_rate = data.get("sample_rate")
                w = data.get("waveform", data.get("audio"))
                if isinstance(w, torch.Tensor):
                    return f"音频 {w.shape[-1]} 采样 @ {sample_rate}Hz" if sample_rate else f"音频 {w.shape[-1]} 采样"
                return "音频"
            if isinstance(data, (list, tuple)) and len(data) >= 2:
                sample_rate = data[1]
                w = data[0]
                if isinstance(w, torch.Tensor):
                    return f"音频 {w.shape[-1]} 采样 @ {sample_rate}Hz"
                return "音频"
            return "音频"
        except Exception:
            return "音频"

    @staticmethod
    def _video_extract_frames(value):
        """从 dict/list/tensor/Video 对象提取 (帧列表, fps)，最多 30 帧。
        优先用内存里的张量（不解码、不落盘）：Video 对象的 get_components().images 就是 [T,H,W,3]。"""
        frames = []
        fps = 8
        try:
            if isinstance(value, dict):
                f = value.get("frames") or value.get("images") or []
                if isinstance(f, (list, tuple)):
                    frames = [x for x in f if isinstance(x, torch.Tensor)]
                fps = value.get("fps", fps) or fps
            elif isinstance(value, torch.Tensor):
                if value.ndim == 4:
                    frames = [value[i] for i in range(min(value.shape[0], 30))]
                elif value.ndim == 3:
                    frames = [value]
            elif isinstance(value, (list, tuple)):
                frames = [x for x in value if isinstance(x, torch.Tensor)]
                if len(frames) == 1 and frames[0].ndim == 4:
                    frames = [frames[0][i] for i in range(min(frames[0].shape[0], 30))]
            else:
                # Video 对象（VideoFromComponents 等）：直接取 components，避免 av 解码整段视频
                if hasattr(value, "get_components"):
                    try:
                        comp = value.get_components()
                        imgs = getattr(comp, "images", None)
                        if isinstance(imgs, torch.Tensor) and imgs.ndim == 4:
                            frames = [imgs[i] for i in range(min(imgs.shape[0], 30))]
                        fr = getattr(comp, "frame_rate", None)
                        if fr:
                            fps = float(fr)
                    except Exception:
                        frames = []
                if not frames:
                    cand = None
                    for attr in ("frames", "images", "tensors", "data"):
                        cand = getattr(value, attr, None)
                        if isinstance(cand, (list, tuple)):
                            frames = [x for x in cand if isinstance(x, torch.Tensor)]
                            if frames:
                                break
                if not frames:
                    try:
                        if hasattr(value, "to_images"):
                            cand = value.to_images()
                            if isinstance(cand, (list, tuple)):
                                frames = [x for x in cand if isinstance(x, torch.Tensor)]
                    except Exception:
                        frames = []
        except Exception:
            frames = []
        if len(frames) > 30:
            frames = frames[:30]
        return frames, fps

    @staticmethod
    def _video_first_frame(data):
        """视频/多帧：返回 (首帧 base64, 帧数)。"""
        frames, _ = PreviewAnyNode._video_extract_frames(data)
        if frames:
            return (PreviewAnyNode._image_to_base64(frames[0]) if frames[0] is not None else None), len(frames)
        return None, 0

    @staticmethod
    def _video_frames(value):
        """提取视频帧列表 + fps（最多 30 帧），兼容 dict/list/VideoFromFile 对象。"""
        return PreviewAnyNode._video_extract_frames(value)

    @staticmethod
    def _video_summary(frames, fps):
        try:
            n = len(frames)
            if not n:
                return "视频"
            t = frames[0]
            if t.ndim == 4:
                t = t[0]
            if t.ndim == 3:
                return f"{n} 帧 @ {fps}fps  {t.shape[1]}x{t.shape[0]}"
            return f"{n} 帧 @ {fps}fps"
        except Exception:
            return "视频"

    @staticmethod
    def _video_to_webm(frames, fps=8):
        """把帧序列快速编码成 WebM(data URI) 供浏览器内联播放。
        只有「底层没有源文件」时才走到这里，所以按预览标准做：缩到 512 宽 + VP9 实时档（默认档很慢）。"""
        if not frames or not isinstance(frames[0], torch.Tensor):
            return None
        import av
        from io import BytesIO

        def render(fast):
            buf = BytesIO()
            rate = max(1, int(fps) if fps else 8)
            container = av.open(buf, mode="w", format="webm")
            stream = container.add_stream("libvpx-vp9", rate=rate)
            stream.pix_fmt = "yuv420p"
            if fast:
                try:
                    stream.bit_rate = 2000000
                    stream.options = {"deadline": "realtime", "cpu-used": "8", "lag-in-frames": "0"}
                except Exception:
                    pass
            for t in frames:
                np_img = t.detach().cpu().numpy()
                if np_img.ndim == 4:
                    np_img = np_img[0]
                np_img = (np.clip(np_img, 0.0, 1.0) * 255).astype(np.uint8)
                if np_img.ndim == 2:
                    np_img = np.stack([np_img] * 3, axis=-1)
                elif np_img.shape[-1] == 1:
                    np_img = np_img[:, :, 0]
                    np_img = np.stack([np_img] * 3, axis=-1)
                if np_img.shape[-1] != 3:
                    np_img = np_img[..., :3]
                if np_img.shape[1] > 512:   # 预览用：等比缩到 512 宽，编码量小一个数量级
                    from PIL import Image as _Im
                    nh = max(2, int(round(np_img.shape[0] * 512.0 / np_img.shape[1])))
                    np_img = np.asarray(_Im.fromarray(np_img).resize((512, nh), _Im.BILINEAR))
                if np_img.shape[0] % 2 or np_img.shape[1] % 2:
                    np_img = np_img[:np_img.shape[0] - (np_img.shape[0] % 2), :np_img.shape[1] - (np_img.shape[1] % 2)]
                if stream.width is None:
                    stream.width = np_img.shape[1]
                    stream.height = np_img.shape[0]
                avf = av.VideoFrame.from_ndarray(np_img, format="rgb24")
                for p in stream.encode(avf):
                    container.mux(p)
            for p in stream.encode():
                container.mux(p)
            container.close()
            return buf.getvalue()

        raw = None
        for fast in (True, False):   # 先试实时档；某些 libvpx 版本不吃这些选项，就退回默认档
            try:
                raw = render(fast)
                if raw:
                    break
            except Exception:
                raw = None
        if not raw:
            return None
        return "data:video/webm;base64," + base64.b64encode(raw).decode("ascii")

    @staticmethod
    def _video_stream_temp(value):
        """内存型视频对象 → 临时文件，返回绝对路径（失败 None）。
        value.get_stream_source() 内部走 save_to()，出来的就是「视频 + 音轨 + 原始帧率」的完整编码流
        （内置 Create Video 的 VideoFromComponents 就是这么实现的），所以直接落盘给浏览器播最省事：
        音轨、帧率、时长全都不丢，也不用再逐帧重编码。按内容哈希命名 → 同一段视频反复预览只占一个文件。"""
        try:
            src = value.get_stream_source()
        except Exception:
            return None
        try:
            if isinstance(src, str) and src and os.path.isfile(src):
                return os.path.abspath(src)
            if hasattr(src, "getvalue"):
                data = src.getvalue()
            elif isinstance(src, (bytes, bytearray)):
                data = bytes(src)
            else:
                return None
            if not data:
                return None
            fmt = ""
            try:
                import io as _io
                import av
                with av.open(_io.BytesIO(data), mode="r") as probe:
                    fmt = (probe.format.name or "").lower()
            except Exception:
                pass
            ext = ".webm" if "webm" in fmt else (".mkv" if "matroska" in fmt else (".mov" if "mov" in fmt and "mp4" not in fmt else ".mp4"))
            import hashlib
            tmp = os.path.join(folder_paths.get_temp_directory(), "ezpv_vid_" + hashlib.sha1(data).hexdigest()[:16] + ext)
            if not os.path.isfile(tmp):
                with open(tmp, "wb") as fh:
                    fh.write(data)
            return os.path.abspath(tmp)
        except Exception:
            return None

    @staticmethod
    def _video_to_webm_np(frames, fps=8):
        """用 av 把 numpy RGB 帧编码成 WebM(data URI)。"""
        if not frames:
            return None
        try:
            import av
            from io import BytesIO
            buf = BytesIO()
            rate = max(1, int(fps) if fps else 8)
            container = av.open(buf, mode="w", format="webm")
            stream = container.add_stream("libvpx-vp9", rate=rate)
            stream.pix_fmt = "yuv420p"
            stream.width = frames[0].shape[1]
            stream.height = frames[0].shape[0]
            for arr in frames:
                if arr.ndim == 2:
                    arr = np.stack([arr] * 3, axis=-1)
                elif arr.shape[-1] == 1:
                    arr = np.stack([arr[:, :, 0]] * 3, axis=-1)
                if arr.shape[-1] != 3:
                    arr = arr[..., :3]
                avf = av.VideoFrame.from_ndarray(np.ascontiguousarray(arr), format="rgb24")
                for p in stream.encode(avf):
                    container.mux(p)
            for p in stream.encode():
                container.mux(p)
            container.close()
            return "data:video/webm;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            return None

    @staticmethod
    def _image_np_to_base64(arr):
        try:
            from io import BytesIO
            from PIL import Image
            if arr.ndim == 2:
                img = Image.fromarray(arr, mode="L")
            else:
                img = Image.fromarray(arr[:, :, :3])
            if max(img.size) > _PREVIEW_MAX_IMG_SIDE:
                img.thumbnail((_PREVIEW_MAX_IMG_SIDE, _PREVIEW_MAX_IMG_SIDE), Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="PNG", optimize=True)
            return base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            return None

    @staticmethod
    def _video_np_summary(frames, fps):
        try:
            if frames:
                h, w = frames[0].shape[:2]
                return f"{len(frames)} 帧 @ {fps:.0f}fps  {w}x{h}"
        except Exception:
            pass
        return "视频"

    @staticmethod
    def _video_file_poster(src):
        """只解首帧做封面，返回 (base64, fps, (w,h))。"""
        try:
            import av
            if not (isinstance(src, str) and src and os.path.exists(src)):
                return None, 8, None
            with av.open(src, mode="r") as container:
                video = next((s for s in container.streams if s.type == "video"), None)
                if video is None:
                    return None, 8, None
                fps = float(video.average_rate) if video.average_rate else 8
                dims = (video.width, video.height)
                for frame in container.decode(video):
                    arr = frame.to_ndarray(format="rgb24")
                    return PreviewAnyNode._image_np_to_base64(arr), fps, dims
        except Exception:
            return None, 8, None
        return None, 8, None

    @staticmethod
    def _video_file_summary(fps, dims):
        try:
            if dims:
                w, h = dims
                return f"视频 @ {fps:.0f}fps  {w}x{h}"
        except Exception:
            pass
        return "视频"

    @staticmethod
    def _resolve_model_path(path):
        """把相对模型路径解析为绝对路径（遍历 ComfyUI 各模型目录，支持子路径如 画风\\风格\\Anima\\xxx.safetensors）。"""
        if not path:
            return path
        if os.path.isabs(path) and os.path.isfile(path):
            return path
        try:
            import folder_paths
            base = os.path.basename(path.replace("\\", "/"))
            rel = path.replace("\\", "/")
            for folder in ("checkpoints", "diffusion_models", "unet", "loras", "controlnet", "vae", "clip", "text_encoders", "embeddings"):
                try:
                    # 1) 相对子路径
                    fp = folder_paths.get_full_path(folder, rel)
                    if fp and os.path.isfile(fp):
                        return fp
                    # 2) 仅文件名
                    fp = folder_paths.get_full_path(folder, base)
                    if fp and os.path.isfile(fp):
                        return fp
                    # 3) 直接拼接各文件夹根目录
                    for root in folder_paths.get_folder_paths(folder):
                        cand = os.path.join(root, rel)
                        if os.path.isfile(cand):
                            return cand
                except Exception:
                    continue
        except Exception:
            pass
        return path

    @staticmethod
    def _model_file_path(value, type_name, upstream=None):
        try:
            # 优先上游加载节点的 widgets_values：能拿到真正的模型/LoRA 文件名
            # （如 LoraLoader 的 lora_name、UNETLoader 的 unet_name、CheckpointLoader 的 ckpt_name）。
            # LoRA 加载器连了模型后，预览想显示的是 LoRA 的训练词/比重等，因此优先读 LoRA 文件。
            if isinstance(upstream, dict):
                node_hint = " ".join(str(upstream.get(k) or "") for k in ("type", "title", "name"))
                is_lora_node = "lora" in node_hint.lower()
                wv = upstream.get("widgets_values") or []
                def _looks_like_file(w):
                    if not isinstance(w, str):
                        return False
                    low = w.lower()
                    if low.startswith("[") or low.startswith("{"):
                        return False
                    if low.endswith((".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx", ".lora", ".zip")):
                        return True
                    if "/" in w or "\\" in w:
                        return True
                    if "." in w and " " not in w.strip() and not low.isdigit():
                        return True
                    return False
                # ModelsCombo：widgets_values 里有一串 JSON，描述 combo 内 unet/clip/vae/lora 清单。
                # MODEL 优先取 lora（读训练词/比重），否则取 unet；CLIP/VAE 取对应类型。
                for w in wv:
                    if isinstance(w, str) and w.strip().startswith("[") and '"file"' in w:
                        try:
                            entries = json.loads(w)
                        except Exception:
                            entries = None
                        if isinstance(entries, list) and entries and all(isinstance(e, dict) for e in entries):
                            pref = {"MODEL": ["lora", "unet", "diffusion_models", "checkpoints"],
                                    "CLIP": ["clip", "text_encoders"],
                                    "VAE": ["vae"]}.get(type_name, [])
                            cand = None
                            for t in pref:
                                for e in entries:
                                    if (e.get("type") or "").lower() == t and e.get("file"):
                                        cand = e["file"]
                                        break
                                if cand:
                                    break
                            if cand:
                                rp = PreviewAnyNode._resolve_model_path(cand)
                                if rp:
                                    return rp
                        break
                # 先找通用文件/路径样式的 widget；LoRA 节点再兜底任何含 lora 的字符串
                for w in wv:
                    if _looks_like_file(w):
                        rp = PreviewAnyNode._resolve_model_path(w)
                        if rp:
                            return rp
                if is_lora_node:
                    for w in wv:
                        if isinstance(w, str) and "lora" in w.lower():
                            rp = PreviewAnyNode._resolve_model_path(w)
                            if rp:
                                return rp
            # 对象兜底：从 cached_patcher_init / patcher 取路径
            path = None
            if type_name in ("MODEL", "CONTROL_NET", "STYLE_MODEL", "UPSCALE_MODEL", "LORA_MODEL", "GLIGEN"):
                init = getattr(value, "cached_patcher_init", None)
                if init:
                    p = init[1][0]
                    path = str(p[0] if isinstance(p, (list, tuple)) else p)
            elif type_name in ("CLIP", "VAE"):
                patcher = getattr(value, "patcher", None)
                init = getattr(patcher, "cached_patcher_init", None)
                if init:
                    p = init[1][0]
                    path = str(p[0] if isinstance(p, (list, tuple)) else p)
            if path:
                return PreviewAnyNode._resolve_model_path(path)
        except Exception:
            return None
        return None

    @staticmethod
    def _model_type_str(value):
        """从模型对象提取架构/类型字符串（处理 callable 的 model_type，避免输出 bound method 的 repr）。"""
        def _clean(v):
            if v is None:
                return None
            if callable(v):
                try:
                    v = v()
                except Exception:
                    return None
            if isinstance(v, str):
                v = v.strip()
                if v:
                    return v
            return None
        try:
            # 只安全探测已知存在的 model_type，避免访问 model_config 上不存在的
            # model_type_name/architecture 触发 ComfyUI 的“accessed non-existing attr”警告。
            for obj in (value, getattr(value, "model", None)):
                if obj is None:
                    continue
                s = _clean(getattr(obj, "model_type", None))
                if s:
                    return s
            cfg = getattr(getattr(value, "model", None), "model_config", None)
            if cfg is not None:
                s = _clean(getattr(cfg, "model_type", None))
                if s:
                    return s
            # 兜底：底层模型类名（comfy.supported_models.Anima -> "anima"，Krea -> "krea" 等）
            for o in (getattr(value, "model", None), value):
                if o is None:
                    continue
                onm = type(o).__name__
                omod = type(o).__module__ or ""
                if onm and (omod.startswith("comfy.supported_models") or onm in ("Anima", "Krea", "Krea2", "Flux", "SDXL", "SD3", "Wan", "Mochi", "PixArt", "Hunyuan", "AuraFlow", "QwenImage", "Lumina", "Sana", "OmniGen", "Hidream", "Chroma", "Ace", "LongCat", "CogVideoX", "LTXVideo", "Playground", "SVD")):
                    return onm.lower()
        except Exception:
            pass
        return ""

    @staticmethod
    def _read_raw_meta(path):
        """读取模型文件的原始元数据 dict（含 ss_* / modelspec.* 等）。"""
        if not path:
            return None
        ext = os.path.splitext(path)[1].lower()
        raw = None
        try:
            if ext == ".safetensors":
                import safetensors
                with safetensors.safe_open(path, framework="pt") as f:
                    raw = f.metadata() or {}
            elif ext == ".gguf":
                import gguf
                reader = gguf.GGUFReader(path)
                raw = {k: (v.value if hasattr(v, "value") else str(v)) for k, v in reader.fields.items()}
            elif ext == ".onnx":
                import onnx
                m = onnx.load(path, load_external_data=False)
                raw = {"producer": m.producer_name or "", "graph": m.graph.name or ""}
        except Exception:
            raw = None
        return raw

    @staticmethod
    def _base_model_path(value, type_name):
        """从模型对象自身取基础模型路径（不含上游 lora）。"""
        try:
            path = None
            if type_name in ("MODEL", "CONTROL_NET", "STYLE_MODEL", "UPSCALE_MODEL", "LORA_MODEL", "GLIGEN"):
                init = getattr(value, "cached_patcher_init", None)
                if init:
                    p = init[1][0]
                    path = str(p[0] if isinstance(p, (list, tuple)) else p)
            elif type_name in ("CLIP", "VAE"):
                patcher = getattr(value, "patcher", None)
                init = getattr(patcher, "cached_patcher_init", None)
                if init:
                    p = init[1][0]
                    path = str(p[0] if isinstance(p, (list, tuple)) else p)
            if path:
                return PreviewAnyNode._resolve_model_path(path)
        except Exception:
            pass
        return None

    @staticmethod
    def _lora_file_path(value, type_name, upstream):
        """从上游节点取 LoRA 文件路径（Lora 节点的 lora_name 或 ModelsCombo 的 lora file）。"""
        if not isinstance(upstream, dict):
            return None
        try:
            node_hint = " ".join(str(upstream.get(k) or "") for k in ("type", "title", "name"))
            is_lora_node = "lora" in node_hint.lower()
            wv = upstream.get("widgets_values") or []
            # ModelsCombo：JSON 清单里的 type=lora 项
            for w in wv:
                if isinstance(w, str) and w.strip().startswith("[") and '"file"' in w:
                    try:
                        entries = json.loads(w)
                    except Exception:
                        entries = None
                    if isinstance(entries, list):
                        for e in entries:
                            if isinstance(e, dict) and (e.get("type") or "").lower() == "lora" and e.get("file"):
                                return PreviewAnyNode._resolve_model_path(e["file"])
                    break
            # Lora 节点：直接取 lora_name 之类的文件
            if is_lora_node:
                for w in wv:
                    if isinstance(w, str) and ("lora" in w.lower() or w.lower().endswith((".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".lora"))):
                        rp = PreviewAnyNode._resolve_model_path(w)
                        if rp:
                            return rp
        except Exception:
            pass
        return None

    @staticmethod
    def _build_sub_meta(path, name, type_name, value, kind):
        """把单个模型文件的元数据整理成“重要字段在前、中文标签”的 dict。kind：模型/LoRA/None。"""
        raw = PreviewAnyNode._read_raw_meta(path)
        rawd = raw or {}
        out = {}

        def pick(*keys):
            for k in keys:
                if k in rawd and rawd[k] not in (None, ""):
                    return rawd[k]
            return None

        out["名称"] = name or (os.path.basename(path) if path else (kind or "模型"))
        out["类型"] = kind or type_name
        arch = pick("modelspec.architecture", "architecture", "model_type", "ss_base_model_version", "ss_model_description", "model_type_name")
        if arch:
            out["架构"] = str(arch)
        else:
            ts = PreviewAnyNode._model_type_str(value)
            if ts:
                out["架构"] = ts
        author = pick("modelspec.author", "created_by", "ss_creator", "author")
        if author:
            out["作者/来源"] = str(author)
        org = pick("modelspec.organization", "modelspec.tags", "ss_sd_model_name", "modelspec.civitai_resources")
        if org:
            out["归属/组织"] = str(org)
        base = pick("ss_base_model_version", "base_model", "ss_sd_model_name")
        if base and kind == "LoRA":
            out["基础模型"] = str(base)
        dim = pick("ss_network_dim", "ss_network_dims")
        if dim:
            out["训练维度 dim"] = str(dim)
        alpha = pick("ss_network_alpha")
        if alpha:
            out["训练维度 alpha"] = str(alpha)
        tf = pick("ss_tag_frequency")
        if tf:
            try:
                tfv = json.loads(tf) if isinstance(tf, str) else tf
                if isinstance(tfv, dict):
                    out["训练关键词/比重"] = {k: (v[0] if isinstance(v, (list, tuple)) else v) for k, v in tfv.items()}
                else:
                    out["训练关键词/比重"] = str(tfv)
            except Exception:
                out["训练关键词/比重"] = str(tf)
        # 主要触发词：按出现次数取前若干（与完整「训练关键词/比重」并存，快速看）
        try:
            tfj = json.loads(tf) if isinstance(tf, str) else tf
            if isinstance(tfj, dict):
                items = []
                for k, v in tfj.items():
                    cnt = v[0] if isinstance(v, (list, tuple)) and len(v) > 0 else v
                    try:
                        cnt = float(cnt)
                    except Exception:
                        cnt = 0
                    items.append((k, cnt))
                items.sort(key=lambda x: -x[1])
                topw = [k for k, _ in items[:8]]
                if topw:
                    out["主要触发词"] = ", ".join(topw)
        except Exception:
            pass
        ntype = pick("ss_network_module", "ss_module", "ss_network_args", "ss_network_type")
        if ntype:
            out["网络类型"] = str(ntype)
        contains = pick("modelspec.contains")
        vae_ok = None
        if contains:
            try:
                cj = json.loads(contains) if isinstance(contains, str) else contains
                if isinstance(cj, list):
                    vae_ok = any("vae" in str(x).lower() for x in cj)
            except Exception:
                vae_ok = False
        if vae_ok is None:
            vae_ok = bool(rawd.get("ss_vae_hash") or rawd.get("vae_hash"))
        if vae_ok is not None:
            out["是否内嵌 VAE"] = "是（内置 VAE）" if vae_ok else "否（可能需外挂 VAE）"
        desc = pick("modelspec.description", "ss_model_description", "ss_training_comment", "ss_caption")
        if desc:
            out["描述"] = str(desc)
        title = pick("modelspec.title", "ss_model_name")
        if title and title != name:
            out["模型名"] = str(title)
        ver = pick("modelspec.sd_version", "modelspec.version", "modelspec.schema_version", "ss_version", "modelspec.training_version")
        if ver and str(ver) != str(arch):
            out["版本"] = str(ver)
        use_prompt = pick("modelspec.usage")
        if use_prompt and str(use_prompt) != str(desc):
            out["使用提示词/触发词"] = str(use_prompt)
        src = None
        for k in ("modelspec.civitai_resources", "civitai_resources", "modelspec.usage"):
            v = rawd.get(k)
            if not v:
                continue
            tv = v
            try:
                if isinstance(v, str):
                    tv = json.loads(v)
            except Exception:
                tv = v
            if isinstance(tv, dict):
                for sub in (tv.get("url"), tv.get("uri"), tv.get("link"), tv.get("source"), tv.get("model_url"), tv.get("download_url")):
                    if isinstance(sub, str) and sub.startswith("http"):
                        src = sub
                        break
                if not src:
                    for sub in tv.values():
                        if isinstance(sub, str) and sub.startswith("http"):
                            src = sub
                            break
                if not src and (tv.get("modelId") or tv.get("model_id") or tv.get("model_id") is not None):
                    mid = tv.get("modelId") if tv.get("modelId") is not None else tv.get("model_id")
                    if mid is not None:
                        src = "https://civitai.com/models/" + str(mid)
            elif isinstance(tv, str) and tv.startswith("http"):
                src = tv
            if src:
                break
        if not src:
            for k in ("ss_training_comment", "modelspec.description", "ss_model_description"):
                v = rawd.get(k)
                if isinstance(v, str):
                    m = re.search(r"https?://[^\s\"'<>]+", v)
                    if m:
                        src = m.group(0)
                        break
        if src:
            out["来源/链接"] = str(src)
        # 常用训练参数（放中间，较次要）
        tr = {}
        for k in ("ss_optimizer", "ss_optimizer_args", "ss_learning_rate", "ss_lr", "ss_unet_lr", "ss_text_encoder_lr",
                  "ss_train_batch_size", "ss_batch_size", "ss_num_batches_per_epoch", "ss_training_steps", "ss_epoch",
                  "ss_resolution", "ss_clip_skip", "ss_mixed_precision", "ss_noise_offset", "ss_prior_loss_weight",
                  "ss_seed", "ss_gradient_accumulation_steps", "ss_warmup_steps", "ss_keep_tokens", "ss_shuffle_caption",
                  "ss_caption_dropout_rate", "ss_tag_dropout_rate", "ss_enable_bucket", "ss_min_bucket_reso", "ss_max_bucket_reso",
                  "ss_bucket_info", "ss_num_images", "ss_dataset_repeats", "ss_cache_latents", "ss_flip_aug", "ss_color_aug",
                  "ss_output_name", "ss_sd_model_hash", "ss_vae_hash", "ss_text_encoder_hash", "ss_full_bf16",
                  "ss_lowram", "ss_latents_upscaler", "ss_prior_loss_weight"):
            if k in rawd and rawd[k] not in (None, ""):
                try:
                    tr[k] = json.loads(rawd[k]) if isinstance(rawd[k], str) and (rawd[k].strip().startswith("{") or rawd[k].strip().startswith("[")) else rawd[k]
                except Exception:
                    tr[k] = rawd[k]
        if tr:
            out["训练参数"] = tr
        if path:
            out["文件"] = os.path.basename(path)
            out["存放路径"] = os.path.abspath(path)
            try:
                sz = os.path.getsize(path)
                out["大小"] = _fmt_size(sz)
                if sz <= (1 << 30):
                    out["哈希值"] = _sha256(path)
                else:
                    out["哈希值"] = "(大文件未计算，避免阻塞)"
            except Exception:
                pass
            try:
                out["修改时间"] = _fmt_mtime(os.path.getmtime(path))
            except Exception:
                pass
        if raw:
            out["全部元数据"] = raw
        return out

    @staticmethod
    def _model_meta(value, type_name, upstream=None):
        """读取模型元数据，按 模型/LoRA 分叉、重要字段在前、中文标签排版，返回 JSON 字符串供前端键值树。"""
        try:
            base_path = PreviewAnyNode._base_model_path(value, type_name)
            lora_path = PreviewAnyNode._lora_file_path(value, type_name, upstream)
            name = PreviewAnyNode._extract_name(value, type_name)
            if lora_path and lora_path != base_path:
                result = {
                    "模型": PreviewAnyNode._build_sub_meta(base_path, name, type_name, value, "模型"),
                    "LoRA": PreviewAnyNode._build_sub_meta(lora_path, os.path.splitext(os.path.basename(lora_path))[0] if lora_path else "LoRA", type_name, value, "LoRA")
                }
            else:
                result = PreviewAnyNode._build_sub_meta(base_path or lora_path, name, type_name, value, None)
            return json.dumps(result, ensure_ascii=False, default=str)
        except Exception:
            return None

    @staticmethod
    def _read_image_text_chunks(path):
        """读取图片内嵌文本块（ComfyUI 的 prompt/workflow，WebUI 的 parameters 等）。"""
        try:
            from PIL import Image
            im = Image.open(path)
            info = im.info or {}
            return {k: v for k, v in info.items() if isinstance(v, str)}
        except Exception:
            return {}

    @staticmethod
    def _parse_img_meta(text):
        """把图片文本块解析成结构化 dict（模型/LoRA/CLIP/VAE/提示词/采样参数 + 原始块）。"""
        out = {}
        try:
            prompt = None
            if "prompt" in text:
                try:
                    prompt = json.loads(text["prompt"])
                except Exception:
                    prompt = None
            parameters = text.get("parameters")
            nodes = prompt if isinstance(prompt, dict) else None
            model, lora, clip, vae, prompts, neg, sampler = [], [], [], [], [], [], {}

            def ct(n):
                return (n.get("class_type") or "") if isinstance(n, dict) else ""

            def inp(n):
                return (n.get("inputs") or {}) if isinstance(n, dict) else {}

            def _combo_append(entries, model, lora, clip, vae):
                if isinstance(entries, list):
                    for e in entries:
                        if not isinstance(e, dict):
                            continue
                        t = (e.get("type") or "").lower()
                        f = e.get("file")
                        if not f:
                            continue
                        if t == "lora":
                            lora.append(f)
                        elif t in ("unet", "checkpoint", "diffusion_models", "model"):
                            model.append(f)
                        elif t in ("clip", "text_encoders"):
                            clip.append(f)
                        elif t == "vae":
                            vae.append(f)

            def _try_combo(val, model, lora, clip, vae):
                if isinstance(val, str) and val.strip().startswith("[") and '"file"' in val:
                    try:
                        _combo_append(json.loads(val), model, lora, clip, vae)
                    except Exception:
                        pass

            if nodes:
                for _dummy, n in nodes.items():
                    c = ct(n)
                    i = inp(n)
                    if "Checkpoint" in c or c in ("UNETLoader", "ModelSamplingSD3", "ModelSamplingAuraFlow", "LoraLoaderModelOnly"):
                        for k in ("ckpt_name", "model_name", "unet_name", "checkpoint"):
                            if isinstance(i.get(k), str):
                                model.append(i[k])
                    if "Lora" in c and isinstance(i.get("lora_name"), str):
                        lora.append(i["lora_name"])
                    if "VAE" in c and isinstance(i.get("vae_name"), str):
                        vae.append(i["vae_name"])
                    if "CLIPLoader" in c and isinstance(i.get("clip_name"), str):
                        clip.append(i["clip_name"])
                    if "CLIPTextEncode" in c and isinstance(i.get("text"), str):
                        prompts.append(i["text"])
                    if ("CLIPSetLastLayer" in c or "SetClip" in c or "CLIPLastLayer" in c) and "clip_skip" in i:
                        clip.append("clip_skip=" + str(i["clip_skip"]))
                    if ("Sampler" in c or "KSampler" in c or "SamplerCustom" in c):
                        for k in ("seed", "steps", "cfg", "sampler_name", "scheduler"):
                            if k in i:
                                sampler[k] = str(i[k])
                    # 组合配置（EzFlex-ModelsCombo 等）：inputs 里可能出现描述 unet/clip/vae/lora 的 JSON 数组
                    for v in i.values():
                        _try_combo(v, model, lora, clip, vae)
            # workflow 图兜底：当只有 workflow 文本块、或多个节点用类 type 表示时也能提取
            wf = None
            if "workflow" in text:
                try:
                    wf = json.loads(text["workflow"])
                except Exception:
                    wf = None
            if isinstance(wf, dict):
                for n in (wf.get("nodes") or []):
                    if not isinstance(n, dict):
                        continue
                    c = (n.get("type") or "")
                    wv = n.get("widgets_values") or []
                    if "Checkpoint" in c or c in ("UNETLoader", "CheckpointLoaderSimple", "ModelSamplingSD3", "LoraLoaderModelOnly"):
                        for w in wv:
                            if isinstance(w, str) and w.lower().endswith((".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".bin")) and "lora" not in w.lower():
                                model.append(w)
                                break
                    if "Lora" in c:
                        for w in wv:
                            if isinstance(w, str) and w.lower().endswith((".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".lora")):
                                lora.append(w)
                                break
                    if "VAE" in c:
                        for w in wv:
                            if isinstance(w, str) and w.lower().endswith((".safetensors", ".pt", ".ckpt")):
                                vae.append(w)
                                break
                    if "CLIPLoader" in c:
                        for w in wv:
                            if isinstance(w, str) and w.lower().endswith((".safetensors", ".pt", ".ckpt")):
                                clip.append(w)
                                break
                    for w in wv:
                        _try_combo(w, model, lora, clip, vae)
            # 通用回退：不依赖硬编码节点类名，扫描所有节点 input，按「像模型文件名的字符串」归类，
            # 覆盖 krea2 / flux2 / qwen 等新加载器或使用自定义节点时 prompt 元数据的提取。
            if nodes:
                def _mf(s):
                    s = str(s)
                    return s.lower().endswith((".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx", ".lora", ".zip"))
                for _dummy, n in nodes.items():
                    c = (ct(n) or "").lower()
                    i = inp(n)
                    for k, v in i.items():
                        if isinstance(v, str) and not v.strip():
                            continue
                        kl = (k or "").lower()
                        if isinstance(v, str) and _mf(v):
                            if "lora" in kl or "lora" in c:
                                lora.append(v)
                            elif "vae" in kl or "vae" in c:
                                vae.append(v)
                            elif "clip" in kl or "clip" in c:
                                clip.append(v)
                            elif any(x in kl for x in ("ckpt", "checkpoint", "unet", "model", "diffusion")) or any(x in c for x in ("checkpoint", "unet", "diffusion", "loadmodel", "load_model")):
                                model.append(v)
                        if isinstance(v, str) and kl == "text" and any(x in c for x in ("encode", "text", "prompt")):
                            prompts.append(v)
                        if any(x in c for x in ("sampler",)) and kl in ("seed", "steps", "cfg", "sampler_name", "scheduler", "denoise", "guidance"):
                            sampler[kl] = str(v)
                    for v in i.values():
                        _try_combo(v, model, lora, clip, vae)
            if parameters:
                lines = [l for l in str(parameters).splitlines() if l.strip()]
                if lines:
                    prompts.insert(0, lines[0])
                for l in lines[1:]:
                    if l.strip().lower().startswith("negative prompt:"):
                        neg.append(l.split(":", 1)[1].strip())
                if lines:
                    for kv in lines[-1].split(","):
                        if ":" in kv:
                            k, v = kv.split(":", 1)
                            k = k.strip()
                            if k in ("Steps", "Sampler", "CFG scale", "Seed", "Model", "VAE", "Model hash", "Clip skip", "Lora hashes", "RNG", "Schedule type"):
                                sampler[k] = v.strip()
                                if k == "Model":
                                    model.append(v.strip())
            if model:
                out["模型"] = list(dict.fromkeys(model))
            if lora:
                out["LoRA"] = list(dict.fromkeys(lora))
            if clip:
                out["CLIP"] = list(dict.fromkeys(clip))
            if vae:
                out["VAE"] = list(dict.fromkeys(vae))
            if prompts:
                out["提示词"] = prompts
            if neg:
                out["反向提示词"] = neg
            if sampler:
                out["采样参数"] = sampler
            rawc = {k: text[k] for k in ("prompt", "workflow", "parameters") if k in text}
            if rawc:
                out["原始文本块"] = rawc
        except Exception:
            pass
        return out

    @staticmethod
    def _image_gen_meta(upstream):
        """从上游节点的 image 文件名读取生成图片的元信息，返回结构化 dict（无则 None）。"""
        if not isinstance(upstream, dict):
            return None
        try:
            wv = upstream.get("widgets_values") or []
            fname = None
            for w in wv:
                if isinstance(w, str) and w.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                    fname = w
                    break
            if not fname:
                return None
            path = None
            try:
                import folder_paths
                base = fname.replace("\\", "/")
                name = os.path.basename(base)
                # 生成图通常在 output/，也兼容 temp/input/；filename 可能是子路径
                for root in (folder_paths.get_output_directory(), folder_paths.get_temp_directory(), folder_paths.get_input_directory()):
                    if not root:
                        continue
                    for cand in (os.path.join(root, base), os.path.join(root, name)):
                        if os.path.isfile(cand):
                            path = cand
                            break
                    if path:
                        break
                if not path:
                    try:
                        path = folder_paths.get_full_path("input", name) or None
                    except Exception:
                        path = None
            except Exception:
                path = fname if fname and os.path.isfile(fname) else None
            if not path or not os.path.isfile(path):
                return None
            text = PreviewAnyNode._read_image_text_chunks(path)
            if not text:
                return None
            parsed = PreviewAnyNode._parse_img_meta(text)
            parsed["来源文件"] = os.path.basename(path)
            return parsed
        except Exception:
            return None

    @staticmethod
    def _file_gen_meta(path):
        """读取任意输出文件的生成/容器元信息。顺序：PIL 内嵌文本块（PNG/WEBP/JPEG/动画 webp）→ 同名 sidecar
        JSON/txt → 容器内嵌元数据（GLB/glTF asset/extras、视频 ffprobe/音频 mutagen 标签）。无则 None。"""
        if not path or not os.path.isfile(path):
            return None
        text = PreviewAnyNode._read_image_text_chunks(path)
        if text:
            parsed = PreviewAnyNode._parse_img_meta(text)
            if parsed:
                parsed["来源文件"] = os.path.basename(path)
                return parsed
        sc = PreviewAnyNode._read_sidecar_meta(path)
        if sc:
            sc.setdefault("来源文件", os.path.basename(path))
            return sc
        cont = PreviewAnyNode._container_meta(path)
        if cont:
            cont.setdefault("来源文件", os.path.basename(path))
            return cont
        return None

    @staticmethod
    def _read_sidecar_meta(path):
        """查找同名的 <base>.json / <base>.metadata.json / <file>.json / <base>.txt，能读到就返回其内容。"""
        try:
            base = os.path.splitext(path)[0]
            cands = [base + ".json", base + ".metadata.json", path + ".json", base + ".txt"]
            for c in cands:
                if not os.path.isfile(c):
                    continue
                try:
                    with open(c, "r", encoding="utf-8", errors="replace") as f:
                        raw = f.read()
                except Exception:
                    continue
                if c.lower().endswith(".txt"):
                    return {"原始文本块": raw[:200000]}
                try:
                    data = json.loads(raw)
                except Exception:
                    return {"原始文本块": raw[:200000]}
                if isinstance(data, dict):
                    return data
                if isinstance(data, list):
                    return {"数据": data}
            return None
        except Exception:
            return None

    @staticmethod
    def _container_meta(path):
        """容器内嵌元数据：GLB/glTF 资产信息（extras/generator），视频容器标签（ffprobe），音频标签（mutagen）。"""
        try:
            ext = os.path.splitext(path)[1].lower()
            if ext == ".glb":
                return PreviewAnyNode._glb_meta(path)
            if ext == ".gltf":
                return PreviewAnyNode._gltf_meta(path)
            if ext in (".mp4", ".webm", ".mov", ".m4v", ".mkv"):
                return PreviewAnyNode._video_container_meta(path)
            if ext in (".mp3", ".flac", ".ogg", ".m4a", ".wav", ".opus"):
                return PreviewAnyNode._audio_tag_meta(path)
            return None
        except Exception:
            return None

    @staticmethod
    def _glb_meta(path):
        with open(path, "rb") as f:
            header = f.read(12)
            if len(header) < 12 or header[:4] != b"glTF":
                return None
            chunk_len, _chunk_type = struct.unpack("<II", f.read(8))
            data = json.loads(f.read(chunk_len).decode("utf-8", "replace"))
        out = {}
        if isinstance(data.get("asset"), dict):
            out["资产"] = data["asset"]
        if data.get("extras"):
            out["附加信息"] = data["extras"]
        if data.get("meshes"):
            out["网格数"] = len(data["meshes"])
        if data.get("materials"):
            out["材质数"] = len(data["materials"])
        if data.get("animations"):
            out["动画数"] = len(data["animations"])
        return out if out else None

    @staticmethod
    def _gltf_meta(path):
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
        out = {}
        if isinstance(data.get("asset"), dict):
            out["资产"] = data["asset"]
        if data.get("extras"):
            out["附加信息"] = data["extras"]
        if data.get("meshes"):
            out["网格数"] = len(data["meshes"])
        if data.get("materials"):
            out["材质数"] = len(data["materials"])
        if data.get("animations"):
            out["动画数"] = len(data["animations"])
        return out if out else None

    @staticmethod
    def _video_container_meta(path):
        try:
            import json as _json
            import shutil
            import subprocess
            ffprobe = shutil.which("ffprobe")
            if ffprobe:
                out = subprocess.run(
                    [ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
                    capture_output=True, text=True, timeout=12,
                )
                if out.returncode == 0 and out.stdout:
                    data = _json.loads(out.stdout)
                    res = {}
                    fmt = data.get("format", {}) or {}
                    tags = fmt.get("tags") or {}
                    if isinstance(tags, dict) and tags:
                        res["容器标签"] = tags
                    for st in (data.get("streams") or []):
                        codec = st.get("codec_type")
                        if codec:
                            res.setdefault("流", []).append({
                                codec: st.get("codec_name"),
                                "宽": st.get("width"),
                                "高": st.get("height"),
                                "时长": st.get("duration"),
                                "fps": st.get("avg_frame_rate"),
                            })
                    return res if res else None
            try:
                import mutagen
            except Exception:
                return None
            m = mutagen.File(path)
            if m and getattr(m, "tags", None):
                return {"标签": {str(k): str(v) for k, v in m.tags.items() if str(v)}}
            return None
        except Exception:
            return None

    @staticmethod
    def _audio_tag_meta(path):
        try:
            import mutagen
        except Exception:
            return None
        try:
            m = mutagen.File(path)
            if m and getattr(m, "tags", None):
                return {"标签": {str(k): str(v) for k, v in m.tags.items() if str(v)}}
            if m and hasattr(m, "info"):
                info = {}
                for attr in ("length", "bitrate", "sample_rate", "channels"):
                    try:
                        v = getattr(m.info, attr)
                        if v is not None:
                            info[attr] = v
                    except Exception:
                        pass
                if info:
                    return {"音频": info}
            return None
        except Exception:
            return None

    @staticmethod
    def _workflow_gen_meta(workflow):
        """从当前工作流图（extra_pnginfo['workflow'] 的 nodes/widgets_values）尽力提取使用的模型/LoRA/CLIP/VAE、
        提示词与采样参数，供视频/3D/音频等「容器不内嵌元数据」的类型也看到生成的模型参数。无则 None。"""
        if not isinstance(workflow, dict):
            return None
        nodes = workflow.get("nodes") or []
        model, lora, clip, vae, prompts, sampler = [], [], [], [], [], {}
        _MODEL_EXT = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx", ".lora", ".zip")

        def _is_model_ext(s):
            return isinstance(s, str) and s.lower().endswith(_MODEL_EXT)

        def _num(v):
            try:
                float(v)
                return True
            except Exception:
                return False

        for n in nodes:
            if not isinstance(n, dict):
                continue
            c = (n.get("type") or "")
            cl = c.lower()
            wv = n.get("widgets_values") or []
            if not isinstance(wv, (list, tuple)):
                wv = [wv]
            for w in wv:
                if not isinstance(w, str):
                    continue
                wl = w.lower()
                if wl.endswith(_MODEL_EXT):
                    if "lora" in cl:
                        lora.append(w)
                    elif "vae" in cl:
                        vae.append(w)
                    elif "clip" in cl:
                        clip.append(w)
                    elif any(x in cl for x in ("checkpoint", "unet", "diffusion", "loadmodel", "load_model", "model")):
                        model.append(w)
            # 提示词：CLIPTextEncode / 带 text 的编码节点，取第一个非模型文件名的文本 widget
            if ("clip" in cl and "encode" in cl) or "text" in cl or "prompt" in cl:
                for w in wv:
                    if isinstance(w, str) and w.strip() and not _is_model_ext(w):
                        prompts.append(w)
                        break
            # 采样参数：K/Sampler 常见 widget 顺序尽力推断（含 control_after_generate 偏移）
            if "sampler" in cl and isinstance(wv, (list, tuple)) and len(wv) >= 3:
                has_ctrl = len(wv) > 1 and isinstance(wv[1], str) and wv[1].lower() in ("randomize", "fixed", "increment", "decrement")
                off = 1 if has_ctrl else 0
                if _num(wv[0]):
                    sampler["seed"] = str(wv[0])
                steps_i = 1 + off
                if len(wv) > steps_i and _num(wv[steps_i]):
                    sampler["steps"] = str(wv[steps_i])
                if len(wv) > steps_i + 1 and _num(wv[steps_i + 1]):
                    sampler["cfg"] = str(wv[steps_i + 1])
                if len(wv) > steps_i + 2 and isinstance(wv[steps_i + 2], str):
                    sampler["sampler_name"] = wv[steps_i + 2]
                if len(wv) > steps_i + 3 and isinstance(wv[steps_i + 3], str) and not _num(wv[steps_i + 3]):
                    sampler["scheduler"] = wv[steps_i + 3]
                if len(wv) > steps_i + 4 and _num(wv[steps_i + 4]):
                    sampler["denoise"] = str(wv[steps_i + 4])
        out = {}
        if model:
            out["模型"] = list(dict.fromkeys(model))
        if lora:
            out["LoRA"] = list(dict.fromkeys(lora))
        if clip:
            out["CLIP"] = list(dict.fromkeys(clip))
        if vae:
            out["VAE"] = list(dict.fromkeys(vae))
        if prompts:
            out["提示词"] = list(dict.fromkeys(prompts))
        if sampler:
            out["采样参数"] = sampler
        return out if out else None

    @staticmethod
    def _mask_to_base64(tensor):
        """灰度 mask (H,W)/(B,H,W) -> PNG base64。"""
        try:
            t = tensor
            if t.dim() == 3 and t.shape[-1] == 1:
                t = t[..., 0]
            if t.dim() == 3:
                t = t[0]
            arr = np.clip(t.detach().cpu().numpy(), 0.0, 1.0)
            arr = (arr * 255).astype(np.uint8)
            from io import BytesIO
            from PIL import Image
            img = Image.fromarray(arr, mode="L")
            if max(img.size) > _PREVIEW_MAX_IMG_SIDE:
                img.thumbnail((_PREVIEW_MAX_IMG_SIDE, _PREVIEW_MAX_IMG_SIDE), Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="PNG", optimize=True)
            return base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            return None

    @staticmethod
    def _export_mask_url(tensor):
        """保存灰度 mask 原图到临时文件并返回 URL（全屏用原图）。"""
        try:
            t = tensor
            if isinstance(t, torch.Tensor):
                if t.dim() == 3 and t.shape[-1] == 1:
                    t = t[..., 0]
                if t.dim() == 3:
                    t = t[0]
                arr = np.clip(t.detach().cpu().numpy(), 0.0, 1.0)
            else:
                return None
            arr = (arr * 255).astype(np.uint8)
            from PIL import Image
            import uuid
            import tempfile
            img = Image.fromarray(arr, mode="L")
            tmp = os.path.join(folder_paths.get_temp_directory(), f"ezpv_mask_{uuid.uuid4().hex}.png")
            img.save(tmp, format="PNG")
            from urllib.parse import quote
            return "/view?type=temp&filename=" + quote(os.path.basename(tmp))
        except Exception:
            return None

    @staticmethod
    def _conditioning_summary(value):
        try:
            if isinstance(value, (list, tuple)):
                parts = []
                for item in value:
                    if isinstance(item, list) and item:
                        cond = item[0]
                        if isinstance(cond, torch.Tensor):
                            parts.append(f"emb{list(cond.shape)}")
                        elif isinstance(cond, dict):
                            parts.append(",".join(str(k) for k in cond.keys()))
                        else:
                            parts.append(str(type(cond).__name__))
                    elif isinstance(item, dict):
                        parts.append(",".join(str(k) for k in item.keys()))
                    else:
                        parts.append(str(type(item).__name__))
                return "Conditioning: " + " ".join(parts)
            return "Conditioning"
        except Exception:
            return "Conditioning"

    @staticmethod
    def _object_summary(value, type_name):
        try:
            name = None
            if type_name in ("MODEL", "CLIP", "VAE"):
                try:
                    name = PreviewAnyNode._extract_name(value, type_name)
                except Exception:
                    name = None
            arch = ""
            if type_name in ("MODEL", "CLIP", "VAE"):
                try:
                    arch = PreviewAnyNode._model_type_str(value) or ""
                except Exception:
                    arch = ""
            parts = [p for p in (name, arch) if p]
            if parts:
                return f"{type_name}: {', '.join(parts)}"
            return f"{type_name} object ({type(value).__name__})"
        except Exception:
            return f"{type_name} object ({type(value).__name__})"

    @staticmethod
    def _object_3d_summary(value):
        try:
            fmt = getattr(value, "format", None) or ""
            path = getattr(value, "path", None) or getattr(value, "file", None) or _file3d_source(value)
            name = os.path.basename(str(path)) if path else ""
            if fmt:
                return f"3D 模型 ({fmt})" + (f": {name}" if name else "")
            return f"3D 模型 ({type(value).__name__})" + (f": {name}" if name else "")
        except Exception:
            return f"3D 模型 ({type(value).__name__})"

    @staticmethod
    def _geometry_summary(value, type_name):
        """MESH / SPLAT / VOXEL（都是张量，不是文件）的文本摘要：张量形状 + 关键数量，不再掉进裸 repr。"""
        try:
            if type_name == "MESH":
                v = getattr(value, "vertices", None)
                f = getattr(value, "faces", None)
                nv = int(v.shape[1]) if isinstance(v, torch.Tensor) and v.ndim == 3 else 0
                nf = int(f.shape[1]) if isinstance(f, torch.Tensor) and f.ndim == 3 else 0
                batch = int(v.shape[0]) if isinstance(v, torch.Tensor) and v.ndim == 3 else 1
                vc, fc = getattr(value, "vertex_counts", None), getattr(value, "face_counts", None)
                if isinstance(vc, torch.Tensor) and vc.numel():
                    nv = int(vc.reshape(-1)[0])
                if isinstance(fc, torch.Tensor) and fc.numel():
                    nf = int(fc.reshape(-1)[0])
                extra = [k for k, attr in (("UV", "uvs"), ("顶点色", "vertex_colors"), ("贴图", "texture")) if getattr(value, attr, None) is not None]
                return (f"网格 {nv} 顶点 / {nf} 面" + (f" ×{batch}" if batch > 1 else "")
                        + ("（" + " · ".join(extra) + "）" if extra else ""))
            if type_name == "SPLAT":
                p = getattr(value, "positions", None)
                sh = getattr(value, "sh", None)
                n = int(p.shape[1]) if isinstance(p, torch.Tensor) and p.ndim == 3 else 0
                k = int(sh.shape[-2]) if isinstance(sh, torch.Tensor) and sh.ndim == 4 else 0
                deg = int(round(k ** 0.5)) - 1 if k else 0
                return f"高斯泼溅 {n} 点" + (f" · SH {k} 系数（阶数 {deg}）" if k else "") + "（暂不支持可视化）"
            d = getattr(value, "data", None)
            shape = "×".join(str(x) for x in d.shape) if isinstance(d, torch.Tensor) else ""
            res = getattr(value, "resolution", None)
            return ("体素 " + shape if shape else "体素") + (f" · 分辨率 {res}" if res else "") + "（暂不支持可视化）"
        except Exception:
            return {"MESH": "网格", "SPLAT": "高斯泼溅"}.get(type_name, "体素")

    @staticmethod
    def _mesh_obj_url(value):
        """Types.MESH（顶点/面张量）→ 临时 .obj，交给 PreviewAny 的 3D 查看器（只导几何：贴图/顶点色/UV 不写）。
        按内容 sha1 命名，同一网格反复预览只占一个文件；过大的网格不导（避免几百 MB 的 OBJ）。"""
        try:
            v = getattr(value, "vertices", None)
            f = getattr(value, "faces", None)
            if not (isinstance(v, torch.Tensor) and isinstance(f, torch.Tensor)):
                return None
            if v.numel() == 0 or f.numel() == 0:
                return None
            verts = (v[0] if v.ndim == 3 else v).detach().cpu().float().numpy()
            faces = (f[0] if f.ndim == 3 else f).detach().cpu().long().numpy()
            vc, fc = getattr(value, "vertex_counts", None), getattr(value, "face_counts", None)
            if isinstance(vc, torch.Tensor) and vc.numel():
                verts = verts[: max(1, int(vc.reshape(-1)[0]))]
            if isinstance(fc, torch.Tensor) and fc.numel():
                faces = faces[: max(1, int(fc.reshape(-1)[0]))]
            if verts.shape[0] > 500000 or faces.shape[0] > 1000000:
                return None
            lines = ["# EzFlex PreviewAny mesh"]
            lines += [f"v {a:.6g} {b:.6g} {c:.6g}" for a, b, c in verts[:, :3]]
            lines += [f"f {int(a) + 1} {int(b) + 1} {int(c) + 1}" for a, b, c in faces[:, :3]]
            data = ("\n".join(lines) + "\n").encode("utf-8")
            import hashlib
            tmp = os.path.join(folder_paths.get_temp_directory(), "ezpv3d_mesh_" + hashlib.sha1(data).hexdigest()[:16] + ".obj")
            if not os.path.isfile(tmp):
                with open(tmp, "wb") as fh:
                    fh.write(data)
            from urllib.parse import quote
            return "/view?type=temp&filename=" + quote(os.path.basename(tmp))
        except Exception:
            return None

    @staticmethod
    def _export_3d_url(value):
        """返回 3D 模型可访问 URL。优先用 path-based URL（/preview_any/fs/<abs>）以便外部贴图/缓冲的相对路径正确解析，否则 save_to 导出。"""
        try:
            path = getattr(value, "path", None) or getattr(value, "file", None) or _file3d_source(value)
            safe_path = _ez_inside(path) if isinstance(path, str) and path else ""   # 只给允许目录内的模型 path-URL
            if safe_path and os.path.isfile(safe_path):
                from urllib.parse import quote
                abs_p = safe_path.replace("\\", "/")
                return "/preview_any/fs/" + quote(abs_p, safe="/")
            if not hasattr(value, "save_to"):
                return None
            fmt = getattr(value, "format", None) or "glb"
            import uuid
            import tempfile
            tmp = os.path.join(folder_paths.get_temp_directory(), f"ezpv3d_{uuid.uuid4().hex}.{fmt}")
            value.save_to(tmp)
            if os.path.exists(tmp):
                from urllib.parse import quote
                return "/view?type=temp&filename=" + quote(os.path.basename(tmp))
        except Exception:
            return None
        return None

    @staticmethod
    def _output_dir():
        try:
            paths = folder_paths.get_folder_paths("output")
            if paths:
                return paths[0]
        except Exception:
            pass
        return getattr(folder_paths, "output_directory", os.getcwd())

    @staticmethod
    def _sanitize_filename(name):
        import re
        s = re.sub(r"[\\/:*?\"<>|]+", "_", str(name)).strip() or "preview"
        return s[:80]

    def _maybe_save(self, entry, cfg, name, extra_pnginfo=None):
        """存档开启时把卡片内容写到 <output>/<savePath>/，并回填 saved_path。
        图片存档用「原图」（与全屏同一份导出文件），不是预览缩图；PNG 会带上工作流/提示词元数据（对齐内置 Save Image）。"""
        if not cfg.get("save"):
            return entry
        data = None
        ext = None
        sf = cfg.get("saveFormats") or {}
        if entry.get("preview"):
            try:
                raw = base64.b64decode(entry["preview"])       # 兜底：预览图（MASK 等没有原图导出时）
                img_cfg = sf.get("image")
                fmt = "png"; quality = 95
                if isinstance(img_cfg, dict):
                    fmt = img_cfg.get("fmt", "png") or "png"
                    try: quality = int(img_cfg.get("quality", 95))
                    except Exception: quality = 95
                from io import BytesIO
                from PIL import Image as _Im
                # 优先用原图文件（_export_image_url 导出的全分辨率 PNG，全屏看的就是它）
                src_file = None
                try:
                    u = entry.get("image_src") or ""
                    if u.startswith("/view?"):
                        from urllib.parse import urlparse, parse_qs, unquote
                        q = parse_qs(urlparse(u).query)
                        fn = (q.get("filename") or [""])[0]
                        if q.get("type", ["temp"])[0] == "temp" and fn:
                            cand = os.path.join(folder_paths.get_temp_directory(), os.path.basename(unquote(fn)))
                            if os.path.isfile(cand):
                                src_file = cand
                    elif u.startswith("/preview_any/fs/"):
                        from urllib.parse import unquote
                        cand = unquote(u[len("/preview_any/fs/"):])
                        if os.path.isfile(cand):
                            src_file = cand
                except Exception:
                    src_file = None
                meta = None
                if isinstance(extra_pnginfo, dict) and extra_pnginfo:
                    meta = {}
                    for k, v in extra_pnginfo.items():
                        try:
                            meta[str(k)] = json.dumps(v)
                        except Exception:
                            pass
                if fmt == "png":
                    if src_file and not meta:
                        data = open(src_file, "rb").read(); ext = ".png"      # 原图直存：零重编码、零损失
                    elif src_file:
                        png = _Im.open(src_file)
                        buf = BytesIO()
                        try:
                            from PIL.PngImagePlugin import PngInfo
                            info = PngInfo()
                            for k, v in meta.items():
                                info.add_text(k, v)
                            png.save(buf, format="PNG", pnginfo=info)
                        except Exception:
                            png.save(buf, format="PNG")
                        data = buf.getvalue(); ext = ".png"
                    else:
                        data = raw; ext = ".png"
                else:
                    img = _Im.open(src_file) if src_file else _Im.open(BytesIO(raw))
                    buf = BytesIO()
                    kwargs = {"quality": quality} if fmt in ("jpeg", "webp") else {}
                    if fmt == "jpeg" and img.mode not in ("RGB", "L"):
                        img = img.convert("RGB")
                    img.save(buf, format=fmt.upper(), **kwargs)
                    data = buf.getvalue(); ext = "." + fmt
            except Exception:
                data = None
        elif entry.get("audio") or entry.get("audio_src"):
            try:
                raw = None
                src_path = None
                if entry.get("audio_src"):
                    from urllib.parse import urlparse, parse_qs
                    p = (parse_qs(urlparse(entry["audio_src"]).query).get("path") or [None])[0]
                    if p and os.path.exists(p):
                        src_path = p
                        with open(p, "rb") as fh:
                            raw = fh.read()
                else:
                    uri = entry["audio"] or ""
                    if uri.startswith("data:audio/wav;base64,") or (uri.startswith("data:audio/") and "base64," in uri):
                        raw = base64.b64decode(uri.split(",", 1)[1])
                if raw:
                    acfg = sf.get("audio")
                    afmt = "wav"; bitrate = "192k"; sr = None
                    if isinstance(acfg, dict):
                        afmt = acfg.get("fmt", "wav") or "wav"
                        bitrate = acfg.get("bitrate") or "192k"
                        sr = acfg.get("sr")
                    src_ext = os.path.splitext(src_path)[1].lower() if src_path else ""
                    if src_path and src_ext == ("." + str(afmt).lower().lstrip(".")):
                        data, ext = raw, src_ext          # 存档格式与源文件一致 → 直接落盘，不重新编码
                    else:
                        res = _encode_audio(raw, afmt, bitrate, sr)
                        if res:
                            data, ext = res
            except Exception:
                data = None
        elif entry.get("video"):
            try:
                uri = entry["video"]
                if uri.startswith("data:video/") and "base64," in uri:
                    raw = base64.b64decode(uri.split(",", 1)[1])
                    vcfg = sf.get("video")
                    vfmt = "webm"; vcodec = "vp9"; crf = None; fps = None
                    if isinstance(vcfg, dict):
                        vfmt = vcfg.get("fmt", "webm") or "webm"
                        vcodec = vcfg.get("codec", "vp9") or "vp9"
                        crf = vcfg.get("crf"); fps = vcfg.get("fps")
                    res = _encode_video(raw, vfmt, vcodec, crf, fps)
                    if res:
                        data, ext = res
            except Exception:
                data = None
        elif entry.get("video_src"):
            try:
                from urllib.parse import urlparse, parse_qs
                u = entry["video_src"]
                src = (parse_qs(urlparse(u).query).get("path") or [None])[0]
                if src and os.path.isfile(src):
                    with open(src, "rb") as fh:
                        raw = fh.read()
                    vcfg = sf.get("video")
                    vfmt = "webm"; vcodec = "vp9"; crf = None; fps = None
                    if isinstance(vcfg, dict):
                        vfmt = vcfg.get("fmt", "webm") or "webm"
                        vcodec = vcfg.get("codec", "vp9") or "vp9"
                        crf = vcfg.get("crf"); fps = vcfg.get("fps")
                    src_ext = os.path.splitext(src)[1].lower()
                    if src_ext == ("." + str(vfmt).lower().lstrip(".")):
                        data, ext = raw, src_ext          # 存档格式与源文件一致 → 直接落盘，不重新编码
                    else:
                        res = _encode_video(raw, vfmt, vcodec, crf, fps)
                        if res:
                            data, ext = res
            except Exception:
                data = None
        elif entry.get("value"):
            data = (entry.get("full_value") or entry["value"]).encode("utf-8")
            tf = sf.get("text")
            text_fmt = tf.get("fmt", "txt") if isinstance(tf, dict) else (tf if isinstance(tf, str) else "txt")
            ext = "." + (text_fmt if text_fmt in ("txt", "md", "json", "csv", "log", "html") else "txt")
        if data is None:
            return entry
        try:
            rel = cfg.get("savePath", "").strip()
            if os.path.isabs(rel):
                dirpath = os.path.normpath(rel)
            else:
                base = PreviewAnyNode._output_dir()
                dirpath = os.path.normpath(os.path.join(base, rel))
                if not dirpath.startswith(os.path.normpath(base)):
                    dirpath = base
            os.makedirs(dirpath, exist_ok=True)
            import time
            fname = PreviewAnyNode._sanitize_filename(name) + "_" + str(int(time.time() * 1000)) + ext
            fpath = os.path.join(dirpath, fname)
            with open(fpath, "wb") as fh:
                fh.write(data)
            entry["saved_path"] = os.path.abspath(fpath)
            entry["saved_name"] = fname
        except Exception:
            pass
        return entry

    @staticmethod
    def _latent_summary(latent, max_len=_PREVIEW_MAX_VALUE_LEN):
        if isinstance(latent, dict):
            samples = latent.get("samples")
            if isinstance(samples, torch.Tensor):
                return f"Latent tensor shape={list(samples.shape)}, dtype={samples.dtype}", None
            return f"Latent dict with keys: {', '.join(latent.keys())}", None
        return _pv_truncate(str(latent), max_len)

    @staticmethod
    @staticmethod
    def _python_to_json(obj):
        """递归把 Python 字面量字符串（含单引号 dict/list/tuple/set）解析成原生 JSON 结构，供树展开。"""
        import ast
        if isinstance(obj, str):
            s = obj.strip()
            if s and (s.startswith("{") or s.startswith("[") or s.startswith("(") or s.startswith("set(")):
                try:
                    return PreviewAnyNode._python_to_json(ast.literal_eval(s))
                except Exception:
                    return obj
            return obj
        if isinstance(obj, dict):
            return {k: PreviewAnyNode._python_to_json(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple, set)):
            return [PreviewAnyNode._python_to_json(v) for v in obj]
        return obj

    @staticmethod
    def _safe_json(obj, max_len=_PREVIEW_MAX_VALUE_LEN):
        try:
            s = json.dumps(obj, default=str, ensure_ascii=False)
        except Exception:
            s = str(obj)
        return _pv_truncate(s, max_len)

    @staticmethod
    def _format_meta(meta):
        """把模型 __metadata__ 整理成可读摘要；嵌套 JSON 字符串尝试解析，优先展示架构/作者等关键项。"""
        if not isinstance(meta, dict):
            return _pv_truncate(str(meta), _PREVIEW_MAX_VALUE_LEN)[0]
        def try_parse(v):
            if isinstance(v, str) and v.strip().startswith(("{", "[")):
                try:
                    return json.loads(v)
                except Exception:
                    return v
            return v
        keys = ("modelspec.architecture", "modelspec.title", "modelspec.author", "modelspec.license",
                "modelspec.description", "modelspec.tags", "modelspec.thumbnail", "title", "author",
                "description", "architecture", "model_author", "model_name", "nsfw", "ss_sd_model_name",
                "ss_resolution", "ss_sampler_name", "ss_cfg_scale", "ss_epochs", "ss_beta_1", "ss_beta_2",
                "ss_clip_skip", "ss_negative_prompt", "ss_num_train_images", "ss_dataset_dirs")
        parts = []
        for k in keys:
            if k in meta:
                v = try_parse(meta[k])
                parts.append(f"{k}={json.dumps(v, ensure_ascii=False, default=str) if isinstance(v, (dict, list)) else v}")
        if not parts:
            parts = [f"{k}={json.dumps(try_parse(v), ensure_ascii=False, default=str) if isinstance(try_parse(v), (dict, list)) else v}" for k, v in meta.items()]
        return _pv_truncate(" | ".join(parts), _PREVIEW_MAX_VALUE_LEN)[0]

    @staticmethod
    def _extract_name(value, type_name):
        try:
            if type_name == "MODEL":
                init = getattr(value, "cached_patcher_init", None)
                if init is None:
                    return None
                path = init[1][0]
                return os.path.splitext(os.path.basename(path))[0]
            if type_name == "CLIP":
                patcher = getattr(value, "patcher", None)
                init = getattr(patcher, "cached_patcher_init", None)
                if init is None:
                    return None
                paths = init[1][0]
                if isinstance(paths, (list, tuple)):
                    return ", ".join(os.path.splitext(os.path.basename(p))[0] for p in paths)
                return os.path.splitext(os.path.basename(paths))[0]
            if type_name == "VAE":
                patcher = getattr(value, "patcher", None)
                init = getattr(patcher, "cached_patcher_init", None)
                if init is None:
                    return None
                path = init[1][0]
                return os.path.splitext(os.path.basename(path))[0]
        except Exception:
            return None
        return None


_register_preset_routes("EzFlex-NodeSwitchGroup", "/nodeswitch_group/presets", with_ratios=False)
_register_preset_routes("EzFlex-NodeSwitchMaster", "/nodeswitch_master/presets", with_ratios=False)
_register_preset_routes("EzFlex-MainControl", "/main_control/presets", with_ratios=False)
_register_preset_routes("EzFlex-ParamPresetControl", "/param_preset_control/presets", with_ratios=False)



# 参数类型 -> ComfyUI 输出类型：复杂类型（complex/tuple/list/set/dictionary）没有原生端口，统一走 STRING(JSON)。
PARAM_TYPE_MAP = {
    "int": "INT",
    "float": "FLOAT",
    "string": "STRING",
    "bool": "BOOLEAN",
    "complex": "STRING",
    "tuple": "STRING",
    "list": "STRING",
    "set": "STRING",
    "dictionary": "STRING",
}


def _py_literal(s):
    import ast
    try:
        return ast.literal_eval(s)
    except Exception:
        return s


def _norm_param_value(value, ptype):
    """按类型把字符串值解析成原生（有效）；不符合保留字符串。"""
    if not isinstance(value, str):
        return value
    s = value.strip()
    ptype = (ptype or "string").lower()
    if ptype == "int":
        return int(s) if re.fullmatch(r"-?\d+", s) else value
    if ptype == "float":
        return float(s) if re.fullmatch(r"-?\d+(\.\d+)?([eE][-+]?\d+)?", s) else value
    if ptype == "bool":
        l = s.lower()
        if l in ("true", "1", "yes", "on"):
            return True
        if l in ("false", "0", "no", "off", "none", "null", ""):
            return False
        return value
    if ptype == "list":
        return _py_literal(s) if (s.startswith("[") and s.endswith("]")) else value
    if ptype == "tuple":
        return _py_literal(s) if (s.startswith("(") and s.endswith(")")) else value
    if ptype == "set":
        return _py_literal(s) if (s.startswith("{") and s.endswith("}") and ":" not in s) else value
    if ptype == "dictionary":
        if s.startswith("{") and s.endswith("}") and ":" in s:
            v = _py_literal(s)
            return v if isinstance(v, dict) else value
        return value
    return value  # string / complex


def _bitrate_int(s):
    try:
        if isinstance(s, (int, float)):
            return int(s)
        s = str(s).strip().lower()
        if s.endswith("k"):
            return int(float(s[:-1]) * 1000)
        return int(float(s))
    except Exception:
        return None


def _encode_audio(data_bytes, fmt, bitrate=None, sample_rate=None):
    """把 WAV 字节按所选格式/码率/采样率重编码（av）。"""
    try:
        import av
        from io import BytesIO
        fmt = (fmt or "wav").lower()
        if fmt == "wav":
            return data_bytes, ".wav"
        codec = {"mp3": "libmp3lame", "flac": "flac", "ogg": "libvorbis", "m4a": "aac", "aac": "aac"}.get(fmt)
        if not codec:
            return data_bytes, "." + fmt
        oidx = BytesIO()
        fsrc = BytesIO(data_bytes); fsrc.seek(0)
        with av.open(fsrc, mode="r") as inp:
            with av.open(oidx, mode="w", format=fmt) as out:
                ostream = out.add_stream(codec)
                br = _bitrate_int(bitrate)
                if br:
                    ostream.bit_rate = br
                if sample_rate:
                    try:
                        ostream.sample_rate = int(sample_rate)
                    except Exception:
                        pass
                for frame in inp.decode(audio=0):
                    for p in ostream.encode(frame):
                        out.mux(p)
                for p in ostream.encode():
                    out.mux(p)
        oidx.seek(0)
        return oidx.getvalue(), "." + fmt
    except Exception:
        return None


def _encode_video(data_bytes, fmt, codec="h264", crf=None, fps=None):
    """把视频字节按所选容器/编码器/CRF/帧率重编码（av）。"""
    try:
        import av
        from io import BytesIO
        fmt = (fmt or "webm").lower()
        codec_name = {"h264": "libx264", "vp9": "libvpx-vp9", "av1": "libsvtav1"}.get(codec, "libvpx-vp9")
        oidx = BytesIO()
        fsrc = BytesIO(data_bytes); fsrc.seek(0)
        with av.open(fsrc, mode="r") as inp:
            vstream = next((s for s in inp.streams if s.type == "video"), None)
            if vstream is None:
                return None
            rate = float(fps) if fps else (float(vstream.average_rate) if vstream.average_rate else 24)
            with av.open(oidx, mode="w", format=fmt) as out:
                ostream = out.add_stream(codec_name, rate=rate)
                ostream.pix_fmt = "yuv420p"
                if crf:
                    try:
                        ostream.options = {"crf": str(int(crf))}
                    except Exception:
                        pass
                for frame in inp.decode(vstream):
                    for p in ostream.encode(frame):
                        out.mux(p)
                for p in ostream.encode():
                    out.mux(p)
        oidx.seek(0)
        return oidx.getvalue(), "." + fmt
    except Exception:
        return None


def parse_param_groups(config):
    """把 ParamPresetControl 的 config JSON 解析成参数组列表（与前端面板数据同构）。"""
    if isinstance(config, str):
        if not config.strip():
            return []
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            return []
    else:
        data = config
    if isinstance(data, dict):
        data = data.get("groups", [])
    if not isinstance(data, list):
        return []
    groups = []
    for item in data:
        if not isinstance(item, dict):
            continue
        params = item.get("params") or []
        groups.append({
            "id": item.get("id"),
            "name": item.get("name") or "参数组",
            "out": item.get("out") or "all",
            "params": [
                {
                    "id": p.get("id"),
                    "name": p.get("name") or "参数",
                    "type": p.get("type") or "string",
                    "value": _norm_param_value(p.get("value"), p.get("type")),
                    "enabled": p.get("enabled", True),
                }
                for p in params if isinstance(p, dict)
            ],
        })
    return groups


def param_value_to_comfy(value, ptype):
    """把面板里的参数值按类型严格转成 ComfyUI 端口值；复杂类型 JSON 序列化为 STRING。

    bool：按「非空/非零即真」的 Python 真值语义——"2"/"abcd"→True；只有明确的假表示
    ("", "0", "false", "no", "off", "none", "null") 或 0 才为 False。
    int/float 宽松解析（int(val)/float(val)），解析失败回退 0，避免下游抛错。
    """
    if ptype == "int":
        if isinstance(value, str):
            s = value.strip()
            if re.fullmatch(r"-?\d+", s):
                return int(s)
            return value  # 无效 -> string
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return str(value)
    if ptype == "float":
        if isinstance(value, str):
            s = value.strip()
            if re.fullmatch(r"-?\d+(\.\d+)?([eE][-+]?\d+)?", s):
                return float(s)
            return value  # 无效 -> string
        try:
            return float(value)
        except (TypeError, ValueError):
            return str(value)
    if ptype == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            s = value.strip().lower()
            if s in ("", "0", "false", "no", "off", "none", "null", "n", "f"):
                return False
            if s in ("true", "1", "yes", "on", "y", "t"):
                return True
            return value  # 无效 -> string
        return bool(value)
    if ptype in ("complex", "tuple", "list", "set", "dictionary"):
        if isinstance(value, str):
            return value
        try:
            return json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(value)
    return str(value)


def _ppc_output_types(groups):
    """按参数组顺序算 ParamPresetControl 的输出类型/名称（一个分组一个 EZFLEX_PARAM_GROUP 端口）。"""
    groups = groups or []
    names = []
    for i, g in enumerate(groups):
        nm = (g.get("name") or "").strip() or f"参数组 {i + 1}"
        names.append(nm)
    return tuple(["EZFLEX_PARAM_GROUP"] * len(groups)), tuple(names)


def _ppo_output_types(params):
    """按输出顺序算 ParamPresetOutput 的类型/名称：第 0 个固定为整组数据(红色 EZFLEX_PARAM_GROUP)，其后每个激活参数一个端口。"""
    params = params or []
    types, names = [], []
    for i, p in enumerate(params):
        ptype = (p.get("type") or "string").lower()
        if ptype == "ezflex_param_group":
            types.append("EZFLEX_PARAM_GROUP")
        else:
            types.append(PARAM_TYPE_MAP.get(ptype, "STRING"))
        names.append((p.get("name") or "").strip() or f"参数 {i + 1}")
    return tuple(types), tuple(names)


def _ppo_effective_params(group):
    """参数组实际输出的参数：全部绿色(启用)参数；若组设了 out（单个参数 id）则只保留该参数。"""
    params = (group or {}).get("params") or []
    active = [p for p in params if p.get("enabled", True) is not False]
    out = group.get("out") or "all"
    if out != "all":
        active = [p for p in active if str(p.get("id")) == str(out)]
    return active


def _parse_local_off(config):
    """解析 Output 节点 config 里的局部禁用参数 id 集合（Output 面板自身启/禁用，不写回控制节点）。"""
    if isinstance(config, str):
        if not config.strip():
            return set()
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            return set()
    else:
        data = config or {}
    if not isinstance(data, dict):
        return set()
    off = data.get("off", [])
    return {str(x) for x in off} if isinstance(off, list) else set()


def _ppo_disabled_value(ptype):
    """禁用/未选中参数输出“中性默认值”（int→0、float→0.0、bool→0、complex→0，其它→空串）。"""
    if ptype in ("int", "bool", "complex"):
        return 0
    if ptype == "float":
        return 0.0
    return ""  # string/tuple/list/set/dictionary -> 空串占位


async def _ppc_outputs(req):
    """前端在分组增删/排序后 POST，把类 RETURN_TYPES/RETURN_NAMES 同步成当前端口排列（校验用）。"""
    try:
        data = await req.json()
        groups = data.get("groups", [])
        types, names = _ppc_output_types(groups)
        ParamPresetControlNode.RETURN_TYPES = types
        ParamPresetControlNode.RETURN_NAMES = names
        return _web.json_response({"ok": True, "types": list(types), "names": list(names)})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ppo_outputs(req):
    """前端在连接变化/参数增删排序后 POST，把类 RETURN_TYPES/RETURN_NAMES 同步成当前参数排列（校验用）。"""
    try:
        data = await req.json()
        params = data.get("params", [])
        types, names = _ppo_output_types(params)
        ParamPresetOutputNode.RETURN_TYPES = types
        ParamPresetOutputNode.RETURN_NAMES = names
        return _web.json_response({"ok": True, "types": list(types), "names": list(names)})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


try:
    PromptServer.instance.routes.post("/param_preset_control/outputs")(_ppc_outputs)
    PromptServer.instance.routes.post("/param_preset_output/outputs")(_ppo_outputs)
except Exception:
    pass


# ===== EzFlex-PreviewAny：文件系统辅助路由（存档位置浏览 / 打开文件夹选中文件）=====
async def _preview_any_folders(req):
    base = PreviewAnyNode._output_dir()
    rel = (req.query.get("path") or "").strip()
    full = _ez_inside(os.path.join(base, rel), [_ez_real(base)]) or base
    if os.path.isfile(full):
        full = os.path.dirname(full)
    try:
        folders = []
        for entry in sorted(os.listdir(full)):
            if os.path.isdir(os.path.join(full, entry)):
                folders.append(entry)
        rel_abs = os.path.relpath(full, base)
        if rel_abs == ".":
            rel_abs = ""
        return _web.json_response({"base": base, "path": rel_abs, "folders": folders})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _preview_any_open(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
        path = str(data.get("path") or "").strip()
        base = PreviewAnyNode._output_dir()
        if os.path.isabs(path):
            full = os.path.normpath(path)
        else:
            full = os.path.normpath(os.path.join(base, path))
        import subprocess
        if os.path.exists(full):
            if os.name == "nt":
                subprocess.Popen(["explorer", "/select," + full])
            else:
                subprocess.Popen(["xdg-open", full if os.path.isfile(full) else os.path.dirname(full)])
        return _web.json_response({"ok": True})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _preview_any_pick_folder(req):
    """弹 Windows 原生“选择文件夹”对话框，默认 ComfyUI 输出目录。仅本机客户端。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    base = PreviewAnyNode._output_dir()
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        path = filedialog.askdirectory(initialdir=base, title="选择保存位置")
        root.destroy()
        if path:
            return _web.json_response({"ok": True, "path": os.path.normpath(path), "base": base})
        return _web.json_response({"ok": False})
    except Exception as e:
        return _web.json_response({"ok": False, "error": str(e)}, status=500)


async def _preview_any_serve_video(req):
    """流式返回媒体文件（Range 支持）。只服务「允许目录」内的文件；根外文件仅「本机预览」才复制进临时目录
    再服务 —— 否则远端能借这条路由把任意文件当视频读走。"""
    path = req.query.get("path", "").strip()
    src = _ez_inside(path)
    if not src:
        if not _ez_local(req):
            return _web.json_response({"error": "out of allowed roots"}, status=403)
        src = _ez_adopt_to_temp(path)
    if not src or not os.path.isfile(src):
        return _web.json_response({"error": "not found"}, status=404)
    return _web.FileResponse(src)


async def _preview_any_static(req):
    """serve 插件 web/ 目录（供前端本地导入 three.js 与加载器），仅白名单相对路径。"""
    rel = req.match_info.get("path", "")
    root = _ez_real(os.path.join(os.path.dirname(__file__), "web"))
    full = _ez_inside(os.path.join(root, rel), [root])
    if not full or not os.path.isfile(full):
        return _web.json_response({"error": "not found"}, status=404)
    return _web.FileResponse(full)


async def _preview_any_fs(req):
    """按绝对路径 serve 文件（用于 3D 模型及其外部贴图/缓冲，使相对路径能正确解析）。仅本地路径。"""
    from urllib.parse import unquote
    full = _ez_inside(unquote(req.match_info.get("path", "")))
    if full and os.path.isfile(full):
        return _web.FileResponse(full)
    # 兜底：贴图/缓冲常在模型同目录的子文件夹（Textures/Materials），在该目录里按 basename 找（仍在允许目录内）
    if full:
        try:
            base = os.path.basename(full)
            base_dir = os.path.dirname(full)
            if base and base_dir and os.path.isdir(base_dir):
                for root, _dirs, files in os.walk(base_dir):
                    if base in files:
                        hit = _ez_inside(os.path.join(root, base))
                        if hit:
                            return _web.FileResponse(hit)
        except Exception:
            pass
    return _web.json_response({"error": "not found"}, status=404)


async def _preview_any_outputs(req):
    """前端在 PreviewAny 连接数变化后 POST，把类 RETURN_TYPES/RETURN_NAMES 同步成当前输出数（校验用）。"""
    try:
        data = await req.json()
        count = int(data.get("count", 0))
        count = max(0, min(count, _PREVIEW_MAX))
        PreviewAnyNode.RETURN_TYPES = tuple("*" for _ in range(count))
        PreviewAnyNode.RETURN_NAMES = tuple(f"output_{i}" for i in range(1, count + 1))
        return _web.json_response({"ok": True, "types": list(PreviewAnyNode.RETURN_TYPES), "names": list(PreviewAnyNode.RETURN_NAMES)})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


try:
    PromptServer.instance.routes.get("/preview_any/folders")(_preview_any_folders)
    PromptServer.instance.routes.post("/preview_any/open")(_preview_any_open)
    PromptServer.instance.routes.post("/preview_any/pick_folder")(_preview_any_pick_folder)
    PromptServer.instance.routes.get("/preview_any/serve_video")(_preview_any_serve_video)
    PromptServer.instance.routes.get("/preview_any/serve_3d")(_preview_any_serve_video)
    PromptServer.instance.routes.get("/preview_any/fs/{path:.*}")(_preview_any_fs)
    PromptServer.instance.routes.get("/preview_any/3d/{path:.*}")(_preview_any_static)
    PromptServer.instance.routes.post("/preview_any/outputs")(_preview_any_outputs)
except Exception:
    pass


# ===== EzFlex-PromptHelper：提示词卡片合并节点 =====
# 输入：固定 clip(单 CLIP) + 动态「综合媒体」端口(red ANY，可接图像/视频/音频/3D 模型等，前端连接后自动补一个空槽)
#   + 动态「提示词文本」输入 = 卡片数 1:1（card_in_1..N，按顺序链接到提示词卡片）；
# 输出：固定「合并提示词」STRING（按卡片顺序拼接）+ 动态输出 = 卡片数 1:1（每卡一段 STRING）。
# 复用 ModelsCombo/ParamPreset/PreviewAny 的动态端口经验：前端按卡片数增删/reuse socket、
# 更新 origin_slot/target_slot，并 POST /prompt_helper/outputs 同步类 RETURN_TYPES/RETURN_NAMES。
_PH_MAX_CARDS = 32
_PH_MAX_MEDIA = 16
_PH_MAX_VISION_IMAGES = 8   # 一次优化最多随请求发几张图（防止批次/视频帧把请求撑爆）
# 优化调用的系统提示（api / Anthropic / llama 三处共用）：**必须要求保留引用媒体标记** ——
# 送去优化的正文是未编译的原文（带 @图片1 这类标记），模型若把它翻译/改写/解释掉，规范编译就没得可编了。
_PH_OPT_SYSTEM = (
    "You are a helpful assistant that rewrites and enhances the user's prompt for a text/image/video model. "
    "Output only the enhanced prompt. "
    "Keep every reference token such as @图片1 / @视频1 / @音频1 exactly as written: do not translate, rename, "
    "renumber, wrap in parentheses or explain them."
)
_PH_VIDEO_MAX_FRAMES = 48   # 视频解码上限（按 ~1fps 抽，覆盖约 48 秒）
_PH_VIDEO_MAX_EDGE = 512    # 视频帧最长边缩到这个尺寸，控制显存/内存



def parse_prompt_cards(config):
    """把 PromptHelper 的 config JSON 解析成提示词卡片列表（与前端面板数据同构）。"""
    if isinstance(config, str):
        if not config.strip():
            return []
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            return []
    else:
        data = config
    if isinstance(data, dict):
        data = data.get("cards", [])
    if not isinstance(data, list):
        return []
    cards = []
    for item in data:
        if not isinstance(item, dict):
            continue
        cards.append({
            "id": item.get("id"),
            "title": (item.get("title") or "").strip() or "提示词",
            "content": item.get("content") or "",
            "contentHTML": item.get("contentHTML") or "",
            "contentOptimized": item.get("contentOptimized") or "",
            "contentOptimizedHTML": item.get("contentOptimizedHTML") or "",
            "timelineStart": item.get("timelineStart") or "",
            "timelineEnd": item.get("timelineEnd") or "",
            "modelType": item.get("modelType") or "text",
            "model": item.get("model") or "",
            "provider": item.get("provider") or "",
            "apiUrl": item.get("apiUrl") or item.get("apiLink") or "",
            "indent": float(item.get("indent") or 0),
            "indentMode": item.get("indentMode") or "paragraph",
            "useOptimized": bool(item.get("useOptimized")),
            "ruleId": item.get("ruleId") or "",
            "mergeOff": bool(item.get("mergeOff")),          # 「合」关掉 = 不进合并输出
            "rule": item.get("rule") if isinstance(item.get("rule"), dict) else {},   # 前端 syncToConfig 解析好的规范
        })
    return cards


def parse_prompt_optimize(config):
    """把 PromptHelper 的 config JSON 里的「设置」(optimize) 对象解析出来（API/TextGenerate/llama）。"""
    if isinstance(config, str):
        if not config.strip():
            return {"provider": "", "model": "", "apiUrl": "", "apiKey": "", "proxy": "", "textgen": {}, "llama": {}}
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            data = {}
    else:
        data = config or {}
    if not isinstance(data, dict):
        data = {}
    o = data.get("optimize")
    if not isinstance(o, dict):
        o = {}
    tg = o.get("textgen")
    ll = o.get("llama")
    ap = o.get("apiParams")
    return {
        "provider": o.get("provider") or "",
        "model": o.get("model") or "",
        "apiUrl": o.get("apiUrl") or "",
        "apiKey": o.get("apiKey") or "",
        "proxy": o.get("proxy") or "",
        "autoTextgen": bool(o.get("autoTextgen")),
        "autoApi": bool(o.get("autoApi")),
        "autoLlama": bool(o.get("autoLlama")),
        "clearCache": bool(o.get("clearCache")),
        "textgen": tg if isinstance(tg, dict) else {},
        "llama": ll if isinstance(ll, dict) else {},
        "apiParams": ap if isinstance(ap, dict) else {},
    }


def parse_prompt_rules(config):
    """把 PromptHelper 的 config JSON 里的「规则设置」(rules) 解析出来。
    目前只有「卡片合并规则」：卡片之间插什么分隔符（输入框里写 \\n / \\t / \\r 表示换行/制表，默认换行）。
    """
    if isinstance(config, str):
        if not config.strip():
            return {"mergeSep": "\n"}
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            data = {}
    else:
        data = config or {}
    if not isinstance(data, dict):
        data = {}
    r = data.get("rules")
    if not isinstance(r, dict):
        r = {}
    sep = str(r.get("mergeSep") or "").replace("\\r", "\r").replace("\\n", "\n").replace("\\t", "\t")
    return {"mergeSep": sep or "\n", "ruleId": str(r.get("ruleId") or "none"), "custom": r.get("custom") if isinstance(r.get("custom"), list) else []}


def parse_prompt_overall(config):
    """「总体编辑」里那份整体优化内容（所有卡片合并后优化一次的结果），以及是否用它输出。
    与卡片级的 contentOptimized / useOptimized 对应，但作用在节点整体上。"""
    if isinstance(config, str):
        if not config.strip():
            return {"text": "", "useOptimized": False}
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            data = {}
    else:
        data = config or {}
    if not isinstance(data, dict):
        data = {}
    return {"text": str(data.get("overallOptimized") or ""), "useOptimized": bool(data.get("overallUseOptimized"))}


def _ph_compile_card(text, card):
    """自动编译只做一件事：按节点级规范的 ref 模板替换引用媒体标记
    （@图片N/@视频N/@音频N → 该规范的写法；留空/缺键 = 原样保留）。
    时间戳与镜头号**不在自动输出里生成** —— 在「提示」气泡里按输入生成，由用户手动复制。"""
    if not text:
        return text
    rule = card.get("rule") if isinstance(card, dict) else None
    if not isinstance(rule, dict):
        return text
    ref = rule.get("ref") if isinstance(rule.get("ref"), dict) else {}
    for kind, pat in (("image", r"@图片\s*(\d+)"), ("video", r"@视频\s*(\d+)"), ("audio", r"@音频\s*(\d+)")):
        tpl = str(ref.get(kind) or "")
        if kind in ref and tpl.strip():   # 留空/缺键 = 不编译，标记原样保留
            text = re.sub(pat, lambda m, t=tpl: t.replace("{n}", m.group(1)), text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def _ph_clip_generate(clip, prompt, tg, media=None):
    """用已连接的 text-gen CLIP 按 TextGenerate 同款参数生成文本（供 run 期内自动优化）。
    若连接的 CLIP 不支持文本生成（无 generate / tokenize 签名不兼容），抛清晰错误，便于排查。
    media 字典可带 image/video/audio（来自综合媒体输入），随 prompt 一起喂给 text-gen CLIP（如 Qwen-VL/Gemma 可看图反推/扩写）。"""
    if not hasattr(clip, "generate"):
        raise ValueError(
            "this CLIP does not support text generation: TextGenerate only works with text-gen encoders such as Gemma/Qwen3-VL/flux2; "
            "a regular stable_diffusion CLIP has no generate method. Use a text-gen CLIP instead, or switch to the API/llama prompt optimizer."
        )
    media = media or {}
    img = _ph_concat_images(media.get("images") or ([] if media.get("image") is None else [media.get("image")]))
    vinfo = media.get("video")
    if isinstance(vinfo, dict):
        vid, vfps = vinfo.get("frames"), vinfo.get("fps")
    else:
        vid, vfps = vinfo, None
    aud = media.get("audio")
    use_tpl = bool(tg.get("use_default_template", True))
    thinking = bool(tg.get("thinking", False))
    vkw = {"fps": vfps} if (vid is not None and vfps) else {}   # 帧率告诉编码器（Gemma4 按 fps 抽 1fps）
    try:
        tokens = clip.tokenize(prompt, skip_template=not use_tpl, min_length=1, thinking=thinking, image=img, video=vid, audio=aud, **vkw)
    except TypeError:
        try:
            tokens = clip.tokenize(prompt, skip_template=not use_tpl, min_length=1, thinking=thinking)
        except TypeError:
            tokens = clip.tokenize(prompt)
    do_sample = str(tg.get("sampling_mode", "on")) == "on"
    # comfy 的 generate 在 do_sample 时要求 seed 是整数（None 会让 torch manual_seed 报错）；0/空 = 每次随机。
    seed = int(_ph_num(tg.get("seed"), 0))
    if do_sample and seed == 0:
        seed = random.randint(0, 0xffffffffffffffff)
    gen = clip.generate(
        tokens,
        do_sample=do_sample,
        max_length=int(_ph_num(tg.get("max_length"), 512)),
        temperature=_ph_num(tg.get("temperature"), 0.7),
        top_k=int(_ph_num(tg.get("top_k"), 64)),
        top_p=_ph_num(tg.get("top_p"), 0.95),
        min_p=_ph_num(tg.get("min_p"), 0.05),
        repetition_penalty=_ph_num(tg.get("repetition_penalty"), 1.05),
        presence_penalty=_ph_num(tg.get("presence_penalty"), 0.0),
        seed=seed,
    )
    return clip.decode(gen)


# ===== 按「设置」里的 CLIP 路径+类型 自行加载 text-gen CLIP（点击即用，像 llama 一样）=====
_PH_CLIP_CACHE = {}


def ph_resolve_model(p, extra_roots=None):
    """把用户填的模型路径解析为真实绝对路径（safetensors/gguf/ckpt/pt/bin），支持绝对路径、相对 models 的子路径、仅文件名。
    extra_roots 为路径设置里用户自定义的扫描目录（可多级）。"""
    if not p:
        return ""
    p = p.strip().strip('"').strip("'")
    if os.path.isfile(p):
        return os.path.abspath(p)
    if not extra_roots:
        gr = _ph_global_scan_path('clip_root')
        extra_roots = [gr] if gr else None
    base = os.path.basename(p)
    for root in _ph_roots_for(extra_roots):
        cand = os.path.join(root, p)
        if os.path.isfile(cand):
            return os.path.abspath(cand)
        for dirpath, _dirs, files in os.walk(root):
            if base in files:
                return os.path.abspath(os.path.join(dirpath, base))
    return ""


def _ph_clip_instance(clip_path, clip_type):
    key = (clip_path, clip_type)
    if key in _PH_CLIP_CACHE:
        return _PH_CLIP_CACHE[key]
    import comfy.sd
    ct = getattr(comfy.sd.CLIPType, str(clip_type or "stable_diffusion").upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
    try:
        clip = comfy.sd.load_clip(ckpt_paths=[clip_path],
                                  embedding_directory=folder_paths.get_folder_paths("embeddings"),
                                  clip_type=ct, model_options={})
    except Exception as e:
        raise ValueError(f"failed to load CLIP: {e} (make sure this is a text-gen text encoder and the CLIP type is correct)") from e
    _PH_CLIP_CACHE[key] = clip
    return clip


def ph_clear_model_cache():
    """清空已加载的 CLIP / llama 模型缓存，并尽量把显存真正还给系统。
    只 clear() 字典只是"丢掉引用"，要等 GC 才回收；llama-cpp 显式 close() 更确定，
    再补一次 gc + comfy 的 soft_empty_cache()（顺带把 ComfyUI 自己缓存的显存也还回去）。"""
    import gc
    for m in list(_LLAMA_CACHE.values()):
        try:
            m.close()          # llama-cpp-python：确定性释放模型 / 上下文
        except Exception:
            pass
    try:
        _LLAMA_CACHE.clear()
    except Exception:
        pass
    try:
        _PH_CLIP_CACHE.clear()
    except Exception:
        pass
    gc.collect()
    try:
        import comfy.model_management
        comfy.model_management.soft_empty_cache()
    except Exception:
        pass

def _ph_html_to_text(html):
    """把卡片 contenteditable 的 HTML 转成纯文本（供合并提示词用）。"""
    if not html:
        return ""
    txt = re.sub(r"<[^>]+>", " ", html)
    txt = re.sub(r"\s+", " ", txt).strip()
    return txt


def _ph_video_frames(value, target_fps=1.0, max_frames=_PH_VIDEO_MAX_FRAMES):
    """把视频解码成帧张量 [T,H,W,C] float32（按 target_fps 抽样、缩到 _PH_VIDEO_MAX_EDGE、最多 max_frames 帧）。
    接受磁盘路径 / io.BytesIO / VideoFromFile 这类对象；取不到返回 (None, 0)。"""
    try:
        import av
        from PIL import Image
        src = value.get_stream_source() if hasattr(value, "get_stream_source") else value
        if not src:
            return None, 0.0
        with av.open(src, mode="r") as container:
            stream = next((s for s in container.streams if s.type == "video"), None)
            if stream is None:
                return None, 0.0
            try:
                native = float(stream.average_rate) if stream.average_rate else 0.0
            except Exception:
                native = 0.0
            step = max(1, int(round(native / target_fps))) if native > 0 else 1
            frames = []
            for i, frame in enumerate(container.decode(stream)):
                if i % step:
                    continue
                im = Image.fromarray(frame.to_ndarray(format="rgb24"))
                im.thumbnail((_PH_VIDEO_MAX_EDGE, _PH_VIDEO_MAX_EDGE))
                frames.append(torch.from_numpy(np.ascontiguousarray(np.asarray(im))).float() / 255.0)
                if len(frames) >= max_frames:
                    break
        if not frames:
            return None, 0.0
        return torch.stack(frames, dim=0), float(target_fps)
    except Exception:
        return None, 0.0


def _ph_media_bundle(images, videos, audios):
    """统一媒体包：各类列表 + 每类第一项（旧调用点读 image/video/audio）。video 项为 {"frames","fps"}。"""
    return {
        "images": images, "videos": videos, "audios": audios,
        "image": images[0] if images else None,
        "video": videos[0] if videos else None,
        "audio": audios[0] if audios else None,
    }


def _ph_vision_tensors(media):
    """API/llama 实际要发的图：普通图片 + 视频从头到尾均匀抽帧（每个视频最多 _PH_MAX_VISION_IMAGES 帧）。"""
    out = list(media.get("images") or [])
    for v in (media.get("videos") or []):
        frames = v.get("frames") if isinstance(v, dict) else v
        if not isinstance(frames, torch.Tensor) or frames.ndim != 4 or frames.shape[0] == 0:
            continue
        t = frames.shape[0]
        n = min(_PH_MAX_VISION_IMAGES, t)
        idx = sorted({int(round(i * (t - 1) / max(n - 1, 1))) for i in range(n)})
        out.extend(frames[i:i + 1] for i in idx)
    return out


def _ph_media_files_from_request(data):
    """点击即用的视频/音频：只拿路径，按 path 从磁盘加载（复用 MediaLoader 的加载器）。"""
    videos, audios = [], []
    items = (data or {}).get("media")
    if isinstance(items, list):
        for it in items:
            if not isinstance(it, dict):
                continue
            t = str(it.get("type") or "").lower()
            p = str(it.get("path") or "")
            if not p or t not in ("video", "audio"):
                continue
            fp = _ml_resolve(p)
            if not fp:
                continue
            if t == "video":
                frames, fps = _ph_video_frames(fp)
                if frames is not None:
                    videos.append({"frames": frames, "fps": fps})
            else:
                audios.append(_ml_load_audio(fp))
    return videos, audios


def _ph_gather_media(kwargs):
    """从 media_in_* 输入里按类型收集全部媒体（仅执行期有真实值）。
    张量一律当图像（批次张量原样保留成一整批）；带 waveform/sample_rate 的 dict 当音频；
    视频对象（Load Video / MediaLoader / VHS 流）解码成 ~1fps 帧张量。返回媒体包。"""
    images, videos, audios = [], [], []
    for i in range(1, _PH_MAX_MEDIA + 1):
        v = kwargs.get(f"media_in_{i}")
        if v is None:
            continue
        for x in (v if isinstance(v, (list, tuple)) else [v]):
            if x is None:
                continue
            if isinstance(x, torch.Tensor):
                images.append(x)
            elif isinstance(x, dict) and ("waveform" in x or "sample_rate" in x):
                audios.append(x)
            elif hasattr(x, "get_stream_source") or hasattr(x, "get_components"):
                frames, fps = _ph_video_frames(x)
                if frames is not None:
                    videos.append({"frames": frames, "fps": fps})
    return _ph_media_bundle(images, videos, audios)


def _ph_image_to_dataurl(tensor):
    """把 IMAGE 张量编码成 base64 PNG data URL，供视觉模型（API/llama mmproj）看图。失败返回 ''。"""
    try:
        import io, base64
        import numpy as np
        from PIL import Image
        t = tensor
        if isinstance(t, torch.Tensor):
            if t.ndim == 4:
                t = t[0]
            arr = t.squeeze().float().cpu().numpy()
        else:
            return ""
        if arr.ndim == 3 and arr.shape[-1] in (3, 4):
            img = Image.fromarray(np.clip(arr * 255.0, 0, 255).astype("uint8"))
        elif arr.ndim == 2:
            img = Image.fromarray(np.clip(arr * 255.0, 0, 255).astype("uint8"), "L")
        else:
            return ""
        buf = io.BytesIO(); img.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return ""


def _ph_images_to_dataurls(images):
    """把若干 IMAGE 张量（含批次）编码成 data URL 列表，供视觉模型看图；单次最多 _PH_MAX_VISION_IMAGES 张。"""
    out = []
    for t in images or []:
        if len(out) >= _PH_MAX_VISION_IMAGES:
            break
        if isinstance(t, torch.Tensor) and t.ndim == 4:
            for i in range(t.shape[0]):
                if len(out) >= _PH_MAX_VISION_IMAGES:
                    break
                u = _ph_image_to_dataurl(t[i:i + 1])
                if u:
                    out.append(u)
        else:
            u = _ph_image_to_dataurl(t)
            if u:
                out.append(u)
    return out


def _ph_dataurl_to_image(url):
    """把 data:image/...;base64,... 解回 IMAGE 张量 [1,H,W,C]（float32 0~1）；失败返回 None。"""
    try:
        import io, base64
        import numpy as np
        from PIL import Image
        if ";base64," not in str(url or ""):
            return None
        img = Image.open(io.BytesIO(base64.b64decode(str(url).split(";base64,", 1)[1])))
        if img.mode not in ("RGB", "RGBA", "L"):
            img = img.convert("RGB")
        arr = np.asarray(img).astype("float32") / 255.0
        if arr.ndim == 2:
            arr = arr[:, :, None]
        return torch.from_numpy(arr).unsqueeze(0)
    except Exception:
        return None


def _ph_dataurls_to_images(urls):
    """data URL 列表 → IMAGE 张量列表（解不开的直接跳过）。"""
    out = []
    for u in urls or []:
        t = _ph_dataurl_to_image(u)
        if t is not None:
            out.append(t)
    return out


def _ph_concat_images(images):
    """多张 IMAGE 张量合成一个批次喂 text-gen CLIP（形状不一致时只留第一张）。"""
    if not images:
        return None
    if len(images) == 1:
        return images[0]
    try:
        return torch.cat([t if t.ndim == 4 else t.unsqueeze(0) for t in images], dim=0)
    except Exception:
        return images[0]


# 注：PromptHelper 的类 RETURN_TYPES/RETURN_NAMES 固定成「最大卡片数 + 1」，**运行期不再按实例收缩**。
# 原因：execution.py 校验链接类型时按 **节点类** 取 RETURN_TYPES[槽位序号]，是全局共享的一份；
# 同屏多个实例卡数不同时，谁最后同步谁说了算 —— 收缩后别的实例的高位槽一取就越界（IndexError，报错信息很难懂）。
# 这份表全是 STRING、且够长，任何槽位都能取到，多个实例也不会互相干扰。


def _ph_chat_completion(url, headers, body, proxy="", timeout=90):
    """同步 OpenAI 兼容 chat/completions 请求（在线程池里跑，避免阻塞事件循环）。
    proxy 非空时走该代理（http/https），空则强制直连（忽略系统代理，默认）。"""
    import urllib.request, urllib.error, socket
    _ph_check_outbound(url)   # 允许列表校验（防 SSRF）：不在列表直接报错
    data_b = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data_b, method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    try:
        if proxy:
            ph = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        else:
            ph = urllib.request.ProxyHandler({})   # 空 dict = 不使用系统代理，直连
        opener = urllib.request.build_opener(ph)
        with opener.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:300]
        except Exception:
            pass
        raise ValueError(f"API returned error {e.code} ({e.reason}): {detail or 'no error detail'}") from e
    except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
        suffix = f" (if you need a proxy, set the proxy address in the API settings, e.g. http://127.0.0.1:7890)" if not proxy else ""
        raise ValueError(f"cannot reach API host {url}: network timeout or unreachable{suffix}. Original error: {e}") from e


# ===== 进程内 llama-cpp-python（用户 venv 已装 llama-cpp-python 时的本地推理）=====
_LLAMA_CACHE = {}

# 加载期参数白名单：Llama() 的 **kwargs 会静默吞掉不认识的键（写错名字不报错只是不生效），所以按签名逐个显式传。
_PH_LLAMA_LOAD_FIELDS = {
    "n_ctx": int, "n_gpu_layers": int, "n_batch": int, "n_ubatch": int,
    "n_threads": int, "n_threads_batch": int,
    "use_mmap": bool, "use_mlock": bool, "offload_kqv": bool,
}
_PH_LLAMA_FLASH = {"auto": "AUTO", "on": "ENABLED", "off": "DISABLED"}
# KV 缓存数据类型：ggml.h 的 ggml_type 枚举值（llama-cpp-python 没把它暴露成 Python 常量）
_PH_KV_TYPES = {"f16": 1, "q8_0": 8, "q4_0": 2}


def _ph_bool(v):
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "on", "yes")
    return bool(v)


def _ph_llama_load_kwargs(ll):
    """把「设置·llama设置」里的加载期参数转成 Llama() 的 kwargs。"""
    kw = {}
    for k, cast in _PH_LLAMA_LOAD_FIELDS.items():
        v = ll.get(k)
        if v is None or v == "":
            continue
        if k == "n_gpu_layers" and not re.fullmatch(r"-?\d+", str(v).strip()):
            kw[k] = str(v).strip()      # llama-cpp-python 也接受 auto / all
            continue
        if k in ("n_threads", "n_threads_batch"):
            v = int(v)
            if v <= 0:
                continue                # 0/-1 = 交给 llama-cpp-python 自动（约物理核数一半）
            kw[k] = v
            continue
        kw[k] = _ph_bool(v) if cast is bool else cast(v)
    for k in ("type_k", "type_v"):
        v = _PH_KV_TYPES.get(str(ll.get(k) or "").strip().lower())
        if v is not None:
            kw[k] = v
    flash = _PH_LLAMA_FLASH.get(str(ll.get("flash_attn") or "auto").strip().lower())
    if flash:
        import llama_cpp.llama_cpp as llama_lib
        kw["flash_attn_type"] = getattr(llama_lib.llama_flash_attn_type, "LLAMA_FLASH_ATTN_TYPE_" + flash)
    chat_format = str(ll.get("chat_format") or "").strip()
    if chat_format:
        kw["chat_format"] = chat_format
    return kw


def _ph_llama_vision_kwargs(ll):
    """mmproj 视觉处理器的构造参数：图片 token 上下限 / 视觉批上限 / 视觉是否上 GPU。
    这些由 chat_handler_kwargs 传给 mmproj 处理器，名字写错它会直接报错（不像 Llama 的 **kwargs 静默吞掉）。"""
    kw = {}
    for k, default in (("image_min_tokens", -1), ("image_max_tokens", -1), ("batch_max_tokens", 1024)):
        v = int(_ph_num(ll.get(k), default))
        if v > 0:                       # ≤0 = 不限制（用 mmproj / 后端默认）
            kw[k] = v
    if not _ph_bool(ll.get("vision_use_gpu", True)):
        kw["use_gpu"] = False           # 默认开（库默认 True），只有关掉时才需要显式传
    if _ph_bool(ll.get("vision_add_vision_id")):
        kw["extra_template_arguments"] = {"add_vision_id": True}   # Qwen-VL 模板变量：给每张图加「Picture N:」前缀
    return kw


def _ph_llama_instance(model_path, mmproj, ll):
    load = _ph_llama_load_kwargs(ll)
    vision = _ph_llama_vision_kwargs(ll) if mmproj else {}
    # vision 里有 dict（extra_template_arguments），用 JSON 文本进缓存 key 保持可哈希
    key = (model_path, mmproj, tuple(sorted(load.items())), json.dumps(vision, sort_keys=True))
    if key in _LLAMA_CACHE:
        return _LLAMA_CACHE[key]
    import llama_cpp
    kw = dict(model_path=model_path, verbose=False, **load)
    if mmproj:
        kw["mmproj_path"] = mmproj
        if vision:
            kw["chat_handler_kwargs"] = vision
    llm = llama_cpp.Llama(**kw)
    _LLAMA_CACHE[key] = llm
    return llm


def _ph_num(v, default):
    """设置项里的数字（前端可能给数字 / 字符串 / 空值）：取不到或不是数字就用默认值。"""
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return float(default)


def _ph_llama_sampling(ll):
    """采样参数的规范形式（llama.cpp 命名）；进程内与 llama.cpp 服务器两种模式共用。"""
    seed = int(_ph_num(ll.get("seed"), 0))
    stop = [s.strip() for s in str(ll.get("stop") or "").split(",") if s.strip()]
    return {
        "max_tokens": int(_ph_num(ll.get("max_tokens"), 256)),
        "temperature": _ph_num(ll.get("temperature"), 0.7),
        "top_p": _ph_num(ll.get("top_p"), 0.95),
        "top_k": int(_ph_num(ll.get("top_k"), 40)),
        "min_p": _ph_num(ll.get("min_p"), 0.05),
        "typical_p": _ph_num(ll.get("typical_p"), 1.0),
        "repeat_penalty": _ph_num(ll.get("repeat_penalty"), 1.1),
        "repeat_last_n": int(_ph_num(ll.get("penalty_last_n"), 64)),
        "presence_penalty": _ph_num(ll.get("presence_penalty"), 0.0),
        "frequency_penalty": _ph_num(ll.get("frequency_penalty"), 0.0),
        "seed": seed,
        "stop": stop,
    }


def _ph_llama_chat(llm, prompt, params, image_b64=None):
    msgs = [{"role": "system", "content": _PH_OPT_SYSTEM}]
    # 视觉：llama-cpp-python 的多模态聊天按 OpenAI 的 content 片段读图（mmproj 由 _ph_llama_instance 挂上）；
    # 纯文本模型收到图像片段会抛「does not support image inputs」，比静默丢图更容易排查。
    urls = [image_b64] if isinstance(image_b64, str) else [u for u in (image_b64 or []) if u]
    if urls:
        content = [{"type": "image_url", "image_url": {"url": u}} for u in urls]
        content.append({"type": "text", "text": prompt})
        msgs.append({"role": "user", "content": content})
    else:
        msgs.append({"role": "user", "content": prompt})
    smp = _ph_llama_sampling(params)
    kw = dict(messages=msgs)
    kw.update(smp)
    kw["stop"] = smp["stop"] or None
    kw["penalty_last_n"] = smp["repeat_last_n"]
    # 同一套设置要同时喂给两种模式的命名：进程内用 present_penalty、服务器（HTTP 分支）用 presence_penalty，
    # 按 create_chat_completion 的真实签名过滤，只保留本构建认识的那个。
    kw["present_penalty"] = smp["presence_penalty"]
    kw["seed"] = smp["seed"] if smp["seed"] > 0 else None   # ≤0 = 每次随机（交给 llama-cpp-python 默认种子）
    sig = inspect.signature(llm.create_chat_completion).parameters
    resp = llm.create_chat_completion(**{k: v for k, v in kw.items() if k in sig})
    return resp["choices"][0]["message"]["content"]


_PH_REASON_BUDGET = {"low": 1024, "medium": 4096, "high": 8192}


def _ph_apply_api_params(provider, model, body, ap, is_anthropic):
    """把「设置·API设置·调用参数」按厂商映射进请求体。字段缺省/留空 = 不发送（用各家默认）。"""
    if not ap:
        return
    for key in ("temperature", "top_p"):
        if key in ap:
            v = ap.get(key)
            if v is None or str(v).strip() == "":
                body.pop(key, None)            # 显式留空 = 不发送
            else:
                body[key] = _ph_num(v, body.get(key, 0.7))
    v = ap.get("max_tokens")
    if v is not None and str(v).strip() != "":
        n = int(_ph_num(v, 0))
        if n > 0:
            body["max_tokens" if provider != "OpenAI" else "max_completion_tokens"] = n
    if not is_anthropic:
        v = ap.get("seed")
        if v is not None and str(v).strip() != "":
            body["seed"] = int(_ph_num(v, 0))
    stop = [s.strip() for s in str(ap.get("stop") or "").split(",") if s.strip()]
    if stop:
        body["stop_sequences" if is_anthropic else "stop"] = stop
    # 思考 / 思维链：统一档位，各厂商落到自己的字段（OpenRouter 用 reasoning，Anthropic 用 thinking …）
    level = str(ap.get("reasoning") or "off").strip().lower()
    if level in _PH_REASON_BUDGET:
        if is_anthropic:
            body["thinking"] = {"type": "enabled", "budget_tokens": _PH_REASON_BUDGET[level]}
            body["max_tokens"] = max(int(body.get("max_tokens") or 1024), _PH_REASON_BUDGET[level] + 1024)
            body.pop("temperature", None); body.pop("top_p", None)   # 开 thinking 时 Claude 只接受 temperature=1
        elif provider == "OpenRouter":
            body["reasoning"] = {"effort": level}
        elif provider == "Alibaba Qwen":
            body["enable_thinking"] = True
            body["thinking_budget"] = _PH_REASON_BUDGET[level]
        elif provider == "Ollama":
            body["reasoning_effort"] = level
        else:
            body["reasoning_effort"] = level
    # OpenAI o 系列 / GPT-5 推理模型不接受自定义 temperature / top_p
    if provider == "OpenAI" and re.match(r"^(o\d|gpt-5)", str(model or "").lower()):
        body.pop("temperature", None); body.pop("top_p", None)
    # 联网搜索
    if ap.get("webSearch"):
        if is_anthropic:
            body["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}]
        elif provider == "OpenRouter":
            body.setdefault("plugins", []).append({"id": "web"})
        elif provider == "Alibaba Qwen":
            body["enable_search"] = True
        elif provider == "xAI Grok":
            body["search_parameters"] = {"mode": "on", "return_citations": True}
        elif provider == "OpenAI":
            body["web_search_options"] = {}
        else:
            raise ValueError("web search only supports OpenAI / Anthropic / OpenRouter / xAI / Qwen; provider " + repr(str(provider or "custom")) + " has no generic web parameters, turn it off.")
    # 自定义参数（JSON 键值对）：最后合并，同名直接覆盖上面的映射，方便厂商字段变动时自行改/加
    extra = ap.get("custom")
    if isinstance(extra, dict) and extra:
        body.update(extra)


def _ph_anthropic_text(result):
    """Anthropic 响应取最终答案：开了 thinking 后 content[0] 是 thinking 块，必须挑 type==text。"""
    for blk in (result.get("content") or []):
        if isinstance(blk, dict) and blk.get("type") == "text":
            return str(blk.get("text") or "")
    return ""


def _ph_optimize_impl(data):
    """同步优化核心：route 与 run 期共用。data 含 method/prompt/provider/model/apiUrl/apiKey/images + llama/textgen 配置。
    返回优化后的文本；出错抛 ValueError（带可读信息）。images 为 base64 data URL 列表（旧字段 image 仍兼容），供视觉模型看图。"""
    method = str((data or {}).get("method") or "api")
    prompt = str((data or {}).get("prompt") or "")
    if not prompt.strip():
        raise ValueError("prompt is empty")
    raw_imgs = (data or {}).get("images")
    img_urls = [str(u).strip() for u in raw_imgs if str(u or "").strip()] if isinstance(raw_imgs, list) else []
    if not img_urls:
        single = str((data or {}).get("image") or "").strip()   # 旧字段：单个 base64 data URL / http url
        if single:
            img_urls = [single]
    videos, audios = _ph_media_files_from_request(data)
    if method == "textgen":
        # 从设置里配置的 CLIP 路径 + 类型自行加载 text-gen CLIP（点击即用，同 llama）。
        tgcfg = (data or {}).get("textgen") or {}
        clip_path = ph_resolve_model(str(tgcfg.get("clip_path") or _ph_global_model_path("clip_path") or "").strip(), [str(tgcfg.get("clip_root") or "").strip()])
        if not clip_path:
            raise ValueError("TextGenerate needs a clip model + type in the TextGenerate settings to run as a one-click button; or switch back to runtime auto-optimize (TextGenerate) to use the connected CLIP during workflow execution.")
        clip = _ph_clip_instance(clip_path, str(tgcfg.get("clip_type") or "stable_diffusion"))
        # 点击即用也带媒体：CLIP 必须吃张量，图片 data URL 解回张量；视频/音频按路径加载
        return _ph_clip_generate(clip, prompt, tgcfg, _ph_media_bundle(_ph_dataurls_to_images(img_urls), videos, audios))

    provider = str((data or {}).get("provider") or "")
    model = str((data or {}).get("model") or "")
    # API/llama：图片直接用浏览器给的原始 data URL（不重编码、不拉伸）；视频抽帧编码后补在后面，整体 ≤8 张
    video_urls = _ph_images_to_dataurls(_ph_vision_tensors(_ph_media_bundle([], videos, [])))
    img_urls = (img_urls + video_urls)[:_PH_MAX_VISION_IMAGES]
    llama = (data or {}).get("llama") or {}
    ap = (data or {}).get("apiParams") or {}
    if not isinstance(ap, dict):
        ap = {}

    HOST = {
        "OpenAI": "https://api.openai.com/v1",
        "DeepSeek": "https://api.deepseek.com/v1",
        "Google Gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
        "Anthropic Claude": "https://api.anthropic.com/v1",
        "SiliconFlow": "https://api.siliconflow.cn/v1",
        "OpenRouter": "https://openrouter.ai/api/v1",
        "Alibaba Qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "Moonshot Kimi": "https://api.moonshot.ai/v1",
        "xAI Grok": "https://api.x.ai/v1",
        "Mistral": "https://api.mistral.ai/v1",
        "Groq": "https://api.groq.com/openai/v1",
        "Ollama": "http://localhost:11434/v1",
    }
    is_anthropic = "Claude" in provider

    # ---- llama：进程内 llama-cpp-python，否则走 llama.cpp 服务器 ----
    llama_server = False
    if method == "llama":
        llama_mode = str(llama.get("mode") or "local")
        model_path = _ph_resolve_gguf(str(llama.get("model") or _ph_global_model_path("model") or "").strip(), [str(llama.get("model_root") or _ph_global_scan_path("model_root") or "").strip()])
        if llama_mode == "local":
            if not model_path:
                raise ValueError("the llama mode is set to in-process llama-cpp-python, but no LLM model file was resolved: set the LLM text encoder model in the llama settings, or switch to the llama.cpp server (HTTP) mode.")
            mmproj = _ph_resolve_gguf(str(llama.get("mmproj") or _ph_global_model_path("mmproj") or "").strip(), [str(llama.get("mmproj_root") or _ph_global_scan_path("mmproj_root") or "").strip()])
            llm = _ph_llama_instance(model_path, mmproj, llama)
            return _ph_llama_chat(llm, prompt, llama, image_b64=img_urls or None)
        server = str(llama.get("server") or "").strip() or "http://127.0.0.1:8080"
        url = server.rstrip("/") + "/v1/chat/completions"
        headers, api_key = {}, ""
        llama_server = True

    # ---- api：OpenAI 兼容 或 Anthropic messages ----
    else:
        api_url = str((data or {}).get("apiUrl") or "").strip()
        api_key = str((data or {}).get("apiKey") or "").strip()
        if not api_url:
            api_url = HOST.get(provider, "")
        if not api_url:
            raise ValueError("enter the API host URL (for example https://api.deepseek.com/v1)")
        base = api_url.rstrip("/")
        if is_anthropic:
            url = base + "/messages" if not base.endswith("/messages") else base
            headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"} if api_key else {"anthropic-version": "2023-06-01"}
        else:
            url = base + "/chat/completions" if not base.endswith("/chat/completions") else base
            headers = {"Authorization": "Bearer " + api_key} if api_key else {}

    system = _PH_OPT_SYSTEM
    if is_anthropic:
        content = []
        for u in img_urls:
            media_type, b64 = _ph_split_data_url(u)
            content.append({"type": "image", "source": {"type": "base64", "media_type": media_type or "image/png", "data": b64}})
        content.append({"type": "text", "text": prompt})
        # Anthropic Messages API 的 system 是顶层字段（原来算了却没带上 → Claude 一直收不到系统提示）
        body = {"model": model or "claude-sonnet-4", "max_tokens": 1024, "system": system,
                "messages": [{"role": "user", "content": content}]}
    else:
        user_content = [{"type": "image_url", "image_url": {"url": u}} for u in img_urls]
        user_content.append({"type": "text", "text": prompt})
        body = {
            "model": model or "gpt-4o-mini",
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user_content}],
            "temperature": 0.7,
        }
        if llama_server:
            # llama.cpp 服务器（OpenAI 兼容端点）：把「llama设置」里的采样参数一并发过去，否则服务器只能用自身启动参数。
            smp = _ph_llama_sampling(llama)
            seed = smp.pop("seed")
            stop = smp.pop("stop")
            body["model"] = model or "local"
            body.update(smp)
            body["seed"] = seed if seed > 0 else -1   # -1 = 服务器每次随机
            if stop:
                body["stop"] = stop

    if method != "llama":
        _ph_apply_api_params(provider, model, body, ap, is_anthropic)

    _proxy = str((data or {}).get("proxy") or "").strip()   # 可选代理（http/socks5）
    result = _ph_chat_completion(url, headers, body, proxy=_proxy)
    if is_anthropic:
        return _ph_anthropic_text(result)
    return str(result["choices"][0]["message"]["content"])


def _ph_split_data_url(url):
    """把 data:<mime>;base64,<data> 拆成 (media_type, base64)；非 data: 返回 ('', url)。"""
    if url.startswith("data:") and ";base64," in url:
        head, b64 = url.split(";base64,", 1)
        return head.replace("data:", ""), b64
    return "", url


def _ph_ensure_progress_attrs():
    """点击即用的优化不在节点执行上下文里跑，但 textgen 的 generate 会用 comfy.utils.ProgressBar，
    它的 hook（main.py hijack_progress）会读 PromptServer.last_prompt_id / last_node_id —— 这两个属性
    main.py 只在真正跑工作流时才写，没跑过工作流时不存在 → AttributeError。
    这里先把缺的属性补成 None，让 hook 能正常走完（进度事件发到前端，prompt_id 为 null 无所谓）。"""
    try:
        srv = PromptServer.instance
        for a in ("last_prompt_id", "last_node_id"):
            if not hasattr(srv, a):
                setattr(srv, a, None)
    except Exception:
        pass


async def _ph_optimize(req):
    """按 method 优化提示词：api / llama 走 OpenAI 兼容 HTTP；textgen 需在执行期用已连接 CLIP。"""
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    _ph_ensure_progress_attrs()
    try:
        import asyncio
        text = await asyncio.to_thread(_ph_optimize_impl, data or {})
    except ValueError as e:
        msg = str(e)
        status = 400 if ("需在节点执行" in msg or "未填写" in msg or "为空" in msg or "请填写" in msg) else 502
        return _web.json_response({"error": msg}, status=status)
    except Exception as e:
        return _web.json_response({"error": f"request failed: {e}"}, status=502)
    if (data or {}).get("clearCache"):
        ph_clear_model_cache()
    return _web.json_response({"ok": True, "text": text})


try:
    PromptServer.instance.routes.post("/prompt_helper/optimize")(_ph_optimize)
except Exception:
    pass


# ===== skill 文件：models 根目录下的 skills 文件夹（md 文件，自动创建）作为「插入 skill」的默认目录 =====
_SKILLS_ROOT_CACHE = None


def ph_skills_dirs():
    global _SKILLS_ROOT_CACHE
    if _SKILLS_ROOT_CACHE is not None:
        return _SKILLS_ROOT_CACHE
    bases = []
    seen = set()
    # 实例 models 根
    try:
        for r in (folder_paths.get_folder_paths("models") or []):
            if r and os.path.normpath(r) not in seen:
                seen.add(os.path.normpath(r)); bases.append(r)
    except Exception:
        pass
    # 共享 models 派生：LLM 等注册目录的父级就是共享 models 基目录（如 ...\ComfyUI-Shared\models）
    try:
        for r in (folder_paths.get_folder_paths("LLM") or []):
            par = os.path.dirname(r)
            if par and os.path.normpath(par) not in seen:
                seen.add(os.path.normpath(par)); bases.append(par)
    except Exception:
        pass
    if not bases:
        try:
            if folder_paths.models_dir:
                bases = [folder_paths.models_dir]
        except Exception:
            pass
    if not bases:
        bases = [os.path.abspath("models")]
    dirs = [os.path.join(b, "skills") for b in bases if b]
    if not dirs:
        dirs = [os.path.join(bases[0], "skills")]
    _SKILLS_ROOT_CACHE = dirs
    return dirs


def ph_ensure_skills_dir():
    dirs = ph_skills_dirs()
    for d in dirs:
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            pass
    return dirs[0] if dirs else None


async def _ph_pick_skill(req):
    """弹 Windows 原生「打开文件」对话框（默认定位 models/skills），返回所选 md 的文本供插入卡片。仅本机客户端。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    initial = ph_ensure_skills_dir() or ""

    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True); root.lift()
            p = filedialog.askopenfilename(title="选择 skill 文件", initialdir=initial or None,
                                           filetypes=[("Markdown", "*.md"), ("所有文件", "*.*")])
            root.destroy()
            return p
        except Exception:
            return ""

    try:
        import asyncio
        p = await asyncio.to_thread(_pick)
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)
    if not p:
        return _web.json_response({"ok": False})
    try:
        with open(p, "r", encoding="utf-8") as fh:
            text = fh.read()
    except Exception as e:
        return _web.json_response({"error": f"failed to read {os.path.basename(p)}: {e}"}, status=500)
    return _web.json_response({"ok": True, "name": os.path.basename(p), "text": text})


def _ph_media_input_dirs():
    from urllib.parse import quote as _q
    roots, seen = [], set()
    for name, fn in (("input", None), (None, "input_directory"), (None, "get_input_directory")):
        try:
            if fn:
                v = getattr(folder_paths, fn)()
            elif name:
                v = folder_paths.get_folder_paths(name) or []
            else:
                v = None
            items = v if isinstance(v, (list, tuple)) else ([v] if v else [])
            for r in items:
                if r and os.path.normpath(r) not in seen:
                    seen.add(os.path.normpath(r)); roots.append(r)
        except Exception:
            pass
    return roots


# ===== 出站主机允许列表（评审要求：/prompt_helper/optimize 不能拿请求里的 apiUrl 去打任意地址）=====
# 允许列表 = 内置厂商域名 + 本机保存的自定义厂商域名 + userdata 里登记的额外主机（仅本机可写）。
# 本机 llama.cpp / Ollama 也走「保存设置时登记一次」这条路，不默认放开 loopback（避免拿它扫本机/内网服务）。
_PH_BUILTIN_HOSTS = (
    "api.openai.com", "api.deepseek.com", "generativelanguage.googleapis.com", "api.anthropic.com",
    "api.siliconflow.cn", "openrouter.ai", "dashscope.aliyuncs.com", "api.moonshot.ai",
    "api.x.ai", "api.mistral.ai", "api.groq.com",
)


def _ph_api_hosts_file():
    try:
        return os.path.join(os.path.dirname(_ph_userdata_file()), "ezflex_api_hosts.json")
    except Exception:
        return ""


def _ph_api_hosts_load():
    fn = _ph_api_hosts_file()
    if not fn or not os.path.isfile(fn):
        return []
    try:
        with open(fn, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return [str(x).strip().lower() for x in data if str(x).strip()] if isinstance(data, list) else []
    except Exception:
        return []


def _ph_allowed_hosts():
    from urllib.parse import urlsplit as _us
    hosts = set(_PH_BUILTIN_HOSTS)
    try:
        fn = _ph_userdata_file()
        if fn and os.path.isfile(fn):
            with open(fn, "r", encoding="utf-8") as fh:
                recs = json.load(fh)
            for rec in (recs if isinstance(recs, list) else []):
                h = _us(str((rec or {}).get("apiUrl") or "")).hostname
                if h:
                    hosts.add(h.lower())
    except Exception:
        pass
    hosts.update(_ph_api_hosts_load())
    return hosts


def _ph_check_outbound(url):
    """出站前校验主机在允许列表里；不在就报清晰错误（不静默、不改小写匹配）。"""
    from urllib.parse import urlsplit as _us
    try:
        host = (_us(str(url)).hostname or "").lower()
    except Exception:
        host = ""
    if not host or host not in _ph_allowed_hosts():
        raise ValueError(
            "API host " + (host or "?") + " is not in the allow-list (security restriction). "
            "Enter and save the address once in the API settings to register that host; built-in providers need no registration."
        )
    return url


def _ph_userdata_file():
    try:
        import folder_paths as fp
        base = getattr(fp, 'user_directory', None) or os.path.join(os.path.dirname(getattr(fp, 'models_dir', '')), 'user')
        if base:
            return os.path.join(base, 'ezflex_custom_providers.json')
    except Exception:
        pass
    return ''


async def _ph_custom_load(req):
    fn = _ph_userdata_file(); arr = []
    if fn and os.path.isfile(fn):
        try:
            with open(fn, 'r', encoding='utf-8') as fh:
                arr = json.loads(fh.read())
        except Exception:
            arr = []
    if not isinstance(arr, list): arr = []
    return _web.json_response({"providers": arr})


async def _ph_custom_save(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    fn = _ph_userdata_file()
    if not fn:
        return _web.json_response({"error": "no userdata"}, status=500)
    name = (data.get("name") or "").strip()
    rec = { "name": name, "provider": (data.get("provider") or "").strip() or name,
            "model": (data.get("model") or "").strip(),
            "apiUrl": (data.get("apiUrl") or "").strip(), "apiKey": (data.get("apiKey") or "").strip(),
            "proxy": (data.get("proxy") or "").strip(), "custom": bool(data.get("custom")) }
    if not rec["name"]:
        return _web.json_response({"error": "enter the provider name"}, status=400)
    try:
        arr = []
        if os.path.isfile(fn):
            try:
                with open(fn, 'r', encoding='utf-8') as fh: arr = json.loads(fh.read())
            except Exception: arr = []
        if not isinstance(arr, list): arr = []
        idx = next((i for i, x in enumerate(arr) if (x.get("name") or "") == rec["name"]), -1)
        if idx >= 0: arr[idx] = rec
        else: arr.append(rec)
        with open(fn, 'w', encoding='utf-8') as fh: json.dump(arr, fh, ensure_ascii=False, indent=2)
        return _web.json_response({"ok": True, "providers": arr})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ph_custom_delete(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    fn = _ph_userdata_file()
    if not fn:
        return _web.json_response({"error": "no userdata"}, status=500)
    name = (req.query.get("name") or "").strip()
    if not name:
        return _web.json_response({"error": "bad name"}, status=400)
    try:
        arr = []
        if os.path.isfile(fn):
            with open(fn, 'r', encoding='utf-8') as fh:
                arr = json.loads(fh.read())
        if not isinstance(arr, list): arr = []
        arr = [x for x in arr if (x.get("name") or "") != name]
        with open(fn, 'w', encoding='utf-8') as fh:
            json.dump(arr, fh, ensure_ascii=False, indent=2)
        return _web.json_response({"ok": True, "providers": arr})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


def _ph_scan_roots(root_q):
    """路径设置：若用户给了自定义扫描目录则只用它；否则回退到 models 根目录枚举。"""
    root_q = (root_q or "").strip()
    if root_q:
        root_q = os.path.abspath(os.path.expanduser(root_q))
        if os.path.isdir(root_q):
            return [root_q]
    return _ph_md_roots()


def _ph_roots_for(extra=None):
    """合并默认 models 根 + 自定义扫描根（用户路径设置），去重。"""
    roots = list(_ph_md_roots())
    seen = {os.path.normpath(r) for r in roots if r}
    for r in (extra or []):
        r = (r or "").strip()
        if not r:
            continue
        r = os.path.abspath(os.path.expanduser(r))
        if os.path.isdir(r) and os.path.normpath(r) not in seen:
            seen.add(os.path.normpath(r)); roots.append(r)
    return roots


async def _ph_pick_folder(req):
    """弹 Windows 原生「选择文件夹」对话框（线程里跑，避免阻塞事件循环并保证置顶）。仅本机客户端。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)

    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True); root.lift()
            p = filedialog.askdirectory(title="选择模型扫描目录")
            root.destroy()
            return p
        except Exception:
            return ""
    try:
        import asyncio
        p = await asyncio.to_thread(_pick)
        return _web.json_response({"ok": bool(p), "path": os.path.normpath(p) if p else ""})
    except Exception as e:
        return _web.json_response({"ok": False, "error": str(e)}, status=500)


async def _ph_scan_roots_info(req):
    """返回当前默认扫描根目录（未设自定义路径时使用），供路径设置输入框动态显示。"""
    roots = _ph_md_roots()
    return _web.json_response({"clip": roots, "model": roots, "mmproj": roots})


def _ph_scan_paths_file():
    base = getattr(folder_paths, 'user_directory', None) or os.path.join(os.path.dirname(getattr(folder_paths, 'models_dir', '')), 'user')
    if not base:
        return ''
    try:
        os.makedirs(base, exist_ok=True)
    except Exception:
        pass
    return os.path.join(base, 'ezflex_scan_paths.json')


def _ph_scan_paths_load():
    fn = _ph_scan_paths_file()
    if not fn or not os.path.isfile(fn):
        return {}
    try:
        with open(fn, 'r', encoding='utf-8') as fh:
            d = json.loads(fh.read())
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _ph_global_scan_path(key):
    return (_ph_scan_paths_load().get(key) or "").strip()


async def _ph_scan_paths_get(req):
    return _web.json_response(_ph_scan_paths_load())


async def _ph_scan_paths_save(req):
    if not _ez_local(req):   # 扫描目录会成为可读根目录，只允许本机改（否则远端能自己扩大根）
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    fn = _ph_scan_paths_file()
    if not fn:
        return _web.json_response({"error": "no userdata"}, status=500)
    rec = {"clip_root": (data.get("clip_root") or "").strip(),
           "model_root": (data.get("model_root") or "").strip(),
           "mmproj_root": (data.get("mmproj_root") or "").strip()}
    try:
        with open(fn, 'w', encoding='utf-8') as fh:
            json.dump(rec, fh, ensure_ascii=False, indent=2)
        return _web.json_response({"ok": True, "paths": rec})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


def _ph_model_paths_file():
    base = getattr(folder_paths, 'user_directory', None) or os.path.join(os.path.dirname(getattr(folder_paths, 'models_dir', '')), 'user')
    if not base:
        return ''
    try:
        os.makedirs(base, exist_ok=True)
    except Exception:
        pass
    return os.path.join(base, 'ezflex_model_paths.json')


def _ph_model_paths_load():
    fn = _ph_model_paths_file()
    if not fn or not os.path.isfile(fn):
        return {}
    try:
        with open(fn, 'r', encoding='utf-8') as fh:
            d = json.loads(fh.read())
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _ph_global_model_path(key):
    return (_ph_model_paths_load().get(key) or "").strip()


async def _ph_model_paths_get(req):
    return _web.json_response(_ph_model_paths_load())


async def _ph_model_paths_save(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    fn = _ph_model_paths_file()
    if not fn:
        return _web.json_response({"error": "no userdata"}, status=500)
    rec = {"clip_path": (data.get("clip_path") or "").strip(),
           "model": (data.get("model") or "").strip(),
           "mmproj": (data.get("mmproj") or "").strip()}
    try:
        with open(fn, 'w', encoding='utf-8') as fh:
            json.dump(rec, fh, ensure_ascii=False, indent=2)
        return _web.json_response({"ok": True, "paths": rec})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


def _ph_prompts_dir():
    """「卡片管理」保存的提示词卡片目录：userdata/prompts（与全局扫描路径同一个 user 目录下）。"""
    base = getattr(folder_paths, 'user_directory', None) or os.path.join(os.path.dirname(getattr(folder_paths, 'models_dir', '')), 'user')
    if not base:
        return ''
    d = os.path.join(base, 'prompts')
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


def _ph_prompt_card_file(name):
    """名称 → userdata/prompts/<名称>.json；含路径分隔符/通配符/隐藏名一律拒绝，并确认仍落在该目录内。"""
    d = _ph_prompts_dir()
    name = str(name or "").strip()
    if not d or not name or len(name) > 64 or name.startswith('.') or any(c in name for c in '\\/:*?"<>|'):
        return ''
    fn = os.path.join(d, name + '.json')
    if os.path.realpath(os.path.dirname(fn)) != os.path.realpath(d):
        return ''
    return fn


async def _ph_pcards_get(req):
    """带 name = 读取一份保存的提示词卡片；不带 name = 已保存卡片清单（下拉框数据源）。"""
    name = (req.query.get("name") or "").strip()
    d = _ph_prompts_dir()
    if name:
        fn = _ph_prompt_card_file(name)
        if not fn or not os.path.isfile(fn):
            return _web.json_response({"error": "no card named " + name}, status=404)
        try:
            with open(fn, 'r', encoding='utf-8') as fh:
                rec = json.loads(fh.read())
        except Exception as e:
            return _web.json_response({"error": str(e)}, status=500)
        cards = rec.get("cards") if isinstance(rec, dict) else None
        return _web.json_response({"name": name, "cards": cards if isinstance(cards, list) else []})
    out = []
    if d and os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(d, fn), 'r', encoding='utf-8') as fh:
                    rec = json.loads(fh.read())
            except Exception:
                continue
            cards = rec.get("cards") if isinstance(rec, dict) else None
            out.append({"name": fn[:-5], "count": len(cards) if isinstance(cards, list) else 0})
    return _web.json_response({"cards": out})


async def _ph_pcards_save(req):
    """把选中的提示词卡片存进 userdata/prompts/<名称>.json（同名覆盖）。仅本机客户端。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    name = (data.get("name") or "").strip()
    cards = data.get("cards")
    fn = _ph_prompt_card_file(name)
    if not fn:
        return _web.json_response({"error": 'invalid name: must not contain \\ / : * ? " < > | , must not start with a dot, max 64 characters'}, status=400)
    if not isinstance(cards, list) or not cards:
        return _web.json_response({"error": "no card selected to save"}, status=400)
    try:
        with open(fn, 'w', encoding='utf-8') as fh:
            json.dump({"name": name, "cards": cards}, fh, ensure_ascii=False, indent=2)
        return _web.json_response({"ok": True, "name": name, "count": len(cards)})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ph_pcards_delete(req):
    """删除一份保存的提示词卡片。仅本机客户端。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    name = (req.query.get("name") or "").strip()
    fn = _ph_prompt_card_file(name)
    if not fn or not os.path.isfile(fn):
        return _web.json_response({"error": "no card named " + name}, status=404)
    try:
        os.remove(fn)
        return _web.json_response({"ok": True})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ph_api_hosts_get(req):
    return _web.json_response({"hosts": sorted(_ph_allowed_hosts()), "registered": _ph_api_hosts_load()})


async def _ph_api_hosts_post(req):
    """登记出站主机（本机保存 API/llama 设置时调用，或用户手动加）。只允许本机客户端。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    from urllib.parse import urlsplit as _us
    try:
        data = await req.json()
    except Exception:
        data = {}
    hosts = _ph_api_hosts_load()
    for u in (data.get("urls") or []):
        h = _us(str(u or "")).hostname
        if h and h.lower() not in hosts:
            hosts.append(h.lower())
    for h in (data.get("hosts") or []):
        h = str(h or "").strip().lower()
        if h and h not in hosts:
            hosts.append(h)
    try:
        fn = _ph_api_hosts_file()
        os.makedirs(os.path.dirname(fn), exist_ok=True)
        with open(fn, "w", encoding="utf-8") as fh:
            json.dump(hosts, fh, ensure_ascii=False, indent=2)
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)
    return _web.json_response({"ok": True, "hosts": sorted(_ph_allowed_hosts())})


try:
    PromptServer.instance.routes.get("/prompt_helper/custom_providers")(_ph_custom_load)
    PromptServer.instance.routes.get("/prompt_helper/api_hosts")(_ph_api_hosts_get)
    PromptServer.instance.routes.post("/prompt_helper/api_hosts")(_ph_api_hosts_post)
    PromptServer.instance.routes.post("/prompt_helper/custom_providers")(_ph_custom_save)
    PromptServer.instance.routes.delete("/prompt_helper/custom_providers")(_ph_custom_delete)
    PromptServer.instance.routes.post("/prompt_helper/pick_folder")(_ph_pick_folder)
    PromptServer.instance.routes.post("/prompt_helper/pick_skill")(_ph_pick_skill)
    PromptServer.instance.routes.get("/prompt_helper/scan_roots")(_ph_scan_roots_info)
    PromptServer.instance.routes.get("/prompt_helper/scan_paths")(_ph_scan_paths_get)
    PromptServer.instance.routes.post("/prompt_helper/scan_paths")(_ph_scan_paths_save)
    PromptServer.instance.routes.get("/prompt_helper/model_paths")(_ph_model_paths_get)
    PromptServer.instance.routes.post("/prompt_helper/model_paths")(_ph_model_paths_save)
    PromptServer.instance.routes.get("/prompt_helper/prompt_cards")(_ph_pcards_get)
    PromptServer.instance.routes.post("/prompt_helper/prompt_cards")(_ph_pcards_save)
    PromptServer.instance.routes.delete("/prompt_helper/prompt_cards")(_ph_pcards_delete)
except Exception:
    pass


# ===== GGUF 模型：扫描「实例 models」+「共享 models」(extra_model_paths 注册的 LLM 等) 供 llama 选取/解析 =====
def _ph_md_roots():
    roots = []
    seen = set()
    cand = ("models", "LLM", "llm", "gguf", "diffusion_models", "text_encoders", "clip", "clip_vision", "unet")
    for name in cand:
        try:
            for r in (folder_paths.get_folder_paths(name) or []):
                if r and os.path.normpath(r) not in seen:
                    seen.add(os.path.normpath(r)); roots.append(r)
        except Exception:
            continue
    # 兜底：把 folder_names_and_paths 里名称含 llm/gguf 的注册目录也纳入
    try:
        for name in folder_paths.folder_names_and_paths:
            if ("llm" in name.lower() or "gguf" in name.lower()) and name not in cand:
                try:
                    for r in (folder_paths.get_folder_paths(name) or []):
                        if r and os.path.normpath(r) not in seen:
                            seen.add(os.path.normpath(r)); roots.append(r)
                except Exception:
                    continue
    except Exception:
        pass
    if not roots:
        try:
            if folder_paths.models_dir:
                roots = [folder_paths.models_dir]
        except Exception:
            pass
    if not roots:
        roots = [os.path.abspath("models")]
    return [r for r in roots if r]


def _ph_resolve_gguf(p, extra_roots=None):
    """把用户填的 GGUF 路径解析为真实绝对路径：支持绝对路径、相对任一 models/LLM 根的子路径、仅文件名。找不到返回 ''。
    extra_roots 为路径设置里用户自定义的扫描目录（可多级）。"""
    if not p:
        return ""
    p = p.strip().strip('"').strip("'")
    if os.path.isfile(p):
        return os.path.abspath(p)
    base = os.path.basename(p)
    for root in _ph_roots_for(extra_roots):
        cand = os.path.join(root, p)
        if os.path.isfile(cand):
            return os.path.abspath(cand)
        for dirpath, _dirs, files in os.walk(root):
            if base in files:
                return os.path.abspath(os.path.join(dirpath, base))
    return ""


async def _ph_llama_models(req):
    """列出共享 models 文件夹下所有 .gguf（相对每个根目录的路径），供前端像选模型一样选取。
    ?root= 为路径设置里自定义的扫描目录（优先，替换默认）。"""
    root_q = (req.query.get("root") or "").strip()
    seen = set()
    out = []
    for root in _ph_scan_roots(root_q):
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if not fn.lower().endswith(".gguf"):
                    continue
                full = os.path.abspath(os.path.join(dirpath, fn))
                if full in seen:
                    continue
                seen.add(full)
                rel = os.path.relpath(full, os.path.abspath(root))
                out.append({"path": rel.replace("\\", "/"), "name": fn})
    out.sort(key=lambda x: (x["name"] or "").lower())
    return _web.json_response({"models": out})


async def _ph_clip_models(req):
    """列出共享/实例 models 下的 .safetensors/.ckpt/.pt 等文本编码器文件，供 TextGenerate 选 CLIP 模型。
    ?root= 为路径设置里自定义的扫描目录（优先，替换默认）。"""
    root_q = (req.query.get("root") or "").strip()
    seen = set()
    out = []
    for root in _ph_scan_roots(root_q):
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                lf = fn.lower()
                if not lf.endswith((".safetensors", ".ckpt", ".pt", ".pth", ".bin")):
                    continue
                full = os.path.abspath(os.path.join(dirpath, fn))
                if full in seen:
                    continue
                seen.add(full)
                rel = os.path.relpath(full, os.path.abspath(root)).replace("\\", "/")
                out.append({"path": rel, "name": fn})
    out.sort(key=lambda x: (x["name"] or "").lower())
    return _web.json_response({"models": out})


try:
    PromptServer.instance.routes.get("/prompt_helper/llama_models")(_ph_llama_models)
    PromptServer.instance.routes.get("/prompt_helper/clip_models")(_ph_clip_models)
except Exception:
    pass


# ===== EzFlex-MediaLoader / EzFlex-MediaOut：媒体素材加载与拆分 =====
# 数据模型（MediaLoader config widget）：
#   { groups:[{id,name,cards:[{id,name,items:[{id,files:[{id,name,path,subfolder,dir,type}]}]}]}],
#     currentGroupId, currentPreset }
#   - 「素材卡片」= 一行卡片，对应 MediaLoader 的一个深红输出端口（标签 = 分组名_卡片名）。
#   - 卡片内 items 是网格里的媒体卡；每张媒体卡可含 1..N 个文件（批量堆叠）。
#   - MediaLoader 运行期按「分组顺序→卡片顺序」加载每张卡片内全部文件，
#     输出为一个带 _kind=ezflex_media_card 的卡片对象（files 为已加载值列表）。
#   - MediaOut 接收该卡片对象，按文件逐个拆出真实类型的输出端口。

_MEDIA_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
_MEDIA_VID_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}
_MEDIA_AUD_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".aac", ".m4a", ".opus", ".wma"}
_MEDIA_3D_EXTS = {".obj", ".glb", ".gltf", ".fbx", ".stl", ".ply", ".3ds", ".dae", ".blend"}


def _media_kind(name):
    """按文件后缀推断媒体类型：image / video / audio / model_3d，无则返回 'other'。"""
    ext = os.path.splitext(name or "")[1].lower()
    if ext in _MEDIA_IMG_EXTS:
        return "image"
    if ext in _MEDIA_VID_EXTS:
        return "video"
    if ext in _MEDIA_AUD_EXTS:
        return "audio"
    if ext in _MEDIA_3D_EXTS:
        return "model_3d"
    return "other"


def _file_kind(f):
    """媒体文件的真实类型：以扩展名为准（卡片里存的 type 可能是旧值/猜错的，会让端口类型不对、连不上目标输入）。"""
    if not isinstance(f, dict):
        return "other"
    by_name = _media_kind(f.get("name") or f.get("path") or "")
    if by_name != "other":
        return by_name
    return str(f.get("type") or "other").lower()


MEDIA_TO_COMFY = {
    "image": "IMAGE", "video": "VIDEO", "audio": "AUDIO",
    "model_3d": "FILE_3D", "model": "FILE_3D", "3d": "FILE_3D",
    "other": "STRING", "text": "STRING", "*": "*",
}
# 端口类型与内置加载节点保持一致：Load Image→IMAGE、Load Video→VIDEO、Load Audio→AUDIO、Load3D→FILE_3D。
# 视频给的是内置同款 VideoFromFile 对象（懒加载、自带帧率/音轨），要帧就用内置 Get Video Components 取。


def _ml_resolve(path):
    """把媒体路径解析成绝对路径：相对路径按 input 目录解析，绝对路径必须是「允许目录」内的；
    根外 / 找不到一律返回 ''（评审要求：不接受调用方给的任意路径）。"""
    if not path:
        return ""
    try:
        p = _ez_real(path)
        if p and os.path.isfile(p):
            return _ez_inside(p)
        for root in _ph_media_input_dirs():
            q = _ez_inside(os.path.join(root, path))
            if q and os.path.isfile(q):
                return q
    except Exception:
        pass
    return ""


def _ml_load_image(path):
    """与内置 Load Image 同款：CHW 归一化到 float32 的 [1,H,W,3]（0..1，RGB）。"""
    from PIL import Image, ImageOps
    i = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    arr = np.array(i).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _ml_load_video(path):
    """与内置 Load Video 同款：返回 VideoFromFile 对象（懒加载，不解码）。
    自带真实帧率/音轨，能直接接 Video 类输入；要帧就接内置 Get Video Components，
    它的 images 输出正是 MiniMax H3 的 ref_video 需要的帧序列。"""
    return InputImpl.VideoFromFile(path)


def _pcm_to_float(wav):
    """与内置 Load Audio 的 f32_pcm 一致：整数 PCM 归一，已经是浮点的原样返回。"""
    if wav.dtype.is_floating_point:
        return wav
    if wav.dtype == torch.int16:
        return wav.float() / (2 ** 15)
    if wav.dtype == torch.int32:
        return wav.float() / (2 ** 31)
    return wav.float() / 32768.0


def _ml_load_audio(path):
    """与内置 Load Audio 同款：{"waveform": [1,C,T] float32, "sample_rate": int}（batch 维必须有）。
    额外带一个 "path"（原始文件绝对路径，非标准键、内置节点不读）：这样预览节点可以直接播放原文件，
    不用把波形重新编码一遍（mp3/flac/ogg 都能原样播）。"""
    empty = {"waveform": torch.zeros((1, 1, 0), dtype=torch.float32), "sample_rate": 44100, "path": os.path.abspath(path)}
    try:
        import av
        rate = 44100
        chunks = []
        with av.open(path, mode="r") as container:
            s = next((x for x in container.streams if x.type == "audio"), None)
            if s is None:
                return empty
            n_ch = int(s.channels or 0)
            if s.rate:
                rate = int(s.rate)
            for frame in container.decode(s):
                arr = frame.to_ndarray()
                buf = torch.from_numpy(np.ascontiguousarray(arr))
                if buf.ndim == 1:
                    buf = buf[None, :]
                # 打包格式会解成 [1, samples*channels]，按内置同法还原成 [channels, samples]
                if n_ch and buf.shape[0] != n_ch:
                    buf = buf.reshape(-1, n_ch).t()
                chunks.append(buf)
        if not chunks:
            return {"waveform": torch.zeros((1, 1, 0), dtype=torch.float32), "sample_rate": rate, "path": os.path.abspath(path)}
        wav = _pcm_to_float(torch.cat(chunks, dim=1))
        return {"waveform": wav.unsqueeze(0), "sample_rate": rate, "path": os.path.abspath(path)}
    except Exception:
        return empty


def _ml_load_3d(path):
    """与内置 Load3D 的 model_3d 输出同款：FILE_3D 类型 + File3D 对象。"""
    return Types.File3D(os.path.abspath(path))


_TEXT_EXTS = {".txt", ".md", ".json", ".csv", ".log", ".py", ".js", ".html", ".css", ".xml", ".yaml", ".yml", ".ini", ".cfg", ".sh", ".bat", ".ts", ".tsx", ".jsx", ".toml", ".srt", ".ass", ".vtt"}
_TEXT_CAP = 1024 * 1024


def _ml_read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = f.read(_TEXT_CAP)
        return data
    except Exception:
        return path


def _ml_load_media(path, ftype):
    ftype = (ftype or _media_kind(path) or "").lower()
    if ftype == "image":
        return _ml_load_image(path)
    if ftype == "video":
        return _ml_load_video(path)
    if ftype == "audio":
        return _ml_load_audio(path)
    if ftype in ("model_3d", "model", "3d"):
        return _ml_load_3d(path)
    if os.path.splitext(path)[1].lower() in _TEXT_EXTS:
        return _ml_read_text(path)
    return path


def parse_media_cards(config):
    """把 MediaLoader config 解析成按「分组→卡片」顺序排序的卡片列表（带 label）。"""
    if isinstance(config, str):
        if not config.strip():
            return []
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            return []
    else:
        data = config
    if isinstance(data, dict):
        data = data.get("groups") or []
    if not isinstance(data, list):
        return []
    cards_out = []
    for g in data:
        if not isinstance(g, dict):
            continue
        gname = (g.get("name") or "").strip() or "分组"
        for c in (g.get("cards") or []):
            if not isinstance(c, dict):
                continue
            items = []
            for it in (c.get("items") or []):
                if not isinstance(it, dict):
                    continue
                files = []
                for f in (it.get("files") or []):
                    if not isinstance(f, dict):
                        continue
                    nm = f.get("name") or ""
                    files.append({
                        "id": f.get("id"),
                        "name": nm,
                        "path": f.get("path") or "",
                        "subfolder": f.get("subfolder") or "",
                        "dir": f.get("dir") or "input",
                        "type": f.get("type") or _media_kind(nm) or "other",
                    })
                items.append({"id": it.get("id"), "files": files})
            cname = (c.get("name") or "").strip() or "素材卡片"
            cards_out.append({
                "id": c.get("id"),
                "name": cname,
                "group": gname,
                "label": gname + "_" + cname,
                "items": items,
            })
    return cards_out


async def _ml_files(req):
    """列出 input 目录下的媒体文件（含子目录），供 MediaLoader 浏览弹窗选取。"""
    from urllib.parse import quote as _q
    out = []
    for root in _ph_media_input_dirs():
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            rel = os.path.relpath(dirpath, root).replace("\\", "/")
            for fn in sorted(files):
                typ = _media_kind(fn)
                if typ == "other":
                    continue
                sub = "" if rel == "." else rel
                path = (rel + "/" + fn) if rel != "." else fn
                full = os.path.join(dirpath, fn)
                try:
                    size = os.path.getsize(full)
                    mtime = _fmt_mtime(os.path.getmtime(full))
                except Exception:
                    size, mtime = 0, ""
                url = "/view?type=input&filename=" + _q(fn) + ("&subfolder=" + _q(sub) if sub else "")
                out.append({
                    "name": fn, "path": path, "subfolder": sub, "dir": "input",
                    "type": typ, "url": url, "size": size, "mtime": mtime,
                })
    return _web.json_response({"files": out})


async def _ml_outputs(req):
    try:
        data = await req.json()
        labels = data.get("labels") or []
        MediaLoaderNode.RETURN_TYPES = tuple(_MEDIA_CARD for _ in labels)
        MediaLoaderNode.RETURN_NAMES = tuple(labels)
        return _web.json_response({"ok": True, "names": labels})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _mo_outputs(req):
    try:
        data = await req.json()
        mode = str(data.get("mode") or "split")
        files = data.get("files") or []
        off = data.get("off") or []
        if not isinstance(off, list):
            off = []
        offset = {str(x) for x in off}
        if mode == "split":
            types = [MEDIA_TO_COMFY.get(_file_kind(f), "STRING") for f in files]
            names = [f.get("name") or f"文件 {i + 1}" for i, f in enumerate(files)]
        else:
            groups = data.get("groups") or []
            rows = _config_to_rows(groups)
            groupings = _mo_groupings(mode, off, rows)
            if mode == "group":
                # 分组模式：把空组也去掉后，按分组标签输出
                types = [g["type"] for g in groupings]
                names = [g["name"] for g in groupings]
            else:
                types = [g["type"] for g in groupings]
                names = [g["name"] for g in groupings]
        MediaOutNode.RETURN_TYPES = tuple(types)
        MediaOutNode.RETURN_NAMES = tuple(names)
        return _web.json_response({"ok": True, "types": types, "names": names})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


def _mout_parse_off(config):
    """解析 MediaOut 局部禁用的文件 id 集合（config = {"off":[ids]}）。"""
    if isinstance(config, str):
        if not config.strip():
            return {}
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            return {}
    else:
        data = config or {}
    if not isinstance(data, dict):
        return {}
    off = data.get("off") or []
    if not isinstance(off, list):
        off = []
    return {str(x): True for x in off}


def _mout_mode(config):
    """MediaOut 输出模式：split / card / row / group。"""
    if isinstance(config, str):
        if not config.strip():
            return "split"
        try:
            data = json.loads(config)
        except json.JSONDecodeError:
            return "split"
    else:
        data = config or {}
    if isinstance(data, dict):
        m = str(data.get("mode") or "split")
        if m in ("card", "row", "group"):
            return m
    return "split"


def _mo_common_kind(files):
    """一组文件的共同类型；超过一种就返回 ''（无法合并成单一批量）。"""
    kinds = {_file_kind(f) for f in (files or [])}
    return kinds.pop() if len(kinds) == 1 else ""


def _mo_one(files, name):
    """给定一个输出分组的文件列表，算出端口类型：同一类型用该类型，混合类型用 *（运行期会给出明确报错）。"""
    files = files or []
    k = _mo_common_kind(files)
    t = MEDIA_TO_COMFY.get(k, "*") if k else "*"
    return {"name": name or "素材", "type": t, "files": files}


def _mout_fit(config):
    """多文件合并（批量）设置：size = 'first'（以第一张为准，默认）或 'WxH'；fit = crop/pad/stretch；
    cap = 每个端口最多取几个文件（0=不限）；start = 从第几个文件开始取（0 起）。
    这些由前端「批量设置」弹窗写入（同 KJNodes Load Images From Folder 的可选项）。"""
    fit = {"size": "first", "fit": "crop", "cap": 0, "start": 0}
    try:
        if isinstance(config, str):
            data = json.loads(config) if config.strip() else {}
        else:
            data = config or {}
        f = (data or {}).get("fit") if isinstance(data, dict) else None
        if isinstance(f, dict):
            sz = str(f.get("size") or "").strip().lower()
            if sz and sz != "first":
                m = re.match(r"^(\d+)\s*[x×*]\s*(\d+)$", sz)
                if m:
                    fit["size"] = f"{int(m.group(1))}x{int(m.group(2))}"
            mode = str(f.get("fit") or "").strip().lower()
            if mode in ("crop", "pad", "stretch"):
                fit["fit"] = mode
            try:
                fit["cap"] = max(0, int(f.get("cap") or 0))
            except (TypeError, ValueError):
                fit["cap"] = 0
            try:
                fit["start"] = max(0, int(f.get("start") or 0))
            except (TypeError, ValueError):
                fit["start"] = 0
    except Exception:
        pass
    return fit


def _mo_edge_color(arr):
    """取图片四条边的中位色（补边用，同 KJNodes 的 get_edge_color 思路）。"""
    try:
        e = np.concatenate([
            arr[0, :, :], arr[-1, :, :], arr[:, 0, :], arr[:, -1, :],
        ], axis=0)
        return np.median(e, axis=0)
    except Exception:
        return np.zeros(arr.shape[-1], dtype=arr.dtype)


def _mo_fit_image(t, width, height, mode):
    """把单张图 [H,W,C] float 对齐到目标尺寸：crop=等比缩放+居中裁剪，pad=等比缩放+边缘色补边，stretch=直接拉伸。"""
    import comfy.utils as _cu
    v = t.movedim(-1, 0).unsqueeze(0)   # HWC -> CHW -> BCHW（common_upscale 要 BCHW）
    if mode == "stretch":
        return _cu.common_upscale(v, width, height, "bilinear", "disabled").squeeze(0).movedim(0, -1)
    if mode == "crop":
        return _cu.common_upscale(v, width, height, "bilinear", "center").squeeze(0).movedim(0, -1)
    # pad：先等比缩放到能放进目标框，再用边缘中位色补满
    h0, w0 = int(t.shape[0]), int(t.shape[1])
    scale = min(width / max(1, w0), height / max(1, h0))
    nw, nh = max(1, int(round(w0 * scale))), max(1, int(round(h0 * scale)))
    fitted = _cu.common_upscale(v, nw, nh, "bilinear", "disabled").squeeze(0).movedim(0, -1)
    from PIL import Image as _Im
    arr = (np.clip(fitted.numpy(), 0.0, 1.0) * 255).astype(np.uint8)
    color = tuple(int(c) for c in _mo_edge_color(arr))
    if len(color) == 3:
        canvas = _Im.new("RGB", (width, height), color)
    else:
        canvas = _Im.new("RGBA", (width, height), color)
    canvas.paste(_Im.fromarray(arr), ((width - nw) // 2, (height - nh) // 2))
    out = np.asarray(canvas).astype(np.float32) / 255.0
    return torch.from_numpy(out)


def _mo_batch_images(vals, label, fit=None):
    """多张图合并成 IMAGE 批量张量。规则与内置 Batch Images / KJNodes Load Images From Folder 一致：
    尺寸不一致时按 fit 设置对齐（默认以「第一张」为准 + 等比裁剪 center crop），通道数不一致按最大值补齐（补 alpha=1.0）。"""
    fit = fit or {"size": "first", "fit": "crop"}
    try:
        return torch.cat(vals, dim=0)
    except Exception:
        pass
    try:
        max_c = max(int(v.shape[-1]) for v in vals)
        padded = [
            torch.nn.functional.pad(v, (0, max_c - int(v.shape[-1])), mode="constant", value=1.0)
            if int(v.shape[-1]) < max_c else v
            for v in vals
        ]
        base = padded[0]
        bh, bw = int(base.shape[1]), int(base.shape[2])
        want = str(fit.get("size") or "first")
        if want != "first":
            try:
                w_s, h_s = want.lower().split("x")
                bw, bh = int(w_s), int(h_s)
            except Exception:
                pass
        mode = str(fit.get("fit") or "crop")
        out = []
        for v in padded:
            if tuple(v.shape[1:]) != (bh, bw, max_c):
                v = _mo_fit_image(v[0], bw, bh, mode).unsqueeze(0)
            out.append(v)
        size_txt = "第一张" if want == "first" else want
        mode_txt = {"crop": "等比裁剪", "pad": "等比补边", "stretch": "拉伸"}.get(mode, mode)
        print(f"[EzFlex-MediaOut] 端口「{label}」里图片尺寸不一致，已按「{size_txt}」{bw}x{bh} + {mode_txt} 对齐后合并为批量。")
        return torch.cat(out, dim=0)
    except Exception as e:
        raise ValueError(
            f'EzFlex-MediaOut: (port "{label}") this group has {len(vals)} images and cannot be merged into a batched tensor ({e}). '
            f"Switch to split mode and connect the files one by one."
        ) from e


def _mo_merge_values(values, label, kind="", fit=None):
    """把一个分组里的多个值合并成「下游能读的合法值」：
      - 单文件：原值
      - 多张图：torch.cat 成批量张量 [B,H,W,C]（ImageFromBatch / 采样器 / 任何 IMAGE 输入都能用）
      - 多段音频：同采样率则沿时间轴拼成一条音轨
      - 多段文本：换行拼接
    类型不一致、或尺寸/采样率对不上时抛出明确错误（提示改用「拆分」模式），而不是塞一个下游读不了的 list。
    """
    vals = list(values or [])
    if not vals:
        return None
    if len(vals) == 1:
        return vals[0]
    hint = f'(port "{label}") '
    if kind == "image" or all(isinstance(v, torch.Tensor) for v in vals):
        return _mo_batch_images(vals, label, fit)
    if kind == "audio" or all(isinstance(v, dict) and "waveform" in v for v in vals):
        rates = {int(v.get("sample_rate") or 0) for v in vals}
        if len(rates) != 1:
            raise ValueError(f"EzFlex-MediaOut: {hint}these audio clips have mixed sample rates ({sorted(rates)}) and cannot be joined into one track; use split mode.")
        try:
            waves = [v["waveform"] for v in vals]
            shapes = {tuple(w.shape[1:]) for w in waves}
            if len(shapes) != 1:
                # 声道数不一致：只要有一个单声道就整体升成多声道
                ch = max(int(w.shape[1]) for w in waves)
                waves = [w.repeat(1, ch, 1) if int(w.shape[1]) == 1 and ch > 1 else w for w in waves]
            return {"waveform": torch.cat(waves, dim=2), "sample_rate": rates.pop()}
        except Exception as e:
            raise ValueError(f"EzFlex-MediaOut: {hint}these audio clips cannot be joined ({e}); use split mode.") from e
    if all(isinstance(v, str) for v in vals):
        return "\n".join(vals)
    kinds_txt = "、".join(sorted({
        "图像" if isinstance(v, torch.Tensor) else
        "音频" if isinstance(v, dict) and "waveform" in v else
        "文本" if isinstance(v, str) else
        "视频" if hasattr(v, "get_components") or hasattr(v, "get_stream_source") else
        type(v).__name__ for v in vals
    }))
    raise ValueError(
        f"EzFlex-MediaOut: {hint}this group has {len(vals)} files of mixed types ({kinds_txt}) and cannot be merged into a single batched value; "
        f"switch MediaOut to split mode and connect the files one by one."
    )


def _mo_groupings(mode, off, rows):
    """把 rows（素材卡片组结构）按 mode 归组，返回 [{name,type,files}]。"""
    offset = {str(x) for x in (off or [])}
    def keep(f): return f and str(f.get("id")) not in offset
    out = []
    if mode == "card":
        for row in rows:
            for it in (row.get("items") or []):
                files = [f for f in (it.get("files") or []) if keep(f)]
                if not files:
                    continue
                out.append(_mo_one(files, files[0].get("name") or "素材"))
    elif mode == "row":
        for row in rows:
            files = []
            for it in (row.get("items") or []):
                files.extend([f for f in (it.get("files") or []) if keep(f)])
            if not files:
                continue
            out.append(_mo_one(files, row.get("label") or "素材卡片组"))
    elif mode == "group":
        byg, order = {}, []
        for row in rows:
            g = row.get("group") or "分组"
            if g not in byg:
                byg[g] = []; order.append(g)
            byg[g].append(row)
        for g in order:
            files = []
            for row in byg[g]:
                for it in (row.get("items") or []):
                    files.extend([f for f in (it.get("files") or []) if keep(f)])
            if not files:
                continue
            out.append(_mo_one(files, g))
    return out


def _config_to_rows(groups):
    """把前端 config 的 groups（分组→素材卡片组→单个卡片→批量卡片）转成 rows 结构（含 label）。"""
    rows = []
    for grp in (groups or []):
        if not isinstance(grp, dict):
            continue
        gname = (grp.get("name") or "").strip() or "分组"
        for c in (grp.get("cards") or []):
            if not isinstance(c, dict):
                continue
            items = []
            for it in (c.get("items") or []):
                if not isinstance(it, dict):
                    continue
                files = []
                for f in (it.get("files") or []):
                    if not isinstance(f, dict):
                        continue
                    nm = f.get("name") or ""
                    files.append({"id": f.get("id"), "name": nm,
                                  "type": f.get("type") or _media_kind(nm) or "other"})
                items.append({"id": it.get("id"), "files": files})
            cname = (c.get("name") or "").strip() or "素材卡片组"
            rows.append({"group": gname, "cardId": c.get("id"), "label": gname + "_" + cname, "items": items})
    return rows


def _mout_flatten(card):
    """把 MediaLoader 卡片对象 / 单值 / 列表 统一展开成文件描述符列表。"""
    if card is None:
        return []
    if isinstance(card, dict) and card.get("_kind") == "ezflex_media_card":
        return card.get("files") or []
    if isinstance(card, (list, tuple)):
        out = []
        for i, x in enumerate(card):
            if isinstance(x, dict) and "value" in x:
                out.append(x)
            else:
                out.append({"id": f"f{i}", "name": getattr(x, "name", None) or f"文件 {i + 1}",
                            "type": _media_kind(getattr(x, "name", None) or "") or "other", "value": x})
        return out
    if isinstance(card, dict) and ("value" in card or "type" in card):
        return [card]
    return [{"id": "f0", "name": "File", "type": "other", "value": card}]


def _ml_media_root():
    roots = _ph_media_input_dirs()
    return roots[0] if roots else ""


def _ml_roots_file():
    try:
        return os.path.join(os.path.dirname(_ph_userdata_file()), "ezflex_media_roots.json")
    except Exception:
        return ""


_ML_SEED_CACHE = {"t": 0, "dirs": []}


def _ml_json_paths(obj, depth=0):
    """递归挑出 JSON 里像媒体文件的绝对路径（用于把素材所在目录收成可浏览根）。"""
    res = []
    if depth > 8:
        return res
    try:
        if isinstance(obj, dict):
            for v in obj.values():
                res.extend(_ml_json_paths(v, depth + 1))
        elif isinstance(obj, (list, tuple)):
            for v in obj:
                res.extend(_ml_json_paths(v, depth + 1))
        elif isinstance(obj, str):
            s = obj.strip()
            if 3 < len(s) < 4096 and _media_kind(s) != "other":
                cand = s if os.path.isabs(s) else ""
                if not cand:
                    for root in _ph_media_input_dirs():
                        q = os.path.join(root, s)
                        if os.path.isfile(q):
                            cand = q
                            break
                if cand and os.path.isfile(cand):
                    res.append(cand)
    except Exception:
        pass
    return res


def _ml_seed_roots():
    """从用户自己的数据里补根目录：已保存预设/卡片里引用过的素材所在目录（不是请求参数）。
    带 30 秒缓存，避免每次浏览都扫一遍 user_data。"""
    import time as _time
    now = _time.time()
    if now - _ML_SEED_CACHE["t"] < 30:
        return list(_ML_SEED_CACHE["dirs"])
    out = []
    dirs = []
    try:
        dirs.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "user_data"))
    except Exception:
        pass
    try:
        ud = getattr(folder_paths, "user_directory", None)
        if ud:
            dirs.append(ud)
    except Exception:
        pass
    for d in dirs:
        try:
            if not os.path.isdir(d):
                continue
            for f in os.listdir(d):
                if not f.lower().endswith(".json"):
                    continue
                try:
                    with open(os.path.join(d, f), "r", encoding="utf-8") as fh:
                        data = json.load(fh)
                except Exception:
                    continue
                for p in _ml_json_paths(data):
                    dd = os.path.dirname(p)
                    if dd and dd not in out:
                        out.append(dd)
        except Exception:
            continue
    _ML_SEED_CACHE["t"] = now
    _ML_SEED_CACHE["dirs"] = list(out)
    return out


def _ml_default_roots():
    """素材浏览器默认只给 ComfyUI 的 input / output；temp、models 与别的目录都由用户自己登记为根。"""
    out = []
    for fn in ("get_input_directory", "get_output_directory"):
        try:
            v = getattr(folder_paths, fn, None)
            v = v() if callable(v) else ""
            if v:
                out.append(_ez_real(v))
        except Exception:
            pass
    return [x for x in out if x]


def _ml_user_roots():
    """用户自己登记的根（写进 roots 文件的），只有这些能删；内置根删不掉。"""
    out = []
    try:
        fn = _ml_roots_file()
        if fn and os.path.isfile(fn):
            with open(fn, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                dropped = 0
                for x in data:
                    r = _ez_real(x)
                    if not r:
                        continue
                    if os.path.dirname(r) == r:   # 整盘不再是根：忽略并顺手清掉（自愈）
                        dropped += 1
                        continue
                    out.append(r)
                if dropped:
                    try:
                        with open(fn, "w", encoding="utf-8") as fh:
                            json.dump(out, fh, ensure_ascii=False, indent=2)
                    except Exception:
                        pass
    except Exception:
        out = []
    return out


def _ml_roots():
    """MediaLoader 文件浏览器可浏览的根：input / output + 用户登记的扫描目录 + 本机添加的根。"""
    roots = _ml_default_roots()
    try:
        roots.extend([_ez_real(x) for x in _ml_seed_roots() if _ez_real(x)])
    except Exception:
        pass
    for r in _ml_user_roots():
        if r not in roots:
            roots.append(r)
    seen, out = set(), []
    for r in roots:
        if r and r not in seen:
            seen.add(r)
            out.append(r)
    return out


def _media_safe(name):
    name = os.path.basename((name or "").replace("\\", "/")).strip()
    name = re.sub(r"[^A-Za-z0-9._\-\u4e00-\u9fff()（）\s]+", "_", name)
    return name


async def _ml_upload(req):
    """接收拖拽上传的多媒体文件，保存到 ComfyUI input 目录，返回可加入素材卡片的文件描述。"""
    try:
        root = _ml_media_root()
        if not root:
            return _web.json_response({"error": "no input dir"}, status=500)
        from urllib.parse import quote as _q
        results = []
        post = await req.post()
        for val in post.getall("files", []):
            if not (hasattr(val, "filename") and hasattr(val, "file")):
                continue
            name = _media_safe(val.filename)
            if not name:
                continue
            data = val.file.read() if hasattr(val.file, "read") else val.file
            dest = os.path.join(root, name)
            with open(dest, "wb") as fh:
                fh.write(data)
            typ = _media_kind(name)
            try:
                size = os.path.getsize(dest)
                mtime = _fmt_mtime(os.path.getmtime(dest))
            except Exception:
                size, mtime = 0, ""
            results.append({
                "name": name, "path": name, "subfolder": "", "dir": "input",
                "type": typ, "size": size, "mtime": mtime,
                "url": "/view?type=input&filename=" + _q(name),
            })
        return _web.json_response({"files": results})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ml_browse(req):
    """浏览任意目录（默认 input）：返回子目录、媒体文件、父级与可用盘符。"""
    from urllib.parse import quote as _q
    roots = _ml_roots()
    if not roots:
        return _web.json_response({"error": "no browsable root"}, status=400)
    want = (req.query.get("path") or "").strip() or _ml_media_root()
    path = _ez_inside(want, roots) or roots[0]      # 越界一律回落到第一个根，不报错
    if not os.path.isdir(path):
        path = roots[0]
    dirs, files = [], []
    try:
        for n in os.listdir(path):
            full = os.path.join(path, n)
            try:
                if os.path.isdir(full):
                    dirs.append({"name": n, "path": full})
                else:
                    typ = _media_kind(n)
                    if typ == "other":
                        continue
                    rel = os.path.relpath(full, path).replace("\\", "/")
                    try:
                        size = os.path.getsize(full); mtime = _fmt_mtime(os.path.getmtime(full))
                    except Exception:
                        size, mtime = 0, ""
                    files.append({"name": n, "path": full, "type": typ, "size": size, "mtime": mtime,
                                  "url": ""})
            except Exception:
                continue
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)
    dirs.sort(key=lambda x: (x["name"] or "").lower())
    files.sort(key=lambda x: (x["name"] or "").lower())
    up = os.path.dirname(path)
    parent = up if (up and up != path and _ez_inside(up, roots)) else ""   # 到根目录就到底，不许再往上层爬
    inside = [r for r in roots if _ez_inside(path, [r])]
    root_of = max(inside, key=len) if inside else roots[0]   # 嵌套时用最具体的根，下拉才停在用户登记的那个
    return _web.json_response({"path": path, "parent": parent, "root": root_of, "roots": roots,
                               "mine": _ml_user_roots(),
                               "name": os.path.basename(path) or path, "dirs": dirs, "files": files})


async def _ml_serve(req):
    """按路径流式返回本地文件（本地工具用途，仅只读须存在的文件）；相对路径按 input 目录解析。"""
    path = (req.query.get("path") or "").strip()
    abs_path = _ml_resolve(path)
    if not abs_path or not os.path.isfile(abs_path):
        return _web.Response(status=404, text="not found")
    try:
        return _web.FileResponse(abs_path, headers={"Cache-Control": "no-store"})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ml_open(req):
    """在系统文件管理器中打开素材文件所在目录。仅本机客户端（拉起系统程序属于本机动作）。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
        path = (data.get("path") or "").strip()
        abs_ = _ml_resolve(path)
        if not abs_ or not os.path.exists(abs_):
            return _web.json_response({"error": "file not found"}, status=404)
        folder = os.path.dirname(os.path.abspath(abs_))
        import subprocess
        import sys
        if sys.platform.startswith("win"):
            try:
                subprocess.Popen(["explorer", "/select,", os.path.abspath(abs_)])
            except Exception:
                os.startfile(folder)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", os.path.abspath(abs_)])
        else:
            subprocess.Popen(["xdg-open", folder])
        return _web.json_response({"ok": True})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ml_save_as(req):
    """把素材文件另存到用户挑选的目录（dest 由前端调 pick_folder 得到，所以同样是本机动作）。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
        path = (data.get("path") or "").strip()
        dest = (data.get("dest") or "").strip()
        abs_ = _ml_resolve(path)          # 只允许「允许目录」内的源文件
        if not abs_ or not os.path.isfile(abs_):
            return _web.json_response({"error": "file not found"}, status=404)
        if not dest or not os.path.isdir(dest):
            return _web.json_response({"error": "bad dest"}, status=400)
        import shutil
        target = os.path.join(dest, os.path.basename(abs_))
        shutil.copy2(abs_, target)
        return _web.json_response({"ok": True, "dest": target})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ml_pick_folder(req):
    """弹 Windows 原生「选择文件夹」对话框（在线程里跑，避免阻塞事件循环并保证置顶）。仅本机客户端。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)

    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            base = folder_paths.get_input_directory() if hasattr(folder_paths, "get_input_directory") else ""
            root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True); root.lift()
            path = filedialog.askdirectory(initialdir=base, title="选择另存目录")
            root.destroy()
            return path
        except Exception:
            return ""
    try:
        import asyncio
        path = await asyncio.to_thread(_pick)
        return _web.json_response({"ok": bool(path), "path": os.path.normpath(path) if path else ""})
    except Exception as e:
        return _web.json_response({"ok": False, "error": str(e)}, status=500)


async def _ml_roots_get(req):
    """当前可浏览的根目录（诊断用；远端调用也只看到根列表，不泄露目录内容）。"""
    return _web.json_response({"roots": _ml_roots(), "mine": _ml_user_roots()})


async def _ml_roots_post(req):
    """添加/移除「可浏览根目录」。只允许本机客户端 —— 否则远端能自己扩大可读范围。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    fn = _ml_roots_file()
    if not fn:
        return _web.json_response({"error": "no userdata"}, status=500)
    cur = []
    try:
        if os.path.isfile(fn):
            with open(fn, "r", encoding="utf-8") as fh:
                v = json.load(fh)
            cur = [str(x) for x in v if str(x).strip()] if isinstance(v, list) else []
    except Exception:
        cur = []
    p = _ez_real((data.get("path") or "").strip())
    if p:
        if not os.path.isdir(p):
            return _web.json_response({"error": "not a folder: " + p}, status=400)
        if os.path.dirname(p) == p:
            return _web.json_response({"error": "a drive/filesystem root cannot be a browsable root; add a subfolder instead"}, status=400)
        if p in _ml_roots():
            return _web.json_response({"ok": True, "note": "already a root", "roots": _ml_roots(), "mine": _ml_user_roots()})
        if p not in cur:
            cur.append(p)
    rm = _ez_real((data.get("remove") or "").strip())
    if rm:
        cur = [x for x in cur if _ez_real(x) != rm]
    try:
        os.makedirs(os.path.dirname(fn), exist_ok=True)
        with open(fn, "w", encoding="utf-8") as fh:
            json.dump(cur, fh, ensure_ascii=False, indent=2)
        _ML_SEED_CACHE["t"] = 0   # 根目录变了，下次重算
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)
    return _web.json_response({"ok": True, "roots": _ml_roots(), "mine": _ml_user_roots()})


try:
    PromptServer.instance.routes.get("/media_loader/files")(_ml_files)
    PromptServer.instance.routes.get("/media_loader/roots")(_ml_roots_get)
    PromptServer.instance.routes.post("/media_loader/roots")(_ml_roots_post)
    PromptServer.instance.routes.get("/media_loader/browse")(_ml_browse)
    PromptServer.instance.routes.get("/media_loader/serve")(_ml_serve)
    PromptServer.instance.routes.post("/media_loader/outputs")(_ml_outputs)
    PromptServer.instance.routes.post("/media_loader/upload")(_ml_upload)
    PromptServer.instance.routes.post("/media_loader/open")(_ml_open)
    PromptServer.instance.routes.post("/media_loader/save_as")(_ml_save_as)
    PromptServer.instance.routes.post("/media_loader/pick_folder")(_ml_pick_folder)
    PromptServer.instance.routes.post("/media_out/outputs")(_mo_outputs)
except Exception:
    pass


class MediaLoaderNode:
    """EzFlex-MediaLoader：可视化组织素材（分组→素材卡片→媒体文件），每张「素材卡片」对应一个深红输出端口。
    运行期按 ComfyUI 内置加载节点同款产出值：图像→IMAGE 张量 [1,H,W,3]、视频→VideoFromFile 对象（VIDEO，懒加载）、
    音频→{"waveform":[1,C,T],"sample_rate"}（AUDIO）、3D→File3D 对象（FILE_3D）；
    卡片内单文件=单值、多文件=批量列表（供 MediaOut 逐个拆出）。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "config": ("STRING", {
                    "multiline": True,
                    "default": "{}",
                    "tooltip": "Config JSON generated by the Media Loader panel (groups / cards / files).",
                }),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "load"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Media Loader"

    def load(self, config="{}", **kwargs):
        cards = parse_media_cards(config)
        rows = []
        for card in cards:
            items = []
            for item in (card.get("items") or []):
                loaded_item = []
                for f in (item.get("files") or []):
                    path = _ml_resolve(f.get("path") or "")
                    if not path:
                        continue
                    ftype = (f.get("type") or _media_kind(f.get("name") or f.get("path")) or "other").lower()
                    val = _ml_load_media(path, ftype)
                    loaded_item.append({
                        "id": f.get("id"), "name": f.get("name") or os.path.basename(path),
                        "type": ftype, "value": val, "path": f.get("path") or "",
                    })
                items.append({"id": item.get("id"), "files": loaded_item})
            rows.append({"group": card.get("group"), "cardId": card.get("id"),
                         "label": card.get("label"), "items": items})
        outputs = []
        labels = []
        for card in cards:
            row = next((r for r in rows if str(r["cardId"]) == str(card.get("id"))), None)
            flat = []
            if row:
                for it in row["items"]:
                    flat.extend(it["files"])
            outputs.append({"_kind": "ezflex_media_card", "cardId": card.get("id"),
                            "label": card.get("label"), "files": flat, "_rows": rows})
            labels.append(card.get("label") or "卡片")
        self.__class__.RETURN_TYPES = tuple(_MEDIA_CARD for _ in outputs)
        self.__class__.RETURN_NAMES = tuple(labels)
        return tuple(outputs)


class MediaOutNode:
    """EzFlex-MediaOut：接收 MediaLoader 的某张「素材卡片」（深红专属类型输入），把卡片内的文件输出到端口。
    模式：拆分（一个文件一个端口）/ 卡片（一个「单个卡片」一个端口）/ 卡片组 / 分组。
    多文件端口的输出是**下游能直接读的合法值**：多张图 → 批量张量 [B,H,W,C]（尺寸不一致时与内置 Batch Images 同款，
    以第一张为准等比缩放+居中裁剪，通道按最大值补齐），多段音频 → 按时间拼成一条音轨，多段文本 → 换行拼接；
    类型混用或音频采样率不一致时给出明确报错（提示改用拆分模式）。
    局部禁用某个文件时：拆分模式保留端口输出 None，卡片/卡片组/分组模式从分组里剔除。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "card": (_MEDIA_CARD, {
                    "forceInput": True,
                    "tooltip": "A media-card output from EzFlex-MediaLoader (dark red input).",
                }),
                "config": ("STRING", {
                    "multiline": True,
                    "default": "{}",
                    "tooltip": "Media Out panel config (ids of locally disabled files).",
                }),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Media Out"

    def run(self, card=None, config="{}", **kwargs):
        off = _mout_parse_off(config)
        mode = _mout_mode(config)
        rows = None
        if isinstance(card, dict):
            rows = card.get("_rows") or None
        if mode == "split":
            files = _mout_flatten(card)
            types, names, outputs = [], [], []
            for i, f in enumerate(files):
                fid = f.get("id") if isinstance(f, dict) else f"f{i}"
                name = f.get("name") if isinstance(f, dict) else f"文件 {i + 1}"
                ftype = _file_kind(f) if isinstance(f, dict) else "other"
                types.append(MEDIA_TO_COMFY.get(str(ftype).lower(), "STRING"))
                names.append(name)
                outputs.append(None if str(fid) in off else (f.get("value") if isinstance(f, dict) else f))
            self.__class__.RETURN_TYPES = tuple(types)
            self.__class__.RETURN_NAMES = tuple(names)
            return tuple(outputs)
        # card / row / group：基于整张 MediaLoader 的结构
        if not rows:
            flat = _mout_flatten(card)
            label = (card.get("label") or "素材卡片组") if isinstance(card, dict) else "素材卡片组"
            rows = [{"group": (card.get("label") or "分组") if isinstance(card, dict) else "分组",
                     "cardId": (card.get("cardId") if isinstance(card, dict) else None),
                     "label": label,
                     "items": [{"id": f.get("id") if isinstance(f, dict) else f"f{i}", "files": [f]} for i, f in enumerate(flat)]}]
        groupings = _mo_groupings(mode, off, rows)
        fit = _mout_fit(config)
        types = [g["type"] for g in groupings]
        names = [g["name"] for g in groupings]
        outputs = []
        for g in groupings:
            keep_vals = [f.get("value") if isinstance(f, dict) else f for f in g["files"]
                         if str(f.get("id") if isinstance(f, dict) else "") not in off]
            start = int(fit.get("start") or 0)
            cap = int(fit.get("cap") or 0)
            if start or cap:
                keep_vals = keep_vals[start:(start + cap) if cap else None]   # 「批量设置」里的 从第几张开始 / 最多取几张
            outputs.append(_mo_merge_values(keep_vals, g["name"], _mo_common_kind(g["files"]), fit))
        self.__class__.RETURN_TYPES = tuple(types)
        self.__class__.RETURN_NAMES = tuple(names)
        return tuple(outputs)


class PromptHelperNode:
    """EzFlex-PromptHelper：可视化编辑提示词卡片（完整富文本编辑器）。
    输入：动态「综合媒体」端口 media_in_1..16（ANY `*`，可接 图像/视频/音频/3D 模型 等任意媒体，连接后自动补空槽）+
    动态「提示词文本」端口 card_in_1..N（STRING，按顺序链接到卡片，连接后该卡片面板内容被外部文本覆盖并置灰）。
    没有 CLIP 输入：运行期自动优化（TextGenerate）用的 CLIP 在「设置·TextGenerate设置」里按模型路径 + 类型自行加载。
    输出：固定「合并提示词」+ 动态卡片输出端口 = 卡片数 1:1（均为 STRING）。
    """

    @classmethod
    def INPUT_TYPES(s):
        inputs = {
            "required": {
                "config": ("STRING", {
                    "multiline": True,
                    "default": "{}",
                    "tooltip": "Config JSON generated by the Prompt Cards panel (card list).",
                }),
            },
            "optional": {},
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
        }
        for i in range(1, _PH_MAX_MEDIA + 1):
            inputs["optional"][f"media_in_{i}"] = (_ANY, {
                "forceInput": True,
                "tooltip": f"Any media {i}: images / video / audio / 3D models are accepted (a new empty slot is added when connected).",
            })
        for i in range(1, _PH_MAX_CARDS + 1):
            inputs["optional"][f"card_in_{i}"] = ("STRING", {
                "forceInput": True,
                "tooltip": f"Text of prompt card {i} (when connected it overrides that card panel content).",
            })
        return inputs

    RETURN_TYPES = ("STRING",) * (_PH_MAX_CARDS + 1)
    RETURN_NAMES = tuple(["Merged prompt"] + [f"Card {i + 1}" for i in range(_PH_MAX_CARDS)])
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Prompt Helper"

    def _ph_optimize_runner(self, opt, tg, media):
        """运行期优化器：返回 optimize(text) —— 整体一次与单卡一次共用同一套参数/媒体。"""
        cache = {}

        def optimize(text):
            if bool(opt.get("autoTextgen")):
                if "clip" not in cache:
                    clip_path = ph_resolve_model(str(tg.get("clip_path") or _ph_global_model_path("clip_path") or "").strip(), [str(tg.get("clip_root") or "").strip()])
                    if not clip_path:
                        raise ValueError("[EzFlex-PromptHelper] runtime auto-optimize (TextGenerate) is enabled; fill in the clip model + type in the TextGenerate settings.")
                    cache["clip"] = _ph_clip_instance(clip_path, str(tg.get("clip_type") or "stable_diffusion"))
                return _ph_clip_generate(cache["clip"], text, tg, media)
            auto_method = "llama" if bool(opt.get("autoLlama")) else "api"
            payload = {
                "method": auto_method, "prompt": text,
                "provider": opt.get("provider") or "", "model": opt.get("model") or "",
                "apiUrl": opt.get("apiUrl") or "", "apiKey": opt.get("apiKey") or "",
                "proxy": opt.get("proxy") or "",
                "images": _ph_images_to_dataurls(_ph_vision_tensors(media)),
                "llama": opt.get("llama") or {}, "textgen": opt.get("textgen") or {},
                "apiParams": opt.get("apiParams") or {},
            }
            try:
                return _ph_optimize_impl(payload)
            except Exception as e:
                # 别只 print 到控制台：优化结果就是输出，静默失败会变成"悄悄输出空提示词"（用户看不到原因）
                print(f"[PromptHelper] {auto_method} 运行期优化失败: {e}")
                hint = " (llama: increase n_ctx in the llama settings, or use the API)" if auto_method == "llama" else ""
                raise ValueError(f"[EzFlex-PromptHelper] runtime auto-optimize ({auto_method}) failed: {e}{hint}") from e

        return optimize

    def run(self, config="{}", unique_id=None, extra_pnginfo=None, **kwargs):
        cards = parse_prompt_cards(config)
        count = len(cards)
        opt = parse_prompt_optimize(config)
        tg = opt.get("textgen") or {}
        sep = parse_prompt_rules(config)["mergeSep"]
        overall = parse_prompt_overall(config)

        # 三个开关前端就是互斥的（开一个自动关另外两个），配置里出现多个只可能是手改坏了 —— 直接报错，
        # 不做静默优先级兜底。
        auto_flags = [k for k in ("autoTextgen", "autoApi", "autoLlama") if opt.get(k)]
        if len(auto_flags) > 1:
            raise ValueError("[EzFlex-PromptHelper] multiple runtime auto-optimize methods are enabled (" + " / ".join(auto_flags) + "); keep only one.")
        auto_used = bool(auto_flags)

        # 每张卡的「默认」正文（外部 card_in_N 覆盖该卡）；「合=绿」卡片的默认合并 = 总体层说的那份「默认」
        defaults = []
        for i in range(count):
            raw = kwargs.get(f"card_in_{i + 1}")
            if raw is not None and str(raw).strip() != "":
                defaults.append(str(raw))   # 已连接的外部文本输入：覆盖该卡
            else:
                defaults.append(cards[i].get("content") or _ph_html_to_text(cards[i].get("contentHTML")) or "")
        _in_merge = [i for i in range(count) if not (isinstance(cards[i], dict) and cards[i].get("mergeOff"))]
        default_src = sep.join(defaults[i] for i in _in_merge if defaults[i].strip())
        default_merged = sep.join(_ph_compile_card(defaults[i], cards[i]) for i in _in_merge if defaults[i].strip())

        optimize = self._ph_optimize_runner(opt, tg, _ph_gather_media(kwargs)) if auto_used else None

        # ── 总体层（合并提示词）──
        # 槽里存/回传的都是**模型原文**（未编译，这样换规范还能重编）；只有真正输出时才过一遍规范编译。
        # 编译是幂等的：模板本身就是 @图片{n} 的规范再编一次结果不变，模板是 <Picture {n}> 的第二次没东西可编。
        rule_card = cards[0] if cards else {}
        opt_text = ""            # 本轮新算出来的整体优化（要回传前端写进「整体优化结果」）
        overall_used = False     # 输出用的是整体优化 → 让前端把总编辑滑块切到「优化」
        has_opt = bool(str(overall.get("text") or "").strip())
        if auto_used:
            if has_opt:
                if overall.get("useOptimized") or not default_src.strip():
                    merged, overall_used = _ph_compile_card(overall["text"], rule_card), True
                else:
                    merged = default_merged
            elif default_src.strip():
                opt_text = optimize(default_src)
                merged, overall_used = _ph_compile_card(opt_text, rule_card), True
            else:
                merged = ""      # 用户自己没写
        else:
            # 三个开关全关：同一套槽位规则，只是不做任何优化调用 ——
            # 总编辑滑块=默认 → 默认合并（合=灰不并）；=优化 → 整体优化内容（空就空，不回落）
            if overall.get("useOptimized"):
                merged = _ph_compile_card(overall["text"], rule_card)
                overall_used = True
            else:
                merged = default_merged

        # ── 各卡片端口 ──
        # 合=绿（进合并）：运行期不单独优化，严格按该卡滑块输出（滑块指到空槽就输出空）
        # 合=灰（不进合并）：按需单独优化一次；两个槽都空才输出空
        ports = []
        card_updates = []
        for i in range(count):
            card = cards[i]
            raw = kwargs.get(f"card_in_{i + 1}")
            if raw is not None and str(raw).strip() != "":
                ports.append(str(raw)); continue
            d = defaults[i]
            o = str(card.get("contentOptimized") or "")
            in_merge = not card.get("mergeOff")
            if auto_used and not in_merge:
                if not d.strip() and not o.strip():
                    ports.append("")
                elif not d.strip():
                    ports.append(o)
                    card_updates.append({"id": card.get("id"), "useOptimized": True})
                elif not o.strip():
                    new_text = optimize(d)
                    ports.append(new_text)
                    card_updates.append({"id": card.get("id"), "contentOptimized": new_text, "useOptimized": True})
                else:
                    ports.append(o if card.get("useOptimized") else d)
            else:
                # 合=绿（或不走自动优化）：严格按该卡滑块输出，滑块指到空槽就输出空（空就空）
                ports.append(o if card.get("useOptimized") else d)

        # 按卡片自己的规范编译（只编引用媒体）；编译结果就是各卡片的输出端口
        compiled = [_ph_compile_card(ports[i], cards[i]) for i in range(count)]

        if bool(opt.get("clearCache")):
            ph_clear_model_cache()

        return {
            # ⚠️ ComfyUI 的 ui 契约：每个键的值必须是**列表** —— execution.py 会按
            # `[y for x in uis for y in x[k]]` 把多个 ui dict 合并成列表；标量会当场炸
            # （bool → TypeError: 'bool' object is not iterable），字符串则被拆成一个个字符。
            # 前端 onExecuted 收到的是「值列表」，所以那边读的时候要取 [0]。
            "ui": {
                # 本轮新算出来的整体优化内容（前端写进「整体优化结果」；空 = 这轮没优化）
                "optimized": [opt_text],
                # 输出用的是整体优化 → 前端把总编辑滑块切到「优化」
                "useOverallOptimized": [overall_used],
                # 运行期动过的卡片：[{id, contentOptimized?, useOptimized?}]
                "cardUpdates": [card_updates],
            },
            "result": tuple([merged] + compiled),
        }


NODE_CLASS_MAPPINGS = {
    "EzFlex-MainControl": MainControlNode,
    "EzFlex-ModelsCombo": ModelsComboLoader,
    "EzFlex-FreeLatent": FreeLatentNode,
    "EzFlex-NodeSwitchMaster": NodeSwitchMasterNode,
    "EzFlex-NodeSwitchGroup": NodeSwitchGroupNode,
    "EzFlex-ParamPresetControl": ParamPresetControlNode,
    "EzFlex-ParamPresetOutput": ParamPresetOutputNode,
    "EzFlex-PreviewAny": PreviewAnyNode,
    "EzFlex-PromptHelper": PromptHelperNode,
    "EzFlex-MediaLoader": MediaLoaderNode,
    "EzFlex-MediaOut": MediaOutNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "EzFlex-MainControl": "EzFlex-MainControl",
    "EzFlex-ModelsCombo": "EzFlex-ModelsCombo",
    "EzFlex-FreeLatent": "EzFlex-FreeLatent",
    "EzFlex-NodeSwitchMaster": "EzFlex-NodeSwitchMaster",
    "EzFlex-NodeSwitchGroup": "EzFlex-NodeSwitchGroup",
    "EzFlex-ParamPresetControl": "EzFlex-ParamPresetControl",
    "EzFlex-ParamPresetOutput": "EzFlex-ParamPresetOutput",
    "EzFlex-PreviewAny": "EzFlex-PreviewAny",
    "EzFlex-PromptHelper": "EzFlex-PromptHelper",
    "EzFlex-MediaLoader": "EzFlex-MediaLoader",
    "EzFlex-MediaOut": "EzFlex-MediaOut",
}
