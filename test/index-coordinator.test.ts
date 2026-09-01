import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IndexCoordinator } from "../src/index-coordinator.js";
import { SearchIndex } from "../src/search-index.js";
import { VaultRegistry } from "../src/vault-registry.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

async function eventually(assertion: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe("IndexCoordinator", () => {
  it("scans nested notes and removes stale records", async () => {
    const fx = await makeTempVaultSet(["personal", "work"]);
    await mkdir(path.join(fx.vaults[0].root, "Nested"));
    const notePath = path.join(fx.vaults[0].root, "Nested", "한글.md");
    await writeFile(notePath, "# 지식검색");
    const registry = await VaultRegistry.create(fx.vaults);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));
    const coordinator = new IndexCoordinator(registry, index);
    try {
      await coordinator.reconcile();
      expect(index.search("지식검색", registry.ids(), 10)).toHaveLength(1);
      await rm(notePath);
      await coordinator.reconcile();
      expect(index.search("지식검색", registry.ids(), 10)).toHaveLength(0);
    } finally {
      await coordinator.stopWatching();
      index.close();
      await fx.cleanup();
    }
  });

  it("indexes a note created after the watcher starts", async () => {
    const fx = await makeTempVaultSet(["work"]);
    const registry = await VaultRegistry.create(fx.vaults);
    const index = new SearchIndex(path.join(fx.root, "index.sqlite"));
    const coordinator = new IndexCoordinator(registry, index);
    try {
      await coordinator.initialize();
      await writeFile(path.join(fx.vaults[0].root, "new.md"), "# watcher-term");
      await eventually(() => {
        expect(index.search("watcher-term", ["work"], 10)).toHaveLength(1);
      });
    } finally {
      await coordinator.stopWatching();
      index.close();
      await fx.cleanup();
    }
  });
});
