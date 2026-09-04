import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startHttp } from "../src/http.js";
import { prepareOrganizerStatePaths } from "../src/organizer/state-paths.js";
import type { OrganizerServiceApi } from "../src/organizer/types.js";
import { createKnowledgeFixture } from "./helpers/knowledge-fixture.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    rmSync(cleanupPath, { force: true, recursive: true });
  }
});

type UnitFile = Map<string, Map<string, string[]>>;

function parseUnitFile(source: string): UnitFile {
  const unit: UnitFile = new Map();
  let section: Map<string, string[]> | undefined;

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch) {
      section = new Map();
      unit.set(sectionMatch[1]!, section);
      continue;
    }

    const separator = line.indexOf("=");
    if (!section || separator < 1) throw new Error(`Invalid systemd unit line: ${line}`);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    section.set(key, [...(section.get(key) ?? []), value]);
  }

  return unit;
}

function directive(unit: UnitFile, section: string, key: string): string[] {
  return unit.get(section)?.get(key) ?? [];
}

function words(value: string): string[] {
  return value.trim().split(/\s+/u).filter(Boolean);
}

function parseEnvironmentFile(source: string): Map<string, string> {
  const environment = new Map<string, string>();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Invalid environment line: ${line}`);
    environment.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return environment;
}

function bashPath(filePath: string): string {
  return process.platform === "win32"
    ? filePath.replace(/^([A-Za-z]):/u, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/")
    : filePath;
}

function executable(name: string, contents: string, directory: string): void {
  const filePath = join(directory, name);
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function logicalShellLines(source: string): string[] {
  const lines: string[] = [];
  let continued = "";
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.endsWith("\\")) {
      continued += `${line.slice(0, -1).trim()} `;
      continue;
    }
    lines.push(`${continued}${line}`.trim());
    continued = "";
  }
  if (continued) throw new Error("unterminated shell continuation");
  return lines;
}

function markdownShellBlocks(source: string): string[] {
  return [...source.matchAll(/^```bash[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gmu)]
    .map((match) => match[1]!);
}

function markdownShellBlock(source: string, marker: string): string[] {
  const block = markdownShellBlocks(source).find((candidate) => candidate.includes(marker));
  if (!block) throw new Error(`missing Markdown shell block containing: ${marker}`);
  return logicalShellLines(block);
}

function commandPosition(lines: string[], fragment: string): number {
  const index = lines.findIndex((line) => line.includes(fragment));
  if (index < 0) throw new Error(`missing command fragment: ${fragment}`);
  return index;
}

function shellWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)]
    .map((match) => match[1] ?? match[2] ?? match[3]!);
}

function commands(lines: string[], name: string): string[][] {
  return lines.map(shellWords).filter((tokens) => tokens[0] === name);
}

function conditionalBranches(lines: string[], opening: string): { whenTrue: string[]; whenFalse: string[] } {
  const start = lines.indexOf(opening);
  if (start < 0) throw new Error(`missing conditional: ${opening}`);
  const whenTrue: string[] = [];
  const whenFalse: string[] = [];
  let branch = whenTrue;
  let depth = 1;
  for (const line of lines.slice(start + 1)) {
    if (/^if\b.*;\s*then$/u.test(line)) depth += 1;
    if (line === "fi") {
      depth -= 1;
      if (depth === 0) return { whenTrue, whenFalse };
    }
    if (depth === 1 && line === "else") {
      branch = whenFalse;
      continue;
    }
    if (depth === 1) branch.push(line);
  }
  throw new Error(`unterminated conditional: ${opening}`);
}

