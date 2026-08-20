/**
 * MI-GAN inpainting via ONNX Runtime Web.
 *
 * Model: MI-GAN (Picsart Research, ICCV 2023) — a GAN inpainter designed for
 * mobile/browser deployment. The ONNX export we use is FIXED at 512×512 with a
 * single 4-channel float32 input.
 *
 * Pipeline per pass:
 *   1. Find the mask bounding box.
 *   2. Square-crop image + mask around it with `context` × the mask size.
 *   3. Resize the crop to the model's 512×512.
 *   4. Build MI-GAN's 4-channel input (see buildMIGANInput for the exact spec).
 *   5. Run the model; map the [-1,1] output back to RGB.
 *   6. Resize the result back to crop size.
 *   7. Composite into the original — only masked pixels change.
 *
 * Because the model input is a fixed 512×512, the crop size is what sets the
 * *effective resolution* at the watermark: a tighter crop means more model
 * pixels are spent on the area you actually care about, at the cost of less
 * surrounding context for the GAN to match against. That tradeoff is what the
 * Quality setting exposes (see QUALITY_PRESETS).
 */

import { loadModel } from './model-cache.js';

// MI-GAN ONNX (verified by `onnx.load` inspection of the actual file):
//   INPUT:  name='input',  shape=[1, 4, 512, 512], dtype=FLOAT
//   OUTPUT: name='output', shape=[?, 3, 512, 512], dtype=FLOAT
// Despite what some web tutorials suggest, this export is FIXED at 512×512.
const MODEL_SIZE = 512;

/**
 * Quality presets. `contexts` is the list of inference passes to run, each
 * value being the crop size as a multiple of the mask's longest side:
 *
 *   - Lower context  = tighter crop = more model pixels on the watermark
 *                      (sharper detail, less surrounding texture to match).
 *   - Higher context = wider crop  = better structural continuity with the
 *                      surrounding image (softer detail at the mask).
 *
 * `best` runs two passes coarse-to-fine: a wide-context pass establishes
 * structure, then a tighter pass re-inpaints the same region at roughly 1.7×
 * the effective resolution to sharpen it. That second pass is a full extra
 * model run, so Best costs about 2× the time of Balanced.
 */
const QUALITY_PRESETS = {
  fast:     { contexts: [2.0],      feather: 3 },
  balanced: { contexts: [3.0],      feather: 6 },
  best:     { contexts: [3.0, 1.8], feather: 8 },
};
const DEFAULT_QUALITY = 'balanced';

let session = null;
let activeBackend = 'unknown';

export function getBackend() {
  return activeBackend;
}

export async function isReady() {
  return session !== null;
}

/**
 * Number of model runs a given quality setting costs. The UI uses this to give
 * an honest time estimate instead of assuming every mode takes the same time.
 */
export function getPassCount(quality) {
  return (QUALITY_PRESETS[quality] ?? QUALITY_PRESETS[DEFAULT_QUALITY]).contexts.length;
}

