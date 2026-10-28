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
 * Laplace solve), and from it a raw per-pixel alpha:
 *
 *     alpha_raw = (observed - background) / (watermark - background)
 *
 * That raw alpha must NOT be used directly. Substituting it back into the
 * inversion gives exactly `background` for every pixel: the pixel's own texture
 * is absorbed into its alpha and cancels out. An earlier version did this and
 * its output was, measurably, the smooth diffusion fill and nothing more
 * (same PSNR, texture correlation 0.2).
 *
 * The fix is to use what we know about the two signals. Texture is
 * high-frequency and zero-mean around the background; a badge's alpha is
 * locally flat with edges. A median over a small window keeps the edges and
 * rejects the texture, so the alpha it yields is the badge's, and the
 * texture then comes back out of the observed pixels in the inversion.
 *
 * This is still an estimate from one image. When the exact alpha map of a
 * known watermark is available (see gemini-template.js) that is used instead
 * and the recovery is essentially exact.
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
 * @param {number} [opts.maxAlpha=0.85]  above this the pixel is treated as opaque
 * @param {number} [opts.pad=6]          extra context sampled around the mask
 * @param {number} [opts.alphaRadius=3]  median window radius for the alpha map
 * @param {Float32Array} [opts.background] background from a previous call on
 *        the same mask (video: the previous frame). Warm-starts the solve.
 * @param {number} [opts.iterations]     cap on relaxation passes
 * @param {{map: Float32Array, wmValue: number}} [opts.alpha] a known alpha map
 *        for this mask (as returned in `alpha` by an earlier call). Skips the
 *        estimate. Video estimates once and reuses it on every frame: the
 *        overlay does not change between frames, and averaging estimates from
 *        several frames cancels the texture leakage of any single one.
 * @returns {{ result: ImageData, residualMask: ImageData, stats: object }}
 *          `result` has the watermark un-blended away; `residualMask` marks the
 *          pixels that were too opaque to recover and still need inpainting.
 */
