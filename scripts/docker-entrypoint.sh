#!/usr/bin/env bash
# multibot: one container, one public port — the harness.
set -euo pipefail
export HOME="${HOME:-/data}"
export MULTIBOT_HOST="${MULTIBOT_HOST:-0.0.0.0}"
export MULTIBOT_PORT="${MULTIBOT_PORT:-8799}"
# `docker logs` is a file somebody keeps forever, so the three values stay
# out of it — the log gets the path and the one command that reads them.
echo "[multibot] first boot writes address, server name and server password to $HOME/.multibot/setup.json (0600)"
echo "[multibot] read them once with: docker compose -f docker-compose.selfhost.yml exec app cat $HOME/.multibot/setup.json"
exec /app/scripts/start-multibot.sh
