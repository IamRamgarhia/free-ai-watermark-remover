/**
 * Exact removal of the Gemini watermark by reverse alpha blending.
 *
 * Gemini composites the same white sparkle onto every image:
 *
 *     observed = alpha * 255 + (1 - alpha) * original
 *
 * dewatermark.js has to ESTIMATE alpha from the image itself, which only gets
 * part of the texture back. Here alpha is KNOWN — a calibrated per-pixel map
 * of the real watermark (gemini-alpha.js) — so the inversion is exact up to
 * 8-bit rounding:
 *
 *     original = (observed - alpha * 255) / (1 - alpha)
 *
 * The sparkle peaks around 50% opacity (37% on the current profile), so no
 * pixel is opaque and nothing has to be invented. The only hard parts are
 * finding exactly where it sits and coping with images that were resized or
 * recompressed after watermarking, which make the stored map slightly too
 * strong or too weak; `gain` absorbs that.
 */

import { GEMINI_ALPHA } from './gemini-alpha.js';

/** Minimum match score to treat a location as the Gemini watermark. */
export const GEMINI_MATCH_THRESHOLD = 0.35;

// Removing a real watermark (at its corrected strength) never left the patch
// rougher: at most 0.99x across wood, sky, bright, blocky and starfield
// backgrounds at strengths 0.85-1.15. Look-alikes that pass the score measured
// 1.07x and up.
const VETO_ROUGHNESS = 1.035;

const maps = {};
/** Alpha map for a profile as Float32 0..1, decoded once. */
function alphaMap(profile) {
  if (maps[profile]) return maps[profile];
  const { size, data } = GEMINI_ALPHA[profile];
  const bin = atob(data);
  const a = new Float32Array(size * size);
  for (let i = 0; i < a.length; i++) a[i] = bin.charCodeAt(i) / 255;
  return (maps[profile] = { size, alpha: a });
}

