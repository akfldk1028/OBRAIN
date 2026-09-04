# Brain Organizer Oracle Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the verified Brain organizer to the existing Oracle VM as a hardened daily dry-run service, install a newly rotated provider credential without exposing it, and prove public MCP, organization reports, backup, undo, synchronization, and reboot recovery end to end.

**Architecture:** The existing `brain-mcp`, `brain-syncthing`, and `caddy` services remain in place. A separate hardened oneshot `brain-organizer.service` shares the tested runtime and uses a persistent systemd timer at 18:00 UTC (03:00 KST); deployment begins disabled, then receives a restricted provider key and runs seven days in non-escalatable dry-run mode before automatic mode can be explicitly enabled.

**Tech Stack:** Oracle Cloud Ubuntu, systemd, Node.js 20+, Caddy, Syncthing, Bash, PowerShell/OpenSSH, DashScope/Qwen, MCP OAuth 2.1

**Spec:** `docs/superpowers/specs/2026-09-03-brain-vault-auto-organization-design.md`

## Global Constraints

- Deploy only to the existing Oracle Brain server and registered `brain` Vault unless the user explicitly adds another Vault ID.
- Preserve the public endpoint `https://144-24-67-37.sslip.io/mcp` and loopback-only Node listener.
- Preserve `brain-mcp`, `brain-syncthing`, `caddy`, and `brain-mcp-backup.timer` behavior.
- Do not expose ports `8384` or `8787`; no new public port is required.
- The organizer timer runs at 18:00 UTC, equivalent to 03:00 KST, with persistent missed-run handling.
- Initial server mode is `disabled`; live provider smoke begins only after a newly issued key is installed.
- After the key is installed, the first seven calendar days remain forced dry-run.
- Never print, commit, chat, copy into a note, or include the provider key in a process argument.
- The historical leaked DashScope key is permanently rejected and never reused.
- `/etc/brain-organizer.env` is root-owned, group-readable only by `brain`, and mode `0640`.
- Organizer reports contain paths and reason codes only, never note bodies or credentials.
- Recovery snapshots are retained 30 days; normal Vault backups remain retained 14 days.
- Every remote mutation is preceded by an explicit target check and a verified current backup.

---

## File Structure

- Create `deploy/brain-organizer.service`: hardened organizer oneshot service.
- Create `deploy/brain-organizer.timer`: persistent daily timer.
- Create `deploy/brain-organizer.env.example`: non-secret environment names and safe disabled defaults.
- Modify `deploy/install.sh`: install units/config safely and preserve existing trial state and secrets.
- Modify `deploy/backup.sh`: back up organizer recovery state without backing up the provider key.
- Modify `deploy/README.md`: exact rollout, trial, activation, disable, audit, and undo commands.
- Modify `deploy/brain-mcp.service`: read optional organizer environment so owner MCP tools can use the same provider.
- Modify `scripts/verify-deployment.mjs`: verify thirteen enabled tools and read-only organizer policy/audit calls.
- Create `test/deploy-organizer.test.ts`: static hardening, schedule, installer, and backup assertions.

### Task 1: Hardened Organizer Service and Daily Timer

**Files:**
- Create: `deploy/brain-organizer.service`
- Create: `deploy/brain-organizer.timer`
- Create: `deploy/brain-organizer.env.example`
- Modify: `deploy/brain-mcp.service`
- Test: `test/deploy-organizer.test.ts`

**Interfaces:**
- Consumes: `dist/organizer-cli.js`, `/etc/brain-mcp.env`, `/etc/brain-organizer.env`, and the registered `brain` Vault.
- Produces: `brain-organizer.service` and `brain-organizer.timer` with no public listener.

