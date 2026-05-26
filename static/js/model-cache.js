/**
 * IndexedDB-backed model cache. The LaMa ONNX model is ~50 MB —
 * we download it once, store it in IndexedDB, and reuse forever.
 *
 * To bump the model: change MODEL_KEY (e.g. lama_int8_v2) and the URL.
 * Old versions are auto-deleted on next load.
 */

import { getActiveFolder, writeFile, readFile } from './fs-folder.js';

const DB_NAME = 'watermarkout';
const DB_VERSION = 1;
const STORE = 'models';
// Bump this key when changing models — old caches are auto-deleted
const MODEL_KEY = 'migan_v1';
const MODEL_FILENAME = 'inpaint-model.onnx';

// Using MI-GAN — the browser-optimized inpainting model from Picsart Research
// (ICCV 2023, https://github.com/Picsart-AI-Research/MI-GAN).
// Used in production by lxfater/inpaint-web. 29 MB, accepts dynamic input
// resolution (no 512x512 limit), designed for incremental brush-stroke
// removal — much better suited for watermark removal than vanilla LaMa.
const MODEL_URL = 'https://huggingface.co/lxfater/inpaint-web/resolve/main/migan.onnx';
const MODEL_SHA256 = null;

// === IndexedDB helpers ===
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDeleteOldKeys(keepKey) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const k of req.result) {
        if (k !== keepKey && typeof k === 'string' && k.startsWith('lama_')) {
          store.delete(k);
        }
      }
      resolve();
    };
    req.onerror = () => resolve();
  });
}

// === SHA256 verification ===
async function sha256Hex(buffer) {
  const h = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(h))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// === Main API ===

/**
 * Request persistent storage so the browser doesn't evict the 200 MB model
 * to free space. Returns true if persistent storage is granted.
 */
export async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) {
    console.log('[model-cache] Persistent storage API not supported');
    return false;
  }
  try {
    const already = await navigator.storage.persisted();
    if (already) {
      console.log('[model-cache] Persistent storage already granted');
      return true;
    }
    const granted = await navigator.storage.persist();
    console.log(`[model-cache] Persistent storage requested: ${granted ? 'GRANTED' : 'DENIED'}`);
    return granted;
  } catch (e) {
    console.warn('[model-cache] persist() failed:', e);
    return false;
  }
}

/**
 * Load the model — from IndexedDB cache if present, else download with progress.
 * @param {(p:{done:number,total:number,cached?:boolean,stage?:string}) => void} onProgress
 * @returns {Promise<Uint8Array>}
 */
export async function loadModel(onProgress) {
  // 1a. Try user-picked folder FIRST (File System Access API, Chrome/Edge)
  try {
    const folder = await getActiveFolder();
    if (folder) {
      const file = await readFile(folder, MODEL_FILENAME);
      if (file && file.size > 1_000_000) {
        console.log(`[model-cache] HIT — model loaded from your folder (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
        onProgress?.({ done: file.size, total: file.size, cached: true, stage: 'Loaded from your folder' });
        return new Uint8Array(await file.arrayBuffer());
      }
    }
  } catch (e) {
    console.warn('[model-cache] Folder read failed, falling back to IndexedDB:', e);
  }

  // 1b. Try IndexedDB cache
  try {
    const cached = await idbGet(MODEL_KEY);
    if (cached && cached.byteLength > 1_000_000) {
      console.log(`[model-cache] HIT — model loaded from IndexedDB (${(cached.byteLength / 1024 / 1024).toFixed(1)} MB)`);
      onProgress?.({ done: cached.byteLength, total: cached.byteLength, cached: true, stage: 'Loaded from your device' });
      return new Uint8Array(cached);
    }
    console.log('[model-cache] MISS — no cached model found, will download');
  } catch (e) {
    console.warn('[model-cache] IndexedDB read failed, will re-download:', e);
  }

  // Ask for persistent storage BEFORE the big download so the browser
  // doesn't decide to evict us later.
  await requestPersistentStorage();

  // 2. Download
  onProgress?.({ done: 0, total: 0, stage: 'Connecting…' });
  const bytes = await fetchWithProgress(MODEL_URL, onProgress);
  console.log(`[model-cache] Downloaded ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB`);

  // 3. Verify
  if (MODEL_SHA256) {
    onProgress?.({ done: bytes.byteLength, total: bytes.byteLength, stage: 'Verifying…' });
    const hash = await sha256Hex(bytes.buffer);
    if (hash !== MODEL_SHA256) {
      throw new Error(`Model integrity check failed (hash mismatch). Got ${hash.slice(0, 16)}…`);
    }
  }

  // 4a. Save to user-picked folder if one is active
  try {
    const folder = await getActiveFolder();
    if (folder) {
      await writeFile(folder, MODEL_FILENAME, new Blob([bytes]));
      console.log(`[model-cache] ✓ Saved to your folder as ${MODEL_FILENAME}`);
    }
  } catch (e) {
    console.warn('[model-cache] Could not save to your folder, falling back to IndexedDB:', e);
  }

  // 4b. Always also save to IndexedDB as a backup
  try {
    await idbDeleteOldKeys(MODEL_KEY);
    await idbSet(MODEL_KEY, bytes.buffer);
    const verifyRead = await idbGet(MODEL_KEY);
    if (verifyRead && verifyRead.byteLength === bytes.byteLength) {
      console.log(`[model-cache] ✓ Saved to IndexedDB (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB)`);
    } else {
      console.error('[model-cache] ✗ IndexedDB write appeared to succeed but read-back failed.');
    }
  } catch (e) {
    console.error('[model-cache] ✗ Could not save model to IndexedDB:', e);
  }

  return bytes;
}

async function fetchWithProgress(url, onProgress) {
  let res;
  try {
    res = await fetch(url, { cache: 'force-cache' });
  } catch (e) {
    // Network failure or CORS rejection — fetch() throws TypeError
    const isCors = String(e).toLowerCase().includes('cors');
    throw new Error(
      isCors
        ? `Blocked by browser security (CORS). The model URL must be served with proper CORS headers. URL: ${url}`
        : `Network error while downloading the model. Check your internet connection. (${e.message || e})`
    );
  }
  if (!res.ok) {
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      throw new Error(
        `Model file not found at the configured URL (HTTP ${res.status}). ` +
        `This usually means the maintainer hasn't uploaded the model yet — ` +
        `see README "One-time model setup" or edit MODEL_URL in static/js/model-cache.js.`
      );
    }
    throw new Error(`Could not download model (HTTP ${res.status} ${res.statusText}).`);
  }
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress?.({ done: buf.byteLength, total: buf.byteLength, stage: 'Downloaded' });
    return new Uint8Array(buf);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let done = 0;
  while (true) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    chunks.push(value);
    done += value.byteLength;
    onProgress?.({ done, total, stage: 'Downloading model' });
  }
  // Concat
  const out = new Uint8Array(done);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function isModelCached() {
  try {
    const cached = await idbGet(MODEL_KEY);
    return !!(cached && cached.byteLength > 1_000_000);
  } catch {
    return false;
  }
}

/**
 * Delete the cached model from IndexedDB. Returns true if a model was removed.
 */
export async function clearModel() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(MODEL_KEY);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}
