/**
 * File System Access API integration.
 *
 * Lets the user pick ONE folder on their disk. The app then:
 *   - Saves the AI model file there (instead of IndexedDB)
 *   - Auto-saves output images / videos there
 *   - Survives browser data clearing — only that folder is the source of truth
 *
 * Browser support:
 *   - Chrome/Edge:         ✓ full support
 *   - Opera/Brave/Arc/etc: ✓ (Chromium-based)
 *   - Firefox/Safari/iOS:  ✗ not supported → callers fall back to IndexedDB + browser download dialogs
 *
 * Permissions:
 *   - User explicitly picks a folder once
 *   - On every browser RESTART, we need to re-request permission (browser security policy)
 *   - We persist the folder HANDLE in IndexedDB so we remember which folder it was
 */

const DB_NAME = 'watermarkout-fs';
const DB_VERSION = 1;
const STORE = 'handles';
const FOLDER_KEY = 'root-folder';

export function isSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

// === IndexedDB helpers for storing the folder handle ===
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
}
async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}
async function idbDel(key) {
  const db = await openDB();
  return new Promise((res) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
    req.onsuccess = () => res(true);
    req.onerror = () => res(false);
  });
}

// === Permission helpers ===
async function verifyPermission(handle, mode = 'readwrite') {
  if (!handle?.queryPermission) return false;
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  if ((await handle.requestPermission({ mode })) === 'granted') return true;
  return false;
}

// === Public API ===

/**
 * Prompt user to pick a folder. Returns the handle on success, null if they canceled.
 */
export async function pickFolder() {
  if (!isSupported()) {
    throw new Error('Your browser doesn\'t support local folder access. Use Chrome or Edge for this feature.');
  }
  try {
    const handle = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'documents',
      id: 'watermarkout-data',
    });
    await idbSet(FOLDER_KEY, handle);
    return handle;
  } catch (e) {
    // User canceled the picker
    if (e.name === 'AbortError') return null;
    throw e;
  }
}

/**
 * Get the previously-picked folder handle, re-requesting permission as needed.
 * Returns null if no folder was ever picked, or if user denied re-permission.
 */
export async function getActiveFolder() {
  if (!isSupported()) return null;
  const handle = await idbGet(FOLDER_KEY);
  if (!handle) return null;
  const ok = await verifyPermission(handle, 'readwrite');
  return ok ? handle : null;
}

/**
 * Clear the saved folder choice. The actual folder on disk is untouched.
 */
export async function forgetFolder() {
  await idbDel(FOLDER_KEY);
}

/**
 * Write bytes to a file in the active folder. Returns the FileSystemFileHandle.
 */
export async function writeFile(folderHandle, filename, blob) {
  const fileHandle = await folderHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return fileHandle;
}

/**
 * Read a file from the active folder. Returns null if file doesn't exist.
 */
export async function readFile(folderHandle, filename) {
  try {
    const fileHandle = await folderHandle.getFileHandle(filename, { create: false });
    return await fileHandle.getFile();
  } catch (e) {
    if (e.name === 'NotFoundError') return null;
    throw e;
  }
}

/**
 * Convenience: write a Uint8Array as a file with a given name.
 */
export async function saveBlob(folderHandle, filename, blob) {
  return writeFile(folderHandle, filename, blob);
}

/**
 * Try to read folder name for display (returns the human-readable name).
 */
export function getFolderName(handle) {
  return handle?.name || 'Unknown folder';
}
