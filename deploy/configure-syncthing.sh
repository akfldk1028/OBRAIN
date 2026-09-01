#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }

brain_vault_csv=${BRAIN_VAULT_IDS:-brain}
IFS=',' read -r -a brain_vault_ids <<<"$brain_vault_csv"
[[ ${#brain_vault_ids[@]} -gt 0 ]] || { echo "at least one vault id is required" >&2; exit 1; }
for brain_vault_id in "${brain_vault_ids[@]}"; do
  [[ "$brain_vault_id" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || {
    echo "invalid vault id: $brain_vault_id" >&2
    exit 1
  }
done

brain_syncthing_url=http://127.0.0.1:8384
brain_syncthing_config=/srv/brain/syncthing/config.xml
for _brain_attempt in $(seq 1 60); do
  if curl -fsS "$brain_syncthing_url/rest/noauth/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "$brain_syncthing_url/rest/noauth/health" >/dev/null

brain_api_key=$(sed -n 's#.*<apikey>\([^<]*\)</apikey>.*#\1#p' "$brain_syncthing_config" | head -n 1)
[[ -n "$brain_api_key" ]] || { echo "Syncthing API key was not generated" >&2; exit 1; }

brain_tmp_dir=$(mktemp -d)
trap 'rm -rf -- "$brain_tmp_dir"' EXIT

brain_api() {
  local brain_method=$1
  local brain_path=$2
  local brain_payload=${3:-}
  if [[ -n "$brain_payload" ]]; then
    curl -fsS -X "$brain_method" \
      -H "X-API-Key: $brain_api_key" \
      -H 'Content-Type: application/json' \
      --data-binary "@$brain_payload" \
      "$brain_syncthing_url$brain_path"
  else
    curl -fsS -X "$brain_method" \
      -H "X-API-Key: $brain_api_key" \
      "$brain_syncthing_url$brain_path"
  fi
}

brain_device_id=$(brain_api GET /rest/system/status | jq -r '.myID')
[[ "$brain_device_id" =~ ^[A-Z0-9-]+$ ]] || { echo "invalid local Syncthing device id" >&2; exit 1; }

# The stock Default Folder is never used on the server.
if brain_api GET /rest/config/folders/default >/dev/null 2>&1; then
  brain_api DELETE /rest/config/folders/default >/dev/null
fi

jq -n '{
  maxFolderConcurrency: 1,
  databaseTuning: "small",
  maxConcurrentIncomingRequestKiB: 32768,
  progressUpdateIntervalS: -1
}' >"$brain_tmp_dir/options.json"
brain_api PATCH /rest/config/options "$brain_tmp_dir/options.json" >/dev/null

for brain_vault_id in "${brain_vault_ids[@]}"; do
  brain_vault_path="/srv/brain/vaults/$brain_vault_id"
  brain_folder_json="$brain_tmp_dir/$brain_vault_id.json"

  if brain_api GET "/rest/config/folders/$brain_vault_id" >"$brain_tmp_dir/existing.json" 2>/dev/null; then
    jq -n \
      --arg label "Obsidian - $brain_vault_id" \
      --arg path "$brain_vault_path" \
      '{
        label: $label,
        path: $path,
        type: "sendreceive",
        rescanIntervalS: 3600,
        fsWatcherEnabled: true,
        fsWatcherDelayS: 10,
        ignorePerms: true,
        versioning: {
          type: "staggered",
          params: {maxAge: "7776000"},
          cleanupIntervalS: 3600,
          fsPath: "",
          fsType: "basic"
        },
        copiers: 1,
        hashers: 1,
        pullerMaxPendingKiB: 16384,
        scanProgressIntervalS: -1,
        maxConcurrentWrites: 1,
        caseSensitiveFS: true
      }' >"$brain_folder_json"
    brain_api PATCH "/rest/config/folders/$brain_vault_id" "$brain_folder_json" >/dev/null
  else
    brain_api GET /rest/config/defaults/folder >"$brain_tmp_dir/template.json"
    jq \
      --arg id "$brain_vault_id" \
      --arg label "Obsidian - $brain_vault_id" \
      --arg path "$brain_vault_path" \
      --arg device "$brain_device_id" \
      '.id = $id |
       .label = $label |
       .path = $path |
       .type = "sendreceive" |
       .devices = [{deviceID: $device, introducedBy: "", encryptionPassword: ""}] |
       .rescanIntervalS = 3600 |
       .fsWatcherEnabled = true |
       .fsWatcherDelayS = 10 |
       .ignorePerms = true |
       .versioning = {
         type: "staggered",
         params: {maxAge: "7776000"},
         cleanupIntervalS: 3600,
         fsPath: "",
         fsType: "basic"
       } |
       .copiers = 1 |
       .hashers = 1 |
       .pullerMaxPendingKiB = 16384 |
       .scanProgressIntervalS = -1 |
       .maxConcurrentWrites = 1 |
       .caseSensitiveFS = true' \
      "$brain_tmp_dir/template.json" >"$brain_folder_json"
    brain_api POST /rest/config/folders "$brain_folder_json" >/dev/null
  fi

  jq -n '{lines: [
    "(?d).obsidian/workspace.json",
    "(?d).obsidian/workspace-mobile.json",
    "(?d).obsidian/cache",
    "(?d).trash",
    "(?d).DS_Store",
    "(?d)Thumbs.db"
  ]}' >"$brain_tmp_dir/ignores.json"
  brain_api PUT "/rest/db/ignores?folder=$brain_vault_id" "$brain_tmp_dir/ignores.json" >/dev/null
done

printf '%s\n' "$brain_device_id" >/root/brain-syncthing-device-id.txt
chmod 600 /root/brain-syncthing-device-id.txt

if [[ $(brain_api GET /rest/config/restart-required | jq -r '.requiresRestart') == true ]]; then
  systemctl restart brain-syncthing
fi

printf '%s\n' 'Syncthing folders configured; server device ID is stored in /root/brain-syncthing-device-id.txt'
