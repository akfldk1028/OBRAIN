import { lstat as nativeLstat, mkdtemp, mkdir, open as nativeOpen, opendir as nativeOpendir, readFile, readdir, realpath as nativeRealpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAreaCanvas, renderBrainCanvas } from "../src/foundation/canvas.js";
import { renderAreaGuide, renderAreaMoc, renderHomeMoc, renderRootGuide } from "../src/foundation/markdown.js";
import { BRAIN_FOUNDATION_POLICY, areaCanvasPath, areaGuidePath, areaMocPath } from "../src/foundation/policy.js";
import { auditVaultIntegrity, type IntegrityAuditFs } from "../src/organizer/integrity.js";

const vaults: string[] = [];
const LIMIT_FINDING = { code: "audit_limit_exceeded", category: "limit", path: "." } as const;

async function writeVaultFile(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function createValidVault(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-integrity-"));
  vaults.push(root);
  await mkdir(path.join(root, BRAIN_FOUNDATION_POLICY.inbox, "검토필요"), { recursive: true });
  await writeVaultFile(root, BRAIN_FOUNDATION_POLICY.rootGuide, renderRootGuide(BRAIN_FOUNDATION_POLICY));
  await writeVaultFile(root, BRAIN_FOUNDATION_POLICY.homeMoc, renderHomeMoc(BRAIN_FOUNDATION_POLICY));
  await writeVaultFile(root, BRAIN_FOUNDATION_POLICY.brainCanvas, renderBrainCanvas(BRAIN_FOUNDATION_POLICY));
  for (const area of BRAIN_FOUNDATION_POLICY.areas) {
    await writeVaultFile(root, areaMocPath(area), renderAreaMoc(area));
    await writeVaultFile(root, areaGuidePath(area), renderAreaGuide(area));
    await writeVaultFile(root, areaCanvasPath(area), renderAreaCanvas(area));
  }
  return root;
}

async function inventoryByteCost(root: string, relative = ""): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path.join(root, ...relative.split("/").filter(Boolean)), { withFileTypes: true })) {
    const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
    total += Buffer.byteLength(entryPath, "utf8");
    if (entry.isDirectory()) total += await inventoryByteCost(root, entryPath);
    else if (entry.isFile()) total += Number((await nativeLstat(path.join(root, ...entryPath.split("/")), { bigint: true })).size);
  }
  return total;
}

async function markdownByteCost(root: string, relative = ""): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path.join(root, ...relative.split("/").filter(Boolean)), { withFileTypes: true })) {
    const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) total += await markdownByteCost(root, entryPath);
    else if (entry.isFile() && entry.name.toLocaleLowerCase("en-US").endsWith(".md")) {
      total += Number((await nativeLstat(path.join(root, ...entryPath.split("/")), { bigint: true })).size);
    }
  }
  return total;
}

