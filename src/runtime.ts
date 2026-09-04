import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AuditLogger } from "./audit.js";
import { loadKnowledgeConfig } from "./config.js";
import { IndexCoordinator } from "./index-coordinator.js";
import { KnowledgeBase } from "./knowledge-base.js";
import { loadOrganizerEnvironment } from "./organizer/config.js";
import { OrganizerService } from "./organizer/service.js";
import { prepareOrganizerStatePaths } from "./organizer/state-paths.js";
import { OrganizerStore } from "./organizer/store.js";
import { OrganizerTransactionEngine } from "./organizer/transaction.js";
import type { OrganizerServiceApi } from "./organizer/types.js";
import { SearchIndex } from "./search-index.js";
import type { VaultRegistry } from "./vault-registry.js";

export interface BrainRuntime {
  knowledge: KnowledgeBase;
  organizer?: OrganizerService;
  close(): Promise<void>;
}

export async function cleanupFailedRuntimeConstruction(
  primaryError: unknown,
  resources: {
    store?: Pick<OrganizerStore, "close">;
    knowledge?: Pick<KnowledgeBase, "close">;
  },
): Promise<never> {
  const errors: unknown[] = [primaryError];
  try { resources.store?.close(); }
  catch (error) { errors.push(error); }
  try { await resources.knowledge?.close(); }
  catch (error) { errors.push(error); }
  if (errors.length > 1) throw new AggregateError(errors, "runtime construction cleanup failed");
  throw primaryError;
}

export async function assembleKnowledge(
  dataDir: string,
  registry: VaultRegistry,
  organizer?: OrganizerServiceApi,
): Promise<KnowledgeBase> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const index = SearchIndex.openWithRecovery(path.join(dataDir, "index.sqlite"));
  const coordinator = new IndexCoordinator(registry, index);
  const knowledge = new KnowledgeBase(
    registry,
    index,
    coordinator,
    new AuditLogger(path.join(dataDir, "audit.jsonl")),
    organizer,
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
  if (!loaded.organizer) {
    const knowledge = await assembleKnowledge(loaded.dataDir, loaded.registry);
    return { knowledge, close: () => knowledge.close() };
  }

  let store: OrganizerStore | undefined;
  let knowledge: KnowledgeBase | undefined;
  try {
    const environment = loaded.organizer.mode === "disabled"
      ? { provider: "disabled" as const }
      : loadOrganizerEnvironment(input.environment);
    const state = await prepareOrganizerStatePaths(loaded.dataDir);
    store = new OrganizerStore(state.database);
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
        recoveryRoot: state.recovery,
        recoveryDays: loaded.organizer.recoveryDays,
      }),
      auditLogger: new AuditLogger(path.join(loaded.dataDir, "audit.jsonl")),
      lockPath: state.lock,
    });
    const attachedKnowledge = await assembleKnowledge(
      loaded.dataDir,
      loaded.registry,
      loaded.organizer.mode === "disabled" ? undefined : organizer,
    );
    knowledge = attachedKnowledge;
    let closed = false;
    return {
      knowledge: attachedKnowledge,
      organizer,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await attachedKnowledge.close();
        } finally {
          store?.close();
        }
      },
    };
  } catch (error) {
    return cleanupFailedRuntimeConstruction(error, { store, knowledge });
  }
}
