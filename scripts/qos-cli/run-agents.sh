#!/usr/bin/env bash
# Launch QuantumOS room agents DETACHED, on your Claude subscription (claude-code
# backend — needs the `claude` CLI installed + logged in). Because they're nohup'd,
# they keep running after you close the terminal (use tmux/screen or a service for
# survival across logout/reboot).
#
#   bash run-agents.sh [room-cap-or-url] [role ...]
#
# Defaults: the public room + facilitator. Stable identity per role under
# ./.qos-<role>; logs + pids under ./.agents. Stop with ./stop-agents.sh.
#
# WHY ONE ROLE BY DEFAULT, AND WHY THE LONG STAGGER
#
# The free signaling server rate-limits, and the limit applies to the WebRTC
# offer/answer/ICE exchange itself — not just to joining. Past a handful of peers
# in one room, handshakes stop completing: peers still appear in the room, and no
# data channel ever opens. From a browser that looks exactly like the agents
# never showed up, with nothing in any log saying why.
#
# Measured against this signaling server, same room, same code. Counting peers is
# fiddly because an observer joining to watch is itself a peer, so these are total
# peers in the room, observer included where one was used:
#
#   7 (facilitator scribe skeptic memory global + browser + observer) → 0 of 6 open
#   5 (facilitator memory global + browser + observer)                → 1 of 4 open
#   4 (facilitator memory + browser + observer)                       → 3 of 3 open
#
# Four is the most that has been seen to work against the public server. The
# default set below — facilitator, memory, and one browser — is three.
#
# The failing case also churns: `peer: rate limit exceeded`, then a signaling
# drop, then a rejoin that re-sends the whole peers list and trips the limit
# again. So the defaults here stay small and slow: one role, facilitator, plus the
# memory daemon started below — three peers with one browser — and a stagger long
# enough that the joins do not arrive as a burst. NO_MEMORY=1 drops that to two if
# you need more room for roles.
#
# The `/global` macro agent is NOT started here. It is deprecated (see CLAUDE.md),
# and every agent running is a peer spent against the ceiling above. Start it by
# hand if you want it: node global-agent.mjs --room <cap> --name global
#
# More roles work — pass them explicitly — but each one is another peer against
# that ceiling, and the failure is silent. Running your own signaling server
# removes the limit entirely and is the real fix if you want a full cast.
set -euo pipefail
cd "$(dirname "$0")"

ROOM="${1:-cap:room:05214747236101414325074505234721}"
shift || true
# Default role: facilitator greets newcomers ("hi") and requests a name itself, so
# no separate greeter is needed. Pass roles explicitly to override, e.g.
#   bash run-agents.sh "$ROOM" facilitator scribe
# — see the ceiling note above before adding several.
ROLES=("$@"); [ ${#ROLES[@]} -eq 0 ] && ROLES=(facilitator)

# Seconds between joins. Override with STAGGER=n for a slower link or a bigger cast.
STAGGER="${STAGGER:-15}"

command -v node >/dev/null || { echo "node not found — install Node 18+."; exit 1; }
[ -d node_modules ] || { echo "Run 'npm install' in scripts/qos-cli first."; exit 1; }
command -v claude >/dev/null || echo "warning: 'claude' CLI not on PATH — the claude-code AI backend needs it (agents still run, deterministically)."

mkdir -p .agents
for role in "${ROLES[@]}"; do
  pidf=".agents/$role.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    echo "• $role already running (pid $(cat "$pidf"))"; continue
  fi
  nohup node agent.mjs --room "$ROOM" --role "$role" --ai --ai-backend claude-code \
    --state "./.qos-$role" >> ".agents/$role.log" 2>&1 &
  echo $! > "$pidf"
  echo "✓ started $role (pid $!) → scripts/qos-cli/.agents/$role.log"
  sleep "$STAGGER"   # keep joins off each other's heels; see the ceiling note above
done

# Memory daemon — persists lemmas / gov and re-serves them to joiners, so room
# state (e.g. /lemma ballots) survives when every browser leaves. Set NO_MEMORY=1
# to skip. Seeded lemmas live in ./.qos-memory and reload automatically.
if [ -z "${NO_MEMORY:-}" ]; then
  mpidf=".agents/memory.pid"
  if [ -f "$mpidf" ] && kill -0 "$(cat "$mpidf")" 2>/dev/null; then
    echo "• memory already running (pid $(cat "$mpidf"))"
  else
    sleep "$STAGGER"   # let the role agents settle before the memory daemon joins
    nohup node qos-daemon.mjs --room "$ROOM" --name memory --state ./.qos-memory \
      >> ".agents/memory.log" 2>&1 &
    echo $! > "$mpidf"
    echo "✓ started memory (pid $!) → scripts/qos-cli/.agents/memory.log"
  fi
fi

echo
echo "Tail:  tail -f scripts/qos-cli/.agents/*.log"
echo "Stop:  bash scripts/qos-cli/stop-agents.sh"
