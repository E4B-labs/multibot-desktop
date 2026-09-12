#!/data/data/com.termux/files/usr/bin/bash
# multibot: one-command Android/Termux installer with termux-services + Boot.
set -euo pipefail

ROOT="${MULTIBOT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|--plan) DRY_RUN=1; shift ;;
    --self-test) bash -n "$0" && bash -n "$ROOT/scripts/start-multibot.sh" && bash -n "$ROOT/scripts/multibot-watchdog.sh" && bash -n "$ROOT/scripts/print-setup-values.sh" && echo "termux installer: OK"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

run() { if (( DRY_RUN )); then printf '+ %q' "$@"; printf '\n'; else "$@"; fi; }
say() { printf '[multibot] %s\n' "$*"; }

say "install Termux packages (no root)"
run pkg update -y
# python zostaje: `python3 -m websockify` w scripts/computer-native.sh to most
# noVNC komputera bota — jedyny ekran, jaki Android daje bez Dockera.
# tor: the onion address (server/tor.ts) is the only rung that works behind a
# phone carrier's NAT without a box of your own. Package, not a bundled binary —
# Termux keeps it patched and the harness only ever spawns `tor` off PATH.
run pkg install -y nodejs-lts python git curl termux-services tor
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
WATCHDOG_DIR="$PREFIX/var/service/multibot-watchdog"
BOOT_DIR="$HOME/.termux/boot"
if (( DRY_RUN )); then
  say "write $SERVICE_DIR/run, $WATCHDOG_DIR/run and $BOOT_DIR/multibot"
else
  mkdir -p "$SERVICE_DIR/log" "$WATCHDOG_DIR/log" "$BOOT_DIR"
  cat > "$SERVICE_DIR/run" <<EOF
#!$PREFIX/bin/bash
exec env HOME="$HOME" MULTIBOT_HOST=0.0.0.0 MULTIBOT_PORT=8799 \\
  MULTIBOT_DATA_DIR="${MULTIBOT_DATA_DIR:-$HOME/.multibot}" \\
  "$ROOT/scripts/start-multibot.sh"
EOF
  chmod +x "$SERVICE_DIR/run"
  ln -sf "$PREFIX/share/termux-services/svlogger" "$SERVICE_DIR/log/run"
  cp "$ROOT/scripts/multibot-watchdog.sh" "$WATCHDOG_DIR/run"
  chmod +x "$WATCHDOG_DIR/run"
  ln -sf "$PREFIX/share/termux-services/svlogger" "$WATCHDOG_DIR/log/run"
  cat > "$BOOT_DIR/multibot" <<EOF
#!$PREFIX/bin/bash
termux-wake-lock
source "$PREFIX/etc/profile.d/start-services.sh"
sv-enable multibot
sv-enable multibot-watchdog
sv up multibot multibot-watchdog
EOF
  chmod +x "$BOOT_DIR/multibot"
  source "$PREFIX/etc/profile.d/start-services.sh"
  sv-enable multibot
  sv-enable multibot-watchdog
  sv up multibot multibot-watchdog
fi

# Bez tego Termux odrzuca RUN_COMMAND z innej apki, a wtedy MultiBot na tym
# telefonie nie umie zrestartować ani zaktualizować serwera bez wklejania
# komendy ręcznie. Dopisujemy raz; plik należy do użytkownika Termuxa.
PROPS="$HOME/.termux/termux.properties"
if (( DRY_RUN )); then
  say "append allow-external-apps=true to $PROPS"
else
  mkdir -p "$(dirname "$PROPS")"
  grep -qsE '^[[:space:]]*allow-external-apps[[:space:]]*=' "$PROPS" || printf '\nallow-external-apps=true\n' >> "$PROPS"
  # Termux reads the file at start; without the reload the property waits
  # for the next app restart and RUN_COMMAND keeps failing for no reason.
  command -v termux-reload-settings >/dev/null && termux-reload-settings || true
fi

say "HTTPS: on by default, self-signed certificate — the first connection asks you to trust its fingerprint"
say "Reverse proxy (optional): terminate TLS there and set MULTIBOT_TLS=off with MULTIBOT_HOST=127.0.0.1"
say "Termux:Boot: install it from F-Droid and OPEN IT ONCE — that is what brings the server back after a reboot"
say "Battery: Android settings > Apps > Termux > Battery > Unrestricted, or Android stops the server with the screen off"
say "Keep phone awake: termux-wake-lock (the Boot script repeats this)"
say "Samsung: disable Automatic restart; set Termux, Tailscale and MultiBot to Never sleeping"
say "Android 12+: optional one-time adb: settings put global settings_enable_monitor_phantom_procs false"

# The server mints its three values on its first boot; runit has just started
# it, so wait for the file rather than guessing an address from `hostname`.
if (( DRY_RUN )); then
  say "print the three values from \$HOME/.multibot/setup.json"
else
  bash "$ROOT/scripts/print-setup-values.sh" 90 || true
fi
