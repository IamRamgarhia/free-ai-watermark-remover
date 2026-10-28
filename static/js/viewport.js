/**
 * Zoom and pan for the preview stage.
 *
 * Every layer (image, result, mask, both videos) is sized to the same display
 * box and shifted by the same translate(), so they stay pixel-aligned at any
 * zoom. The mask canvas keeps its native resolution; MaskCanvas maps pointer
 * coordinates through getBoundingClientRect(), which already includes the
 * size and transform set here, so drawing stays exact while zoomed.
 *
 * Scale is "CSS px per image px": 1 means 100%. "Fit" is the largest scale
 * that shows the whole image, capped at 1 so a small image isn't blown up by
 * default — you can still zoom past it on purpose.
 */

const MAX_SCALE = 32;          // enough to see and place individual pixels
const STEP = 1.25;             // one +/- click or key press
const PADDING = 16;            // matches the breathing room the old fit left

export class Viewport {
  /**
   * @param {object} o
   * @param {HTMLElement} o.stage            element the image is fitted into
   * @param {HTMLElement[]} o.layers         elements sized and moved together
   * @param {() => {w:number,h:number}} o.getNaturalSize  image size in px
   * @param {(vp: Viewport) => void} [o.onChange]
   */
  constructor({ stage, layers, getNaturalSize, onChange }) {
    this.stage = stage;
    this.layers = layers.filter(Boolean);
    this.getNaturalSize = getNaturalSize;
    this.onChange = onChange || (() => {});
    this.fitScale = 1;
    this.scale = 1;
    this.fitted = true;        // follow the fit scale as the stage resizes
    this.panX = 0;             // CSS px offset of the image centre from the stage centre
    this.panY = 0;
    this.panTool = false;      // set by app.js when the Pan tool is selected
    this._pointers = new Map();
    this._pan = null;          // active drag-to-pan gesture
    this._pinch = null;        // active two-finger gesture
    this._bindEvents();
  }

  get minScale() { return Math.min(this.fitScale, 1); }
  get isZoomed() { return this.scale > this.fitScale * 1.001; }

  /** Recompute the fit for the current stage size, keeping any manual zoom. */
  layout() {
    const { w, h } = this.getNaturalSize();
    if (!(w > 1 && h > 1)) return;
    const r = this.stage.getBoundingClientRect();
    const maxW = Math.max(50, r.width - PADDING * 2);
    const maxH = Math.max(50, r.height - PADDING * 2);
    this.fitScale = Math.min(maxW / w, maxH / h, 1);
    if (this.fitted) this.scale = this.fitScale;
    this.scale = this._clampScale(this.scale);
    this._apply();
  }

  /** Back to "whole image visible". */
  fit() {
    this.fitted = true;
    this.panX = this.panY = 0;
    this.layout();
  }

  /** One image pixel per CSS pixel. */
  actualSize() { this.setScale(1); }

  zoomIn(clientX, clientY)  { this.setScale(this.scale * STEP, clientX, clientY); }
  zoomOut(clientX, clientY) { this.setScale(this.scale / STEP, clientX, clientY); }

