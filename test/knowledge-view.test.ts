import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { KnowledgeAccessPolicy } from "../src/knowledge-view.js";
import { createKnowledgeMcpServer } from "../src/server-factory.js";
import { createKnowledgeFixture } from "./helpers/knowledge-fixture.js";

function toolJson(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content[0]?.text ?? "null");
}

describe("Vault-scoped knowledge view", () => {
  it("exposes only the FLOW read surface and hides unauthorized Vaults", async () => {
    const fx = await createKnowledgeFixture(["personal", "work"]);
    await writeFile(path.join(fx.rootOf("personal"), "Secret.md"), "# Secret\nprivate");
    const policy: KnowledgeAccessPolicy = {
      allowedVaults: ["work"],
      inboxWrite: false,
      changeFeed: true,
      organizer: false,
    };
    const server = createKnowledgeMcpServer(fx.knowledge, policy);
    const client = new Client({ name: "flow-view-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "get_note_links",
        "list_note_changes",
        "list_notes",
        "list_vaults",
        "read_note",
        "search_notes",
      ]);
      expect(toolJson(await client.callTool({ name: "list_vaults", arguments: {} })))
        .toEqual({ vaults: ["work"] });
      await expect(client.callTool({
        name: "read_note",
        arguments: { vault: "personal", path: "Secret.md" },
      })).resolves.toMatchObject({ isError: true });
      await expect(client.callTool({
        name: "search_notes",
        arguments: { query: "private", vaults: ["personal"] },
      })).resolves.toMatchObject({ isError: true });
      await expect(client.callTool({
        name: "list_note_changes",
        arguments: { vaults: ["personal"], after: 0 },
      })).resolves.toMatchObject({ isError: true });
    } finally {
      await client.close();
      await server.close();
      await fx.cleanup();
    }
  });
});