export async function init(onProgress) {
  if (session) return session;
  if (typeof ort === 'undefined') {
    throw new Error('ONNX Runtime Web (ort) is not loaded — check your script tag.');
  }

  // Configure ORT before creating session
  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  ort.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 4);
  ort.env.wasm.simd = true;
  // proxy=true runs ALL ORT work (model parsing AND inference) in a Web Worker
  // so the main thread / UI never freezes during a long inpaint. Requires COI
  // for the worker to have shared memory; if COI isn't on, ORT silently falls
  // back to main-thread mode (slower UI, still works).
  ort.env.wasm.proxy = true;
  ort.env.logLevel = 'warning';

  // Track whether the model came from cache, so the loader UI stays correct
  // through subsequent ORT init progress callbacks.
  let wasCached = false;
  const wrappedProgress = (p) => {
    if (p?.cached) wasCached = true;
    onProgress?.({ ...p, cached: p?.cached || wasCached });
  };

  // Download (or restore-from-cache) model
  wrappedProgress({ stage: 'Looking for model on this device…', done: 0, total: 0 });
  const modelBytes = await loadModel(wrappedProgress);

  // Try execution providers in order: webgpu → webgl → wasm
  const providers = ['webgpu', 'webgl', 'wasm'];
  let lastErr = null;

  for (const ep of providers) {
    try {
      wrappedProgress({
        stage: `Initializing ${ep.toUpperCase()}…`,
        done: modelBytes.byteLength,
        total: modelBytes.byteLength,
      });
      session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      activeBackend = ep;
      // Log model's input/output specs so we can verify the format we expect.
      const inputNames = Array.from(session.inputNames || []);
      const outputNames = Array.from(session.outputNames || []);
      console.log(`[inpainter] Active backend: ${ep}`);
      console.log(`[inpainter] Model inputs:`, inputNames);
      console.log(`[inpainter] Model outputs:`, outputNames);
      wrappedProgress({
        stage: 'Ready',
        done: modelBytes.byteLength,
        total: modelBytes.byteLength,
        ready: true,
        backend: ep,
      });
      return session;
    } catch (e) {
      // EXPECTED in many browsers: WebGPU isn't on (Safari/Firefox), or WebGL
      // can't handle int64 ops in this model. We fall back to WASM.
      // Demoted to info-level so it doesn't look like a real error.
      console.info(`[inpainter] ${ep} not available (will try next backend):`, e?.message || e);
      lastErr = e;
    }
  }

  throw new Error(`No usable ONNX backend. Last error: ${lastErr?.message || lastErr}`);
}

/**
 * Inpaint the masked region of `imageData`.
 *
 * @param {ImageData} imageData  source image
 * @param {ImageData} maskData   same dimensions; alpha > 64 marks pixels to remove
 * @param {object}    opts
 * @param {'fast'|'balanced'|'best'} [opts.quality]  see QUALITY_PRESETS
 * @param {number}    [opts.featherRadius]  overrides the preset's feather
 * @param {(passIndex:number, totalPasses:number) => void} [opts.onPass]
 * @returns {Promise<ImageData>} a new ImageData; the input is not mutated
 */
export async function inpaint(imageData, maskData, opts = {}) {
  if (!session) throw new Error('Inpainter not initialized — call init() first');
  if (imageData.width !== maskData.width || imageData.height !== maskData.height) {
    throw new Error('Image and mask dimensions must match');
  }

  const preset = QUALITY_PRESETS[opts.quality] ?? QUALITY_PRESETS[DEFAULT_QUALITY];
  const featherRadius = opts.featherRadius ?? preset.feather;

  // The bbox depends only on the mask, which is identical across passes.
  const bbox = findMaskBbox(maskData);
  if (!bbox) {
    console.warn('[inpainter] Mask is empty — returning original image');
    return imageData;
  }

  const totalPasses = preset.contexts.length;
  let current = imageData;
  for (let i = 0; i < totalPasses; i++) {
    opts.onPass?.(i, totalPasses);
    current = await runPass(current, maskData, bbox, {
      context: preset.contexts[i],
      featherRadius,
      // Only log the output-range diagnostic once — it's the same model each pass.
      logRange: i === 0,
      passLabel: `${i + 1}/${totalPasses}`,
    });
  }
  return current;
}

/**
 * One crop → resize → infer → composite cycle.
 */
