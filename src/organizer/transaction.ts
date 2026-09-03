import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { validateGeneratedCanvas, type JsonCanvas } from "../foundation/canvas.js";
import { BRAIN_FOUNDATION_POLICY, areaCanvasPath, areaMocPath } from "../foundation/policy.js";
import { replaceManagedMocIndex } from "./managed-moc.js";
import { assertApprovedDestination, assertInboxSource } from "./paths.js";
import { OrganizerStore } from "./store.js";
import type { StoredProposal, TransactionRecord } from "./types.js";

const MAX_MANIFEST_BYTES = 65_536;
const MAX_REPORT_BYTES = 4_096;
const MAX_ARTIFACT_BYTES = 2_097_152;
const MAX_MANAGED_REPLACEMENTS = 32;
const COMPONENT_BYTES = 240;
const PATH_BYTES = 1_024;
const ID_BYTES = 160;
const VAULT_BYTES = 256;
const HASH = /^[a-f0-9]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const WINDOWS_INVALID = /[:<>"|?*]/u;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const MOC_START = "<!-- brain-auto:start note-index -->";
const MOC_END = "<!-- brain-auto:end note-index -->";
const MOC_TARGETS = new Set(BRAIN_FOUNDATION_POLICY.areas.map(areaMocPath));
const CANVAS_TO_MOC = new Map(BRAIN_FOUNDATION_POLICY.areas.map((area) => [areaCanvasPath(area), areaMocPath(area)]));

const boundedText = (min: number, max: number) => z.string().min(min).max(max).refine(
  (value) => Buffer.byteLength(value, "utf8") <= max,
  "text exceeds UTF-8 limit",
);
const identifier = z.string().min(1).max(ID_BYTES).regex(/^ORG-[A-Za-z0-9_-]+$/u).refine(
  (value) => Buffer.byteLength(value, "utf8") <= ID_BYTES,
  "identifier exceeds UTF-8 limit",
);
const hashSchema = z.string().regex(HASH);
const relativePathSchema = boundedText(1, PATH_BYTES);
const modeSchema = z.number().int().min(0).max(0o777);
const timestampSchema = boundedText(1, 64).refine(
  (value) => z.string().datetime({ offset: true }).safeParse(value).success && Number.isFinite(Date.parse(value)),
  "invalid timestamp",
);

const managedSnapshotSchema = z.object({
  relativePath: relativePathSchema,
  snapshotFile: boundedText(1, 128),
  beforeHash: hashSchema,
  afterHash: hashSchema,
  mode: modeSchema,
}).strict();

const undoSnapshotSchema = z.object({
  destinationSnapshotFile: boundedText(1, 128),
  destinationMode: modeSchema,
  managed: z.array(z.object({
    relativePath: relativePathSchema,
    snapshotFile: boundedText(1, 128),
    hash: hashSchema,
    mode: modeSchema,
  }).strict()).max(MAX_MANAGED_REPLACEMENTS),
}).strict();

const manifestSchema = z.object({
  version: z.literal(1),
  id: identifier,
  proposalId: boundedText(1, ID_BYTES),
  proposalHash: hashSchema,
  vault: boundedText(1, VAULT_BYTES),
  vaultRoot: boundedText(1, PATH_BYTES * 2),
  sourcePath: relativePathSchema,
  destinationPath: relativePathSchema,
  sourceSnapshotFile: z.literal("original.md"),
  sourceHash: hashSchema,
  sourceMode: modeSchema,
  destinationHash: hashSchema,
  destinationOwned: z.boolean(),
  appliedAt: timestampSchema,
  undoneAt: timestampSchema.optional(),
  managed: z.array(managedSnapshotSchema).max(MAX_MANAGED_REPLACEMENTS),
  state: z.enum(["prepared", "vault_applied", "committed", "rolled_back", "undo_prepared", "undo_vault_applied", "undone"]),
  undo: undoSnapshotSchema.optional(),
}).strict();

type RecoveryManifest = z.infer<typeof manifestSchema>;

const recoveryReportSchema = z.object({
  version: z.literal(1),
  id: identifier,
  outcome: z.enum(["rolled_back", "committed", "undo_rolled_back", "undone"]),
  at: timestampSchema,
}).strict();

export interface ManagedReplacement {
  relativePath: string;
  expectedHash: string;
  content: string;
}

export interface TransactionPlan {
  id: string;
  proposal: StoredProposal;
  vaultRoot: string;
  destinationContent: string;
  managedReplacements: ManagedReplacement[];
}

export type TransactionEventName =
  | "after_source_snapshot_sync"
  | "after_managed_snapshot_sync"
  | "after_manifest_sync"
  | "manifest_directory_synced"
  | "recovery_component_created"
  | "recovery_parent_synced"
  | "before_destination_publish"
  | "before_destination_link"
  | "before_destination_chmod"
  | "before_destination_directory_sync"
  | "before_destination_temp_unlink"
  | "before_destination_ownership_persist"
  | "destination_published"
  | "before_managed_publish"
  | "managed_temp_synced"
  | "managed_published"
  | "before_source_unlink"
  | "source_removed"
  | "before_database_commit"
  | "database_committed"
  | "recovery_destination_removed"
  | "before_recovery_destination_unlink"
  | "recovery_managed_restored"
  | "recovery_source_restored"
  | "before_undo_recovery_destination_publish"
  | "undo_recovery_destination_restored"
  | "before_undo_recovery_managed_publish"
  | "undo_recovery_managed_restored"
  | "before_undo_recovery_source_unlink"
  | "undo_recovery_source_removed"
  | "after_bound_handle_read"
  | "recovery_destination_ownership_persisted"
  | "recovery_destination_ownership_inferred"
  | "recovery_destination_proof_removed"
  | "after_undo_managed_publish"
  | "after_undo_source_publish"
  | "after_undo_destination_remove"
  | "before_undo_database_commit"
  | "undo_database_committed";

export interface TransactionEvent {
  name: TransactionEventName;
  managedIndex?: number;
  operation?:
    | "apply_managed_rename"
    | "apply_source_unlink"
    | "undo_managed_rename"
    | "undo_destination_unlink"
    | "recovery_managed_rename"
    | "recovery_destination_unlink"
    | "undo_recovery_managed_rename"
    | "undo_recovery_source_unlink";
}

export interface RecoveryReport {
  version: 1;
  id: string;
  outcome: "rolled_back" | "committed" | "undo_rolled_back" | "undone";
  at: string;
}

export interface RecoveryCleanupInput {
  now: string;
  backupVerified: boolean;
}

export interface OrganizerTransactionEngineOptions {
  recoveryRoot: string;
  store: OrganizerStore;
  now?: () => string;
  onEvent?: (event: TransactionEvent) => void | Promise<void>;
}

class StaleSourceError extends Error {}
class TransactionConflictError extends Error {}
class TransactionValidationError extends Error {}

interface BoundDirectory {
  pathname: string;
  canonicalPath: string;
  stat: BigIntStats;
  parent?: BoundDirectory;
}

interface BoundFile {
  relativePath: string;
  absolutePath: string;
  canonicalPath: string;
  parent: BoundDirectory;
  stat: BigIntStats;
  content: Buffer;
  hash: string;
  mode: number;
}

interface PreparedApply {
  root: BoundDirectory;
  source: BoundFile;
  requiredMoc: BoundFile;
  destinationParent: BoundDirectory;
  destinationAbsolute: string;
  managed: Array<{ replacement: ManagedReplacement; file: BoundFile; afterHash: string }>;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function proposalRecoveryHash(proposal: StoredProposal): string {
  return digest(JSON.stringify({ ...proposal, status: "pending" }));
}

function collisionKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function isOutside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  if ((left.dev === 0n && left.ino === 0n) || (right.dev === 0n && right.ino === 0n)) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function provableIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return !(left.dev === 0n && left.ino === 0n) && !(right.dev === 0n && right.ino === 0n)
    && left.dev === right.dev && left.ino === right.ino;
}

function exactFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && sameIdentity(left, right)
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function safeMode(statValue: BigIntStats): number {
  return Number(statValue.mode & 0o777n);
}

function validateRelativePath(value: string, extension?: ".md" | ".canvas"): string {
  if (
    !value
    || value.includes("\\")
    || path.isAbsolute(value)
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || CONTROL.test(value)
    || Buffer.byteLength(value, "utf8") > PATH_BYTES
    || Buffer.byteLength(value.normalize("NFKC"), "utf8") > PATH_BYTES
  ) throw new TransactionValidationError("transaction path is unsafe or exceeds the byte limit");
  const segments = value.split("/");
  if (segments.some((segment) => (
    !segment || segment === "." || segment === ".." || segment.startsWith(".")
    || WINDOWS_INVALID.test(segment) || /[ .]$/u.test(segment) || WINDOWS_RESERVED.test(segment)
    || segment.normalize("NFKC").includes("/") || segment.normalize("NFKC").includes("\\")
  ))) throw new TransactionValidationError("transaction path is unsafe");
  if (segments.some((segment) => (
    Buffer.byteLength(segment, "utf8") > COMPONENT_BYTES
    || Buffer.byteLength(segment.normalize("NFKC"), "utf8") > COMPONENT_BYTES
  ))) throw new TransactionValidationError("transaction path component exceeds the UTF-8 byte limit");
  if (segments.length - 1 > BRAIN_FOUNDATION_POLICY.maxDepth) throw new TransactionValidationError("transaction path exceeds maximum depth");
  if (extension && path.posix.extname(value).toLocaleLowerCase("en-US") !== extension) {
    throw new TransactionValidationError(`transaction path must end in ${extension}`);
  }
  return value;
}

function validateSnapshotFile(value: string): string {
  if (!/^(?:original\.md|managed-\d{3}\.snapshot|undo-destination\.snapshot|undo-managed-\d{3}\.snapshot)$/u.test(value)) {
    throw new TransactionValidationError("recovery snapshot filename is invalid");
  }
  return value;
}

async function emit(options: OrganizerTransactionEngineOptions, event: TransactionEvent): Promise<void> {
  await options.onEvent?.(event);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !["EACCES", "EBADF", "EINVAL", "EISDIR", "EPERM"].includes(code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

async function writeSyncedExclusive(file: string, content: string | Buffer, mode = 0o600): Promise<BigIntStats> {
  const handle = await open(file, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.chmod(mode);
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new TransactionValidationError("synced exclusive file changed identity");
    return info;
  } finally {
    await handle.close();
  }
}

async function writeAtomic(
  file: string,
  content: string | Buffer,
  mode: number,
  input: {
    tempPath?: string;
    afterTempSync?: () => Promise<void>;
    beforeRename?: () => Promise<void>;
  } = {},
): Promise<void> {
  const directory = path.dirname(file);
  const temp = input.tempPath ?? recoveryAtomicTemp(directory, path.basename(file));
  if (path.dirname(temp) !== directory) throw new TransactionValidationError("atomic temporary file must share the target directory");
  let tempStat: BigIntStats | undefined;
  try {
    tempStat = await writeSyncedExclusive(temp, content, mode);
    await input.afterTempSync?.();
    await input.beforeRename?.();
    await rename(temp, file);
    await chmod(file, mode);
    await syncDirectory(directory);
  } catch (error: unknown) {
    try {
      const current = await lstat(temp, { bigint: true });
      if (!tempStat || !exactFileSnapshot(tempStat, current)) {
        throw new TransactionValidationError("atomic temporary cleanup target changed identity");
      }
      await unlink(temp);
      await syncDirectory(directory);
    } catch (cleanupError: unknown) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError([error, cleanupError], "atomic publication and temporary cleanup failed");
      }
    }
    throw error;
  }
}

function recoveryAtomicTemp(directory: string, filename: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(filename)) throw new TransactionValidationError("atomic target filename is invalid");
  const owner = path.basename(directory);
  if (!identifier.safeParse(owner).success) throw new TransactionValidationError("atomic recovery directory owner is invalid");
  return path.join(directory, `.brain-organizer-${owner}-${filename}.tmp`);
}

