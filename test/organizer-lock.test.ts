import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOrganizerLock } from "../src/organizer/lock.js";

const roots: string[] = [];

async function lockPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-organizer-lock-"));
  roots.push(root);
  return path.join(root, "organizer.lock");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("organizer lock", () => {
  it("refuses a second acquisition, then allows a release and reacquisition", async () => {
    const file = await lockPath();
    const first = await acquireOrganizerLock({ path: file, maxRunDurationMs: 1_000 });
    if (!first) throw new Error("expected initial lock");
    await expect(acquireOrganizerLock({ path: file, maxRunDurationMs: 1_000 })).resolves.toBeUndefined();
    await first.release();
    const second = await acquireOrganizerLock({ path: file, maxRunDurationMs: 1_000 });
    expect(second).toBeDefined();
    await second?.release();
  });

  it("refuses an old lock while its owner PID is alive", async () => {
    const file = await lockPath();
    await writeFile(file, JSON.stringify({ pid: 123, startedAt: "2020-01-01T00:00:00.000Z", owner: "other" }), "utf8");
    await expect(acquireOrganizerLock({
      path: file,
      maxRunDurationMs: 1,
      isProcessAlive: (pid) => pid === 123,
    })).resolves.toBeUndefined();
  });

  it("recovers an old lock only when its owner PID is dead", async () => {
    const file = await lockPath();
    await writeFile(file, JSON.stringify({ pid: 123, startedAt: "2020-01-01T00:00:00.000Z", owner: "other" }), "utf8");
    const lock = await acquireOrganizerLock({
      path: file,
      maxRunDurationMs: 1,
      isProcessAlive: () => false,
    });
    expect(lock).toBeDefined();
    await lock?.release();
  });

  it("allows only one contender to take over the same stale lock", async () => {
    const file = await lockPath();
    await writeFile(file, JSON.stringify({ pid: 123, startedAt: "2020-01-01T00:00:00.000Z", owner: "other" }), "utf8");
    let observed = 0; let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const contender = () => acquireOrganizerLock({
      path: file, maxRunDurationMs: 1, isProcessAlive: () => false,
      onStaleObserved: async () => { observed += 1; if (observed === 2) releaseBarrier(); await barrier; },
    });
    const locks = await Promise.all([contender(), contender()]);
    expect(observed).toBe(2);
    expect(locks.filter(Boolean)).toHaveLength(1);
    await locks[0]?.release(); await locks[1]?.release();
  });
});
