#!/bin/sh
# multibot: dial OUT to a relay box you own, so the world reaches this server on
# :8799 even though the router in front of it has no UPnP, no NAT-PMP and no
# IPv6. Runs ON THE MULTIBOT SERVER (Termux or Linux).
#
#   sh scripts/relay-connect.sh <relay-ip-or-name>     # set up + install service
#   sh scripts/relay-connect.sh                        # run the loop in foreground
#   sh scripts/relay-connect.sh --print-key            # just show the public key
#
# Only `ssh -R` — no daemon of ours in the path. The relay forwards TCP, so this
# server's self-signed certificate is what the client still pins: the relay never
# holds a key and never sees anything but ciphertext.
set -eu

# `$0` is "sh" under `curl … | sh`, so the repo root is a variable first and a
# guess from the script path second — same rule as scripts/install-termux.sh.
ROOT="${MULTIBOT_ROOT:-}"
if [ -z "$ROOT" ] && [ -f "$0" ]; then ROOT="$(cd "$(dirname "$0")/.." && pwd)"; fi
[ -n "$ROOT" ] || { echo "[relay] set MULTIBOT_ROOT=/path/to/multibot when piping this script" >&2; exit 2; }

PORT="${OMB_PORT:-8799}"
RELAY_USER=mbrelay