async function discardAtomicRecoveryTemp(
  directory: string,
  filename: string,
  maxBytes: number,
  validate?: (content: Buffer) => void | Promise<void>,
): Promise<void> {
  const temp = recoveryAtomicTemp(directory, filename);
  let info: BigIntStats;
  try { info = await lstat(temp, { bigint: true }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new TransactionValidationError("atomic recovery temporary file is unsafe");
  assertPrivateMode(info, 0o600, "atomic recovery temporary file");
  const content = await readBoundedFile(temp, maxBytes);
  await validate?.(content);
  const current = await lstat(temp, { bigint: true });
  if (!exactFileSnapshot(info, current)) throw new TransactionValidationError("atomic recovery temporary file changed identity");
  await unlink(temp);
  await syncDirectory(directory);
}

async function readBoundedFile(file: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(file, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maxBytes)) {
    throw new TransactionValidationError("transaction file is unsafe or exceeds the byte limit");
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!exactFileSnapshot(before, opened)) throw new TransactionValidationError("transaction file changed during read");
    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== buffer.length || !exactFileSnapshot(before, after)) throw new TransactionValidationError("transaction file changed during read");
    return buffer;
  } finally {
    await handle.close();
  }
}

async function bindRoot(rootPath: string): Promise<BoundDirectory> {
  if (!path.isAbsolute(rootPath) || Buffer.byteLength(rootPath, "utf8") > PATH_BYTES * 2) {
    throw new TransactionValidationError("vault root must be a bounded absolute path");
  }
  const before = await lstat(rootPath, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) throw new TransactionValidationError("vault root is not a safe directory");
  const canonicalPath = await realpath(rootPath);
  const after = await lstat(rootPath, { bigint: true });
  const canonicalStat = await lstat(canonicalPath, { bigint: true });
  if (!sameIdentity(before, after) || !sameIdentity(before, canonicalStat)) throw new TransactionValidationError("vault root identity changed");
  return { pathname: rootPath, canonicalPath, stat: before };
}

async function exactEntry(parent: BoundDirectory, wanted: string, allowMissing: boolean): Promise<string | undefined> {
  const entries = await readdir(parent.canonicalPath);
  const matches = entries.filter((entry) => collisionKey(entry) === collisionKey(wanted));
  if (matches.length > 1) throw new TransactionValidationError("filesystem identity is ambiguous");
  if (matches.length === 0) {
    if (allowMissing) return undefined;
    throw new TransactionValidationError("filesystem path does not exist");
  }
  if (matches[0] !== wanted) {
    throw new TransactionValidationError("filesystem path does not have exact spelling");
  }
  return matches[0];
}

async function bindChildDirectory(parent: BoundDirectory, segment: string): Promise<BoundDirectory> {
  await exactEntry(parent, segment, false);
  const pathname = path.join(parent.canonicalPath, segment);
  const before = await lstat(pathname, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) throw new TransactionValidationError("transaction parent is a symlink or not a directory");
  const canonicalPath = await realpath(pathname);
  const after = await lstat(pathname, { bigint: true });
  const canonicalStat = await lstat(canonicalPath, { bigint: true });
  if (isOutside(parent.canonicalPath, canonicalPath) || !sameIdentity(before, after) || !sameIdentity(before, canonicalStat)) {
    throw new TransactionValidationError("transaction parent escaped or changed identity");
  }
  return { pathname, canonicalPath, stat: before, parent };
}

async function bindDirectory(root: BoundDirectory, relative: string): Promise<BoundDirectory> {
  validateRelativePath(`${relative}/placeholder.md`, ".md");
  let current = root;
  for (const segment of relative.split("/")) current = await bindChildDirectory(current, segment);
  return current;
}

async function revalidateDirectory(directory: BoundDirectory): Promise<void> {
  const lineage: BoundDirectory[] = [];
  let current: BoundDirectory | undefined = directory;
  while (current) { lineage.push(current); current = current.parent; }
  for (const bound of lineage.reverse()) {
    const currentStat = await lstat(bound.pathname, { bigint: true });
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory() || !sameIdentity(bound.stat, currentStat)) {
      throw new TransactionValidationError("transaction directory lineage changed identity");
    }
    const canonical = await realpath(bound.pathname);
    if (canonical !== bound.canonicalPath) throw new TransactionValidationError("transaction directory lineage changed canonical path");
    if (bound.parent && isOutside(bound.parent.canonicalPath, canonical)) throw new TransactionValidationError("transaction directory lineage escaped vault");
  }
}

async function bindFile(root: BoundDirectory, relativePath: string, maxBytes = MAX_ARTIFACT_BYTES): Promise<BoundFile> {
  validateRelativePath(relativePath);
  const segments = relativePath.split("/");
  const filename = segments.pop()!;
  const parent = await bindDirectory(root, segments.join("/"));
  await exactEntry(parent, filename, false);
  const absolutePath = path.join(parent.canonicalPath, filename);
  const statValue = await lstat(absolutePath, { bigint: true });
  if (statValue.isSymbolicLink() || !statValue.isFile()) throw new TransactionValidationError("transaction target is a symlink or not a file");
  const canonical = await realpath(absolutePath);
  if (isOutside(parent.canonicalPath, canonical)) throw new TransactionValidationError("transaction file escaped its parent");
  const content = await readBoundedFile(absolutePath, maxBytes);
  const after = await lstat(absolutePath, { bigint: true });
  if (!exactFileSnapshot(statValue, after)) throw new TransactionValidationError("transaction file changed while binding");
  return { relativePath, absolutePath, canonicalPath: canonical, parent, stat: statValue, content, hash: digest(content), mode: safeMode(statValue) };
}

async function revalidateFile(
  file: BoundFile,
  expectedHash: string,
  input?: { options: OrganizerTransactionEngineOptions; operation: NonNullable<TransactionEvent["operation"]>; managedIndex?: number },
): Promise<void> {
  await revalidateDirectory(file.parent);
  await exactEntry(file.parent, path.basename(file.absolutePath), false);
  const before = await lstat(file.absolutePath, { bigint: true });
  if (!exactFileSnapshot(file.stat, before)) throw new TransactionValidationError("transaction file identity changed");
  const handle = await open(file.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let content: Buffer;
  let opened: BigIntStats;
  try {
    opened = await handle.stat({ bigint: true });
    if (!exactFileSnapshot(file.stat, opened) || opened.size > BigInt(MAX_ARTIFACT_BYTES)) {
      throw new TransactionValidationError("transaction file changed before bound read");
    }
    content = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    if (offset !== content.length || !exactFileSnapshot(opened, afterRead) || digest(content) !== expectedHash) {
      throw new TransactionValidationError("transaction file changed during bound read or hash validation");
    }
    if (input) await emit(input.options, {
      name: "after_bound_handle_read",
      operation: input.operation,
      ...(input.managedIndex === undefined ? {} : { managedIndex: input.managedIndex }),
    });
  } finally {
    await handle.close();
  }
  await revalidateDirectory(file.parent);
  const pathnameBefore = await lstat(file.absolutePath, { bigint: true });
  const resolved = await realpath(file.absolutePath);
  const pathnameAfter = await lstat(file.absolutePath, { bigint: true });
  const canonicalStat = await lstat(resolved, { bigint: true });
  const expectedPath = path.join(file.parent.canonicalPath, path.basename(file.absolutePath));
  if (
    expectedPath !== file.absolutePath || resolved !== file.canonicalPath
    || !exactFileSnapshot(file.stat, pathnameBefore)
    || !exactFileSnapshot(file.stat, pathnameAfter)
    || !exactFileSnapshot(file.stat, canonicalStat)
    || !exactFileSnapshot(opened, pathnameBefore)
    || !exactFileSnapshot(opened, pathnameAfter)
    || !exactFileSnapshot(opened, canonicalStat)
  ) throw new TransactionValidationError("transaction pathname changed identity or canonical target");
}

async function revalidateSource(
  file: BoundFile,
  expectedHash: string,
  input?: { options: OrganizerTransactionEngineOptions; operation: "apply_source_unlink" },
): Promise<void> {
  try {
    await revalidateFile(file, expectedHash, input);
  } catch {
    throw new StaleSourceError("source is stale or changed concurrently");
  }
}

async function assertDestinationAbsent(
  parent: BoundDirectory,
  filename: string,
  message = "destination collision: file already exists",
): Promise<void> {
  await revalidateDirectory(parent);
  const matches = (await readdir(parent.canonicalPath)).filter((entry) => collisionKey(entry) === collisionKey(filename));
  if (matches.length) throw new TransactionConflictError(message);
}

function parseCanvas(content: Buffer | string, label: string): JsonCanvas {
  let value: unknown;
  try { value = JSON.parse(content.toString()); }
  catch { throw new TransactionValidationError(`${label} Canvas is invalid JSON`); }
  if (!validateGeneratedCanvas(value)) throw new TransactionValidationError(`${label} Canvas is invalid`);
  return value;
}

async function validateCanvasReferences(root: BoundDirectory, canvas: JsonCanvas, destinationPath: string): Promise<void> {
  for (const node of canvas.nodes) {
    validateRelativePath(node.file, ".md");
    if (node.file === destinationPath) continue;
    await bindFile(root, node.file);
  }
}

function assertManagedContent(relativePath: string, content: Buffer | string): void {
  if (MOC_TARGETS.has(relativePath)) {
    replaceManagedMocIndex(content.toString(), []);
    return;
  }
  if (CANVAS_TO_MOC.has(relativePath)) {
    parseCanvas(content, "managed");
    return;
  }
  throw new TransactionValidationError("managed replacement target is not approved");
}

function managedMocEnvelope(content: Buffer | string): { prefix: string; suffix: string } {
  const text = content.toString();
  replaceManagedMocIndex(text, []);
  const start = text.indexOf(MOC_START);
  const afterStart = start + MOC_START.length;
  const newlineLength = text.slice(afterStart, afterStart + 2) === "\r\n" ? 2 : 1;
  const end = text.indexOf(MOC_END, afterStart + newlineLength);
  return { prefix: text.slice(0, afterStart + newlineLength), suffix: text.slice(end) };
}

function managedMocLinks(content: Buffer | string): string[] {
  const text = content.toString();
  replaceManagedMocIndex(text, []);
  const start = text.indexOf(MOC_START) + MOC_START.length;
  const contentStart = start + (text.slice(start, start + 2) === "\r\n" ? 2 : 1);
  const end = text.indexOf(MOC_END, contentStart);
  const block = text.slice(contentStart, end).replace(/\r?\n$/u, "");
  if (!block) return [];
  return block.split(/\r?\n/u).map((line) => {
    const match = /^- \[\[([^\]|]+)\|[^\]\r\n]*\]\]$/u.exec(line);
    if (!match?.[1]) throw new TransactionValidationError("managed MOC generated block contains an invalid link entry");
    return validateRelativePath(match[1], ".md");
  });
}

