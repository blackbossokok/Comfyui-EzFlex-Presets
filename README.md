# Comfyui-EzFlex-Presets (V1.3.0 Beta-2)

**English** | [中文](README_ZH.md)

A flexible combo plugin for ComfyUI, built with AI; still being improved.

!\[overview](./images/overview.png)

Demo video (Bilibili): [watch](https://www.bilibili.com/video/BV1T8hy6JEf4)

## EzFlex node list:

* Main Control (`MainControl`)
* Models Combo Loader (`EzFlex-ModelsCombo`)
* Resolution / Latent Selector (`EzFlex-FreeLatent`)
* Node Switch Master (`NodeSwitchMaster`)
* Node Switch Group (`NodeSwitchGroup`)
* Param Preset Control (`ParamPresetControl`)
* Param Preset Output (`ParamPresetOutput`)
* Preview Any (`EzFlex-PreviewAny`)
* Prompt Helper (`EzFlex-PromptHelper`)
* Media Loader (`EzFlex-MediaLoader`)
* Media Out (`EzFlex-MediaOut`)
* Merge List (`EzFlex-MergeList`)
* Split List (`EzFlex-SplitList`)
* Loop Start (`EzFlex-LoopStart`)
* Loop End (`EzFlex-LoopEnd`)
* Time Line (`EzFlex-TimeLine`)
* Reroute (`EzFlex-Reroute`)
* **17 nodes in total**

## Version history:

* V1.3.0 (earlier in this cycle): Optimized random tags; fixed category selection diverging from the in-library categories; added a duplicate-category warning (a child category duplicating its parent); the card manager gained image generation; reworked MediaLoader / MediaOut port types and interaction; reworked PreviewAny preview \& save logic; added loop nodes — Merge List (`EzFlex-MergeList`), Split List (`EzFlex-SplitList`), Loop Start (`EzFlex-LoopStart`), Loop End (`EzFlex-LoopEnd`), Time Line (`EzFlex-TimeLine`) — the Reroute node (`EzFlex-Reroute`), and a loop system for MediaLoader and PromptHelper; tag / card previews are stored as standalone image files (`tag\\\_preview` / `card\\\_preview`), with Ctrl+Z / Ctrl+Y guarded so panel undo does not touch the graph.
* V1.2.12: Tag-system performance improvements; fixed cards failing to fill content; fixed the display conflict between the tag hint and "@" media reference; fixed PreviewAny failing to save some media types; improved the save logic.
* V1.2.11: Fixed several PromptHelper frontend bugs and the API-call issue; added API-call error hints; overhauled the tag system: random match/exclude field filters, related tags, a "Hide NSFW" filter, finer in-library tag classification, and a new anima 2.9B tag library.
* V1.2.10: Fixed the ModelsCombo first output port disconnecting after switching windows, refreshing, or restarting; fixed preset selections being lost after switching windows or refreshing.
* V1.2.9: Fixed Preview Any reading incorrect image generation info (prompt text is now read through connected nodes); fixed Node Switch Group possibly failing to match nodes after being copied. ModelsCombo keeps the trigger-words output port whenever it has a config (empty without LoRA).
* V1.2.8: Preview Any (`EzFlex-PreviewAny`) supports batch image preview; the preview window behavior was improved.
* V1.2.7: Fixed the preview-image disappearing bug, improved black-label text rendering, updated to align with official node features.
* V1.2.6: Added the theme system, optimized the FreeLatent canvas, optimized tag previews, normalized data storage, cleaned up some redundant code, and fixed some bugs.
* V1.2.5: The tag system gained random tags; the default tag library is now bundled (it was missed last time); preview generation gained a cleanup action. ModelsCombo can auto-generate the trigger words of a loaded LoRA (shown live in PromptHelper), and the browser gained a "loaded models" view. Fixed black tag sub-nodes not showing and residue after fast moves. Overall edit supports collapsing individual cards.
* V1.2.4: Prompt Helper big update: new tag system / card manager; improved security.
* V1.2.3: Fixed some bugs, continued comprehensive security improvements, enhanced node features.
* V1.2.2: Fixed the `EzFlex-NodeSwitchGroup` dropdown bug; fixed the bug where `EzFlex-ParamPresetOutput`, `EzFlex-PreviewAny` etc. could not validate input after switching presets in `EzFlex-ParamPresetControl`; optimized where the custom size presets sit in `EzFlex-FreeLatent`. Fixed the unclickable controls in the Media Loader preview popup. Fixed Media Loader loading 3D models and preview images too slowly. Fixed PromptHelper's highlight logic.
* V1.2.1: Fixed the Node 2.0 click bugs in Prompt Helper (`EzFlex-PromptHelper`), Media Loader (`EzFlex-MediaLoader`) and Media Out (`EzFlex-MediaOut`). Prompt Helper (`EzFlex-PromptHelper`) and Node Switch Group (`NodeSwitchGroup`) gained collapsible rows. Comprehensive security hardening across the plugin.
* V1.2.0: Comprehensive security hardening; Main Control (`MainControl`) gained an EN / 中文 toggle.
* V1.11: Prompt Helper overhaul and bug fixes.
* V1.1: General node polish and performance work; Prompt Helper improvements; compatibility fixes.
* V1.05: Prompt Helper gained "reference media" and a stronger `@media` reference.
* V1.04: Added Media Loader (`EzFlex-MediaLoader`) and Media Out (`EzFlex-MediaOut`); Prompt Helper overhaul (still in development).
* V1.03: README cleanup; FreeLatent gained a "force override" button (ignore external width/height/batch); fixed the align default (multiples of 8); added the Prompt Helper node.
* V1.02: ModelsCombo gallery/search improvements.
* V1.01: ParamPresetControl preset switching + wiring fix.
* V1.0: First stable release.

## Install

* Put this folder under `ComfyUI/custom\\\_nodes/` and restart ComfyUI.
* Dependencies: the plugin **only needs `mutagen` as an extra** (to read audio/video tags); the rest (torch / numpy / Pillow / safetensors / av) ships with ComfyUI. If you don't want to install it manually, run `pip install -r requirements.txt`.
* Optional (**deliberately not in requirements**, so ComfyUI-Manager never forces a compile — install by hand when needed): `llama-cpp-python` (Prompt Helper's "in-process llama-cpp-python" mode), `gguf` / `onnx` (model metadata cards for those two formats). Or install everything at once: `pip install -e .\\\[llama,metadata]`.

## Usage

Search `EzFlex` in the ComfyUI node list and pick the node you need.

## Node features

### Main Control (`MainControl`):

* Control: drives the overall node behavior; presets can be freely combined, saved and deleted.
* Card list: Models Combo Loader (`EzFlex-ModelsCombo`), Resolution / Latent Selector (`EzFlex-FreeLatent`), Node Switch Master (`NodeSwitchMaster`) and Param Preset Control (`ParamPresetControl`) — each with its own preset dropdown and drag-to-reorder. A master preset records their current presets together and cascades them down when switched. **Node Switch Group is not listed here separately** — it is managed by Node Switch Master.
* Quick load: load the other EzFlex nodes in one click (**Media Out (`MediaOut`) is loaded by Media Loader (`EzFlex-MediaLoader`) itself**).
* Language: switch between 中文 / English.
* Theme: one palette switch recolors every EzFlex panel (Light / Lilac / Sage / Nord / Minimal Cool Grey / Warm Caramel / Cool Haze Blue / Deep Space / Morandi Purple-Grey / Mermaid Core / Chocolate / Klein Blue / Cloud White / Banana Yellow / Burgundy / Deep Teal — 16 in total). Palettes live in the theme module and the panels only write CSS variables, so a switch repaints all open panels immediately.

### Models Combo Loader (`EzFlex-ModelsCombo`):

* Combo loading: freely combine UNet / CLIP / VAE / Checkpoint / LoRA loaders.
* Presets: freely combine / save / delete model-loading setups.
* Preview: preview dropdown-list model covers.
* Gallery: gallery-style browsing to pick models. (Needs the ComfyUI-Lora-Manager plugin to generate JSON files via Civitai.)
* Outputs: ports are generated by the number (loader cards) and type; the LoRA loader chains after its selected target model, multiple LoRAs chain in card order, and port names look like `custom\\\_name\\\_model/clip/vae`.
* Order: reorder cards freely.

### Resolution / Latent Selector (`EzFlex-FreeLatent`):

* Canvas: drag freely to generate the matching empty latent; hold Ctrl to disable snapping.
* Width/height input: type width/height manually.
* Align resolution: computes width/height with the `Opt / Std` algorithm and the `resolution step`; it currently affects `manual width/height input, size-preset selection, and sizes derived from ratio and MP`.
* MP: megapixels.
* Ratio presets: width : height; choose built-in and custom ratio presets.
* Size presets: choose built-in and custom size presets; custom ones can be saved/deleted (`based on the current actual size`).
* Custom ratios: save / delete your own input ratio presets.
* Info panel: live actual width/height, ratio and MP.
* Inputs: external width/height, batch size.
* Outputs: empty latent, width/height, batch size.
* Force override: when green, external width/height/batch are ignored and the panel values win, and the controls are unlocked (available only when at least one input has a value).

### Node Switch Master (`NodeSwitchMaster`):

* Control: drives Node Switch Group behavior; freely combine / save / delete presets.

### Node Switch Group (`NodeSwitchGroup`):

* Control: switch grouped nodes between `on / off / bypass (ignore)`.
* Presets: freely save / delete node switch presets.
* Group matching: by name / by color, subgraph matching.
* Order: auto-sort cards by position / name.
* Note: presets are per node instance; deleting the node removes its presets.

### Param Preset Control (`ParamPresetControl`):

* Control: `green/red parameter buttons`: whether a parameter shows in the output list and in the parameter-group card dropdown. `Parameter group dropdown`: select the output parameter (all or a specific one).
* Presets: freely save / delete parameter-group presets.
* Parameters: eight types — int, float, bool, string, complex, tuple, list, set, dictionary.
* Order: parameter-group cards and parameter cards can both be dragged freely.
* Outputs: one output port per parameter-group card; multiple parameters are red, a single parameter is gray.

### Param Preset Output (`ParamPresetOutput`):

* Control: enable/disable parameter output; int->0, bool->false, float->0.0, string etc.->empty string.



* Type hint: shows the actual type; if the value does not match the type set in Param Preset Control (`ParamPresetControl`), it outputs string by default and is marked red.
* Value preview: click to open a preview popup.



### Preview Any (`EzFlex-PreviewAny`):

* Preview: auto-detects any input type and renders the matching preview card (drag to reorder, cards are added/removed with connections).
* Save: preview-only by default; click "auto save" to write to disk. Save options follow the format (lossless formats take no bitrate, lossless images take no quality) and IMAGE / AUDIO / VIDEO offer "Keep source" (copy the source file as-is, no re-encode). File names support `%year% %month% %day% %hour% %minute% %second%`.
* Batch: one card exports at most 64 frames; the multi-image save mode (auto / batch images / video / animation) is chosen per card.
* Supported types, preview and saving details:

|Type|Accepts|Preview|Formats|
|-|-|-|-|
|IMAGE|tensor `\\\[B,H,W,C]`|thumbnail + full-screen original (batches: thumbnail strip paging; saves as image sequence / video / animation)|PNG / JPEG / WebP / BMP / TIFF / animation (WebP / PNG / GIF)|
|MASK|2D/3D tensor|grayscale PNG|PNG|
|AUDIO|`{waveform,sample\\\_rate}` or `(waveform,sr)` or a file object|player|WAV / MP3 / FLAC / OGG / M4A / AAC|
|VIDEO|`VideoFromFile` / `VideoFromComponents` object|first-frame cover + player|MP4 / WebM / MOV / GIF / AVI / MKV|
|CONDITIONING|a dict with `conditioning/context`|text summary|—|
|LIST / TUPLE / SET|list / tuple / set|indexed value tree (index: value)|JSON|
|DICT|dict|key/value tree (key: value)|JSON|
|STRING / INT / FLOAT / BOOLEAN|str / int / float / bool|text (truncated + popup full text)|TXT / MD / JSON / CSV / LOG / HTML|
|LATENT|`{samples}` dict|shape / dtype summary|—|
|FILE\_3D|`File3D` object (same as the built-in Load3D)|three.js viewer (offline)|glb / gltf / obj / fbx / splat|
|MODEL\_3D|File3D object (with path/file)|three.js viewer (offline)|glb / gltf / obj / fbx / splat|
|MESH|`Types.MESH` (vertex/face tensors, Hunyuan3D / Trellis / MoGe …)|vertices/faces exported to a temp OBJ → three.js viewer|vertices ≤500k, faces ≤1M (beyond that: summary only)|
|SPLAT / VOXEL|`Types.SPLAT` / `Types.VOXEL` (tensors)|text summary (point count / SH coefficients / voxel resolution)|—|
|MODEL|ModelPatcher|model metadata card|safetensors / gguf / onnx / ckpt / pt|
|CLIP|comfy.sd CLIP|metadata card|safetensors / gguf / onnx|
|VAE|comfy.sd VAE|metadata card|safetensors / gguf / onnx|
|CONTROL\_NET / CLIP\_VISION / STYLE\_MODEL / UPSCALE\_MODEL / LORA\_MODEL / GLIGEN / SAMPLER / SIGMAS / GUIDER / NOISE / SEGS|the matching ComfyUI object|text summary|—|
|EMPTY|not connected|"(not connected)"|—|

* Saving details: preview-only by default; click "auto save" to write to disk, with an optional save location and save options.
* Save options follow the format: lossless formats take no bitrate, lossless images take no quality; IMAGE / AUDIO / VIDEO offer "Keep source" (a file loaded from disk is copied as-is, no re-encode).
* File name: supports `%year% %month% %day% %hour% %minute% %second%`; if left empty the card name is used with an automatic number.
* Model types (MODEL / CLIP / VAE / LORA\_MODEL): only the info text is saved (summary + metadata) — **the model file is not copied**.
* Batch images: one card exports at most 64 frames (beyond that only the count is recorded); the corner badge shows images / frames by the upstream node class name (video/frame/sequence …) — batch image output and video frame extraction cannot be told apart on the tensor.
* Multi-image save mode is chosen per card ("multi-image save type": auto / batch images / video / animation, default auto, only for multi-image cards): auto = extract frames → video, batch output → one by one; the animation format / fps / lossless are set under "save type". File name is `name\\\_index\\\_NN`. Non-multi-image cards are saved normally by type.
* Preview: data preview popup / generation info.



### Prompt Helper (`EzFlex-PromptHelper`):

* Cards: add / remove / drag to reorder / double-click to rename; each card has a "Default / Optimized" pair of pages and a "merge" toggle (green = merged, gray = not merged).
* Editor: Word-style toolbar (bold/italic/underline/strike, alignment, font size, font color, highlight, first-line indent, find \& replace, color picker, full/half-width conversion) plus a skill button (pick a \*.md and insert it line by line at the cursor).
* Reference media: reads the media ports of generation nodes on the canvas live and numbers them as @image N / @video N / @audio N; the "reference media" window lists material per generation node, with + insert / − remove / right-click to set as the global reference library.
* Prompt rules: 15 built-in rules under "Settings · Rules" (including "no compile" and "use API") plus custom ones (editable, savable, with 中/EN variants), compiling reference marks into each vendor's syntax (`<Picture 1>`, `@image1`, …).
* Optimize: the tool dropdown offers "optimize prompt (API) / (TextGenerate) / (llama)"; use it once or enable "optimize at runtime". The three toggles are mutually exclusive and failures are reported directly.
* Quick weight: with the caret on a tag, press **Ctrl+↑ / Ctrl+↓** to add/subtract the "weight step" (Settings · Other settings, default 0.05) — e.g. `long_hair` → `(long_hair:1.05)`, then back to `long_hair` once the weight returns to exactly 1 (the brackets are dropped). It follows the caret, so moving with the arrow keys first weights whatever tag the caret is now on. Clamped to 0.05 – 10.
* Collapse: two hover-only bars in the card popup / overall edit fold the **toolbar** and the **Default / Optimized tab row** separately (the text area is never folded). Collapse state is saved in the node config and survives a refresh; when both are collapsed they merge into a single "expand all" bar that is again hover-only.
* Tag entry: a **Tag** button sits to the right of **Hint** in the card popup / overall edit footer, opening the tag panel — it stays available even when the prompt tools are collapsed.
* Card manager: store cards as presets (`user/EzFlex/prompts/<name>.json`); save only the checked ones, click to load, delete.
* Ports: no CLIP input — a dynamic "combined media" port (ANY: images / video / audio / 3D) plus one text input per card; outputs are "merged prompt" plus one per card.
* Settings: six tabs — General / Rules / API / TextGenerate / llama / Paths.
* Mode: the header's "⧉ tile / 🗗 popup" switches the window shape in one click.
* Optimization rules \& rule compilation:

  * Two sliders: the "Default / Optimized" pages in a **card** popup only affect **that card's output port**; the ones in **overall edit** affect the **"merged prompt" port**. Each layer's optimized content is its own slot — they do not overwrite each other.
  * **Tool optimization** — card popup "Tool → optimize prompt": the source is fixed to that card's **Default** page; the result is written to that card's Optimized slot and the slider switches to Optimized, the Default body is untouched. Overall edit "Tool → optimize prompt": the source is each card's **Default** body joined in order with the "card merge separator" (merged = green card; empty cards take no slot), **one single call**; the result goes to the "overall optimization result" and the overall-edit slider switches to Optimized, the original cards are unchanged. Both obey the same table:

|Slider|Default|Optimized|Behavior|
|-|-|-|-|
|Default / Optimized|has|none|optimize using the default prompt → fills the optimized slot, slider switches to Optimized|
|Default / Optimized|has|has|optimize using the default prompt → **overwrites** the optimized slot (does not reuse hand-edited optimized text)|
|any|empty|has / none|pops "this card has no prompt content to optimize."|

* **Runtime optimization — any of the three auto-optimize toggles on**: on failure (API / TextGenerate / llama error) it **stops with red**. The optimized slot is a "memo": if it has content it is **not re-called**, only when empty. Overall layer → "merged prompt" (source = the merged **Default** bodies of merged=green cards, joined with the card merge separator):

|Overall slider|Default|Optimized|Behavior|
|-|-|-|-|
|any|has|none|optimize once overall → write to "overall optimization result" → slider switches to Optimized → output it|
|Optimized|has/empty|has|output the "overall optimization result" directly (**no re-optimize**), slider unchanged|
|Default|has|has|output the **default merged** (the optimized version is kept unused, and no optimization), slider unchanged|
|Default|empty|has|output the "overall optimization result", slider switches to Optimized|
|any|empty|empty|output empty (the user wrote nothing), slider unchanged|

* Each card → "card i" port: when **merge is green** (joins the merge) it is **not optimized separately** at runtime, strictly output by that card's slider — Default outputs Default, Optimized outputs Optimized; **pointing at an empty slot outputs empty** (no fallback). The card list tag follows the slider ("opt" / "def"). When **merge is gray** (does not join the merge) it is **optimized separately on demand** at runtime (the result only reaches its own port):

|Slider|Default|Optimized|Card port|
|-|-|-|-|
|any|has|none|optimize the default separately once → fills that card's optimized slot → port = result, slider switches to Optimized|
|Default|has|has|port = Default (the optimized version is kept unused, and no optimization), slider unchanged|
|Optimized|has|has|port = optimized version (no re-optimize), slider unchanged|
|any|empty|has|port = optimized version (no re-optimize); if the slider was on Default it switches to Optimized|
|any|empty|empty|port = empty, slider unchanged|

* Port count = number of cards + 1 (port 0 is "merged prompt", then "card 1..N" all STRING); ports follow card add/remove/sort. If `card\\\_in\\\_i` is wired to external text it overrides that card (the card is dimmed on the panel) and also takes part in the merge and optimization.
* **All three toggles off**: no optimization call is made, with the same "strictly by slider, empty stays empty" rule. Overall edit: slider on **Default** → outputs the **default merge** (each card's Default body, filtered by merge, gray cards excluded); on **Optimized** → outputs the "overall optimization result". Empty stays empty, no fallback, no filling in. Each card (green and gray the same): Default → that card's Default body; Optimized → that card's optimized content; empty stays empty. A card slider **does not affect** the "merged prompt" — the merged port only takes each card's Default body (this is why a card's optimized content only goes through "its own port").
* **Rule compilation (referencing media), and at which step**: the body sent to the API / TextGenerate / llama is the **uncompiled original text** (the `@image1` / `@video1` / `@audio1` you typed); the system prompt explicitly asks the model to **keep those marks as-is** (no translating, rewriting or renumbering). Both optimized slots (that card's "optimized prompt" / "overall optimization result") also store the **model's original text** (uncompiled) — you can still recompile with a different rule set and never lose the mapping. **Only the output ports go through rule compilation**: the "card i" port, and the default merge / overall-optimized content used by the "merged prompt"; compilation is idempotent. If the model **keeps** `@image1` → the output automatically becomes that rule's syntax (e.g. `<Picture 1>`); if the model **translates/rewrites** it into natural language ("the first picture"), the mark is gone and no compilation can recover it (only the system prompt can lower the odds, or use a more obedient model).

### Media Loader (`EzFlex-MediaLoader`):

* Presets: save and delete group and card-group state plus names.
* Parameters: cards per row, card height multiplier (default 1).
* Groups / card groups / media cards: drag to reorder, double-click to rename, context menu, long-press drag to merge, hover info, click to preview, delete.
* Browse: file-explorer style (directory tree, back/forward/up/refresh, manual path entry, search, multi-select).
* Output: one port per card, of the dedicated `EZFLEX\\\_MEDIA\\\_CARD` type (dark red) — it carries the *card object*, not a media value, so it can only connect to `EzFlex-MediaOut` (this blocks accidental wiring into built-in nodes); for real media values use MediaOut.
* Loadable types: images / video / audio / 3D models / text / other, with the same output values as ComfyUI's built-in loaders, so they wire straight into standard nodes.
* Supported extensions: images `.png .jpg .jpeg .webp .gif .bmp .tif .tiff` | video `.mp4 .webm .mov .mkv .avi .m4v` | audio `.mp3 .wav .flac .ogg .aac .m4a .opus .wma` | 3D `.obj .glb .gltf .fbx .stl .ply .spz .splat .ksplat .3ds .dae .blend` | text/other → STRING.
* Top bar "load output": creates one EzFlex-MediaOut and wires it for you.
* ⚠️ **Be careful with the root-directory (browsable roots) setting**: by default you can only browse ComfyUI's own `input` / `output`; to reach other directories, type a path in the toolbar and click "save root" to register it explicitly. **Only people who can reach your ComfyUI port can see those roots** — when it listens on `127.0.0.1` (the default) adding roots only affects you; but once you use `--listen 0.0.0.0`, a tunnel or a reverse proxy to the internet, anyone on that network/internet can list and download the directories you registered. So: never register a drive letter, your home directory or a project root (the plugin also refuses whole drives and clears legacy ones); registering/deleting is local-only; and delete roots when you are done (the built-in `input` / `output` cannot be deleted).

### Media Out (`EzFlex-MediaOut`):

* Input: a single input (dedicated type `EZFLEX\\\_MEDIA\\\_CARD`), wired to one card port of `EzFlex-MediaLoader`.
* Output: neutral ports colored/typed by the real file type — IMAGE / VIDEO / AUDIO / FILE\_3D / STRING (same as the built-in loaders, so they wire straight into standard nodes).
* Modes: split / card / card group / group (switched from the panel header); split → one port per file, card / card group / group → merged into one port following the structure.
* Merge: multiple images → a batch tensor `\\\[B,H,W,C]` (accepts any IMAGE input, and can be split again with the built-in `ImageFromBatch` / `RebatchImages`); multiple audio files → concatenated into one track (sample rates must match; mono is upmixed); multiple texts → joined with newlines; mixed types / mismatched sample rates → an error suggesting "split" (the port degrades to `\\\*` and the hover label shows `×N`).
* Batch settings (shown in card / card group / group mode, aligned with KJNodes `Load Images From Folder`): target size `use first` / `specify size`, fit `crop` / `pad` / `stretch`, `max items` (0 = all), `start index` (0-based).
* Switches: each can be toggled; in split mode a disabled port is kept and outputs `None` (re-enabling needs no re-wiring), in the other modes a disabled item is dropped from the group. At **runtime** (before the prompt is queued) an input that is "disabled but still connected" is removed from the **submitted prompt** — downstream treats it as not connected, and **neither the canvas wiring nor the saved workflow changes**.

### Merge List (`EzFlex-MergeList`):

* What it does: joins multiple inputs, in order, into one list.
* Input ports are added/removed as needed (`input\\\_1..20`); a list input is flattened in, anything else is appended as one item.
* Outputs one `\\\*` list port, ready for `EzFlex-SplitList` or another loop node.

### Split List (`EzFlex-SplitList`):

* What it does: splits one list into multiple output ports (the inverse of Merge List).
* Output ports are added/removed as needed, always keeping at least one; unconnected ports get no black label.
* Commonly used to take the segments of a collected loop list out one by one.

### Loop Start (`EzFlex-LoopStart`):

* What it does: the loop entry point. The panel has a single `index` field — which round this run starts from (0 by default). At runtime it is read-only and increments every round.
* Outputs: `index` (INT, always first — wire it into PromptHelper / MediaLoader / TimeLine's index input) plus `value1`, `value2`, … (dynamic, added one at a time as you connect).
* Inputs: `index` (optional — feed an upstream value when you want to drive the start round from the graph) plus `initial value1`, `initial value2`, … (dynamic, one per value port). This is the first-round seed: **until feed-back arrives, `valueN` outputs the matching `initial valueN`** (left unwired, it outputs nothing). Wire the same kind of data you expect Loop End port N to carry back — you need it whenever a downstream node cannot accept a missing value (torch.cat / VAE / …).
* `valueN` is the fed-back value: whatever Loop End's port N received last round. From round 2 on it overrides the initial value.
* The round count does not live here — it is Loop End's panel field.

### Loop End (`EzFlex-LoopEnd`):

* What it does: the loop trigger and exit point. The panel has a single round counter, and it counts **total** rounds (the first one included): 0 or 1 = a single pass (a plain run), N = N passes total.
* Inputs `value1`, `value2`, … (dynamic — added one at a time as you connect, one-to-one with Loop Start's outputs): **whatever a port receives becomes the next round's Loop Start value N**.
* Once the total round count is reached, these values are returned as-is on `out1`, `out2`, … (the values of the **last** round — wire a `EzFlex-MergeList` output into `valueN` if you want `outN` to be the accumulated per-round list).
* ⚠️ Do not wire Loop End back into Loop Start on the canvas — the feed is automatic, and a real wire closes the graph cycle (`Dependency cycle detected`).
* ⚠️ `outN` can only feed nodes **outside** the loop body: the body is everything downstream of Loop Start (up to Loop End), so `LoopEnd.out1 → TimeLine.video` is a cycle when TimeLine also takes `LoopStart.index`. Use `LoopStart.valueN → TimeLine.video` instead (valueN is the previous rounds' accumulated value).

### Time Line (`EzFlex-TimeLine`):

* What it does: slices a total duration into segments on the model's frame grid, giving each segment's frame count and the total segment count.
* Inputs: `index` (from the loop's index) and `video` (segment video list, item i = segment i).
* Outputs: `frames` (frames to generate for this segment), `overlap\\\_frames` (overlap frames), `segments` (total segments; wire into LoopEnd's round counter when the round count is not known up front).
* Ships with minimax\_h3 / wan / ltx model parameters; the segmentation is visualized in the "big preview on top + splice track at the bottom" panel.

### Reroute (`EzFlex-Reroute`):

* Relay: a mid-flow reroute node for larger workflows.
* Connections: adds connectable ports as you wire, and each relay card can be named freely.
* Colors: port and link colors follow the upstream output port (VAE red / CLIP yellow / MODEL purple …), so you can see at a glance what is being relayed.

## Directory structure

```
Comfyui-EzFlex-Presets/
├── \\\_\\\_init\\\_\\\_.py          # all 17 node classes + preset routes + output-type sync routes
├── pyproject.toml
├── README.md            # English README (default home page)
├── README\\\_ZH.md         # Chinese README
├── docs/                # detailed references and research notes (loop mechanics / long video / director …)
├── user\\\_data/           # preset library (written at runtime by the plugin)
├── locales/zh/nodeDefs.json  # official i18n: Chinese node names / descriptions / tooltips
└── web/                 # frontend panels (one \\\*\\\_node.js per node; shared ezflex\\\_service/i18n/theme)
    ├── ezflex\\\_service.js       # shared: registry / group matching / preset API / panel helpers
    ├── ezflex\\\_i18n.js          # panel i18n: ezT(key) + Chinese dictionary (English is the source)
    ├── ezflex\\\_theme.js         # theme: 16 palettes → shared CSS variables (--ez-\\\*)
    ├── ezflex\\\_media\\\_index.js   # media numbering engine (generator media ports → image N / video N / audio N)
    ├── ezflex\\\_listview.js      # list / text preview popup
    └── libs/ utils/ curves/    # three.js and loader/curve resources (local offline, for the 3D viewer)
```

## Notes

* A personal project, built with AI assistance and still being improved — feedback and suggestions are welcome.
* Presets and caches live under `user/EzFlex/`; workflows only store each node's own configuration.

