import { constants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { validateGeneratedCanvas } from "../foundation/canvas.js";
import { areaCanvasPath, areaGuidePath, areaMocPath, type VaultFoundationPolicy } from "../foundation/policy.js";
import type { IntegrityFinding, IntegrityFindingCode, IntegrityReport } from "./types.js";

export interface IntegrityAuditLimits { maxDirectories: number; maxFiles: number; maxInventoryBytes: number; maxContentBytes: number; maxParsedLinkBytes: number; maxLinks: number; maxFindings: number; }
export const INTEGRITY_AUDIT_DEFAULTS: IntegrityAuditLimits = Object.freeze({ maxDirectories: 4096, maxFiles: 8192, maxInventoryBytes: 16_777_216, maxContentBytes: 2_097_152, maxParsedLinkBytes: 8_388_608, maxLinks: 16_384, maxFindings: 2_048 });
export interface IntegrityAuditFs { lstat(pathname: string): Promise<BigIntStats>; realpath(pathname: string): Promise<string>; readdir(pathname: string): Promise<Dirent[]>; open(pathname: string, flags: number): Promise<FileHandle>; }
interface BoundDirectory { pathname: string; canonicalPath: string; snapshot: BigIntStats; label: string; }
interface BoundFile { pathname: string; canonicalPath: string; snapshot: BigIntStats; lineage: readonly BoundDirectory[]; path: string; }
interface MarkdownScan { links: string[]; starts: number[]; ends: number[]; overflow: boolean; }

const START = "<!-- brain-auto:start note-index -->";
const END = "<!-- brain-auto:end note-index -->";
const TEMP = /(?:^|[._-])(?:tmp|temp|partial|part|swp|swo)(?:[._-]|$)/iu;
const INVALID = /[:<>"|?*\u0000-\u001f\u007f-\u009f]/u;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const cmp = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const key = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US");
const gone = (e: unknown) => ["ENOENT", "ENOTDIR", "ELOOP"].includes((e as NodeJS.ErrnoException).code ?? "");
const denied = (e: unknown) => gone(e) || ["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "");
const outside = (parent: string, child: string) => { const r = path.relative(parent, child); return r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r); };
const inside = (parent: string, child: string) => child !== parent && !outside(parent, child);
const sameId = (a: BigIntStats, b: BigIntStats) => (a.dev === 0n && a.ino === 0n && b.dev === 0n && b.ino === 0n) || a.dev === b.dev && a.ino === b.ino;
const sameDir = (a: BigIntStats, b: BigIntStats) => a.isDirectory() && b.isDirectory() && sameId(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
const sameFile = (a: BigIntStats, b: BigIntStats) => a.isFile() && b.isFile() && sameId(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
class RaceError extends Error {}
class ReadError extends Error { constructor(readonly kind: "changed" | "unreadable") { super(kind); } }

class Findings {
  values: IntegrityFinding[] = []; private hitLimit = false;
  constructor(private readonly max: number) {}
  add(code: IntegrityFindingCode, category: string, pathValue: string): void {
    if (this.values.some((f) => f.code === code && f.category === category && f.path === pathValue)) return;
    if (this.values.length >= this.max - 1) { this.hitLimit = true; return; }
    this.values.push({ code, category, path: pathValue });
  }
  get exceeded(): boolean { return this.hitLimit; }
  finish(): boolean { if (this.hitLimit) this.values.push({ code: "audit_limit_exceeded", category: "findings", path: "." }); this.values.sort((a, b) => cmp(a.path, b.path) || cmp(a.code, b.code) || cmp(a.category, b.category)); return this.hitLimit; }
}

function limits(partial: Partial<IntegrityAuditLimits> | undefined): IntegrityAuditLimits { const result = { ...INTEGRITY_AUDIT_DEFAULTS, ...partial }; if (Object.values(result).some((v) => !Number.isSafeInteger(v) || v < 1)) throw new Error("integrity audit limit is invalid"); return result; }
function fsNative(): IntegrityAuditFs { return { lstat: (p) => lstat(p, { bigint: true }), realpath, readdir: (p) => readdir(p, { withFileTypes: true }) as Promise<Dirent[]>, open }; }
function foundation(policy: VaultFoundationPolicy) { return { markdown: new Set([policy.rootGuide, policy.homeMoc, ...policy.areas.flatMap((a) => [areaMocPath(a), areaGuidePath(a)])]), canvases: new Set([policy.brainCanvas, ...policy.areas.map(areaCanvasPath)]) }; }

async function bindDir(fs: IntegrityAuditFs, pathname: string, before: BigIntStats, label: string, parent?: BoundDirectory): Promise<BoundDirectory> {
  if (before.isSymbolicLink() || !before.isDirectory()) throw new RaceError();
  const canonicalPath = await fs.realpath(pathname); const after = await fs.lstat(pathname); const resolved = await fs.lstat(canonicalPath);
  if (after.isSymbolicLink() || !sameDir(before, after) || !sameDir(before, resolved) || parent && !inside(parent.canonicalPath, canonicalPath)) throw new RaceError();
  return { pathname, canonicalPath, snapshot: before, label };
}
async function revalidate(fs: IntegrityAuditFs, lineage: readonly BoundDirectory[]): Promise<void> {
  let parent: BoundDirectory | undefined;
  for (const original of lineage) { const now = await fs.lstat(original.pathname); const bound = await bindDir(fs, original.pathname, now, original.label, parent); if (bound.canonicalPath !== original.canonicalPath || !sameDir(bound.snapshot, original.snapshot)) throw new RaceError(); parent = bound; }
}
async function bindFile(fs: IntegrityAuditFs, pathname: string, before: BigIntStats, parent: BoundDirectory): Promise<string> {
  if (before.isSymbolicLink() || !before.isFile()) throw new RaceError();
  const canonical = await fs.realpath(pathname); const after = await fs.lstat(pathname); const resolved = await fs.lstat(canonical);
  if (after.isSymbolicLink() || !sameFile(before, after) || !sameFile(before, resolved) || !inside(parent.canonicalPath, canonical)) throw new RaceError();
  return canonical;
}
function classification(relative: string, directory: boolean, policy: VaultFoundationPolicy): [IntegrityFindingCode, string] | undefined {
  const segments = relative.split("/"); const normal = segments.map((v) => v.normalize("NFKC")); const name = segments.at(-1) ?? ""; const normalized = normal.at(-1) ?? "";
  if (segments.some((v, i) => Buffer.byteLength(v) > 240 || Buffer.byteLength(normal[i] ?? "") > 240) || Buffer.byteLength(relative) > 1024 || Buffer.byteLength(normal.join("/")) > 1024) return ["invalid_path", "path_bytes"];
  if (normal.some((v) => !v || v.includes("/") || v.includes("\\") || v === "." || v === ".." || INVALID.test(v) || /[ .]$/u.test(v) || RESERVED.test(v))) return ["invalid_path", "unsafe_name"];
  if (name !== normalized) return ["invalid_path", "nfkc"];
  const lower = name.toLocaleLowerCase("en-US");
  if (name === ".obsidian") return ["forbidden_artifact", "application"];
  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) return ["forbidden_artifact", "environment"];
  if (/\.(?:key|pem|p8|p12|pfx)$/iu.test(name) || /^(?:id_rsa|id_ed25519|credentials(?:\.json)?|oauth-clients\.json|secrets?)$/iu.test(name)) return ["forbidden_artifact", "key"];
  if (name.startsWith("~") || name.endsWith("~") || TEMP.test(lower) || /\.(?:tmp|temp|partial|swp|swo)$/iu.test(name) || lower.includes("sync-conflict")) return ["forbidden_artifact", "temporary"];
  if (name.startsWith(".")) return ["forbidden_artifact", "hidden"];
  const allowedTop = new Set([policy.inbox, ...policy.areas.map((a) => a.directory), policy.rootGuide, policy.homeMoc, policy.brainCanvas]);
  if (segments.length === 1 && !allowedTop.has(name)) return ["invalid_path", "unapproved_top_level"];
  if (directory && !new Set([policy.inbox, ...policy.areas.map((a) => a.directory)]).has(segments[0] ?? "")) return ["invalid_path", "unapproved_top_level"];
  return undefined;
}
function tooDeep(relative: string, directory: boolean, policy: VaultFoundationPolicy): boolean { return relative.split("/").length - (directory ? 0 : 1) > policy.maxDepth; }

async function inventory(fs: IntegrityAuditFs, rootName: string, policy: VaultFoundationPolicy, cap: IntegrityAuditLimits, findings: Findings): Promise<{ files: BoundFile[]; complete: boolean }> {
  const files: BoundFile[] = []; let complete = true; let directories = 0; let bytes = 0n; let initial: BigIntStats;
  try { initial = await fs.lstat(rootName); } catch { findings.add("unreadable_file", "root", "."); return { files, complete: false }; }
  let root: BoundDirectory; try { root = await bindDir(fs, rootName, initial, "integrity root"); } catch { findings.add("unsafe_link", "root", "."); return { files, complete: false }; }
  const queue: Array<{ bound: BoundDirectory; parts: string[]; lineage: BoundDirectory[] }> = [{ bound: root, parts: [], lineage: [root] }];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!; try { await revalidate(fs, current.lineage); } catch { findings.add("changed_file", "ancestor", current.parts.join("/") || "."); complete = false; continue; }
    let entries: Dirent[]; try { entries = await fs.readdir(current.bound.canonicalPath); } catch (error) { findings.add(denied(error) ? "unreadable_file" : "changed_file", "directory", current.parts.join("/") || "."); complete = false; continue; }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const entry of entries) {
      const parts = [...current.parts, entry.name]; const relative = parts.join("/"); const pathname = path.join(current.bound.canonicalPath, entry.name); let stat: BigIntStats;
      try { stat = await fs.lstat(pathname); } catch (error) { findings.add(denied(error) ? "unreadable_file" : "changed_file", "entry", relative); complete = false; continue; }
      if (stat.isSymbolicLink()) { findings.add("unsafe_link", "symlink", relative); continue; }
      const directory = stat.isDirectory(); const invalid = classification(relative, directory, policy); if (invalid) { findings.add(...invalid, relative); if (directory) continue; }
      if (tooDeep(relative, directory, policy)) { findings.add("max_depth", "depth", relative); if (directory) continue; }
      if (directory) { if (directories === cap.maxDirectories) { findings.add("audit_limit_exceeded", "directories", relative); complete = false; break; } directories += 1; try { const child = await bindDir(fs, pathname, stat, `integrity directory ${relative}`, current.bound); queue.push({ bound: child, parts, lineage: [...current.lineage, child] }); } catch { findings.add("unsafe_link", "directory", relative); complete = false; } continue; }
      if (!stat.isFile()) { findings.add("invalid_path", "unsupported_filesystem_type", relative); continue; }
      if (files.length === cap.maxFiles) { findings.add("audit_limit_exceeded", "files", relative); complete = false; break; }
      if (bytes + stat.size > BigInt(cap.maxInventoryBytes)) { findings.add("audit_limit_exceeded", "inventory_bytes", relative); complete = false; break; }
      try { const canonicalPath = await bindFile(fs, pathname, stat, current.bound); files.push({ pathname, canonicalPath, snapshot: stat, lineage: current.lineage, path: relative }); bytes += stat.size; if (/^000_[^/]+_Map\.canvas$/iu.test(entry.name) && !foundation(policy).canvases.has(relative)) findings.add("forbidden_artifact", "unapproved_managed_canvas", relative); } catch { findings.add("unsafe_link", "file", relative); complete = false; }
    }
  }
  return { files, complete };
}
async function read(fs: IntegrityAuditFs, file: BoundFile, max: number): Promise<Buffer> {
  try {
    await revalidate(fs, file.lineage); const before = await fs.lstat(file.pathname); const canonical = await bindFile(fs, file.pathname, before, file.lineage.at(-1)!); if (canonical !== file.canonicalPath || !sameFile(before, file.snapshot)) throw new RaceError();
    const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { const opened = await handle.stat({ bigint: true }); if (!sameFile(opened, file.snapshot) || opened.size > BigInt(max)) throw new RaceError(); await revalidate(fs, file.lineage); const buf = Buffer.alloc(Number(opened.size)); let offset = 0; while (offset < buf.length) { const got = await handle.read(buf, offset, buf.length - offset, offset); if (!got.bytesRead) break; offset += got.bytesRead; } const after = await handle.stat({ bigint: true }); await revalidate(fs, file.lineage); const final = await fs.lstat(file.pathname); await bindFile(fs, file.pathname, final, file.lineage.at(-1)!); if (offset !== buf.length || !sameFile(after, file.snapshot) || !sameFile(final, file.snapshot)) throw new RaceError(); return buf; } finally { await handle.close(); }
  } catch (error) { throw new ReadError(error instanceof RaceError || gone(error) ? "changed" : denied(error) ? "unreadable" : "changed"); }
}
function scanMarkdown(text: string, remaining: number): MarkdownScan {
  const links: string[] = []; const starts: number[] = []; const ends: number[] = []; let fence: { char: "`" | "~"; count: number } | undefined; let offset = 0;
  for (const line of text.split(/\r?\n/u)) {
    const quote = /^\s{0,3}>/u.test(line); const indent = /^(?: {4}|\t)/u.test(line); const opener = !quote && !indent ? /^ {0,3}(`{3,}|~{3,})/u.exec(line) : undefined;
    if (fence) { if (!quote && !indent && new RegExp(`^ {0,3}${fence.char}{${fence.count},}\\s*$`, "u").test(line)) fence = undefined; offset += line.length + 1; continue; }
    if (opener) { fence = { char: opener[1]![0] as "`" | "~", count: opener[1]!.length }; offset += line.length + 1; continue; }
    if (!quote && !indent) { if (line === START) starts.push(offset); if (line === END) ends.push(offset); for (let i = 0; i < line.length;) { if (line[i] === "`") { let size = 1; while (line[i + size] === "`") size += 1; const close = line.indexOf("`".repeat(size), i + size); i = close < 0 ? line.length : close + size; continue; } const begin = line.startsWith("![[", i) ? i + 1 : line.startsWith("[[", i) ? i : -1; if (begin >= 0) { const close = line.indexOf("]]", begin + 2); if (close >= 0) { if (links.length === remaining) return { links, starts, ends, overflow: true }; links.push(line.slice(begin + 2, close)); i = close + 2; continue; } } i += 1; } }
    offset += line.length + 1;
  }
  return { links, starts, ends, overflow: false };
}
function linkTarget(raw: string): string | undefined { const target = raw.split("|")[0]?.split("#")[0]?.split("^")[0] ?? ""; return target || undefined; }
function options(source: string, target: string): string[] { const suffix = /\.(?:md|canvas)$/iu.test(target) ? "" : ".md"; const direct = `${target}${suffix}`; const relative = path.posix.normalize(path.posix.join(path.posix.dirname(source), direct)); return [...new Set([direct, relative])].filter((v) => v !== ".." && !v.startsWith("../")); }

export async function auditVaultIntegrity(input: { vault: string; root: string; policy: VaultFoundationPolicy; limits?: Partial<IntegrityAuditLimits>; fs?: IntegrityAuditFs }): Promise<IntegrityReport> {
  if (!input || typeof input.vault !== "string" || typeof input.root !== "string" || !input.policy) throw new Error("integrity audit input is invalid");
  const cap = limits(input.limits); const findings = new Findings(cap.maxFindings); const fs = input.fs ?? fsNative(); const inventoryResult = await inventory(fs, input.root, input.policy, cap, findings); const files = new Map(inventoryResult.files.map((f) => [f.path, f])); const required = foundation(input.policy); let complete = inventoryResult.complete; let parsedBytes = 0; let parsedLinks = 0; const incoming = new Set<string>(); const markdown = inventoryResult.files.filter((f) => f.path.toLocaleLowerCase("en-US").endsWith(".md"));
  for (const file of markdown) {
    if (file.snapshot.size > BigInt(cap.maxContentBytes) || parsedBytes + Number(file.snapshot.size) > cap.maxParsedLinkBytes) { findings.add("audit_limit_exceeded", "content_bytes", file.path); complete = false; break; }
    let text: string; try { text = (await read(fs, file, cap.maxContentBytes)).toString("utf8"); } catch (error) { findings.add(error instanceof ReadError && error.kind === "unreadable" ? "unreadable_file" : "changed_file", "markdown", file.path); complete = false; continue; }
    parsedBytes += Buffer.byteLength(text); const scan = scanMarkdown(text, cap.maxLinks - parsedLinks); if (scan.overflow) { findings.add("audit_limit_exceeded", "links", file.path); complete = false; break; } parsedLinks += scan.links.length;
    if (file.path === input.policy.homeMoc || input.policy.areas.some((a) => areaMocPath(a) === file.path)) if (scan.starts.length !== 1 || scan.ends.length !== 1 || scan.starts[0]! >= scan.ends[0]!) findings.add("invalid_managed_markers", "note_index", file.path);
    if (!complete) continue;
    for (const raw of scan.links) { if (raw.startsWith("#") || raw.startsWith("^")) { incoming.add(file.path); continue; } const target = linkTarget(raw); if (!target) { findings.add("broken_link", "wiki_link", file.path); continue; } const choices = options(file.path, target); const exact = choices.find((v) => files.has(v)); if (exact) { if (exact.toLocaleLowerCase("en-US").endsWith(".md")) incoming.add(exact); continue; } if (choices.some((v) => required.markdown.has(v))) continue; const basename = path.posix.basename(choices[0] ?? target); const matches = inventoryResult.files.filter((f) => path.posix.basename(f.path) === basename); if (matches.length === 1) { if (matches[0]!.path.endsWith(".md")) incoming.add(matches[0]!.path); continue; } const near = inventoryResult.files.filter((f) => choices.some((v) => key(v) === key(f.path)) || key(path.posix.basename(f.path)) === key(basename)); findings.add(matches.length > 1 || near.length > 1 ? "ambiguous_link" : "broken_link", "wiki_link", file.path); }
  }
  if (findings.exceeded) complete = false;
  if (complete) for (const expected of [...required.markdown, ...required.canvases]) if (!files.has(expected)) findings.add("missing_required_file", "missing", expected);
  const normal = new Map<string, BoundFile[]>(); for (const f of inventoryResult.files) normal.set(key(f.path), [...(normal.get(key(f.path)) ?? []), f]);
  for (const canvasPath of required.canvases) { const file = files.get(canvasPath); if (!file) continue; let value: unknown; try { value = JSON.parse((await read(fs, file, cap.maxContentBytes)).toString("utf8")); } catch (error) { findings.add("invalid_canvas", error instanceof ReadError ? error.kind : "json", canvasPath); continue; } if (!validateGeneratedCanvas(value)) { findings.add("invalid_canvas", "schema", canvasPath); continue; } for (const node of value.nodes) { const match = files.get(node.file); if (!match || !match.path.endsWith(".md") || (normal.get(key(node.file)) ?? []).length !== 1) findings.add("canvas_missing_file", (normal.get(key(node.file)) ?? []).length > 1 ? "ambiguous_reference" : "file_reference", canvasPath); } }
  if (findings.exceeded) complete = false;
  if (complete) for (const file of markdown) if (!required.markdown.has(file.path) && !file.path.startsWith(`${input.policy.inbox}/`) && !file.path.split("/").some((s) => s.startsWith(".")) && !incoming.has(file.path)) findings.add("orphan_note", "no_inbound_link", file.path);
  findings.finish(); return { vault: input.vault, checkedAt: new Date().toISOString(), findings: findings.values };
}
