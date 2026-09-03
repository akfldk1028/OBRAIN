import matter from "gray-matter";
import { z } from "zod";
import { BRAIN_FOUNDATION_POLICY, areaMocPath } from "../foundation/policy.js";
import type { StoredProposal } from "./types.js";

const MAX_SOURCE_BYTES = 1_048_576;
const MAX_EXISTING_PATHS = 4_096;
const UNSAFE_PATH = /[\\\[\]|#\u0000-\u001f\u007f-\u009f]/u;
const WINDOWS_INVALID = /[:<>"?*]/u;

const scalarSchema = z.string().min(1).max(1_024);

function collisionKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

/** Total ordering over UTF-8 bytes; unlike localeCompare, this cannot vary with host ICU data. */
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function comparePaths(left: string, right: string): number {
  return compareUtf8(collisionKey(left), collisionKey(right)) || compareUtf8(left, right);
}

function assertMarkdownPath(value: string): string {
  if (
    !value
    || value !== value.normalize("NFKC")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || UNSAFE_PATH.test(value)
    || WINDOWS_INVALID.test(value)
    || Buffer.byteLength(value, "utf8") > 1_024
  ) throw new Error(`organizer note path is unsafe: ${value}`);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".") || /[ .]$/u.test(segment))) {
    throw new Error(`organizer note path is unsafe: ${value}`);
  }
  if (!value.toLocaleLowerCase("en-US").endsWith(".md")) throw new Error(`organizer note path is not Markdown: ${value}`);
  return value;
}

function validateExistingPaths(paths: ReadonlySet<string>): Set<string> {
  if (!(paths instanceof Set) || paths.size > MAX_EXISTING_PATHS) throw new Error("existing note path set is invalid or exceeds limit");
  const result = new Set<string>();
  const keys = new Set<string>();
  for (const path of paths) {
    const valid = assertMarkdownPath(path);
    const key = collisionKey(valid);
    if (keys.has(key)) throw new Error(`existing note path collision is ambiguous: ${valid}`);
    keys.add(key);
    result.add(valid);
  }
  return result;
}

function assertProviderText(value: string, maxCharacters: number, field: string): string {
  if (typeof value !== "string" || value.length > maxCharacters || Buffer.byteLength(value, "utf8") > maxCharacters * 4) {
    throw new Error(`proposal ${field} exceeds limit`);
  }
  return value;
}

/** Render model-authored prose as readable text without active HTML, embeds, images, or links. */
export function renderSafeMarkdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\\", "&#92;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function singleLine(value: string): string {
  return renderSafeMarkdownText(value).replace(/\r\n?|\n/gu, " ").replace(/\s+/gu, " ").trim();
}

function quoteLines(value: string): string[] {
  return renderSafeMarkdownText(value).trim().split(/\r\n?|\n/gu).map((line) => line ? `> ${line}` : ">");
}

function callout(kind: string, title: string, value: string): string[] {
  return [`> [!${kind}] ${title}`, ...quoteLines(value)];
}

function linkTarget(path: string): string {
  return path.slice(0, -3);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function renderOrganizedNote(input: {
  source: string;
  proposal: StoredProposal;
  transactionId: string;
  now: string;
  existingNotePaths: ReadonlySet<string>;
}): string {
  if (typeof input.source !== "string" || Buffer.byteLength(input.source, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error("source note exceeds limit");
  }
  scalarSchema.parse(input.transactionId);
  scalarSchema.parse(input.now);
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("organized timestamp is invalid");

  const title = singleLine(assertProviderText(input.proposal.title, 200, "title"));
  const summary = assertProviderText(input.proposal.summary, 2_000, "summary").trim();
  if (!title || !summary) throw new Error("proposal title and summary are required");
  if (input.proposal.relatedNotePaths.length > 12) throw new Error("proposal related paths exceed limit");
  if ((input.proposal.tips?.length ?? 0) > 8 || (input.proposal.warnings?.length ?? 0) > 8) throw new Error("proposal callout items exceed limit");

  const destinationPath = assertMarkdownPath(input.proposal.destinationPath);
  const destinationArea = destinationPath.split("/", 1)[0];
  const area = BRAIN_FOUNDATION_POLICY.areas.find((candidate) => candidate.directory === destinationArea);
  if (!area) throw new Error("proposal destination has no approved parent MOC");
  const parentPath = areaMocPath(area);
  const existing = validateExistingPaths(input.existingNotePaths);
  if (!existing.has(parentPath)) throw new Error(`parent MOC does not exist: ${parentPath}`);

  const parsed = matter(input.source);
  const priorOrganization = parsed.data.organization;
  if (priorOrganization !== undefined && !isPlainRecord(priorOrganization)) {
    throw new Error("existing organization frontmatter is malformed");
  }
  const data = {
    ...parsed.data,
    organization: {
      ...(priorOrganization ?? {}),
      managed: true,
      transaction_id: input.transactionId,
      confidence: input.proposal.confidence,
      organized_at: input.now,
    },
  };

  const lines: string[] = [
    `# ${title}`,
    "",
    ...callout("abstract", "한눈에 보기", summary),
  ];

  const optionalCallouts: Array<[string, string, string | undefined]> = [
    ["example", "쉬운 비유", input.proposal.analogy],
    ["note", "추가 설명", input.proposal.notes],
  ];
  for (const [kind, heading, value] of optionalCallouts) {
    if (value !== undefined && value.trim()) {
      lines.push("", ...callout(kind, heading, assertProviderText(value, kind === "note" ? 4_000 : 2_000, kind)));
    }
  }

  const listCallouts: Array<["tip" | "warning", string, string[] | undefined]> = [
    ["tip", "기억할 핵심", input.proposal.tips],
    ["warning", "주의할 점", input.proposal.warnings],
  ];
  for (const [kind, heading, values] of listCallouts) {
    const meaningful = (values ?? []).filter((value) => value.trim()).map((value) => assertProviderText(value, 500, kind));
    if (meaningful.length) {
      const body = meaningful.map((value) => `- ${value}`).join("\n");
      lines.push("", ...callout(kind, heading, body));
    }
  }

  const related = [...new Set(input.proposal.relatedNotePaths)]
    .filter((path) => existing.has(path) && path !== parentPath)
    .sort(comparePaths);
  lines.push("", "## 연결된 노트", "", `- 상위 목차: [[${linkTarget(parentPath)}]]`);
  for (const path of related) lines.push(`- 관련 개념: [[${linkTarget(path)}]]`);
  lines.push("", "## 원문", "");

  const generatedBody = `${lines.join("\n")}\n${parsed.content}`;
  return matter.stringify(generatedBody, data);
}
