/**
 * Per-frame watermark cleaning for video.
 *
 * The previous pipeline ran the AI once on the first frame and pasted that
 * patch onto every frame. On a locked-off shot that is fine; the moment the
 * camera pans or anything moves behind the watermark, the patch is a frozen
 * rectangle of the first frame sliding over a moving scene.
 *
 * This cleans every frame from that frame's own pixels, choosing the best
 * method that is fast enough to run in real time:
 *
 *   gemini   The exact Gemini sparkle was found on the first frame. Reverse
 *            alpha blending per frame: exact, and microseconds per frame.
 *   unblend  A translucent mark. Its alpha map is estimated on the first
 *            frame and applied to every frame, which is fast; it is refined
 *            by averaging in a fresh estimate every few frames. The overlay
 *            never moves but the scene does, so the texture that leaks into
 *            any one estimate averages out: on a moving shot the estimate
 *            gets better as the video plays. Only the opaque core is filled.
 *   fill     An opaque mark or object. Nothing under it survives, so it has
 *            to be filled.
 *
 * Whatever needs filling uses the AI patch while the background around the
 * mask still matches the frame the AI saw, and a smooth fill that follows the
 * scene when it does not. When the scene has moved on, `wantsKeyframe()` asks
 * the caller to pause and re-run the AI on the current frame.
 *
 * Everything here works on a crop around the mask, so the per-frame cost
 * depends on the watermark's size, not the video's resolution.
 */

import { unblendWatermark, smoothFill, maskBbox, residualIsNegligible } from './dewatermark.js';
import { findGeminiWatermark, removeGeminiWatermark } from './gemini-template.js';

/** Context kept around the mask: the ring that change detection compares. */
const RING = 12;
/** Mean luminance change in the ring above which the AI patch is stale. */
const STALE = 6;
/** Fold a fresh alpha estimate into the running average every N frames. */
const REFINE_EVERY = 10;

/**
 * @param {object} o
 * @param {ImageData} o.firstFrame  full first frame
 * @param {ImageData} o.mask        full-size mask (alpha > 64), already dilated
 * @param {'watermark'|'object'} o.mode
 * @param {(frame: ImageData, mask: ImageData) => Promise<ImageData>} [o.inpaint]
 */
