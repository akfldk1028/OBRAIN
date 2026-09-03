import { constants, type BigIntStats, type Dir, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { validateGeneratedCanvas } from "../foundation/canvas.js";
import {
  areaCanvasPath,
  areaGuidePath,
  areaMocPath,
  type VaultFoundationPolicy,
} from "../foundation/policy.js";
import type { IntegrityFinding, IntegrityFindingCode, IntegrityReport } from "./types.js";

export interface IntegrityAuditLimits {
  maxDirectories: number;
  maxFiles: number;
  maxEntries: number;
  maxInventoryBytes: number;
  maxContentBytes: number;
  maxParsedLinkBytes: number;
  maxLinks: number;
  maxFindings: number;
}

export const INTEGRITY_AUDIT_DEFAULTS: IntegrityAuditLimits = Object.freeze({
  maxDirectories: 4_096,
  maxFiles: 8_192,
  maxEntries: 16_384,
  maxInventoryBytes: 16_777_216,
  maxContentBytes: 2_097_152,
  maxParsedLinkBytes: 8_388_608,
  maxLinks: 16_384,
  maxFindings: 2_048,
});

export interface IntegrityAuditDirectory extends AsyncIterable<Dirent> {
  close(): Promise<void>;
}

export interface IntegrityAuditFs {
  lstat(pathname: string): Promise<BigIntStats>;
  realpath(pathname: string): Promise<string>;
  opendir(pathname: string): Promise<IntegrityAuditDirectory>;
  open(pathname: string, flags: number): Promise<FileHandle>;
}

interface BoundDirectory {
  pathname: string;
  canonicalPath: string;
  snapshot: BigIntStats;
  label: string;
}

interface BoundFile {
  pathname: string;
  canonicalPath: string;
  snapshot: BigIntStats;
  lineage: readonly BoundDirectory[];
  path: string;
}

interface MarkdownScan {
  links: string[];
  starts: number[];
  ends: number[];
  overflow: boolean;
}

interface MarkdownLine {
  start: number;
  end: number;
  raw: string;
}

type FailureKind = "changed" | "unreadable" | "unsafe";

const START = "<!-- brain-auto:start note-index -->";
const END = "<!-- brain-auto:end note-index -->";
const LIMIT_FINDING: IntegrityFinding = {
  code: "audit_limit_exceeded",
  category: "limit",
  path: ".",
};
const TEMP = /(?:^|[._-])(?:tmp|temp|partial|part|swp|swo)(?:[._-]|$)/iu;
const INVALID = /[:<>"|?*\u0000-\u001f\u007f-\u009f]/u;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

const cmp = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const key = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US");
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "";
const outside = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};
const inside = (parent: string, child: string) => child !== parent && !outside(parent, child);
const sameId = (a: BigIntStats, b: BigIntStats) => (
  (a.dev === 0n && a.ino === 0n && b.dev === 0n && b.ino === 0n)
  || (a.dev === b.dev && a.ino === b.ino)
);
const sameDir = (a: BigIntStats, b: BigIntStats) => (
  a.isDirectory() && b.isDirectory() && sameId(a, b)
  && a.size === b.size && a.mtimeNs === b.mtimeNs
);
const sameFile = (a: BigIntStats, b: BigIntStats) => (
  a.isFile() && b.isFile() && sameId(a, b)
  && a.size === b.size && a.mtimeNs === b.mtimeNs
);

class RaceError extends Error {}
class UnsafeLinkError extends Error {}
class ReadError extends Error {
  constructor(readonly kind: FailureKind) {
    super(kind);
  }
}

function failureKind(error: unknown): FailureKind {
  if (error instanceof UnsafeLinkError || errorCode(error) === "ELOOP") return "unsafe";
  if (["EACCES", "EPERM"].includes(errorCode(error))) return "unreadable";
  return "changed";
}

function failureCode(kind: FailureKind): IntegrityFindingCode {
  if (kind === "unsafe") return "unsafe_link";
  if (kind === "unreadable") return "unreadable_file";
  return "changed_file";
}

class Findings {
  values: IntegrityFinding[] = [];
  private hitLimit = false;

  constructor(private readonly max: number) {}

  add(code: IntegrityFindingCode, category: string, pathValue: string): void {
    if (this.hitLimit) return;
    if (this.values.some((finding) => (
      finding.code === code && finding.category === category && finding.path === pathValue
    ))) return;
    if (this.values.length >= this.max) {
      this.limit();
      return;
    }
    this.values.push({ code, category, path: pathValue });
  }

  limit(): void {
    this.hitLimit = true;
    this.values = [{ ...LIMIT_FINDING }];
  }

  get exceeded(): boolean {
    return this.hitLimit;
  }

  suppressIncompleteConclusions(): void {
    if (this.hitLimit) return;
    this.values = this.values.filter((finding) => ![
      "missing_required_file",
      "orphan_note",
      "broken_link",
      "ambiguous_link",
      "canvas_missing_file",
    ].includes(finding.code));
  }

  finish(): void {
    if (this.hitLimit) return;
    this.values.sort((a, b) => (
      cmp(a.path, b.path) || cmp(a.code, b.code) || cmp(a.category, b.category)
    ));
  }
}

function limits(partial: Partial<IntegrityAuditLimits> | undefined): IntegrityAuditLimits {
  const result = { ...INTEGRITY_AUDIT_DEFAULTS, ...partial };
  if (Object.values(result).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error("integrity audit limit is invalid");
  }
  return result;
}

function fsNative(): IntegrityAuditFs {
  return {
    lstat: (pathname) => lstat(pathname, { bigint: true }),
    realpath,
    opendir: (pathname) => opendir(pathname) as Promise<Dir>,
    open,
  };
}

function foundation(policy: VaultFoundationPolicy) {
  return {
    markdown: new Set([
      policy.rootGuide,
      policy.homeMoc,
      ...policy.areas.flatMap((area) => [areaMocPath(area), areaGuidePath(area)]),
    ]),
    canvases: new Set([policy.brainCanvas, ...policy.areas.map(areaCanvasPath)]),
  };
}

async function bindDir(
  fs: IntegrityAuditFs,
  pathname: string,
  before: BigIntStats,
  label: string,
  parent?: BoundDirectory,
): Promise<BoundDirectory> {
  if (before.isSymbolicLink()) throw new UnsafeLinkError();
  if (!before.isDirectory()) throw new RaceError();
  const canonicalPath = await fs.realpath(pathname);
  const after = await fs.lstat(pathname);
  const resolved = await fs.lstat(canonicalPath);
  if (after.isSymbolicLink() || resolved.isSymbolicLink()) throw new UnsafeLinkError();
  if (parent && !inside(parent.canonicalPath, canonicalPath)) throw new UnsafeLinkError();
  if (!sameDir(before, after) || !sameDir(before, resolved)) throw new RaceError();
  return { pathname, canonicalPath, snapshot: before, label };
}

async function revalidate(
  fs: IntegrityAuditFs,
  lineage: readonly BoundDirectory[],
): Promise<void> {
  let parent: BoundDirectory | undefined;
  for (const original of lineage) {
    const now = await fs.lstat(original.pathname);
    const bound = await bindDir(fs, original.pathname, now, original.label, parent);
    if (bound.canonicalPath !== original.canonicalPath || !sameDir(bound.snapshot, original.snapshot)) {
      throw new RaceError();
    }
    parent = bound;
  }
}

async function bindFile(
  fs: IntegrityAuditFs,
  pathname: string,
  before: BigIntStats,
  parent: BoundDirectory,
): Promise<string> {
  if (before.isSymbolicLink()) throw new UnsafeLinkError();
  if (!before.isFile()) throw new RaceError();
  const canonical = await fs.realpath(pathname);
  const after = await fs.lstat(pathname);
  const resolved = await fs.lstat(canonical);
  if (after.isSymbolicLink() || resolved.isSymbolicLink()) throw new UnsafeLinkError();
  if (!inside(parent.canonicalPath, canonical)) throw new UnsafeLinkError();
  if (!sameFile(before, after) || !sameFile(before, resolved)) throw new RaceError();
  return canonical;
}

function classification(
  relative: string,
  directory: boolean,
  policy: VaultFoundationPolicy,
): [IntegrityFindingCode, string] | undefined {
  const segments = relative.split("/");
  const normalizedSegments = segments.map((value) => value.normalize("NFKC"));
  const name = segments.at(-1) ?? "";
  const normalizedName = normalizedSegments.at(-1) ?? "";
  if (
    segments.some((value, index) => (
      Buffer.byteLength(value) > 240
      || Buffer.byteLength(normalizedSegments[index] ?? "") > 240
    ))
    || Buffer.byteLength(relative) > 1_024
    || Buffer.byteLength(normalizedSegments.join("/")) > 1_024
  ) return ["invalid_path", "path_bytes"];
  if (normalizedSegments.some((value) => (
    !value || value.includes("/") || value.includes("\\") || value === "." || value === ".."
    || INVALID.test(value) || /[ .]$/u.test(value) || RESERVED.test(value)
  ))) return ["invalid_path", "unsafe_name"];
  if (name !== normalizedName) return ["invalid_path", "nfkc"];
  const lower = name.toLocaleLowerCase("en-US");
  if (name === ".obsidian") return ["forbidden_artifact", "application"];
  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) {
    return ["forbidden_artifact", "environment"];
  }
  if (
    /\.(?:key|pem|p8|p12|pfx)$/iu.test(name)
    || /^(?:id_rsa|id_ed25519|credentials(?:\.json)?|oauth-clients\.json|secrets?)$/iu.test(name)
  ) return ["forbidden_artifact", "key"];
  if (
    name.startsWith("~") || name.endsWith("~") || TEMP.test(lower)
    || /\.(?:tmp|temp|partial|swp|swo)$/iu.test(name) || lower.includes("sync-conflict")
  ) return ["forbidden_artifact", "temporary"];
  if (name.startsWith(".")) return ["forbidden_artifact", "hidden"];
  const allowedTop = new Set([
    policy.inbox,
    ...policy.areas.map((area) => area.directory),
    policy.rootGuide,
    policy.homeMoc,
    policy.brainCanvas,
  ]);
  if (segments.length === 1 && !allowedTop.has(name)) {
    return ["invalid_path", "unapproved_top_level"];
  }
  if (
    directory
    && !new Set([policy.inbox, ...policy.areas.map((area) => area.directory)])
      .has(segments[0] ?? "")
  ) return ["invalid_path", "unapproved_top_level"];
  return undefined;
}

