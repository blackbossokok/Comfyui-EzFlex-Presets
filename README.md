# Comfyui-EzFlex-Presets (V1.2.9 stable)

[English](README.md) | **中文**

A flexible combo plugin for ComfyUI, built with AI; still being improved.

![overview](./images/overview.png)
Demo video (Bilibili): [watch](https://www.bilibili.com/video/BV1T8hy6JEf4)

## EzFlex node list:
- Main Control (`MainControl`)
- Models Combo Loader (`EzFlex-ModelsCombo`)
- Resolution / Latent Selector (`EzFlex-FreeLatent`)
- Node Switch Master (`NodeSwitchMaster`)
- Node Switch Group (`NodeSwitchGroup`)
- Param Preset Control (`ParamPresetControl`)
- Param Preset Output (`ParamPresetOutput`)
- Preview Any (`EzFlex-PreviewAny`)
- Prompt Helper (`EzFlex-PromptHelper`)
- Media Loader (`EzFlex-MediaLoader`)
- Media Out (`EzFlex-MediaOut`)
- **11 nodes in total**

## Version history:
- V1.2.9: Fixed Preview Any reading incorrect image generation info (prompt text is now read through connected nodes); fixed Node Switch Group possibly failing to match nodes after being copied. The ModelsCombo trigger-words output port is now always present (empty without LoRA), so it no longer disconnects on a preset switch.
- V1.2.8: Preview Any (`EzFlex-PreviewAny`) supports batch image preview; the preview window behavior was improved.
- V1.2.7: Fixed the preview-image disappearing bug, improved black-label text rendering, updated to align with official node features.
- V1.2.6: Added the theme system, optimized the FreeLatent canvas, optimized tag previews, normalized data storage, cleaned up some redundant code, and fixed some bugs.
- V1.2.5: The tag system gained random tags; the default tag library is now bundled (it was missed last time); preview generation gained a cleanup action. ModelsCombo can auto-generate the trigger words of a loaded LoRA (shown live in PromptHelper), and the browser gained a "loaded models" view. Fixed black tag sub-nodes not showing and residue after fast moves. Overall edit supports collapsing individual cards.
- V1.2.4: Prompt Helper big update: new tag system / card manager; improved security.
- V1.2.3: Fixed some bugs, continued comprehensive security improvements, enhanced node features.
- V1.2.2: Fixed the `EzFlex-NodeSwitchGroup` dropdown bug; fixed the bug where `EzFlex-ParamPresetOutput`, `EzFlex-PreviewAny` etc. could not validate input after switching presets in `EzFlex-ParamPresetControl`; optimized where the custom size presets sit in `EzFlex-FreeLatent`. Fixed the unclickable controls in the Media Loader preview popup. Fixed Media Loader loading 3D models and preview images too slowly. Fixed PromptHelper's highlight logic.
- V1.2.1: Fixed the Node 2.0 click bugs in Prompt Helper (`EzFlex-PromptHelper`), Media Loader (`EzFlex-MediaLoader`) and Media Out (`EzFlex-MediaOut`). Prompt Helper (`EzFlex-PromptHelper`) and Node Switch Group (`NodeSwitchGroup`) gained collapsible rows. Comprehensive security hardening across the plugin.
- V1.2.0: Comprehensive security hardening; Main Control (`MainControl`) gained an EN / 中文 toggle.
- V1.11: Prompt Helper overhaul and bug fixes.
- V1.1: General node polish and performance work; Prompt Helper improvements; compatibility fixes.
- V1.05: Prompt Helper gained "reference media" and a stronger `@media` reference.
- V1.04: Added Media Loader (`EzFlex-MediaLoader`) and Media Out (`EzFlex-MediaOut`); Prompt Helper overhaul (still in development).
- V1.03: README cleanup; FreeLatent gained a "force override" button (ignore external width/height/batch); fixed the align default (multiples of 8); added the Prompt Helper node.
- V1.02: ModelsCombo gallery/search improvements.
- V1.01: ParamPresetControl preset switching + wiring fix.
- V1.0: First stable release.

## Install

Put this folder under `ComfyUI/custom_nodes/` and restart ComfyUI.

Dependencies: the plugin **only needs `mutagen` as an extra** (to read audio/video tags); the rest (torch / numpy / Pillow / safetensors / av) ships with ComfyUI; if you don't want to install it manually, run `pip install -r requirements.txt`. Optional: `llama-cpp-python` (Prompt Helper's "in-process llama-cpp-python" mode), `gguf` / `onnx` (model metadata cards for those two formats).

