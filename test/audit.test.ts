import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { AuditLogger } from "../src/audit.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

it("records bounded metadata without note content or secrets", async () => {
  const fx = await makeTempVaultSet(["personal"]);
  try {
    const file = path.join(fx.root, "audit.jsonl");
    await new AuditLogger(file).record({
      action: "create_inbox_note",
      outcome: "allowed",
      vault: "personal",
      path: "Agent-Inbox/a.md",
    });

    const text = await readFile(file, "utf8");
    expect(text).toContain('"outcome":"allowed"');
    expect(text).not.toContain("passphrase");
  } finally {
    await fx.cleanup();
  }
});
