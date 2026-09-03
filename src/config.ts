import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { VaultRegistry } from "./vault-registry.js";

const knowledgeConfigSchema = z.object({
  dataDir: z.string().min(1),
  owner: z.object({
    id: z.string().min(1),
    passphrase: z.string().min(16),
    allowedVaults: z.array(z.string()).min(1),
  }),
  vaults: z.array(z.object({
    id: z.string(),
    root: z.string().min(1),
  })).min(1),
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

  const raw = knowledgeConfigSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
  const registry = await VaultRegistry.create(raw.vaults);
  const allowedVaults = [...new Set(raw.owner.allowedVaults)].sort();
  for (const id of allowedVaults) {
    if (!registry.has(id)) throw new Error(`Owner references unknown vault: ${id}`);
  }
  if (allowedVaults.length !== registry.ids().length) {
    throw new Error("Single owner must be allowed every vault");
  }

  return {
    dataDir: path.resolve(raw.dataDir),
    owner: { ...raw.owner, allowedVaults },
    registry,
  };
}
