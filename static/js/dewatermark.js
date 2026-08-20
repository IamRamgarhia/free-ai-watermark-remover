/**
 * Watermark REMOVAL by un-blending, as opposed to inpainting.
 *
 * WHY THIS EXISTS
 * ---------------
 * Inpainting deletes the masked pixels and asks a generative model to invent
 * replacements. For an opaque badge that is the only option — the original
 * content really is gone. But most AI-generator watermarks are *semi-transparent*,
 * and that changes everything: the original content is still present in those
 * pixels, merely blended with the badge.
 *
 *     observed = alpha * watermark + (1 - alpha) * original
 *
 * Which rearranges to:
 *
 *     original = (observed - alpha * watermark) / (1 - alpha)
 *
 * So if we can estimate `alpha` (how opaque the badge is at each pixel) and
 * `watermark` (its colour, nearly always white), we can RECOVER the true pixels
 * instead of fabricating plausible ones. Wood grain, skin texture, brick, hair —
 * all of it survives, because it was never actually destroyed.
 *
 * This is the difference between "the watermark is gone and the texture
 * continues underneath it" and "there is a smudge of nearby colours where the
 * watermark used to be".
 *
 * ESTIMATING THE TWO UNKNOWNS
 * ---------------------------
 * `watermark` colour: these badges are drawn in white or near-white, so we
 * check whether the marked area is lighter or darker than its surroundings and
 * take white or black accordingly. Both are supported because some badges are
 * dark-on-light.
 *
 * `alpha`: we need the background that lies *under* the badge. We estimate only
 * its LOW-FREQUENCY component by diffusing surrounding colour inward (a discrete
 * Laplace solve). That sounds like the very "fill with nearby colours" this is
 * meant to avoid — the crucial difference is that we do not use that fill as the
 * output. We use it only as a baseline to solve for alpha, and then the actual
 * detail comes back out of the observed pixels. The interpolation supplies the
 * illumination level; the real data supplies the texture.
 *
 *     alpha = (observed - background) / (watermark - background)
 *
 * WHERE THIS HONESTLY CANNOT WIN
 * ------------------------------
 * As alpha approaches 1 the badge is opaque, the division explodes, and no
 * information about the original survives. Those pixels are reported back in
 * `residualMask` so the caller can hand just that core to the inpainter. A
 * typical badge then needs generative fill over a far smaller area than the
 * whole badge — often none at all.
 */

/**
 * @param {ImageData} imageData  source image
 * @param {ImageData} maskData   same size; alpha > 64 marks the watermark
 * @param {object} [opts]
 * @param {number} [opts.maxAlpha=0.92]  above this the pixel is treated as opaque
 * @param {number} [opts.pad=6]          extra context sampled around the mask
 * @returns {{ result: ImageData, residualMask: ImageData, stats: object }}
 *          `result` has the watermark un-blended away; `residualMask` marks the
 *          pixels that were too opaque to recover and still need inpainting.
 */
export function unblendWatermark(imageData, maskData, opts = {}) {
  const maxAlpha = opts.maxAlpha ?? 0.92;
  const pad = opts.pad ?? 6;
  const { width: W, height: H } = imageData;

  const bbox = maskBbox(maskData, pad);
  if (!bbox) {
    return {
      result: imageData,
      residualMask: emptyMask(W, H),
      stats: { recovered: 0, opaque: 0, meanAlpha: 0, skipped: 'empty mask' },
    };
  }

  const { x: bx, y: by, w: bw, h: bh } = bbox;
  const n = bw * bh;

  // --- Local copies of the working window ----------------------------------
  const obs = new Float32Array(n * 3);
  const inMask = new Uint8Array(n);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const si = ((by + y) * W + (bx + x)) * 4;
      const o = y * bw + x;
      obs[o * 3]     = imageData.data[si];
      obs[o * 3 + 1] = imageData.data[si + 1];
      obs[o * 3 + 2] = imageData.data[si + 2];
      inMask[o] = maskData.data[si + 3] > 64 ? 1 : 0;
    }
  }

  // --- Background under the mark, by inward diffusion ----------------------
  const bg = diffuseInward(obs, inMask, bw, bh);

  // --- Is the mark lighter or darker than what surrounds it? ---------------
  let lift = 0, marked = 0;
  for (let o = 0; o < n; o++) {
    if (!inMask[o]) continue;
    marked++;
    const lo = 0.299 * obs[o * 3] + 0.587 * obs[o * 3 + 1] + 0.114 * obs[o * 3 + 2];
    const lb = 0.299 * bg[o * 3]  + 0.587 * bg[o * 3 + 1]  + 0.114 * bg[o * 3 + 2];
    lift += lo - lb;
  }
  const wmValue = lift >= 0 ? 255 : 0;   // white badge vs dark badge

  // --- Solve for alpha, then invert the blend ------------------------------
  const out = new Uint8ClampedArray(imageData.data);
  const residual = emptyMask(W, H);
  let recovered = 0, opaque = 0, alphaSum = 0;

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const o = y * bw + x;
      if (!inMask[o]) continue;

      // Estimate alpha per channel and take the median. Channels where the
      // badge and background happen to be similar give an unstable ratio; the
      // median ignores those instead of letting them dominate.
      const a = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const denom = wmValue - bg[o * 3 + c];
        a[c] = Math.abs(denom) < 1e-3
          ? 0
          : (obs[o * 3 + c] - bg[o * 3 + c]) / denom;
      }
      a.sort((p, q) => p - q);
      let alpha = a[1];
      if (!Number.isFinite(alpha)) alpha = 0;
      alpha = Math.max(0, Math.min(1, alpha));

      const di = ((by + y) * W + (bx + x)) * 4;

      if (alpha >= maxAlpha) {
        // Opaque: nothing of the original survives here. Leave the pixel for
        // the inpainter and record it.
        opaque++;
        residual.data[di]     = 255;
        residual.data[di + 1] = 255;
        residual.data[di + 2] = 255;
        residual.data[di + 3] = 255;
        continue;
      }

      alphaSum += alpha;
      recovered++;
      const k = 1 - alpha;
      for (let c = 0; c < 3; c++) {
        out[di + c] = (obs[o * 3 + c] - alpha * wmValue) / k;
      }
      out[di + 3] = 255;
    }
  }

  return {
    result: new ImageData(out, W, H),
    residualMask: residual,
    stats: {
      recovered,
      opaque,
      marked,
      meanAlpha: recovered ? alphaSum / recovered : 0,
      watermarkColor: wmValue,
      // Fraction of the marked area that still needs generative fill.
      residualFraction: marked ? opaque / marked : 0,
    },
  };
}

