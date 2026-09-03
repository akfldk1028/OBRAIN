# Brain Vault Automatic Organization Design

Date: 2026-09-03  
Status: Approved design, pending implementation-plan review  
Initial vault: `brain`

## 1. Objective

Turn the synchronized `Brain` Obsidian vault into a central, durable knowledge base that a human can
edit locally and any authorized MCP-capable AI can understand and extend consistently.

The system must:

- preserve ordinary Markdown as the source of truth;
- synchronize bidirectionally between `D:\obsidian\Brain` and the Oracle-hosted vault;
- expose the vault through the existing OAuth-protected HTTPS MCP endpoint;
- accept AI-created notes only through `Agent-Inbox`;
- organize inbox notes into the approved folder system on the Oracle server every day;
- maintain readable Maps of Content (MOCs), links, backlinks, and generated Canvas maps;
- keep human-written content recoverable and never silently overwrite or permanently delete it;
- apply the same policy regardless of whether the client is ChatGPT, Codex, Claude, or another AI.

This feature extends the deployed MCP service. It does not replace its HTTPS, OAuth, search, indexing,
backup, or Syncthing layers.

## 2. Existing System Baseline

The design assumes the following verified deployment:

- Local vault: `D:\obsidian\Brain`
- Server vault ID: `brain`
- Public MCP endpoint: `https://144-24-67-37.sslip.io/mcp`
- Bidirectional transport: Syncthing
- Server units: `brain-mcp`, `brain-syncthing`, and `caddy`
- Existing nightly backup timer: `brain-mcp-backup.timer`
- Existing safe MCP tools: `list_vaults`, `list_notes`, `read_note`, `search_notes`,
  `get_note_links`, and `create_inbox_note`
- Existing write boundary: new files can be created only below `Agent-Inbox`

The existing authentication boundary and Inbox-only direct-write policy remain unchanged. Automatic
organization is a separate, validated transaction layer rather than a general-purpose filesystem API.

## 3. User Experience and Data Flow

```text
Human writes in local Obsidian
              |
              v
      D:\obsidian\Brain
              |
       Syncthing, two-way
              |
              v
  Oracle /srv/brain/vaults/brain
        |                    ^
        |                    |
 HTTPS MCP read/search   AI writes only
        |                to Agent-Inbox
        v                    |
 ChatGPT / Codex / Claude / other AI

Daily organizer on Oracle:
Agent-Inbox -> safety scan -> classification proposal -> validation
            -> transactional apply -> MOC/link/Canvas refresh -> audit
```

Results created on Oracle return to local Obsidian through Syncthing. The organizer therefore keeps
working while the local computer is off. When the computer reconnects, the normal synchronization
process delivers the changes.

## 4. Vault Information Architecture

### 4.1 Root Layout

The initial `brain` vault uses the following approved layout:

```text
Brain/
  000_Home_MOC.md
  000_AI_WORK_GUIDE.md
  000_Brain_Map.canvas
  Agent-Inbox/
    검토필요/
  00_Prompt/
  01_Development/
  10_Agent/
  20_Study/
  30_Business/
  40_Research/
  50_Project/
  60_Tools/
  98_DK/
  99_Archive/
```

`Agent-Inbox` is the deliberate unnumbered exception because it is an intake boundary, not a
knowledge category. The numbered folders follow the user's established vocabulary. This is an
Obsidian-oriented extension of Johnny.Decimal, not a claim of strict conformance to the official
two-level Johnny.Decimal structure.

### 4.2 Required Area Files

Every numbered top-level area contains:

```text
000_<Area>_MOC.md
000_<Area>_Map.canvas
99_작업가이드_다음AI용.md
```

Rules:

- `000_<Area>_MOC.md` is the authoritative navigational index for humans and AIs.
- `000_<Area>_Map.canvas` is generated and AI-managed; people should not manually arrange it.
- Other `.canvas` files are human-managed and the organizer never modifies them.
- `99_작업가이드_다음AI용.md` specializes the root guide for that area.
- Folder depth is limited to five levels below the vault root.
- The organizer does not invent a new top-level area.
- In version 1, the organizer does not create a new category folder automatically. It proposes one
  for review or uses an existing approved destination such as `98_DK/98_Unsorted`.

### 4.3 AI Reading Order

An AI should read context in this order before doing substantial work:

1. `000_AI_WORK_GUIDE.md`
2. `000_Home_MOC.md`
3. the destination area's `99_작업가이드_다음AI용.md`
4. the destination area's `000_<Area>_MOC.md`
5. the target note and its relevant linked notes

