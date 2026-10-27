/* ========================================================================
   ALIF Med — just-in-time migration for legacy students

   Migration proof / access source:
   - The old browser session is used only to identify the legacy student
     record that is being migrated. It is NOT trusted as an access ledger.
   - The migration re-reads the student's legacy record and the catalog
     directly from Firestore after Firebase Authentication succeeds.
   - Program Access is interpreted exactly like the admin Program Access
     screen: only explicit per-student overrides count as personal access;
     catalog defaults such as locked=false are not migrated.
   - An explicitly unlocked/enrolled module means full enrollment in that
     module. Explicit bundle enrollment expands to its module/subject scope.
   - The old secretkey is retained only as a one-time migration proof, not as
     a login credential. The Firestore rule validates the link.
   - The student then authenticates with a real Firebase email/password.
   - Existing access is materialized into access/{uid}/resources/{resourceKey}.

   This is deliberately a one-time bridge. Once completed, the legacy
   credential/session is deleted from the browser and runtime access no longer
   consults legacy userLocks.
   ======================================================================== */
import { LSC } from './cache.js';
import { loadStudentForUser, storeStudent, clearStudent } from './auth.js';
import { db } from './firebase-config.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendEmailVerification, deleteUser
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  collection, doc, getDoc, getDocs, query, setDoc, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const auth = getAuth(getApp());
const LEGACY_STUDENT_KEY = 'atlas_student_v1';
const LEGACY_CACHE_KEY = 'atlas_secretkeys_cache';

let catalogPromise = null;
let activeModal = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normEmail = (s) => String(s || '').trim().toLowerCase();
const toMs = (v) => !v ? 0 : v?.toMillis?.() || (v?.seconds != null ? Number(v.seconds) * 1000 : Number(v) || 0);

function getLegacyCandidate() {
  const direct = LSC.get(LEGACY_STUDENT_KEY);
  if (direct?.id && direct?.secretkey) return { id: direct.id, ...direct };
  const roster = LSC.get(LEGACY_CACHE_KEY);
  if (roster && typeof roster === 'object') {
    for (const value of Object.values(roster)) {
      if (value?.id && value?.secretkey) return { id: value.id, ...value };
    }
  }
  return null;
}

export function getLegacyMigrationCandidate() {
  // Any legacy record with its old key can migrate, even if it was linked to
  // another account before: the new sign-in simply takes over the link.
  return getLegacyCandidate();
}

async function loadCatalog() {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const readCol = async (name) => (await getDocs(collection(db, name))).docs.map(d => ({ id: d.id, ...d.data() }));
    const [modules, subjects, packages] = await Promise.all([
      readCol('modules'), readCol('subjects'), readCol('packages')
    ]);
    const quizzes = [];
    for (const subject of subjects) {
      const snap = await getDocs(collection(db, 'subjects', subject.id, 'quizzes'));
      snap.forEach(d => quizzes.push({ id: d.id, ...d.data(), subjectId: subject.id, subjectName: subject.name || '' }));
    }
    return { modules, subjects, packages, quizzes };
  })();
  return catalogPromise;
}

function classifyValue(v) {
  if (v === true) return 'deny';
  if (v === false || v === 'enrolled') return 'allow';
  return null;
}

function explicitValue(map, id) {
  if (!map || !Object.prototype.hasOwnProperty.call(map, id)) return null;
  return classifyValue(map[id]);
}

function expiryFor(item, studentId) {
  const values = [];
  const add = (value) => {
    const ms = toMs(value);
    if (ms) values.push(ms);
  };
  add(item?.userExpiry?.[studentId]);
  return values.length ? Math.max(...values) : 0;
}

function resourceLabel(catalog, type, id) {
  const list = type === 'module' ? catalog.modules : type === 'subject' ? catalog.subjects : type === 'quiz' ? catalog.quizzes : catalog.packages;
  const found = list.find(x => x.id === id);
  return found?.name || found?.title || id;
}

/*
 * IMPORTANT MIGRATION RULE:
 * The catalog's `locked: false` / `locked: 'default'` state is PUBLIC/default
 * access. It is NOT evidence that a particular student purchased or was
 * enrolled in that program.
 *
 * We only migrate explicit student-specific Firestore grants from the same
 * places the admin Program Access view inspects:
 *   1) secretkeys/{studentId}.userLocks[resourceId]
 *   2) modules/{id}.userLocks[studentId]
 *   3) subjects/{id}.userLocks[studentId]
 *   4) subjects/{subjectId}/quizzes/{id}.userLocks[studentId]
 *   5) packages/{bundleId}.userLocks[studentId] === 'enrolled'
 *      or the legacy package-manager grant on the student record.
 *
 * An explicitly unlocked/enrolled MODULE means full enrollment in that
 * module. The runtime access service already inherits module access down to
 * its subjects/quizzes, so we intentionally do not materialize every child.
 */
