import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createKnowledgeMcpServer } from "../src/server-factory.js";
import { createKnowledgeFixture } from "./helpers/knowledge-fixture.js";

it("exposes exactly the six safe public tools", async () => {
  const fx = await createKnowledgeFixture(["personal"]);
  const server = createKnowledgeMcpServer(fx.knowledge);
  const client = new Client({ name: "knowledge-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "create_inbox_note",
      "get_note_links",
      "list_notes",
      "list_vaults",
      "read_note",
      "search_notes",
    ]);
    expect(names).not.toContain("write_note");
    expect(names).not.toContain("edit_note");
    expect(names).not.toContain("delete_note");
  } finally {
    await client.close();
    await server.close();
    await fx.cleanup();
  }
});
