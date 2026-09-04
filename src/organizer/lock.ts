import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { claimLockCoordinator, releaseLockCoordinator, type LockCoordinatorLease } from "./lock-coordinator.js";

interface LockRecord {
  pid: number;
  startedAt: string;
  owner: string;
  generation?: number;
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
  /** Legacy-guard migration hook. New acquisitions do not create takeover or claim files. */
  onBeforeGuardClaim?: () => void | Promise<void>;
  /** Test/diagnostic hook after the stale primary object is opened and before ownership transfer. */
  onBeforeStaleTransfer?: () => void | Promise<void>;
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
      || (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || value.generation < 1))
    ) return undefined;
    return { pid, owner: value.owner, startedAt: value.startedAt, ...(value.generation === undefined ? {} : { generation: value.generation }) };
  } catch {
    return undefined;
  }
}

function stale(record: LockRecord, at: Date, maxRunDurationMs: number, alive: (pid: number) => boolean): boolean {
  return !alive(record.pid) && at.getTime() - Date.parse(record.startedAt) > maxRunDurationMs;
}

type BigStat = Awaited<ReturnType<FileHandle["stat"]>>;

function sameIdentity(left: BigStat, right: BigStat): boolean {
  if ((left.dev === 0n && left.ino === 0n) || (right.dev === 0n && right.ino === 0n)) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

async function legacyGuardBlocks(
  options: AcquireOrganizerLockOptions,
  at: Date,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  const guardPath = `${options.path}.takeover`;
  let observed: string;
  try {
    observed = await readFile(guardPath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
  const guard = parseLock(observed);
  if (!guard || !stale(guard, at, options.maxRunDurationMs, alive)) return true;
  await options.onBeforeGuardClaim?.();
  const current = await readFile(guardPath, "utf8").catch(() => undefined);
  if (current !== observed) return true;
  const currentGuard = parseLock(current);
  return !currentGuard || !stale(currentGuard, at, options.maxRunDurationMs, alive);
}

async function readHandle(handle: FileHandle): Promise<{ content: string; stat: BigStat }> {
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile() || stat.size > 4096n) throw new Error("organizer lock file is invalid");
  const bytes = Buffer.alloc(Number(stat.size));
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== bytes.length) throw new Error("organizer lock file changed during read");
  return { content: bytes.toString("utf8"), stat };
}

async function replaceHandleContent(handle: FileHandle, content: string): Promise<void> {
  const bytes = Buffer.from(content, "utf8");
  await handle.truncate(0);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten === 0) throw new Error("organizer lock write made no progress");
    offset += result.bytesWritten;
  }
  await handle.sync();
}

async function primaryPathStillNames(lockPath: string, opened: BigStat): Promise<boolean> {
  try {
    const before = await lstat(lockPath, { bigint: true });
    const canonical = await realpath(lockPath);
    const after = await lstat(lockPath, { bigint: true });
    const canonicalStat = await lstat(canonical, { bigint: true });
    return canonical === lockPath && !before.isSymbolicLink() && before.isFile()
      && sameIdentity(opened, before) && sameIdentity(opened, after) && sameIdentity(opened, canonicalStat);
  } catch {
    return false;
  }
}

async function acquirePrimary(
  options: AcquireOrganizerLockOptions,
  content: string,
  lease: LockCoordinatorLease,
  at: Date,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  try {
    const handle = await open(options.path, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const handle = await open(options.path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  let original: string | undefined;
  let mutated = false;
  try {
    const opened = await readHandle(handle);
    original = opened.content;
    const current = parseLock(original);
    if (current) {
      if (!stale(current, at, options.maxRunDurationMs, alive)) return false;
    } else if (!lease.previousWasStale) {
      return false;
    }
    await options.onBeforeStaleTransfer?.();
    mutated = true;
    await replaceHandleContent(handle, content);
    const updated = await handle.stat({ bigint: true });
    if (!sameIdentity(opened.stat, updated) || !(await primaryPathStillNames(options.path, updated))) {
      await replaceHandleContent(handle, original);
      return false;
    }
    return true;
  } catch (error) {
    if (mutated && original !== undefined) {
      try {
        await replaceHandleContent(handle, original);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "organizer lock takeover and restoration failed");
      }
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export async function acquireOrganizerLock(options: AcquireOrganizerLockOptions): Promise<OrganizerLock | undefined> {
  if (!path.isAbsolute(options.path) || !Number.isSafeInteger(options.maxRunDurationMs) || options.maxRunDurationMs < 1) {
    throw new Error("organizer lock options are invalid");
  }
  const at = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(at.getTime())) throw new Error("organizer lock timestamp is invalid");
  const alive = options.isProcessAlive ?? processAlive;
  await mkdir(path.dirname(options.path), { recursive: true, mode: 0o700 });

  let observed: string | undefined;
  try { observed = await readFile(options.path, "utf8"); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const observedRecord = observed === undefined ? undefined : parseLock(observed);
  if (observedRecord && stale(observedRecord, at, options.maxRunDurationMs, alive)) {
    await options.onStaleObserved?.();
    if (await legacyGuardBlocks(options, at, alive)) return undefined;
  }

  const record: LockRecord = { pid: process.pid, startedAt: at.toISOString(), owner: randomUUID() };
  const lease = await claimLockCoordinator({
    lockPath: options.path,
    owner: record,
    isStale: (owner) => stale(owner, at, options.maxRunDurationMs, alive),
  });
  if (!lease) return undefined;
  record.generation = lease.generation;
  const content = JSON.stringify(record);
  let acquired = false;
  try {
    acquired = await acquirePrimary(options, content, lease, at, alive);
    if (!acquired) return undefined;
  } finally {
    if (!acquired) await releaseLockCoordinator(options.path, { ...record, generation: record.generation! });
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      let handle: FileHandle;
      try {
        handle = await open(options.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await releaseLockCoordinator(options.path, { ...record, generation: record.generation! });
          released = true;
          return;
        }
        throw error;
      }
      try {
        const current = await readHandle(handle);
        if (current.content !== content || !(await primaryPathStillNames(options.path, current.stat))) {
          throw new Error("organizer lock ownership changed");
        }
      } finally {
        await handle.close();
      }
      await unlink(options.path);
      await releaseLockCoordinator(options.path, { ...record, generation: record.generation! });
      released = true;
    },
  };
}
