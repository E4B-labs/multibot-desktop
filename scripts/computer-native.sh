#!/usr/bin/env bash
# multibot: the bot computer WITHOUT Docker.
#
# Same desktop, same interface, no container: an X server, a window manager, a
# Chromium with CDP, and websockify serving noVNC — on exactly the ports the
# container publishes (cdp 9223, novnc 6901), so the harness proxy works
# against either backend unchanged.
#
# This exists for hosts where Docker cannot run at all. The obvious one is
# Termux on Android: Docker needs kernel privileges an unrooted phone will
# never grant, so the container path is not "hard" there, it is impossible.
#
# SECURITY, and this is the real difference from the container: there is NO
# isolation here. The browser and `computer_exec` run as your own user, on your
# own machine, with your own files — including MultiBot's own data directory and
# API keys. The container backend confines an agent to a throwaway filesystem;
# this one does not. Prefer Docker wherever it exists.
set -uo pipefail

DISPLAY_NUM="${MULTIBOT_COMPUTER_DISPLAY:-1}"
CDP_PORT="${MULTIBOT_COMPUTER_CDP_PORT:-9223}"
NOVNC_PORT="${MULTIBOT_COMPUTER_NOVNC_PORT:-6901}"
VNC_PORT="${MULTIBOT_COMPUTER_VNC_PORT:-5901}"
# 16:9 na starcie: panel w przegladarce jest szeroki, a VNC i tak wysyla tylko
# zmienione fragmenty, wiec wieksza plocha kosztuje glownie przy pelnym
# przerysowaniu. Zmienisz przez MULTIBOT_COMPUTER_GEOMETRY.
GEOMETRY="${MULTIBOT_COMPUTER_GEOMETRY:-1920x1080}"

ROOT="${MULTIBOT_COMPUTER_HOME:-$HOME/.multibot-computer}"
LOG="$ROOT/logs"
# Every process THIS script launched, one "<name> <pid>" per line. `stop` kills
# exactly these and nothing else: other things run under the same Termux, so
# killing by process name is out of the question.
PIDS="$ROOT/computer.pids"
mkdir -p "$LOG" "$ROOT/chrome"

export DISPLAY=":$DISPLAY_NUM"

have() { command -v "$1" >/dev/null 2>&1; }

# Each piece is started with `setsid`, so its pid is also its process-group id:
# killing the group takes the children (chromium renderers, crashpad) with it.
alive() { kill -0 "$1" 2>/dev/null; }
launched() { echo "$1 $2" >>"$PIDS"; }
stop_all() {
  [ -f "$PIDS" ] || { echo "nothing recorded in $PIDS"; return 0; }
  # A polite logout first: xfce's own session clients (xfsettingsd, the power
  # manager, the panel) daemonise out of our process group, and only the
  # session manager knows how to ask them to leave.
  if grep -q '^session ' "$PIDS" && have xfce4-session-logout; then
    xfce4-session-logout --logout --fast >/dev/null 2>&1 || true
    sleep 2
  fi
  local name pid
  while read -r name pid; do
    [ -n "$pid" ] && alive "$pid" || continue
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done <"$PIDS"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    local left=0
    while read -r name pid; do alive "$pid" && left=1; done <"$PIDS"
    [ "$left" = 0 ] && break
    sleep 0.5
  done
  while read -r name pid; do
    [ -n "$pid" ] && alive "$pid" || continue
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  done <"$PIDS"
  rm -f "$PIDS"
}

if [ "${1:-}" = "stop" ]; then
  stop_all
  exit 0
fi

# Forget pids of processes that already died (a crash, a reboot) so a stale
# number is never sent a signal after the kernel reused it.
if [ -f "$PIDS" ]; then
  kept="$(while read -r name pid; do alive "$pid" && echo "$name $pid"; done <"$PIDS")"
  if [ -n "$kept" ]; then printf '%s
' "$kept" >"$PIDS"; else rm -f "$PIDS"; fi
fi

# Termux keeps chromium out of PATH under that name.
CHROME=""
for candidate in "${PREFIX:-/usr}/lib/chromium/chrome" chromium-browser chromium google-chrome; do
  if [ -x "$candidate" ]; then CHROME="$candidate"; break; fi
  if have "$candidate"; then CHROME="$(command -v "$candidate")"; break; fi
done
[ -n "$CHROME" ] || { echo "no chromium/chrome found" >&2; exit 1; }
have Xvnc || { echo "Xvnc missing — install tigervnc" >&2; exit 1; }

running() { pgrep -f "$1" >/dev/null 2>&1; }

# -localhost: the screen is reachable only through the harness, never off-box.
# -SecurityTypes None is safe only BECAUSE of that; the harness auth gate is
# what actually protects it.
if ! running "Xvnc :$DISPLAY_NUM"; then
  setsid Xvnc ":$DISPLAY_NUM" -geometry "$GEOMETRY" -depth 24 \
    -SecurityTypes None -localhost -rfbport "$VNC_PORT" \
    >"$LOG/xvnc.log" 2>&1 </dev/null &
  launched xvnc $!
  sleep 4
fi

# A full desktop, not a bare window manager. XFCE first because that is what the
# container image ships and what "a computer" is supposed to mean here: a panel,
# a menu, a file manager and a terminal you can actually open. A bare WM leaves
# the browser filling the screen with nothing behind it, which reads as "there
# is only a browser". openbox stays as the fallback for hosts too small for it.
#
# Appearance is written FIRST: xfconfd loads it once when the session starts, so
# anything applied afterwards would be overwritten on the next launch.
"$(dirname "${BASH_SOURCE[0]}")/computer-desktop.sh" >"$LOG/desktop-config.log" 2>&1 || true

if ! running "xfce4-session|openbox"; then
  if have xfce4-session; then
    # Termux has no D-Bus session by default; xfce4-session needs one.
    if have dbus-launch; then
      setsid dbus-launch --exit-with-session xfce4-session >"$LOG/wm.log" 2>&1 </dev/null &
    else
      setsid xfce4-session >"$LOG/wm.log" 2>&1 </dev/null &
    fi
    launched session $!
  elif have openbox; then
    setsid openbox >"$LOG/openbox.log" 2>&1 </dev/null &
    launched session $!
  fi
  sleep 5
fi

# Headful on purpose — the user watches this exact window and can take control.
if ! running "$ROOT/chrome"; then
  setsid "$CHROME" \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --no-first-run \
    --no-default-browser-check \
    --remote-debugging-port="$CDP_PORT" \
    --user-data-dir="$ROOT/chrome" \
    --start-maximized \
    about:blank >"$LOG/chrome.log" 2>&1 </dev/null &
  launched chrome $!
fi

# noVNC over websockify, on the same port the container publishes.
if ! running "websockify.*$NOVNC_PORT"; then
  NOVNC_DIR="${MULTIBOT_NOVNC_DIR:-$ROOT/noVNC}"
  if [ -f "$NOVNC_DIR/vnc.html" ]; then
    setsid python3 -m websockify --web="$NOVNC_DIR" \
      "127.0.0.1:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" \
      >"$LOG/websockify.log" 2>&1 </dev/null &
    launched websockify $!
  else
    echo "noVNC missing at $NOVNC_DIR — the screen will not render" >&2
  fi
fi

exit 0
