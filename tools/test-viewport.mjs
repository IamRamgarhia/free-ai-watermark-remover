/**
 * Tests for preview zoom and pan.
 *
 * Run:  node tools/test-viewport.mjs
 *
 * Precise masking depends on two promises: zooming keeps the point under the
 * cursor where it was, and every layer gets the same size and offset so the
 * mask stays over the pixels it was drawn on. Both are plain geometry, so they
 * run here against a stub stage rather than a browser.
 */

import { Viewport } from '../static/js/viewport.js';

globalThis.window = { devicePixelRatio: 1 };
globalThis.HTMLVideoElement = class {};

let passed = 0; const failures = [];
const test = (n, f) => { try { f(); passed++; } catch (e) { failures.push(n); console.log(`  ✗ ${n}\n      ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m || 'failed'); };
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

/** A stage at (100, 50) of the given size, plus five layers to size. */
function setup(stageW, stageH, imgW, imgH) {
  const rect = { left: 100, top: 50, width: stageW, height: stageH };
  const stage = {
    getBoundingClientRect: () => rect,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    closest: () => null,
    dispatchEvent() {},
  };
  const layers = Array.from({ length: 5 }, () => ({ style: {} }));
  const vp = new Viewport({ stage, layers, getNaturalSize: () => ({ w: imgW, h: imgH }) });
  vp.layout();
  return { vp, rect, layers };
}

/** Image pixel shown at a client point, from the first layer's box. */
function imagePointAt(vp, rect, layers, cx, cy, imgW, imgH) {
  const w = parseFloat(layers[0].style.width), h = parseFloat(layers[0].style.height);
  const left = rect.left + rect.width / 2 - w / 2 + vp.panX;
  const top = rect.top + rect.height / 2 - h / 2 + vp.panY;
  return { x: (cx - left) / w * imgW, y: (cy - top) / h * imgH };
}

test('fit shows the whole image inside the padded stage', () => {
  const { vp, layers } = setup(1000, 500, 1920, 1080);
  assert(near(vp.fitScale, (500 - 32) / 1080, 1e-9), `fitScale ${vp.fitScale}`);
  assert(parseFloat(layers[0].style.height) <= 500 - 32, 'too tall');
  assert(!vp.isZoomed, 'fit should not count as zoomed');
});

test('fit never enlarges a small image by default', () => {
  const { vp } = setup(1000, 800, 300, 200);
  assert(vp.scale === 1, `scale ${vp.scale}`);
});

test('a small image can still be zoomed past 100% on purpose', () => {
  const { vp } = setup(1000, 800, 300, 200);
  vp.zoomIn(); vp.zoomIn();
  assert(vp.scale > 1.5, `scale ${vp.scale}`);
});

test('zooming keeps the image point under the cursor fixed', () => {
  const { vp, rect, layers } = setup(1000, 500, 1920, 1080);
  const cx = 820, cy = 360;
  const before = imagePointAt(vp, rect, layers, cx, cy, 1920, 1080);
  for (const s of [1, 2.5, 7, 0.8]) {
    vp.setScale(s, cx, cy);
    const after = imagePointAt(vp, rect, layers, cx, cy, 1920, 1080);
    assert(near(before.x, after.x, 1.5) && near(before.y, after.y, 1.5),
      `at ${s}: (${before.x.toFixed(1)},${before.y.toFixed(1)}) -> (${after.x.toFixed(1)},${after.y.toFixed(1)})`);
  }
});

test('every layer gets the same size and transform', () => {
  const { vp, layers } = setup(1000, 500, 1920, 1080);
  vp.setScale(3, 300, 200);
  vp.panBy(-40, 25);
  const k = JSON.stringify(layers[0].style);
  assert(layers.every((l) => JSON.stringify(l.style) === k), 'layers diverged');
  assert(layers[0].style.transform.startsWith('translate('), 'no pan transform');
});

test('cannot zoom out past fit or in past the maximum', () => {
  const { vp } = setup(1000, 500, 1920, 1080);
  vp.setScale(0.01);
  assert(near(vp.scale, vp.fitScale, 1e-9), `min ${vp.scale}`);
  vp.setScale(1e6);
  assert(vp.scale === 32, `max ${vp.scale}`);
});

test('pan is clamped so the image cannot be dragged off-stage', () => {
  const { vp } = setup(1000, 500, 1920, 1080);
  vp.setScale(1);
  vp.panBy(1e5, -1e5);
  assert(near(vp.panX, (1920 - 1000) / 2 + 16), `panX ${vp.panX}`);
  assert(near(vp.panY, -((1080 - 500) / 2 + 16)), `panY ${vp.panY}`);
});

test('pan resets to centre along an axis the image fits in', () => {
  const { vp } = setup(1000, 500, 1920, 1080);
  vp.panBy(200, 200);
  assert(vp.panX === 0 && vp.panY === 0, 'fitted image should not move');
});

test('fit() undoes zoom and pan', () => {
  const { vp } = setup(1000, 500, 1920, 1080);
  vp.setScale(4, 900, 500); vp.panBy(30, 30);
  vp.fit();
  assert(!vp.isZoomed && vp.panX === 0 && vp.panY === 0, 'not reset');
});

test('a manual zoom survives a stage resize; fit follows it', () => {
  const { vp, rect } = setup(1000, 500, 1920, 1080);
  vp.setScale(2);
  rect.width = 600; rect.height = 400;
  vp.layout();
  assert(vp.scale === 2, `zoom lost: ${vp.scale}`);
  vp.fit();
  rect.width = 1400; rect.height = 900;
  vp.layout();
  assert(near(vp.scale, vp.fitScale, 1e-9), 'fit did not track the new size');
});

test('ensureVisible pans the keyboard crosshair back into view', () => {
  const { vp, rect, layers } = setup(1000, 500, 1920, 1080);
  vp.setScale(4);
  vp.ensureVisible(1900, 1060);
  const w = parseFloat(layers[0].style.width), h = parseFloat(layers[0].style.height);
  const left = rect.left + rect.width / 2 - w / 2 + vp.panX;
  const top = rect.top + rect.height / 2 - h / 2 + vp.panY;
  const px = left + 1900 * 4, py = top + 1060 * 4;
  assert(px >= rect.left && px <= rect.left + rect.width, `x ${px} off-stage`);
  assert(py >= rect.top && py <= rect.top + rect.height, `y ${py} off-stage`);
});

test('high zoom switches to crisp pixels', () => {
  const { vp, layers } = setup(1000, 500, 1920, 1080);
  assert(layers[0].style.imageRendering === '', 'pixelated at fit');
  vp.setScale(4);
  assert(layers[0].style.imageRendering === 'pixelated', 'smoothed at 400%');
});

console.log(`\n${'─'.repeat(64)}`);
if (!failures.length) { console.log(`✓ All ${passed} viewport tests passed.\n`); process.exit(0); }
console.log(`✗ ${failures.length} of ${passed + failures.length} FAILED\n`); process.exit(1);
