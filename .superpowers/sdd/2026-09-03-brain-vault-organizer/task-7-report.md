# Task 7 report — Recoverable Transaction Engine and Guarded Undo

## Result

Implemented Task 7 in `src/organizer/transaction.ts` with a crash-recoverable apply/undo engine and a 37-case temporary-filesystem test suite in `test/organizer-transaction.test.ts`. No live Vault path is used by the tests.

## RED / GREEN evidence

- Initial RED: the focused test failed because `src/organizer/transaction.ts` did not exist.
- GREEN iteration: 27 initial cases exposed collision classification, racing-destination ownership, and test/event naming defects; the corrected focused suite passed 27/27.
- Hardening RED / GREEN cycles then added destination disappearance, post-hook managed identity, current/generated Canvas reference races, required MOC markers, protected MOC human bytes, mid-flight source staleness, recovery parent symlinks, apply replay rejection, and interrupted undo recovery.
- Final focused result: `npm test -- test/organizer-transaction.test.ts` — 1 file, 37 tests passed.

## Apply and recovery design

- Every source, destination parent, managed file, MOC, Canvas, and Canvas file reference is revalidated through exact case/NFKC directory entries, non-symlink canonical containment, bounded reads, file identity, and SHA-256 hashes.
- The destination directory must exist beneath a Foundation-approved area. Managed targets are restricted to exact Foundation area MOCs and Canvases; destination-area MOC markers must already exist.
- MOC replacements must preserve every byte outside the one exact `brain-auto` marker pair. Current and replacement Canvas JSON must be valid file-only Canvas data and all non-destination references must exist with exact spelling.
- Recovery root and transaction directories are mode `0700`; manifests, reports, original source snapshots, managed before-images, and undo before-images are mode `0600`.
- Recovery files are bounded and schema/cross-field validated. Manifests/reports contain only identifiers, bounded paths, hashes, modes, state, and snapshot filenames—never note bodies, provider prose, credentials, or secrets. Raw content exists only in protected recovery snapshots required for rollback/undo.
- All snapshots and the initial manifest are file-synced and directory-synced before the first Vault mutation. Destination publication is exclusive and atomic through a same-directory synced temporary file plus atomic hard-link installation. Managed files use synced same-directory temporary files plus atomic rename.
- Mutation order is deterministic: durable manifest, destination publication, stable-sorted managed replacements, source removal, durable `vault_applied` manifest state, then the SQLite proposal+transaction commit last.
- Failures before the database commit restore owned destination, managed before-images, and a missing source before marking the proposal `stale` or `rejected`. Racing human files are not removed or overwritten.
- `recover()` validates manifests before touching the Vault. It rolls back interrupted pre-database apply/undo work, finalizes operations whose SQLite state already committed, writes a redacted bounded report, and is replay-idempotent.

## Guarded undo

- Undo is one-time through `OrganizerStore.markUndone()` and validates that the transaction and manifest agree.
- It preflights the unchanged generated destination, absent source identity, every current managed after-hash, and every protected before-image before writing.
- Protected undo before-images make every injected undo failure reversible. Undo restores managed files and source, removes the unchanged destination last, durably records `undo_vault_applied`, and commits `undoneAt` last.
- A destination, source, or managed-file human edit produces a conflict with no engine mutation.

## Verification

- Baseline before changes: `npm test` — 28 files, 223 tests passed.
- Focused final: `npm test -- test/organizer-transaction.test.ts` — 1 file, 37 tests passed.
- Full final: `npm test` — 29 files, 260 tests passed.
- TypeScript: `npm run typecheck` — passed.
- Diff: `git diff --check` — passed before report staging.

## Concerns / boundaries

- Node does not expose portable descriptor-relative rename/unlink APIs, so the implementation uses repeated canonical lineage/identity checks immediately before filesystem calls; the remaining final-syscall race assumes the Vault is owner-controlled, matching the Foundation ruling.
- Directory fsync is attempted everywhere. Some Windows Node/filesystem combinations reject directory handles, so only those documented Windows errors are tolerated; the Linux deployment path uses the full directory durability barrier.
- Recovery state is deliberately outside the synchronized Vault. Deployment/runtime assembly must pass the configured organizer recovery root and keep it on protected local storage.

## Fix Round 1 — transactional and recovery hardening

### TDD evidence

