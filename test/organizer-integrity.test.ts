import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAreaCanvas, renderBrainCanvas } from "../src/foundation/canvas.js";
import { renderAreaGuide, renderAreaMoc, renderHomeMoc, renderRootGuide } from "../src/foundation/markdown.js";
import { BRAIN_FOUNDATION_POLICY, areaCanvasPath, areaGuidePath, areaMocPath } from "../src/foundation/policy.js";
import { auditVaultIntegrity } from "../src/organizer/integrity.js";

const vaults: string[] = [];

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

  it("accepts a uniquely named embedded asset without guessing Markdown-only links", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, "20_Study/assets/diagram.png", "not an image fixture");
    await writeVaultFile(root, "20_Study/links.md", "![[diagram.png]]\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!)}\n- [[20_Study/links]]\n`);

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).not.toContainEqual(expect.objectContaining({ path: "20_Study/links.md", code: "broken_link" }));
  });

  it("returns only the unsafe-root finding and makes no write when its root is not a directory", async () => {
    const root = await createValidVault();
    const notDirectory = path.join(root, "not-a-vault.md");
    await writeFile(notDirectory, "unchanged", "utf8");

    const report = await auditVaultIntegrity({ vault: "brain", root: notDirectory, policy: BRAIN_FOUNDATION_POLICY });

    expect(report.findings).toEqual([{ code: "unsafe_link", category: "root", path: "." }]);
    expect(await readFile(notDirectory, "utf8")).toBe("unchanged");
  });

  it("reports forbidden artifacts and unsafe links by category without reading secret-looking note content", async () => {
    const root = await createValidVault();
    await writeVaultFile(root, "20_Study/.env", "API_KEY=example-not-a-real-secret\n");
    await writeVaultFile(root, "20_Study/credentials.pem", "-----BEGIN PRIVATE KEY-----\nexample\n");
    await writeVaultFile(root, "20_Study/example.tmp", "temporary\n");
    await mkdir(path.join(root, ".obsidian"));
    await writeVaultFile(root, "20_Study/code-example.md", "```bash\nexport API_KEY=example-not-a-real-secret\n```\n");
    await writeVaultFile(root, areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!), `${renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]!)}\n- [[20_Study/code-example]]\n`);
    try {
      await symlink(path.join(root, "20_Study", "code-example.md"), path.join(root, "20_Study", "unsafe-link.md"));
    } catch {
      // Symlink creation can be unavailable on locked-down Windows test hosts.
    }

    const report = await auditVaultIntegrity({ vault: "brain", root, policy: BRAIN_FOUNDATION_POLICY });
    const serialized = JSON.stringify(report);

    expect(report.findings.filter((finding) => finding.code === "forbidden_artifact").map((finding) => finding.category)).toEqual([
      "application", "environment", "key", "temporary",
    ]);
    expect(serialized).not.toContain("example-not-a-real-secret");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    if (report.findings.some((finding) => finding.path === "20_Study/unsafe-link.md")) {
      expect(report.findings).toContainEqual(expect.objectContaining({ path: "20_Study/unsafe-link.md", code: "unsafe_link" }));
    }
  });
});