## Usage

Search for "EzFlex" in the ComfyUI node list and click to use.

## Node features

### Main Control (`MainControl`):

- Control: drives the overall node behavior. The **card list** (preset dropdown + drag to reorder) = Models Combo Loader (`EzFlex-ModelsCombo`), Resolution / Latent Selector (`EzFlex-FreeLatent`), Node Switch Master (`NodeSwitchMaster`), Param Preset Control (`ParamPresetControl`). All four expose their own "preset" interface; a master preset records their current presets together and pushes them down when switched. **Node Switch Group is not listed here separately** — it is managed by Node Switch Master.
- Presets: freely combine / save / delete overall node-behavior presets.
- Quick load: load other EzFlex nodes. Load all: Models Combo Loader / Resolution-Latent Selector / Node Switch Master / Node Switch Group / Param Preset Control / Param Preset Output / **Prompt Helper** / **Media Loader** / **Preview Any**; **Media Out (`MediaOut`) is loaded by Media Loader (`EzFlex-MediaLoader`) separately.
- Language: switch between Chinese and English.
- Theme: one palette switches every EzFlex panel (Light = your original palette / Lilac / Sage / Nord / Minimal / Caramel / Mist Blue / Deep Space / Morandi / Mermaid / Chocolate / Klein Blue / Cloud / Banana / Burgundy / Deep Teal). Lilac and Sage take the Radix Colors steps (the base of shadcn/ui); the rest keep their own official schemes; there is also a base layer for native controls, so input boxes and system select popups follow the theme's light/dark and text color. Palettes live in the theme module and the panels only write CSS variables, so a switch repaints all open panels immediately.

### Models Combo Loader (`EzFlex-ModelsCombo`):

- Combo loading: freely combine UNet / CLIP / VAE / Checkpoint / LoRA loaders.
- Presets: freely combine / save / delete model-loading setups.
- Preview: preview dropdown-list model covers.
- Gallery: gallery-style browsing to pick models. (Needs the ComfyUI-Lora-Manager plugin to generate JSON files via Civitai.)
- Outputs: ports are generated by the number (loader cards) and type; the LoRA loader chains after its selected target model, multiple LoRAs chain in card order, and port names look like `custom_name_model/clip/vae`.
- Order: reorder cards freely.

### Resolution / Latent Selector (`EzFlex-FreeLatent`):

- Canvas: drag freely to generate the matching empty latent; hold Ctrl to disable snapping.
- Width/height input: type width/height manually.
- Align resolution: computes width/height with the `Opt / Std` algorithm and the `resolution step`; it currently affects `manual width/height input, size-preset selection, and sizes derived from ratio and MP`.
- MP: megapixels.
- Ratio presets: width : height; choose built-in and custom ratio presets.
- Size presets: choose built-in and custom size presets; custom ones can be saved/deleted (`based on the current actual size`).
- Custom ratios: save / delete your own input ratio presets.
- Info panel: live actual width/height, ratio and MP.
- Inputs: external width/height, batch size.
- Outputs: empty latent, width/height, batch size.
- Force override: when green, external width/height/batch are ignored and the panel values win, and the controls are unlocked (available only when at least one input has a value).

### Node Switch Master (`NodeSwitchMaster`):

- Control: drives Node Switch Group behavior; freely combine / save / delete presets.

### Node Switch Group (`NodeSwitchGroup`):

- Control: switch grouped nodes between `on / off / bypass (ignore)`.
- Presets: freely save / delete node switch presets.
- Group matching: by name / by color, subgraph matching.
- Order: auto-sort cards by position / name.
- Note: presets are per node instance; deleting the node removes its presets.


### Param Preset Control (`ParamPresetControl`):

- Control: `green/red parameter buttons`: whether a parameter shows in the output list and in the parameter-group card dropdown. `Parameter group dropdown`: select the output parameter (all or a specific one).
- Presets: freely save / delete parameter-group presets.
- Parameters: eight types — int, float, bool, string, complex, tuple, list, set, dictionary.
- Order: parameter-group cards and parameter cards can both be dragged freely.
- Outputs: one output port per parameter-group card; multiple parameters are red, a single parameter is gray.

### Param Preset Output (`ParamPresetOutput`):