/** Bilinear resize of a square alpha map, for logo sizes between the stored ones. */
function resizeMap(src, size) {
  if (src.size === size) return src;
  const out = new Float32Array(size * size);
  const s = src.size / size;
  for (let y = 0; y < size; y++) {
    const fy = Math.min(src.size - 1, Math.max(0, (y + 0.5) * s - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(src.size - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < size; x++) {
      const fx = Math.min(src.size - 1, Math.max(0, (x + 0.5) * s - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(src.size - 1, x0 + 1), tx = fx - x0;
      const a = src.alpha;
      out[y * size + x] =
        (a[y0 * src.size + x0] * (1 - tx) + a[y0 * src.size + x1] * tx) * (1 - ty) +
        (a[y1 * src.size + x0] * (1 - tx) + a[y1 * src.size + x1] * tx) * ty;
    }
  }
  return { size, alpha: out };
}

/** The stored map for a profile family at a given logo size. */
const resized = {};
function mapFor(variant, size) {
  if (variant === 'v1' && size === 48) return alphaMap('v1-48');
  if (variant === 'v2' && size === 36) return alphaMap('v2-36');
  const key = `${variant}-${size}`;
  return (resized[key] ??= resizeMap(alphaMap(`${variant}-96`), size));
}

/**
 * Where Gemini puts the sparkle for an image of this size: bottom-right, at a
 * margin and logo size that depend on the output resolution and the profile.
 * Mirrors the calibrated placement rules of GeminiWatermarkTool.
 */
export function geminiPlacements(W, H) {
  const out = [];
  const large = W > 1024 && H > 1024;
  const push = (variant, logo, margin) => {
    const x = W - margin - logo, y = H - margin - logo;
    if (x >= 0 && y >= 0) out.push({ variant, size: logo, x, y });
  };

  // Current profile (Gemini 3.5+).
  if (large) {
    push('v2', 96, 192);
  } else {
    // Small outputs are downscaled from a 2752/2816/2848-wide canonical
    // render, and inherit its margin and logo size proportionally.
    const long = Math.max(W, H), short = Math.min(W, H);
    let canon;
    if (long > 1100) {
      const doubled = 2 * long;
      canon = [2752, 2816, 2848].reduce((b, c) => Math.abs(doubled - c) < Math.abs(doubled - b) ? c : b);
    } else {
      canon = short >= 566 ? 2752 : short >= 550 ? 2816 : 2848;
    }
    const scale = long / canon;
    const ideal = Math.round(96 * scale);
    push('v2', ideal <= 40 ? 36 : ideal, Math.round(192 * scale));
  }

  // Legacy profile (before Gemini 3.5).
  if (large) push('v1', 96, 64); else push('v1', 48, 32);
  return out;
}

function luminance(d, i) {
  return (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
}

/** Normalised cross-correlation of two equal-length vectors, -1..1. */
function ncc(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return saa > 1e-12 && sbb > 1e-12 ? sab / Math.sqrt(saa * sbb) : 0;
}

/**
 * How strongly the image at (x, y) carries the sparkle, roughly -1..1.
 *
 * Correlating brightness with the alpha map alone is easily fooled: bright
 * content, high-contrast texture or a sunlit corner can correlate with any
 * blob. So the test is the inversion itself. If the watermark really is here,
 * removing it leaves a region that no longer looks like the sparkle (residual
 * correlation near 0). If it is not, "removing" it digs a dark sparkle-shaped
 * imprint into the image (strongly negative). The score is the correlation
 * before, minus whatever correlation the removal leaves behind. Removal is
 * tried at a few strengths so a resized file, whose mark is a little weaker
 * or stronger than the stored map, still scores as what it is.
 */
const SCORE_GAINS = [0.8, 0.9, 1, 1.1, 1.2];
function scoreAt(imageData, map, x, y) {
  const { width: W, height: H, data } = imageData;
  const { size, alpha } = map;
  if (x < 0 || y < 0 || x + size > W || y + size > H) return -1;
  const n = size * size;
  const before = new Float32Array(n), after = new Float32Array(n);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) before[j * size + i] = luminance(data, ((y + j) * W + x + i) * 4) * 255;
  }
  const pre = ncc(before, alpha);
  if (pre < 0.05) return pre;               // nothing sparkle-like here at all
  let left = Infinity;
  for (const k of SCORE_GAINS) {
    for (let o = 0; o < n; o++) {
      const a = Math.min(0.99, alpha[o] * k);
      after[o] = (before[o] - a * 255) / (1 - a);
    }
    left = Math.min(left, Math.abs(ncc(after, alpha)));
  }
  return pre - left;
}

/**
 * Find the Gemini watermark. Tries the placements Gemini actually uses and
 * searches a few pixels around each, since crops and odd rounding shift it.
 * With `within` (a box), also searches that box for each logo size, which
 * covers images that were cropped or padded after watermarking.
 *
 * @returns {{score:number, x:number, y:number, size:number, variant:string}|null}
 */
export function findGeminiWatermark(imageData, { within = null, search = 6 } = {}) {
  const { width: W, height: H } = imageData;
  const tries = geminiPlacements(W, H);
  let best = null;

  const consider = (variant, size, cx, cy, radius, step = 1) => {
    const map = mapFor(variant, size);
    for (let dy = -radius; dy <= radius; dy += step) {
      for (let dx = -radius; dx <= radius; dx += step) {
        const s = scoreAt(imageData, map, cx + dx, cy + dy);
        if (!best || s > best.score) best = { score: s, x: cx + dx, y: cy + dy, size, variant };
      }
    }
  };

  for (const p of tries) consider(p.variant, p.size, p.x, p.y, search);

  if (within) {
    for (const p of tries) {
      // Coarse grid over the box, then refine around the best hit.
      const before = best;
      const cx = Math.round(within.x + within.w / 2 - p.size / 2);
      const cy = Math.round(within.y + within.h / 2 - p.size / 2);
      const r = Math.ceil(Math.max(within.w, within.h) / 2);
      consider(p.variant, p.size, cx, cy, r, 3);
      if (best !== before) consider(best.variant, best.size, best.x, best.y, 2);
    }
  }
  if (!best || best.score < GEMINI_MATCH_THRESHOLD) return null;

  // The score finds the watermark; it does not pin it to the pixel. Image
  // content nudges the correlation peak a pixel or two, and one pixel off
  // leaves a crisp sparkle outline after removal. So settle the final
  // position by the result: removing at the true position leaves the
  // smoothest patch, any offset adds a ring of edges.
  const map = mapFor(best.variant, best.size);
  let pick = best, pickRough = Infinity;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = best.x + dx, y = best.y + dy;
      const r = roughnessAfterRemoval(imageData, map, x, y);
      if (r < pickRough) { pickRough = r; pick = { ...best, x, y }; }
    }
  }
  // Gemini's own placements are exact; offsets only arise from cropping. Busy
  // or noisy content can pull both measures a few pixels off, so when the
  // canonical position still scores as a match and removes nearly as
  // cleanly, it wins.
  for (const p of tries) {
    if (p.variant !== best.variant || p.size !== best.size) continue;
    if (Math.abs(p.x - pick.x) > search || Math.abs(p.y - pick.y) > search) continue;
    if (scoreAt(imageData, map, p.x, p.y) < GEMINI_MATCH_THRESHOLD - 0.05) continue;
    if (roughnessAfterRemoval(imageData, map, p.x, p.y) <= pickRough * 1.1) pick = { ...best, x: p.x, y: p.y };
  }

  // Last check, and the one that actually rejects look-alikes. Removing a
  // real watermark leaves the patch about as smooth as before, or smoother
  // (it can only drop: the outline goes and the texture is attenuated).
  // "Removing" one that is not there digs a sparkle-shaped hole and the patch
  // gets much rougher, which is what rejects bright blobs that otherwise
  // score well.
  const roughBefore = roughnessAfterRemoval(imageData, map, pick.x, pick.y, 0);
  const roughAfter = roughnessAfterRemoval(imageData, map, pick.x, pick.y, bestGain(imageData, map, pick.x, pick.y));
  if (roughBefore > 0 && roughAfter > roughBefore * VETO_ROUGHNESS) return null;
  return pick;
}

/**
 * Total variation of the region after subtracting the watermark at (x, y),
 * counted only where the sparkle has meaningful opacity.
 *
 * The inversion divides by (1 - alpha), which also amplifies any noise in
 * the file by up to 1/(1 - alpha); on a faint mark over a noisy bright
 * background that alone would outweigh the edges being judged. Weighting each
 * pixel's edges by (1 - alpha) cancels the amplification exactly, so a correct
 * removal is never penalised for noise that was there all along, while a
 * wrong one still shows the sparkle outline it leaves behind.
 */
function roughnessAfterRemoval(imageData, map, x, y, gain = 1) {
  const { width: W, height: H, data } = imageData;
  const { size, alpha } = map;
  if (x < 1 || y < 1 || x + size >= W || y + size >= H) return Infinity;
  const rec = new Float32Array((size + 2) * (size + 2));
  const S = size + 2;
  for (let j = -1; j <= size; j++) {
    for (let i = -1; i <= size; i++) {
      const inside = i >= 0 && j >= 0 && i < size && j < size;
      const a = inside ? Math.min(0.99, alpha[j * size + i] * gain) : 0;
      const l = luminance(data, ((y + j) * W + x + i) * 4) * 255;
      rec[(j + 1) * S + i + 1] = (l - a * 255) / (1 - a);
    }
  }
  let tv = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // Include a pixel when it or a neighbour carries the mark, so a
      // misplaced edge on either side of the outline is counted.
      const a = alpha[j * size + i];
      const an = Math.max(a, i + 1 < size ? alpha[j * size + i + 1] : 0, j + 1 < size ? alpha[(j + 1) * size + i] : 0);
      if (an < 0.02) continue;
      const c = rec[(j + 1) * S + i + 1];
      const w = 1 - Math.min(0.99, a * gain);
      tv += w * (Math.abs(rec[(j + 1) * S + i + 2] - c) + Math.abs(rec[(j + 2) * S + i + 1] - c));
    }
  }
  return tv;
}

