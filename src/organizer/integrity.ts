import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { validateGeneratedCanvas } from "../foundation/canvas.js";
import { areaCanvasPath, areaGuidePath, areaMocPath, type VaultFoundationPolicy } from "../foundation/policy.js";
import type { IntegrityFinding, IntegrityFindingCode, IntegrityReport } from "./types.js";

/** Bounds make an audit safe to run against an accidentally mounted or hostile vault. */
const MAX_DIRECTORIES = 4_096;
const MAX_FILES = 8_192;
const MAX_RELATIVE_PATH_BYTES = 1_024;
const MAX_MARKDOWN_BYTES = 2_097_152;
const MAX_CANVAS_BYTES = 1_048_576;
const MAX_FINDINGS = 2_048;
const MARKER_START = "<!-- brain-auto:start note-index -->";
const MARKER_END = "<!-- brain-auto:end note-index -->";
const TEMPORARY_NAME = /(?:^|[._-])(?:tmp|temp|partial|part|swp|swo)(?:[._-]|$)/iu;
const WINDOWS_INVALID = /[:<>"|?*\u0000-\u001f\u007f-\u009f]/u;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

interface InventoryFile {
  path: string;
  absolutePath: string;
  size: bigint;
  isMarkdown: boolean;
  isCanvas: boolean;
}

interface Inventory {
  files: InventoryFile[];
  directories: string[];
  findings: IntegrityFinding[];
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareFindings(left: IntegrityFinding, right: IntegrityFinding): number {
  return compareUtf8(left.path, right.path)
    || compareUtf8(left.code, right.code)
    || compareUtf8(left.category, right.category);
}

function collisionKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function posixPath(segments: readonly string[]): string {
  return segments.join("/");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isSameFile(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<FileHandle["stat"]>>): boolean {
  return before.isFile()
    && after.isFile()
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.dev === after.dev
    && before.ino === after.ino;
}

function pushFinding(findings: IntegrityFinding[], code: IntegrityFindingCode, category: string, relativePath: string): void {
  if (findings.length >= MAX_FINDINGS) return;
  if (!findings.some((finding) => finding.code === code && finding.category === category && finding.path === relativePath)) {
    findings.push({ code, category, path: relativePath });
  }
}

function pathCategory(relativePath: string, isDirectory: boolean, policy: VaultFoundationPolicy): string | undefined {
  const parts = relativePath.split("/");
  const basename = parts.at(-1) ?? "";
  const normalized = basename.normalize("NFKC");
  const lower = normalized.toLocaleLowerCase("en-US");
  if (normalized !== basename) return "nfkc";
  if (WINDOWS_INVALID.test(basename) || /[ .]$/u.test(basename) || RESERVED_WINDOWS_NAME.test(basename)) return "unsafe_name";
  if (parts.some((part) => Buffer.byteLength(part, "utf8") > 255) || Buffer.byteLength(relativePath, "utf8") > MAX_RELATIVE_PATH_BYTES) return "path_bytes";
  if (basename === ".obsidian") return "application";
  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) return "environment";
  if (
    /\.(?:key|pem|p8|p12|pfx)$/iu.test(normalized)
    || /^(?:id_rsa|id_ed25519|credentials(?:\.json)?|oauth-clients\.json|secrets?)$/iu.test(normalized)
  ) return "key";
  if (
    basename.startsWith("~") || basename.endsWith("~") || TEMPORARY_NAME.test(lower)
    || /\.(?:tmp|temp|partial|swp|swo)$/iu.test(normalized)
    || lower.includes("sync-conflict")
  ) return "temporary";
  if (basename.startsWith(".")) return "hidden";
  if (isDirectory && parts.length > 0 && parts[0] !== "Agent-Inbox" && !isApprovedTopLevel(parts[0] ?? "", policy)) return "unapproved_top_level";
  return undefined;
}

function isApprovedTopLevel(value: string, policy: VaultFoundationPolicy): boolean {
  return value === policy.inbox || policy.areas.some((area) => area.directory === value);
}

function depthViolation(relativePath: string, isDirectory: boolean, policy: VaultFoundationPolicy): boolean {
  const segments = relativePath.split("/");
  const depth = isDirectory ? segments.length : segments.length - 1;
  return depth > policy.maxDepth;
}

function requiredPaths(policy: VaultFoundationPolicy): { markdown: Set<string>; canvases: Set<string> } {
  return {
    markdown: new Set([
      policy.rootGuide,
      policy.homeMoc,
      ...policy.areas.flatMap((area) => [areaMocPath(area), areaGuidePath(area)]),
    ]),
    canvases: new Set([
      policy.brainCanvas,
      ...policy.areas.map(areaCanvasPath),
    ]),
  };
}

function isUnapprovedManagedCanvas(relativePath: string, policy: VaultFoundationPolicy): boolean {
  return /^000_[^/]+_Map\.canvas$/iu.test(relativePath.split("/").at(-1) ?? "")
    && !requiredPaths(policy).canvases.has(relativePath);
}

function exactLineMarkerCount(text: string, marker: string): number {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...text.matchAll(new RegExp(`(?:^|\\r?\\n)${escaped}(?=\\r?\\n|$)`, "gu"))].length;
}

function stripCodeExamples(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      fenced = !fenced;
      return "";
    }
    if (fenced) return "";
    return line.replace(/`[^`]*`/gu, "");
  }).join("\n");
}

function linkReference(raw: string): string | undefined {
  const target = raw.split("|")[0]?.split("#")[0]?.split("^")[0] ?? "";
  return target ? target : undefined;
}

function linkCandidates(sourcePath: string, reference: string): string[] {
  const extension = path.posix.extname(reference) ? "" : ".md";
  const direct = `${reference}${extension}`;
  const sourceDirectory = path.posix.dirname(sourcePath);
  const relative = sourceDirectory === "." ? direct : path.posix.normalize(path.posix.join(sourceDirectory, direct));
  return [...new Set([direct, relative])].filter((candidate) => !candidate.startsWith("../") && candidate !== "..");
}

function isRootPermittedFile(relativePath: string, policy: VaultFoundationPolicy): boolean {
  const requirements = requiredPaths(policy);
  return requirements.markdown.has(relativePath) || requirements.canvases.has(relativePath);
}

async function readBoundedFile(file: InventoryFile, limit: number): Promise<string | undefined> {
  if (file.size > BigInt(limit)) return undefined;
  let handle: FileHandle | undefined;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    handle = await open(file.absolutePath, constants.O_RDONLY | noFollow);
    const before = await lstat(file.absolutePath);
    if (before.isSymbolicLink() || !before.isFile() || before.size > limit) return undefined;
    const opened = await handle.stat();
    if (!isSameFile(before, opened)) return undefined;
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== buffer.length || !isSameFile(before, after)) return undefined;
    return buffer.toString("utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function inventoryVault(root: string, policy: VaultFoundationPolicy): Promise<Inventory> {
  const findings: IntegrityFinding[] = [];
  const files: InventoryFile[] = [];
  const directories: string[] = [];
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    pushFinding(findings, "unsafe_link", "root", ".");
    return { files, directories, findings };
  }
  const canonicalRoot = await realpath(root);
  const pending: Array<{ absolutePath: string; segments: string[] }> = [{ absolutePath: canonicalRoot, segments: [] }];
  let limitHit = false;
  while (pending.length && !limitHit) {
    const current = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(current.absolutePath, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissing(error)) continue;
      throw error;
    }
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const segments = [...current.segments, entry.name];
      const relativePath = posixPath(segments);
      const absolutePath = path.join(current.absolutePath, entry.name);
      let stat;
      try {
        stat = await lstat(absolutePath, { bigint: true });
      } catch (error: unknown) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        pushFinding(findings, "unsafe_link", "symlink", relativePath);
        continue;
      }
      const directory = stat.isDirectory();
      const category = pathCategory(relativePath, directory, policy);
      if (category !== undefined) {
        const code = ["application", "hidden", "environment", "key", "temporary"].includes(category)
          ? "forbidden_artifact" as const
          : "invalid_path" as const;
        pushFinding(findings, code, category, relativePath);
        if (directory) continue;
      }
      if (depthViolation(relativePath, directory, policy)) {
        pushFinding(findings, "max_depth", "depth", relativePath);
        if (directory) continue;
      }
      if (directory) {
        directories.push(relativePath);
        if (directories.length > MAX_DIRECTORIES) {
          pushFinding(findings, "audit_limit_exceeded", "directories", relativePath);
          limitHit = true;
          break;
        }
        if (relativePath.startsWith(".") || category !== undefined) continue;
        pending.push({ absolutePath, segments });
        continue;
      }
      if (!stat.isFile()) {
        pushFinding(findings, "invalid_path", "unsupported_filesystem_type", relativePath);
        continue;
      }
      if (segments.length === 1 && !isRootPermittedFile(relativePath, policy)) {
        pushFinding(findings, "invalid_path", "unapproved_top_level", relativePath);
      }
      if (isUnapprovedManagedCanvas(relativePath, policy)) {
        pushFinding(findings, "forbidden_artifact", "unapproved_managed_canvas", relativePath);
      }
      files.push({
        path: relativePath,
        absolutePath,
        size: stat.size,
        isMarkdown: path.posix.extname(relativePath).toLocaleLowerCase("en-US") === ".md",
        isCanvas: path.posix.extname(relativePath).toLocaleLowerCase("en-US") === ".canvas",
      });
      if (files.length > MAX_FILES) {
        pushFinding(findings, "audit_limit_exceeded", "files", relativePath);
        limitHit = true;
        break;
      }
    }
  }
  return { files, directories, findings };
}

function isRequiredMoc(filePath: string, policy: VaultFoundationPolicy): boolean {
  return filePath === policy.homeMoc || policy.areas.some((area) => areaMocPath(area) === filePath);
}

export async function auditVaultIntegrity(input: {
  vault: string;
  root: string;
  policy: VaultFoundationPolicy;
}): Promise<IntegrityReport> {
  if (!input || typeof input.vault !== "string" || typeof input.root !== "string" || !input.policy) {
    throw new Error("integrity audit input is invalid");
  }
  const inventory = await inventoryVault(input.root, input.policy);
  const findings = inventory.findings;
  if (findings.some((finding) => finding.code === "unsafe_link" && finding.category === "root" && finding.path === ".")) {
    findings.sort(compareFindings);
    return { vault: input.vault, checkedAt: new Date().toISOString(), findings };
  }
  const requirements = requiredPaths(input.policy);
  const filesByPath = new Map(inventory.files.map((file) => [file.path, file]));
  for (const required of [...requirements.markdown, ...requirements.canvases]) {
    if (!filesByPath.has(required)) pushFinding(findings, "missing_required_file", "missing", required);
  }

  const readableMarkdown = new Map<string, string>();
  for (const file of inventory.files.filter((candidate) => candidate.isMarkdown)) {
    if (file.size > BigInt(MAX_MARKDOWN_BYTES)) {
      pushFinding(findings, "audit_limit_exceeded", "content_bytes", file.path);
      continue;
    }
    const text = await readBoundedFile(file, MAX_MARKDOWN_BYTES);
    if (text === undefined) continue;
    readableMarkdown.set(file.path, text);
    if (isRequiredMoc(file.path, input.policy)) {
      if (exactLineMarkerCount(text, MARKER_START) !== 1 || exactLineMarkerCount(text, MARKER_END) !== 1) {
        pushFinding(findings, "invalid_managed_markers", "note_index", file.path);
      } else {
        const start = text.indexOf(MARKER_START);
        const end = text.indexOf(MARKER_END);
        if (start >= end) pushFinding(findings, "invalid_managed_markers", "note_index", file.path);
      }
    }
  }

  const allPaths = new Set(inventory.files.map((file) => file.path));
  const incoming = new Set<string>();
  for (const [sourcePath, text] of readableMarkdown) {
    for (const match of stripCodeExamples(text).matchAll(/!?\[\[([^\]\r\n]+)\]\]/gu)) {
      const rawReference = match[1] ?? "";
      if (rawReference.startsWith("#") || rawReference.startsWith("^")) {
        incoming.add(sourcePath);
        continue;
      }
      const reference = linkReference(rawReference);
      if (!reference) {
        pushFinding(findings, "broken_link", "wiki_link", sourcePath);
        continue;
      }
      const candidates = linkCandidates(sourcePath, reference);
      const exact = candidates.find((candidate) => allPaths.has(candidate));
      if (exact !== undefined) {
        if (filesByPath.get(exact)?.isMarkdown) incoming.add(exact);
        continue;
      }
      if (candidates.some((candidate) => requirements.markdown.has(candidate))) {
        // A missing foundation document is already reported once as a root cause. Do not turn
        // every guide that references it into a noisy cascade of secondary broken links.
        continue;
      }
      const wantedBasename = path.posix.basename(candidates[0] ?? reference);
      const basenameMatches = inventory.files.filter((candidate) => path.posix.basename(candidate.path) === wantedBasename);
      if (basenameMatches.length === 1) {
        if (basenameMatches[0]?.isMarkdown) incoming.add(basenameMatches[0].path);
        continue;
      }
      const nearMatches = inventory.files.filter((candidate) => (
        candidates.some((value) => collisionKey(value) === collisionKey(candidate.path))
        || collisionKey(path.posix.basename(candidate.path)) === collisionKey(wantedBasename)
      ));
      pushFinding(findings, basenameMatches.length > 1 || nearMatches.length > 1 ? "ambiguous_link" : "broken_link", "wiki_link", sourcePath);
    }
  }

  for (const requiredCanvas of requirements.canvases) {
    const canvas = filesByPath.get(requiredCanvas);
    if (!canvas) continue;
    if (canvas.size > BigInt(MAX_CANVAS_BYTES)) {
      pushFinding(findings, "invalid_canvas", "content_bytes", requiredCanvas);
      continue;
    }
    const text = await readBoundedFile(canvas, MAX_CANVAS_BYTES);
    if (text === undefined) {
      pushFinding(findings, "invalid_canvas", "unreadable", requiredCanvas);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      pushFinding(findings, "invalid_canvas", "json", requiredCanvas);
      continue;
    }
    if (!validateGeneratedCanvas(parsed)) {
      pushFinding(findings, "invalid_canvas", "schema", requiredCanvas);
      continue;
    }
    for (const node of parsed.nodes) {
      if (!filesByPath.has(node.file) || !filesByPath.get(node.file)?.isMarkdown) {
        pushFinding(findings, "canvas_missing_file", "file_reference", requiredCanvas);
      }
    }
  }

  const requiredMarkdown = requirements.markdown;
  for (const file of inventory.files) {
    if (!file.isMarkdown || requiredMarkdown.has(file.path) || file.path === input.policy.rootGuide) continue;
    if (file.path === input.policy.inbox || file.path.startsWith(`${input.policy.inbox}/`)) continue;
    if (file.path.split("/").some((segment) => segment.startsWith("."))) continue;
    if (!incoming.has(file.path)) pushFinding(findings, "orphan_note", "no_inbound_link", file.path);
  }

  findings.sort(compareFindings);
  return { vault: input.vault, checkedAt: new Date().toISOString(), findings };
}
