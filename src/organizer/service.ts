import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { AuditLogger } from "../audit.js";
import { validateGeneratedCanvas, type JsonCanvas } from "../foundation/canvas.js";
import { BRAIN_FOUNDATION_POLICY, areaCanvasPath, areaGuidePath, areaMocPath } from "../foundation/policy.js";
import { VaultRegistry } from "../vault-registry.js";
import { auditVaultIntegrity } from "./integrity.js";
import { acquireOrganizerLock, type OrganizerLock } from "./lock.js";
import { renderManagedAreaCanvas } from "./managed-canvas.js";
import { replaceManagedMocIndex } from "./managed-moc.js";
import { assertApprovedDestination, assertInboxSource, buildDestinationPath } from "./paths.js";
import type { OrganizerContext, OrganizerPolicyContextDocument, OrganizerProvider } from "./provider.js";
import { renderOrganizedNote } from "./render-note.js";
import { scanStableInbox, type InboxCandidate } from "./scanner.js";
import { detectSensitiveContent } from "./secrets.js";
import { OrganizerStore, organizerIds, type SourceDecisionDisposition } from "./store.js";
import { OrganizerTransactionEngine, type CreateOnlyVaultArtifactEvent } from "./transaction.js";
import type { InboxListResult, IntegrityReport, OrganizerConfig, OrganizerMode, OrganizerServiceApi, RunSummary, StoredProposal, TransactionRecord, VaultPolicyView } from "./types.js";

const DAY = 86_400_000;
const MAX_POLICY_CONTEXT_ITEMS = 32;
const MAX_POLICY_SUMMARY_BYTES = 4_096;
const MAX_REPORT_INTEGRITY_FINDINGS = 100;
const MAX_MANAGED_ARTIFACT_BYTES = 1_048_576;

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
function inlineCode(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length));
  const delimiter = "`".repeat(longest + 1);
  return `${delimiter}${longest ? " " : ""}${value}${longest ? " " : ""}${delimiter}`;
}
function redactedReportPath(value: string): string {
  return detectSensitiveContent(value).length ? "[redacted-sensitive-path]" : value;
}
type ReportPath = { path: string; reasonCode: string };
type CandidateProposal = { proposal: StoredProposal; fresh: boolean; disposition: SourceDecisionDisposition };

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

async function readHandlePrefix(handle: FileHandle, limit: number): Promise<Buffer> {
  const bytes = Buffer.alloc(limit);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return bytes.subarray(0, offset);
}

function decodeUtf8Prefix(bytes: Buffer, truncated: boolean): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= (truncated ? 3 : 0); trim += 1) {
    try { return decoder.decode(bytes.subarray(0, bytes.length - trim)); } catch { /* try a shorter code-point boundary */ }
  }
  throw new Error("policy_context_invalid_utf8");
}

async function readPolicySummary(root: string, relativePath: string): Promise<string | undefined> {
  const absolute = path.join(root, ...relativePath.split("/"));
  let before: BigIntStats;
  try { before = await lstat(absolute, { bigint: true }); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("policy_context_unsafe");
  const canonical = await realpath(absolute);
  if (outside(root, canonical)) throw new Error("policy_context_unsafe");
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) throw new Error("policy_context_changed");
    const bytes = await readHandlePrefix(handle, Math.min(Number(opened.size), MAX_POLICY_SUMMARY_BYTES));
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(absolute, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(opened, finalPath)) throw new Error("policy_context_changed");
    const summary = decodeUtf8Prefix(bytes, opened.size > BigInt(bytes.length));
    return detectSensitiveContent(summary).length ? "Sensitive content omitted." : summary;
  } finally {
    await handle.close();
  }
}

