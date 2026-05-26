/**
 * LaMa inpainting via ONNX Runtime Web.
 *
 * Pipeline:
 *   1. Resize image + mask to <= 512px on longest side (for speed).
 *   2. Normalize image to [0,1] CHW float32, mask to binary [0,1].
 *   3. Run model.
 *   4. Postprocess output back to RGB ImageData.
 *   5. Upscale to original dimensions if needed.
 *   6. Blend along feathered mask boundary.
 */

import { loadModel } from './model-cache.js';

// MI-GAN ONNX (verified by `onnx.load` inspection of the actual file):
//   INPUT:  name='input',  shape=[1, 4, 512, 512], dtype=FLOAT
//   OUTPUT: name='output', shape=[?, 3, 512, 512], dtype=FLOAT
// Despite what some web tutorials suggest, this export is FIXED at 512×512.
const MODEL_SIZE = 512;

let session = null;
let activeBackend = 'unknown';

export function getBackend() {
  return activeBackend;
}

export async function isReady() {
  return session !== null;
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
 * Inpaint using MI-GAN (Picsart Research, ICCV 2023) — designed specifically
 * for browser-based watermark/object removal.
 *
 * Key differences from LaMa:
 *   - uint8 tensors (no float normalization)
 *   - Dynamic input shape (no fixed 512×512 — runs at native or near-native res)
 *   - Smaller (29 MB vs 200 MB)
 *   - Better quality for incremental/small brush strokes (the watermark case)
 *
 * Strategy:
 *   1. Find the mask bbox.
 *   2. Crop image+mask with generous context around the bbox.
 *   3. If the crop is bigger than MAX_INPUT_SIZE on the longest side, downscale
 *      uniformly so MI-GAN runs in reasonable browser memory.
 *   4. Feed uint8 image + mask tensors to the model (no normalization).
 *   5. Postprocess uint8 CHW → RGBA ImageData (no scaling, no range detection).
 *   6. If we downscaled in step 3, upscale the result back to crop size.
 *   7. Composite into the original with binary-mask alpha + feathered edges.
 *
 * Reference: github.com/lxfater/inpaint-web (production browser implementation)
 */
export async function inpaint(imageData, maskData, opts = {}) {
  if (!session) throw new Error('Inpainter not initialized — call init() first');
  if (imageData.width !== maskData.width || imageData.height !== maskData.height) {
    throw new Error('Image and mask dimensions must match');
  }
  const featherRadius = opts.featherRadius ?? 6;
  const { width: W, height: H } = imageData;

  // 1. Find the mask bbox.
  const bbox = findMaskBbox(maskData);
  if (!bbox) {
    console.warn('[inpainter] Mask is empty — returning original image');
    return imageData;
  }

  // 2. Square crop around the mask with generous context, then resize to 512.
  //    MI-GAN is fixed at 512×512 so the crop size doesn't matter for inference,
  //    but a tighter crop = higher effective resolution at the watermark area.
  const maskDim = Math.max(bbox.w, bbox.h);
  // Crop must be >= mask + reasonable context, and >= 512 so we don't upscale below model size
  const desiredSize = Math.max(MODEL_SIZE, maskDim * 3);
  const cropSize = Math.min(desiredSize, Math.min(W, H));

  const centerX = bbox.x + bbox.w / 2;
  const centerY = bbox.y + bbox.h / 2;
  let cropX = Math.round(centerX - cropSize / 2);
  let cropY = Math.round(centerY - cropSize / 2);
  cropX = Math.max(0, Math.min(W - cropSize, cropX));
  cropY = Math.max(0, Math.min(H - cropSize, cropY));

  // Inference is always at the model's fixed 512×512.
  const inferW = MODEL_SIZE;
  const inferH = MODEL_SIZE;

  console.log(
    `[inpainter] MI-GAN: mask bbox ${bbox.w}×${bbox.h} at (${bbox.x},${bbox.y}); ` +
    `crop ${cropSize}×${cropSize} at (${cropX},${cropY}); infer ${inferW}×${inferH}; image ${W}×${H}`
  );

  // Extract the crop at native resolution, then resize to the model's 512×512.
  const cropImage = await cropImageData(imageData, cropX, cropY, cropSize, cropSize);
  const cropMask  = await cropImageData(maskData,  cropX, cropY, cropSize, cropSize);
  const inferImage = await resizeImageData(cropImage, inferW, inferH, 'bilinear');
  const inferMask  = await resizeImageData(cropMask,  inferW, inferH, 'bilinear');

  // 4. Build tensors — MI-GAN uses raw uint8, NO normalization.
  const imgTensor  = imageToUint8CHW(inferImage);
  const maskTensor = maskToUint8CHW(inferMask);

  // Build feeds — adapt to ANY combination of input layout / dtype the
  // MI-GAN ONNX export uses. We've seen both:
  //   1) Single 4-channel float32 input [1,4,H,W] = RGB(0-1) + mask(0-1)
  //   2) Two inputs: image [1,3,H,W] float32 + mask [1,1,H,W] float32
  const inputNames = Array.from(session.inputNames || []);
  if (inputNames.length === 0) {
    throw new Error(`Model declares no inputs. Names: ${JSON.stringify(inputNames)}`);
  }

  // Build MI-GAN's exact expected input — verified against Picsart's official
  // demo.py preprocess() function:
  //   img:  [-1, 1] range  (float32)
  //   mask: 1.0 = KEEP, 0.0 = INPAINT  (opposite of LaMa convention!)
  //   4-channel input layout:
  //     channel 0 = mask - 0.5
  //     channels 1-3 = (img * mask)  ← masked area is zeroed in input
  const feeds = {};
  const migInput = buildMIGANInput(inferImage, inferMask);
  feeds[inputNames[0]] = new ort.Tensor('float32', migInput, [1, 4, inferH, inferW]);
  console.log(`[inpainter] MI-GAN input '${inputNames[0]}' [1,4,${inferH},${inferW}] float32 (Picsart spec)`);

  let output;
  try {
    output = await session.run(feeds);
  } catch (e) {
    throw new Error(
      `MI-GAN inference failed for inputs [${inputNames.join(', ')}]: ${e.message || e}.`
    );
  }

  // Postprocess. Inspect the output tensor shape and dtype.
  const outName = Object.keys(output)[0];
  const outTensor = output[outName];
  const outData = outTensor.data;
  const outDims = outTensor.dims;
  console.log(`[inpainter] Output '${outName}' dims=${JSON.stringify(outDims)} dtype=${outTensor.type} length=${outData.length}`);

  // Output is [1, 3, 512, 512] float32 in [-1, 1] range. Convert with the
  // Picsart formula: (v * 0.5 + 0.5).clamp(0,1) * 255
  const outH = outDims[2] || inferH;
  const outW = outDims[3] || inferW;
  const inferResult = miganOutputToImageData(outData, outW, outH);

  // 6. Resize inference result back up to crop size.
  const cropResult = (inferW === cropSize && inferH === cropSize)
    ? inferResult
    : await resizeImageData(inferResult, cropSize, cropSize, 'bilinear');

  // 7. Composite into the original.
  return pasteCropWithMask(imageData, cropResult, cropMask, cropX, cropY, featherRadius);
}

/**
 * Convert RGBA ImageData to CHW uint8 array (raw pixel values, no normalization).
 */
function imageToUint8CHW(imageData) {
  const { data, width, height } = imageData;
  const size = width * height;
  const out = new Uint8Array(3 * size);
  for (let i = 0; i < size; i++) {
    out[i]              = data[i * 4];     // R plane
    out[i + size]       = data[i * 4 + 1]; // G plane
    out[i + size * 2]   = data[i * 4 + 2]; // B plane
  }
  return out;
}

/**
 * Convert mask ImageData (alpha-channel = mask) to single-channel uint8.
 * Convention: 255 = inpaint, 0 = keep — matches MI-GAN's expectation.
 */
function maskToUint8CHW(maskData) {
  const { data, width, height } = maskData;
  const size = width * height;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = data[i * 4 + 3] > 64 ? 255 : 0;
  }
  return out;
}