/**
 * Remove the watermark found by findGeminiWatermark().
 *
 * `gain` scales the stored alpha. Exactly 1 for an untouched Gemini file;
 * resizing or recompression shifts it a little, which leaves a faint ghost
 * (gain too low) or a dark imprint (too high); see bestGain().
 *
 * @returns {{ result: ImageData, residualMask: ImageData, stats: object }}
 */
export function removeGeminiWatermark(imageData, match, { gain = null } = {}) {
  const { width: W, height: H } = imageData;
  const map = mapFor(match.variant, match.size);
  const k = gain ?? bestGain(imageData, map, match.x, match.y);
  const out = new Uint8ClampedArray(imageData.data);
  const residual = new ImageData(new Uint8ClampedArray(W * H * 4), W, H);
  let recovered = 0, clipped = 0;

  for (let j = 0; j < map.size; j++) {
    for (let i = 0; i < map.size; i++) {
      const X = match.x + i, Y = match.y + j;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const a = Math.min(0.99, map.alpha[j * map.size + i] * k);
      if (a < 0.002) continue;
      const di = (Y * W + X) * 4;
      let bad = false;
      for (let c = 0; c < 3; c++) {
        const v = (imageData.data[di + c] - a * 255) / (1 - a);
        // A little outside 0..255 is rounding; a lot means this pixel was
        // already clipped in the source (pure white under the mark) and the
        // true value is unknowable. Hand those to the filler.
        if (v < -24 || v > 279) bad = true;
        out[di + c] = v;
      }
      if (bad) {
        clipped++;
        residual.data[di] = residual.data[di + 1] = residual.data[di + 2] = residual.data[di + 3] = 255;
      } else {
        recovered++;
      }
    }
  }

  const total = recovered + clipped;
  return {
    result: new ImageData(out, W, H),
    residualMask: residual,
    stats: {
      method: 'gemini-template',
      variant: match.variant,
      size: match.size,
      gain: k,
      score: match.score,
      recovered,
      opaque: clipped,
      marked: total,
      residualFraction: total ? clipped / total : 0,
      fellBack: false,
    },
  };
}