- Control: enable/disable parameter output; int->0, bool->false, float->0.0, string etc.->empty string.
- Type hint: shows the actual type; if the value does not match the type set in Param Preset Control (`ParamPresetControl`), it outputs string by default and is marked red.
- Value preview: click to open a preview popup.

### Preview Any (`EzFlex-PreviewAny`):

- Preview types: auto-detects any input type and renders the matching preview card (drag to reorder, cards are added/removed with connections).
- Save settings: when enabled, clicking saves, otherwise preview only; choose the save location and save options.
- Save types:

| Type | Accepts | Preview | Formats |
|---|---|---|---|
| IMAGE | tensor `[B,H,W,C]` | thumbnail + full-screen original (batch: thumbnail strip in the popup, saved frame by frame) | PNG / JPEG / WebP / BMP / TIFF |
| MASK | 2D/3D tensor | grayscale PNG | PNG |
| AUDIO | `{waveform,sample_rate}` or `(waveform,sr)` or a file object | player | WAV / MP3 / FLAC / OGG / M4A / AAC |
| VIDEO | `VideoFromFile` / `VideoFromComponents` object | first-frame cover + player | MP4 / WebM / MOV / GIF / AVI / MKV |
| CONDITIONING | dict with `conditioning/context` | text summary | — |
| LIST / TUPLE / SET | list / tuple / set | index-value tree (index:value) | JSON |
| DICT | dict | key-value tree (key:value) | JSON |
| STRING / INT / FLOAT / BOOLEAN | str / int / float / bool | text (truncated + full-text popup) | TXT / MD / JSON / CSV / LOG / HTML |
| LATENT | `{samples}` dict | shape / dtype summary | — |
| FILE_3D | `File3D` object (same as the built-in Load3D) | three.js viewer (offline) | glb / gltf / obj / fbx / splat |
| MODEL_3D | File3D object (with path/file) | three.js viewer (offline) | glb / gltf / obj / fbx / splat |
| MESH | `Types.MESH` (vertex/face tensors; Hunyuan3D / Trellis / MoGe etc.) | vertices/faces exported to a temp OBJ → three.js viewer | ≤500k vertices, ≤1M faces (summary only beyond that) |
| SPLAT / VOXEL | `Types.SPLAT` / `Types.VOXEL` (tensors) | text summary (point count / SH coefficients / voxel resolution) | — |
| MODEL | ModelPatcher | model metadata card | safetensors / gguf / onnx / ckpt / pt |
| CLIP | comfy.sd CLIP | metadata card | safetensors / gguf / onnx |
| VAE | comfy.sd VAE | metadata card | safetensors / gguf / onnx |
| CONTROL_NET / CLIP_VISION / STYLE_MODEL / UPSCALE_MODEL / LORA_MODEL / GLIGEN / SAMPLER / SIGMAS / GUIDER / NOISE / SEGS | the matching ComfyUI object | text summary | — |
| EMPTY | not connected | "(not connected)" | — |

- Preview method: data preview popup / generation info.
- Image batches: a card exports up to 64 frames (extra frames are counted only); saving writes one file per frame as `name_<timestamp>_NN`. Batches and video frame sequences are indistinguishable from the tensor, so the badge follows the upstream node class name (video/frame/sequence…) and shows images / frames.

### Prompt Helper (`EzFlex-PromptHelper`):

- Cards: add/remove / drag to reorder / double-click to rename; each card has "Default / Optimized prompt" pages and a "merge" switch (green = merged, gray = not merged).
- Editor: Word-style toolbar (bold / italic / underline / strikethrough, alignment, font size, text color, highlight, first-line indent, find & replace, color picker, full/half-width conversion) + a skill button (pick a `*.md` and insert it line by line at the caret).
- Reference media: reads media ports of generator nodes on the canvas and numbers them as `@图片N` / `@视频N` / `@音频N` by port; the "reference media" window lists assets grouped by generator node, with + insert / − remove / right-click "set as the global reference library".
- Prompt specs: 15 built-in specs under "Settings · Rules" ("Do not compile", "Use API" + 13 vendor specs) + custom ones (editable and saveable, with Chinese/English variants and a 中|EN switch), compiling reference markers into each vendor's syntax (`<Picture 1>`, `@image1` …).
- Optimize: the Tools dropdown "Optimize prompt (API) / (TextGenerate) / (llama)"; use once, or enable "runtime auto-optimize"; the three switches are mutually exclusive and failures raise an error.
- Card management: save cards as presets (`user/EzFlex/prompts/<name>.json`; all EzFlex config lives under `user/EzFlex/`); save only selected cards, click to load, delete.
- Ports: no CLIP input — a dynamic "combo media" port (ANY: image/video/audio/3D) + one text input port per card; outputs "merged prompt" + one per card.
- Settings: six tabs — General / Rules / API / TextGenerate / llama / Paths; scan dirs, selected models and custom providers persist globally.
- Panel header buttons: Overall edit / Settings / Card management / + New prompt card.
- Mode: the header's "⧉ Tiled / 🗗 Popup" toggles the window form.

