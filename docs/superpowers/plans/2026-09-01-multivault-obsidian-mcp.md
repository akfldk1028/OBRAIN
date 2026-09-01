# Multi-Vault Obsidian MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, test, and deploy a single-owner HTTPS MCP server that keeps multiple Obsidian vaults as Markdown, indexes them in SQLite, searches them across vaults, and permits writes only as new notes under each vault's `Agent-Inbox`.

**Architecture:** Preserve the upstream stdio/SSH path and add a separate HTTP knowledge path. A `VaultRegistry` confines named vaults, a rebuildable SQLite FTS5 index provides Korean/English substring retrieval, and a `KnowledgeBase` exposes the safe read/search/inbox-write surface to MCP. Caddy terminates TLS on an Oracle Always Free Ubuntu VM and proxies to a loopback-only Node process protected by the upstream OAuth 2.1/PKCE flow.

**Tech Stack:** TypeScript, Node.js 22 LTS, `@modelcontextprotocol/sdk`, Express 5, Zod, `better-sqlite3`, FTS5 trigram tokenization, `gray-matter`, `chokidar`, Vitest, esbuild, Caddy, systemd, Ubuntu 24.04, Oracle Cloud Free Tier.

**Spec:** `docs/superpowers/specs/2026-09-01-multivault-obsidian-mcp-design.md`

## Global Constraints

- Keep ordinary `.md` files as the canonical source of truth; SQLite must be fully rebuildable from Markdown.
- Preserve the existing stdio-over-SSH flow and its existing read/write tools.
- The public HTTP flow has one owner who can access every configured vault.
- Public tools can list, search, read, inspect links, and create a new Markdown note only under `Agent-Inbox`.
- Public tools must not expose edit, overwrite, append, move, rename, or delete operations.
- Resolve vaults only from configured identifiers; never accept an absolute filesystem root from an MCP request.
- Reject traversal, null bytes, disallowed extensions, oversized writes, existing-file overwrite, and symlink escapes.
- Bind Node to `127.0.0.1:8787`; Caddy is the only public listener.
- Keep secrets outside Git in mode-600 files.
- Do not use the DashScope key exposed in chat.
- Fit the service into `VM.Standard.E2.1.Micro` with 1 GB RAM and a 2 GB swap file.
- Follow TDD for each behavior change and commit after every independently testable task.

---

## File Map

### Existing upstream files to import and then modify

- `package.json`: scripts, runtime dependencies, and test dependencies.
- `package-lock.json`: exact dependency graph.
- `tsconfig.json`: include `src` and `test` TypeScript.
- `esbuild.config.mjs`: bundle application JavaScript while leaving the native SQLite module external.
- `src/vault.ts`: existing confined filesystem plus the new inbox-only atomic writer.
- `src/tools.ts`: untouched legacy stdio tools.
- `src/server-factory.ts`: preserve `createMcpServer(vault)` and add `createKnowledgeMcpServer(knowledgeBase)`.
- `src/index.ts`: preserve stdio startup and add the HTTP knowledge configuration lifecycle.
- `src/http.ts`: route an authenticated owner to a `KnowledgeBase` instead of one `VaultFS`.
- `src/oauth-provider.ts`: retain the existing OAuth 2.1, PKCE, DCR, JWT, and constant-time passphrase comparison.
- `scripts/smoke.mjs`: retain legacy stdio regression coverage.
- `scripts/smoke-http.mjs`: update public tool assertions and cross-vault OAuth coverage.

### New application files

- `src/config.ts`: parse and validate the mode-600 server configuration.
- `src/vault-registry.ts`: map stable vault IDs to confined `VaultFS` instances.
- `src/audit.ts`: append safe write/denial events as JSON Lines.
- `src/note-parser.ts`: extract frontmatter, tags, headings, and links from Markdown.
- `src/search-index.ts`: own the SQLite schema, indexing mutations, FTS search, and backlinks.
- `src/index-coordinator.ts`: full scan, incremental reconciliation, and filesystem watching.
- `src/knowledge-base.ts`: single authorization-aware API used by MCP handlers.
- `src/knowledge-tools.ts`: register the limited public MCP tool set.

### New tests

- `test/helpers/temp-vaults.ts`: deterministic temporary vault fixture builder.
- `test/config.test.ts`: configuration and allowlist validation.
- `test/vault-registry.test.ts`: vault-ID lookup and scope enforcement.
- `test/vault-inbox.test.ts`: inbox-only creation and filesystem security.
- `test/audit.test.ts`: append-only, secret-free audit records.
- `test/note-parser.test.ts`: frontmatter, tag, heading, and link extraction.
- `test/search-index.test.ts`: schema, Korean/English search, filters, links, and rebuilds.
- `test/index-coordinator.test.ts`: scan, watcher, stale-record removal, and corrupt-index recovery.
- `test/knowledge-base.test.ts`: cross-vault reads/search and allowed/denied writes.
- `test/knowledge-tools.test.ts`: MCP schemas and registered public tool names.
- `test/helpers/oauth-flow.ts`: DCR, PKCE, login, token, and authenticated MCP test driver.
- `test/http.test.ts`: OAuth owner routing, auth gate, body limits, and session ownership.

### Deployment files

- `deploy/brain-mcp.service`: hardened systemd unit.
- `deploy/Caddyfile`: SSE-safe reverse proxy with body limits and security headers.
- `deploy/brain-mcp-config.example.json`: secret-free schema example.
- `deploy/install.sh`: idempotent package, directory, service, and secret installation.
- `deploy/backup.sh`: nightly local snapshot with retention.
- `deploy/brain-mcp-backup.service`: one-shot backup unit.
- `deploy/brain-mcp-backup.timer`: persistent nightly schedule.
- `deploy/README.md`: exact Oracle and host verification runbook.

---

### Task 1: Import the Upstream Baseline and Add a Test Harness

**Files:**
- Create from upstream: `src/*.ts`, `scripts/*.mjs`, `package.json`, `package-lock.json`, `tsconfig.json`, `esbuild.config.mjs`, `README.md`, `DEPLOY.md`, `LICENSE`, `AGENTS.md`, `users.example.json`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `test/sanity.test.ts`

**Interfaces:**
- Consumes: upstream commit `c2426358ba848a7b9db073f7bdae24682ea9f13c`.
- Produces: `npm test`, `npm run typecheck`, `npm run build`, and the unchanged legacy smoke scripts.

- [ ] **Step 1: Import the exact upstream tree without replacing the approved design files**

```powershell
git remote add upstream https://github.com/bepitulaz/obsidian-multivault-mcp.git
git -c http.sslBackend=openssl fetch --depth 1 upstream c2426358ba848a7b9db073f7bdae24682ea9f13c
git checkout FETCH_HEAD -- .
```

Expected: upstream source files appear, while both `docs/superpowers/specs/...` and this plan remain present.

- [ ] **Step 2: Install the untouched baseline and verify it**

Run:

```powershell
npm ci
npm run typecheck
npm run build
npm run smoke:http
```

Expected: typecheck and build exit 0; `smoke:http` ends with `OK`.

- [ ] **Step 3: Add Vitest and the planned runtime dependencies**

Run:

```powershell
npm install better-sqlite3 chokidar gray-matter
npm install --save-dev vitest @vitest/coverage-v8 @types/better-sqlite3
```

Add these scripts to `package.json`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "verify": "npm run test && npm run typecheck && npm run build && npm run smoke && npm run smoke:http"
  }
}
```

- [ ] **Step 4: Add a test-runner sanity test**

```ts
// test/sanity.test.ts
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("runs on Node", () => {
    expect(process.versions.node).toMatch(/^\d+\./);
  });
});
```

Change `tsconfig.json` to set `rootDir` to `.` and include both trees:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node", "vitest/globals"],
    "rootDir": "."
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 5: Run the harness**

Run: `npm test`

Expected: one passing test file and zero failures.

- [ ] **Step 6: Commit the imported baseline and harness**

```powershell
git add AGENTS.md CLAUDE.md DEPLOY.md LICENSE README.md users.example.json package.json package-lock.json tsconfig.json esbuild.config.mjs scripts src test/sanity.test.ts
git commit -m "chore: import upstream MCP server and test harness"
```

---

### Task 2: Add the Multi-Vault Configuration and Registry

**Files:**
- Create: `src/config.ts`
- Create: `src/vault-registry.ts`
- Create: `test/helpers/temp-vaults.ts`
- Create: `test/config.test.ts`
- Create: `test/vault-registry.test.ts`
- Create: `deploy/brain-mcp-config.example.json`

**Interfaces:**
- Consumes: `VaultFS.create(root, options)` from `src/vault.ts`.
- Produces: `loadKnowledgeConfig(filePath): Promise<LoadedKnowledgeConfig>` and `VaultRegistry` with `ids()`, `entries()`, `get(id)`, and `has(id)`.

- [ ] **Step 1: Write the failing configuration tests**

```ts
// test/config.test.ts
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";
import { loadKnowledgeConfig } from "../src/config.js";

