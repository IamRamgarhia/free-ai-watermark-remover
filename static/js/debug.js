/**
 * In-app debug panel. Surfaces live state and a rolling event log so the
 * user can see exactly what the app is doing — no DevTools required.
 *
 * Toggle: backtick (`) key, or floating 🪲 button.
 *
 * Usage from elsewhere:
 *   import { dbg } from './debug.js';
 *   dbg.set('backend', 'wasm');
 *   dbg.log('Remove clicked');
 *   dbg.error('Inference failed: …');
 */

import { APP_VERSION } from './version.js';

const $ = (id) => document.getElementById(id);

const els = {
  toggle: $('debug-toggle'),
  panel:  $('debug-panel'),
  close:  $('debug-close'),
  log:    $('dbg-log'),
};

const rows = {
  version:  $('dbg-version'),
  coi:      $('dbg-coi'),
  backend:  $('dbg-backend'),
  threads:  $('dbg-threads'),
  model:    $('dbg-model'),
  ready:    $('dbg-ready'),
  file:     $('dbg-file'),
  filetype: $('dbg-filetype'),
  dims:     $('dbg-dims'),
  coverage: $('dbg-coverage'),
  tool:     $('dbg-tool'),
  quality:  $('dbg-quality'),
  removes:  $('dbg-removes'),
  action:   $('dbg-action'),
  error:    $('dbg-error'),
};

const logBuffer = [];
const MAX_LOG = 200;

function show() { els.panel?.removeAttribute('hidden'); }
function hide() { els.panel?.setAttribute('hidden', ''); }
function isOpen() { return !!els.panel && !els.panel.hasAttribute('hidden'); }
function toggle() {
  if (!els.panel) return;
  if (els.panel.hasAttribute('hidden')) show();
  else hide();
}

function pushLog(msg, kind = 'info') {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${kind === 'error' ? '✗' : kind === 'warn' ? '⚠' : '·'} ${msg}`;
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG) logBuffer.shift();
  if (els.log) {
    els.log.textContent = logBuffer.slice(-50).join('\n');
    els.log.scrollTop = els.log.scrollHeight;
  }
}

function setRow(key, value, cls = '') {
  const el = rows[key];
  if (!el) return;
  el.textContent = value;
  el.className = cls;
}

export const dbg = {
  set: setRow,
  log:  (msg)       => { pushLog(msg, 'info');  setRow('action', msg, ''); },
  warn: (msg)       => { pushLog(msg, 'warn');  setRow('action', msg, 'warn'); },
  error: (msg)      => { pushLog(msg, 'error'); setRow('error', msg, 'error'); },
  setIfChanged(key, value, cls) {
    const el = rows[key];
    if (el && el.textContent !== String(value)) setRow(key, value, cls);
  },
  show, hide, toggle, isOpen,
};

// Wire up toggle + close
els.toggle?.addEventListener('click', toggle);
els.close?.addEventListener('click', hide);

// Backtick toggles
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t?.matches?.('input, textarea, select')) return;
  if (e.key === '`') {
    e.preventDefault();
    toggle();
  }
});

// Initial state
setRow('version', APP_VERSION);
setRow('coi', window.crossOriginIsolated ? 'YES' : 'no', window.crossOriginIsolated ? 'ok' : 'warn');
setRow('threads', String(navigator.hardwareConcurrency || 1));

// Force-run / fill-mask / copy buttons — wired from app.js via custom events
function emit(name) {
  document.dispatchEvent(new CustomEvent('dbg:' + name));
}
$('dbg-force-remove')?.addEventListener('click', () => emit('force-remove'));
$('dbg-fill-mask')?.addEventListener('click', () => emit('fill-mask'));
$('dbg-copy')?.addEventListener('click', async () => {
  const snapshot = {};
  for (const [k, el] of Object.entries(rows)) snapshot[k] = el?.textContent;
  snapshot.log = logBuffer.slice(-30);
  try {
    await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
    dbg.log('Debug state copied to clipboard');
  } catch (e) {
    dbg.error('Could not copy: ' + e.message);
  }
});

// Auto-open the panel if URL has ?debug
if (new URLSearchParams(location.search).get('debug') !== null) show();
