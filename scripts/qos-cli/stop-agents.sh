#!/usr/bin/env bash
# Stop agents started by run-agents.sh (all known roles, or just the named ones).
#   bash stop-agents.sh [role ...]
set -euo pipefail
cd "$(dirname "$0")"

# With no arguments, stop everything that has a pidfile — not a hardcoded list.
# The list used to be spelled out, so a role missing from it could not be stopped
# by name and survived every "stop all", outliving the agents around it.
# Whatever run-agents.sh (or a hand-started agent) recorded, this stops.
ROLES=("$@")
if [ ${#ROLES[@]} -eq 0 ]; then
  ROLES=()
  for f in .agents/*.pid; do [ -e "$f" ] || continue; ROLES+=("$(basename "$f" .pid)"); done
  [ ${#ROLES[@]} -eq 0 ] && { echo "nothing to stop"; exit 0; }
fi
for role in "${ROLES[@]}"; do
  pidf=".agents/$role.pid"
  [ -f "$pidf" ] || continue
  pid="$(cat "$pidf")"
  if kill "$pid" 2>/dev/null; then echo "✓ stopped $role (pid $pid)"; else echo "• $role not running"; fi
  rm -f "$pidf"
done
