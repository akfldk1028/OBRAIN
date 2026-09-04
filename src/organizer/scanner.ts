import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { BRAIN_FOUNDATION_POLICY } from "../foundation/policy.js";
import { assertInboxSource } from "./paths.js";

const DEFAULT_MAX_BYTES = 131_072;
const MAX_SUPPORTED_BYTES = 1_048_576;
const REVIEW_DIRECTORY = "검토필요";
const TEMPORARY_NAME = /(?:^|[._-])(?:tmp|temp|partial|part|swp|swo)(?:[._-]|$)/iu;

export interface InboxCandidate {
  path: string;
  absolutePath: string;
  hash: string;
  size: number;
  mtimeMs: number;
  /** Exact UTF-8 text read through the verified, byte-capped file handle. */
  content: string;
}

function isOutside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function normalizedDiskName(name: string): string | undefined {
  const normalized = name.normalize("NFKC");
  if (normalized.includes("/") || normalized.includes("\\")) return undefined;
  return normalized;
}

function shouldSkipDirectory(name: string): boolean {
  const normalized = normalizedDiskName(name);
  return normalized === undefined
    || normalized.startsWith(".")
    || normalized === REVIEW_DIRECTORY;
}

function shouldSkipFile(name: string): boolean {
  const normalized = normalizedDiskName(name);
  if (normalized === undefined || normalized.startsWith(".")) return true;
  const lower = normalized.toLocaleLowerCase("en-US");
  return lower.includes("sync-conflict")
    || lower.startsWith("~")
    || lower.endsWith("~")
    || TEMPORARY_NAME.test(lower);
}

function validateInput(input: {
  minStableSeconds: number;
  nowMs?: number;
  maxBytes?: number;
}): { nowMs: number; maxBytes: number } {
  const nowMs = input.nowMs ?? Date.now();
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(input.minStableSeconds) || input.minStableSeconds < 0) {
    throw new Error("minStableSeconds must be a non-negative finite number");
  }
  if (!Number.isFinite(nowMs)) throw new Error("nowMs must be finite");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SUPPORTED_BYTES) {
    throw new Error(`maxBytes must be an integer from 1 through ${MAX_SUPPORTED_BYTES}`);
  }
  return { nowMs, maxBytes };
}

interface DiscoveredFile {
  sourcePath: string;
  absolutePath: string;
  stat: BigIntStats;
  lineage: readonly BoundDirectory[];
}

function collisionKey(value: string): string {
  return value.normalize("NFKC").replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

function hasIdentity(stat: BigIntStats): boolean {
  return stat.dev !== 0n || stat.ino !== 0n;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  if (!hasIdentity(left) && !hasIdentity(right)) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile()
    && right.isFile()
    && sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function sameDirectorySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

class PathResolutionRaceError extends Error {}

interface BoundDirectory {
  pathname: string;
  canonicalPath: string;
  snapshot: BigIntStats;
  label: string;
}

function isStrictlyInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function resolveBoundDirectory(
  pathname: string,
  before: BigIntStats,
  label: string,
  parent?: BoundDirectory,
): Promise<BoundDirectory> {
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new PathResolutionRaceError(`${label} is not a safe directory`);
  }
  const canonicalPath = await realpath(pathname);
  const after = await lstat(pathname, { bigint: true });
  const resolved = await lstat(canonicalPath, { bigint: true });
  if (
    after.isSymbolicLink()
    || !sameDirectorySnapshot(before, after)
    || !sameDirectorySnapshot(before, resolved)
    || (parent !== undefined && !isStrictlyInside(parent.canonicalPath, canonicalPath))
  ) {
    throw new PathResolutionRaceError(`${label} changed or became a symlink during resolution`);
  }
  return { pathname, canonicalPath, snapshot: before, label };
}

class DirectoryLineageError extends Error {
  constructor(message: string, readonly critical: boolean) {
    super(message);
  }
}

async function revalidateDirectoryLineage(lineage: readonly BoundDirectory[]): Promise<void> {
  let currentParent: BoundDirectory | undefined;
  for (const [index, original] of lineage.entries()) {
    try {
      const before = await lstat(original.pathname, { bigint: true });
      const current = await resolveBoundDirectory(
        original.pathname,
        before,
        original.label,
        currentParent,
      );
      if (
        current.canonicalPath !== original.canonicalPath
        || !sameDirectorySnapshot(original.snapshot, current.snapshot)
      ) {
        throw new PathResolutionRaceError(`${original.label} no longer names its bound directory`);
      }
      currentParent = current;
    } catch (error: unknown) {
      if (!(error instanceof PathResolutionRaceError) && !raceDisappeared(error)) throw error;
      throw new DirectoryLineageError(
        `${original.label} changed or became a symlink after resolution`,
        index < 2,
      );
    }
  }
}

interface BoundFilePath {
  canonicalPath: string;
  after: BigIntStats;
  resolved: BigIntStats;
}

async function resolveBoundFile(
  pathname: string,
  before: BigIntStats,
  label: string,
): Promise<BoundFilePath> {
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new PathResolutionRaceError(`${label} is not a safe file`);
  }
  const canonicalPath = await realpath(pathname);
  const after = await lstat(pathname, { bigint: true });
  const resolved = await lstat(canonicalPath, { bigint: true });
  if (
    after.isSymbolicLink()
    || !sameSnapshot(before, after)
    || !sameSnapshot(before, resolved)
  ) {
    throw new PathResolutionRaceError(`${label} changed or became a symlink during resolution`);
  }
  return { canonicalPath, after, resolved };
}

