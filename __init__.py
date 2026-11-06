"""EzFlex 插件套件：23 个节点（模型 / 分辨率 / 控制 / 参数预设 / 预览 / 提示词 / 媒体 / 时间轴 / 循环）。

## 文件结构（2026-10 按功能域拆分）
- `__init__.py`               核心：常量、路径安全（`_ez_*`）、目录扫描缓存、配置与预设库（`user_data`）、
                              循环展开、跨节点共用的 helper、`NODE_*_MAPPINGS` 聚合、前端 no-store 路由注册
- `ezflex/preview_nodes.py`   EzFlex-PreviewAny + 媒体探测/导出（图/视频/音频/3D/模型元数据）
- `ezflex/segments_nodes.py`  TimeLine / TimePlan / SplitVideo / SegmentPanel / MotionContext
                              + 时间轴规划 `_tl_*`、切素材 `_ezsv_*`、分段落盘 `_ezsp_*`、钉帧几何 `_ezmc_*`
- `ezflex/prompt_nodes.py`    EzFlex-PromptHelper + 卡片编译/合并 + 运行时优化 + 标签库
- `ezflex/routes_nodes.py`    HTTP 路由的**处理函数**（注册块仍留在本文件末尾的 try 块）

## 节点清单
模型组合 ModelsCombo；分辨率 FreeLatent；控制 NodeSwitchGroup / NodeSwitchMaster / MainControl；
参数预设 ParamPresetControl / ParamPresetOutput；预览 PreviewAny；提示词 PromptHelper；
媒体 MediaLoader / MediaOut / MergeList / SplitList / Reroute；
时间轴 TimeLine / TimePlan / SplitVideo / VideoComponents / SegmentPanel / MotionContext；
循环 LoopStart / LoopEnd；预处理 ControlnetPreprocessor。

## 约定
- 全部节点用 V1 API（`INPUT_TYPES` + `RETURN_TYPES` + `FUNCTION`），不混用 V3 `io.ComfyNode`。
- 动态端口：类上声明固定上限，前端按 `config` 建口；类型统一 `*`（ANY），见 `_DynamicOutputTypes`。
- 控制类三节点是**纯前端容器**（参考 rgthree Fast Groups Muter）：Python 只承载隐藏 config，
  `node.mode 0/2/4` 由浏览器设置 ⇒ API 提交时不会生效，与 rgthree 同类节点行为一致。
- 子模块借用本文件的 helper 用 `from .. import (...)`；本文件在**末尾**导入子模块（避免循环导入）。
"""
import base64
import csv
import inspect
import json
import os
import shutil
import random
import re
import struct
import time
from urllib.parse import urlsplit
import logging
import numpy as np
import torch
import folder_paths
# AV latent 落盘是 comfy.nested_tensor.NestedTensor：torch.load(weights_only=True) 默认不认它，
# 不加白名单「重跑续接」会静默丢掉上一段的 latent（→ MotionContext 不钉帧、接缝跳变、音频不连续）。
try:
    import comfy.nested_tensor as _ez_nested_tensor
    torch.serialization.add_safe_globals([_ez_nested_tensor.NestedTensor])
except Exception:
    pass
# ===== §1 路径安全 / 目录扫描缓存 =====
def _fmt_mtime(t):
    """时间戳 → 'YYYY-MM-DD HH:MM'（面板显示用）；失败时原样转字符串。"""
    try:
        from datetime import datetime
        return datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(t)
_SHA_CACHE = {}   # path -> (size, mtime_ns, hexdigest)
def _sha256(p):
    """文件内容 sha256（分块读，避免大文件吃内存）；读失败返回空串。按 (size, mtime) 记忆，避免同一模型每次预览都整文件重算。"""
    try:
        _st = os.stat(p)
        _ck = (_st.st_size, _st.st_mtime_ns)
        _hit = _SHA_CACHE.get(p)
        if _hit and _hit[0] == _ck[0] and _hit[1] == _ck[1]:
            return _hit[2]
    except OSError:
        return ""
    try:
        import hashlib
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        d = h.hexdigest()
    except Exception:
        return ""
    if len(_SHA_CACHE) >= 64:
        _SHA_CACHE.pop(next(iter(_SHA_CACHE)), None)
    _SHA_CACHE[p] = (_ck[0], _ck[1], d)
    return d
import comfy.sd
import comfy.model_management
import threading
import io as _io          # 标准库 io 统一用 _io 引用，避免与 comfy_api 的 io 重名
from comfy_api.latest import InputImpl, Types   # 只用到 VIDEO/3D 构造（Types.VideoComponents / InputImpl.VideoFromFile）
_ez_log = logging.getLogger("EzFlex")   # 本插件唯一的 logger：路由注册失败 / 上游预处理失败都走它
def _ez_route(srv, method, path, handler):
    """逐条注册路由：一条失败只丢这一条。
    以前整组共用一个 try，任何一条注册抛错都会让该组**后续所有**路由静默不注册（只有一条组级 warning）。"""
    try:
        getattr(srv.instance.routes, method)(path)(handler)
    except Exception as exc:
        _ez_log.warning("route %s %s NOT registered: %s", str(method).upper(), path, exc)
__version__ = "1.3.0"   # 版本号按要求停在 1.3.0；历史变更见 PROJECT_STATE.md，不在代码里堆叠。
WEB_DIRECTORY = "./web"
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
    # 必须覆盖 web/ 下**全部** .js（含 core/ panels/ 这些子目录）：漏掉的会走 ComfyUI 默认静态路由
    # （带缓存），改完前端刷新看不到变化、容易被误判成「代码没生效」。所以这里递归枚举，不再手抄清单。
    for _root, _dirs, _files in os.walk(_WEB_DIR):
        _dirs.sort()
        for _fname in sorted(_f for _f in _files if _f.endswith(".js")):
            _rel = os.path.relpath(os.path.join(_root, _fname), _WEB_DIR).replace(os.sep, "/")
            _routes.get("/extensions/Comfyui-EzFlex-Presets/" + _rel)(_serve_no_store(_rel))
except Exception as _e_routes:
    # 整块失败会让所有前端 JS 退回「带缓存的默认静态路由」，表现为刷新后仍是旧版：
    # 不静默吞掉，至少让它出现在控制台里。
    _ez_log.warning(
        "no-store routes for /extensions/Comfyui-EzFlex-Presets/*.js were NOT registered (%s); "
        "front-end changes may appear stale until the browser cache is cleared.", _e_routes)
MAX_PORTS_PER_TYPE = 32   # 每类型输出口上限：前端 MAX_PER_TYPE 必须与此一致（见 modelscombo_node.js）
# ===== §2 加载器选项与实现 =====
# 加载器类型 → ComfyUI 的模型目录名（folder_paths 的 key）
LOADER_FOLDERS = {
    "checkpoint": "checkpoints",
    "unet": "diffusion_models",
    "clip": "text_encoders",
    "vae": "vae",
    "lora": "loras",
}
# 面板可选精度 → torch dtype；"default" = 跟随模型自带精度
WEIGHT_DTYPES = {
    "default": None,
    "fp16": torch.float16,
    "bf16": torch.bfloat16,
    "fp32": torch.float32,
    "fp8_e4m3fn": torch.float8_e4m3fn,
    "fp8_e4m3fn_fast": torch.float8_e4m3fn,
    "fp8_e5m2": torch.float8_e5m2,
}
# 面板里的 CLIP 类型；文件末尾会自动并入内核 CLIPType 枚举，内核新增类型无需改这里
CLIP_TYPES = [
    "stable_diffusion", "stable_cascade", "sd3", "stable_audio", "mochi", "ltxv",
    "pixart", "cosmos", "lumina2", "wan", "hidream", "chroma", "ace", "omnigen2",
    "qwen_image", "hunyuan_image", "flux2", "ovis", "longcat_image", "cogvideox",
    "lens", "pixeldit", "ideogram4", "boogu", "krea2", "joyimage", "mage", "minimax", "yue2",
]
try:
    from comfy.sd import CLIPType as _CLIPType
    for _ct in _CLIPType:
        _nm = str(getattr(_ct, "name", "") or "").lower()
        if _nm and _nm not in CLIP_TYPES:
            CLIP_TYPES.append(_nm)
except Exception:
    pass
# 设备下拉（VAE 加载用）；内核支持但这里没列出的设备走 "default"
DEVICES = ("default", "cpu", "cuda", "cuda:0", "cuda:1", "mps", "xpu")
# VAE 允许的精度（比模型权重少：不支持 fp8）
VAE_DTYPES = ("default", "fp16", "bf16", "fp32")
def _ez_real(p):
    """规范化路径；空串一律返回 ''（注意：os.path.abspath('') 会得到进程 CWD，不能当路径用）。"""
    try:
        s = str(p).strip()
        return os.path.realpath(os.path.abspath(s)) if s else ""
    except Exception:
        return ""
# 目录扫描索引缓存：key = _scan_sig(根目录)，TTL 5 秒；避免每请求都 os.walk 整个模型目录
_SCAN_CACHE_TTL_MS = 5000
_SCAN_CACHE = {}
def _scan_sig(roots):
    sig = []
    for r in (roots or []):
        try:
            sig.append((os.path.normpath(str(r)), os.path.getmtime(r)))
        except OSError:
            sig.append((str(r), -1.0))
    return tuple(sig)
def _scan_cached(key, roots, build):
    if _SCAN_CACHE_TTL_MS <= 0:
        return build()
    sig = _scan_sig(roots)
    now = time.monotonic()
    hit = _SCAN_CACHE.get(key)
    if hit is not None and hit[0] == sig and (now - hit[1]) * 1000.0 < _SCAN_CACHE_TTL_MS:
        return hit[2]
    val = build()
    _SCAN_CACHE[key] = (sig, now, val)
    return val
_EZ_ROOTS_MEMO = {"sig": None, "roots": []}


def _stat_sig(p):
    try:
        st = os.stat(p) if p else None
    except OSError:
        st = None
    return (p, st.st_mtime_ns, st.st_size) if st else (p, 0, 0)


def _ez_roots_sig():
    """根列表的失效签名：根表文件的 (mtime_ns, size) + input/output/temp/models 的当前值。

    只覆盖会影响结果的输入。主根表存在时不再看两个 legacy 文件（_ez_root_rows 也不看），
    省掉 2 次 stat —— 这是每个路径判断都要付的钱。
    """
    parts = []
    main = _ezflex_user_file("ezflex_roots.json")
    st = _stat_sig(main)
    parts.append(st)
    if not st[1]:   # mtime_ns == 0 ⇒ 主根表不存在，才需要看两个 legacy 文件（与 _ez_root_rows 同条件）
        for name in ("ezflex_save_roots.json", "ezflex_media_roots.json"):
            parts.append(_stat_sig(_ezflex_user_file(name)))
    for fn in ("get_input_directory", "get_output_directory", "get_temp_directory"):
        try:
            f = getattr(folder_paths, fn, None)
            parts.append(f() if callable(f) else "")
        except Exception:
            parts.append("")
    parts.append(str(getattr(folder_paths, "models_dir", "") or ""))
    return tuple(parts)


def _ez_roots_invalidate():
    """根表被写过后调用：下一回 _ez_roots() 必须重算（不依赖 mtime 分辨率）。"""
    _EZ_ROOTS_MEMO["sig"] = None


def _ez_roots():
    """允许前端读写的根目录 = ComfyUI 的 input/output/temp/models + 根表里登记的根。

    根表里的根（MediaLoader 添加 / PreviewAny 保存位置 / PromptHelper 扫描目录）也算可读 ——
    「在浏览器里登记过」就等于「这张图/这段素材可以被解析到」，否则浏览得到、serve 却 404。
    ★ 结果按 _ez_roots_sig() 缓存：它同时是安全边界和热路径（每个路径判断都走），
      不缓存的话 9 个素材就要 ~46 ms 纯系统调用。写根表的函数都会 _ez_roots_invalidate()。
    """
    sig = _ez_roots_sig()
    if _EZ_ROOTS_MEMO["sig"] == sig:
        return list(_EZ_ROOTS_MEMO["roots"])
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
        out.extend(_ez_root_paths("read"))
    except Exception:
        pass
    roots, seen = [], set()
    for p in out:
        r = _ez_real(p)
        if r and r not in seen:
            seen.add(r)
            roots.append(r)
    _EZ_ROOTS_MEMO["sig"] = sig
    _EZ_ROOTS_MEMO["roots"] = roots
    return list(roots)
def _ez_inside(path, roots=None):
    """realpath + commonpath：只有落在某个根目录内才返回规范路径，否则返回 ''。"""
    p = _ez_real(path)
    if not p:
        return ""
    # 默认根已经是 realpath 归一过的（见 _ez_roots），别再逐根重复 realpath：
    # 这里每个路径判断都走，4~6 个根各 0.2~0.3 ms 是纯浪费。
    cand = _ez_roots() if roots is None else [_ez_real(r) for r in roots]
    for rr in cand:
        if not rr:
            continue
        try:
            if p == rr or os.path.commonpath([p, rr]) == rr:
                return p
        except Exception:
            continue
    return ""
# ===== §1.5 目录根登记表（读 / 写 / 扫描，一份文件）=====
# 背景：保存类功能原先各存一份列表（ezflex_save_roots.json 给 PreviewAny 存图、ezflex_media_roots.json
# 给 MediaLoader 浏览），在 MediaLoader 里授权过的目录 SegmentPanel 不认，用户也没有统一的地方查看/撤销。
# 现在只有这一张表 user_data/ezflex_roots.json，每个根带 read/write/scan 能力位和 src 来源标记；
# MediaLoader 的「根目录」页就是它的管理界面，节点面板只负责「用哪个根」。
# 老的两份文件在首次写盘时并入新表，之后不再读取。
_EZ_ROOTS_CACHE = {"sig": None, "rows": []}
def _ez_roots_file():
    return _ezflex_user_file("ezflex_roots.json")
def _ez_root_norm(p, must_exist=True):
    """规范化成可登记的根：不是整盘根（C:\\ 这种不当根），默认还要求真实存在且是目录。

    读表时传 must_exist=False：外接盘拔掉的行必须原样留着，否则下次写盘就把用户的登记删了。
    """
    r = _ez_real(p)
    if not r or os.path.dirname(r) == r:
        return ""
    if must_exist and not os.path.isdir(r):
        return ""
    return r
def _ez_root_merge(rows, path, read=True, write=False, scan=False, src=""):
    """把 (路径, 能力位, 来源) 并进 rows（就地改）；同一目录只留一行，能力位取或、来源追加。"""
    key = os.path.normcase(path)
    for row in rows:
        if os.path.normcase(_ez_real(row.get("path")) or "") == key:
            row["read"] = bool(row.get("read")) or bool(read)
            row["write"] = bool(row.get("write")) or bool(write)
            row["scan"] = bool(row.get("scan")) or bool(scan)
            if src:
                srcs = row.setdefault("src", [])
                if src not in srcs:
                    srcs.append(src)
            return rows
    rows.append({"path": path, "read": bool(read), "write": bool(write), "scan": bool(scan),
                 "src": [src] if src else []})
    return rows
