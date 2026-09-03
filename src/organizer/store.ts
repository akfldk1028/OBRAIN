import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OrganizerMode, RunSummary, StoredProposal, TransactionRecord } from "./types.js";

const VERSION = "1";
const ID = 160, VAULT = 256, PATH = 1024, POLICY = 128, TIME = 64, JSON_BYTES = 32768;
const DAY = 86_400_000;
const text = (min: number, max: number) => z.string().min(min).max(max).refine((v) => Buffer.byteLength(v, "utf8") <= max, "string exceeds UTF-8 byte limit");
const timestamp = text(1, TIME).refine((v) => z.string().datetime({ offset: true }).safeParse(v).success && Number.isFinite(Date.parse(v)), "invalid timestamp");
const identifier = text(1, ID);
const vault = text(1, VAULT), filePath = text(1, PATH), policy = text(1, POLICY);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const mode = z.enum(["disabled", "dry-run", "automatic"]);
const proposalStatus = z.enum(["pending", "applied", "stale", "rejected"]);
const proposalSchema = z.object({
  id: identifier.refine((v) => v.startsWith("PRP-")), vault, sourcePath: filePath, sourceHash: hash,
  destinationPath: filePath, policyVersion: policy, createdAt: timestamp, expiresAt: timestamp, status: proposalStatus,
  targetDirectory: text(1, 512), title: text(1, 200),
  type: z.enum(["prompt", "development", "agent", "study", "business", "research", "project", "tools", "dk", "archive"]),
  tags: z.array(text(1, 50)).max(12), summary: text(1, 2000), analogy: text(0, 2000).optional(), notes: text(0, 4000).optional(),
  tips: z.array(text(0, 500)).max(8).optional(), warnings: z.array(text(0, 500)).max(8).optional(),
  relatedNotePaths: z.array(text(0, 512)).max(12), confidence: z.number().min(0).max(1), reason: text(1, 1000),
}).strict();
const transactionSchema = z.object({
  id: identifier.refine((v) => v.startsWith("ORG-")), proposalId: identifier.refine((v) => v.startsWith("PRP-")),
  vault, sourcePath: filePath, destinationPath: filePath, sourceHash: hash, destinationHash: hash, appliedAt: timestamp, undoneAt: timestamp.optional(),
}).strict();
const runSchema = z.object({
  runId: identifier.refine((v) => v.startsWith("RUN-")), mode,
  discovered: z.number().int().min(0).max(1_000_000), proposed: z.number().int().min(0).max(1_000_000),
  applied: z.number().int().min(0).max(1_000_000), review: z.number().int().min(0).max(1_000_000),
  skipped: z.number().int().min(0).max(1_000_000), failed: z.number().int().min(0).max(1_000_000),
  status: z.enum(["running", "complete", "failed", "already_running"]),
}).strict();

export interface TrialState { startedAt: string; expiresAt: string; active: boolean; }
export interface StartRunInput { vault: string; mode: OrganizerMode; startedAt?: string; runId?: string; }
interface ProposalRow { id: string; vault: string; source_path: string; source_hash: string; destination_path: string; policy_version: string; created_at: string; expires_at: string; status: string; proposal_json: string; }
interface TransactionRow { id: string; proposal_id: string; vault: string; source_path: string; destination_path: string; source_hash: string; destination_hash: string; applied_at: string; undone_at: string | null; proposal_created_at: string; proposal_status: string; }
interface RunRow { id: string; vault: string; mode: string; started_at: string; finished_at: string | null; summary_json: string | null; }

const later = (value: string, floor: string) => Date.parse(value) >= Date.parse(floor);
const checkTime = (value: string, message: string): string => { const parsed = timestamp.safeParse(value); if (!parsed.success) throw new Error(message); return parsed.data; };
const json = (value: object, message: string): string => { const result = JSON.stringify(value); if (Buffer.byteLength(result, "utf8") > JSON_BYTES) throw new Error(message); return result; };
const parseJson = (value: string): unknown => { if (Buffer.byteLength(value, "utf8") > JSON_BYTES) throw new Error("too large"); try { return JSON.parse(value); } catch { throw new Error("malformed"); } };
const id = (prefix: "RUN" | "PRP" | "ORG") => `${prefix}-${randomUUID()}`;

