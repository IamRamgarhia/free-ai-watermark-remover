/**
 * WatermarkOut — Main controller.
 * Wires together upload, mask drawing, inpainter, downloads, and PWA registration.
 */

import { APP_VERSION } from './version.js';
import { bindDropzone, imageToImageData } from './upload.js';
import { MaskCanvas, dilateMask, maskHasContent } from './mask.js';
import * as inpainter from './inpainter.js';
import { registerServiceWorker } from './updates.js';
import { toast } from './toast.js';
import { isModelCached, clearModel } from './model-cache.js';
import { dbg } from './debug.js';
import { loadVideoMetadata, grabFirstFrame, processVideo } from './video.js';
import * as fsFolder from './fs-folder.js';

// === State ===
const state = {
  kind: null,          // 'image' | 'video'
  image: null,         // HTMLImageElement (image mode)
  imageData: null,     // ImageData of original (image mode) or first frame (video mode)
  resultData: null,    // ImageData after inpaint
  videoInfo: null,     // { video, url, width, height, duration, fps } (video mode)
  videoBlob: null,     // Final processed video blob
  filename: null,
  tool: 'rect',
  brushSize: 30,
  quality: 'balanced',
  maskExpand: 8,
  outputFormat: 'png',
  showResult: false,
  removeClickCount: 0,
  modelReady: false,   // the editor renders before the model finishes loading
};

// === DOM ===
const D = {
  versionBadge: document.getElementById('version-badge'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),

  loader: document.getElementById('model-loader'),
  loaderTitle: document.getElementById('loader-title'),
  loaderSub: document.getElementById('loader-sub'),
  loaderFill: document.getElementById('loader-fill'),
  loaderMeta: document.getElementById('loader-meta'),
  loaderBackend: document.getElementById('loader-backend'),

  appGrid: document.getElementById('app-grid'),

  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  btnBrowse: document.getElementById('btn-browse'),

  editor: document.getElementById('editor'),
  canvasImage: document.getElementById('canvas-image'),
  canvasResult: document.getElementById('canvas-result'),
  canvasMask: document.getElementById('canvas-mask'),
  canvasWrap: document.getElementById('canvas-wrap'),

  fileInfoCard: document.getElementById('file-info-card'),
  qualityCard: document.getElementById('quality-card'),
  actionsCard: document.getElementById('actions-card'),
  fileName: document.getElementById('file-name'),
  fileDims: document.getElementById('file-dims'),
  fileSize: document.getElementById('file-size'),

  btnNewFile: document.getElementById('btn-new-file'),
  btnRemove: document.getElementById('btn-remove'),
  btnDownload: document.getElementById('btn-download'),
  btnStartOver: document.getElementById('btn-start-over'),
  btnDeleteCanvas: document.getElementById('btn-delete-canvas'),
  btnCompare: document.getElementById('btn-compare'),
  btnUndo: document.getElementById('btn-undo'),
  btnClearMask: document.getElementById('btn-clear-mask'),
  btnZoomFit: document.getElementById('btn-zoom-fit'),
  btnClearModel: document.getElementById('btn-clear-model'),
  btnApplyPreset: document.getElementById('btn-apply-preset'),
  presetSelect: document.getElementById('preset-select'),
  btnPickFolder: document.getElementById('btn-pick-folder'),

  modelStatus: document.getElementById('model-status'),
  backendStatus: document.getElementById('backend-status'),
  storageStatus: document.getElementById('storage-status'),
  folderStatus: document.getElementById('folder-status'),

  videoOriginal: document.getElementById('video-original'),
  videoResult: document.getElementById('video-result'),
  previewLabel: document.getElementById('preview-label'),

  stageHint: document.getElementById('stage-hint'),
  processingOverlay: document.getElementById('processing-overlay'),
  processingFill: document.getElementById('processing-fill'),
  processingStage: document.getElementById('processing-stage'),
  processingTitle: document.getElementById('processing-title'),
  processingSub: document.getElementById('processing-sub'),

  stageModal: document.getElementById('stage-modal'),
  stageModalIcon: document.getElementById('stage-modal-icon'),
  stageModalTitle: document.getElementById('stage-modal-title'),
  stageModalMsg: document.getElementById('stage-modal-msg'),
  stageModalOk: document.getElementById('stage-modal-ok'),

  brushSize: document.getElementById('brush-size'),
  brushSizeVal: document.getElementById('brush-size-val'),
  maskExpand: document.getElementById('mask-expand'),
  maskExpandVal: document.getElementById('mask-expand-val'),
  outputFormat: document.getElementById('output-format'),

  toolBtns: document.querySelectorAll('.tool-btn[data-tool]'),
};

// === Init ===
let maskCanvas = null;

function setStatus(label, kind = 'idle') {
  D.statusText.textContent = label;
  D.statusDot.className = 'status-dot';
  if (kind === 'ready') D.statusDot.classList.add('ready');
  else if (kind === 'busy') D.statusDot.classList.add('busy');
  else if (kind === 'error') D.statusDot.classList.add('error');
}

