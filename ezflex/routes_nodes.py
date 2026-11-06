"""HTTP 路由的处理函数（纯 UI 支撑层，不参与节点执行）。

分组：预设库 / ModelsCombo 模型与 LoRA 元数据 / MediaLoader 上传与浏览 / MediaOut 端口同步 /
PreviewAny 保存与目录 / PromptHelper 标签与模型列表 / 分段落盘 ezsp_* / 预处理目录 / 本机开目录。
注册位置：仍在 __init__.py 末尾的 try 块（PromptServer.instance.routes.X(...)(handler)），
本文件只提供 async 处理函数；_web = aiohttp.web 在此单独导入。
安全：涉及本机动作或路径的 handler 内部必须调 _ez_local() 收口。
"""
import base64
import asyncio
import csv
import inspect
import json
import os
import shutil
import random
import re
import struct
import time
import numpy as np
import torch
import folder_paths
import comfy.sd
import comfy.model_management
import io as _io          # ★ 标准库 io：下面 V3 的 io 是 comfy_api 的 schema 模块，会覆盖同名；标准库一律走 _io
from comfy_api.latest import io, InputImpl, Types
from .preview_nodes import (MEDIA_TO_COMFY, PreviewAnyNode, _media_kind, _media_safe, _preview_any_folders, _preview_any_fs, _preview_any_open, _preview_any_outputs, _preview_any_pick_folder, _preview_any_save_roots, _preview_any_serve_video, _preview_any_static, _pv_card_valid_names, _pv_clean_dir, _pv_delete, _pv_file_path, _pv_get_or_migrate_card, _pv_migrate_value, _pv_relocate_legacy,  _pv_store_dataurl, _pv_tag_valid_names)
from .segments_nodes import (MotionContextNode, SegmentPanelNode, SplitVideoNode, TimeLineNode, TimePlanNode, _EZPV_PREFIXES, _EZPV_SWEEP_MIN_GAP, _EZPV_TTL_SEC, _ezpv_sweep_last, _ezsp_cache_clear, _ezsp_latest_run_get, _ezsp_load_persist_file, _ezsp_load_ref_file, _ezsp_manifest_get, _ezsp_open_dir, _ezsp_pick_video, _ezsp_replace_final, _ezsp_replace_segment, _ezsp_save_persist_value, _ezsp_trim_segment, _ezsp_ver_attach_latent, _ezsp_version_set, _ezsp_versions_clear, _ezsp_versions_get)
from .prompt_nodes import (PromptHelperNode, _ph_api_hosts_get, _ph_api_hosts_post, _ph_categories_get, _ph_categories_save, _ph_clip_models, _ph_custom_delete, _ph_custom_load, _ph_custom_save, _ph_gen_card_preview, _ph_gen_get, _ph_gen_preview, _ph_gen_save, _ph_libs_get, _ph_llama_models, _ph_media_target_get, _ph_media_target_save, _ph_model_paths_get, _ph_model_paths_save, _ph_optimize, _ph_pcards_delete, _ph_pcards_get, _ph_pcards_save, _ph_pick_folder, _ph_pick_skill, _ph_preview_delete, _ph_rules_get, _ph_rules_save, _ph_scan_paths_get, _ph_scan_paths_save, _ph_scan_roots_info, _ph_tag_desc_get, _ph_tag_furry_get, _ph_tag_import, _ph_tag_kind_get, _ph_tag_lib_get, _ph_tag_nsfw_get, _ph_tag_related_get, _ph_tag_series_get, _ph_tag_zh_get, _ph_tags_get, _ph_tags_save, _ph_thumb_get)

from aiohttp import web as _web
from server import PromptServer

# 借用包根里的共享 helper（__init__.py 末尾才导入本模块，届时这些名字都已定义）
from .. import (ControlnetPreprocessorNode, EzFlexRerouteNode, LOADER_FOLDERS, MediaLoaderNode, MediaOutNode, ModelsComboLoader, ParamPresetControlNode, ParamPresetOutputNode, _EZ_OUTPUT_CAP, _ez_inside, _ez_last_dir, _ez_last_dir_set, _ez_local, _ez_real, _ez_root_add, _ez_root_paths, _ez_root_remove, _ez_root_rows, _ez_root_save, _ez_save_roots, _ez_sync_dynamic_types, _ez_write_json, _ezflex_user_dir, _ezflex_user_file, _fmt_mtime, _lora_trained_words, _mc_port_name, _ml_resolve, _ph_forget_scan_path, _ph_md_roots, _ph_media_input_dirs, _ppc_output_names, _prep_cls_of, _prep_disp_name, _prep_input_ports, _prep_output_ports, _prep_param_schema, _prep_source, _preset_file, _read_doc, _scan_cached, _sha256, parse_config)



# 单文件上传上限。ComfyUI 自己的 aiohttp 上限（--max-upload-size，默认 100 MB）会先拦一次，
# 这里是「用户把内核上限调大之后」的第二道闸；没有它，超限分支会引用不存在的名字直接 500。
_ML_UPLOAD_MAX = 4 * 1024 ** 3


_MEDIA_EXTS = (
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
    ".mp4", ".webm", ".mov", ".m4v",
)


async def _preview_handler(request):
    if not _ez_local(request):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
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
    trained = _lora_trained_words(meta)
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
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    roots = []
    for folder in _META_LOADER_FOLDERS.values():
        try:
            roots.extend(folder_paths.get_folder_paths(folder) or [])
        except Exception:
            pass
    return _web.json_response(await asyncio.to_thread(_scan_cached, ("lora_meta",), roots, _lora_meta_build))


def _lora_meta_build():
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
    return out