describe("loadKnowledgeConfig", () => {
  it("loads one owner with every configured vault", async () => {
    const fx = await makeTempVaultSet(["personal", "work"]);
    const configPath = path.join(fx.root, "config.json");
    await writeFile(configPath, JSON.stringify({
      dataDir: path.join(fx.root, "data"),
      owner: { id: "owner", passphrase: "a-long-test-passphrase", allowedVaults: ["personal", "work"] },
      vaults: fx.vaults.map((v) => ({ id: v.id, root: v.root })),
    }), { mode: 0o600 });

    const loaded = await loadKnowledgeConfig(configPath);
    expect(loaded.owner.id).toBe("owner");
    expect(loaded.registry.ids()).toEqual(["personal", "work"]);
  });

  it("rejects duplicate and unknown vault IDs", async () => {
    const fx = await makeTempVaultSet(["personal"]);
    const configPath = path.join(fx.root, "bad.json");
    await writeFile(configPath, JSON.stringify({
      dataDir: path.join(fx.root, "data"),
      owner: { id: "owner", passphrase: "a-long-test-passphrase", allowedVaults: ["missing"] },
      vaults: [{ id: "personal", root: fx.vaults[0].root }],
    }), { mode: 0o600 });
    await expect(loadKnowledgeConfig(configPath)).rejects.toThrow(/unknown vault/i);
  });
});
```

```ts
// test/helpers/temp-vaults.ts
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function makeTempVaultSet(ids: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "brain-vaults-"));
  const vaults = [] as { id: string; root: string }[];
  for (const id of ids) {
    const vaultRoot = path.join(root, id);
    await mkdir(path.join(vaultRoot, "Agent-Inbox"), { recursive: true });
    vaults.push({ id, root: vaultRoot });
  }
  return { root, vaults, cleanup: () => rm(root, { recursive: true, force: true }) };
}
```

- [ ] **Step 2: Run the tests and confirm the missing-module failure**

Run: `npx vitest run test/config.test.ts`

Expected: FAIL because `src/config.ts` and `src/vault-registry.ts` do not exist.

- [ ] **Step 3: Implement `VaultRegistry`**

```ts
// src/vault-registry.ts
import { VaultFS, VaultError } from "./vault.js";

export interface VaultDefinition { id: string; root: string }

export class VaultRegistry {
  private constructor(private readonly byId: Map<string, VaultFS>) {}

  static async create(definitions: VaultDefinition[]): Promise<VaultRegistry> {
    const byId = new Map<string, VaultFS>();
    for (const definition of definitions) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(definition.id)) {
        throw new VaultError(`Invalid vault id: ${definition.id}`);
      }
      if (byId.has(definition.id)) throw new VaultError(`Duplicate vault id: ${definition.id}`);
      byId.set(definition.id, await VaultFS.create(definition.root, { allowedExt: [".md"] }));
    }
    if (!byId.size) throw new VaultError("At least one vault is required");
    return new VaultRegistry(byId);
  }

  ids(): string[] { return [...this.byId.keys()].sort(); }
  entries(): [string, VaultFS][] { return [...this.byId.entries()]; }
  has(id: string): boolean { return this.byId.has(id); }
  get(id: string): VaultFS {
    const vault = this.byId.get(id);
    if (!vault) throw new VaultError("Unknown or unauthorized vault");
    return vault;
  }
}
```

- [ ] **Step 4: Implement validated config loading**

```ts
// src/config.ts
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { VaultRegistry } from "./vault-registry.js";

const schema = z.object({
  dataDir: z.string().min(1),
  owner: z.object({
    id: z.string().min(1),
    passphrase: z.string().min(16),
    allowedVaults: z.array(z.string()).min(1),
  }),
  vaults: z.array(z.object({ id: z.string(), root: z.string().min(1) })).min(1),
});

export interface LoadedKnowledgeConfig {
  dataDir: string;
  owner: { id: string; passphrase: string; allowedVaults: string[] };
  registry: VaultRegistry;
}

export async function loadKnowledgeConfig(filePath: string): Promise<LoadedKnowledgeConfig> {
  const fileStat = await stat(filePath);
  if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
    throw new Error("Knowledge config permissions must be 600");
  }
  const raw = schema.parse(JSON.parse(await readFile(filePath, "utf8")));
  const registry = await VaultRegistry.create(raw.vaults);
  const allowed = [...new Set(raw.owner.allowedVaults)];
  for (const id of allowed) if (!registry.has(id)) throw new Error(`Owner references unknown vault: ${id}`);
  if (allowed.length !== registry.ids().length) throw new Error("Single owner must be allowed every vault");
  return { dataDir: path.resolve(raw.dataDir), owner: { ...raw.owner, allowedVaults: allowed }, registry };
}
```

- [ ] **Step 5: Add the registry tests**

```ts
// test/vault-registry.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";
import { VaultRegistry } from "../src/vault-registry.js";

describe("VaultRegistry", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  it("resolves configured IDs and hides filesystem paths in errors", async () => {
    const fx = await makeTempVaultSet(["personal", "work"]); cleanups.push(fx.cleanup);
    const registry = await VaultRegistry.create(fx.vaults);
    expect(registry.get("personal").rootPath).toBe(fx.vaults[0].root);
    expect(() => registry.get("missing")).toThrow("Unknown or unauthorized vault");
  });
});
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/config.test.ts test/vault-registry.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Add a secret-free production configuration example**

```json
{
  "dataDir": "/srv/brain/data",
  "owner": {
    "id": "owner",
    "passphrase": "example-only-not-a-production-secret",
    "allowedVaults": ["personal", "work", "research"]
  },
  "vaults": [
    { "id": "personal", "root": "/srv/brain/vaults/personal" },
    { "id": "work", "root": "/srv/brain/vaults/work" },
    { "id": "research", "root": "/srv/brain/vaults/research" }
  ]
}
```

- [ ] **Step 8: Commit**

```powershell
git add src/config.ts src/vault-registry.ts test/helpers/temp-vaults.ts test/config.test.ts test/vault-registry.test.ts deploy/brain-mcp-config.example.json
git commit -m "feat: add single-owner multi-vault registry"
```

---

### Task 3: Enforce Inbox-Only Writes and Audit Them

**Files:**
- Modify: `src/vault.ts`
- Create: `src/audit.ts`
- Create: `test/vault-inbox.test.ts`
- Create: `test/audit.test.ts`

**Interfaces:**
- Consumes: confined path checks already implemented by `VaultFS`.
- Produces: `VaultFS.createInboxNote(input): Promise<CreatedInboxNote>` and `AuditLogger.record(event): Promise<void>`.

- [ ] **Step 1: Write failing inbox security tests**

```ts
// test/vault-inbox.test.ts
import { mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultFS } from "../src/vault.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("createInboxNote", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  it("creates a unique markdown note only in Agent-Inbox", async () => {
    const fx = await makeTempVaultSet(["personal"]); cleanups.push(fx.cleanup);
    const vault = await VaultFS.create(fx.vaults[0].root, { allowedExt: [".md"] });
    const created = await vault.createInboxNote({ title: "회의 기록", content: "본문" });
    expect(created.path).toMatch(/^Agent-Inbox\//);
    expect(await readFile(path.join(fx.vaults[0].root, created.path), "utf8")).toContain("본문");
  });

  it("rejects oversized content and an escaped inbox symlink", async () => {
    const fx = await makeTempVaultSet(["personal"]); cleanups.push(fx.cleanup);
    const outside = path.join(fx.root, "outside"); await mkdir(outside);
    const inbox = path.join(fx.vaults[0].root, "Agent-Inbox");
    await (await import("node:fs/promises")).rm(inbox, { recursive: true });
    await symlink(outside, inbox, "junction");
    const vault = await VaultFS.create(fx.vaults[0].root, { allowedExt: [".md"] });
    await expect(vault.createInboxNote({ title: "escape", content: "x" })).rejects.toThrow(/escapes/i);
    await expect(vault.createInboxNote({ title: "huge", content: "x".repeat(1_048_577) })).rejects.toThrow(/too large/i);
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing-method failure**

Run: `npx vitest run test/vault-inbox.test.ts`

Expected: FAIL because `createInboxNote` does not exist.

- [ ] **Step 3: Implement collision-safe inbox creation**

Add to `src/vault.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";

export interface InboxNoteInput {
  title: string;
  content: string;
  frontmatter?: Record<string, string | number | boolean | string[]>;
}
export interface CreatedInboxNote { path: string; content: string }
const MAX_INBOX_BYTES = 1_048_576;

async createInboxNote(input: InboxNoteInput): Promise<CreatedInboxNote> {
  this.assertWritable();
  if (!input.title.trim()) throw new VaultError("Title is required");
  if (Buffer.byteLength(input.content, "utf8") > MAX_INBOX_BYTES) throw new VaultError("Note is too large");
  const slug = input.title.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80) || "note";
  const date = new Date().toISOString().slice(0, 10);
  const rel = path.posix.join("Agent-Inbox", `${date}-${slug}-${randomBytes(4).toString("hex")}.md`);
  const abs = await this.resolveConfined(rel, false);
  const tmp = path.join(path.dirname(abs), `.tmp-${randomUUID()}`);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const yaml = input.frontmatter && Object.keys(input.frontmatter).length
    ? `---\n${Object.entries(input.frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n`
    : "";
  const rendered = `${yaml}# ${input.title.trim()}\n\n${input.content}`;
  if (Buffer.byteLength(rendered, "utf8") > MAX_INBOX_BYTES) throw new VaultError("Note is too large");
  await fs.writeFile(tmp, rendered, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await fs.link(tmp, abs);
  } catch (error: any) {
    if (error?.code === "EEXIST") throw new VaultError("Inbox note collision; retry the request");
    throw error;
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return { path: rel, content: rendered };
}
```

Keep the legacy `writeNote`, `appendNote`, `editNote`, `deleteNote`, and `moveNote` methods unchanged for the stdio path; the public tool registry will not expose them.

- [ ] **Step 4: Write and implement the audit logger**

```ts
// test/audit.test.ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

