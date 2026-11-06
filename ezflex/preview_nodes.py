"""EzFlex-PreviewAny：白板式预览节点，外加它专用的媒体探测与导出工具。

节点：PreviewAnyNode —— 每个已连接的 input_N 生成一张卡片，原值透传。
工具：
  · 探测：图像/视频/音频/3D/模型与 LoRA 元数据、帧数、色彩空间
  · 导出：PNG（带 workflow/prompt 文本块）、MP4/WebM、WAV、OBJ
  · 落地目录：只能在 output 或"选择文件夹"登记过的根内，见 _save_target_dir
依赖包根（from .. import）：路径收口 _ez_real/_ez_inside/_ez_local、temp 回收 _ezpv_sweep、
提示词卡片解析 parse_prompt_*（读生成参数）。
HTTP 处理函数在本文件，注册块在 __init__.py 末尾的 try 块。
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

from aiohttp import web as _web  # 与 __init__.py 同源（那边在 try 块里导入，这里直接引）

# 借用包根里的共享 helper（__init__.py 末尾才导入本模块，届时这些名字都已定义）
from .. import (_ANY, _DynamicOutputTypes, _ez_apply_dynamic_ports, _ez_inside, _ez_last_dir, _ez_last_dir_set, _ez_local, _ez_real, _ez_root_add, _ez_root_drop_cap, _ez_root_rows, _ez_root_save, _ez_save_roots, _ez_sync_dynamic_types, _ezflex_user_dir, _ezflex_user_file, _ezpv_sweep, _fmt_mtime, _ph_backup_before_write, _ph_html_to_text, _ph_prompts_dir, _ph_tags_file, _sha256, parse_prompt_cards, parse_prompt_overall, parse_prompt_rules)


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
        if os.path.getsize(src) > 4 * 1024 ** 3:
            return ""
        ext = os.path.splitext(src)[1].lower()
        # 源版本编码进文件名（size + mtime）：源被同尺寸的新内容覆盖时名字会变 ⇒ 不会播旧副本；
        # 也不用再比对 dest 的 mtime —— 下面 os.utime 会把 dest 的 mtime 改成“现在”，
        # 拿它跟源 mtime 比会恒不相等，等于每个请求都整份重拷（视频 range 请求会放大成好几份）。
        ver = "%d_%d" % (os.path.getsize(src), int(os.path.getmtime(src)))
        dest = os.path.join(tmp_root, "ezflex_serve_"
                            + hashlib.sha1((src + "|" + ver).encode("utf-8", "replace")).hexdigest()[:16]
                            + ext)
        if not os.path.isfile(dest):
            shutil.copy2(src, dest)
            # 副本按**自己的**年龄算 TTL：copy2 会带来源文件的 mtime，源文件超过 6 小时的话
            # 副本一生成就会被 _ezpv_sweep 判过期删掉（2026-11 审计 P2-2）。
            os.utime(dest, None)
        return dest
    except Exception:
        return ""


_PREVIEW_MAX = 16


_PREVIEW_MAX_VALUE_LEN = 500


_PREVIEW_MAX_IMG_SIDE = 1600

# 卡片内联图（`entry["preview"]` 的 base64）的边长：卡片只有 64~120 px，全屏看的是 `image_src` 指向的
# 全尺寸临时文件，所以这里不需要 1600。1600 px PNG 实测 6.7 MB/张（2048 输入），16 张卡的 ui 载荷
# 能到上百 MB；640 在卡片/稍微放大时都够，载荷小一个量级。
_PREVIEW_CARD_SIDE = 640


_PREVIEW_MAX_BATCH = 256     # 默认导出帧数；batchMax=0 = 用户显式不限


_PREVIEW_THUMB_SIDE = 320


_PREVIEW_FRAME_HINTS = ("video", "frame", "sequence", "gif", "webm", "mp4", "mov")


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


# 节点：每个已连接输入一张预览卡，原值透传；探测/导出见 preview_nodes。
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

    RETURN_TYPES = _DynamicOutputTypes()
    RETURN_NAMES = ()
    OUTPUT_NODE = True
    FUNCTION = "preview"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Preview Any"

    def preview(self, config="{}", unique_id=None, extra_pnginfo=None, **kwargs):
        _ezpv_sweep()      # 顺带回收 temp 下过期的导出件（有最小间隔，不会每次执行都扫目录）
        cfg = self._parse_config(config)
        connected = self._connected_inputs(unique_id, extra_pnginfo)
        if not connected:
            # API/循环展开的 prompt 里 extra_pnginfo 可能没有当前节点：退回实际收到的 kwargs。
            # 按编号数值排序（sorted 默认是字符串序：input_1, input_10, input_11, input_2…）
            _ins = [k for k in kwargs if k.startswith("input_") and kwargs[k] is not None]
            _ins.sort(key=lambda s: int(s.split("_", 1)[1]) if s.split("_", 1)[1].isdigit() else 0)
            connected = [(k, k, None) for k in _ins]
        wf_meta = PreviewAnyNode._workflow_gen_meta((extra_pnginfo or {}).get("workflow", {}))
        entries, outputs = [], []
        for i, (name, label, upstream) in enumerate(connected):
            entry = self._entry(label or f"Input {i + 1}", kwargs.get(name), upstream, wf_meta, cfg)
            entry["input"] = name      # 卡片上的「多图保存类型」按这个名称存在节点 config 里
            entry = self._maybe_save(entry, cfg, label or f"card_{i + 1}", extra_pnginfo)
            entries.append(entry)
            outputs.append(kwargs.get(name))   # 透传原始值（不是卡文字），供工作流中间连接继续传递
        # 用 "*" 通配类型，让输出能连到任意类型的输入端口（透传原始值）
        return {"ui": {"entries": _pv_sanitize(entries)},
                "result": _ez_apply_dynamic_ports(self, [f"output_{i + 1}" for i in range(len(outputs))], outputs)}

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
        try:
            batch_max = int(data.get("batchMax", _PREVIEW_MAX_BATCH))
        except (TypeError, ValueError):
            batch_max = _PREVIEW_MAX_BATCH
        return {"save": bool(data.get("save")), "savePath": str(data.get("savePath") or ""),
                "saveFormats": data.get("saveFormats") if isinstance(data.get("saveFormats"), dict) else {},
                "batchMode": str(data.get("batchMode") or "auto"), "batchMax": max(0, batch_max)}

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
    def _entry(self, caption, value, upstream=None, wf_meta=None, cfg=None):
        entry = {"caption": caption or "", "type": "", "value": "", "full_value": None, "preview": None,
                 "audio": None, "frames": 0, "meta": None}
        if value is None:
            entry["type"] = "EMPTY"
            entry["value"] = "(not connected)"
            return entry
        try:
            type_name = self._infer_type(value)
            # ★★ 「多帧图像」的呈现形态由节点设置里的「多图显示 / 保存」决定（默认 auto = 按类型推断）：
            #   一串图像（4D 批次张量 / 张量列表）既能当图片序列看，也能编成视频看 ——
            #   所以渲染方式由这个设置决定，而不是一律按类型判成 VIDEO（否则选了「图片序列」仍出视频）。
            #   auto 保持原样：批次张量 → 图片序列；张量列表 → 视频（那是视频帧的常见形态）。
            frames_probe = PreviewAnyNode._image_frames(value)
            if frames_probe is not None:
                mode = str((cfg or {}).get("batchMode") or "auto")
                if mode == "images":
                    type_name = "IMAGE"
                elif mode == "video":
                    type_name = "VIDEO"
            entry["type"] = type_name
            if type_name == "IMAGE":
                # 支持两种容器：4D 批次张量、张量列表（循环累积出来的那种）
                frames = PreviewAnyNode._image_frames(value)
                first = frames[0] if frames else value
                src = self._export_image_url(first)
                if src:
                    entry["image_src"] = src
                entry["preview"] = self._image_to_base64(first)
                th = self._export_image_thumb(first, self._src_file_of(src) if src else None)   # 复用原图文件，避免再编码一次全图
                if th:
                    entry["thumb_src"] = th
                count = len(frames) if frames else (int(value.shape[0]) if isinstance(value, torch.Tensor) and value.dim() == 4 else 1)
                if count > 1:
                    # 批次：逐帧导出临时文件（弹窗翻页 + 存档都要用）；batch_kind 只按上游节点类名猜来源。
                    try:
                        _maxb = int((cfg or {}).get("batchMax", _PREVIEW_MAX_BATCH))
                    except (TypeError, ValueError):
                        _maxb = _PREVIEW_MAX_BATCH
                    if _maxb <= 0:
                        _maxb = count   # 0 = 不限制（用户显式选择）
                    entry["images"] = [u for u in (self._export_image_url(f) for f in (frames or [])[:min(count, _maxb)]) if u]
                    entry["batch_kind"] = self._image_batch_kind(upstream)
                    if count > _maxb:
                        entry["batch_total"] = count
                if frames:
                    h, w = int(frames[0].shape[0]), int(frames[0].shape[1])
                    entry["value"] = (f"{w} x {h} × {count}" if count > 1 else f"{w} x {h}")
                else:
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
                mth = self._export_image_thumb(value, self._src_file_of(msrc) if msrc else None)   # 复用 mask 原图
                if mth:
                    entry["thumb_src"] = mth
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
                # ★ 列表型视频（LoopEnd.out1 / MergeList 累积出来的 [Video, Video, …]）：
                #   单独处理：取最后一段的视频文件/编码流做封面与播放源，值显示「N 段」。走通用 VIDEO
                #   分支时 _video_first_frame 只认帧序列，会没有封面、没有播放源。
                if isinstance(value, (list, tuple)) and value and not any(isinstance(x, torch.Tensor) for x in value):
                    _seq = [x for x in value if x is not None]
                    if _seq:
                        _last = _seq[-1]
                        _fsrc = PreviewAnyNode._video_file_source(_last)
                        if not _fsrc:
                            _fsrc = PreviewAnyNode._video_stream_temp(_last)
                        entry["frames"] = len(_seq)
                        if _fsrc:
                            from urllib.parse import quote
                            entry["video_src"] = "/preview_any/serve_video?path=" + quote(_fsrc)
                            _poster, _vfps, _dims = self._video_file_poster(_fsrc)
                            if _poster:
                                entry["preview"] = _poster
                            entry["fps"] = _vfps
                            entry["value"] = ("%d videos · " % len(_seq)) + self._video_file_summary(_vfps, _dims)
                        else:
                            entry["value"] = "%d videos" % len(_seq)
                        return entry
                # 1) 底层是磁盘上的视频文件（内置 Load Video / 我们的 MediaOut 都是）：直接挂原文件播放，绝不重编码。
                # 2) 内存型视频对象（内置 Create Video 的 VideoFromComponents 等）：它自己 get_stream_source() 出来的就是
                #    「带音轨 + 原始帧率」的完整视频（save_to 会把 audio 一起写进去），落一个临时文件同样直接播 ——
                #    音轨 / 帧率 / 时长都随原视频保留；重编码会丢掉音轨，帧率也只能靠猜。
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
                    # 只解码一次：首帧、帧数、摘要、WebM 都复用同一份 frames。
                    frames, fps = self._video_frames(value)
                    entry["frames"] = len(frames)
                    entry["preview"] = (self._image_to_base64(frames[0])
                                        if frames and frames[0] is not None else None)
                    entry["fps"] = fps
                    entry["value"] = self._video_summary(frames, fps)
                    webm = self._video_to_webm(frames, fps)
                    if webm:
                        entry["video"] = webm
                else:
                    entry["value"] = "Video"   # 内存型视频但拿不到它的编码流，只能显示个类型
            elif type_name == "CONDITIONING":
                entry["value"] = self._conditioning_summary(value)
                entry["full_value"] = entry["value"]
                _cp = self._conditioning_tmp(value)          # 核心 SaveConditioning 同格式
                if _cp:
                    entry["save_src"] = _cp
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
                _lp = self._latent_tmp(value)                # 核心 SaveLatent 同格式
                if _lp:
                    entry["save_src"] = _lp
                val, full = self._latent_summary(value)
                entry["value"] = val
                entry["meta"] = ("Latent is the hidden latent space of a diffusion model (compressed features); shape=[B,C,H,W] means:"
                                 "B=batch, C=channels (usually 4), H=height, W=width. It is not the final image;"
                                 " it must be decoded by a VAE into an image. This shows its shape/dtype stats.")
                if full:
                    entry["full_value"] = full
            elif type_name in ("MODEL_3D", "FILE_3D"):
                entry["value"] = self._object_3d_summary(value)
                url = self._export_3d_url(value)
                if url:
                    entry["model3d"] = url
                p3d = getattr(value, "path", None) or getattr(value, "file", None) or _file3d_source(value)
                if isinstance(p3d, str) and os.path.isfile(p3d):
                    entry["save_src"] = p3d       # 存不存由 save_skip（来源）决定
                    gm = self._file_gen_meta(p3d)
                    if gm:
                        entry["gen_meta"] = json.dumps(gm, ensure_ascii=False, default=str)
            elif type_name in ("MESH", "SPLAT", "VOXEL"):
                entry["value"] = self._geometry_summary(value, type_name)
                entry["full_value"] = entry["value"]
                if type_name == "MESH":
                    _glb = self._mesh_glb_tmp(value)            # 正式存档用 .glb（查看器仍用 OBJ）
                    if _glb:
                        entry["save_src"] = _glb
                    url = PreviewAnyNode._mesh_obj_url(value)   # 顶点/面张量 → 临时 OBJ，交给内置 3D 查看器
                    if url:
                        entry["model3d"] = url
                        from urllib.parse import urlparse, parse_qs
                        _fn = (parse_qs(urlparse(url).query).get("filename") or [""])[0]
                        _mp = os.path.join(folder_paths.get_temp_directory(), _fn) if _fn else ""
                        if _mp and os.path.isfile(_mp) and not entry.get("save_src"):
                            entry["save_src"] = _mp
                else:
                    # SPLAT / VOXEL 没有标准导出格式：以前会掉进文本存档分支写成 .txt（名不副实）。
                    entry["save_skip"] = True
            elif type_name in ("MODEL", "CLIP", "VAE", "CONTROL_NET", "CLIP_VISION", "STYLE_MODEL",
                               "UPSCALE_MODEL", "LORA_MODEL", "GLIGEN", "SAMPLER", "SIGMAS", "GUIDER",
                               "NOISE", "SEGS"):
                entry["value"] = self._object_summary(value, type_name)
                if type_name in ("MODEL", "CLIP", "VAE", "LORA_MODEL"):
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
        entry["save_skip"] = _is_file_src   # 来源就是文件 → 自动存档直接跳过（加载物本来就在硬盘上）
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
            # ComfyUI 的 CONDITIONING 是 [[cond_tensor, {…}], …]：元数据在第二个元素，
            # 所以判 value[0][1]；判 value[0][0] 会把真 CONDITIONING 当成 LIST。
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
    def _image_frames(value):
        """把「一串图像」摊成逐帧张量列表（每项 [H,W,C]）；不是图像序列时返回 None。

        支持两种容器（都是「多帧图像」的合法写法）：
          · 4D 批次张量 [N,H,W,C] → N 帧；3D 单图 → 1 帧；
          · 张量列表 [t1, t2, …]（每个 t 是 4D/3D）→ 逐帧摊平（**循环累积出来的就是这种**）。
        用途：① 让「多图显示/保存 = 图片序列」能把张量列表按图片序列渲染（不再一律编视频）；
              ② IMAGE 分支统一按「帧列表」处理，两种容器走同一条路。
        ⚠️ 列表里混了非张量（例如视频对象）→ 返回 None，交回原类型推断（那确实是视频）。
        """
        try:
            def dims_ok(t):
                return isinstance(t, torch.Tensor) and t.dim() in (3, 4) and int(t.shape[-1]) in (1, 3, 4)
            if isinstance(value, torch.Tensor):
                if value.dim() == 4 and dims_ok(value):
                    return [value[i] for i in range(int(value.shape[0]))]
                if value.dim() == 3 and dims_ok(value):
                    return [value]
                return None
            if isinstance(value, (list, tuple)):
                if not value:
                    return None
                out = []
                for t in value:
                    if not dims_ok(t):
                        return None
                    if t.dim() == 4:
                        out.extend(t[i] for i in range(int(t.shape[0])))
                    else:
                        out.append(t)
                return out or None
        except Exception:
            pass
        return None

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
            if max(img.size) > _PREVIEW_CARD_SIDE:
                img.thumbnail((_PREVIEW_CARD_SIDE, _PREVIEW_CARD_SIDE), Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="PNG")   # optimize=True 对 PNG 很慢，缩略图不值得
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
    def _export_image_thumb(tensor, src_path=None):
        """卡片缩略图：长边压到 _PREVIEW_THUMB_SIDE 的小 PNG，落临时目录并返回 URL。
        用途：entries 持久化进 node.properties 时只存这张小图的 URL ⇒ 切工作流回来能立刻还原卡片画面，
        又不把 1600px 原图的 base64 塞进工作流 JSON（否则工作流会膨胀到几 MB）。"""
        try:
            from PIL import Image
            import uuid
            if src_path and os.path.isfile(src_path):
                img = Image.open(src_path)
            else:
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
                img = Image.fromarray(img_np)
            img.thumbnail((_PREVIEW_THUMB_SIDE, _PREVIEW_THUMB_SIDE), Image.LANCZOS)
            tmp = os.path.join(folder_paths.get_temp_directory(), f"ezpv_th_{uuid.uuid4().hex}.png")
            img.save(tmp, format="PNG")
            from urllib.parse import quote
            return "/view?type=temp&filename=" + quote(os.path.basename(tmp))
        except Exception:
            return None

    @staticmethod
    def _image_batch_kind(upstream):
        """IMAGE 批次的来源只能从工作流上游节点类名猜：张量本身区分不了批量出图与视频抽帧。"""
        t = (upstream.get("type") or "").lower() if isinstance(upstream, dict) else ""
        return "frames" if any(h in t for h in _PREVIEW_FRAME_HINTS) else "images"

    @staticmethod
    def _image_summary(tensor, max_len=_PREVIEW_MAX_VALUE_LEN):
        if isinstance(tensor, torch.Tensor):
            t = tensor
            batch = int(t.shape[0]) if t.dim() == 4 else 1
            if t.dim() == 4:
                t = t[0]
            if t.dim() == 3:
                h, w = t.shape[0], t.shape[1]
                return (f"{w} x {h} × {batch}" if batch > 1 else f"{w} x {h}"), None
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
            # 无文件 → 写临时 WAV（直接拿 WAV 字节，不再 base64 编一遍再解回来）
            wav = PreviewAnyNode._audio_wav_bytes(data)
            if wav:
                import uuid
                tmp = os.path.join(folder_paths.get_temp_directory(), f"ezpv_audio_{uuid.uuid4().hex}.wav")
                with open(tmp, "wb") as fh:
                    fh.write(wav)
                return "/view?type=temp&filename=" + quote(os.path.basename(tmp))
            return None
        except Exception:
            return None

    @staticmethod
    def _audio_wav_bytes(data):
        """把 ComfyUI 音频编成 WAV 字节（data URI 与临时文件共用，省掉 encode→decode 一转）。"""
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
            # ComfyUI AUDIO = [B, C, T]；取第 0 个 batch，保留声道维，不要 reshape(-1) 把左右声道摊平。
            if w.ndim == 3:
                w = w[0]
            elif w.ndim == 1:
                w = w[None, :]
            if w.ndim != 2 or int(w.shape[0]) < 1 or int(w.shape[1]) < 1:
                return None
            audio16 = (np.clip(w, -1.0, 1.0).T * 32767).astype(np.int16)   # (T, C)，WAV 需要交错
            from io import BytesIO
            import wave
            buf = BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(int(w.shape[0]))
                wf.setsampwidth(2)
                wf.setframerate(int(sample_rate))
                wf.writeframes(audio16.tobytes())
            return buf.getvalue()
        except Exception:
            return None

    @staticmethod
    def _audio_to_data_uri(data):
        """把 ComfyUI 音频（dict 含 waveform/sample_rate，或 (waveform, sample_rate)）编码为 WAV data URI。"""
        wav = PreviewAnyNode._audio_wav_bytes(data)
        return ("data:audio/wav;base64," + base64.b64encode(wav).decode("ascii")) if wav else None

    @staticmethod
    def _audio_summary(data):
        try:
            if isinstance(data, dict):
                sample_rate = data.get("sample_rate")
                w = data.get("waveform", data.get("audio"))
                if isinstance(w, torch.Tensor):
                    return f"Audio {w.shape[-1]} samples @ {sample_rate}Hz" if sample_rate else f"Audio {w.shape[-1]} samples"
                return "Audio"
            if isinstance(data, (list, tuple)) and len(data) >= 2:
                sample_rate = data[1]
                w = data[0]
                if isinstance(w, torch.Tensor):
                    return f"Audio {w.shape[-1]} samples @ {sample_rate}Hz"
                return "Audio"
            return "Audio"
        except Exception:
            return "Audio"

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
                # ★ 循环累积出来的是「多个 4D 批次」的列表（每段一个 [T,H,W,3]）。
                #   这里逐批摊平；只摊平一个批次时多段列表会被当成 3 帧，视频模式只显示第一段、画面变形。
                frames = []
                for x in value:
                    if not isinstance(x, torch.Tensor):
                        continue
                    if x.ndim == 4:
                        for i in range(int(x.shape[0])):
                            frames.append(x[i])
                            if len(frames) >= 30:
                                break
                    elif x.ndim == 3:
                        frames.append(x)
                    if len(frames) >= 30:
                        break
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
                return "Video"
            t = frames[0]
            if t.ndim == 4:
                t = t[0]
            if t.ndim == 3:
                return f"{n} frames @ {fps}fps  {t.shape[1]}x{t.shape[0]}"
            return f"{n} frames @ {fps}fps"
        except Exception:
            return "Video"

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
            _size_set = False
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
                # ★ 必须**无条件**按第一帧设置尺寸：libvpx 的 CodecContext 可能自带默认 640×480，
                #   只在 width is None 时设置会让 480×852 的竖屏被编码成 640×480（画面被拉宽）。
                if not _size_set:
                    stream.width = int(np_img.shape[1])
                    stream.height = int(np_img.shape[0])
                    _size_set = True
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
        """视频对象 → 可播放的临时文件，返回绝对路径（失败 None）。
        · 未裁剪：文件型直接返回源文件；内存型落成临时文件（get_stream_source 自带音轨/帧率）。
        · **裁剪过的**（SplitVideo 的懒裁剪 / VideoTrim）：源文件不能直接播（会播整段）⇒ 按窗口转码一次，
          按 源+窗口 哈希缓存；模型/保存路径不经过这里，所以正常情况下仍然零编码。
        按内容哈希命名 → 同一段视频反复预览只占一个文件。"""
        try:
            start, dur, total = 0.0, 0.0, 0.0
            try:
                if hasattr(value, "get_active_trim_window"):
                    start, dur = value.get_active_trim_window()
                if hasattr(value, "get_duration"):
                    total = float(value.get_duration() or 0.0)
            except Exception:
                start, dur, total = 0.0, 0.0, 0.0
            if (start > 1e-6) or (dur > 0 and total > 0 and dur < total - 1e-3):
                import hashlib
                base = ""
                try:
                    s0 = value.get_stream_source()
                    if isinstance(s0, str) and s0:
                        base = os.path.abspath(s0)
                except Exception:
                    base = ""
                key = "%s|%.4f|%.4f" % (base or ("mem:%d" % id(value)), start, dur)
                tmp = os.path.join(folder_paths.get_temp_directory(),
                                   "ezpv_trim_" + hashlib.sha1(key.encode()).hexdigest()[:16] + ".mp4")
                if os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
                    return os.path.abspath(tmp)
                try:
                    value.save_to(tmp)
                    if os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
                        return os.path.abspath(tmp)
                except Exception:
                    pass
        except Exception:
            pass
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
    def _image_np_to_base64(arr):
        try:
            from io import BytesIO
            from PIL import Image
            if arr.ndim == 2:
                img = Image.fromarray(arr, mode="L")
            else:
                img = Image.fromarray(arr[:, :, :3])
            if max(img.size) > _PREVIEW_CARD_SIDE:
                img.thumbnail((_PREVIEW_CARD_SIDE, _PREVIEW_CARD_SIDE), Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="PNG", optimize=True)
            return base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            return None

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
                return f"Video @ {fps:.0f}fps  {w}x{h}"
        except Exception:
            pass
        return "Video"

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

        out["Name"] = name or (os.path.basename(path) if path else (kind or "Model"))
        out["Type"] = kind or type_name
        arch = pick("modelspec.architecture", "architecture", "model_type", "ss_base_model_version", "ss_model_description", "model_type_name")
        if arch:
            out["Architecture"] = str(arch)
        else:
            ts = PreviewAnyNode._model_type_str(value)
            if ts:
                out["Architecture"] = ts
        author = pick("modelspec.author", "created_by", "ss_creator", "author")
        if author:
            out["Author/Source"] = str(author)
        org = pick("modelspec.organization", "modelspec.tags", "ss_sd_model_name", "modelspec.civitai_resources")
        if org:
            out["Organization"] = str(org)
        base = pick("ss_base_model_version", "base_model", "ss_sd_model_name")
        if base and kind == "LoRA":
            out["Base model"] = str(base)
        dim = pick("ss_network_dim", "ss_network_dims")
        if dim:
            out["Train dim"] = str(dim)
        alpha = pick("ss_network_alpha")
        if alpha:
            out["Train alpha"] = str(alpha)
        tf = pick("ss_tag_frequency")
        if tf:
            try:
                tfv = json.loads(tf) if isinstance(tf, str) else tf
                if isinstance(tfv, dict):
                    out["Training tags/weights"] = {k: (v[0] if isinstance(v, (list, tuple)) else v) for k, v in tfv.items()}
                else:
                    out["Training tags/weights"] = str(tfv)
            except Exception:
                out["Training tags/weights"] = str(tf)
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
                    out["Top trigger words"] = ", ".join(topw)
        except Exception:
            pass
        ntype = pick("ss_network_module", "ss_module", "ss_network_args", "ss_network_type")
        if ntype:
            out["Network type"] = str(ntype)
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
            out["Has embedded VAE"] = "Yes (built-in VAE)" if vae_ok else "No (may need external VAE)"
        desc = pick("modelspec.description", "ss_model_description", "ss_training_comment", "ss_caption")
        if desc:
            out["Description"] = str(desc)
        title = pick("modelspec.title", "ss_model_name")
        if title and title != name:
            out["Model name"] = str(title)
        ver = pick("modelspec.sd_version", "modelspec.version", "modelspec.schema_version", "ss_version", "modelspec.training_version")
        if ver and str(ver) != str(arch):
            out["Version"] = str(ver)
        use_prompt = pick("modelspec.usage")
        if use_prompt and str(use_prompt) != str(desc):
            out["Usage prompt/trigger words"] = str(use_prompt)
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
            out["Source/Link"] = str(src)
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
            out["Training params"] = tr
        if path:
            out["File"] = os.path.basename(path)
            out["Path"] = os.path.abspath(path)
            try:
                sz = os.path.getsize(path)
                out["Size"] = _fmt_size(sz)
                if sz <= (1 << 30):
                    out["SHA256"] = _sha256(path)
                else:
                    out["SHA256"] = "(skipped for large files)"
            except Exception:
                pass
            try:
                out["Modified"] = _fmt_mtime(os.path.getmtime(path))
            except Exception:
                pass
        if raw:
            out["All metadata"] = raw
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
                    "Model": PreviewAnyNode._build_sub_meta(base_path, name, type_name, value, "Model"),
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
                out["Model"] = list(dict.fromkeys(model))
            if lora:
                out["LoRA"] = list(dict.fromkeys(lora))
            if clip:
                out["CLIP"] = list(dict.fromkeys(clip))
            if vae:
                out["VAE"] = list(dict.fromkeys(vae))
            if prompts:
                out["Prompt"] = prompts
            if neg:
                out["Negative prompt"] = neg
            if sampler:
                out["Sampling params"] = sampler
            rawc = {k: text[k] for k in ("prompt", "workflow", "parameters") if k in text}
            if rawc:
                out["Raw text blocks"] = rawc
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
            parsed["Source file"] = os.path.basename(path)
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
                parsed["Source file"] = os.path.basename(path)
                return parsed
        sc = PreviewAnyNode._read_sidecar_meta(path)
        if sc:
            sc.setdefault("Source file", os.path.basename(path))
            return sc
        cont = PreviewAnyNode._container_meta(path)
        if cont:
            cont.setdefault("Source file", os.path.basename(path))
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
                    return {"Raw text blocks": raw[:200000]}
                try:
                    data = json.loads(raw)
                except Exception:
                    return {"Raw text blocks": raw[:200000]}
                if isinstance(data, dict):
                    return data
                if isinstance(data, list):
                    return {"Data": data}
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
            out["Assets"] = data["asset"]
        if data.get("extras"):
            out["Extra info"] = data["extras"]
        if data.get("meshes"):
            out["Meshes"] = len(data["meshes"])
        if data.get("materials"):
            out["Materials"] = len(data["materials"])
        if data.get("animations"):
            out["Animations"] = len(data["animations"])
        return out if out else None

    @staticmethod
    def _gltf_meta(path):
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
        out = {}
        if isinstance(data.get("asset"), dict):
            out["Assets"] = data["asset"]
        if data.get("extras"):
            out["Extra info"] = data["extras"]
        if data.get("meshes"):
            out["Meshes"] = len(data["meshes"])
        if data.get("materials"):
            out["Materials"] = len(data["materials"])
        if data.get("animations"):
            out["Animations"] = len(data["animations"])
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
                        res["Container tags"] = tags
                    for st in (data.get("streams") or []):
                        codec = st.get("codec_type")
                        if codec:
                            res.setdefault("Streams", []).append({
                                codec: st.get("codec_name"),
                                "Width": st.get("width"),
                                "Height": st.get("height"),
                                "Duration": st.get("duration"),
                                "fps": st.get("avg_frame_rate"),
                            })
                    return res if res else None
            try:
                import mutagen
            except Exception:
                return None
            m = mutagen.File(path)
            if m and getattr(m, "tags", None):
                return {"Tags": {str(k): str(v) for k, v in m.tags.items() if str(v)}}
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
                return {"Tags": {str(k): str(v) for k, v in m.tags.items() if str(v)}}
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
                    return {"Audio": info}
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
        model, lora, clip, vae, prompts, sampler, upscale = [], [], [], [], [], {}, []
        _MODEL_EXT = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx", ".lora", ".zip")
        # 放大/超分权重不是本次出图的底模；检测/控制/换脸等辅助权重同样不算。
        _UPSCALE_HINTS = ("upscale", "superresolution", "super_resolution", "esrgan", "swinir", "gfpgan", "codeformer", "restoreformer")
        _AUX_HINTS = ("control", "detector", "insightface", "ipadapter", "faceid", "segment", "yolo", "samloader", "clipvision", "style_model", "gligen")

        def _is_model_ext(s):
            return isinstance(s, str) and s.lower().endswith(_MODEL_EXT)

        def _num(v):
            try:
                float(v)
                return True
            except Exception:
                return False

        # 连线穿透：CLIPTextEncode 的 text 常常是连线（如 EzFlex-PromptHelper 的「Merged prompt」），
        # 只读自己的 widget 会读空 —— 按 workflow.links 上溯去找真正写着提示词的那个节点。
        by_id = {}
        for n in nodes:
            if isinstance(n, dict) and n.get("id") is not None:
                by_id[str(n.get("id"))] = n
        link_src = {}
        for l in (workflow.get("links") or []):
            if isinstance(l, dict):
                link_src[str(l.get("id"))] = (l.get("origin_id"), l.get("origin_slot"))
            elif isinstance(l, (list, tuple)) and len(l) >= 3:
                link_src[str(l[0])] = (l[1], l[2])

        def _plain_widget(n):
            wv = n.get("widgets_values") or []
            if not isinstance(wv, (list, tuple)):
                wv = [wv]
            for w in wv:
                if not isinstance(w, str):
                    continue
                ws = w.strip()
                if not ws or _is_model_ext(ws) or ws[0] in "{[" or _num(ws):
                    continue
                return ws
            return ""

        def _prompt_of(n, depth=0, seen=None, slot=None):
            """穿透连线取提示词正文。PromptHelper 特殊：正文在 config JSON 的卡片里（slot 0 = 合并，slot N = 第 N 张卡）。"""
            if not isinstance(n, dict) or depth > 8:
                return ""
            if seen is None:
                seen = set()
            nid = str(n.get("id"))
            if nid in seen:
                return ""
            seen.add(nid)
            cl = str(n.get("type") or "").lower()
            wv = n.get("widgets_values") or []
            if not isinstance(wv, (list, tuple)):
                wv = [wv]
            if "prompthelper" in cl or "prompt_helper" in cl:
                for w in wv:
                    if not isinstance(w, str) or not w.strip().startswith("{"):
                        continue
                    try:
                        cfg = json.loads(w)
                    except Exception:
                        continue
                    cards = parse_prompt_cards(cfg)
                    if not cards:
                        continue
                    if isinstance(slot, int) and 1 <= slot <= len(cards):
                        c = cards[slot - 1]                 # PromptHelper 的 Card N 输出口
                        t = str(c.get("content") or "").strip() or _ph_html_to_text(c.get("contentHTML") or "").strip()
                        if t:
                            return t
                    ov = parse_prompt_overall(cfg)
                    if ov.get("useOptimized") and str(ov.get("text") or "").strip():
                        return str(ov["text"]).strip()
                    sep = parse_prompt_rules(cfg)["mergeSep"]
                    parts = []
                    for c in cards:
                        if c.get("mergeOff"):
                            continue
                        t = str(c.get("content") or "").strip() or _ph_html_to_text(c.get("contentHTML") or "").strip()
                        if t:
                            parts.append(t)
                    if parts:
                        return sep.join(parts)
                return ""
            t = _plain_widget(n)
            if t:
                return t
            for i in (n.get("inputs") or []):
                if isinstance(i, dict) and i.get("link") is not None:
                    hit = link_src.get(str(i.get("link")))
                    if hit:
                        t = _prompt_of(by_id.get(str(hit[0])), depth + 1, seen, hit[1])
                        if t:
                            return t
            return ""

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
                    elif any(x in cl for x in _AUX_HINTS):
                        pass                     # 检测/控制/换脸等辅助权重：不是出图模型
                    elif any(x in cl for x in _UPSCALE_HINTS):
                        upscale.append(w)
                    elif "clip" in cl:
                        clip.append(w)
                    elif any(x in cl for x in ("checkpoint", "unet", "diffusion", "loadmodel", "load_model", "model")):
                        model.append(w)
            # EzFlex-ModelsCombo：模型文件在 config JSON 里（不是独立的 *.safetensors widget），要单独解出来
            if "modelscombo" in cl:
                for w in wv:
                    if not isinstance(w, str):
                        continue
                    try:
                        loaders = json.loads(w)
                    except Exception:
                        continue
                    if not isinstance(loaders, list):
                        continue
                    for L in loaders:
                        if not isinstance(L, dict):
                            continue
                        f = L.get("file")
                        if not isinstance(f, str) or not f.strip():
                            continue
                        t = str(L.get("type") or "").lower()
                        if t == "lora":
                            lora.append(f)
                        elif t == "vae":
                            vae.append(f)
                        elif t == "clip":
                            clip.append(f)
                        else:
                            model.append(f)
            # 提示词：CLIPTextEncode / 带 text 的编码节点；正文可能是连线（PromptHelper / 文本节点），要穿透
            if ("clip" in cl and "encode" in cl) or "text" in cl or "prompt" in cl:
                t = _prompt_of(n)
                if t:
                    prompts.append(t)
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
            out["Model"] = list(dict.fromkeys(model))
        if lora:
            out["LoRA"] = list(dict.fromkeys(lora))
        if clip:
            out["CLIP"] = list(dict.fromkeys(clip))
        if vae:
            out["VAE"] = list(dict.fromkeys(vae))
        if upscale:
            out["Upscale model"] = list(dict.fromkeys(upscale))
        if prompts:
            out["Prompt"] = list(dict.fromkeys(prompts))
        if sampler:
            out["Sampling params"] = sampler
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
            if max(img.size) > _PREVIEW_CARD_SIDE:
                img.thumbnail((_PREVIEW_CARD_SIDE, _PREVIEW_CARD_SIDE), Image.LANCZOS)
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
                return f"3D model ({fmt})" + (f": {name}" if name else "")
            return f"3D model ({type(value).__name__})" + (f": {name}" if name else "")
        except Exception:
            return f"3D model ({type(value).__name__})"

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
                extra = [k for k, attr in (("UV", "uvs"), ("Vertex colors", "vertex_colors"), ("Textures", "texture")) if getattr(value, attr, None) is not None]
                return (f"Mesh {nv} vertices / {nf} faces" + (f" ×{batch}" if batch > 1 else "")
                        + ("（" + " · ".join(extra) + "）" if extra else ""))
            if type_name == "SPLAT":
                p = getattr(value, "positions", None)
                sh = getattr(value, "sh", None)
                n = int(p.shape[1]) if isinstance(p, torch.Tensor) and p.ndim == 3 else 0
                k = int(sh.shape[-2]) if isinstance(sh, torch.Tensor) and sh.ndim == 4 else 0
                deg = int(round(k ** 0.5)) - 1 if k else 0
                return f"Gaussian splat {n} points" + (f" · SH {k} coeff (degree {deg})" if k else "") + "(visualization not supported yet)"
            d = getattr(value, "data", None)
            shape = "×".join(str(x) for x in d.shape) if isinstance(d, torch.Tensor) else ""
            res = getattr(value, "resolution", None)
            return ("Voxel " + shape if shape else "Voxel") + (f" · resolution {res}" if res else "") + "(visualization not supported yet)"
        except Exception:
            return {"MESH": "Mesh", "SPLAT": "Gaussian splat"}.get(type_name, "Voxel")

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

    @staticmethod
    @staticmethod
    def _latent_tmp(value):
        """LATENT → 临时 .latent（与核心 SaveLatent 同格式：safetensors 里的 latent_tensor）。"""
        try:
            samples = value.get("samples") if isinstance(value, dict) else None
            if not isinstance(samples, torch.Tensor):
                return ""
            import comfy.utils
            tmp = os.path.join(folder_paths.get_temp_directory(), "ezpv_%s.latent" % uuid.uuid4().hex)
            comfy.utils.save_torch_file({"latent_tensor": samples.contiguous(),
                                         "latent_format_version_0": torch.tensor([])}, tmp)
            return tmp if os.path.isfile(tmp) else ""
        except Exception:
            return ""

    @staticmethod
    def _conditioning_tmp(value):
        """CONDITIONING → 临时 .safetensors（与核心 SaveConditioning 同一键格式；核心只支持单条目）。"""
        try:
            if not (isinstance(value, (list, tuple)) and len(value) == 1):
                return ""
            cond, options = value[0]
            if not isinstance(cond, torch.Tensor):
                return ""
            sd = {"conditioning": cond}
            values = {}
            for k, v in (options or {}).items():
                if isinstance(v, torch.Tensor):
                    sd[k] = v
                elif isinstance(v, (bool, int, float, str)):
                    values[k] = v
                elif v is None:
                    continue
                else:
                    return ""
            import safetensors.torch
            tmp = os.path.join(folder_paths.get_temp_directory(), "ezpv_%s.safetensors" % uuid.uuid4().hex)
            safetensors.torch.save_file({k: v.detach().to("cpu", copy=True).contiguous() for k, v in sd.items()},
                                        tmp, metadata={"conditioning_options": json.dumps(values)})
            return tmp if os.path.isfile(tmp) else ""
        except Exception:
            return ""

    @staticmethod
    def _mesh_glb_tmp(value):
        """Types.MESH（顶点/面张量）→ 临时 .glb（正式 3D 存档；查看器仍用 OBJ）。"""
        try:
            v = getattr(value, "vertices", None)
            f = getattr(value, "faces", None)
            if not (isinstance(v, torch.Tensor) and isinstance(f, torch.Tensor)):
                return ""
            verts = (v[0] if v.ndim == 3 else v).detach().cpu().float().numpy()
            faces = (f[0] if f.ndim == 3 else f).detach().cpu().long().numpy()
            vc, fc = getattr(value, "vertex_counts", None), getattr(value, "face_counts", None)
            if isinstance(vc, torch.Tensor) and vc.numel():
                verts = verts[: max(1, int(vc.reshape(-1)[0]))]
            if isinstance(fc, torch.Tensor) and fc.numel():
                faces = faces[: max(1, int(fc.reshape(-1)[0]))]
            import trimesh
            mesh = trimesh.Trimesh(vertices=verts[:, :3], faces=faces[:, :3], process=False)
            tmp = os.path.join(folder_paths.get_temp_directory(), "ezpv_%s.glb" % uuid.uuid4().hex)
            mesh.export(tmp)
            return tmp if os.path.isfile(tmp) else ""
        except Exception:
            return ""

    @staticmethod
    def _save_base(cfg, dirpath, name):
        """存档文件名基名：用「保存类型」里写的模板（支持 %year% %month% %day% %hour% %minute% %second%），
        空则用卡片名。返回 (base, counter)，counter 按目录里已有的 <base>_NNNNN_ 递增（与内置 Save Image 同款）。"""
        import time as _t
        pat = str((cfg.get("saveFormats") or {}).get("_name") or "").strip()
        if pat:
            if "%" in pat:
                now = _t.localtime()
                for k, v in (("%year%", f"{now.tm_year}"), ("%month%", f"{now.tm_mon:02d}"), ("%day%", f"{now.tm_mday:02d}"),
                             ("%hour%", f"{now.tm_hour:02d}"), ("%minute%", f"{now.tm_min:02d}"), ("%second%", f"{now.tm_sec:02d}")):
                    pat = pat.replace(k, v)
            base = PreviewAnyNode._sanitize_filename(os.path.basename(pat.replace("\\", "/")))
        else:
            base = PreviewAnyNode._sanitize_filename(name)   # 没写模板 → 用卡片名，同样要按目录里的编号接着排，别覆盖旧档
        counter = 0
        try:
            for fn in os.listdir(dirpath):
                if fn.startswith(base + "_"):
                    # 单图存档是 <base>_00001.png（编号后面直接跟扩展名），要先去掉扩展名再认编号，
                    # 否则 head 永远不是纯数字、counter 恒为 0 → 每次保存都覆盖同一个文件。
                    head = fn[len(base) + 1:].split("_")[0].split(".")[0]
                    if head.isdigit():
                        counter = max(counter, int(head))
        except Exception:
            pass
        return base, counter

    @staticmethod
    def _png_meta(extra_pnginfo):
        """PNG 文本块：workflow / prompt（与内置 Save Image 同款，值序列化成字符串）。"""
        if not isinstance(extra_pnginfo, dict) or not extra_pnginfo:
            return None
        meta = {}
        for k, v in extra_pnginfo.items():
            try:
                meta[str(k)] = json.dumps(v)
            except Exception:
                pass
        return meta or None

    @staticmethod
    def _src_file_of(url):
        """entry 里的媒体 URL → 本机文件（/view?type=temp&filename=… 或 /preview_any/fs/…）；找不到返回 None。"""
        if not isinstance(url, str):
            return None
        try:
            from urllib.parse import urlparse, parse_qs, unquote
            if url.startswith("/view?"):
                q = parse_qs(urlparse(url).query)
                fn = (q.get("filename") or [""])[0]
                if q.get("type", ["temp"])[0] == "temp" and fn:
                    cand = os.path.join(folder_paths.get_temp_directory(), os.path.basename(unquote(fn)))
                    return cand if os.path.isfile(cand) else None
            elif url.startswith("/preview_any/fs/"):
                cand = unquote(url[len("/preview_any/fs/"):])
                return cand if os.path.isfile(cand) else None
        except Exception:
            pass
        return None

    @staticmethod
    def _image_save_bytes(src_file, raw, fmt, quality, meta):
        """一张图 → (存档 bytes, 扩展名)：优先原图文件，退回复预览 bytes；失败 (None, None)。"""
        from io import BytesIO
        from PIL import Image as _Im
        if fmt == "png":
            if src_file and not meta:
                with open(src_file, "rb") as fh:
                    return fh.read(), ".png"          # 原图直存：零重编码、零损失
            if src_file:
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
                return buf.getvalue(), ".png"
            if raw is None:
                return None, None
            return raw, ".png"
        if src_file:
            img = _Im.open(src_file)
        elif raw is not None:
            img = _Im.open(BytesIO(raw))
        else:
            return None, None
        buf = BytesIO()
        kwargs = {"quality": quality} if fmt in ("jpeg", "webp") else {}
        if fmt == "jpeg" and img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        # 非 PNG 也带上 workflow/prompt：JPEG 写 EXIF UserComment，WebP 写 XMP（Pillow 支持时）。
        if meta:
            try:
                _payload = "\n".join("%s=%s" % (k, v) for k, v in meta.items())
                if fmt == "jpeg":
                    ex = img.getexif()
                    ex[0x9286] = _payload          # UserComment
                    kwargs["exif"] = ex.tobytes()
                elif fmt == "webp":
                    kwargs["xmp"] = _payload.encode("utf-8")
            except Exception:
                pass
        img.save(buf, format=fmt.upper(), **kwargs)
        return buf.getvalue(), "." + fmt

    def _save_target_dir(self, cfg):
        """存档目录：相对路径落在 output 下；绝对路径只允许 output 或本机登记过的目录。"""
        rel = cfg.get("savePath", "").strip()
        base = _ez_real(PreviewAnyNode._output_dir())
        if os.path.isabs(rel):
            # 绝对路径只允许 output，或本机「选择文件夹」对话框登记过的目录（服务端状态）
            dirpath = _ez_inside(rel, _ez_save_roots() + [base])
        else:
            dirpath = _ez_inside(os.path.join(base, rel), [base])
        if not dirpath:
            print(f"[PreviewAny] save path {rel!r} is outside the allowed save folders; saved under output instead")
            dirpath = base
        os.makedirs(dirpath, exist_ok=True)
        return dirpath

    def _save_image_batch(self, entry, cfg, name, sources, fmt, quality, meta):
        """批次图片存档：默认逐张存图片序列；选「合成视频」或判定为抽帧时，编成一个视频。
        name_<counter>_NN.<ext>；saved_path 指向第一张，saved_paths 给全部。"""
        try:
            dirpath = self._save_target_dir(cfg)
        except Exception:
            return entry
        base, counter = PreviewAnyNode._save_base(cfg, dirpath, name)
        sf = cfg.get("saveFormats") or {}
        acfg = sf.get("animated") if isinstance(sf.get("animated"), dict) else {}
        # 多图保存为是**全局**的（节点 config 的 batchMode）；动图格式走独立的 animated 段
        mode = str(cfg.get("batchMode") or "auto")
        if mode == "auto":
            mode = "video" if entry.get("batch_kind") == "frames" else "images"   # 抽帧 → 视频；批量出图 → 序列
        if mode == "animation":
            afmt = str(acfg.get("fmt") or "webp")
            afps = acfg.get("afps") or 6
            _al = acfg.get("alossless")
            aloss = not (_al is False or str(_al).strip().lower() in ("no", "false", "0", "off"))
            paths = [p for p in (PreviewAnyNode._src_file_of(u) for u in sources) if p and os.path.isfile(p)]
            res = _encode_frames_animated(paths, afmt, afps, acfg.get("quality") or quality, aloss, acfg.get("method"))
            if res and res[1].lower() in _SAVE_ALLOWED_EXTS:
                data, ext = res
                fname = f"{base}_{counter + 1:05}{ext}"
                try:
                    with open(os.path.join(dirpath, fname), "wb") as fh:
                        fh.write(data)
                    p = os.path.abspath(os.path.join(dirpath, fname))
                    entry["saved_path"] = p; entry["saved_name"] = os.path.basename(p); entry["saved_paths"] = [p]
                    return entry
                except Exception:
                    pass
            # 编不出来就退回图片序列
        if mode == "video":
            vcfg = sf.get("video") if isinstance(sf.get("video"), dict) else {}
            vfmt = str(vcfg.get("fmt") or "") or "mp4"
            if vfmt not in ("mp4", "webm", "mov", "mkv", "avi"):
                vfmt = "mp4"
            paths = [p for p in (PreviewAnyNode._src_file_of(u) for u in sources) if p and os.path.isfile(p)]
            res = _encode_frames_to_video(paths, entry.get("fps") or vcfg.get("fps") or 24, vfmt, vcfg.get("codec") or "", vcfg.get("crf"),
                                         bit_depth=vcfg.get("bit_depth", ""), color_space=vcfg.get("color_space", ""),
                                         preset=vcfg.get("preset", ""),
                                         metadata=meta)   # meta 已由 _maybe_save 按 extra_pnginfo 算好；这里再用 extra_pnginfo 会 NameError
            if res and res[1].lower() in _SAVE_ALLOWED_EXTS:
                data, ext = res
                fname = f"{base}_{counter + 1:05}{ext}"
                try:
                    with open(os.path.join(dirpath, fname), "wb") as fh:
                        fh.write(data)
                    p = os.path.abspath(os.path.join(dirpath, fname))
                    entry["saved_path"] = p; entry["saved_name"] = os.path.basename(p); entry["saved_paths"] = [p]
                    return entry
                except Exception:
                    pass
            # 编不出来就退回图片序列
        written = []
        for i, url in enumerate(sources):
            data, ext = PreviewAnyNode._image_save_bytes(PreviewAnyNode._src_file_of(url), None, fmt, quality, meta)
            if data is None or not ext or ext.lower() not in _SAVE_ALLOWED_EXTS:
                continue
            fname = f"{base}_{counter + 1:05}_{i + 1:02d}{ext}"
            try:
                with open(os.path.join(dirpath, fname), "wb") as fh:
                    fh.write(data)
            except Exception:
                continue
            written.append(os.path.abspath(os.path.join(dirpath, fname)))
        if written:
            entry["saved_path"] = written[0]
            entry["saved_name"] = os.path.basename(written[0])
            entry["saved_paths"] = written
        return entry

    def _maybe_save(self, entry, cfg, name, extra_pnginfo=None):
        """存档开启时把卡片内容写到 <output>/<savePath>/，并回填 saved_path。
        图片存档用「原图」（与全屏同一份导出文件），不是预览缩图；PNG 会带上工作流/提示词元数据（对齐内置 Save Image）。"""
        if not cfg.get("save") or entry.get("save_skip"):
            return entry      # save_skip：值是从文件加载来的（LoadImage/LoadVideo/LoadAudio/Load3D…），不是本次生成物，无需再存一份
        data = None
        ext = None
        copy_src = None      # 无需转码时直接文件拷贝（大视频/3D 不再整个读进内存）
        sf = cfg.get("saveFormats") or {}
        # 视频/音频卡片也带 preview（视频是封面图）：先让它们走各自的媒体分支，别把封面当图片存了
        if entry.get("preview") and not entry.get("audio") and not entry.get("audio_src") and not entry.get("video") and not entry.get("video_src"):
            try:
                img_cfg = sf.get("image")
                fmt = ""; quality = 95
                if isinstance(img_cfg, dict):
                    fmt = str(img_cfg.get("fmt") or "")
                    try: quality = int(img_cfg.get("quality") or 95)
                    except Exception: quality = 95
                meta = PreviewAnyNode._png_meta(extra_pnginfo)
                sources = entry.get("images") or []
                if len(sources) > 1:
                    return self._save_image_batch(entry, cfg, name, sources, fmt or "png", quality, meta)   # 批次逐张存档
                raw = base64.b64decode(entry["preview"])       # 兜底：预览图（MASK 等没有原图导出时）
                # 优先用原图文件（_export_image_url 导出的全分辨率 PNG，全屏看的就是它）
                src_file = PreviewAnyNode._src_file_of(entry.get("image_src"))
                if not fmt and src_file:      # 「保持原样」：加载进来的原图直接复制，不重编码
                    with open(src_file, "rb") as fh:
                        data = fh.read()
                    ext = os.path.splitext(src_file)[1].lower()
                    # ★ copy 路径也要带上 prompt/workflow：PNG 直接插 iTXt 块，像素一个字节都不动
                    if ext == ".png" and meta:
                        _tagged = _png_add_text(data, meta)
                        if _tagged:
                            data = _tagged
                else:
                    data, ext = PreviewAnyNode._image_save_bytes(src_file, raw, fmt or "png", quality, meta)
            except Exception:
                data = None
        elif entry.get("audio") or entry.get("audio_src"):
            try:
                raw = None
                src_path = None
                if entry.get("audio_src"):
                    from urllib.parse import urlparse, parse_qs
                    _q = parse_qs(urlparse(entry["audio_src"]).query)
                    p = (_q.get("path") or [None])[0]
                    if not p and _q.get("filename"):     # /view?type=temp&filename=… → 到临时目录取原文件
                        p = os.path.join(folder_paths.get_temp_directory(), _q["filename"][0])
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
                    afmt = ""; bitrate = "192k"; sr = None
                    if isinstance(acfg, dict):
                        afmt = str(acfg.get("fmt") or "")
                        bitrate = acfg.get("bitrate") or "192k"
                        sr = acfg.get("sr")
                    src_ext = os.path.splitext(src_path)[1].lower() if src_path else ""
                    if not afmt:
                        afmt = src_ext.lstrip(".") if src_path else "wav"   # 保持原样：加载进来的音频不重编码
                    if src_path and src_ext == ("." + str(afmt).lower().lstrip(".")) and not sr:
                        data, ext = raw, src_ext          # 格式一致且没改采样率 → 直接落盘，不重新编码
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
                    vfmt = ""; vcodec = ""; crf = None; fps = None
                    if isinstance(vcfg, dict):
                        vfmt = str(vcfg.get("fmt") or "")
                        vcodec = vcfg.get("codec") or ""
                        crf = vcfg.get("crf"); fps = vcfg.get("fps")
                    _v = vcfg if isinstance(vcfg, dict) else {}
                    res = _encode_video(raw, vfmt, vcodec, crf, fps,
                                        bit_depth=_v.get("bit_depth", ""), color_space=_v.get("color_space", ""),
                                        preset=_v.get("preset", ""), acodec=_v.get("acodec", ""),
                                        abitrate=_v.get("abitrate"), asr=_v.get("asr"),
                                        metadata=PreviewAnyNode._png_meta(extra_pnginfo))
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
                    vcfg = sf.get("video")
                    vfmt = ""; vcodec = ""; crf = None; fps = None
                    if isinstance(vcfg, dict):
                        vfmt = str(vcfg.get("fmt") or "")
                        vcodec = vcfg.get("codec") or ""
                        crf = vcfg.get("crf"); fps = vcfg.get("fps")
                    src_ext = os.path.splitext(src)[1].lower()
                    if not vfmt:
                        vfmt = src_ext.lstrip(".")      # 保持原样：加载进来的视频不重编码（容器相同就直接复制，保音轨）
                    _v = vcfg if isinstance(vcfg, dict) else {}
                    _changed = any(_v.get(k) for k in ("bit_depth", "color_space", "preset", "acodec", "abitrate", "asr"))
                    _fmt_keep = str(vfmt).lower() in ("", "auto") or src_ext == ("." + str(vfmt).lower().lstrip("."))
                    _codec_keep = str(vcodec).lower() in ("", "auto")
                    if _fmt_keep and _codec_keep and not crf and not fps and not _changed:
                        # 格式/编码都没改 → 直接落盘（保留音轨）。只有需要塞元数据时才读字节做容器级重封装，
                        # 否则按文件拷贝（几百 MB~GB 的成片不再整份进内存）。
                        _meta = PreviewAnyNode._png_meta(extra_pnginfo)
                        if _meta:
                            with open(src, "rb") as fh:
                                raw = fh.read()
                            _tagged = _remux_with_meta(raw, src_ext, _meta)
                            if _tagged:
                                data, ext = _tagged
                        if data is None:
                            copy_src, ext = src, src_ext
                    else:
                        with open(src, "rb") as fh:
                            raw = fh.read()
                        res = _encode_video(raw, vfmt, vcodec, crf, fps,
                                            bit_depth=_v.get("bit_depth", ""), color_space=_v.get("color_space", ""),
                                            preset=_v.get("preset", ""), acodec=_v.get("acodec", ""),
                                            abitrate=_v.get("abitrate"), asr=_v.get("asr"),
                                            metadata=PreviewAnyNode._png_meta(extra_pnginfo))
                        if res:
                            data, ext = res
            except Exception:
                data = None
        elif entry.get("save_src"):
            # 3D / MESH：源文件直接复制到存档目录（生成的 3D 跟着自动存档走）。
            # 不做格式转换（safetensors→gguf 那种要重新导出），
            # 选了别的扩展名时按源文件格式落盘，避免写出一个名不副实的文件。
            try:
                src = entry["save_src"]
                if os.path.isfile(src):
                    src_ext = os.path.splitext(src)[1].lower()
                    mcfg = sf.get("model3d") if entry.get("type") in ("MODEL_3D", "FILE_3D") else sf.get("model")
                    want = ""
                    if isinstance(mcfg, dict):
                        want = str(mcfg.get("fmt") or "").lower().lstrip(".")
                    ext = ("." + want) if want else src_ext
                    if want and ext != src_ext:
                        ext = src_ext
                    copy_src = src      # 3D 模型可能很大：按文件拷贝，不读进内存
            except Exception:
                data = None
        elif entry.get("value"):
            _txt = str(entry.get("full_value") or entry["value"])
            if entry.get("meta"):                     # 模型卡片：摘要正文 + 元数据 JSON，都写进信息文本
                _txt += "\n\n" + str(entry["meta"])
            data = _txt.encode("utf-8")
            tf = sf.get("text")
            text_fmt = tf.get("fmt", "txt") if isinstance(tf, dict) else (tf if isinstance(tf, str) else "txt")
            ext = "." + (text_fmt if text_fmt in ("txt", "md", "json", "csv", "log", "html") else "txt")
        if data is None and not copy_src:
            return entry
        if not ext or ext.lower() not in _SAVE_ALLOWED_EXTS:
            return entry      # 只写媒体/文本文档后缀；未知格式（.bat/.desktop/.sh 等）不落盘
        try:
            dirpath = self._save_target_dir(cfg)
            base, counter = PreviewAnyNode._save_base(cfg, dirpath, name)
            fname = f"{base}_{counter + 1:05}{ext}"
            fpath = os.path.join(dirpath, fname)
            if copy_src:
                _tmp = fpath + ".tmp"
                shutil.copyfile(copy_src, _tmp)
                os.replace(_tmp, fpath)
            else:
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


def _bitrate_int(s):
    """码率：接受 '192k' / '192000' / 192（裸数字 < 1000 当 kbps）。"""
    try:
        if isinstance(s, (int, float)):
            n = int(s)
            return n * 1000 if 0 < n < 1000 else n
        s = str(s).strip().lower()
        if s.endswith("k"):
            return int(float(s[:-1]) * 1000)
        n = int(float(s))
        return n * 1000 if 0 < n < 1000 else n
    except Exception:
        return None


def _encode_audio(data_bytes, fmt, bitrate=None, sample_rate=None):
    """把 WAV 字节按所选格式/码率/采样率重编码（av）。"""
    try:
        import av
        from io import BytesIO
        fmt = (fmt or "wav").lower()
        codec = {"wav": "pcm_s16le", "mp3": "libmp3lame", "flac": "flac", "ogg": "libvorbis", "m4a": "aac", "aac": "aac", "opus": "libopus"}.get(fmt)
        if not codec:
            return data_bytes, "." + fmt
        container = {"m4a": "mp4", "aac": "adts", "opus": "ogg"}.get(fmt, fmt)   # pyav 的容器名和扩展名不总一样
        oidx = BytesIO()
        fsrc = BytesIO(data_bytes); fsrc.seek(0)
        with av.open(fsrc, mode="r") as inp:
            with av.open(oidx, mode="w", format=container) as out:
                ostream = out.add_stream(codec)
                if fmt not in ("wav", "flac"):   # 无损格式码率由内容决定，设了也没用
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


def _encode_frames_animated(paths, fmt, fps, quality=None, lossless=True, method=None):
    """一批帧 → 动图（webp / png / gif），参数对齐内置 SaveAnimatedWEBP / SaveAnimatedPNG。"""
    try:
        if not paths:
            return None
        from io import BytesIO
        from PIL import Image
        fmt = (fmt or "webp").lower()
        if fmt not in ("webp", "png", "gif"):
            fmt = "webp"
        imgs = []
        for p in paths:
            im = Image.open(p)
            imgs.append(im.convert("RGB" if fmt == "gif" else "RGBA"))
        if not imgs:
            return None
        dur = max(10, int(round(1000.0 / (float(fps) or 6.0))))
        buf = BytesIO()
        kw = {"save_all": True, "append_images": imgs[1:], "duration": dur, "loop": 0}
        if fmt == "webp":
            kw["lossless"] = bool(lossless)
            if not lossless and quality:
                kw["quality"] = int(quality)
            m = {"fastest": 0, "default": 4, "slowest": 6}.get(str(method or ""))
            if m is not None:
                kw["method"] = m
            imgs[0].save(buf, format="WEBP", **kw)
            return buf.getvalue(), ".webp"
        if fmt == "png":
            imgs[0].save(buf, format="PNG", **kw)
            return buf.getvalue(), ".png"
        imgs[0].save(buf, format="GIF", **kw)
        return buf.getvalue(), ".gif"
    except Exception:
        return None


_VIDEO_CODECS_BY_FMT = {
    "": ("h264", "h265", "vp9", "av1"),
    "auto": ("h264", "h265", "vp9", "av1"),
    "mp4": ("h264", "h265", "av1"),
    "mov": ("h264", "h265"),
    "webm": ("vp9", "av1"),
    "avi": ("h264",),
    "mkv": ("h264", "h265", "vp9", "av1"),
}


_AUDIO_CODECS_BY_FMT = {
    "": ("aac", "opus", "mp3"),
    "auto": ("aac", "opus", "mp3"),
    "mp4": ("aac", "mp3"),
    "mov": ("aac", "mp3"),
    "webm": ("opus",),
    "avi": ("mp3", "aac"),
    "mkv": ("aac", "opus", "mp3"),
}


_CODEC_ALIASES = {"hevc": "h265"}


def _ez_codec_key(codec):
    c = str(codec or "").strip().lower()
    return _CODEC_ALIASES.get(c, c)


def _video_combo_error(fmt, codec, acodec=""):
    """非法组合 → 中文说明；合法 → ""。"""
    f = str(fmt or "").strip().lower()
    c = _ez_codec_key(codec)
    a = str(acodec or "").strip().lower()
    ok = _VIDEO_CODECS_BY_FMT.get(f)
    if ok and c and c != "auto" and c not in ok:
        if f == "webm":
            return "WebM 只支持 VP9/AV1，不支持 %s" % c
        return "%s 容器不支持 %s 编码（可选：%s）" % (f.upper(), c, "/".join(ok))
    ao = _AUDIO_CODECS_BY_FMT.get(f)
    if ao and a and a not in ("copy", "keep", "source") and a not in ao:
        if f == "webm":
            return "WebM 只支持 Opus 音轨，不支持 %s" % a
        return "%s 容器不支持 %s 音轨（可选：%s）" % (f.upper(), a, "/".join(ao))
    return ""


def _video_encoder_name(fmt, codec):
    """容器 + 编码器 → ffmpeg/PyAV 的编码器名。auto/空按容器给默认。"""
    c = _ez_codec_key(codec)
    if c in ("h264", "h265", "vp9", "av1"):
        return {"h264": "libx264", "h265": "libx265", "vp9": "libvpx-vp9", "av1": "libsvtav1"}[c]
    return "libvpx-vp9" if str(fmt or "").lower() == "webm" else "libx264"


def _hdr_tonemap_filter(color_space, bit_depth="", src=None):
    """目标色彩空间 → (滤镜链, 像素格式)。sRGB 走 Hable tonemap，HDR PQ / HLG 走 PQ 编码。

    ★ 每一级 zscale 都必须把 in/out 的 trc/primaries/matrix 写全：ffmpeg 的 zscale 不会替我们
      推断「没标色彩信息」的源，缺一项就报 `no path between colorspaces`（源视频经常不带色彩标记）。
    `src` = 源视频的 {trc, primaries, matrix, range}；图片序列按 sRGB/BT.709 全范围处理。
    """
    src = src or {}
    tin = str(src.get("trc") or "bt709")
    pin = str(src.get("primaries") or ("bt2020" if _src_is_hdr(tin) else "bt709"))
    mtx = str(src.get("matrix") or ("bt2020nc" if pin == "bt2020" else "bt709"))
    rng = str(src.get("range") or "tv")
    head = ("zscale=tin=%s:pin=%s:min=%s:t=linear:p=%s:m=%s:r=%s,format=gbrpf32le"
            % (tin, pin, mtx, pin, mtx, rng))
    cs = str(color_space or "")
    if cs in ("HDR", "HDR PQ"):
        tail = ("zscale=tin=linear:pin=%s:min=%s:t=%s:p=bt2020:m=bt2020nc:r=tv,format=yuv420p10le"
                % (pin, mtx, "smpte2084" if cs == "HDR PQ" else "arib-std-b67"))
        return head + "," + tail, "yuv420p10le"
    mid = ("zscale=tin=linear:pin=%s:min=%s:t=linear:p=bt709:m=bt709:r=tv,tonemap=tonemap=hable:desat=0,"
           "zscale=tin=linear:pin=bt709:min=bt709:t=bt709:p=bt709:m=bt709:r=tv,"
           % (pin, mtx))
    if str(bit_depth) == "10":
        return head + "," + mid + "format=yuv420p10le", "yuv420p10le"
    return head + "," + mid + "format=yuv420p", "yuv420p"


def _src_is_hdr(trc):
    if isinstance(trc, int):
        return trc in (16, 18)          # AVCOL_TRC_SMPTE2084 / ARIB_STD_B67
    t = str(trc or "").lower()
    return ("smpte2084" in t) or ("arib-std-b67" in t) or t in ("16", "18")


def _container_of(fmt_obj):
    """PyAV demuxer 名 → 输出容器。matroska/webm 都归 mkv（两者可互装），mov/mp4 同名按 mp4 走。"""
    try:
        n = str(getattr(fmt_obj, "name", "") or "").lower()
    except Exception:
        return "mp4"
    if "matroska" in n or "webm" in n:
        return "mkv"
    if "avi" in n:
        return "avi"
    return "mp4"


_Z_TRC_NAMES = {1: "bt709", 8: "linear", 13: "iec61966-2-1", 16: "smpte2084", 18: "arib-std-b67"}


_Z_PRIM_NAMES = {1: "bt709", 9: "bt2020", 12: "smpte432", 22: "display-p3"}


_Z_MATRIX_NAMES = {1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020nc", 10: "bt2020c"}


_Z_TRC = tuple(_Z_TRC_NAMES.values())


_Z_PRIMARIES = tuple(_Z_PRIM_NAMES.values())


_Z_MATRIX = tuple(_Z_MATRIX_NAMES.values())


def _zname(val, table, allowed):
    if isinstance(val, int):
        val = table.get(val, "")
    s = str(val or "").strip().lower()
    return s if s in allowed else ""


def _src_color_props(vstream):
    """源视频流的色彩三元组 + 范围（ffmpeg 侧没标色彩信息时返回空串，让滤镜走默认）。"""
    try:
        cc = vstream.codec_context
        _rng = getattr(cc, "color_range", None)
        _full = _rng in (2, "pc", "jpeg", "full")
        return {
            "trc": _zname(getattr(cc, "color_trc", None), _Z_TRC_NAMES, _Z_TRC),
            "primaries": _zname(getattr(cc, "color_primaries", None), _Z_PRIM_NAMES, _Z_PRIMARIES),
            "matrix": _zname(getattr(cc, "colorspace", None), _Z_MATRIX_NAMES, _Z_MATRIX),
            "range": "pc" if _full else "tv",
        }
    except Exception:
        return {}


def _video_color_args(color_space):
    """输出流的色彩标记：HDR = BT.2020 + PQ/HLG；SDR = BT.709。"""
    cs = str(color_space or "")
    if cs in ("HDR", "HDR PQ"):
        return ["-colorspace", "bt2020nc", "-color_primaries", "bt2020",
                "-color_trc", "arib-std-b67" if cs == "HDR" else "smpte2084"]
    if cs == "sRGB":
        return ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
    return []


def _metadata_args(metadata, fmt):
    """prompt/workflow → 容器元数据参数（MP4/MOV 需要 use_metadata_tags 才写自定义键）。

    ★ 这些键最终落在**命令行**上，而 Windows 的 CreateProcess 上限是 32767 字符：
    整份 workflow/prompt JSON 动辄几十万字符，会直接 OSError(WinError 206)，而编码器把异常吞成
    「没生成文件、也没报错」（2026-11 审计 H-11）。超长时丢掉大字段（workflow/prompt），保住文件本身。
    """
    if not metadata:
        return []
    items = [(k, v) for k, v in dict(metadata).items()]
    total = sum(len(str(k)) + len(str(v)) + 16 for k, v in items)
    if total > 7000:
        items = [(k, v) for k, v in items if str(k).lower() not in ("workflow", "prompt")]
        print("[PreviewAny] metadata too long for the command line (%d chars): "
              "workflow/prompt dropped so the file still gets written." % total)
    args = []
    for k, v in items:
        args += ["-metadata", "%s=%s" % (k, v)]
    if str(fmt or "").lower() in ("mp4", "mov", "auto", ""):
        args += ["-movflags", "use_metadata_tags"]
    return args


def _audio_codec_args(fmt, acodec, abitrate=None, asr=None):
    """音频编码参数（copy = 直接复制音轨）。"""
    ac = str(acodec or "").strip().lower()
    if ac in ("", "copy", "keep", "source"):
        # WebM 装不了 AAC：copy 会直接失败，而失败被吞成「没有文件」。这里强制转 opus。
        if str(fmt or "").lower() == "webm":
            return ["-c:a", "libopus"]
        return ["-c:a", "copy"]
    args = ["-c:a", {"opus": "libopus", "mp3": "libmp3lame"}.get(ac, "aac")]
    b = _bitrate_int(abitrate)
    if b:
        args += ["-b:a", str(b)]
    if asr:
        args += ["-ar", str(int(asr))]
    return args


def _tonemap_video_cli(data_bytes, fmt, codec, crf=None, fps=None, bit_depth="", color_space="",
                       preset="", acodec="", abitrate=None, asr=None, metadata=None, src=None):
    """源视频与目标色彩空间不一致时**真的转一次**（HDR→SDR 用 Hable tonemap，SDR→HDR 按 BT.2020 重新编码）。"""
    try:
        import tempfile
        import subprocess
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        fmt = str(fmt or "mp4").strip().lower()
        if fmt in ("", "auto"):
            fmt = "mp4"
        if fmt not in ("mp4", "mkv", "webm", "mov", "avi"):
            fmt = "mp4"
        err = _video_combo_error(fmt, codec, acodec)
        if err:
            print("[PreviewAny] " + err)
            return None
        vf, pix = _hdr_tonemap_filter(color_space, bit_depth, src)
        inp = tempfile.NamedTemporaryFile(delete=False, suffix=".src")
        out = tempfile.NamedTemporaryFile(delete=False, suffix="." + fmt)
        try:
            inp.write(data_bytes); inp.close(); out.close()
            cmd = [exe, "-y", "-i", inp.name, "-map", "0:v:0", "-map", "0:a?",
                   "-vf", vf, "-c:v", _video_encoder_name(fmt, codec), "-pix_fmt", pix]
            if crf is not None and float(crf) >= 0:
                cmd += ["-crf", str(int(float(crf)))]
            if preset:
                cmd += ["-preset", str(preset)]
            if fps:
                cmd += ["-r", str(fps)]
            cmd += _video_color_args(color_space)
            cmd += _audio_codec_args(fmt, acodec, abitrate, asr)
            cmd += _metadata_args(metadata, fmt)
            cmd.append(out.name)
            rv = subprocess.run(cmd, capture_output=True)
            if rv.returncode != 0 or not os.path.isfile(out.name) or os.path.getsize(out.name) == 0:
                print("[PreviewAny] 色调映射失败：" + (rv.stderr or b"").decode("utf-8", "ignore")[-300:])
                return None
            with open(out.name, "rb") as fh:
                return fh.read(), "." + fmt
        finally:
            for p in (inp.name, out.name):
                try:
                    os.remove(p)
                except Exception:
                    pass
    except Exception as exc:
        print("[PreviewAny] 色调映射异常：%s" % exc)
        return None


def _frames_tonemap_cli(paths, fps, fmt="mp4", codec="", crf=None, bit_depth="", color_space="",
                        preset="", metadata=None):
    """图片序列（SDR 原图）→ HDR 视频：先按号段落到临时目录，再用 zscale 走 BT.2020/PQ 编码。"""
    try:
        import tempfile
        import subprocess
        import imageio_ffmpeg
        import shutil
        import uuid
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        fmt = str(fmt or "mp4").strip().lower()
        if fmt in ("", "auto"):
            fmt = "mp4"
        if fmt not in ("mp4", "mkv", "webm", "mov", "avi"):
            fmt = "mp4"
        err = _video_combo_error(fmt, codec, "")
        if err:
            print("[PreviewAny] " + err)
            return None
        # 号段直接放在系统临时目录（不建子目录：受限环境里新建目录可能没有写权限）
        seq = os.path.join(tempfile.gettempdir(), "ezpv_hdr_%s_%%06d.png" % uuid.uuid4().hex[:8])
        out = tempfile.NamedTemporaryFile(delete=False, suffix="." + fmt)
        out.close()
        try:
            for i, p in enumerate(paths, 1):
                dst = seq % i
                try:
                    os.link(p, dst)
                except Exception:
                    shutil.copyfile(p, dst)
            vf, pix = _hdr_tonemap_filter(color_space, bit_depth,
                                          {"trc": "bt709", "primaries": "bt709", "matrix": "bt709", "range": "pc"})
            rate = float(fps) if fps else 24
            cmd = [exe, "-y", "-framerate", str(rate), "-i", seq,
                   "-vf", vf, "-c:v", _video_encoder_name(fmt, codec), "-pix_fmt", pix]
            if crf is not None and float(crf) >= 0:
                cmd += ["-crf", str(int(float(crf)))]
            if preset:
                cmd += ["-preset", str(preset)]
            cmd += _video_color_args(color_space)
            cmd += _metadata_args(metadata, fmt)
            cmd.append(out.name)
            rv = subprocess.run(cmd, capture_output=True)
            if rv.returncode != 0 or not os.path.isfile(out.name) or os.path.getsize(out.name) == 0:
                print("[PreviewAny] HDR 帧编码失败：" + (rv.stderr or b"").decode("utf-8", "ignore")[-300:])
                return None
            with open(out.name, "rb") as fh:
                return fh.read(), "." + fmt
        finally:
            for i in range(1, len(paths) + 1):
                try:
                    os.remove(seq % i)
                except Exception:
                    pass
            try:
                os.remove(out.name)
            except Exception:
                pass
    except Exception as exc:
        print("[PreviewAny] HDR 帧编码异常：%s" % exc)
        return None


def _png_add_text(data, meta):
    """给现成的 PNG **不重编码**补 prompt/workflow 文本块（插在 IEND 前；copy 存档路径用）。"""
    if not data or not meta or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    try:
        import struct
        import zlib
        tail = struct.pack(">I", 0) + b"IEND"
        start = data.rfind(tail)
        if start < 8:
            return None
        chunks = b""
        for k, v in dict(meta).items():
            body = (str(k).encode("latin-1", "replace") + b"\x00"
                    + b"\x00\x00" + b"\x00" + b"\x00"
                    + str(v).encode("utf-8", "replace"))
            chunks += (struct.pack(">I", len(body)) + b"iTXt" + body
                       + struct.pack(">I", zlib.crc32(b"iTXt" + body) & 0xFFFFFFFF))
        return data[:start] + chunks + data[start:]
    except Exception:
        return None


def _remux_with_meta(data_bytes, ext, metadata):
    """视频 copy 存档：流拷贝（不重编码）+ 补 prompt/workflow 元数据。失败返回 None。"""
    try:
        import tempfile
        import subprocess
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        f = str(ext or "").lstrip(".").lower()
        if f not in ("mp4", "mkv", "webm", "mov", "avi") or not data_bytes or not metadata:
            return None
        inp = tempfile.NamedTemporaryFile(delete=False, suffix="." + f)
        out = tempfile.NamedTemporaryFile(delete=False, suffix="." + f)
        try:
            inp.write(data_bytes); inp.close(); out.close()
            cmd = [exe, "-y", "-i", inp.name, "-map", "0", "-c", "copy"]
            cmd += _metadata_args(metadata, f)
            cmd.append(out.name)
            rv = subprocess.run(cmd, capture_output=True)
            if rv.returncode != 0 or not os.path.isfile(out.name) or os.path.getsize(out.name) == 0:
                return None
            with open(out.name, "rb") as fh:
                return fh.read(), "." + f
        finally:
            for p in (inp.name, out.name):
                try:
                    os.remove(p)
                except Exception:
                    pass
    except Exception:
        return None


def _encode_frames_to_video(paths, fps, fmt="mp4", codec="", crf=None, bit_depth="", color_space="", preset="", metadata=None):
    """一串图片帧 → 一个视频（内置 SaveVideo / SaveWEBM 做的事，PreviewAny 抽帧存档用）。"""
    try:
        if not paths:
            return None
        import av
        from io import BytesIO
        fmt = str(fmt or "mp4").lower()
        if fmt == "auto":
            fmt = "mp4"
        err = _video_combo_error(fmt, codec, "")
        if err:
            print("[PreviewAny] " + err)
            return None
        # HDR 目标：原图是 sRGB，必须真的做一次 SDR→HDR 变换，不能只贴 HDR 标签
        if str(color_space) in ("HDR", "HDR PQ"):
            res = _frames_tonemap_cli(paths, fps, fmt, codec, crf, bit_depth, color_space, preset, metadata)
            if res:
                return res
            print("[PreviewAny] 图片序列的色彩空间转换没做成 ⇒ 不写出错色的文件")
            return None
        # 没选编码器时按容器给默认：webm 用 vp9、其它用 h264（libx264 写 webm 会失败）
        codec_name = _video_encoder_name(fmt, codec)
        container = {"mkv": "matroska", "mov": "mov", "avi": "avi"}.get(fmt, fmt)
        rate = float(fps) if fps else 24
        oidx = BytesIO()
        with av.open(oidx, mode="w", format=container) as out:
            if metadata:
                for _mk, _mv in dict(metadata).items():
                    try:
                        out.metadata[str(_mk)] = str(_mv)
                    except Exception:
                        pass
            stream = out.add_stream(codec_name, rate=rate)
            stream.pix_fmt = "yuv420p10le" if str(bit_depth) == "10" else "yuv420p"
            _opts = {}
            if crf:
                _opts["crf"] = str(int(crf))
            if preset:
                _opts["preset"] = str(preset)
            if str(color_space) in ("HDR", "HDR PQ"):
                _opts["colorspace"] = "bt2020nc"
                _opts["color_primaries"] = "bt2020"
                _opts["color_trc"] = "arib-std-b67" if str(color_space) == "HDR" else "smpte2084"
            if _opts:
                try:
                    stream.options = _opts
                except Exception:
                    pass
            for p in paths:
                with av.open(p, mode="r") as im:
                    for frame in im.decode(video=0):
                        frame.pts = None
                        for pkt in stream.encode(frame):
                            out.mux(pkt)
            for pkt in stream.encode():
                out.mux(pkt)
        oidx.seek(0)
        return oidx.getvalue(), "." + fmt
    except Exception:
        return None


def _encode_video_cli(data_bytes, fmt, codec, crf=None, bit_depth="", color_space="", preset="", acodec="", abitrate=None, asr=None, metadata=None):
    """h265/vp9 的 PyAV 编码器在部分 Windows 构建里缺失，退回系统 ffmpeg。"""
    try:
        import tempfile
        import subprocess
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        fmt = str(fmt or "mp4").lower()
        if fmt not in ("mp4", "mkv", "webm", "mov", "avi"):
            fmt = "mp4"
        err = _video_combo_error(fmt, codec, acodec)
        if err:
            print("[PreviewAny] " + err)
            return None
        inp = tempfile.NamedTemporaryFile(delete=False, suffix=".src")
        out = tempfile.NamedTemporaryFile(delete=False, suffix="." + fmt)
        try:
            inp.write(data_bytes); inp.close(); out.close()
            vc = "libx265" if str(codec).lower() in ("h265", "hevc") else "libvpx-vp9"
            cmd = [exe, "-y", "-i", inp.name, "-map", "0:v:0", "-map", "0:a?", "-c:v", vc]
            if str(bit_depth) == "10":
                cmd += ["-pix_fmt", "yuv420p10le"]
            if crf is not None and float(crf) >= 0:
                cmd += ["-crf", str(int(float(crf)))]
            if preset:
                cmd += ["-preset", str(preset)]
            cmd += _video_color_args(color_space)
            cmd += _audio_codec_args(fmt, acodec, abitrate, asr)
            cmd += _metadata_args(metadata, fmt)
            cmd.append(out.name)
            rv = subprocess.run(cmd, capture_output=True)
            if rv.returncode != 0 or not os.path.isfile(out.name):
                return None
            with open(out.name, "rb") as fh:
                return fh.read(), "." + fmt
        finally:
            for p in (inp.name, out.name):
                try:
                    os.remove(p)
                except Exception:
                    pass
    except Exception:
        return None


def _encode_video(data_bytes, fmt, codec="h264", crf=None, fps=None,
                  bit_depth="", color_space="", preset="", acodec="", abitrate=None, asr=None, metadata=None):
    """按所选容器/编码器/CRF/帧率重编码视频。**音轨跟着一起走**（内置 Save Video 也是这么做的）：
    优先原样复制音轨（不重编码），容器不吃这个音频编码时再转码；实在不行才退回纯视频。"""
    try:
        import av
        from io import BytesIO
        _raw_fmt = str(fmt or "auto").strip().lower()
        _raw_codec = _ez_codec_key(codec) or "auto"
        # 选了明确的编码器但容器是「跟随源」⇒ 直接落到该编码器的默认容器（否则源容器可能装不下）
        if _raw_fmt in ("", "auto") and _raw_codec in ("h265", "vp9", "av1"):
            _raw_fmt = {"vp9": "webm", "av1": "mp4"}.get(_raw_codec, "mp4")
        _audio_extra = bool(acodec or abitrate or asr)
        # ★ 组合约束先于一切编码分支：h265/vp9 走 CLI、webm 走 WebM muxer，
        #   放在分支里面校验会让非法组合（webm+h265、mp4+vp9…）写出坏文件。
        _combo_err = _video_combo_error(_raw_fmt, _raw_codec, acodec)
        if _combo_err:
            print("[PreviewAny] " + _combo_err)
            return None
        # ★ 源 HDR / 目标 SDR（或反过来）⇒ 真的做一次色调映射，不是只改色彩标记。
        _want_cs = str(color_space or "")
        if _want_cs in ("sRGB", "HDR", "HDR PQ"):
            _src_color = {}
            _src_fmt = ""
            try:
                _pc = av.open(BytesIO(data_bytes), mode="r")
                _vs = next((s for s in _pc.streams if s.type == "video"), None)
                _trc = str(getattr(_vs.codec_context, "color_trc", "") or "") if _vs is not None else ""
                _src_color = _src_color_props(_vs) if _vs is not None else {}
                _src_fmt = _container_of(_pc.format)
                _pc.close()
            except Exception:
                _trc = ""
            if _src_is_hdr(_trc) != (_want_cs in ("HDR", "HDR PQ")):
                # 容器「跟随源」时用源的容器，别把 mkv 硬转成 mp4
                _tm_fmt = _raw_fmt if _raw_fmt not in ("", "auto") else (_src_fmt or "mp4")
                _tm = _tonemap_video_cli(data_bytes, _tm_fmt, _raw_codec, crf, fps, bit_depth,
                                         _want_cs, preset, acodec, abitrate, asr, metadata, _src_color)
                if _tm:
                    return _tm
                print("[PreviewAny] 源视频与目标色彩空间不一致，色调映射没做成 ⇒ 不写出错色的文件")
                return None
        if _raw_codec in ("h265", "vp9"):
            res = _encode_video_cli(data_bytes, _raw_fmt, _raw_codec, crf, bit_depth, color_space, preset,
                                    acodec, abitrate, asr, metadata)
            if res:
                return res
        # Common path: h264/av1 in mp4/mkv/webm/auto with no audio overrides -> use the same
        # VideoFromFile.save_to as built-in SaveVideo (HDR/10bit/container semantics included).
        if (_raw_fmt in ("", "auto", "mp4", "mkv", "webm")
                and _raw_codec in ("", "auto", "h264", "av1")
                and not fps and not _audio_extra):
            try:
                from comfy_api.latest import InputImpl, Types
                _out = BytesIO()
                _vin = InputImpl.VideoFromFile(BytesIO(data_bytes))
                _fmt_map = {"": Types.VideoContainer.AUTO, "auto": Types.VideoContainer.AUTO,
                            "mp4": Types.VideoContainer.MP4, "mkv": Types.VideoContainer.MKV,
                            "webm": Types.VideoContainer.WEBM}
                _c_map = {"": Types.VideoCodec.AUTO, "auto": Types.VideoCodec.AUTO,
                          "h264": Types.VideoCodec.H264, "av1": Types.VideoCodec.AV1}
                _bd = None
                if str(bit_depth) in ("8", "10"):
                    _bd = int(bit_depth)
                _cs = str(color_space) if str(color_space) in ("sRGB", "HDR", "HDR PQ") else None
                _crf = None
                try:
                    if crf is not None and float(crf) >= 0:
                        _crf = float(crf)
                except (TypeError, ValueError):
                    pass
                _vin.save_to(_out, format=_fmt_map[_raw_fmt], codec=_c_map[_raw_codec],
                             crf=_crf, bit_depth=_bd, color_space=_cs,
                             preset=str(preset) if preset else None, metadata=metadata)
                _out.seek(0)
                _data = _out.getvalue()
                if _data:
                    return _data, "." + ("mkv" if _raw_fmt == "mkv" else "webm" if _raw_fmt == "webm" else "mp4")
            except Exception:
                pass
        fmt = _raw_fmt
        if fmt in ("", "auto"):
            try:
                _pr = av.open(BytesIO(data_bytes), mode="r")
                fmt = _container_of(_pr.format)
                _pr.close()
            except Exception:
                fmt = "mp4"
        # auto codec = preserve the source codec; otherwise pick a container-compatible encoder.
        if _ez_codec_key(codec) in ("", "auto"):
            try:
                _pc = av.open(BytesIO(data_bytes), mode="r")
                _vs = next((s for s in _pc.streams if s.type == "video"), None)
                _cc = str(getattr(_vs, "codec_context", None) and _vs.codec_context.name or "").lower() if _vs is not None else ""
                _pc.close()
                codec = _cc if _cc in ("h264", "h265", "hevc", "vp9", "av1") else ""
            except Exception:
                codec = ""
        codec = _ez_codec_key(codec)
        # 保源编码时源编码可能进不了目标容器（例：h264 源 + WebM）⇒ 换成该容器的默认编码
        _allowed = _VIDEO_CODECS_BY_FMT.get(fmt)
        if codec not in ("h264", "h265", "vp9", "av1") or (_allowed and codec not in _allowed):
            codec = "vp9" if fmt == "webm" else "h264"
        codec_name = _video_encoder_name(fmt, codec)
        container = {"mkv": "matroska", "mov": "mov", "avi": "avi"}.get(fmt, fmt)
        oidx = BytesIO()
        fsrc = BytesIO(data_bytes); fsrc.seek(0)
        with av.open(fsrc, mode="r") as inp:
            vstream = next((s for s in inp.streams if s.type == "video"), None)
            if vstream is None:
                return None
            astream = next((s for s in inp.streams if s.type == "audio"), None)
            rate = float(fps) if fps else (float(vstream.average_rate) if vstream.average_rate else 24)
            with av.open(oidx, mode="w", format=container) as out:
                if metadata:
                    for _mk, _mv in dict(metadata).items():
                        try:
                            out.metadata[str(_mk)] = str(_mv)
                        except Exception:
                            pass
                ostream = out.add_stream(codec_name, rate=rate)
                ostream.pix_fmt = "yuv420p10le" if str(bit_depth) == "10" else "yuv420p"
                opts = {}
                if crf:
                    opts["crf"] = str(int(crf))
                if preset:
                    opts["preset"] = str(preset)
                if str(color_space) in ("HDR", "HDR PQ"):
                    opts["colorspace"] = "bt2020nc"
                    opts["color_primaries"] = "bt2020"
                    opts["color_trc"] = "arib-std-b67" if str(color_space) == "HDR" else "smpte2084"
                if opts:
                    try:
                        ostream.options = opts
                    except Exception:
                        pass
                oaudio = None
                audio_custom = False
                audio_resampler = None
                _ac = str(acodec or "").strip().lower()
                if _ac in ("", "copy", "keep", "source"):
                    _ac = ""
                _ac_name = {"aac": "aac", "opus": "libopus", "mp3": "libmp3lame"}.get(_ac)
                # WebM 容器只吃 Opus 音轨：源不是 Opus 时「复制」进不去，直接转 Opus
                if (fmt == "webm" and not _ac_name and astream is not None
                        and str(astream.codec_context.name).lower() != "opus"):
                    _ac_name = "libopus"
                if astream is not None:
                    if _ac_name:
                        try:
                            _asr = int(asr or astream.rate or 32000)
                            oaudio = out.add_stream(_ac_name, rate=_asr)
                            _abr = _bitrate_int(abitrate)
                            if _abr:
                                oaudio.bit_rate = _abr
                            audio_resampler = av.audio.resampler.AudioResampler(format="fltp", rate=_asr)
                            audio_custom = True
                        except Exception:
                            oaudio = None
                    if oaudio is None:
                        try:
                            oaudio = out.add_stream_from_template(astream)   # 直接复制音轨（不重编码）
                        except Exception:
                            try:
                                _fc = "libopus" if fmt in ("webm", "ogg") else ("libmp3lame" if fmt == "avi" else "aac")
                                oaudio = out.add_stream(_fc, rate=astream.rate)
                            except Exception:
                                oaudio = None
                streams = [vstream] + ([astream] if astream is not None else [])
                for packet in inp.demux(*streams):
                    if packet.stream is vstream:
                        for frame in packet.decode():
                            for p in ostream.encode(frame):
                                out.mux(p)
                    elif astream is not None and packet.stream is astream and oaudio is not None:
                        try:
                            if audio_custom:
                                for frame in packet.decode():
                                    frames = audio_resampler.resample(frame) if audio_resampler is not None else [frame]
                                    for fr in frames:
                                        for p in oaudio.encode(fr):
                                            out.mux(p)
                            else:
                                packet.stream = oaudio
                                out.mux(packet)
                        except Exception:
                            pass
                for p in ostream.encode():
                    out.mux(p)
                if astream is not None and oaudio is not None:
                    try:
                        if audio_custom and audio_resampler is not None:
                            for fr in audio_resampler.resample(None):
                                for p in oaudio.encode(fr):
                                    out.mux(p)
                        for p in oaudio.encode():
                            out.mux(p)
                    except Exception:
                        pass
        oidx.seek(0)
        return oidx.getvalue(), "." + fmt
    except Exception:
        return None


async def _preview_any_folders(req):
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
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
        base = _ez_real(PreviewAnyNode._output_dir())
        roots = [base] + [_ez_real(x) for x in _ez_save_roots() if _ez_real(x)]
        full = _ez_inside(path if os.path.isabs(path) else os.path.join(base, path), roots)
        if not full or not os.path.exists(full):
            return _web.json_response({"error": "outside allowed roots"}, status=403)
        import subprocess
        if os.name == "nt":
            subprocess.Popen(["explorer", "/select,", full])
        else:
            subprocess.Popen(["xdg-open", full if os.path.isfile(full) else os.path.dirname(full)])
        return _web.json_response({"ok": True})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


async def _preview_any_save_roots(req):
    """保存根（= 统一根表里带 write 能力的行）：GET 列出；POST {remove: path} 去掉该根的写权限、
    {clear: true} 清掉所有写权限。只取消写、不删整行 —— 同一个目录可能还是浏览/扫描根。仅本机。"""
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden: local clients only"}, status=403)
    if req.method == "GET":
        return _web.json_response({"ok": True, "roots": _ez_save_roots(),
                                   "rows": [r for r in _ez_root_rows() if r.get("write")]})
    try:
        data = await req.json()
    except Exception:
        data = {}
    if (data or {}).get("clear"):
        if not _ez_root_drop_cap("write"):
            return _web.json_response({"ok": False, "error": "cannot write userdata"}, status=500)
    else:
        rm = _ez_real((data or {}).get("remove") or "")
        if not rm:
            return _web.json_response({"ok": False, "error": "no path"}, status=400)
        rows = []
        for r in _ez_root_rows():
            r = dict(r)
            if os.path.normcase(_ez_real(r.get("path")) or "") == os.path.normcase(rm):
                r["write"] = False
                if not (r.get("read") or r.get("scan")):
                    continue
            rows.append(r)
        if not _ez_root_save(rows):
            return _web.json_response({"ok": False, "error": "cannot write userdata"}, status=500)
    return _web.json_response({"ok": True, "roots": _ez_save_roots()})


async def _preview_any_pick_folder(req):
    """弹 Windows 原生“选择文件夹”对话框：起始位置是上次选过的目录（没有才用 output）。
    选中的目录登记成可写根。仅本机客户端。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    base = _ez_last_dir(PreviewAnyNode._output_dir())

    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            path = filedialog.askdirectory(initialdir=base, title="Select save location")
            root.destroy()
            return path or ""
        except Exception:
            return ""

    try:
        # Tk 必须在建它的线程里跑：放到工作线程，别占 aiohttp 事件循环。
        path = await asyncio.to_thread(_pick)
        if path:
            _ez_last_dir_set(path)
            _ez_root_add(path, read=True, write=True, src="previewany")
            return _web.json_response({"ok": True, "path": os.path.normpath(path), "base": base})
        return _web.json_response({"ok": False})
    except Exception as e:
        return _web.json_response({"ok": False, "error": str(e)}, status=500)


