#!/usr/bin/env bash
# multibot: the three values a device needs to reach this server — address,
# server name, server password — read back from the setup.json the harness
# writes on its first boot (server/identity.ts, ensureConfigured).
#
# The harness itself prints the password only to a real terminal, because
# svlogger/journald/`docker logs` keep stdout forever. An installer IS that
# terminal, so it reads the file instead of scraping the service log.
#
# Usage: print-setup-values.sh [seconds-to-wait]   (default 30)
# Never fails: an installer that finished must not report failure because the
# server was slow to write one file.
set -uo pipefail

DATA_DIR="${OMB_DATA_DIR:-$HOME/.openmausbot}"
FILE="$DATA_DIR/setup.json"
PORT="${OMB_PORT:-8799}"
DEADLINE=$(( SECONDS + ${1:-30} ))

# node is installed by every path that calls this (Termux pkg, the Linux
# prerequisites check, the container image), so no jq/python dependency.
# A reader can catch the file between create and flush, so an unparsable or
# half-written file is just another reason to keep waiting — hence the retry
# loop below rather than a single read after the file appears.
show() {
  node -e '
const { readFileSync } = require("node:fs");
const file = process.argv[1];
const setup = JSON.parse(readFileSync(file, "utf8"));
if (!setup.address || !setup.serverName || !setup.serverPassword) process.exit(1);
const rows = [["Address", setup.address], ["Name", setup.serverName], ["Password", setup.serverPassword]];
if (setup.tlsFingerprint) rows.push(["Fingerprint", setup.tlsFingerprint]);
const pad = Math.max(...rows.map(([name]) => name.length));
console.log("\n[multibot] MultiBot server is ready\n");
for (const [name, value] of rows) console.log(`  ${name.padEnd(pad)}   ${value}`);
console.log("\n  Enter these three values in MultiBot on any device → Sign in to a server.");
console.log(`  They stay in ${file} until the first profile is created.\n`);
' "$FILE" 2>/dev/null
}

while :; do
  if [[ -f "$FILE" ]] && show; then exit 0; fi
  (( SECONDS < DEADLINE )) || break
  sleep 1
done

# A missing file says nothing about which of the two happened, so say both — and
# still hand over the address, the one value that does not come out of the file.
echo "[multibot] no usable $FILE — either the server already has a profile (sign in) or it did not start (check the service log)"
echo "  Address   https://$(hostname 2>/dev/null || echo localhost):$PORT"
exit 0