async function runPass(imageData, maskData, bbox, { context, featherRadius, logRange, passLabel }) {
  const { width: W, height: H } = imageData;

  // Square crop around the mask, sized as a multiple of the mask itself.
  //
  // The crop is always resized to the model's fixed 512×512, so a crop SMALLER
  // than 512 is upscaled going in and downscaled coming out — which spends more
  // of the model's fixed capacity on the watermark and is how a tight crop buys
  // detail. (An earlier version floored this at 512 "so we don't upscale", but
  // that made every context multiplier collapse to the same crop for the common
  // case — a small corner badge — so the Quality setting had no visible effect.)
  //
  // The lower bound keeps a little real context around the mask no matter how
  // aggressive the multiplier is; the upper bound is the image itself.
  const maskDim = Math.max(bbox.w, bbox.h);
  const minSize = Math.min(Math.round(maskDim * 1.25) + 16, W, H);
  const cropSize = Math.max(minSize, Math.min(Math.round(maskDim * context), W, H));

  const centerX = bbox.x + bbox.w / 2;
  const centerY = bbox.y + bbox.h / 2;
  let cropX = Math.round(centerX - cropSize / 2);
  let cropY = Math.round(centerY - cropSize / 2);
  cropX = Math.max(0, Math.min(W - cropSize, cropX));
  cropY = Math.max(0, Math.min(H - cropSize, cropY));

  console.log(
    `[inpainter] pass ${passLabel} (context ×${context}): mask ${bbox.w}×${bbox.h} at ` +
    `(${bbox.x},${bbox.y}); crop ${cropSize}×${cropSize} at (${cropX},${cropY}); image ${W}×${H}`
  );

  const cropImage = await cropImageData(imageData, cropX, cropY, cropSize, cropSize);
  const cropMask  = await cropImageData(maskData,  cropX, cropY, cropSize, cropSize);
  const inferImage = await resizeImageData(cropImage, MODEL_SIZE, MODEL_SIZE, 'bilinear');
  const inferMask  = await resizeImageData(cropMask,  MODEL_SIZE, MODEL_SIZE, 'bilinear');

  const inputNames = Array.from(session.inputNames || []);
  if (inputNames.length === 0) {
    throw new Error('Model declares no inputs.');
  }

  const feeds = {};
  feeds[inputNames[0]] = new ort.Tensor(
    'float32',
    buildMIGANInput(inferImage, inferMask),
    [1, 4, MODEL_SIZE, MODEL_SIZE]
  );

  let output;
  try {
    output = await session.run(feeds);
  } catch (e) {
    throw new Error(
      `MI-GAN inference failed for inputs [${inputNames.join(', ')}]: ${e.message || e}.`
    );
  }

  const outName = Object.keys(output)[0];
  const outTensor = output[outName];
  const outDims = outTensor.dims;
  const outH = outDims[2] || MODEL_SIZE;
  const outW = outDims[3] || MODEL_SIZE;

  if (logRange) {
    logOutputRange(outTensor.data);
  }

  const inferResult = new ImageData(
    miganOutputToRGBA(outTensor.data, outW, outH), outW, outH
  );

  // Resize the inference result back up to crop size.
  const cropResult = (outW === cropSize && outH === cropSize)
    ? inferResult
    : await resizeImageData(inferResult, cropSize, cropSize, 'bilinear');

  return pasteCropWithMask(imageData, cropResult, cropMask, cropX, cropY, featherRadius);
}

/**
 * Sanity-check the model's output range. MI-GAN should emit roughly [-1, 1];
 * anything else means the input layout is wrong and the result will be garbage.
 * This is diagnostic only — it samples, it doesn't scan the whole buffer.
 */
function logOutputRange(chw) {
  let minV = Infinity, maxV = -Infinity;
  const step = Math.max(1, Math.floor(chw.length / 5000));
  for (let i = 0; i < chw.length; i += step) {
    if (chw[i] < minV) minV = chw[i];
    if (chw[i] > maxV) maxV = chw[i];
  }
  console.log(`[inpainter] MI-GAN output min=${minV.toFixed(3)} max=${maxV.toFixed(3)} (expected ~[-1, 1])`);
}

// === Tensor math ============================================================
// The three functions below are the pixel-math core. They are pure (no canvas,
// no DOM) and exported so tools/test-inpainter.mjs can regression-test them in
// Node — every constant here was wrong on the first implementation and the
// failure mode is silent (bleed-through / inverted mask), not an exception.

