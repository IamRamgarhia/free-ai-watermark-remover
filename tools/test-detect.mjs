/**
 * Tests for automatic watermark detection.
 *
 * Run:  node tools/test-detect.mjs
 *
 * These build synthetic images with a badge composited at a KNOWN position,
 * then check the detector finds it. That is the only way to test this honestly
 * without shipping a corpus of real watermarked images — and it lets us cover
 * the hard cases deliberately: busy backgrounds, faint badges, dark badges on
 * light backgrounds, and images that have no watermark at all (where the right
 * answer is "found nothing", and a detector that always fires is useless).
 */

import { detectWatermarks, presetBoxes, scoreBox } from '../static/js/watermark-detect.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// === Synthetic image helpers ===============================================

/** Deterministic value noise — no Math.random, so a failure always reproduces. */
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function makeImage(w, h, kind = 'texture') {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r, g, b;
      if (kind === 'flat') {
        r = 130; g = 120; b = 110;
      } else if (kind === 'busy') {
        // High-frequency detail everywhere — the adversarial case for an
        // edge-based detector.
        const n = hash(x, y);
        const n2 = hash((x / 3) | 0, (y / 3) | 0);
        r = 60 + n * 180; g = 50 + n2 * 190; b = 70 + hash(y, x) * 160;
      } else {
        // Smooth gradient plus gentle grain — a typical photo/illustration.
        const n = hash((x / 7) | 0, (y / 7) | 0) * 26;
        r = 90 + (x / w) * 90 + n;
        g = 80 + (y / h) * 80 + n;
        b = 70 + ((x + y) / (w + h)) * 70 + n;
      }
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/**
 * Composite a 4-pointed sparkle (Gemini-style) at `alpha` opacity.
 * Returns the ground-truth bounding box.
 */
function drawSparkle(img, cx, cy, size, alpha = 0.9, colour = [255, 255, 255]) {
  const { data, width: w } = img;
  const r = size / 2;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= w || y >= img.height) continue;
      const dx = Math.abs(x - cx) / r, dy = Math.abs(y - cy) / r;
      // Four-pointed star: strong along the axes, pinched on the diagonals.
      const d = Math.pow(dx, 0.55) + Math.pow(dy, 0.55);
      if (d > 1) continue;
      const a = alpha * Math.min(1, (1 - d) * 3.2);
      if (a <= 0.02) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = colour[c] * a + data[i + c] * (1 - a);
    }
  }
  return { x: cx - r, y: cy - r, w: size, h: size };
}

/** Rounded plate + text, e.g. a "Imagined with AI" style badge. */
function drawPlate(img, x0, y0, bw, bh, alpha = 0.85) {
  const { data, width: w } = img;
  for (let y = y0; y < y0 + bh; y++) {
    for (let x = x0; x < x0 + bw; x++) {
      if (x < 0 || y < 0 || x >= w || y >= img.height) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = 245 * alpha + data[i + c] * (1 - alpha);
    }
  }
  return { x: x0, y: y0, w: bw, h: bh };
}

function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter <= 0 ? 0 : inter / (a.w * a.h + b.w * b.h - inter);
}

/** True if any of the top-k candidates substantially covers the truth box. */
function foundWithin(cands, truth, k = 3, minIoU = 0.25) {
  return cands.slice(0, k).some(c => iou(c, truth) >= minIoU);
}

// === Tests =================================================================
console.log('\nCorner badges on a normal background');

test('finds a bright sparkle in the bottom-right', () => {
  const img = makeImage(1024, 1024);
  const truth = drawSparkle(img, 950, 950, 60);
  const c = detectWatermarks(img);
  assert(c.length > 0, 'detected nothing');
  assert(foundWithin(c, truth), `no candidate matched; best=${JSON.stringify(c[0])}`);
});

test('finds it in each of the four corners', () => {
  const spots = [
    ['bottom-right', 950, 950], ['bottom-left', 74, 950],
    ['top-right', 950, 74],     ['top-left', 74, 74],
  ];
  for (const [label, cx, cy] of spots) {
    const img = makeImage(1024, 1024);
    const truth = drawSparkle(img, cx, cy, 60);
    const c = detectWatermarks(img);
    assert(foundWithin(c, truth), `${label}: not found`);
  }
});

test('handles a non-square (portrait) image', () => {
  const img = makeImage(768, 1344);
  const truth = drawSparkle(img, 700, 1270, 56);
  const c = detectWatermarks(img);
  assert(foundWithin(c, truth), 'not found in portrait image');
});

test('handles a wide landscape image', () => {
  const img = makeImage(1600, 900);
  const truth = drawSparkle(img, 1520, 830, 52);
  const c = detectWatermarks(img);
  assert(foundWithin(c, truth), 'not found in landscape image');
});

console.log('\nHarder cases');

test('finds a faint semi-transparent badge (alpha 0.45)', () => {
  const img = makeImage(1024, 1024);
  const truth = drawSparkle(img, 950, 950, 60, 0.45);
  const c = detectWatermarks(img);
  assert(foundWithin(c, truth), 'faint badge missed');
});

