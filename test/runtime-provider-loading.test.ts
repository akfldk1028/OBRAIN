import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const providerModule = vi.hoisted(() => ({ loads: 0 }));

vi.mock("../src/organizer/dashscope-provider.js", () => {
  providerModule.loads += 1;
  return { DashScopeProvider: class {} };
});

import { assembleRuntime } from "../src/runtime.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("runtime provider loading", () => {
  it("does not evaluate the DashScope provider module for a disabled organizer", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    const configFile = path.join(fx.root, "config.json");
    await writeFile(configFile, JSON.stringify({
      dataDir: path.join(fx.root, "data"),
      owner: { id: "owner", passphrase: "a-long-test-passphrase", allowedVaults: ["brain"] },
      vaults: fx.vaults,
      organizer: { enabledVaults: ["brain"], mode: "disabled" },
    }), { mode: 0o600 });

    try {
      const runtime = await assembleRuntime({ configFile, environment: { ORGANIZER_PROVIDER: "dashscope" } });
      await runtime.close();
      expect(providerModule.loads).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });
});
