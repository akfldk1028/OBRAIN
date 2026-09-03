# Task 8 — Vault Integrity Auditor

## Finding-code contract

| Code | Category examples | Meaning |
| --- | --- | --- |
| `ambiguous_link` | `wiki_link` | A wiki link or embed has more than one possible exact basename target. |
| `audit_limit_exceeded` | `directories`, `files`, `content_bytes` | A fixed audit safety bound stopped further inspection of that item or inventory. |
| `broken_link` | `wiki_link` | No exact path or unique exact basename target exists. Case/NFKC lookalikes are not resolved. |
| `canvas_missing_file` | `file_reference` | A valid managed Canvas file node does not name an existing Markdown file exactly. |
| `forbidden_artifact` | `application`, `environment`, `key`, `temporary`, `unapproved_managed_canvas` | A forbidden artifact was found by path/name only. |
| `invalid_canvas` | `json`, `schema`, `content_bytes`, `unreadable` | An approved generated Canvas is not valid bounded JSON Canvas. |
| `invalid_managed_markers` | `note_index` | A required MOC does not contain one exact, ordered marker pair. |
| `invalid_path` | `nfkc`, `unsafe_name`, `path_bytes`, `unapproved_top_level`, `unsupported_filesystem_type` | A Vault path violates the organizer naming/topology policy. |
| `max_depth` | `depth` | A directory or file exceeds the policy's five-level depth bound. |
| `missing_required_file` | `missing` | A required guide, MOC, or approved managed Canvas is absent. |
| `orphan_note` | `no_inbound_link` | A non-required Markdown note outside `Agent-Inbox` has no inbound Markdown link. |
| `unsafe_link` | `root`, `symlink` | A supplied root or discovered entry is a symlink/junction or otherwise unsafe. |

Findings deliberately contain only `code`, fixed `category`, and vault-relative `path`; they never
include note bodies, matching link text, credentials, or error text. Findings sort by UTF-8 path,
then code, then category.

## RED / GREEN

- RED: `npm test -- test/organizer-integrity.test.ts` initially failed because
  `src/organizer/integrity.ts` did not exist. Additional link-resolution and unsafe-root tests were
  added first and failed before their minimal fixes were implemented.
- GREEN: the focused suite covers a clean foundation, required files, malformed markers, invalid
  Canvas JSON/schema references, broken/ambiguous/case/NFKC links and embeds, code examples,
  artifacts, symlinks where supported, depth, asset embeds, and a no-write unsafe-root case.

## Verification

- `npm test -- test/organizer-integrity.test.ts`
- `npm run typecheck`
- `npm test`
- `git diff --check`

## Concerns / boundaries

- The audit is intentionally read-only and does not repair markers, links, Canvas files, or paths.
- Manual Canvas files remain human-managed. Only the policy's explicitly approved generated Canvas
  paths receive strict generated-Canvas schema validation.
- Traversal and file reads are bounded and use `lstat`; symlinks/junctions are reported and never
  traversed. The test host may disallow creating symlinks, so that fixture conditionally verifies
  the finding when supported.
