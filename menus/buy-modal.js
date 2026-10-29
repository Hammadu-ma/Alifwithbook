/* ============================================================================
   buy-modal.js — "Buy this offer" flow (manual bank-transfer verification)

   IMPORTANT: this is an ES module (loaded with <script type="module">) since
   it talks to Firebase directly using the same modular v10 SDK the rest of
   the app uses. It initializes its OWN Firebase app instance — safe to do
   alongside the app's own instance, Firebase allows multiple named apps,
   and this only ever reads/writes collections this file owns
   (paymentSubmissions) or reads price fields from (modules/subjects/quizzes).

   WHAT THIS DOES
   - Watches the existing Package (Exclusive Offer) details overlay
     (#packageOverlayCard) and, whenever it renders, injects a "Buy" button
     next to "View this offer's quizzes" (.pkd-cta-btn) — but only if the
     student doesn't already own it (i.e. the button still has the `locked`
     class).
   - Intercepts taps on ANY locked card — bundles, modules, subjects,
     quizzes, pills — and shows an overlay that reuses the app's own
     `.lock-overlay` CSS classes (identical icon pop/float animation), with
     a Buy button that opens the payment modal for that specific item.
   - Price shown for a locked bundle card comes straight from its own
     `.pk-price-now` element (already authored per-package). Price for a
     locked module/subject/quiz card is looked up live from Firestore.
   - On submit: uploads the receipt to Telegram, then writes a Firestore doc
     to `paymentSubmissions/{autoId}` with the item info, sender name,
     telegram file id, and student identity. Status starts as "pending".

   LIMITATION — name-based matching
   The rest of the app bundle is obfuscated, so this script can only read
   what's already in the rendered DOM (names, not Firestore doc IDs).

   ============================================================================
   INTEGRATION
   ============================================================================
   In index.html, this must be loaded as a module:

     <script type="module" src="menus/buy-modal.js"></script>
   ============================================================================ */

import {
  collection, query, where, orderBy, limit, getDocs, getDoc, doc,
  collectionGroup, addDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getStoredStudent } from './auth.js';
import { ttlRead, dropRead } from './read-cache.js';
// Use the app's already-authenticated Firestore. The old separate 'buyModal' app never signed in,
// so every request arrived unauthenticated and the security rules rejected it.
import { db } from './firebase-config.js';
import { getAuthUidAsync } from './anon-auth.js';

// ============================================================================
// CONFIG
// ============================================================================
const CONFIG = {
  bankNote: 'Send the exact amount shown above to one of the accounts, then upload your receipt.',
  firestoreCollection: 'paymentSubmissions',
};

// ============================================================================
// BANK ACCOUNTS
// ============================================================================
let BANK_ACCOUNTS = null;
let BANK_ACCOUNTS_PROMISE = null;
let selectedBankAccountId = null;

async function getBankAccounts() {
  if (BANK_ACCOUNTS) return BANK_ACCOUNTS;
  if (!BANK_ACCOUNTS_PROMISE) {
    BANK_ACCOUNTS_PROMISE = (async () => {
      try {
        BANK_ACCOUNTS = await ttlRead('bank_accounts', 6 * 36e5, async () => {
          const snap = await getDocs(query(collection(db, 'bankAccounts'), orderBy('order', 'asc')));
          return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        });
      } catch (e) {
        BANK_ACCOUNTS = [];
      }
      return BANK_ACCOUNTS;
    })();
  }
  return BANK_ACCOUNTS_PROMISE;
}

// ============================================================================
// TELEGRAM
// ============================================================================
let TELEGRAM_SETTINGS_PROMISE = null;
async function getTelegramSettings() {
  if (!TELEGRAM_SETTINGS_PROMISE) {
    TELEGRAM_SETTINGS_PROMISE = (async () => {
      try {
        const cfg = await ttlRead('telegram_settings', 6 * 36e5, async () => {
          const snap = await getDoc(doc(db, 'settings', 'telegram'));
          return snap.exists() ? snap.data() : {};
        });
        // never keep an empty/incomplete config cached, so an admin-side fix applies immediately
        if (!cfg || !cfg.botToken || !cfg.chatId) dropRead('telegram_settings');
        return cfg || {};
      } catch (e) {
        return {};
      }
    })();
  }
  return TELEGRAM_SETTINGS_PROMISE;
}