/**
 * Build MI-GAN's exact expected 4-channel input — matches Picsart's official
 * Python preprocess() byte-for-byte:
 *
 *   img normalized:  img_norm = img * 2 / 255 - 1                // [-1, 1]
 *   mask normalized: mask_norm = (mask_alpha > thresh) ? 0 : 1   // 1=keep, 0=inpaint
 *   x = concat([mask_norm - 0.5, img_norm * mask_norm], axis=1)
 *
 * Resulting channels:
 *   plane 0: mask_norm - 0.5    (so 0.5 in known area, -0.5 in hole)
 *   plane 1: R_norm * mask_norm (preserved R in known area, 0 in hole)
 *   plane 2: G_norm * mask_norm
 *   plane 3: B_norm * mask_norm
 *
 * NOTE the mask polarity is INVERTED relative to LaMa. Getting this backwards
 * inpaints everything except the watermark.
 *
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} imageData
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} maskData
 * @returns {Float32Array} length 4*w*h, CHW order
 */
export function buildMIGANInput(imageData, maskData) {
  const { width, height, data: img } = imageData;
  const maskBytes = maskData.data;
  const size = width * height;
  const out = new Float32Array(4 * size);
  for (let i = 0; i < size; i++) {
    // User's brush alpha > 64 means they marked this for removal.
    // MI-GAN wants 1.0 = keep, 0.0 = inpaint — so we invert.
    const isInpaint = maskBytes[i * 4 + 3] > 64;
    const mask = isInpaint ? 0.0 : 1.0;

    // Image normalized to [-1, 1]
    const r = (img[i * 4]     / 255) * 2 - 1;
    const g = (img[i * 4 + 1] / 255) * 2 - 1;
    const b = (img[i * 4 + 2] / 255) * 2 - 1;

    out[i]            = mask - 0.5;  // plane 0
    out[i + size]     = r * mask;    // plane 1 (R, zeroed in hole)
    out[i + size * 2] = g * mask;    // plane 2 (G, zeroed in hole)
    out[i + size * 3] = b * mask;    // plane 3 (B, zeroed in hole)
  }
  return out;
}

/**
 * Convert MI-GAN's [-1, 1] float32 CHW output to a flat RGBA byte array.
 * Matches Picsart's exact formula: (v * 0.5 + 0.5).clamp(0, 1) * 255.
 *
 * @returns {Uint8ClampedArray} length 4*w*h, RGBA order
 */