async def _lora_meta_detail(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
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


async def _fl_default_get(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    doc, _ = _read_doc("EzFlex-FreeLatent")
    d = doc.get("default")
    return _web.json_response(d if isinstance(d, dict) else {})


async def _fl_default_set(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    doc, presets = _read_doc("EzFlex-FreeLatent")
    doc["presets"] = presets
    if data.get("clear"):
        doc.pop("default", None)
    else:
        name = str(data.get("name") or "").strip()
        if not name:
            return _web.json_response({"error": "no name"}, status=400)
        try:
            rec = {"name": name, "width": int(data.get("width") or 0), "height": int(data.get("height") or 0),
                   "batch_size": max(1, int(data.get("batch_size") or 1))}
        except (TypeError, ValueError):
            return _web.json_response({"error": "bad size"}, status=400)
        if rec["width"] <= 0 or rec["height"] <= 0:
            return _web.json_response({"error": "bad size"}, status=400)
        doc["default"] = rec
    if not _ez_write_json(_preset_file("EzFlex-FreeLatent"), doc):
        return _web.json_response({"error": "cannot write preset file"}, status=500)
    return _web.json_response({"ok": True, "default": doc.get("default") or {}})


def _mc_output_types(loaders):
    mains = [l for l in (loaders or []) if l.get("type") != "lora"]
    out_types, out_names = [], []
    for l in mains:
        nm = _mc_port_name(l.get("name"), l.get("type"))
        if l.get("type") in ("checkpoint", "unet"):
            out_types.append("MODEL"); out_names.append(nm + "_model")
        if l.get("type") in ("checkpoint", "clip"):
            out_types.append("CLIP"); out_names.append(nm + "_clip")
        if l.get("type") in ("checkpoint", "vae"):
            out_types.append("VAE"); out_names.append(nm + "_vae")
    if loaders:   # 有加载器就常驻触发词口（无 LoRA = 空串），固定排最后
        out_types.append("STRING"); out_names.append("trigger_words")
    return out_types, out_names


_MC_FOLDERS = {"checkpoints", "diffusion_models", "unet", "text_encoders", "clip", "vae", "loras"}


_MC_COMBO = {
    "checkpoints": ("CheckpointLoaderSimple", "ckpt_name"),
    "unet": ("UNETLoader", "unet_name"),
    "diffusion_models": ("UNETLoader", "unet_name"),
    "clip": ("CLIPLoader", "clip_name"),
    "text_encoders": ("CLIPLoader", "clip_name"),
    "vae": ("VAELoader", "vae_name"),
    "loras": ("LoraLoader", "lora_name"),
}


def _mc_folder_files(folder):
    if folder not in _MC_FOLDERS:
        return []
    try:
        name = folder_paths.map_legacy(folder)
    except Exception:
        name = folder
    roots = []
    try:
        roots = list(folder_paths.get_folder_paths(name) or [])
    except Exception:
        roots = []

    def _build():
        try:
            files = folder_paths.get_filename_list(name)
            if files:
                return [str(x) for x in files]
        except Exception:
            pass
        try:
            import nodes as _nodes
            cls_name, inp = _MC_COMBO.get(folder, (None, None))
            obj = _nodes.NODE_CLASS_MAPPINGS.get(cls_name) if cls_name else None
            spec = ((obj.INPUT_TYPES().get("required") or {}) if obj else {}).get(inp)
            if isinstance(spec, (list, tuple)) and spec and isinstance(spec[0], (list, tuple)):
                return [str(x) for x in spec[0]]
        except Exception:
            pass
        return []

    return list(_scan_cached(("mc_files", name), roots, _build))


async def _mc_files(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    return _web.json_response(_mc_folder_files(str(req.query.get("folder") or "")))


async def _mc_outputs(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
        config = data.get("config", "")
        loaders = parse_config(config) if isinstance(config, str) else (config or [])
        loaders = loaders[:_EZ_OUTPUT_CAP] if isinstance(loaders, list) else []
        out_types, out_names = _mc_output_types(loaders)
        out_types = out_types[:_EZ_OUTPUT_CAP]
        out_names = [str(x)[:128] for x in out_names][:_EZ_OUTPUT_CAP]
        # 类表全局一份：只增不减，不能按当前实例精确覆写（会挤掉另一个实例的高位槽）。
        _ez_sync_dynamic_types(ModelsComboLoader, out_names)
        return _web.json_response({"ok": True, "types": out_types, "names": out_names})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


def _ppo_output_names(params):
    """按输出顺序算 ParamPresetOutput 的输出名：第 0 个固定为整组数据，其后每个激活参数一个端口。"""
    names = ["Data combo"]
    for i, p in enumerate(params or []):
        names.append((p.get("name") or "").strip() or f"Parameter {i + 1}")
    return tuple(names)


async def _ppc_outputs(req):
    """前端在分组增删/排序后 POST，把类 RETURN_TYPES/RETURN_NAMES 同步成当前端口排列（校验用）。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
        groups = data.get("groups", [])
        groups = groups[:_EZ_OUTPUT_CAP] if isinstance(groups, list) else []
        _ez_sync_dynamic_types(ParamPresetControlNode, _ppc_output_names(groups))
        return _web.json_response({"ok": True, "types": list(ParamPresetControlNode.RETURN_TYPES),
                                   "names": list(ParamPresetControlNode.RETURN_NAMES)})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ppo_outputs(req):
    """前端在连接变化/参数增删排序后 POST，把类 RETURN_TYPES/RETURN_NAMES 同步成当前参数排列（校验用）。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
        params = data.get("params", [])
        params = params[:_EZ_OUTPUT_CAP] if isinstance(params, list) else []
        _ez_sync_dynamic_types(ParamPresetOutputNode, _ppo_output_names(params))
        return _web.json_response({"ok": True, "types": list(ParamPresetOutputNode.RETURN_TYPES),
                                   "names": list(ParamPresetOutputNode.RETURN_NAMES)})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


_MEDIA_TXT_EXTS = {".txt", ".md", ".json", ".csv", ".log", ".xml", ".yaml", ".yml"}


def _file_kind(f):
    """媒体文件的真实类型：以扩展名为准（卡片里存的 type 可能是旧值/猜错的，会让端口类型不对、连不上目标输入）。"""
    if not isinstance(f, dict):
        return "other"
    by_name = _media_kind(f.get("name") or f.get("path") or "")
    if by_name != "other":
        return by_name
    return str(f.get("type") or "other").lower()


async def _ml_files(req):
    """列出 input 目录下的媒体文件（含子目录），供 MediaLoader 浏览弹窗选取。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    from urllib.parse import quote as _q
    roots = [r for r in _ph_media_input_dirs() if os.path.isdir(r)]

    def _build():
        out = []
        for root in roots:
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
        return out

    # ★ 目录扫描放线程里跑：这里可能是上万文件的 input 树（还会 stat 每个文件），
    #   同步跑会把 aiohttp 事件循环卡住，连进度推送和队列都停（2026-11 审计 P2-1）。
    return _web.json_response({"files": await asyncio.to_thread(_scan_cached, ("ml_files",), roots, _build)})


async def _ml_outputs(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
        labels = data.get("labels") or []
        labels = [str(x)[:128] for x in labels][:_EZ_OUTPUT_CAP] if isinstance(labels, list) else []
        # 全 ANY + 只增不减：换模式/重排不做类型校验，也不挤掉另一个实例的高位槽。
        _ez_sync_dynamic_types(MediaLoaderNode, labels)
        return _web.json_response({"ok": True, "names": labels})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _mo_outputs(req):
    """MediaOut 的端口清单同步：一个 list 项一个输出口，口名/类型都来自 MediaLoader 的项。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
        files = data.get("files") or []
        files = files[:_EZ_OUTPUT_CAP] if isinstance(files, list) else []
        types = [MEDIA_TO_COMFY.get(_file_kind(f), "STRING") for f in files]
        names = [str(f.get("name") or f"File {i + 1}")[:128] for i, f in enumerate(files)]
        # 全 ANY + 只增不减：拆分口不做类型校验，也不挤掉另一个实例的高位槽。
        _ez_sync_dynamic_types(MediaOutNode, names)
        return _web.json_response({"ok": True, "types": types, "names": names})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


def _ml_media_root():
    roots = _ph_media_input_dirs()
    return roots[0] if roots else ""


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


# 加载器真正读的目录以 LOADER_FOLDERS 为准，这里只补旧目录名 / 控制网
_ML_MODEL_DIRS = tuple(dict.fromkeys(list(LOADER_FOLDERS.values()) + ["unet", "clip", "clip_vision", "controlnet"]))


def _ml_model_roots():
    """模型目录（只读根）：按 ComfyUI 自己注册的目录名取，和模型组合加载器看到的完全一致。
    以前只借 PromptHelper 那份名单（没有 loras / vae / checkpoints），所以 loras 找不到。"""
    out, seen = [], set()
    for name in _ML_MODEL_DIRS:
        try:
            for r in (folder_paths.get_folder_paths(name) or []):
                if not r:
                    continue
                p = _ez_real(r)
                k = os.path.normcase(p)
                if k in seen:
                    continue
                seen.add(k)
                out.append(p)
        except Exception:
            continue
    return out


def _ml_user_roots():
    """根表里能浏览的目录（= 可删的那批；input/output 是内置根，不在表里也删不掉）。"""
    return _ez_root_paths("read")


def _ml_roots():
    """MediaLoader 文件浏览器可浏览的根：input / output + 根表里带 read 的目录
    + 内核模型目录（ModelsCombo / Controlnet 扫描用的那批，只读）。

    只返回「真实存在」的目录：注册表里残留的旧路径会让菜单出现幽灵项，而且删也删不掉。
    ★ 不再从预设/卡片里「自动发现」素材目录：那类目录不在根表里（删不掉）、也不在 _ez_roots 里
      （其实加载不了），只会在菜单里空降一批看得见吃不着的根。菜单只留三类：内置 input/output、
      各节点默认（由 ComfyUI storage 推出来）、各节点自己登记的根。
    """
    roots = list(_ml_default_roots())
    for r in _ez_root_paths("read"):
        if r not in roots:
            roots.append(r)
    # PreviewAny 的保存根也要是可浏览的根（write 位单独一行时 read 位可能为 False）
    try:
        for r in _ez_save_roots():
            if r and r not in roots:
                roots.append(r)
    except Exception:
        pass
    try:
        roots.extend(_ml_model_roots())
    except Exception:
        pass
    seen, live = set(), []
    for r in roots:
        try:
            if not r or not os.path.isdir(r):
                continue
        except Exception:
            continue
        k = os.path.normcase(r)
        if k in seen:
            continue
        seen.add(k)
        live.append(r)
    return live


def _ml_unique_name(root, name):
    """重名不覆盖：<base>_1.<ext>、<base>_2.<ext> …"""
    base, ext = os.path.splitext(name)
    cand, i = name, 1
    while os.path.exists(os.path.join(root, cand)):
        cand = f"{base}_{i}{ext}"
        i += 1
    return cand


async def _ml_upload(req):
    """接收拖拽上传的多媒体文件，保存到 ComfyUI input 目录，返回可加入素材卡片的文件描述。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        root = _ml_media_root()
        if not root:
            return _web.json_response({"error": "no input dir"}, status=500)
        from urllib.parse import quote as _q
        results = []
        post = await req.post()

        def _save_one(val):
            """一条上传落盘 + 去重。返回 (name, dest, err)；err ∈ {'', 'skip', 'too_big'}。
            ★ 整段放线程里跑：4 GB 的落盘 + 两遍整文件 sha256 会把事件循环卡住（2026-11 审计 P2-1）。"""
            name = _media_safe(val.filename)
            if not name:
                return "", "", "skip"
            if _media_kind(name) == "other" and os.path.splitext(name)[1].lower() not in _MEDIA_TXT_EXTS:
                return "", "", "skip"     # 只接收媒体/文本文件，挡掉任意后缀（.bat/.desktop/.sh/.exe 等）
            orig = name                                   # 净化后的原名（可能被 _ml_unique_name 改）
            name = _ml_unique_name(root, name)
            dest = os.path.join(root, name)
            src = val.file if hasattr(val.file, "read") else None
            if src is None:
                data = bytes(val.file)
                if len(data) > _ML_UPLOAD_MAX:
                    return "", "", "too_big"
                with open(dest, "wb") as fh:
                    fh.write(data)
            else:
                total = 0
                too_big = False
                with open(dest, "wb") as fh:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > _ML_UPLOAD_MAX:
                            too_big = True
                            break
                        fh.write(chunk)
                if too_big:
                    try:
                        os.remove(dest)
                    except OSError:
                        pass
                    return "", "", "too_big"
            # ★ 去重：名字被改成 <base>_N.<ext> 说明 input 里已经有同名文件。若内容也一样
            #   （size + sha256 都对得上），就把刚写进去的副本删掉、复用原来那个 ——
            #   否则「再点一次加载视频」会在 input 里堆一串一摸一样的文件（用户实测反馈）。
            if name != orig:
                old = os.path.join(root, orig)
                try:
                    if os.path.isfile(old) and os.path.getsize(old) == os.path.getsize(dest) \
                            and _sha256(old) == _sha256(dest):
                        os.remove(dest)
                        name, dest = orig, old
                except Exception:
                    pass
            return name, dest, ""

        for val in post.getall("files", []):
            if not (hasattr(val, "filename") and hasattr(val, "file")):
                continue
            name, dest, err = await asyncio.to_thread(_save_one, val)
            if err == "too_big":
                return _web.json_response({"error": "file too large", "limit": _ML_UPLOAD_MAX}, status=413)
            if not name:
                continue
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
    except _web.HTTPRequestEntityTooLarge:
        # aiohttp 在 req.post() 读 body 时就按 --max-upload-size（默认 100 MB）拦截；
        # 别兜成 500，前端 media_loader.js 专门按 413 提示「调大 --max-upload-size」。
        return _web.json_response({"error": "file too large", "limit": _ML_UPLOAD_MAX}, status=413)
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ml_browse(req):
    """浏览任意目录（默认 input）：返回子目录、媒体文件、父级与可用盘符。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    roots = _ml_roots()
    if not roots:
        return _web.json_response({"error": "no browsable root"}, status=400)
    want = (req.query.get("path") or "").strip() or _ml_media_root()
    path = _ez_inside(want, roots) or roots[0]      # 越界一律回落到第一个根，不报错
    if not os.path.isdir(path):
        path = roots[0]
    def _scan():
        dirs, files = [], []
        for n in os.listdir(path):
            full = os.path.join(path, n)
            try:
                if os.path.isdir(full):
                    dirs.append({"name": n, "path": full})
                else:
                    typ = _media_kind(n)
                    if typ == "other":
                        continue
                    try:
                        size = os.path.getsize(full); mtime = _fmt_mtime(os.path.getmtime(full))
                    except Exception:
                        size, mtime = 0, ""
                    files.append({"name": n, "path": full, "type": typ, "size": size, "mtime": mtime,
                                  "url": ""})
            except Exception:
                continue
        dirs.sort(key=lambda x: (x["name"] or "").lower())
        files.sort(key=lambda x: (x["name"] or "").lower())
        return dirs, files
    try:
        dirs, files = await asyncio.to_thread(_scan)   # 大目录/网络盘：别占事件循环（2026-11 审计 P2-1）
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)
    up = os.path.dirname(path)
    parent = up if (up and up != path and _ez_inside(up, roots)) else ""   # 到根目录就到底，不许再往上层爬
    inside = [r for r in roots if _ez_inside(path, [r])]
    root_of = max(inside, key=len) if inside else roots[0]   # 嵌套时用最具体的根，下拉才停在用户登记的那个
    return _web.json_response({"path": path, "parent": parent, "root": root_of, "roots": roots,
                               "mine": _ml_user_roots(), "save": _ez_save_roots(),
                               "rows": _ez_root_rows(), "builtin": _ml_default_roots(),
                               "model": _ml_model_roots(),
                               "name": os.path.basename(path) or path, "dirs": dirs, "files": files})


async def _ml_serve(req):
    """按路径流式返回本地文件（本地工具用途，仅只读须存在的文件）；相对路径按 input 目录解析。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    path = (req.query.get("path") or "").strip()
    abs_path = _ml_resolve(path)
    if not abs_path or not os.path.isfile(abs_path):
        return _web.Response(status=404, text="not found")
    try:
        # 别用「禁止缓存」：模型/图片/视频每次打开都整份重下（3D 模型最明显，几 MB 起步）。
        # no-cache = 允许存但每次协商，aiohttp 自带 ETag/Last-Modified → 文件没变就是 304，改了就立刻拿到新的。
        return _web.FileResponse(abs_path, headers={"Cache-Control": "private, no-cache"})
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
    """把素材文件另存到「可写根」里的目录（dest 由前端调 pick_folder 得到 —— 那个对话框会把目录登记成可写根）。
    只认根表里的 write 根：否则任何本机调用方都能把媒体文件写到任意可写目录。"""
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
        dest_abs = _ez_inside(dest, _ez_save_roots() + [folder_paths.get_output_directory()])
        if not dest_abs:
            return _web.json_response({"error": "dest not allowed: pick the folder first"}, status=403)
        import shutil
        # 重名不覆盖：与 _ml_upload 同款策略（<base>_1.<ext> …）。原先直接 copy2 会把同名文件静默替换掉。
        name = _ml_unique_name(dest_abs, os.path.basename(abs_))
        target = os.path.join(dest_abs, name)
        await asyncio.to_thread(shutil.copy2, abs_, target)
        return _web.json_response({"ok": True, "dest": target, "renamed": name != os.path.basename(abs_)})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ml_pick_folder(req):
    """弹 Windows 原生「选择文件夹」对话框（在线程里跑，避免阻塞事件循环并保证置顶），
    选中的目录登记为可写根（= 一次本机授权，之后 save_as / SegmentPanel / PreviewAny 都认）。仅本机客户端。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)

    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            # 起始位置 = 上次选过的目录（没有才用 input）
            base = _ez_last_dir(folder_paths.get_input_directory() if hasattr(folder_paths, "get_input_directory") else "")
            root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True); root.lift()
            path = filedialog.askdirectory(initialdir=base, title="Select save folder")
            root.destroy()
            return path
        except Exception:
            return ""
    try:
        path = await asyncio.to_thread(_pick)
        p = os.path.normpath(path) if path else ""
        if p:
            _ez_last_dir_set(p)
            _ez_root_add(p, read=True, write=True, src="medialoader")
        return _web.json_response({"ok": bool(p), "path": p})
    except Exception as e:
        return _web.json_response({"ok": False, "error": str(e)}, status=500)


async def _ml_roots_get(req):
    """根目录表（含能力位/来源）。**只对本机返回完整列表** —— 根列表属于服务端配置，
    对远端只回空（不然等于把用户登记过的敏感目录报给任意调用方）。"""
    if not _ez_local(req):
        return _web.json_response({"roots": [], "mine": [], "save": [], "rows": [], "local_only": True})
    return _web.json_response({"roots": _ml_roots(), "mine": _ml_user_roots(),
                               "save": _ez_save_roots(), "rows": _ez_root_rows(),
                               "builtin": _ml_default_roots(), "model": _ml_model_roots()})


async def _ml_roots_post(req):
    """添加/移除根目录（MediaLoader 的「根目录」页 = 根表的唯一管理界面）。只允许本机客户端。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    p = _ez_real((data.get("path") or "").strip())
    if p:
        if not os.path.isdir(p):
            return _web.json_response({"error": "not a folder: " + p}, status=400)
        if os.path.dirname(p) == p:
            return _web.json_response({"error": "a drive/filesystem root cannot be a browsable root; add a subfolder instead"}, status=400)
        if p in _ml_roots():
            return _web.json_response({"ok": True, "note": "already a root", "roots": _ml_roots(),
                                       "mine": _ml_user_roots(), "rows": _ez_root_rows(),
                                       "model": _ml_model_roots()})
        if not _ez_root_add(p, read=True, src="medialoader"):
            return _web.json_response({"error": "cannot write userdata"}, status=500)
    rm = _ez_real((data.get("remove") or "").strip())
    if rm:
        # 删一个根 = 从根表里整行移除；如果它同时是 PromptHelper 的扫描槽位，也一并清掉
        for r in _ez_root_rows():
            if r.get("scan") and os.path.normcase(_ez_real(r.get("path")) or "") == os.path.normcase(rm):
                try:
                    _ph_forget_scan_path(rm)
                except Exception:
                    pass
                break
        if not _ez_root_remove(rm):
            return _web.json_response({"error": "cannot write userdata"}, status=500)
    return _web.json_response({"ok": True, "roots": _ml_roots(), "mine": _ml_user_roots(),
                               "rows": _ez_root_rows(), "model": _ml_model_roots()})


async def _ez_reroute_outputs(req):
    """EzFlex-Reroute 端口同步：面板按当前输出口数上报 labels（每口名字），
    这里把类 RETURN_TYPES / RETURN_NAMES 同步成同样多的 ANY 口（校验与端口名用）。
    输入口数由 INPUT_TYPES 固定声明到 _EZ_REROUTE_MAX，前端只显示接了的那几个 + 1 个空槽。

    ⚠️ 走 _ez_sync_dynamic_types 的「只增不减」不变量（与 ParamPresetOutput 等一致），
    **不要**精确覆写长度 —— 类 RETURN_TYPES 全局一份，同屏多个 Reroute 口数不同时，
    精确收缩会把另一个实例的高位槽挤掉，校验时取越界报 `tuple index out of range`。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
        labels = data.get("labels") or []
        labels = [str(x)[:128] for x in labels][:_EZ_OUTPUT_CAP] if isinstance(labels, list) else []
        if not labels:
            labels = ["output_1"]
        _ez_sync_dynamic_types(EzFlexRerouteNode, labels)
        return _web.json_response({"ok": True, "names": list(labels)})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


_PREP_AIO_KEYS = {"AIO_Preprocessor"}   # 裸分类里唯一放行的工具节点
# 预处理器目录（每项都含整份 inputs/outputs/params schema，几十个节点）在运行期不会变：
# 装/卸 aux 插件、改节点定义都要重启 ComfyUI。以前每次打开面板都全量重建一遍。
_PREP_CATALOG_CACHE = None


_PREP_CAT_ZH = {
    "Line Extractors": "线稿提取",
    "Normal and Depth Estimators": "法线 / 深度",
    "Faces and Poses Estimators": "人脸 / 姿态",
    "Semantic Segmentation": "语义分割",
    "tile": "Tile 分块",
    "T2IAdapter-only": "仅 T2IAdapter",
    "Recolor": "重上色",
    "others": "其他",
    "Optical Flow": "光流",
    "Pose Keypoint Postprocess": "姿态关键点后处理",
    "AIO": "一体机（AIO）",
}


_PREP_DESC = {
    "CannyEdgePreprocessor": "经典 Canny 边缘。最通用、最稳，几乎每个 ControlNet 都有 canny 版。",
    "AnyLineArtPreprocessor_aux": "AnyLine 线稿，可跟 lineart 结果合并；参数多，适合复杂场景。",
    "BinaryPreprocessor": "二值化粗线条（阈值切），适合建筑/平面稿。",
    "DiffusionEdge_Preprocessor": "扩散模型出软边缘，比 Canny 干净、少噪点，但慢。",
    "HEDPreprocessor": "HED 软边缘，保留整体结构、线条柔和。",
    "FakeScribblePreprocessor": "HED 转涂鸦（scribble_hed），把照片变成手绘草图感。",
    "LineArtPreprocessor": "写实线稿，带 coarse 粗粒度开关。",
    "AnimeLineArtPreprocessor": "动漫线稿，专为二次元上色线稿模型准备。",
    "LineartStandardPreprocessor": "标准线稿（高斯 + 强度阈值），比 anime 版更通用。",
    "Manga2Anime_LineArt_Preprocessor": "漫画转动画线稿（lineart_anime_denoise），去网点和噪点。",
    "M-LSDPreprocessor": "M-LSD 直线检测，建筑/室内/线框类 ControlNet 的标准输入。",
    "PiDiNetPreprocessor": "PiDiNet 软边缘，质量接近 HED 但更轻。",
    "PyraCannyPreprocessor": "金字塔 Canny，粗细两层边缘叠加，比普通 Canny 更抗噪。",
    "ScribblePreprocessor": "手绘涂鸦线条（Holistically-Nested），适合 scribble ControlNet。",
    "Scribble_XDoG_Preprocessor": "XDoG 涂鸦，线条更细、更抽象。",
    "Scribble_PiDiNet_Preprocessor": "PiDiNet 版涂鸦。",
    "TEEDPreprocessor": "TEED 边缘检测，线条干净、速度快。",
    "DepthAnythingPreprocessor": "Depth Anything 相对深度，选 vitl/vitb/vits 权重。",
    "DepthAnythingV2Preprocessor": "Depth Anything V2 相对深度，细节比 V1 好。",
    "Zoe_DepthAnythingPreprocessor": "Zoe 版 Depth Anything，可切室内/室外。",
    "LeReS-DepthMapPreprocessor": "LeReS 深度图，开 boost 就是 leres++。",
    "MiDaS-DepthMapPreprocessor": "MiDaS 深度图（经典基线）。",
    "MiDaS-NormalMapPreprocessor": "MiDaS 法线图。",
    "Zoe-DepthMapPreprocessor": "Zoe 深度图，室内场景更准。",
    "Metric3D-DepthMapPreprocessor": "Metric3D 度量深度（真实尺度），可给 fx/fy。",
    "Metric3D-NormalMapPreprocessor": "Metric3D 法线图。",
    "BAE-NormalMapPreprocessor": "BAE 法线图，形状边界干净。",
    "DSINE-NormalMapPreprocessor": "DSINE 法线图，可给 fov / 迭代次数。",
    "MeshGraphormer-DepthMapPreprocessor": "MeshGraphormer 手部精修（深度 + 手部掩码）。首输出是深度图。",
    "MeshGraphormer+ImpactDetector-DepthMapPreprocessor": "同上，但用外部检测器找手（参数更多）。",
    "OpenposePreprocessor": "OpenPose 骨架，手/身/脸各自开关。首输出是骨架图。",
    "DWPreprocessor": "DWPose 骨架，比 OpenPose 更准；可选检测器/姿态模型。",
    "AnimalPosePreprocessor": "动物骨架（AP10K）。",
    "MediaPipe-FaceMeshPreprocessor": "MediaPipe 人脸网格，可限最大人脸数与置信度。",
    "DensePosePreprocessor": "DensePose 人体稠密映射，可选配色。",
    "AnimeFace_SemSegPreprocessor": "动漫人脸分割（可去背景）。首输出是分割图。",
    "OneFormer-COCO-SemSegPreprocessor": "OneFormer COCO 语义分割。",
    "OneFormer-ADE20K-SemSegPreprocessor": "OneFormer ADE20K 语义分割（室内外场景划分更细）。",
    "SemSegPreprocessor": "通用语义分割（UniFormer 的旧别名）。",
    "TilePreprocessor": "Tile 分块（金字塔上采样），配 tile ControlNet 做超分/重绘。",
    "TTPlanet_TileGF_Preprocessor": "TTPlanet Tile + 导向滤波，边缘更顺。",
    "TTPlanet_TileSimple_Preprocessor": "TTPlanet Tile 简化版。",
    "ImageLuminanceDetector": "亮度重上色（Recolor），保留原图亮度结构。",
    "ImageIntensityDetector": "强度重上色（Recolor），保留原图明暗结构。",
    "ColorPreprocessor": "色彩调色板（仅 T2IAdapter）。",
    "ShufflePreprocessor": "内容洗牌（仅 T2IAdapter），打乱结构保风格。",
    "SAMPreprocessor": "SAM 自动分割。",
    "AIO_Preprocessor": "上游的「一体机」：一个节点里用下拉选任意预处理器，但**只能调 resolution**（其余参数全取默认值）。这里把它也做成一张卡，方便你懒得为某个预处理器单开一张卡时用。",
}


def _prep_node_schema(cls):
    """catalog 用的完整 schema：{inputs, outputs, params}。"""
    return {"inputs": _prep_input_ports(cls),
            "outputs": _prep_output_ports(cls),
            "params": _prep_param_schema(cls)}


def _prep_catalog():
    """所有可用预处理器，按 CATEGORY 分组。没装 comfyui_controlnet_aux ⇒ []（不抛）。结果进程内缓存。"""
    global _PREP_CATALOG_CACHE
    if _PREP_CATALOG_CACHE is not None:
        return _PREP_CATALOG_CACHE
    try:
        mapping, _disp = _prep_source()
    except Exception:
        return []
    cats = {}
    for key, cls in mapping.items():
        cat = str(getattr(cls, "CATEGORY", "") or "")
        # 子分类（"ControlNet Preprocessors/xxx"）= 真·预处理器。
        # 裸分类 "ControlNet Preprocessors" = 上游的工具节点（Selector / ExecuteAll / AddText），
        # 只放行 **AIO_Preprocessor**。
        # ★ 现在收**全部**：不再要求「单 IMAGE 进 / 首输出 IMAGE」——
        #   多输入的（Inpaint=image+mask、MaskOptFlow）、首输出非 IMAGE 的（Unimatch=OPTICAL_FLOW,IMAGE）、
        #   吃 POSE_KEYPOINT 的（pose_keypoint_postprocess 那 5 个）统统收进来，
        #   每张卡按它**真实的输入/输出口**展开（见 _prep_input_ports / _prep_output_ports）。
        if cat.startswith("ControlNet Preprocessors/"):
            short = cat.split("/", 1)[1]
        elif cat == "ControlNet Preprocessors" and str(key) in _PREP_AIO_KEYS:
            short = "AIO"
        else:
            continue
        sch = _prep_node_schema(cls)
        if not sch["inputs"] and not sch["outputs"]:
            continue                       # 既没输入也没输出 ⇒ 无意义，跳过
        if str(key) in _PREP_AIO_KEYS:
            # AIO 的 preprocessor 下拉：value 是节点 key，显示名给人类看的名字
            for _p in sch["params"]:
                if _p.get("name") == "preprocessor" and _p.get("options"):
                    _p["optionNames"] = [_prep_disp_name(k) or k for k in _p["options"]]
        cats.setdefault(short, []).append({
            "key": str(key),
            "name": _prep_disp_name(key),
            "desc": _PREP_DESC.get(str(key), ""),
            "inputs": sch["inputs"],
            "outputs": sch["outputs"],
            "params": sch["params"],
        })
    out = []
    for short in sorted(cats):
        # label = 英文分类（跟 Add-Node 列表 / 上游一致）；中文放 labelZh 给前端当 title
        out.append({"cat": short, "label": short, "labelZh": _PREP_CAT_ZH.get(short, short),
                    "nodes": sorted(cats[short], key=lambda x: x["name"].lower())})
    if out:      # 空表（aux 还没注册好）不缓存，下次请求还能重新扫
        _PREP_CATALOG_CACHE = out
    return out


async def _prep_nodes(req):
    """预处理器目录（分类 → 节点 → 参数 schema）。前端卡片的下拉与参数面板全靠它。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        return _web.json_response({"cats": _prep_catalog()})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _prep_outputs(req):
    """前端在卡片增删/排序/改名后 POST，把类 RETURN_TYPES/RETURN_NAMES 同步成当前端口排列（校验用）。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
        names = data.get("names", [])
        names = names[:_EZ_OUTPUT_CAP] if isinstance(names, list) else []
        _ez_sync_dynamic_types(ControlnetPreprocessorNode, names)
        return _web.json_response({"ok": True, "types": list(ControlnetPreprocessorNode.RETURN_TYPES),
                                   "names": list(ControlnetPreprocessorNode.RETURN_NAMES)})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


_PREP_MODEL_DEFAULT = (("ckpts", "lllyasviel/Annotators"),)


_PREP_MODEL_DIRS = {
    "DWPosePreprocessor": (("ckpts", "yzd-v/DWPose"),),
    "AnimalPosePreprocessor": (("ckpts", "yzd-v/DWPose"),),
    "TEEDPreprocessor": (("ckpts", "bdsqlsz/qinglong_controlnet-lllite"),),
    "AnimeFace_SemSegPreprocessor": (("ckpts", "bdsqlsz/qinglong_controlnet-lllite"), ("ckpts", "skytnt/anime-seg")),
    "DensePosePreprocessor": (("ckpts", "LayerNorm/DensePose-TorchScript-with-hint-image"),),
    "MeshGraphormer-DepthMapPreprocessor": (("ckpts", "hr16/ControlNet-HandRefiner-pruned"),),
    "MeshGraphormer+ImpactDetector-DepthMapPreprocessor": (("ckpts", "hr16/ControlNet-HandRefiner-pruned"),),
    "SAMPreprocessor": (("ckpts", "dhkim2810/MobileSAM"),),
    "Unimatch_OptFlowPreprocessor": (("ckpts", "hr16/Unimatch"),),
    "Metric3D-DepthMapPreprocessor": (("ckpts", "JUGGHM/Metric3D"),),
    "Metric3D-NormalMapPreprocessor": (("ckpts", "JUGGHM/Metric3D"),),
    "DiffusionEdge_Preprocessor": (("ckpts", "hr16/Diffusion-Edge"),),
    "DSINE-NormalMapPreprocessor": (("ckpts", "hr16/Diffusion-Edge"),),
    "AnyLineArtPreprocessor_aux": (("ckpts", "TheMistoAI/MistoLine"),),
    "DepthAnythingV2Preprocessor": (
        ("hf", "depth-anything/Depth-Anything-V2-Large"),
        ("hf", "depth-anything/Depth-Anything-V2-Base"),
        ("hf", "depth-anything/Depth-Anything-V2-Small"),
        ("hf", "depth-anything/Depth-Anything-V2-Giant"),
    ),
    "DepthAnythingPreprocessor": (("hf", "LiheYoung/depth-anything-large-hf"),),
    "Zoe_DepthAnythingPreprocessor": (("hf", "Intel/zoedepth-nyu-kitti"),),
    "Zoe-DepthMapPreprocessor": (("hf", "Intel/zoedepth-nyu-kitti"),),
    "OneFormer-COCO-SemSegPreprocessor": (("hf", "shi-labs/oneformer_coco_swin_large"),),
    "OneFormer-ADE20K-SemSegPreprocessor": (("hf", "shi-labs/oneformer_ade20k_swin_large"),),
}


def _prep_ckpts_root():
    """aux 的模型根目录（跟随 AUX_ANNOTATOR_CKPTS_PATH / 插件实际位置）。拿不到 ⇒ ''。"""
    try:
        import importlib
        u = importlib.import_module("custom_controlnet_aux.util")
        return _ez_real(str(getattr(u, "annotator_ckpts_path", "") or ""))
    except Exception:
        return ""


def _prep_hf_hub_root():
    """HuggingFace 缓存根（走 transformers 的预处理器模型落这里）。"""
    try:
        from huggingface_hub import constants as _hfc
        p = _ez_real(str(getattr(_hfc, "HF_HUB_CACHE", "") or ""))
        if p:
            return p
    except Exception:
        pass
    try:
        return _ez_real(os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub"))
    except Exception:
        return ""


def _prep_model_roots():
    """允许「打开」的两个根：aux ckpts + HF 缓存。"""
    return [r for r in (_prep_ckpts_root(), _prep_hf_hub_root()) if r]


def _prep_aux_installed():
    """comfyui_controlnet_aux 是否装了（有任一 ControlNet Preprocessors 分类节点即算装了）。"""
    try:
        mapping, _d = _prep_source()
        for _k, c in (mapping or {}).items():
            if str(getattr(c, "CATEGORY", "") or "").startswith("ControlNet Preprocessors"):
                return True
    except Exception:
        pass
    return False


def _prep_model_paths(key):
    """key → 该预处理器模型可能落盘的绝对目录（按优先级）。只读固定映射，不碰请求参数。"""
    specs = _PREP_MODEL_DIRS.get(str(key), _PREP_MODEL_DEFAULT)
    ck = _prep_ckpts_root()
    hf = _prep_hf_hub_root()
    out = []
    for kind, rel in specs:
        if kind == "ckpts" and ck:
            out.append(_ez_real(os.path.join(ck, *str(rel).split("/"))))
        elif kind == "hf" and hf:
            out.append(_ez_real(os.path.join(hf, "models--" + str(rel).replace("/", "--"))))
    return [p for p in out if p]


def _prep_open_dir(path):
    """在系统文件管理器里打开目录。列表参数、无 shell、不拼接命令字符串。"""
    import subprocess
    import sys as _sys
    d = os.path.abspath(path)
    if _sys.platform.startswith("win"):
        subprocess.Popen(["explorer", d])
    elif _sys.platform == "darwin":
        subprocess.Popen(["open", d])
    else:
        subprocess.Popen(["xdg-open", d])


async def _prep_open_model(req):
    """右键卡片 →「打开模型文件夹」。★ 只收预处理器 key，不收路径（杜绝路径注入）。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    key = str((data or {}).get("cls") or "").strip()
    if not key:
        return _web.json_response({"ok": False, "reason": "no_preprocessor"})
    if not _prep_aux_installed():
        return _web.json_response({"ok": False, "reason": "aux_missing"})
    if _prep_cls_of(key) is None:
        return _web.json_response({"ok": False, "reason": "unknown_preprocessor"})
    roots = _prep_model_roots()
    cands = _prep_model_paths(key)
    if not roots or not cands:
        return _web.json_response({"ok": False, "reason": "no_root"})
    exists, target = False, ""
    for p in cands:
        if os.path.isdir(p):
            exists, target = True, p
            break
    if not target:
        p = cands[0]                      # 模型还没下：退到「最近存在的祖先目录」
        while p and not os.path.isdir(p):
            parent = os.path.dirname(p)
            if parent == p:
                break
            p = parent
        target = p
    safe = _ez_inside(target, roots)      # ★ 双保险：必须在允许根内，否则拒绝
    if not safe:
        return _web.json_response({"ok": False, "reason": "outside"})
    try:
        _prep_open_dir(safe)
    except Exception as e:
        return _web.json_response({"ok": False, "reason": "spawn_failed", "error": str(e)}, status=500)
    return _web.json_response({"ok": True, "path": safe, "exists": exists})


