#!/usr/bin/env bash
set -euo pipefail
umask 077

brain_stamp=$(date -u +%Y%m%dT%H%M%SZ)
brain_archive_root=/srv/brain/backups
brain_backup_dest="$brain_archive_root/$brain_stamp"
[[ "$brain_backup_dest" == /srv/brain/backups/* ]] || {
  echo "unsafe backup destination" >&2
  exit 1
}
mkdir -p "$brain_archive_root"
mkdir -p "$brain_backup_dest"
tar --xattrs --acls -C /srv/brain -czf "$brain_backup_dest/vaults.tgz" vaults
install -m 600 /etc/brain-mcp-config.json "$brain_backup_dest/config.json"

mapfile -d '' brain_expired_backups < <(
  find "$brain_archive_root" -mindepth 1 -maxdepth 1 -type d -mtime +13 -print0
)
for brain_old_backup in "${brain_expired_backups[@]}"; do
  [[ "$brain_old_backup" == /srv/brain/backups/* ]] || {
    echo "unsafe retention target" >&2
    exit 1
  }
  rm -rf -- "$brain_old_backup"
done
