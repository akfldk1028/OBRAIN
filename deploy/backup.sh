#!/usr/bin/env bash
set -euo pipefail
umask 077

brain_stamp=$(date -u +%Y%m%dT%H%M%SZ)
if [[ ${BRAIN_BACKUP_TEST_MODE:-} == 1 ]]; then
  brain_backup_test_root=${BRAIN_BACKUP_TEST_ROOT:-}
  [[ ${NODE_ENV:-} == test && -d "$brain_backup_test_root" \
    && -f "$brain_backup_test_root/.brain-backup-test-root" ]] || {
    echo "invalid backup test root" >&2
    exit 1
  }
  brain_canonical_backup_test_root=$(cd -- "$brain_backup_test_root" && pwd -P)
  [[ "$brain_canonical_backup_test_root" != / ]] || { echo "unsafe backup test root" >&2; exit 1; }
  brain_allowed_archive_root="$brain_canonical_backup_test_root/srv/brain/backups"
  brain_archive_root="$brain_backup_test_root/srv/brain/backups"
  brain_vault_root="$brain_backup_test_root/srv/brain"
  brain_data_root="$brain_backup_test_root/srv/brain/data"
  brain_config_file="$brain_backup_test_root/etc/brain-mcp-config.json"
elif [[ -n ${BRAIN_BACKUP_TEST_MODE:-}${BRAIN_BACKUP_TEST_ROOT:-} ]]; then
  echo "invalid backup test mode" >&2
  exit 1
else
  brain_archive_root=/srv/brain/backups
  brain_allowed_archive_root=/srv/brain/backups
  brain_vault_root=/srv/brain
  brain_data_root=/srv/brain/data
  brain_config_file=/etc/brain-mcp-config.json
fi

mkdir -p "$brain_archive_root"
brain_canonical_archive_root=$(cd -- "$brain_archive_root" && pwd -P)
[[ "$brain_canonical_archive_root" == "$brain_allowed_archive_root" ]] || {
  echo "unsafe backup archive root" >&2
  exit 1
}
brain_backup_dest="$brain_archive_root/$brain_stamp"
[[ -n "$brain_archive_root" && "$brain_archive_root" != / && "$brain_backup_dest" == "$brain_archive_root/"* ]] || {
  echo "unsafe backup destination" >&2
  exit 1
}
mkdir -p "$brain_backup_dest"
tar --xattrs --acls -C "$brain_vault_root" -czf "$brain_backup_dest/vaults.tgz" vaults
if [[ -d "$brain_data_root/organizer" ]]; then
  tar --xattrs --acls -C "$brain_data_root" -czf "$brain_backup_dest/organizer-state.tgz" organizer
fi
install -m 600 "$brain_config_file" "$brain_backup_dest/config.json"

mapfile -d '' brain_expired_backups < <(
  find "$brain_archive_root" -mindepth 1 -maxdepth 1 -type d -mtime +13 -print0
)
for brain_old_backup in "${brain_expired_backups[@]}"; do
  [[ "$brain_old_backup" == "$brain_archive_root/"* ]] || {
    echo "unsafe retention target" >&2
    exit 1
  }
  rm -rf -- "$brain_old_backup"
done
