# ALIF — Firestore read-cost optimization

1. **Zero-read content invalidation.** Admin mirrors the content stamp (`cv`/`cq`) onto `settings/appVersion`, which
   every student app already listens to. `loaders.js` uses it instead of polling `settings/contentVersion`, and while
   the stamp is live, catalog cache lives 3 days and question banks 7 days (they re-download only when the admin
   changes content). Falls back to the old 6h/12h + polling behaviour if the stamp is absent.
2. **Chat unread tracking.** Community listener: `limit(50)` -> only messages newer than the student's last-seen
   time, `limit(12)` (badge caps at 9+). Chat/access listeners detach after 2-3 min in the background and re-attach on return.
3. **Profile + buy screens.** `packages`/`modules` (6h, cleared on content change), bank accounts, Telegram and pricing
   settings are TTL-cached (`menus/read-cache.js`).
4. **Admin.** One-time stamp bootstrap per browser; login-events view 2000 -> 600 docs.
5. **Rules.** Content admins may write only `cv`/`cq` on `settings/appVersion`.

Deploy rules + hosting. First admin sign-in after deploy publishes the initial stamps (students re-download once).
