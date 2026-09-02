#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }

brain_rules_v4=${BRAIN_IPTABLES_RULES_V4:-/etc/iptables/rules.v4}
brain_reject_rule='-A INPUT -j REJECT --reject-with icmp-host-prohibited'

brain_allow_runtime() {
  local brain_protocol=$1
  local brain_port=$2
  if iptables -C INPUT -p "$brain_protocol" -m "$brain_protocol" --dport "$brain_port" -j ACCEPT 2>/dev/null; then
    return
  fi

  local brain_reject_position
  brain_reject_position=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')
  if [[ -n "$brain_reject_position" ]]; then
    iptables -I INPUT "$brain_reject_position" -p "$brain_protocol" -m "$brain_protocol" --dport "$brain_port" -j ACCEPT
  else
    iptables -A INPUT -p "$brain_protocol" -m "$brain_protocol" --dport "$brain_port" -j ACCEPT
  fi
}

brain_persist_rule() {
  local brain_rule=$1
  [[ -f "$brain_rules_v4" ]] || return
  grep -Fqx -- "$brain_rule" "$brain_rules_v4" && return

  local brain_tmp_rules
  brain_tmp_rules=$(mktemp "${brain_rules_v4}.tmp.XXXXXX")
  awk -v rule="$brain_rule" -v reject="$brain_reject_rule" '
    !inserted && $0 == reject { print rule; inserted = 1 }
    !inserted && $0 == "COMMIT" { print rule; inserted = 1 }
    { print }
    END { if (!inserted) print rule }
  ' "$brain_rules_v4" >"$brain_tmp_rules"
  chmod 0644 "$brain_tmp_rules"
  mv "$brain_tmp_rules" "$brain_rules_v4"
}

brain_allow_runtime tcp 80
brain_allow_runtime tcp 443
brain_allow_runtime tcp 22000
brain_allow_runtime udp 22000

brain_persist_rule '-A INPUT -p tcp -m tcp --dport 80 -j ACCEPT'
brain_persist_rule '-A INPUT -p tcp -m tcp --dport 443 -j ACCEPT'
brain_persist_rule '-A INPUT -p tcp -m tcp --dport 22000 -j ACCEPT'
brain_persist_rule '-A INPUT -p udp -m udp --dport 22000 -j ACCEPT'
