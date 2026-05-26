# GitHub Setup Guide — what to put where

Copy-paste this when configuring your `IamRamgarhia/watermarkout-` repo for maximum SEO + discoverability.

---

## 1. Repo description (the field at the top of the repo page)

**Copy this exactly** (≤140 chars, optimized for search):

```
🎨 Free AI watermark remover for images & videos. Runs entirely in your browser — no uploads, no accounts, no cloud. Open source.
```

---

## 2. Website URL (right under the description)

```
https://iamramgarhia.github.io/watermarkout-/
```

---

## 3. Topics (clickable tags — adds to GitHub's topic search)

Click "⚙️" next to **About** → add these topics one by one:

```
watermark-remover
ai-watermark-removal
gemini-watermark-remover
dalle-watermark-remover
midjourney-watermark-remover
ai-image-cleaner
inpainting
mi-gan
onnx-runtime
onnx-runtime-web
browser-ai
client-side-ai
progressive-web-app
pwa
webassembly
free-tool
no-server
privacy
open-source
made-in-india
javascript
vanilla-js
```

(GitHub allows up to 20 topics — pick the 20 most relevant from the list above. The first 8 are the highest-priority ones for search.)

---

## 4. Social preview image (the image people see when they share the repo link)

Upload **`static/assets/social-preview.png`** to:
**Settings → General → Social preview → Upload an image**

