import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AuditLogger } from "./audit.js";
import { loadKnowledgeConfig } from "./config.js";
import { IndexCoordinator } from "./index-coordinator.js";
import { KnowledgeBase } from "./knowledge-base.js";
import { loadOrganizerEnvironment } from "./organizer/config.js";
import { OrganizerService } from "./organizer/service.js";
import { OrganizerStore } from "./organizer/store.js";
import { OrganizerTransactionEngine } from "./organizer/transaction.js";
import { SearchIndex } from "./search-index.js";
import type { VaultRegistry } from "./vault-registry.js";

export interface BrainRuntime {
  knowledge: KnowledgeBase;
  organizer?: OrganizerService;
  close(): Promise<void>;
}

export async function assembleKnowledge(dataDir: string, registry: VaultRegistry): Promise<KnowledgeBase> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const index = SearchIndex.openWithRecovery(path.join(dataDir, "index.sqlite"));
  const coordinator = new IndexCoordinator(registry, index);
  const knowledge = new KnowledgeBase(
    registry,
    index,
    coordinator,
    new AuditLogger(path.join(dataDir, "audit.jsonl")),
  );
  try {
    await knowledge.initialize();
    return knowledge;
  } catch (error) {
    try {
      await knowledge.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "knowledge initialization cleanup failed");
    }
    throw error;
  }
}

export async function assembleRuntime(input: {
  configFile: string;
  environment: NodeJS.ProcessEnv;
}): Promise<BrainRuntime> {
  const loaded = await loadKnowledgeConfig(input.configFile);
  const knowledge = await assembleKnowledge(loaded.dataDir, loaded.registry);
  if (!loaded.organizer) return { knowledge, close: () => knowledge.close() };

  let store: OrganizerStore | undefined;
  try {
    const environment = loaded.organizer.mode === "disabled"
      ? { provider: "disabled" as const }
      : loadOrganizerEnvironment(input.environment);
    store = new OrganizerStore(path.join(loaded.dataDir, "organizer.sqlite"));
    const organizer = new OrganizerService({
      registry: loaded.registry,
      config: loaded.organizer,
      store,
      provider: environment.provider === "dashscope"
        ? async ({ maxContextBytes }) => {
          const { DashScopeProvider } = await import("./organizer/dashscope-provider.js");
          return new DashScopeProvider(environment, { maxContextBytes });
        }
        : undefined,
      transaction: new OrganizerTransactionEngine({
        store,
        recoveryRoot: path.join(loaded.dataDir, "organizer-recovery"),
      }),
      auditLogger: new AuditLogger(path.join(loaded.dataDir, "audit.jsonl")),
      lockPath: path.join(loaded.dataDir, "organizer.lock"),
    });
    let closed = false;
    return {
      knowledge,
      organizer,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await knowledge.close();
        } finally {
          store?.close();
        }
      },
    };
  } catch (error) {
    store?.close();
    await knowledge.close();
    throw error;
  }
}
