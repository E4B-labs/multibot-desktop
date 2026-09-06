#!/usr/bin/env bash
# multibot: one-command Linux/VPS installer. User service; no sudo/elevation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="systemd"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:?--mode requires systemd or docker}"; shift 2 ;;
    --mode=systemd) MODE="systemd"; shift ;;
    --mode=docker) MODE="docker"; shift ;;
    --dry-run|--plan) DRY_RUN=1; shift ;;
    --self-test) bash -n "$0" && bash -n "$ROOT/scripts/start-multibot.sh" && echo "linux installer: OK"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '[multibot] %s\n' "$*"; }
run() { if (( DRY_RUN )); then printf '+ %q' "$@"; printf '\n'; else "$@"; fi; }

if [[ "$MODE" == docker ]]; then
  say "Docker route: the harness is the only published port (8799, loopback)."
  command -v docker >/dev/null || { say "missing docker" >&2; exit 1; }
  run docker compose -f "$ROOT/docker-compose.selfhost.yml" up -d --build
  say "HTTPS: on by default, self-signed certificate — the first connection asks you to trust its fingerprint"
  say "Reverse proxy (optional): terminate TLS there and set OMB_TLS=off with OMB_HOST=127.0.0.1"
  say "Next: open MultiBot at the address, choose Set up server, then share host + server password"
  exit 0
fi

[[ "$(uname -s)" == Linux ]] || { say "systemd mode requires Linux" >&2; exit 1; }
for tool in node pnpm git systemctl; do command -v "$tool" >/dev/null || { say "missing $tool" >&2; exit 1; }; done

say "build harness and PWA"
run pnpm --dir "$ROOT" install --frozen-lockfile
run pnpm --dir "$ROOT" build
run pnpm --dir "$ROOT" build:server

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="$SERVICE_DIR/multibot.service"
BASH_BIN="$(command -v bash)"
if (( DRY_RUN )); then
  say "write $SERVICE"
  say "systemctl --user daemon-reload && systemctl --user enable --now multibot.service"
else
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE" <<EOF
[Unit]
Description=Multibot self-hosted bot server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=HOME=%h
Environment=OMB_HOST=0.0.0.0
Environment=OMB_PORT=8799
ExecStart=$BASH_BIN $ROOT/scripts/start-multibot.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now multibot.service
  if command -v loginctl >/dev/null; then loginctl enable-linger "$USER" || say "enable linger manually: loginctl enable-linger $USER"; fi
fi

say "Address: https://$(hostname -f 2>/dev/null || hostname):8799"
say "HTTPS: on by default, self-signed certificate — the first connection asks you to trust its fingerprint"
say "Reverse proxy (optional): terminate TLS there and set OMB_TLS=off with OMB_HOST=127.0.0.1"
say "Next: open MultiBot at the address, choose Set up server, then share host + server password"