async function validateMocLinks(
  root: BoundDirectory,
  content: Buffer | string,
  destinationPath?: string,
): Promise<void> {
  const identities = new Set<string>();
  for (const linkPath of managedMocLinks(content)) {
    const key = collisionKey(linkPath);
    if (identities.has(key)) throw new TransactionValidationError("managed MOC link identity is ambiguous");
    identities.add(key);
    if (destinationPath && linkPath === destinationPath) continue;
    try { await bindFile(root, linkPath); }
    catch (error) { throw new TransactionValidationError(`managed MOC link target does not exist or is ambiguous: ${(error as Error).message}`); }
  }
}

function assertMocHumanBytesPreserved(before: Buffer, after: string): void {
  const beforeEnvelope = managedMocEnvelope(before);
  const afterEnvelope = managedMocEnvelope(after);
  if (beforeEnvelope.prefix !== afterEnvelope.prefix || beforeEnvelope.suffix !== afterEnvelope.suffix) {
    throw new TransactionValidationError("managed MOC replacement changes human-owned bytes outside markers");
  }
}

function checkPlanIdentity(plan: TransactionPlan, stored: StoredProposal): void {
  if (stored.status !== "pending") throw new TransactionValidationError("proposal is not pending");
  if (!isDeepStrictEqual(plan.proposal, stored)) throw new TransactionValidationError("transaction plan proposal does not match stored proposal");
  if (stored.policyVersion !== BRAIN_FOUNDATION_POLICY.version) throw new TransactionValidationError("proposal policy is stale");
  if (plan.proposal.sourcePath !== assertInboxSource(plan.proposal.sourcePath)) throw new TransactionValidationError("source path identity is invalid");
  validateRelativePath(plan.proposal.sourcePath, ".md");
  validateRelativePath(plan.proposal.destinationPath, ".md");
  identifier.parse(plan.id);
  if (!HASH.test(plan.proposal.sourceHash)) throw new TransactionValidationError("source hash is invalid");
  if (Buffer.byteLength(plan.destinationContent, "utf8") > MAX_ARTIFACT_BYTES) throw new TransactionValidationError("destination content exceeds byte limit");
  if (!Array.isArray(plan.managedReplacements) || plan.managedReplacements.length > MAX_MANAGED_REPLACEMENTS) {
    throw new TransactionValidationError("managed replacement count exceeds limit");
  }
}

async function prepareApply(plan: TransactionPlan, stored: StoredProposal): Promise<PreparedApply> {
  checkPlanIdentity(plan, stored);
  const root = await bindRoot(plan.vaultRoot);
  const source = await bindFile(root, plan.proposal.sourcePath);
  if (source.hash !== plan.proposal.sourceHash) throw new StaleSourceError("source is stale");

  const destinationSegments = plan.proposal.destinationPath.split("/");
  const destinationFilename = destinationSegments.pop()!;
  const destinationDirectory = destinationSegments.join("/");
  const destinationParent = await bindDirectory(root, destinationDirectory);
  const directorySegments = destinationDirectory.split("/");
  const existingDirectories = new Set<string>();
  let accumulated = "";
  for (const segment of directorySegments) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    existingDirectories.add(accumulated);
  }
  if (assertApprovedDestination(destinationDirectory, existingDirectories) !== destinationDirectory) {
    throw new TransactionValidationError("destination directory identity is invalid");
  }
  await assertDestinationAbsent(destinationParent, destinationFilename);

  const destinationArea = destinationDirectory.split("/", 1)[0];
  const area = BRAIN_FOUNDATION_POLICY.areas.find((candidate) => candidate.directory === destinationArea);
  if (!area) throw new TransactionValidationError("destination area is not approved");
  const destinationMoc = await bindFile(root, areaMocPath(area));
  assertManagedContent(areaMocPath(area), destinationMoc.content);
  await validateMocLinks(root, destinationMoc.content);

  const identities = new Set<string>();
  const managed: PreparedApply["managed"] = [];
  for (const [index, replacement] of plan.managedReplacements.entries()) {
    if (!replacement || typeof replacement !== "object") throw new TransactionValidationError("managed replacement is invalid");
    const relativePath = validateRelativePath(replacement.relativePath);
    const key = collisionKey(relativePath);
    if (identities.has(key)) throw new TransactionValidationError("managed replacement target is duplicated or ambiguous");
    identities.add(key);
    if (!HASH.test(replacement.expectedHash)) throw new TransactionValidationError("managed expected hash is invalid");
    if (Buffer.byteLength(replacement.content, "utf8") > MAX_ARTIFACT_BYTES) throw new TransactionValidationError("managed replacement exceeds byte limit");
    assertManagedContent(relativePath, replacement.content);
    const file = await bindFile(root, relativePath);
    assertManagedContent(relativePath, file.content);
    if (MOC_TARGETS.has(relativePath)) assertMocHumanBytesPreserved(file.content, replacement.content);
    if (file.hash !== replacement.expectedHash) throw new TransactionValidationError("managed replacement hash is stale");
    if (CANVAS_TO_MOC.has(relativePath)) {
      const requiredMoc = CANVAS_TO_MOC.get(relativePath)!;
      await bindFile(root, requiredMoc);
      await validateCanvasReferences(root, parseCanvas(file.content, "current"), plan.proposal.destinationPath);
      await validateCanvasReferences(root, parseCanvas(replacement.content, "replacement"), plan.proposal.destinationPath);
    } else {
      await validateMocLinks(root, file.content);
      await validateMocLinks(root, replacement.content, plan.proposal.destinationPath);
    }
    managed.push({ replacement: { ...replacement, relativePath }, file, afterHash: digest(replacement.content) });
    if (index >= MAX_MANAGED_REPLACEMENTS) throw new TransactionValidationError("managed replacement count exceeds limit");
  }
  managed.sort((left, right) => Buffer.compare(Buffer.from(collisionKey(left.replacement.relativePath)), Buffer.from(collisionKey(right.replacement.relativePath))));
  return { root, source, requiredMoc: destinationMoc, destinationParent, destinationAbsolute: path.join(destinationParent.canonicalPath, destinationFilename), managed };
}

function assertPrivateMode(statValue: BigIntStats, expected: number, label: string): void {
  if (process.platform === "win32") return;
  if (safeMode(statValue) !== expected) throw new TransactionValidationError(`${label} permissions are not ${expected.toString(8)}`);
}

async function ensureRecoveryRoot(
  recoveryRoot: string,
  options: OrganizerTransactionEngineOptions,
  input: { create: boolean; vaultCanonical?: string },
): Promise<string | undefined> {
  if (!path.isAbsolute(recoveryRoot) || Buffer.byteLength(recoveryRoot, "utf8") > PATH_BYTES * 2) {
    throw new TransactionValidationError("recovery root must be a bounded absolute path");
  }
  const resolved = path.resolve(recoveryRoot);
  if (input.vaultCanonical && !isOutside(input.vaultCanonical, resolved)) {
    throw new TransactionValidationError("recovery root must be outside the vault");
  }
  const parsed = path.parse(resolved);
  let current = parsed.root;
  let parentCanonical = process.platform === "win32" ? parsed.root : await realpath(parsed.root);
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    let info: BigIntStats;
    let created = false;
    try {
      info = await lstat(next, { bigint: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!input.create) return undefined;
      await mkdir(next, { mode: 0o700 });
      created = true;
      await emit(options, { name: "recovery_component_created" });
      await syncDirectory(current);
      await emit(options, { name: "recovery_parent_synced" });
      info = await lstat(next, { bigint: true });
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new TransactionValidationError("recovery root ancestor is a symlink, junction, or unsafe path");
    // On Windows, realpath of protected ancestors can fail even though lstat is
    // permitted. lstat identifies reparse points without following them, so the
    // exact resolved spelling remains the safer lineage value there.
    const canonical = process.platform === "win32" ? next : await realpath(next);
    const canonicalInfo = await lstat(next, { bigint: true });
    if (!sameIdentity(info, canonicalInfo) || isOutside(parentCanonical, canonical)) {
      throw new TransactionValidationError("recovery root ancestor changed or escaped");
    }
    if (created) {
      await chmod(next, 0o700);
      assertPrivateMode(await lstat(next, { bigint: true }), 0o700, "recovery directory");
    }
    current = next;
    parentCanonical = canonical;
  }
  if (input.vaultCanonical && !isOutside(input.vaultCanonical, parentCanonical)) {
    throw new TransactionValidationError("recovery root must be outside the vault");
  }
  const finalInfo = await lstat(current, { bigint: true });
  assertPrivateMode(finalInfo, 0o700, "recovery root");
  return parentCanonical;
}

async function makeTransactionDirectory(recoveryRoot: string, id: string): Promise<string> {
  identifier.parse(id);
  const directory = path.join(recoveryRoot, id);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TransactionConflictError("transaction recovery directory already exists");
    throw error;
  }
  await chmod(directory, 0o700);
  assertPrivateMode(await lstat(directory, { bigint: true }), 0o700, "recovery transaction directory");
  await syncDirectory(recoveryRoot);
  return directory;
}

