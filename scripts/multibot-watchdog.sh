#!/data/data/com.termux/files/usr/bin/bash
set -u

failures=0
last_tailscale_wake=0
log() { printf '[multibot-watchdog] %s\n' "$*"; }
has_tailscale_ip() { (command -v ip >/dev/null 2>&1 && ip addr) || (command -v ifconfig >/dev/null 2>&1 && ifconfig); }

while :; do
  now=$(date +%s)
  service_status=$(sv status multibot 2>&1 || true)
  if ! printf '%s\n' "$service_status" | grep -q '^run:'; then
    log "multibot service is not running ($service_status); bringing it up"
    sv up multibot || true
  fi

  if curl -sk --max-time 10 https://127.0.0.1:8799/api/health >/dev/null 2>&1; then
    failures=0
  else
    failures=$((failures + 1))
    log "health check failed ($failures/3)"
    if [ "$failures" -ge 3 ]; then
      log 'restarting multibot after three failed health checks'
      sv restart multibot || true
      failures=0
    fi
  fi

  if ! has_tailscale_ip 2>/dev/null | grep -Eq '100\.[0-9]{1,3}\.'; then
    if [ $((now - last_tailscale_wake)) -ge 300 ]; then
      log 'Tailscale address missing; opening Tailscale'
      command -v termux-am >/dev/null 2>&1 && termux-am start -n com.tailscale.ipn/.MainActivity >/dev/null 2>&1 || true
      last_tailscale_wake=$now
    fi
  fi
  sleep 60
done
