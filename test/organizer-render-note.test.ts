import { describe, expect, it } from "vitest";
import { renderOrganizedNote } from "../src/organizer/render-note.js";
import type { StoredProposal } from "../src/organizer/types.js";

const proposal = (overrides: Partial<StoredProposal> = {}): StoredProposal => ({
  id: "PRP-test",
  vault: "brain",
  sourcePath: "Agent-Inbox/raw.md",
  sourceHash: "a".repeat(64),
  destinationPath: "20_Study/topic.md",
  policyVersion: "1.0.0",
  createdAt: "2026-09-02T00:00:00.000Z",
  expiresAt: "2026-09-04T00:00:00.000Z",
  status: "pending",
  targetDirectory: "20_Study",
  title: "정리된 제목",
  type: "study",
  tags: ["학습"],
  summary: "쉬운 요약",
  analogy: "일상 비유",
  notes: "추가 설명",
  tips: ["기억할 핵심"],
  warnings: ["주의할 점"],
  relatedNotePaths: ["20_Study/related.md", "20_Study/missing.md"],
  confidence: 0.96,
  reason: "study material",
  ...overrides,
});

const existingNotes = new Set([
  "20_Study/000_Study_MOC.md",
  "20_Study/related.md",
]);

describe("organized note rendering", () => {
  it("preserves user frontmatter fields and the exact original body", () => {
    const source = "---\nsource: lecture\naliases:\n  - old name\n---\n# Raw title\n\n원래 문장입니다.\n";
    const rendered = renderOrganizedNote({
      source,
      proposal: proposal(),
      transactionId: "ORG-test",
      now: "2026-09-03T00:00:00.000Z",
      existingNotePaths: existingNotes,
    });

    expect(rendered).toContain("source: lecture");
    expect(rendered).toContain("aliases:\n  - old name");
    expect(rendered).toContain("organization:\n  managed: true\n  transaction_id: ORG-test\n  confidence: 0.96\n  organized_at: '2026-09-03T00:00:00.000Z'");
    expect(rendered).toContain("> [!abstract] 한눈에 보기");
    expect(rendered).toContain("## 원문\n\n# Raw title\n\n원래 문장입니다.\n");
    expect(rendered.endsWith("# Raw title\n\n원래 문장입니다.\n")).toBe(true);
  });

  it("renders sections in contract order and omits empty optional sections", () => {
    const rendered = renderOrganizedNote({
      source: "사용자 원문\n",
      proposal: proposal({ analogy: undefined, notes: undefined, tips: [], warnings: undefined }),
      transactionId: "ORG-order",
      now: "2026-09-03T00:00:00.000Z",
      existingNotePaths: existingNotes,
    });

    const headings = ["# 정리된 제목", "> [!abstract] 한눈에 보기", "## 연결된 노트", "## 원문"];
    expect(headings.map((heading) => rendered.indexOf(heading))).toEqual(
      [...headings.map((heading) => rendered.indexOf(heading))].sort((a, b) => a - b),
    );
    expect(rendered).not.toContain("[!example]");
    expect(rendered).not.toContain("[!note]");
    expect(rendered).not.toContain("[!tip]");
    expect(rendered).not.toContain("[!warning]");
  });

  it("neutralizes provider HTML, embeds, images, links, and heading injection as readable text", () => {
    const unsafe = "<iframe src=x></iframe>\n<b>raw</b> ![[embed]] [[invented]] ![pixel](https://evil.example/x) [run](javascript:alert(1))";
    const rendered = renderOrganizedNote({
      source: "원문에는 ![[사용자-임베드]]와 <span>사용자 HTML</span>이 있습니다.\n",
      proposal: proposal({
        title: "제목\n---\nevil: true",
        summary: unsafe,
        analogy: unsafe,
        notes: unsafe,
        tips: [unsafe],
        warnings: [unsafe],
      }),
      transactionId: "ORG-unsafe:\nnot_yaml: true",
      now: "2026-09-03T00:00:00.000Z",
      existingNotePaths: existingNotes,
    });

    const generated = rendered.slice(0, rendered.indexOf("## 원문"));
    expect(generated).not.toContain("<iframe");
    expect(generated).not.toContain("<b>");
    expect(generated).not.toMatch(/(^|[^\\])!\[\[embed\]\]/u);
    expect(generated).not.toMatch(/(^|[^\\])\[\[invented\]\]/u);
    expect(generated).not.toMatch(/(^|[^\\])!\[pixel\]\(https:\/\/evil\.example\/x\)/u);
    expect(generated).not.toMatch(/(^|[^\\])\[run\]\(javascript:alert\(1\)\)/u);
    expect(generated).toContain("&lt;iframe src=x&gt;&lt;/iframe&gt;");
    expect(generated).toContain("\\![[embed]]");
    expect(generated).toContain("\\[[invented]]");
    expect(generated).toContain("\\![pixel](https://evil.example/x)");
    expect(generated).toContain("\\[run](javascript:alert(1))");
    expect(generated).toContain("# 제목 --- evil: true");
    expect(rendered).toContain("## 원문\n\n원문에는 ![[사용자-임베드]]와 <span>사용자 HTML</span>이 있습니다.\n");
  });

  it("emits only real candidate links plus the destination area's real parent MOC", () => {
    const rendered = renderOrganizedNote({
      source: "body\n",
      proposal: proposal({ relatedNotePaths: ["20_Study/related.md", "20_Study/missing.md", "20_Study/related.md"] }),
      transactionId: "ORG-links",
      now: "2026-09-03T00:00:00.000Z",
      existingNotePaths: existingNotes,
    });

    expect(rendered).toContain("- 상위 목차: [[20_Study/000_Study_MOC]]");
    expect(rendered).toContain("- 관련 개념: [[20_Study/related]]");
    expect(rendered.match(/관련 개념:/gu)).toHaveLength(1);
    expect(rendered).not.toContain("missing");
  });

  it("fails closed when the parent MOC is absent or the existing-path set is ambiguous", () => {
    const input = {
      source: "body\n",
      proposal: proposal(),
      transactionId: "ORG-paths",
      now: "2026-09-03T00:00:00.000Z",
    };

    expect(() => renderOrganizedNote({ ...input, existingNotePaths: new Set(["20_Study/related.md"]) })).toThrow(/parent MOC/i);
    expect(() => renderOrganizedNote({
      ...input,
      existingNotePaths: new Set(["20_Study/000_Study_MOC.md", "20_Study/Related.md", "20_Study/related.md"]),
    })).toThrow(/ambiguous|collision/i);
  });

  it("rejects an unsafe destination rather than deriving a parent from its prefix", () => {
    expect(() => renderOrganizedNote({
      source: "body\n",
      proposal: proposal({ destinationPath: "20_Study/../outside.md" }),
      transactionId: "ORG-destination",
      now: "2026-09-03T00:00:00.000Z",
      existingNotePaths: existingNotes,
    })).toThrow(/destination|path/i);
  });

  it("is deterministic for the same source and validated proposal", () => {
    const input = {
      source: "body\r\n",
      proposal: proposal(),
      transactionId: "ORG-stable",
      now: "2026-09-03T00:00:00.000Z",
      existingNotePaths: existingNotes,
    };
    expect(renderOrganizedNote(input)).toBe(renderOrganizedNote(input));
  });
});
