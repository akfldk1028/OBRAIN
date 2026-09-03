import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadKnowledgeConfig } from "../src/config.js";
import { loadOrganizerEnvironment } from "../src/organizer/config.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("organizer environment", () => {
  it("defaults to a disabled provider without requiring a key", () => {
    expect(loadOrganizerEnvironment({
      ORGANIZER_PROVIDER: "disabled",
    })).toEqual({ provider: "disabled" });
  });

  it("requires a new key and an official HTTPS base URL for DashScope", () => {
    expect(() => loadOrganizerEnvironment({ ORGANIZER_PROVIDER: "dashscope" })).toThrow("DASHSCOPE_API_KEY");
    expect(() => loadOrganizerEnvironment({
      ORGANIZER_PROVIDER: "dashscope",
      DASHSCOPE_API_KEY: "test-only-key-material",
      DASHSCOPE_BASE_URL: "http://127.0.0.1:9000",
      DASHSCOPE_MODEL: "qwen-plus",
    })).toThrow("official DashScope HTTPS");
  });

  it("keeps valid DashScope key material out of JSON serialization", () => {
    const environment = loadOrganizerEnvironment({
      ORGANIZER_PROVIDER: "dashscope",
      DASHSCOPE_API_KEY: "test-only-key-material",
      DASHSCOPE_BASE_URL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      DASHSCOPE_MODEL: "qwen-plus",
    });

    expect(environment).toMatchObject({
      provider: "dashscope",
      apiKey: "test-only-key-material",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
    });
    expect(JSON.stringify(environment)).not.toContain("test-only-key-material");
  });

  it("applies safe defaults to a configured organizer", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    const configPath = path.join(fx.root, "config.json");
    await writeFile(configPath, JSON.stringify({
      dataDir: path.join(fx.root, "data"),
      owner: {
        id: "owner",
        passphrase: "a-long-test-passphrase",
        allowedVaults: ["brain"],
      },
      vaults: fx.vaults,
      organizer: { enabledVaults: ["brain"] },
    }), { mode: 0o600 });

    try {
      await expect(loadKnowledgeConfig(configPath)).resolves.toMatchObject({
        organizer: {
          enabledVaults: ["brain"],
          mode: "dry-run",
          minStableSeconds: 300,
          autoApplyConfidence: 0.9,
          maxNotesPerRun: 20,
          maxNoteBytes: 131072,
          maxContextBytes: 262144,
          proposalTtlHours: 24,
          recoveryDays: 30,
          reportsDirectory: "60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports",
        },
      });
    } finally {
      await fx.cleanup();
    }
  });

  it.each(["dry-run", "automatic"] as const)("rejects confidence below 0.90 in %s mode", async (mode) => {
    const fx = await makeTempVaultSet(["brain"]);
    const configPath = path.join(fx.root, "config.json");
    await writeFile(configPath, JSON.stringify({
      dataDir: path.join(fx.root, "data"),
      owner: {
        id: "owner",
        passphrase: "a-long-test-passphrase",
        allowedVaults: ["brain"],
      },
      vaults: fx.vaults,
      organizer: { enabledVaults: ["brain"], mode, autoApplyConfidence: 0.89 },
    }), { mode: 0o600 });

    try {
      await expect(loadKnowledgeConfig(configPath)).rejects.toThrow(/greater than or equal to 0.9/i);
    } finally {
      await fx.cleanup();
    }
  });
});
