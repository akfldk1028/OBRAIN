import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNote } from "../src/note-parser.js";
import { SearchIndex } from "../src/search-index.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("SearchIndex", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("searches Korean substrings across vaults and respects a vault filter", async () => {
    const fx = await makeTempVaultSet(["personal", "work"]);
    cleanups.push(fx.cleanup);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));
    index.upsert(parseNote("personal", "생각.md", "# 장기 프로젝트\n개인지식", { mtimeMs: 1, size: 10 }));
    index.upsert(parseNote("work", "업무.md", "# 프로젝트 회의\n결정사항", { mtimeMs: 2, size: 10 }));

    expect(index.search("프로젝트", ["personal", "work"], 10)).toHaveLength(2);
    expect(index.search("로젝", ["personal", "work"], 10)).toHaveLength(2);
    expect(index.search("프로젝트", ["work"], 10).map((hit) => hit.vaultId)).toEqual(["work"]);
    index.close();
  });

  it("uses a safe short-query fallback", async () => {
    const fx = await makeTempVaultSet(["personal"]);
    cleanups.push(fx.cleanup);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));
    index.upsert(parseNote("personal", "AI.md", "# AI\n100% useful", { mtimeMs: 1, size: 10 }));

    expect(index.search("AI", ["personal"], 10).map((hit) => hit.path)).toEqual(["AI.md"]);
    expect(index.search("%", ["personal"], 10).map((hit) => hit.path)).toEqual(["AI.md"]);
    index.close();
  });

  it("returns backlinks only inside the selected vault", async () => {
    const fx = await makeTempVaultSet(["personal", "work"]);
    cleanups.push(fx.cleanup);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));
    index.upsert(parseNote("personal", "A.md", "[[B]]", { mtimeMs: 1, size: 5 }));
    index.upsert(parseNote("personal", "B.md", "# B", { mtimeMs: 1, size: 3 }));
    index.upsert(parseNote("work", "Other.md", "[[B]]", { mtimeMs: 1, size: 5 }));

    expect(index.backlinks("personal", "B.md")).toEqual(["A.md"]);
    index.close();
  });

  it("quarantines an unreadable database and opens a fresh index", async () => {
    const fx = await makeTempVaultSet(["personal"]);
    cleanups.push(fx.cleanup);
    const dbFile = path.join(fx.root, "index.sqlite");
    await writeFile(dbFile, Buffer.from("not-a-sqlite-database"));

    const index = SearchIndex.openWithRecovery(dbFile);
    index.upsert(parseNote("personal", "ok.md", "# recovered", { mtimeMs: 1, size: 11 }));

    expect(index.search("recovered", ["personal"], 10)).toHaveLength(1);
    index.close();
    expect((await readdir(fx.root)).some((name) => name.startsWith("index.sqlite.corrupt-"))).toBe(true);
  });
});