it("records bounded metadata without note content", async () => {
  const fx = await makeTempVaultSet(["personal"]);
  const file = path.join(fx.root, "audit.jsonl");
  await new AuditLogger(file).record({ action: "create_inbox_note", outcome: "allowed", vault: "personal", path: "Agent-Inbox/a.md" });
  const text = await readFile(file, "utf8");
  expect(text).toContain('"outcome":"allowed"');
  expect(text).not.toContain("passphrase");
  await fx.cleanup();
});
```

```ts
// src/audit.ts
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  action: "create_inbox_note";
  outcome: "allowed" | "denied";
  vault: string;
  path?: string;
  reason?: string;
}

export class AuditLogger {
  constructor(private readonly file: string) {}
  async record(event: AuditEvent): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const safe = { timestamp: new Date().toISOString(), ...event, reason: event.reason?.slice(0, 200) };
    await appendFile(this.file, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
```

- [ ] **Step 5: Run focused and regression tests**

Run: `npx vitest run test/vault-inbox.test.ts test/audit.test.ts && npm run typecheck && npm run smoke`

Expected: all new tests pass and the unchanged stdio smoke ends with `OK`.

- [ ] **Step 6: Commit**

```powershell
git add src/vault.ts src/audit.ts test/vault-inbox.test.ts test/audit.test.ts
git commit -m "feat: restrict public writes to atomic inbox creation"
```

---

### Task 4: Parse Markdown and Build the SQLite Search Index

**Files:**
- Create: `src/note-parser.ts`
- Create: `src/search-index.ts`
- Create: `test/note-parser.test.ts`
- Create: `test/search-index.test.ts`
- Modify: `esbuild.config.mjs`

**Interfaces:**
- Produces: `parseNote(vaultId, relativePath, content, stat): ParsedNote`.
- Produces: `SearchIndex` methods `upsert`, `remove`, `removeMissing`, `search`, `backlinks`, `outgoingLinks`, `clear`, and `close`.

- [ ] **Step 1: Write failing parser tests**

```ts
// test/note-parser.test.ts
import { describe, expect, it } from "vitest";
import { parseNote } from "../src/note-parser.js";

describe("parseNote", () => {
  it("extracts frontmatter, inline tags, headings, wiki links, and markdown links", () => {
    const note = parseNote("personal", "Projects/계획.md", `---\ntags: [업무, ai]\nstatus: active\n---\n# 계획\n본문 #중요 [[아이디어|별칭]] [문서](Guide.md)`, { mtimeMs: 10, size: 20 });
    expect(note.title).toBe("계획");
    expect(note.tags).toEqual(expect.arrayContaining(["업무", "ai", "중요"]));
    expect(note.outgoingLinks).toEqual(expect.arrayContaining(["아이디어", "Guide.md"]));
    expect(note.frontmatter.status).toBe("active");
  });

  it("keeps malformed frontmatter searchable as body text", () => {
    const note = parseNote("personal", "broken.md", "---\ntags: [broken\n---\n복구검색어", { mtimeMs: 10, size: 30 });
    expect(note.body).toContain("복구검색어");
    expect(note.metadataError).toMatch(/frontmatter/i);
  });
});
```

- [ ] **Step 2: Verify parser tests fail**

Run: `npx vitest run test/note-parser.test.ts`

Expected: FAIL because `src/note-parser.ts` does not exist.

- [ ] **Step 3: Implement the parser with stable output types**

```ts
// src/note-parser.ts
import { createHash } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";

export interface ParsedNote {
  vaultId: string; path: string; title: string; body: string; excerpt: string;
  frontmatter: Record<string, unknown>; tags: string[]; headings: string[];
  outgoingLinks: string[]; mtimeMs: number; size: number; contentHash: string;
  metadataError?: string;
}

export function parseNote(vaultId: string, relativePath: string, content: string, stat: { mtimeMs: number; size: number }): ParsedNote {
  let body = content;
  let frontmatter: Record<string, unknown> = {};
  let metadataError: string | undefined;
  try {
    const parsed = matter(content);
    body = parsed.content;
    frontmatter = parsed.data;
  } catch {
    metadataError = "Malformed frontmatter";
  }
  const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].trim());
  const inlineTags = [...body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((m) => m[1]);
  const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : frontmatter.tags ? [String(frontmatter.tags)] : [];
  const wiki = [...body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
  const markdown = [...body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1].split("#", 1)[0].trim());
  const fallbackTitle = path.basename(relativePath, path.extname(relativePath));
  return {
    vaultId, path: relativePath, title: headings[0] ?? fallbackTitle, body,
    excerpt: body.replace(/\s+/g, " ").trim().slice(0, 400),
    frontmatter, tags: [...new Set([...fmTags, ...inlineTags])].sort(), headings,
    outgoingLinks: [...new Set([...wiki, ...markdown].filter(Boolean))].sort(),
    mtimeMs: stat.mtimeMs, size: stat.size,
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    metadataError,
  };
}
```

- [ ] **Step 4: Write failing SQLite search tests**

```ts
// test/search-index.test.ts
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SearchIndex } from "../src/search-index.js";
import { parseNote } from "../src/note-parser.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("SearchIndex", () => {
  it("searches Korean substrings across vaults and respects a vault filter", async () => {
    const fx = await makeTempVaultSet(["personal", "work"]);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));
    index.upsert(parseNote("personal", "생각.md", "# 장기 프로젝트\n개인지식", { mtimeMs: 1, size: 10 }));
    index.upsert(parseNote("work", "업무.md", "# 프로젝트 회의\n결정사항", { mtimeMs: 2, size: 10 }));
    expect(index.search("프로젝트", ["personal", "work"], 10)).toHaveLength(2);
    expect(index.search("프로젝트", ["work"], 10).map((h) => h.vaultId)).toEqual(["work"]);
    index.close(); await fx.cleanup();
  });

  it("returns backlinks within the selected vault", async () => {
    const fx = await makeTempVaultSet(["personal"]);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));
    index.upsert(parseNote("personal", "A.md", "[[B]]", { mtimeMs: 1, size: 5 }));
    index.upsert(parseNote("personal", "B.md", "# B", { mtimeMs: 1, size: 3 }));
    expect(index.backlinks("personal", "B.md")).toEqual(["A.md"]);
    index.close(); await fx.cleanup();
  });
});
```

- [ ] **Step 5: Verify index tests fail**

Run: `npx vitest run test/search-index.test.ts`

Expected: FAIL because `SearchIndex` does not exist.

- [ ] **Step 6: Implement the SQLite schema and queries**

Create `src/search-index.ts` with these public types and statements:

```ts
import Database from "better-sqlite3";
import type { ParsedNote } from "./note-parser.js";

export interface IndexedSearchHit {
  vaultId: string; path: string; title: string; excerpt: string; tags: string[]; score: number;
}