function orderedFs(reverse: boolean): IntegrityAuditFs {
  return {
    lstat: (pathname) => nativeLstat(pathname, { bigint: true }),
    realpath: nativeRealpath,
    opendir: async (pathname) => {
      const entries = await readdir(pathname, { withFileTypes: true });
      if (reverse) entries.reverse();
      return {
        async *[Symbol.asyncIterator]() { yield* entries; },
        async close() {},
      };
    },
    open: nativeOpen,
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

afterEach(async () => {
  await Promise.all(vaults.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Vault integrity auditor", () => {
  it("accepts a complete foundation without modifying it", async () => {
    const root = await createValidVault();
    const before = await readFile(path.join(root, BRAIN_FOUNDATION_POLICY.homeMoc), "utf8");

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.vault).toBe("brain");
    expect(report.findings).toEqual([]);
    expect(await readFile(path.join(root, BRAIN_FOUNDATION_POLICY.homeMoc), "utf8")).toBe(before);
  });

  it("does not classify fixed AI-managed organizer Markdown reports as orphan notes", async () => {
    const root = await createValidVault();
    const reportPath = "60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports/RUN-synthetic.md";
    await writeVaultFile(root, reportPath, "# Brain Organizer Run Report\n");

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "orphan_note", path: reportPath }));
  });

  it("reports the documented foundation, link, marker, Canvas, depth, and orphan finding codes in UTF-8 path order", async () => {
    const root = await createValidVault();
    await rm(path.join(root, BRAIN_FOUNDATION_POLICY.rootGuide));
    await writeVaultFile(root, "00_Prompt/broken.md", "[[not-here]]\n");
    await writeVaultFile(root, "00_Prompt/orphan.md", "# alone\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[0]!), "<!-- brain-auto:start note-index -->\n");
    await writeVaultFile(root, BRAIN_FOUNDATION_POLICY.brainCanvas, "not JSON");
    await writeVaultFile(root, areaCanvasPath(BRAIN_FOUNDATION_POLICY.areas[1]!), JSON.stringify({
      nodes: [{ id: "0123456789abcdef", type: "file", file: "01_Development/missing.md", x: 0, y: 0, width: 100, height: 100 }],
      edges: [],
    }));
    await writeVaultFile(root, "20_Study/a/b/c/d/e/too-deep.md", "# deep\n");

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "missing_required_file",
      "invalid_canvas",
      "invalid_managed_markers",
      "broken_link",
      "orphan_note",
      "orphan_note",
      "canvas_missing_file",
      "max_depth",
    ]);
    expect(report.findings.map((finding) => finding.path)).toEqual([
      "000_AI_WORK_GUIDE.md",
      "000_Brain_Map.canvas",
      "00_Prompt/000_Prompt_MOC.md",
      "00_Prompt/broken.md",
      "00_Prompt/broken.md",
      "00_Prompt/orphan.md",
      "01_Development/000_Development_Map.canvas",
      "20_Study/a/b/c/d/e",
    ]);
  });

  it("resolves exact paths before a unique basename and never resolves case or NFKC lookalikes", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, "20_Study/target.md", "# target\n");
    await writeVaultFile(root, "20_Study/links.md", "[[20_Study/target]]\n![[target]]\n[[20_Study/TARGET]]\n[[２０_Study/target]]\n```md\n[[example-only]]\n```\n`![[inline-example]]`\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!)}\n- [[20_Study/links]]\n- [[20_Study/target]]\n`);

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings.filter((finding) => finding.path === "20_Study/links.md").map((finding) => finding.code)).toEqual(["broken_link"]);
    expect(report.findings).not.toContainEqual(expect.objectContaining({ path: "20_Study/links.md", code: "ambiguous_link" }));
  });

  it("reports an ambiguous basename instead of guessing a wiki link", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, "20_Study/one/topic.md", "# one\n");
    await writeVaultFile(root, "40_Research/two/topic.md", "# two\n");
    await writeVaultFile(root, "00_Prompt/links.md", "[[topic]]\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[0]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[0]!)}\n- [[00_Prompt/links]]\n`);

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).toContainEqual(expect.objectContaining({ path: "00_Prompt/links.md", code: "ambiguous_link" }));
  });

  it("treats an embed with an unrecognized extension as an extensionless Markdown target", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, "20_Study/assets/diagram.png", "not an image fixture");
    await writeVaultFile(root, "20_Study/links.md", "![[diagram.png]]\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!)}\n- [[20_Study/links]]\n`);

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).toContainEqual(expect.objectContaining({ path: "20_Study/links.md", code: "broken_link" }));
  });

  it("treats dotted extensionless targets as Markdown and ignores code spans, indented code, blockquotes, and matching fences", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, "20_Study/release.v1.md", "# release\n");
    await writeVaultFile(root, "20_Study/links.md", [
      "[[release.v1]]",
      "````md",
      "[[fenced-example]]",
      "```",
      "[[still-fenced]]",
      "````",
      "``[[span-example]]``",
      "    [[indented-example]]",
      "> [[blockquote-example]]",
    ].join("\n"));
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!)}\n- [[20_Study/links]]\n- [[20_Study/release.v1]]\n`);

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).not.toContainEqual(expect.objectContaining({ path: "20_Study/links.md", code: "broken_link" }));
  });

  it("uses exact marker lines outside code blocks and rejects a reversed marker pair", async () => {
    const root = await createValidVault();
    const area = BRAIN_FOUNDATION_POLICY.areas[0]!;
    await writeVaultFile(root, areaMocPath(area), [
      "<!-- brain-auto:end note-index -->",
      "text <!-- brain-auto:start note-index -->",
      "<!-- brain-auto:start note-index -->",
      "```html",
      "<!-- brain-auto:start note-index -->",
      "<!-- brain-auto:end note-index -->",
      "```",
    ].join("\n"));

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).toContainEqual(expect.objectContaining({ path: areaMocPath(area), code: "invalid_managed_markers" }));
  });

  it("reports a bounded incomplete inventory without deriving missing, orphan, or link conclusions", async () => {
    const root = await createValidVault();

    const report = await auditVaultIntegrity({
      vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY,
      limits: { maxFiles: 1 },
    });

    expect(report.findings).toEqual([LIMIT_FINDING]);
    expect(report.findings.map((finding) => finding.code)).not.toContain("missing_required_file");
    expect(report.findings.map((finding) => finding.code)).not.toContain("orphan_note");
    expect(report.findings.map((finding) => finding.code)).not.toContain("broken_link");
  });

  it.each([
    ["entries", { maxEntries: 1 }],
    ["directories", { maxDirectories: 1 }],
  ])("reports a root-level %s cap without deriving cross-file conclusions", async (_category, limits) => {
    const root = await createValidVault();
    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, limits });

    expect(report.findings).toEqual([LIMIT_FINDING]);
    expect(report.findings.map((finding) => finding.code)).not.toEqual(expect.arrayContaining(["missing_required_file", "orphan_note", "broken_link", "ambiguous_link", "canvas_missing_file"]));
  });

  it("accumulates every relative-path byte and accepts the exact inventory-byte budget", async () => {
    const root = await createValidVault();
    const exact = await inventoryByteCost(root);

    const accepted = await auditVaultIntegrity({
      vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY,
      limits: { maxInventoryBytes: exact },
    });
    const rejected = await auditVaultIntegrity({
      vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY,
      limits: { maxInventoryBytes: exact - 1 },
    });

    expect(accepted.findings).toEqual([]);
    expect(rejected.findings).toEqual([LIMIT_FINDING]);
  });

  it.each([
    ["traversal", "ENOENT", "changed_file"],
    ["traversal", "ESTALE", "changed_file"],
    ["traversal", "EACCES", "unreadable_file"],
    ["traversal", "EPERM", "unreadable_file"],
    ["read", "ENOENT", "changed_file"],
    ["read", "ESTALE", "changed_file"],
    ["read", "EACCES", "unreadable_file"],
    ["read", "EPERM", "unreadable_file"],
  ])("maps %s %s to %s", async (phase, code, expectedCode) => {
    const root = await createValidVault();
    const relative = "20_Study/racy.md";
    const target = path.join(root, ...relative.split("/"));
    await writeVaultFile(root, relative, "# racy\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!)}\n- [[20_Study/racy]]\n`);
    let injected = false;
    const fs: IntegrityAuditFs = {
      lstat: async (pathname) => {
        if (phase === "traversal" && pathname === target && !injected) {
          injected = true;
          throw errno(code);
        }
        return nativeLstat(pathname, { bigint: true });
      },
      realpath: nativeRealpath,
      opendir: (pathname) => nativeOpendir(pathname),
      open: async (pathname, flags) => {
        if (phase === "read" && pathname === target) throw errno(code);
        return nativeOpen(pathname, flags);
      },
    };

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, fs });

    expect(report.findings).toContainEqual(expect.objectContaining({ code: expectedCode, path: relative }));
  });

  it("suppresses earlier cross-file conclusions after a later incomplete read", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, "00_Prompt/a-broken.md", "[[missing-target]]\n");
    await writeVaultFile(root, "99_Archive/z-racy.md", "# unreadable\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[0]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[0]!)}\n- [[00_Prompt/a-broken]]\n`);
    const target = path.join(root, "99_Archive", "z-racy.md");
    const fs: IntegrityAuditFs = {
      ...orderedFs(false),
      open: async (pathname, flags) => {
        if (pathname === target) throw errno("EACCES");
        return nativeOpen(pathname, flags);
      },
    };

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, fs });

    expect(report.findings).toContainEqual(expect.objectContaining({ code: "unreadable_file", path: "99_Archive/z-racy.md" }));
    expect(report.findings.map((finding) => finding.code)).not.toEqual(expect.arrayContaining(["broken_link", "ambiguous_link", "orphan_note", "missing_required_file", "canvas_missing_file"]));
  });

  it("maps a file replaced by a link before its read to unsafe_link", async () => {
    const root = await createValidVault();
    const relative = "20_Study/racy-link.md";
    const target = path.join(root, ...relative.split("/"));
    await writeVaultFile(root, "00_Prompt/a-broken.md", "[[missing-before-link-replacement]]\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[0]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[0]!)}\n- [[00_Prompt/a-broken]]\n`);
    await writeVaultFile(root, relative, "# racy link\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!)}\n- [[20_Study/racy-link]]\n`);
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-integrity-link-stat-"));
    vaults.push(outside);
    const outsideFile = path.join(outside, "outside.md");
    const outsideLink = path.join(outside, "outside-link.md");
    await writeFile(outsideFile, "outside", "utf8");
    await symlink(outsideFile, outsideLink);
    const linkStat = await nativeLstat(outsideLink, { bigint: true });
    let targetStats = 0;
    const fs: IntegrityAuditFs = {
      ...orderedFs(false),
      lstat: async (pathname) => pathname === target && ++targetStats >= 4
        ? linkStat
        : nativeLstat(pathname, { bigint: true }),
    };

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, fs });

    expect(report.findings).toContainEqual(expect.objectContaining({ code: "unsafe_link", path: relative }));
    expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "changed_file", path: relative }));
    expect(report.findings.map((finding) => finding.code)).not.toEqual(expect.arrayContaining(["broken_link", "ambiguous_link", "orphan_note", "missing_required_file", "canvas_missing_file"]));
  });

  it("maps a pre-bind root identity replacement to changed_file without opening the replacement", async () => {
    const root = await createValidVault();
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-integrity-prebind-root-"));
    vaults.push(outside);
    const initial = await nativeLstat(root, { bigint: true });
    const replacement = await nativeLstat(outside, { bigint: true });
    let rootStats = 0;
    let outsideRead = false;
    const fs: IntegrityAuditFs = {
      lstat: async (pathname) => {
        if (pathname === root) return ++rootStats === 1 ? initial : replacement;
        return nativeLstat(pathname, { bigint: true });
      },
      realpath: nativeRealpath,
      opendir: async (pathname) => {
        if (pathname === outside) outsideRead = true;
        return nativeOpendir(pathname);
      },
      open: nativeOpen,
    };

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, fs });

    expect(report.findings).toEqual([{ code: "changed_file", category: "root", path: "." }]);
    expect(outsideRead).toBe(false);
  });

  it("closes the directory handle after a post-opendir identity replacement", async () => {
    const root = await createValidVault();
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-integrity-replacement-"));
    vaults.push(outside);
    const replacement = await nativeLstat(outside, { bigint: true });
    let opened = false;
    let closed = false;
    const fs: IntegrityAuditFs = {
      lstat: async (pathname) => pathname === root && opened ? replacement : nativeLstat(pathname, { bigint: true }),
      realpath: nativeRealpath,
      opendir: async () => {
        opened = true;
        return { async *[Symbol.asyncIterator]() {}, async close() { closed = true; } };
      },
      open: nativeOpen,
    };

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, fs });

    expect(closed).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "changed_file", path: "." }));
  });

  it("closes the directory handle after an iterator permission error", async () => {
    const root = await createValidVault();
    let closed = false;
    const fs: IntegrityAuditFs = {
      lstat: (pathname) => nativeLstat(pathname, { bigint: true }),
      realpath: nativeRealpath,
      opendir: async () => ({
        async *[Symbol.asyncIterator]() { throw errno("EACCES"); },
        async close() { closed = true; },
      }),
      open: nativeOpen,
    };

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, fs });

    expect(closed).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "unreadable_file", path: "." }));
  });

  it("masks multiline inline code only when an exact backtick run closes it", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, "20_Study/exact-span.md", "``\n[[hidden-exact]]\n``\n");
    await writeVaultFile(root, "20_Study/non-exact-span.md", "``\n[[visible-non-exact]]\ntext ``` is a longer run\n");
    await writeVaultFile(root, "20_Study/unmatched-span.md", "`\n[[visible-unmatched]]\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), [
      renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!),
      "- [[20_Study/exact-span]]",
      "- [[20_Study/non-exact-span]]",
      "- [[20_Study/unmatched-span]]",
    ].join("\n"));

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "broken_link", path: "20_Study/exact-span.md" }));
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "broken_link", path: "20_Study/non-exact-span.md" }));
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "broken_link", path: "20_Study/unmatched-span.md" }));
  });

  it("indexes unmatched backtick runs once before masking exact inline spans", async () => {
    const root = await createValidVault();
    const area = BRAIN_FOUNDATION_POLICY.areas[0]!;
    const runCount = 96;
    const unmatchedRuns = Array.from(
      { length: runCount },
      (_, index) => `${"`".repeat(index + 1)} text`,
    ).join(" ");
    await writeVaultFile(root, areaMocPath(area), [
      unmatchedRuns,
      "[[missing-after-unmatched-runs]]",
      "<!-- brain-auto:start note-index -->",
      "<!-- brain-auto:end note-index -->",
      "```md",
      `${"`".repeat(8_192)} [[hidden-in-fence]]`,
      "<!-- brain-auto:start note-index -->",
      "```",
    ].join("\n"));
    const originalIndexOf = String.prototype.indexOf;
    let backtickLookups = 0;
    const indexOf = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
      this: string,
      searchString: string,
      position?: number,
    ) {
      if (searchString === "`") backtickLookups += 1;
      return originalIndexOf.call(this, searchString, position);
    });
    try {
      const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

      expect(report.findings).toContainEqual(expect.objectContaining({ code: "broken_link", path: areaMocPath(area) }));
      expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "invalid_managed_markers", path: areaMocPath(area) }));
      expect(backtickLookups).toBeLessThanOrEqual(runCount * 2);
    } finally {
      indexOf.mockRestore();
    }
  });

  it("ignores a managed marker line inside a multiline inline code span", async () => {
    const root = await createValidVault();
    const area = BRAIN_FOUNDATION_POLICY.areas[0]!;
    await writeVaultFile(root, areaMocPath(area), [
      "`",
      "<!-- brain-auto:start note-index -->",
      "`",
      "<!-- brain-auto:start note-index -->",
      "<!-- brain-auto:end note-index -->",
    ].join("\n"));

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "invalid_managed_markers", path: areaMocPath(area) }));
  });

  it.each([" \t", "  \t", "   \t"])("uses four-column tab stops for %j indented code", async (indent) => {
    const root = await createValidVault();
    await writeVaultFile(root, "20_Study/indented.md", `${indent}[[hidden-by-tab-stop]]\n`);
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!)}\n- [[20_Study/indented]]\n`);

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "broken_link", path: "20_Study/indented.md" }));
  });

  it.each([
    ["entries", { maxEntries: 1 }],
    ["directories", { maxDirectories: 1 }],
    ["files", { maxFiles: 1 }],
    ["inventory", { maxInventoryBytes: 1 }],
    ["content", { maxContentBytes: 1 }],
    ["parsed-link bytes", { maxParsedLinkBytes: 1 }],
    ["links", { maxLinks: 1 }],
    ["findings", { maxFindings: 1 }],
  ])("returns one byte-identical generic finding for the %s cap in either enumeration order", async (_name, limits) => {
    const root = await createValidVault();
    await writeVaultFile(root, ".env", "not-a-secret\n");
    await writeVaultFile(root, "secrets", "not-a-secret\n");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    try {
      const forward = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, limits, fs: orderedFs(false) });
      const reversed = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, limits, fs: orderedFs(true) });

      expect(forward.findings).toEqual([LIMIT_FINDING]);
      expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the same generic cap finding when a generated Canvas exceeds the content bound", async () => {
    const root = await createValidVault();
    const canvas = JSON.parse(renderBrainCanvas(BRAIN_FOUNDATION_POLICY)) as Record<string, unknown>;
    canvas.padding = "x".repeat(32_768);
    await writeVaultFile(root, BRAIN_FOUNDATION_POLICY.brainCanvas, JSON.stringify(canvas));
    const maxMarkdownBytes = Math.max(...await Promise.all((await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase("en-US").endsWith(".md"))
      .map(async (entry) => Number((await nativeLstat(path.join(entry.parentPath, entry.name), { bigint: true })).size))));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    try {
      const forward = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, limits: { maxContentBytes: maxMarkdownBytes }, fs: orderedFs(false) });
      const reversed = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, limits: { maxContentBytes: maxMarkdownBytes }, fs: orderedFs(true) });

      expect(forward.findings).toEqual([LIMIT_FINDING]);
      expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    } finally {
      vi.useRealTimers();
    }
  });

  it("charges valid multibyte Markdown and its BOM by exact raw parsed-link bytes", async () => {
    const root = await createValidVault();
    await writeFile(
      path.join(root, BRAIN_FOUNDATION_POLICY.rootGuide),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# 한글\n", "utf8")]),
    );
    const exact = await markdownByteCost(root);

    const accepted = await auditVaultIntegrity({
      vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY,
      limits: { maxParsedLinkBytes: exact },
    });
    const rejected = await auditVaultIntegrity({
      vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY,
      limits: { maxParsedLinkBytes: exact - 1 },
    });

    expect(accepted.findings).toEqual([]);
    expect(rejected.findings).toEqual([LIMIT_FINDING]);
  });

  it("limits invalid UTF-8 before decode when over budget and fails safely at the exact raw budget", async () => {
    const root = await createValidVault();
    const invalid = Buffer.from([0x23, 0x20, 0x80, 0x0a]);
    await writeFile(path.join(root, BRAIN_FOUNDATION_POLICY.rootGuide), invalid);
    await writeVaultFile(root, "00_Prompt/a-broken-after-invalid.md", "[[missing-after-invalid-text]]\n");

    const overBudget = await auditVaultIntegrity({
      vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY,
      limits: { maxParsedLinkBytes: invalid.length - 1 },
    });
    const exactBudget = await auditVaultIntegrity({
      vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY,
      limits: { maxParsedLinkBytes: invalid.length },
    });

    expect(overBudget.findings).toEqual([LIMIT_FINDING]);
    expect(exactBudget.findings).toEqual([{
      code: "unreadable_file", category: "invalid_text", path: BRAIN_FOUNDATION_POLICY.rootGuide,
    }]);
    expect(exactBudget.findings.map((finding) => finding.code)).not.toEqual(expect.arrayContaining(["broken_link", "ambiguous_link", "orphan_note", "missing_required_file", "canvas_missing_file"]));
  });

  it("resolves uppercase .MD files by exact path and unique basename and credits incoming links", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, "20_Study/Exact.MD", "# exact\n");
    await writeVaultFile(root, "40_Research/Unique.MD", "# unique\n");
    await writeVaultFile(root, "20_Study/uppercase-links.md", "[[20_Study/Exact]]\n[[Unique]]\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!)}\n- [[20_Study/uppercase-links]]\n`);

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "broken_link", path: "20_Study/uppercase-links.md" }));
    expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "orphan_note", path: "20_Study/Exact.MD" }));
    expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "orphan_note", path: "40_Research/Unique.MD" }));
  });

  it("accounts for an uppercase .MD file as Markdown in link and orphan analysis", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, "20_Study/Upper.MD", "# upper\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!)}\n- [[20_Study/Upper.MD]]\n`);

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).not.toContainEqual(expect.objectContaining({ path: "20_Study/Upper.MD", code: "orphan_note" }));
  });

  it("matches the organizer's 240-byte exact and normalized component policy", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, `20_Study/${"a".repeat(241)}.md`, "# too long\n");
    await writeVaultFile(root, "20_Study/fullwidth／separator.md", "# normalized separator\n");

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings.filter((finding) => finding.code === "invalid_path").map((finding) => finding.category)).toEqual(expect.arrayContaining(["path_bytes", "unsafe_name"]));
  });

  it("returns only the unsafe-root finding and makes no write when its root is not a directory", async () => {
    const root = await createValidVault();
    const notDirectory = path.join(root, "not-a-vault.md");
    await writeFile(notDirectory, "unchanged", "utf8");

    const report = await auditVaultIntegrity({ vault: "brain", root: notDirectory, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).toEqual([{ code: "unsafe_link", category: "root", path: "." }]);
    expect(await readFile(notDirectory, "utf8")).toBe("unchanged");
  });

  it.each(["root", "child"])("rejects an injected %s canonical-path replacement before it can read outside the vault", async (kind) => {
    const root = await createValidVault();
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-integrity-outside-"));
    vaults.push(outside);
    const child = path.join(root, "20_Study");
    let outsideRead = false;
    const fs: IntegrityAuditFs = {
      lstat: (pathname) => nativeLstat(pathname, { bigint: true }),
      realpath: async (pathname) => pathname === (kind === "root" ? root : child) ? outside : nativeRealpath(pathname),
      opendir: async (pathname) => {
        if (pathname === outside) outsideRead = true;
        return nativeOpendir(pathname);
      },
      open: (pathname, flags) => nativeOpen(pathname, flags),
    };

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, fs });

    expect(outsideRead).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "unsafe_link", path: kind === "root" ? "." : "20_Study" }));
    expect(report.findings.map((finding) => finding.code)).not.toContain("missing_required_file");
  });

  it("stops at an injected ancestor replacement before descending into a child", async () => {
    const root = await createValidVault();
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-integrity-outside-"));
    vaults.push(outside);
    let rootStats = 0;
    let outsideRead = false;
    const fs: IntegrityAuditFs = {
      lstat: async (pathname) => {
        if (pathname === root && ++rootStats >= 7) return nativeLstat(outside, { bigint: true });
        return nativeLstat(pathname, { bigint: true });
      },
      realpath: nativeRealpath,
      opendir: async (pathname) => {
        if (pathname === outside) outsideRead = true;
        return nativeOpendir(pathname);
      },
      open: nativeOpen,
    };

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY, fs });

    expect(outsideRead).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "changed_file" }));
  });

  it("reports forbidden artifacts and unsafe links by category without reading secret-looking note content", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, "20_Study/.env", "API_KEY=example-not-a-real-secret\n");
    await writeVaultFile(root, "20_Study/credentials.pem", "-----BEGIN PRIVATE KEY-----\nexample\n");
    await writeVaultFile(root, "20_Study/example.tmp", "temporary\n");
    await mkdir(path.join(root, ".obsidian"));
    await writeVaultFile(root, "20_Study/code-example.md", "```bash\nexport API_KEY=example-not-a-real-secret\n```\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!)}\n- [[20_Study/code-example]]\n`);
    await symlink(path.join(root, "20_Study", "code-example.md"), path.join(root, "20_Study", "unsafe-link.md"));

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });
    const serialized = JSON.stringify(report);

    expect(report.findings.filter((finding) => finding.code === "forbidden_artifact").map((finding) => finding.category)).toEqual([
      "application", "environment", "key", "temporary",
    ]);
    expect(serialized).not.toContain("example-not-a-real-secret");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(report.findings).toContainEqual(expect.objectContaining({ path: "20_Study/unsafe-link.md", code: "unsafe_link" }));
  });
});