function tooDeep(relative: string, directory: boolean, policy: VaultFoundationPolicy): boolean {
  return relative.split("/").length - (directory ? 0 : 1) > policy.maxDepth;
}

function addFailure(
  findings: Findings,
  error: unknown,
  category: string,
  pathValue: string,
): void {
  findings.add(failureCode(failureKind(error)), category, pathValue);
}

async function inventory(
  fs: IntegrityAuditFs,
  rootName: string,
  policy: VaultFoundationPolicy,
  cap: IntegrityAuditLimits,
  findings: Findings,
): Promise<{ files: BoundFile[]; complete: boolean }> {
  const files: BoundFile[] = [];
  let complete = true;
  let directories = 1;
  let entriesSeen = 0;
  let inventoryBytes = 0n;
  let initial: BigIntStats;
  try {
    initial = await fs.lstat(rootName);
  } catch (error) {
    addFailure(findings, error, "root", ".");
    return { files, complete: false };
  }
  if (initial.isSymbolicLink() || !initial.isDirectory()) {
    findings.add("unsafe_link", "root", ".");
    return { files, complete: false };
  }

  let root: BoundDirectory;
  try {
    root = await bindDir(fs, rootName, initial, "integrity root");
  } catch (error) {
    const kind = failureKind(error);
    findings.add(
      kind === "unreadable" ? "unreadable_file" : kind === "changed" && errorCode(error) ? "changed_file" : "unsafe_link",
      "root",
      ".",
    );
    return { files, complete: false };
  }

  const queue: Array<{
    bound: BoundDirectory;
    parts: string[];
    lineage: BoundDirectory[];
  }> = [{ bound: root, parts: [], lineage: [root] }];
  let stopped = false;

  for (let cursor = 0; cursor < queue.length && !stopped; cursor += 1) {
    const current = queue[cursor]!;
    const currentPath = current.parts.join("/") || ".";
    try {
      await revalidate(fs, current.lineage);
    } catch (error) {
      addFailure(findings, error, "ancestor", currentPath);
      complete = false;
      continue;
    }

    let directoryHandle: IntegrityAuditDirectory | undefined;
    try {
      const parent = current.lineage.at(-2);
      const pre = await fs.lstat(current.bound.pathname);
      const bound = await bindDir(fs, current.bound.pathname, pre, current.bound.label, parent);
      if (
        bound.canonicalPath !== current.bound.canonicalPath
        || !sameDir(bound.snapshot, current.bound.snapshot)
      ) throw new RaceError();

      directoryHandle = await fs.opendir(bound.canonicalPath);
      try {
        const post = await fs.lstat(current.bound.pathname);
        const rebound = await bindDir(fs, current.bound.pathname, post, current.bound.label, parent);
        if (
          rebound.canonicalPath !== current.bound.canonicalPath
          || !sameDir(rebound.snapshot, current.bound.snapshot)
        ) throw new RaceError();

        for await (const entry of directoryHandle) {
          if (entriesSeen >= cap.maxEntries) {
            findings.limit();
            complete = false;
            stopped = true;
            break;
          }
          entriesSeen += 1;

          const parts = [...current.parts, entry.name];
          const relative = parts.join("/");
          const pathname = path.join(current.bound.canonicalPath, entry.name);
          const pathBytes = BigInt(Buffer.byteLength(relative, "utf8"));
          if (inventoryBytes + pathBytes > BigInt(cap.maxInventoryBytes)) {
            findings.limit();
            complete = false;
            stopped = true;
            break;
          }
          inventoryBytes += pathBytes;

          let stat: BigIntStats;
          try {
            stat = await fs.lstat(pathname);
          } catch (error) {
            addFailure(findings, error, "entry", relative);
            complete = false;
            continue;
          }
          if (stat.isSymbolicLink()) {
            findings.add("unsafe_link", "symlink", relative);
            continue;
          }

          const directory = stat.isDirectory();
          const invalid = classification(relative, directory, policy);
          if (invalid) {
            findings.add(...invalid, relative);
            if (directory) continue;
          }
          if (tooDeep(relative, directory, policy)) {
            findings.add("max_depth", "depth", relative);
            if (directory) continue;
          }
          if (directory) {
            if (directories >= cap.maxDirectories) {
              findings.limit();
              complete = false;
              stopped = true;
              break;
            }
            directories += 1;
            try {
              const child = await bindDir(
                fs,
                pathname,
                stat,
                `integrity directory ${relative}`,
                current.bound,
              );
              queue.push({ bound: child, parts, lineage: [...current.lineage, child] });
            } catch (error) {
              addFailure(findings, error, "directory", relative);
              complete = false;
            }
            continue;
          }
          if (!stat.isFile()) {
            findings.add("invalid_path", "unsupported_filesystem_type", relative);
            continue;
          }
          if (files.length >= cap.maxFiles) {
            findings.limit();
            complete = false;
            stopped = true;
            break;
          }
          if (inventoryBytes + stat.size > BigInt(cap.maxInventoryBytes)) {
            findings.limit();
            complete = false;
            stopped = true;
            break;
          }
          inventoryBytes += stat.size;
          try {
            const canonicalPath = await bindFile(fs, pathname, stat, current.bound);
            files.push({ pathname, canonicalPath, snapshot: stat, lineage: current.lineage, path: relative });
            if (
              /^000_[^/]+_Map\.canvas$/iu.test(entry.name)
              && !foundation(policy).canvases.has(relative)
            ) findings.add("forbidden_artifact", "unapproved_managed_canvas", relative);
          } catch (error) {
            addFailure(findings, error, "file", relative);
            complete = false;
          }
        }
      } finally {
        try {
          await directoryHandle.close();
        } catch (error) {
          if (errorCode(error) !== "ERR_DIR_CLOSED") throw error;
        }
      }
    } catch (error) {
      addFailure(findings, error, "directory", currentPath);
      complete = false;
    }
  }

  files.sort((a, b) => cmp(a.path, b.path));
  return { files, complete };
}