export class SearchIndex {
  private readonly db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY, vault_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL, excerpt TEXT NOT NULL, frontmatter_json TEXT NOT NULL, tags_json TEXT NOT NULL,
        mtime_ms REAL NOT NULL, size INTEGER NOT NULL, content_hash TEXT NOT NULL,
        UNIQUE(vault_id, path)
      );
      CREATE TABLE IF NOT EXISTS links (
        source_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        target TEXT NOT NULL, UNIQUE(source_id, target)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, body, tags, content='notes', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid,title,body,tags) VALUES(new.id,new.title,new.body,new.tags_json);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts,rowid,title,body,tags) VALUES('delete',old.id,old.title,old.body,old.tags_json);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts,rowid,title,body,tags) VALUES('delete',old.id,old.title,old.body,old.tags_json);
        INSERT INTO notes_fts(rowid,title,body,tags) VALUES(new.id,new.title,new.body,new.tags_json);
      END;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  upsert(note: ParsedNote): void {
    this.db.transaction(() => {
      const row = this.db.prepare(`
        INSERT INTO notes(vault_id,path,title,body,excerpt,frontmatter_json,tags_json,mtime_ms,size,content_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(vault_id,path) DO UPDATE SET
          title=excluded.title, body=excluded.body, excerpt=excluded.excerpt,
          frontmatter_json=excluded.frontmatter_json, tags_json=excluded.tags_json,
          mtime_ms=excluded.mtime_ms, size=excluded.size, content_hash=excluded.content_hash
        RETURNING id
      `).get(
        note.vaultId, note.path, note.title, note.body, note.excerpt,
        JSON.stringify(note.frontmatter), JSON.stringify(note.tags), note.mtimeMs, note.size, note.contentHash,
      ) as { id: number };
      this.db.prepare("DELETE FROM links WHERE source_id=?").run(row.id);
      const insertLink = this.db.prepare("INSERT OR IGNORE INTO links(source_id,target) VALUES(?,?)");
      for (const target of note.outgoingLinks) insertLink.run(row.id, target);
    })();
  }

  remove(vaultId: string, relativePath: string): void {
    this.db.prepare("DELETE FROM notes WHERE vault_id=? AND path=?").run(vaultId, relativePath);
  }

  removeMissing(vaultId: string, presentPaths: Set<string>): void {
    const rows = this.db.prepare("SELECT path FROM notes WHERE vault_id=?").all(vaultId) as { path: string }[];
    const remove = this.db.prepare("DELETE FROM notes WHERE vault_id=? AND path=?");
    this.db.transaction(() => {
      for (const row of rows) if (!presentPaths.has(row.path)) remove.run(vaultId, row.path);
    })();
  }

  search(query: string, allowedVaults: string[], limit: number): IndexedSearchHit[] {
    if (!allowedVaults.length || !query.trim()) return [];
    const bounded = Math.max(1, Math.min(200, limit));
    const vaultSlots = allowedVaults.map(() => "?").join(",");
    const trimmed = query.trim();
    let rows: Array<{ vault_id: string; path: string; title: string; excerpt: string; tags_json: string; score: number }>;
    if ([...trimmed].length >= 3) {
      const ftsPhrase = `"${trimmed.replaceAll('"', '""')}"`;
      rows = this.db.prepare(`
        SELECT n.vault_id,n.path,n.title,n.excerpt,n.tags_json,-bm25(notes_fts) AS score
        FROM notes_fts JOIN notes n ON n.id=notes_fts.rowid
        WHERE notes_fts MATCH ? AND n.vault_id IN (${vaultSlots})
        ORDER BY score DESC,n.vault_id,n.path LIMIT ?
      `).all(ftsPhrase, ...allowedVaults, bounded) as typeof rows;
    } else {
      const escaped = trimmed.replace(/[\\%_]/g, "\\$&");
      rows = this.db.prepare(`
        SELECT vault_id,path,title,excerpt,tags_json,0.0 AS score FROM notes
        WHERE vault_id IN (${vaultSlots})
          AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')
        ORDER BY vault_id,path LIMIT ?
      `).all(...allowedVaults, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`, bounded) as typeof rows;
    }
    return rows.map((row) => ({
      vaultId: row.vault_id, path: row.path, title: row.title,
      excerpt: row.excerpt, tags: JSON.parse(row.tags_json) as string[], score: row.score,
    }));
  }

  outgoingLinks(vaultId: string, relativePath: string): string[] {
    return (this.db.prepare(`
      SELECT l.target FROM links l JOIN notes n ON n.id=l.source_id
      WHERE n.vault_id=? AND n.path=? ORDER BY l.target
    `).all(vaultId, relativePath) as { target: string }[]).map((row) => row.target);
  }

  backlinks(vaultId: string, relativePath: string): string[] {
    const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\.md$/i, "").replace(/^\.\//, "").toLowerCase();
    const wanted = normalize(relativePath);
    const basename = wanted.split("/").at(-1);
    const rows = this.db.prepare(`
      SELECT n.path,l.target FROM links l JOIN notes n ON n.id=l.source_id
      WHERE n.vault_id=? ORDER BY n.path
    `).all(vaultId) as { path: string; target: string }[];
    return [...new Set(rows.filter((row) => {
      const target = normalize(row.target);
      return target === wanted || (!target.includes("/") && target === basename);
    }).map((row) => row.path))];
  }
  clear(): void { this.db.exec("DELETE FROM links; DELETE FROM notes;"); }
  close(): void { this.db.close(); }
}
```

- [ ] **Step 7: Externalize the native SQLite module from the bundle**

Add to the esbuild options in `esbuild.config.mjs`:

```js
external: ["better-sqlite3"],
```

The deployment must retain production `node_modules/better-sqlite3` next to `dist/index.js`.

- [ ] **Step 8: Run parser/index tests and build**

Run: `npx vitest run test/note-parser.test.ts test/search-index.test.ts && npm run typecheck && npm run build`

Expected: PASS; esbuild completes without attempting to bundle the `.node` binary.

- [ ] **Step 9: Commit**

```powershell
git add src/note-parser.ts src/search-index.ts test/note-parser.test.ts test/search-index.test.ts esbuild.config.mjs package.json package-lock.json
git commit -m "feat: add rebuildable SQLite vault search index"
```

---

### Task 5: Add Full Scan, Reconciliation, and File Watching

**Files:**
- Create: `src/index-coordinator.ts`
- Create: `test/index-coordinator.test.ts`
- Modify: `src/search-index.ts`

**Interfaces:**
- Consumes: `VaultRegistry`, `parseNote`, and `SearchIndex`.
- Produces: `IndexCoordinator.initialize()`, `reconcile()`, `startWatching()`, `stopWatching()`, and `indexCreatedNote()`.

- [ ] **Step 1: Write failing coordinator tests**

```ts
// test/index-coordinator.test.ts
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VaultRegistry } from "../src/vault-registry.js";
import { SearchIndex } from "../src/search-index.js";
import { IndexCoordinator } from "../src/index-coordinator.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("IndexCoordinator", () => {
  it("makes a full scan and later removes stale records", async () => {
    const fx = await makeTempVaultSet(["personal", "work"]);
    await writeFile(path.join(fx.vaults[0].root, "한글.md"), "# 지식검색");
    const registry = await VaultRegistry.create(fx.vaults);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));
    const coordinator = new IndexCoordinator(registry, index);
    await coordinator.reconcile();
    expect(index.search("지식검색", registry.ids(), 10)).toHaveLength(1);
    await rm(path.join(fx.vaults[0].root, "한글.md"));
    await coordinator.reconcile();
    expect(index.search("지식검색", registry.ids(), 10)).toHaveLength(0);
    index.close(); await fx.cleanup();
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run test/index-coordinator.test.ts`

Expected: FAIL because `IndexCoordinator` is missing.

- [ ] **Step 3: Implement bounded reconciliation and watching**

```ts
// src/index-coordinator.ts
import { stat } from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { VaultRegistry } from "./vault-registry.js";
import type { SearchIndex } from "./search-index.js";
import { parseNote } from "./note-parser.js";

export class IndexCoordinator {
  private watcher?: FSWatcher;
  private reconcileTimer?: NodeJS.Timeout;
  constructor(private readonly registry: VaultRegistry, private readonly index: SearchIndex) {}

  async initialize(): Promise<void> { await this.reconcile(); this.startWatching(); }
  async reconcile(): Promise<void> {
    for (const [vaultId, vault] of this.registry.entries()) {
      const paths = new Set(await vault.listNotes());
      for (const relativePath of paths) await this.indexPath(vaultId, relativePath);
      this.index.removeMissing(vaultId, paths);
    }
  }
  startWatching(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.registry.entries().map(([, vault]) => vault.rootPath), {
      ignored: /(^|[\\/])\../,
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
    });
    const onUpsert = (absolutePath: string) => void this.handleAbsolute("upsert", absolutePath)
      .catch((error) => console.error("index watcher upsert failed", error));
    const onRemove = (absolutePath: string) => void this.handleAbsolute("remove", absolutePath)
      .catch((error) => console.error("index watcher remove failed", error));
    this.watcher.on("add", onUpsert).on("change", onUpsert).on("unlink", onRemove);
    this.reconcileTimer = setInterval(() => void this.reconcile()
      .catch((error) => console.error("scheduled reconcile failed", error)), 6 * 60 * 60 * 1000);
    this.reconcileTimer.unref();
  }
  async stopWatching(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    await this.watcher?.close();
    this.watcher = undefined;
  }
  async indexCreatedNote(vaultId: string, relativePath: string): Promise<void> { await this.indexPath(vaultId, relativePath); }
  private async handleAbsolute(action: "upsert" | "remove", absolutePath: string): Promise<void> {
    for (const [vaultId, vault] of this.registry.entries()) {
      const relative = path.relative(vault.rootPath, absolutePath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const normalized = relative.split(path.sep).join("/");
      if (!/\.(md|markdown)$/i.test(normalized)) return;
      if (action === "remove") this.index.remove(vaultId, normalized);
      else await this.indexPath(vaultId, normalized);
      return;
    }
  }
  private async indexPath(vaultId: string, relativePath: string): Promise<void> {
    const vault = this.registry.get(vaultId);
    if (!/\.(md|markdown)$/i.test(relativePath)) return;
    const content = await vault.readNote(relativePath);
    const fileStat = await stat(path.join(vault.rootPath, relativePath));
    const note = parseNote(vaultId, relativePath, content, fileStat);
    if (note.metadataError) console.warn("note metadata warning", { vaultId, relativePath, error: note.metadataError });
    this.index.upsert(note);
  }
}
```

- [ ] **Step 4: Add a watcher test using condition polling**

Append this test helper and case, which poll every 50 ms for at most five seconds and always close the watcher:

```ts
async function eventually(assertion: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { assertion(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

it("indexes a note created after the watcher starts", async () => {
  const fx = await makeTempVaultSet(["work"]);
  const registry = await VaultRegistry.create(fx.vaults);
  const index = new SearchIndex(path.join(fx.root, "index.sqlite"));
  const coordinator = new IndexCoordinator(registry, index);
  try {
    await coordinator.initialize();
    await writeFile(path.join(fx.vaults[0].root, "new.md"), "# watcher-term");
    await eventually(() => expect(index.search("watcher-term", ["work"], 10)).toHaveLength(1));
  } finally {
    await coordinator.stopWatching();
    index.close();
    await fx.cleanup();
  }
});
```

- [ ] **Step 5: Add corrupt-index startup recovery**

Wrap constructor initialization so it closes the native handle before rethrowing, then add this factory. Import `existsSync` and `renameSync` from `node:fs`:

```ts
static openWithRecovery(file: string): SearchIndex {
  try {
    return new SearchIndex(file);
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${file}${suffix}`;
      if (existsSync(source)) renameSync(source, `${file}.corrupt-${stamp}${suffix}`);
    }
    console.error("quarantined corrupt search index", { file, error });
    return new SearchIndex(file);
  }
}
```

The constructor must put every pragma and schema statement in a `try` block and call `this.db.close()` in its `catch` before rethrowing. Add this recovery test:

```ts
it("quarantines an unreadable database and opens a fresh index", async () => {
  const fx = await makeTempVaultSet(["personal"]);
  const dbFile = path.join(fx.root, "index.sqlite");
  await writeFile(dbFile, Buffer.from("not-a-sqlite-database"));
  const index = SearchIndex.openWithRecovery(dbFile);
  index.upsert(parseNote("personal", "ok.md", "# recovered", { mtimeMs: 1, size: 11 }));
  expect(index.search("recovered", ["personal"], 10)).toHaveLength(1);
  index.close();
  expect((await readdir(fx.root)).some((name) => name.startsWith("index.sqlite.corrupt-"))).toBe(true);
  await fx.cleanup();
});
```

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run test/search-index.test.ts test/index-coordinator.test.ts && npm run typecheck`

