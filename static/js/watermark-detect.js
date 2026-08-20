/**
 * Automatic watermark detection.
 *
 * WHY THIS EXISTS
 * ---------------
 * The old approach hard-coded each generator's badge as a fraction of the image
 * ("Gemini sits at 89% across, 89% down, 8.5% wide"). Those numbers were guesses,
 * and they cannot survive the things that actually vary in practice: aspect
 * ratio, output resolution, and generators quietly restyling their badge. The
 * result was a mask sitting *next to* the watermark instead of on it.
 *
 * So instead of assuming where the badge is, we look for it.
 *
 * HOW IT WORKS
 * ------------
 * A generator badge is a vector graphic composited on top of finished image
 * content, which makes it structurally different from anything the image
 * generator painted:
 *
 *   - Crisp, high-contrast edges (it was rasterised from vectors, not diffused).
 *   - Compact — a small blob, not a region spanning the frame.
 *   - Corner-anchored — essentially all of them hug an edge.
 *   - Internally flat — strokes are near-constant colour, unlike photo texture.
 *
 * The detector looks for exactly that, using a band-pass (difference-of-boxes)
 * response rather than raw edge strength:
 *
 *   1. Search only plausible regions (the four corners, plus edge strips for
 *      credit bars). A strong prior, and cheap.
 *   2. Downscale each region to ~360px, for speed and to damp fine grain.
 *   3. Blur at two scales and subtract: a small blur removes sensor grain and
 *      texture, a large blur estimates the local background. What survives is
 *      "this area is lighter (or darker) than its surroundings" — which is
 *      precisely what compositing a badge does, and is what raw edge magnitude
 *      could NOT distinguish from ordinary busy texture.
 *   4. Threshold that residual adaptively, then extract connected components.
 *      Positive and negative responses are handled separately so a white badge
 *      on dark content and a dark badge on light content both register.
 *   5. Score each blob on size, compactness, residual strength and corner
 *      proximity. Return the best few, ranked.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not template-match a library of known logos. That needs a pixel-exact
 * template per generator per revision, and a semi-transparent badge composited
 * over arbitrary content correlates poorly against a flat template anyway. The
 * structural approach costs nothing to maintain and also catches badges we have
 * never seen — a new generator, a stock-photo tag, a channel bug.
 *
 * The tradeoff is that it can be fooled by a genuinely badge-like object in a
 * corner (a bright sign, a logo on clothing). That is why the UI *proposes* the
 * mask for confirmation rather than silently applying it, and why we return
 * ranked alternatives instead of a single answer.
 */

// Fraction of each dimension searched inward from a corner.
const CORNER_FRAC = 0.34;
// Regions are scaled down to this longest side before analysis.
const WORK_MAX = 360;
// A badge occupies between these fractions of the whole image.
const MIN_AREA_FRAC = 0.00008;
const MAX_AREA_FRAC = 0.06;

/**
 * @typedef {{x:number,y:number,w:number,h:number,score:number,region:string}} Candidate
 */

/**
 * Find likely watermark badges.
 *
 * @param {ImageData} imageData
 * @param {{region?: string, maxResults?: number}} [opts]
 *        region — restrict the search ('bottom-right', 'top-left', 'bottom', …).
 *                 Use this when the user already knows which corner it is; it
 *                 removes most of the false-positive surface.
 * @returns {Candidate[]} ranked best-first, in ORIGINAL image pixel coordinates
 */
export function detectWatermarks(imageData, opts = {}) {
  const { width: W, height: H } = imageData;
  const maxResults = opts.maxResults ?? 4;

  const regions = buildRegions(W, H).filter(
    r => !opts.region || r.name === opts.region
  );

  const candidates = [];
  for (const region of regions) {
    for (const c of scanRegion(imageData, region, W, H)) candidates.push(c);
  }

  candidates.sort((a, b) => b.score - a.score);

  // Drop near-duplicates from overlapping regions (corners overlap the strips).
  const kept = [];
  for (const c of candidates) {
    if (kept.some(k => iou(k, c) > 0.35)) continue;
    kept.push(c);
    if (kept.length >= maxResults) break;
  }
  return kept;
}

/**
 * Search windows.
 *
 * Corners only, and deliberately tight. An earlier version also scanned
 * full-width strips along the top and bottom to catch wide "credit bars" —
 * that was a mistake. A full-width band of ordinary image content (a horizon,
 * a table edge, the line where someone's trousers meet the floor) has exactly
 * the profile a wide badge would, and the strip search reliably preferred it
 * over the real watermark. Precision matters far more than covering a rare
 * layout, so those are gone; a wide bar can still be masked by hand.
 */
