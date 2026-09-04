import type { AuditLogger } from "./audit.js";
import type { IndexCoordinator } from "./index-coordinator.js";
import type { SearchIndex } from "./search-index.js";
import type { VaultRegistry } from "./vault-registry.js";
import { VaultError } from "./vault.js";
import type { OrganizerServiceApi } from "./organizer/types.js";

export interface CreateInboxRequest {
  vault: string;
  title: string;
  content: string;
  frontmatter?: Record<string, string | number | boolean | string[]>;
}

export class KnowledgeBase {
  constructor(
    private readonly registry: VaultRegistry,
    private readonly index: SearchIndex,
    private readonly coordinator: IndexCoordinator,
    private readonly auditLogger: AuditLogger,
    private readonly organizer?: OrganizerServiceApi,
  ) {}

  async initialize(): Promise<void> {
    await this.coordinator.initialize();
  }

  listVaults(): { vaults: string[] } {
    return { vaults: this.registry.ids() };
  }

  async listNotes(input: {
    vault: string;
    folder?: string;
    limit?: number;
    cursor?: number;
  }): Promise<{ vault: string; notes: string[]; nextCursor?: number }> {
    const vault = this.registry.get(input.vault);
    const all = (await vault.listNotes(input.folder ?? ""))
      .map((notePath) => notePath.replaceAll("\\", "/"));
    const cursor = Math.max(0, input.cursor ?? 0);
    const limit = Math.max(1, Math.min(200, input.limit ?? 100));
    const notes = all.slice(cursor, cursor + limit);
    const nextCursor = cursor + notes.length < all.length ? cursor + notes.length : undefined;
    return { vault: input.vault, notes, nextCursor };
  }

  async readNote(input: { vault: string; path: string }): Promise<{
    vault: string;
    path: string;
    content: string;
  }> {
    const content = await this.registry.get(input.vault).readNote(input.path);
    if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) {
      throw new Error("Note exceeds read limit");
    }
    return { vault: input.vault, path: input.path, content };
  }

  async searchNotes(input: { query: string; vaults?: string[]; limit?: number }) {
    const vaults = input.vaults?.length
      ? [...new Set(input.vaults)].sort()
      : this.registry.ids();
    for (const id of vaults) this.registry.get(id);
    const hits = this.index.search(input.query, vaults, input.limit ?? 50)
      .map(({ vaultId, ...hit }) => ({ vault: vaultId, ...hit }));
    return { query: input.query, hits };
  }

  async getNoteLinks(input: { vault: string; path: string }) {
    await this.registry.get(input.vault).readNote(input.path);
    return {
      vault: input.vault,
      path: input.path,
      outgoing: this.index.outgoingLinks(input.vault, input.path),
      backlinks: this.index.backlinks(input.vault, input.path),
    };
  }

  async createInboxNote(input: CreateInboxRequest): Promise<{ vault: string; path: string }> {
    try {
      const created = await this.registry.get(input.vault).createInboxNote(input);
      await this.coordinator.indexCreatedNote(input.vault, created.path);
      await this.auditLogger.record({
        action: "create_inbox_note",
        outcome: "allowed",
        vault: input.vault,
        path: created.path,
      });
      return { vault: input.vault, path: created.path };
    } catch (error) {
      await this.auditLogger.record({
        action: "create_inbox_note",
        outcome: "denied",
        vault: input.vault,
        reason: error instanceof Error ? error.message : "unknown",
      });
      throw error;
    }
  }

  hasOrganizer(): boolean {
    return this.organizer !== undefined;
  }

  async getPolicy(vault: string) {
    return this.organizerOrThrow().getPolicy(vault);
  }

  async listInbox(input: Parameters<OrganizerServiceApi["listInbox"]>[0]) {
    return this.organizerOrThrow().listInbox(input);
  }

  async propose(input: Parameters<OrganizerServiceApi["propose"]>[0]) {
    return this.organizerOrThrow().propose(input);
  }

  async apply(input: Parameters<OrganizerServiceApi["apply"]>[0]) {
    return this.organizerOrThrow().apply(input);
  }

  async audit(input: Parameters<OrganizerServiceApi["audit"]>[0]) {
    return this.organizerOrThrow().audit(input);
  }

  async undo(input: Parameters<OrganizerServiceApi["undo"]>[0]) {
    return this.organizerOrThrow().undo(input);
  }

  async startRun(input: Parameters<OrganizerServiceApi["startRun"]>[0]) {
    return this.organizerOrThrow().startRun(input);
  }

  private organizerOrThrow(): OrganizerServiceApi {
    if (!this.organizer) throw new VaultError("Organizer is not configured");
    return this.organizer;
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.coordinator.stopWatching();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.index.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "knowledge base cleanup failed");
  }
}