async function read(fs: IntegrityAuditFs, file: BoundFile, max: number): Promise<Buffer> {
  try {
    await revalidate(fs, file.lineage);
    const before = await fs.lstat(file.pathname);
    const canonical = await bindFile(fs, file.pathname, before, file.lineage.at(-1)!);
    if (canonical !== file.canonicalPath || !sameFile(before, file.snapshot)) throw new RaceError();
    const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(opened, file.snapshot) || opened.size > BigInt(max)) throw new RaceError();
      await revalidate(fs, file.lineage);
      const buffer = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      await revalidate(fs, file.lineage);
      const final = await fs.lstat(file.pathname);
      const finalCanonical = await bindFile(fs, file.pathname, final, file.lineage.at(-1)!);
      if (
        offset !== buffer.length || finalCanonical !== file.canonicalPath
        || !sameFile(after, file.snapshot) || !sameFile(final, file.snapshot)
      ) throw new RaceError();
      return buffer;
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new ReadError(failureKind(error));
  }
}

function markdownLines(text: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    let raw = text.slice(start, newline < 0 ? text.length : newline);
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    lines.push({ start, end, raw });
    start = end;
  }
  return lines;
}

function indentation(value: string): { characters: number; columns: number } {
  let characters = 0;
  let columns = 0;
  while (characters < value.length) {
    if (value[characters] === " ") {
      columns += 1;
      characters += 1;
      continue;
    }
    if (value[characters] === "\t") {
      columns += 4 - (columns % 4);
      characters += 1;
      continue;
    }
    break;
  }
  return { characters, columns };
}