export function unblendWatermark(imageData, maskData, opts = {}) {
  // Recovery divides by (1 - alpha), so it amplifies any error in the input by
  // 1/(1-alpha). At alpha 0.85 that is already 6.7x, which turns ordinary JPEG
  // ringing near an edge into visible speckle; by 0.95 it is 20x and hopeless.
  // Past this point the honest move is to hand the pixel to the inpainter
  // rather than to amplify noise and call it detail.
  const maxAlpha = opts.maxAlpha ?? 0.85;
  const pad = opts.pad ?? 6;
  const alphaRadius = opts.alphaRadius ?? 3;
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

  let marked = 0;
  for (let o = 0; o < n; o++) marked += inMask[o];

  let alphaMap, wmValue, bg = null;
  if (opts.alpha && opts.alpha.map.length === n) {
    alphaMap = opts.alpha.map;
    wmValue = opts.alpha.wmValue;
  } else {
    // --- Background under the mark, by inward diffusion ----------------------
    const warm = opts.background && opts.background.length === n * 3 ? opts.background : null;
    bg = diffuseInward(obs, inMask, bw, bh, warm, opts.iterations);

    // --- Is the mark lighter or darker than what surrounds it? ---------------
    let lift = 0;
    for (let o = 0; o < n; o++) {
      if (!inMask[o]) continue;
      const lo = 0.299 * obs[o * 3] + 0.587 * obs[o * 3 + 1] + 0.114 * obs[o * 3 + 2];
      const lb = 0.299 * bg[o * 3]  + 0.587 * bg[o * 3 + 1]  + 0.114 * bg[o * 3 + 2];
      lift += lo - lb;
    }
    wmValue = lift >= 0 ? 255 : 0;   // white badge vs dark badge

    // --- Raw alpha per pixel (texture leaks into this; see header) ----------
    const rawAlpha = new Float32Array(n);
    for (let o = 0; o < n; o++) {
      if (!inMask[o]) continue;
      // Estimate per channel and take the median. Channels where the badge and
      // background happen to be similar give an unstable ratio; the median
      // ignores those instead of letting them dominate.
      const a = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const denom = wmValue - bg[o * 3 + c];
        a[c] = Math.abs(denom) < 1e-3
          ? 0
          : (obs[o * 3 + c] - bg[o * 3 + c]) / denom;
      }
      a.sort((p, q) => p - q);
      const v = a[1];
      rawAlpha[o] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    }

    // --- The badge's alpha: an edge-preserving median of the raw estimate -----
    const localAlpha = medianFilter(rawAlpha, inMask, bw, bh, alphaRadius);
    // If the mark looks like it has one opacity, try that too, and keep
    // whichever leaves texture inside the mask that matches the texture around
    // it.
    const flat = flattenUniformAlpha(localAlpha, rawAlpha, inMask, bw, bh);
    if (flat && textureMismatch(obs, flat, inMask, bw, bh, wmValue) <
                textureMismatch(obs, localAlpha, inMask, bw, bh, wmValue)) {
      localAlpha.set(flat);
    }
    alphaMap = localAlpha;
  }

  // --- Invert the blend ------------------------------------------------------
  const out = new Uint8ClampedArray(imageData.data);
  const residual = emptyMask(W, H);
  let recovered = 0, opaque = 0, alphaSum = 0, clampedPx = 0, effective = 0;

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const o = y * bw + x;
      if (!inMask[o]) continue;

      const alpha = alphaMap[o];
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

      // Recover, but check the result is physically sensible before keeping it.
      // If the alpha estimate is wrong the division pushes channels far outside
      // [0,255]; that clamping is the signal that this pixel cannot be trusted.
      const k = 1 - alpha;
      const rec = [0, 0, 0];
      let clamped = 0;
      for (let c = 0; c < 3; c++) {
        const v = (obs[o * 3 + c] - alpha * wmValue) / k;
        if (v < -8 || v > 263) clamped++;
        rec[c] = v;
      }

      if (clamped > 0) {
        // Amplified nonsense. Send it to the inpainter instead of writing a
        // blown-out pixel — a smear is bad, a bright speckle is worse.
        opaque++;
        clampedPx++;
        residual.data[di] = 255;
        residual.data[di + 1] = 255;
        residual.data[di + 2] = 255;
        residual.data[di + 3] = 255;
        continue;
      }

      alphaSum += alpha;
      if (alpha > 0.05) effective++;
      recovered++;
      for (let c = 0; c < 3; c++) out[di + c] = rec[c];
      out[di + 3] = 255;
    }
  }

  // If almost nothing had a meaningful alpha, the mask is not covering a
  // translucent overlay at all — the user has marked a solid object, or a badge
  // that is opaque everywhere. Un-blending correctly left those pixels alone,
  // but then the residual would be empty too, and the caller would skip the
  // inpainter and show the user an unchanged image. Fall back to handing the
  // whole mask over to be filled instead.
  const effectiveFraction = marked ? effective / marked : 0;
  // Fall back only when recovery genuinely achieved NOTHING — not merely when
  // the mask is bigger than the mark.
  //
  // This previously required 15% of the MASK to have meaningful alpha, which
  // quietly punished exactly the masks we tell people to draw. A sparkle is a
  // thin star, so most of its own bounding box is empty, and auto-detect pads
  // generously on top of that. A perfectly good translucent badge landed near
  // 15%, tripped the fallback, and the entire padded box was handed to the
  // inpainter — producing a flat smear across textured backgrounds, which is
  // the precise failure this whole module exists to avoid.
  //
  // What actually indicates "this is not a translucent overlay" is that almost
  // no pixel anywhere in the mask was translucent, in absolute terms.
  const fellBack = effective < 24 && effectiveFraction < 0.02;
  if (fellBack) {
    return {
      result: imageData,
      residualMask: maskData,
      background: bg,
      alpha: { map: alphaMap, wmValue },
      stats: {
        recovered: 0, opaque: marked, marked, clamped: clampedPx,
        meanAlpha: recovered ? alphaSum / recovered : 0,
        watermarkColor: wmValue,
        effectiveFraction,
        fellBack: true,
        residualFraction: 1,
      },
    };
  }

  return {
    result: new ImageData(out, W, H),
    residualMask: residual,
    background: bg,
    alpha: { map: alphaMap, wmValue },
    stats: {
      recovered,
      opaque,
      marked,
      clamped: clampedPx,
      meanAlpha: recovered ? alphaSum / recovered : 0,
      watermarkColor: wmValue,
      effectiveFraction,
      fellBack: false,
      // Fraction of the marked area that still needs generative fill.
      residualFraction: marked ? opaque / marked : 0,
    },
  };
}

