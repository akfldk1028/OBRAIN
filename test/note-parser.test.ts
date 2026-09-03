import { describe, expect, it } from "vitest";
import { parseNote } from "../src/note-parser.js";

describe("parseNote", () => {
  it("extracts frontmatter, tags, headings, and note links", () => {
    const note = parseNote(
      "personal",
      "Projects/계획.md",
      "---\ntags: [업무, ai]\nstatus: active\n---\n# 계획\n본문 #중요 [[아이디어|별칭]] [문서](Guide.md)",
      { mtimeMs: 10, size: 20 },
    );

    expect(note.title).toBe("계획");
    expect(note.tags).toEqual(["ai", "업무", "중요"]);
    expect(note.outgoingLinks).toEqual(["Guide.md", "아이디어"]);
    expect(note.frontmatter.status).toBe("active");
  });

  it("keeps malformed frontmatter searchable as body text", () => {
    const note = parseNote(
      "personal",
      "broken.md",
      "---\ntags: [broken\n---\n복구검색어",
      { mtimeMs: 10, size: 30 },
    );

    expect(note.body).toContain("복구검색어");
    expect(note.metadataError).toMatch(/frontmatter/i);
  });
});
