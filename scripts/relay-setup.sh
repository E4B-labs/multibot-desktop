#!/bin/sh
# multibot: prepare a relay box YOU own so a MultiBot server behind a router
# with no UPnP, no NAT-PMP and no IPv6 is still reachable.
#
# Runs ON THE RELAY BOX, as root, once. `scripts/relay-connect.sh` on the server
# prints the exact line to paste, key and port already filled in:
#   curl -fsSL https://raw.githubusercontent.com/E4B-labs/multibot-desktop/main/scripts/relay-setup.sh | sudo sh -s -- 'ssh-ed25519 AAAA... multibot-relay' 8799
#   ... or, with the file already here: sudo sh relay-setup.sh '<key>' 8799
#
# What it builds: an account that can do exactly ONE thing — hold open a reverse
# tunnel for that one port. No shell, no pty, no agent forwarding, no local
# forwarding (so it cannot be used as a jump host onto anything this box can
# see), no other listen port. The relay forwards TCP, so the harness's TLS is
# untouched: the certificate the client pins is still the server's own, and this
# box only ever sees ciphertext. Idempotent: re-run to add or re-arm a key.
set -eu

USER_NAME=mbrelay
# Read the arguments ONCE, up here: everything below is free to reuse $1.
KEY="${1:-}"
PORT="${2:-${PORT:-8799}}"
SSHD_DROPIN=/etc/ssh/sshd_config.d/10-mbrelay.conf

say() { printf '[relay] %s\n' "$*"; }
warn() { printf '[relay] WARNING: %s\n' "$*" >&2; }
die() { printf '[relay] %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo sh relay-setup.sh '<key>' [port])"

case "$PORT" in
  ''|*[!0-9]*) die "port must be a number: $PORT" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "port out of range: $PORT"

# `permitlisten` (7.6) and `Match`-scoped `AllowStreamLocalForwarding` want a
# recent sshd. On anything older the options below are either rejected or
# silently ignored, and "silently ignored" here means a key with no limits at
# all — so refuse rather than build something weaker than it looks.
SSH_BANNER="$(ssh -V 2>&1)"
SSH_MAJOR="$(printf '%s' "$SSH_BANNER" | sed -n 's/^OpenSSH_\([0-9]*\)\.\([0-9]*\).*/\1/p')"
SSH_MINOR="$(printf '%s' "$SSH_BANNER" | sed -n 's/^OpenSSH_\([0-9]*\)\.\([0-9]*\).*/\2/p')"
[ -n "$SSH_MAJOR" ] || die "cannot read the OpenSSH version from 'ssh -V' ($SSH_BANNER)"
if [ "$SSH_MAJOR" -lt 7 ] || { [ "$SSH_MAJOR" -eq 7 ] && [ "$SSH_MINOR" -lt 8 ]; }; then
  die "OpenSSH $SSH_MAJOR.$SSH_MINOR is too old: this needs 7.8+ for permitlisten and a Match-scoped forwarding policy"
fi

# No key on the command line means it is arriving on stdin (`... < key.pub`).
[ -n "$KEY" ] || KEY="$(cat)"
KEY="$(printf '%s' "$KEY" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
# Only the key types ssh-keygen still mints, and only one line: this string is
# about to be written into a file that decides who gets in.
case "$KEY" in
  ssh-ed25519\ *|ecdsa-sha2-nistp256\ *|ecdsa-sha2-nistp384\ *|ecdsa-sha2-nistp521\ *|ssh-rsa\ *) ;;
  *) die "that is not an OpenSSH public key: pass the line scripts/relay-connect.sh printed" ;;
esac
[ "$(printf '%s' "$KEY" | wc -l)" -eq 0 ] || die "public key must be a single line"

# ── the locked-down account ──────────────────────────────────────────
if id "$USER_NAME" >/dev/null 2>&1; then
  say "user $USER_NAME already exists"
else
  say "create user $USER_NAME (no login shell)"
  NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
  [ -x "$NOLOGIN" ] || NOLOGIN=/bin/false
  if command -v useradd >/dev/null 2>&1; then
    useradd --create-home --shell "$NOLOGIN" "$USER_NAME"
  elif command -v adduser >/dev/null 2>&1; then
    adduser -D -s "$NOLOGIN" "$USER_NAME"
  else
    die "no useradd/adduser on this box"
  fi
fi

HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
[ -n "$HOME_DIR" ] || die "cannot resolve home of $USER_NAME"
mkdir -p "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"

