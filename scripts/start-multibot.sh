#!/usr/bin/env bash
# multibot: common production entrypoint for systemd, Termux and Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Keep Android from suspending the Termux process after screen-off.
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true

if [[ ! -f "$ROOT/dist-server/index.js" || ! -f "$ROOT/dist/index.html" ]]; then
  echo "Multibot is not built. Run: pnpm install --frozen-lockfile && pnpm build && pnpm build:server" >&2
  exit 1
fi

export MULTIBOT_HOST="${MULTIBOT_HOST:-0.0.0.0}"
export MULTIBOT_PORT="${MULTIBOT_PORT:-8799}"
exec node "$ROOT/dist-server/index.js"
