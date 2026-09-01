#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
: "${PUBLIC_HOST:?PUBLIC_HOST is required}"
: "${RELEASE_DIR:?RELEASE_DIR is required}"
[[ "$PUBLIC_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "invalid PUBLIC_HOST" >&2; exit 1; }
[[ -f "$RELEASE_DIR/dist/index.js" && -f "$RELEASE_DIR/package-lock.json" ]] || {
  echo "invalid release directory" >&2
  exit 1
}

brain_vault_csv=${BRAIN_VAULT_IDS:-brain}
IFS=',' read -r -a brain_vault_ids <<<"$brain_vault_csv"
[[ ${#brain_vault_ids[@]} -gt 0 ]] || { echo "at least one vault id is required" >&2; exit 1; }
for brain_vault_id in "${brain_vault_ids[@]}"; do
  [[ "$brain_vault_id" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || {
    echo "invalid vault id: $brain_vault_id" >&2
    exit 1
  }
done

apt-get update
apt-get install -y ca-certificates curl gnupg jq openssl build-essential python3 ripgrep ufw
install -d -m 0755 /etc/apt/keyrings

curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
  >/etc/apt/sources.list.d/nodesource.list

curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  >/etc/apt/sources.list.d/caddy-stable.list

curl -fsSL -o /etc/apt/keyrings/syncthing-archive-keyring.gpg https://syncthing.net/release-key.gpg
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/syncthing-archive-keyring.gpg] https://apt.syncthing.net/ syncthing stable-v2' \
  >/etc/apt/sources.list.d/syncthing.list
printf '%s\n' 'Package: *' 'Pin: origin apt.syncthing.net' 'Pin-Priority: 990' \
  >/etc/apt/preferences.d/syncthing.pref

apt-get update
apt-get install -y nodejs caddy syncthing

if [[ -z $(swapon --show --noheadings) ]]; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
  fi
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || printf '%s\n' '/swapfile none swap sw 0 0' >>/etc/fstab
fi

id brain >/dev/null 2>&1 || useradd --system --home-dir /srv/brain --create-home --shell /usr/sbin/nologin brain
install -d -o root -g root -m 0755 /opt/brain-mcp
cp -a "$RELEASE_DIR/." /opt/brain-mcp/
cd /opt/brain-mcp
npm ci --omit=dev

if [[ ! -f /opt/brain-mcp/oauth-clients.json ]]; then
  install -o brain -g brain -m 0600 /dev/null /opt/brain-mcp/oauth-clients.json
else
  chown brain:brain /opt/brain-mcp/oauth-clients.json
  chmod 600 /opt/brain-mcp/oauth-clients.json
fi

install -d -o brain -g brain -m 0700 /srv/brain/data /srv/brain/backups /srv/brain/syncthing
for brain_vault_id in "${brain_vault_ids[@]}"; do
  install -d -o brain -g brain -m 0700 "/srv/brain/vaults/$brain_vault_id/Agent-Inbox"
done

if [[ -f /etc/brain-mcp.env ]]; then
  brain_jwt_secret=$(sed -n 's/^MCP_JWT_SECRET=//p' /etc/brain-mcp.env)
else
  brain_jwt_secret=$(openssl rand -hex 32)
fi
if [[ -f /root/brain-mcp-owner-passphrase.txt ]]; then
  brain_owner_passphrase=$(tr -d '\r\n' </root/brain-mcp-owner-passphrase.txt)
else
  brain_owner_passphrase=$(openssl rand -base64 36 | tr -d '\r\n')
  printf '%s\n' "$brain_owner_passphrase" >/root/brain-mcp-owner-passphrase.txt
  chmod 600 /root/brain-mcp-owner-passphrase.txt
fi
[[ ${#brain_jwt_secret} -eq 64 && ${#brain_owner_passphrase} -ge 32 ]] || {
  echo "invalid retained secret" >&2
  exit 1
}

{
  printf 'MCP_PUBLIC_URL=https://%s\n' "$PUBLIC_HOST"
  printf 'MCP_JWT_SECRET=%s\n' "$brain_jwt_secret"
  printf '%s\n' 'MCP_CLIENTS_FILE=/opt/brain-mcp/oauth-clients.json'
  printf '%s\n' 'MCP_CONFIG_FILE=/etc/brain-mcp-config.json' 'NODE_ENV=production'
} >/etc/brain-mcp.env
chmod 600 /etc/brain-mcp.env

brain_vault_json=$(printf '%s\n' "${brain_vault_ids[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')
jq -n \
  --arg passphrase "$brain_owner_passphrase" \
  --argjson ids "$brain_vault_json" \
  '{
    dataDir: "/srv/brain/data",
    owner: {id: "owner", passphrase: $passphrase, allowedVaults: $ids},
    vaults: [$ids[] | {id: ., root: ("/srv/brain/vaults/" + .)}]
  }' >/etc/brain-mcp-config.json
chown brain:brain /etc/brain-mcp-config.json
chmod 600 /etc/brain-mcp-config.json

install -o root -g root -m 0644 deploy/brain-mcp.service /etc/systemd/system/brain-mcp.service
install -o root -g root -m 0644 deploy/brain-syncthing.service /etc/systemd/system/brain-syncthing.service
sed "s/__PUBLIC_HOST__/$PUBLIC_HOST/g" deploy/Caddyfile >/etc/caddy/Caddyfile
chown root:caddy /etc/caddy/Caddyfile
chmod 640 /etc/caddy/Caddyfile
install -o root -g root -m 0755 deploy/configure-syncthing.sh /usr/local/sbin/brain-syncthing-configure
install -o root -g root -m 0755 deploy/backup.sh /usr/local/sbin/brain-mcp-backup
install -o root -g root -m 0644 deploy/brain-mcp-backup.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/brain-mcp-backup.timer /etc/systemd/system/

ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 22000/tcp
ufw allow 22000/udp
ufw --force enable

systemctl daemon-reload
systemctl enable --now brain-syncthing
BRAIN_VAULT_IDS="$brain_vault_csv" /usr/local/sbin/brain-syncthing-configure
caddy validate --config /etc/caddy/Caddyfile
systemctl enable brain-mcp caddy brain-mcp-backup.timer
systemctl restart brain-mcp caddy
systemctl start brain-mcp-backup.timer

printf '%s\n' 'Owner passphrase: /root/brain-mcp-owner-passphrase.txt'
printf '%s\n' 'Syncthing server device ID: /root/brain-syncthing-device-id.txt'
printf '%s\n' 'Syncthing GUI remains private at 127.0.0.1:8384 (use an SSH tunnel)'