function setLoaderProgress({ done = 0, total = 0, stage = '', cached = false }) {
  const pct = total > 0 ? (done / total) * 100 : (done > 0 ? 100 : 0);
  D.loaderFill.style.width = `${Math.min(100, pct).toFixed(1)}%`;
  const sizeStr = total > 0
    ? `${formatBytes(done)} / ${formatBytes(total)}`
    : (done > 0 ? formatBytes(done) : '');
  if (cached) {
    document.getElementById('loader-title').textContent = 'Found it on your device';
    document.getElementById('loader-sub').textContent = 'Loading the model into the browser…';
    D.loaderMeta.textContent = 'Loaded from your device (no download needed)';
  } else if (done > 0 && total > 0) {
    document.getElementById('loader-title').textContent = 'First-time setup';
    document.getElementById('loader-sub').textContent = 'This is the only time you\'ll see a download. After this it works fully offline.';
    D.loaderMeta.textContent = `${stage}${sizeStr ? ' — ' + sizeStr : ''}`;
  } else {
    D.loaderMeta.textContent = stage || 'Checking…';
  }
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function bootstrap() {
  D.versionBadge.textContent = `v${APP_VERSION}`;
  setStatus('Loading model', 'busy');

  // Debug initial state
  dbg.set('coi', window.crossOriginIsolated ? 'YES' : 'no', window.crossOriginIsolated ? 'ok' : 'warn');
  dbg.set('threads', String(navigator.hardwareConcurrency || 1));
  dbg.set('tool', state.tool);

  // Probe cache state
  const cachedAlready = await isModelCached();
  setModelStatus(cachedAlready ? 'cached' : 'downloading');
  dbg.set('model', cachedAlready ? 'cached' : 'downloading', cachedAlready ? 'ok' : 'warn');
  refreshStorageStatus();

  registerServiceWorker();

  // Coverage readout for the debug panel. getCoveragePercent() does a full
  // getImageData() — on a 4000×3000 image that's a ~48 MB pixel copy — so it
  // only runs while the panel is actually open, not for the whole session.
  setInterval(() => {
    if (maskCanvas && dbg.isOpen()) {
      const pct = maskCanvas.getCoveragePercent();
      dbg.setIfChanged('coverage', `${pct.toFixed(2)}%`, pct > 0 ? 'ok' : '');
    }
  }, 500);

  // The editor is visible from first paint — it is NOT gated on the model.
  // Previously the whole app sat behind `hidden` until a 29 MB download and
  // WASM init finished, which meant a first-time visitor stared at a spinner
  // and a search-engine crawler saw nothing but "Looking for the AI model…".
  // Now you can drop a file and draw a mask while the model streams in; only
  // the Remove button waits.
  const hideLoaderStrip = () => {
    D.loader.style.opacity = '0';
    D.loader.style.transition = 'opacity 0.3s';
    setTimeout(() => { D.loader.hidden = true; }, 300);
  };

  try {
    await inpainter.init((p) => setLoaderProgress(p));
    const backend = inpainter.getBackend();
    if (D.loaderBackend) D.loaderBackend.textContent = `Running on: ${backend.toUpperCase()}`;
    if (D.backendStatus) {
      D.backendStatus.textContent = backend.toUpperCase();
      D.backendStatus.classList.add('ok');
    }
    setModelStatus('cached');
    dbg.set('backend', backend.toUpperCase(), backend === 'webgpu' ? 'ok' : 'warn');
    dbg.set('model', 'cached', 'ok');
    dbg.set('ready', 'yes', 'ok');
    refreshStorageStatus();
    setStatus(`Ready (${backend})`, 'ready');
    toast('AI engine ready.', 'success', 2500);
    state.modelReady = true;
    updateRemoveEnabled();
    hideLoaderStrip();
  } catch (e) {
    console.error('Bootstrap failed:', e);
    dbg.error('Bootstrap: ' + (e.message || e));
    dbg.set('ready', 'no', 'error');
    setStatus('Failed', 'error');
    setModelStatus('error');
    document.getElementById('loader-title').textContent = 'Could not load the AI model';
    document.getElementById('loader-sub').textContent = String(e.message || e);
    D.loaderMeta.textContent = 'Check your internet connection, then refresh.';
  }
}

/**
 * Remove needs BOTH a loaded file and a ready model. The editor is now usable
 * before the model arrives, so this is the single place that decides whether
 * the button is live, rather than each load path guessing.
 */
function updateRemoveEnabled() {
  if (!D.btnRemove) return;
  const hasFile = !!state.imageData;
  D.btnRemove.disabled = !(hasFile && state.modelReady);
  D.btnRemove.title = !hasFile
    ? 'Drop an image or video first'
    : !state.modelReady
      ? 'Waiting for the AI model to finish loading…'
      : 'Remove the watermark inside your mask';
}

function setModelStatus(state) {
  if (!D.modelStatus) return;
  const map = {
    cached:       { text: 'On your device ✓', cls: 'ok' },
    downloading:  { text: 'Downloading…',     cls: 'warn' },
    error:        { text: 'Error',            cls: 'error' },
  };
  const { text, cls } = map[state] || { text: state, cls: '' };
  D.modelStatus.textContent = text;
  D.modelStatus.className = `status-mini ${cls}`;
}

async function refreshStorageStatus() {
  if (!D.storageStatus) return;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const usedMB = (est.usage || 0) / 1024 / 1024;
      D.storageStatus.textContent = `${usedMB.toFixed(0)} MB local`;
      D.storageStatus.classList.add('ok');
    } else {
      D.storageStatus.textContent = 'IndexedDB';
    }
  } catch {
    D.storageStatus.textContent = 'IndexedDB';
  }
  await refreshFolderStatus();
}

async function refreshFolderStatus() {
  if (!D.folderStatus) return;
  if (!fsFolder.isSupported()) {
    D.folderStatus.textContent = 'Browser only (Chrome/Edge for folder)';
    D.folderStatus.classList.add('warn');
    if (D.btnPickFolder) {
      D.btnPickFolder.disabled = true;
      D.btnPickFolder.title = 'Your browser does not support folder access. Use Chrome or Edge.';
    }
    return;
  }
  const folder = await fsFolder.getActiveFolder();
  if (folder) {
    D.folderStatus.textContent = '📁 ' + fsFolder.getFolderName(folder);
    D.folderStatus.classList.add('ok');
    D.folderStatus.classList.remove('warn');
    if (D.btnPickFolder) D.btnPickFolder.textContent = '📁 Change folder';
  } else {
    D.folderStatus.textContent = 'Browser-local (IndexedDB)';
    D.folderStatus.classList.remove('ok');
    if (D.btnPickFolder) D.btnPickFolder.textContent = '📁 Use a folder on my disk';
  }
}

