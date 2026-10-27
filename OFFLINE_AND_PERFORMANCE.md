# Offline + fast loading

## Deploy (Vercel)
`vercel.json` runs `node tools/stamp-sw.mjs` as the build command on every Vercel deploy (Git push or `vercel --prod`).
It walks the real import graph, hashes every shell file into a BUILD id inside `sw.js`, and regenerates the
`<link rel="modulepreload">` block in `index.html`. Nothing to run by hand; never edit the generated blocks.
`vercel.json` also sets the cache headers, and `.vercelignore` keeps admin/, push-api/ and docs out of the public site.
Firestore rules are still deployed with `firebase deploy --only firestore:rules`.

## How it works
- **sw.js** precaches the whole app shell (index.html, every module, CSS, fonts, icons) as one atomic, versioned set.
  Boot is instant and works with no network. A new deploy = new BUILD = new cache downloaded in full before it takes over;
  open apps show a "new version is ready – Refresh" bar. Admin "Push update" (force-update.js) still works: it clears
  caches + the worker, and the next load re-installs everything.
- Firebase SDK / marked / DOMPurify (versioned CDN URLs) are cached on first use and pre-warmed on install.
- Firestore, Auth, push API and Telegram traffic is never intercepted.
- **Offline boot fix**: the device-registration write never settles offline, so startup used to hang on the loader.
  The allow/deny decision no longer waits for that write: offline it is skipped (the live block-watch enforces once
  data is available), online it is capped at 6 s after the decision is made. The saved student profile is reused offline.
- **Device lock**: `enforceDeviceLock` returns `{ok:false}` for a blocked device / exceeded limit instead of throwing, and
  boot + sign-in ignored that. Both now go through `assertDeviceAllowed()`, which throws `DeviceLockError`.
- **Lighter first load**: fonts + Font Awesome are self-hosted (icon font 156 KB → 17 KB subset; any icon not in the
  subset, e.g. one an admin picks for a package, falls back to the full font on demand). exam-mode (85 KB), buy-modal,
  quiz-live and legacy-migration load on demand / when idle instead of at startup. Module graph is preloaded in parallel.
  Logo shown in-page is a 9 KB WebP (was a 116 KB PNG); the missing icon.ico 404 is fixed.
