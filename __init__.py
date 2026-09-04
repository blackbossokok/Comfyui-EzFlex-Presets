"""EzFlex 鎻掍欢濂椾欢锛氭ā鍨?鍒嗚鲸鐜?鎺у埗/鍙傛暟棰勮鑺傜偣

- EzFlex-ModelsCombo          妯″瀷缁勫悎鍔犺浇鍣紙checkpoint/unet/clip/vae + lora 涓茶仈锛?
- EzFlex-FreeLatent           鍒嗚鲸鐜?Latent 閫夋嫨鍣紙鎷栨嫿鐢诲竷 + 棰勮锛?
- EzFlex-NodeSwitchGroup      鍒嗙粍棰勮锛氫竴缁勫紑鍏筹紝鎸夌敾甯冨垎缁?棰滆壊/鏍囬姝ｅ垯 鍖归厤骞惰鑺傜偣 mode
- EzFlex-NodeSwitchMaster     鑺傜偣鎺у埗鎬婚璁撅細鎶婃瘡涓?NodeSwitchGroup 瀹炰緥鏄犲皠鍒版煇鍒嗙粍棰勮
- EzFlex-MainControl          鎬绘帶鍒惰妭鐐癸細鎶?NodeSwitchMaster / ParamPresetControl 瀹炰緥鏄犲皠鍒板叾棰勮
- EzFlex-ParamPresetControl   鍙傛暟棰勮鎺у埗锛氬垎缁勫崱鐗囬┍鍔紝鍔ㄦ€佽緭鍑虹鍙?= 鍒嗙粍鏁?1:1
- EzFlex-ParamPresetOutput    鍙傛暟棰勮杈撳嚭锛氳繛鎺ユ煇鍒嗙粍绔彛锛屽姩鎬佽緭鍑虹鍙?= 鍙傛暟鏁?1:1锛堟寜绫诲瀷鏄犲皠锛?
- EzFlex-PreviewAny           浠绘剰棰勮锛氱櫧鏉挎斁缃涓彲鎷栨嫿鎺掑簭棰勮鍗＄墖锛屾瘡鍗′竴涓换鎰忚緭鍏?+ 涓€涓瓧绗︿覆杈撳嚭

鎺у埗绫昏妭鐐癸紙NodeSwitchGroup/Master/MainControl锛夋槸绾墠绔敓鏁堢殑閰嶇疆瀹瑰櫒锛堝弬鑰?rgthree
Fast Groups Muter/Bypasser锛歯ode.mode 0/2/4 鐢辨祻瑙堝櫒绔缃級锛孭ython 鍙壙杞介殣钘?config銆?
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

__version__ = "1.0.2"

WEB_DIRECTORY = "./web"

# 缁?web 鐩綍閲岀殑椤甸潰/鑴氭湰璁剧疆 no-store锛屾潨缁?Comfy-Desktop / 娴忚鍣ㄦ妸瀹冧滑缂撳瓨鎴愭棫鐗堛€?
# 鍦ㄨ嚜瀹氫箟鑺傜偣鍔犺浇闃舵娉ㄥ唽璺敱锛屾棭浜?server.py 娣诲姞 /extensions 闈欐€佽矾鐢憋紝鍥犳浼樺厛鐢熸晥銆?
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

# 涓庡唴缃?CLIPLoader 鐨?type 閫夐」淇濇寔涓€鑷?
CLIP_TYPES = [
    "stable_diffusion", "stable_cascade", "sd3", "stable_audio", "mochi", "ltxv",
    "pixart", "cosmos", "lumina2", "wan", "hidream", "chroma", "ace", "omnigen2",
    "qwen_image", "hunyuan_image", "flux2", "ovis", "longcat_image", "cogvideox",
    "lens", "pixeldit", "ideogram4", "boogu", "krea2", "joyimage", "mage", "minimax",
]

# 椤甸潰 device 涓嬫媺鎻愪緵鐨勯€夐」
DEVICES = ("default", "cpu", "cuda", "cuda:0", "cuda:1")

# VAE 鍙帴鍙楄繖浜?dtype锛坒p8 涓嶉€傜敤锛?
VAE_DTYPES = ("default", "fp16", "bf16", "fp32")

# 鎮仠棰勮锛氭寜銆屾ā鍨嬫枃浠跺悓鍚嶃€嶇殑鍥剧墖/瑙嗛杩斿洖锛屼緵鍓嶇 hover 灞曠ず
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

# ===== LoraManager 鍏冩暟鎹祻瑙堬紙ModelsCombo銆屾祻瑙堛€嶅脊绐楋級=====
# 璇诲彇 LoraManager 鍦ㄦā鍨嬬洰褰曠敓鎴愮殑 <妯″瀷鍚?.metadata.json锛堜互鍙婂悓鐩綍棰勮鍥撅級锛?
# 杩斿洖缁欏墠绔仛銆屾壒閲忔坊鍔犲姞杞藉櫒銆嶇殑妯″瀷娴忚鍣ㄣ€傚彧鍒楄兘鏄犲皠鎴愮粍鍚堝姞杞藉櫒绫诲瀷鐨勭洰褰曘€?
_META_LOADER_FOLDERS = {
    "checkpoint": "checkpoints",
    "unet": "diffusion_models",
    "lora": "loras",
}


def _meta_relative_file(folder, meta, meta_path):
    """鎶?LoraManager 鍏冩暟鎹搴旂殑妯″瀷鏂囦欢锛屾崲绠楁垚 ComfyUI /models/<folder> 鐨勭浉瀵硅矾寰勩€?""
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
    # 鍏滃簳锛氭寜 metadata 鏂囦欢浣嶇疆鎺ㄧ畻锛堟ā鍨嬫枃浠朵笌鍏冩暟鎹悓 basename锛屽彧宸悗缂€锛?
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

# ===== 棰勮瀛樺偍锛氭彃浠剁洰褰?user_data锛堟瘡涓妭鐐逛竴涓瓨妗ｆ枃浠讹紝瀛樿鑺傜偣鍏ㄩ儴棰勮锛?====
# 鏂囦欢鍙兘琚紪杈戝櫒鍔犱笂 UTF-8 BOM锛岃鍙栫敤 utf-8-sig 鍏煎锛堝惁鍒?json.load 鎶?BOM 閿欙紝琚?except 鍚炴垚 []锛夈€?
_USER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user_data")
try:
    os.makedirs(_USER_DIR, exist_ok=True)
except Exception:
    pass


def _preset_file(node_name):
    return os.path.join(_USER_DIR, node_name + ".json")


