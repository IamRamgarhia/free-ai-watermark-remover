/**
 * Regression tests for the inpainting pixel math.
 *
 * Run:  node tools/test-inpainter.mjs
 *
 * Why these exist: every constant in buildMIGANInput / miganOutputToRGBA was
 * wrong in the first implementation (see the decisions journal in
 * WATERMARKOUT_BUILD_SPEC.md), and the failure mode is SILENT — you get a
 * washed-out patch, an inverted mask, or the watermark bleeding through, but
 * never an exception. A unit test is the only thing that catches a regression
 * here before a user does.
 *
 * No dependencies and no build step: these functions are pure and accept plain
 * {data, width, height} objects, so Node can import them straight from the
 * browser source.
 */

import {
  buildMIGANInput,
  miganOutputToRGBA,
  findMaskBbox,
  getPassCount,
} from '../static/js/inpainter.js';
import { maskHasContent } from '../static/js/mask.js';

// === Tiny test harness ======================================================
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertClose(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg || 'value'}: expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

// === Fixtures ===============================================================

/** An RGBA image of `w`×`h` where every pixel is [r,g,b,255]. */
function solidImage(w, h, [r, g, b]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

/** A mask where the rect [x,y,rw,rh) has alpha=255 and everything else 0. */
function rectMask(w, h, x, y, rw, rh, alpha = 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let py = y; py < y + rh; py++) {
    for (let px = x; px < x + rw; px++) {
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      data[(py * w + px) * 4 + 3] = alpha;
    }
  }
  return { data, width: w, height: h };
}

/** Deterministic pseudo-random image — no Math.random, so failures reproduce. */
function gradientImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4]     = (i * 7)  % 256;
    data[i * 4 + 1] = (i * 13) % 256;
    data[i * 4 + 2] = (i * 29) % 256;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

// === buildMIGANInput ========================================================
console.log('\nbuildMIGANInput — MI-GAN 4-channel input layout');

test('produces a Float32Array of exactly 4 planes', () => {
  const img = solidImage(4, 4, [128, 128, 128]);
  const mask = rectMask(4, 4, 0, 0, 0, 0);
  const out = buildMIGANInput(img, mask);
  assert(out instanceof Float32Array, 'expected Float32Array');
  assert(out.length === 4 * 4 * 4, `expected length 64, got ${out.length}`);
});

test('mask polarity is INVERTED vs LaMa: plane 0 is +0.5 to KEEP, -0.5 to inpaint', () => {
  const size = 4;
  const img = solidImage(size, size, [0, 0, 0]);
  // Mark only the top-left pixel for removal.
  const mask = rectMask(size, size, 0, 0, 1, 1);
  const out = buildMIGANInput(img, mask);

  // Pixel 0 is masked → mask_norm = 0 → plane 0 = -0.5
  assertClose(out[0], -0.5, 1e-6, 'masked pixel plane 0');
  // Pixel 1 is untouched → mask_norm = 1 → plane 0 = +0.5
  assertClose(out[1], 0.5, 1e-6, 'unmasked pixel plane 0');
});

test('image is normalized to [-1, 1] in the keep area', () => {
  const img = solidImage(2, 2, [0, 255, 128]);
  const mask = rectMask(2, 2, 0, 0, 0, 0);   // nothing masked
  const out = buildMIGANInput(img, mask);
  const size = 4;

  assertClose(out[size],         -1.0, 1e-6, 'R=0 → -1');
  assertClose(out[size * 2],      1.0, 1e-6, 'G=255 → +1');
  assertClose(out[size * 3], 128 / 255 * 2 - 1, 1e-6, 'B=128 → ~0');
});

test('colour channels are ZEROED inside the hole', () => {
  const img = solidImage(2, 2, [255, 255, 255]);
  const mask = rectMask(2, 2, 0, 0, 1, 1);   // pixel 0 masked
  const out = buildMIGANInput(img, mask);
  const size = 4;

  assert(out[size]         === 0, 'R must be 0 in the hole');
  assert(out[size * 2]     === 0, 'G must be 0 in the hole');
  assert(out[size * 3]     === 0, 'B must be 0 in the hole');
  // …and preserved outside it
  assertClose(out[size + 1], 1.0, 1e-6, 'R preserved outside the hole');
});

test('alpha threshold is >64 (a faint brush stroke does not count as masked)', () => {
  const img = solidImage(2, 2, [10, 20, 30]);

  const faint = buildMIGANInput(img, rectMask(2, 2, 0, 0, 1, 1, 64));
  assertClose(faint[0], 0.5, 1e-6, 'alpha=64 must be treated as KEEP');

  const solid = buildMIGANInput(img, rectMask(2, 2, 0, 0, 1, 1, 65));
  assertClose(solid[0], -0.5, 1e-6, 'alpha=65 must be treated as INPAINT');
});

// === miganOutputToRGBA ======================================================
console.log('\nmiganOutputToRGBA — [-1,1] float CHW → RGBA bytes');

test('maps -1 → 0, 0 → ~128, +1 → 255', () => {
  const chw = new Float32Array([-1, 0, 1, /*G*/ -1, 0, 1, /*B*/ -1, 0, 1]);
  const rgba = miganOutputToRGBA(chw, 3, 1);

  assert(rgba[0] === 0, `-1 should map to 0, got ${rgba[0]}`);
  assertClose(rgba[4], 128, 1, '0 should map to ~128');
  assert(rgba[8] === 255, `+1 should map to 255, got ${rgba[8]}`);
});

