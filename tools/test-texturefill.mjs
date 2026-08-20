/**
 * Tests for exemplar (texture) fill.
 *
 * Run:  node tools/test-texturefill.mjs
 *
 * The claim is that on repetitive backgrounds, copying real texture from
 * nearby beats inventing an average. That is measurable, so these measure it
 * against ground truth — and, importantly, also check the honest failure case:
 * when nothing nearby matches, confidence must drop so the caller can fall back
 * instead of confidently copying the wrong region.
 */

import { textureFill } from '../static/js/texturefill.js';

globalThis.ImageData = class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c; }
  }
};

let passed = 0; const failures = [];
const test = (n, f) => { try { f(); passed++; } catch (e) { failures.push(n); console.log(`  ✗ ${n}\n      ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m || 'failed'); };

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Wood planks: strong horizontal seams plus fine grain. */
function woodGrain(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const seam = (y % 58 < 3) ? -60 : 0;
      const grain = Math.sin(x * 0.12 + Math.sin(y * 0.9) * 0.6) * 14;
      const fine = (hash((x / 2) | 0, y) - 0.5) * 16;
      d[i] = 201 + seam + grain + fine;
      d[i + 1] = 160 + seam + grain * 0.8 + fine;
      d[i + 2] = 106 + seam + grain * 0.5 + fine;
      d[i + 3] = 255;
    }
  }
  return new ImageData(d, w, h);
}

/**
 * Content with genuinely no self-similarity: high-amplitude random noise.
 *
 * This is the honest negative case. Two earlier fixtures did NOT work, and why
 * is worth recording — both times the method was right and the test was wrong:
 *
 *   A smooth gradient is self-similar under small shifts, so copying from it is
 *   fine and high confidence is correct.
 *
 *   Flat colour blobs likewise: if the ring around the hole is uniform, every
 *   offset matches and copying uniform colour is exactly right.
 *
 * Noise has no structure to align at any offset, so the best offset can only be
 * about as good as an arbitrary one — which is precisely the signal confidence
 * is meant to detect.
 */
function uniqueContent(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i]     = hash(x, y) * 255;
      d[i + 1] = hash(x + 7777, y) * 255;
      d[i + 2] = hash(x, y + 5555) * 255;
      d[i + 3] = 255;
    }
  }
  return new ImageData(d, w, h);
}

const clone = im => new ImageData(new Uint8ClampedArray(im.data), im.width, im.height);

/** Paint an OPAQUE block — the case where nothing can be recovered. */
function opaqueMark(img, x0, y0, bw, bh) {
  const mask = new ImageData(new Uint8ClampedArray(img.width * img.height * 4), img.width, img.height);
  for (let y = y0; y < y0 + bh; y++) {
    for (let x = x0; x < x0 + bw; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = 252; img.data[i + 1] = 252; img.data[i + 2] = 250;
      mask.data[i + 3] = 255;
    }
  }
  return mask;
}

function psnr(a, b, mask) {
  let se = 0, n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (mask.data[i + 3] <= 64) continue;
    for (let c = 0; c < 3; c++) { const d = a.data[i + c] - b.data[i + c]; se += d * d; n++; }
  }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

/**
 * Fine detail retained inside the repair, measured LOCALLY.
 *
 * Global standard deviation is the wrong instrument here: a diffusion smear
 * spanning a dark plank seam leaves a broad light-to-dark ramp, which scores a
 * HIGH global stdev while containing no texture whatsoever. Averaging the
 * stdev of small blocks measures what we actually care about — is there
 * structure at grain scale — and correctly collapses toward zero for a smear.
 */
function detail(img, mask) {
  const { width: w, height: h } = img;
  const B = 6;
  const blocks = [];
  for (let by = 0; by < h - B; by += B) {
    for (let bx = 0; bx < w - B; bx += B) {
      const vals = [];
      for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) {
        const i = (y * w + x) * 4;
        if (mask.data[i + 3] <= 64) { vals.length = 0; break; }
        vals.push((img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3);
      }
      if (vals.length < B * B) continue;
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      blocks.push(Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length));
    }
  }
  return blocks.length ? blocks.reduce((a, b) => a + b, 0) / blocks.length : 0;
}

/** The behaviour being replaced: diffuse surrounding colour inward. */
function smearBaseline(img, mask) {
  const out = clone(img); const { width: w, height: h } = img;
  for (let it = 0; it < 260; it++) {
    const prev = new Uint8ClampedArray(out.data);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (mask.data[o + 3] <= 64) continue;
      for (let c = 0; c < 3; c++) {
        let a = 0, n = 0;
        if (x > 0) { a += prev[o - 4 + c]; n++; }
        if (x < w - 1) { a += prev[o + 4 + c]; n++; }
        if (y > 0) { a += prev[o - w * 4 + c]; n++; }
        if (y < h - 1) { a += prev[o + w * 4 + c]; n++; }
        out.data[o + c] = a / n;
      }
    }
  }
  return out;
}

console.log('\nOpaque mark on repetitive texture — the case that smears');

test('beats a diffusion smear on wood grain, by a wide margin', () => {
  const truth = woodGrain(300, 300);
  const img = clone(truth);
  const mask = opaqueMark(img, 150, 150, 70, 46);

  const { result, confidence } = textureFill(img, mask);
  const smear = smearBaseline(img, mask);

  const pTex = psnr(result, truth, mask);
  const pSmear = psnr(smear, truth, mask);
  const dTruth = detail(truth, mask), dTex = detail(result, mask), dSmear = detail(smear, mask);

  console.log(`  exemplar ${pTex.toFixed(1)} dB (detail ${dTex.toFixed(1)})  |  ` +
              `smear ${pSmear.toFixed(1)} dB (detail ${dSmear.toFixed(1)})  |  ` +
              `true detail ${dTruth.toFixed(1)}  |  confidence ${confidence.toFixed(2)}`);

  assert(pTex > pSmear + 4, `only ${pTex.toFixed(1)} vs ${pSmear.toFixed(1)} dB`);
  assert(dTex > dTruth * 0.6, `texture flattened: ${dTex.toFixed(1)} vs true ${dTruth.toFixed(1)}`);
  assert(pSmear < 20,
    `baseline scored ${pSmear.toFixed(1)} dB — too good, so this test is not discriminating`);
  assert(confidence > 0.5, `confidence too low on ideal input: ${confidence.toFixed(2)}`);
});

test('keeps plank seams continuous rather than blurring them away', () => {
  const truth = woodGrain(300, 300);
  const img = clone(truth);
  // A block straddling a seam — the structure must carry through.
  const mask = opaqueMark(img, 120, 100, 80, 40);
  const { result } = textureFill(img, mask);
  // Rows that are seams in truth should still be markedly darker in the result.
  let ok = 0, checked = 0;
  for (let y = 100; y < 140; y++) {
    if (y % 58 >= 3) continue;
    checked++;
    let inRepair = 0, above = 0;
    for (let x = 120; x < 200; x++) {
      inRepair += result.data[(y * 300 + x) * 4];
      above += result.data[((y - 20) * 300 + x) * 4];
    }
    if (inRepair / 80 < above / 80 - 15) ok++;
  }
  assert(checked === 0 || ok > 0, 'seam did not survive the repair');
});

console.log('\nHonest failure — must not confidently copy the wrong thing');

test('reports low confidence when nothing nearby matches', () => {
  const img = uniqueContent(240, 240);
  const mask = opaqueMark(img, 92, 96, 44, 40);
  const { confidence } = textureFill(img, mask);
  assert(confidence < 0.5,
    `claimed ${confidence.toFixed(2)} confidence on content with no self-similarity at any offset`);
});

test('leaves pixels outside the mask untouched', () => {
  const img = woodGrain(200, 200);
  const before = clone(img);
  const mask = opaqueMark(img, 90, 90, 30, 30);
  const { result } = textureFill(img, mask);
  for (let i = 0; i < img.data.length; i += 4) {
    if (mask.data[i + 3] > 64) continue;
    for (let c = 0; c < 3; c++) assert(result.data[i + c] === img.data[i + c], `pixel ${i} changed`);
  }
});

test('an empty mask is a no-op', () => {
  const img = woodGrain(120, 120);
  const empty = new ImageData(new Uint8ClampedArray(120 * 120 * 4), 120, 120);
  const { confidence } = textureFill(img, empty);
  assert(confidence === 0, 'should report no confidence for an empty mask');
});

test('completes quickly on a realistic hole', () => {
  const img = woodGrain(1200, 1600);
  const mask = opaqueMark(img, 1050, 1450, 80, 80);
  const t0 = Date.now();
  textureFill(img, mask);
  const ms = Date.now() - t0;
  console.log(`      (${ms}ms on 1200x1600)`);
  assert(ms < 3000, `took ${ms}ms`);
});

console.log(`\n${'─'.repeat(64)}`);
if (!failures.length) { console.log(`✓ All ${passed} texture-fill tests passed.\n`); process.exit(0); }
console.log(`✗ ${failures.length} of ${passed + failures.length} FAILED\n`); process.exit(1);
