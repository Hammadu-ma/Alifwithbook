# ALIF Med — Security Architecture

## Trust boundaries

**Browser**
- Holds only Firebase Web App configuration and short-lived Firebase client state.
- Never treats localStorage, a secret key, device fingerprint, or email address as proof of identity.
- Never contains the Telegram bot token or a Gemini API key.

**Firebase Authentication**
- Owns account identity, password verification, persistence, password reset, and email verification.
- The authenticated UID is the root identity used by Firestore rules.

**Cloud Firestore**
- `users/{uid}` is the student authorization anchor.
- `admin/{uid}` is the admin role/permission anchor.
- Security Rules enforce student ownership and admin permissions.
- There is no public catch-all write rule.

**Firebase AI Logic**
- Uses the Gemini Developer API through Firebase's managed proxy/service.
- The Gemini credential is not embedded in the app source.
- Configure App Check and enforce it for AI Logic in production.

**Optional Telegram relay**
- Runs outside Firebase Spark.
- Validates the Firebase ID token server-side when deployed.
- Telegram bot secrets stay in server environment variables.

## Important compatibility note

The legacy `secretkeys` collection still carries entitlement information such as `userLocks` for compatibility. Those values are not authentication credentials. A future entitlement migration can move those grants to UID-scoped documents without changing the identity model.
