/**
 * File upload / drag-drop handling. Pure browser — file never leaves the page.
 */

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
const MAX_BYTES = 100 * 1024 * 1024;  // 100 MB — practical browser memory limit for video too

export function bindDropzone({ dropzoneEl, fileInputEl, browseBtn, onFile }) {
  // Click-to-browse
  browseBtn.addEventListener('click', () => fileInputEl.click());
  dropzoneEl.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    fileInputEl.click();
  });
  fileInputEl.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file, onFile);
    fileInputEl.value = '';
  });

  // Drag & drop
  ['dragenter', 'dragover'].forEach(ev => {
    dropzoneEl.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzoneEl.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    dropzoneEl.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (ev === 'dragleave' && dropzoneEl.contains(e.relatedTarget)) return;
      dropzoneEl.classList.remove('drag-over');
    });
  });
  dropzoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file, onFile);
  });

  // Window-level drag-drop catch (so users can drop anywhere)
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && !dropzoneEl.contains(e.target)) {
      handleFile(file, onFile);
    }
  });
}

function handleFile(file, onFile) {
  const result = validateFile(file);
  if (!result.ok) {
    onFile({ error: result.error });
    return;
  }
  if (result.kind === 'video') {
    onFile({ file, kind: 'video' });
    return;
  }
  loadImage(file)
    .then(img => onFile({ file, kind: 'image', image: img }))
    .catch(err => onFile({ error: err.message }));
}

function validateFile(file) {
  if (!file) return { ok: false, error: 'No file selected' };
  if (file.size > MAX_BYTES) {
    return { ok: false, error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Limit is ${MAX_BYTES / 1024 / 1024} MB.` };
  }
  const isVideoMime = ALLOWED_VIDEO_TYPES.includes(file.type) || file.type.startsWith('video/');
  const isVideoExt  = /\.(mp4|webm|mov|mkv|m4v)$/i.test(file.name);
  if (isVideoMime || isVideoExt) {
    return { ok: true, kind: 'video' };
  }
  const okMime = ALLOWED_IMAGE_TYPES.includes(file.type);
  const okExt  = /\.(jpe?g|png|webp|bmp)$/i.test(file.name);
  if (!okMime && !okExt) {
    return { ok: false, error: 'Unsupported format. Use JPG, PNG, WEBP, BMP, MP4, WEBM, or MOV.' };
  }
  return { ok: true, kind: 'image' };
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not decode image — file may be corrupt'));
      i.src = url;
    });
    return img;
  } finally {
    // Revoke after a tick so the consumer can use the image if needed first
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export function imageToImageData(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function downloadCanvas(canvas, filename, format = 'png') {
  const mime = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const quality = format === 'png' ? undefined : 0.95;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, mime, quality);
}
