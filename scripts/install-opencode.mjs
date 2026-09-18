#!/usr/bin/env node
// OpenCode CLI installer. Desktops get the official npm package; Termux/Android
// cannot — `opencode-ai` has no android build (EBADPLATFORM) and its linux
// builds are dynamically linked (musl loader /lib/ld-musl-aarch64.so.1, plus
// libstdc++), which Android has no room for. So on Termux we pull the musl
// platform package plus a minimal Alpine musl runtime and run the binary under
// proot, the same trick the Codex shim uses for DNS + CA.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const isTermux = process.platform === "android" || Boolean(process.env.TERMUX_VERSION) || /com\.termux\//.test(process.env.PREFIX ?? "");
const prefix = process.env.PREFIX || "/data/data/com.termux/files/usr";
const muslLib = join(prefix, "lib", "musl", "lib");
const alpineArch = process.arch === "arm64" ? "aarch64" : "x86_64";
const platformPackage = `opencode-linux-${process.arch === "arm64" ? "arm64" : "x64"}-musl`;
const say = (text) => process.stdout.write(`[opencode-install] ${text}\n`);

function run(command, args, options = {}) {
  say(`$ ${[command, ...args].join(" ")}`);
  if (dryRun) return Promise.resolve(0);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, windowsHide: true, ...options });
    child.once("error", (error) => { say(error.message); resolve(1); });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true,
    env: { ...process.env, PATH: [join(homedir(), ".local", "bin"), process.env.PATH ?? ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":") },
  });
  return { code: result.error ? 1 : result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function verify() {
  if (dryRun) { say("verify: opencode --version"); return true; }
  const candidates = [isTermux ? join(prefix, "bin", "opencode") : null, "opencode"].filter(Boolean);
  for (const candidate of candidates) {
    const result = capture(candidate, ["--version"]);
    if (result.code === 0 && result.output) { say(`verified: ${result.output.split(/\r?\n/, 1)[0]}`); return true; }
  }
  return false;
}

const installNative = () => run("npm", ["install", "-g", "opencode-ai@latest"], { shell: process.platform === "win32" });

// Alpine ships the musl runtime the opencode binary links against. Names carry
// the package version, so read them off the index instead of pinning.
async function fetchAlpineRuntime(into) {
  const base = `https://dl-cdn.alpinelinux.org/alpine/latest-stable/main/${alpineArch}/`;
  const index = await fetch(base).then((r) => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status} for ${base}`)));
  const pick = (name) => {
    const found = [...index.matchAll(new RegExp(`${name}-[0-9][^"<]*\\.apk`, "g"))].map((m) => m[0]);
    if (!found.length) throw new Error(`no ${name} package in ${base}`);
    return found.sort().at(-1);
  };
  mkdirSync(into, { recursive: true });
  for (const file of ["musl", "libgcc", "libstdc\\+\\+"].map(pick)) {
    const body = await fetch(base + file).then((r) => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status} for ${file}`)));
    const apk = join(into, file);
    writeFileSync(apk, Buffer.from(body));
    // apk = concatenated gzip streams; tar unpacks the payload and then trips
    // on the signature stream, so its exit code is not a failure signal here.
    spawnSync("tar", ["xzf", apk], { cwd: into, stdio: "ignore", windowsHide: true });
  }
  mkdirSync(muslLib, { recursive: true });
  for (const dir of [join(into, "lib"), join(into, "usr", "lib")]) {
    if (existsSync(dir)) cpSync(dir, muslLib, { recursive: true, dereference: false });
  }
  if (!existsSync(join(muslLib, `ld-musl-${alpineArch}.so.1`))) throw new Error("musl loader missing after extract");
}

const shim = () => `#!${prefix}/bin/sh
# MultiBot shim for the opencode CLI on Termux. The binary is a musl ELF, so it
# needs a musl loader, libstdc++ and a CA bundle at Linux paths Android lacks;
# proot binds them. LD_PRELOAD must go: termux-exec's bionic shim cannot
# relocate inside musl. Reinstalling opencode overwrites this file.
P=${prefix}
exec env -u LD_PRELOAD proot \\
  -b "$P/lib/musl/lib:/lib" \\
  -b "$P/lib/musl/lib:/usr/lib" \\
  -b "$P/etc/resolv.conf:/etc/resolv.conf" \\
  -b "$P/etc/tls/cert.pem:/etc/ssl/certs/ca-certificates.crt" \\
  env -u LD_PRELOAD SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \\
  "$P/lib/node_modules/${platformPackage}/bin/opencode" "$@"
`;

async function installTermux() {
  say("Android detected: installing the musl opencode build under proot.");
  if (await run("pkg", ["install", "-y", "proot"]) !== 0) return 1;
  // --force: npm refuses the linux package on os=android; the binary is fine.
  if (await run("npm", ["install", "-g", "--force", `${platformPackage}@latest`]) !== 0) return 1;
  if (dryRun) return 0;
  const scratch = join(process.env.TMPDIR || tmpdir(), "opencode-musl");
  rmSync(scratch, { recursive: true, force: true });
  try {
    await fetchAlpineRuntime(scratch);
  } catch (error) {
    say(`musl runtime download failed: ${error.message}`);
    return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const wrapper = join(prefix, "bin", "opencode");
  rmSync(wrapper, { force: true }); // a failed `npm i -g opencode-ai` leaves a dangling symlink here
  writeFileSync(wrapper, shim());
  chmodSync(wrapper, 0o755);
  return 0;
}

say(`platform=${process.platform} arch=${process.arch}${dryRun ? " dry-run" : ""}`);
if (!dryRun && verify()) {
  say("OpenCode already ready.");
} else {
  const code = isTermux ? await installTermux() : await installNative();
  if (code !== 0) process.exitCode = code;
  else if (!verify()) { say("OpenCode still unavailable after install. No false success reported."); process.exitCode = 1; }
  else say("OpenCode ready for MultiBot. Free OpenCode Zen models need no key.");
}
