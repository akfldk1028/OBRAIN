import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

describe("APT repository setup", () => {
  it("keeps repository keys and source lists readable by APT under a private umask", () => {
    const testTmp = resolve(".test-tmp");
    mkdirSync(testTmp, { recursive: true });
    const root = mkdtempSync(join(testTmp, "brain-apt-root-"));
    cleanupPaths.push(root);
    const fakeBin = join(root, "fake-bin");
    const relativeRoot = `.test-tmp/${basename(root)}`;
    mkdirSync(fakeBin);

    executable(
      "curl",
      `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$url" == *debian.deb.txt ]]; then
  payload='deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://example.invalid stable main'
else
  payload='test-key'
fi
if [[ -n "$output" ]]; then
  mkdir -p "$(dirname "$output")"
  printf '%s\n' "$payload" >"$output"
else
  printf '%s\n' "$payload"
fi
`,
      fakeBin,
    );
    executable(
      "gpg",
      `#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then output="$2"; shift 2; else shift; fi
done
mkdir -p "$(dirname "$output")"
cat >"$output"
`,
      fakeBin,
    );

    const script = resolve("deploy/configure-apt-repositories.sh");
    const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    const result = spawnSync(
      bash,
      ["-c", `export PATH='${relativeRoot}/fake-bin':"$PATH"; exec bash '${bashPath(script)}'`],
      {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        BRAIN_APT_ROOT: relativeRoot,
      },
      },
    );

    expect(result.status, result.stderr).toBe(0);

    const expectedFiles = [
      "etc/apt/keyrings/nodesource.gpg",
      "usr/share/keyrings/caddy-stable-archive-keyring.gpg",
      "etc/apt/keyrings/syncthing-archive-keyring.gpg",
      "etc/apt/sources.list.d/nodesource.list",
      "etc/apt/sources.list.d/caddy-stable.list",
      "etc/apt/sources.list.d/syncthing.list",
      "etc/apt/preferences.d/syncthing.pref",
    ];
    for (const relativePath of expectedFiles) {
      expect(statSync(join(root, relativePath)).mode & 0o044, relativePath).toBe(0o044);
    }

    const caddySource = readFileSync(join(root, "etc/apt/sources.list.d/caddy-stable.list"), "utf8");
    expect(caddySource).toContain("signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg");
    expect(dirname(join(root, "usr/share/keyrings/caddy-stable-archive-keyring.gpg"))).toBe(
      join(root, "usr/share/keyrings"),
    );
  });
});