async function sendReceiptToTelegram({ offer, senderName, file, student, bankAccount }) {
  const settings = await getTelegramSettings();
  if (!settings.botToken || !settings.chatId) {
    throw new Error('Telegram is not configured yet.');
  }

  const submittedAt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Addis_Ababa',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());

  const studentId = student.studentId || student.ID || student.studentID || 'Not available';
  const lines = [
    `\uD83E\uDE99 New payment submission`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Program: ${offer.name || '—'}`,
    `Type: ${offer.type || 'package'}`,
    `Amount: ${offer.price || '—'}`,
    `Bank: ${bankAccount?.bankName || '—'}`,
    `Account holder: ${bankAccount?.accountName || '—'}`,
    `Account: ${bankAccount?.accountNumber || '—'}`,
    `Sender name: ${senderName || '—'}`,
    `Student name: ${student.name || 'Unknown'}`,
    `Student ID: ${studentId}`,
    student.batch ? `Batch: ${student.batch}` : null,
    student.email ? `Email: ${student.email}` : null,
    `Status: Pending review`,
    `Submitted: ${submittedAt}`,
    `Receipt: ${file?.name || 'receipt image'}`,
  ].filter(Boolean).join('\n');

  const form = new FormData();
  form.append('chat_id', settings.chatId);
  form.append('caption', lines);
  form.append('photo', file, file.name || 'receipt.jpg');

  const res = await fetch(`https://api.telegram.org/bot${settings.botToken}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Telegram rejected the upload');

  const photos = data.result && data.result.photo;
  const largest = photos && photos.length ? photos[photos.length - 1] : null;
  return {
    telegramFileId: largest ? largest.file_id : null,
    telegramMessageId: data.result ? data.result.message_id : null,
  };
}

// ============================================================================
// STUDENT IDENTITY
// ============================================================================
function getCurrentStudent() {
  try {
    const stored = getStoredStudent();
    if (stored && (stored.id || stored.docId)) {
      return {
        // Internal record key — keep this for Firestore access/pending lookups.
        id: stored.id || stored.docId,
        // Human-facing student ID from the admin's `ID` field. Never send the
        // internal Firestore document id to Telegram as the student's ID.
        studentId: stored.ID || stored.studentId || stored.studentID || null,
        name: stored.name || null,
        batch: stored.batch || null,
        email: stored.email || null,
        guest: !!stored.guest,
      };
    }
    if (window.currentStudent && (window.currentStudent.id || window.currentStudent.name)) {
      return {
        id: window.currentStudent.id || null,
        studentId: window.currentStudent.ID || window.currentStudent.studentId || window.currentStudent.studentID || null,
        name: window.currentStudent.name || window.currentStudent.displayName || null,
        batch: window.currentStudent.batch || null,
        email: window.currentStudent.email || null,
        guest: false,
      };
    }
    return { id: null, studentId: null, name: null, batch: null, email: null, guest: false };
  } catch (e) {
    return { id: null, studentId: null, name: null, batch: null, email: null, guest: false };
  }
}

// Backfill the human-facing ID/details from the student's own Firestore
// record when an older browser cache does not contain them yet.
async function enrichStudentIdentity(student) {
  if (!student || !student.id) return student;
  const enriched = { ...student };
  try {
    const snap = await getDoc(doc(db, 'secretkeys', student.id));
    if (snap.exists()) {
      const data = snap.data() || {};
      enriched.studentId = enriched.studentId || data.ID || data.studentId || data.studentID || null;
      enriched.name = enriched.name || data.name || null;
      enriched.batch = enriched.batch || data.batch || null;
      enriched.email = enriched.email || data.email || null;
    }
  } catch (e) {
    // Best-effort only — the existing auth identity remains authoritative.
  }
  return enriched;
}

// ============================================================================
// PENDING SUBMISSIONS
// ============================================================================
const PENDING_KEYS = new Set();
let PENDING_LOADED_FOR = null;

async function loadPendingSubmissions() {
  const student = getCurrentStudent();
  if (!student.id || PENDING_LOADED_FOR === student.id) return;
  PENDING_LOADED_FOR = student.id;
  try {
    const myUid = await getAuthUidAsync();
    if (!myUid) return;
    const snap = await getDocs(query(
      collection(db, 'paymentSubmissions'),
      where('uid', '==', myUid),
      where('status', '==', 'pending'),
    ));
    snap.docs.forEach((d) => {
      const data = d.data();
      PENDING_KEYS.add(`${data.offerType || 'package'}::${(data.offerName || '').trim()}`);
    });
  } catch (e) { /* best-effort */ }
}
loadPendingSubmissions();

function isPending(type, name) {
  return PENDING_KEYS.has(`${type}::${(name || '').trim()}`);
}

// ============================================================================
// LOCK HELPERS
// ============================================================================
function effectiveLocked(docData, studentId) {
  if (studentId && docData.userLocks && Object.prototype.hasOwnProperty.call(docData.userLocks, studentId)) {
    return docData.userLocks[studentId] === true;
  }
  return docData.locked === true || docData.locked === 'public_lock';
}

async function isEnrolledIn(moduleId, student) {
  if (!moduleId || !student || !student.id) return false;
  const { ALL_MODULES } = await import('./picker-screen.js');
  const m = ALL_MODULES.find((x) => x.id === moduleId);
  if (m && m.userLocks && m.userLocks[student.id] === 'enrolled') return true;
  return !!(student.userLocks && student.userLocks[moduleId] === 'enrolled');
}

const MODULE_LOCK_CACHE = new Map();
async function moduleHasLockedContent(moduleName) {
  const student = getCurrentStudent();
  const cacheKey = `${moduleName}::${student.id || ''}`;
  if (MODULE_LOCK_CACHE.has(cacheKey)) return MODULE_LOCK_CACHE.get(cacheKey);
  const resultPromise = (async () => {
    try {
      const { ALL_MODULES } = await import('./picker-screen.js');
      const known = ALL_MODULES.find((x) => x.name === moduleName);
      if (known && await isEnrolledIn(known.id, student)) return false;
      const modSnap = await getDocs(query(collection(db, 'modules'), where('name', '==', moduleName), limit(1)));
      if (!modSnap.docs.length) return false;
      const moduleId = modSnap.docs[0].id;
      const subjSnap = await getDocs(query(collection(db, 'subjects'), where('moduleId', '==', moduleId)));
      for (const subjDoc of subjSnap.docs) {
        const subjData = subjDoc.data();
        if ((subjData.userLocks && subjData.userLocks[student.id] === 'enrolled') || (student.userLocks && student.userLocks[subjDoc.id] === 'enrolled')) continue;
        if (effectiveLocked(subjData, student.id)) return true;
        try {
          const quizSnap = await getDocs(collection(db, 'subjects', subjDoc.id, 'quizzes'));
          for (const qDoc of quizSnap.docs) {
            if (effectiveLocked(qDoc.data(), student.id)) return true;
          }
        } catch (e) { /* no quizzes subcollection */ }
      }
      return false;
    } catch (e) { return false; }
  })();
  MODULE_LOCK_CACHE.set(cacheKey, resultPromise);
  return resultPromise;
}

const SUBJECT_LOCK_CACHE = new Map();
async function subjectHasLockedContent(subjectName) {
  const student = getCurrentStudent();
  const cacheKey = `${subjectName}::${student.id || ''}`;
  if (SUBJECT_LOCK_CACHE.has(cacheKey)) return SUBJECT_LOCK_CACHE.get(cacheKey);
  const resultPromise = (async () => {
    try {
      const { SUBJECTS_CACHE } = await import('./picker-screen.js');
      const known = SUBJECTS_CACHE.find((x) => x.name === subjectName);
      if (known && ((known.userLocks && known.userLocks[student.id] === 'enrolled') || (student.userLocks && student.userLocks[known.id] === 'enrolled'))) return false;
      if (known && await isEnrolledIn(known.moduleId, student)) return false;
      const subjSnap = await getDocs(query(collection(db, 'subjects'), where('name', '==', subjectName), limit(1)));
      if (!subjSnap.docs.length) return false;
      const subjectId = subjSnap.docs[0].id;
      const quizSnap = await getDocs(collection(db, 'subjects', subjectId, 'quizzes'));
      for (const qDoc of quizSnap.docs) {
        if (effectiveLocked(qDoc.data(), student.id)) return true;
      }
      return false;
    } catch (e) { return false; }
  })();
  SUBJECT_LOCK_CACHE.set(cacheKey, resultPromise);
  return resultPromise;
}

// ============================================================================
// PRICING
// ============================================================================
const PRICE_CACHE = new Map();
let PRICING_SETTINGS = null;
let PRICING_SETTINGS_PROMISE = null;

async function getPricingSettings() {
  if (PRICING_SETTINGS) return PRICING_SETTINGS;
  if (!PRICING_SETTINGS_PROMISE) {
    PRICING_SETTINGS_PROMISE = (async () => {
      try {
        PRICING_SETTINGS = await ttlRead('pricing_settings', 30 * 6e4, async () => {
          const snap = await getDoc(doc(db, 'settings', 'pricing'));
          return snap.exists() ? snap.data() : {};
        });
      } catch (e) { PRICING_SETTINGS = {}; }
      return PRICING_SETTINGS;
    })();
  }
  return PRICING_SETTINGS_PROMISE;
}

const TYPE_TO_COLLECTION = { module: 'modules', subject: 'subjects', quiz: null };
const TYPE_TO_UNIFORM_FIELD = {
  module: 'moduleUniformPrice',
  subject: 'subjectUniformPrice',
  quiz: 'quizUniformPrice',
};

async function lookupPrice(type, name) {
  const cacheKey = `${type}::${name}`;
  if (PRICE_CACHE.has(cacheKey)) return PRICE_CACHE.get(cacheKey);
  let price = null;
  try {
    if (type === 'quiz') {
      const snap = await getDocs(query(collectionGroup(db, 'quizzes'), where('name', '==', name), limit(1)));
      if (snap.docs.length && snap.docs[0].data().price) price = snap.docs[0].data().price;
    } else {
      const collName = TYPE_TO_COLLECTION[type];
      if (collName) {
        const snap = await getDocs(query(collection(db, collName), where('name', '==', name), limit(1)));
        if (snap.docs.length && snap.docs[0].data().price) price = snap.docs[0].data().price;
      }
    }
  } catch (e) { /* fall through */ }
  if (!price) {
    const settings = await getPricingSettings();
    const field = TYPE_TO_UNIFORM_FIELD[type];
    if (field && settings[field]) price = settings[field];
  }
  const result = price || 'Contact for price';
  PRICE_CACHE.set(cacheKey, result);
  return result;
}

// ============================================================================
// STYLES — your full-screen checkout CSS verbatim, plus a MODIFICATIONS
// block at the end with the three changes you asked for.
// ============================================================================
const style = document.createElement('style');
style.id = 'bm-style';
style.textContent = `
/* ---------- tokens ---------- */
.bm-overlay, #bmPackageLockOverlay, .bm-cta-btn, .bm-pending-badge {
  --bm-bg: #F5F7FB;
  --bm-field: #ffffff;
  --bm-surface: rgba(255,255,255,.80);
  --bm-tile: rgba(15,23,42,.035);
  --bm-tile-hover: rgba(15,23,42,.065);
  --bm-line: rgba(15,23,42,.10);
  --bm-line-strong: rgba(15,23,42,.24);
  --bm-ink: var(--ink, #1c1d1f);
  --bm-ink-soft: var(--ink-soft, #5b5f64);
  --bm-ink-faint: var(--ink-faint, #8a8e93);
  --bm-accent: #2563EB;
  --bm-accent-ink: #ffffff;
  --bm-btn: #2563EB;
  --bm-btn-ink: #ffffff;
  --bm-danger: #b53a3a;
}
body.dark .bm-overlay, body.dark #bmPackageLockOverlay, body.dark .bm-cta-btn,
body.dark .bm-module-buy-btn, body.dark .bm-pending-badge {
  --bm-bg: #000000;
  --bm-field: rgba(255,255,255,.04);
  --bm-surface: rgba(13,13,15,.78);
  --bm-tile: rgba(255,255,255,.05);
  --bm-tile-hover: rgba(255,255,255,.085);
  --bm-line: rgba(255,255,255,.11);
  --bm-line-strong: rgba(255,255,255,.30);
  --bm-accent: #7FA8FF;
  --bm-accent-ink: #000000;
  --bm-btn: #3B7BF6;
  --bm-btn-ink: #ffffff;
  --bm-danger: #ff8f84;
}

/* ---------- entry points ---------- */
.bm-cta-btn {
  width: 100%; margin-top: 10px; padding: 13px 16px;
  border-radius: 12px; border: 1px solid var(--bm-line-strong);
  background: transparent; color: var(--bm-ink);
  font-family: inherit; font-size: 13.5px; font-weight: 600;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  cursor: pointer; transition: background .18s ease;
}
.bm-cta-btn i { color: var(--bm-accent); }
.bm-cta-btn:hover { background: var(--bm-tile-hover); }

.bm-pending-badge {
  width: 100%; margin-top: 10px; padding: 12px 16px; border-radius: 12px;
  background: var(--bm-tile); border: 1px solid var(--bm-line);
  color: var(--bm-ink-soft); font-size: 13px; font-weight: 600;
  display: flex; align-items: center; justify-content: center; gap: 8px;
}
.bm-pending-badge i { color: var(--bm-accent); }

.bm-module-buy-btn {
  position: absolute; top: 10px; right: 10px; z-index: 5;
  width: 28px; height: 28px; padding: 0; border-radius: 50%;
  background: var(--bm-surface); color: var(--bm-ink); border: 1px solid var(--bm-line);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; cursor: pointer; transition: background .18s ease;
}
.bm-module-buy-btn:hover { background: var(--bm-tile-hover); }

/* ---------- full-screen shell ---------- */
.bm-overlay {
  position: fixed; inset: 0; z-index: 10000; display: block;
  background: var(--bm-bg);
  opacity: 0; visibility: hidden;
  transition: opacity .3s ease, visibility .3s ease;
}
.bm-overlay.show { opacity: 1; visibility: visible; }

.bm-card {
  position: absolute; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none;
  overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
  background: var(--bm-bg); color: var(--bm-ink);
  font-family: 'Source Sans 3', -apple-system, BlinkMacSystemFont, sans-serif;
  transform: translateY(14px);
  transition: transform .55s cubic-bezier(.22,1,.36,1);
  scrollbar-width: thin; scrollbar-color: var(--bm-line-strong) transparent;
}
.bm-card, .bm-card * { box-sizing: border-box; }
.bm-overlay.show .bm-card { transform: none; }
.bm-drag-handle { display: none !important; }

.bm-close {
  position: fixed; z-index: 6; top: calc(env(safe-area-inset-top, 0px) + 14px); right: 16px;
  width: 40px; height: 40px; padding: 0; border-radius: 50%; cursor: pointer;
  display: flex; align-items: center; justify-content: center; font-size: 15px;
  color: #EAF0FB; background: rgba(10,10,12,.35); border: 1px solid rgba(234,240,251,.26);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  transition: background .18s ease;
}
.bm-close:hover { background: rgba(10,10,12,.6); }

/* ---------- order summary panel ---------- */
.bm-summary {
  position: relative; overflow: hidden;
  padding: calc(env(safe-area-inset-top, 0px) + 22px) 22px 28px;
  border-radius: 0 0 28px 28px;
  background: #0A0A0C; color: #EAF0FB;
  --s-soft: rgba(234,240,251,.62); --s-line: rgba(234,240,251,.14);
}
.bm-summary::before, .bm-summary::after {
  content: ''; position: absolute; border-radius: 50%; pointer-events: none;
  border: 1px solid rgba(127,168,255,.20);
}
.bm-summary::before { width: 300px; height: 300px; right: -110px; bottom: -130px; }
.bm-summary::after { width: 470px; height: 470px; right: -195px; bottom: -235px; border-color: rgba(127,168,255,.11); }
.bm-summary > * { position: relative; z-index: 1; }

.bm-sum-top { display: flex; align-items: center; gap: 9px; padding-right: 52px; font-size: 13.5px; font-weight: 500; color: var(--s-soft); }
.bm-sum-top i { color: #7FA8FF; font-size: 13px; }
.bm-sum-body { margin-top: 24px; }
.bm-sum-type {
  display: inline-block; padding: 5px 13px; border-radius: 999px;
  border: 1px solid rgba(127,168,255,.45); color: #7FA8FF;
  font-size: 12.5px; font-weight: 600;
}
.bm-sum-name {
  margin: 15px 0 0; font-family: 'Fraunces', Georgia, serif; font-size: 30px; font-weight: 500;
  line-height: 1.16; letter-spacing: -.02em; color: #EAF0FB; overflow-wrap: anywhere;
}
.bm-sum-amount { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--s-line); position: relative; }
.bm-sum-amount::before { content: ''; position: absolute; top: -1px; left: 0; width: 72px; height: 2px; background: #7FA8FF; }
.bm-sum-amount-label { font-size: 13px; font-weight: 500; color: var(--s-soft); }
.bm-amount {
  margin-top: 7px; font-family: 'Fraunces', Georgia, serif; font-size: 54px; font-weight: 500;
  letter-spacing: -.02em; line-height: 1.02; color: #7FA8FF;
  font-variant-numeric: tabular-nums lining-nums; overflow-wrap: anywhere;
}
.bm-sum-points { display: none; list-style: none; margin: 0; padding: 0; }
.bm-sum-points li { display: flex; align-items: flex-start; gap: 12px; font-size: 14px; line-height: 1.5; color: var(--s-soft); }
.bm-sum-points li + li { margin-top: 12px; }
.bm-sum-points i { margin-top: 4px; font-size: 11px; color: #7FA8FF; }

/* ---------- main column ---------- */
.bm-main { padding: 30px 20px 0; }
.bm-main-inner { max-width: 520px; margin: 0 auto; }
.bm-card h3 {
  margin: 0 0 6px; font-family: 'Fraunces', Georgia, serif; font-size: 26px; font-weight: 500;
  letter-spacing: -.015em; line-height: 1.2; color: var(--bm-ink);
}
.bm-sub { margin: 0 0 30px; font-size: 14.5px; line-height: 1.5; color: var(--bm-ink-soft); }

/* steps */
.bm-step {
  position: relative; display: grid; grid-template-columns: 32px minmax(0, 1fr);
  column-gap: 16px; padding-bottom: 32px;
}
.bm-step::before { content: ''; position: absolute; left: 15.5px; top: 42px; bottom: 8px; width: 1px; background: var(--bm-line); }
.bm-step:last-of-type::before { display: none; }
.bm-step-num {
  width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--bm-line-strong); color: var(--bm-ink);
  font-size: 13.5px; font-weight: 600; font-variant-numeric: tabular-nums;
  transition: background .25s ease, border-color .25s ease, color .25s ease;
}
.bm-step:has(.bm-bank-row.selected) > .bm-step-num,
.bm-step:has(#bmSenderName:not(:placeholder-shown)) > .bm-step-num,
.bm-step:has(.bm-preview-card:not([style*="none"])) > .bm-step-num {
  background: var(--bm-accent); border-color: var(--bm-accent); color: var(--bm-accent-ink);
}
.bm-step-title { display: block; margin: 0 0 4px; font-size: 16px; font-weight: 600; line-height: 32px; color: var(--bm-ink); }
.bm-step-hint { margin: 0 0 14px; font-size: 13.5px; line-height: 1.5; color: var(--bm-ink-soft); }
.bm-note { margin: 12px 0 0; font-size: 13px; line-height: 1.5; color: var(--bm-ink-soft); }

/* fields */
.bm-step input[type="text"] {
  width: 100%; padding: 14px 15px; border-radius: 12px;
  border: 1px solid var(--bm-line); background: var(--bm-field);
  color: var(--bm-ink); font-family: inherit; font-size: 15px;
  transition: border-color .18s ease, box-shadow .18s ease;
}
.bm-step input[type="text"]::placeholder { color: var(--bm-ink-faint); }
.bm-step input[type="text"]:focus {
  outline: none; border-color: var(--bm-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--bm-accent) 18%, transparent);
}

/* bank accounts */
.bm-bank-list { display: flex; flex-direction: column; gap: 10px; }
.bm-bank-row, .bm-skeleton-bank-row {
  display: flex; align-items: center; gap: 13px; padding: 14px 15px;
  border-radius: 14px; border: 1px solid var(--bm-line); background: var(--bm-field);
}
.bm-bank-row { cursor: pointer; transition: border-color .18s ease, background .18s ease; }
.bm-bank-row:hover { border-color: var(--bm-line-strong); }
.bm-bank-row.selected {
  border-color: var(--bm-accent); box-shadow: inset 0 0 0 1px var(--bm-accent);
  background: color-mix(in srgb, var(--bm-accent) 7%, var(--bm-field));
}
.bm-bank-logo { width: 38px; height: 38px; border-radius: 10px; object-fit: contain; background: #fff; border: 1px solid var(--bm-line); flex: none; }
.bm-bank-info { flex: 1; min-width: 0; }
.bm-bank-name { font-size: 14.5px; font-weight: 600; color: var(--bm-ink); }
.bm-bank-holder { margin-top: 3px; font-size: 12.5px; color: var(--bm-ink-soft); overflow-wrap: anywhere; }
.bm-bank-holder-label { color: var(--bm-ink-faint); }
.bm-bank-number {
  display: flex; align-items: center; gap: 10px; margin-top: 3px;
  font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 500;
  letter-spacing: .02em; color: var(--bm-ink-soft);
}
.bm-bank-copy, .bm-copy-btn {
  flex: none; padding: 3px 11px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--bm-line-strong); background: transparent; color: var(--bm-ink);
  font-family: 'Source Sans 3', sans-serif; font-size: 12px; font-weight: 600;
  transition: background .18s ease;
}
.bm-bank-copy:hover, .bm-copy-btn:hover { background: var(--bm-tile-hover); }
.bm-bank-copy.copied { border-color: var(--bm-accent); color: var(--bm-accent); }
.bm-bank-radio { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--bm-line-strong); flex: none; display: flex; align-items: center; justify-content: center; }
.bm-bank-row.selected .bm-bank-radio { border-color: var(--bm-accent); }
.bm-bank-row.selected .bm-bank-radio::after { content: ''; width: 9px; height: 9px; border-radius: 50%; background: var(--bm-accent); }

/* receipt upload */
.bm-upload-choices {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;
}
.bm-upload-choice {
  position: relative; overflow: hidden; min-height: 138px; padding: 18px 12px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px;
  text-align: center; border: 1px solid var(--bm-line); border-radius: 18px;
  background: var(--bm-tile);
  color: var(--bm-ink); cursor: pointer;
  transition: transform .18s ease, border-color .18s ease, background .18s ease, box-shadow .18s ease;
}
.bm-upload-choice:hover {
  border-color: color-mix(in srgb, var(--bm-accent) 70%, var(--bm-line));
  background: color-mix(in srgb, var(--bm-accent-soft) 52%, var(--bm-field));
  box-shadow: 0 12px 28px -20px rgba(148,112,31,.45);
  transform: translateY(-1px);
}
.bm-upload-choice:active { transform: scale(.985); }
.bm-upload-choice:focus-within { outline: 2px solid var(--bm-accent); outline-offset: 2px; }
.bm-upload-ico {
  width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center;
  color: var(--bm-accent); background: var(--bm-accent-soft);
  border: 1px solid color-mix(in srgb, var(--bm-accent) 28%, var(--bm-line));
  font-size: 19px; box-shadow: inset 0 1px 0 rgba(255,255,255,.38);
  transition: transform .18s ease, background .18s ease;
}
.bm-upload-choice:hover .bm-upload-ico { transform: scale(1.04); background: color-mix(in srgb, var(--bm-accent) 14%, var(--bm-field)); }
.bm-upload-title { font-size: 14px; font-weight: 700; line-height: 1.2; }
.bm-upload-hint { font-size: 12px; color: var(--bm-ink-faint); line-height: 1.25; }
.bm-upload-choice input[type="file"] { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
@media (max-width: 480px) {
  .bm-upload-choices { gap: 9px; }
  .bm-upload-choice { min-height: 128px; padding: 16px 8px; border-radius: 16px; }
  .bm-upload-ico { width: 48px; height: 48px; border-radius: 14px; font-size: 18px; }
}

@keyframes bm-preview-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.bm-preview-card {
  position: relative; width: 100%; height: 190px; overflow: hidden;
  border-radius: 14px; border: 1px solid var(--bm-line); background: var(--bm-tile);
  animation: bm-preview-in .28s cubic-bezier(.22,1,.36,1);
}
.bm-preview-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.bm-preview-scrim { position: absolute; left: 0; right: 0; bottom: 0; height: 60%; background:  rgba(10,12,14,.72); pointer-events: none; }
.bm-preview-badge, .bm-preview-remove {
  position: absolute; top: 12px; width: 28px; height: 28px; padding: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(16,18,20,.45); color: #fff; font-size: 11px; border: 1px solid rgba(255,255,255,.28);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
}
.bm-preview-badge { left: 12px; }
.bm-preview-remove { right: 12px; cursor: pointer; transition: background .18s ease; }
.bm-preview-remove:hover { background: rgba(16,18,20,.7); }
.bm-preview-meta { position: absolute; left: 16px; right: 48px; bottom: 12px; color: #fff; pointer-events: none; }
.bm-preview-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bm-preview-size { margin-top: 1px; font-family: 'JetBrains Mono', monospace; font-size: 10.5px; opacity: .82; }

/* polished inline error */
.bm-error { display: none; margin: 4px 0 0; font-size: 13.5px; font-weight: 500; line-height: 1.45; color: var(--bm-danger); }
.bm-error.show {
  display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: 12px;
  background: color-mix(in srgb, var(--bm-danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--bm-danger) 30%, transparent);
  animation: bm-err-in .25s ease;
}
@keyframes bm-err-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }

/* sticky pay bar */
.bm-actions {
  position: sticky; bottom: 0; z-index: 3; display: flex; gap: 10px; margin-top: 10px;
  padding: 18px 0 calc(18px + env(safe-area-inset-bottom, 0px));
  background:  var(--bm-bg);
}
.bm-btn-cancel, .bm-btn-submit {
  min-height: 52px; padding: 0 18px; border-radius: 14px; cursor: pointer;
  font-family: inherit; font-size: 15px; font-weight: 600;
  display: flex; align-items: center; justify-content: center; gap: 9px;
  transition: background .18s ease, opacity .18s ease;
}
.bm-btn-cancel { flex: 1; border: 1px solid var(--bm-line-strong); background: transparent; color: var(--bm-ink-soft); }
.bm-btn-cancel:hover { background: var(--bm-tile-hover); }
.bm-btn-submit { flex: 2; border: none; background: var(--bm-btn); color: var(--bm-btn-ink); }
.bm-btn-submit:hover { opacity: .9; }
.bm-btn-submit:disabled { opacity: .5; cursor: not-allowed; }
.bm-spinner {
  width: 15px; height: 15px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--bm-btn-ink) 30%, transparent);
  border-top-color: var(--bm-btn-ink); animation: bm-spin .7s linear infinite;
}
@keyframes bm-spin { to { transform: rotate(360deg); } }

/* success */
.bm-success { text-align: center; padding: 36px 0 6px; }
.bm-success i { display: block; margin-bottom: 18px; font-size: 54px; color: var(--bm-accent); animation: bm-pop .55s cubic-bezier(.2,1.2,.3,1) both; }
.bm-success .bm-sub { max-width: 340px; margin: 6px auto 0; }
@keyframes bm-pop { from { transform: scale(.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }

.bm-success-panel {
  flex: 1; min-height: 0; width: 100%; max-width: 640px; margin: 0 auto;
  flex-direction: column; justify-content: center; align-items: center;
  padding: 40px 20px 24px; text-align: center;
}
.bm-success-panel[style*="display:none"] { display: none !important; }
.bm-success-panel.show { display: flex !important; animation: bm-pane-in .4s cubic-bezier(.22,1,.36,1) both; }
.bm-success-status {
  display: inline-flex; align-items: center; gap: 8px; margin-top: 18px;
  padding: 8px 13px; border-radius: 999px;
  color: var(--bm-accent); background: var(--bm-accent-soft);
  border: 1px solid var(--bm-line); font-size: 13px; font-weight: 600;
}
.bm-success-status i { display: inline !important; margin: 0 !important; font-size: 12px !important; animation: none !important; color: inherit !important; }
.bm-success-actions { width: 100%; max-width: 520px; margin-top: 18px; border-top: 1px solid var(--bm-line); }
.bm-success-actions .bm-btn-submit { margin-left: auto; }
@media (min-width: 900px) {
  .bm-success-panel { max-width: 760px; padding: 60px 48px 30px; }
  .bm-success i { font-size: 64px; }
}

/* success wipe: curtain sweeps left -> right, success content rises in behind it */
.bm-wipe-wrap { position: absolute; inset: 0; z-index: 40; overflow: hidden; pointer-events: auto; }
.bm-wipe {
  position: absolute; inset: 0; will-change: transform;
  /* translucent golden glass: the page stays faintly visible (and blurred) through the wipe */
  background:
     rgba(204,161,58,.62);
  -webkit-backdrop-filter: blur(16px) saturate(1.25); backdrop-filter: blur(16px) saturate(1.25);
  display: flex; align-items: center; justify-content: center;
}
.bm-wipe::before, .bm-wipe::after { content: ''; position: absolute; top: 0; bottom: 0; width: 170px; pointer-events: none;
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
.bm-wipe::before { right: -170px;
  background:  rgba(140,105,32,.76);
  -webkit-mask-image: linear-gradient(90deg, #000 0%, transparent 100%); mask-image: linear-gradient(90deg, #000 0%, transparent 100%); }
.bm-wipe::after { left: -170px;
  background:  rgba(37,99,235,.70);
  -webkit-mask-image: linear-gradient(270deg, #000 0%, transparent 100%); mask-image: linear-gradient(270deg, #000 0%, transparent 100%); }
.bm-wipe-mark { font-size: 76px; line-height: 1; opacity: 0; transform: scale(.55); filter: drop-shadow(0 6px 18px rgba(120,86,18,.35)); }
.bm-wipe-mark i { display: block; color: var(--bm-accent); background: rgba(255,255,255,.92); border-radius: 50%; }
@keyframes bm-rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
.bm-success-panel.bm-wiped.show { animation: none !important; }
.bm-success-panel.bm-pre .bm-success > *, .bm-success-panel.bm-pre .bm-success-actions { opacity: 0; }
@keyframes bm-pop-in { from { transform: scale(.55); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.bm-success-panel.bm-stagger .bm-success > i { animation: bm-pop-in .7s cubic-bezier(.2,1.2,.3,1) .05s both; }
.bm-success-panel.bm-stagger .bm-success > h3 { animation: bm-rise .7s cubic-bezier(.22,1,.36,1) .18s both; }
.bm-success-panel.bm-stagger .bm-success > .bm-sub { animation: bm-rise .7s cubic-bezier(.22,1,.36,1) .28s both; }
.bm-success-panel.bm-stagger .bm-success > .bm-success-status { animation: bm-rise .7s cubic-bezier(.22,1,.36,1) .38s both; }
.bm-success-panel.bm-stagger .bm-success-actions { animation: bm-rise .7s cubic-bezier(.22,1,.36,1) .5s both; }
@media (prefers-reduced-motion: reduce) { .bm-wipe-wrap { display: none !important; } }

/* skeletons */
@keyframes bm-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
.bm-skeleton {
  display: inline-block; vertical-align: middle; border-radius: 8px;
  background:  rgba(128,128,128,.10);
  background-size: 200% 100%; animation: bm-shimmer 1.4s ease-in-out infinite;
}
.bm-summary .bm-skeleton { background:  rgba(234,240,251,.08); background-size: 200% 100%; }
.bm-skeleton-amount { width: 170px; height: 46px; }
.bm-skeleton-logo { width: 38px; height: 38px; border-radius: 10px; flex: none; }
.bm-skeleton-lines { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.bm-skeleton-line { height: 11px; width: 70%; }
.bm-skeleton-line.short { width: 40%; }

/* ---------- desktop ---------- */
@media (min-width: 900px) {
  .bm-card { display: grid; grid-template-columns: minmax(380px, 42%) 1fr; overflow: hidden; }
  .bm-summary {
    height: 100%; border-radius: 0; padding: 56px 56px 52px;
    display: flex; flex-direction: column; justify-content: space-between;
  }
  .bm-summary::before { width: 380px; height: 380px; right: -140px; bottom: -150px; }
  .bm-summary::after { width: 620px; height: 620px; right: -260px; bottom: -300px; }
  .bm-sum-top { padding-right: 0; font-size: 14px; }
  .bm-sum-body { margin-top: 0; }
  .bm-sum-name { font-size: clamp(38px, 4vw, 58px); margin-top: 20px; max-width: 12em; }
  .bm-sum-type { font-size: 13px; letter-spacing: .02em; text-transform: uppercase; }
  .bm-sum-amount { margin-top: 36px; padding-top: 28px; }
  .bm-amount { font-size: clamp(68px, 6vw, 96px); }
  .bm-skeleton-amount { width: 230px; height: 68px; }
  .bm-sum-points { display: block; }
  .bm-main { height: 100%; overflow-y: auto; padding: 84px clamp(32px, 6vw, 96px) 0; scrollbar-width: thin; }
  .bm-card h3 { font-size: 30px; }
  .bm-close { top: 24px; right: 28px; color: var(--bm-ink); background: transparent; border-color: var(--bm-line-strong); -webkit-backdrop-filter: none; backdrop-filter: none; }
  .bm-close:hover { background: var(--bm-tile-hover); }
}

/* ---------- lock overlay ---------- */
#bmPackageLockOverlay {
  background: rgba(255,255,255,.34);
  -webkit-backdrop-filter: blur(20px) saturate(140%); backdrop-filter: blur(20px) saturate(140%);
}
body.dark #bmPackageLockOverlay { background: rgba(0,0,0,.46); }
#bmPackageLockOverlay .lock-overlay-icon {
  color: var(--bm-ink); background: var(--bm-surface); border: 1px solid var(--bm-line); box-shadow: none;
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
}
#bmPackageLockOverlay .lock-overlay-icon:nth-child(2) { color: var(--bm-accent); border-color: color-mix(in srgb, var(--bm-accent) 45%, transparent); }
#bmPackageLockOverlay .lock-overlay-message {
  padding: 22px 24px; border-radius: 20px; color: var(--bm-ink);
  background: var(--bm-surface); border: 1px solid var(--bm-line); box-shadow: none;
  -webkit-backdrop-filter: blur(28px) saturate(150%); backdrop-filter: blur(28px) saturate(150%);
}
#bmPackageLockOverlay #bmPkgLockMsgText { font-weight: 500; line-height: 1.45; }
#bmPackageLockOverlay .lock-overlay-hint { color: var(--bm-ink-soft); }
#bmPackageLockOverlay .bm-cta-btn {
  min-height: 50px; padding: 0 22px; border-radius: 14px;
  background:  #efd496;
  color: #1c1606; border: 1px solid rgba(160,118,38,.22);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.62), 0 14px 30px -16px rgba(160,118,38,.95);
  font-family: inherit; font-size: 14.5px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  cursor: pointer; transition: transform .18s ease, filter .18s ease;
}
#bmPackageLockOverlay .bm-cta-btn i { color: #1c1606; }
#bmPackageLockOverlay .bm-cta-btn:hover { filter: brightness(1.05); }
#bmPackageLockOverlay .bm-cta-btn:active { transform: scale(.985); }

/* ---------- accessibility ---------- */
.bm-overlay button:focus-visible, .bm-cta-btn:focus-visible {
  outline: 2px solid var(--bm-accent); outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .bm-overlay, .bm-card, .bm-skeleton, .bm-success i, .bm-error.show, .bm-preview-card, .bm-spinner {
    animation: none !important; transition: none !important;
  }
}
@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
  #bmPackageLockOverlay { background: rgba(255,255,255,.92); }
  body.dark #bmPackageLockOverlay { background: rgba(0,0,0,.85); }
}

/* ==========================================================================
   ===== MODIFICATIONS ======================================================
   Three changes layered on top of the sheet above:

     1. COMPACT PAY BAR — Cancel + Submit no longer stretch the full width.
        Submit is content-sized, sits on the right; Cancel is compact and
        sits to its left. No more edge-to-edge slab.

     2. NO ERROR TEXT — .bm-error is force-hidden. The area that needs
        attention shakes and glows in the danger color, then clears the
        moment the user fixes it.

     3. HIGHLIGHT STYLING — dedicated visual rules for the invalid bank
        list, sender field, upload tiles, and (as a last resort) the whole
        card, all in the same champagne/danger language the sheet uses.

   ========================================================================== */

/* ---------- 1. compact, right-aligned pay bar ---------- */
.bm-actions {
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.bm-btn-cancel,
.bm-btn-submit {
  min-height: 46px;
  font-size: 14.5px;
  border-radius: 12px;
}
.bm-btn-cancel {
  flex: 0 0 auto;
  padding: 0 20px;
}
.bm-btn-submit {
  flex: 0 0 auto;
  min-width: 128px;
  max-width: 220px;
  padding: 0 24px;
}
/* trailing arrow on the submit button */
.bm-btn-submit .bm-btn-arrow {
  font-size: 11px;
  opacity: .85;
  transition: transform .2s ease;
}
.bm-btn-submit:not(:disabled):hover .bm-btn-arrow { transform: translateX(3px); }

/* ---------- polished inline error ---------- */
.bm-error {
  display: none; margin: 4px 0 18px; padding: 13px 15px; border-radius: 14px;
  align-items: flex-start; gap: 10px; color: #8e2f2f;
  background: rgba(181,58,58,.075);
  border: 1px solid rgba(181,58,58,.28);
  box-shadow: 0 8px 24px rgba(181,58,58,.06);
  font-size: 13.5px; line-height: 1.45; font-weight: 600;
}
.bm-error.show { display: flex; animation: bm-err-in .25s ease; }
.bm-error > i { flex: none; margin-top: 2px; font-size: 14px; line-height: 1; }
body.dark .bm-error { color: #ffb0a8; background: rgba(255,110,98,.09); border-color: rgba(255,143,132,.28); }

/* ---------- 3. highlight the invalid area ---------- */

@keyframes bm-shake {
  0%, 100% { transform: translateX(0); }
  12%      { transform: translateX(-6px); }
  26%      { transform: translateX(5px); }
  42%      { transform: translateX(-4px); }
  58%      { transform: translateX(3px); }
  74%      { transform: translateX(-2px); }
  88%      { transform: translateX(1px); }
}
.bm-invalid { animation: bm-shake .55s cubic-bezier(.36, .07, .19, .97); }

/* sender field — red border, red label, red focus ring */
.bm-field.bm-invalid input[type="text"] {
  border-color: var(--bm-danger) !important;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--bm-danger) 18%, transparent) !important;
  background: color-mix(in srgb, var(--bm-danger) 5%, var(--bm-field)) !important;
}
.bm-step.bm-invalid .bm-step-num {
  border-color: var(--bm-danger);
  color: var(--bm-danger);
}
.bm-step.bm-invalid .bm-step-title {
  color: var(--bm-danger);
}

/* bank list — every row reads "pick one of these" */
.bm-bank-list.bm-invalid .bm-bank-row {
  border-color: color-mix(in srgb, var(--bm-danger) 40%, transparent);
  background: color-mix(in srgb, var(--bm-danger) 6%, var(--bm-field));
}
.bm-bank-list.bm-invalid .bm-bank-row:hover {
  border-color: var(--bm-danger);
}
.bm-bank-list.bm-invalid .bm-bank-radio { border-color: var(--bm-danger); }
.bm-bank-list.bm-invalid .bm-bank-name { color: var(--bm-danger); }

/* upload tiles — solid border in the danger color */
.bm-upload-choices.bm-invalid .bm-upload-choice {
  border-style: solid;
  border-color: var(--bm-danger);
  background: color-mix(in srgb, var(--bm-danger) 6%, var(--bm-field));
  color: var(--bm-danger);
}
.bm-upload-choices.bm-invalid .bm-upload-choice i { color: var(--bm-danger); }

/* whole-card shake — for guest account / general failure */
.bm-card.bm-invalid .bm-summary {
  border-bottom-color: color-mix(in srgb, var(--bm-danger) 45%, transparent);
}
.bm-card.bm-invalid .bm-summary::before,
.bm-card.bm-invalid .bm-summary::after {
  border-color: color-mix(in srgb, var(--bm-danger) 32%, transparent);
}

/* ---------- body scroll lock while modal is open ---------- */
body.bm-modal-open { overflow: hidden !important; }
`;
document.head.appendChild(style);

// ============================================================================
// DOM — structured to match the CSS above.
// ============================================================================
const overlay = document.createElement('div');
overlay.className = 'bm-overlay';
overlay.innerHTML = `
  <button type="button" class="bm-close" id="bmCloseBtn" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>

  <div class="bm-card" role="dialog" aria-modal="true" aria-labelledby="bmTitle1">

    <!-- ============ ORDER SUMMARY PANEL ============ -->
    <aside class="bm-summary">
      <div class="bm-sum-top">
        <i class="fa-solid fa-lock"></i>
        <span>Secure checkout</span>
      </div>

      <div class="bm-sum-body">
        <span class="bm-sum-type" id="bmSumType">Offer</span>
        <h2 class="bm-sum-name" id="bmOfferName"></h2>
        <div class="bm-sum-amount">
          <div class="bm-sum-amount-label">Total to unlock this program</div>
          <div class="bm-amount" id="bmAmount"></div>
        </div>
      </div>

      <ul class="bm-sum-points">
        <li><i class="fa-solid fa-circle"></i><span>Pick the bank you sent the payment to.</span></li>
        <li><i class="fa-solid fa-circle"></i><span>Attach a clear photo of your receipt.</span></li>
        <li><i class="fa-solid fa-circle"></i><span>We review and unlock access shortly.</span></li>
      </ul>
    </aside>

    <!-- ============ MAIN COLUMN ============ -->
    <main class="bm-main">
      <div class="bm-main-inner">

        <!-- ===== STEP 1: CHOOSE A BANK ===== -->
        <h3 id="bmTitle1">Where did you send it?</h3>
        <p class="bm-sub">Pick the account you transferred the amount to.</p>

        <div class="bm-step" data-step="1">
          <div class="bm-step-num">1</div>
          <div>
            <span class="bm-step-title">Bank account</span>
            <p class="bm-step-hint">Choose the account you sent the money to.</p>
            <div class="bm-bank-list" id="bmBankList"></div>
          </div>
        </div>

        <!-- ===== STEP 2: SENDER NAME ===== -->
        <div class="bm-step" data-step="2">
          <div class="bm-step-num">2</div>
          <div>
            <span class="bm-step-title">Sender name</span>
            <p class="bm-step-hint">Exactly as it shows on your bank statement.</p>
            <div class="bm-field" id="bmSenderField">
              <input type="text" id="bmSenderName" placeholder="e.g. Ahmed Yusuf" autocomplete="off" />
            </div>
          </div>
        </div>

        <!-- ===== STEP 3: RECEIPT ===== -->
        <div class="bm-step" data-step="3">
          <div class="bm-step-num">3</div>
          <div>
            <span class="bm-step-title">Payment receipt</span>
            <p class="bm-step-hint">Upload a screenshot or photo of your transfer.</p>
            <div class="bm-field" id="bmUploadField">
              <div class="bm-upload-choices" id="bmUploadChoices">
                <div class="bm-upload-choice">
                  <div class="bm-upload-ico"><i class="fa-solid fa-photo-film"></i></div>
                  <div class="bm-upload-title">Choose from media</div>
                  <div class="bm-upload-hint">Gallery or files</div>
                  <input type="file" id="bmFileInputGallery" accept="image/*" />
                </div>
                <div class="bm-upload-choice">
                  <div class="bm-upload-ico"><i class="fa-solid fa-camera"></i></div>
                  <div class="bm-upload-title">Take a photo</div>
                  <div class="bm-upload-hint">Use your camera</div>
                  <input type="file" id="bmFileInputCamera" accept="image/*" capture="environment" />
                </div>
              </div>
              <div class="bm-preview-card" id="bmPreviewCard" style="display:none;">
                <img class="bm-preview-img" id="bmPreview" alt="Receipt preview" />
                <div class="bm-preview-scrim"></div>
                <div class="bm-preview-badge"><i class="fa-solid fa-check"></i></div>
                <button type="button" class="bm-preview-remove" id="bmRemoveFileBtn" aria-label="Remove receipt"><i class="fa-solid fa-xmark"></i></button>
                <div class="bm-preview-meta">
                  <div class="bm-preview-name" id="bmPreviewName"></div>
                  <div class="bm-preview-size" id="bmPreviewSize"></div>
                </div>
              </div>
            </div>
            <p class="bm-note">${CONFIG.bankNote}</p>
          </div>
        </div>

        <!-- aria-only error landmark; visually hidden by the mods block -->
        <div class="bm-error" id="bmError" role="alert" aria-live="polite"></div>

        <!-- ===== STICKY PAY BAR ===== -->
        <div class="bm-actions">
          <button type="button" class="bm-btn-cancel" id="bmCancelBtn">Cancel</button>
          <button type="button" class="bm-btn-submit" id="bmSubmitBtn">
            <span>Submit</span><i class="fa-solid fa-arrow-right bm-btn-arrow"></i>
          </button>
        </div>

      </div>

      <!-- ===== SUCCESS ===== -->
      <!-- Kept outside bm-main-inner so hiding the form cannot hide success. -->
      <div id="bmSuccessPanel" class="bm-success-panel" aria-live="polite" style="display:none;">
        <div class="bm-success">
          <i class="fa-solid fa-circle-check"></i>
          <h3>Payment submitted</h3>
          <p class="bm-sub">Your receipt was sent successfully. We'll review it and unlock your access shortly.</p>
          <div class="bm-success-status"><i class="fa-solid fa-clock"></i><span>Pending review</span></div>
        </div>
        <div class="bm-actions bm-success-actions">
          <button type="button" class="bm-btn-submit" id="bmDoneBtn">
            <span>Done</span>
          </button>
        </div>
      </div>

    </main>

  </div>
`;
document.body.appendChild(overlay);

// ============================================================================
// STATE
// ============================================================================
let activeOffer = null;
let selectedFile = null;
let bodyScrollLocked = false;

// ============================================================================
// VALIDATION VISUALS
// ============================================================================

function clearInvalid() {
  overlay.querySelectorAll('.bm-invalid').forEach((el) => el.classList.remove('bm-invalid'));
  const error = overlay.querySelector('#bmError');
  if (error) { error.classList.remove('show'); error.textContent = ''; }
  void overlay.offsetWidth; // reflow so the shake can replay
}

/**
 * Flag a specific area. The area is highlighted (shake + danger color)
 * until the user fixes it. No text is shown anywhere.
 *
 *   'bank'   → highlight the whole bank list + its step marker
 *   'sender' → highlight the sender field + its step marker
 *   'file'   → highlight the upload tiles + its step marker
 *   'card'   → shake the summary panel (guest account / general failure)
 */
function flagInvalid(area) {
  clearInvalid();

  let target = null;
  if (area === 'bank')        target = overlay.querySelector('#bmBankList');
  else if (area === 'sender') target = overlay.querySelector('#bmSenderField');
  else if (area === 'file')   target = overlay.querySelector('#bmUploadField');
  else if (area === 'card')   target = overlay.querySelector('.bm-summary');

  if (!target) return;
  target.classList.add('bm-invalid');

  const error = overlay.querySelector('#bmError');
  const messages = {
    bank: 'Please choose the bank account you sent the payment to.',
    sender: 'Please enter the sender name exactly as it appears on the payment.',
    file: 'Please attach a clear payment receipt before submitting.',
    card: 'We could not submit this payment right now. Please check your details and try again.'
  };
  if (error) {
    error.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i><span>${messages[area] || messages.card}</span>`;
    error.classList.add('show');
  }

  // Also mark the step wrapper so the number + title go red.
  const step = target.closest('.bm-step');
  if (step) step.classList.add('bm-invalid');

  try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
  if (area === 'sender') {
    const input = overlay.querySelector('#bmSenderName');
    if (input && document.activeElement !== input) input.focus({ preventScroll: true });
  }
}

// ============================================================================
// SCROLL LOCK
// ============================================================================

function lockBodyScroll() {
  if (bodyScrollLocked) return;
  bodyScrollLocked = true;
  document.body.classList.add('bm-modal-open');
}
function unlockBodyScroll() {
  if (!bodyScrollLocked) return;
  bodyScrollLocked = false;
  document.body.classList.remove('bm-modal-open');
}

// ============================================================================
// OPEN / CLOSE
// ============================================================================

function titleCase(s) {
  return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
}

function setAmount(price) {
  const amountEl = overlay.querySelector('#bmAmount');
  if (!price || price === 'Loading…') {
    amountEl.innerHTML = '<span class="bm-skeleton bm-skeleton-amount"></span>';
  } else {
    amountEl.textContent = price;
  }
}

function openModal(offer) {
  activeOffer = offer;
  selectedFile = null;
  selectedBankAccountId = null;

  overlay.querySelector('#bmSumType').textContent = titleCase(offer.typeLabel || offer.type || 'Offer');
  overlay.querySelector('#bmOfferName').textContent = offer.name || 'This item';
  setAmount(offer.price);

  overlay.querySelector('#bmSenderName').value = '';
  overlay.querySelector('#bmFileInputGallery').value = '';
  overlay.querySelector('#bmFileInputCamera').value = '';
  overlay.querySelector('#bmUploadChoices').style.display = '';
  overlay.querySelector('#bmPreviewCard').style.display = 'none';

  overlay.querySelector('#bmSuccessPanel').classList.remove('show', 'bm-wiped', 'bm-pre', 'bm-stagger');
  overlay.querySelector('#bmSuccessPanel').style.display = 'none';
  overlay.querySelector('.bm-main-inner').style.display = '';

  clearInvalid();
  loadBankList();
  overlay.classList.add('show');
  lockBodyScroll();

  setTimeout(() => {
    const closeBtn = overlay.querySelector('#bmCloseBtn');
    if (closeBtn) closeBtn.focus({ preventScroll: true });
  }, 60);
}

function closeModal() {
  overlay.classList.remove('show');
  clearInvalid();
  unlockBodyScroll();
}

// ============================================================================
// BANK LIST
// ============================================================================

function loadBankList() {
  const list = overlay.querySelector('#bmBankList');
  list.innerHTML = `
    <div class="bm-skeleton-bank-row">
      <div class="bm-skeleton bm-skeleton-logo"></div>
      <div class="bm-skeleton-lines">
        <div class="bm-skeleton bm-skeleton-line"></div>
        <div class="bm-skeleton bm-skeleton-line short"></div>
      </div>
    </div>
    <div class="bm-skeleton-bank-row">
      <div class="bm-skeleton bm-skeleton-logo"></div>
      <div class="bm-skeleton-lines">
        <div class="bm-skeleton bm-skeleton-line"></div>
        <div class="bm-skeleton bm-skeleton-line short"></div>
      </div>
    </div>
  `;

  getBankAccounts().then((accounts) => {
    if (!accounts.length) {
      list.innerHTML = `<div class="bm-note" style="margin:0;">No bank accounts are set up yet — please contact support.</div>`;
      return;
    }
    list.innerHTML = accounts.map((a) => `
      <div class="bm-bank-row" data-id="${a.id}" role="button" tabindex="0">
        <img class="bm-bank-logo" src="${a.logoUrl || ''}" onerror="this.style.visibility='hidden'" alt="" />
        <div class="bm-bank-info">
          <div class="bm-bank-name">${a.bankName || 'Bank'}</div>
          ${a.accountName ? `<div class="bm-bank-holder"><span class="bm-bank-holder-label">Account holder:</span> ${a.accountName}</div>` : ''}
          <div class="bm-bank-number">
            <span>${a.accountNumber || ''}</span>
            <button type="button" class="bm-bank-copy" data-copy="${a.accountNumber || ''}">Copy</button>
          </div>
        </div>
        <div class="bm-bank-radio"></div>
      </div>
    `).join('');

    list.querySelectorAll('.bm-bank-row').forEach((row) => {
      const pick = () => {
        selectedBankAccountId = row.dataset.id;
        list.querySelectorAll('.bm-bank-row').forEach((r) => r.classList.toggle('selected', r === row));
        // Fixed → clear the invalid highlight immediately.
        list.classList.remove('bm-invalid');
        const step = list.closest('.bm-step');
        if (step) step.classList.remove('bm-invalid');
      };
      row.addEventListener('click', (e) => {
        if (e.target.closest('.bm-bank-copy')) return;
        pick();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });

    list.querySelectorAll('.bm-bank-copy').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const copyText = btn.dataset.copy || '';
        const done = () => {
          btn.classList.add('copied');
          const original = btn.textContent;
          btn.textContent = 'Copied';
          setTimeout(() => { btn.classList.remove('copied'); btn.textContent = original; }, 1400);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(copyText).then(done).catch(done);
        } else {
          const ta = document.createElement('textarea');
          ta.value = copyText;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (err) {}
          document.body.removeChild(ta);
          done();
        }
      });
    });
  });
}

// ============================================================================
// FILE HANDLING
// ============================================================================

function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function handleFileSelected(file) {
  if (!file) return;
  selectedFile = file;
  overlay.querySelector('#bmUploadChoices').style.display = 'none';
  overlay.querySelector('#bmPreviewName').textContent = file.name || 'Receipt';
  overlay.querySelector('#bmPreviewSize').textContent = formatFileSize(file.size);
  const previewCard = overlay.querySelector('#bmPreviewCard');
  const preview = overlay.querySelector('#bmPreview');
  const reader = new FileReader();
  reader.onload = (ev) => {
    preview.src = ev.target.result;
    previewCard.style.display = '';
  };
  reader.readAsDataURL(file);
  // Fixed → clear the invalid highlight on the upload field.
  overlay.querySelector('#bmUploadField').classList.remove('bm-invalid');
  const step = overlay.querySelector('#bmUploadField').closest('.bm-step');
  if (step) step.classList.remove('bm-invalid');
}

overlay.querySelector('#bmFileInputGallery').addEventListener('change', (e) => {
  handleFileSelected(e.target.files && e.target.files[0]);
});
overlay.querySelector('#bmFileInputCamera').addEventListener('change', (e) => {
  handleFileSelected(e.target.files && e.target.files[0]);
});
overlay.querySelector('#bmRemoveFileBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  selectedFile = null;
  overlay.querySelector('#bmFileInputGallery').value = '';
  overlay.querySelector('#bmFileInputCamera').value = '';
  overlay.querySelector('#bmPreviewCard').style.display = 'none';
  overlay.querySelector('#bmUploadChoices').style.display = '';
});

// Live-clear the sender invalid state as soon as the user types.
overlay.querySelector('#bmSenderName').addEventListener('input', (e) => {
  if (e.target.value.trim()) {
    const field = overlay.querySelector('#bmSenderField');
    field.classList.remove('bm-invalid');
    const step = field.closest('.bm-step');
    if (step) step.classList.remove('bm-invalid');
  }
});

// ============================================================================
// NAVIGATION
// ============================================================================

overlay.querySelector('#bmCloseBtn').addEventListener('click', closeModal);
overlay.querySelector('#bmCancelBtn').addEventListener('click', closeModal);
overlay.querySelector('#bmDoneBtn').addEventListener('click', closeModal);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlay.classList.contains('show')) {
    closeModal();
  }
});

// ============================================================================
// SUBMIT
// ============================================================================

overlay.querySelector('#bmSubmitBtn').addEventListener('click', async () => {
  clearInvalid();

  const senderName = overlay.querySelector('#bmSenderName').value.trim();
  if (!selectedBankAccountId) return flagInvalid('bank');
  if (!senderName) return flagInvalid('sender');
  if (!selectedFile) return flagInvalid('file');

  let student = getCurrentStudent();
  if (!student.id || student.guest) return flagInvalid('card');
  student = await enrichStudentIdentity(student);

  const submitBtn = overlay.querySelector('#bmSubmitBtn');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="bm-spinner"></span><span>Submitting</span>';

  try {
    const accounts = await getBankAccounts();
    const bankAccount = accounts.find((a) => a.id === selectedBankAccountId);

    const { telegramFileId, telegramMessageId } = await sendReceiptToTelegram({
      offer: activeOffer, senderName, file: selectedFile, student, bankAccount,
    });

    const myUid = await getAuthUidAsync();
    if (!myUid) throw new Error('Please sign in again before paying.');
    await addDoc(collection(db, CONFIG.firestoreCollection), {
      uid: myUid,
      offerName: activeOffer.name || null,
      offerPrice: activeOffer.price || null,
      offerType: activeOffer.type || 'package',
      senderName,
      bankAccountId: selectedBankAccountId,
      bankName: bankAccount ? bankAccount.bankName : null,
      bankAccountName: bankAccount ? bankAccount.accountName : null,
      bankAccountNumber: bankAccount ? bankAccount.accountNumber : null,
      telegramFileId: telegramFileId || null,
      telegramMessageId: telegramMessageId || null,
      // Human-facing student ID; fall back to the internal record key only
      // for legacy data that truly has no separate student ID.
      studentId: student.studentId || null,
      studentRecordId: student.id || null,
      studentName: student.name || null,
      studentBatch: student.batch || null,
      studentEmail: student.email || null,
      status: 'pending',
      createdAt: serverTimestamp(),
    });

    PENDING_KEYS.add(`${activeOffer.type || 'package'}::${(activeOffer.name || '').trim()}`);

    // Swap the form for the success panel behind a smooth left-to-right wipe.
    const successPanel = overlay.querySelector('#bmSuccessPanel');
    await playSuccessWipe(() => {
      overlay.querySelector('.bm-main-inner').style.display = 'none';
      successPanel.style.display = 'flex';
      successPanel.classList.add('show');
    }, successPanel);
  } catch (e) {
    console.error('[buy-modal] submission failed', e);
    flagInvalid('card');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<span>Submit</span><i class="fa-solid fa-arrow-right bm-btn-arrow"></i>';
  }
});


// ============================================================================
// SUCCESS WIPE — a curtain sweeps across the page left -> right; the form is swapped for the
// success panel while the screen is fully covered, then the curtain exits right and the
// success content rises in.
// ============================================================================
function bmAnimate(el, keyframes, options) {
  return new Promise((resolve) => {
    try {
      const a = el.animate(keyframes, { fill: 'forwards', ...options });
      a.onfinish = () => resolve(a);
      a.oncancel = () => resolve(a);
    } catch (_) { resolve(null); }
  });
}

async function playSuccessWipe(swap, panel) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || typeof Element.prototype.animate !== 'function') { swap(); return; }

  const wrap = document.createElement('div');
  wrap.className = 'bm-wipe-wrap';
  wrap.innerHTML = '<div class="bm-wipe"><div class="bm-wipe-mark"><i class="fa-solid fa-circle-check"></i></div></div>';
  overlay.appendChild(wrap);
  const wipe = wrap.firstElementChild;
  const mark = wipe.firstElementChild;
  const EDGE = 'calc(-100% - 170px)';
  wipe.style.transform = `translateX(${EDGE})`;
  const ease = 'cubic-bezier(.65,0,.25,1)';

  // 1) curtain sweeps in from the left and covers the form
  await bmAnimate(wipe, [{ transform: `translateX(${EDGE})` }, { transform: 'translateX(0)' }], { duration: 620, easing: ease });

  // 2) swap content while fully covered, with a quick check-mark flourish
  swap();
  panel.classList.add('bm-wiped', 'bm-pre');
  const card = overlay.querySelector('.bm-card');
  if (card) card.scrollTop = 0;
  await bmAnimate(mark, [
    { opacity: 0, transform: 'scale(.55)' },
    { opacity: 1, transform: 'scale(1.08)', offset: .6 },
    { opacity: 1, transform: 'scale(1)' },
  ], { duration: 460, easing: 'cubic-bezier(.2,1.1,.3,1)' });
  await new Promise((r) => setTimeout(r, 140));

  // 3) curtain exits to the right; the success content rises in as it uncovers
  panel.classList.remove('bm-pre');
  panel.classList.add('bm-stagger');
  bmAnimate(mark, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 260, easing: 'ease-in' });
  await bmAnimate(wipe, [{ transform: 'translateX(0)' }, { transform: 'translateX(calc(100% + 170px))' }], { duration: 760, easing: ease });

  wrap.remove();
}

// ============================================================================
// LOCKED CONTENT — no card-level Buy buttons are injected.
// The only Buy action is inside the lock-state overlay below.
// ============================================================================


// ============================================================================
// LOCKED CARDS EVERYWHERE
// ============================================================================

const LOCKED_CARD_CONFIGS = [
  { selector: '.module-card.locked',  nameSel: '.module-name',  priceSel: null, type: 'module',  label: 'module'  },
  { selector: '.subject-card.locked', nameSel: '.subject-name', priceSel: null, type: 'subject', label: 'subject' },
  { selector: '.quiz-card.locked',    nameSel: 'h3',            priceSel: null, type: 'quiz',    label: 'quiz'    },
  { selector: '.pill.locked',         nameSel: null,            priceSel: null, type: 'quiz',    label: 'item'    },
  // Bundles (stored as offerType 'package'): the locked card on Home, and the locked button inside its details overlay.
  { selector: '.package-card.locked', nameSel: 'h4', priceSel: '.pk-price-now',  type: 'package', typeLabel: 'Bundle', label: 'bundle' },
  { selector: '.pkd-cta-btn.locked',  nameSel: 'h3', priceSel: '.pkd-price-now', type: 'package', typeLabel: 'Bundle', label: 'bundle', scopeSel: '#packageOverlayCard' },
];

// Where to read an item's name/price from: the card itself, or (for the details-overlay button) its overlay.
function cardRoot(card, config) {
  return config.scopeSel ? (card.closest(config.scopeSel) || card) : card;
}
const LOCKED_CARD_SELECTOR = LOCKED_CARD_CONFIGS.map((c) => c.selector).join(', ');

const pkgLockOverlay = document.createElement('div');
pkgLockOverlay.className = 'lock-overlay';
pkgLockOverlay.id = 'bmPackageLockOverlay';
pkgLockOverlay.innerHTML = `
  <div class="lock-overlay-icons" aria-hidden="true">
    <div class="lock-overlay-icon"><i class="fa-solid fa-lock"></i></div>
    <div class="lock-overlay-icon"><i class="fa-solid fa-receipt"></i></div>
    <div class="lock-overlay-icon"><i class="fa-solid fa-star"></i></div>
  </div>
  <div class="lock-overlay-message" id="bmPkgLockMsg" style="cursor:default;">
    <span id="bmPkgLockMsgText"></span>
    <button type="button" class="bm-cta-btn" id="bmPkgLockBuyBtn" style="margin-top:14px;">
      <i class="fa-solid fa-lock-open"></i>&nbsp; Buy this
    </button>
  </div>
  <div class="lock-overlay-hint">Tap anywhere to close</div>
`;
document.body.appendChild(pkgLockOverlay);

let pendingCardOffer = null;

function openPkgLockOverlay(offer) {
  pendingCardOffer = offer;
  const buyBtn = pkgLockOverlay.querySelector('#bmPkgLockBuyBtn');
  if (offer.pending) {
    pkgLockOverlay.querySelector('#bmPkgLockMsgText').textContent = `${offer.name} — your payment is pending review.`;
    buyBtn.style.display = 'none';
  } else {
    pkgLockOverlay.querySelector('#bmPkgLockMsgText').textContent = `${offer.name} is locked.`;
    buyBtn.style.display = '';
    buyBtn.innerHTML = `<i class="fa-solid fa-lock-open"></i>&nbsp; Buy this ${offer.label}`;
  }
  pkgLockOverlay.classList.add('show');
}
function closePkgLockOverlay() { pkgLockOverlay.classList.remove('show'); }

pkgLockOverlay.addEventListener('click', (e) => { if (e.target === pkgLockOverlay) closePkgLockOverlay(); });
pkgLockOverlay.querySelector('#bmPkgLockMsg').addEventListener('click', (e) => e.stopPropagation());
pkgLockOverlay.querySelector('#bmPkgLockBuyBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const offer = pendingCardOffer;
  closePkgLockOverlay();
  if (!offer || offer.pending) return;
  openModal(offer);
});

async function getCardOfferInfo(card, config) {
  const root = cardRoot(card, config);
  const name = (config.nameSel ? (root.querySelector(config.nameSel) || {}).textContent : card.textContent) || 'This item';
  const trimmedName = name.trim();

  if (config.type === 'package') {
    let price = root.getAttribute('data-price');
    if (!price && config.priceSel) {
      const priceEl = root.querySelector(config.priceSel);
      if (priceEl) price = priceEl.textContent.trim();
    }
    return { name: trimmedName, price: price || 'Contact for price', type: config.type, typeLabel: config.typeLabel, label: config.label };
  }

  const dataPrice = card.getAttribute('data-price');
  const price = dataPrice || await lookupPrice(config.type, trimmedName);
  return { name: trimmedName, price, type: config.type, label: config.label };
}

document.addEventListener(
  'click',
  (e) => {
    // "View offer" on a bundle card keeps opening the bundle's details; the rest of a locked bundle card buys.
    if (e.target.closest && e.target.closest('.package-card .pk-cta')) return;
    const card = e.target.closest && e.target.closest(LOCKED_CARD_SELECTOR);
    if (!card) return;
    const config = LOCKED_CARD_CONFIGS.find((c) => card.matches(c.selector));
    if (!config) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const root = cardRoot(card, config);
    const name = (config.nameSel ? (root.querySelector(config.nameSel) || {}).textContent : card.textContent) || 'This item';
    const trimmedName = name.trim();

    if (isPending(config.type, trimmedName)) {
      openPkgLockOverlay({ name: trimmedName, price: '', type: config.type, typeLabel: config.typeLabel, label: config.label, pending: true });
      return;
    }

    openPkgLockOverlay({ name: trimmedName, price: 'Loading…', type: config.type, typeLabel: config.typeLabel, label: config.label });

    getCardOfferInfo(card, config).then((offer) => {
      pendingCardOffer = offer;
      const msgEl = pkgLockOverlay.querySelector('#bmPkgLockMsgText');
      if (pkgLockOverlay.classList.contains('show')) {
        msgEl.textContent = `${offer.name} is locked.`;
      }
      if (activeOffer && activeOffer.name === offer.name && activeOffer.type === offer.type) {
        activeOffer.price = offer.price;
        setAmount(offer.price);
      }
    });
  },
  true
);
