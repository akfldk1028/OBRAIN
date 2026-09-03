# Multi-Vault Obsidian MCP Server Design

Date: 2026-09-01
Status: Approved design awaiting implementation-plan review

## 1. Objective

Build a central, always-on Obsidian knowledge server that runs independently of any local computer. A single owner connects from ChatGPT, Codex, mobile clients, and other MCP-capable agents through one HTTPS endpoint. The server stores multiple Obsidian vaults, searches them as a unified knowledge base, and preserves every note as an ordinary Markdown file.

The initial deployment runs inside the existing Oracle Cloud Free Tier tenancy in South Korea North (Chuncheon). Because an Ampere A1 shape is not available for the selected ARM image in this tenancy and region, the first deployment uses the available Always Free-eligible `VM.Standard.E2.1.Micro` x86 shape.

## 2. Success Criteria

The system is complete when all of the following are true:

- One public HTTPS MCP URL works while the user's local computers are off.
- One authenticated owner can discover and search every registered vault.
- Search can be scoped to one vault or run across all vaults.
- Korean and English title/body substring searches return useful results without an external AI API.
- Agents can read notes and create new notes only inside each vault's `Agent-Inbox` folder.
- Agents cannot modify or delete existing notes, escape a vault root, or follow a symlink outside the vault.
- Markdown remains the canonical data format and opens normally in Obsidian.
- The search database can be deleted and rebuilt completely from Markdown.
- The service returns after an operating-system reboot without manual intervention.
- HTTPS, authentication, authorization, indexing, search, allowed writes, denied writes, and restart recovery all pass end-to-end verification.

## 3. Non-Goals for the First Release

- Training or fine-tuning an LLM on the vault contents.
- Hosting a local embedding model on the 1 GB VM.
- Semantic vector search in the first release.
- Editing or deleting existing notes through an agent.
- Real-time collaborative editing or Obsidian mobile synchronization.
- Multi-user tenancy or per-person vault sharing.
- Exposing arbitrary filesystem paths through MCP.

Semantic search can be added later with a newly issued external embedding API key. The DashScope key previously exposed in chat must never be used.

## 4. Architecture

```text
ChatGPT / Codex / mobile or cloud agent
                  |
               HTTPS
                  |
        Caddy reverse proxy :443
                  |
      MCP service 127.0.0.1:8787
          |                 |
   Vault registry       SQLite index
          |                 |
  /srv/brain/vaults/<vault-id>/*.md
```

### 4.1 Oracle VM

- Region: `ap-chuncheon-1`
- Shape: `VM.Standard.E2.1.Micro`, Always Free-eligible
- Image: Canonical Ubuntu 24.04 x86
- Boot volume: the Free Tier-compatible default size
- Memory support: a 2 GB swap file to reduce out-of-memory failures during package installation and indexing
- Public access: ports 80 and 443; port 22 remains restricted and is not used as the public MCP interface
- Process management: systemd services for the MCP application and index worker

### 4.2 Public Endpoint

Caddy terminates TLS and proxies only the MCP route to the Node.js application bound to loopback. Before the user supplies a permanent domain, the deployment uses an IP-derived `sslip.io` hostname. The intended stable form is:

```text
https://<public-hostname>/mcp
```

The Node.js port is never exposed directly to the internet.

### 4.3 Application Base

The implementation starts from `bepitulaz/obsidian-multivault-mcp` because it already provides Streamable HTTP MCP, OAuth-oriented remote access, filesystem tools, and Caddy deployment patterns. It is extended from its original one-user-to-one-vault mapping to a one-owner-to-many-vault registry.

The implementation is maintained in this Git repository. Oracle receives a tested release archive or checks out a remote copy of the repository; the VM does not depend on a local computer after deployment.

## 5. Vault and Authorization Model

### 5.1 Directory Layout

```text
/srv/brain/
  vaults/
    personal/
      Agent-Inbox/
    work/
      Agent-Inbox/
    research/
      Agent-Inbox/
  data/
    index.sqlite
    audit.jsonl
  config/
    vaults.json
```

`vaults.json` maps stable vault identifiers to fixed absolute roots. MCP clients can submit only a registered vault identifier, never an operating-system path.

Example logical configuration:

```json
{
  "vaults": {
    "personal": { "root": "/srv/brain/vaults/personal" },
    "work": { "root": "/srv/brain/vaults/work" },
    "research": { "root": "/srv/brain/vaults/research" }
  },
  "owner": {
    "allowedVaults": ["personal", "work", "research"]
  }
}
```

Secrets and password material are stored outside Git with owner-only filesystem permissions.

### 5.2 Read Policy

The owner can list folders, search, inspect links, and read Markdown notes in every registered vault. Hidden Obsidian metadata and non-Markdown files are excluded by default unless a later explicit allowlist permits them.

### 5.3 Write Policy

The only write operation in the first release is creating a new Markdown file beneath `<vault>/Agent-Inbox/`. Existing files cannot be overwritten. Update, move, rename, and delete tools are not exposed.

New files are created atomically and receive collision-safe names. The application rejects absolute paths, `..` traversal, alternate path separators, invalid extensions, oversized content, and symlinked parents that resolve outside the chosen vault root.

Every successful or denied write is recorded in an append-only audit log without recording authentication secrets.

## 6. MCP Tool Interface

The public tool set is intentionally small:

