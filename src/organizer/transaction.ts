import { createHash, randomUUID } from "node:crypto";
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
  vault: boundedText(1, VAULT_BYTES),
  vaultRoot: boundedText(1, PATH_BYTES * 2),
  sourcePath: relativePathSchema,
  destinationPath: relativePathSchema,
  sourceSnapshotFile: z.literal("original.md"),
  sourceHash: hashSchema,
  sourceMode: modeSchema,
  destinationHash: hashSchema,
  managed: z.array(managedSnapshotSchema).max(MAX_MANAGED_REPLACEMENTS),
  state: z.enum(["prepared", "vault_applied", "committed", "rolled_back", "undo_prepared", "undo_vault_applied", "undone"]),
  undo: undoSnapshotSchema.optional(),
}).strict();

type RecoveryManifest = z.infer<typeof manifestSchema>;

const recoveryReportSchema = z.object({
  version: z.literal(1),
  id: identifier,
  outcome: z.enum(["rolled_back", "committed", "undo_rolled_back", "undone"]),
  at: boundedText(1, 64).refine((value) => Number.isFinite(Date.parse(value)), "invalid report timestamp"),
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
  | "before_destination_publish"
  | "destination_published"
  | "before_managed_publish"
  | "managed_published"
  | "source_removed"
  | "before_database_commit"
  | "database_committed"
  | "recovery_destination_removed"
  | "recovery_managed_restored"
  | "recovery_source_restored"
  | "after_undo_managed_publish"
  | "after_undo_source_publish"
  | "after_undo_destination_remove"
  | "before_undo_database_commit"
  | "undo_database_committed";

export interface TransactionEvent {
  name: TransactionEventName;
  managedIndex?: number;
}

export interface RecoveryReport {
  version: 1;
  id: string;
  outcome: "rolled_back" | "committed" | "undo_rolled_back" | "undone";
  at: string;
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
    || value !== value.normalize("NFKC")
    || value.includes("\\")
    || path.isAbsolute(value)
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || CONTROL.test(value)
    || Buffer.byteLength(value, "utf8") > PATH_BYTES
  ) throw new TransactionValidationError("transaction path is unsafe or not in exact NFKC form");
  const segments = value.split("/");
  if (segments.some((segment) => (
    !segment || segment === "." || segment === ".." || segment.startsWith(".")
    || WINDOWS_INVALID.test(segment) || /[ .]$/u.test(segment) || WINDOWS_RESERVED.test(segment)
  ))) throw new TransactionValidationError("transaction path is unsafe");
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

async function writeSyncedExclusive(file: string, content: string | Buffer, mode = 0o600): Promise<void> {
  const handle = await open(file, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(file, mode);
}

async function writeAtomic(
  file: string,
  content: string | Buffer,
  mode: number,
  afterSync?: () => Promise<void>,
): Promise<void> {
  const directory = path.dirname(file);
  const temp = path.join(directory, `.brain-organizer-${randomUUID()}.tmp`);
  try {
    await writeSyncedExclusive(temp, content, mode);
    await afterSync?.();
    await rename(temp, file);
    await chmod(file, mode);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temp).catch((unlinkError: unknown) => {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
    });
    throw error;
  }
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
  if (matches[0] !== wanted || wanted !== wanted.normalize("NFKC")) {
    throw new TransactionValidationError("filesystem path does not have exact case and NFKC identity");
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
  return { relativePath, absolutePath, parent, stat: statValue, content, hash: digest(content), mode: safeMode(statValue) };
}

async function revalidateFile(file: BoundFile, expectedHash: string): Promise<void> {
  await revalidateDirectory(file.parent);
  await exactEntry(file.parent, path.basename(file.absolutePath), false);
  const current = await lstat(file.absolutePath, { bigint: true });
  if (!exactFileSnapshot(file.stat, current)) throw new TransactionValidationError("transaction file identity changed");
  const content = await readBoundedFile(file.absolutePath, MAX_ARTIFACT_BYTES);
  if (digest(content) !== expectedHash) throw new TransactionValidationError("transaction file hash changed");
}

async function revalidateSource(file: BoundFile, expectedHash: string): Promise<void> {
  try {
    await revalidateFile(file, expectedHash);
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
    }
    managed.push({ replacement: { ...replacement, relativePath }, file, afterHash: digest(replacement.content) });
    if (index >= MAX_MANAGED_REPLACEMENTS) throw new TransactionValidationError("managed replacement count exceeds limit");
  }
  managed.sort((left, right) => Buffer.compare(Buffer.from(collisionKey(left.replacement.relativePath)), Buffer.from(collisionKey(right.replacement.relativePath))));
  return { root, source, requiredMoc: destinationMoc, destinationParent, destinationAbsolute: path.join(destinationParent.canonicalPath, destinationFilename), managed };
}

async function ensureRecoveryRoot(recoveryRoot: string, vaultCanonical?: string): Promise<string> {
  if (!path.isAbsolute(recoveryRoot) || Buffer.byteLength(recoveryRoot, "utf8") > PATH_BYTES * 2) {
    throw new TransactionValidationError("recovery root must be a bounded absolute path");
  }
  await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
  await chmod(recoveryRoot, 0o700);
  const info = await lstat(recoveryRoot);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new TransactionValidationError("recovery root is not a safe directory");
  const canonical = await realpath(recoveryRoot);
  if (vaultCanonical && !isOutside(vaultCanonical, canonical)) throw new TransactionValidationError("recovery root must be outside the vault");
  return canonical;
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
  await writeAtomic(path.join(directory, "manifest.json"), text, 0o600, afterSync);
}

async function readRecoveryFile(directory: string, filename: string, maxBytes: number): Promise<Buffer> {
  validateSnapshotFile(filename);
  const file = path.join(directory, filename);
  const info = await lstat(file, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new TransactionValidationError("recovery snapshot is unsafe");
  return readBoundedFile(file, maxBytes);
}

async function readManifest(directory: string, expectedId: string): Promise<RecoveryManifest> {
  const file = path.join(directory, "manifest.json");
  let content: Buffer;
  try { content = await readBoundedFile(file, MAX_MANIFEST_BYTES); }
  catch { throw new TransactionValidationError("recovery manifest is invalid or oversized"); }
  let raw: unknown;
  try { raw = JSON.parse(content.toString("utf8")); }
  catch { throw new TransactionValidationError("recovery manifest is malformed"); }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== expectedId) throw new TransactionValidationError("recovery manifest schema is invalid");
  validateManifestSemantics(parsed.data);
  return parsed.data;
}

async function writeRecoveryReport(directory: string, report: RecoveryReport): Promise<void> {
  const value = recoveryReportSchema.parse(report);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) throw new TransactionValidationError("recovery report exceeds byte limit");
  await writeAtomic(path.join(directory, "recovery-report.json"), text, 0o600);
}

async function publishCreateOnly(
  parent: BoundDirectory,
  target: string,
  content: string | Buffer,
  mode: number,
): Promise<boolean> {
  const temp = path.join(parent.canonicalPath, `.brain-organizer-${randomUUID()}.tmp`);
  let published = false;
  try {
    await writeSyncedExclusive(temp, content, mode);
    await link(temp, target);
    published = true;
    await chmod(target, mode);
    await syncDirectory(parent.canonicalPath);
    return true;
  } catch (error) {
    if (published) await unlink(target).catch(() => undefined);
    throw error;
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function replaceBoundFile(file: BoundFile, content: string | Buffer, mode: number): Promise<void> {
  await writeAtomic(file.absolutePath, content, mode);
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

async function rollbackApply(
  manifest: RecoveryManifest,
  directory: string,
  options: OrganizerTransactionEngineOptions,
  destinationOwned?: boolean,
): Promise<void> {
  const root = await bindRoot(manifest.vaultRoot);
  const destination = await inspectBoundFile(root, manifest.destinationPath);
  const destinationHash = destination.file?.hash;
  if (destinationOwned !== false && destinationHash !== undefined && destinationHash !== manifest.destinationHash) {
    throw new TransactionConflictError("recovery conflict at destination");
  }
  if (destinationOwned !== false && destinationHash !== undefined) {
    await revalidateFile(destination.file!, manifest.destinationHash);
    await unlink(destination.absolutePath);
    await syncDirectory(destination.parent.canonicalPath);
    await emit(options, { name: "recovery_destination_removed" });
  }

  for (const [index, item] of manifest.managed.entries()) {
    const current = await bindFile(root, item.relativePath);
    if (current.hash !== item.beforeHash && current.hash !== item.afterHash) throw new TransactionConflictError("recovery conflict at managed file");
    if (current.hash === item.afterHash && item.afterHash !== item.beforeHash) {
      const snapshot = await readRecoveryFile(directory, item.snapshotFile, MAX_ARTIFACT_BYTES);
      if (digest(snapshot) !== item.beforeHash) throw new TransactionValidationError("managed recovery snapshot hash mismatch");
      await replaceBoundFile(current, snapshot, item.mode);
      await emit(options, { name: "recovery_managed_restored", managedIndex: index });
    }
  }

  const source = await inspectBoundFile(root, manifest.sourcePath);
  const sourceHash = source.file?.hash;
  if (sourceHash === undefined) {
    const snapshot = await readRecoveryFile(directory, manifest.sourceSnapshotFile, MAX_ARTIFACT_BYTES);
    if (digest(snapshot) !== manifest.sourceHash) throw new TransactionValidationError("source recovery snapshot hash mismatch");
    await publishCreateOnly(source.parent, source.absolutePath, snapshot, manifest.sourceMode);
    await emit(options, { name: "recovery_source_restored" });
  }
}

async function rollbackUndo(
  manifest: RecoveryManifest,
  directory: string,
): Promise<void> {
  if (!manifest.undo) throw new TransactionValidationError("undo recovery snapshots are missing");
  const root = await bindRoot(manifest.vaultRoot);
  const destination = await inspectBoundFile(root, manifest.destinationPath);
  const destinationCurrent = destination.file?.hash;
  if (destinationCurrent !== undefined && destinationCurrent !== manifest.destinationHash) throw new TransactionConflictError("undo rollback conflict at destination");
  if (destinationCurrent === undefined) {
    const snapshot = await readRecoveryFile(directory, manifest.undo.destinationSnapshotFile, MAX_ARTIFACT_BYTES);
    if (digest(snapshot) !== manifest.destinationHash) throw new TransactionValidationError("undo destination snapshot hash mismatch");
    await publishCreateOnly(destination.parent, destination.absolutePath, snapshot, manifest.undo.destinationMode);
  }

  const source = await inspectBoundFile(root, manifest.sourcePath);
  const sourceCurrent = source.file?.hash;
  if (sourceCurrent !== undefined && sourceCurrent !== manifest.sourceHash) throw new TransactionConflictError("undo rollback conflict at source");
  if (sourceCurrent === manifest.sourceHash) {
    await revalidateFile(source.file!, manifest.sourceHash);
    await unlink(source.absolutePath);
    await syncDirectory(source.parent.canonicalPath);
  }

  for (const item of manifest.undo.managed) {
    const current = await bindFile(root, item.relativePath);
    const manifestItem = manifest.managed.find((candidate) => candidate.relativePath === item.relativePath);
    if (!manifestItem || (current.hash !== manifestItem.beforeHash && current.hash !== item.hash)) {
      throw new TransactionConflictError("undo rollback conflict at managed file");
    }
    if (current.hash !== item.hash) {
      const snapshot = await readRecoveryFile(directory, item.snapshotFile, MAX_ARTIFACT_BYTES);
      if (digest(snapshot) !== item.hash) throw new TransactionValidationError("undo managed snapshot hash mismatch");
      await replaceBoundFile(current, snapshot, item.mode);
    }
  }
}

function transactionFromManifest(manifest: RecoveryManifest, appliedAt: string): TransactionRecord {
  return {
    id: manifest.id,
    proposalId: manifest.proposalId,
    vault: manifest.vault,
    sourcePath: manifest.sourcePath,
    destinationPath: manifest.destinationPath,
    sourceHash: manifest.sourceHash,
    destinationHash: manifest.destinationHash,
    appliedAt,
  };
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
    const recoveryRoot = await ensureRecoveryRoot(this.options.recoveryRoot);
    await this.recover();
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
        vault: stored.vault,
        vaultRoot: prepared.root.canonicalPath,
        sourcePath: stored.sourcePath,
        destinationPath: stored.destinationPath,
        sourceSnapshotFile: "original.md",
        sourceHash: stored.sourceHash,
        sourceMode: prepared.source.mode,
        destinationHash: digest(plan.destinationContent),
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
        destinationPublished = await publishCreateOnly(prepared.destinationParent, prepared.destinationAbsolute, plan.destinationContent, 0o600);
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
        await replaceBoundFile(item.file, item.replacement.content, item.file.mode);
        await emit(this.options, { name: "managed_published", managedIndex: index });
      }

      await requirePublishedDestination(prepared.root, stored.destinationPath, manifest.destinationHash);
      await revalidateSource(prepared.source, stored.sourceHash);
      await unlink(prepared.source.absolutePath);
      await syncDirectory(prepared.source.parent.canonicalPath);
      await emit(this.options, { name: "source_removed" });

      manifest = { ...manifest, state: "vault_applied" };
      await writeManifest(transactionDirectory, manifest);
      const appliedAt = this.now();
      const transaction = transactionFromManifest(manifest, appliedAt);
      await emit(this.options, { name: "before_database_commit" });
      databaseCommitStarted = true;
      this.options.store.applyProposalWithTransaction(transaction);
      await emit(this.options, { name: "database_committed" });
      return transaction;
    } catch (error: unknown) {
      const existingTransaction = databaseCommitStarted && identifier.safeParse(plan.id).success
        ? this.options.store.getTransaction(plan.id)
        : undefined;
      if (existingTransaction) return existingTransaction;
      try {
        if (manifest && transactionDirectory) {
          await rollbackApply(manifest, transactionDirectory, this.options, destinationPublished);
          manifest = { ...manifest, state: "rolled_back" };
          await writeManifest(transactionDirectory, manifest);
          await writeRecoveryReport(transactionDirectory, { version: 1, id: manifest.id, outcome: "rolled_back", at: this.now() });
        } else if (transactionDirectory && !vaultMutationStarted && !destinationPublished) {
          await this.removeUnpublishedRecoveryDirectory(recoveryRoot, transactionDirectory);
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
    const recoveryRoot = await ensureRecoveryRoot(this.options.recoveryRoot);
    await this.recover();
    const transaction = this.options.store.getTransaction(transactionId);
    if (!transaction) throw new TransactionValidationError("transaction not found");
    if (transaction.undoneAt) throw new TransactionConflictError("transaction already undone");
    const directory = path.join(recoveryRoot, transactionId);
    let manifest = await readManifest(directory, transactionId);
    if (
      manifest.proposalId !== transaction.proposalId || manifest.vault !== transaction.vault
      || manifest.sourcePath !== transaction.sourcePath || manifest.destinationPath !== transaction.destinationPath
      || manifest.sourceHash !== transaction.sourceHash || manifest.destinationHash !== transaction.destinationHash
    ) throw new TransactionValidationError("recovery manifest does not match transaction");
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
      undo: { destinationSnapshotFile, destinationMode: destination.mode, managed: undoManaged },
    };
    await writeManifest(directory, manifest);

    try {
      for (const [index, item] of manifest.managed.entries()) {
        const current = managedFiles[index]!;
        const snapshot = await readRecoveryFile(directory, item.snapshotFile, MAX_ARTIFACT_BYTES);
        await revalidateFile(current, item.afterHash);
        await replaceBoundFile(current, snapshot, item.mode);
        await emit(this.options, { name: "after_undo_managed_publish", managedIndex: index });
      }
      await revalidateDirectory(sourceParent);
      await assertDestinationAbsent(sourceParent, path.posix.basename(manifest.sourcePath), "undo conflict at restored source");
      await publishCreateOnly(sourceParent, path.join(sourceParent.canonicalPath, path.posix.basename(manifest.sourcePath)), originalSnapshot, manifest.sourceMode);
      await emit(this.options, { name: "after_undo_source_publish" });

      await revalidateFile(destination, manifest.destinationHash);
      await unlink(destination.absolutePath);
      await syncDirectory(destination.parent.canonicalPath);
      await emit(this.options, { name: "after_undo_destination_remove" });
      manifest = { ...manifest, state: "undo_vault_applied" };
      await writeManifest(directory, manifest);
      await emit(this.options, { name: "before_undo_database_commit" });
      const undone = this.options.store.markUndone(transactionId, this.now());
      await emit(this.options, { name: "undo_database_committed" });
      return undone;
    } catch (error: unknown) {
      const currentTransaction = this.options.store.getTransaction(transactionId);
      if (currentTransaction?.undoneAt) return currentTransaction;
      try {
        await rollbackUndo(manifest, directory);
        manifest = { ...manifest, state: "committed" };
        await writeManifest(directory, manifest);
        await writeRecoveryReport(directory, { version: 1, id: manifest.id, outcome: "undo_rolled_back", at: this.now() });
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], "undo failed and rollback could not complete");
      }
      throw error;
    }
  }

  public async recover(): Promise<RecoveryReport[]> {
    const recoveryRoot = await ensureRecoveryRoot(this.options.recoveryRoot);
    const entries = await readdir(recoveryRoot, { withFileTypes: true });
    if (entries.length > 1_000) throw new TransactionValidationError("recovery directory entry count exceeds limit");
    const reports: RecoveryReport[] = [];
    for (const entry of entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
      if (!entry.isDirectory() || !identifier.safeParse(entry.name).success) continue;
      const directory = path.join(recoveryRoot, entry.name);
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TransactionValidationError("recovery transaction directory is unsafe");
      await chmod(directory, 0o700);
      const manifest = await readManifest(directory, entry.name);
      if (["committed", "rolled_back", "undone"].includes(manifest.state)) continue;
      const transaction = this.options.store.getTransaction(manifest.id);
      let outcome: RecoveryReport["outcome"];
      let next: RecoveryManifest["state"];
      if (manifest.state === "prepared" || manifest.state === "vault_applied") {
        if (transaction) { outcome = "committed"; next = "committed"; }
        else {
          await rollbackApply(manifest, directory, this.options);
          outcome = "rolled_back";
          next = "rolled_back";
        }
      } else {
        if (transaction?.undoneAt) { outcome = "undone"; next = "undone"; }
        else {
          await rollbackUndo(manifest, directory);
          outcome = "undo_rolled_back";
          next = "committed";
        }
      }
      const updated = { ...manifest, state: next };
      await writeManifest(directory, updated);
      const report: RecoveryReport = { version: 1, id: manifest.id, outcome, at: this.now() };
      await writeRecoveryReport(directory, report);
      reports.push(report);
    }
    return reports;
  }

  private now(): string {
    const value = this.options.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new TransactionValidationError("transaction timestamp is invalid");
    return value;
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