Expected: PASS with no open-handle warning.

- [ ] **Step 7: Commit**

```powershell
git add src/index-coordinator.ts src/search-index.ts test/index-coordinator.test.ts test/search-index.test.ts
git commit -m "feat: keep the vault index synchronized"
```

---

### Task 6: Add the Knowledge Service and Safe MCP Tools

**Files:**
- Create: `src/knowledge-base.ts`
- Create: `src/knowledge-tools.ts`
- Create: `test/knowledge-base.test.ts`
- Create: `test/knowledge-tools.test.ts`
- Modify: `src/server-factory.ts`

**Interfaces:**
- Consumes: `VaultRegistry`, `SearchIndex`, `IndexCoordinator`, and `AuditLogger`.
- Produces: `KnowledgeBase` methods matching the six public MCP tools and `createKnowledgeMcpServer(knowledgeBase)`.

- [ ] **Step 1: Write failing cross-vault service tests**

```ts
// test/knowledge-base.test.ts
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKnowledgeFixture } from "./helpers/knowledge-fixture.js";

describe("KnowledgeBase", () => {
  it("searches every vault or one selected vault", async () => {
    const fx = await createKnowledgeFixture(["personal", "work"]);
    await writeFile(path.join(fx.rootOf("personal"), "p.md"), "# 공통검색 개인");
    await writeFile(path.join(fx.rootOf("work"), "w.md"), "# 공통검색 업무");
    await fx.knowledge.initialize();
    expect((await fx.knowledge.searchNotes({ query: "공통검색" })).hits).toHaveLength(2);
    expect((await fx.knowledge.searchNotes({ query: "공통검색", vaults: ["work"] })).hits[0].vault).toBe("work");
    await fx.cleanup();
  });

  it("creates only an inbox note and indexes it immediately", async () => {
    const fx = await createKnowledgeFixture(["personal"]);
    await fx.knowledge.initialize();
    const created = await fx.knowledge.createInboxNote({ vault: "personal", title: "에이전트 기록", content: "즉시검색" });
    expect(created.path).toMatch(/^Agent-Inbox\//);
    expect((await fx.knowledge.searchNotes({ query: "즉시검색" })).hits).toHaveLength(1);
    await fx.cleanup();
  });
});
```

Create the fixture with explicit ownership of every closeable resource:

```ts
// test/helpers/knowledge-fixture.ts
import path from "node:path";
import { AuditLogger } from "../../src/audit.js";
import { IndexCoordinator } from "../../src/index-coordinator.js";
import { KnowledgeBase } from "../../src/knowledge-base.js";
import { SearchIndex } from "../../src/search-index.js";
import { VaultRegistry } from "../../src/vault-registry.js";
import { makeTempVaultSet } from "./temp-vaults.js";

export async function createKnowledgeFixture(ids: string[]) {
  const vaultSet = await makeTempVaultSet(ids);
  const registry = await VaultRegistry.create(vaultSet.vaults);
  const index = new SearchIndex(path.join(vaultSet.root, "index.sqlite"));
  const coordinator = new IndexCoordinator(registry, index);
  const audit = new AuditLogger(path.join(vaultSet.root, "audit.jsonl"));
  const knowledge = new KnowledgeBase(registry, index, coordinator, audit);
  return {
    knowledge,
    rootOf(id: string) {
      const found = vaultSet.vaults.find((vault) => vault.id === id);
      if (!found) throw new Error(`Unknown test vault: ${id}`);
      return found.root;
    },
    async cleanup() {
      await knowledge.close();
      await vaultSet.cleanup();
    },
  };
}
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/knowledge-base.test.ts`

Expected: FAIL because `KnowledgeBase` and the fixture are missing.

- [ ] **Step 3: Implement `KnowledgeBase` as the only public filesystem facade**

```ts
// src/knowledge-base.ts
export class KnowledgeBase {
  constructor(
    private readonly registry: VaultRegistry,
    private readonly index: SearchIndex,
    private readonly coordinator: IndexCoordinator,
    private readonly audit: AuditLogger,
  ) {}
  async initialize(): Promise<void> { await this.coordinator.initialize(); }
  listVaults() { return { vaults: this.registry.ids() }; }
  async listNotes(input: { vault: string; folder?: string; limit?: number; cursor?: number }) {
    const vault = this.registry.get(input.vault);
    const all = await vault.listNotes(input.folder ?? "");
    const cursor = Math.max(0, input.cursor ?? 0);
    const limit = Math.max(1, Math.min(200, input.limit ?? 100));
    const notes = all.slice(cursor, cursor + limit);
    const nextCursor = cursor + notes.length < all.length ? cursor + notes.length : undefined;
    return { vault: input.vault, notes, nextCursor };
  }
  async readNote(input: { vault: string; path: string }) {
    const content = await this.registry.get(input.vault).readNote(input.path);
    if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) throw new Error("Note exceeds read limit");
    return { vault: input.vault, path: input.path, content };
  }
  async searchNotes(input: { query: string; vaults?: string[]; limit?: number }) {
    const vaults = input.vaults?.length ? [...new Set(input.vaults)] : this.registry.ids();
    for (const id of vaults) this.registry.get(id);
    const hits = this.index.search(input.query, vaults, input.limit ?? 50)
      .map(({ vaultId, ...hit }) => ({ vault: vaultId, ...hit }));
    return { query: input.query, hits };
  }
  getNoteLinks(input: { vault: string; path: string }) {
    this.registry.get(input.vault);
    return {
      vault: input.vault,
      path: input.path,
      outgoing: this.index.outgoingLinks(input.vault, input.path),
      backlinks: this.index.backlinks(input.vault, input.path),
    };
  }
  async createInboxNote(input: { vault: string; title: string; content: string; frontmatter?: Record<string, unknown> }) {
    try {
      const created = await this.registry.get(input.vault).createInboxNote(input);
      await this.coordinator.indexCreatedNote(input.vault, created.path);
      await this.audit.record({ action: "create_inbox_note", outcome: "allowed", vault: input.vault, path: created.path });
      return { vault: input.vault, path: created.path };
    } catch (error) {
      await this.audit.record({ action: "create_inbox_note", outcome: "denied", vault: input.vault, reason: error instanceof Error ? error.message : "unknown" });
      throw error;
    }
  }
  async close(): Promise<void> { await this.coordinator.stopWatching(); this.index.close(); }
}
```

Clamp note-list pages to 200 items, read responses to 2 MiB, and search results to 200. Return plain objects so MCP handlers can serialize them consistently.

- [ ] **Step 4: Write failing MCP registration tests**

Assert the public server lists exactly:

```ts
expect(toolNames).toEqual([
  "create_inbox_note",
  "get_note_links",
  "list_notes",
  "list_vaults",
  "read_note",
  "search_notes",
]);
```

Use `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/sdk/inMemory.js`, connect a real `Client`, call `listTools`, and verify there is no `write_note`, `edit_note`, or `delete_note`.

- [ ] **Step 5: Implement `registerKnowledgeTools`**

Each handler validates with Zod and returns one JSON text content block:

```ts
const json = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

server.registerTool("search_notes", {
  title: "Search notes",
  description: "Search one or all authorized Obsidian vaults.",
  inputSchema: {
    query: z.string().min(1).max(500),
    vaults: z.array(z.string()).max(64).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
}, wrap(async (input) => json(await knowledge.searchNotes(input))));
```

Register all six tools explicitly; the write schema deliberately has no path field:

