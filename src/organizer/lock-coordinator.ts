import Database from "better-sqlite3";
import { chmod, lstat, open, type FileHandle } from "node:fs/promises";

export interface LockCoordinatorOwner {
  pid: number;
  startedAt: string;
  owner: string;
}

export interface LockCoordinatorLease {
  generation: number;
  previousWasStale: boolean;
}

interface CoordinatorRow {
  generation: number;
  state: "held" | "released";
  pid: number;
  started_at: string;
  owner: string;
}

function coordinatorPath(lockPath: string): string {
  return `${lockPath}.coordinator.sqlite`;
}

async function openCoordinator(lockPath: string): Promise<Database.Database> {
  const file = coordinatorPath(lockPath);
  let created: FileHandle | undefined;
  try {
    created = await open(file, "wx", 0o600);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await created?.close();
  }
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("organizer lock coordinator is unsafe");
  await chmod(file, 0o600);
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = DELETE");
    db.pragma("synchronous = FULL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS organizer_lock_coordinator (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        generation INTEGER NOT NULL CHECK(generation >= 0),
        state TEXT NOT NULL CHECK(state IN ('held', 'released')),
        pid INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        owner TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO organizer_lock_coordinator(singleton,generation,state,pid,started_at,owner)
      VALUES(1,0,'released',0,'','');
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function parseCoordinator(row: CoordinatorRow | undefined): CoordinatorRow {
  if (
    !row || !Number.isSafeInteger(row.generation) || row.generation < 0
    || !["held", "released"].includes(row.state)
    || !Number.isSafeInteger(row.pid) || typeof row.started_at !== "string" || typeof row.owner !== "string"
  ) throw new Error("organizer lock coordinator is invalid");
  if (row.state === "held" && (row.pid < 1 || !row.owner || !Number.isFinite(Date.parse(row.started_at)))) {
    throw new Error("organizer lock coordinator is invalid");
  }
  if (row.state === "released" && (row.pid !== 0 || row.started_at || row.owner)) {
    throw new Error("organizer lock coordinator is invalid");
  }
  return row;
}

export async function claimLockCoordinator(input: {
  lockPath: string;
  owner: LockCoordinatorOwner;
  isStale: (owner: LockCoordinatorOwner) => boolean;
}): Promise<LockCoordinatorLease | undefined> {
  const db = await openCoordinator(input.lockPath);
  try {
    return db.transaction(() => {
      const row = parseCoordinator(db.prepare("SELECT generation,state,pid,started_at,owner FROM organizer_lock_coordinator WHERE singleton=1").get() as CoordinatorRow | undefined);
      let previousWasStale = false;
      if (row.state === "held") {
        if (!input.isStale({ pid: row.pid, startedAt: row.started_at, owner: row.owner })) return undefined;
        previousWasStale = true;
      }
      const generation = row.generation + 1;
      const result = db.prepare(`
        UPDATE organizer_lock_coordinator
        SET generation=?,state='held',pid=?,started_at=?,owner=?
        WHERE singleton=1 AND generation=? AND state=? AND pid=? AND started_at=? AND owner=?
      `).run(generation, input.owner.pid, input.owner.startedAt, input.owner.owner, row.generation, row.state, row.pid, row.started_at, row.owner);
      return result.changes === 1 ? { generation, previousWasStale } : undefined;
    }).immediate();
  } finally {
    db.close();
  }
}

export async function releaseLockCoordinator(lockPath: string, owner: LockCoordinatorOwner & { generation: number }): Promise<void> {
  const db = await openCoordinator(lockPath);
  try {
    const released = db.transaction(() => db.prepare(`
      UPDATE organizer_lock_coordinator
      SET generation=generation+1,state='released',pid=0,started_at='',owner=''
      WHERE singleton=1 AND generation=? AND state='held' AND pid=? AND started_at=? AND owner=?
    `).run(owner.generation, owner.pid, owner.startedAt, owner.owner)).immediate();
    if (released.changes !== 1) throw new Error("organizer lock coordinator ownership changed");
  } finally {
    db.close();
  }
}
