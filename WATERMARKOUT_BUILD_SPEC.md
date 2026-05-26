# WatermarkOut — Technical Architecture

> Authoritative spec of how the app is built today. Companion to the user-facing [README](README.md).

---

## Architecture at a glance

```
┌────────────────────────────────────────────────────────────────┐
│  Browser tab                                                   │
│                                                                │
│  index.html                                                    │
│   ├─ coi-bootstrap.js  ────► registers sw.js, reloads if not   │
│   │                          cross-origin isolated             │
│   │                                                            │
│   └─ app.js (ES module)                                        │
│         ├─ uploads/UI ──► upload.js  (drag, validate)          │
│         ├─ mask drawing  ► mask.js   (canvas brush/rect)       │
│         ├─ inpaint       ► inpainter.js  ──► ONNX Runtime Web  │
│         │                                  │                   │
│         │                                  ▼                   │
│         │                            [MI-GAN 512×512]          │
│         │                                  │                   │
│         │                                  ▼                   │
│         │                            Composite back            │
│         │                                                      │
│         ├─ video        ──► video.js (decode + capture)        │
│         ├─ model cache  ──► model-cache.js (IndexedDB)         │
│         ├─ folder pick  ──► fs-folder.js (File System API)     │
│         └─ UI shells     ──► toast.js, debug.js, updates.js    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                          │
                          ▼ first-load only
            ┌─────────────────────────────────┐
            │ Hugging Face CDN (model fetch)  │
            │   29 MB MI-GAN ONNX file        │
            └─────────────────────────────────┘
```

After first load, **no network calls happen** during use. Model is in IndexedDB; app shell is in the Service Worker cache.

---

## Tech stack

| Layer | Technology | Reason |
|---|---|---|
| Frontend | Vanilla HTML + CSS + ES modules | Zero build step, easy to fork |
| AI inference | ONNX Runtime Web 1.20+ | Cross-browser ML in WebAssembly |
| Inpainting model | [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) (ICCV 2023) | Designed for mobile/browser; 29 MB |
| Storage (model) | IndexedDB | Persistent on user's disk; quota-friendly |
| Storage (app shell) | Cache API (via Service Worker) | Offline support |
| Optional storage | File System Access API | User-picked folder (Chromium browsers) |
| Cross-Origin Isolation | Service-worker header injection | Enables WASM threads + WebGPU |
| Hosting | GitHub Pages (or any static host) | Free, no maintenance |
| Model hosting | Hugging Face public repo | Free CDN for the 29 MB file |

---

## The model

**MI-GAN** (Multi-scale Inpainting GAN, Picsart Research, ICCV 2023).

