import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAreaCanvas } from "../src/foundation/canvas.js";
import { BRAIN_FOUNDATION_POLICY, areaCanvasPath, areaMocPath } from "../src/foundation/policy.js";
import { renderManagedAreaCanvas } from "../src/organizer/managed-canvas.js";
import { replaceManagedMocIndex } from "../src/organizer/managed-moc.js";
import { OrganizerStore } from "../src/organizer/store.js";
import {
  OrganizerTransactionEngine,
  type OrganizerTransactionEngineOptions,
  type TransactionEvent,
  type TransactionPlan,
} from "../src/organizer/transaction.js";
import type { StoredProposal } from "../src/organizer/types.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const study = BRAIN_FOUNDATION_POLICY.areas.find((area) => area.slug === "Study")!;
const original = "# Raw\n\nexact original body\n";
const organized = "# Organized\n\n## 원문\n\n# Raw\n\nexact original body\n";
const sourcePath = "Agent-Inbox/source.md";
const destinationPath = "20_Study/22_RL/organized.md";
const mocPath = areaMocPath(study);
const canvasPath = areaCanvasPath(study);
const currentMoc = `# Study\n\n<!-- brain-auto:start note-index -->\n<!-- brain-auto:end note-index -->\n`;
const currentCanvas = renderAreaCanvas(study);
const nextMoc = replaceManagedMocIndex(currentMoc, [{ path: destinationPath, title: "Organized" }]);
const nextCanvas = renderManagedAreaCanvas({
  canvasPath,
  currentCanvas,
  existingPaths: new Set([mocPath, destinationPath]),
  areaMocPath: mocPath,
  childMocPaths: [],
  representativeNotePaths: [destinationPath],
  relationships: [{ from: destinationPath, to: mocPath, label: "parent" }],
});

interface Fixture {
  root: string;
  vault: string;
  recovery: string;
  database: string;
  store: OrganizerStore;
  proposal: StoredProposal;
  plan: TransactionPlan;
  cleanup(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "organizer-transaction-"));
  const vault = path.join(root, "vault");
  const recovery = path.join(root, "recovery");
  const database = path.join(root, "organizer.sqlite");
  await mkdir(path.join(vault, "Agent-Inbox"), { recursive: true });
  await mkdir(path.join(vault, "20_Study", "22_RL"), { recursive: true });
  await writeFile(path.join(vault, ...sourcePath.split("/")), original);
  await writeFile(path.join(vault, ...mocPath.split("/")), currentMoc);
  await writeFile(path.join(vault, ...canvasPath.split("/")), currentCanvas);
  const proposal: StoredProposal = {
    id: "PRP-transaction-test",
    vault: "brain",
    sourcePath,
    sourceHash: hash(original),
    destinationPath,
    policyVersion: BRAIN_FOUNDATION_POLICY.version,
    createdAt: "2026-09-03T00:00:00.000Z",
    expiresAt: "2026-09-04T00:00:00.000Z",
    status: "pending",
    targetDirectory: "20_Study/22_RL",
    title: "Organized",
    type: "study",
    tags: ["study"],
    summary: "Summary",
    relatedNotePaths: [],
    confidence: 0.96,
    reason: "classification",
  };
  const store = new OrganizerStore(database);
  store.saveProposal(proposal);
  const plan: TransactionPlan = {
    id: "ORG-transaction-test",
    proposal,
    vaultRoot: vault,
    destinationContent: organized,
    managedReplacements: [
      { relativePath: mocPath, expectedHash: hash(currentMoc), content: nextMoc },
      { relativePath: canvasPath, expectedHash: hash(currentCanvas), content: nextCanvas },
    ],
  };
  const cleanup = async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { root, vault, recovery, database, store, proposal, plan, cleanup };
}

function engine(
  input: Fixture,
  options: Partial<OrganizerTransactionEngineOptions> = {},
) {
  return new OrganizerTransactionEngine({
    recoveryRoot: options.recoveryRoot ?? input.recovery,
    store: options.store ?? input.store,
    now: options.now ?? (() => "2026-09-03T01:00:00.000Z"),
    onEvent: options.onEvent,
  });
}

async function vaultState(input: Fixture) {
  const read = async (relative: string) => {
    try { return await readFile(path.join(input.vault, ...relative.split("/")), "utf8"); }
    catch (error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error); }
  };
  return {
    source: await read(sourcePath),
    destination: await read(destinationPath),
    moc: await read(mocPath),
    canvas: await read(canvasPath),
  };
}

async function resetToPreDatabaseCrash(input: Fixture): Promise<void> {
  input.store.close();
  const db = new Database(input.database);
  db.prepare("DELETE FROM organizer_transactions WHERE id=?").run(input.plan.id);
  db.prepare("UPDATE organizer_proposals SET status='pending', proposal_json=? WHERE id=?")
    .run(JSON.stringify(input.proposal), input.proposal.id);
  db.close();
  input.store = new OrganizerStore(input.database);
  cleanups.push(async () => input.store.close());
}

async function resetUndoneDatabaseToApplied(input: Fixture): Promise<void> {
  input.store.close();
  const db = new Database(input.database);
  db.prepare("UPDATE organizer_transactions SET undone_at=NULL WHERE id=?").run(input.plan.id);
  db.close();
  input.store = new OrganizerStore(input.database);
  cleanups.push(async () => input.store.close());
}

async function replaceProposalSource(input: Fixture, nextSourcePath: string): Promise<void> {
  await rm(path.join(input.vault, ...input.proposal.sourcePath.split("/")));
  await writeFile(path.join(input.vault, ...nextSourcePath.split("/")), original);
  const proposal = { ...input.proposal, sourcePath: nextSourcePath };
  input.store.close();
  const db = new Database(input.database);
  db.prepare("UPDATE organizer_proposals SET source_path=?, proposal_json=? WHERE id=?")
    .run(nextSourcePath, JSON.stringify(proposal), proposal.id);
  db.close();
  input.store = new OrganizerStore(input.database);
  input.proposal = proposal;
  input.plan = { ...input.plan, proposal };
  cleanups.push(async () => input.store.close());
}

