import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parseNote } from "../src/note-parser.js";
import { SearchIndex } from "../src/search-index.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("SearchIndex change journal", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("records one baseline upsert and suppresses an unchanged duplicate", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    cleanups.push(fx.cleanup);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));
    const note = parseNote("brain", "A.md", "# A", { mtimeMs: 1, size: 3 });

    index.upsert(note);
    index.upsert(note);

    expect(index.listChanges({ allowedVaults: ["brain"], after: 0, limit: 20 }).changes)
      .toEqual([{
        seq: 1,
        vault: "brain",
        path: "A.md",
        operation: "upsert",
        contentHash: note.contentHash,
        mtimeMs: 1,
        size: 3,
      }]);
    index.close();
  });

  it("records a changed hash and a delete in sequence order", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    cleanups.push(fx.cleanup);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));

    index.upsert(parseNote("brain", "A.md", "# A", { mtimeMs: 1, size: 3 }));
    index.upsert(parseNote("brain", "A.md", "# A changed", { mtimeMs: 2, size: 11 }));
    index.remove("brain", "A.md");

    expect(index.listChanges({ allowedVaults: ["brain"], after: 1, limit: 20 }).changes
      .map((change) => change.operation)).toEqual(["upsert", "delete"]);
    index.close();
  });

  it("keeps an immutable upsert snapshot after later edits and deletion", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    cleanups.push(fx.cleanup);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));

    index.upsert(parseNote("brain", "A.md", "# First", { mtimeMs: 1, size: 7 }));
    const first = index.listChanges({ allowedVaults: ["brain"], after: 0, limit: 20 }).changes[0];
    index.upsert(parseNote("brain", "A.md", "# Second", { mtimeMs: 2, size: 8 }));
    index.remove("brain", "A.md");

    expect(index.readChangeContent({
      seq: first.seq,
      vault: "brain",
      path: "A.md",
    })).toBe("# First");
    index.close();
  });

  it("paginates only authorized Vault changes with a monotonic cursor", async () => {
    const fx = await makeTempVaultSet(["private", "brain"]);
    cleanups.push(fx.cleanup);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));

    index.upsert(parseNote("private", "Secret.md", "# Secret", { mtimeMs: 1, size: 8 }));
    index.upsert(parseNote("brain", "One.md", "# One", { mtimeMs: 2, size: 5 }));
    index.upsert(parseNote("brain", "Two.md", "# Two", { mtimeMs: 3, size: 5 }));

    const first = index.listChanges({ allowedVaults: ["brain"], after: 0, limit: 1 });
    const second = index.listChanges({
      allowedVaults: ["brain"],
      after: first.nextCursor,
      limit: 1,
    });

    expect(first.changes.map((change) => change.path)).toEqual(["One.md"]);
    expect(second.changes.map((change) => change.path)).toEqual(["Two.md"]);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    index.close();
  });

  it("backfills a current legacy note with a readable snapshot during reconciliation", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    cleanups.push(fx.cleanup);
    const dbFile = path.join(fx.root, "index.sqlite");
    const legacy = new Database(dbFile);
    legacy.exec(`
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY,
        vault_id TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        UNIQUE(vault_id, path)
      );
    `);
    const current = parseNote("brain", "Legacy.md", "# Legacy", { mtimeMs: 10, size: 8 });
    legacy.prepare(`
      INSERT INTO notes(
        vault_id,path,title,body,excerpt,frontmatter_json,tags_json,mtime_ms,size,content_hash
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run("brain", "Legacy.md", "Legacy", "# Legacy", "Legacy", "{}", "[]", 10, 8, current.contentHash);
    legacy.close();

    const index = new SearchIndex(dbFile);
    index.upsert(current);

    expect(index.listChanges({ allowedVaults: ["brain"], after: 0, limit: 20 }).changes)
      .toEqual([{
        seq: 1,
        vault: "brain",
        path: "Legacy.md",
        operation: "upsert",
        contentHash: current.contentHash,
        mtimeMs: 10,
        size: 8,
      }]);
    expect(index.readChangeContent({ seq: 1, vault: "brain", path: "Legacy.md" }))
      .toBe("# Legacy");
    index.close();
  });

  it("does not emit an unreadable baseline for a legacy note missing at startup", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    cleanups.push(fx.cleanup);
    const dbFile = path.join(fx.root, "index.sqlite");
    const legacy = new Database(dbFile);
    legacy.exec(`
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY,
        vault_id TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        UNIQUE(vault_id, path)
      );
    `);
    legacy.prepare(`
      INSERT INTO notes(
        vault_id,path,title,body,excerpt,frontmatter_json,tags_json,mtime_ms,size,content_hash
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run("brain", "Gone.md", "Gone", "# Gone", "Gone", "{}", "[]", 10, 6, "old-hash");
    legacy.close();

    const index = new SearchIndex(dbFile);
    index.removeMissing("brain", new Set());

    expect(index.listChanges({ allowedVaults: ["brain"], after: 0, limit: 20 }).changes)
      .toEqual([{ seq: 1, vault: "brain", path: "Gone.md", operation: "delete" }]);
    index.close();
  });
});
