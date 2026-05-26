/**
 * Video pipeline — pure browser, no ffmpeg.
 *
 * STRATEGY (post-debug rewrite):
 *
 *   1. Run AI inpainting ONCE on the first frame to get the clean pixels for
 *      the masked region. This is the only expensive step.
 *
 *   2. Build a "patch canvas" — RGBA where the masked region holds those
 *      clean pixels and everything else is transparent.
 *
 *   3. Play the source video at 1× speed. On each decoded frame:
 *        - draw the frame onto the output canvas
 *        - draw the patch on top (only paints the masked area)
 *      Use requestVideoFrameCallback for frame-accurate, real-time capture.
 *
 *   4. MediaRecorder captures the output canvas at 30fps + the original audio
 *      track in real time. Result: a video of identical duration with the
 *      watermark replaced by the patch.
 *
 * Why playback-based instead of seek-based:
 *   MediaRecorder records in WALL-CLOCK time. captureStream(0) with manual
 *   requestFrame produced misshapen output (long duration, wrong fps) when
 *   the seek loop took longer than the video. Playback at 1× guarantees the
 *   output duration matches input.
 *
 * Total time:
 *   1× AI inference (~10–20s on WASM, ~2-3s on WebGPU) + video duration.
 *   A 10s clip → ~20–30s total. (No way to go faster without changing models.)
 */

const PREFERRED_FPS = 30;

export async function loadVideoMetadata(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';

  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Could not decode video')), { once: true });
  });

  return {
    video,
    url,
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
    fps: PREFERRED_FPS,
    revoke: () => URL.revokeObjectURL(url),
  };
}

export async function grabFirstFrame(video) {
  if (video.readyState < 2) {
    await new Promise(r => video.addEventListener('loadeddata', r, { once: true }));
  }
  video.currentTime = 0;
  await new Promise(r => video.addEventListener('seeked', r, { once: true }));

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas;
}

/**
 * Build a transparent-backed canvas where only the masked region holds the
 * inpainted clean pixels (with feathered alpha at edges for seamless blending).
 */
function buildPatchCanvas(inpaintedImage, maskImage, featherRadius = 6) {
  const { width: w, height: h } = inpaintedImage;
  const patch = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const a = maskImage.data[i * 4 + 3];
    if (a > 16) {
      patch.data[i * 4 + 0] = inpaintedImage.data[i * 4 + 0];
      patch.data[i * 4 + 1] = inpaintedImage.data[i * 4 + 1];
      patch.data[i * 4 + 2] = inpaintedImage.data[i * 4 + 2];
      patch.data[i * 4 + 3] = 255;
    }
  }
  const baseCanvas = new OffscreenCanvas(w, h);
  baseCanvas.getContext('2d').putImageData(patch, 0, 0);

  const featherCanvas = new OffscreenCanvas(w, h);
  const fctx = featherCanvas.getContext('2d');
  fctx.filter = `blur(${featherRadius}px)`;
  fctx.drawImage(baseCanvas, 0, 0);
  fctx.filter = 'none';
  return featherCanvas;
}

/**
 * Process a video. Returns a Blob of the output video.
 */
