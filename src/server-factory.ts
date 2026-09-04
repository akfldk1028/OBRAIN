import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultFS } from "./vault.js";
import { registerTools } from "./tools.js";
import type { KnowledgeBase } from "./knowledge-base.js";
import type { KnowledgeAccessPolicy } from "./knowledge-view.js";
import { registerKnowledgeTools } from "./knowledge-tools.js";

/**
 * Build a fresh McpServer bound to the given vault.
 *
 * The stdio path calls this once. The HTTP path calls it once per session —
 * each Streamable-HTTP session needs its own McpServer (a server binds a single
 * transport), while the underlying VaultFS is stateless and shared across all.
 */
export function createMcpServer(vault: VaultFS): McpServer {
  const server = new McpServer({ name: "obsidian-multivault", version: "1.0.0" });
  registerTools(server, vault);
  return server;
}

export function createKnowledgeMcpServer(
  knowledge: KnowledgeBase,
  policy: KnowledgeAccessPolicy = {
    allowedVaults: knowledge.listVaults().vaults,
    inboxWrite: true,
    changeFeed: false,
    organizer: true,
  },
): McpServer {
  const server = new McpServer({ name: "obsidian-brain", version: "1.0.0" });
  // This registration includes the organizer tools only when the shared runtime supplies one.
  registerKnowledgeTools(server, knowledge, policy);
  return server;
}
