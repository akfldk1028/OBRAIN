import { VaultError, VaultFS } from "./vault.js";

export interface VaultDefinition {
  id: string;
  root: string;
}

export class VaultRegistry {
  private constructor(private readonly byId: Map<string, VaultFS>) {}

  static async create(definitions: VaultDefinition[]): Promise<VaultRegistry> {
    const byId = new Map<string, VaultFS>();
    for (const definition of definitions) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(definition.id)) {
        throw new VaultError(`Invalid vault id: ${definition.id}`);
      }
      if (byId.has(definition.id)) {
        throw new VaultError(`Duplicate vault id: ${definition.id}`);
      }
      byId.set(
        definition.id,
        await VaultFS.create(definition.root, { allowedExt: [".md", ".markdown"] }),
      );
    }
    if (byId.size === 0) throw new VaultError("At least one vault is required");
    return new VaultRegistry(byId);
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  entries(): Array<[string, VaultFS]> {
    return [...this.byId.entries()];
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): VaultFS {
    const vault = this.byId.get(id);
    if (!vault) throw new VaultError("Unknown or unauthorized vault");
    return vault;
  }
}