function collectLegacyAccessFromFirestore(legacyStudent, catalog) {
  const sid = legacyStudent.id;
  const grants = new Map();
  const keyFor = (type, id) => `${type}_${id}`;

  const priorityOf = (sourceType) => sourceType === 'legacyCatalogOverride' ? 30
    : sourceType === 'legacyBundle' ? 20
    : 10;

  const put = ({ type, id, mode, expiresAt = 0, sourceType = 'legacyProgramAccess', sourceId = null, sourceLabel = 'Legacy program access' }) => {
    if (!id || !mode) return;
    const key = keyFor(type, id);
    const next = {
      resourceType: type,
      resourceId: id,
      resourceLabel: resourceLabel(catalog, type, id),
      mode,
      status: 'active',
      expiresAt: expiresAt || null,
      sourceType,
      sourceId,
      sourceLabel,
      _priority: priorityOf(sourceType)
    };
    const existing = grants.get(key);
    if (!existing) {
      grants.set(key, next);
      return;
    }

    // Mirror Program Access precedence: an explicit resource.userLocks value
    // wins over the student's generic legacy map; bundle-derived access sits
    // between those two. This prevents a generic student-map value from
    // overriding a specific module/subject/quiz decision shown by the admin.
    if (next._priority > (existing._priority || 0)) {
      grants.set(key, next);
      return;
    }
    if (next._priority < (existing._priority || 0)) return;

    // At the same priority, an explicit deny wins. Two allows merge to the
    // longest expiry so a bundle cannot shorten a separately granted period.
    if (existing.mode === 'deny' || next.mode === 'deny') {
      if (next.mode === 'deny') grants.set(key, next);
      return;
    }
    const a = toMs(existing.expiresAt), b = toMs(next.expiresAt);
    const mergedExpiry = (!a || !b) ? null : Math.max(a, b);
    grants.set(key, { ...existing, expiresAt: mergedExpiry });
  };

  const studentOverrides = legacyStudent.userLocks || {};

  // 1) Explicit per-student overrides stored on the student record.
  //    This includes old direct module/subject/quiz grants and old bundle grants.
  for (const [rid, raw] of Object.entries(studentOverrides)) {
    const mode = classifyValue(raw);
    if (!mode) continue;

    const module = catalog.modules.find(x => x.id === rid);
    if (module) {
      put({
        type: 'module', id: rid, mode,
        expiresAt: expiryFor(module, sid),
        sourceId: rid,
        sourceLabel: mode === 'allow' ? 'Legacy Program Access · module' : 'Legacy Program Access · module block'
      });
      continue;
    }

    const subject = catalog.subjects.find(x => x.id === rid);
    if (subject) {
      put({
        type: 'subject', id: rid, mode,
        expiresAt: expiryFor(subject, sid),
        sourceId: rid,
        sourceLabel: mode === 'allow' ? 'Legacy direct subject access' : 'Legacy subject block'
      });
      continue;
    }

    const quiz = catalog.quizzes.find(x => x.id === rid);
    if (quiz) {
      put({
        type: 'quiz', id: rid, mode,
        expiresAt: expiryFor(quiz, sid),
        sourceId: rid,
        sourceLabel: mode === 'allow' ? 'Legacy direct quiz access' : 'Legacy quiz block'
      });
      continue;
    }

    const bundle = catalog.packages.find(x => x.id === rid);
    if (bundle) {
      if (mode === 'allow') {
        expandBundle(bundle, put, 'Legacy bundle access', expiryFor(bundle, sid));
      } else {
        addBundleDeny(bundle, put, expiryFor(bundle, sid));
      }
    }
  }

  // 2) The admin Program Access screen explicitly overlays resource.userLocks
  //    over the student record. Mirror that precedence for each resource.
  for (const module of catalog.modules) {
    const mode = explicitValue(module.userLocks, sid);
    if (!mode) continue;
    put({
      type: 'module', id: module.id, mode,
      expiresAt: expiryFor(module, sid),
      sourceType: 'legacyCatalogOverride',
      sourceId: module.id,
      sourceLabel: mode === 'allow' ? 'Legacy Program Access · module' : 'Legacy Program Access · module block'
    });
  }

  for (const subject of catalog.subjects) {
    const mode = explicitValue(subject.userLocks, sid);
    if (!mode) continue;
    put({
      type: 'subject', id: subject.id, mode,
      expiresAt: expiryFor(subject, sid),
      sourceType: 'legacyCatalogOverride',
      sourceId: subject.id,
      sourceLabel: mode === 'allow' ? 'Legacy Program Access · subject' : 'Legacy Program Access · subject block'
    });
  }

  for (const quiz of catalog.quizzes) {
    const mode = explicitValue(quiz.userLocks, sid);
    if (!mode) continue;
    put({
      type: 'quiz', id: quiz.id, mode,
      expiresAt: expiryFor(quiz, sid),
      sourceType: 'legacyCatalogOverride',
      sourceId: quiz.id,
      sourceLabel: mode === 'allow' ? 'Legacy Program Access · quiz' : 'Legacy Program Access · quiz block'
    });
  }

  // 3) Bundle enrollment is a distinct explicit relationship in the current
  //    admin Bundles screen. `enrolled` is real membership; catalog defaults
  //    are deliberately ignored.
  for (const bundle of catalog.packages) {
    const packageValue = bundle.userLocks?.[sid];
    const oldStudentValue = studentOverrides[bundle.id];
    const explicitlyEnrolled = packageValue === 'enrolled' || oldStudentValue === false || oldStudentValue === 'enrolled';
    if (!explicitlyEnrolled) continue;
    expandBundle(bundle, put, 'Legacy bundle enrollment', expiryFor(bundle, sid));
  }

  return [...grants.values()];
}

