import { ALL_MODULES as MODS, SUBJECTS_CACHE as SUBJS } from './picker-screen.js';
import { DEFAULT_LOCK_MSG as DEFAULT_MSG, LOCK_CONFIG as LOCK_CFG } from './progress-rings.js';
import { getAccess, hasAccess, hasDeny } from './access-service.js';

function grantState(type, id) {
  if (!id) return 'default';
  const g = getAccess(type, id);
  if (g.mode === 'deny' && g.status === 'active' && !g.active) return 'default';
  if (g.mode === 'deny' && g.status === 'active') return 'deny';
  if (g.active) return 'allow';
  return 'default';
}

export function isItemLockedForUser(item) {
  if (!item) return false;
  if (item.locked === 'public_unlock') return false;
  if (item.locked === 'public_lock') return true;
  return item.locked === 'default' ? false : !!item.locked;
}

export function isEnrolledForItem(item, student, type) {
  if (!item) return false;
  if (grantState(type, item.id) === 'allow') return true;
  if (grantState(type, item.id) === 'deny') return false;
  if (type === 'module') return false;
  let subject = type === 'subject' ? item : null;
  if (type === 'quiz') subject = SUBJS.find(s => s.id === item.subjectId) || null;
  if (subject) {
    if (grantState('subject', subject.id) === 'deny') return false;
    if (grantState('subject', subject.id) === 'allow') return true;
  }
  const module = subject ? MODS.find(m => m.id === subject.moduleId) : null;
  if (!module) return false;
  if (grantState('module', module.id) === 'deny') return false;
  return grantState('module', module.id) === 'allow';
}

export function isUserUnlocked(item, _student, type) {
  return !!item && !!type && hasAccess(type, item.id);
}

export function isResourceLocked(item, student, type) {
  if (!item) return false;
  if (item.locked === 'public_unlock') return false;
  if (grantState(type, item.id) === 'deny') return true;
  if (grantState(type, item.id) === 'allow') return false;
  if (isEnrolledForItem(item, student, type)) return false;

  if (item.locked === 'public_lock') return true;
  if (isItemLockedForUser(item)) return true;

  if (type === 'subject') {
    const m = MODS.find(x => x.id === item.moduleId);
    if (m) {
      if (grantState('module', m.id) === 'deny') return true;
      if (grantState('module', m.id) === 'allow') return false;
      if (isItemLockedForUser(m)) return true;
    }
  }
  if (type === 'quiz') {
    const subject = SUBJS.find(x => x.id === item.subjectId);
    if (subject) {
      if (grantState('subject', subject.id) === 'deny') return true;
      if (grantState('subject', subject.id) === 'allow') return false;
      if (isItemLockedForUser(subject)) return true;
      const m = MODS.find(x => x.id === subject.moduleId);
      if (m) {
        if (grantState('module', m.id) === 'deny') return true;
        if (grantState('module', m.id) === 'allow') return false;
        if (isItemLockedForUser(m)) return true;
      }
    }
  }
  return false;
}

export function getEffectiveLockMessage(item, kind, student) {
  if (!item || !isResourceLocked(item, student, kind === 'modules' ? 'module' : kind === 'subjects' ? 'subject' : 'quiz')) return null;
  const scope = item.lockScope || 'type';
  return scope === 'individual' ? item.lockMessage || DEFAULT_MSG[kind]
    : scope === 'global' ? LOCK_CFG.global || DEFAULT_MSG.global
    : LOCK_CFG[kind] || DEFAULT_MSG[kind];
}

export function getQuizLockMessage(quiz, student) {
  return isResourceLocked(quiz, student, 'quiz') ? getEffectiveLockMessage(quiz, 'quizzes', student) : null;
}
