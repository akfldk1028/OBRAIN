import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseOrganizerArgs, runOrganizerCli, runOrganizerCliEntrypoint } from "../src/organizer-cli.js";
import { assembleRuntime } from "../src/runtime.js";
import { createKnowledgeMcpServer } from "../src/server-factory.js";
import { makeTempVaultSet } from "./helpers/temp-vaults.js";

const sixTools = [
  "create_inbox_note", "get_note_links", "list_notes", "list_vaults", "read_note", "search_notes",
];
const thirteenTools = [
  "apply_organization", "audit_vault", "create_inbox_note", "get_note_links",
  "get_vault_policy", "list_inbox_notes", "list_notes", "list_vaults",
  "organize_now", "propose_organization", "read_note", "search_notes", "undo_organization",
];

async function registeredToolNames(runtime: Awaited<ReturnType<typeof assembleRuntime>>) {
  const server = createKnowledgeMcpServer(runtime.knowledge);
  const client = new Client({ name: "runtime-organizer-tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

describe("parseOrganizerArgs", () => {
  it("parses a bounded dry-run command", () => {
    expect(parseOrganizerArgs(["run", "--vault", "brain", "--mode", "dry-run"])).toEqual({
      command: "run",
      vault: "brain",
      requestedMode: "dry-run",
    });
  });

  it("rejects an unsupported organizer mode", () => {
    expect(() => parseOrganizerArgs(["run", "--vault", "brain", "--mode", "automatic-now"])).toThrow();
  });

  it("requires an exact organizer transaction ID for undo", () => {
    expect(parseOrganizerArgs(["undo", "--vault", "brain", "--transaction-id", "ORG-test-123"])).toEqual({
      command: "undo",
      vault: "brain",
      transactionId: "ORG-test-123",
    });
    expect(() => parseOrganizerArgs(["undo", "--vault", "brain"])).toThrow();
  });
});

describe("assembleRuntime", () => {
  it("keeps a disabled organizer/provider independent of DashScope credentials", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    const configFile = path.join(fx.root, "config.json");
    await writeFile(configFile, JSON.stringify({
      dataDir: path.join(fx.root, "data"),
      owner: { id: "owner", passphrase: "a-long-test-passphrase", allowedVaults: ["brain"] },
      vaults: fx.vaults,
    }), { mode: 0o600 });

    try {
      const runtime = await assembleRuntime({ configFile, environment: { ORGANIZER_PROVIDER: "dashscope" } });
      try {
        expect(runtime.organizer).toBeUndefined();
        expect(runtime.knowledge.listVaults()).toEqual({ vaults: ["brain"] });
      } finally {
        await runtime.knowledge.close();
      }
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps a disabled organizer available to the CLI but out of MCP tools", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    const configFile = path.join(fx.root, "config.json");
    await writeFile(configFile, JSON.stringify({
      dataDir: path.join(fx.root, "data"),
      owner: { id: "owner", passphrase: "a-long-test-passphrase", allowedVaults: ["brain"] },
      vaults: fx.vaults,
      organizer: { enabledVaults: ["brain"], mode: "disabled" },
    }), { mode: 0o600 });

    try {
      const runtime = await assembleRuntime({ configFile, environment: { ORGANIZER_PROVIDER: "dashscope" } });
      try {
        expect(runtime.organizer).toBeDefined();
        expect(runtime.knowledge.hasOrganizer()).toBe(false);
        expect(await registeredToolNames(runtime)).toEqual(sixTools);
      } finally {
        await runtime.close();
      }
    } finally {
      await fx.cleanup();
    }
  });

  it("exposes organizer MCP tools for a real enabled organizer configuration", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    const configFile = path.join(fx.root, "config.json");
    await writeFile(configFile, JSON.stringify({
      dataDir: path.join(fx.root, "data"),
      owner: { id: "owner", passphrase: "a-long-test-passphrase", allowedVaults: ["brain"] },
      vaults: fx.vaults,
      organizer: { enabledVaults: ["brain"], mode: "dry-run" },
    }), { mode: 0o600 });

    try {
      const runtime = await assembleRuntime({ configFile, environment: {} });
      try {
        expect(runtime.organizer).toBeDefined();
        expect(runtime.knowledge.hasOrganizer()).toBe(true);
        expect(await registeredToolNames(runtime)).toEqual(thirteenTools);
      } finally {
        await runtime.close();
      }
    } finally {
      await fx.cleanup();
    }
  });
});

describe("runOrganizerCli", () => {
  it("emits one fixed safe JSON error from the entrypoint without console leakage", async () => {
    const output: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(runOrganizerCliEntrypoint(["run", "--vault", "brain", "--mode", "synthetic-secret"], {}, (line) => output.push(line))).resolves.toBe(1);
      expect(output).toEqual([JSON.stringify({ status: "error", code: "organizer_cli_failed" })]);
      expect(JSON.stringify(output)).not.toContain("synthetic-secret");
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("runs an audit without a provider or HTTP listener and prints a redacted JSON report", async () => {
    const fx = await makeTempVaultSet(["brain"]);
    const configFile = path.join(fx.root, "config.json");
    await writeFile(configFile, JSON.stringify({
      dataDir: path.join(fx.root, "data"),
      owner: { id: "owner", passphrase: "a-long-test-passphrase", allowedVaults: ["brain"] },
      vaults: fx.vaults,
      organizer: { enabledVaults: ["brain"], mode: "disabled" },
    }), { mode: 0o600 });
    const output: string[] = [];

    try {
      await runOrganizerCli(["audit", "--vault", "brain"], { MCP_CONFIG_FILE: configFile, ORGANIZER_PROVIDER: "dashscope" }, (line) => output.push(line));
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0]!)).toMatchObject({ vault: "brain", findings: expect.any(Array) });
      expect(output[0]).not.toContain("DASHSCOPE_API_KEY");
    } finally {
      await fx.cleanup();
    }
  });
});
