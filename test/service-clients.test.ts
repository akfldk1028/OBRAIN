import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashServiceSecret,
  loadServiceClients,
  verifyServiceSecret,
} from "../src/service-clients.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("service client configuration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("loads a read-only client and verifies only the matching secret", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    cleanups.push(fx.cleanup);
    const file = path.join(fx.root, "service-clients.json");
    const secretHash = await hashServiceSecret("correct horse battery staple");
    await writeFile(file, JSON.stringify({ clients: [{
      clientId: "flow",
      secretHash,
      ownerId: "owner",
      scopes: ["notes:read"],
      allowedVaults: ["brain"],
      enabled: true,
    }] }), { mode: 0o600 });

    const [client] = await loadServiceClients(file, ["brain"], ["owner"]);

    await expect(verifyServiceSecret(client, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyServiceSecret(client, "wrong")).resolves.toBe(false);
  });

  it("rejects unknown Vaults and every write scope", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    cleanups.push(fx.cleanup);
    const file = path.join(fx.root, "service-clients.json");
    const secretHash = await hashServiceSecret("correct horse battery staple");

    await writeFile(file, JSON.stringify({ clients: [{
      clientId: "flow",
      secretHash,
      ownerId: "owner",
      scopes: ["notes:write"],
      allowedVaults: ["missing"],
      enabled: true,
    }] }), { mode: 0o600 });

    await expect(loadServiceClients(file, ["brain"], ["owner"]))
      .rejects.toThrow();
  });

  it("rejects duplicate ids, unknown owners, and malformed secret hashes", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    cleanups.push(fx.cleanup);
    const file = path.join(fx.root, "service-clients.json");
    const client = {
      clientId: "flow",
      secretHash: "not-a-supported-hash",
      ownerId: "missing-owner",
      scopes: ["notes:read"],
      allowedVaults: ["brain"],
      enabled: true,
    };
    await writeFile(file, JSON.stringify({ clients: [client, client] }), { mode: 0o600 });

    await expect(loadServiceClients(file, ["brain"], ["owner"]))
      .rejects.toThrow();
  });
});