```ts
const vaultId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const notePath = z.string().min(1).max(1024);
const frontmatterValue = z.union([
  z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(1_000)).max(100),
]);
const frontmatter = z.record(z.string().min(1).max(100), frontmatterValue)
  .refine((value) => Object.keys(value).length <= 50, "At most 50 frontmatter fields are allowed");

server.registerTool("list_vaults", {
  title: "List vaults", description: "List authorized Obsidian vaults.", inputSchema: {},
}, async () => json(knowledge.listVaults()));
server.registerTool("list_notes", {
  title: "List notes", description: "List Markdown notes in one vault.",
  inputSchema: {
    vault: vaultId, folder: z.string().max(1024).optional(),
    limit: z.number().int().min(1).max(200).optional(), cursor: z.number().int().min(0).optional(),
  },
}, async (input) => json(await knowledge.listNotes(input)));
server.registerTool("read_note", {
  title: "Read note", description: "Read one Markdown note.",
  inputSchema: { vault: vaultId, path: notePath },
}, async (input) => json(await knowledge.readNote(input)));
server.registerTool("search_notes", {
  title: "Search notes", description: "Search one or all authorized Obsidian vaults.",
  inputSchema: {
    query: z.string().min(1).max(500), vaults: z.array(vaultId).max(64).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
}, async (input) => json(await knowledge.searchNotes(input)));
server.registerTool("get_note_links", {
  title: "Get note links", description: "Return outgoing links and backlinks.",
  inputSchema: { vault: vaultId, path: notePath },
}, async (input) => json(knowledge.getNoteLinks(input)));
server.registerTool("create_inbox_note", {
  title: "Create inbox note", description: "Create a new note only in Agent-Inbox.",
  inputSchema: {
    vault: vaultId, title: z.string().min(1).max(200), content: z.string().max(1_048_576),
    frontmatter: frontmatter.optional(),
  },
}, async (input) => json(await knowledge.createInboxNote(input)));
```

- [ ] **Step 6: Preserve the legacy factory and add the knowledge factory**

```ts
// src/server-factory.ts
export function createMcpServer(vault: VaultFS): McpServer {
  const server = new McpServer({ name: "obsidian-multivault", version: "1.0.0" });
  registerTools(server, vault);
  return server;
}

export function createKnowledgeMcpServer(knowledge: KnowledgeBase): McpServer {
  const server = new McpServer({ name: "obsidian-brain", version: "1.0.0" });
  registerKnowledgeTools(server, knowledge);
  return server;
}
```

- [ ] **Step 7: Run service, tool, and legacy tests**

Run: `npx vitest run test/knowledge-base.test.ts test/knowledge-tools.test.ts && npm run typecheck && npm run build && npm run smoke`

Expected: six public tools in the new server; nine legacy tools in the stdio smoke; all pass.

- [ ] **Step 8: Commit**

```powershell
git add src/knowledge-base.ts src/knowledge-tools.ts src/server-factory.ts test/helpers/knowledge-fixture.ts test/knowledge-base.test.ts test/knowledge-tools.test.ts
git commit -m "feat: expose safe multi-vault knowledge tools"
```

---

### Task 7: Route the Authenticated HTTP Owner to the Knowledge Base

**Files:**
- Modify: `src/index.ts`
- Modify: `src/http.ts`
- Create: `test/helpers/oauth-flow.ts`
- Create: `test/http.test.ts`
- Modify: `scripts/smoke-http.mjs`
- Modify: `users.example.json`

**Interfaces:**
- Consumes: `MCP_CONFIG_FILE`, `loadKnowledgeConfig`, and `createKnowledgeMcpServer`.
- Produces: one authenticated owner whose token can access all configured vaults through `/mcp`.

- [ ] **Step 1: Write a failing authenticated HTTP integration test**

Create two temporary vaults and a config file, launch the built server with:

```ts
{
  MCP_CONFIG_FILE: configPath,
  MCP_JWT_SECRET: "test-secret-test-secret-test-secret",
  MCP_PUBLIC_URL: `http://127.0.0.1:${port}`,
  MCP_CLIENTS_FILE: clientsPath,
}
```

Extract the upstream `oauthToken` flow from `scripts/smoke-http.mjs` into `test/helpers/oauth-flow.ts` with this typed surface, then import the same helper back into the smoke script so there is only one OAuth implementation:

```ts
export interface OAuthTokens { accessToken: string; refreshToken: string; clientId: string }
export async function oauthToken(baseUrl: string, passphrase: string): Promise<OAuthTokens>;
export async function connectMcp(baseUrl: string, accessToken: string): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}>;
```

The helper performs, in order, the existing dynamic client registration POST, SHA-256 PKCE challenge, `/authorize` redirect, `/login` passphrase POST, `/token` code exchange, and authenticated `StreamableHTTPClientTransport` connection. Preserve every upstream status assertion. The test calls `list_vaults` with that client and expects both `personal` and `work`; a literal forged bearer token must return 401, and a session ID replayed with a second valid token must return 403.

- [ ] **Step 2: Run and verify failure**

Run: `npm run build && npx vitest run test/http.test.ts`

Expected: FAIL because HTTP startup still expects one `VaultFS` per user.

- [ ] **Step 3: Change the HTTP user context**

```ts
// src/http.ts
export interface HttpUser {
  id: string;
  passphrase: string;
  knowledge: KnowledgeBase;
}
```

Replace `vaults` with a map of user ID to `KnowledgeBase`, replace `defaultVault` with `defaultKnowledge`, and call `createKnowledgeMcpServer(knowledge)` for each new Streamable HTTP session. Keep OAuth, DCR, PKCE, JWT verification, CORS, bearer middleware, and session ownership logic unchanged.

Add `express.json({ limit: "1mb" })` on `/mcp`, a global request timeout compatible with streaming, and an IP-based login limiter that returns 429 after ten failed login submissions in fifteen minutes. Do not rate-limit successful SSE traffic.

- [ ] **Step 4: Load and initialize the knowledge configuration in HTTP mode**

Add to `src/index.ts`:

```ts
async function buildKnowledgeHttpUser(): Promise<HttpUser> {
  const configFile = process.env.MCP_CONFIG_FILE;
  if (!configFile) throw new Error("HTTP knowledge mode requires MCP_CONFIG_FILE");
  const loaded = await loadKnowledgeConfig(configFile);
  await mkdir(loaded.dataDir, { recursive: true, mode: 0o700 });
  const index = SearchIndex.openWithRecovery(path.join(loaded.dataDir, "index.sqlite"));
  const coordinator = new IndexCoordinator(loaded.registry, index);
  const audit = new AuditLogger(path.join(loaded.dataDir, "audit.jsonl"));
  const knowledge = new KnowledgeBase(loaded.registry, index, coordinator, audit);
  await knowledge.initialize();
  return { id: loaded.owner.id, passphrase: loaded.owner.passphrase, knowledge };
}
```

In `main`, prefer `MCP_CONFIG_FILE` for HTTP knowledge mode. Retain the old `MCP_USERS_FILE` branch only as a documented legacy mode using the existing `VaultFS` path, or fail with a clear migration message if mixing both variables. Keep the stdio branch byte-for-byte behaviorally equivalent.

Register `SIGTERM` and `SIGINT` handlers that stop watchers, close SQLite, and then exit after the HTTP server closes.

- [ ] **Step 5: Update the full HTTP smoke script**

Replace the old nine-tool public assertion with the six-tool safe assertion. Seed `personal/alpha.md` and `work/bravo.md`, then prove:

```js
assert(vaultList.includes("personal") && vaultList.includes("work"), "owner sees every configured vault");
assert(searchText.includes("alpha.md") && searchText.includes("bravo.md"), "cross-vault search returns both vaults");
assert(!toolNames.includes("delete_note") && !toolNames.includes("edit_note"), "dangerous public tools are absent");
```

Keep the unauthenticated 401, discovery document, DCR, bad passphrase, valid login, refresh token, bad token, and PKCE mismatch checks.

- [ ] **Step 6: Run HTTP and regression verification**

Run: `npx vitest run test/http.test.ts && npm run typecheck && npm run build && npm run smoke:http && npm run smoke`

Expected: all tests pass; public HTTP exposes six tools and legacy stdio still exposes nine.

- [ ] **Step 7: Commit**

```powershell
git add src/index.ts src/http.ts test/http.test.ts scripts/smoke-http.mjs users.example.json
git commit -m "feat: route one OAuth owner to every vault"
```

---

### Task 8: Add Hardened, Repeatable Ubuntu Deployment Assets

**Files:**
- Create: `deploy/brain-mcp.service`
- Create: `deploy/Caddyfile`
- Create: `deploy/install.sh`
- Create: `deploy/backup.sh`
- Create: `deploy/brain-mcp-backup.service`
- Create: `deploy/brain-mcp-backup.timer`
- Create: `deploy/README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: built `dist/index.js`, production `node_modules`, and `MCP_CONFIG_FILE`.
- Produces: services `brain-mcp.service` and `caddy.service`, data in `/srv/brain`, application in `/opt/brain-mcp`, and local health at `127.0.0.1:8787/healthz`.

- [ ] **Step 1: Write a shell syntax verification command before the scripts**

Run after creating each script: `bash -n deploy/install.sh deploy/backup.sh`

Expected before file creation: FAIL with file-not-found.

- [ ] **Step 2: Create the hardened systemd unit**