# `command=` beats anything the client asks to run; `restrict` turns every
# feature off and `port-forwarding` turns exactly one back on. `permitlisten` is
# what pins the tunnel to this port — a bare port there means `*:PORT`, which is
# the shape `-R 0.0.0.0:PORT` asks for, so one spelling is the right number of
# spellings. Local forwarding is banned in sshd_config, not here: `permitopen`
# only ever takes host:port pairs and sshd rejects the WHOLE key line if you try
# to write "none" into it.
OPTS="command=\"echo relay only\",restrict,port-forwarding,permitlisten=\"$PORT\""
LINE="$OPTS $KEY"
# Match on the key itself, then rewrite the line: an older run of this script (or
# a hand-edit) may have left the same key with weaker options, and leaving those
# in place would be the one failure nobody notices.
if grep -qsxF "$LINE" "$HOME_DIR/.ssh/authorized_keys"; then
  say "key already authorized for port $PORT"
elif grep -qsF "$KEY" "$HOME_DIR/.ssh/authorized_keys"; then
  TMP="$HOME_DIR/.ssh/authorized_keys.new"
  grep -vF "$KEY" "$HOME_DIR/.ssh/authorized_keys" > "$TMP" || true
  printf '%s\n' "$LINE" >> "$TMP"
  mv "$TMP" "$HOME_DIR/.ssh/authorized_keys"
  say "key re-armed with the current options (port $PORT)"
else
  printf '%s\n' "$LINE" >> "$HOME_DIR/.ssh/authorized_keys"
  say "key authorized for port $PORT only"
fi
chown -R "$USER_NAME:$(id -gn "$USER_NAME")" "$HOME_DIR/.ssh"
chmod 700 "$HOME_DIR/.ssh"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"

# ── sshd ─────────────────────────────────────────────────────────────
# Everything that loosens sshd lives inside `Match User mbrelay`, so no other
# account on this box gains anything. `GatewayPorts clientspecified` is what
# lets `-R 0.0.0.0:PORT:...` bind the public interface instead of loopback;
# without it the tunnel comes up and nobody outside can reach it.
# `AllowTcpForwarding remote` permits `-R` and refuses `-L`, which is the local
# forwarding ban `permitopen` cannot express.
# `ClientAlive*` stays at global scope: it is not a Match-legal keyword.
mkdir -p "$(dirname "$SSHD_DROPIN")"
cat > "$SSHD_DROPIN" <<EOF
# written by multibot scripts/relay-setup.sh
ClientAliveInterval 30
ClientAliveCountMax 3

Match User $USER_NAME
  GatewayPorts clientspecified
  AllowTcpForwarding remote
  AllowStreamLocalForwarding no
  AllowAgentForwarding no
  PermitTTY no
  X11Forwarding no
EOF
chmod 644 "$SSHD_DROPIN"

# Older sshd builds do not read the drop-in directory at all; saying so beats a
# tunnel that silently binds loopback and a relay that answers nothing.
grep -qsr 'sshd_config.d' /etc/ssh/sshd_config ||
  warn "/etc/ssh/sshd_config has no Include of sshd_config.d — append the contents of $SSHD_DROPIN to it by hand"

if command -v sshd >/dev/null 2>&1; then
  sshd -t || die "sshd rejected the new config; $SSHD_DROPIN is written but NOT active — fix it before trusting this box"
fi

say "reload sshd"
if command -v systemctl >/dev/null 2>&1; then
  systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || systemctl restart sshd ||
    warn "could not reload sshd — do it by hand"
elif command -v service >/dev/null 2>&1; then
  service sshd reload || service ssh reload || warn "could not reload sshd — do it by hand"
else
  warn "reload sshd yourself: no systemctl and no service on this box"
fi

# ── firewall ─────────────────────────────────────────────────────────
# Every branch is `|| warn`: a firewall this script cannot drive is a note to
# the owner, never a reason to exit before the cloud instructions below — those
# are the step people actually miss.
if command -v ufw >/dev/null 2>&1 && ufw status >/dev/null 2>&1; then
  ufw allow "$PORT/tcp" >/dev/null && say "ufw: opened $PORT/tcp" || warn "ufw refused; open TCP $PORT yourself"
elif command -v nft >/dev/null 2>&1 && nft list table inet filter >/dev/null 2>&1; then
  # `insert`, not `add`: `add` appends AFTER the chain's final drop/reject rule,
  # where it can never match.
  nft insert rule inet filter input tcp dport "$PORT" accept && say "nftables: opened $PORT/tcp" ||
    warn "nft refused; open TCP $PORT yourself"
elif command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null ||
    iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT ||
    warn "iptables refused; open TCP $PORT yourself"
  say "iptables: $PORT/tcp allowed (NOT persisted — use iptables-persistent if this box has one)"
else
  warn "no ufw/nft/iptables found: open TCP $PORT yourself"
fi

say ""
say "Cloud VMs have a SECOND firewall, and this is the step people miss:"
say "  Oracle Cloud: Networking > VCN > Security Lists > Add Ingress Rule"
say "                0.0.0.0/0, TCP, destination port $PORT"
say "  AWS: the instance's security group. GCP: a VPC firewall rule."
say "  Without it the packet never reaches this machine, however open ufw is."
say ""
say "done. Back on the MultiBot server: sh scripts/relay-check.sh"
