#!/usr/bin/env bash
set -euo pipefail
umask 077

brain_organizer_json='{"enabledVaults":["brain"],"mode":"disabled","minStableSeconds":300,"autoApplyConfidence":0.9,"maxNotesPerRun":20,"maxNoteBytes":131072,"maxContextBytes":262144,"proposalTtlHours":24,"recoveryDays":30,"reportsDirectory":"60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports"}'

brain_render_config() {
  local brain_config_file=$1
  local brain_passphrase=$2
  local brain_ids=$3
  if [[ -f "$brain_config_file" ]]; then
    jq \
      --argjson organizer "$brain_organizer_json" \
      '.organizer = $organizer' \
      "$brain_config_file"
  else
    jq -n \
      --arg passphrase "$brain_passphrase" \
      --argjson ids "$brain_ids" \
      --argjson organizer "$brain_organizer_json" \
      '{
        dataDir: "/srv/brain/data",
        owner: {id: "owner", passphrase: $passphrase, allowedVaults: $ids},
        vaults: [$ids[] | {id: ., root: ("/srv/brain/vaults/" + .)}],
        organizer: $organizer
      }'
  fi
}

if [[ ${BRAIN_INSTALL_CONFIG_TEST_MODE:-} == 1 ]]; then
  brain_install_test_root=${BRAIN_INSTALL_TEST_ROOT:-}
  [[ ${NODE_ENV:-} == test && -d "$brain_install_test_root" \
    && -f "$brain_install_test_root/.brain-install-config-test-root" ]] || {
    echo "invalid installer config test root" >&2
    exit 1
  }
  brain_install_test_root=$(cd -- "$brain_install_test_root" && pwd -P)
  [[ "$brain_install_test_root" != / ]] || { echo "unsafe installer config test root" >&2; exit 1; }
  brain_test_config="$brain_install_test_root/brain-mcp-config.json"
  [[ -f "$brain_test_config" ]] || { echo "missing installer config test fixture" >&2; exit 1; }
  brain_test_config_tmp=$(mktemp "$brain_install_test_root/brain-mcp-config.json.tmp.XXXXXX")
  trap 'rm -f -- "$brain_test_config_tmp"' EXIT
  brain_render_config "$brain_test_config" "unused-test-passphrase" '["brain"]' >"$brain_test_config_tmp"
  mv -f -- "$brain_test_config_tmp" "$brain_test_config"
  trap - EXIT
  exit 0
elif [[ -n ${BRAIN_INSTALL_CONFIG_TEST_MODE:-}${BRAIN_INSTALL_TEST_ROOT:-} ]]; then
  echo "invalid installer config test mode" >&2
  exit 1
fi

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
bash "$RELEASE_DIR/deploy/configure-apt-repositories.sh"

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
chown -R root:brain /opt/brain-mcp
chmod -R u=rwX,g=rX,o= /opt/brain-mcp

if [[ ! -f /opt/brain-mcp/oauth-clients.json ]]; then
  install -o brain -g brain -m 0600 /dev/null /opt/brain-mcp/oauth-clients.json
else
  chown brain:brain /opt/brain-mcp/oauth-clients.json
  chmod 600 /opt/brain-mcp/oauth-clients.json
fi

install -d -o brain -g brain -m 0700 /srv/brain/data /srv/brain/backups /srv/brain/syncthing /srv/brain/vaults
install -d -o brain -g brain -m 0700 /srv/brain/data/organizer
for brain_vault_id in "${brain_vault_ids[@]}"; do
  install -d -o brain -g brain -m 0700 \
    "/srv/brain/vaults/$brain_vault_id" \
    "/srv/brain/vaults/$brain_vault_id/Agent-Inbox" \
    "/srv/brain/vaults/$brain_vault_id/.stfolder"
done

if [[ ! -f /etc/brain-organizer.env ]]; then
  install -o root -g brain -m 0640 deploy/brain-organizer.env.example /etc/brain-organizer.env
else
  chown root:brain /etc/brain-organizer.env
  chmod 0640 /etc/brain-organizer.env
fi

if [[ -f /etc/brain-mcp.env ]]; then
  brain_jwt_secret=$(sed -n 's/^MCP_JWT_SECRET=//p' /etc/brain-mcp.env)
else
  brain_jwt_secret=$(openssl rand -hex 32)
fi
if [[ -f /root/brain-mcp-owner-passphrase.txt ]]; then
  brain_owner_passphrase=$(tr -d '\r\n' </root/brain-mcp-owner-passphrase.txt)
elif [[ -f /etc/brain-mcp-config.json ]]; then
  brain_owner_passphrase=$(jq -r '.owner.passphrase // empty' /etc/brain-mcp-config.json)
else
  brain_owner_passphrase=$(openssl rand -base64 36 | tr -d '\r\n')
fi
[[ ${#brain_jwt_secret} -eq 64 && ${#brain_owner_passphrase} -ge 32 ]] || {
  echo "invalid retained secret" >&2
  exit 1
}
if [[ ! -f /root/brain-mcp-owner-passphrase.txt ]]; then
  printf '%s\n' "$brain_owner_passphrase" >/root/brain-mcp-owner-passphrase.txt
  chmod 600 /root/brain-mcp-owner-passphrase.txt
fi

{
  printf 'MCP_PUBLIC_URL=https://%s\n' "$PUBLIC_HOST"
  printf 'MCP_JWT_SECRET=%s\n' "$brain_jwt_secret"
  printf '%s\n' 'MCP_CLIENTS_FILE=/opt/brain-mcp/oauth-clients.json'
  printf '%s\n' 'MCP_CONFIG_FILE=/etc/brain-mcp-config.json' 'NODE_ENV=production'
} >/etc/brain-mcp.env
chmod 600 /etc/brain-mcp.env

brain_vault_json=$(printf '%s\n' "${brain_vault_ids[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')
brain_config_tmp=$(mktemp /etc/brain-mcp-config.json.tmp.XXXXXX)
trap 'rm -f -- "$brain_config_tmp"' EXIT
brain_render_config /etc/brain-mcp-config.json "$brain_owner_passphrase" "$brain_vault_json" >"$brain_config_tmp"
install -o brain -g brain -m 0600 "$brain_config_tmp" /etc/brain-mcp-config.json
rm -f -- "$brain_config_tmp"
trap - EXIT
chown brain:brain /etc/brain-mcp-config.json
chmod 600 /etc/brain-mcp-config.json

install -o root -g root -m 0644 deploy/brain-mcp.service /etc/systemd/system/brain-mcp.service
install -o root -g root -m 0644 deploy/brain-syncthing.service /etc/systemd/system/brain-syncthing.service
install -o root -g root -m 0644 deploy/brain-organizer.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/brain-organizer.timer /etc/systemd/system/
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
bash "$RELEASE_DIR/deploy/configure-firewall.sh"

systemctl daemon-reload
systemctl enable --now brain-syncthing
BRAIN_VAULT_IDS="$brain_vault_csv" /usr/local/sbin/brain-syncthing-configure
caddy validate --config /etc/caddy/Caddyfile
systemctl enable brain-mcp caddy brain-mcp-backup.timer brain-organizer.timer
systemctl restart brain-mcp caddy
systemctl start brain-mcp-backup.timer

printf '%s\n' 'Owner passphrase: /root/brain-mcp-owner-passphrase.txt'
printf '%s\n' 'Syncthing server device ID: /root/brain-syncthing-device-id.txt'
printf '%s\n' 'Syncthing GUI remains private at 127.0.0.1:8384 (use an SSH tunnel)'