_MEDIA_SERVE_EXT = {
    ".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v",
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff",
    ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".opus", ".aac", ".wma",
    ".glb", ".gltf", ".obj", ".fbx", ".stl", ".ply", ".3ds", ".dae", ".blend",
    ".splat", ".spz", ".ksplat", ".bin", ".mtl", ".ktx2", ".hdr", ".exr",
}


def _media_serve_roots():
    """`/preview_any/serve_video` 可服务的根：只含 input / output / temp。

    刻意**不用** `_ez_roots()`：那还包含 models 与用户登记的扫描目录，而这条路由对根内路径
    不要求本机来源（远端打开 ComfyUI 时也要能看生成结果）。模型目录、个人素材目录不该被
    远端借它读走 —— 与内核自己 `/view` 的公开面保持一致。
    """
    roots = []
    for fn in ("get_input_directory", "get_output_directory", "get_temp_directory"):
        try:
            get = getattr(folder_paths, fn, None)
            p = get() if callable(get) else None
            if p:
                roots.append(p)
        except Exception:
            continue
    return roots


_DANGEROUS_SERVE_EXT = (".html", ".htm", ".xhtml", ".svg", ".svgz", ".xml", ".xsl", ".js", ".mjs")


def _ez_media_file_response(path):
    """直出用户目录里的文件：nosniff 一律加；HTML/SVG 这类会执行脚本的类型强制下载。"""
    hdrs = {"X-Content-Type-Options": "nosniff"}
    try:
        if os.path.splitext(str(path))[1].lower() in _DANGEROUS_SERVE_EXT:
            hdrs["Content-Disposition"] = 'attachment; filename="%s"' % os.path.basename(str(path)).replace('"', "")
    except Exception:
        pass
    return _web.FileResponse(path, headers=hdrs)


