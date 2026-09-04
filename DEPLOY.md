# Deploying the Obsidian Multivault MCP as a public HTTPS server

This runbook stands up the **remote** (Streamable HTTP) transport so Claude's connectors —
including the **mobile app** — can reach the vault. It is meant to be followed on the VPS itself
(e.g. by an agent with shell access).

It does **not** touch the existing stdio-over-SSH path used by Claude Desktop; that keeps working
independently. You may replace the Desktop SSH config with this remote connector afterwards (see the
last section).

## What you are building

```
Claude (mobile / desktop / web) ──HTTPS──▶ Caddy :443 (auto Let's Encrypt)
                                            <ip>.sslip.io
                                                │ reverse_proxy
                                                ▼
                                  node dist/index.js --http  (127.0.0.1:8787)
                                    ├── self-hosted OAuth 2.1 (passphrase login, PKCE, JWT)
                                    └── /mcp  (bearer-guarded)  ──▶  the vault (read + write)
```

- **Transport:** MCP Streamable HTTP. Public entrypoint is Caddy on 443; the Node process only
  listens on `127.0.0.1:8787`.
- **Auth:** a self-hosted OAuth 2.1 layer. The human gate is a **single passphrase** entered once in
  a browser during the OAuth login. Tokens are stateless JWTs.
- **TLS + hostname:** `sslip.io` gives a hostname for a bare IP with no domain purchase —
  `203-0-113-10.sslip.io` resolves to `203.0.113.10`. Let's Encrypt issues a normal cert for it.

## Prerequisites

