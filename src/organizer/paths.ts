import { createHash } from "node:crypto";
import path from "node:path";
import { BRAIN_FOUNDATION_POLICY } from "../foundation/policy.js";

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;
const WINDOWS_INVALID_CHARACTER = /[:<>"|?*]/u;
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
// Below common 255-byte component limits; the total cap is below common modern
// Windows long-path and Linux PATH_MAX limits while still allowing five levels.
const MAX_COMPONENT_UTF8_BYTES = 240;
const MAX_FILENAME_UTF8_BYTES = 240;
const MAX_RELATIVE_PATH_UTF8_BYTES = 1_024;
const approvedAreas = new Set(BRAIN_FOUNDATION_POLICY.areas.map((area) => area.directory));
const approvedAreaKeys = new Set([...approvedAreas].map((area) => collisionKey(area)));

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

  const identityPath = value.replaceAll("\\", "/");
  const normalized = identityPath.normalize("NFKC");
  if (
    path.isAbsolute(normalized)
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
  ) {
    throw unsafePath(value);
  }

  const identitySegments = identityPath.split("/");
  const normalizedSegments = identitySegments.map((segment) => segment.normalize("NFKC"));
  if (normalizedSegments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || segment.includes("/")
    || segment.includes("\\")
    || segment.startsWith(".")
    || CONTROL_CHARACTER.test(segment)
    || WINDOWS_INVALID_CHARACTER.test(segment)
    || /[ .]$/u.test(segment)
    || isWindowsReserved(segment)
  ))) {
    throw unsafePath(value);
  }

  if (normalizedSegments.some((segment) => (
    Buffer.byteLength(segment, "utf8") > MAX_COMPONENT_UTF8_BYTES
  ))) {
    throw new Error(`organizer path component exceeds UTF-8 byte limit: ${value}`);
  }
  if (Buffer.byteLength(normalizedSegments.join("/"), "utf8") > MAX_RELATIVE_PATH_UTF8_BYTES) {
    throw new Error(`organizer relative path exceeds UTF-8 byte limit: ${value}`);
  }

  return identitySegments.join("/");
}

function assertDirectoryDepth(relativePath: string): void {
  if (relativePath.split("/").length > BRAIN_FOUNDATION_POLICY.maxDepth) {
    throw unsafePath(relativePath);
  }
}

function assertApprovedAreaPath(value: string, allowEquivalentArea = false): string {
  const normalized = normalizeRelativePath(value);
  assertDirectoryDepth(normalized);
  const area = normalized.split("/", 1)[0];
  const approved = allowEquivalentArea
    ? approvedAreaKeys.has(collisionKey(area))
    : approvedAreas.has(area);
  if (!approved) throw unsafePath(value);
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
  const requested = assertApprovedAreaPath(value, true);
  const requestedKey = collisionKey(requested);
  const matches = [...existingDirectories].flatMap((directory) => {
    try {
      const existing = assertApprovedAreaPath(directory);
      return collisionKey(existing) === requestedKey ? [existing] : [];
    } catch {
      return [];
    }
  });
  if (matches.length > 1) {
    throw new Error(`organizer destination is ambiguous: ${requested}`);
  }
  if (matches.length === 0) throw new Error(`organizer destination does not exist: ${requested}`);
  return matches[0];
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

  const unboundedSlug = normalizedTitle
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "note";
  const slug = truncateUtf8(unboundedSlug, MAX_FILENAME_UTF8_BYTES - 12).replace(/-+$/u, "") || "note";
  return { normalizedTitle, slug };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
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
    const filename = candidate.slice(candidate.lastIndexOf("/") + 1);
    if (Buffer.byteLength(filename.normalize("NFKC"), "utf8") > MAX_FILENAME_UTF8_BYTES) {
      throw new Error("organizer filename exceeds UTF-8 byte limit");
    }
    normalizeRelativePath(candidate);
    if (!occupied.has(collisionKey(candidate))) return candidate;
    attempt += 1;
  }
}
