/**
 * Exemplar fill — repair a hole by COPYING real texture from the same image,
 * instead of asking a network to imagine what belongs there.
 *
 * WHY THIS EXISTS
 * ---------------
 * When a watermark is opaque, the pixels underneath are genuinely gone and
 * something has to invent them. MI-GAN does that, and on faces or foliage it is
 * the right tool. But on the backgrounds these badges actually sit on —
 * wood planks, brick, fabric, paper, a plain wall — it produces a flat smear
 * with visible edges, because a small generative model asked for a patch of
 * "wood" returns the average of all wood it ever saw rather than *this* wood.
 *
 * Repetitive texture does not need to be imagined. It is already in the picture,
 * a few centimetres away.
 *
 * HOW IT WORKS
 * ------------
 * Find the single translation that best explains the neighbourhood of the hole,
 * then copy the hole's contents from there.
 *
 * Concretely: for every candidate offset, compare the KNOWN pixels immediately
 * around the hole against those same pixels shifted by that offset. The offset
 * that matches best is, by construction, one where the surrounding texture lines
 * up — so the pixels it points at are a plausible continuation of the structure
 * running through the hole. Wood grain stays a continuous line; plank seams stay
 * straight; the repair inherits real grain and real noise rather than a mean.
 *
 * This is the single-offset case of exemplar/patch-based inpainting. It is far
 * simpler than PatchMatch and, for the strongly repetitive backgrounds that
 * corner watermarks sit on, gets most of the benefit.
 *
 * WHERE IT IS THE WRONG TOOL
 * --------------------------
 * If nothing nearby resembles the hole's surroundings — a face, a caption, a
 * unique object — the best offset is still a poor one. So the match quality is
 * returned, and the caller falls back to the generative model when the texture
 * hypothesis is not supported. Copying the wrong region is worse than a smear.
 */

/**
 * @param {ImageData} imageData
 * @param {ImageData} maskData    alpha > 64 marks pixels to replace
 * @param {object} [opts]
 * @param {number} [opts.searchRadius]  how far to look for a matching region
 * @param {number} [opts.band=10]       thickness of the known ring used to score
 * @returns {{ result: ImageData, confidence: number, offset: {dx:number,dy:number} }}
 *          `confidence` is 0..1; low means no good exemplar exists nearby.
 */
export function textureFill(imageData, maskData, opts = {}) {
  const { width: W, height: H } = imageData;
  const band = opts.band ?? 10;

  const bbox = maskBbox(maskData);
  if (!bbox) return { result: imageData, confidence: 0, offset: { dx: 0, dy: 0 } };

  const { x: hx, y: hy, w: hw, h: hh } = bbox;
  const searchRadius = opts.searchRadius ?? Math.max(48, Math.round(Math.max(hw, hh) * 4));

  const src = imageData.data;
  const msk = maskData.data;
  const isHole = (x, y) => msk[(y * W + x) * 4 + 3] > 64;

  // --- Collect the known ring around the hole -----------------------------
  // These are the pixels whose agreement decides which offset wins.
  const ring = [];
  for (let y = hy - band; y < hy + hh + band; y++) {
    for (let x = hx - band; x < hx + hw + band; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (isHole(x, y)) continue;
      // Only the collar immediately around the hole — texture further out is
      // less likely to be the same material.
      if (x >= hx && x < hx + hw && y >= hy && y < hy + hh) continue;
      ring.push(y * W + x);
    }
  }
  if (ring.length < 40) return { result: imageData, confidence: 0, offset: { dx: 0, dy: 0 } };

  // Subsample: a few hundred points decide an offset just as well as thousands,
  // and this runs once per candidate offset.
  const step = Math.max(1, Math.floor(ring.length / 400));
  const probes = [];
  for (let i = 0; i < ring.length; i += step) probes.push(ring[i]);

  // --- Search offsets ------------------------------------------------------
  // Coarse pass then a fine pass around the winner: a dense search over the
  // whole radius would be needlessly slow for no extra accuracy.
  let best = null;
  const allErrors = [];
  const evaluate = (dx, dy) => {
    if (dx === 0 && dy === 0) return;
    // The source region must lie inside the image and must not itself be hole.
    if (hx + dx < 0 || hy + dy < 0 || hx + dx + hw > W || hy + dy + hh > H) return;
    let sse = 0, n = 0;
    for (let k = 0; k < probes.length; k++) {
      const o = probes[k];
      const x = o % W, y = (o / W) | 0;
      const sx = x + dx, sy = y + dy;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;   // offset falls off the edge
      if (isHole(sx, sy)) continue;                          // never learn from the mark
      const a = o * 4, b = (sy * W + sx) * 4;
      const dr = src[a] - src[b], dg = src[a + 1] - src[b + 1], db = src[a + 2] - src[b + 2];
      sse += dr * dr + dg * dg + db * db;
      n += 3;
    }
    if (n < probes.length) return;    // too much of the ring was unusable
    const mse = sse / n;
    allErrors.push(mse);
    if (!best || mse < best.mse) best = { dx, dy, mse };
  };

  const coarse = Math.max(2, Math.round(searchRadius / 16));
  for (let dy = -searchRadius; dy <= searchRadius; dy += coarse) {
    for (let dx = -searchRadius; dx <= searchRadius; dx += coarse) evaluate(dx, dy);
  }
  if (!best) return { result: imageData, confidence: 0, offset: { dx: 0, dy: 0 } };
  const c = best;
  for (let dy = c.dy - coarse; dy <= c.dy + coarse; dy++) {
    for (let dx = c.dx - coarse; dx <= c.dx + coarse; dx++) evaluate(dx, dy);
  }

  // --- Confidence ----------------------------------------------------------
  // Self-calibrating: compare the winning offset against the TYPICAL offset for
  // this image, rather than against an absolute error budget.
  //
  // If the surroundings genuinely repeat, one offset lines the texture up and
  // scores far better than the rest. If they do not — lettering, a face, any
  // structured-but-aperiodic content — the best offset is only marginally
  // better than an arbitrary one, and that ratio says so no matter how large
  // the absolute errors happen to be.
  //
  // An earlier version scored against the ring's own variance, which was far
  // too lenient exactly where it mattered: high-contrast aperiodic content has
  // a big variance, which inflated the denominator and produced near-certain
  // confidence on content with nothing to copy.
  const sorted = allErrors.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : Infinity;
  const confidence = (!median || !Number.isFinite(median))
    ? 0
    : Math.max(0, Math.min(1, 1 - best.mse / median));

  // --- Copy the hole from the winning offset -------------------------------
  const out = new Uint8ClampedArray(src);
  for (let y = hy; y < hy + hh; y++) {
    for (let x = hx; x < hx + hw; x++) {
      if (!isHole(x, y)) continue;
      const sx = x + best.dx, sy = y + best.dy;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const d = (y * W + x) * 4, s = (sy * W + sx) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = 255;
    }
  }

  return {
    result: new ImageData(out, W, H),
    confidence,
    offset: { dx: best.dx, dy: best.dy },
  };
}

function maskBbox(maskData) {
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
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
