"""EzFlex-PromptHelper：提示词卡片编辑、运行时优化、标签库。

职责：
  · 卡片编译/合并/循环取卡（引用媒体按各卡片的规范编译）
  · 运行时优化：api / llama / TextGenerate 三选一（三个开关互斥，同时开会报错）
  · 标签库、模型列表、卡片预览（/prompt_helper/* 的处理函数在 routes_nodes.py）
依赖包根：parse_prompt_*（卡片/优化/规则解析）、路径收口、user 目录。
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
from .preview_nodes import (MEDIA_TO_COMFY, PreviewAnyNode, _media_kind, _media_safe, _preview_any_folders, _preview_any_fs, _preview_any_open, _preview_any_outputs, _preview_any_pick_folder, _preview_any_save_roots, _preview_any_serve_video, _preview_any_static, _pv_all_valid_names, _pv_card_valid_names, _pv_clean_dir, _pv_delete, _pv_file_path, _pv_get_or_migrate_card, _pv_migrate_value, _pv_relocate_legacy,  _pv_store_dataurl, _pv_tag_valid_names)
from .segments_nodes import (MotionContextNode, SegmentPanelNode, SplitVideoNode, TimeLineNode, TimePlanNode, _EZPV_PREFIXES, _EZPV_SWEEP_MIN_GAP, _EZPV_TTL_SEC, _ezpv_sweep_last, _ezsp_cache_clear, _ezsp_latest_run_get, _ezsp_load_persist_file, _ezsp_load_ref_file, _ezsp_manifest_get, _ezsp_open_dir, _ezsp_pick_video, _ezsp_replace_final, _ezsp_replace_segment, _ezsp_save_persist_value, _ezsp_trim_segment, _ezsp_ver_attach_latent, _ezsp_version_set, _ezsp_versions_clear, _ezsp_versions_get)

from aiohttp import web as _web  # 与 __init__.py 同源（那边在 try 块里导入，这里直接引）

# 借用包根里的共享 helper（__init__.py 末尾才导入本模块，届时这些名字都已定义）
from .. import (_ANY, _USER_DIR, _ezflex_user_dir, _ez_inside, _ez_local, _ez_real, _ez_write_json, _ez_root_add, _ez_root_drop_cap_for, _ezflex_user_file, _ml_load_audio, _ml_resolve, _ph_backup_before_write, _ph_html_to_text, _ph_prompts_dir, _ph_scan_paths_file, _ph_tags_file, _scan_cached, parse_prompt_cards, parse_prompt_overall, parse_prompt_rules)


def _ph_root_index(root):
    """某个模型根目录下「文件名 -> 绝对路径」索引（缓存）；替代每次查询都 os.walk 整个根。"""
    return _scan_cached(("ph_index", os.path.normpath(root)), [root], lambda: _ph_root_index_build(root))


def _ph_root_index_build(root):
    idx = {}
    try:
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                idx.setdefault(fn, os.path.abspath(os.path.join(dirpath, fn)))
    except Exception:
        pass
    return idx


_PH_MAX_CARDS = 32


_PH_MAX_MEDIA = 16


_PH_MAX_VISION_IMAGES = 8   # 一次优化最多随请求发几张图（防止批次/视频帧把请求撑爆）


_PH_REF_WORDS = {"image": "图片", "video": "视频", "audio": "音频", "model": "模型"}   # 引用标记词回落（前端随卡片带 labels，自定义类型走它自己）


_PH_OPT_SYSTEM = (
    "You are a helpful assistant that rewrites and enhances the user's prompt for a text/image/video model. "
    "Output only the enhanced prompt. "
    "Keep every reference token such as @图片1 / @视频1 / @音频1 exactly as written: do not translate, rename, "
    "renumber, wrap in parentheses or explain them."
)


_PH_VIDEO_MAX_FRAMES = 48   # 视频解码上限（按 ~1fps 抽，覆盖约 48 秒）


_PH_VIDEO_MAX_EDGE = 512    # 视频帧最长边缩到这个尺寸，控制显存/内存


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


def _ph_compile_card(text, card):
    """自动编译只做一件事：按节点级规范的 ref 模板替换引用媒体标记
    （@图片N/@视频N/@音频N/@模型N → 该规范的写法；留空/缺键 = 原样保留）。
    时间戳与镜头号**不在自动输出里生成** —— 在「提示」气泡里按输入生成，由用户手动复制。"""
    if not text:
        return text
    rule = card.get("rule") if isinstance(card, dict) else None
    if not isinstance(rule, dict):
        return text
    ref = rule.get("ref") if isinstance(rule.get("ref"), dict) else {}
    labels = rule.get("labels") if isinstance(rule.get("labels"), dict) else {}
    for kind, tpl in ref.items():
        tpl = str(tpl or "")
        if not tpl.strip():   # 留空 = 不编译，标记原样保留
            continue
        word = str(labels.get(kind) or _PH_REF_WORDS.get(kind) or kind)
        text = re.sub("@" + re.escape(word) + r"\s*(\d+)", lambda m, t=tpl: t.replace("{n}", m.group(1)), text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def _ph_strip_thinking(generated, prompt):
    """对齐官方 TextGenerate：开 thinking 时结果里带 <think>…</think> 推理段，插件输出的是提示词，
    要把推理段去掉只留最终文本（与官方第二输出 thinking 的拆分规则一致）。"""
    reasoning, sep, text = str(generated or "").partition("</think>")
    if sep and (reasoning.lstrip().startswith("<think>") or str(prompt or "").rstrip().endswith("<think>")):
        return text
    return generated


def _ph_clip_generate(clip, prompt, tg, media=None):
    """用已连接的 text-gen CLIP 按 TextGenerate 同款参数生成文本（供 run 期内自动优化）。
    参数与官方 comfy_extras/nodes_textgen.py 的 TextGenerate 对齐：system_prompt / mtp / thinking。
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
    system_prompt = str(tg.get("system_prompt") or "").strip() if use_tpl else ""
    vkw = {"fps": vfps} if (vid is not None and vfps) else {}   # 帧率告诉编码器（Gemma4 按 fps 抽 1fps）
    tok_kwargs = {"skip_template": not use_tpl, "min_length": 1, "thinking": thinking, "image": img, "video": vid, "audio": aud, **vkw}
    if system_prompt:
        tok_kwargs["system_prompt"] = system_prompt   # 官方新增：替换模型内置 system turn（仅在用默认模板时）
    try:
        tokens = clip.tokenize(prompt, **tok_kwargs)
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
    # 官方 TextGenerate 的 mtp：off=False / auto=True / 2-5 固定草稿深度（无 MTP 权重时无副作用）。
    mtp_raw = str(tg.get("mtp") or "auto").strip().lower()
    mtp = False if mtp_raw == "off" else (int(mtp_raw) if mtp_raw in ("2", "3", "4", "5") else True)
    gen_kwargs = dict(
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
    try:
        if "mtp" in inspect.signature(clip.generate).parameters:
            gen_kwargs["mtp"] = mtp   # 旧版 ComfyUI 没这个参数：有才发，避免 TypeError
    except (TypeError, ValueError):
        pass
    gen = clip.generate(tokens, **gen_kwargs)
    return _ph_strip_thinking(clip.decode(gen), prompt)


_LLAMA_CACHE_MAX = 2


_PH_CLIP_CACHE_MAX = 4


def _ph_cache_put(cache, key, val, maxn, closer=None):
    cache[key] = val
    while len(cache) > maxn:
        oldest = next(iter(cache))
        if oldest == key:
            break
        old = cache.pop(oldest, None)
        if old is not None and closer is not None:
            try:
                closer(old)
            except Exception:
                pass


_PH_CLIP_CACHE = {}


def _ph_model_roots():
    """已登记的模型根：ComfyUI 各 models 注册目录 + 用户在「路径设置」里保存过的扫描目录。
    远端请求只允许在这些根内解析模型路径（防拿任意本地文件当模型读）。"""
    roots = []
    try:
        roots.extend(_ph_md_roots())
    except Exception:
        pass
    try:
        sp = _ph_scan_paths_load()
        for k in ("clip_root", "model_root", "mmproj_root"):
            v = str((sp.get(k) if isinstance(sp, dict) else "") or "").strip()
            if v:
                roots.append(v)
    except Exception:
        pass
    return roots


def ph_resolve_model(p, extra_roots=None, strict=False):
    """把用户填的模型路径解析为真实绝对路径（safetensors/gguf/ckpt/pt/bin），支持绝对路径、相对 models 的子路径、仅文件名。
    extra_roots 为路径设置里用户自定义的扫描目录（可多级）。
    strict=True（远端请求）时只认「已登记的模型根」：绝对路径必须落在根内，也不接受调用方另给的 extra_roots。"""
    if not p:
        return ""
    p = p.strip().strip('"').strip("'")
    if strict and extra_roots:
        extra_roots = None
    if os.path.isfile(p):
        ap = os.path.abspath(p)
        if strict and not (_ez_inside(ap, _ph_model_roots()) or _ez_inside(ap)):
            return ""
        return ap
    if not extra_roots:
        gr = _ph_global_scan_path('clip_root')
        extra_roots = [gr] if gr else None
    if strict:
        extra_roots = None
    base = os.path.basename(p)
    for root in _ph_roots_for(extra_roots):
        cand = os.path.join(root, p)
        if os.path.isfile(cand):
            return os.path.abspath(cand)
        hit = _ph_root_index(root).get(base)   # 缓存索引：不再每次查询都 os.walk 整个模型根
        if hit:
            return hit
    return ""


def _ph_file_sig(*paths):
    """(size, mtime_ns)：同名文件被替换后缓存自动失效，不用用户记得点「清理模型缓存」。"""
    out = []
    for p in paths:
        try:
            st = os.stat(p)
            out.append((int(st.st_size), int(st.st_mtime_ns)))
        except OSError:
            out.append((0, 0))
    return tuple(out)


def _ph_clip_instance(clip_path, clip_type):
    key = (clip_path, clip_type, _ph_file_sig(clip_path))
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
    _ph_cache_put(_PH_CLIP_CACHE, key, clip, _PH_CLIP_CACHE_MAX)
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


def ph_gen_unload_after():
    """生图（预览图）批次全部跑完后调用：把这一批工作流加载的 checkpoint/UNet/VAE/LoRA 真卸掉，
    并把显存还给系统。EzFlex 是绕过 ComfyUI /prompt 直接往队列里塞项，队列项 extra_data 不带
    free_memory/unload_models flag，所以内核 main.py 那套自动卸载不会触发 —— 必须自己卸。

    只在"整批跑完"后调一次（不是每张都卸），否则连续生成 N 张会反复 load/unload 反而更慢。
    先 unload_all_models() 真卸载，再 soft_empty_cache() + gc.collect() 把显存/内存真正回收。"""
    import gc
    mm = None
    try:
        import comfy.model_management as mm
    except Exception:
        mm = None
    try:
        if mm is not None:
            mm.unload_all_models()
    except Exception:
        pass
    try:
        if mm is not None:
            mm.soft_empty_cache()
    except Exception:
        pass
    # 顺带把我们自己的文本模型缓存也清掉（生图批次结束后本来也不再需要）
    for m in list(_LLAMA_CACHE.values()):
        try:
            m.close()
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
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


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
        buf = _io.BytesIO(); img.save(buf, format="PNG")
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
        img = Image.open(_io.BytesIO(base64.b64decode(str(url).split(";base64,", 1)[1])))
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


def _ph_chat_completion(url, headers, body, proxy="", timeout=90):
    """同步 OpenAI 兼容 chat/completions 请求（在线程池里跑，避免阻塞事件循环）。
    proxy 非空时走该代理（http/https），空则强制直连（忽略系统代理，默认）。"""
    import urllib.request, urllib.error, socket

    class _SafeRedirect(urllib.request.HTTPRedirectHandler):
        """重定向每一跳都重新校验允许列表：防被允许主机 302 到内网。"""
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            _ph_check_outbound(newurl)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    _ph_check_outbound(url)   # 允许列表校验（防 SSRF）：不在列表直接报错
    if proxy:
        _ph_check_outbound(proxy)   # 代理主机同样要在允许列表里（否则能拿代理打内网/本机；设置里保存一次即登记）
    data_b = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data_b, method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    try:
        if proxy:
            ph = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        else:
            ph = urllib.request.ProxyHandler({})   # 空 dict = 不使用系统代理，直连
        opener = urllib.request.build_opener(ph, _SafeRedirect())
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


_LLAMA_CACHE = {}


_PH_LLAMA_LOAD_FIELDS = {
    "n_ctx": int, "n_gpu_layers": int, "n_batch": int, "n_ubatch": int,
    "n_threads": int, "n_threads_batch": int,
    "use_mmap": bool, "use_mlock": bool, "offload_kqv": bool,
}


_PH_LLAMA_FLASH = {"auto": "AUTO", "on": "ENABLED", "off": "DISABLED"}


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
    key = (model_path, mmproj, _ph_file_sig(model_path, mmproj), tuple(sorted(load.items())), json.dumps(vision, sort_keys=True))
    if key in _LLAMA_CACHE:
        return _LLAMA_CACHE[key]
    import llama_cpp
    kw = dict(model_path=model_path, verbose=False, **load)
    if mmproj:
        kw["mmproj_path"] = mmproj
        if vision:
            kw["chat_handler_kwargs"] = vision
    llm = llama_cpp.Llama(**kw)
    _ph_cache_put(_LLAMA_CACHE, key, llm, _LLAMA_CACHE_MAX, lambda m: m.close())
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
    if provider == "OpenAI" and re.match(r"^(o\d|gpt-5|gpt-6)", str(model or "").lower()):
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
        "Zhipu GLM": "https://open.bigmodel.cn/api/paas/v4",
        "Volcengine Doubao": "https://ark.cn-beijing.volces.com/api/v3",
        "MiniMax": "https://api.minimax.chat/v1",
        "Perplexity": "https://api.perplexity.ai",
        "Cohere": "https://api.cohere.ai/compatibility/v1",
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
        # 前端拿到的是脱敏 key（S-2 B 方案）：没带 / 带的是 `****1234` → 从已存的真实 key 里取。
        # 顺序：自定义厂商存档（原有行为）→ 内置厂商的服务端副本（面板保存时上报，H-1）。
        if _ph_key_masked(api_key) or not api_key:
            api_key = (_ph_custom_key_for((data or {}).get("provider"), api_url)
                       or _ph_key_get((data or {}).get("provider"), api_url))
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
        # Anthropic Messages API 的 system 是顶层字段，必须单独带上
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
        # 本模块不 import PromptServer（搬到子模块时漏了），以前这整段是 NameError 被 except 吞掉
        from server import PromptServer
        srv = PromptServer.instance
        for a in ("last_prompt_id", "last_node_id"):
            if not hasattr(srv, a):
                setattr(srv, a, None)
    except Exception:
        pass


async def _ph_optimize(req):
    """按 method 优化提示词：api / llama 走 OpenAI 兼容 HTTP；textgen 需在执行期用已连接 CLIP。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    _ph_ensure_progress_attrs()
    try:
        import asyncio
        # 远端调用：模型路径只认已登记的根（防拿任意本地文件当模型读）；本机点击即用保持原样
        text = await asyncio.to_thread(_ph_optimize_impl, data or {})
    except ValueError as e:
        # 优化失败（空提示词 / 模型没配 / 出站主机被拒…）统一按上游错误提示
        return _web.json_response({"error": str(e)}, status=502)
    except Exception as e:
        return _web.json_response({"error": f"request failed: {e}"}, status=502)
    if (data or {}).get("clearCache"):
        ph_clear_model_cache()
    return _web.json_response({"ok": True, "text": text})


_SKILLS_ROOT_CACHE = None   # 本模块自己的全局；父包 __init__.py 里那个同名变量看不到，别再靠它
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
            p = filedialog.askopenfilename(title="Select skill file", initialdir=initial or None,
                                           filetypes=[("Markdown", "*.md"), ("All files", "*.*")])
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


_PH_BUILTIN_HOSTS = (
    "api.openai.com", "api.deepseek.com", "generativelanguage.googleapis.com", "api.anthropic.com",
    "api.siliconflow.cn", "openrouter.ai", "dashscope.aliyuncs.com", "api.moonshot.ai",
    "api.x.ai", "api.mistral.ai", "api.groq.com",
    "open.bigmodel.cn", "ark.cn-beijing.volces.com", "api.minimax.chat", "api.perplexity.ai", "api.cohere.ai",
)


def _ph_api_hosts_file():
    try:
        return _ezflex_user_file("ezflex_api_hosts.json")
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
    """出站前校验主机在允许列表里；不在就报清晰错误（不静默、不改小写匹配）。
    没有 scheme 的地址（代理常写成 127.0.0.1:7890）先补 http:// 再取 host。"""
    from urllib.parse import urlsplit as _us
    u = str(url or "").strip()
    if u and "://" not in u:
        u = "http://" + u
    try:
        parts = _us(u)
        host = (parts.hostname or "").lower()
    except Exception:
        parts, host = None, ""
    if parts is None or parts.scheme not in ("http", "https"):
        raise ValueError("only http/https outbound URLs are allowed (got " + repr(str(url))[:80] + ")")
    if not host or host not in _ph_allowed_hosts():
        raise ValueError(
            "API host " + (host or "?") + " is not in the allow-list (security restriction). "
            "Enter and save the address once in the API settings to register that host; built-in providers need no registration."
        )
    return url


def _ph_userdata_file():
    try:
        return _ezflex_user_file('ezflex_custom_providers.json')
    except Exception:
        return ''


_PH_KEY_MASK = "****"


def _ph_key_mask(k):
    """GET 一律下发脱敏后的 apiKey：后端仍然保存明文（优化调用要用），但任何接口都不再外泄。
    前端约定：拿到的值形如 `****1234`，原样提交回来 = 不改。"""
    s = str(k or "")
    if not s:
        return ""
    return (_PH_KEY_MASK + s[-4:]) if len(s) > 4 else _PH_KEY_MASK


def _ph_key_masked(k):
    s = str(k or "").strip()
    return (not s) or s.startswith(_PH_KEY_MASK)


def _ph_custom_key_for(provider, apiUrl):
    """按「厂商名/provider + apiUrl」从已存的自定义厂商里取真实 key（优化请求没带 key 时用）。"""
    fn = _ph_userdata_file()
    if not fn or not os.path.isfile(fn):
        return ""
    try:
        with open(fn, "r", encoding="utf-8") as fh:
            arr = json.loads(fh.read())
    except Exception:
        return ""
    if not isinstance(arr, list):
        return ""
    p = str(provider or "").strip().lower()
    u = str(apiUrl or "").strip().rstrip("/").lower()
    for rec in arr:
        if not isinstance(rec, dict):
            continue
        if p and p not in (str(rec.get("name") or "").strip().lower(), str(rec.get("provider") or "").strip().lower()):
            continue
        if u and u != str(rec.get("apiUrl") or "").strip().rstrip("/").lower():
            continue
        k = str(rec.get("apiKey") or "").strip()
        if k:
            return k
    return ""


def _ph_key_slot(provider, apiUrl):
    return str(provider or "").strip().lower() + "|" + str(apiUrl or "").strip().rstrip("/").lower()


def _ph_keys_load():
    fn = _ezflex_user_file("ezflex_api_keys.json")
    if not fn or not os.path.isfile(fn):
        return {}
    try:
        with open(fn, "r", encoding="utf-8") as fh:
            d = json.loads(fh.read())
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _ph_key_get(provider, apiUrl):
    """内置厂商的运行期 key：前端只在 localStorage 留 key，节点执行时读这条服务端副本。"""
    return str(_ph_keys_load().get(_ph_key_slot(provider, apiUrl)) or "")


def _ph_key_put(provider, apiUrl, apiKey):
    slot = _ph_key_slot(provider, apiUrl)
    if slot.strip("|") == "":
        return False
    d = _ph_keys_load()
    k = str(apiKey or "").strip()
    if k:
        d[slot] = k
    else:
        d.pop(slot, None)
    return _ez_write_json(_ezflex_user_file("ezflex_api_keys.json"), d)


async def _ph_api_key_post(req):
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"ok": False, "error": "bad json"}, status=400)
    try:
        ok = await asyncio.to_thread(_ph_key_put, data.get("provider"), data.get("apiUrl"), data.get("apiKey"))
    except Exception as e:
        return _web.json_response({"ok": False, "error": str(e)}, status=500)
    return _web.json_response({"ok": bool(ok)})


