import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

export type ServiceClient = {
  clientId: string;
  secretHash: string;
  ownerId: string;
  scopes: ["notes:read"];
  allowedVaults: string[];
  enabled: boolean;
};

const serviceClientSchema = z.object({
  clientId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  secretHash: z.string().min(1),
  ownerId: z.string().min(1).max(128),
  scopes: z.tuple([z.literal("notes:read")]),
  allowedVaults: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).min(1).max(64),
  enabled: z.boolean(),
}).strict();

const serviceClientsFileSchema = z.object({
  clients: z.array(serviceClientSchema).max(128),
}).strict();

export async function hashServiceSecret(secret: string): Promise<string> {
  if (!secret) throw new Error("Service secret must not be empty");
  const salt = randomBytes(16);
  const key = await derive(secret, salt);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyServiceSecret(
  client: ServiceClient,
  candidate: string,
): Promise<boolean> {
  const parsed = parseSecretHash(client.secretHash);
  const actual = await derive(candidate, parsed.salt);
  return actual.length === parsed.key.length && timingSafeEqual(actual, parsed.key);
}

export async function loadServiceClients(
  file: string,
  knownVaults: string[],
  knownOwners: string[],
): Promise<ServiceClient[]> {
  const fileStat = await stat(file);
  if (process.platform !== "win32") {
    const permissions = fileStat.mode & 0o777;
    if (permissions !== 0o600 && permissions !== 0o640) {
      throw new Error("Service client file must have mode 0600 or 0640");
    }
  }
  const parsed = serviceClientsFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const vaults = new Set(knownVaults);
  const owners = new Set(knownOwners);
  const ids = new Set<string>();

  for (const client of parsed.clients) {
    if (ids.has(client.clientId)) throw new Error(`Duplicate service client id: ${client.clientId}`);
    ids.add(client.clientId);
    if (!owners.has(client.ownerId)) throw new Error(`Unknown service client owner: ${client.ownerId}`);
    if (new Set(client.allowedVaults).size !== client.allowedVaults.length) {
      throw new Error(`Duplicate Vault in service client: ${client.clientId}`);
    }
    for (const vault of client.allowedVaults) {
      if (!vaults.has(vault)) throw new Error(`Unknown service client Vault: ${vault}`);
    }
    parseSecretHash(client.secretHash);
  }

  return parsed.clients;
}

function parseSecretHash(encoded: string): { salt: Buffer; key: Buffer } {
  const [algorithm, n, r, p, saltValue, keyValue, extra] = encoded.split("$");
  if (
    extra !== undefined
    || algorithm !== "scrypt"
    || n !== String(SCRYPT_N)
    || r !== String(SCRYPT_R)
    || p !== String(SCRYPT_P)
    || !saltValue
    || !keyValue
  ) {
    throw new Error("Unsupported service secret hash");
  }
  const salt = Buffer.from(saltValue, "base64url");
  const key = Buffer.from(keyValue, "base64url");
  if (salt.length !== 16 || key.length !== KEY_LENGTH) {
    throw new Error("Malformed service secret hash");
  }
  return { salt, key };
}

function derive(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: MAX_MEMORY,
    }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
