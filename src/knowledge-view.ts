import type { CreateInboxRequest, KnowledgeBase } from "./knowledge-base.js";
import type { NoteChangePage } from "./search-index.js";
import { VaultError } from "./vault.js";

export type KnowledgeAccessPolicy = {
  allowedVaults: string[];
  inboxWrite: boolean;
  changeFeed: boolean;
  organizer: boolean;
};

export class KnowledgeView {
  readonly policy: KnowledgeAccessPolicy;

  constructor(
    private readonly knowledge: KnowledgeBase,
    policy: KnowledgeAccessPolicy,
  ) {
    const available = new Set(knowledge.listVaults().vaults);
    const allowedVaults = [...new Set(policy.allowedVaults)].sort();
    if (allowedVaults.some((vault) => !available.has(vault))) {
      throw new VaultError("Unknown or unauthorized vault");
    }
    this.policy = { ...policy, allowedVaults };
  }

  listVaults(): { vaults: string[] } {
    return { vaults: [...this.policy.allowedVaults] };
  }

  listNotes(input: {
    vault: string;
    folder?: string;
    limit?: number;
    cursor?: number;
  }): ReturnType<KnowledgeBase["listNotes"]> {
    this.assertAllowed(input.vault);
    return this.knowledge.listNotes(input);
  }

  readNote(input: {
    vault: string;
    path: string;
    changeSeq?: number;
  }): ReturnType<KnowledgeBase["readNote"]> {
    this.assertAllowed(input.vault);
    return this.knowledge.readNote(input);
  }

  searchNotes(input: {
    query: string;
    vaults?: string[];
    limit?: number;
  }): ReturnType<KnowledgeBase["searchNotes"]> {
    const vaults = this.resolveVaults(input.vaults);
    return this.knowledge.searchNotes({ ...input, vaults });
  }

  getNoteLinks(input: {
    vault: string;
    path: string;
  }): ReturnType<KnowledgeBase["getNoteLinks"]> {
    this.assertAllowed(input.vault);
    return this.knowledge.getNoteLinks(input);
  }

  async listNoteChanges(input: {
    vaults?: string[];
    after?: number;
    limit?: number;
  }): Promise<NoteChangePage> {
    if (!this.policy.changeFeed) throw new VaultError("Change feed is not authorized");
    const vaults = this.resolveVaults(input.vaults);
    return this.knowledge.listNoteChanges({
      allowedVaults: vaults,
      after: input.after ?? 0,
      limit: input.limit ?? 100,
    });
  }

  createInboxNote(input: CreateInboxRequest): ReturnType<KnowledgeBase["createInboxNote"]> {
    if (!this.policy.inboxWrite) throw new VaultError("Inbox writes are not authorized");
    this.assertAllowed(input.vault);
    return this.knowledge.createInboxNote(input);
  }

  private resolveVaults(requested?: string[]): string[] {
    const vaults = requested?.length
      ? [...new Set(requested)].sort()
      : [...this.policy.allowedVaults];
    for (const vault of vaults) this.assertAllowed(vault);
    return vaults;
  }

  private assertAllowed(vault: string): void {
    if (!this.policy.allowedVaults.includes(vault)) {
      throw new VaultError("Unknown or unauthorized vault");
    }
  }
}
