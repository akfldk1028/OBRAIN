import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { VaultOAuthProvider } from "../src/oauth-provider.js";
import { hashServiceSecret, type ServiceClient } from "../src/service-clients.js";

const issuer = "https://brain.example.test";
const resource = `${issuer}/mcp`;
const jwtSecret = "test-jwt-secret-at-least-thirty-two-characters";

async function makeClient(): Promise<ServiceClient> {
  return {
    clientId: "flow",
    secretHash: await hashServiceSecret("service-secret"),
    ownerId: "owner",
    scopes: ["notes:read"],
    allowedVaults: ["brain"],
    enabled: true,
  };
}

function makeProvider(serviceClients: ServiceClient[]) {
  return new VaultOAuthProvider({
    issuer,
    resource,
    users: [{ id: "owner", passphrase: "owner-passphrase" }],
    jwtSecret,
    clientsFile: "does-not-exist-in-tests.json",
    serviceClients,
  });
}

describe("service access tokens", () => {
  it("issues a one-hour read-only token with a Vault-scoped principal", async () => {
    const serviceClient = await makeClient();
    const provider = makeProvider([serviceClient]);
    const before = Math.floor(Date.now() / 1000);

    const tokens = await provider.issueServiceAccessToken({
      client: serviceClient,
      requestedScopes: ["notes:read"],
    });
    const auth = await provider.verifyAccessToken(tokens.access_token);

    expect(tokens.refresh_token).toBeUndefined();
    expect(tokens.expires_in).toBe(3600);
    expect(auth.clientId).toBe("flow");
    expect(auth.scopes).toEqual(["notes:read"]);
    expect(auth.expiresAt).toBeGreaterThan(before);
    expect(auth.expiresAt).toBeLessThanOrEqual(before + 3600);
    expect(auth.extra).toMatchObject({
      userId: "owner",
      principalId: "service:flow",
      allowedVaults: ["brain"],
      policy: {
        allowedVaults: ["brain"],
        inboxWrite: false,
        changeFeed: true,
        organizer: false,
      },
    });
  });

  it("rejects a wrong audience and a service client disabled after issue", async () => {
    const serviceClient = await makeClient();
    const provider = makeProvider([serviceClient]);
    const wrongAudience = await new SignJWT({
      typ: "service",
      client_id: "flow",
      scopes: ["notes:read"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("service:flow")
      .setIssuer(issuer)
      .setAudience("https://wrong.example.test/mcp")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(jwtSecret));
    await expect(provider.verifyAccessToken(wrongAudience)).rejects.toThrow();

    const tokens = await provider.issueServiceAccessToken({
      client: serviceClient,
      requestedScopes: ["notes:read"],
    });
    serviceClient.enabled = false;
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it("refuses non-read scopes during token issue", async () => {
    const serviceClient = await makeClient();
    const provider = makeProvider([serviceClient]);

    await expect(provider.issueServiceAccessToken({
      client: serviceClient,
      requestedScopes: ["notes:write"],
    })).rejects.toThrow();
  });
});
