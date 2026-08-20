/**
 * Canvas mask drawing — brush, eraser, rectangle.
 * Mask is rendered in violet on a transparent overlay canvas;
 * the alpha channel of that canvas IS the mask.
 */

// Bright magenta — works well over any image content (chosen for contrast on
// both bright and dark backgrounds; opaque enough to clearly indicate the mask).
const MASK_COLOR = 'rgba(255, 64, 192, 0.65)';

export class MaskCanvas {
  /**
   * @param {HTMLCanvasElement} canvas the overlay canvas (transparent on top of image)
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.tool = 'brush';
    this.brushSize = 30;
    this.isDrawing = false;
    this.lastX = 0;
    this.lastY = 0;
    this.startX = 0;
    this.startY = 0;
    this.rectPreviewSnapshot = null;
    this.undoStack = [];
    this.maxUndo = 20;

    // --- Keyboard masking state ---
    // The canvas is the only way to draw a custom mask, so it has to be
    // operable without a pointer. A virtual cursor is moved with the arrow
    // keys and committed with Enter. The crosshair is drawn ONTO the mask
    // canvas (there is no second overlay), so `kbSnapshot` holds the clean
    // mask underneath it and every mask read restores that first — otherwise
    // the crosshair itself would be inpainted.
    this.kbCursor = null;    // {x, y} in canvas pixel coords
    this.kbAnchor = null;    // {x, y} pending rectangle corner
    this.kbSnapshot = null;  // clean mask while the overlay is visible

    this._bindEvents();
  }

  resize(w, h) {
    // Resizing blows away the backing store, so drop the stale overlay state.
    this.kbSnapshot = null;
    this.kbCursor = null;
    this.kbAnchor = null;
    this.canvas.width = w;
    this.canvas.height = h;
    this.clear();
  }

  setTool(tool) {
    this.tool = tool;
    this.kbAnchor = null;          // a half-drawn rect doesn't survive a tool switch
    if (this.kbSnapshot) this._drawKbOverlay();
  }

  setBrushSize(px) {
    this.brushSize = Math.max(1, Math.round(px));
    if (this.kbSnapshot) this._drawKbOverlay();
  }

  clear() {
    this._hideKbOverlay();
    this._pushUndo();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.kbAnchor = null;
  }

  /**
   * Returns the percentage of pixels that are masked (alpha > 16), 0-100.
   * Useful for debug panel and UX hints.
   */
  getCoveragePercent() {
    const { width: w, height: h } = this.canvas;
    if (w === 0 || h === 0) return 0;
    this._hideKbOverlay();
    const data = this.ctx.getImageData(0, 0, w, h).data;
    let masked = 0;
    let sampled = 0;
    // Sample every 16th pixel for speed
    for (let i = 3; i < data.length; i += 64) {
      sampled++;
      if (data[i] > 16) masked++;
    }
    return sampled > 0 ? (masked / sampled) * 100 : 0;
  }

  undo() {
    if (this.undoStack.length === 0) return;
    this.kbSnapshot = null;   // the restored state replaces whatever was under the overlay
    this.kbAnchor = null;
    const snap = this.undoStack.pop();
    this.ctx.putImageData(snap, 0, 0);
  }

  /**
   * Return the current mask as a fresh ImageData (alpha channel = mask).
   */
  getMaskImageData() {
    this._hideKbOverlay();
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }

  // === Events ===
  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    c.addEventListener('pointermove', (e) => this._onMove(e));
    c.addEventListener('pointerup',   (e) => this._onUp(e));
    c.addEventListener('pointerleave', (e) => this._onUp(e));
    // prevent context menu so right-click pan doesn't fight
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('keydown', (e) => this._onKeyDown(e));
    c.addEventListener('blur', () => this._hideKbOverlay());
  }

  // === Keyboard masking =====================================================

  /** Announce state changes to the aria-live region wired up in app.js. */
  _announce(message) {
    this.canvas.dispatchEvent(
      new CustomEvent('mask:announce', { detail: { message }, bubbles: true })
    );
  }

  /** Restore the clean mask, discarding the crosshair overlay. Idempotent. */
  _hideKbOverlay() {
    if (!this.kbSnapshot) return;
    this.ctx.putImageData(this.kbSnapshot, 0, 0);
    this.kbSnapshot = null;
  }

  /** Redraw the crosshair (and any pending rectangle) over a clean mask. */
  _drawKbOverlay() {
    if (!this.kbCursor) return;
    const { width: w, height: h } = this.canvas;
    if (w <= 1 || h <= 1) return;

    this._hideKbOverlay();
    this.kbSnapshot = this.ctx.getImageData(0, 0, w, h);

    const ctx = this.ctx;
    const { x, y } = this.kbCursor;
    // Scale the indicator with image size so it stays visible on a 4K photo
    // and doesn't swamp a thumbnail.
    const lw = Math.max(1, Math.round(Math.min(w, h) / 400));

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // Pending rectangle preview
    if (this.kbAnchor) {
      ctx.fillStyle = MASK_COLOR;
      ctx.fillRect(
        Math.min(this.kbAnchor.x, x), Math.min(this.kbAnchor.y, y),
        Math.abs(x - this.kbAnchor.x), Math.abs(y - this.kbAnchor.y)
      );
    }

    // Crosshair — white core with a dark halo so it reads on any background
    for (const [color, width] of [['rgba(0,0,0,0.85)', lw * 3], ['rgba(255,255,255,0.95)', lw]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
      ctx.moveTo(0, y); ctx.lineTo(w, y);
      ctx.stroke();
      // Brush tools also show the radius they'd paint
      if (this.tool === 'brush' || this.tool === 'erase') {
        ctx.beginPath();
        ctx.arc(x, y, this.brushSize / 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _onKeyDown(e) {
    const { width: w, height: h } = this.canvas;
    if (w <= 1 || h <= 1) return;

    // Start the cursor in the middle on first use.
    if (!this.kbCursor) {
      this.kbCursor = { x: Math.round(w / 2), y: Math.round(h / 2) };
    }

    // Step size: 2% of the image normally, 10% with Shift, 1px with Alt.
    const base = Math.max(1, Math.round(Math.min(w, h) * 0.02));
    const step = e.altKey ? 1 : e.shiftKey ? base * 5 : base;

    // Arrow keys only move the cursor — painting is always an explicit Enter,
    // so a user exploring the image can never accidentally alter the mask.
    const move = (dx, dy) => {
      this.kbCursor.x = Math.max(0, Math.min(w, this.kbCursor.x + dx));
      this.kbCursor.y = Math.max(0, Math.min(h, this.kbCursor.y + dy));
      this._drawKbOverlay();
    };

    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); move(-step, 0); return;
      case 'ArrowRight': e.preventDefault(); move(step, 0);  return;
      case 'ArrowUp':    e.preventDefault(); move(0, -step); return;
      case 'ArrowDown':  e.preventDefault(); move(0, step);  return;

      case 'Enter':
      case ' ': {
        e.preventDefault();
        this._kbCommit();
        return;
      }

      case 'Escape': {
        if (this.kbAnchor) {
          e.preventDefault();
          e.stopPropagation();   // don't let app.js treat this as "start over"
          this.kbAnchor = null;
          this._drawKbOverlay();
          this._announce('Rectangle cancelled.');
        }
        return;
      }
    }
  }

  /** Enter/Space: place a brush dab, or set/complete a rectangle. */
  _kbCommit() {
    const { x, y } = this.kbCursor;

    if (this.tool === 'rect') {
      if (!this.kbAnchor) {
        this.kbAnchor = { x, y };
        this._drawKbOverlay();
        this._announce(
          `Corner set at ${Math.round(x)}, ${Math.round(y)}. ` +
          `Move with the arrow keys and press Enter again to complete the rectangle.`
        );
        return;
      }
      const ax = this.kbAnchor.x, ay = this.kbAnchor.y;
      this.kbAnchor = null;
      this._hideKbOverlay();
      this._pushUndo();
      this._drawRect(ax, ay, x, y);
      this._announce(
        `Rectangle drawn, ${Math.round(Math.abs(x - ax))} by ${Math.round(Math.abs(y - ay))} pixels.`
      );
      this._drawKbOverlay();
      return;
    }

    // Brush / eraser: stamp a single dab at the cursor.
    this._hideKbOverlay();
    this._pushUndo();
    this._drawCircle(x, y, this.brushSize / 2);
    this._announce(
      `${this.tool === 'erase' ? 'Erased' : 'Painted'} at ${Math.round(x)}, ${Math.round(y)}.`
    );
    this._drawKbOverlay();
  }

  _getCoords(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * this.canvas.width,
      y: ((e.clientY - r.top) / r.height) * this.canvas.height,
    };
  }

  _pushUndo() {
    if (this.canvas.width === 0 || this.canvas.height === 0) return;
    this._hideKbOverlay();   // never snapshot the crosshair into undo history
    try {
      const snap = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      this.undoStack.push(snap);
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    } catch (e) {
      console.warn('undo snapshot failed', e);
    }
  }

  _onDown(e) {
    if (e.button !== 0) return;
    // Pointer takes over: drop the keyboard crosshair so it can't be baked in.
    this._hideKbOverlay();
    this.kbAnchor = null;
    this.canvas.setPointerCapture(e.pointerId);
    this._pushUndo();
    this.isDrawing = true;
    const { x, y } = this._getCoords(e);
    this.lastX = x; this.lastY = y;
    this.startX = x; this.startY = y;

    if (this.tool === 'brush' || this.tool === 'erase') {
      this._drawCircle(x, y, this.brushSize / 2);
    } else if (this.tool === 'rect') {
      this.rectPreviewSnapshot = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  _onMove(e) {
    if (!this.isDrawing) return;
    const { x, y } = this._getCoords(e);
    if (this.tool === 'brush' || this.tool === 'erase') {
      this._drawLine(this.lastX, this.lastY, x, y, this.brushSize / 2);
      this.lastX = x; this.lastY = y;
    } else if (this.tool === 'rect') {
      if (this.rectPreviewSnapshot) {
        this.ctx.putImageData(this.rectPreviewSnapshot, 0, 0);
      }
      this._drawRect(this.startX, this.startY, x, y);
    }
  }

  _onUp(e) {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.rectPreviewSnapshot = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
  }

  _drawCircle(x, y, radius) {
    this.ctx.globalCompositeOperation = (this.tool === 'erase') ? 'destination-out' : 'source-over';
    this.ctx.fillStyle = MASK_COLOR;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.fill();
  }

  _drawLine(x1, y1, x2, y2, radius) {
    this.ctx.globalCompositeOperation = (this.tool === 'erase') ? 'destination-out' : 'source-over';
    this.ctx.strokeStyle = MASK_COLOR;
    this.ctx.fillStyle = MASK_COLOR;
    this.ctx.lineWidth = radius * 2;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.ctx.stroke();
  }

  _drawRect(x1, y1, x2, y2) {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = MASK_COLOR;
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    this.ctx.fillRect(x, y, w, h);
  }
}

/**
 * True if a mask ImageData has any painted pixels (alpha > 16).
 *
 * Takes an already-read ImageData rather than reading the canvas itself, so
 * callers that need the buffer anyway don't pay for a second getImageData().
 * Samples every 4th pixel — enough to catch even a small brush dab.
 *
 * @param {{data:Uint8ClampedArray|Uint8Array}} maskImageData
 */
export function maskHasContent(maskImageData) {
  const data = maskImageData?.data;
  if (!data) return false;
  for (let i = 3; i < data.length; i += 16) {
    if (data[i] > 16) return true;
  }
  return false;
}

/**
 * Apply a Gaussian dilation to a mask ImageData by `pixels`.
 * Cheap implementation using canvas filter blur + alpha threshold.
 */
export function dilateMask(maskImageData, pixels) {
  if (pixels <= 0) return maskImageData;
  const { width: w, height: h } = maskImageData;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.putImageData(maskImageData, 0, 0);
  // Approximate dilation: scale up the alpha by blurring then re-thresholding
  ctx.filter = `blur(${pixels / 2}px)`;
  ctx.drawImage(c, 0, 0);
  ctx.filter = 'none';
  const blurred = ctx.getImageData(0, 0, w, h);
  // Threshold alpha back to opaque
  for (let i = 3; i < blurred.data.length; i += 4) {
    blurred.data[i] = blurred.data[i] > 32 ? 255 : 0;
  }
  return blurred;
}