function expandBundle(bundle, put, sourceLabel, expiresAt = 0) {
  if (!bundle) return;
  const label = bundle.name || 'Bundle';
  for (const moduleId of bundle.moduleIds || []) {
    if (!moduleId) continue;
    put({ type: 'module', id: moduleId, mode: 'allow', expiresAt, sourceType: 'legacyBundle', sourceId: bundle.id, sourceLabel: `${label} · ${sourceLabel}` });
  }
  // A bundle may contain selected subjects without owning the whole module.
  // Materialize those subjects, but do not materialize every quiz underneath.
  for (const subjectId of bundle.subjectIds || []) {
    if (!subjectId) continue;
    put({ type: 'subject', id: subjectId, mode: 'allow', expiresAt, sourceType: 'legacyBundle', sourceId: bundle.id, sourceLabel: `${label} · ${sourceLabel}` });
  }
}

function addBundleDeny(bundle, put, expiresAt = 0) {
  if (!bundle) return;
  const label = bundle.name || 'Bundle';
  for (const moduleId of bundle.moduleIds || []) {
    put({ type: 'module', id: moduleId, mode: 'deny', expiresAt, sourceType: 'legacyBundle', sourceId: bundle.id, sourceLabel: `${label} · legacy bundle block` });
  }
  for (const subjectId of bundle.subjectIds || []) {
    put({ type: 'subject', id: subjectId, mode: 'deny', expiresAt, sourceType: 'legacyBundle', sourceId: bundle.id, sourceLabel: `${label} · legacy bundle block` });
  }
}

function summarizeEntitlements(entitlements, catalog) {
  const active = entitlements.filter(g => g.mode === 'allow');
  const directModules = new Set(active.filter(g => g.resourceType === 'module').map(g => g.resourceId));
  const directSubjects = new Set(active.filter(g => g.resourceType === 'subject').map(g => g.resourceId));
  const directQuizzes = new Set(active.filter(g => g.resourceType === 'quiz').map(g => g.resourceId));
  const bundleNames = [...new Set(active.filter(g => g.sourceType === 'legacyBundle').map(g => String(g.sourceLabel || '').split(' · ')[0]).filter(Boolean))].slice(0, 6);
  const moduleNames = [...directModules].map(id => resourceLabel(catalog, 'module', id)).slice(0, 8);
  const subjectNames = [...directSubjects].map(id => resourceLabel(catalog, 'subject', id)).slice(0, 5);
  return {
    moduleNames,
    subjectNames,
    bundleNames,
    counts: { modules: directModules.size, subjects: directSubjects.size, quizzes: directQuizzes.size, bundles: bundleNames.length },
    total: active.length
  };
}

