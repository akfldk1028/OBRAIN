import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { BRAIN_FOUNDATION_POLICY } from "../foundation/policy.js";
import { assertInboxSource } from "./paths.js";

const DEFAULT_MAX_BYTES = 131_072;
const REVIEW_DIRECTORY = "검토필요";
const TEMPORARY_NAME = /(?:^|[._-])(?:tmp|temp|partial|part|swp|swo)(?:[._-]|$)/iu;

export interface InboxCandidate {
  path: string;
  absolutePath: string;
  hash: string;
  size: number;
  mtimeMs: number;
}

function isOutside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function normalizeDiskName(name: string): string | undefined {
  const normalized = name.normalize("NFKC");
  if (normalized.includes("/") || normalized.includes("\\")) return undefined;
  return normalized;
}

function shouldSkipDirectory(name: string): boolean {
  const normalized = normalizeDiskName(name);
  return normalized === undefined
    || normalized.startsWith(".")
    || normalized === REVIEW_DIRECTORY;
}

function shouldSkipFile(name: string): boolean {
  const normalized = normalizeDiskName(name);
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
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  return { nowMs, maxBytes };
}

export async function scanStableInbox(input: {
  root: string;
  minStableSeconds: number;
  nowMs?: number;
  maxBytes?: number;
}): Promise<InboxCandidate[]> {
  const { nowMs, maxBytes } = validateInput(input);
  const canonicalRoot = await realpath(input.root);
  const rootStat = await lstat(canonicalRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("scanner root is not a safe directory");
  }

  const inbox = path.join(canonicalRoot, BRAIN_FOUNDATION_POLICY.inbox);
  let inboxStat;
  try {
    inboxStat = await lstat(inbox);
  } catch (error: unknown) {
    if (isGone(error)) return [];
    throw error;
  }
  if (inboxStat.isSymbolicLink()) throw new Error("scanner Inbox is a symlink");
  if (!inboxStat.isDirectory()) throw new Error("scanner Inbox is not a directory");

  const canonicalInbox = await realpath(inbox);
  if (isOutside(canonicalRoot, canonicalInbox)) throw new Error("scanner Inbox escaped the vault root");

  const candidates: InboxCandidate[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const normalizedName = normalizeDiskName(entry.name);
      if (normalizedName === undefined) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, normalizedName);

      let stat;
      try {
        stat = await lstat(absolutePath);
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
        const canonicalDirectory = await realpath(absolutePath);
        if (
          isOutside(canonicalRoot, canonicalDirectory)
          || isOutside(canonicalInbox, canonicalDirectory)
        ) {
          continue;
        }
        await walk(canonicalDirectory, relativePath);
        continue;
      }

      if (!stat.isFile() || shouldSkipFile(entry.name)) continue;
      let sourcePath: string;
      try {
        sourcePath = assertInboxSource(relativePath);
      } catch {
        continue;
      }
      if (stat.size > maxBytes) continue;
      if (nowMs - stat.mtimeMs < input.minStableSeconds * 1_000) continue;

      const canonicalFile = await realpath(absolutePath);
      if (isOutside(canonicalRoot, canonicalFile) || isOutside(canonicalInbox, canonicalFile)) continue;
      const content = await readFile(canonicalFile);
      candidates.push({
        path: sourcePath,
        absolutePath: canonicalFile,
        hash: createHash("sha256").update(content).digest("hex"),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  };

  await walk(canonicalInbox, BRAIN_FOUNDATION_POLICY.inbox);
  return candidates.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
}