function buildRegions(W, H) {
  const cw = Math.round(W * CORNER_FRAC);
  const ch = Math.round(H * CORNER_FRAC);
  return [
    { name: 'bottom-right', x: W - cw, y: H - ch, w: cw, h: ch, ax: 1, ay: 1 },
    { name: 'bottom-left',  x: 0,      y: H - ch, w: cw, h: ch, ax: 0, ay: 1 },
    { name: 'top-right',    x: W - cw, y: 0,      w: cw, h: ch, ax: 1, ay: 0 },
    { name: 'top-left',     x: 0,      y: 0,      w: cw, h: ch, ax: 0, ay: 0 },
  ].filter(r => r.w > 8 && r.h > 8);
}

/**
 * Known badge geometries.
 *
 * The crucial thing, and the thing the old fraction-based presets got wrong:
 * these badges are placed at an ABSOLUTE pixel offset from the corner, at one
 * of a small set of ABSOLUTE pixel sizes. They do not scale smoothly with the
 * image.
 *
 * That is precisely why fractions failed. "89% across" happens to land near the
 * badge on a square image and lands somewhere else entirely on a 1408x768 one,
 * because the same 32px margin is 2.3% of the width but 4.2% of the height.
 *
 * Values below are the size classes observed in the wild across generator
 * revisions. We do not know which applies to a given file, so we generate all
 * plausible boxes and let the detector score them.
 */
const BADGE_PROFILES = [
  // Measured directly off a real Gemini file (768x1365): the sparkle occupies
  // x 620-672, y 1218-1272, i.e. a ~54px mark sitting 96px in from both edges.
  // Listed first because it is the only entry here taken from an actual image
  // rather than from second-hand reports of what these badges look like.
  { logo: 54, margin: 96 },
  { logo: 48, margin: 32 },
  { logo: 96, margin: 64 },
  { logo: 96, margin: 192 },
  { logo: 36, margin: 96 },
  { logo: 46, margin: 32 },
  { logo: 72, margin: 108 },
];

/**
 * Candidate badge boxes for a corner, from the known geometries.
 * Sorted largest-first so a generous box is offered before a tight one.
 *
 * @returns {{x:number,y:number,w:number,h:number,profile:string}[]}
 */
export function presetBoxes(W, H, corner = 'bottom-right') {
  const short = Math.min(W, H);
  const out = [];
  for (const { logo, margin } of BADGE_PROFILES) {
    // Skip geometries that cannot fit — a 192px margin is meaningless on a
    // 512px image.
    if (logo + margin * 2 > short) continue;
    const right = corner.endsWith('right');
    const bottom = corner.startsWith('bottom');
    out.push({
      x: right ? W - margin - logo : margin,
      y: bottom ? H - margin - logo : margin,
      w: logo,
      h: logo,
      profile: `${logo}px @ ${margin}px`,
    });
  }
  // A proportional fallback for generators we have no fixed geometry for.
  const prop = Math.round(short * 0.075);
  const pm = Math.round(short * 0.03);
  out.push({
    x: corner.endsWith('right') ? W - pm - prop : pm,
    y: corner.startsWith('bottom') ? H - pm - prop : pm,
    w: prop, h: prop, profile: 'proportional',
  });
  return out;
}


/**
 * Score a candidate box by how much it looks like it CONTAINS A BADGE.
 *
 * The obvious measure -- peak local contrast -- does not work, and it is worth
 * saying why, because it looks reasonable and fails badly. Measured on a real
 * Gemini file, boxes sitting on open terrain scored 102 and 58 while the boxes
 * actually containing the sparkle scored 28. A faint badge is simply less
 * contrasty than a horizon or a shadow, so "most contrast" reliably points at
 * scenery.
 *
 * What separates a badge from scenery is not strength but SHAPE. A badge is a
 * compact, roughly symmetric blob that sits clear of its surroundings; an edge
 * running through the box is long, thin, and touches the sides. So the response
 * is thresholded, broken into regions, and each is judged on how blob-like it
 * is -- squareness, how solidly it fills its own bounding box, whether it takes
 * up a plausible share of the candidate, and whether it stays clear of the
 * edges. The best region's score is the box's score.
 *
 * Returns the winning region's own bounding box as well as its score. That
 * location is the point of the exercise: a preset box is only ever an
 * approximation of where the badge sits, and it is nearly always the wrong
 * SHAPE -- too large, or square where the mark is not. Recovery is very
 * sensitive to a mask that includes scenery, so what we actually want is the
 * mark's own extent, which this already has to compute in order to score.
 *
 * @returns {{score:number, x:number, y:number, w:number, h:number}|null}
 */