(The file is 1200×630 px — matches GitHub's recommended size.)

If you want a fancier image, design one with:
- Same 1200 × 630 dimensions
- App logo
- Tagline: "Free AI Watermark Remover · Runs in your browser"
- Screenshot of the app interface

---

## 5. Enable GitHub Pages

**Settings → Pages → Build and deployment:**

- **Source:** *GitHub Actions*

(The `.github/workflows/deploy.yml` file does the rest — pushes auto-deploy.)

After the first deploy completes (check the Actions tab), your live URL is:

```
https://iamramgarhia.github.io/watermarkout-/
```

### Custom domain (optional)

1. Rename `static/CNAME.example` → `static/CNAME`, edit to your domain (e.g. `watermarkout.dicecodes.com`).
2. **Settings → Pages → Custom domain:** type the same domain, save.
3. Add a DNS CNAME record at your registrar:
   ```
   watermarkout.dicecodes.com → iamramgarhia.github.io
   ```
4. Wait ~5 min for HTTPS to provision (free, automatic).

---

## 6. README badges (already in your README.md — no action needed)

Your README has these dynamic badges:

| Badge | What it shows |
|---|---|
| ![License](https://img.shields.io/badge/License-MIT-success.svg?style=flat-square) | MIT license |
| ![PWA](https://img.shields.io/badge/Progressive%20Web%20App-7c3aed?style=flat-square) | PWA |
| ![Stars](https://img.shields.io/github/stars/IamRamgarhia/watermarkout-?style=flat-square) | Live star count |
| ![Issues](https://img.shields.io/github/issues/IamRamgarhia/watermarkout-?style=flat-square) | Open issues |

They auto-update from GitHub.

---

## 7. Pin this repo to your profile

Go to your profile **https://github.com/IamRamgarhia** → click "Customize your pins" → check `watermarkout-`. Now it shows on your profile page.

---

## 8. First release (tagged version)

After your first push:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Then **Releases → Draft a new release**:

- **Tag:** `v1.0.0`
- **Title:** `WatermarkOut v1.0.0 — first release`
- **Description:**
```markdown
First public release.

✨ **Features**
- Remove watermarks from AI-generated images (Gemini, DALL·E, Midjourney, Bing, Firefly, Meta AI)
- Remove watermarks from short videos
- 100% client-side — runs the MI-GAN model in your browser via ONNX Runtime Web
- Works offline after first visit (Service Worker + IndexedDB)
- Installable as a PWA on desktop & mobile

🔧 **Under the hood**
- MI-GAN (Picsart Research, ICCV 2023) — 29 MB
- ONNX Runtime Web with WebGPU → WebGL → WASM fallback
- Cross-origin isolation via Service Worker (enables WASM threads + SIMD)

📥 **Try it:** https://iamramgarhia.github.io/watermarkout-/
```

---

## 9. SEO: search ranking checklist (already done in the code)

I've already added these to `static/index.html` and `static/about.html`:

- ✅ Descriptive `<title>` with target keywords
- ✅ `<meta name="description">` (Google snippet)
- ✅ `<meta name="keywords">` (legacy but harmless)
- ✅ `<link rel="canonical">` to prevent duplicate-content issues
- ✅ Open Graph tags (Facebook, LinkedIn, Slack, Discord previews)
- ✅ Twitter Card tags
- ✅ JSON-LD structured data (`SoftwareApplication` schema)
- ✅ Author + publisher metadata
- ✅ Language declaration (`lang="en"`)
- ✅ `robots.txt` allowing all crawlers
- ✅ `sitemap.xml` with both pages

After deployment, submit your site to:

### Google Search Console
**https://search.google.com/search-console** → Add property → Submit your URL → Submit `sitemap.xml`. Indexing usually starts within a week.

### Bing Webmaster Tools
**https://www.bing.com/webmasters** → Same process. Bing indexes faster than Google for small sites.

### Ping search engines (optional speedup)
```
https://www.google.com/ping?sitemap=https://iamramgarhia.github.io/watermarkout-/sitemap.xml
https://www.bing.com/ping?sitemap=https://iamramgarhia.github.io/watermarkout-/sitemap.xml
```

---

## 10. PWA installation (the "desktop icon" part)

This already works with the `manifest.webmanifest` I included. When users visit and the manifest is valid, browsers automatically offer to "Install" the app:

| Browser | What user sees |
|---|---|
| **Chrome / Edge desktop** | Install icon in the address bar; click → desktop icon appears, app opens in own window |
| **Safari iOS** | Share menu → "Add to Home Screen" → real app icon |
| **Android Chrome** | ⋮ menu → "Install app" → appears in app drawer |
| **Brave / Opera / Arc** | Same as Chrome/Edge |

The installed app:
- Has the WatermarkOut icon on desktop / home screen
- Opens in its own standalone window (no browser tab UI)
- Works fully offline (after first visit)
- Auto-updates when you push a new version (via Service Worker)

---

## 11. After-deploy verification checklist

Once live, verify in this order:

1. ✅ Open the live URL → loads, model downloads, you can upload + process an image
2. ✅ Lighthouse audit (DevTools → Lighthouse → Mobile + PWA) → should score 90+ across all categories
3. ✅ Check Google rich-results test: https://search.google.com/test/rich-results — paste your URL, verify `SoftwareApplication` schema is detected
4. ✅ Facebook sharing debugger: https://developers.facebook.com/tools/debug/ — paste your URL, verify preview image + description
5. ✅ Twitter card validator: https://cards-dev.twitter.com/validator
6. ✅ Install prompt appears on second visit (PWA criterion met)
7. ✅ "About" page link from main app works and is also indexed

---

## 12. Promote it (optional but boosts SEO)

These give your repo authoritative backlinks:

- **Show HN (Hacker News):** post `Show HN: WatermarkOut – browser-based AI watermark remover`
- **Reddit:** r/InternetIsBeautiful, r/SideProject, r/StableDiffusion, r/javascript
- **X (Twitter):** post the GitHub link with screenshots
- **Product Hunt:** schedule a launch
- **GitHub topic pages:** appears automatically once topics are set
- **Awesome lists:** PR to awesome-pwa, awesome-watermark, awesome-onnx, awesome-ai-tools
- **dev.to / Hashnode article:** write up the technical journey (browser-only AI inpainting is interesting)

Every external link to your GitHub URL helps it rank.

---

## 13. Quick git commands

```bash
# Initial push
cd "d:/calude/watermark"
git init
git add .
git commit -m "Initial commit: WatermarkOut v1.0.0"
git branch -M main
git remote add origin https://github.com/IamRamgarhia/watermarkout-.git
git push -u origin main

# Tag the first release
git tag v1.0.0
git push origin v1.0.0
```

After the push, GitHub Actions auto-deploys → site live at the GitHub Pages URL within ~1 minute.

---

## TL;DR — the 5-minute checklist

1. ✅ Push code to GitHub (`git push`)
2. ✅ **Settings → Pages → Source: GitHub Actions**
3. ✅ Set the **About** section: description + URL + 20 topics (use the lists above)
4. ✅ **Settings → Social preview** → upload `static/assets/social-preview.png`
5. ✅ Pin the repo on your profile
6. ✅ Submit `sitemap.xml` to Google Search Console + Bing Webmaster Tools
7. ✅ Tag and release `v1.0.0`

Total time: ~10 minutes. Then your repo is fully discoverable.
