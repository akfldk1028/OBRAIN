import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function bashPath(path: string): string {
  return process.platform === "win32"
    ? path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/")
    : path;
}

function executable(name: string, contents: string, directory: string): void {
  const path = join(directory, name);
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}

describe("Oracle image firewall setup", () => {
  it("places public service rules before the image's catch-all rejection and keeps them idempotent", () => {
    const testTmp = resolve(".test-tmp");
    mkdirSync(testTmp, { recursive: true });
    const root = mkdtempSync(join(testTmp, "brain-firewall-root-"));
    cleanupPaths.push(root);
    const relativeRoot = `.test-tmp/${basename(root)}`;
    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin);
    const rulesPath = join(root, "rules.v4");
    const logPath = join(root, "iptables.log");

    writeFileSync(
      rulesPath,
      `*filter
-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT
-A INPUT -j REJECT --reject-with icmp-host-prohibited
COMMIT
`,
      "utf8",
    );
    executable("id", "#!/usr/bin/env bash\n[[ ${1:-} == -u ]] && echo 0\n", fakeBin);
    executable(
      "iptables",
      `#!/usr/bin/env bash
printf '%s\n' "$*" >>"$BRAIN_TEST_IPTABLES_LOG"
[[ "\${1:-}" == -C ]] && exit 1
exit 0
`,
      fakeBin,
    );

    const script = resolve("deploy/configure-firewall.sh");
    const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    const result = spawnSync(
      bash,
      ["-c", `export PATH='${relativeRoot}/fake-bin':"$PATH"; exec bash '${bashPath(script)}'`],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          BRAIN_IPTABLES_RULES_V4: `${relativeRoot}/rules.v4`,
          BRAIN_TEST_IPTABLES_LOG: `${relativeRoot}/iptables.log`,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);

    const firstRun = readFileSync(rulesPath, "utf8").split(/\r?\n/);
    const rejectIndex = firstRun.indexOf("-A INPUT -j REJECT --reject-with icmp-host-prohibited");
    const expectedRules = [
      "-A INPUT -p tcp -m tcp --dport 80 -j ACCEPT",
      "-A INPUT -p tcp -m tcp --dport 443 -j ACCEPT",
      "-A INPUT -p tcp -m tcp --dport 22000 -j ACCEPT",
      "-A INPUT -p udp -m udp --dport 22000 -j ACCEPT",
    ];
    for (const rule of expectedRules) {
      expect(firstRun.indexOf(rule), rule).toBeGreaterThan(-1);
      expect(firstRun.indexOf(rule), rule).toBeLessThan(rejectIndex);
    }

    const second = spawnSync(
      bash,
      ["-c", `export PATH='${relativeRoot}/fake-bin':"$PATH"; exec bash '${bashPath(script)}'`],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          BRAIN_IPTABLES_RULES_V4: `${relativeRoot}/rules.v4`,
          BRAIN_TEST_IPTABLES_LOG: `${relativeRoot}/iptables.log`,
        },
      },
    );
    expect(second.status, second.stderr).toBe(0);
    const secondRun = readFileSync(rulesPath, "utf8");
    for (const rule of expectedRules) {
      expect(secondRun.split(rule).length - 1, rule).toBe(1);
    }
    expect(readFileSync(logPath, "utf8")).toContain("--dport 443 -j ACCEPT");
  }, 15_000);
});

