#!/bin/sh
# multibot: prepare a relay box YOU own so a MultiBot server behind a router
# with no UPnP, no NAT-PMP and no IPv6 is still reachable on :8799.
#
# Runs ON THE RELAY BOX, as root, once:
#   curl -fsSL .../relay-setup.sh | sudo sh -s -- 'ssh-ed25519 AAAA... multibot-relay'
#   ... or: sudo sh relay-setup.sh < server_key.pub
#
# What it builds: an account that can do exactly ONE thing — hold open a reverse
# tunnel for port 8799. No shell, no pty, no agent forwarding, no other port
# (`permitlisten`). The relay forwards TCP, so the harness's TLS is untouched:
# the certificate the client pins is still the server's own, and this box only
# ever sees ciphertext. Idempotent: safe to re-run to add a second key.
set -eu

USER_NAME=mbrelay
PORT=8799
SSHD_DROPIN=/etc/ssh/sshd_config.d/mbrelay.conf

say() { printf '[relay] %s\n' "$*"; }
die() { printf '[relay] %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo sh relay-setup.sh ...)"

KEY="${1:-}"
[ -n "$KEY" ] || KEY="$(cat)"
KEY="$(printf '%s' "$KEY" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
# Only the key types ssh-keygen still mints, and only a one-line key: this string
# is about to be written into a file that decides who gets in.
case "$KEY" in
  ssh-ed25519\ *|ecdsa-sha2-nistp256\ *|ecdsa-sha2-nistp384\ *|ecdsa-sha2-nistp521\ *|ssh-rsa\ *) ;;
  *) die "that is not an OpenSSH public key: pass the line scripts/relay-connect.sh printed" ;;
esac
# One line only. `wc -l` counts newlines, so a bare key scores 0 and a pasted
# `authorized_keys` with a second key in it scores 1 and is refused.
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

# `command=` beats anything the client asks to run; `restrict` turns everything
# off and `port-forwarding` turns back exactly one thing. `permitlisten` pins the
# tunnel to :8799 (three spellings, because that is what sshd matches the
# client's request string against) and `permitopen="none"` blocks `-L`, so this
# key cannot use the relay as a jump host onto anything the relay can see.
OPTS="command=\"echo relay only\",restrict,no-pty,no-X11-forwarding,no-agent-forwarding,no-user-rc,port-forwarding,permitopen=\"none\",permitlisten=\"$PORT\",permitlisten=\"0.0.0.0:$PORT\",permitlisten=\"*:$PORT\""
LINE="$OPTS $KEY"
if grep -qsF "$KEY" "$HOME_DIR/.ssh/authorized_keys"; then
  say "key already authorized"
else
  printf '%s\n' "$LINE" >> "$HOME_DIR/.ssh/authorized_keys"
  say "key authorized for port $PORT only"
fi
chown -R "$USER_NAME:$(id -gn "$USER_NAME")" "$HOME_DIR/.ssh"
chmod 700 "$HOME_DIR/.ssh"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"

# ── sshd ─────────────────────────────────────────────────────────────
# `GatewayPorts clientspecified` is what lets `-R 0.0.0.0:8799:...` bind the
# public interface instead of the relay's loopback; without it the tunnel comes
# up and nobody outside can reach it. ClientAlive* drops a tunnel whose phone
# fell off the network, so the reconnect finds the port free.
mkdir -p "$(dirname "$SSHD_DROPIN")"
cat > "$SSHD_DROPIN" <<EOF
# written by multibot scripts/relay-setup.sh
GatewayPorts clientspecified
ClientAliveInterval 30
ClientAliveCountMax 3
AllowTcpForwarding yes
EOF
chmod 644 "$SSHD_DROPIN"

# Older sshd builds do not read the drop-in directory at all; saying so beats a
# tunnel that silently binds loopback and a relay that answers nothing.
if ! grep -qsr 'sshd_config.d' /etc/ssh/sshd_config; then
  say "WARNING: /etc/ssh/sshd_config has no Include of sshd_config.d — append the four lines of $SSHD_DROPIN to it by hand"
fi

say "reload sshd"
if command -v systemctl >/dev/null 2>&1; then
  systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || systemctl restart sshd
elif command -v service >/dev/null 2>&1; then
  service sshd reload || service ssh reload
else
  say "reload sshd yourself: no systemctl and no service on this box"
fi

# ── firewall ─────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status >/dev/null 2>&1; then
  ufw allow "$PORT/tcp" >/dev/null && say "ufw: opened $PORT/tcp"
elif command -v nft >/dev/null 2>&1 && nft list table inet filter >/dev/null 2>&1; then
  nft add rule inet filter input tcp dport "$PORT" accept && say "nftables: opened $PORT/tcp"
elif command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null ||
    iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT
  say "iptables: opened $PORT/tcp (not persisted — use iptables-persistent if this box has one)"
else
  say "no ufw/nft/iptables found: open TCP $PORT yourself"
fi

say ""
say "Oracle Cloud (and every other cloud): the host firewall is only half of it."
say "  Open TCP $PORT in the VCN security list / network security group too,"
say "  or the packet never reaches this machine. Console > Networking > VCN >"
say "  Security Lists > Add Ingress Rule: 0.0.0.0/0, TCP, destination port $PORT."
say ""
say "done. Now on the MultiBot server: sh scripts/relay-connect.sh <this box's IP>"