function readProposal(row: ProposalRow): StoredProposal {
  let raw: unknown; try { raw = parseJson(row.proposal_json); } catch { throw new Error("invalid stored proposal"); }
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) throw new Error("invalid stored proposal");
  const value = parsed.data;
  if (value.id !== row.id || value.vault !== row.vault || value.sourcePath !== row.source_path || value.sourceHash !== row.source_hash
    || value.destinationPath !== row.destination_path || value.policyVersion !== row.policy_version || value.createdAt !== row.created_at
    || value.expiresAt !== row.expires_at || value.status !== row.status || !later(value.expiresAt, value.createdAt)) throw new Error("invalid stored proposal");
  return value;
}
function readTransaction(row: TransactionRow): TransactionRecord {
  const parsed = transactionSchema.safeParse({ id: row.id, proposalId: row.proposal_id, vault: row.vault, sourcePath: row.source_path, destinationPath: row.destination_path, sourceHash: row.source_hash, destinationHash: row.destination_hash, appliedAt: row.applied_at, ...(row.undone_at === null ? {} : { undoneAt: row.undone_at }) });
  if (!parsed.success || !timestamp.safeParse(row.proposal_created_at).success || row.proposal_status !== "applied" || !later(parsed.data.appliedAt, row.proposal_created_at) || (parsed.data.undoneAt && !later(parsed.data.undoneAt, parsed.data.appliedAt))) throw new Error("invalid stored transaction");
  return parsed.data;
}
function readRun(row: RunRow): RunSummary {
  if (row.summary_json === null || !vault.safeParse(row.vault).success || !mode.safeParse(row.mode).success || !timestamp.safeParse(row.started_at).success || (row.finished_at !== null && !timestamp.safeParse(row.finished_at).success)) throw new Error("invalid stored run");
  let raw: unknown; try { raw = parseJson(row.summary_json); } catch { throw new Error("invalid stored run"); }
  const parsed = runSchema.safeParse(raw);
  if (!parsed.success || parsed.data.runId !== row.id || parsed.data.mode !== row.mode) throw new Error("invalid stored run");
  const complete = parsed.data.status === "complete" || parsed.data.status === "failed";
  if (parsed.data.status === "already_running" || (parsed.data.status === "running") !== (row.finished_at === null) || complete !== (row.finished_at !== null) || (row.finished_at !== null && !later(row.finished_at, row.started_at))) throw new Error("invalid stored run");
  return parsed.data;
}

export class OrganizerStore {
  private readonly db: Database.Database;
  private closed = false;
  constructor(file: string) {
    this.db = new Database(file);
    try { this.db.pragma("busy_timeout = 5000"); this.db.pragma("foreign_keys = ON"); this.db.pragma("journal_mode = WAL"); this.db.pragma("synchronous = FULL"); this.initialize(); }
    catch (error) { this.db.close(); throw error; }
  }

  public getOrStartTrial(now: string): TrialState {
    this.assertOpen(); const current = checkTime(now, "invalid trial timestamp");
    const trial = this.db.transaction(() => {
      let startedAt = this.meta("trial_started_at"); if (!startedAt) { startedAt = current; this.setMeta("trial_started_at", startedAt); }
      const calculated = this.trialExpiry(startedAt); let expiresAt = this.meta("trial_expires_at");
      if (expiresAt && expiresAt !== calculated) throw new Error("invalid stored trial");
      if (!expiresAt) { expiresAt = calculated; this.setMeta("trial_expires_at", expiresAt); }
      const observed = this.meta("trial_expired_at");
      if (observed && !later(observed, expiresAt)) throw new Error("invalid stored trial");
      if (!observed && Date.parse(current) >= Date.parse(expiresAt)) this.setMeta("trial_expired_at", current);
      return { startedAt, expiresAt, active: !observed && Date.parse(current) < Date.parse(expiresAt) };
    });
    return trial.immediate();
  }

  public startRun(input: StartRunInput): RunSummary {
    this.assertOpen(); const runId = input.runId === undefined ? id("RUN") : identifier.refine((v) => v.startsWith("RUN-")).parse(input.runId);
    const summary: RunSummary = { runId, mode: mode.parse(input.mode), discovered: 0, proposed: 0, applied: 0, review: 0, skipped: 0, failed: 0, status: "running" };
    this.db.prepare("INSERT INTO organizer_runs(id,vault,mode,started_at,finished_at,summary_json) VALUES(?,?,?,?,NULL,?)").run(runId, vault.parse(input.vault), summary.mode, checkTime(input.startedAt ?? new Date().toISOString(), "invalid run timestamp"), json(summary, "run summary exceeds limit"));
    return summary;
  }