`get_vault_policy` exposes this reading order and the parsed policy. Safety enforcement remains in
server code and configuration; a malicious or accidental instruction inside a note cannot override
path, overwrite, authentication, or deletion rules.

## 5. Canonical Note Contract

### 5.1 Frontmatter

An organized note uses a stable minimum schema:

```yaml
---
id: NOTE-20260903-001
type: study
area: 20_Study
status: active
created: 2026-09-03
updated: 2026-09-03
parent_moc: "[[000_Study_MOC]]"
tags:
  - 학습
  - AI정리
aliases: []
organization:
  managed: true
  transaction_id: ORG-20260903-001
  confidence: 0.96
---
```

Stable IDs prevent identity from depending on a filename. Existing valid user frontmatter is
preserved. Organizer-owned fields live below `organization` so their ownership is visible.

### 5.2 Readable Body Template

The organizer may add the following sections around the original material:

```markdown
# 제목

> [!abstract] 한눈에 보기
> 쉬운 요약

> [!example] 쉬운 비유
> 일상적인 예시

## 핵심 내용

> [!note] 추가 설명
> 헷갈리기 쉬운 부분

> [!tip] 기억할 핵심
> 다시 볼 때 필요한 결론

> [!warning] 주의할 점
> 한계, 오류 가능성, 보안 주의사항

## 연결된 노트

- 상위 목차: [[000_Study_MOC]]
- 관련 개념: [[관련 노트]]
- 이전 단계: [[이전 노트]]
- 다음 단계: [[다음 노트]]

## 원문

사용자가 입력한 원문을 그대로 보존한다.
```

Sections without meaningful content are omitted rather than filled with invented text. Learning
notes additionally follow the user's sequence: everyday analogy, intuitive explanation, formula,
symbol table, and step-by-step derivation. Source and page information are mandatory when the input
contains them; the organizer never fabricates missing citations or page numbers.

### 5.3 Original-Content Guarantee

For a newly organized Inbox note:

- the exact original Markdown body is retained under `## 원문`;
- the original complete file is captured in the transaction recovery store before modification;
- the destination is created without overwriting an existing file;
- a source hash is checked again immediately before apply;
- if the source changed after proposal generation, the proposal becomes stale and no move occurs.

The organizer may normalize a title and filename but must not present AI-generated assertions as the
user's original words.

## 6. Link and Canvas Model

### 6.1 Link Semantics

Links are assigned a relationship when known:

- `parent`: containing MOC or broader topic
- `related`: conceptually related note
- `prerequisite`: material to understand first
- `next`: material that logically follows
- `evidence`: paper, PDF, lecture, or external source
- `applies-to`: project or practical use
- `produces`: result, code, report, or artifact
- `contradicts`: conflicting evidence or position

Every organized note should link to one parent MOC. A related-note link is added only when a real,
defensible match exists. The system never creates a fake link merely to satisfy a count.

### 6.2 MOC Management

Human-written MOC text is protected. Generated entries live only inside deterministic markers:

```markdown
<!-- brain-auto:start note-index -->
...generated links...
<!-- brain-auto:end note-index -->
```

The organizer can replace only content between matching markers. Missing, nested, or malformed
markers stop the update and create a review item. Links are stable-sorted so repeated runs do not
cause noisy rewrites.

### 6.3 Canvas Management

`000_Brain_Map.canvas` connects root area MOCs. Each `000_<Area>_Map.canvas` connects the area MOC,
child MOCs, and representative notes.

- Canvas nodes reference real Markdown files whenever possible.
- Edge labels use the relationship vocabulary above.
- Node and edge IDs are deterministic hashes of their semantic identity.
- Layout is deterministic by depth and category, preventing random movement on every run.
- Only the explicitly AI-managed `000_*_Map.canvas` files may be regenerated.
- A temporary file is validated as JSON Canvas before atomically replacing the generated Canvas.
- Essential relationships also exist as Markdown links because Canvas is a human visualization, not
  the sole AI-readable source of truth.

## 7. Organizer Architecture

### 7.1 Components

```text
Organizer CLI / MCP trigger
  -> Inbox scanner
  -> stability and secret guard
  -> context builder
  -> model-provider adapter
  -> strict proposal parser
  -> policy validator
  -> transaction engine
  -> MOC and Canvas generators
  -> integrity auditor
  -> audit and recovery store
```

