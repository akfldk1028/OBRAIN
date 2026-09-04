import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
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

  for (let attempt = 0; attempt < 2; attempt += 1) {
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
      let existing: LockRecord | undefined;
      try { existing = parseLock(await readFile(options.path, "utf8")); } catch (readError: unknown) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        return undefined;
      }
      const age = existing ? now().getTime() - Date.parse(existing.startedAt) : Number.NEGATIVE_INFINITY;
      if (!existing || alive(existing.pid) || age <= options.maxRunDurationMs) return undefined;
      try { await unlink(options.path); } catch (unlinkError: unknown) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
    }
  }
  return undefined;
}