function ensureStyles() {
  if (document.getElementById('legacyMigrationStyles')) return;
  const style = document.createElement('style');
  style.id = 'legacyMigrationStyles';
  style.textContent = `
    /* ===== Clean glass — same language as the payment sheet ===== */
    .lm-overlay{--acc-hi:color-mix(in srgb,var(--artery) 55%,#fff);--g-line:rgba(255,255,255,.55);--g-line-soft:rgba(255,255,255,.22);
      position:fixed;inset:0;z-index:9000;display:flex;align-items:flex-end;justify-content:center;
      background:radial-gradient(520px 360px at 12% 6%,color-mix(in srgb,var(--artery) 15%,transparent),transparent 70%),radial-gradient(560px 420px at 92% 96%,color-mix(in srgb,var(--artery) 13%,transparent),transparent 70%),rgba(255,255,255,.10);
      -webkit-backdrop-filter:blur(22px) saturate(140%);backdrop-filter:blur(22px) saturate(140%);animation:lmFade .3s ease both}
    body.dark .lm-overlay{--acc-hi:color-mix(in srgb,var(--artery) 70%,#fff);--g-line:rgba(255,255,255,.18);--g-line-soft:rgba(255,255,255,.06);
      background:radial-gradient(520px 360px at 12% 6%,color-mix(in srgb,var(--artery) 10%,transparent),transparent 70%),radial-gradient(560px 420px at 92% 96%,color-mix(in srgb,var(--artery) 12%,transparent),transparent 70%),rgba(0,0,0,.34)}
    .lm-overlay,.lm-overlay *{box-sizing:border-box}
    .lm-panel{position:relative;width:100%;max-width:456px;max-height:94vh;overflow:auto;color:var(--ink);padding:26px 22px calc(24px + env(safe-area-inset-bottom,0px));
      background:linear-gradient(180deg,rgba(255,255,255,.26) 0%,rgba(255,255,255,.08) 100%);
      -webkit-backdrop-filter:blur(40px) saturate(160%);backdrop-filter:blur(40px) saturate(160%);
      border:1px solid var(--g-line);border-bottom:none;border-radius:30px 30px 0 0;
      box-shadow:0 30px 80px -30px rgba(0,0,0,.30),0 0 60px -30px color-mix(in srgb,var(--artery) 40%,transparent),inset 0 1.5px 0 color-mix(in srgb,var(--acc-hi) 75%,transparent),inset 0 -1px 0 rgba(255,255,255,.14);
      animation:lmRise .55s cubic-bezier(.2,1.1,.3,1) both;scrollbar-width:thin;scrollbar-color:rgba(128,128,128,.35) transparent}
    body.dark .lm-panel{background:linear-gradient(180deg,rgba(255,255,255,.08) 0%,rgba(255,255,255,.02) 100%);
      box-shadow:0 30px 80px -30px rgba(0,0,0,.65),0 0 60px -30px color-mix(in srgb,var(--artery) 28%,transparent),inset 0 1.5px 0 color-mix(in srgb,var(--acc-hi) 40%,transparent),inset 0 -1px 0 rgba(255,255,255,.04)}
    @media(min-width:640px){.lm-overlay{align-items:center;padding:18px}.lm-panel{border-radius:30px;border-bottom:1px solid var(--g-line-soft);padding:30px 28px 28px}}

    .lm-head{display:flex;align-items:flex-start;gap:14px;padding-right:2px}
    .lm-icon,.lm-welcome,.lm-access,.lm-field input,.lm-chip,.lm-close,.lm-eye,.lm-secondary{
      background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.55);box-shadow:inset 0 1.5px 0 rgba(255,255,255,.6),0 8px 20px -16px rgba(0,0,0,.25)}
    body.dark .lm-icon,body.dark .lm-welcome,body.dark .lm-access,body.dark .lm-field input,body.dark .lm-chip,body.dark .lm-close,body.dark .lm-eye,body.dark .lm-secondary{
      background:rgba(255,255,255,.045);border-color:rgba(255,255,255,.14);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 8px 20px -16px rgba(0,0,0,.55)}
    .lm-icon{width:48px;height:48px;flex:none;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:19px;color:var(--artery);border-color:color-mix(in srgb,var(--artery) 55%,transparent)}
    .lm-kicker{font:700 10px/1.2 'JetBrains Mono',monospace;letter-spacing:.14em;color:var(--artery)}
    .lm-title{font:700 26px/1.1 'Fraunces',Georgia,serif;letter-spacing:-.01em;color:var(--ink);margin:6px 0 0}
    .lm-title::after{content:'';display:block;width:36px;height:2px;margin-top:9px;border-radius:2px;background:linear-gradient(90deg,color-mix(in srgb,var(--artery) 90%,transparent),color-mix(in srgb,var(--acc-hi) 10%,transparent))}
    .lm-sub{font-size:13px;line-height:1.55;color:var(--ink-soft);margin:10px 0 0}
    .lm-close{margin-left:auto;flex:none;width:34px;height:34px;border-radius:50%;color:var(--ink-soft);cursor:pointer;display:flex;align-items:center;justify-content:center}
    .lm-welcome{display:flex;gap:12px;align-items:center;margin-top:20px;padding:12px 14px;border-radius:18px}
    .lm-avatar{width:40px;height:40px;border-radius:13px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff;background:linear-gradient(135deg,var(--acc-hi),var(--artery));box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 6px 14px -8px color-mix(in srgb,var(--artery) 60%,transparent)}
    .lm-welcome b{font-size:13.5px;color:var(--ink)}.lm-welcome span{display:block;font-size:11px;color:var(--ink-faint);margin-top:2px}
    .lm-access{margin-top:12px;border-radius:18px;padding:14px;background:radial-gradient(90% 150% at 0% 0%,color-mix(in srgb,var(--artery) 12%,transparent),transparent 62%),rgba(255,255,255,.14);border-top-color:color-mix(in srgb,var(--acc-hi) 70%,transparent)}
    body.dark .lm-access{background:radial-gradient(90% 150% at 0% 0%,color-mix(in srgb,var(--artery) 10%,transparent),transparent 62%),rgba(255,255,255,.045);border-top-color:color-mix(in srgb,var(--acc-hi) 30%,transparent)}
    .lm-access-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.lm-access-head strong{font-size:12px;color:var(--ink)}
    .lm-count{font:700 10px 'JetBrains Mono',monospace;letter-spacing:.04em;color:var(--artery);background:color-mix(in srgb,var(--artery) 12%,transparent);padding:4px 9px;border-radius:999px;white-space:nowrap}
    .lm-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
    .lm-chip{font-size:11px;font-weight:600;padding:6px 10px;border-radius:11px;color:var(--ink-soft);line-height:1.4}.lm-chip i{margin-right:6px;color:var(--artery)}.lm-chip.more{color:var(--ink-faint)}
    .lm-form{margin-top:18px}.lm-field{margin-bottom:13px}
    .lm-field label{display:block;font-size:11.5px;font-weight:700;color:var(--ink);margin:0 0 6px 2px}
    .lm-field input{width:100%;height:48px;border-radius:15px;padding:0 14px;color:var(--ink);font-size:14.5px;outline:none;font-family:inherit;transition:border-color .2s,box-shadow .2s}
    .lm-field input::placeholder{color:var(--ink-faint)}
    .lm-field input:focus{border-color:color-mix(in srgb,var(--artery) 80%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--artery) 16%,transparent),inset 0 1.5px 0 rgba(255,255,255,.9)}
    body.dark .lm-field input:focus{border-color:color-mix(in srgb,var(--artery) 65%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--artery) 12%,transparent)}
    .lm-field input[readonly]{opacity:.8;cursor:default}
    .lm-help{font-size:10.5px;line-height:1.5;color:var(--ink-faint);margin:6px 2px 0}
    .lm-pass{position:relative}.lm-pass input{padding-right:48px}
    .lm-eye{position:absolute;right:7px;top:7px;width:34px;height:34px;border-radius:11px;color:var(--ink-faint);cursor:pointer;display:flex;align-items:center;justify-content:center}
    .lm-status{display:none;align-items:flex-start;gap:9px;margin-top:12px;padding:11px 13px;border-radius:14px;font-size:12px;line-height:1.45;color:var(--wrong);background:var(--wrong-soft);border:1px solid color-mix(in srgb,var(--wrong) 28%,transparent)}
    .lm-status.show{display:flex}.lm-status::before{content:'!';flex:none;width:17px;height:17px;border-radius:50%;background:var(--wrong);color:#fff;font:800 11px/17px inherit;text-align:center;margin-top:1px}
    .lm-actions{display:flex;flex-direction:column;gap:9px;margin-top:18px}
    .lm-primary{position:relative;overflow:hidden;height:50px;border-radius:16px;cursor:pointer;font:800 14px inherit;color:var(--ink);background:rgba(255,255,255,.34);border:1px solid color-mix(in srgb,var(--artery) 80%,transparent);
      box-shadow:inset 0 1.5px 0 rgba(255,255,255,.85),0 14px 30px -16px color-mix(in srgb,var(--artery) 34%,transparent),0 8px 18px -14px rgba(0,0,0,.30);transition:transform .15s ease,opacity .2s}
    body.dark .lm-primary{background:rgba(255,255,255,.08);border-color:color-mix(in srgb,var(--artery) 55%,transparent);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 14px 30px -16px color-mix(in srgb,var(--artery) 24%,transparent)}
    .lm-primary::after{content:'';position:absolute;inset:0;transform:translateX(-120%);background:linear-gradient(100deg,transparent,color-mix(in srgb,var(--acc-hi) 45%,transparent),transparent);animation:lmSweep 3.6s ease-in-out infinite;pointer-events:none}
    .lm-primary:active{transform:scale(.985)}.lm-primary:disabled{opacity:.75;cursor:default}.lm-primary:disabled::after{animation:none;opacity:0}
    .lm-secondary{height:42px;border-radius:14px;cursor:pointer;font:700 12.5px inherit;color:var(--ink-soft)}
    .lm-note{font-size:10.5px;line-height:1.55;color:var(--ink-faint);margin-top:14px;text-align:center}
    .lm-success{display:flex;align-items:flex-start;gap:12px;padding:15px;border-radius:18px;font-size:12.5px;line-height:1.55;color:var(--ink);background:radial-gradient(90% 150% at 0% 0%,color-mix(in srgb,var(--artery) 14%,transparent),transparent 62%),rgba(255,255,255,.14);border:1px solid color-mix(in srgb,var(--artery) 45%,transparent);margin-top:16px}
    .lm-success i{margin-top:2px;font-size:18px;color:var(--artery);filter:drop-shadow(0 4px 10px color-mix(in srgb,var(--artery) 35%,transparent))}
    .lm-spin{display:inline-block;width:14px;height:14px;border:2px solid color-mix(in srgb,var(--ink) 22%,transparent);border-top-color:var(--ink);border-radius:50%;animation:lmSpin .7s linear infinite;vertical-align:-2px;margin-right:8px}
    @keyframes lmSpin{to{transform:rotate(360deg)}}
    @keyframes lmFade{from{opacity:0}to{opacity:1}}
    @keyframes lmRise{from{opacity:0;transform:translateY(34px) scale(.965)}to{opacity:1;transform:none}}
    @keyframes lmSweep{0%,55%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
    @media(prefers-reduced-motion:reduce){.lm-overlay,.lm-panel,.lm-primary::after{animation:none!important}}
    @supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.lm-panel{background:var(--card)}.lm-overlay{background:rgba(0,0,0,.45)}}
  `;
  document.head.appendChild(style);
}

