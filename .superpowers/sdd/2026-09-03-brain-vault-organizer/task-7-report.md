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

## Fix Round 2 — post-read binding and replay-durable ownership

### TDD evidence

- RED: expanded the focused suite from 70 to 88 cases before the primary implementation. The observed run was 74 passed, 13 failed, and 1 Windows-only skip. The failures specifically demonstrated absent initial-manifest-temp promotion, missing terminal timestamp reconciliation, unobserved pathname substitutions during bound reads, missing final MOC inventory validation, and missing recovery ownership-boundary events/persistence.
- Additional focused RED/GREEN cycles covered post-link marker failure and transaction-shaped recovery-root symlinks. Both tests were observed failing for the intended missing behavior before their minimal fixes.
- Final focused suite: 93 cases total on Windows (91 passed, 2 platform-specific ambiguity/mode skips, 0 failed).

### Scanner-grade final pathname binding

- `BoundFile` now retains the canonical file path captured during initial binding.
- Final revalidation binds the original stat, opened handle stat, post-read handle stat, SHA-256 content, canonical parent lineage, pathname `lstat` before and after resolution, resolved canonical path, and canonical-target `lstat` to the same file identity/type/size/mtime.
- The test-only fault event fires after handle read/fstat/hash while the handle is still open. The handle is closed, parent/pathname binding is repeated, and the caller performs rename or unlink as the next filesystem operation.
- Deterministic races now replace the pathname during the bound read at apply-managed rename, source unlink, undo destination unlink, apply rollback managed rename/destination unlink, and undo rollback managed rename. Every replacement is detected; human bytes are never overwritten or deleted.
- Synced exclusive files are chmodded and statted through their still-open handle. Create-only publication rebinds the proof temp immediately before hard-link creation and re-proves the published target immediately before chmod. Cleanup unlinks only an identity/hash/canonical-checked owned temp.

### Replay-durable destination ownership

- Publication retains the deterministic hard-link proof temp on every post-link error until durable ownership is available. It no longer removes the only ownership evidence on marker, chmod, sync, or later cleanup failure.
- Normal publication writes and fsyncs `destinationOwned=true` before chmod/temp cleanup. The in-memory manifest is advanced only after that durable write succeeds; a partial marker write therefore cannot falsely suppress recovery persistence.
- Recovery that proves ownership from the hard-linked destination/proof pair emits an inference boundary, writes and fsyncs `destinationOwned=true`, then—and only then—may restore Vault artifacts, remove the proof, or remove the destination.
- Crash replay tests cover interruption after inference, marker persistence, proof-temp cleanup, and destination deletion. A post-link marker failure test verifies the proof remains present until recovery durably records ownership.

### Initial manifest publication recovery

- A transaction directory with no `manifest.json` accepts only its exact transaction-derived manifest temp. The temp must be `0600`, bounded, valid JSON, schema- and cross-field-valid, match the directory transaction ID, reference an outside-Vault recovery root, have every required snapshot present and valid, and coexist with no unknown artifact.
- Promotion uses create-only hard-link publication, syncs the directory, proves the published manifest and temp are the same object, removes the proof with a final identity check, and syncs again. A crash leaving both names is replayable.
- Corrupt, oversized, wrong-ID, unsafe-mode, missing-snapshot, and unknown-artifact states fail closed before Vault mutation. Existing manifest/report temps are parsed and validated before any cleanup rather than silently discarded.

### Final MOC inventory and path parity

- After the managed MOC temp is synced and after earlier Vault mutations, the engine freshly parses only the generated marker block and rebinds every linked target through exact case/NFKC collision-checked inventory immediately before the MOC target's final pathname check and rename.
- The planned destination exception is allowed only while `destinationOwned` is durable and the published destination rebinds to the expected hash. Target deletion, exact-spelling rename, and post-sync case ambiguity all reject and roll back without committing a broken MOC.
- Relative path validation now explicitly rejects any component whose NFKC form introduces `/` or `\\`, matching Task 2. Fullwidth slash and reverse-solidus fixtures remain untouched and fail before Vault mutation.

### Terminal reports

- Recovery report timestamps must be at or after the manifest's apply/undo state timestamp. Newly written reports are floored to the relevant manifest timestamp if the injected/runtime clock is older.
- Even a schema-valid, same-ID, same-outcome terminal report is rejected if its timestamp predates the terminal manifest state.

### Round 2 verification

- Focused: 91 passed, 2 Windows-specific skips, 0 failed (93 total).
- Full: 29 files, 314 passed, 2 Windows-specific skips, 0 failed (316 total).
- TypeScript: `npm run typecheck` passed.
- Diff hygiene: `git diff --check` passed; only line-ending notices were emitted on Windows.
- All new filesystem tests use isolated temporary fixtures only; no live Vault path is touched.
