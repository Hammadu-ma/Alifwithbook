# ALIF Web Push — zero Firestore notification reads

This version does **not** use a Firestore notifications collection or realtime listener.

Architecture:

Student browser -> Web Push subscription -> external push API -> browser service worker -> notification

Firebase is used only for the student's existing Authentication ID token. No Firestore notification reads/writes are used.

## 1. Create the Supabase table

Run `push-api/schema.sql` in the Supabase SQL Editor.

## 2. Generate VAPID keys

From the `push-api` directory:

```bash
npm install
node generate-vapid.mjs
```

Keep the private key secret. Put only the public key into `push-config.js`. The private key belongs only in the server environment variable `VAPID_PRIVATE_KEY`.

## 3. Deploy `push-api` to Vercel

Import the `push-api` folder as a separate Vercel project.

Set these Vercel environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `VAPID_SUBJECT` (for example `mailto:admin@yourdomain.com`)
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `ADMIN_UIDS` (comma-separated admin Firebase UIDs)
- `ALIF_APP_ORIGIN` (your Firebase Hosting origin)

The service-account JSON is only on Vercel; never put it in the ALIF frontend.

## 4. Admin authorization

Set the Vercel env var `ADMIN_UIDS` to a comma-separated list of the Firebase Auth UIDs allowed to send
(find a UID in Firebase Console -> Authentication). No Firestore read is used to check this.
A Firebase custom claim `isAdmin: true` also works.

## 5. Configure the ALIF frontend

Edit `push-config.js`:

```js
window.ALIF_PUSH_API_BASE = 'https://YOUR-PUSH-API.vercel.app';
window.ALIF_VAPID_PUBLIC_KEY = 'YOUR_PUBLIC_VAPID_KEY';
```

Then deploy ALIF Hosting normally.

## 6. Student setup

A student opens ALIF, signs in, taps the notification bell, and chooses **Enable alerts**. The browser creates a Web Push subscription and sends it to the external API.

The subscription is stored in Supabase, not Firestore.

## 7. Send

Admin -> Notifications -> compose -> Send notification.

Pick **All students** or **One student** (enter the Student ID; this costs one Firestore read). The API pages through subscriptions and sends 50 at a time, so large audiences work. If the 60s limit is reached the result says so; send again to reach the rest.

Expired subscriptions are automatically removed when the push provider returns 404/410.

## Cost model

There is no Firestore notification listener, notification query, or notification document. Firestore therefore has **0 notification reads** from this feature.

The external Vercel/Supabase services are subject to their own free-tier limits. This architecture specifically makes the **Firebase/Firestore notification cost zero**; it does not promise unlimited free usage of third-party infrastructure.

## Logout and shared devices
Signing out removes that device's subscription from the server, and the student taps **Enable alerts** again after the next login.

## iPhone / iPad
iOS only delivers web push to ALIF installed via Share -> Add to Home Screen (iOS 16.4+). `manifest.webmanifest` is included for this.

## Admin file
`adu.html` (deployed) and `admin/ALIF_Med_Admin.html` now both include the Notifications tab. `admin-notifications.js` exists at the project root (deployed) and in `admin/`.
