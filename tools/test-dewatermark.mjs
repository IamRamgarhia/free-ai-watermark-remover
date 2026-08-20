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

/** Baseline: what "fill with nearby colours" achieves — the thing to beat. */
function smoothFillBaseline(watermarked, mask) {
  const out = clone(watermarked);
  const { width: w, height: h } = out;
  for (let it = 0; it < 300; it++) {
    const prev = new Uint8ClampedArray(out.data);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (mask.data[o + 3] <= 64) continue;
        for (let c = 0; c < 3; c++) {
          let acc = 0, cnt = 0;
          if (x > 0)     { acc += prev[o - 4 + c]; cnt++; }
          if (x < w - 1) { acc += prev[o + 4 + c]; cnt++; }
          if (y > 0)     { acc += prev[o - w * 4 + c]; cnt++; }
          if (y < h - 1) { acc += prev[o + w * 4 + c]; cnt++; }
          out.data[o + c] = acc / cnt;
        }
      }
    }
  }
  return out;
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

    console.log(`  ${label}:  un-blend ${pRec.toFixed(1)} dB` +
                `  |  smooth fill ${pBase.toFixed(1)} dB` +
                `  |  untouched ${pRaw.toFixed(1)} dB` +
                `  (alpha est ${stats.meanAlpha.toFixed(2)})`);

    assert(pRec > pBase + 3,
      `only ${pRec.toFixed(1)} dB vs baseline ${pBase.toFixed(1)} dB — not clearly better`);
    assert(pRec > pRaw + 6,
      `barely improved on doing nothing (${pRec.toFixed(1)} vs ${pRaw.toFixed(1)} dB)`);
  });
}

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