export function scoreBox(imageData, box) {
  const { width: W, height: H, data } = imageData;
  const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y);
  const x1 = Math.min(W, box.x + box.w), y1 = Math.min(H, box.y + box.h);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 8 || bh < 8) return null;

  const n = bw * bh;
  const lum = new Float32Array(n);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((y0 + y) * W + (x0 + x)) * 4;
      lum[y * bw + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }

  const short = Math.min(bw, bh);
  const near = boxBlur(lum, bw, bh, Math.max(1, Math.round(short * 0.05)));
  const far  = boxBlur(lum, bw, bh, Math.max(4, Math.round(short * 0.5)));
  const resid = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    resid[i] = near[i] - far[i];
    const a = Math.abs(resid[i]);
    if (a > peak) peak = a;
  }
  if (peak < 2.5) return null;

  // Try both polarities; a badge may be lighter or darker than its background.
  let best = 0, bestComp = null, bestSign = 1;
  for (const sign of [1, -1]) {
    const bin = new Uint8Array(n);
    const thr = peak * 0.45;
    for (let i = 0; i < n; i++) bin[i] = sign * resid[i] >= thr ? 1 : 0;

    for (const c of components(bin, bw, bh)) {
      const cw = c.maxX - c.minX + 1, ch = c.maxY - c.minY + 1;
      if (c.count < 12) continue;
      const fill = c.count / (cw * ch);
      const aspect = Math.min(cw, ch) / Math.max(cw, ch);
      const share = (cw * ch) / n;
      // A badge occupies a healthy but not overwhelming share of a well-aimed box.
      const shareScore = share > 0.02 && share < 0.75 ? 1 : 0.15;
      // Touching the box edge suggests something passing through rather than
      // sitting inside -- an edge, not a badge.
      const touches = (c.minX === 0 || c.minY === 0 || c.maxX === bw - 1 || c.maxY === bh - 1);
      const isolation = touches ? 0.25 : 1;
      const score = aspect * fill * shareScore * isolation * 3;
      if (score > best) { best = score; bestComp = c; bestSign = sign; }
    }
  }
  if (!bestComp) return null;

  // Grow the core out to the mark's true extent.
  //
  // Thresholding at a level high enough to reject scenery only captures the
  // BRIGHT CORE of a soft-edged badge -- on the file this was tuned against it
  // returned 36x36 for a sparkle that is really 52x54, leaving the arms behind
  // to reappear as a faint cross after removal. Growing outward from the core
  // at a much lower threshold picks those arms up, and because growth is local
  // and bounded it cannot wander off into a horizon the way a globally lower
  // threshold would.
  // Re-derive the winning component's pixels: components() keeps only bounds,
  // and re-thresholding inside those bounds is cheaper than retaining lists for
  // every candidate region just to use one of them.
  const grow = new Uint8Array(n);
  const stack = [];
  const seedThr = peak * 0.45;
  for (let y = bestComp.minY; y <= bestComp.maxY; y++) {
    for (let x = bestComp.minX; x <= bestComp.maxX; x++) {
      const i = y * bw + x;
      if (bestSign * resid[i] >= seedThr) { grow[i] = 1; stack.push(i); }
    }
  }
  if (!stack.length) return null;
  const soft = peak * 0.12;
  const maxReach = Math.round(Math.max(bestComp.maxX - bestComp.minX, bestComp.maxY - bestComp.minY) * 0.9) + 6;
  const cx = (bestComp.minX + bestComp.maxX) / 2, cy = (bestComp.minY + bestComp.maxY) / 2;
  while (stack.length) {
    const o = stack.pop();
    const ox = o % bw, oy = (o / bw) | 0;
    const nb = [];
    if (ox > 0) nb.push(o - 1);
    if (ox < bw - 1) nb.push(o + 1);
    if (oy > 0) nb.push(o - bw);
    if (oy < bh - 1) nb.push(o + bw);
    for (const k of nb) {
      if (grow[k]) continue;
      const kx = k % bw, ky = (k / bw) | 0;
      if (Math.abs(kx - cx) > maxReach || Math.abs(ky - cy) > maxReach) continue;
      if (bestSign * resid[k] < soft) continue;
      grow[k] = 1;
      stack.push(k);
    }
  }

  let mnX = bw, mnY = bh, mxX = -1, mxY = -1;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (!grow[y * bw + x]) continue;
    if (x < mnX) mnX = x; if (x > mxX) mxX = x;
    if (y < mnY) mnY = y; if (y > mxY) mxY = y;
  }
  // Penalise fragments.
  //
  // Compactness alone rewards seeing only PART of a mark: a small preset box
  // centred on one arm of a sparkle finds a neat little blob that scores better
  // than the whole badge does. Masking that fragment leaves the rest of the
  // watermark on screen. Scale the score by how much of a plausible badge the
  // blob actually spans, so the complete mark wins over a tidy piece of it.
  const dim = Math.max(mxX - mnX + 1, mxY - mnY + 1);
  const completeness = Math.min(1, dim / 45);

  return {
    score: best * completeness,
    x: x0 + mnX, y: y0 + mnY,
    w: mxX - mnX + 1, h: mxY - mnY + 1,
  };
}