export async function createFrameCleaner({ firstFrame, mask, mode, inpaint }) {
  const { width: W, height: H } = firstFrame;
  const box = maskBbox(mask, RING);
  if (!box) throw new Error('Mask is empty');
  const crop = (img) => cropImage(img, box);
  const regionMask = crop(mask);
  const first = crop(firstFrame);

  // --- Choose the method from the first frame ------------------------------
  let method = 'fill';
  let gemini = null, residual = regionMask;
  let alphaSum = null, alphaCount = 0, alphaAvg = null, frameNo = 0;

  if (mode === 'watermark') {
    const tight = maskBbox(mask, 0);
    const found = findGeminiWatermark(firstFrame, { within: tight });
    if (found && overlapFraction(found, tight) > 0.5) {
      method = 'gemini';
      const rec = removeGeminiWatermark(firstFrame, found);
      gemini = { ...found, x: found.x - box.x, y: found.y - box.y, gain: rec.stats.gain };
      residual = crop(rec.residualMask);
    } else {
      const rec = unblendWatermark(first, regionMask);
      if (!rec.stats.fellBack) {
        method = 'unblend';
        alphaSum = Float32Array.from(rec.alpha.map);
        alphaCount = 1;
        alphaAvg = { map: Float32Array.from(rec.alpha.map), wmValue: rec.alpha.wmValue };
        residual = residualIsNegligible(rec.stats) ? null : rec.residualMask;
      }
    }
  }
  const needsFill = method === 'fill' || (residual && maskHasPixels(residual));

  // --- AI patch, and the ring it was made against --------------------------
  let patch = null, patchRing = null, keyframes = 0;
  async function keyframe(fullFrame) {
    if (!inpaint || !needsFill) return;
    const out = await inpaint(fullFrame, mask);
    patch = crop(out);
    patchRing = ringLuma(crop(fullFrame), regionMask);
    keyframes++;
  }
  await keyframe(firstFrame);

  let bgFill = null;

  return {
    box,
    method,
    get keyframes() { return keyframes; },

    /** True when the AI patch no longer matches what is around the mask. */
    wantsKeyframe(region) {
      if (!needsFill || !inpaint || !patchRing) return false;
      return ringChange(region, regionMask, patchRing) > STALE;
    },

    keyframe,

    /** Clean one frame's crop (same box as `box`). Returns the cleaned crop. */
    clean(region) {
      let out = region, fillMask = regionMask;

      if (method === 'gemini') {
        const rec = removeGeminiWatermark(region, gemini, { gain: gemini.gain });
        out = rec.result;
        fillMask = maskHasPixels(rec.residualMask) ? rec.residualMask : null;
      } else if (method === 'unblend') {
        if (++frameNo % REFINE_EVERY === 0) {
          const est = unblendWatermark(region, regionMask);
          if (!est.stats.fellBack && est.alpha.wmValue === alphaAvg.wmValue) {
            alphaCount++;
            for (let i = 0; i < alphaSum.length; i++) {
              alphaSum[i] += est.alpha.map[i];
              alphaAvg.map[i] = alphaSum[i] / alphaCount;
            }
          }
        }
        const rec = unblendWatermark(region, regionMask, { alpha: alphaAvg });
        out = rec.result;
        fillMask = residualIsNegligible(rec.stats) ? null : rec.residualMask;
      }
      if (!fillMask) return out;

      // Fill what could not be recovered: the AI patch while it is still valid
      // for this view, otherwise a smooth fill that tracks the scene.
      const fresh = patch && ringChange(region, regionMask, patchRing) <= STALE;
      if (fresh) return composite(out, patch, fillMask);
      const filled = smoothFill(out, fillMask, { background: bgFill });
      bgFill = filled.background;
      return filled.result;
    },
  };
}

/** Copy `box` out of an ImageData. */
export function cropImage(img, box) {
  const out = new ImageData(box.w, box.h);
  for (let y = 0; y < box.h; y++) {
    const s = ((box.y + y) * img.width + box.x) * 4;
    out.data.set(img.data.subarray(s, s + box.w * 4), y * box.w * 4);
  }
  return out;
}

function maskHasPixels(m) {
  for (let i = 3; i < m.data.length; i += 4) if (m.data[i] > 64) return true;
  return false;
}

/** Take `src` pixels where `mask` is set, `base` elsewhere. */
function composite(base, src, mask) {
  const out = new Uint8ClampedArray(base.data);
  for (let i = 0; i < out.length; i += 4) {
    if (mask.data[i + 3] <= 64) continue;
    out[i] = src.data[i]; out[i + 1] = src.data[i + 1]; out[i + 2] = src.data[i + 2];
  }
  return new ImageData(out, base.width, base.height);
}

/** Luminance of the unmasked ring pixels, in a fixed order. */
function ringLuma(region, mask) {
  const v = [];
  for (let i = 0; i < region.data.length; i += 4) {
    if (mask.data[i + 3] > 64) continue;
    v.push(0.299 * region.data[i] + 0.587 * region.data[i + 1] + 0.114 * region.data[i + 2]);
  }
  return Float32Array.from(v);
}

/** Mean absolute luminance change of the ring against a reference. */
function ringChange(region, mask, ref) {
  const now = ringLuma(region, mask);
  if (!ref || now.length !== ref.length || !now.length) return Infinity;
  let d = 0;
  for (let i = 0; i < now.length; i++) d += Math.abs(now[i] - ref[i]);
  return d / now.length;
}

function overlapFraction(match, box) {
  const x0 = Math.max(match.x, box.x), y0 = Math.max(match.y, box.y);
  const x1 = Math.min(match.x + match.size, box.x + box.w);
  const y1 = Math.min(match.y + match.size, box.y + box.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (match.size * match.size);
}
