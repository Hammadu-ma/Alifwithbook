# ALIF Med — Firebase Spark Plan Compatibility

This release is intentionally designed so the **core app can run on Firebase's Spark (no-cost) plan without linking a billing account**.

## Core Firebase services

- Firebase Authentication — Email/Password
- Cloud Firestore
- Firebase Hosting
- Firebase AI Logic with the Gemini Developer API
- Firebase App Check

Firebase currently lists Authentication (most options), App Check, and Hosting's no-cost tier among services available without billing, while Firestore and AI Logic have Spark no-cost usage limits. Cloud Functions and Firebase Cloud Storage require Blaze. See Firebase's current pricing documentation before enabling additional services.

## Current Spark limits that matter to ALIF

Cloud Firestore currently includes 1 GiB stored data, 50,000 document reads/day, 20,000 writes/day, 20,000 deletes/day, and 10 GiB/month outbound transfer on the free tier.

Firebase Authentication on Spark currently has a 3,000 daily active user limit for most sign-in providers; this app does not create anonymous accounts.

The Gemini Developer API can be used through Firebase AI Logic on Spark at its free tier. This release uses `gemini-3.8-flash`, which Firebase currently documents as not requiring Blaze when the Gemini Developer API is selected.

## Services deliberately excluded from the Firebase Spark deployment

- Cloud Functions for Firebase
- Firebase App Hosting
- Cloud Storage for Firebase
- Phone Authentication
- Agent Platform Gemini API / Vertex AI

## Telegram payment receipts

Automatic Telegram receipt forwarding requires a server because Spark cannot run Cloud Functions. The optional relay lives in `optional-backend/` and is ignored by Firebase Hosting. Deploy it separately only when needed, with Telegram credentials stored as server environment variables.
