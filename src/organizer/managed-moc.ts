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

  const keys = new Set<string>();
  const entries = links.map((link) => {
    if (!link || typeof link !== "object") throw new Error("managed MOC link is invalid");
    const key = collisionKey(link.path);
    if (keys.has(key)) throw new Error(`managed MOC link collision is ambiguous: ${link.path}`);
    keys.add(key);
    return { path: validatePath(link.path), title: safeTitle(link.title), key };
  }).sort((left, right) => left.key.localeCompare(right.key, "en-US") || left.path.localeCompare(right.path, "en-US"));

  const replacement = entries.length
    ? `${entries.map((link) => `- [[${link.path}|${link.title}]]`).join(newline)}${newline}`
    : "";
  return `${existing.slice(0, contentStart)}${replacement}${existing.slice(end.start)}`;
}