```ini
# deploy/brain-mcp.service
[Unit]
Description=Multi-Vault Obsidian Brain MCP
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=brain
Group=brain
WorkingDirectory=/opt/brain-mcp
EnvironmentFile=/etc/brain-mcp.env
ExecStart=/usr/bin/node /opt/brain-mcp/dist/index.js --http --host 127.0.0.1 --port 8787
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/srv/brain /opt/brain-mcp/oauth-clients.json
MemoryMax=768M
TasksMax=128

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Create the streaming-safe Caddy configuration**

```caddy
# deploy/Caddyfile; install.sh replaces __PUBLIC_HOST__ exactly once.
__PUBLIC_HOST__ {
    encode zstd gzip
    request_body { max_size 2MB }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
    }
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
        transport http { read_timeout 0 }
    }
}
```

- [ ] **Step 4: Implement the idempotent installer**

Create `deploy/install.sh` with this complete flow. The hostname validation makes the later `sed` substitution safe; existing secrets are retained on reinstall:

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
: "${PUBLIC_HOST:?PUBLIC_HOST is required}"
: "${RELEASE_DIR:?RELEASE_DIR is required}"
[[ "$PUBLIC_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "invalid PUBLIC_HOST" >&2; exit 1; }
[[ -f "$RELEASE_DIR/dist/index.js" && -f "$RELEASE_DIR/package-lock.json" ]] || {
  echo "invalid release directory" >&2; exit 1;
}

apt-get update
apt-get install -y ca-certificates curl gnupg jq openssl build-essential python3 ripgrep
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
  >/etc/apt/sources.list.d/nodesource.list
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  >/etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y nodejs caddy

if [[ -z $(swapon --show --noheadings) ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || printf '%s\n' '/swapfile none swap sw 0 0' >>/etc/fstab
fi

id brain >/dev/null 2>&1 || useradd --system --home-dir /srv/brain --shell /usr/sbin/nologin brain
install -d -o root -g root -m 0755 /opt/brain-mcp
cp -a "$RELEASE_DIR/." /opt/brain-mcp/
cd /opt/brain-mcp
npm ci --omit=dev
if [[ ! -f /opt/brain-mcp/oauth-clients.json ]]; then
  install -o brain -g brain -m 0600 /dev/null /opt/brain-mcp/oauth-clients.json
else
  chown brain:brain /opt/brain-mcp/oauth-clients.json
  chmod 600 /opt/brain-mcp/oauth-clients.json
fi
install -d -o brain -g brain -m 0700 /srv/brain/data /srv/brain/backups
for vault_id in personal work research; do
  install -d -o brain -g brain -m 0700 "/srv/brain/vaults/$vault_id/Agent-Inbox"
done

if [[ -f /etc/brain-mcp.env ]]; then
  jwt_secret=$(sed -n 's/^MCP_JWT_SECRET=//p' /etc/brain-mcp.env)
else
  jwt_secret=$(openssl rand -hex 32)
fi
if [[ -f /root/brain-mcp-owner-passphrase.txt ]]; then
  owner_passphrase=$(tr -d '\r\n' </root/brain-mcp-owner-passphrase.txt)
else
  owner_passphrase=$(openssl rand -base64 36 | tr -d '\r\n')
  printf '%s\n' "$owner_passphrase" >/root/brain-mcp-owner-passphrase.txt
  chmod 600 /root/brain-mcp-owner-passphrase.txt
fi
[[ ${#jwt_secret} -eq 64 && ${#owner_passphrase} -ge 32 ]] || { echo "invalid retained secret" >&2; exit 1; }

{
  printf 'MCP_PUBLIC_URL=https://%s\n' "$PUBLIC_HOST"
  printf 'MCP_JWT_SECRET=%s\n' "$jwt_secret"
  printf '%s\n' 'MCP_CLIENTS_FILE=/opt/brain-mcp/oauth-clients.json'
  printf '%s\n' 'MCP_CONFIG_FILE=/etc/brain-mcp-config.json' 'NODE_ENV=production'
} >/etc/brain-mcp.env
chmod 600 /etc/brain-mcp.env

jq -n --arg passphrase "$owner_passphrase" '{
  dataDir: "/srv/brain/data",
  owner: {id:"owner", passphrase:$passphrase, allowedVaults:["personal","work","research"]},
  vaults:[
    {id:"personal",root:"/srv/brain/vaults/personal"},
    {id:"work",root:"/srv/brain/vaults/work"},
    {id:"research",root:"/srv/brain/vaults/research"}
  ]
}' >/etc/brain-mcp-config.json
chown brain:brain /etc/brain-mcp-config.json
chmod 600 /etc/brain-mcp-config.json

install -o root -g root -m 0644 deploy/brain-mcp.service /etc/systemd/system/brain-mcp.service
sed "s/__PUBLIC_HOST__/$PUBLIC_HOST/g" deploy/Caddyfile >/etc/caddy/Caddyfile
chown root:caddy /etc/caddy/Caddyfile
chmod 640 /etc/caddy/Caddyfile
install -o root -g root -m 0755 deploy/backup.sh /usr/local/sbin/brain-mcp-backup
install -o root -g root -m 0644 deploy/brain-mcp-backup.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/brain-mcp-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now brain-mcp caddy brain-mcp-backup.timer
printf '%s\n' 'Owner passphrase is stored at /root/brain-mcp-owner-passphrase.txt'
```

