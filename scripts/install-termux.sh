#!/data/data/com.termux/files/usr/bin/bash
# multibot: one-command Android/Termux installer with termux-services + Boot.
set -euo pipefail

ROOT="${MULTIBOT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|--plan) DRY_RUN=1; shift ;;
    --self-test) bash -n "$0" && bash -n "$ROOT/scripts/start-multibot.sh" && echo "termux installer: OK"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

run() { if (( DRY_RUN )); then printf '+ %q' "$@"; printf '\n'; else "$@"; fi; }
say() { printf '[multibot] %s\n' "$*"; }

say "install Termux packages (no root)"
run pkg update -y
# python zostaje: `python3 -m websockify` w scripts/computer-native.sh to most
# noVNC komputera bota — jedyny ekran, jaki Android daje bez Dockera.
run pkg install -y nodejs-lts python git termux-services
if ! command -v pnpm >/dev/null; then
  if (( DRY_RUN )); then say "install pnpm@10.33.0 globally"; else npm install -g pnpm@10.33.0; fi
fi

say "build harness"
# Komputer bota (scripts/computer-native.sh) steruje natywnym Chromium Termuksa
# przez CDP — Android nie ma przenośnej przeglądarki do pobrania.
if [[ -n "${TERMUX_VERSION:-}" ]]; then
  run pkg install -y x11-repo chromium
fi
run pnpm --dir "$ROOT" install --frozen-lockfile
run pnpm --dir "$ROOT" build
run pnpm --dir "$ROOT" build:server
if (( ! DRY_RUN )); then chmod +x "$ROOT/scripts/start-multibot.sh"; fi

SERVICE_DIR="$PREFIX/var/service/multibot"
BOOT_DIR="$HOME/.termux/boot"
if (( DRY_RUN )); then
  say "write $SERVICE_DIR/run and $BOOT_DIR/multibot"
else
  mkdir -p "$SERVICE_DIR/log" "$BOOT_DIR"
  cat > "$SERVICE_DIR/run" <<EOF
#!$PREFIX/bin/bash
exec env HOME="$HOME" OMB_HOST=0.0.0.0 OMB_PORT=8799 \\
  "$ROOT/scripts/start-multibot.sh"
EOF
  chmod +x "$SERVICE_DIR/run"
  ln -sf "$PREFIX/share/termux-services/svlogger" "$SERVICE_DIR/log/run"
  cat > "$BOOT_DIR/multibot" <<EOF
#!$PREFIX/bin/bash
termux-wake-lock
source "$PREFIX/etc/profile.d/start-services.sh"
sv-enable multibot
EOF
  chmod +x "$BOOT_DIR/multibot"
  source "$PREFIX/etc/profile.d/start-services.sh"
  sv-enable multibot
fi

say "Address: http://$(hostname 2>/dev/null || echo phone):8799"
say "Keep phone awake: termux-wake-lock (Boot script repeats this)"
say "Public HTTPS: put a trusted reverse proxy in front of port 8799"
say "Next: open MultiBot at the address, choose Set up server, then share host + server password"
