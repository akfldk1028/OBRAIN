import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OrganizerMode, RunSummary, StoredProposal, TransactionRecord } from "./types.js";

const MAX_ID_LENGTH = 160;
const MAX_VAULT_LENGTH = 256;
const MAX_PATH_LENGTH = 1_024;
const MAX_POLICY_VERSION_LENGTH = 128;
const MAX_JSON_BYTES = 32_768;
const DAY_MS = 24 * 60 * 60 * 1_000;

const timestampSchema = z.string().datetime({ offset: true });
const organizerModeSchema = z.enum(["disabled", "dry-run", "automatic"]);
const proposalStatusSchema = z.enum(["pending", "applied", "stale", "rejected"]);

const storedProposalSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH).startsWith("PRP-"),
  vault: z.string().min(1).max(MAX_VAULT_LENGTH),
  sourcePath: z.string().min(1).max(MAX_PATH_LENGTH),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  destinationPath: z.string().min(1).max(MAX_PATH_LENGTH),
  policyVersion: z.string().min(1).max(MAX_POLICY_VERSION_LENGTH),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  status: proposalStatusSchema,
  targetDirectory: z.string().min(1).max(512),
  title: z.string().min(1).max(200),
  type: z.enum(["prompt", "development", "agent", "study", "business", "research", "project", "tools", "dk", "archive"]),
  tags: z.array(z.string().min(1).max(50)).max(12),
  summary: z.string().min(1).max(2_000),
  analogy: z.string().max(2_000).optional(),
  notes: z.string().max(4_000).optional(),
  tips: z.array(z.string().max(500)).max(8).optional(),
  warnings: z.array(z.string().max(500)).max(8).optional(),
  relatedNotePaths: z.array(z.string().max(512)).max(12),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(1_000),
}).strict();

const transactionSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH).startsWith("ORG-"),
  proposalId: z.string().min(1).max(MAX_ID_LENGTH).startsWith("PRP-"),
  vault: z.string().min(1).max(MAX_VAULT_LENGTH),
  sourcePath: z.string().min(1).max(MAX_PATH_LENGTH),
  destinationPath: z.string().min(1).max(MAX_PATH_LENGTH),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  destinationHash: z.string().regex(/^[a-f0-9]{64}$/),
  appliedAt: timestampSchema,
  undoneAt: timestampSchema.optional(),
}).strict();

const runSummarySchema = z.object({
  runId: z.string().min(1).max(MAX_ID_LENGTH).startsWith("RUN-"),
  mode: organizerModeSchema,
  discovered: z.number().int().min(0).max(1_000_000),
  proposed: z.number().int().min(0).max(1_000_000),
  applied: z.number().int().min(0).max(1_000_000),
  review: z.number().int().min(0).max(1_000_000),
  skipped: z.number().int().min(0).max(1_000_000),
  failed: z.number().int().min(0).max(1_000_000),
  status: z.enum(["running", "complete", "failed", "already_running"]),
}).strict();

export interface TrialState {
  startedAt: string;
  expiresAt: string;
  active: boolean;
}

export interface StartRunInput {
  vault: string;
  mode: OrganizerMode;
  startedAt?: string;
  runId?: string;
}

interface ProposalRow {
  id: string;
  vault: string;
  source_path: string;
  source_hash: string;
  destination_path: string;
  policy_version: string;
  created_at: string;
  expires_at: string;
  status: string;
  proposal_json: string;
}

interface TransactionRow {
  id: string;
  proposal_id: string;
  vault: string;
  source_path: string;
  destination_path: string;
  source_hash: string;
  destination_hash: string;
  applied_at: string;
  undone_at: string | null;
}

interface RunRow {
  id: string;
  vault: string;
  mode: string;
  started_at: string;
  finished_at: string | null;
  summary_json: string | null;
}

const transitions: Readonly<Record<StoredProposal["status"], readonly StoredProposal["status"][]>> = {
  pending: ["applied", "stale", "rejected"],
  applied: [],
  stale: [],
  rejected: [],
};

function parseJson(value: string): unknown {
  if (Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES) throw new Error("stored JSON exceeds limit");
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("stored JSON is malformed");
  }
}

function checkedTimestamp(value: string, message: string): string {
  const result = timestampSchema.safeParse(value);
  if (!result.success || Number.isNaN(Date.parse(value))) throw new Error(message);
  return result.data;
}

function serializeBounded(value: object, error: string): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) throw new Error(error);
  return json;
}

function createId(prefix: "RUN" | "PRP" | "ORG"): string {
  return `${prefix}-${randomUUID()}`;
}