- [ ] **Step 5: Implement nightly local snapshots with retention**

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive_root=/srv/brain/backups
dest="$archive_root/$stamp"
[[ "$dest" == /srv/brain/backups/* ]] || { echo "unsafe backup destination" >&2; exit 1; }
mkdir -p "$dest"
tar --xattrs --acls -C /srv/brain -czf "$dest/vaults.tgz" vaults
install -m 600 /etc/brain-mcp-config.json "$dest/config.json"
mapfile -d '' expired < <(find "$archive_root" -mindepth 1 -maxdepth 1 -type d -mtime +13 -print0)
for old in "${expired[@]}"; do
  [[ "$old" == /srv/brain/backups/* ]] || { echo "unsafe retention target" >&2; exit 1; }
  rm -rf -- "$old"
done
```

Add the exact one-shot unit and timer used by the installer:

```ini
# deploy/brain-mcp-backup.service
[Unit]
Description=Back up Obsidian Brain vaults

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/brain-mcp-backup
```

```ini
# deploy/brain-mcp-backup.timer
[Unit]
Description=Nightly Obsidian Brain backup

[Timer]
OnCalendar=*-*-* 03:15:00 UTC
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
```

The Oracle boot-volume backup policy is configured separately in the console so backups survive VM loss.

- [ ] **Step 6: Document exact verification and recovery commands**

`deploy/README.md` must include:

```bash
systemctl is-active brain-mcp caddy
curl -fsS http://127.0.0.1:8787/healthz
curl -i "https://${PUBLIC_HOST}/healthz"
curl -i -X POST "https://${PUBLIC_HOST}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Expected: both services active, local/public health 200, unauthenticated MCP 401 with `WWW-Authenticate`.

- [ ] **Step 7: Run deployment static checks**

Run:

```bash
bash -n deploy/install.sh deploy/backup.sh
grep -R "sk-\|MCP_JWT_SECRET=.*[a-f0-9]\{64\}" deploy src test && exit 1 || true
```

Expected: shell syntax passes; secret scan finds no committed secret.

- [ ] **Step 8: Commit**

```powershell
git add deploy .gitignore
git commit -m "ops: add hardened Ubuntu deployment assets"
```

---

### Task 9: Run the Complete Local Verification Gate

**Files:**
- Modify only if a verification failure exposes a defect: the smallest relevant source or test file.

**Interfaces:**
- Consumes: all application tasks.
- Produces: a release candidate proven locally before any cloud mutation.

- [ ] **Step 1: Install exactly from the lockfile**

Run:

```powershell
npm ci
```

Expected: exit 0 with no lockfile change.

- [ ] **Step 2: Run every automated gate**

Run:

```powershell
npm test
npm run typecheck
npm run build
npm run smoke
npm run smoke:http
```

Expected: all commands exit 0; both smoke scripts end with `OK`.

- [ ] **Step 3: Run focused security regressions**

Run:

```powershell
npx vitest run test/vault-inbox.test.ts test/config.test.ts test/http.test.ts
```

Expected: traversal, symlink, oversized write, bad token, wrong session owner, and dangerous-tool absence assertions pass.

- [ ] **Step 4: Inspect the release contents and secret scan**

Run:

```powershell
Get-Item dist\index.js | Select-Object Name,Length
rg -n "DASHSCOPE|sk-[A-Za-z0-9]|OCI_TENANCY_OCID|OCI_USER_OCID" . -g '!node_modules/**' -g '!docs/**'
git status --short
```

Expected: `dist/index.js` exists; the secret scan returns no result; Git is clean.

- [ ] **Step 5: Commit any minimal verification fix, otherwise record the clean commit**

Run: `git log -1 --oneline`

Expected: the deployment-assets commit is HEAD and the worktree is clean.

---

### Task 10: Create the Oracle Always Free Ubuntu VM

**Files:**
- Create locally outside Git: `work/keys/brain-mcp-oracle.key` and matching `.pub`.
- Record outside Git: VM OCID, public IP, and `sslip.io` hostname.

**Interfaces:**
- Consumes: the existing logged-in `clickaround8` OCI tenancy in `ap-chuncheon-1`.
- Produces: a running Ubuntu VM reachable by SSH and public ports 80/443 with an Always Free-eligible estimate.

- [ ] **Step 1: Correct the currently open image selection**

In the OCI Create Compute Instance panel select `Canonical Ubuntu 24.04` for x86, not an `aarch64` image. Confirm the selected shape becomes `VM.Standard.E2.1.Micro` and shows `Always Free-eligible`.

- [ ] **Step 2: Set the instance identity and networking**

Use:

```text
Name: brain-mcp
Compartment: clickaround8 (root)
Availability domain: AD 1
VCN: create a new VCN if none exists
Subnet: public subnet
Public IPv4 address: assigned
```

- [ ] **Step 3: Generate and secure a fresh SSH key pair**

Generate an ED25519 key locally:

```powershell
New-Item -ItemType Directory -Force work\keys | Out-Null
ssh-keygen -t ed25519 -a 64 -f work\keys\brain-mcp-oracle.key -N "" -C brain-mcp
```

Paste only `work/keys/brain-mcp-oracle.key.pub` into OCI's authorized-keys field. Never upload or paste the private key.

- [ ] **Step 4: Review the estimate before creating**

Open `View estimated cost`. Required signals:

```text
Shape: VM.Standard.E2.1.Micro
Always Free-eligible: displayed
Estimated compute charge: 0 within Always Free limits
No paid marketplace image
```

If any paid amount or non-Free shape appears, stop without pressing Create and return to the image/shape section.

- [ ] **Step 5: Create the instance and wait for Running**

Press `Create`, wait for lifecycle state `Running`, then copy the assigned public IPv4 address into this local prompt. The commands validate it, derive the TLS hostname, and save only public deployment facts outside Git:

```powershell
$vmIp = Read-Host 'Paste the public IPv4 shown in OCI'
if ($vmIp -notmatch '^(?:\d{1,3}\.){3}\d{1,3}$') { throw 'Invalid IPv4 address' }
$publicHost = ($vmIp -replace '\.', '-') + '.sslip.io'
@{ vmIp = $vmIp; publicHost = $publicHost } |
  ConvertTo-Json | Set-Content -Encoding utf8 work\oracle-deployment-target.json
```

Example transformation: `203.0.113.10` becomes `203-0-113-10.sslip.io`.

- [ ] **Step 6: Open only required OCI ingress rules**

In the VCN security list or NSG add stateless=false TCP ingress rules:

```text
22/tcp: source restricted to the current administrator IP when practical
80/tcp: source 0.0.0.0/0
443/tcp: source 0.0.0.0/0
```

Do not open port 8787.

- [ ] **Step 7: Confirm SSH host identity on first connection**

Run:

```powershell
$target = Get-Content -Raw work\oracle-deployment-target.json | ConvertFrom-Json
ssh -i work\keys\brain-mcp-oracle.key "ubuntu@$($target.vmIp)" 'uname -a && cat /etc/os-release'
```

Expected: Ubuntu 24.04 on x86_64. Record the host fingerprint when prompted; if the IP later changes, compare before replacing it.

---

### Task 11: Deploy, Back Up, and Verify the Public MCP Server

**Files:**
- Create locally outside Git: `work/release/brain-mcp-release.tgz`.
- Create on VM: `/opt/brain-mcp`, `/srv/brain`, `/etc/brain-mcp.env`, `/etc/brain-mcp-config.json`, Caddy/systemd files.

**Interfaces:**
- Consumes: verified release candidate, Oracle VM, SSH key, and public hostname.
- Produces: the final `https://$publicHost/mcp` endpoint and tested sample vault database.

- [ ] **Step 1: Build a release archive containing runtime files and deployment assets**

Run locally:

```powershell
npm run build
New-Item -ItemType Directory -Force work\release\package | Out-Null
Copy-Item package.json,package-lock.json -Destination work\release\package
Copy-Item -Recurse dist,deploy -Destination work\release\package
tar -czf work\release\brain-mcp-release.tgz -C work\release\package .
```

Expected: archive contains `dist/index.js`, `package.json`, lockfile, and `deploy/` but no vault, secret, key, or development `node_modules`.

- [ ] **Step 2: Upload and install**

Run locally:

```powershell
$target = Get-Content -Raw work\oracle-deployment-target.json | ConvertFrom-Json
scp -i work\keys\brain-mcp-oracle.key work\release\brain-mcp-release.tgz "ubuntu@$($target.vmIp):/tmp/"
ssh -t -i work\keys\brain-mcp-oracle.key "ubuntu@$($target.vmIp)" "mkdir -p /tmp/brain-release && tar -xzf /tmp/brain-mcp-release.tgz -C /tmp/brain-release && sudo PUBLIC_HOST=$($target.publicHost) RELEASE_DIR=/tmp/brain-release bash /tmp/brain-release/deploy/install.sh"
```

Expected: installer exits 0 and reports that the login passphrase is stored at `/root/brain-mcp-owner-passphrase.txt` without printing it.

- [ ] **Step 3: Add deterministic sample notes for two vaults**

Run through SSH:

```bash
sudo -u brain tee /srv/brain/vaults/personal/Welcome.md >/dev/null <<'EOF'
---
tags: [개인, 테스트]
---
# 개인 지식
공통검색어 개인 기록 [[Shared]]
EOF
sudo -u brain tee /srv/brain/vaults/work/Decisions.md >/dev/null <<'EOF'
---
tags: [업무, 테스트]
---
# 업무 결정
공통검색어 업무 기록 [[Shared]]
EOF
sudo systemctl restart brain-mcp
```

- [ ] **Step 4: Verify services, TLS, and OAuth gate**

Run the private checks over SSH and the public checks locally:

```powershell
$target = Get-Content -Raw work\oracle-deployment-target.json | ConvertFrom-Json
ssh -i work\keys\brain-mcp-oracle.key "ubuntu@$($target.vmIp)" 'systemctl is-active brain-mcp caddy && curl -fsS http://127.0.0.1:8787/healthz'
curl.exe -fsS "https://$($target.publicHost)/healthz"
curl.exe -i -X POST "https://$($target.publicHost)/mcp" `
  -H 'Content-Type: application/json' `
  -H 'Accept: application/json, text/event-stream' `
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Expected: services `active`, both health calls return `ok`, and unauthenticated MCP returns 401 with OAuth resource metadata.

- [ ] **Step 5: Run an authenticated public MCP smoke**

Read the owner passphrase only in an interactive SSH session:

```bash
sudo cat /root/brain-mcp-owner-passphrase.txt
```

Use it in the browser OAuth page without placing it in chat, a command history, or a source file. Connect a real MCP client and assert:

```text
list_vaults -> personal, research, work
search_notes(query="공통검색어") -> personal/Welcome.md and work/Decisions.md
search_notes(query="업무", vaults=["work"]) -> work result only
read_note(vault="personal", path="Welcome.md") -> expected Markdown
get_note_links(vault="personal", path="Welcome.md") -> outgoing Shared
create_inbox_note(vault="personal", title="에이전트 테스트", content="작성검색어") -> Agent-Inbox path
search_notes(query="작성검색어") -> newly created inbox note
edit_note/delete_note/write_note -> absent from listTools
```

- [ ] **Step 6: Verify restart recovery and index rebuild**

Run remotely:

```bash
sudo systemctl restart brain-mcp
sudo systemctl is-active brain-mcp
sudo systemctl stop brain-mcp
sudo mv /srv/brain/data/index.sqlite /srv/brain/data/index.sqlite.manual-test
sudo test ! -e /srv/brain/data/index.sqlite-wal || sudo mv /srv/brain/data/index.sqlite-wal /srv/brain/data/index.sqlite-wal.manual-test
sudo test ! -e /srv/brain/data/index.sqlite-shm || sudo mv /srv/brain/data/index.sqlite-shm /srv/brain/data/index.sqlite-shm.manual-test
sudo systemctl start brain-mcp
curl -fsS http://127.0.0.1:8787/healthz
```

Repeat the `공통검색어` query. Expected: both notes still return after SQLite is rebuilt from Markdown. Restore or remove only the manually renamed test database after verification.

- [ ] **Step 7: Verify backup and Oracle volume policy**

Run remotely:

```bash
sudo /usr/local/sbin/brain-mcp-backup
sudo find /srv/brain/backups -maxdepth 2 -type f -ls
sudo tar -tzf "$(sudo find /srv/brain/backups -name vaults.tgz | sort | tail -1)"
```

Expected: archive lists the sample vault notes and config copy. In OCI, attach the Free Tier-compatible boot-volume backup policy and confirm the next scheduled backup time before leaving the page.

- [ ] **Step 8: Connect Codex and ChatGPT without repository-local configuration**

For Codex, render the exact global configuration snippet from the recorded public hostname:

```powershell
$target = Get-Content -Raw work\oracle-deployment-target.json | ConvertFrom-Json
@"
[mcp_servers.brain]
url = "https://$($target.publicHost)/mcp"
"@
```

Complete the OAuth browser login with the owner passphrase. For ChatGPT web/mobile, add the same HTTPS MCP URL as a remote connector and complete the same OAuth flow. Verify a search from each client returns both sample vaults.

- [ ] **Step 9: Run the final security and availability check**

Confirm:

```text
Node listens only on 127.0.0.1:8787
Public 80/443 reachable; public 8787 unreachable
Secrets/config mode 600
Private SSH key absent from Git and the VM
DashScope key absent from code, config, logs, and command history
brain-mcp and Caddy active after a VM reboot
```

- [ ] **Step 10: Record deployment facts without secrets and commit documentation updates**

Write only the public hostname, region, VM shape, deployed commit hash, and verification timestamp to `deploy/DEPLOYED.md`. Do not record OCIDs, email addresses, passphrases, JWTs, API keys, private IPs, or SSH private-key paths.

```bash
git add deploy/DEPLOYED.md
git commit -m "docs: record verified Oracle deployment"
```
