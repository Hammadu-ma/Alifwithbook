/* ========================================================================
   ALIF Med — Firebase client bootstrap

   IMPORTANT:
   Firebase SDK primitives are imported directly from Google's official ESM
   builds here. The authentication/config layer must not depend on the local
   vendor re-export file because stale service-worker/browser copies of that
   file can create misleading "does not provide an export" module errors.
   ======================================================================== */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

export const firebaseConfig = {
  apiKey: "AIzaSyBXFcbQlTB1mXBsHd_bxnHdgS7dmHK_x3k",
  authDomain: "exam-d9415.firebaseapp.com",
  projectId: "exam-d9415",
  storageBucket: "exam-d9415.firebasestorage.app",
  messagingSenderId: "258742955197",
  appId: "1:258742955197:web:a8e6a179f9e7c23c5b5bd4"
};

export const CONFIG_READY = firebaseConfig.apiKey && firebaseConfig.apiKey !== 'YOUR_API_KEY';
export let app = null;
export let db = null;

if (CONFIG_READY) {
  app = initializeApp(firebaseConfig);
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
      })
    });
  } catch (e) {
    // Private browsing / restricted IndexedDB environments should still boot.
    db = getFirestore(app);
  }
} else {
  const note = document.getElementById('setupNote');
  if (note) {
    note.classList.remove('hidden');
    note.innerHTML = "Firebase isn't configured yet. Open <b>menus/firebase-config.js</b> and add your Firebase web app configuration.";
  }
}