function proposalFromRow(row: ProposalRow): StoredProposal {
  let raw: unknown;
  try {
    raw = parseJson(row.proposal_json);
  } catch {
    throw new Error("invalid stored proposal");
  }
  const parsed = storedProposalSchema.safeParse(raw);
  if (!parsed.success) throw new Error("invalid stored proposal");
  const proposal = parsed.data;
  if (
    proposal.id !== row.id
    || proposal.vault !== row.vault
    || proposal.sourcePath !== row.source_path
    || proposal.sourceHash !== row.source_hash
    || proposal.destinationPath !== row.destination_path
    || proposal.policyVersion !== row.policy_version
    || proposal.createdAt !== row.created_at
    || proposal.expiresAt !== row.expires_at
    || proposal.status !== row.status
  ) throw new Error("invalid stored proposal");
  return proposal;
}

function transactionFromRow(row: TransactionRow): TransactionRecord {
  const parsed = transactionSchema.safeParse({
    id: row.id,
    proposalId: row.proposal_id,
    vault: row.vault,
    sourcePath: row.source_path,
    destinationPath: row.destination_path,
    sourceHash: row.source_hash,
    destinationHash: row.destination_hash,
    appliedAt: row.applied_at,
    ...(row.undone_at === null ? {} : { undoneAt: row.undone_at }),
  });
  if (!parsed.success) throw new Error("invalid stored transaction");
  return parsed.data;
}

function runFromRow(row: RunRow): RunSummary {
  if (row.summary_json === null) throw new Error("invalid stored run");
  let raw: unknown;
  try {
    raw = parseJson(row.summary_json);
  } catch {
    throw new Error("invalid stored run");
  }
  const parsed = runSummarySchema.safeParse(raw);
  if (!parsed.success || parsed.data.runId !== row.id || parsed.data.mode !== row.mode) {
    throw new Error("invalid stored run");
  }
  return parsed.data;
}

/** A single durable, content-free record of organizer proposals, runs, and transactions. */
export class OrganizerStore {
  private readonly db: Database.Database;
  private closed = false;

