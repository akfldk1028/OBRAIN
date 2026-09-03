import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanStableInbox } from "../src/organizer/scanner.js";

const readProbe = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      readProbe.paths.push(String(args[0]));
      return actual.readFile(...args);
    },
  };
});

const roots: string[] = [];
const nowMs = Date.parse("2026-09-03T12:00:00.000Z");

async function makeVault(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-scanner-"));
  roots.push(root);
  await mkdir(path.join(root, "Agent-Inbox"), { recursive: true });
  return root;
}

async function writeAgedFile(
  absolutePath: string,
  content: string,
  ageSeconds: number,
): Promise<void> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  const timestamp = new Date(nowMs - ageSeconds * 1_000);
  await utimes(absolutePath, timestamp, timestamp);
}

afterEach(async () => {
  readProbe.paths.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stable Inbox scanner", () => {
  it("returns only stable normal Markdown with metadata and a canonical path", async () => {
    const root = await makeVault();
    const inbox = path.join(root, "Agent-Inbox");
    const stable = path.join(inbox, "stable.md");
    await writeAgedFile(stable, "stable body", 301);
    await writeAgedFile(path.join(inbox, "recent.md"), "recent", 299);
    await writeAgedFile(path.join(inbox, "draft.sync-conflict-20260903-120000-ABC.md"), "conflict", 600);
    await writeAgedFile(path.join(inbox, "pending.tmp.md"), "temporary", 600);
    await writeAgedFile(path.join(inbox, ".hidden.md"), "hidden", 600);
    await writeAgedFile(path.join(inbox, "not-markdown.txt"), "text", 600);
    await writeAgedFile(path.join(inbox, "검토필요", "review.md"), "review", 600);
    await writeAgedFile(path.join(inbox, ".obsidian", "config.md"), "config", 600);

    const expectedStat = await lstat(stable);
    const candidates = await scanStableInbox({ root, minStableSeconds: 300, nowMs });

    expect(candidates).toEqual([{
      path: "Agent-Inbox/stable.md",
      absolutePath: stable,
      hash: "0b5d111515d1635b87bcda6a27190572a6d8c6bb7452215c3f1c61c9fed940c7",
      size: 11,
      mtimeMs: expectedStat.mtimeMs,
    }]);
    expect(readProbe.paths).toEqual([stable]);
  });

  it("includes the exact stability boundary and sorts recursively by POSIX path", async () => {
    const root = await makeVault();
    const inbox = path.join(root, "Agent-Inbox");
    await writeAgedFile(path.join(inbox, "zeta.md"), "z", 300);
    await writeAgedFile(path.join(inbox, "alpha", "nested.md"), "nested", 900);
    await writeAgedFile(path.join(inbox, "alpha.md"), "a", 301);
    await writeAgedFile(path.join(inbox, "too-new.md"), "new", 299.999);

    const candidates = await scanStableInbox({ root, minStableSeconds: 300, nowMs });

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "Agent-Inbox/alpha.md",
      "Agent-Inbox/alpha/nested.md",
      "Agent-Inbox/zeta.md",
    ]);
  });

  it("checks the default and custom byte limits before reading content", async () => {
    const defaultRoot = await makeVault();
    const defaultOversized = path.join(defaultRoot, "Agent-Inbox", "default-too-large.md");
    await writeAgedFile(defaultOversized, "x".repeat(131_073), 600);

    expect(await scanStableInbox({ root: defaultRoot, minStableSeconds: 300, nowMs })).toEqual([]);
    expect(readProbe.paths).not.toContain(defaultOversized);

    const customRoot = await makeVault();
    const exact = path.join(customRoot, "Agent-Inbox", "exact.md");
    const oversized = path.join(customRoot, "Agent-Inbox", "too-large.md");
    await writeAgedFile(exact, "aaaa", 600);
    await writeAgedFile(oversized, "12345", 600);

    const candidates = await scanStableInbox({
      root: customRoot,
      minStableSeconds: 300,
      nowMs,
      maxBytes: 4,
    });

    expect(candidates.map((candidate) => candidate.path)).toEqual(["Agent-Inbox/exact.md"]);
    expect(candidates[0]?.hash).toBe("61be55a8e2f6b4e172338bddf184d6dbee29c98853e0a0485ecee7f27b9af0b4");
    expect(readProbe.paths).not.toContain(oversized);
  });

  it("rejects invalid scanner bounds", async () => {
    const root = await makeVault();

    await expect(scanStableInbox({ root, minStableSeconds: -1, nowMs })).rejects.toThrow();
    await expect(scanStableInbox({ root, minStableSeconds: 300, nowMs, maxBytes: 0 })).rejects.toThrow();
  });

  it("does not follow a directory symlink or junction outside the canonical root", async () => {
    const root = await makeVault();
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-scanner-outside-"));
    roots.push(outside);
    const outsideNote = path.join(outside, "escaped.md");
    await writeAgedFile(outsideNote, "escaped", 600);
    await symlink(outside, path.join(root, "Agent-Inbox", "linked"), "junction");

    expect(await scanStableInbox({ root, minStableSeconds: 300, nowMs })).toEqual([]);
    expect(readProbe.paths).not.toContain(outsideNote);
  });

  it("rejects an Inbox that is itself a symlink or junction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brain-scanner-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-scanner-outside-"));
    roots.push(root, outside);
    await writeAgedFile(path.join(outside, "escaped.md"), "escaped", 600);
    await symlink(outside, path.join(root, "Agent-Inbox"), "junction");

    await expect(scanStableInbox({ root, minStableSeconds: 300, nowMs })).rejects.toThrow(/symlink/i);
    expect(readProbe.paths).toEqual([]);
  });
});
