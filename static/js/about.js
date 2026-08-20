/**
 * About page behaviour.
 *
 * Deliberately an external module rather than an inline <script>: about.html
 * ships a strict `script-src 'self'` CSP, which blocks inline execution
 * outright (no 'unsafe-inline', no hashes to keep in sync).
 */

import { APP_VERSION } from './version.js';

// Keep the version badge in sync with version.js (the single source of truth).
const badge = document.getElementById('version-badge');
if (badge) badge.textContent = `v${APP_VERSION}`;

// The maker's avatar is optional — fall back to the app logo if it's absent.
// The fallback stays LOCAL on purpose: pulling an avatar from an external host
// would fire an outbound request on every About view, contradicting the
// "network tab is empty after first load" claim the page makes.
//
// Module scripts are deferred, so the image has usually already failed by the
// time this runs — check the settled state as well as listening for `error`.
const avatar = document.getElementById('creator-avatar');
if (avatar) {
  const useFallback = () => { avatar.src = 'assets/logo-icon.svg'; };
  avatar.addEventListener('error', useFallback, { once: true });
  if (avatar.complete && avatar.naturalWidth === 0) useFallback();
}