/**
 * Strength to remove the mark at, in [0.75, 1.25].
 *
 * Exactly 1 for an untouched Gemini file. Resizing or recompression makes
 * the stored map a little too strong or too weak, which leaves a faint ghost
 * (gain too low) or a dark imprint (too high), and either one correlates
 * with the sparkle's shape. So the right gain is where that correlation
 * crosses zero.
 *
 * Ordinary image content also correlates with the shape a little, by chance,
 * so chasing zero on an untouched file would trade an exact result for a
 * slightly wrong one. Only a clear ghost or imprint is corrected. (Minimising
 * roughness instead does not work: the inversion amplifies texture more at
 * higher gain, so it always prefers under-removal.)
 */
function bestGain(imageData, map, x, y) {
  const { width: W, height: H, data } = imageData;
  const { size, alpha } = map;
  if (x < 0 || y < 0 || x + size > W || y + size > H) return 1;
  // The ghost or imprint a wrong gain leaves has the sparkle's SHARP edges.
  // Smooth shading also correlates with the sparkle's shape by chance and
  // would drag the estimate, so compare high-passed signals only.
  const lum = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) lum[j * size + i] = luminance(data, ((y + j) * W + x + i) * 4) * 255;
  }
  const hpAlpha = highPass(alpha, size);
  const rec = new Float32Array(size * size);
  const residualCorr = (k) => {
    for (let o = 0; o < rec.length; o++) {
      const a = Math.min(0.99, alpha[o] * k);
      rec[o] = (lum[o] - a * 255) / (1 - a);
    }
    return ncc(highPass(rec, size), hpAlpha);
  };
  // Untouched files measured |corr| <= 0.10 here; resized ones overlap that
  // when the ghost is faint, so only a clear ghost is corrected and an
  // untouched file is always inverted exactly.
  if (Math.abs(residualCorr(1)) < 0.11) return 1;
  // Residual correlation falls monotonically with gain; find its zero.
  let lo = 0.75, hi = 1.25;
  if (residualCorr(lo) <= 0) return lo;
  if (residualCorr(hi) >= 0) return hi;
  for (let it = 0; it < 16; it++) {
    const mid = (lo + hi) / 2;
    if (residualCorr(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Signal minus its 5x5 box blur (edges clamped). */
function highPass(p, size) {
  const out = new Float32Array(p.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, y - 2); j <= Math.min(size - 1, y + 2); j++) {
        for (let i = Math.max(0, x - 2); i <= Math.min(size - 1, x + 2); i++) { s += p[j * size + i]; n++; }
      }
      out[y * size + x] = p[y * size + x] - s / n;
    }
  }
  return out;
}

/** Composite the watermark onto an image — used by the tests as ground truth. */
export function addGeminiWatermark(imageData, placement, gain = 1) {
  const { width: W } = imageData;
  const map = mapFor(placement.variant, placement.size);
  const out = new Uint8ClampedArray(imageData.data);
  for (let j = 0; j < map.size; j++) {
    for (let i = 0; i < map.size; i++) {
      const a = Math.min(1, map.alpha[j * map.size + i] * gain);
      const di = ((placement.y + j) * W + placement.x + i) * 4;
      for (let c = 0; c < 3; c++) out[di + c] = a * 255 + (1 - a) * imageData.data[di + c];
    }
  }
  return new ImageData(out, W, imageData.height);
}