- **Node.js 20+** available for the run user (if you use a version manager like `asdf`, see step 1).
- **Ports 80 and 443 open to the internet** (Let's Encrypt uses them). Check both the host firewall
  (`ufw`) and any cloud firewall (many providers have a separate Cloud Firewall in their console).
- `sudo` access. Several steps write to `/etc` and manage services, which **requires an interactive
  terminal** — sudo cannot read a password through a non-interactive one-liner.
- Git access to the repo. If the GitHub repo is private, configure a deploy key or token on the VPS
  first; otherwise clone over HTTPS.

## Configuration for this server

These are example values — change them to match your VPS and keep them consistent across every step.

| Variable | Value |
|---|---|
| Run user | `youruser` |
| Vaults (one owner) | personal → `/home/youruser/personal-vault`, work → `/home/youruser/work-vault` |
| Knowledge config | `/etc/obsidian-multivault-mcp.json` (root-owned, mode 600) |
| Data dir | `/home/youruser/obsidian-multivault-mcp/data` |
| Repo / app dir | `/home/youruser/obsidian-multivault-mcp` |
| Public hostname | `203-0-113-10.sslip.io` (→ `203.0.113.10`) |
| Local port | `8787` |
| Node binary | resolved from asdf in step 1 |

> **One owner controls this endpoint and every configured Vault.** The current configuration schema
> requires `owner.allowedVaults` to contain every ID in `vaults`. The owner's one strong passphrase
> unlocks that complete allowed set. Run a separate service instance and configuration for a
> different trust boundary; do not add a second owner to this file.

---

## Step 1 — Clone, build, and resolve the node path (as the run user)

Run as `youruser` (not root). Building bundles the SDK + Express + everything into a single
`dist/index.js`, so no `node_modules` is needed at runtime.

```bash
cd ~
git clone https://github.com/bepitulaz/obsidian-multivault-mcp.git obsidian-multivault-mcp
cd ~/obsidian-multivault-mcp
npm ci
npm run build          # -> dist/index.js
npm run smoke:http     # optional: verifies tools + the full OAuth handshake locally

# Resolve a concrete node binary that works under systemd (no asdf env at runtime):
asdf which node        # copy this path; used as <NODE_BIN> below
```

Take the output of `asdf which node` (something like
`/home/youruser/.asdf/installs/nodejs/20.x.y/bin/node`) and use it wherever `<NODE_BIN>` appears.
The bare asdf shim (`~/.asdf/shims/node`) often fails under systemd, so prefer the concrete path.

---

## Step 2 — Become root for the system setup

Everything from here writes to `/etc` or manages services. Enter an interactive root shell once so
sudo prompts for the password a single time:

```bash
sudo -i
```

The remaining blocks run as root.

---

## Step 3 — Service environment + owner configuration

**Environment** — `/etc/obsidian-multivault-mcp.env`:

```bash
cat > /etc/obsidian-multivault-mcp.env <<EOF
MCP_PUBLIC_URL=https://203-0-113-10.sslip.io
MCP_JWT_SECRET=$(openssl rand -hex 32)
MCP_CLIENTS_FILE=/home/youruser/obsidian-multivault-mcp/oauth-clients.json
EOF
chmod 600 /etc/obsidian-multivault-mcp.env
```

- `MCP_PUBLIC_URL` — public origin; used as the OAuth issuer and token audience. No trailing slash.
- `MCP_JWT_SECRET` — signs access/refresh tokens. Rotating it + restarting revokes all tokens.
- `MCP_CLIENTS_FILE` — where Dynamic Client Registrations persist across restarts.

Do not set `MCP_USERS_FILE`; current HTTP startup rejects that legacy variable. The systemd unit in
step 4 sets `MCP_CONFIG_FILE` to a private credential copy of the owner configuration below.

**Knowledge configuration** — `/etc/obsidian-multivault-mcp.json`. First confirm both owner-controlled
Vault roots exist, then save one new strong owner passphrase in the owner's approved password manager
and enter it without echoing it. The script writes
the current `dataDir`, `owner`, `vaults`, and `organizer` schema directly; it does not print the
passphrase or place it in command history:

```bash
test -d /home/youruser/personal-vault
test -d /home/youruser/work-vault
install -d -o youruser -g youruser -m 700 /home/youruser/obsidian-multivault-mcp/data
install -o root -g root -m 600 /dev/null /etc/obsidian-multivault-mcp.json
read -rsp 'Owner passphrase (minimum 16 characters): ' brain_owner_passphrase
echo
BRAIN_OWNER_PASSPHRASE="$brain_owner_passphrase" <NODE_BIN> --input-type=commonjs <<'NODE'
const { writeFileSync } = require("node:fs");
const passphrase = process.env.BRAIN_OWNER_PASSPHRASE ?? "";
if (passphrase.length < 16) throw new Error("owner passphrase must contain at least 16 characters");
const config = {
  dataDir: "/home/youruser/obsidian-multivault-mcp/data",
  owner: {
    id: "owner",
    passphrase,
    allowedVaults: ["personal", "work"],
  },
  vaults: [
    { id: "personal", root: "/home/youruser/personal-vault" },
    { id: "work", root: "/home/youruser/work-vault" },
  ],
  organizer: {
    enabledVaults: ["personal", "work"],
    mode: "disabled",
    autoApplyConfidence: 0.90,
  },
};
writeFileSync("/etc/obsidian-multivault-mcp.json", `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
NODE
unset brain_owner_passphrase BRAIN_OWNER_PASSPHRASE
chown root:root /etc/obsidian-multivault-mcp.json
chmod 600 /etc/obsidian-multivault-mcp.json
stat -c '%U %G %a %n' /etc/obsidian-multivault-mcp.json
```

Replace `<NODE_BIN>` with the concrete path from step 1 before running the block. If you configure
only one Vault, remove the other entry from all three arrays: `owner.allowedVaults`, `vaults`, and
`organizer.enabledVaults`. `owner.allowedVaults` must name every configured Vault. The first
deployment deliberately uses `organizer.mode: "disabled"`, so it needs no provider and exposes only
the six knowledge tools.

### Organizer provider file

Keep provider settings in a separate root-owned file. Create the file without putting a sample or
real secret in this runbook or shell output:

```bash
install -o root -g root -m 600 /dev/null /etc/brain-organizer.env
sudoedit /etc/brain-organizer.env
stat -c '%U %G %a %n' /etc/brain-organizer.env
```

The file is `/etc/brain-organizer.env`, must remain owned by `root:root` with permissions `600`, and
holds `ORGANIZER_PROVIDER`, `DASHSCOPE_API_KEY`, `DASHSCOPE_BASE_URL`, and `DASHSCOPE_MODEL`. Enter
the real provider key only in that file. Never paste it into the repository, an Obsidian note, a run
report, command output, or incident ticket. Add this line to the systemd service alongside the main
environment file:

```ini
EnvironmentFile=-/etc/brain-organizer.env
```

Leave the file empty for the initial provider-disabled deployment. To enable organization later,
edit this file and add the four real assignments, change `organizer.mode` in
`/etc/obsidian-multivault-mcp.json` to `"dry-run"`, then restart the service. `DASHSCOPE_BASE_URL`
must be an official DashScope HTTPS endpoint. Never enable `automatic` for the initial seven-day
trial. The leading `-` on `EnvironmentFile` permits the disabled deployment to start if the empty
provider file is removed; an enabled organizer must have every required provider setting.

---

## Step 4 — systemd unit `/etc/systemd/system/obsidian-multivault-mcp.service`

Replace `<NODE_BIN>` with the path from step 1. (Written with a quoted heredoc, so paste the real
path in first — or edit the file afterward.)

```bash
cat > /etc/systemd/system/obsidian-multivault-mcp.service <<'EOF'
[Unit]
Description=Obsidian Multivault MCP (Streamable HTTP)
After=network-online.target
Wants=network-online.target

[Service]
User=youruser
WorkingDirectory=/home/youruser/obsidian-multivault-mcp
EnvironmentFile=/etc/obsidian-multivault-mcp.env
EnvironmentFile=-/etc/brain-organizer.env
LoadCredential=knowledge-config.json:/etc/obsidian-multivault-mcp.json
Environment=MCP_CONFIG_FILE=%d/knowledge-config.json
ExecStart=<NODE_BIN> /home/youruser/obsidian-multivault-mcp/dist/index.js --http --port 8787 --host 127.0.0.1
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/home/youruser/personal-vault /home/youruser/work-vault /home/youruser/obsidian-multivault-mcp

[Install]
WantedBy=multi-user.target
EOF

# substitute the resolved node path (edit if your asdf path differs):
sed -i "s#<NODE_BIN>#$(sudo -u youruser bash -lc 'asdf which node')#" /etc/systemd/system/obsidian-multivault-mcp.service
```

Notes:
- No vault path belongs on `ExecStart`; `MCP_CONFIG_FILE` selects the Vault registry. `%d` expands to
  systemd's private credential directory, where `LoadCredential` makes the root-owned mode-600
  source configuration readable by this unprivileged service without changing its ownership.
- `ProtectSystem=strict` makes the whole filesystem read-only except `ReadWritePaths` — list
  **every** configured Vault plus the app/data dir (for `oauth-clients.json`, the search index,
  organizer state, reports, and recovery). Add or remove Vault paths together with the configuration.
- Include exactly the configured Vault roots and `dataDir` in
  `ReadWritePaths`; do not widen the writable boundary. The portable transaction protections assume
  these are owner-controlled paths. An actor running with the same OS identity as the service is
  inside that trust boundary, so stop the service before operator recovery or manual namespace work.

---

## Step 5 — Install Caddy (Debian/Ubuntu)

```bash
apt-get update
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
```

---

## Step 6 — Caddyfile `/etc/caddy/Caddyfile`

```bash
cat > /etc/caddy/Caddyfile <<'EOF'
203-0-113-10.sslip.io {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1        # do NOT buffer — required for the long-lived SSE stream
        transport http {
            read_timeout 0       # allow idle SSE streams to stay open
        }
    }
}
EOF
```

Caddy forwards all headers by default, so `Authorization`, `mcp-session-id`, `Accept`, and
`MCP-Protocol-Version` pass through untouched. `flush_interval -1` is essential — without it the SSE
stream gets buffered and the connector stalls.

---

## Step 7 — Start everything and open the firewall

```bash
systemctl daemon-reload
systemctl enable --now obsidian-multivault-mcp
systemctl reload caddy || systemctl restart caddy

