# ALIF Med — Secure Firebase Authentication Migration

This release replaces the legacy secret-key login with Firebase Authentication.

## Identity

- Firebase Authentication Email/Password is the only account credential.
- `users/{uid}` is the authorization/profile anchor.
- `secretkeys/{studentId}` remains only as a legacy student/entitlement record.
- Local storage is a display/cache layer and is never trusted for authentication.
- Anonymous Firebase Authentication is not created by this application.

## Spark deployment

The core release is designed for the Firebase Spark plan:

- Authentication
- Firestore
- Firebase Hosting
- Firebase AI Logic using the Gemini Developer API free tier
- App Check

It does not require Cloud Functions, App Hosting, Firebase Cloud Storage, Phone Auth, or the Agent Platform Gemini API.

## First-time setup

1. Firebase Console → Authentication → Sign-in method → enable Email/Password.
2. Deploy `firestore.rules` before allowing production writes.
3. Create the first admin account in Firebase Authentication.
4. Create `admin/{uid}` with `role: "owner"` and the desired permissions.
5. For every existing student, create/link Firebase Auth and set `secretkeys/{studentId}.authUid` to that UID; verify `users/{uid}.studentId` matches.
6. Delete/clear any old secret/password values after migration.
7. Add only the real production domains to Authentication's authorized domains.

## Email verification

The app sends verification mail after registration and supports password reset. Firebase's email verification and password-reset quotas apply on Spark.

## AI tutor on Spark

The AI tutor now uses Firebase AI Logic directly in the browser with the Gemini Developer API backend. It uses `gemini-3.8-flash` and does not require a Gemini API key in application source. Configure Firebase AI Logic in the console and configure production App Check for the web app.

## Telegram receipts

Firebase Spark cannot execute Cloud Functions and Firebase Cloud Storage requires Blaze. Automatic Telegram receipt forwarding is therefore optional and external.

The optional `optional-backend/api/telegram-receipt.js` can be deployed separately on a server platform such as Vercel. Its Telegram bot credentials must remain server-side. Firebase Hosting ignores `optional-backend/**`.
