#!/usr/bin/env bash
# Stop agents started by run-agents.sh (all known roles, or just the named ones).
#   bash stop-agents.sh [role ...]
set -euo pipefail
cd "$(dirname "$0")"

ROLES=("$@"); [ ${#ROLES[@]} -eq 0 ] && ROLES=(facilitator scribe skeptic greeter)
for role in "${ROLES[@]}"; do
  pidf=".agents/$role.pid"
  [ -f "$pidf" ] || continue
  pid="$(cat "$pidf")"
  if kill "$pid" 2>/dev/null; then echo "✓ stopped $role (pid $pid)"; else echo "• $role not running"; fi
  rm -f "$pidf"
done
