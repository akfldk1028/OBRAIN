import { createHash } from "node:crypto";
import path from "node:path";
import { BRAIN_FOUNDATION_POLICY } from "../foundation/policy.js";

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;
const WINDOWS_INVALID_CHARACTER = /[:<>"|?*]/u;
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
const approvedAreas = new Set(BRAIN_FOUNDATION_POLICY.areas.map((area) => area.directory));

function unsafePath(value: string): Error {
  return new Error(`organizer path is unsafe: ${value}`);
}

function isWindowsReserved(segment: string): boolean {
  const windowsName = segment.replace(/[ .]+$/u, "");
  const basename = windowsName.split(".", 1)[0].replace(/[ .]+$/u, "");
  return WINDOWS_RESERVED_BASENAME.test(basename);
}

function normalizeRelativePath(value: string): string {
  if (!value || CONTROL_CHARACTER.test(value)) throw unsafePath(value);

  const normalized = value.normalize("NFKC").replaceAll("\\", "/");
  if (
    path.isAbsolute(normalized)
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
  ) {
    throw unsafePath(value);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || segment.startsWith(".")
    || CONTROL_CHARACTER.test(segment)
    || WINDOWS_INVALID_CHARACTER.test(segment)
    || /[ .]$/u.test(segment)
    || isWindowsReserved(segment)
  ))) {
    throw unsafePath(value);
  }

  return segments.join("/");
}

function assertDirectoryDepth(relativePath: string): void {
  if (relativePath.split("/").length > BRAIN_FOUNDATION_POLICY.maxDepth) {
    throw unsafePath(relativePath);
  }
}

function assertApprovedAreaPath(value: string): string {
  const normalized = normalizeRelativePath(value);
  assertDirectoryDepth(normalized);
  if (!approvedAreas.has(normalized.split("/", 1)[0])) throw unsafePath(value);
  return normalized;
}

export function assertInboxSource(value: string): string {
  const normalized = normalizeRelativePath(value);
  const segments = normalized.split("/");
  const directoryDepth = segments.length - 1;
  if (
    segments.length < 2
    || segments[0] !== BRAIN_FOUNDATION_POLICY.inbox
    || directoryDepth > BRAIN_FOUNDATION_POLICY.maxDepth
    || path.posix.extname(segments.at(-1) ?? "").toLocaleLowerCase("en-US") !== ".md"
  ) {
    throw unsafePath(value);
  }
  return normalized;
}

export function assertApprovedDestination(
  value: string,
  existingDirectories: ReadonlySet<string>,
): string {
  const normalized = assertApprovedAreaPath(value);
  const exists = [...existingDirectories].some((directory) => {
    try {
      return normalizeRelativePath(directory) === normalized;
    } catch {
      return false;
    }
  });
  if (!exists) throw new Error(`organizer destination does not exist: ${normalized}`);
  return normalized;
}

function collisionKey(value: string): string {
  return value.normalize("NFKC").replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

function titleSlug(title: string): { normalizedTitle: string; slug: string } {
  if (CONTROL_CHARACTER.test(title)) throw new Error("organizer title contains a control character");
  const normalizedTitle = title.normalize("NFKC").trim();
  if (!normalizedTitle) throw new Error("organizer title must not be empty");

  const slug = Array.from(normalizedTitle
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, ""))
    .slice(0, 80)
    .join("")
    .replace(/-+$/u, "") || "note";
  return { normalizedTitle, slug };
}

export function buildDestinationPath(
  destinationDirectory: string,
  title: string,
  existingPaths: ReadonlySet<string>,
): string {
  const directory = assertApprovedAreaPath(destinationDirectory);
  const { normalizedTitle, slug } = titleSlug(title);
  const occupied = new Set([...existingPaths].map(collisionKey));

  let attempt = 0;
  while (true) {
    const hashInput = attempt === 0 ? normalizedTitle : `${normalizedTitle}\u0000${attempt}`;
    const candidate = `${directory}/${slug}-${digest(hashInput)}.md`;
    if (!occupied.has(collisionKey(candidate))) return candidate;
    attempt += 1;
  }
}