async function onPickFolder() {
  try {
    const handle = await fsFolder.pickFolder();
    if (!handle) return; // user canceled
    toast(`Folder selected: ${fsFolder.getFolderName(handle)}. Model + results will live there.`, 'success', 5000);
    dbg.log('User picked folder: ' + fsFolder.getFolderName(handle));
    await refreshFolderStatus();
  } catch (e) {
    toast('Could not select folder: ' + (e.message || e), 'error');
    dbg.error('Folder pick failed: ' + (e.message || e));
  }
}

// === File handling ===
async function onFileLoaded({ file, image, kind, error }) {
  if (error) {
    toast(error, 'error');
    dbg.error(error);
    return;
  }

  // Free the previous file's blob URLs before we overwrite them — a new file
  // can be dropped while the editor is still open.
  releaseVideoUrls();

  state.filename = file.name;
  state.kind = kind;
  state.resultData = null;
  state.showResult = false;

  dbg.set('file', file.name);
  dbg.set('filetype', kind);

  try {
    if (kind === 'video') {
      await loadVideoIntoEditor(file);
    } else {
      loadImageIntoEditor(file, image);
    }
  } catch (e) {
    console.error('Failed to load file:', e);
    dbg.error('Load failed: ' + (e.message || e));
    toast('Could not load this file: ' + (e.message || e), 'error', 6000);
    return;
  }

  // UI swap
  D.dropzone.hidden = true;
  D.editor.hidden = false;
  D.fileName.textContent = file.name;
  D.fileSize.textContent = formatBytes(file.size);
  D.btnDownload.disabled = true;
  updateRemoveEnabled();   // may still be waiting on the model
  D.btnNewFile.disabled = false;
  D.btnStartOver.disabled = false;

  // Fit after the next layout pass so .stage has its real dimensions
  requestAnimationFrame(() => {
    fitCanvasToStage();
    // Also fit after a slight delay to account for any async layout shifts
    setTimeout(fitCanvasToStage, 100);
  });

  toast(kind === 'video'
    ? 'Video loaded. Draw a rectangle around the watermark on the first frame, then click Remove.'
    : 'Drop a rectangle around the watermark, then click Remove.',
    'info', 5500);
}

function loadImageIntoEditor(file, image) {
  state.image = image;
  state.videoInfo = null;
  state.imageData = imageToImageData(image);

  // Display image canvas
  D.canvasImage.width = image.naturalWidth;
  D.canvasImage.height = image.naturalHeight;
  D.canvasImage.getContext('2d').drawImage(image, 0, 0);
  D.canvasImage.hidden = false;

  D.canvasResult.width = image.naturalWidth;
  D.canvasResult.height = image.naturalHeight;
  D.canvasResult.hidden = true;

  initMaskCanvasFor(image.naturalWidth, image.naturalHeight);
  D.fileDims.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
  dbg.set('dims', `${image.naturalWidth} × ${image.naturalHeight}`);

  populateOutputFormats('image');
}

async function loadVideoIntoEditor(file) {
  const info = await loadVideoMetadata(file);
  state.videoInfo = info;
  state.image = null;

  // Show the first frame on the image canvas as the masking surface
  const firstFrameCanvas = await grabFirstFrame(info.video);
  D.canvasImage.width = info.width;
  D.canvasImage.height = info.height;
  D.canvasImage.getContext('2d').drawImage(firstFrameCanvas, 0, 0);
  D.canvasImage.hidden = false;

  D.canvasResult.width = info.width;
  D.canvasResult.height = info.height;
  D.canvasResult.hidden = true;

  // ImageData for inference uses the first frame
  state.imageData = D.canvasImage.getContext('2d').getImageData(0, 0, info.width, info.height);

  initMaskCanvasFor(info.width, info.height);
  D.fileDims.textContent = `${info.width} × ${info.height} · ${info.duration.toFixed(1)}s`;
  dbg.set('dims', `${info.width}×${info.height} · ${info.duration.toFixed(1)}s`);

  populateOutputFormats('video');
}

function populateOutputFormats(kind) {
  const select = D.outputFormat;
  if (!select) return;
  // Remove existing options safely
  while (select.firstChild) select.removeChild(select.firstChild);
  const options = kind === 'video'
    ? [
        { v: 'auto', t: 'Auto (best supported)' },
        { v: 'mp4',  t: 'MP4 (H.264)' },
        { v: 'webm', t: 'WebM (VP9)' },
      ]
    : [
        { v: 'png',  t: 'PNG (lossless)' },
        { v: 'jpg',  t: 'JPG (smaller)' },
        { v: 'webp', t: 'WebP' },
      ];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.v;
    opt.textContent = o.t;
    select.appendChild(opt);
  }
  state.outputFormat = options[0].v;
  select.value = state.outputFormat;
  const label = document.getElementById('output-format-label');
  if (label) label.textContent = kind === 'video' ? 'VIDEO FORMAT' : 'OUTPUT FORMAT';
}

function initMaskCanvasFor(w, h) {
  if (!maskCanvas) {
    maskCanvas = new MaskCanvas(D.canvasMask);
  }
  maskCanvas.resize(w, h);
  maskCanvas.setTool(state.tool);
  maskCanvas.setBrushSize(state.brushSize);
}