# open the host firewall if ufw is active
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp && ufw allow 443/tcp
fi
```

---

## Step 8 — Verify

```bash
# local (on the VPS): both services active, node health 200
systemctl --no-pager --lines=4 status obsidian-multivault-mcp caddy
curl -s -o /dev/null -w "local health: %{http_code}\n" localhost:8787/healthz    # want 200
```

From anywhere on the internet (first request may take a few seconds while Caddy fetches the cert):

```bash
curl -i https://203-0-113-10.sslip.io/healthz            # want: 200  ok
curl -i -X POST https://203-0-113-10.sslip.io/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# want: HTTP/2 401  with a  WWW-Authenticate: Bearer ... resource_metadata="..."  header
```

`200 ok` on `/healthz` and `401` + `WWW-Authenticate` on `/mcp` means TLS, the proxy, and the OAuth
gate are all working. You're ready to connect Claude.

If the owner configuration enables the organizer, verify the same OAuth/HTTPS path and the exact
tool surface from the checked-out release before going public:

```bash
SMOKE_EXPECT_ORGANIZER_TOOLS=1 npm run smoke:http
```

This must report exactly 13 tools. With no organizer configured (or with its mode set to
`disabled`), the normal smoke test must report exactly the six knowledge tools.

---

## Step 9 — Connect Claude (mobile + desktop)

Custom connectors are **account-level**. The configured owner adds the URL once in that owner's
Claude account, and it works across claude.ai, Desktop, and mobile. That identity receives the full
Vault set named by `owner.allowedVaults`.

1. In Claude (**Settings → Connectors** → **Add custom connector**):
   - URL: `https://203-0-113-10.sslip.io/mcp`
   - Leave Advanced settings (OAuth Client ID/Secret) **blank** — the server supports Dynamic Client
     Registration.
