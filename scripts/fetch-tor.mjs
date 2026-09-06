#!/usr/bin/env node
// Downloads the Tor Expert Bundle for Windows x86_64, verifies its SHA-256
// against the official sums file, and keeps only what the desktop app needs:
// tor.exe, whatever DLLs ship next to it, and the two geoip databases.
// Pluggable transports (lyrebird/conjure), tor-gencert and the docs are
// dropped — MultiBot only ever runs a plain client/onion service.
//
// Not run at install time: the result lands in vendor/tor/win-x64/ which is
// gitignored, so whoever builds the Windows installer runs this once.
//
//   node scripts/fetch-tor.mjs           download + verify + trim
//   node scripts/fetch-tor.mjs --check   only assert the bundle is present
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = process.env.TOR_VERSION || "15.0.21";
const BASE = `https://archive.torproject.org/tor-package-archive/torbrowser/${VERSION}`;
const ARCHIVE = `tor-expert-bundle-windows-x86_64-${VERSION}.tar.gz`;
const SUMS = "sha256sums-unsigned-build.txt";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "vendor/tor/win-x64");
const torExe = resolve(outDir, "tor.exe");

if (process.argv.includes("--check")) {
  if (!existsSync(torExe)) {
    console.error(`Missing ${torExe} — run: node scripts/fetch-tor.mjs`);
    process.exit(1);
  }
  console.log(`tor.exe present (${mb(statSync(torExe).size)})`);
  process.exit(0);
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const sums = (await get(`${BASE}/${SUMS}`)).toString("utf8");
// Lines are "<64 hex>  <filename>". Anchor on the filename so a substring
// match (the i686 sibling shares a prefix) cannot pick the wrong row.
const expected = sums
  .split(/\r?\n/)
  .map((line) => line.match(/^([0-9a-f]{64}) [ *](.+)$/))
  .find((m) => m && m[2].trim() === ARCHIVE)?.[1];
if (!expected) throw new Error(`${ARCHIVE} not listed in ${BASE}/${SUMS}`);

console.log(`Downloading ${BASE}/${ARCHIVE}`);
const tarball = await get(`${BASE}/${ARCHIVE}`);
const actual = createHash("sha256").update(tarball).digest("hex");
if (actual !== expected) throw new Error(`SHA-256 mismatch: got ${actual}, expected ${expected}`);
console.log(`SHA-256 ok: ${actual} (${mb(tarball.length)})`);

// Staging inside vendor/ keeps everything under the gitignored tree and off
// whatever drive os.tmpdir() points at.
const tmp = resolve(root, "vendor/tor/.tmp");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
writeFileSync(resolve(tmp, ARCHIVE), tarball);
// cwd + a bare filename, never `-C <abs>`: a Windows path with backslashes is
// mangled by the MSYS tar that Git for Windows puts on PATH.
execFileSync("tar", ["-xzf", ARCHIVE], { cwd: tmp, stdio: "inherit" });

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const keep = [
  ["tor/tor.exe", "tor.exe"],
  ["data/geoip", "geoip"],
  ["data/geoip6", "geoip6"],
  ...readdirSync(resolve(tmp, "tor"))
    .filter((f) => f.toLowerCase().endsWith(".dll"))
    .map((f) => [`tor/${f}`, f]),
];
for (const [from, to] of keep) cpSync(resolve(tmp, from), resolve(outDir, to));
rmSync(tmp, { recursive: true, force: true });

// Attribution ships with the binary; fail loudly if it drifted away.
const notice = resolve(root, "THIRD-PARTY.md");
if (!readFileSync(notice, "utf8").includes(VERSION)) {
  console.warn(`Warning: THIRD-PARTY.md does not mention ${VERSION} — update it.`);
}

let total = 0;
for (const [, to] of keep) {
  const size = statSync(resolve(outDir, to)).size;
  total += size;
  console.log(`  ${to.padEnd(10)} ${mb(size)}`);
}
console.log(`${outDir}: ${keep.length} files, ${mb(total)}`);