async def _ph_custom_load(req):
    fn = _ph_userdata_file(); arr = []
    if fn and os.path.isfile(fn):
        try:
            with open(fn, 'r', encoding='utf-8') as fh:
                arr = json.loads(fh.read())
        except Exception:
            arr = []
    if not isinstance(arr, list): arr = []
    # 无论本机还是远端，GET 一律返回脱敏 key（后端仍保存明文，优化时按需内部取用）。
    masked = []
    for rec in arr:
        if isinstance(rec, dict):
            r = dict(rec); r["apiKey"] = _ph_key_mask(rec.get("apiKey")); masked.append(r)
        else:
            masked.append(rec)
    if not _ez_local(req):
        return _web.json_response({"providers": masked, "local_only": True})
    return _web.json_response({"providers": masked})


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
        if idx >= 0:
            if _ph_key_masked(rec["apiKey"]):
                rec["apiKey"] = (arr[idx].get("apiKey") or "")   # 提交的是脱敏值 = 不改，沿用已存的真实 key
            arr[idx] = rec
        else:
            if _ph_key_masked(rec["apiKey"]):
                rec["apiKey"] = ""
            arr.append(rec)
        with open(fn, 'w', encoding='utf-8') as fh: json.dump(arr, fh, ensure_ascii=False, indent=2)
        out = [dict(x, apiKey=_ph_key_mask(x.get("apiKey"))) if isinstance(x, dict) else x for x in arr]
        return _web.json_response({"ok": True, "providers": out})
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
        out = [dict(x, apiKey=_ph_key_mask(x.get("apiKey"))) if isinstance(x, dict) else x for x in arr]
        return _web.json_response({"ok": True, "providers": out})
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
            p = filedialog.askdirectory(title="Select model scan folder")
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
    """返回当前默认扫描根目录（未设自定义路径时使用），供路径设置输入框动态显示。只对本机返回。"""
    if not _ez_local(req):
        return _web.json_response({"clip": [], "model": [], "mmproj": [], "local_only": True})
    roots = _ph_md_roots()
    return _web.json_response({"clip": roots, "model": roots, "mmproj": roots})


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
    # 只对本机返回：这些是服务端的绝对路径配置
    if not _ez_local(req):
        return _web.json_response({})
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
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)
    # 同步进统一根表：MediaLoader 的「根目录」下拉里能看到、能浏览、能删（删 = 清掉对应槽位）
    old = _ph_scan_paths_load()
    keep = {os.path.normcase(_ez_real(v) or "") for v in rec.values() if v}
    for v in old.values():
        p = _ez_real(v or "")
        if p and os.path.normcase(p) not in keep:
            _ez_root_drop_cap_for(p, "scan")
    for v in rec.values():
        if v:
            _ez_root_add(v, read=True, scan=True, src="prompthelper")
    return _web.json_response({"ok": True, "paths": rec})