function runLength(value: string, index: number, character: string): number {
  let length = 0;
  while (value[index + length] === character) length += 1;
  return length;
}

function maskMarkdownCode(text: string): { mask: Uint8Array; lines: MarkdownLine[] } {
  const mask = new Uint8Array(text.length);
  const lines = markdownLines(text);
  let fence: { character: "`" | "~"; length: number } | undefined;
  const block = (start: number, end: number) => mask.fill(1, start, end);

  for (const line of lines) {
    const indent = indentation(line.raw);
    const blockquote = indent.columns <= 3 && line.raw[indent.characters] === ">";
    const candidate = line.raw.slice(indent.characters);

    if (fence) {
      block(line.start, line.end);
      if (!blockquote && indent.columns <= 3) {
        const closingLength = runLength(candidate, 0, fence.character);
        if (closingLength >= fence.length && candidate.slice(closingLength).trim() === "") {
          fence = undefined;
        }
      }
      continue;
    }
    if (blockquote || indent.columns >= 4) {
      block(line.start, line.end);
      continue;
    }
    const character = candidate[0];
    if (character !== "`" && character !== "~") continue;
    const openingLength = runLength(candidate, 0, character);
    const information = candidate.slice(openingLength);
    if (openingLength >= 3 && (character === "~" || !information.includes("`"))) {
      fence = { character, length: openingLength };
      block(line.start, line.end);
    }
  }

  const rangeIsClear = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) if (mask[index]) return false;
    return true;
  };

  for (let index = 0; index < text.length;) {
    if (mask[index] || text[index] !== "`") {
      index += 1;
      continue;
    }
    const openingLength = runLength(text, index, "`");
    let search = index + openingLength;
    let close = -1;
    while (search < text.length) {
      const candidate = text.indexOf("`", search);
      if (candidate < 0) break;
      const closingLength = runLength(text, candidate, "`");
      if (closingLength === openingLength && rangeIsClear(candidate, candidate + closingLength)) {
        close = candidate;
        break;
      }
      search = candidate + closingLength;
    }
    if (close < 0) {
      index += openingLength;
      continue;
    }
    block(index, close + openingLength);
    index = close + openingLength;
  }

  return { mask, lines };
}

