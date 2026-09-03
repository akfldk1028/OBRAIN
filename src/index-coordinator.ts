import { stat } from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { parseNote } from "./note-parser.js";
import type { SearchIndex } from "./search-index.js";
import type { VaultRegistry } from "./vault-registry.js";

export class IndexCoordinator {
  private watcher?: FSWatcher;
  private reconcileTimer?: NodeJS.Timeout;

  constructor(
    private readonly registry: VaultRegistry,
    private readonly index: SearchIndex,
  ) {}

  async initialize(): Promise<void> {
    await this.reconcile();
    await this.startWatching();
  }

  async reconcile(): Promise<void> {
    for (const [vaultId, vault] of this.registry.entries()) {
      const paths = new Set(
        (await vault.listNotes()).map((relativePath) => relativePath.split(path.sep).join("/")),
      );
      for (const relativePath of paths) {
        try {
          await this.indexPath(vaultId, relativePath);
        } catch (error) {
          console.error("note reconciliation failed", { vaultId, relativePath, error });
        }
      }
      this.index.removeMissing(vaultId, paths);
    }
  }

  async startWatching(): Promise<void> {
    if (this.watcher) return;
    this.watcher = chokidar.watch(
      this.registry.entries().map(([, vault]) => vault.rootPath),
      {
        ignored: /(^|[\\/])\../,
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
      },
    );
    const onUpsert = (absolutePath: string) => {
      void this.handleAbsolute("upsert", absolutePath)
        .catch((error) => console.error("index watcher upsert failed", error));
    };
    const onRemove = (absolutePath: string) => {
      void this.handleAbsolute("remove", absolutePath)
        .catch((error) => console.error("index watcher remove failed", error));
    };
    this.watcher.on("add", onUpsert).on("change", onUpsert).on("unlink", onRemove);
    await new Promise<void>((resolve, reject) => {
      this.watcher?.once("ready", resolve).once("error", reject);
    });
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((error) => console.error("scheduled reconcile failed", error));
    }, 6 * 60 * 60 * 1000);
    this.reconcileTimer.unref();
  }

  async stopWatching(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    await this.watcher?.close();
    this.watcher = undefined;
  }

  async indexCreatedNote(vaultId: string, relativePath: string): Promise<void> {
    await this.indexPath(vaultId, relativePath);
  }

  private async handleAbsolute(action: "upsert" | "remove", absolutePath: string): Promise<void> {
    for (const [vaultId, vault] of this.registry.entries()) {
      const relativePath = path.relative(vault.rootPath, absolutePath);
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;
      const normalized = relativePath.split(path.sep).join("/");
      if (!/\.(md|markdown)$/i.test(normalized)) return;
      if (action === "remove") this.index.remove(vaultId, normalized);
      else await this.indexPath(vaultId, normalized);
      return;
    }
  }

  private async indexPath(vaultId: string, relativePath: string): Promise<void> {
    if (!/\.(md|markdown)$/i.test(relativePath)) return;
    const vault = this.registry.get(vaultId);
    const fileStat = await stat(path.join(vault.rootPath, relativePath));
    const content = await vault.readNote(relativePath);
    const note = parseNote(vaultId, relativePath, content, fileStat);
    if (note.metadataError) {
      console.warn("note metadata warning", {
        vaultId,
        relativePath,
        error: note.metadataError,
      });
    }
    this.index.upsert(note);
  }
}