test('clamps out-of-range values instead of wrapping', () => {
  const chw = new Float32Array([-5, 5, 0, 0, 0, 0]);
  const rgba = miganOutputToRGBA(chw, 2, 1);
  assert(rgba[0] === 0,   `-5 must clamp to 0, got ${rgba[0]}`);
  assert(rgba[4] === 255, `+5 must clamp to 255, got ${rgba[4]}`);
});

test('always writes opaque alpha', () => {
  const chw = new Float32Array(3 * 4).fill(0);
  const rgba = miganOutputToRGBA(chw, 2, 2);
  for (let i = 0; i < 4; i++) {
    assert(rgba[i * 4 + 3] === 255, 'alpha must be 255');
  }
});

test('reads planar CHW, not interleaved RGBA', () => {
  // 2 pixels. R plane = [1,1], G plane = [-1,-1], B plane = [-1,-1]  → pure red
  const chw = new Float32Array([1, 1, -1, -1, -1, -1]);
  const rgba = miganOutputToRGBA(chw, 2, 1);
  assert(rgba[0] === 255 && rgba[1] === 0 && rgba[2] === 0,
    `expected pure red, got [${rgba[0]}, ${rgba[1]}, ${rgba[2]}]`);
});

// === Round trip =============================================================
console.log('\nRound trip — the test that catches polarity/normalization drift');

test('unmasked pixels survive build → identity model → decode unchanged', () => {
  // Feed the RGB planes buildMIGANInput produced straight back into the decoder,
  // simulating a model that returns its input untouched. With correct
  // normalization on both sides, the original pixels must come back exactly.
  const w = 8, h = 8;
  const img = gradientImage(w, h);
  const emptyMask = rectMask(w, h, 0, 0, 0, 0);

  const input = buildMIGANInput(img, emptyMask);
  const size = w * h;
  // Drop plane 0 (the mask plane); planes 1-3 are the RGB the model echoes back.
  const rgbPlanes = input.subarray(size, size * 4);
  const rgba = miganOutputToRGBA(rgbPlanes, w, h);

  for (let i = 0; i < size * 4; i++) {
    if (i % 4 === 3) continue;   // skip alpha
    assertClose(rgba[i], img.data[i], 1,
      `pixel byte ${i} changed (round-trip must be lossless within rounding)`);
  }
});

// === findMaskBbox ===========================================================
console.log('\nfindMaskBbox');

test('returns null for a completely empty mask', () => {
  assert(findMaskBbox(rectMask(10, 10, 0, 0, 0, 0)) === null, 'expected null');
});

test('finds a single masked pixel as a 1×1 box', () => {
  const bbox = findMaskBbox(rectMask(10, 10, 4, 6, 1, 1));
  assert(bbox !== null, 'expected a bbox');
  assert(bbox.x === 4 && bbox.y === 6 && bbox.w === 1 && bbox.h === 1,
    `expected {4,6,1,1}, got ${JSON.stringify(bbox)}`);
});

test('bbox is inclusive of both edges', () => {
  const bbox = findMaskBbox(rectMask(20, 20, 3, 5, 6, 4));
  assert(bbox.x === 3 && bbox.y === 5 && bbox.w === 6 && bbox.h === 4,
    `expected {3,5,6,4}, got ${JSON.stringify(bbox)}`);
});

test('handles a mask touching the far corner without overflowing', () => {
  const bbox = findMaskBbox(rectMask(10, 10, 9, 9, 1, 1));
  assert(bbox.x === 9 && bbox.y === 9 && bbox.w === 1 && bbox.h === 1,
    `expected {9,9,1,1}, got ${JSON.stringify(bbox)}`);
});

test('ignores alpha at or below the 16 threshold', () => {
  assert(findMaskBbox(rectMask(10, 10, 2, 2, 3, 3, 16)) === null,
    'alpha=16 should not register');
  assert(findMaskBbox(rectMask(10, 10, 2, 2, 3, 3, 17)) !== null,
    'alpha=17 should register');
});

// === maskHasContent =========================================================
console.log('\nmaskHasContent');

test('false for an empty mask, true once anything is painted', () => {
  assert(maskHasContent(rectMask(64, 64, 0, 0, 0, 0)) === false, 'empty mask');
  assert(maskHasContent(rectMask(64, 64, 10, 10, 8, 8)) === true, 'painted mask');
});

test('detects a small dab despite sampling every 4th pixel', () => {
  // 4×4 block — must be caught by the stride-4 sampling.
  assert(maskHasContent(rectMask(200, 200, 100, 100, 4, 4)) === true,
    'a 4×4 dab must be detected');
});

test('tolerates null/undefined input', () => {
  assert(maskHasContent(null) === false, 'null');
  assert(maskHasContent(undefined) === false, 'undefined');
});

// === Quality presets ========================================================
console.log('\nQuality presets');

test('fast and balanced are single-pass, best is two-pass', () => {
  assert(getPassCount('fast') === 1,     `fast: got ${getPassCount('fast')}`);
  assert(getPassCount('balanced') === 1, `balanced: got ${getPassCount('balanced')}`);
  assert(getPassCount('best') === 2,     `best: got ${getPassCount('best')}`);
});

test('unknown quality falls back to balanced rather than throwing', () => {
  assert(getPassCount(undefined) === 1, 'undefined');
  assert(getPassCount('nonsense') === 1, 'nonsense');
});

// === Summary ================================================================
console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`✓ All ${passed} tests passed.`);
  process.exit(0);
} else {
  console.log(`✗ ${failures.length} of ${passed + failures.length} tests FAILED:\n`);
  for (const f of failures) console.log(`  • ${f.name}\n    ${f.error.message}`);
  process.exit(1);
}