function scanRegion(imageData, region, W, H) {
  // --- 1. Crop + downscale the region into working buffers -----------------
  const scale = Math.min(1, WORK_MAX / Math.max(region.w, region.h));
  const rw = Math.max(8, Math.round(region.w * scale));
  const rh = Math.max(8, Math.round(region.h * scale));
  const n = rw * rh;

  const gray = new Float32Array(n);
  const sat = new Float32Array(n);
  const src = imageData.data;

  for (let y = 0; y < rh; y++) {
    // Nearest-neighbour sampling is fine here: we want structure, not fidelity.
    const sy = Math.min(H - 1, region.y + Math.floor(y / scale));
    for (let x = 0; x < rw; x++) {
      const sx = Math.min(W - 1, region.x + Math.floor(x / scale));
      const i = (sy * W + sx) * 4;
      const r = src[i], g = src[i + 1], b = src[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      gray[y * rw + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      sat[y * rw + x] = mx === 0 ? 0 : (mx - mn) / mx;
    }
  }

  // --- 2. Band-pass: small blur minus large blur ---------------------------
  // r1 erases grain/texture; r2 approximates the local background. Their
  // difference is the "does this stand out from what surrounds it" signal.
  const shortSide = Math.min(rw, rh);
  const r1 = Math.max(1, Math.round(shortSide * 0.012));
  const r2 = Math.max(r1 + 3, Math.round(shortSide * 0.18));
  const near = boxBlur(gray, rw, rh, r1);
  const far  = boxBlur(gray, rw, rh, r2);

  const resid = new Float32Array(n);
  for (let i = 0; i < n; i++) resid[i] = near[i] - far[i];

  // --- 3. Adaptive threshold ----------------------------------------------
  const absResid = new Float32Array(n);
  for (let i = 0; i < n; i++) absResid[i] = Math.abs(resid[i]);
  // A percentile adapts to the region, but an absolute floor stops a flat
  // region from producing a "strongest 3%" that is really just noise.
  const thr = Math.max(6, percentile(absResid, 0.965));

  // --- 4. Split by sign so light and dark badges both register -------------
  const pos = new Uint8Array(n);
  const neg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (resid[i] >= thr) pos[i] = 1;
    else if (resid[i] <= -thr) neg[i] = 1;
  }
  const masks = [dilate(pos, rw, rh, 2), dilate(neg, rw, rh, 2)];

  // --- 5. Connected components + scoring ----------------------------------
  const imageArea = W * H;
  const out = [];
  for (const mask of masks) {
  for (const comp of components(mask, rw, rh)) {
    // Back to original-image coordinates.
    const bx = region.x + comp.minX / scale;
    const by = region.y + comp.minY / scale;
    const bw = (comp.maxX - comp.minX + 1) / scale;
    const bh = (comp.maxY - comp.minY + 1) / scale;

    const areaFrac = (bw * bh) / imageArea;
    if (areaFrac < MIN_AREA_FRAC || areaFrac > MAX_AREA_FRAC) continue;

    const aspect = bw / bh;
    if (aspect < 0.08 || aspect > 14) continue;

    // Blob fills its own bounding box — badges are solid-ish, not stringy.
    const fill = comp.count / ((comp.maxX - comp.minX + 1) * (comp.maxY - comp.minY + 1));
    if (fill < 0.12) continue;

    // How strongly does this blob actually stand out, and how colourful is it?
    let strengthSum = 0, satSum = 0, px = 0;
    for (let y = comp.minY; y <= comp.maxY; y++) {
      for (let x = comp.minX; x <= comp.maxX; x++) {
        const o = y * rw + x;
        strengthSum += absResid[o];
        satSum += sat[o];
        px++;
      }
    }
    const strength = strengthSum / Math.max(1, px);
    const meanSat = satSum / Math.max(1, px);

    // Distance from the region's anchor corner, normalised — badges hug edges.
    const cxFrac = (bx + bw / 2) / W;
    const cyFrac = (by + bh / 2) / H;
    const dx = Math.abs(cxFrac - region.ax);
    const dy = Math.abs(cyFrac - region.ay);
    const cornerDist = Math.hypot(dx, dy);

    // --- Score --------------------------------------------------------------
    // Deliberately simple and readable; every term is a property we argued for
    // in the header comment rather than a tuned magic number.
    let score = 0;
    score += Math.min(1, strength / 14) * 2.2;               // stands out locally
    score += Math.min(1, fill / 0.5) * 1.0;                  // solid, not stringy
    score += Math.max(0, 1 - cornerDist / 0.28) * 1.8;       // hugs its corner
    // Prefer badge-sized things; penalise the very small and the very large.
    const sizeIdeal = 0.0025;
    score += Math.max(0, 1 - Math.abs(Math.log(areaFrac / sizeIdeal)) / 3.2) * 1.2;
    // Most badges are white/grey. Colourful ones exist (the DALL·E 2 bar), so
    // this nudges rather than filters.
    score += (1 - Math.min(1, meanSat / 0.5)) * 0.5;

    out.push({
      x: Math.max(0, Math.round(bx)),
      y: Math.max(0, Math.round(by)),
      w: Math.min(W, Math.round(bw)),
      h: Math.min(H, Math.round(bh)),
      score,
      region: region.name,
    });
  }
  }
  return out;
}

/**
 * Mean over a (2r+1) square window, via an integral image so the cost does not
 * grow with the radius.
 */
function boxBlur(src, w, h, r) {
  const iw = w + 1;
  const I = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x];
      I[(y + 1) * iw + (x + 1)] = I[y * iw + (x + 1)] + rowSum;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const sum = I[(y1 + 1) * iw + (x1 + 1)] - I[y0 * iw + (x1 + 1)]
                - I[(y1 + 1) * iw + x0]       + I[y0 * iw + x0];
      out[y * w + x] = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}

