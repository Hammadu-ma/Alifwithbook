/* Shared Firebase client. Keeping one app instance is important: every
   Firestore request now carries the same Firebase Authentication session. */
export { db, CONFIG_READY } from './firebase-config.js';