function scanMarkdown(text: string, remaining: number): MarkdownScan {
  const links: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const { mask, lines } = maskMarkdownCode(text);
  const clear = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) if (mask[index]) return false;
    return true;
  };

  for (const line of lines) {
    if (line.raw === START && clear(line.start, line.start + line.raw.length)) starts.push(line.start);
    if (line.raw === END && clear(line.start, line.start + line.raw.length)) ends.push(line.start);
  }

  for (let index = 0; index < text.length;) {
    if (mask[index]) {
      index += 1;
      continue;
    }
    const begin = text.startsWith("![[", index)
      ? index + 1
      : text.startsWith("[[", index) ? index : -1;
    if (begin < 0) {
      index += 1;
      continue;
    }
    let close = text.indexOf("]]", begin + 2);
    while (close >= 0 && !clear(begin, close + 2)) close = text.indexOf("]]", close + 2);
    if (close < 0) {
      index += 1;
      continue;
    }
    if (links.length >= remaining) return { links, starts, ends, overflow: true };
    links.push(text.slice(begin + 2, close));
    index = close + 2;
  }
  return { links, starts, ends, overflow: false };
}

function linkTarget(raw: string): string | undefined {
  const target = raw.split("|")[0]?.split("#")[0]?.split("^")[0] ?? "";
  return target || undefined;
}

