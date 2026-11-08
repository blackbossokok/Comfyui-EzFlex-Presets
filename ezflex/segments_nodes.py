"""时间轴 / 分段：TimeLine、TimePlan、SplitVideo、SegmentPanel、MotionContext。

它们共用一份数据契约 EZFLEX_TIMEPLAN（由 TimePlan 生成并按端口一路透传）：
  segments[i] = {index, genFrames, netFrames, overlapFrames, toleranceFrames, tailFrames, ...}
四组工具：
  · _tl_*   时间轴规划：模型帧网格、align/strict 两档、手动每段时长
  · _ezsv_* 源素材切分：帧序列 / 懒裁剪 VIDEO / GIF / 音频窗口
  · _ezsp_* 分段落盘：manifest、版本、ffmpeg 拼接（WAV 侧车 + 交叉淡化）
  · _ezmc_* 把上一段 AV latent 的尾部钉进本段（H3 的帧/latent 几何）
依赖包根：路径收口、媒体元数据、PreviewAny._png_meta（写 PNG 文本块）。
"""
import base64
import csv
from collections import deque
import inspect
import json
import asyncio
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

from aiohttp import web as _web  # 与 __init__.py 同源（那边在 try 块里导入，这里直接引）

# 借用包根里的共享 helper（__init__.py 末尾才导入本模块，届时这些名字都已定义）
from .. import (_EZPV_PREFIXES, _EZPV_SWEEP_MIN_GAP, _EZPV_TTL_SEC, _ez_inside, _ez_local, _ez_resume_media_meta, _ez_roots, _ez_save_roots, _ezpv_sweep, _ezpv_sweep_last, _ml_load_audio, _ml_resolve)



def _tl_slice_audio(path, start, dur):
    """抽一段音轨；没有音轨 / 解码失败返回 None（SplitVideo 的 audio 输出）。"""
    audio = _ml_load_audio(path, start, dur)
    try:
        wf = audio.get("waveform") if isinstance(audio, dict) else None
        if wf is None or int(wf.shape[-1]) <= 0:
            return None
    except Exception:
        return None
    return audio


def _ezsp_range(total, rng):
    try:
        s = str(rng if rng is not None else "").strip()
        if s.startswith("-"):
            n = max(0, int(s[1:] or 0))
            return max(0, int(total) - n), int(total)
        n = int(s or 0)
        if n > 0:
            return 0, min(int(total), n)
    except (TypeError, ValueError):
        pass
    return 0, int(total)


def _ez_load_latent_file(path):
    """读 LATENT：`.latent` = ComfyUI 核心格式（safetensors 的 latent_tensor），`.pt` = 本插件旧格式。"""
    if not path or not os.path.isfile(path):
        return None
    if str(path).lower().endswith(".latent"):
        import safetensors.torch          # .latent 与核心同格式：safetensors 内容，但扩展名不是 .safetensors，
        d = safetensors.torch.load_file(path)   # comfy.utils.load_torch_file 会按扩展名回落到 torch.load
        t = d.get("latent_tensor")
        return {"samples": t} if t is not None else None
    return torch.load(path, map_location="cpu", weights_only=True)


def _ezsp_save_persist_value(root, cur, k, name, typ, val, rng, fps):
    """LoopEnd 卡片落盘：只写选中的范围，返回相对文件名/目录。"""
    import wave
    import numpy as np
    from PIL import Image
    base = re.sub(r"[^0-9A-Za-z_.\-\u4e00-\u9fff]+", "_", str(name or ("v%d" % k))).strip(" ._-") or ("v%d" % k)
    base = base[:48]
    prefix = "seg_%04d_%s" % (int(cur), base)
    t = str(typ or "auto").lower()
    if t == "auto":
        if isinstance(val, dict) and ("samples" in val or "audio_latent" in val):
            t = "latent"
        elif isinstance(val, torch.Tensor) and int(getattr(val, "ndim", 0)) == 4:
            t = "frames"
        elif isinstance(val, dict) and "waveform" in val:
            t = "audio"
        elif hasattr(val, "get_stream_source") or hasattr(val, "save_to"):
            t = "video"
        elif hasattr(val, "vertices") and hasattr(val, "faces"):
            t = "mesh"
    if t == "latent" and isinstance(val, dict) and torch.is_tensor(val.get("samples")):
        # 与核心 SaveLatent 同格式：safetensors 里的 latent_tensor（LoadLatent 能直接读）
        import comfy.utils
        fn = prefix + ".latent"
        comfy.utils.save_torch_file({"latent_tensor": val["samples"].contiguous(),
                                     "latent_format_version_0": torch.tensor([])},
                                    os.path.join(root, fn))
        return fn, "latent"
    if t == "mask" and torch.is_tensor(val) and int(val.ndim) in (2, 3):
        a = val.detach().cpu().float()
        if a.ndim == 3:
            a = a[0] if int(a.shape[0]) == 1 else a.max(dim=0).values
        arr = a.clamp(0, 1).mul(255).byte().numpy()
        fn = prefix + "_mask.png"
        Image.fromarray(arr, mode="L").save(os.path.join(root, fn))
        return fn, "mask"
    if t == "conditioning" and isinstance(val, (list, tuple)):
        tmp = PreviewAnyNode._conditioning_tmp(val)     # 单条目才给临时文件（核心也只支持单条目）
        if tmp:
            fn = prefix + ".safetensors"
            shutil.copy2(tmp, os.path.join(root, fn))
            return fn, "conditioning"
        fn = prefix + ".pt"
        torch.save(val, os.path.join(root, fn))
        return fn, "conditioning"
    if t == "mesh":
        tmp = PreviewAnyNode._mesh_glb_tmp(val)         # 顶点/面 → .glb（核心 Save 3D 的标准格式）
        if tmp:
            fn = prefix + ".glb"
            shutil.copy2(tmp, os.path.join(root, fn))
            return fn, "mesh"
        return "", ""
    if t in ("latent", "mask", "tensor", "conditioning") and isinstance(val, (dict, torch.Tensor, list)):
        fn = prefix + ".pt"
        torch.save(val, os.path.join(root, fn))
        return fn, t
    if t in ("text", "string") and isinstance(val, str):
        fn = prefix + ".txt"
        with open(os.path.join(root, fn), "w", encoding="utf-8") as f:
            f.write(val)
        return fn, "text"
    if t in ("frames", "image"):
        if isinstance(val, torch.Tensor) and int(val.ndim) == 4:
            a, b = _ezsp_range(int(val.shape[0]), rng) if t == "frames" else (0, int(val.shape[0]))
            arr = val[a:b].detach().cpu().clamp(0, 1).mul(255).byte().numpy()
            d = prefix + "_frames"
            os.makedirs(os.path.join(root, d), exist_ok=True)
            for i in range(int(arr.shape[0])):
                Image.fromarray(arr[i]).save(os.path.join(root, d, "frame_%03d.png" % i))
            return d, "image"
        # 选了「帧序列」但实际不是帧批次：按「其他」存——接收啥存啥，别静默丢值。
        return _ezsp_save_persist_value(root, cur, k, name, "auto", val, rng, fps)
    if t == "audio" and isinstance(val, dict):
        wf = val.get("waveform")
        sr = int(val.get("sample_rate") or 0)
        if wf is not None and sr > 0:
            take = int(wf.shape[-1])
            take = min(int(wf.shape[-1]), take)
            pcm = wf[..., -take:].detach().cpu().float().clamp(-1, 1).mul(32767).short().numpy()
            fn = prefix + ".wav"
            with wave.open(os.path.join(root, fn), "wb") as w:
                w.setnchannels(int(pcm.shape[1])); w.setsampwidth(2); w.setframerate(sr)
                w.writeframes(pcm[0].T.reshape(-1).astype("<i2").tobytes())
            return fn, "audio"
    if t == "video":
        p = ""
        try:
            p = PreviewAnyNode._video_file_source(val) or ""
        except Exception:
            p = ""
        if p and os.path.isfile(p):
            fn = prefix + ".mp4"
            shutil.copy2(p, os.path.join(root, fn))
            return fn, "video"
    return "", ""


def _ezsp_load_persist_file(root, fn, typ, rng, fps):
    p = os.path.join(root, fn)
    if not os.path.exists(p):
        return None
    try:
        n = abs(int(str(rng or "-5").replace("-", "") or 5)) if str(rng or "").startswith("-") else 0
    except (TypeError, ValueError):
        n = 5
    return _ezsp_load_ref_file(p, typ, n or 1, fps)


def _ezsp_load_ref_file(path, typ, count=5, fps=24):
    """LoopStart 卡片参考：按路径加载 video / latent / audio / frames。

    frames: 目录取最后 count 张 PNG；视频取最后 count 帧；单张 PNG 取 1 张。
    audio:  WAV 取最后 count 帧对应的 PCM。
    """
    if not path:
        return None
    # refPaths / nextRef / resume 的文件名都来自工作流 config：只允许落在允许的根内
    if not _ez_inside(path, _ezsp_allowed_roots()):
        print("[EzFlex-SegmentPanel] 参考文件不在允许的目录内，已跳过：%s" % path)
        return None
    try:
        _raw = str(count if count is not None else "5").strip()
        if _raw == "0":
            n = 0
        elif _raw.startswith("-"):
            n = abs(int(_raw[1:] or 0))
        else:
            n = int(_raw or 0)
    except (TypeError, ValueError):
        n = 5
    try:
        f = max(1e-6, float(fps or 24))
    except (TypeError, ValueError):
        f = 24.0
    t = str(typ or "video").lower()
    if t == "video":
        if not os.path.isfile(path):
            return None
        return InputImpl.VideoFromFile(path)
    if t == "mask" and str(path).lower().endswith(".png"):
        from PIL import Image
        import numpy as np
        im = Image.open(path).convert("L")
        return torch.from_numpy(np.array(im, dtype="float32") / 255.0).unsqueeze(0)
    if t == "conditioning" and str(path).lower().endswith(".safetensors"):
        import comfy.utils
        sd, metadata = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
        cond = sd.pop("conditioning", None)
        if cond is None:
            return None
        options = __import__("json").loads((metadata or {}).get("conditioning_options", "{}"))
        lists = {}
        for k, v in sd.items():
            name, _, index = k.rpartition(".")
            if index.isdigit():
                lists.setdefault(name, {})[int(index)] = v
            else:
                options[k] = v
        options.update({k: [v[i] for i in sorted(v)] for k, v in lists.items()})
        return [[cond, options]]
    if t in ("latent", "mask", "tensor", "conditioning"):
        if not os.path.isfile(path):
            return None
        return _ez_load_latent_file(path)   # .latent 走核心格式，.pt 走旧格式
    if t == "audio":
        if not os.path.isfile(path):
            return None
        import wave
        import numpy as np
        with wave.open(path, "rb") as w:
            sr = int(w.getframerate())
            ch = int(w.getnchannels())
            total = int(w.getnframes())
            take = min(total, max(1, int(round(n / f * sr)))) if n > 0 else total
            start = max(0, total - take)
            w.setpos(start)
            pcm = np.frombuffer(w.readframes(take), dtype="<i2").astype("float32") / 32768.0
        if pcm.size <= 0:
            return None
        return {"waveform": torch.from_numpy(pcm.reshape(-1, ch).T).unsqueeze(0), "sample_rate": sr}
    if t in ("frames", "image"):
        import numpy as np
        from PIL import Image
        if os.path.isdir(path):
            fs = sorted(x for x in os.listdir(path) if x.lower().endswith(".png"))
            if not fs:
                return None
            fs = fs[-n:] if n > 0 else fs
            arrs = [np.array(Image.open(os.path.join(path, x)).convert("RGB")) for x in fs]
            return _ez_img4(torch.from_numpy(np.stack(arrs, axis=0).astype("float32") / 255.0), "frames-dir")
        if path.lower().endswith(".png") and os.path.isfile(path):
            arr = np.array(Image.open(path).convert("RGB")).astype("float32") / 255.0
            return _ez_img4(torch.from_numpy(arr)[None,], "frames-png")
        if os.path.isfile(path):
            import av
            rows = []
            with av.open(path) as c:
                vs = next((s for s in c.streams if s.type == "video"), None)
                if vs is None:
                    return None
                # 只要最后 n 帧：先 seek 到尾段，再用 deque 兜底。全量 decode 到 list 会让
                # 1080p 长视频直接吃几 GB 内存。n=0 沿用旧语义（全片）。
                if n > 0:
                    try:
                        fps = float(vs.average_rate or vs.base_rate or 24) or 24.0
                        dur = float(vs.duration * vs.time_base) if vs.duration and vs.time_base else 0.0
                        if dur > 0:
                            # 不传 stream：offset 按 av.time_base（微秒）解释。
                            c.seek(int(max(0.0, dur - (n + 2) / fps) * 1_000_000), backward=True)
                    except Exception:
                        pass
                    tail = deque(maxlen=n)
                    for fr in c.decode(vs):
                        tail.append(fr.to_ndarray(format="rgb24"))
                    rows = list(tail)
                else:
                    for fr in c.decode(vs):
                        rows.append(fr.to_ndarray(format="rgb24"))
            if not rows:
                return None
            arr = np.stack(rows, axis=0).astype("float32") / 255.0
            return _ez_img4(torch.from_numpy(arr), "frames-video")
    return None


_TL_MODELS = {
    "minimax_h3": {"defaultFps": 24, "B": 5, "S": 17, "maxF": 362},
    "wan": {"defaultFps": 16, "B": 1, "S": 4, "maxF": 121},
    "ltx": {"defaultFps": 24, "B": 1, "S": 8, "maxF": 257},
}


