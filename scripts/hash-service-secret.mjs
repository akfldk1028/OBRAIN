#!/usr/bin/env node
import { hashServiceSecret } from "../dist/service-clients.js";

const secret = process.env.MCP_SERVICE_CLIENT_SECRET ?? "";
if (secret.length < 32) {
  console.error("MCP_SERVICE_CLIENT_SECRET must contain at least 32 characters");
  process.exitCode = 1;
} else {
  console.log(await hashServiceSecret(secret));
}
