# Task 10 Report: Shared Runtime and Scheduled CLI

## Implementation

- Added `src/runtime.ts` with shared `assembleRuntime()` assembly for the KnowledgeBase and optional OrganizerService. It keeps the organizer absent when not configured, skips DashScope environment loading for a disabled organizer, constructs DashScope lazily only for an enabled provider, and passes `maxContextBytes` into the lazy provider factory.
- Added `src/organizer-cli.ts` with bounded `run`, `audit`, and `undo` parsing. The CLI requires `MCP_CONFIG_FILE`, never starts HTTP, emits only selected JSON summary fields, and closes runtime resources in `finally`.
- Moved the HTTP config-path construction through the shared runtime while retaining the existing root-based HTTP fallback and six-tool behavior.
- Added organizer run/audit npm scripts.
- Added a pre-acquisition filesystem capability probe to the organizer lock. Both fresh acquisition and stale recovery fail closed before coordinator/primary lock mutation when device/inode identity is unavailable or zero. The probe uses an exact random file in the runtime directory; no runtime path is recursively deleted.
- Recovery cleanup remains disabled because no independently verified backup signal is available.

## Files changed

- `src/runtime.ts` (new)
- `src/organizer-cli.ts` (new)
- `src/index.ts`
- `src/organizer/lock.ts`
- `package.json`
- `test/organizer-cli.test.ts` (new)
- `test/organizer-lock.test.ts`

## TDD evidence

### RED

`npm test -- test/organizer-cli.test.ts test/organizer-lock.test.ts`

Observed expected failures before implementation:

- `test/organizer-cli.test.ts` failed because `../src/organizer-cli.js` did not exist.
- Fresh acquisition with zero identity returned a lock instead of `undefined`.
- Stale recovery with zero identity left `organizer.lock.coordinator.sqlite`, proving the capability check occurred too late.

`npm test -- test/organizer-cli.test.ts`

Observed the expected missing CLI-module failure for parser and runtime assembly coverage.

### GREEN

`npm test -- test/organizer-cli.test.ts test/organizer-lock.test.ts && npm run typecheck && npm run build && Test-Path dist/index.js && Test-Path dist/organizer-cli.js`

Output: 2 files, 21 tests passed; typecheck and build exited 0; both built entrypoints existed.

## Full verification

- `npm test` — 33 files passed; 421 passed, 3 skipped (424 total).
- `npm run typecheck` — exited 0 with no diagnostics.
- `npm run build` — exited 0; `dist/index.js` and `dist/organizer-cli.js` exist.
- `git diff --check` — exited 0 with no whitespace errors.

## Self-review

- Confirmed disabled/unconfigured organizer paths do not require DashScope credentials or construct/invoke DashScope.
- Confirmed the provider-enabled runtime factory receives the configured context bound and remains lazy.
- Confirmed the CLI audit path uses the real organizer service without an HTTP listener and produces a redacted JSON result.
- Confirmed `run` delegates to `runToCompletion()`, preserving its shared lock ownership.
- Confirmed the HTTP config path uses shared runtime construction and releases both runtime and HTTP resources on shutdown or listener-start failure.
- Confirmed unavailable and zero identity tests cover both fresh and stale lock paths; neither path creates or retains a primary/coordinator lock.

## Concerns

- Recovery cleanup is intentionally not called: this task has no independently verified backup signal.
- On a filesystem that cannot supply usable identity, the random identity probe may remain when it cannot be proven safe to unlink. It contains only fixed probe text; primary and coordinator locks are never retained, and no recursive cleanup is used.