function updateMigrationAccessSummary(summary) {
  const box = activeModal?.querySelector('#lmAccessBox');
  if (!box) return;
  const chips = [
    ...summary.moduleNames.map(n => `<span class="lm-chip"><i class="fa-solid fa-layer-group"></i>${esc(n)}</span>`),
    ...summary.bundleNames.map(n => `<span class="lm-chip"><i class="fa-solid fa-box-open"></i>${esc(n)}</span>`),
    ...summary.subjectNames.map(n => `<span class="lm-chip"><i class="fa-solid fa-book"></i>${esc(n)}</span>`)
  ];
  box.innerHTML = `<div class="lm-access-head"><strong>Existing access verified</strong><span class="lm-count">${summary.counts.modules} module${summary.counts.modules===1?'':'s'} · ${summary.counts.bundles} bundle${summary.counts.bundles===1?'':'s'}</span></div><div class="lm-chips">${chips.length ? chips.slice(0,10).join('') : '<span class="lm-chip"><i class="fa-solid fa-circle-info"></i>No paid or program access was found on your account. Free content stays open to everyone.</span>'}${chips.length>10?`<span class="lm-chip more">+${chips.length-10} more</span>`:''}</div>`;
}

function createModal(candidate, summary) {
  ensureStyles();
  const knownEmail = normEmail(candidate.email);
  const initials = String(candidate.name || 'Student').trim().split(/\s+/).slice(0,2).map(x => x[0]).join('').toUpperCase() || 'A';
  const overlay = document.createElement('div');
  overlay.className = 'lm-overlay';
  overlay.innerHTML = `<div class="lm-panel" role="dialog" aria-modal="true" aria-labelledby="lmTitle">
      <div class="lm-head"><div class="lm-icon"><i class="fa-solid fa-shield-halved"></i></div><div><div class="lm-kicker">WELCOME BACK</div><h2 class="lm-title" id="lmTitle">Secure your ALIF account</h2><p class="lm-sub">We found your ALIF account on this device. Sign in once and we’ll carry your current access over to your new, secure account.</p></div><button class="lm-close" type="button" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="lm-welcome"><div class="lm-avatar">${esc(initials)}</div><div><b>${esc(candidate.name || 'ALIF student')}</b><span>${esc(candidate.batch || candidate.ID || 'ALIF student')}</span></div></div>
      <div class="lm-access" id="lmAccessBox"><div class="lm-access-head"><strong>Your access</strong><span class="lm-count">Verified after sign-in</span></div><div class="lm-chips"><span class="lm-chip"><i class="fa-solid fa-shield-halved"></i>We’ll confirm your program access as soon as you sign in.</span></div></div>
      <div class="lm-form"><div class="lm-field"><label for="lmEmail">Email address</label><input id="lmEmail" type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" value="${esc(knownEmail)}" ${knownEmail?'readonly':''} placeholder="you@example.com"></div><div class="lm-field"><label for="lmPassword">Password</label><div class="lm-pass"><input id="lmPassword" type="password" autocomplete="current-password" placeholder="Enter your password"><button class="lm-eye" type="button" aria-label="Show password"><i class="fa-regular fa-eye"></i></button></div><div class="lm-help">New here? Choose a password with at least 8 characters. Already set one up? Enter it.</div></div><div class="lm-status" id="lmStatus" role="alert"></div><div class="lm-actions"><button class="lm-primary" id="lmContinue" type="button">Continue securely</button><button class="lm-secondary" id="lmSkip" type="button">Not now</button></div><div class="lm-note">Your old access key is never shown or kept again. From now on, your email and password are all you need.</div></div>
    </div>`;
  document.body.appendChild(overlay);
  activeModal = overlay;
  overlay.querySelector('.lm-close').onclick = () => closeMigrationModal(true);
  overlay.querySelector('#lmSkip').onclick = () => closeMigrationModal(true);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeMigrationModal(true); });
  overlay.querySelector('.lm-eye').onclick = () => {
    const input = overlay.querySelector('#lmPassword'); const show = input.type === 'password';
    input.type = show ? 'text' : 'password'; overlay.querySelector('.lm-eye').innerHTML = show ? '<i class="fa-regular fa-eye-slash"></i>' : '<i class="fa-regular fa-eye"></i>';
  };
  overlay.querySelector('#lmContinue').onclick = () => runMigration(candidate, summary);
  setTimeout(() => overlay.querySelector(knownEmail ? '#lmPassword' : '#lmEmail')?.focus(), 40);
  return overlay;
}