function conditionalArm(lines: string[], opening: string): string[] {
  const start = lines.indexOf(opening);
  if (start < 0) throw new Error(`missing conditional arm: ${opening}`);
  const arm: string[] = [];
  let depth = 1;
  for (const line of lines.slice(start + 1)) {
    if (/^if\b.*;\s*then$/u.test(line)) depth += 1;
    if (line === "fi") {
      depth -= 1;
      if (depth === 0) return arm;
    }
    if (depth === 1 && (/^elif\b.*;\s*then$/u.test(line) || line === "else")) return arm;
    if (depth === 1) arm.push(line);
  }
  throw new Error(`unterminated conditional arm: ${opening}`);
}

function jsonAssignment(source: string, name: string): unknown {
  const match = new RegExp(`^${name}='([^']+)'$`, "mu").exec(source);
  if (!match) throw new Error(`missing JSON assignment: ${name}`);
  return JSON.parse(match[1]!);
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate verifier test port");
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  return address.port;
}

function organizerRecorder(calls: string[]): OrganizerServiceApi {
  const unexpected = (name: string): never => {
    calls.push(name);
    throw new Error(`deployment verifier called forbidden organizer operation: ${name}`);
  };
  return {
    async getPolicy(vault) {
      calls.push(`get_vault_policy:${vault}`);
      return {
        version: "test-policy-v1",
        readingOrder: ["000_AI_WORK_GUIDE.md", "000_Home_MOC.md"],
        approvedAreas: ["60_Tools"],
        maxDepth: 5,
        mode: "dry-run",
      };
    },
    async audit({ vault }) {
      calls.push(`audit_vault:${vault}`);
      return { vault, checkedAt: "2026-09-04T00:00:00.000Z", findings: [] };
    },
    async listInbox() { return unexpected("list_inbox_notes"); },
    async propose() { return unexpected("propose_organization"); },
    async apply() { return unexpected("apply_organization"); },
    async undo() { return unexpected("undo_organization"); },
    async startRun() { return unexpected("organize_now"); },
  };
}

async function runDeploymentVerifier(options: {
  organizer?: OrganizerServiceApi;
  expectOrganizer?: boolean;
} = {}): Promise<string[]> {
  const environmentKeys = [
    "DEPLOY_OWNER_PASSPHRASE_FILE",
    "DEPLOY_EXPECT_ORGANIZER",
    "MCP_NO_AUTH",
    "MCP_PUBLIC_URL",
    "MCP_JWT_SECRET",
    "MCP_CLIENTS_FILE",
  ] as const;
  const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const previousArgv = process.argv;
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const logs: string[] = [];
  const fx = await createKnowledgeFixture(["brain"], options.organizer);
  let runtime: Awaited<ReturnType<typeof startHttp>> | undefined;

  try {
    await fx.knowledge.initialize();
    const port = await freePort();
    const publicBase = `https://127.0.0.1:${port}`;
    const localBase = `http://127.0.0.1:${port}`;
    const passphrase = "deployment-verifier-test-passphrase";
    const passphraseFile = join(fx.rootOf("brain"), "verifier-passphrase.txt");
    writeFileSync(passphraseFile, passphrase, "utf8");

    delete process.env.MCP_NO_AUTH;
    process.env.MCP_PUBLIC_URL = publicBase;
    process.env.MCP_JWT_SECRET = "a".repeat(64);
    process.env.MCP_CLIENTS_FILE = resolve(fx.rootOf("brain"), "..", "oauth-clients.json");
    process.env.DEPLOY_OWNER_PASSPHRASE_FILE = passphraseFile;
    if (options.expectOrganizer) process.env.DEPLOY_EXPECT_ORGANIZER = "1";
    else delete process.env.DEPLOY_EXPECT_ORGANIZER;

    runtime = await startHttp(
      [{ id: "owner", passphrase, knowledge: fx.knowledge }],
      { host: "127.0.0.1", port },
    );

    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const requested = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (!requested.startsWith(publicBase)) return previousFetch(input, init);
      const rewritten = `${localBase}${requested.slice(publicBase.length)}`;
      const rewrittenInput = input instanceof Request ? new Request(rewritten, input) : rewritten;
      return previousFetch(rewrittenInput, init);
    }) as typeof fetch;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    process.argv = [process.execPath, resolve("scripts/verify-deployment.mjs"), publicBase];

    const verifierUrl = `${pathToFileURL(resolve("scripts/verify-deployment.mjs")).href}?test=${randomUUID()}`;
    await import(verifierUrl);
    return logs;
  } finally {
    process.argv = previousArgv;
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (runtime) await runtime.close();
    await fx.cleanup();
  }
}

