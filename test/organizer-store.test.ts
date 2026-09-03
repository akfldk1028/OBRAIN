import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { OrganizerStore } from "../src/organizer/store.js";
import type { StoredProposal, TransactionRecord } from "../src/organizer/types.js";

const roots: string[] = [];

async function databaseFile(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-organizer-store-"));
  roots.push(root);
  return path.join(root, "organizer.sqlite");
}

function proposal(id = "PRP-20260903-001"): StoredProposal {
  return {
    id,
    vault: "brain",
    sourcePath: "Agent-Inbox/inbox-note.md",
    sourceHash: "a".repeat(64),
    destinationPath: "20_Study/22_RL/MDP.md",
    policyVersion: "1.0.0",
    createdAt: "2026-09-03T00:00:00.000Z",
    expiresAt: "2026-09-04T00:00:00.000Z",
    status: "pending",
    targetDirectory: "20_Study/22_RL",
    title: "Markov decision processes",
    type: "study",
    tags: ["reinforcement-learning"],
    summary: "A framework for sequential decisions.",
    analogy: "A map for choosing the next step.",
    notes: "Keep state and reward separate.",
    tips: ["Start with the Bellman equation."],
    warnings: ["Do not confuse a policy with a value function."],
    relatedNotePaths: ["20_Study/22_RL/MDP.md"],
    confidence: 0.91,
    reason: "The note discusses reinforcement learning concepts.",
  };
}