export function miganOutputToRGBA(chw, w, h) {
  const size = w * h;
  const out = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    out[i * 4]     = Math.max(0, Math.min(1, chw[i]            * 0.5 + 0.5)) * 255;
    out[i * 4 + 1] = Math.max(0, Math.min(1, chw[i + size]     * 0.5 + 0.5)) * 255;
    out[i * 4 + 2] = Math.max(0, Math.min(1, chw[i + size * 2] * 0.5 + 0.5)) * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * Find the bounding box of non-transparent pixels in a mask.
 * Returns null if the mask is empty. Uses alpha > 16 as the threshold.
 *
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} maskData
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function findMaskBbox(maskData) {
  const { width, height, data } = maskData;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// === Compositing ============================================================

/**
 * Paste an inpainted crop back into the full image at (offsetX, offsetY).
 *
 * CRITICAL: We BINARIZE the mask first (alpha → 0 or 255), THEN apply Gaussian
 * feathering. If we used the raw mask alpha (~166 from the user's brush at
 * 0.65 opacity), the compositing math would be:
 *     result = inpainted * 0.65 + original * 0.35
 * meaning 35% of the original watermark would bleed through every "removed"
 * pixel — exactly the "visible mark" bug. The fix matches IOPaint:
 *     mask = (mask > 0) * 1      # binary
 *     result = inpainted * mask + original * (1 - mask)
 * with feathering ONLY at the edge for clean blending.
 */
function pasteCropWithMask(original, inpaintedCrop, cropMask, offsetX, offsetY, featherRadius) {
  const W = original.width, H = original.height;
  const cw = inpaintedCrop.width, ch = inpaintedCrop.height;

  // 1. Binarize the mask alpha: full opaque (255) inside, transparent (0) outside.
  const binary = new ImageData(cw, ch);
  const THRESHOLD = 64;  // alpha above this counts as "in mask"
  for (let i = 0; i < cw * ch; i++) {
    const a = cropMask.data[i * 4 + 3];
    const v = a > THRESHOLD ? 255 : 0;
    binary.data[i * 4]     = v;
    binary.data[i * 4 + 1] = v;
    binary.data[i * 4 + 2] = v;
    binary.data[i * 4 + 3] = v;
  }

  // 2. Feather the binary mask via canvas blur. Result: alpha=255 deep inside,
  //    alpha=0 outside, smooth ramp at the boundary.
  const maskCv = new OffscreenCanvas(cw, ch);
  maskCv.getContext('2d', READBACK).putImageData(binary, 0, 0);
  const featherCv = new OffscreenCanvas(cw, ch);
  const fctx = featherCv.getContext('2d', READBACK);
  fctx.filter = `blur(${featherRadius}px)`;
  fctx.drawImage(maskCv, 0, 0);
  fctx.filter = 'none';
  const feather = fctx.getImageData(0, 0, cw, ch);

  // 3. Composite. Inside the mask: full replacement (a=1, original is gone).
  //    Edge: smooth blend. Outside: untouched.
  const out = new Uint8ClampedArray(original.data);
  for (let y = 0; y < ch; y++) {
    const oy = offsetY + y;
    if (oy < 0 || oy >= H) continue;
    for (let x = 0; x < cw; x++) {
      const ox = offsetX + x;
      if (ox < 0 || ox >= W) continue;
      const a = feather.data[(y * cw + x) * 4 + 3] / 255;
      if (a <= 0) continue;
      const dst = (oy * W + ox) * 4;
      const src = (y  * cw + x ) * 4;
      out[dst    ] = inpaintedCrop.data[src    ] * a + out[dst    ] * (1 - a);
      out[dst + 1] = inpaintedCrop.data[src + 1] * a + out[dst + 1] * (1 - a);
      out[dst + 2] = inpaintedCrop.data[src + 2] * a + out[dst + 2] * (1 - a);
      out[dst + 3] = 255;
    }
  }
  return new ImageData(out, W, H);
}

// === Canvas helpers =========================================================

// These canvases exist purely to be read back, so flag them as such — without
// it the browser keeps them GPU-backed and every getImageData stalls on a
// readback. (Chrome logs an explicit warning about this.)
const READBACK = { willReadFrequently: true };

async function cropImageData(src, x, y, w, h) {
  const cn = new OffscreenCanvas(w, h);
  const ctx = cn.getContext('2d', READBACK);
  const srcCn = new OffscreenCanvas(src.width, src.height);
  srcCn.getContext('2d', READBACK).putImageData(src, 0, 0);
  ctx.drawImage(srcCn, x, y, w, h, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * Resize an ImageData via OffscreenCanvas. Mode is hint-only — browsers don't
 * expose nearest vs. bilinear directly; we approximate nearest by disabling
 * smoothing.
 */
async function resizeImageData(imageData, w, h, mode = 'bilinear') {
  const src = new OffscreenCanvas(imageData.width, imageData.height);
  src.getContext('2d', READBACK).putImageData(imageData, 0, 0);

  const dst = new OffscreenCanvas(w, h);
  const ctx = dst.getContext('2d', READBACK);
  ctx.imageSmoothingEnabled = mode === 'bilinear';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
