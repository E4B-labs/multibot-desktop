#!/data/data/com.termux/files/usr/bin/bash
# multibot: one-command Android/Termux installer with termux-services + Boot.
set -euo pipefail

ROOT="${MULTIBOT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|--plan) DRY_RUN=1; shift ;;
    --self-test) bash -n "$0" && bash -n "$ROOT/scripts/start-multibot.sh" && bash -n "$ROOT/scripts/print-setup-values.sh" && echo "termux installer: OK"; exit 0 ;;
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

# Bez tego Termux odrzuca RUN_COMMAND z innej apki, a wtedy MultiBot na tym
# telefonie nie umie zrestartować ani zaktualizować serwera bez wklejania
# komendy ręcznie. Dopisujemy raz; plik należy do użytkownika Termuxa.
PROPS="$HOME/.termux/termux.properties"
if (( DRY_RUN )); then
  say "append allow-external-apps=true to $PROPS"
else
  mkdir -p "$(dirname "$PROPS")"
  grep -qs '^allow-external-apps=true' "$PROPS" || printf '\nallow-external-apps=true\n' >> "$PROPS"
fi

say "HTTPS: on by default, self-signed certificate — the first connection asks you to trust its fingerprint"
say "Reverse proxy (optional): terminate TLS there and set OMB_TLS=off with OMB_HOST=127.0.0.1"
say "Termux:Boot: install it from F-Droid and OPEN IT ONCE — that is what brings the server back after a reboot"
say "Battery: Android settings > Apps > Termux > Battery > Unrestricted, or Android stops the server with the screen off"
say "Keep phone awake: termux-wake-lock (the Boot script repeats this)"

# The server mints its three values on its first boot; runit has just started
# it, so wait for the file rather than guessing an address from `hostname`.
if (( DRY_RUN )); then
  say "print the three values from \$HOME/.openmausbot/setup.json"
else
  bash "$ROOT/scripts/print-setup-values.sh" 30
fi