export function closeMigrationModal(skipped = false) {
  if (!activeModal) return;
  activeModal.remove(); activeModal = null;
  if (skipped) window.dispatchEvent(new CustomEvent('alif:legacy-migration-skipped'));
}

// Shared success tail: cache the student, drop the old browser credential,
// show the success state and tell the app the student is logged in.
function completeLogin(overlay, student) {
  storeStudent(student);
  LSC.remove(LEGACY_STUDENT_KEY);
  LSC.remove(LEGACY_CACHE_KEY);
  LSC.remove('atlas_dash_dismissed_v1');
  const ok = overlay.querySelector('.lm-form');
  if (ok) ok.innerHTML = `<div class="lm-success"><i class="fa-solid fa-circle-check"></i><div><b>Your account is secure.</b><br>Your existing ALIF access has been carried over. Your learning history remains on your account.</div></div>`;
  setTimeout(() => { closeMigrationModal(false); window.dispatchEvent(new CustomEvent('alif:legacy-migration-complete', { detail: { student } })); }, 700);
  return student;
}

async function runMigration(candidate, summary) {
  const overlay = activeModal; if (!overlay) return;
  const emailEl = overlay.querySelector('#lmEmail');
  const passEl = overlay.querySelector('#lmPassword');
  const btn = overlay.querySelector('#lmContinue');
  const status = overlay.querySelector('#lmStatus');
  const email = normEmail(emailEl?.value); const password = passEl?.value || '';
  const fail = (msg) => { status.textContent = msg; status.classList.add('show'); btn.disabled = false; btn.textContent = 'Continue securely'; };
  if (!email) return fail('Enter your email address.');
  if (candidate.email && normEmail(candidate.email) !== email) return fail('Please use the email already associated with this ALIF student account.');
  if (password.length < 8) return fail('Your password must be at least 8 characters.');
  btn.disabled = true; btn.innerHTML = '<span class="lm-spin"></span> Securing account…'; status.classList.remove('show');
  let createdNow = false, claimed = false;
  try {
    let user = auth.currentUser;
    if (user && normEmail(user.email) !== email) user = null;
    if (!user) {
      try { user = (await signInWithEmailAndPassword(auth, email, password)).user; }
      catch (e) {
        if (e.code !== 'auth/user-not-found' && e.code !== 'auth/invalid-credential') throw e;
        user = (await createUserWithEmailAndPassword(auth, email, password)).user;
        createdNow = true;
      }
    }

    // The sign-in succeeded. If this Firebase account is ALREADY linked to a
    // student record in Firestore (the source of truth), this is simply a
    // login, not a migration: log the student in instead of treating a stale
    // browser cache as a conflict.
    try {
      const linked = await loadStudentForUser(user);
      if (linked && linked.migrationState !== 'in_progress') return completeLogin(overlay, linked);
    } catch (e) {
      if (e?.code === 'account-disabled') throw e;
      // Any other lookup problem: fall through to the normal migration path.
    }

    // Re-read the candidate from local storage just before claiming it. The
    // migration is only allowed to consume the same legacy key/session the
    // user started with; the Firestore rule also validates that secretkey.
    const fresh = getLegacyCandidate();
    if (!fresh || fresh.id !== candidate.id || !fresh.secretkey) throw new Error('Your previous ALIF session is no longer available on this device. Please open the previous version of ALIF once, then try again.');
    if (fresh.email && normEmail(fresh.email) !== email) throw new Error('That email does not match the existing ALIF account.');

    // Claim the exact legacy student record first. The Firestore security rule
    // checks the old secretkey stored in the existing record, verifies the
    // authenticated email, and rejects an already-linked record. Browser data
    // therefore acts only as a one-time proof of which legacy record is being
    // claimed — it is NOT used to decide what content the student owns.
    await setDoc(doc(db, 'secretkeys', fresh.id), {
      secretkey: fresh.secretkey, // proof: must equal the stored key (checked by the rule)
      authUid: user.uid,
      email,
      source: 'legacyLinked',
      updatedAt: serverTimestamp()
    }, { merge: true });
    claimed = true;

    // Now that the record is linked, read its authoritative Firestore state.
    // Access reconstruction below uses only this fresh Firestore record plus
    // the live catalog, never the browser's cached userLocks.
    const legacySnap = await getDoc(doc(db, 'secretkeys', fresh.id));
    if (!legacySnap.exists()) throw new Error('The existing ALIF student record could not be found.');
    const firestoreLegacy = { id: legacySnap.id, docId: legacySnap.id, ...legacySnap.data() };
    if (firestoreLegacy.authUid !== user.uid) throw new Error('This ALIF account is linked to a different sign-in. Please contact your ALIF administrator.');

    const catalog = await loadCatalog();
    const grants = collectLegacyAccessFromFirestore(firestoreLegacy, catalog);
    const liveSummary = summarizeEntitlements(grants, catalog);
    updateMigrationAccessSummary(liveSummary);

    const existingUserSnap = await getDoc(doc(db, 'users', user.uid));
    if (existingUserSnap.exists()) {
      const existingProfile = existingUserSnap.data() || {};
      if (existingProfile.role && existingProfile.role !== 'student') throw new Error('This account is not a student account.');
      if (existingProfile.studentId && existingProfile.studentId !== fresh.id) throw new Error('This email is already linked to a different ALIF student account. Please contact your ALIF administrator.');
    }

    const userRef = doc(db, 'users', user.uid);
    await setDoc(userRef, {
      role: 'student', status: 'active', name: firestoreLegacy.name || user.displayName || '',
      email, batch: firestoreLegacy.batch || '', studentId: firestoreLegacy.id, source: 'legacyLinked',
      migrationState: 'in_progress', migrationVersion: 1, updatedAt: serverTimestamp()
    }, { merge: true });

    // `grants` was calculated above from the latest Firestore state.
    // Remove current access docs first only if this account is still in the
    // one-time migration state. We never touch access outside this UID.
    const existing = await getDocs(collection(db, 'access', user.uid, 'resources'));
    const ops = new Map();
    existing.forEach(d => ops.set(d.id, { kind: 'delete', ref: d.ref }));
    grants.forEach(g => ops.set(`${g.resourceType}_${g.resourceId}`, { kind: 'set', ref: doc(db, 'access', user.uid, 'resources', `${g.resourceType}_${g.resourceId}`), data: {
      ...Object.fromEntries(Object.entries(g).filter(([k]) => k !== '_priority')), updatedAt: serverTimestamp(), updatedBy: user.uid, migratedAt: serverTimestamp()
    }}));

    const entries = [...ops.values()];
    for (let i=0; i<entries.length; i+=400) {
      const batch = writeBatch(db);
      entries.slice(i,i+400).forEach(op => op.kind === 'delete' ? batch.delete(op.ref) : batch.set(op.ref, op.data, { merge: true }));
        await batch.commit();
    }

    await setDoc(doc(collection(db, 'accessHistory')), {
      studentId: fresh.id, action: 'migration', source: 'legacy',
      grantCount: grants.length, createdAt: serverTimestamp(), createdBy: user.uid
    });
    await setDoc(doc(db, 'users', user.uid), {
      migrationState: 'complete', migrationVersion: 1, updatedAt: serverTimestamp()
    }, { merge: true });

    try { await sendEmailVerification(user); } catch (_) {}
    const student = await loadStudentForUser(user);
    if (!student) throw new Error('Your account was secured, but we couldn’t load your profile. Please sign in again.');
    return completeLogin(overlay, student);
  } catch (e) {
    console.error('[legacy-migration]', e);
    // Never leave behind a brand-new Firebase account that was created for this
    // attempt but never linked to a student record (that account would later
    // fail with "missing its ALIF student profile").
    if (createdNow && !claimed) { try { await deleteUser(auth.currentUser); } catch (_) {} }
    const code = e?.code || '';
    if (code === 'permission-denied') return fail('We couldn’t securely link your account right now. Please refresh and try again. If this keeps happening, contact your ALIF administrator.');
    if (code === 'auth/email-already-in-use') return fail('An account with this email already exists. Enter its current password to continue.');
    if (code === 'auth/weak-password' || code === 'auth/password-does-not-meet-requirements') return fail('Please choose a stronger password.');
    if (code === 'auth/too-many-requests') return fail('Too many attempts. Please wait a moment and try again.');
    if (code === 'auth/network-request-failed') return fail('Connection problem. Please check your internet and try again.');
    return fail(e?.message || 'We couldn’t complete this right now. Please try again.');
  }
}

