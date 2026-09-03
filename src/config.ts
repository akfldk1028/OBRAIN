import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OrganizerConfig } from "./organizer/types.js";
import { VaultRegistry } from "./vault-registry.js";

const organizerConfigSchema = z.object({
  enabledVaults: z.array(z.string().min(1)).min(1),
  mode: z.enum(["disabled", "dry-run", "automatic"]).default("dry-run"),
  minStableSeconds: z.number().int().min(0).max(86_400).default(300),
  autoApplyConfidence: z.number().min(0.90).max(1).default(0.90),
  maxNotesPerRun: z.number().int().min(1).max(1_000).default(20),
  maxNoteBytes: z.number().int().min(1).max(1_048_576).default(131_072),
  maxContextBytes: z.number().int().min(1).max(1_048_576).default(262_144),
  proposalTtlHours: z.number().int().min(1).max(720).default(24),
  recoveryDays: z.number().int().min(1).max(365).default(30),
  reportsDirectory: z.literal("60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports").default("60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports"),
}).strict();

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
  organizer: organizerConfigSchema.optional(),
});

export interface LoadedKnowledgeConfig {
  dataDir: string;
  owner: { id: string; passphrase: string; allowedVaults: string[] };
  registry: VaultRegistry;
  organizer?: OrganizerConfig;
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
    organizer: raw.organizer,
  };
}