def _tl_snap_up(x, B, S):
    """把帧数向上吸附到模型网格 B + S*k（x <= B 时取 B）。

    ⚠️ `_tl_plan` 已不再调用它：现在每段帧数由「网格步数 k」直接展开（`B + S*k`），
       天然就在网格上，不需要事后吸附。这里保留它是因为它是网格规则的一个小工具，
       外部/测试想「把一个任意帧数吸到网格上」时仍然可用（`timeline_plan_test` 会抽出来跑）。
    """
    if x <= B:
        return B
    return B + S * ((x - B + S - 1) // S)


def _tl_alloc_steps(mtot, k1, N):
    """把「第 2..N+1 段的总网格步数」平摊成 N 个整数步数（大段在前，和恰为 mtot - k1）。

    ⚠️ 用 m_base/m_base+1 平摊（而不是 ceil）能让 Σk 恰好等于 mtot，
       从而 Σgen 精确落在 (N+1)*B + S*mtot —— 这是总时长能对齐的前提。
    """
    snet = int(mtot) - int(k1)
    if snet < N:
        return [max(1, snet // N)] * N
    mb, r = snet // N, snet - N * (snet // N)
    return [(mb + 1) if i < r else mb for i in range(N)]


def _tl_spread_steps(total, M, base):
    """把 `total` 个网格步分给 M 段（Σ 恰为 total），在 `base` 附近 **均匀交错**，且每段 ≥ 1。

    目标是「每段步数 = base 或 base±k 尽量接近」，同时总和精确 = total：
      先算 target = total / M（浮点均值），各段取 floor/ceil，再把余数按 **尽量分散** 的位置 +1；
      若 total 远离 base*M（如段数被改动后重配），则退化为普通的 floor/ceil 均摊（保证 Σ 精确）。
    """
    total, M = int(total), int(M)
    if M <= 0:
        return []
    if total < M:                      # 每段至少 1 步
        return [1] * M
    lo = total // M
    rem = total - M * lo               # 需要 +1 的段数（0..M-1）
    res = [lo] * M
    if rem <= 0:
        return res
    # 把 rem 个 +1 均匀交错撒开（步长 M/rem），避免长的全挤在前面
    stride = M / float(rem)
    for i in range(rem):
        res[int(i * stride)] += 1
    return res


def _tl_plan_strict(B, S, fps, T, n, oeff, maxF):
    """strict 档：**每段时长绝对统一**（除首段），总时长靠 **增减段数** 逼近。

    口径：
      ✗ 旧版：锁每段步数 → 用 `_tl_spread_steps` 把余量「交错撒」到各段 ⇒ 段长不统一
             （有的 kseg、有的 kseg+1，看起来「前长后短」）；段数也被限死在 N0±2。
      ✓ 新版：**所有非首段用同一个步数 kseg**（段长一模一样），段数 N 是**唯一自由度**，
             遍历 N 挑 Σnet 最贴近 fps*T 的（**不限制段数范围**）。

    算法：
      ① 首段步数 k1 = round((fps*n - B) / S)（首段无剪头，目标就是 fps*n）。
      ② 非首段步数 kseg = round((fps*n + oeff - B) / S)（要「多生成 oeff」才留下 fps*n 的净增；
         oeff = overlap + tolerance）。⇒ 每个非首段净增 = B + S*kseg - oeff ≈ fps*n，**完全相同**。
      ③ 遍历总段数 Ntot（从 1 段到 maxseg），每段都用 kseg：
           Σnet(N) = (B + S*k1) + (N-1)*(B + S*kseg - oeff)
         取 |Σnet - fps*T| 最小的 N。总时长偏差随 N 线性增长 ⇒ 天然有唯一最优 N。
      ④ 段数口径：maxseg 取「每段时长 n 的下限」对应的段数再放宽一倍
         （即段数可到 ~2*T/n），避免段数被卡死；同时保证 ≥1 段、≤ maxF 单段限制。

    为什么这样最贴合「严格每段」：段长是硬约束（用户要的），总时长是软目标（逼近即可）。
      段数每 +1，总时长就多一个「统一段长」—— 这是唯一能连续调节总时长的旋钮。
    """
    k1 = max(1, int((fps * n - B) / S + 0.5))          # 首段步数（无剪头）
    kseg = max(1, int((fps * n + oeff - B) / S + 0.5))  # 非首段统一步数
    gen1 = B + S * k1
    genseg = B + S * kseg
    netseg = max(1, genseg - oeff)                     # 每个非首段的净增（统一）

    # 段数范围：从 1 段到「让总时长至少两倍目标」的上限（足够宽，保证能逼近）。
    N0 = max(1, int(T / n + 0.5))                      # 基准段数（仅供参考）
    hi = max(1, int(2 * N0) + 2)                       # 上限放宽到 ~2 倍，段数不受 N0±2 限制
    best = None
    for Ntot in range(1, hi + 1):
        N = Ntot - 1                                   # 非首段数量
        s_net = gen1 + N * netseg
        err = abs(s_net - fps * T)
        # 优先 err；同 err 取段数更贴近 N0（段数别无故乱跳）
        key = (err, abs(Ntot - N0), Ntot)
        if best is None or key < best[0]:
            best = (key, Ntot)
    Ntot = best[1]
    N = Ntot - 1
    klist = [k1] + [kseg] * N
    s_net = gen1 + N * netseg
    return klist, s_net


def _tl_parse_override(seg_override):
    """把用户手动设定的「每段时长（秒）」规整成 {1-based 段号: 秒} 字典。

    接受 {seg_no: seconds}（键可为 int / '3' 字符串）。忽略非正 / 非数字项。
    首段（1）也允许 —— 手动值优先于自动算法。
    """
    out = {}
    if not isinstance(seg_override, dict):
        return out
    for k, v in seg_override.items():
        try:
            idx = int(k)
            sec = float(v)
        except (TypeError, ValueError):
            continue
        if idx >= 1 and sec > 0:
            out[idx] = sec
    return out


def _tl_build_override(klist, ovr, B, S, fps, oeff, maxF, seg_count=None):
    """把「手动每段时长（秒）」与自动规划结果合成 → 返回新的 klist + Σnet。

    ★ 口径（两档通用）：
      ① 段号 ≤ 自动段数：**就地替换**该段步数（段数不变，总时长随手动值变）。
         · 首段(1)：目标即 fps*sec，k = round((fps*sec - B)/S)。
         · 其余段：要多生成 oeff 才留下 fps*sec 净增，k = round((fps*sec + oeff - B)/S)。
      ② 段号 > 自动段数：**追加**该段（自动段数不够时，用户能「加段」）。
         追加段前若中间有空号（如自动 3 段、手改第 5 段），中间用「自动段步数」补齐。
      ③ 返回的 Σnet 用统一口径：gen1 + Σ_{i≥2}(gen_i - oeff)。
    """
    kmax = max(1, (int(maxF) - B) // S) if maxF else None
    segs = [int(x) for x in klist]
    # 整体时长面板的「加/删段」：先按目标段数截断或补段，再套每段手动时长。
    if seg_count is not None:
        try:
            _cnt = max(1, int(seg_count))
        except (TypeError, ValueError):
            _cnt = len(segs)
        if _cnt < len(segs):
            segs = segs[:_cnt]
        while _cnt > len(segs):
            segs.append(segs[-1] if segs else 1)
    if not ovr:
        return list(segs), None

    def _k(sec, i):
        want = fps * float(sec) + (0 if i == 0 else oeff)
        kk = max(1, int((want - B) / S + 0.5))
        return min(kk, kmax) if kmax else kk

    for idx in sorted(ovr):
        i = idx - 1
        if i < 0:
            continue
        if i < len(segs):
            segs[i] = _k(ovr[idx], i)
        else:
            while len(segs) < i:                        # 中间空号：用「自动段步数」补齐
                segs.append(segs[-1] if len(segs) > 1 else segs[0])
            segs.append(_k(ovr[idx], i))
    s_net = (B + S * segs[0]) + sum(B + S * kk - oeff for kk in segs[1:])
    return segs, s_net


def _tl_plan(model="minimax_h3", total=30.0, segment=5.0, fps=None, overlap=22, tolerance=1, align="align", seg_override=None, trim_tail=0, seg_count=None, grid_b=None, grid_s=None, max_frames=None):
    """按模型帧网格把总时长切成分段，返回每段的帧数表。

    ★ 核心口径（含扣减顺序）：

    【生成帧 vs 净增帧】
        genFrames  = 交给采样器的帧数 —— **必须落在网格** B + S*k（内核 `align_frame_count` 会吸附）
        netFrames  = 裁掉头帧后的播放长度 = gen - overlap - tolerance —— **不必**在网格上
      内核只约束「生成了几帧」，不管「播多久」。

    【时长扣减顺序】容差在**生成之后**减去，不加进生成里：
        net → gen = 吸附到网格(net + overlap + tolerance) → net = gen - overlap - tolerance

    【总时长对齐 · 在「网格步数空间」求解】
      每段生成帧数写成 gen_i = B + S*k_i，则 Σgen = (N+1)*B + S*Σk_i。
      **首段不剪头**（没有上一段的尾巴可接）：net_1 = gen_1；其余段 net_i = gen_i - oeff。
        ⇒ Σnet = (N+1)*B + S*mtot - N*oeff          （mtot = Σk_i）
      给定目标 Σnet ≈ fps*T - N*tol（容差是生成后裁掉的，不靠多生成补），反解总步数：
        ideal_k = (fps*T - N*tol - (N+1)*B + N*oeff) / S
                = (fps*T - (N+1)*B + N*overlap) / S      ← oeff = overlap + tol，两项相消
      取 ideal_k 附近的整数 mtot（多取几个候选、挑 Σnet 最贴近目标者），
      再把 mtot 平摊到 N+1 段上。首段固定 k1（按每段时长取整），其余 N 段由 `_tl_alloc_steps` 平摊。

      ⚠️ 三个曾经的错法（都表现为「对齐时长逻辑丢了」）：
        ① 用原始帧数相减（remaining = round(fps*T - F1)）⇒ net 出现 120 这种非 S 倍数 ⇒ 相位漂移。
        ② 按 gen 目标均分（Σgen ≈ fps*T + N*oeff 后再逐段取整）⇒ 逐段取整把误差累乘。
        ③ 反解时把**首段的 oeff 也算进扣减**（ideal_k = (fps*T-(N+1)*(B-oeff))/S）⇒
           mtot 偏大 2~3 步 ⇒ 总时长稳定偏长几十帧。必须用 `+ N*oeff`（不是 `(N+1)*oeff`）。

    【align 两档】
        align  ：**总时长优先** —— 首段步数向上取整（≥ 目标段长），其余段按总时长反解后平摊；
                 总时长误差 ≤ 8 帧（≈0.33s），代价是各段净增会偏离「每段时长」最多约 ±1 步。
        strict ：**每段时长绝对统一（除首段）** —— 所有非首段用同一个网格步数 kseg，
                 段数 N 是**唯一自由度**，遍历 N 取 Σnet 最贴近 fps*T 的（段数不设 ±2 上限）。
                 段长完全一致；段长偏大时段数跳变会放大总时长误差，这是统一段长的必然代价。

    【手动每段时长 seg_override】
        面板可对**任意段（含首段）**手动设定时长（秒）：`{段号(1-based): 秒}`。
        设定后该段不再走自动算法，按秒吸附到最近网格步；总时长随之变化（其余段保持自动）。
        段号 > 自动段数时＝「手动加段」（自动段不够用时用户能自己补）。
        ⚠️ 面板与后端**同一份口径**：后端 run() 从 config 读 `segOverride` 再喂进来，两侧算式必须一致。

    每段：index / genFrames / netFrames / overlapFrames / toleranceFrames /
          genStart / netStart / genDuration / netDuration / exceed。
    """
    m = _TL_MODELS.get(str(model)) or _TL_MODELS["minimax_h3"]
    B, S, maxF = m["B"], m["S"], m["maxF"]
    try:
        if grid_b is not None:
            B = max(0, int(grid_b))
        if grid_s is not None:
            S = max(1, int(grid_s))
        if max_frames is not None:
            maxF = max(1, int(max_frames))
    except (TypeError, ValueError):
        B, S, maxF = m["B"], m["S"], m["maxF"]
    try:
        fps = max(1, int(fps or m["defaultFps"]))
    except (TypeError, ValueError):
        fps = m["defaultFps"]
    try:
        T = max(0.1, float(total))
    except (TypeError, ValueError):
        T = 30.0
    try:
        n = max(0.1, float(segment))
    except (TypeError, ValueError):
        n = 5.0
    try:
        raw = max(0, int(overlap))
    except (TypeError, ValueError):
        raw = 22
    try:
        tol = max(0, int(tolerance))
    except (TypeError, ValueError):
        tol = 0
    # overlap 帧数本身也要落在网格上（内核只认 0 或 B+S*k），向下取网格
    if raw <= 0:
        overlap_frames = 0
    elif raw <= B:
        overlap_frames = B
    else:
        overlap_frames = B + S * ((raw - B) // S)
    try:
        tf = max(0, int(trim_tail))
    except (TypeError, ValueError):
        tf = 0
    oeff = overlap_frames + tol          # 每段要「多生成」的量：给上一段尾巴 + 拼接容差
    strict = str(align) == "strict"
    N = max(1, int(T / n + 0.5)) - 1     # 除首段外的段数
    ovr = _tl_parse_override(seg_override)   # 手动每段时长（秒）→ 段号；空则纯自动

    # ---- strict 档：段长统一（除首段）+ 段数逼近总时长 ----
    if strict:
        klist, _ = _tl_plan_strict(B, S, fps, T, n, oeff, maxF)
        klist, _ = _tl_build_override(klist, ovr, B, S, fps, oeff, maxF, seg_count)   # 手动每段时长覆盖
        out = []
        cursor = 0.0
        for i, kk in enumerate(klist):
            gen = B + S * kk                                   # gen 天然落在网格上
            if i == 0:
                _tf0 = tf if len(klist) > 1 else 0
                _net0 = max(1, gen - _tf0)
                out.append({"index": 1, "genFrames": gen, "netFrames": _net0, "overlapFrames": 0,
                            "toleranceFrames": 0, "tailFrames": _tf0, "genStart": 0.0, "netStart": 0.0,
                            "genDuration": gen / fps, "netDuration": _net0 / fps, "exceed": gen > maxF})
                cursor = _net0 / fps
                continue
            _tail = tf if i < len(klist) - 1 else 0
            net_eff = max(1, gen - oeff - _tail)
            out.append({"index": i + 1, "genFrames": gen, "netFrames": net_eff,
                        "overlapFrames": overlap_frames, "toleranceFrames": tol, "tailFrames": _tail,
                        "genStart": cursor - (overlap_frames + tol) / fps, "netStart": cursor,
                        "genDuration": gen / fps, "netDuration": net_eff / fps, "exceed": gen > maxF})
            cursor += net_eff / fps
        return out

    # ---- 第 1 段：没有上一段的尾巴要接，gen 直接按「每段时长」吸附到网格 ----
    want1 = fps * n
    k1 = max(1, -(-(want1 - B) // S))          # 对齐模式：向上取网格步（不少于目标时长）
    F1 = B + S * k1
    _tf1 = tf if N > 0 else 0
    _net1 = max(1, F1 - _tf1)
    out = [{"index": 1, "genFrames": F1, "netFrames": _net1, "overlapFrames": 0, "toleranceFrames": 0,
            "tailFrames": _tf1, "genStart": 0.0, "netStart": 0.0, "genDuration": F1 / fps, "netDuration": _net1 / fps,
            "exceed": F1 > maxF}]

    if N > 0:
        # ---- 第 2..N+1 段：先在「网格步数空间」解出总步数，再一次性平摊 ----
        # ★ 首段不剪头（没有上一段的尾巴可接）⇒ Σnet = F1 + Σ_{i≥2}(gen_i - oeff)
        #   = (N+1)*B + S*Σk - N*oeff  ⇒ 反解总步数：
        # 只补偿 overlap（模型必须生成它）；裁头/裁尾是生成后的额外裁剪，不靠多生成来补
        ideal_k = (fps * T - (N + 1) * B + N * overlap_frames) / S
        cands = sorted({int(ideal_k // 1), int(ideal_k // 1) + 1, int(round(ideal_k))})
        best = None
        for mtot in cands:
            if mtot < k1 + N:                              # 每段至少 1 步
                continue
            kl = _tl_alloc_steps(mtot, k1, N)
            # 首段不剪头；非末段每段再剪 tf 帧尾
            s_net = F1 + sum(B + S * k - oeff for k in kl) - N * tf
            # 裁头/裁尾只是生成后裁掉：总目标相应变短（不靠多生成补回来）
            err = abs(s_net - (fps * T - N * tol - N * tf))
            if best is None or err < best[0]:
                best = (err, kl)
        klist = best[1] if best is not None else _tl_alloc_steps(k1 + N, k1, N)
        klist = [k1] + klist                            # 首段并进 klist，一起过手动覆盖
        klist, _ = _tl_build_override(klist, ovr, B, S, fps, oeff, maxF, seg_count)
        # 首段可能被手动改过 → 重算 F1
        F1 = B + S * klist[0]
        _tf1 = tf if len(klist) > 1 else 0
        _net1 = max(1, F1 - _tf1)
        out[0].update({"genFrames": F1, "netFrames": _net1, "tailFrames": _tf1, "genDuration": F1 / fps,
                       "netDuration": _net1 / fps, "exceed": F1 > maxF})

        cursor = _net1 / fps       # 时间轴游标（净增意义下：上一段净终点）
        for i, kk in enumerate(klist[1:]):
            gen = B + S * kk                                   # gen 天然落在网格上（步数直接展开）
            _tail = tf if i < len(klist) - 2 else 0
            net_eff = max(1, gen - oeff - _tail)               # 真实净增（允许不在网格上）
            out.append({"index": i + 2, "genFrames": gen, "netFrames": net_eff,
                        "overlapFrames": overlap_frames, "toleranceFrames": tol, "tailFrames": _tail,
                        "genStart": cursor - (overlap_frames + tol) / fps,
                        "netStart": cursor,
                        "genDuration": gen / fps, "netDuration": net_eff / fps,
                        "exceed": gen > maxF})
            cursor += net_eff / fps
    return out


_TL_SPLIT_MODES = ("all", "one", "loop")


_TL_TRIM_CACHE = {}


_TL_TRIM_CACHE_MAX = 64


def _tl_source_path(src, cfg_src):
    """把「源视频」解析成本机绝对路径：先看连进来的 `src`（VideoFromFile / 路径 / 列表取第一个视频），
    再看面板加载的 config.src（{name, subfolder, type}）。都没有 ⇒ ''。"""
    try:
        p = PreviewAnyNode._video_file_source(src) or ""
    except Exception:
        p = ""
    if p:
        return p
    try:
        if isinstance(cfg_src, dict):
            name = str(cfg_src.get("name") or "").strip()
            if name:
                hit = _ml_resolve(name)
                if hit:
                    return hit
    except Exception:
        pass
    return ""


def _tl_split_ranges(split, segs, idx, cfg):
    """按切分模式给出「源视频时间窗」列表 [(start_sec, dur_sec), ...]。

    · all  → 每段一段（用净时间轴 netStart/netDur，段间不重叠，拼起来正好是总时长）
    · one  → 一段，[oneStart, oneEnd)
    · loop → 只有 index 那一段
    """
    out = []
    mode = str(split or "all").lower()
    if mode not in _TL_SPLIT_MODES:
        mode = "all"
    if mode == "one":
        try:
            a = max(0.0, float(cfg.get("oneStart") or 0.0))
        except (TypeError, ValueError):
            a = 0.0
        try:
            b = float(cfg.get("oneEnd") or 0.0)
        except (TypeError, ValueError):
            b = 0.0
        # ★ 与前端 `tlOneRange` 严格同口径：终点缺省 / 非法 / 不大于起点 ⇒ 取「起点 + 5s」。
        #   这样只填了起点也能切出一段；若按 b - a > 0 判断，oneEnd=0 会得到空切片，
        #   表现为「切分模式=指定段，跑完什么都没有」。
        if not (b > a + 0.05):
            b = a + 5.0
        out.append((a, b - a))
        return out
    if mode == "loop":
        if 0 <= idx < len(segs):
            sg = segs[idx]
            out.append((float(sg.get("netStart") or 0.0),
                        float(sg.get("netDuration") or sg.get("genDuration") or 0.0)))
        return out
    for sg in segs:
        out.append((float(sg.get("netStart") or 0.0),
                    float(sg.get("netDuration") or sg.get("genDuration") or 0.0)))
    return out


def _tl_trim_video(path, start, dur, fmt="mp4"):
    """把 `path` 的 [start, start+dur) 秒切出来写成一个临时视频（H.264 + 尽量原样复制音轨）。
    成功返回临时文件绝对路径，失败返回 ''（不抛：切分失败不该让整张图崩）。"""
    try:
        import av
        import uuid
        from fractions import Fraction
    except Exception:
        return ""
    dest = ""
    try:
        start = max(0.0, float(start))
        dur = float(dur)
        if dur <= 1e-6 or not path or not os.path.isfile(path):
            return ""
        end = start + dur
        key = None
        try:
            st = os.stat(path)
            key = (os.path.abspath(path), int(st.st_mtime), int(st.st_size),
                   round(start, 4), round(dur, 4), fmt)
            hit = _TL_TRIM_CACHE.get(key)
            if hit and os.path.isfile(hit):
                return hit
        except Exception:
            key = None
        _ezpv_sweep()
        tmpdir = folder_paths.get_temp_directory()
        try:
            os.makedirs(tmpdir, exist_ok=True)
        except Exception:
            pass
        fmt = (fmt or "mp4").lower()
        container = {"mkv": "matroska", "mov": "mov", "avi": "avi"}.get(fmt, fmt)
        dest = os.path.join(tmpdir, "ezflex_tl_" + uuid.uuid4().hex + "." + fmt)
        with av.open(path, mode="r") as inp:
            vstream = next((s for s in inp.streams if s.type == "video"), None)
            if vstream is None:
                return ""
            astream = next((s for s in inp.streams if s.type == "audio"), None)
            # ⚠️ PyAV 18 的 add_stream(rate=…) 只吃 Fraction/int，传 float 会 AttributeError
            try:
                rate = vstream.average_rate
            except Exception:
                rate = None
            if not rate:
                rate = Fraction(24, 1)
            try:
                otb = Fraction(1, 1) / rate        # 输出帧时间基 = 1/fps
            except Exception:
                otb = Fraction(1, 24)
            if start > 0:                       # 关键帧回退定位，再靠时间戳把窗口前的帧丢掉
                try:
                    inp.seek(int(start * 1000000), backward=True)
                except Exception:
                    pass
            wrote = False
            with av.open(dest, mode="w", format=container) as out:
                ostream = out.add_stream("libx264", rate=rate)
                ostream.pix_fmt = "yuv420p"
                oaudio = None
                if astream is not None:
                    try:
                        oaudio = out.add_stream_from_template(astream)   # 音轨原样复制
                    except Exception:
                        try:
                            oaudio = out.add_stream("aac", rate=astream.rate)
                        except Exception:
                            oaudio = None
                streams = [vstream] + ([astream] if astream is not None else [])
                _obase = 0.0
                if oaudio is not None and astream is not None:
                    try:
                        _obase = float(oaudio.time_base or astream.time_base or Fraction(1, astream.rate))
                    except Exception:
                        _obase = 0.0
                done = False
                for packet in inp.demux(*streams):
                    if packet.dts is None or done:
                        continue
                    if packet.stream is vstream:
                        for frame in packet.decode():
                            t = frame.time
                            if t is None:
                                try:
                                    t = float(packet.pts) * float(vstream.time_base)
                                except Exception:
                                    t = start
                            if t < start - 1e-3:
                                continue
                            if t >= end:
                                done = True
                                break
                            # ★ 必须写**显式 pts + 时间基**：只把 pts 置 None 时 PyAV 18 会把
                            #   average_rate 记成「帧数 × fps」（实测 12 帧 → 288fps / 时长 1/24s），
                            #   切出来的片段时长全错，下游按帧率取帧就会崩。
                            frame.pts = wrote
                            frame.time_base = otb
                            for p in ostream.encode(frame):
                                out.mux(p)
                            wrote += 1
                    elif oaudio is not None and packet.stream is astream:
                        try:
                            t = float(packet.pts) * float(astream.time_base)
                            if start - 1e-3 <= t < end:
                                # ★ 音轨也要从 0 重新计时；否则视频从 0 开始、音频还带 start 偏移，下游会不同步。
                                if _obase > 0:
                                    packet.pts = int(round(max(0.0, t - start) / _obase))
                                    packet.dts = packet.pts
                                packet.stream = oaudio
                                out.mux(packet)
                        except Exception:
                            pass
                for p in ostream.encode():
                    out.mux(p)
                if oaudio is not None:
                    try:
                        for p in oaudio.encode():
                            out.mux(p)
                    except Exception:
                        pass
            if not wrote:
                try:
                    os.remove(dest)
                except Exception:
                    pass
                return ""
        if key is not None:
            if len(_TL_TRIM_CACHE) >= _TL_TRIM_CACHE_MAX:
                _TL_TRIM_CACHE.clear()
            _TL_TRIM_CACHE[key] = dest
        return dest
    except Exception:
        try:
            if dest and os.path.isfile(dest):
                os.remove(dest)
        except Exception:
            pass
        return ""


_TL_VIDEO_FMTS = ("video", "frames", "gif")


_TL_FRAMES_MAX = 960


def _tl_frames_tensor(frames):
    """numpy HWC uint8 帧列表 → ComfyUI IMAGE 批次 [T,H,W,3] float32（0..1）。空 ⇒ None。"""
    try:
        if not frames:
            return None
        # 一次转换、就地除：比 astype(float32) + 新数组少一份整份拷贝（峰值 ×1.8 左右）
        return torch.from_numpy(np.stack(frames, axis=0)).to(torch.float32).div_(255.0)
    except Exception:
        return None


def _tl_slice_frames(path, start, dur, budget=None, stride=1):
    """把 [start, start+dur) 秒解成 IMAGE 批次（不解码音轨）。budget = 最多解多少帧（None = 不限）；
    stride = 每隔 N 帧取一帧（VHS 的 select_every_nth 同语义，只影响输出帧）。"""
    try:
        import av
    except Exception:
        return None
    try:
        start = max(0.0, float(start))
        dur = float(dur)
        if dur <= 1e-6 or not path or not os.path.isfile(path):
            return None
        stride = max(1, int(stride or 1))
        end = start + dur
        frames = []
        idx = 0
        with av.open(path, mode="r") as inp:
            vstream = next((s for s in inp.streams if s.type == "video"), None)
            if vstream is None:
                return None
            if start > 0:
                try:
                    inp.seek(int(start * 1000000), backward=True)
                except Exception:
                    pass
            # 用 decode() 而不是 demux()+packet.decode()：H.264 尾部有 B 帧重排延迟，
            # demux 结束不会 flush ⇒ 直接按时间切会少掉最后 1~2 帧（-22 取成 -20）。decode() 会自己 flush。
            for frame in inp.decode(vstream):
                t = frame.time
                if t is None:
                    try:
                        t = float(frame.pts) * float(vstream.time_base)
                    except Exception:
                        t = start
                if t < start - 1e-3:
                    continue
                if t >= end:
                    return _tl_frames_tensor(frames)
                if stride > 1 and (idx % stride):
                    idx += 1
                    continue
                idx += 1
                frames.append(frame.to_ndarray(format="rgb24"))
                if budget is not None and len(frames) >= budget:
                    return _tl_frames_tensor(frames)
        return _tl_frames_tensor(frames)
    except Exception:
        return None


def _tl_save_gif(frames, fps, seq=1):
    """IMAGE 批次 → 动图存到 output 目录，返回路径（失败给 ''）。文件名带秒级时间戳 + 序号，不覆盖。"""
    try:
        from PIL import Image
        if frames is None or int(frames.shape[0]) <= 0:
            return ""
        out_dir = folder_paths.get_output_directory()
        os.makedirs(out_dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        dest = os.path.join(out_dir, "EzFlex_TimeLine_%s_%02d.gif" % (stamp, max(1, int(seq))))
        n = 2
        while os.path.exists(dest):
            dest = os.path.join(out_dir, "EzFlex_TimeLine_%s_%02d_%d.gif" % (stamp, max(1, int(seq)), n))
            n += 1
        delay = max(20, int(round(1000.0 / max(1.0, float(fps or 24)))))
        arr = frames.detach().to("cpu").clamp(0, 1).numpy()
        imgs = [Image.fromarray((arr[i] * 255.0).astype(np.uint8)) for i in range(arr.shape[0])]
        imgs[0].save(dest, save_all=True, append_images=imgs[1:], duration=delay, loop=0)
        return dest
    except Exception:
        return ""


# 节点：纯预览节点（无输出）：吃 timeplan + 每段 video，拖分段时回写 TimePlan。
class TimeLineNode:
    """EzFlex-TimeLine：时间轴（**回看 + 调段**）。

    规划来自上游 `EzFlex-TimePlan` 的 `timeplan` 口；成片来自 `video` 口（每段一项）。
    **没有输出口**，
    所以必须 `OUTPUT_NODE = True`，否则没接出口时内核根本不会调度它。

    面板上拖动分段改每段时长 ⇒ **回写上游 TimePlan 的 `config.segOverride`**
    源视频切分已经独立成 `EzFlex-SplitVideo`，这里不再有 src / 切分模式 / 输出格式。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "config": ("STRING", {"multiline": True, "default": "{}",
                                      "tooltip": "Timeline view state (merge view, zoom, ...)."}),
            },
            "optional": {
                "timeplan": ("EZFLEX_TIMEPLAN", {"tooltip": "Optional plan from EzFlex-TimePlan. Without it the timeline uses a default empty plan."}),
                "video": ("*", {"forceInput": True,
                                "tooltip": "Per-segment videos (list) for preview: item i = segment i."}),
            },
        }

    # ★ 没有输出口（纯回看/调段节点）
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    OUTPUT_NODE = True
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Time Line"

    def run(self, timeplan=None, video=None, config="{}", **kwargs):
        # 没有输出口：内核只要求返回一个 dict（可为空）
        return {}


# 节点：按模型帧网格把总时长切成段，输出本段 genFrames + 完整 plan（下游统一从 plan 取数）。
class TimePlanNode:
    """EzFlex-TimePlan：按模型帧网格把总时长规划成分段，输出**本段**的帧数 + 完整规划表。

    规划口径与 `EzFlex-TimeLine` **完全一致**（共用 `_tl_plan`），只是把「算」从「看」里拆出来：
      · 本节点：吃 `index` -> 算第 i 段 -> 输出帧数 + `timeplan`
      · TimeLine：只管展示 + 裁头/落盘/清显存/进度
    下游统一从 `timeplan` 取数（视频生成读 `cur.genFrames`、裁头读 `cur.overlapFrames + toleranceFrames`、
    切素材读 `segments[i]`、收口读 `total`），一个端口喂饱所有人。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": (list(_TL_MODELS.keys()), {"default": "minimax_h3"}),
                "total": ("FLOAT", {"default": 30.0, "min": 0.1, "step": 0.1,
                                    "tooltip": "Total length in seconds. Split into ceil(total / segment) segments."}),
                "segment": ("FLOAT", {"default": 5.0, "min": 0.1, "step": 0.1,
                                      "tooltip": "Target length of each segment in seconds (before overlap)."}),
                "fps": ("INT", {"default": 24, "min": 1, "max": 120}),
                "overlap": ("INT", {"default": 22, "min": 0, "max": 200,
                                    "tooltip": "Frames re-used from the previous segment's tail. Snapped DOWN to the model grid (MiniMax H3: 0 or 5+17k)."}),
                "tolerance": ("INT", {"default": 0, "min": 0, "max": 5,
                                      "tooltip": "Extra HEAD frames trimmed after generation for the transition (total head trim = overlap + head). Generation is NOT increased for it; total length gets shorter."}),
                "align": (["align", "strict"], {"default": "align",
                                                 "tooltip": "align = total length wins; strict = every segment (but the first) uses the SAME grid step."}),
                "config": ("STRING", {"multiline": True, "default": "{}",
                                      "tooltip": "Plan panel state (segOverride = per-segment manual durations, seconds)."}),
                "trim_tail": ("INT", {"default": 0, "min": 0, "max": 24,
                                      "tooltip": "Frames dropped from the END of each non-final segment (also shortens the plan, so the timeline stays in sync)."}),
                "audio_context_length": ("INT", {"default": 24, "min": 0, "max": 400,
                                                  "tooltip": "Transition audio length in video frames (official H3 example: video 22 / audio 24). MotionContext uses this when it follows the plan."}),
                "grid_b": ("INT", {"default": 5, "min": 0, "max": 1000,
                                    "tooltip": "Frame-grid base B. Frames must be B + S*k (H3 default 5 + 17k)."}),
                "grid_s": ("INT", {"default": 17, "min": 1, "max": 1000,
                                    "tooltip": "Frame-grid step S. Frames must be B + S*k (H3 default 5 + 17k)."}),
                "max_frames": ("INT", {"default": 362, "min": 1, "max": 100000,
                                        "tooltip": "Maximum generated frames per segment."}),
            },
            "optional": {
                "index": ("INT", {"default": 0, "min": 0, "forceInput": True,
                                   "tooltip": "Segment index (0-based). Wire EzFlex-LoopStart.index here. Out of range = 0 frames (lets the loop finish)."}),
            },
        }

    # ★ 只留 2 个口：中间的 trim/net 不再单独出口，
    #   要它们就从 timeplan 里取（cur.overlapFrames + cur.toleranceFrames / cur.netFrames）。
    # ★★ `timeplan` 排**第 0 位**，
    #   与 `LoopEnd` / `SplitVideo` 的口序保持一致。
    #   ⚠️ 槽位换了：老工作流序列化的 outputs 是 `[frames, timeplan]`，而 `cloneObject` 按**源下标**
    #   就地覆盖 ⇒ 加载后顺序还是老的（slot0=frames）。前端 `time_plan.js#ensurePlanPort` 会
    #   把 timeplan 挪到第 0 位 + 回写 `origin_slot`，老工作流的连线不会错位。
    RETURN_TYPES = ("EZFLEX_TIMEPLAN", "INT")
    RETURN_NAMES = ("timeplan", "frames")
    RETURN_TOOLTIPS = (
        "Full plan object: {index, total, fps, overlap, tolerance, segments:[...], cur:{...}}.",
        "Frames to GENERATE for this segment (= the sampler's length; always on the model grid, e.g. 5+17k for H3).",
    )
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Time Plan"

    def run(self, model="minimax_h3", total=30.0, segment=5.0, fps=24, overlap=22, tolerance=0,
            align="align", config="{}", index=0, trim_tail=0, audio_context_length=24,
            grid_b=5, grid_s=17, max_frames=362, **kwargs):
        try:
            cfg = json.loads(config) if isinstance(config, str) else (config or {})
        except Exception:
            cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}
        _custom = bool(cfg.get("customOn", False))
        segs = _tl_plan(model, total, segment, fps, overlap, tolerance, align,
                        cfg.get("segOverride") if _custom else None, trim_tail,
                        cfg.get("segCount") if _custom else None,
                        grid_b=grid_b, grid_s=grid_s, max_frames=max_frames)
        try:
            idx = max(0, int(index))
        except (TypeError, ValueError):
            idx = 0
        try:
            fps_i = max(1, int(fps))
        except (TypeError, ValueError):
            fps_i = 24
        n = len(segs)
        try:
            _actx = max(0, int(audio_context_length or 0))
        except (TypeError, ValueError):
            _actx = 24
        if idx >= n:                      # 越界 = 这一段不存在；给 0，让循环自己收尾
            plan = {"index": idx, "total": n, "fps": fps_i, "overlap": 0, "tolerance": 0, "tail": 0,
                    "audioContextFrames": _actx, "segments": segs, "cur": None}
            return (plan, 0)
        cur = segs[idx]
        ov = int(cur.get("overlapFrames", 0))
        tol = int(cur.get("toleranceFrames", 0))
        tail = int(cur.get("tailFrames", 0))
        plan = {"index": idx, "total": n, "fps": fps_i, "overlap": ov, "tolerance": tol, "tail": tail,
                "audioContextFrames": _actx, "segments": segs, "cur": cur, "nextRef": cfg.get("nextRef")}
        return (plan, int(cur["genFrames"]))


_EZMC_FPT = (1, 4, 4, 4, 4)     # FRAME_PER_TOKEN：每 5 个 latent step 覆盖 17 帧


_EZMC_FPS = 24.0


_EZMC_AUDIO_HZ = 40.0


def _ezmc_frames_for_steps(t, fpt=_EZMC_FPT):
    """t 个 latent step 覆盖多少像素帧。"""
    t = max(0, int(t))
    fpt = tuple(fpt or ())
    if not fpt:
        return 0
    return sum(fpt[i % len(fpt)] for i in range(t))


def _ezmc_steps_for_frames(n, fpt=_EZMC_FPT):
    """n 帧对应几个 latent step。返回 None = n 不是合法帧数（H3 须为 17k+5）。"""
    n = int(n)
    if n <= 0:
        return 0
    fpt = tuple(fpt or ())
    if not fpt:
        return None
    acc = 0
    for k in range(1, 512):
        acc += fpt[(k - 1) % len(fpt)]
        if acc == n:
            return k
        if acc > n:
            return None
    return None


def _ezmc_steps_floor_frames(n, fpt=_EZMC_FPT):
    """不超过 n 帧的最大 latent 步数（用于 overlap+tolerance 不是 17k+5 时近似跳过头部）。"""
    n = int(n)
    fpt = tuple(fpt or ())
    if n <= 0 or not fpt:
        return 0
    acc = 0
    for k in range(1, 512):
        acc += fpt[(k - 1) % len(fpt)]
        if acc > n:
            return max(0, k - 1)
        if acc == n:
            return k
    return 0


def _ezmc_streams(latent):
    """从 LATENT 取 (video, audio) 张量；兼容 NestedTensor 与「video/audio 分离」的 dict。"""
    s = latent.get("samples") if isinstance(latent, dict) else None
    a = latent.get("audio_latent") if isinstance(latent, dict) else None
    if s is None:
        return None, a
    ts = getattr(s, "tensors", None)
    if ts is not None and len(ts) >= 1:
        v = ts[0]
        if a is None and len(ts) >= 2:
            a = ts[1]
        return v, a
    return s, a


def _ezmc_next_head(timeplan, pin_next_head, steps, rt, fpt, fps):
    """重跑中间段时取「下一段已存 latent」的**可见头**（裁掉它自己的 overlap），用于本段尾部冻结。

    只在 pin_next_head 打开、且 timeplan.nextRef 存在、且本段正是它的前一段时返回；否则 None。
    """
    if not bool(pin_next_head) or not isinstance(timeplan, dict):
        return None
    nr = timeplan.get("nextRef")
    cur = timeplan.get("cur") or {}
    if not isinstance(nr, dict) or not nr:
        return None
    try:
        if int(cur.get("index", -1)) != int(nr.get("index", -2)) - 1:
            return None
    except (TypeError, ValueError):
        return None
    nr_dir = str(nr.get("dir") or "")
    try:
        nr_idx = int(nr.get("index"))
        port = max(1, int(nr.get("latentPort") or 2))
    except (TypeError, ValueError):
        return None
    p = ""
    meta = _ez_resume_media_meta(nr_dir, nr_idx)
    fname = str((meta.get("files") or {}).get(str(port)) or "")
    cand = []
    if fname:
        cand.append(fname)
    cand.append(str(nr.get("latentPath") or ""))
    cand += ["seg_%04d.v%d.pt" % (nr_idx, port), "seg_%04d_v%d.pt" % (nr_idx, port),
             "seg_%04d_v%d.latent" % (nr_idx, port)]
    for c in cand:
        if not c:
            continue
        q = c if os.path.isabs(c) else os.path.join(nr_dir, c)
        if os.path.isfile(q):
            p = q
            break
    if not p or not _ez_inside(p, _ezsp_allowed_roots()):
        return None
    nxt = _ez_load_latent_file(p)
    nv, na = _ezmc_streams(nxt)
    if nv is None:
        return None
    segs = timeplan.get("segments") if isinstance(timeplan.get("segments"), list) else []
    nseg = segs[nr_idx] if 0 <= nr_idx < len(segs) and isinstance(segs[nr_idx], dict) else {}
    try:
        ntrim = int(nseg.get("overlapFrames") or 0) + int(nseg.get("toleranceFrames") or 0)
    except (TypeError, ValueError):
        ntrim = 0
    off = _ezmc_steps_floor_frames(ntrim, fpt) if ntrim > 0 else 0
    aoff = int(round(ntrim / max(1e-6, float(fps or 24)) * 40)) if ntrim > 0 else 0
    return {"v": nv, "a": na, "steps": steps, "off": off, "rt": rt, "aoff": aoff}


def _ezmc_freeze_prefix(latent, context_latent, steps, start, rt, tail=None):
    """把上一段 AV latent 的尾部**写进**本段 latent 的前缀，并挂 video/audio 双路 noise_mask（0=冻结）。

    这是「冻结」路线（相对 keyframe 条件行）：本段前 `steps` 个 video 步、前 `rt` 个 audio tick
    直接等于上一段的尾部，采样器不重绘这段（mask=0），只生成后面。
    `start` 是上一段尾部在 latent 时间轴上的起点（已做相位对齐）。
    """
    from comfy.nested_tensor import NestedTensor
    src_v, src_a = _ezmc_streams(context_latent)
    tgt_v, tgt_a = _ezmc_streams(latent)
    if src_v is None or tgt_v is None:
        raise ValueError("当前段或上一段没有 AV latent")
    if src_v.ndim == 4:
        src_v = src_v.unsqueeze(0)
    if tgt_v.ndim == 4:
        tgt_v = tgt_v.unsqueeze(0)
    if int(tgt_v.shape[2]) < steps:
        raise ValueError("本段只有 %d 步，放不下 %d 步前缀" % (int(tgt_v.shape[2]), steps))
    if int(src_v.shape[2]) < steps:
        raise ValueError("上一段只有 %d 步，不足 %d 步" % (int(src_v.shape[2]), steps))
    if (int(src_v.shape[1]) != int(tgt_v.shape[1])
            or tuple(src_v.shape[3:]) != tuple(tgt_v.shape[3:])):
        raise ValueError("画布不一致（上一段 %s vs 本段 %s）"
                         % (tuple(src_v.shape[1:]), tuple(tgt_v.shape[1:])))
    v_tgt = tgt_v.clone()
    v_tgt[:, :, :steps] = src_v[:, :, start:start + steps].to(v_tgt.device, v_tgt.dtype)
    mask_v = torch.ones_like(v_tgt[:, :1])
    mask_v[:, :, :steps] = 0
    streams = [v_tgt]
    masks = [mask_v]
    if tgt_a is not None and int(tgt_a.shape[-1]) > 0:
        if tgt_a.ndim == 3:
            tgt_a = tgt_a.unsqueeze(0)
        a_tgt = tgt_a.clone()
        mask_a = torch.ones_like(a_tgt[:, :1])
        if rt > 0 and src_a is not None:
            if src_a.ndim == 3:
                src_a = src_a.unsqueeze(0)
            total_t = int(src_a.shape[-1])
            rt = max(0, min(int(rt), int(a_tgt.shape[-1]), total_t))
            if rt > 0:
                a_tgt[..., :rt] = src_a[..., total_t - rt:].to(a_tgt.device, a_tgt.dtype)
                mask_a[..., :rt] = 0
            streams.append(a_tgt)
        masks.append(mask_a)
    # ★ 尾部冻结（重跑中间段时对齐"下一段已存的头部"）：末尾 tail_steps 步写下一段裁剪后的可见头，
    #   音频同理取下一段音频裁剪后的前 tail_rt tick。mask 末尾同样置 0。
    _tail_ok = None
    try:
        if tail and int(tail.get("steps") or 0) > 0 and int(tail["steps"]) < int(v_tgt.shape[2]) - steps:
            _ts = int(tail["steps"])
            _tv = tail.get("v")
            if _tv is not None:
                if _tv.ndim == 4:
                    _tv = _tv.unsqueeze(0)
                _off = int(tail.get("off") or 0)
                if int(_tv.shape[2]) >= _off + _ts:
                    v_tgt[:, :, -_ts:] = _tv[:, :, _off:_off + _ts].to(v_tgt.device, v_tgt.dtype)
                    mask_v[:, :, -_ts:] = 0
                    _tail_ok = bool(torch.equal(v_tgt[:, :, -_ts:], _tv[:, :, _off:_off + _ts]))
            _ta = tail.get("a")
            if _ta is not None and len(streams) > 1:
                if _ta.ndim == 3:
                    _ta = _ta.unsqueeze(0)
                _trt = min(int(tail.get("rt") or 0), int(a_tgt.shape[-1]))
                _aoff = int(tail.get("aoff") or 0)
                if _trt > 0 and int(_ta.shape[-1]) >= _aoff + _trt:
                    a_tgt[..., -_trt:] = _ta[..., _aoff:_aoff + _trt].to(a_tgt.device, a_tgt.dtype)
                    mask_a[..., -_trt:] = 0
    except Exception as _exc:
        print("[EzFlex-MotionContext] 尾部冻结失败：%s" % _exc)
    out = dict(latent)
    out["samples"] = NestedTensor(tuple(streams)) if len(streams) > 1 else streams[0]
    out["noise_mask"] = NestedTensor(tuple(masks)) if len(masks) > 1 else masks[0]
    try:
        _ok = bool(torch.equal(v_tgt[:, :, :steps], src_v[:, :, start:start + steps]))
        _aok = None
        try:
            if len(streams) > 1 and src_a is not None and rt > 0:
                _aok = bool(torch.equal(streams[1][..., :rt], src_a[..., src_a.shape[-1] - rt:]))
        except Exception:
            _aok = None
        if tail and int(tail.get("steps") or 0) > 0:
            print("[EzFlex-MotionContext] 尾部冻结：%d 步 / %d tick（对齐下一段可见头，mask 末尾=0，校验 %s）"
                  % (int(tail["steps"]), int(tail.get("rt") or 0), _tail_ok))
        print("[EzFlex-MotionContext] 冻结校验：video prefix==上一段尾部 %s；audio prefix==上一段尾部 %s；"
              "video mask %s / audio mask %s；dtype=%s；mask 前缀最大值=%.3f；audio tick=%d（≈%.0fms）"
              % (_ok, _aok, tuple(mask_v.shape), (tuple(masks[1].shape) if len(masks) > 1 else None),
                 str(v_tgt.dtype), float(mask_v.max()), int(rt), rt * 25.0))
    except Exception:
        pass
    return out


def _ezmc_existing_keyframes(positive):
    """尽力读取 conditioning 上已有的 keyframes（例如 fl2v 的末帧）。"""
    try:
        if not positive:
            return []
        meta = positive[0][1] if isinstance(positive[0], (list, tuple)) else None
        if not isinstance(meta, dict):
            return []
        kfs = meta.get("minimax_keyframes") or []
        return [dict(kf) for kf in kfs if isinstance(kf, dict)]
    except Exception:
        return []


# 节点：把上一段 AV latent 的尾部钉进本段 conditioning（构造 H3 keyframe，零 VAE 往返）。
class MotionContextNode:
    """EzFlex-MotionContext：把上一段 AV latent 的尾部 N 帧「钉」进本段的 conditioning。

    **它确实是一个「条件」节点**（和内核 `MiniMaxH3AddGuide` 同一个位置、二选一、别串两个）：
    产物是 conditioning 上的 `minimax_keyframes` 元数据，内核 `PackedLayout` 会把这些 keyframe
    当作**额外的 cond 行**插进 packed sequence，并按 `resolved_frame_index` 摆到目标时间轴上、
    标成 `img_update=False`（硬锁、**永不被采样更新**，但参与 attention / RoPE）。

    与 `MiniMaxH3AddGuide` 的唯一区别：AddGuide 收**像素**（image/audio）自己 `vae.encode`；
    本节点直接收**上一段已经采样好的 AV latent**，切尾部若干个 latent step 当 keyframe 的 `latent`
    ⇒ **零 VAE 往返**（不 decode + encode，省一次有损重编码和一份显存）。这就是「零 patch」的含义：
    不改内核，只构造内核本来就认的 `keyframe["latent"]` 字段。

    两个 latent 入口的区别（**别接反**）：
      · `latent`         = **本段**要采样的 AV latent（= 视频生成节点输出的 LATENT，也就是即将喂给
                           采样器 `latent_image` 的那份）。用途只有两个：① 算出本段的 `frame_count`
                           写回 `minimax_frame_count`；② 和上一段比对 C/H/W，形状不一致就放弃钉帧。
      · `context_latent` = **上一段**已经采样好的 AV latent（由 `EzFlex-LoopStart.valueK` 回喂）。
                           它是**被钉进去的数据源**：取它尾部 `context_length` 帧对应的 latent step。
                           空着 = 本段不钉（首段就该空着）。裁多少帧由 plan 说了算，本节点不再出这个数。

    几何（H3 的帧/latent 换算：每 5 个 latent step 覆盖 17 帧，`FRAME_PER_TOKEN = (1,4,4,4,4)`）：
      22 帧 = 7 个 latent step（步数 = 2 + 5k，帧数 = 5 + 17k；39 帧 = 12 步）。
      把这 7 步钉在本段第 0 帧 ⇒ 本段前 22 帧 = 上一段的后 22 帧（重叠区）
      ⇒ 解码后必须裁掉头 22 帧（`EzFlex-SegmentPanel` 按 `plan` 自己裁），只保留新增的部分。
      所以 `context_length` 应该 = 规划里的 `overlapFrames + toleranceFrames`（TimePlan 那两格）。

    接法：`视频生成.positive → 本节点 → 采样器.conditioning`。
    `context_latent` 接 `EzFlex-LoopStart.valueK`（上一轮的 latent）；裁头交给 `EzFlex-SegmentPanel`
    （它按 timeplan 自己裁头，裁多少 = `overlapFrames + toleranceFrames`）—— 所以本节点**不再出**
    `trim_frames`（那个数在 plan 里本来就有）。

    第三个入口 `timeplan`：接 `EzFlex-TimePlan.timeplan`（或它下游任一透传口，
    例如 `EzFlex-LoopEnd.timeplan` / `EzFlex-SplitVideo.timeplan`）。**`follow_plan` 开着（默认）时**
    `context_length` 不再看上面那个手动框，而是直接取 `plan.cur.overlapFrames + toleranceFrames`
    ⇒ 改 TimePlan 的 overlap，这里自动跟着变，不会再出现「重复帧 / 丢帧」。
    规划说 overlap = 0 时**不钉**（不回落手动值）—— 手动框只在没接 `timeplan` 时生效。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
        "positive": ("CONDITIONING",),
        "latent": ("LATENT", {"tooltip": "This segment's AV latent to be sampled (used for frame_count / shape check)."}),
        "context_length": ("INT", {"default": 22, "min": 0, "max": 200,
                                   "tooltip": "Frames of video to pin (= overlap + tolerance from the plan). H3 valid values = 17k+5 (5 / 22 / 39 / 56 ...)."}),
        "context_audio_length": ("INT", {"default": 24, "min": 0, "max": 400,
                                         "tooltip": "Frames of audio to pin (0 = follow context_length automatically). The official example pairs 24 with video 22. When follow_plan is on, TimePlan's audio_context_length controls this."}),
        # ★ 追加在**最后**：ComfyUI 的 widgets_values 是**按位置**逐一对上的，
        #   插在 context_length 前面会让老工作流的两个数字框整体串值。
        "follow_plan": ("BOOLEAN", {"default": True,
                                    "tooltip": "When the `timeplan` port is wired, take context_length from the plan (overlap + tolerance) instead of the box above. Keeps pinning in sync with EzFlex-TimePlan."}),
        "pin_next_head": ("BOOLEAN", {"default": False,
                                      "tooltip": "Experimental: when TimeLine re-runs this segment, also pin the NEXT segment's saved head latent at this segment's tail."}),
        # ★ 同样追加在最后：老工作流没有这一格 ⇒ 取默认 keyframe，行为不变。
        "mode": (["keyframe", "masked"], {"default": "keyframe",
                                          "tooltip": "keyframe = the previous tail becomes conditioning rows (model may reshape it); masked = copy the previous tail into THIS latent's prefix and freeze it (mask 0), so only the future is generated."}),
    },
    "optional": {
        "context_latent": ("LATENT", {"tooltip": "PREVIOUS segment's AV latent (EzFlex-LoopStart.valueK) - the data that gets pinned. Not wired = nothing pinned (first segment)."}),
        "context_video_latent": ("*", {"tooltip": "Optional split video latent. Overrides the video half of context_latent (feed from a sampler-side AV latent split)."}),
        "context_audio_latent": ("*", {"tooltip": "Optional split audio latent. Overrides the audio half of context_latent."}),
        # ★ 规划口：接 EzFlex-TimePlan.timeplan（或它下游任一透传口，例如 LoopEnd.timeplan /
        #   SplitVideo.timeplan）。EZFLEX_TIMEPLAN 不是 widget 类型 ⇒ 不生成 widget ⇒ 老工作流不错位。
        "timeplan": ("EZFLEX_TIMEPLAN", {"tooltip": "Plan object (EzFlex-TimePlan.timeplan). With follow_plan on, context_length is taken from plan.cur.overlapFrames + toleranceFrames so pinning always matches the planner."}),
    },
}

    # ★ 输出 = timeplan 透传 + conditioning（用户要求 timeplan 放到第一个口）。
    #   老工作流的 `positive` 槽位由前端 onConfigure 的 reorderOutputs 迁移。
    RETURN_TYPES = ("EZFLEX_TIMEPLAN", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("timeplan", "positive", "latent")
    RETURN_TOOLTIPS = (
        "Pass-through of the incoming plan (same object as the `timeplan` input), so nodes OUTSIDE the loop (TimeLine / SegmentPanel) can read the plan. The head-trim amount is `plan.cur.overlapFrames + toleranceFrames`.",
        "Conditioning with the previous segment's tail pinned at frame 0 (hard-locked, never denoised). In masked mode this is the incoming conditioning, unchanged.",
        "Target AV latent. keyframe mode: the incoming latent, unchanged. masked mode: prefix frozen to the previous segment + video/audio noise_mask (wire it to the sampler's latent_image).",
    )
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Motion Context"

    def run(self, positive, latent, context_length=22, context_audio_length=0, follow_plan=True,
            pin_next_head=False, mode="keyframe",
            context_latent=None, context_video_latent=None, context_audio_latent=None,
            timeplan=None, **kwargs):
        try:
            import node_helpers
        except Exception:
            return (timeplan, positive, latent)
        # 分离输入：只覆盖对应半边；没接的那半边继续用 context_latent 里的
        if context_video_latent is not None or context_audio_latent is not None:
            # 明确区分：这里要的是 **latent**，不是解码后的图片序列/音频波形。
            _vv = context_video_latent.get("samples") if isinstance(context_video_latent, dict) else context_video_latent
            if isinstance(_vv, torch.Tensor) and _vv.ndim == 4 and int(_vv.shape[-1]) in (1, 3, 4):
                print("[EzFlex-MotionContext] context_video_latent 看起来是 IMAGE 像素序列（%s），不是 latent；"
                      "请接 AV latent 的 video 分片，或先 VAE Encode 再钉。" % (tuple(_vv.shape),))
            if isinstance(context_audio_latent, dict) and "waveform" in context_audio_latent:
                print("[EzFlex-MotionContext] context_audio_latent 看起来是 AUDIO 波形，不是 audio latent；请接 audio_latent。")
            _base = context_latent if isinstance(context_latent, dict) else {}
            _uv = lambda x: (x.get("samples") if isinstance(x, dict) else x)
            context_latent = {
                "samples": _uv(context_video_latent) if context_video_latent is not None else _base.get("samples"),
                "audio_latent": _uv(context_audio_latent) if context_audio_latent is not None else _base.get("audio_latent"),
            }
        _prof = timeplan.get("profile") if isinstance(timeplan, dict) and isinstance(timeplan.get("profile"), dict) else {}
        _fpt = tuple(_prof.get("frame_per_token") or _EZMC_FPT)
        # TimePlan 的输出里 fps 在顶层（plan.profile 从来没有产出过）：不取它会让 wan/ltx 也按 H3 的 24fps 钉帧。
        try:
            _plan_fps = float((timeplan or {}).get("fps") or 0) if isinstance(timeplan, dict) else 0.0
        except (TypeError, ValueError):
            _plan_fps = 0.0
        _mc_fps = float(_prof.get("fps") or _plan_fps or _EZMC_FPS)
        _mc_audio_hz = float(_prof.get("audio_hz") or (_EZMC_AUDIO_HZ if not _prof else 0.0))
        _mc_audio_on = bool(_prof.get("audio_enabled", True))
        if _prof and not _prof.get("frame_per_token"):
            _fpt = ()
        n = int(context_length)
        src = "manual"
        # ★ follow_plan：只要 `timeplan` 接上了，就**以规划为准**取「重叠 + 容差」帧数，
        #   保证「钉多少帧」永远等于 TimePlan 里那两格 —— 手动框这时只当没接规划时的兜底。
        #   （规划说 overlap=0 ⇒ n=0 ⇒ 不钉，这是对的，绝不回落手动值。）
        if follow_plan and isinstance(timeplan, dict):
            cur = timeplan.get("cur") if isinstance(timeplan.get("cur"), dict) else None
            ov = cur.get("overlapFrames") if cur else timeplan.get("overlap", 0)
            try:
                # ★ 只钉 overlap（必须是 5+17k 网格）；tolerance 是**自由生成的 burn-in**，
                #   由 SegmentPanel 连同 overlap 一起从头部裁掉，不参与钉入。
                #   （Director 的 lock_px + settling 同口径：settling 只裁不钉。）
                n = max(0, int(ov or 0))
            except (TypeError, ValueError):
                n = 0
            src = "plan"
        if n <= 0 or context_latent is None:      # 首段 / 未接上一段 / 规划无重叠：原样放行
            if context_latent is None:
                print("[EzFlex-MotionContext] 没有 context_latent（首段/未接），本段不钉；参考图由 H3 节点自己的 ref_images 负责")
            return (timeplan, positive, latent)
        if src == "plan":
            print("[EzFlex-MotionContext] 按规划钉 %d 帧（overlap；tolerance 由 SegmentPanel 裁）" % n)
        steps = _ezmc_steps_for_frames(n, _fpt)
        if steps is None:
            print("[EzFlex-MotionContext] context_length %d 不是 17k+5，跳过钉帧" % n)
            return (timeplan, positive, latent)
        src_v, src_a = _ezmc_streams(context_latent)
        tgt_v, _tgt_a = _ezmc_streams(latent)
        if src_v is None or tgt_v is None:
            return (timeplan, positive, latent)
        if src_v.ndim == 4:
            src_v = src_v.unsqueeze(0)
        if tgt_v.ndim == 4:
            tgt_v = tgt_v.unsqueeze(0)
        if (int(src_v.shape[1]) != int(tgt_v.shape[1])
                or tuple(src_v.shape[3:]) != tuple(tgt_v.shape[3:])):
            print("[EzFlex-MotionContext] 形状不一致（上一段 %s vs 本段 %s），跳过钉帧"
                  % (tuple(src_v.shape[1:]), tuple(tgt_v.shape[1:])))
            return (timeplan, positive, latent)
        T = int(src_v.shape[2])
        if T < steps:
            print("[EzFlex-MotionContext] 上一段只有 %d 步，不足 %d 步，跳过钉帧" % (T, steps))
            return (timeplan, positive, latent)
        start = T - steps
        if start % 5 != 0:                        # 相位对齐（FRAME_PER_TOKEN 周期 = 5）
            start = (start // 5) * 5
        if start + steps > T:
            start = max(0, start - 5)
        start = max(0, min(start, T - steps))     # 兜底：切片永远不越界
        # ★★ 把上一段的尾部作为**一个** keyframe 交出去，位置 = 本段第 0 帧。
        #   内核 `PackedLayout` 用 `_video_grid(vt, frame, cond_t)` 铺这个 keyframe 的**每一行**，
        #   而 `_video_t_grid` 会让第 k 步的时间坐标 = cond_t + Σ_{j<k} FRAME_RESCALE*FRAME_PER_TOKEN[j%5]
        #   ⇒ **一个多步 keyframe 自带正确的时间轴铺开**（这正是内核 fl2v 的 `vae.encode(多帧)` 写法：
        #   一段 22 帧的 guide 编码成多步，交给内核自己排时间）。
        #   ⚠️ 必须整段一个 keyframe：拆成 `steps` 个「单步」且全写 `resolved_frame_index: 0` 时，
        #      6 个 block 的 t 坐标会重叠在同一原点（RoPE 按 t 建）⇒ 钉进去的尾帧在时间轴上错位。
        #      参考实现 `comfyui-minimaxh3-contex-loop/nodes.py` 在原生 guide 路径上也是
        #      `blocks = [enc]; offsets = [0]`（整段一个 keyframe）。
        kfs = [{"resolved_frame_index": 0,
                "latent": src_v[:, :, start:start + steps]}]
        if follow_plan and isinstance(timeplan, dict):
            a_ctx = int(timeplan.get("audioContextFrames") or 0) or n
        else:
            a_ctx = int(context_audio_length) or n
        # ★ 冻结模式下音频窗口**必须等于**视频窗口：两者是同一份"冻住的前缀"，
        #   而 SegmentPanel 只按视频 overlap 裁头 → 音频多出来的部分会留在成片里（听起来像重复/错位）。
        #   （条件行/keyframe 模式不受影响：那里音频是"末端对齐、可更长"，多出的是额外上下文。）
        if str(mode or "keyframe").lower() == "masked":
            a_ctx = n
        rt = 0
        if src_a is not None and a_ctx > 0:
            if src_a.ndim == 3:
                src_a = src_a.unsqueeze(0)
            total_t = int(src_a.shape[-1])
            if _mc_audio_on and _mc_audio_hz > 0:
                rt = int(round(a_ctx / (_mc_fps or _EZMC_FPS) * _mc_audio_hz))
                rt = max(1, min(rt, total_t))
        # ★ 冻结模式：把上一段尾部写进本段 latent 前缀并挂 mask，然后直接返回；
        #   这条路径**不碰** conditioning（positive 原样透传），两种模式各自只改一个载体。
        if str(mode or "keyframe").lower() == "masked":
            _nh = _ezmc_next_head(timeplan, bool(pin_next_head), steps, rt, _fpt, _mc_fps)
            frozen = _ezmc_freeze_prefix(latent, context_latent, steps, start, rt, tail=_nh)
            print("[EzFlex-MotionContext] 冻结前缀 %d 帧（%d 步，audio %d tick，源 start=%d/%d%s）"
                  % (n, steps, rt, start, T, "，尾部对齐下一段" if _nh else ""))
            return (timeplan, positive, frozen)
        if rt > 0 and src_a is not None:
            total_t = int(src_a.shape[-1])
            kfs[0]["audio_latent"] = src_a[:1, ..., total_t - rt:total_t].clone()
        merged = list(kfs)
        # ★ 重跑专用：把**下一段**开头的 latent 钉到本段尾部（只当「下一段已经存在」时用）。
        #   通过 timeplan.nextRef 传入 {dir,index}，且只在 cur.index == index-1 时生效：
        #   连续重跑 K..M 时，中间段仍走普通「上一段→下一段」，只有最后一段 M 需要尾部参考 M+1。
        try:
            _nr = timeplan.get("nextRef") if isinstance(timeplan, dict) else None
            _cur = (timeplan.get("cur") or {}) if isinstance(timeplan, dict) else {}
            _cur_i = int(_cur.get("index", 0)) if _cur else -1
            if bool(pin_next_head) and isinstance(_nr, dict) and _cur_i == int(_nr.get("index", -2)) - 1:
                _nr_dir = str(_nr.get("dir") or "")
                _nr_idx = int(_nr.get("index"))
                try:
                    _latent_port = max(1, int(_nr.get("latentPort") or 2))
                except (TypeError, ValueError):
                    _latent_port = 2
                _nr_meta = _ez_resume_media_meta(_nr_dir, _nr_idx)
                _nr_file = str((_nr_meta.get("files") or {}).get(str(_latent_port)) or "")
                # ★ media.json 的 files 才是真实文件名（LoopEnd 落盘可带自定义名）；latentPath 只是兜底。
                _np = os.path.join(_nr_dir, _nr_file) if _nr_file else ""
                if not _np or not os.path.isfile(_np):
                    _nlp = str(_nr.get("latentPath") or "").strip()
                    _np = (_nlp if os.path.isabs(_nlp) else os.path.join(_nr_dir, _nlp)) if _nlp else ""
                if not _np or not os.path.isfile(_np):
                    for _cand in ("seg_%04d.v%d.pt" % (_nr_idx, _latent_port),
                                  "seg_%04d_v%d.pt" % (_nr_idx, _latent_port),
                                  "seg_%04d_v%d.latent" % (_nr_idx, _latent_port)):
                        _p2 = os.path.join(_nr_dir, _cand)
                        if os.path.isfile(_p2):
                            _np = _p2
                            break
                if _np and not _ez_inside(_np, _ezsp_allowed_roots()):
                    # nextRef 的 dir / latentPath 来自工作流 config，可以是任意绝对路径：
                    # 与 LoopStart 的 resumeDir 走同一道闸门再 torch.load（2026-11 复检 M-10）。
                    print("[EzFlex-MotionContext] nextRef is outside the allowed folders, skip tail pinning: %s" % _np)
                    _np = ""
                if os.path.isfile(_np):
                    _nxt = _ez_load_latent_file(_np)   # .latent 走核心格式；.pt 走旧格式（路径来自 nextRef，只读纯数据）
                    _nv, _na = _ezmc_streams(_nxt)
                    if _nv is not None:
                        if _nv.ndim == 4:
                            _nv = _nv.unsqueeze(0)
                        if (int(_nv.shape[1]) == int(tgt_v.shape[1])
                                and tuple(_nv.shape[3:]) == tuple(tgt_v.shape[3:])):
                            # 下一段 v2.pt 的头部含它自己的 overlap；按它导出时裁掉的头部偏移到“可见头”。
                            _nsegs = timeplan.get("segments") if isinstance(timeplan, dict) else []
                            _nseg = _nsegs[_nr_idx] if isinstance(_nsegs, list) and 0 <= _nr_idx < len(_nsegs) else {}
                            try:
                                _ntrim = int(_nseg.get("overlapFrames") or 0) + int(_nseg.get("toleranceFrames") or 0)
                            except (TypeError, ValueError):
                                _ntrim = 0
                            _noff = 0
                            if _ntrim > 0:
                                _noff = _ezmc_steps_floor_frames(_ntrim, _fpt)
                            if _noff + steps > int(_nv.shape[2]):
                                _noff = 0
                            frame_count = _ezmc_frames_for_steps(int(tgt_v.shape[2]), _fpt)
                            # ★ resolved_frame_index 的单位是「像素帧」，而 steps 是「latent 步」
                            #   （H3 的 7 步跨 22 帧）。以前按 steps 往回退，落点比真实片尾晚约 15 帧，
                            #   钉帧整段悬在片外 ⇒ 这个功能静默失效（2026-11 审计 P2-8）。
                            _tail_idx = max(0, frame_count - _ezmc_frames_for_steps(steps, _fpt))
                            _tail_idx = (_tail_idx // 5) * 5
                            _tkf = {"resolved_frame_index": int(_tail_idx),
                                    "latent": _nv[:, :, _noff:_noff + steps].clone()}
                            if _na is not None and a_ctx > 0:
                                if _na.ndim == 3:
                                    _na = _na.unsqueeze(0)
                                _noff_a = 0
                                if _ntrim > 0 and _mc_audio_hz > 0:
                                    _noff_a = int(round(_ntrim / (_mc_fps or _EZMC_FPS) * _mc_audio_hz))
                                _as = _na[:1, ..., _noff_a:_noff_a + rt]
                                if int(_as.shape[-1]) == int(rt):
                                    _tkf["audio_latent"] = _as.clone()
                            merged.append(_tkf)
                            print("[EzFlex-MotionContext] 尾部参考下一段 %d 帧（可见头偏移 %d 步）"
                                  % (steps, _noff))
        except Exception as _exc:
            print("[EzFlex-MotionContext] 尾部参考失败（忽略）：%s" % _exc)
        try:
            for kf in _ezmc_existing_keyframes(positive):
                if int(kf.get("resolved_frame_index", -1)) == 0:
                    continue                      # 丢掉 stock 首帧（已被我们的头替换）
                merged.append(kf)
        except Exception:
            pass
        frame_count = _ezmc_frames_for_steps(int(tgt_v.shape[2]), _fpt)
        try:
            out = node_helpers.conditioning_set_values(
                positive, {"minimax_keyframes": merged, "minimax_frame_count": frame_count})
        except Exception as exc:
            print("[EzFlex-MotionContext] 写 conditioning 失败：%s" % exc)
            return (timeplan, positive, latent)
        print("[EzFlex-MotionContext] 钉入 %d 帧（%d 步，start=%d/%d）%s"
              % (n, steps, start, T, " + 音频" if "audio_latent" in kfs[0] else ""))
        return (timeplan, out, latent)


_EZSP_MANIFEST = "manifest.json"


def _ezsp_out_root():
    """段落盘根目录：<ComfyUI>/output/EzFlex_Segments。拿不到就退到临时目录。"""
    try:
        import folder_paths
        base = folder_paths.get_output_directory()
    except Exception:
        import tempfile
        base = tempfile.gettempdir()
    p = os.path.join(base, "EzFlex_Segments")
    try:
        os.makedirs(p, exist_ok=True)
    except Exception:
        pass
    return p


_EZSP_CUR_RUN = {}   # base -> {"dir": run 目录, "t": 最后活动时间}


def _ez_img4(t, tag=""):
    """参考图/帧统一成 4 维 [T,H,W,C]：去掉多余的「1」前导维，并提示异常形状。
    下游是核心节点时，形状不对会炸在 resize/reshape 很深的位置（MiniMaxH3 _resize），这里先纠正/记录。"""
    try:
        if t is None or not hasattr(t, "ndim"):
            return t
        while t.ndim > 4 and int(t.shape[0]) == 1:
            t = t[0]
        if t.ndim != 4:
            print("[EzFlex] %s: IMAGE 期望 4 维 [T,H,W,C]，实际 %s" % (tag or "ref", tuple(t.shape)))
    except Exception:
        pass
    return t


def _ez_shape_note(tag, v):
    """输出图/帧类值时，非常规维度（>4 或 3 维但像图像）打一行日志：
    下游若是核心节点，形状不对会炸在 resize/reshape 很深的位置，这里先自报是谁。"""
    try:
        if hasattr(v, "ndim") and int(v.ndim) > 4:
            print("[EzFlex] %s 输出维度异常: %s（IMAGE 应为 [T,H,W,C]）" % (tag, tuple(v.shape)))
    except Exception:
        pass


def _ezsp_run_dir(base, idx):
    """一次循环 = 一个 run_<时间戳> 子目录：重跑不会覆盖上一次的 seg_*.mp4 / final.mp4。

    idx==0 时开新目录；同一次循环的后续段复用；断点续跑（idx>0 且没有活动 run）也开新目录。
    6 小时没有新段就视为上一次循环已结束（防止隔天续跑写进旧目录）。
    ★ 按 base 分开记：两个 SegmentPanel 用不同 save_dir 时以前共用一个全局槽，会互相顶掉、
      把同一次循环的段拆到两个 run 目录里。
    """
    try:
        base = os.path.abspath(str(base or "").strip() or _ezsp_out_root())
        now = time.time()
        ent = _EZSP_CUR_RUN.get(base) or {}
        if (int(idx or 0) <= 0 or not ent.get("dir")
                or now - float(ent.get("t") or 0) > 6 * 3600):
            stamp = time.strftime("%Y%m%d_%H%M%S", time.localtime(now))
            cand = os.path.join(base, "run_" + stamp)
            n = 1
            while os.path.isdir(cand) and any(x.startswith("seg_") for x in os.listdir(cand)):
                n += 1
                cand = os.path.join(base, "run_%s_%d" % (stamp, n))
            _EZSP_CUR_RUN[base] = {"dir": cand, "t": now}
            if len(_EZSP_CUR_RUN) > 8:   # 只留最近用过的几个，避免长期运行越攒越多
                for _k in sorted(_EZSP_CUR_RUN, key=lambda k: float((_EZSP_CUR_RUN[k] or {}).get("t") or 0))[:-8]:
                    _EZSP_CUR_RUN.pop(_k, None)
        else:
            ent["t"] = now
            _EZSP_CUR_RUN[base] = ent
        return _EZSP_CUR_RUN[base]["dir"]
    except Exception as exc:
        raise RuntimeError("[EzFlex-SegmentPanel] cannot create run folder under %s: %s" % (base, exc))


def _ezsp_pcm_of(audio, want_samples, target_sr=0):
    """AUDIO dict -> (ndarray[C,N] float32, sample_rate) 或 (None, 0)。

    ComfyUI 的 AUDIO = ``{"waveform": [B, C, N] float, "sample_rate": int}``。
    取第 0 个 batch；>2 声道只留前 2；按 `want_samples` 截断（音轨不能比画面长）。
    """
    try:
        import numpy as np
        if not isinstance(audio, dict):
            return None, 0
        wf = audio.get("waveform")
        sr = int(audio.get("sample_rate") or 0)
        if wf is None or sr <= 0:
            return None, 0
        a = wf
        if hasattr(a, "detach"):
            a = a.detach().cpu().float().numpy()
        a = np.asarray(a, dtype="float32")
        if a.ndim == 3:
            a = a[0]
        if a.ndim != 2 or int(a.shape[0]) < 1 or int(a.shape[1]) < 1:
            return None, 0
        if int(a.shape[0]) > 2:
            a = a[:2]
        if want_samples > 0 and int(a.shape[1]) > want_samples:
            a = a[:, :want_samples]
        if int(a.shape[1]) < 1:
            return None, 0
        if target_sr and int(target_sr) > 0 and int(target_sr) != sr:
            n_out = max(1, int(round(int(a.shape[1]) * float(target_sr) / float(sr))))
            x_old = np.linspace(0.0, 1.0, int(a.shape[1]), endpoint=False, dtype=np.float32)
            x_new = np.linspace(0.0, 1.0, n_out, endpoint=False, dtype=np.float32)
            a = np.stack([np.interp(x_new, x_old, a[c]).astype(np.float32) for c in range(int(a.shape[0]))], axis=0)
            sr = int(target_sr)
        return np.ascontiguousarray(a), sr
    except Exception as exc:
        print("[EzFlex-SegmentPanel] 音轨准备失败（这一段落无声）：%s" % exc)
        return None, 0


def _ezsp_encode_mp4(images, path, fps=24, audio=None, target_sr=0,
                     codec="auto", bit_depth="auto", color_space="sRGB", crf=0.0, metadata=None):
    """SegmentPanel 强制编码：参数语义与内置 CreateVideo/SaveVideo 一致。

    CreateVideo 只把 IMAGE+AUDIO 包成 VIDEO；SegmentPanel 因为循环落盘必须立刻写文件，
    所以这里复用同一条 VideoFromComponents.save_to 编码链，失败时直接报错，不做静默降级。
    """
    b = int(images.shape[0]) if images is not None else 0
    if b < 1:
        raise ValueError("[EzFlex-SegmentPanel] 没有可编码的帧")
    from comfy_api.latest import InputImpl, Types
    from fractions import Fraction
    _cs = str(color_space or "sRGB")
    if _cs not in ("sRGB", "HDR", "HDR PQ"):
        _cs = "sRGB"
    _bd = 10 if _cs in ("HDR", "HDR PQ") else 8
    if str(bit_depth or "auto").lower() not in ("auto", ""):
        _bd = int(bit_depth)
    _a = audio
    if isinstance(_a, dict):
        _wf = _a.get("waveform")
        _sr = int(_a.get("sample_rate") or 0)
        if _wf is not None and target_sr and _sr and int(target_sr) != _sr:
            _n = max(1, int(round(int(_wf.shape[-1]) * float(target_sr) / float(_sr))))
            _wf = torch.nn.functional.interpolate(_wf, size=_n, mode="linear", align_corners=False)
            _a = {"waveform": _wf, "sample_rate": int(target_sr)}
    _codec = str(codec or "auto").lower()
    if _codec in ("", "auto"):
        _codec = "h264"
    if _codec not in ("h264", "av1"):
        raise ValueError("[EzFlex-SegmentPanel] 不支持的编码器：%s" % codec)
    _comp = Types.VideoComponents(images=images, audio=_a, frame_rate=Fraction(max(1, int(fps)), 1))
    _vid = InputImpl.VideoFromComponents(_comp, bit_depth=_bd, color_space=_cs)
    _crf = None
    try:
        if crf is not None and float(crf) > 0:
            _crf = float(crf)
    except (TypeError, ValueError):
        pass
    _vid.save_to(str(path), format=Types.VideoContainer.MP4, codec=Types.VideoCodec(_codec),
                 crf=_crf, bit_depth=_bd, color_space=_cs, metadata=metadata)
    if not (os.path.isfile(path) and os.path.getsize(path) > 0):
        raise RuntimeError("[EzFlex-SegmentPanel] 编码后文件为空：%s" % path)
    return path


def _ezsp_write_wav(audio, path, frames, fps, target_sr=0):
    """每段落一份「和画面等长」的 PCM 侧车；final 用它们一次性编码 AAC（接缝无逐段预延迟）。"""
    try:
        import wave
        n = int(frames or 0)
        if n <= 0:
            return ""
        pcm, sr = _ezsp_pcm_of(audio, 0, target_sr)
        if pcm is None or sr <= 0:
            return ""
        want = int(round(n / float(max(1, int(fps))) * sr))
        if want <= 0:
            return ""
        if int(pcm.shape[1]) >= want:
            pcm = pcm[:, :want]
        else:
            pcm = np.concatenate([pcm, np.zeros((int(pcm.shape[0]), want - int(pcm.shape[1])), dtype=pcm.dtype)], axis=1)
        data = (np.clip(pcm, -1.0, 1.0).T * 32767.0).astype("<i2")
        with wave.open(path, "wb") as w:
            w.setnchannels(int(data.shape[1]))
            w.setsampwidth(2)
            w.setframerate(int(sr))
            w.writeframes(data.tobytes())
        return path
    except Exception as exc:
        print("[EzFlex-SegmentPanel] WAV 侧车失败（final 退回逐段 AAC）：%s" % exc)
        return ""


def _ezsp_manifest_path(root):
    return os.path.join(root, _EZSP_MANIFEST)


def _ezsp_manifest_load(root):
    try:
        with _io.open(_ezsp_manifest_path(root), "r", encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return {}
        # 旧版本把「rename 之前的 .tmp」写进了 manifest（saved 没跟着 os.replace 更新）。
        # 读的时候纠正一次：历史 run 的分段回看、替换、拼成片都跟着修好，不用手工改 JSON。
        for s in (d.get("segments") or []):
            if not isinstance(s, dict):
                continue
            p = str(s.get("path") or "")
            if p.endswith(".tmp") and os.path.isfile(p[:-4]):
                s["path"] = p[:-4]
        return d
    except FileNotFoundError:
        return {}
    except Exception:
        # 损坏/被截断：先把它挪到旁边再返回空，否则下一次保存会整份覆盖，分段清单再也找不回来。
        _p = _ezsp_manifest_path(root)
        try:
            if os.path.isfile(_p):
                _bad = _p + ".broken-" + time.strftime("%Y%m%d_%H%M%S")
                os.replace(_p, _bad)
                print("[EzFlex-SegmentPanel] manifest 损坏，已备份为 %s" % os.path.basename(_bad))
        except Exception:
            pass
        return {}


def _ezsp_manifest_save(root, data):
    try:
        tmp = _ezsp_manifest_path(root) + ".tmp"
        with _io.open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _ezsp_manifest_path(root))
    except Exception as exc:
        print("[EzFlex-SegmentPanel] manifest 写入失败：%s" % exc)


def _ezsp_allowed_roots():
    """段落盘目录允许的根 = 标准根（input/output/temp/models…）**+ 根表里带 write 的目录**。

    ★ 为什么必须带第二组：用户完全可以选 `D:////MyVideos` 这种目录当 `save_dir`，只认标准根的话
    会把它判成「越权」；而它来自「选择文件夹」原生对话框（本机动作、路径由系统返回）。
    ★ 为什么不能只信请求参数里的 `dir`：那样这条路由就成了「任意目录浏览器」。
    """
    roots = []
    try:
        roots.extend(_ez_roots())
    except Exception:
        pass
    try:
        roots.extend(_ez_save_roots())
    except Exception:
        pass
    return roots


def _ezsp_write_roots():
    """写/删允许的根 = input/output/temp + 根表里带 write 的目录。

    不含 models 和「只读登记」的目录：那些只该被读（P2-7/M-15）。读路径仍用 _ezsp_allowed_roots()。
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
    try:
        roots.extend(_ez_save_roots())
    except Exception:
        pass
    return roots


def _ezsp_latest_run(base=None):
    """返回 base 下最近的 run_* 目录（带 manifest 或 seg_*.mp4 才算），供 TimeLine 在 properties 为空时自愈。"""
    try:
        base = os.path.abspath(str(base or "").strip() or _ezsp_out_root())
        if not os.path.isdir(base):
            return ""
        cands = []
        for name in os.listdir(base):
            p = os.path.join(base, name)
            if not os.path.isdir(p) or not name.startswith("run_"):
                continue
            if not (os.path.isfile(os.path.join(p, "manifest.json")) or
                    any(f.startswith("seg_") and f.endswith(".mp4") for f in os.listdir(p))):
                continue
            cands.append((os.path.getmtime(p), p))
        return max(cands)[1] if cands else ""
    except Exception:
        return ""


async def _ezsp_latest_run_get(req):
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden: local clients only"}, status=403)
    try:
        d = str(req.query.get("dir") or "").strip()
    except Exception:
        d = ""
    root = _ez_inside(d, _ezsp_write_roots()) if d else _ezsp_out_root()
    if not root:
        return _web.json_response({"ok": False, "dir": ""})
    p = _ezsp_latest_run(root)
    return _web.json_response({"ok": bool(p), "dir": p})


async def _ezsp_manifest_get(req):
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden: local clients only"}, status=403)
    try:
        d = str(req.query.get("dir") or "").strip()
    except Exception:
        d = ""
    root = _ez_inside(d, _ezsp_write_roots()) if d else _ezsp_out_root()
    if not root:
        return _web.json_response({"ok": False, "error": "outside allowed roots", "dir": d}, status=403)
    return _web.json_response({"ok": True, "dir": root, "manifest": _ezsp_manifest_load(root)})


def _ezsp_probe_media(path):
    """返回 (frames, fps)。只读 container 元数据，不解码整条。"""
    import av
    with av.open(path) as c:
        vs = next((s for s in c.streams if s.type == "video"), None)
        if vs is None:
            return 0, 24
        fps = float(vs.average_rate or vs.base_rate or 24) or 24.0
        frames = int(vs.frames or 0)
        if frames <= 0 and vs.duration and vs.time_base:
            frames = int(round(float(vs.duration * vs.time_base) * fps))
        return max(1, frames), max(1, int(round(fps)))


async def _ezsp_pick_video(req):
    """本机原生文件选择：挑一个视频文件（用于「用外部视频替换本段」）。"""
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    raw = str((data or {}).get("dir") or "").strip()

    def _first_dir(*cands):
        for c in cands:
            try:
                p = os.path.abspath(str(c or ""))
            except Exception:
                continue
            if os.path.isfile(p):
                p = os.path.dirname(p)
            if os.path.isdir(p):
                return p
        return ""

    # 传入的 run 目录可能已被删（例如用户先在资源管理器里删了视频/整个 run），
    # 逐级退到父目录、最近一次 run、默认段目录，别让原生框落到「此电脑 / 库」。
    initial = _first_dir(raw, os.path.dirname(os.path.abspath(raw)) if raw else "")
    if not initial:
        try:
            initial = _first_dir(_ezsp_latest_run(_ezsp_out_root()), _ezsp_out_root())
        except Exception:
            initial = ""
    initial = initial or None

    def _pick():
        p = ""
        err = ""
        if os.name == "nt":
            # Windows 优先用系统 OpenFileDialog（PowerShell STA）：比 Tk 更可靠，
            # 不会被主窗口挡住；仍然是「只能选文件」的原生框。
            try:
                import subprocess
                script = r'''
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Select segment video'
$d.Filter = 'Video files|*.mp4;*.mov;*.webm;*.mkv;*.m4v|All files|*.*'
$d.CheckFileExists = $true
$d.Multiselect = $false
if ($env:EZ_PICK_DIR -and (Test-Path -LiteralPath $env:EZ_PICK_DIR)) { $d.InitialDirectory = $env:EZ_PICK_DIR }
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName); exit 0 }
exit 2
'''
                env = os.environ.copy()
                env["EZ_PICK_DIR"] = initial or ""
                r = subprocess.run(
                    ["powershell.exe", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script],
                    capture_output=True, text=True, timeout=300, env=env)
                if r.returncode == 0:
                    p = (r.stdout or "").strip()
                elif r.returncode == 2:
                    return "", ""
                else:
                    err = (r.stderr or "").strip() or ("picker exit %s" % r.returncode)
            except Exception as exc:
                err = str(exc)
        if not p:
            # 非 Windows / PowerShell 失败时退回 Tk（在同一个工作线程里创建/销毁）。
            root = None
            try:
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                for _fn in (lambda: root.attributes("-topmost", True), root.lift, root.focus_force, root.update):
                    try:
                        _fn()
                    except Exception:
                        pass
                p = filedialog.askopenfilename(
                    parent=root, title="Select segment video", initialdir=initial or None,
                    filetypes=[("Video", "*.mp4 *.mov *.webm *.mkv *.m4v"), ("All files", "*.*")])
            except Exception as exc:
                return "", (err or str(exc))
            finally:
                if root is not None:
                    try:
                        root.destroy()
                    except Exception:
                        pass
        return p, err

    try:
        p, err = await asyncio.to_thread(_pick)
    except Exception as exc:
        return _web.json_response({"ok": False, "error": str(exc)}, status=500)
    return _web.json_response({"ok": bool(p), "path": p or "", "error": err or ""})


async def _ezsp_replace_segment(req):
    """用外部视频替换某一段：覆盖 seg_XXXX.mp4、抽 WAV、更新 manifest、重拼 final。

    `dir` 必须在允许根内（这是写入目标）；`src` **故意只校验「存在 + 视频后缀」**，不要求落在根内 ——
    它来自本机原生文件对话框，用户就是要拿任意位置的视频替换（与「替换整片」同款）。
    路由本身有 _ez_local 收口，所以不存在远端拿它当任意文件读入口的问题。"""
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    d = str((data or {}).get("dir") or "").strip()
    src = str((data or {}).get("src") or "").strip()
    root = _ez_inside(d, _ezsp_write_roots()) if d else ""
    if not root:
        return _web.json_response({"ok": False, "error": "outside allowed roots"}, status=403)
    if not src or not os.path.isfile(src):
        return _web.json_response({"ok": False, "error": "source video not found"}, status=400)
    if os.path.splitext(src)[1].lower() not in (".mp4", ".mov", ".webm", ".mkv", ".m4v"):
        return _web.json_response({"ok": False, "error": "unsupported video"}, status=400)
    try:
        idx = int((data or {}).get("index"))
    except (TypeError, ValueError):
        return _web.json_response({"ok": False, "error": "bad index"}, status=400)
    if idx < 0:
        return _web.json_response({"ok": False, "error": "bad index"}, status=400)
    try:
        import shutil
        os.makedirs(root, exist_ok=True)
        _base = "seg_%04d" % idx
        _ezsp_ver_ensure_current(root, _base)
        dest = os.path.join(root, _base + ".mp4")
        if os.path.abspath(src) != os.path.abspath(dest) and not _ezsp_same_file(src, dest):
            _tmp_d = dest + ".tmp"
            await asyncio.to_thread(shutil.copyfile, src, _tmp_d)
            os.replace(_tmp_d, dest)
        for _old in (os.path.splitext(dest)[0] + ".orig.mp4", os.path.splitext(dest)[0] + ".orig.wav"):
            try:
                if os.path.isfile(_old):
                    os.remove(_old)
            except Exception:
                pass
        _ezsp_ver_invalidate_latent(root, _base)
        frames, fps = await asyncio.to_thread(_ezsp_probe_media, dest)
        # 抽音轨成侧车 WAV（final 走「视频 copy + 单次 AAC」路径）
        wav = os.path.join(root, _base + ".wav")
        _tmp_w = wav + ".tmp"
        try:
            import subprocess
            import imageio_ffmpeg
            import wave as _wv
            _sr = 32000
            try:
                with _wv.open(wav, "rb") as _wr:
                    if _wr.getframerate() > 0:
                        _sr = int(_wr.getframerate())
            except Exception:
                pass
            exe = imageio_ffmpeg.get_ffmpeg_exe()
            rv = await asyncio.to_thread(subprocess.run, [exe, "-y", "-i", dest, "-vn", "-ac", "2", "-ar", str(_sr),
                                 "-c:a", "pcm_s16le", _tmp_w], capture_output=True)
            if rv.returncode == 0 and os.path.isfile(_tmp_w):
                os.replace(_tmp_w, wav)
            else:
                try:
                    os.remove(_tmp_w)
                except Exception:
                    pass
        except Exception:
            pass
        try:
            _ezsp_ver_add_current(root, _base, "replace")
        except Exception:
            pass
        mani = _ezsp_manifest_load(root)
        segs = mani.get("segments")
        if not isinstance(segs, list):
            segs = []
        segs = [s for s in segs if not (isinstance(s, dict) and int(s.get("i", -1)) == idx)]
        segs.append({"i": idx, "path": dest, "frames": frames, "trim": 0, "external": True})
        segs.sort(key=lambda s: int(s.get("i", 0)) if isinstance(s, dict) else 0)
        mani["segments"] = segs
        mani["fps"] = int(mani.get("fps") or fps)
        _ezsp_manifest_save(root, mani)
        paths = [s.get("path") for s in segs if isinstance(s, dict) and s.get("path")]
        _ffmt = str(mani.get("finalFormat") or "mp4").lower()
        if _ffmt not in ("mp4", "mkv", "webm"):
            _ffmt = "mp4"
        _fc = str(mani.get("finalCodec") or "auto").lower()
        try:
            _fcrf = float(mani.get("finalCrf") or 0)
        except (TypeError, ValueError):
            _fcrf = 0.0
        _fbd = str(mani.get("finalBitDepth") or "auto")
        _fcs = str(mani.get("finalColorSpace") or "sRGB")
        _ffps = int(mani.get("finalFps") or 0)
        try:
            _bf = max(0, int(mani.get("blendFrames") or 0))
        except (TypeError, ValueError):
            _bf = 0
        try:
            _ax = max(0, int(mani.get("audioXfadeMs") or 0))
        except (TypeError, ValueError):
            _ax = 0
        # ★ final 也是「先写 tmp 再 replace」：以前这里直接把 final.<fmt> 交给 ffmpeg，
        #   拼接中途失败会留下一只空/半截成片、把旧的好成片顶掉，接口却仍回 ok:true
        #   （2026-11 复检 H-7；同文件 2138/3014 两处早就是 tmp 写法，只有这里漏了）。
        _fp = os.path.join(root, "final." + _ffmt)
        _tmp_fp = _fp + ".tmp." + _ffmt
        final = await asyncio.to_thread(
            _ezsp_concat, paths, _tmp_fp, fmt=_ffmt, codec=_fc, crf=_fcrf,
            bit_depth=_fbd, color_space=_fcs, fps=_ffps,
            blend_frames=_bf, audio_xfade_ms=_ax) if paths else ""
        if final:
            try:
                os.replace(_tmp_fp, _fp)
                final = _fp
            except OSError as exc:
                return _web.json_response({"ok": False, "error": "cannot finalize %s: %s" % (_fp, exc)},
                                          status=500)
        elif paths:
            try:
                if os.path.isfile(_tmp_fp):
                    os.remove(_tmp_fp)
            except OSError:
                pass
        return _web.json_response({"ok": True, "dir": root, "file": os.path.basename(dest),
                                   "frames": frames, "fps": fps, "final": final or ""})
    except Exception as exc:
        return _web.json_response({"ok": False, "error": str(exc)}, status=500)


async def _ezsp_replace_final(req):
    """用外部视频直接替换整条 final。"""
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    d = str((data or {}).get("dir") or "").strip()
    src = str((data or {}).get("src") or "").strip()
    root = _ez_inside(d, _ezsp_write_roots()) if d else ""
    if not root:
        return _web.json_response({"ok": False, "error": "outside allowed roots"}, status=403)
    if not src or not os.path.isfile(src):
        return _web.json_response({"ok": False, "error": "source video not found"}, status=400)
    if os.path.splitext(src)[1].lower() not in (".mp4", ".mov", ".webm", ".mkv", ".m4v"):
        return _web.json_response({"ok": False, "error": "unsupported video"}, status=400)
    try:
        import shutil
        os.makedirs(root, exist_ok=True)
        _mani = _ezsp_manifest_load(root)
        _ffmt = str(_mani.get("finalFormat") or "mp4").lower()
        if _ffmt not in ("mp4", "mkv", "webm"):
            _ffmt = "mp4"
        dest = os.path.join(root, "final." + _ffmt)
        _ezsp_ver_ensure_current(root, "final")
        _changed = False
        if os.path.abspath(src) != os.path.abspath(dest) and not _ezsp_same_file(src, dest):
            _tmp_d = dest + ".tmp"
            shutil.copyfile(src, _tmp_d)
            os.replace(_tmp_d, dest)
            _changed = True
        if _changed:
            _ezsp_ver_add_current(root, "final", "replace")
        _mani["final"] = dest
        _ezsp_manifest_save(root, _mani)
        return _web.json_response({"ok": True, "dir": root, "final": dest})
    except Exception as exc:
        return _web.json_response({"ok": False, "error": str(exc)}, status=500)


async def _ezsp_versions_get(req):
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden"}, status=403)
    try:
        d = str(req.query.get("dir") or "").strip()
        base = str(req.query.get("base") or "final").strip()
    except Exception:
        d, base = "", "final"
    root = _ez_inside(d, _ezsp_write_roots()) if d else ""
    if not root or not re.match(r"^[A-Za-z0-9_.-]+$", base):
        return _web.json_response({"ok": False, "error": "bad dir/base"}, status=400)
    man = _ezsp_versions_load(root, base)
    out = []
    for it in man.get("items", []):
        if isinstance(it, dict):
            out.append({"id": str(it.get("id")), "kind": str(it.get("kind") or ""), "time": str(it.get("time") or "")})
    return _web.json_response({"ok": True, "dir": root, "base": base, "current": str(man.get("current") or ""), "items": out})


def _ezsp_rebuild_final(root):
    """按当前 manifest 的 segments 重拼 final，并登记 final 版本。"""
    mani = _ezsp_manifest_load(root)
    segs = mani.get("segments") if isinstance(mani.get("segments"), list) else []
    paths = [s.get("path") for s in segs if isinstance(s, dict) and s.get("path")]
    if not paths:
        return ""
    fmt = str(mani.get("finalFormat") or "mp4").lower()
    if fmt not in ("mp4", "mkv", "webm"):
        fmt = "mp4"
    fp = os.path.join(root, "final." + fmt)
    try:
        _ezsp_ver_ensure_current(root, "final")
    except Exception:
        pass
    tmp = fp + ".tmp." + fmt
    final = _ezsp_concat(
        paths, tmp, fmt=fmt,
        codec=str(mani.get("finalCodec") or "auto").lower(),
        crf=float(mani.get("finalCrf") or 0),
        bit_depth=str(mani.get("finalBitDepth") or "auto"),
        color_space=str(mani.get("finalColorSpace") or "sRGB"),
        fps=int(mani.get("finalFps") or 0),
        blend_frames=max(0, int(mani.get("blendFrames") or 0)),
        audio_xfade_ms=max(0, int(mani.get("audioXfadeMs") or 0)),
    )
    if final:
        os.replace(tmp, fp)
        _ezsp_ver_add_current(root, "final", "version")
        mani["final"] = fp
        _ezsp_manifest_save(root, mani)
        return fp
    return ""


async def _ezsp_version_set(req):
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    d = str((data or {}).get("dir") or "").strip()
    base = str((data or {}).get("base") or "").strip()
    vid = str((data or {}).get("id") or "").strip()
    root = _ez_inside(d, _ezsp_write_roots()) if d else ""
    if not root or not base or not re.match(r"^[A-Za-z0-9_.-]+$", base) or not re.match(r"^[A-Za-z0-9_.-]+$", vid):
        return _web.json_response({"ok": False, "error": "bad dir/base/id"}, status=400)
    man = _ezsp_versions_load(root, base)
    item = next((it for it in man.get("items", []) if isinstance(it, dict) and str(it.get("id")) == vid), None)
    if not item:
        return _web.json_response({"ok": False, "error": "version not found"}, status=404)
    files = item.get("files") if isinstance(item.get("files"), dict) else {}
    vp = os.path.join(root, str(files.get("video") or ""))
    if not os.path.isfile(vp):
        return _web.json_response({"ok": False, "error": "version video missing"}, status=404)
    try:
        # 恢复目标必须是该 base 的**真实**文件（成片可能是 final.mkv / final.webm）
        _dst = _ezsp_base_video(root, base)
        _tmp = _dst + ".tmp"
        await asyncio.to_thread(shutil.copy2, vp, _tmp)
        os.replace(_tmp, _dst)
        ap = os.path.join(root, str(files.get("audio") or ""))
        if base != "final":
            if os.path.isfile(ap):
                _tmpa = os.path.join(root, base + ".wav.tmp")
                await asyncio.to_thread(shutil.copy2, ap, _tmpa)
                os.replace(_tmpa, os.path.join(root, base + ".wav"))
            else:
                # 该版本没有音频侧车 ⇒ 清掉当前留下的旧 WAV，否则成片/重跑会带着上一版的音轨
                try:
                    if os.path.isfile(os.path.join(root, base + ".wav")):
                        os.remove(os.path.join(root, base + ".wav"))
                except Exception:
                    pass
        # ★ latent 有两种落盘格式：.pt（旧）/ .latent（核心 safetensors）。恢复时必须保留原扩展名，
        #   否则把 safetensors 内容写成 .pt，LoopStart/MotionContext 会被 torch.load 当 pickle 读而失败。
        _lat_name = os.path.basename(str(files.get("latent") or ""))
        _lat_ext = os.path.splitext(_lat_name)[1].lower()
        if _lat_ext not in (".pt", ".latent"):
            _lat_ext = ".pt"
        _lat_dst = ""
        lp = os.path.join(root, str(files.get("latent") or ""))
        if base != "final":
            # 先清掉旧版固定写出来的 <base>_v2.*，否则 nextRef 的兜底路径会抢先命中旧 latent
            for _old in (base + "_v2.pt", base + "_v2.latent"):
                _op = os.path.join(root, _old)
                try:
                    if os.path.abspath(_op) != os.path.abspath(lp) and os.path.isfile(_op):
                        os.remove(_op)
                except Exception:
                    pass
            if os.path.isfile(lp):
                _lat_dst = re.sub(r"[^0-9A-Za-z_.\-\u4e00-\u9fff]+", "_", _lat_name).strip(" ._-")
                if not _lat_dst.lower().endswith((".pt", ".latent")):
                    _lat_dst = base + "_v2" + _lat_ext
                _tmpl = os.path.join(root, _lat_dst + ".tmp")
                await asyncio.to_thread(shutil.copy2, lp, _tmpl)
                os.replace(_tmpl, os.path.join(root, _lat_dst))
        # 旧版这里会把 files["ref"] 目录 copytree 到 <base>.ref；但 files 从来没有 ref 键，
        # os.path.join(root, "") == root，于是第一次恢复就把整条 run 复制进 <base>.ref，
        # 第二次开始嵌套膨胀（copytree 先 list 完 src 再建 dst，第一次扫不到新建的目标目录）。
        # 恢复版本只需要切 video/audio/latent，不复制 run 目录。
        man["current"] = vid
        _ezsp_versions_save(root, base, man)
        if base != "final":
            mp = os.path.join(root, base + ".media.json")
            try:
                with _io.open(mp, "r", encoding="utf-8") as f:
                    media = json.load(f) or {}
            except Exception:
                media = {}
            if isinstance(media, dict):
                _fm = media.get("files") if isinstance(media.get("files"), dict) else {}
                _lat_ports = [str(k) for k, v in _fm.items()
                              if os.path.splitext(str(v))[1].lower() in (".pt", ".latent")]
                _lp = str((files or {}).get("latentPort") or "")
                if not _lp:
                    _lp = next((str(k) for k, v in _fm.items()
                                if _lat_name and os.path.basename(str(v)) == _lat_name), "")
                if not _lp:
                    _lp = _lat_ports[0] if _lat_ports else "2"
                _vk = next((str(k) for k, v in media.items() if str(v).lower() == "video"), "3")
                media[_vk] = "video"
                if _lat_dst:
                    _fm.pop(_lp, None)
                    _fm[_lp] = _lat_dst
                else:
                    for _k in _lat_ports:
                        _fm.pop(_k, None)
                media["files"] = _fm
                with _io.open(mp, "w", encoding="utf-8") as f:
                    json.dump(media, f, ensure_ascii=False)
            try:
                _ezsp_rebuild_final(root)
            except Exception as exc:
                print("[EzFlex-SegmentPanel] version final rebuild failed: %s" % exc)
        return _web.json_response({"ok": True, "dir": root, "base": base, "current": vid,
                                   "video": _dst, "file": os.path.basename(_dst)})
    except Exception as exc:
        return _web.json_response({"ok": False, "error": str(exc)}, status=500)


async def _ezsp_versions_clear(req):
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    d = str((data or {}).get("dir") or "").strip()
    base = str((data or {}).get("base") or "").strip()
    root = _ez_inside(d, _ezsp_write_roots()) if d else ""
    if not root or not re.match(r"^[A-Za-z0-9_.-]+$", base):
        return _web.json_response({"ok": False, "error": "bad dir/base"}, status=400)
    try:
        keep = max(1, int((data or {}).get("keep") or 1))
    except (TypeError, ValueError):
        keep = 1
    man = _ezsp_versions_load(root, base)
    items = [it for it in man.get("items", []) if isinstance(it, dict)]
    items.sort(key=lambda it: str(it.get("id")))
    cur = str(man.get("current") or "")
    item_ids = {str(it.get("id")) for it in items}
    keep_ids = {str(it.get("id")) for it in items[-keep:]}
    # ★ 当前版本必须留下：用户可能切到旧版本后再清理，只按「最新 N 个」删会把正在用的那版删掉，
    #   根目录里的视频还在、versions.json 却指向空目录，后面再切版本就全乱了。
    if cur and cur in item_ids:
        keep_ids.add(cur)
    drop = [it for it in items if str(it.get("id")) not in keep_ids]
    for it in drop:
        try:
            shutil.rmtree(_ezsp_ver_dir(root, base, str(it.get("id"))), ignore_errors=True)
        except Exception:
            pass
    man["items"] = [it for it in items if str(it.get("id")) in keep_ids]
    if cur in keep_ids:
        man["current"] = cur
    else:
        man["current"] = max(keep_ids) if keep_ids else ""
    _ezsp_versions_save(root, base, man)
    return _web.json_response({"ok": True, "kept": len(man["items"]), "removed": len(drop)})


async def _ezsp_trim_segment(req):
    """对已落盘的某一小段做非破坏性二次裁切（只跑 ffmpeg，不重新采样）。"""
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    try:
        idx = int((data or {}).get("index"))
        head = max(0, int((data or {}).get("head") or 0))
        tail = max(0, int((data or {}).get("tail") or 0))
    except (TypeError, ValueError):
        return _web.json_response({"ok": False, "error": "bad index/head/tail"}, status=400)
    root = _ez_inside(str((data or {}).get("dir") or ""), _ezsp_write_roots())
    if not root:
        return _web.json_response({"ok": False, "error": "outside allowed roots"}, status=403)
    mani = _ezsp_manifest_load(root)
    segs = mani.get("segments") if isinstance(mani.get("segments"), list) else []
    entry = next((s for s in segs if isinstance(s, dict) and int(s.get("i", -1)) == idx), None)
    if not entry or not entry.get("path") or not os.path.isfile(str(entry.get("path"))):
        return _web.json_response({"ok": False, "error": "segment not found"}, status=404)
    seg = str(entry.get("path"))
    _vbase = "seg_%04d" % idx
    try:
        _ezsp_ver_ensure_current(root, _vbase)
    except Exception:
        pass
    base, ext = os.path.splitext(seg)
    orig = base + ".orig" + ext
    wav = base + ".wav"
    owav = base + ".orig.wav"
    try:
        import shutil
        if not os.path.isfile(orig):
            shutil.copy2(seg, orig)
            if os.path.isfile(wav):
                shutil.copy2(wav, owav)
        frames, fps = await asyncio.to_thread(_ezsp_probe_media, orig)
        frames = max(1, int(frames))
        head = min(head, max(0, frames - 1))
        tail = min(tail, max(0, frames - head - 1))
        keep = max(1, frames - head - tail)
        if head == 0 and tail == 0:
            shutil.copy2(orig, seg)
            if os.path.isfile(owav):
                shutil.copy2(owav, wav)
        else:
            import subprocess
            import imageio_ffmpeg
            exe = imageio_ffmpeg.get_ffmpeg_exe()
            tmp = seg + ".trim.mp4"
            rv = await asyncio.to_thread(subprocess.run, [exe, "-y", "-ss", "%.6f" % (head / float(fps)), "-i", orig,
                                 "-t", "%.6f" % (keep / float(fps)),
                                 "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
                                 "-c:a", "aac", "-b:a", "192000", "-movflags", "+faststart", tmp],
                                capture_output=True)
            if rv.returncode != 0 or not os.path.isfile(tmp):
                raise RuntimeError((rv.stderr or b"").decode("utf-8", "replace")[-400:])
            os.replace(tmp, seg)
            if os.path.isfile(owav):
                import wave
                with wave.open(owav, "rb") as rf:
                    params = rf.getparams()
                    raw = rf.readframes(params.nframes)
                frame_bytes = max(1, params.nchannels * params.sampwidth)
                start = min(params.nframes, int(round(head / float(fps) * params.framerate)))
                end = min(params.nframes, int(round((frames - tail) / float(fps) * params.framerate)))
                with wave.open(wav, "wb") as wf:
                    wf.setparams(params._replace(nframes=max(0, end - start)))
                    wf.writeframes(raw[start * frame_bytes:end * frame_bytes])
        entry["frames"] = int(keep)
        entry["editHead"] = int(head)
        entry["editTail"] = int(tail)
        _ezsp_manifest_save(root, mani)
        try:
            _ezsp_ver_invalidate_latent(root, _vbase)
            _ezsp_ver_add_current(root, _vbase, "trim")
        except Exception:
            pass
        paths = [s.get("path") for s in segs if isinstance(s, dict) and s.get("path")]
        _ffmt = str(mani.get("finalFormat") or "mp4").lower()
        if _ffmt not in ("mp4", "mkv", "webm"):
            _ffmt = "mp4"
        _fc = str(mani.get("finalCodec") or "auto").lower()
        try:
            _fcrf = float(mani.get("finalCrf") or 0)
        except (TypeError, ValueError):
            _fcrf = 0.0
        _fbd = str(mani.get("finalBitDepth") or "auto")
        _fcs = str(mani.get("finalColorSpace") or "sRGB")
        _ffps = int(mani.get("finalFps") or 0)
        try:
            _bf = max(0, int(mani.get("blendFrames") or 0))
        except (TypeError, ValueError):
            _bf = 0
        try:
            _ax = max(0, int(mani.get("audioXfadeMs") or 0))
        except (TypeError, ValueError):
            _ax = 0
        _fp = os.path.join(root, "final." + _ffmt)
        try:
            _ezsp_ver_ensure_current(root, "final")
        except Exception:
            pass
        _tmp_fp = _fp + ".tmp." + _ffmt
        final = await asyncio.to_thread(
            _ezsp_concat, paths, _tmp_fp, fmt=_ffmt, codec=_fc, crf=_fcrf,
            bit_depth=_fbd, color_space=_fcs, fps=_ffps,
            blend_frames=_bf, audio_xfade_ms=_ax) if paths else ""
        if final:
            try:
                os.replace(_tmp_fp, _fp)
                final = _fp
                _ezsp_ver_add_current(root, "final", "trim")
            except Exception:
                pass
            mani["final"] = final
            _ezsp_manifest_save(root, mani)
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("ezflex.segment", {
                "dir": root, "index": idx, "total": int(mani.get("total") or len(paths)),
                "trim": int(entry.get("trim") or 0), "saved": seg,
                "file": os.path.basename(seg), "done": len(paths), "final": final or "",
            })
        except Exception:
            pass
        return _web.json_response({"ok": True, "dir": root, "frames": int(keep), "head": int(head),
                                   "tail": int(tail), "final": final or ""})
    except Exception as exc:
        return _web.json_response({"ok": False, "error": str(exc)}, status=500)


async def _ezsp_cache_clear(req):
    """删掉 run 目录里的 handoff 缓存（seg_XXXX_<名称>.pt / .latent，含旧版的 seg_XXXX.vN.pt）。可选 index 只删某一段。"""
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    d = str((data or {}).get("dir") or "").strip()
    root = _ez_inside(d, _ezsp_write_roots()) if d else _ezsp_out_root()
    if not root:
        return _web.json_response({"ok": False, "error": "outside allowed roots"}, status=403)
    idx = data.get("index")
    try:
        idx = int(idx) if idx is not None and str(idx).strip() != "" else None
    except (TypeError, ValueError):
        idx = None
    n = 0
    total = 0
    try:
        for fn in os.listdir(root):
            # 实际落盘是 seg_0001_v1.pt（LoopEnd）/ seg_0002_v2.pt（版本）/ seg_0003_<自定义名>.latent，
            # 旧版曾写过 seg_0001.v1.pt
            m = re.match(r"seg_(\d{4})[._].+\.(?:pt|latent)$", fn, re.IGNORECASE)
            if not m:
                continue
            if idx is not None and int(m.group(1)) != idx:
                continue
            fp = os.path.join(root, fn)
            try:
                total += int(os.path.getsize(fp))
                os.remove(fp)
                n += 1
            except Exception:
                pass
    except Exception as exc:
        return _web.json_response({"ok": False, "error": str(exc)}, status=500)
    return _web.json_response({"ok": True, "files": n, "bytes": total, "dir": root})


async def _ezsp_open_dir(req):
    """在资源管理器里打开**当前实际使用的**段落保存目录（`save_dir` 为空 ⇒ 默认
    `<output>/EzFlex_Segments`）。仅本机 + 目录必须落在允许根内，且只拉起系统文件管理器。"""
    if not _ez_local(req):
        return _web.json_response({"ok": False, "error": "forbidden: local clients only"}, status=403)
    try:
        data = await req.json()
    except Exception:
        data = {}
    d = str((data or {}).get("dir") or "").strip()
    root = _ez_inside(d, _ezsp_write_roots()) if d else _ezsp_out_root()
    if not root:
        return _web.json_response({"ok": False, "error": "outside allowed roots", "dir": d}, status=403)
    try:
        os.makedirs(root, exist_ok=True)          # 第一次跑之前目录还不存在，explorer 会开空
    except Exception:
        pass
    try:
        import subprocess
        if os.name == "nt":
            subprocess.Popen(["explorer", root])
        else:
            subprocess.Popen(["xdg-open", root])
        return _web.json_response({"ok": True, "dir": root})
    except Exception as exc:
        return _web.json_response({"ok": False, "error": str(exc)}, status=500)


def _ezsp_clean_vram():
    """段间清 Python 垃圾 + 归还空闲 CUDA 缓存块；不卸载已加载模型。"""
    try:
        import gc
        gc.collect()
    except Exception:
        pass
    try:
        import comfy.model_management as mm
        mm.soft_empty_cache()
    except Exception:
        pass


def _ezsp_same_file(a, b):
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _ezsp_versions_path(root, base):
    return os.path.join(root, str(base) + ".versions.json")


def _ezsp_versions_load(root, base):
    p = _ezsp_versions_path(root, base)
    try:
        with _io.open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("items"), list):
            return d
    except Exception:
        pass
    return {"current": "", "items": []}


def _ezsp_versions_save(root, base, data):
    p = _ezsp_versions_path(root, base)
    tmp = p + ".tmp"
    with _io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def _ezsp_base_video(root, base):
    """当前基础视频的真实路径：段是 seg_XXXX.mp4，成片可能是 mkv/webm/mov。
    优先用 manifest.final，其次按已知扩展名探测，最后回落 mp4。"""
    if str(base) == "final":
        try:
            _p = str((_ezsp_manifest_load(root) or {}).get("final") or "")
        except Exception:
            _p = ""
        if _p and os.path.isfile(_p):
            return _p
    for _ext in (".mp4", ".mkv", ".webm", ".mov", ".m4v"):
        _q = os.path.join(root, str(base) + _ext)
        if os.path.isfile(_q):
            return _q
    return os.path.join(root, str(base) + ".mp4")


def _ezsp_ver_dir(root, base, vid):
    return os.path.join(root, "versions", str(base), str(vid))


def _ezsp_ver_add_current(root, base, kind="generate", latent=None, latent_port=None):
    """把根目录的当前视频/音频归档成一个不可变版本，并把它设为 current。"""
    video = _ezsp_base_video(root, base)
    if not os.path.isfile(video):
        return ""
    d = _ezsp_versions_load(root, base)
    used = {str(it.get("id")) for it in d.get("items", []) if isinstance(it, dict)}
    n = 1
    while ("%04d" % n) in used:
        n += 1
    vid = "%04d" % n
    vdir = _ezsp_ver_dir(root, base, vid)
    os.makedirs(vdir, exist_ok=True)
    files = {}
    vdst = os.path.join(vdir, "video" + (os.path.splitext(video)[1].lower() or ".mp4"))
    shutil.copy2(video, vdst)
    files["video"] = os.path.relpath(vdst, root).replace("\\", "/")
    adst = None
    for cand in (os.path.join(root, str(base) + ".wav"),):
        if os.path.isfile(cand):
            adst = os.path.join(vdir, "audio.wav")
            shutil.copy2(cand, adst)
            files["audio"] = os.path.relpath(adst, root).replace("\\", "/")
            break
    if latent and os.path.isfile(latent):
        ldst = os.path.join(vdir, os.path.basename(latent))
        shutil.copy2(latent, ldst)
        files["latent"] = os.path.relpath(ldst, root).replace("\\", "/")
        if latent_port:
            files["latentPort"] = int(latent_port)
    elif latent:
        files["latent"] = str(latent)
    d.setdefault("items", []).append({
        "id": vid, "kind": str(kind), "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "files": files,
    })
    d["current"] = vid
    _ezsp_versions_save(root, base, d)
    return vid


def _ezsp_ver_ensure_current(root, base, kind="legacy"):
    """旧 run 第一次进入版本管理时，把根目录当前文件登记为 legacy 版本。"""
    d = _ezsp_versions_load(root, base)
    cur = str(d.get("current") or "")
    for it in d.get("items", []):
        if isinstance(it, dict) and str(it.get("id")) == cur:
            v = os.path.join(root, str(it.get("files", {}).get("video") or ""))
            if os.path.isfile(v):
                return cur
    if os.path.isfile(_ezsp_base_video(root, base)):
        _lat = ""
        _lat_k = None
        try:
            _mp = os.path.join(root, str(base) + ".media.json")
            if os.path.isfile(_mp):
                with _io.open(_mp, "r", encoding="utf-8") as _f:
                    _m = json.load(_f) or {}
                for _k, _fn in ((_m.get("files") or {}) if isinstance(_m, dict) else {}).items():
                    _p = os.path.join(root, str(_fn))
                    if os.path.splitext(str(_fn))[1].lower() in (".pt", ".latent") and os.path.isfile(_p):
                        _lat = _p
                        _lat_k = _k
                        break
        except Exception:
            _lat = ""
        return _ezsp_ver_add_current(root, base, kind=kind, latent=_lat, latent_port=_lat_k)
    return ""


def _ezsp_ver_attach_latent(root, base, latent_path, name="", port=None):
    d = _ezsp_versions_load(root, base)
    cur = str(d.get("current") or "")
    if not cur:
        return
    for it in d.get("items", []):
        if not isinstance(it, dict) or str(it.get("id")) != cur:
            continue
        if not latent_path or not os.path.isfile(latent_path):
            return
        vdir = _ezsp_ver_dir(root, base, cur)
        os.makedirs(vdir, exist_ok=True)
        fn = str(name or os.path.basename(latent_path) or "latent.pt")
        dst = os.path.join(vdir, fn)
        shutil.copy2(latent_path, dst)
        it.setdefault("files", {})["latent"] = os.path.relpath(dst, root).replace("\\", "/")
        if port:
            it["files"]["latentPort"] = int(port)
        _ezsp_versions_save(root, base, d)
        return


def _ezsp_ver_invalidate_latent(root, base):
    """替换/裁切后的视频不再对应旧 latent：从当前根目录和 media.json 里摘掉。"""
    mpath = os.path.join(root, str(base) + ".media.json")
    try:
        with _io.open(mpath, "r", encoding="utf-8") as f:
            m = json.load(f) or {}
    except Exception:
        m = {}
    files = m.get("files") if isinstance(m.get("files"), dict) else {}
    for fn in list(files.values()):
        p = os.path.join(root, str(fn))
        try:
            if os.path.isfile(p):
                os.remove(p)
        except Exception:
            pass
    if isinstance(m, dict) and "files" in m:
        m.pop("files", None)
        try:
            with _io.open(mpath, "w", encoding="utf-8") as f:
                json.dump(m, f, ensure_ascii=False)
        except Exception:
            pass


def _ezsp_probe_duration(path):
    """Video duration in seconds (container, else frames/fps); 0 on failure."""
    try:
        import av
        with av.open(path) as c:
            vs = next((s for s in c.streams if s.type == "video"), None)
            if vs is None:
                return 0.0
            if vs.duration and vs.time_base:
                return float(vs.duration * vs.time_base)
            if vs.frames and vs.average_rate:
                return float(vs.frames) / float(vs.average_rate)
    except Exception:
        pass
    return 0.0


def _ezsp_read_pcm(path):
    import wave
    with wave.open(path, "rb") as w:
        sr = int(w.getframerate())
        ch = int(w.getnchannels())
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    return pcm.reshape(-1, ch).astype(np.float32), sr, ch


def _ezsp_crossfade_pcm(parts, n):
    """Equal-power crossfade between consecutive PCM parts; shortens by n samples per seam."""
    out = parts[0]
    for nxt in parts[1:]:
        m = min(int(n), len(out), len(nxt)) if n > 0 else 0
        if m > 0:
            t = np.linspace(0.0, 1.0, m, dtype=np.float32)[:, None]
            out[-m:] = out[-m:] * (1.0 - t) + nxt[:m] * t
            nxt = nxt[m:]
        if len(nxt):
            out = np.concatenate([out, nxt], axis=0)
    return out


def _ezsp_concat_blend(paths, out_path, fmt="mp4", codec="auto", crf=0.0, bit_depth="auto",
                       color_space="sRGB", fps=0, blend_frames=0, audio_xfade_ms=0):
    """收口时做接缝混合：视频 xfade + WAV 侧车 PCM 交叉淡化。

    blend_frames > 0：视频相邻段用 xfade 过渡 D=blend_frames/fps 秒（成片会缩短 D×(段数-1)）。
    audio_xfade_ms > 0：音频用等功率交叉淡化；0 且视频有混合时自动跟随视频 D。
    """
    try:
        import subprocess
        import imageio_ffmpeg
        import wave
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        fmt = str(fmt or "mp4").lower()
        if fmt not in ("mp4", "mkv", "webm"):
            fmt = "mp4"
        codec = str(codec or "auto").lower()
        if codec not in ("auto", "h264", "h265", "av1"):
            codec = "auto"
        try:
            bf = max(0, int(blend_frames or 0))
        except (TypeError, ValueError):
            bf = 0
        try:
            ax = max(0, int(audio_xfade_ms or 0))
        except (TypeError, ValueError):
            ax = 0
        # 只开 audio_xfade_ms（blend_frames=0）时不能淡化：音频每缝会缩短 ax，画面不变 → 逐缝漂移。
        if bf <= 0:
            return ""
        wavs = [os.path.splitext(p)[0] + ".wav" for p in paths]
        if not all(os.path.isfile(w) for w in wavs):
            return ""       # 缺 PCM 侧车时不冒险：交给原路径逐段 AAC
        durs = [_ezsp_probe_duration(p) for p in paths]
        if any(d <= 0 for d in durs):
            return ""
        _fps = float(fps or 0)
        if _fps <= 0:
            try:
                import av
                with av.open(paths[0]) as _c:
                    _vs = next((s for s in _c.streams if s.type == "video"), None)
                    _fps = float(_vs.average_rate or 24) if _vs is not None else 24.0
            except Exception:
                _fps = 24.0
        D = min(float(bf) / _fps, min(durs) * 0.5) if bf > 0 else 0.0
        bd10 = (str(bit_depth) == "10" or (str(bit_depth) == "auto"
                                            and str(color_space) in ("HDR", "HDR PQ")))
        pix = "yuv420p10le" if bd10 else "yuv420p"
        vc = {"h264": "libx264", "h265": "libx265", "av1": "libsvtav1"}.get(codec)
        if fmt == "webm" and codec in ("h264", "h265"):
            vc = "libvpx-vp9"
        if not vc:
            vc = "libvpx-vp9" if fmt == "webm" else "libx264"
        ac = "libopus" if fmt == "webm" else "aac"
        tv = out_path + ".blend.video.mp4"
        tw = out_path + ".blend.audio.wav"
        try:
            # ---- video ----
            if D > 0:
                ins = []
                fparts = []
                for i, p in enumerate(paths):
                    ins += ["-i", str(p)]
                    fparts.append("[%d:v]fps=%s,format=%s[v%d]" % (i, str(int(round(_fps))), pix, i))
                prev = "v0"
                cur = durs[0]
                for i in range(1, len(paths)):
                    off = max(0.0, cur - D)
                    out = "x%d" % i
                    fparts.append("[%s][v%d]xfade=transition=fade:duration=%.6f:offset=%.6f[%s]"
                                  % (prev, i, D, off, out))
                    cur = cur + durs[i] - D
                    prev = out
                cmd = [exe, "-y"] + ins + ["-filter_complex", ";".join(fparts),
                                            "-map", "[%s]" % prev, "-an",
                                            "-c:v", vc, "-pix_fmt", pix, "-r", str(int(round(_fps))),
                                            "-t", "%.6f" % cur, tv]
                if float(crf or 0) > 0:
                    cmd[cmd.index("-c:v"):cmd.index("-c:v")] = ["-crf", str(int(float(crf)))]
                if str(color_space) in ("HDR", "HDR PQ"):
                    cmd += ["-colorspace", "bt2020nc", "-color_primaries", "bt2020",
                            "-color_trc", "arib-std-b67" if str(color_space) == "HDR" else "smpte2084"]
                r = subprocess.run(cmd, capture_output=True)
                if r.returncode != 0 or not os.path.isfile(tv):
                    print("[EzFlex-SegmentPanel] 视频 xfade 失败 rc=%s: %s"
                          % (r.returncode, (r.stderr or b"").decode("utf-8", "replace")[-600:]))
                    return ""
                total = cur
            else:
                lst = out_path + ".blend.list.txt"
                try:
                    with _io.open(lst, "w", encoding="utf-8") as fh:
                        for p in paths:
                            fh.write("file " + repr(str(p).replace(chr(92), "/")) + chr(10))
                    r = subprocess.run([exe, "-y", "-f", "concat", "-safe", "0", "-i", lst,
                                        "-map", "0:v:0", "-c:v", "copy", tv], capture_output=True)
                    if r.returncode != 0 or not os.path.isfile(tv):
                        return ""
                finally:
                    try:
                        os.remove(lst)
                    except Exception:
                        pass
                total = sum(durs)
            # ---- audio (WAV sidecars) ----
            wavs = [os.path.splitext(p)[0] + ".wav" for p in paths]
            have_audio = all(os.path.isfile(w) for w in wavs)
            if have_audio:
                parts = []
                sr = ch = 0
                for w in wavs:
                    pcm, _sr, _ch = _ezsp_read_pcm(w)
                    if not sr:
                        sr, ch = _sr, _ch
                    elif _sr != sr or _ch != ch:
                        # 混合路径要求所有段 WAV 同格式；不一致就回退纯拼接/逐段 AAC（保留声音），
                        # 不能继续生成 tw（下面的 mux 会走 -an，成片整条无声）。
                        print("[EzFlex-SegmentPanel] 接缝混合：WAV 采样率/声道不一致，退回纯拼接")
                        return ""
                    parts.append(pcm)
                if have_audio and parts:
                    n = int(round(ax / 1000.0 * sr)) if ax > 0 else int(round(D * sr)) if D > 0 else 0
                    out_pcm = _ezsp_crossfade_pcm(parts, n) if n > 0 else np.concatenate(parts, axis=0)
                    with wave.open(tw, "wb") as ww:
                        ww.setnchannels(ch)
                        ww.setsampwidth(2)
                        ww.setframerate(sr)
                        ww.writeframes(np.clip(out_pcm, -32768, 32767).astype("<i2").tobytes())
            # ---- mux ----
            cmd = [exe, "-y", "-i", tv]
            if os.path.isfile(tw):
                cmd += ["-i", tw, "-map", "0:v:0", "-map", "1:a:0"]
            else:
                cmd += ["-map", "0:v:0", "-an"]
            cmd += ["-c:v", "copy", "-pix_fmt", pix, "-t", "%.6f" % total]
            if float(crf or 0) > 0:
                cmd += ["-crf", str(int(float(crf)))]
            if os.path.isfile(tw):
                cmd += ["-c:a", ac, "-b:a", "192k"]
            if str(color_space) in ("HDR", "HDR PQ"):
                cmd += ["-colorspace", "bt2020nc", "-color_primaries", "bt2020",
                        "-color_trc", "arib-std-b67" if str(color_space) == "HDR" else "smpte2084"]
            cmd += [out_path]
            r = subprocess.run(cmd, capture_output=True)
            if r.returncode == 0 and os.path.isfile(out_path) and os.path.getsize(out_path) > 0:
                return out_path
            print("[EzFlex-SegmentPanel] 接缝混合封装失败 rc=%s" % r.returncode)
            return ""
        finally:
            for _f in (tv, tw):
                try:
                    if os.path.isfile(_f):
                        os.remove(_f)
                except Exception:
                    pass
    except Exception as exc:
        print("[EzFlex-SegmentPanel] 接缝混合异常：%s" % exc)
        return ""


def _ezsp_concat(paths, out_path, fmt="mp4", codec="auto", crf=0.0, bit_depth="auto", color_space="sRGB", fps=0,
                 blend_frames=0, audio_xfade_ms=0):
    """ffmpeg concat demuxer 收口。返回 out_path 或空串。

    先试**流拷贝**（`-c copy`，不解码、最快）；失败就退化成重编码 ——
    ★ 需要这个兜底的原因：只要有一段没音轨（比如那一段的 audio 没接上）、或者段之间的
      编码参数不完全一致，`-c copy` 就会直接失败，成片会**整条丢失**。
    """
    # ★ 接缝混合：开了 blend / audio xfade 才走混合拼接，否则走纯拼接；混合失败也退回纯拼接。
    try:
        if paths and (int(blend_frames or 0) > 0 or int(audio_xfade_ms or 0) > 0):
            _blended = _ezsp_concat_blend(paths, out_path, fmt=fmt, codec=codec, crf=crf,
                                          bit_depth=bit_depth, color_space=color_space, fps=fps,
                                          blend_frames=blend_frames, audio_xfade_ms=audio_xfade_ms)
            if _blended:
                return _blended
            print("[EzFlex-SegmentPanel] 接缝混合失败 ⇒ 退回纯拼接")
    except Exception as _bexc:
        print("[EzFlex-SegmentPanel] 接缝混合异常（退回纯拼接）：%s" % _bexc)
    # ★ 优先用每段的 PCM 侧车：视频流拷贝 + 整条音频只编码一次 AAC（逐段 AAC 的预延迟是接缝突变/漂移的根源）。
    try:
        _wavs = [os.path.splitext(p)[0] + ".wav" for p in (paths or [])]
        if paths and all(os.path.isfile(w) for w in _wavs):
            import subprocess
            import wave
            import imageio_ffmpeg
            _exe = imageio_ffmpeg.get_ffmpeg_exe()
            _lst = out_path + ".wlist.txt"
            _tv = out_path + ".video.mp4"
            _tw = out_path + ".audio.wav"
            _ta = out_path + ".audio.m4a"
            try:
                with _io.open(_lst, "w", encoding="utf-8") as fh:
                    for p in paths:
                        fh.write("file " + repr(str(p).replace(chr(92), "/")) + chr(10))
                _rv = subprocess.run([_exe, "-y", "-f", "concat", "-safe", "0", "-i", _lst,
                                      "-map", "0:v:0", "-c:v", "copy", _tv], capture_output=True)
                if _rv.returncode == 0 and os.path.isfile(_tv):
                    _sr = 0
                    _ch = 1
                    _parts = []
                    for _w in _wavs:
                        with wave.open(_w, "rb") as _wr:
                            if not _sr:
                                _sr = _wr.getframerate()
                                _ch = _wr.getnchannels()
                            elif _wr.getframerate() != _sr or _wr.getnchannels() != _ch:
                                raise ValueError("WAV sidecar sample rate/channels mismatch")
                            _parts.append(np.frombuffer(_wr.readframes(_wr.getnframes()), dtype="<i2")
                                          .reshape(-1, _wr.getnchannels()))
                    _pcm = np.concatenate(_parts, axis=0) if _parts else None
                    if _pcm is not None and len(_pcm):
                        with wave.open(_tw, "wb") as _ww:
                            _ww.setnchannels(_ch)
                            _ww.setsampwidth(2)
                            _ww.setframerate(_sr)
                            _ww.writeframes(_pcm.astype("<i2").tobytes())
                        _dur = float(len(_pcm)) / float(_sr)
                        _fmt = str(fmt or "mp4").lower()
                        if _fmt not in ("mp4", "mkv", "webm"):
                            _fmt = "mp4"
                        _codec = str(codec or "auto").lower()
                        if _codec not in ("auto", "h264", "h265", "av1"):
                            _codec = "auto"
                        _force_pix = str(bit_depth) not in ("", "auto") or str(color_space) not in ("", "sRGB")
                        _force_fps = int(fps or 0) > 0
                        _direct = _force_pix or _force_fps or not (_fmt == "mp4" and _codec in ("auto", "h264") and float(crf or 0) <= 0)
                        if _direct:
                            _vc = {"h264": "libx264", "h265": "libx265", "av1": "libsvtav1"}.get(_codec)
                            if _fmt == "webm" and _codec in ("h264", "h265"):
                                _vc = "libvpx-vp9"
                            if not _vc:
                                _vc = "libvpx-vp9" if _fmt == "webm" else "libx264"
                            _ac = "libopus" if _fmt == "webm" else "aac"
                            _bd = 10 if (str(bit_depth) == "10" or (str(bit_depth) == "auto" and str(color_space) in ("HDR", "HDR PQ"))) else 8
                            _pix = "yuv420p10le" if _bd == 10 else "yuv420p"
                            _cmd = [_exe, "-y", "-i", _tv, "-i", _tw,
                                    "-map", "0:v:0", "-map", "1:a:0", "-c:v", _vc, "-pix_fmt", _pix]
                            if float(crf or 0) > 0:
                                _cmd += ["-crf", str(int(float(crf)))]
                            if str(color_space) in ("HDR", "HDR PQ"):
                                _cmd += ["-colorspace", "bt2020nc", "-color_primaries", "bt2020",
                                         "-color_trc", "arib-std-b67" if str(color_space) == "HDR" else "smpte2084"]
                            if int(fps or 0) > 0:
                                _cmd += ["-r", str(int(fps))]
                            _cmd += ["-c:a", _ac, "-b:a", "192k", "-t", "%.6f" % _dur, out_path]
                            _rm = subprocess.run(_cmd, capture_output=True)
                            if (_rm.returncode == 0 and os.path.isfile(out_path)
                                    and os.path.getsize(out_path) > 0):
                                return out_path
                        else:
                            _ra = subprocess.run([_exe, "-y", "-i", _tw, "-c:a", "aac", "-b:a", "192k", _ta],
                                                 capture_output=True)
                            if _ra.returncode == 0 and os.path.isfile(_ta):
                                # 用 -t 卡总时长（= 音频样本数/采样率），不要用 -shortest：
                                # AAC 帧粒度会让 -shortest 把最后 1 帧画面剪掉。
                                _rm = subprocess.run([_exe, "-y", "-i", _tv, "-i", _ta,
                                                      "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
                                                      "-t", "%.6f" % _dur, out_path], capture_output=True)
                                if (_rm.returncode == 0 and os.path.isfile(out_path)
                                        and os.path.getsize(out_path) > 0):
                                    return out_path
                print("[EzFlex-SegmentPanel] WAV 侧车收口失败 ⇒ 退回逐段 AAC")
            finally:
                for _f in (_lst, _tv, _tw, _ta):
                    try:
                        os.remove(_f)
                    except Exception:
                        pass
    except Exception as _exc:
        print("[EzFlex-SegmentPanel] WAV 侧车收口异常（退回逐段 AAC）：%s" % _exc)
    try:
        import subprocess
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        lst = out_path + ".list.txt"
        with _io.open(lst, "w", encoding="utf-8") as f:
            for p in paths:
                f.write("file " + repr(str(p).replace(chr(92), "/")) + chr(10))
        base = [exe, "-y", "-f", "concat", "-safe", "0", "-i", lst]
        try:
            r = subprocess.run(base + ["-c", "copy", out_path], capture_output=True)
            if r.returncode == 0 and os.path.isfile(out_path):
                return out_path
            print("[EzFlex-SegmentPanel] concat 流拷贝失败 rc=%s ⇒ 退回重编码" % r.returncode)
            _ff = str(fmt or "mp4").lower()
            _vc = {"h264": "libx264", "h265": "libx265", "av1": "libsvtav1"}.get(str(codec or "auto").lower())
            if not _vc:
                _vc = "libvpx-vp9" if _ff == "webm" else "libx264"
            _ac = "libopus" if _ff == "webm" else "aac"
            _extra = ["-crf", str(int(float(crf)))] if float(crf or 0) > 0 else []
            _bd = 10 if (str(bit_depth) == "10" or (str(bit_depth) == "auto" and str(color_space) in ("HDR", "HDR PQ"))) else 8
            _fps_args = ["-r", str(int(fps))] if int(fps or 0) > 0 else []
            r2 = subprocess.run(base + ["-c:v", _vc, "-pix_fmt", "yuv420p10le" if _bd == 10 else "yuv420p"]
                                + _extra + _fps_args + ["-c:a", _ac, out_path], capture_output=True)
            if r2.returncode == 0 and os.path.isfile(out_path):
                return out_path
            print("[EzFlex-SegmentPanel] concat 重编码也失败 rc=%s" % r2.returncode)
        finally:
            try:
                os.remove(lst)
            except Exception:
                pass
    except Exception as exc:
        print("[EzFlex-SegmentPanel] concat 异常：%s" % exc)
    return ""


# 节点：段间检查站：按 plan 裁头、落盘 mp4+wav、写 manifest、清显存、末段自动收口。
class SegmentPanelNode:
    """EzFlex-SegmentPanel：段间检查站。裁头 + 落盘 + manifest + 清显存 + 进度 + 末段收口。

    接在循环体末尾（采样/解码之后、回喂之前）。输出裁好的 images/audio 继续走下游。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "This segment's decoded frames (the pinned head gets trimmed off)."}),
                "save_dir": ("STRING", {"default": "", "tooltip": "Directory for per-segment files. Empty = <output>/EzFlex_Segments. Must be under output/input or a folder registered with the folder button."}),
                "fps": ("INT", {"default": 24, "min": 1, "max": 120}),
                "clean_vram": ("BOOLEAN", {"default": True, "tooltip": "Clear the cache after every segment (needed on low VRAM)."}),
                "assemble": ("BOOLEAN", {"default": True, "tooltip": "On the last segment, auto-concat all segments into the final video with ffmpeg."}),
                "trim_tail": ("INT", {"default": 0, "min": 0, "max": 24, "tooltip": "Extra frames dropped from the END of each non-final segment (kills the 1-frame echo at the seam). Audio follows the video length."}),
                "rerun_stop": ("INT", {"default": -1, "min": -1, "max": 9999, "tooltip": "Internal: range re-run target segment (writes into the same run folder and assembles there). Not a canvas port."}),
                "codec": (["auto", "h264", "av1"], {"default": "auto",
                                                   "tooltip": "Video codec for each segment. auto = H.264 in MP4; h264/av1 follow the built-in SaveVideo encoders."}),
                "bit_depth": (["auto", "8", "10"], {"default": "auto",
                                                     "tooltip": "auto = 8-bit for sRGB, 10-bit for HDR/HDR PQ."}),
                "color_space": (["sRGB", "HDR", "HDR PQ"], {"default": "sRGB",
                                                            "tooltip": "HDR = BT.2020/HLG, HDR PQ = BT.2020/PQ. Keep sRGB for normal SDR video."}),
                "crf": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 63.0, "step": 1.0,
                                  "tooltip": "0 = built-in default. Lower = higher quality and larger files; 18 for H.264, around 24 for AV1."}),
                "final_format": (["mp4", "mkv", "webm"], {"default": "mp4",
                                                           "tooltip": "Container for the assembled final video. Segments stay MP4 for looping/preview."}),
                "final_codec": (["auto", "h264", "h265", "av1"], {"default": "auto",
                                                                  "tooltip": "Encoder for the final assemble. auto = H.264 (MP4/MKV) or AV1 (WebM)."}),
                "final_crf": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 63.0, "step": 1.0,
                                         "tooltip": "0 = encoder default. Final only; segments use the CRF above."}),
                "final_bit_depth": (["auto", "8", "10"], {"default": "auto",
                                                          "tooltip": "Final bit depth. auto = 10-bit for HDR/HDR PQ, otherwise 8-bit."}),
                "final_color_space": (["sRGB", "HDR", "HDR PQ"], {"default": "sRGB",
                                                                  "tooltip": "Final color space. Keep sRGB for normal SDR output."}),
                "final_follow": ("BOOLEAN", {"default": False,
                                              "tooltip": "Use the segment encoding settings (codec / bit depth / color space / CRF) for the final assemble."}),
                "final_fps": ("INT", {"default": 0, "min": 0, "max": 120,
                                      "tooltip": "Final frame rate. 0 = follow the segment/plan fps."}),
                # ★ 接缝处理：追加在最后，老工作流 widgets_values 不错位。
                "blend_frames": ("INT", {"default": 0, "min": 0, "max": 24,
                                         "tooltip": "Visible crossfade at each seam: number of frames. 0 = off. Final duration shrinks by this many frames per seam."}),
                "audio_xfade_ms": ("INT", {"default": 0, "min": 0, "max": 2000,
                                           "tooltip": "Audio crossfade at each seam (ms). 0 = follow the video blend duration; only used when a seam blend is active."}),
            },
            "optional": {
                "timeplan": ("EZFLEX_TIMEPLAN", {"tooltip": "Optional plan from EzFlex-TimePlan. Without it the panel treats this as a single segment."}),
                "audio": ("AUDIO", {"tooltip": "This segment's audio (trimmed by the same head amount)."}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    # ★ 第 1 个口 = `timeplan` 透传（用户要求与 MotionContext 一致，放到最上面）。
    #   老工作流的 `images/audio` 槽位由前端 onConfigure 的 reorderOutputs 迁移。
    RETURN_TYPES = ("EZFLEX_TIMEPLAN", "IMAGE", "AUDIO", "VIDEO")
    RETURN_NAMES = ("timeplan", "images", "audio", "video")
    RETURN_TOOLTIPS = (
        "Pass-through of the incoming plan (so TimeLine / LoopEnd outside the loop can read it).",
        "This segment images AFTER trimming the pinned head.",
        "This segment audio AFTER trimming the pinned head.",
        "This segment's encoded mp4 (VideoFromFile), so downstream does not need to encode again.",
    )
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Segment Panel"

    def run(self, images, timeplan=None, save_dir="", fps=24, clean_vram=True, assemble=True, audio=None, trim_tail=0, rerun_stop=-1,
            codec="auto", bit_depth="auto", color_space="sRGB", crf=0.0,
            final_format="mp4", final_codec="auto", final_crf=0.0,
            final_bit_depth="auto", final_color_space="sRGB", final_follow=False, final_fps=0,
            blend_frames=0, audio_xfade_ms=0,
            prompt=None, extra_pnginfo=None, **kwargs):
        plan = timeplan if isinstance(timeplan, dict) else {}
        cur = plan.get("cur") or {}
        idx = int(plan.get("index", 0) or 0)
        total = int(plan.get("total", 1) or 1)
        trim = int(cur.get("overlapFrames", 0) or 0) + int(cur.get("toleranceFrames", 0) or 0)
        try:
            fps_i = max(1, int(plan.get("fps") or fps or 24))
        except (TypeError, ValueError):
            fps_i = max(1, int(fps or 24))
        b = int(images.shape[0]) if images is not None else 0
        # 裁头不能把整段裁光：trim >= 帧数（或没有画面）时以前画面不裁、音频仍按 trim 丢样 → 音画错位。
        if b <= 0 or trim >= b:
            trim = 0
        if trim > 0:                                  # ① 裁头
            images = images[trim:]
        try:
            tt = int(cur.get("tailFrames", trim_tail) or 0)
        except (TypeError, ValueError):
            tt = max(0, int(trim_tail or 0))
        if tt > 0 and b > trim + 1:                    # 末端再裁几帧：只对非末段有意义（末段没有下一段要接）
            keep = max(1, int(images.shape[0]) - tt) if total <= 0 or idx < total - 1 else int(images.shape[0])
            images = images[:keep]
            b = int(images.shape[0])
        if audio is not None and trim > 0:
            try:
                wf = audio.get("waveform")
                sr = int(audio.get("sample_rate") or 32000)
                drop = int(round(trim / float(fps_i) * sr))
                if wf is not None and int(wf.shape[-1]) > drop:
                    audio = {"waveform": wf[..., drop:], "sample_rate": sr}
            except Exception:
                pass
        # 尾裁也必须同步到音频：返回给下游的 AUDIO 不能比 images 长，
        # 否则 SegmentPanel 的音频输出、后续拼接和画面会错位。
        if audio is not None and images is not None:
            try:
                wf = audio.get("waveform")
                sr = int(audio.get("sample_rate") or 32000)
                want = int(round(int(images.shape[0]) / float(fps_i) * sr))
                if wf is not None and want > 0 and int(wf.shape[-1]) > want:
                    audio = {"waveform": wf[..., :want], "sample_rate": sr}
            except Exception:
                pass
        try:
            _rs = int(rerun_stop)
        except (TypeError, ValueError):
            _rs = -1
        base_root = str(save_dir or "").strip() or _ezsp_out_root()
        if not os.path.isabs(base_root):
            base_root = os.path.join(_ezsp_out_root(), base_root)
        # save_dir 是节点输入（工作流可控）：只允许 output/input 和「选择文件夹」登记过的目录。
        # SegmentPanel 的「选择」按钮走 /preview_any/pick_folder，会把目录登记进允许根。
        base_root = _ez_inside(base_root, _ezsp_write_roots())
        if not base_root:
            raise ValueError("[EzFlex-SegmentPanel] save_dir is outside the allowed folders; pick it with the folder button or leave it empty for output/EzFlex_Segments")
        if os.path.exists(base_root) and not os.path.isdir(base_root):
            raise ValueError("[EzFlex-SegmentPanel] save_dir is a file, not a folder: %s" % base_root)
        # 只有 save_dir 本身就是某个 run_* 目录时，才是区间重跑；隐藏的 rerun_stop
        # 如果被老工作流存成 0，不能把新一次生成直接倒进 EzFlex_Segments 根目录。
        _is_rerun = _rs >= 0 and os.path.basename(os.path.normpath(base_root)).startswith("run_")
        if _is_rerun:
            root = base_root                               # 区间重跑：写回原 run 目录，不新开子目录
        else:
            root = _ezsp_run_dir(base_root, idx)           # 每次新跑一个 run_<时间戳> 子目录：分段/成片都不再互相覆盖
        try:
            os.makedirs(root, exist_ok=True)
        except Exception as exc:
            raise RuntimeError("[EzFlex-SegmentPanel] cannot create run folder %s: %s" % (root, exc))
        if isinstance(plan, dict):
            plan["ezRunDir"] = root                        # LoopEnd 用它落 handoff 缓存（seg_XXXX.vK.pt）
        _base = "seg_%04d" % idx
        seg_path = os.path.join(root, _base + ".mp4")
        # 新生成/重跑这一段时，旧的「额外裁切原片」失效，避免恢复成上一版。
        for _old in (os.path.splitext(seg_path)[0] + ".orig.mp4", os.path.splitext(seg_path)[0] + ".orig.wav"):
            try:
                if os.path.isfile(_old):
                    os.remove(_old)
            except Exception:
                pass
        try:
            _ezsp_ver_ensure_current(root, _base)
        except Exception:
            pass
        # ② 落盘：把裁完头的 audio 一起写进 mp4，每段都有声音（只写视频流时成片无声）
        _target_sr = int((plan.get("profile") or {}).get("audio_sample_rate") or 0) if isinstance(plan, dict) else 0
        if audio is not None:
            _chk_pcm, _chk_sr = _ezsp_pcm_of(audio, 0, _target_sr)
            if _chk_pcm is None or _chk_sr <= 0:
                raise ValueError("[EzFlex-SegmentPanel] audio input is present but could not be decoded; "
                                 "check the waveform/sample_rate instead of silently writing a silent segment")
        _tmp_v = seg_path + ".tmp"
        saved = _ezsp_encode_mp4(images, _tmp_v, fps_i, audio, _target_sr,
                                  codec=codec, bit_depth=bit_depth, color_space=color_space, crf=crf,
                                  metadata=PreviewAnyNode._png_meta(extra_pnginfo))
        os.replace(_tmp_v, seg_path)
        # ★ 编码器返回的是「传进去的路径」= 刚被 rename 掉的 .tmp。落盘后必须换成最终路径，
        #   否则 manifest / ezflex.segment 事件里记的是 seg_XXXX.mp4.tmp ⇒ TimeLine 取视频 404、
        #   拼成片时 ffmpeg 也找不到这些段（2026-11 修复：saved 一直没跟着 rename 更新）。
        saved = seg_path
        # ②b PCM 侧车：final 收口时只用这些 WAV 编码一次 AAC —— 避开逐段 AAC 的 -1024 样本预延迟
        _wav_path = os.path.join(root, _base + ".wav")
        _tmp_w = _wav_path + ".tmp"
        _ezsp_write_wav(audio, _tmp_w,
                        int(images.shape[0]) if images is not None else 0, fps_i, _target_sr)
        if os.path.isfile(_tmp_w):
            os.replace(_tmp_w, _wav_path)
        else:
            try:
                if os.path.isfile(_wav_path):
                    os.remove(_wav_path)
            except Exception:
                pass
        try:
            _ezsp_ver_add_current(root, _base, "generate")
        except Exception:
            pass
        mani = _ezsp_manifest_load(root)                        # ③ manifest
        mani["fps"] = fps_i
        mani["total"] = total
        _ffmt = str(final_format or "mp4").lower()
        if _ffmt not in ("mp4", "mkv", "webm"):
            _ffmt = "mp4"
        _fcodec = str(final_codec or "auto").lower()
        if _fcodec not in ("auto", "h264", "h265", "av1"):
            _fcodec = "auto"
        try:
            _fcrf = float(final_crf or 0)
        except (TypeError, ValueError):
            _fcrf = 0.0
        _fbd = str(final_bit_depth or "auto").lower()
        if _fbd not in ("auto", "8", "10"):
            _fbd = "auto"
        _fcs = str(final_color_space or "sRGB")
        if _fcs not in ("sRGB", "HDR", "HDR PQ"):
            _fcs = "sRGB"
        mani["segmentCodec"] = str(codec or "auto").lower()
        mani["segmentBitDepth"] = str(bit_depth or "auto").lower()
        mani["segmentColorSpace"] = str(color_space or "sRGB")
        mani["segmentCrf"] = float(crf or 0)
        try:
            _ffps = max(0, int(final_fps or 0))
        except (TypeError, ValueError):
            _ffps = 0
        if bool(final_follow):
            _fcodec = mani["segmentCodec"]
            _fbd = mani["segmentBitDepth"]
            _fcs = mani["segmentColorSpace"]
            _fcrf = mani["segmentCrf"]
            _ffps = int(fps_i)
        mani["finalFollow"] = bool(final_follow)
        mani["finalFps"] = _ffps
        try:
            _bf = max(0, int(blend_frames or 0))
        except (TypeError, ValueError):
            _bf = 0
        try:
            _ax = max(0, int(audio_xfade_ms or 0))
        except (TypeError, ValueError):
            _ax = 0
        mani["blendFrames"] = _bf
        mani["audioXfadeMs"] = _ax
        mani["finalFormat"] = _ffmt
        mani["finalCodec"] = _fcodec
        mani["finalCrf"] = _fcrf
        mani["finalBitDepth"] = _fbd
        mani["finalColorSpace"] = _fcs
        segs = mani.get("segments")
        if not isinstance(segs, list):
            segs = []
        entry = {"i": idx, "path": saved,
                 "frames": int(images.shape[0]) if images is not None else 0, "trim": trim}
        segs = [s for s in segs if not (isinstance(s, dict) and int(s.get("i", -1)) == idx)]
        segs.append(entry)
        segs.sort(key=lambda s: int(s.get("i", 0)) if isinstance(s, dict) else 0)
        mani["segments"] = segs
        _ezsp_manifest_save(root, mani)
        print("[EzFlex-SegmentPanel] 第 %d/%d 段：裁头 %d 帧，落盘 %s"
              % (idx + 1, total, trim, saved or "(失败)"))
        if clean_vram:                                          # ④ 清显存
            _ezsp_clean_vram()
        try:                                                    # ⑤ 进度
            from server import PromptServer
            PromptServer.instance.send_sync("progress", {"value": idx + 1, "max": max(1, total), "node": None})
            # 面板用的实时快照（比轮询 manifest 快一拍，落盘一完成就能看见）
            PromptServer.instance.send_sync("ezflex.segment", {
                "dir": root, "index": idx, "total": max(1, total), "trim": trim,
                "saved": saved or "", "file": os.path.basename(seg_path),
                "done": len([s for s in segs if isinstance(s, dict) and s.get("path")]),
            })
        except Exception:
            pass
        if assemble and (idx >= total - 1 or (_is_rerun and idx >= _rs)):   # ⑥ 末段 / 区间重跑的终点收口
            paths = [s.get("path") for s in segs if isinstance(s, dict) and s.get("path")]
            if len(paths) >= 1:
                _fp = os.path.join(root, "final." + _ffmt)
                try:
                    _ezsp_ver_ensure_current(root, "final")
                except Exception:
                    pass
                _tmp_fp = _fp + ".tmp." + _ffmt
                final = _ezsp_concat(paths, _tmp_fp, fmt=_ffmt, codec=_fcodec, crf=_fcrf,
                                     bit_depth=_fbd, color_space=_fcs,
                                     fps=(_ffps or fps_i if _bf > 0 else _ffps),
                                     blend_frames=_bf, audio_xfade_ms=_ax)
                if final:
                    try:
                        os.replace(_tmp_fp, _fp)
                        final = _fp
                        _ezsp_ver_add_current(root, "final", "assemble")
                        mani["final"] = final
                        _ezsp_manifest_save(root, mani)
                    except Exception:
                        pass
                print("[EzFlex-SegmentPanel] 收口：%d 段 -> %s" % (len(paths), final or "(失败)"))
                try:
                    from server import PromptServer
                    PromptServer.instance.send_sync("ezflex.segment", {
                        "dir": root, "index": idx, "total": max(1, total), "trim": trim,
                        "saved": saved or "", "file": os.path.basename(seg_path),
                        "done": len(paths), "final": final or "",
                    })
                except Exception:
                    pass
        _seg_video = None
        try:
            if saved and os.path.isfile(saved):
                _seg_video = InputImpl.VideoFromFile(saved)
        except Exception as _v_exc:
            print("[EzFlex-SegmentPanel] VIDEO 输出构造失败：%s" % _v_exc)
        _ez_shape_note("SegmentPanel.images", images)
        return (timeplan, images, audio, _seg_video)


_EZSV_MAX = 16     # 声明多少个卡片位（**前端按实际卡片数裁**，同 LoopStart / LoopEnd 的做法）


_EZSV_PROBE_CACHE = {}


def _ezsv_probe(path):
    """源视频帧数/帧率探测：按 (路径, mtime, size) 缓存，多卡同源时只探一次。"""
    try:
        st = os.stat(path)
        key = (os.path.abspath(path), int(st.st_mtime), int(st.st_size))
    except Exception:
        return _ezsp_probe_media(path)
    hit = _EZSV_PROBE_CACHE.get(key)
    if hit:
        return hit
    val = _ezsp_probe_media(path)
    if len(_EZSV_PROBE_CACHE) >= 64:
        _EZSV_PROBE_CACHE.clear()
    _EZSV_PROBE_CACHE[key] = val
    return val


def _ezsv_input_window(video):
    """输入本身就是一段裁剪过的 VIDEO（VideoTrim / as_trimmed）时，返回它的起点秒/时长。
    SplitVideo 的窗口是**相对这个输入**的；裁 frames/audio 时要加上它的起点。"""
    try:
        if hasattr(video, "get_active_trim_window"):
            st, du = video.get_active_trim_window()
            return max(0.0, float(st or 0.0)), max(0.0, float(du or 0.0))
    except Exception:
        pass
    return 0.0, 0.0


def _ezsv_card_range(video, rule, segs, idx):
    """把「统一规则」解成一段窗口：(源文件绝对路径, 起点秒, 时长秒, 相对输入的起点秒)；解不出返回 None。

    rule = {"mode": "loop"|"one"|"frames", "oneStart": 秒, "oneEnd": 秒, "src": 可选路径}
      · loop   = 取 timeplan 里**本段**那一段（netStart / netDuration）
      · one    = 固定时段 [oneStart, oneEnd)
      · frames = 帧范围（0 起，负数从末尾倒数，end=0 到末尾）
    """
    rule = rule if isinstance(rule, dict) else {}
    path = _tl_source_path(video, rule.get("src"))
    if not path:
        return None
    off, in_dur = _ezsv_input_window(video)
    mode = str(rule.get("mode") or "loop").lower()
    if mode == "frames":
        total, src_fps = _ezsv_probe(path)
        src_fps = max(1e-6, float(src_fps))
        # 输入本身被裁剪过 ⇒ 帧编号相对**这段输入**（和内置嵌套 Trim 一致），不是整条源
        total = max(1, int(round(in_dur * src_fps))) if in_dur > 0 else max(1, int(total))
        try:
            a = int(rule.get("startFrame") or 0)
            b = int(rule.get("endFrame") or 0)
        except (TypeError, ValueError):
            return None
        if a < 0:
            a = total + a
        if b == 0:
            b = total
        elif b < 0:
            b = total + b
        a = max(0, min(total, a))
        b = max(0, min(total, b))
        if b <= a:
            return None
        rel = a / float(src_fps)
        du = (b - a) / float(src_fps)
        if in_dur > 0:
            du = min(du, max(0.0, in_dur - rel))
        if du <= 1e-6:
            return None
        return (path, off + rel, du, rel)
    if mode == "one":
        st = float(rule.get("oneStart") or 0.0)
        en = float(rule.get("oneEnd") or 0.0)
        # 与 TimePlan `_tl_split` / 前端 tlOneRange 同口径：终点缺省/非法/不大于起点 ⇒ 起点+5s。
        # 否则 oneStart=0、oneEnd=0（或倒着填）会静默切出空片段，跑完什么都没有。
        if not (en > st + 0.05):
            en = st + 5.0
        du = max(0.0, en - st)
    else:
        i = int(idx)
        if i < 0 or i >= len(segs):
            return None
        st = float(segs[i].get("netStart") or 0.0)
        du = float(segs[i].get("netDuration") or 0.0)
    if du <= 0:
        return None
    rel = max(0.0, st)
    if in_dur > 0:
        du = min(du, max(0.0, in_dur - rel))
        if du <= 1e-6:
            return None
    return (path, off + rel, du, rel)


def _ezsv_card_cut(video, rule, segs, idx, budget, cache=None, stride=1):
    """按「统一规则」把一条源视频切成一段，返回 IMAGE 批次或 None（out_type = frames）。"""
    try:
        rng = _ezsv_card_range(video, rule, segs, idx)
        if not rng:
            print("[EzFlex-SplitVideo] 第 %d 段取不到片段：检查 video 输入是否为视频、源时长是否覆盖本段，"
                  "以及 timeplan.index 是否在推进" % (int(idx) + 1))
            return None
        stride = max(1, int(stride or 1))
        key = (os.path.abspath(rng[0]), round(float(rng[1]), 4), round(float(rng[2]), 4),
               int(budget) if budget else 0, stride, "frames")
        if cache is not None and key in cache:
            return cache[key]
        _frames = _tl_slice_frames(rng[0], rng[1], rng[2], budget, stride)
        if _frames is None:
            print("[EzFlex-SplitVideo] 第 %d 段：切出 0 帧（源=%s, start=%.2f, dur=%.2f）"
                  % (int(idx) + 1, os.path.basename(rng[0]), rng[1], rng[2]))
        else:
            try:
                _n = int(_frames.shape[0])
                _src = os.path.basename(rng[0])
                print("[EzFlex-SplitVideo] 第 %d 段：切出 %d 帧（源=%s）" % (int(idx) + 1, _n, _src))
            except Exception:
                pass
        if cache is not None:
            cache[key] = _frames
        return _frames
    except Exception as exc:
        print("[EzFlex-SplitVideo] 切段失败：%s" % exc)
        return None


def _ezsv_card_media(video, rule, segs, idx, budget, out_type, seq, fps, cache=None, stride=1):
    """按「统一规则」切一段，并**按 out_type 产出对应形态**（out_type = video / gif）。

    · video = 内置同款**懒裁剪**（video.as_trimmed）：不编码、不落盘，下游 SaveVideo / GetVideoComponents
              按窗口处理；只有预览（PreviewAny）需要文件时才编码一次。
    · gif   = 复用 frames 的缓存解码 → 落盘动图到 output → 同样包成 VIDEO（包不起来就回落帧序列）
    任何一步失败都回落到 IMAGE 帧序列（绝不因为格式问题让整张图崩）。
    """
    try:
        rng = _ezsv_card_range(video, rule, segs, idx)
        if not rng:
            return None
        path, st, du, rel = rng
        stride = max(1, int(stride or 1))
        if out_type == "audio":
            key = (os.path.abspath(path), round(float(st), 4), round(float(du), 4), "audio")
            if cache is not None and key in cache:
                return cache[key]
            aud = _tl_slice_audio(path, st, du)
            if cache is not None:
                cache[key] = aud
            return aud
        if out_type == "video":
            key = (os.path.abspath(path), round(float(rel), 4), round(float(du), 4), "video")
            if cache is not None and key in cache:
                return cache[key]
            trimmed = None
            try:
                src_obj = video if hasattr(video, "as_trimmed") else InputImpl.VideoFromFile(path)
                if hasattr(src_obj, "as_trimmed"):
                    trimmed = src_obj.as_trimmed(rel, du, strict_duration=False)
            except Exception:
                trimmed = None
            if trimmed is not None:
                if cache is not None:
                    cache[key] = trimmed
                return trimmed
            # 只有拿不到 VIDEO 对象时才退回旧的重编码路径
            cut = _tl_trim_video(path, st, du, "mp4")
            if cut:
                try:
                    return InputImpl.VideoFromFile(cut)
                except Exception as exc:
                    print("[EzFlex-SplitVideo] 视频对象构造失败：%s" % exc)
            return _tl_slice_frames(path, st, du, budget, stride)
        frames = _ezsv_card_cut(video, rule, segs, idx, budget, cache, stride)
        if frames is None:
            return None
        gif = _tl_save_gif(frames, fps or 24, seq)
        if gif:
            try:
                return InputImpl.VideoFromFile(gif)
            except Exception as exc:
                print("[EzFlex-SplitVideo] GIF 对象构造失败：%s" % exc)
        return frames
    except Exception as exc:
        print("[EzFlex-SplitVideo] 切段失败：%s" % exc)
        return None


def _ezsv_img_frames(t, rule, segs, idx, fps, budget, stride):
    total = int(t.shape[0]) if t is not None else 0
    if total <= 0:
        return None
    mode = str((rule or {}).get("mode") or "loop").lower()
    try:
        fps = max(1e-6, float(fps or 24))
    except (TypeError, ValueError):
        fps = 24.0
    if mode == "frames":
        try:
            a = int(rule.get("startFrame") or 0)
            b = int(rule.get("endFrame") or 0)
        except (TypeError, ValueError):
            return None
        if a < 0:
            a = total + a
        if b == 0:
            b = total
        elif b < 0:
            b = total + b
    elif mode == "one":
        try:
            a = int(round(float(rule.get("oneStart") or 0.0) * fps))
            b = int(round(float(rule.get("oneEnd") or 0.0) * fps))
        except (TypeError, ValueError):
            return None
    else:
        i = int(idx)
        if i < 0 or i >= len(segs):
            return None
        a = int(round(float(segs[i].get("netStart") or 0.0) * fps))
        b = a + int(round(float(segs[i].get("netDuration") or 0.0) * fps))
    a = max(0, min(total, a)); b = max(0, min(total, b))
    if b <= a:
        return None
    out = t[a:b]
    if stride and int(stride) > 1:
        out = out[::int(stride)]
    if budget:
        out = out[:int(budget)]
    return out if int(out.shape[0]) > 0 else None


def _ezsv_audio_slice(audio, rule, segs, idx, fps):
    try:
        wf = audio.get("waveform")
        sr = int(audio.get("sample_rate") or 32000)
        if wf is None or int(wf.shape[-1]) <= 0 or sr <= 0:
            return None
        total = int(wf.shape[-1])
        mode = str((rule or {}).get("mode") or "loop").lower()
        fps = max(1e-6, float(fps or 24))
        if mode == "frames":
            a = int(rule.get("startFrame") or 0)
            b = int(rule.get("endFrame") or 0)
            n = total / sr * fps
            if a < 0:
                a = int(round(n)) + a
            if b == 0:
                b = int(round(n))
            elif b < 0:
                b = int(round(n)) + b
            s0 = max(0, int(round(a / fps * sr)))
            s1 = max(0, int(round(b / fps * sr)))
        elif mode == "one":
            s0 = int(round(float(rule.get("oneStart") or 0.0) * sr))
            s1 = int(round(float(rule.get("oneEnd") or 0.0) * sr))
        else:
            i = int(idx)
            if i < 0 or i >= len(segs):
                return None
            s0 = int(round(float(segs[i].get("netStart") or 0.0) * sr))
            s1 = s0 + int(round(float(segs[i].get("netDuration") or 0.0) * sr))
        s0 = max(0, min(total, s0)); s1 = max(0, min(total, s1))
        if s1 <= s0:
            return None
        out = dict(audio)
        out["waveform"] = wf[..., s0:s1]
        return out
    except Exception:
        return None


# 节点：按 timeplan 把源素材切成本段：帧序列 / 懒裁剪 VIDEO / GIF / 音频。
class SplitVideoNode:
    """EzFlex-SplitVideo：卡片式切源视频。

    **一张卡 = 一个 `video_N` 输入口 + 一个 `Segment N` 输出口**（一卡一口）。
    切分规则（模式 + 值）：面板顶部那条是**总控制**；**每张卡上有「使用上面的」开关（默认开）**，
    开着 = 跟随总控制，关掉 = 用这张卡自己的模式/值（存 config）。
    输出第一个口是 **`timeplan` 透传**（原样往后传，方便继续串下游），其余是每卡的切分结果。

    切分模式：`loop`（按 timeplan 取**本段**，配合 LoopStart.index）/ `one`（固定时段，起点/终点秒）。
    输出形态由 `out_type` 决定：`frames` = IMAGE 帧序列（复用 `_tl_slice_frames`）/
    `video` = **懒裁剪**的 VIDEO（`as_trimmed`，不编不落盘；下游按窗口处理）/ `gif` = 落盘动图（`_tl_save_gif`）/
    `audio` = 采样级音轨。
    """

    @classmethod
    def INPUT_TYPES(s):
        req = {
            "mode": (["loop", "one", "frames"], {"default": "loop",
                                       "tooltip": "Master slice rule (applies to every card, and initialises new cards). frames = 0-based frame range; start/end accept negative indices from the end, end=0 means end of video."}),
            "one_start": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.1,
                                    "tooltip": "Start (seconds) used when mode = one."}),
            "one_end": ("FLOAT", {"default": 5.0, "min": 0.0, "step": 0.1,
                                  "tooltip": "End (seconds) used when mode = one."}),
            "max_frames": ("INT", {"default": 960, "min": 0, "max": 20000,
                                   "tooltip": "Max frames produced per card (same meaning as VHS frame_load_cap). 0 = no limit. Only frames / GIF outputs are capped."}),
            "config": ("STRING", {"multiline": True, "default": "{}",
                                  "tooltip": "Card config (written by the panel): {cards:[{useMaster,mode,oneStart,oneEnd,outType}]}. useMaster defaults to true (follow the master control above)."}),
            # ★ 输出形态必须追加在**最后**：ComfyUI 的 widgets_values 是**按位置**逐一对上的，
            #   插在中间会让后面所有 widget 的值整体错位（老工作流一加载就串值）。
            "out_type": (["frames", "video", "gif", "audio"], {
                "default": "frames",
                "tooltip": "Master output type for every Segment port (a card with its 'master' switch off can override it): frames = IMAGE batch; video = trimmed mp4 (VIDEO); gif = animated GIF saved to output (VIDEO); audio = trimmed audio track (AUDIO)."}),
            "start_frame": ("INT", {"default": 0, "min": -100000, "max": 100000,
                                    "tooltip": "Master frame range start (0-based). Negative = from the end; -22 means the 22nd frame from the end."}),
            "end_frame": ("INT", {"default": 0, "min": -100000, "max": 100000,
                                  "tooltip": "Master frame range end (exclusive). 0 = end of video; negative = from the end; -1 = one frame before the end."}),
            # ★ 新增 widget 一律追加在**最后**（widgets_values 按位置对齐，插中间会让老工作流串值）。
            "select_every_nth": ("INT", {"default": 0, "min": 0, "max": 1000,
                                         "tooltip": "Keep every Nth frame for frames / GIF outputs. 0 = no thinning (all frames); N >= 2 = keep every Nth frame. Video / audio outputs are not affected."}),
        }
        opt = {"timeplan": ("EZFLEX_TIMEPLAN", {"tooltip": "Optional plan from EzFlex-TimePlan; only the loop mode needs it."})}
        for i in range(1, _EZSV_MAX + 1):
            opt["video_%d" % i] = ("*", {"tooltip": "Source for card %d: VIDEO (lazy trim, no re-encode), IMAGE frame batch (tensor slice), or AUDIO (PCM slice)." % i})
        return {"required": req, "optional": opt}

    # ⚠️ 后端一口气声明 _EZSV_MAX 个卡片位 ⇒ **前端必须按实际卡片数裁**（同 LoopStart/LoopEnd）。
    #    返回长度固定 = 1 + _EZSV_MAX（用不到的给 None），这样实例口数怎么裁都不会跟类声明对不上。
    RETURN_TYPES = ("EZFLEX_TIMEPLAN",) + ("*",) * _EZSV_MAX
    RETURN_NAMES = ("timeplan",) + tuple("Segment %d" % i for i in range(1, _EZSV_MAX + 1))
    RETURN_TOOLTIPS = ("Pass-through of the incoming plan (keeps the chain going).",) + tuple(
        "Card %d sliced frames (IMAGE batch) or None." % i for i in range(1, _EZSV_MAX + 1))
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Split Video"

    def run(self, timeplan=None, mode="loop", one_start=0.0, one_end=5.0, max_frames=960,
            out_type="frames", start_frame=0, end_frame=0, config="{}", select_every_nth=0, **kwargs):
        plan = timeplan if isinstance(timeplan, dict) else {}
        segs = plan.get("segments") if isinstance(plan.get("segments"), list) else []
        try:
            idx = max(0, int(plan.get("index", 0) or 0))
        except (TypeError, ValueError):
            idx = 0
        # 0 = 不限（VHS frame_load_cap 同语义）
        try:
            _mf = int(max_frames or 0)
        except (TypeError, ValueError):
            _mf = 960
        budget = _mf if _mf > 0 else None
        try:
            _stride = int(select_every_nth or 0)
        except (TypeError, ValueError):
            _stride = 0
        stride = max(1, _stride)     # 0 = 不抽帧；N = 每 N 帧取 1 帧
        fmt = str(out_type or "frames").lower()
        if fmt not in ("frames", "video", "gif", "audio"):
            fmt = "frames"
        try:
            fps = max(1.0, float(plan.get("fps") or 24))
        except (TypeError, ValueError):
            fps = 24.0
        # 总控制（面板顶部那条）——卡片没自己配规则时就用它
        master = {"mode": str(mode or "loop").lower(),
                  "oneStart": float(one_start or 0.0), "oneEnd": float(one_end or 0.0),
                  "startFrame": int(start_frame or 0), "endFrame": int(end_frame or 0)}
        try:
            cfg = json.loads(config) if isinstance(config, str) else (config or {})
        except Exception:
            cfg = {}
        cards = cfg.get("cards") if isinstance(cfg, dict) and isinstance(cfg.get("cards"), list) else []
        outs = []
        cache = {}
        for i in range(1, _EZSV_MAX + 1):
            c = cards[i - 1] if (i - 1) < len(cards) and isinstance(cards[i - 1], dict) else {}
            use_master = c.get("useMaster")
            if use_master is None:
                use_master = True               # 每张卡的「使用上面的」开关，**默认开**
            m = str(c.get("mode") or "").lower()
            fmt_i = fmt                         # 每张卡自己的输出形态；缺省/非法 ⇒ 跟随总控制
            if (not use_master) and m in ("loop", "one", "frames"):
                rule = {"mode": m,               # 关掉开关 ⇒ 用卡片自己的规则
                        "oneStart": c.get("oneStart", master["oneStart"]),
                        "oneEnd": c.get("oneEnd", master["oneEnd"]),
                        "startFrame": c.get("startFrame", master["startFrame"]),
                        "endFrame": c.get("endFrame", master["endFrame"])}
                cf = str(c.get("outType") or "").lower()
                if cf in ("frames", "video", "gif", "audio"):
                    fmt_i = cf
            else:                               # 开关开着 / 没配 / 非法 ⇒ 跟随上面的总控制
                rule = master
            src = kwargs.get("video_%d" % i)
            if src is None:
                outs.append(None)       # 可选参考口：没接/None 时静默跳过，不刷 16 条“取不到片段”
                continue
            if isinstance(src, torch.Tensor) and int(src.ndim) == 4:
                outs.append(_ezsv_img_frames(src, rule, segs, idx, fps, budget, stride) if fmt_i == "frames" else None)
                continue
            if isinstance(src, dict) and "waveform" in src:
                outs.append(_ezsv_audio_slice(src, rule, segs, idx, fps) if fmt_i == "audio" else None)
                continue
            if fmt_i == "frames":
                outs.append(_ezsv_card_cut(src, rule, segs, idx, budget, cache, stride))
            else:
                outs.append(_ezsv_card_media(src, rule, segs, idx, budget, fmt_i, i, fps, cache, stride))
        hit = sum(1 for o in outs if o is not None)
        if hit:
            print("[EzFlex-SplitVideo] 第 %d 段：%d 张卡片切出内容（%s）" % (idx + 1, hit, fmt))
        for _i, _o in enumerate(outs, 1):
            _ez_shape_note("SplitVideo.Segment %d" % _i, _o)
        return (timeplan, *outs)


