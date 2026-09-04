import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KnowledgeBase } from "./knowledge-base.js";
import { KnowledgeView, type KnowledgeAccessPolicy } from "./knowledge-view.js";
import { VaultError } from "./vault.js";
import { registerOrganizerTools } from "./organizer/tools.js";

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
    return failure(`Unexpected error: ${error?.message ?? String(error)}`);
  }
};

export function registerKnowledgeTools(
  server: McpServer,
  knowledge: KnowledgeBase,
  policy: KnowledgeAccessPolicy,
): void {
  const view = new KnowledgeView(knowledge, policy);
  const vaultId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
  const notePath = z.string().min(1).max(1024);
  const frontmatterValue = z.union([
    z.string().max(10_000),
    z.number(),
    z.boolean(),
    z.array(z.string().max(1_000)).max(100),
  ]);
  const frontmatter = z.record(z.string().min(1).max(100), frontmatterValue)
    .refine((value) => Object.keys(value).length <= 50, "At most 50 fields are allowed");

  server.registerTool(
    "list_vaults",
    {
      title: "List vaults",
      description: "List authorized Obsidian vaults.",
      inputSchema: {},
    },
    async () => json(view.listVaults()),
  );
  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List Markdown notes in one authorized vault.",
      inputSchema: {
        vault: vaultId,
        folder: z.string().max(1024).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.number().int().min(0).optional(),
      },
    },
    wrap(async (input) => json(await view.listNotes(input))),
  );
  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Read one Markdown note.",
      inputSchema: { vault: vaultId, path: notePath },
    },
    wrap(async (input) => json(await view.readNote(input))),
  );
  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description: "Search one or all authorized Obsidian vaults.",
      inputSchema: {
        query: z.string().min(1).max(500),
        vaults: z.array(vaultId).max(64).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    wrap(async (input) => json(await view.searchNotes(input))),
  );
  server.registerTool(
    "get_note_links",
    {
      title: "Get note links",
      description: "Return outgoing links and backlinks for one note.",
      inputSchema: { vault: vaultId, path: notePath },
    },
    wrap(async (input) => json(await view.getNoteLinks(input))),
  );
  if (policy.changeFeed) {
    server.registerTool(
      "list_note_changes",
      {
        title: "List note changes",
        description: "List authorized note changes after a durable cursor.",
        inputSchema: {
          vaults: z.array(vaultId).max(64).optional(),
          after: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
      },
      wrap(async (input) => json(await view.listNoteChanges(input))),
    );
  }
  if (policy.inboxWrite) {
    server.registerTool(
      "create_inbox_note",
      {
        title: "Create inbox note",
        description: "Create a new note only in the selected vault's Agent-Inbox.",
        inputSchema: {
          vault: vaultId,
          title: z.string().min(1).max(200),
          content: z.string().max(1_048_576),
          frontmatter: frontmatter.optional(),
        },
      },
      wrap(async (input) => json(await view.createInboxNote(input))),
    );
  }
  if (policy.organizer) registerOrganizerTools(server, knowledge);
}