/**
 * Most watermarks that are not Gemini's — text, logos, badges — are drawn at
 * ONE opacity. This returns a copy of the alpha map whose core is that single
 * value, measured over all the core's pixels, or null if there is no clear
 * core.
 *
 * It matters more than it looks. Recovery error is roughly the alpha error
 * times (255 - pixel) / (1 - alpha), so a few hundredths of texture leaking
 * into a LOCAL alpha estimate comes back as visible blotches; on smoothly
 * shaded wood the local estimate did worse than a plain blur. A single value
 * pooled over hundreds of pixels averages the leakage away. The caller only
 * keeps this when the result is cleaner, so marks whose opacity really does
 * vary keep their local map.
 */
function flattenUniformAlpha(alphaMap, rawAlpha, inMask, w, h) {
  // Choose the core from a WIDE median, not from the local map: picking the
  // pixels whose local estimate is high preferentially picks the ones where
  // texture leaked upwards, and on a faint mark that bias dominated (0.45
  // estimated for a true 0.30).
  const wide = medianFilter(rawAlpha, inMask, w, h, 8);
  const vals = [];
  for (let o = 0; o < wide.length; o++) if (inMask[o] && wide[o] > 0.03) vals.push(wide[o]);
  if (vals.length < 30) return null;
  vals.sort((a, b) => a - b);
  const p90 = vals[Math.floor(vals.length * 0.9)];
  const core = [], coreRaw = [];
  for (let o = 0; o < wide.length; o++) {
    if (inMask[o] && wide[o] > 0.5 * p90) { core.push(o); coreRaw.push(rawAlpha[o]); }
  }
  if (core.length < 30) return null;
  coreRaw.sort((a, b) => a - b);
  const a0 = coreRaw[coreRaw.length >> 1];
  // Past ~0.6 the inversion amplifies any error in a0 by 2.5x or more, and
  // a pooled estimate is not accurate enough for that (measured: 21.5 dB
  // flattened vs 25.3 dB local at alpha 0.75).
  if (a0 > 0.6) return null;
  const out = new Float32Array(alphaMap);
  for (const o of core) out[o] = a0;
  return out;
}

/**
 * How unlike its surroundings the recovered texture would be: the ratio of
 * edge density inside the mask to edge density in the ring around it, as a
 * distance from 1 (in log terms, so too smooth and too rough count alike).
 *
 * "Smoothest wins" is the wrong rule here. A local alpha estimate soaks the
 * texture up into alpha and returns a smooth patch, which scores as clean
 * while being exactly the smear this module exists to avoid. Matching the
 * surroundings rewards restoring texture and penalises both a smear and
 * blotches. Inside the mask each pixel's edges are weighted by (1 - alpha),
 * cancelling the inversion's amplification of noise that was already there.
 */
function textureMismatch(obs, alphaMap, inMask, w, h, wmValue) {
  const lum = (o, a) => {
    const k = 1 - Math.min(0.95, a);
    return (0.299 * (obs[o * 3] - a * wmValue) + 0.587 * (obs[o * 3 + 1] - a * wmValue) +
            0.114 * (obs[o * 3 + 2] - a * wmValue)) / k;
  };
  const al = (o) => (inMask[o] ? alphaMap[o] : 0);
  let inTv = 0, inN = 0, outTv = 0, outN = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const o = y * w + x;
      const c = lum(o, al(o));
      const e = Math.abs(lum(o + 1, al(o + 1)) - c) + Math.abs(lum(o + w, al(o + w)) - c);
      const all = inMask[o] && inMask[o + 1] && inMask[o + w];
      const none = !inMask[o] && !inMask[o + 1] && !inMask[o + w];
      if (all) { inTv += (1 - Math.min(0.95, al(o))) * e; inN++; }
      else if (none) { outTv += e; outN++; }
    }
  }
  if (!inN || !outN || outTv <= 0) return 0;
  return Math.abs(Math.log(Math.max(1e-6, (inTv / inN) / (outTv / outN))));
}

