import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKnowledgeFixture } from "./helpers/knowledge-fixture.js";

describe("KnowledgeBase", () => {
  it("searches every vault or only selected vaults", async () => {
    const fx = await createKnowledgeFixture(["personal", "work"]);
    try {
      await writeFile(path.join(fx.rootOf("personal"), "p.md"), "# 공통검색 개인");
      await writeFile(path.join(fx.rootOf("work"), "w.md"), "# 공통검색 업무");
      await fx.knowledge.initialize();

      expect((await fx.knowledge.searchNotes({ query: "공통검색" })).hits).toHaveLength(2);
      const workOnly = await fx.knowledge.searchNotes({ query: "공통검색", vaults: ["work"] });
      expect(workOnly.hits.map((hit) => hit.vault)).toEqual(["work"]);
    } finally {
      await fx.cleanup();
    }
  });

  it("creates only an inbox note and indexes it immediately", async () => {
    const fx = await createKnowledgeFixture(["personal"]);
    try {
      await fx.knowledge.initialize();
      const created = await fx.knowledge.createInboxNote({
        vault: "personal",
        title: "에이전트 기록",
        content: "즉시검색",
      });

      expect(created.path).toMatch(/^Agent-Inbox\//);
      expect((await fx.knowledge.searchNotes({ query: "즉시검색" })).hits).toHaveLength(1);
      expect(await readFile(path.join(fx.rootOf("personal"), created.path), "utf8")).toContain("즉시검색");
    } finally {
      await fx.cleanup();
    }
  });
});
