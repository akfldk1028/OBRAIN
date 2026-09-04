import { pathToFileURL } from "node:url";
import { assembleRuntime } from "./runtime.js";
import type { OrganizerMode, RunSummary } from "./organizer/types.js";

export type OrganizerCommand =
  | { command: "run"; vault: string; requestedMode?: Exclude<OrganizerMode, "disabled"> }
  | { command: "audit"; vault: string }
  | { command: "undo"; vault: string; transactionId: string };

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function requireVault(value: string | undefined): string {
  if (!value || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) throw new Error("--vault must be a valid vault ID");
  return value;
}

export function parseOrganizerArgs(argv: string[]): OrganizerCommand {
  const command = argv[0];
  if (command !== "run" && command !== "audit" && command !== "undo") {
    throw new Error("Usage: organizer-cli <run|audit|undo> --vault <vault>");
  }

  let vault: string | undefined;
  let requestedMode: Exclude<OrganizerMode, "disabled"> | undefined;
  let transactionId: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--vault") {
      if (vault !== undefined) throw new Error("--vault may be specified once");
      vault = requireValue(argv, index, option);
    } else if (option === "--mode" && command === "run") {
      if (requestedMode !== undefined) throw new Error("--mode may be specified once");
      const value = requireValue(argv, index, option);
      if (value !== "dry-run" && value !== "automatic") throw new Error("--mode must be dry-run or automatic");
      requestedMode = value;
    } else if ((option === "--transaction-id" || option === "--transaction") && command === "undo") {
      if (transactionId !== undefined) throw new Error("--transaction-id may be specified once");
      transactionId = requireValue(argv, index, option);
    } else {
      throw new Error(`Unsupported option: ${option ?? ""}`);
    }
    index += 1;
  }

  const parsedVault = requireVault(vault);
  if (command === "run") return { command, vault: parsedVault, ...(requestedMode === undefined ? {} : { requestedMode }) };
  if (command === "audit") return { command, vault: parsedVault };
  if (!transactionId || !transactionId.startsWith("ORG-") || Buffer.byteLength(transactionId, "utf8") > 160) {
    throw new Error("undo requires an exact --transaction-id");
  }
  return { command, vault: parsedVault, transactionId };
}

function safeRunSummary(summary: RunSummary) {
  return {
    runId: summary.runId,
    mode: summary.mode,
    status: summary.status,
    discovered: summary.discovered,
    proposed: summary.proposed,
    applied: summary.applied,
    review: summary.review,
    skipped: summary.skipped,
    failed: summary.failed,
  };
}

export async function runOrganizerCli(argv: string[], environment: NodeJS.ProcessEnv, output: (line: string) => void = console.log): Promise<void> {
  const parsed = parseOrganizerArgs(argv);
  const configFile = environment.MCP_CONFIG_FILE;
  if (!configFile) throw new Error("MCP_CONFIG_FILE must be set");
  const runtime = await assembleRuntime({ configFile, environment });
  try {
    if (!runtime.organizer) throw new Error("Organizer is not configured");
    if (parsed.command === "run") {
      output(JSON.stringify(safeRunSummary(await runtime.organizer.runToCompletion(parsed))));
    } else if (parsed.command === "audit") {
      const audit = await runtime.organizer.audit(parsed);
      output(JSON.stringify({ vault: audit.vault, checkedAt: audit.checkedAt, findings: audit.findings }));
    } else {
      const transaction = await runtime.organizer.undo(parsed);
      output(JSON.stringify({ id: transaction.id, vault: transaction.vault, sourcePath: transaction.sourcePath, destinationPath: transaction.destinationPath, appliedAt: transaction.appliedAt, undoneAt: transaction.undoneAt }));
    }
  } finally {
    await runtime.close();
  }
}

export async function runOrganizerCliEntrypoint(argv: string[], environment: NodeJS.ProcessEnv, output: (line: string) => void = console.log): Promise<number> {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    await runOrganizerCli(argv, environment, output);
    return 0;
  } catch {
    output(JSON.stringify({ status: "error", code: "organizer_cli_failed" }));
    return 1;
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runOrganizerCliEntrypoint(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
