#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

command -v sv >/dev/null || { echo 'Termux only'; exit 2; }
sv down multibot
for _ in 1 2 3 4; do
  sleep 60
  sv status multibot | grep -q '^run:' && { echo 'watchdog restored multibot'; exit 0; }
done
echo 'watchdog did not restore multibot within 4 minutes' >&2
exit 1
