export type OrganizerMode = "disabled" | "dry-run" | "automatic";

export interface OrganizerConfig {
  enabledVaults: string[];
  mode: OrganizerMode;
  minStableSeconds: number;
  autoApplyConfidence: number;
  maxNotesPerRun: number;
  maxNoteBytes: number;
  maxContextBytes: number;
  proposalTtlHours: number;
  recoveryDays: number;
  reportsDirectory: "60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports";
}

export interface ProposalDraft {
  targetDirectory: string;
  title: string;
  type: "prompt" | "development" | "agent" | "study" | "business" | "research" | "project" | "tools" | "dk" | "archive";
  status: "active" | "reference" | "complete";
  tags: string[];
  summary: string;
  analogy?: string;
  notes?: string;
  tips?: string[];
  warnings?: string[];
  relatedNotePaths: string[];
  confidence: number;
  reason: string;
}

export interface StoredProposal extends Omit<ProposalDraft, "status"> {
  id: string;
  vault: string;
  sourcePath: string;
  sourceHash: string;
  destinationPath: string;
  policyVersion: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "applied" | "stale" | "rejected";
}

export interface TransactionRecord {
  id: string;
  proposalId: string;
  vault: string;
  sourcePath: string;
  destinationPath: string;
  sourceHash: string;
  destinationHash: string;
  appliedAt: string;
  undoneAt?: string;
}

export interface RunSummary {
  runId: string;
  mode: OrganizerMode;
  discovered: number;
  proposed: number;
  applied: number;
  review: number;
  skipped: number;
  failed: number;
  status: "running" | "complete" | "failed" | "already_running";
}

export interface VaultPolicyView {
  version: string;
  readingOrder: string[];
  approvedAreas: string[];
  maxDepth: number;
  mode: OrganizerMode;
}

export interface InboxListResult {
  vault: string;
  notes: Array<{ path: string; size: number; mtime: string; state: "ready" | "review" }>;
  nextCursor?: number;
}

/**
 * Stable, content-free integrity finding identifiers. Additive changes require a documented
 * compatibility review because operator reports and MCP clients may persist these values.
 */
export type IntegrityFindingCode =
  | "ambiguous_link"
  | "audit_limit_exceeded"
  | "broken_link"
  | "canvas_missing_file"
  | "forbidden_artifact"
  | "invalid_canvas"
  | "invalid_managed_markers"
  | "invalid_path"
  | "max_depth"
  | "missing_required_file"
  | "orphan_note"
  | "unsafe_link";

/** Never includes note text, matched credentials, link targets, or exception messages. */
export interface IntegrityFinding {
  code: IntegrityFindingCode;
  /** A fixed, documented category such as `environment` or `missing`. */
  category: string;
  /** POSIX-style vault-relative path, or `.` when the supplied root itself is unsafe. */
  path: string;
}

export interface IntegrityReport {
  vault: string;
  checkedAt: string;
  findings: IntegrityFinding[];
}

export interface OrganizerServiceApi {
  getPolicy(vault: string): Promise<VaultPolicyView>;
  listInbox(input: { vault: string; state?: "ready" | "review"; limit?: number; cursor?: number }): Promise<InboxListResult>;
  propose(input: { vault: string; path: string }): Promise<StoredProposal>;
  apply(input: { vault: string; proposalId: string }): Promise<TransactionRecord>;
  audit(input: { vault: string; scope?: string }): Promise<IntegrityReport>;
  undo(input: { vault: string; transactionId: string }): Promise<TransactionRecord>;
  startRun(input: { vault: string; requestedMode?: OrganizerMode }): Promise<RunSummary>;
}
