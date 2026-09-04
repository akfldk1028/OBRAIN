import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

interface LockRecord {
  pid: number;
  startedAt: string;
  owner: string;
}

export interface OrganizerLock {
  release(): Promise<void>;
}

export interface AcquireOrganizerLockOptions {
  path: string;
  maxRunDurationMs: number;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  /** Test/diagnostic hook invoked after a stale lock is observed and before takeover arbitration. */
  onStaleObserved?: () => void | Promise<void>;
  /** Test/diagnostic hook immediately before atomically claiming a stale takeover guard. */
  onBeforeGuardClaim?: () => void | Promise<void>;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLock(content: string): LockRecord | undefined {
  try {
    const value = JSON.parse(content) as Partial<LockRecord>;
    const pid = value.pid;
    if (
      !Number.isSafeInteger(pid) || pid === undefined || pid < 1 || typeof value.owner !== "string"
      || !value.owner || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
    ) return undefined;
    return { pid, owner: value.owner, startedAt: value.startedAt };
  } catch {
    return undefined;
  }
}

export async function acquireOrganizerLock(options: AcquireOrganizerLockOptions): Promise<OrganizerLock | undefined> {
  if (!path.isAbsolute(options.path) || !Number.isSafeInteger(options.maxRunDurationMs) || options.maxRunDurationMs < 1) {
    throw new Error("organizer lock options are invalid");
  }
  const now = options.now ?? (() => new Date());
  const alive = options.isProcessAlive ?? processAlive;
  const record: LockRecord = { pid: process.pid, startedAt: now().toISOString(), owner: randomUUID() };
  const content = JSON.stringify(record);

  const takeoverPath = `${options.path}.takeover`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(path.dirname(options.path), { recursive: true, mode: 0o700 });
      const handle = await open(options.path, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          let current: string;
          try { current = await readFile(options.path, "utf8"); } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          if (current !== content) throw new Error("organizer lock ownership changed");
          await unlink(options.path);
        },
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: LockRecord | undefined; let existingText: string;
      try { existingText = await readFile(options.path, "utf8"); existing = parseLock(existingText); } catch (readError: unknown) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        return undefined;
      }
      const age = existing ? now().getTime() - Date.parse(existing.startedAt) : Number.NEGATIVE_INFINITY;
      if (!existing || alive(existing.pid) || age <= options.maxRunDurationMs) return undefined;
      await options.onStaleObserved?.();
      let takeover: Awaited<ReturnType<typeof open>>; let ownedTakeoverPath = takeoverPath; let keepClaim = false;
      try { takeover = await open(takeoverPath, "wx", 0o600); } catch (takeoverError: unknown) {
        if ((takeoverError as NodeJS.ErrnoException).code !== "EEXIST") throw takeoverError;
        let guardText: string;
        try { guardText = await readFile(takeoverPath, "utf8"); } catch { return undefined; }
        const guard = parseLock(guardText);
        const guardAge = guard ? now().getTime() - Date.parse(guard.startedAt) : Number.NEGATIVE_INFINITY;
        if (!guard || alive(guard.pid) || guardAge <= options.maxRunDurationMs) return undefined;
        await options.onBeforeGuardClaim?.();
        const claimPath = `${takeoverPath}.claim-${record.owner}`;
        try { await rename(takeoverPath, claimPath); } catch { return undefined; }
        const claimed = await readFile(claimPath, "utf8").catch(() => undefined);
        if (claimed !== guardText) { keepClaim = true; return undefined; }
        ownedTakeoverPath = claimPath;
        try { takeover = await open(ownedTakeoverPath, "r+"); } catch { return undefined; }
      }
      try {
        await takeover.writeFile(content, "utf8");
        await takeover.sync();
        const current = await readFile(options.path, "utf8").catch((readError: unknown) => (
          (readError as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(readError)
        ));
        const currentRecord = current === undefined ? undefined : parseLock(current);
        const currentAge = currentRecord ? now().getTime() - Date.parse(currentRecord.startedAt) : Number.NEGATIVE_INFINITY;
        if (!currentRecord || current !== existingText || alive(currentRecord.pid) || currentAge <= options.maxRunDurationMs) return undefined;
        await unlink(options.path);
      } finally {
        await takeover.close();
        if (keepClaim) return;
        await unlink(ownedTakeoverPath).catch((unlinkError: unknown) => {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        });
      }
    }
  }
  return undefined;
}
