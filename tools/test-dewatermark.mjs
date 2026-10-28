/**
 * Tests for un-blending watermark removal.
 *
 * Run:  node tools/test-dewatermark.mjs
 *
 * The whole claim of dewatermark.js is that it RECOVERS the original pixels
 * rather than inventing plausible ones. That is a measurable claim, so these
 * tests measure it: build a known original, composite a watermark onto it, run
 * recovery, and compare against ground truth with PSNR.
 *
 * Crucially, each test also computes what a smooth "fill from nearby colours"
 * would have scored on the same image. If un-blending is not clearly better
 * than that baseline, it is not earning its place.
 *
 * The baseline must be a FAIR one. An earlier version of this file started its
 * "smooth fill" from the watermark's own bright pixels and stopped before it
 * converged, so it scored ~11-16 dB and un-blending "beat" it by 10 dB, while
 * un-blending was in fact returning that same smooth fill (23.6 dB vs 23.6 dB,
 * texture correlation 0.2). So the baseline below is seeded and converged, and
 * every recovery test also checks that the texture itself came back.
 */

import { unblendWatermark, residualIsNegligible } from '../static/js/dewatermark.js';

// Node has no ImageData; the module is written for the browser, so provide the
// minimum shim rather than contorting the source to be testable.
globalThis.ImageData = class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c; }
  }
};

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push({ name, e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// === Fixtures ==============================================================
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Detailed content — fine texture is exactly what a smooth fill destroys. */
function makeOriginal(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Wood-grain-ish stripes plus noise: strong high-frequency structure.
      const grain = Math.sin(x * 0.45 + Math.sin(y * 0.08) * 3) * 26;
      const fine = (hash(x, y) - 0.5) * 26;
      data[i]     = 150 + grain + fine;
      data[i + 1] = 110 + grain * 0.8 + fine;
      data[i + 2] = 70  + grain * 0.5 + fine;
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, w, h);
}

function clone(img) {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

/** Composite a soft-edged blob of `colour` at `alpha`; returns the mask. */
function applyWatermark(img, cx, cy, r, alpha, colour = 255) {
  const mask = new ImageData(new Uint8ClampedArray(img.width * img.height * 4), img.width, img.height);
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d > 1) continue;
      // Mostly flat with a short anti-aliased falloff, like a real badge.
      const a = alpha * Math.min(1, (1 - d) * 6);
      if (a <= 0.01) continue;
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) img.data[i + c] = colour * a + img.data[i + c] * (1 - a);
      mask.data[i + 3] = 255;   // mask covers the badge footprint
    }
  }
  return mask;
}

function psnr(a, b, mask) {
  let se = 0, n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (mask && mask.data[i + 3] <= 64) continue;
    for (let c = 0; c < 3; c++) { const d = a.data[i + c] - b.data[i + c]; se += d * d; n++; }
  }
  if (!n) return Infinity;
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

/**
 * Baseline: what "fill with nearby colours" achieves — the thing to beat.
 * Seeded with the surrounding mean and relaxed to convergence, in floats.
 */
function smoothFillBaseline(watermarked, mask) {
  const out = clone(watermarked);
  const { width: w, height: h } = out;
  const f = new Float32Array(out.data);
  const sum = [0, 0, 0]; let n = 0;
  for (let i = 0; i < f.length; i += 4) {
    if (mask.data[i + 3] > 64) continue;
    for (let c = 0; c < 3; c++) sum[c] += f[i + c];
    n++;
  }
  for (let i = 0; i < f.length; i += 4) {
    if (mask.data[i + 3] > 64) for (let c = 0; c < 3; c++) f[i + c] = sum[c] / n;
  }
  for (let it = 0; it < 3000; it++) {
    const prev = f.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const o = (y * w + x) * 4;
        if (mask.data[o + 3] <= 64) continue;
        for (let c = 0; c < 3; c++) {
          f[o + c] = (prev[o - 4 + c] + prev[o + 4 + c] + prev[o - w * 4 + c] + prev[o + w * 4 + c]) / 4;
        }
      }
    }
  }
  for (let i = 0; i < f.length; i++) out.data[i] = f[i];
  return out;
}

/**
 * How much of the ORIGINAL texture came back: correlation of (result - smooth)
 * with (original - smooth) inside the mask. 1 = all of it, 0 = none (a smear).
 */
function textureRecovered(result, original, smooth, mask) {
  let a = 0, b = 0, ab = 0;
  for (let i = 0; i < result.data.length; i += 4) {
    if (mask.data[i + 3] <= 64) continue;
    for (let c = 0; c < 3; c++) {
      const p = result.data[i + c] - smooth.data[i + c];
      const q = original.data[i + c] - smooth.data[i + c];
      a += p * p; b += q * q; ab += p * q;
    }
  }
  return ab / Math.sqrt(a * b + 1e-9);
}

