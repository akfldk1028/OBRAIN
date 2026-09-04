import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { startHttp } from "../src/http.js";
import type { OrganizerServiceApi } from "../src/organizer/types.js";
import { createKnowledgeFixture } from "./helpers/knowledge-fixture.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

it("routes unauthenticated local HTTP to the multi-vault knowledge server", async () => {
  const previousNoAuth = process.env.MCP_NO_AUTH;
  process.env.MCP_NO_AUTH = "1";
  const fx = await createKnowledgeFixture(["personal", "work"]);
  await fx.knowledge.initialize();
  const port = await freePort();
  const runtime = await startHttp(
    [{ id: "owner", passphrase: "a-long-test-passphrase", knowledge: fx.knowledge }],
    { host: "127.0.0.1", port },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: "http-knowledge-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "create_inbox_note",
      "get_note_links",
      "list_notes",
      "list_vaults",
      "read_note",
      "search_notes",
    ]);
    const result = await client.callTool({ name: "list_vaults", arguments: {} });
    expect(JSON.stringify(result.content)).toContain("personal");
    expect(JSON.stringify(result.content)).toContain("work");
  } finally {
    await client.close();
    await runtime.close();
    await fx.cleanup();
    if (previousNoAuth === undefined) delete process.env.MCP_NO_AUTH;
    else process.env.MCP_NO_AUTH = previousNoAuth;
  }
});

it("exposes organizer tools over HTTP only when configured", async () => {
  const previousNoAuth = process.env.MCP_NO_AUTH;
  process.env.MCP_NO_AUTH = "1";
  const organizer: OrganizerServiceApi = {
    async getPolicy() { throw new Error("not invoked"); },
    async listInbox() { throw new Error("not invoked"); },
    async propose() { throw new Error("not invoked"); },
    async apply() { throw new Error("not invoked"); },
    async audit() { throw new Error("not invoked"); },
    async undo() { throw new Error("not invoked"); },
    async startRun() { throw new Error("not invoked"); },
  };
  const fx = await createKnowledgeFixture(["personal"], organizer);
  await fx.knowledge.initialize();
  const port = await freePort();
  const runtime = await startHttp(
    [{ id: "owner", passphrase: "a-long-test-passphrase", knowledge: fx.knowledge }],
    { host: "127.0.0.1", port },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: "http-organizer-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "apply_organization", "audit_vault", "create_inbox_note", "get_note_links",
      "get_vault_policy", "list_inbox_notes", "list_notes", "list_vaults",
      "organize_now", "propose_organization", "read_note", "search_notes",
      "undo_organization",
    ]);
  } finally {
    await client.close();
    await runtime.close();
    await fx.cleanup();
    if (previousNoAuth === undefined) delete process.env.MCP_NO_AUTH;
    else process.env.MCP_NO_AUTH = previousNoAuth;
  }
});

it("advertises client credentials while retaining human OAuth grants", async () => {
  const previousNoAuth = process.env.MCP_NO_AUTH;
  const previousJwtSecret = process.env.MCP_JWT_SECRET;
  delete process.env.MCP_NO_AUTH;
  process.env.MCP_JWT_SECRET = "test-jwt-secret-at-least-thirty-two-characters";
  const fx = await createKnowledgeFixture(["brain"]);
  const port = await freePort();
  const runtime = await startHttp(
    [{ id: "owner", passphrase: "a-long-test-passphrase", knowledge: fx.knowledge }],
    { host: "127.0.0.1", port },
  );
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`,
    );
    const metadata = await response.json() as {
      grant_types_supported: string[];
      token_endpoint_auth_methods_supported: string[];
      scopes_supported: string[];
    };

    expect(response.status).toBe(200);
    expect(metadata.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
      "client_credentials",
    ]);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_post",
      "none",
      "client_secret_basic",
    ]);
    expect(metadata.scopes_supported).toEqual(["notes:read"]);
  } finally {
    await runtime.close();
    await fx.cleanup();
    if (previousNoAuth === undefined) delete process.env.MCP_NO_AUTH;
    else process.env.MCP_NO_AUTH = previousNoAuth;
    if (previousJwtSecret === undefined) delete process.env.MCP_JWT_SECRET;
    else process.env.MCP_JWT_SECRET = previousJwtSecret;
  }
});
