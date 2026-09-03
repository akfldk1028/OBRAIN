import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAIN_FOUNDATION_POLICY, type VaultFoundationPolicy } from "../src/foundation/policy.js";
import { installFoundation } from "../src/foundation/install.js";

const linkFault = vi.hoisted(() => ({
  mode: "none" as "none" | "fail" | "swap-parent",
  studyParent: "",
  studyTarget: "",
  outside: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (existingPath: string, newPath: string) => {
      if (linkFault.mode === "fail") {
        linkFault.mode = "none";
        throw Object.assign(new Error("injected publish failure"), { code: "EIO" });
      }
      if (linkFault.mode === "swap-parent" && newPath === linkFault.studyTarget) {
        linkFault.mode = "none";
        await actual.rm(linkFault.studyParent, { recursive: true, force: true });
        await actual.symlink(linkFault.outside, linkFault.studyParent, "junction");
      }
      return actual.link(existingPath, newPath);
    },
  };
});

const roots: string[] = [];

const foundationPaths = [
  "000_AI_WORK_GUIDE.md",
  "000_Home_MOC.md",
  "000_Brain_Map.canvas",
  "00_Prompt/000_Prompt_MOC.md",
  "00_Prompt/99_작업가이드_다음AI용.md",
  "00_Prompt/000_Prompt_Map.canvas",
  "01_Development/000_Development_MOC.md",
  "01_Development/99_작업가이드_다음AI용.md",
  "01_Development/000_Development_Map.canvas",
  "10_Agent/000_Agent_MOC.md",
  "10_Agent/99_작업가이드_다음AI용.md",
  "10_Agent/000_Agent_Map.canvas",
  "20_Study/000_Study_MOC.md",
  "20_Study/99_작업가이드_다음AI용.md",
  "20_Study/000_Study_Map.canvas",
  "30_Business/000_Business_MOC.md",
  "30_Business/99_작업가이드_다음AI용.md",
  "30_Business/000_Business_Map.canvas",
  "40_Research/000_Research_MOC.md",
  "40_Research/99_작업가이드_다음AI용.md",
  "40_Research/000_Research_Map.canvas",
  "50_Project/000_Project_MOC.md",
  "50_Project/99_작업가이드_다음AI용.md",
  "50_Project/000_Project_Map.canvas",
  "60_Tools/000_Tools_MOC.md",
  "60_Tools/99_작업가이드_다음AI용.md",
  "60_Tools/000_Tools_Map.canvas",
  "98_DK/000_DK_MOC.md",
  "98_DK/99_작업가이드_다음AI용.md",
  "98_DK/000_DK_Map.canvas",
  "99_Archive/000_Archive_MOC.md",
  "99_Archive/99_작업가이드_다음AI용.md",
  "99_Archive/000_Archive_Map.canvas",
];

async function pathsOnDisk(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const next = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? [next, ...await pathsOnDisk(root, next)] : [next];
  }));
  return paths.flat();
}

function policyWithRootGuide(rootGuide: string): VaultFoundationPolicy {
  return { ...BRAIN_FOUNDATION_POLICY, rootGuide } as unknown as VaultFoundationPolicy;
}