- `list_vaults()` returns the vault identifiers available to the authenticated owner.
- `list_notes(vault, folder?, limit?, cursor?)` lists Markdown notes within one registered vault.
- `search_notes(query, vaults?, limit?)` searches one or all vaults and returns vault ID, relative path, title, matched excerpt, tags, and score.
- `read_note(vault, path)` returns the current Markdown content and indexed metadata.
- `get_note_links(vault, path)` returns outgoing links and indexed backlinks.
- `create_inbox_note(vault, title, content, frontmatter?)` creates a new note in the selected vault's `Agent-Inbox`.

All tools validate the authenticated owner and vault allowlist before resolving a note path. Results are bounded by configurable size and count limits so one request cannot exhaust the small VM.

## 7. Search Database

Markdown is the source of truth. SQLite is a disposable, rebuildable projection used only for fast agent retrieval.

### 7.1 Indexed Fields

Each note record stores:

- vault identifier
- relative path
- title and headings
- Markdown body
- YAML frontmatter fields
- tags
- outgoing wiki links and Markdown links
- file modification time, size, and content hash
- a short plain-text excerpt for search results

Backlinks are derived from outgoing link rows rather than written into Markdown.

### 7.2 Text Search

SQLite FTS5 provides full-text search. A trigram search index supports useful Korean and English substring matching without requiring an embedding API. Exact filters for vault, path, tag, and frontmatter are applied before result ranking where possible.

### 7.3 Index Lifecycle

- A complete initial scan builds the database from every registered vault.
- A filesystem watcher debounces create, change, rename, and delete events and updates affected records transactionally.
- A scheduled reconciliation scan repairs missed watcher events.
- `create_inbox_note` updates the database immediately after the atomic Markdown write.
- If the database is missing or corrupt, the service moves it aside, rebuilds from Markdown, and keeps the original for diagnosis.

The indexer limits concurrency and reads files in bounded chunks to fit the 1 GB VM.

## 8. Authentication and Transport Security

- Remote MCP uses Streamable HTTP over TLS.
- The application retains the base project's OAuth 2.1 and PKCE-compatible login flow, adapted to the single-owner multi-vault model.
- Session and signing secrets are generated on the VM and never committed.
- Caddy is the only internet-facing application process.
- Login and MCP request rate limits reduce brute-force and resource-exhaustion risk.
- Security headers, request-body limits, and timeouts are enforced at the reverse proxy and application layers.
- OCI network rules allow 80/443 publicly. Administrative access uses keys and is restricted where practical.

## 9. Operations and Recovery

- The MCP service and indexer start automatically through systemd.
- Structured logs go to journald; the write audit uses a separate JSON Lines file.
- A health endpoint is available only through an explicit Caddy route and reveals no vault contents.
- Log rotation prevents the 1 GB VM and small boot disk from filling.
- Nightly local snapshots retain recent Vault and configuration versions.
- An OCI boot-volume backup policy provides off-instance recovery within Free Tier backup limits.
- Restore verification includes rebuilding SQLite entirely from restored Markdown.

## 10. Error Handling

- Unknown vault IDs return a generic authorization/not-found error without revealing filesystem roots.
- Invalid or escaping paths are rejected before filesystem access.
- Indexing failures identify the affected vault and relative path in logs, keep the last valid index record, and retry during reconciliation.
- Malformed YAML does not block indexing; the note remains searchable as body text and the metadata error is recorded.
- Oversized notes are rejected from agent writes and indexed with bounded excerpts.
- SQLite updates use transactions so partial scans do not leave mixed index state.
- Service startup fails closed if configuration or authentication secrets have unsafe permissions.

## 11. Testing Strategy

### 11.1 Automated Tests

- Vault registry and allowlist tests
- Path traversal tests for Windows and POSIX separators
- Symlink escape tests
- Existing-file overwrite rejection tests
- Inbox-only write tests
- Atomic-write collision tests
- Markdown/frontmatter/tag/link parsing tests
- Korean and English FTS substring search tests
- Cross-vault and vault-scoped ranking tests
- Incremental index and full rebuild equivalence tests
- Corrupt-index recovery tests
- MCP schema and bounded-response tests
- Authentication and request-limit tests

### 11.2 Integration Tests

Temporary `personal` and `work` vaults verify:

1. both vaults appear through `list_vaults`;
2. a cross-vault query returns notes from both;
3. a vault-scoped query excludes the other vault;
4. `read_note` returns the expected Markdown;
5. `create_inbox_note` succeeds only in the selected `Agent-Inbox`;
6. overwrite, edit, delete, traversal, and symlink attempts fail;
7. watcher updates and a clean rebuild produce equivalent results.

### 11.3 Deployment Verification

- Confirm the Oracle instance and boot volume show an Always Free-eligible estimate before creation.
- Confirm only intended network ports are reachable.
- Connect through the final HTTPS MCP URL and complete OAuth login.
- Run list, search, read, link, and allowed-write checks through the public endpoint.
- Restart the VM and repeat health and search checks.
- Restore a test note from backup and rebuild the index.

## 12. Implementation Order

1. Create the Free Tier Ubuntu VM and verify its cost estimate.
2. Establish the local source repository from the selected upstream base.
3. Implement and test the vault registry, path policy, Markdown parser, SQLite index, and MCP tools.
4. Package the tested server and deploy it to Oracle.
5. Configure Caddy, TLS, OAuth secrets, systemd, firewall rules, and backups.
6. Add sample vaults and run automated, integration, and public end-to-end verification.
7. Replace sample data with the user's real vaults using an explicit upload or synchronization workflow.

