# ALIF Med — Firebase Spark secure auth + unified access + just-in-time migration

This build contains the student app, admin dashboard, UID-based entitlement model, and the one-time existing-student migration flow.

### Existing students

On the same browser where an old ALIF student session exists, the first launch shows **Secure your ALIF account**. The student enters an email and password; the app automatically links the old student record to the new Firebase UID and reconstructs the student's existing module, subject, quiz, program and bundle access.

No manual admin linking is required for the normal migration path.

### Safety

The old secret key is never used as the new password and is never kept in the new browser session. It is used only as a one-time migration proof by a Firestore Rule that verifies it against the legacy student document.

### Firebase Spark

The core app requires Firebase Authentication, Firestore and static hosting. The migration is client-driven and does not require Cloud Functions.


## Zero-cost notifications

The app now includes a Firestore-only notification system:
- Admins can publish announcements from **Admin → Notifications**.
- Notifications can target all students or one active Student ID.
- Students receive new notifications in real time while the app is open.
- Students can enable native browser notifications from the bell panel.
- No Firebase Cloud Messaging, Cloud Functions, or other paid Firebase backend is used.

Important: Firestore-only client listeners cannot deliver a notification after the browser/app has been completely closed. True background Web Push requires a push service/relay (such as FCM or a separate Web Push backend). This build deliberately does not add that cost or dependency.
