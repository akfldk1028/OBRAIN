import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultFS } from "../src/vault.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

describe("createInboxNote", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("creates a unique Markdown note only in Agent-Inbox", async () => {
    const fx = await makeTempVaultSet(["personal"]);
    cleanups.push(fx.cleanup);
    const vault = await VaultFS.create(fx.vaults[0].root, { allowedExt: [".md"] });

    const created = await vault.createInboxNote({ title: "회의 기록", content: "본문" });

    expect(created.path).toMatch(/^Agent-Inbox\//);
    expect(await readFile(path.join(fx.vaults[0].root, created.path), "utf8")).toContain("본문");
  });

  it("rejects an inbox symlink that escapes the vault", async () => {
    const fx = await makeTempVaultSet(["personal"]);
    cleanups.push(fx.cleanup);
    const outside = path.join(fx.root, "outside");
    await mkdir(outside);
    const inbox = path.join(fx.vaults[0].root, "Agent-Inbox");
    await rm(inbox, { recursive: true });
    await symlink(outside, inbox, "junction");
    const vault = await VaultFS.create(fx.vaults[0].root, { allowedExt: [".md"] });

    await expect(vault.createInboxNote({ title: "escape", content: "x" })).rejects.toThrow(/escapes/i);
  });

  it("rejects a note larger than one MiB", async () => {
    const fx = await makeTempVaultSet(["personal"]);
    cleanups.push(fx.cleanup);
    const vault = await VaultFS.create(fx.vaults[0].root, { allowedExt: [".md"] });

    await expect(vault.createInboxNote({
      title: "huge",
      content: "x".repeat(1_048_577),
    })).rejects.toThrow(/too large/i);
  });
});
