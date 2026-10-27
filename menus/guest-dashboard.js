/* Guest mode is deliberately local-only. The old Dashboard/localStorage
   account bridge has been removed because browser storage is not an identity. */
export function createGuestStudent() {
  return {
    id: `guest_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`,
    docId: null,
    uid: null,
    authUid: null,
    name: 'Guest',
    batch: '',
    guest: true,
    source: 'guest'
  };
}

export function getDashboardUser() { return null; }
export function studentFromDashboardUser() { return null; }
export function tryAutoLoginFromDashboard() { return null; }