def _ph_forget_scan_path(path):
    """从「路径设置」里清掉等于该目录的槽位（MediaLoader 根目录下拉里删 PrompHelper 根时调）。"""
    p = _ez_real(path)
    if not p:
        return
    fn = _ph_scan_paths_file()
    if not fn or not os.path.isfile(fn):
        return
    cur = _ph_scan_paths_load()
    hit = False
    for k in ("clip_root", "model_root", "mmproj_root"):
        if os.path.normcase(_ez_real(cur.get(k) or "") or "") == os.path.normcase(p):
            cur[k] = ""
            hit = True
    if hit:
        try:
            with open(fn, 'w', encoding='utf-8') as fh:
                json.dump(cur, fh, ensure_ascii=False, indent=2)
        except Exception:
            pass


def _ph_model_paths_file():
    return _ezflex_user_file('ezflex_model_paths.json')


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
    # 只对本机返回：模型绝对路径配置
    if not _ez_local(req):
        return _web.json_response({})
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


def _ph_media_target_file():
    return _ezflex_user_file('ezflex_media_target.json')


def _ph_media_target_load():
    fn = _ph_media_target_file()
    if not fn or not os.path.isfile(fn):
        return {}
    try:
        with open(fn, 'r', encoding='utf-8') as fh:
            d = json.loads(fh.read())
        m = d.get("mediaTarget") if isinstance(d, dict) else None
        return m if isinstance(m, dict) else {}
    except Exception:
        return {}


async def _ph_media_target_get(req):
    """引用识别设置：全局用户设置（换节点/删节点不丢）。没有敏感路径，所以不限本机读。"""
    return _web.json_response({"mediaTarget": _ph_media_target_load()})