The same core library serves scheduled runs and authenticated MCP requests. Business rules are not
duplicated between the CLI and MCP handlers.

### 7.2 Scheduled Service

A separate systemd one-shot service, `brain-organizer.service`, runs through
`brain-organizer.timer` daily at 18:00 UTC, which is 03:00 KST the following day. Korea has no daylight
saving-time change. A persistent timer runs a missed job after the VM returns.

The job uses a single-instance lock. A second scheduled or MCP-triggered run returns `already_running`
instead of processing concurrently. The existing backup at 03:15 UTC remains separate and occurs
about nine hours after organization.

Only Inbox Markdown files that have been unchanged for at least five minutes are eligible. Syncthing
conflict files and partial or temporary files always go to review. Each source is hashed during scan
and again before apply to detect concurrent local edits.

### 7.3 Daily Pipeline

1. Discover eligible `.md` files in `Agent-Inbox`.
2. Exclude `검토필요`, temporary files, conflicts, and already completed transaction IDs.
3. Run local secret detection before any provider request.
4. Load the root policy, relevant MOC summaries, approved folder list, and a bounded set of candidate
   note titles. Do not send the whole vault.
5. Ask the configured model for a strict JSON proposal.
6. Validate the proposal as untrusted input.
7. Store the proposal and confidence score.
8. In dry-run or review bands, write only a report and do not move the note.
9. For an eligible automatic proposal, snapshot, transform, and move the note transactionally.
10. Refresh managed MOC blocks and managed Canvas files.
11. Allow the existing file watcher to update the search index, then run a targeted integrity audit.
12. Append a content-free audit record and expose a human-readable run summary.

A failed note does not abort unrelated notes. The final run status records processed, applied,
review, skipped, and failed counts.

### 7.4 Confidence Policy

- `>= 0.90`: eligible for automatic apply after trial mode
- `0.70` through `0.899...`: proposal only; move to or report under `Agent-Inbox/검토필요`
- `< 0.70`: leave unchanged in Inbox with the reason recorded

Model confidence alone is insufficient. Automatic apply also requires every deterministic policy
check to pass.

### 7.5 Trial and Activation

- First seven calendar days: forced dry-run for all notes.
- During dry-run, the system produces proposals and reports but does not move or rewrite notes.
- After review, automatic mode requires an explicit configuration change.
- Automatic mode applies only proposals at or above `0.90` confidence.
- The owner can return to dry-run immediately without uninstalling the timer.

## 8. Model Provider Boundary

The classifier uses a provider interface rather than embedding one vendor throughout the organizer.
Version 1 supports the OpenAI-compatible DashScope/Qwen API because it matches the user's existing
service choice. Provider, endpoint, model, request limits, and mode are configuration values.

The previously exposed DashScope API key is considered compromised and must never be used. A new key
is required only before live provider testing. It is stored outside Git in
`/etc/brain-organizer.env`, owned by root with restrictive permissions. Where supported, the key is
restricted to the Oracle public IP, the minimum model set, and the intended workspace.

Privacy and cost controls:

- send only the current Inbox note plus minimal classification context;
- never send `.env`, key files, `.obsidian`, hidden files, or recovery snapshots;
- reject locally detected credentials, private keys, access tokens, and high-risk personal secrets;
- cap notes per run, bytes per note, total request bytes, retries, and estimated spend;
- use timeouts and exponential backoff for transient provider errors;
- never apply a proposal after a provider timeout, malformed response, or schema failure;
- treat note text as untrusted data, not executable instructions.

The provider returns only a proposal. It never receives direct filesystem or MCP credentials and
cannot perform writes itself.

## 9. Safe MCP Extension

### 9.1 Proposed Tools

The public MCP surface gains the following owner-authenticated tools:

- `get_vault_policy(vault)`: return policy version, guide, approved areas, and reading order.
- `list_inbox_notes(vault, state?, limit?, cursor?)`: list intake and review items.
- `propose_organization(vault, path)`: create a hash-bound proposal without modifying the note.
- `apply_organization(vault, proposal_id)`: apply only a stored, unexpired, validated proposal.
- `audit_vault(vault, scope?)`: report broken links, orphan notes, missing required files, malformed
  managed blocks, and invalid generated Canvas files.
- `undo_organization(vault, transaction_id)`: restore one recoverable transaction when no newer edit
  would be overwritten.
- `organize_now(vault, mode?)`: start one bounded run or report that another run is active.

### 9.2 Authorization Rules

