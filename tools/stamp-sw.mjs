#!/usr/bin/env node
/* =========================================================================
   tools/stamp-sw.mjs — build step for the offline app shell.

   Runs automatically before `firebase deploy` (firebase.json -> hosting.predeploy)
   and can be run by hand:   node tools/stamp-sw.mjs

   What it does (idempotent, no dependencies):
   1. Walks the real import graph from menus/main.js, so only files the app
      actually uses are precached (unused files like access-admin.js are skipped).
   2. Computes BUILD = hash of every shipped shell file. Any change => new BUILD
      => sw.js bytes change => browsers install the new worker and download the
      new shell atomically.
   3. Rewrites the marked blocks in sw.js (BUILD, SHELL, SOFT, THIRD_PARTY).
   4. Rewrites the <!--PRELOAD_START-->…<!--PRELOAD_END--> block in index.html
      with <link rel="modulepreload"> tags for the *statically* imported modules,
      so the browser downloads the whole module graph in parallel instead of
      discovering it one import at a time.
   ========================================================================= */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p));
const text = p => read(p).toString('utf8');

/* ---------- 1. import graph ---------- */
const staticDeps = new Map();   // file -> Set(static deps)
const dynDeps = new Map();      // file -> Set(dynamic deps)
const external = new Set();

function scan(file) {
  if (staticDeps.has(file)) return;
  if (!existsSync(join(ROOT, file))) throw new Error('Missing module: ' + file);
  const src = text(file);
  const s = new Set(), d = new Set();
  staticDeps.set(file, s); dynDeps.set(file, d);
  const rel = spec => posix.normalize(posix.join(posix.dirname(file), spec));
  for (const m of src.matchAll(/(?:^|[;}\s])(?:import|export)\s*(?:[^"'`;]*?\bfrom\s*|\s*)["'](\.{1,2}\/[^"']+\.js)["']/g)) s.add(rel(m[1]));
  for (const m of src.matchAll(/import\(\s*["'](\.{1,2}\/[^"']+\.js)["']\s*\)/g)) d.add(rel(m[1]));
  for (const m of src.matchAll(/["'](https:\/\/(?:www\.gstatic\.com\/firebasejs|cdn\.jsdelivr\.net\/npm)\/[^"'`\s]+\.m?js)["']/g)) external.add(m[1]);
  [...s, ...d].forEach(scan);
}
scan('menus/main.js');

// Everything reachable (static or dynamic) is precached; only the static closure is modulepreloaded.
const allModules = [...staticDeps.keys()].sort();
const staticClosure = new Set();
(function walk(f) { if (staticClosure.has(f)) return; staticClosure.add(f); staticDeps.get(f).forEach(walk); })('menus/main.js');

/* ---------- 2. shell file list ---------- */
const html = text('index.html');
const refs = new Set();
for (const m of html.matchAll(/(?:src|href)=["']\/?((?!https?:|\/\/|#|data:)[^"'?#]+\.(?:js|css|png|webp|ico|webmanifest|woff2))["']/g)) refs.add(m[1]);
const fontCss = text('assets/ui-fonts.css');
const fontFiles = [...new Set([...fontCss.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map(m => 'assets/' + m[1]))];

const core = new Set(['index.html', ...allModules]);
for (const r of refs) if (!r.endsWith('.png') && !r.endsWith('.webp') && !r.endsWith('.ico') && !r.endsWith('.woff2')) core.add(r);
const soft = new Set([...refs].filter(r => !core.has(r)));
// Fonts needed to render the UI at all are "soft" (never block an update). The big full-glyph icon fallbacks are not precached.
for (const f of fontFiles) if (!/fa-(solid-900|brands-400)\.woff2$/.test(f)) soft.add(f);
['logo.png', 'logo-360.webp', 'icon.ico', 'manifest.webmanifest'].forEach(f => { if (existsSync(join(ROOT, f))) soft.add(f); });
for (const f of core) if (!existsSync(join(ROOT, f))) throw new Error('Referenced file does not exist: ' + f);
for (const f of [...soft]) if (!existsSync(join(ROOT, f))) { console.warn('[stamp-sw] skipping missing optional file: ' + f); soft.delete(f); }

/* ---------- 3. BUILD hash ---------- */
const h = createHash('sha256');
for (const f of [...core, ...soft].sort()) {
  h.update(f);
  // index.html is hashed without the generated preload block so repeated runs give the same BUILD.
  h.update(f === 'index.html' ? Buffer.from(text(f).replace(/<!--PRELOAD_START-->[\s\S]*?<!--PRELOAD_END-->/, '')) : read(f));
}
const BUILD = h.digest('hex').slice(0, 12);

const toUrl = f => '/' + f.replace(/^\//, '');
const list = arr => '[\n' + [...arr].sort().map(f => '  ' + JSON.stringify(toUrl(f))).join(',\n') + '\n]';
const third = [...external].filter(u => !/firebase-ai\.js$/.test(u)).sort();   // firebase-ai only loads on demand

let sw = text('sw.js');
sw = sw.replace(/const BUILD = '[^']*';/, `const BUILD = '${BUILD}';`);
sw = sw.replace(/\/\*SHELL_START\*\/[\s\S]*?\/\*SHELL_END\*\//,
  `/*SHELL_START*/\nconst SHELL = ${list(core)};\nconst SOFT = ${list(soft)};\nconst THIRD_PARTY = ${JSON.stringify(third, null, 2)};\n/*SHELL_END*/`);
writeFileSync(join(ROOT, 'sw.js'), sw);

/* ---------- 4. modulepreload block ---------- */
const preload = [
  ...[...staticClosure].filter(f => f !== 'menus/main.js').sort().map(f => `  <link rel="modulepreload" href="${f}">`),
  ...third.filter(u => /firebase-(app|firestore|auth)\.js$/.test(u) || /marked|purify/.test(u)).map(u => `  <link rel="modulepreload" href="${u}" crossorigin>`)
].join('\n');
let idx = html;
if (!/<!--PRELOAD_START-->[\s\S]*?<!--PRELOAD_END-->/.test(idx)) throw new Error('index.html is missing the PRELOAD markers');
idx = idx.replace(/<!--PRELOAD_START-->[\s\S]*?<!--PRELOAD_END-->/, `<!--PRELOAD_START-->\n${preload}\n  <!--PRELOAD_END-->`);
if (idx !== html) writeFileSync(join(ROOT, 'index.html'), idx);

console.log(`[stamp-sw] BUILD ${BUILD} · ${core.size} core + ${soft.size} soft files · ${staticClosure.size - 1} modules preloaded · ${third.length} CDN modules`);
