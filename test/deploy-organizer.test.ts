import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
});