function fitCanvasToStage() {
  // Computes the exact display size for the canvas stack so the entire image
  // is always visible within the .stage element. We set inline CSS width/height
  // on all canvases AND video elements so they all overlap correctly in the grid.
  if (!D.canvasImage) return;
  const stage = document.getElementById('stage');
  if (!stage) return;

  // Use the intrinsic dimensions of whichever surface holds the source
  let naturalW = 1, naturalH = 1;
  if (state.kind === 'video' && state.videoInfo) {
    naturalW = state.videoInfo.width;
    naturalH = state.videoInfo.height;
  } else {
    naturalW = D.canvasImage.width || state.imageData?.width || 1;
    naturalH = D.canvasImage.height || state.imageData?.height || 1;
  }
  if (naturalW <= 1 || naturalH <= 1) return;

  const stageRect = stage.getBoundingClientRect();
  const padding = 16;
  const maxW = Math.max(50, stageRect.width - padding * 2);
  const maxH = Math.max(50, stageRect.height - padding * 2);

  const scale = Math.min(maxW / naturalW, maxH / naturalH, 1);
  const displayW = Math.floor(naturalW * scale);
  const displayH = Math.floor(naturalH * scale);

  for (const el of [D.canvasImage, D.canvasResult, D.canvasMask, D.videoOriginal, D.videoResult]) {
    if (!el) continue;
    el.style.width = displayW + 'px';
    el.style.height = displayH + 'px';
  }
}

/**
 * Revoke every object URL the video pipeline currently holds.
 *
 * Must run before loading a new file, not just on reset: the window-level drop
 * handler lets you drop a second file while the editor is already open, and
 * without this the previous video's source blob (and any processed result)
 * stays pinned in memory for the lifetime of the tab.
 */
function releaseVideoUrls() {
  if (state.videoInfo?.revoke) {
    try { state.videoInfo.revoke(); } catch {}
  }
  state.videoInfo = null;
  state.videoBlob = null;

  for (const el of [D.videoResult, D.videoOriginal]) {
    if (!el) continue;
    try { el.pause(); } catch {}
    // videoOriginal shares videoInfo.url, which revoke() above already handled;
    // revoking the same URL twice is a harmless no-op.
    if (el.src && el.src.startsWith('blob:')) URL.revokeObjectURL(el.src);
    el.removeAttribute('src');
    el.load();
    el.hidden = true;
  }
}

function resetToDropzone() {
  releaseVideoUrls();

  state.kind = null;
  state.image = null;
  state.imageData = null;
  state.resultData = null;
  state.videoInfo = null;
  state.videoBlob = null;
  state.filename = null;
  state.showResult = false;

  // Reset canvases
  if (D.canvasImage) {
    D.canvasImage.width = 1;
    D.canvasImage.height = 1;
    D.canvasImage.hidden = false;
  }
  if (D.canvasResult) {
    D.canvasResult.hidden = true;
  }
  if (maskCanvas) {
    maskCanvas.resize(1, 1);
  }
  D.canvasMask.style.opacity = '1';
  D.canvasMask.style.pointerEvents = 'auto';

  // Reset UI state
  D.dropzone.hidden = false;
  D.editor.hidden = true;
  D.fileName.textContent = 'No file loaded';
  D.fileDims.textContent = '— × —';
  D.fileSize.textContent = '— MB';
  updateRemoveEnabled();   // no file now, so this disables it
  D.btnDownload.disabled = true;
  D.btnNewFile.disabled = true;
  D.btnStartOver.disabled = true;
  D.stageHint.hidden = false;

  dbg.set('file', 'no');
  dbg.set('filetype', '—');
  dbg.set('dims', '—');
  dbg.set('coverage', '0%');
  dbg.log('Start over — back to dropzone');

  setPreviewLabel(null);
  toast('Ready for a new file.', 'info', 2500);
}

// === Stage modal helper ===
function showStageModal({ icon = '⚠️', title = 'Heads up', msg, btnText = 'OK, got it' }) {
  D.stageModalIcon.textContent = icon;
  D.stageModalTitle.textContent = title;
  D.stageModalMsg.textContent = msg;
  D.stageModalOk.textContent = btnText;
  D.stageModal.hidden = false;
}
function hideStageModal() { D.stageModal.hidden = true; }

// Honest progress: park at 15% (mask prep done), show only elapsed time
// counter during the long AI step. No more "stuck at 90%" lie.
function startFakeProgress(expectedSeconds = 30) {
  D.processingFill.style.width = '15%';
  // Animate the bar as a pulsing indeterminate state (CSS handles the shimmer)
  D.processingFill.classList.add('indeterminate');
  const start = performance.now();
  const id = setInterval(() => {
    const elapsed = (performance.now() - start) / 1000;
    D.processingStage.textContent =
      elapsed < expectedSeconds
        ? `Running AI inference — ${elapsed.toFixed(0)}s elapsed`
        : `Still working — ${elapsed.toFixed(0)}s (larger images take longer, hang tight)`;
  }, 200);
  return () => {
    clearInterval(id);
    D.processingFill.classList.remove('indeterminate');
  };
}