/**
 * Median of `src` over a (2r+1)^2 window, for masked pixels only. Pixels
 * outside the mask count as alpha 0, which is what they are: the mask edge is
 * where the badge ends.
 */
function medianFilter(src, inMask, w, h, r) {
  const out = new Float32Array(src.length);
  if (r <= 0) { out.set(src); return out; }
  const win = new Float32Array((2 * r + 1) * (2 * r + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * w + x;
      if (!inMask[o]) continue;
      let k = 0;
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) {
        for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) {
          win[k++] = src[j * w + i];
        }
      }
      out[o] = quickSelect(win, k, k >> 1);
    }
  }
  return out;
}

/** k-th smallest of the first `len` entries of `a` (reorders them). */
function quickSelect(a, len, k) {
  let lo = 0, hi = len - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[k];
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
function diffuseInward(obs, inMask, w, h, warm = null, maxIters = Infinity) {
  const n = w * h;
  const bg = new Float32Array(obs);
  if (warm) {
    // Continue from the previous frame's solution: the scene moves a little
    // between frames, so a few passes bring it up to date.
    for (let o = 0; o < n; o++) {
      if (!inMask[o]) continue;
      for (let c = 0; c < 3; c++) bg[o * 3 + c] = warm[o * 3 + c];
    }
    relax(bg, inMask, w, h, Math.min(maxIters, 30));
    return bg;
  }

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
  relax(bg, inMask, w, h, Math.min(maxIters, 600, Math.max(40, maxRun * 6)));
  return bg;
}

/** Jacobi relaxation of `bg` inside the mask, in place. */
function relax(bg, inMask, w, h, iters) {
  const n = w * h;
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

/**
 * Fill the masked pixels with a smooth interpolation of their surroundings.
 *
 * The plainest possible fill, and deliberately so: it is what video uses on
 * frames where the background has moved since the AI last ran, because it
 * follows the scene from frame to frame instead of freezing an old patch.
 *
 * @param {ImageData} imageData
 * @param {ImageData} maskData   alpha > 64 marks pixels to fill
 * @param {object} [opts]
 * @param {Float32Array} [opts.background] previous result, to warm-start
 * @returns {{ result: ImageData, background: Float32Array|null }}
 */
export function smoothFill(imageData, maskData, opts = {}) {
  const { width: W, height: H } = imageData;
  const bbox = maskBbox(maskData, 2);
  if (!bbox) return { result: imageData, background: null };
  const { x: bx, y: by, w: bw, h: bh } = bbox;
  const n = bw * bh;
  const obs = new Float32Array(n * 3);
  const inMask = new Uint8Array(n);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const si = ((by + y) * W + (bx + x)) * 4, o = y * bw + x;
      for (let c = 0; c < 3; c++) obs[o * 3 + c] = imageData.data[si + c];
      inMask[o] = maskData.data[si + 3] > 64 ? 1 : 0;
    }
  }
  const warm = opts.background && opts.background.length === n * 3 ? opts.background : null;
  const bg = diffuseInward(obs, inMask, bw, bh, warm, opts.iterations);
  const out = new Uint8ClampedArray(imageData.data);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const o = y * bw + x;
      if (!inMask[o]) continue;
      const di = ((by + y) * W + (bx + x)) * 4;
      for (let c = 0; c < 3; c++) out[di + c] = bg[o * 3 + c];
    }
  }
  return { result: new ImageData(out, W, H), background: bg };
}

/** Bounding box of the mask (alpha > 64), grown by `pad`; null when empty. */
export function maskBbox(maskData, pad = 0) {
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