2. Click **Add** → a browser opens → enter the owner passphrase saved during step 3. You log in once;
   Anthropic's cloud holds the token and reconnects. Confirm `list_vaults` returns exactly
   `personal` and `work` before writing anything.
3. **Replace the Desktop SSH server (optional):** on the Mac, edit
   `~/Library/Application Support/Claude/claude_desktop_config.json` and delete the `obsidian-multivault`
   entry under `mcpServers`, then restart Claude Desktop. (Keep a backup first.)

> A second person or a different Vault trust boundary needs a separate service instance, owner
> configuration, and connector URL. Do not add another owner or share this passphrase.

---

## Updating later

```bash
cd ~/obsidian-multivault-mcp
git pull
npm ci
npm run build
sudo systemctl restart obsidian-multivault-mcp
```

Caddy and the env file are one-time setup; only reload Caddy (`sudo systemctl reload caddy`) if you
change the Caddyfile.

---

## Brain organizer operations and recovery

For every area, read `000_AI_WORK_GUIDE.md`, then `000_Home_MOC.md`, then the area's
`99_작업가이드_다음AI용.md`, and finally that area's `000_*_MOC.md`. Do not apply a proposal before
the root and area-specific rules have been reviewed.

- `dry-run` scans stable Inbox notes and records proposals/reports without moving sources.
- A requested `automatic` run is forced to dry-run during the first seven days. After that, only a
  safe proposal at or above `0.90` can move automatically. Medium- and low-confidence notes remain
  in place.
- Secret-bearing notes are stopped before the provider sees them. They remain local and
  byte-for-byte unchanged; sync-conflict copies are skipped and unchanged as well.

The MCP operator flow is `list_inbox_notes` → `propose_organization` → review the returned source,
destination, reason, and confidence → `apply_organization`. Save the returned transaction ID. Use
`undo_organization` with that ID to restore the exact source and managed MOC state. Run
`audit_vault` after apply and after recovery; it returns structural findings without note bodies.