// === Inpainting ===
async function runRemoval() {
  state.removeClickCount++;
  dbg.set('removes', String(state.removeClickCount));
  dbg.log(`Remove clicked #${state.removeClickCount}`);

  // 1. INSTANT visual feedback
  D.btnRemove.classList.add('loading');

  // 2. Validate
  if (!state.imageData) {
    D.btnRemove.classList.remove('loading');
    showStageModal({ icon: '🖼', title: 'No file loaded', msg: 'Drop an image or video first, then try again.' });
    dbg.warn('No imageData when Remove clicked');
    return;
  }

  // Read the mask ONCE. getImageData() copies the whole canvas, so the old
  // hasContent() → getCoveragePercent() → getMaskImageData() sequence was
  // three full-resolution pixel copies before any work started.
  let rawMask = null;
  if (maskCanvas) {
    try {
      rawMask = maskCanvas.getMaskImageData();
    } catch (e) {
      D.btnRemove.classList.remove('loading');
      dbg.error('Could not read mask: ' + (e.message || e));
      showStageModal({ icon: '❌', title: 'Could not read the mask', msg: String(e.message || e) });
      return;
    }
  }
  if (!rawMask || !maskHasContent(rawMask)) {
    D.btnRemove.classList.remove('loading');
    showStageModal({
      icon: '✏️',
      title: 'Draw the watermark first',
      msg: 'Use the Rectangle tool to drag a box around the watermark — or the Brush to paint over it — then click Remove again.',
    });
    dbg.warn('Mask is empty when Remove clicked');
    return;
  }

  console.log('[remove] clicked. state:', {
    kind: state.kind,
    hasImage: !!state.imageData,
    quality: state.quality,
    passes: inpainter.getPassCount(state.quality),
  });

  if (!(await inpainter.isReady())) {
    D.btnRemove.classList.remove('loading');
    showStageModal({ icon: '⏳', title: 'AI model still loading', msg: 'Give it a few more seconds and try again.' });
    dbg.warn('Inpainter not ready when Remove clicked');
    return;
  }

  // 3. Show processing overlay
  D.processingOverlay.hidden = false;
  D.processingTitle.textContent = state.kind === 'video' ? 'Removing watermark from video…' : 'Removing watermark…';
  D.processingSub.textContent = state.kind === 'video'
    ? 'AI runs ONCE on the first frame, then we paint the clean pixels onto every frame. Much faster than per-frame AI.'
    : 'This stays on-screen until done. You can keep this tab open in the background.';
  D.processingFill.style.width = '5%';
  D.processingStage.textContent = 'Preparing mask';
  D.stageHint.hidden = true;
  setStatus('Processing', 'busy');

  // Expand the mask (already read above — no second getImageData).
  let maskData;
  try {
    maskData = state.maskExpand > 0 ? dilateMask(rawMask, state.maskExpand) : rawMask;
  } catch (e) {
    D.processingOverlay.hidden = true;
    D.btnRemove.classList.remove('loading');
    dbg.error('Mask prep failed: ' + e.message);
    showStageModal({ icon: '❌', title: 'Mask preparation failed', msg: e.message });
    return;
  }

  // Estimate. Scales with the number of model runs the chosen quality costs
  // ("Best" is a two-pass coarse-to-fine refine, so it's ~2× "Balanced").
  // For videos: the AI runs once on the first frame (static-mask optimization),
  // then ~1.5× video duration for seeking + compositing every frame.
  const isWebGPU = inpainter.getBackend() === 'webgpu';
  const baseTime = (isWebGPU ? 3 : 20) * inpainter.getPassCount(state.quality);
  const expected = state.kind === 'video'
    ? baseTime + Math.ceil(state.videoInfo.duration * 1.5)
    : baseTime;
  const stopProgress = startFakeProgress(expected);

  try {
    if (state.kind === 'video') {
      await runVideoRemoval(maskData);
    } else {
      await runImageRemoval(maskData);
    }
    stopProgress();
    D.processingFill.style.width = '100%';
    D.processingTitle.textContent = '✓ Done!';
    D.processingSub.textContent = 'Click Download in the sidebar to save your file.';
    D.processingStage.textContent = '';
    setTimeout(() => { D.processingOverlay.hidden = true; }, 1300);
    D.btnDownload.disabled = false;
    setStatus(`Ready (${inpainter.getBackend()})`, 'ready');
    dbg.log('Remove finished successfully');
  } catch (e) {
    stopProgress();
    console.error('[remove] FAILED:', e);
    dbg.error(String(e.message || e));
    setStatus('Error', 'error');
    D.processingOverlay.hidden = true;
    showStageModal({
      icon: '❌',
      title: 'Could not remove the watermark',
      msg: `${e.message || e}\n\nOpen the 🪲 Debug panel (or press \`) for details.`,
    });
  } finally {
    D.btnRemove.classList.remove('loading');
  }
}

async function runImageRemoval(maskData) {
  const t0 = performance.now();
  // featherRadius is intentionally not passed — it comes from the quality preset.
  const result = await inpainter.inpaint(state.imageData, maskData, {
    quality: state.quality,
    onPass: (i, total) => {
      if (total > 1) D.processingStage.textContent = `Refining — AI pass ${i + 1} of ${total}`;
    },
  });
  const tMs = Math.round(performance.now() - t0);

  state.resultData = result;
  D.canvasResult.getContext('2d').putImageData(result, 0, 0);
  D.canvasResult.hidden = false;
  D.canvasImage.hidden = true;

  // Wipe + hide the mask canvas so the brush color can't bleed through visually.
  if (maskCanvas) {
    maskCanvas.ctx.clearRect(0, 0, maskCanvas.canvas.width, maskCanvas.canvas.height);
  }
  D.canvasMask.style.opacity = '0';
  D.canvasMask.style.pointerEvents = 'none';
  state.showResult = true;
  setPreviewLabel('after');

  dbg.log(`Image inpaint done in ${(tMs / 1000).toFixed(1)}s`);
  toast(`Watermark removed in ${(tMs / 1000).toFixed(1)}s. Click Download.`, 'success');
}

