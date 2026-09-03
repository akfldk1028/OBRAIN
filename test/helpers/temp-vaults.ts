import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function makeTempVaultSet(ids: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "brain-vaults-"));
  const vaults: { id: string; root: string }[] = [];
  for (const id of ids) {
    const vaultRoot = path.join(root, id);
    await mkdir(path.join(vaultRoot, "Agent-Inbox"), { recursive: true });
    vaults.push({ id, root: vaultRoot });
  }
  return {
    root,
    vaults,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
