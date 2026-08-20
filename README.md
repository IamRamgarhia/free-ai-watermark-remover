<div align="center">

<img src="static/assets/logo.svg" alt="WatermarkOut" width="380"/>

# WatermarkOut

### A watermark remover that runs on your machine, not someone's server.

**Free · Private · Open Source · Runs entirely in your browser**

[![License: MIT](https://img.shields.io/badge/License-MIT-success.svg?style=flat-square)](LICENSE)
[![Made in India](https://img.shields.io/badge/Made%20in-India%20🇮🇳-orange?style=flat-square)]()
[![PWA](https://img.shields.io/badge/Progressive%20Web%20App-7c3aed?style=flat-square&logo=pwa&logoColor=white)]()
[![No telemetry](https://img.shields.io/badge/Telemetry-zero-success?style=flat-square)]()
[![Stars](https://img.shields.io/github/stars/IamRamgarhia/free-ai-watermark-remover?style=flat-square&color=yellow)](https://github.com/IamRamgarhia/free-ai-watermark-remover/stargazers)
[![Issues](https://img.shields.io/github/issues/IamRamgarhia/free-ai-watermark-remover?style=flat-square)](https://github.com/IamRamgarhia/free-ai-watermark-remover/issues)

[🚀 **Try it live**](https://iamramgarhia.github.io/free-ai-watermark-remover/) · [📥 Install Guide](INSTALL.md) · [💡 Why](#-why-it-exists) · [🛠 Deploy your own](#-deploy-your-own) · [🤝 Contribute](CONTRIBUTING.md)

<br>

<img src="static/assets/hero-illustration.svg" alt="WatermarkOut app interface preview" width="100%"/>

</div>

---

WatermarkOut finds and removes visible watermarks from AI-generated images (**Google Gemini**, **Bing Image Creator**, **Meta AI** and others) and short videos — **entirely client-side**. The AI model runs in your browser via WebAssembly. Your files never touch any server. There is no server.

---

## 🚀 Quick start

There are **3 ways** to use WatermarkOut. Detailed steps for each in [**INSTALL.md**](INSTALL.md).

### 1️⃣ Easiest: just open the link

👉 **[https://iamramgarhia.github.io/free-ai-watermark-remover/](https://iamramgarhia.github.io/free-ai-watermark-remover/)**

1. Open the link
2. Drop in an image or video
3. Click **Detect watermark**, or draw your own rectangle
4. Click **Remove watermark**
5. Download the clean file

That's it. The file never left your browser.

### 2️⃣ Install as a real desktop app (PWA)

Visit the URL → your browser shows an "Install" icon in the address bar → click it → **WatermarkOut now has a real desktop icon and opens in its own window**. Works on Windows, macOS, Linux, iOS, Android. Zero downloads from any app store.

[📥 Full install steps per OS in INSTALL.md →](INSTALL.md#b-install-as-a-progressive-web-app-pwa--gets-a-real-desktop-icon)

### 3️⃣ Run locally (developers, offline forever, self-host)

```bash
git clone https://github.com/IamRamgarhia/free-ai-watermark-remover.git
cd free-ai-watermark-remover/static
python -m http.server 8000
# Open http://localhost:8000
```

No build step. No npm install. No compilation. Just static files.

[📥 Step-by-step in INSTALL.md →](INSTALL.md#c-run-it-locally-on-your-machine-developers-offline-forever-self-host)

---

## 💡 Why it exists

Most online watermark removers upload your private photos to a server you don't control, charge a monthly subscription, and stamp their own watermark on the free tier. WatermarkOut runs the AI **inside your browser tab** — and because the source is MIT-licensed, you can verify that rather than trust it.

- ✅ Free forever — costs $0 to host on GitHub Pages
- ✅ Open source under MIT — fork, audit, modify
- ✅ Works offline after first visit
- ✅ Zero accounts, zero telemetry

---

## ✨ Features

| | |
|---|---|
| 🖼 Image watermark removal | JPG, PNG, WEBP, BMP — up to 100 MB |
| 🎬 Video watermark removal | MP4, WEBM, MOV — audio preserved, real-time playback preview |
| 🤖 MI-GAN inpainting | Picsart Research ICCV 2023 model, 29 MB |
| ⚠️ Honest about limits | Removing the badge does **not** remove SynthID — see the [guide](static/guide.html) |
| 🔍 Auto watermark detection | Finds the badge instead of assuming where it is |
| 🎨 Manual masking | Rectangle, brush, eraser, undo — mouse **or** keyboard |
| ♻️ Recovery, not repaint | Solves for the picture under a see-through watermark |
| 🔄 BEFORE/AFTER compare | Toggle to see original vs cleaned |
| 🔒 Offline after first load | Your files are never uploaded; the app works with no connection |
| 📱 Installable PWA | Desktop icon, standalone window, offline support |

---

## 🖥 System requirements

- Any browser supporting WebAssembly + Service Workers:
  - Chrome / Edge 90+
  - Firefox 90+
  - Safari 16.4+ (macOS / iOS)
- ~250 MB free storage (model + app cache)
- WebGPU is auto-detected and used when available (huge speedup); falls back to WASM multi-threaded otherwise

---

## 🧩 How it works (technical)

```
┌─────────────────────────────────────────────────────────────┐
│  Your Browser Tab                                           │
│                                                             │
│  [Image] → [Canvas mask] → [MI-GAN AI (WebAssembly)]        │
│     │                            │                          │
│     │                            ▼                          │
│     └─────────────────→ [Composite result] ──→ ⬇ Download  │
└─────────────────────────────────────────────────────────────┘
                       ↑
              No server. No upload. No exit point.
```

**The model**

- [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) (Picsart Research, ICCV 2023). A GAN-based inpainting model designed specifically for **mobile / browser deployment**.
- Exported to ONNX (29 MB) and hosted on [Hugging Face](https://huggingface.co/lxfater/inpaint-web/blob/main/migan.onnx).
- Runs via [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) with WebGPU → WebGL → WASM fallback chain.
- Cached in IndexedDB after first download — never re-downloads.
- Pinned by SHA-256. The model comes from a third-party repo and is then executed, so the bytes are verified before use (and before caching). A mismatch aborts the load rather than running unknown code.

**The pipeline** (matches Picsart's official Python `demo.py`):

1. Find user's mask bounding box; crop image with context.
2. Resize crop to model's fixed 512×512.
3. Normalize image to `[-1, 1]`, mask to `1=keep / 0=inpaint` (yes, the polarity is inverted from LaMa).
4. Build 4-channel input: `[mask-0.5, R*mask, G*mask, B*mask]`.
5. Run model. Output is `[-1, 1]` float32; map to `[0, 255]` via `(v * 0.5 + 0.5) * 255`.
6. Composite into original at full resolution — only masked pixels are replaced, rest stays pixel-identical.

**How removal actually works (two stages)**

Most generator badges are *semi-transparent*, which means the picture underneath
them was never destroyed — it was blended:

```
observed = alpha x watermark + (1 - alpha) x original
```

That inverts. So stage one estimates `alpha` per pixel (using a smooth
interpolation of the surroundings purely as a baseline) and solves for the
original. Texture — wood grain, skin, brick — comes back out of the real data
instead of being repainted. Measured against ground truth on synthetic tests this
scores 7-12 dB higher than filling the area with neighbouring colour.

Stage two runs MI-GAN on whatever stage one could *not* recover: the fully opaque
core, where no information about the original survives. For a typical translucent
badge that residual is a few percent of the mask, and often nothing at all — in
which case no pixels are invented anywhere.

Set the mode to **Object / opaque logo** to skip stage one. Un-blending assumes
the mask covers a translucent overlay; pointed at a solid object it would solve
for meaningless values, so object removal goes straight to generative fill.

**Finding the watermark**

Earlier versions hardcoded each generator's badge as a fraction of the image
("Gemini sits at 89% across, 89% down"). Those were guesses, and they could not
survive a different aspect ratio or a restyled badge — in practice they drew the
mask *beside* the watermark.

**Detect watermark** now searches for it instead. A badge is a vector graphic
composited over finished content, so it is compact, corner-anchored, and lighter
or darker than its immediate surroundings in a way ordinary texture is not. The
detector blurs at two scales and subtracts (a band-pass), thresholds adaptively,
and scores the resulting blobs on size, compactness, contrast and corner
proximity. No templates to maintain, and it catches badges we have never seen.

It *proposes* a box rather than applying one silently, because it can be fooled by
a genuinely badge-like object in a corner — hence "Not it? Try next".

**Quality**

The crop fed to the model is 512x512 at native resolution wherever the mask fits,
so pixels go in and come back untouched. Quality therefore controls refinement
passes, not crop scale: **Standard** is one pass, **High** is two.

**Cross-Origin Isolation**

A service worker injects COOP / COEP headers so the page is `crossOriginIsolated`. This unlocks WebAssembly multi-threading + SIMD + WebGPU. Without it, inference is single-threaded WASM (~5× slower).

**Content Security Policy**

Both pages ship a CSP that pins which origins may serve code and data, and the
ONNX runtime is loaded with a Subresource Integrity hash. `script-src` allows
`blob:` because ONNX Runtime runs inference in a Worker it builds at runtime —
without it the WASM backend fails outright.

---

## 🛠 Deploy your own

### Option 1: GitHub Pages (recommended — free forever)

1. Fork or clone this repo.
2. Push to your own GitHub.
3. **Settings → Pages → Source: Deploy from a branch → `main` / `/static`**
4. Your site is live at `https://<username>.github.io/watermarkout/`.

### Option 2: Cloudflare Pages / Netlify / Vercel

Connect the repo, set the publish directory to `static/`, deploy. All free for static sites.

### Custom domain

1. Create a `CNAME` file in `static/` containing your domain (e.g. `watermarkout.dicecodes.com`).
2. Add a DNS CNAME record pointing to `<username>.github.io`.
3. Free HTTPS is auto-provisioned by GitHub Pages.

---

## 🧑‍💻 Local development

```bash
# Just serve the static/ folder over HTTP. ANY static server works.
cd static
python -m http.server 8000
# Then open http://localhost:8000
```

There is **no build step**. No Node, no npm, no bundler. Edit a file, refresh, see the change. The Service Worker is registered at first visit; for code changes during dev:
- `Ctrl+R` — pick up code changes (preserves the cached AI model)
- `Ctrl+Shift+R` — hard refresh (bypasses Service Worker; will redownload model)

> The Service Worker is **cache-first**. If an edit doesn't seem to take effect,
> it's serving the cached copy — use DevTools → Application → Service Workers →
> *Unregister*, or bump `CACHE_VERSION` in `sw.js`.

### Tests

Two scripts, no dependencies and nothing to install — plain Node:

```bash
node tools/test-inpainter.mjs   # pixel-math regression tests
node tools/check.mjs            # cross-file consistency checks
```

`test-inpainter.mjs` covers the tensor math (mask polarity, `[-1,1]`
normalization, planar CHW layout, bbox detection). That code fails *silently*
when it breaks — wrong colours or a bleed-through watermark, never an
exception — so it's the one part that genuinely needs tests.

`check.mjs` catches the drift a no-build-step project can't otherwise notice:
version strings disagreeing across four files, assets referenced but missing
from the Service Worker precache, stale repo links, external scripts without an
integrity hash, and `getElementById()` calls pointing at markup that doesn't
exist. Both run in CI on every push and pull request.

---

## ⌨️ Keyboard shortcuts

| Key | Action |
|---|---|
| **R** | Rectangle tool |
| **B** | Brush tool |
| **E** | Eraser tool |
| **Space** | Toggle BEFORE / AFTER compare |
| **Ctrl+Z** | Undo brush stroke |
| **Esc** | Start over (with confirm) |
| **D** | Download result |
| **`** | Toggle the diagnostics panel |

### Drawing a mask without a mouse

Tab to the canvas (or click it once) and the mask becomes fully keyboard-operable:

| Key | Action |
|---|---|
| **Arrow keys** | Move the crosshair (2% of the image per press) |
| **Shift + Arrow** | Move in large steps (10%) |
| **Alt + Arrow** | Move one pixel at a time |
| **Enter** | Rect tool: set a corner, then press again to complete. Brush/eraser: stamp at the crosshair |
| **Esc** | Cancel a half-drawn rectangle |

Every action is announced to screen readers, and arrow keys only ever move the
crosshair — the mask changes only on an explicit **Enter**.

---

## 🔐 Privacy

- **No telemetry.** No analytics, no error reporting, no "anonymous usage statistics."
- **No accounts.** No email, no signup, ever.
- **No cloud.** The 29 MB model is fetched once from Hugging Face and checksum-verified. Your images and videos are never sent anywhere — there is no endpoint to send them to.
- **Auditable.** Open DevTools → Network tab → remove a watermark → no requests are made. Fonts are self-hosted and there are no third-party scripts, so nothing phones home. Source is MIT and inspectable.

---

## ⚠️ Honest limitations

| Limit | Why | Workaround |
|---|---|---|
| Image cap ~100 MB | Browser tab memory ceiling | Resize before upload |
| Short videos only (~30 s) | Per-frame processing overhead + memory | Trim long clips first |
| Model is fixed 512×512 | MI-GAN ONNX export | Internally we crop + resize for higher effective resolution at the mask |
| Static-mask video mode | One AI pass + copy patch onto all frames | Best for corner watermarks (95% case); moving content behind the watermark may show a static patch |
| Complex backgrounds (faces, fine text, architecture) | LaMa/MI-GAN inpainting limitation, not a bug | Use a tighter mask; consider desktop tools like [IOPaint](https://github.com/Sanster/IOPaint) for hard cases |
| WebGPU not in all browsers yet | Browser support catching up | Auto-falls back to WASM multi-threading |

---

## 📁 Project structure

```
free-ai-watermark-remover/
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── WATERMARKOUT_BUILD_SPEC.md
├── .gitignore
├── tools/                   ← dev-only, never deployed
│   ├── test-inpainter.mjs   pixel-math regression tests
│   └── check.mjs            cross-file consistency checks
└── static/                  ← deploy this folder
    ├── index.html           main app
    ├── about.html           about page (DiceCodes branding)
    ├── offline.html         shown when offline & uncached
    ├── manifest.webmanifest PWA manifest
    ├── sw.js                Service Worker (offline + COI headers)
    ├── css/
    │   ├── app.css
    │   └── about.css
    ├── js/
    │   ├── app.js               main controller
    │   ├── about.js             about-page behaviour
    │   ├── coi-bootstrap.js     enables Cross-Origin Isolation
    │   ├── inpainter.js         MI-GAN ONNX inference
    │   ├── model-cache.js       IndexedDB model caching
    │   ├── mask.js              canvas brush/rect/eraser
    │   ├── upload.js            drag-drop, validation
    │   ├── video.js             video pipeline (decode → mask → encode)
    │   ├── fs-folder.js         File System Access API integration
    │   ├── debug.js             diagnostic helpers (no UI)
    │   ├── toast.js             notifications
    │   ├── updates.js           Service Worker update flow
    │   └── version.js
    └── assets/
        ├── logo.svg
        ├── logo-icon.svg
        ├── prince-avatar.png   (optional, falls back to GitHub avatar)
        └── icons/              PWA icons (192/512/maskable)
```

---

## 👨‍💻 About the maker

Built solo by **Prince Ramgarhia** (DiceCodes) in Batala, Punjab 🇮🇳.

> Solo-built. No VC. No growth team. Just one developer trying to make pro-grade creative tooling permanently free for everyone.

- 🌐 [dicecodes.com](https://dicecodes.com)
- 📧 [Contact@dicecodes.com](mailto:Contact@dicecodes.com)
- 🐙 [@IamRamgarhia](https://github.com/IamRamgarhia)

### Other free tools by DiceCodes

- [Free GST Billing Software](https://github.com/IamRamgarhia/Free-GST-Billing-Software)
- [SEO Tool](https://github.com/IamRamgarhia/SEO-Tool)
- [AdForge](https://github.com/IamRamgarhia/AdForge)

### Support

If WatermarkOut saved you money, time, or a privacy headache:

- **UPI (India):** `princeramgarhiaa-1@okaxis`
- **GitHub Sponsors:** [github.com/sponsors/IamRamgarhia](https://github.com/sponsors/IamRamgarhia)
- ⭐ **Star this repo** — free and helps others find it

---

## 🙏 Credits

- **[MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN)** — the inpainting model (Picsart-AI-Research, ICCV 2023)
- **[ONNX Runtime Web](https://onnxruntime.ai/)** — Microsoft's browser ML runtime
- **[lxfater/inpaint-web](https://github.com/lxfater/inpaint-web)** — reference implementation we learned from
- **[Sanster/IOPaint](https://github.com/Sanster/IOPaint)** — gold-standard LaMa wrapper, source of our composite logic
- **[dinoBOLT/Gemini-Watermark-Remover](https://github.com/dinoBOLT/Gemini-Watermark-Remover)** — reference for browser-based watermark removal

---

## License

[MIT](LICENSE) — fork, modify, use commercially. Made with ❤️ in India 🇮🇳.
