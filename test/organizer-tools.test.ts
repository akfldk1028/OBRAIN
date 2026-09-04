import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createKnowledgeMcpServer } from "../src/server-factory.js";
import type { OrganizerServiceApi } from "../src/organizer/types.js";
import { createKnowledgeFixture } from "./helpers/knowledge-fixture.js";

function fakeOrganizer(): OrganizerServiceApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getPolicy(vault) { calls.push(`getPolicy:${vault}`); return { version: "1", readingOrder: [], approvedAreas: [], maxDepth: 3, mode: "dry-run" }; },
    async listInbox(input) { calls.push(`listInbox:${input.vault}`); return { vault: input.vault, notes: [] }; },
    async propose(input) { calls.push(`propose:${input.path}`); return { id: "PRP-abcdefgh", vault: input.vault, sourcePath: input.path, sourceHash: "a".repeat(64), destinationPath: "10_Areas/note.md", policyVersion: "1", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z", status: "pending", targetDirectory: "10_Areas", title: "note", type: "study", tags: [], summary: "summary", relatedNotePaths: [], confidence: 0.9, reason: "reason" }; },
    async apply(input) { calls.push(`apply:${input.proposalId}`); return { id: "ORG-abcdefgh", proposalId: input.proposalId, vault: input.vault, sourcePath: "Agent-Inbox/note.md", destinationPath: "10_Areas/note.md", sourceHash: "a".repeat(64), destinationHash: "b".repeat(64), appliedAt: "2026-01-01T00:00:00.000Z" }; },
    async audit(input) { calls.push(`audit:${input.vault}`); return { vault: input.vault, checkedAt: "2026-01-01T00:00:00.000Z", findings: [] }; },
    async undo(input) { calls.push(`undo:${input.transactionId}`); return { id: input.transactionId, proposalId: "PRP-abcdefgh", vault: input.vault, sourcePath: "Agent-Inbox/note.md", destinationPath: "10_Areas/note.md", sourceHash: "a".repeat(64), destinationHash: "b".repeat(64), appliedAt: "2026-01-01T00:00:00.000Z" }; },
    async startRun(input) { calls.push(`startRun:${input.requestedMode ?? ""}`); return { runId: "RUN-abcdefgh", mode: input.requestedMode ?? "dry-run", discovered: 0, proposed: 0, applied: 0, review: 0, skipped: 0, failed: 0, status: "complete" }; },
  };
}

async function connect(organizer?: OrganizerServiceApi) {
  const fx = await createKnowledgeFixture(["personal"], organizer);
  const server = createKnowledgeMcpServer(fx.knowledge);
  const client = new Client({ name: "organizer-tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { fx, server, client };
}

it("exposes exactly seven reversible organizer tools only when configured", async () => {
  const organizer = fakeOrganizer();
  const { fx, server, client } = await connect(organizer);
  try {
    const tools = await client.listTools();
    const expected = [
      "apply_organization", "audit_vault", "create_inbox_note", "get_note_links",
      "get_vault_policy", "list_inbox_notes", "list_notes", "list_vaults",
      "organize_now", "propose_organization", "read_note", "search_notes",
      "undo_organization",
    ].sort();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(expected);
  } finally {
    await client.close();
    await server.close();
    await fx.cleanup();
  }
});

it("keeps the original six tools when no organizer is configured", async () => {
  const { fx, server, client } = await connect();
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "create_inbox_note", "get_note_links", "list_notes", "list_vaults", "read_note", "search_notes",
    ]);
  } finally {
    await client.close();
    await server.close();
    await fx.cleanup();
  }
});

it("returns organizer results only through the safe fixed inputs", async () => {
  const { fx, server, client } = await connect(fakeOrganizer());
  try {
    const policy = await client.callTool({ name: "get_vault_policy", arguments: { vault: "personal" } });
    const run = await client.callTool({ name: "organize_now", arguments: { vault: "personal", mode: "automatic" } });
    const defaultRun = await client.callTool({ name: "organize_now", arguments: { vault: "personal" } });
    const laterInboxPage = await client.callTool({ name: "list_inbox_notes", arguments: { vault: "personal", cursor: 201 } });

    expect(JSON.stringify(policy.content)).toContain("dry-run");
    expect(JSON.stringify(run.content)).toContain("automatic");
    expect(JSON.stringify(defaultRun.content)).toContain("dry-run");
    expect(JSON.stringify(laterInboxPage.content)).toContain("personal");
  } finally {
    await client.close();
    await server.close();
    await fx.cleanup();
  }
});

it("does not expose unexpected organizer error details", async () => {
  const organizer = fakeOrganizer();
  organizer.getPolicy = async () => { throw new Error("provider credential: secret-value"); };
  const { fx, server, client } = await connect(organizer);
  try {
    const result = await client.callTool({ name: "get_vault_policy", arguments: { vault: "personal" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain("secret-value");
  } finally {
    await client.close();
    await server.close();
    await fx.cleanup();
  }
});

it("rejects malformed organizer inputs before invoking the service", async () => {
  const organizer = fakeOrganizer();
  const { fx, server, client } = await connect(organizer);
  const invalid = [
    ["get_vault_policy", { vault: "INVALID!" }],
    ["propose_organization", { vault: "personal", path: "Outside/note.md" }],
    ["propose_organization", { vault: "personal", path: "Agent-Inbox/../outside.md" }],
    ["propose_organization", { vault: "personal", path: "Agent-Inbox/note.md", targetDirectory: "10_Areas" }],
    ["propose_organization", { vault: "personal", path: "Agent-Inbox/note.md", content: "replacement" }],
    ["apply_organization", { vault: "personal", proposalId: "bad" }],
    ["undo_organization", { vault: "personal", transactionId: "bad" }],
    ["list_inbox_notes", { vault: "personal", limit: 201 }],
    ["list_inbox_notes", { vault: "personal", cursor: -1 }],
    ["list_inbox_notes", { vault: "personal", cursor: 1_000_001 }],
    ["organize_now", { vault: "personal", mode: "disabled" }],
  ] as const;
  try {
    for (const [name, arguments_] of invalid) {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(result.isError).toBe(true);
    }
    expect(organizer.calls).toEqual([]);
  } finally {
    await client.close();
    await server.close();
    await fx.cleanup();
  }
});
