/**
 * Static consistency checks for the static/ site.
 *
 * Run:  node tools/check.mjs
 *
 * There is no build step and no bundler, so nothing otherwise notices when
 * these drift apart. Each check below exists because the corresponding bug was
 * actually present in this repo at some point:
 *
 *   - version strings in four places silently disagreeing
 *   - the service worker precache missing assets the pages reference
 *     (installed PWA + offline = broken images)
 *   - a repo rename leaving dead links behind
 *   - js/ modules not listed in the SW app shell (so offline load fails)
 *   - getElementById() pointing at markup that was never added
 *     (the whole debug panel was dead this way)
 *   - third-party <script src> without Subresource Integrity
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = join(ROOT, 'static');

const problems = [];
const notes = [];
function fail(check, msg) { problems.push(`${check}: ${msg}`); }
function ok(check, msg) { notes.push(`${check}: ${msg}`); }

const read = (p) => readFileSync(join(STATIC, p), 'utf8');

const indexHtml = read('index.html');
const aboutHtml = read('about.html');
const swJs      = read('sw.js');
const versionJs = read('js/version.js');
const manifest  = JSON.parse(read('manifest.webmanifest'));

// === 1. Version sync ========================================================
{
  const appVersion = versionJs.match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
  if (!appVersion) {
    fail('version', 'could not parse APP_VERSION from js/version.js');
  } else {
    const cacheVersion = swJs.match(/CACHE_VERSION\s*=\s*'watermarkout-v([^']+)'/)?.[1];
    if (cacheVersion !== appVersion) {
      fail('version', `sw.js CACHE_VERSION is v${cacheVersion}, expected v${appVersion}`);
    }
    const jsonLd = indexHtml.match(/"softwareVersion":\s*"([^"]+)"/)?.[1];
    if (jsonLd !== appVersion) {
      fail('version', `index.html JSON-LD softwareVersion is ${jsonLd}, expected ${appVersion}`);
    }
    const badge = indexHtml.match(/id="version-badge">v([^<]+)</)?.[1];
    if (badge !== appVersion) {
      fail('version', `index.html version badge is v${badge}, expected v${appVersion}`);
    }
    if (problems.length === 0) ok('version', `all sources agree on v${appVersion}`);
  }
}

// === 2. Every js/ module is in the SW app shell =============================
{
  const modules = readdirSync(join(STATIC, 'js')).filter(f => f.endsWith('.js'));
  const missing = modules.filter(m => !swJs.includes(`./js/${m}`));
  if (missing.length) {
    fail('sw-precache', `js modules missing from APP_SHELL: ${missing.join(', ')}`);
  } else {
    ok('sw-precache', `all ${modules.length} js modules are precached`);
  }
}

// === 3. Local assets referenced by HTML/CSS/manifest are precached ==========
{
  const sources = {
    'index.html': indexHtml,
    'about.html': aboutHtml,
    'css/app.css': read('css/app.css'),
    'css/about.css': read('css/about.css'),
  };

  const referenced = new Set();
  for (const text of Object.values(sources)) {
    // src="assets/…" / href="assets/…" / url(assets/…)
    for (const m of text.matchAll(/(?:src|href)="(assets\/[^"?#]+)"/g)) referenced.add(m[1]);
    for (const m of text.matchAll(/url\(['"]?(assets\/[^'")?#]+)/g)) referenced.add(m[1]);
  }
  for (const icon of manifest.icons || []) referenced.add(icon.src);
  for (const sc of manifest.shortcuts || []) {
    for (const icon of sc.icons || []) referenced.add(icon.src);
  }

  const notOnDisk = [...referenced].filter(a => !existsSync(join(STATIC, a)));
  const notCached = [...referenced].filter(a => !swJs.includes(`./${a}`));

  if (notOnDisk.length) {
    // A missing asset is only a warning when the page has a coded fallback;
    // prince-avatar.png is optional by design (about.html falls back to the logo).
    const hard = notOnDisk.filter(a => !a.includes('prince-avatar'));
    if (hard.length) fail('assets', `referenced but not on disk: ${hard.join(', ')}`);
    else ok('assets', 'only the optional avatar is absent (about.html falls back locally)');
  }
  if (notCached.length) {
    const hard = notCached.filter(a => !a.includes('prince-avatar'));
    if (hard.length) fail('sw-precache', `assets referenced but not in APP_SHELL: ${hard.join(', ')}`);
  } else {
    ok('sw-precache', `all ${referenced.size} referenced assets are precached`);
  }
}

// === 4. No stale repo links =================================================
{
  const STALE = 'IamRamgarhia/watermarkout';
  const hits = [];
  const scan = (label, text) => { if (text.includes(STALE)) hits.push(label); };
  scan('index.html', indexHtml);
  scan('about.html', aboutHtml);
  for (const f of readdirSync(join(STATIC, 'js'))) {
    if (f.endsWith('.js')) scan(`js/${f}`, read(`js/${f}`));
  }
  if (hits.length) fail('links', `stale repo path "${STALE}" in: ${hits.join(', ')}`);
  else ok('links', 'no stale repo paths');
}

// === 5. Third-party scripts carry Subresource Integrity =====================
{
  const bad = [];
  for (const [label, text] of [['index.html', indexHtml], ['about.html', aboutHtml]]) {
    for (const m of text.matchAll(/<script\b[^>]*\bsrc="(https?:\/\/[^"]+)"[^>]*>/g)) {
      if (!m[0].includes('integrity=')) bad.push(`${label} → ${m[1]}`);
    }
  }
  if (bad.length) fail('sri', `external script without integrity: ${bad.join(', ')}`);
  else ok('sri', 'all external scripts pin an integrity hash');
}

// === 6. Model integrity hash is pinned ======================================
{
  const modelCache = read('js/model-cache.js');
  const sha = modelCache.match(/MODEL_SHA256\s*=\s*'([a-f0-9]{64})'/)?.[1];
  if (!sha) fail('model-integrity', 'MODEL_SHA256 is not set to a 64-char hex digest');
  else ok('model-integrity', `model pinned to ${sha.slice(0, 12)}…`);
}

// === 7. getElementById targets exist in the markup ==========================
{
  // Collect every id defined in either page.
  const ids = new Set();
  for (const text of [indexHtml, aboutHtml]) {
    for (const m of text.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  }

  // IDs created at runtime rather than authored in HTML.
  const DYNAMIC = new Set(['output-format-label']);

  const missing = [];
  for (const f of readdirSync(join(STATIC, 'js'))) {
    if (!f.endsWith('.js')) continue;
    const text = read(`js/${f}`);
    for (const m of text.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) {
      const id = m[1];
      if (!ids.has(id) && !DYNAMIC.has(id)) missing.push(`js/${f} → #${id}`);
    }
    for (const m of text.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) {
      const id = m[1];
      if (!ids.has(id) && !DYNAMIC.has(id)) missing.push(`js/${f} → #${id}`);
    }
  }
  if (missing.length) {
    fail('dom-ids', `referenced but not present in any HTML:\n    ${missing.join('\n    ')}`);
  } else {
    ok('dom-ids', `all getElementById targets exist (${ids.size} ids defined)`);
  }
}

// === Report =================================================================
console.log('');
for (const n of notes) console.log(`  ✓ ${n}`);
if (problems.length) {
  console.log('');
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log(`\n✗ ${problems.length} problem(s) found.\n`);
  process.exit(1);
}
console.log(`\n✓ All checks passed.\n`);