def _read_doc(node_name):
    """璇诲彇瀛樻。锛岃繑鍥?(doc_dict, presets_list)銆傚吋瀹逛袱绉嶅舰鐘讹細
    绾垪琛紙ModelsCombo 鏃ф牸寮忥級鈫?鍖呰鎴?{'presets': list}锛涘璞?鈫?鍙?presets 閿€?""
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
    # 浠呭綋杩樻湁棰濆閿紙濡?customRatios锛夋椂鍐欏璞★紝鍚﹀垯缁存寔绾垪琛紙ModelsCombo 鏃ф牸寮忎笉鍙橈級
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


# 鍚屼竴濂楅璁捐矾鐢辨寜 node_name 鍙傛暟鍖栵細GET 鍒楄〃 / POST 淇濆瓨 / DELETE {name}銆?
# 淇濆瓨鏃朵繚鐣欏鎴风闄?name 澶栫殑鍏ㄩ儴瀛楁锛坢odelscombo 瀛?loaders锛宖reelatent 瀛?config锛夈€?
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


# ComfyUI 鏍￠獙鑺傜偣杈撳嚭绫诲瀷鏃惰鐨勬槸銆岀被 RETURN_TYPES銆嶏紙execution.py validate锛夛紝
# 鑰?ModelsCombo 鐨勮緭鍑洪殢 config 鍙樺寲锛岃繍琛屾湡 load_combo 鏀圭被灞炴€ц刀涓嶄笂鏍￠獙銆?
# 鍥犳鍓嶇鍦ㄦ瘡娆¤緭鍑虹粨鏋勫彉鍖栨椂 POST 鍒拌繖閲岋紝鎶婄被 RETURN_TYPES/RETURN_NAMES 鍚屾鎴愬綋鍓嶆帓鍒楋紝
# 杩欐牱鏍￠獙锛圴AE鈫扸AE 瑙ｇ爜銆丆LIP鈫扖LIP 鏂囨湰缂栫爜銆丮ODEL鈫掗噰鏍峰櫒锛夌被鍨嬫墠瀵瑰緱涓娿€?
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
            raise ValueError(f"config 涓嶆槸鍚堟硶鐨?JSON锛歿e}") from e
    else:
        data = config
    if isinstance(data, dict):
        data = data.get("loaders", [])
    if not isinstance(data, list):
        raise ValueError("config 蹇呴』鏄姞杞藉櫒鏁扮粍锛屾垨鍖呭惈 loaders 鏁扮粍鐨勫璞?)

    loaders = []
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        ltype = item.get("type")
        if ltype not in LOADER_FOLDERS:
            raise ValueError(f"鏈煡鍔犺浇鍣ㄧ被鍨嬶細{ltype!r}锛堝彲閫夛細{', '.join(LOADER_FOLDERS)}锛?)
        extra = item.get("extra") or {}
        if not isinstance(extra, dict):
            raise ValueError(f"鍔犺浇鍣?{ltype!r} 鐨?extra 蹇呴』鏄璞?)
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
        raise ValueError(f"涓嶆敮鎸佺殑 device锛歿device!r}锛堝彲閫夛細{', '.join(DEVICES)}锛?)
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
        raise ValueError(f"涓嶆敮鎸佺殑 weight_dtype锛歿weight_dtype!r}锛堝彲閫夛細{', '.join(allowed)}锛?)
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
        raise ValueError(f"涓嶆敮鎸佺殑 CLIP type锛歿clip_type_name!r}锛堝彲閫夛細{', '.join(CLIP_TYPES)}锛?)
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
        raise ValueError(f"涓嶆敮鎸佺殑 device锛歿device!r}锛堝彲閫夛細{', '.join(DEVICES)}锛?)
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
                    "tooltip": "浠庛€屾ā鍨嬬粍鍚堥厤缃櫒銆嶉〉闈㈠鍒剁殑 JSON 閰嶇疆锛堝姞杞藉櫒鏁扮粍锛夈€?,
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
    DESCRIPTION = "鎸夈€屾ā鍨嬬粍鍚堥厤缃櫒銆嶉〉闈㈢殑 JSON 閰嶇疆鍔犺浇澶氫釜 Checkpoint/UNET/CLIP/VAE 骞跺彔鍔?LoRA锛岃緭鍑哄搴旂鍙ｃ€?

    def load_combo(self, config, **kwargs):
        loaders = parse_config(config)
        mains = [l for l in loaders if l["type"] != "lora"]
        loras = [l for l in loaders if l["type"] == "lora"]

        model_count = sum(1 for l in mains if l["type"] in ("checkpoint", "unet"))
        clip_count = sum(1 for l in mains if l["type"] in ("checkpoint", "clip"))
        vae_count = sum(1 for l in mains if l["type"] in ("checkpoint", "vae"))
        if max(model_count, clip_count, vae_count) > MAX_PORTS_PER_TYPE:
            raise ValueError(
                f"绔彛鏁拌秴鍑轰笂闄愶細姣忕绫诲瀷鏈€澶?{MAX_PORTS_PER_TYPE} 涓?"
                f"锛堝綋鍓?models={model_count}, clips={clip_count}, vaes={vae_count}锛夛紝璇锋媶鍒嗛厤缃€?
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

        # 澶?LoRA 涓茶仈锛氭寜搴忓彿锛坕d锛夐『搴忎緷娆℃墦琛ヤ竵锛屽悗涓€涓湪鍓嶄竴涓粨鏋滀笂缁х画锛屾渶缁堣緭鍑哄埌 MODEL/CLIP 妲戒綅
        ordered_loras = sorted(
            loras,
            key=lambda x: (x["id"] if isinstance(x["id"], (int, float)) else 0),
        )
        for lora in ordered_loras:
            target = by_id.get(lora["target_id"])
            if target is None:
                print(f"[ModelsCombo] LoRA '{lora['name']}'锛氱洰鏍囧姞杞藉櫒涓嶅瓨鍦紝宸茶烦杩?)
                continue
            model, clip = target["model"], target["clip"]
            if model is None and clip is None:
                print(f"[ModelsCombo] LoRA '{lora['name']}'锛氱洰鏍囨病鏈?MODEL/CLIP锛屽凡璺宠繃")
                continue
            lora_path = folder_paths.get_full_path_or_raise("loras", lora["file"])
            lora_sd = comfy.utils.load_torch_file(lora_path)
            strength_model = float(lora["extra"].get("strength_model", 1.0))
            strength_clip = float(lora["extra"].get("strength_clip", 1.0))
            new_model, new_clip = comfy.sd.load_lora_for_models(model, clip, lora_sd, strength_model, strength_clip)
            # 鏃犺杩斿洖浠€涔堬紝閮芥妸銆屽綋鍓嶆ā鍨?CLIP銆嶄繚鐣欑粰涓嬩竴涓?lora 缁х画涓茶仈
            if new_model is not None:
                target["model"] = new_model
            elif model is not None:
                target["model"] = model
            if new_clip is not None:
                target["clip"] = new_clip
            elif clip is not None:
                target["clip"] = clip

        # 鍔ㄦ€佽緭鍑猴細鎸夈€屽姞杞藉櫒椤哄簭銆嶉€愪釜浜у嚭鍏舵嫢鏈夌殑绔彛锛坈heckpoint=model/clip/vae 鐩搁偦銆乽net=model銆乧lip=clip銆乿ae=vae锛?
        # lora 涓嶅崰杈撳嚭绔彛锛夈€備繚璇佷笌鍓嶇 updatePorts 鐨勯『搴忎竴鑷达紝鍏跺畠鑺傜偣鎺ョ嚎鏃剁被鍨嬫墠瀵瑰緱涓娿€?
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


# ===== EzFlex-FreeLatent锛氭寜銆屽垎杈ㄧ巼閫夋嫨鍣ㄣ€嶉潰鏉块厤缃敓鎴愮┖ Latent =====
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

    # latent 涓嬮噰鏍峰洜瀛愪负 8锛氭妸鍍忕礌灏哄瀵归綈鍒?8 鐨勫€嶆暟锛屽苟淇濊瘉鏈€灏忎笅闄?
    def mult8(v, lo=64):
        return max(lo, int(round(v / 8) * 8))

    return mult8(w), mult8(h), max(1, b)


class FreeLatentNode(io.ComfyNode):
    """V3 鑺傜偣锛歰utput 涓?Latent/Width/Height/Batch锛泈idth/height/batch_size 鐢?force_input 淇濊瘉鏄?
    鍙繛鎺?socket锛堜笉鍐嶈蛋 widget鈫抯ocket 杞崲 hack锛岄伩鍏?socket 鍦嗙偣鎮仠婕傜Щ锛夛紝鏈繛鎺ユ椂鐢ㄩ潰鏉?config 鍊笺€?""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="EzFlex-FreeLatent",
            display_name="EzFlex-FreeLatent",
            category="EzFlex",
            description="鎸夈€屽垎杈ㄧ巼閫夋嫨鍣ㄣ€嶅彲瑙嗗寲闈㈡澘閰嶇疆鍒涘缓涓€涓┖ Latent锛氳嚜鐢辨嫋鎷藉昂瀵?/ 姣斾緥 / MP 绠楁硶锛屾柟鍧楁槧灏勫埌 (b,4,h,w)銆傚楂?鎵规鎺ュ叆澶栭儴 INT socket 鏃朵紭鍏堜娇鐢ㄥ閮ㄥ€笺€?,
            inputs=[
                io.String.Input("config", socketless=True, default="{}",
                                tooltip="銆屽垎杈ㄧ巼閫夋嫨鍣ㄣ€嶉潰鏉跨敓鎴愮殑閰嶇疆 JSON锛堝搴?楂樺害/鎵规/绠楁硶/姣斾緥绛夛級銆?),
                io.Int.Input("width", display_name="Width", optional=True, default=0,
                             min=0, max=32768, step=8, force_input=True,
                             tooltip="澶栭儴瀹藉害锛?0 鏃惰鐩栭潰鏉垮楂橈紙涓嶅～/涓?0 鏃剁敤闈㈡澘鍊硷級銆?),
                io.Int.Input("height", display_name="Height", optional=True, default=0,
                             min=0, max=32768, step=8, force_input=True,
                             tooltip="澶栭儴楂樺害锛?0 鏃惰鐩栭潰鏉垮楂橈紙涓嶅～/涓?0 鏃剁敤闈㈡澘鍊硷級銆?),
                io.Int.Input("batch_size", display_name="Batch", optional=True, default=0,
                             min=0, max=4096, force_input=True,
                             tooltip="澶栭儴鎵规锛?0 鏃惰鐩栭潰鏉挎壒娆★紙涓嶅～/涓?0 鏃剁敤闈㈡澘鍊硷級銆?),
            ],
            outputs=[
                io.Latent.Output("Latent", tooltip="绌?latent (batch,4,height/8,width/8)"),
                io.Int.Output("Width", tooltip="鍍忕礌瀹藉害"),
                io.Int.Output("Height", tooltip="鍍忕礌楂樺害"),
                io.Int.Output("Batch", tooltip="鎵规鏁伴噺"),
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
        # latent 涓嬮噰鏍峰洜瀛愪负 8锛氬閮ㄦ帴鍏ュ€间篃瀵归綈鍒?8 鐨勫€嶆暟锛屼繚璇?latent 灏哄涓庢姤鍛婂€间竴鑷?
        def mult8(v, lo=64):
            return max(lo, int(round(v / 8) * 8))
        w, h = mult8(w), mult8(h)
        latent = torch.zeros([batch, 4, h // 8, w // 8], dtype=torch.float32)
        return io.NodeOutput({"samples": latent}, w, h, batch)


def _control_input_types(tooltip):
    """鎺у埗绫昏妭鐐圭殑鏍囧噯杈撳叆锛氶殣钘?config STRING 鎵胯浇闈㈡澘鐘舵€併€?""
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
    """鍒嗙粍棰勮锛堟柟妗圓锛屽弬鑰?rgthree Fast Groups Muter/Bypasser锛夛細鍓嶇鍐呭祵闈㈡澘绠＄悊
    銆屽紑鍏?鈫?鍖归厤锛堢敾甯冨垎缁?棰滆壊/鏍囬姝ｅ垯锛夆啋 node.mode 0/2/4銆嶃€?
    寮€鍏冲垪琛ㄤ笌褰撳墠棰勮鍚嶅瓨 config锛涘懡鍚嶅垎缁勯璁惧瓨鏈嶅姟鍣?user_data 棰勮搴擄紙鎸夎妭鐐瑰悕鍏变韩锛夈€?""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "銆屽垎缁勯璁俱€嶉潰鏉跨敓鎴愮殑閰嶇疆 JSON锛堝紑鍏冲垪琛?鍖归厤瑙勫垯/褰撳墠棰勮锛夈€?,
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-NodeSwitchGroup锛氫竴缁勫紑鍏筹紝姣忎釜寮€鍏虫寜 ComfyUI 鍒嗙粍 棰滆壊/鏍囬姝ｅ垯 鍖归厤鐩爣鑺傜偣锛屼竴閿 ALWAYS/NEVER/BYPASS mode銆傛帶鍒剁敱鍓嶇鐢熸晥锛屾湰鑺傜偣鎵胯浇 config 鐘舵€併€?

    def run(self, config="{}", **kwargs):
        return ()


class NodeSwitchMasterNode:
    """鑺傜偣鎺у埗鎬婚璁撅細鎬婚璁?= {NodeSwitchGroup 鑺傜偣 id -> 璇ュ垎缁勯璁惧悕} 鐨勬槧灏勩€?
    琛岋紙鐩爣鍒嗙粍鑺傜偣锛夌敱鍓嶇浠庣敾甯冨彂鐜帮紱搴旂敤鏃跺墠绔妸鏄犲皠鍐欒繘鍚勫垎缁勮妭鐐圭殑 config.current 骞惰Е鍙戝叾搴旂敤銆?""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "銆岃妭鐐规帶鍒舵€婚璁俱€嶉潰鏉跨敓鎴愮殑閰嶇疆 JSON锛堝綋鍓嶆€婚璁惧悕锛夈€?,
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-NodeSwitchMaster锛氭妸姣忎釜 EzFlex-NodeSwitchGroup 瀹炰緥鏄犲皠鍒板叾鏌愪釜鍒嗙粍棰勮锛涘垏鎹?搴旂敤鎬婚璁炬椂绾ц仈鍐欏叆鍒嗙粍鑺傜偣骞跺簲鐢ㄥ紑鍏炽€?

    def run(self, config="{}", **kwargs):
        return ()


class MainControlNode:
    """鎬绘帶鍒惰妭鐐癸細鎬婚璁?= {鐩爣鑺傜偣 id -> 璇ヨ妭鐐归璁惧悕} 鐨勬槧灏勶紝鐩爣鏄敾甯冧笂鐨?
    EzFlex-NodeSwitchMaster / EzFlex-ParamPresetControl / EzFlex-ModelsCombo / EzFlex-FreeLatent
    瀹炰緥銆傚簲鐢ㄦ椂绾ц仈涓嬫帹銆?""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "銆屾€绘帶鍒躲€嶉潰鏉跨敓鎴愮殑閰嶇疆 JSON锛堝綋鍓嶆€婚璁惧悕锛夈€?,
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-MainControl锛氭妸鐢诲竷涓婄殑 EzFlex-NodeSwitchMaster / EzFlex-ParamPresetControl / EzFlex-ModelsCombo / EzFlex-FreeLatent 瀹炰緥鏄犲皠鍒板叾棰勮锛屼竴閿骇鑱斿簲鐢紙鍐欑洰鏍?config.current 骞惰Е鍙戝叾搴旂敤閫昏緫锛夈€?

    def run(self, config="{}", **kwargs):
        return ()


class ParamPresetControlNode:
    """鍙傛暟棰勮鎺у埗锛氬墠绔潰鏉跨鐞嗗弬鏁扮粍锛堢粍/鍙傛暟鍙嫋鎷芥帓搴忥級锛屽姩鎬佽緭鍑虹鍙ｄ笌鍙傛暟缁勫崱鐗囦竴涓€瀵瑰簲
    锛堜竴涓垎缁勪竴涓?EZFLEX_PARAM_GROUP 绔彛锛屾惡甯﹁缁勫弬鏁版暟鎹級銆傚垎缁勫鍒?鎺掑簭鍚庣敱鍓嶇 POST
    /param_preset_control/outputs 鍚屾绫?RETURN_TYPES/RETURN_NAMES锛堟牎楠岀敤锛夛紝execute 鍐嶆寜瀹為檯鏁版嵁璁剧疆銆?""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "銆屽弬鏁伴璁炬帶鍒躲€嶉潰鏉跨敓鎴愮殑閰嶇疆 JSON锛堝弬鏁扮粍鍒楄〃 + 褰撳墠棰勮鍚嶏級銆?,
        )

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-ParamPresetControl锛氬彲瑙嗗寲缂栬緫鍙傛暟缁勶紙姣忕粍鍚弬鏁板悕/绫诲瀷/鍊?鍚敤锛夛紝鍔ㄦ€佽緭鍑虹鍙ｄ笌鍒嗙粍涓€涓€瀵瑰簲锛屾嫋鎷芥帓搴忓悗绔彛璺熼殢锛堝悓 ModelsCombo 鏈哄埗锛夈€?

    def run(self, config="{}", **kwargs):
        groups = parse_param_groups(config)
        types, names = _ppc_output_types(groups)
        self.__class__.RETURN_TYPES = types
        self.__class__.RETURN_NAMES = names
        return tuple(groups)


class ParamPresetOutputNode:
    """鍙傛暟棰勮杈撳嚭锛氳緭鍏ヤ竴涓?EZFLEX_PARAM_GROUP 鍒嗙粍绔彛锛堜粠 ParamPresetControl 瀵瑰簲鍒嗙粍绔彛杩炵嚎锛夈€?
    杈撳嚭绔彛 = 鍥哄畾鐨勬暣缁勬暟鎹孩鑹插渾鐐癸紙閫忎紶 EZFLEX_PARAM_GROUP 鏁寸粍鏁版嵁锛? 姣忎釜婵€娲诲弬鏁颁竴涓鍙?
    锛坕nt->INT / float->FLOAT / string->STRING / bool->BOOLEAN锛屽鏉傜被鍨?-> STRING(JSON)锛?
    绾㈣壊/鏈€変腑鐨勫弬鏁颁笉鍗犵鍙ｏ紱Output 闈㈡澘灞€閮ㄧ鐢ㄧ殑鍙傛暟杈撳嚭璇ョ被鍨嬩腑鎬ч粯璁ゅ€硷級銆?
    鍙傛暟澧炲垹/鎺掑簭/杩炴帴鍙樺寲鍚庣敱鍓嶇 POST /param_preset_output/outputs 鍚屾绫?RETURN_TYPES/RETURN_NAMES銆?""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "group": ("EZFLEX_PARAM_GROUP", {
                    "tooltip": "鏉ヨ嚜 EzFlex-ParamPresetControl 鐨勬煇涓弬鏁扮粍绔彛銆?,
                }),
                "config": ("STRING", {
                    "multiline": True,
                    "default": "{}",
                    "tooltip": "銆屽弬鏁伴璁捐緭鍑恒€嶉潰鏉跨敓鎴愮殑閰嶇疆 JSON锛堝眬閮ㄥ惎鐢?绂佺敤鍙傛暟 id 闆嗗悎锛夈€?,
                }),
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-ParamPresetOutput锛氬浐瀹氱殑鏁寸粍鏁版嵁绾㈣壊杈撳嚭 + 鎸夊弬鏁扮被鍨嬮€愪釜杈撳嚭婵€娲诲弬鏁帮紝涓嬫媺鍒囨崲鏃跺鐢?socket 淇濇寔鎺ョ嚎銆?

    def run(self, group=None, config="{}", **kwargs):
        group = group or {}
        off = _parse_local_off(config)
        # 鎸夊疄闄呬慨姝ｅ弬鏁扮粍绫诲瀷锛氬€艰嫢鏄?string锛堟棤鏁堣緭鍏ワ級鍒欑被鍨嬫敼 string
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
        types, names, outputs = ["EZFLEX_PARAM_GROUP"], ["鏁版嵁缁勫悎"], [group]
        for i, p in enumerate(active):
            ptype = (p.get("type") or "string").lower()
            types.append(PARAM_TYPE_MAP.get(ptype, "STRING"))
            names.append((p.get("name") or "").strip() or f"鍙傛暟 {i + 1}")
            if str(p.get("id")) in off:
                outputs.append(_ppo_disabled_value(ptype))
            else:
                outputs.append(param_value_to_comfy(p.get("value"), ptype))
        self.__class__.RETURN_TYPES = tuple(types)
        self.__class__.RETURN_NAMES = tuple(names)
        return tuple(outputs)


# ===== EzFlex-PreviewAny锛氫换鎰忛瑙?=====
# 鍙傝€?AUNPassthroughAnyMulti 鐨勫仛娉曪細鍥哄畾 input_1..N ANY 杈撳叆妲?+ STRING 杈撳嚭锛?
# 鍓嶇鐧芥澘绠＄悊鍗＄墖锛堟嫋鎷芥帓搴?澧炲垹锛夛紝鍗＄墖椤哄簭閫氳繃 workflow 閲岀殑 input 椤哄簭璇诲彇銆?
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
    """閫掑綊纭繚瀵硅薄鏍戝彲 JSON 搴忓垪鍖栥€?""
    if isinstance(obj, dict):
        return {k: _pv_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_pv_sanitize(v) for v in obj]
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    return _pv_str(obj)


class PreviewAnyNode:
    """EzFlex-PreviewAny锛氫竴鍧楃櫧鏉匡紝鍐呭惈澶氫釜鍙嫋鎷芥帓搴忕殑棰勮鍗＄墖锛涙瘡涓崱鐗囧搴斾竴涓换鎰忚緭鍏ョ鍙?+
    涓€涓瓧绗︿覆杈撳嚭绔彛锛堝悓 AUNPassthroughAnyMulti 鐨勬€濊矾锛氳緭鍑鸿鍗¤В鏋愬悗鐨勫瓧绗︿覆锛夈€?""

    @classmethod
    def INPUT_TYPES(cls):
        inputs = {
            "required": {
                "config": ("STRING", {
                    "multiline": True,
                    "default": "{\"save\":false,\"savePath\":\"\"}",
                    "tooltip": "銆屼换鎰忛瑙堛€嶉厤缃紙鏄惁瀛樻。 + 瀛樻。鐩稿鐩綍锛夈€?,
                }),
            },
            "optional": {},
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
        }
        for i in range(1, _PREVIEW_MAX + 1):
            inputs["optional"][f"input_{i}"] = (_ANY, {"forceInput": True, "tooltip": f"浠绘剰杈撳叆 {i}銆?})
        return inputs

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    OUTPUT_NODE = True
    FUNCTION = "preview"
    CATEGORY = "EzFlex"
    DESCRIPTION = "EzFlex-PreviewAny锛氱櫧鏉挎斁缃涓彲鎷栨嫿鎺掑簭鐨勯瑙堝崱鐗囷紝鎺ユ敹浠绘剰杈撳叆骞惰嚜鍔ㄨВ鏋愶紝鎸夌被鍨嬫樉绀?棰勮锛涘彲瀛樻。鍒?ComfyUI 杈撳嚭鐩綍銆傛瘡鍗′竴涓瓧绗︿覆杈撳嚭銆?

    def preview(self, config="{}", unique_id=None, extra_pnginfo=None, **kwargs):
        cfg = self._parse_config(config)
        connected = self._connected_inputs(unique_id, extra_pnginfo)
        wf_meta = PreviewAnyNode._workflow_gen_meta((extra_pnginfo or {}).get("workflow", {}))
        entries, outputs = [], []
        for i, (name, label, upstream) in enumerate(connected):
            entry = self._entry(label or f"杈撳叆 {i + 1}", kwargs.get(name), upstream, wf_meta)
            entry = self._maybe_save(entry, cfg, label or f"card_{i + 1}")
            entries.append(entry)
            outputs.append(kwargs.get(name))   # 閫忎紶鍘熷鍊硷紙涓嶆槸鍗℃枃瀛楋級锛屼緵宸ヤ綔娴佷腑闂磋繛鎺ョ户缁紶閫?
        # 鐢?"*" 閫氶厤绫诲瀷锛岃杈撳嚭鑳借繛鍒颁换鎰忕被鍨嬬殑杈撳叆绔彛锛堥€忎紶鍘熷鍊硷級
        self.__class__.RETURN_TYPES = tuple("*" for _ in range(len(outputs)))
        self.__class__.RETURN_NAMES = tuple(f"output_{i + 1}" for i in range(len(outputs)))
        return {"ui": {"entries": _pv_sanitize(entries)}, "result": tuple(outputs)}

    # 鈹€鈹€ 閰嶇疆 / 宸茶繛鎺ヨ緭鍏?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
        """杩斿洖宸茶繛鎺ヨ緭鍏?(name, label)锛屾寜 workflow 閲?input 椤哄簭銆俵abel 鍙栦笂娓歌緭鍑烘爣绛俱€?""
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
        # ComfyUI 宸ヤ綔娴佺殑 links 鍙兘鏄?dict锛屼篃鍙兘鏄暟缁?[id, origin_id, origin_slot, ...]锛屼袱绉嶉兘鍏煎
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

    # 鈹€鈹€ 鍗曞崱瑙ｆ瀽 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    def _entry(self, caption, value, upstream=None, wf_meta=None):
        entry = {"caption": caption or "", "type": "", "value": "", "full_value": None, "preview": None,
                 "audio": None, "frames": 0, "meta": None}
        if value is None:
            entry["type"] = "EMPTY"
            entry["value"] = "(鏈繛鎺?"
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
                    # 鏂囦欢鍨嬭棰戯紙VideoFromFile锛夛細鎸傛簮鏂囦欢 URL + 瑙ｉ甯у皝闈?+ 鍏冩暟鎹紝涓嶆暣娈佃В鐮侊紙閬垮厤鍗★級
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
                        # BytesIO/鏃犺矾寰勶細璇诲抚缂栫爜锛堝浘鐗囧簭鍒楋級
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
                            entry["value"] = "瑙嗛"
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
                entry["meta"] = ("Latent 鏄墿鏁ｆā鍨嬬殑闅愯棌娼滃湪绌洪棿锛堝帇缂╁悗鐨勭壒寰侊級锛宻hape=[B,C,H,W] 鍚箟锛?
                                 "B=鎵规(batch)銆丆=閫氶亾(channel锛岄€氬父涓?4)銆丠=楂樺害銆乄=瀹藉害銆傚畠涓嶆槸鏈€缁堝浘鍍忥紝"
                                 "闇€缁?VAE 瑙ｇ爜鎴愬浘鍍忋€傝繖閲岀粰鍑虹殑鏄畠鐨?shape/dtype 缁熻銆?)
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
                # 鍏滃簳锛氭ā鍨嬬被瀵硅薄锛堢被鍚?妯″潡/灞炴€ф帰娴嬶級鑻ユ湭琚瘑鍒紝缁欏嚭鎽樿鑰岄潪瑁?repr
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
                # 鍏滃簳锛氭ā鍨?CLIP/VAE 瀵硅薄鍗充娇鍓嶉潰鏌愭寮傚父锛屼篃灏介噺缁欐憳瑕佽€岄潪瑁?repr
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
        # 瑙嗛/3D/闊抽绛夈€屾枃浠朵笉鍚敓鎴愬厓鏁版嵁銆嶇殑绫诲瀷锛岃嫢褰撳墠宸ヤ綔娴佸浘鑳芥彁鍙栧埌浣跨敤鐨勬ā鍨?鎻愮ず璇?閲囨牱鍙傛暟锛?
        # 鍒欎篃鎸備笂銆岀敓鎴愪俊鎭€嶏紝璁╃敤鎴风湅鍒版湰娆＄敓鎴愮敤浜嗗摢浜涙ā鍨嬶紙MODEL/CLIP/VAE 鍗＄墖宸叉湁鑷韩鍏冩暟鎹紝涓嶅啀瑕嗙洊锛夈€?
        # 浣嗚嫢涓婃父鏄€屼粠鏂囦欢鍔犺浇銆嶏紙LoadImage/LoadVideo/VideoFromFile/Load3D 绛夛級锛岃鏄庤鍊间笉鏄湰娆＄敓鎴愮殑锛?
        # 涓嶈兘鐢ㄥ綋鍓嶅伐浣滄祦鍙傛暟鍐掑厖锛岄伩鍏嶈瀵笺€?
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
            # 涓€鍒楀浘鍍忓抚 -> 瑙嗛
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
        # ComfyUI 瀵硅薄绫诲瀷锛堟寜绫诲悕璇嗗埆锛?
        cls = type(value).__name__
        if cls.startswith("VideoFrom") or "Video" in cls or cls in ("VideoFile", "VideoFrame"):
            return "VIDEO"
        mod = type(value).__module__ or ""
        # 妯″瀷/CLIP/VAE锛氭寜绫诲悕 + 妯″潡鍒ゅ畾锛堟ā鍧楀垽瀹氭瘮灞炴€ф帰娴嬫洿绋筹紝瑕嗙洊 ModelPatcher 绯诲垪瀛愮被锛?
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
        """淇濆瓨鍘熷浘鍒颁复鏃舵枃浠跺苟杩斿洖鍙闂?URL锛堝叏灞忕敤鍘熷浘锛夈€?""
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
        """闊抽锛氭枃浠跺瀷鐢ㄥ師 URL锛涘惁鍒欐妸娉㈠舰鍐欎复鏃?WAV 骞惰繑鍥?serve URL锛堟祦寮忥紝閬垮厤 base64 鍗￠】锛夈€?""
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
            # 鏃犳枃浠?鈫?鍐欎复鏃?WAV
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
        """鎶?ComfyUI 闊抽锛坉ict 鍚?waveform/sample_rate锛屾垨 (waveform, sample_rate)锛夌紪鐮佷负 WAV data URI銆?""
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
                    return f"闊抽 {w.shape[-1]} 閲囨牱 @ {sample_rate}Hz" if sample_rate else f"闊抽 {w.shape[-1]} 閲囨牱"
                return "闊抽"
            if isinstance(data, (list, tuple)) and len(data) >= 2:
                sample_rate = data[1]
                w = data[0]
                if isinstance(w, torch.Tensor):
                    return f"闊抽 {w.shape[-1]} 閲囨牱 @ {sample_rate}Hz"
                return "闊抽"
            return "闊抽"
        except Exception:
            return "闊抽"

    @staticmethod
    def _video_extract_frames(value):
        """浠?dict/list/VideoFromFile 瀵硅薄鎻愬彇 (甯у垪琛? fps)锛屾渶澶?30 甯с€?""
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
                # VideoFromFile 涔嬬被鐨勫璞★細璇曞父瑙佸睘鎬?鍙凯浠?to_images
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
        """瑙嗛/澶氬抚锛氳繑鍥?(棣栧抚 base64, 甯ф暟)銆?""
        frames, _ = PreviewAnyNode._video_extract_frames(data)
        if frames:
            return (PreviewAnyNode._image_to_base64(frames[0]) if frames[0] is not None else None), len(frames)
        return None, 0

    @staticmethod
    def _video_frames(value):
        """鎻愬彇瑙嗛甯у垪琛?+ fps锛堟渶澶?30 甯э級锛屽吋瀹?dict/list/VideoFromFile 瀵硅薄銆?""
        return PreviewAnyNode._video_extract_frames(value)

    @staticmethod
    def _video_summary(frames, fps):
        try:
            n = len(frames)
            if not n:
                return "瑙嗛"
            t = frames[0]
            if t.ndim == 4:
                t = t[0]
            if t.ndim == 3:
                return f"{n} 甯?@ {fps}fps  {t.shape[1]}x{t.shape[0]}"
            return f"{n} 甯?@ {fps}fps"
        except Exception:
            return "瑙嗛"

    @staticmethod
    def _video_to_webm(frames, fps=8):
        """鐢?av 鎶婂抚搴忓垪缂栫爜鎴?WebM(data URI)锛岀己澶?av/缂栫爜鍣ㄦ椂杩斿洖 None銆?""
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
        """鏂囦欢鍨嬭棰戝璞★紙VideoFromFile锛夛細鐢?av 璇诲叏閮ㄥ抚锛堝畬鏁磋棰戯級锛岃繑鍥?(numpy RGB 甯у垪琛? fps)銆?""
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
        """鐢?av 鎶?numpy RGB 甯х紪鐮佹垚 WebM(data URI)銆?""
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
                return f"{len(frames)} 甯?@ {fps:.0f}fps  {w}x{h}"
        except Exception:
            pass
        return "瑙嗛"

    @staticmethod
    def _video_file_poster(src):
        """鍙В棣栧抚鍋氬皝闈紝杩斿洖 (base64, fps, (w,h))銆?""
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
                return f"瑙嗛 @ {fps:.0f}fps  {w}x{h}"
        except Exception:
            pass
        return "瑙嗛"

    @staticmethod
    @staticmethod
    def _resolve_model_path(path):
        """鎶婄浉瀵规ā鍨嬭矾寰勮В鏋愪负缁濆璺緞锛堥亶鍘?ComfyUI 鍚勬ā鍨嬬洰褰曪紝鏀寔瀛愯矾寰勫 鐢婚\\椋庢牸\\Anima\\xxx.safetensors锛夈€?""
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
                    # 1) 鐩稿瀛愯矾寰?
                    fp = folder_paths.get_full_path(folder, rel)
                    if fp and os.path.isfile(fp):
                        return fp
                    # 2) 浠呮枃浠跺悕
                    fp = folder_paths.get_full_path(folder, base)
                    if fp and os.path.isfile(fp):
                        return fp
                    # 3) 鐩存帴鎷兼帴鍚勬枃浠跺す鏍圭洰褰?
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
            # 浼樺厛涓婃父鍔犺浇鑺傜偣鐨?widgets_values锛氳兘鎷垮埌鐪熸鐨勬ā鍨?LoRA 鏂囦欢鍚?
            # 锛堝 LoraLoader 鐨?lora_name銆乁NETLoader 鐨?unet_name銆丆heckpointLoader 鐨?ckpt_name锛夈€?
            # LoRA 鍔犺浇鍣ㄨ繛浜嗘ā鍨嬪悗锛岄瑙堟兂鏄剧ず鐨勬槸 LoRA 鐨勮缁冭瘝/姣旈噸绛夛紝鍥犳浼樺厛璇?LoRA 鏂囦欢銆?
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
                # ModelsCombo锛歸idgets_values 閲屾湁涓€涓?JSON锛屾弿杩?combo 鍐?unet/clip/vae/lora 娓呭崟銆?
                # MODEL 浼樺厛鍙?lora锛堣璁粌璇?姣旈噸锛夛紝鍚﹀垯鍙?unet锛汣LIP/VAE 鍙栧搴旂被鍨嬨€?
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
                # 鍏堟壘閫氱敤鏂囦欢/璺緞鏍峰紡鐨?widget锛汱oRA 鑺傜偣鍐嶅厹搴曚换浣曞惈 lora 鐨勫瓧绗︿覆
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
            # 瀵硅薄鍏滃簳锛氫粠 cached_patcher_init / patcher 鍙栬矾寰?
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
        """浠庢ā鍨嬪璞℃彁鍙栨灦鏋?绫诲瀷瀛楃涓诧紙澶勭悊 callable 鐨?model_type锛岄伩鍏嶈緭鍑?bound method 鐨?repr锛夈€?""
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
            # 鍙畨鍏ㄦ帰娴嬪凡鐭ュ瓨鍦ㄧ殑 model_type锛岄伩鍏嶈闂?model_config 涓婁笉瀛樺湪鐨?
            # model_type_name/architecture 瑙﹀彂 ComfyUI 鐨勨€渁ccessed non-existing attr鈥濊鍛娿€?
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
            # 鍏滃簳锛氬簳灞傛ā鍨嬬被鍚嶏紙comfy.supported_models.Anima -> "anima"锛孠rea -> "krea" 绛夛級
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
        """璇诲彇妯″瀷鏂囦欢鐨勫師濮嬪厓鏁版嵁 dict锛堝惈 ss_* / modelspec.* 绛夛級銆?""
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
        """浠庢ā鍨嬪璞¤嚜韬彇鍩虹妯″瀷璺緞锛堜笉鍚笂娓?lora锛夈€?""
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
        """浠庝笂娓歌妭鐐瑰彇 LoRA 鏂囦欢璺緞锛圠ora 鑺傜偣鐨?lora_name 鎴?ModelsCombo 鐨?lora file锛夈€?""
        if not isinstance(upstream, dict):
            return None
        try:
            node_hint = " ".join(str(upstream.get(k) or "") for k in ("type", "title", "name"))
            is_lora_node = "lora" in node_hint.lower()
            wv = upstream.get("widgets_values") or []
            # ModelsCombo锛欽SON 娓呭崟閲岀殑 type=lora 椤?
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
            # Lora 鑺傜偣锛氱洿鎺ュ彇 lora_name 涔嬬被鐨勬枃浠?
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
        """鎶婂崟涓ā鍨嬫枃浠剁殑鍏冩暟鎹暣鐞嗘垚鈥滈噸瑕佸瓧娈靛湪鍓嶃€佷腑鏂囨爣绛锯€濈殑 dict銆俴ind锛氭ā鍨?LoRA/None銆?""
        raw = PreviewAnyNode._read_raw_meta(path)
        rawd = raw or {}
        out = {}

        def pick(*keys):
            for k in keys:
                if k in rawd and rawd[k] not in (None, ""):
                    return rawd[k]
            return None

        out["鍚嶇О"] = name or (os.path.basename(path) if path else (kind or "妯″瀷"))
        out["绫诲瀷"] = kind or type_name
        arch = pick("modelspec.architecture", "architecture", "model_type", "ss_base_model_version", "ss_model_description", "model_type_name")
        if arch:
            out["鏋舵瀯"] = str(arch)
        else:
            ts = PreviewAnyNode._model_type_str(value)
            if ts:
                out["鏋舵瀯"] = ts
        author = pick("modelspec.author", "created_by", "ss_creator", "author")
        if author:
            out["浣滆€?鏉ユ簮"] = str(author)
        org = pick("modelspec.organization", "modelspec.tags", "ss_sd_model_name", "modelspec.civitai_resources")
        if org:
            out["褰掑睘/缁勭粐"] = str(org)
        base = pick("ss_base_model_version", "base_model", "ss_sd_model_name")
        if base and kind == "LoRA":
            out["鍩虹妯″瀷"] = str(base)
        dim = pick("ss_network_dim", "ss_network_dims")
        if dim:
            out["璁粌缁村害 dim"] = str(dim)
        alpha = pick("ss_network_alpha")
        if alpha:
            out["璁粌缁村害 alpha"] = str(alpha)
        tf = pick("ss_tag_frequency")
        if tf:
            try:
                tfv = json.loads(tf) if isinstance(tf, str) else tf
                if isinstance(tfv, dict):
                    out["璁粌鍏抽敭璇?姣旈噸"] = {k: (v[0] if isinstance(v, (list, tuple)) else v) for k, v in tfv.items()}
                else:
                    out["璁粌鍏抽敭璇?姣旈噸"] = str(tfv)
            except Exception:
                out["璁粌鍏抽敭璇?姣旈噸"] = str(tf)
        # 涓昏瑙﹀彂璇嶏細鎸夊嚭鐜版鏁板彇鍓嶈嫢骞诧紙涓庡畬鏁淬€岃缁冨叧閿瘝/姣旈噸銆嶅苟瀛橈紝蹇€熺湅锛?
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
                    out["涓昏瑙﹀彂璇?] = ", ".join(topw)
        except Exception:
            pass
        ntype = pick("ss_network_module", "ss_module", "ss_network_args", "ss_network_type")
        if ntype:
            out["缃戠粶绫诲瀷"] = str(ntype)
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
            out["鏄惁鍐呭祵 VAE"] = "鏄紙鍐呯疆 VAE锛? if vae_ok else "鍚︼紙鍙兘闇€澶栨寕 VAE锛?
        desc = pick("modelspec.description", "ss_model_description", "ss_training_comment", "ss_caption")
        if desc:
            out["鎻忚堪"] = str(desc)
        title = pick("modelspec.title", "ss_model_name")
        if title and title != name:
            out["妯″瀷鍚?] = str(title)
        ver = pick("modelspec.sd_version", "modelspec.version", "modelspec.schema_version", "ss_version", "modelspec.training_version")
        if ver and str(ver) != str(arch):
            out["鐗堟湰"] = str(ver)
        use_prompt = pick("modelspec.usage")
        if use_prompt and str(use_prompt) != str(desc):
            out["浣跨敤鎻愮ず璇?瑙﹀彂璇?] = str(use_prompt)
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
            out["鏉ユ簮/閾炬帴"] = str(src)
        # 甯哥敤璁粌鍙傛暟锛堟斁涓棿锛岃緝娆¤锛?
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
            out["璁粌鍙傛暟"] = tr
        if path:
            out["鏂囦欢"] = os.path.basename(path)
            out["瀛樻斁璺緞"] = os.path.abspath(path)
            try:
                sz = os.path.getsize(path)
                out["澶у皬"] = _fmt_size(sz)
                if sz <= (1 << 30):
                    out["鍝堝笇鍊?] = _sha256(path)
                else:
                    out["鍝堝笇鍊?] = "(澶ф枃浠舵湭璁＄畻锛岄伩鍏嶉樆濉?"
            except Exception:
                pass
            try:
                out["淇敼鏃堕棿"] = _fmt_mtime(os.path.getmtime(path))
            except Exception:
                pass
        if raw:
            out["鍏ㄩ儴鍏冩暟鎹?] = raw
        return out

    @staticmethod
    def _model_meta(value, type_name, upstream=None):
        """璇诲彇妯″瀷鍏冩暟鎹紝鎸?妯″瀷/LoRA 鍒嗗弶銆侀噸瑕佸瓧娈靛湪鍓嶃€佷腑鏂囨爣绛炬帓鐗堬紝杩斿洖 JSON 瀛楃涓蹭緵鍓嶇閿€兼爲銆?""
        try:
            base_path = PreviewAnyNode._base_model_path(value, type_name)
            lora_path = PreviewAnyNode._lora_file_path(value, type_name, upstream)
            name = PreviewAnyNode._extract_name(value, type_name)
            if lora_path and lora_path != base_path:
                result = {
                    "妯″瀷": PreviewAnyNode._build_sub_meta(base_path, name, type_name, value, "妯″瀷"),
                    "LoRA": PreviewAnyNode._build_sub_meta(lora_path, os.path.splitext(os.path.basename(lora_path))[0] if lora_path else "LoRA", type_name, value, "LoRA")
                }
            else:
                result = PreviewAnyNode._build_sub_meta(base_path or lora_path, name, type_name, value, None)
            return json.dumps(result, ensure_ascii=False, default=str)
        except Exception:
            return None

    @staticmethod
    def _read_image_text_chunks(path):
        """璇诲彇鍥剧墖鍐呭祵鏂囨湰鍧楋紙ComfyUI 鐨?prompt/workflow锛學ebUI 鐨?parameters 绛夛級銆?""
        try:
            from PIL import Image
            im = Image.open(path)
            info = im.info or {}
            return {k: v for k, v in info.items() if isinstance(v, str)}
        except Exception:
            return {}

    @staticmethod
    def _parse_img_meta(text):
        """鎶婂浘鐗囨枃鏈潡瑙ｆ瀽鎴愮粨鏋勫寲 dict锛堟ā鍨?LoRA/CLIP/VAE/鎻愮ず璇?閲囨牱鍙傛暟 + 鍘熷鍧楋級銆?""
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
                    # 缁勫悎閰嶇疆锛圗zFlex-ModelsCombo 绛夛級锛歩nputs 閲屽彲鑳藉嚭鐜版弿杩?unet/clip/vae/lora 鐨?JSON 鏁扮粍
                    for v in i.values():
                        _try_combo(v, model, lora, clip, vae)
            # workflow 鍥惧厹搴曪細褰撳彧鏈?workflow 鏂囨湰鍧椼€佹垨澶氫釜鑺傜偣鐢ㄧ被 type 琛ㄧず鏃朵篃鑳芥彁鍙?
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
            # 閫氱敤鍥為€€锛氫笉渚濊禆纭紪鐮佽妭鐐圭被鍚嶏紝鎵弿鎵€鏈夎妭鐐?input锛屾寜銆屽儚妯″瀷鏂囦欢鍚嶇殑瀛楃涓层€嶅綊绫伙紝
            # 瑕嗙洊 krea2 / flux2 / qwen 绛夋柊鍔犺浇鍣ㄦ垨浣跨敤鑷畾涔夎妭鐐规椂 prompt 鍏冩暟鎹殑鎻愬彇銆?
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
                out["妯″瀷"] = list(dict.fromkeys(model))
            if lora:
                out["LoRA"] = list(dict.fromkeys(lora))
            if clip:
                out["CLIP"] = list(dict.fromkeys(clip))
            if vae:
                out["VAE"] = list(dict.fromkeys(vae))
            if prompts:
                out["鎻愮ず璇?] = prompts
            if neg:
                out["鍙嶅悜鎻愮ず璇?] = neg
            if sampler:
                out["閲囨牱鍙傛暟"] = sampler
            rawc = {k: text[k] for k in ("prompt", "workflow", "parameters") if k in text}
            if rawc:
                out["鍘熷鏂囨湰鍧?] = rawc
        except Exception:
            pass
        return out

    @staticmethod
    def _image_gen_meta(upstream):
        """浠庝笂娓歌妭鐐圭殑 image 鏂囦欢鍚嶈鍙栫敓鎴愬浘鐗囩殑鍏冧俊鎭紝杩斿洖缁撴瀯鍖?dict锛堟棤鍒?None锛夈€?""
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
                # 鐢熸垚鍥鹃€氬父鍦?output/锛屼篃鍏煎 temp/input/锛沠ilename 鍙兘鏄瓙璺緞
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
            parsed["鏉ユ簮鏂囦欢"] = os.path.basename(path)
            return parsed
        except Exception:
            return None

    @staticmethod
    def _file_gen_meta(path):
        """璇诲彇浠绘剰杈撳嚭鏂囦欢鐨勭敓鎴?瀹瑰櫒鍏冧俊鎭€傞『搴忥細PIL 鍐呭祵鏂囨湰鍧楋紙PNG/WEBP/JPEG/鍔ㄧ敾 webp锛夆啋 鍚屽悕 sidecar
        JSON/txt 鈫?瀹瑰櫒鍐呭祵鍏冩暟鎹紙GLB/glTF asset/extras銆佽棰?ffprobe/闊抽 mutagen 鏍囩锛夈€傛棤鍒?None銆?""
        if not path or not os.path.isfile(path):
            return None
        text = PreviewAnyNode._read_image_text_chunks(path)
        if text:
            parsed = PreviewAnyNode._parse_img_meta(text)
            if parsed:
                parsed["鏉ユ簮鏂囦欢"] = os.path.basename(path)
                return parsed
        sc = PreviewAnyNode._read_sidecar_meta(path)
        if sc:
            sc.setdefault("鏉ユ簮鏂囦欢", os.path.basename(path))
            return sc
        cont = PreviewAnyNode._container_meta(path)
        if cont:
            cont.setdefault("鏉ユ簮鏂囦欢", os.path.basename(path))
            return cont
        return None

    @staticmethod
    def _read_sidecar_meta(path):
        """鏌ユ壘鍚屽悕鐨?<base>.json / <base>.metadata.json / <file>.json / <base>.txt锛岃兘璇诲埌灏辫繑鍥炲叾鍐呭銆?""
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
                    return {"鍘熷鏂囨湰鍧?: raw[:200000]}
                try:
                    data = json.loads(raw)
                except Exception:
                    return {"鍘熷鏂囨湰鍧?: raw[:200000]}
                if isinstance(data, dict):
                    return data
                if isinstance(data, list):
                    return {"鏁版嵁": data}
            return None
        except Exception:
            return None

    @staticmethod
    def _container_meta(path):
        """瀹瑰櫒鍐呭祵鍏冩暟鎹細GLB/glTF 璧勪骇淇℃伅锛坋xtras/generator锛夛紝瑙嗛瀹瑰櫒鏍囩锛坒fprobe锛夛紝闊抽鏍囩锛坢utagen锛夈€?""
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
            out["璧勪骇"] = data["asset"]
        if data.get("extras"):
            out["闄勫姞淇℃伅"] = data["extras"]
        if data.get("meshes"):
            out["缃戞牸鏁?] = len(data["meshes"])
        if data.get("materials"):
            out["鏉愯川鏁?] = len(data["materials"])
        if data.get("animations"):
            out["鍔ㄧ敾鏁?] = len(data["animations"])
        return out if out else None

    @staticmethod
    def _gltf_meta(path):
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
        out = {}
        if isinstance(data.get("asset"), dict):
            out["璧勪骇"] = data["asset"]
        if data.get("extras"):
            out["闄勫姞淇℃伅"] = data["extras"]
        if data.get("meshes"):
            out["缃戞牸鏁?] = len(data["meshes"])
        if data.get("materials"):
            out["鏉愯川鏁?] = len(data["materials"])
        if data.get("animations"):
            out["鍔ㄧ敾鏁?] = len(data["animations"])
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
                        res["瀹瑰櫒鏍囩"] = tags
                    for st in (data.get("streams") or []):
                        codec = st.get("codec_type")
                        if codec:
                            res.setdefault("娴?, []).append({
                                codec: st.get("codec_name"),
                                "瀹?: st.get("width"),
                                "楂?: st.get("height"),
                                "鏃堕暱": st.get("duration"),
                                "fps": st.get("avg_frame_rate"),
                            })
                    return res if res else None
            try:
                import mutagen
            except Exception:
                return None
            m = mutagen.File(path)
            if m and getattr(m, "tags", None):
                return {"鏍囩": {str(k): str(v) for k, v in m.tags.items() if str(v)}}
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
                return {"鏍囩": {str(k): str(v) for k, v in m.tags.items() if str(v)}}
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
                    return {"闊抽": info}
            return None
        except Exception:
            return None

    @staticmethod
    def _workflow_gen_meta(workflow):
        """浠庡綋鍓嶅伐浣滄祦鍥撅紙extra_pnginfo['workflow'] 鐨?nodes/widgets_values锛夊敖鍔涙彁鍙栦娇鐢ㄧ殑妯″瀷/LoRA/CLIP/VAE銆?
        鎻愮ず璇嶄笌閲囨牱鍙傛暟锛屼緵瑙嗛/3D/闊抽绛夈€屽鍣ㄤ笉鍐呭祵鍏冩暟鎹€嶇殑绫诲瀷涔熺湅鍒扮敓鎴愮殑妯″瀷鍙傛暟銆傛棤鍒?None銆?""
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
            # 鎻愮ず璇嶏細CLIPTextEncode / 甯?text 鐨勭紪鐮佽妭鐐癸紝鍙栫涓€涓潪妯″瀷鏂囦欢鍚嶇殑鏂囨湰 widget
            if ("clip" in cl and "encode" in cl) or "text" in cl or "prompt" in cl:
                for w in wv:
                    if isinstance(w, str) and w.strip() and not _is_model_ext(w):
                        prompts.append(w)
                        break
            # 閲囨牱鍙傛暟锛欿/Sampler 甯歌 widget 椤哄簭灏藉姏鎺ㄦ柇锛堝惈 control_after_generate 鍋忕Щ锛?
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
            out["妯″瀷"] = list(dict.fromkeys(model))
        if lora:
            out["LoRA"] = list(dict.fromkeys(lora))
        if clip:
            out["CLIP"] = list(dict.fromkeys(clip))
        if vae:
            out["VAE"] = list(dict.fromkeys(vae))
        if prompts:
            out["鎻愮ず璇?] = list(dict.fromkeys(prompts))
        if sampler:
            out["閲囨牱鍙傛暟"] = sampler
        return out if out else None

    @staticmethod
    def _mask_to_base64(tensor):
        """鐏板害 mask (H,W)/(B,H,W) -> PNG base64銆?""
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
        """淇濆瓨鐏板害 mask 鍘熷浘鍒颁复鏃舵枃浠跺苟杩斿洖 URL锛堝叏灞忕敤鍘熷浘锛夈€?""
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
                return f"3D 妯″瀷 ({fmt})" + (f": {name}" if name else "")
            return f"3D 妯″瀷 ({type(value).__name__})" + (f": {name}" if name else "")
        except Exception:
            return f"3D 妯″瀷 ({type(value).__name__})"

    @staticmethod
    def _export_3d_url(value):
        """杩斿洖 3D 妯″瀷鍙闂?URL銆備紭鍏堢敤 path-based URL锛?preview_any/fs/<abs>锛変互渚垮閮ㄨ创鍥?缂撳啿鐨勭浉瀵硅矾寰勬纭В鏋愶紝鍚﹀垯 save_to 瀵煎嚭銆?""
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
        """瀛樻。寮€鍚椂鎶婂崱鐗囧唴瀹瑰啓鍒?<output>/<savePath>/锛屽苟鍥炲～ saved_path銆?""
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
        """閫掑綊鎶?Python 瀛楅潰閲忓瓧绗︿覆锛堝惈鍗曞紩鍙?dict/list/tuple/set锛夎В鏋愭垚鍘熺敓 JSON 缁撴瀯锛屼緵鏍戝睍寮€銆?""
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
        """鎶婃ā鍨?__metadata__ 鏁寸悊鎴愬彲璇绘憳瑕侊紱宓屽 JSON 瀛楃涓插皾璇曡В鏋愶紝浼樺厛灞曠ず鏋舵瀯/浣滆€呯瓑鍏抽敭椤广€?""
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



# 鍙傛暟绫诲瀷 -> ComfyUI 杈撳嚭绫诲瀷锛氬鏉傜被鍨嬶紙complex/tuple/list/set/dictionary锛夋病鏈夊師鐢熺鍙ｏ紝缁熶竴璧?STRING(JSON)銆?
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
    """鎸夌被鍨嬫妸瀛楃涓插€艰В鏋愭垚鍘熺敓锛堟湁鏁堬級锛涗笉绗﹀悎淇濈暀瀛楃涓层€?""
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
    """鎶?WAV 瀛楄妭鎸夋墍閫夋牸寮?鐮佺巼/閲囨牱鐜囬噸缂栫爜锛坅v锛夈€?""
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
    """鎶婅棰戝瓧鑺傛寜鎵€閫夊鍣?缂栫爜鍣?CRF/甯х巼閲嶇紪鐮侊紙av锛夈€?""
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
    """鎶?ParamPresetControl 鐨?config JSON 瑙ｆ瀽鎴愬弬鏁扮粍鍒楄〃锛堜笌鍓嶇闈㈡澘鏁版嵁鍚屾瀯锛夈€?""
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
            "name": item.get("name") or "鍙傛暟缁?,
            "out": item.get("out") or "all",
            "params": [
                {
                    "id": p.get("id"),
                    "name": p.get("name") or "鍙傛暟",
                    "type": p.get("type") or "string",
                    "value": _norm_param_value(p.get("value"), p.get("type")),
                    "enabled": p.get("enabled", True),
                }
                for p in params if isinstance(p, dict)
            ],
        })
    return groups


def param_value_to_comfy(value, ptype):
    """鎶婇潰鏉块噷鐨勫弬鏁板€兼寜绫诲瀷涓ユ牸杞垚 ComfyUI 绔彛鍊硷紱澶嶆潅绫诲瀷 JSON 搴忓垪鍖栦负 STRING銆?

    bool锛氭寜銆岄潪绌?闈為浂鍗崇湡銆嶇殑 Python 鐪熷€艰涔夆€斺€?2"/"abcd"鈫扵rue锛涘彧鏈夋槑纭殑鍋囪〃绀?
    ("", "0", "false", "no", "off", "none", "null") 鎴?0 鎵嶄负 False銆?
    int/float 瀹芥澗瑙ｆ瀽锛坕nt(val)/float(val)锛夛紝瑙ｆ瀽澶辫触鍥為€€ 0锛岄伩鍏嶄笅娓告姏閿欍€?
    """
    if ptype == "int":
        if isinstance(value, str):
            s = value.strip()
            if re.fullmatch(r"-?\d+", s):
                return int(s)
            return value  # 鏃犳晥 -> string
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return str(value)
    if ptype == "float":
        if isinstance(value, str):
            s = value.strip()
            if re.fullmatch(r"-?\d+(\.\d+)?([eE][-+]?\d+)?", s):
                return float(s)
            return value  # 鏃犳晥 -> string
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
            return value  # 鏃犳晥 -> string
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
    """鎸夊弬鏁扮粍椤哄簭绠?ParamPresetControl 鐨勮緭鍑虹被鍨?鍚嶇О锛堜竴涓垎缁勪竴涓?EZFLEX_PARAM_GROUP 绔彛锛夈€?""
    groups = groups or []
    names = []
    for i, g in enumerate(groups):
        nm = (g.get("name") or "").strip() or f"鍙傛暟缁?{i + 1}"
        names.append(nm)
    return tuple(["EZFLEX_PARAM_GROUP"] * len(groups)), tuple(names)


def _ppo_output_types(params):
    """鎸夎緭鍑洪『搴忕畻 ParamPresetOutput 鐨勭被鍨?鍚嶇О锛氱 0 涓浐瀹氫负鏁寸粍鏁版嵁(绾㈣壊 EZFLEX_PARAM_GROUP)锛屽叾鍚庢瘡涓縺娲诲弬鏁颁竴涓鍙ｃ€?""
    params = params or []
    types, names = [], []
    for i, p in enumerate(params):
        ptype = (p.get("type") or "string").lower()
        if ptype == "ezflex_param_group":
            types.append("EZFLEX_PARAM_GROUP")
        else:
            types.append(PARAM_TYPE_MAP.get(ptype, "STRING"))
        names.append((p.get("name") or "").strip() or f"鍙傛暟 {i + 1}")
    return tuple(types), tuple(names)


def _ppo_effective_params(group):
    """鍙傛暟缁勫疄闄呰緭鍑虹殑鍙傛暟锛氬叏閮ㄧ豢鑹?鍚敤)鍙傛暟锛涜嫢缁勮浜?out锛堝崟涓弬鏁?id锛夊垯鍙繚鐣欒鍙傛暟銆?""
    params = (group or {}).get("params") or []
    active = [p for p in params if p.get("enabled", True) is not False]
    out = group.get("out") or "all"
    if out != "all":
        active = [p for p in active if str(p.get("id")) == str(out)]
    return active


def _parse_local_off(config):
    """瑙ｆ瀽 Output 鑺傜偣 config 閲岀殑灞€閮ㄧ鐢ㄥ弬鏁?id 闆嗗悎锛圤utput 闈㈡澘鑷韩鍚?绂佺敤锛屼笉鍐欏洖鎺у埗鑺傜偣锛夈€?""
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
    """绂佺敤/鏈€変腑鍙傛暟杈撳嚭鈥滀腑鎬ч粯璁ゅ€尖€濓紙int鈫?銆乫loat鈫?.0銆乥ool鈫?銆乧omplex鈫?锛屽叾瀹冣啋绌轰覆锛夈€?""
    if ptype in ("int", "bool", "complex"):
        return 0
    if ptype == "float":
        return 0.0
    return ""  # string/tuple/list/set/dictionary -> 绌轰覆鍗犱綅


async def _ppc_outputs(req):
    """鍓嶇鍦ㄥ垎缁勫鍒?鎺掑簭鍚?POST锛屾妸绫?RETURN_TYPES/RETURN_NAMES 鍚屾鎴愬綋鍓嶇鍙ｆ帓鍒楋紙鏍￠獙鐢級銆?""
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
    """鍓嶇鍦ㄨ繛鎺ュ彉鍖?鍙傛暟澧炲垹鎺掑簭鍚?POST锛屾妸绫?RETURN_TYPES/RETURN_NAMES 鍚屾鎴愬綋鍓嶅弬鏁版帓鍒楋紙鏍￠獙鐢級銆?""
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


# ===== EzFlex-PreviewAny锛氭枃浠剁郴缁熻緟鍔╄矾鐢憋紙瀛樻。浣嶇疆娴忚 / 鎵撳紑鏂囦欢澶归€変腑鏂囦欢锛?====
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
    """寮?Windows 鍘熺敓鈥滈€夋嫨鏂囦欢澶光€濆璇濇锛岄粯璁?ComfyUI 杈撳嚭鐩綍銆?""
    base = PreviewAnyNode._output_dir()
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        path = filedialog.askdirectory(initialdir=base, title="閫夋嫨淇濆瓨浣嶇疆")
        root.destroy()
        if path:
            return _web.json_response({"ok": True, "path": os.path.normpath(path), "base": base})
        return _web.json_response({"ok": False})
    except Exception as e:
        return _web.json_response({"ok": False, "error": str(e)}, status=500)


async def _preview_any_serve_video(req):
    """娴佸紡杩斿洖鏈湴瑙嗛鏂囦欢锛堝甫 Range 鏀寔锛屽彲鎷栧姩杩涘害/鏈夊０锛夈€備粎闄愭湰鍦拌矾寰勩€?""
    path = req.query.get("path", "").strip()
    if not path or not os.path.isfile(path):
        return _web.json_response({"error": "not found"}, status=404)
    return _web.FileResponse(os.path.abspath(path))


async def _preview_any_static(req):
    """serve 鎻掍欢 web/ 鐩綍锛堜緵鍓嶇鏈湴瀵煎叆 three.js 涓庡姞杞藉櫒锛夛紝浠呯櫧鍚嶅崟鐩稿璺緞銆?""
    rel = req.match_info.get("path", "")
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "web"))
    full = os.path.abspath(os.path.join(root, rel))
    if not full.startswith(root) or not os.path.isfile(full):
        return _web.json_response({"error": "not found"}, status=404)
    return _web.FileResponse(full)


async def _preview_any_fs(req):
    """鎸夌粷瀵硅矾寰?serve 鏂囦欢锛堢敤浜?3D 妯″瀷鍙婂叾澶栭儴璐村浘/缂撳啿锛屼娇鐩稿璺緞鑳芥纭В鏋愶級銆備粎鏈湴璺緞銆?""
    from urllib.parse import unquote
    rel = req.match_info.get("path", "")
    full = os.path.abspath(unquote(rel))
    if os.path.isfile(full):
        return _web.FileResponse(full)
    # 鍏滃簳锛氳创鍥?缂撳啿甯稿湪妯″瀷鍚岀洰褰曠殑瀛愭枃浠跺す锛圱extures/Materials锛夛紝鎸?basename 鍦ㄧ埗鐩綍閫掑綊鎵?
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
    """鍓嶇鍦?PreviewAny 杩炴帴鏁板彉鍖栧悗 POST锛屾妸绫?RETURN_TYPES/RETURN_NAMES 鍚屾鎴愬綋鍓嶈緭鍑烘暟锛堟牎楠岀敤锛夈€?""
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
