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
set -euo pipefail

DATA_DIR="${OMB_DATA_DIR:-$HOME/.openmausbot}"
FILE="$DATA_DIR/setup.json"
DEADLINE=$(( SECONDS + ${1:-30} ))
while [[ ! -f "$FILE" ]] && (( SECONDS < DEADLINE )); do sleep 1; done

if [[ ! -f "$FILE" ]]; then
  # No pending setup means one of two things, and they need opposite reactions.
  if [[ -f "$DATA_DIR/identity.db" ]]; then
    echo "[multibot] server already set up; sign in with an existing profile"
  else
    echo "[multibot] no $FILE yet — the server has not finished its first boot; check the service log"
  fi
  exit 0
fi

# node is installed by every path that calls this (Termux pkg, the Linux
# prerequisites check, the container image), so no jq/python dependency.
node -e '
const { readFileSync } = require("node:fs");
const file = process.argv[1];
const setup = JSON.parse(readFileSync(file, "utf8"));
const rows = [["Address", setup.address], ["Name", setup.serverName], ["Password", setup.serverPassword]];
if (setup.tlsFingerprint) rows.push(["Fingerprint", setup.tlsFingerprint]);
const pad = Math.max(...rows.map(([name]) => name.length));
console.log("\n[multibot] MultiBot server is ready\n");
for (const [name, value] of rows) console.log(`  ${name.padEnd(pad)}   ${value}`);
console.log("\n  Enter these three values in MultiBot on any device → Sign in to a server.");
console.log(`  They stay in ${file} until the first profile is created.\n`);
' "$FILE"
