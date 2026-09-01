import { afterEach, describe, expect, it } from "vitest";
import { VaultRegistry } from "../src/vault-registry.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("VaultRegistry", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("resolves configured IDs and hides filesystem paths in errors", async () => {
    const fx = await makeTempVaultSet(["personal", "work"]);
    cleanups.push(fx.cleanup);
    const registry = await VaultRegistry.create(fx.vaults);

    expect(registry.get("personal").rootPath).toBe(fx.vaults[0].root);
    expect(() => registry.get("missing")).toThrow("Unknown or unauthorized vault");
  });

  it("rejects duplicate vault IDs", async () => {
    const fx = await makeTempVaultSet(["personal"]);
    cleanups.push(fx.cleanup);

    await expect(VaultRegistry.create([fx.vaults[0], fx.vaults[0]])).rejects.toThrow(/duplicate/i);
  });
});
