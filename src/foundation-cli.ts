import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFoundation } from "./foundation/install.js";
import { BRAIN_FOUNDATION_POLICY } from "./foundation/policy.js";

export function parseFoundationArgs(args: string[]): { vaultRoot: string; apply: boolean } {
  const index = args.indexOf("--vault");
  const vaultRoot = index >= 0 ? args[index + 1] : undefined;
  if (!vaultRoot) throw new Error("--vault is required");
  if (!path.isAbsolute(vaultRoot)) throw new Error("--vault must be absolute");
  return { vaultRoot, apply: args.includes("--apply") };
}

async function main(): Promise<void> {
  const args = parseFoundationArgs(process.argv.slice(2));
  const result = await installFoundation({ ...args, policy: BRAIN_FOUNDATION_POLICY });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
