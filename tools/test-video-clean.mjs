/**
 * Tests for per-frame video cleaning.
 *
 * Run:  node tools/test-video-clean.mjs
 *
 * The old pipeline pasted one AI patch, made from the first frame, onto every
 * frame. These tests pan the camera across a textured scene under a
 * watermark and compare each cleaned frame with the true clean frame, against
 * what that frozen patch would have shown. A smooth fill stands in for the AI
 * model, which cannot run in Node.
 */

import { createFrameCleaner, cropImage } from '../static/js/video-clean.js';
import { smoothFill } from '../static/js/dewatermark.js';
import { geminiPlacements, addGeminiWatermark } from '../static/js/gemini-template.js';

globalThis.ImageData = class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c; }
  }
};

let passed = 0; const failures = [];
const test = async (n, f) => { try { await f(); passed++; } catch (e) { failures.push(n); console.log(`  ✗ ${n}\n      ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m || 'failed'); };

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const W = 1280, H = 720;
/** Frame t of a camera panning 4px per frame across shaded wood. */
function frame(t) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, X = x + t * 4;
      const g = Math.sin(X * 0.2 + Math.sin(y * 0.05) * 3) * 30, f = (hash(X, y) - 0.5) * 20, sh = Math.sin(X * 0.01) * 40;
      d[i] = 130 + g + f + sh; d[i + 1] = 110 + g + f + sh; d[i + 2] = 90 + g * 0.5 + f; d[i + 3] = 255;
    }
  }
  return new ImageData(d, W, H);
}

function boxMask(x, y, w, h) {
  const m = new ImageData(W, H);
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) m.data[(j * W + i) * 4 + 3] = 255;
  return m;
}

function overlay(f, alpha, value) {
  const o = new ImageData(new Uint8ClampedArray(f.data), W, H);
  for (let y = 600; y < 640; y++) {
    for (let x = 100; x < 220; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) o.data[i + c] = value * alpha + o.data[i + c] * (1 - alpha);
    }
  }
  return o;
}

/** PSNR over the masked pixels of a crop. */
function psnrCrop(a, b, box, mask) {
  let se = 0, n = 0;
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      if (mask.data[((box.y + y) * W + box.x + x) * 4 + 3] <= 64) continue;
      const i = (y * box.w + x) * 4;
      for (let c = 0; c < 3; c++) { const d = a.data[i + c] - b.data[i + c]; se += d * d; n++; }
    }
  }
  return se ? 10 * Math.log10(65025 / (se / n)) : 99;
}

const fakeAI = async (f, m) => smoothFill(f, m).result;
const pl = geminiPlacements(W, H)[0];

const SCENARIOS = [
  { name: 'Gemini sparkle', method: 'gemini', mode: 'watermark', margin: 25, maxMs: 5,
    mark: (f) => addGeminiWatermark(f, pl), mask: boxMask(pl.x - 4, pl.y - 4, pl.size + 8, pl.size + 8) },
  { name: 'translucent badge', method: 'unblend', mode: 'watermark', margin: 6, maxMs: 40,
    mark: (f) => overlay(f, 0.5, 255), mask: boxMask(96, 596, 128, 48) },
  { name: 'opaque logo', method: 'fill', mode: 'object', margin: 1,
    mark: (f) => overlay(f, 1, 250), mask: boxMask(96, 596, 128, 48) },
];

console.log('\nPanning shot: per-frame cleaning vs the old frozen first-frame patch');

for (const sc of SCENARIOS) {
  await test(`${sc.name}: follows the moving scene`, async () => {
    const first = sc.mark(frame(0));
    const cleaner = await createFrameCleaner({ firstFrame: first, mask: sc.mask, mode: sc.mode, inpaint: fakeAI });
    assert(cleaner.method === sc.method, `chose ${cleaner.method}, expected ${sc.method}`);
    const frozen = cropImage(await fakeAI(first, sc.mask), cleaner.box);

    let now = 0, old = 0, ms = 0, n = 0;
    for (let t = 0; t < 60; t++) {
      const clean = frame(t), region = cropImage(sc.mark(clean), cleaner.box);
      if (cleaner.wantsKeyframe(region)) await cleaner.keyframe(sc.mark(clean));
      const t0 = performance.now();
      const out = cleaner.clean(region);
      ms += performance.now() - t0;
      const truth = cropImage(clean, cleaner.box);
      now += psnrCrop(out, truth, cleaner.box, sc.mask);
      old += psnrCrop(frozen, truth, cleaner.box, sc.mask);
      n++;
    }
    now /= n; old /= n; ms /= n;
    console.log(`  ${sc.name.padEnd(18)} ${cleaner.method.padEnd(8)} ${now.toFixed(1)} dB  vs frozen patch ${old.toFixed(1)} dB   ${ms.toFixed(1)} ms/frame`);
    assert(now > old + sc.margin, `${now.toFixed(1)} dB vs ${old.toFixed(1)} dB`);
    // Generous bound: CI machines are slower and noisier than a laptop.
    if (sc.maxMs) assert(ms < sc.maxMs * 3, `${ms.toFixed(1)} ms per frame`);
  });
}

await test('a static shot keeps using the AI patch instead of re-running it', async () => {
  const mask = boxMask(96, 596, 128, 48);
  let calls = 0;
  const ai = async (f, m) => { calls++; return smoothFill(f, m).result; };
  const still = overlay(frame(0), 1, 250);
  const cleaner = await createFrameCleaner({ firstFrame: still, mask, mode: 'object', inpaint: ai });
  for (let t = 0; t < 10; t++) assert(!cleaner.wantsKeyframe(cropImage(still, cleaner.box)), 'asked for a keyframe on a static shot');
  assert(calls === 1, `AI ran ${calls} times`);
});

await test('works without the AI model (smooth fill only)', async () => {
  const mask = boxMask(96, 596, 128, 48);
  const cleaner = await createFrameCleaner({ firstFrame: overlay(frame(0), 1, 250), mask, mode: 'object' });
  const out = cleaner.clean(cropImage(overlay(frame(5), 1, 250), cleaner.box));
  assert(out.width === cleaner.box.w, 'no output');
  assert(!cleaner.wantsKeyframe(cropImage(frame(30), cleaner.box)), 'cannot refresh without a model');
});

console.log(`\n${'─'.repeat(64)}`);
if (!failures.length) { console.log(`✓ All ${passed} video cleaning tests passed.\n`); process.exit(0); }
console.log(`✗ ${failures.length} of ${passed + failures.length} FAILED\n`); process.exit(1);