/** Grow a binary mask by `r` pixels (square structuring element). */
function dilate(bin, w, h, r) {
  const out = new Uint8Array(bin.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue;
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) out[yy * w + xx] = 1;
      }
    }
  }
  return out;
}

/** Connected components (4-connected), iterative so deep blobs can't blow the stack. */
function components(bin, w, h) {
  const seen = new Uint8Array(bin.length);
  const comps = [];
  const stack = [];
  for (let s = 0; s < bin.length; s++) {
    if (!bin[s] || seen[s]) continue;
    let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const o = stack.pop();
      const x = o % w, y = (o / w) | 0;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0     && bin[o - 1] && !seen[o - 1]) { seen[o - 1] = 1; stack.push(o - 1); }
      if (x < w - 1 && bin[o + 1] && !seen[o + 1]) { seen[o + 1] = 1; stack.push(o + 1); }
      if (y > 0     && bin[o - w] && !seen[o - w]) { seen[o - w] = 1; stack.push(o - w); }
      if (y < h - 1 && bin[o + w] && !seen[o + w]) { seen[o + w] = 1; stack.push(o + w); }
    }
    comps.push({ minX, minY, maxX, maxY, count });
  }
  return comps;
}

function percentile(arr, p) {
  // Histogram rather than a sort — this runs over ~100k values per region.
  const BINS = 512;
  let max = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  if (max <= 0) return 0;
  const hist = new Int32Array(BINS);
  for (let i = 0; i < arr.length; i++) {
    hist[Math.min(BINS - 1, ((arr[i] / max) * (BINS - 1)) | 0)]++;
  }
  const target = arr.length * p;
  let cum = 0;
  for (let b = 0; b < BINS; b++) {
    cum += hist[b];
    if (cum >= target) return (b / (BINS - 1)) * max;
  }
  return max;
}

function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (inter <= 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}