function validateManifestSemantics(manifest: RecoveryManifest): void {
  if (!manifest.proposalId.startsWith("PRP-")) throw new TransactionValidationError("recovery manifest proposal ID is invalid");
  if (!path.isAbsolute(manifest.vaultRoot)) throw new TransactionValidationError("recovery manifest vault root is invalid");
  if (assertInboxSource(manifest.sourcePath) !== manifest.sourcePath) throw new TransactionValidationError("recovery manifest source path identity is invalid");
  validateRelativePath(manifest.sourcePath, ".md");
  validateRelativePath(manifest.destinationPath, ".md");
  const destinationArea = manifest.destinationPath.split("/", 1)[0];
  if (!BRAIN_FOUNDATION_POLICY.areas.some((area) => area.directory === destinationArea)) {
    throw new TransactionValidationError("recovery manifest destination area is invalid");
  }
  if (collisionKey(manifest.sourcePath) === collisionKey(manifest.destinationPath)) {
    throw new TransactionValidationError("recovery manifest source and destination collide");
  }
  if (["vault_applied", "committed", "undo_prepared", "undo_vault_applied", "undone"].includes(manifest.state) && !manifest.destinationOwned) {
    throw new TransactionValidationError("recovery manifest destination ownership is inconsistent");
  }
  validateSnapshotFile(manifest.sourceSnapshotFile);
  const pathKeys = new Set<string>();
  const snapshotFiles = new Set<string>([manifest.sourceSnapshotFile]);
  for (const item of manifest.managed) {
    validateRelativePath(item.relativePath);
    if (!MOC_TARGETS.has(item.relativePath) && !CANVAS_TO_MOC.has(item.relativePath)) {
      throw new TransactionValidationError("recovery manifest managed target is not approved");
    }
    const key = collisionKey(item.relativePath);
    if (pathKeys.has(key) || key === collisionKey(manifest.sourcePath) || key === collisionKey(manifest.destinationPath)) {
      throw new TransactionValidationError("recovery manifest managed paths collide");
    }
    pathKeys.add(key);
    validateSnapshotFile(item.snapshotFile);
    if (snapshotFiles.has(item.snapshotFile)) throw new TransactionValidationError("recovery manifest snapshot filenames collide");
    snapshotFiles.add(item.snapshotFile);
  }
  if (["undo_prepared", "undo_vault_applied", "undone"].includes(manifest.state) && !manifest.undo) {
    throw new TransactionValidationError("recovery manifest undo snapshots are missing");
  }
  if ((manifest.undo !== undefined) !== (manifest.undoneAt !== undefined)) {
    throw new TransactionValidationError("recovery manifest undo timestamp is inconsistent");
  }
  if (manifest.undoneAt && Date.parse(manifest.undoneAt) < Date.parse(manifest.appliedAt)) {
    throw new TransactionValidationError("recovery manifest undo timestamp is before apply");
  }
  if (manifest.undo) {
    validateSnapshotFile(manifest.undo.destinationSnapshotFile);
    if (snapshotFiles.has(manifest.undo.destinationSnapshotFile)) throw new TransactionValidationError("recovery manifest snapshot filenames collide");
    snapshotFiles.add(manifest.undo.destinationSnapshotFile);
    if (manifest.undo.managed.length !== manifest.managed.length) throw new TransactionValidationError("recovery manifest undo snapshot count is invalid");
    const undoPaths = new Set<string>();
    for (const item of manifest.undo.managed) {
      validateRelativePath(item.relativePath);
      const key = collisionKey(item.relativePath);
      if (undoPaths.has(key)) throw new TransactionValidationError("recovery manifest undo paths collide");
      undoPaths.add(key);
      const applied = manifest.managed.find((candidate) => candidate.relativePath === item.relativePath);
      if (!applied || applied.afterHash !== item.hash) throw new TransactionValidationError("recovery manifest undo snapshot does not match managed state");
      validateSnapshotFile(item.snapshotFile);
      if (snapshotFiles.has(item.snapshotFile)) throw new TransactionValidationError("recovery manifest snapshot filenames collide");
      snapshotFiles.add(item.snapshotFile);
    }
  }
}

async function writeManifest(
  directory: string,
  manifest: RecoveryManifest,
  afterSync?: () => Promise<void>,
): Promise<void> {
  const value = manifestSchema.parse(manifest);
  validateManifestSemantics(value);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) throw new TransactionValidationError("recovery manifest exceeds byte limit");
  await writeAtomic(path.join(directory, "manifest.json"), text, 0o600, { afterTempSync: afterSync });
}

async function readRecoveryFile(directory: string, filename: string, maxBytes: number): Promise<Buffer> {
  validateSnapshotFile(filename);
  const file = path.join(directory, filename);
  const info = await lstat(file, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new TransactionValidationError("recovery snapshot is unsafe");
  assertPrivateMode(info, 0o600, "recovery snapshot");
  return readBoundedFile(file, maxBytes);
}

async function readManifest(directory: string, expectedId: string): Promise<RecoveryManifest> {
  return readManifestFile(path.join(directory, "manifest.json"), expectedId);
}

function parseManifestContent(content: Buffer, expectedId: string): RecoveryManifest {
  let raw: unknown;
  try { raw = JSON.parse(content.toString("utf8")); }
  catch { throw new TransactionValidationError("recovery manifest is malformed"); }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== expectedId) throw new TransactionValidationError("recovery manifest schema is invalid");
  validateManifestSemantics(parsed.data);
  return parsed.data;
}

async function readManifestFile(file: string, expectedId: string): Promise<RecoveryManifest> {
  let content: Buffer;
  try {
    const info = await lstat(file, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("unsafe");
    assertPrivateMode(info, 0o600, "recovery manifest");
    content = await readBoundedFile(file, MAX_MANIFEST_BYTES);
  }
  catch { throw new TransactionValidationError("recovery manifest is invalid or oversized"); }
  return parseManifestContent(content, expectedId);
}

async function writeRecoveryReport(directory: string, report: RecoveryReport): Promise<void> {
  const value = recoveryReportSchema.parse(report);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) throw new TransactionValidationError("recovery report exceeds byte limit");
  await writeAtomic(path.join(directory, "recovery-report.json"), text, 0o600);
}