async function runVideoRemoval(maskData) {
  if (!state.videoInfo) throw new Error('No video loaded');
  const { video } = state.videoInfo;

  // Frame-by-frame inpaint function: receives a frame ImageData, returns processed.
  const inpaintFrame = async (frameImg) => {
    return await inpainter.inpaint(frameImg, maskData, { quality: state.quality });
  };

  // Honor user's chosen video format preference
  let preferredMime;
  if (state.outputFormat === 'mp4') {
    preferredMime = 'video/mp4;codecs=avc1,mp4a.40.2';
    if (!MediaRecorder.isTypeSupported(preferredMime)) preferredMime = undefined;
  } else if (state.outputFormat === 'webm') {
    preferredMime = 'video/webm;codecs=vp9,opus';
    if (!MediaRecorder.isTypeSupported(preferredMime)) preferredMime = undefined;
  }

  const t0 = performance.now();
  const blob = await processVideo({
    video,
    maskImageData: maskData,
    inpaintFn: inpaintFrame,
    onProgress: (pct, stage) => {
      D.processingFill.style.width = `${pct.toFixed(1)}%`;
      D.processingStage.textContent = stage;
    },
    opts: { includeAudio: true, mimeType: preferredMime },
  });
  const tMs = Math.round(performance.now() - t0);

  state.videoBlob = blob;

  // Set up the result video element with the processed blob. Revoke any
  // previous result first — Remove can be clicked more than once per file.
  if (D.videoResult.src && D.videoResult.src.startsWith('blob:')) {
    URL.revokeObjectURL(D.videoResult.src);
  }
  const resultUrl = URL.createObjectURL(blob);
  D.videoResult.src = resultUrl;
  D.videoResult.load();
  D.videoResult.hidden = false;
  state.showResult = true;

  // Set up the original video element too (for before/after compare)
  // Use the same source URL the original was loaded from
  if (state.videoInfo?.url && D.videoOriginal) {
    D.videoOriginal.src = state.videoInfo.url;
    D.videoOriginal.load();
    D.videoOriginal.hidden = true;  // hidden by default; Compare button toggles
  }

  // Hide the masking surfaces
  D.canvasImage.hidden = true;
  D.canvasMask.style.opacity = '0';
  D.canvasMask.style.pointerEvents = 'none';
  setPreviewLabel('after');

  // Refit so the video sits properly in the stage
  requestAnimationFrame(() => {
    fitCanvasToStage();
    setTimeout(fitCanvasToStage, 100);
  });

  dbg.log(`Video processed in ${(tMs / 1000).toFixed(1)}s — ${(blob.size / 1024 / 1024).toFixed(1)} MB output`);
  toast(`Video ready. Press play to preview, then Download.`, 'success', 5000);
}

