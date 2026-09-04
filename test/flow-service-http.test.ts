import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startHttp } from "../src/http.js";
import { hashServiceSecret, type ServiceClient } from "../src/service-clients.js";
import { createKnowledgeFixture } from "./helpers/knowledge-fixture.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((item) => item.text ?? "").join("\n");
}

describe("FLOW service principal over Streamable HTTP", () => {
  const previous = {
    noAuth: process.env.MCP_NO_AUTH,
    jwtSecret: process.env.MCP_JWT_SECRET,
    publicUrl: process.env.MCP_PUBLIC_URL,
  };

  afterEach(() => {
    if (previous.noAuth === undefined) delete process.env.MCP_NO_AUTH;
    else process.env.MCP_NO_AUTH = previous.noAuth;
    if (previous.jwtSecret === undefined) delete process.env.MCP_JWT_SECRET;
    else process.env.MCP_JWT_SECRET = previous.jwtSecret;
    if (previous.publicUrl === undefined) delete process.env.MCP_PUBLIC_URL;
    else process.env.MCP_PUBLIC_URL = previous.publicUrl;
  });

  it("authenticates, searches, reads changes, and never receives write tools", async () => {
    delete process.env.MCP_NO_AUTH;
    delete process.env.MCP_PUBLIC_URL;
    process.env.MCP_JWT_SECRET = "test-jwt-secret-at-least-thirty-two-characters";
    const fx = await createKnowledgeFixture(["brain", "private"]);
    await writeFile(path.join(fx.rootOf("brain"), "Connected.md"), "# Connected\nFLOW bridge proof");
    await writeFile(path.join(fx.rootOf("private"), "Secret.md"), "# Secret\nnever visible");
    await fx.knowledge.initialize();
    const serviceClient: ServiceClient = {
      clientId: "flow",
      secretHash: await hashServiceSecret("correct horse battery staple"),
      ownerId: "owner",
      scopes: ["notes:read"],
      allowedVaults: ["brain"],
      enabled: true,
    };
    const port = await freePort();
    const runtime = await startHttp(
      [{ id: "owner", passphrase: "owner-passphrase", knowledge: fx.knowledge }],
      { host: "127.0.0.1", port, serviceClients: [serviceClient] },
    );
    const authProvider = new ClientCredentialsProvider({
      clientId: "flow",
      clientSecret: "correct horse battery staple",
      scope: "notes:read",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { authProvider },
    );
    const client = new Client({ name: "flow-integration-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "get_note_links",
        "list_note_changes",
        "list_notes",
        "list_vaults",
        "read_note",
        "search_notes",
      ]);
      expect(toolText(await client.callTool({
        name: "list_vaults",
        arguments: {},
      }))).toContain("brain");
      expect(toolText(await client.callTool({
        name: "search_notes",
        arguments: { query: "bridge" },
      }))).toContain("Connected.md");
      const changes = toolText(await client.callTool({
        name: "list_note_changes",
        arguments: { after: 0 },
      }));
      expect(changes).toContain("Connected.md");
      expect(changes).not.toContain("Secret.md");
      const changeSeq = (JSON.parse(changes) as { changes: Array<{ seq: number }> }).changes[0].seq;
      await writeFile(path.join(fx.rootOf("brain"), "Connected.md"), "# Connected\nchanged later");
      await fx.knowledge.initialize();
      const historical = toolText(await client.callTool({
        name: "read_note",
        arguments: { vault: "brain", path: "Connected.md", changeSeq },
      }));
      expect(historical).toContain("FLOW bridge proof");
      expect(historical).not.toContain("changed later");
      await expect(client.callTool({
        name: "create_inbox_note",
        arguments: { vault: "brain", title: "Blocked", content: "Blocked" },
      })).resolves.toMatchObject({ isError: true });
    } finally {
      await client.close();
      await runtime.close();
      await fx.cleanup();
    }
  });

  it("rejects a client using the wrong secret", async () => {
    delete process.env.MCP_NO_AUTH;
    delete process.env.MCP_PUBLIC_URL;
    process.env.MCP_JWT_SECRET = "test-jwt-secret-at-least-thirty-two-characters";
    const fx = await createKnowledgeFixture(["brain"]);
    await fx.knowledge.initialize();
    const serviceClient: ServiceClient = {
      clientId: "flow",
      secretHash: await hashServiceSecret("correct secret"),
      ownerId: "owner",
      scopes: ["notes:read"],
      allowedVaults: ["brain"],
      enabled: true,
    };
    const port = await freePort();
    const runtime = await startHttp(
      [{ id: "owner", passphrase: "owner-passphrase", knowledge: fx.knowledge }],
      { host: "127.0.0.1", port, serviceClients: [serviceClient] },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      {
        authProvider: new ClientCredentialsProvider({
          clientId: "flow",
          clientSecret: "wrong secret",
          scope: "notes:read",
        }),
      },
    );
    const client = new Client({ name: "flow-bad-secret-test", version: "1.0.0" });

    try {
      await expect(client.connect(transport)).rejects.toThrow();
    } finally {
      await client.close().catch(() => undefined);
      await runtime.close();
      await fx.cleanup();
    }
  });

  it("rate-limits forwarded client IPs independently behind the loopback proxy", async () => {
    delete process.env.MCP_NO_AUTH;
    delete process.env.MCP_PUBLIC_URL;
    process.env.MCP_JWT_SECRET = "test-jwt-secret-at-least-thirty-two-characters";
    const fx = await createKnowledgeFixture(["brain"]);
    await fx.knowledge.initialize();
    const port = await freePort();
    const runtime = await startHttp(
      [{ id: "owner", passphrase: "owner-passphrase", knowledge: fx.knowledge }],
      { host: "127.0.0.1", port, serviceClients: [] },
    );
    const tokenUrl = `http://127.0.0.1:${port}/token`;
    const attempt = (forwardedFor: string) => fetch(tokenUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("unknown:wrong").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": forwardedFor,
      },
      body: "grant_type=client_credentials&scope=notes%3Aread",
    });

    try {
      for (let index = 0; index < 10; index += 1) {
        expect((await attempt("198.51.100.10")).status).toBe(401);
      }
      expect((await attempt("198.51.100.10")).status).toBe(429);
      expect((await attempt("198.51.100.11")).status).toBe(401);
    } finally {
      await runtime.close();
      await fx.cleanup();
    }
  });
});