export async function processVideo({ video, maskImageData, inpaintFn, onProgress, opts = {} }) {
  const fps = opts.fps || PREFERRED_FPS;
  const width = video.videoWidth;
  const height = video.videoHeight;
  const duration = video.duration;
  const t0 = performance.now();

  // ===== Step 1: AI on first frame =====
  onProgress?.(2, 'Decoding first frame');
  video.muted = true;
  video.currentTime = 0;
  await new Promise(r => video.addEventListener('seeked', r, { once: true }));

  const refCanvas = document.createElement('canvas');
  refCanvas.width = width;
  refCanvas.height = height;
  const refCtx = refCanvas.getContext('2d', { willReadFrequently: true });
  refCtx.drawImage(video, 0, 0);
  const firstFrameImageData = refCtx.getImageData(0, 0, width, height);

  onProgress?.(5, 'Running AI on reference frame (one-time)');
  console.log('[video] Running LaMa on first frame');
  const aiStart = performance.now();
  const inpaintedFirstFrame = await inpaintFn(firstFrameImageData, maskImageData);
  console.log(`[video] First-frame AI done in ${((performance.now() - aiStart) / 1000).toFixed(1)}s`);

  // ===== Step 2: Build patch =====
  onProgress?.(12, 'Preparing patch');
  const patchCanvas = buildPatchCanvas(inpaintedFirstFrame, maskImageData, 6);

  // ===== Step 3: Set up output canvas + recording =====
  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext('2d');

  // captureStream(fps) — automatic capture at the requested rate
  const canvasStream = outCanvas.captureStream(fps);
  const videoTrack = canvasStream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('captureStream returned no video track');

  // Audio: pull directly from the source video's MediaElement
  let audioTrack = null;
  if (opts.includeAudio !== false) {
    try {
      // Source video must be playing for captureStream() to yield an audio track
      const srcStream = video.captureStream ? video.captureStream() : video.mozCaptureStream?.();
      if (srcStream) {
        const at = srcStream.getAudioTracks()[0];
        if (at) audioTrack = at;
      }
    } catch (e) {
      console.warn('[video] Could not capture audio:', e);
    }
  }

  const mediaStream = new MediaStream();
  mediaStream.addTrack(videoTrack);
  if (audioTrack) mediaStream.addTrack(audioTrack);

  const candidates = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const mimeType = opts.mimeType || candidates.find(m => MediaRecorder.isTypeSupported(m));
  if (!mimeType) throw new Error('No supported MediaRecorder mime type');

  const recorder = new MediaRecorder(mediaStream, { mimeType, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  const recordingDone = new Promise(r => { recorder.onstop = r; });

  // ===== Step 4: Play video and capture =====
  onProgress?.(15, 'Recording — playing through video');
  video.currentTime = 0;
  video.muted = opts.includeAudio === false;  // mute the source video if we don't want audio

  // Draw first frame BEFORE starting recorder so it's not blank
  await new Promise(r => video.addEventListener('seeked', r, { once: true }));
  outCtx.drawImage(video, 0, 0, width, height);
  outCtx.drawImage(patchCanvas, 0, 0);

  recorder.start();

  // Use requestVideoFrameCallback when available — gives us frame-accurate timing.
  const useVFC = typeof video.requestVideoFrameCallback === 'function';

  await new Promise((resolve, reject) => {
    let frameCount = 0;
    const totalFrames = Math.max(1, Math.floor(duration * fps));
    let lastReportedPct = 15;
    const playStart = performance.now();

    function onFrame() {
      outCtx.drawImage(video, 0, 0, width, height);
      outCtx.drawImage(patchCanvas, 0, 0);
      frameCount++;
      const elapsed = (performance.now() - playStart) / 1000;
      const progress = Math.min(98, 15 + (video.currentTime / duration) * 83);
      if (progress - lastReportedPct >= 1) {
        const realtimeFps = frameCount / Math.max(0.1, elapsed);
        onProgress?.(progress, `Recording ${video.currentTime.toFixed(1)}s / ${duration.toFixed(1)}s · ${realtimeFps.toFixed(0)} fps`);
        lastReportedPct = progress;
      }
      if (useVFC && !video.ended) {
        video.requestVideoFrameCallback(onFrame);
      }
    }

    video.addEventListener('ended', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('Video playback error')), { once: true });

    // Safety timeout: 3× video duration max
    const safetyTimer = setTimeout(() => {
      console.warn('[video] Safety timeout hit — stopping recording');
      resolve();
    }, (duration + 5) * 3 * 1000);

    if (useVFC) {
      video.requestVideoFrameCallback(onFrame);
    } else {
      // Fallback: poll on rAF
      const tick = () => {
        if (video.ended || video.currentTime >= duration) { resolve(); return; }
        onFrame();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    // Start playback
    video.play().catch((e) => {
      clearTimeout(safetyTimer);
      reject(new Error('Could not play video: ' + (e.message || e)));
    });
  });

  // ===== Step 5: Finalize =====
  onProgress?.(99, 'Encoding final frames');
  // Wait a touch so the last frame settles into the encoder
  await new Promise(r => setTimeout(r, 300));
  recorder.stop();
  await recordingDone;
  video.pause();

  const totalSec = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[video] Total time: ${totalSec}s (${duration.toFixed(1)}s video)`);
  onProgress?.(100, `Done in ${totalSec}s`);

  return new Blob(chunks, { type: mimeType });
}
