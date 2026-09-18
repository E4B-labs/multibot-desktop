# MultiBot on Samsung Android: 24/7 checklist

Code keeps the server alive after process and health failures. Android still controls battery, VPN and reboot policy; set these once:

1. Install and open Termux:Boot once.
2. One UI: Settings → Battery → Background usage limits. Add Termux, Tailscale and MultiBot Mobile to Never sleeping apps.
3. Settings → Battery → More battery settings: disable Adaptive battery if it still suspends Termux.
4. Settings → Device care → Automation → Automatic restart: disable it.
5. Tailscale: enable Always-on VPN. Keep Tailscale allowed to run in background.
6. Wi‑Fi advanced settings: disable Wi‑Fi power saving / keep Wi‑Fi on during sleep.
7. Android 12+: enable Developer options + USB debugging, then run once on a computer:

```sh
adb shell settings put global settings_enable_monitor_phantom_procs false
```

The installer creates `multibot` and `multibot-watchdog` runit services. The watchdog checks `/api/health` every 60 seconds, restarts MultiBot after three failures, and wakes Tailscale at most once per five minutes when no `100.x` address exists.

When deploying a tar archive created on Windows, restore shell executable bits before restarting the service:

```sh
chmod +x ~/multibot/scripts/start-multibot.sh ~/multibot/scripts/multibot-watchdog.sh ~/multibot/scripts/test-multibot-watchdog.sh
```

Verify on Termux:

```sh
sv status multibot multibot-watchdog
bash ~/multibot/scripts/test-multibot-watchdog.sh
curl -sk https://127.0.0.1:8799/api/health
```
