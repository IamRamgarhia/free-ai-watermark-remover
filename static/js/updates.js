/**
 * Service Worker registration + update banner.
 * When a new SW takes control, show a banner to reload.
 */

import { toast } from './toast.js';

const banner = document.getElementById('update-banner');
const reloadBtn = document.getElementById('btn-update');
const dismissBtn = document.getElementById('btn-update-dismiss');

let waitingWorker = null;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.log('[updates] Service Workers not supported');
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    console.log('[updates] SW registered:', reg.scope);

    // If there's already a waiting worker, show banner immediately
    if (reg.waiting) showBanner(reg.waiting);

    // Listen for new installations
    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      if (!newSW) return;
      newSW.addEventListener('statechange', () => {
        if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
          showBanner(newSW);
        }
      });
    });

    // When the active SW changes (because the user clicked reload), refresh
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    // Periodically check for updates (every hour while app is open)
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);

    return reg;
  } catch (e) {
    console.warn('[updates] SW registration failed:', e);
    return null;
  }
}

function showBanner(sw) {
  waitingWorker = sw;
  if (banner) banner.hidden = false;
}

if (reloadBtn) {
  reloadBtn.addEventListener('click', () => {
    if (!waitingWorker) {
      window.location.reload();
      return;
    }
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    // The controllerchange listener above will trigger the reload.
    toast('Updating to the latest version…', 'info');
  });
}

if (dismissBtn) {
  dismissBtn.addEventListener('click', () => {
    if (banner) banner.hidden = true;
  });
}
