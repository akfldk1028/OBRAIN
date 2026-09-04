import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { AuditLogger } from "../audit.js";
import { BRAIN_FOUNDATION_POLICY, areaMocPath } from "../foundation/policy.js";
import { VaultRegistry } from "../vault-registry.js";
import { auditVaultIntegrity } from "./integrity.js";
import { acquireOrganizerLock, type OrganizerLock } from "./lock.js";
import { replaceManagedMocIndex } from "./managed-moc.js";
import { assertApprovedDestination, assertInboxSource, buildDestinationPath } from "./paths.js";
import type { OrganizerProvider } from "./provider.js";
import { renderOrganizedNote } from "./render-note.js";
import { scanStableInbox, type InboxCandidate } from "./scanner.js";
import { detectSensitiveContent } from "./secrets.js";
import { OrganizerStore, organizerIds } from "./store.js";
import { OrganizerTransactionEngine, type CreateOnlyVaultArtifactEvent } from "./transaction.js";
import type { InboxListResult, OrganizerConfig, OrganizerMode, OrganizerServiceApi, RunSummary, StoredProposal, TransactionRecord, VaultPolicyView } from "./types.js";

const DAY = 86_400_000;

export interface OrganizerServiceOptions {
  registry: VaultRegistry;
  config: OrganizerConfig;
  store: OrganizerStore;
  provider?: OrganizerProvider | ((options: { maxContextBytes: number }) => OrganizerProvider | Promise<OrganizerProvider>);
  transaction: OrganizerTransactionEngine;
  auditLogger?: AuditLogger;
  now?: () => string;
  lockPath: string;
  maxRunDurationMs?: number;
  onBeforeReportOpen?: () => void | Promise<void>;
  onReportPublicationEvent?: (event: CreateOnlyVaultArtifactEvent) => void | Promise<void>;
}