| Spec | Value |
|---|---|
| File | [`migan.onnx`](https://huggingface.co/lxfater/inpaint-web/blob/main/migan.onnx) |
| Size | 29.5 MB (float32) |
| Input | `[1, 4, 512, 512]` float32 — **fixed shape** |
| Output | `[1, 3, 512, 512]` float32 in `[-1, 1]` |
| Opset | 12 |
| Producer | PyTorch 1.8 |

### Exact preprocessing (matches Picsart's `demo.py`)

```python
# Image to [-1, 1]
img_norm = img * 2 / 255 - 1

# Mask: 1 = KEEP, 0 = INPAINT (inverse of LaMa convention!)
mask_norm = (mask > 0).float()

# 4-channel input
x = concat([mask_norm - 0.5, img_norm * mask_norm], axis=channel)
```

In JS (`inpainter.js → buildMIGANInput`):

```js
const isInpaint = maskAlpha > 64;
const mask = isInpaint ? 0.0 : 1.0;
const r = (R / 255) * 2 - 1;  // [-1, 1]
// Channel 0: mask - 0.5
// Channel 1: r * mask  (zeroed in hole)
// Channels 2, 3: same for G, B
```

### Postprocessing

```js
const pixel = clamp((output * 0.5 + 0.5) * 255, 0, 255);
```

This was discovered by reading [Picsart's `scripts/demo.py`](https://github.com/Picsart-AI-Research/MI-GAN/blob/main/scripts/demo.py) — every value above was determined incorrectly the first time and corrected after.

---

## Image pipeline

```
input image (any size)
       │
       ▼
find user's mask bbox  ──► no mask? return original
       │
       ▼
build square crop centered on bbox, with context (≥512 px or 3× mask dim)
       │
       ▼
resize crop to 512×512  ◄── model is fixed at 512×512
       │
       ▼
build [1,4,512,512] float32 tensor  ◄── see preprocessing above
       │
       ▼
session.run({ input: tensor })
       │
       ▼
output [1,3,512,512] float32 in [-1, 1]
       │
       ▼
convert to RGBA ImageData
       │
       ▼
resize back to crop dimensions
       │
       ▼
pasteCropWithMask: binary alpha + feathered edge → composite into original
       │
       ▼
result: original everywhere EXCEPT inside mask
```

**Key invariant:** 95%+ of the image is byte-identical to the original. Only the masked pixels are replaced. This is enforced by the `pasteCropWithMask` function, which binarizes the user's translucent brush alpha to `0 or 255` before feathering — preventing the "35% bleed-through" bug we had earlier where the original watermark was visible through the result.

---

## Video pipeline

Static-mask optimization (the only viable approach for browser CPU):

```
load video metadata
       │
       ▼
grab frame 0 → canvas
       │
       ▼
user draws mask (same UI as image)
       │
       ▼
click Remove
       │
       ▼
Run MI-GAN on frame 0 only  ◄── the one expensive step
       │
       ▼
Extract the inpainted pixels for the mask area → patchCanvas
       │
       ▼
Play video at 1× speed, requestVideoFrameCallback per frame:
       ├── draw current video frame to output canvas
       └── draw patchCanvas on top (only masked pixels visible)
       │
       ▼
MediaRecorder captures canvas + source audio in real time
       │
       ▼
Blob → playable <video> element
```

**Why 1× playback** (not seek-loop): MediaRecorder records in wall-clock time. A seek-loop running faster than real-time produces malformed output (slideshow / wrong fps). Playback at 1× guarantees identical output duration + frame rate.

**Trade-off:** the patch is static across all frames. Perfect for static watermarks (95% of cases). For moving content behind the watermark, the patch may look out of place. Per-frame AI is unusable in browser (75+ minutes for a 10s clip).

---

## Cross-Origin Isolation

Required for:
- WebAssembly threads (massive speedup)
- WebAssembly SIMD
- WebGPU (10–30× speedup when available)

How we get it: a single Service Worker (`sw.js`) intercepts every same-origin response and injects:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

`coi-bootstrap.js` runs synchronously in `<head>` and ensures the SW is registered and controlling the page. If not, it reloads once (capped at 3 attempts).

---

## Storage layout

| What | Where | Why |
|---|---|---|
| Model file (29 MB) | IndexedDB (`watermarkout` DB, `models` store, key `migan_v1`) | Persistent; survives reloads but cleared if user clears site data |
| App shell (HTML/CSS/JS) | Cache API (Service Worker, key `watermarkout-v2.x.x`) | Offline support |
| Folder handle (optional) | IndexedDB (`watermarkout-fs` DB) | Restores user-picked disk folder across visits (Chromium browsers only) |
| User images / videos | In-memory only | Never persisted, never uploaded |

---

## File responsibilities

| File | Lines | Role |
|---|---|---|
| `index.html` | ~270 | App shell + DOM scaffolding |
| `about.html` | ~165 | About page (DiceCodes branding) |
| `offline.html` | ~22 | Fallback when SW + cache miss |
| `sw.js` | ~110 | Service Worker: app cache + COI header injection |
| `manifest.webmanifest` | ~50 | PWA manifest for installability |
| `css/app.css` | ~1000 | Design system + all UI styles |
| `css/about.css` | ~250 | About-page-specific styles |
| `js/coi-bootstrap.js` | ~60 | Pre-module sync script for COI registration |
| `js/app.js` | ~600 | Main controller, wires everything together |
| `js/inpainter.js` | ~250 | ONNX Runtime Web wrapper, MI-GAN pre/post |
| `js/model-cache.js` | ~180 | IndexedDB model caching + integrity check |
| `js/mask.js` | ~170 | Canvas brush / rect / eraser + undo stack |
| `js/upload.js` | ~120 | Drag-drop, file validation, image-data extraction |
| `js/video.js` | ~210 | Video decode → patch composite → MediaRecorder encode |
| `js/fs-folder.js` | ~140 | File System Access API integration |
| `js/debug.js` | ~110 | Diagnostic helpers (no UI bound) |
| `js/toast.js` | ~80 | Notification system |
| `js/updates.js` | ~70 | SW update banner |
| `js/version.js` | 3 | APP_VERSION + constants |

---

## Performance targets

| Operation | WebGPU | WASM (threads) | WASM (single) |
|---|---|---|---|
| Model load (cached) | <1 s | <1 s | <1 s |
| Model load (first download) | ~30 s | ~30 s | ~30 s |
| Image inpaint | 1–3 s | 5–10 s | 15–30 s |
| Video (10 s clip) | ~12 s | ~25 s | ~75 min |

Single-threaded WASM time depends on whether Cross-Origin Isolation is active. If it isn't, the page falls back to single-thread and video becomes impractical — that's why `coi-bootstrap.js` is so insistent about reloading.

---

## What this app is NOT

- ❌ Not a desktop application (no Electron, no installer with code signing)
- ❌ Not a cloud service (no backend, no server)
- ❌ Not Python (we tried; abandoned for browser-only)
- ❌ Not using LaMa (we tried; MI-GAN is better for browser)
- ❌ Not using per-frame AI for video (unusable in browser — static-mask only)

If you need any of those, see:
- [IOPaint](https://github.com/Sanster/IOPaint) — Python server with LaMa + other models
- [D-Ogi/WatermarkRemover-AI](https://github.com/D-Ogi/WatermarkRemover-AI) — Python desktop, per-frame video

---

## Decisions journal

(For anyone reading the source wondering why X is X.)

| Why | What |
|---|---|
| We use MI-GAN, not LaMa | LaMa is 200 MB and trained on broader masks. MI-GAN is 29 MB and trained specifically on incremental brush strokes (i.e., watermarks). |
| Input is fixed 512×512 | Verified by `onnx.load()` on the actual file. Inpaint-web's TS code suggesting dynamic shapes was misleading — the model file is fixed. |
| Crop around mask before resize | At 512×512 the watermark area gets much higher effective resolution than scaling the whole image. The non-masked 95% stays original-quality via composite. |
| Static-mask video, not per-frame | Per-frame is unusable in browser (10s of inferences per second of video × 10s/frame on WASM). |
| Service Worker handles COI | GitHub Pages doesn't support custom headers. SW injection is the standard workaround. |
| No build step | Anyone can fork + edit + see changes immediately. Lower barrier to contribution. |
| No npm dependencies | One less thing to break. CDN-hosted ORT is the only external runtime dep. |

---

## See also

- [README.md](README.md) — user docs
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup
- [LICENSE](LICENSE) — MIT
