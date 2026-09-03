import {
  appendFile,
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
const ioProbe = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((filePath: string) => Promise<void>),
  beforeRead: undefined as undefined | ((filePath: string) => Promise<void>),
  handleReads: [] as Array<{ path: string; requestedBytes: number }>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      readProbe.paths.push(String(args[0]));
      return actual.readFile(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const filePath = String(args[0]);
      const beforeOpen = ioProbe.beforeOpen;
      ioProbe.beforeOpen = undefined;
      if (beforeOpen) await beforeOpen(filePath);
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
              const requestedBytes = length;
              ioProbe.handleReads.push({ path: filePath, requestedBytes });
              const beforeRead = ioProbe.beforeRead;
              ioProbe.beforeRead = undefined;
              if (beforeRead) await beforeRead(filePath);
              return target.read(buffer, offset, length, position);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
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
  ioProbe.beforeOpen = undefined;
  ioProbe.beforeRead = undefined;
  ioProbe.handleReads.length = 0;
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
    expect(readProbe.paths).toEqual([]);
  });

  it("preserves exact on-disk Unicode spelling in candidate paths", async () => {
    const root = await makeVault();
    await writeAgedFile(path.join(root, "Agent-Inbox", "Ｆｕｌｌ.md"), "fullwidth", 600);

    const candidates = await scanStableInbox({ root, minStableSeconds: 300, nowMs });

    expect(candidates.map((candidate) => candidate.path)).toEqual(["Agent-Inbox/Ｆｕｌｌ.md"]);
  });

  it("rejects ambiguous case-insensitive NFKC-equivalent on-disk paths before reading", async () => {
    const root = await makeVault();
    const inbox = path.join(root, "Agent-Inbox");
    await writeAgedFile(path.join(inbox, "ABC.md"), "ascii", 600);
    await writeAgedFile(path.join(inbox, "ａｂｃ.md"), "fullwidth lower", 600);

    await expect(scanStableInbox({ root, minStableSeconds: 300, nowMs })).rejects.toThrow(/ambiguous/i);
    expect(readProbe.paths).toEqual([]);
    expect(ioProbe.handleReads).toEqual([]);
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

  it("rejects a supplied Vault root symlink or junction before canonicalization", async () => {
    const root = await makeVault();
    const aliases = await mkdtemp(path.join(os.tmpdir(), "brain-scanner-alias-"));
    roots.push(aliases);
    const alias = path.join(aliases, "vault-link");
    await symlink(root, alias, "junction");

    await expect(scanStableInbox({ root: alias, minStableSeconds: 300, nowMs })).rejects.toThrow(/root.*symlink/i);
  });

  it("discards a candidate replaced by an escaping junction before its handle opens", async () => {
    const root = await makeVault();
    const candidateDirectory = path.join(root, "Agent-Inbox", "race");
    await writeAgedFile(path.join(candidateDirectory, "note.md"), "inside", 600);
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-scanner-outside-"));
    roots.push(outside);
    await writeAgedFile(path.join(outside, "note.md"), "secret", 600);
    ioProbe.beforeOpen = async () => {
      await rm(candidateDirectory, { recursive: true, force: true });
      await symlink(outside, candidateDirectory, "junction");
    };

    expect(await scanStableInbox({ root, minStableSeconds: 300, nowMs })).toEqual([]);
    expect(readProbe.paths).toEqual([]);
    expect(ioProbe.handleReads).toEqual([]);
  });

  it("reads at most maxBytes plus one and discards growth through the open handle", async () => {
    const root = await makeVault();
    const candidate = path.join(root, "Agent-Inbox", "growing.md");
    await writeAgedFile(candidate, "aaaa", 600);
    ioProbe.beforeRead = async (filePath) => {
      await appendFile(filePath, "b");
    };

    expect(await scanStableInbox({ root, minStableSeconds: 300, nowMs, maxBytes: 4 })).toEqual([]);
    expect(readProbe.paths).toEqual([]);
    expect(ioProbe.handleReads.length).toBeGreaterThan(0);
    expect(ioProbe.handleReads.every((read) => read.requestedBytes <= 5)).toBe(true);
  });
});
