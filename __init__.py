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
import json
import os
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

from comfy_api.latest import io

__version__ = "1.0.1"

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
    for _fname in ("modelscombo.html", "modelscombo.js", "modelscombo_node.js", "freelatent_node.js",
                   "ezflex_service.js", "node_switch_group.js", "node_switch_master.js",
                   "main_control.js", "param_preset_control.js", "param_preset_output.js",
                   "preview_any.js"):
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
    return {
        "type": type_,
        "file": rel,
        "file_name": meta.get("file_name"),
        "model_name": meta.get("model_name"),
        "base_model": meta.get("base_model"),
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
            raise ValueError(f"config 不是合法的 JSON：{e}") from e
    else:
        data = config
    if isinstance(data, dict):
        data = data.get("loaders", [])
    if not isinstance(data, list):
        raise ValueError("config 必须是加载器数组，或包含 loaders 数组的对象")

    loaders = []
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        ltype = item.get("type")
        if ltype not in LOADER_FOLDERS:
            raise ValueError(f"未知加载器类型：{ltype!r}（可选：{', '.join(LOADER_FOLDERS)}）")
        extra = item.get("extra") or {}
        if not isinstance(extra, dict):
            raise ValueError(f"加载器 {ltype!r} 的 extra 必须是对象")
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
        raise ValueError(f"不支持的 device：{device!r}（可选：{', '.join(DEVICES)}）")
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
        raise ValueError(f"不支持的 weight_dtype：{weight_dtype!r}（可选：{', '.join(allowed)}）")
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
        raise ValueError(f"不支持的 CLIP type：{clip_type_name!r}（可选：{', '.join(CLIP_TYPES)}）")
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
        raise ValueError(f"不支持的 device：{device!r}（可选：{', '.join(DEVICES)}）")
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
                    "tooltip": "从「模型组合配置器」页面复制的 JSON 配置（加载器数组）。",
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
    DESCRIPTION = "按「模型组合配置器」页面的 JSON 配置加载多个 Checkpoint/UNET/CLIP/VAE 并叠加 LoRA，输出对应端口。"

    def load_combo(self, config, **kwargs):
        loaders = parse_config(config)
        mains = [l for l in loaders if l["type"] != "lora"]
        loras = [l for l in loaders if l["type"] == "lora"]

        model_count = sum(1 for l in mains if l["type"] in ("checkpoint", "unet"))
        clip_count = sum(1 for l in mains if l["type"] in ("checkpoint", "clip"))
        vae_count = sum(1 for l in mains if l["type"] in ("checkpoint", "vae"))
        if max(model_count, clip_count, vae_count) > MAX_PORTS_PER_TYPE:
            raise ValueError(
                f"端口数超出上限：每种类型最多 {MAX_PORTS_PER_TYPE} 个 "
                f"（当前 models={model_count}, clips={clip_count}, vaes={vae_count}），请拆分配置。"
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

    # latent 下采样因子为 8：把像素尺寸对齐到 8 的倍数，并保证最小下限
    def mult8(v, lo=64):
        return max(lo, int(round(v / 8) * 8))

    return mult8(w), mult8(h), max(1, b)


class FreeLatentNode(io.ComfyNode):
    """V3 节点：output 为 Latent/Width/Height/Batch；width/height/batch_size 用 force_input 保证是
    可连接 socket（不再走 widget→socket 转换 hack，避免 socket 圆点悬停漂移），未连接时用面板 config 值。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="EzFlex-FreeLatent",
            display_name="EzFlex-FreeLatent",
            category="EzFlex",
            description="按「分辨率选择器」可视化面板配置创建一个空 Latent：自由拖拽尺寸 / 比例 / MP 算法，方块映射到 (b,4,h,w)。宽高/批次接入外部 INT socket 时优先使用外部值。",
            inputs=[
                io.String.Input("config", socketless=True, default="{}",
                                tooltip="「分辨率选择器」面板生成的配置 JSON（宽度/高度/批次/算法/比例等）。"),
                io.Int.Input("width", display_name="Width", optional=True, default=0,
                             min=0, max=32768, step=8, force_input=True,
                             tooltip="外部宽度：>0 时覆盖面板宽高（不填/为 0 时用面板值）。"),
                io.Int.Input("height", display_name="Height", optional=True, default=0,
                             min=0, max=32768, step=8, force_input=True,
                             tooltip="外部高度：>0 时覆盖面板宽高（不填/为 0 时用面板值）。"),
                io.Int.Input("batch_size", display_name="Batch", optional=True, default=0,
                             min=0, max=4096, force_input=True,
                             tooltip="外部批次：>0 时覆盖面板批次（不填/为 0 时用面板值）。"),
            ],
            outputs=[
                io.Latent.Output("Latent", tooltip="空 latent (batch,4,height/8,width/8)"),
                io.Int.Output("Width", tooltip="像素宽度"),
                io.Int.Output("Height", tooltip="像素高度"),
                io.Int.Output("Batch", tooltip="批次数量"),
            ],
        )

    @classmethod
    def execute(cls, config="{}", width=0, height=0, batch_size=0):
        w, h, batch = parse_freelatent_config(config)
        if width and width > 0:
            w = width
        if height and height > 0:
            h = height
        if batch_size and batch_size > 0:
            batch = batch_size
        # latent 下采样因子为 8：外部接入值也对齐到 8 的倍数，保证 latent 尺寸与报告值一致
        def mult8(v, lo=64):
            return max(lo, int(round(v / 8) * 8))
        w, h = mult8(w), mult8(h)
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
            "「分组预设」面板生成的配置 JSON（开关列表/匹配规则/当前预设）。",
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-NodeSwitchGroup：一组开关，每个开关按 ComfyUI 分组 颜色/标题正则 匹配目标节点，一键设 ALWAYS/NEVER/BYPASS mode。控制由前端生效，本节点承载 config 状态。"

    def run(self, config="{}", **kwargs):
        return ()


class NodeSwitchMasterNode:
    """节点控制总预设：总预设 = {NodeSwitchGroup 节点 id -> 该分组预设名} 的映射。
    行（目标分组节点）由前端从画布发现；应用时前端把映射写进各分组节点的 config.current 并触发其应用。"""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "「节点控制总预设」面板生成的配置 JSON（当前总预设名）。",
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-NodeSwitchMaster：把每个 EzFlex-NodeSwitchGroup 实例映射到其某个分组预设；切换/应用总预设时级联写入分组节点并应用开关。"

    def run(self, config="{}", **kwargs):
        return ()


class MainControlNode:
    """总控制节点：总预设 = {目标节点 id -> 该节点预设名} 的映射，目标是画布上的
    EzFlex-NodeSwitchMaster / EzFlex-ParamPresetControl / EzFlex-ModelsCombo / EzFlex-FreeLatent
    实例。应用时级联下推。"""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "「总控制」面板生成的配置 JSON（当前总预设名）。",
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-MainControl：把画布上的 EzFlex-NodeSwitchMaster / EzFlex-ParamPresetControl / EzFlex-ModelsCombo / EzFlex-FreeLatent 实例映射到其预设，一键级联应用（写目标 config.current 并触发其应用逻辑）。"

    def run(self, config="{}", **kwargs):
        return ()


class ParamPresetControlNode:
    """参数预设控制：前端面板管理参数组（组/参数可拖拽排序），动态输出端口与参数组卡片一一对应
    （一个分组一个 EZFLEX_PARAM_GROUP 端口，携带该组参数数据）。分组增删/排序后由前端 POST
    /param_preset_control/outputs 同步类 RETURN_TYPES/RETURN_NAMES（校验用），execute 再按实际数据设置。"""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "「参数预设控制」面板生成的配置 JSON（参数组列表 + 当前预设名）。",
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-ParamPresetControl：可视化编辑参数组（每组含参数名/类型/值/启用），动态输出端口与分组一一对应，拖拽排序后端口跟随（同 ModelsCombo 机制）。"

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
                    "tooltip": "来自 EzFlex-ParamPresetControl 的某个参数组端口。",
                }),
                "config": ("STRING", {
                    "multiline": True,
                    "default": "{}",
                    "tooltip": "「参数预设输出」面板生成的配置 JSON（局部启用/禁用参数 id 集合）。",
                }),
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-ParamPresetOutput：固定的整组数据红色输出 + 按参数类型逐个输出激活参数，下拉切换时复用 socket 保持接线。"

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
                    "tooltip": "「任意预览」配置（是否存档 + 存档相对目录）。",
                }),
            },
            "optional": {},
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
        }
        for i in range(1, _PREVIEW_MAX + 1):
            inputs["optional"][f"input_{i}"] = (_ANY, {"forceInput": True, "tooltip": f"任意输入 {i}。"})
        return inputs

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    OUTPUT_NODE = True
    FUNCTION = "preview"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-PreviewAny：白板放置多个可拖拽排序的预览卡片，接收任意输入并自动解析，按类型显示/预览；可存档到 ComfyUI 输出目录。每卡一个字符串输出。"

    def preview(self, config="{}", unique_id=None, extra_pnginfo=None, **kwargs):
        cfg = self._parse_config(config)
        connected = self._connected_inputs(unique_id, extra_pnginfo)
        wf_meta = PreviewAnyNode._workflow_gen_meta((extra_pnginfo or {}).get("workflow", {}))
        entries, outputs = [], []
        for i, (name, label, upstream) in enumerate(connected):
            entry = self._entry(label or f"输入 {i + 1}", kwargs.get(name), upstream, wf_meta)
            entry = self._maybe_save(entry, cfg, label or f"card_{i + 1}")
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
                if not isinstance(value, (dict, list, tuple)) and hasattr(value, "get_stream_source"):
                    # 文件型视频（VideoFromFile）：挂源文件 URL + 解首帧封面 + 元数据，不整段解码（避免卡）
                    src = value.get_stream_source() if hasattr(value, "get_stream_source") else None
                    if isinstance(src, str) and src and os.path.exists(src):
                        from urllib.parse import quote
                        entry["video_src"] = "/preview_any/serve_video?path=" + quote(os.path.abspath(src))
                        poster, vfps, dims = self._video_file_poster(src)
                        if poster:
                            entry["preview"] = poster
                        entry["fps"] = vfps
                        entry["value"] = self._video_file_summary(vfps, dims)
                        gm = self._file_gen_meta(src)
                        if gm:
                            entry["gen_meta"] = json.dumps(gm, ensure_ascii=False, default=str)
                    else:
                        # BytesIO/无路径：读帧编码（图片序列）
                        nps, vfps = self._video_from_file_np(value)
                        if nps:
                            entry["preview"] = self._image_np_to_base64(nps[0])
                            entry["frames"] = len(nps)
                            entry["fps"] = vfps
                            entry["value"] = self._video_np_summary(nps, vfps)
                            wm = self._video_to_webm_np(nps, vfps)
                            if wm:
                                entry["video"] = wm
                        else:
                            entry["value"] = "视频"
                else:
                    first, count = self._video_first_frame(value)
                    entry["preview"] = first
                    entry["frames"] = count
                    frames, fps = self._video_frames(value)
                    entry["fps"] = fps
                    entry["value"] = self._video_summary(frames, fps)
                    webm = self._video_to_webm(frames, fps)
                    if webm:
                        entry["video"] = webm
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
            elif type_name == "MODEL_3D":
                entry["value"] = self._object_3d_summary(value)
                url = self._export_3d_url(value)
                if url:
                    entry["model3d"] = url
                p3d = getattr(value, "path", None) or getattr(value, "file", None)
                if isinstance(p3d, str) and os.path.isfile(p3d):
                    gm = self._file_gen_meta(p3d)
                    if gm:
                        entry["gen_meta"] = json.dumps(gm, ensure_ascii=False, default=str)
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
            if value and isinstance(value[0], (list, tuple)) and isinstance(value[0][0], dict):
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
        mod = type(value).__module__ or ""
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
        """从 dict/list/VideoFromFile 对象提取 (帧列表, fps)，最多 30 帧。"""
        frames = []
        fps = 8
        try:
            if isinstance(value, dict):
                f = value.get("frames") or value.get("images") or []
                if isinstance(f, (list, tuple)):
                    frames = [x for x in f if isinstance(x, torch.Tensor)]
                fps = value.get("fps", fps) or fps
            elif isinstance(value, (list, tuple)):
                frames = [x for x in value if isinstance(x, torch.Tensor)]
                if len(frames) == 1 and frames[0].ndim == 4:
                    frames = [frames[0][i] for i in range(min(frames[0].shape[0], 30))]
            else:
                # VideoFromFile 之类的对象：试常见属性/可迭代/to_images
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
        """用 av 把帧序列编码成 WebM(data URI)，缺失 av/编码器时返回 None。"""
        if not frames or not isinstance(frames[0], torch.Tensor):
            return None
        try:
            import av
            from io import BytesIO
            buf = BytesIO()
            rate = max(1, int(fps) if fps else 8)
            container = av.open(buf, mode="w", format="webm")
            stream = container.add_stream("libvpx-vp9", rate=rate)
            stream.pix_fmt = "yuv420p"
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
                if stream.width is None:
                    stream.width = np_img.shape[1]
                    stream.height = np_img.shape[0]
                avf = av.VideoFrame.from_ndarray(np_img, format="rgb24")
                for p in stream.encode(avf):
                    container.mux(p)
            for p in stream.encode():
                container.mux(p)
            container.close()
            return "data:video/webm;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            return None

    @staticmethod
    def _video_from_file_np(value):
        """文件型视频对象（VideoFromFile）：用 av 读全部帧（完整视频），返回 (numpy RGB 帧列表, fps)。"""
        try:
            src = value.get_stream_source() if hasattr(value, "get_stream_source") else None
            if src is None:
                return None, 8
            import av
            frames = []
            fps = 8
            with av.open(src, mode="r") as container:
                video = next((s for s in container.streams if s.type == "video"), None)
                if video is None:
                    return None, 8
                if video.average_rate:
                    fps = float(video.average_rate)
                for frame in container.decode(video):
                    frames.append(frame.to_ndarray(format="rgb24"))
            return frames, fps
        except Exception:
            return None, 8

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
            path = getattr(value, "path", None) or ""
            name = os.path.basename(str(path)) if path else ""
            if fmt:
                return f"3D 模型 ({fmt})" + (f": {name}" if name else "")
            return f"3D 模型 ({type(value).__name__})" + (f": {name}" if name else "")
        except Exception:
            return f"3D 模型 ({type(value).__name__})"

    @staticmethod
    def _export_3d_url(value):
        """返回 3D 模型可访问 URL。优先用 path-based URL（/preview_any/fs/<abs>）以便外部贴图/缓冲的相对路径正确解析，否则 save_to 导出。"""
        try:
            path = getattr(value, "path", None) or getattr(value, "file", None)
            if isinstance(path, str) and path and os.path.isfile(path):
                from urllib.parse import quote
                abs_p = os.path.abspath(path).replace("\\", "/")
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

    def _maybe_save(self, entry, cfg, name):
        """存档开启时把卡片内容写到 <output>/<savePath>/，并回填 saved_path。"""
        if not cfg.get("save"):
            return entry
        data = None
        ext = None
        sf = cfg.get("saveFormats") or {}
        if entry.get("preview"):
            try:
                raw = base64.b64decode(entry["preview"])
                img_cfg = sf.get("image")
                fmt = "png"; quality = 95
                if isinstance(img_cfg, dict):
                    fmt = img_cfg.get("fmt", "png") or "png"
                    try: quality = int(img_cfg.get("quality", 95))
                    except Exception: quality = 95
                if fmt == "png":
                    data = raw; ext = ".png"
                else:
                    from io import BytesIO
                    from PIL import Image as _Im
                    img = _Im.open(BytesIO(raw))
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
                if entry.get("audio_src"):
                    from urllib.parse import urlparse, parse_qs
                    p = (parse_qs(urlparse(entry["audio_src"]).query).get("path") or [None])[0]
                    if p and os.path.exists(p):
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
    full = os.path.normpath(os.path.join(base, rel))
    if not full.startswith(os.path.normpath(base)):
        full = base
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
    """弹 Windows 原生“选择文件夹”对话框，默认 ComfyUI 输出目录。"""
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
    """流式返回本地视频文件（带 Range 支持，可拖动进度/有声）。仅限本地路径。"""
    path = req.query.get("path", "").strip()
    if not path or not os.path.isfile(path):
        return _web.json_response({"error": "not found"}, status=404)
    return _web.FileResponse(os.path.abspath(path))


async def _preview_any_static(req):
    """serve 插件 web/ 目录（供前端本地导入 three.js 与加载器），仅白名单相对路径。"""
    rel = req.match_info.get("path", "")
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "web"))
    full = os.path.abspath(os.path.join(root, rel))
    if not full.startswith(root) or not os.path.isfile(full):
        return _web.json_response({"error": "not found"}, status=404)
    return _web.FileResponse(full)


async def _preview_any_fs(req):
    """按绝对路径 serve 文件（用于 3D 模型及其外部贴图/缓冲，使相对路径能正确解析）。仅本地路径。"""
    from urllib.parse import unquote
    rel = req.match_info.get("path", "")
    full = os.path.abspath(unquote(rel))
    if os.path.isfile(full):
        return _web.FileResponse(full)
    # 兜底：贴图/缓冲常在模型同目录的子文件夹（Textures/Materials），按 basename 在父目录递归找
    try:
        base = os.path.basename(full)
        base_dir = os.path.dirname(full)
        if base and base_dir and os.path.isdir(base_dir):
            for root, _dirs, files in os.walk(base_dir):
                if base in files:
                    return _web.FileResponse(os.path.join(root, base))
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


NODE_CLASS_MAPPINGS = {
    "EzFlex-MainControl": MainControlNode,
    "EzFlex-ModelsCombo": ModelsComboLoader,
    "EzFlex-FreeLatent": FreeLatentNode,
    "EzFlex-NodeSwitchMaster": NodeSwitchMasterNode,
    "EzFlex-NodeSwitchGroup": NodeSwitchGroupNode,
    "EzFlex-ParamPresetControl": ParamPresetControlNode,
    "EzFlex-ParamPresetOutput": ParamPresetOutputNode,
    "EzFlex-PreviewAny": PreviewAnyNode,
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
}