- RED: expanded the focused suite from 37 to 59 cases before implementation. The first run was 39 passed, 19 failed, and 1 Windows-only skip. Failures covered Unicode path acceptance, corrupt-snapshot zero-mutation behavior, rollback ordering, final syscall revalidation, recovery-root creation/link safety, MOC target existence, complete database reconciliation, terminal report replay, and create-only publication faults.
- GREEN: completed the requested fixes, then expanded the deterministic crash matrix and retention/orphan-temp coverage to 70 focused cases.
- Final focused result: `npm test -- --run test/organizer-transaction.test.ts --reporter=dot` — 69 passed, 1 platform-specific skip, 0 failed.

### Critical fixes

- Apply rollback and interrupted-undo rollback now perform a complete read-only preflight before any Vault mutation. This validates the manifest and cross-fields; transaction directory and file modes; original, managed, destination, and undo before-images; every snapshot size/hash; current managed/source/destination conflicts; canonical lineage; and any deterministic owned temporary files. A missing, corrupt, oversized, incorrectly permissioned, or conflicting artifact fails closed with zero Vault changes.
- Apply rollback restores the source first, restores managed files in reverse mutation order, and removes the proven-owned destination last. Interrupted undo recovery restores the generated destination, restores managed after-images, and removes the restored source last. Each operation is replay-safe after interruption.
- Managed atomic replacement writes to a same-directory deterministic temporary file, syncs it, executes the final exact identity/hash/canonical-lineage callback, and immediately renames. Source, destination, rollback, and undo unlink boundaries likewise perform final bound checks directly before the syscall.
- Destination ownership is durable rather than hash-inferred. Create-only hard-link publication proves the temporary and target paths are the same filesystem object, synchronously marks in-memory ownership, and durably records `destinationOwned` in the manifest before temporary cleanup. Recovery can also prove the narrow crash window using the still-linked deterministic temporary file. Unowned collisions are never removed.
- Recovery-root validation now happens outside the Vault before recovery or root mutation. Components are walked with `lstat` without following symlinks/junctions; unsafe existing components are rejected without chmod; missing components are created one at a time as `0700`, with each parent synced before proceeding. Transaction directories are also verified `0700`.

### Important fixes

- Managed MOC validation parses only the exact generated marker block. Every generated link must be a safe exact `.md` path whose target exists in the current Vault inventory, except the exact planned destination in a replacement. Case/NFKC ambiguity or a missing target fails before mutation.
- Create-only publication now distinguishes target ownership from later chmod, directory-sync, and temp-cleanup success. Post-link failures remain recoverable, material cleanup failures are surfaced, and directory linkage is synced after both target publication and temp removal.
- Recovery manifests now carry the apply timestamp and a SHA-256 digest of the complete pending proposal record. Recovery compares the complete expected transaction (including paths, hashes, timestamps, and undo state) and the complete normalized proposal plus exact status. A same-ID/different-record database state fails closed and cannot finalize recovery.
- Path validation preserves exact scanner-accepted decomposed and compatibility Unicode spelling. NFKC+case is used only for collision keys. Both exact and normalized UTF-8 forms enforce 240 bytes per component and 1024 bytes total, and every existing disk component is resolved with exact spelling.
- Manifests, snapshots, and reports are bounded, schema-checked, and verified as `0600`; recovery directories are verified as `0700` (with the documented narrow Windows mode exception). Manifests/reports remain redacted; protected snapshots are the only files containing required before-images.
- Recovery and Vault atomic temp names are transaction-derived. Recovery validates their expected content before removing only those owned names and syncs the containing directory. Missing or stale terminal reports are recreated/reconciled from a terminal manifest plus exact database state.

### Retention boundary

- Apply, undo, and recover never delete verified recovery history automatically.
- `cleanupRecovery({ now, backupVerified })` is the explicit later-orchestration hook. It requires an affirmative independently verified backup, a terminal manifest, matching terminal report, exact database reconciliation, all snapshot validation, no unknown directory artifacts, and a report at least 30 days old before deleting one exact transaction directory and syncing the recovery root.
- Task 9/runtime orchestration must provide the real backup verification signal and call this hook; without that integration, retention remains conservative and no recovery directory is auto-deleted.

### Fix-round verification

- Focused: 69 passed, 1 skipped, 0 failed (70 total).
- Full: 29 files, 292 passed, 1 skipped, 0 failed (293 total), rerun after the final ownership-marker/status hardening.
- TypeScript: `npm run typecheck` passed before final verification.
- Diff hygiene: `git diff --check` passed; only line-ending notices were emitted on Windows.

### Remaining portability boundary

- Node still has no portable descriptor-relative rename/unlink API. The implementation therefore uses same-filesystem atomic link/rename publication and an exact identity/hash/canonical-lineage check as the immediately preceding operation. This is the accepted owner-controlled Vault boundary; no live Vault path is used by any test.