async function readRecoveryReport(directory: string, expectedId: string): Promise<RecoveryReport | undefined> {
  const file = path.join(directory, "recovery-report.json");
  let info: BigIntStats;
  try { info = await lstat(file, { bigint: true }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new TransactionValidationError("recovery report is unsafe");
  assertPrivateMode(info, 0o600, "recovery report");
  let content: Buffer;
  try { content = await readBoundedFile(file, MAX_REPORT_BYTES); }
  catch { throw new TransactionValidationError("recovery report is invalid or oversized"); }
  return parseRecoveryReportContent(content, expectedId);
}

function parseRecoveryReportContent(content: Buffer, expectedId: string): RecoveryReport {
  let raw: unknown;
  try { raw = JSON.parse(content.toString("utf8")); }
  catch { throw new TransactionValidationError("recovery report is malformed"); }
  const parsed = recoveryReportSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== expectedId) throw new TransactionValidationError("recovery report schema is invalid");
  return parsed.data;
}

function recoveryReportTimestamp(manifest: RecoveryManifest, candidate: string): string {
  const floor = manifest.undoneAt ?? manifest.appliedAt;
  return Date.parse(candidate) >= Date.parse(floor) ? candidate : floor;
}

function validateRecoveryReportForManifest(report: RecoveryReport, manifest: RecoveryManifest): void {
  const floor = manifest.undoneAt ?? manifest.appliedAt;
  if (Date.parse(report.at) < Date.parse(floor)) {
    throw new TransactionValidationError("recovery report timestamp predates manifest state");
  }
}

async function publishCreateOnly(
  parent: BoundDirectory,
  target: string,
  content: string | Buffer,
  mode: number,
  input: {
    id: string;
    role: string;
    options?: OrganizerTransactionEngineOptions;
    onOwned?: () => void | Promise<void>;
  },
): Promise<boolean> {
  const temp = transactionTemp(parent, input.id, input.role);
  let tempExists = false;
  let linkSucceeded = false;
  let tempStat: BigIntStats | undefined;
  let cleanupError: unknown;
  try {
    tempStat = await writeSyncedExclusive(temp, content, mode);
    tempExists = true;
    if (input.role === "destination" && input.options) await emit(input.options, { name: "before_destination_link" });
    await assertDestinationAbsent(parent, path.basename(target));
    const verifiedTemp = await inspectOwnedTemporaryFile(parent, temp, new Set([digest(content)]));
    if (!verifiedTemp || !exactFileSnapshot(tempStat, verifiedTemp.stat)) throw new TransactionValidationError("create-only proof temp changed before link");
    await link(temp, target);
    linkSucceeded = true;
    const [tempInfo, targetInfo] = await Promise.all([
      lstat(temp, { bigint: true }),
      lstat(target, { bigint: true }),
    ]);
    if (!tempInfo.isFile() || !targetInfo.isFile() || !provableIdentity(tempInfo, targetInfo)) {
      throw new TransactionValidationError("create-only target ownership could not be proven");
    }
    await input.onOwned?.();
    if (input.role === "destination" && input.options) await emit(input.options, { name: "before_destination_chmod" });
    const targetBeforeChmod = await lstat(target, { bigint: true });
    if (!tempStat || !exactFileSnapshot(targetInfo, targetBeforeChmod) || !provableIdentity(tempStat, targetBeforeChmod)) {
      throw new TransactionValidationError("create-only target changed before chmod");
    }
    await chmod(target, mode);
    if (input.role === "destination" && input.options) await emit(input.options, { name: "before_destination_directory_sync" });
    await syncDirectory(parent.canonicalPath);
    if (input.role === "destination" && input.options) await emit(input.options, { name: "before_destination_temp_unlink" });
    const tempBeforeUnlink = await lstat(temp, { bigint: true });
    if (!tempStat || !exactFileSnapshot(tempStat, tempBeforeUnlink)) {
      throw new TransactionValidationError("create-only proof temp changed before cleanup");
    }
    await unlink(temp);
    tempExists = false;
    await syncDirectory(parent.canonicalPath);
    return true;
  } catch (error: unknown) {
    if (tempExists && !linkSucceeded) {
      try {
        const current = await lstat(temp, { bigint: true });
        if (!tempStat || !exactFileSnapshot(tempStat, current)) {
          throw new TransactionValidationError("create-only temporary cleanup target changed identity");
        }
        await unlink(temp);
        tempExists = false;
        await syncDirectory(parent.canonicalPath);
      } catch (next: unknown) {
        if ((next as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = next;
      }
    }
    if (cleanupError) throw new AggregateError([error, cleanupError], "create-only publication and temporary cleanup failed");
    throw error;
  }
}

function transactionTemp(file: BoundFile | BoundDirectory, id: string, role: string, index?: number): string {
  identifier.parse(id);
  if (!/^[a-z-]+$/u.test(role)) throw new TransactionValidationError("temporary file role is invalid");
  const directory = "absolutePath" in file ? file.parent.canonicalPath : file.canonicalPath;
  const suffix = index === undefined ? "" : `-${index.toString().padStart(3, "0")}`;
  return path.join(directory, `.brain-organizer-${id}-${role}${suffix}.tmp`);
}

async function replaceBoundFile(
  file: BoundFile,
  content: string | Buffer,
  mode: number,
  input: {
    id: string;
    role: string;
    index?: number;
    afterTempSync?: () => Promise<void>;
    options?: OrganizerTransactionEngineOptions;
    operation?: NonNullable<TransactionEvent["operation"]>;
    beforeRename?: () => Promise<void>;
  },
): Promise<void> {
  await writeAtomic(file.absolutePath, content, mode, {
    tempPath: transactionTemp(file, input.id, input.role, input.index),
    afterTempSync: input.afterTempSync,
    beforeRename: async () => {
      await input.beforeRename?.();
      await revalidateFile(file, file.hash, input.options && input.operation
        ? { options: input.options, operation: input.operation, ...(input.index === undefined ? {} : { managedIndex: input.index }) }
        : undefined);
    },
  });
}

async function inspectBoundFile(
  root: BoundDirectory,
  relativePath: string,
): Promise<{ parent: BoundDirectory; absolutePath: string; file?: BoundFile }> {
  validateRelativePath(relativePath);
  const segments = relativePath.split("/");
  const filename = segments.pop()!;
  const parent = await bindDirectory(root, segments.join("/"));
  const found = await exactEntry(parent, filename, true);
  const absolutePath = path.join(parent.canonicalPath, filename);
  if (!found) return { parent, absolutePath };
  return { parent, absolutePath, file: await bindFile(root, relativePath) };
}

interface OwnedTemporaryFile {
  absolutePath: string;
  canonicalPath: string;
  parent: BoundDirectory;
  stat: BigIntStats;
  hash: string;
}

async function inspectOwnedTemporaryFile(
  parent: BoundDirectory,
  absolutePath: string,
  allowedHashes: ReadonlySet<string>,
): Promise<OwnedTemporaryFile | undefined> {
  let statValue: BigIntStats;
  try { statValue = await lstat(absolutePath, { bigint: true }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (statValue.isSymbolicLink() || !statValue.isFile()) throw new TransactionValidationError("owned transaction temporary path is unsafe");
  const content = await readBoundedFile(absolutePath, MAX_ARTIFACT_BYTES);
  const hash = digest(content);
  if (!allowedHashes.has(hash)) throw new TransactionValidationError("owned transaction temporary file content is invalid");
  const after = await lstat(absolutePath, { bigint: true });
  const canonicalPath = await realpath(absolutePath);
  const canonicalStat = await lstat(canonicalPath, { bigint: true });
  if (
    canonicalPath !== absolutePath
    || !exactFileSnapshot(statValue, after)
    || !exactFileSnapshot(statValue, canonicalStat)
  ) throw new TransactionValidationError("owned transaction temporary file changed identity");
  return { absolutePath, canonicalPath, parent, stat: statValue, hash };
}

async function removeOwnedTemporaryFile(file: OwnedTemporaryFile): Promise<void> {
  const bound: BoundFile = {
    relativePath: path.basename(file.absolutePath),
    absolutePath: file.absolutePath,
    canonicalPath: file.canonicalPath,
    parent: file.parent,
    stat: file.stat,
    content: Buffer.alloc(0),
    hash: file.hash,
    mode: safeMode(file.stat),
  };
  await revalidateFile(bound, file.hash);
  await unlink(file.absolutePath);
  await syncDirectory(file.parent.canonicalPath);
}

async function requirePublishedDestination(
  root: BoundDirectory,
  relativePath: string,
  expectedHash: string,
): Promise<BoundFile> {
  const inspected = await inspectBoundFile(root, relativePath);
  if (!inspected.file) throw new TransactionConflictError("published destination is missing or changed");
  if (inspected.file.hash !== expectedHash) throw new TransactionConflictError("published destination is missing or changed");
  return inspected.file;
}

interface RecoverySnapshots {
  source: Buffer;
  managed: Map<string, Buffer>;
  undoDestination?: Buffer;
  undoManaged: Map<string, Buffer>;
}

async function loadRecoverySnapshots(manifest: RecoveryManifest, directory: string): Promise<RecoverySnapshots> {
  const directoryInfo = await lstat(directory, { bigint: true });
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new TransactionValidationError("recovery transaction directory is unsafe");
  assertPrivateMode(directoryInfo, 0o700, "recovery transaction directory");
  const source = await readRecoveryFile(directory, manifest.sourceSnapshotFile, MAX_ARTIFACT_BYTES);
  if (digest(source) !== manifest.sourceHash) throw new TransactionValidationError("source recovery snapshot hash mismatch");
  const managed = new Map<string, Buffer>();
  for (const item of manifest.managed) {
    const snapshot = await readRecoveryFile(directory, item.snapshotFile, MAX_ARTIFACT_BYTES);
    if (digest(snapshot) !== item.beforeHash) throw new TransactionValidationError("managed recovery snapshot hash mismatch");
    managed.set(item.relativePath, snapshot);
  }
  const undoManaged = new Map<string, Buffer>();
  let undoDestination: Buffer | undefined;
  if (manifest.undo) {
    undoDestination = await readRecoveryFile(directory, manifest.undo.destinationSnapshotFile, MAX_ARTIFACT_BYTES);
    if (digest(undoDestination) !== manifest.destinationHash) throw new TransactionValidationError("undo destination snapshot hash mismatch");
    for (const item of manifest.undo.managed) {
      const snapshot = await readRecoveryFile(directory, item.snapshotFile, MAX_ARTIFACT_BYTES);
      if (digest(snapshot) !== item.hash) throw new TransactionValidationError("undo managed snapshot hash mismatch");
      undoManaged.set(item.relativePath, snapshot);
    }
  }
  return { source, managed, ...(undoDestination ? { undoDestination } : {}), undoManaged };
}

async function assertNoUnknownRecoveryArtifacts(
  manifest: RecoveryManifest,
  directory: string,
  manifestFilename = "manifest.json",
): Promise<void> {
  const allowed = new Set<string>([
    manifestFilename,
    "recovery-report.json",
    manifest.sourceSnapshotFile,
    ...manifest.managed.map((item) => item.snapshotFile),
    ...(manifest.undo ? [
      manifest.undo.destinationSnapshotFile,
      ...manifest.undo.managed.map((item) => item.snapshotFile),
    ] : []),
  ]);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > MAX_MANAGED_REPLACEMENTS * 2 + 8 || entries.some((entry) => !entry.isFile() || !allowed.has(entry.name))) {
    throw new TransactionValidationError("recovery directory contains an unverified artifact");
  }
}

async function readOrPromoteInitialManifest(
  directory: string,
  expectedId: string,
  recoveryRoot: string,
): Promise<{ manifest: RecoveryManifest; root: BoundDirectory }> {
  const directoryBefore = await lstat(directory, { bigint: true });
  if (
    directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()
    || path.dirname(directory) !== recoveryRoot || path.basename(directory) !== expectedId
  ) throw new TransactionValidationError("initial recovery transaction directory identity is invalid");
  const manifestPath = path.join(directory, "manifest.json");
  let manifestExists = true;
  try { await lstat(manifestPath, { bigint: true }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    manifestExists = false;
  }
  if (manifestExists) {
    const manifest = await readManifest(directory, expectedId);
    const root = await bindRoot(manifest.vaultRoot);
    if (!isOutside(root.canonicalPath, recoveryRoot)) throw new TransactionValidationError("recovery root must be outside the vault");
    return { manifest, root };
  }
  const tempPath = recoveryAtomicTemp(directory, "manifest.json");
  let manifest: RecoveryManifest;
  let initialTempStat: BigIntStats;
  try { initialTempStat = await lstat(tempPath, { bigint: true }); }
  catch { throw new TransactionValidationError("initial recovery manifest temp is missing or unsafe"); }
  try { manifest = await readManifestFile(tempPath, expectedId); }
  catch { throw new TransactionValidationError("initial recovery manifest temp is invalid or oversized"); }
  const root = await bindRoot(manifest.vaultRoot);
  if (!isOutside(root.canonicalPath, recoveryRoot)) throw new TransactionValidationError("recovery root must be outside the vault");
  await loadRecoverySnapshots(manifest, directory);
  await assertNoUnknownRecoveryArtifacts(manifest, directory, path.basename(tempPath));
  const current = await readManifestFile(tempPath, expectedId);
  if (!isDeepStrictEqual(current, manifest)) throw new TransactionValidationError("initial recovery manifest temp changed before promotion");
  const directoryAfter = await lstat(directory, { bigint: true });
  if (!sameIdentity(directoryBefore, directoryAfter) || directoryAfter.isSymbolicLink() || !directoryAfter.isDirectory()) {
    throw new TransactionValidationError("initial recovery transaction directory changed before promotion");
  }
  const tempBeforeResolution = await lstat(tempPath, { bigint: true });
  const resolvedTemp = await realpath(tempPath);
  const tempAfterResolution = await lstat(tempPath, { bigint: true });
  const canonicalTemp = await lstat(resolvedTemp, { bigint: true });
  const expectedTemp = path.join(directory, path.basename(tempPath));
  if (
    resolvedTemp !== expectedTemp
    || !exactFileSnapshot(initialTempStat, tempBeforeResolution)
    || !exactFileSnapshot(initialTempStat, tempAfterResolution)
    || !exactFileSnapshot(initialTempStat, canonicalTemp)
  ) throw new TransactionValidationError("initial recovery manifest temp changed identity before promotion");
  try { await link(tempPath, manifestPath); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TransactionConflictError("recovery manifest appeared during initial promotion");
    throw error;
  }
  await syncDirectory(directory);
  const [proof, published] = await Promise.all([
    lstat(tempPath, { bigint: true }),
    lstat(manifestPath, { bigint: true }),
  ]);
  if (!provableIdentity(proof, published)) throw new TransactionValidationError("promoted recovery manifest ownership is not provable");
  const proofBeforeUnlink = await lstat(tempPath, { bigint: true });
  if (!exactFileSnapshot(initialTempStat, proofBeforeUnlink)) throw new TransactionValidationError("promoted recovery manifest proof changed identity");
  await unlink(tempPath);
  await syncDirectory(directory);
  return { manifest, root };
}

interface PreparedApplyRollback {
  root: BoundDirectory;
  source: Awaited<ReturnType<typeof inspectBoundFile>>;
  managed: Array<{
    index: number;
    item: RecoveryManifest["managed"][number];
    current: BoundFile;
    snapshot: Buffer;
    temps: OwnedTemporaryFile[];
  }>;
  destination?: BoundFile;
  ownershipNeedsPersistence: boolean;
  ownershipProof?: OwnedTemporaryFile;
  sourceTemps: OwnedTemporaryFile[];
  destinationTemps: OwnedTemporaryFile[];
  sourceSnapshot: Buffer;
}

async function preflightApplyRollback(
  manifest: RecoveryManifest,
  directory: string,
  destinationOwned?: boolean,
): Promise<PreparedApplyRollback> {
  const snapshots = await loadRecoverySnapshots(manifest, directory);
  const root = await bindRoot(manifest.vaultRoot);
  const source = await inspectBoundFile(root, manifest.sourcePath);
  const sourceTemps = (await Promise.all([
    inspectOwnedTemporaryFile(source.parent, transactionTemp(source.parent, manifest.id, "recover-source"), new Set([manifest.sourceHash])),
  ])).filter((item): item is OwnedTemporaryFile => item !== undefined);
  const managed: PreparedApplyRollback["managed"] = [];
  for (const [index, item] of manifest.managed.entries()) {
    const current = await bindFile(root, item.relativePath);
    if (current.hash !== item.beforeHash && current.hash !== item.afterHash) throw new TransactionConflictError("recovery conflict at managed file");
    const temps = (await Promise.all([
      inspectOwnedTemporaryFile(current.parent, transactionTemp(current, manifest.id, "apply-managed", index), new Set([item.afterHash])),
      inspectOwnedTemporaryFile(current.parent, transactionTemp(current, manifest.id, "recover-managed", index), new Set([item.beforeHash])),
    ])).filter((temp): temp is OwnedTemporaryFile => temp !== undefined);
    managed.push({ index, item, current, snapshot: snapshots.managed.get(item.relativePath)!, temps });
  }
  const destinationSegments = manifest.destinationPath.split("/");
  const destinationFilename = destinationSegments.pop()!;
  const destinationParent = await bindDirectory(root, destinationSegments.join("/"));
  const destinationAbsolute = path.join(destinationParent.canonicalPath, destinationFilename);
  const destinationTemps = (await Promise.all([
    inspectOwnedTemporaryFile(destinationParent, transactionTemp(destinationParent, manifest.id, "destination"), new Set([manifest.destinationHash])),
  ])).filter((item): item is OwnedTemporaryFile => item !== undefined);
  const ownershipDeclared = destinationOwned ?? manifest.destinationOwned;
  let ownsDestination = ownershipDeclared;
  let ownershipProof: OwnedTemporaryFile | undefined;
  if (!ownsDestination && destinationTemps[0]) {
    try {
      const targetInfo = await lstat(destinationAbsolute, { bigint: true });
      ownsDestination = targetInfo.isFile() && provableIdentity(destinationTemps[0].stat, targetInfo);
      if (ownsDestination) ownershipProof = destinationTemps[0];
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const destination: Awaited<ReturnType<typeof inspectBoundFile>> = ownsDestination
    ? await inspectBoundFile(root, manifest.destinationPath)
    : { parent: destinationParent, absolutePath: destinationAbsolute };
  if (ownsDestination && destination.file && destination.file.hash !== manifest.destinationHash) {
    throw new TransactionConflictError("recovery conflict at destination");
  }
  return {
    root,
    source,
    managed,
    ...(ownsDestination && destination.file ? { destination: destination.file } : {}),
    ownershipNeedsPersistence: !manifest.destinationOwned && ownsDestination,
    ...(ownershipProof ? { ownershipProof } : {}),
    sourceTemps,
    destinationTemps,
    sourceSnapshot: snapshots.source,
  };
}

async function rollbackApply(
  manifest: RecoveryManifest,
  directory: string,
  options: OrganizerTransactionEngineOptions,
  destinationOwned?: boolean,
): Promise<void> {
  const prepared = await preflightApplyRollback(manifest, directory, destinationOwned);
  if (prepared.ownershipNeedsPersistence) {
    await emit(options, { name: "recovery_destination_ownership_inferred" });
    manifest.destinationOwned = true;
    await writeManifest(directory, manifest);
    await emit(options, { name: "recovery_destination_ownership_persisted" });
  }
  for (const temp of prepared.sourceTemps) await removeOwnedTemporaryFile(temp);
  if (!prepared.source.file) {
    await publishCreateOnly(prepared.source.parent, prepared.source.absolutePath, prepared.sourceSnapshot, manifest.sourceMode, {
      id: manifest.id,
      role: "recover-source",
    });
    await emit(options, { name: "recovery_source_restored" });
  }
  for (const { index, item, current, snapshot, temps } of [...prepared.managed].reverse()) {
    for (const temp of temps) await removeOwnedTemporaryFile(temp);
    if (current.hash === item.afterHash && item.afterHash !== item.beforeHash) {
      await replaceBoundFile(current, snapshot, item.mode, {
        id: manifest.id,
        role: "recover-managed",
        index,
        options,
        operation: "recovery_managed_rename",
      });
      await emit(options, { name: "recovery_managed_restored", managedIndex: index });
    }
  }
  for (const temp of prepared.destinationTemps) {
    await removeOwnedTemporaryFile(temp);
    if (temp === prepared.ownershipProof) await emit(options, { name: "recovery_destination_proof_removed" });
  }
  if (prepared.destination) {
    await emit(options, { name: "before_recovery_destination_unlink" });
    await revalidateFile(prepared.destination, manifest.destinationHash, { options, operation: "recovery_destination_unlink" });
    await unlink(prepared.destination.absolutePath);
    await syncDirectory(prepared.destination.parent.canonicalPath);
    await emit(options, { name: "recovery_destination_removed" });
  }
}

interface PreparedUndoRollback {
  destination: Awaited<ReturnType<typeof inspectBoundFile>>;
  source?: BoundFile;
  managed: Array<{
    index: number;
    item: NonNullable<RecoveryManifest["undo"]>["managed"][number];
    current: BoundFile;
    snapshot: Buffer;
    temps: OwnedTemporaryFile[];
  }>;
  destinationTemps: OwnedTemporaryFile[];
  sourceTemps: OwnedTemporaryFile[];
  destinationSnapshot: Buffer;
}

async function preflightUndoRollback(manifest: RecoveryManifest, directory: string): Promise<PreparedUndoRollback> {
  if (!manifest.undo) throw new TransactionValidationError("undo recovery snapshots are missing");
  const snapshots = await loadRecoverySnapshots(manifest, directory);
  const root = await bindRoot(manifest.vaultRoot);
  const destination = await inspectBoundFile(root, manifest.destinationPath);
  if (destination.file && destination.file.hash !== manifest.destinationHash) throw new TransactionConflictError("undo rollback conflict at destination");
  const source = await inspectBoundFile(root, manifest.sourcePath);
  if (source.file && source.file.hash !== manifest.sourceHash) throw new TransactionConflictError("undo rollback conflict at source");
  const managed: PreparedUndoRollback["managed"] = [];
  for (const [index, item] of manifest.undo.managed.entries()) {
    const current = await bindFile(root, item.relativePath);
    const applied = manifest.managed.find((candidate) => candidate.relativePath === item.relativePath);
    if (!applied || (current.hash !== applied.beforeHash && current.hash !== item.hash)) {
      throw new TransactionConflictError("undo rollback conflict at managed file");
    }
    const temps = (await Promise.all([
      inspectOwnedTemporaryFile(current.parent, transactionTemp(current, manifest.id, "undo-managed", index), new Set([applied.beforeHash])),
      inspectOwnedTemporaryFile(current.parent, transactionTemp(current, manifest.id, "recover-undo-managed", index), new Set([item.hash])),
    ])).filter((temp): temp is OwnedTemporaryFile => temp !== undefined);
    managed.push({ index, item, current, snapshot: snapshots.undoManaged.get(item.relativePath)!, temps });
  }
  const destinationTemps = (await Promise.all([
    inspectOwnedTemporaryFile(destination.parent, transactionTemp(destination.parent, manifest.id, "recover-destination"), new Set([manifest.destinationHash])),
  ])).filter((item): item is OwnedTemporaryFile => item !== undefined);
  const sourceTemps = (await Promise.all([
    inspectOwnedTemporaryFile(source.parent, transactionTemp(source.parent, manifest.id, "undo-source"), new Set([manifest.sourceHash])),
  ])).filter((item): item is OwnedTemporaryFile => item !== undefined);
  return {
    destination,
    ...(source.file ? { source: source.file } : {}),
    managed,
    destinationSnapshot: snapshots.undoDestination!,
    destinationTemps,
    sourceTemps,
  };
}

async function rollbackUndo(
  manifest: RecoveryManifest,
  directory: string,
  options: OrganizerTransactionEngineOptions,
): Promise<void> {
  const prepared = await preflightUndoRollback(manifest, directory);
  for (const temp of prepared.destinationTemps) await removeOwnedTemporaryFile(temp);
  if (!prepared.destination.file) {
    await emit(options, { name: "before_undo_recovery_destination_publish" });
    await publishCreateOnly(prepared.destination.parent, prepared.destination.absolutePath, prepared.destinationSnapshot, manifest.undo!.destinationMode, {
      id: manifest.id,
      role: "recover-destination",
    });
    await emit(options, { name: "undo_recovery_destination_restored" });
  }
  for (const { index, item, current, snapshot, temps } of prepared.managed) {
    for (const temp of temps) await removeOwnedTemporaryFile(temp);
    if (current.hash !== item.hash) {
      await emit(options, { name: "before_undo_recovery_managed_publish", managedIndex: index });
      await replaceBoundFile(current, snapshot, item.mode, {
        id: manifest.id,
        role: "recover-undo-managed",
        index,
        options,
        operation: "undo_recovery_managed_rename",
      });
      await emit(options, { name: "undo_recovery_managed_restored", managedIndex: index });
    }
  }
  for (const temp of prepared.sourceTemps) await removeOwnedTemporaryFile(temp);
  if (prepared.source) {
    await emit(options, { name: "before_undo_recovery_source_unlink" });
    await revalidateFile(prepared.source, manifest.sourceHash, { options, operation: "undo_recovery_source_unlink" });
    await unlink(prepared.source.absolutePath);
    await syncDirectory(prepared.source.parent.canonicalPath);
    await emit(options, { name: "undo_recovery_source_removed" });
  }
}

function transactionFromManifest(manifest: RecoveryManifest): TransactionRecord {
  return {
    id: manifest.id,
    proposalId: manifest.proposalId,
    vault: manifest.vault,
    sourcePath: manifest.sourcePath,
    destinationPath: manifest.destinationPath,
    sourceHash: manifest.sourceHash,
    destinationHash: manifest.destinationHash,
    appliedAt: manifest.appliedAt,
    ...(manifest.undoneAt ? { undoneAt: manifest.undoneAt } : {}),
  };
}

function appliedTransactionFromManifest(manifest: RecoveryManifest): TransactionRecord {
  const transaction = transactionFromManifest(manifest);
  delete transaction.undoneAt;
  return transaction;
}

function assertProposalReconciliation(
  manifest: RecoveryManifest,
  proposal: StoredProposal | undefined,
  status: "pending" | "applied",
): StoredProposal {
  if (
    !proposal || proposal.status !== status || proposalRecoveryHash(proposal) !== manifest.proposalHash
    || Date.parse(manifest.appliedAt) < Date.parse(proposal.createdAt)
  ) {
    throw new TransactionValidationError("database proposal does not exactly match recovery manifest");
  }
  return proposal;
}

function assertAppliedReconciliation(
  manifest: RecoveryManifest,
  store: OrganizerStore,
  expectUndone: boolean,
): TransactionRecord {
  const transaction = store.getTransaction(manifest.id);
  const expected = expectUndone ? transactionFromManifest(manifest) : appliedTransactionFromManifest(manifest);
  if (!transaction || !isDeepStrictEqual(transaction, expected)) {
    throw new TransactionValidationError("database transaction does not exactly match recovery manifest");
  }
  assertProposalReconciliation(manifest, store.getProposal(manifest.proposalId), "applied");
  return transaction;
}

function assertPendingReconciliation(manifest: RecoveryManifest, store: OrganizerStore): void {
  if (store.getTransaction(manifest.id)) throw new TransactionValidationError("database transaction unexpectedly exists during recovery");
  assertProposalReconciliation(manifest, store.getProposal(manifest.proposalId), "pending");
}

function assertRolledBackReconciliation(manifest: RecoveryManifest, store: OrganizerStore): StoredProposal {
  if (store.getTransaction(manifest.id)) throw new TransactionValidationError("database transaction unexpectedly exists for rolled-back recovery");
  const proposal = store.getProposal(manifest.proposalId);
  if (!proposal || proposal.status === "applied" || proposalRecoveryHash(proposal) !== manifest.proposalHash) {
    throw new TransactionValidationError("database proposal does not exactly match rolled-back recovery manifest");
  }
  return proposal;
}

export class OrganizerTransactionEngine {
  private readonly options: OrganizerTransactionEngineOptions;

  constructor(options: OrganizerTransactionEngineOptions) {
    if (!options || typeof options !== "object" || !(options.store instanceof OrganizerStore)) {
      throw new TransactionValidationError("transaction engine options are invalid");
    }
    this.options = options;
  }

  public async apply(plan: TransactionPlan): Promise<TransactionRecord> {
    const planRoot = await bindRoot(plan.vaultRoot);
    const recoveryRoot = (await ensureRecoveryRoot(this.options.recoveryRoot, this.options, {
      create: true,
      vaultCanonical: planRoot.canonicalPath,
    }))!;
    await this.recoverRoot(recoveryRoot);
    const stored = this.options.store.getProposal(plan.proposal.id);
    if (!stored) throw new TransactionValidationError("proposal not found");
    let prepared: PreparedApply | undefined;
    let transactionDirectory: string | undefined;
    let manifest: RecoveryManifest | undefined;
    let destinationPublished = false;
    let vaultMutationStarted = false;
    let databaseCommitStarted = false;
    try {
      prepared = await prepareApply(plan, stored);
      if (!isOutside(prepared.root.canonicalPath, recoveryRoot)) throw new TransactionValidationError("recovery root must be outside the vault");
      transactionDirectory = await makeTransactionDirectory(recoveryRoot, plan.id);

      await writeSyncedExclusive(path.join(transactionDirectory, "original.md"), prepared.source.content, 0o600);
      await emit(this.options, { name: "after_source_snapshot_sync" });
      const managedManifest: RecoveryManifest["managed"] = [];
      for (const [index, item] of prepared.managed.entries()) {
        const snapshotFile = `managed-${index.toString().padStart(3, "0")}.snapshot`;
        await writeSyncedExclusive(path.join(transactionDirectory, snapshotFile), item.file.content, 0o600);
        await emit(this.options, { name: "after_managed_snapshot_sync", managedIndex: index });
        managedManifest.push({
          relativePath: item.replacement.relativePath,
          snapshotFile,
          beforeHash: item.file.hash,
          afterHash: item.afterHash,
          mode: item.file.mode,
        });
      }
      await syncDirectory(transactionDirectory);
      manifest = {
        version: 1,
        id: plan.id,
        proposalId: stored.id,
        proposalHash: proposalRecoveryHash(stored),
        vault: stored.vault,
        vaultRoot: prepared.root.canonicalPath,
        sourcePath: stored.sourcePath,
        destinationPath: stored.destinationPath,
        sourceSnapshotFile: "original.md",
        sourceHash: stored.sourceHash,
        sourceMode: prepared.source.mode,
        destinationHash: digest(plan.destinationContent),
        destinationOwned: false,
        appliedAt: this.now(),
        managed: managedManifest,
        state: "prepared",
      };
      await writeManifest(transactionDirectory, manifest, async () => emit(this.options, { name: "after_manifest_sync" }));
      await emit(this.options, { name: "manifest_directory_synced" });

      await assertDestinationAbsent(prepared.destinationParent, path.basename(prepared.destinationAbsolute));
      await emit(this.options, { name: "before_destination_publish" });
      await assertDestinationAbsent(prepared.destinationParent, path.basename(prepared.destinationAbsolute));
      await revalidateSource(prepared.source, stored.sourceHash);
      await revalidateFile(prepared.requiredMoc, prepared.requiredMoc.hash);
      vaultMutationStarted = true;
      try {
        destinationPublished = await publishCreateOnly(prepared.destinationParent, prepared.destinationAbsolute, plan.destinationContent, 0o600, {
          id: manifest.id,
          role: "destination",
          options: this.options,
          onOwned: async () => {
            destinationPublished = true;
            await emit(this.options, { name: "before_destination_ownership_persist" });
            const ownedManifest = { ...manifest!, destinationOwned: true };
            await writeManifest(transactionDirectory!, ownedManifest);
            manifest = ownedManifest;
          },
        });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TransactionConflictError("destination collision during publication");
        throw error;
      }
      await emit(this.options, { name: "destination_published" });

      for (const [index, item] of prepared.managed.entries()) {
        await revalidateFile(item.file, item.replacement.expectedHash);
        await emit(this.options, { name: "before_managed_publish", managedIndex: index });
        await requirePublishedDestination(prepared.root, stored.destinationPath, manifest.destinationHash);
        await revalidateFile(item.file, item.replacement.expectedHash);
        if (CANVAS_TO_MOC.has(item.replacement.relativePath)) {
          await validateCanvasReferences(prepared.root, parseCanvas(item.file.content, "current"), stored.destinationPath);
          await validateCanvasReferences(prepared.root, parseCanvas(item.replacement.content, "replacement"), stored.destinationPath);
        }
        await replaceBoundFile(item.file, item.replacement.content, item.file.mode, {
          id: manifest.id,
          role: "apply-managed",
          index,
          afterTempSync: async () => emit(this.options, { name: "managed_temp_synced", managedIndex: index }),
          options: this.options,
          operation: "apply_managed_rename",
          beforeRename: MOC_TARGETS.has(item.replacement.relativePath) ? async () => {
            if (!manifest!.destinationOwned) throw new TransactionValidationError("managed MOC destination is not proven owned");
            await requirePublishedDestination(prepared!.root, stored.destinationPath, manifest!.destinationHash);
            assertManagedContent(item.replacement.relativePath, item.replacement.content);
            await validateMocLinks(prepared!.root, item.replacement.content, stored.destinationPath);
          } : undefined,
        });
        await emit(this.options, { name: "managed_published", managedIndex: index });
      }

      await requirePublishedDestination(prepared.root, stored.destinationPath, manifest.destinationHash);
      await emit(this.options, { name: "before_source_unlink" });
      await revalidateSource(prepared.source, stored.sourceHash, { options: this.options, operation: "apply_source_unlink" });
      await unlink(prepared.source.absolutePath);
      await syncDirectory(prepared.source.parent.canonicalPath);
      await emit(this.options, { name: "source_removed" });

      manifest = { ...manifest, state: "vault_applied" };
      await writeManifest(transactionDirectory, manifest);
      const transaction = transactionFromManifest(manifest);
      await emit(this.options, { name: "before_database_commit" });
      databaseCommitStarted = true;
      this.options.store.applyProposalWithTransaction(transaction);
      await emit(this.options, { name: "database_committed" });
      return transaction;
    } catch (error: unknown) {
      if (databaseCommitStarted && manifest) {
        const existingTransaction = this.options.store.getTransaction(plan.id);
        if (existingTransaction) return assertAppliedReconciliation(manifest, this.options.store, false);
      }
      try {
        if (transactionDirectory && !vaultMutationStarted && !destinationPublished) {
          await this.removeUnpublishedRecoveryDirectory(recoveryRoot, transactionDirectory);
        } else if (manifest && transactionDirectory) {
          await rollbackApply(manifest, transactionDirectory, this.options, destinationPublished);
          manifest = { ...manifest, state: "rolled_back" };
          await writeManifest(transactionDirectory, manifest);
          await writeRecoveryReport(transactionDirectory, {
            version: 1,
            id: manifest.id,
            outcome: "rolled_back",
            at: recoveryReportTimestamp(manifest, this.now()),
          });
        }
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], "transaction failed and rollback could not complete");
      }
      const current = this.options.store.getProposal(stored.id);
      if (current?.status === "pending") this.options.store.markProposal(stored.id, error instanceof StaleSourceError ? "stale" : "rejected");
      throw error;
    }
  }

  public async undo(transactionId: string): Promise<TransactionRecord> {
    identifier.parse(transactionId);
    const recoveryRoot = await ensureRecoveryRoot(this.options.recoveryRoot, this.options, { create: false });
    if (!recoveryRoot) throw new TransactionValidationError("transaction recovery root does not exist");
    await this.recoverRoot(recoveryRoot);
    const transaction = this.options.store.getTransaction(transactionId);
    if (!transaction) throw new TransactionValidationError("transaction not found");
    if (transaction.undoneAt) throw new TransactionConflictError("transaction already undone");
    const directory = path.join(recoveryRoot, transactionId);
    let manifest = await readManifest(directory, transactionId);
    const manifestRoot = await bindRoot(manifest.vaultRoot);
    if (!isOutside(manifestRoot.canonicalPath, recoveryRoot)) throw new TransactionValidationError("recovery root must be outside the vault");
    if (!isDeepStrictEqual(transaction, appliedTransactionFromManifest(manifest))) throw new TransactionValidationError("recovery manifest does not match transaction");
    assertProposalReconciliation(manifest, this.options.store.getProposal(manifest.proposalId), "applied");
    if (!["vault_applied", "committed"].includes(manifest.state)) throw new TransactionConflictError("transaction is not in an undoable state");

    const root = await bindRoot(manifest.vaultRoot);
    const destination = await bindFile(root, manifest.destinationPath);
    if (destination.hash !== manifest.destinationHash) throw new TransactionConflictError("undo conflict at destination");
    const sourceParent = await bindDirectory(root, path.posix.dirname(manifest.sourcePath));
    await assertDestinationAbsent(sourceParent, path.posix.basename(manifest.sourcePath), "undo conflict at restored source");
    const originalSnapshot = await readRecoveryFile(directory, manifest.sourceSnapshotFile, MAX_ARTIFACT_BYTES);
    if (digest(originalSnapshot) !== manifest.sourceHash) throw new TransactionValidationError("source recovery snapshot hash mismatch");

    const managedFiles: BoundFile[] = [];
    for (const item of manifest.managed) {
      const current = await bindFile(root, item.relativePath);
      if (current.hash !== item.afterHash) throw new TransactionConflictError("undo conflict at managed file");
      const beforeSnapshot = await readRecoveryFile(directory, item.snapshotFile, MAX_ARTIFACT_BYTES);
      if (digest(beforeSnapshot) !== item.beforeHash) throw new TransactionValidationError("managed recovery snapshot hash mismatch");
      managedFiles.push(current);
    }

    const destinationSnapshotFile = "undo-destination.snapshot";
    await this.replaceRecoverySnapshot(directory, destinationSnapshotFile, destination.content);
    const undoManaged: NonNullable<RecoveryManifest["undo"]>["managed"] = [];
    for (const [index, current] of managedFiles.entries()) {
      const snapshotFile = `undo-managed-${index.toString().padStart(3, "0")}.snapshot`;
      await this.replaceRecoverySnapshot(directory, snapshotFile, current.content);
      undoManaged.push({ relativePath: current.relativePath, snapshotFile, hash: current.hash, mode: current.mode });
    }
    await syncDirectory(directory);
    manifest = {
      ...manifest,
      state: "undo_prepared",
      undoneAt: this.now(),
      undo: { destinationSnapshotFile, destinationMode: destination.mode, managed: undoManaged },
    };
    await writeManifest(directory, manifest);
    await loadRecoverySnapshots(manifest, directory);

    try {
      for (const [index, item] of manifest.managed.entries()) {
        const current = managedFiles[index]!;
        const snapshot = await readRecoveryFile(directory, item.snapshotFile, MAX_ARTIFACT_BYTES);
        await revalidateFile(current, item.afterHash);
        await replaceBoundFile(current, snapshot, item.mode, {
          id: manifest.id,
          role: "undo-managed",
          index,
          options: this.options,
          operation: "undo_managed_rename",
        });
        await emit(this.options, { name: "after_undo_managed_publish", managedIndex: index });
      }
      await revalidateDirectory(sourceParent);
      await assertDestinationAbsent(sourceParent, path.posix.basename(manifest.sourcePath), "undo conflict at restored source");
      await publishCreateOnly(sourceParent, path.join(sourceParent.canonicalPath, path.posix.basename(manifest.sourcePath)), originalSnapshot, manifest.sourceMode, {
        id: manifest.id,
        role: "undo-source",
      });
      await emit(this.options, { name: "after_undo_source_publish" });

      await revalidateFile(destination, manifest.destinationHash, { options: this.options, operation: "undo_destination_unlink" });
      await unlink(destination.absolutePath);
      await syncDirectory(destination.parent.canonicalPath);
      await emit(this.options, { name: "after_undo_destination_remove" });
      manifest = { ...manifest, state: "undo_vault_applied" };
      await writeManifest(directory, manifest);
      await emit(this.options, { name: "before_undo_database_commit" });
      const undone = this.options.store.markUndone(transactionId, manifest.undoneAt!);
      await emit(this.options, { name: "undo_database_committed" });
      return undone;
    } catch (error: unknown) {
      const currentTransaction = this.options.store.getTransaction(transactionId);
      if (currentTransaction?.undoneAt) return assertAppliedReconciliation(manifest, this.options.store, true);
      try {
        await rollbackUndo(manifest, directory, this.options);
        manifest = { ...manifest, state: "committed" };
        await writeManifest(directory, manifest);
        await writeRecoveryReport(directory, {
          version: 1,
          id: manifest.id,
          outcome: "undo_rolled_back",
          at: recoveryReportTimestamp(manifest, this.now()),
        });
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], "undo failed and rollback could not complete");
      }
      throw error;
    }
  }

  public async recover(): Promise<RecoveryReport[]> {
    const recoveryRoot = await ensureRecoveryRoot(this.options.recoveryRoot, this.options, { create: false });
    if (!recoveryRoot) return [];
    return this.recoverRoot(recoveryRoot);
  }

  /**
   * Explicit Task 9/orchestration hook. Recovery is never deleted by apply,
   * undo, or recover; callers must independently verify a backup first.
   */
  public async cleanupRecovery(input: RecoveryCleanupInput): Promise<string[]> {
    if (!input?.backupVerified) throw new TransactionValidationError("verified backup is required before recovery cleanup");
    const now = timestampSchema.parse(input.now);
    const cutoff = Date.parse(now) - 30 * 86_400_000;
    const recoveryRoot = await ensureRecoveryRoot(this.options.recoveryRoot, this.options, { create: false });
    if (!recoveryRoot) return [];
    const entries = await readdir(recoveryRoot, { withFileTypes: true });
    if (entries.length > 1_000) throw new TransactionValidationError("recovery directory entry count exceeds limit");
    const removed: string[] = [];
    for (const entry of entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
      if (!identifier.safeParse(entry.name).success) continue;
      if (!entry.isDirectory()) throw new TransactionValidationError("transaction-shaped recovery entry is unsafe");
      const directory = path.join(recoveryRoot, entry.name);
      const info = await lstat(directory, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TransactionValidationError("recovery transaction directory is unsafe");
      assertPrivateMode(info, 0o700, "recovery transaction directory");
      const manifest = await readManifest(directory, entry.name);
      const manifestRoot = await bindRoot(manifest.vaultRoot);
      if (!isOutside(manifestRoot.canonicalPath, recoveryRoot)) throw new TransactionValidationError("recovery root must be outside the vault");
      if (!["committed", "rolled_back", "undone"].includes(manifest.state)) continue;
      const report = await readRecoveryReport(directory, manifest.id);
      if (!report || Date.parse(report.at) > cutoff) continue;
      validateRecoveryReportForManifest(report, manifest);
      const expectedOutcome: RecoveryReport["outcome"] = manifest.state === "rolled_back"
        ? "rolled_back"
        : manifest.state === "undone"
          ? "undone"
          : manifest.undo ? "undo_rolled_back" : "committed";
      if (report.outcome !== expectedOutcome) throw new TransactionValidationError("recovery report does not match terminal manifest");
      await loadRecoverySnapshots(manifest, directory);
      await assertNoUnknownRecoveryArtifacts(manifest, directory);
      if (manifest.state === "rolled_back") assertRolledBackReconciliation(manifest, this.options.store);
      else assertAppliedReconciliation(manifest, this.options.store, manifest.state === "undone");
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(recoveryRoot) || path.basename(resolved) !== manifest.id) {
        throw new TransactionValidationError("refusing unsafe recovery cleanup target");
      }
      await rm(resolved, { recursive: true, force: false });
      await syncDirectory(recoveryRoot);
      removed.push(manifest.id);
    }
    return removed;
  }

  private async recoverRoot(recoveryRoot: string): Promise<RecoveryReport[]> {
    const entries = await readdir(recoveryRoot, { withFileTypes: true });
    if (entries.length > 1_000) throw new TransactionValidationError("recovery directory entry count exceeds limit");
    const reports: RecoveryReport[] = [];
    for (const entry of entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
      if (!identifier.safeParse(entry.name).success) continue;
      if (!entry.isDirectory()) throw new TransactionValidationError("transaction-shaped recovery entry is unsafe");
      const directory = path.join(recoveryRoot, entry.name);
      const info = await lstat(directory, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TransactionValidationError("recovery transaction directory is unsafe");
      assertPrivateMode(info, 0o700, "recovery transaction directory");
      const { manifest } = await readOrPromoteInitialManifest(directory, entry.name, recoveryRoot);
      await discardAtomicRecoveryTemp(directory, "manifest.json", MAX_MANIFEST_BYTES, async (content) => {
        const candidate = parseManifestContent(content, entry.name);
        const candidateRoot = await bindRoot(candidate.vaultRoot);
        if (!isOutside(candidateRoot.canonicalPath, recoveryRoot)) throw new TransactionValidationError("temporary recovery manifest vault is unsafe");
        await loadRecoverySnapshots(candidate, directory);
      });
      await discardAtomicRecoveryTemp(directory, "recovery-report.json", MAX_REPORT_BYTES, (content) => {
        validateRecoveryReportForManifest(parseRecoveryReportContent(content, entry.name), manifest);
      });
      if (["committed", "rolled_back", "undone"].includes(manifest.state)) {
        const outcome: RecoveryReport["outcome"] = manifest.state === "rolled_back"
          ? "rolled_back"
          : manifest.state === "undone"
            ? "undone"
            : manifest.undo ? "undo_rolled_back" : "committed";
        const rolledProposal = manifest.state === "rolled_back"
          ? assertRolledBackReconciliation(manifest, this.options.store)
          : undefined;
        if (!rolledProposal) assertAppliedReconciliation(manifest, this.options.store, manifest.state === "undone");
        const existing = await readRecoveryReport(directory, manifest.id);
        if (existing) validateRecoveryReportForManifest(existing, manifest);
        if (existing?.outcome !== outcome) {
          const report: RecoveryReport = {
            version: 1,
            id: manifest.id,
            outcome,
            at: recoveryReportTimestamp(manifest, this.now()),
          };
          await writeRecoveryReport(directory, report);
          reports.push(report);
        }
        if (rolledProposal?.status === "pending") this.options.store.markProposal(rolledProposal.id, "rejected");
        continue;
      }
      const transaction = this.options.store.getTransaction(manifest.id);
      let outcome: RecoveryReport["outcome"];
      let next: RecoveryManifest["state"];
      if (manifest.state === "prepared" || manifest.state === "vault_applied") {
        if (transaction) {
          assertAppliedReconciliation(manifest, this.options.store, false);
          outcome = "committed";
          next = "committed";
        }
        else {
          assertPendingReconciliation(manifest, this.options.store);
          await rollbackApply(manifest, directory, this.options);
          outcome = "rolled_back";
          next = "rolled_back";
        }
      } else {
        if (transaction?.undoneAt) {
          assertAppliedReconciliation(manifest, this.options.store, true);
          outcome = "undone";
          next = "undone";
        }
        else {
          if (!transaction || !isDeepStrictEqual(transaction, appliedTransactionFromManifest(manifest))) {
            throw new TransactionValidationError("database transaction does not exactly match recovery manifest");
          }
          assertProposalReconciliation(manifest, this.options.store.getProposal(manifest.proposalId), "applied");
          await rollbackUndo(manifest, directory, this.options);
          outcome = "undo_rolled_back";
          next = "committed";
        }
      }
      const updated = { ...manifest, state: next };
      await writeManifest(directory, updated);
      const report: RecoveryReport = {
        version: 1,
        id: manifest.id,
        outcome,
        at: recoveryReportTimestamp(updated, this.now()),
      };
      await writeRecoveryReport(directory, report);
      if (next === "rolled_back") {
        const proposal = assertRolledBackReconciliation(updated, this.options.store);
        if (proposal.status === "pending") this.options.store.markProposal(proposal.id, "rejected");
      }
      reports.push(report);
    }
    return reports;
  }

  private now(): string {
    const value = this.options.now?.() ?? new Date().toISOString();
    const parsed = timestampSchema.safeParse(value);
    if (!parsed.success) throw new TransactionValidationError("transaction timestamp is invalid");
    return parsed.data;
  }

  private async replaceRecoverySnapshot(directory: string, filename: string, content: Buffer): Promise<void> {
    validateSnapshotFile(filename);
    const file = path.join(directory, filename);
    try {
      await writeSyncedExclusive(file, content, 0o600);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readRecoveryFile(directory, filename, MAX_ARTIFACT_BYTES);
      if (!existing.equals(content)) throw new TransactionConflictError("undo recovery snapshot already exists with different content");
    }
  }

  private async removeUnpublishedRecoveryDirectory(recoveryRoot: string, transactionDirectory: string): Promise<void> {
    const expectedParent = path.resolve(recoveryRoot);
    const resolved = path.resolve(transactionDirectory);
    if (path.dirname(resolved) !== expectedParent || !identifier.safeParse(path.basename(resolved)).success) {
      throw new TransactionValidationError("refusing unsafe recovery cleanup target");
    }
    await rm(resolved, { recursive: true, force: true });
    await syncDirectory(expectedParent);
  }
}
