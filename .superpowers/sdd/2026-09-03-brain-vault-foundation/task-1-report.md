# Foundation Task 1 Report: Canonical Foundation Policy

## Status

Implemented the canonical Brain Vault foundation policy and its path helpers.

## Implementation

- Added `src/foundation/policy.ts` with `AreaDefinition`, `VaultFoundationPolicy`, and the approved `BRAIN_FOUNDATION_POLICY` manifest.
- Added `areaMocPath()`, `areaGuidePath()`, and `areaCanvasPath()` for stable required file paths.
- Added `test/foundation-policy.test.ts` covering the approved area order, depth/inbox settings, and Study path derivation.

## Test evidence

### RED

Command: `npm test -- test/foundation-policy.test.ts`

Result: exit code 1. Vitest reported:

`Error: Cannot find module '../src/foundation/policy.js'`

The test suite had 0 tests executed because the required production module did not yet exist.

### GREEN

Command: `npm test -- test/foundation-policy.test.ts`

Result: exit code 0. `1` test file passed; `2` tests passed.

### Full suite

Command: `npm test`

Result: exit code 0. `15` test files passed; `31` tests passed.

## Self-review

- Confirmed the implementation matches the task brief’s exact public interfaces, literals, area order, and path formats.
- Confirmed `git diff --check` reports no whitespace errors.
- Scope is limited to the requested policy module and focused tests; no live Vault or unrelated files were touched.
