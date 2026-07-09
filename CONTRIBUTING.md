# Contributing to FreeHub Pro

Thanks for considering a contribution! FreeHub Pro is a solo project, but pull requests, issues, and ideas are very welcome.

## Quick setup

There is **no build step**. The app is pure vanilla HTML + CSS + JavaScript. To develop locally:

```bash
git clone https://github.com/IamRamgarhia/free-ai-watermark-remover.git
cd free-ai-watermark-remover/static
python -m http.server 8000
# Open http://localhost:8000
```

Any static server works — Python's, `npx serve`, `php -S`, anything that serves files over HTTP. The Service Worker requires HTTP/HTTPS (not `file://`).

## Refreshing during development

- **`Ctrl + R`** — picks up code changes. **Preserves the cached AI model** (recommended).
- **`Ctrl + Shift + R`** — hard refresh. **Wipes Service Worker cache, will re-download the 29 MB model.** Use sparingly.

The Service Worker version is `static/sw.js` — bump `CACHE_VERSION` when shipping breaking changes so users automatically get the new version.

## Code style

- **Vanilla ES modules** — no transpilation.
- **No dependencies on npm packages.** Everything runs from CDN at runtime or is vendored in `static/js/`.
- **Comments explain *why*, not *what***. If the why is obvious from the code, skip the comment.
- **Console logs use bracketed prefixes** for filtering: `[inpainter]`, `[video]`, `[model-cache]`, `[coi]`.
- **Don't add error handling for cases that can't happen.** Only validate at user/network boundaries.

## Project structure

See [README.md → Project structure](README.md#-project-structure).

## Areas that could use help

- **Model variants** — testing different MI-GAN export sizes / quantizations
- **Per-frame video mode** — currently we use static-mask optimization (1 AI pass + composite). A "Per-frame AI" toggle for harder scenes would be welcome
- **Auto-detection** — detecting watermark position automatically (perhaps via Florence-2 ONNX, similar to D-Ogi/WatermarkRemover-AI)
- **Additional watermark presets** — tuning percentages for specific tools
- **Localization** — currently English-only
- **Accessibility** — keyboard navigation, screen reader labels
- **PWA improvements** — share target, file handler API integration

## Filing issues

When reporting a bug, please include:
- Browser + version (e.g., Chrome 126 on Windows 11)
- Image / video dimensions
- Console output (especially lines starting with `[inpainter]`)
- Steps to reproduce

## Pull requests

- Keep PRs focused — one concern per PR.
- Test in at least Chrome and Firefox before submitting.
- Bump `CACHE_VERSION` in `static/sw.js` if your changes alter cached files.
- The PR description should explain *why* the change is needed.

## License

By contributing, you agree your work is released under the project's [MIT license](LICENSE).

## Code of conduct

Be respectful. This is a free tool built solo — friendly disagreements welcome, hostility is not.