async function readManagedArtifact(root: string, relativePath: string): Promise<string> {
  const absolute = path.join(root, ...relativePath.split("/"));
  const before = await lstat(absolute, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(MAX_MANAGED_ARTIFACT_BYTES)) {
    throw new Error("managed artifact is unsafe or exceeds limit");
  }
  const canonical = await realpath(absolute);
  if (outside(root, canonical)) throw new Error("managed artifact is unsafe");
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened) || opened.size > BigInt(MAX_MANAGED_ARTIFACT_BYTES)) throw new Error("managed artifact changed");
    const bytes = await readHandlePrefix(handle, Number(opened.size));
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(absolute, { bigint: true });
    if (bytes.length !== Number(opened.size) || !sameFile(opened, after) || !sameFile(opened, finalPath)) {
      throw new Error("managed artifact changed");
    }
    return decodeUtf8Prefix(bytes, false);
  } finally {
    await handle.close();
  }
}

export class OrganizerService implements OrganizerServiceApi {
  private readonly now: () => string;
  private readonly active = new Map<string, { summary: RunSummary; promise: Promise<RunSummary> }>();
  private providerInstance: OrganizerProvider | undefined;

  constructor(private readonly options: OrganizerServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async getPolicy(vault: string): Promise<VaultPolicyView> {
    this.authorize(vault);
    return {
      version: BRAIN_FOUNDATION_POLICY.version,
      readingOrder: [
        BRAIN_FOUNDATION_POLICY.rootGuide,
        BRAIN_FOUNDATION_POLICY.homeMoc,
        "<destination-area>/99_작업가이드_다음AI용.md",
        "<destination-area>/000_<Area>_MOC.md",
        "<target-note>",
        "<relevant-linked-notes>",
      ],
      approvedAreas: BRAIN_FOUNDATION_POLICY.areas.map((area) => area.directory),
      maxDepth: BRAIN_FOUNDATION_POLICY.maxDepth,
      mode: this.effectiveMode(undefined, false),
    };
  }

  public async listInbox(input: { vault: string; state?: "ready" | "review"; limit?: number; cursor?: number }): Promise<InboxListResult> {
    const vault = this.authorize(input.vault); const limit = Math.min(Math.max(input.limit ?? 50, 1), 200); const cursor = Math.max(input.cursor ?? 0, 0);
    const states: Array<"ready" | "review"> = input.state ? [input.state] : ["ready", "review"];
    const scanned = await Promise.all(states.map(async (state) => ({
      state,
      candidates: await scanStableInbox({
        root: vault.rootPath,
        minStableSeconds: this.options.config.minStableSeconds,
        nowMs: Date.parse(this.now()),
        maxBytes: this.options.config.maxNoteBytes,
        state,
      }),
    })));
    const all = scanned.flatMap(({ state, candidates }) => candidates.map((candidate) => ({
      path: candidate.path,
      size: candidate.size,
      mtime: new Date(candidate.mtimeMs).toISOString(),
      state,
    }))).sort((left, right) => compare(left.path, right.path) || compare(left.state, right.state));
    const notes = all.slice(cursor, cursor + limit);
    return { vault: input.vault, notes, ...(cursor + notes.length < all.length ? { nextCursor: cursor + notes.length } : {}) };
  }

  public async propose(input: { vault: string; path: string }): Promise<StoredProposal> {
    const vault = this.authorize(input.vault); const sourcePath = assertInboxSource(input.path);
    if (this.providerDisabled()) throw new Error("organizer_unavailable");
    const candidates = await scanStableInbox({ root: vault.rootPath, minStableSeconds: this.options.config.minStableSeconds, nowMs: Date.parse(this.now()), maxBytes: this.options.config.maxNoteBytes });
    const candidate = candidates.find((item) => item.path === sourcePath);
    if (!candidate) throw new Error("source_not_ready");
    return (await this.proposeCandidate(input.vault, vault.rootPath, candidate)).proposal;
  }

  public async apply(input: { vault: string; proposalId: string }): Promise<TransactionRecord> {
    const lock = await acquireOrganizerLock({ path: this.options.lockPath, maxRunDurationMs: this.options.maxRunDurationMs ?? 3_600_000 });
    if (!lock) throw new Error("organizer_busy");
    try {
      return await this.applyLocked(input);
    } finally {
      await lock.release();
    }
  }

  private async applyLocked(input: { vault: string; proposalId: string }): Promise<TransactionRecord> {
    const vault = this.authorize(input.vault); const proposal = this.options.store.getProposal(input.proposalId);
    if (!proposal || proposal.vault !== input.vault || proposal.status !== "pending") throw new Error("proposal_not_pending");
    const now = this.now();
    if (Date.parse(proposal.expiresAt) <= Date.parse(now)) { this.options.store.markProposal(proposal.id, "stale"); throw new Error("proposal_expired"); }
    if (proposal.policyVersion !== BRAIN_FOUNDATION_POLICY.version) throw new Error("proposal_policy_stale");
    if (this.options.config.mode !== "automatic" || this.options.store.getOrStartTrial(now).active || proposal.confidence < this.options.config.autoApplyConfidence) throw new Error("automatic_apply_not_allowed");
    const sourceCandidate = (await scanStableInbox({ root: vault.rootPath, minStableSeconds: this.options.config.minStableSeconds, nowMs: Date.parse(now), maxBytes: this.options.config.maxNoteBytes }))
      .find((candidate) => candidate.path === proposal.sourcePath);
    if (!sourceCandidate || sourceCandidate.hash !== proposal.sourceHash) { this.options.store.markProposal(proposal.id, "stale"); throw new Error("source_stale"); }
    const source = sourceCandidate.content;
    const existing = new Set((await vault.listNotes()).map((item) => item.replaceAll("\\", "/")));
    for (const area of BRAIN_FOUNDATION_POLICY.areas) {
      if (!existing.has(areaMocPath(area))) throw new Error("missing_required_moc");
    }
    const destinationArea = proposal.destinationPath.split("/", 1)[0]!;
    const target = BRAIN_FOUNDATION_POLICY.areas.find((area) => area.directory === destinationArea);
    if (!target) throw new Error("destination_unapproved");
    const mocPath = areaMocPath(target);
    const canvasPath = areaCanvasPath(target);
    const boundRoot = await realpath(vault.rootPath);
    const moc = await readManagedArtifact(boundRoot, mocPath);
    const currentCanvas = await readManagedArtifact(boundRoot, canvasPath);
    let parsedCanvas: JsonCanvas;
    try {
      const parsed: unknown = JSON.parse(currentCanvas);
      if (!validateGeneratedCanvas(parsed)) throw new Error("invalid");
      parsedCanvas = parsed;
    } catch {
      throw new Error("current Canvas is invalid");
    }
    const transactionId = organizerIds.transaction();
    const links = this.mocLinks(moc); links.set(proposal.destinationPath, proposal.title);
    const replacement = replaceManagedMocIndex(moc, [...links].map(([path, title]) => ({ path, title })));
    const futureExisting = new Set(existing);
    futureExisting.add(proposal.destinationPath);
    const canvasFiles = new Map(parsedCanvas.nodes.map((node) => [node.id, node.file]));
    const childMocPaths = [...new Set(parsedCanvas.nodes.map((node) => node.file)
      .filter((file) => file !== mocPath && /_MOC\.md$/u.test(file)))];
    const representativeNotePaths = [...new Set([
      ...parsedCanvas.nodes.map((node) => node.file).filter((file) => file !== mocPath && !childMocPaths.includes(file)),
      proposal.destinationPath,
    ])];
    const relationships = parsedCanvas.edges.map((edge) => ({
      from: canvasFiles.get(edge.fromNode)!,
      to: canvasFiles.get(edge.toNode)!,
      label: edge.label,
    }));
    if (!relationships.some((relationship) => relationship.from === proposal.destinationPath && relationship.to === mocPath && relationship.label === "parent")) {
      relationships.push({ from: proposal.destinationPath, to: mocPath, label: "parent" });
    }
    const canvasReplacement = renderManagedAreaCanvas({
      canvasPath,
      currentCanvas,
      existingPaths: futureExisting,
      areaMocPath: mocPath,
      childMocPaths,
      representativeNotePaths,
      relationships,
    });
    const transaction = await this.options.transaction.apply({
      id: transactionId, proposal, vaultRoot: vault.rootPath,
      destinationContent: renderOrganizedNote({ source, proposal, transactionId, now, existingNotePaths: existing }),
      managedReplacements: [
        { relativePath: mocPath, expectedHash: sha(moc), content: replacement },
        { relativePath: canvasPath, expectedHash: sha(currentCanvas), content: canvasReplacement },
      ],
    });
    await this.record("organizer_apply", "allowed", input.vault, proposal.sourcePath, "applied");
    return transaction;
  }

  public async undo(input: { vault: string; transactionId: string }): Promise<TransactionRecord> {
    const lock = await acquireOrganizerLock({ path: this.options.lockPath, maxRunDurationMs: this.options.maxRunDurationMs ?? 3_600_000 });
    if (!lock) throw new Error("organizer_busy");
    try {
      return await this.undoLocked(input);
    } finally {
      await lock.release();
    }
  }

  private async undoLocked(input: { vault: string; transactionId: string }): Promise<TransactionRecord> {
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
    let progressed = summary;
    const promise = this.executeRun(input.vault, summary, lock, (next) => {
      progressed = next;
      const active = this.active.get(input.vault);
      if (active) active.summary = next;
    }).catch((_error: unknown) => {
      const failed = { ...progressed, failed: progressed.failed + 1, status: "failed" as const };
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
    try { return (await readdir(directory)).filter((name) => name.endsWith(".md")).sort(compare).map((name) => `${this.options.config.reportsDirectory}/${name}`); } catch { return []; }
  }

  private async executeRun(vaultId: string, initial: RunSummary, lock: OrganizerLock, onProgress: (summary: RunSummary) => void): Promise<RunSummary> {
    let summary = initial;
    const paths: ReportPath[] = [];
    try {
      if (summary.mode !== "disabled") {
        const vault = this.authorize(vaultId);
        const candidates = (await scanStableInbox({ root: vault.rootPath, minStableSeconds: this.options.config.minStableSeconds, nowMs: Date.parse(this.now()), maxBytes: this.options.config.maxNoteBytes })).slice(0, this.options.config.maxNotesPerRun);
        summary = { ...summary, discovered: candidates.length };
        onProgress(summary);
        for (const candidate of candidates) {
          try {
            const decision = await this.proposeCandidate(vaultId, vault.rootPath, candidate, summary.mode === "automatic");
            const proposal = decision.proposal;
            if (decision.fresh) summary = { ...summary, proposed: summary.proposed + 1 };
            if (proposal.confidence >= this.options.config.autoApplyConfidence) {
              if (summary.mode === "automatic") { await this.applyLocked({ vault: vaultId, proposalId: proposal.id }); summary = { ...summary, applied: summary.applied + 1 }; paths.push({ path: candidate.path, reasonCode: "applied" }); }
              else if (decision.fresh) paths.push({ path: candidate.path, reasonCode: "proposed" });
              else { summary = { ...summary, skipped: summary.skipped + 1 }; paths.push({ path: candidate.path, reasonCode: "source_already_decided" }); }
            } else if (proposal.confidence >= 0.7) { summary = { ...summary, review: summary.review + 1 }; paths.push({ path: candidate.path, reasonCode: "review" }); }
            else { summary = { ...summary, skipped: summary.skipped + 1 }; paths.push({ path: candidate.path, reasonCode: "skipped_low_confidence" }); }
          } catch (error) {
            if (error instanceof Error && error.message === "sensitive_source") { summary = { ...summary, skipped: summary.skipped + 1 }; paths.push({ path: candidate.path, reasonCode: "sensitive_source" }); }
            else if (error instanceof Error && ["source_previously_undone", "source_previously_rejected", "source_decision_pending"].includes(error.message)) { summary = { ...summary, skipped: summary.skipped + 1 }; paths.push({ path: candidate.path, reasonCode: error.message }); }
            else { summary = { ...summary, failed: summary.failed + 1 }; paths.push({ path: candidate.path, reasonCode: safeReason(error) }); }
          }
          onProgress(summary);
        }
      }
      const complete = { ...summary, status: "complete" as const };
      const vault = this.authorize(vaultId);
      const integrity = await auditVaultIntegrity({ vault: vaultId, root: vault.rootPath, policy: BRAIN_FOUNDATION_POLICY });
      const finishedAt = this.now();
      await this.writeReport(vaultId, complete, paths, integrity, finishedAt);
      await this.record("organizer_run", "allowed", vaultId, undefined, "complete");
      return this.options.store.finishRun(initial.runId, complete, finishedAt);
    } finally { await lock.release(); }
  }

  private async proposeCandidate(vaultId: string, root: string, candidate: InboxCandidate, refreshExpired = false): Promise<CandidateProposal> {
    const source = candidate.content;
    if (Buffer.byteLength(source, "utf8") > this.options.config.maxNoteBytes || sha(source) !== candidate.hash) throw new Error("source_not_ready");
    if (detectSensitiveContent(source).length || detectSensitiveContent(candidate.path).length) throw new Error("sensitive_source");
    const key = { vault: vaultId, sourcePath: candidate.path, sourceHash: candidate.hash, policyVersion: BRAIN_FOUNDATION_POLICY.version };
    const existingDecision = this.options.store.getSourceDecision(key);
    const createdAt = this.now();
    let proposalId: string;
    let refreshing = false;
    if (existingDecision) {
      const existing = this.reuseSourceDecision(existingDecision.disposition, existingDecision.proposalId);
      if (!refreshExpired || existingDecision.disposition !== "proposed" || Date.parse(existing.proposal.expiresAt) > Date.parse(createdAt)) return existing;
      proposalId = existingDecision.proposalId;
      refreshing = this.options.store.claimSourceDecisionRefresh({ ...key, proposalId, decidedAt: createdAt });
      if (!refreshing) {
        const current = this.options.store.getSourceDecision(key);
        if (!current) throw new Error("source_decision_invalid");
        return this.reuseSourceDecision(current.disposition, current.proposalId);
      }
    } else {
      proposalId = organizerIds.proposal();
      const claim = this.options.store.claimSourceDecision({ ...key, proposalId, decidedAt: createdAt });
      if (!claim.claimed) return this.reuseSourceDecision(claim.decision.disposition, claim.decision.proposalId);
    }
    try {
      const provider = await this.provider();
      const existing = new Set((await this.authorize(vaultId).listNotes()).map((item) => item.replaceAll("\\", "/")));
      const directories = await this.existingApprovedDirectories(root);
      const candidateNotes = [...existing].filter((item) => item !== candidate.path).sort(compare).slice(0, 512);
      const context = await this.context(root, source, candidate.path, candidateNotes, [...directories].sort(compare));
      const draft = await provider.propose(context);
      const targetDirectory = assertApprovedDestination(draft.targetDirectory, directories);
      for (const related of draft.relatedNotePaths) if (!existing.has(related)) throw new Error("related_note_missing");
      const destinationPath = buildDestinationPath(targetDirectory, draft.title, existing);
      const { status: semanticStatus, ...proposalFields } = draft;
      const proposal: StoredProposal = { ...proposalFields, semanticStatus, id: proposalId, vault: vaultId, sourcePath: candidate.path, sourceHash: candidate.hash, destinationPath, policyVersion: BRAIN_FOUNDATION_POLICY.version, createdAt, expiresAt: expiry(createdAt, this.options.config.proposalTtlHours), status: "pending" };
      const disposition = this.proposalDisposition(proposal);
      if (refreshing) this.options.store.refreshProposalForDecision(proposal, disposition);
      else this.options.store.saveProposalForDecision(proposal, disposition);
      await this.record("organizer_propose", "allowed", vaultId, candidate.path, "proposed");
      return { proposal, fresh: true, disposition };
    } catch (error) {
      if (refreshing) this.options.store.releaseSourceDecisionRefresh(key, proposalId);
      else this.options.store.releaseSourceDecisionClaim(key, proposalId);
      throw error;
    }
  }

  private reuseSourceDecision(disposition: SourceDecisionDisposition, proposalId: string): CandidateProposal {
    if (disposition === "processing") throw new Error("source_decision_pending");
    if (disposition === "undone") throw new Error("source_previously_undone");
    if (disposition === "rejected") throw new Error("source_previously_rejected");
    const proposal = this.options.store.getProposal(proposalId);
    if (!proposal) throw new Error("source_decision_invalid");
    return { proposal, fresh: false, disposition };
  }

  private proposalDisposition(proposal: StoredProposal): "proposed" | "review" | "skipped" {
    return proposal.confidence >= this.options.config.autoApplyConfidence ? "proposed" : proposal.confidence >= 0.7 ? "review" : "skipped";
  }

  private async context(root: string, source: string, sourcePath: string, notes: string[], directories: string[]): Promise<OrganizerContext> {
    const max = this.options.config.maxContextBytes;
    const policyContext: OrganizerPolicyContextDocument[] = [];
    const candidates: string[] = [];
    let content = "";
    const base = (): OrganizerContext => ({
      policyVersion: BRAIN_FOUNDATION_POLICY.version,
      approvedDirectories: directories,
      policyContext,
      candidateNotes: candidates,
      note: { path: sourcePath, content },
    });
    for (const document of await this.policyContext(root)) {
      policyContext.push(document);
      if (Buffer.byteLength(JSON.stringify(base()), "utf8") > max) {
        policyContext.pop();
        break;
      }
    }
    content = this.fitNoteContent(source, max, (candidate) => {
      content = candidate;
      return Buffer.byteLength(JSON.stringify(base()), "utf8");
    });
    for (const note of notes.slice(0, 512)) {
      candidates.push(note);
      if (Buffer.byteLength(JSON.stringify(base()), "utf8") > max) candidates.pop();
    }
    if (Buffer.byteLength(JSON.stringify(base()), "utf8") > max) throw new Error("context_limit");
    return base();
  }

  private fitNoteContent(source: string, max: number, measure: (candidate: string) => number): string {
    let low = 0;
    let high = source.length;
    let accepted = "";
    while (low <= high) {
      let midpoint = Math.floor((low + high) / 2);
      if (midpoint > 0 && midpoint < source.length && /[\uD800-\uDBFF]/u.test(source[midpoint - 1]!)) midpoint -= 1;
      const candidate = source.slice(0, midpoint);
      if (measure(candidate) <= max) {
        accepted = candidate;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    return accepted;
  }

  private async policyContext(root: string): Promise<OrganizerPolicyContextDocument[]> {
    const boundRoot = await realpath(root);
    const requested: Array<Omit<OrganizerPolicyContextDocument, "summary">> = [
      { kind: "root_guide", path: BRAIN_FOUNDATION_POLICY.rootGuide },
      { kind: "home_moc", path: BRAIN_FOUNDATION_POLICY.homeMoc },
      ...BRAIN_FOUNDATION_POLICY.areas.flatMap((area) => [
        { kind: "destination_guide" as const, path: areaGuidePath(area) },
        { kind: "destination_moc" as const, path: areaMocPath(area) },
      ]),
    ];
    const result: OrganizerPolicyContextDocument[] = [];
    for (const document of requested.slice(0, MAX_POLICY_CONTEXT_ITEMS)) {
      const summary = await readPolicySummary(boundRoot, document.path);
      if (summary !== undefined) result.push({ ...document, summary });
    }
    return result;
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
  private runMode(requested: OrganizerMode | undefined): OrganizerMode { return this.effectiveMode(requested, true); }
  private effectiveMode(requested: OrganizerMode | undefined, startTrial: boolean): OrganizerMode {
    if (this.providerDisabled()) return "disabled";
    const trial = startTrial ? this.options.store.getOrStartTrial(this.now()) : this.options.store.getTrial(this.now());
    if (!trial || trial.active) return "dry-run";
    if (this.options.config.mode === "dry-run" || requested === "dry-run") return "dry-run";
    return "automatic";
  }
  private authorize(vault: string) { if (!this.options.config.enabledVaults.includes(vault)) throw new Error("vault_not_enabled"); return this.options.registry.get(vault); }
  private async writeReport(vault: string, summary: RunSummary, paths: ReportPath[], integrity: IntegrityReport, finishedAt: string): Promise<void> {
    const fs = this.authorize(vault);
    const boundRoot = await realpath(fs.rootPath);
    await this.reportDirectory(boundRoot);
    await this.options.onBeforeReportOpen?.();
    await this.reportDirectory(boundRoot);
    const ordered = [...paths].sort((left, right) => compare(left.path, right.path) || compare(left.reasonCode, right.reasonCode));
    const findings = integrity.findings.slice(0, MAX_REPORT_INTEGRITY_FINDINGS);
    const noteRows = ordered.length
      ? ordered.map((item) => `| ${inlineCode(redactedReportPath(item.path))} | ${inlineCode(item.reasonCode)} |`)
      : ["| — | — |"];
    const integrityRows = findings.length
      ? findings.map((finding) => `| ${inlineCode(redactedReportPath(finding.path))} | ${inlineCode(finding.code)} | ${inlineCode(finding.category)} |`)
      : ["| — | — | — |"];
    const content = [
      "# Brain Organizer Run Report",
      "",
      `- Time: ${inlineCode(finishedAt)}`,
      `- Run ID: ${inlineCode(summary.runId)}`,
      `- Effective mode: ${inlineCode(summary.mode)}`,
      `- Policy version: ${inlineCode(BRAIN_FOUNDATION_POLICY.version)}`,
      "",
      "## Counts",
      "",
      "| Outcome | Count |",
      "| --- | ---: |",
      `| Discovered | ${summary.discovered} |`,
      `| Proposed | ${summary.proposed} |`,
      `| Applied | ${summary.applied} |`,
      `| Review | ${summary.review} |`,
      `| Skipped | ${summary.skipped} |`,
      `| Failed | ${summary.failed} |`,
      "",
      "## Note outcomes",
      "",
      "| Path | Reason code |",
      "| --- | --- |",
      ...noteRows,
      "",
      "## Post-run integrity",
      "",
      "| Path | Finding | Category |",
      "| --- | --- | --- |",
      ...integrityRows,
      ...(integrity.findings.length > findings.length ? ["", `Showing ${findings.length} of ${integrity.findings.length} bounded findings.`] : []),
      "",
      "## Review and undo",
      "",
      "- Review pending proposals before enabling automatic mode or applying a proposal.",
      "- To reverse an applied transaction, call `undo_organization` with its transaction ID.",
      "",
    ].join("\n");
    await this.options.transaction.publishCreateOnlyArtifact({
      vaultRoot: boundRoot,
      relativePath: `${this.options.config.reportsDirectory}/${summary.runId}.md`,
      owner: summary.runId,
      content,
      onEvent: this.options.onReportPublicationEvent,
    });
  }
  private async reportDirectory(root: string): Promise<string> { const boundRoot = await realpath(root); let current = boundRoot; for (const segment of this.options.config.reportsDirectory.split("/")) { const next = path.join(current, segment); try { await mkdir(next, { mode: 0o700 }); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } const before = await lstat(next); if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("report_directory_unsafe"); const canonical = await realpath(next); const after = await lstat(next); if (after.isSymbolicLink() || !after.isDirectory() || outside(boundRoot, canonical)) throw new Error("report_directory_unsafe"); current = canonical; } return current; }
  private async record(action: "organizer_propose" | "organizer_apply" | "organizer_undo" | "organizer_run" | "organizer_audit", outcome: "allowed" | "denied", vault: string, path?: string, reason?: string): Promise<void> { await this.options.auditLogger?.record({ action, outcome, vault, path, reason }); }
}
