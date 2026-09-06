#!/bin/sh
# multibot: is the relay tunnel actually carrying traffic? Runs ON THE MULTIBOT
# SERVER. `ss`/`netstat` here would only show our outbound ssh, which is up long
# before the forwarding works — so the only honest test is to come back in the
# front door: fetch /api/public/server through the relay and check that the
# serverId matches the one this machine answers on loopback.
set -eu

DATA_DIR="${OMB_DATA_DIR:-$HOME/.openmausbot}"
ENV_FILE="$DATA_DIR/relay.env"
PORT="${OMB_PORT:-8799}"

say() { printf '[relay] %s\n' "$*"; }
die() { printf '[relay] %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "no curl: pkg install curl"
[ -f "$ENV_FILE" ] || die "no $ENV_FILE — run scripts/relay-connect.sh <relay-host> first"
RELAY_HOST="$(sed -n 's/^RELAY_HOST=//p' "$ENV_FILE" | head -1)"
[ -n "$RELAY_HOST" ] || die "$ENV_FILE has no RELAY_HOST"

# `-k`: the certificate is self-signed by design, and identity is proved by the
# serverId comparison below plus the fingerprint clients pin (docs/REMOTE-ACCESS.md).
id_at() { curl -sk --max-time 10 "https://$1:$PORT/api/public/server" | tr ',' '\n' | sed -n 's/.*"serverId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1; }

LOCAL="$(id_at 127.0.0.1 || true)"
[ -n "$LOCAL" ] || die "the harness itself is not answering on https://127.0.0.1:$PORT — fix that before the relay"

REMOTE="$(id_at "$RELAY_HOST" || true)"
if [ -z "$REMOTE" ]; then
  say "DOWN: https://$RELAY_HOST:$PORT does not answer."
  say "  tunnel:   sv status mb-relay   (Termux)   |   systemctl --user status mb-relay   (Linux)"
  say "  relay box: sshd reloaded? TCP $PORT open in the host firewall AND the cloud security list?"
  exit 1
fi

if [ "$REMOTE" = "$LOCAL" ]; then
  say "UP: https://$RELAY_HOST:$PORT is this server (serverId $LOCAL)."
  say "That is the address to type into MultiBot > Sign in to a server."
  exit 0
fi

say "WRONG SERVER: https://$RELAY_HOST:$PORT answers with serverId $REMOTE, this machine is $LOCAL."
say "Something else is listening on that port of the relay box. Do NOT hand that address out."
exit 2