  constructor(file: string) {
    this.db = new Database(file);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.pragma("busy_timeout = 5000");
      this.initialize();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  public getOrStartTrial(now: string): TrialState {
    this.assertOpen();
    const checkedNow = checkedTimestamp(now, "invalid trial timestamp");
    const startTrial = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT value FROM organizer_meta WHERE key=?").get("trial_started_at") as { value: string } | undefined;
      if (existing) return checkedTimestamp(existing.value, "invalid stored trial");
      this.db.prepare("INSERT INTO organizer_meta(key,value) VALUES(?,?)").run("trial_started_at", checkedNow);
      return checkedNow;
    });
    const startedAt = startTrial.immediate();
    const expiresAt = new Date(Date.parse(startedAt) + 7 * DAY_MS).toISOString();
    return { startedAt, expiresAt, active: Date.parse(checkedNow) < Date.parse(expiresAt) };
  }

  public startRun(input: StartRunInput): RunSummary {
    this.assertOpen();
    const vault = z.string().min(1).max(MAX_VAULT_LENGTH).parse(input.vault);
    const mode = organizerModeSchema.parse(input.mode);
    const startedAt = checkedTimestamp(input.startedAt ?? new Date().toISOString(), "invalid run timestamp");
    const runId = input.runId === undefined ? createId("RUN") : z.string().min(1).max(MAX_ID_LENGTH).startsWith("RUN-").parse(input.runId);
    const summary: RunSummary = { runId, mode, discovered: 0, proposed: 0, applied: 0, review: 0, skipped: 0, failed: 0, status: "running" };
    const summaryJson = serializeBounded(summary, "run summary exceeds limit");
    this.db.prepare(`
      INSERT INTO organizer_runs(id,vault,mode,started_at,finished_at,summary_json)
      VALUES(?,?,?,?,NULL,?)
    `).run(runId, vault, mode, startedAt, summaryJson);
    return summary;
  }

  public finishRun(runId: string, summary: RunSummary, finishedAt = new Date().toISOString()): RunSummary {
    this.assertOpen();
    const checkedRunId = z.string().min(1).max(MAX_ID_LENGTH).startsWith("RUN-").parse(runId);
    const checkedSummary = runSummarySchema.parse(summary);
    const checkedFinishedAt = checkedTimestamp(finishedAt, "invalid run timestamp");
    if (checkedSummary.runId !== checkedRunId || checkedSummary.status === "running" || checkedSummary.status === "already_running") {
      throw new Error("invalid completed run summary");
    }
    const written = this.db.prepare(`
      UPDATE organizer_runs SET finished_at=?, summary_json=?
      WHERE id=? AND finished_at IS NULL
    `).run(checkedFinishedAt, serializeBounded(checkedSummary, "run summary exceeds limit"), checkedRunId);
    if (written.changes === 1) return checkedSummary;
    const existing = this.getRun(checkedRunId);
    if (existing && JSON.stringify(existing) === JSON.stringify(checkedSummary)) return existing;
    throw new Error("run already finished");
  }

  public getRun(runId: string): RunSummary | undefined {
    this.assertOpen();
    const checkedId = z.string().min(1).max(MAX_ID_LENGTH).startsWith("RUN-").parse(runId);
    const row = this.db.prepare(`
      SELECT id,vault,mode,started_at,finished_at,summary_json FROM organizer_runs
      WHERE id=? AND length(CAST(vault AS BLOB))<=? AND length(CAST(mode AS BLOB))<=?
        AND length(CAST(started_at AS BLOB))<=? AND (finished_at IS NULL OR length(CAST(finished_at AS BLOB))<=?)
        AND summary_json IS NOT NULL AND length(CAST(summary_json AS BLOB))<=?
    `).get(checkedId, MAX_VAULT_LENGTH, 16, 64, 64, MAX_JSON_BYTES) as RunRow | undefined;
    if (row !== undefined) return runFromRow(row);
    if (this.db.prepare("SELECT 1 FROM organizer_runs WHERE id=?").get(checkedId)) throw new Error("invalid stored run");
    return undefined;
  }

  public saveProposal(proposal: StoredProposal): void {
    this.assertOpen();
    const checked = storedProposalSchema.parse(proposal);
    if (checked.status !== "pending") throw new Error("new proposals must be pending");
    const proposalJson = serializeBounded(checked, "proposal exceeds limit");
    const existing = this.db.prepare("SELECT 1 FROM organizer_proposals WHERE id=?").get(checked.id);
    if (existing) throw new Error("proposal already exists");
    this.db.prepare(`
      INSERT INTO organizer_proposals(
        id,vault,source_path,source_hash,destination_path,policy_version,created_at,expires_at,status,proposal_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      checked.id, checked.vault, checked.sourcePath, checked.sourceHash, checked.destinationPath,
      checked.policyVersion, checked.createdAt, checked.expiresAt, checked.status, proposalJson,
    );
  }

  public getProposal(id: string): StoredProposal | undefined {
    this.assertOpen();
    const checkedId = z.string().min(1).max(MAX_ID_LENGTH).parse(id);
    const row = this.db.prepare(`
      SELECT id,vault,source_path,source_hash,destination_path,policy_version,created_at,expires_at,status,proposal_json
      FROM organizer_proposals
      WHERE id=? AND length(CAST(vault AS BLOB))<=? AND length(CAST(source_path AS BLOB))<=?
        AND length(CAST(source_hash AS BLOB))<=? AND length(CAST(destination_path AS BLOB))<=?
        AND length(CAST(policy_version AS BLOB))<=? AND length(CAST(created_at AS BLOB))<=?
        AND length(CAST(expires_at AS BLOB))<=? AND length(CAST(status AS BLOB))<=?
        AND length(CAST(proposal_json AS BLOB))<=?
    `).get(
      checkedId, MAX_VAULT_LENGTH, MAX_PATH_LENGTH, 64, MAX_PATH_LENGTH,
      MAX_POLICY_VERSION_LENGTH, 64, 64, 16, MAX_JSON_BYTES,
    ) as ProposalRow | undefined;
    if (row !== undefined) return proposalFromRow(row);
    if (this.db.prepare("SELECT 1 FROM organizer_proposals WHERE id=?").get(checkedId)) throw new Error("invalid stored proposal");
    return undefined;
  }

  public markProposal(id: string, status: StoredProposal["status"]): StoredProposal {
    this.assertOpen();
    const target = proposalStatusSchema.parse(status);
    const mark = this.db.transaction(() => {
      const existing = this.getProposal(id);
      if (!existing) throw new Error("proposal not found");
      if (existing.status === target) return existing;
      if (!transitions[existing.status].includes(target)) throw new Error("invalid proposal transition");
      const updated = { ...existing, status: target } as StoredProposal;
      const written = this.db.prepare("UPDATE organizer_proposals SET status=?, proposal_json=? WHERE id=? AND status=?")
        .run(target, serializeBounded(updated, "proposal exceeds limit"), id, existing.status);
      if (written.changes !== 1) throw new Error("proposal changed concurrently");
      return updated;
    });
    return mark.immediate();
  }

  public recordTransaction(transaction: TransactionRecord): void {
    this.assertOpen();
    const checked = transactionSchema.parse(transaction);
    if (checked.undoneAt !== undefined) throw new Error("new transaction cannot be undone");
    const record = this.db.transaction(() => {
      const duplicate = this.db.prepare("SELECT 1 FROM organizer_transactions WHERE id=? OR proposal_id=?")
        .get(checked.id, checked.proposalId);
      if (duplicate) throw new Error("transaction already exists");
      const proposal = this.getProposal(checked.proposalId);
      if (!proposal) throw new Error("proposal not found");
      if (
        proposal.vault !== checked.vault
        || proposal.sourcePath !== checked.sourcePath
        || proposal.destinationPath !== checked.destinationPath
        || proposal.sourceHash !== checked.sourceHash
      ) throw new Error("transaction does not match proposal");
      this.db.prepare(`
        INSERT INTO organizer_transactions(
          id,proposal_id,vault,source_path,destination_path,source_hash,destination_hash,applied_at,undone_at
        ) VALUES(?,?,?,?,?,?,?,?,NULL)
      `).run(
        checked.id, checked.proposalId, checked.vault, checked.sourcePath, checked.destinationPath,
        checked.sourceHash, checked.destinationHash, checked.appliedAt,
      );
    });
    record.immediate();
  }

  public getTransaction(id: string): TransactionRecord | undefined {
    this.assertOpen();
    const checkedId = z.string().min(1).max(MAX_ID_LENGTH).parse(id);
    const row = this.db.prepare(`
      SELECT id,proposal_id,vault,source_path,destination_path,source_hash,destination_hash,applied_at,undone_at
      FROM organizer_transactions
      WHERE id=? AND length(CAST(proposal_id AS BLOB))<=? AND length(CAST(vault AS BLOB))<=?
        AND length(CAST(source_path AS BLOB))<=? AND length(CAST(destination_path AS BLOB))<=?
        AND length(CAST(source_hash AS BLOB))<=? AND length(CAST(destination_hash AS BLOB))<=?
        AND length(CAST(applied_at AS BLOB))<=? AND (undone_at IS NULL OR length(CAST(undone_at AS BLOB))<=?)
    `).get(checkedId, MAX_ID_LENGTH, MAX_VAULT_LENGTH, MAX_PATH_LENGTH, MAX_PATH_LENGTH, 64, 64, 64, 64) as TransactionRow | undefined;
    if (row !== undefined) return transactionFromRow(row);
    if (this.db.prepare("SELECT 1 FROM organizer_transactions WHERE id=?").get(checkedId)) throw new Error("invalid stored transaction");
    return undefined;
  }

  public markUndone(id: string, undoneAt = new Date().toISOString()): TransactionRecord {
    this.assertOpen();
    const checkedUndoneAt = checkedTimestamp(undoneAt, "invalid undo timestamp");
    const undo = this.db.transaction(() => {
      const transaction = this.getTransaction(id);
      if (!transaction) throw new Error("transaction not found");
      if (transaction.undoneAt !== undefined) throw new Error("transaction already undone");
      const written = this.db.prepare("UPDATE organizer_transactions SET undone_at=? WHERE id=? AND undone_at IS NULL")
        .run(checkedUndoneAt, id);
      if (written.changes !== 1) throw new Error("transaction already undone");
      return { ...transaction, undoneAt: checkedUndoneAt };
    });
    return undo.immediate();
  }

  public close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("organizer store is closed");
  }

  private initialize(): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS organizer_meta (
          key TEXT PRIMARY KEY, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS organizer_runs (
          id TEXT PRIMARY KEY, vault TEXT NOT NULL, mode TEXT NOT NULL,
          started_at TEXT NOT NULL, finished_at TEXT, summary_json TEXT
        );
        CREATE TABLE IF NOT EXISTS organizer_proposals (
          id TEXT PRIMARY KEY, vault TEXT NOT NULL, source_path TEXT NOT NULL,
          source_hash TEXT NOT NULL, destination_path TEXT NOT NULL,
          policy_version TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','applied','stale','rejected')),
          proposal_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS organizer_transactions (
          id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE, vault TEXT NOT NULL,
          source_path TEXT NOT NULL, destination_path TEXT NOT NULL,
          source_hash TEXT NOT NULL, destination_hash TEXT NOT NULL,
          applied_at TEXT NOT NULL, undone_at TEXT
        );
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export const organizerIds = {
  run: (): string => createId("RUN"),
  proposal: (): string => createId("PRP"),
  transaction: (): string => createId("ORG"),
};