test('finds a dark badge on a light background', () => {
  const img = makeImage(1024, 1024, 'flat');
  const truth = drawSparkle(img, 950, 950, 60, 0.9, [20, 20, 20]);
  const c = detectWatermarks(img);
  assert(foundWithin(c, truth), 'dark badge missed');
});

test('finds a rounded plate badge, not just thin strokes', () => {
  const img = makeImage(1024, 1024);
  const truth = drawPlate(img, 780, 930, 210, 54);
  const c = detectWatermarks(img);
  assert(foundWithin(c, truth), 'plate badge missed');
});

test('finds a small badge on a large image', () => {
  const img = makeImage(2400, 1600);
  const truth = drawSparkle(img, 2300, 1520, 60);
  const c = detectWatermarks(img);
  assert(foundWithin(c, truth), 'small badge on large image missed');
});

test('still finds it when the background is busy', () => {
  const img = makeImage(1024, 1024, 'busy');
  const truth = drawSparkle(img, 950, 950, 72, 1.0);
  const c = detectWatermarks(img);
  assert(foundWithin(c, truth, 4), 'missed against busy background');
});

console.log('\nRestricting the search region');

test('region option confines results to that corner', () => {
  const img = makeImage(1024, 1024);
  const truth = drawSparkle(img, 950, 950, 60);
  drawSparkle(img, 74, 74, 60);            // decoy in the opposite corner
  const c = detectWatermarks(img, { region: 'bottom-right' });
  assert(c.length > 0, 'nothing found in the requested region');
  assert(c.every(r => r.region === 'bottom-right'), 'leaked outside the region');
  assert(foundWithin(c, truth), 'wrong box within the region');
});

console.log('\nNot firing when there is nothing to find');

test('a flat image with no watermark yields no candidate', () => {
  const c = detectWatermarks(makeImage(1024, 1024, 'flat'));
  assert(c.length === 0, `expected none, got ${c.length}: ${JSON.stringify(c[0])}`);
});

test('candidates are ranked best-first', () => {
  const img = makeImage(1024, 1024);
  drawSparkle(img, 950, 950, 60);
  const c = detectWatermarks(img);
  for (let i = 1; i < c.length; i++) {
    assert(c[i - 1].score >= c[i].score, 'scores are not descending');
  }
});

test('boxes stay inside the image bounds', () => {
  const img = makeImage(800, 600);
  drawSparkle(img, 760, 560, 50);
  for (const r of detectWatermarks(img)) {
    assert(r.x >= 0 && r.y >= 0, `negative origin: ${JSON.stringify(r)}`);
    assert(r.x + r.w <= 800 && r.y + r.h <= 600, `box escapes bounds: ${JSON.stringify(r)}`);
  }
});

console.log('\nPerformance');

test('a 4000x3000 image is analysed in under 2 seconds', () => {
  const img = makeImage(4000, 3000);
  drawSparkle(img, 3900, 2900, 90);
  const t0 = Date.now();
  detectWatermarks(img);
  const ms = Date.now() - t0;
  assert(ms < 2000, `took ${ms}ms`);
  console.log(`      (${ms}ms)`);
});

console.log('\nLocating the mark inside a candidate box');

test('scoreBox returns the marks own extent, not the box it was given', () => {
  const img = makeImage(1024, 1024);
  const truth = drawSparkle(img, 950, 950, 60);
  // A deliberately over-large box around it, as a preset would give.
  const found = scoreBox(img, { x: 890, y: 890, w: 130, h: 130 });
  assert(found, 'found nothing');
  assert(iou(found, truth) > 0.35,
    `blob ${JSON.stringify(found)} does not match truth ${JSON.stringify(truth)}`);
  assert(found.w < 110 && found.h < 110,
    'returned something nearly as large as the box — it should be the mark, not the box');
});

test('prefers the whole mark over a neat fragment of it', () => {
  const img = makeImage(1024, 1024);
  drawSparkle(img, 950, 950, 60);
  const whole = scoreBox(img, { x: 900, y: 900, w: 110, h: 110 });
  const frag  = scoreBox(img, { x: 940, y: 940, w: 30, h: 30 });
  assert(whole, 'whole-mark box found nothing');
  if (frag) {
    assert(whole.score >= frag.score,
      `fragment scored ${frag.score.toFixed(2)} vs whole ${whole.score.toFixed(2)} — fragments must not win`);
  }
});

test('reports nothing for a box containing only flat background', () => {
  const img = makeImage(1024, 1024, 'flat');
  assert(scoreBox(img, { x: 400, y: 400, w: 120, h: 120 }) === null,
    'claimed to find a mark in flat background');
});

// === Summary ===============================================================
console.log(`\n${'─'.repeat(60)}`);
if (!failures.length) {
  console.log(`✓ All ${passed} detection tests passed.\n`);
  process.exit(0);
}
console.log(`✗ ${failures.length} of ${passed + failures.length} FAILED\n`);
process.exit(1);