async def _preview_any_serve_video(req):
    """流式返回媒体文件（Range 支持）。根内只服务 input/output/temp；其它根（models、用户扫描目录）
    以及根外文件一律要求本机来源，根外再复制进临时目录 —— 否则远端能借这条路由把任意文件当视频读走。"""
    path = req.query.get("path", "").strip()
    src = _ez_inside(path, _media_serve_roots())
    if not src:
        if not _ez_local(req):
            return _web.json_response({"error": "out of allowed roots"}, status=403)
        src = await asyncio.to_thread(_ez_adopt_to_temp, path)
    if not src or not os.path.isfile(src):
        return _web.json_response({"error": "not found"}, status=404)
    if os.path.splitext(src)[1].lower() not in _MEDIA_SERVE_EXT:
        return _web.json_response({"error": "unsupported file type"}, status=415)
    return _ez_media_file_response(src)


async def _preview_any_static(req):
    """serve 3D 静态资源（three.js 与加载器），仅白名单相对路径。

    ⚠️ 这些文件放在 web_assets/3d，**不在 WEB_DIRECTORY 里**：ComfyUI 会把 WEB_DIRECTORY
    下所有 .js 递归当扩展自动 import（server.py:428），3D 库留在 web/ 里等于每次开页面
    白拉 1.5MB。只有打开 3D 预览时前端才 import() 这里。
    """
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    rel = req.match_info.get("path", "")
    root = _ez_real(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web_assets", "3d"))
    full = _ez_inside(os.path.join(root, rel), [root])
    if not full or not os.path.isfile(full):
        return _web.json_response({"error": "not found"}, status=404)
    return _ez_media_file_response(full)


async def _preview_any_fs(req):
    """按绝对路径 serve 文件（用于 3D 模型及其外部贴图/缓冲，使相对路径能正确解析）。仅本地路径。"""
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    from urllib.parse import unquote
    full = _ez_inside(unquote(req.match_info.get("path", "")))
    if full and os.path.isfile(full):
        return _ez_media_file_response(full)
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
    if not _ez_local(req):
        return _web.json_response({"error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
        count = int(data.get("count", 0))
        count = max(0, min(count, _PREVIEW_MAX))
        names = [f"output_{i}" for i in range(1, count + 1)]
        # 类表全局一份：走“只增不减”，不能按当前实例精确覆写（会挤掉另一个实例的高位槽）。
        _ez_sync_dynamic_types(PreviewAnyNode, names)
        return _web.json_response({"ok": True, "types": ["*"] * len(names), "names": names})
    except Exception as e:
        return _web.json_response({"error": str(e)}, status=500)


_PH_PREVIEW_MAX = 1200000


_PV_DIRNAME = 'tag_preview'                 # 标签预览目录（保留旧名，兼容外部引用）


_PV_CARD_DIRNAME = 'card_preview'           # 卡片预览目录


def _pv_dir_of(kind):
    """预览子目录名：kind='card' → card_preview；其它（含 'tag'/None）→ tag_preview。"""
    return _PV_CARD_DIRNAME if str(kind) == 'card' else _PV_DIRNAME


def _pv_legacy_dir():
    """卡片预览共用目录（tag_preview）：惰性搬迁时从这里读取已有的卡片预览文件。"""
    return _ezflex_user_dir(_PV_DIRNAME)


def _pv_dir(kind='tag'):
    """预览图目录 user/EzFlex/<子目录>/（与 prompts 同级，随 user 数据一起迁移/保留）。"""
    d = _ezflex_user_dir(_pv_dir_of(kind))
    if d:
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            pass
    return d


def _pv_hash(name):
    """标签名/卡片名 → 稳定哈希短名（sha1 前 32 hex）。归一化规则必须与前端判等一致（strip）。"""
    import hashlib
    nm = str(name or '').strip()
    return hashlib.sha1(nm.encode('utf-8')).hexdigest()[:32]


def _pv_ext_of(data_url):
    """从 data URL 的 mime 推断扩展名；默认 webp（体积优先）。"""
    m = re.match(r'data:image/([a-z0-9.+-]+)', str(data_url or ''), re.I)
    kind = (m.group(1).lower() if m else 'webp')
    kind = 'jpg' if kind in ('jpeg', 'jpg') else kind
    if kind not in ('webp', 'png', 'jpg', 'gif', 'bmp'):
        kind = 'webp'
    return kind


def _pv_store_dataurl(name, data_url, kind='tag'):
    """把 data:image/... 写进独立文件，返回哈希短名（如 'ab12...ef.webp'）；失败返回 ''。
    覆盖写：同一 name 重存 = 覆盖同一文件（旧的其它扩展名文件会被顺手删掉）。
    kind：'tag' → tag_preview/；'card' → card_preview/。"""
    s = str(data_url or '')
    if not s.startswith('data:image/') or ',' not in s or len(s) > _PH_PREVIEW_MAX:
        return ''
    d = _pv_dir(kind)
    if not d:
        return ''
    ext = _pv_ext_of(s)
    b64 = s.split(',', 1)[1]
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception:
        return ''
    if not raw:
        return ''
    base = _pv_hash(name)
    fname = base + '.' + ext
    dst = os.path.join(d, fname)
    try:
        tmp = dst + '.tmp'
        with open(tmp, 'wb') as fh:
            fh.write(raw)
        os.replace(tmp, dst)
    except Exception:
        return ''
    # 同一 name 若换过扩展名（如先 png 后 webp），删掉同名其它扩展，避免残留
    for other in ('webp', 'png', 'jpg', 'gif', 'bmp'):
        if other == ext:
            continue
        op = os.path.join(d, base + '.' + other)
        try:
            if os.path.isfile(op):
                os.remove(op)
        except Exception:
            pass
    return fname


def _pv_file_path(fname, kind='tag'):
    """短名 → 绝对路径；拒绝任何路径分隔/穿越，只接受 <32hex>.<ext> 形态。"""
    s = str(fname or '').strip()
    if not s or os.path.sep in s or '/' in s or '..' in s:
        return ''
    if not re.fullmatch(r'[0-9a-fA-F]{4,64}\.[A-Za-z0-9]{2,5}', s):
        return ''
    d = _pv_dir(kind)
    if not d:
        return ''
    p = os.path.join(d, s)
    if os.path.realpath(os.path.dirname(p)) != os.path.realpath(d):
        return ''
    return p


def _pv_relocate_legacy(fname, kind):
    """把旧共用目录 tag_preview/ 里的卡片预览搬进卡片目录，只搬一次，之后正常读取。
    只在 kind='card' 时生效（tag 本来就在 tag_preview）。返回是否发生了搬迁。"""
    if str(kind) != 'card':
        return False
    s = str(fname or '').strip()
    if not re.fullmatch(r'[0-9a-fA-F]{4,64}\.[A-Za-z0-9]{2,5}', s):
        return False
    dst_dir = _pv_dir('card')
    if not dst_dir:
        return False
    dst = os.path.join(dst_dir, s)
    if os.path.isfile(dst):
        return False
    legacy = _pv_legacy_dir()
    if not legacy:
        return False
    src = os.path.join(legacy, s)
    if not os.path.isfile(src):
        return False
    try:
        os.replace(src, dst)     # 同盘移动（同一 user 目录下）
    except Exception:
        try:
            import shutil
            shutil.move(src, dst)
        except Exception:
            return False
    return True


def _pv_delete(name, kind='tag'):
    """删除某 name 对应的预览文件（尽力，任何扩展名）；同时清掉老共用目录里的同名残留。"""
    base = _pv_hash(name)
    dirs = [_pv_dir(kind)]
    if str(kind) == 'card':
        dirs.append(_pv_legacy_dir())   # 历史遗留位置也清一下
    for d in dirs:
        if not d:
            continue
        for ext in ('webp', 'png', 'jpg', 'gif', 'bmp'):
            try:
                p = os.path.join(d, base + '.' + ext)
                if os.path.isfile(p):
                    os.remove(p)
            except Exception:
                pass


def _pv_is_dataurl(v):
    return isinstance(v, str) and v.startswith('data:image/') and len(v) <= _PH_PREVIEW_MAX


def _pv_is_fname(v):
    """JSON 里 preview 字段是否为「新格式哈希短名」。"""
    if not isinstance(v, str):
        return False
    return bool(re.fullmatch(r'[0-9a-fA-F]{4,64}\.[A-Za-z0-9]{2,5}', v.strip()))


def _pv_migrate_value(name, val, kind='tag'):
    """惰性迁移：值是旧 base64 → 落盘成文件并返回哈希短名；值已是新格式 → 原样返回；其它 → ''。
    kind 决定落到 tag_preview/ 还是 card_preview/。"""
    if _pv_is_dataurl(val):
        return _pv_store_dataurl(name, val, kind)
    if _pv_is_fname(val):
        return str(val).strip()
    return ''


def _pv_clean_dir(valid_names, kind='tag'):
    """孤儿回收：目录里存在、但不在 valid_names 里的文件删掉。
    ★ valid_names 必须是「**当前真正被引用的哈希短名集合**」（不是「所有 name 的哈希」）——
      否则「把某条预览移除了、但记录还在」时，它的哈希仍被算作有效 → 文件永远删不掉（用户报过：
      「移除后对应图片没删掉」）。
    valid_names 为 None 时不清理（避免误删）。只清指定 kind 的目录。"""
    if valid_names is None:
        return 0
    d = _pv_dir(kind)
    if not d or not os.path.isdir(d):
        return 0
    keep = set()
    for v in valid_names:
        s = str(v or "").strip()
        if _pv_is_fname(s):
            keep.add(s)
    n = 0
    try:
        for fn in os.listdir(d):
            if fn.endswith('.tmp'):
                try:
                    os.remove(os.path.join(d, fn))
                except Exception:
                    pass
                continue
            if fn not in keep:
                try:
                    os.remove(os.path.join(d, fn))
                    n += 1
                except Exception:
                    pass
    except Exception:
        pass
    return n


def _pv_all_valid_names():
    """两个目录合并回收用：当前**真正被引用**的预览短名集合（标签 ∪ 卡片，含卡片组顶层 + 组内单卡）。
    读取失败时返回 None（= 不清理，宁可留着也别误删）。
    ⚠️ 与 _pv_clean_dir 同口径：只收 preview 非空的短名，不收没有预览的 name。"""
    names = set()
    ok = False
    try:
        fn = _ph_tags_file()
        if fn and os.path.isfile(fn):
            with open(fn, 'r', encoding='utf-8') as fh:
                d = json.loads(fh.read())
            for t in (d.get("tags") or []):
                if isinstance(t, dict):
                    pv = str(t.get("preview") or "").strip()
                    if _pv_is_fname(pv):
                        names.add(pv)
            ok = True
    except Exception:
        pass
    try:
        pd = _ph_prompts_dir()
        if pd and os.path.isdir(pd):
            for fn in os.listdir(pd):
                if not fn.endswith(".json") or fn.endswith(".bak"):
                    continue
                try:
                    with open(os.path.join(pd, fn), 'r', encoding='utf-8') as fh:
                        d = json.loads(fh.read())
                except Exception:
                    continue
                if isinstance(d, dict):
                    pv = str(d.get("preview") or "").strip()
                    if _pv_is_fname(pv):
                        names.add(pv)
                    for c in (d.get("cards") or []):
                        if isinstance(c, dict):
                            cpv = str(c.get("preview") or "").strip()
                            if _pv_is_fname(cpv):
                                names.add(cpv)
            ok = True
    except Exception:
        pass
    return names if ok else None


def _pv_tag_valid_names():
    """标签目录回收用：**当前真正引用了预览图的标签**的哈希短名集合（读取失败 → None，不清理）。
    ⚠️ 必须只收「preview 非空」的条目 —— 收了没有预览的 name 会让它对应的孤儿文件永远删不掉。"""
    try:
        fn = _ph_tags_file()
        if not fn or not os.path.isfile(fn):
            return None
        with open(fn, 'r', encoding='utf-8') as fh:
            d = json.loads(fh.read())
        out = set()
        for t in (d.get("tags") or []):
            if isinstance(t, dict):
                pv = str(t.get("preview") or "").strip()
                if _pv_is_fname(pv):
                    out.add(pv)
        return out
    except Exception:
        return None


def _pv_card_valid_names():
    """卡片目录回收用：prompts/*.json 里**真正引用了预览图**的短名集合（读取失败 → None，不清理）。
    收「卡片组顶层 preview」+「组内每张卡的 preview」两类。"""
    try:
        pd = _ph_prompts_dir()
        if not pd or not os.path.isdir(pd):
            return None
        out = set()
        for fn in os.listdir(pd):
            if not fn.endswith(".json") or fn.endswith(".bak"):
                continue
            try:
                with open(os.path.join(pd, fn), 'r', encoding='utf-8') as fh:
                    d = json.loads(fh.read())
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            pv = str(d.get("preview") or "").strip()
            if _pv_is_fname(pv):
                out.add(pv)
            for c in (d.get("cards") or []):
                if isinstance(c, dict):
                    cpv = str(c.get("preview") or "").strip()
                    if _pv_is_fname(cpv):
                        out.add(cpv)
        return out
    except Exception:
        return None


def _pv_get_or_migrate_card(name, fn, rec):
    """读卡片 preview：旧 base64 → 落盘成文件 + 写回文件 + 返回短名；新短名 → 原样返回。"""
    raw = rec.get("preview") if isinstance(rec, dict) else None
    if not raw:
        return ""
    short = _pv_migrate_value(name, raw, 'card')
    if short and short != raw:
        # 发生过迁移（base64 → 短名）：把文件写回，避免每次都重转
        try:
            rec["preview"] = short
            _ph_backup_before_write(fn)
            with open(fn, 'w', encoding='utf-8') as fh:
                json.dump(rec, fh, ensure_ascii=False, indent=2)
        except Exception:
            pass
    else:
        # 历史遗留：短名对应的文件还躺在旧的共用 tag_preview/ 里 → 惰性搬到 card_preview/
        try:
            if short and not os.path.isfile(_pv_file_path(short, 'card') or ''):
                _pv_relocate_legacy(short, 'card')
        except Exception:
            pass
    return short


_MEDIA_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}


_MEDIA_VID_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp", ".ts", ".m2ts", ".vob"}


_MEDIA_AUD_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".aac", ".m4a", ".opus", ".wma", ".aiff", ".aif", ".mka", ".ac3", ".amr"}


_MEDIA_3D_EXTS = {".obj", ".glb", ".gltf", ".fbx", ".stl", ".ply", ".spz", ".splat", ".ksplat", ".3ds", ".dae", ".blend", ".vrm", ".usdz", ".x3d", ".lwo", ".abc"}


_SAVE_ALLOWED_EXTS = _MEDIA_IMG_EXTS | _MEDIA_VID_EXTS | _MEDIA_AUD_EXTS | {".txt", ".md", ".json", ".csv", ".log", ".html"} | {".safetensors", ".gguf", ".onnx", ".ckpt", ".pt", ".bin", ".glb", ".gltf", ".obj", ".fbx", ".stl", ".ply", ".latent"}


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


MEDIA_TO_COMFY = {
    "image": "IMAGE", "video": "VIDEO", "audio": "AUDIO",
    "model_3d": "FILE_3D", "model": "FILE_3D", "3d": "FILE_3D",
    "other": "STRING", "text": "STRING", "*": "*",
}


def _media_safe(name):
    name = os.path.basename((name or "").replace("\\", "/")).strip()
    name = re.sub(r"[^A-Za-z0-9._\-\u4e00-\u9fff()（）\s]+", "_", name)
    return name

