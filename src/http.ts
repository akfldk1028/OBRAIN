import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import path from "node:path";
import express, { type RequestHandler } from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createOAuthMetadata,
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { KnowledgeBase } from "./knowledge-base.js";
import { createKnowledgeMcpServer } from "./server-factory.js";
import { LoginError, VaultOAuthProvider } from "./oauth-provider.js";
import type { KnowledgeAccessPolicy } from "./knowledge-view.js";
import {
  loadServiceClients,
  type ServiceClient,
  verifyServiceSecret,
} from "./service-clients.js";

/** One HTTP owner whose knowledge base can contain multiple vaults. */
export interface HttpUser {
  id: string;
  passphrase: string;
  knowledge: KnowledgeBase;
}

export interface HttpOptions {
  port: number;
  host: string;
  serviceClients?: ServiceClient[];
}

export interface HttpRuntime {
  server: Server;
  close(): Promise<void>;
}

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  error: { code, message },
  id: null,
});

function parseBasicCredentials(
  header: string | undefined,
): { clientId: string; secret: string } | undefined {
  if (!header?.toLowerCase().startsWith("basic ")) return undefined;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 1) return undefined;
    return {
      clientId: decoded.slice(0, separator),
      secret: decoded.slice(separator + 1),
    };
  } catch {
    return undefined;
  }
}

/**
 * Serve one or more vaults over Streamable HTTP (for Claude's remote connectors,
 * incl. the mobile app), guarded by a self-hosted OAuth 2.1 layer.
 *
 * Each user logs in with their own passphrase; the issued token carries their id
 * and every /mcp request is routed to that user's vault. With a single user this
 * is just a one-vault server.
 *
 * Auth is on by default. Set MCP_NO_AUTH=1 to disable it — for LOCAL testing
 * only; it serves the first user's vault to everyone with no login.
 */
