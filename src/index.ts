import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadKnowledgeConfig } from "./config.js";
import type { HttpRuntime, HttpUser } from "./http.js";
import { assembleKnowledge, assembleRuntime } from "./runtime.js";
import { createMcpServer } from "./server-factory.js";
import { VaultFS } from "./vault.js";
import { VaultRegistry } from "./vault-registry.js";

interface Args {
  root?: string;
  readOnly: boolean;
  ext?: string[];
  http: boolean;
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const out: Args = { readOnly: false, http: false, port: 8787, host: "127.0.0.1" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--read-only") out.readOnly = true;
    else if (arg === "--http") out.http = true;
    else if (arg === "--port") {
      const value = Number.parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(value) && value > 0) out.port = value;
    } else if (arg === "--host") {
      const value = args[++i];
      if (value) out.host = value;
    } else if (arg === "--ext") {
      const values = (args[++i] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      if (values.length) out.ext = values;
    } else if (!arg.startsWith("--") && !out.root) out.root = arg;
  }
  return out;
}

async function buildKnowledgeHttpUser(args: Args): Promise<{ user: HttpUser; close(): Promise<void> }> {
  const configFile = process.env.MCP_CONFIG_FILE;
  if (configFile && process.env.MCP_USERS_FILE) {
    throw new Error("Set MCP_CONFIG_FILE only; MCP_USERS_FILE cannot be combined");
  }
  if (configFile) {
    const loaded = await loadKnowledgeConfig(configFile);
    const runtime = await assembleRuntime({ configFile, environment: process.env });
    return {
      user: { id: loaded.owner.id, passphrase: loaded.owner.passphrase, knowledge: runtime.knowledge },
      close: () => runtime.close(),
    };
  }
  if (process.env.MCP_USERS_FILE) {
    throw new Error("MCP_USERS_FILE is legacy; migrate to MCP_CONFIG_FILE");
  }
  if (!args.root) throw new Error("HTTP mode requires MCP_CONFIG_FILE or a vault root");
  const registry = await VaultRegistry.create([{ id: "default", root: args.root }]);
  const dataDir = process.env.MCP_DATA_DIR ?? path.join(args.root, ".obsidian-mcp-data");
  const knowledge = await assembleKnowledge(dataDir, registry);
  return {
    user: { id: "default", passphrase: process.env.MCP_AUTH_PASSPHRASE ?? "", knowledge },
    close: () => knowledge.close(),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.http) {
    const { startHttp } = await import("./http.js");
    const assembled = await buildKnowledgeHttpUser(args);
    let runtime: HttpRuntime;
    try {
      runtime = await startHttp([assembled.user], { port: args.port, host: args.host });
    } catch (error) {
      await assembled.close();
      throw error;
    }
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await runtime.close();
      await assembled.close();
    };
    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
    return;
  }

  const { root, readOnly, ext } = args;
  if (!root) {
    console.error("Usage: obsidian-multivault-mcp <vault-root> [--read-only] [--http]");
    process.exit(2);
  }
  const vault = await VaultFS.create(root, { readOnly, allowedExt: ext });
  const server = createMcpServer(vault);
  await server.connect(new StdioServerTransport());
  console.error(`[obsidian-multivault-mcp] serving ${vault.rootPath}${readOnly ? " (read-only)" : ""}`);
}

main().catch((error) => {
  console.error("[obsidian-multivault-mcp] fatal:", error);
  process.exit(1);
});