def _ez_root_legacy_rows():
    """老的两份列表 → 新表行（只在 ezflex_roots.json 还不存在时读）。"""
    rows = []
    for fname, src, is_write in (("ezflex_save_roots.json", "previewany", True),
                                 ("ezflex_media_roots.json", "medialoader", False)):
        try:
            fn = _ezflex_user_file(fname)
            if not fn or not os.path.isfile(fn):
                continue
            with open(fn, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if not isinstance(data, list):
                continue
            for x in data:
                p = _ez_root_norm(x)
                if p:
                    _ez_root_merge(rows, p, read=True, write=is_write, src=src)
        except Exception:
            continue
    return rows
def _ez_root_rows():
    """根登记表（含能力位与来源）。读缓存按三个文件的 mtime 失效。

    ★ 返回**全量**行（含当前不存在的目录）：这是要写回磁盘的那份数据。
      需要「现在真的能访问」的列表请用 _ez_root_paths()。
    """
    fn = _ez_roots_file()
    sig = []
    for p in (fn, _ezflex_user_file("ezflex_save_roots.json"), _ezflex_user_file("ezflex_media_roots.json")):
        try:
            sig.append(os.path.getmtime(p))
        except (OSError, TypeError):
            sig.append(0.0)
    sig = tuple(sig)
    if _EZ_ROOTS_CACHE["sig"] == sig:
        return [dict(r) for r in _EZ_ROOTS_CACHE["rows"]]
    rows = []
    if fn and os.path.isfile(fn):
        try:
            with open(fn, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            raw = data.get("roots") if isinstance(data, dict) else data
            for item in (raw if isinstance(raw, list) else []):
                if not isinstance(item, dict):
                    continue
                p = _ez_root_norm(item.get("path"), must_exist=False)
                if p:
                    _ez_root_merge(rows, p, bool(item.get("read", True)), bool(item.get("write")),
                                   bool(item.get("scan")), "")
                    for row in rows:
                        if os.path.normcase(_ez_real(row.get("path")) or "") == os.path.normcase(p):
                            row["src"] = [str(s) for s in (item.get("src") or [])][:8]
                            break
        except Exception:
            rows = []
    else:
        rows = _ez_root_legacy_rows()
    # 不在这里过滤「目录是否存在」：过滤后的结果会被写盘函数当成完整表写回去，
    # 外接盘离线时增删任何根都会永久删掉那一行（2026-11 审计 P2-4）。存在性只在 _ez_root_paths 里判。
    _EZ_ROOTS_CACHE["sig"] = sig
    _EZ_ROOTS_CACHE["rows"] = [dict(r) for r in rows]
    return rows


def _ez_write_json(fn, obj):
    """原子写 JSON：先写 <fn>.tmp 再 os.replace。

    ★ 以前所有配置都是 open(fn, "w") 直接覆盖：写到一半断电/盘满就留下半截文件，
      而 _read_doc/_ez_root_rows 解析失败会返回空表 ⇒ 下一次保存把整份预设库/根表覆盖成一条。
    """
    tmp = fn + ".tmp"
    try:
        os.makedirs(os.path.dirname(fn), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, fn)
        return True
    except Exception:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return False
def _ez_root_save(rows):
    fn = _ez_roots_file()
    if not fn:
        return False
    if not _ez_write_json(fn, {"version": 2, "roots": rows}):
        return False
    _EZ_ROOTS_CACHE["sig"] = None
    _ez_roots_invalidate()   # 根表变了：_ez_roots() 的 memo 必须立刻失效（新增/删除根要即时生效）
    return True
def _ez_root_paths(cap="read"):
    """登记表里具备某能力、且**当前真实存在**的目录（read / write / scan）—— 安全边界用的就是这份。"""
    return [r["path"] for r in _ez_root_rows() if r.get(cap) and os.path.isdir(r.get("path") or "")]
def _ez_root_add(path, read=True, write=False, scan=False, src=""):
    """登记（或给已有行加能力位）。返回规范路径；不合法（不存在/整盘/不是目录）**或写盘失败**返回 ''。"""
    p = _ez_root_norm(path)
    if not p:
        return ""
    if not _ez_root_save(_ez_root_merge(_ez_root_rows(), p, read, write, scan, src)):
        return ""
    return p
def _ez_root_remove(path):
    p = _ez_real(path)
    if not p:
        return False
    key = os.path.normcase(p)
    rows = [r for r in _ez_root_rows() if os.path.normcase(_ez_real(r.get("path")) or "") != key]
    return _ez_root_save(rows)
def _ez_root_drop_cap(cap):
    """去掉所有行的某个能力位（`/preview_any/save_roots` 的 clear 用）；没有能力位的行一并删掉。"""
    rows = []
    for r in _ez_root_rows():
        r = dict(r)
        r[cap] = False
        if r.get("read") or r.get("write") or r.get("scan"):
            rows.append(r)
    return _ez_root_save(rows)
def _ez_root_drop_cap_for(path, cap):
    """只去掉指定目录的某个能力位；没有能力位了就把这行删掉。"""
    p = _ez_real(path)
    if not p:
        return False
    key = os.path.normcase(p)
    rows = []
    for r in _ez_root_rows():
        r = dict(r)
        if os.path.normcase(_ez_real(r.get("path")) or "") == key:
            r[cap] = False
            if not (r.get("read") or r.get("write") or r.get("scan")):
                continue
        rows.append(r)
    return _ez_root_save(rows)
def _ez_save_roots():
    """可写根（= 原来的 `_pv_save_roots()`）：PreviewAny 存图、SegmentPanel `save_dir`、MediaLoader 另存为共用。"""
    return _ez_root_paths("write")
# ===== 上一次选过的目录（原生「选择文件夹」对话框的起始位置）=====
# 以前每次弹框都从 output/input 起步，选过一次 D:\jietu 下次还得重新翻。这里记最后一次，
# 所有「选文件夹」对话框共用（纯本机偏好，不参与权限判定）。
_EZ_LAST_DIR = {"path": None}
def _ez_last_dir_file():
    return _ezflex_user_file("ezflex_last_dir.json")
def _ez_last_dir(default=""):
    if _EZ_LAST_DIR["path"] is None:
        p = ""
        try:
            fn = _ez_last_dir_file()
            if fn and os.path.isfile(fn):
                with open(fn, "r", encoding="utf-8") as fh:
                    d = json.load(fh)
                p = str((d or {}).get("dir") or "") if isinstance(d, dict) else ""
        except Exception:
            p = ""
        _EZ_LAST_DIR["path"] = p
    p = _EZ_LAST_DIR["path"]
    return p if (p and os.path.isdir(p)) else default
def _ez_last_dir_set(path):
    p = _ez_real(path)
    if not p or not os.path.isdir(p):
        return
    _EZ_LAST_DIR["path"] = p
    fn = _ez_last_dir_file()
    if fn:
        _ez_write_json(fn, {"dir": p})
# 预览导出的临时件：前缀 / TTL / 清扫最小间隔（sweep 自己用）。
# 以前这三项定义在 ezflex/segments_nodes.py —— 上层常量被下层工具函数引用，靠"末尾才 import"才恰好可用，
# 单独导入或调整导入顺序就会 NameError。以这里为唯一定义处，segments_nodes 从这里导入。
_EZPV_PREFIXES = ("ezpv_img_", "ezpv_th_", "ezpv_audio_", "ezpv_vid_", "ezpv_trim_", "ezpv_mask_",
                  "ezpv3d_mesh_", "ezpv3d_", "ezflex_serve_", "ezflex_tl_")
_EZPV_TTL_SEC = 6 * 60 * 60        # 6 小时：远大于任何一次预览/播放的生命周期
_EZPV_SWEEP_MIN_GAP = 300.0        # 两次清扫最小间隔（秒），避免每个预览请求都遍历目录
_ezpv_sweep_last = [0.0]
def _ezpv_sweep(force=False):
    """回收 temp 下过期的 EzFlex 导出件。失败静默（清理是尽力而为，不该影响预览本身）。"""
    try:
        now = time.monotonic()
        if not force and (now - _ezpv_sweep_last[0]) < _EZPV_SWEEP_MIN_GAP:
            return 0
        _ezpv_sweep_last[0] = now
        tmp_root = _ez_real(folder_paths.get_temp_directory())
        if not tmp_root or not os.path.isdir(tmp_root):
            return 0
        cutoff = time.time() - _EZPV_TTL_SEC
        removed = 0
        with os.scandir(tmp_root) as it:          # 只扫 temp 根，不递归（这些导出件都直接落在根下）
            for ent in it:
                try:
                    if not ent.is_file(follow_symlinks=False):
                        continue
                    if not ent.name.startswith(_EZPV_PREFIXES):
                        continue
                    if ent.stat(follow_symlinks=False).st_mtime >= cutoff:
                        continue
                    os.remove(ent.path)
                    removed += 1
                except Exception:
                    continue
        return removed
    except Exception:
        return 0
def _ez_loopback(host):
    """回环名归一：去掉方括号 / 端口 / ::ffff: 前缀，只留主机名；裸 IPv6（::1）原样保留。"""
    h = str(host or "").strip().lower()
    if h.startswith("["):
        h = h[1:h.find("]")] if "]" in h else h
    elif h.count(":") == 1:
        h = h.split(":", 1)[0]
    if h.startswith("::ffff:"):
        h = h[7:]
    return h
def _ez_local(req):
    """敏感动作（拉起系统程序 / 弹本机对话框 / 改服务端允许列表）只允许本机客户端。
    另外校验来源头：任意网页也能从浏览器打到 localhost，所以带 Origin/Referer 时必须与 Host 同源。"""
    if _ez_loopback(getattr(req, "remote", "")) not in ("127.0.0.1", "::1", "localhost"):
        return False
    # 反向代理把 Host 改写成 127.0.0.1 时，remote/Host 都会「看起来是本机」——
    # 再看转发头。★ 只信**最后一跳**（代理追加的那个）：最左一跳是客户端自报的，可以随便写
    #   （nginx 用 $proxy_add_x_forwarded_for 时，远端自带 "X-Forwarded-For: 127.0.0.1" 就能过闸门）。
    try:
        xff = str(req.headers.get("X-Forwarded-For") or "").strip()
        peer = _ez_loopback(xff.split(",")[-1]) if xff else ""
        if not peer:
            peer = _ez_loopback(req.headers.get("X-Real-IP") or req.headers.get("CF-Connecting-IP") or "")
    except Exception:
        peer = ""
    if peer and peer not in ("127.0.0.1", "::1", "localhost"):
        return False
    # Host 也必须是回环名：挡 DNS rebinding（恶意域名解析到 127.0.0.1 时，浏览器给的 Host 是那个域名）
    try:
        req_host = _ez_loopback(req.headers.get("Host"))
    except Exception:
        req_host = ""
    if req_host and req_host not in ("127.0.0.1", "localhost", "::1"):
        return False
    # 浏览器跨站 / 同站（另一个 localhost 端口）的请求都带 Sec-Fetch-Site —— 直接拒；
    # 非浏览器客户端没有这个头，不受影响。
    try:
        sfs = str(req.headers.get("Sec-Fetch-Site") or "").strip().lower()
    except Exception:
        sfs = ""
    if sfs in ("cross-site", "same-site"):
        return False
    try:
        origin = str(req.headers.get("Origin") or req.headers.get("Referer") or "")
    except Exception:
        origin = ""
    if origin:
        # Origin: null = 沙箱 iframe / data: / file: 页面 —— 不能当成同源可信，一律拒
        if origin.strip().lower() == "null":
            return False
        # 必须比到端口：只比 hostname 的话 http://127.0.0.1:3000 上的任意本地页面都能过闸门。
        # 不比 scheme（反代常把 TLS 终止在本机，scheme 会被改写成 http）。
        # ⚠️ aiohttp 的 req.url 是 yarl.URL：只有 `.host`，**没有** `.hostname`（写错会 500）。
        try:
            _o = urlsplit(origin.strip())
            _me = req.url
            _oh = (_o.hostname or "").lower()
            _mh = str(getattr(_me, "host", "") or "").lower()
            _op = _o.port or (443 if _o.scheme == "https" else 80)
            _mp = _me.port or (443 if _me.scheme == "https" else 80)
        except Exception:
            return False
        if _oh != _mh or _op != _mp:
            return False
    return True
# ===== §3 ModelsCombo：LoRA 元数据 =====
def _lora_trained_words(meta):
    """触发词：LoraManager 顶层 trainedWords 常为空，退回 civitai.trainedWords（C 站数据在那儿）。"""
    if not isinstance(meta, dict):
        return []
    tw = meta.get("trainedWords")
    if not (isinstance(tw, list) and tw):
        civ = meta.get("civitai")
        if isinstance(civ, dict) and isinstance(civ.get("trainedWords"), list):
            tw = civ.get("trainedWords")
    if not isinstance(tw, list):
        tw = []
    if not tw:
        at = meta.get("activation_text")
        if isinstance(at, str) and at.strip():
            tw = [at]
    return [str(w).strip() for w in tw if str(w or "").strip()]
# 插件目录下的运行期数据根（预设 JSON / 卡片 / 标签库）；首次导入即创建
# 旧版把预设/词库/日志放在插件目录的 user_data/ 下；现在都搬到 ComfyUI 的 user/EzFlex/。
# 这里**不再开机 makedirs**：目录只剩「回落路径」（user_directory 不可用）和「种子源」两种用途，
# 无条件创建会让每个新装用户看到一个永远为空的 user_data/。
_USER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user_data")
def _ezflex_user_base():
    """ComfyUI 官方 user 目录（folder_paths.user_directory）；拿不到返回空串。

    只用官方字段、不做兜底：ComfyUI ≥0.3.13 一定有它；拿不到时各调用点都有 `if not d` 守卫。
    """
    return getattr(folder_paths, 'user_directory', '') or ''
def _ezflex_user_dir(sub=''):
    """user/EzFlex[/sub]，按需创建；user 目录不可用时返回 ''（调用方需判空）。"""
    base = _ezflex_user_base()
    if not base:
        return ''
    # 注：tag_preview / card_preview 暂时留在顶层——标签 JSON 里存的是相对路径
    #     （tag_preview/xxx.webp），换目录会让已存的预览图 404。
    d = os.path.join(base, 'EzFlex', sub) if sub else os.path.join(base, 'EzFlex')
    # 只在缺失时建目录：os.makedirs(exist_ok=True) 每次都要逐级 stat（实测 313 µs，而 isdir 只有 64 µs）。
    # 这个函数在每个路径判断里都会被调到（_ezflex_user_file → _ez_roots_sig），不能每次付全额。
    try:
        if not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d
# 配置类文件统一放到 config/ 下（与缓存、预设、词库分开）
_CFG_NAMES = {
    'ezflex_roots.json', 'ezflex_last_dir.json', 'ezflex_model_paths.json', 'ezflex_scan_paths.json',
    'ezflex_media_roots.json', 'ezflex_media_target.json', 'ezflex_api_hosts.json', 'ezflex_custom_providers.json',
    'ezflex_prompt_tags.json', 'ezflex_prompt_categories.json', 'ezflex_prompt_rules.json', 'settings.json',
}


_USER_FILE_RESOLVED = set()   # 已经做过「旧位置迁移检查」的目标路径（路径本身是确定的，不必每次 stat）


def _ezflex_user_file(name):
    """配置在 user/EzFlex/config/，其它在 user/EzFlex/；旧位置有同名文件时首次访问复制过来。

    旧位置两处都要看：user/<name>（更早）和 user/EzFlex/<name>（这次整理之前）。
    ★ 迁移检查每个目标路径只做一次：这个函数在 _ez_roots_sig 里被每个路径判断调到，
      每次 isfile 0.1 ms 是纯浪费；路径本身由 user_directory 决定，不会中途变。
    """
    d = _ezflex_user_dir('config') if name in _CFG_NAMES else _ezflex_user_dir()
    if not d:
        return ''
    dst = os.path.join(d, name)
    if dst in _USER_FILE_RESOLVED:
        return dst
    if not os.path.isfile(dst):
        base = _ezflex_user_base()
        for old in (os.path.join(base, name) if base else '',
                    os.path.join(base, 'EzFlex', name) if base else ''):
            try:
                if old and os.path.isfile(old) and os.path.abspath(old) != os.path.abspath(dst):
                    shutil.copy2(old, dst)
                    break
            except Exception:
                pass
    _USER_FILE_RESOLVED.add(dst)
    return dst
# ===== §4 分辨率 / 参数预设存储 =====
def _preset_file(node_name):
    """每个节点类型一个存档文件：user_data/<节点类型>.json（预设列表 + 可选额外键）。"""
    name = node_name + ".json"
    d = _ezflex_user_dir("presets")
    if not d:
        # user_directory 不可用（老 ComfyUI）才回落到插件目录；这时按需建目录，
        # 平时不建（否则每个用户都会看到一个空的 user_data/）。
        try:
            os.makedirs(_USER_DIR, exist_ok=True)
        except Exception:
            pass
        return os.path.join(_USER_DIR, name)
    dst = os.path.join(d, name)
    old = os.path.join(_USER_DIR, name)
    try:
        if not os.path.exists(dst) and os.path.isfile(old):
            shutil.copy2(old, dst)                    # 首次访问：旧预设搬过来（旧文件保留）
    except Exception:
        return old
    return dst
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
    """只取预设列表（丢弃 customRatios 等额外键）。"""
    return _read_doc(node_name)[1]
def _write_all(node_name, items):
    """写回预设列表；doc 里没有额外键时保持旧的「纯列表」格式（ModelsCombo 老存档不变）。

    返回是否写成功 —— 路由要据此回 500，别再让「磁盘满/只读目录」也答 ok:true。
    """
    doc, _ = _read_doc(node_name)
    doc["presets"] = items
    extra = {k: v for k, v in doc.items() if k != "presets"}
    out = doc if extra else items
    return _ez_write_json(_preset_file(node_name), out)
def _read_ratios(node_name):
    """自定义比例表（FreeLatent 面板），与 presets 同存一个 doc 的 customRatios 键。"""
    doc, _ = _read_doc(node_name)
    ratios = doc.get("customRatios", [])
    return ratios if isinstance(ratios, list) else []
def _write_ratios(node_name, ratios):
    """写回自定义比例；会一并把 presets 落盘（doc 形状从纯列表升为对象）。返回是否写成功。"""
    doc, presets = _read_doc(node_name)
    doc["presets"] = presets
    doc["customRatios"] = ratios
    return _ez_write_json(_preset_file(node_name), doc)
def _register_preset_routes(node_name, api_path, with_ratios=False):
    async def _list(req):
        # 预设里存着素材绝对路径 / 存档目录：只给本机看（与 POST/DELETE 同一门槛）
        if not _ez_local(req):
            return _web.json_response({"error": "forbidden: local clients only"}, status=403)
        return _web.json_response(_read_all(node_name))

    async def _save(req):
        if not _ez_local(req):
            return _web.json_response({"error": "forbidden: local clients only"}, status=403)
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
            if not _write_all(node_name, items):
                return _web.json_response({"error": "cannot write preset file"}, status=500)
            return _web.json_response({"ok": True, "name": name})
        except Exception as e:
            return _web.json_response({"error": str(e)}, status=500)

    async def _delete(req):
        if not _ez_local(req):
            return _web.json_response({"error": "forbidden: local clients only"}, status=403)
        try:
            name = req.match_info.get("name", "")
            items = [p for p in _read_all(node_name) if p.get("name") != name]
            if not _write_all(node_name, items):
                return _web.json_response({"error": "cannot write preset file"}, status=500)
            return _web.json_response({"ok": True})
        except Exception as e:
            return _web.json_response({"error": str(e)}, status=500)

    if with_ratios:
        async def _ratio_list(req):
            if not _ez_local(req):
                return _web.json_response({"error": "forbidden: local clients only"}, status=403)
            return _web.json_response(_read_ratios(node_name))

        async def _ratio_save(req):
            if not _ez_local(req):
                return _web.json_response({"error": "forbidden: local clients only"}, status=403)
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
                if not _write_ratios(node_name, ratios):
                    return _web.json_response({"error": "cannot write preset file"}, status=500)
                return _web.json_response({"ok": True, "ratios": ratios})
            except Exception as e:
                return _web.json_response({"error": str(e)}, status=500)

        async def _ratio_delete(req):
            if not _ez_local(req):
                return _web.json_response({"error": "forbidden: local clients only"}, status=403)
            try:
                ratio = req.match_info.get("ratio", "")
                ratios = [r for r in _read_ratios(node_name) if r != ratio]
                if not _write_ratios(node_name, ratios):
                    return _web.json_response({"error": "cannot write preset file"}, status=500)
                return _web.json_response({"ok": True, "ratios": ratios})
            except Exception as e:
                return _web.json_response({"error": str(e)}, status=500)

        try:
            _ez_route(PromptServer, "get", api_path + "/custom_ratios", _ratio_list)
            _ez_route(PromptServer, "post", api_path + "/custom_ratios", _ratio_save)
            _ez_route(PromptServer, "delete", api_path + "/custom_ratios/{ratio}", _ratio_delete)
        except Exception as _e:
            _ez_log.warning("%s/custom_ratios: preset routes not registered: %s", api_path, _e)

    try:
        _ez_route(PromptServer, "get", api_path, _list)
        _ez_route(PromptServer, "post", api_path, _save)
        _ez_route(PromptServer, "delete", api_path + "/{name}", _delete)
    except Exception as _e:
        _ez_log.warning("%s: preset routes not registered: %s", api_path, _e)
_register_preset_routes("EzFlex-ModelsCombo", "/models_combo/presets")
_register_preset_routes("EzFlex-FreeLatent", "/freelatent/presets", with_ratios=True)
_register_preset_routes("EzFlex-ControlnetPreprocessor", "/ezflex_prep/presets")
_register_preset_routes("EzFlex-MediaLoader", "/media_loader/presets")
_MC_NAME_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".sft")
def _mc_port_name(name, ltype):
    """端口名 = 面板里填的名字原样，只剥模型文件扩展名。

    ★ 名字里的点必须保留：前端若能按 '.' 切最后一段，填 wan2.2 会变成 2.2_model，
      和 RETURN_NAMES（原样拼接）对不上。modelscombo_node.js 的 sr() 用同一条规则，两边必须同时改。
    """
    s = str(name or "").strip()
    low = s.lower()
    for ext in _MC_NAME_EXTS:
        if low.endswith(ext):
            s = s[: -len(ext)]
            break
    return s or str(ltype or "")
_MC_TRIGGER_CACHE = {}   # <metadata.json 路径> -> (mtime, 触发词列表)：同一 LoRA 只解析一次
def _mc_lora_words(path):
    mp = os.path.splitext(path)[0] + ".metadata.json"
    try:
        mt = os.path.getmtime(mp)
    except OSError:
        return []
    hit = _MC_TRIGGER_CACHE.get(mp)
    if hit is not None and hit[0] == mt:
        return hit[1]
    try:
        with open(mp, "r", encoding="utf-8-sig") as fh:
            meta = json.load(fh)
    except Exception:
        words = []
    else:
        words = _lora_trained_words(meta)
    _MC_TRIGGER_CACHE[mp] = (mt, words)
    return words
def _mc_trigger_words(loras):
    """按 LoRA 顺序拼触发词串（LoraManager <模型>.metadata.json 的 trainedWords）；没有触发词的跳过。"""
    words = []
    for lora in (loras or []):
        rel = str(lora.get("file") or "").strip()
        if not rel:
            continue
        try:
            path = folder_paths.get_full_path("loras", rel)
        except Exception:
            path = None
        if not path:
            continue
        words.extend(_mc_lora_words(path))
    return ", ".join(words)
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
    # 与内置 VAELoader 一致：登记重载工厂，multigpu 深拷贝 / Select VAE Device 才能按设备重载
    # （老版本没有 load_vae_patcher 就跳过，不影响单卡加载）
    factory = getattr(comfy.sd, "load_vae_patcher", None)
    if factory is not None:
        vae.patcher.cached_patcher_init = (factory, (path, metadata, vae_device))
    return vae
# ===== §5 动态输出类型 =====
class _DynamicOutputTypes(tuple):
    """类 RETURN_TYPES 的容器：越界取槽位返回 "*"（ANY），不抛 IndexError。

    execution.py:947 校验链接时按「上游类的 RETURN_TYPES[槽位]」取类型再比下游输入。类表全局一份，
    而不同实例端口数可能不同，表比槽位短时那里一取就越界 → 越界返回 ANY 让校验放行；
    真实返回值来自 run() 的元组，len() 语义不变（execution.py 用它复制标量输出）。
    """

    def __getitem__(self, i):
        try:
            return tuple.__getitem__(self, i)
        except IndexError:
            return "*"
# 节点：加载 checkpoint/unet/clip/vae 并串联 LoRA；输出口按加载器顺序动态生成（LoRA 不占口）。
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

    RETURN_TYPES = _DynamicOutputTypes(["*"] * (MAX_PORTS_PER_TYPE * 3))
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
        applied = []
        for lora in ordered_loras:
            strength_model = float(lora["extra"].get("strength_model", 1.0))
            strength_clip = float(lora["extra"].get("strength_clip", 1.0))
            if strength_model == 0 and strength_clip == 0:
                # 与内置 LoraLoader（nodes.py:741）一致：0 强度不加载文件、原样透传。
                # 触发词也按「这个 LoRA 没装」处理，否则面板显示 0、提示词里还留着它的触发词。
                continue
            target = by_id.get(lora["target_id"])
            if target is None:
                print(f"[ModelsCombo] LoRA '{lora['name']}': target loader not found, skipped")
                continue
            model, clip = target["model"], target["clip"]
            if model is None and clip is None:
                print(f"[ModelsCombo] LoRA '{lora['name']}': target has no MODEL/CLIP, skipped")
                continue
            lora_path = folder_paths.get_full_path_or_raise("loras", lora["file"])
            # 与内置 LoraLoader 一致：safe_load + 带上 metadata（新模型的 lora_metadata 附件靠它）
            lora_sd, lora_meta = comfy.utils.load_torch_file(lora_path, safe_load=True, return_metadata=True)
            new_model, new_clip = comfy.sd.load_lora_for_models(model, clip, lora_sd, strength_model, strength_clip, lora_metadata=lora_meta)
            # 无论返回什么，都把「当前模型/CLIP」保留给下一个 lora 继续串联
            if new_model is not None:
                target["model"] = new_model
            elif model is not None:
                target["model"] = model
            if new_clip is not None:
                target["clip"] = new_clip
            elif clip is not None:
                target["clip"] = clip
            applied.append(lora)

        # 动态输出：按「加载器顺序」逐个产出其拥有的端口（checkpoint=model/clip/vae 相邻、unet=model、clip=clip、vae=vae，
        # lora 不占输出端口）。槽位必须和 routes_nodes._mc_output_types 完全一致：那边按**类型**发口，
        # 这里若按「值非 None」跳过，缺 CLIP 的 checkpoint 会让后面的值前移一格、落进 CLIP 口。
        out_types, out_names, outputs = [], [], []
        for loader in mains:
            entry = by_id[loader["id"]]
            nm = _mc_port_name(loader.get("name"), loader["type"])
            if loader["type"] in ("checkpoint", "unet"):
                out_types.append("MODEL"); out_names.append(nm + "_model"); outputs.append(entry["model"])
            if loader["type"] in ("checkpoint", "clip"):
                out_types.append("CLIP"); out_names.append(nm + "_clip"); outputs.append(entry["clip"])
            if loader["type"] in ("checkpoint", "vae"):
                out_types.append("VAE"); out_names.append(nm + "_vae"); outputs.append(entry["vae"])

        if loaders:   # 触发词串常驻（无 LoRA = 空串）；空配置不加，端口数与前端一致
            out_types.append("STRING"); out_names.append("trigger_words")
            outputs.append(_mc_trigger_words(applied))

        return _ez_apply_dynamic_ports(self, out_names, outputs)
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

    # 只做解析：对齐统一在 execute 里做（那里还要处理外部 width/height 的覆盖值），
    # 两处都对齐是纯冗余，且会让"面板值"和"外部值"走两条不同的取整路径。
    return w, h, max(1, b)
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
    """读取面板「对齐」值，并**向 8 取整**。

    对齐值必须是 8 的倍数：宽高按 mult 取整后就是 mult 的倍数，若 mult 不是 8 的倍数，
    latent 的 h//8 / w//8 会静默截断（例：align=12、width=1024 → 1020，1020//8=127，
    实际出图 1016 而不是 1024）。取整后 mult 仍是"用户意图的近似值"，但不会产生非法尺寸。"""
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
        if a < 1:
            return 8
        return max(8, int(a / 8 + 0.5) * 8)
    return 8
def _fl_round_step(v, mult, lo=8):
    """按 mult 四舍五入（.5 向上取整），与前端 JS Math.round 一致；只保底到 8（latent 最小单位）。"""
    return max(lo, int(v / mult + 0.5) * mult)
# 节点：空 latent + 宽高/批次；面板 config 为底，外部宽高覆盖后再按 align 对齐（align 恒为 8 的倍数）。
class FreeLatentNode:
    """V1 节点（与其它 22 个节点统一）：output 为 Latent/Width/Height/Batch；
    width/height/batch_size 用 forceInput 保证是可连接 socket，未连接时用面板 config 值。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "config": ("STRING", {"multiline": True, "default": "{}",
                                      "tooltip": "Config JSON generated by the resolution panel (width / height / batch / algorithm / ratio)."}),
            },
            "optional": {
                "width": ("INT", {"default": 0, "min": 0, "max": 32768, "step": 8, "forceInput": True,
                                  "tooltip": "External width: >0 overrides the panel width (0 / empty = use the panel value)."}),
                "height": ("INT", {"default": 0, "min": 0, "max": 32768, "step": 8, "forceInput": True,
                                   "tooltip": "External height: >0 overrides the panel height (0 / empty = use the panel value)."}),
                "batch_size": ("INT", {"default": 0, "min": 0, "max": 4096, "forceInput": True,
                                       "tooltip": "External batch: >0 overrides the panel batch (0 / empty = use the panel value)."}),
            },
        }

    RETURN_TYPES = ("LATENT", "INT", "INT", "INT")
    RETURN_NAMES = ("Latent", "Width", "Height", "Batch")
    RETURN_TOOLTIPS = ("Empty latent (batch, 4, height/8, width/8)", "Width in pixels",
                       "Height in pixels", "Batch size")
    FUNCTION = "execute"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Resolution / Latent Selector"

    def execute(self, config="{}", width=0, height=0, batch_size=0):
        w, h, batch = parse_freelatent_config(config)
        # 「强(force)」生效时忽略外部 width/height/batch，强制用面板值
        if not _freelatent_force(config):
            if width and width > 0:
                w = width
            if height and height > 0:
                h = height
            if batch_size and batch_size > 0:
                batch = batch_size
        # 严格按面板「对齐」值对齐（.5 向上，与前端一致）。_freelatent_align 恒返回 8 的倍数，
        # 取整后必然是合法 latent 尺寸；下面的检查只是兜底断言，正常永远不触发。
        mult = _freelatent_align(config)
        w, h = _fl_round_step(w, mult), _fl_round_step(h, mult)
        if (w % 8) != 0 or (h % 8) != 0:
            raise ValueError(
                f"[EzFlex-FreeLatent] the aligned size {w}x{h} (align={mult}) is not a multiple of 8; "
                f"latent dimensions must be divisible by 8 (latent = pixels / 8). Set align to a multiple of 8, or change the width/height."
            )
        batch = max(1, int(batch))
        # 与内置 EmptyLatentImage 同款：中间设备/精度 + downscale_ratio_spacial（新模型靠它知道空间下采样倍数）
        latent = torch.zeros([batch, 4, h // 8, w // 8],
                             device=comfy.model_management.intermediate_device(),
                             dtype=comfy.model_management.intermediate_dtype())
        # ui 回传「实际生效值」：外部宽高接线时，面板在 onExecuted 里把自己当手动输入一样更新
        return {"ui": {"fl_size": [[int(w), int(h), int(batch)]]},
                "result": ({"samples": latent, "downscale_ratio_spacial": 8}, w, h, batch)}
def _control_input_types(tooltip):
    """控制类节点（Group/Master/Main）共用的输入声明：只有一个隐藏 config STRING。

    这三个节点在 Python 侧没有输出、run() 返回 ()：真正的开关动作发生在浏览器 ——
    面板把目标节点的 node.mode 设为 0/2/4，排队时由前端序列化进 prompt 生效。
    因此 API 直接提交 prompt 时它们不产生任何效果（与 rgthree Fast Groups Muter 同类）。
    """
    return {
        "required": {
            "config": ("STRING", {
                "multiline": True,
                "default": "{}",
                "tooltip": tooltip,
            }),
        },
    }
# ===== §6 控制类节点（纯前端容器） =====
# 节点：纯前端容器：按画布分组匹配，批量设目标节点 node.mode；Python 只存 config。
class NodeSwitchGroupNode:
    """分组预设（方案A，参考 rgthree Fast Groups Muter/Bypasser）：前端内嵌面板管理
    「开关 → 匹配（画布分组 颜色/标题正则）→ node.mode 0/2/4」。
    开关列表与当前预设名存 config；命名分组预设存服务器 user_data 预设库（按节点名共享）。"""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "Config JSON produced by the Node Switch Group panel (switch list / match rules / current preset).",
        )

    RETURN_TYPES = _DynamicOutputTypes()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Node Switch Group"

    def run(self, config="{}", **kwargs):
        return ()
# 节点：纯前端容器：把多个 NodeSwitchGroup 实例映射到各自的分组预设名。
class NodeSwitchMasterNode:
    """节点控制总预设：总预设 = {NodeSwitchGroup 节点 id -> 该分组预设名} 的映射。
    行（目标分组节点）由前端从画布发现；应用时前端把映射写进各分组节点的 config.current 并触发其应用。"""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "Config JSON produced by the Node Switch Master panel (current master preset name).",
        )

    RETURN_TYPES = _DynamicOutputTypes()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Node Switch Master"

    def run(self, config="{}", **kwargs):
        return ()
# 节点：纯前端容器：总预设，把 Master / ParamPreset / ModelsCombo / FreeLatent 映射到预设名并级联下推。
class MainControlNode:
    """总控制节点：总预设 = {目标节点 id -> 该节点预设名} 的映射，目标是画布上的
    EzFlex-NodeSwitchMaster / EzFlex-ParamPresetControl / EzFlex-ModelsCombo / EzFlex-FreeLatent
    实例。应用时级联下推。"""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "Config JSON produced by the Main Control panel (current master preset name).",
        )

    RETURN_TYPES = _DynamicOutputTypes()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Main Control"

    def run(self, config="{}", **kwargs):
        return ()
# 节点：参数组 → 一组一个 EZFLEX_PARAM_GROUP 出口；组数变化时前端同步类表。
class ParamPresetControlNode:
    """参数预设控制：前端面板管理参数组（组/参数可拖拽排序），动态输出端口与参数组卡片一一对应
    （一个分组一个 EZFLEX_PARAM_GROUP 端口，携带该组参数数据）。分组增删/排序后由前端 POST
    /param_preset_control/outputs 同步类 RETURN_TYPES/RETURN_NAMES（校验用），execute 再按实际数据设置。"""

    @classmethod
    def INPUT_TYPES(s):
        return _control_input_types(
            "Config JSON produced by the Param Preset Control panel (parameter group list + current preset name).",
        )

    RETURN_TYPES = _DynamicOutputTypes()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Param Preset Control"

    def run(self, config="{}", **kwargs):
        groups = parse_param_groups(config)[:_EZ_OUTPUT_CAP]
        return _ez_apply_dynamic_ports(self, _ppc_output_names(groups), groups)
# 节点：接一个参数组，按参数逐个出口（按类型映射）；面板可局部禁用某参数。
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

    RETURN_TYPES = _DynamicOutputTypes()
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
            # 值是字符串时按「声明类型」转换，而不是把类型改成 string：
            # 以前 int 参数的值是 "0" 会把端口变成 STRING，前端口径跟着变、还会标红。
            if isinstance(val, str) and ptype in ("int", "float", "bool"):
                s = val.strip()
                try:
                    if ptype == "int":
                        val = int(float(s))
                    elif ptype == "float":
                        val = float(s)
                    else:
                        val = s.lower() in ("1", "true", "yes", "on")
                    p["value"] = val
                except (TypeError, ValueError):
                    _ez_log.warning(
                        "[EzFlex-ParamPresetOutput] param %r: value %r is not a valid %s -> output as string",
                        p.get("name"), val, ptype)
                    ptype = "string"
            p["type"] = ptype
            params.append(p)
        group["params"] = params
        active = _ppo_effective_params(group)
        names, outputs = ["Data combo"], [group]
        for i, p in enumerate(active):
            ptype = (p.get("type") or "string").lower()
            names.append((p.get("name") or "").strip() or f"Parameter {i + 1}")
            if str(p.get("id")) in off:
                outputs.append(_ppo_disabled_value(ptype))
            else:
                outputs.append(param_value_to_comfy(p.get("value"), ptype))
        return _ez_apply_dynamic_ports(self, names, outputs)
class _AlwaysEqualProxy(str):
    def __eq__(self, _): return True
    def __ne__(self, _): return False
_ANY = _AlwaysEqualProxy("*")
_MEDIA_CARD = "EZFLEX_MEDIA_CARD"
_register_preset_routes("EzFlex-NodeSwitchMaster", "/nodeswitch_master/presets", with_ratios=False)
_register_preset_routes("EzFlex-MainControl", "/main_control/presets", with_ratios=False)
_register_preset_routes("EzFlex-ParamPresetControl", "/param_preset_control/presets", with_ratios=False)
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
_FMTS_BY_VIDEO_CODEC = {
    "h264": ("mp4", "mov", "avi", "mkv"),
    "h265": ("mp4", "mov", "mkv"),
    "vp9": ("webm", "mkv"),
    "av1": ("mp4", "webm", "mkv"),
}
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
            "name": item.get("name") or "Group",
            "out": item.get("out") or "all",
            "params": [
                {
                    "id": p.get("id"),
                    "name": p.get("name") or "Parameter",
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
    int/float 宽松解析（int(val)/float(val)）；解析失败**保留原字符串**（不静默变 0），让下游按字符串报错。
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
# 动态端口上限：路由（前端同步）与各节点 run() 共用这一个数。以前 128/256/512 混用，
# 超过上限时会出现「前端能加卡、执行时少口」的不一致。
_EZ_OUTPUT_CAP = 512
_EZ_TYPE_LOCK = threading.Lock()
def _ez_sync_dynamic_types(cls, names):
    """把「当前端口名」同步到类级 RETURN_TYPES / RETURN_NAMES（前端端口变化时 POST 调，run() 也调）。

    背景：类表全局只有一份（execution.py:947 校验链接时按槽位读类表的 RETURN_TYPES），
    而同类型多个实例的端口数可能不同。两条不变量（勿改）：
      ① 长度只增不减 —— 收缩会挤掉另一实例的高位槽，那条链接校验时越界；
      ② 槽位类型统一 `*` —— 同一槽位在不同实例可能是不同类型，写死任一个都会误伤另一个。
    因此它只影响 /object_info 与校验放行；节点真实返回值来自 run() 的元组，与此无关。
    ★ 高位槽补**通用名**，不能沿用上一个实例的名字（那会让 /object_info 出现别人的端口名）。
    """
    names = list(names or [])[:_EZ_OUTPUT_CAP]
    with _EZ_TYPE_LOCK:
        prev_types = tuple(getattr(cls, "RETURN_TYPES", ()) or ())[:_EZ_OUTPUT_CAP]
        n = min(max(len(names), len(prev_types)), _EZ_OUTPUT_CAP)
        if len(names) < n:
            names += [f"Output {i + 1}" for i in range(len(names), n)]
        cls.RETURN_TYPES = _DynamicOutputTypes(["*"] * n)
        cls.RETURN_NAMES = tuple(names)
def _ez_apply_dynamic_ports(node, names, outputs):
    """run() 的动态端口统一收口：类表只增不减 + 返回值补齐到类表长度。

    类表是**全局一份**、`execution.py:947` 校验链接时按槽位取它；同类型两个实例的端口数可能不同。
    以前每个实例在 run() 里用自己的长度**覆盖**类表（后跑的挤短先跑的），违背了 _ez_sync_dynamic_types
    的「只增不减」约定，也让 /object_info 的端口数随执行顺序跳变。这里改成：
      ① 类表走 _ez_sync_dynamic_types（只增不减，槽位类型恒 `*`）；
      ② 返回值补齐到类表长度（多出的槽为 None），高位槽的连线取值时不会越界。
    只改类表和返回值，不碰 node.outputs / 连线。
    """
    cls = type(node)
    _ez_sync_dynamic_types(cls, (names or ())[:_EZ_OUTPUT_CAP])
    outs = tuple(outputs or ())[:_EZ_OUTPUT_CAP]
    # 列表型输出（OUTPUT_IS_LIST）不能补 None：merge_result_data 对 is_list 槽会 value.extend(o[i])，
    # extend(None) 直接抛错。这类节点只对齐类表、不补长度（它的端口数就是真实槽位数）。
    if getattr(node, "OUTPUT_IS_LIST", None) is None:
        total = len(getattr(cls, "RETURN_TYPES", ()) or ())
        if len(outs) < total:
            outs = outs + (None,) * (total - len(outs))
    return outs
def _ppc_output_names(groups):
    """按参数组顺序算 ParamPresetControl 的输出名（一个分组一个 EZFLEX_PARAM_GROUP 端口）。"""
    groups = groups or []
    return tuple((g.get("name") or "").strip() or f"Group {i + 1}" for i, g in enumerate(groups))
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
            "title": (item.get("title") or "").strip() or "Prompt",
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
            "liveIn": bool(item.get("liveIn")),              # 实时接收卡：card_in 不覆盖，卡片正文为准（可在卡片里编辑）
            "loop": bool(item.get("loop")),                  # 循环卡：每一轮都放进合并输出（顺序不变）
            # 可选「只在这些轮次出现」：缺省必须是 None（= 每轮都放），不能写成 []，否则会变成一轮都不放。
            "loopIndices": item.get("loopIndices") if isinstance(item.get("loopIndices"), list) else None,
            "rule": item.get("rule") if isinstance(item.get("rule"), dict) else {},   # 前端 syncToConfig 解析好的规范
        })
    return cards
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
def _ph_html_to_text(html):
    """把卡片 contenteditable 的 HTML 转成纯文本（供合并提示词用）。"""
    if not html:
        return ""
    txt = re.sub(r"<b[^>]*eph-tag-x[^>]*>[^<]*</b>", " ", html)   # 标签芯片上的删除按钮，不是正文
    txt = re.sub(r"<[^>]+>", " ", html)
    txt = re.sub(r"\s+", " ", txt).strip()
    return txt
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
def _ph_scan_paths_file():
    return _ezflex_user_file('ezflex_scan_paths.json')
def _ph_tags_file():
    return _ezflex_user_file('ezflex_prompt_tags.json')
def _ph_backup_before_write(fn):
    """写前把旧文件留一份 .bak（只留最近一份）。
    标签数据（ezflex_prompt_tags.json）和卡片（user/EzFlex/prompts/*.json）都走这里。
    预览图已独立成文件（tag_preview/），不再内嵌，所以 .bak 主要保的是元数据。"""
    try:
        if fn and os.path.isfile(fn):
            import shutil
            shutil.copy2(fn, fn + ".bak")
    except Exception:
        pass
def _ph_prompts_dir():
    """「卡片管理」保存的提示词卡片目录：user/EzFlex/prompts（旧的 user/prompts 首次访问自动搬进来）。"""
    d = _ezflex_user_dir('prompts')
    base = _ezflex_user_base()
    if not d or not base:
        return d
    old = os.path.join(base, 'prompts')
    if os.path.isdir(old) and os.path.realpath(old) != os.path.realpath(d):
        try:
            for f in os.listdir(old):
                src, dst = os.path.join(old, f), os.path.join(d, f)
                if os.path.isfile(src) and not os.path.exists(dst):
                    try:
                        os.replace(src, dst)
                    except Exception:
                        pass
            if not os.listdir(old):
                os.rmdir(old)
        except Exception:
            pass
    return d
# ===== §7 媒体节点与媒体工具 =====
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
    """与内置 Load Image 同款：逐帧归一化到 [N,H,W,3]（0..1，RGB）——静态图 N=1，动图（GIF/WebP/APNG）整段出批；
    尺寸不一致的帧按内置做法跳过。设备/精度走 intermediate_device()/intermediate_dtype()
    （默认 CPU/fp32，开了 --gpu-only / --fp16-intermediates 时才和内置一样变）。"""
    from PIL import Image, ImageOps, ImageSequence
    frames = []
    w = h = None
    with Image.open(path) as im:
        for frame in ImageSequence.Iterator(im):
            rgb = ImageOps.exif_transpose(frame).convert("RGB")
            if w is None:
                w, h = rgb.size
            if rgb.size != (w, h):
                continue
            frames.append(torch.from_numpy(np.array(rgb).astype(np.float32) / 255.0)[None,])
    if not frames:
        raise ValueError(f"[EzFlex-MediaLoader] image has no decodable frames: {os.path.basename(path)}")
    out = torch.cat(frames, dim=0)
    return out.to(device=comfy.model_management.intermediate_device(), dtype=comfy.model_management.intermediate_dtype())
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
def _ml_load_audio(path, start=0.0, dur=0.0):
    """与内置 Load Audio 同款：{"waveform": [1,C,T] float32, "sample_rate": int}（batch 维必须有）。
    start/dur 可只解码一段（SplitVideo 的 audio 输出用）；额外带 "path" 便于预览原文件。"""
    empty = {"waveform": torch.zeros((1, 1, 0), dtype=torch.float32), "sample_rate": 44100, "path": os.path.abspath(path)}
    try:
        import av
        rate = 44100
        chunks = []
        start = max(0.0, float(start or 0.0))
        dur = max(0.0, float(dur or 0.0))
        end = (start + dur) if dur > 0 else None
        with av.open(path, mode="r") as container:
            s = next((x for x in container.streams if x.type == "audio"), None)
            if s is None:
                return empty
            rate = int(s.rate or rate) or 44100
            n_ch = int(s.channels or 0)
            if start > 0:
                try:
                    container.seek(int(start * 1000000), backward=True)
                except Exception:
                    pass
            for frame in container.decode(s):
                ft = frame.time
                if ft is None:
                    try:
                        ft = float(frame.pts or 0) * float(s.time_base or 0)
                    except Exception:
                        ft = 0.0
                arr = frame.to_ndarray()
                buf = torch.from_numpy(np.ascontiguousarray(arr))
                if buf.ndim == 1:
                    buf = buf[None, :]
                # 打包格式会解成 [1, samples*channels]，按内置同法还原成 [channels, samples]
                if n_ch and buf.shape[0] != n_ch:
                    buf = buf.reshape(-1, n_ch).t()
                seg_end = float(ft) + (buf.shape[1] / float(rate) if rate else 0.0)
                if end is not None and ft >= end:
                    break
                if ft < start:
                    drop = int(round((start - ft) * rate))
                    if drop >= buf.shape[1]:
                        continue
                    buf = buf[:, drop:]
                if end is not None and seg_end > end:
                    keep = int(round((end - max(ft, start)) * rate))
                    if keep <= 0:
                        continue
                    buf = buf[:, :keep]
                if buf.shape[1] > 0:
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
        except json.JSONDecodeError as e:
            # 坏 config 会变成「0 张卡」，下游只会报 list index out of range 这类无关错误
            try:
                _ez_log.warning(
                    "[EzFlex-MediaLoader] config is not valid JSON (%s) -> treated as 0 cards: %s",
                    e, (config or "")[:80].replace("\n", " "))
            except Exception:
                pass
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
        gname = (g.get("name") or "").strip() or "Group"
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
                try:
                    _sp = int(it.get("slotPos"))
                except (TypeError, ValueError):
                    _sp = 0
                items.append({"id": it.get("id"), "slotPos": _sp if _sp > 0 else 0, "files": files})
            cname = (c.get("name") or "").strip() or "Card"
            cards_out.append({
                "id": c.get("id"),
                "name": cname,
                "group": gname,
                "label": gname + "_" + cname,
                "items": items,
                "loop": bool(c.get("loop")),
                "loopIndices": c.get("loopIndices") if isinstance(c.get("loopIndices"), list) else None,
                "loopAll": bool(c.get("loopAll")),
                "slotPositions": c.get("slotPositions") if isinstance(c.get("slotPositions"), list) else [],
            })
    return cards_out
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
    _dev, _dtype = fitted.device, fitted.dtype
    arr = (np.clip(fitted.detach().cpu().numpy(), 0.0, 1.0) * 255).astype(np.uint8)
    color = tuple(int(c) for c in _mo_edge_color(arr))
    if len(color) == 3:
        canvas = _Im.new("RGB", (width, height), color)
    else:
        canvas = _Im.new("RGBA", (width, height), color)
    canvas.paste(_Im.fromarray(arr), ((width - nw) // 2, (height - nh) // 2))
    out = np.asarray(canvas).astype(np.float32) / 255.0
    return torch.from_numpy(out).to(device=_dev, dtype=_dtype)
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
                # 保留整个批次：逐帧对齐，不能只取 v[0]（多帧视频批次会丢帧）
                v = torch.stack([_mo_fit_image(f, bw, bh, mode) for f in v], dim=0)
            out.append(v)
        size_txt = "first image" if want == "first" else want
        mode_txt = {"crop": "crop", "pad": "pad", "stretch": "stretch"}.get(mode, mode)
        print(f"[EzFlex-MediaOut] port '{label}': images have mismatched sizes; aligned to '{size_txt}' {bw}x{bh} with {mode_txt}, merged into a batch.")
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
        "Image" if isinstance(v, torch.Tensor) else
        "Audio" if isinstance(v, dict) and "waveform" in v else
        "Text" if isinstance(v, str) else
        "Video" if hasattr(v, "get_components") or hasattr(v, "get_stream_source") else
        type(v).__name__ for v in vals
    }))
    raise ValueError(
        f"EzFlex-MediaOut: {hint}this group has {len(vals)} files of mixed types ({kinds_txt}) and cannot be merged into a single batched value; "
        f"switch MediaOut to split mode and connect the files one by one."
    )
_ML_RANK = {"card": 0, "row": 1, "group": 2}
def _ml_load_cards(cards):
    """只加载给定卡片（固定模式只解码当前卡片组，避免整库读盘）。"""
    rows = []
    for card in (cards or []):
        items = []
        for item in (card.get("items") or []):
            loaded = []
            for f in (item.get("files") or []):
                path = _ml_resolve(f.get("path") or "")
                if not path:
                    continue
                ftype = (f.get("type") or _media_kind(f.get("name") or f.get("path")) or "other").lower()
                loaded.append({"id": f.get("id"), "name": f.get("name") or os.path.basename(path),
                               "type": ftype, "value": _ml_load_media(path, ftype), "path": f.get("path") or ""})
            try:
                _sp = int(item.get("slotPos"))
            except (TypeError, ValueError):
                _sp = 0
            items.append({"id": item.get("id"), "slotPos": _sp if _sp > 0 else 0, "files": loaded})
        rows.append({"group": card.get("group"), "cardId": card.get("id"), "label": card.get("label"),
                     "loop": bool(card.get("loop")),
                     "loopIndices": card.get("loopIndices") if isinstance(card.get("loopIndices"), list) else None,
                     "loopAll": bool(card.get("loopAll")),
                     "slotPositions": card.get("slotPositions") if isinstance(card.get("slotPositions"), list) else [],
                     "items": items})
    return rows
def _ml_merge_types(cfg):
    mt = cfg.get("mergeTypes") if isinstance(cfg.get("mergeTypes"), dict) else {}
    txt = mt.get("other", mt.get("text", True))
    return {"image": mt.get("image", True), "audio": mt.get("audio", True), "other": txt, "text": txt}
def _ml_fit_cfg(cfg):
    f = cfg.get("mergeFit") if isinstance(cfg.get("mergeFit"), dict) else {}
    return _mout_fit({"fit": f})
def _ml_merge_items(files, scope, types, fit):
    """把一个输出口内的 (文件, row, item) 按 scope 再分组：同类型且该类型开着拼接 → 合成 1 项；否则逐项。
    同一个拼接组里混用媒体类型 → 直接抛错（前端也给提示）。"""
    groups, order = {}, []
    for f, row, item in files:
        if scope == "card":
            key = (row.get("cardId"), item.get("id"))
        elif scope == "row":
            key = (row.get("cardId"),)
        else:
            key = "__all__"
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(f)
    out = []
    for key in order:
        fs = groups[key]
        kinds = {str(f.get("type") or "other").lower() for f in fs}
        if len(kinds) > 1:
            raise ValueError("EzFlex-MediaLoader: this merge group mixes media types (" + "、".join(sorted(kinds)) +
                             "); turn Merge off or make the group a single type.")
        k = kinds.pop() if kinds else "other"
        if len(fs) > 1 and types.get(k):
            out.append(_mo_merge_values([f.get("value") for f in fs], fs[0].get("name") or "Media", k, fit))
        else:
            for f in fs:
                out.append(f.get("value"))
    return out
def _ml_buckets(rows, mode, groups=None):
    """按粒度分桶：card=每个卡片项一口 / row=每张素材卡片一口 / group=每个分组一口，顺序 = 图上顺序。
    返回 (buckets, order, mode)；bucket = {"row","item","files":[(f,row,item)]}，空卡片组也占位。"""
    mode = mode if mode in _ML_RANK else "card"
    buckets, order = {}, []

    def add(key, row, item):
        if key not in buckets:
            buckets[key] = {"row": row, "item": item, "files": []}
            order.append(key)
        return buckets[key]

    if mode == "group":
        for gname in (groups if groups is not None else []):
            bucket = add(("g", gname), {"group": gname, "label": gname, "cardId": None}, {})
            for row in rows:
                if row.get("group") != gname:
                    continue
                for item in (row.get("items") or []):
                    bucket["files"].extend((f, row, item) for f in (item.get("files") or []))
    elif mode == "row":
        for row in rows:
            bucket = add(("c", row.get("cardId")), row, {})
            for item in (row.get("items") or []):
                bucket["files"].extend((f, row, item) for f in (item.get("files") or []))
    else:
        for row in rows:
            items = row.get("items") or []
            if not items:
                add(("i", row.get("cardId"), None), row, None)   # 空卡片组：占位口，输出空 list
                continue
            for item in items:
                bucket = add(("i", row.get("cardId"), item.get("id")), row, item)
                bucket["files"].extend((f, row, item) for f in (item.get("files") or []))
    return buckets, order, mode
def _ml_fixed_segment(rows, index, slots, groups=None, cycle=False, loop_cards=None):
    """固定模式：**只出一个口**，按 index 走「分组 → 卡片组」的扁平顺序取第 index 个卡片组，
    输出它的槽位序列（越界 = 全 None）。循环里 MediaOut 读的永远是同一个口、同一组槽位。

    `loop_cards` 里的卡片组是「循环卡片组」：每个 index 都参与，但不占用编号，不进入 order。"""
    loop_set = set(str(x) for x in (loop_cards or []) if x)
    normal_rows = []
    for r in (rows or []):
        if str(r.get("cardId") or "") not in loop_set:
            normal_rows.append(r)
    buckets, order, _mode = _ml_buckets(normal_rows, "row", groups)
    total = sum(max(0, int((s or {}).get("n") or 0)) for s in (slots or []) if isinstance(s, dict))
    i = int(index or 0)
    if not order:
        ordered = []
        for r in (rows or []):
            for it in (r.get("items") or []):
                ordered.extend((f, r, it) for f in (it.get("files") or []))
        return [{"name": "Segment", "items": _ml_fixed_items(ordered, slots) if ordered else [None] * total}]
    # 固定/循环模式：index 按分组数**循环**（1 组时每段都用同一组，不再越界变 None）
    if i < 0:
        i = 0
    if i >= len(order):
        if not cycle:
            return [{"name": "Segment", "items": [None] * total}]
        i = i % len(order)
    # 槽位数量不变；按原始卡片组顺序把「当前普通卡片组 + 所有循环卡片组」的素材排进同一组槽位。
    selected_card = str((buckets[order[i]].get("row") or {}).get("cardId") or "")
    ordered = []
    for r in (rows or []):
        cid = str(r.get("cardId") or "")
        if cid != selected_card and cid not in loop_set:
            continue
        for it in (r.get("items") or []):
            ordered.extend((f, r, it) for f in (it.get("files") or []))
    return [{"name": "Segment", "items": _ml_fixed_items(ordered, slots)}]
def _ml_ports(rows, mode, merge, scope, types, fit, groups=None, fixed=None):
    """按 mode 分组输出口：card=每个卡片一项一口 / row=每张素材卡片一口 / group=每个分组一口。
    **空卡片组/空分组也留口**（输出空 list）。拼接对象 scope 不得大于 mode（大了就夹回 mode）。
    fixed = 槽位声明时走固定模式：每个出口的值重排成 Σn 个槽位（缺槽 None），并忽略拼接。"""
    buckets, order, mode = _ml_buckets(rows, mode, groups)
    scope = scope if scope in _ML_RANK else "card"
    if _ML_RANK[scope] > _ML_RANK[mode]:
        scope = mode
    out = []
    for key in order:
        b = buckets[key]
        if fixed:
            items = _ml_fixed_items(b["files"], fixed)
        elif merge:
            items = _ml_merge_items(b["files"], scope, types, fit)
        else:
            items = [f.get("value") for f, _r, _i in b["files"]]
        if mode == "group":
            name = b["row"].get("group") or "Group"
        elif mode == "card" and b["item"] is None:
            name = "Empty card"
        elif mode == "card" and (b["item"].get("files") or []):
            name = b["item"]["files"][0].get("name") or (b["row"].get("label") or "Card")
        else:
            name = b["row"].get("label") or "Card"
        out.append({"name": name, "items": items})
    return out
_FIXED_KINDS = ("image", "video", "audio", "text", "model3d", "other")   # 顺序 = 面板槽位顺序（图片/视频/音频/文本/模型/其他）
_FIXED_POOL = {"image": "image", "video": "video", "audio": "audio", "text": "other", "model3d": "model_3d", "other": "other"}
def _ml_fixed_items(files, slots):
    """固定模式：把一口的文件按槽位声明重排成 Σn 个值（缺槽给 None）。

    默认同类槽位按出现顺序续取；卡片组的 `slotPositions`（全局 1-based 槽位号）
    可以让它把素材放到指定位置，例如普通组 1,2,3,6,7、循环组 4,5。
    """
    kinds = []
    for s in (slots or []):
        if not isinstance(s, dict):
            continue
        k = _FIXED_POOL.get(str(s.get("type") or "other").lower(), "other")
        kinds.extend([k] * max(0, int(s.get("n") or 0)))
    total = len(kinds)
    out = [None] * total
    used = set()
    # ★ 固定模式一个「素材卡片」= 一个槽位值，不按卡片里的文件数铺开。
    #   批量卡片仍只输出第一份值（与前端 fixedCells / mlSegmentFiles 的口径一致）。
    order = []
    first = {}
    for f, row, item in (files or []):
        key = (str((row or {}).get("cardId") or ""), str((item or {}).get("id") or id(f)))
        if key not in first:
            first[key] = (f, row, item)
            order.append(key)
    entries = []
    for key in order:
        f, row, item = first[key]
        pos = []
        # 单个素材卡片拖到指定格：item.slotPos 优先；没设就退回卡片组的 slotPositions。
        try:
            sp = int((item or {}).get("slotPos") or 0)
        except (TypeError, ValueError):
            sp = 0
        if 1 <= sp <= total:
            pos = [sp]
        elif isinstance(row, dict):
            for p in (row.get("slotPositions") or []):
                try:
                    p = int(p)
                except (TypeError, ValueError):
                    continue
                if 1 <= p <= total:
                    pos.append(p)
        entries.append((f, str(f.get("type") or "other").lower(), pos))
    # 先占显式位置，避免普通组按先后顺序先占掉循环组指定的 4、5。
    pending = []
    for f, kind, pos in entries:
        pick = None
        for p in pos:
            if p not in used and kinds[p - 1] == kind:
                pick = p
                break
        if pick is None:
            pending.append((f, kind, bool(pos)))
            continue
        used.add(pick)
        out[pick - 1] = f.get("value")
    # 未指定位置（或指定位置被占用）的素材再按类型找空位。
    for f, kind, _had_pos in pending:
        pick = None
        for p in range(1, total + 1):
            if p not in used and kinds[p - 1] == kind:
                pick = p
                break
        if pick is None:
            continue
        used.add(pick)
        out[pick - 1] = f.get("value")
    return out
# 节点：卡片式素材装载：普通/固定槽位两种模式，一个端口可能是一份 list。
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
            "optional": {
                "index": ("INT", {
                    "default": 0,
                    "min": 0,
                    "forceInput": True,
                    "tooltip": "Fixed mode only: output the index-th card group's slots (the panel walks groups then card groups).",
                }),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = _DynamicOutputTypes()
    RETURN_NAMES = ()
    FUNCTION = "load"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Media Loader"

    def load(self, config="{}", index=None, **kwargs):
        cfg = {}
        try:
            cfg = json.loads(config) if isinstance(config, str) else (config or {})
        except Exception:
            cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}
        cards = parse_media_cards(config)
        groups = [((g.get("name") or "").strip() or "Group") for g in (cfg.get("groups") or []) if isinstance(g, dict)]
        loop_cards = set(str(c.get("id")) for c in cards if c.get("loop"))
        fixed = cfg.get("fixed") if isinstance(cfg.get("fixed"), dict) else {}
        slots = fixed.get("slots") if fixed.get("on") else None
        if slots:
            try:
                _i = max(0, int(index or 0))
            except (TypeError, ValueError):
                _i = 0
            # 循环卡片组每个 index 都带上；普通卡片组才参与编号。
            normal_cards = [c for c in cards if not c.get("loop")]
            _loop_no = _i + 1
            def _loop_active(c):
                if c.get("loopAll"):
                    return True
                try:
                    arr = c.get("loopIndices")
                    if not isinstance(arr, list):
                        return True
                    return _loop_no in {int(x) for x in arr}
                except (TypeError, ValueError):
                    return False
            loop_card_list = [c for c in cards if c.get("loop") and _loop_active(c)]
            loop_cards = set(str(c.get("id")) for c in loop_card_list)
            picked = normal_cards[_i % len(normal_cards)] if normal_cards else None
            use_cards = [c for c in cards if (c.get("loop") and c in loop_card_list) or c is picked]
            rows = _ml_load_cards(use_cards)
            ports = _ml_fixed_segment(rows, 0, slots, groups, cycle=True, loop_cards=loop_cards)
        else:
            rows = _ml_load_cards(cards)
            ports = _ml_ports(rows, str(cfg.get("mode") or "card"), bool(cfg.get("merge")) and not slots,
                              str(cfg.get("mergeScope") or "card"), _ml_merge_types(cfg), _ml_fit_cfg(cfg), groups, slots)
        outputs = [p["items"] for p in ports]
        labels = [p["name"] or "Card" for p in ports]
        self.OUTPUT_IS_LIST = tuple([True] * len(outputs))                      # 挂在实例上：merge_result_data 读的就是实例，UI 的 /object_info 看不到 → 端口保持圆点
        return _ez_apply_dynamic_ports(self, labels, outputs)
# 节点：拆 MediaLoader 的 list，一项一口；端口名由前端按素材同步。
class MediaOutNode:
    """EzFlex-MediaOut：MediaLoader 的拆分端。收 Loader 整份 list（INPUT_IS_LIST=True），一个项一个输出口，
    值按序原样给；端口名/类型由前端 /media_out/outputs 按素材项同步（运行期全是 *）。
    config 里记的本地禁用项输出 None，端口位置不变。批量合并（多张图成批量张量、音频拼接等）在 MediaLoader 那边做。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "card": ("*", {
                    "forceInput": True,
                    "tooltip": "A list output from EzFlex-MediaLoader (one item per file / merged group).",
                }),
                "config": ("STRING", {
                    "multiline": True,
                    "default": "{}",
                    "tooltip": "Media Out panel config (ids of locally disabled files).",
                }),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = _DynamicOutputTypes()
    RETURN_NAMES = ()
    INPUT_IS_LIST = True   # 收 MediaLoader 整份 list，自己拆；不再按项执行
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Media Out"

    def run(self, card=None, config="{}", **kwargs):
        """只拆分：list 项就是真实媒体值（MediaLoader 输出的就是值本身），一项一个输出口。
        端口名/类型由前端 /media_out/outputs 按 MediaLoader 的 _ezItems 设置，这里只按序返回；offIdx = 本地禁用项下标。"""
        cfg = config[0] if isinstance(config, (list, tuple)) and config else config
        off = set()
        try:
            data = json.loads(cfg) if isinstance(cfg, str) else (cfg or {})
            off = {int(x) for x in (data.get("offIdx") or [])}
        except Exception:
            pass
        vals = card if isinstance(card, (list, tuple)) else ([] if card is None else [card])
        outputs = []
        for i, v in enumerate(vals):
            if i in off:
                v = None
            elif isinstance(v, torch.Tensor) and int(v.ndim) >= 3 and int(v.shape[0]) == 0:
                v = None       # 空 IMAGE/V VIDEO 批次：下游 H3 ref_images 会把它当有效图去 resize，直接给 None
            outputs.append(v)
        return _ez_apply_dynamic_ports(self, getattr(type(self), "RETURN_NAMES", ()), outputs)
_EZ_LIST_MAX = 16
# 节点：多输入按端口顺序拼成一份 list；整份全 None 的输入视为没接。
class MergeListNode:
    """EzFlex-MergeList：把若干输入按顺序拼成一个列表（列表展开并入，非列表追加为一项）。
    输入口动态（前端按需增删，后端声明到 _EZ_LIST_MAX），输出固定一个 list，可直接喂 StartLoop 的 List 模式。
    「整份都是 None」的输入视为没接（LoopStart 没给初值的 valueK 吐 [None]，见 merge 里的注释）。"""

    @classmethod
    def INPUT_TYPES(s):
        opt = {}
        for i in range(1, _EZ_LIST_MAX + 1):
            opt["input_%d" % i] = ("*",)
        return {"required": {}, "optional": opt}

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("list",)
    INPUT_IS_LIST = True
    FUNCTION = "merge"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Merge List"

    def merge(self, **kwargs):
        self.OUTPUT_IS_LIST = (True,)   # 实例级：UI 里出口保持圆点，执行仍是"一份 list"
        out = []
        # ★★ 拼接顺序 = 画布上从上到下的端口顺序（kwargs 键顺序），不是 input_N 的数字顺序。
        #   前端会回收空口、在末尾补「最小空闲编号」的新口（`syncMergeInputs`），名字顺序可能与上下顺序
        #   不一致；序列化时按 node.inputs 数组顺序写键 ⇒ JSON 键顺序 = 视觉顺序，Python dict 保序 ⇒
        #   kwargs 保序。面板同时把已连口重命名成 input_1..n，两边口径一致。只认 input_N，其它键跳过。
        for name, v in kwargs.items():
            if not (isinstance(name, str) and name.startswith("input_") and name[6:].isdigit()):
                continue
            if v is None:
                continue
            if isinstance(v, (list, tuple)):
                # ★ 整份都是 None 的输入当成「没接」：LoopStart 的某个 valueK 在第 1 轮没有初值
                #   （initial valueK 空着）时，它按「列表输出」吐出来的是 [None]（见
                #   LoopStartNode._as_items）—— 累积时若把这个 None 当成第 0 项，整份列表就会
                #   错位一格（TimeLine 的「第 i 项 = 第 i 段」整体偏一位）。
                #   ⚠️ 只跳过「全是 None」的整份，**不**逐个丢 None：SplitList 补的 None 占位
                #      （[a, None, c]）必须原样保留，否则 Split→Merge 往返会掉项。
                if v and all(x is None for x in v):
                    continue
                out.extend(v)
            else:
                out.append(v)
        return (out,)
# 节点：一份 list 按序拆成 16 个出口，缺的补 None。
class SplitListNode:
    """EzFlex-SplitList：把一份 list 按顺序拆成多个输出口（一个 list 项一个口），缺的补 None。
    与 EzFlex-MergeList 互为反操作，适用于任意 ComfyUI 列表值。端口数由面板决定。"""

    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
            "list": ("*", {"forceInput": True, "tooltip": "Any ComfyUI list value (for example the output of EzFlex-MergeList)."}),
        }}

    RETURN_TYPES = _DynamicOutputTypes("*" for _ in range(_EZ_LIST_MAX))
    RETURN_NAMES = tuple("item%d" % i for i in range(_EZ_LIST_MAX))
    INPUT_IS_LIST = True
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Split List"

    def run(self, **kwargs):
        # 输入名就叫 list，不能当形参（会遮蔽内置 list），从 kwargs 取
        v = kwargs.get("list")
        vals = v if isinstance(v, (list, tuple)) else ([] if v is None else [v])
        return tuple(vals[i] if i < len(vals) else None for i in range(_EZ_LIST_MAX))
_EZ_REROUTE_MAX = 32
# 节点：逐口 1:1 透传（任意类型），口数与口名由前端 config 决定。
class EzFlexRerouteNode:
    """EzFlex-Reroute：转接点。与内置 Reroute 一样做「原样转接」，但一口一卡、可自定义命名。

    与 MergeList / SplitList 的区别（**都保留，语义别混**）：
      - MergeList 是 N→1（把多个值合成一个 list）；
      - SplitList 是 1→N（把一份 list 拆成多个口）；
      - Reroute 是 **逐口 1:1 透传**（第 i 个入口 → 第 i 个出口），不做任何合并/拆分。
    输入输出全是 ANY（`*`），可以转接任意类型（MODEL / LATENT / 图片 / 字符串……）。

    口数与每个口的名字由前端面板维护、存进本节点 config；面板增删口后 POST /ezreroute/outputs
    同步类 RETURN_TYPES / RETURN_NAMES（校验与端口名用），execute 再按入口实际收到的值逐口返回。
    """

    @classmethod
    def INPUT_TYPES(s):
        # ⚠️ config 必须放在 **required** 里（不能放 optional）：
        #    - required 的 STRING 才会被前端稳定建成「可编辑 + 可序列化」的 widget，
        #      值进 widgets_values，刷新/重启后能恢复；
        #    - 放 optional 会被当成「可选输入口」处理，不生成可序列化 widget →
        #      writeConfig 静默 return、readConfig 恒读回 {}，自定义名一刷新就丢。
        #    （同 MediaLoader / MediaOut / PromptHelper 的写法：required + multiline STRING + default "{}"）
        req = {"config": ("STRING", {
            "multiline": True,
            "default": "{}",
            "tooltip": "Reroute panel state: per-card custom names (one per connected input).",
        })}
        opt = {}
        for i in range(1, _EZ_REROUTE_MAX + 1):
            opt["input_%d" % i] = ("*",)
        return {"required": req, "optional": opt}

    RETURN_TYPES = _DynamicOutputTypes("*" for _ in range(_EZ_REROUTE_MAX))
    # 1 基命名（output_1..output_32），与入口 input_1..input_32 对齐 —— 面板默认名也用这套。
    RETURN_NAMES = tuple("output_%d" % (i + 1) for i in range(_EZ_REROUTE_MAX))
    FUNCTION = "route"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Reroute"

    def route(self, **kwargs):
        # 逐口透传：第 i 个入口原样送到第 i 个出口。没接线的入口给 None（下游会当空值处理）。
        # ⚠️ 必须按「本实例当前口数」返回，不能固定返回 _EZ_REROUTE_MAX 个 ——
        # 类 RETURN_TYPES 是全局共享的，超过实际口数会产出一堆悬空输出。
        # 口数只能从入参推断：内核不给节点实例挂 `outputs`（execution.py 只在自己身上用这个名字），
        # 面板的 syncSockets 又把已连输入压到 1..conn、输出数 = conn，所以「最高已连 input_N」就是口数。
        n = 0
        for i in range(_EZ_REROUTE_MAX, 0, -1):
            if kwargs.get("input_%d" % i) is not None:
                n = i
                break
        n = max(0, min(_EZ_REROUTE_MAX, n))
        return tuple(kwargs.get("input_%d" % (i + 1)) for i in range(n))
_EZ_LOOP_MAX = 20
# ===== §8 循环节点与续跑缓存 =====
def _ez_ref_range_slice(v, typ, rng, fps=24.0):
    """按参考卡的 `range` 裁剪「回喂过来的整段帧序列」：-N = 取最后 N 帧，N = 取前 N 帧。

    ★ 只处理 **frames / image**（用户设定：帧序列按设定帧数取，落盘不足就取现有的）；
      `video` / `audio` 一律原样透传 —— 那两种由用户自己用 SplitVideo 裁切，LoopStart 不碰。

    LoopEnd 回喂的是**上一整段**（images 全部帧 / audio 全部采样），而 H3 的 ref_videos / 参考音频
    只需要卡上写的那几帧。不裁的话整段都会变成参考 token（用户实测每步慢好几倍）。
    只处理 IMAGE 张量与 AUDIO dict；其它类型原样返回。
    """
    try:
        s = str(rng if rng is not None else "").strip()
        if not s:
            return v
        neg = s.startswith("-")
        try:
            n = abs(int(s[1:] if neg else s))
        except (TypeError, ValueError):
            return v
        if n <= 0:
            return v
        t = str(typ or "").lower()
        if t in ("frames", "image") and torch.is_tensor(v) and v.ndim == 4:
            total = int(v.shape[0])
            out = v if total <= n else (v[-n:] if neg else v[:n])
            # ★ H3 的参考视频只接受 17k+5 帧（5/22/39…），非网格长度会被它**向下裁**；
            #   <5 帧直接报错。这里提前把"实际会用几帧"记下来，免得以为 22 帧生效了其实是 5 帧。
            try:
                got = int(out.shape[0])
                if got < 5:
                    print("[EzFlex-LoopStart] 参考帧只有 %d 帧（<5），H3 会报错 'need at least 5 frames'" % got)
                else:
                    grid = got
                    while grid % 17 != 5:
                        grid -= 1
                    if grid != got:
                        print("[EzFlex-LoopStart] 参考帧 %d 不在 17k+5 网格，H3 会按 %d 帧使用（要正好 %d 帧请保证落盘 ≥%d）"
                              % (got, grid, got, got))
            except Exception:
                pass
            return out
    except Exception:
        pass
    return v


def _ez_resume_media_meta(root, idx):
    try:
        with _io.open(os.path.join(root, "seg_%04d.media.json" % int(idx)), "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}
def _ez_resume_images(root, idx):
    """重跑：优先读 <base>.ref 的 PNG 序列；没有才解码成片。"""
    import av
    import numpy as np
    rd = os.path.join(root, "seg_%04d.ref" % int(idx))
    if os.path.isdir(rd):
        try:
            from PIL import Image
            fs = sorted(f for f in os.listdir(rd) if f.lower().endswith(".png"))
            if fs:
                rows = [np.array(Image.open(os.path.join(rd, f)).convert("RGB")) for f in fs]
                arr = np.stack(rows, axis=0).astype("float32") / 255.0
                return torch.from_numpy(arr)
        except Exception:
            pass
    p = os.path.join(root, "seg_%04d.mp4" % int(idx))
    if not os.path.isfile(p):
        return None
    rows = []
    with av.open(p) as c:
        vs = next((s for s in c.streams if s.type == "video"), None)
        if vs is None:
            return None
        for fr in c.decode(vs):
            rows.append(fr.to_ndarray(format="rgb24"))
    if not rows:
        return None
    arr = np.stack(rows, axis=0).astype("float32") / 255.0
    return torch.from_numpy(arr)
def _ez_resume_audio(root, idx):
    """重跑：把上一段 WAV 侧车读成 ComfyUI AUDIO（原样注入 value4 参考）。"""
    import wave
    import numpy as np
    p = os.path.join(root, "seg_%04d.wav" % int(idx))
    if not os.path.isfile(p):
        return None
    with wave.open(p, "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype("float32") / 32768.0
    if not data.size:
        return None
    data = data.reshape(-1, ch).T
    return {"waveform": torch.from_numpy(data).unsqueeze(0), "sample_rate": int(sr)}
def _ez_resume_video(root, idx):
    """重跑：上一段成片恢复成 VideoFromFile（value3 这类视频参考用）。"""
    p = os.path.join(root, "seg_%04d.mp4" % int(idx))
    if not os.path.isfile(p):
        return None
    try:
        return InputImpl.VideoFromFile(p)
    except Exception as exc:
        print("[EzFlex-LoopStart] resume video load failed: %s" % exc)
        return None
_EZ_LOOP_SAFE_MAX = 200
try:
    from comfy_execution.graph_utils import GraphBuilder, is_link
    from comfy_execution.graph import ExecutionBlocker
    import nodes as _comfy_nodes
except Exception:   # 旧核心没有展开器/执行图就只登记节点，运行期自然报缺依赖
    GraphBuilder = None
    is_link = None
    ExecutionBlocker = None
    _comfy_nodes = None
# 队列续跑时把「不能进 JSON 的值」（张量 / 含张量的 dict）落到 temp 再传标记：
# 否则入队的 prompt 里带 tensor，/queue 与 /history 序列化就 500。
# ★ 兼容：只有 json.dumps 失败时才走这条路，普通值（str/int/list/dict）原样写入，行为与以前完全一致。
_EZ_HANDOFF_KEY = "__ezflex_handoff__"
_EZ_HANDOFF_DIR = "EzFlex_handoff"


def _ez_handoff_dir():
    try:
        import folder_paths
        base = folder_paths.get_temp_directory()
    except Exception:
        return ""
    if not base:
        return ""
    p = os.path.join(base, _EZ_HANDOFF_DIR)
    try:
        os.makedirs(p, exist_ok=True)
    except Exception:
        return ""
    return p


def _ez_json_ok(v):
    try:
        json.dumps(v)
        return True
    except Exception:
        return False


def _ez_handoff_save(v):
    """不可序列化的值 → 落盘，返回标记 dict（{__ezflex_handoff__: 文件名}）；失败返回 None。"""
    d = _ez_handoff_dir()
    if not d:
        return None
    import uuid as _uuid
    name = "h_" + _uuid.uuid4().hex + ".pt"
    try:
        import torch
        torch.save(v, os.path.join(d, name))
    except Exception as exc:
        print("[EzFlex-Loop] handoff save failed: %s" % exc)
        return None
    return {_EZ_HANDOFF_KEY: name}


def _ez_handoff_load(mark):
    """标记 → 原值。只接受「纯文件名」且落在 handoff 目录里的文件；异常一律返回 None。"""
    name = str((mark or {}).get(_EZ_HANDOFF_KEY) or "")
    if not name or os.path.basename(name) != name:
        return None
    d = _ez_handoff_dir()
    if not d:
        return None
    p = os.path.join(d, name)
    if not os.path.isfile(p):
        return None
    v = None
    try:
        import torch
        v = torch.load(p, map_location="cpu", weights_only=False)
    except Exception as exc:
        print("[EzFlex-Loop] handoff load failed: %s" % exc)
        v = None
    try:
        os.remove(p)          # 一次性：取回后立刻删
    except OSError:
        pass
    return v


# 节点：循环起点：输出 index 与上一轮 End 回喂的 valueK；首轮用 initial valueK。
class LoopStartNode:
    """EzFlex-LoopStart：循环起点，只干一件事 —— 把上一轮 LoopEnd 收到的产物回喂给本轮。

    面板只有一个 index 框：**本次运行从第几轮开始**（默认 0 = 从头）。运行期它是只读的，每展开
    一轮 +1；它同时作为 index 输出口的值给下游（PromptHelper / TimeLine / MediaLoader 的 index
    输入口按它换内容），所以「控制起点」和「控制下游」是同一件事。

    端口：固定输出 index（INT），紧跟 value1 / value2 / …（动态。「连一个加一个」）。
      · 第 1 轮（idx <= start）：valueK 输出 = 对应的 initial valueK 输入；没接 initial valueK 才给 None。
      · 第 2 轮起：valueK 输出 = 上一轮 LoopEnd 第 K 个输入口收到的值（有回喂就覆盖初值）。
      初值口 initial value1 / initial value2 / … 也是「连一个加一个」的通配（`*`）输入口，
      类型跟着你接进去的线走 —— 用来喂「第一次循环还没有上一轮产物」时下游要的那个值。不接也行，
      但下游若是 torch.cat / VAE 之类吃实值的节点，第一轮收到 None 就会报错，这时就必须给初值。
    轮数不在这里，在 LoopEnd 面板的「次数」框。

    ★ 回喂是**隐式**的，画布上不要连。真连上 End.valueK → Start.valueK 会成环：内核
      comfy_execution/graph.py:303 是唯一的 DependencyCycleError 抛点，校验期不做环检测，
      所以一提交就报 "Dependency cycle detected"。做法是展开时直接写进克隆节点的字面量输入。
    这一条对后端 static 方法同样成立：本节点没有 FROM_END 那种「声明式回连口」，因为声明了
    就会在前端生成连线、连线就会成环。
    """

    @classmethod
    def INPUT_TYPES(s):
        opt = {"index": ("INT", {"default": 0, "min": 0, "forceInput": True,
                                 "tooltip": "Start round (0 = from the first). Also becomes the index output value of the first round. Leave unwired to use the panel value."})}
        # 初值口：第 1 轮（还没有上一轮产物）时每个 valueK 输出什么。通配类型，跟着线走。
        for k in range(1, _EZ_LOOP_MAX + 1):
            opt["initial value%d" % k] = ("*", {"tooltip": "Initial value %d. Used as value%d on the first round, before any feed-back arrives. Wire the same kind of data you expect LoopEnd value%d to carry back. Optional, but required if the downstream node cannot accept a missing value." % (k, k, k)})
        # ★★ _ezfeedK：展开时由 LoopEnd 写进克隆节点的字面量输入（上一轮 End 收到的值）。
        #   必须在这里声明成 optional，否则 get_input_data 会把未声明的键整个丢掉
        #   （execution.py:183 `elif input_category is not None ...` 那一支），loop_open 的 **kwargs
        #   里永远拿不到 _ezfeedK → v 恒 None → 每轮都回落到初值 → 表现就是「不循环 / 每轮同一个值」。
        #   ★ 这正是 __ezround 在 LoopEnd 侧的同一个坑，两边都不能漏。
        #   前端 stripCoreSockets 会把这些口摘掉，用户看不到它。
        for k in range(1, _EZ_LOOP_MAX + 1):
            opt["%s%d" % (LoopStartNode._FEED_PREFIX, k)] = ("*", {"forceInput": True,
                             "tooltip": "Internal feed-back slot written by the loop expander. Not a canvas port."})
        return {"required": {"config": ("STRING", {"multiline": True, "default": "{}",
                                                   "tooltip": "Loop Start panel state (start round). Kept as a serialisable widget so the round counter survives save / load."})},
                "optional": opt}

    RETURN_TYPES = ("INT",) + ("*",) * _EZ_LOOP_MAX
    RETURN_NAMES = ("index",) + tuple("value%d" % (i + 1) for i in range(_EZ_LOOP_MAX))
    # ⚠️ OUTPUT_IS_LIST 不写在这里（那是给 /object_info 看的）：见 loop_open 里写在**实例**上，
    #    这样内核能拿到、而面板端口样式不变（同 MergeList / MediaLoader 的惯例）。
    FUNCTION = "loop_open"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Loop Start"

    # 展开时由 LoopEnd 直接写进克隆节点的字面量输入（不是画布连线，见类 docstring）
    _FEED_PREFIX = "_ezfeed"

    @staticmethod
    def _is_feed(name):
        return isinstance(name, str) and name.startswith(LoopStartNode._FEED_PREFIX)

    @staticmethod
    def _feed_slot(name):
        try:
            return max(1, int(str(name)[len(LoopStartNode._FEED_PREFIX):]))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _feed_name(k):
        return "%s%d" % (LoopStartNode._FEED_PREFIX, int(k))

    @staticmethod
    def _init_name(k):
        """初值输入口 / 初值 kwargs 的键名：'initial value1'（带空格，前端黑框标签也照它显示）。"""
        return "initial value%d" % int(k)

    @staticmethod
    def _start_round(cfg):
        try:
            v = (cfg or {}).get("start")
            if v is None or v == "":
                v = (cfg or {}).get("index")
        except Exception:
            v = None
        try:
            return max(0, int(v))
        except (TypeError, ValueError):
            return 0

    def loop_open(self, config="{}", index=0, **kwargs):
        # ★★ index 是标量；value1..N 声明成「列表输出」（每轮的值按「项」返回，见 _as_items）。
        #   为什么必须这样：内核 merge_result_data 对**非** OUTPUT_IS_LIST 的口会把结果包一层
        #   （`[o[i] for o in results]`）—— 标量无所谓，但**列表值会被多包一层**：
        #   MergeList(INPUT_IS_LIST=True) 收到 [[0,1]] 会把它当成「一个元素」→ 累积变成嵌套
        #   `[[[0,1],2],3]` 而不是平铺 `[0,1,2,3]`。声明成 True 后内核用 extend 平铺，链路上
        #   「上一轮累积的列表」始终是平的（实测 rounds=3 → out1=[0,1,2,3]）。
        #   ⚠️ 按本项目惯例写在**实例**上（同 MergeList / MediaLoader）：内核读的就是实例，
        #      写在实例上：内核执行时读实例，/object_info 只读类属性，前端端口显示不受影响。
        self.OUTPUT_IS_LIST = (False,) + (True,) * _EZ_LOOP_MAX
        try:
            cfg = json.loads(config) if isinstance(config, str) else (config or {})
        except Exception:
            cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}
        idx = max(0, int(index or 0))
        _resume_dir = ""
        try:
            _resume_dir = str((cfg or {}).get("resumeDir") or "").strip()
        except Exception:
            _resume_dir = ""
        # resumeDir 来自工作流 config：只允许 output/input/temp/models 和根表里的可写目录，
        # 否则「重跑」会变成一个能读任意本地文件的入口（后续按 seg_*.mp4/.wav/.png 读）。
        if _resume_dir and not _ez_inside(_resume_dir, _ezsp_allowed_roots()):
            print("[EzFlex-LoopStart] resumeDir 不在允许的目录内，已忽略：%s" % _resume_dir)
            _resume_dir = ""
        out = [idx]
        _cards_cfg = cfg.get("refs") if isinstance(cfg.get("refs"), list) else []
        for k in range(1, _EZ_LOOP_MAX + 1):
            v = kwargs.get(self._feed_name(k))
            if isinstance(v, dict) and set(v.keys()) == {_EZ_HANDOFF_KEY}:
                v = _ez_handoff_load(v)      # 队列续跑：上一轮落在 temp 的张量取回来
            if v is None and idx > 0 and _resume_dir:
                # 区间重跑：上一段的 valueK 从 run 目录缓存里取（不用重跑前一段）
                _meta0 = _ez_resume_media_meta(_resume_dir, idx - 1)
                _fallback = cfg.get("resumeMedia") if isinstance(cfg.get("resumeMedia"), dict) else {}
                if not _meta0:
                    _meta0 = dict(_fallback)
                elif _fallback:
                    # media.json 里可能只有 files、没有逐项类型；用内置 fallback 类型按端口补默认值
                    _meta0 = dict(_meta0)
                    for _fk, _ft in _fallback.items():
                        _meta0.setdefault(str(_fk), _ft)
                _fmap = _meta0.get("files") if isinstance(_meta0.get("files"), dict) else {}
                _fname = str(_fmap.get(str(k)) or "")
                _mtyp = str(_meta0.get(str(k)) or "").lower()
                _cands = []
                if _fname:
                    _cands.append(os.path.join(_resume_dir, _fname))
                _cands.append(os.path.join(_resume_dir, "seg_%04d.v%d.pt" % (idx - 1, k)))
                _cands.append(os.path.join(_resume_dir, "seg_%04d_v%d.pt" % (idx - 1, k)))
                _cands.append(os.path.join(_resume_dir, "seg_%04d_v%d.latent" % (idx - 1, k)))
                _fp = next((p for p in _cands if os.path.exists(p)), "")
                if _fp:
                    try:
                        if _mtyp and _mtyp != "latent":
                            v = _ezsp_load_persist_file(_resume_dir, os.path.basename(_fp), _mtyp, "-999", 24)
                        else:
                            # .latent = 核心 safetensors 格式；.pt = 本插件旧格式（只读纯 tensor/dict）
                            v = _ez_load_latent_file(_fp)
                        # 带上类型/形状：下游是核心节点时，形状不对会炸在很深的地方（resize/reshape），
                        # 这里先把它记下来，报错时能一眼看出是哪个 value 喂了什么。
                        try:
                            _shp = tuple(v.shape) if hasattr(v, "shape") else (type(v).__name__,)
                        except Exception:
                            _shp = ("?",)
                        print("[EzFlex-LoopStart] 重跑续接：读取上一段 value%d 缓存 %s -> %s %s"
                              % (k, os.path.basename(_fp), type(v).__name__, _shp))
                    except Exception as _exc:
                        print("[EzFlex-LoopStart] resume cache load failed: %s" % _exc)
                if v is None:
                    # 上一段视频/音频参考：按正常跑时记录的 media.json，从 seg_{K-1}.mp4/.wav 重建
                    _meta = _meta0   # 已在上面读好（custom file name / type 共用）
                    _typ = _meta.get(str(k))
                    if _typ == "image":
                        v = _ez_resume_images(_resume_dir, idx - 1)
                    elif _typ == "audio":
                        v = _ez_resume_audio(_resume_dir, idx - 1)
                    elif _typ == "video":
                        v = _ez_resume_video(_resume_dir, idx - 1)
            if idx <= self._start_round(cfg) or v is None:
                # 还没有回喂（第 1 轮 / 起始轮之前）：用初值口兜底。
                # ★ 别直接给 None：下游若是 torch.cat / VAE 这类吃实值的节点，收到 None 会直接报错。
                v = kwargs.get(self._init_name(k))
            # ★ 回喂的是**上一整段**：按该口的参考卡 `range` 裁掉多余帧，否则 H3 的 ref_videos
            #   会吃到整段参考（token 暴涨、每步慢好几倍）。卡上没写 range 就不动。
            try:
                _rc = None
                if isinstance(_cards_cfg, list) and 0 < k <= len(_cards_cfg) and isinstance(_cards_cfg[k - 1], dict):
                    _rc = _cards_cfg[k - 1]
                if _rc is not None and v is not None:
                    _rt = str(_rc.get("type") or "").lower()
                    _rr = str(_rc.get("range") or "").strip()
                    if _rr and _rt in ("frames", "image"):
                        _before = None
                        try:
                            if torch.is_tensor(v) and v.ndim == 4:
                                _before = int(v.shape[0])
                            elif isinstance(v, dict) and "waveform" in v:
                                _before = int(v["waveform"].shape[-1])
                        except Exception:
                            _before = None
                        v = _ez_ref_range_slice(v, _rt, _rr, cfg.get("fps") or 24)
                        _after = None
                        try:
                            if torch.is_tensor(v) and v.ndim == 4:
                                _after = int(v.shape[0])
                            elif isinstance(v, dict) and "waveform" in v:
                                _after = int(v["waveform"].shape[-1])
                        except Exception:
                            _after = None
                        if _before is not None and _after is not None and _before != _after:
                            print("[EzFlex-LoopStart] value%d 参考裁剪：%d -> %d（type=%s range=%s）"
                                  % (k, _before, _after, _rt, _rr))
            except Exception:
                pass
            out.append(self._as_items(self._unwrap_literal(v)))
        try:
            _cards = cfg.get("refs") if isinstance(cfg.get("refs"), list) else []
            _paths = cfg.get("refPaths") if isinstance(cfg.get("refPaths"), dict) else {}
            if _paths:
                for _i in range(4):
                    _card = _cards[_i] if _i < len(_cards) and isinstance(_cards[_i], dict) else {}
                    if not bool(_card.get("timeline", (_card.get("enabled", True) and _card.get("follow", True)))):
                        continue
                    _role = str(_card.get("role") or "prev").lower()
                    _typ = str(_card.get("type") or "video").lower()
                    _rng = str(_card.get("range") or _card.get("count") or "-5")
                    _use_rng = _rng if _typ == "frames" else "0"
                    try:
                        _need = abs(int(_rng.replace("-", "") or 0))
                    except (TypeError, ValueError):
                        _need = 5
                    _rp = (_paths.get(_role) or {}) if isinstance(_paths.get(_role), dict) else {}
                    _p = str(_rp.get(_typ) or "")
                    _val = None
                    if _resume_dir and _role in ("prev", "cur", "next"):
                        try:
                            _si = idx - 1 if _role == "prev" else (idx if _role == "cur" else idx + 1)
                            _mm = _ez_resume_media_meta(_resume_dir, _si)
                            _ff = (_mm.get("files") or {}).get(str(_i + 1)) if isinstance(_mm, dict) else None
                            _mt = str((_mm.get(str(_i + 1)) if isinstance(_mm, dict) else "") or "").lower()
                            if _ff and (_mt == _typ or (_mt == "image" and _typ in ("frames", "image"))):
                                _val = _ezsp_load_persist_file(_resume_dir, str(_ff), _mt, _use_rng, cfg.get("fps") or 24)
                        except Exception:
                            _val = None
                    if _typ in ("frames", "image"):
                        if os.path.isdir(_p):
                            try:
                                _have = len([x for x in os.listdir(_p) if x.lower().endswith(".png")])
                            except Exception:
                                _have = 0
                            if _have < _need and _rp.get("video"):
                                _p = str(_rp.get("video") or "")
                        elif _rp.get("video"):
                            _p = str(_rp.get("video") or "")
                    if _val is None:
                        _val = _ezsp_load_ref_file(_p, _typ, _use_rng, cfg.get("fps") or 24)
                    if (_i + 1) < len(out):
                        # ★ 必须走 _as_items：valueK 是「列表输出」，内核会对返回值 extend。
                        #   直接把 4 维帧批次（T,H,W,C）放进去会被 extend 拆成 T 张单帧（H,W,3），
                        #   下游拿到的是**一张 3 维图**——核心节点按 IMAGE 批次读就会
                        #   「shape [576,-1,3,1024,32] invalid」这种错（重新生成本段时踩到）。
                        #   取不到值时**必须保持 valueK 原样**（首段没有上一段、或文件已被清），
                        #   直接写 None 会让内核 extend(None) 抛 TypeError。
                        try:
                            _sh = tuple(_val.shape) if hasattr(_val, "shape") else (type(_val).__name__,)
                            print("[EzFlex-LoopStart] 参考卡 %d -> value%d: %s %s (type=%s, range=%s)"
                                  % (_i + 1, _i + 1, type(_val).__name__, _sh, _typ, _use_rng))
                        except Exception:
                            pass
                        if _val is not None:
                            out[_i + 1] = self._as_items(_val)
        except Exception as _exc:
            print("[EzFlex-LoopStart] ref card failed: %s" % _exc)
        return tuple(out)

    @staticmethod
    def _unwrap_literal(v):
        """拆掉 `{"__value__": …}` 包装（队列续跑写回喂值时会给 list 包这一层，见 LoopEnd._wrap_literal）。

        ⚠️ 队列模式塞回去的 prompt **不经过内核校验**（`execute_async` 不调 validate_prompt），
        所以那层包装不会被 `validate_inputs` 解掉 —— 必须在这里自己拆，否则回喂值会变成
        「一个 dict」而不是列表。展开模式的值是直接写的（没有包装），拆不动就原样返回。
        """
        if isinstance(v, dict) and "__value__" in v:
            return v["__value__"]
        return v

    @staticmethod
    def _as_items(v):
        """valueK 出口是「列表输出」（OUTPUT_IS_LIST=True，在 loop_open 里按实例设置）：内核会把返回的
        每一项 `value.extend(该项)` 拼起来，所以这里要按「项的列表」返回：
          · 值本身是 list/tuple ⇒ 当成多项（**累积列表继续平铺往下传**，这是累积能成立的关键）；
          · 其它（标量 / latent / 图 …）⇒ 当成一项 [v]。
        ⚠️ 别直接返回标量：OUTPUT_IS_LIST=True 时内核会对它 `extend` → TypeError。"""
        return list(v) if isinstance(v, (list, tuple)) else [v]

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")   # 循环控制节点不进缓存：每次提交都重新展开，避免「改了 body 却什么都不跑」
# 节点：循环终点：按总轮数展开（或队列续跑）下一轮，收尾时把 valueK 从 outK 吐出。
class LoopEndNode:
    """EzFlex-LoopEnd：循环触发器 + 终点。面板只有一个「次数」框，语义是**总轮数**（含第 1 轮）：
    0 或 1 = 只跑 1 次（等于普通运行）；N = 一共跑 N 次（`loop_close` 的收尾条件是 `cur + 1 >= total`，
    cur 从 0 起，所以 rounds=2 → index 0/1 两轮）。
    ⚠️ 接了 timeplan 时以 `plan["total"]` 为准，面板「次数」框不生效（见 `_total_from`）。

    输入口是动态的 value1 / value2 / …，和 LoopStart 的输出口一一对应：
      · 每个口收什么 → 下一轮 LoopStart 同编号的 valueK 就输出什么（段间参考 / 尾帧钉入这类用法）。
      · 正向管线是「Start.valueK → 本轮某个节点的输入端 → 本轮产物 → End.valueK」，
        所以 valueK 常常一开始没接（值是 None），第一轮起就能接、也允许先空着。
    跑完总轮数就把**最后一轮**这些口收到的值原样从 out1..outN 吐出去（不是累积列表本身；
    要拿「每轮一项的累积列表」就把 End.valueK 接 EzFlex-MergeList 的输出，outK 自然就是那份完整列表）。

    ★ outK 只能在**循环体外**被消费：接到循环体里的节点上会成环（校验期 validate_inputs 就报
      "Dependency cycle detected"）。例如 TimeLine 的 video 口在循环体内（它吃 LoopStart.index），
      所以「LoopEnd.out1 → TimeLine.video」是**成环**的写法，正确写法是
      「LoopStart.value1 → TimeLine.video」（valueK 是上一轮的累积值，天然不绕回）。

    OUTPUT_NODE 必须为 True：否则「没往本节点的出口接东西」（例如只在 body 里放预览）时它根本不会被调度到，
    循环就只跑一轮 —— 内置循环把 LoopResult 标成 is_output_node 也是这个原因。
    """

    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(s):
        opt = {}
        # ★ timeplan 透传：接上游 TimePlan（或它下游任一透传口），原样从第一位的 `timeplan` 出口送出。
        #   为什么需要：TimeLine 现在只吃 `timeplan`，而它常在循环体外 —— 有这个口就能写
        #   「LoopEnd.timeplan → TimeLine.timeplan」，不必再从 SplitVideo 那种中途节点上取。
        #   EZFLEX_TIMEPLAN 不是 widget 类型 ⇒ 不生成 widget ⇒ 老工作流 widgets_values 不错位。
        opt["timeplan"] = ("EZFLEX_TIMEPLAN", {"tooltip": "Plan object to pass through to the `timeplan` output (e.g. from EzFlex-TimePlan)."})
        for k in range(1, _EZ_LOOP_MAX + 1):
            opt["value%d" % k] = ("*", {"tooltip": "Loop data %d. Whatever this port receives becomes the next round's LoopStart value%d (implicit feed, do not wire End back to Start)." % (k, k)})
        # 「次数」只是个可序列化的落点，面板画的是自绘数字框。★ 必须放 required：
        #   放 optional 会被当成一个可选输入口 + 不可序列化，值一存就丢。
        req = {"rounds": ("INT", {"default": 1, "min": 0,
                                  "tooltip": "Total rounds including the first one. 0 or 1 = a single pass (plain run); N = N passes total."}),
               "rerun_stop": ("STRING", {"default": "-1",
                                      "tooltip": "Internal: when >= 0, stop after this segment index (range re-run). Not a canvas port."})}
        # ★ __ezround：轮次标记。展开时写进克隆节点的字面量输入（不是画布连线，面板也不画口）。
        #   必须声明成 optional，否则 get_input_data 会把未知键整个丢掉、传不进 kwargs；
        #   前端 stripCoreSockets 会把这个口摘掉，用户看不到它。
        #   ★★ forceInput：**别让前端建 widget** —— INT 类型不写 forceInput 时前端会做一个数字框，
        #     否则前端会给 `__ezround` 建一个数字框挂在节点上。
        #     它也不需要序列化：第 1 轮没有这个键时 cur 就是 0（正确），之后每轮由展开器写字面量。
        opt["__ezround"] = ("INT", {"default": 0, "min": 0, "forceInput": True,
                                    "tooltip": "Internal round marker written by the loop expander. Not a canvas port."})
        # 用户级落盘：JSON {"ports":[1,2],"types":["latent","audio"]}；空 = 不落盘（默认）
        opt["persist"] = ("STRING", {"default": "", "multiline": False,
                                     "tooltip": "Internal: which value ports/types to cache for re-runs (JSON). Empty = no cache."})
        return {"required": req,
                "optional": opt,
                "hidden": {"dynprompt": "DYNPROMPT", "unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO",
                           "execution_list": "EXECUTION_LIST"}}

    # ★ `timeplan` 透传口放在第一位。内核按槽位下标回填连线（`outputs[i].links`），存有 out1 的
    #    工作流会把它读回第 0 槽，所以前端 `loop_nodes.js#ensurePlanPort` 在加载后把 `timeplan`
    #    口搬到第 0 位（搬 socket 对象，连线跟着走），再由 `reindexLinks` 重写 `origin_slot`。
    RETURN_TYPES = ("EZFLEX_TIMEPLAN",) + ("*",) * _EZ_LOOP_MAX
    RETURN_NAMES = ("timeplan",) + tuple("out%d" % k for k in range(1, _EZ_LOOP_MAX + 1))
    RETURN_TOOLTIPS = ("Pass-through of the incoming plan.",) + \
        tuple("Last round's value %d." % k for k in range(1, _EZ_LOOP_MAX + 1))
    FUNCTION = "loop_close"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Loop End"

    _FWD = "__ezfwd"   # 展开时写进克隆 End 的「配对 Start 节点 id」标记（不是画布连线）
    _ROUND = "__ezround"   # 展开时写进克隆 End 的「下一轮轮号」标记（不是画布连线）

    # ★★ INPUT_IS_LIST = True：让 valueK 能收到「**整个列表**」而不是被内核按项展开。
    #   为什么必须这样：内核 _async_map_node_over_list 对**没有** INPUT_IS_LIST 的节点做列表展开
    #   （execution.py:255-325：max_len_input 取各输入的最大长度，然后 for i in range(max_len) 逐项跑）。
    #   于是「把上一轮累积的列表接回 LoopEnd.value1」会变成「列表有几项就多跑几轮」——
    #   实测 rounds=3 + MergeList 累积：loop_open 被调用 **7 次**、回喂到的是**标量**、
    #   最终 out1 = 0（累积彻底失效，还会随列表变长组合爆炸）。
    #   置 True 后内核只跑一次、入参是原样值（list 保持 list），累积才成立。
    #   ⚠️ 代价：所有入参都会是 list 包装（字面量/hidden 是 [值]，连线取上游缓存 —— 普通口 [值]、
    #      list 口 [项1,项2…]），所以下面统一用 _unwrap 拆「单元素包装」。
    INPUT_IS_LIST = True

    @staticmethod
    def _unwrap(v):
        """拆掉内核的「单元素 list 包装」，但**保留真正的列表值**（累积就是靠它）。

        规则：只有「恰好 1 个元素、且那个元素自己不是 list/tuple」时才拆。
          · 普通标量 → 原值（回喂语义与旧版一致）；
          · 累积列表（≥2 项）→ 原样保留整份列表 ⇒ 累积成立；
          · 只有 1 项的累积列表 → 拆成那一项 —— 无害：MergeList 对「标量」是 append、对「1 项列表」
            是 extend，两种写法得到的列表完全一样，所以下一轮照样接着累积。
        """
        if isinstance(v, (list, tuple)) and len(v) == 1 and not isinstance(v[0], (list, tuple)):
            return v[0]
        return v

    # ── 队列续跑模式（V1.3.7）：End 自己往队列塞下一轮，不展开图 ────────────────
    @staticmethod
    def _queue_mode(dynprompt, start_id):
        """配对 LoopStart 的 config 里 `queue: true` ⇒ 走队列续跑。

        ⚠️ 模式存在 **Start 的 config** 里（不是 End）：End 没有 config 输入口，而给它新声明一个
        widget 会让老工作流的 `widgets_values` **位置配对整体错位**（面板自绘框 + rounds + __ezround
        三段，插进去一个就全串位），风险太大；Start 本来就有 config。
        """
        try:
            info = dynprompt.get_node(start_id) or {}
            raw = (info.get("inputs") or {}).get("config")
            cfg = json.loads(raw) if isinstance(raw, str) else (raw or {})
            return bool(isinstance(cfg, dict) and cfg.get("queue"))
        except Exception:
            return False

    @staticmethod
    def _wrap_literal(v):
        """写进下一个 prompt 的字面量：list/tuple 必须包 `{"__value__": [...]}`。

        内核 `validate_inputs`（execution.py:982-990）把「长度 ≠ 2 的 list」当成坏连线
        （`bad_linked_input`），只有 `{"__value__": …}` 会被解包并就地写回。前端序列化 list widget 同款。
        """
        if isinstance(v, (list, tuple)):
            return {"__value__": list(v)}
        return v

    def _ret(self, kwargs):
        """统一的返回值：**`timeplan` 透传口排第一位**，后面接 `out1..outN`（本轮 valueK）。

        ★ 顺序必须与 `RETURN_NAMES` 严格一致（`timeplan` 在**第一位**），
          任何 return 分支漏掉它都会让输出长度对不上类声明。
        """
        return (kwargs.get("timeplan"),) + tuple(kwargs.get("value%d" % k) for k in range(1, _EZ_LOOP_MAX + 1))

    def _queue_next_round(self, dynprompt, unique_id, start_id, cur, total, kwargs, extra_pnginfo):
        """把「下一轮」写进一份新 prompt 塞回队列，并返回本轮的值（下游照常拿到本轮结果）。

        与展开模式共用同一套回喂语义：值写成 LoopStart 的 `_ezfeedK` **字面量**、轮号写成
        `index` + LoopEnd 的 `__ezround`；区别只是这次是我们自己构造 prompt（不是内核展开器）。
        任何失败都退化成「只跑一轮」并打印原因 —— 绝不静默。
        """
        import uuid as _uuid
        values = tuple(kwargs.get("value%d" % k) for k in range(1, _EZ_LOOP_MAX + 1))
        try:
            from server import PromptServer
            server = getattr(PromptServer, "instance", None)
        except Exception:
            server = None
        if server is None or getattr(server, "prompt_queue", None) is None:
            print("[EzFlex-LoopEnd] queue mode: no PromptServer available (offline / headless) -> single pass.")
            return self._ret(kwargs)
        try:
            base = dynprompt.get_original_prompt() or {}
        except Exception:
            base = {}
        if not base:
            print("[EzFlex-LoopEnd] queue mode: cannot read the original prompt -> single pass.")
            return self._ret(kwargs)
        try:
            nxt = {}
            for nid, info in base.items():
                if not isinstance(info, dict):
                    nxt[nid] = info
                    continue
                node = {"class_type": info.get("class_type"), "inputs": dict(info.get("inputs") or {})}
                if "_meta" in info:
                    node["_meta"] = info["_meta"]
                if str(nid) == str(start_id):
                    node["inputs"]["index"] = int(cur) + 1
                    for k in range(1, _EZ_LOOP_MAX + 1):
                        v = values[k - 1]
                        if v is None:
                            continue      # 没接的口不写（与「不写 = None」等价，省得 prompt 变胖）
                        lit = self._wrap_literal(v)
                        if not _ez_json_ok(lit):
                            # 张量 / 含张量的 dict：落盘换标记，让 prompt 能被 /queue、/history 序列化。
                            _mark = _ez_handoff_save(v)
                            if _mark is not None:
                                lit = _mark
                            # 落盘失败就保持原值（执行仍然正确，只是那两个面板照旧报错）
                        node["inputs"][LoopStartNode._feed_name(k)] = lit
                elif str(nid) == str(unique_id):
                    node["inputs"][self._ROUND] = int(cur) + 1
                nxt[str(nid)] = node
            mod_nodes = _comfy_nodes
            if mod_nodes is None:
                try:
                    import nodes as mod_nodes
                except Exception:
                    mod_nodes = None
            if mod_nodes is None:
                print("[EzFlex-LoopEnd] queue mode: cannot import ComfyUI nodes -> single pass.")
                return self._ret(kwargs)
            outputs = [str(nid) for nid, info in base.items()
                       if isinstance(info, dict)
                       and getattr(mod_nodes.NODE_CLASS_MAPPINGS.get(info.get("class_type")), "OUTPUT_NODE", False) is True]
            if not outputs:
                print("[EzFlex-LoopEnd] queue mode: no output node in the prompt -> single pass.")
                return self._ret(kwargs)
            number = getattr(server, "number", 0)
            try:
                server.number = number + 1
            except Exception:
                pass
            # 进度归属：优先用这次 /prompt 请求带来的 client_id（PromptExecutor.extra_data），
            # 读不到就保持原行为（None = 广播给所有客户端），不影响已有流程。
            try:
                _ex = PromptServer.instance.prompt_executor
                _cid = (getattr(_ex, "extra_data", None) or {}).get("client_id")
            except Exception:
                _cid = None
            extra = {"client_id": _cid or getattr(server, "client_id", None)}
            if extra_pnginfo:
                extra["extra_pnginfo"] = extra_pnginfo
            server.prompt_queue.put((number, str(_uuid.uuid4()), nxt, extra, outputs, {}))
            print("[EzFlex-LoopEnd] queue mode: round %d/%d done -> enqueued round %d/%d"
                  % (int(cur) + 1, int(total), int(cur) + 2, int(total)))
        except Exception as e:
            print("[EzFlex-LoopEnd] queue mode: failed to enqueue the next round (%s: %s) -> single pass."
                  % (type(e).__name__, e))
        return self._ret(kwargs)

    @staticmethod
    def _total_from(rounds, cfg, timeplan=None):
        """总轮数：接上 `timeplan` 时用 `plan["total"]`（规划段数 = 需要的轮数）；

        否则依次读面板次数与 cfg 的 rounds / count / times，取第一个 > 0 的值。
        """
        if isinstance(timeplan, dict):
            try:
                n = int(timeplan.get("total") or 0)
            except (TypeError, ValueError):
                n = 0
            if n > 0:
                return n
        for v in (rounds, (cfg or {}).get("rounds"), (cfg or {}).get("count"), (cfg or {}).get("times")):
            try:
                n = int(v)
            except (TypeError, ValueError):
                continue
            if n > 0:
                return n
        return 0

    @classmethod
    def _find_start(cls, dynprompt, unique_id, node_id=None):
        """找配对的 EzFlex-LoopStart。展开时走 _FWD 标记（一个 prompt 里可以有多个循环）；
        没标记（第一次运行、老工作流）就按「首轮展开时记录的门牌号」找，最后回落到「唯一一个 Start」。

        为什么不能沿用旧的「flow 端口的 rawLink」：新设计里 Start 与 End 之间没有画布连线
        （连线会成环，见 LoopStartNode docstring），rawLink 那条路不存在了。
        """
        if dynprompt is None:
            return None
        ids = []
        if node_id is not None:
            ids.append(node_id)
        if unique_id is not None and unique_id != node_id:
            ids.append(unique_id)
        for nid in ids:
            try:
                info = dynprompt.get_node(nid)
            except Exception:
                info = None
            if not info:
                continue
            src = (info.get("inputs") or {}).get(cls._FWD)
            if src is None or isinstance(src, (list, tuple, dict)):
                continue
            try:
                cand = dynprompt.get_node(str(src))
            except Exception:
                cand = None
            if cand and cand.get("class_type") == "EzFlex-LoopStart":
                return str(src)
        try:
            prompt = dynprompt.get_original_prompt() or {}
        except Exception:
            prompt = {}
        found = [str(k) for k, v in prompt.items()
                 if isinstance(v, dict) and v.get("class_type") == "EzFlex-LoopStart"]
        return found[0] if len(found) == 1 else None

    @staticmethod
    def _display(dynprompt, node_id):
        """把任意节点 id（原始 id / 带前缀的克隆 id）归一成「显示 id」（画布上那个门牌号）。

        展开出来的克隆节点是 ephemeral：id 带 `.N.M.` 前缀，但 display_id 指向原始 id。
        归一之后才能用同一套键比较「这个节点属于哪个循环体」—— 否则第 2 轮开始
        克隆节点（"P.1"）和原始 id（"1"）对不上，循环体会整段丢失。
        """
        try:
            return str(dynprompt.get_display_node_id(str(node_id)))
        except Exception:
            return str(node_id)

    @classmethod
    def _body_of(cls, dynprompt, start_id, end_id):
        """从显示图算出「Start 与 End 之间」的循环体门牌号集合 + 每个节点的显示 id 表。

        和内核 comfy_execution/validation.py 的 `_walk_graph` 同一套语义：
        从 Start 顺流而下（下游 = 谁的输入引用了本节点），走到 End 就停、不穿过 End。
        返回 (body_set, display_of)，两者都用「显示 id」。
        """
        try:
            prompt = dynprompt.get_original_prompt() or {}
        except Exception:
            prompt = {}
        display_of = {}
        children = {}
        for nid, info in prompt.items():
            if not isinstance(info, dict):
                continue
            did = cls._display(dynprompt, nid)
            display_of[str(nid)] = did
            children.setdefault(did, set())
        # 只要显示图里存在的节点；连线的目标同样归一到显示 id
        for nid, info in prompt.items():
            did = cls._display(dynprompt, nid)
            for v in (info.get("inputs") or {}).values():
                if is_link(v):
                    src = cls._display(dynprompt, v[0])
                    children.setdefault(src, set()).add(did)
        # BFS：Start 的下游，遇 End 停下（End 本身不算 body）
        body = set()
        seen = {str(start_id)}
        stack = list(children.get(str(start_id), ()))
        while stack:
            nid = stack.pop()
            if nid == str(end_id) or nid in seen:
                continue
            seen.add(nid)
            body.add(nid)
            stack.extend(children.get(nid, ()))
        return body, display_of

    def loop_close(self, rounds=0, dynprompt=None, unique_id=None, execution_list=None, **kwargs):
        # ★ INPUT_IS_LIST=True ⇒ 入参一律被内核装进 list（见 _unwrap 注释）：先把包装拆掉，
        #   否则 rounds 会是 [3]、dynprompt 会是 [dynprompt]，后面 int()/get_node() 全崩。
        rounds = self._unwrap(rounds)
        dynprompt = self._unwrap(dynprompt)
        unique_id = self._unwrap(unique_id)
        execution_list = self._unwrap(execution_list)
        kwargs[self._ROUND] = self._unwrap(kwargs.get(self._ROUND))
        kwargs["config"] = self._unwrap(kwargs.get("config"))
        kwargs["timeplan"] = self._unwrap(kwargs.get("timeplan"))
        kwargs["persist"] = self._unwrap(kwargs.get("persist"))
        # 队列续跑要带着 extra_pnginfo（PreviewAny 靠它读端口标签，丢了预览面板会空）
        extra_pnginfo = self._unwrap(kwargs.get("extra_pnginfo"))
        for _k in range(1, _EZ_LOOP_MAX + 1):
            _nk = "value%d" % _k
            if _nk in kwargs:
                kwargs[_nk] = self._unwrap(kwargs[_nk])
        try:
            raw = kwargs.get("config")
            cfg = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except Exception:
            cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}
        # ★ 当前轮次从「展开时写进克隆节点的 __ezround」读。
        #   绝对不要去读 kwargs["index"] —— LoopEnd 没有 index 输入口（那是 LoopStart 的），
        #   早先的版本就是靠它取轮次，结果永远读到 None → cur 恒为 0 → cur+1>=total 永不成立
        #   → 无限展开，表现就是「LoopEnd 一直跑停不下来」。这是本条最关键的修复点。
        cur = 0
        for src in (kwargs.get(self._ROUND), cfg.get("round"), cfg.get("rounds_done")):
            try:
                if src is not None and src != "":
                    cur = max(0, int(src))
                    break
            except (TypeError, ValueError):
                continue
        total = self._total_from(rounds, cfg, kwargs.get("timeplan"))
        try:
            rerun_stop = int(self._unwrap(kwargs.get("rerun_stop", -1)) if kwargs.get("rerun_stop") is not None else -1)
        except (TypeError, ValueError):
            rerun_stop = -1
        # 段缓存：把本轮 valueK（AV latent 等）落到 run 目录，供「区间重跑」当上一段 handoff。
        try:
            _tp = kwargs.get("timeplan") if isinstance(kwargs.get("timeplan"), dict) else {}
            _rd = str(_tp.get("ezRunDir") or "").strip()
            if _rd and os.path.isdir(_rd):
                # ★ 按**类型**缓存，不再写死 value2：
                #   · latent dict（samples / audio_latent）→ 存小 .pt，重跑时原样读回
                #   · IMAGE 张量 → 不存数据，只记类型，重跑时从 seg_K.mp4 解码
                #   · AUDIO dict → 不存数据，只记类型，重跑时从 seg_K.wav 读
                #   · 列表/累积值（如 v1）→ 不缓存（又大又不参与条件）
                try:
                    _pv = json.loads(kwargs.get("persist") or "{}")
                except Exception:
                    _pv = {}
                if not isinstance(_pv, dict):
                    _pv = {}
                try:
                    _pp = {int(x) for x in (_pv.get("ports") or [])}
                except Exception:
                    _pp = set()
                try:
                    _pt = {str(x) for x in (_pv.get("types") or [])}
                except Exception:
                    _pt = set()
                _meta = {}
                _names = _pv.get("names") if isinstance(_pv.get("names"), dict) else {}
                _used = set()
                for _k in range(1, _EZ_LOOP_MAX + 1):
                    _vv = kwargs.get("value%d" % _k)
                    if _vv is None:
                        continue
                    if isinstance(_vv, dict) and ("samples" in _vv or "audio_latent" in _vv):
                        _typ = "latent"
                    elif isinstance(_vv, torch.Tensor) and int(getattr(_vv, "ndim", 0)) == 4:
                        _typ = "image"
                    elif isinstance(_vv, dict) and "waveform" in _vv:
                        _typ = "audio"
                    elif hasattr(_vv, "get_stream_source") or hasattr(_vv, "save_to"):
                        _typ = "video"
                    elif isinstance(_vv, torch.Tensor) and int(getattr(_vv, "ndim", 0)) == 3:
                        _typ = "mask"
                    elif isinstance(_vv, torch.Tensor):
                        _typ = "tensor"
                    elif isinstance(_vv, list) and _vv and isinstance(_vv[0], (list, tuple)) and len(_vv[0]) >= 2:
                        _typ = "conditioning"
                    else:
                        _typ = "other"
                    if _pt and _typ not in _pt:
                        continue
                    # 媒体类型只记类型字符串，成本极低 ⇒ 即使没勾选也记，供重跑恢复上一段视频/音频
                    if _pp and _k not in _pp and _typ not in ("image", "audio", "video"):
                        continue
                    if _typ in ("latent", "mask", "tensor", "conditioning") and not (_pp or _pt):
                        continue
                    if _typ in ("latent", "mask", "tensor"):
                        _nm = str(_names.get(str(_k)) or ("v%d" % _k)).strip()
                        _nm = re.sub(r"[^0-9A-Za-z_.\-\u4e00-\u9fff]+", "_", _nm).strip(" ._-")[:48] or ("v%d" % _k)
                        if _nm in _used:
                            _nm = (_nm[:40] + "_v%d" % _k)
                        _used.add(_nm)
                        _fn = "seg_%04d_%s.pt" % (int(cur), _nm)
                        try:
                            torch.save(_vv, os.path.join(_rd, _fn))
                            _meta.setdefault("files", {})[str(_k)] = _fn
                            _ezsp_ver_attach_latent(_rd, "seg_%04d" % int(cur), os.path.join(_rd, _fn), _fn, int(_k))
                        except Exception:
                            pass
                    elif _typ in ("image", "audio", "conditioning", "video"):
                        _meta[str(_k)] = _typ
                _cards = _pv.get("cards") if isinstance(_pv.get("cards"), dict) else {}
                for _ck, _card in _cards.items():
                    if not isinstance(_card, dict) or not _card.get("enabled"):
                        continue
                    try:
                        _k = int(_ck)
                    except (TypeError, ValueError):
                        continue
                    _vv = kwargs.get("value%d" % _k)
                    if _vv is None:
                        continue
                    _fn, _styp = _ezsp_save_persist_value(
                        _rd, cur, _k, _card.get("name") or "", _card.get("type"),
                        _vv, _card.get("range") or "-5", (_tp.get("fps") or 24))
                    if _fn:
                        _meta[str(_k)] = _styp
                        _meta.setdefault("files", {})[str(_k)] = _fn
                if _meta:
                    try:
                        with _io.open(os.path.join(_rd, "seg_%04d.media.json" % int(cur)), "w", encoding="utf-8") as _f:
                            json.dump(_meta, _f)
                    except Exception:
                        pass
        except Exception:
            pass
        if rerun_stop >= 0 and cur >= rerun_stop:
            return self._ret(kwargs)     # 区间重跑：跑到目标段就停，不再入队下一轮
        if total <= 0:
            print("[EzFlex-LoopEnd] rounds is 0: running a single pass without looping. "
                  "Wire EzFlex-TimePlan.timeplan here (auto) or set the panel round counter to 1+.")
            return self._ret(kwargs)
        if cur + 1 >= total:
            return self._ret(kwargs)
        if cur >= _EZ_LOOP_SAFE_MAX:
            # 兜底熔断：任何意外（旧工作流里 rounds 特别大 / 轮次标记丢失）都不该让画布卡死。
            print("[EzFlex-LoopEnd] safety cap %d reached: stopping the loop early. "
                  "Check the panel round counter and whether LoopStart is still on the canvas."
                  % _EZ_LOOP_SAFE_MAX)
            return self._ret(kwargs)
        if dynprompt is None or not unique_id:
            return self._ret(kwargs)
        fwd = None
        try:
            info = dynprompt.get_node(unique_id)
            v = (info.get("inputs") or {}).get(self._FWD) if info else None
            if v is not None and not isinstance(v, (list, tuple, dict)):
                fwd = str(v)
        except Exception:
            fwd = None
        open_node = self._find_start(dynprompt, unique_id, fwd)
        if not open_node:
            # 找不到配对 Start 时不要静默只跑一轮（最难查的症状）：报清楚，但别把整个执行炸掉
            print("[EzFlex-LoopEnd] cannot find the paired EzFlex-LoopStart; running a single pass. "
                  "Add an EzFlex-LoopStart node and re-queue so the loop can be expanded.")
            return self._ret(kwargs)
        if fwd is None:
            fwd = open_node   # 首次展开时把门牌号记下，下一轮的克隆 End 靠它定位（见 _find_start）
        # ★★★ 队列续跑模式（V1.3.7）：配对 Start 的 config 里 `queue: true` 时**不展开图**，
        #     而是把「本轮各 valueK 收到的值 + 下一轮轮号」写进一份**新的 prompt** 塞回队列，
        #     等于「自己再点一次运行」。图不膨胀、每轮之间可停；代价是每轮独立执行（缓存复用≈0）
        #     且面板看不到跨轮累积（`execution_start` 每轮清空 PreviewAny 的 entries）。
        #     ⚠️ 与展开模式共用同一套回喂语义：值写进 LoopStart 的 `_ezfeedK` 字面量，只是这次
        #        是我们自己构造 prompt（不是内核展开器）。见 docs/Loop_队列式循环设计分析.md §九。
        if self._queue_mode(dynprompt, open_node):
            return self._queue_next_round(dynprompt, unique_id, open_node, cur, total, kwargs, extra_pnginfo)
        # ★★ 循环体一律按「显示图」算：Start 的显示 id / End 的显示 id 都归一到画布门牌号。
        #    取 body 前必须先用 _display() 把 unique_id 映射成显示 id：克隆体在 dynprompt 里的键是
        #    "P.1"/"P.3"，而 unique_id 第 2 轮起是带前缀的 "P.Recurse"，直接比较会得到空 body，
        #    除 Start/End 外整段 body 丢失（表现是 out1 永远停在第一轮）。
        start_did = self._display(dynprompt, open_node)
        end_did = self._display(dynprompt, unique_id)
        body, _display_of = self._body_of(dynprompt, start_did, end_did)

        # 需要克隆的显示 id：循环体 + Start + End 自己（End 克隆成 "Recurse"）
        wanted = set(body)
        wanted.add(start_did)
        wanted.add(end_did)

        # 原始图里「显示 id → 真实节点 id」的映射（同一个显示 id 只取一个源即可）
        src_of = {}
        try:
            prompts = dynprompt.get_original_prompt() or {}
        except Exception:
            prompts = {}
        for nid, info in prompts.items():
            if not isinstance(info, dict) or "inputs" not in info:
                continue
            did = self._display(dynprompt, nid)
            src_of.setdefault(did, str(nid))

        graph = GraphBuilder()
        # ① 建节点：End → "Recurse"（保持内核递归展开的既定命名），其余用显示 id
        built = {}
        for did in sorted(wanted):
            nid = src_of.get(did)
            if nid is None:
                continue   # 画布上找不到对应节点（例如刚删掉）：跳过，别造空壳
            info = dynprompt.get_node(nid)
            if not info:
                continue
            key = "Recurse" if did == end_did else did
            node = graph.node(info["class_type"], key)
            node.set_override_display_id(nid)   # ★ display 指回原始门牌号（内核靠它回溯）
            built[did] = node

        # ② 连边：引用「本轮要克隆的显示 id」→ 改指克隆；其余原样保留
        for did, node in built.items():
            nid = src_of.get(did)
            info = dynprompt.get_node(nid) or {}
            for k, v in (info.get("inputs") or {}).items():
                if str(k) == self._FWD or str(k) == self._ROUND:
                    continue   # 配对门牌号 / 轮号是幂等元数据，下面统一写一次
                if is_link(v):
                    src_did = self._display(dynprompt, v[0])
                    tgt = built.get(src_did)
                    # 引用循环体 / Start 的线 → 接本轮克隆；引用体外的线 → 保留原线（外部依赖不重造）
                    node.set_input(k, tgt.out(v[1]) if tgt is not None else v)
                else:
                    node.set_input(k, v)

        # ③ 下一轮 Start：index +1，并把上一轮 End 收到的 valueK 作为回喂字面量写进去
        new_open = built.get(start_did)
        if new_open is not None:
            new_open.set_input("index", cur + 1)
            # ★ 回喂：上一轮 End 每个输入口收到的值，原样写进下一轮 Start 同编号口（字面量，不是连线）
            for k in range(1, _EZ_LOOP_MAX + 1):
                # list/tuple 必须包一层 __value__：内核把「长度 2 的 [str, int]」当成节点连线，
                # 裸写会静默丢值（找不到上游 → mark_missing → 回落到初值）。队列模式用的是同一个包装。
                new_open.set_input(LoopStartNode._feed_name(k), self._wrap_literal(kwargs.get("value%d" % k)))

        # ④ 下一轮 End：带上配对门牌号 + 轮次标记（否则下一轮读不到第几轮 → 无限展开）
        my_clone = built.get(end_did)
        if my_clone is not None:
            my_clone.set_input(self._FWD, fwd)
            my_clone.set_input(self._ROUND, cur + 1)
        return {"result": tuple(my_clone.out(i) for i in range(_EZ_LOOP_MAX + 1)) if my_clone is not None
                          else (kwargs.get("timeplan"),) + tuple(kwargs.get("value%d" % k) for k in range(1, _EZ_LOOP_MAX + 1)),
                "expand": graph.finalize()}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")   # 每次提交都重新展开（否则重跑同一份工作流会命中缓存、整个循环被跳过）
# 节点：把 VIDEO 拆成 images / audio / fps / 位深 / 分辨率等。
class VideoComponentsNode:
    """EzFlex-VideoComponents：把一段 VIDEO 拆成可继续接线的元素。"""

    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"video": ("VIDEO", {"forceInput": True,
            "tooltip": "Video to inspect (SplitVideo video output / MediaLoader / built-in Load Video)."})}}

    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "INT", "STRING", "INT", "FLOAT", "INT", "INT")
    RETURN_NAMES = ("images", "audio", "fps", "bit_depth", "color_space", "frame_count", "duration", "width", "height")
    RETURN_TOOLTIPS = ("All decoded frames (IMAGE batch).", "Audio track (None when absent).", "Average frame rate.",
                       "Bits per channel when known.", "Color space/pixel format when known.",
                       "Decoded frame count.", "Duration in seconds.", "Pixel width.", "Pixel height.")
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Get Video Components"

    @staticmethod
    def _probe(video):
        meta = {"width": 0, "height": 0, "frames": 0, "fps": 0.0, "duration": 0.0, "bit_depth": 8, "color_space": ""}
        try:
            path = video.get_stream_source() if hasattr(video, "get_stream_source") else ""
            if not path:
                return meta
            import av
            with av.open(path) as c:
                vs = next((s for s in c.streams if s.type == "video"), None)
                if vs is None:
                    return meta
                cc = vs.codec_context
                meta["width"] = int(getattr(cc, "width", 0) or 0)
                meta["height"] = int(getattr(cc, "height", 0) or 0)
                meta["frames"] = int(getattr(vs, "frames", 0) or 0)
                try:
                    meta["fps"] = float(vs.average_rate or vs.base_rate or 0)
                except Exception:
                    meta["fps"] = 0.0
                try:
                    meta["duration"] = float(vs.duration * vs.time_base) if vs.duration else 0.0
                except Exception:
                    meta["duration"] = 0.0
                try:
                    bd = int(getattr(cc, "bits_per_raw_sample", 0) or 0)
                    if not bd and getattr(cc, "format", None) is not None:
                        bd = int(getattr(cc.format, "bits_per_raw_sample", 0) or 0)
                    if bd:
                        meta["bit_depth"] = bd
                except Exception:
                    pass
                try:
                    meta["color_space"] = str(getattr(cc, "colorspace", "") or getattr(cc, "name", "") or "")
                except Exception:
                    pass
        except Exception:
            pass
        return meta

    def run(self, video=None):
        if video is None:
            return (None, None, 24.0, 8, "", 0, 0.0, 0, 0)
        images = None
        audio = None
        fps = 0.0
        frames = 0
        meta = self._probe(video)
        # 内置 Get Video Components 用的是 VIDEO 对象自己的元数据；对象有就优先用它。
        # 尤其 color_space：PyAV 的 `cc.colorspace` 是枚举数字，直接用会输出 "9"/"1"，对不上内置的 "sRGB"/"HDR"。
        try:
            if hasattr(video, "get_bit_depth"):
                _bd = int(video.get_bit_depth() or 0)
                if _bd:
                    meta["bit_depth"] = _bd
        except Exception:
            pass
        try:
            if hasattr(video, "get_color_space"):
                _cs = str(video.get_color_space() or "")
                if _cs:
                    meta["color_space"] = _cs
        except Exception:
            pass
        try:
            comp = video.get_components() if hasattr(video, "get_components") else None
            images = getattr(comp, "images", None) if comp is not None else None
            audio = getattr(comp, "audio", None) if comp is not None else None
            fr = getattr(comp, "frame_rate", None) if comp is not None else None
            if fr:
                fps = float(fr)
        except Exception:
            images = None
            audio = None
        if isinstance(images, (list, tuple)):
            try:
                images = torch.stack([x for x in images if isinstance(x, torch.Tensor)], dim=0)
            except Exception:
                images = None
        if isinstance(images, torch.Tensor):
            if images.ndim == 3:
                images = images.unsqueeze(0)
            if images.ndim != 4:
                images = None
        if images is not None and int(images.shape[0]) == 0:
            images = None
        try:
            frames = int(images.shape[0]) if images is not None else 0
        except Exception:
            frames = 0
        if not fps:
            fps = float(meta.get("fps") or 24.0)
        fps = max(1e-6, float(fps))
        if not frames:
            frames = int(meta.get("frames") or 0)
        width = int(images.shape[2]) if images is not None and images.ndim == 4 else int(meta.get("width") or 0)
        height = int(images.shape[1]) if images is not None and images.ndim == 4 else int(meta.get("height") or 0)
        duration = float(meta.get("duration") or 0.0) or (float(frames) / fps if fps > 0 else 0.0)
        if isinstance(audio, (tuple, list)) and len(audio) >= 2:
            audio = {"waveform": audio[0], "sample_rate": audio[1]}
        if not isinstance(audio, dict):
            audio = None
        else:
            try:
                wf = audio.get("waveform")
                if wf is None or int(wf.shape[-1]) <= 0:
                    audio = None
            except Exception:
                audio = None
        return (images, audio, float(fps), int(meta.get("bit_depth") or 8), str(meta.get("color_space") or ""),
                int(frames), float(duration), int(width), int(height))
_EZ_PREP_MAX = 64          # 声明多少个 image_i 口（前端按「所有卡片输入口总数」裁；一张卡可能多输入）
_PREP_PARAM_DESC = {
    "resolution": "预处理分辨率：先把图缩到这个短边再算，再放大回原尺寸。越大越清晰也越慢（常用 512）。",
    "safe": "安全模式：分块处理，省显存但更慢（图大或爆显存时开）。",
    "coarse": "粗粒度：enable = 线条更少更概括，disable = 保留更多细节。",
    "low_threshold": "Canny 低阈值：越小抓到的边缘越多（也越容易有噪点）。",
    "high_threshold": "Canny 高阈值：越大越只保留强边缘。低:高 常用 100:200 或 50:150。",
    "bin_threshold": "二值化阈值：灰度高于它的算白、低于算黑，决定线条多少。",
    "merge_with_lineart": "把 AnyLine 的结果和 lineart 结果合并（取并集）。",
    "lineart_lower_bound": "线稿灰度下界：比它更暗的像素才算线。",
    "lineart_upper_bound": "线稿灰度上界：比它更亮的像素才算线。",
    "object_min_size": "过滤掉小于这个尺寸的连通块（去噪点）。",
    "object_connectivity": "连通性：4 = 只算上下左右相邻，8 = 斜角也算。",
    "environment": "场景类型：indoor 室内 / outdoor 室外（影响深度先验）。",
    "ckpt_name": "用哪个模型权重文件。首次使用会自动下载。",
    "model": "用哪个模型文件。首次使用会自动下载。",
    "cmap": "DensePose 的配色方案（只影响观感）。",
    "patch_batch_size": "分块批大小：越大越快越吃显存。",
    "fov": "相机视场角（度）：影响法线估计的透视假设。",
    "iterations": "迭代次数：越大越精细也越慢。",
    "detect_hand": "是否检测手部关键点。",
    "detect_body": "是否检测身体关键点。",
    "detect_face": "是否检测面部关键点。",
    "bbox_detector": "人体检测器模型（先框出人，再估姿态）。",
    "pose_estimator": "姿态估计模型。",
    "scale_stick_for_xinsr_cn": "加粗骨架线条：给 xinsr 系 ControlNet 用时开。",
    "rm_nearest": "去掉离相机最近的若干深度层（前景干扰）。",
    "rm_background": "去掉背景（远处）深度层。",
    "boost": "enable = 用 LeReS++，细节更好但更慢。",
    "a": "深度曲率参数：越大深度越平缓。",
    "bg_threshold": "背景阈值：把背景从法线图里剔除。",
    "backbone": "主干网络规格：越大越准越慢。",
    "fx": "相机内参焦距 fx（像素）：不填按图宽估。",
    "fy": "相机内参焦距 fy（像素）：不填按图高估。",
    "mask_bbox_padding": "手部框向外扩多少像素（让掩码多包一点）。",
    "mask_type": "掩码类型：决定手部区域怎么生成。",
    "mask_expand": "掩码再膨胀多少像素。",
    "rand_seed": "随机种子（换一个结果会变）。",
    "detect_thr": "手部检测阈值：越高越保守（漏检多）。",
    "presence_thr": "手存在置信度阈值。",
    "bbox_threshold": "人体框检测阈值：越高越保守。",
    "bbox_dilation": "人体框膨胀量（留点边）。",
    "bbox_crop_factor": "按人体框裁剪时外扩的倍数。",
    "drop_size": "小于这个尺寸的框直接丢掉。",
    "max_faces": "最多检测几张脸。",
    "min_confidence": "人脸检测置信度下限。",
    "remove_background_using_abg": "enable = 顺带把背景抠掉。",
    "gamma_correction": "伽马校正：调亮/调暗再提取亮度结构。",
    "pyrUp_iters": "金字塔上采样次数：越大 tile 纹理越粗。",
    "scale_factor": "缩放系数：决定 tile 的细节尺度。",
    "blur_strength": "导向滤波强度：越大越平滑。",
    "radius": "导向滤波半径。",
    "eps": "导向滤波的数值稳定项（很小，一般不用动）。",
    "score_threshold": "直线检测分数阈值：越高只留越明显的直线。",
    "dist_threshold": "直线合并的距离阈值。",
    "threshold": "XDoG 阈值：控制线条浓淡。",
    "guassian_sigma": "高斯模糊 sigma：越大线条越粗越糊。",
    "intensity_threshold": "强度阈值：决定哪些梯度算成线。",
    "safe_steps": "TEED 安全步数：越大越稳（也越慢）。",
    "seed": "随机种子：换一个结果会变。",
}
_PREP_PARAM_ZH = {
    "resolution": "分辨率",
    "safe": "安全模式",
    "coarse": "粗粒度",
    "low_threshold": "低阈值",
    "high_threshold": "高阈值",
    "bin_threshold": "二值化阈值",
    "merge_with_lineart": "合并线稿",
    "lineart_lower_bound": "线稿灰度下界",
    "lineart_upper_bound": "线稿灰度上界",
    "object_min_size": "最小连通块",
    "object_connectivity": "连通性",
    "environment": "场景",
    "ckpt_name": "模型权重",
    "model": "模型",
    "cmap": "配色方案",
    "patch_batch_size": "分块批大小",
    "fov": "视场角",
    "iterations": "迭代次数",
    "detect_hand": "检测手",
    "detect_body": "检测身体",
    "detect_face": "检测脸",
    "bbox_detector": "人体检测器",
    "pose_estimator": "姿态模型",
    "scale_stick_for_xinsr_cn": "加粗骨架(xinsr)",
    "rm_nearest": "去掉近景",
    "rm_background": "去掉背景",
    "boost": "细节增强",
    "a": "深度曲率",
    "bg_threshold": "背景阈值",
    "backbone": "主干规格",
    "fx": "内参 fx",
    "fy": "内参 fy",
    "mask_bbox_padding": "手框外扩",
    "mask_type": "掩码类型",
    "mask_expand": "掩码膨胀",
    "rand_seed": "随机种子",
    "detect_thr": "手部检测阈值",
    "presence_thr": "手存在阈值",
    "bbox_threshold": "人体框阈值",
    "bbox_dilation": "人体框膨胀",
    "bbox_crop_factor": "人体框外扩倍数",
    "drop_size": "最小框尺寸",
    "max_faces": "最多人脸数",
    "min_confidence": "人脸置信度下限",
    "remove_background_using_abg": "抠背景",
    "gamma_correction": "伽马校正",
    "pyrUp_iters": "金字塔上采样",
    "scale_factor": "缩放系数",
    "blur_strength": "导向滤波强度",
    "radius": "滤波半径",
    "eps": "滤波稳定项",
    "score_threshold": "直线分数阈值",
    "dist_threshold": "直线合并距离",
    "threshold": "阈值",
    "guassian_sigma": "高斯 sigma",
    "intensity_threshold": "强度阈值",
    "safe_steps": "安全步数",
    "seed": "随机种子",
    "preprocessor": "预处理器",
}
def _prep_source():
    """(类映射, 显示名映射) —— 来自 comfyui_controlnet_aux。

    ⚠️ 本节点**依赖那个插件**：没装 ⇒ 两个空表，目录为空、卡片会提示去装（README 里已写明）。
    """
    try:
        import nodes as _nodes
        return ((getattr(_nodes, "NODE_CLASS_MAPPINGS", {}) or {}),
                (getattr(_nodes, "NODE_DISPLAY_NAME_MAPPINGS", {}) or {}))
    except Exception:
        return ({}, {})
def _prep_cls_of(key):
    """按 key 拿预处理器类。没装 comfyui_controlnet_aux / key 不存在 / 不是 ControlNet 预处理器 ⇒ None。"""
    if not key:
        return None
    try:
        mapping, _disp = _prep_source()
        cls = mapping.get(str(key))
        if cls is None:
            return None
        if not str(getattr(cls, "CATEGORY", "") or "").startswith("ControlNet Preprocessors"):
            return None
        return cls
    except Exception:
        return None
def _prep_disp_name(key):
    try:
        _mapping, disp = _prep_source()
        return str(disp.get(str(key)) or key or "")
    except Exception:
        return str(key or "")
_PREP_PARAM_TYPES = ("INT", "FLOAT", "BOOLEAN", "STRING")
def _prep_port_type(spec):
    """spec 是「张量端口」⇒ 返回类型字符串；是「参数」⇒ None。"""
    if not isinstance(spec, (list, tuple)) or not spec:
        return None
    typ = spec[0]
    if isinstance(typ, (list, tuple)):
        return None                      # COMBO（选项列表）⇒ 参数
    ts = str(typ)
    return None if ts in _PREP_PARAM_TYPES else ts
def _prep_param_of(name, spec, meta):
    """单个参数的 schema（老 _prep_param_schema 的那段逻辑）。"""
    typ = spec[0]
    if isinstance(typ, (list, tuple)):
        opts = [str(x) for x in typ]
        return {"name": str(name), "type": "COMBO", "options": opts,
                "default": meta.get("default", opts[0] if opts else "")}
    if str(typ) in ("INT", "FLOAT"):
        p = {"name": str(name), "type": str(typ), "default": meta.get("default", 0)}
        for k in ("min", "max", "step"):
            if k in meta:
                p[k] = meta[k]
        return p
    if str(typ) in ("BOOLEAN", "STRING"):
        return {"name": str(name), "type": str(typ), "default": meta.get("default")}
    return None
def _prep_param_schema(cls):
    """该预处理器的**可调参数**列表（不含输入/输出端口）。取不到 ⇒ []。"""
    try:
        it = cls.INPUT_TYPES() or {}
    except Exception:
        return []
    params = []
    for section in ("required", "optional"):
        for name, spec in (it.get(section) or {}).items():
            if _prep_port_type(spec) is not None:
                continue                 # 是端口，不是参数
            if not isinstance(spec, (list, tuple)) or not spec:
                continue
            meta = spec[1] if (len(spec) > 1 and isinstance(spec[1], dict)) else {}
            p = _prep_param_of(name, spec, meta)
            if p:
                params.append(p)
    for _p in params:
        _p["desc"] = _PREP_PARAM_DESC.get(_p["name"], "")
        _p["labelZh"] = _PREP_PARAM_ZH.get(_p["name"], "")
    return params
def _prep_input_ports(cls):
    """该预处理器的**输入端口** [{name,type}]（顺序 = INPUT_TYPES 声明顺序）。"""
    try:
        it = cls.INPUT_TYPES() or {}
    except Exception:
        return []
    out = []
    for section in ("required", "optional"):
        for name, spec in (it.get(section) or {}).items():
            ts = _prep_port_type(spec)
            if ts is not None:
                out.append({"name": str(name), "type": ts})
    return out
def _prep_output_ports(cls):
    """该预处理器的输出端口 [{name,type}]（含第二输出）。"""
    rt = getattr(cls, "RETURN_TYPES", None) or ()
    rn = getattr(cls, "RETURN_NAMES", None) or ()
    out = []
    for i, t in enumerate(rt):
        nm = str(rn[i]) if i < len(rn) else str(t)
        out.append({"name": nm, "type": str(t)})
    return out
def _prep_out_name(key):
    """该预处理器在**原插件**里的第一个输出口名（卡片模型只暴露第一个输出）。

    原插件多数没写 `RETURN_NAMES` ⇒ ComfyUI 拿 `RETURN_TYPES` 顶 ⇒ `"IMAGE"`；
    AnyLineArt 那种写了名字的就是 `"image"`。前端拿它当出口后缀。
    """
    try:
        cls = _prep_cls_of(key)
        if cls is None:
            return ""
        rn = getattr(cls, "RETURN_NAMES", None)
        if rn:
            return str(rn[0])
        rt = getattr(cls, "RETURN_TYPES", None) or ()
        return str(rt[0]) if rt else ""
    except Exception:
        return ""
def _prep_card_label(c, i):
    """卡片的显示名：自定义名 > 预处理器显示名 > Card N。"""
    nm = str((c or {}).get("name") or "").strip()
    if nm:
        return nm
    return _prep_disp_name((c or {}).get("cls")) or ("Card %d" % (i + 1))
def _prep_card_names(cards):
    """所有卡片的**输出口名**（扁平；每张卡按它自己的输出口数展开），给类 RETURN_NAMES 用。"""
    out = []
    for i, c in enumerate(cards or []):
        c = c if isinstance(c, dict) else {}
        base = _prep_card_label(c, i)
        cls = _prep_cls_of(c.get("cls"))
        ports = _prep_output_ports(cls) if cls is not None else [{"name": "image"}]
        for p in ports:
            out.append(base + "_" + str(p["name"]).lower())
    return out
# 节点：卡片式预处理器：运行期调用 controlnet_aux 的原节点，端口按卡片展开。
class ControlnetPreprocessorNode:
    """EzFlex-ControlnetPreprocessor：卡片列表式预处理器（数据来自 comfyui_controlnet_aux）。

    一张卡 = 一个预处理器实例，输入口按该预处理器的输入端口展开，输出口按它的**全部输出**展开
    （IMAGE / MASK / POSE_KEYPOINT / OPTICAL_FLOW 等都会出）；端口类型统一为 `*`，运行期调
    原预处理器的 FUNCTION，算法与 comfyui_controlnet_aux 一致。卡片参数存 config（随工作流序列化）。
    收录全部预处理器（含 Inpaint / Unimatch / MaskOptFlow / Pose Keypoint Postprocess 这类
    多输入或首输出非 IMAGE 的），每张卡按它的真实端口展开。
    """

    @classmethod
    def INPUT_TYPES(s):
        opt = {}
        for k in range(1, _EZ_PREP_MAX + 1):
            opt["image_%d" % k] = ("*", {"tooltip": "Card %d's input image." % k})
        return {
            "required": {
                "config": ("STRING", {"multiline": True, "default": "{}",
                                      "tooltip": "Preprocessor panel state: one card per preprocessor (class key + custom name + parameters). Kept as a serialisable widget so it survives save / load."}),
            },
            "optional": opt,
        }

    RETURN_TYPES = _DynamicOutputTypes()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "EzFlex"
    DESCRIPTION = "Preprocessor"

    def run(self, config="{}", **kwargs):
        cfg = {}
        try:
            cfg = json.loads(config) if isinstance(config, str) else (config or {})
        except Exception:
            cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}
        cards = [c for c in (cfg.get("cards") or []) if isinstance(c, dict)]
        names = _prep_card_names(cards)
        outs = []
        in_idx = 0                                  # 输入口的**全局**序号（多输入卡会吃掉好几个）
        for i, card in enumerate(cards):
            cls = _prep_cls_of(card.get("cls"))
            ports = _prep_input_ports(cls) if cls is not None else [{"name": "image"}]
            nout = len(_prep_output_ports(cls)) if cls is not None else 1
            nout = max(1, nout)
            # 该卡的输入：按全局输入口顺序取（前端把第 k 个输入口命名为 image_k）
            args = {}
            for p in ports:
                in_idx += 1
                args[p["name"]] = kwargs.get("image_%d" % in_idx)
            res = None
            if cls is not None and any(v is not None for v in args.values()):
                try:
                    allowed = {p["name"] for p in (_prep_param_schema(cls) or [])}
                    raw = card.get("params") if isinstance(card.get("params"), dict) else {}
                    params = {k: v for k, v in raw.items() if k in allowed}
                    inst = cls()
                    fn = getattr(inst, str(getattr(cls, "FUNCTION", "execute") or "execute"))
                    got = fn(**args, **params)
                    res = list(got) if isinstance(got, (list, tuple)) else [got]
                except Exception as e:
                    _ez_log.warning(
                        "[EzFlex-ControlnetPreprocessor] card %d (%s) failed: %s", i + 1, card.get("cls"), e)
                    raise ValueError(
                        "[EzFlex-ControlnetPreprocessor] card %d (%s) failed: %s"
                        % (i + 1, card.get("cls"), e)) from e
            if res is None:
                outs.extend([None] * nout)
            else:
                outs.extend(res)
                if len(res) < nout:
                    # 不静默：卡片少返回输出时，下游拿到 None 会报一个看不懂的错（NoneType ...）。
                    # 这里把「哪张卡片的哪个输出是空的」写进日志，行为不变。
                    try:
                        _miss = list(names[len(res):nout]) or ["#" + str(k) for k in range(len(res), nout)]
                        _ez_log.warning(
                            "[EzFlex-ControlnetPreprocessor] card %d (%s) returned %d/%d outputs -> %s will be None",
                            i + 1, card.get("cls") or "empty", len(res), nout, ", ".join(str(x) for x in _miss))
                    except Exception:
                        pass
                    outs.extend([None] * (nout - len(res)))
        return _ez_apply_dynamic_ports(self, names, outs)
from .ezflex.preview_nodes import (MEDIA_TO_COMFY, PreviewAnyNode, _media_kind, _media_safe, _preview_any_folders, _preview_any_fs, _preview_any_open, _preview_any_outputs, _preview_any_pick_folder, _preview_any_save_roots, _preview_any_serve_video, _preview_any_static, _pv_card_valid_names, _pv_clean_dir, _pv_delete, _pv_file_path, _pv_get_or_migrate_card, _pv_migrate_value, _pv_relocate_legacy,  _pv_store_dataurl, _pv_tag_valid_names)
try:
    _ez_route(PromptServer, "get", "/preview_any/folders", _preview_any_folders)
    _ez_route(PromptServer, "post", "/preview_any/open", _preview_any_open)
    _ez_route(PromptServer, "post", "/preview_any/pick_folder", _preview_any_pick_folder)
    _ez_route(PromptServer, "get", "/preview_any/save_roots", _preview_any_save_roots)
    _ez_route(PromptServer, "post", "/preview_any/save_roots", _preview_any_save_roots)
    _ez_route(PromptServer, "get", "/preview_any/serve_video", _preview_any_serve_video)
    _ez_route(PromptServer, "get", "/preview_any/serve_3d", _preview_any_serve_video)
    _ez_route(PromptServer, "get", "/preview_any/fs/{path:.*}", _preview_any_fs)
    _ez_route(PromptServer, "get", "/preview_any/3d/{path:.*}", _preview_any_static)
    _ez_route(PromptServer, "post", "/preview_any/outputs", _preview_any_outputs)
except Exception as _e:
    _ez_log.warning("routes for preview_any/folders were NOT registered: %s", _e)
from .ezflex.segments_nodes import (MotionContextNode, SegmentPanelNode, SplitVideoNode, TimeLineNode, TimePlanNode, _EZPV_PREFIXES, _ezsp_allowed_roots, _EZPV_SWEEP_MIN_GAP, _EZPV_TTL_SEC, _ezpv_sweep_last, _ezsp_cache_clear, _ezsp_latest_run_get, _ezsp_load_persist_file, _ezsp_load_ref_file, _ezsp_manifest_get, _ezsp_open_dir, _ezsp_pick_video, _ezsp_replace_final, _ezsp_replace_segment, _ezsp_save_persist_value, _ezsp_trim_segment, _ez_load_latent_file, _ezsp_ver_attach_latent, _ezsp_version_set, _ezsp_versions_clear, _ezsp_versions_get)
try:
    from server import PromptServer as _PS_SP
    _ez_route(_PS_SP, "get", "/ezflex/segment_manifest", _ezsp_manifest_get)
    _ez_route(_PS_SP, "get", "/ezflex/segment_versions", _ezsp_versions_get)
    _ez_route(_PS_SP, "post", "/ezflex/segment_version_set", _ezsp_version_set)
    _ez_route(_PS_SP, "post", "/ezflex/versions_clear", _ezsp_versions_clear)
    _ez_route(_PS_SP, "get", "/ezflex/latest_run", _ezsp_latest_run_get)
    _ez_route(_PS_SP, "post", "/ezflex/segment_open", _ezsp_open_dir)
    _ez_route(_PS_SP, "post", "/ezflex/segment_cache_clear", _ezsp_cache_clear)
    _ez_route(_PS_SP, "post", "/ezflex/pick_video", _ezsp_pick_video)
    _ez_route(_PS_SP, "post", "/ezflex/segment_replace", _ezsp_replace_segment)
    _ez_route(_PS_SP, "post", "/ezflex/segment_trim", _ezsp_trim_segment)
    _ez_route(_PS_SP, "post", "/ezflex/final_replace", _ezsp_replace_final)
except Exception as _e_sp_routes:
    _ez_log.warning("SegmentPanel routes not registered (%s)", _e_sp_routes)
from .ezflex.prompt_nodes import (PromptHelperNode, _ph_api_hosts_get, _ph_api_hosts_post, _ph_api_key_post, _ph_categories_get, _ph_categories_save, _ph_clip_models, _ph_custom_delete, _ph_custom_load, _ph_custom_save, _ph_gen_card_preview, _ph_gen_get, _ph_gen_preview, _ph_gen_save, _ph_libs_get, _ph_llama_models, _ph_media_target_get, _ph_media_target_save, _ph_forget_scan_path, _ph_md_roots, _ph_model_paths_get, _ph_model_paths_save, _ph_optimize, _ph_pcards_delete, _ph_pcards_get, _ph_pcards_save, _ph_pick_folder, _ph_pick_skill, _ph_preview_delete, _ph_rules_get, _ph_rules_save, _ph_scan_paths_get, _ph_scan_paths_save, _ph_scan_roots_info, _ph_tag_desc_get, _ph_tag_furry_get, _ph_tag_import, _ph_tag_kind_get, _ph_tag_lib_get, _ph_tag_nsfw_get, _ph_tag_related_get, _ph_tag_series_get, _ph_tag_zh_get, _ph_tags_get, _ph_tags_save, _ph_thumb_get)
try:
    _ez_route(PromptServer, "post", "/prompt_helper/optimize", _ph_optimize)
except Exception as _e:
    _ez_log.warning("routes for prompt_helper/optimize were NOT registered: %s", _e)
try:
    _ez_route(PromptServer, "get", "/prompt_helper/custom_providers", _ph_custom_load)
    _ez_route(PromptServer, "get", "/prompt_helper/api_hosts", _ph_api_hosts_get)
    _ez_route(PromptServer, "post", "/prompt_helper/api_hosts", _ph_api_hosts_post)
    _ez_route(PromptServer, "post", "/prompt_helper/custom_providers", _ph_custom_save)
    _ez_route(PromptServer, "delete", "/prompt_helper/custom_providers", _ph_custom_delete)
    _ez_route(PromptServer, "post", "/prompt_helper/api_key", _ph_api_key_post)
    _ez_route(PromptServer, "post", "/prompt_helper/pick_folder", _ph_pick_folder)
    _ez_route(PromptServer, "post", "/prompt_helper/pick_skill", _ph_pick_skill)
    _ez_route(PromptServer, "get", "/prompt_helper/scan_roots", _ph_scan_roots_info)
    _ez_route(PromptServer, "get", "/prompt_helper/scan_paths", _ph_scan_paths_get)
    _ez_route(PromptServer, "post", "/prompt_helper/scan_paths", _ph_scan_paths_save)
    _ez_route(PromptServer, "get", "/prompt_helper/model_paths", _ph_model_paths_get)
    _ez_route(PromptServer, "post", "/prompt_helper/model_paths", _ph_model_paths_save)
    _ez_route(PromptServer, "get", "/prompt_helper/media_target", _ph_media_target_get)
    _ez_route(PromptServer, "post", "/prompt_helper/media_target", _ph_media_target_save)
    _ez_route(PromptServer, "get", "/prompt_helper/rules", _ph_rules_get)
    _ez_route(PromptServer, "post", "/prompt_helper/rules", _ph_rules_save)
    _ez_route(PromptServer, "get", "/prompt_helper/prompt_cards", _ph_pcards_get)
    _ez_route(PromptServer, "post", "/prompt_helper/prompt_cards", _ph_pcards_save)
    _ez_route(PromptServer, "delete", "/prompt_helper/prompt_cards", _ph_pcards_delete)
    _ez_route(PromptServer, "get", "/prompt_helper/prompt_categories", _ph_categories_get)
    _ez_route(PromptServer, "post", "/prompt_helper/prompt_categories", _ph_categories_save)


    _ez_route(PromptServer, "get", "/prompt_helper/prompt_tags", _ph_tags_get)
    _ez_route(PromptServer, "post", "/prompt_helper/prompt_tags", _ph_tags_save)
    _ez_route(PromptServer, "get", "/prompt_helper/gen_settings", _ph_gen_get)
    _ez_route(PromptServer, "post", "/prompt_helper/gen_settings", _ph_gen_save)
    _ez_route(PromptServer, "post", "/prompt_helper/gen_preview", _ph_gen_preview)
    _ez_route(PromptServer, "post", "/prompt_helper/gen_card_preview", _ph_gen_card_preview)
    _ez_route(PromptServer, "get", "/prompt_helper/tag_libs", _ph_libs_get)
    _ez_route(PromptServer, "get", "/prompt_helper/tag_lib", _ph_tag_lib_get)
    _ez_route(PromptServer, "get", "/prompt_helper/tag_zh", _ph_tag_zh_get)
    _ez_route(PromptServer, "get", "/prompt_helper/tag_furry", _ph_tag_furry_get)
    _ez_route(PromptServer, "get", "/prompt_helper/tag_kind", _ph_tag_kind_get)
    _ez_route(PromptServer, "get", "/prompt_helper/tag_series", _ph_tag_series_get)
    _ez_route(PromptServer, "get", "/prompt_helper/tag_nsfw", _ph_tag_nsfw_get)
    _ez_route(PromptServer, "get", "/prompt_helper/tag_related", _ph_tag_related_get)
    _ez_route(PromptServer, "get", "/prompt_helper/tag_desc", _ph_tag_desc_get)
    _ez_route(PromptServer, "post", "/prompt_helper/tag_import", _ph_tag_import)
    _ez_route(PromptServer, "get", "/prompt_helper/thumb/{kind}/{fname}", _ph_thumb_get)
    _ez_route(PromptServer, "get", "/prompt_helper/thumb/{fname}", _ph_thumb_get)   # 兼容旧 URL（默认 tag）
    _ez_route(PromptServer, "post", "/prompt_helper/preview_delete", _ph_preview_delete)
except Exception as _e:
    _ez_log.warning("routes for prompt_helper/custom_providers were NOT registered: %s", _e)
try:
    _ez_route(PromptServer, "get", "/prompt_helper/llama_models", _ph_llama_models)
    _ez_route(PromptServer, "get", "/prompt_helper/clip_models", _ph_clip_models)
except Exception as _e:
    _ez_log.warning("routes for prompt_helper/llama_models were NOT registered: %s", _e)
from .ezflex.routes_nodes import (_ez_reroute_outputs, _fl_default_get, _fl_default_set, _lora_meta_detail, _lora_meta_list, _mc_files, _mc_outputs, _ml_browse, _ml_files, _ml_open, _ml_outputs, _ml_pick_folder, _ml_roots_get, _ml_roots_post, _ml_save_as, _ml_serve, _ml_upload, _mo_outputs, _ppc_outputs, _ppo_outputs, _prep_nodes, _prep_open_model, _prep_outputs, _preview_handler)


try:
    _ez_route(PromptServer, "get", "/models_combo/preview", _preview_handler)
except Exception as _e:
    _ez_log.warning("routes for models_combo/preview were NOT registered: %s", _e)
try:
    _ez_route(PromptServer, "get", "/models_combo/lora_meta", _lora_meta_list)
    _ez_route(PromptServer, "get", "/models_combo/lora_meta_detail", _lora_meta_detail)
except Exception as _e:
    _ez_log.warning("routes for models_combo/lora_meta were NOT registered: %s", _e)
try:
    _ez_route(PromptServer, "get", "/freelatent/presets/default", _fl_default_get)
    _ez_route(PromptServer, "post", "/freelatent/presets/default", _fl_default_set)
except Exception as _e:
    _ez_log.warning("routes for freelatent/presets/default were NOT registered: %s", _e)
try:
    _ez_route(PromptServer, "get", "/models_combo/files", _mc_files)
    _ez_route(PromptServer, "post", "/models_combo/outputs", _mc_outputs)
except Exception as _e:
    _ez_log.warning("routes for models_combo/files were NOT registered: %s", _e)
try:
    _ez_route(PromptServer, "post", "/param_preset_control/outputs", _ppc_outputs)
    _ez_route(PromptServer, "post", "/param_preset_output/outputs", _ppo_outputs)
except Exception as _e:
    _ez_log.warning("routes for param_preset_control/outputs were NOT registered: %s", _e)
try:
    _ez_route(PromptServer, "get", "/media_loader/files", _ml_files)
    _ez_route(PromptServer, "get", "/media_loader/roots", _ml_roots_get)
    _ez_route(PromptServer, "post", "/media_loader/roots", _ml_roots_post)
    _ez_route(PromptServer, "get", "/media_loader/browse", _ml_browse)
    _ez_route(PromptServer, "get", "/media_loader/serve", _ml_serve)
    _ez_route(PromptServer, "post", "/media_loader/outputs", _ml_outputs)
    _ez_route(PromptServer, "post", "/media_loader/upload", _ml_upload)
    _ez_route(PromptServer, "post", "/media_loader/open", _ml_open)
    _ez_route(PromptServer, "post", "/media_loader/save_as", _ml_save_as)
    _ez_route(PromptServer, "post", "/media_loader/pick_folder", _ml_pick_folder)
    _ez_route(PromptServer, "post", "/media_out/outputs", _mo_outputs)
except Exception as _e:
    _ez_log.warning("routes for media_loader/files were NOT registered: %s", _e)
try:
    _ez_route(PromptServer, "post", "/ezreroute/outputs", _ez_reroute_outputs)
except Exception as _e:
    _ez_log.warning("routes for ezreroute/outputs were NOT registered: %s", _e)
try:
    _ez_route(PromptServer, "get", "/ezflex_prep/nodes", _prep_nodes)
    _ez_route(PromptServer, "post", "/ezflex_prep/outputs", _prep_outputs)
    _ez_route(PromptServer, "post", "/ezflex_prep/open_model", _prep_open_model)
except Exception as _e:
    _ez_log.warning("routes for ezflex_prep/nodes were NOT registered: %s", _e)
# ===== §9 节点映射与前端路由注册 =====
NODE_CLASS_MAPPINGS = {
    "EzFlex-MainControl": MainControlNode,    "EzFlex-ModelsCombo": ModelsComboLoader,
    "EzFlex-FreeLatent": FreeLatentNode,
    "EzFlex-NodeSwitchMaster": NodeSwitchMasterNode,
    "EzFlex-NodeSwitchGroup": NodeSwitchGroupNode,
    "EzFlex-ParamPresetControl": ParamPresetControlNode,
    "EzFlex-ParamPresetOutput": ParamPresetOutputNode,
    "EzFlex-PreviewAny": PreviewAnyNode,
    "EzFlex-PromptHelper": PromptHelperNode,
    "EzFlex-MediaLoader": MediaLoaderNode,
    "EzFlex-MediaOut": MediaOutNode,
    "EzFlex-MergeList": MergeListNode,
    "EzFlex-SplitList": SplitListNode,
    "EzFlex-Reroute": EzFlexRerouteNode,
    "EzFlex-TimeLine": TimeLineNode,
    "EzFlex-SplitVideo": SplitVideoNode,
    "EzFlex-VideoComponents": VideoComponentsNode,
    "EzFlex-SegmentPanel": SegmentPanelNode,
    "EzFlex-MotionContext": MotionContextNode,
    "EzFlex-TimePlan": TimePlanNode,
    "EzFlex-ControlnetPreprocessor": ControlnetPreprocessorNode,
    "EzFlex-LoopStart": LoopStartNode,
    "EzFlex-LoopEnd": LoopEndNode,
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
    "EzFlex-MergeList": "EzFlex-MergeList",
    "EzFlex-SplitList": "EzFlex-SplitList",
    "EzFlex-Reroute": "EzFlex-Reroute",
    "EzFlex-TimeLine": "EzFlex-TimeLine",
    "EzFlex-SplitVideo": "EzFlex-SplitVideo",
    "EzFlex-VideoComponents": "EzFlex-VideoComponents",
    "EzFlex-SegmentPanel": "EzFlex-SegmentPanel",
    "EzFlex-MotionContext": "EzFlex-MotionContext",
    "EzFlex-TimePlan": "EzFlex-TimePlan",
    "EzFlex-ControlnetPreprocessor": "EzFlex-ControlnetPreprocessor",
    "EzFlex-LoopStart": "EzFlex-LoopStart",
    "EzFlex-LoopEnd": "EzFlex-LoopEnd",
}
