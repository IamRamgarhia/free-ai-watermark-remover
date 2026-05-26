/**
 * COI bootstrap — runs BEFORE any other script.
 *
 * Goal: get window.crossOriginIsolated === true so WASM threads + WebGPU
 * work. The service worker injects COOP/COEP headers; this script ensures
 * the SW is installed AND the page is controlled by it, reloading as needed.
 *
 * Robust against:
 *   - First-ever visit (SW not yet installed)
 *   - Hard refresh (Ctrl+Shift+R bypasses SW for that load)
 *   - SW update mid-session
 *   - Browsers that can't enable COI at all (capped at 3 reload attempts)
 */

(function () {
  if (window.crossOriginIsolated) {
    console.log('[coi] ✓ Already cross-origin isolated. Multi-threading + WebGPU available.');
    sessionStorage.removeItem('coi_reload_count');
    return;
  }

  if (!('serviceWorker' in navigator)) {
    console.warn('[coi] Service workers not supported — single-threaded fallback.');
    return;
  }

  const reloadCount = parseInt(sessionStorage.getItem('coi_reload_count') || '0', 10);
  if (reloadCount >= 3) {
    console.warn('[coi] Gave up after 3 reload attempts. COI not available in this browser/setup.');
    return;
  }

  navigator.serviceWorker.register('sw.js', { scope: './' }).then(async (reg) => {
    console.log('[coi] SW registered at scope:', reg.scope);

    // Wait until an SW is "activated" (could be the existing one or a new one).
    if (!reg.active) {
      console.log('[coi] Waiting for SW to activate…');
      await new Promise((resolve) => {
        const sw = reg.installing || reg.waiting;
        if (!sw) return resolve();
        sw.addEventListener('statechange', () => {
          if (sw.state === 'activated') resolve();
        });
      });
    }

    // After hard-refresh the page may be unclaimed by the SW. Force a reload.
    if (!navigator.serviceWorker.controller) {
      sessionStorage.setItem('coi_reload_count', String(reloadCount + 1));
      console.log(`[coi] Page not controlled by SW yet — reloading (attempt ${reloadCount + 1})…`);
      window.location.reload();
      return;
    }

    // SW is controlling but COI still off → reload so navigation goes through SW.
    if (!window.crossOriginIsolated) {
      sessionStorage.setItem('coi_reload_count', String(reloadCount + 1));
      console.log(`[coi] Need reload to apply COI headers (attempt ${reloadCount + 1})…`);
      window.location.reload();
    }
  }).catch((err) => {
    console.error('[coi] SW registration failed:', err);
  });
})();