afterEach(async () => {
  linkFault.mode = "none";
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("foundation installer", () => {
  it("previews without writing, then creates only missing foundation files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brain-foundation-"));
    roots.push(root);

    const preview = await installFoundation({
      vaultRoot: root,
      policy: BRAIN_FOUNDATION_POLICY,
      apply: false,
    });
    expect(preview.preview).toBe(true);
    expect(preview.created).toHaveLength(33);
    expect(preview.created).toEqual(foundationPaths);
    await expect(readFile(path.join(root, "000_AI_WORK_GUIDE.md"), "utf8")).rejects.toThrow();

    await writeFile(path.join(root, "000_Home_MOC.md"), "human home", "utf8");
    const applied = await installFoundation({
      vaultRoot: root,
      policy: BRAIN_FOUNDATION_POLICY,
      apply: true,
    });
    expect(applied.preview).toBe(false);
    expect(await readFile(path.join(root, "000_Home_MOC.md"), "utf8")).toBe("human home");
    expect(applied.skippedExisting).toContain("000_Home_MOC.md");
    expect(await readFile(path.join(root, "20_Study/000_Study_MOC.md"), "utf8")).toContain("Study MOC");
    const diskPaths = await pathsOnDisk(root);
    expect(diskPaths).toEqual(expect.arrayContaining([
      ...foundationPaths,
      "Agent-Inbox",
      "Agent-Inbox/검토필요",
    ]));
    for (const diskPath of diskPaths) {
      expect(diskPath.split("/").every((segment) => !segment.startsWith("."))).toBe(true);
    }

    const repeated = await installFoundation({
      vaultRoot: root,
      policy: BRAIN_FOUNDATION_POLICY,
      apply: true,
    });
    expect(repeated.created).toEqual([]);
    expect(repeated.skippedExisting).toContain("000_Home_MOC.md");
  });

  it("refuses an existing area symlink instead of writing through it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brain-foundation-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-outside-"));
    roots.push(root, outside);
    await symlink(outside, path.join(root, "20_Study"), "junction");

    await expect(installFoundation({ vaultRoot: root, policy: BRAIN_FOUNDATION_POLICY, apply: true }))
      .rejects.toThrow("symlink");
    await expect(readFile(path.join(root, "000_AI_WORK_GUIDE.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(outside, "000_Study_MOC.md"), "utf8")).rejects.toThrow();
  });

  it.each([
    ".obsidian/evil.md",
    ".stfolder/evil.md",
    "visible/.hidden/evil.md",
    "../outside.md",
    "C:\\outside.md",
    "visible/\u0000evil.md",
  ])("rejects unsafe generated path %j before mutating the vault", async (rootGuide) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brain-foundation-"));
    roots.push(root);

    await expect(installFoundation({ vaultRoot: root, policy: policyWithRootGuide(rootGuide), apply: true }))
      .rejects.toThrow("foundation path");
    expect(await readdir(root)).toEqual([]);
  });

  it("preflights a late unsafe area path before creating earlier files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brain-foundation-"));
    roots.push(root);
    const areas = [...BRAIN_FOUNDATION_POLICY.areas];
    areas[9] = { ...areas[9], directory: ".obsidian" };
    const policy = { ...BRAIN_FOUNDATION_POLICY, areas } as VaultFoundationPolicy;

    await expect(installFoundation({ vaultRoot: root, policy, apply: true })).rejects.toThrow("foundation path");
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a parent swapped to a junction between validation and publish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brain-foundation-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-outside-"));
    roots.push(root, outside);
    linkFault.mode = "swap-parent";
    linkFault.studyParent = path.join(root, "20_Study");
    linkFault.studyTarget = path.join(linkFault.studyParent, "000_Study_MOC.md");
    linkFault.outside = outside;

    await expect(installFoundation({ vaultRoot: root, policy: BRAIN_FOUNDATION_POLICY, apply: true }))
      .rejects.toThrow("symlink");
    await expect(readFile(path.join(outside, "000_Study_MOC.md"), "utf8")).rejects.toThrow();
  });

  it("does not publish a partial destination when publication fails and retries safely", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brain-foundation-"));
    roots.push(root);
    linkFault.mode = "fail";

    await expect(installFoundation({ vaultRoot: root, policy: BRAIN_FOUNDATION_POLICY, apply: true }))
      .rejects.toMatchObject({ code: "EIO" });
    await expect(readFile(path.join(root, "000_AI_WORK_GUIDE.md"), "utf8")).rejects.toThrow();
    expect((await readdir(root)).filter((entry) => entry.startsWith("foundation-tmp-"))).toEqual([]);

    const retry = await installFoundation({ vaultRoot: root, policy: BRAIN_FOUNDATION_POLICY, apply: true });
    expect(retry.created).toContain("000_AI_WORK_GUIDE.md");
    expect(await readFile(path.join(root, "000_AI_WORK_GUIDE.md"), "utf8")).toContain("AI 작업 가이드");
  });
});