export async function openLegacyMigrationModal(candidate = getLegacyMigrationCandidate()) {
  if (!candidate || activeModal) return null;
  try {
    const summary = { moduleNames: [], subjectNames: [], bundleNames: [], counts: { modules: 0, subjects: 0, quizzes: 0, bundles: 0 }, total: 0 };
    createModal(candidate, summary);
    return new Promise(resolve => {
      const done = (event) => {
        window.removeEventListener('alif:legacy-migration-complete', done);
        window.removeEventListener('alif:legacy-migration-skipped', done);
        resolve(event.type === 'alif:legacy-migration-complete' ? event.detail.student : null);
      };
      window.addEventListener('alif:legacy-migration-complete', done, { once: true });
      window.addEventListener('alif:legacy-migration-skipped', done, { once: true });
    });
  } catch (e) {
    console.error('[legacy-migration] preview failed', e);
    const fallback = summarizeEntitlements([], {modules:[],subjects:[],quizzes:[],packages:[]});
    createModal(candidate, fallback);
    return new Promise(resolve => {
      const done = (event) => { window.removeEventListener('alif:legacy-migration-complete', done); window.removeEventListener('alif:legacy-migration-skipped', done); resolve(event.type === 'alif:legacy-migration-complete' ? event.detail.student : null); };
      window.addEventListener('alif:legacy-migration-complete', done, { once: true });
      window.addEventListener('alif:legacy-migration-skipped', done, { once: true });
    });
  }
}
