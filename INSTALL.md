# Installation guide

WatermarkOut has **three** ways to install/use it. Pick the one that fits you.

| Path | For who | Time | Internet needed |
|---|---|---|---|
| **A. Use the live URL** | Everyone (recommended) | 0 sec | First visit only |
| **B. Install as a PWA** | Want a desktop icon | 10 sec | First visit only |
| **C. Run locally** | Developers, offline forever, self-host | 5 min | Only to clone & first model fetch |

---

## A. Use the live URL (zero install)

Just open the link. The app loads, downloads the AI model once (~29 MB), and works fully offline after that.

👉 **https://iamramgarhia.github.io/watermarkout-/**

Done. No accounts. No download. Nothing to install.

---

## B. Install as a Progressive Web App (PWA) — gets a real desktop icon

This is the **easiest way to get a "desktop app" feel** without downloading anything.

### Windows (Chrome / Edge / Brave / Opera)

1. Open https://iamramgarhia.github.io/watermarkout-/ in your browser
2. Look for the **install icon** in the address bar — it looks like a monitor with an arrow ⤓ or just `+`
3. Click it → **Install**
4. WatermarkOut now appears:
   - As a **desktop icon** (double-click to launch)
   - In your **Start menu**
   - In the **taskbar** when running
5. It opens in its own standalone window — no browser tabs, no URL bar

### macOS (Chrome / Edge / Safari)

**Chrome / Edge:**
1. Open the URL
2. Click the **install icon** in the address bar (right side)
3. Click **Install** → WatermarkOut.app appears in `/Applications`

**Safari 17+:**
1. Open the URL
2. **File → Add to Dock**
3. The icon appears in your Dock

### iPhone / iPad (Safari)

1. Open the URL in Safari
2. Tap the **Share** button (⬆ box icon)
3. Tap **Add to Home Screen**
4. Tap **Add** in the top-right
5. WatermarkOut now has a real app icon on your home screen

### Android (Chrome)

1. Open the URL
2. Tap the **⋮ menu** (top-right)
3. Tap **Install app** (or "Add to Home Screen")
4. Tap **Install**
5. App icon appears in your app drawer

### What you get after PWA install

✅ Real app icon on desktop / home screen / launcher
✅ Opens in its own window (no browser UI clutter)
✅ Works **fully offline** after first visit
✅ Auto-updates when we push a new version
✅ No App Store, no Play Store, no permissions, no tracking

---

## C. Run it locally on your machine (developers, offline forever, self-host)

For people who want to:
- Modify the code
- Use it 100% offline forever (no first-time internet for the live site)
- Self-host it on their own domain
- Have a copy that survives the live site going down

### Prerequisites