  public finishRun(runId: string, summary: RunSummary, finishedAt = new Date().toISOString()): RunSummary {
    this.assertOpen(); const wanted = identifier.refine((v) => v.startsWith("RUN-")).parse(runId); const completion = runSchema.parse(summary); const finishAt = checkTime(finishedAt, "invalid run timestamp");
    if (completion.runId !== wanted || !["complete", "failed"].includes(completion.status)) throw new Error("invalid completed run summary");
    const finish = this.db.transaction(() => {
      const row = this.runRow(wanted); if (!row) throw new Error("run not found"); const running = readRun(row);
      if (running.status !== "running" || row.finished_at !== null) throw new Error("run already finished");
      if (row.mode !== completion.mode) throw new Error("run mode does not match summary"); if (!later(finishAt, row.started_at)) throw new Error("run finish is before run start");
      const result = this.db.prepare("UPDATE organizer_runs SET finished_at=?,summary_json=? WHERE id=? AND mode=? AND started_at=? AND finished_at IS NULL AND summary_json=?").run(finishAt, json(completion, "run summary exceeds limit"), wanted, row.mode, row.started_at, row.summary_json);
      if (result.changes !== 1) throw new Error("run changed concurrently"); const completed = this.getRun(wanted); if (!completed) throw new Error("invalid stored run"); return completed;
    }); return finish.immediate();
  }

  public getRun(runId: string): RunSummary | undefined {
    this.assertOpen(); const wanted = identifier.refine((v) => v.startsWith("RUN-")).parse(runId); const row = this.runRow(wanted);
    if (row) return readRun(row); if (this.db.prepare("SELECT 1 FROM organizer_runs WHERE id=?").get(wanted)) throw new Error("invalid stored run"); return undefined;
  }

  public saveProposal(proposal: StoredProposal): void {
    this.assertOpen(); const value = proposalSchema.parse(proposal); if (value.status !== "pending" || !later(value.expiresAt, value.createdAt)) throw new Error("invalid new proposal");
    if (this.db.prepare("SELECT 1 FROM organizer_proposals WHERE id=?").get(value.id)) throw new Error("proposal already exists");
    this.db.prepare("INSERT INTO organizer_proposals(id,vault,source_path,source_hash,destination_path,policy_version,created_at,expires_at,status,proposal_json) VALUES(?,?,?,?,?,?,?,?,?,?)").run(value.id, value.vault, value.sourcePath, value.sourceHash, value.destinationPath, value.policyVersion, value.createdAt, value.expiresAt, value.status, json(value, "proposal exceeds limit"));
  }

  public getProposal(proposalId: string): StoredProposal | undefined {
    this.assertOpen(); const wanted = identifier.parse(proposalId); const row = this.proposalRow(wanted);
    if (row) return readProposal(row); if (this.db.prepare("SELECT 1 FROM organizer_proposals WHERE id=?").get(wanted)) throw new Error("invalid stored proposal"); return undefined;
  }

  public markProposal(proposalId: string, next: StoredProposal["status"]): StoredProposal {
    this.assertOpen(); const status = proposalStatus.parse(next); if (status === "applied") throw new Error("applied proposal requires a transaction");
    const mark = this.db.transaction(() => { const old = this.getProposal(proposalId); if (!old) throw new Error("proposal not found"); if (old.status === status) return old; if (old.status !== "pending") throw new Error("invalid proposal transition"); const result = this.db.prepare("UPDATE organizer_proposals SET status=?,proposal_json=? WHERE id=? AND status='pending'").run(status, json({ ...old, status }, "proposal exceeds limit"), old.id); if (result.changes !== 1) throw new Error("proposal changed concurrently"); return { ...old, status }; });
    return mark.immediate();
  }