#### Optimize / Default / Card / Overall edit: behavior rules

> Two slider layers: the card popup's "Default / Optimized" only governs that card's output port; the one in **Overall edit** governs the "merged prompt" port. The optimized contents of the two layers live in separate slots and never overwrite each other.

**1. Tool optimize**

- Card popup "Tools → Optimize prompt": the source is **always that card's "Default" tab**; the result is written into that card's "Optimized" slot and the slider flips to Optimized — the default text is not touched.
- Overall edit "Tools → Optimize prompt": source = the cards' **"Default" bodies** joined in order with the "card merge separator" (merge-gray and empty cards take no place), in a **single call**; the result is written into "overall optimized result" and the overall slider flips to Optimized — original card contents are unchanged.
- Both follow the same table (has/none → fill/overwrite):

| Slider | Default | Optimized | Behavior |
|---|---|---|---|
| Default / Optimized | has | none | Optimize from the default prompt → fill the optimized slot, flip the slider to Optimized |
| Default / Optimized | has | has | Optimize from the default prompt → **overwrite** the optimized slot (manual edits are not kept) |
| any | empty | has / none | Pop "This card has no prompt content to optimize." |

**2. Runtime optimize — any one of the three auto-optimize switches is on**

> If auto-optimize fails (API / TextGenerate / llama error) it **stops with an error immediately**. The optimized slots are "memory": if they have content, **no call is repeated**; only an empty slot is filled.

*Overall layer → "merged prompt"* (source = the **default** bodies of merge-green cards joined with the card merge separator)

| Overall slider | Default | Optimized | Behavior |
|---|---|---|---|
| any | has | none | Optimize overall once → write into "overall optimized result" → flip the slider to Optimized → output it |
| Optimized | has/empty | has | Output "overall optimized result" directly (**no re-optimize**), slider unchanged |
| Default | has | has | Output the **default merge** (the optimized version is kept but unused, and is not regenerated), slider unchanged |
| Default | empty | has | Output "overall optimized result", flip the slider to Optimized |
| any | empty | empty | Output empty (the user wrote nothing), slider unchanged |

*Each card → "card i" port*

- **Merge = green** (goes into the merge): **not optimized separately** at runtime — strictly follows that card's slider (Default outputs default, Optimized outputs optimized); **pointing at an empty slot outputs empty** (no fallback). The card list marker follows the slider ("Opt" / "Def").
- **Merge = gray** (not in the merge): **optimized on demand** at runtime (the result only goes to its own port):

| Slider | Default | Optimized | Card port |
|---|---|---|---|
| any | has | none | Optimize once from the default → fill the card's optimized slot → port = result, flip the slider to Optimized |
| Default | has | has | port = default (the optimized version is kept but unused, and is not regenerated), slider unchanged |
| Optimized | has | has | port = optimized version (no re-optimize), slider unchanged |
| any | empty | has | port = optimized version (no re-optimize); if the slider is on Default it flips to Optimized |
| any | empty | empty | port = empty, slider unchanged |

- Port count = cards + 1 (port 0 is "merged prompt", then "card 1..N", all STRING); ports change with card add/remove/reorder.
- When `card_in_i` is connected to external text it overrides that card (the card is grayed out in the panel), and it also takes part in merging and optimizing.

**3. All three switches off** (no optimize calls; the same "strictly follow the slider, empty stays empty" rules)

- **Overall edit**: slider on **Default** → output the **default merge** (each card's default body, filtered by the merge switch; gray cards are not merged); on **Optimized** → output "overall optimized result". Empty stays empty — no fallback, no padding.
- **Each card** (merge green or gray, same rule): Default → that card's default body; Optimized → that card's optimized content; empty stays empty.
- The card slider **does not affect** the "merged prompt" — the merged port only takes the cards' default bodies (which is also why a card's optimized content only travels through its own port).