export async function startHttp(users: HttpUser[], opts: HttpOptions): Promise<HttpRuntime> {
  if (!users.length) throw new Error("startHttp requires at least one user");

  const authEnabled = process.env.MCP_NO_AUTH !== "1";
  const publicUrl = (process.env.MCP_PUBLIC_URL ?? `http://${opts.host}:${opts.port}`).replace(
    /\/+$/,
    "",
  );
  const resourceUrl = `${publicUrl}/mcp`;

  const knowledgeByUser = new Map(users.map((user) => [user.id, user.knowledge]));
  const defaultKnowledge = users[0].knowledge;
  const ownerIds = users.map((user) => user.id);
  const knownVaults = [...new Set(users.flatMap((user) => user.knowledge.listVaults().vaults))];
  const serviceClients = opts.serviceClients ?? (
    process.env.MCP_SERVICE_CLIENTS_FILE
      ? await loadServiceClients(process.env.MCP_SERVICE_CLIENTS_FILE, knownVaults, ownerIds)
      : []
  );
  for (const client of serviceClients) {
    const knowledge = knowledgeByUser.get(client.ownerId);
    const ownerVaults = new Set(knowledge?.listVaults().vaults ?? []);
    if (!knowledge || client.allowedVaults.some((vault) => !ownerVaults.has(vault))) {
      throw new Error(`Service client ${client.clientId} has an invalid owner or Vault assignment`);
    }
  }

  const app = express();
  app.disable("x-powered-by");

  app.use(
    cors({
      exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
      allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id", "MCP-Protocol-Version"],
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.type("text").send("ok");
  });

  let bearer: RequestHandler | undefined;
  const failedLogins = new Map<string, { count: number; resetAt: number }>();
  const failedServiceAuth = new Map<string, { count: number; resetAt: number }>();
  const loginWindowMs = 15 * 60 * 1000;

  if (authEnabled) {
    const jwtSecret = process.env.MCP_JWT_SECRET;
    if (!jwtSecret) {
      throw new Error(
        "HTTP mode requires MCP_JWT_SECRET (or set MCP_NO_AUTH=1 for local testing only).",
      );
    }
    const provider = new VaultOAuthProvider({
      issuer: publicUrl,
      resource: resourceUrl,
      users: users.map((u) => ({ id: u.id, passphrase: u.passphrase })),
      jwtSecret,
      clientsFile:
        process.env.MCP_CLIENTS_FILE ??
        path.join(path.dirname(new URL(import.meta.url).pathname), "oauth-clients.json"),
      serviceClients,
    });

    const authRouterOptions = {
      provider,
      issuerUrl: new URL(publicUrl),
      resourceServerUrl: new URL(resourceUrl),
      scopesSupported: ["notes:read"],
    };
    const metadata = createOAuthMetadata(authRouterOptions);
    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
      res.json({
        ...metadata,
        grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
        token_endpoint_auth_methods_supported: [
          "client_secret_post",
          "none",
          "client_secret_basic",
        ],
        scopes_supported: ["notes:read"],
      });
    });
    app.post(
      "/token",
      express.urlencoded({ extended: false, limit: "16kb" }),
      async (req, res, next) => {
        if (req.body.grant_type !== "client_credentials") {
          next();
          return;
        }
        const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
        const now = Date.now();
        const existing = failedServiceAuth.get(key);
        const attempt = existing && existing.resetAt > now
          ? existing
          : { count: 0, resetAt: now + loginWindowMs };
        if (attempt.count >= 10) {
          res.status(429).json({ error: "temporarily_unavailable" });
          return;
        }
        const credentials = parseBasicCredentials(req.get("authorization"));
        const client = credentials
          ? serviceClients.find((candidate) => candidate.clientId === credentials.clientId)
          : undefined;
        let validIdentity = false;
        if (client?.enabled && credentials) {
          try {
            validIdentity = await verifyServiceSecret(client, credentials.secret);
          } catch {
            validIdentity = false;
          }
        }
        if (!validIdentity || !client) {
          attempt.count += 1;
          failedServiceAuth.set(key, attempt);
          res
            .status(401)
            .set("WWW-Authenticate", 'Basic realm="token"')
            .json({ error: "invalid_client" });
          return;
        }
        const requestedScopes = String(req.body.scope ?? "")
          .split(/\s+/)
          .filter(Boolean);
        if (requestedScopes.some((scope) => scope !== "notes:read")) {
          res.status(400).json({ error: "invalid_scope" });
          return;
        }
        try {
          const tokens = await provider.issueServiceAccessToken({ client, requestedScopes });
          failedServiceAuth.delete(key);
          res.set("Cache-Control", "no-store").set("Pragma", "no-cache").json(tokens);
        } catch {
          res.status(400).json({ error: "invalid_scope" });
        }
      },
    );
    app.use(
      mcpAuthRouter(authRouterOptions),
    );

    app.get("/login", (req, res) => {
      const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
      res.type("html").send(provider.renderLoginPage(ticket));
    });
    app.post("/login", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
      const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      const existing = failedLogins.get(key);
      const attempt = existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + loginWindowMs };
      if (attempt.count >= 10) {
        res.status(429).type("text").send("Too many failed sign-in attempts. Try again later.");
        return;
      }
      const ticket = String(req.body.ticket ?? "");
      const passphraseInput = String(req.body.passphrase ?? "");
      try {
        const { redirectTo } = provider.submitLogin(ticket, passphraseInput);
        failedLogins.delete(key);
        res.redirect(302, redirectTo);
      } catch (e) {
        attempt.count += 1;
        failedLogins.set(key, attempt);
        const msg = e instanceof LoginError ? e.message : "Sign-in failed.";
        res.status(401).type("html").send(provider.renderLoginPage(ticket, msg));
      }
    });

    bearer = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resourceUrl)),
    });
  }

  // ---- the MCP endpoint (session-managed Streamable HTTP) ----------------
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionPrincipals: Record<string, string> = {}; // sessionId -> principalId
  const guard: RequestHandler[] = bearer ? [bearer] : [];

  // Identify the user for a request (from the verified token, or "default" without auth).
  const userIdOf = (req: express.Request): string =>
    authEnabled ? String((req.auth?.extra?.userId as string | undefined) ?? "") : "default";
  const principalIdOf = (req: express.Request): string => authEnabled
    ? String((req.auth?.extra?.principalId as string | undefined) ?? userIdOf(req))
    : "default";
  const policyOf = (req: express.Request): KnowledgeAccessPolicy | undefined =>
    authEnabled ? req.auth?.extra?.policy as KnowledgeAccessPolicy | undefined : undefined;

  app.post("/mcp", ...guard, express.json({ limit: "1mb" }), async (req, res) => {
    const userId = userIdOf(req);
    const principalId = principalIdOf(req);
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? transports[sid] : undefined;

    if (transport) {
      // Guard against a session id being reused with a different user's token.
      if (sessionPrincipals[sid!] !== principalId) {
        res.status(403).json(jsonRpcError(-32000, "Session does not belong to this user"));
        return;
      }
    } else {
      if (sid) {
        res.status(404).json(jsonRpcError(-32000, "Unknown or expired session id"));
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.status(400).json(jsonRpcError(-32000, "No session id and not an initialize request"));
        return;
      }
      const knowledge = authEnabled ? knowledgeByUser.get(userId) : defaultKnowledge;
      if (!knowledge) {
        res.status(403).json(jsonRpcError(-32000, "No knowledge base configured for this user"));
        return;
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSid: string) => {
          transports[newSid] = created;
          sessionPrincipals[newSid] = principalId;
        },
      });
      created.onclose = () => {
        if (created.sessionId) {
          delete transports[created.sessionId];
          delete sessionPrincipals[created.sessionId];
        }
      };
      const server = createKnowledgeMcpServer(knowledge, policyOf(req));
      await server.connect(created);
      transport = created;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const streamOrDelete: RequestHandler = async (req, res) => {
    const principalId = principalIdOf(req);
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? transports[sid] : undefined;
    if (!transport) {
      res.status(400).json(jsonRpcError(-32000, "Missing or unknown mcp-session-id"));
      return;
    }
    if (sessionPrincipals[sid!] !== principalId) {
      res.status(403).json(jsonRpcError(-32000, "Session does not belong to this user"));
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get("/mcp", ...guard, streamOrDelete);
  app.delete("/mcp", ...guard, streamOrDelete);

  const httpServer = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(opts.port, opts.host, () => resolve(listening));
    listening.once("error", reject);
  });
  httpServer.requestTimeout = 0;

  console.error(
    `[obsidian-multivault-mcp] HTTP serving on http://${opts.host}:${opts.port}/mcp` +
      ` (public ${resourceUrl}) — owners: ${users.map((user) => user.id).join(", ")}` +
      (authEnabled ? "" : " — AUTH DISABLED"),
  );

  return {
    server: httpServer,
    async close() {
      await Promise.all(Object.values(transports).map(async (transport) => transport.close()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