function transaction(proposalId: string): TransactionRecord {
  return {
    id: "ORG-20260903-001",
    proposalId,
    vault: "brain",
    sourcePath: "Agent-Inbox/inbox-note.md",
    destinationPath: "20_Study/22_RL/MDP.md",
    sourceHash: "a".repeat(64),
    destinationHash: "b".repeat(64),
    appliedAt: "2026-09-03T01:00:00.000Z",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OrganizerStore", () => {
  it("persists proposals and completed runs across a clean reopen", async () => {
    const file = await databaseFile();
    const stored = proposal();
    const store = new OrganizerStore(file);
    const run = store.startRun({ vault: "brain", mode: "dry-run", startedAt: "2026-09-03T00:00:00.000Z" });
    store.saveProposal(stored);
    store.finishRun(run.runId, {
      ...run,
      discovered: 1,
      proposed: 1,
      status: "complete",
    }, "2026-09-03T00:05:00.000Z");
    store.close();

    const reopened = new OrganizerStore(file);
    expect(reopened.getProposal(stored.id)).toEqual(stored);
    expect(reopened.getRun(run.runId)).toEqual({
      ...run,
      discovered: 1,
      proposed: 1,
      status: "complete",
    });
    reopened.close();
  });

  it("rejects replayed proposal IDs and only permits explicit proposal transitions", async () => {
    const store = new OrganizerStore(await databaseFile());
    const stored = proposal();
    store.saveProposal(stored);

    expect(() => store.saveProposal(stored)).toThrow("proposal already exists");
    expect(() => store.markProposal(stored.id, "applied")).toThrow("transaction");
    expect(store.markProposal(stored.id, "stale")).toEqual({ ...stored, status: "stale" });
    expect(() => store.markProposal(stored.id, "pending")).toThrow("invalid proposal transition");
    store.close();
  });

  it("records one transaction per proposal and permits undo exactly once", async () => {
    const store = new OrganizerStore(await databaseFile());
    const stored = proposal();
    const applied = transaction(stored.id);
    store.saveProposal(stored);
    expect(store.applyProposalWithTransaction(applied)).toEqual({
      proposal: { ...stored, status: "applied" },
      transaction: applied,
    });
    expect(store.getProposal(stored.id)).toEqual({ ...stored, status: "applied" });

    expect(store.getTransaction(applied.id)).toEqual(applied);
    expect(store.markUndone(applied.id, "2026-09-03T02:00:00.000Z")).toEqual({
      ...applied,
      undoneAt: "2026-09-03T02:00:00.000Z",
    });
    expect(() => store.markUndone(applied.id, "2026-09-03T03:00:00.000Z")).toThrow("transaction already undone");
    expect(() => store.recordTransaction({ ...applied, id: "ORG-20260903-002" })).toThrow("transaction already exists");
    store.close();
  });

  it("rolls back both proposal and transaction when atomic application cannot insert", async () => {
    const store = new OrganizerStore(await databaseFile());
    const first = proposal();
    const second = proposal("PRP-20260903-002");
    store.saveProposal(first);
    store.saveProposal(second);
    store.applyProposalWithTransaction(transaction(first.id));

    expect(() => store.applyProposalWithTransaction({ ...transaction(second.id), id: "ORG-20260903-001" }))
      .toThrow("transaction already exists");
    expect(store.getProposal(second.id)).toEqual(second);
    expect(store.getTransaction("ORG-20260903-001")?.proposalId).toBe(first.id);
    store.close();
  });

  it("uses UTF-8 byte limits consistently for Korean proposal and transaction columns", async () => {
    const store = new OrganizerStore(await databaseFile());
    const maxVault = "가".repeat(85) + "a";
    const maxPath = "가".repeat(341) + "/";
    const maxPolicy = "가".repeat(42) + "aa";
    const stored = proposal();
    const bounded = {
      ...stored,
      vault: maxVault,
      sourcePath: maxPath,
      destinationPath: maxPath,
      policyVersion: maxPolicy,
    };
    store.saveProposal(bounded);
    expect(store.getProposal(bounded.id)).toEqual(bounded);
    expect(() => store.saveProposal({ ...proposal("PRP-20260903-002"), vault: "가".repeat(86) })).toThrow();
    expect(() => store.saveProposal({ ...proposal("PRP-20260903-003"), sourcePath: "가".repeat(342) })).toThrow();
    expect(() => store.saveProposal({ ...proposal("PRP-20260903-004"), policyVersion: "가".repeat(43) })).toThrow();
    expect(() => store.saveProposal({ ...proposal("PRP-20260903-005"), targetDirectory: "Ｆ".repeat(171) })).toThrow();
    expect(() => store.applyProposalWithTransaction({ ...transaction(bounded.id), vault: "가".repeat(86) })).toThrow();
    store.close();
  });

  it("enforces proposal, transaction, and undo time ordering", async () => {
    const store = new OrganizerStore(await databaseFile());
    expect(() => store.saveProposal({
      ...proposal(),
      createdAt: "2026-09-03T02:00:00.000Z",
      expiresAt: "2026-09-03T01:00:00.000Z",
    })).toThrow("invalid new proposal");
    const stored = proposal();
    store.saveProposal(stored);
    expect(() => store.applyProposalWithTransaction({ ...transaction(stored.id), appliedAt: "2026-09-02T23:59:59.999Z" }))
      .toThrow("transaction does not match proposal");
    store.applyProposalWithTransaction(transaction(stored.id));
    expect(() => store.markUndone("ORG-20260903-001", "2026-09-03T00:59:59.999Z"))
      .toThrow("undo is before transaction application");
    store.close();
  });

  it("fails closed when a persisted undo predates its application", async () => {
    const file = await databaseFile();
    const store = new OrganizerStore(file);
    const stored = proposal();
    store.saveProposal(stored);
    store.applyProposalWithTransaction(transaction(stored.id));
    store.close();
    const db = new Database(file);
    db.prepare("UPDATE organizer_transactions SET undone_at=? WHERE id=?")
      .run("2026-09-03T00:59:59.999Z", "ORG-20260903-001");
    db.close();
    const reopened = new OrganizerStore(file);
    expect(() => reopened.getTransaction("ORG-20260903-001")).toThrow("invalid stored transaction");
    reopened.close();
  });

  it("rejects run completion with a mismatched mode or a time before its start", async () => {
    const store = new OrganizerStore(await databaseFile());
    const run = store.startRun({ vault: "brain", mode: "dry-run", startedAt: "2026-09-03T01:00:00.000Z" });
    expect(() => store.finishRun(run.runId, { ...run, mode: "automatic", status: "complete" }, "2026-09-03T02:00:00.000Z"))
      .toThrow("run mode");
    expect(() => store.finishRun(run.runId, { ...run, status: "complete" }, "2026-09-03T00:59:59.999Z"))
      .toThrow("before run start");
    expect(store.getRun(run.runId)).toEqual(run);
    store.close();
  });

  it("fails closed for corrupted run completion invariants", async () => {
    const file = await databaseFile();
    const store = new OrganizerStore(file);
    const run = store.startRun({ vault: "brain", mode: "dry-run", startedAt: "2026-09-03T00:00:00.000Z" });
    store.close();
    const db = new Database(file);
    db.prepare("UPDATE organizer_runs SET summary_json=?, finished_at=NULL WHERE id=?").run(
      JSON.stringify({ ...run, status: "complete" }), run.runId,
    );
    db.close();
    const reopened = new OrganizerStore(file);
    expect(() => reopened.getRun(run.runId)).toThrow("invalid stored run");
    reopened.close();
  });

  it("starts the seven-day trial once and returns a stable state after reopen", async () => {
    const file = await databaseFile();
    const store = new OrganizerStore(file);
    expect(store.getOrStartTrial("2026-09-03T00:00:00.000Z")).toEqual({
      startedAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-10T00:00:00.000Z",
      active: true,
    });
    store.close();

    const reopened = new OrganizerStore(file);
    expect(reopened.getOrStartTrial("2026-09-11T00:00:00.000Z")).toEqual({
      startedAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-10T00:00:00.000Z",
      active: false,
    });
    expect(reopened.getOrStartTrial("2026-09-09T00:00:00.000Z").active).toBe(false);
    reopened.close();
  });

  it("rejects an incompatible partial organizer schema at open", async () => {
    const file = await databaseFile();
    const db = new Database(file);
    db.exec("CREATE TABLE organizer_meta (key TEXT PRIMARY KEY)");
    db.close();
    expect(() => new OrganizerStore(file)).toThrow("incompatible organizer schema");
  });

  it("fails before persisting a non-representable trial expiry", async () => {
    const store = new OrganizerStore(await databaseFile());
    expect(() => store.getOrStartTrial("9999-12-31T23:59:59.999Z")).toThrow("invalid stored trial");
    store.close();
  });

  it("rejects a same-named organizer table with an incompatible column layout", async () => {
    const file = await databaseFile();
    const db = new Database(file);
    db.exec(`
      CREATE TABLE organizer_meta (key INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE organizer_runs (id TEXT PRIMARY KEY, vault TEXT NOT NULL, mode TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, summary_json TEXT);
      CREATE TABLE organizer_proposals (id TEXT PRIMARY KEY, vault TEXT NOT NULL, source_path TEXT NOT NULL, source_hash TEXT NOT NULL, destination_path TEXT NOT NULL, policy_version TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL, proposal_json TEXT NOT NULL);
      CREATE TABLE organizer_transactions (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE, vault TEXT NOT NULL, source_path TEXT NOT NULL, destination_path TEXT NOT NULL, source_hash TEXT NOT NULL, destination_hash TEXT NOT NULL, applied_at TEXT NOT NULL, undone_at TEXT);
    `);
    db.close();
    expect(() => new OrganizerStore(file)).toThrow("incompatible organizer schema");
  });

  it("fails closed when persisted proposal JSON does not satisfy the bounded schema", async () => {
    const file = await databaseFile();
    const store = new OrganizerStore(file);
    const stored = proposal();
    store.saveProposal(stored);
    store.close();

    const db = new Database(file);
    db.prepare("UPDATE organizer_proposals SET proposal_json=? WHERE id=?")
      .run(JSON.stringify({ ...stored, summary: "x".repeat(2_001) }), stored.id);
    db.close();

    const reopened = new OrganizerStore(file);
    expect(() => reopened.getProposal(stored.id)).toThrow("invalid stored proposal");
    reopened.close();
  });

  it("fails closed when persisted proposal JSON is malformed", async () => {
    const file = await databaseFile();
    const store = new OrganizerStore(file);
    const stored = proposal();
    store.saveProposal(stored);
    store.close();

    const db = new Database(file);
    db.prepare("UPDATE organizer_proposals SET proposal_json=? WHERE id=?")
      .run("{not json", stored.id);
    db.close();

    const reopened = new OrganizerStore(file);
    expect(() => reopened.getProposal(stored.id)).toThrow("invalid stored proposal");
    reopened.close();
  });
});
