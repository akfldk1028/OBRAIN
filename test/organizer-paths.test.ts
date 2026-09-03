import { describe, expect, it } from "vitest";
import {
  assertApprovedDestination,
  assertInboxSource,
  buildDestinationPath,
} from "../src/organizer/paths.js";

describe("organizer paths", () => {
  it("normalizes separators while preserving exact Unicode spelling and five directory levels", () => {
    expect(assertInboxSource("Agent-Inbox\\ＭＤＰ.md")).toBe("Agent-Inbox/ＭＤＰ.md");
    expect(assertInboxSource("Agent-Inbox/a/b/c/d/note.md"))
      .toBe("Agent-Inbox/a/b/c/d/note.md");
  });

  it.each([
    "../outside.md",
    "/etc/passwd",
    "C:\\outside.md",
    "\\\\server\\share\\outside.md",
    "Agent-Inbox\\..\\outside.md",
    "Agent-Inbox/foo／bar.md",
    "Agent-Inbox/foo＼bar.md",
    "Agent-Inbox/./outside.md",
    "Agent-Inbox//outside.md",
    "Agent-Inbox/.hidden/note.md",
    "Agent-Inbox/.obsidian/config.md",
    "Agent-Inbox/.stfolder/state.md",
    "Agent-Inbox/control\u0001.md",
    "Agent-Inbox/CON.md",
    "Agent-Inbox/prn.txt.md",
    "Agent-Inbox/COM9.md",
    "Agent-Inbox/LPT1.notes.md",
    "Agent-Inbox/a/b/c/d/e/note.md",
    "Agent-Inbox/not-markdown.txt",
  ])("rejects an unsafe Inbox source %j", (value) => {
    expect(() => assertInboxSource(value)).toThrow();
  });

  it("requires destinations to be existing directories beneath an approved area", () => {
    const existing = new Set([
      "20_Study/22_RL",
      "20_Study/a/b/c/d",
      "40_Research/ＭＤＰ",
    ]);

    expect(assertApprovedDestination("20_Study\\22_RL", existing)).toBe("20_Study/22_RL");
    expect(assertApprovedDestination("20_Study/a/b/c/d", existing)).toBe("20_Study/a/b/c/d");
    expect(assertApprovedDestination("40_Research/MDP", existing)).toBe("40_Research/ＭＤＰ");
  });

  it("rejects ambiguous case-insensitive NFKC-equivalent existing destinations", () => {
    const existing = new Set(["20_Study/ABC", "20_Study/ａｂｃ"]);

    expect(() => assertApprovedDestination("20_Study/Abc", existing)).toThrow(/ambiguous/i);
  });

  it.each([
    ["20_Study/missing", new Set(["20_Study"])],
    ["20_StudyEvil/topic", new Set(["20_StudyEvil/topic"])],
    ["Agent-Inbox", new Set(["Agent-Inbox"])],
    ["20_Study/.hidden", new Set(["20_Study/.hidden"])],
    ["20_Study/NUL", new Set(["20_Study/NUL"])],
    ["20_Study/a/b/c/d/e", new Set(["20_Study/a/b/c/d/e"])],
    ["20_Study/evil\u0007", new Set(["20_Study/evil\u0007"])],
    ["../20_Study", new Set(["../20_Study"])],
  ] as const)("rejects an unsafe or nonexistent destination %j", (value, existing) => {
    expect(() => assertApprovedDestination(value, existing)).toThrow();
  });

  it("derives deterministic NFKC filenames from titles without accepting path syntax", () => {
    const result = buildDestinationPath("20_Study/22_RL", "  ＭＤＰ　소개/../CON  ", new Set());

    expect(result).toMatch(/^20_Study\/22_RL\/MDP-소개-CON-[a-f0-9]{8}\.md$/);
    expect(buildDestinationPath("20_Study/22_RL", "  ＭＤＰ　소개/../CON  ", new Set()))
      .toBe(result);
  });

  it("avoids destination collisions case-insensitively", () => {
    const first = buildDestinationPath("20_Study/22_RL", "MDP 소개", new Set());
    const occupied = new Set([first.toUpperCase().replaceAll("/", "\\")]);
    const second = buildDestinationPath("20_Study/22_RL", "MDP 소개", occupied);

    expect(second).toMatch(/^20_Study\/22_RL\/MDP-소개-[a-f0-9]{8}\.md$/);
    expect(second.toLocaleLowerCase("en-US")).not.toBe(first.toLocaleLowerCase("en-US"));
  });

  it("rejects empty and control-character titles", () => {
    expect(() => buildDestinationPath("20_Study", "  ", new Set())).toThrow();
    expect(() => buildDestinationPath("20_Study", "bad\u007ftitle", new Set())).toThrow();
  });

  it("enforces normalized UTF-8 component, filename, and total path byte bounds", () => {
    const oversizedComponent = "한".repeat(81);
    expect(() => assertInboxSource(`Agent-Inbox/${oversizedComponent}/note.md`)).toThrow(/byte/i);

    const bounded = buildDestinationPath("20_Study", "한".repeat(100), new Set());
    expect(Buffer.byteLength(pathBasename(bounded).normalize("NFKC"), "utf8")).toBeLessThanOrEqual(240);

    const longSegment = "한".repeat(70);
    const longDestination = `20_Study/${longSegment}/${longSegment}/${longSegment}/${longSegment}`;
    expect(() => buildDestinationPath(longDestination, "한".repeat(100), new Set())).toThrow(/byte/i);
  });

  it("also enforces UTF-8 bounds on exact compatibility-character spelling", () => {
    const exactOversizedButNormalizedShort = "Ａ".repeat(81);
    expect(() => assertInboxSource(`Agent-Inbox/${exactOversizedButNormalizedShort}/note.md`))
      .toThrow(/byte/i);

    const exactLongSegment = "Ａ".repeat(70);
    const exactLongFilename = "Ｂ".repeat(56);
    const exactLongPath = [
      "Agent-Inbox",
      exactLongSegment,
      exactLongSegment,
      exactLongSegment,
      exactLongSegment,
      `${exactLongFilename}.md`,
    ].join("/");
    expect(Buffer.byteLength(exactLongPath, "utf8")).toBeGreaterThan(1_024);
    expect(Buffer.byteLength(exactLongPath.normalize("NFKC"), "utf8")).toBeLessThan(1_024);
    expect(() => assertInboxSource(exactLongPath)).toThrow(/byte/i);
  });
});

function pathBasename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}