# The data directory has to be the one the SERVER uses, or we write relay.env
# where nothing reads it. The installers bake it into the service, so read it
# back from there before falling back to the default.
if [ -z "${OMB_DATA_DIR:-}" ]; then
  for RUNFILE in "${PREFIX:-/nonexistent}/var/service/multibot/run" \
                 "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/multibot.service"; do
    [ -f "$RUNFILE" ] || continue
    FOUND="$(sed -n 's/.*OMB_DATA_DIR="\{0,1\}\([^" ]*\)"\{0,1\}.*/\1/p' "$RUNFILE" | head -1)"
    if [ -n "$FOUND" ]; then OMB_DATA_DIR="$FOUND"; break; fi
  done
fi
DATA_DIR="${OMB_DATA_DIR:-$HOME/.openmausbot}"
KEY="$DATA_DIR/relay_key"
ENV_FILE="$DATA_DIR/relay.env"

say() { printf '[relay] %s\n' "$*"; }
die() { printf '[relay] %s\n' "$*" >&2; exit 1; }

command -v ssh >/dev/null 2>&1 || die "no ssh: pkg install openssh (Termux) / apt install openssh-client"
mkdir -p "$DATA_DIR"

if [ ! -f "$KEY" ]; then
  say "mint $KEY (ed25519, no passphrase — a service has nobody to type one)"
  ssh-keygen -t ed25519 -N '' -C multibot-relay -f "$KEY" >/dev/null
fi
chmod 600 "$KEY"

if [ "${1:-}" = "--print-key" ]; then
  cat "$KEY.pub"
  exit 0
fi

# The host comes from the argument once, then from relay.env forever after — the
# service restarts without one.
ARG="${1:-}"
RELAY_HOST="$ARG"
if [ -z "$RELAY_HOST" ] && [ -f "$ENV_FILE" ]; then
  RELAY_HOST="$(sed -n 's/^RELAY_HOST=//p' "$ENV_FILE" | head -1)"
fi
[ -n "$RELAY_HOST" ] || die "usage: sh scripts/relay-connect.sh <relay-ip-or-name>"
# A host and nothing else: this string goes into a file the server reads back as
# the address it publishes to everybody.
case "$RELAY_HOST" in
  *[!A-Za-z0-9.:-]*|""|-*) die "relay host must be a bare IP or DNS name: $RELAY_HOST" ;;
esac

if [ -n "$ARG" ]; then
  printf 'RELAY_HOST=%s\n' "$RELAY_HOST" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "wrote $ENV_FILE"
  say ""
  say "Run this ON THE RELAY BOX (once), as root:"
  say ""
  printf "  curl -fsSL https://raw.githubusercontent.com/E4B-labs/multibot-desktop/main/scripts/relay-setup.sh | sudo sh -s -- '%s' %s\n\n" "$(cat "$KEY.pub")" "$PORT"
  say "…then this server keeps the tunnel up by itself."
  say ""
fi

# ── the service ──────────────────────────────────────────────────────
# Mirrors how scripts/install-termux.sh builds the `multibot` service, so both
# are supervised the same way and both come back after a reboot.
install_service() {
  if [ -n "${PREFIX:-}" ] && [ -d "$PREFIX/var/service" ]; then
    DIR="$PREFIX/var/service/mb-relay"
    mkdir -p "$DIR/log"
    # `exec 2>&1` or svlogger only ever files stdout, and every reconnect
    # message this script writes goes to stderr — into nothing.
    cat > "$DIR/run" <<EOF
#!$PREFIX/bin/sh
exec 2>&1
exec env HOME="$HOME" MULTIBOT_ROOT="$ROOT" OMB_DATA_DIR="$DATA_DIR" OMB_PORT="$PORT" \\
  sh "$ROOT/scripts/relay-connect.sh"
EOF
    chmod +x "$DIR/run"
    ln -sf "$PREFIX/share/termux-services/svlogger" "$DIR/log/run"
    # shellcheck disable=SC1091
    . "$PREFIX/etc/profile.d/start-services.sh"
    sv-enable mb-relay
    # Enabling an already-enabled service does not restart it, so a changed
    # relay.env would otherwise wait for the next reboot.
    sv restart mb-relay >/dev/null 2>&1 || true
    say "runit service mb-relay running (sv status mb-relay)"
  elif command -v systemctl >/dev/null 2>&1; then
    DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$DIR"
    cat > "$DIR/mb-relay.service" <<EOF
[Unit]
Description=Multibot reverse tunnel to a relay box you own
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=MULTIBOT_ROOT=$ROOT
Environment=OMB_DATA_DIR=$DATA_DIR
Environment=OMB_PORT=$PORT
ExecStart=/bin/sh $ROOT/scripts/relay-connect.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now mb-relay.service
    systemctl --user restart mb-relay.service
    # Without lingering, the tunnel dies at logout and never comes back after a
    # reboot — the same trap scripts/install-linux.sh works around.
    if command -v loginctl >/dev/null 2>&1; then
      WHO="${USER:-$(id -un)}"
      loginctl enable-linger "$WHO" || say "enable linger manually: loginctl enable-linger $WHO"
    fi
    say "systemd user unit mb-relay.service running (systemctl --user status mb-relay)"
  else
    die "no runit and no systemd here: run 'sh $0' under whatever supervisor you use"
  fi
}

if [ -n "$ARG" ]; then
  install_service
  say "check it with: sh $ROOT/scripts/relay-check.sh"
  exit 0
fi

# ── the loop ─────────────────────────────────────────────────────────
# `ExitOnForwardFailure` is the important one: without it ssh happily sits there
# connected with no forwarding, and the address we publish answers nothing.
# Backoff so a relay that is down does not become a login flood.
say "tunnel $RELAY_HOST:$PORT -> 127.0.0.1:$PORT"
BACKOFF=5
while :; do
  START=$(date +%s)
  ssh -N \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes \
    -i "$KEY" \
    -R "0.0.0.0:$PORT:127.0.0.1:$PORT" \
    "$RELAY_USER@$RELAY_HOST" || true
  # A tunnel that held for a while was healthy: reset the backoff so one bad
  # night does not leave us reconnecting once a minute forever after.
  if [ $(( $(date +%s) - START )) -ge 60 ]; then BACKOFF=5; fi
  say "tunnel down, retrying in ${BACKOFF}s"
  sleep "$BACKOFF"
  BACKOFF=$(( BACKOFF * 2 ))
  [ "$BACKOFF" -le 60 ] || BACKOFF=60
done
