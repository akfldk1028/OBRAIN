import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const passphraseFile = process.env.DEPLOY_OWNER_PASSPHRASE_FILE
  ?? "/root/brain-mcp-owner-passphrase.txt";
const organizerExpected = process.env.DEPLOY_EXPECT_ORGANIZER === "1";
const baseTools = [
  "create_inbox_note",
  "get_note_links",
  "list_notes",
  "list_vaults",
  "read_note",
  "search_notes",
];
const organizerTools = [
  "apply_organization",
  "audit_vault",
  "get_vault_policy",
  "list_inbox_notes",
  "organize_now",
  "propose_organization",
  "undo_organization",
];

if (!base.startsWith("https://")) {
  throw new Error("usage: node scripts/verify-deployment.mjs https://host");
}

const passphrase = (await readFile(passphraseFile, "utf8")).trim();
const ok = (message) => console.log(`ok - ${message}`);
const assert = (condition, message) => {
  if (!condition) throw new Error(`verification failed: ${message}`);
  ok(message);
};

const health = await fetch(`${base}/healthz`);
assert(health.status === 200 && (await health.text()) === "ok", "public HTTPS health check");

const unauthenticated = await fetch(`${base}/mcp`);
assert(unauthenticated.status === 401, "unauthenticated MCP requests are rejected");

const redirectUri = "http://127.0.0.1:45999/callback";
const registration = await fetch(`${base}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "deployment-verifier",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
assert(registration.status === 201, "dynamic client registration");
const registeredClient = await registration.json();

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authorizeUrl = new URL(`${base}/authorize`);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", registeredClient.client_id);
authorizeUrl.searchParams.set("redirect_uri", redirectUri);
authorizeUrl.searchParams.set("code_challenge", challenge);
authorizeUrl.searchParams.set("code_challenge_method", "S256");
authorizeUrl.searchParams.set("state", "deployment-verification");

const authorization = await fetch(authorizeUrl, { redirect: "manual" });
assert(authorization.status === 302, "OAuth authorization redirect");
const ticket = new URL(authorization.headers.get("location"), base).searchParams.get("ticket");

const login = await fetch(`${base}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ticket, passphrase }),
  redirect: "manual",
});
assert(login.status === 302, "owner login");
const callback = new URL(login.headers.get("location"));
const code = callback.searchParams.get("code");
assert(Boolean(code), "authorization code issuance");

const tokenResponse = await fetch(`${base}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: registeredClient.client_id,
  }),
});
assert(tokenResponse.status === 200, "PKCE token exchange");
const tokens = await tokenResponse.json();
assert(Boolean(tokens.access_token), "access token issuance");

const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
});
const client = new Client({ name: "deployment-verifier", version: "1.0.0" });
await client.connect(transport);

try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  const expected = (organizerExpected ? [...baseTools, ...organizerTools] : baseTools).sort();
  assert(
    names.join(",") === expected.join(","),
    organizerExpected
      ? "thirteen MCP tools including organizer are available"
      : "six safe MCP tools are available",
  );

  if (organizerExpected) {
    const policy = await client.callTool({
      name: "get_vault_policy",
      arguments: { vault: "brain" },
    });
    assert(!policy.isError, "get_vault_policy over public MCP");

    const audit = await client.callTool({
      name: "audit_vault",
      arguments: { vault: "brain" },
    });
    assert(!audit.isError, "audit_vault over public MCP");
  }

  const marker = `deploymentcheck${Date.now()}`;
  const created = await client.callTool({
    name: "create_inbox_note",
    arguments: {
      vault: "brain",
      title: "연결 테스트",
      content: `자동 배포 검증 메모입니다.\n\n${marker}`,
    },
  });
  assert(!created.isError, "create_inbox_note over public MCP");
  const createdNote = JSON.parse(created.content[0].text);

  const read = await client.callTool({
    name: "read_note",
    arguments: { vault: "brain", path: createdNote.path },
  });
  assert(!read.isError && read.content[0].text.includes(marker), "read_note round trip");

  const search = await client.callTool({
    name: "search_notes",
    arguments: { query: marker },
  });
  assert(!search.isError && search.content[0].text.includes(createdNote.path), "indexed search round trip");
  console.log(`created test note: ${createdNote.path}`);
} finally {
  await client.close();
}