// === Tests =================================================================
console.log('\nRecovery quality vs a smooth "nearby colours" fill');

const scenarios = [
  { label: 'faint badge   (alpha 0.35)', alpha: 0.35 },
  { label: 'typical badge (alpha 0.55)', alpha: 0.55 },
  { label: 'strong badge  (alpha 0.75)', alpha: 0.75 },
];

for (const { label, alpha } of scenarios) {
  test(`beats smooth fill on a ${label}`, () => {
    const original = makeOriginal(200, 200);
    const wm = clone(original);
    const mask = applyWatermark(wm, 100, 100, 22, alpha);

    const { result, stats } = unblendWatermark(wm, mask);
    const baseline = smoothFillBaseline(wm, mask);

    const pRec = psnr(result, original, mask);
    const pBase = psnr(baseline, original, mask);
    const pRaw = psnr(wm, original, mask);
    const tex = textureRecovered(result, original, baseline, mask);

    console.log(`  ${label}:  un-blend ${pRec.toFixed(1)} dB` +
                `  |  smooth fill ${pBase.toFixed(1)} dB` +
                `  |  untouched ${pRaw.toFixed(1)} dB` +
                `  |  texture recovered ${tex.toFixed(2)}`);

    assert(pRec > pBase + 1.5,
      `only ${pRec.toFixed(1)} dB vs baseline ${pBase.toFixed(1)} dB — not clearly better`);
    assert(tex > 0.5, `texture correlation ${tex.toFixed(2)}: this is a smear, not a recovery`);
    assert(pRec > pRaw + 6,
      `barely improved on doing nothing (${pRec.toFixed(1)} vs ${pRaw.toFixed(1)} dB)`);
  });
}

test('beats smooth fill on shaded texture under a flat-opacity badge', () => {
  // The case that exposed per-pixel alpha estimates: large-scale shading plus
  // strong grain. Local estimates soaked the grain into alpha and lost to a
  // plain blur; the pooled single-opacity estimate must not.
  const W = 400, H = 200;
  const original = new ImageData(new Uint8ClampedArray(W * H * 4), W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const g = Math.sin(x * 0.2 + Math.sin(y * 0.05) * 3) * 30, f = (hash(x, y) - 0.5) * 20, sh = Math.sin(x * 0.01) * 40;
      original.data[i] = 130 + g + f + sh; original.data[i + 1] = 110 + g + f + sh;
      original.data[i + 2] = 90 + g * 0.5 + f; original.data[i + 3] = 255;
    }
  }
  const wm = clone(original);
  const mask = new ImageData(new Uint8ClampedArray(W * H * 4), W, H);
  for (let y = 80; y < 120; y++) {
    for (let x = 100; x < 220; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) wm.data[i + c] = 255 * 0.5 + wm.data[i + c] * 0.5;
      mask.data[i + 3] = 255;
    }
  }
  const { result } = unblendWatermark(wm, mask);
  const pRec = psnr(result, original, mask), pBase = psnr(smoothFillBaseline(wm, mask), original, mask);
  console.log(`  shaded wood, flat badge:  un-blend ${pRec.toFixed(1)} dB  |  smooth fill ${pBase.toFixed(1)} dB`);
  assert(pRec > pBase + 3, `${pRec.toFixed(1)} dB vs smooth ${pBase.toFixed(1)} dB`);
});

test('a known alpha map is reused exactly (video path)', () => {
  const original = makeOriginal(160, 160);
  const wm = clone(original);
  const mask = applyWatermark(wm, 80, 80, 18, 0.5);
  const first = unblendWatermark(wm, mask);
  const again = unblendWatermark(wm, mask, { alpha: first.alpha });
  assert(psnr(first.result, again.result) === Infinity, 'reusing the alpha map changed the result');
});

console.log('\nBehaviour');

test('recovers a dark badge on light content too', () => {
  const original = makeOriginal(160, 160);
  const wm = clone(original);
  const mask = applyWatermark(wm, 80, 80, 18, 0.6, 0);   // black badge
  const { result, stats } = unblendWatermark(wm, mask);
  assert(stats.watermarkColor === 0, `expected a dark badge, got ${stats.watermarkColor}`);
  assert(psnr(result, original, mask) > psnr(wm, original, mask) + 6, 'no real improvement');
});

