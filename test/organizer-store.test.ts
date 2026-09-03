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
    expect(store.markProposal(stored.id, "applied")).toEqual({ ...stored, status: "applied" });
    expect(() => store.markProposal(stored.id, "pending")).toThrow("invalid proposal transition");
    expect(() => store.markProposal(stored.id, "rejected")).toThrow("invalid proposal transition");
    store.close();
  });

  it("records one transaction per proposal and permits undo exactly once", async () => {
    const store = new OrganizerStore(await databaseFile());
    const stored = proposal();
    const applied = transaction(stored.id);
    store.saveProposal(stored);
    store.recordTransaction(applied);

    expect(store.getTransaction(applied.id)).toEqual(applied);
    expect(store.markUndone(applied.id, "2026-09-03T02:00:00.000Z")).toEqual({
      ...applied,
      undoneAt: "2026-09-03T02:00:00.000Z",
    });
    expect(() => store.markUndone(applied.id, "2026-09-03T03:00:00.000Z")).toThrow("transaction already undone");
    expect(() => store.recordTransaction({ ...applied, id: "ORG-20260903-002" })).toThrow("transaction already exists");
    store.close();
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
    reopened.close();
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