- **Git** — [download from git-scm.com](https://git-scm.com/downloads) if you don't have it
- **One of:**
  - **Python 3** (already on macOS and Linux; Windows: [python.org](https://www.python.org/downloads/))
  - **OR Node.js** (works as a static server too)
  - **OR any other static HTTP server** you prefer

### Step 1: Clone the repo

Open a terminal (Command Prompt / PowerShell / Terminal):

```bash
git clone https://github.com/IamRamgarhia/watermarkout-.git
cd watermarkout-
```

You should now see the project files. Verify with `ls` (Mac/Linux) or `dir` (Windows).

### Step 2: Start a local server

There is **no build step** — no `npm install`, no compilation. Just serve the `static/` folder over HTTP.

**Option 2A — Python (already installed on Mac/Linux):**

```bash
cd static
python -m http.server 8000
```

**Option 2B — Python on Windows (if `python` doesn't work, try `py`):**

```bash
cd static
py -m http.server 8000
```

**Option 2C — Node.js (any version):**

```bash
cd static
npx serve -p 8000
```
(Press `y` if it asks to install `serve`.)

**Option 2D — PHP (if you have it):**

```bash
cd static
php -S localhost:8000
```

You should see something like:
```
Serving HTTP on :: port 8000 (http://[::]:8000/) ...
```

### Step 3: Open in your browser

Open: **http://localhost:8000**

The app loads. **On the first run**, the browser fetches the 29 MB MI-GAN AI model from Hugging Face. Wait ~30 seconds. After that, the model is cached locally and the app runs fully offline forever.

### Step 4 (optional): Pre-cache the model for fully-offline use

If you want to use WatermarkOut even without internet (e.g., on a plane, secure environment):

1. Run Step 3 once with internet → wait for "Found it on your device" status
2. The model is now in your browser's IndexedDB (cached on disk)
3. From now on, even offline, the app works

To distribute the cached model to another machine:
- Browser-cached IndexedDB isn't easily transferable across machines
- Instead, download the model file once: https://huggingface.co/lxfater/inpaint-web/resolve/main/migan.onnx (29 MB)
- Place it in `static/models/migan.onnx`
- Edit `static/js/model-cache.js` line ~21 — change `MODEL_URL` to `./models/migan.onnx`
- Now the model loads from your local file, no internet needed at all

### Step 5 (optional): Stop the server

In the terminal, press **`Ctrl + C`**.

To restart later:
```bash
cd watermarkout-/static
python -m http.server 8000
```

---

## Self-hosting (production)

If you want to put your own copy on the internet (your own domain, your own server):

### Option 1 — GitHub Pages (free, recommended)

Already done if you forked this repo. See [GITHUB_SETUP.md](GITHUB_SETUP.md).

### Option 2 — Cloudflare Pages

1. Sign in at https://pages.cloudflare.com
2. Connect your forked GitHub repo
3. Build settings: **Build command: (leave empty)**, **Build output directory: `static`**
4. Deploy

### Option 3 — Netlify

1. https://app.netlify.com → "Add new site" → Import from Git
2. Pick your forked repo
3. Build command: empty. Publish directory: `static`
4. Deploy

### Option 4 — Any static host

Upload the contents of `static/` to any HTTP server (Apache, Nginx, S3+CloudFront, Surge.sh, Vercel, Fly.io, etc.). The site is pure static files.

**Important for self-hosting:** the Service Worker needs to be served from the root of your site (or app scope). If you serve from a subpath (e.g. `example.com/watermarkout/`), all paths in `manifest.webmanifest` and HTML already use relative URLs — no changes needed.

---

## System requirements

| Requirement | Why |
|---|---|
| Modern browser: Chrome/Edge 90+, Firefox 90+, Safari 16.4+ | Needed for WebAssembly + Service Worker |
| 250 MB free disk space | For caching the AI model + app shell |
| 4 GB RAM minimum | For ONNX inference (browser tab memory) |
| WebGPU (optional) | Massive speedup; auto-detected, falls back to WASM if unavailable |

**You do NOT need:**
- ❌ A GPU (CPU fallback works fine for typical watermarks)
- ❌ Node.js (only if you want to use it as a static server)
- ❌ Python (only if you want to use it as a static server)
- ❌ Any paid service
- ❌ Any account anywhere

---

## Troubleshooting

### "The site shows a 404"

The live GitHub Pages site shows 404 for ~30 seconds right after a code update is pushed. Just refresh after a minute.

### "Model never finishes downloading"

Check your internet connection — the first-time download is ~29 MB from Hugging Face. After it's cached, no internet needed.

If you're getting CORS errors when self-hosting, make sure your server sets these headers for `*.onnx` files: `Access-Control-Allow-Origin: *` (only required if the model is served from a different domain than the app).

### "Cross-origin isolated: NO" in the debug panel

This means the Service Worker didn't take over the page. Hard-refresh (`Ctrl + Shift + R`) once, then refresh normally. Subsequent visits will have COI enabled and run inference 4–10× faster.

### "Permission denied" / "Site can't be reached" when running locally

- Make sure no other app is using port 8000 (try port 8001 instead: `python -m http.server 8001`)
- On Windows, your firewall may block Python the first time — allow it
- On macOS, you may get a Gatekeeper prompt — click "Allow"

### Want to inspect what the app is doing

- Open DevTools (`F12` or `Ctrl+Shift+I`)
- **Console tab** — see logs from `[inpainter]`, `[model-cache]`, `[coi]`, `[video]`
- **Network tab** — verify nothing is uploaded (it shouldn't be)
- **Application tab → Service Workers** — verify the worker is active
- **Application tab → IndexedDB → watermarkout** — see the cached model file

---

## Questions?

- 📖 Full docs: [README.md](README.md)
- 🤝 Want to contribute? [CONTRIBUTING.md](CONTRIBUTING.md)
- 🐛 Found a bug? [Open an issue](https://github.com/IamRamgarhia/watermarkout-/issues)
- 💬 Contact: Contact@dicecodes.com
