import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
      path: file, maxRunDurationMs: 1, isProcessAlive: (pid) => pid === process.pid,
      onStaleObserved: async () => { observed += 1; if (observed === 2) releaseBarrier(); await barrier; },
    });
    const locks = await Promise.all([contender(), contender()]);
    expect(observed).toBe(2);
    expect(locks.filter(Boolean)).toHaveLength(1);
    await locks[0]?.release(); await locks[1]?.release();
    expect((await readdir(path.dirname(file))).filter((name) => name.includes("takeover") || name.includes("claim"))).toEqual([]);
  });

  it("recovers a stale crash-leftover takeover guard", async () => {
    const file = await lockPath();
    await writeFile(file, JSON.stringify({ pid: 123, startedAt: "2020-01-01T00:00:00.000Z", owner: "stale-lock" }), "utf8");
    await writeFile(`${file}.takeover`, JSON.stringify({ pid: 456, startedAt: "2020-01-01T00:00:00.000Z", owner: "crashed" }), "utf8");
    const lock = await acquireOrganizerLock({ path: file, maxRunDurationMs: 1, isProcessAlive: () => false });
    expect(lock).toBeDefined();
    await lock?.release();
  });

  it("refuses to remove a takeover guard owned by a live process", async () => {
    const file = await lockPath();
    await writeFile(file, JSON.stringify({ pid: 123, startedAt: "2020-01-01T00:00:00.000Z", owner: "stale-lock" }), "utf8");
    await writeFile(`${file}.takeover`, JSON.stringify({ pid: 456, startedAt: "2020-01-01T00:00:00.000Z", owner: "live" }), "utf8");
    await expect(acquireOrganizerLock({ path: file, maxRunDurationMs: 1, isProcessAlive: (pid) => pid === 456 })).resolves.toBeUndefined();
  });

  it("preserves a live ABA replacement instead of renaming it into an orphan claim", async () => {
    const file = await lockPath();
    await writeFile(file, JSON.stringify({ pid: 123, startedAt: "2020-01-01T00:00:00.000Z", owner: "stale-lock" }), "utf8");
    await writeFile(`${file}.takeover`, JSON.stringify({ pid: 456, startedAt: "2020-01-01T00:00:00.000Z", owner: "stale" }), "utf8");
    let hooked = false;
    const lock = await acquireOrganizerLock({ path: file, maxRunDurationMs: 1, isProcessAlive: () => false, onBeforeGuardClaim: async () => {
      hooked = true; await rm(`${file}.takeover`, { force: true }); await writeFile(`${file}.takeover`, JSON.stringify({ pid: 789, startedAt: "2026-09-04T12:00:00.000Z", owner: "live" }), "utf8");
    } });
    expect(hooked).toBe(true);
    expect(lock).toBeUndefined();
    expect(JSON.parse(await readFile(`${file}.takeover`, "utf8")).owner).toBe("live");
    expect((await readdir(path.dirname(file))).filter((name) => name.includes("claim"))).toEqual([]);
  });

  it("does not overwrite a live primary-lock replacement during stale ownership transfer", async () => {
    const file = await lockPath();
    const stale = JSON.stringify({ pid: 123, startedAt: "2020-01-01T00:00:00.000Z", owner: "stale-lock" });
    const live = JSON.stringify({ pid: process.pid, startedAt: "2026-09-04T12:00:00.000Z", owner: "live-lock" });
    const moved = `${file}.moved`;
    await writeFile(file, stale, "utf8");
    let hooked = false;
    const options = {
      path: file,
      maxRunDurationMs: 1,
      now: () => new Date("2026-09-04T12:00:00.000Z"),
      isProcessAlive: (pid: number) => pid === process.pid,
      onBeforeStaleTransfer: async () => {
        hooked = true;
        await rename(file, moved);
        await writeFile(file, live, "utf8");
      },
    };

    await expect(acquireOrganizerLock(options)).resolves.toBeUndefined();
    expect(hooked).toBe(true);
    expect(await readFile(file, "utf8")).toBe(live);
    expect(await readFile(moved, "utf8")).toBe(stale);
  });

  it("recovers a crashed owner without leaving takeover or claim files", async () => {
    const file = await lockPath();
    const crashed = await acquireOrganizerLock({
      path: file,
      maxRunDurationMs: 1,
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });
    expect(crashed).toBeDefined();

    const recovered = await acquireOrganizerLock({
      path: file,
      maxRunDurationMs: 1,
      now: () => new Date("2026-09-04T12:00:00.000Z"),
      isProcessAlive: () => false,
    });

    expect(recovered).toBeDefined();
    expect((await readdir(path.dirname(file))).filter((name) => name.includes("takeover") || name.includes("claim"))).toEqual([]);
    await recovered?.release();
  });
});
