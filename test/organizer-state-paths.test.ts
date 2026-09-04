import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOrganizerStatePaths } from "../src/organizer/state-paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "organizer-state-paths-"));
  roots.push(root);
  return root;
}

describe("organizer persistent state paths", () => {
  it("creates the backup-contained organizer root and transaction directory", async () => {
    const dataDir = await dataDirectory();

    const paths = await prepareOrganizerStatePaths(dataDir);

    expect(paths).toEqual({
      root: path.join(dataDir, "organizer"),
      database: path.join(dataDir, "organizer", "organizer.sqlite"),
      recovery: path.join(dataDir, "organizer", "transactions"),
      lock: path.join(dataDir, "organizer", "organizer.lock"),
    });
    expect((await lstat(paths.root)).isDirectory()).toBe(true);
    expect((await lstat(paths.recovery)).isDirectory()).toBe(true);
  });

  it("migrates legacy database sidecars and recovery state without data loss", async () => {
    const dataDir = await dataDirectory();
    await writeFile(path.join(dataDir, "organizer.sqlite"), "legacy-db", "utf8");
    await writeFile(path.join(dataDir, "organizer.sqlite-wal"), "legacy-wal", "utf8");
    await mkdir(path.join(dataDir, "organizer-recovery"));
    await writeFile(path.join(dataDir, "organizer-recovery", "manifest.marker"), "legacy-recovery", "utf8");

    const paths = await prepareOrganizerStatePaths(dataDir);

    await expect(readFile(paths.database, "utf8")).resolves.toBe("legacy-db");
    await expect(readFile(`${paths.database}-wal`, "utf8")).resolves.toBe("legacy-wal");
    await expect(readFile(path.join(paths.recovery, "manifest.marker"), "utf8")).resolves.toBe("legacy-recovery");
    await expect(lstat(path.join(dataDir, "organizer.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(dataDir, "organizer-recovery"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed without changing either copy when legacy and target state conflict", async () => {
    const dataDir = await dataDirectory();
    await mkdir(path.join(dataDir, "organizer"));
    await writeFile(path.join(dataDir, "organizer.sqlite"), "legacy-db", "utf8");
    await writeFile(path.join(dataDir, "organizer", "organizer.sqlite"), "target-db", "utf8");

    await expect(prepareOrganizerStatePaths(dataDir)).rejects.toThrow(/conflict/i);

    await expect(readFile(path.join(dataDir, "organizer.sqlite"), "utf8")).resolves.toBe("legacy-db");
    await expect(readFile(path.join(dataDir, "organizer", "organizer.sqlite"), "utf8")).resolves.toBe("target-db");
  });

  it("fails closed when a target SQLite sidecar exists without its database", async () => {
    const dataDir = await dataDirectory();
    const targetRoot = path.join(dataDir, "organizer");
    const orphan = path.join(targetRoot, "organizer.sqlite-wal");
    await mkdir(targetRoot);
    await writeFile(orphan, "orphan-target-wal", "utf8");

    await expect(prepareOrganizerStatePaths(dataDir)).rejects.toThrow(/sidecar.*database/i);

    await expect(readFile(orphan, "utf8")).resolves.toBe("orphan-target-wal");
    await expect(lstat(path.join(targetRoot, "organizer.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