Run reports are stored in the Vault at
`60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports/<run-id>.json`. Private recovery snapshots are
under `<dataDir>/organizer-recovery/<transaction-id>/`, and audit actions are in
`<dataDir>/audit.jsonl`. Do not manually edit recovery snapshots while the service runs. Preserve
the owner-controlled filesystem boundary: recovery never requires broader Vault access or another
native dependency.

To disable the organizer immediately:

1. Run `sudoedit /etc/obsidian-multivault-mcp.json` and set `organizer.mode` to `disabled` in the
   root-owned source configuration selected by the unit's `LoadCredential` line.
2. Run `sudo systemctl restart obsidian-multivault-mcp`; systemd refreshes the private
   `MCP_CONFIG_FILE` credential copy from that source file.
3. Confirm the service is active, the Vault is unchanged, and MCP lists exactly the six knowledge
   tools. The seven organizer tools must be absent.

Disabling does not delete reports, audit history, proposals, or recovery snapshots. Keep those files
for diagnosis and exact undo; remove nothing recursively during incident response.

---

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `curl :443` refuses instantly from outside | Nothing on 443 → Caddy not running. `systemctl status caddy`, `journalctl -u caddy -n 40`. |
| `curl :443` hangs/times out | Firewall dropping packets → open 80+443 (host `ufw` and cloud firewall). |
| `journalctl -u caddy` shows an ACME/cert error | Port 80 or 443 not reachable from the internet, or DNS not resolving. Confirm `dig +short 203-0-113-10.sslip.io` → `203.0.113.10`. |
| `obsidian-multivault-mcp` fails: `node: command not found` / version error | asdf shim not resolving under systemd → put the concrete `asdf which node` path in `ExecStart`, `daemon-reload`, restart. |
| `obsidian-multivault-mcp` fails: `requires MCP_JWT_SECRET` | `/etc/obsidian-multivault-mcp.env` missing/unreadable → check it exists, mode 600, and `EnvironmentFile=` path matches. |
| Startup reports `MCP_CONFIG_FILE` missing or the knowledge config is unreadable | Confirm `LoadCredential=knowledge-config.json:/etc/obsidian-multivault-mcp.json`, `Environment=MCP_CONFIG_FILE=%d/knowledge-config.json`, and source ownership/mode `root root 600`; then run `daemon-reload` and restart. |
| Startup reports an unknown Vault or incomplete owner access | Fix `/etc/obsidian-multivault-mcp.json`: every `owner.allowedVaults` ID must exist in `vaults`, and the owner must be allowed every configured Vault. Restart to refresh the credential copy. |
| A Vault write fails | `ProtectSystem=strict` may be blocking a configured root or `dataDir`; make the matching minimal `ReadWritePaths` correction without widening access elsewhere. |
| Organizer tools fail while knowledge tools work | Keep `organizer.mode` disabled until `/etc/brain-organizer.env` contains all four required provider assignments and has `root root 600`; then enable `dry-run` and restart. |
| `/healthz` 200 locally but 502 through Caddy | Caddy up but node down, or wrong upstream port → confirm `ExecStart` port matches the Caddyfile `reverse_proxy` port (8787). |
| Want to revoke all sessions | Change `MCP_JWT_SECRET` in `/etc/obsidian-multivault-mcp.env`, then `sudo systemctl restart obsidian-multivault-mcp`. |

## Security notes (public endpoint is read + write)

- The owner passphrase lives only in the root-owned mode-600
  `/etc/obsidian-multivault-mcp.json`; systemd presents a private credential copy to the service.
  The JWT signing secret lives only in the mode-600 `/etc/obsidian-multivault-mcp.env`, and the
  provider key lives only in root-owned mode-600 `/etc/brain-organizer.env`.
- Access tokens are short-lived (1h) JWTs; rotate `MCP_JWT_SECRET` to revoke everything at once.
- The Node service binds `127.0.0.1` only — Caddy is the sole public listener, always over HTTPS.
- Consider `--read-only` on the public service if you don't need mobile writes; the trusted Desktop
  SSH path can retain full write access.