describe("organizer transaction engine", () => {
  it("durably snapshots before applying and records database state last", async () => {
    const input = await fixture();
    const events: TransactionEvent[] = [];
    const result = await engine(input, { onEvent: (event) => { events.push(event); } }).apply(input.plan);

    expect(result).toMatchObject({
      id: input.plan.id,
      proposalId: input.proposal.id,
      sourceHash: hash(original),
      destinationHash: hash(organized),
    });
    expect(await vaultState(input)).toEqual({ source: undefined, destination: organized, moc: nextMoc, canvas: nextCanvas });
    const transactionDirectory = path.join(input.recovery, input.plan.id);
    expect(await readFile(path.join(transactionDirectory, "original.md"), "utf8")).toBe(original);
    const manifest = JSON.parse(await readFile(path.join(transactionDirectory, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ version: 1, id: input.plan.id, state: "vault_applied", sourcePath, destinationPath });
    expect(JSON.stringify(manifest)).not.toContain(original);
    expect(JSON.stringify(manifest)).not.toContain("Summary");

    const names = events.map((event) => event.name);
    expect(names.indexOf("manifest_directory_synced")).toBeLessThan(names.indexOf("destination_published"));
    expect(names.indexOf("source_removed")).toBeLessThan(names.indexOf("database_committed"));
    expect(input.store.getProposal(input.proposal.id)?.status).toBe("applied");
    expect(input.store.getTransaction(input.plan.id)).toEqual(result);
  });

  it("uses restrictive recovery permissions on platforms with POSIX mode bits", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    if (process.platform === "win32") return;
    const transactionDirectory = path.join(input.recovery, input.plan.id);
    expect((await stat(input.recovery)).mode & 0o777).toBe(0o700);
    expect((await stat(transactionDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(transactionDirectory, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(transactionDirectory, "original.md"))).mode & 0o777).toBe(0o600);
  });

  it("marks a changed source stale without mutating the vault", async () => {
    const input = await fixture();
    await writeFile(path.join(input.vault, ...sourcePath.split("/")), `${original}human edit\n`);
    const before = await vaultState(input);
    await expect(engine(input).apply(input.plan)).rejects.toThrow(/stale/i);
    expect(await vaultState(input)).toEqual(before);
    expect(input.store.getProposal(input.proposal.id)?.status).toBe("stale");
  });

  it("rechecks the source immediately before the first vault mutation and records a race as stale", async () => {
    const input = await fixture();
    const edited = `${original}concurrent human edit\n`;
    await expect(engine(input, {
      onEvent: async (event) => {
        if (event.name === "before_destination_publish") {
          await writeFile(path.join(input.vault, ...sourcePath.split("/")), edited);
        }
      },
    }).apply(input.plan)).rejects.toThrow(/stale/i);
    expect(await vaultState(input)).toEqual({ source: edited, destination: undefined, moc: currentMoc, canvas: currentCanvas });
    expect(input.store.getProposal(input.proposal.id)?.status).toBe("stale");
  });

  it("rejects an existing destination including case-equivalent collisions", async () => {
    const input = await fixture();
    await writeFile(path.join(input.vault, "20_Study", "22_RL", "ORGANIZED.md"), "human file");
    const before = await vaultState(input);
    await expect(engine(input).apply(input.plan)).rejects.toThrow(/collision|exists/i);
    expect(await vaultState(input)).toEqual(before);
    expect(await readFile(path.join(input.vault, "20_Study", "22_RL", "ORGANIZED.md"), "utf8")).toBe("human file");
    expect(input.store.getProposal(input.proposal.id)?.status).toBe("rejected");
  });

  it("does not remove a destination created in the final publication race", async () => {
    const input = await fixture();
    const racing = "racing human file";
    await expect(engine(input, {
      onEvent: async (event) => {
        if (event.name === "before_destination_publish") {
          await writeFile(path.join(input.vault, ...destinationPath.split("/")), racing);
        }
      },
    }).apply(input.plan)).rejects.toThrow(/collision|exists/i);
    expect(await vaultState(input)).toEqual({ source: original, destination: racing, moc: currentMoc, canvas: currentCanvas });
  });

  it("does not commit when the published destination disappears before later mutations", async () => {
    const input = await fixture();
    await expect(engine(input, {
      onEvent: async (event) => {
        if (event.name === "before_managed_publish" && event.managedIndex === 0) {
          await rm(path.join(input.vault, ...destinationPath.split("/")));
        }
      },
    }).apply(input.plan)).rejects.toThrow(/destination.*missing|destination.*changed/i);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
    expect(input.store.getTransaction(input.plan.id)).toBeUndefined();
  });

  it("revalidates a managed target after the final pre-publication hook", async () => {
    const input = await fixture();
    const mocAbsolute = path.join(input.vault, ...mocPath.split("/"));
    await expect(engine(input, {
      onEvent: async (event) => {
        if (event.name === "before_managed_publish" && event.managedIndex === 0) {
          await rename(mocAbsolute, `${mocAbsolute}.moved`);
          await writeFile(mocAbsolute, currentMoc);
        }
      },
    }).apply(input.plan)).rejects.toThrow(/identity|changed/i);
    expect(await readFile(`${mocAbsolute}.moved`, "utf8")).toBe(currentMoc);
    expect(input.store.getTransaction(input.plan.id)).toBeUndefined();
  });

  it("revalidates managed Canvas references immediately before publication", async () => {
    const input = await fixture();
    const referencePath = "20_Study/reference.md";
    const referenceAbsolute = path.join(input.vault, ...referencePath.split("/"));
    await writeFile(referenceAbsolute, "# Reference\n");
    const canvas = JSON.stringify({
      nodes: [
        { id: "1111111111111111", type: "file", file: mocPath, x: 0, y: 0, width: 100, height: 100 },
        { id: "2222222222222222", type: "file", file: referencePath, x: 200, y: 0, width: 100, height: 100 },
      ],
      edges: [],
    });
    const replacementCanvas = JSON.stringify({
      nodes: [
        { id: "1111111111111111", type: "file", file: mocPath, x: 0, y: 0, width: 100, height: 100 },
        { id: "2222222222222222", type: "file", file: referencePath, x: 200, y: 0, width: 100, height: 100 },
        { id: "3333333333333333", type: "file", file: destinationPath, x: 400, y: 0, width: 100, height: 100 },
      ],
      edges: [],
    });
    await writeFile(path.join(input.vault, ...canvasPath.split("/")), canvas);
    const plan = {
      ...input.plan,
      managedReplacements: input.plan.managedReplacements.map((replacement) => (
        replacement.relativePath === canvasPath
          ? { ...replacement, expectedHash: hash(canvas), content: replacementCanvas }
          : replacement
      )),
    };
    await expect(engine(input, {
      onEvent: async (event) => {
        if (event.name === "before_managed_publish" && event.managedIndex === 0) await rm(referenceAbsolute);
      },
    }).apply(plan)).rejects.toThrow(/reference|exist/i);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas });
    expect(input.store.getTransaction(input.plan.id)).toBeUndefined();
  });

  it("rejects a replaced destination parent before publication", async () => {
    const input = await fixture();
    const target = path.join(input.vault, "20_Study", "22_RL");
    const moved = path.join(input.vault, "20_Study", "22_RL-old");
    await expect(engine(input, {
      onEvent: async (event) => {
        if (event.name === "before_destination_publish") {
          await rename(target, moved);
          await mkdir(target);
        }
      },
    }).apply(input.plan)).rejects.toThrow(/changed|lineage|identity/i);
    expect(await readFile(path.join(moved, "organized.md"), "utf8").catch(() => undefined)).toBeUndefined();
    expect(await readFile(path.join(input.vault, ...sourcePath.split("/")), "utf8")).toBe(original);
  });

  it("rejects a symlinked managed parent and never writes outside the vault", async () => {
    const input = await fixture();
    const outside = path.join(input.root, "outside");
    await mkdir(outside);
    const area = path.join(input.vault, "20_Study");
    await rename(area, `${area}-real`);
    await symlink(outside, area, process.platform === "win32" ? "junction" : "dir");
    await expect(engine(input).apply(input.plan)).rejects.toThrow(/symlink|safe|identity/i);
    expect(await lstat(path.join(outside, "22_RL")).catch(() => undefined)).toBeUndefined();
  });

  it.each([
    ["missing MOC marker", () => "# Human text only\n", mocPath],
    ["Canvas missing reference", () => JSON.stringify({ nodes: [{ id: "0123456789abcdef", type: "file", file: "20_Study/missing.md", x: 0, y: 0, width: 100, height: 100 }], edges: [] }), canvasPath],
  ])("fails closed for %s", async (_name, content, relativePath) => {
    const input = await fixture();
    await writeFile(path.join(input.vault, ...relativePath.split("/")), content());
    const before = await vaultState(input);
    await expect(engine(input).apply({
      ...input.plan,
      managedReplacements: input.plan.managedReplacements.map((replacement) => (
        replacement.relativePath === relativePath ? { ...replacement, expectedHash: hash(content()) } : replacement
      )),
    })).rejects.toThrow(/marker|reference|exist|Canvas/i);
    expect(await vaultState(input)).toEqual(before);
  });

  it("requires the destination area's existing MOC markers even when the MOC is not replaced", async () => {
    const input = await fixture();
    await writeFile(path.join(input.vault, ...mocPath.split("/")), "# Human text without managed markers\n");
    const before = await vaultState(input);
    await expect(engine(input).apply({ ...input.plan, managedReplacements: [] })).rejects.toThrow(/marker/i);
    expect(await vaultState(input)).toEqual(before);
  });

  it("rejects a MOC replacement that changes human-owned bytes outside the markers", async () => {
    const input = await fixture();
    const plan = {
      ...input.plan,
      managedReplacements: input.plan.managedReplacements.map((replacement) => (
        replacement.relativePath === mocPath
          ? { ...replacement, content: nextMoc.replace("# Study", "# Rewritten by model") }
          : replacement
      )),
    };
    await expect(engine(input).apply(plan)).rejects.toThrow(/human|outside|marker/i);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
  });

  it.each([
    ["destination_published", undefined],
    ["managed_published", 0],
    ["managed_published", 1],
    ["source_removed", undefined],
    ["before_database_commit", undefined],
  ] as const)("rolls back fully after injected %s boundary %s", async (name, managedIndex) => {
    const input = await fixture();
    await expect(engine(input, {
      onEvent: (event) => {
        if (event.name === name && (managedIndex === undefined || event.managedIndex === managedIndex)) {
          throw new Error(`injected ${name}`);
        }
      },
    }).apply(input.plan)).rejects.toThrow(`injected ${name}`);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
    expect(input.store.getTransaction(input.plan.id)).toBeUndefined();
    expect(input.store.getProposal(input.proposal.id)?.status).toBe("rejected");
  });

  it("leaves the vault untouched when snapshot or manifest durability fails", async () => {
    for (const boundary of ["after_source_snapshot_sync", "after_managed_snapshot_sync", "after_manifest_sync"] as const) {
      const input = await fixture();
      const before = await vaultState(input);
      await expect(engine(input, {
        onEvent: (event) => {
          if (event.name === boundary) throw new Error(`injected ${boundary}`);
        },
      }).apply(input.plan)).rejects.toThrow(`injected ${boundary}`);
      expect(await vaultState(input)).toEqual(before);
      await input.cleanup();
      cleanups.pop();
    }
  });

  it("recovers a pre-database crash and replay is idempotent", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const transactionDirectory = path.join(input.recovery, input.plan.id);
    const manifestPath = path.join(transactionDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, state: "vault_applied" }));
    input.store.close();
    const db = new Database(input.database);
    db.prepare("DELETE FROM organizer_transactions WHERE id=?").run(input.plan.id);
    db.prepare("UPDATE organizer_proposals SET status='pending', proposal_json=? WHERE id=?").run(JSON.stringify(input.proposal), input.proposal.id);
    db.close();
    input.store = new OrganizerStore(input.database);
    cleanups.push(async () => input.store.close());

    const first = await engine(input).recover();
    expect(first).toEqual([expect.objectContaining({ id: input.plan.id, outcome: "rolled_back" })]);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
    expect(input.store.getProposal(input.proposal.id)?.status).toBe("rejected");
    expect(await engine(input).recover()).toEqual([]);
    const report = JSON.parse(await readFile(path.join(transactionDirectory, "recovery-report.json"), "utf8"));
    expect(report).toEqual(expect.objectContaining({ id: input.plan.id, outcome: "rolled_back" }));
    expect(JSON.stringify(report)).not.toContain(original);
  });

  it("resumes recovery safely when the first recovery attempt is interrupted", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const manifestPath = path.join(input.recovery, input.plan.id, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, state: "vault_applied" }));
    input.store.close();
    const db = new Database(input.database);
    db.prepare("DELETE FROM organizer_transactions WHERE id=?").run(input.plan.id);
    db.prepare("UPDATE organizer_proposals SET status='pending', proposal_json=? WHERE id=?").run(JSON.stringify(input.proposal), input.proposal.id);
    db.close();
    input.store = new OrganizerStore(input.database);
    cleanups.push(async () => input.store.close());

    await expect(engine(input, {
      onEvent: (event) => { if (event.name === "recovery_managed_restored" && event.managedIndex === 0) throw new Error("interrupted recovery"); },
    }).recover()).rejects.toThrow("interrupted recovery");
    expect(await engine(input).recover()).toEqual([expect.objectContaining({ outcome: "rolled_back" })]);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
  });

  it("revalidates recovery parent lineage before touching a crash-state destination", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    input.store.close();
    const db = new Database(input.database);
    db.prepare("DELETE FROM organizer_transactions WHERE id=?").run(input.plan.id);
    db.prepare("UPDATE organizer_proposals SET status='pending', proposal_json=? WHERE id=?").run(JSON.stringify(input.proposal), input.proposal.id);
    db.close();
    input.store = new OrganizerStore(input.database);
    cleanups.push(async () => input.store.close());

    const targetParent = path.join(input.vault, "20_Study", "22_RL");
    await rename(targetParent, `${targetParent}-real`);
    const outside = path.join(input.root, "outside-recovery");
    await mkdir(outside);
    await writeFile(path.join(outside, "organized.md"), organized);
    await symlink(outside, targetParent, process.platform === "win32" ? "junction" : "dir");

    await expect(engine(input).recover()).rejects.toThrow(/symlink|lineage|safe|identity/i);
    expect(await readFile(path.join(outside, "organized.md"), "utf8")).toBe(organized);
  });

  it("undoes once and restores all exact before-images", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const undone = await new OrganizerTransactionEngine({
      recoveryRoot: input.recovery,
      store: input.store,
      now: () => "2026-09-03T02:00:00.000Z",
    }).undo(input.plan.id);
    expect(undone.undoneAt).toBe("2026-09-03T02:00:00.000Z");
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
    await expect(engine(input).undo(input.plan.id)).rejects.toThrow(/already undone/i);
  });

  it("rejects a completed apply replay without changing the committed vault", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const before = await vaultState(input);
    await expect(engine(input).apply(input.plan)).rejects.toThrow(/pending|already|replay/i);
    expect(await vaultState(input)).toEqual(before);
  });

  it.each(["destination", "source", "managed"] as const)("undo detects a newer %s edit and performs no writes", async (kind) => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    if (kind === "destination") await writeFile(path.join(input.vault, ...destinationPath.split("/")), `${organized}human edit\n`);
    if (kind === "source") await writeFile(path.join(input.vault, ...sourcePath.split("/")), "new human source");
    if (kind === "managed") await writeFile(path.join(input.vault, ...mocPath.split("/")), `${nextMoc}human edit\n`);
    const before = await vaultState(input);
    await expect(engine(input).undo(input.plan.id)).rejects.toThrow(/conflict/i);
    expect(await vaultState(input)).toEqual(before);
    expect(input.store.getTransaction(input.plan.id)?.undoneAt).toBeUndefined();
  });

  it("undo treats a case-equivalent restored source as a conflict", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const collisionPath = path.join(input.vault, "Agent-Inbox", "SOURCE.md");
    await writeFile(collisionPath, "human source");
    const before = await vaultState(input);
    await expect(engine(input).undo(input.plan.id)).rejects.toThrow(/conflict/i);
    expect(await vaultState(input)).toEqual(before);
    expect(await readFile(collisionPath, "utf8")).toBe("human source");
  });

  it.each([
    ["after_undo_managed_publish", 0],
    ["after_undo_managed_publish", 1],
    ["after_undo_source_publish", undefined],
    ["after_undo_destination_remove", undefined],
    ["before_undo_database_commit", undefined],
  ] as const)("undo rolls back all files after injected %s boundary %s", async (name, managedIndex) => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const applied = await vaultState(input);
    await expect(engine(input, {
      onEvent: (event) => {
        if (event.name === name && (managedIndex === undefined || event.managedIndex === managedIndex)) throw new Error(`injected ${name}`);
      },
    }).undo(input.plan.id)).rejects.toThrow(`injected ${name}`);
    expect(await vaultState(input)).toEqual(applied);
    expect(input.store.getTransaction(input.plan.id)?.undoneAt).toBeUndefined();
  });

  it("fails closed on a corrupt or oversized manifest without changing the vault", async () => {
    for (const corrupt of ["{bad json", JSON.stringify({ junk: "x".repeat(70_000) })]) {
      const input = await fixture();
      await engine(input).apply(input.plan);
      const before = await vaultState(input);
      const manifestPath = path.join(input.recovery, input.plan.id, "manifest.json");
      await chmod(manifestPath, 0o600);
      await writeFile(manifestPath, corrupt);
      await expect(engine(input).undo(input.plan.id)).rejects.toThrow(/manifest/i);
      expect(await vaultState(input)).toEqual(before);
      await input.cleanup();
      cleanups.pop();
    }
  });

  it("recovers an interrupted undo back to the complete applied state exactly once", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await new OrganizerTransactionEngine({
      recoveryRoot: input.recovery,
      store: input.store,
      now: () => "2026-09-03T02:00:00.000Z",
    }).undo(input.plan.id);
    input.store.close();
    const db = new Database(input.database);
    db.prepare("UPDATE organizer_transactions SET undone_at=NULL WHERE id=?").run(input.plan.id);
    db.close();
    input.store = new OrganizerStore(input.database);
    cleanups.push(async () => input.store.close());

    expect(await engine(input).recover()).toEqual([expect.objectContaining({ outcome: "undo_rolled_back" })]);
    expect(await vaultState(input)).toEqual({ source: undefined, destination: organized, moc: nextMoc, canvas: nextCanvas });
    expect(await engine(input).recover()).toEqual([]);
  });

  it.each(["Agent-Inbox/Ｆ.md", "Agent-Inbox/e\u0301.md"])('applies a scanner-accepted exact Unicode source spelling %s', async (unicodePath) => {
    const input = await fixture();
    await replaceProposalSource(input, unicodePath);
    await engine(input).apply(input.plan);
    expect(await readFile(path.join(input.vault, ...destinationPath.split("/")), "utf8")).toBe(organized);
    await expect(lstat(path.join(input.vault, ...unicodePath.split("/")))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects exact or normalized path components above the Task 2 UTF-8 limit", async () => {
    const input = await fixture();
    const longPath = `Agent-Inbox/${"가".repeat(81)}.md`;
    await replaceProposalSource(input, longPath);
    const before = await vaultState(input);
    await expect(engine(input).apply(input.plan)).rejects.toThrow(/component|byte|limit/i);
    expect(await vaultState(input)).toEqual(before);
  });

  it("preflights every apply rollback snapshot before mutating the crash-state vault", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await resetToPreDatabaseCrash(input);
    const transactionDirectory = path.join(input.recovery, input.plan.id);
    await writeFile(path.join(transactionDirectory, "managed-001.snapshot"), "corrupt snapshot");
    const before = await vaultState(input);
    await expect(engine(input).recover()).rejects.toThrow(/snapshot|hash/i);
    expect(await vaultState(input)).toEqual(before);
  });

  it("restores source first and removes the owned destination last during apply recovery", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await resetToPreDatabaseCrash(input);
    const events: TransactionEvent[] = [];
    await engine(input, { onEvent: (event) => { events.push(event); } }).recover();
    const names = events.map((event) => event.name);
    expect(names.indexOf("recovery_source_restored")).toBeLessThan(names.indexOf("recovery_managed_restored"));
    expect(names.indexOf("recovery_managed_restored")).toBeLessThan(names.indexOf("recovery_destination_removed"));
  });

  it.each([
    ["recovery_source_restored", undefined],
    ["recovery_managed_restored", 0],
    ["recovery_managed_restored", 1],
    ["recovery_destination_removed", undefined],
  ] as const)("replays apply recovery after an interruption at %s %s", async (name, managedIndex) => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await resetToPreDatabaseCrash(input);
    await expect(engine(input, {
      onEvent: (event) => {
        if (event.name === name && (managedIndex === undefined || event.managedIndex === managedIndex)) throw new Error(`crash ${name}`);
      },
    }).recover()).rejects.toThrow(`crash ${name}`);
    await expect(engine(input).recover()).resolves.toEqual([expect.objectContaining({ outcome: "rolled_back" })]);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
  });

  it("preflights every undo rollback image before mutating an interrupted undo", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await new OrganizerTransactionEngine({ recoveryRoot: input.recovery, store: input.store, now: () => "2026-09-03T02:00:00.000Z" }).undo(input.plan.id);
    input.store.close();
    const db = new Database(input.database);
    db.prepare("UPDATE organizer_transactions SET undone_at=NULL WHERE id=?").run(input.plan.id);
    db.close();
    input.store = new OrganizerStore(input.database);
    cleanups.push(async () => input.store.close());
    const transactionDirectory = path.join(input.recovery, input.plan.id);
    await writeFile(path.join(transactionDirectory, "undo-managed-001.snapshot"), "corrupt snapshot");
    const before = await vaultState(input);
    await expect(engine(input).recover()).rejects.toThrow(/snapshot|hash/i);
    expect(await vaultState(input)).toEqual(before);
  });

  it.each([
    ["undo_recovery_destination_restored", undefined],
    ["undo_recovery_managed_restored", 0],
    ["undo_recovery_managed_restored", 1],
    ["undo_recovery_source_removed", undefined],
  ] as const)("replays undo rollback after an interruption at %s %s", async (name, managedIndex) => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await new OrganizerTransactionEngine({ recoveryRoot: input.recovery, store: input.store, now: () => "2026-09-03T02:00:00.000Z" }).undo(input.plan.id);
    await resetUndoneDatabaseToApplied(input);
    await expect(engine(input, {
      onEvent: (event) => {
        if (event.name === name && (managedIndex === undefined || event.managedIndex === managedIndex)) throw new Error(`crash ${name}`);
      },
    }).recover()).rejects.toThrow(`crash ${name}`);
    await expect(engine(input).recover()).resolves.toEqual([expect.objectContaining({ outcome: "undo_rolled_back" })]);
    expect(await vaultState(input)).toEqual({ source: undefined, destination: organized, moc: nextMoc, canvas: nextCanvas });
  });

  it("revalidates a managed target after its temp file is synced and immediately before rename", async () => {
    const input = await fixture();
    const mocAbsolute = path.join(input.vault, ...mocPath.split("/"));
    await expect(engine(input, {
      onEvent: async (event) => {
        if ((event.name as string) === "managed_temp_synced" && event.managedIndex === 1) {
          await rename(mocAbsolute, `${mocAbsolute}.moved-after-sync`);
          await writeFile(mocAbsolute, currentMoc);
        }
      },
    }).apply(input.plan)).rejects.toThrow(/identity|changed/i);
    expect(await readFile(`${mocAbsolute}.moved-after-sync`, "utf8")).toBe(currentMoc);
    expect(input.store.getTransaction(input.plan.id)).toBeUndefined();
  });

  it.each(["disappear", "replace"] as const)("revalidates source %s immediately before unlink", async (kind) => {
    const input = await fixture();
    const sourceAbsolute = path.join(input.vault, ...sourcePath.split("/"));
    await expect(engine(input, {
      onEvent: async (event) => {
        if ((event.name as string) === "before_source_unlink") {
          if (kind === "disappear") await rm(sourceAbsolute);
          else {
            await rename(sourceAbsolute, `${sourceAbsolute}.moved-before-unlink`);
            await writeFile(sourceAbsolute, original);
          }
        }
      },
    }).apply(input.plan)).rejects.toThrow(/stale|changed|identity/i);
    expect(input.store.getTransaction(input.plan.id)).toBeUndefined();
  });

  it("rejects an inside-Vault recovery root before creating it", async () => {
    const input = await fixture();
    const inside = path.join(input.vault, "private-recovery");
    await expect(engine(input, { recoveryRoot: inside } as never).apply(input.plan)).rejects.toThrow(/outside/i);
    await expect(lstat(inside)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
  });

  it.each(["direct", "ancestor"] as const)("rejects a %s recovery-root symlink before chmod or creation", async (kind) => {
    const input = await fixture();
    const outside = path.join(input.root, `outside-${kind}`);
    await mkdir(outside);
    const linkPath = path.join(input.root, `recovery-link-${kind}`);
    await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
    const recoveryRoot = kind === "direct" ? linkPath : path.join(linkPath, "nested");
    await expect(engine(input, { recoveryRoot } as never).apply(input.plan)).rejects.toThrow(/symlink|junction|safe/i);
    if (kind === "ancestor") await expect(lstat(path.join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("durably links each newly created recovery component before creating the next", async () => {
    const input = await fixture();
    const recoveryRoot = path.join(input.root, "state", "transactions");
    const events: TransactionEvent[] = [];
    await engine(input, { recoveryRoot, onEvent: (event: TransactionEvent) => { events.push(event); } } as never).apply(input.plan);
    const names = events.map((event) => event.name as string);
    const creates = names.map((name, index) => name === "recovery_component_created" ? index : -1).filter((index) => index >= 0);
    const syncs = names.map((name, index) => name === "recovery_parent_synced" ? index : -1).filter((index) => index >= 0);
    expect(creates.length).toBeGreaterThanOrEqual(2);
    expect(syncs.length).toBe(creates.length);
    expect(creates[0]).toBeLessThan(syncs[0]);
    expect(syncs[0]).toBeLessThan(creates[1]);
    expect(syncs.at(-1)!).toBeLessThan(names.indexOf("after_source_snapshot_sync"));
  });

  it("validates every generated MOC link target before any mutation", async () => {
    const input = await fixture();
    const badMoc = replaceManagedMocIndex(currentMoc, [
      { path: destinationPath, title: "Organized" },
      { path: "20_Study/missing.md", title: "Missing" },
    ]);
    const plan = {
      ...input.plan,
      managedReplacements: input.plan.managedReplacements.map((replacement) => replacement.relativePath === mocPath
        ? { ...replacement, content: badMoc }
        : replacement),
    };
    await expect(engine(input).apply(plan)).rejects.toThrow(/MOC|link|exist/i);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
  });

  it.skipIf(process.platform === "win32")("rejects case-ambiguous generated MOC link targets", async () => {
    const input = await fixture();
    await writeFile(path.join(input.vault, "20_Study", "Case.md"), "one");
    await writeFile(path.join(input.vault, "20_Study", "case.md"), "two");
    const badMoc = replaceManagedMocIndex(currentMoc, [{ path: "20_Study/Case.md", title: "Case" }]);
    const plan = {
      ...input.plan,
      managedReplacements: input.plan.managedReplacements.map((replacement) => replacement.relativePath === mocPath
        ? { ...replacement, content: badMoc }
        : replacement),
    };
    await expect(engine(input).apply(plan)).rejects.toThrow(/ambiguous|collision/i);
  });

  it("refuses to finalize recovery when the database has the same ID but different transaction content", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    input.store.close();
    const db = new Database(input.database);
    db.prepare("UPDATE organizer_transactions SET destination_hash=? WHERE id=?").run("f".repeat(64), input.plan.id);
    db.close();
    input.store = new OrganizerStore(input.database);
    cleanups.push(async () => input.store.close());
    const before = await vaultState(input);
    await expect(engine(input).recover()).rejects.toThrow(/database|match|reconcile/i);
    expect(await vaultState(input)).toEqual(before);
  });

  it("recreates a missing terminal recovery report on the next recovery pass", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await engine(input).recover();
    const reportPath = path.join(input.recovery, input.plan.id, "recovery-report.json");
    await rm(reportPath);
    expect(await engine(input).recover()).toEqual([expect.objectContaining({ id: input.plan.id, outcome: "committed" })]);
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(expect.objectContaining({ outcome: "committed" }));
  });

  it.each([
    "before_destination_link",
    "before_destination_chmod",
    "before_destination_directory_sync",
    "before_destination_temp_unlink",
  ])("fails safely when destination publication injects %s", async (fault) => {
    const input = await fixture();
    await expect(engine(input, {
      onEvent: (event) => { if ((event.name as string) === fault) throw new Error(`injected ${fault}`); },
    }).apply(input.plan)).rejects.toThrow(`injected ${fault}`);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
    expect(input.store.getTransaction(input.plan.id)).toBeUndefined();
  });

  it("leaves recoverable state and no bookkeeping when owned destination unlink fails", async () => {
    const input = await fixture();
    await expect(engine(input, {
      onEvent: (event) => {
        if (event.name === "destination_published") throw new Error("trigger rollback");
        if ((event.name as string) === "before_recovery_destination_unlink") throw new Error("injected target unlink");
      },
    }).apply(input.plan)).rejects.toThrow(/rollback could not complete/i);
    expect(input.store.getProposal(input.proposal.id)?.status).toBe("pending");
    expect(input.store.getTransaction(input.plan.id)).toBeUndefined();
    expect((await vaultState(input)).destination).toBe(organized);
  });

  it("removes only transaction-derived valid orphan Vault temps during recovery", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await resetToPreDatabaseCrash(input);
    const mocAbsolute = path.join(input.vault, ...mocPath.split("/"));
    const orphan = path.join(path.dirname(mocAbsolute), `.brain-organizer-${input.plan.id}-recover-managed-001.tmp`);
    await writeFile(orphan, currentMoc);
    await engine(input).recover();
    await expect(lstat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
  });

  it("fails closed before rollback when a transaction-derived orphan temp has unexpected content", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await resetToPreDatabaseCrash(input);
    const mocAbsolute = path.join(input.vault, ...mocPath.split("/"));
    const orphan = path.join(path.dirname(mocAbsolute), `.brain-organizer-${input.plan.id}-recover-managed-001.tmp`);
    await writeFile(orphan, "not an owned before-image");
    const before = await vaultState(input);
    await expect(engine(input).recover()).rejects.toThrow(/temporary|content|invalid/i);
    expect(await vaultState(input)).toEqual(before);
    expect(await readFile(orphan, "utf8")).toBe("not an owned before-image");
  });

  it("retains recovery automatically and exposes only backup-gated 30-day terminal cleanup", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await engine(input).recover();
    const directory = path.join(input.recovery, input.plan.id);
    await expect(engine(input).cleanupRecovery({ now: "2026-10-04T01:00:00.000Z", backupVerified: false }))
      .rejects.toThrow(/backup/i);
    expect((await lstat(directory)).isDirectory()).toBe(true);
    expect(await engine(input).cleanupRecovery({ now: "2026-09-20T01:00:00.000Z", backupVerified: true })).toEqual([]);
    expect(await engine(input).cleanupRecovery({ now: "2026-10-04T01:00:00.000Z", backupVerified: true }))
      .toEqual([input.plan.id]);
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["／", "＼"])("rejects a path component whose NFKC form introduces a separator: %s", async (separator) => {
    const input = await fixture();
    await replaceProposalSource(input, `Agent-Inbox/bad${separator}name.md`);
    const before = await vaultState(input);
    await expect(engine(input).apply(input.plan)).rejects.toThrow(/path|unsafe|separator/i);
    expect(await vaultState(input)).toEqual(before);
  });

  it("promotes and recovers a valid synced initial manifest temp", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const directory = path.join(input.recovery, input.plan.id);
    const manifestPath = path.join(directory, "manifest.json");
    const tempPath = path.join(directory, `.brain-organizer-${input.plan.id}-manifest.json.tmp`);
    await rename(manifestPath, tempPath);
    await expect(engine(input).recover()).resolves.toEqual([expect.objectContaining({ outcome: "committed" })]);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(expect.objectContaining({ state: "committed" }));
    await expect(lstat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["corrupt", "oversized", "wrong-id"] as const)("fails closed for a %s initial manifest temp", async (kind) => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const directory = path.join(input.recovery, input.plan.id);
    const manifestPath = path.join(directory, "manifest.json");
    const tempPath = path.join(directory, `.brain-organizer-${input.plan.id}-manifest.json.tmp`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await rename(manifestPath, tempPath);
    if (kind === "corrupt") await writeFile(tempPath, "{not-json");
    if (kind === "oversized") await writeFile(tempPath, "x".repeat(70_000));
    if (kind === "wrong-id") await writeFile(tempPath, JSON.stringify({ ...manifest, id: "ORG-wrong" }));
    const before = await vaultState(input);
    await expect(engine(input).recover()).rejects.toThrow(/manifest|oversized|schema|invalid/i);
    expect(await vaultState(input)).toEqual(before);
  });

  it("fails closed on an unknown artifact beside an initial manifest temp", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const directory = path.join(input.recovery, input.plan.id);
    await rename(path.join(directory, "manifest.json"), path.join(directory, `.brain-organizer-${input.plan.id}-manifest.json.tmp`));
    await writeFile(path.join(directory, "unknown.secret"), "do not delete");
    const before = await vaultState(input);
    await expect(engine(input).recover()).rejects.toThrow(/unknown|unverified|artifact/i);
    expect(await vaultState(input)).toEqual(before);
    expect(await readFile(path.join(directory, "unknown.secret"), "utf8")).toBe("do not delete");
  });

  it("fails closed on a transaction-shaped symlink entry in the recovery root", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const outside = path.join(input.root, "recovery-entry-outside");
    await mkdir(outside);
    await symlink(outside, path.join(input.recovery, "ORG-other-entry"), process.platform === "win32" ? "junction" : "dir");
    const before = await vaultState(input);
    await expect(engine(input).recover()).rejects.toThrow(/symlink|unsafe|directory/i);
    expect(await vaultState(input)).toEqual(before);
  });

  it("rejects a same-outcome terminal report whose timestamp predates the manifest", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await engine(input).recover();
    const reportPath = path.join(input.recovery, input.plan.id, "recovery-report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    await writeFile(reportPath, JSON.stringify({ ...report, at: "2026-09-03T00:30:00.000Z" }));
    const before = await vaultState(input);
    await expect(engine(input).recover()).rejects.toThrow(/timestamp|report|manifest/i);
    expect(await vaultState(input)).toEqual(before);
  });

  it.each([
    ["apply_managed_rename", canvasPath],
    ["apply_source_unlink", sourcePath],
  ] as const)("does not overwrite or delete a human pathname substitution at %s", async (operation, relativePath) => {
    const input = await fixture();
    const absolute = path.join(input.vault, ...relativePath.split("/"));
    const moved = `${absolute}.pre-race`;
    await expect(engine(input, {
      onEvent: async (event) => {
        if ((event as TransactionEvent & { operation?: string }).operation !== operation) return;
        await rename(absolute, moved);
        await writeFile(absolute, "human replacement");
      },
    }).apply(input.plan)).rejects.toThrow(/identity|changed|stale|rollback/i);
    expect(await readFile(absolute, "utf8")).toBe("human replacement");
    expect(await readFile(moved, "utf8")).toBe(relativePath === sourcePath ? original : currentCanvas);
  });

  it("does not delete a human destination substitution during undo", async () => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const absolute = path.join(input.vault, ...destinationPath.split("/"));
    const moved = `${absolute}.pre-race`;
    await expect(engine(input, {
      onEvent: async (event) => {
        if ((event as TransactionEvent & { operation?: string }).operation !== "undo_destination_unlink") return;
        await rename(absolute, moved);
        await writeFile(absolute, "human destination");
      },
    }).undo(input.plan.id)).rejects.toThrow(/identity|changed|rollback|conflict/i);
    expect(await readFile(absolute, "utf8")).toBe("human destination");
    expect(await readFile(moved, "utf8")).toBe(organized);
  });

  it.each([
    ["recovery_managed_rename", canvasPath, "managed"],
    ["recovery_destination_unlink", destinationPath, "destination"],
    ["undo_recovery_managed_rename", canvasPath, "undo"],
  ] as const)("does not overwrite or delete a human pathname substitution at %s", async (operation, relativePath, phase) => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    const absolute = path.join(input.vault, ...relativePath.split("/"));
    const moved = `${absolute}.pre-race`;
    let triggered = false;
    if (phase === "undo") {
      await expect(engine(input, {
        onEvent: async (event) => {
          if (!triggered && event.name === "after_undo_managed_publish" && event.managedIndex === 0) {
            triggered = true;
            throw new Error("start undo rollback");
          }
          if (
            (event as TransactionEvent & { operation?: string }).operation === operation
            && (!operation.includes("managed") || event.managedIndex === 0)
          ) {
            await rename(absolute, moved);
            await writeFile(absolute, "human rollback replacement");
          }
        },
      }).undo(input.plan.id)).rejects.toThrow(/rollback could not complete/i);
    } else {
      await resetToPreDatabaseCrash(input);
      await expect(engine(input, {
        onEvent: async (event) => {
          if (
            (event as TransactionEvent & { operation?: string }).operation !== operation
            || (operation.includes("managed") && event.managedIndex !== 0)
          ) return;
          await rename(absolute, moved);
          await writeFile(absolute, "human rollback replacement");
        },
      }).recover()).rejects.toThrow(/identity|changed|conflict/i);
    }
    expect(await readFile(absolute, "utf8")).toBe("human rollback replacement");
  });

  it("revalidates generated MOC links after temp sync and before rename", async () => {
    const input = await fixture();
    const referenced = "20_Study/reference.md";
    await writeFile(path.join(input.vault, ...referenced.split("/")), "reference");
    const moc = replaceManagedMocIndex(currentMoc, [
      { path: destinationPath, title: "Organized" },
      { path: referenced, title: "Reference" },
    ]);
    const plan = {
      ...input.plan,
      managedReplacements: input.plan.managedReplacements.map((item) => item.relativePath === mocPath ? { ...item, content: moc } : item),
    };
    await expect(engine(input, {
      onEvent: async (event) => {
        if (event.name === "managed_temp_synced" && event.managedIndex === 1) await rm(path.join(input.vault, ...referenced.split("/")));
      },
    }).apply(plan)).rejects.toThrow(/MOC|link|exist|reference/i);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
    expect(input.store.getTransaction(input.plan.id)).toBeUndefined();
  });

  it.each([
    "recovery_destination_ownership_inferred",
    "recovery_destination_ownership_persisted",
    "recovery_destination_proof_removed",
    "recovery_destination_removed",
  ])("replays recovery after a crash at durable ownership boundary %s", async (fault) => {
    const input = await fixture();
    await engine(input).apply(input.plan);
    await resetToPreDatabaseCrash(input);
    const directory = path.join(input.recovery, input.plan.id);
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, state: "prepared", destinationOwned: false }));
    const destination = path.join(input.vault, ...destinationPath.split("/"));
    const proof = path.join(path.dirname(destination), `.brain-organizer-${input.plan.id}-destination.tmp`);
    await link(destination, proof);
    await expect(engine(input, {
      onEvent: (event) => { if ((event.name as string) === fault) throw new Error(`crash ${fault}`); },
    }).recover()).rejects.toThrow(`crash ${fault}`);
    const durable = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(durable.destinationOwned).toBe(fault !== "recovery_destination_ownership_inferred");
    await expect(engine(input).recover()).resolves.toEqual([expect.objectContaining({ outcome: "rolled_back" })]);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
  });

  it("leaves hard-link proof and durably marks ownership after a post-link marker failure", async () => {
    const input = await fixture();
    const directory = path.join(input.recovery, input.plan.id);
    const destination = path.join(input.vault, ...destinationPath.split("/"));
    const proof = path.join(path.dirname(destination), `.brain-organizer-${input.plan.id}-destination.tmp`);
    let publicationFaulted = false;
    await expect(engine(input, {
      onEvent: async (event) => {
        if ((event.name as string) === "before_destination_ownership_persist" && !publicationFaulted) {
          publicationFaulted = true;
          throw new Error("marker persistence failed");
        }
        if ((event.name as string) === "recovery_destination_ownership_persisted") {
          expect((await lstat(proof)).isFile()).toBe(true);
          throw new Error("crash after recovery marker");
        }
      },
    }).apply(input.plan)).rejects.toThrow(/rollback could not complete/i);
    expect(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")).destinationOwned).toBe(true);
    expect((await lstat(proof)).isFile()).toBe(true);
    await expect(engine(input).recover()).resolves.toEqual([expect.objectContaining({ outcome: "rolled_back" })]);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
  });

  it("rejects a generated MOC target renamed after its temp sync", async () => {
    const input = await fixture();
    const referenced = "20_Study/reference.md";
    const referencedAbsolute = path.join(input.vault, ...referenced.split("/"));
    await writeFile(referencedAbsolute, "reference");
    const moc = replaceManagedMocIndex(currentMoc, [
      { path: destinationPath, title: "Organized" },
      { path: referenced, title: "Reference" },
    ]);
    const plan = {
      ...input.plan,
      managedReplacements: input.plan.managedReplacements.map((item) => item.relativePath === mocPath ? { ...item, content: moc } : item),
    };
    await expect(engine(input, {
      onEvent: async (event) => {
        if (event.name === "managed_temp_synced" && event.managedIndex === 1) await rename(referencedAbsolute, path.join(path.dirname(referencedAbsolute), "Reference.md"));
      },
    }).apply(plan)).rejects.toThrow(/MOC|link|exist|spelling/i);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
  });

  it.skipIf(process.platform === "win32")("rejects a generated MOC target made case-ambiguous after its temp sync", async () => {
    const input = await fixture();
    const referenced = "20_Study/Case.md";
    await writeFile(path.join(input.vault, ...referenced.split("/")), "reference");
    const moc = replaceManagedMocIndex(currentMoc, [
      { path: destinationPath, title: "Organized" },
      { path: referenced, title: "Case" },
    ]);
    const plan = {
      ...input.plan,
      managedReplacements: input.plan.managedReplacements.map((item) => item.relativePath === mocPath ? { ...item, content: moc } : item),
    };
    await expect(engine(input, {
      onEvent: async (event) => {
        if (event.name === "managed_temp_synced" && event.managedIndex === 1) await writeFile(path.join(input.vault, "20_Study", "case.md"), "ambiguous");
      },
    }).apply(plan)).rejects.toThrow(/ambiguous|collision|MOC/i);
    expect(await vaultState(input)).toEqual({ source: original, destination: undefined, moc: currentMoc, canvas: currentCanvas });
  });
});