function sha(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
function compare(left: string, right: string): number { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")); }
function expiry(now: string, hours: number): string { return new Date(Date.parse(now) + hours * 3_600_000).toISOString(); }
function safeReason(_error: unknown): "processing_failed" { return "processing_failed"; }
function outside(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); }
type ReportPath = { path: string; reasonCode: string };

export class OrganizerService implements OrganizerServiceApi {
  private readonly now: () => string;
  private readonly active = new Map<string, { summary: RunSummary; promise: Promise<RunSummary> }>();
  private providerInstance: OrganizerProvider | undefined;

  constructor(private readonly options: OrganizerServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async getPolicy(vault: string): Promise<VaultPolicyView> {
    this.authorize(vault);
    return { version: BRAIN_FOUNDATION_POLICY.version, readingOrder: [BRAIN_FOUNDATION_POLICY.inbox, ...BRAIN_FOUNDATION_POLICY.areas.map((area) => area.directory)], approvedAreas: BRAIN_FOUNDATION_POLICY.areas.map((area) => area.directory), maxDepth: BRAIN_FOUNDATION_POLICY.maxDepth, mode: this.options.config.mode };
  }

  public async listInbox(input: { vault: string; state?: "ready" | "review"; limit?: number; cursor?: number }): Promise<InboxListResult> {
    const vault = this.authorize(input.vault); const limit = Math.min(Math.max(input.limit ?? 50, 1), 200); const cursor = Math.max(input.cursor ?? 0, 0);
    const candidates = await scanStableInbox({ root: vault.rootPath, minStableSeconds: this.options.config.minStableSeconds, nowMs: Date.parse(this.now()), maxBytes: this.options.config.maxNoteBytes });
    const notes = candidates.slice(cursor, cursor + limit).map((candidate) => ({ path: candidate.path, size: candidate.size, mtime: new Date(candidate.mtimeMs).toISOString(), state: "ready" as const }));
    return { vault: input.vault, notes, ...(cursor + notes.length < candidates.length ? { nextCursor: cursor + notes.length } : {}) };
  }

  public async propose(input: { vault: string; path: string }): Promise<StoredProposal> {
    const vault = this.authorize(input.vault); const sourcePath = assertInboxSource(input.path);
    if (this.providerDisabled()) throw new Error("organizer_unavailable");
    const candidates = await scanStableInbox({ root: vault.rootPath, minStableSeconds: this.options.config.minStableSeconds, nowMs: Date.parse(this.now()), maxBytes: this.options.config.maxNoteBytes });
    const candidate = candidates.find((item) => item.path === sourcePath);
    if (!candidate) throw new Error("source_not_ready");
    return this.proposeCandidate(input.vault, vault.rootPath, candidate);
  }

  public async apply(input: { vault: string; proposalId: string }): Promise<TransactionRecord> {
    const vault = this.authorize(input.vault); const proposal = this.options.store.getProposal(input.proposalId);
    if (!proposal || proposal.vault !== input.vault || proposal.status !== "pending") throw new Error("proposal_not_pending");
    const now = this.now();
    if (Date.parse(proposal.expiresAt) <= Date.parse(now)) { this.options.store.markProposal(proposal.id, "stale"); throw new Error("proposal_expired"); }
    if (proposal.policyVersion !== BRAIN_FOUNDATION_POLICY.version) throw new Error("proposal_policy_stale");
    if (this.options.config.mode !== "automatic" || this.options.store.getOrStartTrial(now).active || proposal.confidence < this.options.config.autoApplyConfidence) throw new Error("automatic_apply_not_allowed");
    const source = await vault.readNote(proposal.sourcePath);
    if (sha(source) !== proposal.sourceHash) { this.options.store.markProposal(proposal.id, "stale"); throw new Error("source_stale"); }
    const existing = new Set((await vault.listNotes()).map((item) => item.replaceAll("\\", "/")));
    for (const area of BRAIN_FOUNDATION_POLICY.areas) {
      if (!existing.has(areaMocPath(area))) throw new Error("missing_required_moc");
    }
    const destinationArea = proposal.destinationPath.split("/", 1)[0]!;
    const target = BRAIN_FOUNDATION_POLICY.areas.find((area) => area.directory === destinationArea);
    if (!target) throw new Error("destination_unapproved");
    const mocPath = areaMocPath(target); const moc = await vault.readNote(mocPath);
    const transactionId = organizerIds.transaction();
    const links = this.mocLinks(moc); links.set(proposal.destinationPath, proposal.title);
    const replacement = replaceManagedMocIndex(moc, [...links].map(([path, title]) => ({ path, title })));
    const transaction = await this.options.transaction.apply({
      id: transactionId, proposal, vaultRoot: vault.rootPath,
      destinationContent: renderOrganizedNote({ source, proposal, transactionId, now, existingNotePaths: existing }),
      managedReplacements: [{ relativePath: mocPath, expectedHash: sha(moc), content: replacement }],
    });
    await this.record("organizer_apply", "allowed", input.vault, proposal.sourcePath, "applied");
    return transaction;
  }

  public async undo(input: { vault: string; transactionId: string }): Promise<TransactionRecord> {
    this.authorize(input.vault); const transaction = this.options.store.getTransaction(input.transactionId);
    if (!transaction || transaction.vault !== input.vault) throw new Error("transaction_not_found");
    const result = await this.options.transaction.undo(input.transactionId); await this.record("organizer_undo", "allowed", input.vault, result.sourcePath, "undone"); return result;
  }

  public async audit(input: { vault: string; scope?: string }) {
    const vault = this.authorize(input.vault); const result = await auditVaultIntegrity({ vault: input.vault, root: vault.rootPath, policy: BRAIN_FOUNDATION_POLICY }); await this.record("organizer_audit", "allowed", input.vault, undefined, "complete"); return result;
  }

  public async startRun(input: { vault: string; requestedMode?: OrganizerMode }): Promise<RunSummary> {
    this.authorize(input.vault); const active = this.active.get(input.vault);
    if (active) return { ...active.summary, status: "already_running" };
    const lock = await acquireOrganizerLock({ path: this.options.lockPath, maxRunDurationMs: this.options.maxRunDurationMs ?? 3_600_000 });
    if (!lock) return { runId: "", mode: this.runMode(input.requestedMode), discovered: 0, proposed: 0, applied: 0, review: 0, skipped: 0, failed: 0, status: "already_running" };
    const mode = this.runMode(input.requestedMode); const summary = this.options.store.startRun({ vault: input.vault, mode, startedAt: this.now() });
    const promise = this.executeRun(input.vault, summary, lock).catch((error: unknown) => {
      const failed = { ...summary, failed: summary.failed + 1, status: "failed" as const };
      return this.options.store.finishRun(summary.runId, failed, this.now());
    });
    this.active.set(input.vault, { summary, promise });
    void promise.catch(() => undefined).finally(() => this.active.delete(input.vault));
    return summary;
  }

  public async runToCompletion(input: { vault: string; requestedMode?: OrganizerMode }): Promise<RunSummary> {
    const summary = await this.startRun(input); if (summary.status === "already_running") return summary;
    return this.active.get(input.vault)!.promise;
  }

  public async listReportPaths(vault: string): Promise<string[]> {
    const fs = this.authorize(vault); const directory = path.join(fs.rootPath, ...this.options.config.reportsDirectory.split("/"));
    try { return (await readdir(directory)).filter((name) => name.endsWith(".json")).sort(compare).map((name) => `${this.options.config.reportsDirectory}/${name}`); } catch { return []; }
  }

  private async executeRun(vaultId: string, initial: RunSummary, lock: OrganizerLock): Promise<RunSummary> {
    let summary = initial;
    const paths: ReportPath[] = [];
    try {
      if (summary.mode !== "disabled") {
        const vault = this.authorize(vaultId);
        const candidates = (await scanStableInbox({ root: vault.rootPath, minStableSeconds: this.options.config.minStableSeconds, nowMs: Date.parse(this.now()), maxBytes: this.options.config.maxNoteBytes })).slice(0, this.options.config.maxNotesPerRun);
        summary = { ...summary, discovered: candidates.length };
        for (const candidate of candidates) {
          try {
            const proposal = await this.proposeCandidate(vaultId, vault.rootPath, candidate);
            summary = { ...summary, proposed: summary.proposed + 1 };
            if (proposal.confidence >= this.options.config.autoApplyConfidence) {
              if (summary.mode === "automatic") { await this.apply({ vault: vaultId, proposalId: proposal.id }); summary = { ...summary, applied: summary.applied + 1 }; paths.push({ path: candidate.path, reasonCode: "applied" }); }
              else paths.push({ path: candidate.path, reasonCode: "proposed" });
            } else if (proposal.confidence >= 0.7) { summary = { ...summary, review: summary.review + 1 }; paths.push({ path: candidate.path, reasonCode: "review" }); }
            else { summary = { ...summary, skipped: summary.skipped + 1 }; paths.push({ path: candidate.path, reasonCode: "skipped_low_confidence" }); }
          } catch (error) {
            if (error instanceof Error && error.message === "sensitive_source") { summary = { ...summary, skipped: summary.skipped + 1 }; paths.push({ path: candidate.path, reasonCode: "sensitive_source" }); }
            else { summary = { ...summary, failed: summary.failed + 1 }; paths.push({ path: candidate.path, reasonCode: safeReason(error) }); }
          }
        }
      }
      const complete = { ...summary, status: "complete" as const }; await this.writeReport(vaultId, complete, paths); await this.record("organizer_run", "allowed", vaultId, undefined, "complete"); return this.options.store.finishRun(initial.runId, complete, this.now());
    } finally { await lock.release(); }
  }

  private async proposeCandidate(vaultId: string, root: string, candidate: InboxCandidate): Promise<StoredProposal> {
    const source = await readFile(candidate.absolutePath, "utf8");
    if (Buffer.byteLength(source, "utf8") > this.options.config.maxNoteBytes || sha(source) !== candidate.hash) throw new Error("source_not_ready");
    if (detectSensitiveContent(source).length) throw new Error("sensitive_source");
    const provider = await this.provider();
    const existing = new Set((await this.authorize(vaultId).listNotes()).map((item) => item.replaceAll("\\", "/")));
    const directories = await this.existingApprovedDirectories(root);
    const candidateNotes = [...existing].filter((item) => item !== candidate.path).sort(compare).slice(0, 512);
    const context = this.context(source, candidate.path, candidateNotes, [...directories].sort(compare));
    const draft = await provider.propose(context);
    const targetDirectory = assertApprovedDestination(draft.targetDirectory, directories);
    for (const related of draft.relatedNotePaths) if (!existing.has(related)) throw new Error("related_note_missing");
    const destinationPath = buildDestinationPath(targetDirectory, draft.title, existing);
    const createdAt = this.now(); const proposal: StoredProposal = { ...draft, id: organizerIds.proposal(), vault: vaultId, sourcePath: candidate.path, sourceHash: candidate.hash, destinationPath, policyVersion: BRAIN_FOUNDATION_POLICY.version, createdAt, expiresAt: expiry(createdAt, this.options.config.proposalTtlHours), status: "pending" };
    this.options.store.saveProposal(proposal); await this.record("organizer_propose", "allowed", vaultId, candidate.path, "proposed"); return proposal;
  }

  private context(source: string, sourcePath: string, notes: string[], directories: string[]): { policyVersion: string; approvedDirectories: string[]; candidateNotes: string[]; note: { path: string; content: string } } {
    const max = this.options.config.maxContextBytes; let content = source; const candidates: string[] = [];
    const base = () => ({ policyVersion: BRAIN_FOUNDATION_POLICY.version, approvedDirectories: directories, candidateNotes: candidates, note: { path: sourcePath, content } });
    while (Buffer.byteLength(JSON.stringify(base()), "utf8") > max && content.length) content = content.slice(0, -1);
    for (const note of notes.slice(0, 512)) { candidates.push(note); if (Buffer.byteLength(JSON.stringify(base()), "utf8") > max) candidates.pop(); }
    if (Buffer.byteLength(JSON.stringify(base()), "utf8") > max) throw new Error("context_limit");
    return base();
  }

  private async existingApprovedDirectories(root: string): Promise<Set<string>> {
    const boundRoot = await realpath(root); const rootStat = await lstat(root); if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("vault_root_unsafe");
    const found = new Set<string>();
    const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
      if (depth > BRAIN_FOUNDATION_POLICY.maxDepth) return;
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries) if (!entry.name.startsWith(".")) {
        const next = relative ? `${relative}/${entry.name}` : entry.name;
        const candidate = path.join(absolute, entry.name); const before = await lstat(candidate);
        if (before.isSymbolicLink()) throw new Error("approved_directory_unsafe");
        if (!before.isDirectory()) continue;
        const canonical = await realpath(candidate); const after = await lstat(candidate);
        if (after.isSymbolicLink() || !after.isDirectory() || outside(boundRoot, canonical)) throw new Error("approved_directory_unsafe");
        found.add(next); await walk(canonical, next, depth + 1);
      }
    };
    for (const area of BRAIN_FOUNDATION_POLICY.areas) {
      const absolute = path.join(boundRoot, area.directory); let value;
      try { value = await lstat(absolute); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (value.isSymbolicLink() || !value.isDirectory()) throw new Error("approved_directory_unsafe");
      const canonical = await realpath(absolute); if (outside(boundRoot, canonical)) throw new Error("approved_directory_unsafe");
      found.add(area.directory); await walk(canonical, area.directory, 1);
    }
    return new Set([...found].sort(compare).slice(0, 256));
  }

  private mocLinks(content: string): Map<string, string> { const result = new Map<string, string>(); for (const match of content.matchAll(/^- \[\[([^|\]]+)\|([^\]]+)\]\]$/gmu)) result.set(match[1]!, match[2]!); return result; }
  private providerDisabled(): boolean { return this.options.config.mode === "disabled" || !this.options.provider; }
  private async provider(): Promise<OrganizerProvider> { if (this.providerDisabled()) throw new Error("organizer_unavailable"); if (!this.providerInstance) this.providerInstance = typeof this.options.provider === "function" ? await this.options.provider({ maxContextBytes: this.options.config.maxContextBytes }) : this.options.provider!; return this.providerInstance; }
  private runMode(requested: OrganizerMode | undefined): OrganizerMode { if (this.providerDisabled()) return "disabled"; const trial = this.options.store.getOrStartTrial(this.now()); if (trial.active) return "dry-run"; if (this.options.config.mode === "dry-run" || requested === "dry-run") return "dry-run"; return "automatic"; }
  private authorize(vault: string) { if (!this.options.config.enabledVaults.includes(vault)) throw new Error("vault_not_enabled"); return this.options.registry.get(vault); }
  private async writeReport(vault: string, summary: RunSummary, paths: ReportPath[]): Promise<void> { const fs = this.authorize(vault); const boundRoot = await realpath(fs.rootPath); await this.reportDirectory(boundRoot); await this.options.onBeforeReportOpen?.(); await this.reportDirectory(boundRoot); const ordered = [...paths].sort((left, right) => compare(left.path, right.path) || compare(left.reasonCode, right.reasonCode)); const content = JSON.stringify({ runId: summary.runId, mode: summary.mode, paths: ordered, counts: { discovered: summary.discovered, proposed: summary.proposed, applied: summary.applied, review: summary.review, skipped: summary.skipped, failed: summary.failed }, reasonCodes: [...new Set(ordered.map((item) => item.reasonCode))].sort(compare) }); await this.options.transaction.publishCreateOnlyArtifact({ vaultRoot: boundRoot, relativePath: `${this.options.config.reportsDirectory}/${summary.runId}.json`, owner: summary.runId, content, onEvent: this.options.onReportPublicationEvent }); }
  private async reportDirectory(root: string): Promise<string> { const boundRoot = await realpath(root); let current = boundRoot; for (const segment of this.options.config.reportsDirectory.split("/")) { const next = path.join(current, segment); try { await mkdir(next, { mode: 0o700 }); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } const before = await lstat(next); if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("report_directory_unsafe"); const canonical = await realpath(next); const after = await lstat(next); if (after.isSymbolicLink() || !after.isDirectory() || outside(boundRoot, canonical)) throw new Error("report_directory_unsafe"); current = canonical; } return current; }
  private async record(action: "organizer_propose" | "organizer_apply" | "organizer_undo" | "organizer_run" | "organizer_audit", outcome: "allowed" | "denied", vault: string, path?: string, reason?: string): Promise<void> { await this.options.auditLogger?.record({ action, outcome, vault, path, reason }); }
}
