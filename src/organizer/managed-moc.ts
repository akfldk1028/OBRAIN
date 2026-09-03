const START = "<!-- brain-auto:start note-index -->";
const END = "<!-- brain-auto:end note-index -->";
const MAX_MOC_BYTES = 2_097_152;
const MAX_LINKS = 4_096;
const UNSAFE_PATH = /[\\\[\]|#\u0000-\u001f\u007f-\u009f]/u;
const WINDOWS_INVALID = /[:<>"?*]/u;

interface Marker {
  start: number;
  end: number;
}

function exactLineMarkers(text: string, marker: string): Marker[] {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(`(^|\\r?\\n)${escaped}(?=\\r?\\n|$)`, "gu");
  const result: Marker[] = [];
  for (const match of text.matchAll(expression)) {
    const prefix = match[1] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    result.push({ start, end: start + marker.length });
  }
  return result;
}

function collisionKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

/** Total ordering over UTF-8 bytes; unlike localeCompare, this cannot vary with host ICU data. */
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertUniformNewlines(value: string): void {
  let style: "lf" | "crlf" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\r") {
      if (value[index + 1] !== "\n") throw new Error("managed MOC newline style contains bare CR");
      if (style === "lf") throw new Error("managed MOC newline styles are mixed");
      style = "crlf";
      index += 1;
    } else if (character === "\n") {
      if (style === "crlf") throw new Error("managed MOC newline styles are mixed");
      style = "lf";
    }
  }
}

function validatePath(path: string): string {
  if (
    !path
    || path !== path.normalize("NFKC")
    || path.startsWith("/")
    || /^[A-Za-z]:/u.test(path)
    || UNSAFE_PATH.test(path)
    || WINDOWS_INVALID.test(path)
    || Buffer.byteLength(path, "utf8") > 1_024
  ) throw new Error(`managed MOC link path is unsafe: ${path}`);
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".") || /[ .]$/u.test(segment))) {
    throw new Error(`managed MOC link path is unsafe: ${path}`);
  }
  if (!path.toLocaleLowerCase("en-US").endsWith(".md")) throw new Error(`managed MOC link path is not Markdown: ${path}`);
  return path;
}

function safeTitle(value: string): string {
  if (typeof value !== "string" || value.length > 1_000 || Buffer.byteLength(value, "utf8") > 4_000) {
    throw new Error("managed MOC title exceeds limit");
  }
  const result = value
    .replace(/\r\n?|\n/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replace(/\s+/gu, " ")
    .trim();
  if (!result) throw new Error("managed MOC title is empty");
  return result;
}

export function replaceManagedMocIndex(existing: string, links: Array<{ path: string; title: string }>): string {
  if (typeof existing !== "string" || Buffer.byteLength(existing, "utf8") > MAX_MOC_BYTES) throw new Error("managed MOC exceeds limit");
  if (!Array.isArray(links) || links.length > MAX_LINKS) throw new Error("managed MOC links exceed limit");
  assertUniformNewlines(existing);

  const starts = exactLineMarkers(existing, START);
  const ends = exactLineMarkers(existing, END);
  if (starts.length !== 1 || ends.length !== 1) throw new Error("managed marker pair must be unique");
  const start = starts[0];
  const end = ends[0];
  if (!start || !end || start.start >= end.start) throw new Error("managed marker pair is malformed or out of order");

  const newline = existing.slice(start.end, start.end + 2) === "\r\n"
    ? "\r\n"
    : existing[start.end] === "\n" ? "\n" : undefined;
  if (!newline) throw new Error("managed marker start line has no line ending");
  const contentStart = start.end + newline.length;
  if (contentStart > end.start) throw new Error("managed marker pair is malformed");

  const spellingByKey = new Map<string, string>();
  for (const link of links) {
    if (!link || typeof link !== "object" || typeof link.path !== "string") throw new Error("managed MOC link is invalid");
    const key = collisionKey(link.path);
    const priorSpelling = spellingByKey.get(key);
    if (priorSpelling !== undefined && priorSpelling !== link.path) {
      throw new Error(`managed MOC link collision is ambiguous: ${link.path}`);
    }
    spellingByKey.set(key, link.path);
  }

  const entriesByKey = new Map<string, { path: string; title: string; key: string }>();
  for (const link of links) {
    const path = validatePath(link.path);
    const title = safeTitle(link.title);
    const key = collisionKey(path);
    const prior = entriesByKey.get(key);
    if (prior) {
      if (prior.path === path && prior.title === title) continue;
      throw new Error(`managed MOC link collision is ambiguous: ${path}`);
    }
    entriesByKey.set(key, { path, title, key });
  }
  const entries = [...entriesByKey.values()].sort((left, right) => (
    compareUtf8(left.key, right.key) || compareUtf8(left.path, right.path) || compareUtf8(left.title, right.title)
  ));

  const replacement = entries.length
    ? `${entries.map((link) => `- [[${link.path}|${link.title}]]`).join(newline)}${newline}`
    : "";
  return `${existing.slice(0, contentStart)}${replacement}${existing.slice(end.start)}`;
}