describe("organizer deployment units", () => {
  it("runs the organizer once as brain inside the intended sandbox", async () => {
    const service = parseUnitFile(await readFile("deploy/brain-organizer.service", "utf8"));

    expect(directive(service, "Unit", "After").flatMap(words).sort()).toEqual([
      "brain-mcp.service",
      "brain-syncthing.service",
      "network-online.target",
    ]);
    expect(directive(service, "Unit", "Wants").flatMap(words)).toEqual(["network-online.target"]);
    expect(directive(service, "Service", "Type")).toEqual(["oneshot"]);
    expect(directive(service, "Service", "User")).toEqual(["brain"]);
    expect(directive(service, "Service", "Group")).toEqual(["brain"]);
    expect(directive(service, "Service", "WorkingDirectory")).toEqual(["/opt/brain-mcp"]);
    expect(directive(service, "Service", "EnvironmentFile")).toEqual([
      "/etc/brain-mcp.env",
      "/etc/brain-organizer.env",
    ]);
    expect(directive(service, "Service", "Environment")).toEqual([
      "NODE_OPTIONS=--max-old-space-size=256",
    ]);

    const command = directive(service, "Service", "ExecStart").flatMap(words);
    expect(command).toEqual([
      "/usr/bin/node",
      "/opt/brain-mcp/dist/organizer-cli.js",
      "run",
      "--vault",
      "brain",
    ]);
    expect(command).not.toContain("--http");

    expect(directive(service, "Service", "ReadWritePaths").flatMap(words)).toEqual([
      "/srv/brain/data",
      "/srv/brain/vaults/brain",
    ]);
    expect(Object.fromEntries([
      "UMask",
      "NoNewPrivileges",
      "PrivateTmp",
      "ProtectHome",
      "ProtectSystem",
      "ProtectKernelTunables",
      "ProtectKernelModules",
      "ProtectControlGroups",
      "RestrictSUIDSGID",
      "MemoryMax",
      "TasksMax",
      "TimeoutStartSec",
    ].map((key) => [key, directive(service, "Service", key)]))).toEqual({
      UMask: ["0077"],
      NoNewPrivileges: ["true"],
      PrivateTmp: ["true"],
      ProtectHome: ["true"],
      ProtectSystem: ["strict"],
      ProtectKernelTunables: ["true"],
      ProtectKernelModules: ["true"],
      ProtectControlGroups: ["true"],
      RestrictSUIDSGID: ["true"],
      MemoryMax: ["384M"],
      TasksMax: ["64"],
      TimeoutStartSec: ["10min"],
    });
  });

  it("schedules the organizer daily at 18:00 UTC and catches missed runs", async () => {
    const timer = parseUnitFile(await readFile("deploy/brain-organizer.timer", "utf8"));

    expect(directive(timer, "Timer", "OnCalendar")).toEqual(["*-*-* 18:00:00 UTC"]);
    expect(directive(timer, "Timer", "Persistent")).toEqual(["true"]);
    expect(directive(timer, "Timer", "RandomizedDelaySec")).toEqual(["5m"]);
    expect(directive(timer, "Timer", "Unit")).toEqual(["brain-organizer.service"]);
    expect(directive(timer, "Install", "WantedBy")).toEqual(["timers.target"]);
  });

  it("ships disabled provider defaults and shares provider settings with MCP only when present", async () => {
    const example = parseEnvironmentFile(await readFile("deploy/brain-organizer.env.example", "utf8"));
    const mcpService = parseUnitFile(await readFile("deploy/brain-mcp.service", "utf8"));

    expect(Object.fromEntries(example)).toEqual({
      ORGANIZER_PROVIDER: "disabled",
      DASHSCOPE_BASE_URL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      DASHSCOPE_MODEL: "qwen-plus",
    });
    expect(example.has("DASHSCOPE_API_KEY")).toBe(false);
    expect(directive(mcpService, "Service", "EnvironmentFile")).toEqual([
      "/etc/brain-mcp.env",
      "-/etc/brain-organizer.env",
    ]);
  });

  it("verifies the exact six-tool public surface by default", async () => {
    const logs = await runDeploymentVerifier();
    expect(logs).toContain("ok - six safe MCP tools are available");
    expect(logs).toContain("ok - indexed search round trip");
  });

  it("rejects the thirteen-tool organizer surface unless explicitly expected", async () => {
    await expect(runDeploymentVerifier({ organizer: organizerRecorder([]) })).rejects.toThrow(
      "verification failed: six safe MCP tools are available",
    );
  });

  it("verifies exactly thirteen tools while invoking only non-mutating organizer operations", async () => {
    const organizerCalls: string[] = [];
    const logs = await runDeploymentVerifier({
      organizer: organizerRecorder(organizerCalls),
      expectOrganizer: true,
    });

    expect(logs).toContain("ok - thirteen MCP tools including organizer are available");
    expect(logs).toContain("ok - get_vault_policy over public MCP");
    expect(logs).toContain("ok - audit_vault over public MCP");
    expect(organizerCalls).toEqual(["get_vault_policy:brain", "audit_vault:brain"]);
  });

  it("rejects the six-tool surface when organizer tools are explicitly expected", async () => {
    await expect(runDeploymentVerifier({ expectOrganizer: true })).rejects.toThrow(
      "verification failed: thirteen MCP tools including organizer are available",
    );
  });

  it.each(["deploy/README.md", "DEPLOY.md"])(
    "stops and confirms the organizer inactive before emergency provider disable in %s",
    async (documentPath) => {
      const document = await readFile(documentPath, "utf8");
      const lines = markdownShellBlock(document, "sudoedit /etc/brain-organizer.env");
      const stop = commandPosition(lines, "systemctl stop");
      const inactive = commandPosition(lines, "ActiveState --value brain-organizer.service");
      const edit = commandPosition(lines, "sudoedit /etc/brain-organizer.env");
      const disabled = commandPosition(lines, "ORGANIZER_PROVIDER=disabled");
      const restart = commandPosition(lines, "systemctl restart brain-mcp");
      const stopWords = shellWords(lines[stop]!);

      expect(stopWords).toEqual(expect.arrayContaining([
        "brain-organizer.timer",
        "brain-organizer.service",
      ]));
      expect([stop, inactive, edit, disabled, restart]).toEqual(
        [...[stop, inactive, edit, disabled, restart]].sort((left, right) => left - right),
      );
      expect(lines.some((line) => /systemctl (?:start|restart).*brain-organizer\.(?:timer|service)/u.test(line))).toBe(false);
    },
  );

  it.each(["deploy/README.md", "DEPLOY.md"])(
    "stops and confirms the organizer inactive before backup and guarded undo in %s",
    async (documentPath) => {
      const document = await readFile(documentPath, "utf8");
      const lines = markdownShellBlock(document, "ORG-EXAMPLE-IDENTIFIER");
      const stop = commandPosition(lines, "systemctl stop");
      const inactive = commandPosition(lines, "ActiveState --value brain-organizer.service");
      const backup = commandPosition(lines, "/usr/local/sbin/brain-mcp-backup");
      const undo = commandPosition(lines, " undo --vault brain");
      const audit = commandPosition(lines, " audit --vault brain");
      const cleanAudit = commandPosition(lines, ".findings | length == 0");
      const restart = commandPosition(lines, "systemctl start brain-syncthing brain-mcp");
      const stopWords = shellWords(lines[stop]!);

      expect(stopWords).toEqual(expect.arrayContaining([
        "brain-organizer.timer",
        "brain-organizer.service",
        "brain-mcp",
        "brain-syncthing",
      ]));
      expect([stop, inactive, backup, undo, audit, cleanAudit, restart]).toEqual(
        [...[stop, inactive, backup, undo, audit, cleanAudit, restart]].sort((left, right) => left - right),
      );
      expect(lines.some((line) => /systemctl (?:start|restart).*brain-organizer\.(?:timer|service)/u.test(line))).toBe(false);
    },
  );

  it("documents current organizer reports and transaction state without treating legacy recovery as live", async () => {
    const document = await readFile("DEPLOY.md", "utf8");
    expect(document).toContain("60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports/<run-id>.md");
    expect(document).toContain("<dataDir>/organizer/transactions/<transaction-id>/");
    expect(document).toMatch(/`<dataDir>\/organizer-recovery`[^\n]*legacy migration source/u);
    expect(document).not.toContain("90_Auto_Organizer_Reports/<run-id>.json");
    expect(document).not.toContain("<dataDir>/organizer-recovery/<transaction-id>/");
  });

  it.each(["deploy/README.md", "DEPLOY.md"])(
    "documents enabled-but-not-started timer state without a catch-up start command in %s",
    async (documentPath) => {
      const document = await readFile(documentPath, "utf8");
      const shellLines = markdownShellBlocks(document).flatMap(logicalShellLines);
      expect(shellLines.some((line) => line.includes("systemctl is-enabled brain-organizer.timer"))).toBe(true);
      expect(shellLines.some((line) => line.includes("ActiveState --value brain-organizer.timer"))).toBe(true);
      expect(document).toContain("inactive (dead)");
      expect(shellLines.some((line) => /systemctl (?:enable --now|start|restart).*brain-organizer\.timer/u.test(line))).toBe(false);
    },
  );

  it("installs organizer state and units while preserving an existing provider environment", async () => {
    const source = await readFile("deploy/install.sh", "utf8");
    const lines = logicalShellLines(source);
    const installCommands = commands(lines, "install");

    expect(installCommands).toContainEqual([
      "install", "-d", "-o", "brain", "-g", "brain", "-m", "0700",
      "/srv/brain/data/organizer",
    ]);
    expect(installCommands.some((tokens) => tokens.includes("/srv/brain/data/organizer/transactions"))).toBe(false);
    expect(installCommands).toContainEqual([
      "install", "-o", "root", "-g", "root", "-m", "0644",
      "deploy/brain-organizer.service", "/etc/systemd/system/",
    ]);
    expect(installCommands).toContainEqual([
      "install", "-o", "root", "-g", "root", "-m", "0644",
      "deploy/brain-organizer.timer", "/etc/systemd/system/",
    ]);

    const environment = conditionalBranches(lines, "if [[ ! -f /etc/brain-organizer.env ]]; then");
    expect(commands(environment.whenTrue, "install")).toEqual([[
      "install", "-o", "root", "-g", "brain", "-m", "0640",
      "deploy/brain-organizer.env.example", "/etc/brain-organizer.env",
    ]]);
    expect(commands(environment.whenFalse, "chown")).toEqual([
      ["chown", "root:brain", "/etc/brain-organizer.env"],
    ]);
    expect(commands(environment.whenFalse, "chmod")).toEqual([
      ["chmod", "0640", "/etc/brain-organizer.env"],
    ]);
  });

  it("leaves the transaction target absent so runtime can migrate legacy recovery state", async () => {
    const testTmp = resolve(".test-tmp");
    mkdirSync(testTmp, { recursive: true });
    const root = mkdtempSync(join(testTmp, "brain-organizer-legacy-install-"));
    cleanupPaths.push(root);
    const dataRoot = join(root, "srv/brain/data");
    const legacyRecovery = join(dataRoot, "organizer-recovery");
    mkdirSync(legacyRecovery, { recursive: true });
    writeFileSync(join(legacyRecovery, "manifest.marker"), "legacy", "utf8");

    const installCommands = commands(logicalShellLines(readFileSync("deploy/install.sh", "utf8")), "install");
    const organizerInstall = installCommands.find((tokens) => tokens.includes("/srv/brain/data/organizer"));
    expect(organizerInstall).toBeDefined();
    for (const target of organizerInstall!.filter((token) => token.startsWith("/srv/brain/data/organizer"))) {
      mkdirSync(join(dataRoot, ...target.slice("/srv/brain/data/".length).split("/")), { recursive: true });
    }
    expect(existsSync(join(dataRoot, "organizer/transactions"))).toBe(false);

    const paths = await prepareOrganizerStatePaths(dataRoot);
    expect(readFileSync(join(paths.recovery, "manifest.marker"), "utf8")).toBe("legacy");
    expect(existsSync(legacyRecovery)).toBe(false);
  });

  it("merges exact disabled organizer policy into existing MCP config and only enables its timer", async () => {
    const source = await readFile("deploy/install.sh", "utf8");
    const lines = logicalShellLines(source);

    expect(jsonAssignment(source, "brain_organizer_json")).toEqual({
      enabledVaults: ["brain"],
      mode: "disabled",
      minStableSeconds: 300,
      autoApplyConfidence: 0.9,
      maxNotesPerRun: 20,
      maxNoteBytes: 131_072,
      maxContextBytes: 262_144,
      proposalTtlHours: 24,
      recoveryDays: 30,
      reportsDirectory: "60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports",
    });

    const existingConfig = conditionalBranches(lines, "if [[ -f \"$brain_config_file\" ]]; then");
    const merge = commands(existingConfig.whenTrue, "jq");
    expect(merge).toHaveLength(1);
    expect(merge[0]).toEqual(expect.arrayContaining([
      "--argjson", "organizer", "$brain_organizer_json", ".organizer = $organizer",
      "$brain_config_file",
    ]));

    const systemctl = commands(lines, "systemctl");
    expect(systemctl).toContainEqual([
      "systemctl", "enable", "brain-mcp", "caddy", "brain-mcp-backup.timer", "brain-organizer.timer",
    ]);
    expect(systemctl.some((tokens) => tokens.includes("brain-organizer.service"))).toBe(false);
  });

  it("recovers the existing owner passphrase from MCP config when its root copy is absent", async () => {
    const lines = logicalShellLines(await readFile("deploy/install.sh", "utf8"));
    const recovered = conditionalArm(lines, "elif [[ -f /etc/brain-mcp-config.json ]]; then");

    expect(recovered).toEqual([
      "brain_owner_passphrase=$(jq -r '.owner.passphrase // empty' /etc/brain-mcp-config.json)",
    ]);
    const validation = lines.indexOf("[[ ${#brain_jwt_secret} -eq 64 && ${#brain_owner_passphrase} -ge 32 ]] || {");
    const persistenceStart = lines.indexOf("if [[ ! -f /root/brain-mcp-owner-passphrase.txt ]]; then");
    expect(validation).toBeGreaterThan(-1);
    expect(persistenceStart).toBeGreaterThan(validation);
    expect(conditionalBranches(lines, "if [[ ! -f /root/brain-mcp-owner-passphrase.txt ]]; then").whenTrue).toEqual([
      "printf '%s\\n' \"$brain_owner_passphrase\" >/root/brain-mcp-owner-passphrase.txt",
      "chmod 600 /root/brain-mcp-owner-passphrase.txt",
    ]);
  });

  it("merges organizer config twice without changing existing owner, auth, or custom fields", () => {
    const testTmp = resolve(".test-tmp");
    mkdirSync(testTmp, { recursive: true });
    const root = mkdtempSync(join(testTmp, "brain-organizer-config-"));
    cleanupPaths.push(root);
    const relativeRoot = `.test-tmp/${basename(root)}`;
    const fakeBin = join(root, "fake-bin");
    const configPath = join(root, "brain-mcp-config.json");
    mkdirSync(fakeBin);
    writeFileSync(join(root, ".brain-install-config-test-root"), "test-only\n", "utf8");
    writeFileSync(configPath, JSON.stringify({
      dataDir: "/preserved/data",
      owner: { id: "owner", passphrase: "fixture-passphrase-that-is-not-a-credential", allowedVaults: ["brain"] },
      vaults: [{ id: "brain", root: "/preserved/vault" }],
      authentication: { issuer: "preserved" },
      customField: { keep: true },
      organizer: { mode: "automatic", trialStartedAt: "must-be-removed" },
    }), "utf8");
    executable("jq", `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.length !== 5 || args[0] !== "--argjson" || args[1] !== "organizer"
  || args[3] !== ".organizer = $organizer") process.exit(64);
const config = JSON.parse(readFileSync(args[4], "utf8"));
config.organizer = JSON.parse(args[2]);
process.stdout.write(JSON.stringify(config));
`, fakeBin);

    const script = resolve("deploy/install.sh");
    const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    const run = () => spawnSync(
      bash,
      ["-c", `export PATH='${relativeRoot}/fake-bin':"$PATH"; exec bash '${bashPath(script)}'`],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          BRAIN_INSTALL_CONFIG_TEST_MODE: "1",
          BRAIN_INSTALL_TEST_ROOT: relativeRoot,
        },
      },
    );

    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const once = readFileSync(configPath, "utf8");
    expect(JSON.parse(once)).toEqual({
      dataDir: "/preserved/data",
      owner: { id: "owner", passphrase: "fixture-passphrase-that-is-not-a-credential", allowedVaults: ["brain"] },
      vaults: [{ id: "brain", root: "/preserved/vault" }],
      authentication: { issuer: "preserved" },
      customField: { keep: true },
      organizer: {
        enabledVaults: ["brain"],
        mode: "disabled",
        minStableSeconds: 300,
        autoApplyConfidence: 0.9,
        maxNotesPerRun: 20,
        maxNoteBytes: 131_072,
        maxContextBytes: 262_144,
        proposalTtlHours: 24,
        recoveryDays: 30,
        reportsDirectory: "60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports",
      },
    });

    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(once);
  }, 15_000);

  it("backs up organizer recovery state without copying the provider environment", () => {
    const backupSource = readFileSync("deploy/backup.sh", "utf8");
    const backupLines = logicalShellLines(backupSource);
    expect(backupLines).toContain("brain_archive_root=/srv/brain/backups");
    expect(backupSource).not.toContain("BRAIN_ARCHIVE_ROOT");
    expect(commands(backupLines, "tar")).toContainEqual([
      "tar", "--xattrs", "--acls", "-C", "$brain_data_root", "-czf",
      "$brain_backup_dest/organizer-state.tgz", "organizer",
    ]);

    const testTmp = resolve(".test-tmp");
    mkdirSync(testTmp, { recursive: true });
    const root = mkdtempSync(join(testTmp, "brain-organizer-backup-"));
    cleanupPaths.push(root);
    const relativeRoot = `.test-tmp/${basename(root)}`;
    const brainRoot = join(root, "srv/brain");
    const organizerRoot = join(brainRoot, "data/organizer");
    const configPath = join(root, "etc/brain-mcp-config.json");
    const providerEnvironmentPath = join(root, "etc/brain-organizer.env");

    writeFileSync(join(root, ".brain-backup-test-root"), "test-only\n", "utf8");
    mkdirSync(join(brainRoot, "vaults/brain"), { recursive: true });
    mkdirSync(join(organizerRoot, "transactions/ORG-example"), { recursive: true });
    mkdirSync(join(root, "etc"), { recursive: true });
    writeFileSync(join(brainRoot, "vaults/brain/note.md"), "safe fixture", "utf8");
    writeFileSync(join(organizerRoot, "organizer.sqlite"), "state", "utf8");
    writeFileSync(join(organizerRoot, "transactions/ORG-example/manifest.json"), "{}", "utf8");
    writeFileSync(configPath, "{}", "utf8");
    writeFileSync(providerEnvironmentPath, "DASHSCOPE_API_KEY=must-not-be-backed-up\n", "utf8");
    chmodSync(configPath, 0o600);

    const script = resolve("deploy/backup.sh");
    const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    const result = spawnSync(bash, ["-c", `exec bash '${bashPath(script)}'`], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        BRAIN_BACKUP_TEST_MODE: "1",
        BRAIN_BACKUP_TEST_ROOT: relativeRoot,
      },
    });
    expect(result.status, result.stderr).toBe(0);

    const backupRoot = join(brainRoot, "backups");
    const [stamp] = readdirSync(backupRoot);
    expect(stamp).toMatch(/^\d{8}T\d{6}Z$/u);
    const destination = join(backupRoot, stamp!);
    expect(statSync(join(destination, "organizer-state.tgz")).isFile()).toBe(true);
    expect(existsSync(join(destination, "brain-organizer.env"))).toBe(false);

    const listed = spawnSync(bash, ["-c", `tar -tzf '${bashPath(join(destination, "organizer-state.tgz"))}'`], {
      cwd: resolve("."),
      encoding: "utf8",
    });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout.split(/\r?\n/u).filter(Boolean).sort()).toEqual([
      "organizer/",
      "organizer/organizer.sqlite",
      "organizer/transactions/",
      "organizer/transactions/ORG-example/",
      "organizer/transactions/ORG-example/manifest.json",
    ]);
    expect(listed.stdout).not.toContain("brain-organizer.env");
    expect(readFileSync(providerEnvironmentPath, "utf8")).toContain("must-not-be-backed-up");
  }, 15_000);

  it("rejects an ungated broad backup override before retention can delete sibling directories", () => {
    const testTmp = resolve(".test-tmp");
    mkdirSync(testTmp, { recursive: true });
    const root = mkdtempSync(join(testTmp, "brain-organizer-backup-unsafe-"));
    cleanupPaths.push(root);
    const relativeRoot = `.test-tmp/${basename(root)}`;
    const brainRoot = join(root, "srv/brain");
    const victim = join(root, "unrelated-old-directory");
    mkdirSync(join(brainRoot, "vaults/brain"), { recursive: true });
    mkdirSync(join(brainRoot, "data/organizer"), { recursive: true });
    mkdirSync(join(root, "etc"), { recursive: true });
    mkdirSync(victim);
    writeFileSync(join(root, "etc/brain-mcp-config.json"), "{}", "utf8");
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1_000);
    utimesSync(victim, old, old);

    const script = resolve("deploy/backup.sh");
    const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    const result = spawnSync(bash, ["-c", `exec bash '${bashPath(script)}'`], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        BRAIN_BACKUP_TEST_MODE: "1",
        BRAIN_BACKUP_TEST_ROOT: relativeRoot,
        BRAIN_ARCHIVE_ROOT: relativeRoot,
        BRAIN_VAULT_ROOT: `${relativeRoot}/srv/brain`,
        BRAIN_DATA_ROOT: `${relativeRoot}/srv/brain/data`,
        BRAIN_CONFIG_FILE: `${relativeRoot}/etc/brain-mcp-config.json`,
      },
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(victim)).toBe(true);
  }, 15_000);
});
