import { describe, expect, it, vi } from "vitest";
import { KnowledgeBase } from "../src/knowledge-base.js";
import { assembleKnowledge } from "../src/runtime.js";
import type { AuditLogger } from "../src/audit.js";
import { IndexCoordinator } from "../src/index-coordinator.js";
import { SearchIndex } from "../src/search-index.js";
import type { VaultRegistry } from "../src/vault-registry.js";
import { VaultRegistry as RealVaultRegistry } from "../src/vault-registry.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("KnowledgeBase resource cleanup", () => {
  it("closes the index even when watcher shutdown fails", async () => {
    const stopWatching = vi.fn().mockRejectedValue(new Error("watcher failure"));
    const close = vi.fn();
    const knowledge = new KnowledgeBase(
      {} as VaultRegistry,
      { close } as unknown as SearchIndex,
      { stopWatching } as unknown as IndexCoordinator,
      {} as AuditLogger,
    );

    await expect(knowledge.close()).rejects.toThrow("watcher failure");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a partially assembled knowledge base when watcher initialization fails", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    const registry = await RealVaultRegistry.create(fx.vaults);
    const initialize = vi.spyOn(IndexCoordinator.prototype, "initialize").mockRejectedValueOnce(new Error("watcher start failure"));
    const close = vi.spyOn(SearchIndex.prototype, "close");
    try {
      await expect(assembleKnowledge(`${fx.root}/data`, registry)).rejects.toThrow("watcher start failure");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      initialize.mockRestore();
      close.mockRestore();
      await fx.cleanup().catch(() => undefined);
    }
  });
});
