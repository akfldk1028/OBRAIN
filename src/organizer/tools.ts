import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KnowledgeBase } from "../knowledge-base.js";
import { VaultError } from "../vault.js";
import { assertInboxSource } from "./paths.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const json = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});
const failure = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});
const wrap = (handler: (input: any) => Promise<ToolResult>) => async (input: any) => {
  try {
    return await handler(input);
  } catch (error: any) {
    if (error instanceof VaultError) return failure(`Error: ${error.message}`);
    return failure("Unexpected organizer error");
  }
};

const vaultId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const inboxPath = z.string().min(1).max(1024).refine((value) => {
  try {
    assertInboxSource(value);
    return true;
  } catch {
    return false;
  }
}, "Must be a safe Agent-Inbox Markdown path");
const proposalId = z.string().regex(/^PRP-[A-Za-z0-9-]{8,80}$/);
const transactionId = z.string().regex(/^ORG-[A-Za-z0-9-]{8,80}$/);
const limit = z.number().int().min(1).max(200);
const cursor = z.number().int().min(0).max(1_000_000);

export function registerOrganizerTools(server: McpServer, knowledge: KnowledgeBase): void {
  if (!knowledge.hasOrganizer()) return;

  server.registerTool(
    "get_vault_policy",
    { title: "Get vault policy", description: "Get the active safe organization policy for a vault.", inputSchema: z.object({ vault: vaultId }).strict() },
    wrap(async (input) => json(await knowledge.getPolicy(input.vault))),
  );
  server.registerTool(
    "list_inbox_notes",
    { title: "List inbox notes", description: "List safe-to-organize Agent-Inbox notes.", inputSchema: z.object({ vault: vaultId, state: z.enum(["ready", "review"]).optional(), limit: limit.optional(), cursor: cursor.optional() }).strict() },
    wrap(async (input) => json(await knowledge.listInbox(input))),
  );
  server.registerTool(
    "propose_organization",
    { title: "Propose organization", description: "Create a reversible proposal for an Agent-Inbox note.", inputSchema: z.object({ vault: vaultId, path: inboxPath }).strict() },
    wrap(async (input) => json(await knowledge.propose(input))),
  );
  server.registerTool(
    "apply_organization",
    { title: "Apply organization", description: "Apply a previously approved safe organization proposal.", inputSchema: z.object({ vault: vaultId, proposalId }).strict() },
    wrap(async (input) => json(await knowledge.apply(input))),
  );
  server.registerTool(
    "audit_vault",
    { title: "Audit vault", description: "Audit organizer integrity without exposing note content.", inputSchema: z.object({ vault: vaultId }).strict() },
    wrap(async (input) => json(await knowledge.audit(input))),
  );
  server.registerTool(
    "undo_organization",
    { title: "Undo organization", description: "Undo one organizer transaction.", inputSchema: z.object({ vault: vaultId, transactionId }).strict() },
    wrap(async (input) => json(await knowledge.undo(input))),
  );
  server.registerTool(
    "organize_now",
    { title: "Organize now", description: "Run safe organization using only dry-run or automatic mode.", inputSchema: z.object({ vault: vaultId, mode: z.enum(["dry-run", "automatic"]).optional() }).strict() },
    wrap(async (input) => json(await knowledge.startRun({ vault: input.vault, requestedMode: input.mode }))),
  );
}
