import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRAIN_FOUNDATION_POLICY } from "../src/foundation/policy.js";
import { installFoundation } from "../src/foundation/install.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("foundation installer", () => {
  it("previews without writing, then creates only missing foundation files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brain-foundation-"));
    roots.push(root);

    const preview = await installFoundation({
      vaultRoot: root,
      policy: BRAIN_FOUNDATION_POLICY,
      apply: false,
    });
    expect(preview.preview).toBe(true);
    expect(preview.created.length).toBeGreaterThan(30);
    expect(preview.created).not.toContain(".obsidian");
    expect(preview.created).not.toContain(".stfolder");
    await expect(readFile(path.join(root, "000_AI_WORK_GUIDE.md"), "utf8")).rejects.toThrow();

    await writeFile(path.join(root, "000_Home_MOC.md"), "human home", "utf8");
    const applied = await installFoundation({
      vaultRoot: root,
      policy: BRAIN_FOUNDATION_POLICY,
      apply: true,
    });
    expect(applied.preview).toBe(false);
    expect(await readFile(path.join(root, "000_Home_MOC.md"), "utf8")).toBe("human home");
    expect(applied.skippedExisting).toContain("000_Home_MOC.md");
    expect(await readFile(path.join(root, "20_Study/000_Study_MOC.md"), "utf8")).toContain("Study MOC");

    const repeated = await installFoundation({
      vaultRoot: root,
      policy: BRAIN_FOUNDATION_POLICY,
      apply: true,
    });
    expect(repeated.created).toEqual([]);
    expect(repeated.skippedExisting).toContain("000_Home_MOC.md");
  });

  it("refuses an existing area symlink instead of writing through it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brain-foundation-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-outside-"));
    roots.push(root, outside);
    await symlink(outside, path.join(root, "20_Study"), "junction");

    await expect(installFoundation({ vaultRoot: root, policy: BRAIN_FOUNDATION_POLICY, apply: true }))
      .rejects.toThrow("symlink");
    await expect(readFile(path.join(outside, "000_Study_MOC.md"), "utf8")).rejects.toThrow();
  });
});
