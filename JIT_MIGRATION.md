# ALIF Just-in-Time Migration

Existing students can upgrade their account when they first use the redesigned app. The old browser session identifies the legacy student record, but it is never treated as the source of truth for access.

## Access reconstruction

After Firebase Authentication succeeds, the app re-reads the following from Firestore:

- `secretkeys/{studentId}`
- `modules`
- `subjects`
- `subjects/{subjectId}/quizzes`
- `packages`

The migration mirrors the admin Program Access semantics. An explicit `userLocks[studentId]` value of `false` or `enrolled` is personal access. An explicit `true` is a personal block. A resource's normal catalog state (`locked: false`, `locked: default`, etc.) is public/default behavior and is **not** migrated as student-owned access.

An explicitly unlocked/enrolled module becomes one module entitlement. The runtime entitlement service inherits that module entitlement to its subjects and quizzes. Bundle membership is migrated only when it is explicit (`packages/{bundleId}.userLocks[studentId] === 'enrolled'`, or the legacy package-manager grant on the student record). Bundle contents are expanded into module/subject entitlements.

## Safety

The old `secretkey` remains only as a one-time migration proof so a forged localStorage student ID cannot claim another student's record. It is never used as the new password and is not retained by the new browser cache. The authenticated Firebase UID becomes the permanent identity.