function options(source: string, target: string): string[] {
  const suffix = /\.(?:md|canvas)$/iu.test(target) ? "" : ".md";
  const direct = `${target}${suffix}`;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(source), direct));
  return [...new Set([direct, relative])]
    .filter((value) => value !== ".." && !value.startsWith("../"));
}

function markdownExtensionKey(value: string): string {
  return value.toLocaleLowerCase("en-US").endsWith(".md")
    ? `${value.slice(0, -3)}.md`
    : value;
}

function report(vault: string, findings: Findings): IntegrityReport {
  findings.finish();
  return { vault, checkedAt: new Date().toISOString(), findings: findings.values };
}

export async function auditVaultIntegrity(input: {
  vault: string;
  root: string;
  policy: VaultFoundationPolicy;
  limits?: Partial<IntegrityAuditLimits>;
  fs?: IntegrityAuditFs;
}): Promise<IntegrityReport> {
  if (!input || typeof input.vault !== "string" || typeof input.root !== "string" || !input.policy) {
    throw new Error("integrity audit input is invalid");
  }

  const cap = limits(input.limits);
  const findings = new Findings(cap.maxFindings);
  const fs = input.fs ?? fsNative();
  const inventoryResult = await inventory(fs, input.root, input.policy, cap, findings);
  if (findings.exceeded) return report(input.vault, findings);

  const files = new Map(inventoryResult.files.map((file) => [file.path, file]));
  const extensionPaths = new Map<string, BoundFile[]>();
  for (const file of inventoryResult.files) {
    const extensionKey = markdownExtensionKey(file.path);
    extensionPaths.set(extensionKey, [...(extensionPaths.get(extensionKey) ?? []), file]);
  }
  const required = foundation(input.policy);
  let complete = inventoryResult.complete;
  let parsedBytes = 0;
  let parsedLinks = 0;
  const incoming = new Set<string>();
  const markdown = inventoryResult.files.filter((file) => (
    file.path.toLocaleLowerCase("en-US").endsWith(".md")
  ));

  for (const file of markdown) {
    if (
      file.snapshot.size > BigInt(cap.maxContentBytes)
      || parsedBytes + Number(file.snapshot.size) > cap.maxParsedLinkBytes
    ) {
      findings.limit();
      return report(input.vault, findings);
    }
    let text: string;
    try {
      text = (await read(fs, file, cap.maxContentBytes)).toString("utf8");
    } catch (error) {
      const kind = error instanceof ReadError ? error.kind : failureKind(error);
      findings.add(failureCode(kind), "markdown", file.path);
      complete = false;
      continue;
    }
    parsedBytes += Buffer.byteLength(text);
    const scan = scanMarkdown(text, cap.maxLinks - parsedLinks);
    if (scan.overflow) {
      findings.limit();
      return report(input.vault, findings);
    }
    parsedLinks += scan.links.length;

    if (
      file.path === input.policy.homeMoc
      || input.policy.areas.some((area) => areaMocPath(area) === file.path)
    ) {
      if (
        scan.starts.length !== 1 || scan.ends.length !== 1
        || scan.starts[0]! >= scan.ends[0]!
      ) findings.add("invalid_managed_markers", "note_index", file.path);
    }
    if (findings.exceeded) return report(input.vault, findings);
    if (!complete) continue;

    for (const raw of scan.links) {
      if (raw.startsWith("#") || raw.startsWith("^")) {
        incoming.add(file.path);
        continue;
      }
      const target = linkTarget(raw);
      if (!target) {
        findings.add("broken_link", "wiki_link", file.path);
        continue;
      }
      const choices = options(file.path, target);
      const exactMatches = [...new Set(choices.flatMap((choice) => (
        extensionPaths.get(markdownExtensionKey(choice)) ?? []
      )))];
      if (exactMatches.length === 1) {
        const exact = exactMatches[0]!;
        if (exact.path.toLocaleLowerCase("en-US").endsWith(".md")) incoming.add(exact.path);
        continue;
      }
      if (exactMatches.length > 1) {
        findings.add("ambiguous_link", "wiki_link", file.path);
        continue;
      }
      if (choices.some((choice) => required.markdown.has(markdownExtensionKey(choice)))) continue;
      const basename = path.posix.basename(choices[0] ?? target);
      const basenameKey = markdownExtensionKey(basename);
      const matches = inventoryResult.files.filter((candidate) => (
        markdownExtensionKey(path.posix.basename(candidate.path)) === basenameKey
      ));
      if (matches.length === 1) {
        if (matches[0]!.path.toLocaleLowerCase("en-US").endsWith(".md")) incoming.add(matches[0]!.path);
        continue;
      }
      const near = inventoryResult.files.filter((candidate) => (
        choices.some((choice) => key(choice) === key(candidate.path))
        || key(path.posix.basename(candidate.path)) === key(basename)
      ));
      findings.add(
        matches.length > 1 || near.length > 1 ? "ambiguous_link" : "broken_link",
        "wiki_link",
        file.path,
      );
    }
    if (findings.exceeded) return report(input.vault, findings);
  }

  const normalized = new Map<string, BoundFile[]>();
  for (const file of inventoryResult.files) {
    normalized.set(key(file.path), [...(normalized.get(key(file.path)) ?? []), file]);
  }
  for (const canvasPath of required.canvases) {
    const file = files.get(canvasPath);
    if (!file) continue;
    if (file.snapshot.size > BigInt(cap.maxContentBytes)) {
      findings.limit();
      return report(input.vault, findings);
    }
    let value: unknown;
    try {
      value = JSON.parse((await read(fs, file, cap.maxContentBytes)).toString("utf8"));
    } catch (error) {
      if (error instanceof ReadError) {
        findings.add(failureCode(error.kind), "canvas", canvasPath);
        complete = false;
      } else {
        findings.add("invalid_canvas", "json", canvasPath);
      }
      if (findings.exceeded) return report(input.vault, findings);
      continue;
    }
    if (!validateGeneratedCanvas(value)) {
      findings.add("invalid_canvas", "schema", canvasPath);
      if (findings.exceeded) return report(input.vault, findings);
      continue;
    }
    if (complete) {
      for (const node of value.nodes) {
        const match = files.get(node.file);
        if (
          !match || !match.path.toLocaleLowerCase("en-US").endsWith(".md")
          || (normalized.get(key(node.file)) ?? []).length !== 1
        ) {
          findings.add(
            "canvas_missing_file",
            (normalized.get(key(node.file)) ?? []).length > 1 ? "ambiguous_reference" : "file_reference",
            canvasPath,
          );
        }
      }
    }
    if (findings.exceeded) return report(input.vault, findings);
  }

  if (!complete) findings.suppressIncompleteConclusions();
  if (complete) {
    for (const expected of [...required.markdown, ...required.canvases]) {
      if (!files.has(expected)) findings.add("missing_required_file", "missing", expected);
      if (findings.exceeded) return report(input.vault, findings);
    }
  }
  if (complete) {
    for (const file of markdown) {
      if (
        !required.markdown.has(file.path)
        && !file.path.startsWith(`${input.policy.inbox}/`)
        && !file.path.split("/").some((segment) => segment.startsWith("."))
        && !incoming.has(file.path)
      ) findings.add("orphan_note", "no_inbound_link", file.path);
      if (findings.exceeded) return report(input.vault, findings);
    }
  }
  return report(input.vault, findings);
}
