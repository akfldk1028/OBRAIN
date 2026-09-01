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