/**
 * Estimate what lies under the mask by diffusing surrounding colour inward.
 *
 * This is a Jacobi relaxation of the Laplace equation with the unmasked pixels
 * pinned as boundary conditions — it converges to a smooth interpolation. A
 * multi-resolution pass first gets the low frequencies across wide gaps quickly,
 * so a handful of fine iterations is then enough.
 *
 * Only the smooth baseline matters here; texture is recovered from the observed
 * pixels by the caller, not from this.
 */
function diffuseInward(obs, inMask, w, h) {
  const n = w * h;
  const bg = new Float32Array(obs);

  // Seed the holes with the mean of the known pixels so relaxation starts from
  // something sane rather than from the watermark's own colour.
  let sum = [0, 0, 0], known = 0;
  for (let o = 0; o < n; o++) {
    if (inMask[o]) continue;
    known++;
    for (let c = 0; c < 3; c++) sum[c] += obs[o * 3 + c];
  }
  if (known === 0) return bg;
  const mean = sum.map(s => s / known);
  for (let o = 0; o < n; o++) {
    if (!inMask[o]) continue;
    for (let c = 0; c < 3; c++) bg[o * 3 + c] = mean[c];
  }

  // Relax. Iterations scale with hole size — a wider gap needs more passes for
  // the boundary to reach the middle.
  let maxRun = 0, run = 0;
  for (let y = 0; y < h; y++) {
    run = 0;
    for (let x = 0; x < w; x++) {
      run = inMask[y * w + x] ? run + 1 : 0;
      if (run > maxRun) maxRun = run;
    }
  }
  const iters = Math.min(600, Math.max(40, maxRun * 6));

  const next = new Float32Array(bg);
  for (let it = 0; it < iters; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = y * w + x;
        if (!inMask[o]) continue;
        for (let c = 0; c < 3; c++) {
          let acc = 0, cnt = 0;
          if (x > 0)     { acc += bg[(o - 1) * 3 + c]; cnt++; }
          if (x < w - 1) { acc += bg[(o + 1) * 3 + c]; cnt++; }
          if (y > 0)     { acc += bg[(o - w) * 3 + c]; cnt++; }
          if (y < h - 1) { acc += bg[(o + w) * 3 + c]; cnt++; }
          next[o * 3 + c] = cnt ? acc / cnt : bg[o * 3 + c];
        }
      }
    }
    for (let o = 0; o < n; o++) {
      if (!inMask[o]) continue;
      for (let c = 0; c < 3; c++) bg[o * 3 + c] = next[o * 3 + c];
    }
  }
  return bg;
}

function maskBbox(maskData, pad) {
  const { width: w, height: h, data } = maskData;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 64) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function emptyMask(w, h) {
  return new ImageData(new Uint8ClampedArray(w * h * 4), w, h);
}

/** True if the residual is small enough that inpainting can be skipped. */
export function residualIsNegligible(stats, threshold = 0.02) {
  return stats.residualFraction <= threshold;
}