  public applyProposalWithTransaction(transaction: TransactionRecord): { proposal: StoredProposal; transaction: TransactionRecord } {
    this.assertOpen(); const value = transactionSchema.parse(transaction); if (value.undoneAt) throw new Error("new transaction cannot be undone");
    const apply = this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM organizer_transactions WHERE id=? OR proposal_id=?").get(value.id, value.proposalId)) throw new Error("transaction already exists");
      const proposal = this.getProposal(value.proposalId); if (!proposal) throw new Error("proposal not found");
      if (proposal.status !== "pending" || proposal.vault !== value.vault || proposal.sourcePath !== value.sourcePath || proposal.destinationPath !== value.destinationPath || proposal.sourceHash !== value.sourceHash || !later(value.appliedAt, proposal.createdAt)) throw new Error("transaction does not match proposal");
      this.db.prepare("INSERT INTO organizer_transactions(id,proposal_id,vault,source_path,destination_path,source_hash,destination_hash,applied_at,undone_at) VALUES(?,?,?,?,?,?,?,?,NULL)").run(value.id, value.proposalId, value.vault, value.sourcePath, value.destinationPath, value.sourceHash, value.destinationHash, value.appliedAt);
      const applied = { ...proposal, status: "applied" } as StoredProposal; const result = this.db.prepare("UPDATE organizer_proposals SET status=?,proposal_json=? WHERE id=? AND status='pending'").run("applied", json(applied, "proposal exceeds limit"), proposal.id); if (result.changes !== 1) throw new Error("proposal changed concurrently"); return { proposal: applied, transaction: value };
    }); return apply.immediate();
  }
  public recordTransaction(transaction: TransactionRecord): void { this.applyProposalWithTransaction(transaction); }
  public getTransaction(transactionId: string): TransactionRecord | undefined {
    this.assertOpen(); const wanted = identifier.parse(transactionId); const row = this.transactionRow(wanted);
    if (row) return readTransaction(row); if (this.db.prepare("SELECT 1 FROM organizer_transactions WHERE id=?").get(wanted)) throw new Error("invalid stored transaction"); return undefined;
  }
  public markUndone(transactionId: string, undoneAt = new Date().toISOString()): TransactionRecord {
    this.assertOpen(); const time = checkTime(undoneAt, "invalid undo timestamp"); const undo = this.db.transaction(() => { const current = this.getTransaction(transactionId); if (!current) throw new Error("transaction not found"); if (current.undoneAt) throw new Error("transaction already undone"); if (!later(time, current.appliedAt)) throw new Error("undo is before transaction application"); const result = this.db.prepare("UPDATE organizer_transactions SET undone_at=? WHERE id=? AND undone_at IS NULL").run(time, current.id); if (result.changes !== 1) throw new Error("transaction already undone"); return { ...current, undoneAt: time }; }); return undo.immediate();
  }
  public close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  private assertOpen(): void { if (this.closed) throw new Error("organizer store is closed"); }
  private meta(key: string): string | undefined { const row = this.db.prepare("SELECT value FROM organizer_meta WHERE key=? AND length(CAST(value AS BLOB))<=?").get(key, TIME) as { value: string } | undefined; if (row) return checkTime(row.value, "invalid stored trial"); if (this.db.prepare("SELECT 1 FROM organizer_meta WHERE key=?").get(key)) throw new Error("invalid stored trial"); return undefined; }
  private setMeta(key: string, value: string): void { this.db.prepare("INSERT INTO organizer_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
  private trialExpiry(startedAt: string): string { const value = Date.parse(startedAt) + 7 * DAY; if (!Number.isFinite(value)) throw new Error("invalid stored trial"); try { const expiresAt = new Date(value).toISOString(); if (!timestamp.safeParse(expiresAt).success) throw new Error("invalid stored trial"); return expiresAt; } catch { throw new Error("invalid stored trial"); } }
  private proposalRow(idValue: string): ProposalRow | undefined { return this.db.prepare("SELECT id,vault,source_path,source_hash,destination_path,policy_version,created_at,expires_at,status,proposal_json FROM organizer_proposals WHERE id=? AND length(CAST(vault AS BLOB))<=? AND length(CAST(source_path AS BLOB))<=? AND length(CAST(source_hash AS BLOB))<=64 AND length(CAST(destination_path AS BLOB))<=? AND length(CAST(policy_version AS BLOB))<=? AND length(CAST(created_at AS BLOB))<=? AND length(CAST(expires_at AS BLOB))<=? AND length(CAST(status AS BLOB))<=16 AND length(CAST(proposal_json AS BLOB))<=?").get(idValue, VAULT, PATH, PATH, POLICY, TIME, TIME, JSON_BYTES) as ProposalRow | undefined; }
  private transactionRow(idValue: string): TransactionRow | undefined { return this.db.prepare("SELECT t.id,t.proposal_id,t.vault,t.source_path,t.destination_path,t.source_hash,t.destination_hash,t.applied_at,t.undone_at,p.created_at AS proposal_created_at,p.status AS proposal_status FROM organizer_transactions t JOIN organizer_proposals p ON p.id=t.proposal_id WHERE t.id=? AND length(CAST(t.proposal_id AS BLOB))<=? AND length(CAST(t.vault AS BLOB))<=? AND length(CAST(t.source_path AS BLOB))<=? AND length(CAST(t.destination_path AS BLOB))<=? AND length(CAST(t.source_hash AS BLOB))<=64 AND length(CAST(t.destination_hash AS BLOB))<=64 AND length(CAST(t.applied_at AS BLOB))<=? AND (t.undone_at IS NULL OR length(CAST(t.undone_at AS BLOB))<=?) AND length(CAST(p.created_at AS BLOB))<=? AND length(CAST(p.status AS BLOB))<=16").get(idValue, ID, VAULT, PATH, PATH, TIME, TIME, TIME) as TransactionRow | undefined; }
  private runRow(idValue: string): RunRow | undefined { return this.db.prepare("SELECT id,vault,mode,started_at,finished_at,summary_json FROM organizer_runs WHERE id=? AND length(CAST(vault AS BLOB))<=? AND length(CAST(mode AS BLOB))<=16 AND length(CAST(started_at AS BLOB))<=? AND (finished_at IS NULL OR length(CAST(finished_at AS BLOB))<=?) AND summary_json IS NOT NULL AND length(CAST(summary_json AS BLOB))<=?").get(idValue, VAULT, TIME, TIME, JSON_BYTES) as RunRow | undefined; }
  private initialize(): void {
    const expected: Record<string, Array<[string, string]>> = { organizer_meta: [["key", "TEXT"], ["value", "TEXT"]], organizer_runs: [["id", "TEXT"], ["vault", "TEXT"], ["mode", "TEXT"], ["started_at", "TEXT"], ["finished_at", "TEXT"], ["summary_json", "TEXT"]], organizer_proposals: [["id", "TEXT"], ["vault", "TEXT"], ["source_path", "TEXT"], ["source_hash", "TEXT"], ["destination_path", "TEXT"], ["policy_version", "TEXT"], ["created_at", "TEXT"], ["expires_at", "TEXT"], ["status", "TEXT"], ["proposal_json", "TEXT"]], organizer_transactions: [["id", "TEXT"], ["proposal_id", "TEXT"], ["vault", "TEXT"], ["source_path", "TEXT"], ["destination_path", "TEXT"], ["source_hash", "TEXT"], ["destination_hash", "TEXT"], ["applied_at", "TEXT"], ["undone_at", "TEXT"]] };
    try { this.db.exec("BEGIN IMMEDIATE"); const found = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('organizer_meta','organizer_runs','organizer_proposals','organizer_transactions')").all() as Array<{ name: string }>;
      if (found.length !== 0 && found.length !== 4) throw new Error("incompatible organizer schema");
      if (found.length === 0) this.db.exec("CREATE TABLE organizer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE organizer_runs (id TEXT PRIMARY KEY, vault TEXT NOT NULL, mode TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, summary_json TEXT); CREATE TABLE organizer_proposals (id TEXT PRIMARY KEY, vault TEXT NOT NULL, source_path TEXT NOT NULL, source_hash TEXT NOT NULL, destination_path TEXT NOT NULL, policy_version TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','applied','stale','rejected')), proposal_json TEXT NOT NULL); CREATE TABLE organizer_transactions (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE, vault TEXT NOT NULL, source_path TEXT NOT NULL, destination_path TEXT NOT NULL, source_hash TEXT NOT NULL, destination_hash TEXT NOT NULL, applied_at TEXT NOT NULL, undone_at TEXT);");
      for (const [name, columns] of Object.entries(expected)) { const actual = this.db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string; type: string }>; if (actual.length !== columns.length || actual.some((column, index) => column.name !== columns[index]?.[0] || column.type.toUpperCase() !== columns[index]?.[1])) throw new Error("incompatible organizer schema"); }
      const schema = this.db.prepare("SELECT value FROM organizer_meta WHERE key='schema_version' AND length(CAST(value AS BLOB))<=?").get(TIME) as { value: string } | undefined; if (!schema && this.db.prepare("SELECT 1 FROM organizer_meta WHERE key='schema_version'").get()) throw new Error("incompatible organizer schema"); if (schema && schema.value !== VERSION) throw new Error("incompatible organizer schema"); if (!schema) this.db.prepare("INSERT INTO organizer_meta(key,value) VALUES('schema_version',?)").run(VERSION); this.db.exec("COMMIT");
    } catch (error) { if (this.db.inTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
}
export const organizerIds = { run: () => id("RUN"), proposal: () => id("PRP"), transaction: () => id("ORG") };