async function readAtMost(handle: FileHandle, byteLimit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(byteLimit);
  let offset = 0;
  while (offset < byteLimit) {
    const { bytesRead } = await handle.read(buffer, offset, byteLimit - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function raceDisappeared(error: unknown): boolean {
  return ["ELOOP", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export async function scanStableInbox(input: {
  root: string;
  minStableSeconds: number;
  nowMs?: number;
  maxBytes?: number;
  state?: "ready" | "review";
}): Promise<InboxCandidate[]> {
  const { nowMs, maxBytes } = validateInput(input);
  const suppliedRootStat = await lstat(input.root, { bigint: true });
  if (suppliedRootStat.isSymbolicLink()) throw new Error("scanner root is a symlink");
  if (!suppliedRootStat.isDirectory()) throw new Error("scanner root is not a directory");
  const root = await resolveBoundDirectory(input.root, suppliedRootStat, "scanner root");

  const inboxPath = path.join(root.canonicalPath, BRAIN_FOUNDATION_POLICY.inbox);
  let inboxStat;
  try {
    inboxStat = await lstat(inboxPath, { bigint: true });
  } catch (error: unknown) {
    if (isGone(error)) return [];
    throw error;
  }
  if (inboxStat.isSymbolicLink()) throw new Error("scanner Inbox is a symlink");
  if (!inboxStat.isDirectory()) throw new Error("scanner Inbox is not a directory");

  const inbox = await resolveBoundDirectory(inboxPath, inboxStat, "scanner Inbox", root);
  if (isOutside(root.canonicalPath, inbox.canonicalPath)) {
    throw new Error("scanner Inbox escaped the vault root");
  }

  let scanBase = inbox;
  let scanRelative: string = BRAIN_FOUNDATION_POLICY.inbox;
  let scanLineage: readonly BoundDirectory[] = [root, inbox];
  if (input.state === "review") {
    const reviewPath = path.join(inbox.canonicalPath, REVIEW_DIRECTORY);
    let reviewStat: BigIntStats;
    try {
      reviewStat = await lstat(reviewPath, { bigint: true });
    } catch (error: unknown) {
      if (isGone(error)) return [];
      throw error;
    }
    const review = await resolveBoundDirectory(reviewPath, reviewStat, "scanner review directory", inbox);
    if (isOutside(inbox.canonicalPath, review.canonicalPath)) throw new Error("scanner review directory escaped the Inbox");
    scanBase = review;
    scanRelative = `${BRAIN_FOUNDATION_POLICY.inbox}/${REVIEW_DIRECTORY}`;
    scanLineage = [root, inbox, review];
  }

  const discovered: DiscoveredFile[] = [];
  const walk = async (
    directory: BoundDirectory,
    relativeDirectory: string,
    lineage: readonly BoundDirectory[],
  ): Promise<void> => {
    try {
      await revalidateDirectoryLineage(lineage);
    } catch (error: unknown) {
      if (error instanceof DirectoryLineageError && !error.critical) return;
      throw error;
    }

    const entries = await readdir(directory.canonicalPath, { withFileTypes: true });
    for (const entry of entries) {
      if (normalizedDiskName(entry.name) === undefined) continue;
      const absolutePath = path.join(directory.canonicalPath, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);

      let stat;
      try {
        stat = await lstat(absolutePath, { bigint: true });
      } catch (error: unknown) {
        if (isGone(error)) continue;
        throw error;
      }
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) continue;
        try {
          assertInboxSource(path.posix.join(relativePath, "scan.md"));
        } catch {
          continue;
        }
        let child: BoundDirectory;
        try {
          child = await resolveBoundDirectory(
            absolutePath,
            stat,
            `scanner directory ${relativePath}`,
            directory,
          );
        } catch (error: unknown) {
          if (error instanceof PathResolutionRaceError || raceDisappeared(error)) continue;
          throw error;
        }
        if (
          isOutside(root.canonicalPath, child.canonicalPath)
          || isOutside(scanBase.canonicalPath, child.canonicalPath)
        ) {
          continue;
        }
        await walk(child, relativePath, [...lineage, child]);
        continue;
      }

      if (!stat.isFile() || shouldSkipFile(entry.name)) continue;
      let sourcePath: string;
      try {
        sourcePath = assertInboxSource(relativePath);
      } catch {
        continue;
      }
      let canonicalFile: string;
      try {
        canonicalFile = (await resolveBoundFile(
          absolutePath,
          stat,
          `scanner file ${sourcePath}`,
        )).canonicalPath;
      } catch (error: unknown) {
        if (error instanceof PathResolutionRaceError || raceDisappeared(error)) continue;
        throw error;
      }
      if (
        !isStrictlyInside(directory.canonicalPath, canonicalFile)
        || isOutside(root.canonicalPath, canonicalFile)
        || isOutside(scanBase.canonicalPath, canonicalFile)
      ) {
        continue;
      }
      discovered.push({ sourcePath, absolutePath: canonicalFile, stat, lineage });
    }

    try {
      await revalidateDirectoryLineage(lineage);
    } catch (error: unknown) {
      if (error instanceof DirectoryLineageError && !error.critical) return;
      throw error;
    }
  };

  const rootInboxLineage = scanLineage;
  await walk(scanBase, scanRelative, rootInboxLineage);
  const inventory = new Map<string, string>();
  for (const file of discovered) {
    const key = collisionKey(file.sourcePath);
    const prior = inventory.get(key);
    if (prior !== undefined && prior !== file.sourcePath) {
      throw new Error(`scanner Inbox path is ambiguous: ${prior} and ${file.sourcePath}`);
    }
    inventory.set(key, file.sourcePath);
  }

  const candidates: Array<{ candidate: InboxCandidate; lineage: readonly BoundDirectory[] }> = [];
  for (const file of discovered) {
    if (file.stat.size > BigInt(maxBytes)) continue;
    const mtimeMs = Number(file.stat.mtimeNs) / 1_000_000;
    if (nowMs - mtimeMs < input.minStableSeconds * 1_000) continue;

    let handle: FileHandle;
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0;
      handle = await open(file.absolutePath, constants.O_RDONLY | noFollow);
    } catch (error: unknown) {
      if (raceDisappeared(error)) continue;
      throw error;
    }

    try {
      const openedStat = await handle.stat({ bigint: true });
      if (!sameSnapshot(file.stat, openedStat) || openedStat.size > BigInt(maxBytes)) continue;

      const content = await readAtMost(handle, maxBytes + 1);
      const finalHandleStat = await handle.stat({ bigint: true });
      let finalPathBefore: BigIntStats;
      let finalBoundPath: BoundFilePath;
      try {
        finalPathBefore = await lstat(file.absolutePath, { bigint: true });
        finalBoundPath = await resolveBoundFile(
          file.absolutePath,
          finalPathBefore,
          `scanner final file ${file.sourcePath}`,
        );
      } catch (error: unknown) {
        if (error instanceof PathResolutionRaceError || raceDisappeared(error)) continue;
        throw error;
      }
      if (
        content.length > maxBytes
        || !sameSnapshot(file.stat, finalHandleStat)
        || !sameSnapshot(file.stat, finalPathBefore)
        || !sameSnapshot(file.stat, finalBoundPath.after)
        || !sameSnapshot(file.stat, finalBoundPath.resolved)
        || isOutside(root.canonicalPath, finalBoundPath.canonicalPath)
        || isOutside(scanBase.canonicalPath, finalBoundPath.canonicalPath)
      ) {
        continue;
      }

      try {
        await revalidateDirectoryLineage(file.lineage);
      } catch (error: unknown) {
        if (error instanceof DirectoryLineageError && !error.critical) continue;
        throw error;
      }

      candidates.push({
        lineage: file.lineage,
        candidate: {
          path: file.sourcePath,
          absolutePath: file.absolutePath,
          hash: createHash("sha256").update(content).digest("hex"),
          size: Number(file.stat.size),
          mtimeMs,
          content: decodeExactUtf8(content),
        },
      });
    } finally {
      await handle.close();
    }
  }

  const finalCandidates: InboxCandidate[] = [];
  for (const accepted of candidates) {
    try {
      await revalidateDirectoryLineage(accepted.lineage);
    } catch (error: unknown) {
      if (error instanceof DirectoryLineageError && !error.critical) continue;
      throw error;
    }
    finalCandidates.push(accepted.candidate);
  }
  await revalidateDirectoryLineage(rootInboxLineage);
  return finalCandidates.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
}

function decodeExactUtf8(content: Buffer): string {
  const decoded = content.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(content)) {
    throw new Error("scanner source is not valid UTF-8");
  }
  return decoded;
}