- Existing read tools and `create_inbox_note` retain their behavior.
- No generic edit, rename, move, delete, or arbitrary path tool is added.
- A proposal can name only a registered vault, an Inbox source, and an approved destination.
- Proposal IDs are server-generated, expire, and bind to source path, content hash, policy version,
  and target path.
- `apply_organization` cannot accept replacement content or a caller-selected arbitrary destination.
- `undo_organization` refuses to overwrite content changed after the recorded transaction.
- A caller-supplied `organize_now` mode can request a stricter mode such as dry-run, but can never
  escalate beyond the server-configured mode or bypass the seven-day trial lock.
- All state-changing tools are rate-limited and audit-logged.

This contract lets any authorized AI follow the same workflow without granting arbitrary write
access.

## 10. Transaction, Audit, and Recovery Model

Organizer state lives outside the synchronized vault:

```text
/srv/brain/data/organizer/
  organizer.sqlite
  transactions/<transaction-id>/
    manifest.json
    original.md
```

The database records jobs, proposals, source hashes, destinations, confidence, policy versions,
transaction status, and undo status. Audit entries contain paths and outcomes but not note contents,
OAuth secrets, or provider keys.

Apply sequence:

1. acquire the organizer lock;
2. validate the source and hash;
3. verify destination and parents resolve inside the registered vault;
4. snapshot original content and write a manifest;
5. create and validate the transformed temporary file;
6. refuse if the destination exists;
7. atomically install the destination;
8. remove the original Inbox path only after the destination is durable;
9. update managed indexes and Canvas files atomically;
10. commit transaction state and audit record.

If a step fails, recovery uses the manifest to restore the pre-transaction state. A cleanup process
may remove expired recovery snapshots only after normal Vault backups cover the retention window.
The initial recovery retention is 30 days.

## 11. Structural Safety Rules

All organizer paths undergo the same or stricter checks as public Vault access:

- registered vault IDs only;
- source must be a Markdown file under `Agent-Inbox`;
- destination must be Markdown under an approved numbered area;
- no absolute paths, traversal components, alternate-separator escapes, control characters, or
  symlink escapes;
- maximum five folder levels below the Vault root;
- collision-safe filename generation with no overwrite;
- case-insensitive collision checks to remain safe across Linux and Windows synchronization;
- bounded filename, path, file, request, and run sizes;
- reserved Windows names rejected;
- `.obsidian`, hidden directories, Syncthing metadata, and recovery storage excluded.

The organizer never follows instructions embedded in note content to weaken these rules.

## 12. Legacy Vault Migration Boundary

`D:\obsidian\claude\Local_Claude` remains read-only and untouched during the initial implementation.
Its folder names and guides are a reference for the new clean Vault, not an instruction to copy all
1,169 files immediately.

A later, separate migration stage will:

1. inventory Markdown and referenced assets;
2. exclude dot folders, app configuration, trash, JSON credentials, keys, and secrets;
3. detect duplicates and broken references;
4. copy batches into a staging area rather than moving the source;
5. produce dry-run classification proposals;
6. migrate approved batches with link validation;
7. leave the original legacy Vault unchanged until the user explicitly retires it.

Migration is not part of the first organizer release and cannot silently expand its scope.

## 13. Testing Strategy

### 13.1 Unit Tests

- approved area and maximum-depth validation
- POSIX and Windows traversal rejection
- symlink and case-insensitive collision rejection
- Windows reserved filename rejection
- Inbox-only source validation
- stable-file and source-hash concurrency guard
- secret detector fixtures without logging secret values
- strict provider response schema and confidence bands
- prompt-injection-shaped note content treated as data
- frontmatter preservation and organizer-owned metadata
- exact original body preservation
- managed MOC marker parsing and human-text preservation
- deterministic valid JSON Canvas generation
- transaction rollback and guarded undo
- lock, idempotency, expiry, and replay rejection

### 13.2 Integration Tests

Temporary Vault fixtures verify:

1. a safe Inbox note receives a valid dry-run proposal;
2. trial mode performs no Vault mutation;
3. automatic mode moves only a high-confidence validated proposal;
4. a concurrently edited note is not applied;
5. a secret-bearing note is never sent to the mocked provider;
6. an ambiguous note remains for review;
7. existing destination content is not overwritten;
8. MOC human sections survive refresh;
9. generated Canvas parses and references existing files;
10. search and backlinks update after an applied transaction;
11. an injected failure restores the original state;
12. undo refuses to replace a newer human edit;
13. a Syncthing conflict file is skipped;
14. two simultaneous starts produce only one active run.