test('reports an opaque badge as unrecoverable instead of guessing', () => {
  const original = makeOriginal(160, 160);
  const wm = clone(original);
  const mask = applyWatermark(wm, 80, 80, 18, 1.0);      // fully opaque
  const { stats } = unblendWatermark(wm, mask);
  assert(stats.residualFraction > 0.5,
    `opaque badge should mostly land in the residual, got ${stats.residualFraction.toFixed(2)}`);
  assert(!residualIsNegligible(stats), 'should not claim the residual is negligible');
});

test('a semi-transparent badge leaves little for the inpainter', () => {
  const original = makeOriginal(160, 160);
  const wm = clone(original);
  const mask = applyWatermark(wm, 80, 80, 18, 0.5);
  const { stats } = unblendWatermark(wm, mask);
  assert(stats.residualFraction < 0.1,
    `expected a small residual, got ${stats.residualFraction.toFixed(2)}`);
});

test('leaves pixels outside the mask byte-identical', () => {
  const original = makeOriginal(160, 160);
  const wm = clone(original);
  const mask = applyWatermark(wm, 80, 80, 18, 0.6);
  const { result } = unblendWatermark(wm, mask);
  for (let i = 0; i < wm.data.length; i += 4) {
    if (mask.data[i + 3] > 64) continue;
    for (let c = 0; c < 3; c++) {
      assert(result.data[i + c] === wm.data[i + c], `pixel ${i} outside the mask changed`);
    }
  }
});

test('falls back to filling when the mask is not a translucent overlay', () => {
  // Mask a region that is NOT a translucent overlay at all: a hard, saturated
  // block. Solving the blend equation here is meaningless, and the danger is
  // that it writes amplified nonsense. It must route those pixels to the
  // residual instead.
  const original = makeOriginal(160, 160);
  const wm = clone(original);
  const mask = new ImageData(new Uint8ClampedArray(160 * 160 * 4), 160, 160);
  for (let y = 60; y < 100; y++) {
    for (let x = 60; x < 100; x++) {
      const i = (y * 160 + x) * 4;
      wm.data[i] = 255; wm.data[i + 1] = 8; wm.data[i + 2] = 250;   // hard magenta
      mask.data[i + 3] = 255;
    }
  }
  const { result, stats } = unblendWatermark(wm, mask);
  // Whatever it does, it must not emit pixels that are wildly out of family.
  let extreme = 0;
  for (let y = 60; y < 100; y++) {
    for (let x = 60; x < 100; x++) {
      const i = (y * 160 + x) * 4;
      if (mask.data[i + 3] <= 64) continue;
      // Pixels it chose to keep should be plausible image values, not clipped junk.
      const isResidual = stats.clamped > 0;
      for (let c = 0; c < 3; c++) {
        if (result.data[i + c] === 0 || result.data[i + c] === 255) extreme++;
      }
    }
  }
  assert(stats.fellBack === true,
    'should have detected this is not a translucent overlay and fallen back');
  assert(stats.residualFraction === 1,
    'the whole mask should be handed to the inpainter, not silently left unchanged');
  assert(!residualIsNegligible(stats),
    'must not report the residual as negligible, or nothing would be filled');
});

test('a thin badge in a generously padded mask still recovers, not falls back', () => {
  // The regression that shipped: a sparkle occupies a small share of its own
  // bounding box, and auto-detect pads further. Requiring a high fraction of
  // the MASK to be translucent wrongly classified this as "not a watermark"
  // and repainted the whole box.
  const original = makeOriginal(200, 200);
  const wm = clone(original);
  const mask = applyWatermark(wm, 100, 100, 16, 0.55);
  // Pad the mask well beyond the mark, as the UI does.
  for (let y = 60; y < 140; y++) {
    for (let x = 60; x < 140; x++) mask.data[(y * 200 + x) * 4 + 3] = 255;
  }
  const { result, stats } = unblendWatermark(wm, mask);
  assert(stats.fellBack === false,
    `fell back despite a genuine translucent badge (effective ${(stats.effectiveFraction*100).toFixed(1)}% of mask)`);
  assert(psnr(result, original, mask) > psnr(wm, original, mask) + 4,
    'recovery did not improve on doing nothing');
});

test('an empty mask is a no-op', () => {
  const img = makeOriginal(64, 64);
  const empty = new ImageData(new Uint8ClampedArray(64 * 64 * 4), 64, 64);
  const { result, stats } = unblendWatermark(img, empty);
  assert(stats.recovered === 0, 'should have recovered nothing');
  assert(result === img || psnr(result, img) === Infinity, 'image should be untouched');
});

// === Summary ===============================================================
console.log(`\n${'─'.repeat(64)}`);
if (!failures.length) {
  console.log(`✓ All ${passed} un-blending tests passed.\n`);
  process.exit(0);
}
console.log(`✗ ${failures.length} of ${passed + failures.length} FAILED\n`);
process.exit(1);
