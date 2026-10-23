/**
 * Video pipeline — pure browser, no ffmpeg.
 *
 * STRATEGY:
 *
 *   1. Decide how to clean the watermark from the first frame (see
 *      video-clean.js): exact Gemini removal, per-frame un-blending, or fill.
 *      The AI runs on the first frame only if something needs filling.
 *
 *   2. Play the source video at 1x speed. On each decoded frame:
 *        - draw the frame onto the output canvas
 *        - clean the crop around the mask from THIS frame's pixels, and
 *          write it back
 *      Use requestVideoFrameCallback for frame-accurate, real-time capture.
 *
 *   3. If the background around the mask has changed since the AI last ran,
 *      pause the video AND the recorder, re-run the AI on the current frame,
 *      and resume. Pausing both keeps the recording continuous, so the extra
 *      time does not show up in the output.
 *
 *   4. MediaRecorder captures the output canvas + the original audio track.
 *
 * Earlier versions ran the AI once and pasted that patch onto every frame,
 * which left a frozen rectangle wherever the scene moved behind the mark.
 *
 * Why playback-based instead of seek-based:
 *   MediaRecorder records in WALL-CLOCK time. captureStream(0) with manual
 *   requestFrame produced misshapen output (long duration, wrong fps) when
 *   the seek loop took longer than the video. Playback at 1× guarantees the
 *   output duration matches input.
 */

import { createFrameCleaner } from './video-clean.js';

// Re-running the AI costs seconds each time, so cap how often a moving shot
// can trigger it.
const MIN_KEYFRAME_GAP_S = 1.0;
const MAX_KEYFRAMES = 30;

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
 * Process a video. Returns a Blob of the output video.
 */
export async function processVideo({ video, maskImageData, inpaintFn, mode = 'watermark', onProgress, opts = {} }) {
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

  onProgress?.(5, 'Analysing the watermark on the first frame');
  const aiStart = performance.now();
  const cleaner = await createFrameCleaner({
    firstFrame: firstFrameImageData,
    mask: maskImageData,
    mode,
    inpaint: inpaintFn,
  });
  const box = cleaner.box;
  console.log(`[video] Method: ${cleaner.method}; first-frame prep ${((performance.now() - aiStart) / 1000).toFixed(1)}s`);

  // ===== Step 3: Set up output canvas + recording =====
  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });

  // Draw a frame, clean the crop around the mask, write it back.
  const renderFrame = () => {
    outCtx.drawImage(video, 0, 0, width, height);
    const region = outCtx.getImageData(box.x, box.y, box.w, box.h);
    outCtx.putImageData(cleaner.clean(region), box.x, box.y);
    return region;
  };

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
  renderFrame();

  recorder.start();
  let lastKeyframeAt = 0;
  let busy = false;

  // Use requestVideoFrameCallback when available — gives us frame-accurate timing.
  const useVFC = typeof video.requestVideoFrameCallback === 'function';

  await new Promise((resolve, reject) => {
    let frameCount = 0;
    const totalFrames = Math.max(1, Math.floor(duration * fps));
    let lastReportedPct = 15;
    const playStart = performance.now();

    async function onFrame() {
      if (busy) return;
      outCtx.drawImage(video, 0, 0, width, height);
      const region = outCtx.getImageData(box.x, box.y, box.w, box.h);

      // The scene behind the mark has moved on from what the AI last saw:
      // pause everything, refresh the AI patch from this frame, carry on.
      if (cleaner.wantsKeyframe(region) &&
          cleaner.keyframes < MAX_KEYFRAMES &&
          video.currentTime - lastKeyframeAt >= MIN_KEYFRAME_GAP_S) {
        busy = true;
        video.pause();
        if (recorder.state === 'recording') recorder.pause();
        onProgress?.(15 + (video.currentTime / duration) * 83, `Scene changed — refreshing fill at ${video.currentTime.toFixed(1)}s`);
        try {
          await cleaner.keyframe(outCtx.getImageData(0, 0, width, height));
        } catch (e) {
          console.warn('[video] keyframe failed, continuing with smooth fill', e);
        }
        lastKeyframeAt = video.currentTime;
        armSafety();   // the AI time is not playback time
        if (recorder.state === 'paused') recorder.resume();
        busy = false;
        video.play().catch(() => {});
      }

      outCtx.putImageData(cleaner.clean(region), box.x, box.y);
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
      if (video.ended) resolve();
    }

    video.addEventListener('ended', () => { clearTimeout(safetyTimer); resolve(); }, { once: true });
    video.addEventListener('error', () => reject(new Error('Video playback error')), { once: true });

    // Safety timeout: 3× video duration of playback, re-armed after each AI
    // refresh so a moving shot that needs several is not cut off.
    let safetyTimer = null;
    function armSafety() {
      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(() => {
        console.warn('[video] Safety timeout hit — stopping recording');
        resolve();
      }, (duration + 5) * 3 * 1000);
    }
    armSafety();

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