Provider behavior is mocked for deterministic automated tests. A real provider is used only for a
small explicit smoke test after a rotated key is installed.

### 13.3 Deployment Verification

- existing test, typecheck, build, local smoke, HTTP smoke, OAuth smoke, and public MCP checks pass;
- all existing MCP tools behave unchanged;
- new tools require the same owner authentication;
- systemd organizer timer is active and dry-run mode is visible;
- run logs contain no note bodies or secrets;
- a public MCP-created test note synchronizes to Oracle;
- a dry-run proposal is produced without moving the file;
- after controlled activation, one high-confidence fixture is organized and synchronizes back to
  `D:\obsidian\Brain`;
- MOC, Canvas, backlinks, audit, backup, and undo are verified end to end;
- reboot recovery leaves MCP, Syncthing, Caddy, backups, and organizer active.

## 14. Observability and Reports

Every run produces a concise Markdown report in an AI-managed operational location, containing:

- run ID, time, mode, and policy version;
- counts for discovered, proposed, applied, review, skipped, and failed notes;
- note paths and non-sensitive reasons;
- broken-link or Canvas validation findings;
- instructions for reviewing or undoing a transaction.

Reports never include API keys, source note bodies, OAuth tokens, SSH material, or transaction
snapshots. Journald receives structured operational events with the same redaction policy.

## 15. Rollout Phases

### Phase A: Vault Foundation

- create the approved root folders;
- create the root guide, Home MOC, required area MOCs and guides;
- create valid generated Canvas maps;
- move the existing MCP handoff note to the appropriate Tools area;
- archive connection-test notes without deleting them;
- verify local/server synchronization and Obsidian rendering.

### Phase B: Organizer Core

- implement policy parsing, scanner, secret guard, proposal schema, deterministic generators,
  transaction store, rollback, audit, and tests;
- keep provider calls mocked and filesystem fixtures local.

### Phase C: Safe MCP Tools

- register the proposal, apply, audit, undo, and run tools;
- add OAuth, replay, rate-limit, and backward-compatibility tests.

### Phase D: Oracle Dry-Run Deployment

- install the separate oneshot service and timer;
- install a newly rotated, restricted provider key outside Git;
- run one explicit real-provider smoke test;
- force seven-day dry-run mode and inspect reports.

### Phase E: Controlled Automatic Mode

- activate automatic apply only after dry-run review;
- retain the `0.90` threshold and all deterministic validators;
- verify one reversible end-to-end transaction and local synchronization.

### Phase F: Optional Legacy Migration

- inventory and stage selected legacy material;
- migrate in reviewed batches using the established organizer and audit rules.

## 16. Acceptance Criteria

The feature is complete when:

- every authorized AI can retrieve the same Vault policy through MCP;
- a human can write locally and an AI can create an Inbox note, with both directions synchronizing;
- trial mode classifies without mutating notes;
- automatic mode organizes only stable, non-secret, high-confidence notes into approved paths;
- original text remains visible and recoverable;
- human-authored MOC sections and manual Canvas files are never overwritten;
- generated MOCs, Markdown links, backlinks, and Canvas maps agree;
- no generic public edit, move, or delete capability exists;
- every mutation is hash-bound, auditable, collision-safe, and undoable;
- provider failure, malformed output, prompt injection, concurrent edits, and sync conflicts fail
  closed;
- existing MCP, OAuth, search, sync, backup, and reboot behavior continues to pass verification;
- the complete result is visible in local Obsidian without requiring manual file copying.

## 17. External Standards and Product References

- Johnny.Decimal number structure: <https://johnnydecimal.com/documentation/the-numbers>
- Johnny.Decimal standard zero categories: <https://johnnydecimal.com/documentation/the-standard-zeros>
- Obsidian Callouts: <https://obsidian.md/help/callouts>
- Obsidian Canvas: <https://obsidian.md/help/plugins/canvas>
- Obsidian internal links: <https://obsidian.md/help/Linking%20notes%20and%20files/Internal%20links>
- Obsidian Backlinks: <https://obsidian.md/help/Plugins/Backlinks>
- DashScope/Qwen API: <https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen-api-via-dashscope>
- DashScope function calling: <https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen-function-calling>
- Alibaba Cloud Model Studio API-key controls:
  <https://www.alibabacloud.com/help/en/model-studio/get-api-key>
