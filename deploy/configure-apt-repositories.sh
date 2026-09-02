#!/usr/bin/env bash
set -euo pipefail
umask 077

brain_apt_root=${BRAIN_APT_ROOT:-}
brain_etc_dir="$brain_apt_root/etc"
brain_usr_dir="$brain_apt_root/usr"

mkdir -p \
  "$brain_etc_dir/apt/keyrings" \
  "$brain_etc_dir/apt/sources.list.d" \
  "$brain_etc_dir/apt/preferences.d" \
  "$brain_usr_dir/share/keyrings"
chmod 0755 \
  "$brain_etc_dir/apt/keyrings" \
  "$brain_etc_dir/apt/sources.list.d" \
  "$brain_etc_dir/apt/preferences.d" \
  "$brain_usr_dir/share/keyrings"

curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
  gpg --batch --yes --dearmor -o "$brain_etc_dir/apt/keyrings/nodesource.gpg"
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
  >"$brain_etc_dir/apt/sources.list.d/nodesource.list"

curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
  gpg --batch --yes --dearmor -o "$brain_usr_dir/share/keyrings/caddy-stable-archive-keyring.gpg"
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  >"$brain_etc_dir/apt/sources.list.d/caddy-stable.list"

curl -fsSL -o "$brain_etc_dir/apt/keyrings/syncthing-archive-keyring.gpg" https://syncthing.net/release-key.gpg
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/syncthing-archive-keyring.gpg] https://apt.syncthing.net/ syncthing stable-v2' \
  >"$brain_etc_dir/apt/sources.list.d/syncthing.list"
printf '%s\n' 'Package: *' 'Pin: origin apt.syncthing.net' 'Pin-Priority: 990' \
  >"$brain_etc_dir/apt/preferences.d/syncthing.pref"

chmod 0644 \
  "$brain_etc_dir/apt/keyrings/nodesource.gpg" \
  "$brain_usr_dir/share/keyrings/caddy-stable-archive-keyring.gpg" \
  "$brain_etc_dir/apt/keyrings/syncthing-archive-keyring.gpg" \
  "$brain_etc_dir/apt/sources.list.d/nodesource.list" \
  "$brain_etc_dir/apt/sources.list.d/caddy-stable.list" \
  "$brain_etc_dir/apt/sources.list.d/syncthing.list" \
  "$brain_etc_dir/apt/preferences.d/syncthing.pref"