/**
 * Combine an RGBA image and an RGBA mask into a single 4-channel CHW uint8
 * buffer: [R-plane | G-plane | B-plane | mask-plane]. Used by MI-GAN ONNX
 * exports that take a single 4-channel uint8 input.
 */
function combineRGBAndMaskCHW(imageData, maskData) {
  const { width, height, data: img } = imageData;
  const mask = maskData.data;
  const size = width * height;
  const out = new Uint8Array(4 * size);
  for (let i = 0; i < size; i++) {
    out[i]            = img[i * 4];      // R
    out[i + size]     = img[i * 4 + 1];  // G
    out[i + size * 2] = img[i * 4 + 2];  // B
    out[i + size * 3] = mask[i * 4 + 3] > 64 ? 255 : 0;  // mask
  }
  return out;
}

/**
 * Build MI-GAN's exact expected 4-channel input — matches Picsart's official
 * Python preprocess() byte-for-byte:
 *
 *   img normalized:  img_norm = img * 2 / 255 - 1           // [-1, 1]
 *   mask normalized: mask_norm = (mask_alpha > thresh) ? 0 : 1   // 1=keep, 0=inpaint
 *   x = concat([mask_norm - 0.5, img_norm * mask_norm], axis=1)
 *
 * Resulting channels:
 *   plane 0: mask_norm - 0.5    (so 0.5 in known area, -0.5 in hole)
 *   plane 1: R_norm * mask_norm (preserved R in known area, 0 in hole)
 *   plane 2: G_norm * mask_norm
 *   plane 3: B_norm * mask_norm
 */
