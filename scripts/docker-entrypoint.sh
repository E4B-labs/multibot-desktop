#!/usr/bin/env bash
# multibot: one container, one public port — the harness.
set -euo pipefail
export HOME="${HOME:-/data}"
export OMB_HOST="${OMB_HOST:-0.0.0.0}"
export OMB_PORT="${OMB_PORT:-8799}"
# Container stdout is not a terminal, so the harness prints only a pointer to
# setup.json — and nobody can `cat` a file in a container they just started.
# The three values therefore go to `docker logs` once, on first boot only; the
# helper is a no-op after the first profile claims the server.
bash "$(dirname "$0")/print-setup-values.sh" 120 || true &
exec /app/scripts/start-multibot.sh
