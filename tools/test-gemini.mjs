/**
 * Tests for exact Gemini watermark removal.
 *
 * Run:  node tools/test-gemini.mjs
 *
 * Ground truth is built the way Gemini builds it: the calibrated alpha map is
 * composited onto a known image at Gemini's own placement. Removal must then
 * give back that image, essentially exactly — and must never fire on an image
 * that has no watermark, because "removing" a sparkle that is not there digs a
 * dark sparkle into the picture.
 */

import {
  geminiPlacements, findGeminiWatermark, removeGeminiWatermark, addGeminiWatermark,
} from '../static/js/gemini-template.js';

globalThis.ImageData = class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c; }
  }
};

let passed = 0; const failures = [];
const test = (n, f) => { try { f(); passed++; } catch (e) { failures.push(n); console.log(`  ✗ ${n}\n      ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m || 'failed'); };

function hash(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) ^ 0x5bf03635;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const BACKGROUNDS = {
  wood:   (x, y) => { const g = Math.sin(x * 0.45 + Math.sin(y * 0.08) * 3) * 26, f = (hash(x, y) - 0.5) * 26; return [150 + g + f, 110 + g * 0.8 + f, 70 + g * 0.5 + f]; },
  sky:    (x, y) => [90 + y * 0.05, 140 + y * 0.03, 210 - y * 0.02],
  bright: (x, y) => { const f = (hash(x, y) - 0.5) * 20; return [225 + f, 228 + f, 232 + f]; },
  blocks: (x, y) => { const f = (hash(x >> 2, y >> 2) - 0.5) * 120; return [110 + f, 110 + f, 110 + f]; },
};

function makeImage(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, [r, g, b] = fn(x, y);
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  return new ImageData(d, w, h);
}

function psnrBox(a, b, box) {
  let se = 0, n = 0;
  for (let y = box.y; y < box.y + box.size; y++) {
    for (let x = box.x; x < box.x + box.size; x++) {
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) { const d = a.data[i + c] - b.data[i + c]; se += d * d; n++; }
    }
  }
  return se ? 10 * Math.log10(65025 / (se / n)) : 99;
}

console.log('\nPlacement');

test('large outputs use the 96px mark at a 192px margin', () => {
  const p = geminiPlacements(2752, 1536)[0];
  assert(p.variant === 'v2' && p.size === 96 && p.x === 2752 - 192 - 96 && p.y === 1536 - 192 - 96, JSON.stringify(p));
});

test('1024-class outputs use the 36px mark', () => {
  const p = geminiPlacements(1024, 1024)[0];
  assert(p.size === 36, JSON.stringify(p));
});

test('free-tier half-scale outputs use a 48px mark', () => {
  assert(geminiPlacements(1376, 768)[0].size === 48);
});

test('the legacy placement is offered too', () => {
  const v1 = geminiPlacements(1024, 1024).find(p => p.variant === 'v1');
  assert(v1 && v1.size === 48 && v1.x === 1024 - 32 - 48, JSON.stringify(v1));
});

console.log('\nExact recovery');

for (const [W, H] of [[1024, 1024], [1376, 768], [2752, 1536], [768, 1365]]) {
  for (const [name, fn] of Object.entries(BACKGROUNDS)) {
    test(`${W}x${H} on ${name}: found and removed exactly`, () => {
      const original = makeImage(W, H, fn);
      const p = geminiPlacements(W, H)[0];
      const wm = addGeminiWatermark(original, p);
      const m = findGeminiWatermark(wm);
      assert(m, 'not found');
      assert(m.x === p.x && m.y === p.y && m.size === p.size, `found at ${m.x},${m.y} (${m.size}px), expected ${p.x},${p.y}`);
      const { result, stats } = removeGeminiWatermark(wm, m);
      const db = psnrBox(result, original, p);
      assert(db > 50, `${db.toFixed(1)} dB (untouched ${psnrBox(wm, original, p).toFixed(1)} dB)`);
      assert(stats.residualFraction === 0, 'nothing should need filling');
    });
  }
}

test('legacy (pre-3.5) profile is removed exactly', () => {
  const original = makeImage(1024, 1024, BACKGROUNDS.wood);
  const p = geminiPlacements(1024, 1024).find(q => q.variant === 'v1');
  const wm = addGeminiWatermark(original, p);
  const m = findGeminiWatermark(wm);
  assert(m && m.variant === 'v1', `found ${m && m.variant}`);
  assert(psnrBox(removeGeminiWatermark(wm, m).result, original, p) > 50, 'not exact');
});

test('a cropped file (mark shifted a few px) is still found and removed exactly', () => {
  const original = makeImage(1024, 1024, BACKGROUNDS.wood);
  const p0 = geminiPlacements(1024, 1024)[0];
  const p = { ...p0, x: p0.x - 4, y: p0.y + 3 };
  const wm = addGeminiWatermark(original, p);
  const m = findGeminiWatermark(wm);
  assert(m && m.x === p.x && m.y === p.y, `found at ${m && m.x},${m && m.y}`);
  assert(psnrBox(removeGeminiWatermark(wm, m).result, original, p) > 50, 'not exact');
});

test('a resized file (mark 15% weaker) is corrected, not left as a ghost', () => {
  const original = makeImage(1024, 1024, BACKGROUNDS.wood);
  const p = geminiPlacements(1024, 1024)[0];
  const wm = addGeminiWatermark(original, p, 0.85);
  const m = findGeminiWatermark(wm);
  assert(m, 'not found');
  const fixed = psnrBox(removeGeminiWatermark(wm, m).result, original, p);
  const raw = psnrBox(wm, original, p);
  assert(fixed > raw + 12, `${fixed.toFixed(1)} dB vs untouched ${raw.toFixed(1)} dB`);
});

test('pixels outside the mark are left byte-identical', () => {
  const original = makeImage(1024, 1024, BACKGROUNDS.blocks);
  const p = geminiPlacements(1024, 1024)[0];
  const wm = addGeminiWatermark(original, p);
  const { result } = removeGeminiWatermark(wm, findGeminiWatermark(wm));
  for (let y = 0; y < 1024; y += 7) {
    for (let x = 0; x < 1024; x += 7) {
      if (x >= p.x && x < p.x + p.size && y >= p.y && y < p.y + p.size) continue;
      const i = (y * 1024 + x) * 4;
      assert(result.data[i] === wm.data[i], `pixel ${x},${y} changed`);
    }
  }
});

console.log('\nNo false positives');

test('never fires on clean images, including bright look-alike blobs', () => {
  let hits = 0;
  const kinds = [
    ...Object.values(BACKGROUNDS),
    (x, y, s) => { const g = Math.sin(x * 0.3 + Math.sin(y * 0.05) * 3) * 30, f = (hash(x, y, s) - 0.5) * 30, b = hash(x >> 4, y >> 4, s) > 0.9 ? 90 : 0; return [120 + g + f + b, 100 + g + f + b, 90 + g * 0.5 + f + b]; },
  ];
  for (let s = 0; s < 12; s++) {
    for (const [W, H] of [[1024, 1024], [1376, 768], [900, 700]]) {
      for (const k of kinds) if (findGeminiWatermark(makeImage(W, H, (x, y) => k(x, y, s)))) hits++;
    }
  }
  assert(hits === 0, `${hits} false positives`);
});

console.log(`\n${'─'.repeat(64)}`);
if (!failures.length) { console.log(`✓ All ${passed} Gemini tests passed.\n`); process.exit(0); }
console.log(`✗ ${failures.length} of ${passed + failures.length} FAILED\n`); process.exit(1);