function buildMIGANInput(imageData, maskData) {
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
 * Convert MI-GAN's [-1, 1] float32 CHW output to RGBA ImageData.
 * Matches Picsart's exact formula: (v * 0.5 + 0.5).clamp(0, 1) * 255.
 */
function miganOutputToImageData(chw, w, h) {
  let minV = Infinity, maxV = -Infinity;
  const step = Math.max(1, Math.floor(chw.length / 5000));
  for (let i = 0; i < chw.length; i += step) {
    if (chw[i] < minV) minV = chw[i];
    if (chw[i] > maxV) maxV = chw[i];
  }
  console.log(`[inpainter] MI-GAN output min=${minV.toFixed(3)} max=${maxV.toFixed(3)} (expected ~[-1, 1])`);

  const out = new Uint8ClampedArray(w * h * 4);
  const size = w * h;
  for (let i = 0; i < size; i++) {
    const r = Math.max(0, Math.min(1, chw[i]              * 0.5 + 0.5)) * 255;
    const g = Math.max(0, Math.min(1, chw[i + size]       * 0.5 + 0.5)) * 255;
    const b = Math.max(0, Math.min(1, chw[i + size * 2]   * 0.5 + 0.5)) * 255;
    out[i * 4]     = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, w, h);
}

/**
 * Convert CHW uint8 model output → RGBA ImageData. No scaling needed.
 */
function uint8CHWtoImageData(chw, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  const size = w * h;
  for (let i = 0; i < size; i++) {
    out[i * 4]     = chw[i];
    out[i * 4 + 1] = chw[i + size];
    out[i * 4 + 2] = chw[i + size * 2];
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, w, h);
}

/**
 * Find the bounding box of non-transparent pixels in a mask ImageData.
 * Returns null if the mask is empty. Uses alpha channel > 16 as the threshold.
 */
function findMaskBbox(maskData) {
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
  maskCv.getContext('2d').putImageData(binary, 0, 0);
  const featherCv = new OffscreenCanvas(cw, ch);
  const fctx = featherCv.getContext('2d');
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

// === Helpers ===

/**
 * Scale an ImageData proportionally to fit inside a target square,
 * then center-pad to the full square with `padColor` (RGBA).
 * Returns the padded ImageData plus the metadata needed to crop back later.
 */
async function letterbox(src, target, padColor) {
  const { width: W, height: H } = src;
  const scale = Math.min(target / W, target / H);
  const scaledW = Math.max(1, Math.round(W * scale));
  const scaledH = Math.max(1, Math.round(H * scale));
  const padX = Math.floor((target - scaledW) / 2);
  const padY = Math.floor((target - scaledH) / 2);

  const canvas = new OffscreenCanvas(target, target);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgba(${padColor[0]}, ${padColor[1]}, ${padColor[2]}, ${(padColor[3] ?? 255) / 255})`;
  ctx.fillRect(0, 0, target, target);

  const srcCanvas = new OffscreenCanvas(W, H);
  srcCanvas.getContext('2d').putImageData(src, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, padX, padY, scaledW, scaledH);

  return {
    image: ctx.getImageData(0, 0, target, target),
    scale, padX, padY, scaledW, scaledH,
  };
}

async function cropImageData(src, x, y, w, h) {
  const cn = new OffscreenCanvas(w, h);
  const ctx = cn.getContext('2d');
  const srcCn = new OffscreenCanvas(src.width, src.height);
  srcCn.getContext('2d').putImageData(src, 0, 0);
  ctx.drawImage(srcCn, x, y, w, h, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function floatCHWtoImageData(chw, w, h) {
  // Auto-detect the model's output value range. Three common conventions:
  //   • [-1, 1]  (GAN/StyleGAN-style) → map (v+1)/2*255
  //   • [0, 1]   (standard normalized) → multiply by 255
  //   • [0, 255] (already pixel range) → use as-is
  // We sample a wide chunk of the buffer to characterize the distribution.
  let maxV = -Infinity, minV = Infinity, sumV = 0, nSamples = 0;
  const step = Math.max(1, Math.floor(chw.length / 8000));
  for (let i = 0; i < chw.length; i += step) {
    const v = chw[i];
    if (v > maxV) maxV = v;
    if (v < minV) minV = v;
    sumV += v;
    nSamples++;
  }
  const meanV = sumV / nSamples;

  let mode, convert;
  if (minV < -0.1) {
    // GAN-style [-1, 1]
    mode = `[-1, 1] (GAN-style)`;
    convert = (v) => Math.max(0, Math.min(255, (v + 1) / 2 * 255));
  } else if (maxV > 2.0) {
    mode = `[0, 255] (already pixel range)`;
    convert = (v) => Math.max(0, Math.min(255, v));
  } else {
    mode = `[0, 1] (normalized)`;
    convert = (v) => Math.max(0, Math.min(255, v * 255));
  }

  console.log(
    `[inpainter] Model output min=${minV.toFixed(3)} max=${maxV.toFixed(3)} mean=${meanV.toFixed(3)} → ${mode}`
  );

  const out = new Uint8ClampedArray(w * h * 4);
  const planeSize = w * h;
  for (let i = 0; i < planeSize; i++) {
    out[i * 4 + 0] = convert(chw[i]);
    out[i * 4 + 1] = convert(chw[i + planeSize]);
    out[i * 4 + 2] = convert(chw[i + planeSize * 2]);
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, w, h);
}

/**
 * Convert RGBA ImageData to CHW float32 array [0,1].
 * Returns Float32Array of length 3*h*w in C-major order: [R-plane | G-plane | B-plane].
 */
function imageToFloat32CHW(imageData) {
  const { data, width, height } = imageData;
  const size = width * height;
  const out = new Float32Array(3 * size);
  for (let i = 0; i < size; i++) {
    out[i] = data[i * 4] / 255;
    out[i + size] = data[i * 4 + 1] / 255;
    out[i + size * 2] = data[i * 4 + 2] / 255;
  }
  return out;
}

/**
 * Convert mask ImageData (alpha channel determines mask) to single-channel float32.
 * Returns Float32Array of length h*w with values 0 (keep) or 1 (remove).
 */
function maskToFloat32CHW(maskData) {
  const { data, width, height } = maskData;
  const size = width * height;
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    // alpha channel
    out[i] = data[i * 4 + 3] > 128 ? 1.0 : 0.0;
  }
  return out;
}

/**
 * Resize an ImageData via OffscreenCanvas. Mode is hint-only — browsers don't expose nearest vs. bilinear directly.
 * We approximate nearest by disabling smoothing.
 */
async function resizeImageData(imageData, w, h, mode = 'bilinear') {
  const src = new OffscreenCanvas(imageData.width, imageData.height);
  src.getContext('2d').putImageData(imageData, 0, 0);

  const dst = new OffscreenCanvas(w, h);
  const ctx = dst.getContext('2d');
  ctx.imageSmoothingEnabled = mode === 'bilinear';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * Blend `replacement` into `original` only where the `mask` alpha > 0,
 * with a Gaussian-feathered boundary for seamless transitions.
 */
function blendByMask(original, replacement, mask, featherRadius = 4) {
  const W = original.width, H = original.height;
  // Build feathered alpha by stack-blurring the mask alpha channel
  const featherCanvas = new OffscreenCanvas(W, H);
  const fctx = featherCanvas.getContext('2d');
  // Draw mask
  const maskCanvas = new OffscreenCanvas(W, H);
  maskCanvas.getContext('2d').putImageData(mask, 0, 0);
  // Apply blur via filter
  fctx.filter = `blur(${featherRadius}px)`;
  fctx.drawImage(maskCanvas, 0, 0);
  fctx.filter = 'none';
  const feather = fctx.getImageData(0, 0, W, H);

  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const a = feather.data[i * 4 + 3] / 255;  // 0..1 blend weight
    out[i * 4 + 0] = original.data[i * 4 + 0] * (1 - a) + replacement.data[i * 4 + 0] * a;
    out[i * 4 + 1] = original.data[i * 4 + 1] * (1 - a) + replacement.data[i * 4 + 1] * a;
    out[i * 4 + 2] = original.data[i * 4 + 2] * (1 - a) + replacement.data[i * 4 + 2] * a;
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, W, H);
}
