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

    this._bindEvents();
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.clear();
  }

  setTool(tool) { this.tool = tool; }
  setBrushSize(px) { this.brushSize = Math.max(1, Math.round(px)); }

  clear() {
    this._pushUndo();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  hasContent() {
    const { width: w, height: h } = this.canvas;
    if (w === 0 || h === 0) return false;
    // Sample every 4th pixel for reliable detection of small marks.
    const data = this.ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] > 16) return true;
    }
    return false;
  }

  /**
   * Returns the percentage of pixels that are masked (alpha > 16), 0-100.
   * Useful for debug panel and UX hints.
   */
  getCoveragePercent() {
    const { width: w, height: h } = this.canvas;
    if (w === 0 || h === 0) return 0;
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
    const snap = this.undoStack.pop();
    this.ctx.putImageData(snap, 0, 0);
  }

  /**
   * Return the current mask as a fresh ImageData (alpha channel = mask).
   */
  getMaskImageData() {
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
