import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadKnowledgeConfig } from "../src/config.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("loadKnowledgeConfig", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("loads one owner with every configured vault", async () => {
    const fx = await makeTempVaultSet(["personal", "work"]);
    cleanups.push(fx.cleanup);
    const configPath = path.join(fx.root, "config.json");
    await writeFile(configPath, JSON.stringify({
      dataDir: path.join(fx.root, "data"),
      owner: {
        id: "owner",
        passphrase: "a-long-test-passphrase",
        allowedVaults: ["personal", "work"],
      },
      vaults: fx.vaults,
    }), { mode: 0o600 });

    const loaded = await loadKnowledgeConfig(configPath);

    expect(loaded.owner.id).toBe("owner");
    expect(loaded.registry.ids()).toEqual(["personal", "work"]);
  });

  it("rejects an owner reference to an unknown vault", async () => {
    const fx = await makeTempVaultSet(["personal"]);
    cleanups.push(fx.cleanup);
    const configPath = path.join(fx.root, "bad.json");
    await writeFile(configPath, JSON.stringify({
      dataDir: path.join(fx.root, "data"),
      owner: {
        id: "owner",
        passphrase: "a-long-test-passphrase",
        allowedVaults: ["missing"],
      },
      vaults: fx.vaults,
    }), { mode: 0o600 });

    await expect(loadKnowledgeConfig(configPath)).rejects.toThrow(/unknown vault/i);
  });
});
