import { createHash } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";

export interface ParsedNote {
  vaultId: string;
  path: string;
  title: string;
  body: string;
  excerpt: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  headings: string[];
  outgoingLinks: string[];
  mtimeMs: number;
  size: number;
  contentHash: string;
  metadataError?: string;
}

export function parseNote(
  vaultId: string,
  relativePath: string,
  content: string,
  stat: { mtimeMs: number; size: number },
): ParsedNote {
  let body = content;
  let frontmatter: Record<string, unknown> = {};
  let metadataError: string | undefined;
  try {
    const parsed = matter(content);
    body = parsed.content;
    frontmatter = parsed.data;
  } catch {
    metadataError = "Malformed frontmatter";
  }

  const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].trim());
  const inlineTags = [...body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((match) => match[1]);
  const rawFrontmatterTags = frontmatter.tags;
  const frontmatterTags = Array.isArray(rawFrontmatterTags)
    ? rawFrontmatterTags.map(String)
    : rawFrontmatterTags == null
      ? []
      : [String(rawFrontmatterTags)];
  const wikiLinks = [...body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)]
    .map((match) => match[1].trim());
  const markdownLinks = [...body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].split("#", 1)[0].trim());
  const fallbackTitle = path.basename(relativePath, path.extname(relativePath));

  return {
    vaultId,
    path: relativePath.split(path.sep).join("/"),
    title: headings[0] ?? fallbackTitle,
    body,
    excerpt: body.replace(/\s+/g, " ").trim().slice(0, 400),
    frontmatter,
    tags: [...new Set([...frontmatterTags, ...inlineTags])].sort(),
    headings,
    outgoingLinks: [...new Set([...wikiLinks, ...markdownLinks].filter(Boolean))].sort(),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    metadataError,
  };
}