async def _ph_media_target_save(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    m = data.get("mediaTarget")
    if not isinstance(m, dict):
        return _web.json_response({"error": "mediaTarget must be an object"}, status=400)
    fn = _ph_media_target_file()
    if not fn:
        return _web.json_response({"error": "no userdata"}, status=500)
    try:
        with open(fn, 'w', encoding='utf-8') as fh:
            json.dump({"mediaTarget": m}, fh, ensure_ascii=False, indent=2)
        return _web.json_response({"ok": True})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


def _ph_rules_file():
    return _ezflex_user_file('ezflex_prompt_rules.json')


def _ph_rules_load():
    fn = _ph_rules_file()
    if not fn or not os.path.isfile(fn):
        return {}
    try:
        with open(fn, 'r', encoding='utf-8') as fh:
            d = json.loads(fh.read())
        r = d.get("rules") if isinstance(d, dict) else None
        return r if isinstance(r, dict) else {}
    except Exception:
        return {}


async def _ph_rules_get(req):
    """引用规则设置：全局用户设置（合并分隔符 / 选中的规范 / 自定义规范 / 内置覆盖）。只对本机返回。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    return _web.json_response({"rules": _ph_rules_load()})


async def _ph_rules_save(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    r = data.get("rules")
    if not isinstance(r, dict):
        return _web.json_response({"error": "rules must be an object"}, status=400)
    fn = _ph_rules_file()
    if not fn:
        return _web.json_response({"error": "no userdata"}, status=500)
    try:
        with open(fn, 'w', encoding='utf-8') as fh:
            json.dump({"rules": r}, fh, ensure_ascii=False, indent=2)
        return _web.json_response({"ok": True})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


def _ph_prompt_categories_file():
    return _ezflex_user_file('ezflex_prompt_categories.json')


def _ph_cat_clean(items, depth=0):
    """分类树清洗：只留 {id,name,children}，名字截断、限深限宽（防止坏文件把前端撑爆）。"""
    out = []
    if depth > 6 or not isinstance(items, list):
        return out
    for it in items[:200]:
        if not isinstance(it, dict):
            continue
        name = str(it.get("name") or "").strip()[:64]
        if not name:
            continue
        cid = str(it.get("id") or "").strip()[:64] or ("c" + str(len(out) + 1))
        out.append({"id": cid, "name": name, "children": _ph_cat_clean(it.get("children"), depth + 1)})
    return out


def _ph_categories_load():
    fn = _ph_prompt_categories_file()
    if not fn or not os.path.isfile(fn):
        return []
    try:
        with open(fn, 'r', encoding='utf-8') as fh:
            d = json.loads(fh.read())
        return _ph_cat_clean(d.get("categories") if isinstance(d, dict) else None)
    except Exception:
        return []


async def _ph_categories_get(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    return _web.json_response({"categories": _ph_categories_load()})


async def _ph_categories_save(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    cats = _ph_cat_clean(data.get("categories"))
    fn = _ph_prompt_categories_file()
    if not fn:
        return _web.json_response({"error": "no userdata"}, status=500)
    try:
        with open(fn, 'w', encoding='utf-8') as fh:
            json.dump({"categories": cats}, fh, ensure_ascii=False, indent=2)
        return _web.json_response({"ok": True, "categories": cats})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


def _ph_libs_clean(libs):
    # 每个库的用户偏好：显示名 / 隐藏掉的默认标签 / 停用。CSV 文件永远不动。
    out = {}
    if not isinstance(libs, dict):
        return out
    for key, val in list(libs.items())[:200]:
        if not isinstance(val, dict):
            continue
        rec = {}
        name = str(val.get("name") or "").strip()[:64]
        if name:
            rec["name"] = name
        if val.get("disabled"):
            rec["disabled"] = True
        hid = val.get("hidden")
        if isinstance(hid, list):
            rec["hidden"] = [str(x)[:96] for x in hid[:5000] if str(x).strip()]
        grp = _ph_cat_clean(val.get("groups"))   # 库自己的分组树（用户可改，必须原样存回去）
        if grp:
            rec["groups"] = grp
        pl = val.get("place")                    # 库内那份的归类：标签名 -> 分类 id
        if isinstance(pl, dict):
            mp = {}
            for k2, v2 in list(pl.items())[:20000]:
                kk = str(k2).strip()[:96]
                vv = str(v2).strip()[:64]
                if kk and vv:
                    mp[kk] = vv
            if mp:
                rec["place"] = mp
        fav = val.get("fav")                     # 库侧的收藏（标签名数组），和我的副本分开
        if isinstance(fav, list):
            rec["fav"] = [str(x)[:96] for x in fav[:20000] if str(x).strip()]
        mt = val.get("meta")                     # 库侧那份的显示覆盖：标签名 -> {zh,color,weight}
        if isinstance(mt, dict):
            mm = {}
            for k2, v2 in list(mt.items())[:20000]:
                kk = str(k2).strip()[:96]
                if not kk or not isinstance(v2, dict):
                    continue
                e = {}
                z = str(v2.get("zh") or "").strip()[:64]
                if z:
                    e["zh"] = z
                c = str(v2.get("color") or "").strip()[:32]
                if c:
                    e["color"] = c
                w = v2.get("weight")
                if isinstance(w, (int, float)) and w:
                    e["weight"] = w
                elif isinstance(w, str) and w.strip():
                    e["weight"] = w.strip()[:32]
                if e:
                    mm[kk] = e
            if mm:
                rec["meta"] = mm
        if rec:
            out[str(key)[:64]] = rec
    return out


_PV_KINDS = ('tag', 'card')


def _ph_tags_clean(items):
    out = []
    if not isinstance(items, list):
        return out
    seen = set()
    for it in items[:10000]:
        if not isinstance(it, dict):
            continue
        name = str(it.get("name") or "").strip()[:64]
        if not name:
            continue
        tid = str(it.get("id") or "").strip()[:64]
        if not tid or tid in seen:
            # 补的 id 必须确定：不能用 hash()，它随进程变化
            base = "t" + str(len(out) + 1)
            tid, n = base, 1
            while tid in seen:
                n += 1
                tid = base + "_" + str(n)
        seen.add(tid)
        rec = {"id": tid, "name": name, "category": str(it.get("category") or "").strip()[:64]}
        # 预览图：改为独立文件存储，JSON 只留哈希短名。
        #   - 旧数据（data:image base64）在这里**惰性迁移**：落盘成文件、字段换成短名（用户无感）。
        #   - 新格式（<hash>.ext）原样保留；其它值一律丢弃。
        pv = _pv_migrate_value(name, it.get("preview"), 'tag')
        if pv:
            rec["preview"] = pv
        # 布尔字段单独处理，不走下面的 str(v)[:cap]：
        #   str(True) 会得到 "True"（类型脏），str(False) 得到 "False" 仍是 truthy，前端 !t.mine 判不出。
        for key in ("mine", "fav"):
            if it.get(key) is True:
                rec[key] = True
        for key, cap in (("from", 64), ("collectedFrom", 64), ("rec", 64), ("zh", 64), ("color", 32)):
            val = str(it.get(key) or "").strip()[:cap]
            if val:
                rec[key] = val
        weight = it.get("weight")
        if isinstance(weight, (int, float)) and 0 < float(weight) <= 5:
            rec["weight"] = round(float(weight), 2)
        out.append(rec)
    return out


def _ph_tags_load():
    fn = _ph_tags_file()
    if not fn or not os.path.isfile(fn):
        return {"categories": [], "tags": []}
    try:
        with open(fn, 'r', encoding='utf-8') as fh:
            d = json.loads(fh.read())
    except Exception:
        return {"categories": [], "tags": []}
    if not isinstance(d, dict):
        d = {}
    return {"categories": _ph_cat_clean(d.get("categories")), "tags": _ph_tags_clean(d.get("tags")), "libs": _ph_libs_clean(d.get("libs"))}


async def _ph_tags_get(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    return _web.json_response(_ph_tags_load())


async def _ph_preview_delete(req):
    """删掉某个标签/卡片对应的预览图片文件（+ 顺手回收目录里的孤儿）。
    POST {name, kind}。标签侧前端「移除预览图」不落 JSON 字段时也能立即清文件，
    否则该文件会一直留在 tag_preview/ 里（用户报过：「移除后对应图片没删掉」）。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    name = str(data.get("name") or "").strip()[:96]
    kind = str(data.get("kind") or "tag").strip().lower()
    if kind not in _PV_KINDS:
        kind = "tag"
    if not name:
        return _web.json_response({"error": "no name"}, status=400)
    _pv_delete(name, kind)
    try:
        if kind == 'card':
            _pv_clean_dir(_pv_all_valid_names(), 'card')
        else:
            _pv_clean_dir(_pv_all_valid_names(), 'tag')
    except Exception:
        pass
    return _web.json_response({"ok": True, "name": name, "kind": kind})


async def _ph_thumb_get(req):
    """预览图独立文件服务：GET /prompt_helper/thumb/<kind>/<hash>.webp
    kind = 'tag' | 'card'（缺省/未知当 'tag'，兼容旧 URL）。
    只读对应目录下的合法短名（拒绝路径穿越）。
    卡片图若还在历史共用的 tag_preview/ 里，顺手搬迁到 card_preview/ 再返回。

    只读、且文件名必须是该目录下的合法短名（`_pv_file_path` 已做穿越校验）；不再限定本机 ——
    以前远端打开时"标签面板能用、图片墙全是破图"，与同面板词库 CSV 的策略也不一致。"""
    kind = (req.match_info.get("kind") or "tag").strip().lower()
    if kind not in _PV_KINDS:
        kind = "tag"
    fname = (req.match_info.get("fname") or "").strip()
    p = _pv_file_path(fname, kind)
    if p and not os.path.isfile(p) and kind == "card":
        # 历史遗留：卡片图可能在旧的共用 tag_preview/ 里 → 搬迁后再取
        try:
            if _pv_relocate_legacy(fname, kind):
                p = _pv_file_path(fname, kind)
        except Exception:
            pass
    if not p or not os.path.isfile(p):
        return _web.json_response({"error": "not found"}, status=404)
    # ETag 用 (mtime, size)，不整文件读+SHA1：304 命中时连文件都不打开。
    try:
        _st = os.stat(p)
        etag = '"%x-%x"' % (int(_st.st_mtime_ns), int(_st.st_size))
    except OSError:
        etag = '"0-0"'
    inm = req.headers.get("If-None-Match")
    if inm and etag in [x.strip() for x in inm.split(",")]:
        return _web.Response(status=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    try:
        with open(p, 'rb') as fh:
            raw = fh.read()
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)
    ext = fname.rsplit('.', 1)[-1].lower()
    mime = {"webp": "image/webp", "png": "image/png", "jpg": "image/jpeg",
            "jpeg": "image/jpeg", "gif": "image/gif", "bmp": "image/bmp"}.get(ext, "application/octet-stream")
    try:
        import email.utils as _eu
        lm = _eu.formatdate(os.path.getmtime(p), usegmt=True)
    except Exception:
        lm = None
    hdrs = {"Cache-Control": "no-cache", "ETag": etag}
    if lm:
        hdrs["Last-Modified"] = lm
    return _web.Response(body=raw, content_type=mime, headers=hdrs)


def _ph_payload_truncated(data):
    """保存上限检查：只给前端一个提示，不改变实际写入内容（各 caps 见 _ph_tags_clean / _ph_libs_clean）。"""
    tags = (data or {}).get("tags")
    if isinstance(tags, list) and len(tags) > 10000:
        return True
    libs = (data or {}).get("libs")
    if isinstance(libs, dict):
        if len(libs) > 200:
            return True
        for val in libs.values():
            if not isinstance(val, dict):
                continue
            for k, cap in (("hidden", 5000), ("place", 20000), ("fav", 20000), ("meta", 20000)):
                v = val.get(k)
                if isinstance(v, (list, dict)) and len(v) > cap:
                    return True
    return False


async def _ph_tags_save(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    rec = {"categories": _ph_cat_clean(data.get("categories")), "tags": _ph_tags_clean(data.get("tags")), "libs": _ph_libs_clean(data.get("libs"))}
    fn = _ph_tags_file()
    if not fn:
        return _web.json_response({"error": "no userdata"}, status=500)
    # ⚠️ 空表护栏：整份覆盖写最怕前端拿了个「还没加载完/加载失败」的空状态回来保存 —— 一写就把
    #    磁盘上几百 KB 的标签连同内嵌预览图全抹了（实测发生过：live 文件被写成 tags:[]）。
    #    真要清空，前端得显式带 allowEmpty:true，避免误清。
    if not rec["tags"] and not data.get("allowEmpty"):
        try:
            cur = _ph_tags_load()
        except Exception:
            cur = {"tags": []}
        if cur.get("tags"):
            # 磁盘上有数据、这次却要写空 → 判定为坏请求，不写盘，把现状回给前端让它自愈（顺手留 .bak）。
            try:
                _ph_backup_before_write(fn)
            except Exception:
                pass
            return _web.json_response({
                "ok": False, "rejected": "empty_overwrite",
                "categories": cur["categories"], "tags": cur["tags"], "libs": cur.get("libs") or {},
            })
    try:
        _ph_backup_before_write(fn)
        with open(fn, 'w', encoding='utf-8') as fh:
            json.dump(rec, fh, ensure_ascii=False, indent=2)
        # 孤儿回收：标签目录已与卡片目录分开 → 只按「标签名」清 tag_preview/ 即可，不会误伤卡片图。
        try:
            _pv_clean_dir(_pv_all_valid_names(), 'tag')
        except Exception:
            pass
        return _web.json_response({"ok": True, "truncated": _ph_payload_truncated(data), "categories": rec["categories"], "tags": rec["tags"], "libs": rec["libs"]})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


def _ph_migrate_dir(old_dir, new_name):
    """把插件 user_data 下的目录搬到 user/EzFlex/<new_name>。

    `_ezflex_user_dir()` 会先把目标目录建出来，所以这里不能判断“目标不存在”，
    要看“目标里有没有东西”：空的就把旧目录里的内容逐个移进去。
    """
    d = _ezflex_user_dir(new_name)
    if not d or not os.path.isdir(old_dir):
        return d or old_dir
    try:
        empty = True
        try:
            empty = next(os.scandir(d), None) is None
        except OSError:
            empty = False
        if empty:
            for name in os.listdir(old_dir):
                shutil.move(os.path.join(old_dir, name), os.path.join(d, name))
            try:
                os.rmdir(old_dir)
            except OSError:
                pass
    except Exception:
        return old_dir
    return d


def _ph_seed_dir(seed_dir, new_name):
    """随插件发布的种子数据（user_data/<name>）→ user/EzFlex/<new_name>。

    用**复制**不用搬：源留在插件目录里，仓库不会出现「已删除」的工作区改动，发布包也还能带词库；
    目标已有内容时不覆盖（用户自己的库优先）。
    """
    d = _ezflex_user_dir(new_name)
    if not d or not os.path.isdir(seed_dir):
        return d or seed_dir
    try:
        if next(os.scandir(d), None) is not None:
            return d
        for name in os.listdir(seed_dir):
            src = os.path.join(seed_dir, name)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(d, name))
    except Exception:
        return d or seed_dir
    return d


_PH_LIB_DIR = _ph_seed_dir(os.path.join(_USER_DIR, "PromptHelperLib"), "taglib")
_PH_GEN_MIGRATED = _ph_migrate_dir(os.path.join(_USER_DIR, "PromptHelperGen"), "logs/gen")


_PH_LIB_ROWS = {}
_PH_LIB_ROWS_LOADED = False


def _ph_lib_rows_file():
    return os.path.join(_ezflex_user_dir("config"), "tag_lib_rows.json")


def _ph_lib_rows_load():
    """行数缓存的落盘副本：词库合计几十 MB，冷启动第一次开面板要整读一遍才能数行；
    存下来后（按 mtime 校验）重启只需 stat。"""
    global _PH_LIB_ROWS_LOADED
    if _PH_LIB_ROWS_LOADED:
        return
    _PH_LIB_ROWS_LOADED = True
    try:
        with open(_ph_lib_rows_file(), "r", encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception:
        return
    if not isinstance(d, dict):
        return
    for k, v in d.items():
        try:
            _PH_LIB_ROWS[str(k)] = (float(v[0]), int(v[1]))
        except Exception:
            continue


def _ph_lib_rows_save():
    try:
        fn = _ph_lib_rows_file()
        tmp = fn + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({k: [v[0], v[1]] for k, v in _PH_LIB_ROWS.items()}, fh)
        os.replace(tmp, fn)
    except Exception:
        pass


def _ph_lib_files():
    try:
        os.makedirs(_PH_LIB_DIR, exist_ok=True)
    except Exception:
        pass
    out = []
    try:
        names = sorted(os.listdir(_PH_LIB_DIR))
    except OSError:
        return out
    for name in names:
        if not name.lower().endswith('.csv'):
            continue
        stem = name[:-4]
        if stem.startswith('_') or stem.lower().startswith('zh'):
            continue
        fp = os.path.join(_PH_LIB_DIR, name)
        if os.path.isfile(fp):
            out.append((stem, fp))
    return out


def _ph_lib_stat(fp):
    """(行数, 字节数)；按 mtime 缓存（内存 + 落盘），免得每次开面板/重启都重读几十 MB。"""
    try:
        mt = os.path.getmtime(fp)
        size = os.path.getsize(fp)
    except OSError:
        return 0, 0
    _ph_lib_rows_load()
    hit = _PH_LIB_ROWS.get(fp)
    if hit and hit[0] == mt:
        return hit[1], size
    try:
        with open(fp, 'rb') as fh:
            rows = sum(chunk.count(b'\n') for chunk in iter(lambda: fh.read(1 << 20), b''))
    except OSError:
        return 0, size
    _PH_LIB_ROWS[fp] = (mt, rows)
    _ph_lib_rows_save()
    return rows, size


async def _ph_libs_get(req):
    def _build():
        libs = []
        for sid, fp in _ph_lib_files():
            rows, size = _ph_lib_stat(fp)
            libs.append({"id": sid, "rows": rows, "size": size})
        return libs
    # 首次会把 17 个 CSV（约 55 MB / 178 万行）数一遍行数：同步跑会把事件循环卡住 0.3 s
    # 以上（2026-11 复检 P-12）。后续命中磁盘缓存，走的也是线程，开销可忽略。
    return _web.json_response({"libs": await asyncio.to_thread(_build)})


async def _ph_tag_lib_get(req):
    lib_id = (req.query.get('id') or '').strip()
    for sid, fp in _ph_lib_files():
        if sid == lib_id:
            return _web.FileResponse(fp, headers={"Cache-Control": "no-store"})
    return _web.json_response({"error": "unknown tag library"}, status=404)


async def _ph_tag_zh_get(req):
    fp = os.path.join(_PH_LIB_DIR, '_zh_CN.csv')
    if not os.path.isfile(fp):
        return _web.json_response({"error": "no zh dictionary"}, status=404)
    return _web.FileResponse(fp, headers={"Cache-Control": "no-store"})


async def _ph_tag_kind_get(req):
    """细分分类词表 _tag_kind.csv（tag,kind：person/clothing/expression/sex/scene/camera/object/style）。"""
    fp = os.path.join(_PH_LIB_DIR, '_tag_kind.csv')
    if not os.path.isfile(fp):
        return _web.json_response({"error": "no tag kind table"}, status=404)
    return _web.FileResponse(fp, headers={"Cache-Control": "no-store"})


async def _ph_tag_related_get(req):
    """相关标签表 _related.csv（tag,相关1,相关2,…），卡片右键菜单与悬停提示用。"""
    fp = os.path.join(_PH_LIB_DIR, '_related.csv')
    if not os.path.isfile(fp):
        return _web.json_response({"error": "no related tags table"}, status=404)
    return _web.FileResponse(fp, headers={"Cache-Control": "no-store"})


async def _ph_tag_nsfw_get(req):
    """NSFW 标签表 _nsfw.csv（一行一个），面板「隐藏 NSFW」筛选用。"""
    fp = os.path.join(_PH_LIB_DIR, '_nsfw.csv')
    if not os.path.isfile(fp):
        return _web.json_response({"error": "no nsfw table"}, status=404)
    return _web.FileResponse(fp, headers={"Cache-Control": "no-store"})


async def _ph_tag_desc_get(req):
    """标签中文短描述 _tag_desc.csv（tag,desc），卡片悬停显示。"""
    fp = os.path.join(_PH_LIB_DIR, '_tag_desc.csv')
    if not os.path.isfile(fp):
        return _web.json_response({"error": "no tag descriptions"}, status=404)
    return _web.FileResponse(fp, headers={"Cache-Control": "no-store"})


async def _ph_tag_series_get(req):
    """角色→系列表 _char_series.csv（character,copyright,score），供标签面板「系列」分组筛选。"""
    fp = os.path.join(_PH_LIB_DIR, '_char_series.csv')
    if not os.path.isfile(fp):
        return _web.json_response({"error": "no character-series table"}, status=404)
    return _web.FileResponse(fp, headers={"Cache-Control": "no-store"})


async def _ph_tag_furry_get(req):
    """兽类/物种词表：_e621_species.csv（e621 分类 5 的物种，去掉 Danbooru 已有的）+ _furry_extra.csv（可自己加）。"""
    names = []
    for name in ('_e621_species.csv', '_furry_extra.csv'):
        fp = os.path.join(_PH_LIB_DIR, name)
        if not os.path.isfile(fp):
            continue
        try:
            with open(fp, 'r', encoding='utf-8-sig') as fh:
                names.extend(ln.strip() for ln in fh if ln.strip() and not ln.lstrip().startswith('#'))
        except OSError:
            continue
    return _web.Response(text='\n'.join(names), content_type='text/plain', headers={"Cache-Control": "no-store"})


def _ph_import_rows(text, name):
    """把导入文件解析成 [(name, second)]：csV/tsv/txt 按列、json 按字段、sql 抽 VALUES。"""
    ext = os.path.splitext(name.lower())[1]
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    rows = []
    if ext == '.sql':
        for m in re.finditer(r"VALUES\s*\(([^)]*)\)", text, re.I):
            cells = next(csv.reader([m.group(1)]), [])
            nm = (cells[0] if cells else '').strip()
            if nm:
                rows.append((nm, (cells[2] if len(cells) > 2 else '').strip()))
        return rows
    if ext == '.json':
        try:
            d = json.loads(text)
        except Exception:
            return []
        items = d.get('tags') if isinstance(d, dict) else d
        if not isinstance(items, list):
            return []
        for it in items:
            if isinstance(it, str):
                rows.append((it.strip(), ''))
            elif isinstance(it, dict):
                nm = str(it.get('name') or it.get('tag') or it.get('text') or '').strip()
                if nm:
                    rows.append((nm, str(it.get('translate') or it.get('zh') or it.get('category') or it.get('cat') or '')))
        return rows
    first = text.split('\n')[0] if text else ''
    sep = '\t' if (ext == '.tsv' or ('\t' in first and ',' not in first)) else ','
    for ln in text.split('\n'):
        if not ln.strip() or ln.lstrip().startswith('#'):
            continue
        cells = next(csv.reader([ln], delimiter=sep), [])
        nm = (cells[0] if cells else '').strip()
        if nm:
            rows.append((nm, (cells[1] if len(cells) > 1 else '').strip()))
    return rows


def _ph_import_is_zh(rows):
    """第 2 列大面积是汉字 → 当成中英对照表（并进 _zh_CN.csv），否则当标签库。"""
    if len(rows) < 5:
        return False
    cjk = re.compile(u'[\u4e00-\u9fff]')
    sample = rows[:200]
    return sum(1 for r in sample if cjk.search(r[1] or '')) >= len(sample) * 0.6


def _ph_import_zh(rows):
    fp = os.path.join(_PH_LIB_DIR, '_zh_CN.csv')
    cur = {}
    if os.path.isfile(fp):
        try:
            with open(fp, 'r', encoding='utf-8-sig') as fh:
                for _ln, r in enumerate(csv.reader(fh)):
                    if len(r) < 2:
                        continue
                    a, b = r[0].strip(), r[1].strip()
                    # 表头不是词条：以前会把 "tag,zh" 当成「tag 的中文是 zh」写进词典
                    if _ln == 0 and a.lower() in ('tag', 'tags', 'name', 'label', '标签') \
                            and b.lower() in ('zh', 'cn', 'chinese', '中文', 'translation'):
                        continue
                    if a and not a.lstrip().startswith('#'):
                        cur[a] = b
        except OSError:
            pass
    for r in rows:
        nm = r[0].strip()
        if nm and r[1].strip():
            cur[nm] = r[1].strip()
    os.makedirs(_PH_LIB_DIR, exist_ok=True)
    _ph_backup_before_write(fp)          # 10 MB / 30 万行的词典：写坏了没有 .bak 就找不回来
    tmp = fp + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8-sig', newline='') as fh:
            w = csv.writer(fh)
            w.writerow(['tag', 'zh'])
            for nm in sorted(cur):
                w.writerow([nm, cur[nm]])
        os.replace(tmp, fp)
    except OSError:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except OSError:
            pass
        raise
    return len(cur)


async def _ph_tag_import(req):
    """导入标签库：csv / tsv / txt / json / sql 自动识别；中英对照表并进 _zh_CN.csv。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    name = str(data.get("name") or "import").strip()[:120]
    text = str(data.get("text") or "")
    if len(text) > 64 * 1024 * 1024:
        return _web.json_response({"error": "file too large"}, status=413)
    rows = _ph_import_rows(text, name)
    if not rows:
        return _web.json_response({"error": "no tags found (csv / tsv / txt / json / sql)"}, status=400)
    if _ph_import_is_zh(rows):
        try:
            total = _ph_import_zh(rows)
        except OSError as e:
            return _web.json_response({"error": "cannot write zh dictionary: %s" % e}, status=500)
        return _web.json_response({"ok": True, "kind": "zh", "rows": total})
    lib_id = re.sub(r'[^\w\u4e00-\u9fff.-]+', '_', os.path.splitext(name)[0]).strip('_')[:60] or "import"
    if lib_id.startswith('_') or lib_id.lower().startswith('zh'):
        lib_id = "lib_" + lib_id.lstrip('_')
    fp = os.path.join(_PH_LIB_DIR, lib_id + '.csv')
    os.makedirs(_PH_LIB_DIR, exist_ok=True)
    with open(fp, 'w', encoding='utf-8-sig', newline='') as fh:
        w = csv.writer(fh)
        for nm, second in rows:
            cat = second if re.fullmatch(r'-?\d+', second) else '0'
            w.writerow([nm, cat, '0', ''])
    _PH_LIB_ROWS.pop(fp, None)
    return _web.json_response({"ok": True, "kind": "lib", "id": lib_id, "rows": len(rows)})


def _ph_prompt_card_file(name):
    """名称 → user/EzFlex/prompts/<名称>.json；含路径分隔符/通配符/隐藏名一律拒绝，并确认仍落在该目录内。"""
    d = _ph_prompts_dir()
    name = str(name or "").strip()
    if not d or not name or len(name) > 64 or name.startswith('.') or any(c in name for c in '\\/:*?"<>|'):
        return ''
    fn = os.path.join(d, name + '.json')
    if os.path.realpath(os.path.dirname(fn)) != os.path.realpath(d):
        return ''
    return fn


async def _ph_pcards_get(req):
    """带 name = 读取一份保存的提示词卡片/卡片组；不带 name = 已保存清单（含分类与类型）。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
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
        if not isinstance(rec, dict):
            rec = {}
        cards = rec.get("cards")
        # 旧卡片文件里 preview 还是 base64 → GET 时惰性迁移成短名（写回文件，用户无感）
        pv = _pv_get_or_migrate_card(name, fn, rec)
        return _web.json_response({"name": name, "cards": cards if isinstance(cards, list) else [],
                                   "kind": str(rec.get("kind") or "card"), "category": str(rec.get("category") or ""),
                                   "preview": pv})
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
            if not isinstance(rec, dict):
                rec = {}
            cards = rec.get("cards")
            nm = fn[:-5]
            pv = _pv_get_or_migrate_card(nm, os.path.join(d, fn), rec)
            out.append({"name": nm, "count": len(cards) if isinstance(cards, list) else 0,
                        "kind": str(rec.get("kind") or "card"), "category": str(rec.get("category") or ""),
                        "preview": pv})
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
    category = data.get("category")
    category = (str(category).strip()[:200] if category is not None else None)   # 缺省 = 不改分类（只改预览图时别把分类冲掉）
    kind_in = str(data.get("kind") or "").strip()
    fn = _ph_prompt_card_file(name)
    if not fn:
        return _web.json_response({"error": 'invalid name: must not contain \\ / : * ? " < > | , must not start with a dot, max 64 characters'}, status=400)
    # 预览图：传入可能是「data:image base64（新加的图）」或「已存在的哈希短名（只改别的字段时带回）」。
    # 统一走 _pv_migrate_value：base64 → 落盘成文件并换短名；短名 → 原样；其它 → 空。
    preview_in = _pv_migrate_value(name, data.get("preview"), 'card')
    remove_preview = bool(data.get("removePreview"))
    if isinstance(cards, list) and cards:
        rec = {"name": name, "cards": cards, "kind": kind_in if kind_in in ("card", "group") else "card", "category": category or ""}
        # 只改卡片内容时这里会重建 rec：把原文件里已有的预览图带回来（前端保存卡片不传 preview，不然一存就没图）
        if not preview_in and os.path.isfile(fn):
            try:
                with open(fn, 'r', encoding='utf-8') as fh:
                    prev = json.loads(fh.read())
                if isinstance(prev, dict):
                    preview_in = _pv_migrate_value(name, prev.get("preview"), 'card')
            except Exception:
                pass
        if preview_in:
            rec["preview"] = preview_in
    else:
        # 没带卡片 = 只改分类/类型（移动已保存的卡片/卡片组）：原文件必须在
        if not os.path.isfile(fn):
            return _web.json_response({"error": "no card selected to save"}, status=400)
        try:
            with open(fn, 'r', encoding='utf-8') as fh:
                rec = json.loads(fh.read())
        except Exception:
            rec = {}
        if not isinstance(rec, dict):
            rec = {}
        rec["name"] = name
        if category is not None:
            rec["category"] = category
        if preview_in:
            rec["preview"] = preview_in
        elif isinstance(rec.get("preview"), str):
            # 旧文件里还是 base64 → 顺手迁移成短名
            rec["preview"] = _pv_migrate_value(name, rec.get("preview"), 'card') or rec.pop("preview", None)
        if kind_in in ("card", "group"):
            rec["kind"] = kind_in
        else:
            rec["kind"] = str(rec.get("kind") or "card")
    if remove_preview:
        rec.pop("preview", None)
        _pv_delete(name, 'card')
    try:
        _ph_backup_before_write(fn)
        with open(fn, 'w', encoding='utf-8') as fh:
            json.dump(rec, fh, ensure_ascii=False, indent=2)
        # 孤儿回收：卡片目录里没被任何卡片引用的图删掉（移除预览后旧图不会残留）
        if remove_preview:
            try:
                _pv_clean_dir(_pv_all_valid_names(), 'card')
            except Exception:
                pass
        return _web.json_response({"ok": True, "name": name, "count": len(rec.get("cards") or [])})
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
        _pv_delete(name, 'card')          # 顺手删掉该卡片的预览文件
        return _web.json_response({"ok": True})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _ph_api_hosts_get(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
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


_PGEN_DEFAULT = {
    "api": "",          # 工作流 api.json 的文本（前端导入）
    "ckpt": "", "unet": "", "clip": "", "vae": "", "lora": "", "builtinMode": "ckpt",
    "width": 512, "height": 512, "steps": 20, "cfg": 6,
    "sampler": "euler", "scheduler": "simple", "batch": 1,
    "seedMode": "random", "seed": 0,
    "positive": "masterpiece, best quality, vibrant, very aesthetic, high contrast, highly detailed, absurdres,", "negative": "lowres, worst quality, low quality, bad anatomy, bad proportions, signature, watermark, patreon, artist name, twitter username, simple background, borders",
    "format": "webp", "quality": 80, "size": 384,
    "unloadAfter": True,   # 生成预览图整批结束后卸载模型、还显存（默认开，防止连生几张后爆显存/变卡）
}


def _ph_gen_file():
    d = _ph_migrate_dir(os.path.join(_USER_DIR, "PromptHelperGen"), "logs/gen")
    return os.path.join(d, "settings.json")


def _ph_gen_clean(data):
    out = dict(_PGEN_DEFAULT)
    if isinstance(data, dict):
        for k in _PGEN_DEFAULT:
            if k not in data:
                continue
            v = data[k]
            if k in ("width", "height", "steps", "batch", "seed", "quality", "size"):
                try:
                    out[k] = int(v)
                except (TypeError, ValueError):
                    pass
            elif k == "cfg":
                try:
                    out[k] = float(v)
                except (TypeError, ValueError):
                    pass
            elif k in ("seedMode", "format"):
                out[k] = str(v)[:16]
            elif k == "unloadAfter":
                out[k] = bool(v) if not isinstance(v, str) else (v.strip().lower() not in ("0", "false", "no", "off", ""))
            elif k == "api":
                out[k] = str(v)[:2 * 1024 * 1024]
            else:
                out[k] = str(v)[:4096]
    return out


def _ph_gen_load():
    fn = _ph_gen_file()
    try:
        with open(fn, "r", encoding="utf-8-sig") as fh:
            return _ph_gen_clean(json.load(fh))
    except Exception:
        return dict(_PGEN_DEFAULT)


async def _ph_gen_get(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    return _web.json_response({"ok": True, "settings": _ph_gen_load()})


async def _ph_gen_save(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    rec = _ph_gen_clean(data.get("settings") if isinstance(data, dict) else None)
    fn = _ph_gen_file()
    os.makedirs(os.path.dirname(fn), exist_ok=True)
    with open(fn, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, ensure_ascii=False, indent=2)
    return _web.json_response({"ok": True, "settings": rec})


def _ph_gen_patch(prompt, cfg, pos_text, neg_text, seed):
    """按输入名通用注入：工作流里叫 width/height/steps/cfg/... 的输入一律改写。
    正负提示词通过 KSampler 的 positive/negative 连线找到对应的 CLIPTextEncode。"""
    repl = {
        "width": cfg["width"], "height": cfg["height"], "batch_size": cfg["batch"],
        "steps": cfg["steps"], "cfg": cfg["cfg"],
        "sampler_name": cfg["sampler"], "scheduler": cfg["scheduler"],
        "seed": seed, "noise_seed": seed,
    }
    if cfg.get("ckpt"):
        repl["ckpt_name"] = cfg["ckpt"]
    if cfg.get("clip"):
        repl["clip_name"] = cfg["clip"]
    if cfg.get("vae"):
        repl["vae_name"] = cfg["vae"]
    if cfg.get("unet"):                      # 分离式加载：UNETLoader
        repl["unet_name"] = cfg["unet"]
    if cfg.get("lora"):                      # LoraLoader
        repl["lora_name"] = cfg["lora"]
    pos_ids, neg_ids = set(), set()
    for node in prompt.values():
        ct = str(node.get("class_type") or "")
        if "KSampler" not in ct:
            continue
        for key, sink in (("positive", pos_ids), ("negative", neg_ids)):
            ref = node.get("inputs", {}).get(key)
            if isinstance(ref, list) and ref and str(ref[0]) in prompt:
                sink.add(str(ref[0]))
    for nid, node in prompt.items():
        ct = str(node.get("class_type") or "")
        ins = node.get("inputs")
        if not isinstance(ins, dict):
            continue
        for k in list(ins.keys()):
            if k in repl:
                ins[k] = repl[k]
        if "text" in ins and isinstance(ins["text"], str):
            if str(nid) in neg_ids:
                ins["text"] = neg_text
            elif str(nid) in pos_ids:
                ins["text"] = pos_text
        if ct == "CLIPTextEncode" and "text" in ins and isinstance(ins["text"], str):
            low = ins["text"].lower()
            if ("worst quality" in low or "low quality" in low) and str(nid) not in pos_ids:
                ins["text"] = neg_text
    return prompt


def _ph_gen_run_one(name, cfg):
    """跑一张：返回 (data_url, None) 或 (None, 错误信息)"""
    try:
        prompt = json.loads(cfg.get("api") or "")
    except Exception:
        return None, "api.json 不是合法 JSON（先在生图设置里导入工作流）"
    if not isinstance(prompt, dict) or not prompt:
        return None, "没有工作流：先在生图设置里导入 api.json"
    if not all(isinstance(v, dict) and v.get("class_type") for v in prompt.values()):
        return None, "不是 API 格式的工作流：要用 ComfyUI「导出(API格式)」的那份 json"
    try:
        import folder_paths
        import server as _srv
        import uuid as _uuid
    except Exception as e:
        return None, f"无法加载 ComfyUI 服务模块: {e}"
    seed = cfg["seed"]
    if cfg.get("seedMode") == "random" or not seed:
        seed = random.randint(0, 2 ** 31 - 1)
    pos = (cfg.get("positive") or "").strip()
    neg = (cfg.get("negative") or "").strip()
    pos = (pos + " " + name).strip() if pos else name
    prompt = _ph_gen_patch(prompt, cfg, pos, neg, int(seed))
    pid = str(_uuid.uuid4())
    srv = _srv.PromptServer.instance
    try:
        # 必须和 ComfyUI /prompt 的队列项同形：(number, prompt_id, prompt, extra_data, outputs, sensitive)
        # 少一个元素会在 prompt_worker 的 item[5] 处 IndexError，把执行线程整个弄死（之后所有任务都不再执行）
        srv.prompt_queue.put((-1, pid, prompt, {"client_id": getattr(srv, "client_id", "")}, list(prompt.keys()), {}))
    except Exception as e:
        return None, f"排队失败: {e}"
    import time as _time
    deadline = _time.time() + 180
    hist = None
    while _time.time() < deadline:
        _time.sleep(0.4)
        try:
            h = srv.prompt_queue.get_history(pid)
        except Exception:
            h = None
        if h and pid in h:
            hist = h[pid]
            break
    if not hist:
        return None, "生成超时（180s）或工作流报错"
    img = None
    for out in (hist.get("outputs") or {}).values():
        for it in (out.get("images") or []):
            if str(it.get("filename", "")).lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                img = it
                break
        if img:
            break
    if not img:
        return None, "工作流没有输出图片"
    kind = img.get("type") or "output"
    base = folder_paths.get_temp_directory() if kind == "temp" else folder_paths.get_output_directory()
    path = os.path.join(base, img.get("subfolder") or "", img.get("filename") or "")
    try:
        from PIL import Image
        im = Image.open(path).convert("RGB")
        side = max(64, min(1024, int(cfg.get("size") or 384)))
        im.thumbnail((side, side))
        import io as _io
        buf = _io.BytesIO()
        fmt = "WEBP" if str(cfg.get("format") or "webp").lower() == "webp" else "PNG"
        if fmt == "WEBP":
            im.save(buf, format="WEBP", quality=max(40, min(95, int(cfg.get("quality") or 85))), method=4)
            mime = "image/webp"
        else:
            im.save(buf, format="PNG")
            mime = "image/png"
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:{mime};base64,{b64}", None
    except Exception as e:
        return None, f"读取/压缩生成图失败: {e}"


def _ph_card_prompt(rec):
    """已保存的卡片/卡片组 → 一段用于生图的提示词（合=灰的卡不并，和运行期合并同口径）。"""
    cards = rec.get("cards") if isinstance(rec, dict) else None
    parts = []
    for c in (cards or []):
        if not isinstance(c, dict) or c.get("mergeOff"):
            continue
        t = str(c.get("content") or "").strip() or _ph_html_to_text(c.get("contentHTML") or "").strip()
        if t:
            parts.append(_ph_compile_card(t, c))
    return ", ".join(parts)


async def _ph_gen_card_preview(req):
    """给已保存的卡片/卡片组生成预览图：用同一套生图设置，按卡片正文拼提示词，成功后直接写回卡片文件。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    names = [str(x)[:64] for x in (data.get("names") or []) if str(x).strip()][:32]
    if not names:
        return _web.json_response({"error": "no cards"}, status=400)
    cfg = _ph_gen_load()
    if isinstance(data.get("settings"), dict):
        cfg = _ph_gen_clean({**cfg, **data["settings"]})
    out = {}
    err = None
    import asyncio
    try:
        for nm in names:
            fn = _ph_prompt_card_file(nm)
            if not fn or not os.path.isfile(fn):
                err = "no saved card named " + nm
                break
            try:
                with open(fn, 'r', encoding='utf-8') as fh:
                    rec = json.loads(fh.read())
            except Exception as e:
                err = str(e)
                break
            if not isinstance(rec, dict):
                rec = {}
            text = _ph_card_prompt(rec)
            if not text.strip():
                err = "card has no prompt content: " + nm
                break
            url, e = await asyncio.to_thread(_ph_gen_run_one, text, cfg)
            if not url:
                err = e
                break
            # 生图返回 base64 → 立刻落盘成独立文件（card_preview/），卡片里只存短名（不再内嵌）
            short = _pv_store_dataurl(nm, url, 'card') or _pv_migrate_value(nm, url, 'card')
            if not short:
                err = "preview write failed"
                break
            rec["preview"] = short
            try:
                with open(fn, 'w', encoding='utf-8') as fh:
                    json.dump(rec, fh, ensure_ascii=False, indent=2)
            except Exception as e:
                err = str(e)
                break
            out[nm] = short
    finally:
        # 整批跑完（含出错/超时提前 break）后统一卸模型、还显存：否则连续生成几张会累积占用显存直到卡死
        if cfg.get("unloadAfter", True):
            try:
                await asyncio.to_thread(ph_gen_unload_after)
            except Exception:
                pass
    return _web.json_response({"ok": bool(out), "previews": out, "error": err})


async def _ph_gen_preview(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        return _web.json_response({"error": "bad json"}, status=400)
    names = [str(x)[:96] for x in (data.get("names") or []) if str(x).strip()][:32]
    if not names:
        return _web.json_response({"error": "no tags"}, status=400)
    cfg = _ph_gen_load()
    if isinstance(data.get("settings"), dict):
        cfg = _ph_gen_clean({**cfg, **data["settings"]})
    out = {}
    err = None
    import asyncio
    try:
        for nm in names:
            url, e = await asyncio.to_thread(_ph_gen_run_one, nm, cfg)
            if url:
                # 生图返回 base64 → 落盘成独立文件（tag_preview/），只回短名给前端（前端把它塞进 tag.preview 再保存）
                short = _pv_store_dataurl(nm, url, 'tag') or _pv_migrate_value(nm, url, 'tag')
                if short:
                    out[nm] = short
                else:
                    err = "preview write failed: " + nm
                    break
            else:
                err = e
                break
    finally:
        # 标签系统预览：整批结束后同样卸模型、还显存
        if cfg.get("unloadAfter", True):
            try:
                await asyncio.to_thread(ph_gen_unload_after)
            except Exception:
                pass
    return _web.json_response({"ok": bool(out), "previews": out, "error": err})


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


def _ph_resolve_gguf(p, extra_roots=None, strict=False):
    """把用户填的 GGUF 路径解析为真实绝对路径：支持绝对路径、相对任一 models/LLM 根的子路径、仅文件名。找不到返回 ''。
    extra_roots 为路径设置里用户自定义的扫描目录（可多级）。
    strict=True（远端请求）时只认「已登记的模型根」（同 ph_resolve_model）。"""
    if not p:
        return ""
    p = p.strip().strip('"').strip("'")
    if strict and extra_roots:
        extra_roots = None
    if os.path.isfile(p):
        ap = os.path.abspath(p)
        if strict and not (_ez_inside(ap, _ph_model_roots()) or _ez_inside(ap)):
            return ""
        return ap
    if strict:
        extra_roots = None
    base = os.path.basename(p)
    for root in _ph_roots_for(extra_roots):
        cand = os.path.join(root, p)
        if os.path.isfile(cand):
            return os.path.abspath(cand)
        hit = _ph_root_index(root).get(base)   # 缓存索引：不再每次查询都 os.walk 整个模型根
        if hit:
            return hit
    return ""


async def _ph_llama_models(req):
    """列出共享 models 文件夹下所有 .gguf（相对每个根目录的路径），供前端像选模型一样选取。
    ?root= 为路径设置里自定义的扫描目录（优先，替换默认）。"""
    root_q = (req.query.get("root") or "").strip()
    if root_q and not _ez_local(req):
        root_q = ""   # 远端不能指定扫描根（否则能拿它递归遍历任意目录）；回落默认 models 根
    roots = [r for r in _ph_scan_roots(root_q) if os.path.isdir(r)]

    def _build():
        seen = set()
        out = []
        for root in roots:
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
        return out

    return _web.json_response({"models": _scan_cached(("ph_llama", root_q), roots, _build)})


async def _ph_clip_models(req):
    """列出共享/实例 models 下的 .safetensors/.ckpt/.pt 等文本编码器文件，供 TextGenerate 选 CLIP 模型。
    ?root= 为路径设置里自定义的扫描目录（优先，替换默认）。"""
    root_q = (req.query.get("root") or "").strip()
    if root_q and not _ez_local(req):
        root_q = ""   # 远端不能指定扫描根（否则能拿它递归遍历任意目录）；回落默认 models 根
    roots = [r for r in _ph_scan_roots(root_q) if os.path.isdir(r)]

    def _build():
        seen = set()
        out = []
        for root in roots:
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
        return out

    return _web.json_response({"models": _scan_cached(("ph_clip", root_q), roots, _build)})


# 节点：提示词卡片编辑/合并/循环取卡 + 运行时优化（api/llama/TextGenerate 三选一，互斥）。
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
        # 循环输入：固定排在所有 media_in / card_in 之后（最下面）。接上后「合并提示词」只出第 index 张卡。
        inputs["optional"]["index"] = ("INT", {
            "default": 0, "min": 0, "forceInput": True,
            "tooltip": "Loop index: when wired, the Merged prompt outputs only card #index's text (one prompt per loop round).",
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
                print(f"[PromptHelper] runtime auto-optimize ({auto_method}) failed: {e}")
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
        recv = []   # 「实时接收卡」本轮收到的外部文本（回传前端写进卡片，源变了就刷新）
        for i in range(count):
            raw = kwargs.get(f"card_in_{i + 1}")
            has_raw = raw is not None and str(raw).strip() != ""
            own = cards[i].get("content") or _ph_html_to_text(cards[i].get("contentHTML")) or ""
            if has_raw and cards[i].get("liveIn"):
                # 实时接收卡：外部文本只在卡片正文为空时兜底；正文为准（用户可在卡片里临时加词）
                recv.append({"id": cards[i].get("id"), "text": str(raw)})
                defaults.append(own if own.strip() else str(raw))
            elif has_raw:
                defaults.append(str(raw))   # 已连接的外部文本输入：覆盖该卡
            else:
                defaults.append(own)
        _in_merge = [i for i in range(count) if not (isinstance(cards[i], dict) and cards[i].get("mergeOff"))]
        # 实时接收卡：运行期绝不送优化（三个自动优化开关都不作用到它），原样并入输出
        live_idx = set(i for i in range(count) if isinstance(cards[i], dict) and cards[i].get("liveIn"))
        opt_merge = [i for i in _in_merge if i not in live_idx]
        live_merged = sep.join(_ph_compile_card(defaults[i], cards[i]) for i in _in_merge if i in live_idx and defaults[i].strip())
        default_src = sep.join(defaults[i] for i in opt_merge if defaults[i].strip())
        default_merged = sep.join(_ph_compile_card(defaults[i], cards[i]) for i in _in_merge if defaults[i].strip())

        def _join_live(base):
            return sep.join([x for x in (base or "", live_merged or "") if str(x).strip()])

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
                    merged, overall_used = _join_live(_ph_compile_card(overall["text"], rule_card)), True
                else:
                    merged = default_merged      # 已含实时卡原文
            elif default_src.strip():
                opt_text = optimize(default_src)
                merged, overall_used = _join_live(_ph_compile_card(opt_text, rule_card)), True
            else:
                merged = _join_live("")          # 用户自己没写；只有实时卡时也照常输出
        else:
            # 三个开关全关：同一套槽位规则，只是不做任何优化调用 ——
            # 总编辑滑块=默认 → 默认合并（合=灰不并）；=优化 → 整体优化内容（空就空，不回落）
            if overall.get("useOptimized"):
                merged = _join_live(_ph_compile_card(overall["text"], rule_card))
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
            if raw is not None and str(raw).strip() != "" and not card.get("liveIn"):
                ports.append(str(raw)); continue
            d = defaults[i]
            o = str(card.get("contentOptimized") or "")
            in_merge = not card.get("mergeOff")
            if card.get("liveIn"):
                ports.append(d)   # 实时接收卡：只输出默认正文，不优化、不用优化槽
            elif auto_used and not in_merge:
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

        # 循环模式（设置·其他设置里开）：index 接上时「合并提示词」只出第 index 张卡 —— 一段一张提示词时不用改卡片
        try:
            _cfg = json.loads(config) if isinstance(config, str) else (config or {})
        except Exception:
            _cfg = {}
        loop_mode = bool(_cfg.get("loopMode")) if isinstance(_cfg, dict) else False
        idx_raw = kwargs.get("index")
        if loop_mode and idx_raw is not None and str(idx_raw).strip() != "":
            try:
                _i = max(0, int(idx_raw))
            except (TypeError, ValueError):
                _i = -1
            _loop_no = _i + 1
            _loops = []
            for j in _in_merge:
                if not cards[j].get("loop"):
                    continue
                _arr = cards[j].get("loopIndices")
                if not isinstance(_arr, list):
                    _loops.append(j)
                    continue
                try:
                    if _loop_no in {int(x) for x in _arr}:
                        _loops.append(j)
                except (TypeError, ValueError):
                    pass
            if _loops:
                # 循环卡每轮都在；index 只在**非循环卡**里选当前段那张。顺序仍按原卡片顺序。
                _normals = [j for j in _in_merge if not cards[j].get("loop")]
                if not _normals:
                    print("[EzFlex-PromptHelper] 只有循环卡、没有普通卡：每一轮的合并提示词都会完全相同。"
                          " 要做“每段不同”，请再放普通卡（index 只在普通卡里选）。")
                _pick = _normals[_i] if 0 <= _i < len(_normals) else None
                _use = sorted(set(_loops + ([_pick] if _pick is not None else [])))
                merged = sep.join(compiled[j] for j in _use if compiled[j].strip())
            else:
                merged = compiled[_i] if 0 <= _i < len(compiled) else ""

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
                # 「实时接收卡」本轮收到的外部文本：[{id, text}]（前端据此更新卡片内容）
                "recv": [recv],
            },
            "result": tuple([merged] + compiled),
        }


