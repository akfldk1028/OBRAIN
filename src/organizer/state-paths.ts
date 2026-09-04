import { chmod, lstat, mkdir, rename } from "node:fs/promises";
import path from "node:path";

export interface OrganizerStatePaths {
  root: string;
  database: string;
  recovery: string;
  lock: string;
}

const SQLITE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

async function exists(pathname: string): Promise<boolean> {
  try {
    await lstat(pathname);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertRegularFile(pathname: string, label: string): Promise<void> {
  const info = await lstat(pathname);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is unsafe`);
}

async function assertDirectory(pathname: string, label: string): Promise<void> {
  const info = await lstat(pathname);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is unsafe`);
}

export async function prepareOrganizerStatePaths(dataDirectory: string): Promise<OrganizerStatePaths> {
  const dataDir = path.resolve(dataDirectory);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await assertDirectory(dataDir, "organizer data directory");

  const root = path.join(dataDir, "organizer");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertDirectory(root, "organizer state directory");

  const database = path.join(root, "organizer.sqlite");
  const recovery = path.join(root, "transactions");
  const lock = path.join(root, "organizer.lock");
  const legacyDatabase = path.join(dataDir, "organizer.sqlite");
  const legacyRecovery = path.join(dataDir, "organizer-recovery");
  const legacyFiles = SQLITE_SUFFIXES.map((suffix) => `${legacyDatabase}${suffix}`);
  const targetFiles = SQLITE_SUFFIXES.map((suffix) => `${database}${suffix}`);
  const legacyPresence = await Promise.all(legacyFiles.map(exists));
  const targetPresence = await Promise.all(targetFiles.map(exists));
  const hasLegacyDatabaseState = legacyPresence.some(Boolean);
  const hasTargetDatabaseState = targetPresence.some(Boolean);

  if (legacyPresence.slice(1).some(Boolean) && !legacyPresence[0]) {
    throw new Error("organizer state migration conflict: legacy SQLite sidecar has no database");
  }
  if (targetPresence.slice(1).some(Boolean) && !targetPresence[0]) {
    throw new Error("organizer state migration conflict: target SQLite sidecar has no database");
  }
  if (hasLegacyDatabaseState && hasTargetDatabaseState) {
    throw new Error("organizer state migration conflict: legacy and target databases both exist");
  }
  for (const [index, present] of legacyPresence.entries()) {
    if (present) await assertRegularFile(legacyFiles[index]!, "legacy organizer database state");
  }
  for (const [index, present] of targetPresence.entries()) {
    if (present) await assertRegularFile(targetFiles[index]!, "target organizer database state");
  }

  const hasLegacyRecovery = await exists(legacyRecovery);
  const hasTargetRecovery = await exists(recovery);
  if (hasLegacyRecovery) await assertDirectory(legacyRecovery, "legacy organizer recovery directory");
  if (hasTargetRecovery) await assertDirectory(recovery, "target organizer recovery directory");
  if (hasLegacyRecovery && hasTargetRecovery) {
    throw new Error("organizer state migration conflict: legacy and target recovery directories both exist");
  }

  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const [index, present] of legacyPresence.entries()) {
      if (!present) continue;
      await rename(legacyFiles[index]!, targetFiles[index]!);
      moved.push({ from: targetFiles[index]!, to: legacyFiles[index]! });
    }
    if (hasLegacyRecovery) {
      await rename(legacyRecovery, recovery);
      moved.push({ from: recovery, to: legacyRecovery });
    } else if (!hasTargetRecovery) {
      await mkdir(recovery, { mode: 0o700 });
    }
    await assertDirectory(recovery, "organizer recovery directory");
    await chmod(root, 0o700);
    await chmod(recovery, 0o700);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const move of moved.reverse()) {
      try { await rename(move.from, move.to); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "organizer state migration and rollback failed");
    throw error;
  }

  return { root, database, recovery, lock };
}