- [ ] **Step 1: Write failing deployment-file tests**

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("organizer deployment units", () => {
  it("runs as brain with hardening and exact daily UTC schedule", async () => {
    const service = await readFile("deploy/brain-organizer.service", "utf8");
    const timer = await readFile("deploy/brain-organizer.timer", "utf8");
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("User=brain");
    expect(service).toContain("EnvironmentFile=/etc/brain-mcp.env");
    expect(service).toContain("EnvironmentFile=/etc/brain-organizer.env");
    expect(service).toContain("ExecStart=/usr/bin/node /opt/brain-mcp/dist/organizer-cli.js run --vault brain");
    expect(service).toContain("NoNewPrivileges=true");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("ReadWritePaths=/srv/brain/data /srv/brain/vaults/brain");
    expect(timer).toContain("OnCalendar=*-*-* 18:00:00 UTC");
    expect(timer).toContain("Persistent=true");
  });

  it("ships no usable provider credential", async () => {
    const example = await readFile("deploy/brain-organizer.env.example", "utf8");
    expect(example).toContain("ORGANIZER_PROVIDER=disabled");
    expect(example).not.toMatch(/DASHSCOPE_API_KEY=\S+/);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm test -- test/deploy-organizer.test.ts`

Expected: FAIL because the deployment files do not exist.

- [ ] **Step 3: Create the hardened oneshot unit**

```ini
[Unit]
Description=Brain Vault automatic organizer
After=network-online.target brain-mcp.service brain-syncthing.service
Wants=network-online.target

[Service]
Type=oneshot
User=brain
Group=brain
WorkingDirectory=/opt/brain-mcp
EnvironmentFile=/etc/brain-mcp.env
EnvironmentFile=/etc/brain-organizer.env
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=/usr/bin/node /opt/brain-mcp/dist/organizer-cli.js run --vault brain
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/srv/brain/data /srv/brain/vaults/brain
MemoryMax=384M
TasksMax=64
TimeoutStartSec=10min
```

- [ ] **Step 4: Create the exact timer and disabled example environment**

```ini
[Unit]
Description=Run Brain Vault organizer daily at 03:00 KST

[Timer]
OnCalendar=*-*-* 18:00:00 UTC
Persistent=true
RandomizedDelaySec=5m
Unit=brain-organizer.service

[Install]
WantedBy=timers.target
```

```dotenv
ORGANIZER_PROVIDER=disabled
DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen-plus
# DASHSCOPE_API_KEY is added only to /etc/brain-organizer.env on the server.
```

Modify `brain-mcp.service` to include `EnvironmentFile=-/etc/brain-organizer.env`; the leading minus
keeps the pre-rollout service compatible when the file is absent. Do not put a key in the unit.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- test/deploy-organizer.test.ts`

Expected: PASS.

```bash
git add deploy/brain-organizer.service deploy/brain-organizer.timer deploy/brain-organizer.env.example deploy/brain-mcp.service test/deploy-organizer.test.ts
git commit -m "feat: add hardened daily organizer service"
```

### Task 2: Idempotent Installer, Config Preservation, and Organizer Backup

**Files:**
- Modify: `deploy/install.sh`
- Modify: `deploy/backup.sh`
- Modify: `test/deploy-organizer.test.ts`

**Interfaces:**
- Consumes: service files from Task 1 and existing `/etc/brain-mcp-config.json` when present.
- Produces: safe installation of organizer directories, config, environment, units, timer, and recovery backup.

- [ ] **Step 1: Add failing installer and backup assertions**

Assert `install.sh`:

- creates `/srv/brain/data/organizer/transactions` owned by `brain` mode `0700`;
- installs both units mode `0644`;
- creates `/etc/brain-organizer.env` from the disabled example only if absent;
- sets owner `root:brain` and mode `0640`;
- enables the timer without starting an organizer run;
- adds `organizer.enabledVaults=["brain"]`, `mode="disabled"`, threshold `0.9`, stable seconds `300`,
  maximum notes `20`, recovery days `30`, and the exact reports directory to MCP config.

Assert `backup.sh` creates `organizer-state.tgz` from `/srv/brain/data/organizer` when present and never
copies `/etc/brain-organizer.env`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm test -- test/deploy-organizer.test.ts`

Expected: FAIL on missing installer and backup behavior.

- [ ] **Step 3: Extend installation with safe defaults**

Add exact directory and unit installation operations:

```bash
install -d -o brain -g brain -m 0700 /srv/brain/data/organizer /srv/brain/data/organizer/transactions
if [[ ! -f /etc/brain-organizer.env ]]; then
  install -o root -g brain -m 0640 deploy/brain-organizer.env.example /etc/brain-organizer.env
else
  chown root:brain /etc/brain-organizer.env
  chmod 0640 /etc/brain-organizer.env
fi
install -o root -g root -m 0644 deploy/brain-organizer.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/brain-organizer.timer /etc/systemd/system/
```

Add the complete non-secret organizer object through `jq`, preserving the existing owner passphrase
handling. Trial time is not stored in root configuration: the organizer SQLite store records
`trial_started_at` on the first provider-enabled run. The installed config must remain
`mode="disabled"`; Task 6 performs the first protected transition to `dry-run`. Enable
`brain-organizer.timer` but do not call
`systemctl start brain-organizer.service` from the installer.

- [ ] **Step 4: Back up recovery state separately**

After `vaults.tgz`, add:

```bash
if [[ -d /srv/brain/data/organizer ]]; then
  tar --xattrs --acls -C /srv/brain/data -czf "$brain_backup_dest/organizer-state.tgz" organizer
fi
```

Do not archive the search index, provider environment, OAuth client file, owner passphrase file, or
SSH credentials.

- [ ] **Step 5: Run deployment and existing backup tests**

Run: `npm test -- test/deploy-organizer.test.ts test/audit.test.ts test/config.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit installer and backup changes**

```bash
git add deploy/install.sh deploy/backup.sh test/deploy-organizer.test.ts
git commit -m "feat: install and back up organizer state safely"
```

### Task 3: Deployment Verifier and Operator Runbook

**Files:**
- Modify: `scripts/verify-deployment.mjs`
- Modify: `deploy/README.md`
- Modify: `DEPLOY.md`
- Test: `test/deploy-organizer.test.ts`

**Interfaces:**
- Consumes: public OAuth MCP endpoint and server systemd services.
- Produces: redacted public verification and exact enable/disable/audit/undo recovery instructions.

- [ ] **Step 1: Add failing verifier text assertions**

Require the verifier to expect thirteen tools only when `DEPLOY_EXPECT_ORGANIZER=1`, call
`get_vault_policy` and `audit_vault`, and never call `apply_organization`, `undo_organization`, or
`organize_now` during a read-only deployment check.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -- test/deploy-organizer.test.ts`

Expected: FAIL until verifier and docs contain the required behavior.

- [ ] **Step 3: Make verifier mode explicit and non-mutating**

```js
const organizerExpected = process.env.DEPLOY_EXPECT_ORGANIZER === "1";
const baseTools = [
  "create_inbox_note", "get_note_links", "list_notes",
  "list_vaults", "read_note", "search_notes",
];
const organizerTools = [
  "apply_organization", "audit_vault", "get_vault_policy", "list_inbox_notes",
  "organize_now", "propose_organization", "undo_organization",
];
const expected = organizerExpected ? [...baseTools, ...organizerTools].sort() : baseTools.sort();
```

In organizer mode, call only `get_vault_policy({vault:"brain"})` and
`audit_vault({vault:"brain"})`, then assert non-error results. Keep the existing authenticated
create/read/search round trip as the only deployment-verifier mutation.

- [ ] **Step 4: Document exact operations without secrets**

Add commands for:

```bash
systemctl status brain-organizer.timer --no-pager
systemctl list-timers brain-organizer.timer --no-pager
sudo -u brain /usr/bin/node /opt/brain-mcp/dist/organizer-cli.js audit --vault brain
sudo systemctl start brain-organizer.service
sudo systemctl edit --runtime brain-organizer.timer
```

Document emergency disable as editing `ORGANIZER_PROVIDER=disabled` in the protected environment,
then restarting `brain-mcp` and leaving the timer harmless. Document guarded undo through MCP or:

```bash
sudo -u brain /usr/bin/node /opt/brain-mcp/dist/organizer-cli.js undo --vault brain --transaction ORG-EXAMPLE-IDENTIFIER
```

The identifier is visibly an example, not a secret. Document that automatic activation requires
seven elapsed calendar days plus explicit review; no command should bypass the trial check.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- test/deploy-organizer.test.ts && git diff --check`

Expected: PASS.

```bash
git add scripts/verify-deployment.mjs deploy/README.md DEPLOY.md test/deploy-organizer.test.ts
git commit -m "docs: add safe organizer rollout verification"
```

### Task 4: Local Release Gate and Packaging

**Files:**
- No source files unless verification reveals a feature-scoped defect
- Create outside Git: a temporary release staging directory and archive

**Interfaces:**
- Consumes: completed foundation and organizer implementation branches.
- Produces: one verified release archive with no local Vault content or secrets.

- [ ] **Step 1: Confirm exact branch and clean tracked state**

Run:

```powershell
git status --short --branch
git remote -v
git log -5 --oneline
```

Expected: branch `feature/multivault-brain-mcp`, no uncommitted files, and only the known local origin.
Do not claim the branch is backed up to GitHub.

- [ ] **Step 2: Run the complete local verification gate**

Run:

```powershell
npm ci
npm run test
npm run typecheck
npm run build
npm run smoke
npm run smoke:http
npm audit --omit=dev
git diff --check
```

Expected: all commands pass; production dependencies have no known high or critical advisories and
the two known `qs` denial-of-service advisories are no longer present.

- [ ] **Step 3: Create and validate an explicit temporary release directory**

Use one PowerShell process, a random temp directory, and an archive path under the workspace. Do not
include `.git`, `node_modules`, `work/keys`, the Brain Vault, `.env` files, or local reports:

```powershell
$releaseStage = Join-Path ([IO.Path]::GetTempPath()) ("brain-release-" + [guid]::NewGuid().ToString('N'))
$releaseArchive = 'C:\Users\SOGANG1\Documents\Codex\2026-09-01\new-chat\work\brain-organizer-release.tar.gz'
New-Item -ItemType Directory -Path $releaseStage | Out-Null
git archive --format=zip HEAD -o (Join-Path $releaseStage 'source.zip')
Expand-Archive -LiteralPath (Join-Path $releaseStage 'source.zip') -DestinationPath (Join-Path $releaseStage 'release')
Copy-Item -LiteralPath '.\dist' -Destination (Join-Path $releaseStage 'release\dist') -Recurse
tar -czf $releaseArchive -C (Join-Path $releaseStage 'release') .
Get-FileHash -LiteralPath $releaseArchive -Algorithm SHA256
```

Before upload, list names with `tar -tzf` and assert none match `\.env$`, `keys/`, `\.key$`, `Brain/`,
`node_modules/`, or `.git/`.

- [ ] **Step 4: Record release identity**

Save the Git commit ID and archive SHA-256 in the operator's deployment output, not in a Vault note
containing credentials. The release archive is disposable after verified deployment.

### Task 5: Backup, Upload, and Idempotent Oracle Installation

**Files:**
- Remote install targets under `/opt/brain-mcp`, `/etc/systemd/system`, and `/srv/brain/data/organizer`
- No local source changes

**Interfaces:**
- Consumes: release archive, the existing SSH host, and existing deployment installer.
- Produces: installed but provider-disabled organizer with existing services preserved.

- [ ] **Step 1: Request network permission and resolve exact remote identity**

Request network access only for the deployment turn. Use the existing host
`ubuntu@144.24.67.37`, the active session key
`C:\Users\SOGANG1\Documents\Codex\2026-09-01\new-chat\work\session-key\brain-mcp-active.key`, and the
known-hosts file `C:\Users\SOGANG1\Documents\Codex\2026-09-01\new-chat\work\keys\known_hosts`.
Never print key contents.

- [ ] **Step 2: Verify remote targets and create a current backup**

Over SSH, confirm the hostname, `/srv/brain`, `/opt/brain-mcp`, and exact four existing services.
Run `/usr/local/sbin/brain-mcp-backup`, capture the new backup directory name, list both archive
files, and verify `tar -tzf` can read them before installing. Do not remove any prior release.

- [ ] **Step 3: Upload and verify the remote release archive**

Upload the local release archive to the exact file `/tmp/brain-organizer-release.tar.gz` with `scp` and
strict known-host checking. Compare local and remote SHA-256 before extraction. Stop if the hashes do
not match.

- [ ] **Step 4: Run the installer with existing public identity**

Run as root with:

```bash
brain_release_dir=$(mktemp -d /tmp/brain-organizer-release.XXXXXX)
tar -xzf /tmp/brain-organizer-release.tar.gz -C "$brain_release_dir"
test -f "$brain_release_dir/dist/index.js"
test -f "$brain_release_dir/dist/organizer-cli.js"
test -f "$brain_release_dir/deploy/install.sh"
test -f "$brain_release_dir/package-lock.json"
PUBLIC_HOST=144-24-67-37.sslip.io \
RELEASE_DIR="$brain_release_dir" \
BRAIN_VAULT_IDS=brain \
bash "$brain_release_dir/deploy/install.sh"
```

The installer must retain JWT and owner passphrase files, install the organizer in disabled mode, and
leave all Vault data intact. Do not recursively delete the temporary directory during the deployment
turn; it can be removed later only after resolving and rechecking its exact `/tmp/brain-organizer-release.*`
path.

- [ ] **Step 5: Verify provider-disabled deployment**

Run:

```bash
systemctl is-active brain-mcp brain-syncthing caddy brain-mcp-backup.timer brain-organizer.timer
systemctl is-enabled brain-mcp brain-syncthing caddy brain-mcp-backup.timer brain-organizer.timer
systemctl list-timers brain-organizer.timer --no-pager
curl -fsS http://127.0.0.1:8787/healthz
# Run the authenticated verifier without DEPLOY_EXPECT_ORGANIZER.
# It must assert the exact six-tool disabled surface.
node /opt/brain-mcp/current/scripts/verify-deployment.mjs
```

Expected: all units active/enabled as appropriate, next organizer time is about 18:00 UTC, health is
`ok`, the authenticated MCP surface contains exactly six tools, and no organizer run starts during
installation. Stop before provider activation if any organizer tool is registered.

### Task 6: Secure Provider Activation and Real Dry-Run Smoke

**Files:**
- Modify remotely: `/etc/brain-organizer.env` and `/etc/brain-mcp-config.json` only through one
  root-owned protected activation transaction
- Create in Vault: one harmless public MCP test note and one dry-run report
- No Git source changes

**Interfaces:**
- Consumes: a newly issued DashScope key and its matching official regional base URL.
- Produces: provider-enabled, trial-locked dry-run operation.

- [ ] **Step 1: Revoke the historical key and create a new restricted key**

In Alibaba Cloud Model Studio, revoke the key previously exposed in conversation. Create a new key
for the selected workspace, restrict it to the Oracle public IP and intended Qwen model where the
account supports those controls, and confirm whether it belongs to the China or International API
region. Never paste the new value into chat or a Vault note.

- [ ] **Step 2: Enter the new value through a hidden interactive remote prompt**

Open an interactive SSH terminal and run one root activation script that uses `read -rsp` so the
value is not echoed or placed in shell history. With `umask 077`, stage both (a) a provider
environment containing `ORGANIZER_PROVIDER=dashscope`, the correct official base URL, selected
model, and hidden `DASHSCOPE_API_KEY`, and (b) a validated config copy whose only activation change
is `organizer.mode="dry-run"`. Verify the live config is still `disabled`, validate both staged
files, retain private same-filesystem rollback copies, and atomically rename the staged files into
`/etc/brain-organizer.env` and `/etc/brain-mcp-config.json` inside one trap-guarded critical section.
Restore both prior files if either replacement, permission change, restart, health check, or tool
count verification fails. Install the final files as `root:brain` mode `0640` and `brain:brain` mode
`0600`, respectively, preserving the service account's existing config ownership. Remove staged and
rollback files in the same shell only after success. Do not
use a command-line argument or clipboard-visible transcript for the key.

- [ ] **Step 3: Restart only the processes that read the environment**

Only after both protected files are installed, run:

```bash
systemctl restart brain-mcp
systemctl reset-failed brain-organizer.service
systemctl is-active brain-mcp brain-syncthing caddy
```

Expected: the public MCP service returns without restarting Syncthing or Caddy.

- [ ] **Step 4: Create one harmless test note through public authenticated MCP**

Use a unique marker and content that contains no personal or secret data:

```markdown
# 자동정리 시험 메모

강화학습에서 상태, 행동, 보상이 어떻게 연결되는지 공부할 예정이다.
```

Confirm it is created under `Agent-Inbox`, can be read and searched, and synchronizes to
`D:\obsidian\Brain`. To avoid a five-minute blocking wait, set only that test file's server mtime to
ten minutes earlier after resolving and verifying its exact path inside `/srv/brain/vaults/brain/Agent-Inbox`.

- [ ] **Step 5: Run one explicit dry-run and verify no source mutation**

Record the source SHA-256, run `systemctl start brain-organizer.service`, then inspect status and
redacted journal output. Confirm:

- service result is success;
- run mode is `dry-run`;
- a proposal and Markdown report exist;
- the source path and SHA-256 are unchanged;
- no transaction row is applied;
- report contains no note body or credential;
- Syncthing returns to idle and the report appears locally.

- [ ] **Step 6: Run public and backup verification**

Set `DEPLOY_EXPECT_ORGANIZER=1` and run the authenticated deployment verifier from the server without
displaying the passphrase; it must assert the exact thirteen-tool provider-enabled surface. Then
create a new backup, verify `vaults.tgz`, `organizer-state.tgz`, and
`config.json` are readable, and confirm the protected provider environment is absent from the backup.

- [ ] **Step 7: Reboot and verify recovery**

Reboot the VM, wait with bounded status polls, and verify `brain-mcp`, `brain-syncthing`, `caddy`, both
timers, HTTPS health, unauthenticated MCP `401`, authenticated policy/audit tools, local Syncthing
idle state, and no failed systemd units. Do not invoke automatic apply.

### Task 7: Seven-Day Review and Explicit Automatic-Mode Gate

**Files:**
- Review: generated organizer reports and proposals
- Modify remotely after approval: non-secret organizer mode in `/etc/brain-mcp-config.json`

**Interfaces:**
- Consumes: at least seven elapsed calendar days of dry-run reports.
- Produces: either continued dry-run with corrections or explicitly approved `automatic` mode.

- [ ] **Step 1: Review every live dry-run result**

For each proposal, compare target area, existing destination folder, title, summary, callouts, related
links, confidence, and reason against the source. Record false positives and ensure secret skips and
ambiguous notes stayed unchanged.

- [ ] **Step 2: Run the integrity and security gates again**

Run the public read-only verifier, organizer audit, full repository tests at the deployed commit,
`npm audit --omit=dev`, backup verification, failed-unit check, disk usage check, and a search for
provider-key-shaped values in reports and journald. Never output matching secret text; report only
counts and paths.

- [ ] **Step 3: Require explicit user approval before changing mode**

If seven calendar days have elapsed and all critical classifications are correct, present a concise
summary and request explicit automatic-mode approval. Without that approval, keep `dry-run` forever.

- [ ] **Step 4: Enable automatic mode without changing safety thresholds**

After approval, atomically set mode to `automatic` while retaining threshold `0.90`, stable seconds
`300`, maximum notes `20`, and recovery days `30`. Restart `brain-mcp`; do not run a forced organizer
job until a backed-up harmless fixture is ready.

- [ ] **Step 5: Verify one reversible automatic transaction**

Create one harmless Inbox fixture, record source hash, run the service, confirm it moved to an approved
existing directory, verify `## 원문`, MOC, Canvas, backlinks, search index, transaction manifest, and
local synchronization, then call guarded undo. Confirm the exact original source returns and no newer
human file is overwritten.

- [ ] **Step 6: Leave automatic mode active only if the reversible test passes**

If any apply, derived-file, sync, backup, audit, or undo check fails, immediately return to `dry-run`
and preserve all evidence. Claim rollout completion only when the reversible test and post-reboot
verification both pass.