**4. Where does spec compilation (reference media) happen?**

- The text sent to the API / TextGenerate / llama is the **uncompiled original** (your `@图片1` / `@视频1` / `@音频1`); the system prompt explicitly asks the model to **keep these markers as-is** (no translation, no rewriting, no renumbering).
- The two optimized slots (that card's "optimized prompt" / "overall optimized result") also store the **model's raw text** (uncompiled) — another spec can still recompile without losing the mapping.
- **Only output ports go through spec compilation**: the `card i` port, and the default merge / overall optimized content used by "merged prompt"; compilation is idempotent.
- If the model **kept** `@图片1` → the output automatically becomes that spec's syntax (e.g. `<Picture 1>`); if the model **translated/rewrote** it into natural language ("the first image") → the marker is gone and no compilation can bring it back (a strict system prompt lowers the chance, or use a model that follows instructions better).

### Media Loader (`EzFlex-MediaLoader`):

- Presets: save / delete group and card-group state and names.
- Parameters: cards per row, card height multiplier (default 1).
- Groups / card groups / media cards: drag to reorder, double-click to rename, context menu, long-press drag to merge, hover info, click to preview, delete.
- Browsing: file-explorer style (directory tree, back/forward/up/refresh, manual path input, search, batch selection).
- Outputs: one port per card, of the dedicated type EZFLEX_MEDIA_CARD (dark red) — it carries a "card object", not a media value, so it only connects to EzFlex-MediaOut (this blocks accidental wiring into built-in nodes); for real media values connect MediaOut.
- Loadable types: image / video / audio / 3D model / text / other; output values match ComfyUI's built-in loaders and can feed standard nodes directly.
- Supported extensions: image .png .jpg .jpeg .webp .gif .bmp .tif .tiff | video .mp4 .webm .mov .mkv .avi .m4v | audio .mp3 .wav .flac .ogg .aac .m4a .opus .wma | 3D .obj .glb .gltf .fbx .stl .ply .spz .splat .ksplat .3ds .dae .blend | text/other → STRING (text gives the file content, other gives the path).
- Top bar "Load output": creates an EzFlex-MediaOut and wires it in one click.

> ⚠️ **Be careful with the root (browsable root) setting — while ComfyUI is exposed to a LAN / the internet it decides "which of your files others can see"**
>
> The media browser can only browse ComfyUI's own `input` / `output` by default. To reach other folders, type a path in the toolbar → click "Save root" to **explicitly register that folder as a root**.
>
> **Precondition (this decides whether there is any risk)**: only people who **can reach your ComfyUI port** can see these roots.
> - Listening on `127.0.0.1` (localhost, the default) → outside machines cannot connect, so **adding roots only affects you**; no need to worry;
> - Running with `--listen 0.0.0.0` to the LAN (some all-in-one packages do this by default), a tunnel, or a reverse proxy exposed to the internet → others on the same network / internet visitors can list and download files inside **the roots you registered and their subdirectories**.
>
> Keep the exposure controlled and adding roots is safe:
> - **Do not expose ComfyUI to untrusted networks** (the most fundamental rule). If you must expose it, only register **specific media folders**: do not register a drive, your home directory or a project root. The plugin itself also refuses to register a **whole drive** (`C:\`, `D:\`, `/`), and legacy whole-drive entries are ignored and cleaned up automatically.
> - **Registering / deleting is local-only** (loopback + same-origin), so neither others nor web scripts can extend your permissions for you; but **"reading" is not local-only** — the precondition above is its boundary.
> - **Delete when done**: select that root in the dropdown → click "Delete root". The built-in `input` / `output` cannot be deleted (the delete button greys out when they are selected).
> - **Nested entries are deleted one by one**: if both `D:\media` and `D:\media\videos` are registered, the dropdown has two entries and deleting one does not delete the other.
> - You can also avoid this whole mechanism: only use assets under `input` / `output`, and put your files there.

### Media Out (`EzFlex-MediaOut`):

- Input: a single input (dedicated type `EZFLEX_MEDIA_CARD`), connected to one of `EzFlex-MediaLoader`'s card ports.
- Outputs: neutral ports colored/typed by the real file type — IMAGE / VIDEO / AUDIO / FILE_3D / STRING (same as the built-in loaders, so they can feed standard nodes directly).
- Modes: split / card / card group / group (switched by the buttons at the top of the panel); split → one port per file; card / card group / group → merged into one port by structure.
- Merging: multiple images → a batched tensor `[B,H,W,C]` (feeds any IMAGE input, and can be split again with the built-in `ImageFromBatch` / `RebatchImages`); multiple audio clips → joined in time into one track (sample rates must match; mono is upmixed to multi-channel automatically); multiple texts → joined with newlines; mixed types / mismatched sample rates → an error telling you to use "split" (the port degrades to `*`, and its hover label shows `×N` for the number of files).
- Batch settings (shown in card / card group / group mode, aligned with KJNodes `Load Images From Folder`): target size `first image` / `custom size`, fit `crop` / `pad` / `stretch`, `max images` (0 = all), `start at` (0-based); when size / channels differ, they are aligned by the rule before merging (the console prints which rule was used).
- Switches: each can be toggled on/off; in split mode a disabled file keeps its port and outputs `None` (no rewiring when re-enabling); in the other modes disabling removes it from the group. **At runtime** (before the prompt is submitted) an input that is "disabled but still connected" is removed from the **submitted prompt** — downstream sees "not connected" (optional inputs use their own default; required inputs are caught by validation with a clear error), and **neither the canvas wiring nor the saved workflow is touched**; queueing directly through the HTTP API (bypassing the frontend) still sends `None`.
- Paging: page navigation.

## Directory structure

```
Comfyui-EzFlex-Presets/
├── __init__.py          # all 11 node classes + preset routes + output-type sync routes
├── pyproject.toml
├── README.md            # English README (default home page)
├── README_ZH.md         # Chinese README
├── user_data/           # preset library (written at runtime by the plugin): EzFlex-ModelsCombo.json / EzFlex-FreeLatent.json /
│                        #   EzFlex-NodeSwitchMaster.json / EzFlex-NodeSwitchGroup.json /
│                        #   EzFlex-MainControl.json / EzFlex-ParamPresetControl.json
│                        # Note: these are generated at runtime by the preset routes; any extra files on your
│                        #   machine (e.g. EzFlex-PreviewAny.json) are local runtime data, not shipped/fixed files.
├── locales/zh/nodeDefs.json  # official i18n: Chinese node names / descriptions / tooltips
└── web/
    ├── modelscombo_node.js  # ModelsCombo embedded panel (addDOMWidget)
    ├── freelatent_node.js   # FreeLatent embedded canvas resolution picker
    ├── ezflex_service.js    # shared: node registry / group matching / node.mode / preset API / dialogs
    ├── ezflex_i18n.js       # panel i18n: ezT(key) + Chinese dictionary (English is the source)
    ├── ezflex_theme.js      # theme: 16 palettes → shared CSS variables (--ez-*), live for the whole canvas
    ├── node_switch_group.js # NodeSwitchGroup panel
    ├── node_switch_master.js# NodeSwitchMaster panel
    ├── main_control.js      # MainControl panel
    ├── param_preset_control.js # ParamPresetControl panel + dynamic ports
    ├── param_preset_output.js  # ParamPresetOutput panel + dynamic ports
    ├── preview_any.js          # PreviewAny board + draggable cards + dynamic sockets + previews
    ├── prompt_helper.js        # PromptHelper panel (in development)
    ├── media_loader.js         # MediaLoader panel (groups/cards/media/preview/presets + dynamic ports)
    ├── media_out.js            # MediaOut panel (file list + enable switches + type-colored ports)
    ├── ezflex_media_index.js   # media numbering engine (scans generator nodes' media input ports → image N / video N / audio N + <Picture N>)
    └── libs/ utils/ curves/    # three.js and loader/curve resources (local offline, for the PreviewAny 3D viewer)
```

## Dependencies
- shipped with comfyui
torch
numpy
Pillow
safetensors
av

- extra required by this plugin: read audio/video tags and container metadata
mutagen>=1.46.0

- Optional: needed by Prompt Helper's "Settings · llama settings → in-process (llama-cpp-python)" — **not written into requirements (to avoid ComfyUI-Manager forcing a compile at install time, which often fails on Windows)**; install manually when needed:
```
pip install llama-cpp-python
```

- Optional: only needed to read the corresponding model file formats (.gguf / .onnx); without them that file's "model metadata card" is skipped; also manual:
```
pip install gguf onnx
```

> You can also install all optional dependencies at once with the pyproject extras: `pip install -e .[llama,metadata]`