async function downloadResult() {
  const base = (state.filename || 'output').replace(/\.[^.]+$/, '');

  // Build the blob first (so we can save to disk-folder AND/OR download)
  let blob = null, ext = 'png';
  if (state.kind === 'video' && state.videoBlob) {
    blob = state.videoBlob;
    // Use the actual recorded mime to determine extension —
    // we honor the user's preference where possible but MediaRecorder
    // may have picked a different codec.
    const type = (blob.type || '').toLowerCase();
    ext = type.includes('mp4') ? 'mp4' : type.includes('webm') ? 'webm' : 'mp4';
  } else if (state.resultData) {
    ext = state.outputFormat;
    const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const quality = ext === 'png' ? undefined : 0.95;
    blob = await new Promise(r => D.canvasResult.toBlob(r, mime, quality));
  } else {
    toast('Nothing to download — process a file first.', 'warning');
    return;
  }
  if (!blob) {
    toast('Could not encode result.', 'error');
    return;
  }

  const filename = `${base}-clean.${ext}`;

  // 1. If user has a folder picked, save there silently
  let savedToFolder = false;
  try {
    const folder = await fsFolder.getActiveFolder();
    if (folder) {
      await fsFolder.saveBlob(folder, filename, blob);
      savedToFolder = true;
      toast(`Saved to your folder: ${filename}`, 'success', 4000);
      dbg.log('Saved to folder: ' + filename);
    }
  } catch (e) {
    console.warn('Could not save to folder, falling back to browser download:', e);
    dbg.warn('Folder save failed: ' + (e.message || e));
  }

  // 2. Always also trigger the browser download (so the user gets their file
  //    either way, whether or not the folder feature worked)
  if (!savedToFolder) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

function toggleCompare() {
  if (state.kind === 'video') {
    if (!state.videoBlob) return;
    state.showResult = !state.showResult;
    if (state.showResult) {
      D.videoOriginal?.pause();
      D.videoResult.hidden = false;
      D.videoOriginal.hidden = true;
      setPreviewLabel('after');
    } else {
      D.videoResult?.pause();
      D.videoOriginal.hidden = false;
      D.videoResult.hidden = true;
      setPreviewLabel('before');
    }
    return;
  }
  if (!state.resultData) return;
  state.showResult = !state.showResult;
  D.canvasImage.hidden = state.showResult;
  D.canvasResult.hidden = !state.showResult;
  D.canvasMask.style.opacity = state.showResult ? '0' : '0.7';
  setPreviewLabel(state.showResult ? 'after' : 'before');
}

function setPreviewLabel(kind) {
  if (!D.previewLabel) return;
  if (kind === 'after') {
    D.previewLabel.textContent = '✓ After (cleaned)';
    D.previewLabel.className = 'preview-label after';
    D.previewLabel.hidden = false;
  } else if (kind === 'before') {
    D.previewLabel.textContent = 'Before (original)';
    D.previewLabel.className = 'preview-label before';
    D.previewLabel.hidden = false;
  } else {
    D.previewLabel.hidden = true;
  }
}

// === Wire up ===
function bindUI() {
  bindDropzone({
    dropzoneEl: D.dropzone,
    fileInputEl: D.fileInput,
    browseBtn: D.btnBrowse,
    onFile: onFileLoaded,
  });

  D.toolBtns.forEach(b => {
    b.addEventListener('click', () => {
      D.toolBtns.forEach(x => {
        x.classList.remove('active');
        x.setAttribute('aria-pressed', 'false');
      });
      b.classList.add('active');
      b.setAttribute('aria-pressed', 'true');   // .active is CSS-only; screen readers need this
      state.tool = b.dataset.tool;
      maskCanvas?.setTool(state.tool);
      dbg.set('tool', state.tool);
    });
  });

  // Debug panel custom events
  document.addEventListener('dbg:force-remove', () => runRemoval());
  document.addEventListener('dbg:fill-mask', () => {
    if (!state.imageData || !maskCanvas) {
      dbg.warn('Cannot fill: no image loaded');
      return;
    }
    maskCanvas.clear();
    const { width: w, height: h } = state.imageData;
    const rw = Math.round(w * 0.55);
    const rh = Math.round(h * 0.30);
    const rx = Math.round((w - rw) / 2);
    const ry = Math.round((h - rh) / 2);
    const ctx = maskCanvas.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(255, 64, 192, 0.65)';
    ctx.fillRect(rx, ry, rw, rh);
    D.stageHint.hidden = true;
    dbg.log(`Filled debug mask at (${rx}, ${ry}, ${rw}, ${rh})`);
  });

  D.brushSize.addEventListener('input', () => {
    state.brushSize = +D.brushSize.value;
    D.brushSizeVal.textContent = state.brushSize;
    maskCanvas?.setBrushSize(state.brushSize);
  });

  D.maskExpand.addEventListener('input', () => {
    state.maskExpand = +D.maskExpand.value;
    D.maskExpandVal.textContent = `${state.maskExpand} px`;
  });

  const QUALITY_HINTS = {
    fast:     'Fast — one AI pass, tight crop. Sharpest detail, least context.',
    balanced: 'Balanced — one AI pass, wide context.',
    best:     'Best — two AI passes (structure, then sharpen). ~2× slower.',
  };
  const qualityHint = document.getElementById('quality-hint');
  document.querySelectorAll('input[name="quality"]').forEach(r => {
    r.addEventListener('change', () => {
      state.quality = r.value;
      if (qualityHint) qualityHint.textContent = QUALITY_HINTS[r.value] || '';
      dbg.set('quality', r.value);
    });
  });

  D.outputFormat.addEventListener('change', () => { state.outputFormat = D.outputFormat.value; });

  D.btnNewFile.addEventListener('click', resetToDropzone);
  const handleDelete = () => {
    if (!state.image && !state.videoInfo) return;
    if (confirm('Discard this file and start over?')) resetToDropzone();
  };
  D.btnStartOver?.addEventListener('click', handleDelete);
  D.btnDeleteCanvas?.addEventListener('click', handleDelete);
  D.btnRemove.addEventListener('click', runRemoval);
  D.btnDownload.addEventListener('click', downloadResult);
  D.btnCompare.addEventListener('click', toggleCompare);
  D.btnUndo.addEventListener('click', () => maskCanvas?.undo());
  D.btnClearMask.addEventListener('click', () => maskCanvas?.clear());
  D.btnZoomFit.addEventListener('click', fitCanvasToStage);

  D.stageModalOk?.addEventListener('click', hideStageModal);

  // === Preset watermark masks ===
  //
  // Coordinates as fractions of the image dimensions: (x, y) = top-left corner
  // of the mask rect, (w, h) = mask size. Tuned to match real watermark sizes
  // on a 1024×1024 reference image. Tight masks = cleaner MI-GAN output.
  //
  // Each preset also has a `shape` — 'rounded' draws a rounded-rect (matches
  // most AI logo badges); 'rect' is a plain rectangle.
  const PRESETS = {
    // Gemini's sparkle badge is ~70px on a 1024-wide image (~7%).
    // Margin from edge is ~25px (~2.5%).
    'gemini-br':       { x: 0.89, y: 0.89, w: 0.085, h: 0.075, shape: 'rounded', label: 'Gemini ✨ bottom-right' },
    'gemini-bl':       { x: 0.025, y: 0.89, w: 0.085, h: 0.075, shape: 'rounded', label: 'Gemini ✨ bottom-left' },

    // DALL·E watermark is small text "DALL·E" at the bottom-right.
    'dalle-br':        { x: 0.88, y: 0.945, w: 0.10, h: 0.03, shape: 'rounded', label: 'DALL·E bottom-right' },

    // DALL·E 2 has a tiny multi-color bar in the very corner.
    'dalle-color-bar': { x: 0.93, y: 0.955, w: 0.06, h: 0.025, shape: 'rect', label: 'DALL·E 2 color bar' },

    // Bing Image Creator: small Bing logo + watermark.
    'bing-creator':    { x: 0.88, y: 0.91, w: 0.10, h: 0.06, shape: 'rounded', label: 'Bing Image Creator' },

    // Adobe Firefly: rounded badge with star icon.
    'firefly-br':      { x: 0.89, y: 0.89, w: 0.085, h: 0.075, shape: 'rounded', label: 'Adobe Firefly' },

    // Midjourney doesn't strictly watermark but credit-strips appear at bottom.
    'midjourney-br':   { x: 0.86, y: 0.94, w: 0.12, h: 0.035, shape: 'rounded', label: 'Midjourney credit' },

    // Meta AI: rounded "Imagined with AI" badge.
    'meta-ai':         { x: 0.025, y: 0.90, w: 0.18, h: 0.05, shape: 'rounded', label: 'Meta AI' },

    // Tiled stock-photo watermarks are not corner-located — handled separately.
    'stock-tile':      null,
  };

  function fillRoundedRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    ctx.fill();
  }

  function applyPreset(key) {
    if (!state.imageData || !maskCanvas) {
      showStageModal({ icon: '🖼', title: 'Load a file first', msg: 'Drop an image or video, then pick a watermark preset.' });
      return;
    }
    if (key === 'custom') return;

    const { width: w, height: h } = state.imageData;
    maskCanvas.clear();
    const ctx = maskCanvas.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(255, 64, 192, 0.65)';

    if (key === 'stock-tile') {
      const cell = Math.round(Math.min(w, h) * 0.22);
      ctx.save();
      for (let y = 0; y < h; y += cell) {
        for (let x = 0; x < w; x += cell) {
          if (((x / cell) + (y / cell)) % 2 === 0) {
            ctx.fillRect(x + cell * 0.3, y + cell * 0.4, cell * 0.5, cell * 0.2);
          }
        }
      }
      ctx.restore();
      dbg.log(`Preset stock-tile applied across ${w}×${h}`);
      toast('Applied tiled stock-photo mask. Fine-tune with brush if needed.', 'info', 4500);
    } else {
      const p = PRESETS[key];
      if (!p) return;
      const rx = Math.round(w * p.x);
      const ry = Math.round(h * p.y);
      const rw = Math.round(w * p.w);
      const rh = Math.round(h * p.h);
      if (p.shape === 'rounded') {
        const radius = Math.round(Math.min(rw, rh) * 0.35);
        fillRoundedRect(ctx, rx, ry, rw, rh, radius);
      } else {
        ctx.fillRect(rx, ry, rw, rh);
      }
      dbg.log(`Preset ${key}: rect(${rx}, ${ry}, ${rw}, ${rh}) over image ${w}×${h}`);
      toast(`Applied "${p.label}" preset. Fine-tune with brush if needed, then Remove.`, 'info', 4500);
    }

    D.stageHint.hidden = true;
  }

  D.btnApplyPreset?.addEventListener('click', () => {
    applyPreset(D.presetSelect?.value || 'custom');
  });
  // Apply automatically when user changes the select (cuts a click)
  D.presetSelect?.addEventListener('change', () => {
    applyPreset(D.presetSelect.value);
  });

  // Hide the "drag a rectangle" hint as soon as the user starts drawing
  D.canvasMask?.addEventListener('pointerdown', () => {
    D.stageHint.hidden = true;
  });

  // Relay keyboard-masking feedback to the aria-live region.
  const maskStatus = document.getElementById('mask-status');
  document.addEventListener('mask:announce', (e) => {
    if (maskStatus) maskStatus.textContent = e.detail?.message || '';
    D.stageHint.hidden = true;
  });

  D.btnPickFolder?.addEventListener('click', onPickFolder);

  D.btnClearModel?.addEventListener('click', async () => {
    if (!confirm('Delete the cached AI model from your device? It\'ll re-download (~29 MB) next time you open the app.')) return;
    const ok = await clearModel();
    if (ok) {
      toast('Cached model deleted. Refresh the page to download a fresh copy.', 'success', 5000);
      setModelStatus('downloading');
      refreshStorageStatus();
    } else {
      toast('Could not delete the cached model.', 'error');
    }
  });

  // Keyboard shortcuts. Bound to window with capture so they fire even when
  // focus is on a button (e.g. just-clicked tool button).
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    // Skip when user is typing into a text/number field, but NOT for buttons,
    // sliders, or selects (so shortcuts still work after clicking a tool).
    if (t && typeof t.tagName === 'string') {
      if (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'radio' && t.type !== 'checkbox') return;
      if (t.tagName === 'TEXTAREA') return;
    }
    // The mask canvas owns arrows/Enter/Space for keyboard drawing — don't let
    // Space also fire the compare toggle while someone is drawing.
    if (t === D.canvasMask && (e.key === ' ' || e.key === 'Enter' || e.key.startsWith('Arrow'))) {
      return;
    }

    const key = e.key.toLowerCase();
    const map = { b: 'brush', e: 'erase', r: 'rect' };

    if (map[key]) {
      const btn = document.querySelector(`.tool-btn[data-tool="${map[key]}"]`);
      if (btn) {
        btn.click();
        toast(`Tool: ${map[key]}`, 'info', 1200);
        dbg.log(`Keyboard: ${key.toUpperCase()} → ${map[key]}`);
      }
      e.preventDefault();
    } else if (e.key === ' ') {
      e.preventDefault();
      toggleCompare();
      dbg.log('Keyboard: Space → compare');
    } else if ((e.ctrlKey || e.metaKey) && key === 'z') {
      e.preventDefault();
      maskCanvas?.undo();
      dbg.log('Keyboard: Ctrl+Z → undo');
    } else if (key === 'escape') {
      e.preventDefault();
      // Esc closes modals first, otherwise resets
      if (!D.stageModal.hidden) {
        hideStageModal();
      } else if (state.image || state.videoInfo) {
        if (confirm('Discard this file and start over?')) {
          resetToDropzone();
        }
      }
      dbg.log('Keyboard: Esc');
    } else if (key === 'd' && state.resultData) {
      e.preventDefault();
      downloadResult();
      dbg.log('Keyboard: D → download');
    }
  });

  // Refit canvas on viewport resize so the image always stays inside .stage
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitCanvasToStage, 80);
  });

  // Also observe the stage element directly — handles sidebar scrolling that
  // changes available canvas width without triggering window.resize.
  if (typeof ResizeObserver !== 'undefined') {
    const stage = document.getElementById('stage');
    if (stage) {
      const ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(fitCanvasToStage, 50);
      });
      ro.observe(stage);
    }
  }

  // Catch all errors so the page doesn't show a blank screen
  window.addEventListener('error', (e) => {
    console.error(e);
    toast(`Error: ${e.message || 'something went wrong'}`, 'error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e);
    toast(`Error: ${e.reason?.message || e.reason}`, 'error');
  });
}

// === Boot ===
bindUI();
populateOutputFormats('image');  // initial defaults before any file is loaded
bootstrap();