  /**
   * Zoom to `scale`, keeping the image point under (clientX, clientY) fixed.
   * Without an anchor, zooms about the centre of the stage.
   */
  setScale(scale, clientX, clientY) {
    const next = this._clampScale(scale);
    const r = this.stage.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ax = clientX ?? cx, ay = clientY ?? cy;
    const k = next / this.scale;
    // Offset of the anchor from the image centre scales with the image, so
    // move the centre by the difference to keep the anchor where it was.
    const dx = ax - (cx + this.panX), dy = ay - (cy + this.panY);
    this.panX = ax - cx - dx * k;
    this.panY = ay - cy - dy * k;
    this.scale = next;
    this.fitted = next <= this.fitScale * 1.001;
    this._apply();
  }

  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this._apply();
  }

  /** Pan the minimum needed to bring image point (x, y) into view. */
  ensureVisible(x, y, margin = 24) {
    if (!this.isZoomed) return;
    const { w, h } = this.getNaturalSize();
    const r = this.stage.getBoundingClientRect();
    // Position of the point relative to the stage centre, in CSS px.
    const px = (x - w / 2) * this.scale + this.panX;
    const py = (y - h / 2) * this.scale + this.panY;
    const limX = r.width / 2 - margin, limY = r.height / 2 - margin;
    let dx = 0, dy = 0;
    if (px > limX) dx = limX - px; else if (px < -limX) dx = -limX - px;
    if (py > limY) dy = limY - py; else if (py < -limY) dy = -limY - py;
    if (dx || dy) this.panBy(dx, dy);
  }

  _clampScale(s) {
    return Math.max(this.minScale, Math.min(MAX_SCALE, s || 1));
  }

  /** Keep at least the stage's worth of image in view; centre it when smaller. */
  _clampPan(dispW, dispH) {
    const r = this.stage.getBoundingClientRect();
    const slackX = Math.max(0, (dispW - r.width) / 2 + PADDING);
    const slackY = Math.max(0, (dispH - r.height) / 2 + PADDING);
    this.panX = dispW <= r.width  ? 0 : Math.max(-slackX, Math.min(slackX, this.panX));
    this.panY = dispH <= r.height ? 0 : Math.max(-slackY, Math.min(slackY, this.panY));
  }

  _apply() {
    const { w, h } = this.getNaturalSize();
    if (!(w > 1 && h > 1)) return;
    const dispW = Math.max(1, Math.round(w * this.scale));
    const dispH = Math.max(1, Math.round(h * this.scale));
    this._clampPan(dispW, dispH);
    const transform = (this.panX || this.panY)
      ? `translate(${Math.round(this.panX)}px, ${Math.round(this.panY)}px)`
      : '';
    // Past ~3 device pixels per image pixel, smoothing only blurs the edges
    // you are trying to mask against; show the real pixels instead.
    const pixelated = this.scale * (window.devicePixelRatio || 1) >= 3;
    for (const el of this.layers) {
      el.style.width = dispW + 'px';
      el.style.height = dispH + 'px';
      el.style.transform = transform;
      el.style.imageRendering = pixelated ? 'pixelated' : '';
    }
    this.stage.classList.toggle('is-zoomed', this.isZoomed);
    this.onChange(this);
  }

  // === Gestures =============================================================

  _bindEvents() {
    const s = this.stage;

    // Wheel (and trackpad pinch, which arrives as ctrl+wheel) zooms at the cursor.
    s.addEventListener('wheel', (e) => {
      if (!this._hasImage()) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const speed = e.ctrlKey ? 0.01 : 0.0015;
      const factor = Math.exp(-e.deltaY * unit * speed);
      this.setScale(this.scale * factor, e.clientX, e.clientY);
    }, { passive: false });

    // Capture phase: decide pan/pinch before the mask canvas starts a stroke.
    s.addEventListener('pointerdown', (e) => this._onDown(e), true);
    s.addEventListener('pointermove', (e) => this._onMove(e), true);
    for (const type of ['pointerup', 'pointercancel']) {
      s.addEventListener(type, (e) => this._onUp(e), true);
    }
    // Right-drag pans, so the context menu must not open on the image.
    s.addEventListener('contextmenu', (e) => {
      if (this._hasImage()) e.preventDefault();
    });
  }

  _hasImage() {
    const { w, h } = this.getNaturalSize();
    return w > 1 && h > 1 && !this.stage.closest('[hidden]');
  }

  _onDown(e) {
    if (!this._hasImage()) return;
    // Leave the native video controls alone.
    if (e.target instanceof HTMLVideoElement && e.button === 0) return;

    if (e.pointerType === 'touch') {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 2) {
        // Second finger: this is a pinch, not a stroke. Undo whatever the
        // first finger already painted.
        this.stage.dispatchEvent(new CustomEvent('viewport:gesture', { bubbles: true }));
        this._pan = null;
        this._pinch = this._pinchState();
        e.stopPropagation();
        e.preventDefault();
        return;
      }
    }

    const wantsPan = e.button === 1 || e.button === 2 || (e.button === 0 && this.panTool);
    if (!wantsPan) return;
    e.stopPropagation();
    e.preventDefault();
    this._pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.stage.classList.add('is-panning');
    try { this.stage.setPointerCapture(e.pointerId); } catch {}
  }

  _onMove(e) {
    if (this._pointers.has(e.pointerId)) {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (this._pinch && this._pointers.size >= 2) {
      e.stopPropagation();
      const now = this._pinchState();
      const prev = this._pinch;
      this.panBy(now.mx - prev.mx, now.my - prev.my);
      if (prev.dist > 0) this.setScale(this.scale * (now.dist / prev.dist), now.mx, now.my);
      this._pinch = now;
      return;
    }
    if (this._pan && e.pointerId === this._pan.id) {
      e.stopPropagation();
      this.panBy(e.clientX - this._pan.x, e.clientY - this._pan.y);
      this._pan.x = e.clientX;
      this._pan.y = e.clientY;
    }
  }

  _onUp(e) {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._pinch = null;
    if (this._pan && e.pointerId === this._pan.id) {
      e.stopPropagation();
      this._pan = null;
      this.stage.classList.remove('is-panning');
      try { this.stage.releasePointerCapture(e.pointerId); } catch {}
    }
  }

  _pinchState() {
    const [a, b] = [...this._pointers.values()];
    return {
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }
}
