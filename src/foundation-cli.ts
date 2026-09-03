import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFoundation } from "./foundation/install.js";
import { BRAIN_FOUNDATION_POLICY } from "./foundation/policy.js";

export function parseFoundationArgs(
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { vaultRoot: string; apply: boolean } {
  let vaultRoot: string | undefined;
  let apply = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--vault") {
      if (vaultRoot !== undefined) throw new Error("--vault may only be provided once");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--vault requires a value");
      vaultRoot = value;
      index += 1;
      continue;
    }
    if (argument === "--apply") {
      if (apply) throw new Error("--apply may only be provided once");
      apply = true;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (!vaultRoot) throw new Error("--vault is required");
  const absolute = platform === "win32"
    ? (() => {
        const root = path.win32.parse(vaultRoot).root;
        return path.win32.isAbsolute(vaultRoot) && root !== "\\" && root !== "/";
      })()
    : path.posix.isAbsolute(vaultRoot);
  if (!absolute) throw new Error("--vault must be absolute");
  return { vaultRoot, apply };
}

async function main(): Promise<void> {
  const args = parseFoundationArgs(process.argv.slice(2));
  const result = await installFoundation({ ...args, policy: BRAIN_FOUNDATION_POLICY });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
